// Phase 4A -- Advanced Listing Health v3 PER-ACCOUNT SOURCE MATERIALIZATION.
//
// PRIMARY DEFECT (reproduced in A): regional Listings/Listings-Raw/inventory are exported in <=5-seller BATCHES, so
// the batch rows live under the BATCH request_hash; the v3 serve resolves a PER-ACCOUNT identity (one seller) whose
// hash differs, so a valid per-account read MISSES. The fix splits one validated batch back into N per-account cache
// aliases (ZERO new exports) so the serve's per-account read HITS with ONLY that seller's rows.
//
// Proves: reproduction of the miss; 5-seller batch -> 5 isolated per-account reads from ONE source export; end-to-end
// serve HIT after materialization; empty-seller valid-empty (distinct from missing); mixed-marketplace isolation;
// malformed-identity + cross-org rejection (never written); idempotent replay (no duplicate rows); partial/failed
// batch preserves last-known-good; zero DataDoe/network. Offline. 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { planListingHealthV3BucketBatched, buildShadowReportPlan, SHADOW_PLANNED_REPORT_KEYS, DEDICATED_BATCHED_SHADOW_REPORT_KEYS } from "../lib/server/sync/report-planner.js";
import {
  materializeListingHealthV3PerAccount,
  listingHealthV3PerAccountReadHashes,
  listingHealthV3PlannedExports,
  assertListingHealthV3ExportCeiling,
  expectedListingHealthV3NewExports,
  LISTING_HEALTH_V3_READ_KEYS,
  LISTING_HEALTH_V3_REGION_EXPORT_CEILING,
} from "../lib/server/sync/listing-health-v3-materialize.js";
import { serveListingHealthV3Preview } from "../lib/server/reports/listing-health-v3-serve.js";
import { organizationFingerprint, accountScopeHash } from "../lib/server/source-identity.js";
import { CONTROLLED_REPORT_KEYS, SCHEDULER_V2_READY_REPORT_KEYS, schedulerV2ReportControlCatalog } from "../lib/server/sync/report-controls.js";
import { selectSchedulerV2ReportKeys, classifySchedulerV2ReportKey } from "../lib/server/sync/sync-dispatch.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
const throwsSync = (n, fn) => { let t = false; try { fn(); } catch { t = true; } ok(n, t); };
writeSync(1, "report-listing-health-v3-materialize\n");

const API_KEY = "fixture-key";
const connections = [{ id: "primary", apiKey: API_KEY, accountPrefix: "" }];
const asOf = "2026-09-02";
const inv = "2026-09-04";
const SELLERS = ["acct-00", "acct-01", "acct-02", "acct-03", "acct-04"]; // 5 US sellers -> ONE batch
const usAccounts = SELLERS.map((id, i) => ({ accountId: id, country: "US", currency: "USD", name: `A${i}` }));

// Row builders (shapes match the v3 integration test).
const listingRow = (seller, mkt, sku, o = {}) => ({ seller_or_vendor_id: seller, marketplace_country_code: mkt, sku, child_asin: `ASIN-${sku}`, listing_name: o.name ?? `L ${sku}`, listing_status: o.status ?? "Active", listing_price_value: o.price ?? 9, listing_price_currency: "USD", listing_current_quantity: o.qty ?? 0, fba_quantity_available: o.fba ?? 0, listing_fulfillment_channel: o.channel ?? "AMAZON_NA", listing_open_date: "2024-01-01" });
const invRow = (date, seller, mkt, sku, available) => ({ date, seller_or_vendor_id: seller, marketplace_country_code: mkt, child_asin: `ASIN-${sku}`, sku, available });
const rawRow = (seller, mkt, sku) => ({ seller_or_vendor_id: seller, marketplace_country_code: mkt, sku, child_asin: `ASIN-${sku}`, summaries: JSON.stringify({ status: ["BUYABLE", "DISCOVERABLE"] }), issues: JSON.stringify([]), offers: JSON.stringify([{ price: { amount: 9 } }]) });

