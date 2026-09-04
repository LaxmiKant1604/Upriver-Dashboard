// Phase 2A regressions -- reproduce the six defects Codex found in the dormant Listing Health foundation, then
// prove the fixes. Each block asserts the CORRECT (fixed) behavior; run against the pre-fix modules it FAILS
// (reproduction), against the fixed modules it passes. Offline, zero DataDoe/network.
//
// 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import {
  buildAdvancedListingHealth, resolveListingHealthWindow, assessOliCoverage, latestInventoryBySku,
} from "../lib/server/reports/listing-health-advanced.js";
import { planListingHealthSourceBatches } from "../lib/server/reports/listing-health-batching.js";
import { isolateFragmentRowsForOwner } from "../lib/server/sync/source-account-isolation.js";

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); };
const throws = (name, fn) => { let t = false; try { fn(); } catch { t = true; } ok(name, t); };
const asOf = "2026-09-04";
const owner = { accountId: "acct-A", rawSellerId: "SELLER-A" };
writeSync(1, "listing-health-advanced-regressions\n");

/* ===== D1: COVERAGE UNION (merge overlapping/adjacent; report only genuine gaps; never bridge) ===== */
(() => {
  // Reproduction: request Sep 1-4, coverage Sep 1-2 + Sep 3-4 (adjacent) -> must be COMPLETE, no false gap.
  const adj = assessOliCoverage({ oliCoverageWindows: [{ from: "2026-09-03", to: "2026-09-04" }, { from: "2026-09-01", to: "2026-09-02" }], from: "2026-09-01", to: "2026-09-04" });
  ok("D1 adjacent split coverage (Sep1-2 + Sep3-4) is COMPLETE with no gap", adj.complete === true && (adj.gaps || []).length === 0);
  // Unsorted + duplicates + nested overlaps collapse.
  const messy = assessOliCoverage({ oliCoverageWindows: [{ from: "2026-09-02", to: "2026-09-03" }, { from: "2026-09-01", to: "2026-09-04" }, { from: "2026-09-01", to: "2026-09-04" }], from: "2026-09-01", to: "2026-09-04" });
  ok("D1 unsorted/duplicate/nested windows merge to complete", messy.complete === true && messy.gaps.length === 0);
  // Genuine interior gap is reported and never bridged.
  const gap = assessOliCoverage({ oliCoverageWindows: [{ from: "2026-09-01", to: "2026-09-02" }, { from: "2026-09-04", to: "2026-09-05" }], from: "2026-09-01", to: "2026-09-05" });
  ok("D1 genuine interior gap Sep3 is reported (not bridged)", gap.complete === false && gap.gaps.length === 1 && gap.gaps[0].from === "2026-09-03" && gap.gaps[0].to === "2026-09-03");
  // Multiple gaps.
  const multi = assessOliCoverage({ oliCoverageWindows: [{ from: "2026-09-02", to: "2026-09-03" }, { from: "2026-09-06", to: "2026-09-07" }], from: "2026-09-01", to: "2026-09-10" });
  ok("D1 multiple gaps: leading Sep1, middle Sep4-5, trailing Sep8-10", multi.gaps.length === 3 && multi.gaps[0].from === "2026-09-01" && multi.gaps[1].from === "2026-09-04" && multi.gaps[2].to === "2026-09-10");
  // Coverage starting AFTER the requested start -> leading gap, coveredFrom null.
  const late = assessOliCoverage({ oliCoverageWindows: [{ from: "2026-09-02", to: "2026-09-04" }], from: "2026-09-01", to: "2026-09-04" });
  ok("D1 coverage starting after requested start -> leading gap, coveredFrom null", late.complete === false && late.coveredFrom === null && late.gaps[0].from === "2026-09-01" && late.gaps[0].to === "2026-09-01");
})();

