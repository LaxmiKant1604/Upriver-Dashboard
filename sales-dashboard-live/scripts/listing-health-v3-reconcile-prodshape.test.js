// WORK C/D prod-shape -- the REAL buildListingHealthV3Release over an injected shared resolveBundle + the REAL
// deriveReportSnapshot. Proves: the release recomputes the COMPLETE dependency bundle, requires its fingerprint ===
// the supplied revisionId BEFORE opening a cycle AND rechecks immediately before the first write (TOCTOU -- a manifest
// advance during derive DEFERS with zero writes), derives from the exact resolved bundle via the canonical
// deriveReportSnapshot, records durable_content_deps = the single manifest token, and publishes/reads back ONLY
// listing-health-v3 (zero sibling writes). Also: bundle-ineligible defer, abort, report-disabled hardFail. Offline.
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
process.env.POSTGRES_URL = "postgres://user:pass@localhost:5432/db";

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { buildListingHealthV3Release } from "../lib/server/sync/listing-health-v3-release.js";
import { deriveReportSnapshot, REPORT_DERIVATIONS } from "../lib/server/sync/report-derivation.js";
import { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } from "../lib/server/sync/report-publisher.js";
import { paramsHashFor } from "../lib/server/report-store.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "listing-health-v3-reconcile-prodshape\n");

const ORG = "org-1", ACCT = "acct-00", SELLER = "SELLER-RAW-1", ASOF = "2026-09-04";
const REVID = "abcdef0123456789abcdef0123456789".slice(0, 32);
const MANIFEST_TOKEN = "listing-health-v3-manifest|" + ORG + "|primary|" + ACCT + "|" + ASOF + "|" + REVID;

// Canonical LHv3 row fixtures (same shapes as report-listing-health-v3-integration.test.js) so the REAL derive passes.
const invRow = (date, seller, mkt, sku, available) => ({ date, seller_or_vendor_id: seller, marketplace_country_code: mkt, child_asin: `ASIN-${sku}`, sku, available });
const listingRow = (seller, mkt, sku, o = {}) => ({ seller_or_vendor_id: seller, marketplace_country_code: mkt, sku, child_asin: `ASIN-${sku}`, listing_name: o.name ?? `L ${sku}`, listing_status: o.status ?? "Active", listing_price_value: o.price === undefined ? 9 : o.price, listing_price_currency: o.currency ?? "USD", listing_current_quantity: o.qty ?? 0, fba_quantity_available: o.fba ?? 0, listing_fulfillment_channel: o.channel ?? "AMAZON_NA", listing_open_date: o.open ?? "2024-01-01" });
const oliRow = (date, sku, sales, units) => ({ account_id: ACCT, seller_or_vendor_id: SELLER, sale_date: date, sku, child_asin: `ASIN-${sku}`, currency: "USD", sales_amount: sales, ordered_units: units, unpriced_units: 0 });
const catRow = (sku, brand) => ({ child_asin: `ASIN-${sku}`, product_name: `P ${sku}`, product_brand: brand });
const listingsRows = [listingRow(SELLER, "US", "A", { status: "Active", price: 25, fba: 30 }), listingRow(SELLER, "US", "B", { status: "Inactive", price: 0, qty: 7 })];
const rawRows = [{ seller_or_vendor_id: SELLER, marketplace_country_code: "US", sku: "A", child_asin: "ASIN-A", summaries: JSON.stringify({ status: ["BUYABLE"] }), issues: JSON.stringify([]), offers: JSON.stringify([{ price: { amount: 25 } }]) }];
const invRows = [invRow(ASOF, SELLER, "US", "A", 30)];