// A tiny in-memory source_export_cache, keyed by request_hash (upsert). Both the batch download and the per-account
// aliases live here, exactly as production source_export_cache would.
function makeCache() {
  const map = new Map();
  return {
    map,
    readSourceCache: async (h) => (map.has(h) ? { ...map.get(h) } : null),
    writeSourceCache: async ({ requestHash, rows, expiresAt, sourceId, organizationFingerprint: org, accountScopeHash: scope, requestMeta }) => {
      map.set(requestHash, { rows: [...rows], expires_at: expiresAt, source_id: sourceId, organization_fingerprint: org, account_scope_hash: scope, request_meta: requestMeta });
    },
    // The serve's cache-only saved-source reader reads the SAME cache by request_hash.
    getSavedSourceRows: async (h) => { const e = map.get(h); return e && Array.isArray(e.rows) ? e.rows : null; },
    // Metadata-only reader for the newer-only alias-overwrite guard (request_meta.batchFetchedAt).
    readAliasMeta: async (h) => { const e = map.get(h); return e && e.request_meta ? { batchFetchedAt: e.request_meta.batchFetchedAt } : null; },
  };
}

const plans = () => planListingHealthV3BucketBatched({ accounts: usAccounts, connections, asOfFor: () => asOf, inventoryAsOf: inv });

// Seed the batch payloads under the batch (source-job) hashes for the three v3 keys.
function seedBatch(cache, plan, { listings, raw, inventory }) {
  const rowsByKey = { "listing-health-v3:listings": listings, "listing-health-v3:listings-raw": raw, "listing-health-v3:inventory": inventory };
  const seen = new Set();
  for (const src of plan[0].sources) {
    if (seen.has(src.requestHash)) continue; seen.add(src.requestHash);
    if (rowsByKey[src.requestKey] === undefined) continue;
    cache.map.set(src.requestHash, { rows: [...rowsByKey[src.requestKey]], expires_at: "2999-01-01T00:00:00.000Z", source_id: src.sourceId, organization_fingerprint: src.organizationFingerprint, account_scope_hash: src.accountScopeHash });
  }
}

// The full listings batch: every seller has a row; acct-02 has TWO SKUs; acct-04 has NONE (empty seller).
const listingsBatch = [
  listingRow("acct-00", "US", "S00"),
  listingRow("acct-01", "US", "S01"),
  listingRow("acct-02", "US", "S02a"),
  listingRow("acct-02", "US", "S02b", { status: "Inactive", price: 0, qty: 3, channel: "DEFAULT" }),
  listingRow("acct-03", "US", "S03"),
  // acct-04: intentionally no listings rows (a genuine empty-success owner).
];
const rawBatch = SELLERS.filter((s) => s !== "acct-04").map((s) => rawRow(s, "US", `RAW-${s}`));
const inventoryBatch = [invRow("2026-09-03", "acct-02", "US", "S02a", 30), invRow("2026-09-03", "acct-00", "US", "S00", 5)];

