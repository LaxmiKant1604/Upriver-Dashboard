// Advanced Listing Health backend foundation (DORMANT, additive). Proves the OLI-based, window-aware derivation
// core and the <=5-seller mixed-marketplace ingestion batching, entirely offline (zero DataDoe/network).
//
// Matrix: OLI parity, date boundaries (7D/14D/30D/month/custom, inclusive), incomplete coverage, actual-vs-
// estimated units, currency/account isolation, unknown-vs-zero stock, latest-snapshot selection, FBA/FBM split,
// flagged/sales-at-risk semantics (confirmed vs possible), mixed-marketplace <=5 batches (8->2/16->4/10->2),
// malformed rows, and zero-export purity (no transport import).
// Listings inventory cutover PHASE 2: On Hand FBA follows ONE per-account source -- validated (expanded) Listings, else
// the latest FBA Inventory Health snapshot as a labelled fallback (15-column rows / unresolved conflict / unattributed
// "__EMPTY__" stock / blank FBA field), else Unavailable -- never mixed per SKU, duplicates never summed.
//
// 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { readFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  buildAdvancedListingHealth, resolveListingHealthWindow, foldOliWindowSales, assessOliCoverage,
  LISTING_HEALTH_ADVANCED_SALES_SOURCE, listingHealthInventorySelection,
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

/* ===================== full payload: Health fallback (15-column Listings), unknown-vs-zero, FBA/FBM split, flags ===================== */
// 15-column Listings rows (no fba_quantity_inbound / _reserved / _fc_transfer, plus one SKU-less row): NOT validated
// inventory evidence, so this account's On Hand FBA is the labelled FBA Inventory Health fallback.
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
  // Health fallback: latest snapshot only + unknown vs zero; the non-validated Listings quantities are NEVER mixed in.
  ok("FALLBACK: SKU-A FBA on-hand comes from the LATEST Health snapshot (30, not 999), marked fba-health-fallback", byId.get("SKU-A").onHandFba === 30 && byId.get("SKU-A").onHandFbaSource === "fba-health-fallback");
  ok("FALLBACK: SKU-C (absent from the Health snapshot) is UNAVAILABLE (null), never 0", byId.get("SKU-C").onHandFba === null && byId.get("SKU-C").onHandFbaSource === null);
  ok("FALLBACK: SKU-E (absent from Health) is UNAVAILABLE -- its Listings 0 is never mixed into a Health-sourced account", byId.get("SKU-E").onHandFba === null && byId.get("SKU-E").onHandFbaSource === null);
  ok("FALLBACK: payload.inventory = inventory-source-v1 / health-fallback with the Health date, the Listings reasons and the label",
    payload.inventory.model === "inventory-source-v1" && payload.inventory.source === "health-fallback" && payload.inventory.available === true
    && payload.inventory.snapshotDate === "2026-09-03" && payload.inventory.refreshedAt === null
    && JSON.stringify(payload.inventory.fallbackReasons) === JSON.stringify(["listings-not-expanded", "listings-invalid-rows:1"])
    && payload.inventory.unavailableReasons.length === 0
    && payload.inventory.label === "FBA Inventory Health snapshot 2026-09-03 (saved, no longer refreshed -- temporary bridge: listings-not-expanded, listings-invalid-rows:1)"
    && payload.inventory.bridgeMaxAgeDays === 2);
  ok("FALLBACK: no row is a Listings conflict (the Health value is the displayed one)", payload.rows.every((r) => r.inventoryConflict === false));
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
  ok("provenance carries source dates + the Health snapshot date (fallback source) + oli covered-to", payload.provenance.listingsFetchedAt === "2026-09-04T08:00:00Z" && payload.provenance.inventorySnapshotDate === "2026-09-03" && payload.provenance.oliCoveredTo === "2026-09-02"
    && payload.provenance.inventoryFetchedAt === "2026-09-04T08:05:00Z");
  ok("inventory snapshot date is the latest Health date (2026-09-03)", payload.inventory.snapshotDate === "2026-09-03" && payload.inventory.available === true);
})();

