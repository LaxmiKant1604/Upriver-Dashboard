// Scheduler v2 -- server-only TYPED loader for the four PERSISTED Supabase Ads sources that PPC Performance
// derives from. It NEVER calls DataDoe and NEVER trusts browser input. The public accountId + the exact
// [asOf-29d, asOf] window are authoritative (recomputed here, never taken from a row); only the four allowed
// source_keys are accepted; every row must be a plain object carrying the AUTHORITATIVE public account_id,
// a real calendar metric_date INSIDE the window and finite numeric metrics; the 120,000-row cap REJECTS
// partial data (never a truncated window).
//
// Two integrity gates (from the PPC review):
//   1. Ads validity is proven from DURABLE successful `ads_sync_coverage` windows, NEVER from metric-row
//      min/max or `latest_metric_date` (a successfully-covered zero-activity day has no row). The two
//      DEFAULT datasets (campaign + ASIN, defaultDataset:true) must prove COMPLETE [asOf-29d, asOf] coverage
//      before Ads are validated; a gap / partial / stale / schema-missing / read-failed / unseeded required
//      source => typed UNAVAILABLE (plan nothing, spend zero tokens, write no snapshot, preserve LKG). A
//      fully-covered required source with ZERO rows stays a genuine VALIDATED EMPTY window. The OPTIONAL
//      targeting / search-terms sources contribute rows ONLY when THEY are fully covered; an unproven /
//      stale optional source is shown unavailable and its rows are NEVER folded as current.
//   2. Row-level account isolation: every row's public account_id must EXACTLY equal the authoritative
//      requested account; a missing / mismatched account_id fails closed BEFORE currency gating or folding.
//
// A validated EMPTY window (status "ok", adsRows []) stays DISTINCT from an unavailable read. The Supabase
// readers are INJECTED (getAdsDailySourceRows / getAdsSyncStates / getAdsSyncCoverage) so this module imports
// no transport and is deterministically testable offline; the pure validator is exported separately.

import { addDaysStr } from "../date-windows.js";
import { isValidCalendarDate } from "./report-source-contracts.js";
import { adsCurrencySignal, failedAdsCurrencySignal } from "./source-signals.js";
// The CLOSED allowlist of admin-safe coverage reason codes -- the SAME set the pure payload leaf uses to
// sanitize `coverageUnavailableReason`, so the injected-derive contract and the saved payload share ONE source
// of truth. derivation-core.js is an import-free pure leaf (no transport/storage), so this adds none.
import { PPC_COVERAGE_REASON_CODES } from "../reports/derivation-core.js";

// The persisted Ads source_keys PPC reads -- byte-identical to the ADS_* syncKeys the live builder uses. ASIN Ads
// is RETIRED from PPC (not loaded, aggregated, required or displayed); the durable ASIN history is retained for
// rollback but never read here. Campaign is the sole REQUIRED default dataset; targeting + search-terms are
// OPTIONAL independent sources that fold only when independently covered.
export const PPC_SOURCE_KEYS = Object.freeze([
  "campaign-performance-v1",
  "keyword-targeting-performance-v1",
  "search-terms-performance-v1",
]);
export const PPC_REQUIRED_SOURCE_KEYS = Object.freeze(["campaign-performance-v1"]);
export const PPC_OPTIONAL_SOURCE_KEYS = Object.freeze(["keyword-targeting-performance-v1", "search-terms-performance-v1"]);
export const PPC_ADS_WINDOW_DAYS = 30;
export const PPC_MAX_ADS_ROWS = 120000;
const PPC_SOURCE_KEY_SET = new Set(PPC_SOURCE_KEYS);
const PPC_REQUIRED_SOURCE_KEY_SET = new Set(PPC_REQUIRED_SOURCE_KEYS);
// Recognized safe coverage reason codes (the contract validator rejects anything else on an unproven entry).
const PPC_COVERAGE_REASON_SET = new Set(PPC_COVERAGE_REASON_CODES);