/* ===================== A. reproduce the miss, then 5->5 from ONE export + end-to-end serve HIT ===================== */
await (async () => {
  const cache = makeCache();
  const p = plans();
  seedBatch(cache, p, { listings: listingsBatch, raw: rawBatch, inventory: inventoryBatch });

  // REPRODUCTION: before materialization, the per-account read hash for acct-02 misses (only the batch hash exists).
  const h02 = listingHealthV3PerAccountReadHashes({ apiKey: API_KEY, rawSellerId: "acct-02", marketplaceCountry: "US" });
  ok("A(defect): before materialization the per-account listings read MISSES (batch hash != per-account hash)", (await cache.getSavedSourceRows(h02["listing-health-v3:listings"])) === null);
  const batchListingsHash = p[0].sources.find((s) => s.requestKey === "listing-health-v3:listings").requestHash;
  ok("A(defect): the batch listings hash is NOT any account's per-account hash", batchListingsHash !== h02["listing-health-v3:listings"]);

  // MATERIALIZE with a fetch spy: ZERO network/DataDoe.
  const realFetch = globalThis.fetch; let hits = 0; globalThis.fetch = () => { hits += 1; throw new Error("no network in materialization"); };
  let summary;
  try { summary = await materializeListingHealthV3PerAccount({ plans: p, connections, readSourceCache: cache.readSourceCache, writeSourceCache: cache.writeSourceCache }); }
  finally { globalThis.fetch = realFetch; }
  ok("A: materialization makes ZERO DataDoe/network calls", hits === 0);

  // 5 accounts -> 5 distinct per-account listings aliases from the ONE batch listings hash.
  const listingAliasHashes = new Set(SELLERS.map((s) => listingHealthV3PerAccountReadHashes({ apiKey: API_KEY, rawSellerId: s, marketplaceCountry: "US" })["listing-health-v3:listings"]));
  ok("A: five accounts resolve to FIVE distinct per-account listings identities (no collision)", listingAliasHashes.size === 5);
  ok("A: none of the five per-account hashes equals the batch hash", ![...listingAliasHashes].includes(batchListingsHash));
  for (const s of ["acct-00", "acct-01", "acct-02", "acct-03"]) {
    const hh = listingHealthV3PerAccountReadHashes({ apiKey: API_KEY, rawSellerId: s, marketplaceCountry: "US" })["listing-health-v3:listings"];
    const rows = await cache.getSavedSourceRows(hh);
    ok(`A: ${s} listings alias materialized with ONLY its own rows`, Array.isArray(rows) && rows.length >= 1 && rows.every((r) => r.seller_or_vendor_id === s));
  }
  const a02 = await cache.getSavedSourceRows(h02["listing-health-v3:listings"]);
  ok("A: acct-02 (two SKUs) alias has EXACTLY its two rows -- no other seller leaks in", a02.length === 2 && a02.every((r) => r.seller_or_vendor_id === "acct-02"));

  // END-TO-END: the serve now HITS the per-account alias and returns ONLY acct-02's listings.
  const payload = await serveListingHealthV3Preview({
    owner: { accountId: "acct-02", rawSellerId: "acct-02" }, // api passes no marketplace; hash is marketplace-independent
    identity: { apiKey: API_KEY, connectionId: "primary" },
    windowControls: { preset: "30D" }, asOf,
    readers: {
      getEnrichedOli: async () => [{ account_id: "acct-02", seller_or_vendor_id: "acct-02", sale_date: "2026-09-01", sku: "S02a", child_asin: "ASIN-S02a", currency: "USD", sales_amount: 100, ordered_units: 10, unpriced_units: 0 }],
      getOliCoverage: async () => ({ read: "ok", windows: [{ from: "2024-01-01", to: asOf }] }),
      getCompleteness: async () => [],
      getCatalog: async () => [],
      getSavedSourceRows: cache.getSavedSourceRows,
    },
  });
  ok("A(e2e): the serve now HITS -- listings evidence available after materialization", payload.evidence.listingsEvidenceAvailable === true);
  const skus = payload.rows.map((r) => r.sku).sort();
  ok("A(e2e): the serve returns EXACTLY acct-02's two SKUs (no cross-account leak)", skus.join(",") === "S02a,S02b");
  ok("A(e2e): acct-02 window sales attach to its own SKU (durable OLI)", (payload.rows.find((r) => r.sku === "S02a") || {}).sales === 100);
})();

/* ===================== B. empty seller -> VALID-EMPTY alias (distinct from missing) ===================== */
await (async () => {
  const cache = makeCache();
  const p = plans();
  seedBatch(cache, p, { listings: listingsBatch, raw: rawBatch, inventory: inventoryBatch });
  await materializeListingHealthV3PerAccount({ plans: p, connections, readSourceCache: cache.readSourceCache, writeSourceCache: cache.writeSourceCache });
  const h04 = listingHealthV3PerAccountReadHashes({ apiKey: API_KEY, rawSellerId: "acct-04", marketplaceCountry: "US" });
  const rows = await cache.getSavedSourceRows(h04["listing-health-v3:listings"]);
  ok("B: an empty-success owner gets a VALID-EMPTY [] alias (written, not skipped)", Array.isArray(rows) && rows.length === 0);
  // A genuinely absent alias (a source never in the batch) stays null (missing/unavailable) -- proven by a hash we
  // never materialized (a fake seller not in any batch).
  const hGhost = listingHealthV3PerAccountReadHashes({ apiKey: API_KEY, rawSellerId: "ghost-seller", marketplaceCountry: "US" });
  ok("B: a never-materialized identity stays null (missing != empty)", (await cache.getSavedSourceRows(hGhost["listing-health-v3:listings"])) === null);
})();

