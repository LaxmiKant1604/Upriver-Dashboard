// WORK C prod-shape -- the REAL buildListingHealthV3Release driven over injected durable doubles + the REAL canonical
// deriveReportSnapshot. Proves: the release hand-builds the EXACT sources+context the canonical listing-health-v3
// derive+validator accept (correct no-date listings/raw fragments + the single-day inventory fragment); it re-derives
// through deriveReportSnapshot and publishes/reads back ONLY listing-health-v3 (ZERO sibling writes); it defers (LKG,
// zero writes) on a missing/older/future pointer, a missing durable OLI/Catalog, and on abort; inventory is OPTIONAL
// (absent/older => inventory.available:false, still derives+publishes); and the report job's lineage records the exact
// content tokens the revision emits. Offline; every side effect is an injected spy. 7-bit ASCII, LF.
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
process.env.POSTGRES_URL = "postgres://user:pass@localhost:5432/db";

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { buildListingHealthV3Release } from "../lib/server/sync/listing-health-v3-release.js";
import { deriveReportSnapshot, REPORT_DERIVATIONS } from "../lib/server/sync/report-derivation.js";
import { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } from "../lib/server/sync/report-publisher.js";
import { paramsHashFor } from "../lib/server/report-store.js";
import { listingsContentProvenanceToken, listingsRawContentProvenanceToken } from "../lib/server/sync/listings-revision.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "listing-health-v3-reconcile-prodshape\n");

const ORG = "org-1";
const ACCT = "acct-00";
const SELLER = "SELLER-RAW-1";
const ASOF = "2026-09-04";

// ---- Canonical LHv3 row fixtures (same shapes as report-listing-health-v3-integration.test.js) ----
const invRow = (date, seller, mkt, sku, available) => ({ date, seller_or_vendor_id: seller, marketplace_country_code: mkt, child_asin: `ASIN-${sku}`, sku, available });
const listingRow = (seller, mkt, sku, o = {}) => ({ seller_or_vendor_id: seller, marketplace_country_code: mkt, sku, child_asin: `ASIN-${sku}`, listing_name: o.name ?? `L ${sku}`, listing_status: o.status ?? "Active", listing_price_value: o.price === undefined ? 9 : o.price, listing_price_currency: o.currency ?? "USD", listing_current_quantity: o.qty ?? 0, fba_quantity_available: o.fba ?? 0, listing_fulfillment_channel: o.channel ?? "AMAZON_NA", listing_open_date: o.open ?? "2024-01-01" });
const oliRow = (date, sku, sales, units) => ({ account_id: ACCT, seller_or_vendor_id: SELLER, sale_date: date, sku, child_asin: `ASIN-${sku}`, currency: "USD", sales_amount: sales, ordered_units: units, unpriced_units: 0 });
const catRow = (sku, brand) => ({ child_asin: `ASIN-${sku}`, product_name: `P ${sku}`, product_brand: brand });
const baseListings = [listingRow(SELLER, "US", "A", { status: "Active", price: 25, fba: 30, channel: "AMAZON_NA" }), listingRow(SELLER, "US", "B", { status: "Inactive", price: 0, qty: 7, channel: "DEFAULT" })];
const baseRaw = [{ seller_or_vendor_id: SELLER, marketplace_country_code: "US", sku: "A", child_asin: "ASIN-A", summaries: JSON.stringify({ status: ["BUYABLE", "DISCOVERABLE"] }), issues: JSON.stringify([]), offers: JSON.stringify([{ price: { amount: 25 } }]) }];
const baseInv = [invRow(ASOF, SELLER, "US", "A", 30)];
const baseCat = [catRow("A", "BrandX"), catRow("B", "BrandY")];
const baseOli = [oliRow("2026-09-01", "A", 100, 10), oliRow("2026-08-20", "A", 50, 5), oliRow("2026-09-02", "B", 200, 20)];
const durableCtx = () => ({
  listingHealthV3DurableOli: { available: true, rows: baseOli, coverageWindows: [{ from: "2024-01-01", to: ASOF }], completenessRows: [] },
  listingHealthV3DurableCatalog: { available: true, rows: baseCat },
});

