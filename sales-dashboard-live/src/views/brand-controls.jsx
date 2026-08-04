/* =====================================================================
   Shared Brand View controls
   =====================================================================

   The control bar, the date-range resolution, the exchange-rate read and the
   export runner, shared by both Brand View pages so the two behave identically.
   Nothing here fetches report data — that stays in each page.                */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, FileSpreadsheet, FileText, Printer } from "lucide-react";

// RANGE_PRESETS and resolveRange are pure and live in src/lib/brand-view.js with
// the rest of the calculations, so Node can unit-test them. Re-exported here so
// the components have one import.
import { ORIGINAL_CURRENCY, RANGE_PRESETS, isConvertedMode, resolveRange } from "../lib/brand-view.js";

export { RANGE_PRESETS, resolveRange };

// The single currency a multi-currency brand is converted to by default, so the
// report opens as one clean "All Markets" table rather than per-currency bands.
// USD is the FX base, so no cross-rate is derived for it. Change this one line to
// make INR (or any other) the default reporting currency.
export const DEFAULT_REPORT_CURRENCY = "USD";

/* ------------------------------------------------------------- controls */

export function BvSelect({ id, label, icon, value, onChange, options, disabled, placeholder, hint }) {
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

export function CustomRangeInputs({ from, to, min, max, onFrom, onTo }) {
  return (
    <div className="bv-field bv-custom">
      <span className="bv-field-label"><span>Custom range</span></span>
      <span className="bv-custom-inputs">
        <input
          type="date" aria-label="Custom range start" value={from}
          min={min || undefined} max={max || undefined}
          onChange={(event) => onFrom(event.target.value)}
        />
        <input
          type="date" aria-label="Custom range end" value={to}
          min={min || undefined} max={max || undefined}
          onChange={(event) => onTo(event.target.value)}
        />
      </span>
    </div>
  );
}

export function ExportMenu({ disabled, busy, error, onExport }) {
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
        title={disabled ? "Load a brand report first" : "Export the three Brand View reports"}
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

/* ---------------------------------------------------------------- hooks */

/**
 * Read the server-side exchange-rate cache, once, and only when a conversion
 * currency is actually selected.
 *
 * The attempt is tracked in a ref rather than in state on purpose: reading a
 * loading flag in the dependency list would re-run the effect when it flips back
 * to false after a failure, which is an unbounded retry loop against the
 * endpoint. `reload` is the explicit retry, wired to each page's Refresh button.
 */
export function useFxRates(loadReport, displayCurrency) {
  const [fx, setFx] = useState(null);
  const [fxLoading, setFxLoading] = useState(false);
  const [fxError, setFxError] = useState(null);
  const requested = useRef(false);

  const load = useCallback(async () => {
    requested.current = true;
    setFxLoading(true);
    setFxError(null);
    try {
      const { body } = await loadReport({ action: "fx-rates" });
      setFx(body);
      setFxError(body.unavailable ? body.message : null);
      return body;
    } catch (error) {
      // A rate problem must never present itself as a report failure: the report
      // is fine and Original marketplace currency still works.
      setFxError(error.message);
      return null;
    } finally {
      setFxLoading(false);
    }
  }, [loadReport]);

  useEffect(() => {
    if (!isConvertedMode(displayCurrency) || requested.current) return;
    void load();
  }, [displayCurrency, load]);

  return { fx, fxLoading, fxError, reloadFx: load };
}

/**
 * The display-currency control with a data-driven default.
 *
 * WHY A DEFAULT THAT DEPENDS ON THE DATA
 *   The clean single-table layout — one "All Markets" total, no dividers — is
 *   only meaningful inside one currency. A brand that trades in a single currency
 *   already renders that way in Original mode, so it is left in its own currency.
 *   A brand that spans several currencies would otherwise open as stacked
 *   per-currency bands; converting it to one reporting currency makes it read as
 *   the same single clean table. Either way the report opens in the reference
 *   shape without the user touching the control.
 *
 *   The choice only holds until the user picks a currency themselves: once they
 *   do, `userChosen` latches and the data no longer overrides them. A new brand
 *   or scope (`resetKey`) forgets that choice so the next brand gets its own
 *   sensible default.
 *
 * @param {object|null} model     the brand view model (its `countries` carry the
 *                                marketplace currencies)
 * @param {string} resetKey       changes when the brand or scope changes
 */
export function useBrandCurrency(model, resetKey) {
  const [displayCurrency, setDisplayCurrencyState] = useState(ORIGINAL_CURRENCY);
  const userChosen = useRef(false);

  const currencyCount = useMemo(
    () => new Set((model?.countries || []).map((entry) => entry.currency).filter(Boolean)).size,
    [model]
  );

  // A new brand or scope forgets any manual currency choice.
  useEffect(() => { userChosen.current = false; }, [resetKey]);

  // Follow the data until the user overrides it.
  useEffect(() => {
    if (userChosen.current) return;
    setDisplayCurrencyState(currencyCount > 1 ? DEFAULT_REPORT_CURRENCY : ORIGINAL_CURRENCY);
  }, [currencyCount]);

  const setDisplayCurrency = useCallback((value) => {
    userChosen.current = true;
    setDisplayCurrencyState(value);
  }, []);

  return { displayCurrency, setDisplayCurrency };
}

/** Lazily load the export code and run one export. */
export function useBrandExport(exportModel) {
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState(null);

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
    } catch (failure) {
      setExportError(failure.message || "The export could not be created.");
    } finally {
      setExportBusy(false);
    }
  }, [exportModel]);

  return { runExport, exportBusy, exportError };
}

/** The date-range control plus its resolved window. */
export function useBrandRange({ latestDate, coverageFrom, initialPreset = "LATEST" }) {
  const [preset, setPreset] = useState(initialPreset);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  const [rangeFrom, rangeTo] = useMemo(
    () => resolveRange({ preset, latestDate, coverageFrom, customFrom, customTo }),
    [coverageFrom, customFrom, customTo, latestDate, preset]
  );

  const reset = useCallback(() => {
    setPreset(initialPreset);
    setCustomFrom("");
    setCustomTo("");
  }, [initialPreset]);

  return {
    preset, setPreset, customFrom, setCustomFrom, customTo, setCustomTo,
    rangeFrom, rangeTo, reset,
  };
}
