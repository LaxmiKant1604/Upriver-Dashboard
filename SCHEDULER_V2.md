# Scheduler v2 — source-first sync (working design + plan)

Branch: `feature/scheduler-v2` (from `origin/main` @ `330ac91`). Not pushed/merged/
deployed. `feature/design-system` is untouched. Commit small; Codex reviews +
deploys the backend foundation first, validates real cycles, then the UI phase.

> Honesty note: this repo has **no live DataDoe key, Supabase session, or browser**.
> Everything below that concerns real export shapes, 402/404 coverage, or "a report
> renders" is a claim to be **validated live by Codex**, never asserted from here.

---

## 1. What already exists (verified from code on origin/main)

Scheduler **v1** is built and deployed. It is not a greenfield.

- `lib/server/sync/registry.js` — declarative registry. **Enabled today: 4 Ads
  sources + `brand-sales` only.** `fba-plan`, `daily-reporting`, `reconciliation`,
  `sku-pl`, `keyword-rank`, `content-changes`, and the 5 insight reports are
  declared `enabled:false` (this is problem #2–3 in the brief). `sales-movers` is
  disabled pending sub-export checkpointing.
- `lib/server/sync/run-sync.js` — `runScheduledSync({bucket})`: per-bucket lock →
  `sync_runs` → discover both orgs + `account_directory` → ordered work → bounded
  ~50 s loop with per-target lock, checkpoint to `sync_targets`, continue-on-
  failure → retention → finalize.
- `lib/server/sync/planner.js` — `expandSyncWork`, `targetDisposition`
  (3-attempts-per-cycle). **v2 additions committed here** (below).
- `lib/server/sync/adapters/` — `report-adapter.js` (generic; save only on success
  = last-known-good), `ads.js`, `index.js` (only module importing `api/datadoe.js`).
- `lib/server/datadoe.js` — **the canonical source identity already exists**:
  `sourceRequestIdentity({apiKey, sourceId, columns, ids, from, to, limit, options})`
  → `requestHash = sha256({organizationFingerprint, accountScopeHash, requestMeta})`
  where `requestMeta = {source, columns↑, from, to, limit, groupBy↑, aggregations↑,
  orderByColumn, orderByDirection}`. This is *exactly* the brief's canonical
  identity (org, account scope, source, columns, grain, aggregations, window, limit,
  ordering). `fetchSourceChunk` already dedups via memory + in-flight + the
  persisted `source_export_cache`, and **rejects truncated results**
  (`rows.length < limit` ⇒ not persisted).
- Migrations: `20260805_scheduled_sync.sql` (account_directory, sync_runs,
  sync_targets, sync_errors, audit_log), `20260806_shared_source_export_cache.sql`
  (`source_export_cache` keyed by `request_hash` → Storage payload; prune RPC).

**Gap v2 closes:** the in-process caches in `datadoe.js` cannot prevent two
*separate* serverless workers from each POSTing create-export for the same
`request_hash`, and there is no durable source→report dependency graph, per-cycle
"one attempt", or separated fetch/derive/save accounting. That is what the new
tables + planner provide.

---

## 2. What this branch adds so far (committed, verify-green)

- **`20260807_scheduler_v2.sql`** (additive; `0563d3e`): `sync_cycles`
  (unique(bucket, cycle_date)), `sync_source_jobs` (unique(cycle_id, request_hash);
  `attempted_at` + `create_export_count<=1` guard; fetch_status/error_stage/
  error_code/error_message/row_count/payload_bytes/duration_ms/terminal;
  cache_object_path + last_good_fetched_at), `sync_report_jobs` (separate
  fetch/derive/save status + `validated`; latest_data_date; snapshot_params_hash;
  last_good_snapshot_at). RPCs `open_sync_cycle` (idempotent kickoff) and
  `claim_source_export_attempt` (durable one-POST guard). RLS service-role-write +
  admin-read. **No secret in any migration.**
- **planner v2** (`4469e70`): pure `buildDependencyPlan` (dedup),
  `sourceExportAttemptAllowed`, `reportFetchGate` + `scripts/test-scheduler-v2.mjs`
  (10 assertions, in `npm run verify`).

---

## 3. Source dependency map (draft — contracts to be extracted in Phase 1b)

Each report DERIVES from one or more canonical sources. The **exact source IDs,
columns, grain and aggregations must be lifted from the per-report builders in
`api/datadoe.js`** (not guessed) and confirmed to exist **per organization** before
enabling. Categories below are inferred from the registry + PROJECT_MEMORY and are
the extraction checklist, not final contracts.

| Report | Canonical source(s) needed | Shared with | Notes |
|---|---|---|---|
| Dashboard / brand-sales | Sales & Traffic by ASIN & Date | Daily, SKU P&L, FBA, Movers, insights | already enabled |
| Daily Reporting | Sales & Traffic (150-day window) + Ads | Dashboard (diff window ⇒ diff hash) | window differs ⇒ separate source job |
| FBA Shipment Plan | Sales & Traffic (velocity) + FBA Inventory Health + (US only) Listings/AWD | Dashboard (sales) | AWD source US-only |
| Reconciliation | **Order Line Items** + settlement/financial events | SKU P&L (financial) | ⚠ 402/404 source (see §5) |
| SKU P&L Analyzer | Sales & Traffic + Order Line Items/financial + Ads + COGS (Supabase, user-entered) | Dashboard, Reconciliation, Ads | COGS is NOT a DataDoe source |
| Keyword Rank | keyword-targeting-performance + search-query/rank source | Ads (keyword) | |
| Content Alerts | Product Catalog / Listings snapshot | Brand directory | Product Catalog 0-rows in secondary org (known) |
| Sales Movers | Sales & Traffic | Dashboard | multi-export ⇒ needs checkpointing |
| Listing Health | Listings / catalog + Sales & Traffic | Content Alerts | |
| Buy Box Loss | Buy-box / offer source + Sales & Traffic | | |
| Returns & Refunds | Returns source + Sales & Traffic | Reconciliation | |
| PPC Performance | campaign/asin/keyword/search-terms Ads (4) | Ads (all) | derives from ads_daily_source_rows |
| Listing Optimizer | Ads + Listings + search-terms | PPC, Keyword Rank | |

**Derived-only (must NOT create their own export):** Priority Feed, Brand View,
brand directory, `sales` rollup — read already-saved snapshots/history. In the
planner these are report jobs with `depends_on: []` (or depending only on other
reports' saved output).

Token-saving payoff: e.g. Sales & Traffic for one account, one window feeds
Dashboard + Movers + Listing Health + FBA velocity from **one** export; the 4 Ads
sources feed PPC + Listing Optimizer + Keyword Rank + per-report ad metrics from
**4** exports total, not per-report.

---

## 4. Phased plan (remaining) — ordered so the backend deploys/validates first

**Phase 1b — registry source contracts.** For every report, add a declarative
`sources: [{sourceId, columns, grain, aggregations, window, limit, ordering}]`
extracted verbatim from the `api/datadoe.js` builder, so the planner can compute
each report's `request_hash` set via the *existing* `sourceRequestIdentity` (extract
it into `lib/server/sync/source-identity.js`, imported by both `datadoe.js` and the
planner, **byte-identical hash** so `source_export_cache` stays valid). Tests: every
sidebar report has a scheduler declaration; a source shared by ≥2 reports yields one
`request_hash`.

**Phase 1c — worker v2 / run-sync v2.** Kickoff opens one cycle (`open_sync_cycle`),
materializes `sync_source_jobs` (deduped) + `sync_report_jobs`. Bounded checkpointable
worker: for each due source job, `claim_source_export_attempt` → if won, one
create-export (store `export_id`); poll/download may resume on later invocations
without re-POST; on 402/404/truncated ⇒ mark `terminal`, record safe error, keep
last-known-good. When a report's deps all succeed ⇒ derive from saved source rows ⇒
validate ⇒ save (separate `save_status`). Stop safely before the Vercel timeout;
next invocation continues pending jobs. A cycle is "succeeded" only when fetch+save+
derive+validate all pass — never on HTTP 200 alone.

**Phase 1d — derivation adapters.** Extract each report's calculation into a pure
function consuming saved canonical source rows (do **not** call a builder that
re-exports). Segment/checkpoint large 6-month reports. Reject row-cap/truncated data.

**Phase 1e — Admin Data Sync Center.** `src/views/DataSyncCenter.jsx` (admin-only
lazy route) + `/api/admin/sync.js` (admin-only) + sidebar item. Read-only view of
cycles/source jobs/report jobs with the columns + filters in the brief. **No retry,
no manual DataDoe refresh button.**

**Phase 1f — durable kickoff.** Separate migration `20260808_scheduler_v2_kickoff.sql`
(applied AFTER Vault secret load): pg_cron @ `0 2 * * *` and `30 10 * * *` calling a
SQL fn that `open_sync_cycle` + `pg_net.http_post`s the worker, reading the auth
secret from **Supabase Vault** (`vault.decrypted_secrets`). GitHub/Vercel remain
watchdogs that call the same idempotent endpoint (never create a second cycle).

**Phase 2 (LAST, after real cycles validated) — remove manual refresh.** In
`src/App.jsx`: remove SnapshotGate refresh actions, `refreshSharedReport`,
`refresh=1` senders, `fetch{Rows,Daily,Plan,Reconciliation,SkuPl,KeywordRank,
ContentChanges}`, header refresh buttons. New empty states: "Scheduled sync
pending" / "No scheduled snapshot yet" / "Last sync failed, showing data from
<ts>" / "Data unavailable because <admin-safe reason>" / "Saved data refreshed at
<ts>". Server rejects browser `refresh=1` after migration. Tests: no `refresh=1`
sender or "Refresh from DataDoe" remains in `src`.

---

## 5. Non-Indian account investigation (status — needs a live probe)

Documented in PROJECT_MEMORY from the v1 production run, **not yet re-probed here**:

- Some primary EU accounts return **DataDoe 404** for Order Line Items source
  `89b27535d27c2a94db5ae39af4717f542624ff4df7802fd633e16c78674a1778` — the source
  is **not available in that organization**. ⇒ Do not assume one source ID exists in
  both orgs; the registry contract must be **per-connection**, and a 404 is a
  terminal source-job failure that must not block other accounts/reports.
- Mostly secondary (`dd-secondary:`) accounts return **DataDoe 402** (export-credit
  exhausted). Terminal for that source+cycle; never auto-retried.
- Secondary **Product Catalog** returns 0 rows (upstream ingestion), so those brands
  cannot be derived regardless of code.

Required (Phase 1b/live): **one controlled probe per organization** listing available
source IDs, recorded once (no credit-burning loops), so each report's source is
selected from that org's confirmed set. `distinguish routing bug vs missing source
vs 402` in the recorded `error_code`.

---

## 6. Rollout steps (for Codex)

1. Review + apply `20260807_scheduler_v2.sql` (additive; safe in production while v1
   keeps serving last-known-good).
2. Continue Phase 1b–1e on this branch; keep `npm run verify` green each commit.
3. Load Vault secrets, apply `20260808_scheduler_v2_kickoff.sql`; run Scheduler v2 in
   **shadow mode** (writes v2 tables; does not yet change what pages read).
4. Validate ≥1 non-US and ≥1 US cycle across **primary and secondary** orgs; confirm
   every enabled report has a valid snapshot **or** an explicit safe failure reason.
5. Only then land Phase 2 (remove manual refresh, enforce read-only scheduled data).

Do not count a cycle successful on HTTP 200; success = fetch + save + derive +
validate. Do not claim accuracy without live reconciliation evidence.
