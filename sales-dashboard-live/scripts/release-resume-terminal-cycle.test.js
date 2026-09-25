// Publication-recovery WP2 -- the three EXISTING dedicated releases (listing-health-v3-release.js /
// fba-brand-inventory-release.js / daily-reporting-release.js) + the supabase.js lineage/prune additions. Proves:
//   A. CRASH AFTER FINALIZE, BEFORE PUBLISH: the retry (same revision -> same priority-partial bucket -> the cycle is
//      already TERMINAL) RESUMES at preflight -> verifyLease -> publish -> read-back with ZERO job/lease/shadow/finalize
//      writes -- never the 'cycle-not-running' TERMINAL_CYCLE strand -- for ALL THREE releases; and the CLI-identical
//      composition (NO injected reader -> the lazy default getLatestReportJobLineage over a stubbed PostgREST) through the
//      REAL FBA reconciler + REAL fenced publisher converges to READBACK_VERIFIED.
//   B. A terminal cycle whose latest job belongs to ANOTHER cycle, another revision (params hash / deps / content token),
//      is not promotable, unreadable, absent, or lacks a cycleId -- and any non-success terminal status -- defers
//      'cycle-not-running:<status>' BYTE-IDENTICALLY to today; a running cycle never consults the reader.
//   C. A publish 'newer-live' is {stage:'publish', status:'NEWER_LIVE', reason:'publish-newer-live'} -> the shared
//      statusFromRelease DEFERRED_DEPENDENCY (was a hard FAILED_PUBLISH); the strictly-newer live row is never touched.
//   D. getLatestReportJobLineage is ADDITIVE: every pre-WP2 field keeps its name, value and order; id / cycleId /
//      createdAt are appended (both the primary read and the schema-missing fallback).
//   E. deleteRouteShadowSnapshots refuses a non-allowlisted / live / scheduler-prefixed key and every malformed argument
//      with ZERO requests, and its ONE DELETE -- evaluated by a faithful PostgREST filter model -- never removes a row
//      without params.route or params.rev, a live (non scheduler-v2) row, another route/account/key, a kept hash, or a
//      row newer than the cutoff.
// Offline: a stubbed global fetch stands in for PostgREST (never the network); zero DataDoe. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";

// Credentials MUST be set before supabase.js is evaluated (it captures them at import) -> every lib import is dynamic.
process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";

// ---- the stubbed PostgREST (installed BEFORE any import can capture fetch; the real network is NEVER reached) ----
const net = { calls: [], unexpected: [], routes: [] };
const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  const method = String(opts.method || "GET").toUpperCase();
  net.calls.push({ method, path: u.pathname, params: u.searchParams, headers: opts.headers || {} });
  for (const route of net.routes) { const out = route(method, u, opts); if (out) return out; }
  net.unexpected.push(method + " " + u.pathname + u.search);
  return resp(400, { message: "unexpected request in an offline test", code: "TEST400" }); // 400: never retried
};

const { buildListingHealthV3Release } = await import("../lib/server/sync/listing-health-v3-release.js");
const { buildFbaBrandInventoryRelease } = await import("../lib/server/sync/fba-brand-inventory-release.js");
const { buildDailyReportingRelease } = await import("../lib/server/sync/daily-reporting-release.js");
const { statusFromRelease, diagStageFor, RECONCILE_STATUS } = await import("../lib/server/sync/saved-data-reconciler.js");
const { REPORT_DERIVATIONS } = await import("../lib/server/sync/report-derivation.js");
const { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } = await import("../lib/server/sync/report-publisher.js");
const { paramsHashFor } = await import("../lib/server/report-store.js");
const { fbaContentProvenanceToken } = await import("../lib/server/sync/fba-inventory-revision.js");
const { FBA_INVENTORY_SOURCE_KEY, oliBackfillWindow } = await import("../lib/server/sync/source-durable-model.js");
const { computeAdsReportRevision, subUtcDaysStr } = await import("../lib/server/sync/ads-publication-revision.js");
const { ADS_CAMPAIGN_SOURCE_KEY, adsRequiredCoverageDays } = await import("../lib/server/sync/ads-dependent-reports.js");
const { BRAND_INVENTORY_REPORT_VERSION } = await import("../lib/server/reports/brand-view.js");
const { FBA_RECONCILE_STATUS } = await import("../lib/server/sync/fba-publication-reconciler.js");
const fbaShape = await import("./fba-reconcile-prodshape.test.js"); // exported faithful FBA world + CLI-identical wiring
const sb = await import("../lib/server/supabase.js");

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const A = "A01";
const ASOF = "2026-09-10";
const BUCKET = "priority-partial-india-0123456789abcdef";
const S = (v) => (v == null ? "" : String(v));
// The EXACT pre-WP2 terminal-cycle deferral (the release's defer("cycle-not-running:<status>")).
const LEGACY_TERMINAL = (status) => ({ code: 1, ok: false, stage: "reconcile", status: "SOURCE_UNAVAILABLE", leaseLost: false, reason: "cycle-not-running:" + status, blockerCodes: [], problems: ["cycle-not-running:" + status] });
const NEWER_LIVE_RESULT = { code: 1, ok: false, stage: "publish", status: "NEWER_LIVE", leaseLost: false, reason: "publish-newer-live", blockerCodes: [], problems: ["publish-newer-live"] };