/* ===== D2: UNKNOWN STOCK (null available preserved; explicit Listings fallback; genuine zero kept) ===== */
(() => {
  const base = {
    owner, asOf, window: resolveListingHealthWindow({ preset: "30D", asOf }),
    enrichedOliRows: [], oliCoverageWindows: [{ from: "2026-01-01", to: asOf }], completenessRows: [],
    catalogRows: [], rawRows: [], issuesAvailable: false,
    listingRows: [{ sku: "SKU-N", child_asin: "ASIN-N", listing_status: "Active", listing_fulfillment_channel: "AMAZON_NA", fba_quantity_available: 7 }],
  };
  // Reproduction: latest snapshot available:null + Listings fba 7 -> onHandFba must be 7 (listings-fallback), NOT 0/snapshot.
  const nullSnap = buildAdvancedListingHealth({ ...base, inventoryRows: [{ date: "2026-09-03", sku: "SKU-N", available: null }] });
  const rN = nullSnap.rows.find((r) => r.sku === "SKU-N");
  ok("D2 null snapshot available falls back to Listings 7 (not a false snapshot 0)", rN.onHandFba === 7 && rN.onHandFbaSource === "listings-fallback");
  // Genuine numeric zero in the snapshot is preserved as 0 (fba-snapshot).
  const zeroSnap = buildAdvancedListingHealth({ ...base, inventoryRows: [{ date: "2026-09-03", sku: "SKU-N", available: 0 }] });
  ok("D2 genuine snapshot zero is preserved as 0 (fba-snapshot)", zeroSnap.rows[0].onHandFba === 0 && zeroSnap.rows[0].onHandFbaSource === "fba-snapshot");
  // Both unavailable -> null.
  const noneAvail = buildAdvancedListingHealth({ ...base, listingRows: [{ sku: "SKU-N", child_asin: "ASIN-N", listing_status: "Active", listing_fulfillment_channel: "AMAZON_NA", fba_quantity_available: null }], inventoryRows: [{ date: "2026-09-03", sku: "SKU-N", available: "" }] });
  ok("D2 unknown snapshot + no listing fallback -> null (unavailable)", noneAvail.rows[0].onHandFba === null && noneAvail.rows[0].onHandFbaSource === null);
  // latestInventoryBySku preserves unknown across null/missing/blank/malformed/non-finite; keeps latest date.
  const inv = latestInventoryBySku([
    { date: "2026-09-01", sku: "SKU-N", available: 999 }, // older -> ignored
    { date: "2026-09-03", sku: "A", available: null }, { date: "2026-09-03", sku: "B", available: "" },
    { date: "2026-09-03", sku: "C", available: "abc" }, { date: "2026-09-03", sku: "D", available: 0 },
    { date: "2026-09-03", sku: "E", available: 5 }, { date: "2026-09-03", sku: "F" }, // missing key
  ]);
  ok("D2 latest snapshot only (2026-09-03) and unknown-vs-zero preserved",
    inv.snapshotDate === "2026-09-03" && inv.bySku.get("A").available === null && inv.bySku.get("B").available === null
    && inv.bySku.get("C").available === null && inv.bySku.get("D").available === 0 && inv.bySku.get("E").available === 5
    && inv.bySku.get("F").available === null && !inv.bySku.has("SKU-N"));
})();

/* ===== D3: BATCH IDENTITY (complete trusted identity; supported routing; reject contradictions) ===== */
(() => {
  const good = (over) => ({ accountId: "a1", rawSellerId: "S1", country: "US", connectionId: "primary", organizationFingerprint: "org1", ...over });
  throws("D3 missing connectionId is rejected", () => planListingHealthSourceBatches({ accounts: [good({ connectionId: "" })] }));
  throws("D3 missing organizationFingerprint is rejected", () => planListingHealthSourceBatches({ accounts: [good({ organizationFingerprint: "" })] }));
  throws("D3 unsupported connection routing is rejected", () => planListingHealthSourceBatches({ accounts: [good({ connectionId: "bogus" })] }));
  throws("D3 contradictory duplicate accountId (two raw seller ids) is rejected", () => planListingHealthSourceBatches({ accounts: [good(), good({ rawSellerId: "S2" })] }));
  throws("D3 ambiguous raw seller id (mapped to two accounts) is rejected", () => planListingHealthSourceBatches({ accounts: [good(), good({ accountId: "a2" })] }));
  // Organization separation: same region, two orgs -> two partitions, each its own batch.
  const twoOrgs = planListingHealthSourceBatches({ accounts: [good(), good({ accountId: "a2", rawSellerId: "S2", organizationFingerprint: "org2" })] });
  ok("D3 organizations are never mixed in a batch", twoOrgs.batches.length === 2 && twoOrgs.batches.every((b) => b.sellerOrVendorIds.length === 1));
  // Complete identity + UK/GB alias + <=5 across marketplaces within region still works.
  const eu = planListingHealthSourceBatches({ accounts: ["UK", "DE", "FR", "IT", "ES", "UK"].map((c, i) => ({ accountId: `e${i}`, rawSellerId: `S${i}`, country: c, connectionId: "primary", organizationFingerprint: "org1" })) });
  ok("D3 6 mixed-marketplace EU accounts -> 2 batches, <=5, UK mapped to GB", eu.batches.length === 2 && eu.batches.every((b) => b.sellerOrVendorIds.length <= 5) && eu.batches.some((b) => b.marketplacePairs.some((p) => p.marketplace === "GB")));
})();

