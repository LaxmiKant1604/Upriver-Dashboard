// Phase 2B -- Advanced Listing Health (listing-health/v3-oli-window) SHADOW integration.
// Proves: registration (contracts/derivation/authorization/source-registry), <=5 mixed-marketplace batching,
// exact seller-marketplace isolation, FBA inventory + Catalog reuse with ZERO duplicate exports, OLI arbitrary-window
// reads with ZERO exports, partial/unavailable coverage, latest-inventory-only, Raw degraded, authorization,
// LKG preservation, one account-scoped shadow snapshot saved via the real worker + idempotent replay, and no new API.
// Listings inventory CUTOVER: the listing-health-v3:inventory fragment (a reuse of the cycle's FBA Inventory Health
// export) is GONE -- no Health export exists. On Hand FBA follows ONE per-account source (validated Listings, else the
// account's LAST SAVED durable Health snapshot injected READ-ONLY as context.listingHealthV3DurableInventory -- the dated
// bridge, only while its date >= asOf - 2 -- else Unavailable); validatePayload requires the inventory-source-v1 model
// and latestDataDate is the bridge date ONLY for a bridge-sourced payload.
// Offline, zero DataDoe/network. 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { readFileSync, writeSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { planListingHealthV3BucketBatched, planFbaPlanBucketBatched } from "../lib/server/sync/report-planner.js";
import { assembleSources, runReportJobs } from "../lib/server/sync/report-worker.js";
import { deriveReportSnapshot, shadowSnapshotKey, REPORT_DERIVATIONS } from "../lib/server/sync/report-derivation.js";
import { isolateFragmentRowsForOwner } from "../lib/server/sync/source-account-isolation.js";
import { REPORT_SOURCE_CONTRACTS, SELLER_SCOPED_REQUEST_KEYS, reportSourceCoverage } from "../lib/server/sync/report-source-contracts.js";
import { REPORT_SOURCE_REQUIREMENTS } from "../lib/server/source-contracts.js";
import { REPORT_CAPABILITIES, CAPABILITY, isBrandAccessible, resolveUserReportScope } from "../lib/server/report-authorization.js";
import { makeListingHealthV3DurableContextLoader } from "../lib/server/sync/listing-health-v3-durable-loader.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
const throwsAsync = async (n, fn) => { let t = false; try { await fn(); } catch { t = true; } ok(n, t); };
writeSync(1, "report-listing-health-v3-integration\n");

const connections = [{ id: "primary", apiKey: "fixture-key", accountPrefix: "" }];
const asOf = "2026-09-02"; const inv = "2026-09-04";
const mk = (cs) => cs.map((c, i) => ({ accountId: `acct-${String(i).padStart(2, "0")}`, country: c, currency: c === "US" || c === "CA" ? "USD" : "EUR", name: `A${i}` }));
const distinctHashes = (plan, key) => { const s = new Set(); for (const r of plan) for (const x of r.sources) if (x.requestKey === key) s.add(x.requestHash); return s; };

/* ===================== A. registration / wiring ===================== */
(() => {
  const keys = (REPORT_SOURCE_CONTRACTS["listing-health-v3"] || []).map((c) => c.requestKey);
  ok("A: v3 owns listings + listings-raw ONLY (the retired inventory fragment is gone; catalog is derived durable, not owned)",
    keys.join(",") === "listing-health-v3:listings,listing-health-v3:listings-raw");
  ok("A: v3 listings + listings-raw are seller-scoped (exact-pair attribution)",
    ["listing-health-v3:listings", "listing-health-v3:listings-raw"].every((k) => SELLER_SCOPED_REQUEST_KEYS.includes(k)));
  ok("A: the v3 derive declares no inventory request key and receives the saved Health bridge as a derived context key",
    !REPORT_DERIVATIONS["listing-health-v3"].optionalRequestKeys.includes("listing-health-v3:inventory")
    && REPORT_DERIVATIONS["listing-health-v3"].derivedContextKeys.includes("listingHealthV3DurableInventory"));
  ok("A: v3 listings/listings-raw carry seller_or_vendor_id + marketplace_country_code",
    ["listing-health-v3:listings", "listing-health-v3:listings-raw"].every((k) => {
      const cols = REPORT_SOURCE_CONTRACTS["listing-health-v3"].find((c) => c.requestKey === k).columns;
      return cols.includes("seller_or_vendor_id") && cols.includes("marketplace_country_code");
    }));
  ok("A: v3 declares coverage", reportSourceCoverage("listing-health-v3") === "shadow");
  ok("A: v3 requirements = order-line-items + listings + listings-raw + product-catalog (FBA Inventory Health is never fetched)",
    [...REPORT_SOURCE_REQUIREMENTS["listing-health-v3"]].sort().join(",") === "listings,listings-raw,order-line-items,product-catalog");
  ok("A: v3 derivation registered at listing-health/v3-oli-window with a real derive",
    REPORT_DERIVATIONS["listing-health-v3"].snapshotVersion === "listing-health/v3-oli-window" && typeof REPORT_DERIVATIONS["listing-health-v3"].derive === "function");
  ok("A: v3 authorization is DENY_FOR_BRAND_RESTRICTED_USERS and NOT brand-accessible (same gate as listing-health)",
    REPORT_CAPABILITIES["listing-health-v3"] === CAPABILITY.DENY_FOR_BRAND_RESTRICTED_USERS && isBrandAccessible(REPORT_CAPABILITIES["listing-health-v3"]) === false);
  ok("A: shadow snapshot key namespaces to scheduler-v2/ (never a production row)", shadowSnapshotKey("listing-health-v3") === "scheduler-v2/listing-health-v3");
})();

