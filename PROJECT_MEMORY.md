# Project Memory

Last updated: 2026-07-31 (account-scoped brand selector and Brand View deployed and verified)

## MANDATORY RULE FOR ALL FUTURE REPORTS — use the shared design system

Every current and future report must be built from the shared visual system in
`sales-dashboard-live/src/styles/theme.js` and the shared components in
`sales-dashboard-live/src/components/`. This is not a style preference; it is the
reason a single token change restyles all fourteen report views at once.

- **Never** hard-code a colour, radius, shadow or spacing value in a view. Use
  the tokens (`--bg-app`, `--bg-surface`, `--bg-elevated`, `--border-default`,
  `--border-hover`, `--text-primary`, `--text-secondary`, `--text-muted`,
  `--accent`, `--accent-soft`, `--positive`, `--negative`, `--warning`,
  `--info`, `--radius-sm/md/lg`, `--shadow-sm/md`, `--space-1..6`). If the
  system lacks something, add the token to `theme.js` — do not localise it.
- Charts must take their colours from the exported `CHART` object in `theme.js`
  (recharts needs literal values, so it cannot read CSS variables).
- Compose from the shared patterns rather than new markup: `AppShell`/`Sidebar`/
  `TopBar`/`AccountSelector`/`BrandSelector`/`DateRangeSelector`
  (`src/components/shell.jsx`); `MetricCard`, `ComparisonMetric`,
  `TrendIndicator`, `Sparkline`, `ChartCard`, `ChartTooltip`, `BreakdownCard`,
  `ContributionBar`, `MetricTooltip`, `StatusBadge`, `DataQualityAlert`,
  `SkeletonCard`/`SkeletonMetricGrid`/`SkeletonChart`/`SkeletonTable`,
  `EmptyState`, `ErrorState`, `SegmentedControl` (`src/components/ui.jsx`); and
  the report shell helpers in `src/views/shared.jsx`.
- Tables use the shared table system: `plan-scroll` + `plan-table` (or
  `recon-table-scroll` + `recon-table`), a sticky `thead`, a sticky `pt-id`
  identity column, right-aligned tabular numerals, `min-width` on the table so
  horizontal scrolling stays **inside** the container, and `recon-pagination`
  for paging. A report must never make the page itself scroll sideways.
- Light theme only. Do not add a dark mode or a theme toggle.
- Data honesty rules are enforced by the components and must be preserved: an
  unknown value renders as an em dash and never as zero; a trend or sparkline is
  omitted entirely when the earlier period does not exist rather than drawn from
  a guess; money always carries an explicit currency and is never converted or
  combined across currencies.
- Only an explicit manual Refresh may call DataDoe. Navigation, account/brand
  changes, date filters, sorting, search and pagination stay local.

## Multi-DataDoe connection readiness (2026-07-31)

The current deployment has **one** server-side DataDoe connection:
`DATADOE_API_KEY`. All DataDoe API routes and the Ads scheduler use that single
key, so adding a second DataDoe organisation by changing the environment value
would replace the first connection; it would not merge the two safely.

Supporting another DataDoe account is feasible and should be implemented as a
small connection layer before any second key is added:

- store a server-only connection record for each DataDoe organisation;
- associate every discovered `seller_or_vendor_id` with exactly one connection;
- select the correct key server-side for every export, account discovery and
  scheduled Ads sync;
- namespace shared snapshots/cache keys by connection as well as account, and
  reject duplicate/unassigned account IDs instead of guessing;
- keep both keys out of the browser, source code, logs and `PROJECT_MEMORY.md`.

For a fixed two-organisation setup, separate Vercel environment variables can
temporarily hold the keys. For an admin-managed, scalable setup, use encrypted
server-side connection records and an admin-only connection screen. Existing
user-to-Amazon-account permissions continue to apply after connection mapping;
they should never grant access merely because a second DataDoe organisation was
added. The dashboard owner later reported adding the secondary Vercel variable;
its presence and the second organisation's live account list still require the
production check recorded below.

### Two-connection implementation (2026-07-31; deployed)

The report API and automated Ads worker now support the existing primary
DataDoe organisation plus an optional second one configured as the sensitive
Vercel variable `DATADOE_API_KEY_SECONDARY`. The browser never receives either
key.

- Existing primary account IDs remain unchanged, preserving current user
  permissions, browser caches, Supabase snapshots, COGS overrides and Ads
  history. Secondary account IDs use the stable prefix `dd-secondary:`. The
  shared account selector labels secondary entries `Secondary DataDoe` so two
  similarly named stores can be distinguished.
- `/api/datadoe?action=accounts` discovers and merges accounts from every
  configured connection. Each account-scoped report resolves its selected
  public account ID to one key plus its raw DataDoe seller/vendor ID before
  exporting. It intentionally rejects a request containing accounts from more
  than one organisation: DataDoe exports must not mix credentials or data.
- Returned secondary rows are rewritten to their public prefixed account ID,
  which keeps dashboard aggregation, local filters and cache keys consistent.
  Insight-report snapshots use the public ID, while their live DataDoe exports
  still use the raw ID. PPC's persisted Ads history also uses the public ID.
- Scheduled Ads sync now discovers, partitions and exports accounts per
  connection, then saves secondary records under their prefixed ID. The same
  country cron jobs cover both organisations; no additional cron functions are
  required. A repeated API key or the same raw Amazon account appearing in both
  connections fails closed instead of duplicating sales or advertising data.
- The outstanding redesign review findings are fixed: date presets now use a
  truthful button group with `aria-pressed` rather than an incomplete ARIA
  radio group, and the Sales Trend tooltip preserves valid zero unit/order
  values while still omitting fields that a source did not provide.

**Verification completed locally:** server modules pass `node --check`; `npm
run verify` passes **53 assertions** (including primary ID preservation,
secondary row namespacing and mixed-organisation rejection) and compiles the
full application bundle. The secondary Vercel variable was reported added by
the dashboard owner, but its value was intentionally not read or logged.

**Deployment verification:** feature commit `a553c27 Support secondary DataDoe
account sync` is pushed to `origin/main` and deployed through the stable alias
`https://upriverdashboard.vercel.app`. The production HTML now serves bundle
`assets/index-D2gD8Dl7.js`; the protected `/api/datadoe?action=accounts` route
returns HTTP 401 without a Supabase session, confirming the deployment remains
protected and no API key is exposed.

**Required signed-in production check:** sign in as the administrator,
hard-refresh once, confirm the Account selector includes the secondary
organisation's accounts, select one of them and use manual Refresh on a report.
The next existing country-specific Ads cron then seeds that organisation's Ads
history; do not expose `CRON_SECRET` merely to force it manually. If an Amazon
account appears in both DataDoe organisations, remove one copy in DataDoe
before using the dashboard; the API will display a safe duplicate error rather
than double count it.

### Account-directory refresh follow-up (2026-07-31; deployed)

The dashboard intentionally opens from its cached account directory, so a new
DataDoe organisation does not appear merely from a hard refresh. This protects
the existing cache-first/no-automatic-DataDoe-fetch rule, but it made a newly
added secondary connection hard to discover. The header Account control now has
an adjacent icon-only **Refresh account list** button. It calls only the merged
`accounts` endpoint when explicitly clicked; it does not refresh reports or
fetch sales/Ads data. Administrators then see the new account(s) immediately;
non-admin users still need the administrator to assign each new account in User
Access.

Commit `67f0d68 Add manual account directory refresh` is pushed to `main` and
live at `https://upriverdashboard.vercel.app`; production serves
`assets/index-BxxvG0Yk.js` and the protected account API still returns HTTP 401
without a signed-in user. The administrator must now use the new header icon to
perform the authenticated merged-account check.

## Frontend redesign — premium light-theme workspace (2026-07-30, deployed)

The whole frontend was redesigned into a light-theme Amazon seller command
centre. **No business logic, calculation, API, route, permission or caching
behaviour was changed.** The work was presentation plus the two interaction
defects noted below.

### New files

- `sales-dashboard-live/src/styles/theme.js` — the entire design system as one
  token-based stylesheet, exported as `STYLE`, plus the `CHART` colour object.
  It replaces the ~340-line inline `STYLE` template literal that used to live at
  the bottom of `App.jsx`. Every screen still renders `<style>{STYLE}</style>`,
  so the import is a drop-in and the login/loading screens are styled too.
  Three surface levels only: `--bg-app` (canvas), `--bg-surface` (panels),
  `--bg-elevated` (KPI cards, dropdowns, interactive controls). Depth is 1px
  borders plus soft ambient shadows; transitions are 150–250 ms.
- `sales-dashboard-live/src/components/ui.jsx` — the reusable primitives listed
  in the rule above. They take pre-formatted values, so report calculations stay
  in the report.
- `sales-dashboard-live/src/components/shell.jsx` — `Sidebar`, `TopBar`,
  `AccountSelector`, `BrandSelector`, `DateRangeSelector`, and the `NAV_GROUPS`
  navigation model. Presentation only: every piece of state stays in
  `DashboardApp`.

### Changed files

- `sales-dashboard-live/src/App.jsx` — inline stylesheet removed and imported;
  sidebar and header markup replaced by the shell components; the dashboard view
  rebuilt on the new primitives; hard-coded chart hex values replaced with
  `CHART`; loading/empty/error states added.
- `sales-dashboard-live/index.html` — title is now
  `UPRIVER — Amazon Seller Analytics`; the Manrope + JetBrains Mono webfonts moved
  from a CSS `@import` inside the injected `<style>` to `<link rel=preconnect>` +
  `<link rel=stylesheet>` in `<head>`, so the browser starts fetching them during
  HTML parse instead of after the stylesheet evaluates. Added
  `color-scheme: light` and a `theme-color`.
- `sales-dashboard-live/src/views/shared.jsx` — the one inline amber banner style
  became the shared `alert warning` class. Nothing else changed; the six insight
  reports inherit the redesign through the shared class names.

### Palette (light only)

Cool-neutral canvas `#F3F5F9`, white surfaces, near-navy text `#111A2E`. The
interactive accent is a confident blue (`--accent #2C5FD6`) used for active nav,
selected controls, focus rings and the primary chart series. **UPRIVER gold
(`--brand #E0982A`) is now a controlled brand accent only** — the logo tile, the
workspace crumb and the Daily Reporting MTD column — instead of colouring the
whole UI. Green/red/amber/blue keep their semantic meanings. Text contrast was
measured and tuned: primary ≈15.5:1, secondary `#4E5769` ≈6.9:1 and muted
`#6B7488` ≈4.6:1 against white, so every text level clears WCAG AA.

### App shell

- **Sidebar**: 236 px expanded, 68 px collapsed, smooth width transition. All
  fifteen destinations are preserved with unchanged `view` keys and route
  behaviour, now grouped for scanning as Overview / Finance / Operations /
  Growth / Monitoring / Admin. The active item uses a subtle accent background
  plus a slim 3 px accent indicator, not an oversized pill. Collapse and Sign
  out remain at the bottom. Collapsed items rely on native `title` tooltips
  deliberately: a CSS popover would be clipped by the rail's own vertical scroll
  container.
- **Mobile**: off-canvas drawer with a backdrop, a close button, and Escape to
  dismiss. The Collapse toggle is hidden on mobile because it has no meaning
  there.
- **Top command bar**: breadcrumb `UPRIVER · Amazon Seller Portfolio › <page>`
  on the left; Account selector, Brand selector and the refresh status cluster
  (label, live/idle dot, last-refreshed time, account name, Refresh button) on
  the right. The selectors are still native `<select>` elements — keyboard and
  mobile behaviour and the exact change semantics are unchanged — wrapped in a
  labelled icon+label+value+chevron control that truncates instead of
  overlapping.

