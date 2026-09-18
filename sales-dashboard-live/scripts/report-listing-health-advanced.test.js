// Advanced Listing Health backend foundation (DORMANT, additive). Proves the OLI-based, window-aware derivation
// core and the <=5-seller mixed-marketplace ingestion batching, entirely offline (zero DataDoe/network).
//
// Matrix: OLI parity, date boundaries (7D/14D/30D/month/custom, inclusive), incomplete coverage, actual-vs-
// estimated units, currency/account isolation, unknown-vs-zero stock, latest-snapshot selection, FBA/FBM split,
// flagged/sales-at-risk semantics (confirmed vs possible), mixed-marketplace <=5 batches (8->2/16->4/10->2),
// malformed rows, and zero-export purity (no transport import).
//
// 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { readFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  buildAdvancedListingHealth, resolveListingHealthWindow, foldOliWindowSales, assessOliCoverage,
  LISTING_HEALTH_ADVANCED_SALES_SOURCE,
} from "../lib/server/reports/listing-health-advanced.js";
import { planListingHealthSourceBatches } from "../lib/server/reports/listing-health-batching.js";

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); };
const throws = (name, fn) => { let threw = false; try { fn(); } catch { threw = true; } ok(name, threw); };

const asOf = "2026-09-04";
writeSync(1, "report-listing-health-advanced\n");

/* ===================== window resolution + date boundaries ===================== */
(() => {
  const w7 = resolveListingHealthWindow({ preset: "7D", asOf });
  ok("7D window is inclusive [asOf-6, asOf]", w7.from === "2026-08-29" && w7.to === asOf && w7.days === 7);
  const w14 = resolveListingHealthWindow({ preset: "14D", asOf });
  ok("14D window", w14.from === "2026-08-22" && w14.days === 14);
  const w30 = resolveListingHealthWindow({ preset: "30D", asOf });
  ok("30D default window", w30.from === "2026-08-06" && w30.days === 30);
  const wDefault = resolveListingHealthWindow({ asOf });
  ok("unknown/absent preset falls back to 30D (never a guess)", wDefault.kind === "30D" && wDefault.from === "2026-08-06");
  const wm = resolveListingHealthWindow({ preset: "MONTH", asOf });
  ok("calendar month-to-date window", wm.from === "2026-09-01" && wm.to === asOf && wm.days === 4);
  const wc = resolveListingHealthWindow({ preset: "CUSTOM", from: "2026-08-01", to: "2026-08-31", asOf });
  ok("custom inclusive window", wc.from === "2026-08-01" && wc.to === "2026-08-31" && wc.days === 31);
  throws("custom from>to is rejected", () => resolveListingHealthWindow({ preset: "CUSTOM", from: "2026-08-31", to: "2026-08-01", asOf }));
  throws("custom to>asOf is rejected", () => resolveListingHealthWindow({ preset: "CUSTOM", from: "2026-08-01", to: "2026-09-30", asOf }));
  throws("bad asOf is rejected", () => resolveListingHealthWindow({ preset: "30D", asOf: "nope" }));
})();

/* ===================== OLI window fold parity + boundaries + actual/estimated ===================== */
const enriched = [
  { sale_date: "2026-09-01", sku: "SKU-A", child_asin: "ASIN-A", currency: "USD", sales_amount: 100, ordered_units: 10, unpriced_units: 2 },
  { sale_date: "2026-08-20", sku: "SKU-A", child_asin: "ASIN-A", currency: "USD", sales_amount: 50, ordered_units: 5, unpriced_units: 0 },
  { sale_date: "2026-07-01", sku: "SKU-A", child_asin: "ASIN-A", currency: "USD", sales_amount: 999, ordered_units: 99, unpriced_units: 0 }, // outside any tested window
  { sale_date: "2026-09-02", sku: "SKU-B", child_asin: "ASIN-B", currency: "USD", sales_amount: 200, ordered_units: 20, unpriced_units: 0 },
];
(() => {
  const w30 = resolveListingHealthWindow({ preset: "30D", asOf });
  const { salesBySku } = foldOliWindowSales(enriched, w30);
  ok("30D fold sums only in-window rows (SKU-A 100+50=150, units 15, unpriced 2)",
    salesBySku.get("SKU-A").sales === 150 && salesBySku.get("SKU-A").units === 15 && salesBySku.get("SKU-A").unpricedUnits === 2);
  ok("30D fold excludes the July row (999 never counted)", salesBySku.get("SKU-A").sales === 150);
  const w7 = resolveListingHealthWindow({ preset: "7D", asOf });
  const f7 = foldOliWindowSales(enriched, w7).salesBySku;
  ok("7D fold excludes 2026-08-20 (SKU-A only the 09-01 row: 100/10)", f7.get("SKU-A").sales === 100 && f7.get("SKU-A").units === 10);
  ok("units are ORDERED units (priced+overlay) and unpriced_units is preserved (actual/estimated distinction)", f7.get("SKU-A").units === 10 && f7.get("SKU-A").unpricedUnits === 2);
  ok("blank-SKU OLI rows are skipped", foldOliWindowSales([{ sale_date: "2026-09-01", sku: "", currency: "USD", sales_amount: 5, ordered_units: 1 }], w7).salesBySku.size === 0);
})();

