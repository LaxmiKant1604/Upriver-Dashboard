// Scheduler v2 -- SOURCE DEPENDENCY REGISTRY proof suite (offline, ZERO network/DB).
//
// Proves the typed immutable source registry (lib/server/sync/source-registry.js):
//   A. coverage -- every fetched contract family, every derived Ads family, and every tranche family is
//      registered; the record count is exact; derived-only dashboards are not registered.
//   B. the PRIORITY-TRANCHE downstream mappings required by the reviewed mission are present verbatim:
//      OLI -> Daily Reporting, Brand Sales/Brand View, FBA Plan, PPC denominator, Buy Box Loss, Returns
//      Leakage; Product Catalog -> Daily Reporting, Brand Sales/Brand View + catalog-dependent dashboards;
//      campaign-performance-v1 (ads-campaign-date) -> Daily Reporting + Brand View + PPC (the ACTIVE Ads grain);
//      asin-performance-v1 (ads-asin-date) -> PPC Performance ONLY (retired from Daily/Brand; history retained);
//      FBA Inventory Health -> Brand View, FBA Plan, Buy Box Loss, Listing Health, Sales Movers.
//   C. DataDoe token classes -- premium is EXACTLY {profit-by-sku-date, listings, fba-inventory-health}
//      (5 tokens); every other family standard (2); pricing reads fail closed on an unregistered family.
//   D. fail-closed reads + immutability -- unregistered key throws typed UNREGISTERED_SOURCE; records and
//      arrays are deeply frozen.
//   E. budget planning -- trancheBudgetMode is "frozen" exactly for the all-static tranches
//      (order-line-items, product-catalog, current-state) and "unbudgeted" for the signal-derived ones.
//   F. consistency checker fail-closed -- an UNREGISTERED fetched dependency, a CONTRADICTORY consumer
//      list, a wrong source id, a batched-but-organization scope, and an invented dashboard each THROW.
//   G. backfill policy -- the OLI initial backfill window covers the LONGEST executable Daily/Brand window
//      declared by the real contracts (420 days), read from the contracts themselves.
//
// 7-bit ASCII, LF, no top-level await, synchronous writeSync progress, dynamic imports after a dummy env.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = process.env[SB_KEY_ENV] || ["test", "svc", "role", "key"].join("-");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const group = (label) => tests.push({ marker: label });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

let reg; // source-registry module
let contracts; // report-source-contracts module
let sourceContracts; // canonical source-contracts module
let tranche; // source-tranche module
let durable; // source-durable-model module
let dates; // date-windows module

const clone = (v) => JSON.parse(JSON.stringify(v));

group("A. coverage");

test("every fetched family, derived Ads family, and tranche family is registered exactly once", () => {
  const keys = reg.SOURCE_REGISTRY.map((r) => r.sourceKey);
  assert.equal(new Set(keys).size, keys.length, "no duplicate registrations");
  const fetched = new Set();
  for (const list of Object.values(contracts.REPORT_SOURCE_CONTRACTS)) {
    for (const c of list || []) if (c && c.sourceKey) fetched.add(c.sourceKey);
  }
  for (const k of fetched) assert.ok(keys.includes(k), `fetched family ${k} registered`);
  for (const t of tranche.SOURCE_TRANCHE_ORDER) {
    for (const k of t.sourceKeys) assert.ok(keys.includes(k), `tranche family ${k} registered`);
  }
  for (const k of ["ads-campaign-date", "ads-asin-date", "ads-targeting-date", "ads-search-terms-date"]) {
    const r = reg.sourceRegistryEntry(k);
    assert.equal(r.storage, "durable-ads", `${k} uses the existing durable Ads architecture`);
    assert.ok(!fetched.has(k), `${k} is never fetched as a Scheduler-v2 source job`);
  }
  // 12 fetched families + 4 durable Ads families.
  assert.equal(reg.SOURCE_REGISTRY.length, 16);
});

test("derived-only dashboards (brand-view / priority-feed) are not registered as source families", () => {
  for (const k of contracts.REPORT_DERIVED_ONLY) {
    assert.throws(() => reg.sourceRegistryEntry(k), /UNREGISTERED_SOURCE/);
  }
});

group("B. priority-tranche downstream mappings (mission-exact)");

test("Order Line Items feeds Daily Reporting, Brand Sales/Brand View, FBA Plan, PPC denominator, Buy Box Loss, Returns Leakage", () => {
  const d = reg.dashboardsUsingSource("order-line-items");
  for (const want of ["daily-reporting", "brand-sales", "brand-view", "fba-plan", "ppc-performance", "buy-box-loss", "returns-leakage"]) {
    assert.ok(d.includes(want), `OLI usedByDashboards includes ${want}`);
  }
});

