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
// fba-plan:awd is now the CANONICAL Listings export planned for EVERY marketplace (shared byte-identically with
// listing-health-v3:listings), NOT the old US+EU5-gated AWD. So "listings" packs ALL 16 sellers into ceil(16/5)=4
// batches (was 11 AWD-eligible -> 3); AWD ELIGIBILITY (which marketplaces fold AWD) is enforced in the DERIVE, not by
// the plan's source count. Listings inventory cutover: FBA Inventory Health is RETIRED -- ZERO Health jobs are planned;
// the canonical Listings export is the ONLY FBA inventory source (4 Listings batches, nothing else).
const plan = planFor(europe);
const count = (p, key) => p.sourceJobs.filter((s) => s.sourceKey === key).length;
assert.equal(count(plan, "fba-inventory-health"), 0);
assert.equal(count(plan, "listings"), 4); // canonical Listings for ALL 16 europe/AU sellers -> ceil(16/5)=4 batches
assert.equal(plan.sourceJobs.length, 4); // Listings is the fba-plan plan's ONLY fetched source (OLI/Catalog are durable)
const allFourteen = planFor(europe.slice(0, 14));
assert.equal(count(allFourteen, "listings"), 3); // 14 sellers -> ceil(14/5)=3 canonical Listings batches (was 9 eligible -> 2)
assert.equal(count(planFor(make(Array(8).fill("IN"))), "fba-inventory-health"), 0);
// India is not AWD-eligible, but the canonical Listings export is STILL planned for it (shared with v3 -> 0 extra cost;
// India's derive simply never folds AWD). 8 IN sellers -> ceil(8/5)=2 Listings batches (was 0 under the old AWD gate).
assert.equal(count(planFor(make(Array(8).fill("IN"))), "listings"), 2);
assert.equal(count(planFor(make([...Array(8).fill("US"), "CA", "CA"])), "fba-inventory-health"), 0);
assert.equal(count(planFor(make([...Array(8).fill("US"), "CA", "CA"])), "listings"), 2);
assert.deepEqual(planFor([...europe].reverse()).sourceJobs.map((s) => s.requestHash).sort(), plan.sourceJobs.map((s) => s.requestHash).sort());
for (const r of plan.reportRequests) for (const s of r.sources) {
  assert(s.sellerOrVendorIds.length <= 5);
  assert(s.marketplacePairs.some((p) => p.sellerId === r.owner.rawSellerId && p.marketplace === r.owner.marketplace));
  assert.equal(s.freshnessNotBefore, "2026-09-04T00:00:00.000Z");
  // The ONLY inventory request is the no-date Listings snapshot (from === to === null) -- no inventory day is claimed.
  assert.equal(s.sourceKey, "listings");
  assert.equal(s.requestKey, "fba-plan:awd");
  assert.equal(s.from, null); assert.equal(s.to, null);
}
assert(plan.reportRequests.some((r) => r.sources.some((s) => new Set(s.marketplacePairs.map((p) => p.marketplace)).size > 1)));
// fbaInventoryAsOf is the PREVIOUS UTC date (D-1, the cycle as-of): on 2026-09-05 it names 2026-09-04.
assert.equal(fbaInventoryAsOf(Date.parse("2026-09-05T08:30:00Z")), inventoryDate);
console.log("PASS regional packing, stable <=5 batches, zero Health jobs and the no-date canonical Listings inventory request");

const req = plan.reportRequests[0];
const listing = req.sources.find((s) => s.sourceKey === "listings");
const job = plannedSourceJob("fba-plan", listing, "europe-au", "primary", req.accountId, req.owner.rawSellerId, listing.marketplaceConstraint, req.owner.marketplace);
assert.deepEqual(job.marketplacePairs, listing.marketplacePairs);
assert.equal(job.freshnessNotBefore, listing.freshnessNotBefore);
assert.equal(job.owner.marketplace, req.owner.marketplace);
const rows = listing.marketplacePairs.map((p) => ({ seller_or_vendor_id: p.sellerId, marketplace_country_code: p.marketplace }));
const args = { rows, sellerOrVendorIds: listing.sellerOrVendorIds, sourceScope: "seller", marketplaceScoped: true, marketplacePairs: listing.marketplacePairs };
assert.equal(validateBatchSourcePayload(args).valid, true);
assert.equal(validateBatchSourcePayload({ ...args, rows: [{ ...rows[0], marketplace_country_code: rows[1].marketplace_country_code }] }).code, "BATCH_CROSS_MARKETPLACE");
assert.equal(validateBatchSourcePayload({ ...args, rows: [{ ...rows[0], seller_or_vendor_id: "outside" }] }).code, "BATCH_CROSS_ACCOUNT");
assert.equal(validateBatchSourcePayload({ ...args, rows: [{ ...rows[0], marketplace_country_code: "" }] }).code, "BATCH_ROW_NO_MARKETPLACE");
assert.equal(validateBatchSourcePayload({ ...args, marketplacePairs: [] }).valid, false);
const sameSeller = [{ seller_or_vendor_id: "same", marketplace_country_code: "DE", fba_quantity_available: 10 }, { seller_or_vendor_id: "same", marketplace_country_code: "FR", fba_quantity_available: 99 }];
assert.equal(isolateFragmentRowsForOwner({ rows: sameSeller, sourceScope: "seller" }, { rawSellerId: "same", marketplace: "DE" }).rows[0].fba_quantity_available, 10);
assert.equal(isolateFragmentRowsForOwner({ rows: sameSeller, sourceScope: "seller" }, { rawSellerId: "same", marketplace: "DE" }).rows.length, 1);
console.log("PASS exact seller-marketplace validation and immutable owner isolation");