// A durable pointer row (snake_case, exactly as getSourceListingsSnapshot / getSourceSnapshot project it).
const listingsPtr = (o = {}) => ({ account_id: ACCT, marketplace: "US", as_of: o.as_of ?? ASOF, object_path: o.object_path ?? "obj/listings.json", payload_sha: o.payload_sha ?? "sha-l", row_count: o.row_count ?? 2, source_request_hash: o.source_request_hash ?? "rh-l", validated_at: "2026-09-04T06:00:00.000Z" });
const rawPtr = (o = {}) => ({ account_id: ACCT, marketplace: "US", as_of: o.as_of ?? ASOF, object_path: o.object_path ?? "obj/raw.json", payload_sha: o.payload_sha ?? "sha-r", row_count: o.row_count ?? 1, source_request_hash: o.source_request_hash ?? "rh-r", validated_at: "2026-09-04T06:00:00.000Z" });
const invPtr = (o = {}) => ({ scope_key: ACCT, object_path: o.object_path ?? "obj/inv.json", payload_sha: "sha-i", row_count: 1, source_request_hash: o.source_request_hash ?? "rh-inv-expected", validated_at: "2026-09-04T06:00:00.000Z" });

const EXPECTED_INV_HASH = "rh-inv-expected";

// Build a release + a call-recording harness. `cfg` overrides individual collaborators/behaviors.
function harness(cfg = {}) {
  const calls = { publish: [], preflight: [], readback: [], saveShadow: [], upsertJob: [], reconcile: [], claim: [], finalize: 0, openCycle: 0, derive: [] };
  const payloadByPath = { "obj/listings.json": { rows: baseListings }, "obj/raw.json": { rows: baseRaw }, "obj/inv.json": { rows: baseInv }, ...(cfg.payloadByPath || {}) };
  const release = buildListingHealthV3Release({
    resolveOrg: async () => ({ organizationFingerprint: ORG, connectionId: "primary" }),
    openCycle: async () => { calls.openCycle += 1; },
    getCycleByBucketDate: async () => ({ id: "cyc-1", created_at: "2026-09-04T07:00:00.000Z" }),
    readListingsSnapshot: cfg.readListingsSnapshot || (async () => ({ read: "ok", snapshot: listingsPtr() })),
    readListingsRawSnapshot: cfg.readListingsRawSnapshot || (async () => ({ read: "ok", snapshot: rawPtr() })),
    readInventorySnapshot: cfg.readInventorySnapshot || (async () => ({ read: "ok", snapshot: invPtr() })),
    loadSnapshotPayload: async (path) => { const p = payloadByPath[path]; if (p === undefined) throw new Error("no payload for " + path); return p; },
    resolveExpectedInventoryRequestHash: cfg.resolveExpectedInventoryRequestHash || (async () => EXPECTED_INV_HASH),
    resolveAccountRawSellerId: async () => SELLER,
    loadDurableContext: cfg.loadDurableContext || (async () => durableCtx()),
    deriveSnapshot: (args) => { calls.derive.push(args); return (cfg.deriveSnapshot || deriveReportSnapshot)(args); },
    reportDerivations: REPORT_DERIVATIONS,
    computeHash: paramsHashFor,
    liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS,
    upsertReportJob: async (job) => { calls.upsertJob.push(job); },
    claimLease: async (cycleId, reportKey) => { calls.claim.push(reportKey); return { disposition: "claimed", leaseToken: "lt" }; },
    saveShadow: async (args) => { calls.saveShadow.push(args); return { outcome: "inserted" }; },
    reconcileSuccess: async (args) => { calls.reconcile.push(args.reportKey); return { disposition: "reconciled" }; },
    finalizeCycle: async () => { calls.finalize += 1; return { disposition: "finalized" }; },
    publisher: {
      preflight: async (rk) => { calls.preflight.push(rk); return { disposition: "ready" }; },
      publish: async (rk) => { calls.publish.push(rk); return { disposition: "published", liveReportKey: "listing-health-v3", paramsHash: "live-ph" }; },
    },
    readbackLive: async ({ reportKey, liveReportKey }) => { calls.readback.push({ reportKey, liveReportKey }); return { ok: true }; },
    verifyLease: async () => ({ ok: true }),
    log: () => {},
  });
  return { release, calls };
}
const run = (h, over = {}) => h.release.runForAccount({ accountId: ACCT, requestedAsOf: ASOF, cycleBucket: "priority-partial-us-ca-abc", signal: null, ...over });

