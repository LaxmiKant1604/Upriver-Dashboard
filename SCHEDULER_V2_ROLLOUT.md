# Scheduler v2 — Production Rollout Runbook (Phase 1f)

**Status (2026-08-13): Migrations 1–4 have been APPLIED and VERIFIED in production** (Gate 1a–1d — evidence in
Appendices C, E, G, I). Scheduler v2 otherwise remains in SHADOW MODE and fully closed: it is **locked** (the
code readiness allowlist `SCHEDULER_V2_READY_REPORT_KEYS` is empty), **paused** (all 13 durable
`report_sync_settings` rows have `schedule_enabled=false`), **undeployed**, **unscheduled** (no `pg_cron`/`pg_net`
kickoff applied), and has made **zero DataDoe exports**. The five operational/data tables — `sync_cycles`,
`sync_source_jobs`, `sync_report_jobs`, `sync_source_job_owners`, `ads_sync_coverage` — are **empty**;
`report_sync_settings` contains **exactly the 13 seeded control rows, all `schedule_enabled=false`**. No route,
deployment, live DataDoe export, control unlock, or frontend change has been made. Every remaining live step
(Gate 2
verification onward) is **gated on explicit human approval** and must be run one step at a time, pausing for
sign-off before the next. This document is the plan Codex senior review evaluates; it does not authorize any step
by itself.

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
- [ ] Gate 5 — one-account shadow canary run — package prepared (Appendix L); **NOT executed** — awaiting explicit approval before any live DataDoe/Supabase activity.
- [ ] Gate 6 — parity/reconciliation stable across ≥ 2 cycles.
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

## Appendix L — Gate 5 one-account shadow canary (PREPARED — NOT executed)

> **NOTHING in this appendix has been run.** It is the exact package a reviewer/operator executes **after
> written approval**, for **exactly ONE primary account and ONE report (`brand-sales`)**, then STOPS. It is the
> FIRST step that makes a live DataDoe export + Supabase write — but **only** into Scheduler-v2 tables and
> `scheduler-v2/*` shadow snapshots, never a production `report_snapshots` row and never a control/schedule
> change. It supersedes the earlier §5 sketch with the CURRENT runtime API. No route, cron, deployment, frontend,
> or scheduled invocation is involved.

### L.1 Scope + report choice + prerequisites

- **Exactly one primary DataDoe account** and **exactly one report: `brand-sales`** (a generic single-shot;
  its two canonical source contracts are `order-line-items` and `product-catalog`).
- Use `brand-sales` **only if** the chosen account has **both**: (1) a current production Brand Sales snapshot
  (`report_snapshots` under `report_key='brand-sales'`) for later Gate 6 parity; (2) confirmed **Product Catalog
  usability for the EXACT canonical `brand-sales` product-catalog request the CURRENT plan derives** — the
  request built from the live short source id `68d2de238e`, the contract's columns (incl. `child_asin`,
  `product_brand`), and the window/scope values the current planner emits (compute its `request_hash` via the
  same source identity the `brand-sales` plan uses). **Confirmed contract (Appendix M): the Product Catalog
  DATASET is organization-wide** — DataDoe ignores `sellerOrVendorIds` for this source and downloads requested
  for different accounts are byte-identical — so the seller id inside this request identity is a
  CURRENT-implementation cache-key artifact, **not** a data scope (Order Line Items remains genuinely
  seller-scoped). Require a `source_export_cache` entry for THAT exact `request_hash` with `row_count > 0`, and
  a bounded payload read showing **non-empty usable `child_asin` → `product_brand` mappings**. This existing
  cache entry is **usability evidence only** — proof the exact canonical request yields usable data — **not a
  pre-export shortcut**: the canary's fresh cycle still creates its own catalog export (the source worker never
  skips `create-export` because a cache entry exists), so a fully successful canary spends exactly two
  create-exports. A catalog cached under a **different `request_hash`** (another account's identity, or a
  different catalog shape/id) is MECHANICALLY insufficient — `rt.sourceRowLoader()` reads only the plan-derived
  hash — even though the underlying catalog data is organization-wide. The long id
  `68d2de238e8d1a47bc56a981a99d54558507b0bafb1e09f1b3e95fb7750a17a8` is the **obsolete (DataDoe-404)** alias and
  must **never** be used.
- **If either prerequisite (or the exact catalog evidence) cannot be confirmed, STOP.** Do not use the obsolete
  catalog ID, do not add a fallback/retry, and do not substitute another report or account without review.
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
- The EXACT canonical `brand-sales` product-catalog usability is validated **in-script** (L.5) from the
  **plan-derived** catalog `request_hash` via `rt.sourceRowLoader()` — a current cache entry, `source_id ===
  '68d2de238e'`, `rows.length === row_count`, `0 < rows.length < limit`, and ≥ 1 non-blank
  `child_asin`/`product_brand` (never printed). A catalog entry under any other `request_hash` is MECHANICALLY
  insufficient (the loader reads only the plan-derived hash; the organization-wide dataset — Appendix M — does
  not change the cache identity the CURRENT plan derives). There is no manual `<PC_REQUEST_HASH>` substitution.
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

