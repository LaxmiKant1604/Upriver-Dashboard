// Returns (FBA & FBM) EVENT source -- the PURE core (no I/O). Shared by the regional runner (returns-event-runner.js),
// the operator CLI (scripts/release/scheduled-returns-refresh.mjs), the schedule switch and the tests, so the scheduled
// and operator paths cannot drift. Implements DESIGN-v2 sections 2, 3.3, 3.7, 3.8 and CONTRACT sections A-C:
//   * ONE durable row per SOURCE row (public.source_returns_events, migration 20260942). NOTHING in this module drops,
//     merges or de-duplicates a row: value-identical rows get occurrence 1..n (owner decision OD2 -- no dedupe by LPN,
//     RMA or anything else until the identity is validated on real FBA + FBM rows).
//   * Windows (OD1): initial = [D1-59, D1] (60 days incl.), rolling = [D1-13, D1] (RETURNS_ROLLING_DAYS = 14). There is
//     NO catch-up mode and NO automatic paid backfill: a hole in the saved coverage older than the rolling window is only
//     COUNTED (coverageGapDays -> typed RETURNS_COVERAGE_GAP + day count), never fetched. FRESHNESS LIMITATION: rows
//     older than 14 days keep the status / FBM refund / disposition they had when last fetched.
//   * accountD1 = min(region as-of, marketplace-local today - 1): an account is never asked for its current local day.
//   * Mode, fail closed: unreadable state or coverage -> pending (excluded); owner hold -> held (ZERO creates, reported
//     every run); last 'replaced' -> reverify (zero-token confirm RPC first, then decide again); no state / initial
//     'pending' / initial 'loaded' with nothing left to confirm -> initial; complete + current -> skipped-current;
//     complete otherwise -> rolling.
//   * Page shape: the request asks all 24 columns, but a page row must carry ONLY the 12 not-null spec columns as own
//     properties (RETURNS_SHAPE_SOURCE for validateSplitWindowPage); an absent nullable column normalizes as null.
//   * Identity (OD2, DESIGN 3.7): physicalKey = FBA (order id, sku, LPN) / FBM (order id, sku, Amazon RMA id) when that
//     id is non-blank, else unkeyed. A window is AMBIGUOUS when (a) one physicalKey is on 2+ rows (any date/channel),
//     (b) rows are equal on every non-COGS column but differ in COGS (join fan-out signature), or (c) 2+ unkeyed rows
//     share an event_key. An ambiguous account is STILL persisted with every row; the RPC holds it (not complete).
//   * Output contract (public repo): what this module hands to logs / RESULT / status rows / RPC detail is ONLY counts,
//     typed codes, dates and 8-char prefixes (maskId). physicalKey is a sha256 digest, never the raw order/sku/LPN/RMA;
//     validation failures carry codes + counts, never a row value.
// Imports are zero-I/O leaves only (lib/marketplaces.js, date-windows.js, reports/sources.js, node:crypto) -- never
// datadoe.js / supabase.js / ads-sync.js (scripts/returns-event-source.test.js pins the import closure).

import { createHash } from "node:crypto";
import { marketplaceToday } from "../../marketplaces.js";
import { addDaysStr } from "../date-windows.js";
import { RETURNS } from "../reports/sources.js";

// ================================================ A. shared constants ================================================
export const RETURNS_EVENT_SOURCE_KEY = "returns"; // source_controls / source_coverage / source_run_status key
export const RETURNS_SOURCE_ID = RETURNS.id;
// The 23 owner-requested fields, in REQUEST order (every one verified on the live public spec, 35 columns, 2026-10-04).
export const RETURNS_OWNER_FIELDS = Object.freeze([
  "seller_or_vendor_id", "marketplace_country_code", "date", "order_date", "sku", "child_asin",
  "fnsku", "amazon_order_id", "quantity", "amazon_return_reason", "amazon_fulfillment_channel",
  "amazon_return_request_status", "amazon_return_detailed_disposition", "amazon_return_rmaid",
  "amazon_return_seller_rmaid", "amazon_return_label_to_be_paid_by", "amazon_return_refunded_amount",
  "amazon_return_label_cost", "cogs_item_value", "cogs_shipping_value", "cogs_total_value", "cogs_currency", "cogs_present",
]);
// + the license plate number as the 24th requested field (OD2): stored server-side only, never served.
export const RETURNS_EVENT_COLUMNS = Object.freeze([...RETURNS_OWNER_FIELDS, "amazon_license_plate_number"]);
export const RETURNS_TOKENS_PER_CREATE = 2;
export const RETURNS_EXPORT_ROW_LIMIT = 50000;
export const RETURNS_MAX_SELLERS = 5;
export const RETURNS_INITIAL_DAYS = 60;
export const RETURNS_ROLLING_DAYS = 14;
export const RETURNS_ATTRIBUTION = "as-delivered";
export const RETURNS_ATTRIBUTIONS = Object.freeze(["as-delivered", "exclude-other-owner"]);
export const RETURNS_COMPATIBLE_SOURCE_NAME = "returns (fba & fbm)";
// Fed to ads-sync buildAdsExportRequestBody / createExport / validateSplitWindowPage. NO aggregations -> the request is
// RAW (no groupBy): DataDoe returns one row per returned item and never collapses identical rows.
export const RETURNS_PSEUDO_SOURCE = Object.freeze({
  key: "returns-events", sourceId: RETURNS_SOURCE_ID, dimensions: RETURNS_EVENT_COLUMNS,
  metrics: Object.freeze([]), keyFields: Object.freeze([]),
});
// The 12 NOT-NULL columns of the live public spec (request order). A page row must carry each as an OWN property (a
// provider shape change fails closed); the other 12 requested columns are nullable and may be omitted from a row (absent
// -> null in normalization). RETURNS_SHAPE_SOURCE is the shape-check-only pseudo source handed to ads-sync
// validateSplitWindowPage -- never to a create (the REQUEST keeps RETURNS_PSEUDO_SOURCE and all 24 columns).
export const RETURNS_REQUIRED_COLUMNS = Object.freeze([
  "seller_or_vendor_id", "marketplace_country_code", "date", "sku", "child_asin", "amazon_order_id", "quantity",
  "amazon_return_reason", "amazon_fulfillment_channel", "amazon_return_request_status", "cogs_present", "amazon_license_plate_number",
]);
export const RETURNS_SHAPE_SOURCE = Object.freeze({
  key: "returns-events-shape", sourceId: RETURNS_SOURCE_ID, dimensions: RETURNS_REQUIRED_COLUMNS,
  metrics: Object.freeze([]), keyFields: Object.freeze([]),
});
export const RETURNS_REGIONS = Object.freeze(["india", "europe-au", "us-ca"]);
// The per-account outcomes a run reports (DESIGN 3.9).
export const RETURNS_ACCOUNT_OUTCOMES = Object.freeze([
  "initial-loaded", "daily-refreshed", "skipped-current", "held", "incomplete", "failed", "pending", "incompatible",
]);
// Row-level failure codes (normalizeReturnsRow + validateAccountRows) and per-row anomaly codes (counted, never fatal).
// RETURNS_FRAGMENT_UNKNOWN / RETURNS_TEXT_INVALID are additions to the CONTRACT C list (fragment metadata missing or
// malformed; a text value that is not a scalar, holds NUL, or exceeds the RPC's 512 / order-id 64 limits).
export const RETURNS_ROW_FAILURE_CODES = Object.freeze([
  "RETURNS_ROW_NOT_OBJECT", "RETURNS_FRAGMENT_UNKNOWN", "RETURNS_DATE_INVALID", "RETURNS_CHANNEL_INVALID",
  "RETURNS_ORDER_ID_MISSING", "RETURNS_QUANTITY_INVALID", "RETURNS_NUMERIC_INVALID", "RETURNS_CURRENCY_INVALID",
  "RETURNS_COGS_PRESENT_INVALID", "RETURNS_TEXT_INVALID", "RETURNS_SELLER_MISMATCH", "RETURNS_MARKETPLACE_MISMATCH",
  "RETURNS_ROW_OUTSIDE_WINDOW",
]);
// COGS_CURRENCY_MIXED is per ACCOUNT window (1 when its valid rows carry 2+ distinct non-null cogs_currency values).
export const RETURNS_ANOMALY_CODES = Object.freeze(["QUANTITY_NULL", "QUANTITY_ZERO", "FBA_ONLY_ON_FBM", "FBM_ONLY_ON_FBA", "LPN_BLANK", "COGS_CURRENCY_MIXED"]);

