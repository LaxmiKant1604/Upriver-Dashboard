# Project Memory

Last updated: 2026-07-26

## Operating rule

- Whenever a future assistant makes changes, completes a task, or learns important project context, update this memory/documentation before finishing.
- Keep this file useful for handoff between Codex, Claude, or another assistant: record completed work, current progress, pending tasks, important decisions, and technical learnings.
- Do not overwrite unrelated user changes. If the worktree has existing untracked or modified files, preserve them unless the user explicitly asks otherwise.

## Current project status

- Project root: `sales-dashboard-live`.
- App: PULSE, an Amazon Seller Portfolio Sales Dashboard.
- Frontend: React + Vite in `sales-dashboard-live/src/App.jsx`.
- Backend: Vercel serverless function in `sales-dashboard-live/api/datadoe.js`.
- Data source: DataDoe REST API, using a server-side `DATADOE_API_KEY`.
- Deployment target: Vercel. Pushing code to GitHub should trigger Vercel rebuild/redeploy.
- Critical Vercel setting: Settings -> General -> Root Directory must be `sales-dashboard-live`, because the project files are nested one folder deep.
- Production URL: https://upriverdashboard.vercel.app
- Local development command from the README: `npm install`, then `npm run dev`.

## Completed

- Initial project files exist for the Vite frontend, Vercel API route, package metadata, and README.
- `node_modules` and `dist` are present under `sales-dashboard-live`, suggesting dependencies have been installed and a production build has been generated at least once.
- Added this project memory file so future work has a durable handoff location.
- Fixed a DataDoe sales export failure caused by sending more than 5 `sellerOrVendorIds` in one export request. `sales-dashboard-live/api/datadoe.js` now chunks sales exports into batches of 5 and combines the returned rows.
- Vercel deployment is intended to auto-deploy from the main branch.
- Production deploy completed from the repo root with Vercel CLI on 2026-07-23. Deployment URL: https://upriver-dashboard-gchyci0gn-laxmikant1604s-projects.vercel.app. Production alias: https://upriverdashboard.vercel.app.
- Latest production deployment with account and catalog brand filtering completed on 2026-07-23. Deployment URL: https://upriver-dashboard-3xs64d4e1-laxmikant1604s-projects.vercel.app. Production alias remains https://upriverdashboard.vercel.app.
- Latest production deployment with Daily Reporting aggregation/freshness correction completed on 2026-07-24. Deployment URL: https://upriver-dashboard-ezelupb9z-laxmikant1604s-projects.vercel.app. Production alias remains https://upriverdashboard.vercel.app.
- Latest production deployment with Seller Central Order Report sales completed on 2026-07-24. Deployment URL: https://upriver-dashboard-e2wjkc6bn-laxmikant1604s-projects.vercel.app. Production alias remains https://upriverdashboard.vercel.app.
- Latest production deployment with header Brand Selection and Yesterday date filter completed on 2026-07-24. Deployment URL: https://upriver-dashboard-5flxvkird-laxmikant1604s-projects.vercel.app. Production alias remains https://upriverdashboard.vercel.app.
- Latest production deployment with cached Brand Selection enablement completed on 2026-07-24. Deployment URL: https://upriver-dashboard-avrphaoqk-laxmikant1604s-projects.vercel.app. Production alias remains https://upriverdashboard.vercel.app.
- Latest production deployment with selected-account refresh restriction completed on 2026-07-24. Deployment URL: https://upriver-dashboard-i5dly4pvv-laxmikant1604s-projects.vercel.app. Production alias remains https://upriverdashboard.vercel.app.
- FBA Shipment Plan report built, reconciled, reviewed, and deployed to production on 2026-07-26. Commit `6ef64fb Add FBA Shipment Plan report` pushed to `origin/main`. Production deployment URL: https://upriver-dashboard-1a0pg1mq1-laxmikant1604s-projects.vercel.app. Production alias remains https://upriverdashboard.vercel.app. Deployed verification (Haven&Hue US, to=2026-07-26): 79 ASIN rows, 27 restock, AWD column shown, sales through 2026-07-24, FBA snapshot 2026-07-26; existing Dashboard (KPI cards, range chips) and Daily Reporting regression-checked OK; no console errors on desktop or mobile; no mobile page overflow. See the "FBA Shipment Plan report" section below for full source IDs, mappings, and reconciliation.
- Local commit `89c30f0 Batch DataDoe sales exports` was pushed to `origin/main` after clearing the stale cached GitHub credential.
- `DATADOE_API_KEY` is expected to be configured for Production, Preview, and Development in Vercel.
- DataDoe authentication is verified to use the custom `datadoe-api-key` header, not standard Bearer auth.
- DataDoe endpoint paths are verified as `/util/sellers-and-vendors` for accounts and `/exports` for export creation/data retrieval.
- Account list loading has worked with 15 accounts visible in dropdowns.
- Header UI updated: the top badge now reads `UPRIVER` instead of `PULSE`, and the account scope selector (`All Accounts`, `Single Account`, `Brand View`) moved into the header before the refresh/account status.
- Added browser-side DataDoe response caching in `src/App.jsx`. The app now hydrates accounts, dashboard sales, and Daily Reporting from `localStorage` on open/selection changes and does not call DataDoe automatically. Network calls happen only through explicit refresh buttons, which update the matching cache entry.
- Replaced the dashboard's `All Accounts` / `Single Account` / `Brand View` modes with a single Account Selection dropdown in the header and a Brand Selection dropdown below it. The brand dropdown includes `Select All Brands` and filters every dashboard KPI, comparison, trend, and breakdown locally from the cached response.
- Moved the dashboard Brand Selection dropdown into the header beside Account Selection. It is populated only from the selected account's cached catalog/sales response, resets to `Select All Brands` immediately on account changes, and never triggers a DataDoe request by itself. Added a `Yesterday` date-range chip; it uses the prior calendar day when present, otherwise the latest available source date to avoid an empty inverted range.
- Fixed the header Brand Selection control being disabled after the order-report cache version change. It now scans only browser-cached `brand-sales` catalog metadata for the selected account, so previously cached account brands remain selectable before a new manual refresh. The selector is always openable and does not call DataDoe.
- Dashboard refresh is now explicitly single-account: the browser passes only the selected account ID, `action=brand-sales` rejects multi-account IDs server-side, and the header status reports the refreshed account name instead of the total number of connected accounts. Daily Reporting follows the same selected-account status behavior.
- Production verification: a two-account `action=brand-sales` request returns HTTP 400 before DataDoe access; a one-account Indya Store request returned 11 rows, 35 catalog brands, and exactly one account ID.
- Replaced account-name heuristic brand grouping with DataDoe product-brand data. Dashboard refreshes now use the product-level sales source plus the Product Catalog by ASIN source, keeping all DataDoe calls manual and caching both the sales rollup and catalog response per account/date range.
- Validated the deployed `action=brand-sales` route with a one-day AAKRITI request: it returned one grouped row per product brand/day and the catalog source returned real product-brand data. The API now returns only distinct `catalogBrands` to the browser rather than full product catalog records, avoiding oversized `localStorage` cache entries while retaining catalog-backed filtering.
- Final live payload check: the one-day AAKRITI request returned 2 grouped sales rows and 35 catalog brand labels; the compact response is suitable for the browser cache.
- Daily Reporting is now verified and corrected: it uses DataDoe server-side grouping for sales and advertising data, then anchors the visible table to the latest completed sales date. This prevents an incomplete current zero-sales source row from appearing as a genuine zero-sales day.
- Final daily live check after deployment: June 2026 is `₹633,481.37` sales, `467` units, `₹348,317.20` ad sales, `₹125,095.80` ad spend, and `26,703` clicks for AAKRITI ART CREATIONS IN. The latest completed sales date is 2026-07-22; the raw source has an incomplete 2026-07-23 sales row.
- Added a collapsible left sidebar shell around the existing dashboard in `src/App.jsx`. It has a brand/workspace header ("UR" logo, "Upriver Dashboard", `laxmikant@upriver.in`). Desktop supports a collapse button (icon-only mode); mobile/tablet uses an off-canvas drawer with a menu button, backdrop click, and close button. All existing filters, KPI cards, comparisons, chart, and breakdowns render unchanged inside the new `.main-area`. Icons use `lucide-react`.
- Added a "Daily Reporting" section as a second sidebar nav item. A `view` state (`"dashboard"` | `"daily"`) switches the main content; the account-scope tabs only show in dashboard view. The Daily Reporting view is single-account (defaults to Aakriti Art Creations, matched by name) with its own account dropdown and independent fetch (`dailyRows`, ~5 months of history via `action=daily`).
- Daily Reporting renders a table matching the user's screenshot: columns are 3 completed months + current-month MTD + the last 5 days (relative to the latest data date); rows are Total Sales, Ad Sales, Ad Spends, Clicks, Units, ROI (Ad Sales÷Ad Spend), ACoS % (Ad Spend÷Ad Sales), TACoS % (Ad Spend÷Total Sales). Table helpers: `monthBack`, `dailyReportColumns`, `DAILY_METRICS`. Wide table scrolls horizontally with a sticky metric column.
- Total Sales and Units populate from the existing sales source now. Ad Sales/Spend/Clicks (and the derived ROI/ACoS/TACoS) show "—" because no DataDoe advertising source is wired yet. The frontend reads ad fields optimistically via `pickNum` + candidate key lists (`AD_SALES_KEYS`, `AD_SPEND_KEYS`, `CLICKS_KEYS`), so the table auto-fills once the export includes real ad columns.
- Added a temporary discovery route to `api/datadoe.js`: `?action=fields` (optional `&sourceId=`). It probes candidate DataDoe source/column endpoints and returns their JSON so we can identify the advertising source id + column names. Remove this route after the ad source is confirmed. It exposes source metadata (not the API key) on the live URL while present.
- IMPORTANT — source granularity finding: `401ffcd7e5` ("Sales & Traffic by ASIN & Date") is **per-ASIN**, ~700 rows/account/day (mostly zero-sales rows), and has no currency/name columns. It has data for AAKRITI only from ~2026-04-27 onward. Summing ALL rows per day gives correct totals (full June = ₹623,252 / 456 units, matching Seller Central expectations); a naive fetch with a low row limit truncates recent dates to ₹0. It cannot be used for the multi-account dashboard (would be millions of rows), so it is used ONLY for the single-account Daily Reporting view.
- Architecture split in `api/datadoe.js`:
  - `action=brand-sales` (main dashboard): **Order Line Items** data, grouped server-side by date/account/currency/child ASIN. The server maps ASINs to `product_brand` via the Product Catalog source and folds the response to date/brand totals. It uses `item_price_value`, DataDoe's documented order value field, so Select All Brands reflects Seller Central Order Report sales including pending orders. A cache version is included in `dashboardParams`, preventing pre-change profit totals from being reused after deployment. The legacy `action=sales` fast daily profit rollup remains available for compatibility but is no longer used by the dashboard UI.
  - `action=daily` (Daily Reporting): DataDoe now aggregates sales and ads server-side by `(seller_or_vendor_id, date)`, then the API merges the two compact results. This avoids raw ASIN/ad-row truncation and returns one row per day to the frontend.