/* ===================== PHASE 2: validated Listings is the source (Health present but never read) ===================== */
// The EXPANDED canonical Listings fields (post-cutover 18-column export): every row carries them as own keys.
const X = { fba_quantity_inbound: 0, fba_quantity_reserved: 0, fba_quantity_fc_transfer: 0 };
const xBase = { owner: { accountId: "acct-1", rawSellerId: "SELLER-1", marketplace: "US" }, asOf, window: resolveListingHealthWindow({ preset: "30D", asOf }), enrichedOliRows: [], oliCoverageWindows: [], completenessRows: [], catalogRows: [], rawRows: [], issuesAvailable: false, provenance };
const xRow = (sku, asin, fba, o = {}) => ({ sku, child_asin: asin, listing_status: "Active", listing_fulfillment_channel: "AMAZON_NA", marketplace_country_code: "US", fba_quantity_available: fba, ...X, ...o });
const hRow = (sku, asin, available, date = "2026-09-03") => ({ date, sku, child_asin: asin, marketplace_country_code: "US", available, inbound_working: 0, inbound_shipped: 0, inbound_received: 0 });
(() => {
  const p = buildAdvancedListingHealth({ ...xBase,
    listingRows: [
      xRow("SKU-A", "ASIN-A", 30),
      xRow("SKU-E", "ASIN-E", 0),                                                    // genuine zero
      xRow("SKU-D", "ASIN-D", "8"),                                                  // numeric string -> 8
      xRow("SKU-B", "ASIN-B", 0, { listing_fulfillment_channel: "DEFAULT", listing_status: "Inactive", listing_current_quantity: 7 }), // merchant-fulfilled, FBA all 0
    ],
    inventoryRows: [hRow("SKU-A", "ASIN-A", 999), hRow("SKU-E", "ASIN-E", 55), hRow("SKU-D", "ASIN-D", 77)],
  });
  const b = new Map(p.rows.map((r) => [r.sku, r]));
  ok("LISTINGS: SKU-A on-hand is the Listings 30 (source listings) -- the Health 999 is never read", b.get("SKU-A").onHandFba === 30 && b.get("SKU-A").onHandFbaSource === "listings");
  ok("LISTINGS: a genuine Listings 0 is kept (never the Health 55, never unknown)", b.get("SKU-E").onHandFba === 0 && b.get("SKU-E").onHandFbaSource === "listings");
  ok("LISTINGS: a numeric-string quantity is read as its number", b.get("SKU-D").onHandFba === 8);
  ok("LISTINGS: a merchant-fulfilled all-zero SKU is FBA NOT applicable (never an FBA stockout); FBM on-hand 7",
    b.get("SKU-B").onHandFbaApplicable === false && b.get("SKU-B").onHandFba === null && b.get("SKU-B").onHandFbm === 7);
  ok("LISTINGS: payload.inventory = inventory-source-v1 / listings: NO inventory date, freshness = the Listings refresh time",
    p.inventory.model === "inventory-source-v1" && p.inventory.source === "listings" && p.inventory.available === true
    && p.inventory.snapshotDate === null && p.inventory.refreshedAt === "2026-09-04T08:00:00Z"
    && p.inventory.label === "Listings refreshed 2026-09-04T08:00:00Z"
    && p.inventory.fallbackReasons.length === 0 && p.inventory.unavailableReasons.length === 0 && p.inventory.conflicts.length === 0);
  ok("LISTINGS: provenance keeps the Health fetch fields but claims NO inventory snapshot date", p.provenance.inventorySnapshotDate === null && p.provenance.inventoryFetchedAt === "2026-09-04T08:05:00Z");
  ok("LISTINGS: no row is flagged as an inventory conflict", p.rows.every((r) => r.inventoryConflict === false));
})();