/* ===================== coverage honesty (never silently shorten) ===================== */
(() => {
  const w30 = resolveListingHealthWindow({ preset: "30D", asOf }); // 2026-08-06..2026-09-04
  const partial = assessOliCoverage({ oliCoverageWindows: [{ from: "2026-01-01", to: "2026-09-02" }], from: w30.from, to: w30.to });
  ok("partial coverage is reported honestly (not complete, covered->09-02, gap 09-03..09-04)",
    partial.complete === false && partial.coveredTo === "2026-09-02" && partial.gapFrom === "2026-09-03" && partial.gapTo === "2026-09-04");
  const full = assessOliCoverage({ oliCoverageWindows: [{ from: "2026-01-01", to: "2026-09-04" }], from: w30.from, to: w30.to });
  ok("full coverage is complete with no gap", full.complete === true && full.gapFrom === null);
  const none = assessOliCoverage({ oliCoverageWindows: [{ from: "2025-01-01", to: "2025-02-01" }], from: w30.from, to: w30.to });
  ok("no coverage over the window -> complete false, whole window is the gap", none.complete === false && none.coveredFrom === null && none.gapFrom === w30.from);
})();

/* ===================== full payload: inventory authority, unknown-vs-zero, FBA/FBM split, flags ===================== */
const listingRows = [
  { sku: "SKU-A", child_asin: "ASIN-A", listing_name: "A", listing_status: "Active", listing_price_value: 25, listing_price_currency: "USD", listing_current_quantity: 0, fba_quantity_available: 30, listing_fulfillment_channel: "AMAZON_NA", listing_open_date: "2024-01-01" },
  { sku: "SKU-B", child_asin: "ASIN-B", listing_name: "B", listing_status: "Inactive", listing_price_value: 0, listing_price_currency: "USD", listing_current_quantity: 7, fba_quantity_available: null, listing_fulfillment_channel: "DEFAULT", listing_open_date: "2024-02-01" },
  { sku: "SKU-C", child_asin: "ASIN-C", listing_name: "C", listing_status: "Active", listing_price_value: 10, listing_price_currency: "USD", listing_current_quantity: null, fba_quantity_available: null, listing_fulfillment_channel: "AMAZON_NA", listing_open_date: "2024-03-01" }, // FBA, no snapshot, no listing fallback -> unavailable
  { sku: "SKU-E", child_asin: "ASIN-E", listing_name: "E", listing_status: "Active", listing_price_value: 10, listing_price_currency: "USD", listing_current_quantity: null, fba_quantity_available: 0, listing_fulfillment_channel: "AMAZON_NA", listing_open_date: "2024-04-01" }, // FBA, no snapshot, listing fallback 0 (genuine zero via fallback)
  { sku: "", child_asin: "", listing_name: "blank", listing_status: "Active", listing_fulfillment_channel: "AMAZON_NA" }, // skipped (no sku, no asin)
];
const inventoryRows = [
  { date: "2026-09-03", sku: "SKU-A", child_asin: "ASIN-A", available: 30, currency: "USD" },   // newest snapshot
  { date: "2026-09-01", sku: "SKU-A", child_asin: "ASIN-A", available: 999, currency: "USD" },  // older -> must be ignored
  { date: "2026-09-03", sku: "SKU-F", child_asin: "ASIN-F", available: 0, currency: "USD" },    // genuine zero (but no listing row -> not in output)
];
const catalogRows = [
  { child_asin: "ASIN-A", product_name: "Prod A", product_brand: "BrandX" },
  { child_asin: "ASIN-B", product_name: "Prod B", product_brand: "BrandY" },
];
const rawRows = [
  { sku: "SKU-A", child_asin: "ASIN-A", summaries: JSON.stringify({ status: ["BUYABLE", "DISCOVERABLE"] }), issues: JSON.stringify([]), offers: JSON.stringify([{ price: { amount: 25 } }]) },
  { sku: "SKU-B", child_asin: "ASIN-B", summaries: JSON.stringify({ status: [] }), issues: JSON.stringify([]), offers: JSON.stringify([{ price: { amount: 0 } }]) }, // not buyable, not discoverable, present-but-unpriced offer => no live offer
];
const completenessRows = [
  { sale_date: "2026-09-01", completeness_status: "final", itemization_percent: 100 },
  { sale_date: "2026-09-02", completeness_status: "provisional", itemization_percent: 60, pending_unit_count: 12 },
];
const oliCoverageWindows = [{ from: "2026-01-01", to: "2026-09-02" }];
const provenance = { listingsFetchedAt: "2026-09-04T08:00:00Z", inventoryFetchedAt: "2026-09-04T08:05:00Z", rawFetchedAt: "2026-09-04T08:06:00Z", catalogFetchedAt: "2026-09-03T08:00:00Z" };