function makeBundle() {
  return {
    eligible: true, status: "available", revisionId: REVID, deps: [], contentDeps: [MANIFEST_TOKEN],
    bundle: {
      listingsRows, rawRows,
      inventorySource: { available: true, rows: invRows, fragments: [{ requestKey: "listing-health-v3:inventory", from: ASOF, to: ASOF, sellerOrVendorIds: [SELLER], rows: invRows }], disabled: false, disabledPolicy: null, reason: null },
      context: { to: ASOF, inventoryAsOf: ASOF, accountId: ACCT, rawSellerId: SELLER, listingHealthV3DurableOli: { available: true, rows: [oliRow("2026-09-01", "A", 100, 10), oliRow("2026-08-20", "A", 50, 5)], coverageWindows: [{ from: "2024-01-01", to: ASOF }], completenessRows: [] }, listingHealthV3DurableCatalog: { available: true, rows: [catRow("A", "BrandX"), catRow("B", "BrandY")], payloadSha: "sha-cat" } },
      listingsSnapshot: { source_request_hash: "rh-l", payload_sha: "sha-l" }, rawSnapshot: { source_request_hash: "rh-r", payload_sha: "sha-r" }, inventorySnapshot: { source_request_hash: "rh-inv", payload_sha: "sha-i" },
    },
  };
}

function harness(cfg = {}) {
  const calls = { publish: [], preflight: [], readback: [], saveShadow: [], upsertJob: [], reconcile: [], claim: [], finalize: 0, openCycle: 0, derive: 0, resolveBundle: 0 };
  // resolveBundle returns per-call results (cfg.bundles is an array indexed by call #, else makeBundle each call).
  const resolveBundle = async () => {
    calls.resolveBundle += 1;
    const seq = cfg.bundles;
    return seq ? seq[Math.min(calls.resolveBundle - 1, seq.length - 1)] : makeBundle();
  };
  const release = buildListingHealthV3Release({
    resolveBundle,
    openCycle: async () => { calls.openCycle += 1; },
    getCycleByBucketDate: async () => ({ id: "cyc-1", status: "running", created_at: "2026-09-04T07:00:00.000Z" }),
    claimCycle: async () => true, // claim_sync_cycle: pending -> running (won the transition)
    deriveSnapshot: (args) => { calls.derive += 1; return (cfg.deriveSnapshot || deriveReportSnapshot)(args); },
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
      publish: async (rk) => { calls.publish.push(rk); return (cfg.publish || (() => ({ disposition: "published", liveReportKey: "listing-health-v3", paramsHash: "live-ph" })))(rk); },
    },
    readbackLive: async ({ reportKey, liveReportKey }) => { calls.readback.push({ reportKey, liveReportKey }); return { ok: true }; },
    verifyLease: async () => ({ ok: true }),
    log: () => {},
  });
  return { release, calls };
}
const run = (h, over = {}) => h.release.runForAccount({ accountId: ACCT, requestedAsOf: ASOF, cycleBucket: "priority-partial-us-ca-abc", revisionId: REVID, signal: null, ...over });

// ---- (1) HAPPY PATH: bundle eligible + fingerprint === revisionId -> REAL derive -> publish/readback ONLY LHv3 ----
{
  const h = harness();
  const res = await run(h);
  ok("happy path: returns ok (code 0)", res && res.code === 0 && res.ok === true);
  ok("the release RESOLVED the bundle at least twice (entry + before-write TOCTOU recheck)", h.calls.resolveBundle >= 2);
  ok("the REAL deriveReportSnapshot ran (derived + validated payload)", h.calls.derive === 1);
  ok("the shadow is saved under scheduler-v2/listing-health-v3 with reportVersion === snapshotVersion", h.calls.saveShadow.length === 1 && h.calls.saveShadow[0].reportKey === "scheduler-v2/listing-health-v3" && h.calls.saveShadow[0].params.reportVersion === REPORT_DERIVATIONS["listing-health-v3"].snapshotVersion);
  const job = h.calls.upsertJob[0];
  ok("durable_content_deps === the SINGLE manifest token the revision emits (revisionCoveredByJob converges)", job.durableContentDeps.length === 1 && job.durableContentDeps[0] === MANIFEST_TOKEN);
  ok("depends_on carries the owned durable request hashes (listings + raw + inventory)", ["rh-l", "rh-r", "rh-inv"].every((x) => job.dependsOn.includes(x)));
}

