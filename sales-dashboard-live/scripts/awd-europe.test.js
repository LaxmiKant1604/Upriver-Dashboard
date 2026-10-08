// Europe AWD support -- the shared marketplace-capability rule + the derive folding + the client planning gate.
// Listings inventory cutover, phase 2: AWD is read from the SAME canonical Listings rows (fba-plan:awd) that carry the
// FBA inventory, per ASIN over ALL of its Listings SKUs, whichever FBA source the account uses (validated Listings or
// the READ-ONLY bridge: the last saved FBA Inventory Health snapshot). Proves: US unchanged; proven-compatible EU5 (UK/GB,
// DE, FR, IT, ES) fold AWD; Australia + other marketplaces excluded (AWD null even when the Listings row carries AWD
// cells; the client shows N/A and AWD contributes 0 there); one marketplace's AWD never attaches to another (dropped row
// by row, as before); a BLANK AWD cell is ASSUMED 0 and flagged (owner decision 2026-10-08), an explicit 0 is 0 and not
// flagged; an absent/empty Listings is never a fabricated zero; the network formulas receive European AWD through the
// SAME code; US = required-block, Europe / elsewhere = no block (the labelled bridge / Unavailable). 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { awdCapableMarketplace, canonicalAwdMarketplace, awdRequiredForMarketplace, AWD_CAPABLE_MARKETPLACES, AWD_CONTRACT_COUNTRIES } from "../lib/server/reports/awd-capability.js";
import { fbaPlanPayload } from "../lib/server/reports/derivation-core.js";
import { REPORT_DERIVATIONS } from "../lib/server/sync/report-derivation.js";
import { computePlanRow } from "../src/lib/fba-planning.js";
import { planMonthWindows } from "../lib/server/date-windows.js";
import { slicedOliSourceFromHistory } from "../lib/server/sync/durable-dashboards.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`  ok  ${name}`); };
console.log("awd-europe");

const { completed, current } = planMonthWindows("2026-06-15");
// One FULL (expanded, 18-column) canonical Listings row for marketplace `mkt` carrying FBA stock + the given AWD cells.
const lstRow = (mkt, asin, avail, inbound = 0, sku = "S-" + asin) => ({
  seller_or_vendor_id: "S1", marketplace_country_code: mkt, sku, child_asin: asin, fnsku: "X-" + asin,
  listing_name: "L-" + asin, listing_status: "Active", listing_price_value: 10, listing_price_currency: "USD",
  listing_current_quantity: 0, listing_fulfillment_channel: "AMAZON_EU", listing_open_date: "2025-01-01T00:00:00.000Z",
  fba_quantity_available: 5, fba_quantity_inbound: 1, fba_quantity_reserved: 0, fba_quantity_fc_transfer: 0,
  awd_available_distributable_quantity: avail, awd_total_inbound_quantity: inbound,
});
// A pre-expansion (15-column) Listings row: AWD cells but none of the three new inventory fields.
const lst15 = (mkt, asin, avail, inbound = 0) => { const r = lstRow(mkt, asin, avail, inbound); delete r.fba_quantity_inbound; delete r.fba_quantity_reserved; delete r.fba_quantity_fc_transfer; return r; };
const healthRow = (mkt, asin, available = 7) => ({ date: "2026-06-14", seller_or_vendor_id: "S1", marketplace_country_code: mkt, sku: "S-" + asin, child_asin: asin, available, inbound_working: 0, inbound_shipped: 2, inbound_received: 1, reserved_customer_order: 0, reserved_fc_transfer: 0, reserved_fc_processing: 0 });
function payload({ marketCountry, isUS = false, awdEligible = undefined, listingsRows = [], invRows = [], catalog = [{ child_asin: "B0X", product_brand: "Acme", product_name: "P" }] }) {
  // B0X (and B0Y) carry a little month-0 sales so they enter the plan even when the Listings omit them; AWD then
  // attaches only from the account's OWN-marketplace Listings rows.
  const sales = [[{ child_asin: "B0X", units_sum: 5 }, { child_asin: "B0Y", units_sum: 5 }], [], []];
  return fbaPlanPayload({ asOf: "2026-06-15", accountName: "t", marketCountry, isUS, awdEligible, completed, current, completedUnitRows: sales, mtdUnitRows: [], dailyDateRows: [], catalogRows: catalog, invRows, listingsRows });
}
const rowFor = (p, asin) => (p.rows || []).find((r) => r.asin === asin) || null;

