# Project Memory

Last updated: 2026-07-01

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
- Local development command from the README: `npm install`, then `npm run dev`.

## Completed

- Initial project files exist for the Vite frontend, Vercel API route, package metadata, and README.
- `node_modules` and `dist` are present under `sales-dashboard-live`, suggesting dependencies have been installed and a production build has been generated at least once.
- Added this project memory file so future work has a durable handoff location.
- Fixed a DataDoe sales export failure caused by sending more than 5 `sellerOrVendorIds` in one export request. `sales-dashboard-live/api/datadoe.js` now chunks sales exports into batches of 5 and combines the returned rows.
- Vercel deployment is intended to auto-deploy from the main branch.
- Local commit `89c30f0 Batch DataDoe sales exports` was pushed to `origin/main` after clearing the stale cached GitHub credential.
- `DATADOE_API_KEY` is expected to be configured for Production, Preview, and Development in Vercel.
- DataDoe authentication is verified to use the custom `datadoe-api-key` header, not standard Bearer auth.
- DataDoe endpoint paths are verified as `/util/sellers-and-vendors` for accounts and `/exports` for export creation/data retrieval.
- Account list loading has worked with 15 accounts visible in dropdowns.
- Header UI updated: the top badge now reads `UPRIVER` instead of `PULSE`, and the account scope selector (`All Accounts`, `Single Account`, `Brand View`) moved into the header before the refresh/account status.
- Added a collapsible left sidebar shell around the existing dashboard in `src/App.jsx`. It has a brand/workspace header ("UR" logo, "Upriver Dashboard", `laxmikant@upriver.in`). Desktop supports a collapse button (icon-only mode); mobile/tablet uses an off-canvas drawer with a menu button, backdrop click, and close button. All existing filters, KPI cards, comparisons, chart, and breakdowns render unchanged inside the new `.main-area`. Icons use `lucide-react`.
- Added a "Daily Reporting" section as a second sidebar nav item. A `view` state (`"dashboard"` | `"daily"`) switches the main content; the account-scope tabs only show in dashboard view. The Daily Reporting view is single-account (defaults to Aakriti Art Creations, matched by name) with its own account dropdown and independent fetch (`dailyRows`, ~5 months of history via `action=sales`).
- Daily Reporting renders a table matching the user's screenshot: columns are 3 completed months + current-month MTD + the last 5 days (relative to the latest data date); rows are Total Sales, Ad Sales, Ad Spends, Clicks, Units, ROI (Ad Sales÷Ad Spend), ACoS % (Ad Spend÷Ad Sales), TACoS % (Ad Spend÷Total Sales). Table helpers: `monthBack`, `dailyReportColumns`, `DAILY_METRICS`. Wide table scrolls horizontally with a sticky metric column.
- Total Sales and Units populate from the existing sales source now. Ad Sales/Spend/Clicks (and the derived ROI/ACoS/TACoS) show "—" because no DataDoe advertising source is wired yet. The frontend reads ad fields optimistically via `pickNum` + candidate key lists (`AD_SALES_KEYS`, `AD_SPEND_KEYS`, `CLICKS_KEYS`), so the table auto-fills once the export includes real ad columns.
- Added a temporary discovery route to `api/datadoe.js`: `?action=fields` (optional `&sourceId=`). It probes candidate DataDoe source/column endpoints and returns their JSON so we can identify the advertising source id + column names. Remove this route after the ad source is confirmed. It exposes source metadata (not the API key) on the live URL while present.
- Migrated the sales source from `b24cd69c06` to the user-confirmed `401ffcd7e5` ("Sales & Traffic by ASIN & Date") app-wide. Columns used: `total_sales`, `total_units` (the export is aggregated per account per day because only date + seller_or_vendor_id dimensions are selected). `total_units` is normalized to `total_units_sold` server-side so the frontend is unchanged. This source has no order-count column, so the dashboard Orders and Avg. Order Value KPIs now show "—" (guarded by a `hasOrders` check) unless an orders column is added later.
- Wired advertising data from source `08cdc77d3d` (columns `ad_sales`, `ad_spend`, `ad_clicks`). The `action=sales` route merges ad rows into sales rows by (account, date) via `mergeSalesAndAds`, but only when called with `&ads=1` (the Daily Reporting view sets this; the main dashboard skips it to stay a single fast export). The Daily Reporting table's Ad Sales / Ad Spends / Clicks now populate, and ROI / ACoS % / TACoS % derive from them.
- Export helpers in `api/datadoe.js` were generalized: `createExport(apiKey, sourceId, columns, ids, from, to)` and `fetchExportRows(...)` work for any source; the per-export row limit was raised to `EXPORT_ROW_LIMIT = 10000`.

