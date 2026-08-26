// FUTURE-ONLY Amazon Order ID capture -- deterministic OFFLINE proof of the 20 mandatory behaviours. The order
// audit is written from the SAME validated OLI export as the dimensional/rollup evidence; the business grain stays
// byte-identical (Order ID folded away) and Order IDs live only in the order-level audit. 7-bit ASCII, LF, no
// top-level await.

import assert from "node:assert/strict";
import { readFileSync, writeSync } from "node:fs";
import path from "node:path";
import {
  canonicalizeOrderId, redactOrderId, orderIdDisplayState, classifyOliDimensionalRow,
} from "../lib/server/sync/oli-order-rules.js";
import { oliDimensionalRowsFromFragment } from "../lib/server/sync/source-durable-model.js";
import { summarizeExplicitZeroOli } from "../lib/server/reports/oli-quality.js";
import { OLI_SALES_COLUMNS, reportSourceRequestHashes } from "../lib/server/sync/report-source-contracts.js";
import { auditSchemaContract } from "../lib/server/sync/schema-contract.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const frag = (over = {}) => ({
  date: "2026-08-27", seller_or_vendor_id: "S1", sku: "SKU-A", child_asin: "B0A", item_price_currency: "USD",
  amazon_order_status: "Shipped", fulfillment_channel: "AFN", address_state: "CA", address_city: "LA",
  amazon_order_id: "111-2223334-4445556", total_sales_sum: 100, total_units_sum: 1, ...over,
});
const accounts = { S1: { accountId: "ACC-1", currency: "USD" }, S2: { accountId: "ACC-2", currency: "EUR" } };
const build = (rows, over = {}) => oliDimensionalRowsFromFragment({
  rows, accountsBySellerId: accounts, organizationFingerprint: "org", connectionId: "primary", sourceRequestHash: "h1", ...over,
});
const auditRows = (res, acc = "ACC-1") => res.orderAuditByAccount.get(acc) || [];
const dimRows = (res, acc = "ACC-1") => res.byAccount.get(acc) || [];
const rollRows = (res, acc = "ACC-1") => res.rollupByAccount.get(acc) || [];

// ---- 1. a valid Order ID persists EXACTLY (canonical, unmodified) -------------------------------------------
test("1. a valid Order ID is captured EXACTLY into the order audit (canonical, unchanged)", () => {
  const res = build([frag({ amazon_order_id: "  111-2223334-4445556 " })]); // surrounding whitespace trimmed only
  const a = auditRows(res);
  assert.equal(a.length, 1);
  assert.equal(a[0].amazon_order_id, "111-2223334-4445556");
});

// ---- 2. multiple orders sharing date/SKU/ASIN do NOT collapse in the audit ---------------------------------
test("2. two DISTINCT orders with the same date/SKU/ASIN/status/etc. stay TWO audit rows (never merged)", () => {
  const res = build([
    frag({ amazon_order_id: "AAA-0000001-0000001", total_units_sum: 1, total_sales_sum: 10 }),
    frag({ amazon_order_id: "BBB-0000002-0000002", total_units_sum: 1, total_sales_sum: 20 }),
  ]);
  const a = auditRows(res);
  assert.equal(a.length, 2, "distinct Order IDs => two audit rows");
  assert.deepEqual([...new Set(a.map((r) => r.amazon_order_id))].sort(), ["AAA-0000001-0000001", "BBB-0000002-0000002"]);
  // ...but the DIMENSIONAL business grain folds Order ID away => ONE row (byte-identical business grain).
  assert.equal(dimRows(res).length, 1, "the business dimensional grain collapses the two orders into one");
  assert.equal(dimRows(res)[0].total_units_sum, 2);
});