### Main dashboard

Information architecture preserved exactly: header → global date filter →
data-quality alert → primary KPIs → performance comparisons → Sales Trend →
Sales by Account → Sales by Brand.

- **Date filter**: a compact segmented radio group (Yesterday / 7D / 30D / 90D /
  MTD / YTD / Custom) with the resolved range shown beside it. Preset maths,
  custom inputs and min/max clamping are the existing logic.
- **Data-quality alert**: the real unpriced-units warning is now a compact warm
  amber alert with a short headline plus detail, sized so it cannot outweigh the
  KPIs it qualifies.
- **KPI cards**: small label, dominant tabular-numeral value, `translateY(-2px)`
  hover with a slightly stronger border and shadow. **New, and computed only
  from the same cached rows:** a period-over-period change against the
  immediately preceding window of equal length, and a tiny SVG sparkline of the
  real per-day series. Both are withheld — not zeroed — when the earlier period
  starts before the first date this scope actually reported, and the sparkline
  renders nothing below three real points. Orders and Average Order Value still
  show an em dash when the source reports no order count.
- **Comparisons**: DoD / WoW / MTD / YoY as compact cards with period label,
  percentage, direction arrow and comparison basis. Direction is never colour
  alone — every value carries an arrow and an explicit sign.
- **Sales Trend**: the analytical centrepiece in a larger `ChartCard`. Same real
  data and the same Daily/Weekly/Monthly tabs; subtle area gradient, dashed
  hover crosshair, highlighted active point, and a custom tooltip that shows
  Date, Sales and — only when the source actually supplied them — Units and
  Orders. Trend buckets now also carry units/orders for that tooltip. Animation
  runs on data change only and is disabled entirely under
  `prefers-reduced-motion` (recharts animates in JS, so it is told separately
  via a `matchMedia` hook).
- **Sales by Account / Brand**: one visual language — name, sales value,
  contribution percentage and a horizontal contribution bar, aligned rows,
  `Unassigned` deliberately muted. Currency comes from the selected marketplace;
  INR is not hard-coded anywhere.

### States

Skeletons whose geometry matches the real content (metric grid, chart bars,
table rows), plus distinct honest states for: no account selected, nothing saved
for this account yet, saved but no sales in this range, nothing to plot, and a
real upstream failure showing the verbatim message with a retry action. A new
shared `SnapshotGate` renders exactly one of error / skeleton / "nothing saved
yet" for the five cache-first reports. **A cache miss is no longer a red error
banner** — it is a first-run empty state with a Refresh action, tracked in
`rowsCacheMissing` / `snapshotNotice` separately from real errors. Daily
Reporting no longer renders its matrix when nothing is saved, because that
printed a full grid of zeroes that looked like genuinely reported sales.

### Two interaction defects fixed (both were open follow-ups in this file)

1. **Duplicate manual refreshes.** The header Refresh button is now disabled for
   every view while that view's own request is in flight, and `fetchRows`,
   `fetchDaily` and `fetchPlan` gained in-flight guards. Repeated clicks could
   previously launch concurrent 25–45 s DataDoe exports for the dashboard, Daily
   Reporting and the FBA plan, spending quota twice.
2. **Mobile page overflow.** The seven-preset date control forced the whole page
   36 px wider than a 390 px viewport, because flex items default to
   `min-width:auto`. The row and the control can now shrink, so the control
   scrolls inside itself and the page never scrolls sideways.

### Verification actually performed (2026-07-30)

- `npm run verify` — **50 insight assertions pass**, and `build:check` produced a
  1,057 kB bundle with the expected >500 kB chunk warning, proving the full app
  compiled rather than being tree-shaken away.
- **Browser verification, which this file previously listed as the highest-value
  outstanding check, is now done.** A temporary local harness (`devpreview.html`
  + `src/devpreview.jsx`, both deleted before commit, plus a temporary export of
  `DashboardApp` that was reverted) seeded the browser cache the app already
  reads on open and rendered the real `DashboardApp`, so the redesign could be
  driven in Chrome via Playwright without production Supabase credentials. The
  seeded numbers were synthetic and existed only in that throwaway harness; no
  mock data exists in the application.
  Swept at **1440, 1180, 860 and 390 px**, and at every viewport: every one of
  the fifteen navigation destinations was opened, all seven date presets plus the
  custom range exercised, all three granularities switched, the chart hovered,
  and the brand filter applied and cleared. Result: **zero page-level horizontal
  overflow at any viewport, zero console or page errors, and zero `refresh=1`
  requests** from navigation, brand changes, date changes, granularity changes or
  sorting. Confirmed rendering: 4 KPI cards, 4 comparison cards, 4 sparklines,
  15 nav items, the chart and its hover tooltip, and the brand filter narrowing
  the brand breakdown from 5 rows to 2 locally. The mobile drawer opens from the
  menu button and closes with Escape; the collapsed desktop rail measures 68 px.
  Report tables scroll inside their own container with the sticky identity column
  intact.
- Note on the shared-report requests seen during the sweep: opening one of the
  six insight reports does issue a `/api/datadoe` request **without** `refresh=1`.
  That is the documented shared-snapshot read, which never touches DataDoe, and
  it is unchanged by this work.

### Deployment (2026-07-30)

Commit `7bee6ac Redesign frontend as a light-theme analytics workspace` pushed to
`origin/main` and deployed to production from the repo root with the Vercel CLI:
deployment `dpl_7rYzRqwL6sFxxUgmUekP3ecU1EXr`
(`https://upriver-dashboard-iy9uacrxr-laxmikant1604s-projects.vercel.app`),
`readyState: READY`, aliased to `https://upriverdashboard.vercel.app`.

Post-deployment verification: the production alias returned **HTTP 200**; the
served HTML carries the new `UPRIVER — Amazon Seller Analytics` title, the
`color-scheme: light` hint and the webfont `<link>` tags; the served bundle
(`/assets/index-DPdRMajb.js`) contains the redesign markers `sb-group-label`,
`crumb-current`, `refresh-cluster`, `metric-spark`, `chart-tip-swatch`,
`--bg-elevated` and "Nothing saved for this account yet". Access control is
unaffected: `/api/datadoe?action=accounts` without a Supabase token still returns
**HTTP 401**, and `/api/access?action=bootstrap-status` still returns
`{"initialAdminExists":true,"confirmationPending":false}`. The bare deployment
URL returns 302 (Vercel deployment protection on the non-aliased host), which is
the project's normal behaviour — verify through the alias.

### Independent Codex review (2026-07-31; no production change)

`npm run verify` was independently rerun after the deployment: all 50 insight
assertions passed and the full 1,057 kB application bundle compiled. The public
production alias was also checked: it returns the new light-theme sign-in page
with the expected title and authentication controls. Authenticated report data
was not inspected in this review because no production user session was used.

Two polish fixes remain before describing the redesign as fully accessibility-
and data-display-complete:

1. **Date range keyboard semantics:** `DateRangeSelector` in
   `src/components/shell.jsx` uses `role="radiogroup"` and `role="radio"`, but it
   does not implement the required Arrow-key/roving-tabindex behaviour of an
   ARIA radio group. Either implement that keyboard model or change the wrapper
   to a neutral `role="group"` and retain ordinary buttons. Do not leave a
   keyboard-incomplete radio pattern.
2. **Chart tooltip zero values:** `DashboardApp` builds trend buckets with
   `units: 0` and `orders: 0`, then only renders a tooltip row when each value is
   truthy. A genuine zero-unit/zero-order bucket is therefore hidden, and the
   bucket has no field-presence flag to distinguish an unavailable metric from
   a real zero. Preserve `hasUnits`/`hasOrders` while aggregating rows and use
   those flags when rendering the tooltip. This keeps the product rule that
   unknown values are omitted without hiding real zero values.

These are review findings only. No application code or deployment was changed
on 2026-07-31; the live alias remains the deployment recorded above. Resolve
the two items in a focused follow-up, rerun `npm run verify`, perform a
signed-in browser check, then deploy and update this section with the commit.

### Remaining limitations

- The six insight reports, Reconciliation, SKU P&L, FBA plan, Keyword Rank and
  Content Alerts inherit the redesign through the shared class names and were
  verified for layout, overflow and their empty/error states, but **not with real
  populated data in a browser**, because that needs a signed-in production
  session. Their table markup and calculations were not touched.
- No screenshot was attached to the redesign request in the session that
  produced this work, so the layout follows the written specification (refined
  sidebar, command-bar header, compact filters, strong KPI hierarchy, main chart,
  two-column breakdown) rather than a pixel reference.
- The bundle is still a single ~1,057 kB chunk. Code-splitting recharts and the
  report views behind dynamic imports remains the obvious performance follow-up.
- `sales-dashboard-live/datadoe (1).js` and the diagnostic `?action=fields` /
  `?action=sample` routes are still present; unrelated to this work.

## Six insight reports — built on branch `feature/six-insight-reports` (2026-07-29, NOT deployed, NOT merged)

All six approved read-only modules are implemented on the branch
`feature/six-insight-reports` (base `main` at `497c7cc`). **Nothing was merged to
main and nothing was deployed**, as instructed. Codex review is the next step.

### Commits, in phase order

| Commit | Phase |
| --- | --- |
| `1c3eb22` | Insight engine + Sales Movers + Listing Health + Buy Box Loss |
| `1278c05` | Returns & Refund Leakage |
| `626280e` | PPC Performance & Wasted Spend |
| `78658d1` | Listing & Search Optimizer |
| `a4d6f7d` | Cross-report Priority Feed |
| `ad39fc4` | Senior-review fixes (currency mixing, truncation, midnight-blank reports) |

### New and changed files

New server modules:
- `lib/server/datadoe.js` — the DataDoe transport, extracted from
  `api/datadoe.js` so all thirteen reports share one 2-req/sec rate limiter, one
  export poller, one row-cap policy and one set of UTC date helpers. Adds
  `fetchExportRowsStrict`, which refuses a result sitting on the row cap.
- `lib/server/report-store.js` — the shared snapshot contract (below).
- `lib/server/reports/sources.js` — every source id, column, grain, default-
  enablement flag and fetch window, validated against the live data scheme.
- `lib/server/reports/common.js` — catalog map, source freshness, FBA snapshot.
- `lib/server/reports/{sales-movers,listing-health,buy-box,returns,ppc,listing-optimizer}.js`

New client modules:
- `src/lib/format.js`, `src/lib/csv.js` — display and CSV helpers moved out of
  `App.jsx` so the report views format money, dates and units identically.
- `src/lib/insights.js` — the Insight Engine and all six reports' rule sets.
- `src/views/shared.jsx` — report shell, freshness strip, Priority Actions,
  insight card, sortable header, pagination, currency-scope helpers.
- `src/views/{SalesMovers,ListingHealth,BuyBoxLoss,ReturnsLeakage,PpcPerformance,ListingOptimizer,PriorityFeed}.jsx`

Changed: `api/datadoe.js` (imports the shared transport; six new actions),
`lib/server/supabase.js` (`releaseRefreshLock`, `getLatestReportSnapshot`,
`getAdsDailySourceRows`), `lib/server/ads-sync.js` + `api/cron/[scope].js` +
`vercel.json` (search-terms Ads source, 16 crons), `src/App.jsx` (seven sidebar
items, shared-report data layer, insight CSS), `package.json` (scripts).

### Non-negotiable architecture — how each rule is met

- **Shared Account/Brand scope only.** No report has a page-level account or
  brand selector. Brand filtering is applied client-side in every builder, and
  each payload returns `catalogBrands` so the header selector works from these
  reports alone.
