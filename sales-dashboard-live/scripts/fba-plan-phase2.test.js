// Listings inventory CUTOVER (owner decisions 2026-10-08), building on phase 2 -- the FBA Shipment Plan consumer (derive +
// payload contract + client view). NO FBA Inventory Health export exists any more: per account the plan uses the
// VALIDATED canonical Listings snapshot, else the account's LAST SAVED FBA Inventory Health snapshot as a READ-ONLY bridge
// (context.fbaPlanHealthBridge, injected by the durable loader) only while its date >= the plan's inventory as-of - 2 days,
// else Unavailable -- in ONE Listings-model payload. Proves, through the REAL fba-plan derive (REPORT_DERIVATIONS["fba-plan"]):
//   (1) validated Listings -> source "listings" (no inventory date; no Health fragment needed or read);
//   (2) the bridge: fresh (same day / 2 days old) -> labelled fallback; stale (3 days) / missing / refused / after the
//       as-of / no as-of -> Unavailable with the typed reason + the snapshot date, never 0; a foreign seller's bridge row
//       blocks (fail closed); a stale bridge is never identity evidence;
//   (3) no Health fragment is required: a US account with Listings only derives; only a missing / failed / capped Listings
//       source still blocks the US AWD requirement;
//   (4) duplicates (identical / R2 / R3 / quantity conflict) + the "__EMPTY__" ASIN (unchanged phase-2 rules);
//   (5) AWD: a BLANK cell on an AWD marketplace is ASSUMED 0 -- flagged per row (awdAssumedZero) + counted per account
//       (awdAssumedZeroSkus); an explicit DataDoe 0 is NOT flagged; a non-AWD marketplace carries no AWD (null);
//   (6) the client: a non-AWD marketplace contributes 0 AWD (planning never blocked -- India), an AWD marketplace whose
//       AWD source is not validated is unknown (never silently AWD-less), WDD cover gets 0 AWD for a non-AWD marketplace;
//   (7) the client view + labels (bridge / stale bridge / "AWD blank treated as 0"), the App.jsx notices and the N/A
//       AWD columns; (8) the version / validator / route seams.
// Offline: no DataDoe, no Supabase, no network. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { REPORT_DERIVATIONS } from "../lib/server/sync/report-derivation.js";
import { fbaPlanPayload } from "../lib/server/reports/derivation-core.js";
import { planMonthWindows, addDaysStr } from "../lib/server/date-windows.js";
import { slicedOliSourceFromHistory } from "../lib/server/sync/durable-dashboards.js";
import { fbaPlanHealthBridgeFromSnapshot } from "../lib/server/sync/fba-plan-health-bridge.js";
import { adaptFbaPlanPayload, fbaPlanInventoryView, fbaPlanInventoryReasonText, fbaPlanHealthReasonText, computePlanRow } from "../src/lib/fba-planning.js";
import { computeAsinWdd } from "../src/lib/fba-wdd.js";

let passed = 0;
const test = (name, fn) => { try { fn(); passed += 1; console.log("  ok  " + name); } catch (e) { console.error("FAIL  " + name); console.error(e && e.stack ? e.stack : e); process.exitCode = 1; } };
console.log("fba-plan-phase2 (cutover)");

const entry = REPORT_DERIVATIONS["fba-plan"];
const ASOF = "2026-10-06";
const { completed, current } = planMonthWindows(ASOF);
const LISTINGS_AT = "2026-10-06T16:31:00.000Z";
const HEALTH_AT = "2026-10-06T03:05:00.000Z";
const L = (o = {}) => ({
  seller_or_vendor_id: "S1", marketplace_country_code: "IN", sku: "SKU-A", child_asin: "B0A", fnsku: "X0A",
  listing_name: "Listing A", listing_status: "Active", listing_price_value: 10, listing_price_currency: "INR",
  listing_current_quantity: 0, listing_fulfillment_channel: "AMAZON_IN", listing_open_date: "2025-01-01T00:00:00.000Z",
  fba_quantity_available: 5, fba_quantity_inbound: 2, fba_quantity_reserved: 1, fba_quantity_fc_transfer: 3,
  awd_available_distributable_quantity: null, awd_total_inbound_quantity: null, ...o,
});
const L15 = (o = {}) => { const r = L(o); delete r.fba_quantity_inbound; delete r.fba_quantity_reserved; delete r.fba_quantity_fc_transfer; return r; };
const H = (o = {}) => ({ date: ASOF, seller_or_vendor_id: "S1", marketplace_country_code: "IN", sku: "SKU-A", child_asin: "B0A", product_name: "Health A", available: 4, inbound_working: 1, inbound_shipped: 2, inbound_received: 3, reserved_customer_order: 7, reserved_fc_transfer: 8, reserved_fc_processing: 9, ...o });
const sale = (sku, asin, units = 2, date = "2026-09-10") => ({ account_id: "S1", sale_date: date, seller_or_vendor_id: "S1", sku, child_asin: asin, currency: "INR", sales_amount: 0, units });
// The READ-ONLY bridge as the durable loader delivers it (fba-plan-health-bridge.js) from the account's saved pointer.
const bridgeOf = (rows) => fbaPlanHealthBridgeFromSnapshot({ snapshot: { source_key: "fba-inventory-health", scope_key: "S1", row_count: rows.length, validated_at: HEALTH_AT }, rows, accountId: "S1", rawSellerId: "S1" });