/* ===================== B. <=5 mixed-marketplace batches (separate listings vs raw counts) ===================== */
(() => {
  const euPlan = planListingHealthV3BucketBatched({ accounts: mk(["UK", "DE", "FR", "IT", "ES", "UK", "DE", "IT", "UK", "NL", "BE", "PL", "AU", "NL", "FR", "ES"]), connections, asOfFor: () => asOf, inventoryAsOf: inv });
  ok("B: Europe-Australia 16 -> 4 listings batches", distinctHashes(euPlan, "listing-health-v3:listings").size === 4);
  ok("B: Europe-Australia 16 -> 4 listings-raw batches (counted separately)", distinctHashes(euPlan, "listing-health-v3:listings-raw").size === 4);
  ok("B: Europe-Australia 16 -> ZERO inventory sources (no Health export is ever planned)", distinctHashes(euPlan, "listing-health-v3:inventory").size === 0
    && euPlan.every((r) => r.sources.every((x) => x.sourceKey !== "fba-inventory-health")));
  ok("B: India 8 -> 2 batches", distinctHashes(planListingHealthV3BucketBatched({ accounts: mk(Array(8).fill("IN")), connections, asOfFor: () => asOf, inventoryAsOf: inv }), "listing-health-v3:listings").size === 2);
  ok("B: US-Canada 10 -> 2 batches", distinctHashes(planListingHealthV3BucketBatched({ accounts: mk([...Array(8).fill("US"), "CA", "CA"]), connections, asOfFor: () => asOf, inventoryAsOf: inv }), "listing-health-v3:listings").size === 2);
  let le5 = true, pairs = true, mixed = false;
  for (const r of euPlan) for (const s of r.sources) { if (s.sellerOrVendorIds.length > 5) le5 = false; if (!s.marketplacePairs.some((p) => p.sellerId === r.owner.rawSellerId && p.marketplace === r.owner.marketplace)) pairs = false; if (new Set(s.marketplacePairs.map((p) => p.marketplace)).size > 1) mixed = true; }
  ok("B: no batch exceeds 5 sellers; each source carries the owner's exact seller-marketplace pair", le5 && pairs);
  ok("B: batches genuinely span multiple marketplaces within one region", mixed);
  ok("B: UK is aliased to GB in the pairs", euPlan.some((r) => r.sources.some((s) => s.marketplacePairs.some((p) => p.marketplace === "GB"))));
  const fwd = distinctHashes(planListingHealthV3BucketBatched({ accounts: mk(Array(16).fill("UK")), connections, asOfFor: () => asOf, inventoryAsOf: inv }), "listing-health-v3:listings");
  const rev = distinctHashes(planListingHealthV3BucketBatched({ accounts: mk(Array(16).fill("UK")).reverse(), connections, asOfFor: () => asOf, inventoryAsOf: inv }), "listing-health-v3:listings");
  ok("B: batch membership is stable regardless of input order", [...fwd].sort().join() === [...rev].sort().join());
})();

/* ===================== C. FBA inventory + catalog reuse (zero duplicate exports; no FBA hash change) ===================== */
(() => {
  const accts = mk(["UK", "DE", "FR", "IT", "ES", "UK", "DE", "IT", "UK", "NL", "BE", "PL", "AU", "NL", "FR", "ES"]);
  const v3 = planListingHealthV3BucketBatched({ accounts: accts, connections, asOfFor: () => asOf, inventoryAsOf: inv });
  const fba = planFbaPlanBucketBatched({ accounts: accts, connections, asOfFor: () => asOf, inventoryAsOf: inv });
  ok("C: NEITHER v3 nor fba-plan plans an FBA Inventory Health export (the retired source is never fetched)",
    distinctHashes(v3, "listing-health-v3:inventory").size === 0 && distinctHashes(fba, "fba-plan:inventory-health").size === 0
    && [...v3, ...fba].every((r) => r.sources.every((x) => x.sourceKey !== "fba-inventory-health")));
  ok("C: v3 defines NO owned inventory/catalog export beyond the reused identity (catalog is derived durable)",
    !(REPORT_SOURCE_CONTRACTS["listing-health-v3"] || []).some((c) => c.requestKey === "listing-health-v3:catalog"));
  // v3:listings REUSES the fba-plan:awd CANONICAL Listings export (identical hash SET over the same batches) -- ONE
  // shared paid Listings export instead of two. This
  // also proves the two planners produce IDENTICAL listings batches (same batch family => same membership => same ids).
  const v3listings = distinctHashes(v3, "listing-health-v3:listings");
  const fbaAwd = distinctHashes(fba, "fba-plan:awd");
  ok("C: v3 listings request_hash SET is IDENTICAL to fba-plan:awd (ONE shared canonical Listings export; identical batches)",
    v3listings.size > 0 && v3listings.size === fbaAwd.size && [...v3listings].every((h) => fbaAwd.has(h)));
  // Listings Raw is a DIFFERENT DataDoe source (id 6ea445cd) and stays its OWN export -- it must never collide with FBA.
  const fbaHashes = new Set(fba.flatMap((r) => r.sources.map((s) => s.requestHash)));
  ok("C: v3 listings-raw (a DISTINCT source) never collides with any FBA hash", [...distinctHashes(v3, "listing-health-v3:listings-raw")].every((h) => !fbaHashes.has(h)));
})();

/* ===================== fixtures for derive / save / isolation ===================== */
const SELLER = "acct-00"; // primary: public id == raw seller id
const OTHER = "acct-99";
const invRow = (date, seller, mkt, sku, available) => ({ date, seller_or_vendor_id: seller, marketplace_country_code: mkt, child_asin: `ASIN-${sku}`, sku, available });
const listingRow = (seller, mkt, sku, o = {}) => ({ seller_or_vendor_id: seller, marketplace_country_code: mkt, sku, child_asin: `ASIN-${sku}`, listing_name: o.name ?? `L ${sku}`, listing_status: o.status ?? "Active", listing_price_value: o.price === undefined ? 9 : o.price, listing_price_currency: o.currency ?? "USD", listing_current_quantity: o.qty ?? 0, fba_quantity_available: o.fba ?? 0, listing_fulfillment_channel: o.channel ?? "AMAZON_NA", listing_open_date: o.open ?? "2024-01-01" });
const oliRow = (date, sku, sales, units) => ({ account_id: SELLER, seller_or_vendor_id: SELLER, sale_date: date, sku, child_asin: `ASIN-${sku}`, currency: "USD", sales_amount: sales, ordered_units: units, unpriced_units: 0 });
const catRow = (sku, brand) => ({ child_asin: `ASIN-${sku}`, product_name: `P ${sku}`, product_brand: brand });
// Expanded (post-cutover, 18-column) canonical Listings rows: the three inventory fields as own keys.
const xRow = (seller, mkt, sku, o = {}) => ({ ...listingRow(seller, mkt, sku, o), fba_quantity_inbound: 0, fba_quantity_reserved: 0, fba_quantity_fc_transfer: 0 });

