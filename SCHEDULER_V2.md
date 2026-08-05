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

- **`20260807_scheduler_v2.sql`** (additive; `0563d3e`, corrected by the review
  pass): `sync_cycles` (unique(bucket, cycle_date)), `sync_source_jobs`
  (unique(cycle_id, request_hash); DB-enforced one-attempt invariant — CHECK
  `(count=0 AND attempted_at IS NULL) OR (count=1 AND attempted_at IS NOT NULL)`, so
  the database caps create-export at one even against a direct write;
  fetch_status/error_stage/error_code/error_message/row_count/payload_bytes/
  duration_ms/terminal; cache_object_path + last_good_fetched_at), `sync_report_jobs`
  (separate fetch/derive/save status + `validated`; latest_data_date;
  snapshot_params_hash; last_good_snapshot_at). RPCs: `open_sync_cycle` (idempotent
  ENQUEUE — creates a **pending** cycle with `started_at` NULL, never a duplicate),
  `claim_sync_cycle` (atomic **pending → running**, stamps `started_at` once, cannot
  be claimed twice), `claim_source_export_attempt` (durable one-POST guard). RLS
  service-role-write + admin-read. **No secret in any migration.**
- **planner v2** (`4469e70`): pure `buildDependencyPlan` (dedup),
  `sourceExportAttemptAllowed`, `reportFetchGate`. Tests live in
  `scripts/scheduler-v2.test.mjs` (renamed from the old `test-scheduler-v2.mjs`,
  which was an inaccessible entry in the Codex checkout) — 22 assertions proving the
  DB invariants + transitions, run by `npm run verify`.

---

## 3. Source dependency map (corrected from executable `api/datadoe.js`)

Source IDs below are the **actual constants in `api/datadoe.js`** with line refs,
not guesses. Earlier drafts of this file were WRONG (they said Dashboard uses
Sales & Traffic); the code shows `buildBrandSalesPayload` uses Order Line Items +
Product Catalog, and Sales & Traffic `401ffcd7e5` is used by Daily Reporting and
FBA velocity instead. Corrected here.

**Sharing rule (important):** two reports share a DataDoe export ONLY when their
*complete* canonical identity is identical — organization, account scope, source
id, columns, grain, aggregations, from/to window, row limit AND ordering — because
that is exactly what `request_hash` covers. **The same `source_id` is NOT enough.**
In practice per-report windows/columns differ, so cross-report dedup is the
exception; each pairing below must be proven per `request_hash` before it is
claimed as a saved export. The reliable token-saving is (a) within-cycle reuse of a
request across accounts/reports that truly match, and (b) the persisted
`source_export_cache`.

| Report | Source constants used (api/datadoe.js) | Confidence |
|---|---|---|
| Dashboard / `brand-sales` | `ORDER_LINE_ITEMS_SOURCE_ID` = `89b27535…` (L164) **+** `PRODUCT_CATALOG_SOURCE_ID` = `68d2de…` (L189) — `buildBrandSalesPayload` L622-637 | confirmed from code |
| Daily Reporting | `DAILY_SALES_SOURCE_ID` = `401ffcd7e5` (L675, Sales & Traffic) + `PRODUCT_CATALOG` `68d2de…` (L1639) + `ADS_SOURCE_ID` = `08cdc77d3d` (L1683) | confirmed |
| FBA Shipment Plan | `PLAN_SALES_SOURCE_ID` = `401ffcd7e5` (L778, Sales & Traffic velocity, L1180/1969) + `PRODUCT_CATALOG` `68d2de…` (L1986) + `FBA_HEALTH_SOURCE_ID` = `44fc5b…` (L784, L2002) + **US only** `LISTINGS_SOURCE_ID` = `ba689c…` AWD (L803, L2057) | confirmed |
| Reconciliation | `ORDER_LINE_ITEMS` `89b27535…` (L1719) + `RECONCILIATION_SETTLEMENTS_SOURCE_ID` = `732dac…` (L707, L1723) + `PRODUCT_CATALOG` `68d2de…` (L1727) | confirmed |
| SKU P&L Analyzer | `SKU_PL_SOURCE_ID` = `57a0cb…` (L735, L1095) + COGS from **Supabase** (user-entered, not DataDoe) | confirmed |
| Keyword Rank | `SQP_WEEKLY_SOURCE_ID` = `81aa5b…` (L754, L1803) + `SQP_MONTHLY_SOURCE_ID` = `df4160…` (L755, L1823) | confirmed |
| Content Alerts | `CONTENT_CHANGE_SOURCE_ID` = `aec3d5…` (L663, L1899) + `PRODUCT_CATALOG` `68d2de…` (L1849/1912) | confirmed |
| Sales Movers, Listing Health, Buy Box Loss, Returns & Refunds, PPC Performance, Listing Optimizer | **NOT audited yet** — extract per-report in Phase 1b and live-validate. Ads-derived reports read saved `ads_daily_source_rows` (`ADS_SOURCE_ID` `08cdc77d3d` + the 4 registry ads sources) | requires extraction + live validation |