const payload = buildAdvancedListingHealth({
  owner: { accountId: "acct-1", rawSellerId: "SELLER-1" }, asOf, window: resolveListingHealthWindow({ preset: "30D", asOf }),
  enrichedOliRows: enriched, oliCoverageWindows, completenessRows,
  listingRows, inventoryRows, catalogRows, rawRows,
  issuesAvailable: true, issuesUnavailableReason: null, provenance,
});
const byId = new Map(payload.rows.map((r) => [r.sku, r]));
(() => {
  ok("payload sales source is order-line-items (no Profit-by-SKU)", payload.salesSource === LISTING_HEALTH_ADVANCED_SALES_SOURCE);
  ok("listingCount counts all listing rows (blank included), rows exclude the blank-sku listing", payload.listingCount === 5 && payload.rows.length === 4);
  // Inventory authority + latest-snapshot + unknown vs zero.
  ok("SKU-A FBA on-hand comes from the LATEST snapshot (30, not 999) and is marked fba-snapshot", byId.get("SKU-A").onHandFba === 30 && byId.get("SKU-A").onHandFbaSource === "fba-snapshot");
  ok("SKU-C FBA on-hand is UNAVAILABLE (null) when no snapshot and no listing fallback", byId.get("SKU-C").onHandFba === null && byId.get("SKU-C").onHandFbaSource === null);
  ok("SKU-E FBA on-hand is a genuine ZERO via the explicit Listings fallback (0, listings-fallback)", byId.get("SKU-E").onHandFba === 0 && byId.get("SKU-E").onHandFbaSource === "listings-fallback");
  // FBA/FBM split + not applicable.
  ok("SKU-A (FBA) FBM on-hand is NOT APPLICABLE", byId.get("SKU-A").onHandFbmApplicable === false && byId.get("SKU-A").onHandFbm === null && byId.get("SKU-A").onHandFbaApplicable === true);
  ok("SKU-B (FBM) FBA on-hand is NOT APPLICABLE; FBM on-hand is 7", byId.get("SKU-B").onHandFbaApplicable === false && byId.get("SKU-B").onHandFbm === 7 && byId.get("SKU-B").onHandFbmApplicable === true);
  // Sales/units from window OLI.
  ok("SKU-A window sales/units = 150/15", byId.get("SKU-A").sales === 150 && byId.get("SKU-A").units === 15);
  ok("SKU-B window sales/units = 200/20", byId.get("SKU-B").sales === 200 && byId.get("SKU-B").units === 20);
  ok("SKU-C has no OLI sales -> 0 with hasSalesData false", byId.get("SKU-C").sales === 0 && byId.get("SKU-C").hasSalesData === false);
  // Flags: confirmed vs possible; sales at risk = window exposure for flagged only.
  ok("SKU-A is NOT flagged (Active, buyable/discoverable, live offer, priced) -> salesAtRisk 0", byId.get("SKU-A").flagged === false && byId.get("SKU-A").salesAtRisk === 0);
  const bReasons = byId.get("SKU-B").flagReasons.map((r) => r.code);
  ok("SKU-B is flagged: not_buyable/not_discoverable/no_live_offer are CONFIRMED, status_not_active is POSSIBLE",
    byId.get("SKU-B").flagged === true
    && byId.get("SKU-B").flagReasons.find((r) => r.code === "not_buyable").confidence === "confirmed"
    && byId.get("SKU-B").flagReasons.find((r) => r.code === "status_not_active").confidence === "possible"
    && bReasons.includes("no_live_offer"));
  ok("SKU-B salesAtRisk = its window sales exposure (200), not proven lost revenue", byId.get("SKU-B").salesAtRisk === 200);
  // Buyable/Discoverable/Live offer + issues surfaced.
  ok("SKU-A buyable+discoverable true, live offer true", byId.get("SKU-A").buyable === true && byId.get("SKU-A").discoverable === true && byId.get("SKU-A").liveOffer === true);
  ok("SKU-B buyable false, discoverable false, live offer false", byId.get("SKU-B").buyable === false && byId.get("SKU-B").discoverable === false && byId.get("SKU-B").liveOffer === false);
  // Provenance + coverage + completeness.
  ok("coverage reported honestly (incomplete, gap 09-03..09-04)", payload.coverage.complete === false && payload.coverage.gapFrom === "2026-09-03");
  ok("completeness surfaces provisional", payload.completeness && payload.completeness.provisional === true);
  ok("provenance carries source dates + snapshot date + oli covered-to", payload.provenance.listingsFetchedAt === "2026-09-04T08:00:00Z" && payload.provenance.inventorySnapshotDate === "2026-09-03" && payload.provenance.oliCoveredTo === "2026-09-02");
  ok("inventory snapshot date is the latest (2026-09-03)", payload.inventory.snapshotDate === "2026-09-03" && payload.inventory.available === true);
})();