/* ===================== C. mixed-marketplace isolation (a cross-marketplace row never enters an owner's alias) ===================== */
await (async () => {
  const cache = makeCache();
  const p = plans();
  // A stray row for acct-02's seller but a DIFFERENT marketplace (DE) alongside its US rows.
  const tainted = [...listingsBatch, listingRow("acct-02", "DE", "S02-DE")];
  seedBatch(cache, p, { listings: tainted, raw: rawBatch, inventory: inventoryBatch });
  await materializeListingHealthV3PerAccount({ plans: p, connections, readSourceCache: cache.readSourceCache, writeSourceCache: cache.writeSourceCache });
  const h02 = listingHealthV3PerAccountReadHashes({ apiKey: API_KEY, rawSellerId: "acct-02", marketplaceCountry: "US" });
  const rows = await cache.getSavedSourceRows(h02["listing-health-v3:listings"]);
  ok("C: the owner's US alias EXCLUDES the cross-marketplace (DE) row (marketplace-isolated)", rows.every((r) => r.marketplace_country_code === "US") && !rows.some((r) => r.sku === "S02-DE"));
})();

/* ===================== D. malformed identity -> skipped, never written ===================== */
await (async () => {
  const cache = makeCache();
  const p = plans();
  seedBatch(cache, p, { listings: listingsBatch, raw: rawBatch, inventory: inventoryBatch });
  // Corrupt one plan's owner (blank rawSellerId) -- it must be skipped, and NOTHING written for it.
  const broken = p.map((r) => (r.owner.accountId === "acct-03" ? { ...r, owner: { ...r.owner, rawSellerId: "" } } : r));
  const summary = await materializeListingHealthV3PerAccount({ plans: broken, connections, readSourceCache: cache.readSourceCache, writeSourceCache: cache.writeSourceCache });
  ok("D: an owner with a blank rawSellerId is counted as a skipped account", summary.skippedAccounts >= 1);
  const h03 = listingHealthV3PerAccountReadHashes({ apiKey: API_KEY, rawSellerId: "acct-03", marketplaceCountry: "US" });
  ok("D: no alias is written for the malformed-owner account", (await cache.getSavedSourceRows(h03["listing-health-v3:listings"])) === null);
})();

/* ===================== E. cross-org rejection -> never written ===================== */
await (async () => {
  const cache = makeCache();
  const p = plans();
  seedBatch(cache, p, { listings: listingsBatch, raw: rawBatch, inventory: inventoryBatch });
  // Force a batch fragment whose org differs from the owner's -> isolateFragmentRowsForOwner rejects (fail closed).
  const crossOrg = p.map((r) => (r.owner.accountId === "acct-01"
    ? { ...r, sources: r.sources.map((s) => ({ ...s, organizationFingerprint: "different-org-fingerprint" })) }
    : r));
  const summary = await materializeListingHealthV3PerAccount({ plans: crossOrg, connections, readSourceCache: cache.readSourceCache, writeSourceCache: cache.writeSourceCache });
  const h01 = listingHealthV3PerAccountReadHashes({ apiKey: API_KEY, rawSellerId: "acct-01", marketplaceCountry: "US" });
  ok("E: a cross-org batch fragment is rejected -- no alias written", (await cache.getSavedSourceRows(h01["listing-health-v3:listings"])) === null && summary.rejected >= 1);
})();

