// Listings inventory CUTOVER -- the insight reports (Sales Movers, Buy Box Loss, Listing Health v1; the Priority Feed is
// built from their insights) pick ONE FBA stock source per account: the validated saved Listings snapshot, else the
// account's LAST SAVED durable FBA Inventory Health snapshot as a dated, read-only, temporary BRIDGE (only while its date
// is within HEALTH_BRIDGE_MAX_AGE_DAYS of the report as-of), else Unavailable. NO FBA Inventory Health export is ever
// requested (not by a manual refresh, not by the scheduled derive). Offline: DataDoe is a fetch double that REFUSES a
// Health request, the saved Listings + saved Health snapshots are injected readers, Supabase is NOT configured.
//   (A) the pure decision (derivation-core insightInventory + insightAsinStock / insightSkuStock / insightInventoryFields)
//   (B) readSavedListingsRows + readSavedHealthBridge: ZERO export; every failure is a reason
//   (C) the REAL builders: NO Health export, NO Listings export; listings / bridge / stale bridge / no Health
//   (D) the browser engine (insights.js): dated + qualified stock claims, no claim without an observation time, every
//       Health-only metric (days of supply, run rate, competitive prices / price cause, Health inbound shipped+received)
//       removed -- never from a stale bridge -- and legacy payloads never read as 0
//   (E) pages + CSV carry the source label and no Health-only column; the scheduled derive's context loader
//   (F) brand-limited permissions unchanged
// 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

delete process.env.SUPABASE_URL; // the legacy single-invocation DataDoe flow (no durable store / cache)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const {
  insightInventory, insightInventoryFields, insightAsinStock, insightSkuStock, INSIGHT_LISTINGS_NOT_LOADED, INSIGHT_HEALTH_BRIDGE_NOT_LOADED,
  INSIGHT_INVENTORY_CONTEXT_KEY, insightEvidenceFromContext, salesMoversPayload,
} = await import("../lib/server/reports/derivation-core.js");
const { readSavedListingsRows, readInsightInventoryEvidence, INSIGHT_LISTINGS_MAX_CYCLE_LAG_DAYS } = await import("../lib/server/reports/common.js");
const { readSavedHealthBridge, HEALTH_BRIDGE_SOURCE_KEY } = await import("../lib/server/reports/health-bridge.js");
const { buildSalesMovers } = await import("../lib/server/reports/sales-movers.js");
const { buildBuyBoxLoss } = await import("../lib/server/reports/buy-box.js");
const { buildListingHealth } = await import("../lib/server/reports/listing-health.js");
const { SALES_TRAFFIC, PROFIT_BY_SKU, ORDER_LINE_ITEMS, PRODUCT_CATALOG, LISTINGS, LISTINGS_RAW, FBA_INVENTORY_HEALTH } = await import("../lib/server/reports/sources.js");
const { INVENTORY_SOURCE_MODEL, HEALTH_BRIDGE_MAX_AGE_DAYS } = await import("../lib/server/reports/inventory-consumer.js");
const { organizationFingerprint } = await import("../lib/server/source-identity.js");
const { makeInsightInventoryContextLoader, INSIGHT_INVENTORY_REPORT_KEYS } = await import("../lib/server/sync/insight-inventory-loader.js");
const { REPORT_CAPABILITIES, CAPABILITY } = await import("../lib/server/report-authorization.js");
const {
  INSIGHT_INVENTORY_SOURCE_MODEL, insightInventoryState, inventoryReasonText, buildSalesMoversRows, buildSalesMoversInsights, buildBuyBoxRows,
  buildBuyBoxInsights, buildListingHealthRows, buildListingHealthInsights,
} = await import("../src/lib/insights.js");

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`  ok  ${name}`); };
console.log("insight-inventory-source (cutover)");

const SELLER = "S1";
const TODAY = "2026-10-08";
const HEALTH_DAY = "2026-10-07"; // within 2 days of TODAY -> a usable bridge
const STALE_DAY = "2026-10-05"; // older than TODAY - 2 -> refused
const REFRESHED = "2026-10-07T03:05:00Z";
const SAVED_AT = "2026-10-07T09:00:00Z";

// One expanded (18-column) saved Listings row of this seller.
const L = (sku, asin, channel, avail, inbound = 0, extra = {}) => ({
  seller_or_vendor_id: SELLER, marketplace_country_code: "US", sku, child_asin: asin, fnsku: `X-${sku}`,
  listing_fulfillment_channel: channel, fba_quantity_available: avail, fba_quantity_inbound: inbound,
  fba_quantity_reserved: 0, fba_quantity_fc_transfer: 0, awd_available_distributable_quantity: null, awd_total_inbound_quantity: null, ...extra,
});
// A validated Listings set: known zero (with inbound), positive, merchant-fulfilled-only, identical duplicates.
const CLEAN = () => [
  L("SKU1", "A1", "AMAZON_NA", 0, 12),
  L("SKU2", "A2", "AMAZON_NA", 40),
  L("SKU4", "A4", "DEFAULT", 0, 0),
  L("SKU7", "A7", "AMAZON_NA", 9), L("SKU7", "A7", "AMAZON_NA", 9), // identical listing rows -> counted ONCE
  L("S-STOCK", "C-S-STOCK", "AMAZON_NA", 0), L("S-FBM", "C-S-FBM", "DEFAULT", 0, 0), L("S-OK", "C-S-OK", "AMAZON_NA", 30),
];
// One SAVED durable FBA Inventory Health row (the persisted fba-plan:inventory-health columns: WITH inbound_working).
// The legacy Health-only metrics are present on purpose: they must never surface anywhere.
const H = (sku, asin, available, extra = {}) => ({
  date: HEALTH_DAY, marketplace_country_code: "US", seller_or_vendor_id: SELLER, sku, child_asin: asin, fnsku: `X-${sku}`, product_name: `P ${sku}`,
  available, reserved_customer_order: 0, reserved_fc_transfer: 0, reserved_fc_processing: 0,
  inbound_working: 1, inbound_shipped: 2, inbound_received: 1,
  days_of_supply: 6, units_shipped_t30: 30, your_price: 12, sales_price: 12, featuredoffer_price: 10, lowest_price_new_plus_shipping: 11, ...extra,
});
const HEALTH = (date = HEALTH_DAY) => [H("SKU1", "A1", 5), H("SKU2", "A2", 0), H("SKU7", "A7", 3), H("S-STOCK", "C-S-STOCK", 0), H("S-OK", "C-S-OK", 50), H("LH1", "L1", 6), H("LH2", "L2", 0)].map((r) => ({ ...r, date }));
const bridgeOk = (rows = HEALTH()) => ({ rows, unavailableReason: null, snapshotDate: rows.reduce((d, r) => (r.date > d ? r.date : d), ""), savedAt: SAVED_AT });
const listingsOk = (rows = CLEAN(), refreshedAt = REFRESHED) => ({ rows, unavailableReason: null, refreshedAt, marketplace: "US" });
const HEALTH_ONLY_KEYS = ["health", "daysOfSupply", "unitsShippedT30", "featuredOfferPrice", "yourPrice", "salesPrice", "lowestPriceNewPlusShipping", "inboundShippedReceived", "unfulfillable"];

