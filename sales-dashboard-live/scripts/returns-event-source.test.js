// Returns (FBA & FBM) EVENT source -- the PURE core (lib/server/sync/returns-event-source.js; DESIGN-v2 sections 2, 3.3,
// 3.7, 3.8 + CONTRACT A-C). EXECUTABLE offline proof: every fetch is refused; the transport modules (ads-sync.js, the
// ASIN runner) are imported ONLY to prove the pure mirrors are byte-identical to them. Covers:
//   A constants, the exact RAW request body (no groupBy), page validation with the pseudo source, request-hash parity;
//   B windows (documented examples, month + year rollover), accountD1 per marketplace at the 3 regional times + a late
//     operator time, operator --as-of bounds;
//   C every mode branch (pending / held / reverify / initial / skipped-current / rolling), no catch-up, coverage gap days;
//   D normalization (UK->GB, canonical decimals, null vs '', channel-only anomalies, quantity null/0/negative/fraction,
//     currencies, cogs_present, dates, text, fragment metadata);
//   E event_key formula / stability / sensitivity, deterministic occurrences;
//   F identity rules (a) keyed collisions, (b) COGS-only variants, (c) identical unkeyed -- every row kept;
//   G validateAccountRows failures + success (fragments, units, anomalies);
//   H planning (identical windows, <=5 sellers, ordering, 2/7/3 batches for 8/32/11 accounts) + exposure;
//   I cross-account collisions, masking, anomaly summary, run-status row, output-contract redaction;
//   J history aggregate mirror == legacy aggregateReturnsForAccount (shared fields) + the RPC SQL semantics;
//   K purity: import closure (zero-I/O leaves only), 7-bit ASCII, no I/O primitives.
// 7-bit ASCII, LF, no top-level await in the test bodies.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Dummy transport configuration (never a real credential), set BEFORE any transport module loads; ZERO network.
process.env.SUPABASE_URL = "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = ["test", "svc", "role", "key"].join("-");
process.env.DATADOE_API_KEY = ["dd", "test"].join("_");
globalThis.fetch = async (u) => { throw new Error("NETWORK REFUSED IN TEST: " + String(u).slice(0, 60)); };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_PATH = path.join(ROOT, "lib", "server", "sync", "returns-event-source.js");
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
let passed = 0; const tests = []; const test = (name, fn) => tests.push({ name, fn });

const M = await import("../lib/server/sync/returns-event-source.js");
const SRC = await import("../lib/server/reports/sources.js");
const LEG = await import("../lib/server/sync/returns-source-refresh.js");
const AS = await import("../lib/server/ads-sync.js");
const R = await import("../lib/server/sync/scheduled-asin-ads-runner.js");

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
// Synthetic identifiers only (never a real account / order / LPN / RMA).
const SELLER = "a0000001-0000-4000-8000-000000000001";
const OTHER_SELLER = "a0000002-0000-4000-8000-000000000002";
const acct = (n) => "a" + String(n).padStart(7, "0") + "-0000-4000-8000-000000000000";
const D1 = "2026-10-04";
const W = M.returnsWindows(D1); // initial 2026-08-06..2026-10-04, rolling 2026-09-21..2026-10-04
const NOW = "2026-10-05T09:00:00.000Z";
const BODY_A = AS.buildAdsExportRequestBody(M.RETURNS_PSEUDO_SOURCE, [SELLER], W.rolling.from, "2026-09-27", 0);
const BODY_B = AS.buildAdsExportRequestBody(M.RETURNS_PSEUDO_SOURCE, [SELLER], "2026-09-28", D1, 0);
const H1 = M.returnsRequestHash(BODY_A);
const H2 = M.returnsRequestHash(BODY_B);
const META_A = { sourceRequestHash: H1, exportId: "e0000001-0000-4000-8000-00000000000a" };
const META_B = { sourceRequestHash: H2, exportId: "e0000002-0000-4000-8000-00000000000b" };
const ORDER1 = "000-0000000-0000001";

// One full 24-column raw row (FBA by default) + an FBM variant.
const fbaRow = (o = {}) => ({
  seller_or_vendor_id: SELLER, marketplace_country_code: "GB", date: "2026-09-30", order_date: null,
  sku: "SKU-1", child_asin: "B000000001", fnsku: "X000000001", amazon_order_id: ORDER1, quantity: 1,
  amazon_return_reason: "UNWANTED_ITEM", amazon_fulfillment_channel: "FBA", amazon_return_request_status: "Unit returned to inventory",
  amazon_return_detailed_disposition: "SELLABLE", amazon_return_rmaid: null, amazon_return_seller_rmaid: null,
  amazon_return_label_to_be_paid_by: null, amazon_return_refunded_amount: null, amazon_return_label_cost: null,
  cogs_item_value: "4.20", cogs_shipping_value: "0.50", cogs_total_value: "4.70", cogs_currency: "GBP", cogs_present: true,
  amazon_license_plate_number: "LPN0000000001", ...o,
});
const fbmRow = (o = {}) => fbaRow({
  order_date: "2026-09-20", fnsku: null, amazon_fulfillment_channel: "FBM", amazon_return_request_status: "Approved",
  amazon_return_detailed_disposition: null, amazon_return_rmaid: "RMA0000000001", amazon_return_seller_rmaid: "SRMA0000001",
  amazon_return_label_to_be_paid_by: "Seller", amazon_return_refunded_amount: "-12.50", amazon_return_label_cost: "3.10",
  amazon_license_plate_number: "", ...o,
});
const norm = (row, meta = META_A) => { const r = M.normalizeReturnsRow(row, meta); assert.equal(r.ok, true, "row did not normalize: " + r.code); return r; };
const ev = (row, meta = META_A) => norm(row, meta).event;
const code = (row, meta = META_A) => M.normalizeReturnsRow(row, meta).code;
const vrows = (rows, o = {}) => M.validateAccountRows({ rows, accountId: SELLER, sellerId: SELLER, marketplace: "GB", from: W.rolling.from, to: D1, fragmentOf: () => META_A, ...o });
const SECRETS = [SELLER, ORDER1, "LPN0000000001", "RMA0000000001", "SRMA0000001", "X000000001"];
const assertRedacted = (value, label) => { const s = JSON.stringify(value); for (const x of SECRETS) assert.ok(!s.includes(x), label + " leaks a raw identifier"); };
const daysIn = (from, to) => Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000) + 1;

// ================================================ A. constants + request contract ================================================
test("A1 CONTRACT A constants: 23 owner fields in request order + LPN as the 24th; ids, limits, windows, attribution", () => {
  assert.deepEqual([...M.RETURNS_OWNER_FIELDS], ["seller_or_vendor_id", "marketplace_country_code", "date", "order_date", "sku", "child_asin",
    "fnsku", "amazon_order_id", "quantity", "amazon_return_reason", "amazon_fulfillment_channel",
    "amazon_return_request_status", "amazon_return_detailed_disposition", "amazon_return_rmaid",
    "amazon_return_seller_rmaid", "amazon_return_label_to_be_paid_by", "amazon_return_refunded_amount",
    "amazon_return_label_cost", "cogs_item_value", "cogs_shipping_value", "cogs_total_value", "cogs_currency", "cogs_present"]);
  assert.equal(M.RETURNS_EVENT_COLUMNS.length, 24);
  assert.deepEqual([...M.RETURNS_EVENT_COLUMNS], [...M.RETURNS_OWNER_FIELDS, "amazon_license_plate_number"]);
  assert.equal(M.RETURNS_EVENT_SOURCE_KEY, "returns");
  assert.equal(M.RETURNS_SOURCE_ID, SRC.RETURNS.id);
  assert.equal(M.RETURNS_SOURCE_ID, "27c6fc0ec69648b5fed4612dbd9ccdfdeaaca6787f8f985c01266e4dc11f9038");
  assert.equal(M.RETURNS_TOKENS_PER_CREATE, 2); assert.equal(M.RETURNS_EXPORT_ROW_LIMIT, 50000); assert.equal(M.RETURNS_MAX_SELLERS, 5);
  assert.equal(M.RETURNS_INITIAL_DAYS, 60); assert.equal(M.RETURNS_ROLLING_DAYS, 14); assert.equal(M.RETURNS_ATTRIBUTION, "as-delivered");
  assert.equal(M.RETURNS_COMPATIBLE_SOURCE_NAME, "returns (fba & fbm)");
  assert.equal(M.RETURNS_COMPATIBLE_SOURCE_NAME, SRC.RETURNS.label.toLowerCase(), "the compatible-source name is the registry label, lower-cased");
  assert.deepEqual([...M.RETURNS_REGIONS], ["india", "europe-au", "us-ca"]);
  assert.equal(M.RETURNS_PSEUDO_SOURCE.key, "returns-events"); assert.equal(M.RETURNS_PSEUDO_SOURCE.sourceId, M.RETURNS_SOURCE_ID);
  assert.equal(M.RETURNS_PSEUDO_SOURCE.dimensions, M.RETURNS_EVENT_COLUMNS);
  assert.deepEqual([...M.RETURNS_PSEUDO_SOURCE.metrics], []); assert.deepEqual([...M.RETURNS_PSEUDO_SOURCE.keyFields], []);
  assert.equal(M.RETURNS_PSEUDO_SOURCE.aggregations, undefined);
});
test("A2 the shared constants are frozen (no caller can mutate the request columns)", () => {
  for (const c of [M.RETURNS_OWNER_FIELDS, M.RETURNS_EVENT_COLUMNS, M.RETURNS_REGIONS, M.RETURNS_PSEUDO_SOURCE, M.RETURNS_PSEUDO_SOURCE.metrics]) assert.ok(Object.isFrozen(c));
  assert.throws(() => M.RETURNS_EVENT_COLUMNS.push("x"), TypeError);
});
test("A3 CONTRACT B event keys == source_returns_events columns (order_owner is NOT sent; the RPC computes it)", () => {
  assert.deepEqual([...M.RETURNS_EVENT_FIELDS], ["seller_or_vendor_id", "marketplace_country_code", "return_date", "order_date", "sku", "child_asin",
    "fnsku", "amazon_order_id", "quantity", "amazon_return_reason", "fulfillment_channel", "request_status", "detailed_disposition",
    "rma_id", "seller_rma_id", "label_paid_by", "refunded_amount", "label_cost", "cogs_item_value", "cogs_shipping_value",
    "cogs_total_value", "cogs_currency", "cogs_present", "license_plate_number", "event_key", "occurrence", "source_request_hash", "export_id"]);
  const e = ev(fbaRow());
  assert.deepEqual(Object.keys(e), M.RETURNS_EVENT_FIELDS.filter((k) => k !== "occurrence"));
  assert.ok(!("order_owner" in e));
});
test("A4 the pseudo source builds EXACTLY the DESIGN 3.4 body: RAW (no groupBy / aggregations), 24 columns, limit 50000, skip 0, JSON, date ASC", () => {
  const b = AS.buildAdsExportRequestBody(M.RETURNS_PSEUDO_SOURCE, [OTHER_SELLER, SELLER], W.rolling.from, D1, 0);
  assert.deepEqual(Object.keys(b), ["sourceId", "sellerOrVendorIds", "columns", "from", "to", "limit", "skip", "outputType", "orderByColumn", "orderByDirection"]);
  assert.deepEqual(b, { sourceId: M.RETURNS_SOURCE_ID, sellerOrVendorIds: [OTHER_SELLER, SELLER], columns: [...M.RETURNS_EVENT_COLUMNS],
    from: W.rolling.from, to: D1, limit: 50000, skip: 0, outputType: "JSON", orderByColumn: "date", orderByDirection: "ASC" });
  assert.notEqual(b.columns, M.RETURNS_EVENT_COLUMNS, "the body gets a copy, never the frozen shared array");
});
test("A5 ads-sync validateSplitWindowPage with the pseudo source requires all 24 columns and every date inside the fragment", () => {
  const page = (rows) => ({ status: "COMPLETED", rowCount: rows.length, rows, loadingNotice: null, dataSourceIssues: [] });
  assert.equal(AS.validateSplitWindowPage(page([fbaRow(), fbmRow()]), W.rolling.from, D1, M.RETURNS_PSEUDO_SOURCE).length, 2);
  const noLpn = fbaRow(); delete noLpn.amazon_license_plate_number;
  assert.throws(() => AS.validateSplitWindowPage(page([noLpn]), W.rolling.from, D1, M.RETURNS_PSEUDO_SOURCE), (e) => e.code === "ADS_EXPORT_SHAPE_MISMATCH");
  assert.throws(() => AS.validateSplitWindowPage(page([fbaRow({ date: "2026-09-20" })]), W.rolling.from, D1, M.RETURNS_PSEUDO_SOURCE), (e) => e.code === "ADS_EXPORT_ROW_OUTSIDE_WINDOW");
});
test("A6 returnsRequestHash = sha256(exportRequestIdentity(body)) byte-for-byte (DESIGN 3.8); seller order-independent; sensitive to the window/columns/limit", () => {
  const bodies = [BODY_A, BODY_B, AS.buildAdsExportRequestBody(M.RETURNS_PSEUDO_SOURCE, [SELLER, OTHER_SELLER, acct(3)], W.initial.from, D1, 0),
    { sourceId: "x", sellerOrVendorIds: ["b", "a"], columns: ["c"], from: "2026-09-01T00:00:00Z", to: "2026-09-02", groupBy: ["c"],
      aggregations: [{ column: "q", aggregation: "SUM", alias: "q_sum" }, { column: "a", aggregation: "sum", alias: "a_sum" }], limit: 5, skip: 3, outputType: "json", orderByColumn: "date", orderByDirection: "asc" },
    {}];
  for (const b of bodies) {
    assert.equal(M.returnsRequestIdentity(b), R.exportRequestIdentity(b), "identity mirror drifted from the ASIN runner");
    assert.equal(M.returnsRequestHash(b), sha(R.exportRequestIdentity(b)));
    assert.match(M.returnsRequestHash(b), /^[0-9a-f]{64}$/);
  }
  const swapped = AS.buildAdsExportRequestBody(M.RETURNS_PSEUDO_SOURCE, [OTHER_SELLER, SELLER], W.rolling.from, D1, 0);
  const straight = AS.buildAdsExportRequestBody(M.RETURNS_PSEUDO_SOURCE, [SELLER, OTHER_SELLER], W.rolling.from, D1, 0);
  assert.equal(M.returnsRequestHash(swapped), M.returnsRequestHash(straight));
  const listed = { ...straight, id: "e0000009", status: "COMPLETED", createdAt: NOW, from: W.rolling.from + "T00:00:00.000Z", to: D1 + "T00:00:00.000Z" };
  assert.equal(M.returnsRequestHash(listed), M.returnsRequestHash(straight), "a listed (adoptable) export hashes like the body that created it");
  const hashes = new Set([straight, { ...straight, from: W.initial.from }, { ...straight, to: "2026-10-03" }, { ...straight, limit: 49999 },
    { ...straight, columns: straight.columns.slice(0, 23) }, { ...straight, sellerOrVendorIds: [SELLER] }].map(M.returnsRequestHash));
  assert.equal(hashes.size, 6);
});