/* ===================== PHASE 2: Unavailable (no validated Listings and no Health) ===================== */
(() => {
  const p = buildAdvancedListingHealth({ ...xBase,
    listingRows: [{ sku: "U1", child_asin: "B1", listing_status: "Inactive", listing_fulfillment_channel: "AMAZON_NA", fba_quantity_available: 40 }], // 15-column
    inventoryRows: [],
  });
  ok("UNAVAILABLE: 15-column Listings + no Health -> on-hand null (never the Listings 40, never 0)", p.rows[0].onHandFba === null && p.rows[0].onHandFbaSource === null);
  ok("UNAVAILABLE: payload.inventory carries both reasons, no date, no refresh time, label 'FBA inventory unavailable'",
    p.inventory.model === "inventory-source-v1" && p.inventory.source === "unavailable" && p.inventory.available === false
    && p.inventory.snapshotDate === null && p.inventory.refreshedAt === null && p.provenance.inventorySnapshotDate === null
    && JSON.stringify(p.inventory.unavailableReasons) === JSON.stringify(["listings-not-expanded", "health-snapshot-missing"])
    && JSON.stringify(p.inventory.fallbackReasons) === JSON.stringify(["listings-not-expanded"])
    && p.inventory.label === "FBA inventory unavailable");
  ok("UNAVAILABLE: an unknown on-hand never raises stranded stock", !p.rows[0].flagReasons.some((r) => r.code === "stranded_stock"));
  const empty = buildAdvancedListingHealth({ ...xBase, listingRows: [], inventoryRows: [] });
  ok("UNAVAILABLE: no Listings rows and no Health -> reasons listings-empty + health-snapshot-missing", empty.inventory.available === false
    && JSON.stringify(empty.inventory.unavailableReasons) === JSON.stringify(["listings-empty", "health-snapshot-missing"]));
})();

/* ===================== PHASE 2: duplicate listing rows (identical once; conflicting -> fallback / unavailable) ===================== */
(() => {
  // Identical duplicate rows of one SKU count ONCE (Listings stays validated).
  const same = buildAdvancedListingHealth({ ...xBase, listingRows: [xRow("DUP", "A1", 30), xRow("DUP", "A1", 30), xRow("OTH", "A2", 9)], inventoryRows: [] });
  ok("DUP: identical duplicate rows -> Listings validated, on-hand 30 on each row (never 60)",
    same.inventory.source === "listings" && same.rows.filter((r) => r.sku === "DUP").length === 2 && same.rows.filter((r) => r.sku === "DUP").every((r) => r.onHandFba === 30 && r.inventoryConflict === false));
  // Conflicting duplicates (quantities differ) -> Listings NOT validated; with Health -> the labelled fallback.
  const conflictRows = [xRow("DUP", "A1", 30), xRow("DUP", "A1", 12), xRow("OTH", "A2", 9)];
  const fb = buildAdvancedListingHealth({ ...xBase, listingRows: conflictRows, inventoryRows: [hRow("DUP", "A1", 31), hRow("OTH", "A2", 4)] });
  ok("DUP: conflicting duplicates + Health -> health-fallback (reason listings-unresolved-conflicts:1), conflict reported",
    fb.inventory.source === "health-fallback" && fb.inventory.fallbackReasons.includes("listings-unresolved-conflicts:1")
    && fb.inventory.conflicts.length === 1 && fb.inventory.conflicts[0].sku === "DUP" && fb.inventory.conflicts[0].reasons.includes("duplicate-different-quantities"));
  ok("DUP: in the fallback every SKU reads the Health value (DUP 31, OTH 4 -- never the Listings 9)",
    fb.rows.filter((r) => r.sku === "DUP").every((r) => r.onHandFba === 31 && r.onHandFbaSource === "fba-health-fallback") && fb.rows.find((r) => r.sku === "OTH").onHandFba === 4);
  // Without Health -> the whole account is Unavailable (no partial Listings figure presented as complete).
  const un = buildAdvancedListingHealth({ ...xBase, listingRows: conflictRows, inventoryRows: [] });
  ok("DUP: conflicting duplicates + no Health -> Unavailable for EVERY SKU (null), conflict still reported",
    un.inventory.source === "unavailable" && un.rows.every((r) => r.onHandFba === null) && un.inventory.conflicts.length === 1
    && un.inventory.unavailableReasons[0] === "listings-unresolved-conflicts:1" && un.inventory.unavailableReasons[un.inventory.unavailableReasons.length - 1] === "health-snapshot-missing");
  // IDENTITY conflict (only the ASIN differs; FNSKU + quantities agree) resolved by the account's OWN sales (R2) -> validated.
  const idRows = [xRow("R2", "ASIN-R1", 6, { fnsku: "X00R2" }), xRow("R2", "ASIN-R2", 6, { fnsku: "X00R2" })];
  const oli = [{ sale_date: "2026-09-01", sku: "R2", child_asin: "ASIN-R2", currency: "USD", sales_amount: 10, ordered_units: 1 }];
  const r2 = buildAdvancedListingHealth({ ...xBase, enrichedOliRows: oli, listingRows: idRows, inventoryRows: [] });
  ok("DUP: an ASIN identity conflict resolved by the account's own sales (R2) keeps Listings validated and is REPORTED",
    r2.inventory.source === "listings" && r2.rows.every((r) => r.onHandFba === 6) && r2.inventory.resolvedConflicts.length === 1
    && r2.inventory.resolvedConflicts[0].rules.includes("R2-sales-asin"));
  const noSales = buildAdvancedListingHealth({ ...xBase, listingRows: idRows, inventoryRows: [] });
  ok("DUP: the same identity conflict WITHOUT sales evidence stays unresolved -> Unavailable (never a guessed ASIN)",
    noSales.inventory.source === "unavailable" && noSales.rows.every((r) => r.onHandFba === null) && noSales.inventory.conflicts[0].reasons.includes("duplicate-different-asin"));
})();