const statuses = {}; const loaded = {};
for (const s of req.sources) {
  statuses[s.requestHash] = "succeeded";
  const rows = s.marketplacePairs.map((p) => ({ seller_or_vendor_id: p.sellerId, marketplace_country_code: p.marketplace,
    child_asin: "ASIN", sku: "SKU", listing_status: "Active", listing_fulfillment_channel: "AMAZON_EU",
    fba_quantity_available: 12, fba_quantity_inbound: 3, fba_quantity_reserved: 1, fba_quantity_fc_transfer: 0,
    awd_available_distributable_quantity: 7, awd_total_inbound_quantity: 2 }));
  loaded[s.requestHash] = { rows, fetched_at: "2026-09-04T08:40:00Z" };
}
const { sources } = assembleSources(req.sources, statuses, loaded, {}, req.owner);
const { completed } = planMonthWindows(salesDate);
const oli = slicedOliSourceFromHistory({ historyRows: [], accountId: req.accountId, rawSellerId: req.owner.rawSellerId, from: completed[0].from, to: salesDate });
const context = { ...req.context, fbaPlanDurableOli: { available: true, rows: oli.rows, fragments: oli.fragments },
  fbaPlanDurableCatalog: { available: true, rows: [], fragments: [{ from: completed[0].from, to: salesDate, sellerOrVendorIds: [req.owner.rawSellerId], rows: [] }] } };
const result = deriveReportSnapshot({ reportKey: "fba-plan", sources, context });
assert.equal(result.status, "derived", result.reason);
assert.equal(result.payload.inventoryModel, "listings-v1");
assert.equal(result.payload.inventorySource, "listings"); // validated expanded Listings -> the inventory source (no Health)
assert.equal(result.payload.listingsRefreshedAt, "2026-09-04T08:40:00Z"); // freshness = the Listings fetch time
assert.equal(result.payload.rows[0].fbaAvailable, 12);
assert.equal(result.payload.rows[0].fbaInbound, 3);
assert.equal(result.payload.rows[0].awdAvailable, 7);
assert.equal(result.payload.awdFetchedAt, "2026-09-04T08:40:00Z");
console.log("PASS real assembly/derive: Sept 2 sales with the saved Listings stock (freshness = Listings fetch time, no inventory date)");

// NO-DATE GUARD: a Listings fragment carrying ANY date window (a claimed inventory day) makes the derive INVALID --
// zero writes, LKG preserved. Listings stock can therefore never be bound to (or combined across) inventory dates.
{
  const dated = { ...sources, "fba-plan:awd": { ...sources["fba-plan:awd"],
    fragments: sources["fba-plan:awd"].fragments.map((f) => ({ ...f, from: inventoryDate, to: inventoryDate })) } };
  const datedResult = deriveReportSnapshot({ reportKey: "fba-plan", sources: dated, context });
  // Either the derive refuses it outright (invalid / LKG preserved) or it NEVER uses that fragment's stock (the Listings
  // source is then not the inventory source) -- a dated Listings fragment never drives inventory.
  assert.ok(datedResult.status === "invalid" || (datedResult.status === "derived" && datedResult.payload.inventorySource !== "listings"),
    "a dated Listings fragment never drives inventory: " + datedResult.status + "/" + (datedResult.payload && datedResult.payload.inventorySource));
}
console.log("PASS dated Listings fragment rejected: no inventory date can be claimed");

const expired = await planFbaBucketCost({ bucketAccounts: europe, connections, asOf: salesDate, inventoryAsOf: inventoryDate,
  getSourceExportCache: async () => ({ fetched_at: "2026-09-03T10:00:00Z" }) });
assert.equal(expired.cost.creates, 4); // 4 canonical Listings batches (all 16 sellers) all stale -> refetch; ZERO Health
assert.deepEqual(Object.keys(expired.cost.byFamily), ["listings"]);
const fresh = await planFbaBucketCost({ bucketAccounts: europe, connections, asOf: salesDate, inventoryAsOf: inventoryDate,
  getSourceExportCache: async () => ({ fetched_at: "2026-09-04T08:40:00Z" }) });
assert.equal(fresh.cost.creates, 0);
console.log("PASS dry-run cost excludes yesterday's Listings/AWD cache from reuse");