// ================================================ B. windows, D-1, operator as-of ================================================
test("B1 DESIGN 2 examples: D1 2026-10-03 and 2026-11-01 (month rollover) exactly; 60 / 14 days inclusive", () => {
  assert.deepEqual(M.returnsWindows("2026-10-03"), { initial: { from: "2026-08-05", to: "2026-10-03", days: 60 }, rolling: { from: "2026-09-20", to: "2026-10-03", days: 14 } });
  assert.deepEqual(M.returnsWindows("2026-11-01"), { initial: { from: "2026-09-03", to: "2026-11-01", days: 60 }, rolling: { from: "2026-10-19", to: "2026-11-01", days: 14 } });
  for (const d of ["2026-10-03", "2026-11-01", "2026-03-01", "2028-03-01", "2026-01-01"]) {
    const w = M.returnsWindows(d);
    assert.equal(daysIn(w.initial.from, w.initial.to), 60); assert.equal(daysIn(w.rolling.from, w.rolling.to), 14);
  }
});
test("B2 year rollover + the third DESIGN example: [D1-59, D1] is 60 days (D1 2026-03-01 -> 2026-01-01; the doc's 2025-12-31 would be 61 days)", () => {
  const mar = M.returnsWindows("2026-03-01");
  assert.deepEqual(mar.rolling, { from: "2026-02-16", to: "2026-03-01", days: 14 }, "rolling as documented");
  assert.deepEqual(mar.initial, { from: "2026-01-01", to: "2026-03-01", days: 60 }, "the formula, not the doc's off-by-one example");
  assert.equal(daysIn("2025-12-31", "2026-03-01"), 61);
  assert.deepEqual(M.returnsWindows("2026-02-28").initial, { from: "2025-12-31", to: "2026-02-28", days: 60 }, "initial window crossing the year");
  assert.deepEqual(M.returnsWindows("2026-01-10").rolling, { from: "2025-12-28", to: "2026-01-10", days: 14 }, "rolling window crossing the year");
  assert.equal(M.returnsWindows("2026-01-10").initial.from, "2025-11-12");
  assert.equal(M.returnsWindows("2028-03-01").initial.from, "2028-01-02", "leap year");
  for (const bad of ["2026-02-30", "2026-10-4", "20261004", null, undefined, "2026-10-04T00:00:00Z"]) assert.throws(() => M.returnsWindows(bad), TypeError);
});
test("B3 accountD1 per marketplace at the scheduled 03:07 / 08:37 / 16:37 UTC: only the Americas trail at 03:07; never after the region as-of", () => {
  const at = (iso, mkt, asOf = "2026-10-04") => M.accountD1({ regionAsOf: asOf, marketplace: mkt, now: new Date(iso) });
  const all = ["IN", "GB", "UK", "DE", "FR", "IT", "ES", "NL", "BE", "PL", "SE", "AU", "US", "CA", "MX"];
  for (const m of all) {
    const americas = ["US", "CA", "MX"].includes(m);
    assert.equal(at("2026-10-05T03:07:00Z", m), americas ? "2026-10-03" : "2026-10-04", "india window " + m);
    assert.equal(at("2026-10-05T08:37:00Z", m), "2026-10-04", "europe-au window " + m);
    assert.equal(at("2026-10-05T16:37:00Z", m), "2026-10-04", "us-ca window " + m);
    assert.equal(at("2026-10-05T16:37:00Z", m, "2026-10-03"), "2026-10-03", "capped by an earlier region as-of " + m);
  }
  assert.equal(at("2026-10-05T08:37:00Z", "uk"), at("2026-10-05T08:37:00Z", "GB"), "UK is the GB business day");
  assert.equal(M.accountD1({ regionAsOf: "2026-10-04", marketplace: "IN", now: Date.parse("2026-10-05T03:07:00Z") }), "2026-10-04", "epoch ms accepted");
  assert.throws(() => M.accountD1({ regionAsOf: "2026-10-4", marketplace: "IN" }), TypeError);
  assert.throws(() => M.accountD1({ regionAsOf: "2026-10-04", marketplace: "IN", now: "not a time" }), TypeError);
});
test("B4 accountD1 at a LATE operator time (01:30 UTC, as-of = UTC D-1): Asia/Europe/AU reach the as-of, the Americas stay a day behind", () => {
  const at = (mkt) => M.accountD1({ regionAsOf: "2026-10-05", marketplace: mkt, now: new Date("2026-10-06T01:30:00Z") });
  for (const m of ["IN", "GB", "DE", "PL", "AU"]) assert.equal(at(m), "2026-10-05", m);
  for (const m of ["US", "CA", "MX"]) assert.equal(at(m), "2026-10-04", m + " local day is still 2026-10-05 -> its D-1 is 2026-10-04");
  assert.equal(M.validateOperatorAsOf("2026-10-05", new Date("2026-10-06T01:30:00Z")).ok, true, "that operator as-of is in range");
});
test("B5 validateOperatorAsOf: an operator paid run's --as-of must be in [todayUTC-3, todayUTC-1]", () => {
  const now = new Date("2026-10-05T12:00:00Z");
  assert.deepEqual(M.validateOperatorAsOf("2026-10-02", now), { ok: true });
  assert.deepEqual(M.validateOperatorAsOf("2026-10-03", now), { ok: true });
  assert.deepEqual(M.validateOperatorAsOf("2026-10-04", now), { ok: true });
  assert.deepEqual(M.validateOperatorAsOf("2026-10-01", now), { ok: false, code: "RETURNS_ASOF_OUT_OF_RANGE", reason: "too-old", from: "2026-10-02", to: "2026-10-04" });
  assert.deepEqual(M.validateOperatorAsOf("2026-10-05", now), { ok: false, code: "RETURNS_ASOF_OUT_OF_RANGE", reason: "too-recent", from: "2026-10-02", to: "2026-10-04" });
  for (const bad of ["2026-10-4", "2026-02-30", null, undefined, 20261004, "2026-10-04T00:00:00Z"]) {
    const r = M.validateOperatorAsOf(bad, now);
    assert.equal(r.ok, false); assert.equal(r.code, "RETURNS_ASOF_OUT_OF_RANGE"); assert.equal(r.reason, "malformed");
  }
  assert.equal(M.validateOperatorAsOf("2026-10-02", new Date("2026-10-05T23:59:59.999Z")).ok, true, "same UTC day until midnight");
  assert.equal(M.validateOperatorAsOf("2026-10-02", new Date("2026-10-06T00:00:00.000Z")).ok, false, "the window moves at UTC midnight");
  assert.equal(M.validateOperatorAsOf("2026-10-05", new Date("2026-10-06T00:00:00.000Z")).ok, true);
});

// ================================================ C. mode decision + coverage gap ================================================
const covOk = (windows) => ({ windows, read: "ok", error: null });
const FULL = covOk([{ from: W.initial.from, to: D1 }]);
const st = (o = {}) => ({ organization_fingerprint: "f", connection_id: "primary", account_id: SELLER, marketplace_country_code: "GB",
  initial_status: "complete", initial_window_from: "2026-08-05", initial_window_to: "2026-10-03", last_mode: "rolling",
  last_window_from: W.rolling.from, last_window_to: D1, last_status: "succeeded", last_success_at: "2026-10-04T09:00:00Z",
  legacy_fence: true, identity_status: "clear", hold_reason: null, identity_detail: {}, ...o });
const mode = (state, coverage = FULL) => M.decideAccountMode({ d1: D1, state, coverage });