- **Server-enforced permissions.** `getDashboardAccess(req)` runs before any
  branch in `api/datadoe.js`; all six actions are in `ACCOUNT_SCOPED_ACTIONS`, so
  `assertAccountAccess` rejects an account the user is not assigned. Each action
  additionally requires exactly one account id.
- **Only Refresh calls DataDoe.** A request without `refresh=1` reads the saved
  Supabase snapshot and never touches DataDoe. Navigation, brand changes,
  filters, search, sorting, paging, level tabs, the Buy Box threshold and the PPC
  break-even input are all local recomputation.
- **Shared snapshot + refresh lock.** `serveSharedReport` claims
  `claim_report_refresh_lock` before any export, so two people pressing Refresh
  cannot spend DataDoe tokens twice; the validated payload is saved to
  `report_snapshots` for every permitted user and a compact `dashboard_events`
  row is published. The lock is released in a `finally`, so a failed refresh does
  not block retries. There is also a client-side in-flight guard per report.
- **PPC reads persisted Ads history.** Every advertising figure comes from
  `ads_daily_source_rows`. No Ads export runs from the report path at all, even
  on Refresh. The only DataDoe call PPC makes is one small total-sales export for
  TACoS, and losing it degrades TACoS to unavailable without breaking the report.
- **Currencies stay separate.** Nothing converts. Combined money totals render an
  em dash when a scope holds more than one currency, per-row money keeps its own
  currency, and the Priority Feed groups by currency and never adds across them.
- **No summed percentages.** ACoS, TACoS, CTR, CVR, CPC, ROAS, conversion,
  margin, return rate, impression share and Buy Box share are all recomputed from
  summed numerators and denominators.
- **No fake zeroes.** Unknown values render as an em dash. A missing snapshot, a
  disabled source, a missing FBA snapshot, an unseeded Ads account and a lagging
  sales source each have their own explicit state.
- **Read-only.** No Amazon write action, bid change or negative keyword anywhere.

### Sources used, all validated against the live data scheme on 2026-07-29

Validated against `https://api.datadoe.com/api/v1/spec/data-scheme` (public,
unauthenticated). `default:false` tables are not enabled for every organisation
and every such export is wrapped to return an actionable Settings > Data tables
message instead of a server error.

| Table | Full id | default | Used by | Documented window |
| --- | --- | --- | --- | --- |
| `amazon_sales_and_traffic_with_cogs` | `401ffcd7e50c1ea9a18cacf221ddf99858db20a0f31eff65fc22a8e8140c7e1b` | yes | Movers, Returns rate, PPC TACoS | INITIAL 35 / DAILY 4 / MONTHLY 30 |
| `amazon_profit_by_sku_and_date` | `57a0cb31...` | yes (premium) | Buy Box, Listing Health, Movers ads | CONTINUOUS, intraday |
| `amazon_listings_with_cogs` | `ba689c05...` | yes (premium) | Listing Health | CONTINUOUS, no date column |
| `amazon_listings_raw` | `6ea445cdc459f9fbb9517c5c009384da60ef31a1e70d4de9187ea3d4c28535c4` | **no** | Listing Health issue codes (optional) | CONTINUOUS, no date column |
| `amazon_fba_inventory_health` | `44fc5ba0...` | yes (premium) | Buy Box prices, Movers stock, Listing Health | INITIAL 1 / DAILY 1 (snapshot only) |
| `amazon_returns` | `27c6fc0ec69648b5fed4612dbd9ccdfdeaaca6787f8f985c01266e4dc11f9038` | yes | Returns reasons | INITIAL 60 / DAILY 60 |
| `amazon_settlements_with_cogs` | `732dac68...` | yes | Returns money | INITIAL 730 / DAILY 21 |
| `amazon_products_by_child_asin` | `68d2de23...` | yes | all (brand), Optimizer (content) | CONTINUOUS, no date column |
| `amazon_ads_performance_by_campaign_by_date` | `08cdc77d...` | yes | PPC campaigns | 56 / 21 / 49 |
| `amazon_ads_performance_by_child_asin_and_date` | `d0017e92...` | yes | PPC ASINs (same-SKU attributed) | 60 / 21 / 49 |
| `amazon_ads_targeting_by_campaign_by_date` | `bbba3d21...` | **no** | PPC targets (**SP + SB + SD**) | 56 / 21 / 49 |
| `amazon_ads_search_terms_by_campaign_by_date` | `e94e9671989ce4aa2814ac729807c7ddcc1cc47a71ebcd75d9fe661ed80335be` | **no** | PPC search terms (**SP + SB only**) | 60 / 21 / 49 |
| `amazon_child_product_organic_search_ranks_per_week` | `81aa5b4c...` | **no** | Optimizer | INITIAL 21 / WEEKLY 7 |

Newly discovered facts worth keeping:
- `amazon_returns` has **no quantity column and no currency column**, and
  `amazon_return_refunded_amount` / `amazon_return_label_cost` exist for **FBM
  returns only**. One row is one returned item. All refund money therefore comes
  from settlement REFUND rows, which cover FBA and FBM and carry a currency.
- `amazon_sales_and_traffic_with_cogs` has **no currency column**; its money is
  in the account's currency.
- `amazon_products_by_child_asin` has **no `seller_or_vendor_id` column** — it is
  marketplace-level and filtered by the export's account ids.
- `amazon_listings_with_cogs.listing_status` is the enum `Active / Inactive /
  Incomplete`, and `listing_fulfillment_channel` is `DEFAULT` (= FBM) /
  `AMAZON_NA` / `AMAZON_EU` / null.
- Buy Box share has **no dedicated table**. `buybox_percentage` lives on
  `amazon_profit_by_sku_and_date` at SKU/day grain.

### Formulas and rules per report

**Sales Movers.** Two equal 7-day windows, both ending at the latest date Sales &
Traffic actually reported units (never today, because that source's recurring
window is 4 days). Because `sales = sessions x (units/sessions) x (sales/units)`,
the change is split exactly into a traffic effect, a conversion effect and a price
effect that sum to the total change; the dominant driver is the largest of the
three. An ASIN with no sessions or no units in either week shows **Not
attributable** instead of a guessed driver. Buy Box is deliberately not diagnosed
here (it needs a page-view-weighted average of daily rows). A uniform,
traffic-shaped collapse across most of the catalogue triggers a data-completeness
warning instead of a page of false alarms.

**Listing Health.** Gates in order: reported ERROR issue, missing
buyable/discoverable flag, `Inactive`, `Incomplete`, stock on hand with no active
or buyable offer (stranded), Active with no price, then WARNING/INFO. Ranked by
trailing 30-day `total_sales` for that SKU — money that stops, not a forecast.
Units on hand uses the FBA snapshot for FBA offers and the merchant quantity for
FBM offers and **never adds them**, because they are two views of the same stock.
Without the non-default raw-issues table nothing is labelled Suppressed.

**Buy Box Loss.** 28 days of raw daily rows in 7-day slices (rejecting any slice
that hits the cap), folded into a **page-view-weighted** Buy Box share so a
2-page-view day cannot count as much as a 2,000-page-view day. Days where Amazon
reported no featured-offer competition are **excluded**, not scored 0%, because a
sole seller has lost nothing. Sales at risk = `sales x (1 - share)`. Cause is
named only from present evidence: your price above `featuredoffer_price` is
Price; zero or near-zero `available` against the 30-day run rate is Stock; a
selling SKU with no FBA row at all is Fulfilment; otherwise **Unconfirmed** with
confidence dropped.

**Returns & Refund Leakage.** Ranked by money, not rate. Leakage = settled
customer refunds + seller-borne return fees (return commission + FBA
customer-return per-unit fee, less any restocking fee recovered, clamped at zero).
`COGS on refunded units` is displayed but **excluded**, because the source does
not say whether returned stock came back sellable. Rate is Amazon's own
`units_refunded / units_shipped`; when refunds exceed shipments inside the window
the returns belong to earlier sales, so the rate is withheld as **lag\*** rather
than shown above 100%. A cause is named only when one reason bucket is at least
half of that product's returns. Refunds are separated from pending and cancelled
activity structurally: a refund exists only once a REFUND settlement posts, a
cancelled order never settles, and a pending return shows as a pending request.

**PPC Performance & Wasted Spend.** Ads figures come only from Supabase.
**Dead spend** is the whole spend of a row with clicks and no attributed orders,
and only above a 10-click minimum. A **break-even breach** counts only the spend
*above* the break-even ACoS as wasted, because the sales up to that point are
still worth buying. Scaling candidates are separate opportunities. Coverage is
stated per level and Search Term results are never labelled as covering
Sponsored Display.

**Listing & Search Optimizer.** SQP reports both the ASIN's counts and the whole
query's totals, so "below market" is a measurement: impression share = your
impressions ÷ query impressions, and CTR/CVR vs market is your rate ÷ the same
query's rate. Gates in order: relevance guard (low share + both below market),
discoverability, exposure, click-rate, conversion. A query missing the market
denominators is left **unclassified**. Organic rank uses the **best** rank
observed, never an average. Title checks apply Amazon's published 2026 rules for
non-media categories (75 characters, no promotional words, no disallowed symbols,
no word more than twice). Insights carry **no money value**, because SQP reports
purchase counts and inventing a price would be fabrication.

**Priority Feed.** Re-derives the six reports' insights from the same snapshots,
dedupes repeats per (report, category, product) keeping the most severe, and
groups by currency. It deliberately does **not** merge across reports: a Buy Box
loss and a returns problem on the same ASIN are different problems with different
fixes.

### Verification actually performed

- `npm run test:insights` — **47 assertions pass** (`scripts/test-insights.mjs`),
  covering decomposition exactness, the no-averaged-ratios rule, gate ordering,
  evidence-gated causes, the click minimum, break-even partial waste, the
  currency-withholding fix, ranking, dedupe, CSV formula-injection escaping and
  em-dash-not-zero rendering.
- `npm run build:check` — clean build, ~1,010 kB bundle with the expected
  >500 kB chunk warning. New view strings confirmed present in the bundle.
- `node --check` on every server module; `import()` of `api/datadoe.js` to prove
  every import resolves; `vercel.json` parsed (16 crons).
- Access control audited in code: the auth gate is the first statement in the
  handler and all six actions are account-scoped.

**IMPORTANT — a build-verification gap was found and fixed.** `src/lib/supabase.js`
exports `supabase` as null when `VITE_SUPABASE_URL`/`VITE_SUPABASE_PUBLISHABLE_KEY`
are absent, and `App.jsx` then returns an early "Login setup incomplete" screen.
Vite inlines `import.meta.env` at build time, so in a workspace without those
variables Rollup proves `supabase` is null and **dead-code-eliminates the entire
dashboard** — LoginScreen, DashboardApp, every report view, recharts and
lucide-react. A plain `npm run build` produced a ~180 kB bundle with no chunk
warning while compiling almost none of the app. Any past "npm run build passed"
claim made in a workspace without those variables verified very little. Use
`npm run build:check` (or `npm run verify`), which injects placeholder public
values; a bundle well under ~900 kB, or a missing chunk warning, means the app was
tree-shaken away and the build did not verify it.

### Senior self-review — defects found and fixed in `ad39fc4`

- **Currency mixing (correctness).** The Movers advertising export is grouped by
  `child_asin` AND `currency` but was folded on ASIN alone, adding two currencies
  into one spend number. Now withheld per ASIN with a `mixedCurrency` flag.