// ---- 3. replay is idempotent (deterministic) ---------------------------------------------------------------
test("3. re-building the same payload yields byte-identical audit rows (idempotent replay)", () => {
  const payload = [frag({ amazon_order_id: "AAA-0000001-0000001" }), frag({ sku: "SKU-B", amazon_order_id: "CCC-3" })];
  assert.deepEqual(auditRows(build(payload)), auditRows(build(payload)));
});

// ---- 4. account isolation ----------------------------------------------------------------------------------
test("4. each account's Order IDs stay in its OWN audit bucket (never cross accounts)", () => {
  const res = build([
    frag({ seller_or_vendor_id: "S1", amazon_order_id: "AAA-1" }),
    frag({ seller_or_vendor_id: "S2", item_price_currency: "EUR", amazon_order_id: "BBB-2" }),
  ]);
  assert.deepEqual(auditRows(res, "ACC-1").map((r) => r.amazon_order_id), ["AAA-1"]);
  assert.deepEqual(auditRows(res, "ACC-2").map((r) => r.amazon_order_id), ["BBB-2"]);
});

// ---- 5. marketplace / currency isolation -------------------------------------------------------------------
test("5. the same Order ID under a DIFFERENT currency is a DISTINCT audit grain (currency isolation)", () => {
  // Same account (S1=USD) but two currencies present on its rows -> distinct grains, never summed across currency.
  const res = build([
    frag({ amazon_order_id: "AAA-1", item_price_currency: "USD" }),
    frag({ amazon_order_id: "AAA-1", item_price_currency: "GBP" }),
  ]);
  const a = auditRows(res);
  assert.equal(a.length, 2);
  assert.deepEqual([...new Set(a.map((r) => r.currency))].sort(), ["GBP", "USD"]);
});

// ---- 6. cancelled: Order ID kept for audit, ZERO business ---------------------------------------------------
test("6. a CANCELLED order keeps its Order ID in the audit but contributes ZERO to the rollup", () => {
  const res = build([frag({ amazon_order_status: "Cancelled", amazon_order_id: "CAN-1", total_sales_sum: 999, total_units_sum: 5 })]);
  const a = auditRows(res);
  assert.equal(a.length, 1);
  assert.equal(a[0].amazon_order_id, "CAN-1");
  assert.equal(rollRows(res).length, 0, "cancelled contributes nothing to the business rollup");
});

// ---- 7. explicit-zero non-cancelled: Order ID kept for audit, ZERO business --------------------------------
test("7. a non-cancelled PRESENT-ZERO order keeps its Order ID in the audit but contributes ZERO to the rollup", () => {
  const res = build([frag({ amazon_order_status: "Shipped", amazon_order_id: "ZER-1", total_sales_sum: 0, total_units_sum: 3 })]);
  const a = auditRows(res);
  assert.equal(a.length, 1);
  assert.equal(a[0].amazon_order_id, "ZER-1");
  assert.equal(a[0].total_sales_sum, 0, "present-zero value preserved in audit");
  assert.equal(rollRows(res).length, 0, "present-zero contributes nothing to the business rollup");
});

// ---- 8. positive-value order keeps the business totals -----------------------------------------------------
test("8. a positive-value order still contributes its exact sales/units to the rollup (unchanged)", () => {
  const res = build([frag({ amazon_order_id: "POS-1", total_sales_sum: 100, total_units_sum: 2 })]);
  assert.equal(rollRows(res).length, 1);
  assert.equal(rollRows(res)[0].salesAmount, 100);
  assert.equal(rollRows(res)[0].units, 2);
});

// ---- 9. NULL price on a non-cancelled positive-unit row: fail-closed (LKG), NO audit written ----------------
test("9. a non-cancelled units>0 row with a MISSING value BLOCKS the account (LKG) -- no audit row emitted", () => {
  const res = build([frag({ amazon_order_status: "Shipped", amazon_order_id: "NUL-1", total_sales_sum: null, total_units_sum: 2 })]);
  assert.ok(res.blocked.some((b) => b.accountId === "ACC-1" && b.code === "OLI_NON_CANCELLED_VALUE_MISSING"));
  assert.equal(res.orderAuditByAccount.has("ACC-1"), false, "a blocked account writes NO audit rows (LKG preserved)");
});