/**
 * PURE fail-closed validation of already-fetched persisted Ads rows against the authoritative window +
 * account. Returns { ok:true, rows } only when EVERY row is a plain object carrying an allowed source_key,
 * the AUTHORITATIVE public account_id, a real calendar metric_date inside [from, to], an object `metrics`
 * whose values are all finite, a string-or-null currency and an object-or-null `dimensions`. One malformed /
 * cross-source / cross-account / out-of-window / non-finite row => { ok:false, reason } (never a silently
 * filtered row). No I/O.
 */
export function validatePpcAdsRows({ rows, from, to, accountId }) {
  if (!Array.isArray(rows)) return { ok: false, reason: "ads-rows-not-array", rows: [] };
  if (!isValidCalendarDate(String(from || "")) || !isValidCalendarDate(String(to || ""))) {
    return { ok: false, reason: "ads-window-invalid", rows: [] };
  }
  // The authoritative requested account MUST be present -- row-level isolation cannot be proven without it.
  const account = accountId != null ? String(accountId) : "";
  if (!account) return { ok: false, reason: "ads-account-missing", rows: [] };
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return { ok: false, reason: "malformed-ads-row", rows: [] };
    // Row-level account isolation FIRST (before source/window/currency): a missing or other-account
    // account_id must fail closed so a mis-scoped/injected reader can never leak another account into PPC.
    if (row.account_id == null || String(row.account_id) === "") return { ok: false, reason: "ads-row-account-missing", rows: [] };
    if (String(row.account_id) !== account) return { ok: false, reason: "ads-row-account-mismatch", rows: [] };
    const sourceKey = String(row.source_key || "");
    if (!PPC_SOURCE_KEY_SET.has(sourceKey)) return { ok: false, reason: "ads-row-source-key-not-allowed", rows: [] };
    const date = row.metric_date;
    if (!isValidCalendarDate(date)) return { ok: false, reason: "ads-row-non-calendar-metric-date", rows: [] };
    if (date < from || date > to) return { ok: false, reason: "ads-row-out-of-window", rows: [] };
    if (row.metrics == null || typeof row.metrics !== "object" || Array.isArray(row.metrics)) return { ok: false, reason: "ads-row-metrics-not-object", rows: [] };
    for (const value of Object.values(row.metrics)) {
      if (value != null && !Number.isFinite(Number(value))) return { ok: false, reason: "ads-row-non-finite-metric", rows: [] };
    }
    if (row.currency != null && typeof row.currency !== "string") return { ok: false, reason: "ads-row-non-string-currency", rows: [] };
    if (row.dimensions != null && (typeof row.dimensions !== "object" || Array.isArray(row.dimensions))) return { ok: false, reason: "ads-row-dimensions-not-object", rows: [] };
  }
  return { ok: true, rows, reason: null };
}

/**
 * PURE: do the DURABLE successful coverage windows FULLY span [from, to] with no gap? Overlapping/adjacent
 * windows merge; the merged coverage must begin at/before `from` and reach `to` with no interior gap. This is
 * the SPAN check only -- structural window validation (real dates, from<=to, plain object) is enforced by
 * `evaluateSourceCoverage` BEFORE this runs, so a malformed window can no longer be papered over by a valid
 * sibling. Its defensive filter remains for standalone safety. Coverage is proven from these windows alone --
 * NEVER from metric-row min/max or latest_metric_date. No I/O.
 */
export function coverageProvesWindow(windows, from, to) {
  if (!isValidCalendarDate(from) || !isValidCalendarDate(to) || from > to) return false;
  const clamped = (Array.isArray(windows) ? windows : [])
    .filter((w) => w && isValidCalendarDate(w.from) && isValidCalendarDate(w.to) && w.from <= w.to && w.to >= from && w.from <= to)
    .map((w) => ({ from: w.from < from ? from : w.from, to: w.to > to ? to : w.to }))
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  if (!clamped.length || clamped[0].from > from) return false;
  let reach = clamped[0].to;
  for (let i = 1; i < clamped.length; i += 1) {
    if (clamped[i].from > addDaysStr(reach, 1)) return false; // interior gap => not fully covered
    if (clamped[i].to > reach) reach = clamped[i].to;
  }
  return reach >= to;
}