Notes from the corrected contracts:
- **Order Line Items `89b27535…`** is used by BOTH Dashboard (`brand-sales`) and
  Reconciliation — but with different columns/windows, so they are almost certainly
  **different `request_hash`es** (not one shared export). This is the source that
  returns 404 in some primary EU orgs and 402 on secondary (see §5), so it is a
  first-class terminal-failure risk for Dashboard, not only Reconciliation.
- **`401ffcd7e5` (Sales & Traffic)** is used by Daily Reporting and FBA velocity;
  FBA reads it with `["child_asin"]` (L1180) and Daily with its own columns/window,
  so again likely distinct `request_hash`es — verify before claiming a shared export.
- **`b24cd69c06` (`DASHBOARD_SOURCE_ID`, L147, used at L1594)** is a separate legacy
  dashboard path, NOT the `brand-sales` snapshot builder. Do not conflate the two.
- **Derived-only (no own export):** Priority Feed, Brand View, brand directory,
  `sales` rollup — read already-saved snapshots/history (`depends_on: []`).

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

**Phase 1b — registry source contracts.** IN PROGRESS.
- DONE (`420101b`): `sourceRequestIdentity` (+`sha256`/`stableValue`) extracted
  **verbatim** into `lib/server/source-identity.js`, imported by `datadoe.js`.
  Byte-identical hash proven by `scripts/source-identity.test.mjs` (parity vs an
  independent reconstruction of the pre-extraction algorithm + a pinned golden hash),
  so `source_export_cache` stays valid. Note: it landed at `lib/server/source-identity.js`
  (a clean leaf importing only `source-contracts.js`), not under `sync/`.
- DONE (`5026038`): `lib/server/sync/report-source-contracts.js` declares each
  report's exact create-export inputs `{sourceKey, columns, limit, groupBy,
  aggregations, orderByColumn, orderByDirection, windowKind}` + `reportSourceRequestHashes()`.
  Declared so far, read line-by-line from the builders and **parity-tested against
  the executable `api/datadoe.js` constants** (`scripts/report-source-contracts.test.mjs`,
  10 assertions): **brand-sales** (Order Line Items + Product Catalog, one shared
  window) and **sku-pl** (Profit by SKU & Date, per-month).
- CORRECTED (`c46deef`, `9877e21`) after review: the resolver now reproduces the live
  transport EXACTLY. Five-ID batching moved to a dependency-free leaf
  `lib/server/id-batching.js` (shared by `datadoe.js` + the resolver); the resolver
  chunks the account scope into groups of 5 in input order and emits **one request
  per chunk** with its own `request_hash` (no longer one hash over all IDs); empty
  scope ⇒ `[]`. Each declared source carries a stable **requestKey**
  (`brand-sales:order-lines`, `brand-sales:catalog`, `sku-pl:monthly-profit`), and
  windows are supplied as `windowsByRequestKey` and applied **only to their own key**
  — no shared Cartesian product — so a monthly source and a no-date source can never
  receive each other's dates (validated; missing/unknown keys throw). Result fields:
  requestKey, sourceKey, sourceId, sellerOrVendorIds (the chunk), from/to, limit,
  options, requestHash, organizationFingerprint, accountScopeHash, requestMeta. Tests
  now cover ID counts 0/1/5/6/11 vs the transport, per-key windows, no-date, reorder
  behaviour and org isolation (23 assertions).
- REMAINING: declare the multi-call / per-month / brand-variant reports
  (`daily-reporting`, `fba-plan`, `reconciliation`, `keyword-rank`, `content-changes`)
  and the insight reports with the SAME parity-tested method — each from its exact
  builder calls, never assumed. Key realism found while auditing: several reports fire
  multiple exports with per-month windows (e.g. sku-pl, fba-plan) and brand-variant
  columns (daily all-brand vs named), and the same `source_id` used by two reports
  usually has a different window ⇒ a different `request_hash` ⇒ NOT a shared export.
  The request `source` field hashes on the contract KEY (not the raw id), so the
  short/long id variants of a source collapse to one hash.

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
