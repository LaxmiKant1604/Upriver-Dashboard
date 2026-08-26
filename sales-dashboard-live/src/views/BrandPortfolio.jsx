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
import { CalendarRange, Coins, DatabaseZap, Inbox, RefreshCw, Tag } from "lucide-react";

import { DataQualityAlert, EmptyState, ErrorState, SkeletonMetricGrid, SkeletonTable } from "../components/ui.jsx";
import { fmtRangeLabel } from "../lib/format.js";
import { partitionBrandSourceAccounts, refreshBrandSourceAccounts } from "../lib/brand-source-refresh.js";
import { marketplaceToday } from "../../lib/marketplaces.js";
import { CURRENCY_OPTIONS, brandViewModel, isConvertedMode } from "../lib/brand-view.js";
import { DASH } from "../lib/brand-view-tables.js";
import BrandReports, { buildExportModel, freshnessSummaryLine, fxSummaryLine } from "./BrandReports.jsx";
import {
  BvSelect, CustomRangeInputs, ExportMenu, RANGE_PRESETS,
  useBrandCurrency, useBrandExport, useBrandRange, useFxRates,
} from "./brand-controls.jsx";

const PORTFOLIO_VERSION = "brand-view-portfolio-v1";

export default function BrandPortfolio({
  brand, accountIds, accountsKnown, loadReport, refreshReport,
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
  const [tables, setTables] = useState(null);
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
    if (!brand || !idsKey) return null;
    return { action: "brand-view-portfolio", reportVersion: PORTFOLIO_VERSION, ids: idsKey, brand, asOf };
  }, [asOf, brand, idsKey]);

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

  // Auto-converge an `updating` Brand View: trigger the bounded zero-export rebuild (refresh), then re-apply.
  // A rebuild that runs out of the route budget returns `updating` again -> this re-fires (bounded attempts) so
  // the fresh snapshot eventually replaces the LKG with no user action. One rebuild at a time (server lock); a
  // concurrent holder (409) falls back to a plain read poll.
  useEffect(() => {
    if (!updating || !reportParams || refreshGuard.current) return undefined;
    if (rebuildAttempts.current >= 6) return undefined; // give up auto-rebuild; the Refresh button still works
    let active = true;
    const delay = rebuildAttempts.current === 0 ? 400 : 3500;
    const timer = setTimeout(async () => {
      rebuildAttempts.current += 1;
      try {
        const { body, cachedAt } = await refreshReport(reportParams);
        if (active) applyReport(body, cachedAt);
      } catch {
        try { const { body, cachedAt } = await loadReport(reportParams); if (active) applyReport(body, cachedAt); }
        catch { /* transient; the next attempt retries */ }
      }
    }, delay);
    return () => { active = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updating, reportParams, applyReport, refreshReport, loadReport]);

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
    setTables(null);
    setSourceProgress(null);
    setSourceOutcome(null);
    resetRange();
  }, [brand, idsKey, resetRange]);

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

  return (
    <div className="container bv-page">
      <div className="page-head">
        <div>
          <div className="page-title">Brand View</div>
          <div className="page-sub">
            {brand
              ? `${brand} across every account and marketplace that sells it. Refresh rebuilds from saved data; admins can temporarily fetch latest account data from DataDoe.`
              : "Choose a brand in the header to compare it across every account and marketplace that sells it."}
          </div>
        </div>
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
          {isAdmin && (
            <button
              type="button"
              className="plan-export-btn"
              onClick={onFetchLatestData}
              disabled={!reportParams || sourceRefreshing || refreshing}
              title="Temporary admin action: refresh the mapped primary accounts from DataDoe, then rebuild this Brand View from their saved snapshots."
            >
              <DatabaseZap size={14} className={sourceRefreshing ? "spin" : ""} aria-hidden="true" />
              Fetch latest data
            </button>
          )}
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
        </div>
      </div>

      {model && (
        <div className="recon-freshness bv-freshness">
          <span className="live-dot" style={{ position: "relative", top: 1 }} aria-hidden="true" />
          <span>{savedAt ? `Shared snapshot saved ${savedAt.toLocaleString()}` : "Shared snapshot"}</span>
          <span className="plan-fresh-sep">·</span>
          <span>{freshnessSummaryLine(model)}</span>
          {converted && <><span className="plan-fresh-sep">·</span><span>{fxSummaryLine(fx, converted)}</span></>}
        </div>
      )}

      {/* Compact, non-blocking "Updating brand coverage" indicator: the account set is being re-checked against
          the latest saved brand-sales (self-healing, Supabase-only). Previous content stays on screen. */}
      {directoryLoading && (
        <div className="plan-fresh" style={{ opacity: 0.85 }}>
          <RefreshCw size={13} className="spin" aria-hidden="true" />
          <span>Updating brand coverage…</span>
        </div>
      )}
      {directoryError && <DataQualityAlert tone="warning" title="Some portfolio brands could not be loaded" detail={directoryError} />}
      {sourceProgress && (
        <DataQualityAlert
          tone="info"
          title={`Fetching latest account data (${Math.min(sourceProgress.completed + 1, sourceProgress.total)} of ${sourceProgress.total})`}
          detail={sourceProgress.account?.name || sourceProgress.account?.id || "Saving refreshed account snapshots"}
        />
      )}
      {sourceOutcome && <DataQualityAlert tone={sourceOutcome.tone} title={sourceOutcome.title} detail={sourceOutcome.detail} />}
      {staleScope && (
        <DataQualityAlert
          tone="info"
          title="Showing the most recent saved report for this brand"
          detail={`It was saved for ${staleScope.asOf || "an earlier date"}. Click Refresh to rebuild it from the newest saved account snapshots.`}
        />
      )}
      {updating && model && (
        <DataQualityAlert
          tone="info"
          title="Updating to the newest saved data…"
          detail="The figures below are the last complete Brand View. A newer account snapshot arrived, so it is being rebuilt from saved data (no export) and will refresh here automatically."
        />
      )}

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
          <BrandReports
            model={model}
            rangeFrom={range.rangeFrom}
            rangeTo={range.rangeTo}
            displayCurrency={displayCurrency}
            fx={fx}
            fxError={fxError}
            scopeLabel={`${accountCount} account${accountCount === 1 ? "" : "s"}`}
            onTables={setTables}
          />
          <div className="footer-note">
            Portfolio Brand View is a shared Supabase snapshot for this brand and its accounts. A marketplace sold by more
            than one account is one row: their sales and units are added together, and the contributing accounts are named
            under the country. FBA cover is calculated from available FBA units and average daily unit sales in the selected
            report range. A blank cell means the source cannot answer, never zero.{converted ? ` Converted figures use server-side cached rates. ${fx?.attribution || ""}` : ""}
          </div>
        </>
      ) : null}
    </div>
  );
}