- **Currency mixing (presentation).** Combined money totals in Buy Box, Listing
  Health, Returns and PPC summed across currencies. Now an em dash plus an
  explanation via `moneyScope`/`totalMoney`.
- **Silent truncation.** The shared catalog and FBA snapshot reads were not
  strict. A truncated catalog silently drops brands and makes the header brand
  filter hide real rows; a truncated inventory snapshot makes an absent SKU look
  like zero stock and produces a **false stockout claim**. Both now reject.
- **Understated leakage.** The returns fee component could go negative when a
  restocking fee exceeded the return fees. Clamped at zero.
- **Reports blank every midnight.** Snapshot scope includes the as-of date, so the
  exact key stopped matching at midnight and all six reports looked unsaved. The
  server now falls back to the latest saved snapshot and the UI labels it as an
  earlier as-of date. This also resolves the long-standing FBA Shipment Plan
  stale-cache follow-up.
- **Wrong refresh target.** Refresh on the Priority Feed would have refreshed the
  main dashboard. Now disabled there with a tooltip.

### Open issues for Codex review

1. **No live DataDoe validation was possible from this workspace.**
   `DATADOE_API_KEY` is not present locally (`vercel env pull` at the repo root
   provides only the Supabase and Postgres variables), and production must not be
   deployed. So **no report has yet run against a real account**, and the
   requested IN and US account validation is outstanding. Every source id, column
   name, grain and window was validated against the public data scheme, and only
   export shapes already proven in this repo are used (`groupBy` + `sum`
   aggregations, plain column selects, `orderByColumn`, omitted from/to for
   date-less sources), but the first real refresh of each report still needs
   observing on a preview deployment.
2. **`aggregation: "avg"` was deliberately never used**, because it is unproven
   in this repo. That is why Buy Box fetches raw daily rows in slices. If a live
   test confirms DataDoe supports `avg`, Buy Box could collapse to one grouped
   export and lose most of its latency.
3. **Latency risk.** Buy Box runs 4 sliced exports plus a snapshot; Returns runs 3
   plus a catalog; Movers runs 6. `maxDuration` is 60 s. These need timing on real
   accounts, especially large catalogues; the observed 25–46 s of existing
   six-month reports suggests Movers and Buy Box are the ones to watch.
4. **16 cron entries** now exist (four Ads sources × four country scopes).
   Confirm this is within the Vercel plan's cron limit before deploying; the
   project previously had 12 registered.
5. **Search Term Ads history starts at first sync.** Adding
   `search-terms-performance-v1` means its 60-day initial seed only happens on the
   next scheduled run after deployment. Until then the PPC search-term level
   correctly reports no saved rows rather than zero spend.
6. **Browser-level verification is outstanding.** No Playwright runtime is
   available in this workspace, so mobile overflow, sticky identifier columns and
   the "zero DataDoe requests on navigation/filter/sort" behaviour were built to
   the proven existing patterns and reasoned through, but not observed in a real
   browser. This is the highest-value remaining check.
7. **Any authorised viewer can trigger a Refresh** and therefore spend DataDoe
   quota. This matches the existing reports' behaviour, but if refresh should be
   restricted to editor/admin, that is a one-line change in each action.
8. **Priority Feed is a seventh sidebar item.** Phase 5 asked for a global feed
   and it needed a home; flagging it against the "only the six requested sidebar
   items" instruction.
9. **`report_snapshots` growth.** Each report keeps one row per
   (report, account, params_hash) and the as-of date is part of the hash, so a new
   row accumulates per account per day. An 8 MB per-snapshot guard exists, but a
   retention job that deletes superseded snapshots is still needed to protect the
   Supabase free-tier 500 MB.
10. **Pre-existing cleanup, untouched:** the temporary `?action=fields` and
    `?action=sample` diagnostic routes remain in `api/datadoe.js`, and the stray
    `sales-dashboard-live/datadoe (1).js` file still exists.

### How to review

```
git checkout feature/six-insight-reports
cd sales-dashboard-live
npm run verify          # 47 assertions + a real (non-tree-shaken) build
```
Then deploy a **preview** (not production), sign in, and for one IN and one US
account press Refresh once per report, confirming: the shared snapshot is saved,
a second browser sees it without its own refresh, a concurrent Refresh is
rejected by the lock, and navigation/brand/filter/sort/paging produce zero
`/api/datadoe` requests.

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
- Latest production deployment with SKU P&L Analyzer and Content Change Alerts completed on 2026-07-27. Commit `6391bd3` added both reports; commit `752d6d5` added an actionable disabled-source response for Content Alerts. Deployment URL: https://upriver-dashboard-aidb49f1v-laxmikant1604s-projects.vercel.app. Production alias remains https://upriverdashboard.vercel.app. Build and `node --check` passed; the homepage returned HTTP 200; Content Alerts returned the expected HTTP 424 setup message while its source is disabled and rejected a two-account request with HTTP 400 before DataDoe access.
- Latest production deployment with the standalone SKU P&L Brand-selector review fix completed on 2026-07-27. Commit `32f01da Populate brands from SKU P&L` returns distinct P&L brands with the selected account ID and hydrates the shared header selector after a P&L refresh. Deployment URL: https://upriver-dashboard-r3j0dajj1-laxmikant1604s-projects.vercel.app. The production alias https://upriverdashboard.vercel.app returned HTTP 200 after deployment.
- Latest production deployment with the unpriced-order-unit dashboard warning completed on 2026-07-27. Commit `d91951c Flag unpriced order units in dashboard` preserves `unpriced_units` from the Order Line Items response, shows a visible all-brand warning, and uses cache version `order-items-v2-quality`. Deployment URL: https://upriver-dashboard-btarbwi5i-laxmikant1604s-projects.vercel.app. Production verification for JustHuman IN / 2026-07-26 returned `INR 79,510` across 60 priced units and a separate 6-unit zero-value group; the production alias returned HTTP 200.
- Latest production deployment with longer DataDoe export polling completed on 2026-07-27. Commit `a03b90c Allow longer DataDoe export polling` changes the shared polling window from roughly 18 seconds to roughly 40 seconds at DataDoe's recommended five-second cadence. Deployment URL: https://upriver-dashboard-qfa5iuf09-laxmikant1604s-projects.vercel.app, aliased to https://upriverdashboard.vercel.app. A retried one-day JustHuman Sales & Traffic request completed successfully but returned no 2026-07-26 rows, confirming that the alternate source has not caught up and is not a safe fallback for this recent date.
- FBA inventory data-path audit completed on 2026-07-27. Account-level checks found complete current snapshots: JustHuman IN had 24 raw SKU rows and Indya Store IN had 207, both below the 15,000-row cap. Exact Amazon reconciliation for JustHuman `JH-100-PC-2` / `B08YGQJJ6D` exposed a source-field overlap: Amazon showed Available 48, Inbound 126, FC transfer 0, FC processing 12, and customer-order reserve 2, while DataDoe's 2026-07-27 row returned Available 50, `reserved_fc_transfer` 126, `reserved_fc_processing` 13, and `inbound_shipped` 126. The 126 shipment was being counted twice by the prior dashboard formula. The FBA plan now uses `max(0, reserved_fc_transfer - inbound_shipped)` for the FC-transfer reserve, retains In Transit from `inbound_shipped + inbound_received`, and uses cache version `fba-plan-v2-transfer-dedupe` so a manual refresh cannot reuse the old totals. The remaining 2 Available and 1 FC-processing difference is upstream snapshot timing/rounding; customer-order reserve remains intentionally excluded from shipment planning.
- Latest production deployment with the FBA transfer/inbound de-duplication completed on 2026-07-27. Commit `7975b33 Deduplicate FBA transfer inventory`; deployment https://upriver-dashboard-i8jytbo10-laxmikant1604s-projects.vercel.app is aliased to https://upriverdashboard.vercel.app. Production verification for JustHuman `JH-100-PC-2` / `B08YGQJJ6D` returned FBA Available 50, adjusted FC Transfer 0, FC Processing 13, Inbound Shipped 126, and Inbound Received 0, so the 126 shipment is no longer counted under both Reserved and In Transit.
- Latest production deployment with SKU P&L COGS overrides completed on 2026-07-27. Commit `40cb991 Add SKU COGS overrides`; deployment https://upriver-dashboard-h8i24ymu3-laxmikant1604s-projects.vercel.app is aliased to https://upriverdashboard.vercel.app. The COGS-column pencil opens an account/SKU/currency-scoped per-unit editor. Saving persists the browser-local override, recalculates COGS, total cost, profit, margins, statuses, KPIs, and CSV export without a DataDoe request; reset restores the DataDoe value. Production HTML served `index-D7OKhlGz.js` containing the `upriver-cogs-overrides-v1` marker.
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

- **Amazon Ads data-scheme fetch-window audit (2026-07-29):** verified the public DataDoe specification `https://api.datadoe.com/api/v1/spec/data-scheme` and documented all 26 `AMAZON_ADS` tables in `sales-dashboard-live/supabase/DATADOE_AMAZON_ADS_FETCH_WINDOWS.md`. Nine dated performance reports declare fixed initial/recurring windows: ASIN performance, Search Term Performance, and Purchased Products = **60 initial / 21 daily / 49 monthly**; Campaign performance, Keyword Targeting, Sponsored Brands Ad Performance, and **Ad Group Performance** = **56 initial / 21 daily / 49 monthly**; Placement = **56 initial / 28 daily / 56 monthly**; Ads Brand Metrics = **95 initial / 95 weekly**. Sixteen raw/configuration/AMS tables are `CONTINUOUS` with no stated numerical historical backfill; Sellers & Vendors Context has no date/fetch period. Crucial interpretation: these are DataDoe source-fetch/re-correction windows, **not an explicit deletion or permanent query-retention policy**. A new Ad Group connection initially gets 56 days; after that, history can accumulate and the recurring window should be UPSERTed so late attribution corrects recent data. **Month-wise and day-wise reports are possible for every future month** when the dated rows are synced into Supabase now: retain each daily date row, re-upsert the rolling correction window, and aggregate any selected calendar month locally/server-side. Months before the initial DataDoe backfill cannot be reconstructed unless DataDoe already retained them or they are imported from another audited source. The planned Supabase store preserves all successfully synced history from the first sync onward.
  - **Required sync semantics clarified:** initial seed imports the source's available days; every daily job re-fetches the whole documented recent window (normally 21 days, Placement 28) and UPSERTs by the report's natural daily grain, so it replaces late-attribution values rather than duplicating them. A monthly correction job re-fetches 49/56 days (Brand Metrics 95 days weekly). Thus “after 21 days” is not a waiting period: a daily row is repeatedly refreshed while inside the rolling window, then retained as the final known history in Supabase. The UI reads Supabase only; manual refresh is selected-account-scoped and uses a database lock to avoid duplicate DataDoe exports. Full implementation specification is in `sales-dashboard-live/supabase/DATADOE_AMAZON_ADS_FETCH_WINDOWS.md`; this sync is still pending application code.
  - **Ad-product coverage verified:** `Keyword Targeting Performance` (`amazon_ads_targeting_by_campaign_by_date`) is **SP + SB + SD**: its DataDoe dependencies are the SP, legacy SB, and SD targeting raw reports. `Search Term Performance (Ads)` (`amazon_ads_search_terms_by_campaign_by_date`) is **SP + SB only**, not SD: its documented `ad_campaign_type` values are `SPONSORED_BRANDS or SPONSORED_PRODUCTS` and its dependencies include only SB/SP search-term reports. Any future PPC UI must retain `ad_campaign_type` and not label Search Term results as full three-product coverage.
  - **Core Ads date-grain clarified:** Keyword Targeting Performance, Ad Performance by ASIN & Date, and Ad Performance by Campaign & Date all include daily `date` data. Their grains differ: targeting/keyword + campaign/date, child ASIN/date, and campaign/date respectively. Month-wise reports are created by summing the appropriate daily source rows; do not compare raw row counts or join the tables without respecting their different attribution grains. Campaign/date is the compact account/campaign total source, ASIN/date is product attribution, and targeting/date supports keyword/target analysis with SP/SB/SD split by `ad_campaign_type`.
