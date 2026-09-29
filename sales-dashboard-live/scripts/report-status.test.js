// Status-only header control (Option A) + header Reload targets. Fully offline:
//   R  the report registry: every REPORT_MATERIALIZATION entry declares a valid dataStatus (the existing validator fails a
//      missing or unknown value), and each dataStatus AGREES with the recovery route registry's class kind
//      (route -> scheduled, read-only-self-heal -> read-time, manual-paid -> paid-manual, dormant -> dormant)
//   M  the browser mirror (src/lib/report-status.js) EQUALS the server registry, and every NAV_GROUPS view id in
//      src/components/shell.jsx has exactly one status entry -- so a new report or view cannot ship without one
//   V  viewDataStatus: the status shown per view (brand mode, the Campaign Ads flag, pages with no report), and the
//      wording rule: it describes the data source, never offers to update or publish
//   H  App.jsx header wiring: Listing Health v3, Campaign Ads and brand mode reload THEIR OWN data (brand mode never
//      calls the paid Product Catalog sync); the Sales Dashboard reload also re-reads its quality panel; the status value
//      says "Loaded"/"Loading…"; non-admins reload the SAVED account list; the chip is rendered as text, not a control
//   C  CampaignAds: re-reads only when the header's reload counter CHANGES after mount, and reports its own loading /
//      loaded time back to the header
// 7-bit ASCII in code; LF.
import assert from "node:assert/strict";
import { readFileSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(path.join(ROOT, ...p.split("/")), "utf8").replace(/\r\n/g, "\n");
let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; out("  ok  " + name); };
const J = (v) => JSON.stringify(v);
out("report-status");

const MAT = await import("../lib/server/reports/report-materialization-registry.js");
const REC = await import("../lib/server/recovery/registry.js");
const RS = await import("../src/lib/report-status.js");

// =====================================================================================================================
// R. the server registry
// =====================================================================================================================
{
  const entries = Object.entries(MAT.REPORT_MATERIALIZATION);
  ok("R1 dataStatus is a REQUIRED declaration field with a closed vocabulary (scheduled | read-time | paid-manual | dormant)",
    MAT.REQUIRED_DECLARATION_FIELDS.includes("dataStatus") && J(MAT.DATA_STATUS) === J(["scheduled", "read-time", "paid-manual", "dormant"]));
  ok(`R2 every one of the ${entries.length} registry entries declares a valid dataStatus, and the real registry validates`,
    entries.length >= 24 && entries.every(([, e]) => MAT.DATA_STATUS.includes(e.dataStatus)) && MAT.validateReportMaterializationRegistry().ok === true);
  const drop = (mutate) => {
    const registry = Object.fromEntries(entries.map(([a, e]) => [a, { ...e }]));
    mutate(registry);
    try { MAT.validateReportMaterializationRegistry({ registry }); return null; } catch (e) { return String(e.message); }
  };
  const missing = drop((r) => { delete r["returns-leakage"].dataStatus; });
  const unknown = drop((r) => { r["daily"].dataStatus = "live"; });
  ok("R3 the existing validator FAILS a report that omits dataStatus, and one that uses a value outside the vocabulary",
    /"returns-leakage" is missing required declaration field "dataStatus"/.test(missing || "") && /"daily" dataStatus "live" is not an allowed value/.test(unknown || ""));
  const KIND_TO_STATUS = { "route": "scheduled", "read-only-self-heal": "read-time", "manual-paid": "paid-manual", "dormant": "dormant" };
  const disagree = entries.filter(([a, e]) => {
    const cls = REC.classifyReportKey(e.reportKey || a);
    return !cls || KIND_TO_STATUS[cls.kind] !== e.dataStatus;
  }).map(([a]) => a);
  ok("R4 every dataStatus AGREES with the recovery route registry class of its report (route=scheduled, read-only-self-heal=read-time, manual-paid=paid-manual, dormant=dormant)",
    disagree.length === 0);
  const ownerMismatch = drop((r) => { r["reconciliation"].dataStatus = "scheduled"; });
  const ownerMismatch2 = drop((r) => { r["brand-sales"].dataStatus = "read-time"; });
  ok("R5 the validator FAILS a dataStatus that contradicts the report's materializationOwner (a manual paid report cannot claim 'scheduled'; a scheduler report cannot claim 'read-time')",
    /"reconciliation" dataStatus "scheduled" contradicts its materializationOwner "manual-refresh"/.test(ownerMismatch || "")
    && /"brand-sales" dataStatus "read-time" contradicts its materializationOwner "scheduler-v2:priority"/.test(ownerMismatch2 || ""));
}