/* ---- capability rule ---- */
test("awdCapableMarketplace: US + EU5 (UK/GB, DE, FR, IT, ES) true; AU/CA/IN/NL/BE/IE/PL false", () => {
  for (const c of ["US", "UK", "GB", "DE", "FR", "IT", "ES", "gb", " uk "]) assert.equal(awdCapableMarketplace(c), true, `${c} capable`);
  for (const c of ["AU", "CA", "IN", "NL", "BE", "IE", "PL", "SE", "AT", ""]) assert.equal(awdCapableMarketplace(c), false, `${c} NOT capable`);
  assert.equal(canonicalAwdMarketplace("UK"), "GB");
  assert.equal(canonicalAwdMarketplace("de"), "DE");
  assert.deepEqual([...AWD_CAPABLE_MARKETPLACES].sort(), ["DE", "ES", "FR", "GB", "IT", "US"]);
  assert.ok(AWD_CONTRACT_COUNTRIES.includes("UK") && AWD_CONTRACT_COUNTRIES.includes("GB") && AWD_CONTRACT_COUNTRIES.includes("US"));
});
test("awdRequiredForMarketplace: US ONLY (US blocks on a missing Listings / AWD source; elsewhere never blocks)", () => {
  assert.equal(awdRequiredForMarketplace("US"), true);
  for (const c of ["UK", "GB", "DE", "FR", "IT", "ES", "AU", "IN"]) assert.equal(awdRequiredForMarketplace(c), false, `${c} not required`);
});