/* ============================== (A) the pure per-account decision ============================== */

await test("A1 validated Listings -> source listings: known zero / positive / absent / mfn-only; identical duplicates once; Listings wins over the bridge; no inventory date", () => {
  const inv = insightInventory({ listings: listingsOk(), healthBridge: bridgeOk(), asOf: TODAY, sellerId: SELLER });
  assert.equal(inv.sel.source, "listings");
  assert.deepEqual(insightAsinStock(inv, "A1"), { source: "listings", listed: true, fbaContext: "fba", fbaAvailable: 0, fbaInbound: 12, conflict: false }, "Listings 0, never the bridge 5; no Health-only key");
  assert.equal(insightAsinStock(inv, "A2").fbaAvailable, 40);
  assert.deepEqual(insightAsinStock(inv, "A3"), { source: "listings", listed: false, fbaContext: null, fbaAvailable: null, fbaInbound: null, conflict: false }, "absent: unknown, never 0");
  assert.deepEqual(insightAsinStock(inv, "A4"), { source: "listings", listed: true, fbaContext: "mfn-only", fbaAvailable: null, fbaInbound: null, conflict: false });
  assert.equal(insightAsinStock(inv, "A7").fbaAvailable, 9, "two identical listing rows = 9, not 18");
  assert.deepEqual(insightSkuStock(inv, "S-FBM"), { source: "listings", listed: true, channel: "DEFAULT", fbaContext: "mfn-only", fbaAvailable: null, fbaInbound: null, conflict: false });
  const f = insightInventoryFields(inv);
  assert.deepEqual(f, { inventoryModel: INVENTORY_SOURCE_MODEL, inventorySource: "listings", inventorySourceLabel: `Listings refreshed ${REFRESHED}`, inventoryAvailable: true,
    listingsRefreshedAt: REFRESHED, inventoryHealthDate: null, inventoryFallbackReasons: [], inventoryUnavailableReasons: [], inventoryResolvedConflicts: 0, inventorySnapshotDate: null });
  assert.equal(INSIGHT_INVENTORY_SOURCE_MODEL, INVENTORY_SOURCE_MODEL, "the browser and the server agree on the payload model");
});

await test(`A2 Listings NOT validated + a FRESH saved Health bridge (date >= asOf-${HEALTH_BRIDGE_MAX_AGE_DAYS}) -> the dated, labelled bridge (15-column / conflict / __EMPTY__ / blank / foreign seller / not loaded / stale Listings)`, () => {
  const old = CLEAN().map(({ fba_quantity_inbound, fba_quantity_reserved, fba_quantity_fc_transfer, ...r }) => r);
  const cases = [
    [listingsOk(old), "listings-not-expanded"],
    [listingsOk([...CLEAN(), L("SKU2", "A2", "AMAZON_NA", 41)]), "listings-unresolved-conflicts:1"],
    [listingsOk([...CLEAN(), L("SKU-X", "__EMPTY__", "AMAZON_NA", 4)]), "listings-unattributed-stock:1"],
    [listingsOk([...CLEAN(), L("SKU-B", "A8", "AMAZON_NA", 3, null)]), "listings-blank-fba-fields:1"],
    [listingsOk([...CLEAN(), { ...L("SKU-O", "A9", "AMAZON_NA", 3), seller_or_vendor_id: "OTHER" }]), "listings-foreign-seller-rows"],
    [null, INSIGHT_LISTINGS_NOT_LOADED],
    [{ rows: null, unavailableReason: "listings-snapshot-stale" }, "listings-snapshot-stale"],
  ];
  for (const [listings, reason] of cases) {
    const inv = insightInventory({ listings, healthBridge: bridgeOk(), asOf: TODAY, sellerId: SELLER });
    assert.equal(inv.sel.source, "health-fallback", reason);
    assert.ok(inv.sel.listingsReasons.includes(reason), `${reason}: ${inv.sel.listingsReasons}`);
    const a1 = insightAsinStock(inv, "A1");
    assert.equal(a1.fbaAvailable, 5, `${reason}: the bridge figure, never a Listings one`);
    assert.equal(a1.fbaInbound, 4, "bridge inbound = working + shipped + received (the saved snapshot carries inbound_working)");
    for (const k of HEALTH_ONLY_KEYS) assert.ok(!(k in a1), `${reason}: Health-only ${k} is never carried`);
    const f = insightInventoryFields(inv);
    assert.equal(f.inventorySource, "health-fallback"); assert.equal(f.inventoryHealthDate, HEALTH_DAY); assert.equal(f.inventorySnapshotDate, HEALTH_DAY);
    assert.equal(f.listingsRefreshedAt, null, "a bridge account claims no Listings refresh");
    assert.ok(f.inventorySourceLabel.startsWith(`FBA Inventory Health snapshot ${HEALTH_DAY} (saved, no longer refreshed -- temporary bridge: `), f.inventorySourceLabel);
  }
  // An expanded-but-conflicting Listings snapshot: still identity evidence for a merchant-fulfilled-only product.
  const inv = insightInventory({ listings: listingsOk([...CLEAN(), L("SKU2", "A2", "AMAZON_NA", 41)]), healthBridge: bridgeOk(), asOf: TODAY, sellerId: SELLER });
  assert.deepEqual(insightAsinStock(inv, "A3"), { source: "health-fallback", listed: false, fbaContext: null, fbaAvailable: null, fbaInbound: null, conflict: false }, "absent from the bridge: unknown, never 0");
  assert.equal(insightAsinStock(inv, "A4").fbaContext, "mfn-only", "a Listings-only merchant-fulfilled product stays mfn-only (never an FBA stockout)");
  assert.equal(insightSkuStock(inv, "S-STOCK").channel, null, "Health reports no channel; never inferred");
  assert.ok(!("health" in insightSkuStock(inv, "S-STOCK")), "no competitive prices / run rate ride on a bridge SKU");
});