/* ===================== PHASE 2: "__EMPTY__" ASIN, blank FBA field, never mixing sources ===================== */
(() => {
  // DataDoe's "__EMPTY__" placeholder is a MISSING ASIN: shown blank; its stock is unattributed unless the account's own
  // sales map the SKU to exactly one ASIN.
  const emp = [xRow("EMP", "__EMPTY__", 5), xRow("SKU-A", "ASIN-A", 30)];
  const fb = buildAdvancedListingHealth({ ...xBase, listingRows: emp, inventoryRows: [hRow("EMP", "ASIN-EMP", 4), hRow("SKU-A", "ASIN-A", 31)] });
  const e = fb.rows.find((r) => r.sku === "EMP");
  ok("EMPTY: '__EMPTY__' is shown as a missing ASIN (null), never a product key", e.asin === null);
  ok("EMPTY: unattributed stock -> health-fallback (reason listings-unattributed-stock:1); EMP 4 + SKU-A 31 from Health",
    fb.inventory.source === "health-fallback" && fb.inventory.fallbackReasons.join(",") === "listings-unattributed-stock:1"
    && e.onHandFba === 4 && fb.rows.find((r) => r.sku === "SKU-A").onHandFba === 31);
  const oli = [{ sale_date: "2026-09-01", sku: "EMP", child_asin: "ASIN-EMP", currency: "USD", sales_amount: 10, ordered_units: 1 }];
  const res = buildAdvancedListingHealth({ ...xBase, enrichedOliRows: oli, listingRows: emp, inventoryRows: [hRow("EMP", "ASIN-EMP", 4)] });
  ok("EMPTY: the account's own sales resolve the missing ASIN -> Listings validated (EMP 5, SKU-A 30), ASIN still shown blank",
    res.inventory.source === "listings" && res.rows.find((r) => r.sku === "EMP").onHandFba === 5 && res.rows.find((r) => r.sku === "EMP").asin === null
    && res.rows.find((r) => r.sku === "SKU-A").onHandFba === 30);
  // A blank FBA field on an FBA-channel SKU -> Listings NOT validated.
  const blank = buildAdvancedListingHealth({ ...xBase, listingRows: [xRow("BL", "ASIN-BL", ""), xRow("SKU-A", "ASIN-A", 30)], inventoryRows: [hRow("BL", "ASIN-BL", 2), hRow("SKU-A", "ASIN-A", 29)] });
  ok("BLANK: a blank FBA quantity -> health-fallback (listings-blank-fba-fields:1); BL 2 + SKU-A 29 from Health",
    blank.inventory.source === "health-fallback" && blank.inventory.fallbackReasons.join(",") === "listings-blank-fba-fields:1"
    && blank.rows.find((r) => r.sku === "BL").onHandFba === 2 && blank.rows.find((r) => r.sku === "SKU-A").onHandFba === 29);
  const blankInbound = buildAdvancedListingHealth({ ...xBase, listingRows: [xRow("BI", "ASIN-BI", 3, { fba_quantity_inbound: null })], inventoryRows: [] });
  ok("BLANK: a blank FBA inbound (available known) also blocks validation -> Unavailable without Health", blankInbound.inventory.source === "unavailable" && blankInbound.rows[0].onHandFba === null);
  // The Health fallback never fills a SKU from Listings: a SKU absent from Health stays null.
  const mix = buildAdvancedListingHealth({ ...xBase, listingRows: [xRow("BL", "ASIN-BL", ""), xRow("ONLY-L", "ASIN-OL", 12)], inventoryRows: [hRow("BL", "ASIN-BL", 2)] });
  ok("MIX: in a Health-sourced account a SKU absent from Health is null -- its Listings 12 is NEVER used",
    mix.inventory.source === "health-fallback" && mix.rows.find((r) => r.sku === "ONLY-L").onHandFba === null && mix.rows.find((r) => r.sku === "ONLY-L").onHandFbaSource === null);
  // A merchant-fulfilled (DEFAULT) listing whose FBA stock the Health fallback PROVES positive keeps it visible.
  const mfn = buildAdvancedListingHealth({ ...xBase, listingRows: [xRow("M1", "ASIN-M1", "", { listing_fulfillment_channel: "DEFAULT", listing_current_quantity: 2 }), xRow("BL", "ASIN-BL", "")], inventoryRows: [hRow("M1", "ASIN-M1", 3), hRow("BL", "ASIN-BL", 1)] });
  ok("MIX: a DEFAULT listing with Health-proven positive FBA stock keeps it visible (3, applicable, source fba-health-fallback)",
    mfn.rows.find((r) => r.sku === "M1").onHandFbaApplicable === true && mfn.rows.find((r) => r.sku === "M1").onHandFba === 3 && mfn.rows.find((r) => r.sku === "M1").onHandFbaSource === "fba-health-fallback");
  // The pure selection helper agrees with the payload (one shared decision).
  const s = listingHealthInventorySelection({ listingRows: [xRow("SKU-A", "ASIN-A", 30)], inventoryRows: [], marketplace: "us", listingsRefreshedAt: "2026-09-04T08:00:00Z" });
  ok("HELPER: listingHealthInventorySelection -> listings source, SKU-A 30, label with the refresh time", s.source === "listings" && s.skus.get("SKU-A").fbaAvailable === 30 && s.label === "Listings refreshed 2026-09-04T08:00:00Z");
})();