/* ===== D4: WINDOW VALIDATION (validate supplied windows at build entry; selected calendar month; leap Feb) ===== */
(() => {
  const base = { owner, asOf, enrichedOliRows: [], oliCoverageWindows: [{ from: "2020-01-01", to: asOf }], completenessRows: [], listingRows: [], inventoryRows: [], catalogRows: [], rawRows: [], issuesAvailable: false };
  throws("D4 reversed supplied window is rejected at build entry", () => buildAdvancedListingHealth({ ...base, window: { kind: "CUSTOM", from: "2026-09-04", to: "2026-09-01", days: 1 } }));
  throws("D4 future-endpoint supplied window is rejected at build entry", () => buildAdvancedListingHealth({ ...base, window: { kind: "CUSTOM", from: "2026-09-01", to: "2026-12-31", days: 1 } }));
  throws("D4 explicitly invalid preset is rejected", () => resolveListingHealthWindow({ preset: "BOGUS", asOf }));
  ok("D4 omitted preset uses the 30D default", resolveListingHealthWindow({ asOf }).kind === "30D" && resolveListingHealthWindow({ asOf }).from === "2026-08-06");
  // Selected calendar month (previous month, full range).
  const aug = resolveListingHealthWindow({ preset: "MONTH", month: "2026-08", asOf });
  ok("D4 selected previous calendar month is the FULL month", aug.from === "2026-08-01" && aug.to === "2026-08-31" && aug.days === 31);
  // Leap February.
  const febLeap = resolveListingHealthWindow({ preset: "MONTH", month: "2024-02", asOf });
  ok("D4 leap February resolves to 29 days", febLeap.from === "2024-02-01" && febLeap.to === "2024-02-29" && febLeap.days === 29);
  const febCommon = resolveListingHealthWindow({ preset: "MONTH", month: "2026-02", asOf });
  ok("D4 common February resolves to 28 days", febCommon.to === "2026-02-28" && febCommon.days === 28);
  // Current month is month-to-date (clamped to asOf).
  const cur = resolveListingHealthWindow({ preset: "MONTH", month: "2026-09", asOf });
  ok("D4 current month is month-to-date (clamped to asOf)", cur.from === "2026-09-01" && cur.to === asOf);
  throws("D4 a future selected month is rejected", () => resolveListingHealthWindow({ preset: "MONTH", month: "2026-12", asOf }));
  throws("D4 a malformed month is rejected", () => resolveListingHealthWindow({ preset: "MONTH", month: "2026-13", asOf }));
})();

