# Scheduler v2 — Production Rollout Runbook (Phase 1f)

**Current status (2026-08-16, supersedes the historical status below):** reviewed `main` commit
`02c2ef5858cb4bcb6b11ca5da5611e3fd5e080e1` is pushed and deployed to production as Vercel deployment
`dpl_GzXYRLSKGYJKwMzU5oTVozkfn56x` (`p7un5uel8` was superseded), with the production alias
`upriverdashboard.vercel.app` returning HTTP 200. The durable rollout remains restricted to the one approved IN
account (`d658442d-6273-4c2d-aeda-f247e638ef98`), `all_primary=false`, and no cron exists. Four IN reports are now
live and approved: `brand-sales`, `content-changes`, `keyword-rank`, and `listing-optimizer`. The other nine reports
remain disabled and unapproved after an honest fresh-cycle failure caused by typed DataDoe export timeouts. Europe,
USA, and every other account remain excluded. See Appendix AI for the complete execution evidence.

**Historical status (2026-08-14): Migrations 1–5 APPLIED + VERIFIED; the Gate 5 one-account brand-sales SHADOW canary has
been EXECUTED (SUCCESS) and its cycle RECONCILED to `succeeded` via Appendix N (EXECUTED 2026-08-14).**
Scheduler v2 otherwise remains in SHADOW MODE and closed: it is **locked** (the code readiness allowlist
`SCHEDULER_V2_READY_REPORT_KEYS` is empty), **paused** (all 13 durable `report_sync_settings` rows have
`schedule_enabled=false`), **undeployed**, and **unscheduled** (no `pg_cron`/`pg_net` kickoff applied; no cron
sync job). **Exact current operational state (FIVE terminal cycles; NO cycle running):** the Scheduler-v2
`sync_cycles` table holds **exactly five rows**, each terminal (`succeeded`/`partial`) with a non-null
`finished_at` — the Gate-5 canary + the two Gate-6 Cycle-1 + the two Gate-6 Cycle-2 shadow cycles:
`57afc1fb-6694-4925-8961-4730f5a8f4df` **`succeeded`** (sources 2/2/0, reports 1/1/0 — Gate-5 canary, Appendix N.4);
`56422a66-9f23-43c9-9c8d-8a9427f8f36a` **`partial`** (sources 57/44/13, reports 13/2/11 — Gate-6 Cycle-1 us, Appendix P);
`ac4cba6f-3214-4d9b-9be7-35c572890edf` **`partial`** (sources 56/39/17, reports 13/3/10 — Gate-6 Cycle-1 non-us, Appendix P);
`b0415a5b-3926-48b0-885e-5dfb61489d74` **`partial`** (sources 135/84/51, reports 13/4/9 — Gate-6 Cycle-2 us, Appendix T);
`c70879e8-006b-4dba-9896-813106b5aa74` **`succeeded`** (sources 133/133/0, reports 13/13/0 — Gate-6 Cycle-2 non-us, Appendix T).
Their shadow snapshots live ONLY under the `scheduler-v2/*` namespace (never a production `report_snapshots`
key); the production Brand Sales
`report_snapshots` fingerprint is **byte-identical** (`cba3fb26…`, 7 rows — unchanged through the canary, the
Migration-5 gate, AND the reconciliation); and `report_sync_settings` still contains **exactly the 13 seeded
control rows, all `schedule_enabled=false`**. No control unlock, deployment, schedule, route, or frontend change
has been made. **BLOCKER 1 (drained-cycle lifecycle) — RESOLVED IN PRODUCTION 2026-08-14:** the CODE fix
(dispatcher-owned finalization with a TOTAL typed disposition; the `finalizeSyncCycle` wrapper + composed-store
`finalizeCycle`; the audited RPC/trigger contract; the fail-closed preflight/dispatcher; the
complete-scheduled-scope-only auto-finalize semantics) was reviewed and committed, **`20260815_sync_cycle_
finalize.sql` was applied via its own reviewed single-file Gate (Appendix O)**, and the one running Gate-5
canary cycle was **reconciled via the reviewed Appendix N procedure** — `disposition='finalized'`, zero DataDoe
calls, no child/snapshot/control row touched. The `.sql` file itself stays byte-frozen (SHA-256 `5222a8e5…`;
its "PREPARED — UNAPPLIED" header note is historical text from review, kept to preserve the frozen hash — the
ledger row `2026-08-14T16:27:31.800Z` is authoritative). **Gate 6 Shadow Parity CYCLE 1 was EXECUTED 2026-08-14
with explicit authorization** (Appendix P): one production-shaped SHADOW cycle per bucket for ALL 13 reports on
two representative accounts — both cycles drained and finalized to an honest **`partial`** under the corrected
lifecycle (us `57/44/13` sources + `13/2/11` reports; non-us `56/39/17` + `13/3/10`); 5 new `scheduler-v2/*`
snapshots; production fingerprints byte-identical; ONE parity defect found and FIXED in code (the brand-sales
derive now emits the route's additive `asinBrand` map — commit `bb37a4e`); 30 DataDoe export TIMEOUTs on the
largest datasets and the EMPTY durable `ads_sync_coverage` (PPC prerequisite) are recorded as upstream findings
needing DataDoe/Ads-sync input. **Gate 6 Shadow Parity CYCLE 2 was EXECUTED 2026-08-15 with explicit
authorization** (Appendix T) after the timeout-slicing + Ads-coverage remediations. **Gate-6 completion
judgement (recorded 2026-08-15): NON-US = PASS (13/13 reports succeeded; cycle `succeeded` 133/133/0 sources);
US = PARTIAL (4/13 reports; cycle `partial` 135/84/51 — every failure a US-account DataDoe export TIMEOUT,
zero code defects); a GLOBAL unlock is NOT approved.** The Appendix Q.4 DataDoe questions remain the gating
input for US-account stability. **Gate 7 (2026-08-15, OFFLINE code/tests only): the productionization
foundation is IMPLEMENTED but INERT** — (a) migration 6 `20260816_account_rollout.sql` is **PREPARED and NOT
APPLIED** (durable per-account rollout allowlist + a separate durable all-primary switch, both defaulting to
ZERO accounts, + explicit per-(report,account) publish approvals); (b) the dispatcher now REQUIRES the trusted
durable rollout for every SCHEDULED run and fails closed to a zero-I/O drained no-op on a read failure or the
default zero-account state (manual shadow canaries unchanged); (c) a reviewed shadow-to-live publisher exists
but is QUADRUPLE-LOCKED (code readiness — still frozen EMPTY — + durable report enable + durable account
enable + explicit publish approval) with CAS newer-live-wins semantics against the 13 statically pinned live
report contracts; NO route, cron, or dispatcher path invokes it (Appendix U). A PREPARED, NOT-executed
IN-only rollout package is Appendix V. **Gate-7 CORRECTION TRANCHE (2026-08-15, OFFLINE, post-Codex-review):**
(1) the durable account rollout now gates EVERY dispatch — scheduled AND production-manual — with
`manualReportKeys` selecting REPORTS only; isolated canaries use the BUILD-TIME trusted canary composition
(`buildSchedulerV2CanaryRuntime`, exact ids validated against fresh primary discovery; no per-run bypass);
(2) publication binds to the EXACT successful job snapshot (validated=true + `snapshot_params_hash` natural
identity + hash echo; storage-backed payloads hydrate fail-closed); (3) the publisher account gate resolves
the durable rollout against REAL memoized fresh discovery (an undiscovered/stale or dd-secondary account can
never publish, even under all_primary), via the trusted `buildSchedulerV2Publisher` composition whose
`publish(reportKey, accountId)` caller can inject nothing; (4) the CAS replacement explicitly clears
`payload_storage_path`; (5) migration 6 carries DB-enforced identity + audited-decision constraints
(nonblank ids, dd-secondary rejection, nonblank `approved_by` + non-null `approved_at` on EVERY decision
row), proven by exact table-scoped schema-contract audits — migration 6 REMAINS UNAPPLIED; migrations 1–5
byte-identical. **Gate-7 CORRECTION TRANCHE 2 (2026-08-15, OFFLINE, post-Codex-review):** (1) equal-freshness
publication no longer assumes payload equality — the CAS primitive, at an EQUAL `source_refreshed_at`,
canonically compares live-vs-candidate params AND payload (hydrating a storage-backed live row) and returns
`already-current` ONLY when PROVEN identical, else a typed `publish-conflict` (zero write, live LKG
byte-identical); a strictly-newer live row wins, a strictly-older is guard-replaced; there is NO unconditional
equal-timestamp overwrite; (2) the publisher now PROVES `shadow.params` produced `job.snapshot_params_hash` by
recomputing `paramsHashFor(params.reportVersion, params)` and requiring the recompute, the row's `params_hash`,
and the job hash to be ALL identical, and swaps the regex date test for the shared STRICT calendar-date
validator (impossible dates + reversed `from/to` rejected; each of the 13 exact live param shapes preserved);
(3) migration 6 adds named canonical-identity constraints (`account_id`/`report_key`/`approved_by` =
`btrim(...)`) and the rollout reader/resolver + `buildSchedulerV2CanaryRuntime` now FAIL CLOSED on noncanonical
durable ids (never silently trimmed into another account; the canary also rejects duplicate ids). **Migration 6
REMAINS UNAPPLIED (new frozen SHA-256 `bd03301ce71c13db419cf950e537c46f4e1fe7d8fd2c8291952c667ac61457a7`);
migrations 1–5 byte-identical.** No control unlock, publish, deploy, schedule, or migration apply has happened
in Gate 7. **Gate 7 PASSED final Codex review; the Gate 7a APPLY package (apply ONLY
`20260816_account_rollout.sql`, the reviewed single-file gate) is PREPARED as Appendix W but NOT EXECUTED** —
no production connection was made preparing it. **Appendix W was HARDENED per Codex re-review (2026-08-15,
docs-only):** its inventory/verification steps are genuinely read-only (`BEGIN; SET TRANSACTION READ ONLY; …`
with an always-ROLLBACK `finally`), every object check is scoped to the exact `public` relation/function OID (a
same-named object in another schema can neither PASS nor false-STOP), the unchanged-data claim is backed by
deterministic count+content digests compared before/after the apply (no "counts alone"), and the complete table
ACL is enumerated + asserted before COMMIT. **Gate 7a EXECUTION was AUTHORIZED and ATTEMPTED (2026-08-15):**
W.0 offline preflight PASSED; corrected W.1 read-only inventory PASSED (baseline `cycles_count=5`/`snap_count=23`);
**W.2 REFUSED at the pre-COMMIT ACL gate** — inside the transaction `service_role` held ALL 8 PostgreSQL-17
table privileges (Supabase project-level DEFAULT PRIVILEGES grant `service_role` ALL on every new public table),
not the required exactly SELECT/INSERT/UPDATE. The ACL gate did its job: **the transaction ROLLED BACK before
the ledger insert/COMMIT, Migration 6 remained UNAPPLIED, and the W.1 baseline re-read byte-identical.** The
genuine defect was fixed OFFLINE: the migration now `REVOKE ALL … FROM public, anon, authenticated, service_role`
then `GRANT SELECT, INSERT, UPDATE … TO service_role` on all three tables (least privilege; no
delete/truncate/references/trigger/maintain), proven by a new static `auditServiceRoleAcl` (typed blockers
`SERVICE_ROLE_REVOKE_MISSING`/`_GRANT_MISSING`/`_GRANT_MISMATCH`) and regressions (Gate-7 suite 45 checks;
Appendix U.1/U.5). The migration body changed, so the frozen SHA-256 became NEW
(`bd03301ce71c13db419cf950e537c46f4e1fe7d8fd2c8291952c667ac61457a7`). **Gate 7a was then RE-AUTHORIZED and
EXECUTED SUCCESSFULLY 2026-08-15 against that hash (Appendix X): W.0 / W.1 / W.2 / W.4 ALL PASSED, and
Migration 6 is now APPLIED** — ledger `applied_at 2026-08-15T14:37:02.726Z` (exactly one row); the pre-COMMIT
ACL gate passed with `service_role` = EXACTLY SELECT/INSERT/UPDATE on all three tables (W.4 re-proved it
post-commit); the data plane is byte-identical to the W.1 baseline (digest-proven: `cycles_digest=a8c97132…`,
`snap_digest=3c4a1ed7…`). **All three tables are EMPTY except the seeded singleton `scheduler_rollout_mode
(1, all_primary=false)`, so the durable rollout selects ZERO accounts and NOTHING is approved — the system
stays fully off at the data layer.** Migrations 1–5 remain byte-identical; all 13 `report_sync_settings` rows
`schedule_enabled=false`; no `pg_cron`; no route/frontend/deploy change. **GATE 7b PREPARED (2026-08-15,
OFFLINE — NOT DEPLOYED): the reviewed code cutover sets `SCHEDULER_V2_READY_REPORT_KEYS` to an EXPLICIT
hand-authored frozen literal of the 13 individually-approved report keys** (the reports the IN account cleared
in Gate 6; NEVER derived/spread from `CONTROLLED_REPORT_KEYS` — a future controlled report cannot inherit
readiness, and the preflight fails closed with typed `V2_READINESS_*` blockers on a duplicate/unknown/miscounted/
non-contract list or a ready key outside the literal). Readiness ON changes no runtime behavior on its own — the
durable account rollout (ZERO accounts), the durable report controls (13 paused), and the per-(report, account)
publish approval (none) still gate every dispatch/publish, proven by `scripts/gate7b-in-cutover.test.js` (6
checks incl. a per-report all-13 real-dispatch IN-only ownership proof: `selected=[report]`,
`accountsDispatched=[IN]`, owners/jobs/snapshots scoped to IN, USA + other-non-US zero) plus the
explicit-readiness-allowlist regression (a synthetic future controlled report never auto-becomes-ready) and full
`npm run verify` (39 steps / 19 suites incl. `build:check`). **The reviewed IN-only all-13 production cutover sequence + exact rollback is
Appendix Y; USA stays fully excluded and needs a SEPARATE per-`(report, account)` gate (Y.5).** Nothing in Gate
7b has been deployed/published/scheduled and no production connection was made preparing it. The next gate
(Appendix Y — Gate-7b IN cutover) remains BLOCKED pending Codex review + a separate explicit authorization.
Every remaining live step is **gated on explicit human approval**, one step at a time.
This document is the plan Codex senior review evaluates; it does not authorize any step by itself.

The composed runtime + the no-side-effect preflight this runbook drives live in
`sales-dashboard-live/lib/server/sync/runtime-composition.js`; the migration↔wrapper compatibility matrix it
checks lives in `sales-dashboard-live/lib/server/sync/schema-contract.js`. Both are covered by
`scripts/sync-runtime-composition.test.js` (offline, zero I/O).

---

## 0. Preconditions (no live effect)

- [ ] `npm run verify` is green on `feature/scheduler-v2` (includes the Phase 1f composition + audit tests).
- [ ] `schedulerV2Preflight(...)` returns `{ ready: true, blockers: [] }` in CI against the committed
      migrations + wrappers (static schema audit). A non-empty `blockers` array **stops rollout**.
- [ ] The four migrations are reviewed and unchanged since this audit:
      `20260807_scheduler_v2.sql`, `20260810_ads_sync_coverage.sql`, `20260810_report_sync_controls.sql`,
      `20260811_sync_source_job_owners.sql`.
- [ ] Supabase Vault holds the service-role key; `DATADOE_API_KEY` (+ optional `DATADOE_API_KEY_SECONDARY`)
      and `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are configured for the runtime.
- [ ] Confirm every Scheduler-v2 control is LOCKED: `schedulerV2ReportControlCatalog([])` has zero
      `ready`/`scheduleEnabled` reports (the preflight asserts this and fails closed otherwise).

**Approval gate 0 → proceed only with written sign-off.**

---

## 1. Migration order (apply one at a time; all four are ADDITIVE + IDEMPOTENT)

Apply in this order. All four are additive and idempotent and **do NOT DROP any table or touch historical Ads
data**. Steps 1–3 only `create ... if not exists` / `create or replace` (they add NEW tables/RPCs and never
alter an existing table). Step 4 is different and must be understood before applying: it CONVERGES an
already-unapplied `sync_source_job_owners` table to a final shape and therefore additively **ALTERs** it —
`add column if not exists connection_id`, a deterministic backfill of `connection_id` from the SAFE public
account scope, `alter column ... set not null` / `drop default`, and named `add constraint` checks. It changes
NO other table and stores NO secret, but it is NOT a pure `create if not exists`. **Approval required before
each `apply`.**

1. `20260807_scheduler_v2.sql` — creates `sync_cycles`, `sync_source_jobs`, `sync_report_jobs` +
   RPCs `open_sync_cycle`, `claim_sync_cycle`, `claim_source_export_attempt` (new objects only).
2. `20260810_ads_sync_coverage.sql` — creates `ads_sync_coverage` (durable Daily/PPC coverage windows).
3. `20260810_report_sync_controls.sql` — creates `report_sync_settings` (every report seeded `schedule_enabled=false`).
4. `20260811_sync_source_job_owners.sql` — establishes `sync_source_job_owners` (many-to-many source
   ownership). ADDITIVELY **ALTERs / backfills / constrains** an existing earlier-shape owner table so a fresh
   DB and an already-created earlier-shape table converge to the SAME final schema. It **FAILS CLOSED** (raises
   and aborts the migration) if any pre-existing owner row has a blank/invalid identity
   (report_key / account_id / request_key / organization_fingerprint / account_scope_hash) or a
   connection_id that is not `primary`/`dd-secondary` after backfill — such rows must be repaired or removed
   BEFORE applying. It never rewrites a `dd-secondary:` account as primary.

> The `pg_cron` / `pg_net` kickoff + its Vault secret are a SEPARATE migration
> (`20260808_scheduler_v2_kickoff.sql`) that is **intentionally NOT part of this rollout** and is applied only
> after a fully reviewed live cutover. Applying steps 1–4 alone creates NO DataDoe request and NO schedule.

## 2. Two DISTINCT schema checks — do not conflate them

- **STATIC source-compatibility audit** (`auditSchemaContract` / `schedulerV2Preflight`): runs in CI on the
  **committed SQL text + the committed `supabase.js` wrappers**, BEFORE any migration is applied. It reads
  files only — it never touches the database, DataDoe, or a secret. It proves the migration SQL and the
  calling wrappers AGREE (declared tables/columns/unique+named constraints, RPC parameter names/order, and
  every required wrapper export). A non-empty `blockers` array is a **source/contract** problem and stops
  rollout. It says NOTHING about whether the objects exist in a live database.
- **LIVE post-migration schema verification** (the queries below + an optional live `probeSchema`): run against
  the **actual database AFTER each migration** to confirm the objects were really created/altered as expected
  (and, for step 4, that the ALTER/backfill succeeded and no row failed the fail-closed identity check). This
  is a read-only DB check; it is the only check that proves the migration was applied correctly.

Both must pass: the static audit gates whether it is SAFE to apply; the live verification confirms it WAS
applied correctly. Neither substitutes for the other.

## 2a. Verification queries (LIVE — run read-only after EACH migration)

```sql
-- tables exist (expect 6 rows across the four migrations)
select table_name from information_schema.tables
 where table_schema='public'
   and table_name in ('sync_cycles','sync_source_jobs','sync_report_jobs',
                      'ads_sync_coverage','report_sync_settings','sync_source_job_owners')
 order by table_name;

-- RPCs exist (expect 3)
select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public'
   and proname in ('open_sync_cycle','claim_sync_cycle','claim_source_export_attempt')
 order by proname;

-- one-attempt + dedup constraints exist
select conname from pg_constraint
 where conname in ('sync_source_jobs_cycle_hash_unique','sync_source_jobs_one_attempt',
                   'sync_report_jobs_cycle_report_account_unique','sync_source_job_owners_unique',
                   'sync_source_job_owners_source_fk');

-- every report control is PAUSED (schedule_enabled=false) after step 3
select report_key, schedule_enabled from public.report_sync_settings order by report_key;
-- expect: 13 rows, all schedule_enabled = false.

-- no cycle has run yet (expect 0 rows)
select count(*) from public.sync_cycles;
```

Re-run `schedulerV2Preflight(...)` after the migrations; it must stay `ready:true` with an empty `blockers`.

**Approval gate 2 → proceed only if all queries match expectations.**

---

## 3. Token budget

- **Discovery**: one DataDoe accounts GET per configured connection (primary only in current prod). Not an export.
- **One-account shadow canary (§5)**: bounded by an explicit `maxJobs` and a wall-clock `deadlineMs`. Set
  `maxJobs` to the exact number of canonical source request_hashes the canary report plans for ONE account
  (e.g. Brand Sales = 2: `order-lines` + `catalog`), so the canary can never exceed that budget.
- One create-export **per canonical `request_hash` per cycle** is enforced durably by
  `claim_source_export_attempt` (DB-level one-attempt guard) — a retry/parallel worker never re-POSTs.
- A cap-sized (`strict`) result is rejected as `TRUNCATED` and spends its one export without saving partial
  data; it is retried only on a NEW cycle.
- **Stop** if observed create-export count for the canary exceeds `maxJobs`, or if any account other than the
  canary account acquires a source job.

## 4. Last-known-good (LKG) checks (before AND after any shadow run)

- Shadow snapshots are written under the namespaced key `scheduler-v2/<reportKey>` and **never** overwrite a
  production `report_snapshots` row. Confirm production snapshots are unchanged:
  ```sql
  -- production snapshot count/hashes for the canary account must be identical before vs after the canary.
  select report_key, count(*), max(updated_at)
    from public.report_snapshots
   where report_key not like 'scheduler-v2/%'
   group by report_key order by report_key;
  ```
- A failed/blocked/unavailable/invalid derive preserves LKG: the report writes NO snapshot and leaves the
  previous good snapshot + `last_good_snapshot_at` untouched (worker discipline; unit-tested).
- Source LKG: a failed source never overwrites `source_export_cache`; `cache_object_path` +
  `last_good_fetched_at` are preserved.

## 5. One-account shadow canary procedure (SHADOW; snapshots namespaced)

Runs the composed runtime for exactly ONE primary account, ONE report, under a tight budget, writing ONLY
`scheduler-v2/*` shadow snapshots. **Approval gate required before starting.**

1. Choose ONE primary account (`accountId`) and ONE report (recommend `brand-sales`, a generic single-shot).
2. Temporarily allow ONLY that report through a **scoped** control catalog for the canary run (do NOT edit
   `SCHEDULER_V2_READY_REPORT_KEYS`; pass a one-report `controlCatalog` to `buildSchedulerV2Runtime` for the
   canary only). Discovery is restricted to the canary account (inject a `fetchAccounts` returning just it).
3. Run one bounded slice:
   ```
   const rt = buildSchedulerV2Runtime({ /* production primitives */,
     controlCatalog: () => [{ reportKey: 'brand-sales', ready: true, scheduleEnabled: false }],
     fetchAccounts: async () => [ /* the ONE canary account */ ] });
   await rt.run({ bucket: 'us', cycleDate: '<today>', asOf: '<today>',
                  manualReportKeys: ['brand-sales'], maxJobs: 2, deadlineMs: <now + 60s> });
   ```
4. Confirm: exactly one `sync_cycles` row; ≤ `maxJobs` `sync_source_jobs` rows for the canary account only;
   one `scheduler-v2/brand-sales` snapshot; production `report_snapshots` untouched (§4).

**Stop conditions (abort + investigate):** any source job for a non-canary account; create-export count >
`maxJobs`; a write to a non-`scheduler-v2/*` snapshot; any `error_message` that is not a SAFE code; discovery
touching the primary API key for a `dd-secondary:` account.

## 6. Parity / reconciliation gates (before ANY control unlock)

For the canary report + account, compare the shadow snapshot to the current production snapshot **without a
re-fetch** (`compareShadowToProduction` in `report-snapshot-store.js`):

- [ ] `shadowPresent && productionPresent`.
- [ ] Structural `comparison` equal within the documented tolerance (row counts, brands, latest data date,
      currency handling). A mismatch **blocks** the unlock and is investigated as a derivation bug, never
      papered over.
- [ ] Re-run parity across ≥ 2 cycles to rule out a one-off; require stable equality.
- [ ] Daily/PPC only: confirm `ads_sync_coverage` proves the exact window before Ads are treated as covered
      (uncovered periods must read `unavailable`, never a fabricated zero).

## 7. Control unlock (per report, reviewed, reversible)

Only after §6 passes for a report: unlock it deliberately by adding its key to
`SCHEDULER_V2_READY_REPORT_KEYS` (a code change + review), then optionally set `schedule_enabled=true` in
`report_sync_settings` for the scheduled path. Unlock ONE report at a time; re-run the canary + parity per
report. **Approval gate per report.**

## 8. Rollback / stop conditions

- **Stop the whole rollout** on: a non-empty preflight `blockers`; any parity mismatch; any production snapshot
  change during a shadow run; any source job for an unexpected account; any create-export beyond budget; any
  non-SAFE error string surfacing in telemetry.
- **Rollback a control unlock**: remove the report key from `SCHEDULER_V2_READY_REPORT_KEYS` and set
  `schedule_enabled=false`; the dispatcher immediately stops selecting it. No data migration is needed.
- **Rollback the schedule**: the `pg_cron` kickoff is a separate un-applied migration; not applying it (or
  disabling the cron job) stops all scheduled invocations. Shadow snapshots remain namespaced and inert.
- **The migrations themselves are additive**; they can remain applied safely while every control is locked
  (shadow). A destructive teardown is out of scope and would be its own reviewed migration.

---

### Explicit approval checklist (sign off before each live step)

- [x] Gate 0 — preconditions verified (offline evidence in Appendix A, 2026-08-13).
- Gate 1a–1d — each migration applied (one at a time):
  - [x] **Gate 1a — `20260807_scheduler_v2.sql` applied 2026-08-13** (execution evidence in Appendix C; B.1 clear, B.4 V1–V11 all pass).
  - [x] **Gate 1b — `20260810_ads_sync_coverage.sql` applied 2026-08-13** (execution evidence in Appendix E; D.2 clear, W1–W11 all pass).
  - [x] **Gate 1c — `20260810_report_sync_controls.sql` applied 2026-08-13** (execution evidence in Appendix G; F.2 clear, X1–X11 all pass).
  - [x] **Gate 1d — `20260811_sync_source_job_owners.sql` applied 2026-08-13** (fresh path / Branch A; execution evidence in Appendix I; H.2 clear, Y1–Y12 all pass).
- [x] **Gate 2 — read-only re-verification of migrations 1–4 PASSED 2026-08-13** (execution evidence in Appendix K; J.1 G1–G12 all pass, J.2 offline preflight `ready:true`/`blockers:[]`).
- [x] **Gate 5 — one-account brand-sales SHADOW canary EXECUTED 2026-08-14 — SUCCESS** (execution evidence in
  Appendix L.8). Exactly ONE primary account, `brand-sales` only, exactly TWO create-exports (one Order Line
  Items, one Product Catalog `68d2de238e`), one `scheduler-v2/brand-sales` shadow snapshot; production Brand
  Sales fingerprint byte-identical; controls still locked/paused; no deploy/schedule.
- [x] **Migration-5 gate — `20260815_sync_cycle_finalize.sql` applied 2026-08-14** (single guarded transaction,
  advisory lock `(20260815,1)`, plain ledger insert; execution evidence in Appendix O; read-only inventory +
  post-verification all PASS; zero data rows changed).
- [x] **Appendix N reconciliation EXECUTED 2026-08-14 — the Gate-5 canary cycle is terminal.** One
  `finalize_sync_cycle` call, `disposition='finalized'`, `status='succeeded'`, `finished_at` set, counters
  `2/2/0` + `1/1/0`; source/report/owner/snapshot rows byte-unchanged (digest-proven); zero DataDoe calls
  (evidence in Appendix N.4). Blocker 1 is RESOLVED IN PRODUCTION.
- [x] **Gate 6 Shadow Parity CYCLE 1 — EXECUTED 2026-08-14 (all 13 reports, 2 buckets/accounts; evidence in
  Appendix P).** Both bucket cycles drained + finalized `partial` under the corrected lifecycle; budgets held
  (57≤59 / 56≤58 create-exports, ≤1 per hash); production fingerprints byte-identical; LKG preserved on every
  failure; 1 parity defect (brand-sales `asinBrand`) found + FIXED (`bb37a4e`); upstream findings recorded
  (30 DataDoe TIMEOUTs on the largest datasets; empty durable `ads_sync_coverage` blocks the PPC prerequisite).
- [x] **Gate-6 Ads coverage prerequisite — EXECUTED 2026-08-15 (Appendix S).** Four bounded one-source
  `requiredCoverage` invocations for exactly the two approved accounts over `[2026-07-16 .. 2026-08-14]`
  (30 inclusive days): campaign + ASIN (required) and targeting + search-terms (optional) ALL `completed` +
  `coverageComplete:true`, one create-export each (≤3 budget held), 8 exact-window `succeeded` coverage records,
  8 `succeeded` states with cadence timestamps unchanged, unrelated-account digests byte-identical. The empty
  `ads_sync_coverage` PPC blocker is RESOLVED — `evaluateSourceCoverage(..).proven === true` for campaign+ASIN
  on both accounts for asOf `2026-08-14`.
- [x] **Gate 6 Shadow Parity CYCLE 2 — EXECUTED 2026-08-15 (all 13 reports, 2 buckets; evidence in Appendix
  T).** non-us cycle **`succeeded` 133/133 sources, 13/13 reports** — the first fully-successful all-13 cycle;
  us cycle `partial` (84/135 sources; 4 succeeded / 9 SOURCE_BLOCKED reports — all remaining failures are
  DataDoe TIMEOUTs on the US account). PPC succeeded on non-us with all four Ads coverages validated; the
  corrected `brand-sales/v2d-2` payload (nonempty `asinBrand`) landed for BOTH accounts; sliced windows exact;
  budgets held (135≤135 / 133≤134, ≤1 create per hash); LKG + fingerprints byte-preserved; ZERO code defects
  found (remaining blockers are upstream DataDoe processing limits).
- [ ] Gate 6 completion — parity stability judgement across the two executed cycles + the DataDoe answer on
  US-account export processing limits. **BLOCKED** pending Codex review + explicit human approval.
- [ ] Gate 7 — per-report control unlock (repeat per report).
- [ ] Kickoff (`20260808_scheduler_v2_kickoff.sql`) — separate, later, fully-reviewed step (NOT in this phase).

---

## Appendix A — Gate 0 offline evidence (executed 2026-08-13, read-only)

Gate 0 is **offline/read-only preparation only**. No migration applied, no DataDoe call, no Supabase write, no
deploy, no schedule, no control unlock. Verified against `feature/scheduler-v2` @ `4163974` (Codex-approved
Phase 1f).

**Committed-state invariants (all confirmed):**
- HEAD includes `4163974` (`git merge-base --is-ancestor` = yes); working tree clean except untracked
  `.worktrees/` and `HANDOFF.md`.
- `SCHEDULER_V2_READY_REPORT_KEYS = Object.freeze([])` — **every** v2 report locked (empty fail-closed allowlist).
- Scheduler v1 unchanged: `git diff HEAD` is empty; v1 `reportControlCatalog` untouched.
- Primary-DataDoe-only: discovery skips a dormant `dd-secondary:` account read-only and **never** routes it
  through the primary key (`runtime-composition.js` `makeProductionDiscoverAccounts` / classify); no secondary
  API key is required (connections without an `apiKey` are skipped). No secondary→primary fallback exists.

**Offline verification (npm run verify stalled on the Windows npm process-spawn wrapper as documented; every
component run directly):**

| suite | result |
|---|---|
| `test:insights` | 54 |
| `test:brand-view` | 78 |
| `test:sync` | 23 |
| `test:source-cache` | 73 |
| `test:sync-engine` (7 files) | 79 (22+17+6+12+4+17+1) |
| `test:report-derivation` (15 files) | 502 |
| `test:source-identity` | 7 |
| `test:report-contracts` | 161 |
| `test:report-sync-controls` | 9 |
| **verify test total** | **986** |
| `build:check` | green (dashboard bundle intact, >500 kB chunk present) |
| `git diff --check` | clean |
| `node --check` (schema-contract.js, runtime-composition.js, report-controls.js, sync-runtime-composition.test.js, sync-dispatch.test.js) | all OK |

**Zero-side-effect static preflight** (`schedulerV2Preflight` over the real committed migrations + `supabase.js`,
with a global `fetch` trap and an allowlisted `readFile`/`getConnections`):
- static audit `ok:true`, `blockers:[]`, `requiredWrappers.ok:true` (28/28 exported, 0 missing);
- `pf.ready:true`, `pf.blockers:[]`; `checks.v2ControlsLocked = {ready:[], scheduled:[], ok:true}`;
- **network(fetch) calls: 0**; files read = exactly the 4 migrations + `supabase.js` (0 unexpected reads);
  `getConnections` called once (read-only, no network); **zero writes, zero DataDoe, zero discovery**.

**Frozen input SHA-256 (do not edit; re-verify before Gate 1):**

```
1328bc0fdbe430670d2ea1dc8bdf4b1a223feb04cd6eb5c0080ef26a1bdc691e  supabase/migrations/20260807_scheduler_v2.sql
0750a155a0c46a6e6ae3d24cea7835b8840f0e2c3a0d22670b595222d859b724  supabase/migrations/20260810_ads_sync_coverage.sql
544557fb29b1ae8e03e9c8d263d8b2fba73853853273f30c517cbc30938bea4c  supabase/migrations/20260810_report_sync_controls.sql
49628c8d701b3d1ca3b22b131bd8d8f8122585cd0461133f094a7a0154d98669  supabase/migrations/20260811_sync_source_job_owners.sql
534cad4767e980456a99a30180b20a4546f35ff69ca144c970a3f6c08f4fdb95  lib/server/sync/schema-contract.js
8d22e8133d25dc50158dae5ca13d77c30f3542a7f8084ce9794d34387943793c  lib/server/sync/runtime-composition.js
8ca6d7092665bda62593faf5b9c5677a822eee1b9c650be734bf2105be123ae7  lib/server/supabase.js
```

**Gate 0 conclusion:** all offline checks pass. Cleared to PREPARE Gate 1 (below). **Not** cleared to apply —
that requires explicit human approval.

---

## Appendix B — Gate 1a package: apply ONLY `20260807_scheduler_v2.sql` (PREPARED — NOT executed)

> **NOTHING in this appendix has been run.** It is the exact package a reviewer/operator executes **after
> written approval**, one migration only, then STOPS for Gate 2 verification before migrations 2–4.

**Do NOT use `npm run db:migrate` for Gate 1.** `scripts/apply-supabase-migrations.mjs` applies **every** pending
`.sql` file (migrations 1–4) in one run — that is Gate 1a–1d at once, which this gate forbids. Apply the single
file atomically instead. (The kickoff `20260808_scheduler_v2_kickoff.sql` is **not present** in
`supabase/migrations/`, so no schedule can be applied here regardless.)

### B.1 Pre-apply read-only inventory (run + REVIEW FIRST; STOP on any hit)

Run these read-only queries and review the output **before** the apply. Expected FIRST-APPLY state: **0** ledger
row for this migration; every target table/RPC/constraint/index/trigger/policy **absent**; every prerequisite
**present**. If any target object or the ledger row already exists — or any prerequisite is missing — **STOP; do
not apply**; capture the exact shape (use the B.3 definition queries) and report it for review.

```sql
-- P1) ledger state for THIS migration -- SAFE whether or not the ledger table exists yet. Step A checks
--     to_regclass FIRST; step B: if the table is absent, the recorded count is logically zero and the table is
--     NOT queried; step C: if present, query it (via dynamic EXECUTE, so a missing table can never raise a
--     "relation does not exist" parse error). Emits a typed NOTICE and STOPs (raises) only if THIS row exists.
do $$
declare
  v_ledger_exists boolean := to_regclass('public.app_schema_migrations') is not null;   -- A
  v_migration_recorded boolean := false;                                                -- B: absent => zero
begin
  if v_ledger_exists then                                                               -- C: present => query
    execute 'select exists (select 1 from public.app_schema_migrations where filename = $1)'
      into v_migration_recorded using '20260807_scheduler_v2.sql';
  end if;
  raise notice 'ledger_exists:% migration_recorded:%', v_ledger_exists, v_migration_recorded;
  if v_migration_recorded then
    raise exception 'STOP: 20260807_scheduler_v2.sql already recorded in app_schema_migrations (Gate 1a expects the FIRST apply)';
  end if;
end $$;
-- Expected NOTICE: "ledger_exists:false migration_recorded:false" (fresh DB), OR
--                  "ledger_exists:true  migration_recorded:false" (ledger already created by earlier migrations).
-- Any "migration_recorded:true" raises the STOP above -- do NOT apply.

-- P2) target tables already present? (expect all three NULL)
select to_regclass('public.sync_cycles')     as sync_cycles,
       to_regclass('public.sync_source_jobs') as sync_source_jobs,
       to_regclass('public.sync_report_jobs') as sync_report_jobs;

-- P3) the three EXACT RPC signatures already present? (expect all three NULL)
select to_regprocedure('public.open_sync_cycle(text, date, timestamptz, text)') as open_sync_cycle,
       to_regprocedure('public.claim_sync_cycle(uuid)')                          as claim_sync_cycle,
       to_regprocedure('public.claim_source_export_attempt(uuid, text)')         as claim_source_export_attempt;

-- P4) same-named constraints / indexes / triggers / policies already present? (expect 0 rows from EACH)
select conname from pg_constraint
 where conname in ('sync_cycles_bucket_date_unique','sync_source_jobs_cycle_hash_unique',
                   'sync_source_jobs_one_attempt','sync_report_jobs_cycle_report_account_unique');
select indexname from pg_indexes where schemaname='public'
 and indexname in ('sync_cycles_bucket_date_idx','sync_source_jobs_cycle_idx','sync_source_jobs_pending_idx',
                   'sync_source_jobs_source_idx','sync_report_jobs_cycle_idx','sync_report_jobs_report_idx');
select tgname from pg_trigger
 where not tgisinternal and tgname in ('sync_cycles_touch','sync_source_jobs_touch','sync_report_jobs_touch');
select polname from pg_policy
 where polname in ('admins read sync cycles','admins read sync source jobs','admins read sync report jobs');

-- P5) required PREREQUISITES must ALREADY exist (from earlier migrations); STOP if any is missing
select to_regclass('auth.users')                      as auth_users,          -- 20260729_dashboard_auth_and_access
       to_regprocedure('public.touch_updated_at()')   as touch_updated_at,     -- 20260728_shared_dashboard
       to_regprocedure('public.is_dashboard_admin()') as is_dashboard_admin;   -- 20260729_dashboard_auth_and_access
select rolname from pg_roles where rolname = 'service_role';                   -- expect exactly 1 row
```

A read-only **Node/pg** equivalent of P1 (checks `to_regclass` first, queries the table only when present):

```bash
node --input-type=module -e '
import pg from "pg";
const FILE = "20260807_scheduler_v2.sql";
const url = new URL(process.env.POSTGRES_URL); url.searchParams.set("sslmode", "no-verify");
const c = new pg.Client({ connectionString: url.toString() }); await c.connect();
try {
  const reg = await c.query("select to_regclass($1) as t", ["public.app_schema_migrations"]);
  const ledgerExists = reg.rows[0].t !== null;
  let migrationRecorded = false;
  if (ledgerExists) migrationRecorded = (await c.query("select 1 from public.app_schema_migrations where filename=$1", [FILE])).rowCount > 0;
  console.log("ledger_exists:" + ledgerExists + " migration_recorded:" + migrationRecorded);
  if (migrationRecorded) console.log("STOP: this migration is already recorded -- do NOT apply");
} finally { await c.end(); }
'
```

> The `app_schema_migrations` ledger table may **legitimately already exist** — it is created by the first-ever
> run of the migration runner, so any earlier migration will have created it. `ledger_exists:true` is therefore
> fine; only **this** migration's row must be absent. Judge P1 solely by `migration_recorded`.

**STOP (do not apply) if:** P1 reports `migration_recorded:true`; P2/P3 return any non-NULL; P4 returns any row;
or P5 shows any NULL / the `service_role` row missing. Report the exact shape for review rather than applying over
it.

### B.2 Hardened apply command (single migration, single transaction, advisory-locked, ledger fail-closed)

Applies **only** `20260807_scheduler_v2.sql`, in one transaction, taking a transaction-scoped advisory lock
**before** touching the ledger, failing closed if the migration is already recorded, inserting the ledger row
with a **plain** insert (no `ON CONFLICT` — a repeat must surface, not hide), and rolling back on any error. Uses
the same connection as `apply-supabase-migrations.mjs` (`POSTGRES_URL` + `sslmode=no-verify` for the Vercel
pooler cert on Windows).

```bash
node --input-type=module -e '
import pg from "pg"; import { readFileSync } from "node:fs";
const FILE = "20260807_scheduler_v2.sql";
const url = new URL(process.env.POSTGRES_URL); url.searchParams.set("sslmode", "no-verify");
const c = new pg.Client({ connectionString: url.toString() }); await c.connect();
try {
  await c.query("begin");
  // 1) transaction-scoped advisory lock BEFORE any ledger check/create (auto-released on commit/rollback);
  //    serializes any concurrent/repeated apply of THIS migration.
  await c.query("select pg_advisory_xact_lock($1::int, $2::int)", [20260807, 1]);
  await c.query("create table if not exists public.app_schema_migrations (filename text primary key, applied_at timestamptz not null default now())");
  // 2) fail closed if already recorded (do NOT hide a repeat).
  const seen = await c.query("select applied_at from public.app_schema_migrations where filename=$1", [FILE]);
  if (seen.rowCount) throw new Error("REFUSING: " + FILE + " already applied at " + seen.rows[0].applied_at + " (Gate 1a expects the FIRST apply)");
  // 3) apply migration 1 (its whole body runs inside this one transaction).
  await c.query(readFileSync("sales-dashboard-live/supabase/migrations/" + FILE, "utf8"));
  // 4) record the ledger row with a PLAIN insert (a duplicate raises a PK error -> rollback, surfacing a repeat).
  await c.query("insert into public.app_schema_migrations (filename) values ($1)", [FILE]);
  await c.query("commit"); console.log("applied " + FILE);
} catch (e) { await c.query("rollback"); throw e; } finally { await c.end(); }
'
```

### B.3 What migration 1 changes (accurate characterization)

- **Deletes nothing:** no `DROP TABLE`, no `TRUNCATE`, no change to any existing table or historical Ads/report
  data. The only `DROP`s are `drop trigger if exists` / `drop policy if exists` for THIS migration's own three
  triggers and three policies, each immediately re-created (see the transactional note below).
- **Creates** the three scheduler tables (`sync_cycles`, `sync_source_jobs`, `sync_report_jobs`) and their six
  indexes (`create table` / `create index if not exists`).
- **`CREATE OR REPLACE`** for the three RPCs (`open_sync_cycle`, `claim_sync_cycle`,
  `claim_source_export_attempt`).
- **Transactionally DROP + CREATE** the three named triggers (`sync_cycles_touch`, `sync_source_jobs_touch`,
  `sync_report_jobs_touch`) and the three named policies (`admins read sync cycles` / `... source jobs` /
  `... report jobs`): each is `drop ... if exists` then `create ...`. Because the whole migration runs in ONE
  transaction, no concurrent reader ever observes a window with the trigger/policy missing.
- **Enables RLS** on the three tables. For each of the three RPCs it **revokes EXECUTE from `PUBLIC`, `anon`
  and `authenticated`** and then **explicitly grants EXECUTE to `service_role`**; the function **owner retains
  its owner privilege** (owners may always execute their own functions). Net: only the owner and `service_role`
  can execute — checked by V8a/V8b.
- **Creates NO schedule** (no `pg_cron` / `pg_net`) and performs **NO DataDoe call** (verified by inspecting the
  frozen file: the only `pg_cron` tokens are comments and the `trigger` text-enum column value).
- **Prerequisites** (from earlier migrations): `public.touch_updated_at()`, `public.is_dashboard_admin()`,
  `auth.users`, and the `service_role` role. If any is absent the apply errors and the whole transaction rolls
  back (fail closed) — B.1 checks these before applying.

### B.4 Post-apply STRUCTURAL verification (read-only, table-scoped; every mismatch is a STOP)

Run after the apply; compare each result against the expected shape. **Any deviation STOPs the rollout.**

```sql
-- V1) exact columns / types / nullability / defaults (compare per table against the migration text).
--     expect: sync_cycles 18 cols, sync_source_jobs 27 cols, sync_report_jobs 25 cols.
select table_name, ordinal_position, column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema='public' and table_name in ('sync_cycles','sync_source_jobs','sync_report_jobs')
 order by table_name, ordinal_position;

-- V2) exact NAMED constraints, scoped to the three tables, via pg_get_constraintdef
select rel.relname as table_name, con.conname, con.contype, pg_get_constraintdef(con.oid) as definition
  from pg_constraint con
  join pg_class rel on rel.oid=con.conrelid
  join pg_namespace n on n.oid=rel.relnamespace
 where n.nspname='public' and rel.relname in ('sync_cycles','sync_source_jobs','sync_report_jobs')
 order by rel.relname, con.conname;
-- expect (among the PK + inline CHECKs):
--   sync_cycles_bucket_date_unique                UNIQUE (bucket, cycle_date)
--   sync_source_jobs_cycle_hash_unique            UNIQUE (cycle_id, request_hash)
--   sync_source_jobs_one_attempt                  CHECK (((create_export_count = 0 AND attempted_at IS NULL)
--                                                    OR (create_export_count = 1 AND attempted_at IS NOT NULL)))
--   sync_report_jobs_cycle_report_account_unique  UNIQUE (cycle_id, report_key, account_id)
--   FK sync_source_jobs.cycle_id -> sync_cycles(id) ON DELETE CASCADE
--   FK sync_report_jobs.cycle_id -> sync_cycles(id) ON DELETE CASCADE
--   FK sync_cycles.created_by    -> auth.users(id)  ON DELETE SET NULL

-- V3) exactly the SIX explicit indexes + target table + definition (expect 6 rows)
select tablename, indexname, indexdef from pg_indexes
 where schemaname='public'
   and indexname in ('sync_cycles_bucket_date_idx','sync_source_jobs_cycle_idx','sync_source_jobs_pending_idx',
                     'sync_source_jobs_source_idx','sync_report_jobs_cycle_idx','sync_report_jobs_report_idx')
 order by indexname;
-- expect: sync_cycles(bucket, cycle_date DESC); sync_source_jobs(cycle_id, fetch_status);
--   sync_source_jobs(cycle_id) WHERE fetch_status='pending'; sync_source_jobs(source_id, created_at DESC);
--   sync_report_jobs(cycle_id, derive_status, save_status); sync_report_jobs(report_key, account_id, created_at DESC).

-- V4) exactly three touch triggers: BEFORE UPDATE, enabled, calling public.touch_updated_at() (expect 3 rows)
select rel.relname as table_name, t.tgname, t.tgenabled as enabled, pg_get_triggerdef(t.oid) as definition
  from pg_trigger t
  join pg_class rel on rel.oid=t.tgrelid
  join pg_namespace n on n.oid=rel.relnamespace
 where n.nspname='public' and not t.tgisinternal
   and rel.relname in ('sync_cycles','sync_source_jobs','sync_report_jobs')
 order by rel.relname;
-- expect: tgname sync_*_touch; enabled='O'; definition "... BEFORE UPDATE ON public.<table> FOR EACH ROW
--         EXECUTE FUNCTION touch_updated_at()".

-- V5) exactly three admin SELECT policies to `authenticated`, qualifier is_dashboard_admin() (expect 3 rows)
select rel.relname as table_name, pol.polname, pol.polcmd as cmd,
       array(select rolname from pg_roles where oid = any(pol.polroles)) as roles,
       pg_get_expr(pol.polqual, pol.polrelid) as using_qual
  from pg_policy pol
  join pg_class rel on rel.oid=pol.polrelid
  join pg_namespace n on n.oid=rel.relnamespace
 where n.nspname='public' and rel.relname in ('sync_cycles','sync_source_jobs','sync_report_jobs')
 order by rel.relname;
-- expect: polcmd='r' (SELECT); roles={authenticated}; using_qual = "is_dashboard_admin()".

-- V6) RLS enabled on all three tables (expect relrowsecurity=true for all three)
select relname, relrowsecurity from pg_class
 where relnamespace='public'::regnamespace
   and relname in ('sync_cycles','sync_source_jobs','sync_report_jobs')
 order by relname;

-- V7) exact RPC identity args/order, return type, SECURITY DEFINER, and search_path=public (expect 3 rows)
select p.proname,
       pg_get_function_identity_arguments(p.oid) as identity_args,
       pg_get_function_result(p.oid)             as returns,
       p.prosecdef                               as security_definer,
       p.proconfig                               as config
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in ('open_sync_cycle','claim_sync_cycle','claim_source_export_attempt')
 order by p.proname;
-- expect:
--   claim_source_export_attempt  "p_cycle_id uuid, p_request_hash text"                       boolean  t  {search_path=public}
--   claim_sync_cycle             "p_cycle_id uuid"                                             boolean  t  {search_path=public}
--   open_sync_cycle              "p_bucket text, p_cycle_date date, p_scheduled_at timestamp
--                                 with time zone, p_trigger text"                              uuid     t  {search_path=public}

-- V8a) FORBIDDEN execute grantees must be ABSENT (expect 0 rows)
select p.proname, (case when a.grantee=0 then 'PUBLIC' else r.rolname end) as bad_grantee
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  cross join lateral aclexplode(p.proacl) a
  left join pg_roles r on r.oid=a.grantee
 where n.nspname='public' and p.proname in ('open_sync_cycle','claim_sync_cycle','claim_source_export_attempt')
   and a.privilege_type='EXECUTE' and (a.grantee=0 or r.rolname in ('anon','authenticated'));

-- V8b) service_role MUST have EXECUTE on all three (expect 3 rows); the function owner may also execute.
select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee
 where n.nspname='public' and p.proname in ('open_sync_cycle','claim_sync_cycle','claim_source_export_attempt')
   and a.privilege_type='EXECUTE' and r.rolname='service_role';

-- V9) nothing has run yet (expect 0)
select count(*) as cycle_rows from public.sync_cycles;

-- V10) ledger recorded EXACTLY this one migration in this gate (expect exactly 1 row)
select filename, applied_at from public.app_schema_migrations where filename='20260807_scheduler_v2.sql';

-- V11) NO Scheduler-v2 cron entry (pg_cron optional; expect 0 rows, or a benign "relation cron.job does not
--      exist" if pg_cron is not installed — migration 1 creates no cron entry either way)
select jobid, jobname, schedule, command from cron.job where command ilike '%sync%' or jobname ilike '%sync%';
```

Then re-run `schedulerV2Preflight(...)` (still offline/read-only against the committed source) — it must stay
`ready:true`, `blockers:[]`, controls locked.

### B.5 Stop / rollback conditions (Gate 1a)

- The apply is a single advisory-locked transaction with abort-on-error, so any failure leaves the DB
  **unchanged** (no partial apply). STOP and investigate on any error (e.g. a missing prerequisite, or the
  ledger already containing this migration) — do not retry blindly.
- **STOP on any structural mismatch:** a column set / type / nullability / default that differs from the
  migration, or V1 counts ≠ 18 / 27 / 25; any named-constraint definition differing (V2 — especially the
  `sync_source_jobs_one_attempt` CHECK body or an FK target / `ON DELETE` action); ≠ 6 indexes or any differing
  index definition (V3); ≠ 3 triggers, not `BEFORE UPDATE`, disabled, or not calling `touch_updated_at()` (V4);
  ≠ 3 policies, not SELECT, wrong role, or missing the `is_dashboard_admin()` qualifier (V5); any
  `relrowsecurity=false` (V6); any RPC identity-args / return-type / `security_definer` / `search_path=public`
  mismatch (V7); **any** row from V8a (PUBLIC / anon / authenticated holds EXECUTE) or fewer than 3 rows from
  V8b (service_role missing EXECUTE); `cycle_rows > 0` (V9); ≠ exactly 1 ledger row (V10); or any `cron.job` row
  matching sync (V11).
- Non-destructive rollback: migration 1 is additive and idempotent-on-replay; while every v2 control stays
  locked (shadow), leaving it applied is safe and inert. **No destructive teardown (DROP TABLE) is prepared** —
  a teardown would be its own separately reviewed migration and is out of scope.
- Do **NOT** proceed to migrations 2–4, the canary, any control unlock, or the kickoff. Stop for Gate 2 review +
  explicit human approval.

---

## Appendix C — Gate 1a EXECUTION evidence (applied 2026-08-13)

Executed with explicit human approval, from `feature/scheduler-v2` @ `2b6a27e`, following Appendix B exactly.
Connected to production Supabase over the configured `POSTGRES_URL` (`sslmode=no-verify`) loaded from untracked
`.env.local` and never printed (the connection string is NOT committed to the repository). **Exactly one
migration applied: `20260807_scheduler_v2.sql`.**

**Preflight:** HEAD includes `2b6a27e`; migration-1 SHA-256 = `1328bc0f…1bdc691e` (matches the frozen hash);
`SCHEDULER_V2_READY_REPORT_KEYS` length 0 (every v2 report still locked).

**B.1 live read-only inventory (in a read-only transaction) — CLEAR TO APPLY:**
- P1 `ledger_exists:true migration_recorded:false` (the ledger table pre-existed from earlier migrations; this
  migration's row was absent — the documented legitimate case).
- P2 `sync_cycles / sync_source_jobs / sync_report_jobs` all NULL (absent).
- P3 all three RPC signatures NULL (absent).
- P4 same-named constraints/indexes/triggers/policies: 0 / 0 / 0 / 0.
- P5 prerequisites present: `auth.users`, `public.touch_updated_at()`, `public.is_dashboard_admin()`,
  `service_role`.

**Apply (B.2 hardened command):** single transaction, `pg_advisory_xact_lock(20260807, 1)` taken before the
ledger check, `create table if not exists app_schema_migrations`, fail-closed check (not previously recorded),
migration body applied, **plain** ledger insert, commit → `APPLIED 20260807_scheduler_v2.sql`. No retry needed.

**B.4 post-apply structural verification (read-only) — all V1–V11 PASS:**
- V1 exact columns present: `sync_cycles` 18, `sync_source_jobs` 27, `sync_report_jobs` 25; key defaults
  (`connection_id` `'primary'`, `create_export_count` `0`) and `cycle_id NOT NULL` confirmed.
- V2 named constraints (via `pg_get_constraintdef`): `sync_cycles_bucket_date_unique` = `UNIQUE (bucket,
  cycle_date)`; `sync_source_jobs_cycle_hash_unique` = `UNIQUE (cycle_id, request_hash)`;
  `sync_report_jobs_cycle_report_account_unique` = `UNIQUE (cycle_id, report_key, account_id)`;
  `sync_source_jobs_one_attempt` CHECK = `(((create_export_count = 0) AND (attempted_at IS NULL)) OR
  ((create_export_count = 1) AND (attempted_at IS NOT NULL)))`; FKs `sync_source_jobs.cycle_id` and
  `sync_report_jobs.cycle_id` → `sync_cycles(id) ON DELETE CASCADE`, `sync_cycles.created_by` →
  `auth.users(id) ON DELETE SET NULL`.
- V3 exactly the six indexes with the expected definitions (incl. the partial `WHERE fetch_status='pending'`).
- V4 three `sync_*_touch` triggers: enabled (`O`), `BEFORE UPDATE`, `EXECUTE FUNCTION touch_updated_at()`.
- V5 three admin policies: `SELECT`, to `authenticated` only (single role), `USING is_dashboard_admin()`, no
  WITH CHECK. (The first V5 pass tripped a node-pg `name[]`→string parsing quirk in the checker, not a schema
  issue; a corrected read-only re-check confirmed all three exactly.)
- V6 RLS enabled on all three tables.
- V7 RPC identities exact: `open_sync_cycle(p_bucket text, p_cycle_date date, p_scheduled_at timestamp with time
  zone, p_trigger text) → uuid`; `claim_sync_cycle(p_cycle_id uuid) → boolean`;
  `claim_source_export_attempt(p_cycle_id uuid, p_request_hash text) → boolean`; all `SECURITY DEFINER`,
  `search_path=public`.
- V8a no `PUBLIC`/`anon`/`authenticated` EXECUTE on any RPC; V8b `service_role` has EXECUTE on all three.
- V9 `sync_cycles` row count = 0. V10 exactly one ledger row for `20260807_scheduler_v2.sql`. V11 `cron.job` is
  absent (`pg_cron` not installed) → no schedule.

**Post-apply invariants:** `SCHEDULER_V2_READY_REPORT_KEYS` still empty; the four migration files remain
byte-unchanged (all seven Gate 0 hashes intact); no code changed; no DataDoe call/export; no schedule; no
deployment/push/merge. Scheduler v1 / frontend / routes / cron untouched.

**STOP.** Gates 1b–1d (migrations 2–4), the canary, and any control unlock remain **unapproved** — stop for
Codex review and separate approval before Gate 1b.

---

## Appendix D — Gate 1b package: apply ONLY `20260810_ads_sync_coverage.sql` (PREPARED — NOT executed)

> **NOTHING in this appendix has been run.** It is the exact package a reviewer/operator executes **after
> written approval**, one migration only, then STOPS for verification before Gate 1c. Gate 1a (migration 1) is
> already applied and verified (Appendix C).

Frozen input: `20260810_ads_sync_coverage.sql` SHA-256 `0750a155…d859b724` (Gate 0). **Do NOT use `npm run
db:migrate`** — it applies every pending file (migrations 2–4) at once.

### D.1 What migration 2 changes (accurate characterization)

- **Deletes nothing** (no `DROP`, no `TRUNCATE`, no change to any existing table or historical data).
- **Creates one table** `public.ads_sync_coverage` (8 columns; a composite `PRIMARY KEY`; a `status` CHECK),
  one index `ads_sync_coverage_lookup_idx`, and one trigger `ads_sync_coverage_touch_updated_at`
  (`BEFORE UPDATE` → `touch_updated_at()`).
- **Enables RLS** on the table and creates **NO policy**. Access model: no browser role (`anon`/`authenticated`)
  has a policy, so browsers **cannot read or write** rows; the `service_role` key **bypasses RLS** (the scheduler
  writes, the Daily loader reads). This is enforced by RLS-enabled + no-policy + service-role-bypass — **not** by
  a table GRANT/ACL; **no table-level ACL exclusivity is asserted** (not verified).
- Creates **NO RPC**, **NO schedule** (no `pg_cron`/`pg_net`), performs **NO DataDoe call**.
- **Replay note:** unlike migration 1, migration 2's `create trigger` has **no** `drop trigger if exists`, so the
  **raw SQL is NOT independently replay-idempotent** — re-running it raises "trigger already exists". This is
  safe for the FIRST transactional apply, but the ledger + advisory-locked apply (D.3) **MUST refuse a repeat**
  (it fails closed on the migration-2 ledger row), which is what prevents a second execution.
- **Prerequisites:** `public.touch_updated_at()` (from `20260728_shared_dashboard.sql`) and the `service_role`
  role; **Migration 1 must already be applied** (its ledger row present exactly once).

### D.2 Pre-apply read-only inventory (run + REVIEW FIRST; STOP on any hit)

Expected FIRST-APPLY state: ledger exists; **Migration 1 row present exactly once**; **Migration 2 row absent**;
`ads_sync_coverage` + its index + its trigger **absent**; prerequisites present; Migration 1 objects still
present (do not modify). Any pre-existing Migration-2 object, or a Migration-2 ledger row, is a **STOP**.

```sql
-- Q1) ledger state -- SAFE whether or not the ledger table exists. Migration 1 must be recorded EXACTLY once and
--     Migration 2 must be absent. Emits a typed NOTICE; STOPs (raises) on a violation.
do $$
declare
  v_ledger_exists boolean := to_regclass('public.app_schema_migrations') is not null;
  v_m1 int := 0; v_m2 int := 0;
begin
  if v_ledger_exists then
    execute 'select count(*) from public.app_schema_migrations where filename=$1' into v_m1 using '20260807_scheduler_v2.sql';
    execute 'select count(*) from public.app_schema_migrations where filename=$1' into v_m2 using '20260810_ads_sync_coverage.sql';
  end if;
  raise notice 'ledger_exists:% migration1_rows:% migration2_rows:%', v_ledger_exists, v_m1, v_m2;
  if not v_ledger_exists then raise exception 'STOP: ledger table absent (Migration 1 must already be applied)'; end if;
  if v_m1 <> 1 then raise exception 'STOP: expected exactly 1 Migration-1 ledger row, found %', v_m1; end if;
  if v_m2 <> 0 then raise exception 'STOP: Migration 2 already recorded (% row(s)) -- do NOT re-apply', v_m2; end if;
end $$;
-- Expected NOTICE: "ledger_exists:true migration1_rows:1 migration2_rows:0".

-- Q2) Migration 2 target objects must be ABSENT
select to_regclass('public.ads_sync_coverage')            as ads_sync_coverage_table,  -- expect NULL
       to_regclass('public.ads_sync_coverage_lookup_idx') as lookup_idx;               -- expect NULL
select tgname from pg_trigger where not tgisinternal and tgname='ads_sync_coverage_touch_updated_at';  -- expect 0 rows
select pol.polname from pg_policy pol join pg_class rel on rel.oid=pol.polrelid        -- expect 0 rows
 where rel.relname='ads_sync_coverage';

-- Q3) prerequisites must be present
select to_regprocedure('public.touch_updated_at()') as touch_updated_at;               -- expect non-NULL
select rolname from pg_roles where rolname='service_role';                             -- expect exactly 1 row

-- Q4) Migration 1 objects must remain present (do NOT modify)
select to_regclass('public.sync_cycles') a, to_regclass('public.sync_source_jobs') b, to_regclass('public.sync_report_jobs') c,
       to_regprocedure('public.open_sync_cycle(text, date, timestamptz, text)') d,
       to_regprocedure('public.claim_sync_cycle(uuid)') e,
       to_regprocedure('public.claim_source_export_attempt(uuid, text)') f;            -- expect all non-NULL
```

**STOP (do not apply) if:** Q1 raises (ledger absent / Migration 1 ≠ 1 / Migration 2 already recorded); Q2
returns any non-NULL or any row (a Migration-2 object already exists); Q3 shows a missing prerequisite; or Q4
shows any Migration-1 object absent. Report the exact shape for review rather than applying over it.

### D.3 Hardened apply command (single migration, single transaction, advisory-locked, ledger fail-closed)

Advisory key for Gate 1b = `(20260810, 1)` — **distinct** from Gate 1a's `(20260807, 1)`. (Gate 1c
`20260810_report_sync_controls.sql` shares the `20260810` date and MUST use a different key, e.g. `(20260810,
2)`; Gate 1d → `(20260811, 1)`.) Run from `sales-dashboard-live/`; `POSTGRES_URL` is loaded from `.env.local`
and never printed (as in Gate 1a).

```bash
node --input-type=module -e '
import pg from "pg"; import { readFileSync } from "node:fs";
const FILE = "20260810_ads_sync_coverage.sql";
const url = new URL(process.env.POSTGRES_URL); url.searchParams.set("sslmode", "no-verify");
const c = new pg.Client({ connectionString: url.toString() }); await c.connect();
try {
  await c.query("begin");
  // 1) transaction-scoped advisory lock (migration-2-specific key), BEFORE any ledger read.
  await c.query("select pg_advisory_xact_lock($1::int, $2::int)", [20260810, 1]);
  await c.query("create table if not exists public.app_schema_migrations (filename text primary key, applied_at timestamptz not null default now())");
  // 2) require Migration 1 applied EXACTLY once.
  const m1 = await c.query("select count(*)::int as n from public.app_schema_migrations where filename=$1", ["20260807_scheduler_v2.sql"]);
  if (m1.rows[0].n !== 1) throw new Error("REFUSING: expected exactly 1 Migration-1 ledger row, found " + m1.rows[0].n);
  // 3) fail closed if Migration 2 already recorded (do NOT hide a repeat -- migration 2 is not replay-safe).
  const seen = await c.query("select applied_at from public.app_schema_migrations where filename=$1", [FILE]);
  if (seen.rowCount) throw new Error("REFUSING: " + FILE + " already applied at " + seen.rows[0].applied_at);
  // 4) apply migration 2 (its whole body runs inside this one transaction).
  await c.query(readFileSync("supabase/migrations/" + FILE, "utf8"));
  // 5) record the ledger row with a PLAIN insert (a duplicate raises -> rollback, surfacing a repeat).
  await c.query("insert into public.app_schema_migrations (filename) values ($1)", [FILE]);
  await c.query("commit"); console.log("applied " + FILE);
} catch (e) { await c.query("rollback"); throw e; } finally { await c.end(); }
'
```

### D.4 Post-apply STRUCTURAL verification (read-only, table-scoped; every mismatch is a STOP)

```sql
-- W1) table exists + EXACTLY 8 columns in this order/type/nullability/default
select ordinal_position, column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema='public' and table_name='ads_sync_coverage'
 order by ordinal_position;
-- expect exactly 8 rows:
--  1 account_id          text                       NO   (null)
--  2 source_key          text                       NO   (null)
--  3 covered_from        date                       NO   (null)
--  4 covered_to          date                       NO   (null)
--  5 status              text                       NO   'succeeded'::text
--  6 source_refreshed_at timestamp with time zone   NO   now()
--  7 created_at          timestamp with time zone   NO   now()
--  8 updated_at          timestamp with time zone   NO   now()

-- W2) PRIMARY KEY exactly (account_id, source_key, covered_from, covered_to)
select con.conname, pg_get_constraintdef(con.oid) as definition
  from pg_constraint con join pg_class rel on rel.oid=con.conrelid
 where rel.relname='ads_sync_coverage' and con.contype='p';
-- expect: PRIMARY KEY (account_id, source_key, covered_from, covered_to)

-- W3) the status CHECK permits EXACTLY 'succeeded' (single allowed value)
select con.conname, pg_get_constraintdef(con.oid) as definition
  from pg_constraint con join pg_class rel on rel.oid=con.conrelid
 where rel.relname='ads_sync_coverage' and con.contype='c';
-- expect one CHECK equivalent to: (status = 'succeeded'::text)  -- i.e. only 'succeeded' is permitted

-- W4) indexes: the PK unique index + ads_sync_coverage_lookup_idx (account_id, source_key, covered_from)
select indexname, indexdef from pg_indexes
 where schemaname='public' and tablename='ads_sync_coverage' order by indexname;
-- expect ads_sync_coverage_lookup_idx = btree (account_id, source_key, covered_from)

-- W5) trigger enabled, BEFORE UPDATE, calls touch_updated_at()
select tg.tgname, tg.tgenabled, pg_get_triggerdef(tg.oid) as definition
  from pg_trigger tg join pg_class rel on rel.oid=tg.tgrelid
 where rel.relname='ads_sync_coverage' and not tg.tgisinternal;
-- expect 1 row: tgenabled='O'; "... BEFORE UPDATE ON public.ads_sync_coverage FOR EACH ROW EXECUTE FUNCTION touch_updated_at()"

-- W6) RLS enabled + ZERO policies
select relrowsecurity from pg_class where relnamespace='public'::regnamespace and relname='ads_sync_coverage';  -- expect true
select count(*) as policy_count from pg_policy pol join pg_class rel on rel.oid=pol.polrelid
 where rel.relname='ads_sync_coverage';  -- expect 0

-- W7) zero rows immediately after the migration
select count(*) as rows from public.ads_sync_coverage;  -- expect 0

-- W8) ledger: Migration 1 AND Migration 2 each EXACTLY one row
select filename, count(*) as n from public.app_schema_migrations
 where filename in ('20260807_scheduler_v2.sql','20260810_ads_sync_coverage.sql')
 group by filename order by filename;  -- expect 2 rows, each n=1

-- W9) NO new RPC introduced by migration 2 (it declares none)
select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and proname ilike '%ads_sync_coverage%';  -- expect 0 rows

-- W10) no cron/schedule (guard cron.job with to_regclass first)
select to_regclass('cron.job') as cron_job;  -- if NULL: pg_cron absent -> no schedule; if present, run the next line
-- select jobid, jobname, schedule from cron.job where command ilike '%ads_sync_coverage%' or jobname ilike '%sync%';  -- expect 0

-- W11) Migration 1 objects UNCHANGED / still present (do NOT modify)
select to_regclass('public.sync_cycles') a, to_regclass('public.sync_source_jobs') b, to_regclass('public.sync_report_jobs') c,
       to_regprocedure('public.open_sync_cycle(text, date, timestamptz, text)') d,
       to_regprocedure('public.claim_sync_cycle(uuid)') e,
       to_regprocedure('public.claim_source_export_attempt(uuid, text)') f;  -- expect all non-NULL
```

**Access model (accurate):** `ads_sync_coverage` has **RLS enabled and zero policies**, so no browser role
(`anon`/`authenticated`) can read or write its rows; the `service_role` key **bypasses RLS** (scheduler writes,
Daily loader reads). This is enforced by RLS + absence of policy, **not** by a table GRANT/ACL — table-level ACL
exclusivity is **not** asserted here.

### D.5 Stop / rollback conditions (Gate 1b)

- The apply is a single advisory-locked transaction with abort-on-error, so any failure leaves the DB
  **unchanged** (no partial apply). STOP on any error (missing prerequisite, Migration 1 not recorded exactly
  once, or Migration 2 already recorded) — do not retry.
- **STOP on any structural mismatch:** ≠ 8 columns or any differing column order/type/nullability/default (W1);
  PK not exactly `(account_id, source_key, covered_from, covered_to)` (W2); the `status` CHECK permitting
  anything other than exactly `'succeeded'` (W3); a missing / renamed / mis-defined `ads_sync_coverage_lookup_idx`
  (W4); the trigger absent, disabled, not `BEFORE UPDATE`, or not calling `touch_updated_at()` (W5); RLS not
  enabled or **any** policy present (W6); rows > 0 (W7); either ledger filename ≠ exactly one row (W8); any
  unexpected new RPC (W9); any `cron.job` entry (W10); or any Migration-1 object missing (W11).
- Non-destructive: migration 2 is additive; while every v2 control stays locked (shadow), leaving it applied is
  safe and inert. **No destructive teardown (DROP) is prepared.** Because migration 2's raw SQL is **not
  replay-idempotent** (`CREATE TRIGGER` without `DROP TRIGGER IF EXISTS`), the ledger/advisory-locked apply is
  the ONLY sanctioned path and it refuses a repeat — never re-run the raw SQL directly.
- Do **NOT** proceed to Gate 1c (`20260810_report_sync_controls.sql`), migration 4, the canary, any control
  unlock, or the kickoff. Stop for review + explicit human approval.

---

## Appendix E — Gate 1b EXECUTION evidence (applied 2026-08-13)

Executed with explicit human approval, from `feature/scheduler-v2` @ `63c7e51`, following Appendix D exactly.
Connected to production Supabase over the configured `POSTGRES_URL` (`sslmode=no-verify`) loaded from untracked
`.env.local` and never printed (the connection string is NOT committed to the repository). **Exactly one migration applied in this gate: `20260810_ads_sync_coverage.sql`.**

**Preflight:** HEAD includes `63c7e51`; migration-2 SHA-256 = `0750a155…d859b724` (matches the frozen hash);
`SCHEDULER_V2_READY_REPORT_KEYS` length 0 (every v2 report still locked).

**D.2 live read-only inventory (read-only transaction) — CLEAR TO APPLY:**
- Q1 `ledger_exists:true migration1_rows:1 migration2_rows:0`.
- Q2 `ads_sync_coverage` table NULL, `ads_sync_coverage_lookup_idx` NULL, trigger 0 rows, policies 0 rows (all
  absent).
- Q3 prerequisites present: `public.touch_updated_at()`, `service_role`.
- Q4 Migration 1 objects present: `sync_cycles`, `sync_source_jobs`, `sync_report_jobs`, `open_sync_cycle`,
  `claim_sync_cycle`, `claim_source_export_attempt`.

**Apply (D.3 hardened command):** single transaction, `pg_advisory_xact_lock(20260810, 1)` (distinct from Gate
1a) before the ledger read, `create table if not exists app_schema_migrations`, required Migration 1 recorded
exactly once, fail-closed check (Migration 2 not previously recorded), migration body applied, **plain** ledger
insert, commit → `APPLIED 20260810_ads_sync_coverage.sql`. No retry.

**W1–W11 post-apply structural verification (read-only, scoped to `public.ads_sync_coverage`) — all PASS:**
- W1 exactly 8 columns in order: `account_id text NOT NULL`, `source_key text NOT NULL`, `covered_from date NOT
  NULL`, `covered_to date NOT NULL`, `status text NOT NULL default 'succeeded'::text`, `source_refreshed_at
  timestamptz NOT NULL default now()`, `created_at timestamptz NOT NULL default now()`, `updated_at timestamptz
  NOT NULL default now()`.
- W2 `PRIMARY KEY (account_id, source_key, covered_from, covered_to)`.
- W3 status CHECK = `((status = 'succeeded'::text))` — permits exactly `'succeeded'`.
- W4 `ads_sync_coverage_lookup_idx` = `btree (account_id, source_key, covered_from)` (plus the PK unique index
  `ads_sync_coverage_pkey`).
- W5 trigger `ads_sync_coverage_touch_updated_at`: enabled (`O`), `BEFORE UPDATE`, `EXECUTE FUNCTION
  touch_updated_at()`.
- W6 RLS enabled = true; **zero policies** on the table.
- W7 `ads_sync_coverage` row count = 0.
- W8 ledger: `20260807_scheduler_v2.sql` = 1 row, `20260810_ads_sync_coverage.sql` = 1 row.
- W9 no new RPC (no `ads_sync_coverage`-named function). W10 `cron.job` absent (`pg_cron` not installed) → no
  schedule. W11 Migration 1 tables + RPCs all still present.

**Access model (accurate):** `ads_sync_coverage` has RLS enabled and zero policies, so no browser role
(`anon`/`authenticated`) can read/write its rows; the `service_role` key bypasses RLS. No table-level ACL
exclusivity is asserted (not verified).

**Post-apply invariants:** `SCHEDULER_V2_READY_REPORT_KEYS` still empty; the four migration files remain
byte-unchanged (all seven Gate 0 hashes intact); no code changed; no DataDoe call/export; no schedule; no
deployment/push/merge. Scheduler v1 / frontend / routes / cron untouched.

**STOP.** Gate 1c (`20260810_report_sync_controls.sql`), Gate 1d (`20260811_sync_source_job_owners.sql`), the
canary, and any control unlock remain **unapproved** — stop for Codex review and separate approval before
preparing or executing Gate 1c.

---

## Appendix F — Gate 1c package: apply ONLY `20260810_report_sync_controls.sql` (PREPARED — NOT executed)

> **NOTHING in this appendix has been run.** It is the exact package a reviewer/operator executes **after
> written approval**, one migration only, then STOPS for verification before Gate 1d. Gates 1a + 1b (migrations
> 1 + 2) are already applied and verified (Appendices C, E).

Frozen input: `20260810_report_sync_controls.sql` SHA-256 `544557fb…0938bea4c` (Gate 0). **Do NOT use `npm run
db:migrate`** — it applies every pending file at once.

### F.1 What migration 3 changes (accurate characterization)

- **Deletes nothing** (no `DROP TABLE`, no `TRUNCATE`, no change to any existing table or historical data).
- **Creates one table** `public.report_sync_settings` (4 columns; `report_key` `PRIMARY KEY`; a named CHECK
  `report_sync_settings_key_nonempty`; an FK `updated_by → auth.users(id) ON DELETE SET NULL`).
- **Seeds 13 report-control rows**, all `schedule_enabled=false`, `updated_by` NULL, via `INSERT … ON CONFLICT
  (report_key) DO NOTHING`.
- **Enables RLS** and creates **exactly one** policy — `admins read report sync settings`: `SELECT`, to
  `authenticated`, `USING is_dashboard_admin()`. **No browser-write policy** (writes go through the admin API
  with the service role).
- Creates **NO trigger**, **NO RPC**, **NO schedule** (no `pg_cron`/`pg_net`), performs **NO DataDoe call**.
- **Two independent gates stay closed:** (1) the **durable** control rows are all **PAUSED**
  (`schedule_enabled=false`); (2) the **code** readiness allowlist `SCHEDULER_V2_READY_REPORT_KEYS` is **EMPTY**.
  Applying migration 3 only seeds the paused rows — it changes neither gate. A report is live only when **both**
  gates open (a reviewed allowlist addition **and** `schedule_enabled=true`).
- **Replay behavior (raw SQL):** migration 3 **is** replay-idempotent by construction — `CREATE TABLE IF NOT
  EXISTS`, the seed uses `ON CONFLICT (report_key) DO NOTHING`, and the policy is `DROP POLICY IF EXISTS` +
  `CREATE POLICY`. Even so, the ledger + advisory-locked apply (F.3) **MUST still refuse a repeat** (it fails
  closed on the migration-3 ledger row) — the sanctioned path never re-runs it.
- **Prerequisites:** `auth.users` (FK target), `public.is_dashboard_admin()` (policy), the `authenticated` role
  (policy grantee), and `service_role`; Migrations 1 and 2 must already be applied (each ledger row exactly once).

### F.2 Pre-apply read-only inventory (run + REVIEW FIRST; STOP on any hit)

Expected FIRST-APPLY state: ledger exists; **Migration 1 and Migration 2 each present exactly once**; **Migration
3 row absent**; `report_sync_settings` + its named constraint/policy **absent**; prerequisites present;
Migrations 1–2 objects present. Any pre-existing Migration-3 object, or a Migration-3 ledger row, is a **STOP**.

```sql
-- Q1) ledger -- SAFE whether or not the ledger table exists. Migrations 1 & 2 each EXACTLY once; Migration 3
--     absent. Emits a typed NOTICE; STOPs (raises) on a violation.
do $$
declare
  v_ledger boolean := to_regclass('public.app_schema_migrations') is not null;
  v_m1 int := 0; v_m2 int := 0; v_m3 int := 0;
begin
  if v_ledger then
    execute 'select count(*) from public.app_schema_migrations where filename=$1' into v_m1 using '20260807_scheduler_v2.sql';
    execute 'select count(*) from public.app_schema_migrations where filename=$1' into v_m2 using '20260810_ads_sync_coverage.sql';
    execute 'select count(*) from public.app_schema_migrations where filename=$1' into v_m3 using '20260810_report_sync_controls.sql';
  end if;
  raise notice 'ledger_exists:% migration1_rows:% migration2_rows:% migration3_rows:%', v_ledger, v_m1, v_m2, v_m3;
  if not v_ledger then raise exception 'STOP: ledger table absent'; end if;
  if v_m1 <> 1 then raise exception 'STOP: expected exactly 1 Migration-1 ledger row, found %', v_m1; end if;
  if v_m2 <> 1 then raise exception 'STOP: expected exactly 1 Migration-2 ledger row, found %', v_m2; end if;
  if v_m3 <> 0 then raise exception 'STOP: Migration 3 already recorded (% row(s)) -- do NOT re-apply', v_m3; end if;
end $$;
-- Expected NOTICE: "ledger_exists:true migration1_rows:1 migration2_rows:1 migration3_rows:0".

-- Q2) Migration 3 target objects must be ABSENT
select to_regclass('public.report_sync_settings') as report_sync_settings_table;      -- expect NULL
select conname from pg_constraint where conname='report_sync_settings_key_nonempty';  -- expect 0 rows
select pol.polname from pg_policy pol join pg_class rel on rel.oid=pol.polrelid        -- expect 0 rows
 where rel.relname='report_sync_settings';

-- Q3) prerequisites must be present
select to_regclass('auth.users') as auth_users,                                       -- expect non-NULL
       to_regprocedure('public.is_dashboard_admin()') as is_dashboard_admin;           -- expect non-NULL
select rolname from pg_roles where rolname in ('authenticated','service_role') order by rolname;  -- expect 2 rows

-- Q4) Migrations 1 & 2 objects must remain present (do NOT modify)
select to_regclass('public.sync_cycles') a, to_regclass('public.sync_source_jobs') b, to_regclass('public.sync_report_jobs') c,
       to_regclass('public.ads_sync_coverage') d,
       to_regprocedure('public.open_sync_cycle(text, date, timestamptz, text)') e,
       to_regprocedure('public.claim_sync_cycle(uuid)') f,
       to_regprocedure('public.claim_source_export_attempt(uuid, text)') g;            -- expect all non-NULL
```

**STOP (do not apply) if:** Q1 raises; Q2 returns any non-NULL or any row; Q3 shows a missing prerequisite (or
< 2 roles); or Q4 shows any Migration-1/2 object absent.

### F.3 Hardened apply command (single migration, single transaction, advisory-locked, ledger fail-closed)

Advisory key for Gate 1c = `(20260810, 2)` — **distinct** from Gate 1b's `(20260810, 1)`. Run from
`sales-dashboard-live/`; `POSTGRES_URL` loaded from `.env.local` and never printed.

```bash
node --input-type=module -e '
import pg from "pg"; import { readFileSync } from "node:fs";
const FILE = "20260810_report_sync_controls.sql";
const url = new URL(process.env.POSTGRES_URL); url.searchParams.set("sslmode", "no-verify");
const c = new pg.Client({ connectionString: url.toString() }); await c.connect();
try {
  await c.query("begin");
  // 1) transaction-scoped advisory lock (migration-3-specific key), BEFORE any ledger read.
  await c.query("select pg_advisory_xact_lock($1::int, $2::int)", [20260810, 2]);
  await c.query("create table if not exists public.app_schema_migrations (filename text primary key, applied_at timestamptz not null default now())");
  // 2) require Migrations 1 AND 2 applied EXACTLY once.
  const m1 = await c.query("select count(*)::int as n from public.app_schema_migrations where filename=$1", ["20260807_scheduler_v2.sql"]);
  if (m1.rows[0].n !== 1) throw new Error("REFUSING: expected exactly 1 Migration-1 ledger row, found " + m1.rows[0].n);
  const m2 = await c.query("select count(*)::int as n from public.app_schema_migrations where filename=$1", ["20260810_ads_sync_coverage.sql"]);
  if (m2.rows[0].n !== 1) throw new Error("REFUSING: expected exactly 1 Migration-2 ledger row, found " + m2.rows[0].n);
  // 3) fail closed if Migration 3 already recorded.
  const seen = await c.query("select applied_at from public.app_schema_migrations where filename=$1", [FILE]);
  if (seen.rowCount) throw new Error("REFUSING: " + FILE + " already applied at " + seen.rows[0].applied_at);
  // 4) apply migration 3 (its whole body runs inside this one transaction).
  await c.query(readFileSync("supabase/migrations/" + FILE, "utf8"));
  // 5) record the ledger row with a PLAIN insert (a duplicate raises -> rollback).
  await c.query("insert into public.app_schema_migrations (filename) values ($1)", [FILE]);
  await c.query("commit"); console.log("applied " + FILE);
} catch (e) { await c.query("rollback"); throw e; } finally { await c.end(); }
'
```

### F.4 Post-apply STRUCTURAL verification (read-only, scoped to `public.report_sync_settings`; every mismatch is a STOP)

```sql
-- X1) exactly 4 columns in order/type/nullability/default
select ordinal_position, column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema='public' and table_name='report_sync_settings' order by ordinal_position;
-- expect exactly 4 rows:
--  1 report_key       text                       NO   (null)
--  2 schedule_enabled boolean                    NO   false
--  3 updated_by       uuid                       YES  (null)
--  4 updated_at       timestamp with time zone   NO   now()

-- X2) PRIMARY KEY exactly (report_key)
select con.conname, pg_get_constraintdef(con.oid) as definition
  from pg_constraint con join pg_class rel on rel.oid=con.conrelid
 where rel.relname='report_sync_settings' and con.contype='p';  -- expect: PRIMARY KEY (report_key)

-- X3) named CHECK report_sync_settings_key_nonempty (non-blank report_key)
select con.conname, pg_get_constraintdef(con.oid) as definition
  from pg_constraint con join pg_class rel on rel.oid=con.conrelid
 where rel.relname='report_sync_settings' and con.contype='c';
-- expect exactly one CHECK named report_sync_settings_key_nonempty, semantics length(trim(report_key)) > 0
--   (Postgres renders it as CHECK ((length(TRIM(BOTH FROM report_key)) > 0)) or ((length(btrim(report_key)) > 0)))

-- X4) FK updated_by -> auth.users(id) ON DELETE SET NULL
select con.conname, pg_get_constraintdef(con.oid) as definition
  from pg_constraint con join pg_class rel on rel.oid=con.conrelid
 where rel.relname='report_sync_settings' and con.contype='f';
-- expect: FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL

-- X5) indexes: ONLY the PK unique index (report_sync_settings_pkey)
select indexname, indexdef from pg_indexes where schemaname='public' and tablename='report_sync_settings' order by indexname;
-- expect exactly 1 row: report_sync_settings_pkey (UNIQUE on report_key)

-- X6) NO user trigger on the table
select tgname from pg_trigger tg join pg_class rel on rel.oid=tg.tgrelid
 where rel.relname='report_sync_settings' and not tg.tgisinternal;  -- expect 0 rows

-- X7) RLS enabled + EXACTLY ONE policy (SELECT, authenticated only, USING is_dashboard_admin(), no WITH CHECK)
select relrowsecurity from pg_class where relnamespace='public'::regnamespace and relname='report_sync_settings';  -- expect true
select pol.polname, pol.polcmd,
       (select string_agg(rolname, ',' order by rolname) from pg_roles where oid = any(pol.polroles)) as roles,
       pg_get_expr(pol.polqual, pol.polrelid) as using_qual,
       pg_get_expr(pol.polwithcheck, pol.polrelid) as with_check
  from pg_policy pol join pg_class rel on rel.oid=pol.polrelid
 where rel.relname='report_sync_settings';
-- expect exactly 1 row: polcmd='r'; roles='authenticated'; using_qual='is_dashboard_admin()'; with_check NULL

-- X8) EXACTLY these 13 keys, none missing/extra/duplicate; all paused; updated_by all NULL
select count(*) as total,
       count(*) filter (where schedule_enabled) as enabled_count,
       count(*) filter (where updated_by is not null) as has_updater,
       count(distinct report_key) as distinct_keys
  from public.report_sync_settings;  -- expect total=13, enabled_count=0, has_updater=0, distinct_keys=13
with expected(k) as (values ('brand-sales'),('daily-reporting'),('reconciliation'),('fba-plan'),('sku-pl'),
  ('keyword-rank'),('content-changes'),('sales-movers'),('listing-health'),('buy-box-loss'),('returns-leakage'),
  ('ppc-performance'),('listing-optimizer'))
select (select count(*) from expected e left join public.report_sync_settings r on r.report_key=e.k where r.report_key is null) as missing,
       (select count(*) from public.report_sync_settings r left join expected e on e.k=r.report_key where e.k is null) as extra;
-- expect missing=0 and extra=0

-- X9) ledger: Migrations 1, 2, 3 each EXACTLY one row
select filename, count(*) as n from public.app_schema_migrations
 where filename in ('20260807_scheduler_v2.sql','20260810_ads_sync_coverage.sql','20260810_report_sync_controls.sql')
 group by filename order by filename;  -- expect 3 rows, each n=1

-- X10) prior tables unchanged: ads_sync_coverage present + empty; sync_cycles empty
select to_regclass('public.ads_sync_coverage') as ads_sync_coverage,   -- expect non-NULL
       (select count(*) from public.ads_sync_coverage) as ads_rows,     -- expect 0
       (select count(*) from public.sync_cycles) as cycle_rows;         -- expect 0

-- X11) no new RPC; no cron/schedule
select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and proname ilike '%report_sync_settings%';   -- expect 0 rows
select to_regclass('cron.job') as cron_job;  -- if NULL: pg_cron absent -> no schedule; else check for sync jobs (expect 0)
```

**Also (offline / code — NOT a DB query):** confirm `SCHEDULER_V2_READY_REPORT_KEYS` is still `Object.freeze([])`
(empty). **Two independent gates must BOTH stay closed:** the durable control rows are all paused
(`schedule_enabled=false`, X8) AND the code readiness allowlist is empty. A report is live only when **both**
open — seeding the paused rows here opens neither.

### F.5 Stop / rollback conditions (Gate 1c)

- The apply is a single advisory-locked transaction with abort-on-error, so any failure leaves the DB
  **unchanged** (no partial apply). STOP on any error (missing prerequisite, Migration 1 or 2 not recorded
  exactly once, or Migration 3 already recorded) — do not retry.
- **STOP on any structural mismatch:** ≠ 4 columns or any differing order/type/nullability/default (X1); PK not
  exactly `(report_key)` (X2); the `report_sync_settings_key_nonempty` CHECK missing/renamed or not enforcing
  non-blank `report_key` (X3); FK not `updated_by → auth.users(id) ON DELETE SET NULL` (X4); any index other
  than the PK (X5); any user trigger (X6); RLS off, ≠ 1 policy, or a policy that is not SELECT / not
  authenticated-only / missing `is_dashboard_admin()` / has a WITH CHECK (X7); missing / extra / duplicate keys,
  ≠ 13 rows, any `schedule_enabled=true`, or any `updated_by` not null (X8); any ledger filename ≠ exactly one
  row (X9); `ads_sync_coverage` absent or non-empty, or `sync_cycles` non-empty (X10); any new RPC or `cron.job`
  entry (X11); or `SCHEDULER_V2_READY_REPORT_KEYS` not empty (code check).
- Non-destructive: migration 3 is additive; while every v2 control stays locked (shadow) and every durable row
  paused, leaving it applied is safe and inert. **No destructive teardown (DROP TABLE) is prepared.** (The raw
  SQL is replay-idempotent, but the ledger/advisory-locked apply still refuses a repeat.)
- Do **NOT** proceed to Gate 1d (`20260811_sync_source_job_owners.sql`), the canary, any control unlock, or the
  kickoff. Stop for review + explicit human approval.

---

## Appendix G — Gate 1c EXECUTION evidence (applied 2026-08-13)

Executed with explicit human approval, from `feature/scheduler-v2` @ `0f34038`, following Appendix F exactly.
Connected to production Supabase over the configured `POSTGRES_URL` (`sslmode=no-verify`) loaded from untracked
`.env.local` and never printed (the connection string is NOT committed to the repository). **Exactly one migration applied in this gate: `20260810_report_sync_controls.sql`.**

**Preflight:** HEAD includes `0f34038`; migration-3 SHA-256 = `544557fb…0938bea4c` (matches the frozen hash);
`SCHEDULER_V2_READY_REPORT_KEYS` length 0.

**F.2 live read-only inventory (read-only transaction) — CLEAR TO APPLY:**
- Q1 `ledger_exists:true migration1_rows:1 migration2_rows:1 migration3_rows:0`.
- Q2 `report_sync_settings` NULL, `report_sync_settings_key_nonempty` 0 rows, policies 0 rows (all absent).
- Q3 prerequisites present: `auth.users`, `public.is_dashboard_admin()`, roles `authenticated` + `service_role`.
- Q4 Migration 1 & 2 objects present: `sync_cycles`, `sync_source_jobs`, `sync_report_jobs`, `ads_sync_coverage`,
  and the three RPCs.

**Apply (F.3 hardened command):** single transaction, `pg_advisory_xact_lock(20260810, 2)` (distinct from Gate
1b's `(20260810, 1)`) before the ledger reads, required Migrations 1 and 2 each recorded exactly once,
fail-closed check (Migration 3 not previously recorded), migration body applied, **plain** ledger insert, commit
→ `APPLIED 20260810_report_sync_controls.sql`. No retry.

**X1–X11 post-apply structural verification (read-only, scoped to `public.report_sync_settings`) — all PASS:**
- X1 exactly 4 columns in order: `report_key text NOT NULL`, `schedule_enabled boolean NOT NULL default false`,
  `updated_by uuid NULL`, `updated_at timestamptz NOT NULL default now()`.
- X2 `PRIMARY KEY (report_key)`.
- X3 named CHECK `report_sync_settings_key_nonempty` = `((length(TRIM(BOTH FROM report_key)) > 0))` — non-blank
  `report_key` (the only CHECK).
- X4 FK `updated_by → auth.users(id) ON DELETE SET NULL`.
- X5 only the PK unique index `report_sync_settings_pkey`.
- X6 zero user triggers.
- X7 RLS enabled; exactly one policy `admins read report sync settings` — SELECT, to `authenticated` only,
  `USING is_dashboard_admin()`, no WITH CHECK.
- X8 exactly the 13 approved keys (`total=13, distinct=13, missing=0, extra=0`); every `schedule_enabled=false`;
  every `updated_by` NULL.
- X9 ledger: migrations 1, 2, 3 each exactly one row.
- X10 `ads_sync_coverage` present and empty (0 rows); `sync_cycles` empty (0 rows).
- X11 no new RPC; `cron.job` absent (`pg_cron` not installed) → no schedule.

**Two independent gates confirmed CLOSED:** (1) durable controls — all 13 rows `schedule_enabled=false` (X8);
(2) code readiness allowlist — `SCHEDULER_V2_READY_REPORT_KEYS` still `Object.freeze([])` (empty). A report is
live only when both open; neither is opened here.

**Post-apply invariants:** the four migration files remain byte-unchanged (all seven Gate 0 hashes intact); no
code changed; no DataDoe call/export; no schedule; no deployment/push/merge. Scheduler v1 / frontend / routes /
cron untouched.

**STOP.** Gate 1d (`20260811_sync_source_job_owners.sql`), the canary, and any control unlock remain
**unapproved** — stop for Codex review and separate approval before preparing or executing Gate 1d.

---

## Appendix H — Gate 1d package: apply ONLY `20260811_sync_source_job_owners.sql` (PREPARED — NOT executed)

> **NOTHING in this appendix has been run.** It is the exact package a reviewer/operator executes **after
> written approval**, one migration only, then STOPS. Gates 1a–1c (migrations 1–3) are already applied and
> verified (Appendices C, E, G). **Higher risk:** this migration supports BOTH a fresh-table path **and** an
> earlier-shape UPGRADE path (backfill + `NOT NULL` + constraints). **This rollout authorizes ONLY the fresh
> path (Branch A).** If the owner table already exists (Branch B), STOP and return for a separate upgrade-path
> review — do **NOT** auto-apply over an existing table.

Frozen input: `20260811_sync_source_job_owners.sql` SHA-256 `49628c8d…54d98669` (Gate 0). **Do NOT use `npm run
db:migrate`.**

### H.1 What migration 4 changes (accurate characterization)

- **Deletes nothing** (never `DROP TABLE`/`TRUNCATE`; the only DROPs are `DROP TRIGGER IF EXISTS` / `DROP POLICY
  IF EXISTS` for its OWN trigger/policy, immediately re-created; changes NO other table).
- **Creates one table** `public.sync_source_job_owners` — **15 columns** (fresh-path order): `id uuid PK default
  gen_random_uuid()`, `cycle_id uuid NOT NULL`, `request_hash text NOT NULL`, `owner_id text NOT NULL`,
  `request_key text NOT NULL`, `report_key text NOT NULL`, `account_id text NOT NULL`, `connection_id text`
  (converged to `NOT NULL default 'primary'`), `organization_fingerprint text NOT NULL`, `account_scope_hash text
  NOT NULL`, `owner_status text NOT NULL default 'active'`, `error_code text`, `error_message text`, `created_at
  timestamptz NOT NULL default now()`, `updated_at timestamptz NOT NULL default now()`.
- **Constraints:** PK `(id)`; UNIQUE membership `sync_source_job_owners_unique (cycle_id, request_hash,
  owner_id)`; FK `cycle_id → sync_cycles(id) ON DELETE CASCADE`; composite FK `sync_source_job_owners_source_fk
  (cycle_id, request_hash) → sync_source_jobs(cycle_id, request_hash) ON DELETE CASCADE`; CHECK `owner_status in
  ('active','stale')`; named CHECK `sync_source_job_owners_connection_id_check` (`connection_id in
  ('primary','dd-secondary')`); named CHECK `sync_source_job_owners_identity_nonempty` (`char_length > 0` for
  report_key AND account_id AND request_key AND organization_fingerprint AND account_scope_hash).
- **Convergence (runs on both paths; no-ops on a fresh 0-row table):** `ADD COLUMN IF NOT EXISTS connection_id`;
  deterministic `connection_id` backfill (a `dd-secondary:`-prefixed account ⇒ `dd-secondary`; other NULLs ⇒
  `primary`; **never downgrades** a secondary to primary); a fail-closed DO block that ABORTS if any existing row
  has a blank identity field or a null/invalid `connection_id`; removal of unsafe blank defaults + `SET NOT NULL`
  on report_key/account_id/organization_fingerprint/account_scope_hash + `connection_id SET NOT NULL SET DEFAULT
  'primary'`.
- **Two explicit indexes:** `sync_source_job_owners_owner_idx (cycle_id, owner_id)`,
  `sync_source_job_owners_hash_idx (cycle_id, request_hash)` (plus the PK + unique-constraint indexes).
- **Trigger** `sync_source_job_owners_touch` — `BEFORE UPDATE` → `touch_updated_at()`.
- **RLS enabled; one policy** `admins read sync source job owners`: SELECT, to `authenticated`, `USING
  is_dashboard_admin()`. No browser-write policy.
- `request_hash` and `owner_id` are **NEVER rewritten** (no `ALTER` touches them). **No secret is stored; no
  DataDoe call; no RPC; no schedule; no control change.**
- **Prerequisites:** `sync_cycles` + `sync_source_jobs` (FK targets — incl. the `sync_source_jobs` UNIQUE
  `(cycle_id, request_hash)` the composite FK references), `touch_updated_at()`, `is_dashboard_admin()`, the
  `authenticated` + `service_role` roles; Migrations 1–3 already applied.
- **Replay:** the raw SQL is idempotent (create/add-if-not-exists, guarded `ADD CONSTRAINT`, DROP/CREATE
  trigger+policy, idempotent `ALTER`s), but the ledger + advisory-locked apply MUST still refuse a repeat.

### H.2 Pre-apply read-only inventory — TWO BRANCHES (run + REVIEW FIRST)

**Ledger + prerequisites (both branches):**

```sql
-- Q1) ledger: Migrations 1-3 each EXACTLY once, Migration 4 absent (guarded DO block; SAFE if ledger absent)
do $$
declare v_ledger boolean := to_regclass('public.app_schema_migrations') is not null;
  v1 int:=0; v2 int:=0; v3 int:=0; v4 int:=0;
begin
  if v_ledger then
    execute 'select count(*) from public.app_schema_migrations where filename=$1' into v1 using '20260807_scheduler_v2.sql';
    execute 'select count(*) from public.app_schema_migrations where filename=$1' into v2 using '20260810_ads_sync_coverage.sql';
    execute 'select count(*) from public.app_schema_migrations where filename=$1' into v3 using '20260810_report_sync_controls.sql';
    execute 'select count(*) from public.app_schema_migrations where filename=$1' into v4 using '20260811_sync_source_job_owners.sql';
  end if;
  raise notice 'ledger:% m1:% m2:% m3:% m4:%', v_ledger, v1, v2, v3, v4;
  if not v_ledger then raise exception 'STOP: ledger absent'; end if;
  if v1<>1 then raise exception 'STOP: Migration 1 rows=%', v1; end if;
  if v2<>1 then raise exception 'STOP: Migration 2 rows=%', v2; end if;
  if v3<>1 then raise exception 'STOP: Migration 3 rows=%', v3; end if;
  if v4<>0 then raise exception 'STOP: Migration 4 already recorded (rows=%)', v4; end if;
end $$;
-- Expected NOTICE: "ledger:true m1:1 m2:1 m3:1 m4:0".

-- Q2) prerequisites: FK-target tables; the exact sync_source_jobs UNIQUE(cycle_id,request_hash); helpers; roles;
--     and the shadow invariants (sync_cycles empty, 13 paused controls)
select to_regclass('public.sync_cycles') as sync_cycles,            -- expect non-NULL
       to_regclass('public.sync_source_jobs') as sync_source_jobs;   -- expect non-NULL
select con.conname, pg_get_constraintdef(con.oid) as def
  from pg_constraint con
 where con.conrelid = 'public.sync_source_jobs'::regclass and con.contype='u'
   and pg_get_constraintdef(con.oid) ilike '%(cycle_id, request_hash)%';  -- expect the UNIQUE (cycle_id, request_hash)
select to_regprocedure('public.touch_updated_at()') as touch_updated_at,       -- expect non-NULL
       to_regprocedure('public.is_dashboard_admin()') as is_dashboard_admin;    -- expect non-NULL
select rolname from pg_roles where rolname in ('authenticated','service_role') order by rolname;  -- expect 2 rows
select (select count(*) from public.sync_cycles) as sync_cycles_rows;   -- expect 0 (remains empty)
select count(*) as controls_total, count(*) filter (where schedule_enabled) as controls_enabled
  from public.report_sync_settings;  -- expect 13 and 0

-- Q3) BRANCH DISCRIMINATOR
select to_regclass('public.sync_source_job_owners') as owner_table;   -- NULL => Branch A; non-NULL => Branch B
```

**Branch A — `sync_source_job_owners` ABSENT (fresh-path eligible; this rollout applies ONLY here):**

```sql
-- A1) confirm EVERY owner object is ABSENT IN public (expect 0 rows from each). The table is absent here, so we
--     join pg_namespace and require nspname='public' (a ::regclass cast would ERROR on an absent relation), and
--     scope by nspname so a same-named object in ANOTHER schema cannot cause a false STOP.
select con.conname from pg_constraint con
  join pg_class rel on rel.oid=con.conrelid join pg_namespace n on n.oid=rel.relnamespace
 where n.nspname='public' and con.conname in
  ('sync_source_job_owners_unique','sync_source_job_owners_source_fk',
   'sync_source_job_owners_connection_id_check','sync_source_job_owners_identity_nonempty');  -- expect 0
select indexname from pg_indexes where schemaname='public'
  and indexname in ('sync_source_job_owners_owner_idx','sync_source_job_owners_hash_idx');    -- expect 0
select tg.tgname from pg_trigger tg
  join pg_class rel on rel.oid=tg.tgrelid join pg_namespace n on n.oid=rel.relnamespace
 where n.nspname='public' and not tg.tgisinternal and tg.tgname='sync_source_job_owners_touch';  -- expect 0
select pol.polname from pg_policy pol
  join pg_class rel on rel.oid=pol.polrelid join pg_namespace n on n.oid=rel.relnamespace
 where n.nspname='public' and rel.relname='sync_source_job_owners';  -- expect 0
```

Branch A ⇒ record **fresh-path eligible**; after approval, proceed to H.3.

**Branch B — `sync_source_job_owners` ALREADY EXISTS ⇒ STOP; do NOT apply.** Collect ONLY the universally-safe
B0 metadata (schema, constraints, indexes, triggers, policies, RLS) and the row count below — these make **no
assumption about which columns exist**. Do **NOT** run any column-referencing row classification here: an
earlier table shape may lack `connection_id` (or other columns), so a fixed classification query would ERROR. The
shape-specific classification is built and reviewed **separately**, once B0 reveals the actual columns. Repair /
delete / backfill / alter / dynamically-guess NOTHING. Because the table exists, `::regclass` scopes every
lookup to `public.sync_source_job_owners` exactly (no cross-schema false result).

```sql
-- B0) exact current shape (universally safe -- no assumption about which columns exist)
select ordinal_position, column_name, data_type, is_nullable, column_default from information_schema.columns
 where table_schema='public' and table_name='sync_source_job_owners' order by ordinal_position;
select con.conname, con.contype, pg_get_constraintdef(con.oid) as def from pg_constraint con
 where con.conrelid = 'public.sync_source_job_owners'::regclass order by con.conname;
select indexname, indexdef from pg_indexes where schemaname='public' and tablename='sync_source_job_owners';
select tg.tgname, tg.tgenabled, pg_get_triggerdef(tg.oid) as def from pg_trigger tg
 where tg.tgrelid = 'public.sync_source_job_owners'::regclass and not tg.tgisinternal;
select pol.polname, pol.polcmd, pg_get_expr(pol.polqual, pol.polrelid) as using_qual from pg_policy pol
 where pol.polrelid = 'public.sync_source_job_owners'::regclass;
select relrowsecurity from pg_class where oid = 'public.sync_source_job_owners'::regclass;
select count(*) as row_count from public.sync_source_job_owners;
```

Branch B result ⇒ **hand the B0 output (exact columns + constraints + indexes + triggers + policies + RLS + row
count) to a separate, shape-specific upgrade-path review that builds the row classification against the columns
B0 actually reports. Do NOT auto-apply over an existing table, and do NOT run a fixed classification here.**

**STOP (do not apply) if:** Q1 raises; Q2 shows a missing prerequisite / the `sync_source_jobs` UNIQUE
`(cycle_id, request_hash)` absent / `sync_cycles` non-empty / not 13 paused controls; Branch A shows any owner
object already present; **or Branch B applies at all** (owner table exists).

### H.3 Hardened FRESH-PATH apply (single migration, single transaction, advisory-locked, fresh-path-only)

Advisory key = `(20260811, 1)`. Requires Migrations 1–3 each exactly once, refuses a recorded Migration 4, and —
critically — **re-checks INSIDE the locked transaction that `sync_source_job_owners` is ABSENT** (fresh path
only); if the table exists it rolls back and STOPs for the Branch-B upgrade review. Run from
`sales-dashboard-live/`; `POSTGRES_URL` from `.env.local`, never printed.

```bash
node --input-type=module -e '
import pg from "pg"; import { readFileSync } from "node:fs";
const FILE = "20260811_sync_source_job_owners.sql";
const url = new URL(process.env.POSTGRES_URL); url.searchParams.set("sslmode","no-verify");
const c = new pg.Client({ connectionString: url.toString() }); await c.connect();
try {
  await c.query("begin");
  await c.query("select pg_advisory_xact_lock($1::int, $2::int)", [20260811, 1]);
  await c.query("create table if not exists public.app_schema_migrations (filename text primary key, applied_at timestamptz not null default now())");
  for (const [f, n] of [["20260807_scheduler_v2.sql",1],["20260810_ads_sync_coverage.sql",2],["20260810_report_sync_controls.sql",3]]) {
    const r = await c.query("select count(*)::int as n from public.app_schema_migrations where filename=$1", [f]);
    if (r.rows[0].n !== 1) throw new Error("REFUSING: expected exactly 1 Migration-" + n + " ledger row, found " + r.rows[0].n);
  }
  const seen = await c.query("select applied_at from public.app_schema_migrations where filename=$1", [FILE]);
  if (seen.rowCount) throw new Error("REFUSING: " + FILE + " already applied at " + seen.rows[0].applied_at);
  const exists = await c.query("select to_regclass($1) as t", ["public.sync_source_job_owners"]);
  if (exists.rows[0].t !== null) throw new Error("REFUSING: sync_source_job_owners already exists -- fresh-path apply only; run the Branch-B upgrade-path review");
  await c.query(readFileSync("supabase/migrations/" + FILE, "utf8"));
  await c.query("insert into public.app_schema_migrations (filename) values ($1)", [FILE]);
  await c.query("commit"); console.log("applied " + FILE);
} catch (e) { await c.query("rollback"); throw e; } finally { await c.end(); }
'
```

### H.4 Post-apply STRUCTURAL verification (read-only, scoped to `public.sync_source_job_owners`; every mismatch is a STOP)

```sql
-- Y1) exactly 15 columns in order/type/nullability/default
select ordinal_position, column_name, data_type, is_nullable, column_default from information_schema.columns
 where table_schema='public' and table_name='sync_source_job_owners' order by ordinal_position;
-- expect 15 rows:
--  1 id                       uuid                     NO   gen_random_uuid()
--  2 cycle_id                 uuid                     NO   (null)
--  3 request_hash             text                     NO   (null)
--  4 owner_id                 text                     NO   (null)
--  5 request_key              text                     NO   (null)
--  6 report_key               text                     NO   (null)
--  7 account_id               text                     NO   (null)
--  8 connection_id            text                     NO   'primary'::text
--  9 organization_fingerprint text                     NO   (null)
-- 10 account_scope_hash       text                     NO   (null)
-- 11 owner_status             text                     NO   'active'::text
-- 12 error_code               text                     YES  (null)
-- 13 error_message            text                     YES  (null)
-- 14 created_at               timestamp with time zone NO   now()
-- 15 updated_at               timestamp with time zone NO   now()

-- Y2) PRIMARY KEY (id)
select pg_get_constraintdef(con.oid) def from pg_constraint con
 where con.conrelid = 'public.sync_source_job_owners'::regclass and con.contype='p';  -- expect PRIMARY KEY (id)

-- Y3) UNIQUE membership (cycle_id, request_hash, owner_id)
select con.conname, pg_get_constraintdef(con.oid) def from pg_constraint con
 where con.conrelid = 'public.sync_source_job_owners'::regclass and con.contype='u';
-- expect: sync_source_job_owners_unique UNIQUE (cycle_id, request_hash, owner_id)

-- Y4) the two FKs
select con.conname, pg_get_constraintdef(con.oid) def from pg_constraint con
 where con.conrelid = 'public.sync_source_job_owners'::regclass and con.contype='f' order by con.conname;
-- expect: FOREIGN KEY (cycle_id) REFERENCES sync_cycles(id) ON DELETE CASCADE;
--         sync_source_job_owners_source_fk FOREIGN KEY (cycle_id, request_hash)
--           REFERENCES sync_source_jobs(cycle_id, request_hash) ON DELETE CASCADE

-- Y5) the three CHECKs
select con.conname, pg_get_constraintdef(con.oid) def from pg_constraint con
 where con.conrelid = 'public.sync_source_job_owners'::regclass and con.contype='c' order by con.conname;
-- expect: owner_status = ANY (ARRAY['active'::text, 'stale'::text]);
--         sync_source_job_owners_connection_id_check  connection_id = ANY (ARRAY['primary'::text, 'dd-secondary'::text]);
--         sync_source_job_owners_identity_nonempty  char_length(report_key)>0 AND char_length(account_id)>0
--           AND char_length(request_key)>0 AND char_length(organization_fingerprint)>0 AND char_length(account_scope_hash)>0

-- Y6) indexes: the PK + unique + the two explicit owner/hash indexes (4 total)
select indexname, indexdef from pg_indexes where schemaname='public' and tablename='sync_source_job_owners' order by indexname;
-- expect: sync_source_job_owners_pkey (id); sync_source_job_owners_unique (cycle_id, request_hash, owner_id);
--         sync_source_job_owners_owner_idx (cycle_id, owner_id); sync_source_job_owners_hash_idx (cycle_id, request_hash)

-- Y7) trigger enabled, BEFORE UPDATE, touch_updated_at()
select tg.tgname, tg.tgenabled, pg_get_triggerdef(tg.oid) def from pg_trigger tg
 where tg.tgrelid = 'public.sync_source_job_owners'::regclass and not tg.tgisinternal;
-- expect 1 row: sync_source_job_owners_touch, tgenabled='O', "... BEFORE UPDATE ON public.sync_source_job_owners
--   FOR EACH ROW EXECUTE FUNCTION touch_updated_at()"

-- Y8) RLS enabled + EXACTLY ONE policy (SELECT, authenticated only, USING is_dashboard_admin(), no WITH CHECK)
select relrowsecurity from pg_class where oid = 'public.sync_source_job_owners'::regclass;  -- expect true
select pol.polname, pol.polcmd,
       (select string_agg(rolname, ',' order by rolname) from pg_roles where oid = any(pol.polroles)) as roles,
       pg_get_expr(pol.polqual, pol.polrelid) as using_qual, pg_get_expr(pol.polwithcheck, pol.polrelid) as with_check
  from pg_policy pol where pol.polrelid = 'public.sync_source_job_owners'::regclass;
-- expect exactly 1 row: polcmd='r'; roles='authenticated'; using_qual='is_dashboard_admin()'; with_check NULL

-- Y9) zero owner rows (fresh path)
select count(*) as owner_rows from public.sync_source_job_owners;  -- expect 0

-- Y10) ledger: Migrations 1-4 each EXACTLY one row
select filename, count(*) as n from public.app_schema_migrations
 where filename in ('20260807_scheduler_v2.sql','20260810_ads_sync_coverage.sql','20260810_report_sync_controls.sql','20260811_sync_source_job_owners.sql')
 group by filename order by filename;  -- expect 4 rows, each n=1

-- Y11) prior tables intact: sync_cycles empty, sync_source_jobs empty, ads_sync_coverage empty; 13 paused controls
select (select count(*) from public.sync_cycles) as sync_cycles,
       (select count(*) from public.sync_source_jobs) as sync_source_jobs,
       (select count(*) from public.ads_sync_coverage) as ads_sync_coverage;  -- expect 0, 0, 0
select count(*) as controls_total, count(*) filter (where schedule_enabled) as controls_enabled
  from public.report_sync_settings;  -- expect 13 and 0

-- Y12) no new RPC; no cron/schedule
select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and proname ilike '%sync_source_job_owners%';  -- expect 0 rows
select to_regclass('cron.job') as cron_job;  -- if NULL: pg_cron absent -> no schedule; else check for sync jobs (expect 0)
```

**Also (offline / code — NOT a DB query):** confirm `SCHEDULER_V2_READY_REPORT_KEYS` is still `Object.freeze([])`
(empty). Both gates stay closed — durable controls paused (Y11) AND the code allowlist empty.

### H.5 Stop / rollback conditions (Gate 1d)

- The apply is a single advisory-locked, fresh-path-only transaction with abort-on-error, so any failure leaves
  the DB **unchanged** (no partial apply). STOP on any error (missing prerequisite, Migrations 1–3 not each
  exactly once, Migration 4 already recorded, **or the owner table already exists** — the in-transaction fresh
  guard). Do not retry.
- **STOP on any structural mismatch:** ≠ 15 columns or any differing order/type/nullability/default (Y1 — esp.
  `connection_id NOT NULL default 'primary'`, and report_key/account_id/organization_fingerprint/
  account_scope_hash NOT NULL with no default); PK not `(id)` (Y2); UNIQUE not `(cycle_id, request_hash,
  owner_id)` (Y3); either FK missing / wrong target / wrong `ON DELETE` (Y4); any of the three CHECKs missing or
  not enforcing exactly `active|stale` / `primary|dd-secondary` / the 5-field non-empty AND (Y5); missing the two
  explicit indexes or an unexpected extra index (Y6); the trigger absent/disabled/not BEFORE UPDATE/not
  `touch_updated_at()` (Y7); RLS off, ≠ 1 policy, or a policy not SELECT / not authenticated-only / missing
  `is_dashboard_admin()` / with a WITH CHECK (Y8); owner rows > 0 (Y9); any ledger filename ≠ exactly one row
  (Y10); `sync_cycles`/`sync_source_jobs`/`ads_sync_coverage` non-empty or ≠ 13 paused controls (Y11); any new
  RPC or cron entry (Y12); or `SCHEDULER_V2_READY_REPORT_KEYS` not empty (code check).
- **No destructive rollback, repair, backfill, delete, or DROP** is prepared. Migration 4 is additive; while
  every v2 control stays locked and paused (shadow), leaving it applied is safe and inert. A Branch-B upgrade is
  a separate, reviewed path — never an automatic apply over an existing table.
- Do **NOT** proceed to the canary or Gate 2. Stop for review + explicit human approval.

---

## Appendix I — Gate 1d EXECUTION evidence (applied 2026-08-13)

Executed with explicit human approval, from `feature/scheduler-v2` @ `9250663`, following Appendix H exactly.
Connected to production Supabase over the configured `POSTGRES_URL` (`sslmode=no-verify`) loaded from untracked
`.env.local` and never printed (the connection string is NOT committed to the repository). **Exactly one migration applied in this gate: `20260811_sync_source_job_owners.sql` — via the
FRESH path (Branch A).**

**Preflight:** HEAD includes `9250663`; migration-4 SHA-256 = `49628c8d…54d98669` (matches the frozen hash);
`SCHEDULER_V2_READY_REPORT_KEYS` length 0.

**H.2 live read-only inventory (read-only transaction) — Branch A confirmed, CLEAR TO APPLY:**
- Q1 `ledger:true m1:1 m2:1 m3:1 m4:0`.
- Q2 prerequisites: `sync_cycles` + `sync_source_jobs` present; the `sync_source_jobs` UNIQUE(cycle_id,
  request_hash) = `sync_source_jobs_cycle_hash_unique`; `touch_updated_at()` + `is_dashboard_admin()` present;
  roles `authenticated` + `service_role`; `sync_cycles` empty; controls 13/0 (all paused).
- Q3 `sync_source_job_owners` NULL ⇒ **Branch A** (fresh path). A1: owner constraints / indexes / trigger /
  policy all absent (0/0/0/0). **Branch B was not taken** (no existing owner table).

**Apply (H.3 hardened fresh-path command):** single transaction, `pg_advisory_xact_lock(20260811, 1)` before the
ledger reads, required Migrations 1–3 each recorded exactly once, fail-closed check (Migration 4 not previously
recorded), **in-transaction re-check that `sync_source_job_owners` was ABSENT** (fresh path only), migration body
applied, **plain** ledger insert, commit → `APPLIED 20260811_sync_source_job_owners.sql`. No retry.

**Y1–Y12 post-apply structural verification (read-only, scoped to `public.sync_source_job_owners`) — all PASS:**
- Y1 exactly 15 columns in order (id uuid PK `gen_random_uuid()`; cycle_id/request_hash/owner_id/request_key/
  report_key/account_id NOT NULL; `connection_id text NOT NULL default 'primary'`; organization_fingerprint/
  account_scope_hash NOT NULL; `owner_status text NOT NULL default 'active'`; error_code/error_message nullable;
  created_at/updated_at timestamptz NOT NULL `now()`).
- Y2 `PRIMARY KEY (id)`. Y3 `sync_source_job_owners_unique UNIQUE (cycle_id, request_hash, owner_id)`.
- Y4 both FKs: `(cycle_id) → sync_cycles(id) ON DELETE CASCADE`; `sync_source_job_owners_source_fk (cycle_id,
  request_hash) → sync_source_jobs(cycle_id, request_hash) ON DELETE CASCADE`.
- Y5 the three CHECKs: `owner_status = ANY (ARRAY['active','stale'])`;
  `sync_source_job_owners_connection_id_check connection_id = ANY (ARRAY['primary','dd-secondary'])`;
  `sync_source_job_owners_identity_nonempty` (`char_length > 0` for report_key AND account_id AND request_key
  AND organization_fingerprint AND account_scope_hash).
- Y6 four indexes: `sync_source_job_owners_pkey`, `sync_source_job_owners_unique`,
  `sync_source_job_owners_owner_idx (cycle_id, owner_id)`, `sync_source_job_owners_hash_idx (cycle_id,
  request_hash)`.
- Y7 trigger `sync_source_job_owners_touch`: enabled (`O`), `BEFORE UPDATE`, `EXECUTE FUNCTION
  touch_updated_at()`.
- Y8 RLS enabled; exactly one policy `admins read sync source job owners` — SELECT, to `authenticated` only,
  `USING is_dashboard_admin()`, no WITH CHECK.
- Y9 owner rows = 0. Y10 ledger: migrations 1, 2, 3, 4 each exactly one row. Y11 `sync_cycles`,
  `sync_source_jobs`, `ads_sync_coverage` all empty; 13 controls, all paused. Y12 no new RPC; `cron.job` absent
  (`pg_cron` not installed) → no schedule.

**Confirmations:** Migration 4 has exactly one ledger row; the owner table has zero rows; the existing
Scheduler-v2 tables (`sync_cycles`, `sync_source_jobs`, `ads_sync_coverage`) remain empty; all 13 durable
controls remain paused; `SCHEDULER_V2_READY_REPORT_KEYS` is still `Object.freeze([])` (empty); no cron/schedule
exists; zero DataDoe calls/exports occurred (pure additive DDL). All four migration files remain byte-unchanged
(all seven Gate 0 hashes intact); no code changed; no deployment/push/merge. Scheduler v1 / frontend / routes /
cron untouched.

**Migrations 1–4 are now applied.** **STOP** — do not proceed to Gate 2, canary execution, deployment, any
control unlock, or scheduling. Stop for Codex review.

---

## Appendix J — Gate 2 package: read-only re-verification of migrations 1–4 (PREPARED — NOT executed)

> **NOTHING in this appendix has been run.** It is the exact **read-only** package a reviewer/operator executes
> **after written approval** to re-confirm that the applied schema (migrations 1–4) still matches the contract.
> It performs **zero writes, zero DataDoe calls/exports, and no control/schedule change** — run it entirely
> inside a read-only transaction (`begin; set transaction read only; … ; rollback;`). It only reads catalogs +
> the empty Scheduler-v2 tables. Do **NOT** prepare or run the canary, unlock controls, deploy, push, merge,
> schedule, or call DataDoe from this gate.

This consolidates and **MUST reproduce every pass** already recorded per migration — V1–V11 (Appendix B.4),
W1–W11 (Appendix D.4), X1–X11 (Appendix F.4), Y1–Y12 (Appendix H.4) — using **public-scoped** catalog queries
(exact `public.<rel>::regclass` / `regprocedure` OIDs, or `nspname='public'`). Those per-migration blocks remain
the authoritative per-object expectations (exact column lists, CHECK bodies, index/trigger/policy definitions);
G3–G9 below re-read the same objects across all four migrations at once.

### J.1 Cross-cutting read-only verification (run in a read-only transaction)

```sql
-- Run this ENTIRE block as ONE read-only transaction. BEGIN + SET TRANSACTION READ ONLY guarantee that any
-- accidental non-SELECT would ERROR (nothing can be written), and the trailing ROLLBACK releases the snapshot.
-- Every statement below is a SELECT / catalog read, and there is NO branch inside the transaction, so the final
-- ROLLBACK can never be skipped.
begin;
set transaction read only;

-- G1) all SIX Scheduler-v2 tables present (expect all six non-NULL)
select to_regclass('public.sync_cycles') a, to_regclass('public.sync_source_jobs') b,
       to_regclass('public.sync_report_jobs') c, to_regclass('public.ads_sync_coverage') d,
       to_regclass('public.report_sync_settings') e, to_regclass('public.sync_source_job_owners') f;

-- G2) the FOUR migration ledger rows, each EXACTLY once (expect 4 rows, each n=1)
select filename, count(*) as n from public.app_schema_migrations
 where filename in ('20260807_scheduler_v2.sql','20260810_ads_sync_coverage.sql',
                    '20260810_report_sync_controls.sql','20260811_sync_source_job_owners.sql')
 group by filename order by filename;

-- G3) exact columns for every table (compare each block to the expected shapes in V1/W1/X1/Y1)
select table_name, ordinal_position, column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema='public' and table_name in
   ('sync_cycles','sync_source_jobs','sync_report_jobs','ads_sync_coverage','report_sync_settings','sync_source_job_owners')
 order by table_name, ordinal_position;
-- expect column counts: sync_cycles 18, sync_source_jobs 27, sync_report_jobs 25, ads_sync_coverage 8,
--   report_sync_settings 4, sync_source_job_owners 15.

-- G4) every NAMED constraint on the six tables, scoped by exact public relation OIDs (pg_get_constraintdef)
select rel.relname as table_name, con.conname, con.contype, pg_get_constraintdef(con.oid) as def
  from pg_constraint con join pg_class rel on rel.oid=con.conrelid
 where con.conrelid in ('public.sync_cycles'::regclass,'public.sync_source_jobs'::regclass,
   'public.sync_report_jobs'::regclass,'public.ads_sync_coverage'::regclass,
   'public.report_sync_settings'::regclass,'public.sync_source_job_owners'::regclass)
 order by rel.relname, con.contype, con.conname;
-- MUST reproduce every constraint asserted in V2/V3, W2/W3, X2/X3/X4, Y2–Y5: PKs; uniques
--   (sync_cycles_bucket_date_unique, sync_source_jobs_cycle_hash_unique, sync_report_jobs_cycle_report_account_unique,
--    sync_source_job_owners_unique); FKs with ON DELETE (sync_source_jobs.cycle_id & sync_report_jobs.cycle_id &
--    sync_source_job_owners.cycle_id -> sync_cycles(id) CASCADE; sync_source_job_owners_source_fk (cycle_id,
--    request_hash) -> sync_source_jobs CASCADE; sync_cycles.created_by -> auth.users(id) SET NULL); CHECKs
--   (sync_source_jobs_one_attempt; report_sync_settings_key_nonempty; ads_sync_coverage status='succeeded';
--    sync_source_job_owners owner_status active|stale, connection_id primary|dd-secondary, identity_nonempty).

-- G5) all indexes on the six tables (the explicit indexes + each PK/unique index; no unexpected extras)
select tablename, indexname, indexdef from pg_indexes where schemaname='public'
 and tablename in ('sync_cycles','sync_source_jobs','sync_report_jobs','ads_sync_coverage','report_sync_settings','sync_source_job_owners')
 order by tablename, indexname;

-- G6) all USER triggers on the six tables (each enabled 'O', BEFORE UPDATE, EXECUTE FUNCTION touch_updated_at())
select rel.relname as table_name, tg.tgname, tg.tgenabled, pg_get_triggerdef(tg.oid) as def
  from pg_trigger tg join pg_class rel on rel.oid=tg.tgrelid
 where tg.tgrelid in ('public.sync_cycles'::regclass,'public.sync_source_jobs'::regclass,
   'public.sync_report_jobs'::regclass,'public.ads_sync_coverage'::regclass,
   'public.report_sync_settings'::regclass,'public.sync_source_job_owners'::regclass)
   and not tg.tgisinternal
 order by rel.relname;
-- expect the five touch triggers (sync_cycles_touch, sync_source_jobs_touch, sync_report_jobs_touch,
--   ads_sync_coverage_touch_updated_at, sync_source_job_owners_touch); report_sync_settings has NO trigger (X6).

-- G7) RLS enabled on ALL six tables (expect relrowsecurity=true for all six)
select rel.relname, rel.relrowsecurity from pg_class rel
 where rel.oid in ('public.sync_cycles'::regclass,'public.sync_source_jobs'::regclass,
   'public.sync_report_jobs'::regclass,'public.ads_sync_coverage'::regclass,
   'public.report_sync_settings'::regclass,'public.sync_source_job_owners'::regclass)
 order by rel.relname;

-- G8) all policies on the six tables (SELECT / authenticated / is_dashboard_admin() / no WITH CHECK)
select rel.relname as table_name, pol.polname, pol.polcmd,
       (select string_agg(rolname, ',' order by rolname) from pg_roles where oid = any(pol.polroles)) as roles,
       pg_get_expr(pol.polqual, pol.polrelid) as using_qual, pg_get_expr(pol.polwithcheck, pol.polrelid) as with_check
  from pg_policy pol join pg_class rel on rel.oid=pol.polrelid
 where pol.polrelid in ('public.sync_cycles'::regclass,'public.sync_source_jobs'::regclass,
   'public.sync_report_jobs'::regclass,'public.ads_sync_coverage'::regclass,
   'public.report_sync_settings'::regclass,'public.sync_source_job_owners'::regclass)
 order by rel.relname;
-- expect EXACTLY 5 policies (sync_cycles, sync_source_jobs, sync_report_jobs, report_sync_settings,
--   sync_source_job_owners) each polcmd='r', roles='authenticated', using='is_dashboard_admin()', with_check NULL.
--   ads_sync_coverage has ZERO policies (W6) -- RLS on + no policy (service_role bypass).

-- G9a) the three RPCs: exact identity args, return, SECURITY DEFINER, search_path (via exact regprocedure OIDs)
select p.proname, pg_get_function_identity_arguments(p.oid) as args, pg_get_function_result(p.oid) as ret,
       p.prosecdef as security_definer, p.proconfig as config
  from pg_proc p
 where p.oid in ('public.open_sync_cycle(text, date, timestamptz, text)'::regprocedure,
   'public.claim_sync_cycle(uuid)'::regprocedure,
   'public.claim_source_export_attempt(uuid, text)'::regprocedure)
 order by p.proname;
-- expect exactly the V7 identities/returns; prosecdef=true; proconfig contains 'search_path=public'.

-- G9b) RPC EXECUTE ACL -- ONLY the function owner (inherent privilege) and service_role may hold EXECUTE.
--      Enumerate EVERY EXECUTE grantee for each RPC and FAIL on any grantee that is neither the owner
--      (a.grantee = p.proowner) nor service_role. PUBLIC (a.grantee = 0), anon, authenticated, or ANY arbitrary
--      extra role therefore all appear here => STOP. Expect 0 rows.
select p.proname,
       (case when a.grantee = 0 then 'PUBLIC'
             when a.grantee = p.proowner then '(owner)'
             else coalesce(r.rolname, a.grantee::text) end) as forbidden_execute_grantee
  from pg_proc p
  cross join lateral aclexplode(p.proacl) a
  left join pg_roles r on r.oid = a.grantee
 where p.oid in ('public.open_sync_cycle(text, date, timestamptz, text)'::regprocedure,
   'public.claim_sync_cycle(uuid)'::regprocedure,'public.claim_source_export_attempt(uuid, text)'::regprocedure)
   and a.privilege_type = 'EXECUTE'
   and a.grantee <> p.proowner                                          -- owner's inherent EXECUTE is allowed
   and a.grantee not in (select oid from pg_roles where rolname = 'service_role')  -- the one explicit grant
 order by p.proname, forbidden_execute_grantee;  -- expect 0 rows (any row => a non-owner/non-service_role holds EXECUTE)
-- Separately: service_role HAS EXECUTE on ALL THREE RPCs (expect exactly 3 rows -- one per RPC):
select p.proname from pg_proc p
  cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid = a.grantee
 where p.oid in ('public.open_sync_cycle(text, date, timestamptz, text)'::regprocedure,
   'public.claim_sync_cycle(uuid)'::regprocedure,'public.claim_source_export_attempt(uuid, text)'::regprocedure)
   and a.privilege_type = 'EXECUTE' and r.rolname = 'service_role'
 order by p.proname;

-- G10) every Scheduler-v2 DATA table is EMPTY (expect 0 for all five)
select (select count(*) from public.sync_cycles) as sync_cycles,
       (select count(*) from public.sync_source_jobs) as sync_source_jobs,
       (select count(*) from public.sync_report_jobs) as sync_report_jobs,
       (select count(*) from public.sync_source_job_owners) as sync_source_job_owners,
       (select count(*) from public.ads_sync_coverage) as ads_sync_coverage;

-- G11) exactly 13 report controls, all paused, no duplicate keys
select count(*) as total, count(*) filter (where schedule_enabled) as enabled, count(distinct report_key) as distinct_keys
  from public.report_sync_settings;  -- expect total=13, enabled=0, distinct_keys=13

-- G12) exactly the three expected RPCs exist; and pg_cron presence (single, unconditional, branch-free check)
select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and proname in ('open_sync_cycle','claim_sync_cycle','claim_source_export_attempt') order by proname;  -- expect these 3
select to_regclass('cron.job') as cron_job;  -- expect NULL (pg_cron not installed -> no schedule can exist)

rollback;  -- read-only transaction: no write occurred; release the snapshot. Always runs (no branch above it).
```

If — and only if — G12 returns a **non-NULL** `cron_job` (i.e. `pg_cron` is installed), run this SEPARATE
read-only follow-up **outside** the transaction above (it is also a plain SELECT; it is kept out of the fixed
`begin … rollback` block precisely so that block stays branch-free and always rolls back):

```sql
select jobid, jobname, schedule from cron.job where jobname ilike '%sync%' or command ilike '%sync%';  -- expect 0 rows; any row => STOP
```

### J.2 Offline checks (no production connection)

- Re-run the **offline** `schedulerV2Preflight(...)` against the **committed** migrations + `supabase.js`
  wrappers (the same static audit as Gate 0, Appendix A): require `ready:true` and `blockers:[]`. This reads
  files only — no database, no DataDoe, no secret.
- Confirm `SCHEDULER_V2_READY_REPORT_KEYS` is still `Object.freeze([])` (empty). Both gates remain closed: the
  durable controls are paused (G11) **and** the code allowlist is empty.

### J.3 STOP conditions (Gate 2)

**STOP (report; make NO change) if:** any of the six tables is absent (G1); any ledger filename ≠ exactly one row
(G2); any table's column set / type / nullability / default differs from V1/W1/X1/Y1 or the counts ≠
18/27/25/8/4/15 (G3); any named constraint is missing / renamed / redefined vs V2-3 / W2-3 / X2-4 / Y2-5 (G4);
any expected index missing or an unexpected extra index present (G5); any touch trigger missing / disabled / not
`BEFORE UPDATE` / not `touch_updated_at()`, or a trigger present on `report_sync_settings` (G6); any table's RLS
not enabled (G7); ≠ 5 policies, or any policy not SELECT / not authenticated-only / missing `is_dashboard_admin()`
/ with a WITH CHECK, or any policy on `ads_sync_coverage` (G8); any RPC identity / return / `security_definer` /
`search_path=public` mismatch (G9a); **any** row from the forbidden-grantee ACL query or fewer than 3 service_role
rows (G9b); any of the five data tables non-empty (G10); ≠ 13 paused controls or a duplicate key (G11); the RPC
set ≠ exactly the three, or any `cron.job` sync entry (G12); the offline preflight not `ready:true` with
`blockers:[]`, or `SCHEDULER_V2_READY_REPORT_KEYS` non-empty (J.2).
- Gate 2 makes **no** repair, write, schema change, or DataDoe call. A mismatch is investigated separately; the
  applied schema is **not** altered or rolled back.
- Do **NOT** proceed to the canary (Gate 5), any control unlock (Gate 7), deployment, push, merge, or the
  `pg_cron` kickoff. Stop for Codex review + explicit human approval.

---

## Appendix K — Gate 2 EXECUTION evidence (read-only re-verification, 2026-08-13)

Executed with explicit human approval, from `feature/scheduler-v2` @ `8dcd535`, running Appendix J exactly.
Connected to production Supabase over the configured `POSTGRES_URL` (`sslmode=no-verify`) loaded from untracked
`.env.local` and never printed (the connection string is NOT committed). **Read-only only** — J.1 ran inside a
single `begin; set transaction read only; … rollback;` transaction (only SELECT / catalog reads); **zero writes,
zero repairs, zero DataDoe calls/exports, no control/schedule change.**

**Preflight:** HEAD includes `8dcd535`; all seven Gate 0 hashes match; `SCHEDULER_V2_READY_REPORT_KEYS` length 0.

**J.1 read-only transaction (G1–G12) — ALL PASS:**
- G1 all six tables present (`sync_cycles`, `sync_source_jobs`, `sync_report_jobs`, `ads_sync_coverage`,
  `report_sync_settings`, `sync_source_job_owners`). G2 the four ledger rows each exactly once.
- G3 exact columns per table (counts 18 / 27 / 25 / 8 / 4 / 15; ordered names match V1/W1/X1/Y1).
- G4 every named constraint reproduced: uniques (`sync_cycles_bucket_date_unique`,
  `sync_source_jobs_cycle_hash_unique`, `sync_report_jobs_cycle_report_account_unique`,
  `sync_source_job_owners_unique`); FKs with `ON DELETE` (the three `cycle_id → sync_cycles(id)` CASCADE;
  `sync_source_job_owners_source_fk (cycle_id, request_hash) → sync_source_jobs` CASCADE;
  `sync_cycles.created_by → auth.users(id)` SET NULL); CHECKs (`sync_source_jobs_one_attempt`;
  `report_sync_settings_key_nonempty`; `ads_sync_coverage` status='succeeded'; `sync_source_job_owners`
  owner_status active|stale, connection_id primary|dd-secondary, identity_nonempty 5-field AND).
- G5 exact index set per table (explicit indexes + each PK/unique index; no unexpected extras). G6 the five touch
  triggers enabled (`O`), `BEFORE UPDATE`, `touch_updated_at()`; `report_sync_settings` has none. G7 RLS enabled
  on all six.
- G8 exactly 5 policies (one each on sync_cycles / sync_source_jobs / sync_report_jobs / report_sync_settings /
  sync_source_job_owners), each SELECT / `authenticated` only / `USING is_dashboard_admin()` / no WITH CHECK;
  `ads_sync_coverage` has ZERO policies.
- G9a the three RPC identities/returns exact, `prosecdef=true`, `proconfig={search_path=public}`. G9b hardened
  ACL: **no** EXECUTE grantee other than the owner (inherent) or `service_role` — PUBLIC / anon / authenticated /
  arbitrary roles all absent (0 rows); `service_role` holds EXECUTE on all three (3 rows).
- G10 the five operational/data tables all empty. G11 exactly 13 controls, all `schedule_enabled=false`,
  distinct_keys=13. G12 exactly the three RPCs; `cron.job` absent (`pg_cron` not installed) → no schedule (the
  documented cron follow-up was not needed).

**J.2 offline (no production connection):** `schedulerV2Preflight(...)` against the committed migrations +
`supabase.js` (fetch-trapped) returned **`ready:true`, `blockers:[]`**; `SCHEDULER_V2_READY_REPORT_KEYS` remains
`Object.freeze([])` (empty). Both gates stay closed: durable controls paused **and** the code allowlist empty.

**Result:** every Gate 2 check passed; the applied schema (migrations 1–4) matches the contract and was **not**
altered or rolled back. All seven Gate 0 hashes remain byte-unchanged; no code changed; no deployment/push/merge.
Scheduler v1 / frontend / routes / cron untouched.

**STOP** — do not run a canary (Gate 5), unlock a report or enable a durable control (Gate 7), deploy, push,
merge, or create a schedule / apply the `pg_cron` kickoff. Stop for Codex review.

---

## Appendix L — Gate 5 one-account shadow canary (EXECUTED 2026-08-14 — SUCCESS)

> **EXECUTED 2026-08-14 with explicit approval** for **exactly ONE primary account and ONE report
> (`brand-sales`)**, then STOPPED. Made the FIRST live DataDoe exports (exactly TWO — one Order Line Items, one
> Product Catalog `68d2de238e`) + a single `scheduler-v2/brand-sales` shadow snapshot — **only** into
> Scheduler-v2 tables and the `scheduler-v2/*` shadow namespace, never a production `report_snapshots` row and
> never a control/schedule change. No route, cron, deployment, frontend, or scheduled invocation was involved.
> The safe evidence is in Appendix L.8 (and PROJECT_MEMORY.md). The procedure below (L.1–L.7) is the exact
> package that was run.

### L.1 Scope + report choice + prerequisites

- **Exactly one primary DataDoe account** and **exactly one report: `brand-sales`** (a generic single-shot;
  its two canonical source contracts are `order-line-items` and `product-catalog`).
- **Hard prerequisite:** the chosen account has a **current production Brand Sales snapshot** (`report_snapshots`
  under `report_key='brand-sales'`) for later Gate 6 parity. If absent, STOP (pick another account).
- **Product Catalog usability is ADVISORY EVIDENCE, not a start gate (Codex correction).** DataDoe has confirmed
  Product Catalog is an **organization-wide, API-exportable** dataset (Appendix M; DataDoe ignores
  `sellerOrVendorIds`, downloads for different accounts are byte-identical), and the source worker **never**
  consults `source_export_cache` to skip a create-export. So a **missing or EXPIRED** pre-existing catalog cache
  for the plan-derived `request_hash` must **NOT** block starting Gate 5 — requiring a *current* entry would
  force an extra warm-up export outside the approved two-export budget. Record, for the evidence, whether a
  **current** exact-hash catalog cache exists and (if so) that it is usable (`source_id === '68d2de238e'`,
  `rows.length === row_count`, `0 < rows.length < limit`, ≥ 1 non-blank `child_asin` → `product_brand`), via
  `rt.sourceRowLoader()` on the plan-derived catalog `request_hash` — but treat `absent` / `current-usable` /
  `current-unusable` as **advisory** and proceed either way. The catalog cache is keyed by the exact canonical
  request identity (short source id `68d2de238e`, the contract's columns incl. `child_asin`/`product_brand`, and
  the planner's window/scope); the seller id inside it is a cache-key artifact, not a data scope (Order Line
  Items remains genuinely seller-scoped). The long id
  `68d2de238e8d1a47bc56a981a99d54558507b0bafb1e09f1b3e95fb7750a17a8` is the **obsolete (DataDoe-404)** alias and
  must **never** be used.
- **The authoritative catalog integrity guarantee is the fresh export at final drain (L.5), NOT the cache.** The
  canary's own catalog export must succeed with `create_export_count === 1` and **non-cap-sized** rows the
  derive can use. If that fresh catalog export **fails / is empty / malformed / cap-sized / unavailable**: no
  shadow snapshot is saved, production/LKG data is preserved, and the run STOPS with the typed failure — **no
  retry and no third export** (strict `strict:true` + the final-drain guard enforce this).
- Product Catalog **incremental ASIN-brand gap-fill remains OUT OF SCOPE** for this canary.

### L.2 Control isolation (no control/allowlist/settings change)

- Do **NOT** edit `SCHEDULER_V2_READY_REPORT_KEYS`. Do **NOT** change `report_sync_settings`.
- Unlock `brand-sales` for the canary **only** by injecting a one-report control catalog at
  `buildSchedulerV2Runtime` **construction**: `controlCatalog: () => [{ reportKey: 'brand-sales', ready: true,
  scheduleEnabled: false }]`. This is scoped to the constructed runtime instance and touches neither the durable
  rows nor the code allowlist.
- Drive the run with `manualReportKeys: ['brand-sales']` (a MANUAL, readiness-gated run).
- Restrict `connections` to the **configured primary connection only** (`id === 'primary'` with an `apiKey`);
  fail closed unless exactly one is configured. Never route a `dd-secondary:` account through the primary key.
- Inject `fetchAccounts` so it validates it received the **selected primary `apiKey`** and returns **exactly the
  one real discovered account** from the single memoized discovery snapshot (L.5) — no second network call, no
  fabricated record, no `dd-secondary` fallback.
- The snapshot saver: `buildSchedulerV2Runtime` accepts a **`makeShadowSnapshotSaver` FACTORY** override; its
  **default factory** constructs the trusted `saveSnapshot` collaborator, which writes **only** under
  `scheduler-v2/<reportKey>`. `saveSnapshot` itself is NOT a per-construction override — **keep the default
  factory** for the canary (do not override `makeShadowSnapshotSaver`).

### L.3 Budget (cumulative, ≤ 2 create-exports)

- `brand-sales` has at most **two** canonical source request hashes (`order-line-items`, `product-catalog`), so
  set **`maxJobs: 2`** and, per slice, a fresh explicit wall-clock **`deadlineMs`** + **`reserveMs`** reserve.
- Permit **bounded continuation slices only on the SAME `(bucket, cycleDate)`** (a fresh `rt.run(...)` resumes
  from persisted state; the DB one-attempt guard `claim_source_export_attempt` + the `sync_source_jobs_one_attempt`
  CHECK guarantee **≤ 1 create-export per `request_hash` per cycle**, so no duplicate export across slices).
- **The authoritative create-export / token count is the DB `create_export_count`**, NOT `rollup.spent` (which is
  *processed job work* — jobs advanced, not exports created). After **every** slice and **before** any
  continuation, read `rt.store.listSourceJobs(rollup.cycleId)` and require: **≤ 2** canonical source rows whose
  `request_hash`es are **exactly the two plan-derived hashes** (not merely allowed source keys), each matched to
  its plan source's `source_key` / `source_id` / `connection_id='primary'` / `organization_fingerprint` /
  `account_scope_hash`; each `create_export_count ∈ {0, 1}`; and **`sum(create_export_count) ≤ 2`**. Also read
  `rt.store.listSourceJobOwners(cycleId, [ownerId])` (the deterministic plan-derived owner id) and require the
  **two owner rows** carry the exact `request_key → request_hash` mapping, `owner_status='active'`,
  `report_key='brand-sales'`, the selected account, and `connection_id='primary'`. Throw immediately on any
  mismatch (STOP — do not run another slice). `create_export_count = 0` on a row is only ever a **mid-drain
  partial/failed-slice state** (a job not yet attempted this cycle) — the pre-existing catalog
  `source_export_cache` entry is a **usability prerequisite (L.1), never a pre-export shortcut**, and the worker
  never skips a create-export because of it. So mid-drain the total may be **≤ 2**, but after a SUCCESSFUL fresh
  drained canary (saved shadow snapshot) the final state must be **exactly two** succeeded source rows with
  `create_export_count === 1` each — the L.5 final-drain guard enforces this.

### L.4 Before-canary read-only evidence (run + RECORD first; STOP on any failure)

- Re-run offline `schedulerV2Preflight(...)` → require `ready:true`, `blockers:[]`.
- Confirm all **13** durable `report_sync_settings` rows remain `schedule_enabled=false`; `SCHEDULER_V2_READY_REPORT_KEYS`
  is empty; the five Scheduler-v2 operational tables (`sync_cycles`, `sync_source_jobs`, `sync_report_jobs`,
  `sync_source_job_owners`, `ads_sync_coverage`) are empty; no `cron.job` sync schedule (Appendix J G1–G12 / J.2
  cover all of these — re-run them read-only).
- Record (safe fields only): the chosen **public account `id`**, its raw seller scope, **country**, derived
  **bucket** (`bucketForCountry(country)` — must equal the `bucket` passed to `run`), **currency**, **`asOf`**
  (marketplace-local latest data date), and a unique reviewed **`cycleDate`**.
- The canonical `brand-sales` product-catalog usability is **RECORDED (advisory)** in-script (L.5) from the
  **plan-derived** catalog `request_hash` via `rt.sourceRowLoader()` — classified `absent` (missing OR expired),
  `current-usable` (`source_id === '68d2de238e'`, `rows.length === row_count`, `0 < rows.length < limit`, ≥ 1
  non-blank `child_asin`/`product_brand`; never printed), or `current-unusable`. This is **advisory only and
  does NOT gate the run**: a missing/expired/unusable pre-existing cache does not stop Gate 5 (the source worker
  creates a fresh catalog export). There is no manual `<PC_REQUEST_HASH>` substitution.
- Here (read-only, no payload exposed) capture the existing production Brand Sales snapshot identity, prove there
  are **zero** pre-existing `scheduler-v2/*` shadow snapshots (this is the FIRST canary), and take the payload-free
  production fingerprint. Committed columns (`report_snapshots`: `id, report_key, account_id, params_hash, params,
  payload, payload_storage_path, payload_bytes, source_refreshed_at, created_at, updated_at`):
  ```sql
  -- (b) existing production brand-sales snapshot IDENTITY for the account (real columns; no payload) -- for parity.
  select id, report_key, account_id, params_hash, payload_storage_path, payload_bytes,
         source_refreshed_at, created_at, updated_at
    from public.report_snapshots
   where report_key = 'brand-sales' and account_id = '<SELECTED_ACCOUNT_ID>'
   order by updated_at desc limit 5;

  -- (c) production (non-shadow) snapshot FINGERPRINT for the account -- payload-free + deterministic. Run this
  --     query IDENTICALLY before (here) and after (L.6 P5) and require the two results are byte-identical.
  select count(*) as snapshot_rows,
         md5(coalesce(string_agg(
           id::text || '|' || params_hash || '|' || md5(coalesce(payload::text, '')) || '|' ||
           coalesce(payload_storage_path, '') || '|' || payload_bytes::text || '|' ||
           source_refreshed_at::text || '|' || created_at::text || '|' || updated_at::text,
           chr(10) order by id), '')) as production_fingerprint
    from public.report_snapshots
   where report_key not like 'scheduler-v2/%' and account_id = '<SELECTED_ACCOUNT_ID>';

  -- (d) ZERO pre-existing scheduler-v2/* shadow snapshots GLOBALLY for this FIRST canary (expect 0; else STOP).
  select count(*) as shadow_snapshots from public.report_snapshots where report_key like 'scheduler-v2/%';
  ```

### L.5 Execution script (current runtime API; secrets from untracked env; snapshots shadow-only)

Run from `sales-dashboard-live/`. Secrets (`POSTGRES_URL`, `DATADOE_API_KEY`, `SUPABASE_*`) come **only** from the
untracked local environment / `.env.local` and are **never printed**. Uses the exact current constructor + `run`
argument names. The `makeShadowSnapshotSaver` factory is left at its default, so the trusted `saveSnapshot`
collaborator writes **only** under `scheduler-v2/<reportKey>` (`scheduler-v2/brand-sales`).

```js
// Gate 5 canary — ONE primary account, ONE report (brand-sales). Live DataDoe export + Supabase write into
// Scheduler-v2 tables + scheduler-v2/* snapshots ONLY. No route/cron/frontend/deploy/schedule.
// The guard logic below is covered by the deterministic offline self-check scripts/gate5-canary-package.test.js.
import { buildSchedulerV2Runtime } from "./lib/server/sync/runtime-composition.js";
import { fetchAccounts as realFetchAccounts } from "./lib/server/datadoe.js";
import { getDataDoeConnections } from "./lib/server/datadoe-connections.js";
import { bucketForCountry } from "./lib/server/sync/registry.js";        // bucket derivation ('us' | 'non-us')
import { planBrandSales } from "./lib/server/sync/report-planner.js";    // pure/offline canonical brand-sales plan
import { sourceJobOwnerId } from "./lib/server/source-identity.js";      // deterministic owner id (org/scope-scoped)
import { addDaysStr, monthStartStr } from "./lib/server/date-windows.js"; // pin the exact live brand-sales window

const SELECTED_ACCOUNT_ID = "<REVIEWED_PRIMARY_ACCOUNT_ID>";
const CYCLE_DATE = "<UNIQUE_REVIEWED_YYYY-MM-DD>";   // a unique reviewed cycle date (never a real scheduled one)
const AS_OF = "<YYYY-MM-DD>";                         // marketplace-local latest data date for the account
const norm = (s) => String(s ?? "").trim();

// primary-only connection; fail closed unless exactly one configured primary key
const conns = (getDataDoeConnections() || []).filter((c) => c && c.id === "primary" && norm(c.apiKey));
if (conns.length !== 1) throw new Error("canary: expected exactly one configured primary connection (fail closed)");
const PRIMARY_API_KEY = conns[0].apiKey;

// ONE real primary discovery, MEMOIZED -- account, bucket, plan, and the injected fetchAccounts all use this one
// snapshot (no second network discovery).
let discoveryPromise = null;
const discoverOnce = () => (discoveryPromise ??= realFetchAccounts(PRIMARY_API_KEY));
const directory = (await discoverOnce()) || [];
const selectedAccts = directory.filter((a) => a && a.id === SELECTED_ACCOUNT_ID);
if (selectedAccts.length !== 1) throw new Error(`canary: expected exactly one discovered primary account for ${SELECTED_ACCOUNT_ID}; got ${selectedAccts.length} (fail closed)`);
const account = selectedAccts[0];
const BUCKET = bucketForCountry(account.country);
if (BUCKET !== "us" && BUCKET !== "non-us") throw new Error("canary: could not derive a valid bucket (fail closed)");

// PLAN (pure/offline) the exact two brand-sales sources against the SAME discovered account + AS_OF, and
// INDEPENDENTLY pin every critical property before anything runs: plan.accountId, the exact seller scope
// (the primary PUBLIC account id IS the raw seller id -- publicAccountId), BOTH windows exactly
// [addDaysStr(monthStartStr(AS_OF), -420), AS_OF], strict === true, the EXACT source ids for BOTH sources,
// limits, connection, bucket, hashes, org fingerprint, account-scope hash. NOTE: the catalog's seller id is
// pinned as part of the CURRENT canonical request identity (a cache-key fact) -- the catalog DATASET itself
// is organization-wide (Appendix M; DataDoe ignores sellerOrVendorIds for it). Order Line Items is genuinely
// seller-scoped.
const plan = planBrandSales({ accountId: account.id, country: account.country, currency: account.currency, connections: conns, asOf: AS_OF });
if (plan.reportKey !== "brand-sales" || (plan.sources || []).length !== 2) throw new Error("canary: brand-sales plan did not yield exactly two sources (fail closed)");
if (plan.accountId !== SELECTED_ACCOUNT_ID) throw new Error(`canary: plan accountId ${plan.accountId} != ${SELECTED_ACCOUNT_ID} (fail closed)`);
const byKey = new Map(plan.sources.map((s) => [s.requestKey, s]));
if (byKey.size !== 2) throw new Error("canary: plan has a duplicate requestKey (fail closed)");
const EXPECT_FROM = addDaysStr(monthStartStr(AS_OF), -420);   // the exact live brand-sales window start
const EXPECT = { "brand-sales:order-lines": { sourceKey: "order-line-items", sourceId: "89b27535d27c2a94db5ae39af4717f542624ff4df7802fd633e16c78674a1778", limit: 50000 },
                 "brand-sales:catalog":     { sourceKey: "product-catalog", sourceId: "68d2de238e", limit: 10000 } };
for (const [rk, exp] of Object.entries(EXPECT)) {
  const s = byKey.get(rk);
  if (!s) throw new Error(`canary: plan missing ${rk} (fail closed)`);
  if (s.sourceKey !== exp.sourceKey) throw new Error(`canary: ${rk} sourceKey ${s.sourceKey} != ${exp.sourceKey}`);
  if (s.sourceId !== exp.sourceId) throw new Error(`canary: ${rk} sourceId ${s.sourceId} != ${exp.sourceId} (catalog: never the obsolete long id)`);
  if (s.limit !== exp.limit) throw new Error(`canary: ${rk} limit ${s.limit} != ${exp.limit}`);
  if (s.connectionId !== "primary") throw new Error(`canary: ${rk} connectionId ${s.connectionId} != primary`);
  if (s.bucket !== BUCKET) throw new Error(`canary: ${rk} bucket ${s.bucket} != ${BUCKET}`);
  if (s.strict !== true) throw new Error(`canary: ${rk} strict ${s.strict} != true`);
  if (!norm(s.requestHash) || !norm(s.organizationFingerprint) || !norm(s.accountScopeHash)) throw new Error(`canary: ${rk} missing hash/org/scope`);
  if (!norm(s.from) || !norm(s.to) || s.from > s.to) throw new Error(`canary: ${rk} invalid window ${s.from}..${s.to}`);
  if (s.from !== EXPECT_FROM || s.to !== AS_OF) throw new Error(`canary: ${rk} window ${s.from}..${s.to} != expected ${EXPECT_FROM}..${AS_OF}`);
  if (!(Array.isArray(s.sellerOrVendorIds) && s.sellerOrVendorIds.length === 1 && s.sellerOrVendorIds[0] === SELECTED_ACCOUNT_ID)) throw new Error(`canary: ${rk} seller scope != [${SELECTED_ACCOUNT_ID}]`);
}
if (plan.sources[0].requestHash === plan.sources[1].requestHash) throw new Error("canary: the two sources share a request_hash (fail closed)");
const expectByHash = new Map(plan.sources.map((s) => [s.requestHash, s]));
const OWNER_IDS = [...new Set(plan.sources.map((s) => sourceJobOwnerId({ reportKey: "brand-sales", connectionId: s.connectionId, organizationFingerprint: s.organizationFingerprint, accountScopeHash: s.accountScopeHash })).filter(Boolean))];
// Both sources share connection/org/scope, so EXACTLY ONE nonblank deterministic owner id must survive the
// dedupe (sourceJobOwnerId returns null on any blank input -- a blank org/scope fails closed here rather
// than silently widening the owner query).
if (OWNER_IDS.length !== 1 || !norm(OWNER_IDS[0])) throw new Error(`canary: expected exactly one nonblank plan-derived owner id, got ${OWNER_IDS.length} (fail closed)`);
const EXPECTED_OWNER_ID = OWNER_IDS[0];

const rt = buildSchedulerV2Runtime({
  connections: conns,                                                       // primary-only; never dd-secondary
  controlCatalog: () => [{ reportKey: "brand-sales", ready: true, scheduleEnabled: false }], // instance-scoped unlock
  fetchAccounts: async (apiKey) => {
    if (apiKey !== PRIMARY_API_KEY) throw new Error("canary: fetchAccounts called with a non-primary apiKey (fail closed)");
    const all = (await discoverOnce()) || [];                              // SAME memoized snapshot -- no 2nd call
    const match = all.filter((a) => a && a.id === SELECTED_ACCOUNT_ID);    // exactly the one real discovered account
    if (match.length !== 1) throw new Error(`canary: expected exactly one matching primary account; got ${match.length} (fail closed)`);
    return match;                                                          // never fabricated; never dd-secondary
  },
  // makeShadowSnapshotSaver is a FACTORY override; leaving it default => trusted saveSnapshot writes ONLY under
  // scheduler-v2/<reportKey>. We keep the default factory (do NOT override it here).
});

// PRE-EXECUTION catalog usability -- ADVISORY EVIDENCE ONLY (Codex correction). The EXACT plan-derived catalog
// request, via rt.sourceRowLoader() (cache-only; returns null for a MISSING or EXPIRED entry). NEVER prints rows
// or secrets. A missing/expired/unusable cache does NOT stop Gate 5 -- the source worker creates its own fresh
// catalog export. We only RECORD the evidence classification; the authoritative catalog integrity check is the
// final-drain guard (a real fresh export with create_export_count === 1 and non-cap-sized rows).
const catalog = byKey.get("brand-sales:catalog");
const cache = await rt.sourceRowLoader(catalog.requestHash);              // { ..., source_id, row_count, rows } | null
let catalogEvidence = "absent";                                          // "absent" | "current-usable" | "current-unusable"
if (cache) {
  const rows = cache.rows;
  const usable = cache.source_id === "68d2de238e" && Array.isArray(rows) && rows.length === cache.row_count
    && rows.length > 0 && rows.length < catalog.limit
    && rows.some((r) => r && norm(r.child_asin) !== "" && norm(r.product_brand) !== "");
  catalogEvidence = usable ? "current-usable" : "current-unusable";
}
// (record catalogEvidence for the evidence log; do NOT throw on absent/expired/unusable -- advisory only)

// bounded continuation on the SAME (bucket, cycleDate). ONE overall deadline; EACH slice deadline is CLAMPED to it
// with Math.min; STOP before starting a slice when < reserveMs remains (never busy-loop).
const RESERVE_MS = 5_000;
const OVERALL_DEADLINE_MS = Date.now() + 15 * 60_000;   // one explicit overall canary budget
const MAX_SLICES = 8;
let slices = 0, rollup = null;
do {
  if (OVERALL_DEADLINE_MS - Date.now() < RESERVE_MS) throw new Error("canary: overall deadline reached (< reserveMs) before drain (STOP; do not busy-loop)");
  if (++slices > MAX_SLICES) throw new Error("canary: too many continuation slices (fail closed)");
  const sliceDeadlineMs = Math.min(Date.now() + 90_000, OVERALL_DEADLINE_MS);   // FRESH, clamped to the overall deadline
  rollup = await rt.run({
    bucket: BUCKET, cycleDate: CYCLE_DATE, asOf: AS_OF,
    manualReportKeys: ["brand-sales"], maxJobs: 2,
    deadlineMs: sliceDeadlineMs, reserveMs: RESERVE_MS, trigger: "manual",
  });
  // AUTHORITATIVE between-slice guard (read-only): the DB create_export_count -- NOT rollup.spent (processed work).
  // Require exactly the two PLAN-DERIVED request hashes (not merely allowed source keys), each matched to its plan
  // source's source_key / source_id / primary connection / org fingerprint / account-scope hash. Mid-drain a
  // create_export_count of 0 means the job has NOT been attempted yet (partial slice) -- never "cache reuse";
  // the final-drain guard below still requires exactly 1 per hash on success.
  const jobs = (await rt.store.listSourceJobs(rollup.cycleId)) || [];
  if (jobs.length > 2) throw new Error(`canary: >2 canonical source jobs (${jobs.length}) -- STOP`);
  let totalExports = 0; const seen = new Set();
  for (const j of jobs) {
    const exp = expectByHash.get(j.request_hash);
    if (!exp) throw new Error("canary: source row with a request_hash that is not one of the two plan hashes -- STOP");
    if (seen.has(j.request_hash)) throw new Error("canary: duplicate source row for a request_hash -- STOP");
    seen.add(j.request_hash);
    if (j.source_key !== exp.sourceKey || j.source_id !== exp.sourceId) throw new Error(`canary: source_key/source_id mismatch for ${exp.requestKey} -- STOP`);
    if (j.connection_id !== "primary") throw new Error(`canary: source connection_id ${j.connection_id} != primary -- STOP`);
    if (j.organization_fingerprint !== exp.organizationFingerprint || j.account_scope_hash !== exp.accountScopeHash) throw new Error(`canary: source org/scope mismatch for ${exp.requestKey} -- STOP`);
    const n = j.create_export_count ?? 0;
    if (n !== 0 && n !== 1) throw new Error(`canary: create_export_count ${n} not in {0,1} -- STOP`);
    totalExports += n;
  }
  if (totalExports > 2) throw new Error(`canary: total create-exports ${totalExports} > 2 -- STOP`);
  // Owner rows for THIS cycle (deterministic owner ids from the plan): the two exact request_key -> request_hash
  // mappings, active / brand-sales / selected account / primary. (Both sources share ONE owner_id.)
  const owners = (await rt.store.listSourceJobOwners(rollup.cycleId, OWNER_IDS)) || [];
  if (jobs.length > 0 && owners.length !== 2) throw new Error(`canary: expected exactly 2 owner rows, got ${owners.length} -- STOP`);
  const ownerExpect = new Map(plan.sources.map((s) => [s.requestKey, s.requestHash]));
  for (const o of owners) {
    if (!norm(o.owner_id) || o.owner_id !== EXPECTED_OWNER_ID) throw new Error("canary: owner row owner_id is not the plan-derived owner id -- STOP");
    if (o.owner_status !== "active" || o.report_key !== "brand-sales" || o.account_id !== SELECTED_ACCOUNT_ID || o.connection_id !== "primary") throw new Error("canary: owner row not active / brand-sales / selected account / primary -- STOP");
    if (ownerExpect.get(o.request_key) !== o.request_hash) throw new Error(`canary: owner request_key -> request_hash mapping mismatch for ${o.request_key} -- STOP`);
  }
} while (rollup && rollup.continuationRequired);
// FINAL-DRAIN guard (executable): the pre-existing catalog source_export_cache entry is USABILITY EVIDENCE
// only (L.1) -- the source worker NEVER skips create-export because of it -- so a SUCCESSFUL fresh drained
// canary ends with EXACTLY two source rows (the two plan hashes), each fetch_status='succeeded' and
// create_export_count === 1. A 0-export or non-succeeded row here means the drain did NOT fully succeed
// (create_export_count=0 is only ever a mid-drain not-yet-attempted state, never "cache reuse"): STOP.
const finalJobs = (await rt.store.listSourceJobs(rollup.cycleId)) || [];
if (finalJobs.length !== 2) throw new Error(`canary: final state has ${finalJobs.length} source jobs, expected exactly 2 -- STOP`);
for (const s of plan.sources) if (!finalJobs.some((j) => j.request_hash === s.requestHash)) throw new Error(`canary: final state missing source row for ${s.requestKey} -- STOP`);
for (const j of finalJobs) {
  const exp = expectByHash.get(j.request_hash);
  if (!exp) throw new Error("canary: final source row carries a non-plan request_hash -- STOP");
  if (j.fetch_status !== "succeeded") throw new Error(`canary: final ${exp.requestKey} fetch_status ${j.fetch_status} != succeeded -- STOP`);
  if ((j.create_export_count ?? 0) !== 1) throw new Error(`canary: final ${exp.requestKey} create_export_count ${j.create_export_count ?? 0} != 1 -- STOP`);
}
// Then: exactly one report job + one shadow snapshot (L.6 P6/P7); production fingerprint unchanged (L.4 (c)
// vs L.6 P5). Record safe fields only.
// rollup = { cycleId, selected, accountsDispatched, spent (PROCESSED job work, NOT exports), maxJobs, drained,
//            continuationRequired, perUnit, reports }.
```

### L.6 Post-canary read-only checks (record safe fields only; no repair)

`sync_source_jobs` has **no `account_id`** column; source-account isolation is verified by joining
`sync_source_jobs` to `sync_source_job_owners` on `(cycle_id, request_hash)`. `sync_report_jobs.account_id`
exists and is checked separately.

```sql
-- P1) exactly ONE sync_cycles row for the reviewed bucket/cycleDate (expect 1)
select id, bucket, cycle_date, status, source_total, source_succeeded, source_failed
  from public.sync_cycles where bucket = '<BUCKET>' and cycle_date = '<CYCLE_DATE>';

-- P2) SOURCE isolation via the owner join (sync_source_jobs has NO account_id). Expect ZERO rows from each:
-- (i) any source row with NO owner membership (ownerless) -- fail
select s.request_hash, s.source_key from public.sync_source_jobs s
 where s.cycle_id = '<CYCLE_ID>'
   and not exists (select 1 from public.sync_source_job_owners o
                    where o.cycle_id = s.cycle_id and o.request_hash = s.request_hash);
-- (ii) any owner membership that is NOT active / brand-sales / selected account / primary / matching scope -- fail
select o.request_hash, o.owner_status, o.report_key, o.account_id, o.connection_id
  from public.sync_source_job_owners o
  join public.sync_source_jobs s on s.cycle_id = o.cycle_id and s.request_hash = o.request_hash
 where o.cycle_id = '<CYCLE_ID>'
   and ( o.owner_status <> 'active'
      or o.report_key <> 'brand-sales'
      or o.account_id <> '<SELECTED_ACCOUNT_ID>'
      or o.connection_id <> 'primary'
      or o.organization_fingerprint is distinct from s.organization_fingerprint
      or o.account_scope_hash is distinct from s.account_scope_hash );
-- (iii) any owner account_id other than the selected one (additional account) -- fail
select distinct o.account_id from public.sync_source_job_owners o
 where o.cycle_id = '<CYCLE_ID>' and o.account_id <> '<SELECTED_ACCOUNT_ID>';
-- (iv) sync_report_jobs.account_id (this table HAS account_id) -- only the selected account (fail otherwise)
select distinct account_id from public.sync_report_jobs
 where cycle_id = '<CYCLE_ID>' and account_id <> '<SELECTED_ACCOUNT_ID>';

-- P3) SUCCESSFUL drained canary: EXACTLY two canonical source jobs (the two plan hashes), each
--     fetch_status='succeeded' and create_export_count = 1 (the pre-existing catalog cache is a usability
--     prerequisite, never a pre-export shortcut). A stopped/partial/failed run may instead show fewer rows,
--     a non-succeeded status, or create_export_count = 0 on a not-yet-attempted job -- record + STOP (L.7).
--     (sync_source_jobs columns: request_hash, source_key, fetch_status, create_export_count, terminal, error_code)
select request_hash, source_key, fetch_status, create_export_count, terminal, error_code
  from public.sync_source_jobs where cycle_id = '<CYCLE_ID>' order by source_key;  -- success: exactly 2 rows, each succeeded with create_export_count = 1
select coalesce(sum(create_export_count),0) as total_exports,
       coalesce(max(create_export_count),0) as max_per_hash
  from public.sync_source_jobs where cycle_id = '<CYCLE_ID>';  -- success: total_exports = 2, max_per_hash = 1 (partial/stopped: <= 2 / <= 1; never more)

-- P4) owner memberships snapshot for the record (all rows expected active / primary / selected account)
select owner_status, connection_id, account_id, report_key, error_code
  from public.sync_source_job_owners where cycle_id = '<CYCLE_ID>';

-- P5) exactly ONE scheduler-v2/brand-sales snapshot when derivation succeeded (real columns; no payload)
select id, report_key, account_id, params_hash, payload_bytes, source_refreshed_at, created_at, updated_at
  from public.report_snapshots
 where report_key = 'scheduler-v2/brand-sales' and account_id = '<SELECTED_ACCOUNT_ID>';   -- expect 1 (on success)
-- Re-run the L.4 (c) production FINGERPRINT query IDENTICALLY and require it EQUALS the before value:
select count(*) as snapshot_rows,
       md5(coalesce(string_agg(
         id::text || '|' || params_hash || '|' || md5(coalesce(payload::text, '')) || '|' ||
         coalesce(payload_storage_path, '') || '|' || payload_bytes::text || '|' ||
         source_refreshed_at::text || '|' || created_at::text || '|' || updated_at::text,
         chr(10) order by id), '')) as production_fingerprint
  from public.report_snapshots
 where report_key not like 'scheduler-v2/%' and account_id = '<SELECTED_ACCOUNT_ID>';       -- MUST equal L.4 (c)

-- P6) exactly ONE scheduler-v2/* snapshot GLOBALLY, and it is scheduler-v2/brand-sales for the selected account
select report_key, account_id from public.report_snapshots where report_key like 'scheduler-v2/%';
-- expect EXACTLY 1 row: ('scheduler-v2/brand-sales', '<SELECTED_ACCOUNT_ID>').

-- P7) exactly ONE report job: brand-sales / selected account / primary / depends_on == the two plan hashes
select report_key, account_id, connection_id, depends_on
  from public.sync_report_jobs where cycle_id = '<CYCLE_ID>';
-- expect EXACTLY 1 row: report_key='brand-sales', account_id='<SELECTED_ACCOUNT_ID>', connection_id='primary',
--   depends_on = exactly the two brand-sales request_hashes (order-lines + catalog) -- no more, no fewer.
```

Record from the returned `rollup` (safe fields only, **no secrets / no raw provider errors**): `cycleId`,
`selected`, `accountsDispatched` (must be `['<SELECTED_ACCOUNT_ID>']`), `spent` (**processed job work, not the
export count**), `drained` / `continuationRequired`, each `perUnit`, and from `rollup.reports` the per-report
shadow **status**, **latestDataDate**, and any **SAFE error code**. The **authoritative create-export / token
count** is the DB `sum(create_export_count)` from P3 (and the between-slice guard) — plus the source
`request_hash`es and per-hash `create_export_count`. Prove the before/after production snapshot fingerprints
(L.4 (c) vs P5) are **identical**.

### L.7 Stop conditions (Gate 5)

STOP immediately (safely ending any read-only transaction; make **no** repair/delete/backfill/write) on **any**
of: the `brand-sales` plan not yielding exactly the two expected sources with the exact
`requestHash`/`sourceKey`/`sourceId`/`limit`/window/org/scope; **no production brand-sales snapshot** for the
selected account (the one remaining hard prerequisite; a **missing / expired / unusable pre-existing catalog
cache does NOT stop the run** — it is advisory only); the canary's own **fresh catalog export** failing / empty
/ malformed / cap-sized (`strict:true` TRUNCATED) / unavailable, so the final drain lacks two succeeded source
rows (no shadow snapshot is saved; LKG preserved; no retry, no third export); **any pre-existing
`scheduler-v2/*` snapshot** before the run; a DB source row whose
`request_hash` is **not one of the two plan hashes**, or whose `source_key`/`source_id`/`connection_id`/
`organization_fingerprint`/`account_scope_hash` does not match its plan source; more than two create-export
attempts total (authoritative DB `sum(create_export_count)`), or a duplicate export (`create_export_count > 1`)
for a `request_hash`; a drain that finished without **exactly two succeeded** source rows carrying
`create_export_count = 1` each (the final-drain guard — a 0-export row is a not-finished job, never "cache
reuse"); an ownerless source row, an owner row whose `owner_id` is not the single plan-derived owner id, an
owner `request_key → request_hash` mapping mismatch, any additional owner or account, or a source/owner scope
mismatch; **any** account other than the selected primary
account in `sync_report_jobs` or the owner rows; any `dd-secondary` routing or a `connection_id` other than
`primary`; **not exactly one** `scheduler-v2/*` snapshot globally (or one for another account / not the shadow
key), or **not exactly one** report job (or a report job whose `depends_on ≠` the two plan hashes); any write
outside the Scheduler-v2 tables or `scheduler-v2/*` snapshots; **any** change to the non-`scheduler-v2/*`
production fingerprint (L.4 (c) vs P5); any unsafe/raw error text or a `TRUNCATED` / malformed-scope /
cross-account row; the overall canary deadline reached (**< `reserveMs` remaining**) or the slice cap reached
before drain; or any control, allowlist, or schedule change. Do **NOT** proceed to Gate 6 parity, Gate 7 unlock,
deployment, or scheduling. Stop for review + explicit human approval.

> The guard logic above (plan-source validation with the pinned account/seller-scope/exact-window/strict/
> source-id properties, the single plan-derived owner id, the **advisory** catalog-evidence classifier, per-slice
> source + owner checks, the final-drain exactly-one-export-per-hash guard, shadow/report-job checks, and the
> deadline clamp/boundary) is exercised by a **deterministic offline self-check**:
> `scripts/gate5-canary-package.test.js` (`npm run test:gate5-canary-package`; part of `npm run verify`) — it
> builds the real `planBrandSales()` output and asserts each guard passes on the correct shape and throws on a
> wrong account/seller id, both sources shifted to the same valid-but-wrong window, `strict:false`, a wrong
> Order Line Items or Product Catalog source id, wrong hashes, duplicate/missing sources, a wrong/blank/missing
> `owner_id`, pre-existing shadow rows, extra report jobs/snapshots, a final drain without exactly one
> create-export per hash, and the final-slice deadline boundary — and that an **absent/expired/unusable catalog
> cache is advisory and never blocks canary start**, while a failed/truncated/missing fresh catalog source still
> fails closed at the final drain.

### L.8 Execution evidence (EXECUTED 2026-08-14 — SUCCESS; safe fields only)

Ran from `sales-dashboard-live/` with `node --env-file=../.env.local` (secrets loaded into the process env only,
never printed/committed). Offline preflight `ready:true / blockers:[]`; 13 durable controls `schedule_enabled=false`;
`SCHEDULER_V2_READY_REPORT_KEYS` empty; the five v2 tables empty; no `cron.job` sync schedule (pg_cron absent);
zero pre-existing `scheduler-v2/*` snapshots. One primary connection configured, no secondary. Fresh live
discovery (30 primary accounts, memoized once).

- **Selected account** (exactly one): `fbd72f10-2e86-42a1-afe5-df4d93b25ede` (country DE, currency EUR, bucket
  `non-us`). **`asOf` 2026-08-13**, window `2025-06-07 .. 2026-08-13`. **`cycleDate` 2026-08-14**;
  **`cycleId` 57afc1fb-6694-4925-8961-4730f5a8f4df**.
- **Catalog evidence (advisory): `absent`** — the account's exact plan-derived catalog cache had expired ~15 min
  earlier; per the correction this did NOT block the run, and the source worker created its own fresh export.
- **Sources — exactly two, one create-export each** (`sum(create_export_count)=2`, `max_per_hash=1`):
  - `brand-sales:order-lines` (`order-line-items`): request_hash `f1270dc16e…`, `fetch_status=succeeded`,
    `create_export_count=1`, 190 rows.
  - `brand-sales:catalog` (`product-catalog`, source id `68d2de238e` — never the obsolete long id): request_hash
    `ee35b3f2e7…`, `fetch_status=succeeded`, `create_export_count=1`, 3452 rows (non-cap-sized; `< 10000`).
- **Owner memberships**: exactly two, one plan-derived `owner_id` `39d8b5b0a9…`, `owner_status=active`,
  `report_key=brand-sales`, selected account, `connection_id=primary`, exact `request_key → request_hash`
  mapping; no ownerless source row; no other account.
- **Report job**: exactly one — `brand-sales` / selected account / `primary` / `depends_on` == the two plan
  hashes (`f1270dc16e…`, `ee35b3f2e7…`), no more/fewer.
- **Shadow snapshot**: exactly one `scheduler-v2/brand-sales` for the selected account (`payload_bytes=48762`),
  and exactly one `scheduler-v2/*` snapshot globally.
- **Production isolation**: the account's non-shadow Brand Sales fingerprint is **byte-identical**
  before/after (`cba3fb264b31dd6a5c35b20e8df2ccab`, 7 snapshot rows → 7). No production `report_snapshots` row
  overwritten; no other account/report/source owner created or changed.
- **Cycle**: exactly one `sync_cycles` row for (`non-us`, `2026-08-14`, id `57afc1fb-…`) — `source_total=2`,
  `source_succeeded=2`, `source_failed=0`. **`status='running'` with `finished_at` null and report counters
  unwritten is a LIFECYCLE DEFECT (Blocker 1), NOT an acceptable terminal result:** all source/report/snapshot
  work completed and every L.6 check passed, but the dispatcher did not finalize the drained cycle. The CODE fix
  (dispatcher-owned finalization + typed disposition + complete-scope-only auto-finalize + the hardened guarded
  `finalize_sync_cycle` RPC/triggers in the PREPARED, UNAPPLIED `20260815_sync_cycle_finalize.sql`) is complete,
  but the defect is **not resolved in production** until that migration is applied via a reviewed Gate and the
  canary cycle reconciled (Appendix N). The running canary cycle stays exactly as-is until then.
  *(UPDATE 2026-08-14: both steps have since been EXECUTED — Migration 5 applied via its reviewed gate
  (Appendix O) and this cycle reconciled to `succeeded` (Appendix N.4). This paragraph is kept as the historical
  record of the state at canary time.)*

Post-canary L.6 P1–P7 all PASS. `npm run verify` (at execution time) incl. `build:check`; `git diff --check`
clean. Both readiness gates remain locked/paused; nothing pushed/merged/deployed/migrated/unlocked/scheduled.
STOP for Codex review after this single canary.

## Appendix M — Organization-wide Product Catalog: confirmed contract + reviewed design (NOT implemented)

> **Design only.** Nothing in this appendix is implemented, and NO code, contract, planner, resolver, or
> identity change is made on its basis yet. The final Product Catalog request identity is **deliberately
> unresolved** until DataDoe's follow-up answers arrive (M.3).

### M.1 Confirmed Product Catalog contract (DataDoe support + our own byte-level comparison, 2026-08-14)

1. Product Catalog is an **organization-wide dataset**: an export returns the organization's catalog
   regardless of which account requested it.
2. **`sellerOrVendorIds` is accepted but IGNORED** by DataDoe for this source.
3. **Downloaded files requested for different accounts are byte-identical.**
4. Current files contain **no `marketplace_id`** (no per-marketplace partition key in the payload).
5. **One downloaded file can seed the shared ASIN → brand map** for every account in the organization.
6. **43 blank-brand ASINs remain UNMAPPED** — an honest gap surfaced as unmapped, **never coerced to
   "Unassigned"**.

Consequences for existing docs: the earlier Gate 5 phrasing that treated the catalog request as
account-scoped DATA is corrected in Appendix L (L.1/L.4/L.5) — the seller id inside today's canonical
catalog request identity is a CURRENT-implementation **cache-key artifact only**. **Order Line Items remains
genuinely seller-scoped** (its rows carry and depend on the seller/vendor scope). The Gate 5 canary continues
to validate the EXACT identity the CURRENT planner derives; this appendix changes no canary step.

### M.2 Reviewed organization-wide Catalog design (canonical scope vs owner scope — corrected)

> **Why the correction:** the CURRENT implementation uses ONE `accountScopeHash` value for BOTH the source
> identity (`sourceRequestIdentity` hashes it into `request_hash`) AND the owner identity
> (`sourceJobOwnerId({reportKey, connectionId, organizationFingerprint, accountScopeHash})`), and the worker
> **re-derives and enforces** `owner_id` from the canonical job's scope (source-worker.js owner validation).
> If the canonical catalog scope simply became org-wide, every account's catalog `owner_id` would COLLAPSE
> into one — destroying per-account ownership. The design below separates the two scopes explicitly.

**Two distinct scopes, never conflated:**

- **Canonical source scope — ORGANIZATION-WIDE.** Used for the Product Catalog `request_hash` and the
  canonical `sync_source_jobs` metadata. ONE canonical catalog identity per organization, derived from the
  org credential (`organizationFingerprint`) + the contract's columns/limit/ordering + the final
  (M.3-confirmed) filter/window semantics — **never** from any per-account seller id. The canonical row's
  stored scope value is a typed organization-scope token (see field discussion below), identical no matter
  which account plans first.
- **Owner scope — ACCOUNT-SPECIFIC.** Used for `sourceJobOwnerId` and every `sync_source_job_owners`
  membership. Each owning report/account derives its `owner_id` from ITS OWN account scope (the account's
  raw-seller scope hash, as today), so N accounts needing the catalog produce **N distinct owner ids** and N
  membership rows — all pointing at the ONE org-wide canonical `request_hash`. **No owner-ID collapse.**

**Required contract / resolver / planner / type changes (reviewed, NOT implemented):**

- `REPORT_SOURCE_CONTRACTS` (and/or `SOURCE_CONTRACTS`): a new explicit, typed per-contract field — e.g.
  `sourceScope: "organization" | "account"` (default `"account"`, so every existing contract is untouched
  by omission). Only Product Catalog contracts would declare `"organization"`, and only at the deliberate
  cutover.
- `reportSourceRequestHashes` (resolver): for an `"organization"`-scope contract, compute the identity from
  the org fingerprint + request meta + a canonical org-scope token — NOT from the seller-id chunk — while
  **still returning the account's own scope** on the resolved source (e.g. a separate `ownerScopeHash`
  field) so owner derivation stays account-specific. The single-account safety check
  (`requiresSingleAccountSource`) continues to apply to account-scoped sources only.
- `sourceRequestIdentity` / `source-identity.js`: accept the typed scope so the org-wide identity is
  first-class (an explicit `scope:"organization"` token hashed in place of the per-account
  `accountScopeHash`) — never a fake/constant "account" hash pretending to be one.
- `sourceJobOwnerId`: derivation INPUT changes from "the canonical job's accountScopeHash" to "the OWNER's
  account scope hash" (an explicit parameter fed from the plan's account scope). For account-scoped sources
  the two values are identical, so existing owner ids do not change.
- `source-worker.js` owner validation: recompute/enforce `owner_id` from the **membership's** account scope
  (owner-level metadata), not the canonical job's scope; a membership whose owner scope does not belong to
  the planning account still fails closed.
- Planner (`report-planner.js` / `decorateSources`): carries BOTH values on each planned source — canonical
  identity fields (org-wide for the catalog) and the owner's account scope — so `buildDependencyPlan`,
  the drivers, and the workers never re-conflate them.

**Schema / migration question:** `sync_source_jobs.account_scope_hash` and
`sync_source_job_owners.account_scope_hash` both exist today. Option A (no migration): store the canonical
org-scope token in the canonical row's `account_scope_hash` and the account scope in each membership row —
works, but the column name then lies for org-scope rows and the L.6 P2 equality check
(`o.account_scope_hash = s.account_scope_hash`) must become scope-aware. Option B (small additive
migration): add an explicit `source_scope` column (default `'account'`) to `sync_source_jobs` so canonical
rows are self-describing and P2 checks branch on it. **Recommendation: Option B** — self-describing state
beats overloading, and the migration is additive/non-destructive — but the choice is made at implementation
review, not here, and NO migration is prepared or applied now.

**Canonical metadata stability:** every canonical field of the org-wide row (source_id, org fingerprint,
canonical scope token, request meta, hash) derives ONLY from org-level inputs — no "first account to plan
wins", no account ordering sensitivity. Two accounts planning in either order produce byte-identical
canonical rows and identities.

**Primary organization isolation:** the org fingerprint (derived from the connection's own apiKey) stays
inside the identity, so a `dd-secondary` organization gets its OWN org-wide catalog hash; requests, caches,
maps, and memberships never cross organizations, and retired-secondary accounts stay read-only exactly as
today.

**One shared saved catalog/map:** a single `source_export_cache` entry (and one derived ASIN → brand map)
per organization catalog identity; every derive reads the same saved rows. Blank-brand ASINs (M.1 #6) stay
unmapped — never "Unassigned".

**No duplicate export per account:** the existing DB one-attempt guard (`claim_source_export_attempt` + the
one-attempt CHECK) already dedupes by `request_hash`; with ONE org-wide hash there is at most ONE catalog
create-export per cycle for the WHOLE organization, regardless of account count.

**Automatic reuse for newly discovered accounts:** a newly discovered account's plan resolves the SAME
org-wide hash, so onboarding adds only a new (account-specific) owner-membership row; the existing canonical
job, export, and saved catalog/map are reused — zero additional catalog tokens.

**Compatibility / migration for existing account-scoped cache entries:** existing per-account catalog cache
entries and their `request_hash` identities remain valid and readable until natural expiry — no rewrite,
delete, or backfill. The org-wide identity starts EMPTY and is seeded by its own first export at the
deliberate cutover; until that cutover the CURRENT per-account identities (including the Gate 5 canary's
plan-derived hash and every golden `request_hash` pin) stay byte-unchanged. The legacy browser route keeps
its current identity until it is migrated deliberately, with parity evidence.

**Tests required BEFORE implementation (all offline/deterministic):**

1. Identity: an `"organization"`-scope identity ignores seller ids and account planning order; is stable
   across accounts; differs between organizations (primary vs dd-secondary); every `"account"`-scope
   identity (all golden `request_hash` pins) is byte-unchanged.
2. Resolver: an org-scope contract resolves ONE request regardless of account count; the resolved source
   still carries the account's own owner scope; account-scoped sources keep the single-account fail-closed
   invariant; unknown scope values fail closed.
3. Owner derivation: N accounts ⇒ N distinct owner ids pointing at ONE canonical hash (no collapse); the
   worker's owner validation passes for each account's own membership and fails closed for a
   wrong/mismatched owner scope.
4. Worker/driver: one create-export total for the org-wide hash with multiple owners; either owner can
   resume; stale-membership reconciliation unchanged.
5. P2/L.6 checks: updated isolation queries pass for org-scope canonical rows with account-scoped
   memberships and still FAIL on genuinely mis-scoped memberships.
6. Cache compatibility: old per-account entries readable until expiry; new org-wide entry independent;
   no cross-org reuse.

**Explicitly REJECTED (do NOT implement):**

- using ONE ACCOUNT's `accountScopeHash` as the canonical org-wide scope (first-account-wins identity —
  unstable, account-ordering-dependent, and a lie about the request);
- a CONSTANT `accountScopeHash` shortcut (hard-coding/normalizing the scope while the identity still
  claims to be account-scoped — overloads the meaning, invites silent aliasing, leaves no typed record);
- including per-account seller IDs in the organization-wide request identity (would fracture the one
  canonical hash back into per-account hashes);
- changing ANY identity before DataDoe confirms the marketplace, `child_asin`, and date/filter semantics
  (M.3) — the golden `request_hash` pins stay untouched until then.

### M.3 Deliberately unresolved (pending DataDoe follow-up — do not guess)

The final org-wide request identity is NOT fixed here. Blocked on DataDoe's answers about:
- whether a **marketplace filter** exists/behaves server-side for this source (current files carry no
  `marketplace_id` — M.1 #4);
- whether a **`child_asin` filter** is honored;
- the source's **date behavior** (no-date vs windowed semantics for this dataset);
- the exact request payload the org-wide identity should therefore hash (columns/window/filters).

Until then: no planner/resolver/contract change, no new hash scheme, no migration of cached entries, and the
Gate 5 canary (Appendix L) keeps validating the CURRENT plan-derived identities unchanged.

## Appendix N — Gate 5 canary cycle reconciliation (EXECUTED 2026-08-14 — SUCCESS; zero DataDoe)

> **N.1–N.3 are the reviewed procedure as prepared; N.4 is the execution evidence.** It reconciles ONLY the
> single Gate 5 canary cycle
> (`sync_cycles` id `57afc1fb-6694-4925-8961-4730f5a8f4df`, `(non-us, 2026-08-14)`) that the Blocker-1
> lifecycle defect left `status='running'`. It is executed ONLY **after** the lifecycle fix (dispatcher-owned
> finalization + `20260815_sync_cycle_finalize.sql`) is reviewed and that migration is applied via its own
> reviewed Gate. It makes **zero DataDoe calls/exports**, no Supabase write beyond finalizing that one cycle
> row, and **does not alter or delete** any source/report/owner/snapshot row. Do not run it before the fix is
> approved; do not touch any other cycle.

### N.1 Preconditions (read-only; STOP on any mismatch)
- `20260815_sync_cycle_finalize.sql` has been applied via a reviewed Gate (the `finalize_sync_cycle` RPC and the
  three `*_no_append_terminal` triggers exist); migrations 1–4 remain byte-unchanged.
- The target cycle is still `status='running'`, `finished_at` null, and its source/report/owner/snapshot rows
  are exactly the Appendix L.8 evidence (2 succeeded source jobs, 1 report job, 2 owner memberships, 1 shadow
  snapshot). Confirm zero open source/report jobs: no `sync_source_jobs.fetch_status in ('pending','attempted')`
  and no non-finished `sync_report_jobs` for the cycle.

### N.2 Reconcile (guarded; one cycle only)
- Call `select public.finalize_sync_cycle('57afc1fb-6694-4925-8961-4730f5a8f4df');` ONCE. The RPC takes ONLY the
  cycle id (no expect-status parameter) and returns a `jsonb` `{ disposition, cycle }`. It finalizes only a
  `running` cycle with zero open source/report jobs, recomputes the authoritative source **and** report
  counters, and stamps `finished_at`. **Require `disposition = 'finalized'`** with the expected cycle. Any other
  disposition — `already-terminal` / `open-work` / `not-found` / `invalid-status` — means the preconditions did
  not hold: STOP and report, make no manual edit.

### N.3 Post-reconciliation (read-only; record safe fields only)
- Expect the cycle row: `status='succeeded'` (all source + report work succeeded — 2/2 sources, 1/1 report),
  `finished_at` set, `source_total=2/source_succeeded=2/source_failed=0`, `report_total=1/report_succeeded=1/
  report_failed=0`. Re-confirm the production Brand Sales fingerprint is still byte-identical (unchanged by a
  cycle-row-only finalize) and that exactly one `scheduler-v2/brand-sales` shadow snapshot exists. No other
  cycle/account/report/source/owner is touched. STOP for review; do not proceed to Gate 6 until parity is
  established across ≥ 2 cycles under the corrected lifecycle.

### N.4 EXECUTION evidence (EXECUTED 2026-08-14 — SUCCESS; safe fields only)

Executed from `sales-dashboard-live/` with `node --env-file=../.env.local` (secrets loaded into the process env
only, never printed/committed), immediately after the Appendix O Migration-5 gate passed its full read-only
post-verification. Zero DataDoe calls; the ONLY write in this phase is the one `finalize_sync_cycle` UPDATE of
the one canary cycle row.

- **Preconditions (read-only, ALL PASS before the call):** cycle `57afc1fb-6694-4925-8961-4730f5a8f4df` was
  `status='running'` / `finished_at IS NULL`; exactly 2 succeeded source jobs, 0 `pending`/`attempted`; exactly
  1 report job with `derive_status='succeeded'` + `save_status='succeeded'`, 0 unfinished; exactly 2 active
  `primary` owner memberships for `brand-sales` / the selected account; exactly 1 `scheduler-v2/brand-sales`
  shadow snapshot (and 1 `scheduler-v2/*` globally); production Brand Sales payload-free fingerprint
  `cba3fb264b31dd6a5c35b20e8df2ccab` (7 rows) matched Appendix L.8; no other `sync_cycles` row (global v2 row
  counts 1/2/1/2); 13 controls all `schedule_enabled=false`. Payload-free per-table digests (source jobs /
  report job / owners / shadow snapshot) captured as the before-images.
- **The one call:** `select public.finalize_sync_cycle('57afc1fb-6694-4925-8961-4730f5a8f4df');` — executed
  EXACTLY ONCE. Result: **`disposition='finalized'`** with the full cycle row as evidence — id matching,
  **`status='succeeded'`**, **`finished_at=2026-08-14T16:34:30.312782Z`**, **`source_total=2 /
  source_succeeded=2 / source_failed=0`**, **`report_total=1 / report_succeeded=1 / report_failed=0`** — every
  strict-acknowledgement expectation met.
- **Post-checks (read-only, ALL PASS):** the persisted cycle row is terminal with exactly those counters; the
  source-job / report-job / owner-membership / shadow-snapshot digests are **byte-identical** to the
  before-images (nothing but the one cycle row changed); production fingerprint still
  `cba3fb264b31dd6a5c35b20e8df2ccab` (7 rows); 13 controls still all `schedule_enabled=false`; still exactly one
  `sync_cycles` row; `pg_cron` still absent.

**Blocker 1 is RESOLVED IN PRODUCTION.** Gate 6 remains BLOCKED pending parity across ≥ 2 cycles under the
corrected lifecycle, each behind explicit human approval. STOP for Codex review.

---

## Appendix O — Migration-5 gate EXECUTION evidence (applied 2026-08-14; single guarded transaction)

Applies ONLY `20260815_sync_cycle_finalize.sql` — the Blocker-1 finalization primitives (the guarded
`finalize_sync_cycle(p_cycle_id uuid)` RPC + the `reject_append_to_terminal_cycle` BEFORE-trigger on the three
child tables). Executed with explicit human authorization, from `sales-dashboard-live/` with
`node --env-file=../.env.local` (secrets never printed/committed). No `db:migrate`, no retry.

### O.1 Offline preflight (all PASS)

HEAD `6b36544` on `feature/scheduler-v2` (includes the final-review commits `eb543ea`/`6b36544`); migrations 1–4
SHA-256 unchanged (`1328bc0f / 0750a155 / 544557fb / 49628c8d`); **Migration 5 frozen at SHA-256
`5222a8e55c89bbcb21fe10b9f1f755d795aecee69f4ac0d5a15c61d459823759`** and byte-identical to HEAD; `npm run
verify` 35/35 incl. `build:check`; `git diff --check` clean; `SCHEDULER_V2_READY_REPORT_KEYS` frozen empty;
working tree only `HANDOFF.md` + `.worktrees/` untracked; `POSTGRES_URL` present + nonblank in the git-ignored
untracked env file (checked by NAME only).

### O.2 Production read-only inventory (all PASS; run in a `read only` transaction)

`app_schema_migrations` exists; migrations 1–4 each **exactly one** ledger row; Migration 5 **zero** rows;
`sync_cycles` (18 cols) / `sync_source_jobs` (27) / `sync_report_jobs` (25) / `sync_source_job_owners` (15) all
present with the expected column sets; `finalize_sync_cycle` **absent** (0 overloads);
`reject_append_to_terminal_cycle` **absent**; all three `*_no_append_terminal` triggers **absent**; roles
`service_role`/`anon`/`authenticated` exist; the Gate-5 canary cycle matched Appendix L.8 exactly (running,
source counters 2/2/0, report counters unwritten 0/0/0, hash prefixes `ee35b3f2e7…`/`f1270dc16e…` both
succeeded, 0 open; 1 finished report job; 2 active owner memberships; global v2 row counts 1/2/1/2); exactly 1
`scheduler-v2/brand-sales` snapshot (1 globally); production fingerprint `cba3fb264b31dd6a5c35b20e8df2ccab`
(7 rows); 13 controls all `schedule_enabled=false`; `pg_cron` absent (no `cron.job`).

### O.3 The apply (ONE transaction, ONE commit)

In order, inside a single `BEGIN … COMMIT`: (1) `pg_advisory_xact_lock(20260815, 1)` acquired BEFORE any ledger
read; (2) migrations 1–4 re-checked exactly-once in-transaction; (3) fail-closed check that Migration 5 was not
already recorded; (4) re-check that the RPC, guard function, and all three triggers were still absent; (5) the
migration file's SHA-256 re-verified in-script against the frozen `5222a8e5…` BEFORE execution, then the frozen
body executed; (6) ledger row recorded with a **plain INSERT** (no `ON CONFLICT`); (7) single `COMMIT`. Any
error would have rolled back everything; none occurred. **Ledger `applied_at = 2026-08-14T16:27:31.800Z`.**

### O.4 Read-only post-verification (all PASS; run in a `read only` transaction)

- **RPC:** exactly one `finalize_sync_cycle` overload; signature exactly `(p_cycle_id uuid)`; returns `jsonb`;
  `SECURITY DEFINER`; `proconfig = [search_path=public]`.
- **Privileges:** `anon` × / `authenticated` × / `service_role` ✓ (`has_function_privilege`); the ACL
  (`postgres=X/postgres;service_role=X/postgres`) contains NO empty-grantee entry, so **PUBLIC cannot execute**;
  owner `postgres` retains execute (accurately reported — expected for the definer).
- **Guard function:** present; returns `trigger`; `SECURITY DEFINER`; body **byte-identical to the approved
  migration body** (1180 chars, `prosrc` exact string match).
- **Triggers:** exactly 3 `*_no_append_terminal`; each `tgtype=23` (BEFORE INSERT OR UPDATE, FOR EACH ROW),
  `tgenabled='O'`, on its exact table (`sync_source_jobs` / `sync_source_job_owners` / `sync_report_jobs`),
  executing `public.reject_append_to_terminal_cycle` **proven by OID join** (`tgfoid` → `pg_proc`/
  `pg_namespace`; `pg_get_triggerdef` serializes the function unqualified because `public` is on the
  serialization path — the OID join is the authoritative schema proof).
- **Ledger:** migrations 1–5 each exactly one row.
- **Migrations 1–4 unchanged:** the three migration-1 RPCs present; the three `*_touch` triggers present; table
  column counts unchanged (18/27/25/15); RLS still enabled on all four tables.
- **Zero data changed:** canary cycle STILL `running`/`finished_at` null at this point (untouched by the
  migration); v2 row counts 1/2/1/2; 1 shadow snapshot; fingerprint `cba3fb26…` unchanged; 13 controls all
  disabled; `pg_cron` absent.

The `.sql` file remains byte-frozen in git (its "PREPARED — UNAPPLIED" header comment is the historical review
text; the ledger row is authoritative for applied-state). Reconciliation of the canary cycle followed
immediately as Appendix N.4. STOP for Codex review; Gate 6 remains BLOCKED.

---

## Appendix P — Gate 6 Shadow Parity CYCLE 1 EXECUTION evidence (2026-08-14; all 13 reports; SHADOW)

Explicitly authorized live scope: ONE production-shaped SHADOW parity cycle for all 13 Scheduler-v2 reports on
representative primary accounts. Executed from `sales-dashboard-live/` with `node --env-file=../.env.local`
(secrets never printed/committed). **No control unlock, publish, deploy, merge, push, schedule, or Cycle 2.**
Writes: scheduler-v2 tables + `scheduler-v2/*` snapshots ONLY; instance-scoped readiness only (the durable
controls and `SCHEDULER_V2_READY_REPORT_KEYS` stayed locked; verified 13× `schedule_enabled=false` before and
after). HEAD at execution `f0d424b`; `npm run verify` 35/35 before AND after (incl. the Cycle-1 fix commit).

### P.1 Scope, accounts, plans, budget

- **Report keys (authoritative, from `report_sync_settings`):** brand-sales, buy-box-loss, content-changes,
  daily-reporting, fba-plan, keyword-rank, listing-health, listing-optimizer, ppc-performance, reconciliation,
  returns-leakage, sales-movers, sku-pl — passed as `manualReportKeys` (exactly these 13; `lockedOut=[]` each
  slice, `derivedOnly=[]`).
- **ONE live primary-account discovery** (30 accounts), memoized to a snapshot reused by every later phase;
  never fabricated; dd-secondary never routed (primary-only connection; every owner row `connection_id='primary'`).
- **Selected accounts:** US bucket `26f7a1a6-…` (US/USD; freshest+largest production brand-sales snapshot);
  non-US bucket `d658442d-…` (IN/INR; 6 production report snapshots — the widest parity baseline). `asOf
  2026-08-13` (stable, both buckets), `cycleDate 2026-08-15` (unique; `(non-us, 2026-08-14)` is the TERMINAL
  Gate-5 cycle, protected by the append-guard triggers).
- **Plan-before-export budget** (real planners, validated against the authoritative `SOURCE_CONTRACTS` registry;
  catalog = short id `68d2de238e` everywhere; every source strict-flagged/windowed/owner-derived; per-report
  max source counts recorded): **us 53 initial unique hashes / 59 MAX** (incl. staged fallback+activation
  ceilings; fba-plan carries the US-only AWD source), **non-us 52 / 58**; generic dedup saved 3 hashes per
  bucket (the shared no-date insight catalog across buy-box/returns/listing-health + the shared inventory
  snapshot). PPC planned ZERO sources by design (see P.3).

### P.2 Execution + budgets + finalization (per bucket)

Bounded resumable slices (`maxJobs 8`/slice, 90s slice deadline, 5s reserve, overall per-invocation budget),
resumed until drained; after EVERY slice an authoritative DB budget guard re-checked `create_export_count`
(≤ 1 per request_hash; total ≤ the precomputed MAX; every hash either plan-pinned or owner-proven to a staged
family; `connection_id='primary'` on every row). Manual runs never auto-finalize; after full drain + zero open
source/report jobs + all 13 report jobs present, `finalize_sync_cycle` was called EXACTLY ONCE per bucket cycle.

| bucket | cycle | slices | create-exports (actual/MAX) | sources ok/failed | finalize |
|---|---|---|---|---|---|
| us | `56422a66-9f23-43c9-9c8d-8a9427f8f36a` | 22 | **57 / 59** (≤1 per hash) | 44 / 13 | `finalized`, **`partial`**, `finished_at 2026-08-14T18:24:51.385779Z`, source `57/44/13`, report `13/2/11` |
| non-us | `ac4cba6f-3214-4d9b-9be7-35c572890edf` | 20 | **56 / 58** (≤1 per hash) | 39 / 17 | `finalized`, **`partial`**, `finished_at 2026-08-14T18:24:51.892947Z`, source `56/39/17`, report `13/3/10` |

Deferral/resume behavior observed repeatedly (poll-pending → `attempted` → resumed, no duplicate create-export);
the corrected lifecycle held end-to-end: honest `partial` terminal statuses with authoritative counters, and the
strict finalize-acknowledgement validation passed on both calls.

### P.3 The 13 report outcomes (per bucket; typed, evidence-backed)

- **us `26f7a1a6-…`:** brand-sales **succeeded** (shadow 232,753 B); listing-health **succeeded** (697,584 B);
  buy-box-loss / content-changes / daily-reporting / fba-plan / keyword-rank / reconciliation / returns-leakage /
  sales-movers / sku-pl **blocked** (`SOURCE_BLOCKED` — a required source TIMEOUTed; LKG preserved);
  listing-optimizer **unavailable** (`SOURCE_UNAVAILABLE` — its SQP-weekly export TIMEOUTed);
  ppc-performance **unavailable** (`SOURCE_UNAVAILABLE` — empty durable Ads coverage; zero tokens spent).
- **non-us `d658442d-…`:** brand-sales **succeeded** (329,897 B); content-changes **succeeded** (680 B);
  keyword-rank **succeeded** (5,042,535 B); buy-box-loss / daily-reporting / fba-plan / listing-health /
  reconciliation / returns-leakage / sales-movers / sku-pl **blocked** (`SOURCE_BLOCKED`); listing-optimizer +
  ppc-performance **unavailable** (as above).
- **PPC prerequisite (stopped PPC only; every other safe report continued):** durable `ads_sync_coverage` holds
  **0 rows** — the table postdates the production Ads-sync pause, and the only approved population path (the
  paused v1 Ads sync) has not run since. Missing for BOTH accounts: required `campaign-performance-v1` +
  `asin-performance-v1` (and optional `keyword-targeting-performance-v1` + `search-terms-performance-v1`) over
  `[2026-07-15 .. 2026-08-13]`. Coverage was NOT fabricated and NOT derived from metric-row min/max
  (`ad_daily_metrics` has 31,864 rows; `ads_sync_state` 196 — history exists, durable coverage evidence does
  not). **Needs a reviewed decision on running the approved Ads-sync path before PPC can join a parity cycle.**
- **DataDoe TIMEOUT findings (30 total: 13 us / 17 non-us; each `create_export_count=1`, typed safe failure,
  zero duplicates/retry storms):** consistently the LARGEST datasets — `sales-traffic-asin-date` monthly
  fragments, `profit-by-sku-date` monthly fragments, `settlements`, `sqp-weekly`, `returns`, `listings`,
  `content-changes` events, one `product-catalog` (non-us), `fba-inventory-health`, `order-line-items` monthly
  fragments (non-us). These are DataDoe-side export processing timeouts (the export itself reported timed-out;
  distinct from the resumable poll-pending path, which worked). **Needs DataDoe input on large-export
  processing limits/latency before Cycle-2 stability can be assessed.**

### P.4 Parity, isolation, LKG, Brand View

- **Production isolation (byte-proof):** payload-free fingerprints identical before/after for BOTH selected
  accounts (`26f7a1a6…`: 4 rows, `0642f2c8…`; `d658442d…`: 8 rows, `190b4444…`) AND the Gate-5 canary account
  (`cba3fb26…`, 7 rows); the Gate-5 cycle row + child rows (2/1/2) untouched; 13 durable controls still
  `schedule_enabled=false`; `pg_cron` absent. Exactly **6** `scheduler-v2/*` snapshots exist (5 new + Gate-5's).
- **LKG preservation:** for EVERY non-succeeded report (both buckets) no `scheduler-v2/<report>` snapshot was
  written, and every existing production snapshot (e.g. non-us listing-health / listing-optimizer /
  ppc-performance / returns-leakage / sales-movers) is byte-preserved (covered by the account fingerprints).
- **Owner/organization isolation:** all 62+62 owner rows active/`primary`/selected-account; exactly ONE
  organization fingerprint per cycle; ZERO ownerless source jobs; every report job scoped to its account.
- **Zero network in derivation:** structural (the derive receives no DataDoe adapter — offline-proven by the
  import-boundary tests) + observed (the final drain invocations performed ZERO `api.datadoe.com` calls while
  the derive transitions completed; per-invocation host/method fetch accounting recorded).
- **brand-sales field parity (both buckets):** row schema IDENTICAL; catalogBrands overlap complete (shadow adds
  1 new brand on us — fresher data); overlapping-window sales totals delta **0.067% (us)** / **0.296% (non-us)**
  (production snapshots are 1–6 days older than `asOf 2026-08-13`). **ONE real defect found:** the newer us
  production payload carries the additive `asinBrand` map; the scheduler derive omitted it → **FIXED in
  `bb37a4e`** (route-identical first-wins map + fail-closed empty-map guard + `validatePayload` + version bump
  `brand-sales/v2d-2`; 69 derivation assertions). The Cycle-1 shadow snapshots predate the fix; Cycle 2 lands
  the corrected payload. First-shadow reports with no production baseline (us listing-health; non-us
  content-changes + keyword-rank) are recorded as parity-N/A baselines for Cycle 2.
- **Brand View:** rebuilt OFFLINE (global.fetch removed → any network call would throw) for BOTH selected
  accounts + the Gate-5 account from saved production snapshots only: brand directory (1 brand each, from
  brand-sales) + a full per-brand slice each (inventory present, no ads error, nothing skipped). Missing
  coverage reported explicitly (none — all 3 accounts rebuilt). The organization-wide Product Catalog identity
  redesign (Appendix M) was NOT introduced.

**STOP.** Cycle 2, control unlock, publishing, deployment, and scheduling all remain BLOCKED pending Codex
review of this evidence and explicit human approval.

---

## Appendix Q — Gate-6 blocker remediation: timeout classification, timeout-safe slicing, Ads-sync canary prep (2026-08-15; OFFLINE code/tests only)

Remediates the Cycle-1 blockers entirely offline (commit `8b085e0` code/tests; this appendix docs-only).
Nothing was executed: no production/DataDoe/Supabase call, no Cycle 2, no Ads sync, no control change.

### Q.1 Timeout classification matrix (all 30 Cycle-1 terminal TIMEOUTs)

Classification rule: a source is SAFE_TO_SLICE only when its output rows are PER-DAY (its groupBy includes
`date`, or it is raw grain with a real per-row date) — then any partition of the window partitions the rows
exactly and concatenation reproduces the fold. A groupBy WITHOUT date returns whole-window aggregate rows
(slicing changes row identity); no-date/current-state sources have no window to slice.

| request key (timeouts us/non-us) | source / id-prefix | window | grouping | strict/limit | classification |
|---|---|---|---|---|---|
| daily-reporting:asin-day-superset (2/2) | sales-traffic-asin-date `401ffcd7e5` | per-month | [date,seller,asin]+sums | ✓/50k | **SAFE_TO_SLICE — SLICED** |
| reconciliation:order-lines (0/2) | order-line-items `89b27535d2…` | per-month | incl. date + sums | ✓/50k | **SAFE_TO_SLICE — SLICED** |
| reconciliation:settlements (1/2) | settlements `732dac689a…` | per-month | incl. date + sums | ✓/50k | **SAFE_TO_SLICE — SLICED** |
| returns-leakage:returns (1/0) | returns `27c6fc0ec6…` | 60d, date DESC | raw dated rows | ✓/50k | **SAFE_TO_SLICE — SLICED (newest-first)** |
| keyword-rank:sqp-weekly (1/0) + listing-optimizer:sqp-weekly (1/1) | sqp-weekly `81aa5b4cc2…` | 84d | raw dated rows | ✓/50k | **NOT_SLICEABLE (pipeline)** — the fold is slice-safe, but the STAGED cycles track ONE weekly fragment hash as the activation signal (single-fragment contract); slicing requires a staged-driver redesign. Deferred; in the DataDoe matrix. |
| sku-pl:monthly-profit (1/2) | profit-by-sku-date `57a0cb319c…` | per-month | [sku,…] NO date | ✓/50k | **NOT_SLICEABLE** (whole-month aggregate rows; six-complete-month contract) |
| fba-plan:monthly-units (1/1) | sales-traffic-asin-date | per-month | [child_asin] NO date | ✓/30k | **NOT_SLICEABLE** (whole-month aggregate rows) |
| listing-health:sales (0/1) | profit-by-sku-date | 30d | [sku,asin,currency] NO date | ✓/50k | **NOT_SLICEABLE** |
| sales-movers:traffic (1/1) + :ads (1/1) | sales-traffic / profit-by-sku | 7d probe-derived pairs | NO date | ✓/50k | **NOT_SLICEABLE** (already 7d; grouped without date) |
| buy-box-loss:daily (1/1) | profit-by-sku-date | 7d slices (existing) | incl. date | ✓/50k | **already at the 7d policy floor** — a 7d slice still TIMEOUTed → DataDoe matrix |
| fba-plan:inventory-health (0/1) + sales-movers:inventory (0/1) | fba-inventory-health `44fc5ba0ce…` | 10d snapshot | date-DESC snapshot rows | ✓/15k | **LATEST_SNAPSHOT_SLICEABLE** (provable: a partition preserves the union, so latest-date selection is unchanged) — deferred pending DataDoe limits |
| content-changes:events (1/0) | content-changes `aec3d59769…` | no-date (event_time DESC) | raw | ✓/1k | **NOT_SLICEABLE (no-date)** |
| fba-plan:awd / listings (1/0) | listings `ba689c05d7…` | no-date | raw | ✓/10k | **NOT_SLICEABLE (no-date)** |
| sales-movers:catalog / product-catalog (0/1) | product-catalog `68d2de238e` | no-date/current-state | raw | ✓/20k | **NOT_SLICEABLE (current-state)** |

Totals: us 13 + non-us 17 = 30 ✓. **10 of the 30 timed-out exports belonged to the now-sliced contracts**
(daily superset 4, reconciliation 5, returns 1) — and every unfailed sibling window of those contracts is
protected by the same change. The remaining 20 are classified above and carried in the DataDoe support
matrix (Q.4).

### Q.2 Changed request/window contracts (INTENTIONAL request_hash changes; golden-pinned)

- `daily-reporting:asin-day-superset`: `per-month` → **`per-slice(<=7d, within each calendar month)`** over the
  same `monthStart(asOf)-150..asOf` coverage (ordered ASC, gapless, non-overlapping, exact from/to).
- `reconciliation:order-lines` + `:settlements`: `per-month (6 complete months)` → **`per-slice(<=7d, within
  each of the 6 months)`**; the six-complete-calendar-month integrity is enforced on the context window and the
  derive recomputes + requires the EXACT slice sequence.
- `returns-leakage:returns`: `range asOf-59d..asOf` → **`per-slice(<=7d), NEWEST-FIRST`** (source is date DESC;
  concatenation reproduces the former whole-window DESC order exactly).
- Derive-side (`slicedFragmentRows`): only the exact recomputed sequence is accepted (reordered/duplicate/
  missing/extra/wrong-window/cross-account rejected) and EVERY row must lie inside its OWN fragment window.
- Golden tests pin the new hashes for a fixed synthetic input (`timeout-slicing.test.js`); the browser routes
  are untouched (the scheduler's request identities deliberately diverge for these three families).
- Unchanged: strict caps (now per-slice — stricter), LKG semantics, public/raw identity, owner scope,
  primary-only routing, one create-export per request_hash, no retry/fallback source.

### Q.3 Export-count budget (before → after; the deliberate trade-off)

| bucket | Cycle-1 initial unique | post-slicing initial unique | delta |
|---|---|---|---|
| us (`26f7a1a6…`) | 53 | **128** | +75 (superset 6→27, recon orders 6→27, recon settlements 6→27, returns 1→9; dedup unchanged) |
| non-us (`d658442d…`) | 52 | **127** | +75 |

~2.4× more create-exports, each ~4–7× smaller — sized so the largest single export a sliced source can request
is ≤7 days of rows (the whole-month/60-day exports were what TIMEOUTed).

### Q.4 DataDoe support matrix — unsplittable timed-out sources (questions for DataDoe)

For EVERY entry: our request used the exact safe windows/filters shown in Q.1, strict row caps, and the export
terminally reported TIMEOUT while processing. **The question for each is the same: “What API-supported filter
or export partition should be used for this source, and what are its processing/row limits?”**

| source (name / short id-prefix) | windows/filters we used | terminal outcome |
|---|---|---|
| Profit by SKU & Date `57a0cb319c…` | one calendar month (sku-pl), 30d (listing-health sales), 7d slices (buy-box) — grouped by SKU | TIMEOUT (5 exports) |
| Sales & Traffic by ASIN & Date `401ffcd7e5` | one calendar month grouped by child_asin (fba-plan monthly-units); 7d probe-derived grouped windows (sales-movers traffic) | TIMEOUT (4 exports) |
| Settlements `732dac689a…` | one calendar month, grouped incl. date | TIMEOUT (3 exports) — now sliced ≤7d; residual risk if 7d still times out |
| SQP Weekly `81aa5b4cc2…` | 84d raw weekly rows | TIMEOUT (3 exports) — fold slice-safe; staged single-fragment signal blocks slicing without redesign |
| FBA Inventory Health `44fc5ba0ce…` | 10d snapshot lookback | TIMEOUT (2 exports) |
| Product Catalog `68d2de238e` | current-state, 4 columns, 20k cap | TIMEOUT (1 export, non-us) |
| Content Change Alerts `aec3d59769…` | no-date, event_time DESC, 1k cap | TIMEOUT (1 export) |
| Listings `ba689c05d7…` | no-date, 4 columns (AWD) | TIMEOUT (1 export) |
| Returns `27c6fc0ec6…` | 60d raw | TIMEOUT (1 export) — now sliced ≤7d newest-first |

No API keys, payload rows, or export IDs appear here or in any committed evidence.

### Q.5 Account-bounded Ads-sync preparation (PPC prerequisite; NOT executed)

`runAdsSync(countries, sourceKeys, { accountIds })` gains an OPTIONAL exact public-account allowlist
(`resolveAdsAccountAllowlist`, pure + fail-closed): selects ONLY freshly discovered primary accounts; throws on
unknown/duplicate/blank/`dd-secondary:`/non-primary ids; never routes a secondary account through the primary
key (selection returns discovered account objects with their OWN connections); coverage windows are recorded
ONLY after durable Ads persistence (unchanged order, per-source independent — campaign + ASIN each exactly
covered; targeting/search independent). Absent allowlist ⇒ byte-for-byte unchanged (both existing callers pass
two arguments). Tests prove the two Gate-6 accounts (`26f7a1a6…` US, `d658442d…` IN) can be targeted without
selecting any other US/IN account. **The Ads sync itself was NOT run** — executing it (to populate
`ads_sync_coverage` for the PPC prerequisite) remains a separate explicitly-approved step.

### Q.6 Verification

`npm run verify` **36/36 across 16 suites** (the new `timeout-slicing` suite is wired in) incl. `build:check`;
`git diff --check` clean; migrations 1–5 untouched; controls locked/paused; no readiness/durable-settings/
frontend/cron/route/Scheduler-v1 change. **STOP for Codex review.** Cycle 2 / Ads-sync execution / unlock /
deploy / schedule all remain BLOCKED pending review + explicit approval.

---

## Appendix R — Ads-sync `requiredCoverage` canary contract (2026-08-15; OFFLINE code/tests only; NOT executed)

Fixes the three Codex Ads-sync findings on Appendix Q.5's canary preparation (commit `a72c259` code/tests; this
appendix docs-only). Nothing was executed — the Ads sync itself remains a separate explicitly-approved step.
The approved timeout slicing (Appendix Q) is unchanged.

### R.1 The option

`runAdsSync(countries, sourceKeys, { accountIds, requiredCoverage: { from, to } })`. `requiredCoverage` is the
account-bounded exact-window backfill the PPC prerequisite needs. It is **validated before the lock is claimed**
and is **allowed only with an `accountIds` allowlist of 1..`MAX_IDS_PER_EXPORT` (5) ids** (it can never widen an
unbounded country sweep, and it fits in ONE export batch per source so it can never go organization-wide):
strict real `YYYY-MM-DD`, `from ≤ to`, `to` not in the future, the **inclusive window span ≤
`MAX_REQUIRED_COVERAGE_DAYS`** (see R.7), and **EXACTLY one supported `sourceKey`** per invocation (see R.8). In
coverage mode the exact `[from, to]` is the DataDoe export window for the selected source — `pickMode`/`windowFor`
are never called, so an existing `ads_sync_state` that would otherwise pick a 21-day `daily` window can never
shorten it.

### R.2 Exact per-batch effect (state + coverage), coverage mode

Order per batch: **1)** fetch the exact window → **2)** `upsertAdsDailyRows` (+ `ad_daily_metrics` for
campaign) — durable rows FIRST → **3)** `recordAdsCoverageWindows` and REQUIRE a positive acknowledgement
(`write==='ok'` AND one recorded row per account) → **4)** only then write the success state.

| table | on positive coverage ack | on unconfirmed/mismatched/failed ack (fail closed) |
|---|---|---|
| `ads_daily_source_rows` | upserted (durable, natural key) | upserted (rows already fetched) — but never marked a success |
| `ad_daily_metrics` (campaign only) | upserted | upserted |
| `ads_sync_coverage` | one row per (source, account): `covered_from=from`, `covered_to=to`, `status='succeeded'` | **no coverage row written** (or a non-`ok` write → treated as unconfirmed) |
| `ads_sync_state` | `last_status='succeeded'`; `latest_metric_date` advanced from the saved rows; **`initial_seeded_at` / `last_daily_sync_at` / `last_monthly_sync_at` PRESERVED verbatim** (not a cadence run) | `last_status='failed'`; `latest_metric_date` **not advanced**; cadence timestamps untouched; account in `coverageFailedAccounts` |

The recorded `[from, to]` (e.g. the 30-day PPC window `[asOf-29, asOf]`) is exactly what
`evaluateSourceCoverage(state, from, to)` needs to return `proven === true` for campaign + ASIN; optional
targeting/search coverage is recorded independently (only when those sources are requested). Existing
two-argument callers (`runAdsSync(countries)` / `runAdsSync(countries, [sourceKey])`) are byte-for-byte
behavior-compatible: no options ⇒ the unchanged cadence path (coverage stays best-effort/ignored).

### R.3 Lock + architecture

`releaseRefreshLock` is added and the whole post-claim body runs in `try/finally`, so the lock is released
**exactly once on every post-claim outcome** (success, partial/deadline, discovery failure, allowlist
rejection, DataDoe failure, coverage-write failure); the `skipped` path (lock held by another run) never
releases. The worker is now a dependency-injected core `runAdsSyncWithDeps(deps, …)` with a production wrapper
`runAdsSync = runAdsSyncWithDeps(PRODUCTION_ADS_SYNC_DEPS, …)`.

### R.4 Per-batch row validation (fix, 2026-08-15; commit `539bdfa`)

Before ANY row/metric/coverage/success-state write, `validateExportBatchRows(source, rows, batch, connection)`
(pure) rejects the **whole batch** on any malformed/cross-account evidence: the result must be an array; every
row a plain object; `seller_or_vendor_id` nonblank and **exactly one of the batch's rawAccountIds**, resolved
**through the batch's discovered account object** (resolved public id + connection must match the batch); and,
when the source declares the `marketplace_country_code` dimension, the row marketplace must equal the discovered
account's country. A rejected batch records **only** a typed safe failed state (`INVALID_EXPORT_EVIDENCE
(<slug>)`) for the requested accounts — zero row/metric/coverage/success writes. A **genuine zero-row export
(`[]`)** stays valid covered-empty evidence.

### R.5 Total coverage-mode result (fix, 2026-08-15; commit `539bdfa`)

`finalizeCoverageSummary(summary, { accounts, sourceKeys, deferred })` (pure) turns per-source counts into a
TOTAL result. `expectedCoveragePairs = N accounts × M sources`; a pair is successful only with durable Ads rows
(or a validated empty result) **and** a confirmed exact coverage ack **and** successful state persistence.

| terminal condition | `status` | `coverageComplete` |
|---|---|---|
| every N×M pair succeeded, zero failures, not deferred | `completed` | `true` |
| some successful pairs + any failure | `partial` | `false` |
| zero successful pairs + any failure | `failed` | `false` |
| work-budget deadline (deferral) | `partial` (`deferred:true`) | `false` |

`completed` therefore **implies** `coverageComplete === true` and zero `failedAccounts`/`coverageFailedAccounts`,
so the live operator can require **`res.status === "completed" && res.coverageComplete === true`**. Normal
cadence summaries are byte-for-byte unchanged (no `coverageComplete` field). The work-budget clock is now an
injected dep (`clock: () => Date.now()`) so the deferral path is deterministically testable.

### R.6 Verification

`scripts/ads-sync-canary.test.js` (**40 assertions**) drives the real DI core with injected trusted
collaborators (no network/Supabase/real lock) and proves every listed property, incl. the fixes: one
selected + one unrelated row ⇒ zero writes; missing/blank seller ⇒ whole batch fails; wrong marketplace ⇒ whole
batch fails; non-array ⇒ whole batch fails; both selected accounts in one batch succeed; zero-row export ⇒
validated-empty coverage; all N×M pairs ⇒ `completed` + `coverageComplete:true`; null/mismatched ack ⇒ never
completed; one source ok + one fail ⇒ `partial` + `coverageComplete:false`; state-write failure cannot return
completed; deadline cannot return completed (⇒ `partial`+`deferred`); no secret/raw error in results; lock
released exactly once on every post-claim path; two-argument cadence behavior unchanged; + a pure
`finalizeCoverageSummary` unit; + the R.7 budget bounds. `npm run verify` **37/37 across 17 suites** incl.
`build:check`; `git diff --check` clean; timeout slicing / `requiredCoverage` / DI structure / lock release /
source IDs / request hashes / Scheduler-v1 cadence / controls / frontend / routes / migrations **unchanged**.
**STOP for Codex review.** Ads-sync execution / Cycle 2 / unlock / deploy / schedule remain BLOCKED pending
review + explicit approval.

### R.7 Canonical requiredCoverage budget bounds (fix, 2026-08-15; commit `30f3980`)

The arbitrary `2000-01-01` floor is replaced by **canonical hard bounds derived from the source contracts**,
both checked in `validateAdsSyncOptions` **before `claimRefreshLock`** (so an overlong/excessive request makes
zero lock/discovery/export/write calls):

- **Window span:** `MAX_REQUIRED_COVERAGE_DAYS = Math.max(...ADS_SOURCES.map(s => s.initialDays))` — currently
  **60** (asin / search-terms `initialDays`; derived, so it can never drift from the contracts). A new pure
  `inclusiveDaySpan(from, to)` computes the **inclusive** calendar-day span with strict UTC calendar arithmetic
  (both endpoints are UTC midnights, so leap days and year boundaries are counted naturally). A window whose
  inclusive span exceeds the maximum is rejected; the strict-real-date / `from ≤ to` / non-future checks are
  retained. The intended **30-day PPC window is accepted**; **60 inclusive days accepted, 61 rejected**.
- **Account count (requiredCoverage mode only):** the allowlist must be nonempty and **≤ `MAX_IDS_PER_EXPORT`
  (5)** — one export batch per source, preventing an accidental organization-wide run. **5 accepted, 6
  rejected.** The intended Gate-6 execution remains exactly the **two approved accounts**.

Regressions: `MAX_REQUIRED_COVERAGE_DAYS===60` and `MAX_IDS_PER_EXPORT===5`; `inclusiveDaySpan` across leap-day
and year boundaries; 60-accepted/61-rejected; 5-accepted/6-rejected; the 30-day PPC window accepted;
overlong-window + excessive-account requests rejected **before the lock** with zero lock/discovery/export/write;
malformed rejected before lock; the two-account Gate-6 shape validates.

### R.8 Production-token guards — one source, export ceiling, idempotent skip (fix, 2026-08-15; commit `52f6a3d`)

Three guards so a requiredCoverage canary can never over-spend DataDoe create-export tokens:

- **One source per invocation.** A requiredCoverage run must name **exactly one supported `sourceKey`** (one
  source, one export batch). Zero or multiple keys are rejected **before `claimRefreshLock`** → zero lock /
  discovery / DataDoe / Supabase activity on rejection. The Gate-6 PPC prerequisite therefore runs campaign and
  ASIN as **separate** invocations, each returning its own `completed` + `coverageComplete:true`.
- **Hard recursive export ceiling.** `MAX_REQUIRED_COVERAGE_CREATE_EXPORTS = 3`, threaded as one
  invocation-scoped `{ count, max }` through the recursive fetch and checked **before every create-export POST**.
  Parent-cap + two split children is allowed; a **fourth create fails closed** with a typed/admin-safe
  `ADS_COVERAGE_EXPORT_BUDGET_EXCEEDED` error. On exhaustion: **zero** Ads-row / metric / coverage /
  successful-state writes; the failed state carries **only** the typed code (never in the returned summary); the
  lock releases once. To keep this executable (not a source-text proof), the DI core injects `createExport` +
  `downloadExport` and drives the real recursive `fetchRangeWith`, so the harness exercises the actual ceiling.
- **Durable idempotent completion.** Before exporting an account/source pair, read durable coverage; **skip it
  only** when `evaluateSourceCoverage` proves the complete requested `[from, to]` window **and**
  `ads_sync_state.last_status === "succeeded"`. Skipped pairs count as **successful** in `coverageComplete`; only
  the **missing** account is exported (never a complete one). A fully-covered **replay creates zero exports** and
  returns `completed` + `coverageComplete:true`. A read failure / malformed / unproven / not-succeeded coverage
  **never** authorizes a skip.

| final state table (unchanged from R.5, plus the new terminal causes) | `status` | `coverageComplete` |
|---|---|---|
| every pair fully covered (exported or safely skipped), zero failures | `completed` | `true` |
| a create-export budget exhaustion / invalid evidence / unconfirmed ack | `partial` or `failed` | `false` |
| ≥ 2 or 0 source keys, overlong window, > 5 accounts, malformed options | rejected **before the lock** (throws) | n/a |

Regressions (part of the 40): multiple/zero source keys rejected pre-lock with zero I/O; non-cap uses exactly
one create; parent-cap + two children uses exactly three; deeper split stopped before create #4; budget
exhaustion writes nothing and keeps the typed code out of the summary; exact successful replay creates zero
exports; partial durable coverage exports only the missing account; malformed/read-failed/unproven/thrown
coverage never authorizes a skip. `npm run verify` **37/37 across 17 suites** incl. `build:check`; `git diff
--check` clean; timeout slicing / requiredCoverage semantics / lock release / source IDs / request hashes /
Scheduler-v1 cadence / controls / frontend / routes / migrations **unchanged**. **STOP for Codex review.**
Ads-sync execution / Cycle 2 / unlock / deploy / schedule remain BLOCKED pending review + explicit approval.

---

## Appendix S — Gate-6 Ads coverage prerequisite EXECUTION evidence (2026-08-15; bounded requiredCoverage canary)

Explicitly authorized live task: populate durable `ads_sync_coverage` for EXACTLY the two approved Gate-6
accounts (US `26f7a1a6-…`, IN `d658442d-…`) over the exact window `[2026-07-16 .. 2026-08-14]` (30 inclusive
days — prepares PPC for asOf `2026-08-14`), via FOUR SEPARATE one-source `requiredCoverage` invocations of the
guarded `runAdsSync` (R.1–R.8 contract). Executed from `sales-dashboard-live/` with `node --env-file=../.env.local`
(secrets never printed/committed); `global.fetch` was wrapped in the throwaway runner to count DataDoe calls
(hostname/method/class only — never keys, export ids, rows, or payloads) with a hard tripwire at a 4th
create-export POST. Throwaway scripts removed after execution. **No Cycle 2, no unlock, no deploy, no schedule.**

### S.1 Prechecks (ALL PASS before any write)

HEAD `e8a43e2`; `npm run verify` 37/37; env names present (values never read into evidence); exactly ONE
configured primary connection and NO dd-secondary (nothing to route); both accounts freshly discovered as
primary US/IN; ledger migrations 1–5 exactly once; 13 durable controls `schedule_enabled=false`;
`SCHEDULER_V2_READY_REPORT_KEYS` frozen empty (offline); `pg_cron` absent. Baselines captured (counts +
order-independent narrow-projection digests, selected vs unrelated accounts): `ads_daily_source_rows`
selected 0 / unrelated 265,741; `ad_daily_metrics` 0 / 31,864; `ads_sync_state` 4 (all IN, all `failed`,
cadence timestamps captured) / 192; `ads_sync_coverage` 0 / 0.

### S.2 The four invocations (separate processes, in order; each one source, both accounts, exact window)

| # | source | kind | outcome | create-POSTs (≤3) | rows persisted | durable proof |
|---|---|---|---|---|---|---|
| 1 | `campaign-performance-v1` | required | **`completed` + `coverageComplete:true`, 2/2 pairs, zero failed** | **1** | 4,217 (+`ad_daily_metrics` 4,217) | 2 exact-window `succeeded` coverage rows; both states `succeeded` (lmd US `2026-08-13` / IN `2026-08-14`) |
| 2 | `asin-performance-v1` | required | **`completed` + `coverageComplete:true`, 2/2, zero failed** | **1** | 7,211 | 2 exact-window `succeeded` coverage rows; both states `succeeded` |
| 3 | `keyword-targeting-performance-v1` | optional | `completed` + `coverageComplete:true` (recorded) | **1** | 9,750 | 2 exact-window `succeeded` coverage rows; both states `succeeded` |
| 4 | `search-terms-performance-v1` | optional | `completed` + `coverageComplete:true` (recorded) | **1** | 7,711 | 2 exact-window `succeeded` coverage rows; both states `succeeded` |

Both REQUIRED gates passed independently (status/coverageComplete/pairs/zero-failed/budget/durable checks);
no retry was needed or performed; total 4 create-exports, 28,889 Ads rows.

### S.3 Postchecks (ALL PASS, read-only)

- **Unrelated accounts byte-identical:** counts + digests unchanged across all four tables
  (`ads_daily_source_rows` 265,741; `ad_daily_metrics` 31,864; `ads_sync_state` 192; `ads_sync_coverage` 0).
- **Only the two selected accounts written:** selected rows `ads_daily_source_rows` 0→28,889;
  `ad_daily_metrics` 0→4,217; `ads_sync_state` 4→8 (all `succeeded`); `ads_sync_coverage` 0→**8** (4 sources ×
  2 accounts, all `succeeded`, all exactly `2026-07-16..2026-08-14`).
- **Cadence preserved:** every selected state row's `initial_seeded_at` / `last_daily_sync_at` /
  `last_monthly_sync_at` is unchanged vs the baseline (the IN account's four pre-existing `failed` rows became
  `succeeded` without stamping a cadence run; the US account's four new rows carry null cadence timestamps).
- **PPC gate provably satisfied:** `evaluateSourceCoverage({read:"ok",windows},"2026-07-16","2026-08-14").proven
  === true` for campaign + ASIN on BOTH accounts — the empty-coverage PPC blocker from Appendix P.3 is
  **RESOLVED** for the two Gate-6 accounts.
- Scheduler surfaces untouched: `sync_cycles` still 3 (Gate-5 + two Gate-6 Cycle-1 cycles); 13 controls still
  disabled. Throwaway scripts removed; `npm run verify` 37/37 after; `git diff --check` clean.

**STOP.** Cycle 2 / unlock / deploy / schedule remain BLOCKED pending Codex review + explicit human approval.

---

## Appendix T — Gate-6 Shadow Parity CYCLE 2 EXECUTION evidence (2026-08-15; all 13 reports, both buckets)

Explicitly authorized: Cycle 2 for the SAME two approved accounts (US `26f7a1a6-…`, IN `d658442d-…`), all 13
reports, `asOf 2026-08-14`, `cycleDate 2026-08-16` (pre-verified unused for both buckets; buckets derived by
the canonical `bucketForCountry`). Executed from `sales-dashboard-live/` with `node --env-file=../.env.local`
(secrets never printed/committed); throwaway scripts removed after. **No unlock, deploy, schedule, push, or
control change.**

### T.1 Precheck + plan (before any write)

HEAD `6e528e0`; `npm run verify` 37/37 before AND after; one primary connection, NO dd-secondary; both accounts
freshly discovered (one live discovery, memoized); ledger 1–5 exactly once; 13 controls paused; readiness
allowlist empty; no cron; campaign+ASIN durable coverage RE-PROVEN for both accounts over
`2026-07-16..2026-08-14`; production fingerprints baselined for both accounts + the Gate-5 account (identical
to the Cycle-1 values). OFFLINE plans validated against the authoritative registry (catalog short-id only,
primary-only, per-account seller scope, one owner per family): **us MAX 135 unique hashes (== the ≤135
ceiling), non-us 134**; PPC planned catalog + total-sales on BOTH buckets (validated single-currency signal).

### T.2 Execution + finalization

Bounded resumable slices (maxJobs 8; the per-slice deadline was widened 90s→300s mid-run as an OPERATIONAL
parameter only — the ~125-job sliced plan re-upserts consumed a 90s slice before reaching the staged units;
all semantic guards unchanged). After EVERY slice a DB guard re-proved: ≤1 create-export per hash, total ≤ the
planned MAX, every hash plan-pinned or staged-owner-proven, primary-only, zero ownerless jobs. One transient
runner-level `fetch failed` interrupted one us invocation; the durable state resumed with no duplicate export
(counters continuous). Manual runs never auto-finalize; after full drain + zero open jobs + all-13-planned
checks, `finalize_sync_cycle` was called EXACTLY ONCE per cycle (strict acknowledgement validation passed):

| bucket | cycle | create-exports (actual/MAX) | finalize | source counters | report counters |
|---|---|---|---|---|---|
| us | `b0415a5b-3926-48b0-885e-5dfb61489d74` | **135 / 135** | `finalized`, **`partial`**, `2026-08-15T08:48:30.239541Z` | 135/84/51 | 13/4/9 |
| non-us | `c70879e8-006b-4dba-9896-813106b5aa74` | **133 / 134** | `finalized`, **`succeeded`**, `2026-08-15T08:48:30.959091Z` | **133/133/0** | **13/13/0** |

### T.3 The 26 report outcomes

- **non-us (IN): ALL 13 SUCCEEDED** — brand-sales, buy-box-loss, content-changes, daily-reporting, fba-plan,
  keyword-rank, listing-health, listing-optimizer, **ppc-performance**, reconciliation, returns-leakage,
  sales-movers, sku-pl. The first fully-successful all-13-report Scheduler-v2 cycle.
- **us (US): 4 succeeded** — brand-sales, content-changes, keyword-rank, listing-optimizer; **9
  `SOURCE_BLOCKED`** (buy-box-loss, daily-reporting, fba-plan, listing-health, ppc-performance,
  reconciliation, returns-leakage, sales-movers, sku-pl) — every one caused by DataDoe terminal TIMEOUTs (T.5).

### T.4 Mandatory proofs

- **PPC:** non-us SUCCEEDED with the payload's `sourceAvailability` showing ALL FOUR sources
  `coverageProven:true / coverageFolded:true / "validated"` (campaign 3,754 + ASIN 6,146 default rows folded;
  targeting 8,993 + search 6,290 optional folded per their proven coverage; 25,183 ads rows; single currency
  INR; TACoS denominator present). us PPC was `SOURCE_BLOCKED` by its shared insight-catalog TIMEOUT — the PPC
  machinery itself is proven working end-to-end.
- **asinBrand:** the LATEST brand-sales snapshots for BOTH accounts are **`brand-sales/v2d-2` with 3,190
  asinBrand mappings** (the Cycle-1 v2d-1 rows remain as history under their own params hash). NOTE: the two
  accounts' maps are identical because the Product Catalog dataset is ORGANIZATION-WIDE (DataDoe ignores
  seller scope for it) — the documented, deferred Appendix-M identity design; not a pipeline defect.
- **Sliced windows:** daily superset 27 slices, reconciliation order-lines/settlements 29 each, returns 9 —
  exact canonical ordered/gapless/non-overlapping counts in BOTH cycles (the derive additionally enforces the
  exact sequences; every succeeded sliced report proves them end-to-end).
- **Regressions:** non-us — none (all Cycle-1 successes succeeded again, plus the other 10). us — brand-sales
  succeeded again; **listing-health regressed to `SOURCE_BLOCKED`** (its listings/inventory/catalog exports
  TIMEOUTed THIS cycle after succeeding in Cycle 1 — upstream latency variance; its Cycle-1 shadow snapshot is
  byte-preserved).
- **LKG:** every non-succeeded report preserved its prior shadow snapshot byte-for-byte (updated_at +
  payload_bytes unchanged); production fingerprints byte-identical for BOTH accounts + the Gate-5 account.
- **Owners:** 142/142 (us) + 140/140 (non-us) all active/primary/correctly scoped; ZERO ownerless jobs.
- **Derivation:** zero DataDoe calls (structural import-boundary proof + drained invocations performing derive
  transitions with zero `api.datadoe.com` traffic).

### T.5 Remaining blocker matrix

**Code defects: NONE.** (Two apparent proof failures were artifacts of the throwaway proof script itself —
a snapshot query missing `ORDER BY updated_at DESC` and probing the loader's field name instead of the
payload's — both re-verified clean.)

**DataDoe limitations (all on the US account; 57 failed source-owner rows / 51 unique source jobs, each
`create_export_count=1`, typed safe TIMEOUT, no retry, no second export):** daily superset 11 of 27 ≤7-day
slices; reconciliation order-lines 12/29 + settlements 11/29 slices; returns 4/9 slices; sku-pl 4 whole-month
fragments; fba-plan monthly-units/inventory/catalog/AWD; buy-box daily/inventory/catalog; listing-health
listings/inventory/catalog; sales-movers inventory/catalog; returns traffic/catalog; ppc catalog. The IN
account had ZERO failures over the same window sizes, so the ≤7-day slicing is proven effective — the US
account's exports appear to hit an organization/dataset-level DataDoe processing bottleneck independent of
window size. **The Appendix Q.4 DataDoe questions (processing/row limits, supported partitions) remain the
gating input for US-account stability.**

**STOP.** Unlock / deploy / schedule remain BLOCKED pending Codex review + explicit human approval.

### T.6 Gate-6 completion judgement (recorded 2026-08-15)

- **NON-US: PASS.** All 13 reports derived, validated, and saved (`13/13/0`); the cycle finalized `succeeded`
  with `133/133/0` sources; ZERO code defects; timeout-safe slicing proven effective end-to-end on the IN
  account (zero failures across identical window sizes that time out for the US account).
- **US: PARTIAL.** 4/13 reports succeeded (brand-sales, content-changes, keyword-rank, listing-optimizer;
  T.3); the cycle finalized `partial` with `135/84/51` sources. Every failure is a US-account DataDoe export
  TIMEOUT (typed, no retry, one create per hash); NONE is a scheduler code defect. The Appendix Q.4 DataDoe
  questions remain the gating input.
- **GLOBAL UNLOCK: NOT APPROVED.** No report key enters `SCHEDULER_V2_READY_REPORT_KEYS`, all 13
  `report_sync_settings` rows stay `schedule_enabled=false`, and nothing is deployed or scheduled. The
  judgement permits ONLY preparing an account-bounded (IN-only) rollout foundation — implemented OFFLINE and
  INERT in Appendix U, with the prepared-but-NOT-executed enable package in Appendix V.

---

## Appendix U — Gate-7 productionization foundation (2026-08-15; OFFLINE code/tests only; migration PREPARED — NOT APPLIED)

Implements the account-bounded rollout foundation the T.6 judgement permits: the proven IN account can LATER
be enabled to run and publish Scheduler-v2 reports while the US and every unrelated account remain untouched,
with a separate explicit all-primary switch preserved for the eventual full rollout. **Migration 6 is now
APPLIED (Gate 7a — Appendix X), so the tables/constraints/triggers exist; the foundation is still INERT at the
DATA layer: `scheduler_account_rollout` + `scheduler_publish_approvals` are EMPTY and `scheduler_rollout_mode`
is the seeded `(1, all_primary=false)`, so ZERO accounts are selected and NOTHING is approved.** The reviewed
IN-only enable sequence (write the durable rows, enable settings, publish one report at a time) is the SEPARATE
Gate-7b package (Appendix Y); Appendix V is retained as the original prepared plan.

### U.1 Migration 6 — `20260816_account_rollout.sql` (**APPLIED 2026-08-15 via Appendix X**; frozen SHA-256 `bd03301ce71c13db419cf950e537c46f4e1fe7d8fd2c8291952c667ac61457a7`; the `.sql` file's "PREPARED — UNAPPLIED" header comment is historical review text kept to preserve the frozen hash — the ledger row is authoritative)

Three ADDITIVE tables (no existing table/RPC/trigger/policy touched; RLS enabled with NO policies;
`select/insert/update` granted to `service_role` only; the shared `scheduler_rollout_touch()` BEFORE UPDATE
trigger maintains `updated_at`):

| table | key | columns | default state |
|---|---|---|---|
| `scheduler_account_rollout` | `account_id` (text PK) | `enabled bool DEFAULT false`, `note`, timestamps | zero rows => ZERO accounts |
| `scheduler_rollout_mode` | `id smallint PK` | `all_primary bool DEFAULT false` | seeded single row `(1,false)` |
| `scheduler_publish_approvals` | `(report_key, account_id)` PK | `approved bool DEFAULT false`, `approved_by NOT NULL`, `approved_at NOT NULL`, timestamps | zero rows => NOTHING approved |

**DB-enforced audit-integrity constraints (correction tranche; each proven by an exact table-scoped named
CHECK in the static schema audit — removal or weakening is a typed `NAMED_CONSTRAINT_MISSING` blocker):**

| constraint | table | enforces |
|---|---|---|
| `…_account_id_nonblank` | scheduler_account_rollout | `char_length(btrim(account_id)) > 0` |
| `…_account_id_canonical` | scheduler_account_rollout | `account_id = btrim(account_id)` — no leading/trailing whitespace |
| `…_account_id_primary_only` | scheduler_account_rollout | `account_id NOT LIKE 'dd-secondary:%'` |
| `scheduler_rollout_mode_singleton` | scheduler_rollout_mode | `id = 1` |
| `…_report_key_nonblank` | scheduler_publish_approvals | `char_length(btrim(report_key)) > 0` |
| `…_report_key_canonical` | scheduler_publish_approvals | `report_key = btrim(report_key)` |
| `…_account_id_nonblank` | scheduler_publish_approvals | `char_length(btrim(account_id)) > 0` |
| `…_account_id_canonical` | scheduler_publish_approvals | `account_id = btrim(account_id)` |
| `…_account_id_primary_only` | scheduler_publish_approvals | `account_id NOT LIKE 'dd-secondary:%'` |
| `…_approved_by_canonical` | scheduler_publish_approvals | `approved_by = btrim(approved_by)` |
| `scheduler_publish_approvals_audited` | scheduler_publish_approvals | `char_length(btrim(approved_by)) > 0 AND approved_at IS NOT NULL` — EVERY decision row (approval OR revocation) carries WHO and WHEN |

The **eleven** named constraints are all proven `true` by the static audit (test EM1); removal of any is a typed
`NAMED_CONSTRAINT_MISSING` blocker and a weakened CHECK body fails the exact-token comparison (tests EM2/EM3).
The rollout reader (`getSchedulerAccountRollout`) and the pure resolver (`resolveRolloutAccounts`) additionally
FAIL CLOSED on a noncanonical durable id at read time (a `noncanonical-id` read / `rollout-noncanonical-id`
resolver reason ⇒ zero accounts) — a whitespace-padded id is NEVER trimmed into a different account — and
`buildSchedulerV2CanaryRuntime` rejects (never normalizes) whitespace-padded, blank, dd-secondary, or DUPLICATE
reviewed ids at compose time.

The static schema contract (`schema-contract.js`) carries the migration-6 entry (tables + the seven named
constraints above) plus the REQUIRED wrapper exports (now also `getLatestSyncReportJob`, `getReportSnapshot`,
`getReportSnapshotStoragePayload`), so the no-side-effect preflight audits the pairing exactly like
migrations 1–5.

### U.2 Durable account-rollout semantics (one shared implementation)

`getSchedulerAccountRollout()` (supabase.js) returns the TYPED state
`{ read: "ok"|"schema-missing"|"read-failed", allPrimary, enabledAccountIds }` and never throws. The PURE
resolver `resolveRolloutAccounts(state, discoveredPrimary)` (`lib/server/sync/account-rollout.js`) is the
ONLY selection implementation:

- `read !== "ok"` => ZERO accounts (a read/schema failure can never widen scope);
- default durable state (no enabled rows, `all_primary=false`) => ZERO accounts;
- allowlist mode => ONLY discovered ACTIVE PRIMARY accounts whose EXACT public id has an `enabled=true` row —
  no wildcard, no prefix/case matching, no implicit fallback; stale/unknown rows match nothing, spend nothing,
  and are reported as `staleIds`;
- `all_primary=true` (separate deliberate durable switch) => EVERY discovered primary account, so a newly
  connected primary account joins automatically with NO code change;
- `dd-secondary:`-prefixed ids are rejected on BOTH sides (discovered account AND allowlist row) — a stale
  secondary can never enter scheduled scope or be routed through the primary key.

This gate is ADDITIONAL to (and independent of) report-level readiness: `SCHEDULER_V2_READY_REPORT_KEYS`
(still frozen EMPTY) and the 13 paused `report_sync_settings` rows are unchanged and unweakened.

### U.3 Trusted runtime enforcement (EVERY dispatch — scheduled AND manual; correction tranche)

`buildSchedulerV2Runtime` composes `loadAccountRollout` from the trusted wrapper; it is NOT in
`RUN_OPERATIONAL_ARGS`, so a per-run caller can never supply, replace, or bypass it (proven by test). The
dispatcher (`runSchedulerV2Shadow`):

1. EVERY dispatch — scheduled AND production-manual — WITHOUT the trusted loader REFUSES to run (fail
   closed, zero I/O). `manualReportKeys` selects REPORTS only; it can never widen ACCOUNT scope.
2. The rollout state is loaded BEFORE discovery; a failed read OR a state whose allowlist normalizes to zero
   valid ids returns a `drained:true, spent:0` no-op with ZERO discovery/cycle/store/DataDoe work.
3. After primary-only classification, the resolver filters the bucket's accounts BEFORE `openCycle`/source
   planning; zero selected => the same zero-write drained no-op. The rollup records
   `accountRollout: { selected, staleIds, reason }`.
4. Isolated shadow canaries use the BUILD-TIME trusted canary composition `buildSchedulerV2CanaryRuntime`:
   the operator's reviewed EXACT account ids are fixed at composition time (nonblank, primary-only —
   dd-secondary/blank/empty inputs refuse to compose), become the composed rollout state, and are STILL
   intersected with FRESH primary discovery on every run (an undiscovered id selects nothing). There is NO
   per-run account-scope argument and NO rollout bypass anywhere in the ordinary runtime.

### U.4 Reviewed shadow-to-live publisher (DISABLED BY DEFAULT; nothing invokes it; correction tranche)

The PURE core `lib/server/sync/report-publisher.js` (`publishSchedulerV2Snapshot(deps, …)`) promotes ONE
validated `scheduler-v2/<reportKey>` shadow snapshot to the EXACT live `report_snapshots` identity the
frontend reads; the TRUSTED production composition `lib/server/sync/publisher-composition.js`
(`buildSchedulerV2Publisher()`) binds every collaborator at BUILD time and exposes ONLY
`publish(reportKey, accountId)` — two identifier strings; a publish() caller can inject NOTHING (no code
readiness, no discovery, no rollout/approval readers, no persistence). Publishing requires ALL FOUR
independent gates (each fails closed):

1. **Code readiness** — the key is in `SCHEDULER_V2_READY_REPORT_KEYS` (frozen EMPTY => disabled today);
2. **Durable report enable** — `report_sync_settings.schedule_enabled === true`;
3. **Durable account enable** — the durable rollout state is resolved against REAL FRESH primary discovery
   (ONE memoized directory read per composition; never a synthetic record): the requested id must be a
   CURRENTLY DISCOVERED active primary account the state selects. An undiscovered/stale id and every
   dd-secondary id fail here — including under `all_primary=true`;
4. **Explicit publish approval** — `scheduler_publish_approvals.approved === true` for the exact
   `(report_key, account_id)`.

Source-of-truth gate (exact job snapshot binding): the LATEST report job must have `validated=true`,
`derive_status='succeeded' AND save_status='succeeded'`, a TERMINAL cycle (`succeeded`, or `partial` with
that exact report succeeded), AND a nonblank `snapshot_params_hash`. The shadow snapshot is then loaded by
the EXACT natural identity that job saved — `(scheduler-v2/<reportKey>, accountId, job.snapshot_params_hash)`
— never an unrelated "latest" row. **HASH PROVENANCE (correction tranche 2):** the publisher recomputes
`paramsHashFor(params.reportVersion, params)` EXACTLY as `makeShadowSnapshotSaver` did and requires the
recomputed hash, the returned row's `params_hash`, AND `job.snapshot_params_hash` to be ALL identical — a row
whose stored params were mutated after saving (same hash, different params) fails here, BEFORE any hydration
or publish (job A can never authorize snapshot B; blank/missing/mismatched hashes never publish). The row must
also match the derivation `snapshotVersion`, the exact account, and carry a nonblank `source_refreshed_at`.
**STRICT calendar-date params (correction tranche 2):** the 13 live-param builders use the shared
`isValidCalendarDate` validator (impossible dates — `2026-02-30`, `2026-13-01`, a non-leap Feb 29 — rejected)
and every `from/to` contract additionally requires `from <= to`; each of the 13 exact live param shapes is
preserved. A storage-backed payload (`payload NULL` + `payload_storage_path`) hydrates through the trusted
storage loader; a missing/unreadable object fails CLOSED (live LKG preserved). The hydrated/inline payload
must pass the derivation's own `validatePayload` and must NOT declare `dataUnavailable:true`; the live params
builder fails closed on any missing/malformed planned param.

The write is the CAS primitive `publishLiveSnapshotIfNewer` (supabase.js): INSERT-if-absent on the natural
key `(report_key, account_id, params_hash)`; on conflict it READS the live row and classifies by SOURCE
FRESHNESS, fail-closed — **equal freshness is NEVER an unconditional overwrite (correction tranche 2):**

| live vs candidate `source_refreshed_at` | live-vs-candidate content | outcome | write | disposition |
|---|---|---|---|---|
| absent (row did not exist) | — | `inserted` | insert | `published` |
| strictly OLDER | — | `replaced` (guarded PATCH `lt`; clears `payload_storage_path`) | replace | `published` |
| strictly NEWER | — | `newer-live` | none | `newer-live` |
| EQUAL | canonically IDENTICAL params AND payload (live payload hydrated when storage-backed) | `already-current` | none | `already-current` |
| EQUAL | DIFFERENT params/payload/storage content, OR live payload unprovable (unreadable/missing) | `conflict` | none | `publish-conflict` |

Content identity uses deterministic canonical-JSON comparison entirely inside the primitive — a payload,
storage path, or digest is NEVER returned to a caller (only the typed outcome). A `publish-conflict` leaves the
live LKG byte-identical; the safe remediation is a FRESH shadow cycle with NEWER source evidence (never an
equal-timestamp overwrite). Live last-known-good is preserved on EVERY failure. Typed safe dispositions only
(`PUBLISH_DISPOSITIONS`, now including `publish-conflict`); live params hashing uses the live `paramsHashFor`
and the live stored-params shape `{ reportVersion, ...params }`. NO api route, cron, or dispatcher path imports
the publisher OR the composition (structurally tested); no browser route can promote.

The 13 canonical mappings (transcribed from the executable live routes — `api/datadoe.js`
`sharedSnapshotSpec` + the six insight `serveSharedReport` sites — and statically pinned by tests F1–F3):

| scheduler report | live `report_key` | live `reportVersion` | live params |
|---|---|---|---|
| brand-sales | brand-sales | brand-sales-shared-v1 | `{ from, to }` |
| daily-reporting | daily-reporting | daily-reporting-shared-v1 | `{ from, to, brand }` (`"ALL"` default) |
| reconciliation | reconciliation | reconciliation-shared-v1 | `{ from, to }` |
| sku-pl | sku-pl | sku-pl-shared-v1 | `{ from, to }` |
| keyword-rank | keyword-rank | keyword-rank-shared-v1 | `{ to }` |
| content-changes | content-changes | content-changes-shared-v1 | `{ asOf }` (the planner's `to`) |
| fba-plan | fba-plan | fba-plan-shared-v1 | `{ to }` |
| sales-movers | sales-movers | sales-movers-v1 | `{ to }` |
| listing-health | listing-health | listing-health-v1 | `{ to }` |
| buy-box-loss | buy-box-loss | buy-box-loss-v1 | `{ to }` |
| returns-leakage | returns-leakage | returns-leakage-v1 | `{ to }` |
| ppc-performance | ppc-performance | ppc-performance-v1 | `{ to }` |
| listing-optimizer | listing-optimizer | listing-optimizer-v1 | `{ to }` |

### U.5 Executable regression evidence (offline; zero I/O; correction tranche 2 + ACL correction)

`scripts/gate7-rollout-publisher.test.js` — **45 checks** in 9 groups (registered in `package.json` +
`scripts/verify.mjs`): (A) pure resolver fail-closed semantics; (B) dispatcher enforcement — default
locked/empty controls = zero I/O, missing-loader refusal for EVERY dispatch, read-failure fail-closed
(zero discovery/cycle/store/DataDoe I/O), zero-default drain, ONLY IN selected from a 30-account discovery
with every write account-scoped, the same allowlist leaving the US bucket untouched, dd-secondary excluded
via both vectors, stale rows spending zero, all-primary auto-including a new primary account, a NONCANONICAL
durable id draining BEFORE discovery (B4b), a MANUAL production run unable to bypass the rollout (B10:
refusal without the loader, zero-default drain, read-failure drain, allowlist-bounded manual accounts), the
build-time canary composition (B11: exact reviewed ids run, undiscovered ids select nothing,
blank/empty/dd-secondary/**whitespace/duplicate** inputs refuse to compose, per-run widening attempts
dropped); the pure resolver fails closed on a noncanonical durable id (A2b); (C) `RUN_OPERATIONAL_ARGS`
pinned + a malicious per-run override dropped by the composed runtime; (D) wrapper typed reads (incl. the
reader failing closed on a noncanonical durable id) + the CAS primitive's full freshness matrix against
stubbed fetch — insert / strictly-older guarded replace (clears `payload_storage_path`) / strictly-newer
zero-write / EQUAL-freshness canonical identity (already-current when proven identical INLINE or hydrated
from storage; `publish-conflict` on differing params/payload/storage or unreadable storage); (E) the
publisher's default code lock, all four gates, the REAL-discovery account gate (undiscovered /
all-primary-undiscovered / discovered-dd-secondary can never publish), the exact job snapshot binding with
HASH PROVENANCE (unvalidated / hash-less jobs never publish; a mismatched `params_hash` echo AND a
recompute-mismatch — mutated stored params — never publish; E6b), storage-backed hydration (exact job-linked
inline AND storage-backed snapshots publish; missing/unreadable/truncated/unavailable hydrations preserve
live LKG), exactly-once publish, idempotent replay, newer-live-wins, EQUAL-freshness content mismatch =>
`publish-conflict`, typed transport-failure disposition; (EC) the trusted publisher composition — default
composition code-locked, `publish()` caller can inject nothing, ONE memoized fresh discovery across
publishes; (EM) migration-6 audit integrity — the real migration proves all **11** named constraints;
removing OR weakening the audited-decision / prefix-rejection / **canonical-identity** constraints is a typed
`NAMED_CONSTRAINT_MISSING` blocker, and each canonical constraint is proven table-scoped/exact/mandatory
(EM3); **least-privilege `service_role` ACL — all three tables prove REVOKE-ALL-from-`service_role` + exactly
`{select,insert,update}`, and the missing-revoke / GRANT-ALL / added-DELETE / wrong-table / comment-only /
string-only mutations each fail with a typed `SERVICE_ROLE_*` blocker (EM4)**; (F) the 13 contracts statically
pinned against `api/datadoe.js` literals and the live insight modules'
exported constants, plus STRICT calendar-date validation (impossible dates + reversed `from/to` rejected;
leap-day + boundaries pass; F2b); (G) structural isolation (no api/ reference to the publisher / composition
/ rollout / CAS primitive; the dispatcher never auto-publishes) **plus the rollout-table wrapper privilege
proof (G3): the runtime wrappers only READ the three tables (no POST/PATCH/DELETE), so SELECT/INSERT/UPDATE
suffices and DELETE/TRUNCATE are never needed**. Existing suites updated only in their
HARNESS defaults (all-primary loader injection): `sync-dispatch.test.js` 37, `sync-runtime-composition.test.js`
26, `cycle-lifecycle.test.js` 16, `cycle-finalize-wiring.test.js` 14 — all green; full `npm run verify` green
(38 steps / 18 suites including `build:check`).

---

## Appendix V — Gate-7 IN-only rollout package (SUPERSEDED by Appendix Y; retained for history)

**SUPERSEDED:** the operational IN cutover is now the Gate-7b package in **Appendix Y** (all-13 IN cutover;
readiness is a single reviewed CODE flip rather than a per-report readiness edit). **Migration 6 is APPLIED
(Gate 7a — Appendix X), so this appendix's migration-apply step is DONE.** Appendix V is kept as the original
prepared plan; execute **Appendix Y** instead. Nothing further in this appendix has been run beyond the
already-completed migration apply.

Let `IN_ACCOUNT` = the exact public account id of the proven IN primary account (`d658442d-…` — the full id
is re-read from live discovery at execution time; never guessed or hard-coded). **Every durable id written
below (`account_id`, `report_key`, `approved_by`) must be CANONICAL — no leading/trailing whitespace: the
migration-6 `= btrim(...)` constraints reject a noncanonical value, and the reader/resolver fail closed on
one rather than trimming it into a different account.**

1. **Migration 6 is already APPLIED** (`20260816_account_rollout.sql`; Gate 7a — Appendix X). The three tables
   exist with RLS enabled, zero policies, `scheduler_rollout_mode` = exactly `(1, all_primary=false)`, and the
   other two tables empty; `service_role` holds exactly SELECT/INSERT/UPDATE. No migration step remains here.
   At this point the system is STILL fully off at the data layer (the zero-account default, proven by Y2).
2. **Preflight** — run the no-side-effect runtime preflight; the migration-6 schema-contract entry and the
   wrappers must audit clean.
3. **Enable the IN account (allowlist row):** insert into `scheduler_account_rollout` the single row
   `(account_id='<IN_ACCOUNT>', enabled=true, note='Gate-7 IN-only rollout — approved <date>')`.
   Verify: exactly ONE enabled row; `all_primary` still false. Scheduled runs remain no-ops (every report is
   still locked + paused).
4. **Per-report enable, ONE report at a time** (starting with `brand-sales`, the deepest-verified report):
   add the key to `SCHEDULER_V2_READY_REPORT_KEYS` (code review + deploy gate) and set its ONE
   `report_sync_settings.schedule_enabled=true` row. Verify a scheduled shadow run selects exactly
   (report x IN account) and nothing else.
5. **Publish approval, ONE (report, account) at a time:** insert into `scheduler_publish_approvals` the row
   `(report_key='<report>', account_id='<IN_ACCOUNT>', approved=true, approved_by='<operator>',
   approved_at=now())` — `approved_by`/`approved_at` are DB-REQUIRED on every decision row (U.1) — then
   invoke `buildSchedulerV2Publisher().publish('<report>', '<IN_ACCOUNT>')` from a trusted operator context
   (NEVER a browser route; the composition takes exactly those two identifier strings and nothing else),
   expecting `published`, and verify the live row via its natural key + the frontend's own route. The live
   fingerprint procedure (section 4) brackets the first publish.
6. **Rollback at ANY point:** set the allowlist row `enabled=false` / record an explicit audited REVOCATION
   (`update scheduler_publish_approvals set approved=false, approved_by='<operator>', approved_at=now()
   where report_key='<report>' and account_id='<IN_ACCOUNT>'` — a revocation is a decision row too, so it
   carries WHO and WHEN) / remove the report key — each independently returns the system to fail-closed zero
   with no code change and no data loss (live LKG rows untouched).
7. **Isolated canaries during the rollout** use the BUILD-TIME trusted canary composition
   (`buildSchedulerV2CanaryRuntime({ canaryAccountIds: ['<IN_ACCOUNT>'] })`) — the reviewed exact ids are
   fixed at composition time and validated against fresh primary discovery on every run; there is no per-run
   account-scope argument anywhere.

The all-primary switch (`scheduler_rollout_mode.all_primary=true`) is NOT part of this package; it is a
separate future gate requiring its own review after US-account DataDoe stability (Q.4) is resolved.

**STOP.** Gate-7 hands back for Codex review. No migration applied, no row written, no unlock, no publish,
no deploy, no schedule.

---

## Appendix W — Gate 7a APPLY package: apply ONLY `20260816_account_rollout.sql` (**EXECUTED 2026-08-15 — see Appendix X for evidence**)

> **This package was EXECUTED 2026-08-15 (Appendix X): W.0/W.1/W.2/W.4 all PASSED and Migration 6 is now
> APPLIED.** It is retained verbatim as the reviewed procedure. It is the exact
> package a reviewer/operator executes **only after explicit written human approval**, one migration file only,
> then STOPS for W.4. It follows the reviewed single-file gate shape of Migration 5 (Appendix O) and Migration 1
> (Appendix B), hardened per Codex re-review: the verification steps are **genuinely read-only** (executed inside
> `BEGIN; SET TRANSACTION READ ONLY; … ROLLBACK`, rolled back even on an assertion failure), every object check
> is **scoped to the exact `public` relation/function OID** (a same-named object in another schema can neither
> PASS nor false-STOP), the unchanged-data claim is backed by **deterministic count+content digests** compared
> before/after the apply (never "counts alone"), and the **complete table ACL** is enumerated and asserted
> before COMMIT.

**Working directory + connection:** run every command below from **`sales-dashboard-live/`** (where `pg` resolves
and the git-ignored `../.env.local` holds `POSTGRES_URL`). Each runner is a throwaway `.mjs` file created via a
quoted heredoc and **removed after** (never committed). **Do NOT use `npm run db:migrate`** — it would bulk-apply;
Gate 7a is single-file, advisory-locked, hash-verified, ledger-fail-closed. There is no Scheduler-v2 kickoff/cron
migration present, so no schedule can be applied here regardless. No `DROP`, no retry, no destructive repair.

### W.0 Offline preflight (must ALL PASS before connecting)

- **HEAD** on `feature/scheduler-v2` includes **`85d49a0`** — Gate 7 passed final Codex review at this HEAD.
- **Frozen input SHA-256 (re-verify byte-for-byte before connecting; the W.2 apply re-checks #6 in-process):**

```
1328bc0fdbe430670d2ea1dc8bdf4b1a223feb04cd6eb5c0080ef26a1bdc691e  supabase/migrations/20260807_scheduler_v2.sql        (migration 1 — FROZEN)
0750a155a0c46a6e6ae3d24cea7835b8840f0e2c3a0d22670b595222d859b724  supabase/migrations/20260810_ads_sync_coverage.sql   (migration 2 — FROZEN)
544557fb29b1ae8e03e9c8d263d8b2fba73853853273f30c517cbc30938bea4c  supabase/migrations/20260810_report_sync_controls.sql(migration 3 — FROZEN)
49628c8d701b3d1ca3b22b131bd8d8f8122585cd0461133f094a7a0154d98669  supabase/migrations/20260811_sync_source_job_owners.sql(migration 4 — FROZEN)
5222a8e55c89bbcb21fe10b9f1f755d795aecee69f4ac0d5a15c61d459823759  supabase/migrations/20260815_sync_cycle_finalize.sql (migration 5 — FROZEN)
bd03301ce71c13db419cf950e537c46f4e1fe7d8fd2c8291952c667ac61457a7  supabase/migrations/20260816_account_rollout.sql     (migration 6 — THE ONE TO APPLY)
```

- `SCHEDULER_V2_READY_REPORT_KEYS` still **frozen empty** (`Object.freeze([])` in
  `lib/server/sync/report-controls.js`) — a code check, not a DB object; re-grep before apply.
- `npm run verify` green (38 steps / 18 suites incl. `build:check`); `git diff --check` clean; working tree only
  `HANDOFF.md` + `.worktrees/` untracked.
- `POSTGRES_URL` present + nonblank in `../.env.local` (checked by NAME only; never printed).

**STOP** if HEAD does not contain `85d49a0`, any of the six hashes differs, the readiness allowlist is non-empty,
`verify`/`diff --check` is not clean, or `POSTGRES_URL` is absent.

### W.1 Pre-apply read-only inventory (genuinely read-only; rolls back always)

`gate7a-w1-inventory.mjs` runs inside `BEGIN; SET TRANSACTION READ ONLY` and **always ROLLBACKs** (in a
`finally`, even when an assertion throws), so it can never write. Every existence/absence check is scoped to the
exact `public` OID; each Migration-5 no-append trigger is proven on its exact table OID + guard-function OID with
`tgenabled='O'` and `tgtype=23`. Before capturing the baseline it asserts the **KNOWN lifecycle: EXACTLY the five
recorded terminal cycles** (ids / status / source+report counters / non-null `finished_at`, no extra or running
cycle). It then captures and PRINTS the unchanged-data **BASELINE** (`cycles_count`/`cycles_digest`/`snap_count`/
`snap_digest`) — record that line; W.4 re-checks against it. **STOP on any thrown assertion** (the exact reason
prints); do not apply.

```bash
cat > gate7a-w1-inventory.mjs <<'NODE'
import pg from "pg";
const M6 = "20260816_account_rollout.sql";
const PRIOR = ["20260807_scheduler_v2.sql","20260810_ads_sync_coverage.sql","20260810_report_sync_controls.sql",
               "20260811_sync_source_job_owners.sql","20260815_sync_cycle_finalize.sql"];
const M6_TABLES = ["public.scheduler_account_rollout","public.scheduler_rollout_mode","public.scheduler_publish_approvals"];
const M6_TRIGGERS = ["scheduler_account_rollout_touch","scheduler_rollout_mode_touch","scheduler_publish_approvals_touch"];
const M6_CONSTRAINTS = ["scheduler_account_rollout_account_id_nonblank","scheduler_account_rollout_account_id_canonical",
  "scheduler_account_rollout_account_id_primary_only","scheduler_rollout_mode_singleton",
  "scheduler_publish_approvals_report_key_nonblank","scheduler_publish_approvals_report_key_canonical",
  "scheduler_publish_approvals_account_id_nonblank","scheduler_publish_approvals_account_id_canonical",
  "scheduler_publish_approvals_account_id_primary_only","scheduler_publish_approvals_approved_by_canonical",
  "scheduler_publish_approvals_audited"];
const NOAPPEND = [["sync_source_jobs_no_append_terminal","public.sync_source_jobs"],
                  ["sync_source_job_owners_no_append_terminal","public.sync_source_job_owners"],
                  ["sync_report_jobs_no_append_terminal","public.sync_report_jobs"]];
const OPS = { sync_cycles:18, sync_source_jobs:27, sync_report_jobs:25, sync_source_job_owners:15 };
// The KNOWN pre-apply lifecycle: exactly these five terminal cycles [status, s_total,s_ok,s_fail, r_total,r_ok,r_fail].
const CYCLES = {
  "57afc1fb-6694-4925-8961-4730f5a8f4df": ["succeeded", 2, 2, 0, 1, 1, 0],
  "56422a66-9f23-43c9-9c8d-8a9427f8f36a": ["partial", 57, 44, 13, 13, 2, 11],
  "ac4cba6f-3214-4d9b-9be7-35c572890edf": ["partial", 56, 39, 17, 13, 3, 10],
  "b0415a5b-3926-48b0-885e-5dfb61489d74": ["partial", 135, 84, 51, 13, 4, 9],
  "c70879e8-006b-4dba-9896-813106b5aa74": ["succeeded", 133, 133, 0, 13, 13, 0],
};
// Deterministic unchanged-data digest: per-row md5 over the WHOLE row (payload content included), aggregated in
// a stable order. Only the 32-char md5 is emitted -- NEVER a payload/path.
const DIGEST_SQL =
  "select (select count(*)::int from public.sync_cycles) as cycles_count," +
  " coalesce((select md5(string_agg(rh, ',' order by k)) from" +
  "   (select id::text k, md5(sc::text) rh from public.sync_cycles sc) q), 'EMPTY') as cycles_digest," +
  " (select count(*)::int from public.report_snapshots where report_key like 'scheduler-v2/%') as snap_count," +
  " coalesce((select md5(string_agg(rh, ',' order by k)) from" +
  "   (select (report_key||'/'||account_id||'/'||params_hash) k, md5(rs::text) rh" +
  "      from public.report_snapshots rs where report_key like 'scheduler-v2/%') q), 'EMPTY') as snap_digest";
const ok = (cond, msg) => { if (!cond) throw new Error("STOP: " + msg); };
const url = new URL(process.env.POSTGRES_URL); url.searchParams.set("sslmode", "no-verify");
const c = new pg.Client({ connectionString: url.toString() });
await c.connect();
try {
  await c.query("begin");
  await c.query("set transaction read only");   // GENUINE read-only: any write below would throw.

  // Ledger: table present; migrations 1-5 each exactly once; Migration 6 absent.
  ok((await c.query("select to_regclass('public.app_schema_migrations') is not null e")).rows[0].e, "app_schema_migrations ledger absent");
  for (const f of PRIOR) {
    const n = (await c.query("select count(*)::int c from public.app_schema_migrations where filename=$1", [f])).rows[0].c;
    ok(n === 1, "prerequisite migration " + f + " has " + n + " ledger rows (expected 1)");
  }
  ok((await c.query("select count(*)::int c from public.app_schema_migrations where filename=$1", [M6])).rows[0].c === 0,
     M6 + " already recorded (Gate 7a is the FIRST apply)");

  // Migration-6 target objects ABSENT, each PUBLIC-scoped (a same-named object in another schema never matches).
  for (const t of M6_TABLES) ok((await c.query("select to_regclass($1) o", [t])).rows[0].o === null, "target table " + t + " already exists");
  ok((await c.query("select to_regprocedure('public.scheduler_rollout_touch()') o")).rows[0].o === null, "public.scheduler_rollout_touch() already exists");
  ok((await c.query("select count(*)::int c from pg_trigger t join pg_class rel on rel.oid=t.tgrelid" +
     " join pg_namespace n on n.oid=rel.relnamespace where not t.tgisinternal and n.nspname='public' and t.tgname=any($1)", [M6_TRIGGERS])).rows[0].c === 0,
     "a Migration-6 trigger already exists on a public relation");
  ok((await c.query("select count(*)::int c from pg_constraint con join pg_namespace n on n.oid=con.connamespace" +
     " where n.nspname='public' and con.conname=any($1)", [M6_CONSTRAINTS])).rows[0].c === 0,
     "a Migration-6 named constraint already exists in public");

  // Prerequisites present.
  ok((await c.query("select to_regclass('public.report_sync_settings') o")).rows[0].o !== null, "report_sync_settings missing");
  ok((await c.query("select to_regclass('auth.users') o")).rows[0].o !== null, "auth.users missing");
  const roles = (await c.query(
    "select rolname::text rolname from pg_roles where rolname in ('service_role','anon','authenticated') order by rolname"
  )).rows.map((r) => r.rolname);
  ok(
    JSON.stringify(roles) === JSON.stringify(["anon", "authenticated", "service_role"]),
    "expected exactly anon/authenticated/service_role, got [" + roles.join(",") + "]"
  );

  // Operational Scheduler-v2 tables present + exact column counts; ads_sync_coverage present.
  for (const [t, cols] of Object.entries(OPS)) {
    const n = (await c.query("select count(*)::int c from information_schema.columns where table_schema='public' and table_name=$1", [t])).rows[0].c;
    ok(n === cols, "public." + t + " has " + n + " columns (expected " + cols + ")");
  }
  ok((await c.query("select to_regclass('public.ads_sync_coverage') o")).rows[0].o !== null, "ads_sync_coverage missing");

  // Gate-5/6 evidence: finalize RPC present; each no-append trigger on its EXACT table, executing the EXACT
  // guard function -- proven by OID (tgrelid + tgfoid), never by name.
  ok((await c.query("select to_regprocedure('public.finalize_sync_cycle(uuid)') o")).rows[0].o !== null, "finalize_sync_cycle(uuid) missing");
  ok((await c.query("select to_regprocedure('public.reject_append_to_terminal_cycle()') o")).rows[0].o !== null, "reject_append_to_terminal_cycle() missing");
  for (const [trig, tbl] of NOAPPEND) {
    const r = (await c.query("select t.tgenabled, t.tgtype, (t.tgrelid = $2::regclass) rel_ok," +
      " (t.tgfoid = to_regprocedure('public.reject_append_to_terminal_cycle()')) fn_ok" +
      " from pg_trigger t where not t.tgisinternal and t.tgname=$1 and t.tgrelid=$2::regclass", [trig, tbl])).rows;
    ok(r.length === 1, "no-append trigger " + trig + " not found on exactly " + tbl);
    ok(r[0].rel_ok === true, trig + " not on the exact public table OID " + tbl);
    ok(r[0].fn_ok === true, trig + " does not execute public.reject_append_to_terminal_cycle by OID");
    ok(r[0].tgenabled === "O", trig + " not enabled (tgenabled=" + r[0].tgenabled + ")");
    ok(Number(r[0].tgtype) === 23, trig + " tgtype=" + r[0].tgtype + " (expected 23 = ROW|BEFORE|INSERT|UPDATE)");
  }

  // Exactly 13 report controls, ALL paused.
  const ctrl = (await c.query("select count(*)::int total, count(*) filter (where schedule_enabled)::int enabled from public.report_sync_settings")).rows[0];
  ok(ctrl.total === 13, "expected 13 report controls, got " + ctrl.total);
  ok(ctrl.enabled === 0, ctrl.enabled + " report control(s) schedule_enabled=true (expected 0)");

  // No Scheduler-v2 pg_cron schedule.
  const cronInstalled = (await c.query("select to_regclass('cron.job') is not null e")).rows[0].e;
  let cronJobs = 0;
  if (cronInstalled) cronJobs = (await c.query("select count(*)::int c from cron.job")).rows[0].c;
  ok(cronJobs === 0, cronJobs + " cron job(s) present (expected 0)");

  // KNOWN pre-apply lifecycle: EXACTLY the five recorded terminal cycles, exact counters, every finished_at
  // non-null, and NO extra cycle -- validated BEFORE the baseline digest is captured/trusted.
  const cyc = (await c.query("select id::text id, status s, source_total st, source_succeeded ss, source_failed sf," +
    " report_total rt, report_succeeded rs, report_failed rf, (finished_at is not null) fin from public.sync_cycles")).rows;
  ok(cyc.length === 5, "expected EXACTLY 5 sync_cycles, got " + cyc.length);
  for (const id of Object.keys(CYCLES)) ok(cyc.some((r) => r.id === id), "missing expected sync_cycle " + id);
  for (const r of cyc) {
    const e = CYCLES[r.id];
    ok(e !== undefined, "unexpected sync_cycle " + r.id);
    ok(r.s === e[0], r.id + " status " + r.s + " (expected " + e[0] + ")");
    ok(Number(r.st) === e[1] && Number(r.ss) === e[2] && Number(r.sf) === e[3], r.id + " source counters " + [r.st, r.ss, r.sf] + " (expected " + [e[1], e[2], e[3]] + ")");
    ok(Number(r.rt) === e[4] && Number(r.rs) === e[5] && Number(r.rf) === e[6], r.id + " report counters " + [r.rt, r.rs, r.rf] + " (expected " + [e[4], e[5], e[6]] + ")");
    ok(r.fin === true, r.id + " finished_at is null (expected terminal)");
  }

  // BASELINE unchanged-data digests (payload content hashed; NEVER printed). RECORD this line for W.4.
  const b = (await c.query(DIGEST_SQL)).rows[0];
  console.log("BASELINE cycles_count=" + b.cycles_count + " cycles_digest=" + b.cycles_digest +
              " snap_count=" + b.snap_count + " snap_digest=" + b.snap_digest);
  console.log("W.1 INVENTORY PASS -- five terminal cycles + all pre-apply invariants hold; transaction rolls back (read-only).");
} finally {
  await c.query("rollback").catch(() => {});
  await c.end();
}
NODE
node --env-file=../.env.local gate7a-w1-inventory.mjs
rm gate7a-w1-inventory.mjs
```

### W.2 Hardened apply (single migration, single transaction, advisory-locked, hash-verified, digest- + ACL-guarded, ledger fail-closed)

`gate7a-w2-apply.mjs` verifies the frozen SHA-256 **before connecting**; then, in ONE transaction: takes
`pg_advisory_xact_lock(20260816, 1)` **before** any ledger/object read; requires migrations 1-5 recorded exactly
once; refuses if Migration 6 is already recorded; re-checks (OID/public-scoped) every Migration-6 target object is
absent; **captures the unchanged-data digest BEFORE the DDL**; runs ONLY the frozen file; **re-digests AFTER the
DDL and throws on any drift**; **asserts the COMPLETE table ACL** (every explicit grantee is the table owner or
`service_role`; `service_role` has EXACTLY SELECT+INSERT+UPDATE) — all **before** the ledger insert/COMMIT, so any
unexpected privilege or data drift rolls the whole migration back; records the ledger row with a **plain** INSERT;
COMMITs once. Any error rolls back. No `db:migrate`, no retry, no `DROP`.

```bash
cat > gate7a-w2-apply.mjs <<'NODE'
import pg from "pg"; import { readFileSync } from "node:fs"; import { createHash } from "node:crypto";
const M6 = "20260816_account_rollout.sql";
const PATH = "supabase/migrations/" + M6;   // run from sales-dashboard-live/
const FROZEN = "bd03301ce71c13db419cf950e537c46f4e1fe7d8fd2c8291952c667ac61457a7";
const PRIOR = ["20260807_scheduler_v2.sql","20260810_ads_sync_coverage.sql","20260810_report_sync_controls.sql",
               "20260811_sync_source_job_owners.sql","20260815_sync_cycle_finalize.sql"];
const M6_TABLES = ["public.scheduler_account_rollout","public.scheduler_rollout_mode","public.scheduler_publish_approvals"];
const M6_TRIGGERS = ["scheduler_account_rollout_touch","scheduler_rollout_mode_touch","scheduler_publish_approvals_touch"];
const M6_CONSTRAINTS = ["scheduler_account_rollout_account_id_nonblank","scheduler_account_rollout_account_id_canonical",
  "scheduler_account_rollout_account_id_primary_only","scheduler_rollout_mode_singleton",
  "scheduler_publish_approvals_report_key_nonblank","scheduler_publish_approvals_report_key_canonical",
  "scheduler_publish_approvals_account_id_nonblank","scheduler_publish_approvals_account_id_canonical",
  "scheduler_publish_approvals_account_id_primary_only","scheduler_publish_approvals_approved_by_canonical",
  "scheduler_publish_approvals_audited"];
const SHORT = ["scheduler_account_rollout","scheduler_rollout_mode","scheduler_publish_approvals"];
const DIGEST_SQL =
  "select (select count(*)::int from public.sync_cycles) as cycles_count," +
  " coalesce((select md5(string_agg(rh, ',' order by k)) from" +
  "   (select id::text k, md5(sc::text) rh from public.sync_cycles sc) q), 'EMPTY') as cycles_digest," +
  " (select count(*)::int from public.report_snapshots where report_key like 'scheduler-v2/%') as snap_count," +
  " coalesce((select md5(string_agg(rh, ',' order by k)) from" +
  "   (select (report_key||'/'||account_id||'/'||params_hash) k, md5(rs::text) rh" +
  "      from public.report_snapshots rs where report_key like 'scheduler-v2/%') q), 'EMPTY') as snap_digest";
const ok = (cond, msg) => { if (!cond) throw new Error("REFUSING: " + msg); };
// (0) verify the frozen hash BEFORE connecting/applying.
const bytes = readFileSync(PATH);
const sha = createHash("sha256").update(bytes).digest("hex");
ok(sha === FROZEN, M6 + " SHA-256 " + sha + " != frozen " + FROZEN);
const body = bytes.toString("utf8");
const url = new URL(process.env.POSTGRES_URL); url.searchParams.set("sslmode", "no-verify");
const c = new pg.Client({ connectionString: url.toString() });
await c.connect();
try {
  await c.query("begin");
  // (1) transaction-scoped advisory lock BEFORE any ledger/object read.
  await c.query("select pg_advisory_xact_lock($1::int, $2::int)", [20260816, 1]);
  await c.query("create table if not exists public.app_schema_migrations (filename text primary key, applied_at timestamptz not null default now())");
  // (2) migrations 1-5 each recorded exactly once.
  for (const f of PRIOR) {
    const n = (await c.query("select count(*)::int c from public.app_schema_migrations where filename=$1", [f])).rows[0].c;
    ok(n === 1, "prerequisite migration " + f + " has " + n + " ledger rows (expected 1)");
  }
  // (3) fail closed if Migration 6 already recorded.
  const seen = await c.query("select applied_at from public.app_schema_migrations where filename=$1", [M6]);
  ok(seen.rowCount === 0, M6 + " already applied at " + (seen.rows[0] && seen.rows[0].applied_at));
  // (4) re-check Migration-6 objects ABSENT (OID/public-scoped) inside the transaction.
  for (const t of M6_TABLES) ok((await c.query("select to_regclass($1) o", [t])).rows[0].o === null, "table " + t + " already exists");
  ok((await c.query("select to_regprocedure('public.scheduler_rollout_touch()') o")).rows[0].o === null, "scheduler_rollout_touch() already exists");
  ok((await c.query("select count(*)::int c from pg_trigger t join pg_class rel on rel.oid=t.tgrelid" +
     " join pg_namespace n on n.oid=rel.relnamespace where not t.tgisinternal and n.nspname='public' and t.tgname=any($1)", [M6_TRIGGERS])).rows[0].c === 0, "a Migration-6 trigger already exists in public");
  ok((await c.query("select count(*)::int c from pg_constraint con join pg_namespace n on n.oid=con.connamespace" +
     " where n.nspname='public' and con.conname=any($1)", [M6_CONSTRAINTS])).rows[0].c === 0, "a Migration-6 named constraint already exists in public");
  // (5) capture the unchanged-data BASELINE inside the transaction, BEFORE the DDL.
  const before = (await c.query(DIGEST_SQL)).rows[0];
  // (6) execute ONLY the frozen Migration-6 body (whole file inside this one transaction).
  await c.query(body);
  // (7) UNCHANGED-DATA proof: re-digest AFTER the DDL, BEFORE the ledger insert; any drift throws -> rollback.
  const after = (await c.query(DIGEST_SQL)).rows[0];
  for (const k of ["cycles_count", "cycles_digest", "snap_count", "snap_digest"]) {
    ok(String(before[k]) === String(after[k]), "data-plane drift in " + k + " during apply (" + before[k] + " -> " + after[k] + ")");
  }
  // (8) COMPLETE ACL proof BEFORE COMMIT: every explicit grantee is the table owner or service_role, and
  //     service_role has EXACTLY {SELECT, INSERT, UPDATE}. Any other grantee/privilege rolls the migration back.
  const owners = Object.fromEntries((await c.query(
    "select rel.relname, o.rolname owner from pg_class rel join pg_roles o on o.oid=rel.relowner where rel.oid=any($1::regclass[])", [M6_TABLES])).rows.map((r) => [r.relname, r.owner]));
  const acl = (await c.query(
    "select rel.relname, coalesce(r.rolname,'PUBLIC') grantee, a.privilege_type" +
    " from pg_class rel cross join lateral aclexplode(rel.relacl) a left join pg_roles r on r.oid=a.grantee" +
    " where rel.oid=any($1::regclass[]) order by rel.relname, grantee, a.privilege_type", [M6_TABLES])).rows;
  for (const row of acl) ok(row.grantee === "service_role" || row.grantee === owners[row.relname], "unexpected ACL grantee " + row.grantee + " on " + row.relname);
  for (const t of SHORT) {
    const svc = acl.filter((r) => r.relname === t && r.grantee === "service_role").map((r) => r.privilege_type).sort();
    ok(JSON.stringify(svc) === JSON.stringify(["INSERT", "SELECT", "UPDATE"]), "service_role privileges on " + t + " are [" + svc + "] (expected exactly SELECT,INSERT,UPDATE)");
  }
  // (9) ledger row: PLAIN insert (a duplicate raises a PK error -> rollback, surfacing a repeat).
  await c.query("insert into public.app_schema_migrations (filename) values ($1)", [M6]);
  // (10) single commit.
  await c.query("commit");
  console.log("applied " + M6 + " (data plane unchanged; ACL asserted before commit)");
} catch (e) {
  await c.query("rollback").catch(() => {});
  throw e;
} finally {
  await c.end();
}
NODE
node --env-file=../.env.local gate7a-w2-apply.mjs
rm gate7a-w2-apply.mjs
```

### W.3 What Migration 6 changes (accurate characterization)

- **Deletes nothing:** no `DROP TABLE`, `TRUNCATE`, or change to any existing table / historical row. The only
  `DROP`s are `drop trigger if exists` for THIS migration's own three touch triggers, each immediately re-created
  inside the same transaction. **No `DROP` repair, ever.**
- **Creates** three ADDITIVE tables — `scheduler_account_rollout` (5 cols), `scheduler_rollout_mode` (3 cols),
  `scheduler_publish_approvals` (7 cols) — with their PKs and **11 named CHECK constraints** (nonblank + canonical
  + primary-only identity, the rollout-mode singleton, and the audited-decision constraint).
- **`CREATE OR REPLACE`** the one trigger function `public.scheduler_rollout_touch()` and **DROP+CREATE** the
  three BEFORE-UPDATE FOR-EACH-ROW touch triggers that call it (one per table).
- **Seeds** the singleton `scheduler_rollout_mode` row `(1, all_primary=false)` with `on conflict (id) do
  nothing` (idempotent).
- **Enables RLS** on all three tables and creates **ZERO policies**; **revokes ALL** from
  `PUBLIC`/`anon`/`authenticated` **AND `service_role`** (stripping the Supabase project-level default-privilege
  ALL grant), then **grants EXACTLY SELECT/INSERT/UPDATE to `service_role`** on each table — no
  delete/truncate/references/trigger/maintain; the table owner's inherent privileges are untouched. The static
  `auditServiceRoleAcl` proves both the REVOKE-ALL-from-`service_role` and the exact `{select,insert,update}`
  grant per table (typed blockers `SERVICE_ROLE_REVOKE_MISSING`/`_GRANT_MISSING`/`_GRANT_MISMATCH`; comment/
  string-only, wrong-table, GRANT-ALL, and added-DELETE evidence all fail — EM4). The runtime wrappers only READ
  these tables; the operator's enable/approve is an INSERT and disable/revoke is an UPDATE (`enabled`/`approved`
  = false), never a DELETE (G3). The applied grant posture is asserted by W.2 step 8 before commit and re-proven
  in W.4.
- **Creates NO schedule** (no `pg_cron`/`pg_net`), performs **NO DataDoe call**, opens **no cycle**, writes **no
  snapshot**, and does **not** touch `SCHEDULER_V2_READY_REPORT_KEYS`, `report_sync_settings`, or any migration
  1-5 object. Every table uses `create table if not exists`, which is exactly why W.1 + the W.2 in-transaction
  re-check require every target object ABSENT before applying.

### W.4 Post-apply read-only verification (genuinely read-only; rolls back always)

`gate7a-w4-verify.mjs` runs inside `BEGIN; SET TRANSACTION READ ONLY` and **always ROLLBACKs** (in a `finally`),
scoping every check to the exact `public` OID. It validates the **exact ordered 15-column contract** (ordinal
position, name, PostgreSQL type, nullability, normalized default) across the three tables, the 11 CHECK
constraints + PKs, the singleton row + empty data tables, the three touch triggers (BEFORE-UPDATE-FOR-EACH-ROW,
`tgtype=19`, executing `public.scheduler_rollout_touch` by OID), RLS + zero policies, the complete
owner/`service_role` ACL, the Migration-1–5 objects (incl. each no-append trigger's OID / `tgenabled='O'` /
`tgtype=23`), the **five recorded terminal cycles**, the paused 13 controls, the **`cron.job` fail-closed
check**, and the unchanged-data digest. Provide the W.1 BASELINE via env vars so the digest re-check is exact:

```bash
export W1_CYCLES_COUNT=<from W.1>  W1_CYCLES_DIGEST=<from W.1>  W1_SNAP_COUNT=<from W.1>  W1_SNAP_DIGEST=<from W.1>
cat > gate7a-w4-verify.mjs <<'NODE'
import pg from "pg";
const M6 = "20260816_account_rollout.sql";
const PRIOR = ["20260807_scheduler_v2.sql","20260810_ads_sync_coverage.sql","20260810_report_sync_controls.sql",
               "20260811_sync_source_job_owners.sql","20260815_sync_cycle_finalize.sql"];
const M6_TABLES = ["public.scheduler_account_rollout","public.scheduler_rollout_mode","public.scheduler_publish_approvals"];
const SHORT = ["scheduler_account_rollout","scheduler_rollout_mode","scheduler_publish_approvals"];
// EXACT ordered column contract for all 15 columns: [name, PostgreSQL type, is_nullable, normalized default].
const COLUMN_CONTRACT = {
  scheduler_account_rollout: [
    ["account_id", "text", "NO", null],
    ["enabled", "boolean", "NO", "false"],
    ["note", "text", "YES", null],
    ["created_at", "timestamp with time zone", "NO", "now()"],
    ["updated_at", "timestamp with time zone", "NO", "now()"],
  ],
  scheduler_rollout_mode: [
    ["id", "smallint", "NO", "1"],
    ["all_primary", "boolean", "NO", "false"],
    ["updated_at", "timestamp with time zone", "NO", "now()"],
  ],
  scheduler_publish_approvals: [
    ["report_key", "text", "NO", null],
    ["account_id", "text", "NO", null],
    ["approved", "boolean", "NO", "false"],
    ["approved_by", "text", "NO", null],
    ["approved_at", "timestamp with time zone", "NO", null],
    ["created_at", "timestamp with time zone", "NO", "now()"],
    ["updated_at", "timestamp with time zone", "NO", "now()"],
  ],
};
const CYCLES = {
  "57afc1fb-6694-4925-8961-4730f5a8f4df": ["succeeded", 2, 2, 0, 1, 1, 0],
  "56422a66-9f23-43c9-9c8d-8a9427f8f36a": ["partial", 57, 44, 13, 13, 2, 11],
  "ac4cba6f-3214-4d9b-9be7-35c572890edf": ["partial", 56, 39, 17, 13, 3, 10],
  "b0415a5b-3926-48b0-885e-5dfb61489d74": ["partial", 135, 84, 51, 13, 4, 9],
  "c70879e8-006b-4dba-9896-813106b5aa74": ["succeeded", 133, 133, 0, 13, 13, 0],
};
const OPS = { sync_cycles:18, sync_source_jobs:27, sync_report_jobs:25, sync_source_job_owners:15 };
const PK = { scheduler_account_rollout:"PRIMARY KEY (account_id)", scheduler_rollout_mode:"PRIMARY KEY (id)",
             scheduler_publish_approvals:"PRIMARY KEY (report_key, account_id)" };
const TRIG = [["scheduler_account_rollout_touch","public.scheduler_account_rollout"],
              ["scheduler_rollout_mode_touch","public.scheduler_rollout_mode"],
              ["scheduler_publish_approvals_touch","public.scheduler_publish_approvals"]];
const NOAPPEND = [["sync_source_jobs_no_append_terminal","public.sync_source_jobs"],
                  ["sync_source_job_owners_no_append_terminal","public.sync_source_job_owners"],
                  ["sync_report_jobs_no_append_terminal","public.sync_report_jobs"]];
// Expected normalized CHECK bodies (whitespace collapsed, lowercased). Postgres renders NOT LIKE as !~~.
const CHK = {
  scheduler_account_rollout: {
    scheduler_account_rollout_account_id_nonblank: "check ((char_length(btrim(account_id)) > 0))",
    scheduler_account_rollout_account_id_canonical: "check ((account_id = btrim(account_id)))",
    scheduler_account_rollout_account_id_primary_only: "check ((account_id !~~ 'dd-secondary:%'::text))" },
  scheduler_rollout_mode: { scheduler_rollout_mode_singleton: "check ((id = 1))" },
  scheduler_publish_approvals: {
    scheduler_publish_approvals_report_key_nonblank: "check ((char_length(btrim(report_key)) > 0))",
    scheduler_publish_approvals_report_key_canonical: "check ((report_key = btrim(report_key)))",
    scheduler_publish_approvals_account_id_nonblank: "check ((char_length(btrim(account_id)) > 0))",
    scheduler_publish_approvals_account_id_canonical: "check ((account_id = btrim(account_id)))",
    scheduler_publish_approvals_account_id_primary_only: "check ((account_id !~~ 'dd-secondary:%'::text))",
    scheduler_publish_approvals_approved_by_canonical: "check ((approved_by = btrim(approved_by)))",
    scheduler_publish_approvals_audited: "check (((char_length(btrim(approved_by)) > 0) and (approved_at is not null)))" },
};
const DIGEST_SQL =
  "select (select count(*)::int from public.sync_cycles) as cycles_count," +
  " coalesce((select md5(string_agg(rh, ',' order by k)) from" +
  "   (select id::text k, md5(sc::text) rh from public.sync_cycles sc) q), 'EMPTY') as cycles_digest," +
  " (select count(*)::int from public.report_snapshots where report_key like 'scheduler-v2/%') as snap_count," +
  " coalesce((select md5(string_agg(rh, ',' order by k)) from" +
  "   (select (report_key||'/'||account_id||'/'||params_hash) k, md5(rs::text) rh" +
  "      from public.report_snapshots rs where report_key like 'scheduler-v2/%') q), 'EMPTY') as snap_digest";
const norm = (s) => String(s).replace(/\s+/g, " ").trim().toLowerCase();
const ok = (cond, msg) => { if (!cond) throw new Error("STOP: " + msg); };
const EXPECT = { cycles_count: process.env.W1_CYCLES_COUNT, cycles_digest: process.env.W1_CYCLES_DIGEST,
                 snap_count: process.env.W1_SNAP_COUNT, snap_digest: process.env.W1_SNAP_DIGEST };
const url = new URL(process.env.POSTGRES_URL); url.searchParams.set("sslmode", "no-verify");
const c = new pg.Client({ connectionString: url.toString() });
await c.connect();
try {
  await c.query("begin");
  await c.query("set transaction read only");

  // EXACT ordered column contract -- ordinal position, name, PostgreSQL type, nullability, normalized default --
  // for ALL 15 columns across the three tables. Any missing/renamed/reordered/extra/wrongly-typed/-nullable/
  // -defaulted column throws a typed STOP. (Casts like ::smallint and surrounding whitespace are normalized.)
  const normDefault = (d) => (d === null || d === undefined ? null : String(d).replace(/::[a-z ]+/g, "").replace(/\s+/g, " ").trim().toLowerCase());
  let colTotal = 0;
  for (const [t, contract] of Object.entries(COLUMN_CONTRACT)) {
    ok((await c.query("select to_regclass($1) o", ["public." + t])).rows[0].o !== null, t + " table missing");
    const rows = (await c.query("select ordinal_position op, column_name cn, data_type dt, is_nullable nu, column_default cd" +
      " from information_schema.columns where table_schema='public' and table_name=$1 order by ordinal_position", [t])).rows;
    ok(rows.length === contract.length, t + " has " + rows.length + " columns (expected " + contract.length + ")");
    colTotal += rows.length;
    for (let i = 0; i < contract.length; i++) {
      const [name, type, nullable, def] = contract[i];
      const r = rows[i];
      ok(Number(r.op) === i + 1, t + "." + name + " ordinal " + r.op + " (expected " + (i + 1) + ")");
      ok(r.cn === name, t + " column #" + (i + 1) + " is " + r.cn + " (expected " + name + ")");
      ok(r.dt === type, t + "." + name + " type " + r.dt + " (expected " + type + ")");
      ok(r.nu === nullable, t + "." + name + " nullability " + r.nu + " (expected " + nullable + ")");
      ok(normDefault(r.cd) === normDefault(def), t + "." + name + " default [" + r.cd + "] (expected [" + (def === null ? "no default" : def) + "])");
    }
  }
  ok(colTotal === 15, "expected 15 columns across the 3 tables, got " + colTotal);

  // PKs, scoped by conrelid OID.
  for (const [t, def] of Object.entries(PK)) {
    const r = (await c.query("select pg_get_constraintdef(con.oid) d from pg_constraint con where con.conrelid=$1::regclass and con.contype='p'", ["public." + t])).rows;
    ok(r.length === 1 && r[0].d === def, t + " PK is " + (r[0] && r[0].d) + " (expected " + def + ")");
  }

  // 11 named CHECK constraints, scoped by conrelid OID, validated, exact (normalized) bodies. Total must be 11.
  let total = 0;
  for (const [t, expect] of Object.entries(CHK)) {
    const rows = (await c.query("select con.conname, con.convalidated, pg_get_constraintdef(con.oid) d from pg_constraint con where con.conrelid=$1::regclass and con.contype='c' order by con.conname", ["public." + t])).rows;
    total += rows.length;
    ok(rows.length === Object.keys(expect).length, t + " has " + rows.length + " CHECK constraints (expected " + Object.keys(expect).length + ")");
    for (const row of rows) {
      ok(expect[row.conname] !== undefined, "unexpected CHECK " + row.conname + " on " + t);
      ok(row.convalidated === true, row.conname + " is NOT validated");
      ok(norm(row.d) === norm(expect[row.conname]), row.conname + " body mismatch: got [" + row.d + "]");
    }
  }
  ok(total === 11, "expected 11 CHECK constraints across the 3 tables, got " + total);

  // Singleton row (1,false); the two data tables EMPTY.
  const mode = (await c.query("select id, all_primary from public.scheduler_rollout_mode")).rows;
  ok(mode.length === 1 && Number(mode[0].id) === 1 && mode[0].all_primary === false, "scheduler_rollout_mode is not exactly (1,false)");
  ok((await c.query("select count(*)::int c from public.scheduler_account_rollout")).rows[0].c === 0, "scheduler_account_rollout is not empty");
  ok((await c.query("select count(*)::int c from public.scheduler_publish_approvals")).rows[0].c === 0, "scheduler_publish_approvals is not empty");

  // Three touch triggers: BEFORE UPDATE, FOR EACH ROW, enabled, executing public.scheduler_rollout_touch by OID.
  ok((await c.query("select to_regprocedure('public.scheduler_rollout_touch()') o")).rows[0].o !== null, "scheduler_rollout_touch() missing");
  for (const [trig, tbl] of TRIG) {
    const r = (await c.query("select t.tgenabled, t.tgtype, (t.tgfoid = to_regprocedure('public.scheduler_rollout_touch()')) fn_ok from pg_trigger t where not t.tgisinternal and t.tgname=$1 and t.tgrelid=$2::regclass", [trig, tbl])).rows;
    ok(r.length === 1, trig + " not found on exactly " + tbl);
    ok(r[0].fn_ok === true, trig + " does not execute public.scheduler_rollout_touch");
    ok(r[0].tgenabled === "O", trig + " not enabled (tgenabled=" + r[0].tgenabled + ")");
    ok(Number(r[0].tgtype) === 19, trig + " tgtype=" + r[0].tgtype + " (expected 19 = ROW|BEFORE|UPDATE)");
  }
  const fn = (await c.query("select pg_get_function_result(p.oid) ret, l.lanname from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=to_regprocedure('public.scheduler_rollout_touch()')")).rows[0];
  ok(fn.ret === "trigger", "scheduler_rollout_touch returns " + fn.ret);
  ok(fn.lanname === "plpgsql", "scheduler_rollout_touch language " + fn.lanname);

  // RLS enabled on all 3 (OID-scoped); ZERO policies.
  for (const t of M6_TABLES) ok((await c.query("select relrowsecurity from pg_class where oid=$1::regclass", [t])).rows[0].relrowsecurity === true, t + " RLS not enabled");
  ok((await c.query("select count(*)::int c from pg_policy where polrelid=any($1::regclass[])", [M6_TABLES])).rows[0].c === 0, "a policy exists on a Migration-6 table (expected 0)");

  // COMPLETE ACL proof: every explicit grantee is the owner or service_role; service_role EXACTLY SELECT+INSERT+UPDATE.
  const owners = Object.fromEntries((await c.query("select rel.relname, o.rolname owner from pg_class rel join pg_roles o on o.oid=rel.relowner where rel.oid=any($1::regclass[])", [M6_TABLES])).rows.map((r) => [r.relname, r.owner]));
  const acl = (await c.query("select rel.relname, coalesce(r.rolname,'PUBLIC') grantee, a.privilege_type from pg_class rel cross join lateral aclexplode(rel.relacl) a left join pg_roles r on r.oid=a.grantee where rel.oid=any($1::regclass[]) order by rel.relname, grantee, a.privilege_type", [M6_TABLES])).rows;
  for (const row of acl) ok(row.grantee === "service_role" || row.grantee === owners[row.relname], "unexpected ACL grantee " + row.grantee + " on " + row.relname);
  for (const t of SHORT) {
    const svc = acl.filter((r) => r.relname === t && r.grantee === "service_role").map((r) => r.privilege_type).sort();
    ok(JSON.stringify(svc) === JSON.stringify(["INSERT", "SELECT", "UPDATE"]), "service_role privileges on " + t + " are [" + svc + "] (expected SELECT,INSERT,UPDATE)");
  }

  // Ledger: Migration 6 exactly once; migrations 1-5 each exactly once.
  ok((await c.query("select count(*)::int c from public.app_schema_migrations where filename=$1", [M6])).rows[0].c === 1, M6 + " ledger count != 1");
  for (const f of PRIOR) ok((await c.query("select count(*)::int c from public.app_schema_migrations where filename=$1", [f])).rows[0].c === 1, f + " ledger count != 1");

  // Migrations 1-5 objects UNCHANGED: column counts + finalize RPC + 3 no-append triggers (OID-proven).
  for (const [t, n] of Object.entries(OPS)) ok((await c.query("select count(*)::int c from information_schema.columns where table_schema='public' and table_name=$1", [t])).rows[0].c === n, t + " column count changed");
  ok((await c.query("select to_regprocedure('public.finalize_sync_cycle(uuid)') o")).rows[0].o !== null, "finalize_sync_cycle missing");
  for (const [trig, tbl] of NOAPPEND) {
    const r = (await c.query("select t.tgenabled, t.tgtype, (t.tgrelid = $2::regclass) rel_ok," +
      " (t.tgfoid = to_regprocedure('public.reject_append_to_terminal_cycle()')) fn_ok" +
      " from pg_trigger t where not t.tgisinternal and t.tgname=$1 and t.tgrelid=$2::regclass", [trig, tbl])).rows;
    ok(r.length === 1, "no-append trigger " + trig + " changed/missing on " + tbl);
    ok(r[0].rel_ok === true, trig + " not on the exact public table OID " + tbl);
    ok(r[0].fn_ok === true, trig + " does not execute public.reject_append_to_terminal_cycle by OID");
    ok(r[0].tgenabled === "O", trig + " not enabled (tgenabled=" + r[0].tgenabled + ")");
    ok(Number(r[0].tgtype) === 23, trig + " tgtype=" + r[0].tgtype + " (expected 23 = ROW|BEFORE|INSERT|UPDATE)");
  }

  // 13 controls paused.
  const ctrl = (await c.query("select count(*)::int total, count(*) filter (where schedule_enabled)::int enabled from public.report_sync_settings")).rows[0];
  ok(ctrl.total === 13 && ctrl.enabled === 0, "controls total=" + ctrl.total + " enabled=" + ctrl.enabled + " (expected 13/0)");

  // No Scheduler-v2 pg_cron schedule (same fail-closed check as W.1; W.4 independently proves it post-apply).
  const cronInstalled = (await c.query("select to_regclass('cron.job') is not null e")).rows[0].e;
  let cronJobs = 0;
  if (cronInstalled) cronJobs = (await c.query("select count(*)::int c from cron.job")).rows[0].c;
  ok(cronJobs === 0, cronJobs + " cron job(s) present (expected 0)");

  // NO cycle created by Gate 7a: EXACTLY the five recorded terminal cycles remain, counters unchanged.
  const cyc = (await c.query("select id::text id, status s, source_total st, source_succeeded ss, source_failed sf," +
    " report_total rt, report_succeeded rs, report_failed rf, (finished_at is not null) fin from public.sync_cycles")).rows;
  ok(cyc.length === 5, "expected EXACTLY 5 sync_cycles post-apply, got " + cyc.length);
  for (const id of Object.keys(CYCLES)) ok(cyc.some((r) => r.id === id), "missing expected sync_cycle " + id);
  for (const r of cyc) {
    const e = CYCLES[r.id];
    ok(e !== undefined, "unexpected sync_cycle " + r.id);
    ok(r.s === e[0] && Number(r.st) === e[1] && Number(r.ss) === e[2] && Number(r.sf) === e[3] &&
       Number(r.rt) === e[4] && Number(r.rs) === e[5] && Number(r.rf) === e[6] && r.fin === true,
       r.id + " terminal state changed");
  }

  // Unchanged-data digest re-check vs the W.1 BASELINE (independent, after commit).
  for (const k of ["cycles_count", "cycles_digest", "snap_count", "snap_digest"]) ok(EXPECT[k] !== undefined && EXPECT[k] !== "", "set W1_" + k.toUpperCase() + " from the W.1 BASELINE before running W.4");
  const now = (await c.query(DIGEST_SQL)).rows[0];
  for (const k of ["cycles_count", "cycles_digest", "snap_count", "snap_digest"]) ok(String(now[k]) === String(EXPECT[k]), "unchanged-data drift in " + k + " (W.1 baseline " + EXPECT[k] + " != post-commit " + now[k] + ")");

  console.log("W.4 VERIFY PASS -- 15-column contract exact; ACL owner+service_role only; data plane byte-identical to the W.1 baseline; five terminal cycles + migrations 1-5 + 13 paused controls intact; no cron; transaction rolls back (read-only).");
} finally {
  await c.query("rollback").catch(() => {});
  await c.end();
}
NODE
node --env-file=../.env.local gate7a-w4-verify.mjs
rm gate7a-w4-verify.mjs
```

- **Code readiness allowlist:** re-grep `lib/server/sync/report-controls.js` — `SCHEDULER_V2_READY_REPORT_KEYS`
  is still `Object.freeze([])`. This is a **code** invariant (no DB object); Gate 7a cannot change it.
- **No publisher invocation / DataDoe call / cycle creation / schedule:** Gate 7a runs ONLY the migration DDL +
  one ledger INSERT. The W.2 in-transaction digest compare + the W.4 post-commit re-check prove `sync_cycles` and
  every `scheduler-v2/*` `report_snapshots` row are byte-identical (content-hashed); W.4 additionally re-asserts
  the **exact five terminal cycles** (so no cycle was opened) and runs the **same fail-closed `cron.job` check as
  W.1** (so no Scheduler-v2 schedule exists) — both are real runner assertions, not prose claims.

### W.5 STOP conditions (every mismatch halts Gate 7a; report the exact shape, do not repair in place)

- **Offline (W.0):** HEAD missing `85d49a0`; any of the six migration SHA-256 differs; `SCHEDULER_V2_READY_REPORT_KEYS`
  non-empty; `verify`/`diff --check` not clean; `POSTGRES_URL` absent → **STOP, do not connect.**
- **Pre-apply (W.1):** any thrown `STOP:` — Migration-6 ledger row present or a migration-1–5 count ≠ 1; any
  Migration-6 table/function/trigger/constraint already present in `public`; a prerequisite missing; an
  operational table absent or a column count ≠ 18/27/25/15; `finalize_sync_cycle` missing or a no-append trigger
  not OID-mapped to its exact table+guard function, not `tgenabled='O'`, or `tgtype≠23`; **not EXACTLY the five
  recorded terminal cycles (ids / status / source+report counters / non-null `finished_at`) — any extra, missing,
  miscounted, or still-running cycle**; controls total ≠ 13 or enabled ≠ 0; a `cron.job` present →
  **STOP; do not apply; capture the exact reason.**
- **Apply (W.2):** the runner refuses (rolls back, NO ledger row) on — frozen SHA-256 mismatch; a prerequisite not
  recorded exactly once; Migration 6 already recorded; any target object already present; **any `sync_cycles` /
  `scheduler-v2/*` digest drift between the pre-DDL and post-DDL snapshots**; **any ACL grantee other than the
  owner or `service_role`, or `service_role` not holding exactly SELECT+INSERT+UPDATE**; any DDL error; a
  duplicate ledger PK. **On ANY refusal, STOP and report; never retry with `db:migrate`, never `DROP` to
  "repair", never force.**
- **Post-apply (W.4):** any thrown `STOP:` — **any of the 15 columns wrong by ordinal position / name /
  PostgreSQL type / nullability / normalized default (missing, renamed, reordered, extra, wrongly typed,
  nullable, or defaulted)**; a wrong PK; ≠ 11 CHECK constraints, an unexpected/renamed constraint, any
  `convalidated=false`, or a normalized body mismatch (the printed `got [...]` shows the exact serialization); the
  rollout-mode row not exactly `(1,false)` or not exactly one row; any rollout/approval row present; a touch
  trigger not BEFORE-UPDATE-FOR-EACH-ROW (`tgtype≠19`) / not enabled / not executing `public.scheduler_rollout_touch`
  by OID; the function missing or wrong return/language; RLS not enabled on all three; ANY policy present; an
  unexpected ACL grantee or `service_role` privileges ≠ SELECT+INSERT+UPDATE; Migration-6 ledger ≠ 1 or a
  migration-1–5 count ≠ 1; a migration-1–5 object changed or a no-append trigger not `tgenabled='O'`/`tgtype=23`/
  OID-mapped; **not EXACTLY the five recorded terminal cycles**; a `cron.job` present; controls ≠ 13/0; or the
  unchanged-data digest ≠ the W.1 baseline → **STOP. The migration transaction already committed, so do NOT
  attempt a destructive rollback/DROP — capture the deviation and escalate for reviewed remediation.**

### W.6 Zero-production-side-effect confirmation (THIS preparation turn)

This turn made **no production connection** and executed **nothing** against the database: no migration applied,
no DataDoe call, no snapshot published, no report unlocked, no durable control changed, no deploy, no push, no
merge, no schedule. Migration 6 (`20260816_account_rollout.sql`) remains **UNAPPLIED** and byte-frozen at SHA-256
`bd03301ce71c13db419cf950e537c46f4e1fe7d8fd2c8291952c667ac61457a7`; migrations 1–5 are byte-identical; all
touched Gate-7 code files are unchanged (docs-only commit). **STOP.** Gate 7a executes ONLY after Codex review of
this hardened package **and** explicit human approval — one migration file, then stop for W.4.

---

## Appendix X — Gate 7a EXECUTION evidence (APPLIED 2026-08-15; single guarded transaction; Migration 6 now APPLIED)

Applies ONLY `20260816_account_rollout.sql` (the durable account-rollout control plane: `scheduler_account_rollout`,
`scheduler_rollout_mode`, `scheduler_publish_approvals` + the shared touch trigger, 11 named constraints, RLS with
zero policies, and the least-privilege `service_role` ACL). Executed with explicit human authorization against
HEAD `69fa168` and the frozen SHA-256 `bd03301ce71c13db419cf950e537c46f4e1fe7d8fd2c8291952c667ac61457a7`, exactly
per the reviewed Appendix W (W.0 → W.1 → W.2 → W.4), from `sales-dashboard-live/` with `node --env-file=../.env.local`
(secrets never printed/committed). No `db:migrate`, no retry, no runner modification. This is the second Gate-7a
execution attempt; the first (against the prior hash) correctly failed CLOSED at the pre-COMMIT ACL gate and rolled
back — see the status header — after which the migration's `service_role` grants were corrected to least privilege.

### X.1 W.0 offline preflight (all PASS)

HEAD `69fa168` (exact); all six Scheduler-v2 migration SHA-256 match their frozen values (migration 6 =
`bd03301c…c61457a7`; migrations 1–5 byte-identical); `SCHEDULER_V2_READY_REPORT_KEYS` frozen empty; `npm run verify`
green (38 steps / 18 suites incl. `build:check`); `git diff --check` clean; working tree only `HANDOFF.md` +
`.worktrees/` untracked; `POSTGRES_URL` present + nonblank (checked by NAME only). The three Appendix W runners were
extracted verbatim from the committed doc and `node --check`-clean; the W.2 runner's `FROZEN` constant equals the
new hash.

### X.2 W.1 read-only inventory (PASS; rolled back)

`gate7a-w1-inventory.mjs` (inside `BEGIN; SET TRANSACTION READ ONLY; … finally ROLLBACK`) passed EVERY assertion:
ledger present with migrations 1–5 each exactly once and Migration 6 absent; the three Migration-6 tables /
`scheduler_rollout_touch()` / its three triggers / its 11 named constraints all absent; prerequisites present
(`report_sync_settings`, `auth.users`, and EXACTLY roles `anon`/`authenticated`/`service_role` via the corrected
parser-independent check); the five operational sync tables present with column counts 18/27/25/15 +
`ads_sync_coverage`; `finalize_sync_cycle` + the three no-append triggers OID-mapped to their exact tables + guard
function with `tgenabled='O'` and `tgtype=23`; **EXACTLY the five recorded terminal cycles** (`57afc1fb` succeeded
2/2/0·1/1/0; `56422a66` partial 57/44/13·13/2/11; `ac4cba6f` partial 56/39/17·13/3/10; `b0415a5b` partial
135/84/51·13/4/9; `c70879e8` succeeded 133/133/0·13/13/0), every `finished_at` non-null; 13 report controls all
`schedule_enabled=false`; no `cron.job`. **Recorded BASELINE (payload-free): `cycles_count=5`,
`cycles_digest=a8c97132102dd9e40ea46a799f54bb33`, `snap_count=23`, `snap_digest=3c4a1ed7284a615e5fc9ecac4d94cf01`.**

### X.3 W.2 apply — ONE transaction, ONE commit (SUCCESS)

`gate7a-w2-apply.mjs` result: **`applied 20260816_account_rollout.sql (data plane unchanged; ACL asserted before
commit)`**. In order, inside a single `BEGIN … COMMIT`: (0) the file's SHA-256 was re-verified against the frozen
`bd03301c…` BEFORE connecting; (1) `pg_advisory_xact_lock(20260816, 1)` acquired before any ledger/object read;
(2) migrations 1–5 confirmed recorded exactly once; (3) Migration 6 confirmed not already recorded; (4) every
Migration-6 target object re-confirmed ABSENT (OID/public-scoped) inside the transaction; (5) the pre-DDL
unchanged-data baseline captured; (6) the frozen migration body executed; (7) the post-DDL digest re-captured and
compared — **no `sync_cycles` / `scheduler-v2/*` drift**; (8) the COMPLETE ACL asserted BEFORE commit — every
explicit grantee is the table owner or `service_role`, and **`service_role` holds EXACTLY `{SELECT, INSERT,
UPDATE}`** on each table (the correction that the first attempt's gate demanded); (9) the ledger row recorded with
a PLAIN `INSERT` (no `ON CONFLICT`); (10) a single `COMMIT`. **Ledger `applied_at = 2026-08-15T14:37:02.726Z`;
Migration 6 ledger rows = 1.**

### X.4 W.4 read-only post-apply verification (all PASS; rolled back)

`gate7a-w4-verify.mjs` result: **`W.4 VERIFY PASS -- 15-column contract exact; ACL owner+service_role only; data
plane byte-identical to the W.1 baseline; five terminal cycles + migrations 1-5 + 13 paused controls intact; no
cron; transaction rolls back (read-only).`** Proven post-commit: the three tables' EXACT ordered 15-column contract
(name / PostgreSQL type / nullability / normalized default); all 11 named CHECK constraints present + `convalidated`
with exact bodies; PKs; the singleton `scheduler_rollout_mode` row `(1,false)`; zero rows in
`scheduler_account_rollout` + `scheduler_publish_approvals`; the three BEFORE-UPDATE-FOR-EACH-ROW touch triggers
(`tgtype=19`) executing `public.scheduler_rollout_touch` by OID; RLS enabled with **zero policies**; **no
PUBLIC/anon/authenticated grant and `service_role` = EXACTLY SELECT+INSERT+UPDATE** on all three; Migration-6 ledger
= 1 and migrations 1–5 each = 1; migrations 1–5 objects unchanged (column counts + `finalize_sync_cycle` + the three
no-append triggers OID/`tgenabled`/`tgtype=23`); the five terminal cycles unchanged; 13 controls paused; no cron;
and the unchanged-data digest **byte-identical to the W.1 baseline** (`cycles_digest=a8c97132…`, `snap_digest=3c4a1ed7…`).

An independent read-only evidence snapshot confirmed: `applied_at 2026-08-15T14:37:02.726Z`, Migration-6 ledger
rows = 1, and `service_role` = `["INSERT","SELECT","UPDATE"]` on each of the three tables.

### X.5 State + guardrails

- **Migration 6 is now APPLIED** (ledger authoritative); the three tables + trigger function + three touch triggers
  + 11 constraints exist; all three tables are **EMPTY except** the seeded singleton `scheduler_rollout_mode (1,
  all_primary=false)`. The durable rollout therefore selects **ZERO accounts** and NOTHING is approved — the system
  stays fully off at the data layer.
- **UNCHANGED:** migrations 1–5 byte-identical; the five terminal cycles + all `scheduler-v2/*` snapshots
  byte-identical (digest-proven); `SCHEDULER_V2_READY_REPORT_KEYS` frozen empty; 13 `report_sync_settings` rows all
  `schedule_enabled=false`; no `pg_cron` schedule; no route/frontend/deploy change.
- **NOT DONE (not authorized):** no DataDoe call; no report/account enable; no publish; no deploy/push/merge; no
  cron/schedule; no advance to the next rollout gate. The throwaway runner scripts were removed after execution.

**STOP.** Gate 7a is complete. The next gate (Appendix V — the IN-only enable package) remains BLOCKED pending
Codex review of this evidence and a separate explicit authorization.

---

## Appendix Y — Gate 7b: IN-account all-13-report production cutover (PREPARED — NOT EXECUTED)

**Nothing in this appendix has been run.** It is the exact, reviewed sequence a FUTURE explicitly authorized
gate executes to bring the **IN account only** live for **all 13 Scheduler-v2 reports**, one report at a time,
each step behind its own read-only verification. **USA stays completely excluded** (see Y.5). Executing it
requires: Codex review of the Gate-7b code (below), explicit human approval naming the IN account, and the
standing gate discipline (single, reviewed, reversible steps; fail closed on any mismatch).

### Y.0 Starting state (must hold before Gate 7b)

- HEAD includes `63346bd`; **Migration 6 is APPLIED exactly once** (Gate 7a — Appendix X): the three tables +
  11 constraints + touch triggers exist; RLS on, zero policies; `service_role` = exactly SELECT/INSERT/UPDATE.
- `scheduler_account_rollout` and `scheduler_publish_approvals` are **EMPTY**; `scheduler_rollout_mode` =
  `(1, all_primary=false)`.
- All 13 `report_sync_settings` rows are **paused** (`schedule_enabled=false`).
- The reviewed branch sets `SCHEDULER_V2_READY_REPORT_KEYS` to an **explicit hand-authored frozen literal of
  the 13 individually-approved report keys** (the code cutover) — but this is NOT yet deployed.
- No Scheduler-v2 `pg_cron` schedule exists.
- The IN account `d658442d-…` passed Gate-6 Cycle 2 with **all 13 reports succeeded** (Appendix T.3).

### Y.1 The reviewed CODE change (this branch; deploy is a later step)

`lib/server/sync/report-controls.js`: `SCHEDULER_V2_READY_REPORT_KEYS` is an **EXPLICIT frozen literal of the 13
individually-approved report keys** — authored by hand, **NEVER derived/spread from `CONTROLLED_REPORT_KEYS`, the
registry, planners, contracts, or settings** — so a FUTURE controlled report can never inherit readiness; it
becomes v2-ready ONLY via an explicit reviewed edit to this literal. `CONTROLLED_REPORT_KEYS` remains the general
user-facing control catalog (unchanged). The literal (in order):
`brand-sales, daily-reporting, reconciliation, fba-plan, sku-pl, keyword-rank, content-changes, sales-movers,
listing-health, buy-box-loss, returns-leakage, ppc-performance, listing-optimizer`.

This is the CODE gate only. Readiness ON dispatches or publishes **nothing** by itself: the durable account
rollout (default ZERO accounts), the durable `report_sync_settings` (all paused), and the per-(report, account)
publish approval (none) all remain closed. The no-side-effect preflight now (6a) validates the readiness literal —
exactly 13 UNIQUE keys, each an existing controlled report with a pinned live snapshot contract, failing closed
with typed `V2_READINESS_COUNT / _DUPLICATE / _UNKNOWN / _NO_CONTRACT` blockers — and (6b) requires the catalog's
ready set to be a SUBSET of that literal and nothing scheduled with empty settings (`V2_CONTROLS_UNLOCKED`), so a
future controlled report not in the literal stays not-ready.

Regressions: `scripts/sync-runtime-composition.test.js` adds an explicit-readiness-allowlist test — the literal is
proven hand-authored (source assignment has no spread/derivation), a **synthetic future controlled report never
becomes ready automatically**, and duplicate / 14-key / 12-key / unknown / no-contract lists each fail closed with
the typed blocker. `scripts/gate7b-in-cutover.test.js` (6 checks): **Y1** readiness = exactly the 13, each a valid
live contract; **Y2** no rollout rows ⇒ a scheduled run (even with all 13 settings enabled) is a zero-I/O drained
no-op before discovery; **Y3** EVERY one of the 13 reports, dispatched through its REAL planner path with a mixed
discovery (IN + another non-US + a US account) and an IN-only rollout, produces exactly the requested report with
`selected=[report]`, `accountsDispatched=[IN]`, every source-job owner + report job + shadow snapshot scoped to IN,
and ZERO owners/jobs/snapshots/exports for the US and the other non-US account (ownership evidence per report — no
selection-only shortcut; a report that legitimately stays pending still creates only IN-scoped durable work);
**Y4** the US bucket + IN-only rollout drains (US spends zero); **Y5** durable `schedule_enabled=false` still
prevents dispatch; **Y6** the dispatcher never auto-publishes (no import; a full IN cycle writes only
`scheduler-v2/*` shadow snapshots). Full `npm run verify` green (39 steps / 19 suites incl. `build:check`).

### Y.2 Reviewed production sequence (one step at a time; verify before the next)

Let `IN_ACCOUNT` = the exact public id of the proven IN primary account (`d658442d-…`; **re-read from live
discovery at execution time**, never hard-coded). Every durable id written (`account_id`, `report_key`,
`approved_by`) must be CANONICAL — no leading/trailing whitespace (the migration-6 `= btrim(...)` constraints
reject a noncanonical value, and the reader/resolver fail closed on one).

1. **Deploy the reviewed branch** while the durable data stays CLOSED (rollout empty, `rollout_mode`
   `(1,false)`, all 13 settings paused, no approvals). The readiness flip alone changes no runtime behavior.
2. **Reconfirm the deployment is INERT** (read-only): the no-side-effect preflight audits clean and reports
   `v2ControlsLocked.ok=true` (readiness = the 13 approved keys, nothing scheduled); a scheduled dispatch is a
   drained no-op (zero accounts); `scheduler_account_rollout` / `scheduler_publish_approvals` empty;
   `report_sync_settings` 13× `schedule_enabled=false`; no `pg_cron`. **STOP if any is not so.**
3. **Discover + positively verify the full IN primary public account ID** from live DataDoe discovery: it must
   be an ACTIVE PRIMARY account (not `dd-secondary:`-prefixed), its full public id, and the same account that
   passed Gate-6 Cycle 2 (`d658442d-…`). Record the exact id as `IN_ACCOUNT`.
4. **Enable the IN account — exactly one allowlist row:**
   `insert into public.scheduler_account_rollout (account_id, enabled, note) values ('<IN_ACCOUNT>', true, 'Gate-7b IN cutover — approved <date>');`
   Verify: exactly ONE enabled row; `scheduler_rollout_mode.all_primary` STILL false. Scheduled runs still
   dispatch nothing (all settings paused).
5. **Enable `report_sync_settings` ONE report at a time** (recommended order: `brand-sales` first — the
   deepest-verified — then the rest): `update public.report_sync_settings set schedule_enabled=true where
   report_key='<report>';`. After each, verify a scheduled shadow run selects exactly that report for exactly
   IN, and no other report/account moves.
6. **Run one controlled SHADOW cycle** — either one bounded cycle per newly-enabled report, or one bounded
   all-13 IN cycle once all 13 are enabled — via the trusted composition (instance-scoped, IN-only, bounded
   slices, ≤1 create per hash). Writes stay under `scheduler-v2/*` + the scheduler tables ONLY.
7. **Require terminal SUCCEEDED jobs + valid shadow snapshots:** each report's `sync_report_jobs` row must be
   `validated=true`, `derive_status='succeeded'`, `save_status='succeeded'` inside a terminal `succeeded`/`partial`
   cycle, with a `scheduler-v2/<report>` snapshot for IN that passes the derivation's `validatePayload` and is
   NOT `dataUnavailable`. **STOP on any non-terminal / failed / blocked / invalid report.**
8. **Insert ONE audited publish approval per (report, IN account):**
   `insert into public.scheduler_publish_approvals (report_key, account_id, approved, approved_by, approved_at) values ('<report>', '<IN_ACCOUNT>', true, '<operator>', now());`
   (`approved_by`/`approved_at` are DB-required and canonical.)
9. **Publish ONE report at a time** through the trusted composition:
   `buildSchedulerV2Publisher().publish('<report>', '<IN_ACCOUNT>')` from a trusted operator context (NEVER a
   browser route). Expect `published` (or `already-current`/`newer-live` on a benign replay). The four gates
   (code readiness + durable report enable + durable account enable resolved against fresh discovery + explicit
   approval) plus the exact job-snapshot binding + CAS all apply. **STOP on `publish-conflict` or any
   non-publishing disposition** and remediate with a fresh shadow cycle (never an equal-timestamp overwrite).
10. **Verify each live snapshot via the frontend's EXACT natural identity + payload contract:** read
    `report_snapshots` by the pinned live `(report_key, account_id, params_hash)` (`paramsHashFor(liveReportVersion,
    liveParams)`; the 13 mappings in U.4) and confirm the frontend's own route serves it. The payload must match
    the derivation's `validatePayload` shape for that report.
11. **Preserve + compare the previous live fingerprint BEFORE and AFTER every publication:** capture the live
    payload-free fingerprint for `(report_key, IN_ACCOUNT)` before publishing; after, confirm the row advanced to
    the new snapshot identity AND that **no OTHER account's or report's** live snapshot changed (compare their
    fingerprints byte-for-byte). The previous live last-known-good is preserved on any non-publishing outcome.

### Y.3 Exact rollback (any point; reversible; never destroys LKG)

- **Pause a report:** `update public.report_sync_settings set schedule_enabled=false where report_key='<report>';`
  — the scheduled path stops dispatching it immediately.
- **Revoke a publish approval (audited):** `update public.scheduler_publish_approvals set approved=false,
  approved_by='<operator>', approved_at=now() where report_key='<report>' and account_id='<IN_ACCOUNT>';` — a
  revocation is itself an audited decision row (WHO + WHEN required).
- **Disable the IN account:** `update public.scheduler_account_rollout set enabled=false where
  account_id='<IN_ACCOUNT>';` — the rollout immediately selects zero accounts (fail closed).
- **Remove readiness keys ONLY through a reviewed CODE rollback** (revert the `SCHEDULER_V2_READY_REPORT_KEYS`
  flip on the branch + redeploy) — never by hand at runtime.
- **NEVER delete a live last-known-good (`report_snapshots`) row.** Rollback disables/ pauses/ revokes; it does
  not delete published or prior LKG snapshots. The publisher's CAS already preserves LKG on every failure.

Each lever independently returns the system to fail-closed zero with no code change (except the readiness
rollback) and no data loss.

### Y.4 Guardrails (do NOT, in this gate)

- **Do NOT add USA (or any non-IN account) to `scheduler_account_rollout`.** Only `IN_ACCOUNT` gets an enabled
  row; `all_primary` stays false.
- **Do NOT create any `pg_cron`/`pg_net` schedule.** Gate 7b is operator-driven, one report at a time; scheduling
  is a separate future gate.
- No DataDoe call outside the reviewed shadow cycle; no deploy/push/merge beyond the single reviewed branch
  deploy in step 1; no advance to any further rollout gate.

### Y.5 USA partial rollout needs a SEPARATE report-account execution gate

Gate-6 Cycle 2 left **IN = 13/13 (PASS)** and **USA = 4/13 (PARTIAL — 9 DataDoe TIMEOUTs, zero code defects;
Appendix T.6)**. The current durable controls are an **account-level** gate (`scheduler_account_rollout` enables
an account for ALL its ready reports) plus a **report-level** gate (`report_sync_settings` enables a report for
ALL enabled accounts). This product **cannot safely express "IN = all 13 AND USA = only the 4 that passed"** — an
enabled USA row + a report enabled for IN would also expose USA to that report, and USA's 9 timeout-prone reports
must not go live. Therefore **USA partial rollout is OUT OF SCOPE for Gate 7b** and requires a **separate,
reviewed report-account execution gate** — a per-`(report, account)` durable enable (not just per-report and
per-account) — designed and reviewed after the Appendix Q.4 DataDoe stability questions are resolved for the US
account. Until then USA stays excluded (no `scheduler_account_rollout` row).

**STOP.** Gate 7b hands back for Codex review. No deploy, no durable row, no settings change, no publish, no cron,
no production connection has happened in this preparation.

## Appendix Z — Gate 7b PHASE 1 EXECUTION evidence (2026-08-15 — EXECUTED: deploy INERT + Brand-Sales-only IN cutover; SUCCESS)

**Authorized scope (Phase 1 of Gate 7b):** deploy Scheduler-v2 to production **inert**, then cut over **ONLY
Brand Sales** for the proven **IN account** (`d658442d-…`). USA and the other 12 reports stay excluded. Ran as
phased steps A→D, each behind its own read-only verification. Every runner was a throwaway read-mostly `.mjs`
(removed after use) that connected read-only where possible (`BEGIN; SET TRANSACTION READ ONLY; … ROLLBACK`) and
**never printed secrets, payloads, export ids, or full sensitive hashes**. Starting HEAD included `4b1179d`.

### Z.A Preflight (read-only) — PASS
- `npm run verify` green; `git diff --check` clean.
- Migration 6 applied exactly once; frozen ledger hash `bd03301…` unchanged.
- `scheduler_account_rollout` empty; `scheduler_rollout_mode`=(1, false); `scheduler_publish_approvals` empty;
  all 13 `report_sync_settings` paused; no Scheduler-v2 `pg_cron`.
- Durable baseline byte-identical to Gate-7a: 5 `sync_cycles` (digest `a8c9713…`), 23 `scheduler-v2/*` snapshots
  (digest `3c4a1ed…`).
- IN Brand Sales live baseline captured: 2 live rows, payload-free combined fingerprint `898aed784cd…`.

### Z.B Merge + deploy INERT — PASS
- Merged `feature/scheduler-v2` → `main` `--no-ff` (history preserved): **merge commit `0ea9f345…` (`0ea9f34`)**;
  pushed to `origin/main`.
- Deployed the **exact merge-commit tree** to Vercel Production via `vercel deploy --prod` from the repo root
  (project root dir `sales-dashboard-live`): deployment **`p7un5uel8`** (`dpl_4o6JFFQ…`), **● Ready**, holds the
  production alias `upriverdashboard.vercel.app`, app returns HTTP **200**.
- Deploy caused **zero durable effect** (re-verified read-only): cycles=5 / v2-snapshots=23 (both digests
  unchanged), rollout empty, approvals empty, mode (1, false), 13 settings paused, no cron, IN Brand Sales
  fingerprint unchanged.
- **Note:** the docs-evidence commit (this appendix) is intentionally **not pushed**, so the verified production
  deployment stays pinned to the exact merge-commit tree.

### Z.C Exact IN account gate — PASS
- One fresh primary DataDoe discovery: 30 active accounts.
- Resolved **exactly one** ACTIVE PRIMARY account matching the proven IN identity (`d658442d…`) — canonical, not
  `dd-secondary`; failed closed otherwise.
- Inserted **exactly one** `scheduler_account_rollout` row (`enabled=true`, exact IN id, note "Gate-7b Phase 1 IN
  cutover (Brand Sales) — approved 2026-08-15"). `all_primary` stays false. Verified only IN enabled; USA + every
  other account excluded; 13 settings still paused; approvals empty.

### Z.D Brand-Sales-only cutover — PASS
- **(16)** `report_sync_settings.schedule_enabled=true` for **brand-sales only**; other 12 paused.
- **(17)** One bounded manual Scheduler-v2 Brand Sales shadow cycle for IN (`non-us`, cycleDate `2026-08-17`, asOf
  `2026-08-14`) via `buildSchedulerV2Runtime().run(...)`: drained in a single bounded slice (2 exports), then
  `finalizeSyncCycle` → **finalized / succeeded**. Cycle `460777e0…`.
- **(18)** Verified: cycle `non-us/2026-08-17/manual/succeeded` (src 2/2, rep 1/1, 0 failures); owners + report
  job **ONLY brand-sales / IN** (`request_keys={brand-sales:catalog, brand-sales:order-lines}`); report version
  `brand-sales/v2d-2`, `validated`, derive+save succeeded; both source exports `create_export_count=1`; Product
  Catalog `source_id=68d2de238e…` the ONLY catalog; shadow v2d-2 payload VALID (rows=1188, catalogBrands=2,
  `asinBrand` object with 3190 keys, nonempty); **live IN Brand Sales fingerprint UNCHANGED before publishing**.
- **(19)** Inserted **exactly one** audited `scheduler_publish_approvals` row (`brand-sales`, IN, `approved=true`,
  `approved_by='laxmikant@superboring.in'`, `approved_at=now()`).
- **(20/21)** `buildSchedulerV2Publisher().publish('brand-sales', IN)` once → disposition **`published`**; live
  identity `brand-sales` / IN / `brand-sales-shared-v1` / window `[2025-06-07..2026-08-14]` / params_hash
  `297b6257…`.
- **(22)** Verified: exact live natural identity present; the API read path (`getReportSnapshot`) serves it; live
  payload **byte-identical** to the validated shadow (rows=1188, catalogBrands=2, `asinBrand` 3190 keys); **170
  other live rows BYTE-IDENTICAL** (USA + every other account/report unchanged); IN Brand Sales live rows **2→3**
  (both pre-existing rows preserved, 1 new); **no other report published**.

### Z.E End state
- **Deployed:** `main` = `0ea9f34` (merge); production = `p7un5uel8` (merge tree); HTTP 200.
- **Durable controls:** `scheduler_account_rollout` = 1 enabled IN row (`all_primary=false`);
  `scheduler_publish_approvals` = 1 row (`brand-sales`, IN, approved); `report_sync_settings` = brand-sales enabled,
  other 12 paused; no `pg_cron`.
- **Live:** IN Brand Sales is now served by a Scheduler-v2-published snapshot; all other accounts/reports untouched.

**STOP.** Per the authorization, execution halted after Brand Sales verification. The remaining 12 reports stay
paused + unapproved; USA stays excluded (Y.5); no cron was created. Rollback levers (Y.3) remain available and
reversible with no data loss.

## Appendix AA — Gate 7b PHASE 2 ATTEMPT (2026-08-15 — remaining-12 IN cutover; HALTED at Phase C by a DataDoe timeout; step-17 rollback; NOTHING published)

**Authorized scope (Phase 2):** generate, validate, and publish the remaining **12** reports for the proven **IN
account** — **no deployment, no scheduling** — one report at a time behind read-only verification. Outcome:
**HALTED at Phase C** by a DataDoe export-timeout blocker; per step 17 the 12 settings were returned to false and
**nothing was published**. Production code stays the exact merge commit `0ea9f34` (deploy `p7un5uel8`); brand-sales
for IN stays live and untouched.

### AA.A Preflight (read-only) — PASS
- Production alias `upriverdashboard.vercel.app` → deploy `p7un5uel8` (merge tree `0ea9f34`), HTTP 200.
- Durable state exact: rollout = 1 enabled IN (`all_primary=false`); approvals = 1 (`brand-sales`/IN); settings
  `brand-sales=true` + other 12 false; no `pg_cron`.
- Fresh primary discovery (30 active) revalidated exactly one active PRIMARY IN match = the enabled rollout id.
- Payload-free fingerprints captured: IN live = 9 rows (`16eae8af…`, across brand-catalog:1, brand-sales:3,
  listing-health:1, listing-optimizer:1, ppc-performance:1, returns-leakage:1, sales-movers:1); non-IN live = 164
  rows (`cc9c2c91…`).
- PPC durable coverage proven for asOf `2026-08-14` (window `[2026-07-16..2026-08-14]`, 2 required sources
  proven+folded, single currency, latestMetricDate 2026-08-14).
- `npm run verify` green (39 steps / 19 suites incl. build:check); `git diff --check` clean.

### AA.B Prepare the 12 — PASS
- `report_sync_settings.schedule_enabled=true` set for exactly the 12 (brand-sales stays true) ⇒ **13/13 enabled**;
  no cron; no scheduled trigger; **no approvals inserted** (Phase C precedes any approval). Enabling settings alone
  dispatches/publishes nothing.

### AA.C One bounded combined shadow cycle — FAILED (DataDoe timeout) → step-17 rollback
- Ran one manual Scheduler-v2 SHADOW cycle for exactly the 12 + IN only: bucket `non-us`, cycleDate `2026-08-18`,
  asOf `2026-08-14`, bounded slices (`maxJobs=40`, ~90s deadline), resuming the same cycle. Cycle `dfca8f75…`.
- The 12-report plan fanned out to **122 canonical source jobs** (staged per-entity/per-slice sources:
  order-line-items×29, settlements×30, sales-traffic-asin-date×33, profit-by-sku-date×11, returns×9,
  product-catalog×5, fba-inventory-health×2, listings/listings-raw/content-changes×1). Per-slice isolation held
  throughout (IN-only owners/jobs, ≤12 report keys, `create_export_count ≤ 1` per request_hash, no ownerless
  source jobs, no non-IN work, live snapshots unchanged).
- **BLOCKER (typed):** `daily-reporting`'s REQUIRED source `sales-traffic-asin-date` (request_key
  `daily-reporting:asin-day-superset`) had **3 slices FAIL** — `stage=create-export code=TIMEOUT` (×2) and
  `stage=poll code=EXPORT_ERROR` (×1), each `terminal=false`, `create_export_count=1`. A **failed** source job is
  treated as done and **skipped on resume — never retried** (`source-worker.js` execute loop). `daily-reporting`
  declares `optionalRequestKeys: []` (ALL sources required) and its derive reconstructs the EXACT sliced superset
  sequence, so a failed required slice means it **cannot reach `validated=true` / derive+save succeeded** in this
  cycle. Retry / fallback / a second cycle are **not authorized** (and step 11 authorizes exactly ONE cycle).
- **Nature:** a DataDoe export-infrastructure timeout (same class as the Gate-6 Cycle-2 USA timeouts, Appendix
  Q.4 / T.6) — **not a code defect**. The one-attempt guard held (no duplicate create-export; `cec ≤ 1`).
- **Step-17 rollback (executed):** returned the 12 `report_sync_settings` to `schedule_enabled=false`; **brand-sales
  stays true** (1/13 enabled); rollout unchanged (1 IN enabled, `all_primary=false`); approvals unchanged
  (`brand-sales`/IN only — none were ever added for the 12); no cron. **Every LKG preserved** — IN live 9 rows
  (`16eae8af…`) and non-IN live 164 rows (`cc9c2c91…`) **byte-identical to preflight**; no snapshot deleted or
  overwritten. The shadow cycle `dfca8f75…` is left intact (scheduler-v2/* shadow namespace only; **zero live
  impact**; it cannot be finalized while non-drained, and no further DataDoe was spent to drain a cycle that
  cannot pass Phase C).

### AA.D Guardrails honored
No code change; no deploy/push/merge; no USA/other-account work; no `all_primary`; no cron/scheduling; no DataDoe
retry/fallback; no obsolete Product Catalog id; no deletion of any snapshot or LKG. Phases D/E were **not** reached.

**STOP for review.** Phase 2 cannot complete under the current authorization because a required `daily-reporting`
source timed out at DataDoe and no retry is permitted. Recommended next steps (each a SEPARATE authorization): (1)
re-attempt one fresh bounded shadow cycle for the 12 + IN when DataDoe `sales-traffic-asin-date` is stable; and/or
(2) resolve the Appendix-Q.4 DataDoe stability questions for the large sliced sources before retrying. brand-sales
for IN remains live and correct throughout.

## Appendix AB — Gate 7b Phase 2 RECOVERY drain HALTED by authorization (2026-08-16; drain-all superseded; cycle intact/resumable; NOTHING finalized or published)

**Authorized recovery (then superseded):** a recovery gate authorized *draining the EXISTING `dfca8f75…` cycle
without retrying failed exports, finalizing it honestly (partial), and publishing only independently-succeeded IN
reports* — **no new cycle**. Partway through the bounded drain, DataDoe instability proved broad (create-export
`TIMEOUT`s concentrated on `sales-traffic-asin-date`), so a follow-up authorization **superseded the drain-all** and
directed a **graceful STOP after the in-flight slice**: do not finalize, do not publish, keep the rollback state.
Reason given: ~6 succeeded vs ~8 failed with ~107 pending ⇒ continuing would spend a large export budget with very
low probability of completing report dependencies.

### AB.1 Recovery mechanics used (before the stop)
- **Resumed the SAME cycle only** (`non-us` / `2026-08-18` / manual / 12 reports / IN), bounded ~90s slices — never
  a new cycle.
- **Create-export TRIPWIRE:** a wrapped DataDoe adapter that aborts **before** any create-export POST for a
  `request_hash` already failed/attempted in this cycle (defense-in-depth atop the source-worker's skip-failed rule
  and the durable one-attempt claim). **It never fired.**
- **Per-slice invariants** enforced every continuation: same `cycleId`, no new cycle, the failed hashes stay
  `create_export_count=1`, every hash `≤1`, IN-only owners/report jobs, production live snapshots unchanged.
- The monitoring DB connection was hardened to a `pg.Pool` after a first run's long-lived `Client` was dropped
  ("Connection terminated unexpectedly"); the cycle **persisted and resumed idempotently with no duplicate export**.

### AB.2 Graceful stop (executed)
Killed the background drain loop and removed its runner (no possible re-launch); **no new slice started; no
additional DataDoe export created; no failed/attempted job retried, reset, or reopened; no new cycle; the cycle was
NOT finalized (open jobs remain); nothing published; nothing deleted.** The one-attempt claim + per-step durable
persistence guarantee an interrupted in-flight request leaves at most an `attempted` row with its saved `export_id`
(`create_export_count=1`) — never a duplicate.

### AB.3 Halt state — read-only capture of `dfca8f75…` (status **running**, NOT finalized)
- **122 source jobs:** succeeded **8**, failed **9**, attempted **4**, pending **101**.
- **Failures are ALL `sales-traffic-asin-date`:** `create-export/TIMEOUT` ×8, `poll/EXPORT_ERROR` ×1 — DataDoe
  export-infrastructure instability concentrated on this one sliced source; **no code defect**.
- **max `create_export_count` = 1** (0 rows > 1) — **no duplicate export** across both resumes and the interrupt.
- **IN-ONLY:** every source-job owner and report job is scoped to the IN account (`d658442d…`), report keys ⊆ the
  authorized 12, no ownerless source jobs.
- **0 reports complete:** all 8 materialized report jobs are `derive=pending/save=pending` (most sources still
  pending) — **nothing was publishable at the stop point.**
- **Live fingerprints UNCHANGED:** IN 9 rows (`16eae8af…`) + non-IN 164 rows (`cc9c2c91…`) == Appendix-AA.
- **Controls == rollback state:** rollout = 1 IN enabled (`all_primary=false`); approvals = {`brand-sales`/IN};
  `report_sync_settings` enabled = {`brand-sales`} (other 12 paused); no `pg_cron`.

### AB.4 Status + next steps
Gate 7b Phase 2 remains **INCOMPLETE**. `dfca8f75…` is **left intact and fully resumable** (deleted nothing).
brand-sales for IN stays live, approved, and byte-identical; the remaining 12 reports stay paused + unapproved; USA
and every other account are byte-identical; no cron; `all_primary=false`. A future **separate** authorization can
either (a) resume + honestly finalize this same cycle (expected `partial`) and publish only the reports whose full
source set independently succeeded, or (b) discard it and re-attempt fresh — **only after** DataDoe
`sales-traffic-asin-date` stability is resolved (Appendix Q.4), since that single source is the dominant failure.

**STOP for Codex review.** Halt evidence is docs-only and unpushed; production stays on `0ea9f34`.

## Appendix AC — Order Line Items source correction (OFFLINE, 2026-08-16; code+tests commit `feb0c83`; NOT deployed)

**Approved business decision:** Order Line Items (OLI — `item_price_value` = sales, `quantity` = ordered units,
`item_price_currency` = currency; sourceId `89b27535…`) is the **canonical sales/units source** for
daily-reporting, fba-plan, buy-box-loss, returns-leakage, ppc-performance. Implemented **offline on `main`** —
**no deploy/push/merge, no production/DataDoe/Supabase call**; the running Phase-2 cycle `dfca8f75` was NOT
touched; brand-sales/IN's live snapshot is unchanged.

### AC.1 What changed (per report)
| Report | Change | Shadow ver | Live ver |
|---|---|---|---|
| daily-reporting | sales/units → OLI; `item_price_currency` added to columns+groupBy; folds key currency in | `/v2d-1`→`/v2d-2` | `daily-reporting-shared-v1` (unchanged) |
| fba-plan | monthly-units + current-daily-dates → OLI `quantity` (units are currency-agnostic; no currency column) | `/v2d-1`→`/v2d-2` | `fba-plan-shared-v1` (unchanged) |
| ppc-performance | TACoS denominator → OLI sales, grouped by `item_price_currency`; sums ONLY the single Ads currency, degrades (typed reason) on any mismatch/mix | `/v2d-1`→`/v2d-2` | `ppc-performance-v1` (unchanged) |
| buy-box-loss | ADD `buy-box-loss:ordered` (OLI, grouped `sku,child_asin,item_price_currency`) for sales/units, joined on `currency\|sku`; Profit-by-SKU retained ONLY for `buybox_percentage` + `page_views` | `/v2d-1`→`/v2d-2` | `buy-box-loss-v1` (unchanged) |
| returns-leakage | denominator `units_shipped` → **ordered units** (OLI `quantity`, relabeled "Ordered Units"); numerator → **Returns record count** (was Sales&Traffic `units_refunded`); `units_shipped`/`units_refunded` dropped; frontend rate/labels/CSV updated | `/v2d-1`→`/v2d-2` | `returns-leakage-v1`→**`-v2`** (payload field rename) |

Aggregation **aliases** were preserved (`total_sales_sum`/`total_units_sum`/`sales_sum`/`units_sum`) so downstream
folds changed only for currency isolation. Live route builders (`api/datadoe.js`, `reports/{ppc,returns,buy-box}.js`)
and the scheduler folds (`derivation-core.js`) were edited as **byte-identical twins**; contract constants updated
in lockstep so the parity tests stay green.

### AC.2 Reports still legitimately using Sales & Traffic by ASIN & Date
**`sales-movers` ONLY** (probe + `sales-movers:traffic`) — it needs `session`/`page_views`/`total_orders`, which OLI
does not carry. Its `sales-movers:ads` still uses Profit by SKU & Date (unchanged). The `sales-traffic-asin-date`
contract's `consumers` list is now exactly `["sales-movers"]`. (Reports unaffected by this change: `sku-pl`,
`listing-health`, `reconciliation` keep their existing sources; `brand-sales`/`reconciliation` already used OLI.)

### AC.3 Judgment calls flagged for senior review
1. **returns-leakage re-sourcing:** numerator = Returns record count (item 4); denominator = OLI ordered units
   (item 7). The old Sales&Traffic shipped/refunded pair no longer exists. An ASIN with orders but **no returns and
   no refund events** is now **excluded** from the leakage report (documented in `report-returns.test.js` test 9).
2. **returns `sales`** (OLI `item_price_value`) is summed per-ASIN; the return RATE is currency-safe (units are
   currency-agnostic) and settlement money stays currency-isolated. The informational `sales` field is not
   currency-keyed and is unused by the UI.
3. **buy-box join** requires `profit-by-sku.currency` == OLI `item_price_currency` for the same SKU; a mismatch
   excludes that SKU (fail-closed, never a fabricated cross-source number).
4. **PPC TACoS** sums only OLI rows in the single Ads currency; any mismatch/mix degrades TACoS with a typed reason
   — never a cross-currency sum.

### AC.4 Verification (item 9)
`npm run verify` **green — 40 steps / 20 suites** (incl. `build:check`). New `scripts/oli-source-correction.test.js`
(14 deterministic, network-free tests) proves (a)–(j): OLI source keys for the five; none plan a Sales&Traffic
request; sales-movers keeps Sales&Traffic; buy-box buybox%/page-views from Profit-by-SKU with OLI sales/units;
PPC TACoS sums-in-Ads-currency + degrades on mismatch/mix; daily brand totals = sum of ASIN-level OLI rows;
fba-plan uses OLI `quantity` (ignores `total_units`); returns denominator = ordered units; cross-currency never
merges (daily/buy-box/returns → separate rows); a cross-account OLI fragment fails closed (derive-invalid, no
partial write); deterministic one-export-per-`request_hash` with distinct per-report identities. Golden
daily-reporting request-hashes recaptured; live↔scheduler parity preserved.

**STOP for Codex senior review.** Code+tests committed `feb0c83`, docs `<this commit>`; **not pushed** — production
stays on `0ea9f34`, and this correction is not deployed/rolled out by this work.

## Appendix AD — Codex senior-review blocker fixes on the OLI correction (OFFLINE, 2026-08-16; code+tests `dee77b7`; NOT deployed)

Codex senior review of Appendix AC raised six blockers. All are fixed **offline on `main`** (no deploy/push/DataDoe/
Supabase; the running cycle `dfca8f75` and brand-sales/IN live snapshot untouched). `npm run verify` green — **40
steps / 20 suites** (incl. `build:check`).

### AD.1 Real cross-report OLI reuse (was: "same source id is insufficient")
- New calendar-anchored slicer `canonicalOliSlices(from,to)` in `date-windows.js` — intra-month bins
  `[1-7],[8-14],[15-21],[22-28],[29-monthEnd]` clamped to `[from,to]`. Anchored to the CALENDAR (not to `from`), so
  reports ending at the same `asOf` share every interior + boundary slice; only each report's oldest (window-start)
  slice differs.
- ONE **canonical account-scoped OLI sales fragment** (`OLI_SALES_*`, parity source of truth in `api/datadoe.js`,
  mirrored in `report-source-contracts.js`): columns `[date, seller_or_vendor_id, sku, child_asin,
  item_price_currency]`, aggregations `item_price_value→total_sales_sum` + `quantity→total_units_sum`, order
  `date ASC`, limit 50000. `daily-reporting:oli-sales`, `fba-plan:oli-sales`, `buy-box-loss:oli-sales`,
  `returns-leakage:oli-sales`, `ppc-performance:oli-sales` all use this EXACT spec — so on an overlapping slice they
  produce the **same `request_hash` → one DataDoe export owned by multiple reports** (`owner_id` includes
  `reportKey`; the proven shared-`product-catalog` pattern). Each report rolls the canonical grain down to its own
  view (daily sums over sku+child_asin per date/seller/currency; fba derives per-ASIN monthly units + the latest-date
  probe from the ONE fragment; buy-box/returns key by currency; ppc filters to the Ads currency). **Reconciliation
  stays separate** (it needs order-level fields: `amazon_order_id`/`amazon_order_status`/…). Strict-cap, LKG, and
  single-account/organization isolation preserved on every fragment.
- Tests: the old "buy-box ≠ returns OLI hash" assertion is **replaced** by (i) cross-report hash EQUALITY on the
  shared August `[01-07]` slice, (ii) one `request_hash` → **three distinct report owners**, (iii) exactly one
  create-export per `request_hash`; plus `canonicalOliSlices` alignment tests.

### AD.2 Returns currency correctness (live `returns.js` + pure `derivation-core.js`)
Ordered evidence is folded by **`currency|ASIN`** (never ASIN alone); each row's `sales`/`orderedUnits` come from THAT
currency only (never a combined total copied into every settlement-currency row). Returns records carry no currency,
so a **multi-currency ASIN** puts its `returnCount` on exactly ONE deterministic primary row (greatest ordered units;
tie-break lexicographic currency), 0 on the others, and **withholds the rate** (`returnedUnits=null`) on all its rows.
USD+CAD regressions prove: no duplicated counts (per-ASIN `returnCount` sum = true record count), no duplicated
sales/units, per-currency isolation, and the withheld rate.

### AD.3 PPC TACoS currency validation (live `ppc.js` + pure `derivation-core.js`)
Require **exactly one** Ads currency; then EVERY non-empty OLI total-sales row must carry a nonblank **canonical**
(trim+UPPERCASE) currency EQUAL to it. Any missing/blank/malformed/mismatched, or a currency mix ⇒ TACoS unavailable
(typed reason), and **no row is summed** — a currencyless row is never summed into a currency denominator. Regressions
cover match / mismatch / mix / blank.

### AD.4 Daily Reporting Ads currency
The daily Ads export now requests **`ad_campaign_budget_currency`** (added to columns AND groupBy) and
`normalizeAdRows` normalizes it into `currency` (canonical UPPERCASE, or null when blank). The currency-keyed
`mergeSalesAndAds` merges an Ads row ONLY into the OLI sales row of the SAME currency; a blank/unprovable Ads currency
is `null` and never merges (fail-closed — the sales row simply shows no ads). This also fixes a latent bug from
Appendix AC (the currency-keyed merge with currencyless ad rows would never have merged). Regressions: USD sales +
USD ads → one merged row; blank/mismatched ads → no merge.

### AD.5 Text + cleanup
Corrected Daily (Order Line Items) and Returns (rate = Returns-record count ÷ OLI ordered units) wording and removed
the last stale Sales & Traffic `units_shipped`/`units_refunded` statements (sales-movers legitimately keeps Sales &
Traffic; `units_shipped_t30` is the unrelated FBA-inventory metric). Removed dead constants left by the earlier
per-report approach (`PLAN_UNITS_*`, `PLAN_DAILY_*`, `PPC_TOTAL_SALES_*`, `planAsinUnits`, `PLAN_SALES_ROW_LIMIT`).

### AD.6 Versions + verification
Shadow `snapshotVersion` `v2d-2 → v2d-3` for the five (canonical grain changed); returns live version stays
`returns-leakage-v2` (field names unchanged, values corrected). Live builders and scheduler pure folds kept
byte-equivalent (parity harnesses green). Adversarial tests added for every finding.

**STOP for Codex re-review.** Code+tests `dee77b7`, docs `<this commit>`; **not pushed** — production stays on
`0ea9f34`; nothing deployed.

## Appendix AE — Codex re-review blocker fixes, round 2 (OFFLINE, 2026-08-16; code+tests `622716f`; NOT deployed)

Codex re-review of Appendix AD raised three more blockers; all fixed **offline on `main`** (no deploy/push/DataDoe/
Supabase; the running cycle `dfca8f75` and brand-sales/IN live snapshot untouched). `npm run verify` green — **40
steps / 20 suites** (incl. `build:check`); `git diff --check` clean.

### AE.1 Real manual + scheduler OLI reuse in the LIVE Daily + FBA paths
The scheduler contracts already used the canonical fragment + `canonicalOliSlices`, but the **live (browser/manual)**
Daily and FBA paths did not, so their `request_hash`es didn't match the scheduler's and no export was actually reused.
- `api/datadoe.js fetchDailyBrandSalesRows` now slices by `canonicalOliSlices(from,to)` and fetches each slice with
  the **exact** canonical OLI spec (`OLI_SALES_COLUMNS/GROUP_BY/AGGREGATIONS`, limit 50000, `orderByColumn:"date"`,
  `orderByDirection:"ASC"`) — so the manual named-brand + all-brand superset is byte-identical in request identity to
  the scheduler `daily-reporting:oli-sales` fragments.
- The Daily **ALL-brand** branch no longer spends a separate compact export; it derives all-brand from the SAME
  canonical superset via `rollupSupersetToDaily` (a byte-identical twin added to `api/datadoe.js`), matching the
  scheduler's `dailyReportingPayload` ALL branch. Removed the now-dead `DAILY_SALES_GROUP_BY` (a few `DAILY_*`
  constants remain, still required by the text-parity harness / `/datadoe` pass-through debug handler).
- The **FBA** route's OLI fetch now loops `canonicalOliSlices(completed[0].from, current.to)` with a per-slice strict
  cap (was one unsliced fetch).
- Tests: the cross-report proof now spans **all five** OLI reports sharing one `request_hash` on the shared slice; a
  new **(iv)** asserts **LIVE == SCHEDULER request identity** for daily + fba on every canonical slice (a manual
  refresh reuses the scheduled export); and an **executable worker-level `24b`** builds a 2-report shadow plan, runs
  `runSourceJobs`, and asserts the shared canonical OLI slice yields **one create-export + two report-owner
  memberships**.

### AE.2 PPC TACoS fail-closed on ANY currency ambiguity (Ads or OLI)
- `adsCurrencySignal` (`source-signals.js`) now canonicalizes each row's currency (trim + UPPERCASE) and counts a
  **blank/malformed** Ads currency as its own violation bucket: `USD + a blank row ⇒ currencyCount 2 ⇒
  evaluateAdsCurrencyGate false ⇒ total-sales (TACoS) is not planned** (fail closed at the gate).
- The pure `ppcPerformancePayload` **and** the live `buildPpcPerformance` twin require **exactly one nonblank
  canonical Ads currency AND no blank Ads row**, then every nonempty OLI total-sales row must carry that same
  canonical currency; any missing/blank/malformed/mismatched/mixed (Ads or OLI) ⇒ `totalSales=null` + typed reason,
  never summed. **Everything else in the PPC payload is preserved** when TACoS is unavailable.
- **Known residual (safe):** an all-blank Ads-rows set passes the gate as count 1 (an unnecessary scheduled export in
  that corruption case), but the payload guard still fails TACoS closed — so no wrong number is ever shown; the
  realistic single-currency-plus-blank case fails closed at the gate.

### AE.3 Returns aggregate-rate accuracy + currencies union
- The portfolio return rate is now a **PROVEN** rate (`returnsPortfolioRate` in `insights.js`): the numerator AND
  denominator sum only over rows whose `returnedUnits` is known. A withheld-`returnedUnits` row (a currency-ambiguous
  ASIN) is **excluded from BOTH** — its ordered units never sit in the denominator to understate the rate. When such a
  row carries ordered units the KPI is a **proven PARTIAL**, marked "· partial" with a tooltip in `ReturnsLeakage.jsx`,
  never an understated complete rate.
- Payload `currencies` (live `returns.js` + pure `derivation-core.js`) is now the canonical **union of the nonblank
  currencies emitted on the rows** (deduped, sorted) — not the settlement-fold currencies (so an ordered-only currency
  is no longer dropped). Live == pure.
- Tests: mixed-currency regressions prove the proven-partial rate, the partial marker, and `payload.currencies` =
  emitted-row union.

**STOP for Codex re-review.** Code+tests `622716f`, docs `<this commit>`; **not pushed** — production stays on
`0ea9f34`; nothing deployed.

## Appendix AF — Codex re-review blocker fixes, round 3 (OFFLINE, 2026-08-16; code+tests `a1de539`; NOT deployed)

Codex re-review of Appendix AE raised two more blockers; both fixed **offline on `main`** (no deploy/push/DataDoe/
Supabase; the running cycle `dfca8f75` and brand-sales/IN live snapshot untouched). `npm run verify` green — **41
steps / 21 suites** (incl. `build:check` and the new `test:currency` suite); `git diff --check` clean.

### AF.1 Strict PPC currency evidence
- New **dependency-free leaf** `lib/server/currency.js` (imports nothing — safe for the transport-free derivation
  graph): `canonicalCurrency(value)` accepts ONLY a trimmed, UPPERCASE ISO-style 3-letter code (`^[A-Z]{3}$`) and
  returns it or `null` (`"usd"→"USD"`, `"US D"`/`"USDX"`/`""`/`null → null`); and a shared 4-state
  `adsCurrencyEvidence(rows)` classifier → `single-valid` | `empty` | `invalid` | `multiple` (any blank/absent/
  malformed row ⇒ `invalid`).
- `adsCurrencySignal` (`source-signals.js`) now folds via `adsCurrencyEvidence` and carries an explicit `state`;
  `validateAdsCurrencySignal` requires it; `evaluateAdsCurrencyGate` returns true **only** for
  `state==="single-valid"`. So **empty / all-blank / malformed / multiple** Ads evidence all fail closed and
  `planPpcPerformance` emits **zero** `ppc-performance:oli-sales` exports (case (a) alone schedules). This closes the
  AE.2 residual (all-blank previously passed the gate).
- Both TACoS folds — live `buildPpcPerformance` and the pure `ppcPerformancePayload` twin (byte-equivalent) — decide
  via `adsCurrencyEvidence(...).state==="single-valid"` and require every OLI total-sales row's
  `canonicalCurrency(item_price_currency)` to be non-null and equal to that single valid Ads currency. This fixes the
  real bug: a **malformed-but-nonblank** Ads currency (e.g. `"US D"`) previously read as valid and could be summed —
  now it fails closed. The rest of the PPC payload is preserved when TACoS is unavailable.
- Regressions at every layer (`currency.test.mjs`, signal matrix in `sync-signals.test.js`, gate/planner in
  `report-source-contracts.test.mjs` + a planner zero-export case, live+scheduler fold matrix in
  `report-ppc-performance.test.js` test 46): `US D`, USD+blank, all-blank, empty, mixed, lowercase-valid,
  matching-valid.
- Safety note: the fail-closed signal literals (`{failed,false,currencyCount:null}`) in `ppc-ads-loader.js` /
  `source-sync-driver.js` are structurally guarded — `planPpcPerformance` early-returns on `!validated` **before** the
  gate, so a stateless failed signal never reaches `validateAdsCurrencySignal` (the same guard that already protected
  the pre-existing `currencyCount:null`).

### AF.2 Correct proven/partial Returns portfolio rate
- `returnsPortfolioRate` (`insights.js`): a row is **eligible** for the rate ONLY when `returnedUnits` is known AND
  `orderedUnits > 0` AND it is **not lag-inflated** (`returnedUnits ≤ orderedUnits`). Ineligible rows contribute to
  **neither** the numerator nor the denominator (previously lag-inflated rows were summed and no-denominator rows
  leaked into the numerator). `ratePartial` is set whenever excluded evidence could move the rate: (i) a
  currency-ambiguous withheld row, (ii) returns with no usable denominator, (iii) lag-inflated.
- `ReturnsLeakage.jsx`: when no eligible denominator remains, the KPI shows an **explicit "unavailable · partial"**
  state (with a tooltip naming the exclusions) — never a numeric rate and never a plain "—" that reads as
  complete/no-returns.
- Regressions (`test-insights.mjs`): 20 returned / 10 ordered (lag-inflated), returns with null/zero ordered, mixed
  eligible+ineligible, all-ineligible, and a fully-eligible control.

**STOP for Codex re-review.** Code+tests `a1de539`, docs `<this commit>`; **not pushed** — production stays on
`0ea9f34`; nothing deployed.

## Appendix AG — Codex re-review blocker fixes, round 4 (OFFLINE, 2026-08-16; code+tests `1fb09c1`; NOT deployed)

Codex re-review of Appendix AF raised two more blockers; both fixed **offline on `main`** (no deploy/push/publish/
DataDoe/Supabase; controls/approvals/cron untouched; the running cycle `dfca8f75` not resumed; the approved Returns
implementation unchanged). `npm run verify` green — **41 steps / 21 suites** (incl. `build:check`); `git diff --check`
clean.

### AG.1 Live/manual PPC zero-export currency gate (transport ordering)
The AF.1 fix made the pure scheduler fold and the planner fail closed, but the **live** `buildPpcPerformance` still
fetched the OLI total-sales slices **before** classifying the Ads currency — so empty/all-blank/`US D`/USD+blank Ads
still spent OLI export calls.
- `lib/server/reports/ppc.js`: the Ads currency is now classified with `adsCurrencyEvidence` **before** any
  `canonicalOliSlices` / `fetchExportRowsStrict` call. The OLI fetch loop is entered **only** when
  `state === "single-valid"`; empty / all-blank / valid+blank / malformed (`"US D"`) fail closed up front and spend
  **exactly zero** OLI export calls. The existing `currencies.length > 1` branch (the distinct multi-currency reason)
  is kept **unchanged** so the live path stays byte-parity with the scheduler's `PPC_MULTI_CURRENCY_REASON`; the
  OLI-row currency check and the degrade `try/catch` are preserved for the single-valid path. The rest of the PPC
  payload and the unconditional catalog fetch are untouched.
- A **minimal DI seam** (an optional second `deps` argument; production callers pass none, and the strict-transport
  default remains a genuine `fetchExportRowsStrict` call — so the contract suite's strict-transport guard stays
  genuinely satisfied) makes the live path executably testable.
- New **test 47** drives a real `buildPpcPerformance` through injected stubs with an OLI-export **spy**: single valid
  USD ⇒ OLI may run (≥1 call); empty / all-blank / `"US D"` / USD+blank / USD+EUR ⇒ **0** OLI export calls, `totalSales`
  null, a typed unavailable reason, and the rest of PPC intact (every Ads row still counted). This is the executable
  live-path transport-ordering regression Codex required (not a pure-fold or planner-only test).

### AG.2 Totally typed failed Ads-currency signals
- One shared producer `failedAdsCurrencySignal()` → `{status:"failed", validated:false, currencyCount:0,
  state:"invalid"}` in `source-signals.js`, now used by `adsCurrencySignal` (non-array), `ppcAdsCurrencySignalOf`
  (`ppc-ads-loader.js`) and `reconstructSignals` (`source-sync-driver.js`) — so the fail-closed shape cannot drift.
  The old `{...,currencyCount:null}` was **rejected** by `validateAdsCurrencySignal`; the typed shape validates cleanly.
- Tests prove a failed/unavailable ads read (a) validates via `validateAdsCurrencySignal` (no throw), (b) gates OFF via
  `evaluateAdsCurrencyGate`, and (c) schedules **zero** `ppc-performance:oli-sales` sources through the real
  `runStagedSourceCycle` driver. The `currencyCount:null` pins in `report-ppc-performance.test.js` /
  `sync-signals.test.js` are updated to the typed shape (coverage strengthened, not removed).

**No production side effects:** the transport test runs entirely on injected stubs (no network/DB call). Live builders
and scheduler pure folds kept byte-equivalent (the pure `ppcPerformancePayload` twin is unchanged); no assertions
weakened.

**STOP for Codex re-review.** Code+tests `1fb09c1`, docs `<this commit>`; **not pushed** — production stays on
`0ea9f34`; nothing deployed.

## Appendix AH — Codex re-review blocker fix, round 5: PPC canonical-currency consistency (OFFLINE, 2026-08-16; code+tests `dbd4726`; NOT deployed)

Codex re-review of Appendix AG raised one consistency blocker; fixed **offline on `main`** (no deploy/push/publish/
DataDoe/Supabase; controls/approvals/rollout/cron untouched; the running cycle `dfca8f75` not resumed; the approved
Returns implementation unchanged). `npm run verify` green — **41 steps / 21 suites** (incl. `build:check`); `git diff
--check` clean.

### AH.1 The bug
Ads rows `[{currency:"usd"},{currency:"USD"}]` canonicalize to ONE currency (USD), so `adsCurrencySignal` ⇒
`single-valid` and the scheduler **planner** schedules the OLI slices. But the **live** `buildPpcPerformance` used a
raw case-sensitive `currencies.length` (⇒ 2 ⇒ "multiple", skipped OLI) and the scheduler **derive adapter**
(`report-derivation.js`) used a raw distinct-nonblank count (⇒ "multiple" **after** the exports were spent). Planner /
live / derive disagreed, and the derive threw away exports the planner had already fetched.

### AH.2 The fix — one canonical interpretation everywhere
- **Live `ppc.js` `buildPpcPerformance`:** removed the raw `currencies.length` decision from the TACoS gate; it now
  classifies `adsCurrencyEvidence(adsRows)` **once, before any OLI fetch** — `multiple` ⇒ the exact multi-currency
  reason, `empty`/`invalid` ⇒ the exact mismatch reason (both **zero** OLI calls), `single-valid` ⇒ the OLI
  fetch/validate/sum loop.
- **Derive adapter `report-derivation.js`:** replaced its raw `new Set(...).size > 1` branch with the same
  `adsCurrencyEvidence` 4-state logic and the **same exact reason strings** (added
  `PPC_TOTAL_SALES_CURRENCY_MISMATCH_REASON`, copied verbatim from `derivation-core.js`). `empty`/`invalid`
  short-circuit to the mismatch reason with no `ts` read (matching the live builder); `single-valid` keeps the `ts`
  read + the degraded fallback.
- **Consistency:** the planner gate, the live builder, the derive adapter, and the pure `ppcPerformancePayload` fold
  now all key on the same four evidence states with byte-identical reasons (verified: the MULTI string appears in 2
  sites and the MISMATCH string in 3 sites, all identical).
- **Canonicalized currency identities** (both `ppc.js` and the byte-equivalent `derivation-core.js` twin): the payload
  `currencies` field and the `rollupPpcRows` + daily-series currency keys use `canonicalCurrency`, so `usd`+`USD`
  collapse to one money identity (`["USD"]`, one campaign bucket) — no false multi-currency KPI suppression and no
  duplicate campaign rows — while `USD` vs `EUR` stay distinct and a malformed currency buckets under `"?"`.

### AH.3 Executable regressions (tests 48–51)
`usd`+`USD` ⇒ one canonical identity (`currencies == ["USD"]`, one campaign row), OLI **allowed**, TACoS **computes**,
and the signal / planner gate / live builder / derive+pure fold **all agree** (test 49). `USD`+`EUR` ⇒ `multiple` ⇒
**zero** OLI calls + the exact multi-currency reason in the live builder **and** the derive. `USD`+blank and `"US D"`
⇒ `invalid` ⇒ **zero** OLI calls + the exact mismatch reason in both. The prior one-create-per-`request_hash` dedup and
every earlier reason string remain byte-exact. No production side effects (the transport regressions drive the code
through injected DI seams / direct pure-fold calls — no network/DB call).

**STOP for Codex re-review.** Code+tests `dbd4726`, docs `<this commit>`; **not pushed** — production stays on
`0ea9f34`; nothing deployed.

## Appendix AI — Guarded production deploy + publish-ready IN rollout (EXECUTED 2026-08-16)

### AI.1 Authorization, verification, push, and deploy
- The operator explicitly authorized committing, deploying, and making every ready report live.
- `npm run verify` passed all **41 steps across 21 suites**, including `build:check`; focused PPC tests passed
  **51/51** and currency tests passed **5/5**. `git diff --check` was clean.
- Reviewed `main` commit `02c2ef5858cb4bcb6b11ca5da5611e3fd5e080e1` was pushed to `origin/main`.
- The Git-connected production deploy completed as `dpl_GzXYRLSKGYJKwMzU5oTVozkfn56x`; the production alias
  `https://upriverdashboard.vercel.app` returned HTTP 200 and rendered the dashboard sign-in screen.
- Production secrets were loaded only from the untracked environment file; no value was printed or committed.

### AI.2 Pre-execution baseline and scope
- Durable rollout: exactly one enabled IN account (`d658442d-6273-4c2d-aeda-f247e638ef98`), `all_primary=false`.
- Durable controls/approvals: only `brand-sales` enabled and approved. No `pg_cron` Scheduler-v2 job existed.
- Live snapshots: count **173**, digest `80cc74fb9a3647594d2d0ba9fa22e28e`; shadow snapshots: count **23**,
  digest `c088e1dd8e60b7315238912d5e9bcd8c`.
- The earlier halted cycle `dfca8f75...` remained `running` at 8 succeeded / 9 failed / 4 attempted / 101 pending.
  It was not resumed, retried, reset, finalized, or mutated.
- Europe, USA, and every account except the exact approved IN account were out of scope and excluded.

### AI.3 Fresh bounded IN-only shadow cycle
- A new cycle was opened for the remaining 12 reports only: bucket `non-us`, cycle date `2026-08-19`,
  `asOf=2026-08-15`, cycle `cf6bb0ff-4269-4b19-a7ce-a8b932aa36ff`.
- The first operator invocation stopped on a throwaway guard comparing a PostgreSQL `date` through a timezone-bearing
  JavaScript value. The guard was corrected to compare `cycle_date::text`, and the same cycle was resumed. This was
  an operator-check defect, not a scheduler defect; no second cycle or duplicate export was created.
- Per-slice guards proved: IN-only owners/report jobs; no ownerless source jobs; every
  `create_export_count <= 1`; zero duplicate creates; only catalog source `68d2de238e`; unchanged live snapshots;
  unchanged unrelated-account shadows; unchanged controls; and no mutation of `dfca8f75...`.
- The cycle drained and was finalized exactly once to **`partial`** with `finished_at` set: sources
  **127 total / 88 succeeded / 39 failed**, reports **12 total / 3 succeeded / 9 failed**.
- Successful reports: `content-changes`, `keyword-rank`, `listing-optimizer`.
- Failed/unavailable reports: `buy-box-loss`, `daily-reporting`, `fba-plan`, `listing-health`, `ppc-performance`,
  `reconciliation`, `returns-leakage`, `sales-movers`, `sku-pl`.
- Typed upstream failure breakdown: `order-line-items` create-export TIMEOUT x16; `settlements` TIMEOUT x10;
  `profit-by-sku-date` TIMEOUT x8; `product-catalog` TIMEOUT x2; `returns` TIMEOUT x2; `listings-raw` TIMEOUT x1.
  The one-attempt guard held; no failed hash was retried.

### AI.4 Publish-ready results
- Only the three succeeded reports were enabled and given audited IN-only publish approvals.
- `buildSchedulerV2Publisher()` returned `published` for all three:
  - `content-changes` — 680-byte validated live payload;
  - `keyword-rank` — 5,042,282-byte validated live payload;
  - `listing-optimizer` — 6,581,954-byte validated live payload.
- Every candidate was tied to its exact succeeded report job, terminal cycle, params hash, and validated shadow
  snapshot. Live natural-identity reads confirmed inline payloads, no stale storage pointer, and a nonblank
  `source_refreshed_at`.
- Before/after publication, unrelated live data stayed byte-identical: non-IN count **164**, digest
  `fb353dadee4457ec81fce45fb2c1fb15`; unrelated IN rows count **172**, digest
  `6811ddf83379750f57f6ae8d7a1b681c`. Shadow state also stayed stable during publishing: count **26**, digest
  `47ac4c6f963a1216342822e4f9ad3f9d`.

### AI.5 Final production state and stop
- Exact enabled + approved IN reports: `brand-sales`, `content-changes`, `keyword-rank`, `listing-optimizer`.
- The other nine reports are disabled and unapproved; no unavailable/blocked snapshot was published.
- Final live snapshot count is **176**, digest `4058535b9a3944b8ab774c927d88329a`; shadow count is **26**.
- Rollout remains exactly one IN account; `all_primary=false`; no Europe/USA account was added; no cron exists.
- The dashboard deployment is live and usable for the four approved IN reports. Automatic Scheduler-v2 cadence is
  still intentionally unscheduled. Completing the other nine reports requires fresh successful DataDoe exports (or
  a reviewed DataDoe-supported partition/remediation); Europe and USA each require their own account-specific canary
  and publication gate.

## Appendix AJ — Source-first tranche orchestration (OFFLINE, 2026-08-17; code+tests `1c61c7c`; docs `<this commit>`; NOT deployed)

### AJ.1 Why (motivation from Appendix AI)
The guarded IN rollout (Appendix AI) confirmed the report-first fan-out's failure mode empirically: opening all 12
reports at once created ~127 source jobs whose create-exports overwhelmed the primary DataDoe — `order-line-items`
create-export **TIMEOUT x16**, `settlements` x10, `profit-by-sku-date` x8, `product-catalog` x2, `returns` x2,
`listings-raw` x1 — leaving 9 of 12 reports unavailable. Source-first orchestration inverts the driver: drain ONE
canonical source family across the approved accounts, save + validate it durably, reuse it everywhere it is shared,
then move to the next family. A report is derived only after ALL its exact source dependencies are validated (the
existing `reportFetchGate`, unchanged). This bounds concurrent DataDoe pressure to a single family at a time and makes
a shared source (e.g. the one OLI slice five reports need) cost exactly one export.

This work is **shadow/offline only**: no production, DataDoe, Supabase, deploy, schedule, control, approval, or
cycle-resume. `npm run verify` green — **42 steps / 22 suites** (incl. `build:check`); `git diff --check` clean;
focused `test:source-tranche` 16/16. The running cycle `dfca8f75...` is untouched; these commits are LOCAL-only
(unpushed) — `origin/main` and the deployed production remain at `02c2ef5` (the Appendix AI baseline).

### AJ.2 The tranche selector (build-time, plan-derived, fail-closed)
`lib/server/sync/source-tranche.js` (pure, zero I/O):
- `makeSourceTranche(spec)` returns a FROZEN `{ name, mode, sourceKeys:Set, requestHashes:Set, selects(job) }`. It
  accepts EXACTLY ONE of `{ sourceKeys:[...] }` or `{ requestHashes:[...] }` (both / neither / blank / non-object ⇒
  throw). `selects(job)` reads `job.sourceKey ?? job.source_key` (or `job.requestHash ?? job.request_hash`), so it
  matches a canonical job in either camel or snake case. Idempotent: an already-built descriptor passes through unchanged.
- It is fixed at COMPOSE time only: `buildSchedulerV2Runtime` gained a `sourceTranche` override (normalized, added to the
  trusted `collaborators`, NEVER on `RUN_OPERATIONAL_ARGS`), and `buildSchedulerV2SourceTrancheRuntime(spec, overrides)`
  deletes any `sourceTranche` smuggled through `overrides` before fixing the reviewed one (mirrors
  `buildSchedulerV2CanaryRuntime`). No per-run / untrusted caller can widen execution to an unintended family.

### AJ.3 Exact source order (`SOURCE_TRANCHE_ORDER`)
`sourceTrancheOrder()` derives the order from `REPORT_SOURCE_CONTRACTS` and cross-checks it at module load: a fetched
family with no tranche, a classified family no contract declares, or a family in two tranches all THROW
(drift / gap / overlap fail closed). Tranche 1 must be exactly OLI and tranche 2 exactly the catalog. Resulting order:

| # | Tranche | Source families | Rationale |
|---|---------|-----------------|-----------|
| 1 | `order-line-items` | order-line-items | the single canonical OLI sales fragment (5 reports share it) |
| 2 | `product-catalog` | product-catalog | organization-wide catalog (identity/coverage for the rest) |
| 3 | `date-sliceable` | settlements, returns, profit-by-sku-date, sales-traffic-asin-date | remaining date-windowed history families |
| 4 | `current-state` | listings, listings-raw, fba-inventory-health, content-changes | current-state snapshots (no/short as-of) |
| 5 | `staged-signal` | sqp-weekly, sqp-monthly | staged / signal-dependent SQP families |

`sales-traffic-asin-date` is exclusive to Sales Movers, but the FAMILY carries a date window, so it is classified
date-sliceable (tranche 3); each family appears in exactly one tranche and their union equals the declared contract
source set (proven by the `order` test).

### AJ.4 Source-first state table (one tranche pass over a shared cycle)
For a single `runSourceJobs` pass with tranche T over bucket/cycle_date C:

| Job class | Upserted? | Executed this pass? | End state after the pass | Next tranche |
|-----------|-----------|---------------------|--------------------------|--------------|
| In T, `pending`, no cache | yes | yes (claim→create→poll→download→save) | `succeeded` (export_id set) or `failed`/`deferred` | done, or retryable |
| In T, `pending`, EXACT cache hit | yes | reuse (0 DataDoe) | `succeeded`, export_id NULL, cache_object_path set | done |
| In T, `attempted` (export_id saved) | yes | resume poll/download only (0 create) | `succeeded`/`failed`/`deferred` | resumable |
| NOT in T | yes | no | stays `pending` | executed when its tranche runs |
| Owner membership (any family) | yes (full plan) | n/a | `active` | carried in the shared cycle |

Because every planned family is upserted BEFORE the execution filter, a filtered pass leaves the un-selected families
`pending`; `drained = !unfinished && !deadlineReached` where `unfinished` scans ALL owned canonical jobs (not just the
executed subset), so a narrowed tranche is NEVER drained and the dispatcher does not finalize the cycle. The next
`buildSchedulerV2SourceTrancheRuntime(next)` invocation re-opens the SAME `(bucket, cycle_date)` cycle (`openCycle` is
keyed on it) and executes the next family with no duplicate export for already-succeeded hashes (tests 8 + 9). A `null`
tranche (every existing caller) executes every family — behavior byte-identical to before.

### AJ.5 Cache-reuse acceptance matrix (Part C, BEFORE any create-export)
The reuse path runs only for a `pending` job and only when `store.loadSourceRows` exists (injected test/canary stores
without it keep the old path). It reuses the durable `source_export_cache` entry iff ALL hold; ANY miss records nothing
and falls through to the normal one-create path:

| Condition | Accept requires | On failure |
|-----------|-----------------|------------|
| Entry exists + unexpired | `getSourceExportCache` non-null (its query is `expires_at > now`) | miss ⇒ create |
| Rows present + array | `Array.isArray(entry.rows)` | malformed ⇒ create |
| Source identity | `entry.source_id === job.sourceId` (nonblank) | mismatch ⇒ create |
| Organization identity | `entry.organization_fingerprint === job.organizationFingerprint` (nonblank) | mismatch ⇒ create |
| Account scope identity | `entry.account_scope_hash === job.accountScopeHash` (nonblank) | mismatch ⇒ create |
| Object path present | nonblank `entry.object_path` | blank ⇒ create |
| Integrity | `entry.row_count === entry.rows.length` (a number) | mismatch ⇒ create |
| Not truncated | NOT (`job.strict === true` AND `rows.length >= job.limit`) | cap-sized ⇒ create |

`request_hash` already folds org + account scope + full request meta; the explicit source_id / org / scope equality
checks are belt-and-suspenders. On confirm, `recordSourceSuccess({ exportId:null, rowCount, payloadBytes,
cacheObjectPath })` — ZERO DataDoe calls, the claim RPC is NEVER touched, so `create_export_count` stays `0` and
`attempted_at` stays `null`, and NO export id is fabricated. A reused row is distinguishable from a freshly-fetched one
ONLY by `export_id IS NULL AND cache_object_path IS NOT NULL`. Proven by test 4 (accept) and test 5's five sub-cases
(expired / mismatched source_id / mismatched scope / non-array / cap-sized all ⇒ exactly one create).

### AJ.6 Preserved invariants (NOT weakened)
- One create-export POST per `request_hash`; export_id persisted before poll; `attempted` rows resume via poll/download
  with zero new POSTs (the reuse block is skipped for non-pending jobs). Tests 6 + 12.
- Canonical dedup (one row per hash) + full owner memberships; owner_id recomputed and scope-checked; no ownerless /
  cross-account / cross-organization job. Tests 2 + 13.
- Derive gate unchanged: a report stays pending until ALL its deps succeed; a failed dep preserves LKG and never blocks
  an unrelated complete report. Tests 10 + 11.
- Request hashes (`source-identity.js`), source contracts (`report-source-contracts.js`), and report folds/payloads are
  untouched — the tranche order only READS the contracts for its drift cross-check.

### AJ.7 Residual DataDoe questions (for Codex senior review)
1. **Manual/UI-export adoption is deliberately UNSUPPORTED.** DataDoe's export GET does not return the original request
   parameters (columns / groupBy / aggregations / from / to / limit / account scope), so a UI-visible export cannot be
   proven to equal a canonical `request_hash`. Reuse therefore requires a durable `source_export_cache` row keyed by the
   exact hash (test 7 proves a source-name-only "manual" entry is rejected and a real export is created instead). **Open
   question:** is there any DataDoe endpoint that returns an export's full original request parameters? If so, a SEPARATE
   reviewed adoption design (recompute the hash from the returned params, then confirm) would be required — an unsafe
   name-only match must never be added.
2. **Reuse telemetry shape.** A reused job intentionally has `create_export_count=0` / `attempted_at=null` /
   `export_id=null` and points at the pre-existing object. Confirm this shape is acceptable for dashboards/alerting,
   since a reused job is distinguishable only by `export_id IS NULL AND cache_object_path IS NOT NULL`.
3. **No live confirmation yet.** All 14 requirements are proven against in-memory stores + an injected DataDoe spy; the
   TTL/reuse behavior is validated only against the modeled `expires_at > now` gate. A one-account READ-ONLY shadow
   confirmation is warranted before any cutover — NOT done here.

**STOP for Codex senior review.** Code+tests `1c61c7c`, docs `<this commit>`; **not pushed** — `origin/main` and the
deployed production remain at `02c2ef5`; nothing deployed, scheduled, or resumed.

## Appendix AK — Source-first foundation + Daily/Brand View priority tranche (OFFLINE, 2026-08-20; 7 code commits `83a088d`..`2227f16`; docs `<this commit>`; NOT deployed)

### AK.1 Scope + authorization
Authorized continuation from `65f5612` (Blockers 4a-4d complete): finish the offline source-level
synchronization foundation and the first high-priority dashboard tranche (Daily Reporting + Brand View),
WITHOUT touching production, DataDoe, Supabase, deploys, controls, crons, or the halted cycle `dfca8f75`.
Everything below is offline (injected fakes, reuseOnly + create-export tripwire), committed locally, unpushed.
`npm run verify` green — **53 steps / 33 suites** (incl. `build:check`); `git diff --check` clean.

### AK.2 The seven commits
| Commit | Phase | What |
|---|---|---|
| `83a088d` | 2 | **Source dependency registry** (`source-registry.js`): 16 typed immutable records (12 fetched + 4 durable-Ads families) — DataDoe id, seller/org scope, grain, batching rules, downstream reports+dashboards, backfill/refresh policy, token class (premium EXACTLY profit-by-sku-date/listings/fba-inventory-health), plan staticism, storage strategy. Module-load cross-checks vs SOURCE_CONTRACTS / REPORT_SOURCE_REQUIREMENTS / SELLER_SCOPED_REQUEST_KEYS / SOURCE_TRANCHE_ORDER; ANY unregistered or contradictory dependency THROWS. |
| `cbe33cf` | 1 | **Global source-family fixpoint orchestrator** (`source-fixpoint.js`): plans the complete graph FIRST, walks SOURCE_TRANCHE_ORDER one family at a time (durable per-family completion, never a narrowed pass's `drained`), re-enters the SAME (bucket, cycle_date) cycle across bounded continuations + bounded re-walks (staged deps that surface late), completion-anchored >=60s cooldown on an injected clock/waiter, REQUIRED-source failure stops the bucket, typed stall/exhaustion stops. Engine wiring (additive, null byte-identical): dispatcher tranche-scoped open-work continuation probe + `trancheDrained`; Blocker-4d budget wiring (generic-unit ceilings frozen per (cycle, tranche#generic) via `budgetPlanner`; `makeSupabaseSourceStore` gains the budget wrappers). |
| `b1fc163` | 3 | **Durable model**: migration `20260820_source_durable_model.sql` (PREPARED, UNAPPLIED; registered in schema-contract; audit green) — OLI history at full-grain PK (corrections REPLACE), succeeded-only coverage, source_controls (pause + `schedule_enabled default false`), source_run_status, validated-only source_snapshots. Wrappers (typed schema-missing vs failed; snapshot wrapper REFUSES non-validated evidence pre-HTTP). Pure policy: 420d backfill / 7d rolling windows, gap-only slice planning, per-slice member-subset batching, fragment->history attribution, once-daily snapshot decisions. `brand-resolution.js`: ASIN wins; unique-SKU fallback; conflicting/blank UNMAPPED; "Unassigned" never a real brand. |
| `e96613c` | 3-4 | **Bucket source sync + durable dashboards**: `source-bucket-sync.js` — ONE operator action per bucket; stable <=5-account batches (30=>6, 31=>7, no reshuffle); OLI slice exports scoped to exactly the members missing each slice (new account backfills SOLO); slice hashes BYTE-IDENTICAL to the five OLI reports' canonical fragment (one export, many owners; synthetic `source-sync` owner family); durable org-wide catalog = NEW versioned request `source-catalog:durable-v1` (the only catalog spec fetching `sku`; golden hashes untouched); FBA per-account premium-priced snapshots; families one at a time with frozen ceilings + cooldown + required-failure stop; durable persistence success-only. `durable-dashboards.js` — Daily + Brand View fold ONE OLI/catalog evidence set; Daily reads the CAMPAIGN Ads grain, Brand View the ASIN grain; the wrong grain THROWS; Ads gaps degrade, never block sales. |
| `0b24a39` | 5 | **Data Sync Center source cards** (`source-status.js`, `api/admin/sources.js`, rewritten `DataSyncCenter.jsx`): one card per family with the exact reviewed field set + Pause/Resume + per-card "Sync missing data" (`source-bucket-sync-runtime.js`, zero-I/O composition, `onlySourceKey` scoping, paused sources unforceable); READ-ONLY readiness summary (blocking vs degrading per Ads grain); report-level schedule toggles retained in a legacy section. |
| `5a37451` | 6 | **Inert schedule** (`source-schedule.js`): Non-US 07:30 IST / 02:00 UTC, US 16:00 IST / 10:30 UTC; marketplace-local latest COMPLETED day (conservative standard-time offsets; bucket = minimum); typed decision chain (schedule-disabled DEFAULT / not-due / overlap / already-ran-today=COMPLETION / completion-anchored cooldown / launch). No cron, no timer, no transport import; 5s poll policy pinned unchanged. |
| `2227f16` | 7 | **Zero-export rehearsal** (`zero-export-rehearsal.test.js`): the full priority workflow with reuseOnly + a THROWING tripwire, proving all 18 reviewed requirements (see the commit message / suite header for the enumerated list). |

### AK.3 Invariants preserved (NOT weakened)
Golden request hashes byte-identical (the durable catalog is a NEW versioned request; the OLI slice/FBA
requests reuse the existing canonical specs exactly — hash equality proven by test). One-create-per-hash,
export-id resume, cache-adoption CAS, owner-identity isolation, marketplace evidence, LKG preservation,
Scheduler v1, live snapshots, HANDOFF.md/.worktrees untouched. sourceTranche=null paths byte-identical
(entire pre-existing suite green under the engine edits).

### AK.4 Residual items for Codex senior review
1. **Unapplied migration**: `20260820_source_durable_model.sql` needs its reviewed single-file Gate before any durable write path can function (until then the endpoint reads typed schema-missing and POST fails closed).
2. **DataDoe contract question (open from AJ.7)**: no endpoint is known that returns an export's full original request parameters, so manual/UI-export adoption stays UNSUPPORTED.
3. **Brand View country/name dimension**: the durable model records the mission's canonical account/date/SKU/ASIN/currency grain; per-country display derives from the account directory (an account is one marketplace). If a seller id ever spans marketplaces inside one account, a reviewed grain extension (new versioned request) would be needed.
4. **US/CA timezone floor**: the schedule pins US/CA to Pacific standard time (conservative). Confirm against DataDoe's per-seller local fetch clocks before enablement.
5. **Org token balance is 0** (BLOCKED_NO_TOKENS): nothing here spends tokens, but any live confirmation after review requires the balance fixed at app.datadoe.com/organization.

**STOP for Codex senior review.** 7 local commits + this docs commit; NOT pushed; production stays on `02c2ef5`; no migration applied; nothing scheduled, published, or resumed.

## Appendix AL — Production-path hardening for the source workflow (OFFLINE, 2026-08-20; code+tests `545735b`; docs `<this commit>`; NOT deployed)

Codex senior review of Appendix AK raised ten production-path blockers; all fixed offline on main (no
production/DataDoe/Supabase call; migration NOT applied; nothing pushed/deployed/enabled/scheduled).
`npm run verify` green — **54 steps / 34 suites** (incl. `build:check`); `git diff --check` clean.

| # | Finding | Fix (proof: `source-production-hardening.test.js` F-groups) |
|---|---|---|
| 1 | Non-ok evidence reads proceeded (schema-missing read as "nothing paused"/"no coverage" => full-backfill spend) | Every controls/coverage/snapshot/membership read must be `read:"ok"` BEFORE any create/write/cycle; schema-missing => typed `DURABLE_MODEL_UNAVAILABLE` 503 ZERO-export; failures => `SOURCE_EVIDENCE_READ_FAILED` / `BATCH_MEMBERSHIP_READ_FAILED` (F1a-c: zero openCycle + zero creates per class) |
| 2 | dd-secondary/prefixed ids could enter with rawSellerId=accountId through the primary key | `bindPrimaryBucketAccounts`: only clean primary ids with a marketplace country; prefixed/country-less EXCLUDED typed+recorded (F2a-b through the REAL merge/classify path with a configured secondary) |
| 3 | Infinity deadline under the 60s route; unbounded work per invocation | `deadlineMs = clock()+budgetMs` (50s default) + reserve headroom threaded into the family loop AND every `runSourceJobs` pass; expiry => typed-RESUMABLE rollup (`deadlineReached`+`continuationRequired`, never a failure); continuation completes the same cycle, <=1 create/hash (F3a) |
| 4 | Card actions only knew 3 families; no fixpoint composition; no Ads evidence; no dashboard snapshots | `runSourceCardAction` routes: durable families => bucket sync; cycle-cache => REAL fixpoint composition (`buildSchedulerV2SourceTrancheRuntime`, consumer-report scope, finite deadline); durable-ads => typed `SOURCE_ACTION_ADS_ARCHITECTURE` refusal. Post-complete-run: durable Ads evidence loaded, Daily (per account) + Brand View (per bucket) durable SHADOW snapshots derived+validated+saved (`deriveDurableDashboardSnapshots`, scheduler-v2/* only; non-ready => typed skip) (F4a-d) |
| 5 | merge-duplicates upsert let removed/changed grains survive; data+coverage were two writes | NEW `replace_oli_history_window` RPC (migration 20260820, PREPARED-UNAPPLIED): validate fail-closed -> DELETE window rows -> INSERT corrected -> UPSERT succeeded-coverage — ONE transaction; wrapper `replaceOliHistoryWindow`; per-(account, slice) persistence exclusively through it; failure leaves data AND coverage untouched (F5a-b) |
| 6 | Snapshot pointers referenced the prunable 24h cache objects | Payloads COPIED to `source-snapshots/v1/*` (`saveSourceSnapshotPayload`/`getSourceSnapshotPayload`) — a namespace `prune_source_export_cache` never touches; hydration after a full cache prune proven (F6a) |
| 7 | Durable batch membership never loaded/assigned in production | Runtime loads `source_batch_membership` (`oliBatchFamily`) and transactionally assigns ONLY new accounts via the RPC wrapper; stable across invocations; malformed acks fail closed (F7a-b) |
| 8 | Readiness derived from last_status cards | `gatherDurableReadiness`: per-account durable coverage + snapshot freshness + PER-ACCOUNT Ads windows (`windowsByAccountId`; gaps carry accountId); read failures merge as typed blockers; served by GET (typed unavailable on gather failure); card summary demoted to a labeled hint (F8a) |
| 9 | No explicit ACL SQL; no audit mutations for 20260820 | Exact least-privilege ACLs (history: REVOKE ALL + GRANT SELECT — RPC-only writes; other four: SELECT,INSERT,UPDATE; RPC EXECUTE service_role only) + schema-contract registration + NEW `replace-oli` structural body proof; mutations (dropped REVOKE / widened GRANT / dropped RPC / gutted body) each raise typed blockers; real SQL audits clean (F9a-c) |
| 10 | FBA resolved "organization"-scoped; returned rows never validated | Honest seller+marketplace scoping with the account country as the planned constraint; `validateFbaSnapshotRows` validates EVERY row's marketplace pre-snapshot (cross-marketplace / marketplace-less reject typed; latest-good preserved) (F10a) |

Guardrails preserved: golden request hashes byte-identical; one-create-per-hash; cache-adoption CAS;
owner isolation; LKG; Scheduler v1; reuseOnly + tripwire; schedule defaults OFF; no cron. The three
reconciled suites (bucket-sync 16, source-status 9, zero-export rehearsal 12) still prove their full
matrices against the hardened interfaces.

**STOP for Codex re-review.** Code+tests `545735b`, docs `<this commit>`; NOT pushed; production stays on
`02c2ef5`; migration 20260820 remains PREPARED-UNAPPLIED; nothing deployed, scheduled, or published.

## Appendix AM — Round-3 senior-review corrections (OFFLINE, 2026-08-20; code+tests `545735b`-successor `64a0cc3`; docs `<this commit>`; NOT deployed)

Codex round-3 review raised nine findings on Appendix AL; all fixed offline. `npm run verify` green — **55
steps / 35 suites** (incl. `build:check`); `git diff --check` clean; migration blob `26e63bc...` (still
PREPARED-UNAPPLIED).

| # | Fix (proofs: `source-production-hardening.test.js` R1-R9 + `durable-live-parity.test.js` P1-P3) |
|---|---|
| 1 | Card actions read controls FIRST for every storage class (paused => typed `SOURCE_PAUSED` 409 before ANY discovery/I-O); cycle-cache cards execute ONLY their own family via the trusted composition FIXED to `[sourceKey]` (no widening), honoring `reuseOnly` (tripwire in rehearsal) (R1, F4b) |
| 2 | ONE end-to-end deadline: `ensureTime` before every costly step (discovery, each evidence read, membership, sync, hydration, history/ads loads, derivation, each save); fixpoint checks before family launches/continuations/cooldowns; expiry is ALWAYS typed resumable (`deadlineReached`+`continuationRequired`+phase), never a failure or deadline-caused `FAMILY_CONTINUATIONS_EXHAUSTED` (R2, R3) |
| 3 | Durable Daily/Brand View outputs produced BY the existing contracts: the REAL `daily-reporting` adapter (v2d-3) with ACTUAL campaign ad metrics via the REAL ads-coverage contract (account currency threaded), and the REAL `brand-sales` adapter (v2d-2 — the exact payload live Brand View aggregates, incl. `asinBrand`); orphan custom keys deleted; parity vs an independent pure-twin + executable consumption by the REAL live aggregators + `SCHEDULER_LIVE_SNAPSHOT_CONTRACTS` params (P1-P3) |
| 4 | A succeeded job with missing/unreadable/malformed cached rows => typed `SOURCE_PAYLOAD_UNAVAILABLE` stop at every persistence site; never drained/successful; persistence never silently skipped; LKG intact (R4) |
| 5 | `source_snapshots` identity now (org, connection, source, scope) + `payload_sha`; IMMUTABLE CONTENT-ADDRESSED objects (`source-snapshots/v2/<org>/<conn>/.../<sha>.json`); pointer refuses a non-matching path; hydrator re-derives the hash — metadata and payload provably one save; concurrent/cross-org saves isolated (R5) |
| 6 | Every loaded `source_batch_membership` row validated (canonical primary account, connection, org fingerprint, integer index, uniqueness, <=5) => typed `BATCH_MEMBERSHIP_CORRUPT`, zero exports (R6) |
| 7 | Readiness evidence validates freshness policy (`snapshot-stale`), isolated identity, hydration (`snapshot-dangling`), row-count integrity (`snapshot-integrity`), content provenance — all typed blockers (R7) |
| 8 | POST runs the evidence preflight BEFORE its first write INCLUDING the audit row; PATCH requires an actual boolean `paused` (400, zero writes — no silent resume) (R8) |
| 9 | Exact public-scoped POLICY auditing (`POLICY_MISSING`/`POLICY_MISMATCH`/`POLICY_UNEXPECTED`; full FOR/TO/USING shape; no-policy tables enforced); ACLs reconciled EXPLICITLY with policy intent (admin-read tables: policy + authenticated SELECT grant together; history/snapshots: neither) (R9) |

**STOP for Codex re-review.** Code+tests `64a0cc3`, docs `<this commit>`; NOT pushed; production stays on
`02c2ef5`; migration 20260820 PREPARED-UNAPPLIED; nothing deployed, scheduled, or published.

## Appendix AN — Round-4 senior-review corrections (OFFLINE, 2026-08-20; code+tests `0c0ed70`; docs `<this commit>`; NOT deployed)

Codex round-4 raised nine findings on Appendix AM; all fixed offline. `npm run verify` green — **55 steps /
35 suites** (incl. `build:check`); `git diff --check` clean; migration 20260820 blob `d51a0c3f...`
(PREPARED-UNAPPLIED).

| # | Fix (proofs: hardening S1-S7 + strengthened R7/F10a; parity P3-P5) |
|---|---|
| 1 | Ads read state PRESERVED: typed `{rows, metricsRead}` per account (a thrown/limited/non-array read is `read-failed`/`limit-exceeded`, never `[]`+ok); metricsRead threads into `buildDailyAdsCoverage` so Daily's availability fails typed — no false zero Ads (S1, P5) |
| 2 | EXACT TERMINAL policy auditing: final-policy-set enumeration per declared table (creates minus later drops); create-then-drop => `POLICY_DROPPED`; undeclared final policy => `POLICY_UNEXPECTED`; NEW `authenticatedAcl` audit — exact authenticated verb set (`AUTH_GRANT_MISSING`/`AUTH_GRANT_FORBIDDEN`, anon/public grants forbidden) (S6) |
| 3 | GENUINE publication lineage: every durable shadow save records a REAL `sync_report_jobs` row (upsert → claim → validated success with the EXACT saver-computed `snapshot_params_hash`, production report key). Parity calls `contract.liveParams` and drives the REAL `publishSchedulerV2Snapshot` to `disposition:"published"` over the durable lineage; Brand View's ACTUAL inventory path (`buildBrandInventoryPayload`) consumes durable FBA rows (S2, P3, P4) |
| 4 | COMPLETE preflight BEFORE the audit write: controls+paused, discovery, per-account coverage, catalog+FBA snapshots, validated membership, `report_sync_settings`, durable rollout — every later read failure is a typed refusal with ZERO writes (S3) |
| 5 | UNIFORM `SOURCE_PAYLOAD_UNAVAILABLE`: unreadable loaders caught; missing/malformed/domain-invalid (unbuildable catalog brand maps; marketplace-invalid FBA rows) all STOP the bucket typed with a detail code, non-drained, LKG intact (S4; F10a strengthened to assert the stop) |
| 6 | Deadline through EVERY persistence operation (per-account replace loop, FBA loop); mid-persistence expiry typed resumable; `deadlineReached` preserved with zero opened jobs (R2) |
| 7 | STALE required catalog/FBA evidence BLOCKS readiness (`ready:false` asserted) AND its rows are DROPPED — never derivable (R7 strengthened) |
| 8 | ATOMIC newer-or-equal-identical pointer CAS: new `record_source_snapshot` RPC (older ⇒ `stale-save` no-write; equal-identical ⇒ `unchanged`; equal-conflicting ⇒ `conflict` fail-closed; newer ⇒ replace); `source_snapshots` ACL tightened to SELECT-only; `snapshot-cas` structural proof + mutation regressions (S5) |
| 9 | NONCANONICAL membership ids REJECTED (never trimmed) + DB constraint `source_batch_membership_account_canonical` in 20260820 (frozen 20260817 untouched) + `requiredStatements` audit (`STATEMENT_MISSING` on removal) (S7) |

**STOP for Codex re-review.** Code+tests `0c0ed70`, docs `<this commit>`; NOT pushed; production stays on
`02c2ef5`; migration 20260820 PREPARED-UNAPPLIED; nothing deployed, scheduled, or published.

## Appendix AP — Round-6 corrections: all six Codex round-5 findings (OFFLINE, 2026-08-20; code+tests `e6165a6`; docs `<this commit>`; NOT deployed)

(Round-5's Appendix AO record lives in PROJECT_MEMORY.md; round 6 fixes the six findings Codex raised on it.)
`npm run verify` green — **55 steps / 35 suites** (incl. `build:check`); `git diff --check` clean; migration
20260820 byte-UNCHANGED this round (blob `2053597b...`, PREPARED-UNAPPLIED); migrations 1-6 frozen.

| # | Fix (proofs: hardening U1-U6 + reworked T1/T2/T5; gate7 F1 updated to 14 contracts) |
|---|---|
| 1 | SHARED-CYCLE FINALIZATION: the source-first runtime NEVER finalizes the shared `(bucket, cycle_date)` cycle (Migration 5's `reject_append_to_terminal_cycle` blocks all later child work on a terminal cycle); `run()` reports the cycle status from an honest READ; finalization belongs to the canonical SCHEDULED dispatcher's complete-scope close / an explicit reviewed operation. Harness store models the Migration-5 guard faithfully. U1: source runs/cards never terminalize; later report runs append+complete; same-day replay passes; dispatcher close atomic+idempotent, guard then rejects; no fabricated status/trigger bypass (T1/T2 reworked; the raced claim keeps finalize at `open-work`) |
| 2 | STALE SNAPSHOT CAS: `makePersistSnapshot` acts on the acknowledgement — `replaced`/`unchanged` (content proven identical via the content-addressed sha) fold the candidate; `stale-save` re-reads + hash-provingly hydrates the WINNER and folds it ONLY; unreadable winner ⇒ typed `SOURCE_SNAPSHOT_STALE_WINNER_UNREADABLE` stop (LKG intact); missing ack ⇒ `SOURCE_SNAPSHOT_ACK_INVALID`. U2: a CAS-losing candidate never reaches any report payload |
| 3 | BRAND-INVENTORY LIVE PATH: reviewed gated promotion — `SOURCE_PROMOTED_REPORT_KEYS` (disjoint from `CONTROLLED_REPORT_KEYS`; v1 + dispatcher untouched, structurally undispatchable), publisher code readiness = `SCHEDULER_V2_PUBLISHABLE_REPORT_KEYS` (13 + promoted), exact live contract `brand-inventory`/`brand-inventory-shared-v1`/`{to}`, `REPORT_DERIVATIONS` derive:null entry for lineage/hash provenance; gates 2-4 (durable enable + rollout + audited approval) still gate every publish; nothing publishes automatically. U3: REAL `buildSchedulerV2Publisher` under the PRODUCTION default readiness → `published`; the REAL `buildAccountBrandSlice` reads the PROMOTED row by its PLAIN live key (no remapping) |
| 4 | REAL ROUTE DEADLINE: AbortSignal threads through the REAL Supabase REST `request()` + Storage helpers + every wrapper this route uses; `makeRouteDeadline` has three TYPED outcomes (`beforeRequest` = proven zero effect; in-flight WRITE = `commitUnknown`, never claimed uncommitted; returned = confirmed committed); all runtime writes bounded in-flight; ghost-write guards (abandoned chains cannot run their next step or fold evidence after abort); the endpoint's audit write + response-status reads share the SAME route budget. U4 + T5: signal reaches `globalThis.fetch`; zero writes before-request; commit-unknown surfaced; no ghost write/mutation after return; total elapsed under budget |
| 5 | ACCOUNT-EXACT LINEAGE: `depends_on` built from the AUTHORITATIVE `sync_source_job_owners` of the cycle (new `getSyncSourceJobOwnersForCycle` + `store.listCycleOwners`): own batch's OLI export + own FBA export + shared `__organization` catalog scope only; missing ownership fails closed (`LINEAGE_OWNERSHIP_UNAVAILABLE`). U5: 30 accounts / 6 batches — exact per-account sets, zero cross-batch leakage, strictly per-account FBA |
| 6 | POSTGRESQL 17 ACL AUDIT: the modeled `ALL` now includes `MAINTAIN`. U6: GRANT ALL + revoke-the-legacy-seven leaves MAINTAIN (typed mismatch); explicit MAINTAIN forbidden for every role unless expected; REVOKE ALL clears it; the real Migration 20260820 (REVOKE ALL + explicit grants) still audits clean — migration byte-unchanged |

**STOP for Codex re-review.** Code+tests `e6165a6`, docs `<this commit>`; NOT pushed; production stays on
`02c2ef5`; migration 20260820 PREPARED-UNAPPLIED (blob `2053597b...`); nothing deployed, scheduled, or published.

## Appendix AQ — Round-6 RELEASE blockers (two): deadline end-to-end + brand-inventory durable enable (OFFLINE, 2026-08-20; code+tests `f6fd11c`; docs `<this commit>`; NOT deployed)

Codex's round-6 review approved the six fixes (Appendix AP) but flagged two RELEASE blockers; both fixed
offline. `npm run verify` green — **55 steps / 35 suites** (incl. `build:check`); `git diff --check` clean;
migration 20260820 byte-UNCHANGED (`2053597b`); NEW migration 20260821 PREPARED-UNAPPLIED
(`b3c0bc86`, sha256 `381a41ff607a7566b6fbeacb9598d629fe5d8defd4cec0bc8d0123ececbc4b3a`); migrations 1-6 frozen.

| # | Blocker → fix (proofs: hardening V1-V6 + U7; reworked U3) |
|---|---|
| 1 | **The one route deadline is now genuinely end-to-end.** Every production Supabase/Storage read+write the source-first route invokes carries the route AbortSignal to the REAL `fetch`: ~21 source-store wrappers + the cache storage/metadata adapters + `saveReportSnapshot` accept & forward an optional `{ signal }` (no signal ⇒ byte-identical; fixed `updateSyncCycleCounts`, which accepted but discarded it); `makeSupabaseSourceStore({ deadline })` binds EVERY method through `deadline.bound` (checked-before-request, remaining-budget race, signal→fetch, typed `ROUTE_DEADLINE_EXCEEDED` + commitUnknown for a timed-out write); `runBucketSourceSync`/`runSourceJobs` need no signature change (their `store.*` calls are bound via the store closure); the runtime builds its store with the deadline and the shadow-save closures forward the bound signal into `makeShadowSnapshotSaver`→`saveReportSnapshot`. V1-V6 drive the REAL store + real shadow saver with MOCKED global fetch: signal reaches fetch for every op; hung open/source-job/owner/budget/report_snapshots writes abort within budget (commitUnknown); before-request expiry = zero fetches; confirmed completion stays confirmed; one-attempt guard unchanged; no ghost `source_export_cache` pointer write after abort |
| 2 | **brand-inventory gets a REAL fail-closed durable enable path.** New additive `20260821_source_promoted_publish_controls.sql` (PREPARED-UNAPPLIED) adds `source_promoted_publish_settings(report_key, publish_enabled)` seeded `brand-inventory=false` (default OFF) with admin-read RLS + least-privilege ACL (REVOKE ALL strips PG17 MAINTAIN; grant select,insert,update), registered + audited in schema-contract.js. New wrappers `getSourcePromotedPublishSettings` (fail-closed `[]` on schema-missing/read error) / `setSourcePromotedPublishControl`. Publisher gate 2 consults this SEPARATE control for source-promoted keys (report_sync_settings for the 13 dispatch keys) — independent, both default OFF. The admin sync surface gains a reviewed enable/revoke path that writes ONLY the promoted control and REFUSES (409) to dispatch a promoted key; brand-inventory stays out of CONTROLLED_REPORT_KEYS (structurally undispatchable). U3 no longer fabricates a report_sync_settings row (real promoted control: default-off ⇒ report-disabled, enabled ⇒ published); U7 proves the fail-closed wrappers, the admin routing/refusal, and the migration ACL/policy audit |

**STOP for Codex re-review.** Code+tests `f6fd11c`, docs `<this commit>`; NOT pushed; production stays on
`02c2ef5`; migration 20260820 byte-unchanged + 20260821 both PREPARED-UNAPPLIED; nothing deployed,
scheduled, or published.

## Appendix AR — Round-7: durable report-derive recovery + strict promoted-control ack (OFFLINE, 2026-08-21; code+tests `66b38bc`; docs `<this commit>`; NOT deployed)

Codex's final review raised two findings; both fixed offline. `npm run verify` green — **55 steps / 35
suites** (incl. `build:check`); `git diff --check` clean; migrations 1-6, 20260820, 20260821 byte-UNCHANGED;
NEW migration 20260822 PREPARED-UNAPPLIED (`aa4f6e82`, sha256
`3f63fa43ed36cfb347a43ec6b7dfbbb63298e5dd5cbe08a6e7087a70ba28cf77`).

| # | Finding -> fix (proofs: hardening X1-X11; T2/S2 reworked; U7 extended) |
|---|---|
| 1 | **Durable, concurrency-safe recovery after report-lineage commit-unknown.** A commitUnknown mid-derive used to leave `sync_report_jobs` 'running' forever (the one-time claim could never re-acquire; finalize returned open-work permanently). NEW additive `20260822_report_derive_lease.sql` adds lease columns to the (20260807-frozen) table + two guarded RPCs: `claim_report_derive_lease` (pending->running with a fresh token+expiry = 'claimed'; an UNEXPIRED lease is NEVER stolen = 'held'; a stale/expired running lease is re-claimed = 'reclaimed'; an already-validated job is 'already-complete'; failed/skipped terminal-for-cycle; updated_at is never an ownership token) and `reconcile_report_derive_success` (running->succeeded requiring BOTH the CURRENT lease token AND the EXACT durable shadow snapshot — report_snapshots for scheduler-v2/<report_key>+account+params_hash — so wrong-account/wrong-hash/malformed never authorizes success). The runtime's saveWithLineage becomes upsert -> claimLease -> (already-complete: observe; held/terminal: skip) -> for claimed/reclaimed: adopt the exact durable snapshot if present (a shadow-save commit-unknown left it) else save once -> reconcile; `deriveResumable` PRESERVES the deadline error's commitUnknown onto the rollup. Recovery is pure re-derive+save+reconcile off durable evidence — ZERO new DataDoe, no duplicate save, no fabricated success, a live worker never stolen. X1-X10 cover every mandated scenario; the two RPCs are wrapper-validated (strict jsonb disposition) + structurally proven in schema-contract |
| 2 | **Strict promoted-control command acknowledgement.** `setSourcePromotedPublishControl` requires a strict boolean and validates a SINGLE returned row (exact canonical report_key, publish_enabled EXACTLY the requested boolean, valid updated_at); null/empty/multi-row/wrong-key/wrong-state/no-updated_at throw a typed safe error. The admin PATCH requires `typeof body.publishEnabled === "boolean"` and returns 400 BEFORE any write, recording the audit event ONLY after the validated durable acknowledgement. U7 extended + X11 prove malformed input performs zero control/audit writes, a malformed ack never returns 200, and promoted reports stay non-dispatchable |

**STOP for Codex re-review.** Code+tests `66b38bc`, docs `<this commit>`; NOT pushed; production stays on
`02c2ef5`; migrations 20260820/20260821/20260822 all PREPARED-UNAPPLIED; nothing deployed, scheduled, or published.

## Appendix AS — Round-8: harden the report-derive lease/recovery (5 findings) (OFFLINE, 2026-08-21; code+tests `f1b79af`; docs `<this commit>`; NOT deployed)

Codex's review of the round-7 lease work raised five findings; all fixed offline. `npm run verify` green --
**55 steps / 35 suites** (incl. `build:check`); `git diff --check` clean; migrations 1-6, 20260820, 20260821
byte-UNCHANGED. Migration **20260822 CHANGES** this round; new frozen SHA-256
`4e1eda2a145143333db5da4390a9830cc56082d8d1090148adccba1e9295f900` (blob `0cd0f526`), still PREPARED-UNAPPLIED.

| # | Finding -> fix (proofs: hardening X12, Y1-Y7, Z1-Z5, ZM1) |
|---|---|
| 1 | **Database-authoritative lease time.** `claim_report_derive_lease` drops the caller `p_now` param and uses `now()` (captured once as v_now) for every lease comparison/creation, so a future/past caller clock skew can neither steal nor distort a lease. The requested lease duration is bounded to the reviewed safe range **[120s, 1800s]**. Signature, wrapper (no p_now sent), schema-contract rpc params + proof (CLAIM_LEASE_DB_TIME_MISSING / CLAIM_LEASE_CALLER_TIME / CLAIM_LEASE_UNBOUNDED) and SQL mutation tests updated. X12 |
| 2 | **Validate a recovered snapshot before adoption.** The runtime no longer adopts a durable snapshot merely because its identity row exists: it proves params provenance (stored params recompute to the hash), exact derivation version + account, hydrates a storage-backed payload through the trusted loader (dangling/unavailable fail closed), runs the exact REPORT_DERIVATIONS payload contract, and proves byte-identical content (canonical JSON) vs the freshly derived candidate -- else a TYPED conflict/integrity outcome that NEVER reconciles or sets validated=true. Y1-Y7 (mutated params, malformed payload, dangling storage, wrong version, unavailable payload, equal-hash conflicting content -> all keep the cycle at open-work; + the identical-adopt path) |
| 3 | **Honest incomplete rollups.** `derived.skipped` stays null ONLY when every report genuinely completed; any incomplete lineage item makes it a typed non-null and enumerates the items. claim-held / reconcile-lost / transient claim-failure are typed-resumable (continuationRequired=true; a later invocation recovers with ZERO DataDoe); a snapshot conflict / terminal report is a typed non-resumable incompleteness (finalize returns open-work). Z1/Z2 |
| 4 | **Total lease state machine + strict acks.** claim reclaims ONLY an EXACTLY-running expired lease (the reclaim UPDATE re-asserts `derive_status = 'running'`); succeeded+save-failed and every other incoherent combination return 'invalid-state' and never fall through; reconcile handles a non-running row explicitly (terminal / invalid-state). Both wrapper ack validators reject multi-row / non-object / unknown disposition and enforce disposition-dependent field exactness. Z3/Z4 + ZM1 |
| 5 | **Abortable snapshot recovery read.** `getReportSnapshot` accepts `{signal}` and forwards it to `request()`; the runtime's shadow-read is bounded by the route deadline. Z5 proves the signal reaches the real fetch and a hung recovery read is aborted within budget -> typed-resumable with NO later save/reconcile |

**STOP for Codex re-review.** Code+tests `f1b79af`, docs `<this commit>`; NOT pushed; production stays on
`02c2ef5`; migrations 20260820/20260821/20260822 all PREPARED-UNAPPLIED; nothing deployed, scheduled, or published.

## Appendix AT — Round-9: hash-bound completions, total resumability, storage-first, refresh CAS (4 findings) (OFFLINE, 2026-08-21; code+tests `89d9139`; docs `<this commit>`; NOT deployed)

Codex's review of the round-8 recovery work raised four findings; all fixed offline. `npm run verify` green
-- **55 steps / 35 suites** (incl. `build:check`); `git diff --check` clean; migrations 1-6, 20260820,
20260821 byte-UNCHANGED. Migration **20260822 CHANGES** this round; new frozen SHA-256
`3a0a2116e816269cc4987e8ca98bff1d1bedb38dc02a5e744e1b61f0f4432896` (blob `96bf3be3`), still PREPARED-UNAPPLIED.

| # | Finding -> fix (proofs: hardening W1-W4c, Y6-Y6d, Z2, ZM1) |
|---|---|
| 1 | **Bind every already-complete acknowledgement to the current snapshot hash.** claim RPC: 'already-complete' requires a nonblank `snapshot_params_hash` (a hash-less validated success is 'invalid-state'); the claim wrapper requires that field. The runtime requires `lease.snapshotParamsHash === the current paramsHash` (a different-hash completion is a typed 'already-complete-hash-mismatch', never this derivation's success). reconcile RPC echoes `snapshot_params_hash` for 'already-complete'; the reconcile wrapper requires an exact echo for BOTH 'reconciled' AND 'already-complete'. Schema proofs + SQL mutations updated. W1/W2 |
| 2 | **Total, accurately-resumable lineage.** Granular outcomes replace the coarse claim-failed/reconcile-failed: held + reconcile-lease-lost are resumable; not-found, invalid-lease, invalid-state, terminal, malformed acks, hash mismatch, snapshot integrity/conflict are NON-resumable. snapshot-absent is classified by whether a preceding save committed cleanly (absent-after-clean-save => integrity/non-resumable; a concurrently-vanished adopted snapshot => resumable). `continuationRequired` is set ONLY for genuinely-recoverable outcomes, so terminal/configuration failures can never create an endless continuation loop. W3/W3b |
| 3 | **Storage-first precedence (mirrors the publisher).** A nonblank `payload_storage_path` is AUTHORITATIVE and is always hydrated + validated even when an inline payload is present; inline is used ONLY when the path is blank. The recovered row's `report_key`/`account_id`/`params_hash` identity is validated exactly. The publisher's payload precedence is made storage-first to match. W4/W4b/W4c (inline+pointer mismatch -> storage wins; dangling pointer fails closed; wrong-row identity rejected) |
| 4 | **Safe same-scope refreshed evidence.** Identical valid content is adopted; a different-but-valid durable payload is no longer a permanent block -- it routes through a reviewed atomic freshness/CAS (`saveShadowSnapshotIfNewer`, the `publishLiveSnapshotIfNewer` primitive on the shadow row, now signal-aware): a STRICTLY-NEWER validated candidate atomically REPLACES older shadow evidence and completes; an OLDER (newer-live) candidate is typed-resumable and preserves LKG; an EQUAL-but-conflicting candidate preserves LKG and fails closed non-resumable; concurrent writers converge on the newest timestamp with no blind overwrite. Y6/Y6b/Y6c/Y6d |

**STOP for Codex re-review.** Code+tests `89d9139`, docs `<this commit>`; NOT pushed; production stays on
`02c2ef5`; migrations 20260820/20260821/20260822 all PREPARED-UNAPPLIED; nothing deployed, scheduled, or published.

## Appendix AU — Round-10: DB-authoritative evidence freshness + storage-first freshness CAS (2 blockers) (OFFLINE, 2026-08-21; code+tests `86b8530`; docs `<this commit>`; NOT deployed)

Codex's review of the round-9 refresh CAS raised two release blockers; both fixed offline. `npm run verify`
green -- **55 steps / 35 suites** (incl. `build:check`); `git diff --check` clean; migrations 1-6, 20260820,
20260821 byte-UNCHANGED. Migration **20260822 CHANGES** this round; new frozen SHA-256
`6e315413ba8fc0cf33216fd546b124c97dc3c497be150b949a34eb23be3bbaa0` (blob `7c987c17`), still PREPARED-UNAPPLIED.

| # | Blocker -> fix (proofs: hardening V1-V7, Y6b/Y6c, ZM2) |
|---|---|
| 1 | **Durable evidence freshness.** The source runtime no longer stamps shadow snapshots with `nowIso()` (worker completion/retry wall time). Freshness is now the OWNING CYCLE's database-created timestamp (`sync_cycles.created_at`, read once via `getSyncCycle` before the save loop): identical across retries of the same derivation, orders an older cycle strictly below a newer one even when the older worker finishes later, never advances because a retry happened later, and is never the caller/route `Date.now()`. A durable-lineage run whose cycle has no readable `created_at` fails closed (`LINEAGE_FRESHNESS_UNAVAILABLE`). The degenerate no-cycle/no-lineage path (a plain, non-CAS save with no ordering) is the only remaining wall-clock user. Comparison is chronological + database-safe: freshness compares as `timestamptz` inside the new RPC (Z == +00:00 == any offset == fractional precision), never a lexicographic RFC3339 string; the JS `publishLiveSnapshotIfNewer` classifier and the harness/test model parse to epoch instants (`instantMs`) for the same reason. V1/V2/V3 |
| 2 | **Storage-first CAS.** `publishLiveSnapshotIfNewer`/`classifyNonOlder` (and the shadow CAS wrapper) now treat a nonblank `payload_storage_path` as AUTHORITATIVE and ALWAYS hydrate + compare it at EQUAL freshness, even when an inline payload is also present -- a stale inline that matches the candidate can never stand in for authoritative storage. A storage-different, dangling, or unreadable object is a conflict/newer-live (never `already-current`, never a reconciled success). If authoritative content cannot be proven after a race, it fails closed without reconciling. V4/V5 |

New RPC **`cas_report_snapshot_if_newer`** (migration 20260822): an atomic, row-locked (`FOR UPDATE`) freshness
CAS on the `report_snapshots` natural key -- insert-if-absent (`inserted`) / guarded strictly-newer replace
(`WHERE source_refreshed_at < candidate` -> `replaced`) / strictly-older `newer-live` / EQUAL returns the durable
content (params + payload + storage pointer) for the caller's storage-first identity proof / null-freshness
`invalid-freshness`. `saveShadowSnapshotIfNewer` routes through it and performs the storage-first equal-case
proof in JS (the authoritative payload can live in object storage, unreachable from SQL). `schema-contract` adds
the `cas-report-snapshot` structural proof (lock, insert-if-absent, null guard, guarded replace, older/equal
branches, equal-returns-content) + a `timestamptz` required-statement; `ZM2` mutates each guard and proves a
typed blocker. The V-series covers all 8 mandatory regressions (older-cycle-cannot-overwrite; wall-time-advanced
retry stays non-winning; Z/+00:00/offset/fractional equal instants; inline=candidate+storage=different ->
conflict; inline=different+storage=candidate -> adopt; concurrent-writer convergence; LKG byte-identical on
every conflict; existing hash-binding/lease/deadline/publisher tests green). Hardening **99**.

**STOP for Codex re-review.** Code+tests `86b8530`, docs `<this commit>`; NOT pushed; production stays on
`02c2ef5`; migrations 20260820/20260821/20260822 all PREPARED-UNAPPLIED; nothing deployed, scheduled, or published.

## Appendix AV — Round-11: route the initially-absent shadow write through the atomic CAS (P1 blocker) (OFFLINE, 2026-08-21; code+tests `21d30d3`; docs `<this commit>`; NOT deployed)

Codex's review of the round-10 CAS raised one P1 release blocker; fixed offline. `npm run verify` green -- **55
steps / 35 suites** (incl. `build:check`); `git diff --check` clean. **No migration change** this round
(20260822 byte-unchanged, blob `7c987c17`; 20260820/20260821 byte-unchanged) -- `cas_report_snapshot_if_newer`
already existed; the fix is that the runtime now USES it on the absent branch.

**Blocker.** `source-bucket-sync-runtime.js` still handled an ABSENT shadow snapshot through
`saveShadow()`/`makeShadowSnapshotSaver()`/`saveReportSnapshot` -- a merge-duplicates upsert that never
consults `cas_report_snapshot_if_newer`. Two cycles could both read the row as absent; if the newer cycle wrote
first and the older cycle's delayed merge-upsert arrived later, the older evidence overwrote the newer row
without a freshness check.

**Fix.** Every durable-lineage shadow write -- the initially-absent branch INCLUDED -- now routes through
`saveShadowSnapshotIfNewer`/`cas_report_snapshot_if_newer` via a single `persistViaCas()` helper. The CAS owns
insert-if-absent AND freshness ordering under a row lock, so two writers that both read the row as absent
converge on the newer evidence. Every CAS outcome is handled explicitly: `inserted`/`replaced` -> reconcile;
`already-current` -> reconcile only after the wrapper's storage-first equality proof; `newer-live` -> typed
resumable, no reconcile for the losing candidate; `conflict`/invalid/malformed -> fail closed, no reconcile;
deadline/`commitUnknown` -> honest resumable. The merge-upsert saver (`saveShadow`) is now reachable ONLY on
the degenerate no-lineage path. The recovery harness injects commit-unknown at the CAS write and makes the
merge-upsert saver THROW if the durable path ever reaches it -- so every X-series recovery test now doubles as a
proof that durable lineage never merge-upserts (regression 5).

| Mandatory regression | Proof |
|---|---|
| 1 Two instances both read the natural key as absent | VV1 (injected absent read + a pre-seeded newer durable row) |
| 2/3 Newer-first, older-delayed; final payload is the newer cycle's | VV1 (older instance -> newer-live; durable byte-identical) |
| 4 Older cycle not reconciled for its losing candidate | VV1 (`validated === false`) |
| 5 Exactly the CAS handles both writes; zero merge-upserts | VV1 + X-series (the merge-upsert saver throws if the durable path uses it) |
| 6 Reverse completion order converges | VV2 |
| 7 Equal-cycle equal-content replay is idempotent | VV3 (insert -> already-current) |
| 8 Equal-freshness conflicting content fails closed, LKG preserved | VV4 |
| 9 CAS commitUnknown/deadline stays typed-resumable | VV5 (timeoutSaveAfterCommit -> resumable; recovery adopts, zero re-save) |
| 10 Existing storage-first/lease/hash/publisher/schema-audit tests green | full verify 55/35; hardening **104** |

**STOP for Codex re-review.** Code+tests `21d30d3`, docs `<this commit>`; NOT pushed; production stays on
`02c2ef5`; migrations 20260820/20260821/20260822 all PREPARED-UNAPPLIED; nothing deployed, scheduled, or published.

## Appendix AW — Release package: manifest-pinned baseline + read-only digest diagnostic (OFFLINE, 2026-08-21; code+tests `02289d8`; docs `<this commit>`; NOT deployed)

Tracked single-file migration release tooling under `scripts/release/` (applier, stage-aware checker,
manifest+engine, fs helper, read-only digest diagnostic, 79-test offline self-test). All OFFLINE-safe; no
secrets/machine-specific paths; `npm run verify` 55/35 green; `git diff --check` clean. Migrations 20260817–
20260822 remain UNAPPLIED.

Hardening: pinned identity (project ref + exact host/port/db) validated before connecting; the applier completes
ALL validation (allowlist, frozen SHA-256, identity, manifest-pinned baseline) BEFORE constructing a
`pg.Client`, with phase-tracked transactions and a distinct `COMMIT_UNKNOWN` (exit 3, never rollback/retry).
Catalog verification is semantically exact (ordered column vectors; complete canonical constraint bodies with
AND/OR preserved; PK/FK ordered columns + referenced table/columns + on-delete; exact index sets incl ordered
columns/uniqueness/access-method/predicate; permissive/USING/WITH CHECK policies; `tgfoid`-by-OID triggers;
`aclexplode` ACLs incl PG17 MAINTAIN). Control state is pinned exactly (rollout, `all_primary`, four approvals,
13 report_sync_settings) plus the `dfca8f75` cycle AND its durable child state (122 source jobs = 8/9/4/101,
`max(create_export_count)=1`, 8 report jobs all `derive_status=pending` + `save_status=pending`). Protected
digests use the runbook algorithm `md5(string_agg(md5(row::text), ',' ORDER BY natural_key))` and are
manifest-pinned for ALL eight datasets; `buildBaseline` uses manifest pins only; `validateBaseline` /
`requirePinnedStage0Digest` require the exact key set and every count/hash, rejecting missing/extra/edited/
observed-different.

**BLOCKER escalated (do not proceed):** the one authorized read-only diagnostic (`BEGIN ISOLATION LEVEL
REPEATABLE READ READ ONLY`; `ROLLBACK` in finally) shows NEITHER the old nor the runbook algorithm reproduces
the pinned Appendix-AI pairs, and the **counts themselves differ** — observed live=183 (pinned 176), shadow=48
(pinned 26). The pinned values were **NOT changed**; the six control-table digests remain `null`/fail-closed
(never pinned to arbitrary current state). This must be reconciled by Codex/the runbook owner (stale Appendix AI
vs. grown production, or a different scope/algorithm) before stage-0 baseline creation and migration application.

**STOP for Codex re-review.** Code+tests `02289d8`, docs `<this commit>`; NOT pushed; migrations UNAPPLIED;
nothing deployed/scheduled/published; the read-only digest diagnostic was the only production read.

## Appendix AX — Production-state reconciliation: VERDICT STOP, pins unchanged (OFFLINE read-only, 2026-08-21; code `806a498`; docs `<this commit>`; NOT deployed)

The narrowly-scoped read-only reconciliation runner (`scripts/release/reconciliation-runner.mjs`; `BEGIN
ISOLATION LEVEL REPEATABLE READ READ ONLY`; SELECT-only; `ROLLBACK` in finally; identity validated before
connecting; safe-metadata + typed pass/fail only; SQLSTATE-only on error) executed against production and
returned **STOP** — so the manifest pins were **NOT changed** (live/shadow keep the stale Appendix-AI values;
the six control digests remain `null`/fail-closed). No baseline was created; no migration applied.

**Findings (read-only):**
- Growth is genuine: **live 183** (Appendix AI 176, +7), **shadow 48** (26, +22); **0** duplicate natural
  identities; all 48 shadow rows use **known Scheduler-v2 report keys**. The +7 live are `manual-source-attempt`
  (5) and `brand-view-portfolio` (2); the +22 shadow are `brand-sales`/`content-changes`/`listing-optimizer`/
  `keyword-rank`/`sku-pl`/`ppc-performance` derivations.
- **42 contract-invalid rows, all `brand-sales`** (≈38 live + ≥2 shadow) under the EXACT registered contract
  (`REPORT_DERIVATIONS["brand-sales"].validatePayload`): version skew — `brand-sales/v2d-2` now requires a
  non-empty `asinBrand` map that these older snapshots predate.
- Neither the old nor the runbook digest algorithm reproduces the pinned Appendix-AI hashes — expected, because
  the underlying data grew.
- Infra note: SQLSTATE **57014** (statement timeout) on the heavy per-row/big-fetch queries over the pooler
  prevented one clean pass through lineage/invariants; this is a runner-robustness limit, not a data verdict.

**Escalation for Codex / runbook owner:** decide whether the `brand-sales` version skew is acceptable historical
state (and, if so, whether the contract should apply to pre-`v2d-2` rows) and re-issue a reconciled
count/hash for all eight datasets, OR remediate the snapshots — before stage-0 baseline creation and Migration 1.
The `57014` timeout also argues for pinning via a lighter server-side digest pass rather than per-row payload
fetch.

**STOP for Codex review.** Code `806a498`, docs `<this commit>`; pins UNCHANGED; NOT pushed; migrations
20260817–20260822 UNAPPLIED; the read-only reconciliation was the ONLY production read (zero writes).

## Appendix AY — Invariants-only read-only pass + 42P01 checker fix (OFFLINE, 2026-08-21; code `4bf2718`)

The reconciliation runner's single pass timed out (SQLSTATE 57014) on the heavy per-row payload fetch before
its invariants section completed, so a lightweight **invariants-only** read-only pass (ledger + new-6-absent +
control/dfca/children; no payload fetch, no digest string_agg) was run to capture the invariant results.

**Checker fix (committed `4bf2718`):** `columnExists`/`constraintExists` used `$1::regclass`, which throws
SQLSTATE **42P01** when the table does not exist yet — so `verifyMigrationAbsent` **crashed at stage 0** in
production the moment it checked an ALTER against a not-yet-created table (`source_batch_membership`, created by
Migration 2). Now both guard with `to_regclass` first, so an absent altered table resolves to "absent" rather
than crashing. Regression added (M4 `source_batch_membership`, M6 `sync_report_jobs`); self-tests **80**.

**Invariant results (read-only, in-snapshot):**
- `LEDGER(stage0)`: **PASS** (12 baseline recorded; the six new migrations not present).
- `OBJECTS(new-6 absent)`: **PASS** (none of the six new migrations' objects exist).
- Control invariants: **PASS** — rollout row enabled IN account, `all_primary=false`, 4 IN approvals, 13 settings
  (4 enabled / 9 disabled), `cron.job` count 0.
- dfca8f75 **child** state: **PASS** — source jobs 122 = 8 succeeded / 9 failed / 4 attempted / 101 pending,
  `max(create_export_count)=1` with zero rows > 1; 8 report jobs all pending/pending.
- dfca8f75 **cycle** counters: **1 FAIL** — the cycle-column `report_total` is **0** in production, but the pin
  is **8**. Everything else on the cycle matches (`status=running`, `source_total=122`, `source_succeeded=8`,
  `source_failed=9`, `report_succeeded=0`, `report_failed=0`, `finished_at=null`).

**Interpretation:** Appendix AB's "reports 8" is the **child report-job count** (which PASSES), not the cycle's
`report_total` counter column, which a running cycle leaves at 0 until roll-up. The pin `report_total=8` appears
to be a mis-encoding of the child count. **Pin left UNCHANGED** per the decision gate ("do not change pins to
match current state"); escalated to the runbook owner to confirm the correct cycle-column value (0) before
re-pinning. This is an additional STOP reason alongside the contract-invalid `brand-sales` rows (Appendix AX).