/* ===================== CUTOVER: the saved Health snapshot is a READ-ONLY BRIDGE with a 2-day threshold ===================== */
(() => {
  // asOf = 2026-09-04: a bridge dated 2026-09-02 (asOf - 2) still serves; 2026-09-01 is stale -> Unavailable (typed).
  const conflictRows = [xRow("DUP", "A1", 30), xRow("DUP", "A1", 12)]; // AAKRITI-style unresolved duplicate
  const edge = buildAdvancedListingHealth({ ...xBase, listingRows: conflictRows, inventoryRows: [hRow("DUP", "A1", 31, "2026-09-02")] });
  ok("BRIDGE: dated asOf-2 -> still the source (31), labelled as the saved temporary bridge",
    edge.inventory.source === "health-fallback" && edge.rows.every((r) => r.onHandFba === 31) && /saved, no longer refreshed -- temporary bridge/.test(edge.inventory.label));
  const stale = buildAdvancedListingHealth({ ...xBase, listingRows: conflictRows, inventoryRows: [hRow("DUP", "A1", 31, "2026-09-01")] });
  ok("BRIDGE: older than asOf-2 -> Unavailable for EVERY SKU (never the stale 31, never 0) with the typed reason",
    stale.inventory.source === "unavailable" && stale.rows.every((r) => r.onHandFba === null) && stale.inventory.snapshotDate === null
    && JSON.stringify(stale.inventory.unavailableReasons) === JSON.stringify(["listings-unresolved-conflicts:1", "health-bridge-stale:2026-09-01"]));
  // FR-style "__EMPTY__" unattributed stock: the bridge while fresh; Unavailable once stale.
  const emp = [xRow("EMP", "__EMPTY__", 5), xRow("SKU-A", "ASIN-A", 30)];
  ok("BRIDGE: FR __EMPTY__ unattributed -> the fresh bridge", buildAdvancedListingHealth({ ...xBase, listingRows: emp, inventoryRows: [hRow("SKU-A", "ASIN-A", 31)] }).inventory.source === "health-fallback");
  ok("BRIDGE: FR __EMPTY__ unattributed + a stale bridge -> Unavailable", buildAdvancedListingHealth({ ...xBase, listingRows: emp, inventoryRows: [hRow("SKU-A", "ASIN-A", 31, "2026-08-20")] }).inventory.source === "unavailable");
  // Without the report as-of the bridge is refused (never an undated Health figure).
  const noAsOf = listingHealthInventorySelection({ listingRows: conflictRows, inventoryRows: [hRow("DUP", "A1", 31)], marketplace: "US" });
  ok("BRIDGE: no as-of -> refused (health-bridge-as-of-missing)", noAsOf.source === "unavailable" && noAsOf.unavailableReasons.includes("health-bridge-as-of-missing"));
  // The caller's typed reason for having no saved Health snapshot is carried (e.g. a read failure).
  const missing = buildAdvancedListingHealth({ ...xBase, listingRows: conflictRows, inventoryRows: [], inventoryUnavailableReason: "health-snapshot-read-failed" });
  ok("BRIDGE: no saved Health rows -> the caller's reason (health-snapshot-read-failed) is carried",
    missing.inventory.unavailableReasons[missing.inventory.unavailableReasons.length - 1] === "health-snapshot-read-failed");
  // Validated Listings never need the bridge (a stale one is irrelevant to them).
  ok("BRIDGE: validated Listings ignore even a stale bridge", buildAdvancedListingHealth({ ...xBase, listingRows: [xRow("SKU-A", "ASIN-A", 30)], inventoryRows: [hRow("SKU-A", "ASIN-A", 999, "2026-08-01")] }).inventory.source === "listings");
})();