await test(`A3 a STALE saved bridge (date < asOf-${HEALTH_BRIDGE_MAX_AGE_DAYS}) or no as-of -> unavailable (typed), never the stale figure`, () => {
  const conflicting = listingsOk([...CLEAN(), L("SKU2", "A2", "AMAZON_NA", 41)]);
  const stale = insightInventory({ listings: conflicting, healthBridge: bridgeOk(HEALTH(STALE_DAY)), asOf: TODAY, sellerId: SELLER });
  assert.equal(stale.sel.source, "unavailable");
  assert.equal(insightAsinStock(stale, "A1"), null, "stale bridge: stock unavailable, never 5 and never 0");
  const f = insightInventoryFields(stale);
  assert.equal(f.inventoryAvailable, false); assert.equal(f.inventorySnapshotDate, null);
  assert.deepEqual(f.inventoryUnavailableReasons, ["listings-unresolved-conflicts:1", `health-bridge-stale:${STALE_DAY}`]);
  // The threshold edge: exactly asOf - 2 is still usable.
  assert.equal(insightInventory({ listings: conflicting, healthBridge: bridgeOk(HEALTH("2026-10-06")), asOf: TODAY, sellerId: SELLER }).sel.source, "health-fallback");
  const noAsOf = insightInventoryFields(insightInventory({ listings: conflicting, healthBridge: bridgeOk(), sellerId: SELLER }));
  assert.equal(noAsOf.inventorySource, "unavailable");
  assert.ok(noAsOf.inventoryUnavailableReasons.includes("health-bridge-as-of-missing"), "without the report as-of the bridge is refused");
});

await test("A4 no saved Health snapshot / not loaded / read failure -> unavailable; every row's stock null (never 0); reasons kept", () => {
  const conflicting = listingsOk([...CLEAN(), L("SKU2", "A2", "AMAZON_NA", 41)]);
  const missing = insightInventoryFields(insightInventory({ listings: conflicting, healthBridge: { rows: null, unavailableReason: "health-snapshot-missing" }, asOf: TODAY, sellerId: SELLER }));
  assert.equal(missing.inventorySource, "unavailable"); assert.equal(missing.inventoryAvailable, false);
  assert.deepEqual(missing.inventoryUnavailableReasons, ["listings-unresolved-conflicts:1", "health-snapshot-missing"]);
  const notLoaded = insightInventoryFields(insightInventory({ listings: conflicting, asOf: TODAY, sellerId: SELLER }));
  assert.equal(notLoaded.inventoryUnavailableReasons[1], INSIGHT_HEALTH_BRIDGE_NOT_LOADED);
  const none = insightInventory({ listings: null, healthBridge: null, asOf: TODAY });
  assert.equal(insightAsinStock(none, "A1"), null); assert.equal(insightSkuStock(none, "SKU1"), null);
  // A bridge carrying ANOTHER seller's rows is refused (never another account's stock).
  const foreign = insightInventoryFields(insightInventory({ listings: conflicting, healthBridge: bridgeOk([...HEALTH(), { ...H("Z", "AZ", 9), seller_or_vendor_id: "OTHER" }]), asOf: TODAY, sellerId: SELLER }));
  assert.deepEqual(foreign.inventoryUnavailableReasons, ["listings-unresolved-conflicts:1", "health-foreign-seller-rows"]);
});

await test("A5 AAKRITI-style unresolved duplicate conflict -> the fresh bridge (dated); FR __EMPTY__ unattributed -> the bridge, resolved ONLY by the account's own unique sales mapping", () => {
  // AAKRITI: one SKU on two listings whose FBA quantities disagree -> unresolved -> Listings not validated -> bridge.
  const aakriti = listingsOk([L("AK1", "B1", "AMAZON_EU", 5, 0, { marketplace_country_code: "US" }), L("AK1", "B1", "AMAZON_EU", 7), L("AK2", "B2", "AMAZON_EU", 3)]);
  const bridgeRows = [H("AK1", "B1", 6), H("AK2", "B2", 3)];
  const ak = insightInventory({ listings: aakriti, healthBridge: bridgeOk(bridgeRows), asOf: TODAY, sellerId: SELLER });
  assert.equal(ak.sel.source, "health-fallback"); assert.ok(ak.sel.listingsReasons.includes("listings-unresolved-conflicts:1"));
  assert.equal(insightAsinStock(ak, "B1").fbaAvailable, 6, "the bridge figure for the conflicting SKU, never 5 / 7 / 12");
  assert.equal(insightInventory({ listings: aakriti, healthBridge: bridgeOk(bridgeRows.map((r) => ({ ...r, date: STALE_DAY }))), asOf: TODAY, sellerId: SELLER }).sel.source, "unavailable", "AAKRITI with a too-old bridge -> unavailable");
  // FR: DataDoe's "__EMPTY__" ASIN placeholder on stock -> unattributed -> bridge; the account's own sales resolve it -> Listings.
  const fr = listingsOk([...CLEAN(), L("SKU-X", "__EMPTY__", "AMAZON_NA", 4)]);
  assert.equal(insightInventory({ listings: fr, healthBridge: bridgeOk(), asOf: TODAY, sellerId: SELLER }).sel.source, "health-fallback");
  const resolved = insightInventory({ listings: fr, healthBridge: bridgeOk(), asOf: TODAY, sellerId: SELLER, asinForSku: (sku) => (sku === "SKU-X" ? "A5" : null) });
  assert.equal(resolved.sel.source, "listings"); assert.equal(insightAsinStock(resolved, "A5").fbaAvailable, 4);
  assert.equal(insightAsinStock(resolved, "__EMPTY__").listed, false, "the placeholder is never a product key");
});

await test("A6 the payload builder carries the decision (a pure salesMoversPayload with saved evidence == the live shape); no inventoryRows input exists", () => {
  const base = { accountId: SELLER, asOf: TODAY, latestReportedDate: "2026-10-05", recent: { from: "2026-09-29", to: "2026-10-05" }, prior: { from: "2026-09-22", to: "2026-09-28" },
    lagDays: 4, sourceLabel: "S&T", windowDays: 7,
    recentTrafficRows: [{ child_asin: "A1", sales_sum: 10, units_sum: 2, sessions_sum: 5 }], priorTrafficRows: [], recentAdsRows: [], priorAdsRows: [], catalogRows: [], sellerId: SELLER };
  const p = salesMoversPayload({ ...base, listings: listingsOk(), healthBridge: bridgeOk() });
  assert.equal(p.inventorySource, "listings"); assert.equal(p.rows[0].stock.fbaAvailable, 0);
  assert.ok(!("inventory" in p.rows[0]));
  // A legacy caller passing Health rows the old way gets NOTHING from them (no Health fragment input exists).
  const legacy = salesMoversPayload({ ...base, inventoryRows: HEALTH() });
  assert.equal(legacy.inventorySource, "unavailable");
  assert.deepEqual(legacy.inventoryUnavailableReasons, [INSIGHT_LISTINGS_NOT_LOADED, INSIGHT_HEALTH_BRIDGE_NOT_LOADED]);
  // The scheduled derive's context evidence is read through ONE key.
  assert.equal(INSIGHT_INVENTORY_CONTEXT_KEY, "insightInventoryEvidence");
  assert.deepEqual(insightEvidenceFromContext({ insightInventoryEvidence: { listings: listingsOk(), healthBridge: bridgeOk() } }).listings.refreshedAt, REFRESHED);
  assert.deepEqual(insightEvidenceFromContext({}), { listings: null, healthBridge: null });
  assert.deepEqual(insightEvidenceFromContext({ insightInventoryEvidence: [1] }), { listings: null, healthBridge: null });
});