// ---- 10. blank Order ID: never invented, typed unavailable -------------------------------------------------
test("10. a blank/missing Order ID is stored '' + orderIdAvailable=false (never fabricated, never a neighbour's)", () => {
  const res = build([
    frag({ amazon_order_id: "   ", total_units_sum: 1 }),      // whitespace-only -> unavailable
    frag({ amazon_order_id: "REAL-1", sku: "SKU-Z", total_units_sum: 1 }),
  ]);
  const blank = auditRows(res).find((r) => r.sku === "SKU-A");
  const real = auditRows(res).find((r) => r.sku === "SKU-Z");
  assert.equal(blank.amazon_order_id, "", "blank Order ID canonicalizes to '' (never invented)");
  assert.equal(real.amazon_order_id, "REAL-1", "a real ID is never overwritten by a neighbour");
  // classify never invents an ID and marks availability precisely.
  assert.equal(classifyOliDimensionalRow(frag({ amazon_order_id: "" })).orderIdAvailable, false);
  assert.equal(classifyOliDimensionalRow(frag({ amazon_order_id: "X-1" })).orderIdAvailable, true);
});

// ---- 11. historical rows (no audit) display "Not captured"; source-missing display "unavailable" -----------
test("11. display states: captured id / source-unavailable / historical-not-captured (never a fabricated id)", () => {
  assert.deepEqual(orderIdDisplayState({ hasAudit: true, orderIdAvailable: true, amazonOrderId: "111-2" }), { kind: "captured", text: "111-2", orderId: "111-2" });
  assert.equal(orderIdDisplayState({ hasAudit: true, orderIdAvailable: false, amazonOrderId: "" }).kind, "unavailable");
  assert.equal(orderIdDisplayState({ hasAudit: true, orderIdAvailable: false, amazonOrderId: "" }).text, "Order ID unavailable from source");
  const hist = orderIdDisplayState({ hasAudit: false });
  assert.equal(hist.kind, "not-captured");
  assert.match(hist.text, /before Order ID tracking/);
  assert.equal(hist.orderId, "", "a not-captured cell never exposes an id");
});

// ---- 12. scheduler + manual use the SAME single persist path (same contract + persistence) -----------------
test("12. one persist path (oliDimensionalRowsFromFragment -> replaceOliDimensionalWindow) feeds scheduler AND manual", () => {
  const bucket = readFileSync("lib/server/sync/source-bucket-sync.js", "utf8");
  // The single OLI persist block destructures orderAuditByAccount and passes orderRows to the SAME replace wrapper.
  assert.match(bucket, /orderAuditByAccount/, "the persist path builds order-audit rows");
  assert.match(bucket, /orderRows\s*[,}]/, "the persist path passes orderRows to the replace wrapper");
  const sup = readFileSync("lib/server/supabase.js", "utf8");
  assert.match(sup, /p_order_rows/, "the wrapper POSTs p_order_rows on the SAME RPC call");
});

// ---- 13. the SAME export feeds BOTH the business grain and the order audit ----------------------------------
test("13. ONE build of ONE payload yields BOTH the folded business grain AND the order audit (no second export)", () => {
  const res = build([frag({ amazon_order_id: "AAA-1" }), frag({ amazon_order_id: "BBB-2" })]);
  assert.ok(dimRows(res).length >= 1 && auditRows(res).length === 2, "both products come from the single payload build");
  // The audit rows carry the same source_request_hash as the dimensional rows (one export lineage).
  assert.equal(auditRows(res)[0].source_request_hash, "h1");
  assert.equal(dimRows(res)[0].source_request_hash, "h1");
});