test("C1 unreadable coverage / state -> pending (excluded, zero creates); unreadable wins over a hold", () => {
  for (const c of [{ windows: [], read: "read-failed", error: "SOURCE_COVERAGE_READ_FAILED" }, { windows: [], read: "schema-missing" }, { read: "error" }, { read: "missing" }, { read: "ok" }, null, undefined, "ok"]) {
    assert.deepEqual(M.decideAccountMode({ d1: D1, state: st(), coverage: c }), { kind: "pending", window: null, reason: "RETURNS_COVERAGE_UNREADABLE", gapDays: 0 });
  }
  assert.deepEqual(M.decideAccountMode({ d1: D1, state: null }), { kind: "pending", window: null, reason: "RETURNS_COVERAGE_UNREADABLE", gapDays: 0 }, "an omitted coverage read is unreadable, never 'no coverage'");
  for (const s of [{ read: "error" }, { read: "missing" }, { read: "ok", rows: [] }, "row", 7, []]) {
    assert.deepEqual(mode(s), { kind: "pending", window: null, reason: "RETURNS_STATE_UNREADABLE", gapDays: 0 });
  }
  assert.equal(mode(st({ hold_reason: "RETURNS_IDENTITY_AMBIGUOUS" }), { read: "read-failed", windows: [] }).kind, "pending");
});
test("C2 an invalid state row fails closed -> pending RETURNS_STATE_INVALID", () => {
  for (const s of [st({ initial_status: "weird" }), st({ initial_status: null }), st({ last_status: "bogus" }), st({ initial_status: "loaded", last_status: "replaced", last_window_from: null }),
    st({ last_status: "replaced", last_window_from: "2026-10-04", last_window_to: "2026-09-21" })]) {
    assert.equal(mode(s).kind, "pending"); assert.equal(mode(s).reason, "RETURNS_STATE_INVALID");
  }
});
test("C3 hold_reason set -> held: excluded with ZERO creates whatever the status (reported every run until the owner clears it)", () => {
  for (const s of [st({ initial_status: "loaded", last_status: "succeeded", hold_reason: "RETURNS_IDENTITY_AMBIGUOUS" }),
    st({ initial_status: "loaded", last_status: "replaced", hold_reason: "RETURNS_IDENTITY_AMBIGUOUS" }),
    st({ initial_status: "pending", last_status: null, hold_reason: "RETURNS_IDENTITY_AMBIGUOUS" })]) {
    assert.deepEqual(mode(s), { kind: "held", window: null, reason: "RETURNS_IDENTITY_AMBIGUOUS", gapDays: 0 });
  }
  const rollingHeld = mode(st({ hold_reason: "RETURNS_IDENTITY_AMBIGUOUS" }), covOk([{ from: W.rolling.from, to: D1 }]));
  assert.deepEqual(rollingHeld, { kind: "held", window: null, reason: "RETURNS_IDENTITY_AMBIGUOUS", gapDays: 46 }, "a held COMPLETE account still reports its gap");
  assert.equal(mode(st({ hold_reason: "owner said: stop!" })).reason, "RETURNS_HOLD", "a non-code hold value is never echoed");
});
test("C4 no state / initial 'pending' -> initial [D1-59, D1] (new-account onboarding; a failed verify re-loads)", () => {
  const want = { kind: "initial", window: { from: W.initial.from, to: D1 }, reason: null, gapDays: 0 };
  assert.deepEqual(mode(null), want);
  assert.deepEqual(mode(undefined), want);
  assert.deepEqual(mode(null, covOk([])), want);
  assert.deepEqual(mode(st({ initial_status: "pending", last_status: "failed" })), want);
  assert.deepEqual(mode(st({ initial_status: "pending", last_status: null, last_window_from: null, last_window_to: null })), want);
});
test("C5 last 'replaced' (no hold) -> reverify the RECORDED window first (zero tokens); initial 'loaded' with NO pending confirm and no hold -> initial (never a stuck pending)", () => {
  const rec = { from: "2026-08-05", to: "2026-10-03" };
  assert.deepEqual(mode(st({ initial_status: "loaded", last_mode: "initial", last_status: "replaced", last_window_from: rec.from, last_window_to: rec.to })),
    { kind: "reverify", window: rec, reason: "RETURNS_REVERIFY", gapDays: 0 });
  // A confirm only acts on last_status 'replaced' (else 'superseded', no change), so re-verifying a 'loaded' account whose
  // last attempt is anything else could never resolve it: it re-loads instead.
  const fresh = { kind: "initial", window: { from: W.initial.from, to: D1 }, reason: null, gapDays: 0 };
  for (const last of ["succeeded", "failed", null]) {
    assert.deepEqual(mode(st({ initial_status: "loaded", last_mode: "initial", last_status: last, last_window_from: rec.from, last_window_to: rec.to })), fresh, "loaded + last " + last);
  }
  assert.deepEqual(mode(st({ initial_status: "loaded", last_status: "succeeded", last_window_from: null, last_window_to: null })), fresh, "no recorded window needed for a re-load");
  const crashed = mode(st({ last_status: "replaced", last_window_from: "2026-09-20", last_window_to: "2026-10-03" }));
  assert.deepEqual(crashed, { kind: "reverify", window: { from: "2026-09-20", to: "2026-10-03" }, reason: "RETURNS_REVERIFY", gapDays: 0 }, "a rolling crash between replace and confirm");
});
test("C6 complete AND coverage proves [D1-13, D1] AND last 'succeeded' AND last_window_to >= D1 -> skipped-current (zero creates)", () => {
  assert.deepEqual(mode(st()), { kind: "skipped-current", window: null, reason: null, gapDays: 0 });
  assert.equal(mode(st({ last_window_to: "2026-10-05" })).kind, "skipped-current", "a later recorded end still proves D1");
  assert.equal(mode(st(), covOk([{ from: W.initial.from, to: "2026-09-19" }, { from: "2026-09-21", to: D1 }])).kind, "skipped-current", "a hole OLDER than the rolling window does not force a refresh");
});
test("C7 complete otherwise -> rolling [D1-13, D1], never wider (NO catch-up, whatever the gap)", () => {
  const roll = { from: W.rolling.from, to: D1 };
  assert.deepEqual(mode(st({ last_window_to: "2026-10-03" })), { kind: "rolling", window: roll, reason: null, gapDays: 0 });
  assert.deepEqual(mode(st({ last_status: "failed" })).window, roll);
  assert.deepEqual(mode(st({ last_status: null })).window, roll);
  assert.equal(mode(st(), covOk([{ from: W.initial.from, to: "2026-09-20" }, { from: "2026-09-22", to: D1 }])).kind, "rolling", "a hole INSIDE the rolling window");
  const gappy = mode(st({ last_window_to: "2026-09-10" }), covOk([{ from: "2026-08-25", to: "2026-09-04" }]));
  assert.deepEqual(gappy, { kind: "rolling", window: roll, reason: null, gapDays: 35 }, "35 uncovered older days are REPORTED, the window stays 14 days");
  assert.equal(daysIn(gappy.window.from, gappy.window.to), 14);
});
test("C8 coverageGapDays counts the days of [D1-59, D1-14] not proven by the union of coverage windows", () => {
  const g = (windows) => M.coverageGapDays({ windows, d1: D1 });
  assert.equal(g([]), 46); assert.equal(g(undefined), 46);
  assert.equal(g([{ from: W.rolling.from, to: D1 }]), 46);
  assert.equal(g([{ from: W.initial.from, to: D1 }]), 0);
  assert.equal(g([{ from: "2026-01-01", to: "2026-12-31" }]), 0);
  assert.equal(g([{ from: "2026-08-06", to: "2026-08-24" }, { from: "2026-08-30", to: D1 }]), 5, "a 5-day hole");
  assert.equal(g([{ from: "2026-08-06", to: "2026-09-04" }, { from: "2026-09-05", to: D1 }]), 0, "touching windows are contiguous");
  assert.equal(g([{ from: "2026-09-01", to: D1 }, { from: "2026-08-06", to: "2026-09-15" }]), 0, "overlapping + unsorted");
  assert.equal(g([{ from: "2026-08-06", to: "2026-09-19" }, { from: "2026-09-21", to: D1 }]), 1, "D1-14 itself is in the gap range");
  assert.equal(g([{ from: "2026-08-06", to: "2026-09-20" }, { from: "2026-09-22", to: D1 }]), 0, "D1-13 belongs to the rolling window, not the gap");
  assert.equal(g([{ from: "2026-08-06", to: "2026-13-01" }, { from: null, to: D1 }, { from: "2026-09-10", to: "2026-09-01" }, null]), 46, "malformed windows prove nothing");
  assert.throws(() => M.coverageGapDays({ windows: [], d1: "bad" }), TypeError);
});