/* ============================== (B) saved readers (zero export) ============================== */

const POINTER = (over = {}) => ({ account_id: SELLER, marketplace: "US", as_of: HEALTH_DAY, object_path: "source-snapshots/x/listings/abc.json", row_count: CLEAN().length, validated_at: REFRESHED, ...over });
const readerOf = ({ pointer = POINTER(), read: r = "ok", payloadRows = CLEAN(), pointerThrows = false, payloadThrows = false, calls = [] } = {}) => ({
  readPointer: async (args) => { calls.push(["pointer", args]); if (pointerThrows) throw new Error("boom"); return { snapshot: pointer, read: r, error: r === "ok" ? null : "X" }; },
  readPayload: async (path) => { calls.push(["payload", path]); if (payloadThrows) throw new Error("SOURCE_SNAPSHOT_PAYLOAD_MISMATCH"); return { rows: payloadRows }; },
});
const HPOINTER = (over = {}) => ({ organization_fingerprint: organizationFingerprint("test-key"), connection_id: "primary", source_key: HEALTH_BRIDGE_SOURCE_KEY, scope_key: SELLER, object_path: "source-snapshots/x/fba-inventory-health/def.json", row_count: HEALTH().length, validated_at: SAVED_AT, ...over });
const healthReaderOf = ({ pointer = HPOINTER(), read: r = "ok", payloadRows = HEALTH(), pointerThrows = false, payloadThrows = false, calls = [] } = {}) => ({
  readHealthPointer: async (args) => { calls.push(["health-pointer", args]); if (pointerThrows) throw new Error("boom"); return { snapshot: pointer, read: r, error: r === "ok" ? null : "X" }; },
  readHealthPayload: async (path) => { calls.push(["health-payload", path]); if (payloadThrows) throw new Error("SOURCE_SNAPSHOT_PAYLOAD_MISMATCH"); return { rows: payloadRows }; },
});

await test("B1 fresh saved Listings -> rows + refresh time (validated_at) + marketplace; identity = org fingerprint + connection + RAW seller id", async () => {
  const calls = [];
  const out = await readSavedListingsRows({ apiKey: "test-key", connectionId: "primary", accountId: SELLER, asOf: TODAY, ...readerOf({ calls }) });
  assert.equal(out.unavailableReason, null); assert.equal(out.rows.length, CLEAN().length); assert.equal(out.refreshedAt, REFRESHED); assert.equal(out.marketplace, "US");
  assert.deepEqual(calls[0], ["pointer", { organizationFingerprint: organizationFingerprint("test-key"), connectionId: "primary", accountId: SELLER }]);
});

await test(`B2 Listings cycle freshness: as_of >= asOf-${INSIGHT_LISTINGS_MAX_CYCLE_LAG_DAYS} accepted; older -> listings-snapshot-stale`, async () => {
  const at = async (asOf) => readSavedListingsRows({ apiKey: "k", accountId: SELLER, asOf: TODAY, ...readerOf({ pointer: POINTER({ as_of: asOf }) }) });
  assert.equal((await at("2026-10-06")).unavailableReason, null);
  assert.equal((await at("2026-10-05")).unavailableReason, "listings-snapshot-stale");
});

await test("B3 every Listings read failure is a reason (never throws, never rows)", async () => {
  const run = (o, extra = {}) => readSavedListingsRows({ apiKey: "k", accountId: SELLER, asOf: TODAY, ...readerOf(o), ...extra });
  assert.equal((await run({ pointer: null })).unavailableReason, "listings-snapshot-missing");
  assert.equal((await run({ read: "schema-missing", pointer: null })).unavailableReason, "listings-snapshot-missing");
  assert.equal((await run({ read: "read-failed", pointer: null })).unavailableReason, "listings-snapshot-read-failed");
  assert.equal((await run({ pointerThrows: true })).unavailableReason, "listings-snapshot-read-failed");
  assert.equal((await run({ payloadThrows: true })).unavailableReason, "listings-payload-unreadable");
  assert.equal((await run({ pointer: POINTER({ row_count: 3 }) })).unavailableReason, "listings-payload-row-count-mismatch");
  assert.equal((await run({}, { accountId: "dd-secondary:S1" })).unavailableReason, "listings-identity-unavailable");
  assert.equal((await run({}, { apiKey: null })).unavailableReason, "listings-identity-unavailable");
  for (const o of [{ pointer: null }, { payloadThrows: true }]) assert.equal((await run(o)).rows, null);
});

await test("B4 readSavedHealthBridge: the durable source_snapshots('fba-inventory-health', scope = account) READ-ONLY; dated by its latest row; saved time = validated_at", async () => {
  const calls = [];
  const h = healthReaderOf({ calls });
  const out = await readSavedHealthBridge({ apiKey: "test-key", connectionId: "primary", accountId: SELLER, rawSellerId: SELLER, readPointer: h.readHealthPointer, readPayload: h.readHealthPayload });
  assert.equal(out.unavailableReason, null); assert.equal(out.rows.length, HEALTH().length);
  assert.equal(out.snapshotDate, HEALTH_DAY); assert.equal(out.savedAt, SAVED_AT);
  assert.deepEqual(calls[0], ["health-pointer", { organizationFingerprint: organizationFingerprint("test-key"), connectionId: "primary", sourceKey: "fba-inventory-health", scopeKey: SELLER, signal: null }]);
  assert.deepEqual(calls[1], ["health-payload", HPOINTER().object_path]);
});

await test("B5 every bridge read failure / integrity failure is a typed reason (never throws, never rows)", async () => {
  const run = async (o, extra = {}) => { const h = healthReaderOf(o); return readSavedHealthBridge({ apiKey: "test-key", accountId: SELLER, rawSellerId: SELLER, readPointer: h.readHealthPointer, readPayload: h.readHealthPayload, ...extra }); };
  assert.equal((await run({ pointer: null })).unavailableReason, "health-snapshot-missing");
  assert.equal((await run({ read: "schema-missing", pointer: null })).unavailableReason, "health-snapshot-missing");
  assert.equal((await run({ read: "read-failed", pointer: null })).unavailableReason, "health-snapshot-read-failed");
  assert.equal((await run({ pointerThrows: true })).unavailableReason, "health-snapshot-read-failed");
  assert.equal((await run({ payloadThrows: true })).unavailableReason, "health-payload-unreadable");
  assert.equal((await run({ pointer: HPOINTER({ row_count: 3 }) })).unavailableReason, "health-payload-row-count-mismatch");
  assert.equal((await run({ pointer: HPOINTER({ scope_key: "OTHER" }) })).unavailableReason, "health-snapshot-identity-mismatch");
  assert.equal((await run({ pointer: HPOINTER({ source_key: "listings" }) })).unavailableReason, "health-snapshot-identity-mismatch");
  assert.equal((await run({ payloadRows: [...HEALTH().slice(1), { ...H("Z", "AZ", 1), seller_or_vendor_id: "OTHER" }] })).unavailableReason, "health-foreign-seller-rows");
  assert.equal((await run({}, { apiKey: null })).unavailableReason, "health-identity-unavailable");
  for (const o of [{ pointer: null }, { payloadThrows: true }, { pointer: HPOINTER({ row_count: 3 }) }]) assert.equal((await run(o)).rows, null);
});