## In progress

- Verify the migrated numbers on the live site (both the main dashboard and the Daily Reporting ad rows) against Seller Central, since the sales source changed from `b24cd69c06` to `401ffcd7e5`.
- Temporary discovery routes `?action=fields` and `?action=sample` still exist in `api/datadoe.js`; remove them now that sources/columns are confirmed.

## Pending tasks and known follow-ups

- Verify sales numbers on the live dashboard match Seller Central expectations.
- Consider switching sales source from `b24cd69c06` (Profit by Date, settlement-based, roughly 7-day lag) to `401ffcd7e5` (Sales & Traffic by ASIN & Date, roughly 4-day lag, closer to Seller Central) if accuracy is off.
- Sidebar is intentionally a minimal foundation: only the "Dashboard" nav item exists for now. Add further report/module nav items (e.g. Profit, PPC, Inventory) into the `.sb-nav` block in `src/App.jsx` later, only when the user decides which modules are needed.
- Add Profit module for net margin analysis.
- Add PPC module for ad spend, ACoS, TACoS, and campaign performance.
- Add Inventory module for FBA stock, days-of-cover, and restock alerts.
- Currency conversion currently uses static approximate FX rates in `src/App.jsx`; consider wiring in a live FX API or creating a maintenance process for updates.
- Brand grouping is inferred from account names and may need manual validation after first real-data deploy.
- Confirm whether MeridianMarKet / MeridianmarKet / MeridienMarket should merge as one brand; currently they may be treated separately because spelling differs.
- YoY comparisons require roughly 13 months of account history.
- The most recent 1-2 days of Amazon data may change as settlement data finalizes.
- README text currently displays mojibake for some punctuation in this environment; consider normalizing the file encoding if editing it later.

## Key decisions

- Source ID `b24cd69c06` was chosen initially for daily account-level rollup. Trade-off: it is settlement-based and can lag Seller Central by roughly 7 days. `401ffcd7e5` may match Seller Central more closely but has not been swapped in.
- Static FX rates are hardcoded in `src/App.jsx` for now. This is simple and free, but rates need periodic updates or a live API later.
- Brand grouping is heuristic: account names are grouped by stripping marketplace codes. This needs manual handling for spelling edge cases.
- Project files should remain under `sales-dashboard-live/` unless Vercel's Root Directory setting is changed too.
- The sidebar currently stays simple with only the Dashboard item; additional report/module options should be added later only when requested.

## Technical learnings

- The dashboard combines multiple Amazon accounts and supports account/brand selection, KPI cards, DoD/WoW/MTD/YoY comparisons, a sales trend chart, and account/brand breakdowns.
- The browser should never receive the DataDoe API key; all authenticated DataDoe requests go through the serverless API route.
- When running local dev, the Vite dev server proxies `/api` to `localhost:3000`, so `vercel dev` may be needed separately for API routes.
- DataDoe's export creation API rejects `sellerOrVendorIds` arrays with more than 5 elements. Any all-account, marketplace, or large-brand request must be batched server-side.
- `npm run build` currently succeeds, but Vite warns that the generated JS chunk is larger than 500 kB.
- DataDoe REST API rate limit is understood to be 2 requests/second per organization; excess requests may return HTTP 429 with `Retry-After: 1`.
- DataDoe exports are asynchronous: POST `/exports`, poll `/exports/{id}` until status is `COMPLETED`, then GET `/exports/{id}/raw`.
- DataDoe API keys are shown only once at creation time. After that, only the prefix is visible in the UI.
- Vercel serverless functions cannot have spaces in the filename. A file named `datadoe (1).js` under `api/` would fail deployment with `invalid_function_name`; the active API route must remain `api/datadoe.js`.
- Changing Vercel environment variables does not auto-redeploy. Trigger a redeploy for new values to take effect.

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