// ================================================ D. normalization ================================================
test("D1 marketplace: trimmed, upper-cased, UK -> GB (row and account sides alike)", () => {
  assert.equal(M.normalizeMarketplace("UK"), "GB"); assert.equal(M.normalizeMarketplace(" uk "), "GB"); assert.equal(M.normalizeMarketplace("gb"), "GB");
  assert.equal(M.normalizeMarketplace("DE"), "DE"); assert.equal(M.normalizeMarketplace(null), ""); assert.equal(M.normalizeMarketplace(undefined), "");
  assert.equal(ev(fbaRow({ marketplace_country_code: "UK" })).marketplace_country_code, "GB");
  assert.equal(ev(fbaRow({ marketplace_country_code: " de " })).marketplace_country_code, "DE");
});
test("D2 canonicalDecimal: exact strings, no exponent / trailing zeros / '+', -0 -> 0; blank -> null; garbage -> undefined", () => {
  const cases = [["12.50", "12.5"], [12.5, "12.5"], ["-0", "0"], [-0, "0"], ["0.000", "0"], ["-0.00", "0"], ["1e21", "1000000000000000000000"], [1e21, "1000000000000000000000"],
    [5e-7, "0.0000005"], ["1.5E-3", "0.0015"], ["+3.10", "3.1"], [".5", "0.5"], ["5.", "5"], ["007", "7"], ["-12.340", "-12.34"], [" 4 ", "4"],
    ["123456789012345678901234567890.123456789", "123456789012345678901234567890.123456789"], [0.1 + 0.2, "0.30000000000000004"], [10n, "10"],
    [null, null], [undefined, null], ["", null], ["   ", null]];
  for (const [input, want] of cases) assert.equal(M.canonicalDecimal(input), want, "canonicalDecimal(" + String(input) + ")");
  for (const bad of ["abc", "1,234", "0x10", "1e", ".", "-", "+", "1.2.3", "Infinity", "NaN", NaN, Infinity, -Infinity, true, false, {}, [], "1e99999"]) {
    assert.equal(M.canonicalDecimal(bad), undefined, "invalid: " + String(bad));
  }
});
test("D3 null vs '': nullable text '' -> null; not-null text null -> ''; every text trimmed; numeric ids become text", () => {
  const e = ev(fbaRow({ fnsku: "  ", amazon_return_detailed_disposition: "", amazon_return_rmaid: "", amazon_return_seller_rmaid: " ", amazon_return_label_to_be_paid_by: "",
    amazon_license_plate_number: " LPN0000000001 ", sku: null, child_asin: undefined, amazon_return_reason: "  ", amazon_return_request_status: null, cogs_currency: "", order_date: "" }));
  assert.equal(e.fnsku, null); assert.equal(e.detailed_disposition, null); assert.equal(e.rma_id, null); assert.equal(e.seller_rma_id, null); assert.equal(e.label_paid_by, null);
  assert.equal(e.license_plate_number, "LPN0000000001");
  assert.equal(e.sku, ""); assert.equal(e.child_asin, ""); assert.equal(e.amazon_return_reason, ""); assert.equal(e.request_status, "");
  assert.equal(e.cogs_currency, null); assert.equal(e.order_date, null);
  assert.equal(ev(fbmRow({ amazon_return_rmaid: 123456789 })).rma_id, "123456789");
  const f = ev(fbmRow({ amazon_return_refunded_amount: "-12.50", amazon_return_label_cost: 3.1, cogs_item_value: null, cogs_shipping_value: "", cogs_total_value: "0.000" }));
  assert.equal(f.refunded_amount, "-12.5"); assert.equal(f.label_cost, "3.1"); assert.equal(f.cogs_item_value, null); assert.equal(f.cogs_shipping_value, null); assert.equal(f.cogs_total_value, "0");
});
test("D4 channel-only fields on the other channel are anomaly COUNTS (per the live spec), never failures; LPN_BLANK only on FBA", () => {
  assert.deepEqual(norm(fbaRow()).anomalies, []);
  assert.deepEqual(norm(fbmRow()).anomalies, []);
  assert.deepEqual(norm(fbmRow({ fnsku: "X000000001" })).anomalies, ["FBA_ONLY_ON_FBM"]);
  assert.deepEqual(norm(fbmRow({ fnsku: "X000000001", amazon_return_detailed_disposition: "SELLABLE" })).anomalies, ["FBA_ONLY_ON_FBM"], "once per row");
  for (const o of [{ amazon_return_rmaid: "RMA0000000001" }, { amazon_return_seller_rmaid: "S1" }, { order_date: "2026-09-01" }, { amazon_return_refunded_amount: 0 }, { amazon_return_label_cost: "1.00" }]) {
    assert.deepEqual(norm(fbaRow(o)).anomalies, ["FBM_ONLY_ON_FBA"], Object.keys(o)[0]);
  }
  assert.deepEqual(norm(fbaRow({ amazon_license_plate_number: "" })).anomalies, ["LPN_BLANK"]);
  assert.deepEqual(norm(fbaRow({ amazon_license_plate_number: null })).anomalies, ["LPN_BLANK"]);
  assert.deepEqual(norm(fbmRow({ amazon_license_plate_number: "" })).anomalies, [], "FBM rows carry no LPN");
  assert.deepEqual(norm(fbaRow({ amazon_return_label_to_be_paid_by: "Customer" })).anomalies, [], "the label payer has no channel note in the spec");
});
test("D5 quantity: integer >= 1 valid; null/'' -> null (QUANTITY_NULL), 0 kept (QUANTITY_ZERO); negative / fraction / > 9 digits / non-numeric -> RETURNS_QUANTITY_INVALID", () => {
  const q = (v) => norm(fbaRow({ quantity: v }));
  assert.equal(q(1).event.quantity, 1); assert.deepEqual(q(1).anomalies, []);
  assert.equal(q("2").event.quantity, 2); assert.equal(q("2.0").event.quantity, 2); assert.equal(q(7).event.quantity, 7);
  assert.equal(q(null).event.quantity, null); assert.deepEqual(q(null).anomalies, ["QUANTITY_NULL"]);
  assert.equal(q(undefined).event.quantity, null); assert.equal(q("").event.quantity, null);
  assert.equal(q(0).event.quantity, 0); assert.deepEqual(q(0).anomalies, ["QUANTITY_ZERO"]);
  assert.equal(q("-0").event.quantity, 0);
  for (const bad of [-1, "-3", 1.5, "0.5", 1000000000, 2147483647, "1e10", true, "abc", {}, NaN]) assert.equal(code(fbaRow({ quantity: bad })), "RETURNS_QUANTITY_INVALID", "quantity " + String(bad));
  assert.equal(q(999999999).event.quantity, 999999999, "the RPC's 9-digit bound is the last valid quantity");
});
test("D5b persistence bounds mirror the replace RPC: money/COGS <= 24 integer + <= 30 fraction digits (exact, never rounded), order_date 1900..2099, well-formed text", () => {
  assert.equal(ev(fbmRow({ cogs_total_value: "123456789012345678901234.123456789012" })).cogs_total_value, "123456789012345678901234.123456789012");
  assert.equal(ev(fbmRow({ cogs_total_value: "-0.000000000001" })).cogs_total_value, "-0.000000000001");
  // A computed COGS float artifact (DataDoe: unit cost x quantity) persists EXACTLY -- one such row never fails its account.
  assert.equal(ev(fbmRow({ cogs_item_value: 3 * 1.1 })).cogs_item_value, "3.3000000000000003");
  assert.equal(ev(fbmRow({ cogs_item_value: 0.1 + 0.2 })).cogs_item_value, "0.30000000000000004");
  assert.equal(ev(fbmRow({ cogs_item_value: "0.1234567890123" })).cogs_item_value, "0.1234567890123");
  assert.equal(ev(fbmRow({ cogs_item_value: "0." + "1".repeat(30) })).cogs_item_value, "0." + "1".repeat(30));
  for (const bad of ["0." + "1".repeat(31), "1234567890123456789012345"]) {
    assert.equal(code(fbmRow({ cogs_item_value: bad })), "RETURNS_NUMERIC_INVALID", "out of the RPC's numeric bound: " + String(bad));
  }
  assert.equal(M.canonicalDecimal(3 * 1.1), "3.3000000000000003", "canonicalDecimal itself stays exact (the bound is a persistence rule)");
  assert.equal(code(fbmRow({ order_date: "2100-01-01" })), "RETURNS_DATE_INVALID");
  assert.equal(ev(fbmRow({ order_date: "2099-12-31" })).order_date, "2099-12-31");
  assert.equal(code(fbaRow({ sku: "SKU-\uD800" })), "RETURNS_TEXT_INVALID", "a lone surrogate cannot enter jsonb");
  assert.equal(ev(fbaRow({ amazon_return_reason: "R\u{1F600}" })).amazon_return_reason, "R\u{1F600}", "a well-formed astral character is fine");
});
test("D6 currencies + cogs_present + dates + channel + order id + text + fragment metadata: each failure is typed", () => {
  assert.equal(ev(fbaRow({ cogs_currency: "eur" })).cogs_currency, "EUR");
  assert.equal(ev(fbaRow({ cogs_currency: null })).cogs_currency, null);
  for (const bad of ["EURO", "E1R", "\u20ac", 978, true]) assert.equal(code(fbaRow({ cogs_currency: bad })), "RETURNS_CURRENCY_INVALID");
  for (const [v, want] of [[true, true], [false, false], ["true", true], [" FALSE ", false], [1, true], [0, false], ["1", true], ["0", false]]) assert.equal(ev(fbaRow({ cogs_present: v })).cogs_present, want);
  for (const bad of [null, undefined, "yes", 2, {}]) assert.equal(code(fbaRow({ cogs_present: bad })), "RETURNS_COGS_PRESENT_INVALID");
  for (const bad of ["2026-02-30", "2026-10-03T00:00:00Z", "10/03/2026", null, "", 20261003]) assert.equal(code(fbaRow({ date: bad })), "RETURNS_DATE_INVALID", "date " + String(bad));
  assert.equal(code(fbmRow({ order_date: "2026-13-01" })), "RETURNS_DATE_INVALID");
  assert.equal(ev(fbmRow({ order_date: " 2026-09-20 " })).order_date, "2026-09-20");
  for (const bad of ["fba", "AFN", "", null, "FBA/FBM"]) assert.equal(code(fbaRow({ amazon_fulfillment_channel: bad })), "RETURNS_CHANNEL_INVALID");
  assert.equal(ev(fbaRow({ amazon_fulfillment_channel: " FBA " })).fulfillment_channel, "FBA");
  for (const bad of ["", "   ", null]) assert.equal(code(fbaRow({ amazon_order_id: bad })), "RETURNS_ORDER_ID_MISSING");
  assert.equal(code(fbaRow({ amazon_order_id: "9".repeat(65) })), "RETURNS_TEXT_INVALID", "an order id is at most 64 chars");
  assert.equal(code(fbaRow({ amazon_order_id: { id: 1 } })), "RETURNS_TEXT_INVALID");
  for (const [k, bad] of [["sku", {}], ["amazon_return_reason", "r".repeat(513)], ["sku", "a\u0000b"], ["amazon_license_plate_number", ["x"]], ["seller_or_vendor_id", true]]) {
    assert.equal(code(fbaRow({ [k]: bad })), "RETURNS_TEXT_INVALID", k);
  }
  for (const [k, bad] of [["amazon_return_refunded_amount", "abc"], ["amazon_return_label_cost", true], ["cogs_total_value", "1,5"], ["cogs_item_value", {}]]) {
    assert.equal(code(fbmRow({ [k]: bad })), "RETURNS_NUMERIC_INVALID", k);
  }
  for (const bad of [null, "x", [], 5]) assert.equal(M.normalizeReturnsRow(bad, META_A).code, "RETURNS_ROW_NOT_OBJECT");
  for (const meta of [undefined, {}, { sourceRequestHash: H1.toUpperCase() }, { sourceRequestHash: "abc" }, { sourceRequestHash: H1, exportId: "" },
    { sourceRequestHash: H1, exportId: "e".repeat(129) }, { sourceRequestHash: H1, exportId: 42 }]) {
    assert.equal(M.normalizeReturnsRow(fbaRow(), meta).code, "RETURNS_FRAGMENT_UNKNOWN");
  }
  const e = ev(fbaRow(), { sourceRequestHash: H2, exportId: " e0000002 " });
  assert.equal(e.source_request_hash, H2); assert.equal(e.export_id, "e0000002");
  assert.equal(ev(fbaRow(), { sourceRequestHash: H2 }).export_id, null, "export_id null is allowed (an adopted export always has one; the RPC accepts null)");
});
const REQUIRED_12 = ["seller_or_vendor_id", "marketplace_country_code", "date", "sku", "child_asin", "amazon_order_id", "quantity", "amazon_return_reason",
  "amazon_fulfillment_channel", "amazon_return_request_status", "cogs_present", "amazon_license_plate_number"];
test("D7 page shape vs nullable columns: ONLY the 12 not-null spec columns must be own properties (RETURNS_SHAPE_SOURCE); an ABSENT nullable column normalizes as null (own properties only -- an inherited value is never read)", () => {
  assert.deepEqual([...M.RETURNS_REQUIRED_COLUMNS], REQUIRED_12);
  assert.ok(Object.isFrozen(M.RETURNS_REQUIRED_COLUMNS) && Object.isFrozen(M.RETURNS_SHAPE_SOURCE));
  assert.ok(M.RETURNS_REQUIRED_COLUMNS.every((c) => M.RETURNS_EVENT_COLUMNS.includes(c)), "a subset of the requested columns");
  assert.equal(M.RETURNS_SHAPE_SOURCE.sourceId, M.RETURNS_SOURCE_ID); assert.equal(M.RETURNS_SHAPE_SOURCE.dimensions, M.RETURNS_REQUIRED_COLUMNS);
  assert.equal(M.RETURNS_SHAPE_SOURCE.aggregations, undefined); assert.equal(M.RETURNS_PSEUDO_SOURCE.dimensions.length, 24, "the REQUEST still asks every one of the 24 columns");
  const nullable = M.RETURNS_EVENT_COLUMNS.filter((c) => !REQUIRED_12.includes(c));
  assert.equal(nullable.length, 12);
  const sparse = fbmRow(); for (const c of nullable) delete sparse[c];
  const e = ev(sparse);
  for (const f of ["order_date", "fnsku", "detailed_disposition", "rma_id", "seller_rma_id", "label_paid_by", "refunded_amount", "label_cost",
    "cogs_item_value", "cogs_shipping_value", "cogs_total_value", "cogs_currency"]) assert.equal(e[f], null, f + " absent -> null");
  assert.equal(e.event_key, ev(fbmRow(Object.fromEntries(nullable.map((c) => [c, null])))).event_key, "absent == explicit null (same event_key)");
  const page = (rows) => ({ status: "COMPLETED", rowCount: rows.length, rows, loadingNotice: null, dataSourceIssues: [] });
  assert.equal(AS.validateSplitWindowPage(page([sparse]), W.rolling.from, D1, M.RETURNS_SHAPE_SOURCE).length, 1, "a missing NULLABLE column passes the shape check");
  for (const c of REQUIRED_12.filter((x) => x !== "date")) {
    const bad = fbaRow(); delete bad[c];
    assert.throws(() => AS.validateSplitWindowPage(page([bad]), W.rolling.from, D1, M.RETURNS_SHAPE_SOURCE), (x) => x.code === "ADS_EXPORT_SHAPE_MISMATCH", "missing " + c);
  }
  const inherited = Object.assign(Object.create({ fnsku: "X0INHERITED", cogs_currency: "EUR", amazon_return_rmaid: "RMAINHERITED", amazon_return_refunded_amount: "9.99" }), fbaRow());
  for (const c of ["fnsku", "cogs_currency", "amazon_return_rmaid", "amazon_return_refunded_amount"]) delete inherited[c];
  const ie = ev(inherited);
  assert.deepEqual([ie.fnsku, ie.cogs_currency, ie.rma_id, ie.refunded_amount], [null, null, null, null], "an inherited (non-own) value is absent");
  assert.deepEqual(norm(inherited).anomalies, [], "and raises no channel anomaly");
});

