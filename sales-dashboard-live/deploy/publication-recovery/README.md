# Publication recovery worker

A small independent Node.js worker, meant for the Oracle Always Free VM (Mumbai, Ubuntu 24.04,
VM.Standard.E2.1.Micro, 1 GB RAM). It finds saved source evidence that has not yet reached its live dashboard
report. It then runs the **existing** zero-export reconciler for that account and completes the job only when the
reconciler's own live read-back check passes.

> **Status: repository work only.** Migration `20260934` is **prepared, not applied**. Nothing is installed on the VM,
> and nothing is live. Every family is observe-only until the two-key activation in [Sign-off gates](#sign-off-gates)
> is completed.

## 1. Architecture audit (what exists, and what the worker reuses)

### 1.1 Source families and the live reports they feed

Nothing below is hand-maintained. `lib/server/recovery/registry.js` derives the table from:

- the four reconcilers' lineage modules (`lib/server/sync/{oli,fba,ads,listing-health-v3}-dependent-reports.js`);
- `SCHEDULER_LIVE_SNAPSHOT_CONTRACTS` in `report-publisher.js`;
- `REPORT_MATERIALIZATION` in `report-materialization-registry.js`.

`validateRecoveryRegistry()` fails closed. A new live report that nothing classifies breaks `npm run verify`.

| Worker family | Saved sources (evidence) | Existing zero-export publisher | Live reports it publishes |
|---|---|---|---|
| `oli` | order-line-items (`source_coverage`, `source_oli_completeness`) | `scripts/release/oli-publication-reconcile.mjs` | brand-sales, brand-inventory, daily-reporting |
| `ads` | campaign-ads (`ads_sync_state` `campaign-performance-v1.content_rev`) | `scripts/release/ads-publication-reconcile.mjs` (runs **only** `buildOperation("daily-reporting")`) | daily-reporting |
| `fba` | fba-inventory-health (`source_snapshots`) | `scripts/release/fba-publication-reconcile.mjs` | brand-inventory (needs live brand-sales at the same as-of) |
| `listings` | Listings and Listings Raw (`source_listings_snapshot`, `source_listings_raw_snapshot`), plus the FBA, catalog and OLI inputs it folds in | `scripts/release/listing-health-v3-reconcile.mjs` | listing-health-v3 |

All other live and registry keys are classified, not skipped silently:

| Class | Reports | Worker behaviour |
|---|---|---|
| **detect-only** (no zero-export publisher) | fba-plan (published only by the paid go-live path) | Records the saved-not-live gap as an observation. Never publishes. |
| **detect-only** (scheduler-materialized) | sku-movement, returns-leakage, brand-view, brand-view-brands, brand-view-portfolio | Records "behind upstream" when detectable. The scheduler's materializer remains the only writer. |
| **not-applicable** (read-only or self-healing serve) | brand-directory, brand-portfolio, oli-quality, oli-quality-summary | None. |
| **not-applicable** (manual-refresh, paid DataDoe) | sales, sales-movers, sku-pl, reconciliation, buy-box-loss, content-changes, keyword-rank, listing-health, listing-optimizer, ppc-performance | None. The worker never fetches source data. |

### 1.2 Existing contracts the worker relies on (unchanged)

- **Completion check.** `evaluatePublicationBinding` (the saved-data-reconciler core) returns `PUBLICATION_NOT_REQUIRED`
  only when all of these hold:
  - the latest promotable `sync_report_jobs` revision is covered by `depends_on` / `durable_content_deps`;
  - the `scheduler-v2/<key>` shadow is present;
  - the live identity matches;
  - the publisher's read-back matches (same `source_refreshed_at` and payload).

  **This is the worker's only definition of "live".** It does not use a revision counter or dependency map of its own.
- **Publication path.** Each reconciler CLI publishes through the existing fenced CAS, under the single global
  `control_plane_lease`, with owner token `<family>-reconcile:<bucket>:<runToken>`. `--cleanup` with the same token
  releases a lease the run left behind. The worker never writes `report_snapshots` or any dashboard row itself.
- **Zero-export adapters.** Each CLI has a DataDoe adapter that refuses creates, plus one account-directory GET that
  costs zero tokens. The CLIs report `dataDoeCreates` / `dataDoeTokens` themselves.
- **Not reused, on purpose:**
  - `report_publication_outbox` is OLI-enqueued, and its claim is not filtered by source or region. Its drain would
    complete other families' rows.
  - `sync_targets` / `sync_runs` belong to the legacy path.

  So the worker has its own tables (migration 20260934).
- **Unchanged:**
  - scheduler-v2 and its acquisition plan, including the 5-seller batch limit, the 50,000-row Listings request and the
    shared canonical Listings export;
  - every GitHub workflow, including the four backstop reconcile workflows;
  - the outbox and its drain;
  - the publisher;
  - the reconcilers' logic.

### 1.3 The only change to existing code

Each of the four reconciler CLIs gains an **opt-in** `--emit-targets` flag. When it is passed, the CLI prints one extra
line, `TARGETS {json}`: per account, the verdict code for each report, sanitized to `[A-Za-z0-9_.:-]`. The line comes
from `lib/server/sync/reconcile-targets-output.js`. Without the flag, output is byte-identical to before.

## 2. How the worker runs

The worker runs one loop with concurrency 1 and never busy-waits. Each iteration:

1. **Heartbeat.** Upserts `publication_recovery_workers` (redacted stats).
2. **Watermark pass** (every `PRW_POLL_SECONDS`, default 20s; metadata SQL only, no child process):
   1. Composes a cheap evidence token per account from the saved-source tables.
   2. Enqueues a job when the token differs from both the last verified token and the token the last scan observed.
      So an account the scan saw as missing evidence is not re-enqueued on every poll.
   3. Covers only the (family, region, account) scope that the last full scan recorded.
3. **Full consistency scan** (at most every `PRW_SCAN_INTERVAL_SECONDS`, default 600s).
   - **Single-flight across workers** through the `publication_recovery_scan` lease, with DB-scheduled timing. The
     lease is renewed before and after every child run. If another worker has taken it over, this worker abandons
     its scan.
   - **Evidence tokens** are read per step, before the dry-run. Evidence that lands during a run is therefore newer
     than the recorded token, and the watermark still reacts to it.
   - **Stepped:** one family × region dry-run per iteration, so pending jobs still run between steps.
   - **Coverage:** detects gaps that no watermark can see, such as a live report overwritten or lost after publication.
   - **Recording:** writes the baseline and per-report observations.
4. **At most one claimed batch.** The batch is a coherent (family, region, as-of) set of up to `PRW_BATCH` accounts,
   claimed atomically with `FOR UPDATE SKIP LOCKED`. The claim is a bounded lease that is renewed while work runs.
   1. **Gates.** None of these consume an attempt:
      - an as-of older than D-1 → `superseded`;
      - family not live → deferred 600s;
      - a scheduler-v2 cycle for the region in flight → deferred 300s;
      - the global control lease held → deferred 120s;
      - an awaited family (FBA and Ads await OLI) still open for the account → deferred 180s.
   2. **Pre-check dry-run** with the exact binding. An account that is already current is **verified without
      publishing**. This is what makes a crash after publish safe: the job is not published twice.
   3. **Live run** of the existing reconciler, for only the accounts still stale:
      - with a unique run token;
      - never in immediate mode;
      - never as a full-region live pass.

      An abnormal exit (timeout, kill, or unresolved control) is followed by `--cleanup` with the same token.
   4. **Zero-export tripwire**, checked on **every** child (scan, pre-check, live, cleanup, verify). If a child reports
      a DataDoe create or token, its jobs are dead-lettered and the family is switched off for the rest of the process.
   5. **Verify dry-run.** Only `PUBLICATION_NOT_REQUIRED` verifies a job.
   6. **Every finish carries the job's claim-time evidence token.** If an enqueue refreshed the evidence while the job
      ran, a verified, retry, deferred or dead verdict is about old evidence. The job is **re-armed** instead, with
      attempts and claims reset, so evidence the reconciler never evaluated is never dead-lettered.
   7. **Exceptions.** An exception mid-batch counts as one attempt (transport retry with backoff). It never becomes an
      instant hand-back that loops at the head of the queue.

**Shutdown** (SIGTERM from `systemctl stop`, a reboot, or `rollback.sh`):

- The worker stops claiming and starting children.
- A running **dry-run** child is terminated after `PRW_STOP_GRACE_SECONDS`, and its jobs are handed back without
  using an attempt.
- A **live** or **cleanup** child is never killed. The reconcilers finalize a cycle before they publish, so a kill in
  that window would strand the cycle (`cycle-not-running:succeeded`). The child ends within its own deadline (330 s,
  LHv3 720 s), bounded by the runner's hard timeout (420 s / 840 s). The unit's `TimeoutStopSec=1200` covers that.

**Timezone.** The unit pins `TZ=UTC`. The store also reads the Postgres `date` column as exact text, so an as-of can
never shift a day on a host east of UTC.

### 2.1 Outcome classes (`lib/server/recovery/classify.js`)

| Class | Meaning | Job outcome |
|---|---|---|
| current | binding proves live is current | verified |
| stale | saved evidence not live yet | publish attempt |
| missing-evidence | the saved source is absent or incomplete; the worker will **not** fetch it | deferred 1800s, reported |
| dependency-deferral | the reconciler deferred on provenance, or an upstream family is not live yet | deferred 900s |
| contention | the global lease is held, or a reconciler reported a lease conflict | deferred 120s |
| not-attempted | the reconciler kept its remaining deadline for cleanup (`deadline-cleanup-reserved`) | deferred 120s |
| timeout / transport | child timeout, spawn failure, DB or network, exception mid-batch | retry with exponential backoff (60s → max 3600s) |
| run-failed | the whole reconciler run failed before any per-account result (`outcome: failed` plus a typed code) | retry with backoff; the scan step counts as an error (partial) |
| readback-mismatch | publish reported success but the binding is still stale | retry with backoff |
| superseded-newer-live | `publish-newer-live` / `shadow-newer-live`: the live row is strictly newer than anything this evidence can publish | dead for this evidence (benign; a new token opens a new job) |
| terminal-cycle-stuck | `cycle-not-running:*`: the revision's cycle is already terminal | dead for this evidence |
| permanent-integrity, zero-export-violation | will not be fixed by retrying | dead-letter |

Bounded everywhere, so there is no infinite loop:

- `PRW_MAX_ATTEMPTS` (6) caps executed failures.
- `PRW_MAX_CLAIMS` (8) dead-letters a crash-loop. The counter counts **consecutive** claims that never reached a
  finish, and every normal finish resets it. Routine deferrals therefore never accumulate toward it.
- A dead job with the same evidence is not re-enqueued. New evidence starts a new job.
- Deferrals (missing evidence, dependency, contention, scheduler window) do not use up attempts. They are still
  bounded, because the next D-1 rollover supersedes the job. A deferred job is **never** marked complete while its
  saved evidence still awaits publication.

### 2.2 Safety properties and the tests that pin them

| Property | Test |
|---|---|
| Normal save: watermark → claim → pre-check → live → verify | worker 1a–1d |
| Missed GitHub trigger: the full scan finds a gap with no watermark change | worker 2a–2c |
| Timeout / retry with backoff, `--cleanup` with the same token | worker 3a–3c |
| Crash, then lease reclaim by another worker; a stale token cannot finish | worker 4a–4c, SQL self-test |
| Crash after publish: pre-check verifies, no second publish | worker 5 |
| Two workers: disjoint claims, each job verified once, single-flight scan | worker 6a–6c, SQL self-test (SKIP LOCKED) |
| Dependency ordering (FBA/Ads wait for OLI) | worker 7a–7c |
| Missing evidence reported and deferred, never fetched | worker 8 |
| Read-back mismatch is never verified; bounded dead-letter | worker 9, units D3 |
| Newer live / as-of rollover / lease held / scheduler window / observe-only / evidence advancing mid-run | worker 10–12d |
| Zero-export tripwire (any reported create or token trips the family) | worker 12c, units D7 |
| New report registration fails closed until classified | units A6–A8 |
| Every source handler (oli, ads, fba, listings): argv, dry-run and cleanup shape, no immediate or outbox mode, the TARGETS hook is present | units B1–B4 per family, B9 (Ads daily-only), B10 (deadlines), F1–F5 |
| Structural zero-export: allow-listed scripts only, no DataDoe export or lease or CAS code in worker modules, import closure is `pg` only | units C1–C3, H1 |
| Migration: expand-only, SECURITY DEFINER, RLS and grants, control disabled by default, rollback outside the ledger | units G1–G6 |
| SIGTERM mid-batch releases jobs; a crash-loop is dead-lettered | worker 13a / 13b |
| Adversarial-review regressions: consecutive-claim crash-loop guard, re-arm of untried evidence, run-level failure, not-attempted, exception retry, dry-run zero-export trip, watermark observed-token, live child never killed on stop, scan lease takeover | worker 14a–14i, units I1–I10 |
| Real SQL semantics (enqueue, claim, reclaim, finish, re-arm, crash-loop, baseline observed token, status, grants) | `publication-recovery-sql-selftest.mjs` (PGlite, 33 assertions) |

**Honest limit:** PGlite is a single connection. The SQL self-test proves the semantics, but it cannot contend two
sessions on `FOR UPDATE SKIP LOCKED` or the advisory lock. Concurrency safety rests on those standard Postgres
primitives, the in-memory two-worker scenarios, and review. It has not been exercised against a real multi-session
Postgres.

## 3. Resource fit (1 GB Micro)

Both checks are repeatable. Commands and measured results are below.

```bash
# The worker loop alone: an in-memory store plus a fake reconciler world. Re-runs itself under the unit's
# --max-old-space-size=160 with --expose-gc and judges the retained heap after GC.
node scripts/worker/publication-recovery-memcheck.mjs [--iterations=40000]

# The real workload: runs the existing reconciler CLIs in DRY-RUN (zero writes, zero DataDoe creates and tokens),
# exactly as one full scan does, and samples each child's peak RSS. Needs the worker's env.
node scripts/worker/publication-recovery-memcheck.mjs --real [--regions=...] [--families=...]
```

**Measured on 2026-09-25, on the development machine (Windows x64, Node 24.14.1), NOT on the VM:**

Synthetic run, 40,000 ticks (about 9.3 simulated days, 930 full scans, 167k verified jobs), under
`--max-old-space-size=160`:

| Measure | Result |
|---|---|
| Retained heap after GC | 7.5 MB at start, 9.6 MB at end |
| Steady-state drift | 0.2 MB |
| RSS peak | 190 MB (tight loop with no idle time) |
| Verdict | **PASS** |

Real run, as-of 2026-09-23, all 12 family × region dry-runs, 51 accounts (india 8, europe-au 32, us-ca 11). It
exercises the existing reconciler CLIs, which the review fixes did not change:

| Region | oli | ads | fba | listings |
|---|---|---|---|---|
| india | 49.9 s / 186 MB | 7.0 s / 73 MB | 5.9 s / 68 MB | 28.8 s / 135 MB |
| europe-au | 40.7 s / 108 MB | 16.5 s / 71 MB | 13.5 s / 72 MB | 81.3 s / 150 MB |
| us-ca | 23.7 s / 133 MB | 9.6 s / 74 MB | 6.7 s / 70 MB | 28.6 s / 112 MB |

- **One full scan took 312 s**, within the 600 s interval.
- **Memory budget:** worker ceiling 200 + largest child 186 + OS reserve 250 = **636 MB**, against 870 MB (85% of
  1 GB). **PASS.**
- **DataDoe:** every step reported **zero** creates and zero tokens.

**Caveat, a gate before activation:** the E2.1.Micro has 1/8 OCPU, far slower than the machine these numbers came
from.

- Memory should be similar. Durations may be several times longer.
- If europe-au Listings (81 s here) slows to about 8×, it approaches the reconciler's own 720 s deadline (hard
  timeout 840 s).
