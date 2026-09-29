# Publication recovery worker

A small independent Node.js worker for the Oracle Always Free VM (Mumbai, Ubuntu 24.04, VM.Standard.E2.1.Micro,
1 GB RAM, 1/8 OCPU). It finds saved source evidence that has not reached its live dashboard report and repairs it
**zero-export** through the **publication routes**: the four pre-existing zero-export reconciler CLIs and the one
generic route CLI (`scripts/release/publication-route-reconcile.mjs --route=<id>`). Every live write still goes through
the existing fenced four-gate publisher. A job completes only when a separate verify child proves the exact binding
(content identity + lineage + live read-back) **and** the served row, for the same evidence token the job was claimed
with.

> **Status (2026-09-29): observe-only, nothing live.** Migrations `20260934` (the worker queue) and `20260935` (the
> writer fence, section 9) were **applied 2026-09-28** with owner sign-off (Gate A done); every key is still
> `fenced_only = false`. The VM observer (Gate B, observe-only) ran `c30ff11` and failed the tier-1 capacity gate (section
> 3), so no route is activatable. Every flag is OFF: the control row is disabled, every route row is `live_enabled =
> false` with no live region, and `PRW_LIVE_ROUTES` is empty. See [section 6](#6-sign-off-gates-rollout-order-and-canary-order).

## 1. The routes the worker drives

`lib/server/recovery/routes.js` is the **only** registry (the ffb035b four-family view and "detect-only" are gone). It
lists ten routes in priority order; `topoOrder()` orders them by `awaits`. `lib/server/recovery/registry.js` classifies
**every** report key the code knows and fails closed on an unclassified or double-classified key.

| Route | CLI | Live report keys | Grain / unit | Awaits | Deadline / hard timeout | Child heap (min) |
|---|---|---|---|---|---|---|
| `oli` | `oli-publication-reconcile.mjs` (legacy, TARGETS v1) | brand-sales, brand-inventory, daily-reporting | account | - | 330 s / 420 s | 512 (192) |
| `listings` | `listing-health-v3-reconcile.mjs` (legacy) | listing-health-v3 | account | - | 720 s / 840 s | 512 (192) |
| `fba-plan` | route CLI | fba-plan (fill-only) | account | - | 600 s / 720 s | 448 (320) |
| `returns-v3` | route CLI | returns-leakage (v3) | account | - | 330 s / 420 s | 256 (192) |
| `ads` | `ads-publication-reconcile.mjs` (legacy) | daily-reporting | account | oli | 330 s / 420 s | 512 (192) |
| `fba` | `fba-publication-reconcile.mjs` (legacy) | brand-inventory | account | oli | 330 s / 420 s | 512 (192) |
| `brand-view-brands` | route CLI | brand-view-brands | account | oli, fba-plan | 330 s / 420 s | 448 (192) |
| `sku-movement` | route CLI | sku-movement | account / brand | brand-view-brands | 330 s / 420 s | 384 (256) |
| `brand-view` | route CLI | brand-view | account / brand | oli, fba, fba-plan, returns-v3, brand-view-brands | 720 s / 840 s | 448 (320) |
| `brand-view-portfolio` | route CLI | brand-view-portfolio | region / brand | oli, fba, fba-plan, returns-v3, brand-view-brands | 720 s / 840 s | 448 (448) |

Every other key is typed **not-applicable** in the owner hand-off: `manual-paid` (reconciliation, sku-pl,
keyword-rank, content-changes, sales-movers, listing-health v1, buy-box-loss, listing-optimizer, ppc-performance: no
durable evidence, only a paid refresh), `read-only-self-heal` (brand-directory, oli-quality*: derived on every read),
plus operational rows and the `scheduler-v2/*` shadow namespace (a shadow is never a publication).

The worker spawns **only** the allow-listed CLIs through `lib/server/recovery/runner.js` (never a publisher, a fetch
path, a backfill, a go-live or a materializer; those scripts are refused even if mis-registered). Every child gets the
runtime zero-export guard preloaded (`NODE_OPTIONS=--import=zero-export-guard.mjs`); the worker's own import graph is
proven by `scripts/worker-closure.test.js` to load no DataDoe, publisher, CAS, lease or `report_snapshots` writer code,
and no cycle-finalize RPC.

## 2. How the worker runs

One loop, concurrency 1, no busy-wait (`lib/server/recovery/worker.js`, no report-specific code). Each tick:

1. **Heartbeat** (`publication_recovery_workers`, redacted counters; also every 60 s while a child runs).
2. **Watermark** (per route, every `route.evidence.everySeconds`; **live** (route, region) pairs only). The route's own
   metadata-only evidence SQL + compose (`evaluateRouteEvidence`, one repeatable-read read-only snapshot, the ONE
   evidence context of `routes.js`: the region's durable-directory accounts, the primary organization fingerprint, one
   clock) gives a token per target. A target whose token is neither the verified nor the observed token of its state row
   (including a target with no state row) is enqueued (`origin = watermark`).
3. **Tier-1 consistency scan** (every `PRW_SCAN_INTERVAL_SECONDS` = 600 s, claimed in the DB so one worker per interval;
   **all** routes and regions; metadata SQL only, in-process):
   - evidence token vs state (`token-advanced`, `token-unobserved`, `target-missing`, `no-token`);
   - live rows written after the verification (`max(updated_at)` per `tier1.liveRowScope`: exact account, a
     `brand-view:<acct>::%` prefix, or the portfolio's own `params->>'region'`) -> `served-row-foreign`;
   - identity as-of rollover (`identityAsOf(target)` vs `verified_rows[].asOf`, e.g. Brand View at IN midnight);
   - findings are enqueued (`origin = scan`) for a live route, otherwise only observed. A foreign served-row write on a
     **legacy** family is **detection-only** (its own backstops also write that key -- never fought in a loop);
   - the served read-back proof of a legacy family (`served_confirmed`: no live row in scope written after the
     verification);
   - global checks: the scheduler gate facts, the writer-fence state per key, the unregistered-live-report-key detector;
   - the duration is recorded (`tier1_summary.durationMs`).
4. **Deep sweep step** (single-flight through the scan lease; one child per step). Once per epoch after the scheduler gate
   clears, then every `PRW_DEEP_SWEEP_HOURS` (fba-plan and the portfolio only when their tokens changed): one read-only
   child per (region, route) over the full region (`--verify-exact` for a route CLI -- the manifest backstop that catches
   drift a metadata token cannot see; the legacy CLIs' dry-run). It records the unit baseline (`verified_rows`) and
   enqueues stale targets (`origin = deep-scan`).
5. **One claimed batch** (up to `PRW_BATCH` targets of ONE route, region and epoch; `FOR UPDATE SKIP LOCKED`):
   1. an older epoch (UTC D-1) -> `superseded`;
   2. **route live?** `control.enabled` AND `route.live_enabled` AND region in `route.live_regions` AND `PRW_LIVE_ROUTES`
      AND not tripped -> else deferred `route-not-live` (600 s, no attempt, state untouched);
   3. **the global scheduler gate** -> deferred `scheduler-window-global` (300 s, no attempt, state untouched);
   4. the control-plane lease held -> `contention` (120 s, no attempt). A **read failure** of the control row, the
      scheduler gate, the control lease (or, below, the durable directory / the upstream blockers / the claim renewal)
      never consumes an attempt: every job is deferred `gate-unreadable` (300 s, alert `gate-unreadable`, state untouched)
      -- never the batch-exception attempt path, so a flaky metadata read can never dead-letter a job;
   5. capacity: the route's `minChildHeapMb` above `PRW_CHILD_MAX_OLD_SPACE_MB` -> `capacity-exceeded` (6 h, alert, no
      spawn); a missing owner attestation (section 5) -> `route-not-activated` (deferred, alert, no spawn);
   6. **scope** (account routes): a target that is no longer in the region's **durable directory** (the worker's
      directory == the route CLI's `buildDurableDirectory`, the same `accountInScope` rule) is **superseded**
      (`superseded-target-out-of-scope`, alert `target-out-of-scope`, no attempt, no child) -- it is never handed to the
      CLI (which would `STOP ROUTE_TARGET_OUT_OF_SCOPE` for the whole batch), and unlike a dead job the same token can open
      a new job if the account comes back;
   7. **live-state awaits**: an owner is blocked only by an OPEN upstream job (a deferred one only with a class that will
      converge) or an upstream state whose class is `stale` this epoch; a dead or missing-evidence upstream never blocks.
      A region target (the portfolio) is blocked by any upstream in its region (its owners never gate it). Past
      `PRW_AWAIT_MAX_MINUTES` since the job's creation it proceeds with alert `await-timeout`;
   8. **pre-check** child (`--verify-exact` for a route CLI). Current with the token echo -> **verified without a
      publish** (what makes a crash after publish safe). **Any** stale unit -> the live pass (the worst class decides only
      the final outcome: one integrity unit never blocks a region target's other stale units);
   9. **re-check immediately before the live child** (the pre-check may have run for its whole hard timeout): the claim is
      renewed for exactly the jobs to publish -- a job whose claim was **lost** (lease expired and reclaimed by another
      worker) is dropped from the batch **without a finish** (the new owner finishes it); then the epoch (a newer UTC D-1
      -> `superseded`), the trip, `control.enabled` / the route switch / `PRW_LIVE_ROUTES`, the scheduler gate and the
      control lease are all **re-read**. Any gate now closed -> the same typed outcome as at the batch start (no attempt)
      and **no** live child;
   10. **live** child for the stale targets only (unique run token; `--live --verify-exact` = `repair` for a
      `manifest-differs` unit); an abnormal exit is followed by a `--cleanup` child with the **same** run token;
   11. **verify** child (`--verify-exact`). **Verified only when** the verdict is current **and** the child's evaluated
      token equals the job's token. A legacy CLI (TARGETS v1 carries no evaluated token) is verified on its binding and
      the worker then re-reads its own token: evidence that moved during the run **re-arms** the job;
   12. after a verified **publish**, the dependents are enqueued (`origin = dependency`: the owner scope for account
       routes, the region target for the portfolio) -- so a fba-plan repair cascades fba-plan -> brand-view-brands ->
       sku-movement -> brand-view -> brand-view-portfolio.

   Capacity and the owner attestations are process configuration (they cannot change mid-batch) and are checked once.

**Token mismatch.** When a child evaluated a different token than the job was claimed with: if the worker now reads the
child's token, the evidence advanced -> the job adopts it and is **re-armed** (`finish(evaluatedToken)`); if the worker
still reads the claim-time token, it is a worker/CLI **token disagreement** (a context or code defect) -> deferred 1800 s
with alert `token-disagreement`, never a hot loop. Every re-arm is counted per job (`rearms`); past `PRW_MAX_REARMS` the
job is alerted `evidence-rearm-bound` and backs off 600 s.

**The global scheduler gate** (`store-pg.js evaluateSchedulerGate`; the bucket grammar is EXHAUSTIVE against
`sync_cycles_bucket_check`, `supabase/migrations/20260924_priority_partial_cycle_bucket.sql:40-42`, pinned by the worker
suite). It blocks in **any** region when a scheduler-owned or paid cycle is pending/running and started within 4 h, or had
any activity (the cycle or its report/source jobs) within `PRW_SCHEDULER_COOLDOWN_SECONDS` (900 s; covers the gap between
the run and fba jobs), or the clock is inside `PRW_SCHEDULER_WINDOWS`:

| Bucket | Kind | Opened by |
|---|---|---|
| `india`, `europe-au`, `us-ca`; legacy `us`, `non-us` | scheduler | the natural scheduler-v2 cycle; the Data Sync Center source sync (us / non-us) |
| `<scope>-fba` (`india-fba`, `europe-au-fba`, `us-ca-fba`; legacy `us-fba`, `non-us-fba`) | **paid-fba** | `fba-plan-operation.js:41` `fbaCycleBucket` (`:219-220`): `scripts/release/fba-plan-golive.mjs` (scheduler fba job) and the Data Sync Center paid FBA sync `api/admin/sources.js:436-448` (bucket us / non-us at `:313-314`) |
| `bootstrap-fba-<region>-<hex16>` | **paid-fba** | `account-onboarding.js:377-386`; `fba-plan-golive.mjs` bootstrap waves |
| `bootstrap-<region>-<hex16>`, `listing-health-v3-<region>` | scheduler | onboarding bootstrap; the LHv3 ingestion |
| `priority-partial-<region>-<hex16>` | **excluded** | the route / priority release cycles (never block) |
| anything else | unknown -> **blocks** + alert `unknown-cycle-bucket` | fail closed |

Nothing else opens an fba-plan paid job: `manual-source-sync.mjs` has no FBA; `fba-inventory-recovery.mjs` and
`fba-durable-source-replay.mjs` open no fba-plan cycle (the operator should hold the worker's kill switch while running
them). A paid cycle open for more than 4 h and idle for 15 min no longer blocks (else one stuck cycle would starve every
route); it is alerted instead, and the fba-plan route's own `paid-cycle-open` / `paid-job-in-flight` check plus the
control-plane lease still protect the write itself.

**Shutdown** (SIGTERM from `systemctl stop`, a reboot, or `rollback.sh`): no new claims or children. A running
read-only child (sweep step, pre-check, verify) is terminated after `PRW_STOP_GRACE_SECONDS` and its jobs are handed back
without an attempt. A `live`, `repair` or `cleanup` child is **never** killed (the releases finalize a cycle before they
publish); it ends within its own deadline, bounded by the runner's hard timeout (<= 840 s). The unit's
`TimeoutStopSec=1200` covers that.

**Dates and timeouts.** The unit pins `TZ=UTC`; Postgres `date`s are read as exact text and instants as epoch-ms
computed in SQL. Every statement runs inside a short transaction that first sets `SET LOCAL statement_timeout` (the
proven `reconciliation-runner.mjs` pattern) plus a client-side `query_timeout`; **no** `statement_timeout` startup
parameter is sent through the pooler.

### 2.1 Classes and the owner hand-off

`lib/server/recovery/classify.js` maps every typed reason a route emits to a worker class (unknown -> a typed deferral +
alert, never current). Deferrals (gate, `gate-unreadable`, contention, dependency, missing evidence, route-not-activated,
capacity, config) **never** consume an attempt; retries back off exponentially and dead-letter at `PRW_MAX_ATTEMPTS`; a
dead job is never re-enqueued for the same evidence token; `PRW_MAX_CLAIMS` dead-letters a crash loop. Route-CLI
specifics (the legacy families' verdicts are unchanged, pinned by `recovery-classify-vocabulary.test.js` V2):

- a typed reason whose **leading** code ends `-threw` (`lineage-read-threw:<message>`, `bundle-resolve-threw:<message>`,
  `revision-threw`, ...) is classified by that code alone -- its tail is an error **message**, so text such as
  `brand-not-sold` / `superseded-newer-live` in it can never make it not-applicable / superseded: a bounded transport
  retry + alert `route-step-threw`. The two contract-thrown tails keep their class (`derive-threw:fba-plan-route-fence-not-
  attested:` -> route-not-activated; `derive-threw:fba-plan-derive-invalid:` -> integrity);
- the race-prone failures `preflight-not-successful`, `reconcile-lease-lost`, `claim-terminal`, `finalize-open-work` (a
  concurrent twin run / paid job causes them) are a bounded transport retry + alert `race-transient`, never an integrity
  dead-letter;
- a route CLI `STOP ROUTE_TARGET_OUT_OF_SCOPE` (the residual race between the worker's cached directory, TTL 600 s, and
  the CLI's fresh read) defers the batch as a dependency deferral (900 s, **no attempt**) + alert
  `route-target-out-of-scope`; the next claim sees the refreshed directory and supersedes the stale target (step 6).
  Every other STOP is `run-failed` + alert;
- a current unit is verified only with its own served read-back unless the caller explicitly says `legacy-cli` (an
  omitted route kind is strict).

The owner **hand-off matrix** (per region x account x report; `status --matrix`) uses EXACTLY these classes:

| Hand-off | Meaning |
|---|---|
| `repaired` | this worker published and a separate verify child proved content + lineage + live read-back **and** the served row |
| `already-current` | the binding proved content + lineage + live read-back **and** the served row, with no publish |
| `deferred` (typed) | stale-pending, superseded, preempted, capacity, contention, dependency, not activated, `current-unserved` (a current binding whose served read-back is not yet proven, or was revoked), `evidence-advanced` / `identity-rollover` (a tier-1 finding recorded **after** the verification says the token advanced / the identity as-of rolled), `job-open` (a pending / claimed / deferred job exists for the target: the worker is re-checking it), `not-yet-evaluated` |
| `missing-source` (typed) | the saved evidence is absent or ineligible (the worker never fetches it) |
| `failed` (typed) | integrity, zero-export violation, terminal cycle, read-back mismatch, exhausted retries |
| `not-applicable` (typed) | `manual-paid`, `read-only-self-heal`, `source-absent` (no evidence material at all) |

Two routes feeding one report (daily-reporting: oli + ads) combine worst-first. The matrix reads the status RPC's state
rows, which carry `served_confirmed`, `open_job` and `tier1_state` (the tier-1 finding only when newer than the
verification).

**The served proof** (`publication_recovery_state.served_confirmed`). A route CLI proves it per unit at verification (the
served row carries the unit's own content hash). A legacy family's proof is the tier-1 check "no live row in scope
written after the verification". A tier-1 **revocation** (`false`, a foreign served-row write after the verification) is
**sticky for the verified token**: a re-verification of the same token (the deep sweep, a pre-check) without a republish
keeps it `false`, and a later tier-1 "no newer write" never flips it back (each tier-1 row also names the verified token it
evaluated, so it never lands on a newer verification). Only a **new** verified token, a **republish by this worker**
(finish `verified` with `published`), or a route CLI's own positive unit-level served proof resets it.

### 2.2 Status alerts (`publication_recovery_status`, `status.mjs`, `health.mjs`)

Dead letters **by class**; `missing-evidence-over-6h`; `served-row-preempted`; `zero-export-violation`;
`capacity-exceeded`; `source-stale-manual`; `await-timeout`; `served-row-foreign`; `token-disagreement`;
`evidence-rearm-bound`; `scheduler-gate-starvation` (a job held by the gate > 12 h); `gate-unreadable` (a gate / lease /
claim / directory / blocker read failed -- deferred, no attempt); `target-out-of-scope` (an account target left the
region's durable directory -- superseded); `route-target-out-of-scope` (the route CLI's scope STOP race -- deferred, no
attempt); `route-step-threw` and `race-transient` (bounded route retries, see 2.1); and the tier-1 global alerts:
`stranded-partial-cycle` (a running priority-partial cycle older than 2 x the longest hard timeout that holds a job),
`paid-cycle-stale-open` (an open paid fba cycle idle > 6 h, the fba-plan route's own staleness rule),
`paid-job-stale-in-flight` (an open fba-plan job older than 6 h), `scheduler-cycle-relaxed-open` (an open scheduler /
paid cycle past the 4 h in-flight bound and the cooldown: it no longer blocks the gate, and is alerted AT ONCE),
`scheduler-gate-truncated` (the gate read hit its row limit: the gate fails CLOSED), `unknown-cycle-bucket`,
`unregistered-live-report-key`,
`writer-fenced` (a `REPORT_WRITER_FENCED` rejection reported by a worker child -- from a fenced route writer this is a
defect), `writer-fence-invalid|unreadable`. A job-less running priority-partial cycle (a crash between the cycle claim
and the job upsert) is an ignored orphan, never a stall. The status also shows the writer fence **per key**
(`fenceStatusSummary`: fenced / open / unknown; `absent` until 20260935 is applied).

### 2.3 Safety properties and the tests that pin them

| Property | Test |
|---|---|
| Normal save: watermark -> pre-check STALE -> live -> verify -> verified with the token echo; legacy argv byte-identical | worker 1a-1i |
| Missed GitHub run: tier-1 token change / identity rollover / foreign served write enqueues and the worker publishes | worker 2a-2h |
| Global scheduler gate (cross-region, cooldown, paid DSC / bootstrap-fba, unknown bucket, windows, priority-partial excluded) | worker 3a-3h, SQL Q1-Q2 |
| Live-state awaits (stale upstream blocks; missing-evidence / dead do not; await-timeout proceeds + alert) | worker 4a-4e, SQL Q5 |
| Dependency repair order fba-plan -> brand-view-brands -> sku-movement -> brand-view -> portfolio | worker 5a-5c |
| Token re-arm (verify mismatch, mid-run refresh), disagreement alert, re-arm bound | worker 6a-6e, SQL V3 / D4 |
| Crash-loop guard, stale claim lease reclaimed, graceful stop releases | worker 7a-7c, SQL L1-L3 |
| capacity-exceeded; route-not-activated never burns an attempt | worker 8a-8b |
| Zero-export violation trips the route + dead-letters; writer-fenced event + fence state per key | worker 9a-9d |
| Any stale unit is repaired; manifest drift -> repair pass | worker 10a-10b |
| Deep sweep cadence (after the gate; token-change-only routes) | worker 11a-11e |
| Observe-only, epoch rollover, retry / cleanup, missing evidence, read-back mismatch, crash after publish | worker 12a-12f |
| Hand-off matrix classes (served read-back required) | worker 13a-13f |
| Migration seed == registry; gate grammar == the sync_cycles CHECK; worker directory == the CLI's; no startup statement_timeout | worker 14a-14g |
| Every gate re-checked right before the live child (switches, scheduler gate, lease, epoch, a lost claim dropped without a finish) | worker 16a-16d |
| A gate / lease / directory / blocker read error defers without an attempt | worker 16d-16e |
| The matrix never says repaired / already-current past a newer token-advanced finding or an open job | worker 16f-16g, SQL ST4 |
| A served-proof revocation is sticky for the verified token (new token / republish reset it); the pre-verification foreign row stays a known limit | worker 16h-16k, SQL SV1-SV3 |
| An out-of-scope target never poisons its batch (superseded before the child; the scope STOP race defers without an attempt) | worker 16l-16m, SQL SS1, units K5 |
| Leading `-threw` / race-prone / strict-default classification; the guard's leading newline | units K1-K6, vocabulary V1c / V3 / V5, zero-export-guard G10 |
| Real SQL of the redesigned 20260934 + the store's own SQL + exact rollback | `publication-recovery-sql-selftest.mjs` (PGlite, 55 assertions) |
| Ads digest partials: the per-(account, day) partials folded per window == the old per-window `adr1:` digest (both statements) on real Postgres; an empty window is `adr1:0:0:0` | `ads-digest-equivalence-selftest.mjs` (PGlite, 12 assertions), `ads-daily-digest.test.js` |
| Tier-1 sweep cache: ONE shared Ads scan per tier-1 / watermark pass; every other read stays account-scoped and fresh; a failed shared read fails fast for that pass only | worker 15t (one Map per pass), 1j / 5d / 11f (the per-job, dependency and deep-sweep reads get none), brand-view E11, `ads-daily-digest.test.js` |
| Database load: cross-pass reuse of the shared Ads partials behind the change probe (every probe field, the 1 h cap from the ORIGINAL scan, a probe that cannot vouch stores nothing, a failure is never carried); the tier-1 circuit breaker; the deep-sweep pause while the gate is blocked | worker 19a-19h, digest D5r-D5u, `ads-change-probe-selftest.mjs` (PGlite, 12 assertions) |
| FBA reconcile fairness: most-starved accounts first (served inventory date), a hung account defers `deadline-account-in-flight` without stalling the run, the served-date reads are capped (10 s per read, 60 s in total including an in-flight read) | `fba-reconcile-fairness.test.js` (F14, F15) |
| Structural zero-export (import closure, allow-list) | `worker-closure.test.js`, `publication-recovery-units.test.js` C1-C9 |

**Honest limit:** PGlite is a single connection: `FOR UPDATE SKIP LOCKED` and the advisory lock are not contended by two
sessions there. Concurrency safety rests on those standard Postgres primitives and the in-memory two-worker scenarios.

## 3. Resource fit (1 GB Micro)

```bash
node scripts/worker/publication-recovery-memcheck.mjs [--iterations=40000]     # synthetic: the worker loop, all 10 routes
node scripts/worker/publication-recovery-memcheck.mjs --real [--regions=...] [--routes=...] [--sql-only]   # ON THE VM
```

**Synthetic, measured 2026-09-26 on the development machine (Windows x64, Node 24.14.1), NOT on the VM:** 40,000 ticks
(about 9.3 simulated days: 1,334 tier-1 scans, 118 deep sweeps, 162k verified jobs, all 10 routes x 3 regions) under
`--max-old-space-size=160`: retained heap after GC 13.3 MB at the end, steady-state drift **0.7 MB** (no heap drift),
RSS peak 221 MB (V8 lets garbage accumulate up to the old-space cap before a major GC; heapTotal ~145 MB while the
retained heap stays ~13 MB). **PASS** against the 240 MB worker envelope. The real budget therefore uses 240 MB for the
worker.

**The VM measurement is REQUIRED before any live route** (`--real`, read-only: zero writes, zero DataDoe creates or
tokens). It must measure, and the verdict lines print:

- per-child peak RSS and duration for **all 10 routes x 3 regions**, run exactly as the deep sweep runs them
  (`--verify-exact` for a route CLI). This includes the **fba-plan extra reads** (the latest paid job, its shadow if
  promotable, the live row / payload of a foreign pending job, and the publish guard's re-reads) and the **brand-view
  per-unit reads** (about 18 evidence queries + 25 REST reads per brand unit; the per-target seconds are printed);
- the **tier-1 duration**: every route's evidence SQL per region with per-statement timings -- in particular the ONE
  **`ads_daily` shared digest scan** of brand-view and the portfolio (below) and the **legacy GLOBAL evidence SQL**
  (`oli_coverage`, `fba_pointers`, `listings_pointers`, ... are not region-filtered) -- plus the served-row write scan,
  the gate, the fence and the report-key universe;
- the per-epoch deep-sweep total.

**Tier-1 performance (2026-09-28).** The first real memcheck FAILED the 60 s gate (tier-1 84 s on the VM; the observe-only
worker measured 82 s). About 85% of it was SIX scans per pass of the same wide, disk-bound `ads_daily_source_rows`
(718 MB heap): Brand View per region and the portfolio three times with an identical statement. EXPLAIN: each scan is
~11-15 s of heap I/O; the md5 digest itself only ~2-5 s. Both routes now read the per-(account, day) partials of the
SAME `adr1:` digest (additive: count + exact BigInt lane sums, max of the daily maxima), folded back into the old
per-window rows (`adsWindowRowsFromDaily`): the portfolio its unscoped `ads-daily-evidence.js ADS_DAILY_STATEMENT`
(`shared: true`; it needs every account, as its old statement did), Brand View an ACCOUNT-SCOPED twin
(`ADS_DAILY_SCOPED_STATEMENT`, index-driven, `account_id = any($4)`) for every reader WITHOUT a sweep cache -- the route
CLI's per-unit reads (scope, prepare b1 / b2, the publish-time token, verify-exact; they must stay fresh and never share)
and the worker's per-job, dependency and deep-sweep reads -- whose `sharedVariant` IS the portfolio statement. Only a
sweep-mode evaluation (`evaluateRouteEvidence(..., { sweep: true })`: the worker's tier-1 AND watermark passes, memcheck
`--real`) runs the shared variant, through one sweep cache per pass (`routes.js sweepMemoQuery`), so Brand View + the
portfolio read ONE scan per pass; a failed shared read fails fast for the rest of that pass (the next pass retries). The
statement echoes the range it actually scanned (every row + an always-present sentinel), so a params / compose clock split
still fails closed `ads-rows-window-mismatch`. Proof: the portfolio tokens
are IDENTICAL on production data (one read-only snapshot, all 3 regions); Brand View tokens are identical except for the
accounts with NO Ads row in their window, where the old LEFT JOIN digested its null-extended row
(`adr1:0:403621951634681328:664928202173542839`) -- a value the derive's JS twin can never produce, so those accounts could
never publish; the new path yields the documented empty digest `adr1:0:0:0` (pinned on real Postgres by
`scripts/worker/ads-digest-equivalence-selftest.mjs`). A full read-only tier-1 pass from the development machine: 105.5 s
before, 32.5-33.6 s after (the VM runs ~20% faster than that machine). The VM `--real` re-run on the release is the
verdict.

**Production database load (2026-09-29).** The observe-only `c30ff11` worker overloaded the production database, a
small Supabase compute tier (`max_connections` 60, `shared_buffers` 224 MB, shared burstable CPU). Its six full-window
Ads digest scans per pass read ~43 GB and ~4,900 s of database time in 13.5 h (the busiest production statement uses ~22
s/h). During the india cycle the database was CPU-throttled (an index-only evidence query ran 57 s on CPU; a 6 MB query
49.8 s with zero disk reads; dashboard `report_snapshots` reads ~1 s against a 15 ms baseline), tier-1 took 811-1,374 s
with evidence timeouts, and the india `materialize-inventory` job hit its 90-minute timeout (LKG kept). So the capacity
gate is the DATABASE's, and the worker must not be its main load. Three worker-only changes (no gate, acquisition or
route-CLI change):

- **Cross-pass reuse** of the shared Ads digest partials: at the start of every tier-1 / watermark pass the worker reads
  the Ads table's CHANGE PROBE (`store-pg.js ADS_CHANGE_PROBE_SQL`: the cumulative insert / update / delete counters,
  oid, relfilenode, the stats-reset stamps and the postmaster start, in its own transaction BEFORE any evidence read) and
  reuses the previous pass's partials only while the probe is byte-identical and the entry is younger than
  `PRW_SHARED_EVIDENCE_REUSE_SECONDS` (default and maximum 3600; 0 = off). A statement opts in with `reuseTable`; the
  contract admits it only on a shared statement that reads that table alone and no time function. Exactness: every
  committed write moves the probe (PGlite-proven in `ads-change-probe-selftest.mjs`, incl. a no-op upsert, a delete and
  TRUNCATE); a write not yet flushed to the statistics can make one pass reuse rows older by that flush delay; the 1 h
  cap bounds everything else. Only tier-1 / watermark see reused rows: every verification, per-job, dependency,
  deep-sweep and route-CLI read stays fresh, so reuse can DELAY a detection, never verify or publish. Quiet passes read
  ~20-95 MB instead of ~300 MB.
- **Tier-1 circuit breaker**: the first statement timeout (57014) of a pass means the database is starved; the rest of
  the pass is NOT issued (each counted as a failed evaluation, alert `tier1-circuit-open`, outcome `partial`, never
  `complete`), the next pass retries. Every evidence failure keeps its SQLSTATE in the alert sample.
- **Deep sweep pause**: a sweep in progress re-checks the scheduler gate before EVERY step (before, only at sweep start)
  and pauses -- no evidence read, no child, step not consumed, scan lease kept -- while a scheduler cycle runs.
- The token digest of the deep sweep's token-change rule is now taken over every region's LATEST successful parts, so a
  pass that could not evaluate a region never looks like a token change.

`PRW_SCAN_INTERVAL_SECONDS` stays at 900 or more through the soak. `memcheck --real` protocol (Codex): stop the worker
service first (or install without `--restart`) so it cannot overlap the measurement; run in a window with the scheduler
gate clear AND no scheduler-v2 downstream job or backstop reconciler running; record the gate and the database state
before and after; the unchanged verdict (tier-1 <= 60 s, zero evidence failures, on a COLD full pass) must PASS in at
least two separate windows. If the quiet cold pass still fails, activation stays blocked and the owner-approved
trigger-maintained digest table (a migration) is the next lever; so is a larger database compute tier.

PASS thresholds: max child peak <= 448 MB; worker 240 + largest child + OS 250 <= 85% of 1024 MB (870 MB); tier-1 <= 60 s;
per-epoch deep sweep <= 4 h. Otherwise the check prints the measured value and the required change (a longer
`PRW_SCAN_INTERVAL_SECONDS` / `PRW_DEEP_SWEEP_HOURS`, fewer `PRW_REGIONS`, or a larger shape such as OCI A1.Flex). A
route that fails stays **capacity-exceeded** on the VM and keeps being published by its GitHub run. Reference (the four
legacy families only, 2026-09-25, development machine): a full scan took 312 s, the largest child 186 MB.

## 4. Files and secrets

| Path | Purpose |
|---|---|
| `scripts/worker/publication-recovery-worker.mjs` | Entrypoint (`--check-config`, `--once`, graceful SIGTERM/SIGINT) |
| `scripts/worker/publication-recovery-health.mjs` | Health check: exit 0 healthy, 1 unhealthy (incl. a critical alert), 2 config, 3 DB |
| `scripts/worker/publication-recovery-status.mjs` | Redacted status, alerts, writer fence per key, hand-off matrix (`--summary`, `--matrix`) |
| `scripts/worker/publication-recovery-memcheck.mjs` | Memory / throughput check (synthetic and `--real` on the VM) |
| `scripts/worker/publication-recovery-sql-selftest.mjs` | Real-SQL self-test of 20260934 + the store's SQL (PGlite; exit 3 = SKIPPED, not a pass) |
| `scripts/worker/ads-change-probe-selftest.mjs` | Real-SQL proof that every Ads-table write kind moves the reuse change probe and a quiet interval does not (`PRW_PGLITE_DIR=<dir> node scripts/worker/ads-change-probe-selftest.mjs`; exit 3 = SKIPPED, not a pass) |
| `scripts/worker/ads-digest-equivalence-selftest.mjs` | Real-SQL proof that the Ads digest partials equal the old per-window digests (`PRW_PGLITE_DIR=<dir> node scripts/worker/ads-digest-equivalence-selftest.mjs`; exit 3 = SKIPPED, not a pass) |
| `scripts/worker/publication-recovery-reaper.mjs` | Operator tool: stuck-cycle candidates (read-only) / finalize ONE with sign-off (section 8) |
| `lib/server/recovery/{routes,route-contract,registry,classify,runner,worker,store-pg,config,memory-store}.js` | Worker modules (`memory-store` is test-only) |
| `supabase/migrations/20260934_publication_recovery_worker.sql` | **Applied 2026-09-28** (Gate A). 7 tables, 12 RPCs, expand-only, idempotent |
| `deploy/publication-recovery/ROLLBACK_20260934.sql` | Contract rollback (drops exactly the 20260934 objects) |
| `deploy/publication-recovery/publication-recovery.service`, `{install,rollback}.sh`, `worker.env.example` | systemd unit, release install / rollback, env template |

**Secrets.** The worker needs `POSTGRES_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `DATADOE_API_KEY` (the
account-directory GET the CLIs make costs zero tokens; the worker derives the non-reversible organization fingerprint
from it). They live **only** in `/etc/publication-recovery/worker.env` (`root:prw`, `0640`, created empty by
`install.sh`, edited with `sudoedit`). Never put a secret in Git, the unit file, a command line, shell history, a log, a
ticket or chat; `--check-config`, health and status print only presence booleans and redacted codes. No inbound port.
Rotation: `sudoedit` the env file, then `sudo systemctl restart publication-recovery`.

**Supabase CA rotation (Postgres TLS trust).** Every Postgres connection (worker, route CLI, reconcilers) verifies the
chain against the Supabase root(s) pinned in `lib/server/pg-tls.js` (`SUPABASE_PG_TRUSTED_ROOTS`; the current root,
"Supabase Root 2021 CA", is valid until 2031-04-26) AND checks the hostname. Rotate it only by overlap, never by
disabling verification:

1. When Supabase publishes a new root, ADD it to `SUPABASE_PG_TRUSTED_ROOTS` next to the old one (official download,
   cross-checked against the chain the pooler presents), and pin its sha256 in `scripts/pg-tls.test.js` (T1b requires
   every listed root to hash to its declared fingerprint).
2. Deploy that release (app + VM `install.sh`). Both roots now verify; nothing else changes.
3. After Supabase switches the pooler to the new chain, prove ONE verified connection against it (an owner-approved,
   read-only check such as the worker's `--check-config` on the VM). A failure here means the new root is wrong: stop.
4. Only then REMOVE the old root (and its pin) in a follow-up release.

At no step is `rejectUnauthorized` false, `sslmode=no-verify` used, the hostname check overridden or a CA read from the
environment. A root that expires or is revoked without a published successor is an owner escalation, not a workaround.

## 5. Pre-live checklist and attestations

**Pre-live checklist** (read-only; run once against production before ANY live route; record the output):

1. `memcheck --real` on the VM (section 3). Its tier-1 part runs **every route's evidence SQL read-only once** on real
   Postgres (param typing, `to_char(max)`, `rank()` ties -> `latest-row-ambiguous`, jsonb extraction, collations) and
   also runs **`FBA_PLAN_FOREIGN_JOB_SQL`** (`lib/server/sync/routes/fba-plan.release.js`) and
   **`LISTING_HEALTH_V3_FOREIGN_JOB_SQL`** (`lib/server/sync/listing-health-v3-release.js`) read-only once per region.
   `--sql-only` runs just these reads. Any `ok:false` line blocks activation of that route.
2. Migration `20260923` is applied (the portfolio evidence reads `ads_sync_state.content_rev`).
3. `--check-config` answers `db: ok` through the pooler (the SET LOCAL timeout path).
4. Before `SKU_MOVEMENT_SERVE_TOKEN_ATTESTED`: `EXPLAIN ANALYZE` the opunits `count=exact` + `max(updated_at)` window query
   on the largest account.
5. The brand directory hydration exposure check from the WP10a hand-off returns 0 rows (or is understood).
6. `status --summary` shows the writer fence state per key and no `unregistered-live-report-key`.
7. `FBA_PLAN_PAID_CYCLE_SQL` (`lib/server/sync/routes/fba-plan.release.js`) runs read-only once per region (the fba-plan
   route's in-lease open-paid-cycle check) in an owner-approved read-only session -- `memcheck --sql-only` does NOT run
   it today; a read failure blocks fba-plan.
8. `select count(*) from public.report_snapshots where payload_storage_path like 'source-cache/v1/%'` returns 0.

**Owner attestations** (only the literal `true` attests; anything else is not attested). Set each in the worker env
(`/etc/publication-recovery/worker.env`) **and** in the route CLI's GitHub environment, only after its condition holds;
revoke by removing the line and restarting. Without it the worker defers that route's live jobs `route-not-activated`
(no attempt, no spawn) and the route CLI refuses the live write itself.

| Variable | Route | Set only when |
|---|---|---|
| `FBA_PLAN_ROUTE_FENCE_ATTESTED` | fba-plan | WP10b (read-only `refresh=1`) is deployed **and** the 20260935 fence has `fba-plan` `fenced_only = true` |
| `SKU_MOVEMENT_SERVE_TOKEN_ATTESTED` | sku-movement | the WP10 serve (the `sms2:` serve token) is **deployed** and smoke-tested |
| `LHV3_SERVE_GATE_ATTESTED` | listings | both Vercel production flags `LHV3_PUBLISH_LIVE` and `LISTING_HEALTH_V3` are `true` |

## 6. Sign-off gates, rollout order and canary order

Each gate needs explicit owner sign-off. As of 2026-09-29: Gate A (20260934) and the 9.3 step-1 schema (20260935) are
applied (2026-09-28); Gate B
(the VM observe-only run) is in progress and has NOT passed (tier-1 capacity, section 3); no later gate is signed off.

**Gate A -- apply 20260934** (its own sign-off; it enables nothing):

```bash
cd sales-dashboard-live
MIGRATE_ONLY=20260934_publication_recovery_worker.sql npm run db:migrate
```

Verify (read-only):

```sql
select enabled from public.publication_recovery_control;                                   -- false
select route_id, grain, live_enabled, live_regions from public.publication_recovery_routes; -- 10 rows, all false / {}
select count(*) from pg_proc where proname like '%publication_recovery%';                   -- 12
```

Rollback: `deploy/publication-recovery/ROLLBACK_20260934.sql` in the SQL editor, after the worker is stopped.

**Gate B -- install on the VM, observe-only** (section 7). With `PRW_LIVE_ROUTES` empty and the control disabled the
worker only beats, runs tier-1 and deep sweeps, and records baselines / observations -- **it cannot publish**. Soak at
least one full day covering all three regional cycles; run the pre-live checklist; confirm from the DataDoe
`/usage-logs` ledger that the VM caused **zero creates**.

**Gate C -- preconditions for ANY live route** (all required):

1. the WP13 scheduler control-envelope hardening (`--lease-wait-seconds=600` on the scheduler's control applies) is
   deployed -- without it a worker publish in the run -> fba gap can abort a paid fetch;
2. the WP10 / WP10b serve + read-only `refresh=1` are deployed (paid sync stays available only through the admin Data
   Sync Center action);
3. the writer fence (20260935, its **own** sign-off) is applied and the route's live keys are **fenced** (section 9),
   so no rollout window exists in which an unfenced legacy writer and a route both write a route-owned key;
4. the route's `memcheck --real` verdicts PASS and its pre-live SQL ran `ok`;
5. its attestation (section 5) where one is listed.

**Gate D -- canary, one route x one region at a time, india first.** Per step, two keys (the DB row AND the VM env):

```sql
update public.publication_recovery_control set enabled = true, updated_at = now(), updated_by = '<approver>' where id = true;
update public.publication_recovery_routes
   set live_enabled = true, live_regions = array['india'], updated_at = now(), updated_by = '<approver>'
 where route_id = '<route>';
```

then add the route to `PRW_LIVE_ROUTES` and restart. **Canary order:**

1. `oli` (the existing legacy CLI, lowest risk);
2. `listings` (needs `LHV3_SERVE_GATE_ATTESTED`);
3. `ads`, then `fba`;
4. `returns-v3`;
5. `fba-plan` (fill-only; needs `FBA_PLAN_ROUTE_FENCE_ATTESTED`);
6. `brand-view-brands` (only after the WP10a serve and the retirement of the legacy directory materializer);
7. `sku-movement` (needs `SKU_MOVEMENT_SERVE_TOKEN_ATTESTED`);
8. `brand-view` (only with a VM memcheck PASS for it);
9. `brand-view-portfolio` **last**, and only if the VM memcheck passes; otherwise it stays on its GitHub run.

Then widen each proven route region by region: `india` -> `us-ca` -> `europe-au` (the largest last). Evidence required at
each step: jobs `verified` (`verified-live-readback`) and the hand-off matrix `repaired` / `already-current` **with the
served read-back**; the live dashboard values match; zero `writer-fenced`; zero `zero-export-violation`; no
`scheduler-gate-starvation`; DataDoe `/usage-logs` shows zero creates from the worker's runs.

**Kill switches** (fastest first): `update public.publication_recovery_control set enabled = false ...` (next claim);
`update public.publication_recovery_routes set live_enabled = false ... where route_id = '<route>'`; empty
`PRW_LIVE_ROUTES` + restart; `sudo systemctl disable --now publication-recovery`. **Not resolved end to end** until an
unattended VM run has proven saved-to-live-to-served convergence and zero DataDoe creates for every applicable account x
marketplace x report.

## 7. VM handoff (for Codex; only after Gate A is signed off)

On a trusted machine (the repo checkout). The archive **must be of the repository root**; `.gitattributes` pins LF for
`*.sh`, `*.service` and `*.example`.

```bash
SHA=$(git rev-parse HEAD)            # the reviewed commit containing this worker
git -C "$(git rev-parse --show-toplevel)" archive --format=tar.gz -o "/tmp/prw-$SHA.tar.gz" "$SHA"
sha256sum "/tmp/prw-$SHA.tar.gz"
scp "/tmp/prw-$SHA.tar.gz" "$(git rev-parse --show-toplevel)/sales-dashboard-live/deploy/publication-recovery/install.sh" <vm>:/tmp/
```

On the VM (Ubuntu 24.04). Manual commands run through `systemd-run` as `prw`, reading the env file exactly as the unit
does. Never `source` the env file into a shell.

```bash
/usr/bin/node -v                     # Node 24 at /usr/bin/node
sha256sum /tmp/prw-<sha>.tar.gz      # must match the trusted machine
sudo bash /tmp/install.sh /tmp/prw-<sha>.tar.gz <sha>
sudoedit /etc/publication-recovery/worker.env   # template: deploy/publication-recovery/worker.env.example; PRW_LIVE_ROUTES empty
prw() { sudo systemd-run --quiet --wait --pipe --collect --uid=prw --gid=prw \
  -p EnvironmentFile=/etc/publication-recovery/worker.env -p EnvironmentFile=-/etc/publication-recovery/version.env \
  -p Environment=TZ=UTC -p WorkingDirectory=/opt/publication-recovery/app/sales-dashboard-live \
  /usr/bin/node "$@"; }
prw scripts/worker/publication-recovery-worker.mjs --check-config; echo "exit=$?"   # "db": "ok"; 42P01 = Gate A pending
prw scripts/worker/publication-recovery-memcheck.mjs --real; echo "exit=$?"         # section 3 + pre-live SQL (read-only)
sudo systemctl enable --now publication-recovery                                     # observe-only
prw scripts/worker/publication-recovery-health.mjs; echo "exit=$?"
prw scripts/worker/publication-recovery-status.mjs --summary
```

Update: `sudo bash /tmp/install.sh /tmp/prw-<newsha>.tar.gz <newsha> --restart`. Rollback: `... rollback.sh release`
(previous release) or `... rollback.sh disable` (stop entirely); schema: `ROLLBACK_20260934.sql` after the worker is
stopped. Report back: `--check-config`, `systemctl status`, the health JSON, `status --summary` after one tier-1 and one
deep sweep, and the `--real` memcheck verdict lines. Do **not** set `PRW_LIVE_ROUTES` or enable any route row without
Gate D sign-off.

## 8. Stuck cycles, known limits and risks

**Stuck cycles.** The worker never writes a sync table and its graph never names a cycle-finalize RPC; it **surfaces**
`stranded-partial-cycle`, `paid-cycle-stale-open` and `paid-job-stale-in-flight`. Closing is an explicit, signed-off
operator action with `scripts/worker/publication-recovery-reaper.mjs`:

```bash
prw scripts/worker/publication-recovery-reaper.mjs                                  # read-only candidate list
prw scripts/worker/publication-recovery-reaper.mjs --apply --cycle-id=<id> --confirm=<id>   # ONE cycle, after sign-off
```

It finalizes (through the guarded `finalize_sync_cycle`, which re-checks the whole cycle under `FOR UPDATE`) only a
job-less orphan priority-partial cycle of a **past** epoch (`cycle_date` < the current UTC D-1; -> `succeeded`,
`report_total` 0) or a drained stuck cycle. A **current-epoch** orphan is `never`: the next run with the same evidence
resumes it, while finalizing it would dead-letter that target (`cycle-not-running`) for the rest of the day. It **never** finalizes
a priority-partial cycle holding a pending or failed job (e.g. the LHv3 salted foreign-retry cycle) nor any cycle with an
open job. A stuck **paid** fba cycle with an open fba-plan job keeps the fba-plan route deferred for that account
(`paid-job-in-flight` / `paid-job-stale-in-flight`) until the next natural paid cycle supersedes it or the operator
re-runs the paid publish phase.

**Known limits and risks.**

- **Tier-1 must pass the VM gate on the release you install**: the 2026-09-28 real memcheck FAILED at 84 s; the shared Ads
  scan (section 3) is the fix, but only the VM `--real` re-run on that exact release proves it.
- **Capacity is unproven** for brand-view and the portfolio on 1/8 OCPU until the VM memcheck passes (the plan's
  PARTIAL). A failing route stays capacity-exceeded on the VM and keeps its GitHub run.
- **Tier-1 is metadata-only**; the exact child-verified binding runs per job and in the deep sweep (once per epoch, then
  every `PRW_DEEP_SWEEP_HOURS`). An every-10-minute exact verification of every route does not fit the VM.
- **Legacy served read-back** is the tier-1 check "no live row in scope written after the verification": it cannot see
  a foreign row written **before** the verification with a newer `updated_at` than the verified row (the served
  selector would pick it); the legacy CLIs do not report their served row. A "the newest served-scope row IS the
  verified row" check is not expressible from metadata alone (the TARGETS v1 line carries no served-row identity), so
  this limit stands (pinned as a known limit by worker 16k). What IS closed: once tier-1 revokes the proof (a foreign
  write AFTER the verification) the revocation is sticky for that verified token (2.1) -- a later re-verification of the
  same token can no longer re-anchor it back to `already-current` while the foreign row stays newest. A **new** token
  or a republish by the worker resets the proof and re-opens the before-verification window for that new verification.
- **Scope races**: the worker's durable directory is cached for 600 s; a target the route CLI's fresh directory no
  longer lists makes the CLI STOP the batch (`route-target-out-of-scope`, deferred 900 s, no attempt) until the cache
  refreshes and the worker supersedes that target.
- **Gate re-check window**: the gates are re-read immediately before the live child, but a gate can still close during
  the live child itself; the release's own fenced CAS under the control-plane lease (and the fba-plan route's in-lease
  paid-cycle check) protect that window.
- **Scheduler-gate starvation**: the gate removes live repair from part of each day (alerted after 12 h). A paid cycle
  open > 4 h and idle 15 min no longer blocks (alerted), so one stuck cycle cannot stop every route.
- **Evidence-token exactness** of sku-movement / returns depends on every writer bumping a folded column; the
  `--verify-exact` deep sweep is the backstop.
- **Growth**: priority-partial cycles and content-addressed shadows grow `sync_cycles`, `sync_report_jobs` and
  `report_snapshots` (the shadow prune is off by default, `PRW_SHADOW_PRUNE`).
- **Slow stops**: `systemctl stop` can take up to ~15 minutes while a live child finishes (deliberate).
- **Env-only settings**: restart after changing them. The DB switches take effect on the next claim.
- The fence trigger (20260935) also blocks DELETE / TRUNCATE of a fenced key: scheduler-v1 prune / 30-day retention stop
  working for a fenced key (retention swallows the error; rows kept) -- expected.

## 9. Writer fence cutover

> **Status (2026-09-29):** migration `20260935_report_publication_writer_fence.sql` was **applied 2026-09-28** (every
> key `fenced_only = false`: no key is fenced yet, nothing is live). Each flip is its own sign-off (section 9.3).

### 9.1 What the fence is

A code cutover alone cannot stop a scheduler job that is **already running** old code, or any other stale writer
(a `refresh=1` builder, a backfill script, the retired brand-inventory rebuild, a reverted deploy). So the fence is
enforced **inside Postgres**, whatever code is deployed:

- `public.report_publication_writer_fence` has one row per route-owned live key: `brand-sales`, `daily-reporting`,
  `brand-inventory`, `listing-health-v3`, `fba-plan`, `sku-movement`, `returns-leakage`, `brand-view`,
  `brand-view-portfolio`, `brand-view-brands`. Every row is seeded `fenced_only = false`, so applying the migration
  changes nothing. `scheduler-v2/*` shadow keys can never be fenced (a CHECK constraint forbids them).
- A `BEFORE INSERT OR UPDATE OR DELETE` row trigger (plus a `BEFORE TRUNCATE` statement trigger) on
  `public.report_snapshots` refuses any write of a key whose row is `fenced_only = true`. The error is SQLSTATE `RWF01`
  with the message `REPORT_WRITER_FENCED:<key>`. The live row is left byte-identical (last-known-good). The trigger
  checks both the old and the new `report_key`, so an `UPDATE` that moves a row into or out of a fenced key is refused
  too.
- The only writer allowed through is `public.cas_report_snapshot_if_newer_fenced`, the fenced CAS behind the four-gate
  publisher. `20260935` re-creates it **byte-identical to 20260919 except one line**:
  `perform set_config('app.report_publication_fenced', 'on', true);`. That line runs only after every lease check
  (owner token, generation, not expired) has passed. The setting is **transaction-local**, so it ends at
  `COMMIT`/`ROLLBACK` and can never leak into another transaction or another pooled connection.
- A `DELETE` of a fenced key is refused as well. The fenced publisher never deletes a live row, and the guarded
  route-shadow prune deletes only `scheduler-v2/*` rows, so the only thing a fenced `DELETE` could stop is a stale
  retention or prune destroying last-known-good.
- **One exemption: deleting a dashboard user.** `report_snapshots.created_by` references `auth.users` with
  `ON DELETE SET NULL`, so deleting a user issues an `UPDATE` of its rows. That `UPDATE` is allowed on a fenced key
  only when `created_by` goes from a user to `NULL` and **every other column** (whole-row comparison, except
  `updated_at`) is unchanged; the trigger then restores `updated_at`, so the row stays byte-identical except
  `created_by`. Any other change in the same `UPDATE` is refused. Proven in PGlite with the real foreign key.
- **A flip is seen by every new statement at once.** Under `READ COMMITTED` (PostgREST and every `pg` writer here)
  each statement, and each query inside the trigger function, takes a fresh snapshot. Only a `REPEATABLE READ` /
  `SERIALIZABLE` transaction that began before the flip keeps the old snapshot until it ends; step 4 below waits for
  those.

`lib/server/sync/report-writer-fence.js` holds the shared contract: the error classifier (`writer-fenced`, LKG
preserved, never retried), the read-only fence reader (zero visible rows is `invalid: no-rows-visible`, never `ok`)
and the per-key status summary for the worker status.

Proof, all offline:

```bash
node scripts/report-writer-fence.test.js                                          # contract, byte identity, writer inventory
PRW_PGLITE_DIR=/tmp/pglite node scripts/worker/report-writer-fence-selftest.mjs  # real SQL in PGlite (exit 3 = SKIPPED)
```

The PGlite self-test also runs the SQL blocks of this section marked `wp15-sql` (trigger check, negative probe,
barrier, mark check), so the documented SQL is proven on real Postgres.

### 9.2 Which writers must be gone before a key is fenced

`scripts/report-writer-fence.test.js` contains the **fail-closed writer inventory**. A new writer that is not listed
fails the test. Writes that are proven to target an unfenced key, or the `scheduler-v2/*` shadow namespace, need no
entry. Section 9.5 says what the scan can and cannot see.

The **machine-checked readiness gate** decides each key. It runs the whole suite, then fails if any inventory entry
other than a fenced-publisher path (a `blocked-by-fence` writer, or any other non-fenced writer) still lists the key:

```bash
REPORT_WRITER_FENCE_READY_KEY=<key> node scripts/report-writer-fence.test.js    # exit 0 = ready; it prints the blockers
REPORT_WRITER_FENCE_DUMP=readiness node scripts/report-writer-fence.test.js     # every key at once (never fails)
```

Snapshot of the gate on 2026-09-28, after WP10b (read-only `refresh=1`; scheduler-v1 APIs refuse route-owned keys) and
WP13 (the scheduler materializers call the fenced route CLI; every legacy unfenced writer retired): **all 10 keys are
ready** (`REPORT_WRITER_FENCE_READY_KEY` exits 0 for each, and for the whole list at once).

| Key | Ready | Retired by | Fenced writers that keep publishing |
|---|---|---|---|
| brand-sales | **yes** | WP13: the scheduler-v1 LIBRARY (`run-sync.js`, `adapters/report-adapter.js`) refuses route-owned keys itself; `backfill-brand-sales.mjs` is an exit-2 stub | OLI reconciler, priority dashboards (scheduler, Data Sync Center, bootstrap, manual-source-sync) |
| daily-reporting | **yes** | WP13: `backfill-daily-v2.mjs`, `backfill-daily-named-brands.mjs` are exit-2 stubs | OLI + Ads reconcilers, priority dashboards |
| brand-inventory | **yes** | WP13: the legacy Brand View materializer and its compact **rebuild** are gone from the workflow and bind no writer | OLI + FBA reconcilers, priority dashboards |
| listing-health-v3 | **yes** | (none needed) | LHv3 reconciler |
| fba-plan | **yes** | (none needed) | `fba-plan-golive.mjs`, `fba-inventory-recovery.mjs`, `fba-durable-source-replay.mjs`, Data Sync Center paid sync (`buildFbaPlanRelease`), fba-plan route |
| sku-movement | **yes** | WP13: legacy `materializeOne` retired | sku-movement route (its LIVE writes are deferred until `SKU_MOVEMENT_SERVE_TOKEN_ATTESTED` is exactly `true`) |
| returns-leakage | **yes** | WP13: legacy `materializeOne` retired | returns-v3 route (the scheduler `materialize` job; `returns-leakage-golive.mjs` spawns it) |
| brand-view, brand-view-portfolio | **yes** | WP13: legacy Brand View materializer retired | brand-view and brand-view-portfolio routes (the scheduler `materialize-inventory` job) |
| brand-view-brands | **yes** | WP13: legacy `materializeOne` retired | brand-view-brands route (the scheduler `materialize` job) |

A key becomes ready when its blockers are deleted or reduced to read-only and their inventory entries go away. A
blocker that is still reachable after a flip corrupts nothing: it fails closed.

**The gate is a static inventory; some writers are proven not-a-writer at RUNTIME.** The scheduler-v1 library and
`report-store.js` keep their generic sinks for the manual-paid keys and refuse route-owned keys by a runtime check. That
refusal is pinned by `scripts/scheduler-v2-route-switch.test.js` and `scripts/refresh-readonly.test.js`, not by the fence
test, so readiness (step 2 below) requires all three suites green on the deployed commit.

**Order matters for `refresh=1`.** WP10b must be **deployed** before any key is flipped. Otherwise a dashboard
`refresh=1` or a scheduler-v1 run of a fenced key spends a paid DataDoe export first and then fails on save (tokens
spent, LKG kept).

### 9.3 Procedure

Each step needs explicit owner sign-off. All SQL here is read-only except the migration, the flip and the probe
(which always rolls back).

1. **Apply the schema** (it enables nothing). Apply `20260934` first if it is not already applied, then:

   ```bash
   cd sales-dashboard-live
   MIGRATE_ONLY=20260935_report_publication_writer_fence.sql npm run db:migrate
   ```

   Verify:

   ```sql
   select report_key, fenced_only, updated_by from public.report_publication_writer_fence order by 1;  -- 10 rows, all false
   select position('set_config(''app.report_publication_fenced'', ''on'', true)' in prosrc) > 0
     from pg_proc where proname = 'cas_report_snapshot_if_newer_fenced';                                -- true
   select count(*) from pg_db_role_setting where array_to_string(setconfig, ',') like '%report_publication_fenced%';  -- 0
   ```

   And **exactly** the expected triggers on `report_snapshots`, all enabled (`tgenabled = 'O'`), with the expected
   timing/events (`tgtype`) and functions:

   <!-- wp15-sql:triggers -->
   ```sql
   select coalesce(array_agg(t.tgname::text || ':' || t.tgenabled::text || ':' || t.tgtype::text || ':' || p.proname::text
                             order by t.tgname::text collate "C"), '{}'::text[])
          = array['report_snapshots_touch_updated_at:O:19:touch_updated_at',
                  'report_snapshots_zz_writer_fence:O:31:enforce_report_publication_writer_fence',
                  'report_snapshots_zz_writer_fence_truncate:O:34:enforce_report_publication_writer_fence']::text[] as exact_triggers
     from pg_trigger t join pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = 'public.report_snapshots'::regclass and not t.tgisinternal;  -- true
   ```

   `false` means stop. **Ordering assumption:** PostgreSQL fires `BEFORE` row triggers of the same event in name order,
   so `report_snapshots_zz_writer_fence` runs last and sees the final `report_key`. A future `BEFORE` trigger that sorts
   after it and rewrites `report_key` would bypass the fence; that is why the set must be exact. The touch trigger runs
   first and only sets `updated_at`. A disabled (`D`) or replica-only (`R`) fence trigger does not fire.

   The migration sets `lock_timeout = 10s`. If it times out behind a long transaction, re-run it later. Nothing is
   half-applied, because the runner wraps it in one transaction.

2. **Deploy code whose only writers for the key are fenced** (section 9.2): WP10b and the WP10 serve on Vercel; WP13 per
   section 9.6 (recommended FENCE-FIRST: the gate then runs on the WP13 commit that is about to be merged). On that
   commit, for **each** key you intend to flip:

   ```bash
   REPORT_WRITER_FENCE_READY_KEY=<key> node scripts/report-writer-fence.test.js   # must exit 0
   node scripts/scheduler-v2-route-switch.test.js && node scripts/refresh-readonly.test.js   # the runtime refusals (9.2)
   ```

   A key that is not ready is not flipped. Also prove that no writer connection carries the mark:

   - database/role level: the `pg_db_role_setting` query in step 1 returns `0` (this also covers the PostgREST roles);
   - connection level: in each `pg` writer runtime (the VM worker env file, and locally with the same `POSTGRES_URL`
     secret value the workflows use), check that neither `PGOPTIONS` nor the URL's `options` parameter sets an `app.*`
     setting. This prints no secret:

     ```bash
     node -e "const u=new URL(process.env.POSTGRES_URL);const o=(u.searchParams.get('options')||'')+' '+(process.env.PGOPTIONS||'');console.log(/app\.|report_publication_fenced/i.test(o)?'STOP: a startup option sets an app.* setting':'ok: no app.* startup option')"
     ```

     The workflows and deploy files are machine-checked for `PGOPTIONS` / `options=` / the mark by the test (F8);
   - runtime: through the same connection path a writer uses, the mark must be empty:

     <!-- wp15-sql:mark -->
     ```sql
     select coalesce(current_setting('app.report_publication_fenced', true), '') as mark;  -- '' (anything else: STOP)
     ```

     For the `pg` runtimes, for example:

     ```bash
     cd sales-dashboard-live
     node --input-type=module -e "import pg from 'pg'; import { verifiedPgConfig } from './lib/server/pg-tls.js'; const c = new pg.Client(verifiedPgConfig(process.env.POSTGRES_URL)); await c.connect(); const r = await c.query(\"select coalesce(current_setting('app.report_publication_fenced', true), '') as mark\"); console.log(JSON.stringify(r.rows[0])); await c.end();"
     # expected: {"mark":""}
     ```

3. **Flip one key** with one approved `UPDATE`, run **on its own** (so it commits by itself):

   ```sql
   update public.report_publication_writer_fence
      set fenced_only = true, updated_by = '<approver>'
    where report_key = '<key>'
   returning report_key, fenced_only, updated_at;
   ```

   Then, in a **separate** run, record a timestamp that is certainly after the flip committed:

   <!-- wp15-sql:barrier-time -->
   ```sql
   select clock_timestamp()::text as flip_committed_by;
   ```

   At the same moment, record the in-flight runs as evidence:

   ```bash
   gh run list --status in_progress --limit 50
   ```

   **No drain is needed once the key is flipped.** A scheduler job that is already running old code fails closed on
   its next write of that key: `RWF01 REPORT_WRITER_FENCED:<key>`, with the live row unchanged. Writes that go through
   the fenced path are unaffected. (Before the flip there is no such protection -- see section 9.6 for the WP13 code
   cutover window.)

4. **Flip barrier.** Repeat this read-only query, with the timestamp from step 3, until **both** numbers are `0`:

   <!-- wp15-sql:barrier -->
   ```sql
   select count(*) filter (where a.xact_start < '<flip_committed_by>'::timestamptz) as pre_flip_transactions,
          count(*) filter (where a.query = '<insufficient privilege>') as invisible_backends
     from pg_stat_activity a
    where a.backend_type = 'client backend' and a.pid <> pg_backend_pid();
   ```

   `0 / 0` proves that no transaction that could still hold a pre-flip snapshot is open. If `invisible_backends` stays
   above `0`, the viewing role cannot see other sessions (run it as the `postgres` role in the SQL editor). If that is
   not possible, use the bounded window instead: only a `REPEATABLE READ` / `SERIALIZABLE` transaction that began
   before the flip is exposed, no current writer of a route-owned key uses one, and every run is bounded by its
   workflow `timeout-minutes`. So wait until every run in the `gh run list` from step 3 has finished.

5. **Verify:**
   - the fence row is `true` and the trigger check from step 1 is still `true`;
   - the **per-key negative probe** is refused with `RWF01`. It runs inside `begin`/`rollback` and never leaves a row:

     <!-- wp15-sql:probe -->
     ```sql
     begin;
     do $probe$
     begin
       insert into public.report_snapshots (report_key, account_id, params_hash, payload)
       values ('<key>', '__writer_fence_probe__', '__writer_fence_probe__', '{}'::jsonb);
       raise exception using errcode = 'P0001', message = 'WRITER_FENCE_NOT_ENFORCED:<key>';
     end
     $probe$;
     rollback;
     ```

     Expected: `ERROR: REPORT_WRITER_FENCED:<key>` (SQLSTATE `RWF01`). `WRITER_FENCE_NOT_ENFORCED:<key>`, or any other
     error, means the fence is **not** enforced for that key: stop and investigate. In every case the transaction
     rolls back, so the probe row never persists;
   - the next scheduler cycle, or zero-export reconcile or route run, writes the key through the fenced path. Its
     publish outcomes are `inserted` / `replaced` / `already-current`, and the exact live read-back and served-row
     checks pass;
   - **zero** `REPORT_WRITER_FENCED` / `writer-fenced` from any fenced writer, in the workflow logs and the Postgres
     logs.

   A `REPORT_WRITER_FENCED` from a legacy writer is the fence working. Record which writer produced it and retire it.
   Never "fix" it by opening the fence.

   Then repeat steps 2 to 5 for the next key.

### 9.4 Rollback

- **A code rollback never disables the fence.** A `git revert` or a redeploy of an older release leaves the fence
  **on**, so a reverted legacy writer fails closed and LKG is preserved. This is the rollback path WP13 relies on --
  **only for keys already flipped**: a revert of WP13 BEFORE its keys are fenced re-enables the retired unfenced writers
  (section 9.6: never revert WP13 before the flip; fence-first avoids the question).
- **Opening a key again is a separate, explicitly approved DB change**, recorded as *re-enabling unfenced writers for
  `<key>`*. Do it only after proving that no known-unsafe writer of that key is deployed or running:

  ```sql
  update public.report_publication_writer_fence set fenced_only = false, updated_by = '<approver>' where report_key = '<key>';
  ```

- **Schema rollback:** `deploy/publication-recovery/ROLLBACK_20260935.sql`, in the SQL editor. It sets
  `lock_timeout = 10s` (fails fast behind a long transaction; nothing half-applied), restores the 20260919 fenced CAS
  byte-identical, then drops the triggers, the trigger function and the table, and deletes the ledger row. It
  re-enables unfenced writers for **every** key, so it needs the same approval.
- **Re-apply after a schema rollback.** The migration file stays in `supabase/migrations`, so a later full
  `npm run db:migrate` (without `MIGRATE_ONLY`) re-applies it. That is behaviour-neutral: every key comes back
  `fenced_only = false`, so nothing is refused until a new approved per-key flip.

### 9.5 Honest limits

- **The database trigger is authoritative.** The fence protects against stale **application** writers. It does not
  protect against a privileged database operator: a superuser can disable triggers, set
  `session_replication_role = replica`, or set the marker by hand.
- The marker stays set until the end of the fenced CAS's **own** transaction. Its only caller is the single-statement
  PostgREST RPC in `supabase.js`; the test pins that there is no `pg`-direct caller and that no application code,
  workflow or deploy config sets the marker.
- The created_by exemption is shape-based, not caller-based: anyone may null `created_by` on a fenced row. It cannot
  change content or which row is served (every other column, including `updated_at`, is unchanged).
- Scheduler-v1 retention of a fenced key stops: its errors are swallowed and the rows are kept. If table growth for
  that key ever matters, clean it up with a separate, approved maintenance step.
- Storage objects are outside the fence. The fenced publisher writes inline payloads, and no current code writes a
  report-snapshot payload object.
- **What the static inventory catches.** It scans `lib/`, `api/` and `scripts/` (not the offline `*.test.js` suites;
  `src/` is checked separately and never names the table, and no JS outside these trees may name it or the sinks).
  It follows the `supabase.js` sinks through imports, aliases, namespaces, dynamic imports, `require` and wrappers;
  direct SQL, REST, RPC and supabase-js writes, also when the table or RPC name is built from concatenated or
  templated literal fragments or string constants (local, module-level or imported), in upper case, `%5F`- or
  `\x5f`-encoded, or schema-quoted (`"public"."report_snapshots"`), and when the method comes from an options object.
  Shadow-key proofs must cover the whole key expression, and a DI forwarder stays tainted on any reference other than
  a proven call. A **coarse tripwire** then requires every file whose code mentions `report_snapshot*`, or makes a
  non-GET REST call with a computed path, a `.from(x)` write, a `.rpc(x)` call, SQL DML on a computed target or an
  `import(x)` / `require(x)` with a computed specifier, to be listed with its exact hit count.
- **What it does not catch.** A table name assembled by other means (array `join`, character codes, base64,
  environment variables or files), `eval` / `new Function`, a DI function reached without its name (generic iteration
  over a deps object, or a computed property name built from separate variables), a spawned process running a file
  outside the scan, inline code in workflow YAML, and SQL run by hand. The scan is a review aid for honest mistakes,
  not a security boundary. PGlite is single-session,
  so concurrent sessions are not exercised; the trigger itself is per-row and holds no state.

### 9.6 The WP13 scheduler cutover (deploy order and the rollout window)

WP13 makes the scheduler-v2 `materialize` (brand-view-brands, sku-movement, returns-v3) and `materialize-inventory`
(brand-view, brand-view-portfolio) jobs call the fenced route CLI unconditionally, removes the unfenced brand-inventory
rebuild from the workflow, and retires every legacy unfenced writer (9.2). Owner decisions are marked **(owner)**.

**Preconditions before WP13 reaches the default branch:**

1. WP10b and the WP10 serve are deployed on Vercel and smoke-tested. brand-view-brands relies on the WP10 hydrated serve. The
   sku-movement route DEFERS every live write (`sku-movement-serve-not-attested:route-not-activated`, zero writes) until
   `SKU_MOVEMENT_SERVE_TOKEN_ATTESTED` is exactly `true`, so a merge-order slip leaves SKU Movement on the read-only serve
   (correct, but slower) and never pushes a row the deployed serve cannot serve. Set the variable only after the WP10
   serve is live.
2. 20260934 and 20260935 are applied (every key `fenced_only = false`).
3. On the WP13 commit: `REPORT_WRITER_FENCE_READY_KEY=<key>` passes for every key, and `scheduler-v2-route-switch` +
   `refresh-readonly` pass.
4. **(owner)** brand-inventory freshness is accepted after this read-only check. Without the rebuild, the same-day
   conversion of the cycle's `inventoryAvailable:false` placeholder depends on the `fba` job's immediate FBA reconcile
   (`FBA_RECONCILE_LIVE`) and the once-daily `fba-publication-reconcile.yml` backstop (20:48 UTC). The serve always picks
   the newest AVAILABLE compact (never a fabricated zero), so the risk is staleness, not wrong data.
   **D3 (2026-09-28): the reconcilers used to STARVE a fixed tail.** Both walked the stale accounts in sorted id order and
   stopped at their deadline: the `fba` step (300 s = a 180 s start cutoff, ~20 s per account) always reached the first
   8 europe-au ids and the backstop the middle ones, so the last five FBA-active accounts (b7b13aac, bf623cf8, f08cefca,
   f0bd8ce3, fbd72f10) were made available ONLY by the rebuild WP13 retires (on every day checked; their last fenced
   available row was 2026-09-23). Fixed without any new writer: the `fba` step's reconcile deadline is 900 s (780 s start
   cutoff covers all 32 europe-au accounts) and the FBA reconciler executes its stale accounts in a FAIR order
   (`fba-publication-reconciler.js fbaFairOrder`: stocked before honest-empty, then the OLDEST dashboard-served
   inventory date first, then a per-day tie), so whenever a deadline still cuts, the next run starts with whoever was
   left behind (`scripts/fba-reconcile-fairness.test.js`, incl. the multi-day starvation simulation). Every account also
   gets its OWN budget (`fba-publication-reconcile.mjs ACCOUNT_DEADLINE_SECONDS`: a quarter of the run deadline within
   [60, 180] s -- 180 s in the 900 s `fba` step, 82 s in the 330 s backstop and the recovery worker's fba child; ~4-9x the
   typical ~20 s): a hung account is aborted (its fence goes null: the fenced CAS writes nothing), deferred `deadline-account-in-flight` with LKG
   kept, and the run CONTINUES -- so ONE account whose abort is confirmed can never consume the whole window. **Honest
   limit (review 2026-09-29):** the fair order has no memory of earlier attempts, and an account that never publishes
   keeps the oldest served date, so it LEADS every run. The fairness bound therefore assumes every account a run starts
   completes: (a) an account whose termination is NOT confirmed within the 8 s grace stops the run (as before, the lease
   and controls are left for cleanup), and at the head of the order that now stops every run for the region; (b) about 3
   accounts that keep exceeding the 82 s budget exhaust the 330 s backstop (about 5 over 180 s for the 900 s step). The
   recovery worker is protected (a timed-out target backs off and dead-letters after PRW_MAX_ATTEMPTS; the others run in
   their own batches). A recurring `deadline-account-in-flight` / `deadline-termination-unconfirmed` for the same account
   is therefore an operator signal: investigate that account. Trade-offs to
   know: the europe-au step now holds the GLOBAL control lease up to ~11-15 min (32 x ~20 s, renewed with a 900 s TTL
   before every account's publish; the LHv3 reconciler's 720 s hold is the precedent). EVERY bounded lease-waiter that
   starts inside that hold waits at most its own cap -- another region's `materialize` / `materialize-inventory` route
   CLIs, control applies, `fba-plan-golive`, the other immediate reconcilers and the evening backstops (600 s, never past
   their own start cutoff), the half-hourly OLI outbox drain (210 s) -- and if the hold outlasts it, that pass publishes
   nothing and keeps LKG (the next pass / cycle retries). The old 300 s hold was shorter than every 600 s cap; now a
   waiter can outlast its cap, which needs two regions' downstream jobs to overlap (e.g. an overrunning india
   `materialize` during europe-au's `fba` step). The `fba` job's 120-minute timeout now has to cover fba-plan-golive plus
   up to ~15 min of reconcile. If the timeout ever cuts the reconcile step (continue-on-error; the step has NO in-job
   cleanup): no partial row is possible (each account is one fenced CAS), unreached accounts keep LKG, the lease lapses
   within its 900 s TTL, and controls left open are rolled back by a `--cleanup` (the 20:48 UTC backstop runs one as a
   separate always() job; it reclaims only a free or expired lease -- the `fba` step runs under its OWN `--run-token`
   lease owner, never the backstop's or a manual dispatch's shared `fba-reconcile:<region>:<as-of>`, so an overlapping
   backstop waits on `CONTROL_LEASE_HELD` instead of sharing the step's fence); the next reconcile that opens its controls (the backstop, or
   the next cycle's `fba` step in fair order: the unreached accounts first) converges them. To converge sooner, dispatch
   `fba-publication-reconcile.yml` (`mode=live`, the region's bucket; zero export) -- never re-run the `fba` job for it. The backstop keeps its 330 / 420 s (the recovery worker's fba argv pins
   it). After the WP13
   merge the proof is the next europe-au `fba` step's RESULT (32 examined, the five tail accounts published through the
   fenced CAS, read back) plus this query:

   ```sql
   -- per recent D-1: brand-inventory rows that are available / placeholders / out-of-line, and how many the (retired)
   -- rebuild wrote (params.depFingerprint). 'available' should be ~ every FBA-active account WITHOUT the rebuild.
   select params->>'to' as to_date,
          count(*) filter (where payload->>'inventoryAvailable' = 'true')  as available,
          count(*) filter (where payload->>'inventoryAvailable' = 'false') as placeholder,
          count(*) filter (where nullif(btrim(payload_storage_path), '') is not null) as out_of_line,
          count(*) filter (where params ? 'depFingerprint') as rebuild_written
     from public.report_snapshots
    where report_key = 'brand-inventory' and params->>'to' >= (current_date - 4)::text
    group by 1 order by 1;
   ```

**The rollout window (owner rule: no window in which an unfenced legacy writer and a route can both write a key,
including an already-running old job).** GitHub Actions keeps the OLD workflow file and the OLD checkout for every run
that was in flight or queued when WP13 merged, and for any manual "Re-run" of such a run. Until a key is fenced, those
runs still execute the retired unfenced writers (the legacy materializers, the brand-inventory rebuild), while new-code
runs publish the same keys through the routes. Within one region the per-region concurrency group serializes the runs,
but another workflow (e.g. `returns-leakage.yml`) can overlap. Two orderings:

- **FENCE-FIRST (recommended; closes the window).** With preconditions 1-3 met, IMMEDIATELY BEFORE merging WP13 run, for
  every key, section 9.3 step 3 (flip), step 4 (barrier) and the step-5 per-key NEGATIVE PROBE; then merge WP13 and run
  the rest of step 5 (the fenced publish through the new code) AFTER the merge -- it cannot pass earlier for the five
  scheduler route keys, and for sku-movement only once `SKU_MOVEMENT_SERVE_TOKEN_ATTESTED` is set. From the flip on,
  every old-code writer fails closed (`RWF01`, LKG kept). Between the flip and the merge the old `materialize` /
  `materialize-inventory` jobs MAY go red (a legacy run exits 1 only when every unit errored; a run with any 'unchanged'
  unit still exits 0), so keep that gap short -- note that step 4's bounded fallback (when `pg_stat_activity` is not
  visible) can take up to the longest in-flight run's timeout. Re-runs of pre-cutover runs are then harmless (they fail
  closed), and a WP13 revert can never re-enable an unsafe writer.
- **Merge-first (accepted window).** Record `gh run list --workflow scheduler-v2.yml --status in_progress` (and
  `queued`) at merge, never re-run a pre-cutover run, flip every key promptly (9.3), and never revert WP13 before the
  flip. Low practical harm (a legacy row always precedes the route row in a region and the route overwrites it; the
  rebuild's content matched the reconcilers'), but the owner rule holds only after the flip.

**Lease fairness.** A live route run holds the GLOBAL control lease in windows of up to 90 s and now leaves it free for
30 s between windows (`ROUTE_CLI_INTER_WINDOW_PAUSE_MS`, twice the 15 s retry interval of every bounded lease-waiter).
The run job's control applies and `fba-plan-golive` wait up to 600 s; the immediate Ads (`ads_reconcile`), Listing
Health v3 and FBA (the `fba` job's step) reconcilers, the evening OLI / FBA / Ads / LHv3 backstops and the half-hourly
OLI outbox drain now wait too (`--lease-wait-seconds=600` on their PERIODIC controls apply, never past their own start
cutoff -- the safe-close reserve stays intact, though a long wait can use up a run's work window and defer its accounts
with LKG kept), instead of deferring every account on one `CONTROL_LEASE_HELD`. Still single-attempt:
`manual-source-sync` (an operator tool -- retry it) and any immediate-mode reconcile (it renews the scheduler's fence). The critical path is longer (`materialize` now runs
after `fba`): worst case run 180 + fba 120 + materialize 80 + materialize-inventory 90 = 470 min, against 330 min between
the india and europe-au starts; the typical case is far shorter, and a region that overruns only waits on the lease.

**Cleanup edge cases (unchanged WP4 pattern).** The always() cleanup uses the SAME run token as the route step, i.e. the
SAME lease owner: `acquire_control_plane_lease` grants a same-owner renew (without bumping the fencing generation), so
it reclaims IMMEDIATELY, rolls the controls back and releases the lease -- safe because the cleanup starts only after the
route step's process has exited; a fenced CAS still in flight server-side either landed before the release (validated
prepared content) or is refused lease-lost after it. A cleanup (or any caller) with a FOREIGN token reclaims only a FREE
or EXPIRED lease. A cleanup that finds another operation's live lease goes red and leaves that lease untouched -- read the
log before acting on it.
