// Scheduler v2 -- server-only TYPED loader for the four PERSISTED Supabase Ads sources that PPC Performance
// derives from. It NEVER calls DataDoe and NEVER trusts browser input. The public accountId + the exact
// [asOf-29d, asOf] window are authoritative (recomputed here, never taken from a row); only the four allowed
// source_keys are accepted; every row must be a plain object with a real calendar metric_date INSIDE the
// window and finite numeric metrics; the 120,000-row cap REJECTS partial data (never a truncated window).
// A validated EMPTY window (status "ok", adsRows []) stays DISTINCT from an unavailable read. The Supabase
// readers are INJECTED (getAdsDailySourceRows / getAdsSyncStates) so this module imports no transport and is
// deterministically testable offline; the pure validator is exported separately.

import { addDaysStr } from "../date-windows.js";
import { isValidCalendarDate } from "./report-source-contracts.js";
import { adsCurrencySignal } from "./source-signals.js";

// The four persisted Ads source_keys PPC reads -- byte-identical to the ADS_* syncKeys the live builder uses.
export const PPC_SOURCE_KEYS = Object.freeze([
  "campaign-performance-v1",
  "asin-performance-v1",
  "keyword-targeting-performance-v1",
  "search-terms-performance-v1",
]);
export const PPC_ADS_WINDOW_DAYS = 30;
export const PPC_MAX_ADS_ROWS = 120000;
const PPC_SOURCE_KEY_SET = new Set(PPC_SOURCE_KEYS);

/**
 * PURE fail-closed validation of already-fetched persisted Ads rows against the authoritative window. Returns
 * { ok:true, rows } only when EVERY row is a plain object carrying an allowed source_key, a real calendar
 * metric_date inside [from, to], an object `metrics` whose values are all finite, a string-or-null currency
 * and an object-or-null `dimensions`. One malformed / cross-source / out-of-window / non-finite row =>
 * { ok:false, reason } (never a silently-filtered row). No I/O.
 */
export function validatePpcAdsRows({ rows, from, to }) {
  if (!Array.isArray(rows)) return { ok: false, reason: "ads-rows-not-array", rows: [] };
  if (!isValidCalendarDate(String(from || "")) || !isValidCalendarDate(String(to || ""))) {
    return { ok: false, reason: "ads-window-invalid", rows: [] };
  }
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return { ok: false, reason: "malformed-ads-row", rows: [] };
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
 * Load + validate the persisted Ads history for ONE account over [asOf-29d, asOf]. Returns a typed result:
 *   { status: "ok",          from, to, adsRows, syncStates, currencies, latestMetricDate }  -- validated (may be empty)
 *   { status: "unavailable", reason, adsRows: [], syncStates, currencies: [], latestMetricDate: null }
 * A read error (including the 120k row-cap throw) or ANY invalid row => "unavailable" (never a partial/empty
 * success). `getAdsDailySourceRows` / `getAdsSyncStates` are injected (no transport import here).
 */
export async function loadPersistedPpcAds({ accountId, asOf, getAdsDailySourceRows, getAdsSyncStates, maxRows = PPC_MAX_ADS_ROWS }) {
  const acct = accountId != null ? String(accountId) : null;
  const to = asOf != null ? String(asOf) : "";
  if (!acct || !isValidCalendarDate(to)) {
    return { status: "unavailable", reason: "missing-account-or-asof", adsRows: [], syncStates: [], currencies: [], latestMetricDate: null };
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
    return { status: "unavailable", reason: "ads-read-failed", adsRows: [], syncStates, currencies: [], latestMetricDate: null };
  }
  const validated = validatePpcAdsRows({ rows, from, to });
  if (!validated.ok) {
    return { status: "unavailable", reason: validated.reason, adsRows: [], syncStates, currencies: [], latestMetricDate: null };
  }
  const currencies = [...new Set(validated.rows.map((r) => String((r && r.currency) || "").trim()).filter(Boolean))].sort();
  const latestMetricDate = validated.rows.reduce((latest, r) => (!latest || r.metric_date > latest ? r.metric_date : latest), null);
  return { status: "ok", from, to, adsRows: validated.rows, syncStates, currencies, latestMetricDate };
}

/**
 * The typed ads-currency signal the PPC cycle feeds to the ads-currency gate. A validated load yields
 * adsCurrencySignal(adsRows) (status "success", validated true, currencyCount N); an unavailable read yields
 * a fail-closed signal (never "success"), so the gate SKIPS total-sales and PPC spends zero DataDoe tokens.
 */
export function ppcAdsCurrencySignalOf(loaded) {
  return loaded && loaded.status === "ok" && Array.isArray(loaded.adsRows)
    ? adsCurrencySignal(loaded.adsRows)
    : { status: "failed", validated: false, currencyCount: null };
}

/**
 * `loadDerivedContext` factory for the report worker: returns `{ ppcAds }` for reportKey "ppc-performance"
 * (from planned.context.to = asOf, planned.accountId = public id), read ONLY from the persisted Ads history.
 * Every other report gets `{}`.
 */
export function makePpcAdsContextLoader({ getAdsDailySourceRows, getAdsSyncStates, maxRows = PPC_MAX_ADS_ROWS }) {
  return async ({ reportKey, accountId, planned }) => {
    if (reportKey !== "ppc-performance") return {};
    const asOf = planned && planned.context ? planned.context.to : null;
    const ppcAds = await loadPersistedPpcAds({ accountId, asOf, getAdsDailySourceRows, getAdsSyncStates, maxRows });
    return { ppcAds };
  };
}