// PRE-EXECUTION catalog usability: the EXACT plan-derived catalog request, via rt.sourceRowLoader() (cache-only,
// current entry). NEVER prints rows or secrets. STOP if the exact request is not usable (no fallback / no long id).
const catalog = byKey.get("brand-sales:catalog");
const cache = await rt.sourceRowLoader(catalog.requestHash);              // { ..., source_id, row_count, rows } | null
if (!cache) throw new Error("canary: no CURRENT product-catalog cache for the exact brand-sales:catalog request (STOP)");
if (cache.source_id !== "68d2de238e") throw new Error(`canary: catalog cache source_id ${cache.source_id} != 68d2de238e (STOP)`);
if (!Array.isArray(cache.rows) || cache.rows.length !== cache.row_count) throw new Error("canary: catalog cache rows.length != row_count (STOP)");
if (!(cache.rows.length > 0 && cache.rows.length < catalog.limit)) throw new Error(`canary: catalog rows ${cache.rows.length} not in (0, ${catalog.limit}) (STOP)`);
if (!cache.rows.some((r) => r && norm(r.child_asin) !== "" && norm(r.product_brand) !== "")) throw new Error("canary: no non-blank child_asin/product_brand mapping (STOP)");

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
`requestHash`/`sourceKey`/`sourceId`/`limit`/window/org/scope; a prerequisite mismatch (no production brand-sales
snapshot, or the EXACT plan-derived brand-sales product-catalog request unavailable / stale / `source_id ≠
68d2de238e` / `rows.length ≠ row_count` / not `0 < rows.length < limit` / no usable `child_asin` →
`product_brand` mapping); **any pre-existing `scheduler-v2/*` snapshot** before the run; a DB source row whose
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
> source-id properties, the single plan-derived owner id, catalog cache, per-slice source + owner checks, the
> final-drain exactly-one-export-per-hash guard, shadow/report-job checks, and the deadline clamp/boundary) is
> exercised by a **deterministic offline self-check**: `scripts/gate5-canary-package.test.js`
> (`npm run test:gate5-canary-package`; part of `npm run verify`) — it builds the real `planBrandSales()` output
> and asserts each guard passes on the correct shape and throws on a wrong account/seller id, both sources
> shifted to the same valid-but-wrong window, `strict:false`, a wrong Order Line Items or Product Catalog source
> id, wrong hashes, duplicate/missing sources, a wrong/blank/missing `owner_id`, a stale/absent catalog cache,
> pre-existing shadow rows, extra report jobs/snapshots, a final drain without exactly one create-export per
> hash, and the final-slice deadline boundary.

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

### M.2 Reviewed organization-wide Catalog design (separation of concerns)

- **Canonical source scope/hash: organization-wide.** ONE canonical Product Catalog request identity per
  organization (per `organizationFingerprint`), derived from the org credential + the contract's
  columns/limit/ordering + the final (M.3-confirmed) filter/window semantics — and **NOT** from any
  per-account seller id. One org ⇒ one catalog `request_hash` per cycle window.
- **Owner memberships stay account/report-specific.** `sync_source_job_owners` rows remain per
  `(report_key, account, connection, org/scope)` — every report/account needing the catalog holds its OWN
  active membership pointing at the ONE org-wide canonical `request_hash`. The Appendix L P2 isolation model
  (ownerless-row / membership-scope checks) is unchanged in shape; only the number of distinct canonical
  catalog hashes shrinks to one per organization.
- **One shared saved catalog/map.** A single `source_export_cache` entry (and the derived shared ASIN → brand
  map) per organization catalog identity; every derive reads the same saved rows. Blank-brand ASINs (M.1 #6)
  stay unmapped — never "Unassigned".
- **No duplicate export per account.** The existing DB one-attempt guard (`claim_source_export_attempt` +
  the one-attempt CHECK) already dedupes by `request_hash`; with ONE org-wide hash there is at most ONE
  catalog create-export per cycle for the WHOLE organization, regardless of account count.
- **Automatic reuse for newly discovered accounts.** A newly discovered account's plan resolves the SAME
  org-wide hash, so onboarding adds only a new owner-membership row; the existing canonical job, export, and
  saved catalog/map are reused — zero additional catalog tokens.

**Rejected shortcut (do NOT implement):** normalizing or hard-coding `accountScopeHash` (hashing a constant /
empty scope, or aliasing every account onto one account's hash) while the request still carries per-account
seller ids. That would (a) make the stored identity lie about the actual request, (b) silently alias
genuinely account-scoped requests if ever applied beyond the catalog, (c) bypass the resolver's
single-account invariants instead of modeling scope, and (d) leave no explicit contract-level record that the
source is org-wide. The correct change is a first-class **organization scope** in the source contract +
resolver + planner (a typed scope the identity derivation understands), landed as reviewed code with tests —
only after M.3 resolves.

### M.3 Deliberately unresolved (pending DataDoe follow-up — do not guess)

The final org-wide request identity is NOT fixed here. Blocked on DataDoe's answers about:
- whether a **marketplace filter** exists/behaves server-side for this source (current files carry no
  `marketplace_id` — M.1 #4);
- whether a **`child_asin` filter** is honored;
- the source's **date behavior** (no-date vs windowed semantics for this dataset);
- the exact request payload the org-wide identity should therefore hash (columns/window/filters).

Until then: no planner/resolver/contract change, no new hash scheme, no migration of cached entries, and the
Gate 5 canary (Appendix L) keeps validating the CURRENT plan-derived identities unchanged.