- Advertising source `08cdc77d3d` was configured with columns `ad_sales`, `ad_spend`, `ad_clicks`, but it returned `404 Source not found` on 2026-07-24. Do not rely on its Daily Reporting metrics until it is replaced or the route is made sales-only.
- Export helpers generalized: `createExport`/`fetchExportRows(apiKey, sourceId, columns, ids, from, to, limit)` work for any source with a per-call limit.
- Rate limiting: DataDoe caps at 2 requests/sec per organization; the all-accounts dashboard load (chunked exports) plus any concurrent usage was surfacing HTTP 429 in the UI. Added `ddFetch` in `api/datadoe.js` — a wrapper that spaces DataDoe requests ~550ms apart (`MIN_REQUEST_INTERVAL_MS`) and auto-retries on 429 using `retryAfterSeconds`/`Retry-After` (up to 6 times). All accounts/export/poll/download calls route through it. The account-scope tabs are NOT the cause of the 429.

## FBA Shipment Plan report (added 2026-07-26)

New sidebar report directly below Daily Reporting. Single selected account, cache-first, manual-refresh-only, all planning math computed in the browser. Backend action `fba-plan` in `sales-dashboard-live/api/datadoe.js`; frontend view + helpers in `sales-dashboard-live/src/App.jsx` (`computePlanRow`, `comparePlanRows`, `planSearchMatch`, `PlanTh`).