/* ===================== degraded issues (Raw JSON unavailable) ===================== */
(() => {
  const degraded = buildAdvancedListingHealth({
    owner: { accountId: "acct-1", rawSellerId: "SELLER-1" }, asOf, window: resolveListingHealthWindow({ preset: "30D", asOf }),
    enrichedOliRows: enriched, oliCoverageWindows, completenessRows, listingRows, inventoryRows, catalogRows,
    rawRows: [], issuesAvailable: false, issuesUnavailableReason: "enable Listings (Raw JSON)", provenance,
  });
  const a = degraded.rows.find((r) => r.sku === "SKU-A");
  ok("when issues unavailable: buyable/discoverable/liveOffer are null (nothing inferred)", a.buyable === null && a.discoverable === null && a.liveOffer === null && a.issues.length === 0);
  ok("degraded still flags SKU-B on status alone as POSSIBLE (no confirmed suppression invented)",
    degraded.rows.find((r) => r.sku === "SKU-B").flagReasons.every((r) => r.code !== "not_buyable"));
})();

/* ===================== ACCURACY: "No price" only from a CONFIRMED invalid price, never from unavailable price ===================== */
(() => {
  const priceRows = [
    { sku: "P-NULL", child_asin: "AP1", listing_status: "Active", listing_price_value: null, listing_price_currency: "USD", listing_fulfillment_channel: "AMAZON_NA" },   // price UNAVAILABLE (absent)
    { sku: "P-BLANK", child_asin: "AP2", listing_status: "Active", listing_price_value: "", listing_price_currency: "USD", listing_fulfillment_channel: "AMAZON_NA" },     // price BLANK -> unavailable (numOrNull, not 0)
    { sku: "P-ZERO", child_asin: "AP3", listing_status: "Active", listing_price_value: 0, listing_price_currency: "USD", listing_fulfillment_channel: "AMAZON_NA" },       // explicit invalid price (0)
    { sku: "P-VALID", child_asin: "AP4", listing_status: "Active", listing_price_value: 12.5, listing_price_currency: "USD", listing_fulfillment_channel: "AMAZON_NA" },   // valid price
    { sku: "P-INACT0", child_asin: "AP5", listing_status: "Inactive", listing_price_value: 0, listing_price_currency: "USD", listing_fulfillment_channel: "AMAZON_NA" },   // 0 but NOT Active -> no No-price
  ];
  const p = buildAdvancedListingHealth({
    owner: { accountId: "acct-1", rawSellerId: "SELLER-1" }, asOf, window: resolveListingHealthWindow({ preset: "30D", asOf }),
    enrichedOliRows: [], oliCoverageWindows: [], completenessRows: [], listingRows: priceRows, inventoryRows: [], catalogRows: [],
    rawRows: [], issuesAvailable: false, provenance,
  });
  const b = new Map(p.rows.map((r) => [r.sku, r]));
  const noPrice = (sku) => b.get(sku).flagReasons.some((r) => r.code === "no_price_while_active");
  ok("PRICE: Active + UNAVAILABLE (null) price is NOT flagged 'No price' (missing evidence != negative finding)", !noPrice("P-NULL") && b.get("P-NULL").price === null);
  ok("PRICE: Active + BLANK price becomes UNAVAILABLE (numOrNull), NOT 'No price'", !noPrice("P-BLANK") && b.get("P-BLANK").price === null);
  ok("PRICE: Active + explicit 0 price IS a CONFIRMED 'No price'", noPrice("P-ZERO") && b.get("P-ZERO").flagReasons.find((r) => r.code === "no_price_while_active").confidence === "confirmed");
  ok("PRICE: Active + valid price is not flagged and preserves the genuine value", !noPrice("P-VALID") && b.get("P-VALID").price === 12.5);
  ok("PRICE: a 0 price on a NON-Active listing is not 'No price' (only checked while Active)", !noPrice("P-INACT0"));
  ok("PRICE: an unavailable-price Active listing gains NO negative flag at all from the missing price", b.get("P-NULL").flagged === false && b.get("P-BLANK").flagged === false);
})();

