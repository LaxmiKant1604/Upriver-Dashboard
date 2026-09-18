// Phase 3 -- Advanced Listing Health v3 READ-ONLY PREVIEW SERVE (serveListingHealthV3Preview).
// Proves the additive serve path assembles the v3 payload from ALREADY-SAVED evidence ONLY: durable enriched OLI +
// coverage/completeness + durable catalog + cache-only saved listings/inventory/raw. It NEVER creates a DataDoe
// export, NEVER writes, re-aggregates stored OLI for any window with ZERO network, keeps status/issues/inventory on
// the LATEST snapshot independent of the sales window, rejects cross-account rows (fail closed), preserves null vs
// zero + FBA/FBM applicability, reports honest covered/partial/unavailable, and maps an invalid window to a throw
// (caller -> 400). Offline, zero DataDoe/network. 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { serveListingHealthV3Preview } from "../lib/server/reports/listing-health-v3-serve.js";
import { listingHealthV3PerAccountReadHashes } from "../lib/server/sync/listing-health-v3-materialize.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
const throwsAsync = async (n, fn) => { let t = false; try { await fn(); } catch { t = true; } ok(n, t); };
writeSync(1, "report-listing-health-v3-serve\n");

const API_KEY = "fixture-key";
const SELLER = "acct-00";
const OTHER = "acct-99";
const asOf = "2026-09-02";

// The v3 PER-ACCOUNT read identities, computed by the SAME shared helper the serve uses -- so injecting
// getSavedSourceRows keyed by these hashes proves the serve reads the correct per-account identity. The identities
// are DATE-FREE (stable), so `to`/preset never change them (proving inventory is window-independent).
function hashesFor({ apiKey = API_KEY, rawSellerId = SELLER, marketplace = "US" } = {}) {
  return listingHealthV3PerAccountReadHashes({ apiKey, rawSellerId, marketplaceCountry: marketplace || null });
}

/* ---- fixtures (row shapes byte-match the v3 integration test) ---- */
const listingRow = (seller, mkt, sku, o = {}) => ({ seller_or_vendor_id: seller, marketplace_country_code: mkt, sku, child_asin: `ASIN-${sku}`, listing_name: o.name ?? `L ${sku}`, listing_status: o.status ?? "Active", listing_price_value: o.price === undefined ? 9 : o.price, listing_price_currency: o.currency ?? "USD", listing_current_quantity: o.qty ?? 0, fba_quantity_available: o.fba ?? 0, listing_fulfillment_channel: o.channel ?? "AMAZON_NA", listing_open_date: o.open ?? "2024-01-01" });
const invRow = (date, seller, mkt, sku, available) => ({ date, seller_or_vendor_id: seller, marketplace_country_code: mkt, child_asin: `ASIN-${sku}`, sku, available });
const oliRow = (date, sku, sales, units, seller = SELLER) => ({ account_id: seller, seller_or_vendor_id: seller, sale_date: date, sku, child_asin: `ASIN-${sku}`, currency: "USD", sales_amount: sales, ordered_units: units, unpriced_units: 0 });
const catRow = (sku, brand) => ({ child_asin: `ASIN-${sku}`, product_name: `P ${sku}`, product_brand: brand });
const rawRow = (seller, mkt, sku, buyable = true, disc = true, live = true) => ({ seller_or_vendor_id: seller, marketplace_country_code: mkt, sku, child_asin: `ASIN-${sku}`, summaries: JSON.stringify({ status: [buyable ? "BUYABLE" : "", disc ? "DISCOVERABLE" : ""].filter(Boolean) }), issues: JSON.stringify([]), offers: JSON.stringify(live ? [{ price: { amount: 25 } }] : []) });

