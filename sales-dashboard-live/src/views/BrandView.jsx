/* =====================================================================
   BRAND VIEW — Account -> Brand -> Brand Reports
   =====================================================================

   The account-scoped Brand View, route key `brandview`. One permitted account,
   one brand, every marketplace that account sells the brand in.

   THE FLOW
     1. The user picks one permitted Account. Nothing else is enabled first.
     2. Brands are loaded for THAT account only, from that account's saved
        Supabase snapshots. The dropdown is disabled until an account exists and
        can never contain a brand from another account.
     3. The user picks a brand and gets the three country-wise reports.

   WHAT MAY CALL A SOURCE
     Nothing here starts a DataDoe export — not navigation, not an account or
     brand switch, not a date or currency change, not an export. Reads go to the
     shared Supabase snapshot. Refresh re-aggregates this account+brand from
     already-saved snapshots under a cross-user lock and saves one shared result.

   The tables themselves live in BrandReports.jsx, shared with the cross-account
   portfolio page, so the two reports can never disagree.                     */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarRange, Coins, Inbox, RefreshCw, Store, Tag } from "lucide-react";

import { DataQualityAlert, EmptyState, ErrorState, ObservedUnitsBreakdown, SkeletonMetricGrid, SkeletonTable } from "../components/ui.jsx";
import { FLAGS, fmtRangeLabel } from "../lib/format.js";
import { marketplaceToday } from "../../lib/marketplaces.js";
import { CURRENCY_OPTIONS, brandViewModel, isConvertedMode } from "../lib/brand-view.js";
import { DASH } from "../lib/brand-view-tables.js";
import BrandReports, { buildExportModel, freshnessSummaryLine, fxSummaryLine } from "./BrandReports.jsx";
import {
  BvSelect, CustomRangeInputs, ExportMenu, RANGE_PRESETS,
  useBrandCurrency, useBrandExport, useBrandRange, useFxRates,
} from "./brand-controls.jsx";

const REPORT_VERSION = "brand-view-account-scoped-v2";
const BRANDS_VERSION = "brand-view-brands-v1";

