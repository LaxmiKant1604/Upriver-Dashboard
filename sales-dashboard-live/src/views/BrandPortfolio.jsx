/* =====================================================================
   BRAND PORTFOLIO — one brand across every account that sells it
   =====================================================================

   Reached from the header's `Brand view` switcher. It keeps the cross-account
   rollup this workspace has always had (one brand, every account and every
   marketplace), but renders it through the shared Brand View reports so the
   columns, currency system, formulas and exports are identical to the
   account-scoped page.

   The brand selector and the account-to-brand mapping stay where they already
   were, in DashboardApp: this component receives the brand and the mapped
   accounts and owns only the date range, the currency, the refresh and the
   export.

   WHAT MAY CALL A SOURCE
     Reads and the normal Refresh action use shared Supabase snapshots only.
     A separate temporary, admin-only action may refresh the mapped account
     snapshots from DataDoe before rebuilding this shared Brand View.         */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Boxes, CalendarRange, Coins, DatabaseZap, Inbox, Info, Layers, RefreshCw, Tag } from "lucide-react";

import { DataQualityAlert, EmptyState, ErrorState, SkeletonMetricGrid, SkeletonTable } from "../components/ui.jsx";
import { fmtRangeLabel, monthKeyLabel, nInt } from "../lib/format.js";
import { partitionBrandSourceAccounts, refreshBrandSourceAccounts } from "../lib/brand-source-refresh.js";
import { marketplaceToday } from "../../lib/marketplaces.js";
import { CURRENCY_OPTIONS, brandViewModel, isConvertedMode, shareOf, hasAdsCoverage, hasUnmappedAds } from "../lib/brand-view.js";
import { DASH, buildBrandTables, countryTitle, coverLabel, money, ratePct } from "../lib/brand-view-tables.js";
import { orderStatusItems, portfolioKpis, adSpendKpiCopy } from "../lib/brand-portfolio-view.js";
import { regionLabel } from "../lib/region-view.js";
import { ReportPanel, buildExportModel, freshnessSummaryLine, fxSummaryLine } from "./BrandReports.jsx";
import {
  BvSelect, CustomRangeInputs, ExportMenu, RANGE_PRESETS,
  useBrandCurrency, useBrandExport, useBrandRange, useFxRates,
} from "./brand-controls.jsx";

const PORTFOLIO_VERSION = "brand-view-portfolio-v1";

/* ------------------------------------------------------------------ presentation helpers
   All of these are presentation-only: they read the SAME model + built tables the page
   already computes and reuse the existing formatters and cover/TACoS helpers. No new
   business metric, aggregation or currency rule is introduced here. */

function BvKpi({ label, value, sub, badge, hint, icon }) {
  return (
    <div className="bv-kpi">
      <div className="bv-kpi-top">
        <span className="bv-kpi-label">{icon}{label}</span>
        {badge ? <span className="bv-kpi-badge">{badge}</span> : null}
        {hint ? <span className="bv-kpi-hint" tabIndex={0} role="note" aria-label={hint} title={hint}><Info size={12} aria-hidden="true" /></span> : null}
      </div>
      <div className="bv-kpi-value">{value}</div>
      {sub ? <div className="bv-kpi-sub">{sub}</div> : null}
    </div>
  );
}