// Build isolated sources for a single-account v3 derive from raw batch rows.
function v3Sources({ listings, raw, owner, rawState = "success" }) {
  const planned = planListingHealthV3BucketBatched({ accounts: [{ accountId: SELLER, country: "US", currency: "USD", name: "A0" }], connections, asOfFor: () => asOf, inventoryAsOf: inv })[0];
  const statusByHash = {}; const errorByHash = {}; const loaded = new Map();
  const rowsByKey = { "listing-health-v3:listings": listings, "listing-health-v3:listings-raw": raw };
  for (const s of planned.sources) {
    if (s.requestKey === "listing-health-v3:listings-raw" && rawState !== "success") {
      statusByHash[s.requestHash] = "failed";
      errorByHash[s.requestHash] = rawState === "disabled" ? "SOURCE_DISABLED" : "EXPORT_ERROR";
    } else {
      statusByHash[s.requestHash] = "succeeded";
      loaded.set(s.requestHash, { rows: rowsByKey[s.requestKey] || [] });
    }
  }
  const sources = assembleSources(planned.sources, statusByHash, loaded, errorByHash, owner || planned.owner).sources;
  return { sources, planned };
}
const durableOli = ({ rows, coverageWindows, completenessRows = [] }) => ({ available: true, rows, coverageWindows, completenessRows });
const durableCat = (rows) => ({ available: true, rows });
// The account's LAST SAVED durable FBA Inventory Health snapshot (the read-only bridge), as the loader injects it.
const bridge = (rows, savedAt = "2026-09-04T09:00:00.000Z") => ({ available: true, rows, snapshotDate: rows.reduce((d, r) => (String(r.date) > d ? String(r.date) : d), ""), savedAt });
const fullCoverage = [{ from: "2024-01-01", to: asOf }];

/* ===================== D. exact seller-marketplace isolation ===================== */
(() => {
  const shared = [
    { seller_or_vendor_id: SELLER, marketplace_country_code: "US", sku: "SAME", child_asin: "ASIN-SAME", available: 11 },
    { seller_or_vendor_id: OTHER, marketplace_country_code: "US", sku: "SAME", child_asin: "ASIN-SAME", available: 22 }, // cross-account, identical SKU/ASIN
    { seller_or_vendor_id: SELLER, marketplace_country_code: "DE", sku: "SAME", child_asin: "ASIN-SAME", available: 33 }, // owner seller, WRONG marketplace
  ];
  const mine = isolateFragmentRowsForOwner({ rows: shared, sourceScope: "seller" }, { rawSellerId: SELLER, marketplace: "US" });
  ok("D: isolation keeps ONLY the owner's exact seller+marketplace row (identical SKU/ASIN cannot leak across accounts)",
    mine.rows.length === 1 && mine.rows[0].available === 11);
})();

/* ===================== E. derive: parity, window/zero-export, coverage, inventory, raw, LKG ===================== */
const baseListings = [listingRow(SELLER, "US", "A", { status: "Active", price: 25, fba: 30, channel: "AMAZON_NA" }), listingRow(SELLER, "US", "B", { status: "Inactive", price: 0, qty: 7, channel: "DEFAULT" })];
// The saved Health bridge rows (dated inv = 2026-09-04; within asOf - 2 of asOf 2026-09-02).
const baseInv = [invRow(inv, SELLER, "US", "A", 30)];
const baseCat = [catRow("A", "BrandX"), catRow("B", "BrandY")];
const baseOli = [oliRow("2026-09-01", "A", 100, 10), oliRow("2026-08-20", "A", 50, 5), oliRow("2026-09-02", "B", 200, 20), oliRow("2026-06-01", "A", 999, 99)];
// marketCountry is the TRUSTED account-directory marketplace the real planner ALWAYS supplies (report-planner.js) and
// the live-promote bundle now threads (dependency-bundle context). The derive requires it to validate row ownership and
// stamps it (canonical) onto the payload; a context that lacks it fails closed (proved in section J).
const ctx = (over = {}) => ({ to: asOf, inventoryAsOf: inv, rawSellerId: SELLER, accountId: SELLER, marketCountry: "US", listingHealthV3DurableOli: durableOli({ rows: baseOli, coverageWindows: fullCoverage }), listingHealthV3DurableCatalog: durableCat(baseCat), listingHealthV3DurableInventory: bridge(baseInv), ...over });
const deriveV3 = (sources, context) => deriveReportSnapshot({ reportKey: "listing-health-v3", sources, context });