// health: the saved bridge rows (null = no saved snapshot); bridge: an explicit context.fbaPlanHealthBridge override.
function derive({ mkt = "IN", listings = undefined, listingsFrag = {}, health = [H()], bridge = undefined, inventoryAsOf = ASOF, sales = [sale("SKU-A", "B0A")], catalog = [{ child_asin: "B0A", product_brand: "Acme", product_name: "Prod A" }] } = {}) {
  const oli = slicedOliSourceFromHistory({ historyRows: sales, accountId: "S1", rawSellerId: "S1", from: completed[0].from, to: ASOF });
  // NO Health fragment: the canonical Listings (fba-plan:awd) is the only owned source.
  const sources = {};
  if (listings !== undefined) sources["fba-plan:awd"] = { available: true, rows: listings, fragments: [{ from: null, to: null, sellerOrVendorIds: ["S1"], fetchedAt: LISTINGS_AT, ...listingsFrag }] };
  const context = {
    to: ASOF, inventoryAsOf, rawSellerId: "S1", accountName: "t", marketCountry: mkt, isUS: mkt === "US",
    fbaPlanDurableOli: { available: true, rows: oli.rows, fragments: oli.fragments },
    fbaPlanDurableCatalog: { available: true, rows: catalog, fragments: [{ from: completed[0].from, to: current.to, sellerOrVendorIds: ["S1"] }] },
  };
  const b = bridge !== undefined ? bridge : (health == null ? undefined : bridgeOf(health));
  if (b !== undefined) context.fbaPlanHealthBridge = b;
  return entry.derive({ sources, context });
}
const row = (p, asin) => p.rows.find((r) => r.asin === asin) || null;
const fbaQ = (r) => [r.fbaAvailable, r.fbaInbound, r.fbaReservedTotal, r.fbaFcTransfer];

/* (1) validated Listings */
test("1 a validated expanded Listings snapshot -> source listings: Listings quantities, no inventory date, the bridge never consulted", () => {
  const p = derive({ listings: [L()] });
  assert.equal(p.inventoryModel, "listings-v1");
  assert.equal(p.inventorySource, "listings");
  assert.deepEqual(p.inventoryListingsReasons, []);
  assert.equal(p.inventoryAvailable, true); assert.equal(p.inventoryUnavailableReason, null);
  assert.equal(p.inventoryHealthDate, null); assert.equal(p.inventoryDate, null, "Listings has no inventory date (no D-1 claim)");
  assert.equal(p.inventoryStale, false, "a Listings plan is never 'stale vs the requested D-1' (its age comes from listingsRefreshedAt)");
  assert.equal(p.listingsRefreshedAt, LISTINGS_AT); assert.equal(p.healthFetchedAt, null, "the bridge does not drive this plan");
  assert.deepEqual(p.inventoryHealthReasons, []); assert.equal(p.inventoryBridgeSnapshotDate, null);
  assert.equal(p.inventoryAsOf, ASOF); assert.equal(p.inventoryBridgeMaxAgeDays, 2);
  const r = row(p, "B0A");
  assert.deepEqual(fbaQ(r), [5, 2, 1, 3]); assert.equal(r.fbaContext, "fba"); assert.equal(r.inventoryConflict, false);
  for (const k of ["customerOrderReserved", "reservedFcTransfer", "reservedFcProcessing", "inboundWorking", "inboundShipped", "inboundReceived"]) assert.ok(!(k in r), k + " is gone");
  assert.deepEqual(p.inventoryByBrandCountry, [{ country: "IN", brand: "Acme", fbaAvailable: 5, skuCount: 1 }]);
  assert.ok(entry.validatePayload(p));
  assert.equal(derive({ listings: [L()], health: null }).inventorySource, "listings", "no saved Health snapshot at all: Listings still drives the plan");
});