// ---- (1) HAPPY PATH: REAL derive -> validated -> publish + readback ONLY listing-health-v3 ----
{
  const h = harness();
  const res = await run(h);
  ok("happy path: the release returns ok (code 0)", res && res.code === 0 && res.ok === true);
  ok("the REAL deriveReportSnapshot ran for reportKey listing-health-v3", h.calls.derive.length === 1 && h.calls.derive[0].reportKey === "listing-health-v3");
  const d = h.calls.derive[0];
  const ls = d.sources["listing-health-v3:listings"];
  const rs = d.sources["listing-health-v3:listings-raw"];
  const is = d.sources["listing-health-v3:inventory"];
  ok("sources.listings is a single owner no-date fragment {from:null,to:null,sellerOrVendorIds:[SELLER]}", ls.available === true && ls.fragments.length === 1 && ls.fragments[0].from === null && ls.fragments[0].to === null && ls.fragments[0].sellerOrVendorIds.length === 1 && ls.fragments[0].sellerOrVendorIds[0] === SELLER && ls.rows === ls.fragments[0].rows);
  ok("sources.listings-raw is a single owner no-date fragment", rs.available === true && rs.fragments[0].from === null && rs.fragments[0].to === null && rs.fragments[0].sellerOrVendorIds[0] === SELLER);
  ok("sources.inventory is the single-day fragment {from:reqAsOf,to:reqAsOf,sellerOrVendorIds:[SELLER]}", is.available === true && is.fragments[0].from === ASOF && is.fragments[0].to === ASOF && is.fragments[0].sellerOrVendorIds[0] === SELLER);
  ok("context carries to/inventoryAsOf=reqAsOf, accountId(public), rawSellerId, and the loader's durable OLI+catalog", d.context.to === ASOF && d.context.inventoryAsOf === ASOF && d.context.accountId === ACCT && d.context.rawSellerId === SELLER && d.context.listingHealthV3DurableOli.available === true && d.context.listingHealthV3DurableCatalog.available === true);
  ok("the shadow is saved under scheduler-v2/listing-health-v3 with reportVersion === the shadow snapshotVersion", h.calls.saveShadow.length === 1 && h.calls.saveShadow[0].reportKey === "scheduler-v2/listing-health-v3" && h.calls.saveShadow[0].params.reportVersion === REPORT_DERIVATIONS["listing-health-v3"].snapshotVersion);
  // Lineage: durable_content_deps === the two Listings tokens the revision emits (revisionCoveredByJob will match).
  const job = h.calls.upsertJob[0];
  ok("upsertReportJob durableContentDeps === [listingsToken, listingsRawToken] (matches the revision exactly)",
    job.durableContentDeps.length === 2
    && job.durableContentDeps[0] === listingsContentProvenanceToken({ accountId: ACCT, connectionId: "primary", asOf: ASOF, requestHash: "rh-l", contentSha: "sha-l" })
    && job.durableContentDeps[1] === listingsRawContentProvenanceToken({ accountId: ACCT, connectionId: "primary", asOf: ASOF, requestHash: "rh-r", contentSha: "sha-r" }));
  ok("upsertReportJob dependsOn carries the owned durable source request hashes (listings + raw + inventory)", ["rh-l", "rh-r", EXPECTED_INV_HASH].every((h2) => job.dependsOn.includes(h2)));
}

// ---- (2) SIBLING ISOLATION: every publisher/readback/reconcile/claim touch is listing-health-v3 ONLY ----
{
  const h = harness();
  await run(h);
  const onlyLive = (arr) => arr.length > 0 && arr.every((k) => k === "listing-health-v3");
  ok("publisher.preflight touched ONLY listing-health-v3", onlyLive(h.calls.preflight));
  ok("publisher.publish touched ONLY listing-health-v3", onlyLive(h.calls.publish));
  ok("reconcileSuccess touched ONLY listing-health-v3", onlyLive(h.calls.reconcile));
  ok("claimLease touched ONLY listing-health-v3", onlyLive(h.calls.claim));
  ok("readbackLive read back ONLY listing-health-v3 (report + live key)", h.calls.readback.length === 1 && h.calls.readback[0].reportKey === "listing-health-v3" && h.calls.readback[0].liveReportKey === "listing-health-v3");
  ok("the ONLY shadow write is the listing-health-v3 shadow (no sibling shadow)", h.calls.saveShadow.length === 1 && h.calls.saveShadow.every((s) => s.reportKey === "scheduler-v2/listing-health-v3"));
}

// ---- (3) DEFER ladder: LKG preserved, ZERO cycle/publish writes ----
async function deferCase(name, cfg) {
  const h = harness(cfg);
  const res = await run(h);
  ok(name, res.ok === false && res.stage === "reconcile" && h.calls.openCycle === 0 && h.calls.publish.length === 0 && h.calls.saveShadow.length === 0);
}
await deferCase("defer: listings pointer absent => no cycle/publish", { readListingsSnapshot: async () => ({ read: "ok", snapshot: null }) });
await deferCase("defer: listings pointer schema-missing => no cycle/publish", { readListingsSnapshot: async () => ({ read: "schema-missing", snapshot: null }) });
await deferCase("defer: listings-raw pointer absent => no cycle/publish", { readListingsRawSnapshot: async () => ({ read: "ok", snapshot: null }) });
await deferCase("defer: listings OLDER as_of than requested => no cycle/publish", { readListingsSnapshot: async () => ({ read: "ok", snapshot: listingsPtr({ as_of: "2026-09-03" }) }) });
await deferCase("defer: raw FUTURE as_of than requested => no cycle/publish", { readListingsRawSnapshot: async () => ({ read: "ok", snapshot: rawPtr({ as_of: "2026-09-05" }) }) });
await deferCase("defer: durable context {} (missing OLI/Catalog) => derive unavailable => no publish", { loadDurableContext: async () => ({}) });