- **Repository privacy hardening completed and deployment-proven (2026-07-28):** user changed `LaxmiKant1604/Upriver-Dashboard` to private. Post-change verification passed: authenticated `git ls-remote origin HEAD` returned commit `7a19e109...`, confirming Codex can still fetch/push to the private remote; Vercel project inspection still reports the correct linked project `upriver-dashboard`, Root Directory `sales-dashboard-live`, and Node 24.x. The proof commit `d321045` pushed successfully to the private remote and triggered a new production deployment, `https://upriver-dashboard-f1m6cykfg-laxmikant1604s-projects.vercel.app`, which completed `Ready` in 12 seconds. Supabase is independent of repository visibility and remains connected through Vercel. Public forks, if any, remain public/detached; privacy does not retract code already copied. Sources checked 2026-07-28: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility and https://vercel.com/docs/git.
- **Supabase provisioned and schema applied (2026-07-28):** after the team accepted Vercel Marketplace terms, Vercel provisioned the Free-plan `upriver-shared-data` Supabase resource in Mumbai (`bom1`) and connected it to `upriver-dashboard` Production, Preview, and Development. It injected `POSTGRES_*`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and `VITE_SUPABASE_*` values; the root `.env.local` was pulled locally and remains gitignored. The versioned migration `sales-dashboard-live/supabase/migrations/20260728_shared_dashboard.sql` is now applied through the reusable `npm run db:migrate` runner. Verified live tables: `account_permissions`, `ad_daily_metrics`, `app_schema_migrations`, `cogs_overrides`, `dashboard_events`, `report_refresh_locks`, `report_snapshots`, and `user_profiles`. A server-only REST read through `api/supabase.js` passed using the Vercel-provided secret; no credentials were printed or committed. The migration uses a private `dashboard-snapshots` bucket for large payloads and publishes only compact `dashboard_events` rows to Realtime. The local migration runner sets the marketplace pooler's `sslmode=no-verify` compatibility mode because the Windows Node trust store rejected its chain; it remains encrypted and is used only for direct migrations, while deployed app access uses HTTPS Supabase REST. **Current status:** the database foundation is live, but no report path, COGS edit, login, role UI, or Realtime subscription is wired yet, so dashboard behavior and browser-local cache are unchanged. Next implementation: migrate a compact selected-account report to `report_snapshots` with an explicit refresh lock, then migrate COGS and remaining reports incrementally.
  - **Owner login/access decision:** this Supabase organization was created through Vercel Marketplace, so Vercel has a one-to-one organization relationship and synchronizes Vercel team roles to Supabase. Use the existing Vercel owner account as the primary administrator; open Supabase Studio through the Vercel Integration/Storage dashboard. Do **not** create a separate Supabase email/password owner for this marketplace-managed project. For direct `supabase.com` dashboard access outside Vercel, use **GitHub OAuth with the same primary email address as the Vercel account**; Supabase documents that email/password login is disabled for accounts created via the Vercel Marketplace. Enable MFA on the Vercel identity and retain a secure backup TOTP factor. Sources checked 2026-07-28: https://supabase.com/docs/guides/integrations/vercel-marketplace and https://supabase.com/docs/guides/troubleshooting/email-password-login-disabled-supabase-vercel-marketplace-a7dd36.
  - **Administrator access confirmed (2026-07-28):** the project administrator successfully signed in to the Supabase dashboard using GitHub. This is management access only; it is separate from the future Upriver dashboard user-login feature. No Supabase Auth provider or application user should be manually created yet because the React login screens, callback URLs, role-assignment workflow, and server authorization checks have not been implemented.
  - **Supabase console verification (2026-07-28):** the administrator confirmed the expected `upriver-shared-data` project in Supabase Studio. The console shows the organization is Vercel Marketplace-managed, the database region as AWS `ap-south-1` (the Mumbai/India selection requested as `bom1` through Vercel), the Free/Nano plan, 26 MB of 500 MB database capacity in use, and zero egress/active users/file storage at this initial setup stage. No additional Supabase-console provisioning action is needed now; do not create another project or click `New project`.
- **Shared advertising-history store (confirmed 2026-07-28, implementation pending Supabase):** DataDoe's verified `Ad Performance by Campaign & Date` source is `08cdc77d3dc24a7651553e2e926f598188c66172f64cd6512265900af6073a6c` (`amazon_ads_performance_by_campaign_by_date`). Its initial connection backfill is 56 days; after that DataDoe re-fetches the most recent 21 days daily and 49 days monthly, so late attribution changes can revise recent figures. A Supabase `ad_daily_metrics` history table is the correct solution: sync the available date range through one controlled server refresh/cron, then upsert by account + date + campaign + campaign type (not append) so corrected values replace the prior snapshot. Dashboard reports will read Supabase first and only the controlled sync will call DataDoe, preventing every user/browser from spending API tokens. This preserves history **from the first successful sync onward**; it cannot recreate dates older than the initial 56-day DataDoe backfill. The current Daily Reporting source constant uses the abbreviated `08cdc77d3d` prefix; verify/replace it with the full source ID as part of the Supabase ads-sync implementation, then reconcile actual ad sales/spend/clicks before relying on it.
- **Keyword Rank & Share Tracker (completed and deployed 2026-07-28):** added a `Keyword Rank` sidebar report backed by the DataDoe skill https://github.com/Deltologic/datadoe-ai-skills/tree/DOE-2733-skill-metadata-categories/skills/keyword-rank-sqp-tracker. It uses only the shared header Account/Brand scope and the existing cache-first/manual-refresh pattern: navigation, account/brand/ASIN/search/signal filters, and sorting are local; only Refresh calls `action=keyword-rank`. Backend is single-account enforced and uses Weekly SQP source `81aa5b4cc248bb70de405b9ff9d51290b9232f84570d76ba2a1289b67b6595fb` (`amazon_child_product_organic_search_ranks_per_week`) over an 84-day window. It fetches Monthly SQP source `df4160ff8e1add239172a69ebd6c8abfec7116ee4a17720983757b1b55599830` when fewer than four weekly periods exist, and shows an explicit baseline rather than fabricating a trend when fewer than two comparable periods remain. The UI calculates impression/click/purchase shares from the query totals, tracks only converting money keywords, compares recent periods to prior periods, and flags Lost, Slipping, Rising, Emerging, Stable, or Baseline with a concrete action. Exports that hit the 50,000-row cap are rejected rather than silently truncated. Both SQP tables are non-default in DataDoe; an organisation-disabled source returns HTTP 424 with DataDoe Settings > Data tables enablement instructions. Commit `020a300 Add keyword rank SQP tracker`; production deployment https://upriver-dashboard-gs29ejhxw-laxmikant1604s-projects.vercel.app is aliased to https://upriverdashboard.vercel.app. Verification: `node --check api/datadoe.js` and `npm run build` passed. A live one-account AAKRITI request on 2026-07-28 returned weekly mode with 8 complete SQP periods (2026-05-24 through 2026-07-12), proving the weekly source and source fields work on this organisation. A two-account request returned HTTP 400 `Keyword Rank requires exactly one selected account.` before DataDoe access. Browser-level visual interaction still needs a manual production refresh because the local Playwright browser runtime is unavailable in this workspace.
- **Shared online cache and COGS persistence (requested 2026-07-27):** the current cache and SKU COGS overrides live in each browser (`localStorage` / IndexedDB), so one user's manual refresh or COGS edit is not visible to other users. The requested next architecture is a durable server-side store: one user explicitly refreshes a selected report/account scope, the server obtains DataDoe data once, saves the successful snapshot, and all users then read that same snapshot without spending another DataDoe request. COGS overrides must move to the same shared store and be keyed by account, currency, SKU, and ASIN. A per-report/scope refresh lock is also required so simultaneous clicks cannot start duplicate DataDoe exports. **Decision:** use a Vercel Marketplace PostgreSQL integration (recommended: Neon) rather than Vercel Blob because report/COGS changes need immediate, concurrent, queryable updates; no database credentials are connected to this project yet. Do not claim this is active until `DATABASE_URL` is provisioned and the server/client paths are implemented and deployed.
  - **Cost decision:** Neon currently offers a no-time-limit $0 Free plan with no credit card required, 0.5 GB storage per project, and 100 CU-hours of compute per project/month. It is appropriate for the initial shared cache if the application retains only the latest successful snapshot for each report/scope and purges superseded snapshots. Monitor usage because the reconciliation response can be about 23 MB per account/scope; move to paid usage-based Neon only if the retained data or traffic grows beyond the free allowance. Source checked 2026-07-27: https://neon.com/pricing.
  - **Alternatives reviewed:** Supabase is also managed Postgres (starts at $0) and adds built-in authentication/realtime, making it a good choice if user accounts/permissions are added soon. Upstash Redis is excellent for short-lived cache entries and distributed refresh locks, but it is not the right sole durable store for COGS history and larger report snapshots. Firebase Firestore has a free quota and realtime updates, but would require a different NoSQL/auth client architecture from the existing Vercel serverless app. Vercel Blob is file storage, not suitable as the primary mutable collaborative data store. Keep Neon Postgres as the recommended single-service starting point; revisit Supabase only if dashboard login/roles/realtime subscriptions become a near-term requirement. Sources checked 2026-07-27: https://vercel.com/docs/marketplace-storage and https://vercel.com/marketplace/supabase.
  - **Supabase selected (2026-07-27):** user confirmed that login, roles, and live update notifications are near-term requirements, so Supabase replaces Neon as the recommended shared platform. It will provide Postgres for report snapshots/COGS overrides, Supabase Auth for user login, Row Level Security for roles, and Realtime for cache/COGS change notifications. Vercel CLI verification found no Supabase resource currently connected; install the Supabase Marketplace integration into `upriver-dashboard` before implementation. Do not expose `SUPABASE_SECRET_KEY` to the browser; only the publishable key and URL may be used by the frontend, while all DataDoe calls and privileged writes remain server-side.
  - **Supabase Free-plan verification (2026-07-27):** the official plan is $0/month with 500 MB database storage, 50,000 monthly active users, 5 GB egress, and Realtime (2 million messages/month, 200 concurrent peak connections). It is adequate to start the shared-cache/auth feature, but a free project pauses after one week of inactivity and has no automatic backups; its first request after a long idle period can be delayed. Use a compact notification payload (cache key/timestamp, never a whole report) because Free Realtime messages max out at 256 KB. Monitor retained report snapshots and upgrade to Pro only when storage, production-reliability, or backup requirements demand it. Source checked 2026-07-27: https://supabase.com/pricing.
  - **Claude storage decision (2026-07-28):** do not use Claude, Claude Code, or an AI-assistant workspace as the Upriver application's business-data store. They can retain code and project documentation such as this file, but they are not the dashboard's shared transactional database and do not provide the required application-owned persistence, row-level authorization, realtime subscriptions, refresh locking, or scheduled report upserts. Store shared report snapshots, advertising history, COGS overrides, users, and roles in Supabase; keep DataDoe credentials and privileged writes server-side. Claude/Codex remain development assistants and handoff-document writers only.
  - **Google storage clarification (2026-07-28):** "Claude" is Anthropic's product, not a Google storage service. Google Drive is suitable only for optional report exports/backups (for example, CSV/XLSX snapshots); it is not suitable as the live shared dashboard database because concurrent updates, query performance, application authorization, and realtime synchronization would be fragile. If the team prefers Google infrastructure, Google Cloud Firestore plus Firebase Authentication can satisfy the shared-cache, login/role, and live-update requirements, while Cloud SQL/Postgres is another valid Google Cloud alternative. Supabase remains the selected implementation because it provides the required Postgres, Auth, RLS, and Realtime features together with less application infrastructure. Do not use Google Drive or Google Sheets as the primary live store.
  - **Expected live-data flow after Supabase implementation (2026-07-28):** when an authorized user explicitly refreshes a report for one account/scope, the server fetches DataDoe once, validates the result, and saves/upserts the snapshot in Supabase. Every dashboard session then reads that shared saved snapshot rather than making its own DataDoe call. Supabase Realtime broadcasts only a small "snapshot updated" event; open dashboards receive it and reload the saved data, so users see the refreshed values without manually refreshing the browser. This is not active yet: until Supabase is connected and the current local cache is migrated, data remains per-browser in IndexedDB/localStorage.