// ================================================ E. event_key + occurrences ================================================
test("E1 event_key = sha256 hex of JSON.stringify(the 24 canonical values in RETURNS_EVENT_COLUMNS order) (CONTRACT B)", () => {
  const e = ev(fbaRow());
  const values = [SELLER, "GB", "2026-09-30", null, "SKU-1", "B000000001", "X000000001", ORDER1, "1", "UNWANTED_ITEM", "FBA",
    "Unit returned to inventory", "SELLABLE", null, null, null, null, null, "4.2", "0.5", "4.7", "GBP", true, "LPN0000000001"];
  assert.deepEqual(M.eventKeyValues(e), values);
  assert.equal(e.event_key, sha(JSON.stringify(values)));
  assert.equal(M.eventKey(e), e.event_key);
  assert.match(e.event_key, /^[0-9a-f]{64}$/);
});
test("E2 event_key is STABLE across equivalent encodings and across fragments (the export metadata never enters the key)", () => {
  const base = ev(fbaRow()).event_key;
  const variants = [
    fbaRow({ sku: " SKU-1 ", amazon_return_reason: "UNWANTED_ITEM  ", amazon_license_plate_number: " LPN0000000001" }),
    fbaRow({ cogs_item_value: 4.2, cogs_shipping_value: "0.500", cogs_total_value: 4.7 }),
    fbaRow({ marketplace_country_code: "UK" }), fbaRow({ marketplace_country_code: " gb" }),
    fbaRow({ quantity: "1" }), fbaRow({ quantity: "1.0" }),
    fbaRow({ cogs_present: "true" }), fbaRow({ cogs_present: 1 }), fbaRow({ cogs_currency: "gbp" }),
    fbaRow({ order_date: "" }), fbaRow({ amazon_return_rmaid: "" }), fbaRow({ amazon_return_label_to_be_paid_by: "  " }),
  ];
  for (const v of variants) assert.equal(ev(v).event_key, base);
  assert.equal(ev(fbaRow(), META_B).event_key, base, "another fragment / export id -> same key");
  assert.equal(ev(fbaRow({ sku: null })).event_key, ev(fbaRow({ sku: "" })).event_key, "not-null text: null and '' are both ''");
});
test("E3 event_key is SENSITIVE to every one of the 24 columns", () => {
  const changes = {
    seller_or_vendor_id: OTHER_SELLER, marketplace_country_code: "DE", date: "2026-09-29", order_date: "2026-09-01", sku: "SKU-2",
    child_asin: "B000000002", fnsku: "X000000002", amazon_order_id: "000-0000000-0000002", quantity: 2, amazon_return_reason: "DEFECTIVE",
    amazon_fulfillment_channel: "FBM", amazon_return_request_status: "Reimbursed", amazon_return_detailed_disposition: "CUSTOMER_DAMAGED",
    amazon_return_rmaid: "RMA9", amazon_return_seller_rmaid: "SRMA9", amazon_return_label_to_be_paid_by: "Customer",
    amazon_return_refunded_amount: "1.00", amazon_return_label_cost: "2", cogs_item_value: "4.21", cogs_shipping_value: "0.51",
    cogs_total_value: "4.71", cogs_currency: "EUR", cogs_present: false, amazon_license_plate_number: "LPN0000000002",
  };
  assert.deepEqual(Object.keys(changes), [...M.RETURNS_EVENT_COLUMNS], "one change per requested column");
  const keys = new Set([ev(fbaRow()).event_key]);
  for (const [col, v] of Object.entries(changes)) keys.add(ev(fbaRow({ [col]: v })).event_key);
  assert.equal(keys.size, 25, "every single-column change yields a distinct key");
});
test("E4 assignOccurrences: lossless, sorted by event_key (stable), occurrence 1..n per identical key, independent of row order, inputs untouched", () => {
  const A = fbaRow(); const B = fbaRow({ sku: "SKU-2" }); const C = fbmRow();
  const events = [A, B, A, C, A].map((r) => ev(r));
  const got = M.assignOccurrences(events);
  assert.equal(got.length, 5, "no row dropped or merged");
  const keyA = events[0].event_key;
  assert.deepEqual(got.filter((e) => e.event_key === keyA).map((e) => e.occurrence), [1, 2, 3]);
  assert.deepEqual(got.filter((e) => e.event_key !== keyA).map((e) => e.occurrence), [1, 1]);
  for (let i = 1; i < got.length; i += 1) assert.ok(got[i - 1].event_key <= got[i].event_key, "sorted by event_key");
  for (const e of events) assert.ok(!("occurrence" in e), "inputs are not mutated");
  const pk = new Set(got.map((e) => e.return_date + "|" + e.event_key + "|" + e.occurrence));
  assert.equal(pk.size, 5, "no duplicate (return_date, event_key, occurrence)");
  for (const order of [[4, 3, 2, 1, 0], [2, 0, 4, 1, 3], [1, 2, 3, 4, 0]]) {
    assert.deepEqual(M.assignOccurrences(order.map((i) => events[i])), got, "row order never changes the result");
  }
  const noKey = { ...events[1] }; delete noKey.event_key;
  assert.equal(M.assignOccurrences([noKey])[0].event_key, events[1].event_key, "a missing event_key is computed");
  assert.throws(() => M.assignOccurrences(null), TypeError);
});

// ================================================ F. identity (OD2, DESIGN 3.7) ================================================
const identityOf = (rows) => M.assessIdentity(rows.map((r) => ev(r)));
test("F1 clear: distinct LPNs for the same order/sku (two units), distinct RMAs, distinct unkeyed rows", () => {
  const r = identityOf([fbaRow(), fbaRow({ amazon_license_plate_number: "LPN0000000002" }), fbmRow(), fbmRow({ amazon_return_rmaid: "RMA0000000002" }),
    fbaRow({ amazon_license_plate_number: "", sku: "SKU-3" }), fbaRow({ amazon_license_plate_number: "", sku: "SKU-4" })]);
  assert.deepEqual(r, { status: "clear", detail: { keyedFba: 2, keyedFbm: 2, unkeyed: 2, keyCollisions: 0, cogsVariants: 0, identicalUnkeyed: 0 } });
});
test("F2 rule (a): one FBA (order, sku, LPN) on 2+ rows -- on different dates -- is AMBIGUOUS; every row is kept", () => {
  const rows = [fbaRow({ date: "2026-09-30" }), fbaRow({ date: "2026-10-01" })];
  assert.deepEqual(identityOf(rows), { status: "ambiguous", detail: { keyedFba: 2, keyedFbm: 0, unkeyed: 0, keyCollisions: 1, cogsVariants: 0, identicalUnkeyed: 0 } });
  const v = vrows(rows);
  assert.equal(v.ok, true, "an ambiguous account is still persisted"); assert.equal(v.events.length, 2); assert.equal(v.identity.status, "ambiguous");
});
test("F3 rule (a) for FBM (order, sku, Amazon RMA) and ACROSS channels (the channel is not part of the key)", () => {
  assert.equal(identityOf([fbmRow(), fbmRow({ amazon_return_request_status: "Closed" })]).detail.keyCollisions, 1);
  const cross = identityOf([fbaRow({ amazon_license_plate_number: "SAME0000001" }), fbmRow({ amazon_return_rmaid: "SAME0000001" })]);
  assert.equal(cross.status, "ambiguous"); assert.equal(cross.detail.keyCollisions, 1);
  assert.equal(identityOf([fbmRow(), fbmRow({ amazon_order_id: "000-0000000-0000009" })]).status, "clear", "same RMA text on another order is another unit");
});
test("F4 rule (b): rows equal on every non-COGS column but differing in COGS (join fan-out) are AMBIGUOUS", () => {
  const unkeyed = (o) => fbaRow({ amazon_license_plate_number: "", ...o });
  assert.deepEqual(identityOf([unkeyed({ cogs_total_value: "4.70" }), unkeyed({ cogs_total_value: "4.80" })]).detail,
    { keyedFba: 0, keyedFbm: 0, unkeyed: 2, keyCollisions: 0, cogsVariants: 1, identicalUnkeyed: 0 });
  assert.equal(identityOf([unkeyed({ cogs_present: true }), unkeyed({ cogs_present: false })]).detail.cogsVariants, 1);
  assert.equal(identityOf([unkeyed({ cogs_currency: "GBP" }), unkeyed({ cogs_currency: "EUR" })]).detail.cogsVariants, 1);
  const keyed = identityOf([fbaRow({ cogs_item_value: "1" }), fbaRow({ cogs_item_value: "2" })]).detail;
  assert.equal(keyed.cogsVariants, 1); assert.equal(keyed.keyCollisions, 1, "a keyed fan-out trips rule (a) too");
  assert.equal(identityOf([unkeyed({ cogs_total_value: "4.70" }), unkeyed({ cogs_total_value: "4.80", amazon_return_reason: "DEFECTIVE" })]).status, "clear", "a non-COGS difference is a different event");
});
test("F5 rule (c): 2+ value-identical UNKEYED rows are AMBIGUOUS; each keeps its own occurrence", () => {
  const blankLpn = fbaRow({ amazon_license_plate_number: "" });
  const v = vrows([blankLpn, { ...blankLpn }, { ...blankLpn }]);
  assert.equal(v.ok, true); assert.equal(v.events.length, 3);
  assert.deepEqual(v.events.map((e) => e.occurrence), [1, 2, 3]);
  assert.deepEqual(v.identity.detail, { keyedFba: 0, keyedFbm: 0, unkeyed: 3, keyCollisions: 0, cogsVariants: 0, identicalUnkeyed: 1 });
  assert.equal(identityOf([fbmRow({ amazon_return_rmaid: null }), fbmRow({ amazon_return_rmaid: "" })]).detail.identicalUnkeyed, 1, "FBM without an RMA is unkeyed");
  const keyedTwins = identityOf([fbaRow(), fbaRow()]).detail;
  assert.equal(keyedTwins.identicalUnkeyed, 0); assert.equal(keyedTwins.keyCollisions, 1, "identical KEYED rows are rule (a)");
});
test("F6 physicalKey: FBA uses the LPN, FBM the Amazon RMA (never the seller RMA); a sha256 digest, never the raw ids", () => {
  const k = M.physicalKey(ev(fbaRow()));
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.equal(k, sha(JSON.stringify([ORDER1, "SKU-1", "LPN0000000001"])));
  assert.notEqual(M.physicalKey(ev(fbaRow({ amazon_license_plate_number: "LPN0000000002" }))), k);
  assert.equal(M.physicalKey(ev(fbaRow({ amazon_license_plate_number: "" }))), null);
  assert.equal(M.physicalKey(ev(fbaRow({ amazon_license_plate_number: "", amazon_return_rmaid: "RMA0000000001" }))), null, "FBA is never keyed by an RMA");
  assert.equal(M.physicalKey(ev(fbmRow({ amazon_return_rmaid: null }))), null, "the seller RMA alone does not key an FBM row");
  assert.equal(M.physicalKey(ev(fbmRow())), sha(JSON.stringify([ORDER1, "SKU-1", "RMA0000000001"])));
  assert.equal(M.physicalKey({ fulfillment_channel: "X", license_plate_number: "L", rma_id: "R" }), null);
  assert.equal(M.physicalKey(null), null);
});