/* ===================== F. idempotent replay -> no duplicate rows, identical content ===================== */
await (async () => {
  const cache = makeCache();
  const p = plans();
  seedBatch(cache, p, { listings: listingsBatch, raw: rawBatch, inventory: inventoryBatch });
  await materializeListingHealthV3PerAccount({ plans: p, connections, readSourceCache: cache.readSourceCache, writeSourceCache: cache.writeSourceCache });
  const sizeAfterFirst = cache.map.size;
  const h02 = listingHealthV3PerAccountReadHashes({ apiKey: API_KEY, rawSellerId: "acct-02", marketplaceCountry: "US" })["listing-health-v3:listings"];
  const firstRows = JSON.stringify(await cache.getSavedSourceRows(h02));
  await materializeListingHealthV3PerAccount({ plans: p, connections, readSourceCache: cache.readSourceCache, writeSourceCache: cache.writeSourceCache });
  ok("F: replay adds NO new cache rows (upsert by request_hash)", cache.map.size === sizeAfterFirst);
  ok("F: replay leaves each alias byte-identical (no duplication/append)", JSON.stringify(await cache.getSavedSourceRows(h02)) === firstRows && JSON.parse(firstRows).length === 2);
})();

/* ===================== G. partial/failed batch preserves last-known-good ===================== */
await (async () => {
  const cache = makeCache();
  const p = plans();
  // A PRIOR successful cycle already materialized acct-00's inventory alias (last-known-good).
  const invH00 = listingHealthV3PerAccountReadHashes({ apiKey: API_KEY, rawSellerId: "acct-00", marketplaceCountry: "US" })["listing-health-v3:inventory"];
  cache.map.set(invH00, { rows: [invRow("2026-08-01", "acct-00", "US", "S00", 77)], expires_at: "2999-01-01T00:00:00.000Z" });
  // This cycle: listings batch present, inventory batch MISSING (failed download this cycle).
  seedBatch(cache, p, { listings: listingsBatch, raw: rawBatch }); // inventory intentionally not seeded
  const summary = await materializeListingHealthV3PerAccount({ plans: p, connections, readSourceCache: cache.readSourceCache, writeSourceCache: cache.writeSourceCache });
  ok("G: a missing inventory batch is counted, not written", summary.batchMissing >= 1);
  const invNow = await cache.getSavedSourceRows(invH00);
  ok("G: the prior inventory alias (LKG) SURVIVES an absent batch (never deleted/overwritten)", Array.isArray(invNow) && invNow.length === 1 && invNow[0].available === 77);
  const lh00 = listingHealthV3PerAccountReadHashes({ apiKey: API_KEY, rawSellerId: "acct-00", marketplaceCountry: "US" })["listing-health-v3:listings"];
  ok("G: this cycle still materialized the available (listings) fragment", Array.isArray(await cache.getSavedSourceRows(lh00)));
})();

/* ===================== H. defensive identity check: alias org/scope match the owner ===================== */
(() => {
  const idHashes = listingHealthV3PerAccountReadHashes({ apiKey: API_KEY, rawSellerId: "acct-02", marketplaceCountry: "US" });
  ok("H: every v3 read key resolves a per-account hash", LISTING_HEALTH_V3_READ_KEYS.every((k) => typeof idHashes[k] === "string" && idHashes[k].length > 0));
  ok("H: marketplace does NOT change the per-account read hash (serve passes null; ingestion passes the marketplace)",
    listingHealthV3PerAccountReadHashes({ apiKey: API_KEY, rawSellerId: "acct-02", marketplaceCountry: null })["listing-health-v3:listings"] === idHashes["listing-health-v3:listings"]);
  ok("H: the owner scope equals accountScopeHash([rawSellerId]) (single-account identity)", accountScopeHash(["acct-02"]).length > 0 && organizationFingerprint(API_KEY).length > 0);
})();

