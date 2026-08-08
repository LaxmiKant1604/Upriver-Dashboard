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
| Daily Reporting | **COMPLETE (superset strategy).** ONE ASIN/day Sales & Traffic superset (`fetchDailyBrandSalesRows`, monthly-segmented, `child_asin` grain, `DAILY_BRAND_ROW_LIMIT` 50000, L1136) + ONE `PRODUCT_CATALOG` — all-brand + every named brand derive from these; no per-brand and no compact export. Ads derive from `ads_daily_source_rows`. Keys: `daily-reporting:asin-day-superset`, `:catalog`. | confirmed |
| FBA Shipment Plan | `PLAN_SALES_SOURCE_ID` = `401ffcd7e5` (L778, Sales & Traffic velocity, L1180/1969) + `PRODUCT_CATALOG` `68d2de…` (L1986) + `FBA_HEALTH_SOURCE_ID` = `44fc5b…` (L784, L2002) + **US only** `LISTINGS_SOURCE_ID` = `ba689c…` AWD (L803, L2057) | confirmed |
| Reconciliation | `ORDER_LINE_ITEMS` `89b27535…` (L1719) + `RECONCILIATION_SETTLEMENTS_SOURCE_ID` = `732dac…` (L707, L1723) + `PRODUCT_CATALOG` `68d2de…` (L1727) | confirmed |
| SKU P&L Analyzer | `SKU_PL_SOURCE_ID` = `57a0cb…` (L735, L1095) + COGS from **Supabase** (user-entered, not DataDoe) | confirmed |
| Keyword Rank | **COMPLETE.** `sqp-weekly` (81aa5b, 84d) + `sqp-monthly` (df4160, 365d, **data-dependent fallback** — see §9) + `product-catalog` (365d). SQP raw rows, `strict`, structured `availabilityPolicy` (terminal). | confirmed |
| Content Alerts | **COMPLETE.** `content-changes` (aec3d5, **no-date**, 1000, event_time/DESC) + `product-catalog` (365d). Structured `availabilityPolicy` (terminal). | confirmed |
| Insight reports (Sales Movers, Buy Box Loss, Returns & Refunds, Listing Health, Listing Optimizer, PPC Performance) | **AUDITED + classified (contracts not yet declared).** Builders in `lib/server/reports/*.js` (`sources.js`/`common.js`). See §7. Owned: Movers (sales-traffic, profit-by-sku, fba-inventory-health, catalog), Buy Box (profit-by-sku, inventory, catalog), Returns (returns, settlements, sales-traffic, catalog). Owned+org-cond: Listing Health (+`listings-raw`, degrades), Listing Optimizer (`sqp-weekly`). PPC: owned small sales-traffic + catalog, **ads DERIVED from persisted `ads_daily_source_rows`**. | audited; declaration pending |

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

Token-saving payoff is request-identity based, not source-name based. One canonical
request can feed every matching report dependency, but requests with different
columns/windows remain separate. The four persisted Ads sources can feed compatible
PPC and brand/report metrics without each report exporting Ads again. Dashboard
continues to use Order Line Items + Product Catalog; it does not reuse the FBA/Daily
Sales & Traffic requests.

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
- DONE (`a53b3e2`): empty account scopes return `[]` before validating windows or
  conditional marketplace metadata.
- DONE (`f2eb3e5`): exact declarations for **Reconciliation**, **FBA Shipment Plan**,
  and the **all-brand Daily Reporting path**, parity-tested against their executable
  builder calls. Reconciliation declares monthly Order Line Items + monthly
  Settlements + one full-range Product Catalog request. FBA declares four monthly
  ASIN-unit windows, current-month date coverage, catalog, inventory health, and a
  no-date Listings/AWD request that is mandatory only when authoritative account
  country is `US`. Daily all-brand declares Sales & Traffic; its Ads dependency is
  explicitly derived from persisted Ads history rather than another DataDoe export.
  Coverage metadata marks Daily `all-brand-only`, preventing Phase 1c from enabling
  its still-undeclared named-brand path as complete. Tests now cover exact source
  parity, monthly segmentation, no cross-products, 0/1/5/6/11-ID chunking,
  source-requirement coverage, and US/non-US AWD applicability (46 assertions).
- REMAINING: declare Daily Reporting's named-brand ASIN/month + Product Catalog path,
  then `keyword-rank`, `content-changes`, and the insight reports with the SAME
  parity-tested method. The same `source_id` used by two reports usually has a
  different request identity and must not be claimed as a shared export.

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

---

## 7. Insight-report source audit + classification (2026-08-06)

Audited from executable code in `lib/server/reports/` (`sources.js`, `common.js`,
per-report builders). Dependency classes: **owned** = the report's own DataDoe export;
**derived** = persisted `ads_daily_source_rows` / another snapshot; **org-cond** =
`defaultDataset:false`. The report API may translate DataDoe's disabled-source error
to HTTP 424, but a Scheduler v2 source worker sees the raw DataDoe error and must
classify it with `isSourceDisabledError` (or an equivalent safe error code).

| Report | Owned DataDoe exports (source · columns-const · limit · window · order) | Derived / org-cond |
|---|---|---|
| Sales Movers | `sales-traffic` TRAFFIC_COLUMNS 50000 per-window child_asin/ASC · `profit-by-sku` ADS_COLUMNS 50000 per-window · `fba-inventory-health` (shared) · `product-catalog` (shared) | ads come from Profit-by-SKU (owned), not persisted ads |
| Buy Box Loss | `profit-by-sku` DAILY_COLUMNS 50000 per-slice · `fba-inventory-health` · `product-catalog` | — |
| Returns & Refunds | `returns` RETURN_COLUMNS 50000 · `settlements` SETTLEMENT_GROUP_BY 50000 · `sales-traffic` TRAFFIC_GROUP_BY 50000 · `product-catalog` | — |
| Listing Health | `listings` LISTING_COLUMNS 20000 no-date · `profit-by-sku` SALES_COLUMNS 50000 · `fba-inventory-health` · `product-catalog` | **`listings-raw` org-cond, DEGRADES gracefully (optional)** |
| Listing Optimizer | `sqp-weekly` SQP_COLUMNS 50000 · its own richer `product-catalog` request | **`sqp-weekly` org-cond; builder degrades to a valid `sqpAvailable:false` snapshot when disabled** |
| PPC Performance | `sales-traffic` TOTAL_SALES_GROUP_BY 500 date-rollup (TACoS denominator) · `product-catalog` | **ads DERIVED from persisted `ads_daily_source_rows`** (never a live ads export) |

**Shared insight fetchers (token saving via dedup):** five reports call `common.js
fetchCatalog` (Sales Movers, Buy Box Loss, Returns, Listing Health, PPC) with one
identical `product-catalog` identity: CATALOG_COLUMNS, no-date, limit 20000,
child_asin/ASC. Three reports call `fetchInventorySnapshot` (Sales Movers, Buy Box
Loss, Listing Health) with one identical FBA Inventory Health identity. Those matching
consumers can share one catalog and one inventory export per account/org. Listing
Optimizer does **not** use `fetchCatalog`: it requests richer content columns, so its
catalog has a different `request_hash` and cannot share under the exact-identity rule.
The common insight catalog also differs from operational catalogs (window/limit), so
it is not shared with those.

**Now declared + parity-tested (see §10, 2026-08-06):** all six insight reports are formal
`REPORT_SOURCE_CONTRACTS` entries, transcribed request-by-request from the builder files
(where the column constants live) and parity-tested against those constants. Org-conditional
`listings-raw` / `sqp-weekly` carry the degraded policy. Priority Feed + Brand View stay
derived-only (`REPORT_DERIVED_ONLY`, no DataDoe export).

---

## 8. Phase 1b review-blocker fixes (2026-08-06)

Three review blockers corrected (commits `625001f`, `4d1dd64`). `npm run verify` green;
insight declarations + Phase 1c NOT started.

**FIX 1 — Daily superset row cap is now strictly enforced.** `fetchDailyBrandSalesRows`
(api/datadoe.js) rejects any monthly ASIN/day window at the `DAILY_BRAND_ROW_LIMIT`
(50,000) cap **before appending**, with the month in the safe error, so a truncated
month can never derive/save an understated all-brand or named-brand total (the prior
snapshot is preserved by the save-on-success adapter). The contract exposes this
machine-readably: `strict: true` on every contract whose builder actually rejects at
cap (`daily-reporting:asin-day-superset`, `sku-pl:monthly-profit`, `keyword-rank:sqp-weekly`,
`keyword-rank:sqp-monthly`, `reconciliation:order-lines`, `reconciliation:settlements`)
and none that do not. Pure `rejectsAtCap(rowCount, limit)` helper for Phase 1c. Daily
stays behind its live superset-vs-compact reconciliation gate.

**FIX 2 — Keyword monthly is a typed data-dependent fallback.** `keyword-rank:sqp-monthly`
carries `dependencyMode:"fallback"`, `dependsOnRequestKey:"keyword-rank:sqp-weekly"`,
`condition:{ type:"distinct_periods_lt", value:4 }`. Pure `evaluateFallbackCondition`
+ resolver `fallbackSignals` gate it: active ONLY once weekly is evaluated (signal
present) AND weekly has < 4 distinct periods. **Token saving:** at kickoff (no signal)
monthly is not planned, so an account with sufficient weekly history spends **no** monthly
export — one fewer export/account/cycle than the previous unconditional declaration.
(Superseded by §9: a failed/terminal weekly no longer attempts monthly; only a
validated fresh/last-known-good weekly does.) Determinism + the
one-create-export-per-cycle guarantee (`unique(cycle_id, request_hash)` +
`claim_source_export_attempt`) mean repeated workers never duplicate it.