// ---- 14. no second Order-ID-specific export: order_id rides the ONE canonical OLI fragment ------------------
test("14. amazon_order_id is on the ONE canonical OLI fragment (no separate Order-ID export/source)", () => {
  assert.ok(OLI_SALES_COLUMNS.includes("amazon_order_id"));
  assert.ok(!OLI_SALES_COLUMNS.includes("address_country"));
  assert.equal(new Set(OLI_SALES_COLUMNS).size, OLI_SALES_COLUMNS.length, "no duplicate columns");
});

// ---- 15. request-hash stays deterministic + stable (create-once) -------------------------------------------
test("15. adding the column keeps the OLI request identity DETERMINISTIC + shared (one create per hash)", () => {
  const W = { "daily-reporting:oli-sales": [{ from: "2026-08-01", to: "2026-08-07" }], "daily-reporting:catalog": [{ from: null, to: null }] };
  const a = reportSourceRequestHashes({ reportKey: "daily-reporting", apiKey: "k", ids: ["A1"], windowsByRequestKey: W });
  const b = reportSourceRequestHashes({ reportKey: "daily-reporting", apiKey: "k", ids: ["A1"], windowsByRequestKey: W });
  const oli = a.filter((r) => r.requestKey === "daily-reporting:oli-sales");
  assert.ok(oli.length >= 1);
  assert.deepEqual(a.map((r) => r.requestHash), b.map((r) => r.requestHash), "identical inputs => identical hashes");
});