### DataDoe sources & field mappings (verified against https://api.datadoe.com/api/v1/spec/data-scheme — public, unauthenticated; there is NO REST "list sources" endpoint, use the spec URL)
- Unit sales per ASIN: `401ffcd7e5` Sales & Traffic by ASIN & Date (`amazon_sales_and_traffic_with_cogs`), column `total_units`, grouped server-side by `child_asin` per month window. Same source Daily Reporting already reconciled to Seller Central.
- Live FBA inventory: `44fc5ba0ce81a7807601f6d7a9b8b7aaec64be4c7e046ea30dc6864d1a4aa823` FBA Inventory Health (`amazon_fba_inventory_health`). Per-SKU fields used: `available`, `reserved_fc_transfer`, `reserved_fc_processing`, `inbound_shipped`, `inbound_received`, `inbound_working`, `sku`, `child_asin`, `product_name`, `date`. Snapshot is per-SKU per-day; the server keeps only the latest snapshot date (fetch ordered by date DESC over a 10-day lookback, then filter to max date) and folds SKUs to ASIN by summing.
- AWD available (US accounts only): `ba689c05d7f7cee1a1690990c28995680a0654b7ed258230f4173d61bbcd1ab3` Listings (`amazon_listings_with_cogs`), column `awd_available_distributable_quantity`. Listings has NO date column, so its export sends no from/to and orders by `child_asin` (createExport now omits from/to when falsy).
- Brand + product name: `68d2de23...` Product Catalog by ASIN (`product_brand`, `product_name`), fetched over the 3-month+MTD window.

### Field-mapping decisions (per spec + confirmed on real rows)
- FBA Available = `available`.
- Reserved = `reserved_fc_transfer` + `reserved_fc_processing` ONLY. Customer-order reserve (`reserved_customer_order`) is intentionally excluded and never fetched. NOTE: `total_reserved_quantity` is unreliable in raw data (observed total=3 while fc_transfer=14, fc_processing=1) — do NOT use it.
- In Transit to FBA = `inbound_shipped` + `inbound_received`. `inbound_working` (still being prepared, not yet shipped) is intentionally excluded per the "already shipped/inbound/receiving" definition.
- AWD only applies to US-marketplace accounts (isUS derived from the authoritative DataDoe accounts-list country, not client input). Non-US accounts get AWD null/hidden; it never enters coverage or the recommendation.

### Calculations (browser, `computePlanRow`)
- 3 Month Avg = (m1+m2+m3)/3 over the 3 completed calendar months.
- MTD Projected Monthly Units = (MTD units / elapsed days) * days in current month. elapsedDays = day-of-month of the latest COMPLETED sales date (not the raw calendar day), so a reporting lag does not understate velocity; 0 if no current-month sales.
- Planning Avg = max(3-month avg, MTD projected).
- Daily Planning Rate = Planning Avg / days in current month.
- Target Units = Daily Rate * Target Coverage Days (numeric input at top, default 30, any positive number; recomputes locally, no fetch).
- Total FBA Inv. = FBA Available + Reserved + In Transit (+ AWD for US).
- Recommended Shipment = max(0, ceil(Target Units - FBA - Reserved - In Transit [- AWD if US])).
- Stock Remark = Restock if Recommended > 0 else OK.