// =====================================================================================================================
// M. the browser mirror + the view map
// =====================================================================================================================
{
  const server = Object.fromEntries(Object.entries(MAT.REPORT_MATERIALIZATION).map(([a, e]) => [a, e.dataStatus]));
  ok("M1 the browser mirror REPORT_DATA_STATUS EQUALS the server registry's dataStatus (same actions, same values)",
    J(Object.keys(RS.REPORT_DATA_STATUS).sort()) === J(Object.keys(server).sort())
    && Object.keys(server).every((a) => RS.REPORT_DATA_STATUS[a] === server[a]));
  const shell = src("src/components/shell.jsx");
  const nav = shell.slice(shell.indexOf("NAV_GROUPS"), shell.indexOf("VIEW_TITLES"));
  const navViews = [...new Set([...nav.matchAll(/view: "([^"]+)"/g)].map((m) => m[1]))];
  const statusViews = Object.keys(RS.VIEW_REPORT_STATUS);
  ok(`M2 every NAV_GROUPS view id (${navViews.length}) has a status entry (a view without one fails here)`,
    navViews.length >= 15 && navViews.every((v) => statusViews.includes(v)));
  const shapeOk = Object.entries(RS.VIEW_REPORT_STATUS).every(([, e]) => {
    const kinds = [Boolean(e.action), Boolean(e.status), Boolean(e.none)].filter(Boolean).length;
    if (kinds !== 1) return false;
    if (e.action) return e.action in MAT.REPORT_MATERIALIZATION && MAT.REPORT_MATERIALIZATION[e.action].dataStatus !== "dormant" && typeof e.name === "string";
    if (e.status) return e.status in RS.DATA_STATUS_COPY && typeof e.detail === "string" && typeof e.name === "string";
    return typeof e.none === "string";
  });
  ok("M3 each view entry is exactly one of: a registered, non-dormant report action | a view-level status with its own explanation | 'no report' with a reason",
    shapeOk && statusViews.includes("dashboard#brand"));
}

// =====================================================================================================================
// V. viewDataStatus + the wording rule
// =====================================================================================================================
{
  const v = (view, opts) => RS.viewDataStatus(view, opts);
  ok("V1 account views show their own report's status: Sales Dashboard + Daily + Returns = Daily schedule; SKU P&L = Paid report",
    v("dashboard").status === "scheduled" && v("daily").status === "scheduled" && v("returns").status === "scheduled" && v("skupl").status === "paid-manual");
  const brandMode = v("dashboard", { dashboardMode: "brand" });
  ok("V2 brand mode shows the Brand View portfolio status, and its explanation matches what the header Reload does there (the saved brand list only; the page's 'Reload saved data' re-reads the portfolio)",
    brandMode.status === "scheduled" && /^Brand View portfolio:/.test(brandMode.detail)
    && /header Reload re-reads the saved brand list only/.test(brandMode.detail) && /"Reload saved data" inside the page re-reads the portfolio/.test(brandMode.detail)
    && !/Reload re-reads that copy/.test(brandMode.detail) && /Neither publishes or calls DataDoe/.test(brandMode.detail));
  ok("V3 with the Campaign Ads tab on, the legacy ppc view shows Campaign Ads (built on open); with it off, PPC Performance (paid)",
    v("ppc", { campaignAdsTab: true }).status === "read-time" && /^Ad Performance by Campaign:/.test(v("ppc", { campaignAdsTab: true }).detail)
    && v("ppc", { campaignAdsTab: false }).status === "paid-manual" && v("campaign-ads").status === "read-time");
  ok("V4 pages with no report of their own (Priority Feed, Data Sync Center, User Access) and unknown views show NO status (never an invented one)",
    v("priority") === null && v("sync-center") === null && v("access") === null && v("no-such-view") === null);
  const noCopy = ["dashboard", "daily", "skupl", "campaign-ads"].map((id) => v(id, { hasCopy: false }));
  const noCopyRebuilt = v("listinghealth-v3", { served: { preview: true }, hasCopy: false });
  const brandNoCopy = v("dashboard", { dashboardMode: "brand", hasCopy: false });
  const brandRebuilt = v("dashboard", { dashboardMode: "brand", served: { snapshot: { rederived: true } } });
  ok("V9 with NO copy on screen the explanation never claims one is shown (no 'You are seeing' / 'This copy'), keeps the source class, and says nothing publishes; a rebuilt Brand View portfolio is labelled 'Built on open'",
    noCopy.every((s) => s && !/You are seeing|This copy|re-reads that copy/.test(s.detail) && /No saved copy is on screen yet|Nothing is on screen yet/.test(s.detail))
    && noCopy[0].status === "scheduled" && noCopy[2].status === "paid-manual" && noCopy[3].status === "read-time"
    && noCopyRebuilt.status === "read-time" && !/This copy/.test(noCopyRebuilt.detail)
    && brandNoCopy.status === "scheduled" && !/you are seeing/i.test(brandNoCopy.detail)
    && brandRebuilt.status === "read-time" && /the scheduler did not publish it/.test(brandRebuilt.detail));
  const texts = [...Object.values(RS.DATA_STATUS_COPY).flatMap((c) => [c.label, c.detail]), ...Object.values(RS.NO_COPY_DETAIL), RS.BUILT_ON_READ_DETAIL, ...Object.values(RS.VIEW_REPORT_STATUS).map((e) => e.detail || e.none || "")];
  ok("V5 wording rule: no status text says 'update'; no label offers to publish, sync or refresh",
    texts.every((t) => !/update/i.test(t)) && Object.values(RS.DATA_STATUS_COPY).every((c) => !/publish|sync|refresh/i.test(c.label)));
  const preview = v("listinghealth-v3", { served: { preview: true, rows: [] } });
  const rederived = v("returns", { served: { snapshot: { rederived: true, readOnly: true } } });
  const stored = v("returns", { served: { snapshot: { savedAt: "2026-09-25T01:00:00Z" } } });
  ok("V7 a served copy the server REBUILT at read time (Listing Health preview, a read-only re-derive) is labelled 'Built on open'; a stored copy keeps the report's class",
    preview.status === "read-time" && /^Listing Health: This copy was rebuilt from data already saved/.test(preview.detail)
    && rederived.status === "read-time" && stored.status === "scheduled" && v("listinghealth-v3").status === "scheduled"
    && RS.servedBuiltOnRead(null) === false && RS.servedBuiltOnRead({ snapshot: {} }) === false);
  const now = new Date(2026, 8, 30, 15, 0, 0);
  const today = RS.formatLoadedStamp(new Date(2026, 8, 30, 9, 5, 7), now);
  const earlier = RS.formatLoadedStamp(new Date(2026, 8, 28, 9, 5, 7), now);
  ok("V8 formatLoadedStamp: time only for today, the date as well for an older copy, empty for no date",
    today === new Date(2026, 8, 30, 9, 5, 7).toLocaleTimeString() && earlier.endsWith(new Date(2026, 8, 28, 9, 5, 7).toLocaleTimeString()) && earlier.length > today.length
    && RS.formatLoadedStamp(null, now) === "" && RS.formatLoadedStamp(new Date("x"), now) === "");
  ok("V6 every non-paid explanation says Reload does not publish or call DataDoe; the paid one names the DataDoe token cost",
    /does not publish or call DataDoe/.test(RS.DATA_STATUS_COPY.scheduled.detail) && /does not publish or call DataDoe/.test(RS.DATA_STATUS_COPY["read-time"].detail)
    && /does not publish or call DataDoe/.test(RS.VIEW_REPORT_STATUS["campaign-ads"].detail) && /DataDoe tokens/.test(RS.DATA_STATUS_COPY["paid-manual"].detail));
}

// =====================================================================================================================
// H. App.jsx / shell.jsx header wiring
// =====================================================================================================================
{
  const app = src("src/App.jsx");
  const header = app.slice(app.indexOf("/* ===== The header Reload control + status ====="), app.indexOf("const showGlobalScope ="));
  const onRefresh = header.slice(header.indexOf("onRefresh: onFeed ? undefined"), header.indexOf("disabled: onFeed"));
  ok("H1 brand mode re-reads the SAVED brand list (reloadBrandDirectory) -- the header never calls the paid Product Catalog sync (fetchBrandDirectory)",
    /showingBrandPortfolio \? reloadBrandDirectory/.test(onRefresh) && !/fetchBrandDirectory/.test(header.replace(/\/\/.*$/gm, "")));
  ok("H2 Listing Health v3 (and the legacy listinghealth id) reloads, stamps and spins on ITS OWN report, before the insight map",
    /const onListingHealthV3 = view === "listinghealth-v3" \|\| view === "listinghealth";/.test(header)
    && /onListingHealthV3 \? listingHealthV3\.reload/.test(onRefresh) && /onListingHealthV3 \? listingHealthV3\.cachedAt/.test(header) && /onListingHealthV3 \? listingHealthV3\.loading/.test(header)
    && onRefresh.indexOf("onListingHealthV3 ?") < onRefresh.indexOf("activeInsightReport ?"));
  ok("H3 Campaign Ads (and ppc when the Campaign Ads tab is on) reloads ITS OWN rows via the reload counter and shows its own loaded time / loading state",
    /const onCampaignAds = view === "campaign-ads" \|\| \(view === "ppc" && CAMPAIGN_ADS_TAB\);/.test(header)
    && /onCampaignAds \? \(\) => setCampaignAdsReload\(\(n\) => n \+ 1\)/.test(onRefresh) && /onCampaignAds \? campaignAdsStatus\.loadedAt/.test(header) && /onCampaignAds \? campaignAdsStatus\.loading/.test(header)
    && /reloadSignal=\{campaignAdsReload\}/.test(app) && /onStatus=\{setCampaignAdsStatus\}/.test(app));
  ok("H4 the Sales Dashboard fallback reloads its sales rows AND its quality panel; nothing falls through to loadCachedRows alone any more",
    /const reloadSalesDashboard = \(\) => \{ loadCachedRows\(\); loadOliQuality\(\); \};/.test(header) && /: reloadSalesDashboard,/.test(onRefresh) && !/: loadCachedRows,/.test(onRefresh));
  ok("H5 the status says when this page last LOADED the saved copy ('Loaded' / 'Loading…'), never 'Last updated' / 'Updating…', and carries the status-only dataStatus",
    /: "Loaded",/.test(header) && /\? "Loading…"/.test(header) && !/Last updated|Updating…/.test(header)
    && /dataStatus: viewDataStatus\(view, \{ dashboardMode, campaignAdsTab: CAMPAIGN_ADS_TAB, served: servedStatusBody, hasCopy: copyOnScreen \}\),/.test(header));
  ok("H5b the served body passed to the status is the report ON SCREEN (Brand View portfolio / Listing Health v3 / Daily / SKU Movement / the insight report, never Campaign Ads)",
    /const servedStatusBody = showingBrandPortfolio \? brandPortfolioServed\n\s*: onListingHealthV3 \? \(listingHealthV3\.data \|\| \(lhv3DefaultWindow \? null : \{ preview: true \}\)\)\n\s*: view === "daily" \? dailyServedMeta\n\s*: view === "skumovement" \? skuMovement\.data\n\s*: activeInsightReport && !onCampaignAds \? activeInsightReport\.data\n\s*: null;/.test(header));
  ok("H5b1 the status claims a copy is on screen ONLY when one is (a loaded copy, not missing, not waiting; brand mode: the portfolio's own copy) -- and copyOnScreen is declared AFTER activeStamp and servedStatusBody (no temporal-dead-zone crash at render)",
    /const copyOnScreen = showingBrandPortfolio \? Boolean\(brandPortfolioServed\)\n\s*: Boolean\(activeStamp\) && !\(servedStatusBody && servedStatusBody\.snapshotMissing\)\n\s*&& !\(view === "dashboard" && rowsCacheMissing\) && !\(view === "daily" && dailyMissing\);/.test(header)
    && header.indexOf("const copyOnScreen =") > header.indexOf("const activeStamp =") && header.indexOf("const copyOnScreen =") > header.indexOf("const servedStatusBody =")
    && header.indexOf("const copyOnScreen =") < header.indexOf("const refreshDescriptor ="));
  const bp = src("src/views/BrandPortfolio.jsx");
  ok("H5b4 Brand Portfolio reports the snapshot facts of the copy ON SCREEN (null when none) to the header and clears them on unmount; App wires it (onServedMeta={setBrandPortfolioServed}, state above the early returns)",
    /onServedMeta = null,/.test(bp) && /if \(onServedMeta\) onServedMeta\(data \? \{ snapshot: data\.snapshot \|\| null \} : null\);/.test(bp) && /onServedMeta\(null\); \}, \[onServedMeta\]\);/.test(bp)
    && /onServedMeta=\{setBrandPortfolioServed\}/.test(app)
    && app.indexOf("const [brandPortfolioServed, setBrandPortfolioServed] = useState(null);") > 0
    && app.indexOf("const [brandPortfolioServed, setBrandPortfolioServed] = useState(null);") < app.indexOf("if (!isAdmin && access.accountIds.length === 0) {"));
  ok("H5b2 a Listing Health window other than the default 30 days (the only one the scheduler publishes) is described as built at read time even before a body arrives -- the same default-window rule as the server",
    /const lhv3DefaultWindow = \(!lhv3Window\.preset \|\| lhv3Window\.preset === "30D"\) && !lhv3Window\.month && !lhv3Window\.from && !lhv3Window\.to;/.test(header));
  const dailyLoader = app.slice(app.indexOf("const loadCachedDaily = useCallback("), app.indexOf("}, [dailyParams, bumpReq, isCurrentReq]);"));
  ok("H5b3 Daily keeps the served copy's snapshot facts (cache paint and network) and clears them when there is no copy, so a named-brand copy rebuilt at read time is labelled 'Built on open'",
    /setDailyServedMeta\(\{ snapshot: cached\.body\.snapshot \|\| null, snapshotMissing: Boolean\(cached\.body\.snapshotMissing\) \}\);/.test(dailyLoader)
    && /setDailyServedMeta\(\{ snapshot: body\.snapshot \|\| null, snapshotMissing: Boolean\(body\.snapshotMissing\) \}\);/.test(dailyLoader)
    && (dailyLoader.match(/setDailyServedMeta\(null\);/g) || []).length === 2
    && RS.viewDataStatus("daily", { served: { snapshot: { rederived: true, readOnly: true } } }).status === "read-time"
    && RS.viewDataStatus("daily", { served: { snapshot: { savedAt: "x" } } }).status === "scheduled");
  ok("H5c the loaded time carries the date when it is not today (formatLoadedStamp); the live dot is no longer forced on for the Priority Feed",
    /\$\{formatLoadedStamp\(activeStamp\)\} · \$\{refreshScopeLabel\}/.test(header) && /live: Boolean\(activeStamp\),/.test(header) && !/live: Boolean\(activeStamp\) \|\| onFeed/.test(header));
  ok("H5d Daily Reporting shows ITS OWN loaded time (dailyCachedAt); its loader no longer writes the Sales Dashboard's lastFetchedAt",
    /view === "daily" \? dailyCachedAt/.test(header)
    && (() => { const l = app.slice(app.indexOf("const loadCachedDaily = useCallback("), app.indexOf("}, [dailyParams, bumpReq, isCurrentReq]);")); return /setDailyCachedAt\(new Date\(cachedAt\)\)/.test(l) && !/setLastFetchedAt/.test(l); })());
  ok("H5e FBA Shipment Plan reloads the plan AND its demand input (the SKU Movement read it depends on)",
    /view === "fbaplan" \? \(\) => \{ loadCachedPlan\(\); fbaDemand\.reload\(\); \}/.test(onRefresh));
  ok("H5f Brand Portfolio's 'Load portfolio brands' re-reads the saved brand list for non-admins (the paid Catalog sync stays admin-only)",
    /onLoadBrandDirectory=\{isAdmin \? fetchBrandDirectory : reloadBrandDirectory/.test(app));
  ok("H6 the admin-only paid-sync entry is unchanged (isAdmin && routeOwnedView && !onFeed)", /paidSync: isAdmin && routeOwnedView && !onFeed/.test(header));
  ok("H7 non-admins reload the SAVED account list: every account-list control uses reloadAccountList (admins keep the DataDoe refresh); only the admin-only AccessPanel calls fetchAccounts directly",
    /const reloadAccountList = isAdmin \? fetchAccounts : reloadAccounts;/.test(app)
    && /onRefreshAccounts=\{reloadAccountList\}/.test(app) && /onClick=\{reloadAccountList\} disabled=\{accountsLoading\}>\n\s*<RefreshCw size=\{14\} className=\{accountsLoading \? "spin" : ""\} \/>\n\s*Retry loading accounts/.test(app)
    && (app.match(/onClick=\{fetchAccounts\}/g) || []).length === 0
    && (app.match(/fetchAccounts\b/g) || []).length === (app.match(/const fetchAccounts = useCallback/g) || []).length + 2 // definition + reloadAccountList + AccessPanel
    && /view === "access" && isAdmin && <AccessPanel [^>]*onLoadAccounts=\{fetchAccounts\}/.test(app)
    && /accountsRefreshTitle=\{isAdmin \? "Refresh account list from DataDoe" : "Reload the saved account list"\}/.test(app));
  const reloadAccounts = app.slice(app.indexOf("const reloadAccounts = useCallback("), app.indexOf("const reloadAccountList ="));
  ok("H8 reloadAccounts is a plain READ (loadSharedReport, never refreshSharedReport) and is declared ABOVE the early returns (React #310)",
    /loadSharedReport\(\{ action: "accounts" \}\)/.test(reloadAccounts) && !/refreshSharedReport/.test(reloadAccounts)
    && app.indexOf("const reloadAccounts = useCallback(") < app.indexOf("if (!isAdmin && access.accountIds.length === 0) {")
    && app.indexOf("const [campaignAdsReload, setCampaignAdsReload] = useState(0);") < app.indexOf("if (!isAdmin && access.accountIds.length === 0) {"));
  const shell = src("src/components/shell.jsx");
  const chip = shell.slice(shell.indexOf("{refresh.dataStatus && ("), shell.indexOf("<div className=\"refresh-status\">"));
  ok("H9 the TopBar renders the status as TEXT (a span with an explanation), not as a button or link -- it is not a control",
    /<span className=\{"data-status-chip " \+ refresh\.dataStatus\.status\} title=\{refresh\.dataStatus\.detail\}>/.test(chip)
    && !/onClick|<button|<a /.test(chip) && /<span className="sr-only">/.test(chip));
  ok("H10 the account button's label follows the viewer (refreshTitle prop, default unchanged for admins)",
    /refreshTitle = "Refresh account list from DataDoe"/.test(shell) && /title=\{refreshTitle\}/.test(shell) && /refreshTitle=\{accountsRefreshTitle\}/.test(shell));
}

// =====================================================================================================================
// E. EXECUTE the real header descriptor block from App.jsx (plain JS, no JSX) with stubbed page state: it must run
//    without a ReferenceError (e.g. a temporal-dead-zone const) for every view, call the right loader(s) on Reload, and
//    produce an honest status for the copy on screen.
// =====================================================================================================================
{
  const app = src("src/App.jsx");
  const header = app.slice(app.indexOf("/* ===== The header Reload control + status ====="), app.indexOf("const showGlobalScope ="));
  const block = header.slice(header.indexOf("const showingBrandPortfolio"));
  const runHeader = (state) => {
    const calls = [];
    const fn = (name) => (...args) => { calls.push(name); if (typeof args[0] === "function") args[0](0); };
    const base = {
      view: "dashboard", dashboardMode: "account", onFeed: false, isAdmin: false, CAMPAIGN_ADS_TAB: true,
      viewDataStatus: RS.viewDataStatus, formatLoadedStamp: RS.formatLoadedStamp,
      accounts: [{ id: "A" }], allowedAccountIds: new Set(["A"]), selectedAccountId: "A", refreshScopeAccount: { name: "Acct" }, selectedPortfolioBrand: "Acme",
      listingHealthV3Window: { preset: "30D" }, listingHealthV3: { data: null, cachedAt: null, loading: false, reload: fn("listingHealthV3.reload") },
      skuMovement: { data: null, cachedAt: null, loading: false, updating: false, reload: fn("skuMovement.reload") }, fbaDemand: { reload: fn("fbaDemand.reload") },
      activeInsightReport: null, campaignAdsStatus: { loading: false, loadedAt: null }, brandPortfolioServed: null, dailyServedMeta: null,
      brandDirectoryFetchedAt: null, brandDirectoryLoading: false, dailyCachedAt: null, planCachedAt: null, reconciliationCachedAt: null, skuPlCachedAt: null,
      keywordRankCachedAt: null, contentChangesCachedAt: null, lastFetchedAt: null, rowsCacheMissing: false, dailyMissing: false,
      dailyLoading: false, planLoading: false, reconciliationLoading: false, skuPlLoading: false, keywordRankLoading: false, contentChangesLoading: false, rowsLoading: false,
      loadCachedRows: fn("loadCachedRows"), loadOliQuality: fn("loadOliQuality"), reloadBrandDirectory: fn("reloadBrandDirectory"), fetchBrandDirectory: fn("fetchBrandDirectory"),
      setCampaignAdsReload: fn("setCampaignAdsReload"), loadCachedDaily: fn("loadCachedDaily"), loadCachedPlan: fn("loadCachedPlan"),
      loadCachedReconciliation: fn("loadCachedReconciliation"), loadCachedSkuPl: fn("loadCachedSkuPl"), loadCachedKeywordRank: fn("loadCachedKeywordRank"),
      loadCachedContentChanges: fn("loadCachedContentChanges"), setView: fn("setView"), setDashboardMode: fn("setDashboardMode"),
    };
    const scope = new Proxy({ ...base, ...state }, { has: (t, k) => k in t || !(k in globalThis), get: (t, k) => (k in t ? t[k] : undefined) });
    // eslint-disable-next-line no-new-func
    const d = new Function("scope", `with (scope) {\n${block}\nreturn refreshDescriptor;\n}`)(scope);
    return { d, calls, reload: () => { calls.length = 0; if (d.onRefresh) d.onRefresh(); return [...calls]; } };
  };
  const now = new Date();
  let threw = null;
  const cases = {};
  try {
    for (const view of ["dashboard", "priority", "daily", "returns", "fbaplan", "listinghealth-v3", "listinghealth", "skumovement", "campaign-ads", "ppc", "reconciliation", "skupl", "keywordrank", "contentchanges", "salesmovers", "buybox", "optimizer"]) {
      cases[view] = runHeader({ view, onFeed: view === "priority" });
    }
    cases.brand = runHeader({ view: "dashboard", dashboardMode: "brand" });
  } catch (e) { threw = e; }
  ok(`E1 the real header block EXECUTES for all ${Object.keys(cases).length} views + brand mode with no ReferenceError / temporal-dead-zone crash`, threw === null && Object.keys(cases).length === 18);
  ok("E2 Reload calls exactly the loader(s) of the report ON SCREEN: Sales Dashboard = rows + quality; Daily; FBA Plan = plan + demand; Listing Health v3 (and legacy id) = its hook; Campaign Ads (and ppc with the tab on) = its reload counter; brand mode = the saved brand list (never the paid Catalog sync); the Priority Feed has none",
    J(cases.dashboard.reload()) === J(["loadCachedRows", "loadOliQuality"]) && J(cases.daily.reload()) === J(["loadCachedDaily"])
    && J(cases.fbaplan.reload()) === J(["loadCachedPlan", "fbaDemand.reload"]) && J(cases["listinghealth-v3"].reload()) === J(["listingHealthV3.reload"])
    && J(cases.listinghealth.reload()) === J(["listingHealthV3.reload"]) && J(cases["campaign-ads"].reload()) === J(["setCampaignAdsReload"]) && J(cases.ppc.reload()) === J(["setCampaignAdsReload"])
    && J(cases.brand.reload()) === J(["reloadBrandDirectory"]) && cases.priority.d.onRefresh === undefined && J(cases.skumovement.reload()) === J(["skuMovement.reload"]));
  ok("E3 the status names the report on screen and claims NO copy when nothing is loaded (fresh page); the Priority Feed shows no chip and an idle dot",
    cases.dashboard.d.dataStatus.status === "scheduled" && /No saved copy is on screen yet/.test(cases.dashboard.d.dataStatus.detail)
    && cases.skupl.d.dataStatus.status === "paid-manual" && cases["campaign-ads"].d.dataStatus.status === "read-time"
    && cases.priority.d.dataStatus === null && cases.priority.d.live === false && cases.dashboard.d.label === "Loaded");
  const loaded = runHeader({ view: "dashboard", lastFetchedAt: now });
  const waiting = runHeader({ view: "dashboard", lastFetchedAt: now, rowsCacheMissing: true });
  const dailyRebuilt = runHeader({ view: "daily", dailyCachedAt: now, dailyServedMeta: { snapshot: { rederived: true }, snapshotMissing: false } });
  const dailyMissing = runHeader({ view: "daily", dailyCachedAt: now, dailyMissing: true, dailyServedMeta: { snapshot: null, snapshotMissing: true } });
  const lhv3Week = runHeader({ view: "listinghealth-v3", listingHealthV3Window: { preset: "7D" }, listingHealthV3: { data: null, cachedAt: null, loading: true, reload: () => {} } });
  const brandRebuilt = runHeader({ view: "dashboard", dashboardMode: "brand", brandDirectoryFetchedAt: now, brandPortfolioServed: { snapshot: { rederived: true } } });
  const brandShown = runHeader({ view: "dashboard", dashboardMode: "brand", brandDirectoryFetchedAt: now, brandPortfolioServed: { snapshot: { savedAt: "x" } } });
  ok("E4 honest status per state: a loaded copy -> 'You are seeing'; waiting / missing -> no copy claimed; a Daily copy rebuilt at read time -> 'Built on open'; a 7-day Listing Health window -> built on open even while loading; Brand View portfolio follows ITS copy",
    /You are seeing the latest copy it published/.test(loaded.d.dataStatus.detail) && loaded.d.live === true && /\d/.test(loaded.d.value)
    && /No saved copy is on screen yet/.test(waiting.d.dataStatus.detail)
    && dailyRebuilt.d.dataStatus.status === "read-time" && /the scheduler did not publish it/.test(dailyRebuilt.d.dataStatus.detail)
    && /No saved copy is on screen yet/.test(dailyMissing.d.dataStatus.detail)
    && lhv3Week.d.dataStatus.status === "read-time" && lhv3Week.d.value === "Loading…"
    && brandRebuilt.d.dataStatus.status === "read-time" && brandShown.d.dataStatus.status === "scheduled" && /header Reload re-reads the saved brand list only/.test(brandShown.d.dataStatus.detail));
  ok("E5 admins keep the paid-sync entry on route-owned pages; members never get it",
    runHeader({ view: "daily", isAdmin: true }).d.paidSync && !runHeader({ view: "daily", isAdmin: false }).d.paidSync);
}

// =====================================================================================================================
// C. CampaignAds
// =====================================================================================================================
{
  const ca = src("src/views/CampaignAds.jsx");
  ok("C1 CampaignAds accepts reloadSignal + onStatus and re-reads ONLY when the counter changes after mount (a remount with an old count does not read twice)",
    /reloadSignal = 0, onStatus \}\) \{/.test(ca) && /const seenReloadSignal = useRef\(reloadSignal\);/.test(ca)
    && /if \(reloadSignal === seenReloadSignal\.current\) return;\n\s*seenReloadSignal\.current = reloadSignal;\n\s*loadRef\.current\(\);/.test(ca));
  ok("C2 CampaignAds reports its own loading + loaded time to the header and clears it on unmount; a failed read clears the loaded time",
    /if \(onStatus\) onStatus\(\{ loading, loadedAt \}\);/.test(ca) && /onStatus\(\{ loading: false, loadedAt: null \}\)/.test(ca)
    && /setLoadedAt\(new Date\(\)\);/.test(ca) && /setError\(e\.message \|\| "Failed to load Campaign Ads\."\); setLoadedAt\(null\);/.test(ca));
}

out(`\nreport-status: ${passed} passed`);