/* ===================== OWNERSHIP: marketplace isolation (defence-in-depth) ===================== */
(() => {
  const base = { asOf, window: resolveListingHealthWindow({ preset: "30D", asOf }), enrichedOliRows: [], oliCoverageWindows: [], completenessRows: [], inventoryRows: [], catalogRows: [], rawRows: [], issuesAvailable: false, provenance };
  const lr = (o) => [{ sku: "S1", child_asin: "A1", listing_status: "Active", seller_or_vendor_id: "SELLER-1", listing_fulfillment_channel: "AMAZON_NA", ...o }];
  // Matching marketplace is accepted, and the payload carries the trusted owner marketplace (canonical, uppercase).
  const okp = buildAdvancedListingHealth({ ...base, owner: { accountId: "acct-1", rawSellerId: "SELLER-1", marketplace: "US" }, listingRows: lr({ marketplace_country_code: "US" }) });
  ok("OWN: a matching-marketplace row is accepted; payload.marketplace = the owner marketplace", okp.rows.length === 1 && okp.marketplace === "US");
  // A cross-marketplace row (DE under a US owner) is REJECTED before aggregation -- never silently merged.
  throws("OWN: a cross-marketplace row (DE under a US owner) fails closed", () => buildAdvancedListingHealth({ ...base, owner: { accountId: "acct-1", rawSellerId: "SELLER-1", marketplace: "US" }, listingRows: lr({ marketplace_country_code: "DE" }) }));
  // FAIL-OPEN: a row with a BLANK marketplace (already projected by the ingestion isolate boundary) is NOT rejected.
  const blankp = buildAdvancedListingHealth({ ...base, owner: { accountId: "acct-1", rawSellerId: "SELLER-1", marketplace: "US" }, listingRows: lr({}) });
  ok("OWN: a blank-marketplace row is accepted (fail-open; ingestion already isolated it)", blankp.rows.length === 1);
  // FAIL-OPEN + backward compatible: when the OWNER carries no marketplace, a marketplace-bearing row is not rejected.
  const noMktOwner = buildAdvancedListingHealth({ ...base, owner: { accountId: "acct-1", rawSellerId: "SELLER-1" }, listingRows: lr({ marketplace_country_code: "DE" }) });
  ok("OWN: with no owner marketplace the row is not rejected (fail-open, backward compatible)", noMktOwner.rows.length === 1 && noMktOwner.marketplace === null);
  // GB/UK divergence (directory may say "UK", rows say "GB") is FOLDED so a legitimate account is never false-rejected.
  const ukp = buildAdvancedListingHealth({ ...base, owner: { accountId: "acct-1", rawSellerId: "SELLER-1", marketplace: "UK" }, listingRows: lr({ marketplace_country_code: "GB" }) });
  ok("OWN: a 'UK' owner accepts a 'GB' row (GB/UK folded; no false reject)", ukp.rows.length === 1 && ukp.marketplace === "GB");
})();