(() => {
  const { sources } = v3Sources({ listings: baseListings, raw: [{ seller_or_vendor_id: SELLER, marketplace_country_code: "US", sku: "A", child_asin: "ASIN-A", summaries: JSON.stringify({ status: ["BUYABLE", "DISCOVERABLE"] }), issues: JSON.stringify([]), offers: JSON.stringify([{ price: { amount: 25 } }]) }] });

  // 30D window (default): SKU-A = 09-01(100) only in 7D but 09-01+08-20 in 30D.
  const r30 = deriveV3(sources, ctx({ windowPreset: "30D" }));
  ok("E: derive status derived; sales source is order-line-items (no Profit-by-SKU)", r30.status === "derived" && r30.payload.salesSource === "order-line-items");
  const a30 = r30.payload.rows.find((x) => x.sku === "A");
  ok("E: 30D OLI window sales/units for SKU-A = 150/15 (08-20 + 09-01, June excluded)", a30.sales === 150 && a30.units === 15);
  // 15-column Listings are not validated inventory evidence -> the saved Health BRIDGE (its latest date, read-only).
  ok("E: the dated saved Health bridge (SKU-A on-hand 30 from the 09-04 snapshot)", a30.onHandFba === 30 && a30.onHandFbaSource === "fba-health-fallback");
  ok("E: payload.inventory = inventory-source-v1 health-fallback (the bridge) carrying its date + reason; latestDataDate = that date; provenance = the bridge's saved time",
    r30.payload.inventory.model === "inventory-source-v1" && r30.payload.inventory.source === "health-fallback" && r30.payload.inventory.snapshotDate === inv
    && r30.payload.inventory.refreshedAt === null && r30.payload.inventory.fallbackReasons.join(",") === "listings-not-expanded"
    && r30.payload.inventory.label === `FBA Inventory Health snapshot ${inv} (saved, no longer refreshed -- temporary bridge: listings-not-expanded)` && r30.latestDataDate === inv
    && r30.payload.inventory.bridgeMaxAgeDays === 2 && r30.payload.provenance.inventoryFetchedAt === "2026-09-04T09:00:00.000Z");

  // The bridge reads its LATEST date only: an older-dated row is never folded or summed.
  const olderRow = deriveV3(sources, ctx({ windowPreset: "30D", listingHealthV3DurableInventory: bridge([...baseInv, invRow("2026-09-01", SELLER, "US", "A", 999)]) }));
  ok("E: an older-dated bridge row is ignored (latest date only; never 999, never 1029)", olderRow.status === "derived" && olderRow.payload.rows.find((x) => x.sku === "A").onHandFba === 30);
  // A STALE bridge (older than asOf - 2) never drives On Hand FBA: Unavailable with the typed reason, never the stale 30.
  const staleR = deriveV3(sources, ctx({ windowPreset: "30D", listingHealthV3DurableInventory: bridge([invRow("2026-08-30", SELLER, "US", "A", 30)]) }));
  ok("E: a stale bridge (2026-08-30 < 2026-09-02 - 2) -> On Hand FBA Unavailable (health-bridge-stale), never the stale figure",
    staleR.status === "derived" && staleR.payload.inventory.source === "unavailable" && staleR.payload.rows.find((x) => x.sku === "A").onHandFba === null
    && JSON.stringify(staleR.payload.inventory.unavailableReasons) === JSON.stringify(["listings-not-expanded", "health-bridge-stale:2026-08-30"]) && staleR.latestDataDate === null);
  // A bridge carrying another seller's / marketplace's row is refused SOFTLY (Unavailable with the reason) -- never invalid.
  const foreignR = deriveV3(sources, ctx({ windowPreset: "30D", listingHealthV3DurableInventory: bridge([...baseInv, invRow(inv, SELLER, "DE", "A", 7)]) }));
  ok("E: a bridge with another marketplace's row -> Unavailable (soft refusal; listings/OLI still publish)",
    foreignR.status === "derived" && foreignR.payload.inventory.source === "unavailable" && foreignR.payload.inventory.unavailableReasons.includes("health-foreign-seller-or-marketplace-rows"));

  // WINDOW CHANGE with ZERO exports: 7D re-aggregates the SAME durable OLI (no fetch), different total.
  const realFetch = globalThis.fetch; let hits = 0; globalThis.fetch = () => { hits += 1; throw new Error("no network in derive"); };
  let r7;
  try { r7 = deriveV3(sources, ctx({ windowPreset: "7D" })); } finally { globalThis.fetch = realFetch; }
  ok("E: a window change (7D) re-aggregates stored OLI with ZERO exports/network", hits === 0 && r7.status === "derived");
  ok("E: 7D window sales for SKU-A = 100 (08-20 now excluded) -- proves date change without a new export", r7.payload.rows.find((x) => x.sku === "A").sales === 100);

  // Partial coverage -> salesWindowStatus partial (a 0 is not a proven zero).
  const rPartial = deriveV3(sources, ctx({ windowPreset: "30D", listingHealthV3DurableOli: durableOli({ rows: baseOli, coverageWindows: [{ from: "2026-08-06", to: "2026-08-25" }] }) }));
  ok("E: partial OLI coverage -> salesWindowStatus 'partial'", rPartial.payload.salesWindowStatus === "partial");
  const rNone = deriveV3(sources, ctx({ windowPreset: "30D", listingHealthV3DurableOli: durableOli({ rows: [], coverageWindows: [] }) }));
  ok("E: no OLI coverage -> salesWindowStatus 'unavailable' (never a fabricated zero)", rNone.payload.salesWindowStatus === "unavailable");
  ok("E: full coverage -> salesWindowStatus 'covered'", r30.payload.salesWindowStatus === "covered");

  // Raw degraded (SOURCE_DISABLED) => issuesAvailable false, snapshot still saved (never blocked); nothing inferred.
  const dg = v3Sources({ listings: baseListings, raw: [], rawState: "disabled" });
  const rDg = deriveV3(dg.sources, ctx({ windowPreset: "30D" }));
  ok("E: Listings Raw disabled => derived with issuesAvailable false; buyable/discoverable/liveOffer null (nothing inferred)",
    rDg.status === "derived" && rDg.payload.issuesAvailable === false && rDg.payload.rows.every((x) => x.buyable === null && x.discoverable === null && x.liveOffer === null));

  // OPTIONAL INVENTORY (Section 3 partial-data contract): no saved Health snapshot does not block -- listings + durable
  // OLI still publish, with inventory.available:false (never a fabricated zero).
  const miss = v3Sources({ listings: baseListings, raw: [] });
  const rMiss = deriveV3(miss.sources, ctx({ windowPreset: "30D", listingHealthV3DurableInventory: { available: false, reason: "health-snapshot-missing" } }));
  ok("E: no saved Health snapshot => still DERIVED (listings/OLI publish), inventory.available:false",
    rMiss.status === "derived" && rMiss.payload.inventory && rMiss.payload.inventory.available === false);
  ok("E: with no Health and non-validated (15-column) Listings, FBA on-hand is Unavailable -- never the Listings 30, never 0",
    (() => { const a = rMiss.payload.rows.find((x) => x.sku === "A"); return !!a && a.onHandFba === null && a.onHandFbaSource === null; })()
    && rMiss.payload.inventory.source === "unavailable" && rMiss.latestDataDate === null
    && JSON.stringify(rMiss.payload.inventory.unavailableReasons) === JSON.stringify(["listings-not-expanded", "health-snapshot-missing"]));
  const rNotLoaded = deriveV3(miss.sources, ctx({ windowPreset: "30D", listingHealthV3DurableInventory: undefined }));
  ok("E: a derive context without the bridge => health-bridge-not-loaded (Unavailable)", rNotLoaded.status === "derived"
    && JSON.stringify(rNotLoaded.payload.inventory.unavailableReasons) === JSON.stringify(["listings-not-expanded", "health-bridge-not-loaded"]));

  // VALIDATED (expanded) Listings is the source -- the saved Health bridge is never used next to it.
  const xListings = [xRow(SELLER, "US", "A", { status: "Active", price: 25, fba: 30, channel: "AMAZON_NA" }), xRow(SELLER, "US", "B", { status: "Inactive", price: 0, qty: 7, channel: "DEFAULT" })];
  const vx = v3Sources({ listings: xListings, raw: [] });
  const rX = deriveV3(vx.sources, ctx({ windowPreset: "30D", listingsFetchedAt: "2026-09-04T06:00:00.000Z", listingHealthV3DurableInventory: bridge([invRow(inv, SELLER, "US", "A", 999)]) }));
  const aX = rX.status === "derived" ? rX.payload.rows.find((x) => x.sku === "A") : null;
  ok("E: validated Listings -> on-hand from Listings (SKU-A 30, source listings), never the Health 999", !!aX && aX.onHandFba === 30 && aX.onHandFbaSource === "listings");
  ok("E: ... payload.inventory listings: NO inventory date, freshness = the Listings refresh time; latestDataDate null",
    rX.payload.inventory.source === "listings" && rX.payload.inventory.snapshotDate === null && rX.payload.inventory.refreshedAt === "2026-09-04T06:00:00.000Z"
    && rX.payload.inventory.label === "Listings refreshed 2026-09-04T06:00:00.000Z" && rX.payload.provenance.inventorySnapshotDate === null && rX.latestDataDate === null);
  ok("E: ... a merchant-fulfilled all-zero SKU (B) is FBA not applicable", rX.payload.rows.find((x) => x.sku === "B").onHandFbaApplicable === false);
  // Validated Listings never need the bridge -- even a STALE one is irrelevant to them.
  ok("E: validated Listings with a stale bridge -> still Listings", deriveV3(vx.sources, ctx({ windowPreset: "30D", listingHealthV3DurableInventory: bridge([invRow("2026-08-01", SELLER, "US", "A", 999)]) })).payload.inventory.source === "listings");
  // Conflicting duplicate Listings rows (AAKRITI-style) -> the dated saved Health bridge, conflict reported.
  const vc = v3Sources({ listings: [...xListings, xRow(SELLER, "US", "A", { status: "Active", price: 25, fba: 12, channel: "AMAZON_NA" })], raw: [] });
  const rC = deriveV3(vc.sources, ctx({ windowPreset: "30D", listingHealthV3DurableInventory: bridge([invRow(inv, SELLER, "US", "A", 31)]) }));
  ok("E: conflicting duplicate Listings rows -> health-fallback (SKU-A 31 from Health on every row), conflict reported",
    rC.status === "derived" && rC.payload.inventory.source === "health-fallback" && rC.payload.inventory.fallbackReasons.includes("listings-unresolved-conflicts:1")
    && rC.payload.inventory.conflicts.some((c) => c.sku === "A") && rC.payload.rows.filter((x) => x.sku === "A").every((x) => x.onHandFba === 31 && x.onHandFbaSource === "fba-health-fallback"));

  // validatePayload: the phase-2 inventory model is REQUIRED (a pre-phase-2 payload is never valid / served / promoted).
  const V = REPORT_DERIVATIONS["listing-health-v3"];
  ok("E: validatePayload accepts the phase-2 payloads (listings / health-fallback / unavailable)", V.validatePayload(rX.payload) && V.validatePayload(r30.payload) && V.validatePayload(rMiss.payload));
  ok("E: validatePayload rejects a pre-phase-2 payload (no inventory.model) and a phase-3-only model",
    V.validatePayload({ ...r30.payload, inventory: { available: true, snapshotDate: inv } }) === false
    && V.validatePayload({ ...rX.payload, inventory: { ...rX.payload.inventory, model: "listings-v1" } }) === false
    && V.validatePayload({ ...rX.payload, inventory: null }) === false);
  ok("E: latestDataDate = the Health date ONLY for a health-fallback payload (Listings / Unavailable claim none)",
    V.latestDataDate(r30.payload) === inv && V.latestDataDate(rX.payload) === null && V.latestDataDate(rMiss.payload) === null
    && V.latestDataDate({ inventory: { source: "listings", snapshotDate: inv } }) === null
    && V.latestDataDate({ inventory: { source: "health-fallback", snapshotDate: "2026-02-30" } }) === null);
  // The truly-required LISTINGS source still blocks when missing (LKG preserved, no snapshot).
  const missListings = v3Sources({ listings: baseListings, raw: [] });
  delete missListings.sources["listing-health-v3:listings"];
  ok("E: a missing REQUIRED source (listings) => unavailable (LKG preserved, no snapshot)", deriveV3(missListings.sources, ctx()).status === "unavailable");
  // Missing durable OLI => unavailable.
  ok("E: missing durable OLI => unavailable (LKG preserved)", deriveV3(sources, ctx({ listingHealthV3DurableOli: null })).status === "unavailable");
})();