/* (2) the READ-ONLY bridge */
const fallbackCase = (name, listings, reason) => test("2 bridge (fresh): " + name + " -> saved Health available, inbound = working + shipped + received, reserved + FC transfer null, reason " + reason, () => {
  const p = derive({ listings });
  assert.equal(p.inventorySource, "health-fallback");
  assert.equal(p.inventoryAvailable, true);
  assert.ok(p.inventoryListingsReasons.includes(reason), JSON.stringify(p.inventoryListingsReasons));
  assert.equal(p.inventoryHealthDate, ASOF); assert.equal(p.inventoryDate, ASOF);
  assert.equal(p.inventoryStale, false, "the saved snapshot IS the requested D-1");
  assert.equal(p.healthFetchedAt, HEALTH_AT, "the bridge's recorded instant");
  assert.deepEqual(p.inventoryHealthReasons, []); assert.equal(p.inventoryBridgeSnapshotDate, ASOF);
  assert.deepEqual(fbaQ(row(p, "B0A")), [4, 1 + 2 + 3, null, null]);
  assert.deepEqual(p.inventoryByBrandCountry, [{ country: "IN", brand: "Acme", fbaAvailable: 4, skuCount: 1 }]);
  assert.equal(p.inventoryUnattributed, null, "Listings' unplaced SKUs never apply to a Health-sourced plan");
  assert.ok(entry.validatePayload(p));
});
fallbackCase("a 15-column (not expanded) snapshot", [L15()], "listings-not-expanded");
fallbackCase("an unresolved QUANTITY conflict", [L(), L({ fba_quantity_available: 9 })], "listings-unresolved-conflicts:1");
fallbackCase("unattributed stock (__EMPTY__ ASIN, unsold SKU)", [L(), L({ sku: "SKU-Z", child_asin: "__EMPTY__", fnsku: "X0Z", fba_quantity_available: 6 })], "listings-unattributed-stock:1");
fallbackCase("a blank FBA field on an FBA SKU", [L({ fba_quantity_inbound: null })], "listings-blank-fba-fields:1");
test("2 bridge: a snapshot 2 days older than the inventory as-of is still used (shown with its own date, stale-flagged); 3 days older -> Unavailable naming the date (never 0)", () => {
  const two = derive({ listings: [L15()], health: [H({ date: addDaysStr(ASOF, -2) })] });
  assert.equal(two.inventorySource, "health-fallback"); assert.equal(two.inventoryHealthDate, addDaysStr(ASOF, -2));
  assert.equal(two.inventoryStale, true, "older than the requested D-1 (allowed by the 2-day rule, labelled)");
  const three = derive({ listings: [L15()], health: [H({ date: addDaysStr(ASOF, -3) })] });
  assert.equal(three.inventorySource, "unavailable"); assert.equal(three.inventoryAvailable, false);
  assert.deepEqual(three.inventoryHealthReasons, ["health-bridge-stale:" + addDaysStr(ASOF, -3)]);
  assert.equal(three.inventoryBridgeSnapshotDate, addDaysStr(ASOF, -3), "the page can name the saved snapshot date");
  assert.equal(three.inventoryUnavailableReason, "listings-not-validated-and-health-bridge-stale:" + addDaysStr(ASOF, -3));
  assert.deepEqual(fbaQ(row(three, "B0A")), [null, null, null, null], "a stale bridge never drives a figure -- never 0");
  assert.equal(three.inventoryDate, null); assert.equal(three.healthFetchedAt, null);
  assert.deepEqual(three.inventoryByBrandCountry, []);
  assert.ok(!three.accountSkuDirectory.some((e) => e.provenance === "inventory"), "a stale bridge is never identity evidence");
  assert.equal(row(three, "B0A").productName, "Prod A", "product names come from the catalog, never a stale bridge");
});
test("2 bridge: the unresolved Listings conflict stays REPORTED; a snapshot spanning several days folds its LATEST day only (no block)", () => {
  const p = derive({ listings: [L(), L({ fba_quantity_available: 9 })] });
  assert.deepEqual(p.inventoryConflicts.map((c) => [c.sku, c.reasons.join()]), [["SKU-A", "duplicate-different-quantities"]]);
  assert.equal(p.inventoryRequestedThrough, ASOF); assert.equal(p.inventoryStale, false);
  const multi = derive({ listings: [L15()], health: [H(), H({ date: addDaysStr(ASOF, -1), available: 999 })] });
  assert.equal(row(multi, "B0A").fbaAvailable, 4, "the older day's 999 is never summed");
});
test("2 bridge: missing / refused upstream / dated after the as-of -> Unavailable with the typed reason; a foreign seller's bridge row BLOCKS (fail closed)", () => {
  const none = derive({ listings: [L15()], health: null });
  assert.equal(none.inventorySource, "unavailable");
  assert.deepEqual(none.inventoryHealthReasons, ["health-snapshot-missing"]);
  assert.equal(none.inventoryUnavailableReason, "listings-not-validated-and-no-health-snapshot");
  const refused = derive({ listings: [L15()], bridge: { available: false, reason: "health-bridge-rows-invalid:cross-account" } });
  assert.deepEqual(refused.inventoryHealthReasons, ["health-bridge-rows-invalid:cross-account"]);
  const after = derive({ listings: [L15()], health: [H({ date: addDaysStr(ASOF, 1) })] });
  assert.deepEqual(after.inventoryHealthReasons, ["health-bridge-after-as-of:" + addDaysStr(ASOF, 1)]);
  assert.throws(() => derive({ listings: [L15()], bridge: { available: true, rows: [H({ seller_or_vendor_id: "S2" })] } }), /another seller/);
  assert.equal(derive({ listings: [L15()], health: [] }).inventorySource, "unavailable", "an empty saved snapshot is no bridge");
});
test("2 bridge: no inventory as-of -> the bridge is refused (never guessed); a foreign-marketplace bridge is never used", () => {
  const p = fbaPlanPayload({ asOf: null, inventoryAsOf: null, accountName: "t", marketCountry: "IN", isUS: false, completed, current, completedUnitRows: [[{ child_asin: "B0A", units_sum: 1 }], [], []], mtdUnitRows: [], dailyDateRows: [], catalogRows: [], invRows: [H()] });
  assert.equal(p.inventorySource, "unavailable"); assert.deepEqual(p.inventoryHealthReasons, ["health-bridge-as-of-missing"]);
  const de = derive({ listings: [L15()], health: [H(), H({ sku: "SKU-DE", marketplace_country_code: "DE" })] });
  assert.equal(de.inventorySource, "unavailable"); assert.deepEqual(de.inventoryHealthReasons, ["health-foreign-marketplace-rows"]);
});

