/* =====================================================================
   BRAND VIEW — Account -> Brand -> Brand Reports
   =====================================================================

   A NEW page with its own route key (`brandview`). It does not touch the
   Account View dashboard, the older portfolio Brand View (`dashboard` +
   brand mode), their calculations, their cache keys or their API actions.

   THE FLOW
     1. The user picks one permitted Account. Nothing else is enabled first.
     2. Brands are loaded for THAT account only, from that account's saved
        Supabase snapshots. The dropdown is disabled until an account exists and
        can never contain a brand from another account.
     3. The user picks a brand and gets three country-wise reports.

   WHAT MAY CALL A SOURCE
     Nothing on this page starts a DataDoe export — not navigation, not an
     account or brand switch, not a date or currency change, not sorting, not an
     export. Reads go to the shared Supabase snapshot. The explicit Refresh
     button re-aggregates this account+brand from already-saved snapshots under a
     cross-user database lock and saves one shared result for everyone.

   MONEY
     Money is never converted unless the user selects a display currency. In
     Original marketplace currency mode each marketplace stays in its own
     currency and there is no cross-currency total — totals are grouped and
     labelled per currency. In a converted mode every country value is converted
     individually and the totals are the sums of those converted values, so the
     visible rows always add up to the visible total.                          */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, CalendarRange, Coins, Download, FileSpreadsheet, FileText,
  Inbox, Info, Printer, RefreshCw, Store, Tag,
} from "lucide-react";

import {
  DataQualityAlert, EmptyState, ErrorState, MetricCard, SkeletonMetricGrid, SkeletonTable,
} from "../components/ui.jsx";
import { FLAGS, fmtDateHuman, fmtMoney, fmtRangeLabel, monthKeyLabel, nInt } from "../lib/format.js";
import { marketplaceProfile, marketplaceToday } from "../../lib/marketplaces.js";
import {
  CURRENCY_OPTIONS, ORIGINAL_CURRENCY, addDays, brandViewModel, currencyGroups,
  dailySnapshotRows, inventoryCoverDays, isConvertedMode, monthStart, monthlySnapshotRows,
  sevenDayColumnTotals, sevenDayRows, shareOf, tacos, unconvertibleCurrencies,
} from "../lib/brand-view.js";

/* ============================== CONSTANTS ============================== */

const REPORT_VERSION = "brand-view-account-scoped-v1";
const BRANDS_VERSION = "brand-view-brands-v1";

const RANGE_PRESETS = [
  { value: "LATEST", label: "Latest reported day" },
  { value: "7D", label: "Last 7 days" },
  { value: "30D", label: "Last 30 days" },
  { value: "MTD", label: "Month to date" },
  { value: "LASTMONTH", label: "Last full month" },
  { value: "CUSTOM", label: "Custom range" },
];

// Ad spend is often a fraction of a currency unit, so it keeps two decimals
// while sales figures stay whole units. This mirrors the reference report.
const SALES_DECIMALS = 0;
const SPEND_DECIMALS = 2;

const DASH = "—";

/* ============================== FORMATTERS ============================== */

function countryLabel(code) {
  if (!code) return "Unknown marketplace";
  const profile = marketplaceProfile(code);
  if (profile.countryName && profile.countryName !== "Marketplace") return profile.countryName;
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) || code;
  } catch (error) {
    return code;
  }
}

function money(value, currency, decimals = SALES_DECIMALS, country) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return DASH;
  return fmtMoney(Number(value), currency, decimals, country);
}

function ratePct(value, decimals = 1) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return DASH;
  return `${(Number(value) * 100).toFixed(decimals)}%`;
}

function coverLabel(days) {
  if (days === null || days === undefined || !Number.isFinite(Number(days))) return DASH;
  return `${Math.round(Number(days)).toLocaleString("en-US")} d`;
}

function coverHint(days) {
  if (days === null || days === undefined || !Number.isFinite(Number(days))) return undefined;
  // 30.44 = mean days per calendar month, so the month equivalent is honest.
  return `${(Number(days) / 30.44).toFixed(1)} months of cover at the current month-to-date daily run rate`;
}

/** An export cell: `t` is the display text, `n` the raw number for Excel. */
function cell(text, number) {
  return number === null || number === undefined || !Number.isFinite(Number(number))
    ? { t: text }
    : { t: text, n: Number(number) };
}

/* ============================== CONTROLS ============================== */

function BvSelect({ id, label, icon, value, onChange, options, disabled, placeholder, hint }) {
  return (
    <div className={"bv-field" + (disabled ? " disabled" : "")}>
      <label className="bv-field-label" htmlFor={id}>
        {icon}
        <span>{label}</span>
      </label>
      <select
        id={id}
        className="bv-select"
        value={value}
        disabled={disabled}
        title={hint || undefined}
        onChange={(event) => onChange(event.target.value)}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((option) => (
          <option value={option.value} key={option.value}>{option.label}</option>
        ))}
      </select>
    </div>
  );
}