const LISTINGS = [
  listingRow(SELLER, "US", "A", { status: "Active", price: 25, fba: 30, channel: "AMAZON_NA" }), // FBA, healthy
  listingRow(SELLER, "US", "B", { status: "Inactive", price: 0, qty: 7, channel: "DEFAULT" }),   // FBM, flagged
];
const INVENTORY = [invRow("2026-09-01", SELLER, "US", "A", 30), invRow("2026-08-30", SELLER, "US", "A", 999)]; // newest 09-01 -> 30
const CATALOG = [catRow("A", "BrandX"), catRow("B", "BrandY")];
const RAW = [rawRow(SELLER, "US", "A")];
const OLI = [oliRow("2026-09-01", "A", 100, 10), oliRow("2026-08-20", "A", 50, 5), oliRow("2026-09-02", "B", 200, 20), oliRow("2026-06-01", "A", 999, 99)];
const FULL_COVERAGE = [{ from: "2024-01-01", to: asOf }];

// Build a read-only reader set backed by saved-hash maps. Records which saved hashes were requested + the OLI window.
function makeReaders({ oli = OLI, coverage = FULL_COVERAGE, catalog = CATALOG, listings = LISTINGS, inventory = INVENTORY, raw = RAW, to = asOf } = {}) {
  const H = hashesFor({ to });
  const savedByHash = new Map();
  if (listings) savedByHash.set(H["listing-health-v3:listings"], listings);
  if (inventory) savedByHash.set(H["listing-health-v3:inventory"], inventory);
  if (raw) savedByHash.set(H["listing-health-v3:listings-raw"], raw);
  const requestedHashes = [];
  const oliCalls = [];
  return {
    H,
    requestedHashes,
    oliCalls,
    readers: {
      getEnrichedOli: async (a) => { oliCalls.push({ from: a.from, to: a.to, accountIds: a.accountIds }); return oli.slice(); },
      getOliCoverage: async () => ({ read: "ok", windows: coverage }),
      getCompleteness: async () => [],
      getCatalog: async () => catalog.slice(),
      getSavedSourceRows: async (h) => { requestedHashes.push(h); return savedByHash.has(h) ? savedByHash.get(h).slice() : null; },
    },
  };
}

const serve = (over = {}, owner = { accountId: SELLER, rawSellerId: SELLER, marketplace: "US" }, windowControls = { preset: "30D" }) => {
  const m = makeReaders(over);
  return { m, run: serveListingHealthV3Preview({ owner, identity: { apiKey: API_KEY, connectionId: "primary" }, windowControls, asOf, readers: m.readers }) };
};

/* ===================== A. read-only assembly + provenance ===================== */
await (async () => {
  const realFetch = globalThis.fetch; let hits = 0; globalThis.fetch = () => { hits += 1; throw new Error("no network in serve"); };
  let payload;
  try { payload = await serve().run; } finally { globalThis.fetch = realFetch; }
  ok("A: zero network/DataDoe during the read-only serve", hits === 0);
  ok("A: preview payload flagged preview:true and sourced from durable order-line-items", payload.preview === true && payload.salesSource === "order-line-items");
  ok("A: evidence reports listings + inventory + issues all available", payload.evidence.listingsEvidenceAvailable === true && payload.evidence.inventoryEvidenceAvailable === true && payload.evidence.issuesEvidenceAvailable === true);
  const a = payload.rows.find((r) => r.sku === "A");
  const b = payload.rows.find((r) => r.sku === "B");
  ok("A: 30D OLI window sales/units for SKU-A = 150/15 (08-20 + 09-01, June excluded)", a.sales === 150 && a.units === 15);
  ok("A: SKU-A is FBA -> latest inventory 30 (09-01), FBM not applicable", a.onHandFba === 30 && a.onHandFbaApplicable === true && a.onHandFbmApplicable === false);
  ok("A: SKU-B is FBM -> on-hand 7 from listing qty, FBA not applicable", b.onHandFbm === 7 && b.onHandFbmApplicable === true && b.onHandFbaApplicable === false);
  ok("A: SKU-A healthy (Active/priced/buyable) -> not flagged", a.flagged === false);
  ok("A: SKU-B flagged (Inactive + stranded); salesAtRisk = window sales 200 for a listing flagged NOW", b.flagged === true && b.salesAtRisk === 200);
  ok("A: full coverage -> salesWindowStatus 'covered'", payload.salesWindowStatus === "covered");
})();