// ---------------------------------------------------------------------------------------------------------------------
// A faithful in-memory LINEAGE world shared by the three releases: sync_cycles (open=pending -> claim=running ->
// finalize=terminal), sync_report_jobs (insert-if-absent, lease, reconcile), report_snapshots (shadow CAS + live CAS),
// the lineage read in the EXACT getLatestReportJobLineage shape (incl. the WP2 id/cycleId/createdAt), and a GATE-7
// MODEL publisher (report-publisher.js: the LATEST job must be validated + succeeded in a TERMINAL cycle with a hash ->
// the EXACT shadow at that hash -> the freshness CAS on the live identity: newer-live / already-current / conflict).
// ---------------------------------------------------------------------------------------------------------------------
function makeLineageWorld() {
  const cycles = new Map(); const jobs = []; const snaps = new Map();
  const n = { open: 0, upsert: 0, claimLease: 0, shadow: 0, reconcile: 0, finalize: 0, preflight: 0, verifyLease: 0, publish: 0, liveWrites: 0, readLatest: 0, readback: {} };
  let seq = 0; let clock = Date.UTC(2026, 8, 10, 9, 0, 0);
  const cycleById = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  const jobOf = (cycleId, rk, a) => jobs.find((j) => j.cycle_id === cycleId && j.report_key === rk && j.account_id === a) || null;
  const w = { cycles, jobs, snaps, n, onBeforeLiveCas: null };
  w.openCycle = async ({ bucket, cycleDate }) => { n.open += 1; const k = bucket + "|" + cycleDate; if (!cycles.has(k)) cycles.set(k, { id: "cyc-" + (++seq), bucket, cycle_date: cycleDate, status: "pending", created_at: new Date(clock += 60000).toISOString() }); };
  w.getCycleByBucketDate = async (bucket, cycleDate) => { const c = cycles.get(bucket + "|" + cycleDate); return c ? { ...c } : null; };
  w.claimCycle = async (cycleId) => { const c = cycleById(cycleId); if (c && c.status === "pending") { c.status = "running"; return true; } return false; };
  w.upsertReportJob = async (job) => {
    n.upsert += 1;
    if (jobOf(job.cycleId, job.reportKey, job.accountId)) return;
    jobs.push({ id: "job-" + (++seq), cycle_id: job.cycleId, report_key: job.reportKey, account_id: job.accountId, depends_on: [...(job.dependsOn || [])], durable_content_deps: [...(job.durableContentDeps || [])], derive_status: "pending", save_status: "pending", validated: false, snapshot_params_hash: null, latest_data_date: null, created_at: ++seq });
  };
  w.claimLease = async (cycleId, rk, a) => {
    n.claimLease += 1;
    const j = jobOf(cycleId, rk, a);
    if (!j) return { disposition: "not-found", leaseToken: null, snapshotParamsHash: null };
    if (j.validated === true) return { disposition: "already-complete", leaseToken: null, snapshotParamsHash: j.snapshot_params_hash };
    j.derive_status = "running";
    return { disposition: "claimed", leaseToken: "lt-" + (++seq), snapshotParamsHash: null };
  };
  w.saveShadow = async ({ reportKey, accountId, paramsHash, params, payload, sourceRefreshedAt }) => {
    n.shadow += 1;
    const k = reportKey + "|" + accountId + "|" + paramsHash; const cur = snaps.get(k);
    if (cur && S(cur.source_refreshed_at) > S(sourceRefreshedAt)) return { outcome: "newer-live" };
    if (cur && S(cur.source_refreshed_at) === S(sourceRefreshedAt) && JSON.stringify(cur.payload) === JSON.stringify(payload)) return { outcome: "already-current" };
    snaps.set(k, { report_key: reportKey, account_id: accountId, params_hash: paramsHash, params, payload, source_refreshed_at: sourceRefreshedAt });
    return { outcome: cur ? "replaced" : "inserted" };
  };
  w.reconcileSuccess = async ({ cycleId, reportKey, accountId, snapshotParamsHash, latestDataDate }) => {
    n.reconcile += 1;
    const j = jobOf(cycleId, reportKey, accountId); if (!j) return { disposition: "not-found" };
    Object.assign(j, { validated: true, derive_status: "succeeded", save_status: "succeeded", snapshot_params_hash: snapshotParamsHash, latest_data_date: latestDataDate });
    return { disposition: "reconciled" };
  };
  w.finalizeCycle = async ({ cycleId }) => {
    n.finalize += 1;
    const c = cycleById(cycleId); if (!c) return { disposition: "not-found" };
    if (c.status !== "running") return { disposition: "invalid-status" };
    c.status = jobs.some((j) => j.cycle_id === cycleId && j.validated === true) ? "succeeded" : "partial";
    return { disposition: "finalized", cycle: { status: c.status } };
  };
  w.lineage = (rk, a) => {
    const j = jobs.filter((x) => x.report_key === rk && x.account_id === a).sort((x, y) => y.created_at - x.created_at)[0];
    if (!j) return null;
    const c = cycleById(j.cycle_id);
    return { reportKey: j.report_key, accountId: j.account_id, deriveStatus: j.derive_status, saveStatus: j.save_status, validated: j.validated === true, dependsOn: j.depends_on.map(String), durableContentDeps: j.durable_content_deps.map(String), snapshotParamsHash: j.snapshot_params_hash, latestDataDate: j.latest_data_date, cycleStatus: c ? c.status : null, id: j.id, cycleId: j.cycle_id, createdAt: j.created_at };
  };
  w.readLatestJob = async (rk, a) => { n.readLatest += 1; return w.lineage(rk, a); };
  w.getSnapshot = async ({ reportKey, accountId, paramsHash }) => snaps.get(reportKey + "|" + accountId + "|" + paramsHash) || null;
  const gate = (rk, a) => {
    const L = w.lineage(rk, a);
    if (!L || L.validated !== true || L.deriveStatus !== "succeeded" || L.saveStatus !== "succeeded" || !(L.cycleStatus === "succeeded" || L.cycleStatus === "partial") || !S(L.snapshotParamsHash)) return { disposition: "not-successful" };
    const shadow = snaps.get("scheduler-v2/" + rk + "|" + a + "|" + L.snapshotParamsHash);
    if (!shadow || S(shadow.params && shadow.params.accountId) !== a) return { disposition: "invalid-snapshot" };
    return { ok: true, shadow, liveHash: "live-" + L.snapshotParamsHash };
  };
  w.publisher = {
    preflight: async (rk, a) => { n.preflight += 1; const g = gate(rk, a); return g.ok ? { disposition: "ready", reportKey: rk, accountId: a, liveReportKey: rk, paramsHash: g.liveHash } : { disposition: g.disposition }; },
    publish: async (rk, a) => {
      n.publish += 1;
      const g = gate(rk, a); if (!g.ok) return { disposition: g.disposition };
      const k = rk + "|" + a + "|" + g.liveHash;
      if (typeof w.onBeforeLiveCas === "function") w.onBeforeLiveCas(k, rk, a, g.liveHash);
      const out = { reportKey: rk, accountId: a, liveReportKey: rk, paramsHash: g.liveHash };
      const cur = snaps.get(k); const stamp = S(g.shadow.source_refreshed_at);
      if (cur && S(cur.source_refreshed_at) > stamp) return { disposition: "newer-live", ...out };
      if (cur && S(cur.source_refreshed_at) === stamp) return { disposition: JSON.stringify(cur.payload) === JSON.stringify(g.shadow.payload) ? "already-current" : "publish-conflict", ...out };
      snaps.set(k, { report_key: rk, account_id: a, params_hash: g.liveHash, params: { accountId: a }, payload: g.shadow.payload, source_refreshed_at: stamp });
      n.liveWrites += 1;
      return { disposition: "published", ...out };
    },
  };
  w.readbackLive = async ({ liveReportKey, accountId, paramsHash }) => {
    n.readback[liveReportKey] = (n.readback[liveReportKey] || 0) + 1;
    return snaps.has(liveReportKey + "|" + accountId + "|" + paramsHash) ? { ok: true } : { ok: false, reason: "live-missing" };
  };
  w.verifyLease = async () => { n.verifyLease += 1; return { ok: true }; };
  w.live = (rk, a) => [...snaps.values()].filter((r) => r.report_key === rk && r.account_id === a);
  w.cycle = () => cycles.get(BUCKET + "|" + ASOF) || null;
  w.job = (rk) => jobs.filter((j) => j.report_key === rk && j.account_id === A).sort((x, y) => y.created_at - x.created_at)[0] || null;
  return w;
}

