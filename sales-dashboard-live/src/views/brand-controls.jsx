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
import { RANGE_PRESETS, isConvertedMode, resolveRange } from "../lib/brand-view.js";

export { RANGE_PRESETS, resolveRange };

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