// Source column -> event field (keys of one p_events element == source_returns_events columns) + value kind. The kinds:
// text = trimmed, '' kept (not-null default-'' columns); text? = trimmed, '' -> null (nullable columns); date / date? =
// YYYY-MM-DD calendar date; decimal? = canonical decimal string | null; currency? = ^[A-Z]{3}$ | null.
const COLUMN_SPECS = Object.freeze([
  { column: "seller_or_vendor_id", field: "seller_or_vendor_id", kind: "text" },
  { column: "marketplace_country_code", field: "marketplace_country_code", kind: "marketplace" },
  { column: "date", field: "return_date", kind: "date" },
  { column: "order_date", field: "order_date", kind: "date?" },
  { column: "sku", field: "sku", kind: "text" },
  { column: "child_asin", field: "child_asin", kind: "text" },
  { column: "fnsku", field: "fnsku", kind: "text?" },
  { column: "amazon_order_id", field: "amazon_order_id", kind: "order" },
  { column: "quantity", field: "quantity", kind: "quantity" },
  { column: "amazon_return_reason", field: "amazon_return_reason", kind: "text" },
  { column: "amazon_fulfillment_channel", field: "fulfillment_channel", kind: "channel" },
  { column: "amazon_return_request_status", field: "request_status", kind: "text" },
  { column: "amazon_return_detailed_disposition", field: "detailed_disposition", kind: "text?" },
  { column: "amazon_return_rmaid", field: "rma_id", kind: "text?" },
  { column: "amazon_return_seller_rmaid", field: "seller_rma_id", kind: "text?" },
  { column: "amazon_return_label_to_be_paid_by", field: "label_paid_by", kind: "text?" },
  { column: "amazon_return_refunded_amount", field: "refunded_amount", kind: "decimal?" },
  { column: "amazon_return_label_cost", field: "label_cost", kind: "decimal?" },
  { column: "cogs_item_value", field: "cogs_item_value", kind: "decimal?" },
  { column: "cogs_shipping_value", field: "cogs_shipping_value", kind: "decimal?" },
  { column: "cogs_total_value", field: "cogs_total_value", kind: "decimal?" },
  { column: "cogs_currency", field: "cogs_currency", kind: "currency?" },
  { column: "cogs_present", field: "cogs_present", kind: "boolean" },
  { column: "amazon_license_plate_number", field: "license_plate_number", kind: "text?" },
]);
if (COLUMN_SPECS.map((c) => c.column).join(",") !== RETURNS_EVENT_COLUMNS.join(",")) {
  throw new Error("returns-event-source: the column map drifted from RETURNS_EVENT_COLUMNS (fix both together).");
}
if (RETURNS_REQUIRED_COLUMNS.join(",") !== RETURNS_EVENT_COLUMNS.filter((c) => RETURNS_REQUIRED_COLUMNS.includes(c)).join(",")) {
  throw new Error("returns-event-source: RETURNS_REQUIRED_COLUMNS must be requested columns, in request order.");
}
const REQUIRED_SET = new Set(RETURNS_REQUIRED_COLUMNS);
// The keys the runner sends per event (order_owner is NOT sent: the replace RPC computes it from saved OLI orders).
export const RETURNS_EVENT_FIELDS = Object.freeze([...COLUMN_SPECS.map((c) => c.field), "event_key", "occurrence", "source_request_hash", "export_id"]);
// Channel-only fields per the live public spec ("Available only for FBA/FBM returns"). Present on the other channel ->
// an anomaly COUNT (reported, never a failure). The LPN column carries no channel note (spec: TEXT not null), so it is
// not listed; an FBA row with a blank LPN is counted as LPN_BLANK instead (it cannot be physically keyed).
export const RETURNS_FBA_ONLY_FIELDS = Object.freeze(["fnsku", "detailed_disposition"]);
export const RETURNS_FBM_ONLY_FIELDS = Object.freeze(["order_date", "rma_id", "seller_rma_id", "refunded_amount", "label_cost"]);
const COGS_FIELDS = new Set(["cogs_item_value", "cogs_shipping_value", "cogs_total_value", "cogs_currency", "cogs_present"]);
const COGS_INDEX = new Set(COLUMN_SPECS.map((c, i) => (COGS_FIELDS.has(c.field) ? i : -1)).filter((i) => i >= 0));

// Persistence bounds MIRRORED from the replace RPC's per-event checks (migration 20260942) so JS rejects everything the
// RPC would: an out-of-bounds value fails ITS account early with a typed code instead of raising inside the RPC.
const MAX_WINDOW_DAYS = 62; // (to-from)+1 bound; a wider window could never be persisted
const MAX_TEXT = 512; // per-text-field bound
const MAX_ORDER_ID = 64;
const MAX_EXPORT_ID = 128;
const MAX_QUANTITY = 999999999; // quantity ~ '^[0-9]{1,9}$'
const DECIMAL_FITS = /^-?[0-9]{1,24}(\.[0-9]{1,30})?$/; // money / COGS: <= 24 integer + <= 30 fraction digits
const HEX64 = /^[0-9a-f]{64}$/;
const CODE_RE = /^[A-Z0-9_]{1,64}$/;
const S = (v) => (v == null ? "" : String(v));
const sha256Hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");

// ================================================ dates ================================================
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
// A real calendar date "YYYY-MM-DD" in 1900..2099 (the RPC's order_date bound; rejects 2026-02-30 and timestamps).
function isYmd(v) {
  if (typeof v !== "string") return false;
  const m = YMD.exec(v);
  if (!m) return false;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  if (y < 1900 || y > 2099 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}
function assertYmd(v, name) {
  if (!isYmd(v)) throw new TypeError("returns-event-source: " + name + " must be a YYYY-MM-DD date (fail closed).");
}
const dayNumber = (s) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10))) / 86400000;
const daySpan = (from, to) => dayNumber(to) - dayNumber(from) + 1; // inclusive
function toDate(now) {
  const t = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(t.getTime())) throw new TypeError("returns-event-source: now must be a valid Date / timestamp (fail closed).");
  return t;
}

// Days of [from, to] covered by the UNION of `windows` ({from, to} inclusive, overlapping / touching / unsorted all
// fine). A malformed window proves nothing (fail closed: it can only make coverage look SMALLER, never larger).
function coveredDayCount(windows, from, to) {
  const clipped = [];
  for (const w of Array.isArray(windows) ? windows : []) {
    if (!w || !isYmd(w.from) || !isYmd(w.to) || w.from > w.to) continue;
    const f = w.from < from ? from : w.from;
    const t = w.to > to ? to : w.to;
    if (f <= t) clipped.push([f, t]);
  }
  clipped.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  let covered = 0; let curF = null; let curT = null;
  for (const [f, t] of clipped) {
    if (curT !== null && f <= addDaysStr(curT, 1)) { if (t > curT) curT = t; continue; }
    if (curT !== null) covered += daySpan(curF, curT);
    curF = f; curT = t;
  }
  if (curT !== null) covered += daySpan(curF, curT);
  return covered;
}
const provesWindow = (windows, from, to) => coveredDayCount(windows, from, to) === daySpan(from, to);