/**
 * PURE fail-closed: evaluate ONE source's durable coverage state ({ windows, read, ... } from
 * getAdsSyncCoverage) against [from, to]. Returns { proven:boolean, reason:string|null }. Hardened so absent /
 * malformed evidence can NEVER read as proven:
 *   - the state must be a plain object;
 *   - `read` must EXPLICITLY equal "ok" (a missing/unknown/schema-missing/read-failed read is NOT success);
 *   - `windows` must be a real array;
 *   - EVERY supplied window must be a plain object with real from<=to calendar dates -- ONE malformed window
 *     invalidates the whole evidence (a valid sibling window must NOT paper over it);
 *   - and the merged successful windows must fully span [from, to] (partial / gap / stale => not proven).
 * No I/O.
 */
export function evaluateSourceCoverage(coverageState, from, to) {
  if (!coverageState || typeof coverageState !== "object" || Array.isArray(coverageState)) {
    return { proven: false, reason: "coverage-state-malformed" };
  }
  const read = coverageState.read;
  if (read !== "ok") {
    return { proven: false, reason: read === "schema-missing" ? "coverage-schema-missing" : read === "read-failed" ? "coverage-read-failed" : "coverage-read-not-ok" };
  }
  const windows = coverageState.windows;
  if (!Array.isArray(windows)) return { proven: false, reason: "coverage-windows-not-array" };
  for (const w of windows) {
    if (!w || typeof w !== "object" || Array.isArray(w) || !isValidCalendarDate(w.from) || !isValidCalendarDate(w.to) || w.from > w.to) {
      return { proven: false, reason: "coverage-window-malformed" };
    }
  }
  if (!coverageProvesWindow(windows, from, to)) return { proven: false, reason: "coverage-incomplete" };
  return { proven: true, reason: null };
}

/**
 * PURE typed CONTRACT for the `sourceCoverage` a validated PPC Ads context MUST carry. Enforced in BOTH the
 * loader (on its own output) AND the derive adapter (on the injected `context.ppcAds`) so no wrong / future
 * loader wiring can slip an unproven empty snapshot -- OR an unsafe `reason` string -- past the durable-coverage
 * gate. Returns { ok, reason }. Requires EXACTLY the four known PPC source keys, each once (no missing /
 * duplicate / unknown key), booleans for required/proven/folded, the `required` flag matching the registry
 * (campaign + ASIN required, targeting + search optional), campaign + ASIN proven AND folded, every OPTIONAL
 * `folded` exactly equal to its `proven`, AND a consistent, admin-safe `reason`:
 *   - proven:true            => reason MUST be null (a proven source has no unavailable reason);
 *   - optional proven:false  => folded:false AND reason MUST be a recognized allowlisted safe code
 *                               (never a raw DB/HTTP/URL/credential/exception string).
 * A missing / malformed / contradictory / unknown reason fails closed. No I/O.
 */
export function validatePpcSourceCoverage(sourceCoverage) {
  if (!Array.isArray(sourceCoverage)) return { ok: false, reason: "source-coverage-not-array" };
  if (sourceCoverage.length !== PPC_SOURCE_KEYS.length) return { ok: false, reason: "source-coverage-wrong-count" };
  const seen = new Set();
  for (const entry of sourceCoverage) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { ok: false, reason: "source-coverage-entry-malformed" };
    const key = String(entry.sourceKey || "");
    if (!PPC_SOURCE_KEY_SET.has(key)) return { ok: false, reason: "source-coverage-unknown-key" };
    if (seen.has(key)) return { ok: false, reason: "source-coverage-duplicate-key" };
    seen.add(key);
    if (typeof entry.required !== "boolean" || typeof entry.proven !== "boolean" || typeof entry.folded !== "boolean") {
      return { ok: false, reason: "source-coverage-flags-not-boolean" };
    }
    const requiredExpected = PPC_REQUIRED_SOURCE_KEY_SET.has(key);
    if (entry.required !== requiredExpected) return { ok: false, reason: "source-coverage-required-flag-mismatch" };
    if (requiredExpected) {
      // campaign + ASIN are the DEFAULT datasets: a validated context MUST have proven AND folded them.
      if (entry.proven !== true || entry.folded !== true) return { ok: false, reason: "source-coverage-required-not-proven-folded" };
    } else if (entry.folded !== entry.proven) {
      // optional targeting / search: folded iff proven (an unproven optional must NOT be folded, and a proven
      // optional must be folded -- a contradiction means tampered/inconsistent evidence).
      return { ok: false, reason: "source-coverage-optional-folded-not-equal-proven" };
    }
    // Reason consistency (admin-safe typed-code guarantee): a proven source carries NO reason; an unproven
    // source (only optional reaches here -- an unproven required already failed above) MUST carry a recognized
    // allowlisted safe code, so a raw DB/HTTP/URL/credential/exception string is rejected, never persisted.
    if (entry.proven === true) {
      if (entry.reason !== null) return { ok: false, reason: "source-coverage-proven-reason-not-null" };
    } else if (typeof entry.reason !== "string" || !PPC_COVERAGE_REASON_SET.has(entry.reason)) {
      return { ok: false, reason: "source-coverage-unproven-reason-unsafe" };
    }
  }
  // length === four, no duplicates, no unknown keys, all drawn from the four-key set => all four are present.
  return { ok: true, reason: null };
}