/* ===== D5: HONEST SALES + COMPLETENESS (no false proven-zero; window-scoped, any-provisional) ===== */
(() => {
  const base = {
    owner, asOf, window: resolveListingHealthWindow({ preset: "30D", asOf }),
    enrichedOliRows: [], completenessRows: [], catalogRows: [], rawRows: [], issuesAvailable: false, inventoryRows: [],
    listingRows: [{ sku: "SKU-Z", child_asin: "ASIN-Z", listing_status: "Active", listing_fulfillment_channel: "AMAZON_NA", listing_price_value: 5, listing_price_currency: "USD" }],
  };
  // Partial coverage -> salesWindowStatus "partial" (a 0 is NOT proven zero).
  const partial = buildAdvancedListingHealth({ ...base, oliCoverageWindows: [{ from: "2026-08-06", to: "2026-08-20" }] });
  ok("D5 partial coverage -> salesWindowStatus 'partial'", partial.salesWindowStatus === "partial");
  // No coverage -> "unavailable".
  const none = buildAdvancedListingHealth({ ...base, oliCoverageWindows: [] });
  ok("D5 no coverage -> salesWindowStatus 'unavailable'", none.salesWindowStatus === "unavailable");
  // Full coverage -> "covered" (a genuine proven zero).
  const covered = buildAdvancedListingHealth({ ...base, oliCoverageWindows: [{ from: "2026-01-01", to: asOf }] });
  ok("D5 full coverage -> salesWindowStatus 'covered' (proven zero)", covered.salesWindowStatus === "covered");
  // Completeness is window-scoped and any-provisional: latest day final but an earlier day provisional => provisional.
  const comp = buildAdvancedListingHealth({
    ...base, oliCoverageWindows: [{ from: "2026-01-01", to: asOf }],
    completenessRows: [
      { sale_date: "2026-08-10", completeness_status: "provisional", itemization_percent: 50 },
      { sale_date: asOf, completeness_status: "final", itemization_percent: 100 },
      { sale_date: "2026-01-01", completeness_status: "final" }, // OUT of window earlier - must not matter
    ],
  });
  ok("D5 window is provisional if ANY in-window day is provisional (not just the latest)", comp.completeness && comp.completeness.provisional === true);
})();

/* ===== D6: ACCOUNT-ISOLATION PROOF (trusted projection boundary; reject cross-account rows) ===== */
(() => {
  const base = {
    owner, asOf, window: resolveListingHealthWindow({ preset: "30D", asOf }),
    oliCoverageWindows: [{ from: "2026-01-01", to: asOf }], completenessRows: [], catalogRows: [], rawRows: [], issuesAvailable: false, inventoryRows: [],
    listingRows: [{ sku: "SAME-SKU", child_asin: "SAME-ASIN", listing_status: "Active", listing_fulfillment_channel: "AMAZON_NA", listing_price_value: 5, listing_price_currency: "USD" }],
  };
  throws("D6 missing owner rawSellerId is rejected (trusted projection boundary required)", () => buildAdvancedListingHealth({ ...base, owner: { accountId: "acct-A" }, enrichedOliRows: [] }));
  // Cross-account OLI row (account B's seller) presented under owner A must be REJECTED, even with identical SKU/ASIN.
  throws("D6 a cross-account OLI row (identical SKU/ASIN, different seller) is rejected", () => buildAdvancedListingHealth({
    ...base,
    enrichedOliRows: [{ sale_date: "2026-09-01", sku: "SAME-SKU", child_asin: "SAME-ASIN", currency: "USD", sales_amount: 10, ordered_units: 1, account_id: "acct-B", seller_or_vendor_id: "SELLER-B" }],
  }));
  // Same-owner rows (or pre-projected rows with no account evidence) are accepted.
  const okPayload = buildAdvancedListingHealth({
    ...base,
    enrichedOliRows: [{ sale_date: "2026-09-01", sku: "SAME-SKU", child_asin: "SAME-ASIN", currency: "USD", sales_amount: 10, ordered_units: 1, account_id: "acct-A", seller_or_vendor_id: "SELLER-A" }],
  });
  ok("D6 the owner's own rows are accepted and attributed", okPayload.rows[0].sales === 10 && okPayload.accountId === "acct-A");
  // The trusted projection primitive itself (reused, not reinvented) isolates identical-SKU rows by exact seller+marketplace.
  const shared = [
    { seller_or_vendor_id: "SELLER-A", marketplace_country_code: "US", sku: "SAME-SKU", child_asin: "SAME-ASIN", available: 11 },
    { seller_or_vendor_id: "SELLER-B", marketplace_country_code: "US", sku: "SAME-SKU", child_asin: "SAME-ASIN", available: 22 },
  ];
  const mine = isolateFragmentRowsForOwner({ rows: shared, sourceScope: "seller" }, { rawSellerId: "SELLER-A", marketplace: "US" });
  ok("D6 isolateFragmentRowsForOwner keeps ONLY the owner's identical-SKU row (exact seller+marketplace)", mine.rows.length === 1 && mine.rows[0].available === 11);
})();

writeSync(1, `\nlisting-health-advanced-regressions: ${passed} assertions passed\n`);