// ================================================ windows + D-1 (DESIGN 2) ================================================
/** PURE: the initial (60-day) and rolling (14-day) windows ending at the account's D-1. */
export function returnsWindows(d1) {
  assertYmd(d1, "d1");
  return {
    initial: { from: addDaysStr(d1, -(RETURNS_INITIAL_DAYS - 1)), to: d1, days: RETURNS_INITIAL_DAYS },
    rolling: { from: addDaysStr(d1, -(RETURNS_ROLLING_DAYS - 1)), to: d1, days: RETURNS_ROLLING_DAYS },
  };
}

/**
 * PURE: the account's D-1 = min(regionAsOf, marketplace-local today - 1) (lib/marketplaces.js marketplaceToday; UK is
 * the same business day as GB). The scheduler's regionAsOf is the UTC D-1; a marketplace still on the previous local
 * day (Americas just after UTC midnight) gets its own, earlier D-1 so its current local day is never requested.
 * An unknown marketplace code falls back to UTC (marketplaceProfile), which equals regionAsOf at every scheduled time.
 */
export function accountD1({ regionAsOf, marketplace, now = new Date() } = {}) {
  assertYmd(regionAsOf, "regionAsOf");
  const localD1 = addDaysStr(marketplaceToday(normalizeMarketplace(marketplace), toDate(now)), -1);
  return localD1 < regionAsOf ? localD1 : regionAsOf;
}

/**
 * PURE: an operator PAID run's explicit --as-of must lie in [todayUTC-3, todayUTC-1] (else the CLI STOPS).
 * -> { ok:true } | { ok:false, code:'RETURNS_ASOF_OUT_OF_RANGE', reason:'malformed'|'too-old'|'too-recent', from, to }.
 */
export function validateOperatorAsOf(asOf, now = new Date()) {
  const today = toDate(now).toISOString().slice(0, 10);
  const from = addDaysStr(today, -3); const to = addDaysStr(today, -1);
  if (!isYmd(asOf)) return { ok: false, code: "RETURNS_ASOF_OUT_OF_RANGE", reason: "malformed", from, to };
  if (asOf < from) return { ok: false, code: "RETURNS_ASOF_OUT_OF_RANGE", reason: "too-old", from, to };
  if (asOf > to) return { ok: false, code: "RETURNS_ASOF_OUT_OF_RANGE", reason: "too-recent", from, to };
  return { ok: true };
}

/** PURE: days in [d1-59, d1-14] NOT proven by the account's 'returns' coverage windows (reported, never fetched). */
export function coverageGapDays({ windows, d1 } = {}) {
  assertYmd(d1, "d1");
  const from = addDaysStr(d1, -(RETURNS_INITIAL_DAYS - 1));
  const to = addDaysStr(d1, -RETURNS_ROLLING_DAYS);
  return daySpan(from, to) - coveredDayCount(windows, from, to);
}

// ================================================ mode decision (DESIGN 2) ================================================
const INITIAL_STATUSES = new Set(["pending", "loaded", "complete"]);
const LAST_STATUSES = new Set(["replaced", "succeeded", "failed"]);

/**
 * PURE, fail closed: what this run may do for ONE account.
 *   d1       = accountD1(...) for the account.
 *   state    = its source_returns_account_state row (snake_case) | null / undefined (no row) | the FAILED states read
 *              itself ({ read:'error'|'missing' } -- any object carrying `read` is a read result, never a row).
 *   coverage = getSourceCoverageWindows(...) result: only read === 'ok' with a windows array is readable.
 * -> { kind, window, reason, gapDays }, kind in
 *   'pending'         unreadable / invalid state or coverage: excluded, zero creates, reported (reason = typed code);
 *   'held'            hold_reason set (identity ambiguous / owner hold): excluded, ZERO creates, reported every run
 *                     until the owner clears it (reason = the hold code);
 *   'reverify'        last 'replaced' (a committed replace awaiting its confirm): the runner calls the zero-token confirm
 *                     RPC for the RECORDED window (returned here) + recorded hashes/counts, re-reads the state and decides
 *                     again (a second 'reverify' in the same run is the runner's to treat as pending -- never a create);
 *   'initial'         no state / initial 'pending' / initial 'loaded' whose last attempt is NOT 'replaced' (nothing left
 *                     for a confirm to settle -- it would only answer 'superseded' -- so the load is redone instead of
 *                     sticking as pending forever): window = [D1-59, D1];
 *   'skipped-current' complete AND coverage proves [D1-13, D1] AND last 'succeeded' AND last_window_to >= D1: zero creates;
 *   'rolling'         complete otherwise: window = [D1-13, D1] -- NEVER wider (no catch-up).
 * gapDays = coverageGapDays for a complete account (any kind), else 0. A gap is REPORTED only.
 */
export function decideAccountMode({ d1, state, coverage } = {}) {
  assertYmd(d1, "d1");
  const w = returnsWindows(d1);
  const out = (kind, window = null, reason = null, gapDays = 0) => ({ kind, window, reason, gapDays });
  const hasRow = state !== null && state !== undefined;
  if (hasRow && (typeof state !== "object" || Array.isArray(state) || Object.prototype.hasOwnProperty.call(state, "read"))) {
    return out("pending", null, "RETURNS_STATE_UNREADABLE");
  }
  if (!coverage || typeof coverage !== "object" || coverage.read !== "ok" || !Array.isArray(coverage.windows)) {
    return out("pending", null, "RETURNS_COVERAGE_UNREADABLE");
  }
  if (!hasRow) return out("initial", { from: w.initial.from, to: w.initial.to });
  const initialStatus = state.initial_status;
  const lastStatus = state.last_status == null ? null : state.last_status;
  const hold = state.hold_reason == null ? "" : S(state.hold_reason).trim();
  if (!INITIAL_STATUSES.has(initialStatus) || (lastStatus !== null && !LAST_STATUSES.has(lastStatus))) {
    return out("pending", null, "RETURNS_STATE_INVALID");
  }
  const gapDays = initialStatus === "complete" ? coverageGapDays({ windows: coverage.windows, d1 }) : 0;
  if (hold) return out("held", null, CODE_RE.test(hold) ? hold : "RETURNS_HOLD", gapDays);
  if (lastStatus === "replaced") {
    const from = state.last_window_from; const to = state.last_window_to;
    if (!isYmd(from) || !isYmd(to) || from > to) return out("pending", null, "RETURNS_STATE_INVALID", gapDays);
    return out("reverify", { from, to }, "RETURNS_REVERIFY", gapDays);
  }
  if (initialStatus === "pending" || initialStatus === "loaded") return out("initial", { from: w.initial.from, to: w.initial.to });
  // complete
  const lastTo = state.last_window_to;
  if (lastStatus === "succeeded" && isYmd(lastTo) && lastTo >= d1 && provesWindow(coverage.windows, w.rolling.from, d1)) {
    return out("skipped-current", null, null, gapDays);
  }
  return out("rolling", { from: w.rolling.from, to: w.rolling.to }, null, gapDays);
}

// ================================================ normalization (DESIGN 3.8, CONTRACT B) ================================================
/** PURE: ISO-2 marketplace code, trimmed + upper-cased, UK -> GB (every durable source stores GB). Not validated here. */
export function normalizeMarketplace(code) {
  const c = (typeof code === "string" ? code : S(code)).trim().toUpperCase();
  return c === "UK" ? "GB" : c;
}