/* (3) no Health fragment required */
test("3 NO Health fragment is required: the gate never requires the retired request; a US account with Listings only derives (AWD from Listings)", () => {
  assert.ok(!entry.requiredRequestKeys.includes("fba-plan:inventory-health"), "the retired Health request is never required");
  assert.deepEqual([...entry.derivedContextKeys], ["fbaPlanDurableOli", "fbaPlanDurableCatalog", "fbaPlanHealthBridge"]);
  const us = (o) => L({ marketplace_country_code: "US", listing_fulfillment_channel: "AMAZON_NA", ...o });
  const p = derive({ mkt: "US", listings: [us({ awd_available_distributable_quantity: 4, awd_total_inbound_quantity: 1 })], health: null });
  assert.equal(p.inventorySource, "listings"); assert.equal(p.awdAvailable, true);
  assert.deepEqual([row(p, "B0A").awdAvailable, row(p, "B0A").awdInbound], [4, 1]);
  const usNotValidated = derive({ mkt: "US", listings: [L15({ marketplace_country_code: "US" })], health: null });
  assert.equal(usNotValidated.inventorySource, "unavailable", "a US account without a bridge is never blocked by the retired Health source");
});
test("3 only a missing / malformed / capped Listings source still blocks the US AWD requirement; elsewhere the typed reason (bridge or Unavailable)", () => {
  assert.throws(() => derive({ mkt: "US", listings: undefined, health: [H({ marketplace_country_code: "US" })] }), /requires a validated AWD source/);
  assert.throws(() => derive({ mkt: "US", listings: [L({ marketplace_country_code: "US" })], listingsFrag: { from: ASOF }, health: null }), /no-date fragment/);
  const capped = Array.from({ length: 50000 }, (_, i) => L({ sku: "SKU-" + i, child_asin: "B0C" + i, fnsku: "XC" + i }));
  assert.throws(() => derive({ mkt: "US", listings: capped.map((r) => ({ ...r, marketplace_country_code: "US" })), health: null }), /50,000-row provider ceiling/);
  const inCapped = derive({ listings: capped });
  assert.equal(inCapped.inventorySource, "health-fallback"); assert.deepEqual(inCapped.inventoryListingsReasons, ["listings-capped:50000"]);
  assert.equal(inCapped.listingsRefreshedAt, null, "a refused fragment is never presented as the Listings freshness");
  assert.ok(!inCapped.accountSkuDirectory.some((e) => e.sku === "SKU-1"), "a capped fragment never feeds the SKU directory");
  assert.deepEqual(derive({ listings: undefined }).inventoryListingsReasons, ["listings-source-unavailable"]);
  assert.deepEqual(derive({ listings: [L()], listingsFrag: { sellerOrVendorIds: ["S1", "S2"] } }).inventoryListingsReasons, ["listings-fragment-malformed"]);
  assert.notEqual(derive({ listings: capped.slice(0, 49999) }).inventoryListingsReasons[0], "listings-capped:50000", "49,999 rows is below the ceiling");
});