- **Dashboard order-report sales reconciliation:** the attached Seller Central Order Report `C:\Users\laxmi\Downloads\793915020661.txt` definitively totals JustHuman IN on 2026-07-26 at `INR 84,673` item price across 66 sale units (57 shipped lines = `INR 78,924`; 9 pending lines = `INR 5,749`; 5 cancelled lines = zero; item tax = zero). The live DataDoe Order Line Items source still returns `INR 79,510` across those same 66 units: 60 priced units under JustHuman plus 6 zero-price/unassigned units, a precise `INR 5,163` understatement. Sales & Traffic by ASIN & Date has no row at all for this date, so it cannot be used as a fallback. The dashboard does not fabricate the missing amount; it retains and displays `unpriced_units` as a data-completeness warning. This is a **high-severity upstream DataDoe synchronization defect** for recent order values: request a DataDoe/Amazon order-data resync before treating this date as final. A permanent code fix requires a DataDoe source that contains the missing order values or an explicitly approved Seller Central report-import workflow; neither is available in the current server-side credentials.
- **Sales-source comparison (2026-07-27):** checked every currently connected sales-capable DataDoe report for JustHuman IN / 2026-07-26 against the `INR 84,673` Seller Central Order Report benchmark. Order Line Items (`89b275...`) is closest but incomplete at `INR 79,510` / 66 units / 6 zero-price units. Profit by Date (`b24cd69c06`) and Profit by SKU & Date (`57a0...`) both return `INR 73,761` / 51 units because they are settlement/profit-oriented and omit pending or not-yet-settled activity. Sales & Traffic by ASIN & Date (`401ffcd7e5`) returns no rows for this date because of its multi-day freshness lag. Settlements & P&L Components (`732dac...`) is payout/posting-date data, not an order-day sales total. **Decision:** do not swap the dashboard to any of these reports for recent Seller Central Order Report sales; use Order Line Items with its completeness warning until DataDoe resolves the missing values, or add an audited Seller Central report-import override.
- **Export polling reliability:** a one-day JustHuman Sales & Traffic export timed out because `pollExport` stopped after about 18 seconds (`12 × 1.5s`), below DataDoe's normal completion window. `pollExport` now uses nine five-second attempts (about 40 seconds after the first check), still within Vercel's 60-second function limit. Retesting completed successfully, but Sales & Traffic returned no 2026-07-26 row for JustHuman, so its multi-day freshness lag makes it unsuitable as a fallback for the latest Order Line Items date.
- **Content Change Alerts:** implementation is deployed and the route is verified, but live events are blocked until this DataDoe table is enabled for the organization. In DataDoe, open **Settings > Data tables** and enable **Branded Item Content Change Notifications**, then use the dashboard's Refresh button. It is a cache-first selected-account report that extracts ASINs from notification payloads, resolves them through the Product Catalog where possible, and applies the shared brand filter only to attributable events. This source has no sales, inventory, or profit metrics and must not be used for those reports.
- **SKU P&L Analyzer:** deployed. It uses the reviewed Profit by SKU & Date source over six full calendar months, keeps currencies separate, computes all ratios locally from summed amounts, and shares the global Account/Brand scope. It remains cache-first; only the header Refresh button fetches DataDoe data.
  - **Verification completed 2026-07-27 (Claude, `action=sku-pl` against the preview and production `/api/datadoe`):** Haven&Hue US returned exactly `2026-01..2026-06`, one currency `["USD"]`, 134 SKU rows; each per-month bucket contains only the seven summed fields (`sales,profit,cost,adSpend,fees,cogs,units`) and **no ratio fields** — margin/ACoS/blended are recomputed in the browser. Guards verified: a 5-month range, a mid-month start, and a two-account request each return HTTP 400 before any DataDoe access. AAKRITI IN returned `["INR"]`, 1,769 rows, no truncation (well under the 50k monthly cap). Currency separation confirmed (USD vs INR never combined). Cross-source sanity check: AAKRITI June Profit-by-SKU sales `₹632,639` vs the documented Sales & Traffic June sales `₹633,481` = 0.13% apart (expected profit-vs-sales-source gap; not fabricated). Profit identities hold exactly on 500 real buckets: `profit = total_sales − total_cost` and `total_cost = total_fees + ad_spend + cogs_total` (0 violations). Missing-COGS handled correctly: AAKRITI has COGS on 0 of 1,769 SKUs, so every row is flagged **Check COGS** rather than shown as a real high margin. UI (Playwright, built bundle): month switch, currency selector (shown only when >1 currency), search, status filter, sort, and header brand filter (e.g. "Caruso Italy" → only Caruso rows) are all local — **0 `/api/datadoe` calls** across nav, account change, month, search, filter, sort, and brand change (cache-first confirmed); refresh has an in-flight guard and is disabled while loading. Mobile 390px: table scrolls inside its container with a sticky Product/SKU column and **no page-level horizontal overflow** (`document.body.scrollWidth === innerWidth`); no console errors. Payload ~817 KB for AAKRITI, so the report is cached in IndexedDB (`upriver-report-cache`) with a localStorage fallback, reportVersion `sku-pl-v1`.
  - **Codex review fix (2026-07-27):** a standalone SKU P&L refresh previously did not populate the shared header Brand selector when the selected account had no prior dashboard catalog cache. The API now returns distinct P&L `catalogBrands` plus its `accountId`, and the frontend feeds them into the existing account-scoped header state. This retains local filtering and makes the shared scope usable from this report alone; a fuller dashboard catalog cache is still merged when present.
  - **Decision — ACoS column:** the mandated aggregation set excludes `ad_sales`, so classic ACoS (ad spend ÷ ad sales) is not computable. The table/CSV column is therefore labelled **"Ad/Sales %" = ad spend ÷ total sales** (computed from the allowed sums) and the footer states this explicitly, rather than mislabelling a total-sales ratio as ACoS. If a true ACoS is required later, add `ad_sales` to `SKU_PL_AGGREGATIONS`.
  - **Latency risk:** a six-month refresh runs six sequential, rate-limited monthly exports and took ~20–46s in testing — under the 60s `maxDuration`, but a very large catalog on a slow DataDoe day could approach it. The `datadoe-api-starter` `dateInterval:"MONTH"` option could collapse the six exports into one and cut latency; it is unverified in this repo and left as a follow-up (monthly batches were kept because they are explicitly endorsed and proven).
  - **Concurrency note:** this feature was committed by a concurrent process as `6391bd3 Add SKU P&L and content alerts` (bundled with the unrelated Content Change Alerts feature) and deployed to production as `7415186`/`aidb49f1v` before this verification ran — i.e. it is already live on `https://upriverdashboard.vercel.app`, not deployment-pending.