- Run the `--real` check **on the VM** (handoff step 4) before enabling any live family.
- If a step times out, or the budget verdict FAILs there, **do not activate**. Instead, either:
  - raise `PRW_SCAN_INTERVAL_SECONDS` and restrict `PRW_REGIONS`; or
  - move the worker to a larger shape.

## 4. Files

| Path | Purpose |
|---|---|
| `scripts/worker/publication-recovery-worker.mjs` | Entrypoint (`--check-config`, `--once`, graceful SIGTERM/SIGINT) |
| `scripts/worker/publication-recovery-health.mjs` | Health check: exit 0 healthy, 1 unhealthy, 2 config, 3 DB; redacted JSON |
| `scripts/worker/publication-recovery-status.mjs` | Redacted operational status (for a future Delivery Status details panel) |
| `scripts/worker/publication-recovery-memcheck.mjs` | Memory and throughput check (synthetic and `--real`) |
| `scripts/worker/publication-recovery-sql-selftest.mjs` | Real-SQL self-test of the migration (PGlite; exit 3 = SKIPPED, not a pass) |
| `lib/server/recovery/{registry,classify,runner,worker,store-pg,config,memory-store}.js` | Worker modules (`memory-store` is test-only) |
| `lib/server/sync/reconcile-targets-output.js` | `TARGETS` line builder and parser (the `--emit-targets` hook) |
| `supabase/migrations/20260934_publication_recovery_worker.sql` | **Prepared, not applied.** Six tables and 12 RPCs, expand-only, idempotent |
| `deploy/publication-recovery/ROLLBACK_20260934.sql` | Contract rollback (drops only the 20260934 objects) |
| `deploy/publication-recovery/publication-recovery.service` | systemd unit (no listening port; `prw` user; hardened; `MemoryMax=850M`) |
| `deploy/publication-recovery/{install,rollback}.sh` | Immutable release install, update and rollback on the VM |
| `deploy/publication-recovery/worker.env.example` | Env template (no secret values) |
| `scripts/publication-recovery-{units,worker}.test.js` | Unit and scenario suites (registered in `npm run verify`) |