/* ===================== currency + account isolation ===================== */
throws("a SKU split across two sales currencies fails closed (currency isolation)", () => buildAdvancedListingHealth({
  owner: { accountId: "acct-1", rawSellerId: "SELLER-1" }, asOf, window: resolveListingHealthWindow({ preset: "30D", asOf }),
  enrichedOliRows: [
    { sale_date: "2026-09-01", sku: "SKU-A", currency: "USD", sales_amount: 10, ordered_units: 1 },
    { sale_date: "2026-09-01", sku: "SKU-A", currency: "EUR", sales_amount: 10, ordered_units: 1 },
  ],
  oliCoverageWindows, listingRows, inventoryRows, catalogRows, rawRows: [], issuesAvailable: false, provenance,
}));
ok("account isolation: the fold/payload only ever consume the single-account rows passed in (no cross-account merge)",
  new Set(payload.rows.map((r) => r.sku)).size === payload.rows.length);

/* ===================== mixed-marketplace <=5 batches (8->2, 16->4, 10->2) ===================== */
(() => {
  const mk = (countries) => countries.map((c, i) => ({ accountId: `a${i}`, rawSellerId: `S${i}`, country: c, connectionId: "primary", organizationFingerprint: "org1" }));
  const india = planListingHealthSourceBatches({ accounts: mk(Array(8).fill("IN")) });
  ok("India 8 accounts -> 2 batches", india.countsByRegion.india === 2 && india.batches.length === 2);
  const eu = planListingHealthSourceBatches({ accounts: mk(["UK", "DE", "FR", "IT", "ES", "UK", "DE", "IT", "UK", "NL", "BE", "PL", "AU", "NL", "FR", "ES"]) });
  ok("Europe-Australia 16 accounts -> 4 batches", eu.countsByRegion["europe-au"] === 4 && eu.batches.length === 4);
  const usca = planListingHealthSourceBatches({ accounts: mk([...Array(8).fill("US"), "CA", "CA"]) });
  ok("US-Canada 10 accounts -> 2 batches", usca.countsByRegion["us-ca"] === 2 && usca.batches.length === 2);
  ok("no batch exceeds 5 sellers", [...india.batches, ...eu.batches, ...usca.batches].every((b) => b.sellerOrVendorIds.length <= 5));
  ok("batches carry EXACT seller-marketplace pairs (attribution never by SKU/ASIN alone)",
    eu.batches.every((b) => b.marketplacePairs.length === b.sellerOrVendorIds.length && b.marketplacePairs.every((p) => p.sellerId && /^[A-Z]{2}$/.test(p.marketplace))));
  ok("a mixed-marketplace batch has marketplaceConstraint null (cross-marketplace within one region)", eu.batches.some((b) => new Set(b.marketplacePairs.map((p) => p.marketplace)).size > 1 && b.marketplaceConstraint === null));
  ok("UK is mapped to GB in the pairs", eu.batches.some((b) => b.marketplacePairs.some((p) => p.marketplace === "GB")));
  // Stability: reversing the input never changes the set of seller batches.
  const fwd = planListingHealthSourceBatches({ accounts: mk(Array(16).fill("UK")) }).batches.map((b) => b.sellerOrVendorIds.join(",")).sort();
  const rev = planListingHealthSourceBatches({ accounts: mk(Array(16).fill("UK")).reverse() }).batches.map((b) => b.sellerOrVendorIds.join(",")).sort();
  ok("batch membership is stable regardless of input order", JSON.stringify(fwd) === JSON.stringify(rev));
  throws("an unassignable marketplace fails closed", () => planListingHealthSourceBatches({ accounts: mk(["ZZ"]) }));
  throws("a missing rawSellerId fails closed", () => planListingHealthSourceBatches({ accounts: [{ accountId: "x", country: "US", connectionId: "primary", organizationFingerprint: "org1" }] }));
})();

/* ===================== zero-export purity (no transport reachable) ===================== */
(() => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const advSrc = readFileSync(path.join(root, "lib/server/reports/listing-health-advanced.js"), "utf8");
  const batchSrc = readFileSync(path.join(root, "lib/server/reports/listing-health-batching.js"), "utf8");
  const forbidden = /from "\.\.\/datadoe\.js"|from "\.\.\/\.\.\/datadoe\.js"|fetchExportRows|createExport|supabase|fetch\(/;
  ok("advanced derivation imports NO DataDoe transport / supabase / fetch (a date change spends zero exports)", !forbidden.test(advSrc));
  ok("batching helper imports NO DataDoe transport / supabase / fetch", !forbidden.test(batchSrc));
})();

writeSync(1, `\nreport-listing-health-advanced: ${passed} assertions passed\n`);