// Common release collaborators: `over.readLatestJob` replaces the world's reader; `over.omitReader` leaves the builder
// DEFAULT in place; `over.publisher` / `over.finalizeCycle` / `over.verifyLease` override those collaborators.
const commonWiring = (w, over) => ({
  openCycle: w.openCycle, getCycleByBucketDate: w.getCycleByBucketDate, claimCycle: w.claimCycle,
  upsertReportJob: w.upsertReportJob, claimLease: w.claimLease, saveShadow: w.saveShadow, reconcileSuccess: w.reconcileSuccess,
  finalizeCycle: over.finalizeCycle || w.finalizeCycle,
  publisher: over.publisher || w.publisher, readbackLive: w.readbackLive, verifyLease: over.verifyLease || w.verifyLease,
  computeHash: paramsHashFor, liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, reportDerivations: REPORT_DERIVATIONS,
  ...(over.omitReader ? {} : { readLatestJob: over.readLatestJob || w.readLatestJob }),
  log: () => {},
});

// ---- listing-health-v3: the shared bundle (fingerprint === revisionId) + a derived/validated payload ----
const LH_REV = "0123456789abcdef0123456789abcdef";
const LH_TOKEN = "listing-health-v3-manifest|org-1|primary|" + A + "|" + ASOF + "|" + LH_REV;
const lhBundle = () => ({
  eligible: true, status: "available", revisionId: LH_REV, deps: [], contentDeps: [LH_TOKEN],
  bundle: { listingsRows: [], rawRows: [], inventorySource: { available: false }, context: { rawSellerId: "SELLER-1" }, listingsSnapshot: { source_request_hash: "rh-l" }, rawSnapshot: { source_request_hash: "rh-r" }, inventorySnapshot: { source_request_hash: "rh-inv" } },
});
const wireLh = (w, over = {}) => buildListingHealthV3Release({
  ...commonWiring(w, over),
  resolveBundle: async () => lhBundle(),
  deriveSnapshot: async () => ({ status: "derived", validated: true, payload: { rows: [{ sku: "A", status: "Active" }] }, latestDataDate: ASOF }),
});

// ---- brand-inventory: a durable D-1 FBA snapshot + ONE publisher-identical brand-sales candidate (REAL contract) ----
const FBA_SHA = "ps-A01";
const INV_TOKEN = fbaContentProvenanceToken({ sourceKey: FBA_INVENTORY_SOURCE_KEY, accountId: A, connectionId: "primary", requestHash: "rh-fba", contentSha: FBA_SHA });
function seedBrandSalesCandidate(w) {
  const version = REPORT_DERIVATIONS["brand-sales"].snapshotVersion;
  const contract = SCHEDULER_LIVE_SNAPSHOT_CONTRACTS["brand-sales"];
  const shadowParams = { accountId: A, reportVersion: version, from: "2026-09-01", to: ASOF };
  const shadowHash = paramsHashFor(version, shadowParams);
  const liveParams = contract.liveParams(shadowParams);
  const liveHash = paramsHashFor(contract.liveReportVersion, liveParams);
  const payload = { rows: [], catalogBrands: ["BrandA"], asinBrand: { ASIN1: "BrandA" } };
  const stamp = "2026-09-09T08:00:00.000Z";
  w.cycles.set("bs-seed|" + ASOF, { id: "cyc-bs", bucket: "bs-seed", cycle_date: ASOF, status: "succeeded", created_at: stamp });
  w.jobs.push({ id: "job-bs", cycle_id: "cyc-bs", report_key: "brand-sales", account_id: A, depends_on: ["oli-h", "catalog"], durable_content_deps: [], derive_status: "succeeded", save_status: "succeeded", validated: true, snapshot_params_hash: shadowHash, latest_data_date: ASOF, created_at: 0 });
  w.snaps.set("scheduler-v2/brand-sales|" + A + "|" + shadowHash, { report_key: "scheduler-v2/brand-sales", account_id: A, params_hash: shadowHash, params: shadowParams, payload, payload_storage_path: null, source_refreshed_at: stamp });
  w.snaps.set("brand-sales|" + A + "|" + liveHash, { report_key: "brand-sales", account_id: A, params_hash: liveHash, params: { reportVersion: contract.liveReportVersion, ...liveParams }, payload, payload_storage_path: null, source_refreshed_at: stamp });
}
const wireInv = (w, over = {}) => buildFbaBrandInventoryRelease({
  ...commonWiring(w, over),
  resolveOrg: async () => ({ organizationFingerprint: "org-1", connectionId: "primary" }),
  readFbaSnapshot: async () => ({ read: "ok", snapshot: { object_path: "obj/fba/A01", payload_sha: FBA_SHA, source_request_hash: "rh-fba", row_count: 1 } }),
  loadSnapshotPayload: async () => ({ rows: [{ date: ASOF, child_asin: "ASIN1", available: 10, marketplace_country_code: "US" }] }),
  resolveExpectedRequestHash: async () => "rh-fba",
  resolveAccountCountry: async () => "US",
  readReportJob: async (rk, a) => w.lineage(rk, a),
  readSnapshot: (args) => w.getSnapshot(args),
  loadStoragePayload: async () => null,
  buildInventorySnapshot: async () => ({ payload: { inventoryAvailable: true, inventoryDate: ASOF, inventoryByBrandCountry: [{ brand: "BrandA", country: "US", fbaAvailable: 10 }] } }),
});