## 5. Secrets

- The worker needs the same four secrets as the GitHub reconcile workflows: `POSTGRES_URL`, `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY` and `DATADOE_API_KEY`. The DataDoe key is used only for the zero-token account-directory
  GET.
- They live **only** in `/etc/publication-recovery/worker.env` on the VM:
  - owner `root:prw`, mode `0640`;
  - `install.sh` creates it empty;
  - edit it with `sudoedit` only.
- Never put a secret in Git, the unit file, a command-line argument, shell history, a log, a ticket or chat.
  `--check-config`, the health check and status print only **presence** booleans and redacted codes.
- The VM has no Git credentials. Releases arrive as a `git archive` tarball over the existing SSH.
- No public HTTP port. The worker makes outbound connections only: the Postgres pooler, Supabase REST and the DataDoe
  account GET. Do not open any ingress rule for it.
- Rotation: `sudoedit` the env file, then `sudo systemctl restart publication-recovery`.

## 6. Sign-off gates

Each gate needs explicit owner sign-off. None of them have been done.

**Gate A: apply the migration (production schema change).**

- Expand-only and idempotent. It adds six tables and 12 RPCs and touches nothing existing.
- The control row is created **disabled, with no live families**.
- Apply it from a trusted machine with the repo env, **exactly this one file**:

  ```bash
  cd sales-dashboard-live
  MIGRATE_ONLY=20260934_publication_recovery_worker.sql npm run db:migrate
  ```

  Or use the manual-only GitHub workflow. It applies exactly the named file, once the commit is on the default
  branch: `gh workflow run db-migrate.yml -f migration=20260934_publication_recovery_worker.sql`. No workflow applies
  migrations automatically, so merging this change applies nothing.