// Read the durable coverage for one source, fail-closed. A THROWING/absent coverage reader is treated as a
// read failure (never silently "covered"). Returns { proven, reason }.
async function proveSourceCoverage(getAdsSyncCoverage, accountId, sourceKey, from, to) {
  if (typeof getAdsSyncCoverage !== "function") return { proven: false, reason: "coverage-reader-missing" };
  let coverageState;
  try {
    coverageState = await getAdsSyncCoverage(accountId, sourceKey);
  } catch (_e) {
    return { proven: false, reason: "coverage-read-failed" };
  }
  return evaluateSourceCoverage(coverageState, from, to);
}

/**
 * Load + validate the persisted Ads history for ONE account over [asOf-29d, asOf]. Returns a typed result:
 *   { status: "ok",          from, to, adsRows, syncStates, currencies, latestMetricDate, sourceCoverage }
 *   { status: "unavailable", reason, adsRows: [], syncStates, currencies: [], latestMetricDate: null, sourceCoverage }
 *
 * Availability is gated on DURABLE successful coverage windows (getAdsSyncCoverage), NOT on the returned
 * metric rows:
 *   - either DEFAULT dataset (campaign / ASIN) missing complete [from, to] coverage => UNAVAILABLE;
 *   - a read error (including the 120k row-cap throw) or ANY invalid/cross-account row => UNAVAILABLE;
 *   - both defaults fully covered => VALIDATED (adsRows may be empty -- a genuine validated-empty window);
 *   - an OPTIONAL source (targeting / search-terms) that is NOT fully covered has its rows DROPPED (never
 *     folded as current) and is reported unavailable in `sourceCoverage`; the report still derives from the
 *     validated defaults.
 * `getAdsDailySourceRows` / `getAdsSyncStates` / `getAdsSyncCoverage` are injected (no transport import here).
 */