test("Product Catalog feeds Daily Reporting, Brand Sales/Brand View and the catalog-dependent dashboards", () => {
  const d = reg.dashboardsUsingSource("product-catalog");
  for (const want of ["daily-reporting", "brand-sales", "brand-view"]) assert.ok(d.includes(want), `catalog -> ${want}`);
  // Every report whose REPORT_SOURCE_REQUIREMENTS names product-catalog appears.
  const expected = Object.entries(sourceContracts.REPORT_SOURCE_REQUIREMENTS)
    .filter(([, deps]) => deps.includes("product-catalog")).map(([k]) => k);
  for (const want of expected) assert.ok(d.includes(want), `catalog-dependent dashboard ${want}`);
  assert.equal(expected.length, 12, "catalog has 12 direct consumers");
});

test("ASIN->Campaign CUTOVER: campaign-performance-v1 (ads-campaign-date) is the ACTIVE Ads grain -- Daily + Brand View + PPC", () => {
  const d = reg.dashboardsUsingSource("ads-campaign-date");
  assert.ok(d.includes("ppc-performance"), "PPC reads the campaign grain");
  assert.ok(d.includes("daily-reporting"), "Daily Reporting reads the campaign grain (account-level) post-cutover");
  assert.ok(d.includes("brand-view"), "Brand View reads the campaign grain (brand-level, via campaign->brand mapping) post-cutover");
});

test("ASIN->Campaign CUTOVER: asin-performance-v1 (ads-asin-date) is RETIRED from Daily/Brand -- PPC-only (history retained)", () => {
  const d = reg.dashboardsUsingSource("ads-asin-date");
  assert.ok(!d.includes("daily-reporting"), "Daily Reporting no longer reads the ASIN grain (retired)");
  assert.ok(!d.includes("brand-view"), "Brand View no longer reads the ASIN grain (retired)");
  assert.ok(d.includes("ppc-performance"), "ASIN grain remains a PPC-only input (durable history retained, exports blocked)");
});

test("FBA Inventory Health feeds Brand View, FBA Plan, Buy Box Loss, Listing Health, Sales Movers", () => {
  const d = reg.dashboardsUsingSource("fba-inventory-health");
  for (const want of ["brand-view", "fba-plan", "buy-box-loss", "listing-health", "sales-movers"]) {
    assert.ok(d.includes(want), `fba-inventory-health -> ${want}`);
  }
});

group("C. DataDoe token classes");

test("premium is EXACTLY {profit-by-sku-date, listings, fba-inventory-health}; everything else standard", () => {
  const premium = reg.SOURCE_REGISTRY.filter((r) => r.tokenClass === "premium").map((r) => r.sourceKey).sort();
  assert.deepEqual(premium, ["fba-inventory-health", "listings", "profit-by-sku-date"]);
  assert.equal(reg.registryIsPremiumOf({ sourceKey: "order-line-items" }), false);
  assert.equal(reg.registryIsPremiumOf({ source_key: "profit-by-sku-date" }), true, "snake_case job shape reads too");
  assert.equal(reg.registryIsPremiumOf({ sourceKey: "listings-raw" }), false, "the raw Listings twin is standard");
});

test("pricing fails closed on an unregistered family (never a default cost)", () => {
  assert.throws(() => reg.registryIsPremiumOf({ sourceKey: "no-such-source" }), /UNREGISTERED_SOURCE/);
  assert.throws(() => reg.registryIsPremiumOf({}), /UNREGISTERED_SOURCE/);
  assert.throws(() => reg.registryIsPremiumOf(null), /UNREGISTERED_SOURCE/);
});

group("D. fail-closed reads + immutability");

test("sourceRegistryEntry throws typed UNREGISTERED_SOURCE for an unknown family", () => {
  try {
    reg.sourceRegistryEntry("profit-by-date"); // legacy family, deliberately NOT part of Scheduler v2
    assert.fail("expected a throw");
  } catch (e) {
    assert.equal(e.code, "UNREGISTERED_SOURCE");
  }
});

test("registry records and their arrays are deeply frozen", () => {
  const oli = reg.sourceRegistryEntry("order-line-items");
  assert.ok(Object.isFrozen(reg.SOURCE_REGISTRY));
  assert.ok(Object.isFrozen(oli));
  assert.ok(Object.isFrozen(oli.usedByReports));
  assert.ok(Object.isFrozen(oli.usedByDashboards));
  assert.ok(Object.isFrozen(oli.batching));
  assert.ok(Object.isFrozen(oli.initialBackfill));
  assert.ok(Object.isFrozen(oli.incrementalRefresh));
  assert.throws(() => { oli.usedByDashboards.push("evil-dashboard"); }, TypeError);
});

group("E. budget planning modes");