- Verify (read-only):

  ```sql
  select enabled, live_families from public.publication_recovery_control;   -- expect: false, {}
  select count(*) from pg_proc where proname like '%publication_recovery%';   -- expect: 12
  ```

- Rollback: run `deploy/publication-recovery/ROLLBACK_20260934.sql` in the SQL editor. It drops only these objects
  and removes the ledger row. Stop the worker first.

**Gate B: install on the VM, observe-only** (see the VM handoff below).

- With `PRW_LIVE_FAMILIES=` empty and the control row disabled, the worker can only:
  - write its heartbeat;
  - run scans (dry-runs);
  - record baselines and observations.
- **It cannot publish.** The status then shows what it would do.
- Soak this for at least one full day, covering all three regional cycles. Confirm with the status script:
  - heartbeat fresh;
  - scans complete;
  - `stale` counts plausible;
  - zero `zero-export-violation`.

  Then confirm, from the DataDoe `/usage-logs` ledger, that the VM caused **zero creates** (retention is about 24h).

**Gate C: canary one family (two-key).**

1. On the VM, set `PRW_LIVE_FAMILIES=oli` (optionally also `PRW_REGIONS=india`) and restart.
2. In the DB:

   ```sql
   update public.publication_recovery_control
      set enabled = true, live_families = array['oli'], updated_at = now(), updated_by = '<approver>'
    where id = true;
   ```