/* (4) duplicates + __EMPTY__ (phase-2 rules, unchanged) */
test("4 identical duplicate listing rows of one SKU are counted ONCE (never summed)", () => {
  assert.deepEqual(fbaQ(row(derive({ listings: [L(), L(), L()] }), "B0A")), [5, 2, 1, 3]);
});
test("4 R2: an ASIN-only identity conflict resolves to the account's own unique SALES ASIN; without that evidence -> unresolved -> the bridge", () => {
  const rows = [L(), L({ child_asin: "B0NEW" })];
  const p = derive({ listings: rows, sales: [sale("SKU-A", "B0NEW")] });
  assert.equal(p.inventorySource, "listings");
  assert.deepEqual(p.inventoryResolvedConflicts.map((c) => [c.sku, c.asin, c.rules.join()]), [["SKU-A", "B0NEW", "R2-sales-asin"]]);
  assert.equal(row(p, "B0NEW").fbaAvailable, 5); assert.equal(row(p, "B0A"), null, "the stock is placed once");
  const none = derive({ listings: rows, sales: [sale("SKU-OTHER", "B0A")] });
  assert.equal(none.inventorySource, "health-fallback"); assert.ok(none.inventoryListingsReasons.includes("listings-unresolved-conflicts:1"));
});
test("4 R3: a channel-only identity conflict resolves to FBA when EVERY row reports positive FBA available", () => {
  const p = derive({ listings: [L(), L({ listing_fulfillment_channel: "DEFAULT" })] });
  assert.equal(p.inventorySource, "listings"); assert.deepEqual(p.inventoryResolvedConflicts[0].rules, ["R3-fba-stock-channel"]);
  assert.equal(derive({ listings: [L({ fba_quantity_available: 0 }), L({ fba_quantity_available: 0, listing_fulfillment_channel: "DEFAULT" })] }).inventorySource, "health-fallback");
});
test("4 a merchant-fulfilled-only product is mfn-only (FBA figures null, never an FBA stockout) and creates no brand bucket", () => {
  const mfn = L({ listing_fulfillment_channel: "DEFAULT", fba_quantity_available: 0, fba_quantity_inbound: 0, fba_quantity_reserved: 0, fba_quantity_fc_transfer: 0 });
  const p = derive({ listings: [mfn], health: null });
  assert.equal(p.inventorySource, "listings"); assert.equal(row(p, "B0A").fbaContext, "mfn-only");
  assert.deepEqual(fbaQ(row(p, "B0A")), [null, null, null, null]); assert.deepEqual(p.inventoryByBrandCountry, []);
});
test("4 an __EMPTY__ ASIN resolves ONLY from the account's own unique sales mapping; never a product key", () => {
  const p = derive({ listings: [L({ child_asin: "__EMPTY__" })], sales: [sale("SKU-A", "B0SOLD")] });
  assert.equal(p.inventorySource, "listings"); assert.equal(row(p, "B0SOLD").fbaAvailable, 5); assert.equal(p.inventoryAsinResolvedFromSales, 1);
  const amb = derive({ listings: [L({ child_asin: "__EMPTY__" })], sales: [sale("SKU-A", "B0X1"), sale("SKU-A", "B0X2")] });
  assert.equal(amb.inventorySource, "health-fallback"); assert.ok(amb.inventoryListingsReasons.includes("listings-unattributed-stock:1"));
  assert.ok(!amb.accountSkuDirectory.some((e) => e.childAsin === "__EMPTY__"));
});

/* (5) AWD (owner decision 2026-10-08) */
test("5 AWD (US): a BLANK cell is ASSUMED 0 -- row awdAssumedZero + account awdAssumedZeroSkus; an explicit DataDoe 0 is NOT flagged; a positive value is not flagged", () => {
  const us = (o) => L({ marketplace_country_code: "US", listing_fulfillment_channel: "AMAZON_NA", ...o });
  const blank = derive({ mkt: "US", listings: [us()], health: null });
  assert.equal(blank.inventorySource, "listings", "a blank AWD cell never invalidates the FBA figures");
  assert.deepEqual([row(blank, "B0A").awdAvailable, row(blank, "B0A").awdInbound, row(blank, "B0A").awdAssumedZero], [0, 0, true]);
  assert.equal(blank.awdAssumedZeroSkus, 1);
  const zero = derive({ mkt: "US", listings: [us({ awd_available_distributable_quantity: 0, awd_total_inbound_quantity: 0 })], health: null });
  assert.deepEqual([row(zero, "B0A").awdAvailable, row(zero, "B0A").awdAssumedZero, zero.awdAssumedZeroSkus], [0, false, 0], "an explicit 0 is a verified 0");
  const pos = derive({ mkt: "US", listings: [us({ awd_available_distributable_quantity: 7, awd_total_inbound_quantity: 2 })], health: null });
  assert.deepEqual([row(pos, "B0A").awdAvailable, row(pos, "B0A").awdAssumedZero, pos.awdAssumedZeroSkus], [7, false, 0]);
  const mixed = derive({ mkt: "US", listings: [us({ awd_available_distributable_quantity: 7, awd_total_inbound_quantity: 2 }), us({ sku: "SKU-B", fnsku: "X0B", awd_available_distributable_quantity: null, awd_total_inbound_quantity: null })], health: null });
  assert.deepEqual([row(mixed, "B0A").awdAvailable, row(mixed, "B0A").awdAssumedZero, mixed.awdAssumedZeroSkus], [7, true, 1], "one blank SKU on the ASIN marks the row");
});
test("5 AWD (EU5 via the bridge too): the AWD still comes from the Listings rows with the same assumption; a non-AWD marketplace carries NO AWD (null, count 0)", () => {
  const de = derive({ mkt: "DE", listings: [L15({ marketplace_country_code: "DE" })], health: [H({ marketplace_country_code: "DE" })] });
  assert.equal(de.inventorySource, "health-fallback"); assert.equal(de.awdAvailable, true);
  assert.deepEqual([row(de, "B0A").awdAvailable, row(de, "B0A").awdAssumedZero, de.awdAssumedZeroSkus], [0, true, 1]);
  const n = derive({ mkt: "IN", listings: [L({ awd_available_distributable_quantity: 9 })] });
  assert.equal(n.awdEligible, false); assert.equal(n.awdAvailable, false);
  assert.deepEqual([row(n, "B0A").awdAvailable, row(n, "B0A").awdAssumedZero, n.awdAssumedZeroSkus], [null, false, 0]);
});
test("5 AWD-dependent totals: an unattributed Listings SKU holding AWD is counted (awdUnattributedSkus); a blank one is an assumed 0 (not counted)", () => {
  const de = (o) => L({ marketplace_country_code: "DE", ...o });
  const p = derive({ mkt: "DE", listings: [de({ awd_available_distributable_quantity: 3 }), de({ sku: "SKU-Q", child_asin: "__EMPTY__", fnsku: "XQ", fba_quantity_available: 0, fba_quantity_inbound: 0, awd_available_distributable_quantity: 40 })], health: [H({ marketplace_country_code: "DE" })] });
  assert.equal(p.awdUnattributedSkus, 1);
  const q = derive({ mkt: "DE", listings: [de({ awd_available_distributable_quantity: 3 }), de({ sku: "SKU-Q", child_asin: "__EMPTY__", fnsku: "XQ", fba_quantity_available: 0, fba_quantity_inbound: 0 })], health: [H({ marketplace_country_code: "DE" })] });
  assert.equal(q.awdUnattributedSkus, 0);
});

