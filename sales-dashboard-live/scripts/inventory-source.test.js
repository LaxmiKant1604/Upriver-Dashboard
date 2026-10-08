// Phase 2 of the Listings inventory cutover: the shared Listings fold (duplicate / identity rules) and the per-account
// inventory-source decision with the labelled FBA Inventory Health fallback. Pure, offline. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { foldListingsInventory, listingsValidation, listingsAsin } from "../lib/server/listings-inventory.js";
import { selectAccountInventory, foldHealthInventory, inventorySourceLabel, selectionFoldView } from "../lib/server/inventory-source.js";
import { brandCountryInventory } from "../lib/server/listings-inventory.js";

let passed = 0;
const test = (name, fn) => { try { fn(); passed += 1; console.log("  ok  " + name); } catch (e) { console.error("FAIL  " + name); console.error(e && e.stack ? e.stack : e); process.exitCode = 1; } };
const L = (o = {}) => ({ seller_or_vendor_id: "S1", marketplace_country_code: "IN", sku: "SKU-A", child_asin: "B0A", fnsku: "X0A", listing_fulfillment_channel: "AMAZON_IN",
  fba_quantity_available: 5, fba_quantity_inbound: 2, fba_quantity_reserved: 1, fba_quantity_fc_transfer: 0, awd_available_distributable_quantity: null, awd_total_inbound_quantity: null, ...o });
const H = (o = {}) => ({ date: "2026-10-07", sku: "SKU-A", child_asin: "B0A", available: 4, inbound_working: 1, inbound_shipped: 1, inbound_received: 0, reserved_customer_order: 1, reserved_fc_transfer: 3, reserved_fc_processing: 0, ...o });
const fold = (rows, o = {}) => foldListingsInventory(rows, { marketplace: "IN", ...o });
const notExpandedRow = (o = {}) => { const r = L(o); delete r.fba_quantity_inbound; delete r.fba_quantity_reserved; delete r.fba_quantity_fc_transfer; return r; };