/**
 * PURE: the canonical decimal string of a finite number / numeric string: no exponent, no leading zeros, no trailing
 * fraction zeros, no '+', and every zero (incl. "-0") -> "0" (e.g. 12.50 -> "12.5", "1.5E-3" -> "0.0015").
 * null / undefined / blank -> null; anything else (NaN, Infinity, boolean, object, "1,234", "0x10") -> undefined.
 * Exact string arithmetic -- a numeric string is never routed through a float.
 */
export function canonicalDecimal(v) {
  if (v === null || v === undefined) return null;
  let s;
  if (typeof v === "number") { if (!Number.isFinite(v)) return undefined; s = String(v); }
  else if (typeof v === "bigint") s = v.toString();
  else if (typeof v === "string") { s = v.trim(); if (s === "") return null; }
  else return undefined;
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!m) return undefined;
  const sign = m[1]; const intPart = m[2]; const fracPart = m[3] || "";
  if (intPart === "" && fracPart === "") return undefined;
  const exp = m[4] === undefined ? 0 : Number(m[4]);
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > 1000) return undefined;
  let digits = intPart + fracPart;
  let point = intPart.length + exp;
  if (point < 0) { digits = "0".repeat(-point) + digits; point = 0; }
  if (point > digits.length) digits += "0".repeat(point - digits.length);
  const ip = digits.slice(0, point).replace(/^0+/, "") || "0";
  const fp = digits.slice(point).replace(/0+$/, "");
  const body = fp ? ip + "." + fp : ip;
  if (body === "0") return "0";
  return sign === "-" ? "-" + body : body;
}

// Scalar -> trimmed text ("" for null/undefined); undefined for a non-scalar (boolean / object / array / NaN).
function textOf(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : undefined;
  if (typeof v === "bigint") return v.toString();
  return undefined;
}
// jsonb rejects NUL and lone surrogates; the RPC bounds every text field.
const textOk = (t, max = MAX_TEXT) => t.length <= max && t.indexOf("\u0000") < 0 && (typeof t.isWellFormed !== "function" || t.isWellFormed());
const FAIL = (code) => ({ code });
const KIND = {
  text: (v) => { const t = textOf(v); return t === undefined || !textOk(t) ? FAIL("RETURNS_TEXT_INVALID") : { value: t }; },
  "text?": (v) => { const t = textOf(v); return t === undefined || !textOk(t) ? FAIL("RETURNS_TEXT_INVALID") : { value: t === "" ? null : t }; },
  marketplace: (v) => { const t = textOf(v); return t === undefined || !textOk(t) ? FAIL("RETURNS_TEXT_INVALID") : { value: normalizeMarketplace(t) }; },
  order: (v) => {
    const t = textOf(v); // the RPC bounds an order id to 64 chars
    if (t === undefined || !textOk(t, MAX_ORDER_ID)) return FAIL("RETURNS_TEXT_INVALID");
    return t === "" ? FAIL("RETURNS_ORDER_ID_MISSING") : { value: t };
  },
  date: (v) => { const t = typeof v === "string" ? v.trim() : null; return t !== null && isYmd(t) ? { value: t } : FAIL("RETURNS_DATE_INVALID"); },
  "date?": (v) => {
    if (v === null || v === undefined) return { value: null };
    const t = typeof v === "string" ? v.trim() : null;
    if (t === "") return { value: null };
    return t !== null && isYmd(t) ? { value: t } : FAIL("RETURNS_DATE_INVALID");
  },
  channel: (v) => { const t = textOf(v); return t === "FBA" || t === "FBM" ? { value: t } : FAIL("RETURNS_CHANNEL_INVALID"); },
  quantity: (v) => {
    const c = canonicalDecimal(v);
    if (c === null) return { value: null, anomaly: "QUANTITY_NULL" };
    if (c === undefined || c.startsWith("-") || c.includes(".")) return FAIL("RETURNS_QUANTITY_INVALID");
    const n = Number(c);
    if (!Number.isSafeInteger(n) || n > MAX_QUANTITY) return FAIL("RETURNS_QUANTITY_INVALID");
    return n === 0 ? { value: 0, anomaly: "QUANTITY_ZERO" } : { value: n };
  },
  // Exact, never rounded: a computed COGS float artifact (e.g. 3 x 1.1 = 3.3000000000000003, 16 fraction digits) IS
  // persistable exactly; only > 30 fraction digits or > 24 integer digits is refused (the replace RPC bound).
  "decimal?": (v) => { const c = canonicalDecimal(v); return c === undefined || (c !== null && !DECIMAL_FITS.test(c)) ? FAIL("RETURNS_NUMERIC_INVALID") : { value: c }; },
  "currency?": (v) => {
    if (v === null || v === undefined) return { value: null };
    if (typeof v !== "string") return FAIL("RETURNS_CURRENCY_INVALID");
    const t = v.trim().toUpperCase();
    if (t === "") return { value: null };
    return /^[A-Z]{3}$/.test(t) ? { value: t } : FAIL("RETURNS_CURRENCY_INVALID");
  },
  boolean: (v) => {
    if (v === true || v === false) return { value: v };
    if (v === 1 || v === 0) return { value: v === 1 };
    if (typeof v === "string") {
      const t = v.trim().toLowerCase();
      if (t === "true" || t === "1") return { value: true };
      if (t === "false" || t === "0") return { value: false };
    }
    return FAIL("RETURNS_COGS_PRESENT_INVALID");
  },
};

/**
 * PURE: one raw DataDoe Returns row -> one canonical event (CONTRACT B) for the fragment that produced it.
 *   meta = { sourceRequestHash (64-hex, returnsRequestHash of the fragment's body), exportId (text|null) }.
 * -> { ok:true, event, anomalies:[codes] } | { ok:false, code }. The event carries event_key, source_request_hash and
 * export_id; `occurrence` is assigned per account window by assignOccurrences. Text is trimmed; '' -> null for the
 * nullable columns, '' kept for the not-null ones; quantity integer|null (0 kept as 0; negative / fractional / over 9
 * digits -> RETURNS_QUANTITY_INVALID); money/COGS exact canonical decimal strings within the RPC's 24.12 digit bound
 * (else RETURNS_NUMERIC_INVALID -- never rounded); cogs_currency upper-cased ^[A-Z]{3}$.
 * Anomalies (counted, never fatal): QUANTITY_NULL, QUANTITY_ZERO (units unavailable), FBA_ONLY_ON_FBM, FBM_ONLY_ON_FBA,
 * LPN_BLANK (an FBA row that cannot be physically keyed). Seller / marketplace / window ownership is validateAccountRows'.
 */