await test("B6 readInsightInventoryEvidence: BOTH saved inputs with the right identities (Listings = RAW seller; Health = the scope key); zero export", async () => {
  const calls = [];
  const ev = await readInsightInventoryEvidence({ apiKey: "test-key", ids: [SELLER], to: TODAY, listings: { connectionId: "primary", healthScopeKey: SELLER, ...readerOf({ calls }), ...healthReaderOf({ calls }) } });
  assert.equal(ev.listings.unavailableReason, null); assert.equal(ev.healthBridge.unavailableReason, null);
  assert.deepEqual(calls.map((c) => c[0]), ["pointer", "payload", "health-pointer", "health-payload"]);
});

/* ============================== (C) builders: NO Health export ============================== */

const created = [];
const rowsByExport = new Map();
let exportSeq = 0;
const SM_ASINS = ["A1", "A2", "A3", "A4", "A7"];
const BB_SKUS = ["S-STOCK", "S-FBM", "S-ABSENT", "S-OK"];
const respond = (body) => {
  const cols = (body.columns || []).join(",");
  const inWin = (d) => (!body.from || d >= body.from) && (!body.to || d <= body.to);
  if (body.sourceId === SALES_TRAFFIC.id && cols === "date") return [{ date: "2026-10-05", units_sum: 9 }];
  if (body.sourceId === SALES_TRAFFIC.id) {
    const recent = body.from === "2026-09-29";
    return SM_ASINS.map((asin) => ({ child_asin: asin, product_name: `P ${asin}`, sales_sum: recent ? 100 : 80, units_sum: recent ? 10 : 8, orders_sum: 1, sessions_sum: 50, page_views_sum: 60, units_shipped_sum: 1, units_refunded_sum: 0 }));
  }
  if (body.sourceId === PROFIT_BY_SKU.id && cols.includes("buybox_percentage")) {
    return inWin("2026-10-06") ? BB_SKUS.map((sku) => ({ date: "2026-10-06", sku, child_asin: `C-${sku}`, product_name: sku, product_brand: "Acme", currency: "USD", buybox_percentage: 50, page_views: 10 })) : [];
  }
  if (body.sourceId === PROFIT_BY_SKU.id && cols === "sku,child_asin,currency") return [{ sku: "LH1", child_asin: "L1", currency: "USD", sales_sum: 10, units_sum: 1, profit_sum: 2 }];
  if (body.sourceId === PROFIT_BY_SKU.id) return [];
  if (body.sourceId === ORDER_LINE_ITEMS.id) {
    return inWin("2026-10-06") ? BB_SKUS.map((sku) => ({ date: "2026-10-06", seller_or_vendor_id: SELLER, sku, child_asin: `C-${sku}`, item_price_currency: "USD", total_sales_sum: 100, total_units_sum: 5 })) : [];
  }
  if (body.sourceId === FBA_INVENTORY_HEALTH.id) throw new Error("an FBA Inventory Health export was requested (the cutover forbids it)");
  if (body.sourceId === PRODUCT_CATALOG.id) return [{ child_asin: "A1", parent_asin: "P", product_name: "Cat A1", product_brand: "Acme" }];
  if (body.sourceId === LISTINGS.id) {
    return [
      { sku: "LH1", child_asin: "L1", listing_name: "One", listing_status: "Inactive", listing_price_value: 9.5, listing_price_currency: "USD", listing_current_quantity: 0, listing_pending_quantity: 0, fba_quantity_available: null, fba_quantity_inbound: 4, fba_quantity_reserved: "", listing_fulfillment_channel: "AMAZON_NA", listing_open_date: null },
      { sku: "LH2", child_asin: "L2", listing_name: "Two", listing_status: "Active", listing_price_value: 5, listing_price_currency: "USD", listing_current_quantity: 0, listing_pending_quantity: 0, fba_quantity_available: 0, fba_quantity_inbound: 0, fba_quantity_reserved: 0, listing_fulfillment_channel: "AMAZON_NA", listing_open_date: null },
    ];
  }
  if (body.sourceId === LISTINGS_RAW.id) return [];
  return [];
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const u = String(url);
  if (u.endsWith("/exports") && options.method === "POST") {
    const body = JSON.parse(options.body);
    created.push(body);
    const id = `fx-${(exportSeq += 1)}`;
    rowsByExport.set(id, respond(body));
    return { ok: true, status: 200, json: async () => ({ exportId: id, status: "COMPLETED" }) };
  }
  const m = u.match(/\/exports\/(fx-\d+)\/raw$/);
  if (m) return { ok: true, status: 200, json: async () => ({ rawContent: JSON.stringify(rowsByExport.get(m[1]) || []) }) };
  throw new Error("unexpected fetch in insight-inventory-source test: " + u);
};
const saved = (over = {}, health = {}) => ({ connectionId: "primary", ...readerOf(over), ...healthReaderOf(health) });
const noHealthExport = () => assert.ok(!created.some((b) => String(b.sourceId || "").startsWith(FBA_INVENTORY_HEALTH.id.slice(0, 10))), "NO FBA Inventory Health export is ever requested");