/* duplicates */
test("identical same-SKU listing rows (identity, channel, FNSKU, quantities) count ONCE -- never summed", () => {
  const f = fold([L(), L(), L({ listing_current_quantity: 9 })]);
  assert.equal(f.byAsin.get("B0A").fbaAvailable, 5); assert.equal(f.conflicts.length, 0); assert.equal(f.skus.get("SKU-A").duplicates, 2);
});
test("QUANTITY conflict (different FBA quantity or FNSKU) is never resolved: quantities unknown, reported", () => {
  const q = fold([L(), L({ fba_quantity_available: 6 })]);
  assert.equal(q.byAsin.get("B0A").fbaAvailable, null); assert.deepEqual(q.conflicts[0].reasons, ["duplicate-different-quantities"]);
  const fn = fold([L(), L({ fnsku: "X0B" })], { asinForSku: () => "B0A" });
  assert.equal(fn.byAsin.get("B0A").fbaAvailable, null); assert.deepEqual(fn.conflicts[0].reasons, ["duplicate-different-fnsku"]);
});
test("IDENTITY conflict, different ASIN: R2 resolves ONLY to the account's own unique sales ASIN when it is one of the rows'", () => {
  const rows = [L(), L({ child_asin: "B0NEW" })];
  const r = fold(rows, { asinForSku: () => "B0NEW" });
  assert.equal(r.conflicts.length, 0); assert.equal(r.byAsin.get("B0NEW").fbaAvailable, 5); assert.ok(!r.byAsin.has("B0A"), "the stock is placed ONCE");
  assert.deepEqual(r.resolvedConflicts.map((c) => [c.sku, c.asin, c.rules.join()]), [["SKU-A", "B0NEW", "R2-sales-asin"]]);
  const none = fold(rows); // no sales evidence
  assert.equal(none.conflicts.length, 1); assert.equal(none.byAsin.get("B0A").fbaAvailable, null); assert.equal(none.byAsin.get("B0NEW").fbaAvailable, null);
  const other = fold(rows, { asinForSku: () => "B0ELSE" }); // sales ASIN not among the rows: not proof
  assert.equal(other.conflicts.length, 1);
});
test("IDENTITY conflict, different channel: R3 resolves to FBA only when EVERY row reports positive FBA available", () => {
  const pos = fold([L(), L({ listing_fulfillment_channel: "DEFAULT" })]);
  assert.equal(pos.conflicts.length, 0); assert.equal(pos.skus.get("SKU-A").channel, "AMAZON_IN"); assert.equal(pos.byAsin.get("B0A").fbaContext, "fba");
  assert.deepEqual(pos.resolvedConflicts[0].rules, ["R3-fba-stock-channel"]);
  const zero = fold([L({ fba_quantity_available: 0 }), L({ fba_quantity_available: 0, listing_fulfillment_channel: "DEFAULT" })]);
  assert.equal(zero.conflicts.length, 1); assert.deepEqual(zero.conflicts[0].reasons, ["duplicate-different-fulfillment-channel"]);
  assert.equal(zero.byAsin.get("B0A").fbaAvailable, null, "unresolved: unknown, never 0");
});
test("ASIN + channel conflict resolves only when BOTH rules hold", () => {
  const rows = [L(), L({ child_asin: "B0NEW", listing_fulfillment_channel: "DEFAULT" })];
  assert.equal(fold(rows, { asinForSku: () => "B0A" }).conflicts.length, 0);
  assert.equal(fold(rows).conflicts.length, 1);
});
/* identity: placeholder ASIN */
test("__EMPTY__ is a MISSING ASIN: it takes the group's single real ASIN, else the unique sales ASIN, else unattributed (stock kept, reported)", () => {
  assert.equal(listingsAsin("__EMPTY__"), "");
  const g = fold([L(), L({ child_asin: "__EMPTY__" })]);
  assert.equal(g.conflicts.length, 0); assert.equal(g.byAsin.get("B0A").fbaAvailable, 5);
  const s = fold([L({ child_asin: "__EMPTY__" })], { asinForSku: () => "B0SOLD" });
  assert.equal(s.byAsin.get("B0SOLD").fbaAvailable, 5); assert.equal(s.asinResolved, 1);
  const u = fold([L({ child_asin: "__EMPTY__" })]);
  assert.ok(!u.byAsin.has("__EMPTY__")); assert.deepEqual([u.unattributed.skus, u.unattributed.skusWithStock, u.unattributed.fbaAvailable], [1, 1, 5]);
});
/* AWD */
test("AWD (owner decision 2026-10-08): explicit number kept; explicit 0 kept (NOT assumed); BLANK on an AWD-eligible marketplace = ASSUMED 0 (flagged + counted); missing column unknown; non-eligible null (N/A)", () => {
  const f = (o, opt = { marketplace: "US", awdEligible: true }) => fold([L({ marketplace_country_code: "US", ...o })], opt);
  assert.equal(f({ awd_available_distributable_quantity: 7 }).skus.get("SKU-A").awdAvailable, 7);
  const z = f({ awd_available_distributable_quantity: 0, awd_total_inbound_quantity: 0 });
  assert.equal(z.skus.get("SKU-A").awdAvailable, 0); assert.equal(z.skus.get("SKU-A").awdAssumedZero, false); assert.equal(z.awdAssumedZeroSkus, 0, "an explicit DataDoe 0 is never counted as assumed");
  const b = f({ awd_available_distributable_quantity: null, awd_total_inbound_quantity: null });
  assert.equal(b.skus.get("SKU-A").awdAvailable, 0); assert.equal(b.skus.get("SKU-A").awdInbound, 0);
  assert.equal(b.skus.get("SKU-A").awdAssumedZero, true); assert.equal(b.awdAssumedZeroSkus, 1); assert.equal(b.byAsin.get("B0A").awdAssumedZero, true);
  const missing = L({ marketplace_country_code: "US" }); delete missing.awd_available_distributable_quantity; delete missing.awd_total_inbound_quantity;
  assert.equal(fold([missing], { marketplace: "US", awdEligible: true }).skus.get("SKU-A").awdAvailable, null, "a NOT-REQUESTED AWD column stays unknown");
  assert.equal(fold([L({ awd_available_distributable_quantity: 7 })], { awdEligible: false }).skus.get("SKU-A").awdAvailable, null, "non-AWD marketplace: not applicable");
});
test("BRIDGE: the saved Health snapshot is usable only within HEALTH_BRIDGE_MAX_AGE_DAYS (2) of the report as-of; older or no as-of -> unavailable (never 0)", () => {
  const old = notExpandedRow();
  const fresh = selectAccountInventory({ listingsRows: [old], healthRows: [H({ date: "2026-10-06" })], marketplace: "IN", asOf: "2026-10-08" });
  assert.equal(fresh.source, "health-fallback"); assert.equal(fresh.healthDate, "2026-10-06");
  const stale = selectAccountInventory({ listingsRows: [old], healthRows: [H({ date: "2026-10-05" })], marketplace: "IN", asOf: "2026-10-08" });
  assert.equal(stale.source, "unavailable"); assert.deepEqual(stale.healthReasons, ["health-bridge-stale:2026-10-05"]); assert.equal(stale.byAsin.size, 0);
  const noAsOf = selectAccountInventory({ listingsRows: [old], healthRows: [H()], marketplace: "IN" });
  assert.equal(noAsOf.source, "unavailable"); assert.deepEqual(noAsOf.healthReasons, ["health-bridge-as-of-missing"]);
  assert.match(inventorySourceLabel({ source: "health-fallback", healthDate: "2026-10-06", listingsReasons: ["listings-not-expanded"] }), /saved, no longer refreshed -- temporary bridge/);
});
/* validation */
test("listingsValidation: every reason is evidence-based (not expanded / unresolved conflict / unattributed stock / blank FBA field)", () => {
  assert.deepEqual(listingsValidation([L()], fold([L()])), { ok: true, reasons: [] });
  const old = L(); delete old.fba_quantity_inbound; delete old.fba_quantity_reserved; delete old.fba_quantity_fc_transfer;
  assert.ok(listingsValidation([old], fold([old])).reasons.includes("listings-not-expanded"), "a 15-column snapshot was never asked for the fields");
  const c = [L(), L({ fba_quantity_available: 9 })];
  assert.ok(listingsValidation(c, fold(c)).reasons.includes("listings-unresolved-conflicts:1"));
  const u = [L({ child_asin: "__EMPTY__" })];
  assert.ok(listingsValidation(u, fold(u)).reasons.includes("listings-unattributed-stock:1"));
  const b = [L({ fba_quantity_inbound: null })];
  assert.ok(listingsValidation(b, fold(b)).reasons.includes("listings-blank-fba-fields:1"));
  assert.deepEqual(listingsValidation([], fold([])).reasons, ["listings-empty"]);
});
/* source selection */
test("validated Listings -> source listings (Listings quantities, no Health)", () => {
  const sel = selectAccountInventory({ listingsRows: [L()], healthRows: [H()], marketplace: "IN", asOf: "2026-10-08" });
  assert.equal(sel.source, "listings"); assert.equal(sel.byAsin.get("B0A").fbaAvailable, 5); assert.equal(sel.byAsin.get("B0A").fbaInbound, 2);
});
test("NOT validated + a Health snapshot -> health-fallback: latest Health date only; inbound = working+shipped+received; reserved / FC transfer unavailable; reasons kept", () => {
  const old = L(); delete old.fba_quantity_inbound; delete old.fba_quantity_reserved; delete old.fba_quantity_fc_transfer;
  const sel = selectAccountInventory({ listingsRows: [old], healthRows: [H(), H({ date: "2026-10-01", available: 999 })], marketplace: "IN", asOf: "2026-10-08" });
  assert.equal(sel.source, "health-fallback"); assert.equal(sel.healthDate, "2026-10-07"); assert.deepEqual(sel.listingsReasons, ["listings-not-expanded"]);
  const a = sel.byAsin.get("B0A");
  assert.deepEqual([a.fbaAvailable, a.fbaInbound, a.fbaReserved, a.fbaFcTransfer], [4, 2, null, null]);
  assert.match(inventorySourceLabel({ source: sel.source, healthDate: sel.healthDate, listingsReasons: sel.listingsReasons }), /^FBA Inventory Health snapshot 2026-10-07 \(saved, no longer refreshed -- temporary bridge: listings-not-expanded\)$/);
});
test("health-fallback: a blank Health cell stays unknown; a Listings-only merchant-fulfilled product is mfn-only; an unlisted sold ASIN is absent (unknown)", () => {
  const conflict = [L(), L({ fba_quantity_available: 9 }), L({ sku: "MFN-1", child_asin: "B0M", listing_fulfillment_channel: "DEFAULT", fba_quantity_available: 0, fba_quantity_inbound: 0, fba_quantity_reserved: 0, fba_quantity_fc_transfer: 0 })];
  const sel = selectAccountInventory({ listingsRows: conflict, healthRows: [H({ inbound_shipped: null })], marketplace: "IN", asOf: "2026-10-08" });
  assert.equal(sel.source, "health-fallback"); assert.equal(sel.byAsin.get("B0A").fbaInbound, null);
  assert.equal(sel.byAsin.get("B0M").fbaContext, "mfn-only"); assert.ok(!sel.byAsin.has("B0GONE"));
  assert.equal(sel.conflicts.length, 1, "the unresolved Listings conflict is still reported");
});
test("NOT validated + no Health -> unavailable (never a guessed figure)", () => {
  const sel = selectAccountInventory({ listingsRows: [L({ fba_quantity_inbound: null })], healthRows: [], marketplace: "IN", asOf: "2026-10-08" });
  assert.equal(sel.source, "unavailable"); assert.equal(sel.byAsin.size, 0); assert.deepEqual(sel.listingsReasons, ["listings-blank-fba-fields:1"]);
});
test("foreign-marketplace Listings rows: never used for identity in the fallback", () => {
  const sel = selectAccountInventory({ listingsRows: [L({ marketplace_country_code: "DE", listing_fulfillment_channel: "DEFAULT", fba_quantity_available: 0, fba_quantity_inbound: 0, fba_quantity_reserved: 0, fba_quantity_fc_transfer: 0 })], healthRows: [H()], marketplace: "IN", asOf: "2026-10-08" });
  assert.equal(sel.source, "health-fallback"); assert.ok(sel.listingsReasons.includes("listings-foreign-marketplace-rows")); assert.deepEqual([...sel.byAsin.keys()], ["B0A"]);
});
test("foldHealthInventory never invents a 0 for a blank available", () => {
  assert.equal(foldHealthInventory([H({ available: null })]).byAsin.get("B0A").fbaAvailable, null);
});
test("selectionFoldView feeds the shared brand roll-up from the SELECTED source (Health fallback ignores Listings' unplaced SKUs)", () => {
  const old = L(); delete old.fba_quantity_inbound; delete old.fba_quantity_reserved; delete old.fba_quantity_fc_transfer;
  const fb = selectAccountInventory({ listingsRows: [old, { ...old, sku: "NOASIN", child_asin: "__EMPTY__" }], healthRows: [H()], marketplace: "IN", asOf: "2026-10-08" });
  assert.deepEqual(brandCountryInventory(selectionFoldView(fb), { country: "IN", brandOf: () => "Acme" }), [{ country: "IN", brand: "Acme", fbaAvailable: 4, skuCount: 1 }]);
  const ls = selectAccountInventory({ listingsRows: [L()], healthRows: [], marketplace: "IN", asOf: "2026-10-08" });
  assert.deepEqual(brandCountryInventory(selectionFoldView(ls), { country: "IN", brandOf: () => "Acme" }), [{ country: "IN", brand: "Acme", fbaAvailable: 5, skuCount: 1 }]);
});
/* Health fold rules (fallback) */
const notExpanded = (o = {}) => { const r = L(o); delete r.fba_quantity_inbound; delete r.fba_quantity_reserved; delete r.fba_quantity_fc_transfer; return r; };
test("Health fold: another marketplace's Health rows are an integrity failure -> the fallback is NOT used (unavailable)", () => {
  const sel = selectAccountInventory({ listingsRows: [notExpanded()], healthRows: [H(), H({ sku: "SKU-DE", marketplace_country_code: "DE" })], marketplace: "IN", asOf: "2026-10-08" });
  assert.equal(sel.source, "unavailable"); assert.deepEqual(sel.healthReasons, ["health-foreign-marketplace-rows"]);
});
test("Health fold: a negative / non-numeric cell is invalid -> unknown (counted), never used", () => {
  const h = foldHealthInventory([H({ available: -3, inbound_shipped: "abc" })], { marketplace: "IN", asOf: "2026-10-08" });
  assert.equal(h.byAsin.get("B0A").fbaAvailable, null); assert.equal(h.byAsin.get("B0A").fbaInbound, null); assert.equal(h.invalidCells, 2);
});
test("Health fold: identical duplicate SKU rows count ONCE; differing duplicates make the SKU unknown (reported)", () => {
  assert.equal(foldHealthInventory([H(), H()], { marketplace: "IN" }).byAsin.get("B0A").fbaAvailable, 4);
  const c = foldHealthInventory([H(), H({ available: 7 })], { marketplace: "IN", asOf: "2026-10-08" });
  assert.equal(c.byAsin.get("B0A").fbaAvailable, null); assert.deepEqual(c.healthConflicts, ["SKU-A"]);
});
test("Health fold: a row without child_asin is reported (missingAsinRows / with stock), never silently dropped", () => {
  const h = foldHealthInventory([H(), H({ sku: "NO-ASIN", child_asin: "" })], { marketplace: "IN", asOf: "2026-10-08" });
  assert.equal(h.missingAsinRows, 1); assert.equal(h.missingAsinWithStock, 1);
});
test("Health fold: a BLANK available is 0 ONLY when the same account's Listings explicitly reports 0 for that SKU; else unknown", () => {
  const zeroL = fold([notExpanded({ fba_quantity_available: 0 })]);
  const h0 = foldHealthInventory([H({ available: null })], { marketplace: "IN", listingsFold: zeroL });
  assert.equal(h0.byAsin.get("B0A").fbaAvailable, 0); assert.equal(h0.availableFilledFromListings, 1);
  const posL = fold([notExpanded({ fba_quantity_available: 3 })]);
  assert.equal(foldHealthInventory([H({ available: null })], { marketplace: "IN", listingsFold: posL }).byAsin.get("B0A").fbaAvailable, null, "a positive Listings value never fills a Health blank");
  assert.equal(foldHealthInventory([H({ available: null })], { marketplace: "IN" }).byAsin.get("B0A").fbaAvailable, null, "no Listings evidence -> unknown");
});
test("Health fallback: AWD per ASIN comes from the Listings fold (eligible marketplace), FNSKU carried, selection.skus is the SELECTED source", () => {
  const rows = [notExpanded({ marketplace_country_code: "US", awd_available_distributable_quantity: 9, awd_total_inbound_quantity: 1 })];
  const sel = selectAccountInventory({ listingsRows: rows, healthRows: [H({ marketplace_country_code: "US", fnsku: "X0A" })], marketplace: "US", awdEligible: true, asOf: "2026-10-08" });
  assert.equal(sel.source, "health-fallback"); assert.equal(sel.byAsin.get("B0A").awdAvailable, 9); assert.equal(sel.byAsin.get("B0A").awdInbound, 1);
  assert.equal(sel.skus.get("SKU-A").fnsku, "X0A"); assert.equal(sel.skus.get("SKU-A").fbaAvailable, 4); assert.equal(sel.skus.get("SKU-A").channel, "AMAZON_IN");
});
test("Listings fold: a quantity-conflict SKU is a conflict only (not ALSO unattributed stock)", () => {
  const f = fold([L({ child_asin: "__EMPTY__" }), L({ child_asin: "__EMPTY__", fba_quantity_available: 9 })]);
  assert.equal(f.conflicts.length, 1); assert.equal(f.unattributed.skusWithStock, 0);
});
console.log(`\ninventory-source: ${passed} passed`);
