import assert from "node:assert/strict";
import { buildShadowReportPlan } from "../lib/server/sync/report-planner.js";
import { planFbaBucketCost, fbaInventoryAsOf } from "../lib/server/sync/fba-plan-operation.js";
import { validateBatchSourcePayload, isolateFragmentRowsForOwner } from "../lib/server/sync/source-account-isolation.js";
import { assembleSources } from "../lib/server/sync/report-worker.js";
import { deriveReportSnapshot } from "../lib/server/sync/report-derivation.js";
import { slicedOliSourceFromHistory } from "../lib/server/sync/durable-dashboards.js";
import { planMonthWindows } from "../lib/server/date-windows.js";
import { plannedSourceJob } from "../lib/server/sync/source-sync-driver.js";

const connections = [{ id: "primary", apiKey: "fixture-key", accountPrefix: "" }];
const salesDate = "2026-09-02";
const inventoryDate = "2026-09-04";
const make = (countries) => countries.map((country, i) => ({ accountId: `acct-${String(i).padStart(2, "0")}`, country, currency: "EUR", name: `Account ${i}` }));
const planFor = (accounts) => buildShadowReportPlan({ accounts, connections, reportKeys: ["fba-plan"], asOfFor: () => salesDate, inventoryAsOf: inventoryDate });
const europe = make(["UK", "DE", "FR", "IT", "ES", "UK", "DE", "IT", "UK", "NL", "BE", "PL", "AU", "NL", "FR", "ES"]);
// Eleven AWD-eligible sellers here: independent source packing must produce 4 Health + 3 AWD, not marketplace groups.
const plan = planFor(europe);
const count = (p, key) => p.sourceJobs.filter((s) => s.sourceKey === key).length;
assert.equal(count(plan, "fba-inventory-health"), 4);
assert.equal(count(plan, "listings"), 3);
const nineEligible = planFor(europe.slice(0, 14));
assert.equal(count(nineEligible, "listings"), 2);
assert.equal(count(planFor(make(Array(8).fill("IN"))), "fba-inventory-health"), 2);
assert.equal(count(planFor(make(Array(8).fill("IN"))), "listings"), 0);
assert.equal(count(planFor(make([...Array(8).fill("US"), "CA", "CA"])), "fba-inventory-health"), 2);
assert.equal(count(planFor(make([...Array(8).fill("US"), "CA", "CA"])), "listings"), 2);
assert.deepEqual(planFor([...europe].reverse()).sourceJobs.map((s) => s.requestHash).sort(), plan.sourceJobs.map((s) => s.requestHash).sort());
for (const r of plan.reportRequests) for (const s of r.sources) {
  assert(s.sellerOrVendorIds.length <= 5);
  assert(s.marketplacePairs.some((p) => p.sellerId === r.owner.rawSellerId && p.marketplace === r.owner.marketplace));
  assert.equal(s.freshnessNotBefore, "2026-09-04T00:00:00.000Z");
  // Inventory is EXACTLY the single snapshot day [inventoryAsOf .. inventoryAsOf] -- never a lookback window.
  if (s.sourceKey === "fba-inventory-health") { assert.equal(s.from, inventoryDate); assert.equal(s.to, inventoryDate); }
  else { assert.equal(s.from, null); assert.equal(s.to, null); }
}
assert(plan.reportRequests.some((r) => r.sources.some((s) => new Set(s.marketplacePairs.map((p) => p.marketplace)).size > 1)));
// fbaInventoryAsOf is the PREVIOUS UTC date (D-1): on 2026-09-05 it names the 2026-09-04 snapshot.
assert.equal(fbaInventoryAsOf(Date.parse("2026-09-05T08:30:00Z")), inventoryDate);
console.log("PASS regional packing, source eligibility, stable <=5 batches, exact single-day D-1 inventory window and no-date AWD");