- **Amazon Reconciliation Dashboard:** completed and deployed on 2026-07-26. The new sidebar report uses the shared Account/Brand header scope, reconciles six *full* calendar months of Order Line Items with Settlements & P&L Components, and performs month switching, charts, Order Explorer filtering/sorting/pagination, copy-order-ID, and Excel-compatible CSV export locally after an explicit refresh. It makes settlement posting dates and cross-month timing visible rather than calling normal Amazon timing differences errors. Confirmed settlement source: `732dac689a6545697c2f2e36c61b2c9e93187053bcce2999914183c6f490df27`; financial fields: `item_price`, `item_tax`, `referral_fee`, `fba_per_unit_fulfillment_fee`, `refunded_amount`, and `total` (not the generic skill's `sum_*` aliases). Named-brand reconciliation intentionally keeps only single-brand orders because settlement events are order-level and cannot be allocated accurately across items in a mixed-brand order.
- **Delivery protocol:** for future Claude/Codex changes, the implementing agent must update this memory with completed work, in-progress/pending work, decisions, technical learnings, and verification. Codex must then perform a senior-engineer review, resolve material findings, verify the deployed behavior, and record a concise completion/deployment summary before declaring the task finished.
- FBA Shipment Plan review follow-up is open: address month-rollover completeness and duplicate-refresh protection before treating shipment recommendations as production-accurate in all periods. The main dashboard now uses DataDoe Order Line Items (`89b275...`) rather than Profit by SKU & Date for its sales total.
- Temporary discovery routes `?action=fields` and `?action=sample` still exist in `api/datadoe.js`; remove them now that sources/columns are confirmed.

## Pending tasks and known follow-ups

- Verify sales numbers on the live dashboard match Seller Central expectations.
- Recheck very recent Order Line Items values after DataDoe completes its upstream synchronization. The 2026-07-23 Indya Store export was `INR 1,081` short of the downloaded Seller Central report because three units had zero `item_price_value` in DataDoe. The dashboard must not fabricate the missing revenue; click manual refresh after DataDoe has populated those order values.
- Obtain a DataDoe/Amazon order-data resync for JustHuman IN on 2026-07-26: the supplied report proves the `INR 5,163` shortfall across six zero-price source units. Do not substitute a hard-coded correction. If DataDoe cannot provide a complete order source, decide whether to add a user-driven Seller Central Order Report import that is stored as an auditable account/date override.
- Revalidate Daily Reporting advertising metric accuracy after any DataDoe source change. The source `08cdc77d3d` returned `404 Source not found` on 2026-07-24, but a deployed `action=daily` request for AAKRITI returned HTTP 200 with seven daily rows on 2026-07-26; the earlier hard-failure is no longer reproducible.
- Enable **Branded Item Content Change Notifications** in DataDoe **Settings > Data tables**, then click Refresh once in Content Alerts and verify events/ASIN-to-brand attribution. Until then, the report intentionally shows an actionable setup error and makes no automatic request.
- Reconcile the first successful SKU P&L Analyzer refresh against Seller Central / the DataDoe Profit by SKU & Date export, including the reported currency, sales, profit, and COGS flags.
- Consider switching sales source from `b24cd69c06` (Profit by Date, settlement-based, roughly 7-day lag) to `401ffcd7e5` (Sales & Traffic by ASIN & Date, roughly 4-day lag, closer to Seller Central) if accuracy is off.
- Sidebar now includes Dashboard, Daily Reporting, Reconciliation, FBA Shipment Plan, SKU P&L Analyzer, and Content Alerts. Add later report modules only when the user defines their scope.
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
- The sidebar contains only implemented report modules; add additional report/module options only when requested.
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
- Deltologic organization review (2026-07-26): use `datadoe-ai-skills` as the primary feature-blueprint library. Current directly relevant skills are `create-orders-manager`, `create-amazon-reconciliation-dashboard`, `weekly-sales-briefing`, and `amazon-asin-search-auditor`; read the exact `SKILL.md` before designing one of these modules. The organization also publishes `datadoe-mcp-codex`, a secure project-scoped Codex MCP template: keep the MCP key in an environment variable, configure the `datadoe` MCP server with `env_http_headers`, retain repo-specific agent rules/prompts, and never put the real MCP key in `.codex/config.toml`, source code, screenshots, or git history.
- SKU P&L Analyzer reference reviewed (2026-07-26): https://github.com/Deltologic/datadoe-ai-skills/tree/DOE-2733-skill-metadata-categories/skills/net-profit-pl-analyzer. Use the premium **Profit by SKU & Date** source (`57a0cb319c10a395853afc0671579bf7ef0ff45d8a40c88ed9d2a5f61b4169a4`) as the canonical P&L source because it already joins settlements, COGS, and advertising. Aggregate `total_sales`, `profit`, `total_cost`, `ad_spend`, `total_fees`, `cogs_total`, and `total_units_sold` by SKU/product/currency. Never sum ratio fields such as ACoS, TACoS, or ROI; recompute ratios from the summed amounts. Keep currencies separate, use full calendar months (fees settle in batches), rank by profit rather than sales, and flag negative profit, margin below half the blended margin, ad spend above profit, and suspiciously high margin as possible missing COGS.
- DataDoe source `aec3d5976911a7a80110c08801a741e4f0a25dd997d639f5d918284d905a4758` reviewed on 2026-07-27: **Branded Item Content Change Notifications** (`amazon_notifications_branded_item_content_change`). It is a Seller Central real-time event feed for A+ content / brand-registered ASIN changes, typically available within about two hours of Amazon publishing the change. Fields: marketplace and seller context, `sp_api_notification_id`, `sp_api_notification_type`, `event_time`, `notification_metadata`, and raw `payload`. It is useful for a future content-change alert/audit module, not sales, inventory, profit, or P&L reporting.
- Production source check (2026-07-27): DataDoe returned HTTP 400 because `Branded Item Content Change Notifications` is currently disabled for this organization. The dashboard route now turns this into an actionable HTTP 424 message rather than a generic server failure. Enabling the table in DataDoe **Settings > Data tables** is required before any notification events can be validated or displayed.
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
    - Real export statuses: `PENDING | IN_PROGRESS | COMPLETED | ERROR | BLOCKED_NO_TOKENS`. `pollExport` now treats `ERROR` and `BLOCKED_NO_TOKENS` (plus legacy `FAILED`) as terminal failures, so users receive the real upstream error instead of a misleading timeout.
  - `AGENTS.md` — build discipline for this API: read README first; run a `/util/sellers-and-vendors` health check before coding; keep features simple; feature-based folders under `src/features/<name>/`.

- **`datadoe-ai-skills`** (branch `development`) — 18 skill blueprints (`skills/<name>/SKILL.md`), each a ready feature spec with the exact source, columns, and formulas. Direct candidates for new sidebar modules: `restock-priority-alert` (inventory, overlaps our FBA plan), `net-profit-pl-analyzer`, `ppc-wasted-spend-watchdog` / `ppc-bid-optimizer-apply` / `ppc-negative-keyword-applier`, `keyword-rank-sqp-tracker`, `sales-movers-scanner`, `return-refund-analyzer`, `buy-box-loss-root-cause`, `suppressed-inactive-listings-check`, `daily-account-health-check`, `weekly-business-review`, `create-orders-manager`, `create-amazon-reconciliation-dashboard`, `amazon-listing-optimizer`.
  - `restock-priority-alert` validates our FBA plan design (same `amazon_fba_inventory_health` source, latest-snapshot/MAX(date), inbound-aware, skip dead stock). It surfaces extra fields we could add later: `days_of_supply`, `units_shipped_t7/t30`, `fba_inventory_level_health_status`, and Amazon's own `recommended_ship_in_quantity` / `recommended_ship_in_date` (worth showing next to our computed Recommended Shipment as a cross-check). Note quirks it flags: `days_of_supply` is often null for slow SKUs (fall back to t30 velocity); FBA Inventory Health is not available in MX.

- There is also a hosted MCP server (`Deltologic/datadoe-mcp`, base `https://mcp.datadoe.com/mcp/v1`) exposing the same data as MCP tools — an alternative to the REST exports flow if we ever want tool-based access.

### Report opportunity review (2026-07-29)

DataDoe's published skill catalogue was rechecked at
https://github.com/Deltologic/datadoe-ai-skills and its public data scheme at
https://api.datadoe.com/api/v1/spec/data-scheme. The current Upriver modules
already cover Dashboard, Daily Reporting, Reconciliation, FBA Shipment Plan,
SKU P&L, Keyword Rank, and Content Alerts (pending the source being enabled).
Do not build duplicates. Recommended next modules, in priority order, are:

1. **PPC Performance & Wasted Spend:** campaign/ASIN/keyword/search-term
   performance, spend, attributed sales, ACoS/TACoS, zero-sale click waste,
   break-even breaches, and concrete bid/negative-keyword suggestions. This is
   the highest-value next module because shared daily Ads history is already
   persisted in Supabase. Preserve campaign type; Search Term data is SP+SB,
   while Keyword Targeting is SP+SB+SD.
2. **Returns & Refund Leakage:** SKU/ASIN returns, refund value, return rate,
   reason buckets, COGS/profit impact, and money-ranked fixes. It identifies
   whether the best action is product, sizing, listing, or delivery work.
3. **Sales Movers & Weekly Business Review:** week-over-week SKU gains/losses
   diagnosed by traffic, conversion, price, buy box, ads, margin, and stock;
   paired with a compact owner/manager weekly summary and actions.
4. **Listing Health / Suppressed Listings:** inactive, incomplete, suppressed,
   stranded, or error-state SKUs ranked by sales at risk; prevents silent sales
   loss. Add Buy Box root-cause as a drill-down for price, availability, and
   fulfilment causes.
5. **Account Health Monitor:** Account Health Rating, order-defect, late
   shipment, valid tracking, cancellation, and policy violations against
   Amazon targets. This is a risk-prevention report, not a sales report.
6. **Orders Manager:** searchable order/line-item operations view with order
   status, FBA/FBM, business order, geography, product/SKU, and local workflow
   tags. It is best for customer-service and operations teams.
7. **Listing / Search Optimizer:** combines SQP, catalog and listings to show
   search-funnel gaps, title/content quality, and ASIN search visibility. Use
   only after the team is ready to act on copy/content changes; it is less
   urgent than PPC, returns, or listing health.

Important data limits: Order Line Items are near-real-time but can be delayed
up to about an hour; Sales & Traffic can lag up to four days; Profit/settlement
metrics are better for settled profitability than same-day ordered sales; Ads
attribution should continue to be re-upserted over its rolling correction
window. Keep currency separate, use shared Account/Brand scope, read Supabase
snapshots first, and make external DataDoe refreshes controlled rather than
per-browser.

**Approved next-report roadmap (2026-07-29, planning):** user selected six
new read-only modules: PPC Performance & Wasted Spend, Returns & Refund
Leakage, Sales Movers, Listing Health / Suppressed Listings, Buy Box Loss, and
Listing & Search Optimizer. Build in phased, independently verified commits:
first shared insight/alert primitives plus Sales Movers, Listing Health and
Buy Box; then Returns; then PPC from persisted Ads data; then Listing/Search
Optimizer; then an optional cross-report priority feed. Every module must use
the existing global Account/Brand header scope, server-enforced permissions,
shared Supabase snapshot/cache-first behavior, explicit refresh only, and
mobile-safe tables. The requested "AI" experience means evidence-bound,
deterministic insights: severity, money/revenue at risk, named contributing
metrics, data freshness/confidence, and a recommended action. Do not generate
unsupported claims or use any Amazon write action without a later explicit
approval. Claude/Codex must read each referenced DataDoe `SKILL.md` and the
data scheme before implementation, update this memory after every stage, run a
senior code review, deploy only after source-level and browser-level checks.

**Six-report senior review (2026-07-29, remediation completed locally):**
`npm run verify` now passes 49 assertions and a full non-tree-shaken Vite build.
Review fixed the following correctness risks before merge:

- PPC rollups now include currency in their identity, so a campaign/ASIN/target
  or search term reported in multiple currencies never has its money or ratios
  combined. Account-wide PPC KPIs and TACoS are intentionally unavailable for a
  multi-currency scope rather than fabricated; the UI labels this distinction
  accurately instead of describing it as an export failure.
- Priority Feed uses campaign-level PPC insights only. Search-term, target and
  ASIN views overlap that campaign spend and remain drill-down views, so adding
  them to the feed would double-count waste.
- Pagination of persisted Ads source rows is now ordered by metric date plus
  its remaining primary-key fields (`source_key`, marketplace and
  `dimension_key`). This makes PostgREST pages deterministic when an account has
  more than 1,000 rows on a single date, preventing a partial or repeated PPC
  rollup.
- The cross-midnight fallback serves a saved snapshot only if its stored
  `reportVersion` matches the currently requested metric schema. A future report
  version change therefore cannot render an old payload under a new definition.

Live DataDoe validation for one IN and one US account, plus signed-in browser
and mobile validation, remain required before production deployment.

**Marketplace-aware dashboard foundation (2026-07-29, ready to deploy):**
`sales-dashboard-live/lib/marketplaces.js` is the single source of truth for
marketplace country, default currency, numeric locale and IANA timezone. It
covers the current IN/US/CA/AU accounts and the UK plus Amazon Europe
marketplaces (DE, FR, IT, ES, NL, BE, IE, PL and SE), with safe profiles for
other supported marketplaces. `fetchAccounts` now returns normalized country,
currency, locale and timezone metadata. Every report window derives its
date-only `to` value from the *selected account's marketplace day*, preventing
an India-based user from requesting tomorrow's US/Canada data near midnight (or
the reverse). Display money respects the currency locale, dashboard breakdowns
no longer hard-code INR, and content-alert timestamps use the selected
marketplace timezone. This is intentionally account-scoped: currencies are
still never converted or combined. Validation: 50 insight assertions and the
full Vite build pass. **Production deployment completed 2026-07-29:** commit
`543f35f` deployed as `dpl_87uT8Qmjapc8MwmWbsZCW5QQcmZ8` in 18 seconds;
Vercel reports it Ready and aliases it to `https://upriverdashboard.vercel.app`.
The public URL returned HTTP 200 after deployment. Remaining operational QA is
to sign in and refresh one account each for IN, US, CA, AU and an EU marketplace
when those accounts are connected, confirming DataDoe's returned country/currency
matches the normalized account profile.

## Dashboard authentication and account access (implemented and deployed 2026-07-29)

### What is implemented

- Supabase email/password authentication gates the entire browser app. The
  Vite bundle uses only `VITE_SUPABASE_URL` and the public/anon key; it never
  receives `SUPABASE_SECRET_KEY` or `DATADOE_API_KEY`.
- The initial administrator is **`laxmikant@upriver.in`**. Migration
  `20260729_dashboard_auth_and_access.sql` creates an Auth-user trigger that
  makes this email `admin`; all invited users become `viewer` by default with
  no Amazon account access. The migration is applied to production.
- The sign-in screen permits only this initial owner email to create the first
  administrator login. Every other person must be invited from the admin-only
  **User Access** sidebar page.
- The User Access page invites an email, lets the admin choose a Viewer or
  Editor role, and assigns zero or more individual Amazon accounts. It lists
  current users and lets the admin change a non-admin user's role/assignments.
  The initial administrator is deliberately protected from alteration there.