let smListings; let smBridge; let bbBridge; let lhListings;
try {
  await test("C1 buildSalesMovers: NO Health export, ZERO Listings export; validated saved Listings is the source", async () => {
    const start = created.length;
    smListings = await buildSalesMovers({ apiKey: "test-key", ids: [SELLER], to: TODAY, listings: saved() });
    const bodies = created.slice(start);
    assert.ok(!bodies.some((b) => b.sourceId === LISTINGS.id), "stock is read from the SAVED Listings snapshot: zero Listings export");
    noHealthExport();
    assert.equal(smListings.inventorySource, "listings"); assert.equal(smListings.listingsRefreshedAt, REFRESHED); assert.equal(smListings.inventorySnapshotDate, null);
    const by = Object.fromEntries(smListings.rows.map((r) => [r.asin, r]));
    assert.equal(by.A1.stock.fbaAvailable, 0); assert.ok(!("health" in by.A1.stock), "no Health-only metric");
    assert.equal(by.A3.stock.listed, false); assert.equal(by.A4.stock.fbaContext, "mfn-only"); assert.equal(by.A7.stock.fbaAvailable, 9);
  });

  await test("C2 buildSalesMovers: a stale saved Listings snapshot -> the dated saved Health bridge (labelled), never stale Listings; a stale bridge -> unavailable; no saved Health -> unavailable", async () => {
    smBridge = await buildSalesMovers({ apiKey: "test-key", ids: [SELLER], to: TODAY, listings: saved({ pointer: POINTER({ as_of: "2026-09-30" }) }) });
    assert.equal(smBridge.inventorySource, "health-fallback");
    assert.deepEqual(smBridge.inventoryFallbackReasons, ["listings-snapshot-stale"]);
    assert.equal(smBridge.inventorySnapshotDate, HEALTH_DAY);
    const by = Object.fromEntries(smBridge.rows.map((r) => [r.asin, r]));
    assert.equal(by.A1.stock.fbaAvailable, 5); assert.equal(by.A1.stock.fbaInbound, 4); assert.equal(by.A2.stock.fbaAvailable, 0);
    for (const k of HEALTH_ONLY_KEYS) assert.ok(!(k in by.A1.stock), `no ${k}`);
    assert.equal(by.A3.stock.listed, false, "absent from the bridge: unknown, never 0");
    const stale = await buildSalesMovers({ apiKey: "test-key", ids: [SELLER], to: TODAY, listings: saved({ pointer: POINTER({ as_of: "2026-09-30" }) }, { payloadRows: HEALTH(STALE_DAY) }) });
    assert.equal(stale.inventorySource, "unavailable"); assert.ok(stale.rows.every((r) => r.stock === null));
    assert.deepEqual(stale.inventoryUnavailableReasons, ["listings-snapshot-stale", `health-bridge-stale:${STALE_DAY}`]);
    const none = await buildSalesMovers({ apiKey: "test-key", ids: [SELLER], to: TODAY, listings: saved({ pointer: null }, { pointer: null }) });
    assert.equal(none.inventorySource, "unavailable");
    assert.deepEqual(none.inventoryUnavailableReasons, ["listings-snapshot-missing", "health-snapshot-missing"]);
    noHealthExport();
  });

  await test("C3 buildBuyBoxLoss: Listings source -> stock + channel from Listings; bridge -> available units only (no price fields, no priceSourceLabel); NO Health export", async () => {
    const start = created.length;
    const p = await buildBuyBoxLoss({ apiKey: "test-key", ids: [SELLER], to: TODAY, listings: saved() });
    assert.ok(!created.slice(start).some((b) => b.sourceId === LISTINGS.id), "zero Listings export");
    noHealthExport();
    assert.equal(p.inventorySource, "listings"); assert.ok(!("priceSourceLabel" in p), "no FBA Inventory Health price source");
    assert.ok(p.rows.every((r) => !("price" in r) && !("available" in r) && !("inventoryKnown" in r) && (r.stock === null || !("health" in r.stock))));
    const cause = Object.fromEntries(buildBuyBoxRows(p, "ALL", 90).map((r) => [r.sku, r.cause]));
    assert.deepEqual(cause, { "S-STOCK": "stock", "S-FBM": "fulfilment", "S-ABSENT": "unconfirmed", "S-OK": "unconfirmed" });
    // No saved Listings at all: the bridge, and a SKU absent from Health is never inferred merchant-fulfilled.
    const noListings = await buildBuyBoxLoss({ apiKey: "test-key", ids: [SELLER], to: TODAY, listings: saved({ pointer: null }) });
    assert.equal(noListings.inventorySource, "health-fallback"); assert.deepEqual(noListings.inventoryFallbackReasons, ["listings-snapshot-missing"]);
    assert.equal(buildBuyBoxRows({ ...noListings, asOf: TODAY }, "ALL", 90).find((r) => r.sku === "S-FBM").cause, "unconfirmed", "no Health row is NOT proof of FBM");
    // Saved Listings that do not validate (a conflicting duplicate): bridge; the Listings still prove S-FBM mfn-only.
    const conflicting = [...CLEAN(), L("SKU2", "A2", "AMAZON_NA", 41)];
    bbBridge = await buildBuyBoxLoss({ apiKey: "test-key", ids: [SELLER], to: TODAY, listings: saved({ payloadRows: conflicting, pointer: POINTER({ row_count: conflicting.length }) }) });
    assert.equal(bbBridge.inventorySource, "health-fallback"); assert.ok(bbBridge.inventoryFallbackReasons.includes("listings-unresolved-conflicts:1"));
    const stock = bbBridge.rows.find((r) => r.sku === "S-OK").stock;
    assert.equal(stock.fbaAvailable, 50); assert.ok(!("health" in stock), "no competitive prices ride on a bridge SKU");
    noHealthExport();
  });

  await test("C4 buildListingHealth (v1): on-hand FBA from the per-account source; the listing record's own quantities stay null-preserving; NO Health export", async () => {
    lhListings = await buildListingHealth({ apiKey: "test-key", ids: [SELLER], to: TODAY,
      listings: saved({ payloadRows: [L("LH1", "L1", "AMAZON_NA", 7), L("LH2", "L2", "AMAZON_NA", 0)], pointer: POINTER({ row_count: 2 }) }) });
    assert.equal(lhListings.inventorySource, "listings");
    const one = lhListings.rows.find((r) => r.sku === "LH1");
    assert.deepEqual([one.onHandFba, one.onHandFbaSource], [7, "listings"], "the saved Listings figure, never the bridge 6");
    assert.deepEqual([one.fbaAvailable, one.fbaInbound, one.fbaReserved], [null, 4, null], "the listing record's own unknown quantity => null, never 0");
    assert.ok(!("snapshotAvailable" in one));
    const fb = await buildListingHealth({ apiKey: "test-key", ids: [SELLER], to: TODAY, listings: saved({ pointer: null }) });
    assert.equal(fb.inventorySource, "health-fallback");
    assert.deepEqual([fb.rows.find((r) => r.sku === "LH1").onHandFba, fb.rows.find((r) => r.sku === "LH1").onHandFbaSource], [6, "health-fallback"]);
    const stale = await buildListingHealth({ apiKey: "test-key", ids: [SELLER], to: TODAY, listings: saved({ pointer: null }, { payloadRows: HEALTH(STALE_DAY) }) });
    assert.equal(stale.inventorySource, "unavailable"); assert.ok(stale.rows.every((r) => r.onHandFba === null), "a stale bridge never drives on-hand FBA");
    noHealthExport();
  });

  await test("C5 the central refusal: a direct Health export request is refused as HEALTH_SOURCE_RETIRED (typed, non-retryable) -- no builder ever reaches it", async () => {
    const dd = await import("../lib/server/datadoe.js");
    if (typeof dd.isRetiredSourceError !== "function") { console.log("      (skipped: the central refusal is not present in this tree)"); return; }
    const before = created.length;
    let err = null;
    try { await dd.fetchExportRows("test-key", FBA_INVENTORY_HEALTH.id, ["date"], [SELLER], TODAY, TODAY, 10); } catch (e) { err = e; }
    assert.ok(err && dd.isRetiredSourceError(err), "the retired source is refused before any network call");
    assert.equal(created.length, before, "no export was created");
  });
} finally {
  globalThis.fetch = realFetch;
}