/* ---- derive folding: US + Europe eligible + isolation + no fabrication ---- */
test("US: AWD folds exactly as before (awdEligible defaults to isUS); row shows the units", () => {
  const p = payload({ marketCountry: "US", isUS: true, listingsRows: [lstRow("US", "B0X", 120, 15)] }); // awdEligible undefined -> isUS
  assert.equal(p.awdEligible, true);
  assert.equal(p.awdAvailable, true);
  assert.equal(rowFor(p, "B0X").awdAvailable, 120);
  assert.equal(rowFor(p, "B0X").awdInbound, 15);
});
test("EU (UK/GB): AWD folds when eligible; row shows the units for the account's own marketplace (UK account, GB rows)", () => {
  const p = payload({ marketCountry: "UK", isUS: false, awdEligible: true, listingsRows: [lstRow("GB", "B0X", 90, 8)] });
  assert.equal(p.awdEligible, true);
  assert.equal(p.awdAvailable, true);
  assert.equal(p.inventorySource, "listings", "UK account + GB rows are the same marketplace (never foreign)");
  assert.equal(rowFor(p, "B0X").awdAvailable, 90);
  assert.equal(rowFor(p, "B0X").awdInbound, 8);
});
test("AWD explicit 0 is 0 (not flagged); a BLANK AWD cell is ASSUMED 0 and FLAGGED (owner decision); an ASIN with no Listings row is unknown", () => {
  const zero = payload({ marketCountry: "DE", isUS: false, awdEligible: true, listingsRows: [lstRow("DE", "B0X", 0, 0)] });
  assert.equal(rowFor(zero, "B0X").awdAvailable, 0); assert.equal(rowFor(zero, "B0X").awdInbound, 0);
  assert.equal(rowFor(zero, "B0X").awdAssumedZero, false, "an explicit DataDoe 0 is a verified 0"); assert.equal(zero.awdAssumedZeroSkus, 0);
  const blank = payload({ marketCountry: "DE", isUS: false, awdEligible: true, listingsRows: [lstRow("DE", "B0X", null, null)] });
  assert.equal(rowFor(blank, "B0X").awdAvailable, 0, "blank -> assumed 0 (an unverified assumption)");
  assert.equal(rowFor(blank, "B0X").awdInbound, 0);
  assert.equal(rowFor(blank, "B0X").awdAssumedZero, true, "flagged so the page says 'AWD blank treated as 0'");
  assert.equal(blank.awdAssumedZeroSkus, 1, "counted per account");
  assert.equal(rowFor(blank, "B0X").fbaAvailable, 5, "FBA inventory is unaffected by the AWD assumption");
  assert.equal(rowFor(blank, "B0Y").awdAvailable, null, "an ASIN with NO Listings row stays unknown (no AWD claim)");
});
test("AWD under the READ-ONLY Health bridge still comes from the Listings rows (a 15-column snapshot carries the AWD cells)", () => {
  const p = payload({ marketCountry: "DE", isUS: false, awdEligible: true, listingsRows: [lst15("DE", "B0X", 33, 4)], invRows: [healthRow("DE", "B0X")] });
  assert.equal(p.inventorySource, "health-fallback");
  assert.equal(p.awdAvailable, true);
  const r = rowFor(p, "B0X");
  assert.deepEqual([r.fbaAvailable, r.fbaInbound, r.fbaReservedTotal, r.fbaFcTransfer, r.awdAvailable, r.awdInbound], [7, 3, null, null, 33, 4]);
});
test("ISOLATION: a UK/GB account NEVER attaches another marketplace's (DE) AWD row; the foreign row withholds the Listings FBA inventory", () => {
  const p = payload({ marketCountry: "UK", isUS: false, awdEligible: true, listingsRows: [lstRow("GB", "B0X", 90), lstRow("DE", "B0Y", 999)] });
  assert.equal(rowFor(p, "B0X").awdAvailable, 90, "the account's own-marketplace AWD row folds (the foreign row is dropped row by row, as before)");
  const y = rowFor(p, "B0Y");
  assert.ok(y, "B0Y (sold) is still a row");
  assert.equal(y.awdAvailable, null, "the foreign-marketplace AWD row is dropped (never 999)");
  assert.notEqual(p.inventorySource, "listings", "another marketplace's rows are an integrity failure for the Listings FBA inventory");
  assert.ok(p.inventoryListingsReasons.includes("listings-foreign-marketplace-rows"));
});
test("AU + non-capable marketplaces: AWD is never eligible; row AWD stays null even though the Listings row carries AWD (the client shows N/A, AWD contributes 0)", () => {
  for (const cc of ["AU", "IN", "CA", "NL"]) {
    const p = payload({ marketCountry: cc, isUS: false, awdEligible: awdCapableMarketplace(cc), listingsRows: [lstRow(canonicalAwdMarketplace(cc), "B0X", 500)] });
    assert.equal(p.awdEligible, false, `${cc} not eligible`);
    assert.equal(p.awdAvailable, false, `${cc} awdAvailable boolean false`);
    assert.equal(rowFor(p, "B0X").awdAvailable, null, `${cc} row AWD null (never fabricated)`);
    assert.equal(rowFor(p, "B0X").awdAssumedZero, false, `${cc} never flagged (AWD does not apply)`); assert.equal(p.awdAssumedZeroSkus, 0);
    assert.equal(rowFor(p, "B0X").fbaAvailable, 5, `${cc} FBA inventory still folds from the same Listings`);
  }
});
test("NO FABRICATION: an eligible marketplace with an EMPTY Listings reports awdAvailable=false and null row AWD (client renders unavailable)", () => {
  const p = payload({ marketCountry: "DE", isUS: false, awdEligible: true, listingsRows: [] });
  assert.equal(p.awdEligible, true);
  assert.equal(p.awdAvailable, false, "no Listings rows -> awdAvailable boolean false -> the client gate shows unavailable, not 0");
  assert.equal(rowFor(p, "B0X").awdAvailable, null);
  assert.deepEqual(p.inventoryListingsReasons, ["listings-empty"]);
});
test("BACKWARD COMPAT: a legacy caller passing only isUS keeps the exact US-only behavior (awdRows is the former name of the Listings input)", () => {
  const us = payload({ marketCountry: "US", isUS: true, awdEligible: undefined, listingsRows: [lstRow("US", "B0X", 10)] });
  assert.equal(us.awdEligible, true); assert.equal(rowFor(us, "B0X").awdAvailable, 10);
  const nonUs = payload({ marketCountry: "IN", isUS: false, awdEligible: undefined, listingsRows: [lstRow("IN", "B0X", 10)] });
  assert.equal(nonUs.awdEligible, false); // isUS false + undefined -> no AWD (byte-identical to the old non-US path)
  assert.equal(rowFor(nonUs, "B0X").awdAvailable, null);
  const legacy = fbaPlanPayload({ asOf: "2026-06-15", accountName: "t", marketCountry: "US", isUS: true, completed, current, completedUnitRows: [[{ child_asin: "B0X", units_sum: 1 }], [], []], mtdUnitRows: [], dailyDateRows: [], catalogRows: [], invRows: [], awdRows: [lstRow("US", "B0X", 12)] });
  assert.equal(rowFor(legacy, "B0X").awdAvailable, 12, "the former awdRows input still reaches the fold");
});