// ---- daily-reporting: the ads-reconcile-prodshape durable evidence (OLI + catalog + Campaign Ads) ----
const BW = oliBackfillWindow(ASOF);
const DAILY_CLOCK = () => Date.parse("2026-09-10T12:00:00Z"); // catalog validated today (UTC execution day == ASOF)
const DAILY_REV = computeAdsReportRevision({
  organizationFingerprint: "org-1", connectionId: "primary", accountId: A, marketplace: "US",
  requestedAsOf: ASOF, requiredFrom: subUtcDaysStr(ASOF, adsRequiredCoverageDays("daily-reporting") - 1), requiredGrains: [ADS_CAMPAIGN_SOURCE_KEY],
  grains: { [ADS_CAMPAIGN_SOURCE_KEY]: { contentRev: "cr-A", latestMetricDate: "2026-09-08", windows: [{ from: BW.from, to: ASOF }], read: "ok", syncStatus: "succeeded" } },
}).revisionId;
const wireDaily = (w, over = {}) => buildDailyReportingRelease({
  ...commonWiring(w, over),
  resolveOrg: async () => ({ organizationFingerprint: "org-1", connectionId: "primary" }),
  resolveAccountMeta: async () => ({ rawSellerId: "seller-A01", currency: "USD", marketplace: "US" }),
  readOliHistory: async () => [
    { account_id: A, sale_date: "2026-09-05", sku: "SKU-A", child_asin: "B0A", currency: "USD", sales_amount: 100, units: 4, source_request_hash: "oli-h" },
    { account_id: A, sale_date: "2026-09-08", sku: "SKU-B", child_asin: "B0B", currency: "USD", sales_amount: 60, units: 2, source_request_hash: "oli-h" },
  ],
  readOliCoverage: async () => ({ read: "ok", windows: [{ from: BW.from, to: ASOF }] }),
  readOliZeroProof: async () => ({ read: "ok", byAccount: new Map() }),
  readCatalogSnapshot: async () => ({ read: "ok", snapshot: { object_path: "obj/cat", source_request_hash: "catalog", validated_at: "2026-09-10T06:00:00Z", row_count: 2 } }),
  loadCatalogPayload: async () => ({ rows: [
    { child_asin: "B0A", sku: "SKU-A", parent_asin: "P", product_name: "A", product_brand: "Acme" },
    { child_asin: "B0B", sku: "SKU-B", parent_asin: "P", product_name: "B", product_brand: "Bolt" },
  ] }),
  readActiveAdsRows: async () => [{ metric_date: "2026-09-05", marketplace_country_code: "US", dimension_key: "d1", currency: "USD", campaign_id: "c1", updated_at: "2026-09-06T00:00:00Z", metrics: { ad_sales: 40, ad_spend: 12, ad_clicks: 8 } }],
  readAdsCoverage: async () => ({ read: "ok", windows: [{ from: BW.from, to: ASOF }], status: "succeeded", latestMetricDate: "2026-09-08", contentRev: "cr-A" }),
  readOperationalUnits: async () => [], readEstimates: async () => [], readSkuAsinResolution: async () => [],
  clock: DAILY_CLOCK,
});

const RELEASES = [
  { name: "listing-health-v3", rk: "listing-health-v3", wire: wireLh, seed: () => {}, args: () => ({ accountId: A, requestedAsOf: ASOF, cycleBucket: BUCKET, revisionId: LH_REV }) },
  { name: "brand-inventory", rk: "brand-inventory", wire: wireInv, seed: seedBrandSalesCandidate, args: () => ({ accountId: A, requestedAsOf: ASOF, cycleBucket: BUCKET }) },
  { name: "daily-reporting", rk: "daily-reporting", wire: wireDaily, seed: () => {}, args: () => ({ accountId: A, requestedAsOf: ASOF, cycleBucket: BUCKET, revisionId: DAILY_REV }) },
];

// Pass 1 is KILLED right after finalize_sync_cycle COMMITS (the finalize write landed; the process died before the
// publish): the durable state is a TERMINAL cycle + a validated job + its shadow, and NO live row.
async function crashedWorld(d) {
  const w = makeLineageWorld(); d.seed(w);
  const killAfterFinalize = async (args, opt) => { await w.finalizeCycle(args, opt); throw new Error("process killed after finalize"); };
  const r1 = await d.wire(w, { finalizeCycle: killAfterFinalize }).runForAccount(d.args());
  return { w, r1 };
}
const snapshotCounts = (w) => JSON.parse(JSON.stringify(w.n));

// =====================================================================================================================
// A. crash after finalize and before publish -> the retry RESUMES (all three releases)
// =====================================================================================================================
for (const d of RELEASES) {
  test(`A[${d.name}]: crash after finalize + before publish -> the retry resumes at publish; no TERMINAL_CYCLE`, async () => {
    const { w, r1 } = await crashedWorld(d);
    const job = w.job(d.rk);
    ok(`${d.name}: pass 1 died after finalize -> cycle TERMINAL + job validated + shadow saved + ZERO live rows`,
      r1.ok === false && r1.stage === "finalize" && S(w.cycle() && w.cycle().status) === "succeeded" && !!job && job.validated === true && w.snaps.has("scheduler-v2/" + d.rk + "|" + A + "|" + job.snapshot_params_hash) && w.live(d.rk, A).length === 0);
    const before = snapshotCounts(w);
    const r2 = await d.wire(w).runForAccount(d.args());
    ok(`${d.name}: the retry RESUMES + publishes + reads back (READBACK_VERIFIED; never 'cycle-not-running')`,
      r2.ok === true && r2.code === 0 && statusFromRelease(r2) === RECONCILE_STATUS.READBACK_VERIFIED && !/cycle-not-running/.test(S(r2.reason)) && w.live(d.rk, A).length === 1);
    ok(`${d.name}: the resumed pass writes ZERO job/lease/shadow/reconcile/finalize rows (straight to preflight -> verifyLease -> publish -> read-back)`,
      w.n.upsert === before.upsert && w.n.claimLease === before.claimLease && w.n.shadow === before.shadow && w.n.reconcile === before.reconcile && w.n.finalize === before.finalize
      && w.n.preflight === before.preflight + 1 && w.n.verifyLease === before.verifyLease + 1 && w.n.publish === before.publish + 1 && w.n.liveWrites === before.liveWrites + 1 && (w.n.readback[d.rk] || 0) === (before.readback[d.rk] || 0) + 1);
    ok(`${d.name}: the latest job is read exactly once, only by the terminal-cycle resume`, w.n.readLatest === before.readLatest + 1);
    ok(`${d.name}: the live row IS the terminal cycle's shadow (same payload + source_refreshed_at = that cycle's created_at)`,
      (() => { const live = w.live(d.rk, A)[0]; const sh = w.snaps.get("scheduler-v2/" + d.rk + "|" + A + "|" + job.snapshot_params_hash); return JSON.stringify(live.payload) === JSON.stringify(sh.payload) && live.source_refreshed_at === w.cycle().created_at; })());
    const r3 = await d.wire(w).runForAccount(d.args());
    ok(`${d.name}: a further replay resumes again as an idempotent already-current (zero live writes)`, r3.ok === true && w.n.liveWrites === before.liveWrites + 1);
  });

  test(`A[${d.name}]: the resume never bypasses the fence or the deadline`, async () => {
    const { w } = await crashedWorld(d);
    const before = snapshotCounts(w);
    const lost = await d.wire(w, { verifyLease: async () => ({ ok: false, reason: "lost" }) }).runForAccount(d.args());
    ok(`${d.name}: resumed + lease lost before publish -> contention, ZERO publish`, lost.ok === false && lost.leaseLost === true && lost.stage === "contention" && w.n.publish === before.publish && w.live(d.rk, A).length === 0);
    const controller = new AbortController();
    const abortingReader = async (rk, a) => { const L = w.lineage(rk, a); controller.abort(); return L; };
    const ab = await d.wire(w, { readLatestJob: abortingReader }).runForAccount({ ...d.args(), signal: controller.signal });
    ok(`${d.name}: abort observed during the resume read -> DEADLINE_ABORTED, ZERO preflight/publish`, ab.status === "DEADLINE_ABORTED" && w.n.preflight === before.preflight + 1 && w.n.publish === before.publish && w.live(d.rk, A).length === 0);
  });

  test(`A[${d.name}]: the reader is consulted ONLY for a terminal cycle (fresh + running paths unchanged)`, async () => {
    const w = makeLineageWorld(); d.seed(w);
    const r = await d.wire(w).runForAccount(d.args());
    ok(`${d.name}: a fresh pass (claim won) publishes and NEVER reads the latest job`, r.ok === true && w.n.readLatest === 0 && w.n.finalize === 1 && w.live(d.rk, A).length === 1);
    const w2 = makeLineageWorld(); d.seed(w2);
    await w2.openCycle({ bucket: BUCKET, cycleDate: ASOF }); w2.cycle().status = "running"; // a prior in-flight pass
    const r2 = await d.wire(w2).runForAccount(d.args());
    ok(`${d.name}: an already-RUNNING cycle proceeds exactly as today (upsert -> shadow -> finalize -> publish), reader untouched`, r2.ok === true && w2.n.readLatest === 0 && w2.n.upsert === 1 && w2.n.finalize === 1 && w2.live(d.rk, A).length === 1);
  });
}