/* (6) the client planning engine */
const planArgs = (o = {}) => ({ inventoryAvailable: true, available: 10, fbaInbound: 5, effectiveAsOf: ASOF, daysInCurrentMonth: 31, monthlyValues: [62, 62, 62], forecastMethod: "three-month", safetyDays: 14, ...o });
test("6 a NON-AWD marketplace (India) contributes 0 AWD: the network position = FBA Supply and planning is never blocked by AWD", () => {
  const r = computePlanRow(planArgs({ awdApplicable: false, awdValidated: false, awdAvailable: null }));
  assert.equal(r.awdNotApplicable, true); assert.equal(r.awdAvailable, null, "displayed N/A, never a stock 0");
  assert.equal(r.fbaSupply, 15); assert.equal(r.amazonNetworkPosition, 15);
  assert.ok(r.shortageBeforeWarehouse != null && r.productionRequirement != null && r.planningPriority !== "Unknown", "India planning computes (never blocked by AWD)");
  const ignored = computePlanRow(planArgs({ awdApplicable: false, awdValidated: true, awdAvailable: 99 }));
  assert.equal(ignored.amazonNetworkPosition, 15, "a non-AWD marketplace never adds AWD");
});
test("6 an AWD marketplace: validated AWD (incl. an assumed 0) is added; an UNVALIDATED AWD source leaves the network position unknown (never silently AWD-less)", () => {
  assert.equal(computePlanRow(planArgs({ awdApplicable: true, awdValidated: true, awdAvailable: 6 })).amazonNetworkPosition, 21);
  assert.equal(computePlanRow(planArgs({ awdApplicable: true, awdValidated: true, awdAvailable: 0 })).amazonNetworkPosition, 15);
  const unknown = computePlanRow(planArgs({ awdApplicable: true, awdValidated: false, awdAvailable: null }));
  assert.equal(unknown.amazonNetworkPosition, null); assert.equal(unknown.planningPriority, "Unknown");
  assert.equal(computePlanRow(planArgs({ awdValidated: false })).amazonNetworkPosition, 15, "a legacy caller (no awdApplicable) keeps the former behaviour");
});
test("6 WDD cover: a non-AWD marketplace passes 0 AWD (cover computes); an unknown AWD keeps the cover unknown", () => {
  const base = { dailyUnits: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [addDaysStr(ASOF, -i), 2])), effectiveAsOf: ASOF, coverageFrom: addDaysStr(ASOF, -59), weights: { w7: 34, w30: 33, w60: 33 }, leadTime: { production: 10, shipping: 10, awd: 0, safety: 5, inboundEta: addDaysStr(ASOF, 10) }, marketplaceToday: ASOF, fbaAvailable: 10, inboundPipeline: 5 };
  const india = computeAsinWdd({ ...base, awdAvailable: 0 });
  assert.notEqual(india.existingCover, null); assert.notEqual(india.reorderStatus, "Unavailable");
  assert.equal(computeAsinWdd({ ...base, awdAvailable: null }).existingCover, null);
});