// ---- (2) SIBLING ISOLATION: only listing-health-v3 is touched ----
{
  const h = harness();
  await run(h);
  const onlyLive = (arr) => arr.length > 0 && arr.every((k) => k === "listing-health-v3");
  ok("publisher.preflight/publish + reconcile + claim touch ONLY listing-health-v3", onlyLive(h.calls.preflight) && onlyLive(h.calls.publish) && onlyLive(h.calls.reconcile) && onlyLive(h.calls.claim));
  ok("readback reads back ONLY listing-health-v3", h.calls.readback.length === 1 && h.calls.readback[0].reportKey === "listing-health-v3" && h.calls.readback[0].liveReportKey === "listing-health-v3");
  ok("the ONLY shadow write is the listing-health-v3 shadow", h.calls.saveShadow.every((s) => s.reportKey === "scheduler-v2/listing-health-v3"));
}

// ---- (3) TOCTOU at ENTRY: bundle fingerprint != supplied revisionId -> defer, ZERO writes, no derive ----
{
  const advanced = { ...makeBundle(), revisionId: "ffffffffffffffffffffffffffffffff".slice(0, 32) };
  const h = harness({ bundles: [advanced] });
  const res = await run(h);
  ok("entry mismatch -> defer('revision-advanced-at-entry'), zero cycle/derive/publish/shadow writes", res.ok === false && res.stage === "reconcile" && /revision-advanced-at-entry/.test(res.reason) && h.calls.derive === 0 && h.calls.openCycle === 0 && h.calls.publish.length === 0 && h.calls.saveShadow.length === 0);
}

// ---- (4) TOCTOU BEFORE WRITE: matches at entry, DIFFERS on the recheck (advanced during derive) -> defer, no writes ----
{
  const advanced = { ...makeBundle(), revisionId: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee".slice(0, 32) };
  const h = harness({ bundles: [makeBundle(), advanced] }); // call#1 matches, call#2 (recheck) differs
  const res = await run(h);
  ok("recheck mismatch -> defer('revision-advanced-before-write') AFTER derive but with ZERO cycle/publish/shadow writes", res.ok === false && res.stage === "reconcile" && /revision-advanced-before-write/.test(res.reason) && h.calls.derive === 1 && h.calls.openCycle === 0 && h.calls.publish.length === 0 && h.calls.saveShadow.length === 0);
}

// ---- (5) bundle NOT eligible -> defer, zero writes ----
{
  const h = harness({ bundles: [{ eligible: false, reason: "cross-account", status: "missing", revisionId: null, deps: [], contentDeps: [] }] });
  const res = await run(h);
  ok("bundle not eligible -> defer, zero writes", res.ok === false && res.stage === "reconcile" && /bundle-cross-account/.test(res.reason) && h.calls.openCycle === 0 && h.calls.publish.length === 0);
}

// ---- (6) ABORT before start -> DEADLINE, zero writes ----
{
  const h = harness();
  const ac = new AbortController(); ac.abort();
  const res = await run(h, { signal: ac.signal });
  ok("aborted -> DEADLINE_ABORTED, zero writes", res.status === "DEADLINE_ABORTED" && h.calls.openCycle === 0 && h.calls.publish.length === 0 && h.calls.saveShadow.length === 0);
}

// ---- (7) report-disabled publish (promoted control OFF, pre-activation) -> hard FAILED_PUBLISH ----
{
  const h = harness({ publish: () => ({ disposition: "report-disabled" }) });
  const res = await run(h);
  ok("publish report-disabled -> hard FAILED_PUBLISH (stage 'publish'), never green", res.ok === false && res.stage === "publish");
}

writeSync(1, `\nlisting-health-v3-reconcile-prodshape: ${passed} assertions passed\n`);