/* ===================== I. per-region export ceiling (new Listings + Listings-Raw only; inventory reuse = 0) ===================== */
(() => {
  const p = plans(); // 5 US accounts -> ONE batch -> 1 listings + 1 listings-raw + 1 inventory hash
  const counts = listingHealthV3PlannedExports(p);
  ok("I: only Listings + Listings-Raw count as NEW exports (one batch -> 2 new)", counts.newExports === 2);
  ok("I: inventory is counted as a REUSED export (zero incremental), never a new create", counts.reusedExports === 1 && !counts.newExportHashes.includes(counts.reusedExportHashes[0]));
  // Within ceiling: us-ca baseline is 4 (2 batches x 2); one batch (2 new) is well within.
  const within = assertListingHealthV3ExportCeiling({ region: "us-ca", plans: p });
  ok("I: a plan within the region ceiling passes and reports the new-export count", within.withinCeiling === true && within.newExports === 2 && within.ceiling === LISTING_HEALTH_V3_REGION_EXPORT_CEILING["us-ca"]);
  // Fail closed: an artificially tightened ceiling below the planned count refuses to create.
  throwsSync("I: a planned count above the ceiling FAILS CLOSED before any create", () => assertListingHealthV3ExportCeiling({ region: "us-ca", plans: p, ceiling: 1 }));
  throwsSync("I: an unknown region (no reviewed ceiling) FAILS CLOSED", () => assertListingHealthV3ExportCeiling({ region: "atlantis", plans: p }));
  ok("I: the reviewed baseline ceilings are India 4 / Europe-AU 8 / US-CA 4 (2 x regional batch count)",
    LISTING_HEALTH_V3_REGION_EXPORT_CEILING.india === 4 && LISTING_HEALTH_V3_REGION_EXPORT_CEILING["europe-au"] === 8 && LISTING_HEALTH_V3_REGION_EXPORT_CEILING["us-ca"] === 4);

  // ---- COMPUTED ceiling (the fix): scales with the frozen plan's account membership; no fixed 4/8/4. ----
  // A v3 plan with N batches -> 2 distinct new export hashes per batch (listings + listings-raw).
  const planBatches = (n) => Array.from({ length: n }, (_, b) => ({
    reportKey: "listing-health-v3",
    sources: [
      { requestKey: "listing-health-v3:listings", requestHash: "L" + b },
      { requestKey: "listing-health-v3:listings-raw", requestHash: "R" + b },
      { requestKey: "listing-health-v3:inventory", requestHash: "I" + b },
    ],
  }));
  ok("I(computed): expectedListingHealthV3NewExports scales as 2 x ceil(accounts/5); null/invalid -> null",
    expectedListingHealthV3NewExports(5) === 2 && expectedListingHealthV3NewExports(12) === 6
    && expectedListingHealthV3NewExports(35) === 14 && expectedListingHealthV3NewExports(0) === 0
    && expectedListingHealthV3NewExports(null) === null && expectedListingHealthV3NewExports(-1) === null);
  // Europe grew past the old fixed ceiling 8: 35 accounts -> 7 batches -> 14 exports now PASSES (was hard-fail).
  const eu = assertListingHealthV3ExportCeiling({ region: "europe-au", plans: planBatches(7), accountCount: 35 });
  ok("I(computed): Europe 35 accounts -> 14 exports is WITHIN the computed ceiling 14 (was fail-closed against the fixed 8)",
    eu.withinCeiling === true && eu.newExports === 14 && eu.ceiling === 14 && eu.computedFromAccounts === true);
  // US-CA grew past the old fixed ceiling 4: 12 accounts -> 3 batches -> 6 exports now PASSES.
  const usca = assertListingHealthV3ExportCeiling({ region: "us-ca", plans: planBatches(3), accountCount: 12 });
  ok("I(computed): US-CA 12 accounts -> 6 exports is WITHIN the computed ceiling 6 (was fail-closed against the fixed 4)",
    usca.withinCeiling === true && usca.newExports === 6 && usca.ceiling === 6);
  // DRIFT still fails closed: a plan fanning out MORE creates than the membership justifies is refused.
  throwsSync("I(computed): a plan with 14 exports for only 5 eligible accounts (expected 2) FAILS CLOSED as drift",
    () => assertListingHealthV3ExportCeiling({ region: "europe-au", plans: planBatches(7), accountCount: 5 }));
  // An explicit ceiling still overrides (reviewed test path).
  throwsSync("I(computed): an explicit ceiling override still wins and can fail closed",
    () => assertListingHealthV3ExportCeiling({ region: "us-ca", plans: planBatches(3), accountCount: 12, ceiling: 1 }));
  // Backward-compat: no accountCount + no ceiling falls back to the deprecated region map (never a 0-ceiling).
  const legacy = assertListingHealthV3ExportCeiling({ region: "us-ca", plans: planBatches(1) });
  ok("I(computed): with no accountCount and no explicit ceiling it falls back to the region map (not a 0 ceiling)",
    legacy.ceiling === LISTING_HEALTH_V3_REGION_EXPORT_CEILING["us-ca"] && legacy.computedFromAccounts === false);
})();