/* ---- client planning: European AWD flows through the SAME (unchanged) formulas ---- */
test("computePlanRow: European AWD (awdValidated, isUS false) counts into amazonNetworkPosition exactly like US", () => {
  const eu = computePlanRow({ isUS: false, inventoryAvailable: true, available: 50, fbaInbound: 0, awdValidated: true, awdAvailable: 100, awdInbound: 7, effectiveAsOf: "2026-06-15", daysInCurrentMonth: 30 });
  assert.equal(eu.awdAvailable, 100, "European AWD available is counted");
  assert.equal(eu.awdInbound, 7);
  assert.equal(eu.amazonNetworkPosition, 150, "50 FBA + 0 inbound + 100 AWD = 150 (same formula)");
  const us = computePlanRow({ isUS: true, inventoryAvailable: true, available: 50, fbaInbound: 0, awdValidated: true, awdAvailable: 100, awdInbound: 7, effectiveAsOf: "2026-06-15", daysInCurrentMonth: 30 });
  assert.equal(us.amazonNetworkPosition, eu.amazonNetworkPosition, "US + EU identical when both validated");
});
test("computePlanRow: unvalidated AWD stays null (em dash), never a fabricated zero; awdInbound excluded from supply", () => {
  const r = computePlanRow({ isUS: false, inventoryAvailable: true, available: 40, fbaInbound: 0, awdValidated: false, awdAvailable: null, awdInbound: null, effectiveAsOf: "2026-06-15", daysInCurrentMonth: 30 });
  assert.equal(r.awdAvailable, null);
  assert.equal(r.amazonNetworkPosition, 40, "no AWD -> network = FBA only (never a fabricated 0-that-counts)");
});
test("computePlanRow (cutover): a NON-AWD marketplace contributes 0 AWD (N/A, never blocks); an AWD marketplace with an unvalidated AWD source is UNKNOWN", () => {
  const base = { isUS: false, inventoryAvailable: true, available: 40, fbaInbound: 2, effectiveAsOf: "2026-06-15", daysInCurrentMonth: 30 };
  const na = computePlanRow({ ...base, awdApplicable: false, awdValidated: false, awdAvailable: null });
  assert.deepEqual([na.awdNotApplicable, na.awdAvailable, na.amazonNetworkPosition], [true, null, 42], "AU / IN / CA / NL ...: network = FBA Supply");
  const unknown = computePlanRow({ ...base, awdApplicable: true, awdValidated: false, awdAvailable: null });
  assert.equal(unknown.amazonNetworkPosition, null, "EU5 / US without a validated AWD source: never silently AWD-less");
  const assumed = computePlanRow({ ...base, awdApplicable: true, awdValidated: true, awdAvailable: 0 });
  assert.equal(assumed.amazonNetworkPosition, 42, "an assumed-0 AWD adds 0 (the page marks it 'AWD blank treated as 0')");
});