/* ===================== B. window change re-aggregates stored OLI with ZERO exports ===================== */
await (async () => {
  const realFetch = globalThis.fetch; let hits = 0; globalThis.fetch = () => { hits += 1; throw new Error("no network"); };
  let s7, s30;
  try {
    s7 = serve({}, undefined, { preset: "7D" });
    const p7 = await s7.run;
    s30 = serve({}, undefined, { preset: "30D" });
    const p30 = await s30.run;
    ok("B: 7D window sales for SKU-A = 100 (08-20 excluded) -- date change, no new export", p7.rows.find((r) => r.sku === "A").sales === 100);
    ok("B: 30D window sales for SKU-A = 150 -- same durable OLI, re-aggregated", p30.rows.find((r) => r.sku === "A").sales === 150);
    ok("B: the OLI reader window differs by preset (7D from != 30D from)", s7.m.oliCalls[0].from !== s30.m.oliCalls[0].from && s7.m.oliCalls[0].from === "2026-08-27" && s30.m.oliCalls[0].from === "2026-08-04");
    // LATEST inventory is independent of the sales window: the inventory saved-hash requested is IDENTICAL across windows.
    ok("B: latest inventory identity is independent of the sales window (same inventory hash for 7D and 30D)",
      s7.m.H["listing-health-v3:inventory"] === s30.m.H["listing-health-v3:inventory"] &&
      s7.m.requestedHashes.includes(s7.m.H["listing-health-v3:inventory"]) && s30.m.requestedHashes.includes(s30.m.H["listing-health-v3:inventory"]));
  } finally { globalThis.fetch = realFetch; }
  ok("B: zero network across both window reads", hits === 0);
})();

/* ===================== C. honest covered / partial / unavailable ===================== */
await (async () => {
  const partial = await serve({ coverage: [{ from: "2026-08-06", to: "2026-08-25" }] }).run;
  ok("C: partial OLI coverage -> salesWindowStatus 'partial' (a 0 is not a proven zero)", partial.salesWindowStatus === "partial");
  const none = await serve({ oli: [], coverage: [] }).run;
  ok("C: no OLI coverage -> salesWindowStatus 'unavailable' (never a fabricated zero)", none.salesWindowStatus === "unavailable");
})();

/* ===================== D. degraded saved-evidence (cache miss -> honest Unavailable, never an export) ===================== */
await (async () => {
  const noRaw = await serve({ raw: null }).run; // raw cache MISS
  ok("D: raw cache miss -> issuesEvidenceAvailable false; buyable/discoverable/liveOffer null (nothing inferred)",
    noRaw.evidence.issuesEvidenceAvailable === false && noRaw.issuesAvailable === false && noRaw.rows.every((r) => r.buyable === null && r.discoverable === null && r.liveOffer === null));
  const noListings = await serve({ listings: null }).run; // listings cache MISS
  ok("D: listings cache miss -> listingsEvidenceAvailable false + empty rows + honest reason (no export attempted)",
    noListings.evidence.listingsEvidenceAvailable === false && noListings.rows.length === 0 && typeof noListings.evidence.listingsUnavailableReason === "string");
  // inventory cache MISS AND no listings FBA fallback -> on-hand UNAVAILABLE (null), never coerced to 0.
  const noInv = await serve({ inventory: null, listings: [listingRow(SELLER, "US", "A", { status: "Active", price: 25, fba: "", channel: "AMAZON_NA" }), LISTINGS[1]] }).run;
  const a = noInv.rows.find((r) => r.sku === "A");
  ok("D: inventory cache miss + no listing fallback -> FBA on-hand null (UNAVAILABLE), never coerced to 0", noInv.evidence.inventoryEvidenceAvailable === false && a.onHandFba === null);
})();

/* ===================== E. cross-account isolation (fail closed) ===================== */
await (async () => {
  await throwsAsync("E: a cross-account OLI row (account_id != owner) makes the serve throw (no cross-account leak)",
    () => serve({ oli: [oliRow("2026-09-01", "A", 100, 10, OTHER)] }).run);
  await throwsAsync("E: a cross-account listings row (seller != owner) makes the serve throw",
    () => serve({ listings: [listingRow(OTHER, "US", "A", { status: "Active", price: 25 })] }).run);
})();