/* ===================== J. safe-closed scheduler wiring (present, but nothing can dispatch v3) ===================== */
(() => {
  // v3 is DELIBERATELY absent from the LIVE-publish control plane, so the reviewed 13-report cutover gate is intact
  // and v3 has no live snapshot contract (it can never be published live).
  ok("J: listing-health-v3 is NOT in CONTROLLED_REPORT_KEYS (never listed by the control plane)", !CONTROLLED_REPORT_KEYS.includes("listing-health-v3"));
  ok("J: listing-health-v3 is NOT in SCHEDULER_V2_READY_REPORT_KEYS (no live-dispatch readiness, no live snapshot contract)", !SCHEDULER_V2_READY_REPORT_KEYS.includes("listing-health-v3"));

  // Even with EVERY durable control enabled, the scheduler-v2 catalog never lists v3 -> a scheduled run selects zero v3.
  const allEnabled = CONTROLLED_REPORT_KEYS.map((k) => ({ report_key: k, schedule_enabled: true }));
  const catalog = schedulerV2ReportControlCatalog(allEnabled);
  ok("J: the scheduler-v2 control catalog never contains v3", !catalog.some((c) => c.reportKey === "listing-health-v3"));
  const scheduled = selectSchedulerV2ReportKeys({ settings: allEnabled });
  ok("J: a scheduled run (all controls enabled) selects ZERO v3 work", !scheduled.requested.includes("listing-health-v3"));
  // Even a MANUAL request for v3 is locked out (never runtime-ready) -> zero dispatch.
  const manual = selectSchedulerV2ReportKeys({ manualReportKeys: ["listing-health-v3"], settings: allEnabled });
  ok("J: a manual v3 request is NOT runtime-ready (locked out at the readiness gate -> zero exports)", !manual.readySet.has("listing-health-v3"));

  // The default (scheduled) shadow plan is byte-identical -- it never plans v3.
  const defaultPlan = buildShadowReportPlan({ accounts: usAccounts, connections, asOfFor: () => asOf, inventoryAsOf: inv });
  ok("J: the DEFAULT buildShadowReportPlan never plans v3 (default set unchanged)", !defaultPlan.reportRequests.some((r) => r.reportKey === "listing-health-v3"));
  ok("J: v3 stays out of SHADOW_PLANNED_REPORT_KEYS (the default set)", !SHADOW_PLANNED_REPORT_KEYS.includes("listing-health-v3"));
  ok("J: v3 IS a dedicated batched shadow key (explicit-request only)", DEDICATED_BATCHED_SHADOW_REPORT_KEYS.includes("listing-health-v3"));

  // A DEDICATED operator CAN plan v3 by explicit request (the Phase-4B ingestion seam) -- batched, per-account owners.
  const v3Plan = buildShadowReportPlan({ accounts: usAccounts, reportKeys: ["listing-health-v3"], connections, asOfFor: () => asOf, inventoryAsOf: inv });
  const v3Requests = v3Plan.reportRequests.filter((r) => r.reportKey === "listing-health-v3");
  ok("J: an explicit reportKeys:['listing-health-v3'] plans one batched request per account with owner metadata", v3Requests.length === 5 && v3Requests.every((r) => r.owner && r.owner.rawSellerId && r.sources.length === 3));
  ok("J: the explicit v3 plan matches the direct batched planner (same source hashes)",
    JSON.stringify(v3Requests.map((r) => r.sources.map((s) => s.requestHash)).flat().sort())
    === JSON.stringify(plans().map((r) => r.sources.map((s) => s.requestHash)).flat().sort()));

  // classify: v3 is not a live-dispatch route (stays out of the generic/staged sets), so the live dispatcher would
  // never route it even if it were somehow selected (it cannot be).
  ok("J: classifySchedulerV2ReportKey(v3) is 'unsupported' for the LIVE dispatcher (never selectable there)", classifySchedulerV2ReportKey("listing-health-v3") === "unsupported");
})();

