# Scheduler v2 — Production Rollout Runbook (Phase 1f)

**Status (2026-08-14): Migrations 1–5 APPLIED + VERIFIED; the Gate 5 one-account brand-sales SHADOW canary has
been EXECUTED (SUCCESS) and its cycle RECONCILED to `succeeded` via Appendix N (EXECUTED 2026-08-14).**
Scheduler v2 otherwise remains in SHADOW MODE and closed: it is **locked** (the code readiness allowlist
`SCHEDULER_V2_READY_REPORT_KEYS` is empty), **paused** (all 13 durable `report_sync_settings` rows have
`schedule_enabled=false`), **undeployed**, and **unscheduled** (no `pg_cron`/`pg_net` kickoff applied; no cron
sync job). **Exact current operational state:** the Scheduler-v2 tables hold **one canary cycle** (`sync_cycles`:
1 row, `(non-us, 2026-08-14)`, id `57afc1fb-…`) — now **terminal `status='succeeded'`** with `finished_at`
`2026-08-14T16:34:30.312782Z` and authoritative counters `source 2/2/0`, `report 1/1/0` (Appendix N.4) — **two
succeeded source jobs**, **one report job**, and **two owner memberships** (all byte-unchanged by the
reconciliation); there is **exactly one `scheduler-v2/brand-sales` shadow snapshot** (and exactly one
`scheduler-v2/*` snapshot globally); the canary spent **exactly two DataDoe create-exports total** (one Order
Line Items, one Product Catalog `68d2de238e`; the reconciliation spent ZERO); the production Brand Sales
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
needing DataDoe/Ads-sync input. **Cycle 2 is NOT started**: it is BLOCKED pending Codex review of the Cycle-1
evidence and explicit human approval, and no control unlock/publish/deploy/schedule has happened. Every
remaining live step is **gated on explicit human approval**, one step at a time.
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
- [ ] Gate 6 Shadow Parity CYCLE 2 (+ stability across ≥ 2 cycles). **BLOCKED** pending Codex review of the
  Cycle-1 evidence and explicit human approval (nothing here authorizes it). Cycle 2 should land the fixed
  brand-sales payload (`asinBrand`) and re-observe the TIMEOUT-prone large exports.
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