export function normalizeReturnsRow(raw, { sourceRequestHash, exportId = null } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, code: "RETURNS_ROW_NOT_OBJECT" };
  if (typeof sourceRequestHash !== "string" || !HEX64.test(sourceRequestHash)) return { ok: false, code: "RETURNS_FRAGMENT_UNKNOWN" };
  let exp = null;
  if (exportId !== null && exportId !== undefined) {
    exp = typeof exportId === "string" ? exportId.trim() : "";
    if (!exp || exp.length > MAX_EXPORT_ID) return { ok: false, code: "RETURNS_FRAGMENT_UNKNOWN" };
  }
  const event = {};
  const anomalies = [];
  for (const spec of COLUMN_SPECS) {
    // OWN properties only (an inherited value is never read); an absent NULLABLE column is null. An absent not-null
    // column is undefined here -- the runner's page shape check (RETURNS_SHAPE_SOURCE) refuses such a row first.
    const present = Object.prototype.hasOwnProperty.call(raw, spec.column);
    const r = KIND[spec.kind](present ? raw[spec.column] : (REQUIRED_SET.has(spec.column) ? undefined : null));
    if (r.code) return { ok: false, code: r.code };
    event[spec.field] = r.value;
    if (r.anomaly) anomalies.push(r.anomaly);
  }
  if (event.fulfillment_channel === "FBM" && RETURNS_FBA_ONLY_FIELDS.some((f) => event[f] !== null)) anomalies.push("FBA_ONLY_ON_FBM");
  if (event.fulfillment_channel === "FBA" && RETURNS_FBM_ONLY_FIELDS.some((f) => event[f] !== null)) anomalies.push("FBM_ONLY_ON_FBA");
  if (event.fulfillment_channel === "FBA" && event.license_plate_number === null) anomalies.push("LPN_BLANK");
  event.event_key = eventKey(event);
  event.source_request_hash = sourceRequestHash;
  event.export_id = exp;
  return { ok: true, event, anomalies };
}

/** PURE: the 24 canonical values (RETURNS_EVENT_COLUMNS order) an event_key hashes: quantity as a canonical decimal. */
export function eventKeyValues(event) {
  const e = event && typeof event === "object" ? event : {};
  return COLUMN_SPECS.map((spec) => {
    const v = e[spec.field];
    if (v === undefined || v === null) return null;
    if (spec.kind === "quantity") { const c = canonicalDecimal(v); return c === undefined ? null : c; }
    return v;
  });
}

/** PURE: event_key = sha256 hex of JSON.stringify(the 24 canonical values). Fragment metadata never enters the key. */
export function eventKey(event) {
  return sha256Hex(JSON.stringify(eventKeyValues(event)));
}

const keyOf = (e) => (e && typeof e.event_key === "string" && HEX64.test(e.event_key) ? e.event_key : eventKey(e));

/**
 * PURE, deterministic, lossless: a NEW array sorted by event_key (stable on input order), every element a copy with
 * occurrence = its 1-based ordinal among rows with the same event_key. Value-identical rows always come from the same
 * fragment (the key holds the date; fragments are disjoint date ranges), so the result does not depend on row order.
 */
export function assignOccurrences(events) {
  if (!Array.isArray(events)) throw new TypeError("assignOccurrences: events must be an array (fail closed).");
  const list = events.map((e, i) => ({ e, i, k: keyOf(e) }));
  list.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.i - b.i));
  const seen = new Map();
  return list.map(({ e, k }) => {
    const n = (seen.get(k) || 0) + 1;
    seen.set(k, n);
    return { ...e, event_key: k, occurrence: n };
  });
}

// ================================================ identity (DESIGN 3.7, OD2) ================================================
/**
 * PURE: the physical identity of one returned unit, as a sha256 digest (never the raw ids): FBA -> (order id, sku, LPN)
 * when the LPN is non-blank; FBM -> (order id, sku, Amazon RMA id) when the RMA id is non-blank; otherwise null
 * (unkeyed). The channel is deliberately NOT part of the key (rule (a) holds for "any date/channel"), so the JS check
 * is never narrower than the replace RPC's own recomputation.
 */
export function physicalKey(event) {
  const e = event && typeof event === "object" ? event : {};
  const id = e.fulfillment_channel === "FBA" ? e.license_plate_number : e.fulfillment_channel === "FBM" ? e.rma_id : null;
  const idText = S(id).trim();
  if (!idText) return null;
  return sha256Hex(JSON.stringify([S(e.amazon_order_id).trim(), S(e.sku).trim(), idText]));
}

/**
 * PURE: the identity verdict of ONE account window (NO row is dropped or merged, whatever the verdict).
 * -> { status:'clear'|'ambiguous', detail:{ keyedFba, keyedFbm, unkeyed, keyCollisions, cogsVariants, identicalUnkeyed } }
 * keyCollisions = physical keys on 2+ rows (rule a); cogsVariants = non-COGS signatures seen with 2+ distinct COGS
 * tuples (rule b); identicalUnkeyed = event_keys shared by 2+ unkeyed rows (rule c). Counts only (identity_detail).
 */
export function assessIdentity(events) {
  if (!Array.isArray(events)) throw new TypeError("assessIdentity: events must be an array (fail closed).");
  const detail = { keyedFba: 0, keyedFbm: 0, unkeyed: 0, keyCollisions: 0, cogsVariants: 0, identicalUnkeyed: 0 };
  const byPhysical = new Map(); const unkeyedByEvent = new Map(); const cogsBySignature = new Map();
  for (const e of events) {
    const pk = physicalKey(e);
    if (pk === null) {
      detail.unkeyed += 1;
      const k = keyOf(e);
      unkeyedByEvent.set(k, (unkeyedByEvent.get(k) || 0) + 1);
    } else {
      if (e.fulfillment_channel === "FBA") detail.keyedFba += 1; else detail.keyedFbm += 1;
      byPhysical.set(pk, (byPhysical.get(pk) || 0) + 1);
    }
    const values = eventKeyValues(e);
    const signature = sha256Hex(JSON.stringify(values.filter((_, i) => !COGS_INDEX.has(i))));
    let tuples = cogsBySignature.get(signature);
    if (!tuples) cogsBySignature.set(signature, (tuples = new Set()));
    tuples.add(JSON.stringify(values.filter((_, i) => COGS_INDEX.has(i))));
  }
  for (const n of byPhysical.values()) if (n >= 2) detail.keyCollisions += 1;
  for (const n of unkeyedByEvent.values()) if (n >= 2) detail.identicalUnkeyed += 1;
  for (const tuples of cogsBySignature.values()) if (tuples.size >= 2) detail.cogsVariants += 1;
  const ambiguous = detail.keyCollisions > 0 || detail.cogsVariants > 0 || detail.identicalUnkeyed > 0;
  return { status: ambiguous ? "ambiguous" : "clear", detail };
}

// fragmentOf: (row, index) => meta | Map/WeakMap keyed by the row object | array aligned with rows.
function fragmentResolver(fragmentOf) {
  if (typeof fragmentOf === "function") return (row, i) => fragmentOf(row, i) || {};
  if (fragmentOf instanceof Map || fragmentOf instanceof WeakMap) return (row) => (row && typeof row === "object" ? fragmentOf.get(row) : null) || {};
  if (Array.isArray(fragmentOf)) return (_row, i) => fragmentOf[i] || {};
  throw new TypeError("validateAccountRows: fragmentOf must map every row to its fragment { sourceRequestHash, exportId } (fail closed).");
}
const sortedCounts = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));

/**
 * PURE: validate + normalize ONE account's rows from ALL fragments of its batch (DESIGN 3.7). Every row must normalize,
 * belong to `sellerId` (and the account must be bound to it: primary account = seller, dd-secondary account =
 * 'dd-secondary:' + seller), carry the account's marketplace (UK -> GB on both sides) and a return date inside
 * [from, to]. Any failure fails THIS account alone (the caller records it; nothing is written) ->
 *   { ok:false, code (the first failure in row order), anomalies:{code:count}, failures:{code:count} }.
 * Otherwise -> { ok:true, events (assignOccurrences order, every row kept), anomalies:{code:count},
 *   identity:{status,detail}, expectedCount, expectedUnits (sum of the non-null quantities) }.
 * anomalies (both shapes) = the per-row codes of the valid rows + COGS_CURRENCY_MIXED: 1 when those rows carry 2+
 * distinct non-null cogs_currency values (counts only; the rows are kept with their own currency).
 * An AMBIGUOUS identity is still ok:true: the account persists every row and the RPC holds it.
 */