// ================================================ G. validateAccountRows ================================================
test("G1 success across two fragments: each event carries ITS fragment's hash + export id; counts, units, anomalies, identity", () => {
  const rows = [fbaRow({ date: "2026-09-22", quantity: 2, amazon_license_plate_number: "LPN-A1" }), fbaRow({ date: "2026-09-25", quantity: null, amazon_license_plate_number: "LPN-A2" }),
    fbmRow({ date: "2026-09-29", quantity: 0 }), fbmRow({ date: "2026-10-04", quantity: "3", amazon_return_rmaid: "RMA-B2" }),
    fbaRow({ date: "2026-10-01", amazon_license_plate_number: "" })];
  const v = vrows(rows, { fragmentOf: (row) => (row.date <= "2026-09-27" ? META_A : META_B) });
  assert.equal(v.ok, true);
  assert.equal(v.expectedCount, 5); assert.equal(v.expectedUnits, 6, "2 + 0 + 3 + 1; a null quantity adds nothing");
  assert.deepEqual(v.anomalies, { LPN_BLANK: 1, QUANTITY_NULL: 1, QUANTITY_ZERO: 1 });
  assert.deepEqual(v.identity, { status: "clear", detail: { keyedFba: 2, keyedFbm: 2, unkeyed: 1, keyCollisions: 0, cogsVariants: 0, identicalUnkeyed: 0 } });
  for (const e of v.events) {
    const m = e.return_date <= "2026-09-27" ? META_A : META_B;
    assert.equal(e.source_request_hash, m.sourceRequestHash); assert.equal(e.export_id, m.exportId); assert.equal(e.occurrence, 1);
  }
  assert.deepEqual(v.events, M.assignOccurrences(v.events), "events come back in assignOccurrences order");
  const units = v.events.reduce((t, e) => t + (e.quantity === null ? 0 : e.quantity), 0);
  assert.equal(units, v.expectedUnits);
});
test("G2 fragmentOf may be a function, a Map keyed by the row object or an index-aligned array; it is required", () => {
  const rows = [fbaRow(), fbmRow({ date: "2026-10-02" })];
  const metas = [META_A, META_B];
  const viaFn = vrows(rows, { fragmentOf: (_r, i) => metas[i] });
  assert.deepEqual(vrows(rows, { fragmentOf: new Map(rows.map((r, i) => [r, metas[i]])) }), viaFn);
  assert.deepEqual(vrows(rows, { fragmentOf: metas }), viaFn);
  assert.throws(() => vrows(rows, { fragmentOf: undefined }), TypeError);
  const missing = vrows(rows, { fragmentOf: [META_A] });
  assert.equal(missing.ok, false); assert.equal(missing.code, "RETURNS_FRAGMENT_UNKNOWN");
});
test("G3 ownership failures fail the ACCOUNT alone: seller, account binding, marketplace (UK == GB), window", () => {
  assert.equal(vrows([fbaRow(), fbaRow({ seller_or_vendor_id: OTHER_SELLER })]).code, "RETURNS_SELLER_MISMATCH");
  assert.equal(vrows([fbaRow()], { accountId: OTHER_SELLER }).code, "RETURNS_SELLER_MISMATCH", "primary binding: account = seller");
  assert.equal(vrows([fbaRow()], { accountId: "", sellerId: "" }).code, "RETURNS_SELLER_MISMATCH");
  assert.equal(vrows([fbaRow()], { accountId: "dd-secondary:" + SELLER }).ok, true, "dd-secondary binding");
  assert.equal(vrows([fbaRow({ marketplace_country_code: "DE" })]).code, "RETURNS_MARKETPLACE_MISMATCH");
  assert.equal(vrows([fbaRow({ marketplace_country_code: "UK" })]).ok, true);
  assert.equal(vrows([fbaRow({ marketplace_country_code: "GB" })], { marketplace: "UK" }).ok, true);
  for (const m of ["", null, "GBR", "G"]) assert.equal(vrows([fbaRow()], { marketplace: m }).code, "RETURNS_MARKETPLACE_MISMATCH");
  assert.equal(vrows([fbaRow({ date: "2026-09-20" })]).code, "RETURNS_ROW_OUTSIDE_WINDOW", "the day before the window");
  assert.equal(vrows([fbaRow({ date: "2026-10-05" })]).code, "RETURNS_ROW_OUTSIDE_WINDOW", "the day after D1");
  assert.equal(vrows([fbaRow({ date: W.rolling.from }), fbaRow({ date: D1, sku: "SKU-9" })]).ok, true, "both window edges are inside");
});
test("G4 normalize failures propagate: the FIRST failure in row order is the code, every failure is counted, nothing leaks", () => {
  const v = vrows([fbaRow(), fbaRow({ quantity: -1 }), fbaRow({ amazon_fulfillment_channel: "AFN" }), fbaRow({ quantity: 0.5 }), fbmRow({ quantity: null })]);
  assert.equal(v.ok, false); assert.equal(v.code, "RETURNS_QUANTITY_INVALID");
  assert.deepEqual(v.failures, { RETURNS_CHANNEL_INVALID: 1, RETURNS_QUANTITY_INVALID: 2 });
  assert.deepEqual(v.anomalies, { QUANTITY_NULL: 1 }, "anomalies of the valid rows are still counted");
  assert.equal(v.events, undefined, "a failed account hands back NO events (nothing to write)");
  assertRedacted(v, "validation failure");
  for (const [row, want] of [[null, "RETURNS_ROW_NOT_OBJECT"], [fbaRow({ date: "2026-02-30" }), "RETURNS_DATE_INVALID"], [fbaRow({ amazon_order_id: "" }), "RETURNS_ORDER_ID_MISSING"],
    [fbmRow({ amazon_return_label_cost: "x" }), "RETURNS_NUMERIC_INVALID"], [fbaRow({ cogs_currency: "EURO" }), "RETURNS_CURRENCY_INVALID"], [fbaRow({ cogs_present: null }), "RETURNS_COGS_PRESENT_INVALID"]]) {
    const r = vrows([row]);
    assert.equal(r.code, want); assertRedacted(r, want);
  }
});
test("G5 empty rows -> ok with zero events (proven-empty is the RPC's sudden-empty guard to judge); bad inputs throw", () => {
  assert.deepEqual(vrows([]), { ok: true, events: [], anomalies: {}, identity: { status: "clear", detail: { keyedFba: 0, keyedFbm: 0, unkeyed: 0, keyCollisions: 0, cogsVariants: 0, identicalUnkeyed: 0 } }, expectedCount: 0, expectedUnits: 0 });
  assert.throws(() => vrows(null), TypeError);
  assert.throws(() => vrows([], { from: D1, to: W.rolling.from }), TypeError);
  assert.throws(() => vrows([], { from: "2026-9-21" }), TypeError);
});
test("G6 COGS_CURRENCY_MIXED: an account whose rows carry 2+ distinct non-null cogs_currency values is counted ONCE (counts only; every row kept); one currency / nulls only -> no anomaly", () => {
  const mixed = vrows([fbaRow({ cogs_currency: "GBP" }), fbaRow({ amazon_license_plate_number: "LPN-2", cogs_currency: "EUR" }),
    fbaRow({ amazon_license_plate_number: "LPN-3", cogs_currency: "usd" }), fbaRow({ amazon_license_plate_number: "LPN-4", cogs_currency: null })]);
  assert.equal(mixed.ok, true); assert.equal(mixed.events.length, 4, "no row dropped");
  assert.equal(mixed.anomalies.COGS_CURRENCY_MIXED, 1, "one per account, whatever the number of currencies");
  assert.deepEqual(mixed.events.map((e) => e.cogs_currency).sort(), ["EUR", "GBP", "USD", null].sort(), "the currencies are stored as they came");
  const same = vrows([fbaRow({ cogs_currency: "GBP" }), fbaRow({ amazon_license_plate_number: "LPN-2", cogs_currency: " gbp " }), fbaRow({ amazon_license_plate_number: "LPN-3", cogs_currency: "" })]);
  assert.equal(same.ok, true); assert.equal(same.anomalies.COGS_CURRENCY_MIXED, undefined, "GBP + gbp + blank is ONE currency");
  assert.equal(vrows([fbaRow({ cogs_currency: null }), fbaRow({ amazon_license_plate_number: "LPN-2", cogs_currency: null })]).anomalies.COGS_CURRENCY_MIXED, undefined);
  const failedAcct = vrows([fbaRow({ cogs_currency: "GBP" }), fbaRow({ amazon_license_plate_number: "LPN-2", cogs_currency: "EUR" }), fbaRow({ quantity: -1 })]);
  assert.equal(failedAcct.ok, false); assert.equal(failedAcct.anomalies.COGS_CURRENCY_MIXED, 1, "counted over the valid rows of a failed account too");
  assert.ok(M.RETURNS_ANOMALY_CODES.includes("COGS_CURRENCY_MIXED"));
  assert.deepEqual(M.summarizeAnomalies(mixed.anomalies, same.anomalies), { COGS_CURRENCY_MIXED: 1 }, "a known code (never folded into OTHER)");
  assertRedacted(mixed.anomalies, "currency anomaly");
});

// ================================================ H. planning + exposure ================================================
const ROLL = { from: W.rolling.from, to: D1 };
const INIT = { from: W.initial.from, to: D1 };
const pend = (n, o = {}) => ({ accountId: acct(n), mode: "rolling", window: ROLL, lastSuccessAt: "2026-10-04T09:00:00Z", ...o });
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
test("H1 identical windows -> 2 / 7 / 3 five-seller batches for the 8 / 32 / 11 accounts of india / europe-au / us-ca (12 creates = 24 tokens)", () => {
  const sizes = (n) => M.planReturnsBatches(range(1, n).map((i) => pend(i))).map((it) => it.accountIds.length);
  assert.deepEqual(sizes(8), [5, 3]); assert.deepEqual(sizes(32), [5, 5, 5, 5, 5, 5, 2]); assert.deepEqual(sizes(11), [5, 5, 1]);
  const items = M.planReturnsBatches(range(1, 32).map((i) => pend(i)));
  assert.deepEqual(items.flatMap((it) => it.accountIds).sort(), range(1, 32).map(acct).sort(), "every account exactly once");
  for (const it of items) { assert.ok(it.accountIds.length <= 5); assert.deepEqual(it.sellerIds, it.accountIds); assert.deepEqual(it.window, ROLL); assert.equal(it.mode, "rolling"); }
  const exposure = [[8, 4], [32, 11], [11, 6]].map(([n, cap]) => M.returnsPlanExposure(M.planReturnsBatches(range(1, n).map((i) => pend(i))), { maxCreates: cap }));
  assert.deepEqual(exposure, [
    { plannedCreates: 2, maxCreates: 4, expectedTokens: 4, ceilingTokens: 8 },
    { plannedCreates: 7, maxCreates: 11, expectedTokens: 14, ceilingTokens: 22 },
    { plannedCreates: 3, maxCreates: 6, expectedTokens: 6, ceilingTokens: 12 }]);
  assert.equal(exposure.reduce((t, e) => t + e.expectedTokens, 0), 24); assert.equal(exposure.reduce((t, e) => t + e.ceilingTokens, 0), 42);
});
test("H2 a batch NEVER mixes windows; a day mixing initial (new account) + rolling adds at most one create per window", () => {
  const other = { from: "2026-09-20", to: "2026-10-03" };
  const items = M.planReturnsBatches([...range(1, 6).map((i) => pend(i)), pend(7, { window: other }), pend(8, { window: other })]);
  assert.deepEqual(items.map((it) => [it.window, it.accountIds]), [[ROLL, range(1, 5).map(acct)], [ROLL, [acct(6)]], [other, [acct(7), acct(8)]]],
    "8 accounts on two windows -> 3 creates (never 2): the 6th account cannot ride with the other window");
  for (const it of items) assert.equal(new Set(it.accountIds.map((id) => (id === acct(7) || id === acct(8) ? "o" : "r"))).size, 1);
  const mixed = M.planReturnsBatches([...range(1, 31).map((i) => pend(i)), pend(32, { mode: "initial", window: INIT, lastSuccessAt: null })]);
  assert.equal(mixed.length, 8, "31 rolling (7 batches) + 1 new account (1 batch)");
  assert.equal(M.planReturnsBatches(range(1, 32).map((i) => pend(i))).length, 7);
});
test("H3 ordering: ROLLING items first, then initial; inside each, oldest last_success_at (never-succeeded first), then account id", () => {
  const entries = [pend(5, { lastSuccessAt: null }), pend(3, { lastSuccessAt: "2026-10-02T09:00:00Z" }), pend(1, { lastSuccessAt: "2026-10-03T09:00:00Z" }),
    pend(4, { lastSuccessAt: "2026-10-02T09:00:00Z" }), pend(2, { lastSuccessAt: "2026-10-03T09:00:00.000+00:00" }), pend(6, { lastSuccessAt: null }),
    pend(9, { mode: "initial", window: INIT, lastSuccessAt: null }), pend(8, { mode: "initial", window: INIT, lastSuccessAt: null })];
  const items = M.planReturnsBatches(entries);
  assert.deepEqual(items.map((it) => [it.mode, it.accountIds]), [
    ["rolling", [acct(5), acct(6), acct(3), acct(4), acct(1)]], ["rolling", [acct(2)]], ["initial", [acct(8), acct(9)]]]);
  const acrossWindows = M.planReturnsBatches([pend(7, { lastSuccessAt: "2026-10-03T00:00:00Z" }), pend(8, { window: { from: "2026-09-20", to: "2026-10-03" }, lastSuccessAt: null })]);
  assert.deepEqual(acrossWindows.map((it) => it.accountIds[0]), [acct(8), acct(7)], "the item holding the stalest account goes first");
  const viaState = M.planReturnsBatches([{ accountId: acct(2), kind: "rolling", window: ROLL, state: { last_success_at: "2026-10-01T00:00:00Z" } },
    { accountId: acct(1), kind: "rolling", window: ROLL, last_success_at: "2026-10-02T00:00:00Z" }]);
  assert.deepEqual(viaState[0].accountIds, [acct(2), acct(1)], "kind / snake_case / state.last_success_at are accepted");
});
test("H4 zero-create kinds plan nothing; duplicates and unpersistable windows throw (fail closed); dd-secondary sellers are kept", () => {
  assert.deepEqual(M.planReturnsBatches([{ accountId: acct(1), kind: "skipped-current" }, { accountId: acct(2), kind: "held" }, { accountId: acct(3), kind: "pending" },
    { accountId: acct(4), kind: "reverify", window: ROLL }, null]), []);
  assert.throws(() => M.planReturnsBatches([pend(1), pend(1)]), TypeError);
  assert.throws(() => M.planReturnsBatches([pend(1, { sellerId: "s" }), pend(2, { sellerId: "s" })]), TypeError);
  assert.throws(() => M.planReturnsBatches([pend(1, { window: { from: D1, to: W.rolling.from } })]), TypeError);
  assert.equal(daysIn("2026-08-03", D1), 63);
  assert.throws(() => M.planReturnsBatches([pend(1, { window: { from: "2026-08-03", to: D1 } })]), TypeError, "63 days > the RPC's 62");
  assert.equal(M.planReturnsBatches([pend(1, { mode: "initial", window: { from: "2026-08-04", to: D1 } })]).length, 1, "62 days is persistable");
  assert.throws(() => M.planReturnsBatches([pend(1, { accountId: "" })]), TypeError);
  assert.throws(() => M.planReturnsBatches("x"), TypeError);
  const sec = M.planReturnsBatches([pend(1, { accountId: "dd-secondary:" + acct(1), sellerId: acct(1) })]);
  assert.deepEqual(sec[0].sellerIds, [acct(1)]);
});
test("H5 returnsPlanExposure: expected = planned creates x 2; ceiling = the hard create cap x 2 (the worst case); validated", () => {
  assert.deepEqual(M.returnsPlanExposure([], { maxCreates: 0 }), { plannedCreates: 0, maxCreates: 0, expectedTokens: 0, ceilingTokens: 0 });
  assert.deepEqual(M.returnsPlanExposure([{}, {}, {}]), { plannedCreates: 3, maxCreates: null, expectedTokens: 6, ceilingTokens: null });
  assert.deepEqual(M.returnsPlanExposure(new Array(12).fill({}), { maxCreates: 21 }), { plannedCreates: 12, maxCreates: 21, expectedTokens: 24, ceilingTokens: 42 });
  for (const bad of [-1, 1.5, "x"]) assert.throws(() => M.returnsPlanExposure([], { maxCreates: bad }), TypeError);
  assert.throws(() => M.returnsPlanExposure(null), TypeError);
});