// =====================================================================================================================
// B. a terminal cycle whose latest job is NOT provably this derivation -> 'cycle-not-running' EXACTLY as today
// =====================================================================================================================
const NEGATIVE = [
  { label: "the latest job belongs to ANOTHER (later) cycle", mutate: (w, d) => {
    w.cycles.set("sched|" + ASOF, { id: "cyc-sched", bucket: "india", cycle_date: ASOF, status: "succeeded", created_at: "2026-09-10T20:00:00.000Z" });
    const j = w.job(d.rk); w.jobs.push({ ...j, id: "job-sched", cycle_id: "cyc-sched", created_at: 10000 });
  } },
  { label: "another revision: the job's shadow params hash differs", mutate: (w, d) => { w.job(d.rk).snapshot_params_hash = "f".repeat(40); } },
  { label: "another revision: a dependency hash advanced (deps not covered)", mutate: (w, d) => { w.job(d.rk).depends_on = ["stale-dep"]; } },
  { label: "another revision: the content token advanced (content deps not covered)", mutate: (w, d) => { w.job(d.rk).durable_content_deps = ["stale-content-token"]; } },
  { label: "the job is not promotable (unvalidated)", mutate: (w, d) => { w.job(d.rk).validated = false; } },
  { label: "the reader throws", reader: () => async () => { throw new Error("read failed (503)"); } },
  { label: "the reader returns no job", reader: () => async () => null },
  { label: "a pre-WP2 lineage shape (no cycleId)", reader: (w) => async (rk, a) => { const L = w.lineage(rk, a); delete L.cycleId; return L; } },
];
for (const d of RELEASES) {
  test(`B[${d.name}]: a terminal cycle NOT provably holding this derivation defers byte-identically to today`, async () => {
    for (const c of NEGATIVE) {
      const { w } = await crashedWorld(d);
      if (c.mutate) c.mutate(w, d);
      const before = snapshotCounts(w);
      const r = await d.wire(w, c.reader ? { readLatestJob: c.reader(w) } : {}).runForAccount(d.args());
      assert.deepEqual(r, LEGACY_TERMINAL("succeeded"), `${d.name}: ${c.label}`);
      ok(`${d.name}: ${c.label} -> defer('cycle-not-running:succeeded') EXACTLY as today; ZERO preflight/publish/job/shadow/finalize writes`,
        statusFromRelease(r) === RECONCILE_STATUS.DEFERRED_DEPENDENCY && w.n.preflight === before.preflight && w.n.publish === before.publish && w.n.upsert === before.upsert && w.n.shadow === before.shadow && w.n.finalize === before.finalize && w.live(d.rk, A).length === 0);
    }
    const { w } = await crashedWorld(d);
    w.cycle().status = "failed";
    const before = snapshotCounts(w);
    const r = await d.wire(w).runForAccount(d.args());
    assert.deepEqual(r, LEGACY_TERMINAL("failed"));
    ok(`${d.name}: a non-success terminal status ('failed') defers 'cycle-not-running:failed' WITHOUT reading the job`, w.n.readLatest === before.readLatest && w.n.publish === before.publish);
  });
}

// =====================================================================================================================
// C. publish 'newer-live' -> NEWER_LIVE (retryable DEFERRED_DEPENDENCY), never a hard FAILED_PUBLISH
// =====================================================================================================================
for (const d of RELEASES) {
  test(`C[${d.name}]: a concurrent strictly-newer live row -> NEWER_LIVE deferral; the newer row is untouched`, async () => {
    const w = makeLineageWorld(); d.seed(w);
    const FOREIGN = { report_key: d.rk, account_id: A, params: { accountId: A }, payload: { foreign: "newer-writer" }, source_refreshed_at: "2099-01-01T00:00:00.000Z" };
    // A foreign writer (e.g. the scheduler's materializer) lands a strictly-newer live row between preflight and the CAS.
    w.onBeforeLiveCas = (k, rk, a, hash) => { if (!w.snaps.has(k)) w.snaps.set(k, { ...FOREIGN, params_hash: hash }); };
    const r = await d.wire(w).runForAccount(d.args());
    assert.deepEqual(r, NEWER_LIVE_RESULT);
    ok(`${d.name}: publish newer-live -> {stage:'publish', status:'NEWER_LIVE', reason:'publish-newer-live'}`, r.stage === "publish" && r.status === "NEWER_LIVE" && r.reason === "publish-newer-live");
    ok(`${d.name}: statusFromRelease classifies it DEFERRED_DEPENDENCY (retryable), NOT FAILED_PUBLISH`, statusFromRelease(r) === RECONCILE_STATUS.DEFERRED_DEPENDENCY && statusFromRelease({ ...r, status: null }) === RECONCILE_STATUS.FAILED_PUBLISH);
    ok(`${d.name}: the diagnostic stage/reasonCode are unchanged (publish / publish-newer-live)`, diagStageFor(r).stage === "publish" && diagStageFor(r).reasonCode === "publish-newer-live");
    const live = w.live(d.rk, A);
    ok(`${d.name}: ZERO live writes, the strictly-newer row is byte-for-byte untouched, and NO read-back ran`, w.n.liveWrites === 0 && live.length === 1 && live[0].payload.foreign === "newer-writer" && (w.n.readback[d.rk] || 0) === 0);
  });
}

