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

## 1. Migration order (apply one at a time; each is additive + idempotent)

Apply in this order (each is `create ... if not exists` / `create or replace`; none alters or drops an
existing table; none touches historical Ads data). **Approval required before each `apply`.**

1. `20260807_scheduler_v2.sql` — `sync_cycles`, `sync_source_jobs`, `sync_report_jobs` +
   RPCs `open_sync_cycle`, `claim_sync_cycle`, `claim_source_export_attempt`.
2. `20260810_ads_sync_coverage.sql` — `ads_sync_coverage` (durable Daily/PPC coverage windows).
3. `20260810_report_sync_controls.sql` — `report_sync_settings` (every report seeded `schedule_enabled=false`).
4. `20260811_sync_source_job_owners.sql` — `sync_source_job_owners` (many-to-many source ownership;
   converges idempotently and **fails closed** on a malformed pre-existing identity row).

> The `pg_cron` / `pg_net` kickoff + its Vault secret are a SEPARATE migration
> (`20260808_scheduler_v2_kickoff.sql`) that is **intentionally NOT part of this rollout** and is applied only
> after a fully reviewed live cutover. Applying steps 1–4 alone creates NO DataDoe request and NO schedule.

## 2. Verification queries (run read-only after EACH migration)

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

- [ ] Gate 0 — preconditions verified.
- [ ] Gate 1a–1d — each migration applied (one at a time).
- [ ] Gate 2 — post-migration verification queries pass.
- [ ] Gate 5 — one-account shadow canary run.
- [ ] Gate 6 — parity/reconciliation stable across ≥ 2 cycles.
- [ ] Gate 7 — per-report control unlock (repeat per report).
- [ ] Kickoff (`20260808_scheduler_v2_kickoff.sql`) — separate, later, fully-reviewed step (NOT in this phase).