/* ===================== K. newer-only alias overwrite (late/older + replay never replace newer data) ===================== */
await (async () => {
  const cache = makeCache();
  const p = plans();
  const NEWER = "2026-09-04T06:00:00.000Z";
  const OLDER = "2026-09-03T06:00:00.000Z";
  const seedWithFetchedAt = (fetchedAt, listings) => {
    const seen = new Set();
    for (const src of p[0].sources) {
      if (seen.has(src.requestHash)) continue; seen.add(src.requestHash);
      const rows = src.requestKey === "listing-health-v3:listings" ? listings : (src.requestKey === "listing-health-v3:listings-raw" ? rawBatch : inventoryBatch);
      cache.map.set(src.requestHash, { rows: [...rows], fetched_at: fetchedAt, expires_at: "2999-01-01T00:00:00.000Z", source_id: src.sourceId, organization_fingerprint: src.organizationFingerprint, account_scope_hash: src.accountScopeHash });
    }
  };
  const h02 = listingHealthV3PerAccountReadHashes({ apiKey: API_KEY, rawSellerId: "acct-02", marketplaceCountry: "US" })["listing-health-v3:listings"];

  // 1) NEWER cycle writes acct-02 = [S02a, S02b].
  seedWithFetchedAt(NEWER, listingsBatch);
  await materializeListingHealthV3PerAccount({ plans: p, connections, readSourceCache: cache.readSourceCache, writeSourceCache: cache.writeSourceCache, readAliasMeta: cache.readAliasMeta });
  ok("K: the newer batch materialized acct-02's alias (2 rows)", (await cache.getSavedSourceRows(h02)).length === 2);

  // 2) A LATE, OLDER batch (different content) must NOT overwrite the newer alias.
  seedWithFetchedAt(OLDER, [listingRow("acct-02", "US", "OLD-ONLY")]);
  const late = await materializeListingHealthV3PerAccount({ plans: p, connections, readSourceCache: cache.readSourceCache, writeSourceCache: cache.writeSourceCache, readAliasMeta: cache.readAliasMeta });
  const afterLate = await cache.getSavedSourceRows(h02);
  ok("K: a late OLDER completion is skipped (skippedStale) and never replaces newer alias data", late.skippedStale >= 1 && afterLate.length === 2 && !afterLate.some((r) => r.sku === "OLD-ONLY"));

  // 3) Same-cycle REPLAY (same NEWER batch) writes nothing new (idempotent, no duplication).
  seedWithFetchedAt(NEWER, listingsBatch);
  const replay = await materializeListingHealthV3PerAccount({ plans: p, connections, readSourceCache: cache.readSourceCache, writeSourceCache: cache.writeSourceCache, readAliasMeta: cache.readAliasMeta });
  ok("K: a same-cycle replay (equal freshness) is skipped -- idempotent, no overwrite", replay.skippedStale >= 1 && (await cache.getSavedSourceRows(h02)).length === 2);

  // 4) A genuinely NEWER cycle DOES overwrite.
  seedWithFetchedAt("2026-09-05T06:00:00.000Z", [listingRow("acct-02", "US", "S02-NEXT")]);
  await materializeListingHealthV3PerAccount({ plans: p, connections, readSourceCache: cache.readSourceCache, writeSourceCache: cache.writeSourceCache, readAliasMeta: cache.readAliasMeta });
  const afterNext = await cache.getSavedSourceRows(h02);
  ok("K: a strictly newer batch DOES overwrite the alias", afterNext.length === 1 && afterNext[0].sku === "S02-NEXT");
})();

writeSync(1, `\nreport-listing-health-v3-materialize: ${passed} assertions passed\n`);