function ExportMenu({ disabled, busy, error, onExport }) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => { if (event.key === "Escape") setOpen(false); };
    const onPointerDown = (event) => {
      if (wrapper.current && !wrapper.current.contains(event.target)) setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const choose = (format) => { setOpen(false); onExport(format); };

  return (
    <div className="bv-export" ref={wrapper}>
      <button
        type="button"
        className="plan-export-btn"
        disabled={disabled || busy}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={disabled ? "Select an account and a brand first" : "Export the three Brand View reports"}
      >
        <Download size={14} className={busy ? "spin" : ""} aria-hidden="true" />
        Export
      </button>
      {open && (
        <div className="bv-menu" role="menu" aria-label="Export format">
          <button type="button" role="menuitem" onClick={() => choose("xlsx")}>
            <FileSpreadsheet size={14} aria-hidden="true" />
            <span><b>Excel (.xlsx)</b><small>One sheet per report</small></span>
          </button>
          <button type="button" role="menuitem" onClick={() => choose("csv")}>
            <FileText size={14} aria-hidden="true" />
            <span><b>CSV</b><small>All three reports, clearly separated</small></span>
          </button>
          <button type="button" role="menuitem" onClick={() => choose("pdf")}>
            <Printer size={14} aria-hidden="true" />
            <span><b>PDF</b><small>Opens a print view — save as PDF</small></span>
          </button>
        </div>
      )}
      {error && <div className="bv-export-error" role="alert">{error}</div>}
    </div>
  );
}

/* ============================== TABLE PIECES ============================== */