// ================================================ I. collisions, masking, summaries, status row ================================================
test("I1 crossAccountOrderCollisions counts order ids under 2+ accounts of the run (pan-EU signature) -- counts only", () => {
  const e = (order) => ({ amazon_order_id: order });
  const byAccount = new Map([[acct(1), [e("O1"), e("O2"), e("O1")]], [acct(2), [e("O1"), e("O2")]], [acct(3), [e("O2"), e("O3")]], [acct(4), [e("O4"), e(""), e(null)]]]);
  assert.deepEqual(M.crossAccountOrderCollisions(byAccount), { orders: 2, accountsAffected: 3 });
  assert.deepEqual(M.crossAccountOrderCollisions(Object.fromEntries(byAccount)), { orders: 2, accountsAffected: 3 });
  assert.deepEqual(M.crossAccountOrderCollisions(new Map([[acct(1), [e("O1"), e("O1")]]])), { orders: 0, accountsAffected: 0 }, "a repeat inside ONE account is not cross-account");
  assert.deepEqual(M.crossAccountOrderCollisions(new Map()), { orders: 0, accountsAffected: 0 });
  assert.throws(() => M.crossAccountOrderCollisions([]), TypeError);
});
test("I2 maskId keeps only the 8-char prefix", () => {
  assert.equal(M.maskId(acct(1)), "a0000001"); assert.equal(M.maskId(" e0000001-0000-4000 "), "e0000001");
  assert.equal(M.maskId(null), ""); assert.equal(M.maskId(undefined), ""); assert.equal(M.maskId(12345678901), "12345678"); assert.equal(M.maskId("abc"), "abc");
});
test("I3 summarizeAnomalies merges arrays / count objects / results into sorted counts; an unknown key (a row value) folds into OTHER", () => {
  const got = M.summarizeAnomalies(["QUANTITY_NULL", "LPN_BLANK"], { QUANTITY_NULL: 2, LPN0000000001: 1, [ORDER1]: 3, RETURNS_QUANTITY_INVALID: 0 },
    { ok: true, anomalies: ["FBA_ONLY_ON_FBM"] }, vrows([fbaRow({ quantity: 0 })]), null, undefined, 7);
  assert.deepEqual(got, { FBA_ONLY_ON_FBM: 1, LPN_BLANK: 1, OTHER: 4, QUANTITY_NULL: 3, QUANTITY_ZERO: 1 });
  assert.deepEqual(Object.keys(got), Object.keys(got).slice().sort());
  assertRedacted(got, "anomaly summary");
  assert.deepEqual(M.summarizeAnomalies(), {});
});
test("I4 returnsRunStatusEntry: succeeded only when every account is current and gap-free; typed safe codes; counts-only stage", () => {
  const plan = { items: [{}, {}], windows: M.returnsWindows(D1), accountsTotal: 8 };
  assert.deepEqual(M.returnsRunStatusEntry({ region: "india", plan, outcome: { creates: 2, accounts: { dailyRefreshed: 6, "skipped-current": 2 } }, maxCreates: 4, nowIso: NOW }), {
    sourceKey: "returns", bucket: "india", lastStatus: "succeeded", lastAttemptAt: NOW, lastSuccessAt: NOW, safeErrorCode: null, safeErrorStage: null,
    coveredFrom: W.initial.from, coveredTo: D1, accountsCompleted: 8, accountsFailed: 0, accountsTotal: 8, batchCount: 2,
    createsSpent: 2, tokensSpent: 4, createsCeiling: 4, tokensCeiling: 8 });
  const partial = M.returnsRunStatusEntry({ region: "europe-au", plan: { items: new Array(7).fill({}), windows: M.returnsWindows(D1), compatible: range(1, 32).map(acct) },
    outcome: { creates: 7, accounts: { "daily-refreshed": range(1, 29).map(acct), "initial-loaded": [acct(30)], failed: [acct(31)], held: [acct(32)] }, coverageGap: { accounts: 1, days: 12 } },
    maxCreates: 11, nowIso: NOW });
  assert.equal(partial.lastStatus, "partial"); assert.equal(partial.lastSuccessAt, undefined);
  assert.equal(partial.safeErrorCode, "RETURNS_ACCOUNTS_FAILED"); assert.equal(partial.safeErrorStage, "failed 1, held 1, coverage gap 12 days on 1 account");
  assert.equal(partial.coveredFrom, null); assert.equal(partial.coveredTo, null);
  assert.equal(partial.accountsCompleted, 30); assert.equal(partial.accountsFailed, 2); assert.equal(partial.accountsTotal, 32);
  assert.equal(partial.tokensSpent, 14); assert.equal(partial.tokensCeiling, 22);
  assertRedacted(partial, "status row"); assert.ok(!JSON.stringify(partial).includes(acct(31)));
  const gapOnly = M.returnsRunStatusEntry({ region: "us-ca", plan, outcome: { accounts: { dailyRefreshed: 3 }, gapAccounts: 2, gapDays: 30 }, nowIso: NOW });
  assert.equal(gapOnly.lastStatus, "partial"); assert.equal(gapOnly.safeErrorCode, "RETURNS_COVERAGE_GAP"); assert.equal(gapOnly.safeErrorStage, "coverage gap 30 days on 2 accounts");
  assert.equal(gapOnly.createsCeiling, null); assert.equal(gapOnly.tokensCeiling, null);
  assert.equal(M.returnsRunStatusEntry({ region: "us-ca", plan, outcome: { counts: { held: 1, dailyRefreshed: 2 } }, nowIso: NOW }).safeErrorCode, "RETURNS_ACCOUNTS_HELD");
  assert.equal(M.returnsRunStatusEntry({ region: "us-ca", plan, outcome: { incomplete: 3 }, nowIso: NOW }).safeErrorCode, "RETURNS_ACCOUNTS_INCOMPLETE");
  assert.equal(M.returnsRunStatusEntry({ region: "us-ca", plan, outcome: { pending: [acct(1)] }, nowIso: NOW }).safeErrorCode, "RETURNS_ACCOUNTS_PENDING");
  const drift = M.returnsRunStatusEntry({ region: "india", plan, outcome: { systemic: true, code: "RETURNS_SCHEMA_DRIFT" }, nowIso: NOW });
  assert.equal(drift.lastStatus, "failed"); assert.equal(drift.safeErrorCode, "RETURNS_SCHEMA_DRIFT"); assert.equal(drift.safeErrorStage, "run");
  assert.equal(M.returnsRunStatusEntry({ region: "india", plan, outcome: { systemic: true }, nowIso: NOW }).safeErrorCode, "RETURNS_FAILED");
  const lease = M.returnsRunStatusEntry({ region: "india", plan, outcome: { code: "RETURNS_LEASE_HELD" }, nowIso: NOW });
  assert.equal(lease.lastStatus, "partial"); assert.equal(lease.safeErrorCode, "RETURNS_LEASE_HELD");
  assert.equal(M.returnsRunStatusEntry({ region: "india", plan, outcome: { code: acct(1), failed: 1 }, nowIso: NOW }).safeErrorCode, "RETURNS_ACCOUNTS_FAILED", "a non-code value is never echoed");
  assert.throws(() => M.returnsRunStatusEntry({ region: "us", plan, outcome: {}, nowIso: NOW }), TypeError);
  assert.throws(() => M.returnsRunStatusEntry({ region: "india", plan, outcome: {}, nowIso: "yesterday" }), TypeError);
});
test("I5 output contract: identity detail, exposure, collisions, mode decisions and plans carry no raw identifier", () => {
  const v = vrows([fbaRow({ date: "2026-09-30" }), fbaRow({ date: "2026-10-01" }), fbmRow(), fbaRow({ amazon_license_plate_number: "" })]);
  assertRedacted(v.identity, "identity"); assertRedacted(v.anomalies, "anomalies");
  for (const x of Object.values(v.identity.detail)) assert.ok(Number.isInteger(x));
  assertRedacted(M.crossAccountOrderCollisions(new Map([[SELLER, v.events], [OTHER_SELLER, v.events]])), "collisions");
  assertRedacted(M.returnsPlanExposure(M.planReturnsBatches([pend(1)])), "exposure");
  assertRedacted(mode(st({ hold_reason: "RETURNS_IDENTITY_AMBIGUOUS" })), "mode");
  assert.ok(Buffer.byteLength(JSON.stringify(v.identity.detail), "utf8") <= 4096, "identity_detail fits the 4096-byte column check");
});

