# Scheduler v2 — Production Rollout Runbook (Phase 1f)

**Status: PLAN ONLY. Nothing in this runbook has been executed.** Scheduler v2 is in SHADOW MODE: no route,
cron, deployment, migration application, live DataDoe export, control unlock, or frontend change has been made.
Every live step below is **gated on explicit human approval** and must be run one step at a time, pausing for
sign-off before the next. This document is the plan Codex senior review evaluates; it does not authorize any
step by itself.

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
  - [ ] Gate 1d — `20260811_sync_source_job_owners.sql` (**NOT executed**).
- [ ] Gate 2 — post-migration verification queries pass.
- [ ] Gate 5 — one-account shadow canary run.
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
Connected to production Supabase over the committed `POSTGRES_URL` (`sslmode=no-verify`) — the connection string
was loaded from `.env.local` and never printed. **Exactly one migration applied: `20260807_scheduler_v2.sql`.**

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
Connected to production Supabase over the committed `POSTGRES_URL` (`sslmode=no-verify`) loaded from `.env.local`
and never printed. **Exactly one migration applied in this gate: `20260810_ads_sync_coverage.sql`.**

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
Connected to production Supabase over the committed `POSTGRES_URL` (`sslmode=no-verify`) loaded from `.env.local`
and never printed. **Exactly one migration applied in this gate: `20260810_report_sync_controls.sql`.**

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