export function validateAccountRows({ rows, accountId, sellerId, marketplace, from, to, fragmentOf } = {}) {
  if (!Array.isArray(rows)) throw new TypeError("validateAccountRows: rows must be an array (fail closed).");
  if (!isYmd(from) || !isYmd(to) || from > to) throw new TypeError("validateAccountRows: invalid window (fail closed).");
  const fragment = fragmentResolver(fragmentOf);
  const account = textOf(accountId) || ""; const seller = textOf(sellerId) || "";
  const mkt = normalizeMarketplace(marketplace);
  if (!seller || (account !== seller && account !== "dd-secondary:" + seller)) {
    return { ok: false, code: "RETURNS_SELLER_MISMATCH", anomalies: {}, failures: { RETURNS_SELLER_MISMATCH: rows.length || 1 } };
  }
  if (!/^[A-Z]{2}$/.test(mkt)) {
    return { ok: false, code: "RETURNS_MARKETPLACE_MISMATCH", anomalies: {}, failures: { RETURNS_MARKETPLACE_MISMATCH: rows.length || 1 } };
  }
  const anomalyCounts = {}; const failureCounts = {}; let first = null;
  const fail = (code) => { failureCounts[code] = (failureCounts[code] || 0) + 1; if (!first) first = code; };
  const events = [];
  rows.forEach((raw, i) => {
    const r = normalizeReturnsRow(raw, fragment(raw, i));
    if (!r.ok) return fail(r.code);
    const e = r.event;
    if (e.seller_or_vendor_id !== seller) return fail("RETURNS_SELLER_MISMATCH");
    if (e.marketplace_country_code !== mkt) return fail("RETURNS_MARKETPLACE_MISMATCH");
    if (e.return_date < from || e.return_date > to) return fail("RETURNS_ROW_OUTSIDE_WINDOW");
    for (const a of r.anomalies) anomalyCounts[a] = (anomalyCounts[a] || 0) + 1;
    events.push(e);
    return undefined;
  });
  // COGS in 2+ currencies inside ONE account window: counted once (COGS totals across currencies are not summable);
  // every row is kept and stored with its own currency.
  if (new Set(events.map((e) => e.cogs_currency).filter((c) => c !== null)).size >= 2) anomalyCounts.COGS_CURRENCY_MIXED = 1;
  const anomalies = sortedCounts(anomalyCounts);
  if (first) return { ok: false, code: first, anomalies, failures: sortedCounts(failureCounts) };
  const withOccurrences = assignOccurrences(events);
  return {
    ok: true, events: withOccurrences, anomalies, identity: assessIdentity(withOccurrences),
    expectedCount: withOccurrences.length,
    expectedUnits: withOccurrences.reduce((t, e) => t + (e.quantity === null ? 0 : e.quantity), 0),
  };
}

/**
 * PURE, counts only: order ids seen under 2+ accounts of the run (the pan-EU / NA shared-inventory signature). Accepts a
 * Map<accountId, events[]> (or a plain object). -> { orders, accountsAffected }. Never returns an id.
 */
export function crossAccountOrderCollisions(eventsByAccount) {
  let entries = null;
  if (eventsByAccount instanceof Map) entries = [...eventsByAccount.entries()];
  else if (eventsByAccount && typeof eventsByAccount === "object" && !Array.isArray(eventsByAccount)) entries = Object.entries(eventsByAccount);
  if (!entries) throw new TypeError("crossAccountOrderCollisions: expected a Map of accountId -> events (fail closed).");
  const owners = new Map();
  for (const [account, events] of entries) {
    for (const e of Array.isArray(events) ? events : []) {
      const order = S(e && e.amazon_order_id).trim();
      if (!order) continue;
      let set = owners.get(order);
      if (!set) owners.set(order, (set = new Set()));
      set.add(S(account));
    }
  }
  let orders = 0; const affected = new Set();
  for (const set of owners.values()) if (set.size >= 2) { orders += 1; for (const a of set) affected.add(a); }
  return { orders, accountsAffected: affected.size };
}

// ================================================ history aggregate mirror (DESIGN 1.6g) ================================================
// Exact decimal arithmetic (BigInt scaled integers) so money sums equal Postgres numeric sums digit for digit.
const decOf = (v) => {
  const c = canonicalDecimal(v);
  if (c === undefined) throw new TypeError("aggregateEventsForHistory: a money value is not a canonical decimal (fail closed).");
  if (c === null) return { n: 0n, scale: 0 };
  const neg = c.startsWith("-"); const body = neg ? c.slice(1) : c;
  const [ip, fp = ""] = body.split(".");
  const n = BigInt(ip + fp);
  return { n: neg ? -n : n, scale: fp.length };
};
const decAbs = (a) => ({ n: a.n < 0n ? -a.n : a.n, scale: a.scale });
const decAdd = (a, b) => {
  const scale = Math.max(a.scale, b.scale);
  return { n: a.n * 10n ** BigInt(scale - a.scale) + b.n * 10n ** BigInt(scale - b.scale), scale };
};
const decString = (a) => {
  const neg = a.n < 0n;
  let digits = (neg ? -a.n : a.n).toString();
  if (a.scale > 0) {
    digits = digits.padStart(a.scale + 1, "0");
    digits = digits.slice(0, digits.length - a.scale) + "." + digits.slice(digits.length - a.scale);
  }
  return canonicalDecimal((neg ? "-" : "") + digits);
};
// collate "C" = byte order of the UTF-8 encoding = Unicode code point order (NOT JS UTF-16 code unit order).
function compareCodePoints(a, b) {
  const ia = a[Symbol.iterator](); const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next(); const y = ib.next();
    if (x.done || y.done) return x.done ? (y.done ? 0 : -1) : 1;
    const cx = x.value.codePointAt(0); const cy = y.value.codePointAt(0);
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

/**
 * PURE JS MIRROR of the replace RPC's history aggregate (DESIGN 1.6g) -- for tests and offline evidence; production
 * history rows are derived INSIDE the RPC transaction. Attribution 'exclude-other-owner' drops events whose
 * order_owner = 'other' (order_owner is computed by the RPC; pass it on test events). Grain = (return_date, sku,
 * child_asin, amazon_return_reason, fulfillment_channel, request_status, coalesce(label_paid_by,'') AS label_payer):
 *   return_count = rows; returned_units = sum(quantity) only when EVERY row has quantity >= 1, else null;
 *   fbm_refunded_amount = sum|refunded|; fbm_seller_label_cost = sum|label_cost| where label_payer ~* 'seller';
 *   cogs_total_value = sum|cogs_total_value| (exact decimal strings); detailed_disposition = min non-blank (collate
 *   "C") or ''; source_request_hash = min; seller / marketplace / refreshed_at = the RPC params (options).
 * Rows are returned in grain order. Parity with the legacy fold (aggregateReturnsForAccount): identical grain set,
 * return_count and money; disposition is a documented deterministic min (the payload never reads it).
 */
export function aggregateEventsForHistory(events, { attribution = RETURNS_ATTRIBUTION, sellerOrVendorId = null, marketplaceCountryCode = null, refreshedAt = null } = {}) {
  if (!Array.isArray(events)) throw new TypeError("aggregateEventsForHistory: events must be an array (fail closed).");
  if (!RETURNS_ATTRIBUTIONS.includes(attribution)) throw new TypeError("aggregateEventsForHistory: unknown attribution (fail closed).");
  const groups = new Map();
  for (const e of events) {
    if (attribution === "exclude-other-owner" && e.order_owner === "other") continue;
    const payer = e.label_paid_by == null ? "" : S(e.label_paid_by);
    const parts = [S(e.return_date), S(e.sku), S(e.child_asin), S(e.amazon_return_reason), S(e.fulfillment_channel), S(e.request_status), payer];
    const key = JSON.stringify(parts);
    let g = groups.get(key);
    if (!g) {
      g = { parts, count: 0, unitsOk: true, units: 0, refunded: decOf(null), label: decOf(null), cogs: decOf(null), disposition: null, hash: null,
        seller: S(e.seller_or_vendor_id), marketplace: S(e.marketplace_country_code) };
      groups.set(key, g);
    }
    g.count += 1;
    const q = e.quantity;
    if (q === null || q === undefined || !(Number(q) >= 1)) g.unitsOk = false; else g.units += Number(q);
    g.refunded = decAdd(g.refunded, decAbs(decOf(e.refunded_amount)));
    if (/seller/i.test(payer)) g.label = decAdd(g.label, decAbs(decOf(e.label_cost)));
    g.cogs = decAdd(g.cogs, decAbs(decOf(e.cogs_total_value)));
    const d = e.detailed_disposition == null ? "" : S(e.detailed_disposition);
    if (d !== "" && (g.disposition === null || compareCodePoints(d, g.disposition) < 0)) g.disposition = d;
    const h = S(e.source_request_hash);
    if (g.hash === null || h < g.hash) g.hash = h;
  }
  return [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, g]) => ({
    seller_or_vendor_id: sellerOrVendorId != null ? S(sellerOrVendorId) : g.seller,
    marketplace_country_code: marketplaceCountryCode != null ? S(marketplaceCountryCode) : g.marketplace,
    return_date: g.parts[0], sku: g.parts[1], child_asin: g.parts[2], amazon_return_reason: g.parts[3],
    fulfillment_channel: g.parts[4], request_status: g.parts[5], label_payer: g.parts[6],
    detailed_disposition: g.disposition === null ? "" : g.disposition,
    return_count: g.count, returned_units: g.unitsOk ? g.units : null,
    fbm_refunded_amount: decString(g.refunded), fbm_seller_label_cost: decString(g.label), cogs_total_value: decString(g.cogs),
    source_request_hash: g.hash, refreshed_at: refreshedAt,
  }));
}

