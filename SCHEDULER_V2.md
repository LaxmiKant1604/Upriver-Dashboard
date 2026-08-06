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

**Not declared this session (stop condition, honest):** each insight report's column
constants live in the builder files (not `api/datadoe.js`) and several use org-conditional
sources; accurate per-call transcription + parity testing for six reports is the next
focused Phase 1b increment, using the same method as the operational reports. The
classification above is complete; the formal `REPORT_SOURCE_CONTRACTS` entries + tests
remain. No insight contract was guessed or half-declared. Priority Feed + Brand View stay
derived-only (no DataDoe export).

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