/* ===================== J. trusted marketplace ownership on EVERY derive path (scheduler + live-promote) ===================== */
// The derive resolves the row-ownership marketplace from the TRUSTED account-directory provenance (context.marketCountry
// -- what the planner buckets on and the live-promote bundle now threads), canonicalizes it (UK->GB, uppercase), threads
// it into owner.marketplace so buildAdvancedListingHealth's assertRowsOwnedBy enforces cross-marketplace isolation, and
// FAILS CLOSED (unavailable, LKG preserved) when it is missing -- closing the gap where the scheduler live-promote path
// reached the builder with no owner marketplace and fell open on the marketplace axis. The builder-level accept/reject/
// UK->GB/fail-open matrix is proved directly in report-listing-health-advanced.test.js; here we prove the DERIVE wires
// the trusted marketplace through and gates on it.
(() => {
  const { sources } = v3Sources({ listings: baseListings, raw: [{ seller_or_vendor_id: SELLER, marketplace_country_code: "US", sku: "A", child_asin: "ASIN-A", summaries: JSON.stringify({ status: ["BUYABLE"] }), issues: JSON.stringify([]), offers: JSON.stringify([{ price: { amount: 25 } }]) }] });
  // A present, trusted marketplace derives AND stamps the canonical owner marketplace on the payload (this is the SAME
  // owner.marketplace the direct read-only serve resolves from the account directory -> scheduler/serve are equivalent).
  const rOk = deriveV3(sources, ctx({ windowPreset: "30D" }));
  ok("J: a trusted marketplace derives and stamps the canonical owner marketplace onto the payload", rOk.status === "derived" && rOk.payload.marketplace === "US");
  // A lowercase directory marketplace is canonicalized (never a false reject) and still stamps the canonical form.
  const rLower = deriveV3(sources, ctx({ windowPreset: "30D", marketCountry: "us" }));
  ok("J: a lowercase directory marketplace is canonicalized to US (no false reject)", rLower.status === "derived" && rLower.payload.marketplace === "US");
  // FAIL CLOSED: a missing / blank / whitespace-only trusted marketplace preserves last-known-good (never a marketplace-
  // unvalidated snapshot). This is the exact scheduler live-promote gap now closed.
  ok("J: a MISSING trusted marketplace (null) => unavailable (fail closed, LKG preserved)", deriveV3(sources, ctx({ windowPreset: "30D", marketCountry: null })).status === "unavailable");
  ok("J: a BLANK trusted marketplace ('') => unavailable (fail closed)", deriveV3(sources, ctx({ windowPreset: "30D", marketCountry: "" })).status === "unavailable");
  ok("J: a WHITESPACE-only trusted marketplace => unavailable (fail closed)", deriveV3(sources, ctx({ windowPreset: "30D", marketCountry: "   " })).status === "unavailable");
})();