// ---- 16. commit-unknown never reports success (wrapper error mapping) ---------------------------------------
test("16. the replace wrapper reports orderAuditInserted only on write:'ok'; every error path returns a typed non-ok", () => {
  const sup = readFileSync("lib/server/supabase.js", "utf8");
  const fn = sup.slice(sup.indexOf("export async function replaceOliDimensionalWindow"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /write:\s*"ok"[\s\S]*orderAuditInserted/, "success path carries orderAuditInserted");
  for (const code of ["schema-missing", "value-missing", "status-missing", "write-failed"]) {
    assert.ok(body.includes(`"${code}"`), `error path ${code} present (typed non-ok, never a false success)`);
  }
  // every non-ok error branch pins orderAuditInserted: 0 (a failure never claims audit rows landed).
  assert.equal((body.match(/orderAuditInserted:\s*0/g) || []).length >= 4, true);
});

// ---- 17. account-scoped reads: a reader is bound to ONE account_id -----------------------------------------
test("17. the order-audit reader is STRICTLY account-scoped (an account can only read its own Order IDs)", () => {
  const sup = readFileSync("lib/server/supabase.js", "utf8");
  const fn = sup.slice(sup.indexOf("export async function getExplicitZeroOliOrderAudit"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /account_id:\s*`eq\.\$\{accountId\}`/, "read is filtered to the exact account_id");
  assert.match(body, /organization_fingerprint:\s*`eq\.\$\{organizationFingerprint\}`/, "and to the org fingerprint");
  assert.match(body, /source_oli_order_audit/, "reads the order-audit table");
  assert.ok(!/amazon_order_id[^,]*address_country/.test(body), "never selects address_country");
});

// ---- 18. logs/errors redact full Order IDs -----------------------------------------------------------------
test("18. redactOrderId never leaks a full Order ID (prefix only) and maps blank -> (none)", () => {
  assert.equal(redactOrderId("111-2223334-4445556"), "111...".replace("...", "…"));
  assert.ok(!redactOrderId("111-2223334-4445556").includes("2223334"), "the middle/tail is never shown");
  assert.equal(redactOrderId("   "), "(none)");
  assert.equal(canonicalizeOrderId("  X-1 "), "X-1");
});

// ---- 19. business Sales/Units are BYTE-IDENTICAL with vs without Order ID present ---------------------------
test("19. the folded dimensional + rollup are BYTE-IDENTICAL whether or not Order IDs are present", () => {
  const withId = [frag({ amazon_order_id: "AAA-1", total_sales_sum: 40, total_units_sum: 1 }), frag({ amazon_order_id: "BBB-2", total_sales_sum: 60, total_units_sum: 2 })];
  const noId = [frag({ amazon_order_id: "", total_sales_sum: 40, total_units_sum: 1 }), frag({ amazon_order_id: "", total_sales_sum: 60, total_units_sum: 2 })];
  const r1 = build(withId); const r2 = build(noId);
  assert.deepEqual(dimRows(r1), dimRows(r2), "dimensional business grain identical regardless of Order ID");
  assert.deepEqual(rollRows(r1), rollRows(r2), "rollup identical regardless of Order ID");
  assert.equal(rollRows(r1)[0].salesAmount, 100);
  assert.equal(rollRows(r1)[0].units, 3);
});

// ---- 20. explicit-zero + missing-value semantics unchanged by the Order ID feature -------------------------
test("20. cancellation / explicit-zero / missing-value classification is unchanged by Order ID capture", () => {
  const cancelled = classifyOliDimensionalRow(frag({ amazon_order_status: "Cancelled", total_sales_sum: 5, total_units_sum: 1 }));
  assert.equal(cancelled.contributesToRollup, false);
  const zero = classifyOliDimensionalRow(frag({ total_sales_sum: 0, total_units_sum: 2 }));
  assert.equal(zero.valuePresent, true);
  assert.equal(zero.contributesToRollup, false);
  assert.throws(() => classifyOliDimensionalRow(frag({ total_sales_sum: null, total_units_sum: 2 })), (e) => e.code === "OLI_NON_CANCELLED_VALUE_MISSING");
  const pos = classifyOliDimensionalRow(frag({ total_sales_sum: 10, total_units_sum: 1 }));
  assert.equal(pos.contributesToRollup, true);
});

// ---- 11b. the breakdown MERGE: audit rows attach Order IDs per grain; historical grains show "Not captured" ---
test("11b. summarizeExplicitZeroOli attaches captured/unavailable Order IDs per grain; a grain with no audit is historical", () => {
  // Two explicit-zero dimensional grains (present-zero, non-cancelled, units>0): one has future audit rows, one does not.
  const dim = [
    { sale_date: "2026-08-27", sku: "SKU-A", child_asin: "B0A", currency: "USD", amazon_order_status: "Shipped", fulfillment_channel: "AFN", address_state: "CA", address_city: "LA", is_cancelled: false, total_sales_sum: 0, total_units_sum: 2 },
    { sale_date: "2026-01-01", sku: "SKU-OLD", child_asin: "B0OLD", currency: "USD", amazon_order_status: "Shipped", fulfillment_channel: "AFN", address_state: "NY", address_city: "NYC", is_cancelled: false, total_sales_sum: 0, total_units_sum: 1 },
  ];
  const audit = [
    { sale_date: "2026-08-27", sku: "SKU-A", child_asin: "B0A", currency: "USD", amazon_order_status: "Shipped", fulfillment_channel: "AFN", address_state: "CA", address_city: "LA", amazon_order_id: "111-2223334-4445556", order_id_available: true, is_cancelled: false, total_sales_sum: 0, total_units_sum: 1 },
    { sale_date: "2026-08-27", sku: "SKU-A", child_asin: "B0A", currency: "USD", amazon_order_status: "Shipped", fulfillment_channel: "AFN", address_state: "CA", address_city: "LA", amazon_order_id: "", order_id_available: false, is_cancelled: false, total_sales_sum: 0, total_units_sum: 1 },
  ];
  const summary = summarizeExplicitZeroOli(dim, { brand: "ALL", orderAuditRows: audit });
  const future = summary.breakdown.find((b) => b.sku === "SKU-A");
  const historical = summary.breakdown.find((b) => b.sku === "SKU-OLD");
  assert.equal(future.hasAudit, true);
  assert.deepEqual(future.orderIds.map((o) => o.orderId).sort(), ["", "111-2223334-4445556"]);
  assert.ok(future.orderIds.some((o) => o.orderIdAvailable && o.orderId === "111-2223334-4445556"), "captured id present");
  assert.ok(future.orderIds.some((o) => !o.orderIdAvailable), "source-unavailable order present");
  assert.equal(historical.hasAudit, false, "a pre-tracking grain has NO audit -> UI shows 'Not captured'");
  assert.deepEqual(historical.orderIds, []);
  assert.deepEqual(summary.orderIdTracking, { captured: 1, unavailable: 1 });
  // Business units are unchanged by the merge (audit is display-only).
  assert.equal(future.units, 2);
});

// ---- structural: the REAL migration proves the atomic order-audit block on the SAME RPC ---------------------
test("S. the REAL 20260827 migration + schema-contract audit CLEAN (order-audit block proven on the replace RPC)", () => {
  const readFile = (name) => name === "supabase.js" ? readFileSync("lib/server/supabase.js", "utf8") : readFileSync(path.join("supabase/migrations", name), "utf8");
  const res = auditSchemaContract({ readFile });
  assert.equal(res.ok, true, "schema-contract audit must be green: " + JSON.stringify(res.blockers));
  // The 20260827 entry (which registers BOTH the replace-oli-dimensional and replace-oli-order-audit proofs) is clean.
  const row = res.matrix.find((m) => m.migration === "20260827_oli_order_audit.sql");
  assert.ok(row, "the 20260827 migration entry is audited");
  assert.ok(row.provenFunctions.every((p) => p.ok), "both function proofs pass: " + JSON.stringify(row.provenFunctions));
  // The migration ATOMICALLY replaces the order audit inside the SAME window as the dimensional/rollup/coverage.
  const sql = readFileSync("supabase/migrations/20260827_oli_order_audit.sql", "utf8");
  assert.match(sql, /delete\s+from\s+public\.source_oli_order_audit[\s\S]*sale_date\s+between\s+p_covered_from\s+and\s+p_covered_to/i);
  assert.match(sql, /insert\s+into\s+public\.source_oli_order_audit/i);
  assert.match(sql, /md5\s*\(\s*concat_ws/i);
  assert.match(sql, /order_id_available\s*=\s*\(char_length/i, "order_id_available is DB-pinned to a non-blank Order ID");
  assert.ok(!/insert\s+into\s+public\.source_oli_dimensional_history[\s\S]{0,400}amazon_order_id/i.test(sql), "the dimensional insert never carries amazon_order_id (business grain byte-identical)");
  // The HASHFIX (20260828) is the authoritative runtime RPC: its md5 date argument must be grouped-aligned
  // ((o->>'sale_date')::date), guarding against the SQLSTATE 42803 regression.
  const fix = readFileSync("supabase/migrations/20260828_oli_order_audit_hashfix.sql", "utf8");
  const md5arg = fix.slice(fix.indexOf("md5(concat_ws("));
  assert.match(md5arg.slice(0, 260), /\(o->>'sale_date'\)::date/, "the md5 surrogate groups sale_date as ::date (matches the GROUP BY)");
  assert.ok(!/md5\(concat_ws\([\s\S]{0,200}\(o->>'sale_date'\)\s*,/.test(fix), "the md5 never references the ungrouped TEXT sale_date");
  const fixRow = res.matrix.find((m) => m.migration === "20260828_oli_order_audit_hashfix.sql");
  assert.ok(fixRow && fixRow.provenFunctions.every((p) => p.ok), "the corrected RPC proofs pass: " + JSON.stringify(fixRow && fixRow.provenFunctions));
});

async function main() {
  for (const t of tests) {
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (e) { out("FAIL  " + t.name + "\n" + (e && e.stack ? e.stack : e)); process.exitCode = 1; }
  }
  out(`\n${passed}/${tests.length} order-audit assertions passed`);
}
main();