/* ============================== (D) browser engine: dated + qualified claims ============================== */

const moversPayload = (over = {}) => ({ ...smListings, asOf: HEALTH_DAY, ...over });

await test("D1 Listings same day as the report -> a stockout is dated and high-confidence; one day older -> qualified 'may have changed since', medium", () => {
  const fresh = moversPayload();
  const s = insightInventoryState(fresh);
  assert.equal(s.source, "listings"); assert.equal(s.stale, false); assert.equal(s.ageDays, 0);
  assert.equal(s.label, "Listings refreshed 2026-10-07 03:05 UTC (same day as this report)");
  const rows = buildSalesMoversRows(fresh, "ALL");
  assert.deepEqual(rows.filter((r) => r.stockedOut === true).map((r) => r.asin), ["A1"], "only the KNOWN-zero FBA ASIN; absent / mfn-only never");
  const out = buildSalesMoversInsights(fresh, rows, "USD").find((i) => i.category === "stockout");
  assert.equal(out.confidence, "high");
  assert.match(out.title, /Listings \(as of 2026-10-07 03:05 UTC\) showed zero FBA available$/);
  const stale = moversPayload({ asOf: TODAY });
  const outStale = buildSalesMoversInsights(stale, buildSalesMoversRows(stale, "ALL"), "USD").find((i) => i.category === "stockout");
  assert.equal(outStale.confidence, "medium");
  assert.match(outStale.title, /as of 2026-10-07 03:05 UTC, may have changed since/);
  assert.match(outStale.freshness, /1 day before this report's as-of date/);
});

await test("D2 saved Health bridge -> every stockout dated by the snapshot and ALWAYS qualified (medium); inbound = working+shipped+received; NO days of supply anywhere", () => {
  const p = { ...smBridge, asOf: TODAY };
  const s = insightInventoryState(p);
  assert.equal(s.source, "health-fallback"); assert.equal(s.stale, true);
  assert.equal(s.label, "FBA Inventory Health snapshot 2026-10-07 (saved, no longer refreshed — temporary bridge: the saved Listings snapshot is from an older scheduled run)");
  assert.match(s.note, /no longer refreshed/);
  assert.equal(insightInventoryState({ ...smBridge, asOf: HEALTH_DAY }).stale, true, "a bridge figure is never presented as current, even on its own date");
  const rows = buildSalesMoversRows(p, "ALL");
  assert.deepEqual(rows.filter((r) => r.stockedOut === true).map((r) => r.asin), ["A2"]);
  const insights = buildSalesMoversInsights(p, rows, "USD");
  const out = insights.find((i) => i.category === "stockout");
  assert.equal(out.confidence, "medium");
  assert.match(out.title, /as of the saved FBA Inventory Health snapshot of 2026-10-07, may have changed since\) showed zero FBA available/);
  assert.ok(out.evidence.some((e) => /^FBA inbound, working \+ shipped \+ received \(saved FBA Inventory Health snapshot 2026-10-07\)$/.test(e.label)));
  for (const r of rows) for (const k of ["healthDaysOfSupply", "healthInboundShippedReceived"]) assert.ok(!(k in r), `row ${k} removed`);
  assert.ok(!JSON.stringify(insights).match(/days of supply|Days of supply|shipped \+ received \(FBA/), "no Health-only metric in any insight");
});

await test("D3 no observation time -> no stock claim; unavailable / stale-bridge / legacy payloads never produce a stockout and never read 0", () => {
  const noTime = moversPayload({ listingsRefreshedAt: null });
  assert.equal(insightInventoryState(noTime).asOfPhrase, null);
  assert.ok(!buildSalesMoversInsights(noTime, buildSalesMoversRows(noTime, "ALL"), "USD").some((i) => i.category === "stockout"));
  const unavailable = { ...smListings, inventorySource: "unavailable", inventoryAvailable: false, inventoryUnavailableReasons: ["listings-snapshot-missing", `health-bridge-stale:${STALE_DAY}`] };
  const st = insightInventoryState(unavailable);
  assert.equal(st.available, false);
  assert.match(st.note, /no saved Listings snapshot exists for this account yet; the last saved FBA Inventory Health snapshot \(2026-10-05\) is too old to use/);
  assert.equal(inventoryReasonText("health-bridge-as-of-missing"), "the saved FBA Inventory Health snapshot cannot be checked against a report date");
  assert.ok(buildSalesMoversRows(unavailable, "ALL").every((r) => r.stock === null && r.stockedOut === null && r.fbaAvailable === null));
  const legacy = { asOf: TODAY, inventoryAvailable: true, inventorySnapshotDate: HEALTH_DAY, rows: [{ asin: "A1", brand: "Acme", recent: { sales: 10, units: 2 }, prior: { sales: 5, units: 1 }, inventory: { available: 0, inbound: 0, daysOfSupply: 0 } }] };
  assert.equal(insightInventoryState(legacy).legacy, true);
  const lr = buildSalesMoversRows(legacy, "ALL");
  assert.ok(!("inventory" in lr[0]) && lr[0].stockedOut === null, "a pre-phase-2 Health row is never read (absent => 0 was the old defect)");
});

await test("D4 Buy Box: bridge -> stock cause dated + qualified, medium; NO price cause (even from a pre-cutover snapshot's stock.health prices); absent SKU never FBM", () => {
  const p = { ...bbBridge, asOf: TODAY };
  const rows = buildBuyBoxRows(p, "ALL", 90);
  const by = Object.fromEntries(rows.map((r) => [r.sku, r]));
  assert.equal(by["S-STOCK"].cause, "stock"); assert.match(by["S-STOCK"].causeDetail, /as of the saved FBA Inventory Health snapshot of 2026-10-07, may have changed since/);
  assert.equal(by["S-OK"].cause, "unconfirmed", "a 12 offer vs a 10 featured offer was a Health price cause: removed");
  assert.match(by["S-OK"].causeDetail, /50 FBA units were available, so stock does not explain the loss\. Competitive prices are not evaluated/);
  assert.equal(by["S-FBM"].cause, "fulfilment", "the account's Listings prove it merchant-fulfilled only");
  assert.equal(by["S-ABSENT"].cause, "unconfirmed"); assert.equal(by["S-ABSENT"].fulfillmentChannel, null, "absent from Health is never inferred FBM");
  for (const r of rows) for (const k of ["effectivePrice", "featuredOfferPrice", "lowestPrice", "priceGap", "dailyRate"]) assert.ok(!(k in r), `${k} removed`);
  const ins = buildBuyBoxInsights(p, rows, 90);
  assert.ok(ins.filter((i) => i.category !== "buybox-unconfirmed").every((i) => i.confidence === "medium"));
  assert.ok(!ins.some((i) => i.category === "buybox-price"));
  assert.ok(!JSON.stringify(ins).includes("Featured offer price") && !JSON.stringify(ins).includes("run rate ("));
  // A pre-cutover saved payload whose stock still carries Health prices: never a price cause, never shown.
  const legacyPrices = { ...p, rows: p.rows.map((r) => (r.sku === "S-OK" ? { ...r, stock: { ...r.stock, health: { yourPrice: 12, salesPrice: 12, featuredOfferPrice: 10, lowestPriceNewPlusShipping: 11, unitsShippedT30: 900 } } } : r)) };
  const lr = buildBuyBoxRows(legacyPrices, "ALL", 90).find((r) => r.sku === "S-OK");
  assert.equal(lr.cause, "unconfirmed"); assert.ok(!("health" in lr.stock));
});

await test("D5 Listing Health v1: stranded FBA stock is dated by its source; unknown on-hand never strands", () => {
  // LH1: an Active listing with no buyable offer holding FBA stock (the stranded gate).
  const lh = { ...lhListings, asOf: TODAY, rows: lhListings.rows.map((r) => (r.sku === "LH1" ? { ...r, listingStatus: "Active", hasLiveOffer: false, summary: null, issues: [] } : r)) };
  const rows = buildListingHealthRows(lh, "ALL");
  const one = rows.find((r) => r.sku === "LH1");
  assert.equal(one.unitsOnHand, 7); assert.equal(one.gate, "stranded"); assert.equal(one.unitsOnHandSource, "listings");
  const ins = buildListingHealthInsights(lh, rows).find((i) => i.category === "stranded");
  assert.match(ins.title, /holds 7 units with no buyable offer \(Listings as of 2026-10-07 03:05 UTC, may have changed since\)$/);
  assert.equal(ins.confidence, "medium");
  const unknown = buildListingHealthRows({ ...lh, rows: lh.rows.map((r) => ({ ...r, onHandFba: null })) }, "ALL");
  assert.ok(unknown.every((r) => r.unitsOnHand === null && r.gate !== "stranded"), "unknown on-hand is never 0 and never strands");
  const legacy = buildListingHealthRows({ rows: [{ ...lhListings.rows[0], snapshotAvailable: 40, onHandFba: undefined }] }, "ALL");
  assert.equal(legacy[0].unitsOnHand, null); assert.ok(!("snapshotAvailable" in legacy[0]));
});

/* ============================== (E) pages + CSV + the scheduled derive's loader ============================== */

await test("E1 pages carry the per-account source label and NO Health-only column / CSV field (days of supply, prices, run rate)", () => {
  for (const f of ["src/views/SalesMovers.jsx", "src/views/BuyBoxLoss.jsx", "src/views/ListingHealth.jsx"]) {
    const src = read(f);
    assert.ok(src.includes("insightInventoryState") && src.includes("stockState.label"), f + " shows the source label");
    for (const s of ["FBA snapshot ${", "data.inventorySnapshotDate", "row.inventory", "row.available", "snapshotAvailable", "healthPrices", "healthDaysOfSupply"]) assert.ok(!src.includes(s), `${f}: no ${s}`);
  }
  const sm = read("src/views/SalesMovers.jsx");
  assert.ok(!/Days of Supply/.test(sm), "Sales Movers CSV has no days-of-supply field");
  const bb = read("src/views/BuyBoxLoss.jsx");
  for (const s of ["Featured Offer", "Your Price", "Your Effective Price", "Lowest New + Shipping", "Price Gap", "30-day Run Rate", "effectivePrice", "priceCaused"]) assert.ok(!bb.includes(s), `BuyBoxLoss.jsx: no ${s}`);
  const engine = read("src/lib/insights.js");
  assert.ok(!/data\.inventorySnapshotDate|row\.inventory\?|row\.snapshotAvailable/.test(engine), "the engine never reads a pre-phase-2 field");
  assert.ok(!/health\.(featuredOfferPrice|yourPrice|salesPrice|lowestPriceNewPlusShipping|unitsShippedT30|daysOfSupply|inboundShippedReceived)/.test(engine), "the engine reads no Health-only metric");
  // The three live builders never fetch FBA Inventory Health.
  const code = (f) => read(f).split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n"); // comments excluded
  for (const f of ["lib/server/reports/sales-movers.js", "lib/server/reports/buy-box.js", "lib/server/reports/listing-health.js", "lib/server/reports/common.js"]) {
    assert.ok(!/fetchInventorySnapshot|FBA_INVENTORY_HEALTH/.test(code(f)), `${f}: no Health fetch`);
  }
});

await test("E2 the scheduled derive's context loader: the SAME saved evidence for the three insight reports only; {} for every other report; fail-soft", async () => {
  const connections = [{ id: "primary", apiKey: "test-key", organizationFingerprint: organizationFingerprint("test-key"), accountIds: [SELLER] }];
  const seen = [];
  const loader = makeInsightInventoryContextLoader({ connections, readEvidence: async (args) => { seen.push(args); return { listings: listingsOk(), healthBridge: bridgeOk() }; } });
  assert.deepEqual([...INSIGHT_INVENTORY_REPORT_KEYS].sort(), ["buy-box-loss", "listing-health", "sales-movers"]);
  for (const reportKey of INSIGHT_INVENTORY_REPORT_KEYS) {
    const out = await loader({ reportKey, accountId: SELLER, planned: { context: { to: TODAY } } });
    assert.ok(out[INSIGHT_INVENTORY_CONTEXT_KEY], reportKey);
    assert.equal(out[INSIGHT_INVENTORY_CONTEXT_KEY].healthBridge.snapshotDate, HEALTH_DAY);
  }
  assert.deepEqual(seen[0].ids, [SELLER]); assert.equal(seen[0].to, TODAY);
  assert.equal(seen[0].listings.healthScopeKey, SELLER); assert.equal(seen[0].listings.connectionId, "primary");
  assert.deepEqual(await loader({ reportKey: "fba-plan", accountId: SELLER, planned: { context: { to: TODAY } } }), {});
  assert.deepEqual(await loader({ reportKey: "sales-movers", accountId: SELLER, planned: { context: {} } }), {}, "no authoritative as-of -> no evidence (Unavailable)");
  const throwing = makeInsightInventoryContextLoader({ connections, readEvidence: async () => { throw new Error("db down"); } });
  assert.deepEqual(await throwing({ reportKey: "sales-movers", accountId: SELLER, planned: { context: { to: TODAY } } }), {}, "fail-soft");
});

/* ============================== (F) permissions unchanged ============================== */

await test("F1 brand-limited permissions unchanged: the three insight reports stay denied to brand-restricted users", () => {
  for (const k of ["sales-movers", "buy-box-loss", "listing-health", "listing-health-v3"]) assert.equal(REPORT_CAPABILITIES[k], CAPABILITY.DENY_FOR_BRAND_RESTRICTED_USERS, k);
});

console.log(`\ninsight-inventory-source: ${passed} passed`);
