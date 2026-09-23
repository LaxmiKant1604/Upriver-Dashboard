// Europe AWD support -- the shared marketplace-capability rule + the derive folding + the client planning gate.
// Proves: US byte-identical; proven-compatible EU5 (UK/GB, DE, FR, IT, ES) fold AWD; Australia + other marketplaces
// excluded; one marketplace's AWD never attaches to another; missing AWD is never a fabricated zero (honest
// unavailable); the existing Cover/network formulas receive European AWD through the SAME code (no formula change);
// US = required-block, Europe = best-effort (no block). 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { awdCapableMarketplace, canonicalAwdMarketplace, awdRequiredForMarketplace, AWD_CAPABLE_MARKETPLACES, AWD_CONTRACT_COUNTRIES } from "../lib/server/reports/awd-capability.js";
import { fbaPlanPayload } from "../lib/server/reports/derivation-core.js";
import { computePlanRow } from "../src/lib/fba-planning.js";
import { planMonthWindows } from "../lib/server/date-windows.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`  ok  ${name}`); };
console.log("awd-europe");

const { completed, current } = planMonthWindows("2026-06-15");
const awdRow = (mkt, asin, avail, inbound = 0, sku = "S-" + asin) => ({ marketplace_country_code: mkt, child_asin: asin, sku, awd_available_distributable_quantity: avail, awd_total_inbound_quantity: inbound });
function payload({ marketCountry, isUS = false, awdEligible = undefined, awdRows = [], catalog = [{ child_asin: "B0X", product_brand: "Acme", product_name: "P" }] }) {
  // B0X (and B0Y) carry a little month-0 sales so they enter asinSet (ASINs enter via sales/inventory, not AWD alone --
  // existing behavior); AWD then attaches to the resolved rows.
  const sales = [[{ child_asin: "B0X", units_sum: 5 }, { child_asin: "B0Y", units_sum: 5 }], [], []];
  return fbaPlanPayload({ asOf: "2026-06-15", accountName: "t", marketCountry, isUS, awdEligible, completed, current, completedUnitRows: sales, mtdUnitRows: [], dailyDateRows: [], catalogRows: catalog, invRows: [], awdRows });
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
test("awdRequiredForMarketplace: US ONLY (US blocks on missing AWD; Europe is best-effort)", () => {
  assert.equal(awdRequiredForMarketplace("US"), true);
  for (const c of ["UK", "GB", "DE", "FR", "IT", "ES", "AU", "IN"]) assert.equal(awdRequiredForMarketplace(c), false, `${c} not required`);
});

/* ---- derive folding: US byte-identical + Europe eligible + isolation + no fabrication ---- */
test("US: AWD folds exactly as before (awdEligible defaults to isUS); row shows the units", () => {
  const p = payload({ marketCountry: "US", isUS: true, awdRows: [awdRow("US", "B0X", 120, 15)] }); // awdEligible undefined -> isUS
  assert.equal(p.awdEligible, true);
  assert.equal(p.awdAvailable, true);
  assert.equal(rowFor(p, "B0X").awdAvailable, 120);
  assert.equal(rowFor(p, "B0X").awdInbound, 15);
});
test("EU (UK/GB): AWD folds when eligible; row shows the units for the account's own marketplace", () => {
  const p = payload({ marketCountry: "UK", isUS: false, awdEligible: true, awdRows: [awdRow("GB", "B0X", 90, 8)] });
  assert.equal(p.awdEligible, true);
  assert.equal(p.awdAvailable, true);
  assert.equal(rowFor(p, "B0X").awdAvailable, 90);
});
test("ISOLATION: a UK/GB account NEVER attaches another marketplace's (DE) AWD row", () => {
  const p = payload({ marketCountry: "UK", isUS: false, awdEligible: true, awdRows: [awdRow("GB", "B0X", 90), awdRow("DE", "B0Y", 999)] });
  assert.equal(rowFor(p, "B0X").awdAvailable, 90);
  // B0Y (a DE row) must NOT appear as a GB-account AWD ASIN with 999 units.
  const y = rowFor(p, "B0Y");
  assert.ok(!y || (y.awdAvailable || 0) === 0, "the foreign-marketplace AWD row is dropped");
});
test("AU + non-capable marketplaces: AWD is never eligible; row AWD stays null (columns hidden client-side)", () => {
  for (const cc of ["AU", "IN", "CA", "NL"]) {
    const p = payload({ marketCountry: cc, isUS: false, awdEligible: awdCapableMarketplace(cc), awdRows: [awdRow(canonicalAwdMarketplace(cc), "B0X", 500)] });
    assert.equal(p.awdEligible, false, `${cc} not eligible`);
    assert.equal(p.awdAvailable, false, `${cc} awdAvailable boolean false`);
    assert.equal(rowFor(p, "B0X") ? rowFor(p, "B0X").awdAvailable : null, null, `${cc} row AWD null (never fabricated)`);
  }
});
test("NO FABRICATION: an eligible marketplace with an ABSENT/empty AWD source reports awdAvailable=false (client renders unavailable)", () => {
  const p = payload({ marketCountry: "DE", isUS: false, awdEligible: true, awdRows: [], catalog: [{ child_asin: "B0X", product_brand: "Acme", product_name: "P" }] });
  assert.equal(p.awdEligible, true);
  assert.equal(p.awdAvailable, false, "no AWD rows -> awdAvailable boolean false -> the client gate shows unavailable, not 0");
});
test("BACKWARD COMPAT: a legacy caller passing only isUS keeps the exact US-only behavior", () => {
  const us = payload({ marketCountry: "US", isUS: true, awdEligible: undefined, awdRows: [awdRow("US", "B0X", 10)] });
  assert.equal(us.awdEligible, true); assert.equal(rowFor(us, "B0X").awdAvailable, 10);
  const nonUs = payload({ marketCountry: "IN", isUS: false, awdEligible: undefined, awdRows: [awdRow("IN", "B0X", 10)] });
  assert.equal(nonUs.awdEligible, false); // isUS false + undefined -> no AWD (byte-identical to the old non-US path)
});

/* ---- client planning: European AWD flows through the SAME (unchanged) formulas ---- */
test("computePlanRow: European AWD (awdValidated, isUS false) counts into amazonNetworkPosition exactly like US", () => {
  const eu = computePlanRow({ isUS: false, inventoryAvailable: true, available: 50, awdValidated: true, awdAvailable: 100, awdInbound: 7, effectiveAsOf: "2026-06-15", daysInCurrentMonth: 30 });
  assert.equal(eu.awdAvailable, 100, "European AWD available is counted");
  assert.equal(eu.awdInbound, 7);
  assert.equal(eu.amazonNetworkPosition, 150, "50 FBA + 100 AWD = 150 (same formula)");
  const us = computePlanRow({ isUS: true, inventoryAvailable: true, available: 50, awdValidated: true, awdAvailable: 100, awdInbound: 7, effectiveAsOf: "2026-06-15", daysInCurrentMonth: 30 });
  assert.equal(us.amazonNetworkPosition, eu.amazonNetworkPosition, "US + EU identical when both validated");
});
test("computePlanRow: unvalidated AWD stays null (em dash), never a fabricated zero; awdInbound excluded from supply", () => {
  const r = computePlanRow({ isUS: false, inventoryAvailable: true, available: 40, awdValidated: false, awdAvailable: null, awdInbound: null, effectiveAsOf: "2026-06-15", daysInCurrentMonth: 30 });
  assert.equal(r.awdAvailable, null);
  assert.equal(r.amazonNetworkPosition, 40, "no AWD -> network = FBA only (never a fabricated 0-that-counts)");
});

/* ---- source-scan: US required-block, Europe best-effort ---- */
test("SEAM: report-derivation blocks US on missing AWD but is best-effort for Europe (no throw)", () => {
  const src = readFileSync(join(root, "lib/server/sync/report-derivation.js"), "utf8");
  assert.ok(/awdRequiredForMarketplace\(context\.marketCountry\)/.test(src), "AWD requirement is marketplace-driven (US only)");
  assert.ok(/if \(awdRequired\) throw/.test(src), "only awdRequired (US) throws/blocks on a bad AWD source");
  assert.ok(/awdCapableMarketplace\(context\.marketCountry\)/.test(src), "AWD eligibility is the shared capability rule");
});
test("SEAM: the AWD contract is the shared canonical Listings (no marketplace restriction); AWD eligibility (never AU) is enforced in the DERIVE", () => {
  const src = readFileSync(join(root, "lib/server/sync/report-source-contracts.js"), "utf8");
  // The former per-marketplace AWD restriction is GONE: fba-plan:awd is now the canonical Listings export fetched for
  // EVERY marketplace (byte-identical batch family to listing-health-v3:listings, so both consumers share ONE paid
  // export). AWD ELIGIBILITY (US + EU5, never Australia) is enforced in the DERIVE via awdCapableMarketplace -- a
  // non-AWD marketplace's Listings rows are still fetched (for v3 + the shared hash) but its AWD stays honestly
  // unavailable, and the derive never even reads fba-plan:awd for it. AWD_CONTRACT_COUNTRIES is retained here only to
  // prove it no longer gates the contract.
  assert.ok(!/marketplaceCountries:\s*\[\.\.\.AWD_CONTRACT_COUNTRIES\]/.test(src), "the AWD contract no longer restricts by marketplaceCountries (it is the shared canonical Listings for all marketplaces)");
  assert.ok(/LISTINGS_CANONICAL_COLUMNS/.test(src), "the AWD contract requests the canonical union Listings columns (the validated superset of v3 listing_* + AWD fields)");
  assert.ok(!AWD_CAPABLE_MARKETPLACES.includes("AU"), "Australia is NOT an AWD-capable marketplace (derive never folds AU AWD)");
  assert.equal(awdCapableMarketplace("AU"), false, "awdCapableMarketplace('AU') is false -> AU AWD stays honestly unavailable even though its Listings are fetched");
  assert.ok(!AWD_CONTRACT_COUNTRIES.includes("AU"), "Australia is NOT in the AWD capability countries");
});

console.log(`\nawd-europe: ${passed} assertions passed`);