export async function loadPersistedPpcAds({ accountId, asOf, getAdsDailySourceRows, getAdsSyncStates, getAdsSyncCoverage, maxRows = PPC_MAX_ADS_ROWS }) {
  const acct = accountId != null ? String(accountId) : null;
  const to = asOf != null ? String(asOf) : "";
  if (!acct || !isValidCalendarDate(to)) {
    return { status: "unavailable", reason: "missing-account-or-asof", adsRows: [], syncStates: [], currencies: [], latestMetricDate: null, sourceCoverage: [] };
  }
  const from = addDaysStr(to, -(PPC_ADS_WINDOW_DAYS - 1));
  let syncStates = [];
  let rows = null;
  try {
    const rawSync = (await getAdsSyncStates([acct])) || [];
    // Only THIS account's sync states for the allowed sources (no account/source leakage).
    syncStates = rawSync.filter((s) => s && String(s.account_id) === acct && PPC_SOURCE_KEY_SET.has(String(s.source_key)));
    rows = await getAdsDailySourceRows({ accountId: acct, sourceKeys: PPC_SOURCE_KEYS, from, to, maxRows });
  } catch (_e) {
    return { status: "unavailable", reason: "ads-read-failed", adsRows: [], syncStates, currencies: [], latestMetricDate: null, sourceCoverage: [] };
  }
  // Row integrity + account isolation FIRST: one bad/cross-account row invalidates the whole load.
  const validated = validatePpcAdsRows({ rows, from, to, accountId: acct });
  if (!validated.ok) {
    return { status: "unavailable", reason: validated.reason, adsRows: [], syncStates, currencies: [], latestMetricDate: null, sourceCoverage: [] };
  }

  // Prove each source's durable coverage (defaults first: any unproven default => whole context unavailable).
  const sourceCoverage = [];
  for (const sourceKey of PPC_SOURCE_KEYS) {
    const cov = await proveSourceCoverage(getAdsSyncCoverage, acct, sourceKey, from, to);
    const required = PPC_REQUIRED_SOURCE_KEY_SET.has(sourceKey);
    sourceCoverage.push({ sourceKey, required, proven: cov.proven, reason: cov.reason });
  }
  const unprovenRequired = sourceCoverage.find((c) => c.required && !c.proven);
  if (unprovenRequired) {
    return { status: "unavailable", reason: `required-source-${unprovenRequired.reason}`, adsRows: [], syncStates, currencies: [], latestMetricDate: null, sourceCoverage };
  }

  // Fold ONLY rows from proven sources. An unproven OPTIONAL source's rows are dropped (shown unavailable via
  // sourceCoverage) so stale/unproven data is NEVER presented as current. Mark each source's folded state.
  const provenKeys = new Set(sourceCoverage.filter((c) => c.proven).map((c) => c.sourceKey));
  const adsRows = validated.rows.filter((r) => provenKeys.has(String(r.source_key)));
  for (const c of sourceCoverage) c.folded = c.proven; // proven => its rows are folded; unproven => dropped

  // Self-check the coverage contract on the loader's OWN output before declaring the context validated -- the
  // SAME typed contract the derive adapter re-checks, so a construction drift here also fails closed.
  const contract = validatePpcSourceCoverage(sourceCoverage);
  if (!contract.ok) {
    return { status: "unavailable", reason: `coverage-contract-${contract.reason}`, adsRows: [], syncStates, currencies: [], latestMetricDate: null, sourceCoverage };
  }

  const currencies = [...new Set(adsRows.map((r) => String((r && r.currency) || "").trim()).filter(Boolean))].sort();
  const latestMetricDate = adsRows.reduce((latest, r) => (!latest || r.metric_date > latest ? r.metric_date : latest), null);
  return { status: "ok", from, to, adsRows, syncStates, currencies, latestMetricDate, sourceCoverage };
}

/**
 * The typed ads-currency signal the PPC cycle feeds to the ads-currency gate. A validated load yields
 * adsCurrencySignal(adsRows) (status "success", validated true, currencyCount N); an unavailable read yields
 * a fail-closed signal (never "success"), so the gate SKIPS total-sales and PPC spends zero DataDoe tokens.
 */
export function ppcAdsCurrencySignalOf(loaded) {
  return loaded && loaded.status === "ok" && Array.isArray(loaded.adsRows)
    ? adsCurrencySignal(loaded.adsRows)
    : failedAdsCurrencySignal();
}

/**
 * `loadDerivedContext` factory for the report worker: returns `{ ppcAds }` for reportKey "ppc-performance"
 * (from planned.context.to = asOf, planned.accountId = public id), read ONLY from the persisted Ads history.
 * Every other report gets `{}`.
 */
export function makePpcAdsContextLoader({ getAdsDailySourceRows, getAdsSyncStates, getAdsSyncCoverage, maxRows = PPC_MAX_ADS_ROWS }) {
  return async ({ reportKey, accountId, planned }) => {
    if (reportKey !== "ppc-performance") return {};
    const asOf = planned && planned.context ? planned.context.to : null;
    const ppcAds = await loadPersistedPpcAds({ accountId, asOf, getAdsDailySourceRows, getAdsSyncStates, getAdsSyncCoverage, maxRows });
    return { ppcAds };
  };
}