/* ===================== PHASE 2: DEFAULT (merchant-fulfilled) + stranded stock from validated Listings ===================== */
(() => {
  const p = buildAdvancedListingHealth({ ...xBase, owner: { accountId: "acct-1", rawSellerId: "SELLER-1" }, listingRows: [
    { sku: "M-POS", child_asin: "C1", listing_status: "Active", listing_fulfillment_channel: "DEFAULT", listing_current_quantity: 3, fba_quantity_available: 5, ...X },
    { sku: "M-ZERO", child_asin: "C2", listing_status: "Active", listing_fulfillment_channel: "DEFAULT", listing_current_quantity: 3, fba_quantity_available: 0, ...X },
    { sku: "F-STR", child_asin: "C3", listing_status: "Inactive", listing_fulfillment_channel: "AMAZON_NA", listing_current_quantity: null, fba_quantity_available: 10, ...X },
    { sku: "F-ZERO", child_asin: "C4", listing_status: "Inactive", listing_fulfillment_channel: "AMAZON_NA", listing_current_quantity: null, fba_quantity_available: 0, ...X },
  ], inventoryRows: [] });
  const b = new Map(p.rows.map((r) => [r.sku, r]));
  ok("DEFAULT: a merchant-fulfilled listing with PROVEN positive Listings FBA stock keeps it visible (5, applicable)", p.inventory.source === "listings" && b.get("M-POS").onHandFbaApplicable === true && b.get("M-POS").onHandFba === 5 && b.get("M-POS").onHandFbm === 3);
  ok("DEFAULT: a merchant-fulfilled zero is NOT applicable (never an FBA stockout)", b.get("M-ZERO").onHandFbaApplicable === false && b.get("M-ZERO").onHandFba === null);
  ok("DEFAULT: the stranded gate keeps the OWN channel's on-hand (an Active DEFAULT row with FBA 5 is not stranded)", !b.get("M-POS").flagReasons.some((r) => r.code === "stranded_stock"));
  ok("STRANDED: an Inactive FBA listing with Listings on-hand 10 is 'possible' stranded stock", b.get("F-STR").flagReasons.some((r) => r.code === "stranded_stock" && r.confidence === "possible"));
  ok("STRANDED: an Inactive FBA listing with a genuine Listings 0 is not stranded", !b.get("F-ZERO").flagReasons.some((r) => r.code === "stranded_stock"));
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