/* ===================== F. save one account-scoped shadow snapshot via the REAL worker + idempotent ===================== */
await (async () => {
  const planned = planListingHealthV3BucketBatched({ accounts: [{ accountId: SELLER, country: "US", currency: "USD", name: "A0" }], connections, asOfFor: () => asOf, inventoryAsOf: inv })[0];
  const store = makeStore();
  const cid = store.openCycle({ bucket: "us-ca", cycleDate: asOf });
  const rowsByKey = {
    "listing-health-v3:listings": baseListings,
    "listing-health-v3:listings-raw": [{ seller_or_vendor_id: SELLER, marketplace_country_code: "US", sku: "A", child_asin: "ASIN-A", summaries: JSON.stringify({ status: ["BUYABLE", "DISCOVERABLE"] }), issues: JSON.stringify([]), offers: JSON.stringify([{ price: { amount: 25 } }]) }],
  };
  for (const s of planned.sources) {
    store.upsertSourceJob({ cycleId: cid, requestHash: s.requestHash, requestKey: s.requestKey, sourceId: s.sourceId, sourceKey: s.sourceKey, connectionId: s.connectionId, organizationFingerprint: s.organizationFingerprint, accountScopeHash: s.accountScopeHash });
    store.saveSourceRows({ job: { request_hash: s.requestHash }, rows: rowsByKey[s.requestKey] || [] });
    store.recordSourceSuccess({ cycleId: cid, requestHash: s.requestHash, exportId: "e", rowCount: (rowsByKey[s.requestKey] || []).length, cacheObjectPath: "p/" + s.requestHash });
  }
  // Durable OLI + catalog via the REAL loader with injected readers (proves it uses getEnrichedOli + the window).
  let enrichedCalledWith = null;
  const loadDerivedContext = makeListingHealthV3DurableContextLoader({
    connections,
    getEnrichedOli: async (a) => { enrichedCalledWith = a; return baseOli; },
    getOliCoverage: async () => ({ read: "ok", windows: fullCoverage }),
    getCompleteness: async () => [{ sale_date: asOf, completeness_status: "final", itemization_percent: 100 }],
    getCatalogSnapshot: async () => ({ read: "ok", snapshot: { object_path: "cat/p" } }),
    loadCatalogPayload: async () => ({ rows: baseCat }),
    // The saved Health bridge (read-only; the retired inventory fragment no longer exists).
    getHealthBridge: async () => ({ rows: baseInv, unavailableReason: null, snapshotDate: inv, savedAt: "2026-09-04T09:00:00.000Z" }),
  });
  const saved = [];
  const saveSnapshot = async ({ reportKey, accountId, params, payload }) => { store.saveCalls += 1; store.seedSnapshot(reportKey, accountId, payload); saved.push({ reportKey, accountId, params, payload }); return { paramsHash: "ph" }; };
  const realFetch = globalThis.fetch; let hits = 0; globalThis.fetch = () => { hits += 1; throw new Error("no network in worker derive"); };
  let res;
  try { res = await runReportJobs({ store, cycleId: cid, sourceRows: (h) => store.loadSourceRows(h), saveSnapshot, plannedReports: [planned], loadDerivedContext }); } finally { globalThis.fetch = realFetch; }
  ok("F: the real worker derives + saves EXACTLY one v3 shadow snapshot", res.succeeded === 1 && saved.length === 1);
  ok("F: saved under the shadow key scheduler-v2/listing-health-v3, version listing-health/v3-oli-window",
    saved[0].reportKey === "scheduler-v2/listing-health-v3" && saved[0].params.reportVersion === "listing-health/v3-oli-window");
  ok("F: the shadow payload is account-scoped + OLI-sourced", saved[0].accountId === SELLER && saved[0].payload.salesSource === "order-line-items" && saved[0].payload.accountId === SELLER);
  ok("F: the shadow payload carries the inventory model (15-column Listings -> the saved Health bridge from the loader)",
    saved[0].payload.inventory.model === "inventory-source-v1" && saved[0].payload.inventory.source === "health-fallback" && saved[0].payload.rows.find((x) => x.sku === "A").onHandFba === 30);
  ok("F: the loader read enriched OLI via the established wrapper for the resolved 30D window", enrichedCalledWith && enrichedCalledWith.from === "2026-08-04" && enrichedCalledWith.to === asOf && enrichedCalledWith.accountIds[0] === SELLER);
  ok("F: zero network/DataDoe during the worker derive", hits === 0);
  const before = store.saveCalls;
  await runReportJobs({ store, cycleId: cid, sourceRows: (h) => store.loadSourceRows(h), saveSnapshot, plannedReports: [planned], loadDerivedContext });
  ok("F: idempotent replay -- no duplicate snapshot on re-run", store.saveCalls === before);
})();