/* (7) client view + labels + App.jsx notices */
test("7 view: a fresh bridge is the labelled fallback; a stale bridge is Unavailable with the date, the 2-day rule and human-readable reasons", () => {
  const fb = fbaPlanInventoryView(derive({ listings: [L15()] }), Date.parse(LISTINGS_AT) + 99 * 3600000);
  assert.deepEqual([fb.source, fb.fallback, fb.healthDate, fb.listingsStale, fb.bridgeStale], ["health-fallback", true, ASOF, false, false]);
  assert.deepEqual(fb.reasons, ["this account's Listings snapshot does not yet include the new inventory fields"]);
  const st = fbaPlanInventoryView(derive({ listings: [L15()], health: [H({ date: addDaysStr(ASOF, -3) })] }));
  assert.deepEqual([st.source, st.inventoryOk, st.bridgeStale, st.bridgeSnapshotDate, st.bridgeMaxAgeDays, st.inventoryAsOf], ["unavailable", false, true, addDaysStr(ASOF, -3), 2, ASOF]);
  assert.match(st.healthReasons[0], new RegExp("saved FBA Inventory Health snapshot of " + addDaysStr(ASOF, -3) + " is more than 2 days older than this plan's inventory date \\(" + ASOF + "\\), and FBA Inventory Health is no longer refreshed"));
  const none = fbaPlanInventoryView(derive({ listings: [L15()], health: null }));
  assert.deepEqual([none.bridgeStale, none.healthReasons], [false, ["there is no saved FBA Inventory Health snapshot for this account"]]);
  assert.match(fbaPlanHealthReasonText("health-bridge-rows-invalid:cross-account"), /could not be verified/);
  assert.match(fbaPlanHealthReasonText("health-foreign-marketplace-rows"), /another marketplace/);
  const lst = fbaPlanInventoryView(derive({ listings: [L()] }), Date.parse(LISTINGS_AT) + 2 * 3600000);
  assert.deepEqual([lst.source, lst.fallback, lst.listingsRefreshedAt, lst.listingsStale, lst.healthReasons.length], ["listings", false, LISTINGS_AT, false, 0]);
  assert.equal(fbaPlanInventoryView(derive({ listings: [L()] }), Date.parse(LISTINGS_AT) + 37 * 3600000).listingsStale, true);
  assert.equal(fbaPlanInventoryReasonText("listings-unresolved-conflicts:3"), "3 SKUs have conflicting duplicate Listings rows");
  assert.match(fbaPlanInventoryReasonText("listings-capped:50000"), /50,000-row limit/);
});
test("7 view: awdAssumedZeroSkus is surfaced only for an AWD marketplace with Listings AWD; a non-AWD marketplace reports awdApplicable false", () => {
  const us = derive({ mkt: "US", listings: [L({ marketplace_country_code: "US", listing_fulfillment_channel: "AMAZON_NA" })], health: null });
  const v = fbaPlanInventoryView(us);
  assert.deepEqual([v.awdApplicable, v.awdAssumedZeroSkus], [true, 1]);
  const n = fbaPlanInventoryView(derive({ listings: [L()] }));
  assert.deepEqual([n.awdApplicable, n.awdAssumedZeroSkus], [false, 0]);
});
test("7 App.jsx: the concise 'AWD blank treated as 0' notice (banner + row marker + KPI subtext), the bridge + stale-bridge labels and the N/A AWD columns", () => {
  const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  for (const s of [
    "AWD blank treated as 0 ({planInventory.awdAssumedZeroSkus.toLocaleString(\"en-US\")} SKU",
    "data-awd-assumed-zero={planInventory.awdAssumedZeroSkus}",
    "<span data-awd-assumed=\"kpi\"> \u00b7 AWD blank treated as 0</span>",
    "const PLAN_AWD_ASSUMED_TITLE = \"AWD blank treated as 0:",
    "(saved, no longer refreshed \u2014 temporary bridge)",
    "FBA Inventory Health is no longer refreshed, so that snapshot is not used.",
    "data-health-bridge={planInventory.bridgeStale ? \"stale\"",
    "const awdNaTd = (key) => <td key={key} className=\"mono plan-awd-na\"",
    "awd: (r) => (r.awdNA ? \"N/A\" : expNum(r.awd))",
    "awdApplicable: planAwdEligible",
  ]) assert.ok(app.includes(s), "App.jsx carries: " + s);
  assert.ok(!app.includes("(planAwdEligible || !c.awd)"), "the AWD columns are no longer hidden for a non-AWD marketplace");
  assert.ok(!app.includes("g.cols.filter((c) => isUS || !c.awd)"), "the chooser offers the AWD columns everywhere");
});