test("frozen budgets exactly for the all-static tranches; signal-derived tranches unbudgeted", () => {
  const modes = Object.fromEntries(tranche.SOURCE_TRANCHE_ORDER.map((t) => [t.name, reg.trancheBudgetMode(t)]));
  assert.deepEqual(modes, {
    "order-line-items": "frozen",
    "product-catalog": "frozen",
    "date-sliceable": "unbudgeted",
    "current-state": "frozen",
    "staged-signal": "unbudgeted",
  });
  assert.throws(() => reg.trancheBudgetMode({}), /fail closed/);
  assert.throws(() => reg.trancheBudgetMode({ sourceKeys: [] }), /fail closed/);
});

group("F. consistency checker fail-closed");

test("the real registry + real contracts audit clean", () => {
  assert.equal(reg.assertSourceRegistryConsistency(), true);
});

test("an UNREGISTERED fetched dependency fails closed", () => {
  const registry = reg.SOURCE_REGISTRY.filter((r) => r.sourceKey !== "returns");
  assert.throws(() => reg.assertSourceRegistryConsistency({ registry }), /"returns" is UNREGISTERED/);
});

test("a CONTRADICTORY consumer list fails closed (missing and invented consumers)", () => {
  const mutate = (key, fn) => reg.SOURCE_REGISTRY.map((r) => (r.sourceKey === key ? { ...clone(r), ...fn(clone(r)) } : r));
  // Missing consumer: drop returns-leakage from the returns family.
  assert.throws(
    () => reg.assertSourceRegistryConsistency({ registry: mutate("returns", () => ({ usedByReports: [] })) }),
    /contradicts REPORT_SOURCE_REQUIREMENTS/,
  );
  // Invented consumer: claim sku-pl reads returns.
  assert.throws(
    () => reg.assertSourceRegistryConsistency({ registry: mutate("returns", (r) => ({ usedByReports: [...r.usedByReports, "sku-pl"] })) }),
    /contradicts REPORT_SOURCE_REQUIREMENTS/,
  );
  // Invented dashboard that no snapshot dependency reaches.
  assert.throws(
    () => reg.assertSourceRegistryConsistency({ registry: mutate("returns", (r) => ({ usedByDashboards: [...r.usedByDashboards, "keyword-rank"] })) }),
    /neither a direct consumer nor a snapshot-derived dashboard/,
  );
});

test("a wrong DataDoe source id fails closed", () => {
  const registry = reg.SOURCE_REGISTRY.map((r) => (r.sourceKey === "returns" ? { ...clone(r), dataDoeSourceId: "beef" } : r));
  assert.throws(() => reg.assertSourceRegistryConsistency({ registry }), /does not match any canonical SOURCE_CONTRACTS id/);
});

test("scope/batching contradictions fail closed (org-wide cannot be seller-batched; stable-batch needs the allowlist)", () => {
  const withMode = (key, patch) => reg.SOURCE_REGISTRY.map((r) => (r.sourceKey === key ? { ...clone(r), ...patch } : r));
  // Organization-wide family claiming per-seller batching.
  assert.throws(
    () => reg.assertSourceRegistryConsistency({ registry: withMode("product-catalog", { batching: { mode: "per-account", maxAccountsPerExport: 1, marketplaceSafe: true } }) }),
    /organization-wide but not organization-batched/,
  );
  // Organization-wide family claiming stable-batch trips the allowlist check (also fail closed).
  assert.throws(
    () => reg.assertSourceRegistryConsistency({ registry: withMode("product-catalog", { batching: { mode: "stable-batch", maxAccountsPerExport: 5, marketplaceSafe: true } }) }),
    /has NO approved SELLER_SCOPED_REQUEST_KEYS contract/,
  );
  // A per-account family claiming stable-batch without any approved SELLER_SCOPED contract.
  assert.throws(
    () => reg.assertSourceRegistryConsistency({ registry: withMode("returns", { batching: { mode: "stable-batch", maxAccountsPerExport: 5, marketplaceSafe: true } }) }),
    /has NO approved SELLER_SCOPED_REQUEST_KEYS contract/,
  );
  // The batched OLI family claiming organization scope.
  assert.throws(
    () => reg.assertSourceRegistryConsistency({ registry: withMode("order-line-items", { scope: "organization" }) }),
    /seller-batched contract but is not seller-scoped/,
  );
});