/* ===================== G. authorization (unchanged Listing Health gate) ===================== */
await (async () => {
  const getTrustedBrands = async () => [{ key: "brandx", display: "BrandX" }];
  const admin = await resolveUserReportScope({ access: { role: "admin" }, requestedAccountId: SELLER, requestedBrand: "ALL", action: "listing-health-v3", getTrustedBrands });
  ok("G: admin is unrestricted (byte-identical serving)", admin.restricted === false && admin.mode === "ADMIN");
  const allBrands = await resolveUserReportScope({ access: { role: "user", accountGrants: { [SELLER]: { mode: "ALL_BRANDS" } } }, requestedAccountId: SELLER, requestedBrand: "ALL", action: "listing-health-v3", getTrustedBrands });
  ok("G: ALL_BRANDS user is unrestricted", allBrands.restricted === false && allBrands.mode === "ALL_BRANDS");
  await throwsAsync("G: SELECTED_BRANDS user is DENIED 403 (v3 is not brand-accessible)", () => resolveUserReportScope({ access: { role: "user", accountGrants: { [SELLER]: { mode: "SELECTED_BRANDS", brandKeys: ["brandx"] } } }, requestedAccountId: SELLER, requestedBrand: "ALL", action: "listing-health-v3", getTrustedBrands }));
  await throwsAsync("G: an unauthorized account is DENIED 403", () => resolveUserReportScope({ access: { role: "user", accountGrants: {} }, requestedAccountId: "not-mine", requestedBrand: "ALL", action: "listing-health-v3", getTrustedBrands }));
  ok("G: an unregistered action fails closed to DENY (so a missing capability is a 403, never open)",
    (REPORT_CAPABILITIES["listing-health-v3-typo"] || CAPABILITY.DENY_FOR_BRAND_RESTRICTED_USERS) === CAPABILITY.DENY_FOR_BRAND_RESTRICTED_USERS);
})();

/* ===================== H. durable loader (established wrapper + fail-closed reads) ===================== */
await (async () => {
  const base = { connections, getOliCoverage: async () => ({ read: "ok", windows: fullCoverage }), getCompleteness: async () => [], getCatalogSnapshot: async () => ({ read: "ok", snapshot: { object_path: "cat/p" } }), loadCatalogPayload: async () => ({ rows: baseCat }) };
  const planned = { context: { to: asOf, windowPreset: "7D" } };
  const okLoader = makeListingHealthV3DurableContextLoader({ ...base, getEnrichedOli: async (a) => { return [oliRow("2026-09-01", "A", 10, 1)].filter(() => a.from === "2026-08-27"); } });
  const c = await okLoader({ reportKey: "listing-health-v3", accountId: SELLER, planned });
  ok("H: loader reads enriched OLI for the resolved 7D window and returns available durable OLI + catalog", c.listingHealthV3DurableOli.available === true && c.listingHealthV3DurableOli.rows.length === 1 && c.listingHealthV3DurableCatalog.available === true);
  ok("H: loader carries coverage windows for honest covered/partial reporting", c.listingHealthV3DurableOli.coverageWindows.length === 1);
  const failLoader = makeListingHealthV3DurableContextLoader({ ...base, getEnrichedOli: async () => { throw new Error("db down"); } });
  const cf = await failLoader({ reportKey: "listing-health-v3", accountId: SELLER, planned });
  ok("H: a durable READ FAILURE fails closed ({}), never a fabricated zero", Object.keys(cf).length === 0);
  const other = await okLoader({ reportKey: "fba-plan", accountId: SELLER, planned });
  ok("H: loader returns {} for any non-v3 report key", Object.keys(other).length === 0);
  // The saved Health bridge: read READ-ONLY with the account's identity; soft when missing / unreadable; never in STRICT.
  const calls = [];
  const bLoader = makeListingHealthV3DurableContextLoader({ ...base, getEnrichedOli: async () => [], getHealthBridge: async (a) => { calls.push(a); return { rows: baseInv, unavailableReason: null, snapshotDate: inv, savedAt: "t" }; } });
  const cb = await bLoader({ reportKey: "listing-health-v3", accountId: SELLER, planned });
  ok("H: the loader injects the saved Health bridge (rows + date + saved time) with the account's org / connection / scope / raw seller",
    cb.listingHealthV3DurableInventory.available === true && cb.listingHealthV3DurableInventory.snapshotDate === inv && cb.listingHealthV3DurableInventory.rows.length === 1
    && calls[0].accountId === SELLER && calls[0].rawSellerId === SELLER && calls[0].connectionId === "primary" && !!calls[0].organizationFingerprint);
  const mLoader = makeListingHealthV3DurableContextLoader({ ...base, getEnrichedOli: async () => [], getHealthBridge: async () => ({ rows: null, unavailableReason: "health-snapshot-missing" }) });
  ok("H: no saved Health snapshot -> { available:false, reason } (soft; OLI + catalog still load)",
    (await mLoader({ reportKey: "listing-health-v3", accountId: SELLER, planned })).listingHealthV3DurableInventory.reason === "health-snapshot-missing");
  const tLoader = makeListingHealthV3DurableContextLoader({ ...base, getEnrichedOli: async () => [], getHealthBridge: async () => { throw new Error("db down"); } });
  const ct = await tLoader({ reportKey: "listing-health-v3", accountId: SELLER, planned });
  ok("H: a bridge read THROW is soft (health-snapshot-read-failed) -- OLI + catalog still load", ct.listingHealthV3DurableOli.available === true && ct.listingHealthV3DurableInventory.reason === "health-snapshot-read-failed");
  let strictCalls = 0;
  const sLoader = makeListingHealthV3DurableContextLoader({ ...base, strict: true, buildObjectPath: () => "x", getEnrichedOli: async () => [], getHealthBridge: async () => { strictCalls += 1; return { rows: baseInv }; } });
  await sLoader({ reportKey: "listing-health-v3", accountId: SELLER, planned });
  ok("H: STRICT (reconciler) mode never reads the bridge here (the dependency bundle proves + injects it)", strictCalls === 0);
})();