3. Watch at least one natural cycle.
4. Proof required:
   - jobs `verified` with `verified-live-readback`;
   - the live dashboard reports match;
   - DataDoe `/usage-logs` shows zero creates from the worker's runs.

**Gate D: widen** to `oli,fba,ads,listings` and all regions, one family at a time, with the same evidence at each step.

**DB kill switch** (no restart needed; takes effect on the next claim):

```sql
update public.publication_recovery_control set enabled = false, updated_at = now(), updated_by = '<who>' where id = true;
```

**Not resolved end to end** until an unattended VM run has proven saved-to-live convergence **and** zero DataDoe
creates.

## 7. VM handoff (for Codex; only after Gate A is signed off)

On a trusted machine (the repo checkout). The archive **must be of the repository root**: `git archive` run inside
`sales-dashboard-live/` drops the directory prefix, and `install.sh` refuses such a tarball. `.gitattributes` pins
LF line endings for `*.sh`, `*.service` and `*.example`, so an archive built on Windows is still valid on Ubuntu.

```bash
SHA=$(git rev-parse HEAD)            # the reviewed commit containing this worker
git -C "$(git rev-parse --show-toplevel)" archive --format=tar.gz -o "/tmp/prw-$SHA.tar.gz" "$SHA"
sha256sum "/tmp/prw-$SHA.tar.gz"
scp "/tmp/prw-$SHA.tar.gz" "$(git rev-parse --show-toplevel)/sales-dashboard-live/deploy/publication-recovery/install.sh" <vm>:/tmp/
```