// ONE consolidated status panel: the highest-priority live message is shown compactly,
// with every remaining real message behind "View details". Every item is passed in from
// the page's existing evidence; nothing is invented and no warning is suppressed.
function BvStatusPanel({ items }) {
  const [open, setOpen] = useState(false);
  if (!items || !items.length) return null;
  const [head, ...rest] = items;
  const Icon = head.tone === "error" ? AlertTriangle : head.busy ? RefreshCw : Info;
  return (
    <div className={"bv-status bv-status-" + head.tone} role={head.tone === "error" ? "alert" : "status"}>
      <Icon size={15} className={"bv-status-icon" + (head.busy ? " spin" : "")} aria-hidden="true" />
      <div className="bv-status-body">
        <div className="bv-status-head">
          <span className="bv-status-title">{head.title}</span>
          {head.badge ? <span className="bv-status-badge">{head.badge}</span> : null}
          {rest.length ? (
            <button type="button" className="bv-status-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
              {open ? "Hide details" : `View details (${rest.length})`}
            </button>
          ) : null}
        </div>
        {head.detail ? <div className="bv-status-detail">{head.detail}</div> : null}
        {open && rest.length ? (
          <ul className="bv-status-list">
            {rest.map((item, index) => (
              <li key={index} className={"bv-status-item bv-status-item-" + item.tone}>
                <span className="bv-status-item-title">{item.title}</span>
                {item.detail ? <span className="bv-status-item-detail"> — {item.detail}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

// The compact two-column Performance Summary Overview. Populated only when there is a
// SINGLE currency group (so the money bars and the "All Markets" total are real); with
// several currencies the money view is not a single number, so the panel is omitted.
function BvOverview({ tables, currencyLabelNote }) {
  const dGroups = tables?.dailyGroups || [];
  const mGroups = tables?.monthlyGroups || [];
  if (dGroups.length !== 1 || mGroups.length !== 1 || !tables?.monthly?.columns?.current) return null;
  const dGroup = dGroups[0];
  const mGroup = mGroups[0];
  const currency = dGroup.currency;
  const monthly = tables.monthly;
  const completed = monthly.columns.completed || [];
  const current = monthly.columns.current;
  const currentLabel = monthKeyLabel(current.key).replace(/ '\d\d$/, "");
  const cadence = completed.map((month) => ({ key: month.key, label: monthKeyLabel(month.key), value: mGroup.totals[`m_${month.key}`] }));
  const actual = mGroup.totals.currentActual;
  const runRate = mGroup.totals.runRate;
  const cadenceMax = Math.max(1, ...cadence.map((c) => Math.abs(Number(c.value) || 0)), Math.abs(Number(actual) || 0), Math.abs(Number(runRate) || 0));
  const total = dGroup.totals.sales;
  const contrib = dGroup.rows
    .filter((row) => Number.isFinite(row.sales))
    .map((row) => ({ country: row.country, sales: row.sales, share: shareOf(row.sales, total) }))
    .sort((a, b) => (Number(b.sales) || 0) - (Number(a.sales) || 0));
  const contribMax = Math.max(1, ...contrib.map((row) => Math.abs(Number(row.sales) || 0)));
  const pctWidth = (value, max) => `${Math.max(0, Math.min(100, (Math.abs(Number(value) || 0) / max) * 100))}%`;

  return (
    <section className="panel bv-overview">
      <div className="panel-head bv-overview-head">
        <div className="panel-title">Performance summary overview</div>
        <div className="bv-overview-note">Based on monthly and daily saved snapshots</div>
      </div>
      <div className="bv-overview-grid">
        <div className="bv-overview-col">
          <div className="bv-overview-subtitle">Monthly sales cadence <span className="bv-overview-dim">({currency})</span></div>
          <div className="bv-cadence">
            {cadence.map((row) => (
              <div className="bv-cadence-row" key={row.key}>
                <span className="bv-cadence-label">{row.label}</span>
                <span className="bv-cadence-track"><span className="bv-cadence-fill" style={{ width: pctWidth(row.value, cadenceMax) }} /></span>
                <span className="bv-cadence-val num">{money(row.value, currency)}</span>
              </div>
            ))}
            <div className="bv-cadence-row bv-cadence-current">
              <span className="bv-cadence-label">{currentLabel} act.</span>
              <span className="bv-cadence-track">
                <span className="bv-cadence-fill bv-cadence-fill-rr" style={{ width: pctWidth(runRate, cadenceMax) }} />
                <span className="bv-cadence-fill bv-cadence-fill-actual" style={{ width: pctWidth(actual, cadenceMax) }} />
              </span>
              <span className="bv-cadence-val num">{money(actual, currency)} <span className="bv-cadence-rr">({money(runRate, currency)} RR)</span></span>
            </div>
          </div>
        </div>
        <div className="bv-overview-col">
          <div className="bv-overview-subtitle">Marketplace contribution <span className="bv-overview-dim">({currencyLabelNote})</span></div>
          <div className="bv-contrib">
            {contrib.map((row) => (
              <div className="bv-contrib-row" key={row.country}>
                <span className="bv-contrib-label" title={countryTitle(row.country)}>{countryTitle(row.country)}</span>
                <span className="bv-contrib-track"><span className="bv-contrib-fill" style={{ width: pctWidth(row.sales, contribMax) }} /></span>
                <span className="bv-contrib-val num">{money(row.sales, currency)}</span>
                <span className="bv-contrib-share num">{row.share === null ? DASH : `${(row.share * 100).toFixed(1)}%`}</span>
              </div>
            ))}
            <div className="bv-contrib-row bv-contrib-total">
              <span className="bv-contrib-label">All markets</span>
              <span className="bv-contrib-track" aria-hidden="true" />
              <span className="bv-contrib-val num">{money(total, currency)}</span>
              <span className="bv-contrib-share num">100.0%</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

const JUMP_TARGETS = [
  { id: "bv-daily", label: "Daily Snapshot" },
  { id: "bv-monthly", label: "Monthly Snapshot" },
  { id: "bv-weekly", label: "7-Day Performance" },
  { id: "bv-methodology", label: "Methodology" },
];

function BvJumpNav({ brandNote }) {
  const jump = (event, id) => {
    event.preventDefault();
    const el = typeof document !== "undefined" ? document.getElementById(id) : null;
    if (!el) return;
    // Smooth scroll only when motion is allowed; jump immediately under reduced motion.
    const reduceMotion = typeof window !== "undefined" && window.matchMedia
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (el.scrollIntoView) el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    // Focus transfer is preserved regardless of motion so keyboard users land on the section.
    if (el.focus) { try { el.setAttribute("tabindex", "-1"); el.focus({ preventScroll: true }); } catch (_e) { /* ignore */ } }
  };
  return (
    <nav className="bv-jump" aria-label="Jump to section">
      <span className="bv-jump-label">Jump to</span>
      <span className="bv-jump-links">
        {JUMP_TARGETS.map((target) => (
          <a key={target.id} href={`#${target.id}`} className="bv-jump-link" onClick={(event) => jump(event, target.id)}>{target.label}</a>
        ))}
      </span>
      {brandNote ? <span className="bv-jump-note">{brandNote}</span> : null}
    </nav>
  );
}

export default function BrandPortfolio({
  brand, region = "", accountIds, accountsKnown, loadReport, refreshReport,
  directoryLoading, directoryError, onLoadBrandDirectory,
  isAdmin = false, sourceAccounts = [],
}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [savedAt, setSavedAt] = useState(null);
  const [staleScope, setStaleScope] = useState(null);
  // `updating` = the server served the last-known-good but the contributing sources have advanced (or no
  // snapshot exists yet), so a bounded zero-export rebuild is due. The page keeps showing the LKG (never blanks
  // on a 504) and auto-converges by triggering the rebuild + polling until the fresh snapshot lands.
  const [updating, setUpdating] = useState(false);
  const rebuildAttempts = useRef(0);
  const [refreshing, setRefreshing] = useState(false);
  const [sourceRefreshing, setSourceRefreshing] = useState(false);
  const [sourceProgress, setSourceProgress] = useState(null);
  const [sourceOutcome, setSourceOutcome] = useState(null);
  const refreshGuard = useRef(false);
  const sourceRefreshGuard = useRef(false);

  // A stable, sorted account signature keeps the snapshot key deterministic no
  // matter what order the directory returned the accounts in.
  const idsKey = useMemo(
    () => [...new Set((accountIds || []).map(String))].sort().join(","),
    [accountIds]
  );
  // India's business day is the workspace's reference calendar for a report that
  // deliberately spans marketplaces; the payload itself is anchored to the
  // latest date the sources actually populated, not to this.
  const asOf = useMemo(() => marketplaceToday("IN"), []);

  const model = useMemo(() => (data ? brandViewModel(data) : null), [data]);
  // A brand sold across accounts and marketplaces usually spans several
  // currencies, so it opens converted to one reporting currency and reads as a
  // single clean table. A single-currency brand stays in its own currency.
  const { displayCurrency, setDisplayCurrency } = useBrandCurrency(model, `${brand}::${idsKey}`);
  const { fx, fxError, reloadFx } = useFxRates(loadReport, displayCurrency);
  const range = useBrandRange({
    latestDate: model?.latestDate || null,
    coverageFrom: model?.coverage?.salesFrom || null,
    // Accounts refresh at different times, so the single newest day is often
    // populated for only some of them. Opening on 30 days avoids presenting a
    // partial day as the headline; "Latest reported day" is still one click away
    // and the freshness bar names the date every account is complete through.
    initialPreset: "30D",
  });

  const reportParams = useMemo(() => {
    // A region is required: Brand View is region-scoped, and the server enforces + segregates the snapshot by region.
    if (!brand || !idsKey || !region) return null;
    return { action: "brand-view-portfolio", reportVersion: PORTFOLIO_VERSION, ids: idsKey, brand, asOf, region };
  }, [asOf, brand, idsKey, region]);

  const applyReport = useCallback((body, cachedAt) => {
    // `updating` means a rebuild is due; the page shows the LKG (if any) and converges. It is NOT an error and
    // NOT "no data" -- a missing-but-updating response is a "preparing" state, never the blank empty state.
    setUpdating(!!body.updating);
    if (body.snapshotMissing) {
      setData(null);
      setNotice(body.message);
      setSavedAt(null);
      setStaleScope(null);
      return;
    }
    setData(body);
    setNotice(null);
    setSavedAt(body.snapshot?.savedAt ? new Date(body.snapshot.savedAt) : (cachedAt ? new Date(cachedAt) : null));
    setStaleScope(body.snapshot?.staleScope ? body.snapshot.savedForParams || {} : null);
  }, []);

  // Auto-converge an `updating` Brand View by POLLING the saved snapshot READ-ONLY (loadReport). The regional
  // scheduler now OWNS materialization, so converging a page never triggers a server rebuild, snapshot write, lock,
  // or DataDoe activity. When the scheduler republishes the fresh snapshot, this bounded read-only poll replaces
  // the LKG with no user action; if it does not converge within the bounded attempts, the LKG stays on screen and
  // the explicit Refresh button (the only rebuild path, and only on a real click) remains available.
  useEffect(() => {
    if (!updating || !reportParams || refreshGuard.current) return undefined;
    if (rebuildAttempts.current >= 6) return undefined; // give up auto-poll; the Refresh button still works
    let active = true;
    const delay = rebuildAttempts.current === 0 ? 400 : 3500;
    const timer = setTimeout(async () => {
      rebuildAttempts.current += 1;
      try {
        const { body, cachedAt } = await loadReport(reportParams);
        if (active) applyReport(body, cachedAt);
      } catch { /* transient; the next read-only poll retries */ }
    }, delay);
    return () => { active = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updating, reportParams, applyReport, loadReport]);

  // Changing brand must clear the previous brand's numbers before the next
  // request lands, so two brands can never be on screen at once.
  const resetRange = range.reset;
  useEffect(() => {
    setData(null);
    setError(null);
    setNotice(null);
    setSavedAt(null);
    setStaleScope(null);
    setUpdating(false);
    rebuildAttempts.current = 0;
    setSourceProgress(null);
    setSourceOutcome(null);
    resetRange();
  }, [brand, idsKey, region, resetRange]);

  useEffect(() => {
    if (!reportParams) return undefined;
    let active = true;
    setLoading(true);
    setError(null);
    loadReport(reportParams)
      .then(({ body, cachedAt }) => { if (active) applyReport(body, cachedAt); })
      .catch((loadError) => { if (active) { setError(loadError.message); setData(null); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [applyReport, loadReport, reportParams]);

  const onRefresh = useCallback(async () => {
    if (!reportParams || refreshGuard.current) return;
    refreshGuard.current = true;
    setRefreshing(true);
    setError(null);
    try {
      const { body, cachedAt } = await refreshReport(reportParams);
      applyReport(body, cachedAt);
      if (isConvertedMode(displayCurrency)) await reloadFx();
    } catch (refreshError) {
      setError(refreshError.message);
    } finally {
      refreshGuard.current = false;
      setRefreshing(false);
    }
  }, [applyReport, displayCurrency, refreshReport, reloadFx, reportParams]);

  const sourceAccountPartition = useMemo(
    () => partitionBrandSourceAccounts(sourceAccounts),
    [sourceAccounts]
  );

  const onFetchLatestData = useCallback(async () => {
    if (!isAdmin || !reportParams || sourceRefreshGuard.current) return;
    const eligibleCount = sourceAccountPartition.eligible.length;
    const skippedCount = sourceAccountPartition.skipped.length;
    if (!eligibleCount) {
      setSourceOutcome({
        tone: "warning",
        title: "No primary DataDoe accounts are ready",
        detail: skippedCount
          ? "The mapped accounts still use legacy Secondary DataDoe ids. Reload the account and brand directories after moving them to the primary organization."
          : "No mapped account is available for this brand.",
      });
      return;
    }

    const confirmed = window.confirm(
      `Fetch latest DataDoe data for ${eligibleCount} mapped account${eligibleCount === 1 ? "" : "s"}?\n\n`
      + "This temporary admin action runs accounts sequentially with no automatic retry. "
      + "Each account refreshes Brand Sales (up to two DataDoe exports) and then compact FBA inventory "
      + "(one FBA Inventory Health export, reusing the Product Catalog it just fetched). "
      + "Existing saved data is preserved when an account fails."
    );
    if (!confirmed) return;

    sourceRefreshGuard.current = true;
    setSourceRefreshing(true);
    setSourceOutcome(null);
    setError(null);
    try {
      const outcome = await refreshBrandSourceAccounts({
        accounts: sourceAccounts,
        refreshReport,
        todayForCountry: marketplaceToday,
        onProgress: setSourceProgress,
      });

      // Rebuild the shared portfolio whenever any account saved new sales OR
      // inventory, so a fresh FBA snapshot shows up even if that account's sales
      // step failed.
      if (outcome.succeeded.length) {
        const { body, cachedAt } = await refreshReport(reportParams);
        applyReport(body, cachedAt);
        if (isConvertedMode(displayCurrency)) await reloadFx();
      }

      // Report each source outcome distinctly. Only account NAMES are shown; raw
      // upstream DataDoe/Supabase error bodies are never surfaced in the browser.
      const nameOf = (account) => account.name || account.id;
      const details = [
        `${outcome.salesSucceeded.length} of ${outcome.attempted} account${outcome.attempted === 1 ? "" : "s"} refreshed sales; ${outcome.inventorySucceeded.length} refreshed FBA inventory.`,
      ];
      if (outcome.salesFailed.length) details.push(`Sales failed: ${outcome.salesFailed.map(({ account }) => nameOf(account)).join(", ")}.`);
      if (outcome.inventoryFailed.length) details.push(`FBA inventory failed: ${outcome.inventoryFailed.map(({ account }) => nameOf(account)).join(", ")}.`);
      if (outcome.salesFailed.length || outcome.inventoryFailed.length) details.push("Previous saved data was preserved.");
      if (outcome.skipped.length) {
        details.push(`${outcome.skipped.length} legacy Secondary DataDoe mapping${outcome.skipped.length === 1 ? " was" : "s were"} skipped. Move those sellers to the primary DataDoe organization, then reload the account and brand directories.`);
      }
      const hasExceptions = outcome.salesFailed.length || outcome.inventoryFailed.length || outcome.skipped.length;
      setSourceOutcome({
        tone: hasExceptions ? "warning" : "success",
        title: hasExceptions ? "Latest data fetched with exceptions" : "Latest data fetched",
        detail: details.join(" "),
      });
    } catch {
      setSourceOutcome({
        tone: "warning",
        title: "Latest data could not be fetched",
        detail: "The refresh sequence stopped before completion. Existing saved snapshots were preserved.",
      });
    } finally {
      sourceRefreshGuard.current = false;
      setSourceRefreshing(false);
      setSourceProgress(null);
    }
  }, [applyReport, displayCurrency, isAdmin, refreshReport, reloadFx, reportParams, sourceAccountPartition, sourceAccounts]);

  /* ------------------------------- exports ------------------------------ */
  const converted = isConvertedMode(displayCurrency);
  const currencyLabel = converted ? `Converted to ${displayCurrency}` : "Original marketplace currency";

  // The three tables + their currency groups, built from the SAME model + FX rates the
  // account-scoped page uses (identical numbers, formulas and export). Computed here so
  // the portfolio renders its own layout while the export still consumes this exact output.
  const rates = fx?.rates || null;
  const tables = useMemo(
    () => (model ? buildBrandTables(model, { rangeFrom: range.rangeFrom, rangeTo: range.rangeTo, displayCurrency, rates }) : null),
    [model, range.rangeFrom, range.rangeTo, displayCurrency, rates]
  );

  const exportModel = useMemo(() => {
    if (!model || !tables) return null;
    const accountNames = (model.accounts || []).map((entry) => entry.name || entry.id);
    return buildExportModel({
      tables,
      model,
      meta: {
        accountId: idsKey,
        accountName: accountNames.length ? accountNames.join(", ") : "Portfolio",
        brand: model.brand,
        rangeLabel: range.rangeFrom && range.rangeTo ? fmtRangeLabel(range.rangeFrom, range.rangeTo) : DASH,
        asOf: tables.anchor || model.asOf,
        currencyLabel,
        currencyCode: converted ? displayCurrency : "original",
        fxLine: fxSummaryLine(fx, converted),
        fxAttribution: converted ? (fx?.attribution || null) : null,
        freshnessLine: freshnessSummaryLine(model),
        generatedAt: new Date().toISOString(),
        limitations: model.notes,
        footer: [
          `Upriver Brand View (portfolio). ${model.brand} across ${accountNames.length} account${accountNames.length === 1 ? "" : "s"}, built from shared Supabase snapshots of their saved Dashboard, Ads and FBA reports.`,
          converted
            ? `Money converted to ${displayCurrency}. ${fx?.attribution || ""}`
            : "Money is shown in each marketplace's original currency and is never summed across currencies.",
        ].join(" "),
      },
    });
  }, [converted, currencyLabel, displayCurrency, fx, idsKey, model, range.rangeFrom, range.rangeTo, tables]);

  const { runExport, exportBusy, exportError } = useBrandExport(exportModel);

  /* ------------------------------- render ------------------------------- */
  const accountCount = model?.accounts?.length || 0;
  const coverage = model?.coverage || {};
  const marketplaceCount = tables?.marketplaceCount || 0;
  const kpis = tables ? portfolioKpis(tables) : null;
  const rangeLabel = range.rangeFrom && range.rangeTo ? fmtRangeLabel(range.rangeFrom, range.rangeTo) : "";
  const RANGE_BADGE = { "7D": "7D", "30D": "30D", MTD: "MTD", LASTMONTH: "Last month", LATEST: "Latest day", CUSTOM: "Custom" };
  const rangeBadge = RANGE_BADGE[range.preset] || null;
  const adPartial = Boolean(model) && model.countries.some((entry) => entry.adsAvailable) && model.countries.some((entry) => !entry.adsAvailable);
  // Accurate Ad Spend KPI copy: active attribution is Campaign Ads (campaign->brand mapping), and an em dash names the
  // real reason (no coverage / campaigns unmapped / per-marketplace) from existing model+coverage data -- never a
  // stale "same-ASIN" claim, and never "no saved Ads history" when saved Ads exist. A shown total that omits an
  // uncovered OR unmapped marketplace is flagged Partial.
  const adUnmapped = hasUnmappedAds(model, range.rangeFrom, range.rangeTo);
  const adSpendCopy = adSpendKpiCopy({
    hasValue: Boolean(kpis) && kpis.adSpend !== null && kpis.adSpend !== undefined,
    valuePartial: adPartial || adUnmapped,
    hasAdsCoverage: hasAdsCoverage(model),
    hasUnmapped: adUnmapped,
    singleCurrency: Boolean(kpis && kpis.single),
  });
  const lastYear = tables?.daily?.lastYearWindow;
  const weekDates = tables?.weekly?.dates || [];
  const weekLabel = weekDates.length ? fmtRangeLabel(weekDates[0], weekDates[weekDates.length - 1]) : "";
  const monthlyCols = tables?.monthly?.columns;
  const monthlySub = monthlyCols?.current
    ? [
      monthlyCols.completed.length
        ? `${monthKeyLabel(monthlyCols.completed[0].key)} – ${monthKeyLabel(monthlyCols.current.key)}`
        : monthKeyLabel(monthlyCols.current.key),
      `${monthKeyLabel(monthlyCols.current.key)} MTD (${monthlyCols.current.elapsedDays} days)`,
      `RR = (Act ÷ ${monthlyCols.current.elapsedDays}) × ${monthlyCols.current.daysInMonth}`,
      currencyLabel,
    ].join(" · ")
    : currencyLabel;
  const totalSalesSub = kpis && kpis.single
    ? (kpis.ly === null
      ? "LY unavailable for this window"
      : <span>LY {money(kpis.ly, kpis.currency)}{kpis.lyDelta !== null ? <span className={"bv-delta " + (kpis.lyDelta < 0 ? "bv-neg" : "bv-pos")}> {kpis.lyDelta >= 0 ? "+" : ""}{(kpis.lyDelta * 100).toFixed(1)}%</span> : null}</span>)
    : "Shown per currency in the tables";

  // ONE consolidated status list: every real message the page can raise, ordered by
  // priority. The panel shows the top one and exposes the rest through "View details".
  // Nothing is invented or suppressed; each item is an existing page message.
  const statusItems = [];
  if (sourceProgress) statusItems.push({ tone: "info", busy: true, title: `Fetching latest account data (${Math.min(sourceProgress.completed + 1, sourceProgress.total)} of ${sourceProgress.total})`, detail: sourceProgress.account?.name || sourceProgress.account?.id || "Saving refreshed account snapshots" });
  if (converted && fxError) statusItems.push({ tone: "error", title: "Currency conversion is unavailable", detail: fxError });
  if (updating && model) statusItems.push({ tone: "warning", badge: "Rebuild in progress", title: "Updating to the newest saved data", detail: "The figures shown are the last complete Brand View. A newer account snapshot arrived, so it is being rebuilt from saved data (no export) and refreshes here automatically." });
  if (sourceOutcome) statusItems.push({ tone: sourceOutcome.tone, title: sourceOutcome.title, detail: sourceOutcome.detail });
  if (staleScope) statusItems.push({ tone: "info", title: "Showing the most recent saved report for this brand", detail: `It was saved for ${staleScope.asOf || "an earlier date"}. Refresh rebuilds it from the newest saved account snapshots.` });
  if (directoryError) statusItems.push({ tone: "warning", title: "Some portfolio brands could not be loaded", detail: directoryError });
  if (converted && fx?.fallback) statusItems.push({ tone: "warning", title: "Using cached exchange rates", detail: fx.message || "The exchange-rate provider was unreachable, so the last rates saved in Supabase are being used." });
  if (converted && !fxError && tables?.missingRates?.length) statusItems.push({ tone: "warning", title: `No exchange rate for ${tables.missingRates.join(", ")}`, detail: `Those marketplaces cannot be converted to ${displayCurrency} and are shown as unavailable rather than with a substituted rate. Switch to Original marketplace currency to see their real figures.` });
  (model?.notes || []).forEach((note) => statusItems.push({ tone: "info", title: "Partial source coverage", detail: note }));
  if (directoryLoading) statusItems.push({ tone: "info", busy: true, title: "Updating brand coverage…", detail: "Re-checking every account you can access against the latest saved brand sales (saved data only; no export)." });

  return (
    <div className="container bv-page op-report bv-portfolio">
      {/* BRAND CONTEXT HEADER — brand, dynamic account + marketplace counts, currency and
          regional scope are metadata (not KPI cards); every value comes from the live model. */}
      <div className="page-head bv-head">
        <div className="bv-head-main">
          <div className="bv-head-titlerow">
            <span className="page-title">Brand View</span>
            {brand ? <span className="bv-brand-chip"><Tag size={12} aria-hidden="true" />{brand}</span> : null}
            {model ? (
              <span className="bv-head-counts"><Layers size={13} aria-hidden="true" />{accountCount} account{accountCount === 1 ? "" : "s"} · {marketplaceCount} marketplace{marketplaceCount === 1 ? "" : "s"}</span>
            ) : null}
          </div>
          <div className="page-sub bv-head-desc">
            {brand
              ? "Cross-account, marketplace-aggregated commercial performance from saved snapshot data."
              : "Choose a brand in the header to compare it across every account and marketplace that sells it."}
          </div>
        </div>
        {model ? (
          <div className="bv-head-meta">
            <div className="bv-meta-item"><span className="bv-meta-label">Currency</span><span className="bv-meta-value">{converted ? displayCurrency : "Original"}</span></div>
            {region ? <div className="bv-meta-item"><span className="bv-meta-label">Scope</span><span className="bv-meta-value">{regionLabel(region)}</span></div> : null}
          </div>
        ) : null}
      </div>

      <div className="bv-controls" role="group" aria-label="Brand View scope">
        <BvSelect
          id="bp-range"
          label="Date range"
          icon={<CalendarRange size={14} aria-hidden="true" />}
          value={range.preset}
          onChange={range.setPreset}
          options={RANGE_PRESETS}
          disabled={!model}
          hint="Sets the Daily Snapshot window and anchors the Monthly and 7-Day reports to its final day."
        />
        {range.preset === "CUSTOM" && (
          <CustomRangeInputs
            from={range.customFrom || model?.coverage?.salesFrom || ""}
            to={range.customTo || model?.latestDate || ""}
            min={model?.coverage?.salesFrom}
            max={model?.latestDate}
            onFrom={range.setCustomFrom}
            onTo={range.setCustomTo}
          />
        )}
        <BvSelect
          id="bp-currency"
          label="Currency"
          icon={<Coins size={14} aria-hidden="true" />}
          value={displayCurrency}
          onChange={setDisplayCurrency}
          options={CURRENCY_OPTIONS}
          hint="Original keeps every marketplace in its own currency and never sums across currencies."
        />
        <div className="bv-actions">
          <button
            type="button"
            className="plan-export-btn"
            onClick={onRefresh}
            disabled={!reportParams || refreshing || sourceRefreshing}
            title={reportParams
              ? "Rebuild this brand across its mapped accounts from the shared saved snapshots. No new source export is created."
              : "Choose a brand first"}
          >
            <RefreshCw size={14} className={refreshing ? "spin" : ""} aria-hidden="true" />
            Refresh
          </button>
          <ExportMenu disabled={!exportModel} busy={exportBusy} error={exportError} onExport={runExport} />
          {/* Admin-only source action — kept distinct and secondary (not the default action),
              flagged ADMIN, with its exact existing handler and availability preserved. */}
          {isAdmin && (
            <button
              type="button"
              className="plan-export-btn bv-admin-btn"
              onClick={onFetchLatestData}
              disabled={!reportParams || sourceRefreshing || refreshing}
              title="Temporary admin action: refresh the mapped primary accounts from DataDoe, then rebuild this Brand View from their saved snapshots."
            >
              <DatabaseZap size={14} className={sourceRefreshing ? "spin" : ""} aria-hidden="true" />
              Fetch latest data
              <span className="bv-admin-tag">Admin</span>
            </button>
          )}
        </div>
      </div>

      {/* Compact dynamic freshness row from existing evidence only. Wraps; never truncates. */}
      {model && (
        <div className="recon-freshness bv-freshness">
          <span className="bv-fresh-item"><span className="live-dot" aria-hidden="true" />{savedAt ? `Shared snapshot ${savedAt.toLocaleString()}` : "Shared snapshot"}</span>
          <span className="bv-fresh-item">{coverage.accountCount || accountCount} account{(coverage.accountCount || accountCount) === 1 ? "" : "s"} covered</span>
          {coverage.salesSavedAt ? <span className="bv-fresh-item">Oldest {new Date(coverage.salesSavedAt).toLocaleString()}</span> : null}
          {coverage.salesFrom && coverage.salesTo ? <span className="bv-fresh-item">Sales {coverage.salesFrom} → {coverage.salesTo}</span> : null}
          <span className="bv-fresh-item">FBA {coverage.inventoryDate ? `as of ${coverage.inventoryDate}` : "unavailable"}</span>
          {converted ? <span className="bv-fresh-item">{fxSummaryLine(fx, converted)}</span> : null}
          <span className="bv-fresh-item">{converted ? `Display ${displayCurrency}` : "Original currency"}</span>
        </div>
      )}

      {/* ONE consolidated status panel: the highest-SEVERITY current condition is shown
          compact (error > warning > success > info/busy), the rest under View details.
          orderStatusItems is a stable severity sort, so no message is dropped. */}
      <BvStatusPanel items={orderStatusItems(statusItems)} />

      {!brand ? (
        <div className="panel">
          <EmptyState
            icon={<Tag size={19} aria-hidden="true" />}
            title="Choose a brand"
            actions={onLoadBrandDirectory ? (
              <button className="plan-export-btn" type="button" onClick={onLoadBrandDirectory} disabled={directoryLoading}>
                <RefreshCw size={14} className={directoryLoading ? "spin" : ""} aria-hidden="true" />
                Load portfolio brands
              </button>
            ) : null}
          >
            Pick a brand in the header to see it across every account and marketplace that sells it. The first use on a
            fresh browser needs one manual brand-directory load; it reads only accounts you may access and never runs
            automatically.
          </EmptyState>
        </div>
      ) : !idsKey ? (
        <div className="panel">
          <EmptyState
            icon={<DatabaseZap size={19} aria-hidden="true" />}
            title={(!accountsKnown || directoryLoading) ? "Updating brand coverage…" : "No saved account records this brand yet"}
          >
            {(!accountsKnown || directoryLoading)
              ? "Checking every account you can access against the latest saved brand sales. This reads saved data only and never runs a DataDoe export."
              : `No saved brand-sales snapshot records "${brand}" in any account you can access yet. It will appear automatically once the scheduled data refresh saves sales for it.`}
          </EmptyState>
        </div>
      ) : error ? (
        <div className="panel">
          <ErrorState title="Brand View could not be built" message={error} onRetry={onRefresh} busy={refreshing} retryLabel="Rebuild from saved data" />
        </div>
      ) : loading && !model ? (
        <><SkeletonMetricGrid count={4} /><div className="panel panel-flush"><SkeletonTable rows={8} /></div></>
      ) : notice ? (
        <div className="panel">
          <EmptyState
            icon={updating ? <RefreshCw size={19} className="spin" aria-hidden="true" /> : <Inbox size={19} aria-hidden="true" />}
            title={updating ? "Preparing Brand View from saved data…" : "No saved Brand View for this brand yet"}
            actions={(
              <>
                {isAdmin && (
                  <button className="plan-export-btn" type="button" onClick={onFetchLatestData} disabled={sourceRefreshing || refreshing}>
                    <DatabaseZap size={14} className={sourceRefreshing ? "spin" : ""} aria-hidden="true" />
                    Fetch latest data
                  </button>
                )}
                <button className="plan-export-btn" type="button" onClick={onRefresh} disabled={refreshing || sourceRefreshing}>
                  <RefreshCw size={14} className={refreshing ? "spin" : ""} aria-hidden="true" />
                  Build from saved data
                </button>
              </>
            )}
          >
            {notice} Build from saved data creates no source export. The temporary admin action fetches each mapped primary
            account sequentially, then rebuilds this shared Brand View.
          </EmptyState>
        </div>
      ) : model ? (
        <>
          {/* Six commercial KPI cells from the existing model/formatter. Money is only a single
              number in one currency group; otherwise it is an em dash, never a zero. */}
          <div className="bv-kpi-strip">
            <BvKpi label="Total Sales" badge={rangeBadge} value={kpis.single ? money(kpis.sales, kpis.currency) : DASH} sub={totalSalesSub} />
            <BvKpi label="Units Sold" icon={<Boxes size={12} aria-hidden="true" />} badge={rangeBadge} value={nInt(kpis.units)} sub={`Across ${marketplaceCount} marketplace${marketplaceCount === 1 ? "" : "s"}`} hint="Ordered units summed across every marketplace. Unit counts are never currency converted." />
            <BvKpi label="FBA Inventory" value={kpis.fba === null ? DASH : nInt(kpis.fba)} sub={`Available FBA units${coverage.inventoryDate ? ` · as of ${coverage.inventoryDate}` : ""}`} hint={kpis.fba === null ? "No overall FBA inventory total is available for this scope." : "Available FBA units for this brand's ASINs; unit counts are never currency converted."} />
            <BvKpi label="FBA Cover" value={kpis.cover === null ? DASH : coverLabel(kpis.cover)} sub="Based on selected-range unit velocity" hint="Available FBA units divided by this brand's average daily unit sales in the selected range." />
            <BvKpi label="Ad Spend" badge={adSpendCopy.badge} value={kpis.adSpend === null ? DASH : money(kpis.adSpend, kpis.currency, 2)} sub={adSpendCopy.sub} />
            <BvKpi label="TACoS" badge="Overall" value={kpis.tacos === null ? DASH : ratePct(kpis.tacos)} sub="Brand ad spend ÷ brand sales" />
          </div>

          <BvOverview tables={tables} currencyLabelNote={rangeLabel || "selected range"} />

          <BvJumpNav brandNote={`Brand: ${model.brand} · ${converted ? `Converted to ${displayCurrency}` : "Original currency"}`} />

          {tables.dailyTable && (
            <div id="bv-daily">
              <ReportPanel
                title={`${model.brand} — Daily Snapshot`}
                subtitle={[
                  rangeLabel,
                  lastYear ? `LY compares ${fmtRangeLabel(lastYear.from, lastYear.to)}` : "LY unavailable for this window",
                  coverage.inventoryDate ? `FBA Inv. as of ${coverage.inventoryDate}` : "FBA Inv. unavailable",
                  currencyLabel,
                ].filter(Boolean).join(" · ")}
                headers={tables.dailyTable.headers}
                rows={tables.dailyTable.rows}
                minWidth={1040}
              />
            </div>
          )}
          {tables.monthlyTable && (
            <div id="bv-monthly">
              <ReportPanel title={`${model.brand} — Monthly Snapshot`} subtitle={monthlySub} headers={tables.monthlyTable.headers} rows={tables.monthlyTable.rows} minWidth={1040} />
            </div>
          )}
          {tables.weeklyTable && (
            <div id="bv-weekly">
              <ReportPanel
                title={`${model.brand} — 7-Day Performance`}
                subtitle={[weekLabel, `${marketplaceCount} marketplace${marketplaceCount === 1 ? "" : "s"}`, currencyLabel].filter(Boolean).join(" · ")}
                headers={tables.weeklyTable.headers}
                rows={tables.weeklyTable.rows}
                minWidth={1000}
              />
            </div>
          )}

          <details id="bv-methodology" className="methodology-disclosure bv-methodology">
            <summary>Data methodology, currency and coverage policy</summary>
            <div className="footer-note">
              Portfolio Brand View is a shared Supabase snapshot for this brand and its accounts. A marketplace sold by more
              than one account is one row: their sales and units are added together, and the contributing accounts are named
              under the country. FBA cover is calculated from available FBA units and average daily unit sales in the selected
              report range. A blank cell means the source cannot answer, never zero.{converted ? ` Converted figures use server-side cached rates. ${fx?.attribution || ""}` : ""}
            </div>
          </details>
        </>
      ) : null}
    </div>
  );
}