// ================================================ planning (DESIGN 3.3) ================================================
const lastSuccessMs = (p) => {
  const v = p.lastSuccessAt ?? p.last_success_at ?? (p.state && typeof p.state === "object" ? p.state.last_success_at : null) ?? null;
  const ms = v == null ? NaN : Date.parse(S(v));
  return Number.isFinite(ms) ? ms : null;
};
// Oldest last_success_at first (never-succeeded = null first), then account id.
const staleFirst = (a, b) => {
  if (a.lss !== b.lss) {
    if (a.lss === null) return -1;
    if (b.lss === null) return 1;
    return a.lss - b.lss;
  }
  return a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0;
};

/**
 * PURE: <=5-seller create batches for the accounts that NEED a paid export (mode 'initial' | 'rolling'; every other
 * kind plans nothing). Entry: { accountId, sellerId? (default accountId), mode|kind, window:{from,to},
 * lastSuccessAt? | last_success_at? | state? }. Accounts are grouped by IDENTICAL (mode, window) -- a batch never mixes
 * windows -- and chunked by 5 in staleness order; ROLLING items come first, then initial; inside each, items are
 * ordered by their stalest account (oldest last_success_at, null first, then account id), so a create ceiling that
 * cuts the plan short serves the stalest accounts first. A duplicate account / seller or a malformed or >62-day window
 * throws (fail closed: never a paid export the RPC would refuse).
 * -> [{ window:{from,to}, mode, accountIds, sellerIds }]; planned creates = items.length = sum over windows of ceil(n/5).
 */
export function planReturnsBatches(pending) {
  if (!Array.isArray(pending)) throw new TypeError("planReturnsBatches: pending must be an array (fail closed).");
  const accounts = new Set(); const sellers = new Set(); const entries = [];
  for (const p of pending) {
    const mode = S(p && (p.mode ?? p.kind));
    if (mode !== "initial" && mode !== "rolling") continue;
    const accountId = S(p.accountId ?? p.account_id).trim();
    const sellerId = S(p.sellerId ?? p.sellerOrVendorId ?? p.seller_or_vendor_id ?? accountId).trim();
    const win = p.window && typeof p.window === "object" ? p.window : {};
    if (!accountId || !sellerId || !isYmd(win.from) || !isYmd(win.to) || win.from > win.to || daySpan(win.from, win.to) > MAX_WINDOW_DAYS) {
      throw new TypeError("planReturnsBatches: invalid pending entry (fail closed).");
    }
    if (accounts.has(accountId) || sellers.has(sellerId)) throw new TypeError("planReturnsBatches: duplicate account or seller (fail closed).");
    accounts.add(accountId); sellers.add(sellerId);
    entries.push({ mode, accountId, sellerId, from: win.from, to: win.to, lss: lastSuccessMs(p) });
  }
  const items = [];
  for (const mode of ["rolling", "initial"]) {
    const groups = new Map();
    for (const e of entries.filter((x) => x.mode === mode).sort(staleFirst)) {
      const k = e.from + "|" + e.to;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    }
    const chunks = [];
    for (const list of groups.values()) {
      for (let i = 0; i < list.length; i += RETURNS_MAX_SELLERS) chunks.push(list.slice(i, i + RETURNS_MAX_SELLERS));
    }
    chunks.sort((a, b) => staleFirst(a[0], b[0]));
    for (const c of chunks) {
      items.push({ window: { from: c[0].from, to: c[0].to }, mode, accountIds: c.map((e) => e.accountId), sellerIds: c.map((e) => e.sellerId) });
    }
  }
  return items;
}

/**
 * PURE: token exposure of a plan (2 tokens per create). expectedTokens = planned creates x 2 (one create per <=5-seller
 * item; density keeps every batch far below the 50,000-row cap, so no split is expected); ceilingTokens = the hard
 * DB-enforced create ceiling x 2 = the worst case (a split tree / ambiguous POST can never exceed the slot ceiling).
 */
export function returnsPlanExposure(items, { maxCreates = null } = {}) {
  if (!Array.isArray(items)) throw new TypeError("returnsPlanExposure: items must be an array (fail closed).");
  let max = null;
  if (maxCreates !== null && maxCreates !== undefined) {
    max = Number(maxCreates);
    if (!Number.isInteger(max) || max < 0) throw new TypeError("returnsPlanExposure: maxCreates must be a non-negative integer (fail closed).");
  }
  return {
    plannedCreates: items.length, maxCreates: max,
    expectedTokens: items.length * RETURNS_TOKENS_PER_CREATE, ceilingTokens: max === null ? null : max * RETURNS_TOKENS_PER_CREATE,
  };
}

// ================================================ request identity (DESIGN 3.8) ================================================
const canonAggs = (aggs) => (Array.isArray(aggs) ? aggs : []).map((a) => [S(a && a.column), S(a && a.aggregation).toLowerCase(), S(a && a.alias)].join(":")).sort().join("|");
/**
 * PURE: the canonical identity string of one create-export request -- BYTE-IDENTICAL to scheduled-asin-ads-runner.js
 * exportRequestIdentity (mirrored, not imported: that module reaches the DataDoe/Supabase transport). For a Returns
 * body it is JSON [sourceId, sorted sellers, columns, from, to, [] (groupBy), "" (aggregations), limit, skip,
 * outputType, orderByColumn, orderByDirection]. Holds raw seller ids: never log it.
 */