On the VM (Ubuntu 24.04). Manual commands run through `systemd-run` as the `prw` user. It reads the env file
**exactly as the unit does**. Never `source` the env file into a shell: values such as the pooler URL contain `&`,
which bash would misparse, and `$` would be expanded.

```bash
# 0) Node 24 at /usr/bin/node is required (the unit runs /usr/bin/node; the workflows pin 24). NodeSource installs it there.
/usr/bin/node -v

# 1) Install the release. Creates the prw user, a 2G swapfile if there is no swap, an EMPTY env file, and the unit.
#    It builds a self-contained release (its own pg closure pinned to package-lock.json) and does NOT start the worker.
sha256sum /tmp/prw-<sha>.tar.gz      # must match the value printed on the trusted machine
sudo bash /tmp/install.sh /tmp/prw-<sha>.tar.gz <sha>

# 2) Fill the secrets and settings (observe-only: leave PRW_LIVE_FAMILIES empty). Template:
#    /opt/publication-recovery/app/sales-dashboard-live/deploy/publication-recovery/worker.env.example
sudoedit /etc/publication-recovery/worker.env

# Helper for this shell session: run a worker script as prw with the unit's exact environment.
prw() { sudo systemd-run --quiet --wait --pipe --collect --uid=prw --gid=prw \
  -p EnvironmentFile=/etc/publication-recovery/worker.env -p EnvironmentFile=-/etc/publication-recovery/version.env \
  -p Environment=TZ=UTC -p WorkingDirectory=/opt/publication-recovery/app/sales-dashboard-live \
  /usr/bin/node "$@"; }

# 3) Validate config, registry and DB reachability (prints presence booleans + redacted codes only).
#    Expect "db": "ok", exit 0. "error:42P01" (exit 3) means TLS and auth work but migration 20260934 is not applied
#    (Gate A). A TLS or certificate code means the connection string is wrong.
prw scripts/worker/publication-recovery-worker.mjs --check-config; echo "exit=$?"

# 4) Before enabling: measure the real workload ON THE VM (read-only dry-runs, zero DataDoe creates; ~15+ minutes).
prw scripts/worker/publication-recovery-memcheck.mjs --real; echo "exit=$?"

# 5) Start observe-only.
sudo systemctl enable --now publication-recovery
systemctl status publication-recovery --no-pager
journalctl -u publication-recovery -n 100 --no-pager

# 6) Health and status (redacted).
prw scripts/worker/publication-recovery-health.mjs; echo "exit=$?"
prw scripts/worker/publication-recovery-status.mjs --summary
```