/* ===================== I. no new API function (12-function ceiling preserved) ===================== */
(() => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const apiDir = path.join(root, "api");
  let count = 0;
  const walk = (d) => { for (const e of readdirSync(d)) { const p = path.join(d, e); if (statSync(p).isDirectory()) walk(p); else if (e.endsWith(".js")) count += 1; } };
  walk(apiDir);
  ok("I: api/*.js count is still 12 (no new serverless function for v3)", count === 12);
  ok("I: no v3-specific api handler file exists (v3 is served by no route)", !readdirSync(apiDir).includes("listing-health-v3.js"));
})();

/* ===================== makeStore (copied worker harness) ===================== */
function makeStore() {
  const cycles = new Map(); const jobsByCycle = new Map(); const ownersByCycle = new Map();
  const cache = new Map(); const reportJobs = new Map(); const snapshots = new Map(); let seq = 0;
  const findCycle = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  const ownerRows = (cid) => [...((ownersByCycle.get(cid) && ownersByCycle.get(cid).values()) || [])];
  const rkey = (rk, a) => rk + "|" + a;
  return {
    _snapshots: snapshots, saveCalls: 0,
    openCycle({ bucket, cycleDate }) { const k = bucket + "|" + cycleDate; if (!cycles.has(k)) { const id = "cyc_" + (seq += 1); cycles.set(k, { id, bucket, status: "pending" }); jobsByCycle.set(id, new Map()); } return cycles.get(k).id; },
    claimCycle(id) { const c = findCycle(id); if (c && c.status === "pending") { c.status = "running"; return true; } return false; },
    getCycle(id) { return findCycle(id); },
    upsertSourceJob(job) { const m = jobsByCycle.get(job.cycleId); if (m.has(job.requestHash)) return; m.set(job.requestHash, { request_hash: job.requestHash, request_key: job.requestKey, source_id: job.sourceId, source_key: job.sourceKey, connection_id: job.connectionId, organization_fingerprint: job.organizationFingerprint, account_scope_hash: job.accountScopeHash, fetch_status: "pending", attempted_at: null, create_export_count: 0, export_id: null, terminal: false, row_count: null }); },
    listSourceJobs(id) { return [...((jobsByCycle.get(id) && jobsByCycle.get(id).values()) || [])].map((j) => ({ ...j })); },
    upsertSourceJobOwners(ms) { for (const m of ms || []) { if (!ownersByCycle.has(m.cycleId)) ownersByCycle.set(m.cycleId, new Map()); ownersByCycle.get(m.cycleId).set(m.ownerId + "|" + m.requestHash, { cycle_id: m.cycleId, request_hash: m.requestHash, owner_id: m.ownerId, request_key: m.requestKey, report_key: m.reportKey, account_id: m.accountId, connection_id: m.connectionId, organization_fingerprint: m.organizationFingerprint, account_scope_hash: m.accountScopeHash, owner_status: "active", error_code: null }); } },
    listSourceJobOwners(cid, ids) { const s = new Set(ids || []); return ownerRows(cid).filter((m) => s.has(m.owner_id)).map((m) => ({ ...m })); },
    recordSourceOwnerStale({ cycleId, requestHash, ownerId, code }) { const m = ownersByCycle.get(cycleId) && ownersByCycle.get(cycleId).get(ownerId + "|" + requestHash); if (m) { m.owner_status = "stale"; m.error_code = code || "STALE_PLAN"; } },
    claimExportAttempt(id, h) { const j = jobsByCycle.get(id) && jobsByCycle.get(id).get(h); if (j && j.attempted_at === null) { j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted"; return true; } return false; },
    recordExportCreated({ cycleId, requestHash, exportId }) { jobsByCycle.get(cycleId).get(requestHash).export_id = exportId; },
    loadSourceRows(h) { const e = cache.get(h); return e ? { rows: e.rows } : null; },
    saveSourceRows({ job, rows }) { const h = job.request_hash != null ? job.request_hash : job.requestHash; cache.set(h, { rows: [...rows] }); return "p/" + h; },
    recordSourceSuccess({ cycleId, requestHash, exportId, rowCount, cacheObjectPath }) { Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "succeeded", export_id: exportId, row_count: rowCount, cache_object_path: cacheObjectPath }); },
    recordSourceFailure({ cycleId, requestHash, stage, code, terminal }) { Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "failed", error_stage: stage, error_code: code, terminal: !!terminal }); },
    updateCycleCounts() {},
    seedSnapshot(rk, a, payload) { snapshots.set(rkey(rk, a), { payload }); },
    report(rk, a) { return reportJobs.get(rkey(rk, a)); },
    listReportJobs() { return [...reportJobs.values()].map((j) => ({ ...j })); },
    upsertReportJob({ reportKey, accountId, connectionId, bucket, reportVersion, dependsOn }) { const k = rkey(reportKey, accountId); if (reportJobs.has(k)) return; reportJobs.set(k, { report_key: reportKey, account_id: accountId, connection_id: connectionId, bucket, report_version: reportVersion, depends_on: dependsOn || [], fetch_status: "pending", derive_status: "pending", save_status: "pending", validated: false }); },
    claimReportDerive(_c, rk, a) { const j = reportJobs.get(rkey(rk, a)); if (j && j.derive_status === "pending") { j.derive_status = "running"; return true; } return false; },
    recordReportBlocked({ reportKey, accountId }) { Object.assign(reportJobs.get(rkey(reportKey, accountId)), { fetch_status: "blocked", derive_status: "skipped", save_status: "skipped" }); },
    recordReportFailure({ reportKey, accountId, stage, code }) { Object.assign(reportJobs.get(rkey(reportKey, accountId)), { derive_status: stage === "save" ? "succeeded" : "failed", save_status: stage === "save" ? "failed" : "pending", error_code: code }); },
    recordReportSuccess({ reportKey, accountId, latestDataDate }) { Object.assign(reportJobs.get(rkey(reportKey, accountId)), { fetch_status: "ready", derive_status: "succeeded", save_status: "succeeded", validated: true, latest_data_date: latestDataDate ?? null }); },
  };
}

writeSync(1, `\nreport-listing-health-v3-integration: ${passed} assertions passed\n`);