// ================================================ J. history aggregate mirror ================================================
function prng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const centsText = (c) => (c < 0 ? "-" : "") + Math.trunc(Math.abs(c) / 100) + "." + String(Math.abs(c) % 100).padStart(2, "0");
test("J1 PARITY: aggregateEventsForHistory == legacy aggregateReturnsForAccount on the same rows (grain set, return_count, money; exact decimals)", () => {
  const rnd = prng(20261004); const pick = (a) => a[Math.floor(rnd() * a.length)];
  const days = ["2026-09-21", "2026-09-24", "2026-09-27", "2026-09-30", "2026-10-02", "2026-10-04"];
  const rows = []; const cents = [];
  const money = () => { const r = rnd(); if (r < 0.15) return [null, 0]; if (r < 0.2) return ["", 0]; const c = Math.floor(rnd() * 20000) - 2000; return [rnd() < 0.5 ? centsText(c) : c / 100, c]; };
  for (let i = 0; i < 400; i += 1) {
    const fba = rnd() < 0.5; const sku = pick(["SKU-1", "SKU-2", "SKU-3", "SKU-4"]);
    const [refund, refundC] = money(); const [label, labelC] = money(); const [cogs, cogsC] = money();
    const payer = pick(["Seller", "Customer", "", "seller-paid", null, " SELLER "]);
    rows.push(fbaRow({ date: pick(days), sku, child_asin: "B00000000" + sku.slice(-1), amazon_order_id: "000-0000000-" + String(i).padStart(7, "0"),
      quantity: pick([1, 1, 1, 2, null, 0]), amazon_return_reason: pick(["UNWANTED_ITEM", "DEFECTIVE", "NOT_AS_DESCRIBED"]),
      amazon_fulfillment_channel: fba ? "FBA" : "FBM", amazon_return_request_status: fba ? pick(["Unit returned to inventory", "Reimbursed"]) : pick(["Approved", "Closed", "PendingApproval"]),
      amazon_return_detailed_disposition: fba ? pick(["SELLABLE", "CUSTOMER_DAMAGED", "DEFECTIVE", null]) : null,
      amazon_return_rmaid: fba ? null : "RMA" + i, amazon_license_plate_number: fba ? "LPN" + i : "", amazon_return_label_to_be_paid_by: payer,
      amazon_return_refunded_amount: refund, amazon_return_label_cost: label, cogs_total_value: cogs, cogs_currency: pick(["GBP", null]), cogs_present: rnd() < 0.7 }));
    cents.push({ refund: refundC, label: /seller/i.test(String(payer || "")) ? labelC : 0, cogs: cogsC });
  }
  const legacy = LEG.aggregateReturnsForAccount({ rows, accountId: SELLER, sellerOrVendorId: SELLER, marketplaceCountryCode: "GB", from: W.rolling.from, to: D1, sourceRequestHash: H1, refreshedAt: NOW });
  const v = vrows(rows);
  assert.equal(v.ok, true);
  const mine = M.aggregateEventsForHistory(v.events, { sellerOrVendorId: SELLER, marketplaceCountryCode: "GB", refreshedAt: NOW });
  const grain = (r) => JSON.stringify([r.return_date, r.sku, r.child_asin, r.amazon_return_reason, r.fulfillment_channel, r.request_status, r.label_payer]);
  const L = new Map(legacy.map((r) => [grain(r), r])); const Mi = new Map(mine.map((r) => [grain(r), r]));
  assert.ok(mine.length > 50, "a dense multi-grain sample");
  assert.deepEqual([...Mi.keys()].sort(), [...L.keys()].sort(), "identical grain set");
  const exact = new Map();
  rows.forEach((r, i) => {
    const k = JSON.stringify([r.date, r.sku, r.child_asin, r.amazon_return_reason, r.amazon_fulfillment_channel, r.amazon_return_request_status, String(r.amazon_return_label_to_be_paid_by ?? "").trim()]);
    const x = exact.get(k) || { refund: 0, label: 0, cogs: 0 };
    x.refund += Math.abs(cents[i].refund); x.label += Math.abs(cents[i].label); x.cogs += Math.abs(cents[i].cogs); exact.set(k, x);
  });
  for (const [k, m] of Mi) {
    const l = L.get(k);
    assert.equal(m.return_count, l.return_count);
    for (const [f, c] of [["fbm_refunded_amount", "refund"], ["fbm_seller_label_cost", "label"], ["cogs_total_value", "cogs"]]) {
      assert.ok(Math.abs(Number(m[f]) - l[f]) < 1e-6, f + " parity");
      assert.equal(m[f], M.canonicalDecimal(centsText(exact.get(k)[c])), f + " is the EXACT decimal sum");
    }
    assert.equal(m.seller_or_vendor_id, l.seller_or_vendor_id); assert.equal(m.marketplace_country_code, l.marketplace_country_code);
    assert.equal(m.source_request_hash, l.source_request_hash); assert.equal(m.refreshed_at, l.refreshed_at);
  }
  assert.equal(mine.reduce((t, r) => t + r.return_count, 0), rows.length, "sum(return_count) = event count (as-delivered)");
});
test("J2 SQL semantics: returned_units only when EVERY row has quantity >= 1; label cost only for a seller payer; abs + exact sums; min hash", () => {
  let seq = 0;
  const g = (o) => fbmRow({ amazon_order_id: "000-0000000-" + String(++seq).padStart(7, "0"), amazon_return_rmaid: "RMA" + seq, ...o });
  const events = M.assignOccurrences([
    ev(g({ sku: "U1", quantity: 1 })), ev(g({ sku: "U1", quantity: 2 }), META_B), ev(g({ sku: "U1", quantity: "3" })),
    ev(g({ sku: "U2", quantity: 1 })), ev(g({ sku: "U2", quantity: null })),
    ev(g({ sku: "U3", quantity: 2 })), ev(g({ sku: "U3", quantity: 0 })),
    ev(g({ sku: "M1", amazon_return_refunded_amount: "0.1", amazon_return_label_cost: "-1.25", amazon_return_label_to_be_paid_by: "Seller", cogs_total_value: "-2.5" })),
    ev(g({ sku: "M1", amazon_return_refunded_amount: "0.2", amazon_return_label_cost: "2.5", amazon_return_label_to_be_paid_by: "Seller", cogs_total_value: null })),
    ev(g({ sku: "M2", amazon_return_label_cost: "9.99", amazon_return_label_to_be_paid_by: "Customer" })),
    ev(g({ sku: "M3", amazon_return_label_cost: "1.01", amazon_return_label_to_be_paid_by: "PAID BY SELLER" })),
  ]);
  const by = new Map(M.aggregateEventsForHistory(events).map((r) => [r.sku + "|" + r.label_payer, r]));
  assert.equal(by.get("U1|Seller").returned_units, 6); assert.equal(by.get("U1|Seller").return_count, 3);
  assert.equal(by.get("U1|Seller").source_request_hash, [H1, H2].sort()[0], "min(source_request_hash)");
  assert.equal(by.get("U2|Seller").returned_units, null, "a null quantity makes the grain's units unavailable");
  assert.equal(by.get("U3|Seller").returned_units, null, "so does a 0");
  const m1 = by.get("M1|Seller");
  assert.equal(m1.fbm_refunded_amount, "0.3", "exact decimal, not 0.30000000000000004");
  assert.equal(m1.fbm_seller_label_cost, "3.75"); assert.equal(m1.cogs_total_value, "2.5");
  assert.equal(by.get("M2|Customer").fbm_seller_label_cost, "0"); assert.equal(by.get("M3|PAID BY SELLER").fbm_seller_label_cost, "1.01", "~* 'seller' is a case-insensitive substring match");
  for (const r of by.values()) assert.equal(r.seller_or_vendor_id, SELLER);
  assert.throws(() => M.aggregateEventsForHistory(events, { attribution: "nope" }), TypeError);
  assert.throws(() => M.aggregateEventsForHistory(null), TypeError);
});
test("J3 detailed_disposition = min(non-blank) collate \"C\" (code point order, not UTF-16 order) or ''", () => {
  const disp = (d) => ({ ...ev(fbaRow()), detailed_disposition: d });
  const one = (ds) => M.aggregateEventsForHistory(ds.map(disp))[0].detailed_disposition;
  assert.equal(one(["b", "a", "Z", null]), "Z");
  assert.equal(one([null, null]), "");
  assert.equal(one(["", "SELLABLE"]), "SELLABLE");
  assert.equal(one(["\u{1F600}", "\uFFFD"]), "\uFFFD", "U+FFFD sorts before U+1F600 in UTF-8 byte order");
  assert.ok("\u{1F600}" < "\uFFFD", "(plain JS string order would have picked the emoji)");
});
test("J4 attribution 'exclude-other-owner' drops order_owner='other' events (a grain of only 'other' rows disappears); as-delivered keeps all", () => {
  const base = [ev(fbaRow({ sku: "K1" })), ev(fbaRow({ sku: "K1", amazon_license_plate_number: "LPN0000000002" })), ev(fbaRow({ sku: "K1", amazon_license_plate_number: "LPN0000000003" })), ev(fbaRow({ sku: "K2" }))];
  const owned = [{ ...base[0], order_owner: "self" }, { ...base[1], order_owner: "other" }, { ...base[2], order_owner: "unknown", quantity: null }, { ...base[3], order_owner: "other" }];
  const all = M.aggregateEventsForHistory(owned);
  assert.deepEqual(all.map((r) => [r.sku, r.return_count, r.returned_units]), [["K1", 3, null], ["K2", 1, 1]]);
  const excl = M.aggregateEventsForHistory(owned, { attribution: "exclude-other-owner" });
  assert.deepEqual(excl.map((r) => [r.sku, r.return_count, r.returned_units]), [["K1", 2, null]]);
  assert.equal(excl.reduce((t, r) => t + r.return_count, 0), owned.filter((e) => e.order_owner !== "other").length, "sum(return_count) = attributed events");
});

// ================================================ K. purity ================================================
function importSpecifiers(src) {
  const found = new Set();
  for (const re of [/^\s*import\s[\s\S]*?from\s*["']([^"']+)["']/gm, /^\s*import\s*["']([^"']+)["']/gm, /^\s*export\s[^;]*?\sfrom\s*["']([^"']+)["']/gm, /\bimport\(\s*["']([^"']+)["']\s*\)/g]) {
    for (const m of src.matchAll(re)) found.add(m[1]);
  }
  return found;
}
test("K1 import closure: node:crypto + three zero-I/O leaves ONLY (never datadoe.js / supabase.js / ads-sync.js)", () => {
  const allowed = new Set([path.join(ROOT, "lib", "marketplaces.js"), path.join(ROOT, "lib", "server", "date-windows.js"), path.join(ROOT, "lib", "server", "reports", "sources.js")]);
  const builtins = new Set(); const files = new Set(); const stack = [MODULE_PATH];
  while (stack.length) {
    const f = stack.pop();
    for (const spec of importSpecifiers(readFileSync(f, "utf8"))) {
      if (spec.startsWith("node:")) { builtins.add(spec); continue; }
      assert.ok(spec.startsWith("."), "bare package import: " + spec);
      const abs = path.resolve(path.dirname(f), spec);
      if (!files.has(abs)) { files.add(abs); stack.push(abs); }
    }
  }
  assert.deepEqual([...builtins], ["node:crypto"]);
  assert.deepEqual([...files].sort(), [...allowed].sort());
  for (const f of files) assert.ok(!/(^|[\\/])(datadoe|supabase|ads-sync)\.js$/.test(f));
});
test("K2 the module is 7-bit ASCII + LF and uses no I/O primitive (fetch, env, fs, dynamic import, timers)", () => {
  const buf = readFileSync(MODULE_PATH);
  for (const b of buf) assert.ok(b < 0x80, "non-ASCII byte");
  const src = buf.toString("utf8");
  assert.ok(!src.includes("\r"), "CRLF");
  for (const re of [/\bfetch\s*\(/, /process\.env/, /\bfrom\s+["']node:fs["']/, /readFileSync|writeFileSync/, /\bimport\(/, /setTimeout|setInterval/, /Math\.random/, /Date\.now\(/]) assert.ok(!re.test(src), "forbidden: " + re);
});

(async () => {
  for (const t of tests) {
    try { await t.fn(); passed += 1; out("ok - " + t.name); }
    catch (e) { out("not ok - " + t.name + "\n  " + String(e && e.stack ? e.stack : e).split("\n").slice(0, 6).join("\n  ")); process.exitCode = 1; }
  }
  out("\nreturns-event-source: " + passed + "/" + tests.length + " passed");
  if (passed !== tests.length) process.exitCode = 1;
})();