Update to a new release: build and copy the new tarball as above, then run
`sudo bash /tmp/install.sh /tmp/prw-<newsha>.tar.gz <newsha> --restart`.

Rollback:

- Previous release (code **and** its own pinned `node_modules`; `version.env` is rewritten to match):
  `sudo bash /opt/publication-recovery/app/sales-dashboard-live/deploy/publication-recovery/rollback.sh release`.
- Stop the worker entirely: `... rollback.sh disable`. The GitHub scheduler and the backstop reconcilers are unaffected.
- DB kill switch: the SQL above.
- Schema: `ROLLBACK_20260934.sql`, after the worker is stopped.

Report back to the owner:

- `--check-config` output;
- `systemctl status`;
- the health JSON;
- `status --summary` after at least one full scan;
- the `--real` memcheck verdict lines from the VM.

Do **not** set `PRW_LIVE_FAMILIES` or enable the control row without Gate C sign-off.

## 8. Known limits and risks

- **Cost of detection.** Every scan step and every batch pre-check or verify is a real reconciler dry-run. Each one:
  - reads Supabase (service role; egress counts against the plan);
  - makes **one zero-token DataDoe account-directory GET**.

  At the default 600s interval, a full scan is 12 dry-runs. If egress or the DataDoe GET rate matters, raise
  `PRW_SCAN_INTERVAL_SECONDS` (maximum 3600). The watermark pass (metadata SQL only) still catches new saves every
  poll.
- **Detect-only reports are not recovered.**
  - fba-plan has no zero-export publisher (only the paid go-live path).
  - The scheduler-materialized reports stay with the scheduler's materializer.

  The worker reports these gaps; it never fixes them.
- **Deferral windows.** While a scheduler-v2 cycle for a region is running (within 4h), that region's jobs are
  deferred. This includes the natural, `-fba`, LHv3, `bootstrap-*` and `priority-partial-*` cycles. During the global
  control lease, all jobs are deferred.
- **Scheduler materializer races.** `superseded-newer-live` dead-letters are expected and benign: the scheduler's
  materializer kept that live row fresher than the saved evidence. They appear in the dead-letter count, so read
  `last_class` before alerting on `--max-dead`.
- **Slow stops.** `systemctl stop` or a reboot can take up to about 15 minutes while a live Listings reconcile
  finishes. That is deliberate (see Shutdown).
- **Pre-existing, not introduced here.** A latent defect in the LHv3 operation: replaying a terminal cycle can fail
  the natural v3 job. When the Listings family cannot converge, it reports the reconciler's own reason code and
  dead-letters after bounded attempts.
- **Env-only settings.** The worker's own settings (poll, scan interval, batch size) are env-only. Restart after
  changing them.