export default function BrandView({ accounts, accountsLoading, accountsError, loadReport, refreshReport }) {
  const [accountId, setAccountId] = useState("");
  const [brand, setBrand] = useState("");

  const [brands, setBrands] = useState([]);
  const [brandsLoading, setBrandsLoading] = useState(false);
  const [brandsError, setBrandsError] = useState(null);
  const [brandsMessage, setBrandsMessage] = useState(null);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [savedAt, setSavedAt] = useState(null);
  const [staleScope, setStaleScope] = useState(null);
  const [completeness, setCompleteness] = useState(null); // two-layer provisional/final D-1 (portfolio aggregate)
  // A rebuild is due (the account's brand-sales advanced past this assembly, or no snapshot exists yet). The
  // page shows the last-known-good and auto-converges by triggering the bounded zero-export rebuild.
  const [updating, setUpdating] = useState(false);
  const rebuildAttempts = useRef(0);

  const [tables, setTables] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const refreshGuard = useRef(false);

  const account = useMemo(
    () => accounts.find((entry) => String(entry.id) === String(accountId)) || null,
    [accounts, accountId]
  );
  // Report windows follow the selected marketplace's business day, exactly as
  // every other report in this workspace does.
  const asOf = useMemo(() => marketplaceToday(account?.country), [account]);

  const model = useMemo(() => (data ? brandViewModel(data) : null), [data]);
  // A single-account brand is usually one currency and opens in Original; one
  // that spans currencies opens converted so it reads as a single clean table.
  const { displayCurrency, setDisplayCurrency } = useBrandCurrency(model, `${accountId}::${brand}`);
  const { fx, fxError, reloadFx } = useFxRates(loadReport, displayCurrency);
  const range = useBrandRange({
    latestDate: model?.latestDate || null,
    coverageFrom: model?.coverage?.salesFrom || null,
  });

  /* --------------------------- scope changes --------------------------- */
  // Changing account must clear the brand AND every piece of report state, so a
  // previous account's numbers can never remain on screen next to a new account.
  const clearReport = useCallback(() => {
    setData(null);
    setError(null);
    setNotice(null);
    setSavedAt(null);
    setStaleScope(null);
    setUpdating(false);
    rebuildAttempts.current = 0;
    setTables(null);
    range.reset();
  }, [range]);

  const onAccountChange = useCallback((nextId) => {
    setAccountId(nextId);
    setBrand("");
    setBrands([]);
    setBrandsError(null);
    setBrandsMessage(null);
    clearReport();
  }, [clearReport]);

  const onBrandChange = useCallback((nextBrand) => {
    setBrand(nextBrand);
    clearReport();
  }, [clearReport]);

  /* ------------------------------- brands ------------------------------- */
  const brandParams = useMemo(
    () => (accountId ? { action: "brand-view-brands", reportVersion: BRANDS_VERSION, ids: accountId } : null),
    [accountId]
  );

  useEffect(() => {
    if (!brandParams) return undefined;
    let active = true;
    setBrandsLoading(true);
    setBrandsError(null);
    loadReport(brandParams)
      .then(({ body }) => {
        if (!active) return;
        setBrands(body.brands || []);
        setBrandsMessage(body.message || null);
      })
      .catch((loadError) => { if (active) setBrandsError(loadError.message); })
      .finally(() => { if (active) setBrandsLoading(false); });
    return () => { active = false; };
  }, [brandParams, loadReport]);

  /* ------------------------------- report ------------------------------- */
  const reportParams = useMemo(() => {
    if (!accountId || !brand || !asOf) return null;
    return { action: "brand-view", reportVersion: REPORT_VERSION, ids: accountId, brand, asOf };
  }, [accountId, brand, asOf]);

  const applyReport = useCallback((body, cachedAt) => {
    setUpdating(!!body.updating);
    if (body.snapshotMissing) {
      setData(null);
      setNotice(body.message);
      setSavedAt(null);
      setStaleScope(null);
      setCompleteness(null);
      return;
    }
    setData(body);
    setNotice(null);
    setSavedAt(body.snapshot?.savedAt ? new Date(body.snapshot.savedAt) : (cachedAt ? new Date(cachedAt) : null));
    setStaleScope(body.snapshot?.staleScope ? body.snapshot.savedForParams || {} : null);
    setCompleteness(body.completeness || null);
  }, []);

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

  // Auto-converge an `updating` single-account Brand View by POLLING the saved snapshot READ-ONLY (loadReport):
  // the regional scheduler now OWNS materialization, so opening or converging a page never triggers a server-side
  // rebuild, snapshot write, lock, or DataDoe activity. The account's brand-sales advanced past the assembly; the
  // scheduler republishes the fresh exact-identity snapshot, and this bounded read-only poll picks it up with no
  // user action. The LKG stays on screen meanwhile. The explicit Refresh button (onRefresh) remains the only path
  // that requests a rebuild, and only on a real click.
  useEffect(() => {
    if (!updating || !reportParams || refreshGuard.current) return undefined;
    if (rebuildAttempts.current >= 6) return undefined;
    let active = true;
    const delay = rebuildAttempts.current === 0 ? 400 : 3000;
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

  /* ------------------------------- refresh ------------------------------ */
  const onRefresh = useCallback(async () => {
    if (!accountId || refreshGuard.current) return;
    refreshGuard.current = true;
    setRefreshing(true);
    setError(null);
    try {
      // Rebuild the account's brand directory first: a brand added since the
      // last Account View refresh should appear before the report is rebuilt.
      const directory = await refreshReport({ action: "brand-view-brands", reportVersion: BRANDS_VERSION, ids: accountId });
      setBrands(directory.body.brands || []);
      setBrandsMessage(directory.body.message || null);

      if (brand && directory.body.brands?.includes(brand)) {
        const { body, cachedAt } = await refreshReport({ action: "brand-view", reportVersion: REPORT_VERSION, ids: accountId, brand, asOf });
        applyReport(body, cachedAt);
      } else if (brand) {
        setBrand("");
        setData(null);
        setError(`"${brand}" is no longer recorded in this account's saved data. Choose a brand from the refreshed list.`);
      }
      if (isConvertedMode(displayCurrency)) await reloadFx();
    } catch (refreshError) {
      setError(refreshError.message);
    } finally {
      refreshGuard.current = false;
      setRefreshing(false);
    }
  }, [accountId, applyReport, asOf, brand, displayCurrency, refreshReport, reloadFx]);

  /* ------------------------------- exports ------------------------------ */
  const converted = isConvertedMode(displayCurrency);
  const currencyLabel = converted ? `Converted to ${displayCurrency}` : "Original marketplace currency";

  const exportModel = useMemo(() => {
    if (!model || !tables) return null;
    return buildExportModel({
      tables,
      model,
      meta: {
        accountId: model.accountId,
        accountName: model.accountName || account?.name || model.accountId,
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
          "Upriver Brand View. Built from shared Supabase snapshots of this account's saved Dashboard, Ads and FBA reports.",
          converted
            ? `Money converted to ${displayCurrency}. ${fx?.attribution || ""}`
            : "Money is shown in each marketplace's original currency and is never summed across currencies.",
        ].join(" "),
      },
    });
  }, [account, converted, currencyLabel, displayCurrency, fx, model, range.rangeFrom, range.rangeTo, tables]);

  const { runExport, exportBusy, exportError } = useBrandExport(exportModel);

  /* ------------------------------- render ------------------------------- */
  const accountOptions = useMemo(
    () => accounts.map((entry) => ({
      value: String(entry.id),
      label: `${FLAGS[entry.country] || ""} ${entry.name} (${entry.currency || "—"})`.trim(),
    })),
    [accounts]
  );

  return (
    <div className="container bv-page op-report">
      <div className="page-head">
        <div>
          <div className="page-title">Brand View</div>
          <div className="page-sub">
            One account, one brand, every marketplace. Reads shared saved data only — Refresh rebuilds this account and
            brand from snapshots that already exist and never starts a new source export.
          </div>
        </div>
      </div>

      <div className="bv-controls" role="group" aria-label="Brand View scope">
        <BvSelect
          id="bv-account"
          label="Account"
          icon={<Store size={14} aria-hidden="true" />}
          value={accountId}
          onChange={onAccountChange}
          options={accountOptions}
          placeholder={accountsLoading ? "Loading accounts…" : accounts.length ? "Select an account" : "No accounts available"}
          disabled={!accounts.length}
        />
        <BvSelect
          id="bv-brand"
          label="Brand"
          icon={<Tag size={14} aria-hidden="true" />}
          value={brand}
          onChange={onBrandChange}
          options={brands.map((name) => ({ value: name, label: name }))}
          placeholder={brandsLoading ? "Loading brands…" : brands.length ? "Select a brand" : "No saved brands"}
          disabled={!accountId || brandsLoading || !brands.length}
          hint={!accountId ? "Select an account first" : undefined}
        />
        <BvSelect
          id="bv-range"
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
          id="bv-currency"
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
            disabled={!accountId || refreshing}
            title={accountId
              ? "Rebuild this account's brand list and this brand's report from the shared saved snapshots. No new source export is created."
              : "Select an account first"}
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
          {completeness && (
            <>
              <span className="plan-fresh-sep">·</span>
              <span style={{ padding: "0 8px", borderRadius: 10, fontSize: 11, fontWeight: 700,
                background: completeness.provisional ? "rgba(210,140,0,0.14)" : (completeness.sourceDefect ? "rgba(200,50,50,0.14)" : "rgba(30,150,80,0.14)"),
                color: completeness.provisional ? "#a86a00" : (completeness.sourceDefect ? "#b32424" : "#1a7f45") }}>
                {completeness.provisional ? "Provisional D-1" : (completeness.sourceDefect ? "Source issue" : "Final D-1")}
              </span>
              {completeness.provisional && <span>{completeness.itemizationPercent}% itemized · {completeness.pendingOrderCount} orders pending</span>}
            </>
          )}
        </div>
      )}

      {accountsError && <DataQualityAlert tone="warning" title="The account list could not be read" detail={accountsError} />}
      {brandsError && <DataQualityAlert tone="warning" title="Brands for this account could not be read" detail={brandsError} />}
      {staleScope && (
        <DataQualityAlert
          tone="info"
          title="Showing the most recent saved Brand View for this account and brand"
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
      {/* Two-layer PROVISIONAL/FINAL D-1: real itemized brand sales are shown, honestly labelled while some order
          shells are not yet itemized. Sales may increase automatically -- never a fabricated value. */}
      {completeness && completeness.provisional && (
        <DataQualityAlert tone="info" title={`Provisional D-1 — ${completeness.itemizationPercent}% of orders itemized`}
          detail={`${completeness.notice} (${completeness.accountsProvisional} account(s) still itemizing; ${completeness.pendingOrderCount} order(s), ${completeness.pendingUnitCount} unit(s) pending item-level prices.)`} />
      )}
      {completeness && completeness.sourceDefect && (
        <DataQualityAlert tone="error" title="Source-data issue for one or more accounts" detail={completeness.notice} />
      )}
      {completeness && completeness.unitBreakdown && <ObservedUnitsBreakdown completeness={completeness} />}

      {!accountId ? (
        <div className="panel">
          <EmptyState icon={<Store size={19} aria-hidden="true" />} title="Select an account">
            Brand View is scoped to one account at a time. Choose one of your permitted accounts and its brands will load
            from saved data. The brand list can only ever contain brands recorded for that account.
          </EmptyState>
        </div>
      ) : !brand ? (
        <div className="panel">
          <EmptyState
            icon={<Tag size={19} aria-hidden="true" />}
            title={brands.length ? "Select a brand" : "No saved brands for this account yet"}
            actions={brands.length ? null : (
              <button className="plan-export-btn" type="button" onClick={onRefresh} disabled={refreshing}>
                <RefreshCw size={14} className={refreshing ? "spin" : ""} aria-hidden="true" />
                Re-read saved data
              </button>
            )}
          >
            {brands.length
              ? `${brands.length} brand${brands.length === 1 ? "" : "s"} were found in this account's saved reports.`
              : brandsMessage || "This account has no saved report that records a brand yet."}
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
            icon={<Inbox size={19} aria-hidden="true" />}
            title="No saved Brand View for this account and brand yet"
            actions={(
              <button className="plan-export-btn" type="button" onClick={onRefresh} disabled={refreshing}>
                <RefreshCw size={14} className={refreshing ? "spin" : ""} aria-hidden="true" />
                Build from saved data
              </button>
            )}
          >
            {notice} This build reads only snapshots that already exist for this account, so it does not create a new
            source export.
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
            scopeLabel={model.accountName || model.accountId}
            onTables={setTables}
          />
          <div className="footer-note">
            Brand View is a shared Supabase snapshot for this account and brand. Sales come from the saved Dashboard
            snapshot (Order Line Items joined to Product Catalog) and FBA inventory from the saved FBA Shipment Plan snapshot.
            FBA cover is calculated from available FBA units and average daily unit sales in the selected report range. A blank cell means the source cannot
            answer, never zero.{converted ? ` Converted figures use server-side cached rates. ${fx?.attribution || ""}` : ""}
          </div>
        </>
      ) : null}
    </div>
  );
}