function ReportPanel({ title, subtitle, headers, rows, minWidth }) {
  return (
    <section className="panel bv-panel">
      <div className="panel-head">
        <div>
          <div className="panel-title">{title}</div>
          {subtitle && <div className="page-sub">{subtitle}</div>}
        </div>
      </div>
      <div className="bv-scroll">
        <table className="bv-table" style={minWidth ? { minWidth } : undefined}>
          <thead>
            <tr>
              {headers.map((header, index) => (
                <th key={header.key || index} className={index === 0 ? "bv-first" : "bv-num"} scope="col" title={header.hint || undefined}>
                  {header.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              if (row.kind === "section") {
                return (
                  <tr className="bv-section" key={row.key}>
                    <td colSpan={headers.length}>{row.cells[0].t}</td>
                  </tr>
                );
              }
              return (
                <tr className={row.kind === "total" ? "bv-total" : undefined} key={row.key}>
                  {row.cells.map((value, index) => (
                    <td
                      key={index}
                      className={index === 0 ? "bv-first" : "bv-num"}
                      title={row.hints?.[index] || undefined}
                    >
                      {index === 0 ? row.label || value.t : value.t}
                      {index === 0 && row.sublabel ? <small>{row.sublabel}</small> : null}
                      {index > 0 && row.subcells?.[index] ? <small>{row.subcells[index]}</small> : null}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ============================== THE PAGE ============================== */

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

  const [displayCurrency, setDisplayCurrency] = useState(ORIGINAL_CURRENCY);
  const [fx, setFx] = useState(null);
  const [fxLoading, setFxLoading] = useState(false);
  const [fxError, setFxError] = useState(null);

  const [rangePreset, setRangePreset] = useState("LATEST");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  const [refreshing, setRefreshing] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState(null);
  const refreshGuard = useRef(false);

  const account = useMemo(
    () => accounts.find((entry) => String(entry.id) === String(accountId)) || null,
    [accounts, accountId]
  );

  // Report windows follow the selected marketplace's business day, exactly as
  // every other report in this workspace does.
  const asOf = useMemo(() => marketplaceToday(account?.country), [account]);

  /* --------------------------- account -> brand reset --------------------------- */
  // Changing account must clear the brand AND every piece of report state, so a
  // previous account's numbers can never remain on screen next to a new account.
  const onAccountChange = useCallback((nextId) => {
    setAccountId(nextId);
    setBrand("");
    setBrands([]);
    setBrandsError(null);
    setBrandsMessage(null);
    setData(null);
    setError(null);
    setNotice(null);
    setSavedAt(null);
    setStaleScope(null);
    setRangePreset("LATEST");
    setCustomFrom("");
    setCustomTo("");
    setExportError(null);
  }, []);

  const onBrandChange = useCallback((nextBrand) => {
    setBrand(nextBrand);
    setData(null);
    setError(null);
    setNotice(null);
    setSavedAt(null);
    setStaleScope(null);
    setRangePreset("LATEST");
    setCustomFrom("");
    setCustomTo("");
    setExportError(null);
  }, []);

  /* ------------------------------- brand loading ------------------------------- */
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

  /* ------------------------------ report loading ------------------------------ */
  const reportParams = useMemo(() => {
    if (!accountId || !brand || !asOf) return null;
    return { action: "brand-view", reportVersion: REPORT_VERSION, ids: accountId, brand, asOf };
  }, [accountId, brand, asOf]);

  const applyReport = useCallback((body, cachedAt) => {
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

  /* --------------------------------- exchange rates ---------------------------- */
  // Requested only when a conversion currency is actually selected, and only as
  // a read of the server-side Supabase cache. The browser never calls the FX
  // provider, and Original marketplace currency mode needs no rates at all.
  // `fxRequested` is a ref, not state, on purpose. Reading `fxLoading` here
  // instead would re-run the effect when the flag flips back to false after a
  // failure, which is an unbounded retry loop against the rate endpoint. One
  // attempt per mount; the Refresh button is the explicit way to try again.
  const fxRequested = useRef(false);
  useEffect(() => {
    if (!isConvertedMode(displayCurrency) || fxRequested.current) return undefined;
    fxRequested.current = true;
    let active = true;
    setFxLoading(true);
    setFxError(null);
    loadReport({ action: "fx-rates" })
      .then(({ body }) => {
        if (!active) return;
        setFx(body);
        if (body.unavailable) setFxError(body.message);
      })
      .catch((loadError) => { if (active) setFxError(loadError.message); })
      .finally(() => { if (active) setFxLoading(false); });
    return () => { active = false; };
  }, [displayCurrency, loadReport]);

  /* ------------------------------------ refresh -------------------------------- */
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
      // Rates are refreshed at most once per provider cycle; the server decides
      // whether that means a provider call or the saved table. Refresh is also
      // the explicit retry after a failed first attempt.
      if (isConvertedMode(displayCurrency)) {
        fxRequested.current = true;
        try {
          const rates = await loadReport({ action: "fx-rates" });
          setFx(rates.body);
          setFxError(rates.body.unavailable ? rates.body.message : null);
        } catch (fxFailure) {
          // A rate problem must not present itself as a Brand View failure: the
          // report itself is fine and Original currency mode still works.
          setFxError(fxFailure.message);
        }
      }
    } catch (refreshError) {
      setError(refreshError.message);
    } finally {
      refreshGuard.current = false;
      setRefreshing(false);
    }
  }, [accountId, applyReport, asOf, brand, displayCurrency, loadReport, refreshReport]);

  /* =============================== CALCULATIONS =============================== */

  const model = useMemo(() => (data ? brandViewModel(data) : null), [data]);
  const latestDate = model?.latestDate || null;
  const coverageFrom = model?.coverage?.salesFrom || null;

  const [rangeFrom, rangeTo] = useMemo(() => {
    if (!latestDate) return ["", ""];
    let from;
    let to = latestDate;
    switch (rangePreset) {
      case "7D": from = addDays(latestDate, -6); break;
      case "30D": from = addDays(latestDate, -29); break;
      case "MTD": from = monthStart(latestDate); break;
      case "LASTMONTH": {
        const previous = monthStart(addDays(monthStart(latestDate), -1));
        from = previous;
        to = addDays(monthStart(latestDate), -1);
        break;
      }
      case "CUSTOM":
        from = customFrom || coverageFrom || latestDate;
        to = customTo || latestDate;
        break;
      default: from = latestDate;
    }
    if (coverageFrom && from < coverageFrom) from = coverageFrom;
    if (to > latestDate) to = latestDate;
    if (from > to) from = to;
    return [from, to];
  }, [coverageFrom, customFrom, customTo, latestDate, rangePreset]);

  const rates = fx?.rates || null;
  const converted = isConvertedMode(displayCurrency);
  const currencyLabel = converted
    ? `Converted to ${displayCurrency}`
    : "Original marketplace currency";

  const daily = useMemo(
    () => (model && rangeFrom && rangeTo ? dailySnapshotRows(model, { from: rangeFrom, to: rangeTo }) : null),
    [model, rangeFrom, rangeTo]
  );
  // The selected range's final day is the common report anchor. That keeps a
  // historical selection consistent across Daily, Monthly and 7-Day views.
  const reportAnchor = rangeTo || latestDate;
  const monthly = useMemo(() => (model ? monthlySnapshotRows(model, reportAnchor) : null), [model, reportAnchor]);
  const weekly = useMemo(() => (model ? sevenDayRows(model, reportAnchor) : null), [model, reportAnchor]);

  const reportCurrencies = useMemo(
    () => [...new Set((model?.countries || []).map((entry) => entry.currency).filter(Boolean))],
    [model]
  );
  const missingRates = useMemo(
    () => unconvertibleCurrencies(reportCurrencies, displayCurrency, rates),
    [displayCurrency, rates, reportCurrencies]
  );

  const dailyGroups = useMemo(
    () => (daily ? currencyGroups(daily.rows, displayCurrency, rates, ["sales", "lySales", "adSpend"]) : []),
    [daily, displayCurrency, rates]
  );
  const monthlyGroups = useMemo(() => {
    if (!monthly) return [];
    const monthFields = monthly.columns.completed.map((month) => `m_${month.key}`);
    const rows = monthly.rows.map((row) => {
      const flat = { ...row };
      monthly.columns.completed.forEach((month) => { flat[`m_${month.key}`] = row.byMonth[month.key] ?? null; });
      return flat;
    });
    return currencyGroups(rows, displayCurrency, rates, [...monthFields, "currentActual", "runRate", "adSpend"]);
  }, [displayCurrency, monthly, rates]);
  const weeklyGroups = useMemo(
    () => (weekly ? currencyGroups(weekly.rows, displayCurrency, rates, ["sales", "adSpend"]) : []),
    [displayCurrency, rates, weekly]
  );

  /* ============================== TABLE MODELS ============================== */

  const groupTitle = (group) => (group.converted
    ? `All Markets (${group.currency})`
    : `All Markets (${group.currency || "currency unavailable"})`);

  const dailyTable = useMemo(() => {
    if (!daily) return null;
    const headers = [
      { key: "country", label: "Country" },
      { key: "sales", label: converted ? `Sales (${displayCurrency})` : "Sales" },
      { key: "ly", label: converted ? `Last year sales (${displayCurrency})` : "Last year sales", hint: "Shown only when the saved snapshot fully covers the equivalent previous-year window." },
      { key: "spend", label: converted ? `Ad spend (${displayCurrency})` : "Ad spend", hint: "Same-ASIN advertising spend for this brand only. Blank means the saved Ads history cannot answer for this marketplace and window — not zero spend." },
      { key: "tacos", label: "TACoS", hint: "Brand ad spend divided by brand sales for the same marketplace and window." },
      { key: "fba", label: "FBA inventory", hint: "Available FBA units for this brand's ASINs from the latest saved FBA snapshot. Never converted." },
      { key: "cover", label: "Inv. cover (days)", hint: "Available FBA units divided by this brand's month-to-date daily unit run rate." },
      { key: "units", label: "Units" },
    ];
    // When the saved inventory source has no marketplace dimension its total is
    // real for the account but cannot be attributed to a country. It is shown on
    // the All Markets row only when the report has a single currency group, so
    // it is never silently assigned to one currency out of several.
    const accountScopedFba = daily.inventoryScope === "account" && dailyGroups.length === 1
      ? daily.inventoryAccountTotal
      : null;

    const rows = [];
    for (const group of dailyGroups) {
      const groupTacos = tacos(group.totals.adSpend, group.totals.sales);
      const groupFba = group.fbaAvailable === null ? accountScopedFba : group.fbaAvailable;
      const groupMtdUnits = group.rows.reduce((sum, row) => sum + (Number(row.mtdUnits) || 0), 0);
      const groupCover = daily.mtd ? inventoryCoverDays(groupFba, groupMtdUnits, daily.mtd.elapsedDays) : null;
      rows.push({
        key: `total-${group.key}`,
        kind: "total",
        label: "All Markets",
        sublabel: group.converted ? `${group.rows.length} marketplaces · ${displayCurrency}` : `${group.rows.length} marketplaces · ${group.currency || "currency unavailable"}`,
        hints: [undefined, undefined, undefined, undefined, undefined, undefined, coverHint(groupCover), undefined],
        cells: [
          cell("All Markets"),
          cell(money(group.totals.sales, group.currency, SALES_DECIMALS), group.totals.sales),
          cell(money(group.totals.lySales, group.currency, SALES_DECIMALS), group.totals.lySales),
          cell(money(group.totals.adSpend, group.currency, SPEND_DECIMALS), group.totals.adSpend),
          cell(ratePct(groupTacos), groupTacos === null ? null : groupTacos * 100),
          cell(groupFba === null ? DASH : nInt(groupFba), groupFba),
          cell(coverLabel(groupCover), groupCover === null ? null : Math.round(groupCover)),
          cell(nInt(group.units), group.units),
        ],
      });
      for (const row of group.rows) {
        const rowTacos = tacos(row.adSpend, row.sales);
        rows.push({
          key: `${group.key}-${row.country}`,
          kind: "row",
          label: `${FLAGS[row.country] || ""} ${countryLabel(row.country)}`.trim(),
          sublabel: [
            row.salesOnly ? "Inventory only (no sales in range)" : null,
            group.converted ? `from ${row.currency || "unknown currency"}` : row.currency,
            row.currencyConflict ? "multiple currencies reported" : null,
          ].filter(Boolean).join(" · "),
          hints: [undefined, undefined, undefined, undefined, undefined, undefined, coverHint(row.coverDays), undefined],
          cells: [
            cell(`${FLAGS[row.country] || ""} ${countryLabel(row.country)}`.trim()),
            cell(money(row.sales, row.displayCurrency, SALES_DECIMALS, converted ? undefined : row.country), row.sales),
            cell(money(row.lySales, row.displayCurrency, SALES_DECIMALS, converted ? undefined : row.country), row.lySales),
            cell(money(row.adSpend, row.displayCurrency, SPEND_DECIMALS, converted ? undefined : row.country), row.adSpend),
            cell(ratePct(rowTacos), rowTacos === null ? null : rowTacos * 100),
            cell(row.fbaAvailable === null ? DASH : nInt(row.fbaAvailable), row.fbaAvailable),
            cell(coverLabel(row.coverDays), row.coverDays === null ? null : Math.round(row.coverDays)),
            cell(nInt(row.units), row.units),
          ],
        });
      }
    }
    return { headers, rows };
  }, [converted, daily, dailyGroups, displayCurrency]);

  const monthlyTable = useMemo(() => {
    if (!monthly || !monthly.columns.current) return null;
    const current = monthly.columns.current;
    const headers = [
      { key: "country", label: "Country" },
      ...monthly.columns.completed.map((month) => ({ key: month.key, label: monthKeyLabel(month.key) })),
      { key: "actual", label: `${monthKeyLabel(current.key)} actual`, hint: `Month to date, ${current.from} to ${current.to}.` },
      { key: "runrate", label: `${monthKeyLabel(current.key)} run rate`, hint: `Actual / ${current.elapsedDays} elapsed days x ${current.daysInMonth} days in month.` },
      { key: "spend", label: "Ad spend (MTD)", hint: "Brand same-ASIN spend for the current month to date. Blank means unavailable, not zero." },
      { key: "tacos", label: "TACoS (MTD)" },
    ];
    const rows = [];
    for (const group of monthlyGroups) {
      const groupTacos = tacos(group.totals.adSpend, group.totals.currentActual);
      rows.push({
        key: `total-${group.key}`,
        kind: "total",
        label: "All Markets",
        sublabel: group.converted ? displayCurrency : (group.currency || "currency unavailable"),
        cells: [
          cell("All Markets"),
          ...monthly.columns.completed.map((month) => {
            const value = group.totals[`m_${month.key}`];
            return cell(money(value, group.currency, SALES_DECIMALS), value);
          }),
          cell(money(group.totals.currentActual, group.currency, SALES_DECIMALS), group.totals.currentActual),
          cell(money(group.totals.runRate, group.currency, SALES_DECIMALS), group.totals.runRate),
          cell(money(group.totals.adSpend, group.currency, SPEND_DECIMALS), group.totals.adSpend),
          cell(ratePct(groupTacos), groupTacos === null ? null : groupTacos * 100),
        ],
      });
      for (const row of group.rows) {
        const rowTacos = tacos(row.adSpend, row.currentActual);
        // Share of the total this row may legitimately be compared against: its
        // own currency group in original mode, the single converted total
        // otherwise. A share across currencies would be meaningless.
        const subcells = { };
        monthly.columns.completed.forEach((month, index) => {
          const share = shareOf(row[`m_${month.key}`], group.totals[`m_${month.key}`]);
          subcells[index + 1] = share === null ? null : `${(share * 100).toFixed(1)}%`;
        });
        const actualShare = shareOf(row.currentActual, group.totals.currentActual);
        subcells[monthly.columns.completed.length + 1] = actualShare === null ? null : `${(actualShare * 100).toFixed(1)}%`;
        rows.push({
          key: `${group.key}-${row.country}`,
          kind: "row",
          label: `${FLAGS[row.country] || ""} ${countryLabel(row.country)}`.trim(),
          sublabel: group.converted ? `from ${row.currency || "unknown currency"}` : row.currency,
          subcells,
          cells: [
            cell(`${FLAGS[row.country] || ""} ${countryLabel(row.country)}`.trim()),
            ...monthly.columns.completed.map((month) => {
              const value = row[`m_${month.key}`];
              return cell(money(value, row.displayCurrency, SALES_DECIMALS, converted ? undefined : row.country), value);
            }),
            cell(money(row.currentActual, row.displayCurrency, SALES_DECIMALS, converted ? undefined : row.country), row.currentActual),
            cell(money(row.runRate, row.displayCurrency, SALES_DECIMALS, converted ? undefined : row.country), row.runRate),
            cell(money(row.adSpend, row.displayCurrency, SPEND_DECIMALS, converted ? undefined : row.country), row.adSpend),
            cell(ratePct(rowTacos), rowTacos === null ? null : rowTacos * 100),
          ],
        });
      }
    }
    return { headers, rows };
  }, [converted, displayCurrency, monthly, monthlyGroups]);

  const weeklyTable = useMemo(() => {
    if (!weekly || !weekly.dates.length) return null;
    const dates = weekly.dates;
    const headers = [
      { key: "metric", label: "Metric" },
      ...dates.map((date, index) => ({
        key: date,
        label: index === dates.length - 1 ? `${fmtDateHuman(date).replace(/, \d{4}$/, "")} (latest)` : fmtDateHuman(date).replace(/, \d{4}$/, ""),
      })),
      { key: "total", label: "7-day total" },
    ];
    const rows = [];

    for (const group of weeklyGroups) {
      const totals = sevenDayColumnTotals(group, dates, displayCurrency, rates);
      const label = group.converted ? displayCurrency : (group.currency || "currency unavailable");
      const weekSales = group.totals.sales;
      const weekSpend = group.totals.adSpend;

      rows.push({
        key: `sales-${group.key}`, kind: "total", label: "Daily sales", sublabel: label,
        cells: [
          cell("Daily sales"),
          ...dates.map((date) => cell(money(totals[date].sales, group.currency, SALES_DECIMALS), totals[date].sales)),
          cell(money(weekSales, group.currency, SALES_DECIMALS), weekSales),
        ],
      });
      rows.push({
        key: `units-${group.key}`, kind: "row", label: "Units", sublabel: label,
        cells: [
          cell("Units"),
          ...dates.map((date) => cell(nInt(totals[date].units), totals[date].units)),
          cell(nInt(group.units), group.units),
        ],
      });
      rows.push({
        key: `spend-${group.key}`, kind: "row", label: "Ad spend", sublabel: label,
        cells: [
          cell("Ad spend"),
          ...dates.map((date) => cell(money(totals[date].adSpend, group.currency, SPEND_DECIMALS), totals[date].adSpend)),
          cell(money(weekSpend, group.currency, SPEND_DECIMALS), weekSpend),
        ],
      });
      const weekTacos = tacos(weekSpend, weekSales);
      rows.push({
        key: `tacos-${group.key}`, kind: "row", label: "TACoS", sublabel: label,
        cells: [
          cell("TACoS"),
          ...dates.map((date) => {
            const value = totals[date].tacos;
            return cell(ratePct(value), value === null ? null : value * 100);
          }),
          cell(ratePct(weekTacos), weekTacos === null ? null : weekTacos * 100),
        ],
      });
    }

    rows.push({ key: "units-section", kind: "section", cells: [cell("Units by country")] });
    for (const row of weekly.rows) {
      rows.push({
        key: `country-${row.country}`,
        kind: "row",
        label: `${FLAGS[row.country] || ""} ${countryLabel(row.country)}`.trim(),
        sublabel: row.currency,
        cells: [
          cell(`${FLAGS[row.country] || ""} ${countryLabel(row.country)}`.trim()),
          ...dates.map((date) => {
            const units = row.byDate[date]?.units || 0;
            return cell(units ? nInt(units) : DASH, units || null);
          }),
          cell(nInt(row.units), row.units),
        ],
      });
    }

    return { headers, rows };
  }, [displayCurrency, rates, weekly, weeklyGroups]);

  /* ============================== EXPORT MODEL ============================== */

  const fxLine = useMemo(() => {
    if (!converted) return "Not applicable — every marketplace is shown in its own currency.";
    if (!fx || fx.unavailable) return "Unavailable";
    const stamp = fx.providerUpdatedAt || fx.fetchedAt;
    return [
      `FX updated ${stamp ? new Date(stamp).toUTCString() : "unknown"}`,
      fx.fallback ? "cached fallback in use — the provider was unreachable" : null,
      fx.stale ? "older than one provider update cycle" : null,
      `base ${fx.base}`,
    ].filter(Boolean).join(" · ");
  }, [converted, fx]);

  const freshnessLine = useMemo(() => {
    if (!model) return DASH;
    const coverage = model.coverage || {};
    return [
      coverage.salesSavedAt ? `Sales snapshot saved ${new Date(coverage.salesSavedAt).toLocaleString()}` : null,
      coverage.salesFrom && coverage.salesTo ? `sales coverage ${coverage.salesFrom} to ${coverage.salesTo}` : null,
      coverage.adsFrom ? `ads coverage ${coverage.adsFrom} to ${coverage.adsTo}` : "ads coverage unavailable",
      coverage.inventoryDate ? `FBA inventory as of ${coverage.inventoryDate}` : "FBA inventory unavailable",
    ].filter(Boolean).join(" · ");
  }, [model]);

  const exportModel = useMemo(() => {
    if (!model || !dailyTable || !monthlyTable || !weeklyTable) return null;
    const toReport = (id, title, subtitle, sheetName, table) => ({
      id,
      title,
      subtitle,
      sheetName,
      headers: table.headers.map((header) => header.label),
      rows: table.rows.map((row) => ({
        kind: row.kind,
        cells: row.cells.map((value, index) => {
          if (index !== 0) {
            const sub = row.subcells?.[index];
            return sub ? { ...value, t: `${value.t} (${sub})` } : value;
          }
          return { t: [row.label || value.t, row.sublabel].filter(Boolean).join(" — ") };
        }),
      })),
    });
    return {
      meta: {
        accountId: model.accountId,
        accountName: model.accountName || account?.name || model.accountId,
        brand: model.brand,
        rangeLabel: rangeFrom && rangeTo ? fmtRangeLabel(rangeFrom, rangeTo) : DASH,
        asOf: reportAnchor || model.asOf,
        currencyLabel,
        currencyCode: converted ? displayCurrency : "original",
        fxLine,
        fxAttribution: converted ? (fx?.attribution || null) : null,
        freshnessLine,
        generatedAt: new Date().toISOString(),
        limitations: model.notes,
        footer: [
          "Upriver Brand View. Built from shared Supabase snapshots of this account's saved Dashboard, Ads and FBA reports.",
          converted ? `Money converted to ${displayCurrency}. ${fx?.attribution || ""}` : "Money is shown in each marketplace's original currency and is never summed across currencies.",
        ].join(" "),
      },
      reports: [
        toReport("daily", `Daily Snapshot — ${model.brand}`, `${rangeFrom && rangeTo ? fmtRangeLabel(rangeFrom, rangeTo) : ""} · ${currencyLabel}`, "Daily Snapshot", dailyTable),
        toReport("monthly", `Monthly Snapshot — ${model.brand}`, `Five completed months plus the selected month and its run rate · ${currencyLabel}`, "Monthly Snapshot", monthlyTable),
        toReport("weekly", `7-Day Performance — ${model.brand}`, `Seven days ending ${reportAnchor || ""} · ${currencyLabel}`, "7-Day Performance", weeklyTable),
      ],
    };
  }, [account, converted, currencyLabel, dailyTable, displayCurrency, freshnessLine, fx, fxLine, model, monthlyTable, rangeFrom, rangeTo, reportAnchor, weeklyTable]);

  const runExport = useCallback(async (format) => {
    if (!exportModel) return;
    setExportBusy(true);
    setExportError(null);
    try {
      // Lazily imported so the .xlsx writer is not in the initial bundle.
      const exporters = await import("../lib/brand-view-export.js");
      if (format === "csv") exporters.downloadBrandViewCsv(exportModel);
      else if (format === "xlsx") exporters.downloadBrandViewXlsx(exportModel);
      else if (format === "pdf" && !exporters.printBrandViewPdf(exportModel)) {
        setExportError("The PDF view could not open. Allow pop-ups for this site, then export again.");
      }
    } catch (exportFailure) {
      setExportError(exportFailure.message || "The export could not be created.");
    } finally {
      setExportBusy(false);
    }
  }, [exportModel]);

  /* ================================= RENDER ================================= */

  const accountOptions = useMemo(
    () => accounts.map((entry) => ({
      value: String(entry.id),
      label: `${FLAGS[entry.country] || ""} ${entry.name} (${entry.currency || "—"})`.trim(),
    })),
    [accounts]
  );

  const totalUnits = dailyGroups.reduce((sum, group) => sum + group.units, 0);
  const marketplaceCount = daily?.rows.length || 0;

  return (
    <div className="container bv-page">
      <div className="page-head">
        <div>
          <div className="page-title">Brand View</div>
          <div className="page-sub">
            One account, one brand, every marketplace. Reads shared saved data only — the Refresh button rebuilds this
            account and brand from snapshots that already exist and never starts a new source export.
          </div>
        </div>
      </div>

      {/* ---------------------------- control bar ---------------------------- */}
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
          value={rangePreset}
          onChange={setRangePreset}
          options={RANGE_PRESETS}
          disabled={!model}
          hint="Applies to all three reports. Monthly and 7-Day tables end on the selected range's final date."
        />
        {rangePreset === "CUSTOM" && (
          <div className="bv-field bv-custom">
            <span className="bv-field-label"><CalendarRange size={14} aria-hidden="true" /><span>Custom</span></span>
            <span className="bv-custom-inputs">
              <input
                type="date" aria-label="Custom range start" value={customFrom || coverageFrom || ""}
                min={coverageFrom || undefined} max={latestDate || undefined}
                onChange={(event) => setCustomFrom(event.target.value)}
              />
              <input
                type="date" aria-label="Custom range end" value={customTo || latestDate || ""}
                min={coverageFrom || undefined} max={latestDate || undefined}
                onChange={(event) => setCustomTo(event.target.value)}
              />
            </span>
          </div>
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

      {/* ------------------------------ freshness ------------------------------ */}
      {model && (
        <div className="recon-freshness bv-freshness">
          <span className="live-dot" style={{ position: "relative", top: 1 }} aria-hidden="true" />
          <span>{savedAt ? `Shared snapshot saved ${savedAt.toLocaleString()}` : "Shared snapshot"}</span>
          <span className="plan-fresh-sep">·</span>
          <span>{freshnessLine}</span>
          {converted && <><span className="plan-fresh-sep">·</span><span>{fxLine}</span></>}
        </div>
      )}

      {/* -------------------------------- alerts -------------------------------- */}
      {accountsError && <DataQualityAlert tone="warning" title="The account list could not be read" detail={accountsError} />}
      {brandsError && <DataQualityAlert tone="warning" title="Brands for this account could not be read" detail={brandsError} />}
      {staleScope && (
        <DataQualityAlert
          tone="info"
          title="Showing the most recent saved Brand View for this account and brand"
          detail={`It was saved for ${staleScope.asOf || "an earlier date"}. Click Refresh to rebuild it from the newest saved account snapshots.`}
        />
      )}
      {converted && fxError && (
        <DataQualityAlert tone="error" title="Currency conversion is unavailable" detail={fxError} icon={AlertTriangle} />
      )}
      {converted && fx?.fallback && (
        <DataQualityAlert
          tone="warning"
          title="Using cached exchange rates"
          detail={fx.message || "The exchange-rate provider was unreachable, so the last rates saved in Supabase are being used."}
        />
      )}
      {converted && !fxError && missingRates.length > 0 && (
        <DataQualityAlert
          tone="warning"
          title={`No exchange rate for ${missingRates.join(", ")}`}
          detail={`Those marketplaces cannot be converted to ${displayCurrency} and are shown as unavailable rather than with a substituted rate. Switch to Original marketplace currency to see their real figures.`}
        />
      )}
      {model?.notes?.map((note) => (
        <DataQualityAlert key={note} tone="info" title="Partial source coverage" detail={note} icon={Info} />
      ))}

      {/* -------------------------------- body -------------------------------- */}
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
          <div className="metric-grid bv-kpis">
            <MetricCard label="Brand" value={model.brand} period={model.accountName || model.accountId} />
            <MetricCard
              label="Marketplaces"
              value={nInt(marketplaceCount)}
              period={rangeFrom && rangeTo ? fmtRangeLabel(rangeFrom, rangeTo) : ""}
              hint="Only marketplaces where this brand has sales or FBA inventory in the selected scope."
            />
            <MetricCard label="Units sold" value={nInt(totalUnits)} period="never currency converted" />
            <MetricCard
              label="Currency mode"
              value={converted ? displayCurrency : "Original"}
              period={converted ? "totals are sums of converted rows" : "grouped per currency, never combined"}
              hint={converted
                ? "Every country value is converted individually at full precision; the totals are the sums of those converted values."
                : "Money stays in each marketplace's own currency. There is deliberately no single cross-currency total."}
            />
          </div>

          {dailyTable && (
            <ReportPanel
              title={`Daily Snapshot — ${model.brand}`}
              subtitle={`${rangeFrom && rangeTo ? fmtRangeLabel(rangeFrom, rangeTo) : ""} · ${currencyLabel}${daily?.lastYearWindow ? ` · last year compares ${fmtRangeLabel(daily.lastYearWindow.from, daily.lastYearWindow.to)}` : " · last year unavailable for this window"}`}
              headers={dailyTable.headers}
              rows={dailyTable.rows}
              minWidth={880}
            />
          )}
          {monthlyTable && (
            <ReportPanel
              title={`Monthly Snapshot — ${model.brand}`}
              subtitle={`Five completed calendar months, the selected month to date and its run rate · ${currencyLabel} · share of the group total shown under each value`}
              headers={monthlyTable.headers}
              rows={monthlyTable.rows}
              minWidth={1020}
            />
          )}
          {weeklyTable && (
            <ReportPanel
              title={`7-Day Performance — ${model.brand}`}
              subtitle={`Seven days ending ${reportAnchor ? fmtDateHuman(reportAnchor) : ""} · ${currencyLabel} · units are never converted`}
              headers={weeklyTable.headers}
              rows={weeklyTable.rows}
              minWidth={980}
            />
          )}

          <div className="footer-note">
            Brand View is a shared Supabase snapshot for this account and brand. Sales come from the saved Dashboard
            snapshot (Order Line Items joined to Product Catalog), ad spend from saved same-ASIN Amazon Ads rows for this
            brand only, and FBA inventory from the saved FBA Shipment Plan snapshot. A blank cell means the source cannot
            answer, never zero.{converted ? ` Converted figures use server-side cached rates. ${fx?.attribution || ""}` : ""}
          </div>
        </>
      ) : null}
    </div>
  );
}