/* (8) version + validator + route seams */
test("8 snapshot version fba-plan/v3-cutover; the validator accepts the new AND a pre-phase-2 payload; latestDataDate never counts a stale bridge", () => {
  assert.equal(entry.snapshotVersion, "fba-plan/v3-cutover");
  assert.deepEqual([...entry.optionalRequestKeys], ["fba-plan:awd"]);
  const legacy = { asOf: ASOF, isUS: false, months: [], rows: [], inventoryByBrandCountry: [], inventoryAvailable: true, awdAvailable: false, inventoryDate: ASOF };
  assert.equal(entry.validatePayload(legacy), true);
  assert.equal(entry.latestDataDate(derive({ listings: [L()] })), null, "a Listings plan claims no inventory date (and no current-month sales here)");
  assert.equal(entry.latestDataDate(derive({ listings: [L15()] })), ASOF, "the used bridge carries its date");
  assert.equal(entry.latestDataDate(derive({ listings: [L15()], health: [H({ date: addDaysStr(ASOF, -3) })] })), null, "a stale bridge is never a data date");
});
const v2d5 = () => ({
  asOf: ASOF, isUS: true, marketCountry: "US", months: [], rows: [
    { asin: "B0A", sku: "SKU-A", unitsByMonth: {}, mtdUnits: 1, fbaAvailable: 10, customerOrderReserved: 1, reservedFcTransfer: 2, reservedFcProcessing: 3, inboundWorking: 1, inboundShipped: 2, inboundReceived: 4, awdAvailable: 6, awdInbound: 1 },
  ], inventoryDate: "2026-10-05", inventoryAvailable: true, awdAvailable: true, awdEligible: true, inventoryFetchedAt: HEALTH_AT, inventoryByBrandCountry: [],
});
test("8 adapter: a PRE-phase-2 (Health-model) saved plan still renders as a labelled Health plan; a cutover payload passes through unchanged", () => {
  const a = adaptFbaPlanPayload(v2d5());
  assert.deepEqual([a.inventorySource, a.inventoryLegacy, a.inventoryHealthDate], ["health-fallback", true, "2026-10-05"]);
  assert.deepEqual(fbaQ(a.rows[0]), [10, 1 + 2 + 4, null, null]);
  const p = derive({ listings: [L()] });
  assert.equal(adaptFbaPlanPayload(p), p);
});
test("8 legacy callers: fbaPlanPayload without Listings input still derives (the bridge or unavailable), never throws", () => {
  const p = fbaPlanPayload({ asOf: ASOF, accountName: "t", marketCountry: "IN", isUS: false, completed, current, completedUnitRows: [[{ child_asin: "B0A", units_sum: 1 }], [], []], mtdUnitRows: [], dailyDateRows: [], catalogRows: [], invRows: [H()] });
  assert.equal(p.inventorySource, "health-fallback"); assert.deepEqual(p.inventoryListingsReasons, ["listings-empty"]);
});

/* (9) the browser refresh builders (api/datadoe.js; scheduler line only -- the web line retired them) */
test("9 the browser FBA Shipment Plan refresh builds through the shared fbaPlanPayload over the SAVED Listings rows + the saved Health BRIDGE (no Health export)", () => {
  const src = readFileSync(new URL("../api/datadoe.js", import.meta.url), "utf8");
  const start = src.indexOf('if (action === "fba-plan") {');
  const block = src.slice(start, src.indexOf("await sendLegacyPayload(payload);", start));
  assert.ok(start > 0 && block.length > 0, "the fba-plan builder is present");
  assert.ok(block.includes("const payload = fbaPlanPayload({"), "one payload definition (the scheduler's fbaPlanPayload)");
  assert.ok(block.includes("readSavedListingsRows({"), "the account's SAVED Listings rows (zero export)");
  assert.ok(block.includes("readSavedHealthBridge({"), "the account's LAST SAVED Health snapshot (read-only bridge)");
  assert.ok(block.includes("inventoryAsOf: planInvDay") && block.includes("healthBridgeReason,"), "the bridge threshold is applied against the plan's inventory as-of");
  assert.ok(block.includes("salesSkuAsinRows: oliSalesRows"), "the account-local SKU -> ASIN sales evidence");
  assert.ok(!/FBA_HEALTH_SOURCE_ID|FBA_HEALTH_COLUMNS|fba-inventory-health/.test(block), "no FBA Inventory Health export");
});
test("9 the browser Brand View inventory refresh passes the SAVED Listings rows + the saved Health BRIDGE to buildBrandInventorySnapshot (no Health export)", () => {
  const src = readFileSync(new URL("../api/datadoe.js", import.meta.url), "utf8");
  const start = src.indexOf('if (action === "brand-inventory") {');
  const block = src.slice(start, src.indexOf("await sendLegacyPayload(payload);", start));
  assert.ok(start > 0 && block.length > 0, "the brand-inventory builder is present");
  assert.ok(block.includes("readSavedListingsRows({"));
  assert.ok(block.includes("fetchListingsRows: async () => savedListings.rows || []"));
  assert.ok(block.includes("listingsRefreshedAt: savedListings.rows ? (savedListings.refreshedAt || null) : null"));
  assert.ok(block.includes("readSavedHealthBridge({") && block.includes("fetchInventoryRows: async () => (healthBridge.rows || [])"));
  assert.ok(!/FBA_HEALTH_SOURCE_ID|FBA_HEALTH_COLUMNS|fba-inventory-health/.test(block), "no FBA Inventory Health export");
});

console.log(`\nfba-plan-phase2: ${passed} passed`);