**FIX 3 — machine-readable source-failure policy.** The misleading `orgAvailability`
strings (which described the report API's HTTP 424) are replaced with structured
`availabilityPolicy { disabledSource:"terminal"|"degraded", safeCode:"SOURCE_DISABLED",
reportOutcome:"blocked"|"save-unavailable-snapshot" }` on every conditional source
(keyword weekly+monthly, content-changes events — all **terminal**). Pure
`sourceDisabledOutcome(policy)` returns `{ blocks, safeCode, reportOutcome }`; a
source-first worker branches on this, **never** on an HTTP 424 string (no contract field
contains "424"). Degraded (e.g. the future Listing Optimizer `sqp-weekly`, which the
builder degrades to a valid `sqpAvailable:false` snapshot) does not block; terminal
blocks only its own report while other reports/accounts in the cycle continue.

**Tests:** `report-source-contracts.test.mjs` = **74 assertions** (adds the strict-cap,
fallback, and structured-policy proofs). Full `npm run verify` green: 54 insight + 60
Brand View + 23 sync + 6 source-cache + 22 scheduler-v2 + 7 source-identity + 74
report-contracts + build.

**Remaining live gates:** Daily superset-vs-compact all-brand reconciliation; real
per-org SQP / content-changes / listings-raw availability (the raw disabled-source
error). Insight contract declarations + Phase 1c remain future work.

---

## 9. Phase 1b re-review corrections (2026-08-06)

Two corrections (commit `724f502`). `npm run verify` green (report-contracts now **83**
assertions); insight declarations + Phase 1c NOT started.

**Concrete resolved-job shape (`reportSourceRequestHashes` output).** Each job now
also carries immutable execution policy for Phase 1c:

```
{
  requestKey, sourceKey, sourceId, sellerOrVendorIds,   // the exact ≤5-ID chunk
  from, to, limit, options,                              // the DataDoe request
  requestHash, organizationFingerprint, accountScopeHash, requestMeta,
  strict: boolean,                                       // reject at row cap
  availabilityPolicy: null | Object.freeze({ disabledSource, safeCode, reportOutcome })
}
```

`strict` and `availabilityPolicy` are normalised copies (the policy is frozen and
detached from `REPORT_SOURCE_CONTRACTS`, so mutating a job cannot mutate the registry),
carry no HTTP-status string, and are NOT part of the DataDoe request — **`request_hash`
is unchanged** by their presence (asserted).

`normalizeAvailabilityPolicy` enforces the ONLY two consistent pairs — **terminal →
blocked**, **degraded → save-unavailable-snapshot** — and rejects a crossed pair
(`terminal + save-unavailable-snapshot` or `degraded + blocked`) that would give the
worker contradictory instructions. `sourceDisabledOutcome()` consumes the same
normaliser, so both enforce an identical invariant (a contradictory policy fails closed
in both; `null`/no-policy is treated conservatively as terminal/blocked).

**Typed, validated fallback signal.** `fallbackSignals[dependsOnRequestKey]` is now
`{ status: "success"|"last-known-good"|"failed"|"terminal", validated: boolean,
distinctPeriods: number|null }`. The prior code conflated a failed weekly (`null`) with
a zero-period success and wasted a monthly export; it no longer does. State table (for
`condition { type:"distinct_periods_lt", value:4 }`):

| Weekly signal | Monthly fallback |
|---|---|
| missing (kickoff) | not planned (weekly + catalog only) |
| validated success, 0–3 periods | **active** (one monthly job) |
| validated success, 4+ periods | not planned |
| validated last-known-good, 0–3 | **active** |
| validated last-known-good, 4+ | not planned |
| failed, no validated last-known-good | not planned (prior report preserved) |
| terminal / disabled | not planned; weekly `availabilityPolicy` blocks Keyword Rank |
| unvalidated (validated:false) | not planned |
| malformed signal / unsupported condition / invalid threshold or periods | **throws** a safe configuration error (fails closed) |

Determinism, one-create-export-per-cycle (`unique(cycle_id, request_hash)` +
`claim_source_export_attempt`), five-ID batching and primary/dd-secondary isolation are
unchanged and re-tested.

---

## 10. Insight source contracts declared + parity-tested (2026-08-06)

The six insight reports classified in §7 are now formal `REPORT_SOURCE_CONTRACTS`
entries, transcribed request-by-request from the executable builders and parity-tested
against the builder constants (columns/groupBy/aggregations read out of
`lib/server/reports/*.js`, not documentation). Commits `8750c20` (Sales Movers / Buy
Box / Returns) and `056dcf0` (Listing Health / PPC / Listing Optimizer). `npm run
verify` green (301 assertions); `request_hash` golden literal unchanged; Phase 1c NOT
started; no push / deploy / migration.

### 10.1 Full source dependency table (from executable code)

Every request: source key · columns constant · limit (`ROW_LIMITS`) · groupBy/agg ·
order · window · strict · policy. All fetch through `fetchExportRowsStrict` (generic
`rows.length >= limit` guard, `lib/server/datadoe.js`) **except** the Sales Movers
latest-date probe (a date rollup that never nears its 500 cap).

| requestKey | source | columns · limit · order | grouped? | window | strict | policy |
|---|---|---|---|---|---|---|
| `sales-movers:sales-latest-probe` | sales-traffic-asin-date | `["date"]` · 500 · date/ASC | groupBy date, sum total_units | asOf−25d..asOf | no | — |
| `sales-movers:traffic` | sales-traffic-asin-date | TRAFFIC_COLUMNS(2) · 50000 · child_asin/ASC | groupBy + 7 sums | recent + prior 7d | yes | — |
| `sales-movers:ads` | profit-by-sku-date | ADS_COLUMNS(2) · 50000 · child_asin/ASC | groupBy + 3 sums | recent + prior 7d | yes | — |
| `sales-movers:inventory` | fba-inventory-health | INVENTORY_COLUMNS(16) · 15000 · date/DESC | raw | asOf−10d..asOf | yes | — |
| `sales-movers:catalog` | product-catalog | CATALOG_COLUMNS(4) · 20000 · child_asin/ASC | raw | no-date | yes | — |
| `buy-box-loss:daily` | profit-by-sku-date | DAILY_COLUMNS(10) · 50000 · date/ASC | raw | 4×7d slices (asOf−27d..asOf) | yes | — |
| `buy-box-loss:inventory` | fba-inventory-health | INVENTORY_COLUMNS(16) · 15000 · date/DESC | raw | asOf−10d..asOf | yes | — |
| `buy-box-loss:catalog` | product-catalog | CATALOG_COLUMNS(4) · 20000 · child_asin/ASC | raw | no-date | yes | — |
| `returns-leakage:returns` | returns | RETURN_COLUMNS(10) · 50000 · date/DESC | raw | asOf−59d..asOf | yes | — |
| `returns-leakage:settlements` | settlements | SETTLEMENT_GROUP_BY(4) · 50000 · sku/ASC | groupBy + 9 sums | asOf−59d..asOf | yes | — |
| `returns-leakage:traffic` | sales-traffic-asin-date | TRAFFIC_GROUP_BY(2) · 50000 · child_asin/ASC | groupBy + 4 sums | asOf−59d..asOf | yes | — |
| `returns-leakage:catalog` | product-catalog | CATALOG_COLUMNS(4) · 20000 · child_asin/ASC | raw | no-date | yes | — |
| `listing-health:listings` | listings | LISTING_COLUMNS(13) · 20000 · child_asin/ASC | raw | no-date | yes | — |
| `listing-health:listings-raw` | listings-raw | LISTING_RAW_COLUMNS(6) · 20000 · child_asin/ASC | raw | no-date | yes | **degraded** |
| `listing-health:sales` | profit-by-sku-date | SALES_COLUMNS(3) · 50000 · sku/ASC | groupBy + 3 sums | asOf−29d..asOf | yes | — |
| `listing-health:inventory` | fba-inventory-health | INVENTORY_COLUMNS(16) · 15000 · date/DESC | raw | asOf−10d..asOf | yes | — |
| `listing-health:catalog` | product-catalog | CATALOG_COLUMNS(4) · 20000 · child_asin/ASC | raw | no-date | yes | — |
| `ppc-performance:total-sales` | sales-traffic-asin-date | `["date"]` · 500 · date/ASC | groupBy date + 2 sums | asOf−29d..asOf | yes | — |
| `ppc-performance:catalog` | product-catalog | CATALOG_COLUMNS(4) · 20000 · child_asin/ASC | raw | no-date | yes | — |
| `listing-optimizer:sqp-weekly` | sqp-weekly | OPT SQP_COLUMNS(15) · 50000 · date/ASC | raw | asOf−84d..asOf | yes | **degraded** |
| `listing-optimizer:catalog` | product-catalog | OPT CATALOG_COLUMNS(13) · 20000 · child_asin/ASC | raw | no-date | yes | — |

### 10.2 Shared identities (deduplicate) and identities that intentionally do NOT

- **Common Product Catalog** — one `product-catalog` identity (CATALOG_COLUMNS(4),
  no-date, 20000, child_asin/ASC) shared by **five** reports: Sales Movers, Buy Box,
  Returns, Listing Health, PPC. One export per account, not five.
- **Common FBA Inventory** — one `fba-inventory-health` identity (INVENTORY_COLUMNS(16),
  asOf−10d..asOf, 15000, date/DESC) shared by **three**: Sales Movers, Buy Box, Listing
  Health. One export per account, not three.
- **Do NOT share (same source, different identity):**
  - Sales Movers `traffic` (7 sums, 7-day) vs Returns `traffic` (4 sums, 60-day) — same
    `sales-traffic-asin-date` source, different columns/aggregations/window.
  - PPC `total-sales` (500 date rollup) vs Sales Movers `sales-latest-probe` (1 sum) vs
    the traffic aggregates — all `sales-traffic-asin-date`, all distinct identities.
  - **Listing Optimizer's catalog** (13 richer content columns) ≠ the common catalog;
    **its SQP** (15 columns) ≠ Keyword Rank's SQP — proven by distinct `request_hash`
    at an identical account scope + window.

### 10.3 Derived Supabase dependencies (zero DataDoe exports)

- **PPC advertising** — all campaign/ASIN/target/search-term figures come from persisted
  `ads_daily_source_rows` (four scheduled Ads sources, `REPORT_DERIVED_SOURCE_KEYS`).
  PPC's only owned exports are `total-sales` + `catalog`. Opening/refreshing PPC never
  runs an Ads export.
- **Priority Feed** and **Brand View** are `REPORT_DERIVED_ONLY`: they own zero source
  contracts (Priority Feed reads the six insight outputs; Brand View reads brand-sales
  rows + persisted Ads + fba-plan). A dependency-map test proves every sidebar report is
  covered exactly one way — scheduler-declared **or** derived-only, never unaudited.

### 10.4 Disabled-source behavior

- **Terminal → blocked** (unchanged): Keyword Rank SQP, Content Changes events.
- **Degraded → save-unavailable-snapshot** (new): `listing-health:listings-raw` (optional
  listing-issues enrichment → `issuesAvailable:false`) and `listing-optimizer:sqp-weekly`
  (→ a valid `sqpAvailable:false` snapshot). A degraded source never blocks the cycle;
  `sourceDisabledOutcome(policy).blocks === false`. Both carry the structured policy
  `{disabledSource:"degraded", safeCode:"SOURCE_DISABLED", reportOutcome:"save-unavailable-snapshot"}`
  — no HTTP status strings — and it survives onto the resolved job frozen.

### 10.5 Strict row-cap behavior

Every insight request except the Sales Movers probe is `strict:true`, backed by
`fetchExportRowsStrict` which throws on `rows.length >= limit` rather than returning a
truncated page. The strict-backing test proves the exact strict set and that each strict
insight request is issued through that guard (or through `common.js` for the shared
catalog/inventory helpers).

### 10.6 Estimated export savings (per account, per cycle)

Naïve per-report fetching would issue **6 catalog** + **3 inventory** exports across the
six insight reports; dedup collapses these to **1 catalog + 1 inventory**. PPC issues
**0** Ads exports (four Ads sources fully derived) and **1** small date-rollup instead.
Net: **7 redundant catalog/inventory exports removed per account per cycle**, plus the
entire Ads-export path eliminated for PPC — before counting the five-ID batching that
already collapses multi-account scopes.

### 10.7 Unresolved live assumptions (must gate Phase 1c)

- The `listings-raw` / `sqp-weekly` degraded paths are asserted from builder logic; a live
  per-org probe must confirm a disabled table returns the documented `isSourceDisabledError`
  (not a silent empty page) before enabling those sources in the scheduler.
- PPC has **no export fallback** for stale Ads history — confirm the scheduled Ads worker
  keeps `ads_daily_source_rows` fresh per account before PPC is enabled.
- Window derivations (probe lookback, 7-day slices, 84-day SQP) are transcribed from the
  builders but not yet reconciled against a live DataDoe response in this workspace.

---

## 11. Staged dependencies + generic failure policy (2026-08-06)

Codex's insight-contract review approved the request shapes/batching/isolation/dedup but
withheld Phase 1b for three execution-policy gaps. Fixed on `feature/scheduler-v2`
(commit `476f62f`); nothing pushed/merged/deployed/migrated; Phase 1c NOT started;
`request_hash` unchanged (all new metadata is outside `sourceRequestIdentity`).

One reusable typed layer, added to `report-source-contracts.js` (all helpers fail closed
on malformed input and return frozen objects detached from the registry):

- **Staged dependency** — `validateStagedSignal` + `evaluateStagedActivation`. A staged
  downstream job activates only when its primary's typed signal
  `{status, validated, latestReportedDate?}` proves a **fresh** `validated` `success`
  (and, where `requireReportedDate`, a real ISO date). `salesMoversWindows(date)` derives
  the recent/prior 7-day weeks from the validated date — never the calendar.
- **Ads-currency gate** — `validateAdsCurrencySignal` + `evaluateAdsCurrencyGate`. Reads a
  typed `{status, validated, currencyCount}` signal derived from persisted
  `ads_daily_source_rows`.
- **Generic failure policy** — `normalizeFailurePolicy`, DISTINCT from `availabilityPolicy`
  (which stays disabled-source-only). Governs any export/save failure — DataDoe error,
  timeout, HTTP 4xx/5xx, a strict row-cap/truncation, or a Supabase source-save error —
  as typed `causes`; a `degrade` policy sets `blocks:false` and `neverPartial:true` and
  carries an admin-safe `safeCode` (never a parsed HTTP string).

The resolver takes `dependencySignals` (`fallbackSignals` kept as the legacy alias),
gates staged/currency contracts in `applies()`, and attaches immutable `failurePolicy`
and a `dependency` descriptor `{mode, dependsOn, requiredSignalStatus, signalStatus,
validated, latestReportedDate}` to each resolved job.

### 11.1 Sales Movers — probe → downstream (FIX 1)

`traffic`, `ads`, `inventory`, `catalog` are `dependencyMode:"staged"` on
`sales-movers:sales-latest-probe` (`activation: validated_success, requireReportedDate`).

| Probe signal this cycle | Downstream planned? | Outcome |
|---|---|---|
| absent (kickoff) | no | plan the probe only |
| `success, validated, date` | **yes** | derive recent/prior weeks from the date; plan traffic/ads/inventory/catalog |
| `success, validated, date=null` | no | honest "data unavailable" Sales Movers snapshot |
| `failed` / `terminal` | no | preserve previous successful report |
| `success, validated:false` (unvalidated) | no | preserve previous report |
| `last-known-good` | no | conservative — no new exports, does not pretend the probe succeeded |
| malformed status / bad date / missing required date | **throws** | fail closed |

### 11.2 Listing Optimizer — SQP → catalog (FIX 2)

`listing-optimizer:catalog` is `dependencyMode:"staged"` on `listing-optimizer:sqp-weekly`
(`activation: validated_success`, no `requireReportedDate`).

| SQP signal | Catalog planned? | Outcome |
|---|---|---|
| absent (kickoff) | no | plan SQP only |
| `success, validated` (incl. **zero rows**) | **yes** | activate the rich catalog |
| disabled SQP (`terminal`) | no | save `sqpAvailable:false`; **no catalog export spent** |
| `failed` / unvalidated / `last-known-good` | no | no catalog export |
| malformed | **throws** | fail closed |

### 11.3 PPC — currency gate + failure policy (FIX 3)

`ppc-performance:total-sales` is `dependencyMode:"ads-currency-gate"` on the
`ppc-performance:ads-currency` signal and carries
`failurePolicy {onFailure:"degrade", degradedScope:"tacos-denominator", safeCode:"TOTAL_SALES_UNAVAILABLE"}`.
`ppc-performance:catalog` stays independently required and ungated (it enriches ASIN
rows even when TACoS is unavailable).

| Ads-currency signal | total-sales planned? | catalog | Notes |
|---|---|---|---|
| `validated, currencyCount 0` | **yes** | yes | matches the builder |
| `validated, currencyCount 1` | **yes** | yes | |
| `validated, currencyCount > 1` | no | yes | TACoS unavailable BY DESIGN, not an error |
| absent | no | yes | safe: not scheduled |
| `validated:false` | no | yes | fail closed |
| malformed (`currencyCount -1`, bad status) | **throws** | — | fail closed |

**total-sales failure handling:** any failure (incl. a strict row-cap) degrades ONLY the
TACoS denominator — the rest of PPC is derived and saved; a capped/partial result is a
failure, never saved as data (`neverPartial:true`). The policy is frozen on the resolved
job and never blocks the report (`blocks:false`).

### 11.4 Invariants preserved

Execution metadata (`failurePolicy`, `dependency`, `strict`, `availabilityPolicy`) is
outside `sourceRequestIdentity`, so the golden `request_hash`
`5601253219be13c7…` and all dedup groups are unchanged. Five-ID batching,
primary/dd-secondary isolation, one-create-export-per-cycle, last-known-good
preservation, and no-auto-retry all hold. A staged/gated job that does not activate
consumes no export and preserves the prior report snapshot.

---

## 12. Staged-policy re-review corrections (2026-08-06)

Three fail-closed corrections from Codex's staged-policy re-review; on
`feature/scheduler-v2` (commit `f398d12`). Nothing pushed/merged/deployed/migrated;
Phase 1c NOT started; `request_hash` unchanged (metadata is still outside
`sourceRequestIdentity`, and valid requests keep byte-identical hashes).

### 12.1 Sales Movers windows are bound to the validated probe date (FIX 1)

The recent/prior 7-day windows are DERIVED FACTS of the validated probe date, not caller
inputs. The resolver now, when the probe has activated downstream, requires
`sales-movers:traffic` and `sales-movers:ads` to equal EXACTLY the
`salesMoversWindows(latestReportedDate)` pair `[recent, prior]` (same order). Any
mismatched, missing, duplicated, extra, reordered, or invalid window is rejected — a
Phase 1c caller cannot drift them, and it need not "remember" to call the helper because
the resolver enforces the bind. A probe date of `2025-07-30` rejects arbitrary windows
such as `1999-01-01..1999-01-07`. `sales-movers:inventory` (as-of `asOf-10d..asOf`) and
`sales-movers:catalog` (no-date) are left untouched; correct windows keep their hashes.

### 12.2 Strict UTC calendar-date validation (FIX 2)

`isValidCalendarDate(value)` requires the `YYYY-MM-DD` shape AND round-trips the value
through `Date.UTC` + `toISOString()`, so an impossible date that would silently normalize
(`2025-02-30 → 2025-03-02`, `2025-99-99`, `0000-00-00`, a non-leap `2023-02-29`) is
rejected, while a real leap day (`2024-02-29`) is accepted. It backs `validateStagedSignal`
and `salesMoversWindows`. For Sales Movers the validated `latestReportedDate` must also
fall INSIDE the actual `sales-movers:sales-latest-probe` window (boundaries inclusive)
before any downstream job activates — a date before `probe.from` or after `probe.to`
fails closed.

### 12.3 Complete safeCode HTTP-status rejection (FIX 3)

`normalizeFailurePolicy` now rejects EVERY standalone 4xx/5xx number (`400`–`599`) in
`safeCode` via `/(?<!\d)[45]\d\d(?!\d)/` — the earlier regex missed `400/401/403/409/422`
and others. Symbolic codes with no 3-digit 4xx/5xx run (e.g. `TOTAL_SALES_UNAVAILABLE`)
remain allowed, and a longer number (`12500`) is not misread as a status. Operational
behavior is still driven only by the typed `causes`, never parsed from message text.

### 12.4 Invariants re-confirmed

Golden `request_hash` `5601253219be13c7…` unchanged; five-ID batching and
primary/dd-secondary isolation unchanged; dedup groups unchanged.
`report-source-contracts.test.mjs` = **155 assertions**; full `npm run verify` green
(**327**); `git diff --check` clean.

---

## 13. Phase 1c — source-job worker (SHADOW MODE, 2026-08-06)

The checkpointable, idempotent source half of a cycle. SHADOW MODE: not wired to any
route/cron and it does not replace Scheduler v1 (`run-sync.js`); the pg_cron/Vercel
kickoff and the production `resolvePlan` (registry → accounts → windows) are deliberately
left for a later step. Commits `77c87d3` / `7c53045` / `68f1a9c`. Nothing pushed,
merged, deployed, or migrated; Phase 1d (report derivation) not started.

### 13.1 Modules (all I/O injected → deterministic, offline-testable)

- `lib/server/sync/source-signals.js` — typed dependency signals from VALIDATED saved
  results only (never the browser): probe `{status,validated,latestReportedDate}`,
  keyword weekly `{…,distinctPeriods}`, optimizer SQP `{status,validated}`, PPC ads
  currency `{…,currencyCount}` (from persisted `ads_daily_source_rows`).
- `lib/server/sync/source-worker.js` — `runSourceJobs()`; the lifecycle below.
- `lib/server/sync/source-sync-driver.js` — `makeSupabaseSourceStore` / `makeDataDoeFetcher`
  / `runStagedSourceCycle`; the shadow composition + staged loop.
- `lib/server/supabase.js` — service-role wrappers for the 3 tables + 3 RPCs.

### 13.2 Worker / checkpoint flow (per invocation)

1. `open_sync_cycle(bucket, cycle_date)` → the one cycle id (idempotent).
2. `claim_sync_cycle(id)` → the first worker stamps `started_at`; a finished cycle is a
   no-op. Later invocations proceed (per-job guards handle concurrency).
3. Upsert each canonical job once (`unique(cycle_id, request_hash)`, ignore-duplicates).
4. For each still-`pending` job, bounded by `maxJobs` and a wall-clock deadline:
   a. `claim_source_export_attempt(id, request_hash)` — the durable one-attempt guard.
      Lose it → create nothing (skip). Win it → exactly one create-export.
   b. `fetchSource(job)` (create → poll → download via the injected DataDoe fetcher).
   c. VALIDATE: a strict job at/above its row cap → `validate`/`TRUNCATED`, terminal,
      NOT saved.
   d. PERSIST: save rows to `source_export_cache`; a save error is a SEPARATE
      `persist`/`SAVE_FAILED` stage.
   e. On success → `succeeded` + `last_good_fetched_at`. On any failure → `failed` with a
      SAFE `{stage,code,message}`; `cache_object_path`/`last_good_fetched_at` are never
      cleared (last-known-good survives).
5. Stop at the deadline (`deadlineReached`) or when the pending list drains; return
   progress with NO secret.

### 13.3 Database operations used

`open_sync_cycle`, `claim_sync_cycle`, `claim_source_export_attempt` (RPCs);
`sync_cycles` counts PATCH; `sync_source_jobs` insert-if-absent / list / success+failure
PATCH; `source_export_cache` save. All service-role; RLS keeps reads admin-only.

### 13.4 One-attempt & isolation evidence

`claim_source_export_attempt` is a single guarded `UPDATE … WHERE attempted_at IS NULL`
returning `FOUND` — one winner per (cycle, request_hash) across separate serverless
invocations, backstopped by the `one_attempt` CHECK. Five-ID chunks and primary vs
dd-secondary orgs have distinct `request_hash`es → distinct jobs → distinct exports; the
worker never mixes them.

### 13.5 Dependency-signal & failure/last-known-good evidence

Signals are computed from the worker's own validated rows and fed back into the approved
`reportSourceRequestHashes` (Sales Movers downstream uses the validated probe date;
Optimizer catalog waits for a validated SQP success; Keyword monthly follows the
distinct-period policy; PPC total-sales respects the ads-currency count). A
failed/terminal/timed-out/save-failed job is not retried in the same cycle, saves no
empty/partial/truncated data, and preserves the prior source rows and report snapshot.

### 13.6 Tests / invariants

`scheduler-v2.test.mjs` = **40 assertions** (in-memory store modelling the RPCs). Full
`npm run verify` green (**345**); `git diff --check` clean. Golden `request_hash`,
five-ID batching, and primary/dd-secondary isolation unchanged.

### 13.7 Unresolved live gates (before enabling)

pg_cron/Vercel kickoff + production `resolvePlan` wiring are not built; a live cycle
against real DataDoe/Supabase (create/poll/download timing, disabled-source classification,
Storage save) is Codex's separate gate. Report derivation is Phase 1d.

---

## 14. Phase 1c review corrections (FIX 1-7, 2026-08-06)

Commits `3de9f7a` (atomic cache + org fingerprint + sync helpers) and `8a8f9a7`
(resumable worker + driver + test split). SHADOW MODE, Scheduler v1 / frontend / manual
refresh untouched; not pushed/merged/deployed/migrated.

- **FIX 1** — the worker rebuilds the full canonical job from the plan by request_hash
  (fetchParams/requestKey/policies); the production `sync_source_jobs` row is authoritative
  only for fetch_status/attempted_at/export_id/connection. No-plan job fails closed.
- **FIX 2** — `makeDataDoeAdapter` fail-closed routing: explicit valid `connection_id`, the
  connection must exist, `organizationFingerprint` must match; missing/unknown/mismatched
  throws before any DataDoe call; a secondary job never uses the primary key.
- **FIX 3** — resumable state machine: claim → createExport once → **persist export_id
  immediately** → poll → download → validate → save → success. `attempted`+export_id
  resumes without re-create; `attempted` with no id → `CREATE_INTERRUPTED`. Distinct safe
  stages (create-export/poll/download/validate/persist); `withDataDoeDeadline` wraps work.
- **FIX 4** — `reconstructSignals` rebuilds typed signals from persisted successful jobs +
  saved payloads (+ persisted ads rows) each invocation; a fresh process plans downstream
  without repeating a primary export; failed/terminal/unvalidated primaries activate nothing.
- **FIX 5** — `atomicSaveSourcePayload`: immutable versioned object, pointer switched only
  after upload, old pruned only after commit; a pointer failure deletes the new orphan and
  preserves the old readable payload. Non-array payload rejected; success requires a
  non-empty object path.
- **FIX 6** — source counts recomputed from ALL persisted jobs (never decrease).
- **FIX 7** — root cause: TOP-LEVEL AWAIT made the test an async module that hangs
  `node --check`/piped runs. Phase 1c async tests moved to `scheduler-v2-worker.test.mjs`
  (async `main()`, deterministic exit, no TLA); `scheduler-v2.test.mjs` restored to pure
  sync; `test:scheduler-v2` runs both. No handle keeps Node alive.

Tests: sync 22 + worker 23; full `npm run verify` green (**350**); `node --check` on every
changed file exits 0; `git diff --check` clean; golden `request_hash` and five-ID batching
unchanged; shared v1 `saveSourceExportCache` untouched.

---

## 15. Phase 1c correction re-review blockers (2026-08-07)

Commits `1d273d2` (LF `.gitattributes`) + `887136d` (blockers 1-4 code + tests). SHADOW
MODE; Scheduler v1 / frontend / manual refresh untouched; not pushed/merged/deployed/migrated.

- **Blocker 1 — fail-closed org routing.** Removed every `|| "primary"` default in
  Scheduler v2. `plannedSourceJob` and `upsertSyncSourceJob` REQUIRE an explicit
  `primary`/`dd-secondary` id and a non-empty `organizationFingerprint`. The adapter's
  `resolveConnection` requires a non-empty fingerprint and compares it UNCONDITIONALLY to
  the selected connection before create/poll/download; missing/unknown/mismatched and a
  missing secondary key throw with zero DataDoe calls.
- **Blocker 2 — cache-aware signal reconstruction.** `reconstructSignals` only treats a
  cleanly loaded array (including `[]`) as a validated success; a miss/read-error/non-array
  payload is a non-activating `source-cache-unavailable` signal; a failed ads read yields
  `currencyCount:null`.
- **Blocker 3 — resumable deadline.** An execution-deadline `DataDoeDeadlineError` after
  `export_id` is saved defers (job stays `attempted` + `export_id`, nothing recorded) so
  the next bounded invocation resumes poll/download with no second create. Genuine DataDoe
  processing timeouts/failures remain failed. `deriveSignalsFromOutcomes` skips deferred.
- **Blocker 4 — ambiguity-safe atomic cache.** `atomicSaveSourcePayload` never deletes the
  newly uploaded object on a throwing/ambiguous pointer write (Postgres may have committed).
  It reads the pointer back; prunes the OLD object ONLY after a positively confirmed switch;
  an unconfirmed write throws (persist failure) leaving the new orphan + old readable; a
  concurrent winner is observed and preserved.
- **Blocker 5 — Windows read/`node --check` hang.** `.gitattributes` forces LF on checkout
  for source/test files; `scheduler-v2-worker.test.mjs` rewritten with short ASCII/LF lines
  and no top-level await. `node --check` on both test files exits 0; both runs +
  `npm run verify` complete.

Tests: sync 22 + worker 27; full `npm run verify` green (**354**); `node --check` on every
changed file exits 0; `git diff --check` clean; golden `request_hash` and five-ID batching
unchanged; shared v1 `saveSourceExportCache` untouched.

---

## 16. Phase 1c second-correction re-review fixes (2026-08-07)

SHADOW MODE; Scheduler v1 / frontend / manual refresh / `feature/design-system` untouched;
not pushed/merged/deployed and no migration applied.

- **Fix 1 — worker test readability blocker, resolved by a genuinely fresh artifact.** The
  earlier `scheduler-v2-worker.test.mjs` remained unreadable on the review machine even with
  the LF `.gitattributes` policy. Root cause of the review symptom: PowerShell
  `[System.IO.File]::ReadAllBytes()` blocks on files in that sandbox (it hangs on the
  known-good `scheduler-v2.test.mjs` too), i.e. an environment/AV artifact of the .NET file
  API, not the bytes. Rather than argue the environment, the file was **replaced with a new
  filename and fresh bytes**: `scripts/scheduler-v2-source-worker.test.mjs`, written 7-bit
  ASCII (highBytes=0), LF-only (CR=0), no BOM, no top-level await. The old artifact was
  `git rm`-removed. `package.json` `test:scheduler-v2` now runs
  `scheduler-v2.test.mjs && scheduler-v2-source-worker.test.mjs && scheduler-v2-supabase-wrapper.test.mjs`.
  A normal file read (Read tool / `fs.readFileSync`), both `node --check` commands, the
  focused suite, and full `npm run verify` all complete from this checkout.
- **Fix 2 — concurrent source-cache publication is now self-consistent.**
  `atomicSaveSourcePayload` previously returned a concurrent writer's object path as this
  attempt's success while the worker kept recording its OWN rows/row-count — pairing one
  payload's rows/count with another payload's path. It now returns a self-consistent result
  `{ objectPath, rows, rowCount, payloadBytes, winner }`. When read-back shows a DIFFERENT
  winner it **adopts** that winner: loads and validates the winner's object and returns the
  WINNER's rows, row count, bytes and path. If the winner cannot be read/validated it throws
  a typed `SourceCachePointerConflictError` (`code: "CACHE_CONFLICT"`), preserving BOTH
  immutable objects. The worker records the winner's rows/count/path on adoption, or a
  benign NON-terminal `persist`/`CACHE_CONFLICT` non-success on an un-adoptable conflict
  (no path recorded, previous last-known-good preserved). Concurrency tests use visibly
  different row sets and row counts (winner 3 rows vs this attempt's 1).
- **Fix 3 — durable job upsert enforces the fingerprint handoff invariant.**
  `upsertSyncSourceJob` now REQUIRES a non-empty `organizationFingerprint` and rejects
  BEFORE any PostgREST request — so a fingerprint-less job is never written (and never as an
  empty string) and never reaches the one-attempt claim (`claim_source_export_attempt`) or
  the DataDoe adapter that key routing off that row. A production-wrapper test drives the
  REAL `lib/server/supabase.js` with a fetch spy: an empty/missing fingerprint rejects with
  ZERO PostgREST calls; a well-formed job is the positive control that reaches exactly one
  `sync_source_jobs` insert; the claim RPC is proven reachable only when invoked directly.

Tests: sync 22 + source-worker 30 + supabase-wrapper 4 (**56** in `test:scheduler-v2`); full
`npm run verify` green (**361** assertions) plus the production `build:check`; `node --check`
on every changed/added file exits 0; golden `request_hash`, five-ID batching, and shared v1
`saveSourceExportCache` all unchanged.

---

## 17. Phase 1c third-correction: single-file test packaging (2026-08-07)

The approved production fixes (sections 15-16) are unchanged. The remaining blocker was
purely a test-artifact issue: the two new files `scheduler-v2-source-worker.test.mjs` and
`scheduler-v2-supabase-wrapper.test.mjs` blocked before Node could parse them in the Codex
worktree. This correction consolidates the packaging only — NO source, Scheduler v1,
frontend, or scheduler-logic change.

- **All 56 assertions now live in the already-readable `scripts/scheduler-v2.test.mjs`.**
  The 22 planner/SQL/model tests are unchanged; the 30 worker/signal/atomic-cache tests and
  the 4 production Supabase-wrapper tests were merged in verbatim (same assertions, no
  weakening of concurrency, routing, deadline-resume, cache-adoption, or PostgREST-guard
  coverage). Both split files were removed from Git and the worktree.
- **`package.json` `test:scheduler-v2` now runs only `node scripts/scheduler-v2.test.mjs`.**
- **Single-file structure keeps it reproducible.** No top-level await (async suite runs in
  `main()`). Only env/IO-free modules are static imports (assert, node builtins,
  `registry.js`, `planner.js`); every module that transitively imports `supabase.js`
  (`source-worker` -> `datadoe` -> `supabase`, and `source-sync-driver`) is loaded
  DYNAMICALLY inside `main()` AFTER a dummy Supabase env is set at the top of the file, so
  the production-wrapper tests' `requireConfiguration()` positive control reaches the fetch
  boundary. The production `claimSourceExportAttempt` wrapper is imported under an alias to
  avoid colliding with the pure claim MODEL used by the SQL-invariant tests. Every byte is
  7-bit ASCII (highBytes=0), LF-only (CR=0), no BOM.
- **Root cause of the review symptom is environmental, not the bytes.** In this Windows
  sandbox, PowerShell file reads (`Get-Content`, `[System.IO.File]::ReadAllBytes`) block on
  ANY file under the project directory while a trivial `Write-Output` runs instantly and the
  SAME bytes copied to `%TEMP%` are read by `Get-Content -TotalCount 5` immediately — an
  antivirus / Controlled-Folder-Access artifact tied to the project path. `node --check`,
  `fs.readFileSync`, and the full suite all read the file fine.

Proof from the exact worktree: `node --check scripts/scheduler-v2.test.mjs` exits 0;
`npm run test:scheduler-v2` = **56** assertions, exit 0; `npm run verify` green (**361**
assertions across all suites) plus `build:check`; `git diff --check` clean. Both removed test
paths are absent from the worktree, `git ls-files`, and `git ls-tree -r HEAD`.

---

## 18. Phase 1c: test harness silent-hang diagnosis + fix (2026-08-07)

The consolidated file passed `node --check` but executed with zero output and appeared to
hang in the reviewer's worktree. Instrumentation (this correction) diagnoses and fixes the
harness only — NO production, Scheduler v1, frontend, or scheduler-logic change (the active-
handle dump below proved there was no real module-import defect to fix).

- **Instrumentation added.** A synchronous `mark()` (stderr) / `out()` (stdout) pair built on
  `fs.writeSync` replaces `console.log`/`console.error`. Markers bracket: module-body eval,
  `before main()`, the start/finish of every one of the 7 dynamic imports, each of the 6
  major test-group boundaries, the end of the test loop, and — right before the NATURAL exit
  — a dump of `process.getActiveResourcesInfo()`.
- **Diagnosis from the exact worktree.** Every dynamic import resolves in <=~55ms with no
  block; all 56 tests run; the loop completes; and the active-resource dump prints `[]` — the
  event loop is empty and the process exits naturally with code 0 (no `process.exit()`, no
  forced timeout). So there is no unresolved promise, timer, socket, AsyncLocalStorage, or
  server handle. `withDataDoeDeadline` is pure `AsyncLocalStorage.run` (no timer), and with
  the default `Infinity` deadline `remainingDeadlineMs()` returns `null`, so no deadline
  timer is ever created; `ddFetch`'s abort timer is cleared in a `finally` and is never
  exercised by the in-memory fakes.
- **Root cause of the silent hang.** The old runner did all imports first, then wrote results
  with async `console.log`. When stdout is an npm pipe, Node's asynchronous stdout buffer can
  be dropped if the process is killed before it flushes — so a run that was actually
  progressing (or a fast exit) surfaced as ZERO output. Switching every marker/result to
  synchronous `fs.writeSync` makes output land the instant it executes, so progress is always
  visible and a true block would be pinpointed to the exact import/group.

Proof from the exact worktree (all emit output promptly, exit 0, terminate naturally):
`node --check scripts/scheduler-v2.test.mjs` exits 0; `node scripts/scheduler-v2.test.mjs`
streams markers + **56** assertions, `active resources: []`, exit 0; `npm run test:scheduler-v2`
exit 0; `npm run verify` green (**361** assertions) + `build:check`; `git diff --check` clean.

---

## 19. Phase 1c: the REAL block was a secret-shaped literal, not stdout buffering (2026-08-07)

Section 18's stdout-buffer root cause is **superseded**. The synchronous markers were still
worth keeping (a true block now pinpoints itself), but they did not fix the reviewer's
failure. The actual cause is an **antivirus / endpoint-security content signature**: the
consolidated test contained a leaked-credentials query string literal
(`apikey=<value> token=<value>`) in the "no secret value appears" test, which Windows
Defender flags — quarantining/scanning the file and blocking it from being **read or copied
before Node can evaluate it** (hence zero output, even outside the sandbox and with
unsandboxed permissions). Test-artifact-only fix; no production change.

- **Reproduced + bisected.** `Copy-Item` of the source hung with empty output (blocked on the
  source read). On TEMP copies: neutralizing ONLY the `apikey=/token=` string made the file
  read reliably; the all-neutralized copy read; the untouched original was blocked/flaky. The
  minimal trigger is that leaked-key fixture; `test-service-role-key` and the `*_ORG_KEY`
  api-key values are on the same secret-shaped list.
- **Fix (per the reviewer):** assemble every sensitive-looking value at RUNTIME from harmless
  fragments (`frag()`/`dash()` join helpers) so no complete secret-shaped literal exists in
  the bytes — the leaked query string (fragments + a runtime-built `RegExp`), the Supabase
  placeholder key, and the two API-key placeholders. Comments reworded to avoid
  credential-shaped text. The security assertions are unchanged in intent; all 56 kept.
- **Content proven clean.** Exhaustive scan: no hex/JWT/Bearer/Authorization/`key=value`/
  PRIVATE-KEY sequences. Identical fixed bytes copy+read via PowerShell in ~42ms from `%TEMP%`
  and ~123ms at a fresh project-dir filename; `package.json` in the same dir reads fine.
- **Local caveat:** this machine's Defender keeps quarantine state on the specific filename
  `scheduler-v2.test.mjs` from the earlier secret-laden versions, so the in-place `Copy-Item`
  still hangs here (a same-bytes copy under any other name reads fine). A fresh Codex checkout
  has no such history and reads the clean file normally. Clearing local state needs Defender
  admin and is deliberately out of scope.

Proof (node/bash path): `node --check` exit 0; `node scripts/scheduler-v2.test.mjs` = **56**
assertions, `active resources []`, exit 0; `npm run test:scheduler-v2` exit 0; `npm run verify`
green (**361** assertions) + `build:check`; `git diff --check` clean.

---

## 20. Phase 1c: verification suite renamed to a never-used path (2026-08-07)

Final test-artifact correction. The content was already clean (section 19); the old filename
had accrued a filename-specific local Defender quarantine from earlier, genuinely
secret-laden revisions, so the suite is moved to a fresh path. Rename only -- no production,
Scheduler v1, frontend, source-contract, request-hashing, migration, or report change
(`git diff --stat 142c43d HEAD` = 2 files: `package.json` + the renamed test, R099).

- `scripts/scheduler-v2.test.mjs` -> **`scripts/scheduler-v2-verification.test.mjs`**
  (`git mv`, then rewritten to a fresh inode so it does not inherit the old file's local
  quarantine). Old path removed from Git and the worktree; never read or recreated. Only the
  "Run with" comment changed; all **56** assertions preserved exactly; natural termination
  kept; no `process.exit()`/timeouts/shortcuts.
- `package.json` `test:scheduler-v2` runs only
  `node scripts/scheduler-v2-verification.test.mjs`.

Verification (deterministic): old path absent from the worktree (`fs.existsSync`=false),
`git ls-files`, and `git ls-tree -r HEAD`; new path present + readable (first 5 lines via
node; fresh TEMP copy readable); `node --check` exit 0; the direct test = **56** assertions,
`active resources []`, natural exit 0; `npm run test:scheduler-v2` exit 0; `npm run verify`
green, sum **361** (54+60+23+6+**56**+7+155) + `build:check`; `git diff --check` clean.

Local caveat: on this machine, PowerShell `Test-Path`/`Get-Content`/`Copy-Item` against the
freshly-written project-dir file hang under Defender's on-access scan (trivial PowerShell,
node, and git all succeed; the same bytes read fine once the scan settles). This is an
environmental scan artifact, not a file defect; a fresh Codex checkout has no such state, so
the PowerShell proofs will pass there.

---

## 21. Phase 1d -- report-derivation foundation (SHADOW MODE, 2026-08-07)

The report half of a cycle: derive report snapshots PURELY from already-saved canonical
source rows (`source_export_cache`) with **zero DataDoe exports**. Commits `0541976` (impl),
`bbaed0c` (tests), `54955fd` (fba map fix). SHADOW MODE -- not wired to any route/cron, does
not change what pages read; Scheduler v1 / frontend / manual refresh / `feature/design-system`
untouched; nothing pushed/merged/deployed and **no migration applied** (`sync_report_jobs`
already exists in `20260807_scheduler_v2.sql`; the atomic one-derive guard is a conditional
PATCH, so no new RPC/migration is needed).

### 21.1 Modules

- **`lib/server/reports/derivation-core.js`** -- PURE, dependency-free leaf. Report calc cores
  extracted VERBATIM from `api/datadoe.js` (brand-sales `orderSalesByBrand`/`catalogBrandNames`;
  content-changes `compactContentChangeEvents` + `notificationAsins`/`compactJsonPreview`/
  `parseJsonValue`). The route is unchanged (its "one implementation / no risky cross-file
  move" annotation is respected); a golden parity test pins byte-identical output. Because
  this leaf imports nothing, a derivation adapter cannot reach a DataDoe export.
- **`lib/server/sync/report-derivation.js`** -- the derivation registry (dependency map) + the
  PURE `deriveReportSnapshot` orchestrator + `compareReportPayloads` (no-refetch parity) +
  shadow-key namespacing. Imports only pure leaves (derivation-core, report-source-contracts,
  planner); NEVER datadoe/supabase.
- **`lib/server/sync/report-worker.js`** -- checkpointable, idempotent `runReportJobs` worker
  (transport-free; all I/O injected). Gates required deps via `reportFetchGate`, claims derive
  once, derives + validates + saves a versioned SHADOW snapshot, with SEPARATE fetch/derive/
  validate/save accounting and per-report failure isolation.
- **`lib/server/sync/report-snapshot-store.js`** -- production wiring: `makeSupabaseReportStore`,
  `makeSourceRowLoader` (cache-only `getSourceExportCache`), `makeShadowSnapshotSaver`, and
  `compareShadowToProduction`.
- **`supabase.js`** -- `sync_report_jobs` wrappers: `getSyncReportJobs`, `upsertSyncReportJob`
  (fail-closed connection id), `claimReportDeriveAttempt` (conditional PATCH pending->running),
  `recordSyncReportBlocked/Failure/Success` (save vs derive are distinct stages; failure never
  clears `snapshot_params_hash`/`last_good_snapshot_at`); `updateSyncCycleCounts` extended with
  the existing `report_*` counters.

### 21.2 Shadow snapshots

v2 snapshots are written through the existing `saveReportSnapshot` under a namespaced report
key `scheduler-v2/<reportKey>` (so a v2 snapshot can NEVER overwrite a production
`report_snapshots` row). Each report job records its `snapshot_params_hash`.
`compareShadowToProduction({productionReportKey, accountId, params})` loads the saved shadow
snapshot and the saved production snapshot and structurally diffs them -- **no re-fetch, no
export** -- for pre-cutover parity review.

### 21.3 Derivation dependency map (from the executable registry)

`derive` = WIRED (faithful pure core, parity-tested) or PENDING (dependency map declared; the
pure-core extraction from the impure builder is the next tranche). Snapshot version tags are
Phase-1d shadow tags. Required keys are computed from `REPORT_SOURCE_CONTRACTS` (never drift).

| Report | derive | required request keys | optional | derived (persisted, non-DataDoe) |
|---|---|---|---|---|
| brand-sales | WIRED | order-lines, catalog | -- | -- |
| content-changes | WIRED | events, catalog | -- | -- |
| daily-reporting | pending | asin-day-superset, catalog | -- | ads-campaign-date |
| fba-plan | pending | monthly-units, current-daily-dates, catalog, inventory-health | awd (US-only) | -- |
| reconciliation | pending | order-lines, settlements, catalog | -- | -- |
| sku-pl | pending | monthly-profit | -- | (COGS from Supabase) |
| keyword-rank | pending | sqp-weekly, catalog | sqp-monthly (fallback) | -- |
| sales-movers | pending | sales-latest-probe, traffic, ads, inventory, catalog | -- | -- |
| buy-box-loss | pending | daily, inventory, catalog | -- | -- |
| returns-leakage | pending | returns, settlements, traffic, catalog | -- | -- |
| listing-health | pending | listings, sales, inventory, catalog | listings-raw (degraded) | -- |
| listing-optimizer | pending | catalog | sqp-weekly (degraded/staged) | -- |
| ppc-performance | pending | catalog | total-sales (currency-gated) | ads-campaign/asin/targeting/search-terms-date |

**Derived-only** (own zero source contracts, create no source job): `brand-view`,
`priority-feed`, `brand-directory`. `reportDerivationCoverage()` proves every scheduler-declared
report is mapped exactly once (declared derivation OR derived-only; `missing`/`both` empty).

### 21.4 Safety rules enforced (tested)

Derive only from validated saved arrays (`[]` is valid); a cache miss / malformed / failed /
truncated source is NEVER an empty success; a required source unavailable => not derived
(last-known-good snapshot preserved); terminal-disabled required => blocked (that report only);
optional/degraded never blocks; save failure is a distinct stage from derive; one report's
failure never blocks another; repeated workers never re-derive a finished report;
primary/dd-secondary never mix (no brand leakage); PPC owns no Ads export; derived-only reports
own no source contracts; golden `request_hash` unchanged.

### 21.5 Tests / status

`scripts/scheduler-v2-report-derivation.test.mjs` = **20 assertions** (`test:report-derivation`,
added to `npm run verify`). Full `npm run verify` green: **381** (54 insights + 60 brand-view +
23 sync + 6 source-cache + 56 scheduler-v2 + **20 report-derivation** + 7 source-identity + 155
report-contracts) + `build:check`; `node --check` on every changed file exits 0;
`git diff --check` clean.

### 21.6 Remaining (next tranche + live gates)

- Wire the 11 PENDING `derive` cores (extract-and-parity per the safest per-report choice):
  daily-reporting (superset all-brand + named-brand + ads merge), fba-plan (inline handler
  extraction + AWD conditional), reconciliation + sku-pl (monthly segmentation), keyword-rank,
  and the five insight reports + PPC (persisted-ads rollup). Each lands with a golden parity
  test against its current builder output.
- Derived-only derive (brand-view/priority-feed/brand-directory) reads other saved snapshots.
- Live gates (Codex): a real cycle deriving from real saved rows; superset-vs-compact Daily
  reconciliation; per-org disabled-source classification; Ads-history freshness before PPC.

---

## 22. Phase 1d foundation review -- blockers 1-5 corrected (SHADOW MODE, 2026-08-08)

Corrects the five review blockers on the Phase 1d foundation; the 11 pending adapters were
NOT started. Commits `875d9c9` (production fixes), `14208d1` (regression tests). SHADOW MODE;
Scheduler v1 / frontend / manual refresh / `feature/design-system` untouched; nothing pushed/
merged/deployed/migrated; request_hash unchanged; zero DataDoe calls during derivation.

1. **Blocked report completion.** `recordSyncReportBlocked` writes a consistent terminal state
   (`fetch_status=blocked`, `derive_status=skipped`, `save_status=skipped`, `validated=false`);
   `reportFinished()` treats `fetch_status=blocked` as finished. A blocked report is recorded
   once, not reprocessed, and the cycle drains; `last_good_snapshot_at` is untouched.
2. **Fragment preservation.** New exported pure `assembleSources(plannedSources, statusByHash,
   loadedByHash)` groups sources into deterministically-ordered fragments (order: from, to,
   requestHash), each carrying `requestHash/requestKey/from/to/sellerOrVendorIds/rows/fetchedAt`.
   One fragment never overwrites another; a key is `available` only if every fragment loaded a
   validated array (missing/malformed => unavailable, blocks safely, never coerced to `[]`).
   Adapters receive ordered `fragments` plus a safe concatenated `rows`. FBA monthly fragments
   retain their window because grouped rows do not carry the month.
3. **Content Changes exact payload.** Shared pure `contentChangesPayload({accountId,
   notificationRows, catalogRows, retrievedAt})` (derivation-core.js) returns the full
   `{ accountId, events, catalogBrands, retrievedAt, unassignedEvents }` shape the route/
   frontend use. `retrievedAt` comes from deterministic source metadata (the saved fetch time
   in the derivation context), never `Date.now()` inside the pure adapter. `latest_data_date`
   is normalized to `YYYY-MM-DD` (`toDateOnly`) before the `sync_report_jobs` write.
4. **Independent calculation parity.** `api/datadoe.js` now `export`s `orderSalesByBrand`,
   `catalogBrandNames`, `compactContentChangeEvents` (runtime unchanged). The Phase 1d suite
   runs the PRODUCTION route copy and the extracted `derivation-core.js` copy side by side and
   asserts identical output (two separate function objects) -- genuinely independent, catching
   drift. The route copies are retained (no offline suite exercises those fetch-bound handlers,
   so their removal cannot be verified here); this is the reviewer's sanctioned alternative.
5. **Snapshot payload-size guard.** The canonical 8 MB `MAX_SNAPSHOT_BYTES` is exported from
   `report-store.js` and reused. The worker rejects an oversized shadow payload BEFORE any
   Supabase write (`SNAPSHOT_SAVE_FAILED` at the save stage, previous snapshot preserved, zero
   writes); `makeShadowSnapshotSaver` enforces the same limit at the I/O boundary.

Tests: `scheduler-v2-report-derivation.test.mjs` = **29** (20 + 9 blocker regressions). Full
`npm run verify` green: **390** (54+60+23+6+56+**29**+7+155) + `build:check`; `node --check` on
every changed file exits 0; `git diff --check` clean. Remaining: wire the 11 pending derive
cores (each with a golden parity test) + the derived-only reads; then Codex's live gates.

## 23. Phase 1d blocker-fix re-review -- P1/P2 corrections (SHADOW MODE, 2026-08-08)

Corrects the three re-review blockers (one P1 parity, two P2 boundary) raised after the
blocker 1-5 fixes. Commits `6e73571` (production), `e08b835` (regression tests). SHADOW MODE;
Scheduler v1 / frontend / manual refresh / `feature/design-system` untouched; nothing pushed/
merged/deployed/migrated; request_hash unchanged; zero DataDoe calls during derivation; the 11
pending adapters still NOT started.

1. **P1 -- fragment order now matches the live transport (never a hash).** `assembleSources`
   carries an immutable `fragmentIndex` (the resolver/plan emission order, which is exactly the
   live transport's account/chunk then window fetch order -- see report-source-contracts
   `for contract -> for window -> for chunk`) and sorts fragments by it. The previous
   `(from, to, requestHash)` sort is gone: a SHA is not a sequence key, and even the `from/to`
   tiebreak re-derived order from data instead of preserving the plan. Concatenated `rows` are
   now byte-identical to sequential `fetchExportRows` concatenation, so `orderSalesByBrand`
   (last catalog label wins for a duplicate ASIN) and `compactContentChangeEvents` (first label
   wins) resolve to the SAME value the live route produces. The pre-existing monthly-windows
   regression was updated to the corrected contract (plan order preserved, not date-re-sorted).
2. **P2 -- the size guard can no longer be bypassed by a supplied byte count.** New
   dependency-free `lib/server/report-limits.js` leaf owns the single canonical
   `MAX_SNAPSHOT_BYTES` plus `snapshotByteSize` / `assertSnapshotWithinLimit`. `report-store.js`
   re-exports it; `report-worker.js` and `report-snapshot-store.js` import it (no literal that
   can drift from report-store; a pure worker never imports Supabase to learn the limit).
   `makeShadowSnapshotSaver` ALWAYS recomputes the actual UTF-8 JSON byte size and validates
   against THAT before any write (throws `SNAPSHOT_TOO_LARGE`); a caller-supplied `payloadBytes`
   is telemetry only and cannot understate/forge past the guard. The worker likewise recomputes
   actual bytes (never a trusted value) and defaults `maxSnapshotBytes` to the leaf constant.
3. **P2 -- `latest_data_date` is a strict calendar date, validated before save.** `toDateOnly`
   now validates the sliced `YYYY-MM-DD` via the strict UTC round-trip `isValidCalendarDate`
   (shared from report-source-contracts): `2026-02-30`, `2026-99-99`, and non-leap `2023-02-29`
   are rejected; `2024-02-29` is accepted. The worker validates the derived latest date at a
   dedicated VALIDATE stage BEFORE saving; a present-but-impossible date fails
   (`INVALID_LATEST_DATE`) so the shadow snapshot is never saved ahead of a Postgres `date`
   write that would then fail -- previous snapshot preserved, zero writes. A legitimately absent
   (null) date still succeeds.

Tests: `scheduler-v2-report-derivation.test.mjs` = **34** (20 + 9 foundation + 5 re-review
regressions; one pre-existing monthly-windows test rewritten to the plan-order contract). New
coverage: route-vs-shadow parity with >5 IDs + reverse-sorted hashes + conflicting catalog
labels for both brand-sales and content-changes; the forged-small-`payloadBytes` oversized
rejection with zero writes; the strict calendar rule (leap/impossible/malformed); and the
end-to-end impossible-date VALIDATE failure with last-known-good preserved. Full `npm run verify`
green: **395** (54+60+23+6+56+**34**+7+155) + `build:check`; `node --check` on every changed
file exits 0; `git diff --check` clean. Remaining unchanged: wire the 11 pending derive cores
(each with a golden parity test) + the derived-only reads; then Codex's live gates.

## 24. Phase 1d tranche 2 -- Daily Reporting + SKU P&L adapters (SHADOW MODE, 2026-08-08)

Wires the first two faithful derive adapters after the approved foundation (`ff9d350`). ONLY
these two; the other nine adapters are NOT started. Commits `5a3a197` (route folds exported/
extracted), `cab8d1c` (pure cores), `b8d9cab` (registry adapters + worker derived-input channel),
`baa8ad6` (parity/regression tests). SHADOW MODE; Scheduler v1 / frontend / manual refresh /
`feature/design-system` untouched; nothing pushed/merged/deployed/migrated; zero DataDoe calls
during derivation; `request_hash`, five-ID batching, and organization isolation unchanged;
`HANDOFF.md` stays untracked. (Commits are layered substrate -> cores -> adapters -> tests
because both reports share the same files; each committed snapshot keeps the suite green.)

### 24.1 Reuse strategy (safest-per-report)

`npm run verify` does not execute the fetch-bound `api/datadoe.js` handlers, so -- exactly as the
approved blocker-4 pattern -- the production folds are **exported** (runtime unchanged) and
**copied verbatim** into the dependency-free `reports/derivation-core.js` leaf, with an INDEPENDENT
route-vs-shadow parity harness executing both copies (separate function objects) on shared fixtures.
The SKU P&L fold was extracted from `fetchSkuPlRows` into an exported pure `foldSkuPlMonthlyRows`
that the route now calls (output-identical), removing the only inline duplication.

Production functions reused/copied: `normalizeDailySalesRows`, `dailyRowsForBrand` (first catalog
label per ASIN wins), `normalizeAdRows`, `mergeSalesAndAds`, `foldSkuPlMonthlyRows`, and the
`src/App.jsx` COGS applier `computeSkuPlRow`/`skuPlScopedTotals`/`cogsOverrideKey` (a React module
that cannot be imported offline, so transcribed verbatim and unit-tested against hand-computed
expectations). The ONLY new fold is `rollupSupersetToDaily` (no production equivalent -- the route
uses the server-side grouped compact export), proven equal to that compact calc in the harness.

### 24.2 Daily Reporting

- **Strategy.** Derive BOTH outputs from the ONE saved ASIN/day Sales & Traffic superset
  (`daily-reporting:asin-day-superset`, monthly-segmented, strict) + saved Product Catalog. No
  compact all-brand export, no per-brand export. ALL-brand = sum the superset over `child_asin`
  per `(date, seller_or_vendor_id)` -> normalize -> `total_units_sold = total_units` -> merge the
  injected Ads rows. Named brand = catalog ASIN->brand join folded to one row/day (NO ads, exactly
  like the route). Additive values re-aggregate after fragment concatenation; there are no stored
  ratio fields (daily ratios are recomputed in the browser from these base sums).
- **Snapshot stored this tranche:** the ALL-brand payload `{ rows, brandFiltered:false }`. `brand`
  is a legitimate snapshot param (the cache key includes it); per-brand snapshot PLANNING is
  deferred to the orchestration phase (the core already derives any brand, fully parity-tested).
- **Ads** are a DERIVE-ONLY injected input (`context.adRows`, planner-loaded from the scheduled
  Ads rows) delivered via the worker's new `loadDerivedContext` callback -- reaching the pure
  adapter but NEVER the snapshot params/identity. A missing/non-array `adRows` for the ALL mode
  THROWS (-> derive-invalid, last-known-good preserved) rather than silently understating.
- **Payload shape (ALL):** `{ rows: [{date, seller_or_vendor_id, total_sales_sum, total_units_sum,
  total_sales, total_units, total_units_sold, ad_sales?, ad_spend?, ad_clicks?}], brandFiltered:false }`
  (ad fields present only where Ads exist; ad-only days get a synthetic zero-sales row with
  `currency`). **Named:** `{ rows: [{date, seller_or_vendor_id, total_sales, total_units,
  total_units_sold}], brandFiltered:true }`. `latest_data_date` = max row date.

### 24.3 SKU P&L

- **Strategy.** Fold the six saved monthly-profit fragments (`sku-pl:monthly-profit`, strict) into
  one row per `currency|sku|child_asin` with per-month sums under `byMonth`. `monthKey` comes from
  each fragment's `from`, so two five-ID chunks in the same month sum into one bucket and the full
  six-month `byMonth` map is preserved (including empty months). Currencies never merge (part of
  the identity key). No ratios are summed.
- **Snapshot = the RAW route payload** `{ accountId, from, to, months, currencies, catalogBrands,
  rows }` byte-for-byte. `latest_data_date` = the window `to` (end of the last covered month).
- **COGS dependency (approved: "raw fold + tested applier").** The live route does NOT apply COGS
  overrides -- `src/App.jsx` applies them at display from browser `localStorage`, and the Supabase
  `getCogsOverrides()`/`cogs_overrides` table is currently unused. Baking overrides in would
  diverge from the route payload AND double-apply against the browser, so the snapshot stays raw.
  The injected-COGS applier (`computeSkuPlRow` + `latestCogsOverridePerUnit`) is implemented and
  parity-tested but NOT wired into the stored snapshot: it picks the latest valid per-unit override
  (max `updated_at`; negative/non-finite ignored), replaces ONLY the COGS component, moves cost/
  profit by the same delta, recomputes every ratio from sums, and keeps missing COGS explicitly
  unavailable -- NEVER assumed zero. It is ready for future server-side use / the live-gate
  reconciliation without touching the frontend.

### 24.4 Job status / safety (both)

`latest_data_date` (max row date / window `to`), truthful `row_count` (real payload rows) and
`payload_bytes` (recomputed) are recorded; the payload is validated before save; invalid/missing/
malformed inputs fail at derive/validate (never an empty snapshot); save failure is a distinct
stage; a repeated worker invocation does not re-derive a finished report; one report's failure does
not block the other; the adapters read only `sources`/`context` and create NO source request.

### 24.5 Verification

`node --check` on every changed file exits 0; `npm run test:report-derivation` = **44** (34 + 10
new, natural exit 0, zero fetch); `npm run test:scheduler-v2` = 56; `npm run test:report-contracts`
= 155; `npm run test:source-identity` = 7; full `npm run verify` green = **405**
(54+60+23+6+56+**44**+7+155) + `build:check` (2,393 modules); `git diff --check` clean. The golden
`request_hash`, five-ID batching, and primary/dd-secondary isolation assertions remain green.

### 24.6 Live-data assumptions / risks

- **Superset vs compact reconciliation (existing live gate).** The ALL-brand roll-up equals the
  compact export only if DataDoe's `[date,seller]` group-by is a strict roll-up of the
  `[date,seller,child_asin]` superset (same source, same aggregations). Proven offline against a
  deterministic oracle; reconcile once against a live compact total before retiring the compact export.
- **Ads freshness/injection.** ALL-brand fidelity depends on the planner loading the scheduled Ads
  rows into `context.adRows`; an absent/failed Ads load must gate upstream (like a required source),
  which the adapter enforces by throwing on a missing array.
- **Fragment order = resolver plan order.** Faithful concatenation assumes production planning
  passes the resolver's `contract -> window -> chunk` output through unchanged (the approved P1
  guarantee); it must never rebuild fragments from unordered DB rows.
- **COGS overrides are browser-local today.** The Supabase `cogs_overrides` reader is unused; wiring
  the tested applier server-side is deferred and must not double-apply with the browser.
- Remaining unchanged: the nine other adapters, per-brand daily snapshot planning, and Codex's live
  gates (no push/merge/deploy/migration/pg_cron until then).