test("C[brand-inventory, REAL fenced publisher + REAL FBA reconciler]: a strictly-newer canonical live -> DEFERRED_DEPENDENCY (was FAILED_PUBLISH), live untouched", async () => {
  const world = fbaShape.makeWorld();
  const contract = SCHEDULER_LIVE_SNAPSHOT_CONTRACTS["brand-inventory"];
  const liveParams = contract.liveParams({ reportVersion: BRAND_INVENTORY_REPORT_VERSION, accountId: A, to: ASOF });
  const liveHash = paramsHashFor(contract.liveReportVersion, liveParams);
  const newer = { report_key: "brand-inventory", account_id: A, params_hash: liveHash, params: { reportVersion: contract.liveReportVersion, ...liveParams }, payload: { inventoryAvailable: true, inventoryDate: ASOF, marker: "materializer" }, payload_storage_path: null, source_refreshed_at: "2099-01-01T00:00:00.000Z" };
  world.snaps.set("brand-inventory|" + A + "|" + liveHash, { ...newer });
  const { reconciler } = fbaShape.buildProd(world);
  const out = await reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  const rep = out.perAccount[0].reports["brand-inventory"];
  ok("the REAL fenced CAS returned newer-live -> the report is DEFERRED_DEPENDENCY with reason publish-newer-live; the run stays green", rep.state === FBA_RECONCILE_STATUS.DEFERRED_DEPENDENCY && rep.reason === "publish-newer-live" && out.ok === true);
  ok("the strictly-newer canonical live row is byte-for-byte untouched (zero live writes)", JSON.stringify(world.snaps.get("brand-inventory|" + A + "|" + liveHash)) === JSON.stringify(newer) && world.writes.publishedLiveKeys.length === 0);
});