/* ===================== F. window validation (caller maps a throw -> 400) ===================== */
await (async () => {
  await throwsAsync("F: an explicitly invalid preset throws", () => serve({}, undefined, { preset: "99D" }).run);
  await throwsAsync("F: a reversed custom window throws", () => serve({}, undefined, { preset: "CUSTOM", from: "2026-09-02", to: "2026-08-01" }).run);
  await throwsAsync("F: a future custom endpoint throws", () => serve({}, undefined, { preset: "CUSTOM", from: "2026-08-01", to: "2026-12-31" }).run);
  const month = await serve({}, undefined, { preset: "MONTH", month: "2026-08" }).run;
  ok("F: a selected calendar month resolves to that month window", month.window.from === "2026-08-01" && month.window.to === "2026-08-31" && month.window.kind === "MONTH");
})();

/* ===================== G. fail-closed owner ===================== */
await (async () => {
  await throwsAsync("G: a missing owner rawSellerId is rejected (server must pin identity)",
    () => serveListingHealthV3Preview({ owner: { accountId: SELLER }, identity: { apiKey: API_KEY }, windowControls: { preset: "30D" }, asOf, readers: makeReaders().readers }));
})();

/* ===================== H. freshness metadata: TRUE effective/as-of + source-type per fragment ===================== */
await (async () => {
  const H = hashesFor({ to: asOf });
  const rich = {
    getEnrichedOli: async () => [], getOliCoverage: async () => ({ read: "ok", windows: FULL_COVERAGE }), getCompleteness: async () => [], getCatalog: async () => [],
    // Production { rows, fetchedAt, effectiveAt, sourceType } shape: effectiveAt = the batch's real download time
    // (truer data as-of), fetchedAt = the materialization time, sourceType = the source id.
    getSavedSourceRows: async (h) => (h === H["listing-health-v3:listings"]
      ? { rows: [listingRow(SELLER, "US", "A", { status: "Active", price: 12 })], fetchedAt: "2026-09-18T09:00:00Z", effectiveAt: "2026-09-17T02:00:00Z", sourceType: "listings-health-v1" }
      : null),
  };
  const p = await serveListingHealthV3Preview({ owner: { accountId: SELLER, rawSellerId: SELLER, marketplace: "US" }, identity: { apiKey: API_KEY, connectionId: "primary" }, windowControls: { preset: "30D" }, asOf, readers: rich });
  ok("H: provenance surfaces the TRUE effective/as-of (batch download time), not the materialization time", p.provenance.listingsFetchedAt === "2026-09-17T02:00:00Z");
  ok("H: provenance records the materialization saved-time separately", p.provenance.listingsSavedAt === "2026-09-18T09:00:00Z");
  ok("H: provenance records the per-fragment source type", p.provenance.listingsSourceType === "listings-health-v1");
  ok("H: absent raw + inventory fragments stay honestly Unavailable (no fabricated date)", p.evidence.issuesEvidenceAvailable === false && p.evidence.inventoryEvidenceAvailable === false && p.provenance.rawFetchedAt === null);
})();

/* ===================== I. marketplace ownership: a cross-marketplace saved row fails closed ===================== */
await (async () => {
  const H = hashesFor({ to: asOf });
  const cross = {
    getEnrichedOli: async () => [], getOliCoverage: async () => ({ read: "ok", windows: FULL_COVERAGE }), getCompleteness: async () => [], getCatalog: async () => [],
    getSavedSourceRows: async (h) => (h === H["listing-health-v3:listings"] ? [listingRow(SELLER, "DE", "A", { status: "Active", price: 12 })] : null),
  };
  await throwsAsync("I: a DE listing row under a US owner fails closed (cross-marketplace; never merged)",
    () => serveListingHealthV3Preview({ owner: { accountId: SELLER, rawSellerId: SELLER, marketplace: "US" }, identity: { apiKey: API_KEY, connectionId: "primary" }, windowControls: { preset: "30D" }, asOf, readers: cross }));
})();

writeSync(1, `\nreport-listing-health-v3-serve: ${passed} assertions passed\n`);