export function returnsRequestIdentity(body) {
  const e = body || {};
  return JSON.stringify([
    S(e.sourceId), [...(e.sellerOrVendorIds || [])].map(S).sort(), (e.columns || []).map(S), S(e.from).slice(0, 10), S(e.to).slice(0, 10),
    (e.groupBy || []).map(S), canonAggs(e.aggregations), Number(e.limit), Number(e.skip || 0), S(e.outputType).toUpperCase(),
    S(e.orderByColumn), S(e.orderByDirection).toUpperCase(),
  ]);
}
/** PURE: source_request_hash of one fragment = sha256(exportRequestIdentity(body)) (64-hex; DESIGN 3.8). */
export function returnsRequestHash(body) {
  return sha256Hex(returnsRequestIdentity(body));
}

// ================================================ output contract helpers ================================================
/** PURE: the 8-char prefix that is the ONLY form of an account / export id allowed in logs, RESULT and status rows. */
export function maskId(v) {
  return S(v).trim().slice(0, 8);
}

const KNOWN_COUNT_CODES = new Set([...RETURNS_ANOMALY_CODES, ...RETURNS_ROW_FAILURE_CODES]);
/**
 * PURE, counts only: merge anomaly / failure codes from any mix of code arrays, {code:count} objects and
 * normalize/validate results into ONE {code:count} object (sorted keys). A key that is not a known code is folded into
 * OTHER, so a stray row value can never surface as a key.
 */
export function summarizeAnomalies(...inputs) {
  const out = {};
  const add = (code, n) => { const c = KNOWN_COUNT_CODES.has(code) ? code : "OTHER"; out[c] = (out[c] || 0) + n; };
  const visit = (x) => {
    if (x === null || x === undefined) return;
    if (typeof x === "string") { add(x, 1); return; }
    if (Array.isArray(x)) { x.forEach(visit); return; }
    if (typeof x !== "object") return;
    if (Object.prototype.hasOwnProperty.call(x, "anomalies")) { visit(x.anomalies); return; }
    for (const [k, v] of Object.entries(x)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) add(k, Math.trunc(n));
    }
  };
  inputs.forEach(visit);
  return sortedCounts(out);
}

// ================================================ operator status row ================================================
const OUTCOME_ALIASES = {
  initialLoaded: ["initialLoaded", "initial-loaded"], dailyRefreshed: ["dailyRefreshed", "daily-refreshed"],
  skippedCurrent: ["skippedCurrent", "skipped-current"], held: ["held"], incomplete: ["incomplete"], failed: ["failed"],
  pending: ["pending"], incompatible: ["incompatible"],
};
const countValue = (v) => {
  if (Array.isArray(v)) return v.length;
  const n = Number(v);
  return v !== null && v !== undefined && Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
};

/**
 * PURE: the operator status row (source_run_status keyed ('returns', region)) for one finished region run -- the
 * upsertSourceRunStatus entry shape. Accepted input (every field optional):
 *   plan    = { items (planReturnsBatches), windows (returnsWindows of the region D-1), accountsTotal | compatible[] }
 *   outcome = { systemic, code (typed run code), creates, accounts|counts|<top level>: per DESIGN 3.9 outcome a count
 *               or an id array (initialLoaded|'initial-loaded', dailyRefreshed, skippedCurrent, held, incomplete,
 *               failed, pending, incompatible), coverageGap:{accounts, days} | gapAccounts + gapDays }
 * succeeded only when nothing is held / incomplete / failed / pending, there is no coverage gap and no typed run code;
 * failed on a systemic failure; partial otherwise. Incompatible accounts are reported by the runner, not counted here.
 * The safe stage is a counts-only phrase (e.g. "failed 1, coverage gap 12 days on 1 account"). Never an id.
 */
export function returnsRunStatusEntry({ region, plan = {}, outcome = {}, maxCreates = null, nowIso } = {}) {
  if (!RETURNS_REGIONS.includes(region)) throw new TypeError("returnsRunStatusEntry: unknown region (fail closed).");
  if (typeof nowIso !== "string" || !Number.isFinite(Date.parse(nowIso))) throw new TypeError("returnsRunStatusEntry: nowIso must be an ISO timestamp (fail closed).");
  const p = plan && typeof plan === "object" ? plan : {};
  const o = outcome && typeof outcome === "object" ? outcome : {};
  const src = [o.accounts, o.counts].find((x) => x && typeof x === "object" && !Array.isArray(x)) || o;
  const n = (k) => { for (const name of OUTCOME_ALIASES[k]) if (src[name] !== undefined) return countValue(src[name]); return 0; };
  const completed = n("initialLoaded") + n("dailyRefreshed") + n("skippedCurrent");
  const held = n("held"); const incomplete = n("incomplete"); const failed = n("failed"); const pending = n("pending");
  const gap = o.coverageGap && typeof o.coverageGap === "object" ? o.coverageGap : {};
  const gapAccounts = countValue(gap.accounts ?? o.gapAccounts); const gapDays = countValue(gap.days ?? o.gapDays);
  const systemic = o.systemic === true;
  const code = typeof o.code === "string" && CODE_RE.test(o.code) ? o.code : null;
  const problems = held + incomplete + failed + pending;
  const succeeded = !systemic && problems === 0 && gapAccounts === 0 && code === null;
  const phrase = [];
  if (failed) phrase.push("failed " + failed);
  if (incomplete) phrase.push("incomplete " + incomplete);
  if (held) phrase.push("held " + held);
  if (pending) phrase.push("pending " + pending);
  if (gapAccounts) phrase.push("coverage gap " + gapDays + " days on " + gapAccounts + " account" + (gapAccounts === 1 ? "" : "s"));
  const windows = p.windows && typeof p.windows === "object" ? p.windows : {};
  const coveredFrom = succeeded && windows.initial && isYmd(windows.initial.from) ? windows.initial.from : null;
  const coveredTo = succeeded && windows.rolling && isYmd(windows.rolling.to) ? windows.rolling.to : null;
  const creates = countValue(o.creates);
  let ceiling = null;
  if (maxCreates !== null && maxCreates !== undefined && Number.isInteger(Number(maxCreates)) && Number(maxCreates) >= 0) ceiling = Number(maxCreates);
  const total = Number.isInteger(p.accountsTotal) && p.accountsTotal >= 0 ? p.accountsTotal
    : Array.isArray(p.compatible) ? p.compatible.length : completed + problems;
  return {
    sourceKey: RETURNS_EVENT_SOURCE_KEY, bucket: region,
    lastStatus: systemic ? "failed" : succeeded ? "succeeded" : "partial",
    lastAttemptAt: nowIso, ...(succeeded ? { lastSuccessAt: nowIso } : {}),
    safeErrorCode: systemic ? (code || "RETURNS_FAILED")
      : (code || (failed ? "RETURNS_ACCOUNTS_FAILED" : incomplete ? "RETURNS_ACCOUNTS_INCOMPLETE" : held ? "RETURNS_ACCOUNTS_HELD"
        : pending ? "RETURNS_ACCOUNTS_PENDING" : gapAccounts ? "RETURNS_COVERAGE_GAP" : null)),
    safeErrorStage: systemic ? "run" : (phrase.length ? phrase.join(", ") : null),
    coveredFrom: coveredFrom && coveredTo ? coveredFrom : null, coveredTo: coveredFrom && coveredTo ? coveredTo : null,
    accountsCompleted: completed, accountsFailed: problems, accountsTotal: total,
    batchCount: Array.isArray(p.items) ? p.items.length : 0,
    createsSpent: creates, tokensSpent: creates * RETURNS_TOKENS_PER_CREATE,
    createsCeiling: ceiling, tokensCeiling: ceiling === null ? null : ceiling * RETURNS_TOKENS_PER_CREATE,
  };
}