// =====================================================================================================================
// A (production composition). The CLI-identical wiring passes NO reader: the release's lazy DEFAULT
// getLatestReportJobLineage runs over the stubbed PostgREST, served from the faithful FBA world's sync_report_jobs.
// =====================================================================================================================
const projectSelect = (row, select) => {
  const cols = String(select || "").split(",").map((c) => c.trim().replace(/\(.*$/, ""));
  const out = {}; for (const c of cols) if (c in row) out[c] = row[c]; return out;
};
const strip = (v, p) => (S(v).startsWith(p) ? S(v).slice(p.length) : null);
const fbaJobsRoute = (world, { hide = false } = {}) => (method, u) => {
  if (method !== "GET" || u.pathname !== "/rest/v1/sync_report_jobs") return null;
  const r = world.latestJob(strip(u.searchParams.get("report_key"), "eq."), strip(u.searchParams.get("account_id"), "eq."));
  if (!r || hide) return resp(200, []);
  const { j, cycleStatus } = r;
  const row = { id: "job-row-" + j.created_at, cycle_id: j.cycle_id, report_key: j.report_key, account_id: j.account_id, derive_status: j.derive_status, save_status: j.save_status, validated: j.validated, depends_on: j.depends_on, durable_content_deps: j.durable_content_deps || [], snapshot_params_hash: j.snapshot_params_hash, latest_data_date: j.latest_data_date, created_at: new Date(Date.UTC(2026, 8, 10) + Number(j.created_at) * 1000).toISOString(), sync_cycles: { status: cycleStatus } };
  return resp(200, [projectSelect(row, u.searchParams.get("select"))]);
};
async function crashFbaThroughReconciler(world) {
  const realFinalize = world.finalizeCycle;
  world.finalizeCycle = async (args) => { await realFinalize(args); throw new Error("process killed after finalize"); };
  const { reconciler } = fbaShape.buildProd(world);
  const out1 = await reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  world.finalizeCycle = realFinalize;
  return { reconciler, out1 };
}
test("A[production composition]: REAL FBA reconciler + REAL publisher + DEFAULT reader -> crash, then the next pass RESUMES to READBACK_VERIFIED", async () => {
  const world = fbaShape.makeWorld();
  net.routes = [fbaJobsRoute(world)];
  const { reconciler, out1 } = await crashFbaThroughReconciler(world);
  const cyc = [...world.cycles.values()].find((c) => String(c.bucket).startsWith("priority-partial-india-"));
  ok("pass 1: killed after finalize -> the dedicated cycle is TERMINAL, no brand-inventory live row", out1.perAccount[0].reports["brand-inventory"].state === FBA_RECONCILE_STATUS.FAILED_PUBLISH && cyc && cyc.status === "succeeded" && !fbaShape.liveRow(world));
  const callsBefore = net.calls.length;
  const out2 = await reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("pass 2 (same revision -> same terminal bucket): RESUMED -> READBACK_VERIFIED; a real brand-inventory live row exists", out2.perAccount[0].reports["brand-inventory"].state === FBA_RECONCILE_STATUS.READBACK_VERIFIED && out2.ok === true && !!fbaShape.liveRow(world));
  const jobReads = net.calls.slice(callsBefore).filter((c) => c.method === "GET" && c.path === "/rest/v1/sync_report_jobs");
  ok("the DEFAULT reader IS getLatestReportJobLineage (one PostgREST read of the brand-inventory job, selecting id + cycle_id + created_at)",
    jobReads.length === 1 && jobReads[0].params.get("report_key") === "eq.brand-inventory" && jobReads[0].params.get("account_id") === "eq." + A && /(^|,)id,cycle_id,/.test(S(jobReads[0].params.get("select"))) && /created_at/.test(S(jobReads[0].params.get("select"))));
  ok("pass 2 opened NO new job and saved NO new shadow (the terminal cycle's validated job is what the publisher promoted)", world.jobs.filter((j) => j.report_key === "brand-inventory").length === 1 && world.writes.shadowSavedKeys.filter((k) => k === "scheduler-v2/brand-inventory").length === 1);
  const out3 = await reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("pass 3 is PUBLICATION_NOT_REQUIRED (converged; zero writes)", out3.perAccount[0].reports["brand-inventory"].state === "PUBLICATION_NOT_REQUIRED");
  net.routes = [];
});
test("A[production composition] CONTROL: the same crash with NO provable job keeps today's TERMINAL deferral", async () => {
  const world = fbaShape.makeWorld();
  net.routes = [fbaJobsRoute(world, { hide: true })];
  const { reconciler } = await crashFbaThroughReconciler(world);
  const out2 = await reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  const rep = out2.perAccount[0].reports["brand-inventory"];
  ok("no promotable job for this cycle -> DEFERRED_DEPENDENCY 'cycle-not-running:succeeded' (pre-WP2 behaviour), zero live rows", rep.state === FBA_RECONCILE_STATUS.DEFERRED_DEPENDENCY && rep.reason === "cycle-not-running:succeeded" && !fbaShape.liveRow(world));
  net.routes = [];
});

// =====================================================================================================================
// D. getLatestReportJobLineage mapping is ADDITIVE
// =====================================================================================================================
const LEGACY_LINEAGE_KEYS = ["reportKey", "accountId", "deriveStatus", "saveStatus", "validated", "dependsOn", "durableContentDeps", "snapshotParamsHash", "latestDataDate", "cycleStatus"];
const legacyLineage = (row) => {
  const cycle = Array.isArray(row.sync_cycles) ? row.sync_cycles[0] : row.sync_cycles;
  return {
    reportKey: row.report_key, accountId: row.account_id, deriveStatus: row.derive_status ?? null, saveStatus: row.save_status ?? null,
    validated: row.validated === true, dependsOn: Array.isArray(row.depends_on) ? row.depends_on.map((h) => String(h)) : [],
    durableContentDeps: Array.isArray(row.durable_content_deps) ? row.durable_content_deps.map((h) => String(h)) : [],
    snapshotParamsHash: row.snapshot_params_hash ?? null, latestDataDate: row.latest_data_date ?? null,
    cycleStatus: cycle && typeof cycle === "object" ? (cycle.status ?? null) : null,
  };
};
test("D: getLatestReportJobLineage keeps every pre-WP2 field (name, value, order) and appends id / cycleId / createdAt", async () => {
  const row = { id: "5f0b2c1e-0000-4000-8000-000000000001", cycle_id: "9a1e-cycle", report_key: "daily-reporting", account_id: A, derive_status: "succeeded", save_status: "succeeded", validated: true, depends_on: ["catalog", "oli-h"], durable_content_deps: ["ads|tok"], snapshot_params_hash: "h".repeat(40), latest_data_date: ASOF, created_at: "2026-09-10T09:31:00.000Z", sync_cycles: [{ status: "succeeded" }] };
  const seen = [];
  net.routes = [(method, u) => { if (method !== "GET" || u.pathname !== "/rest/v1/sync_report_jobs") return null; seen.push(S(u.searchParams.get("select"))); return resp(200, [projectSelect(row, u.searchParams.get("select"))]); }];
  const got = await sb.getLatestReportJobLineage("daily-reporting", A);
  const legacy = legacyLineage(row);
  ok("every pre-WP2 field is unchanged (deep-equal to the legacy mapping)", LEGACY_LINEAGE_KEYS.every((k) => JSON.stringify(got[k]) === JSON.stringify(legacy[k])));
  ok("key order: the pre-WP2 fields first (same order), then id, cycleId, createdAt", JSON.stringify(Object.keys(got)) === JSON.stringify([...LEGACY_LINEAGE_KEYS, "id", "cycleId", "createdAt"]));
  ok("the new fields map id / cycle_id / created_at", got.id === row.id && got.cycleId === row.cycle_id && got.createdAt === row.created_at);
  ok("the select now requests id (additive) alongside the unchanged columns + durable_content_deps", seen.length === 1 && seen[0].startsWith("id,cycle_id,report_key,account_id,derive_status,save_status,validated,depends_on,snapshot_params_hash,latest_data_date,created_at,sync_cycles(status)") && seen[0].endsWith(",durable_content_deps"));

  // Schema-missing fallback (durable_content_deps unapplied): the retry WITHOUT the column still maps the new fields.
  const seen2 = [];
  net.routes = [(method, u) => {
    if (method !== "GET" || u.pathname !== "/rest/v1/sync_report_jobs") return null;
    const sel = S(u.searchParams.get("select")); seen2.push(sel);
    if (sel.includes("durable_content_deps")) return resp(404, { code: "PGRST205", message: "Could not find the table in the schema cache" });
    const { durable_content_deps: _drop, ...rest } = row; return resp(200, [projectSelect(rest, sel)]);
  }];
  const got2 = await sb.getLatestReportJobLineage("daily-reporting", A);
  ok("fallback path: durableContentDeps degrades to [] exactly as before; id/cycleId/createdAt still mapped", seen2.length === 2 && JSON.stringify(got2.durableContentDeps) === "[]" && got2.dependsOn.join(",") === "catalog,oli-h" && got2.cycleId === row.cycle_id && got2.id === row.id && got2.createdAt === row.created_at);

  net.routes = [(method, u) => (method === "GET" && u.pathname === "/rest/v1/sync_report_jobs" ? resp(200, [projectSelect({ ...row, id: undefined }, u.searchParams.get("select"))]) : null)];
  const got3 = await sb.getLatestReportJobLineage("daily-reporting", A);
  ok("an absent id maps to null (never undefined)", got3.id === null && got3.cycleId === row.cycle_id);
  net.routes = [(method, u) => (method === "GET" && u.pathname === "/rest/v1/sync_report_jobs" ? resp(200, []) : null)];
  ok("no job row -> null (unchanged)", (await sb.getLatestReportJobLineage("daily-reporting", A)) === null);
  net.routes = [];
});

// =====================================================================================================================
// E. deleteRouteShadowSnapshots: allowlist + argument guards + a faithful PostgREST DELETE filter model
// =====================================================================================================================
const H = (c) => c.repeat(40);
// Evaluate ONE PostgREST filter against a report_snapshots row. `params->>k` is JSON text (absent/null -> SQL NULL); a
// NULL never satisfies eq / not.in / lt (SQL three-valued logic), exactly like Postgres.
function pgFilterMatches(row, field, expr) {
  const raw = field.startsWith("params->>") ? (row.params ? row.params[field.slice("params->>".length)] : undefined) : row[field];
  const val = raw == null ? null : String(raw);
  if (expr === "not.is.null") return val !== null;
  if (expr.startsWith("eq.")) return val !== null && val === expr.slice(3);
  if (expr.startsWith("lt.")) return val !== null && Date.parse(val) < Date.parse(expr.slice(3));
  if (expr.startsWith("not.in.(") && expr.endsWith(")")) return val !== null && !expr.slice("not.in.(".length, -1).split(",").map((s) => s.replace(/^"|"$/g, "")).includes(val);
  throw new Error("unsupported filter in the test model: " + field + "=" + expr);
}
function snapshotTableRoute(table, seen) {
  return (method, u, opts) => {
    if (u.pathname !== "/rest/v1/report_snapshots" || method !== "DELETE") return null;
    seen.push({ params: u.searchParams, prefer: S(opts.headers && opts.headers.Prefer) });
    const filters = [...u.searchParams.entries()].filter(([k]) => k !== "select");
    const deleted = table.rows.filter((r) => filters.every(([k, v]) => pgFilterMatches(r, k, v)));
    table.rows = table.rows.filter((r) => !deleted.includes(r));
    return resp(200, deleted.map((r) => projectSelect(r, u.searchParams.get("select"))));
  };
}
const OLD = "2026-09-01T00:00:00.000Z";
const CUTOFF = "2026-09-20T00:00:00.000Z";
function pruneTable() {
  const row = (id, report_key, account_id, params, params_hash, updated_at = OLD) => ({ id, report_key, account_id, params, params_hash, updated_at, payload: { big: id } });
  return { rows: [
    row("del-1", "scheduler-v2/fba-plan", A, { route: "fba-plan", rev: "r1", reportVersion: "v" }, H("1")),
    row("kept-hash", "scheduler-v2/fba-plan", A, { route: "fba-plan", rev: "r2" }, H("2")),
    row("fresh", "scheduler-v2/fba-plan", A, { route: "fba-plan", rev: "r3" }, H("3"), "2026-09-24T12:00:00.000Z"),
    row("paid-shadow", "scheduler-v2/fba-plan", A, { reportVersion: "fba-plan/v", accountId: A, to: ASOF }, H("4")),
    row("route-no-rev", "scheduler-v2/fba-plan", A, { route: "fba-plan" }, H("5")),
    row("rev-no-route", "scheduler-v2/fba-plan", A, { rev: "r6" }, H("6")),
    row("rev-null", "scheduler-v2/fba-plan", A, { route: "fba-plan", rev: null }, H("7")),
    row("other-route", "scheduler-v2/fba-plan", A, { route: "returns-v3", rev: "r8" }, H("8")),
    row("other-account", "scheduler-v2/fba-plan", "A02", { route: "fba-plan", rev: "r9" }, H("9")),
    row("live-row", "fba-plan", A, { route: "fba-plan", rev: "r10" }, H("a")),
    row("other-key", "scheduler-v2/brand-inventory", A, { route: "fba-plan", rev: "r11" }, H("b")),
    row("del-2", "scheduler-v2/fba-plan", A, { route: "fba-plan", rev: "r12" }, H("c")),
    row("bv-live", "brand-view", A, { route: "brand-view", rev: "r13" }, H("d")),
    row("bv-shadow", "scheduler-v2/brand-view", A, { route: "brand-view", rev: "r14" }, H("e")),
  ] };
}
const VALID = () => ({ routeId: "fba-plan", publisherKey: "fba-plan", targetId: A, keepParamsHashes: [H("2")], olderThanIso: CUTOFF });
async function expectRefused(label, args) {
  const before = net.calls.length;
  let err = null;
  try { await sb.deleteRouteShadowSnapshots(args); } catch (e) { err = e; }
  ok("refused: " + label + " (ROUTE_SHADOW_PRUNE_REFUSED, ZERO requests)", !!err && err.code === "ROUTE_SHADOW_PRUNE_REFUSED" && net.calls.length === before);
}
test("E: deleteRouteShadowSnapshots refuses non-allowlisted / live / scheduler-prefixed keys and malformed arguments with ZERO requests", async () => {
  ok("the allowlist is exactly the six route publisher keys", JSON.stringify(sb.ROUTE_SHADOW_PRUNE_PUBLISHER_KEYS) === JSON.stringify(["fba-plan", "sku-movement", "returns-leakage-v3", "brand-view-brands", "brand-view", "brand-view-portfolio"]) && Object.isFrozen(sb.ROUTE_SHADOW_PRUNE_PUBLISHER_KEYS));
  for (const key of ["daily-reporting", "brand-sales", "brand-inventory", "listing-health-v3", "returns-leakage", "returns-leakage-v2", "scheduler-v2/fba-plan", "scheduler-v2/brand-view", "FBA-PLAN", "", null, undefined]) {
    await expectRefused("publisherKey " + JSON.stringify(key), { ...VALID(), publisherKey: key });
  }
  for (const routeId of ["", "Fba Plan", "fba_plan", "-x", 5, null]) await expectRefused("routeId " + JSON.stringify(routeId), { ...VALID(), routeId });
  for (const targetId of ["", "  ", " A01", null, 7]) await expectRefused("targetId " + JSON.stringify(targetId), { ...VALID(), targetId });
  for (const keep of [[], undefined, "a".repeat(40), ["not-a-hash"], [H("2"), "x"], [H("a").toUpperCase()], [H("2") + "0"]]) await expectRefused("keepParamsHashes " + JSON.stringify(keep), { ...VALID(), keepParamsHashes: keep });
  for (const older of ["not-a-date", "", undefined, 1758326400000]) await expectRefused("olderThanIso " + JSON.stringify(older), { ...VALID(), olderThanIso: older });
  await expectRefused("no arguments at all", undefined);
});
test("E: ONE guarded DELETE removes ONLY old, un-kept, route+rev shadows of the exact scheduler-v2 key + account + route", async () => {
  const table = pruneTable(); const seen = [];
  net.routes = [snapshotTableRoute(table, seen)];
  const n = await sb.deleteRouteShadowSnapshots(VALID());
  ok("returns the deleted count (2)", n === 2);
  ok("exactly the two deletable rows are gone; every guarded row survives", JSON.stringify(table.rows.map((r) => r.id).sort()) === JSON.stringify(["bv-live", "bv-shadow", "fresh", "kept-hash", "live-row", "other-account", "other-key", "other-route", "paid-shadow", "rev-no-route", "rev-null", "route-no-rev"]));
  ok("rows without params.route or params.rev (incl. the paid fba-plan shadow + a null rev) are NEVER deleted", ["paid-shadow", "route-no-rev", "rev-no-route", "rev-null"].every((id) => table.rows.some((r) => r.id === id)));
  ok("the live (non scheduler-v2) row is NEVER deleted", table.rows.some((r) => r.id === "live-row"));
  const p = seen[0] && seen[0].params;
  ok("exactly ONE DELETE carrying every restriction (key, account, route, rev not null, keep, cutoff) + return=representation of params_hash only",
    seen.length === 1 && seen[0].prefer === "return=representation" && p.get("select") === "params_hash" && p.get("report_key") === "eq.scheduler-v2/fba-plan" && p.get("account_id") === "eq." + A
    && p.get("params->>route") === "eq.fba-plan" && p.get("params->>rev") === "not.is.null" && p.get("params_hash") === "not.in.(" + H("2") + ")" && p.get("updated_at") === "lt." + CUTOFF);

  // brand-view is BOTH a route publisher key AND a live report_key: only its scheduler-v2 shadow can ever match.
  const n2 = await sb.deleteRouteShadowSnapshots({ routeId: "brand-view", publisherKey: "brand-view", targetId: A, keepParamsHashes: [H("0")], olderThanIso: CUTOFF });
  ok("publisherKey brand-view deletes ONLY scheduler-v2/brand-view (the live brand-view row with route+rev survives)", n2 === 1 && !table.rows.some((r) => r.id === "bv-shadow") && table.rows.some((r) => r.id === "bv-live"));

  net.routes = [(method, u) => (method === "DELETE" && u.pathname === "/rest/v1/report_snapshots" ? resp(200, null) : null)];
  let err = null; try { await sb.deleteRouteShadowSnapshots(VALID()); } catch (e) { err = e; }
  ok("a non-array DELETE acknowledgement fails closed (ROUTE_SHADOW_PRUNE_ACK_INVALID), never a guessed count", !!err && err.code === "ROUTE_SHADOW_PRUNE_ACK_INVALID");
  net.routes = [];
});

async function main() {
  writeSync(1, "release-resume-terminal-cycle\n");
  let failures = 0;
  for (const t of tests) {
    net.routes = [];
    try { await t.fn(); } catch (e) { failures += 1; writeSync(1, "FAIL  " + t.name + "\n" + String((e && e.stack) || e) + "\n"); }
  }
  try { ok("zero unexpected (unrouted) requests across the whole suite -- nothing reached a real endpoint", net.unexpected.length === 0); }
  catch (e) { failures += 1; writeSync(1, "FAIL  unexpected requests: " + JSON.stringify(net.unexpected) + "\n"); }
  writeSync(1, `\nrelease-resume-terminal-cycle: ${passed} assertions passed${failures ? ", " + failures + " FAILED" : ""}\n`);
  if (failures) process.exitCode = 1;
}
await main();