- `api/datadoe.js` now authenticates every request with the Supabase access
  token. For every account-scoped action it validates `ids` on the server
  against `account_permissions`; changing a browser URL/request cannot expose
  an unassigned account. The `accounts` action filters the returned account
  directory too. Diagnostic `fields`/`sample` actions require admin.
- Browser report caches are now namespaced by Auth user ID (`v2` cache keys),
  and both localStorage and IndexedDB report entries for revoked accounts are
  removed when a user's access is loaded. Server authorization remains the
  final control.
- `api/access.js` is the admin-only invitation/access-management endpoint.
  It uses the server-only Supabase secret to call the Auth Admin API; it does
  not expose user-management capability to the browser.

### One-time operational setup after deployment

1. In Supabase Studio, open **Authentication > URL Configuration**.
2. Set Site URL to `https://upriverdashboard.vercel.app`.
3. Add `https://upriverdashboard.vercel.app/**` to Redirect URLs.
4. On the dashboard login page, choose **Create initial administrator login**
   and sign up using `laxmikant@upriver.in`. Confirm the email if Supabase asks.
5. Sign in, open **User Access**, load the account directory once, invite each
   user, and tick only the accounts that user should access.

**Observed setup issue (2026-07-29):** the first administrator confirmation
email redirected to `http://localhost:3000` and then showed
`error_code=otp_expired`. This confirms Supabase Auth URL Configuration has not
yet been changed from its local-development default and that specific email
link is no longer usable. Set the Site/Redirect URLs above first, then request
a fresh confirmation email from the production dashboard. Do not troubleshoot
the old link or start a localhost server merely to complete it.

**Bootstrap hardening (completed and deployed 2026-07-29):** the login screen
queries a public, non-sensitive `bootstrap-status` response from the existing
access API. The one-time administrator-create control is shown only when no
Auth user exists for `laxmikant@upriver.in`; if the status request fails, the
control stays hidden. The database trigger remains the authority: only that
exact email is assigned the admin role, so no other email can self-register as
administrator. Commit `75a3e9f Hide completed administrator bootstrap` is
deployed. Production verification returned HTTP 200 with
`{"initialAdminExists":true,"confirmationPending":false}`, proving the owner
account exists and is confirmed; the live login page should therefore hide the
bootstrap action after a hard refresh.

**Login UI cleanup (completed 2026-07-29):** removed the explanatory
"Administrator setup is already in progress or complete" text from the login
screen. The bootstrap action remains hidden after initial setup; this is a
presentation-only change and does not weaken the server-side administrator
protection.

**Session persistence fix (implemented 2026-07-29):** the browser Supabase
client now uses explicit first-party
`localStorage` using `upriver-dashboard-auth-v1`, with persistent refresh
tokens enabled. App startup now attempts `refreshSession()` only when
`getSession()` reports an error, so a recoverable expired access token is not
treated as a logout. Existing users will need to sign in once after this
storage-key migration; subsequent browser refreshes should keep them signed in
unless they explicitly sign out, clear browser site data, or their Supabase
session is revoked. `npm run build` passed; end-to-end refresh verification
requires a signed-in browser session and must be performed by the dashboard
owner after deployment.

`DASHBOARD_APP_URL=https://upriverdashboard.vercel.app` is configured in
Vercel Production for invitation redirects. Supabase Auth settings showed
email signup enabled and email confirmation enabled on 2026-07-29. The
production dependency audit after adding `@supabase/supabase-js` found zero
production vulnerabilities; do not run `npm audit fix --force` casually.

**Deployment verification:** feature commit `de5327e` deployed as
`https://upriver-dashboard-m6rs943xe-laxmikant1604s-projects.vercel.app` and
is live at `https://upriverdashboard.vercel.app`. Production homepage returned
HTTP 200; a request to `/api/datadoe?action=accounts` without a Supabase access
token returned HTTP 401 `Please sign in to access the dashboard.` This confirms
the previous anonymous data API is no longer accessible.

## Amazon accounts inventory

## Account-scoped brands and Brand View (2026-07-31; deployed)

### Completed locally

- **Account selector brand isolation:** the header Brand dropdown now derives
  its values only from saved `brand-sales` rows whose `ids` cache parameter is
  exactly the selected account. It no longer trusts broad Product Catalog
  metadata, which could make brands from another account appear in the
  selected account dropdown.
- `action=brand-sales` now also returns `catalogBrands` derived from its
  already-joined selected-account sales rows rather than the raw catalog
  export. The browser and API therefore enforce the same scope boundary.
- **Dashboard mode switcher:** the Dashboard header now has `Account view`
  (the existing account/brand dashboard) and `Brand view`. Other report pages
  remain account-scoped and their existing header behavior is unchanged.
- **Brand View:** a separate portfolio view lets a user choose one brand and
  shows a country/currency snapshot and a seven-day country-performance table
  across all accounts that user is allowed to access. Country labels use the
  existing marketplace flags and standard region names.
- Brand View is cache-first and manual-refresh only. Its one refresh action
  walks accessible accounts sequentially, reuses the existing
  `action=brand-sales` API, saves each account response and saves the combined
  portfolio response in the signed-in user's browser cache. It must not be
  changed to background-fetch or parallel requests because that would spend
  DataDoe tokens and can violate the organisation-wide rate limit.

### Important decisions and limitations

- Brand View **never combines or converts money across currencies**. It groups
  sales by marketplace country and currency; percentage share is calculated
  only within the same currency. The summary intentionally says "Sales
  reporting: By country" rather than inventing a portfolio total.
- It shows only sales and units because the current manual portfolio refresh
  fetches only the proven Order Line Items + Product Catalog mapping. FBA
  inventory, ad spend and TACoS remain withheld until a dedicated country-level
  portfolio data source is fetched and reconciled; no account-level ad or FBA
  value may be relabelled as a brand value.
- A first Brand View refresh may take several minutes for many accounts because
  it checks them one at a time. Progress is visible in the page. Subsequent
  opens and date/filter changes use saved browser data and make no DataDoe API
  call.
- `npm run verify` passed after implementation: 53 deterministic assertions
  and the full Vite build (1,071 kB main bundle; existing chunk-size warning
  remains only a performance follow-up).
- Feature commit **`7f23e9a`** (`Add account scoped brand portfolio view`) is
  pushed to `origin/main`. Vercel auto-deployment was verified on the stable
  production URL: the deployed JavaScript contains `brand-portfolio-v1`,
  `Brand View`, and `Portfolio brand` markers. Production URL:
  https://upriverdashboard.vercel.app

## Automated Amazon Ads persistence (implemented 2026-07-29; deployment pending)

The three requested Amazon Ads reports now have a server-side, cache-first
foundation. The code is ready to deploy and the Supabase migration has already
been applied to the production `upriver-shared-data` database.

- **Campaign performance**: `08cdc77d3dc24a7651553e2e926f598188c66172f64cd6512265900af6073a6c`.
  This is persisted at campaign/day grain and also upserts the compact
  `ad_daily_metrics` table used by Daily Reporting, so saved campaign metrics
  can be read without another DataDoe advertising export.
- **ASIN performance**: `d0017e92fb089c2c8c3fe65f81d08666ecb4fe937ffbce9969ce2fc7d28c805c`.
  This is persisted at its native ASIN/campaign/ad/day grain.
- **Keyword Targeting performance**: `bbba3d213ac78ccbaf22cfa68eecb3f475641f49da26d51d1ac36446310051e3`.
  This is persisted at its native targeting/keyword/campaign/ad-group/day
  grain, retaining `ad_campaign_type` so SP/SB/SD are not mixed blindly.

### Automation behavior

- `sales-dashboard-live/api/ads-sync.js` discovers the authoritative DataDoe
  account list every scheduled run. Existing accounts and accounts connected in
  the future are included automatically; no account list is hard-coded.
- Supabase tables `ads_daily_source_rows` and `ads_sync_state` were created by
  migration `20260729_automated_ads_sync.sql`. Upserts use each report's
  natural dimensions plus account/marketplace/date, so daily and monthly
  re-fetches correct attribution instead of double-counting it.
- Initial history is imported once per account/source: 56 days for campaign and
  targeting, 60 days for ASIN. Later runs re-fetch the latest 21-day correction
  window daily and the last 49 days about once every 25 days.
- A hard 50,000-row export cap is never accepted as complete: the worker splits
  a date range and retries smaller windows. DataDoe calls are spaced at least
  ~550 ms and retry HTTP 429 responses to respect the organization limit.
- A database lock prevents overlapping work for the same country/source scope.
  `CRON_SECRET` is stored only in Vercel Production and protects every cron
  endpoint; it must never be copied into source, docs, screenshots, or git.

### Country schedules (all cron expressions are UTC)

Each source gets its own bounded job so a large ASIN/targeting export cannot
block the compact campaign export. Vercel Hobby can run up to 100 daily jobs,
but has hourly (up to 59 minute) scheduling precision.

| Marketplace scope | Campaign | ASIN | Targeting | Intended local morning |
| --- | --- | --- | --- | --- |
| India (`IN`) | 00:30 UTC | 01:30 UTC | 02:30 UTC | approximately 06:00 / 07:00 / 08:00 IST |
| US + Canada (`US`, `CA`) | 10:00 UTC | 11:00 UTC | 12:00 UTC | approximately 06:00 / 07:00 / 08:00 US Eastern during daylight saving |
| Australia (`AU`) | 20:00 UTC | 21:00 UTC | 22:00 UTC | approximately 06:00 / 07:00 / 08:00 AEST |
| Other future countries | 06:00 UTC | 07:00 UTC | 08:00 UTC | fallback; not guaranteed 06:00 local |

The application chooses country membership dynamically. The scheduled UTC
times are intentionally documented as *approximate*: Vercel Hobby may invoke
any time during the requested hour and does not provide DST-aware local-time
scheduling. A Vercel Pro/external timezone-aware scheduler is required if
exact 06:00 local time becomes a business requirement.

### Current implementation status

- Supabase migration applied successfully and verified: the new tables are
  present alongside the existing dashboard tables.
- Vercel Hobby permits **at most 12 Serverless Functions per deployment**. The
  first two scheduler deployment attempts failed only after a successful build
  because 12 separate cron handlers plus existing API files exceeded that
  limit (`exceeded_serverless_functions_per_deployment`). This is now resolved
  in code: server-only helpers live under `lib/server/`, and one dynamic
  `api/cron/[scope].js` function serves all 12 scheduled country/source paths.
  Do not recreate one API file per schedule on this Hobby project.
- **Production deployment is live:** the scheduler code from commit `a8a3fb7`
  is live through the stable alias `https://upriverdashboard.vercel.app`.
  Vercel API metadata confirms `READY`, alias assigned, and exactly **12**
  registered cron jobs. The latest deployment record is documentation commit
  `6824110`; it carries the same scheduler code.
- Production health check returned HTTP 200. A direct request without the
  secret correctly returned HTTP 401, proving the cron route is not public.
  Vercel supplies the stored `CRON_SECRET` authorization header to scheduled
  invocations. The secret is intentionally unavailable from `vercel env pull`,
  so do not weaken the endpoint merely to test it manually.
- The first real scheduled DataDoe worker result still needs observation in
  Vercel Cron logs / `ads_sync_state` after its next country time. Until the
  first campaign seed succeeds for an account, Daily Reporting will show no
  saved Ads metrics for that account rather than launch an unplanned DataDoe
  Ads export.
- The existing browser report cache remains in place. New Ads data is shared
  server-side now; other report families will be migrated to shared Supabase
  snapshots incrementally, using the same no-automatic-DataDoe-fetch rule.

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