// ---- (4) INVENTORY OPTIONAL: absent / older-hash => inventory.available:false, STILL derives + publishes ----
{
  const h = harness({ resolveExpectedInventoryRequestHash: async () => "some-other-hash" }); // pointer hash won't match => not-D-1
  const res = await run(h);
  const is = h.calls.derive[0].sources["listing-health-v3:inventory"];
  ok("inventory NOT proven D-1 (hash mismatch) => sources.inventory available:false (never a throw/defer)", is.available === false);
  ok("with inventory unavailable the release STILL derives + publishes listing-health-v3", res.code === 0 && h.calls.publish.length === 1);
}
{
  const h = harness({ readInventorySnapshot: async () => ({ read: "schema-missing", snapshot: null }) });
  const res = await run(h);
  ok("inventory pointer schema-missing => inventory unavailable, release still publishes (FBA on-hand falls back)", h.calls.derive[0].sources["listing-health-v3:inventory"].available === false && res.code === 0 && h.calls.publish.length === 1);
}

// ---- (5) ABORT: an already-aborted signal => DEADLINE, ZERO writes ----
{
  const h = harness();
  const ac = new AbortController(); ac.abort();
  const res = await run(h, { signal: ac.signal });
  ok("aborted signal => DEADLINE_ABORTED, zero cycle/publish/shadow writes", res.status === "DEADLINE_ABORTED" && h.calls.openCycle === 0 && h.calls.publish.length === 0 && h.calls.saveShadow.length === 0);
}

// ---- (6) HARD publish failure (report-disabled / unknown-report) => FAILED_PUBLISH (matches FBA) ----
{
  // A release whose publisher returns report-disabled (the pre-activation state: the promoted control is OFF).
  const calls = { publish: [] };
  const rel = buildListingHealthV3Release({
    resolveOrg: async () => ({ organizationFingerprint: ORG, connectionId: "primary" }),
    openCycle: async () => {}, getCycleByBucketDate: async () => ({ id: "c", created_at: "2026-09-04T07:00:00.000Z" }),
    readListingsSnapshot: async () => ({ read: "ok", snapshot: listingsPtr() }),
    readListingsRawSnapshot: async () => ({ read: "ok", snapshot: rawPtr() }),
    readInventorySnapshot: async () => ({ read: "ok", snapshot: invPtr() }),
    loadSnapshotPayload: async (p) => ({ "obj/listings.json": { rows: baseListings }, "obj/raw.json": { rows: baseRaw }, "obj/inv.json": { rows: baseInv } }[p]),
    resolveExpectedInventoryRequestHash: async () => EXPECTED_INV_HASH, resolveAccountRawSellerId: async () => SELLER,
    loadDurableContext: async () => durableCtx(), deriveSnapshot: deriveReportSnapshot,
    reportDerivations: REPORT_DERIVATIONS, computeHash: paramsHashFor, liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS,
    upsertReportJob: async () => {}, claimLease: async () => ({ disposition: "claimed", leaseToken: "lt" }),
    saveShadow: async () => ({ outcome: "inserted" }), reconcileSuccess: async () => ({ disposition: "reconciled" }),
    finalizeCycle: async () => ({ disposition: "finalized" }),
    publisher: { preflight: async () => ({ disposition: "ready" }), publish: async (rk) => { calls.publish.push(rk); return { disposition: "report-disabled" }; } },
    readbackLive: async () => ({ ok: true }), verifyLease: async () => ({ ok: true }), log: () => {},
  });
  const res = await rel.runForAccount({ accountId: ACCT, requestedAsOf: ASOF, cycleBucket: "priority-partial-x", signal: null });
  ok("publish report-disabled (promoted control OFF, pre-activation) => hard FAILED_PUBLISH (stage 'publish'), never green", res.ok === false && res.stage === "publish");
}

writeSync(1, `\nlisting-health-v3-reconcile-prodshape: ${passed} assertions passed\n`);
