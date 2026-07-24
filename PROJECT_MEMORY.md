# Project Memory

Last updated: 2026-07-24

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

## In progress

- No active implementation work. The main dashboard now uses DataDoe Order Line Items (`89b275...`) rather than Profit by SKU & Date for its sales total.
- Temporary discovery routes `?action=fields` and `?action=sample` still exist in `api/datadoe.js`; remove them now that sources/columns are confirmed.

## Pending tasks and known follow-ups

- Verify sales numbers on the live dashboard match Seller Central expectations.
- Recheck very recent Order Line Items values after DataDoe completes its upstream synchronization. The 2026-07-23 Indya Store export was `INR 1,081` short of the downloaded Seller Central report because three units had zero `item_price_value` in DataDoe. The dashboard must not fabricate the missing revenue; click manual refresh after DataDoe has populated those order values.
- Repair or make optional the Daily Reporting advertising source `08cdc77d3d`: on 2026-07-24 it returned `404 Source not found`, which currently prevents a manual `action=daily` refresh even when the sales export succeeds.
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
  - Daily Reporting's configured advertising source `08cdc77d3d` currently responds `404 Source not found` from DataDoe. Since `action=daily` fetches ads after sales, the 404 aborts the whole manual daily response. The code should degrade gracefully to sales-only data until a valid ads source ID is discovered.
  - Main dashboard Order Line Items verification after deployment (2026-07-24): a full 420-day Indya Store refresh completed in 13.1 seconds and returned 5,539 date/brand rows. For 2026-07-23 it returned `INR 158,873.00` and `345` units. The attached Seller Central Order Report has the same `345` units and `INR 159,954.00`, leaving `INR 1,081.00` unexplained by dashboard logic. The DataDoe grouped data contains three units with zero order value, so the remaining difference is an upstream field-completeness delay, not the former shipped-versus-pending metric mismatch. Orders/AOV deliberately show unavailable for the new source because compact ASIN aggregation cannot deduplicate order IDs across ASINs without a substantially larger export.
- DataDoe API keys are shown only once at creation time. After that, only the prefix is visible in the UI.
- Vercel serverless functions cannot have spaces in the filename. A file named `datadoe (1).js` under `api/` would fail deployment with `invalid_function_name`; the active API route must remain `api/datadoe.js`.
- Changing Vercel environment variables does not auto-redeploy. Trigger a redeploy for new values to take effect.
- DataDoe AI Skills reference for Claude/Codex handoff and future report ideas: https://github.com/Deltologic/datadoe-ai-skills. Also review DataDoe Hub's AI skills/docs pages when designing new modules, especially reconciliation dashboards, orders manager, ASIN/search audit, export discovery, REST fallback, polling, and rate-limit guidance.

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