### Behaviors / assumptions
- **Global report scope (added 2026-07-26):** `selectedAccountId` and `selectedBrand` in `src/App.jsx` are the only account/brand selectors for Dashboard, Daily Reporting, FBA Shipment Plan, and all future reports. The selectors live in the header on every view; do not add page-level account or brand selectors. New reports must use this shared scope, read cached data for it on navigation/scope change, and make DataDoe calls only on explicit refresh.
- Header brand choices are strictly account-scoped. The app reads only cache keys for the selected account and tracks the account that owns in-memory catalog brands, preventing a prior account's brands from appearing while a newly selected account is loading.
- Daily Reporting accepts the shared brand in `action=daily`. For `Select All Brands`, it retains compact account/day sales and advertising data. For a named brand, the server groups Sales & Traffic data at ASIN/day grain, joins Product Catalog `product_brand`, then returns only that brand's sales and units. It fetches each calendar month separately (limit 50,000 rows/month) to avoid silent ASIN/day truncation. Advertising metrics intentionally render unavailable for named brands because the current advertising export is account-level and cannot be attributed accurately to a product brand.
- Production validation on 2026-07-26 for Indya Store IN: `brand=Caruso Italy` returned `brandFiltered:true`, 89 daily rows (2026-04-27 through 2026-07-24), 27,050 units, and no advertising fields. The matching `brand=ALL` request returned `brandFiltered:false`, 91 daily rows, and advertising fields on all rows. This confirms no account-level advertising values are mixed into a selected brand.
- One row per ASIN. SKU->ASIN folding sums inventory across SKUs. Representative SKU = first non-empty SKU in ascending `localeCompare` order (stable across refreshes), gathered from FBA Inventory Health + Listings.
- Rows are limited to ASINs with real activity: any unit sales in the window OR any live FBA/AWD stock. This drops the large zero-sales/zero-stock catalog tail that Sales & Traffic emits daily (e.g. AAKRITI 2226 -> 1225 rows; Haven&Hue 92 -> 79).
- Live inventory freshness (snapshot date) is shown separately from sales-report freshness (latest completed sales date). When the whole FBA inventory snapshot is unavailable, coverage/recommendation render "—" with a banner; sales velocity still displays. No values are fabricated.
- Cache key (`planParams`) = {action:"fba-plan", reportVersion:"fba-plan-v1", ids, to}. Target Coverage Days, search, and sort are NOT in the key — local recompute only. Refresh is single-account (server rejects != 1 id with HTTP 400).
- `sales-dashboard-live/vercel.json` added with `maxDuration: 60` for `api/datadoe.js` (the plan makes ~7-8 sequential, rate-limited exports; observed 25-33s per refresh).
- On 2026-07-26, the plan table was updated to round all visible unit values to whole units. The former displayed `Plan Avg` column was replaced with dynamic `Target Units (Nd)`: `Planning Avg / days in current month * Target Coverage Days`. This makes the entered days visibly change the required stock, while 3-month average and MTD projection remain demand inputs. Recommended Shipment still uses the exact calculation and rounds up with `ceil`.
- The plan has a `Download Excel` action that exports the currently visible (searched and sorted) rows as a UTF-8 BOM CSV, which opens directly in Excel. It includes all displayed planning/inventory columns and the dynamic target-days column; CSV cells are protected from spreadsheet-formula injection. Do not add the npm `xlsx` package for this: its audit reported two unpatched high-severity advisories, so the dependency was removed.
- `Total FBA Inv.` means inventory already counted toward meeting demand: FBA Available + Reserved FC Transfer/Processing + In Transit; US accounts also add AWD Available. It is a quantity of units, not a number of days.
- On 2026-07-26, the combined inventory label was renamed from `Coverage Units` to `Total FBA Inv.`. A new sortable `FBA Days (MTD DRR)` column was added to the table and Excel-compatible export. It is `FBA Available / (MTD Units / completed sales days)` and displays whole days; it intentionally excludes reserved, inbound, and AWD inventory because those units are not physically available in FBA. When MTD DRR is zero or unavailable, it displays `—`. The totals row uses total FBA Available divided by the summed MTD DRR, rather than summing individual ASIN cover days.
- Latest production deployment for the rounded units, dynamic Target Units, and Excel-compatible export: `https://upriver-dashboard-5dema7vbr-laxmikant1604s-projects.vercel.app` (2026-07-26). It is aliased to `https://upriverdashboard.vercel.app`; the production bundle was checked for all three new UI strings.
- Latest production deployment for `Total FBA Inv.` and `FBA Days (MTD DRR)`: `https://upriver-dashboard-q4j2n5cg1-laxmikant1604s-projects.vercel.app` (2026-07-26), aliased to `https://upriverdashboard.vercel.app`.
- Latest production deployment for the global header account/brand scope and Daily brand filter: `https://upriver-dashboard-btlg1nskn-laxmikant1604s-projects.vercel.app` (2026-07-26), aliased to `https://upriverdashboard.vercel.app`.