test("ads-asin-date declares the REAL <=5 stable batch (contradiction resolved); the exemption is durable-ads-specific", () => {
  const asin = reg.SOURCE_REGISTRY.find((r) => r.sourceKey === "ads-asin-date");
  // Was per-account/maxAccountsPerExport:1 -- contradicted the ads-sync runtime (chunks of 5) and the scheduler
  // token budget (US <=2 / Non-US <=5 exports). Now declares the real stable <=5-seller batch.
  assert.equal(asin.batching.mode, "stable-batch");
  assert.equal(asin.batching.maxAccountsPerExport, 5);
  assert.equal(asin.scope, "seller");
  assert.equal(asin.storage, "durable-ads");
  // The registry as shipped is consistent: durable-ads batches via the durable Ads architecture (per-seller
  // isolation proven by validateExportBatchRows), so it may be stable-batch without a source-job contract.
  assert.doesNotThrow(() => reg.assertSourceRegistryConsistency());
  // The exemption is SPECIFIC to durable-ads: flip the SAME entry off durable-ads and stable-batch fails closed.
  const withMode = (key, patch) => reg.SOURCE_REGISTRY.map((r) => (r.sourceKey === key ? { ...clone(r), ...patch } : r));
  assert.throws(
    () => reg.assertSourceRegistryConsistency({ registry: withMode("ads-asin-date", { storage: "durable-history" }) }),
    /has NO approved SELLER_SCOPED_REQUEST_KEYS contract/,
  );
});

group("G. backfill policy vs executable contracts");

test("OLI initial backfill covers the LONGEST Daily/Brand window the real contracts declare (420 days)", () => {
  const windows = [];
  for (const rk of ["brand-sales", "daily-reporting"]) {
    for (const c of contracts.REPORT_SOURCE_CONTRACTS[rk]) {
      if (c.sourceKey !== "order-line-items") continue;
      const m = String(c.windowKind || "").match(/-(\d+)\.\.asOf/);
      assert.ok(m, `an OLI contract for ${rk} declares a -N..asOf window (got "${c.windowKind}")`);
      windows.push(Number(m[1]));
    }
  }
  assert.ok(windows.length >= 2, "both Daily and Brand Sales OLI windows found");
  const longest = Math.max(...windows);
  assert.equal(longest, 420, "the longest executable window is the 420-day Brand Sales span");
  const oli = reg.sourceRegistryEntry("order-line-items");
  // A GENUINELY FIXED calendar start (2025-01-01), not "N days from the month start": [2025-01-01, asOf] is a
  // SUPERSET of the longest executable contract window (monthStart(asOf)-420) for the authorized go-live asOf.
  assert.equal(oli.initialBackfill.kind, "fixed-start");
  assert.equal(oli.initialBackfill.start, "2025-01-01", "authorized durable backfill starts at the fixed 2025-01-01");
  const goLiveAsOf = "2026-08-21";
  const longestStart = dates.addDaysStr(dates.monthStartStr(goLiveAsOf), -longest);
  assert.ok(oli.initialBackfill.start <= longestStart, "the fixed start COVERS the longest executable Daily/Brand window at go-live");
  assert.deepEqual(durable.oliBackfillWindow(goLiveAsOf), { from: "2025-01-01", to: goLiveAsOf }, "oliBackfillWindow honours the fixed start");
  assert.deepEqual(oli.incrementalRefresh, { kind: "rolling-window-days", days: 7, upsert: "replace-matching-rows" });
});

test("Product Catalog refreshes once daily per ORGANIZATION (never per dashboard or seller); FBA keeps the latest validated snapshot", () => {
  const cat = reg.sourceRegistryEntry("product-catalog");
  assert.equal(cat.scope, "organization");
  assert.deepEqual(cat.incrementalRefresh, { kind: "daily-snapshot", perOrganization: true });
  assert.equal(cat.storage, "durable-snapshot");
  const fba = reg.sourceRegistryEntry("fba-inventory-health");
  assert.equal(fba.storage, "durable-snapshot");
  assert.equal(fba.initialBackfill.kind, "current-only", "historical inventory is never repeatedly backfilled");
  assert.deepEqual(fba.incrementalRefresh, { kind: "daily-snapshot", perOrganization: false });
});

async function main() {
  out("source-registry proof suite");
  reg = await import("../lib/server/sync/source-registry.js");
  contracts = await import("../lib/server/sync/report-source-contracts.js");
  sourceContracts = await import("../lib/server/source-contracts.js");
  tranche = await import("../lib/server/sync/source-tranche.js");
  durable = await import("../lib/server/sync/source-durable-model.js");
  dates = await import("../lib/server/date-windows.js");

  let failures = 0;
  for (const t of tests) {
    if (t.marker) { out("-- " + t.marker); continue; }
    try {
      await t.fn();
      passed += 1;
      out("  ok  " + t.name);
    } catch (e) {
      failures += 1;
      out("FAIL  " + t.name);
      out(String((e && e.stack) || e));
    }
  }
  out("\n" + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : ""));
  if (failures) process.exitCode = 1;
}

main();