/* ---- the derive: US keeps its hard requirement; elsewhere a missing Listings falls back (labelled), never blocks ---- */
test("DERIVE: a missing canonical Listings BLOCKS a US account only; EU5 / AU derive the labelled READ-ONLY Health bridge (listings-source-unavailable)", () => {
  const entry = REPORT_DERIVATIONS["fba-plan"];
  assert.deepEqual([...entry.optionalRequestKeys], ["fba-plan:awd"], "fba-plan:awd stays optional at the gate (as before)");
  const oli = slicedOliSourceFromHistory({ historyRows: [], accountId: "S1", rawSellerId: "S1", from: completed[0].from, to: "2026-06-15" });
  for (const cc of ["US", "UK", "DE", "FR", "IT", "ES", "AU"]) {
    const context = {
      to: "2026-06-15", rawSellerId: "S1", accountName: "t", marketCountry: cc, isUS: cc === "US",
      fbaPlanDurableOli: { available: true, rows: oli.rows, fragments: oli.fragments },
      fbaPlanDurableCatalog: { available: true, rows: [], fragments: [{ from: completed[0].from, to: current.to, sellerOrVendorIds: ["S1"] }] },
    };
    const mkt = canonicalAwdMarketplace(cc);
    // The READ-ONLY bridge (the account's last saved Health snapshot), never a fetched Health fragment.
    context.fbaPlanHealthBridge = { available: true, rows: [{ ...healthRow(mkt, "B0X"), date: "2026-06-15" }], snapshotDate: "2026-06-15", validatedAt: "2026-06-15T09:00:00.000Z" };
    const derive = () => entry.derive({ sources: {}, context });
    if (cc === "US") { assert.throws(derive, /requires a validated AWD source/, "US blocks on a missing Listings"); continue; }
    const p = derive();
    assert.equal(p.inventorySource, "health-fallback", `${cc} falls back to the Health snapshot`);
    assert.deepEqual(p.inventoryListingsReasons, ["listings-source-unavailable"], `${cc} carries the typed reason`);
    assert.equal(p.awdAvailable, false, `${cc} AWD unavailable (never 0)`);
  }
});
test("SEAM: report-derivation keeps the US-only block; AWD eligibility is the shared capability rule", () => {
  const src = readFileSync(join(root, "lib/server/sync/report-derivation.js"), "utf8");
  assert.ok(/awdRequiredForMarketplace\(context\.marketCountry\)/.test(src), "AWD requirement is marketplace-driven (US only)");
  assert.ok(/if \(awdRequired\) throw/.test(src), "only awdRequired (US) throws/blocks on a bad Listings / AWD source");
  assert.ok(/awdCapableMarketplace\(context\.marketCountry\)/.test(src), "AWD eligibility is the shared capability rule");
});
test("SEAM: the AWD contract is the shared canonical Listings (no marketplace restriction); AWD eligibility (never AU) is enforced in the DERIVE", () => {
  const src = readFileSync(join(root, "lib/server/sync/report-source-contracts.js"), "utf8");
  // fba-plan:awd is the canonical Listings export fetched for EVERY marketplace (byte-identical batch family to
  // listing-health-v3:listings, so both consumers share ONE paid export) and, since phase 2 of the Listings inventory
  // cutover, it carries every marketplace's FBA inventory evidence. AWD ELIGIBILITY (US + EU5, never Australia) is
  // enforced in the DERIVE via awdCapableMarketplace. AWD_CONTRACT_COUNTRIES is retained only to prove it no longer
  // gates the contract.
  assert.ok(!/marketplaceCountries:\s*\[\.\.\.AWD_CONTRACT_COUNTRIES\]/.test(src), "the AWD contract no longer restricts by marketplaceCountries (it is the shared canonical Listings for all marketplaces)");
  assert.ok(/LISTINGS_CANONICAL_COLUMNS/.test(src), "the AWD contract requests the canonical union Listings columns (the validated superset of v3 listing_* + AWD + inventory fields)");
  assert.ok(!AWD_CAPABLE_MARKETPLACES.includes("AU"), "Australia is NOT an AWD-capable marketplace (derive never folds AU AWD)");
  assert.equal(awdCapableMarketplace("AU"), false, "awdCapableMarketplace('AU') is false -> AU AWD stays honestly unavailable even though its Listings are fetched");
  assert.ok(!AWD_CONTRACT_COUNTRIES.includes("AU"), "Australia is NOT in the AWD capability countries");
});

console.log(`\nawd-europe: ${passed} assertions passed`);