### Verification (Haven&Hue US and AAKRITI IN)
- Sales reconciliation EXACT: plan per-ASIN monthly sums equal `action=daily` (same source 401ffcd7e5, grouped by date). Haven&Hue: Apr 92 / May 646 / Jun 877 / Jul-MTD(<=07-22) 462 identical both ways. AAKRITI June = 467 units, matching the previously documented Seller Central reconciliation.
- Inventory per-ASIN reconciliation MATCH vs raw 2026-07-23 FBA Inventory Health snapshot: B09F3RBP4K avail96/fct2/fcp1, B09F3SVQW3 avail0/fct(null->0)/fcp19, B0BVMQ49TC avail1/fct0/fcp3 — all exact, including null->0 coalescing.
- AWD: Listings export with no date range works; Haven&Hue returned 24 ASINs with AWD>0. Non-US (AAKRITI) returns awdAvailable=null on every row and no AWD column.
- UI (Playwright, desktop 1440 + mobile 390): sticky Product/ASIN column holds when scrolled; horizontal scroll is inside the table only. Fixed a bug where the min-width:1080 table forced the whole page to overflow to 1240px on mobile — root cause was `.container { margin:0 auto }` disabling flex stretch; fixed by adding `width:100%` (and `min-width:0`). Search 79->3 on "hella"; restock rows highlighted; math confirmed (B000CRZXPI 3M avg 66.3, MTD proj 100.0, plan avg 100.0). No console errors. Independent code review found no issues.

### Known limitations / risks
- Refresh latency 25-35s (many sequential rate-limited exports); could approach the 60s function limit on a slow DataDoe day — the UI then surfaces the error and the user retries.
- Large catalogs (e.g. AAKRITI ~1225 rows) make a sizable localStorage entry; `writeApiCache` already swallows quota errors so the app stays usable.
- Sales source (401ffcd7e5) can lag a few days; MTD projection is anchored to the latest completed sales date, which is shown in the UI.
- Independent Codex review on 2026-07-26 verified the deployed Haven&Hue US plan end to end: one-account request completed in 27.2 seconds, returned 79 ASIN rows, sales through 2026-07-24, FBA snapshot dated 2026-07-26, and AWD inventory for 24 ASINs. The current upstream sales values had settled to Apr 92, May 646, Jun 876, and Jul MTD 484 units; values can change as DataDoe finishes synchronization.
- **Review follow-up — accuracy at month rollover:** `planMonthWindows(to)` chooses the prior three *calendar* months before checking whether DataDoe has complete sales for them. On the first days of a new month, a lagging source can make the just-finished month incomplete while it is still counted as a completed month, understating the 3-month average and shipment recommendation. Before relying on the plan across a month boundary, change the backend to select the last three fully populated source months (or clearly mark/block an incomplete month).
- **Review follow-up — duplicate manual refreshes:** the header refresh button is not disabled while a plan is loading, and `fetchPlan` has no in-flight guard. Repeated clicks can launch concurrent 25-35 second exports, spending extra DataDoe quota and bypassing the intended sequential rate protection across Vercel invocations. Add a shared client-side in-flight guard and disable the refresh button for every report while its request is active.
- **Review follow-up — stale-cache UX:** the plan cache key includes `to=TODAY`. A report fetched yesterday is not reused after midnight; no automatic request is sent, but the user sees a cache-miss prompt instead of the last fetched plan. If the product requirement is to display the previously fetched data until manual refresh, add a latest-cache lookup per report version/account and label it with its as-of date.
- **Review follow-up — partial-source failure:** the UI's inventory-unavailable banner only handles a successful export with no inventory rows. A failed FBA Inventory Health or US Listings export currently aborts the whole `fba-plan` request, so sales velocity cannot be shown. Decide whether the endpoint should return a sales-only, explicitly unavailable inventory state for those upstream failures.

## In progress