const req = plan.reportRequests[0];
const health = req.sources.find((s) => s.sourceKey === "fba-inventory-health");
const job = plannedSourceJob("fba-plan", health, "europe-au", "primary", req.accountId, req.owner.rawSellerId, health.marketplaceConstraint, req.owner.marketplace);
assert.deepEqual(job.marketplacePairs, health.marketplacePairs);
assert.equal(job.freshnessNotBefore, health.freshnessNotBefore);
assert.equal(job.owner.marketplace, req.owner.marketplace);
const rows = health.marketplacePairs.map((p) => ({ seller_or_vendor_id: p.sellerId, marketplace_country_code: p.marketplace }));
const args = { rows, sellerOrVendorIds: health.sellerOrVendorIds, sourceScope: "seller", marketplaceScoped: true, marketplacePairs: health.marketplacePairs };
assert.equal(validateBatchSourcePayload(args).valid, true);
assert.equal(validateBatchSourcePayload({ ...args, rows: [{ ...rows[0], marketplace_country_code: rows[1].marketplace_country_code }] }).code, "BATCH_CROSS_MARKETPLACE");
assert.equal(validateBatchSourcePayload({ ...args, rows: [{ ...rows[0], seller_or_vendor_id: "outside" }] }).code, "BATCH_CROSS_ACCOUNT");
assert.equal(validateBatchSourcePayload({ ...args, rows: [{ ...rows[0], marketplace_country_code: "" }] }).code, "BATCH_ROW_NO_MARKETPLACE");
assert.equal(validateBatchSourcePayload({ ...args, marketplacePairs: [] }).valid, false);
const sameSeller = [{ seller_or_vendor_id: "same", marketplace_country_code: "DE", available: 10 }, { seller_or_vendor_id: "same", marketplace_country_code: "FR", available: 99 }];
assert.equal(isolateFragmentRowsForOwner({ rows: sameSeller, sourceScope: "seller" }, { rawSellerId: "same", marketplace: "DE" }).rows[0].available, 10);
assert.equal(isolateFragmentRowsForOwner({ rows: sameSeller, sourceScope: "seller" }, { rawSellerId: "same", marketplace: "DE" }).rows.length, 1);
console.log("PASS exact seller-marketplace validation and immutable owner isolation");

const statuses = {}; const loaded = {};
for (const s of req.sources) {
  statuses[s.requestHash] = "succeeded";
  const rows = s.marketplacePairs.flatMap((p) => s.sourceKey === "fba-inventory-health"
    ? [{ date: inventoryDate, seller_or_vendor_id: p.sellerId, marketplace_country_code: p.marketplace, child_asin: "ASIN", sku: "SKU", available: 12 }]
    : [{ seller_or_vendor_id: p.sellerId, marketplace_country_code: p.marketplace, child_asin: "ASIN", sku: "SKU", awd_available_distributable_quantity: 7 }]);
  loaded[s.requestHash] = { rows, fetched_at: "2026-09-04T08:40:00Z" };
}
const { sources } = assembleSources(req.sources, statuses, loaded, {}, req.owner);
const { completed } = planMonthWindows(salesDate);
const oli = slicedOliSourceFromHistory({ historyRows: [], accountId: req.accountId, rawSellerId: req.owner.rawSellerId, from: completed[0].from, to: salesDate });
const context = { ...req.context, fbaPlanDurableOli: { available: true, rows: oli.rows, fragments: oli.fragments },
  fbaPlanDurableCatalog: { available: true, rows: [], fragments: [{ from: completed[0].from, to: salesDate, sellerOrVendorIds: [req.owner.rawSellerId], rows: [] }] } };
const result = deriveReportSnapshot({ reportKey: "fba-plan", sources, context });
assert.equal(result.status, "derived", result.reason);
assert.equal(result.payload.inventoryDate, inventoryDate);
assert.equal(result.payload.rows[0].fbaAvailable, 12);
assert.equal(result.payload.inventoryStale, false);
assert.equal(result.payload.awdFetchedAt, "2026-09-04T08:40:00Z");
console.log("PASS real assembly/derive: Sept 2 sales with the exact Sept 4 (D-1) stock snapshot");

// CROSS-DATE GUARD: a row dated OUTSIDE the exact single inventory day (even an in-the-past sales date) makes the
// derive INVALID -- zero writes, LKG preserved. Inventory can therefore never be combined or summed across dates.
{
  const crossLoaded = { ...loaded };
  for (const s of req.sources) {
    if (s.sourceKey !== "fba-inventory-health") continue;
    const rows = s.marketplacePairs.flatMap((p) => [salesDate, inventoryDate].map((date) => ({
      date, seller_or_vendor_id: p.sellerId, marketplace_country_code: p.marketplace, child_asin: "ASIN", sku: "SKU", available: date === salesDate ? 1000 : 12,
    })));
    crossLoaded[s.requestHash] = { rows, fetched_at: "2026-09-04T08:40:00Z" };
  }
  const crossAssembled = assembleSources(req.sources, statuses, crossLoaded, {}, req.owner);
  const crossResult = deriveReportSnapshot({ reportKey: "fba-plan", sources: crossAssembled.sources, context });
  assert.equal(crossResult.status, "invalid", "a cross-date inventory row must invalidate the derive (never summed)");
}
console.log("PASS cross-date inventory row rejected: no cross-date combination or summation is possible");

const expired = await planFbaBucketCost({ bucketAccounts: europe, connections, asOf: salesDate, inventoryAsOf: inventoryDate,
  getSourceExportCache: async () => ({ fetched_at: "2026-09-03T10:00:00Z" }) });
assert.equal(expired.cost.creates, 7);
const fresh = await planFbaBucketCost({ bucketAccounts: europe, connections, asOf: salesDate, inventoryAsOf: inventoryDate,
  getSourceExportCache: async () => ({ fetched_at: "2026-09-04T08:40:00Z" }) });
assert.equal(fresh.cost.creates, 0);
console.log("PASS dry-run cost excludes yesterday's Listings/AWD cache from reuse");