- **Amazon Reconciliation Dashboard:** completed and deployed on 2026-07-26. The new sidebar report uses the shared Account/Brand header scope, reconciles six *full* calendar months of Order Line Items with Settlements & P&L Components, and performs month switching, charts, Order Explorer filtering/sorting/pagination, copy-order-ID, and Excel-compatible CSV export locally after an explicit refresh. It makes settlement posting dates and cross-month timing visible rather than calling normal Amazon timing differences errors. Confirmed settlement source: `732dac689a6545697c2f2e36c61b2c9e93187053bcce2999914183c6f490df27`; financial fields: `item_price`, `item_tax`, `referral_fee`, `fba_per_unit_fulfillment_fee`, `refunded_amount`, and `total` (not the generic skill's `sum_*` aliases). Named-brand reconciliation intentionally keeps only single-brand orders because settlement events are order-level and cannot be allocated accurately across items in a mixed-brand order.
- **Delivery protocol:** for future Claude/Codex changes, the implementing agent must update this memory with completed work, in-progress/pending work, decisions, technical learnings, and verification. Codex must then perform a senior-engineer review, resolve material findings, verify the deployed behavior, and record a concise completion/deployment summary before declaring the task finished.
- FBA Shipment Plan review follow-up is open: address month-rollover completeness and duplicate-refresh protection before treating shipment recommendations as production-accurate in all periods. The main dashboard now uses DataDoe Order Line Items (`89b275...`) rather than Profit by SKU & Date for its sales total.
- Temporary discovery routes `?action=fields` and `?action=sample` still exist in `api/datadoe.js`; remove them now that sources/columns are confirmed.

## Pending tasks and known follow-ups

- Verify sales numbers on the live dashboard match Seller Central expectations.
- Recheck very recent Order Line Items values after DataDoe completes its upstream synchronization. The 2026-07-23 Indya Store export was `INR 1,081` short of the downloaded Seller Central report because three units had zero `item_price_value` in DataDoe. The dashboard must not fabricate the missing revenue; click manual refresh after DataDoe has populated those order values.
- Revalidate Daily Reporting advertising metric accuracy after any DataDoe source change. The source `08cdc77d3d` returned `404 Source not found` on 2026-07-24, but a deployed `action=daily` request for AAKRITI returned HTTP 200 with seven daily rows on 2026-07-26; the earlier hard-failure is no longer reproducible.
- Consider switching sales source from `b24cd69c06` (Profit by Date, settlement-based, roughly 7-day lag) to `401ffcd7e5` (Sales & Traffic by ASIN & Date, roughly 4-day lag, closer to Seller Central) if accuracy is off.
- Sidebar is intentionally a minimal foundation: only the "Dashboard" nav item exists for now. Add further report/module nav items (e.g. Profit, PPC, Inventory) into the `.sb-nav` block in `src/App.jsx` later, only when the user decides which modules are needed.
- Add Profit module for net margin analysis.
- Add PPC module for ad spend, ACoS, TACoS, and campaign performance.
- Add Inventory module for FBA stock, days-of-cover, and restock alerts.
- Currency conversion currently uses static approximate FX rates in `src/App.jsx`; consider wiring in a live FX API or creating a maintenance process for updates.
- Confirm product-brand labels in the catalog match the desired reporting taxonomy. They now come directly from Amazon/DataDoe catalog data rather than account-name heuristics.
- YoY comparisons require roughly 13 months of account history.
- The most recent 1-2 days of Amazon data may change as settlement data finalizes.
- README text currently displays mojibake for some punctuation in this environment; consider normalizing the file encoding if editing it later.

## Key decisions

- Source ID `b24cd69c06` was chosen initially for daily account-level rollup. Trade-off: it is settlement-based and can lag Seller Central by roughly 7 days. `401ffcd7e5` may match Seller Central more closely but has not been swapped in.
- Static FX rates are hardcoded in `src/App.jsx` for now. This is simple and free, but rates need periodic updates or a live API later.
- Brand filtering uses `product_brand` from DataDoe's catalog/product data, not account-name heuristics. Similar-looking product-brand labels will be treated as distinct until the underlying catalog data is corrected or an explicit mapping layer is added.
- Project files should remain under `sales-dashboard-live/` unless Vercel's Root Directory setting is changed too.
- The sidebar currently stays simple with only the Dashboard item; additional report/module options should be added later only when requested.
- Vercel CLI should be run from the repo root, not from `sales-dashboard-live`, because the Vercel project already has Root Directory set to `sales-dashboard-live`. Running from the nested app folder makes Vercel look for `sales-dashboard-live/sales-dashboard-live`.
- Data policy for reports: all current and future reports should use the shared cache-first pattern (`cachedApiGet` / `readApiCache`) and should call DataDoe only on manual refresh. Do not add mount/view-change auto-fetching unless the user explicitly asks for it.
- Brand filtering is account-scoped. The selected account is the dashboard's primary scope; `Select All Brands` returns that account's overall figures, while a named product brand filters the same cached rows without another DataDoe request.

## Technical learnings

- The dashboard combines multiple Amazon accounts and supports account/brand selection, KPI cards, DoD/WoW/MTD/YoY comparisons, a sales trend chart, and account/brand breakdowns.
- The browser should never receive the DataDoe API key; all authenticated DataDoe requests go through the serverless API route.
- When running local dev, the Vite dev server proxies `/api` to `localhost:3000`, so `vercel dev` may be needed separately for API routes.
- DataDoe's export creation API rejects `sellerOrVendorIds` arrays with more than 5 elements. Any all-account, marketplace, or large-brand request must be batched server-side.
- `npm run build` currently succeeds, but Vite warns that the generated JS chunk is larger than 500 kB.
- DataDoe REST API rate limit is understood to be 2 requests/second per organization; excess requests may return HTTP 429 with `Retry-After: 1`.
- DataDoe exports are asynchronous: POST `/exports`, poll `/exports/{id}` until status is `COMPLETED`, then GET `/exports/{id}/raw`.
- DataDoe public schema confirmed the source IDs and fields for product-brand filtering:
  - `57a0cb319c10a395853afc0671579bf7ef0ff45d8a40c88ed9d2a5f61b4169a4` — **Profit by SKU & Date**. It is at child-ASIN/SKU/day grain and exposes `product_brand`, `total_sales`, `total_units_sold`, and `total_orders`.
  - `68d2de238e8d1a47bc56a981a99d54558507b0bafb1e09f1b3e95fb7750a17a8` — **Product Catalog by ASIN**. It exposes `child_asin`, `parent_asin`, `product_name`, and `product_brand` and is used to populate the complete brand selector.
  - The existing `401ffcd7e5` Sales & Traffic source has `child_asin` and `parent_asin`, but does **not** expose `asin`, `sku`, `brand`, or `brand_name` fields. Do not request those names from that source.
  - SKU-level sales must use DataDoe `groupBy` plus `aggregations` (date/account/currency/product_brand grouped; sales/units/orders summed). Fetching selected columns alone returns repeated SKU-level rows and can truncate the dashboard result.
  - Product Catalog by ASIN can be large (many product descriptions and ASINs). Do not cache/send the raw catalog in the browser response when only brand filtering is required; collapse it server-side to unique `product_brand` labels.
  - Daily Reporting validation on 2026-07-24 for AAKRITI ART CREATIONS IN: June 2026 totals from `action=daily` exactly reconciled to a direct `401ffcd7e5` Sales & Traffic export: `₹633,481.37` sales and `467` units across `20,779` ASIN-level rows. The API output contained `88` unique daily rows and no duplicate dates.
  - The Sales & Traffic source may expose a current zero-sales row before its sales/units finish loading. For example, July 23 had zero sales/units but nonzero ads. The Daily Reporting table must anchor on the latest date with completed sales/units rather than the maximum raw date.
  - Seller Central reconciliation on 2026-07-24, using the attached `C:\\Users\\laxmi\\Downloads\\788561020658.txt` Order Report for 2026-07-23: the report is for **Indya Store IN** and totals `INR 159,954.00` item price across 345 lines. It consists of `INR 137,346.00` shipped and `INR 22,608.00` pending; 22 cancelled lines have zero value. The deployed main dashboard's `action=brand-sales` route (source `57a0...`, Profit by SKU & Date) returned `INR 135,220.00`, 281 units, and 259 orders for the same account/date. The `INR 24,734.00` gap is primarily the pending order value (`INR 22,608.00`); the remaining `INR 2,126.00` is consistent with the source's settlement/profit-oriented adjustments rather than raw ordered item price. Do not claim these two report types should reconcile exactly.
  - The same live reconciliation found no 2026-07-23 rows in the `401ffcd7e5` Sales & Traffic by ASIN & Date source for any connected account, so it cannot currently provide yesterday's Seller Central total. This is source freshness/availability, not a frontend cache or aggregation defect.
  - Daily Reporting's configured advertising source `08cdc77d3d` returned `404 Source not found` from DataDoe on 2026-07-24 and then returned successfully through the deployed `action=daily` route on 2026-07-26 (seven AAKRITI daily rows for 2026-07-20 through 2026-07-26). Treat source availability as an upstream condition and keep validating the actual ad values rather than assuming the earlier 404 persists.
  - Main dashboard Order Line Items verification after deployment (2026-07-24): a full 420-day Indya Store refresh completed in 13.1 seconds and returned 5,539 date/brand rows. For 2026-07-23 it returned `INR 158,873.00` and `345` units. The attached Seller Central Order Report has the same `345` units and `INR 159,954.00`, leaving `INR 1,081.00` unexplained by dashboard logic. The DataDoe grouped data contains three units with zero order value, so the remaining difference is an upstream field-completeness delay, not the former shipped-versus-pending metric mismatch. Orders/AOV deliberately show unavailable for the new source because compact ASIN aggregation cannot deduplicate order IDs across ASINs without a substantially larger export.
- DataDoe API keys are shown only once at creation time. After that, only the prefix is visible in the UI.
- Vercel serverless functions cannot have spaces in the filename. A file named `datadoe (1).js` under `api/` would fail deployment with `invalid_function_name`; the active API route must remain `api/datadoe.js`.
- Changing Vercel environment variables does not auto-redeploy. Trigger a redeploy for new values to take effect.
- DataDoe AI Skills reference for Claude/Codex handoff and future report ideas: https://github.com/Deltologic/datadoe-ai-skills. Also review DataDoe Hub's AI skills/docs pages when designing new modules, especially reconciliation dashboards, orders manager, ASIN/search audit, export discovery, REST fallback, polling, and rate-limit guidance.
- Reconciliation dashboard source guide: https://github.com/Deltologic/datadoe-ai-skills/tree/DOE-2733-skill-metadata-categories/skills/create-amazon-reconciliation-dashboard. It requires six full calendar months and distinguishes order purchase dates from settlement posting dates; cross-month settlement is expected and must be labelled rather than treated as a discrepancy.
- Reconciliation source mapping verified live on 2026-07-26 for Indya Store IN: Order Line Items source `89b27535d27c2a94db5ae39af4717f542624ff4df7802fd633e16c78674a1778` supplies `amazon_order_id`, `order_date`, `amazon_order_status`, `fulfillment_channel`, `order_is_business`, `quantity`, `item_price_value`, and `item_tax_value`. Settlements source `732dac...` supplies the matching order ID, posting `date`, `settlement_type`, `item_price`, `item_tax`, `referral_fee`, `fba_per_unit_fulfillment_fee`, `refunded_amount`, and `total`. A real six-month request returned HTTP 200 and showed ORDER and REFUND events plus negative FBA/refund amounts as expected.
- A six-month order-level response can be larger than normal browser localStorage capacity (Indya Store's initial raw response was about 23 MB). Reconciliation uses IndexedDB (`upriver-report-cache`) for cache-first persistence, with localStorage only as a fallback. Do not return a per-brand monetary breakdown for every order: the server returns compact `brands` labels and uses `reconciliation-v2` cache keys.
- Reconciliation feature commits: `450d2ba Add Amazon reconciliation dashboard`; `37f0b0a Optimize reconciliation report caching`. Latest deployment: `https://upriver-dashboard-8928qt2rr-laxmikant1604s-projects.vercel.app` (2026-07-26), aliased to `https://upriverdashboard.vercel.app`.

## DataDoe reference (Deltologic GitHub) — reviewed 2026-07-26, for future features

Public org: https://github.com/Deltologic. Two repos are the most useful references for extending this dashboard:

- **`datadoe-api-starter`** (branch `development`) — official Next.js reference app on the DataDoe API. Mirror its patterns:
  - `src/lib/datadoe-client.ts` — canonical client. Confirms our conventions: `datadoe-api-key` header; on 429 read `retry-after` (our `ddFetch` already does this); responses/errors carry a `datadoe-api-request-id` header worth logging for support; error `message` can be an array (first = summary, full = details).
  - `src/app/api/datadoe/[...path]/route.ts` — a generic catch-all proxy that forwards any `/api/v1/*` path server-side. If we add more sources/actions, consider this pattern instead of one hand-written branch per action.
  - `src/types/api/exports.ts` — authoritative Exports request/response shape. **Capabilities we are NOT yet using but should:**
    - `filters: { combinator: "and"|"or", rules: [{ field, operator, value, not }] }` — server-side row filtering. This unlocks using **Order Line Items** with `amazon_order_status != "Cancelled"` for cleaner sales, or filtering an export to specific ASINs.
    - `dateInterval: "DAY"|"WEEK"|"MONTH"` — native period bucketing. The FBA Shipment Plan currently runs 3 separate month exports; one grouped export with `dateInterval:"MONTH"` + `groupBy:["child_asin"]` could replace them and cut refresh latency (the 25-40s risk).
    - `skip` (+ `limit`) — real pagination for large sources instead of a single large `limit`.
    - Real export statuses: `PENDING | IN_PROGRESS | COMPLETED | ERROR | BLOCKED_NO_TOKENS`. **Latent bug in our `api/datadoe.js` `pollExport`:** it checks `status === "FAILED"` (never emitted), so a failed export polls until timeout instead of erroring fast. Change to treat `ERROR` and `BLOCKED_NO_TOKENS` as terminal failures.
  - `AGENTS.md` — build discipline for this API: read README first; run a `/util/sellers-and-vendors` health check before coding; keep features simple; feature-based folders under `src/features/<name>/`.

- **`datadoe-ai-skills`** (branch `development`) — 18 skill blueprints (`skills/<name>/SKILL.md`), each a ready feature spec with the exact source, columns, and formulas. Direct candidates for new sidebar modules: `restock-priority-alert` (inventory, overlaps our FBA plan), `net-profit-pl-analyzer`, `ppc-wasted-spend-watchdog` / `ppc-bid-optimizer-apply` / `ppc-negative-keyword-applier`, `keyword-rank-sqp-tracker`, `sales-movers-scanner`, `return-refund-analyzer`, `buy-box-loss-root-cause`, `suppressed-inactive-listings-check`, `daily-account-health-check`, `weekly-business-review`, `create-orders-manager`, `create-amazon-reconciliation-dashboard`, `amazon-listing-optimizer`.
  - `restock-priority-alert` validates our FBA plan design (same `amazon_fba_inventory_health` source, latest-snapshot/MAX(date), inbound-aware, skip dead stock). It surfaces extra fields we could add later: `days_of_supply`, `units_shipped_t7/t30`, `fba_inventory_level_health_status`, and Amazon's own `recommended_ship_in_quantity` / `recommended_ship_in_date` (worth showing next to our computed Recommended Shipment as a cross-check). Note quirks it flags: `days_of_supply` is often null for slow SKUs (fall back to t30 velocity); FBA Inventory Health is not available in MX.

- There is also a hosted MCP server (`Deltologic/datadoe-mcp`, base `https://mcp.datadoe.com/mcp/v1`) exposing the same data as MCP tools — an alternative to the REST exports flow if we ever want tool-based access.

## Amazon accounts inventory

- 15 total accounts were previously observed through DataDoe.
- Marketplace count observed: IN (7), US (5), AU (1), CA (1), plus 1 US-marketplace account labelled "AU" in DataDoe data.
- Accounts with Amazon Ads connected: Indya Store IN, Haven&Hue US, JustHuman IN, Sashaa World IN, AAKRITI ART CREATIONS IN.
- Treat DataDoe's `/util/sellers-and-vendors` endpoint as authoritative for the current account list.

## How to resume cold

1. Read this file end to end.
2. Verify the live site works by hard-refreshing the Vercel deployment.
3. If it errors, read the on-screen error message; the app surfaces DataDoe errors verbatim.
4. Make code changes under `sales-dashboard-live/`, then commit and push.
5. Vercel should auto-deploy from the main branch.
6. If `git push origin main` returns 403 for `aibylk16`, reject the stale cached GitHub credential for `https://github.com` so Git Credential Manager can authenticate as `LaxmiKant1604`, then push again.
7. Update this file whenever a task is completed, new context is learned, or an important decision is made.
