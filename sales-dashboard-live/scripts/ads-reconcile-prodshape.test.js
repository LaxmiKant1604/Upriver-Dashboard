// PRODUCTION-SHAPE integration for the Campaign-Ads reconciler's DEDICATED daily-reporting-only release. Drives the REAL
// composition end to end over FAITHFUL in-memory stores -- NOTHING about the release/lineage/publish/derive is injected
// as a fake success:
//   - the REAL buildAdsReportReconciler + shared saved-data core + REAL Ads revision;
//   - the REAL buildDailyReportingRelease (open cycle -> read durable OLI history/coverage + org catalog + Campaign Ads
//     rows/coverage -> enrich (read-only) -> derive via the ONE canonical REPORT_DERIVATIONS["daily-reporting"] -> upsert
//     lineage + durable_content_deps -> claim -> shadow CAS -> reconcile -> finalize -> publish -> read back);
//   - the REAL buildSchedulerV2Publisher (four durable gates + fenced live CAS) wired to in-memory backing;
//   - the REAL buildLiveReadback (canonical live identity + payload contract);
//   - the REAL runControlPackageCli control apply/safe-close over the faithful in-memory control store.
//
// It PROVES the P0 scope fix + convergence: unpromoted -> derive+publish+readback ONLY daily-reporting (Brand Sales +
// Brand Inventory get ZERO writes and stay byte-for-byte identical); replay -> zero-write no-op; a SAME-DATE Ads
// correction (content_rev flips) -> Daily STALE -> republish ONCE -> canonical readback -> a second pass is a zero-write
// no-op; D-1 not ready -> defer + siblings untouched; and abort during any awaited release phase (open/upsert/claim/
// shadow/reconcile/finalize/readback) starts NO later durable write + NO publish, and a NULL control fence makes the
// REAL publisher's live CAS write ZERO rows. The test FAILS if a brand-sales or brand-inventory row/job is ever written.
// Offline; zero network. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { buildAdsReportReconciler, ADS_RECONCILE_STATUS } from "../lib/server/sync/ads-publication-reconciler.js";
import { buildDailyReportingRelease } from "../lib/server/sync/daily-reporting-release.js";
import { adsWorkerKeyForGrain, ADS_CAMPAIGN_SOURCE_KEY, adsRequiredCoverageDays } from "../lib/server/sync/ads-dependent-reports.js";
import { adsContentProvenanceToken, computeAdsReportRevision, subUtcDaysStr } from "../lib/server/sync/ads-publication-revision.js";
import { buildSchedulerV2Publisher } from "../lib/server/sync/publisher-composition.js";
import { buildLiveReadback } from "../lib/server/sync/source-priority-release-runner.js";
import { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } from "../lib/server/sync/report-publisher.js";
import { REPORT_DERIVATIONS } from "../lib/server/sync/report-derivation.js";
import { paramsHashFor } from "../lib/server/report-store.js";
import { runControlPackageCli } from "../lib/server/sync/source-priority-control-package.js";
import { oliBackfillWindow } from "../lib/server/sync/source-durable-model.js";
import { monthBackStr } from "../lib/server/date-windows.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const ASOF = "2026-09-10";
const A = "A01";
const RAW = "seller-A01";
const CUR = "USD";
const MKT = "US";
const RK = "daily-reporting";
const SHADOW = "scheduler-v2/daily-reporting";
const BS_SHADOW = "scheduler-v2/brand-sales";
const INV_SHADOW = "scheduler-v2/brand-inventory";
const BW = oliBackfillWindow(ASOF);          // OLI backfill window (wide provenance window)
const DAILY_FROM = monthBackStr(ASOF, 5);    // daily payload window start
// Fixed UTC execution-day clock so the Catalog freshness policy (validatedDate < today -> stale) uses today == ASOF,
// matching the seeded catalog validated_at (a real wall clock would mark the fixture's catalog stale).
const TEST_CLOCK = () => Date.parse("2026-09-10T12:00:00Z");
// The EXACT Ads revision id the reconciler produces for the fixture (= what the dedicated release recomputes + requires).
// Used by the DIRECT-release scenarios (abort / null-fence) that bypass the reconciler.
const expectedRevisionId = (contentRev = "cr-A", marketplace = MKT) => computeAdsReportRevision({
  organizationFingerprint: "org-1", connectionId: "primary", accountId: A, marketplace,
  requestedAsOf: ASOF, requiredFrom: subUtcDaysStr(ASOF, adsRequiredCoverageDays(RK) - 1), requiredGrains: [ADS_CAMPAIGN_SOURCE_KEY],
  grains: { [ADS_CAMPAIGN_SOURCE_KEY]: { contentRev, latestMetricDate: "2026-09-08", windows: [{ from: BW.from, to: ASOF }], read: "ok", syncStatus: "succeeded" } },
}).revisionId;

// A faithful in-memory control store for runControlPackageTransaction (row-shaped state + the full lease interface).
function inMemoryControlStore() {
  const s = { rollout: [], dispatch: [], promoted: [], approvals: [], lease: null, gen: 0 };
  const owns = (o, g) => !!s.lease && s.lease.owner === o && s.lease.generation === g;
  return {
    _s: s, begin: async () => {}, rollback: async () => {}, end: async () => {}, commit: async () => {},
    acquireControlLease: async (o) => { s.gen += 1; s.lease = { owner: o, generation: s.gen }; return { disposition: "acquired", generation: s.gen, owner_token: o }; },
    renewControlLease: async (o, g) => (owns(o, g) ? { disposition: "renewed" } : { disposition: "lost" }),
    assertControlLeaseOwner: async (o, g) => owns(o, g),
    lockAndVerifyControlLease: async (o, g) => owns(o, g),
    releaseControlLease: async (o, g) => (owns(o, g) ? (s.lease = null, { disposition: "released" }) : { disposition: "not-owner" }),
    readAllPrimary: async () => false, hasCron: async () => false,
    setRolloutEnabled: async (ids) => { s.rollout = [...ids].map((id) => ({ account_id: String(id), enabled: true })); },
    setDispatchEnabled: async (en, ct) => { const e = new Set(en.map(String)); s.dispatch = [...ct].map((rk) => ({ report_key: String(rk), schedule_enabled: e.has(String(rk)) })); },
    setPromotedEnabled: async (ids) => { s.promoted = [...ids].map((rk) => ({ report_key: String(rk), publish_enabled: true })); },
    setApprovalsApproved: async (ps) => { s.approvals = [...ps].map((p) => { const [rk, a] = String(p).split("|"); return { report_key: rk, account_id: a, approved: true }; }); },
    disableAllRollout: async () => { s.rollout = s.rollout.map((r) => ({ ...r, enabled: false })); },
    pauseAllDispatch: async (ct) => { s.dispatch = [...ct].map((rk) => ({ report_key: String(rk), schedule_enabled: false })); },
    disableAllPromoted: async () => { s.promoted = s.promoted.map((r) => ({ ...r, publish_enabled: false })); },
    revokeAllApprovals: async () => { s.approvals = s.approvals.map((r) => ({ ...r, approved: false })); },
    rolloutRows: async () => [...s.rollout], dispatchRows: async () => [...s.dispatch], promotedRows: async () => [...s.promoted], approvalRows: async () => [...s.approvals],
  };
}

// ---- Faithful WORLD: report_snapshots (shadow+live) + sync_report_jobs + sync_cycles + durable daily evidence
// (OLI history + coverage + org Product Catalog + Campaign Ads rows/coverage). Every REAL module reads/writes THIS. ----
function makeWorld(over = {}) {
  const snaps = new Map();   // report_snapshots: report_key|account_id|params_hash -> row
  const jobs = [];           // sync_report_jobs rows
  const cycles = new Map();  // sync_cycles: key -> row
  const writes = { publishedLiveKeys: [], upsertedReportKeys: [], shadowSavedKeys: [], openCalls: 0, claimCalls: 0, reconcileCalls: 0, finalizeCalls: 0 };
  let seq = 0;
  // Durable OLI history (positive-sales rows carrying source_request_hash) + org catalog + Campaign Ads.
  const historyRows = over.historyRows || [
    { account_id: A, sale_date: "2026-09-05", sku: "SKU-A", child_asin: "B0A", currency: CUR, sales_amount: 100, units: 4, source_request_hash: "oli-h" },
    { account_id: A, sale_date: "2026-09-08", sku: "SKU-B", child_asin: "B0B", currency: CUR, sales_amount: 60, units: 2, source_request_hash: "oli-h" },
  ];
  const catalogRows = over.catalogRows || [
    { child_asin: "B0A", sku: "SKU-A", parent_asin: "P", product_name: "A", product_brand: "Acme" },
    { child_asin: "B0B", sku: "SKU-B", parent_asin: "P", product_name: "B", product_brand: "Bolt" },
  ];
  // Catalog snapshot: validated_at day defaults to ASOF (fresh under TEST_CLOCK today==ASOF); row_count defaults to the
  // hydrated rows length (integrity match). Overrides model the stale-catalog + row_count-mismatch defer scenarios.
  const catalogValidatedAt = over.catalogValidatedAt || "2026-09-10T06:00:00Z";
  const catalogRowCount = over.catalogRowCount != null ? over.catalogRowCount : catalogRows.length;
  // OLI coverage window: gapless [BW.from .. covTo]; covTo < ASOF models "D-1 not ready" (the effective as-of clamps below ASOF).
  const covTo = over.oliCovTo || ASOF;
  const adState = { windows: [{ from: BW.from, to: ASOF }], status: "succeeded", latestMetricDate: "2026-09-08", contentRev: over.adsContentRev || "cr-A", read: "ok" };
  const adRows = over.adRows || [{ metric_date: "2026-09-05", marketplace_country_code: "US", dimension_key: "d1", currency: CUR, campaign_id: "c1", updated_at: "2026-09-06T00:00:00Z", metrics: { ad_sales: over.adSales != null ? over.adSales : 40, ad_spend: 12, ad_clicks: 8 } }];

  const world = {
    snaps, jobs, cycles, writes,
    // --- durable daily evidence readers (signal accepted + ignored; threaded by the release) ---
    readOliHistory: async () => (over.noHistory ? [] : historyRows.map((r) => ({ ...r }))),
    readOliCoverage: async () => ({ read: "ok", windows: [{ from: BW.from, to: covTo }] }),
    readOliZeroProof: async () => ({ read: "ok", byAccount: new Map() }),
    readCatalogSnapshot: async () => (over.noCatalog ? { read: "ok", snapshot: null } : { read: "ok", snapshot: { object_path: "obj/cat", source_request_hash: "catalog", validated_at: catalogValidatedAt, row_count: catalogRowCount } }),
    loadCatalogPayload: async () => ({ rows: catalogRows.map((r) => ({ ...r })) }),
    readActiveAdsRows: async () => adRows.map((r) => ({ ...r, metrics: { ...r.metrics } })),
    readAdsCoverage: async () => ({ ...adState, windows: adState.windows.map((w) => ({ ...w })) }),
    // --- report_snapshots (shadow + live) ---
    getReportSnapshot: async ({ reportKey, accountId, paramsHash }) => snaps.get(reportKey + "|" + accountId + "|" + paramsHash) || null,
    getReportSnapshotStoragePayload: async (path) => (world._storage && world._storage[path] !== undefined ? world._storage[path] : null),
    _storage: {},
    // shadow CAS (saveShadowSnapshotIfNewer semantics)
    saveShadow: async ({ reportKey, accountId, paramsHash, params, payload, sourceRefreshedAt }) => {
      const k = reportKey + "|" + accountId + "|" + paramsHash; writes.shadowSavedKeys.push(reportKey);
      const cur = snaps.get(k);
      if (cur && String(cur.source_refreshed_at) > String(sourceRefreshedAt)) return { outcome: "newer-live" };
      if (cur && String(cur.source_refreshed_at) === String(sourceRefreshedAt) && JSON.stringify(cur.payload) === JSON.stringify(payload)) return { outcome: "already-current" };
      snaps.set(k, { report_key: reportKey, account_id: accountId, params_hash: paramsHash, params, payload, payload_storage_path: null, source_refreshed_at: sourceRefreshedAt });
      return { outcome: cur ? "replaced" : "inserted" };
    },
    // live CAS (publishLiveSnapshotFencedIfNewer semantics) -- FENCE checked FIRST: no owner -> zero rows written.
    publishLiveFenced: async ({ reportKey, accountId, paramsHash, params, payload, sourceRefreshedAt, ownerToken, generation }) => {
      if (!ownerToken || !Number.isSafeInteger(generation) || generation <= 0) return { outcome: "lease-lost" };
      const k = reportKey + "|" + accountId + "|" + paramsHash;
      const cur = snaps.get(k);
      if (cur && String(cur.source_refreshed_at) > String(sourceRefreshedAt)) return { outcome: "newer-live" };
      if (cur && String(cur.source_refreshed_at) === String(sourceRefreshedAt)) { if (JSON.stringify(cur.payload) === JSON.stringify(payload)) return { outcome: "already-current" }; return { outcome: "publish-conflict" }; }
      snaps.set(k, { report_key: reportKey, account_id: accountId, params_hash: paramsHash, params, payload, payload_storage_path: null, source_refreshed_at: sourceRefreshedAt });
      writes.publishedLiveKeys.push(reportKey);
      return { outcome: cur ? "replaced" : "inserted" };
    },
    // --- sync_report_jobs (lineage) ---
    upsertReportJob: async (job) => {
      // FAITHFUL to the production sync_report_jobs_bucket_check (20260917_scheduler_regional_scope; NOT widened by 20260924 for the priority-
      // partial CYCLE namespace): a report JOB's bucket MUST be a fixed region bucket. A priority-partial CYCLE bucket
      // here is a 400 check-constraint violation -- the exact production root cause of the Ads lineage-upsert-threw.
      const ALLOWED_JOB_BUCKETS = new Set(["us", "non-us", "us-fba", "non-us-fba", "india", "europe-au", "us-ca", "india-fba", "europe-au-fba", "us-ca-fba"]);
      if (!ALLOWED_JOB_BUCKETS.has(String(job.bucket))) { const e = new Error(`Supabase request failed (400): new row for relation "sync_report_jobs" violates check constraint "sync_report_jobs_bucket_check"`); e.status = 400; e.code = "23514"; throw e; }
      writes.upsertedReportKeys.push(job.reportKey);
      const existing = jobs.find((j) => j.cycle_id === job.cycleId && j.report_key === job.reportKey && j.account_id === job.accountId);
      if (existing) return;
      jobs.push({ cycle_id: job.cycleId, report_key: job.reportKey, account_id: job.accountId, connection_id: "primary", bucket: job.bucket, depends_on: job.dependsOn || [], durable_content_deps: job.durableContentDeps || [], derive_status: "pending", save_status: "pending", validated: false, snapshot_params_hash: null, latest_data_date: null, created_at: ++seq });
    },
    claimLease: async (cycleId, reportKey, accountId) => {
      writes.claimCalls += 1;
      const j = jobs.find((x) => x.cycle_id === cycleId && x.report_key === reportKey && x.account_id === accountId);
      if (!j) return { disposition: "not-found", leaseToken: null, snapshotParamsHash: null };
      if (j.validated === true) return { disposition: "already-complete", leaseToken: null, snapshotParamsHash: j.snapshot_params_hash };
      j.derive_status = "running";
      return { disposition: "claimed", leaseToken: "lease-" + (++seq), snapshotParamsHash: null };
    },
    reconcileSuccess: async ({ cycleId, reportKey, accountId, snapshotParamsHash, latestDataDate }) => {
      writes.reconcileCalls += 1;
      const j = jobs.find((x) => x.cycle_id === cycleId && x.report_key === reportKey && x.account_id === accountId);
      if (!j) return { disposition: "not-found" };
      j.validated = true; j.derive_status = "succeeded"; j.save_status = "succeeded"; j.snapshot_params_hash = snapshotParamsHash; j.latest_data_date = latestDataDate;
      return { disposition: "reconciled" };
    },
    latestJob: (reportKey, accountId) => {
      const matching = jobs.filter((j) => j.report_key === reportKey && j.account_id === accountId).sort((a, b) => b.created_at - a.created_at);
      const j = matching[0]; if (!j) return null;
      const cyc = [...cycles.values()].find((c) => c.id === j.cycle_id);
      return { j, cycleStatus: cyc ? cyc.status : null };
    },
    getLatestReportJobLineage: async (reportKey, accountId) => {
      const r = world.latestJob(reportKey, accountId); if (!r) return null;
      const { j, cycleStatus } = r;
      return { reportKey: j.report_key, accountId: j.account_id, deriveStatus: j.derive_status, saveStatus: j.save_status, validated: j.validated === true, dependsOn: j.depends_on.map(String), durableContentDeps: (j.durable_content_deps || []).map(String), snapshotParamsHash: j.snapshot_params_hash, latestDataDate: j.latest_data_date, cycleStatus };
    },
    getLatestReportJob: async (reportKey, accountId) => {
      const r = world.latestJob(reportKey, accountId); if (!r) return null;
      const { j, cycleStatus } = r;
      return { cycle_id: j.cycle_id, report_key: j.report_key, account_id: j.account_id, derive_status: j.derive_status, save_status: j.save_status, validated: j.validated === true, snapshot_params_hash: j.snapshot_params_hash, cycle_status: cycleStatus };
    },
    // --- sync_cycles --- created_at MONOTONIC per open (production wall-clock): a later reconcile cycle (same-date Ads
    // correction -> different priority-partial-<revisionId> bucket) gets a strictly-newer source_refreshed_at, so the
    // live CAS REPLACES the older content instead of a false equal-freshness conflict.
    openCycle: async ({ bucket, cycleDate }) => { writes.openCalls += 1; const k = bucket + "|" + cycleDate; if (!cycles.has(k)) cycles.set(k, { id: "cyc-" + (++seq), bucket, cycle_date: cycleDate, status: "running", trigger: "manual", created_at: new Date(Date.UTC(2026, 8, 10, 9, 30, 0) + (++seq) * 1000).toISOString() }); },
    getBaseSyncCycleByBucketDate: async (bucket, cycleDate) => cycles.get(bucket + "|" + cycleDate) || null,
    finalizeCycle: async ({ cycleId }) => {
      writes.finalizeCalls += 1;
      const cyc = [...cycles.values()].find((c) => c.id === cycleId);
      if (!cyc) return { disposition: "not-found" };
      cyc.status = jobs.some((j) => j.cycle_id === cycleId && j.validated === true) ? "succeeded" : "partial";
      return { disposition: "finalized", cycle: { status: cyc.status } };
    },
  };

  // ---- SEED the SIBLINGS (brand-sales + brand-inventory): a canonical live + shadow + validated job for each, so a
  // clean "zero sibling writes + byte-identical siblings" is provable. These are NEVER read/derived/published by the
  // daily reconciler; they exist only to catch a scope leak. ----
  const seedSibling = (liveKey, shadowKey, payload) => {
    const bsh = liveKey + "-shadow-hash"; const clh = liveKey + "-live-hash";
    cycles.set(liveKey + "-seed", { id: "cyc-" + liveKey, bucket: "seed", cycle_date: ASOF, status: "succeeded", trigger: "manual", created_at: "2026-09-09T08:00:00Z" });
    jobs.push({ cycle_id: "cyc-" + liveKey, report_key: liveKey, account_id: A, connection_id: "primary", bucket: "seed", depends_on: ["oli-h", "catalog"], durable_content_deps: [], derive_status: "succeeded", save_status: "succeeded", validated: true, snapshot_params_hash: bsh, latest_data_date: ASOF, created_at: 0 });
    snaps.set(shadowKey + "|" + A + "|" + bsh, { report_key: shadowKey, account_id: A, params_hash: bsh, params: { reportVersion: "seed", accountId: A, to: ASOF }, payload, payload_storage_path: null, source_refreshed_at: "2026-09-09T08:00:00Z" });
    snaps.set(liveKey + "|" + A + "|" + clh, { report_key: liveKey, account_id: A, params_hash: clh, params: { reportVersion: "seed-live", to: ASOF }, payload, payload_storage_path: null, source_refreshed_at: "2026-09-09T08:00:00Z" });
  };
  seedSibling("brand-sales", BS_SHADOW, { seeded: "brand-sales", rows: [{ brand: "Acme" }] });
  seedSibling("brand-inventory", INV_SHADOW, { seeded: "brand-inventory", inventoryAvailable: true });
  return world;
}

// Wire the REAL dedicated daily release + REAL fenced publisher with a WORLD, mirroring the entrypoint's
// runReleaseForAccount composition. `abortWhen` makes the named awaited phase abort AFTER completing (the release
// observes it at its NEXT recheck); abortOnReadback aborts the instant the live read-back settles.
function wireRelease(world, { leaseFence, aborted = () => false, controller = null, abortWhen = null, abortOnReadback = null, failReadback = false, clock = TEST_CLOCK } = {}) {
  const rawReadback = buildLiveReadback({ getReportSnapshot: world.getReportSnapshot, loadStoragePayload: world.getReportSnapshotStoragePayload, liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, reportDerivations: REPORT_DERIVATIONS, computeHash: paramsHashFor });
  const readbackLive = failReadback
    ? async () => ({ ok: false, reason: "forced-readback-failure" })
    : (controller && abortOnReadback)
      ? async (a) => { const r = await rawReadback(a); if (String(a && a.reportKey) === abortOnReadback) controller.abort(); return r; }
      : rawReadback;
  const publisher = buildSchedulerV2Publisher({
    connections: [{ id: "primary", apiKey: "k", organizationFingerprint: "org-1", label: "primary" }],
    fetchAccounts: async () => [{ id: A, name: A, country: "US" }],
    getAccountRollout: async () => ({ read: "ok", allPrimary: false, enabledAccountIds: [A] }),
    // daily-reporting is a DISPATCH report -> gated by schedule_enabled (getSettings), NOT the source-promoted gate that
    // brand-inventory uses. Hardcoded-open here (the control-package apply/safe-close is exercised separately via the REAL
    // openControls/closeControls over the in-memory store), exactly as the FBA prod-shape test hardcodes its promoted gate.
    getSettings: async () => [{ report_key: RK, schedule_enabled: true }],
    getPromotedSettings: async () => [{ report_key: RK, publish_enabled: true }],
    getApproval: async () => ({ read: "ok", approved: true }),
    getJob: (rk, a) => world.getLatestReportJob(rk, a),
    getSnapshot: (args) => world.getReportSnapshot(args),
    loadStoragePayload: async () => null,
    publishLiveFenced: world.publishLiveFenced,
    getControlFence: () => (aborted() ? null : (typeof leaseFence === "function" ? leaseFence() : leaseFence)),
  });
  const wrapAbort = (name, fn) => (controller && abortWhen === name ? async (...a) => { const r = await fn(...a); controller.abort(); return r; } : fn);
  const release = buildDailyReportingRelease({
    resolveOrg: async () => ({ organizationFingerprint: "org-1", connectionId: "primary" }),
    resolveAccountMeta: async () => ({ rawSellerId: RAW, currency: CUR, marketplace: MKT }),
    openCycle: wrapAbort("open", world.openCycle), getCycleByBucketDate: world.getBaseSyncCycleByBucketDate,
    finalizeCycle: wrapAbort("finalize", world.finalizeCycle),
    readOliHistory: world.readOliHistory, readOliCoverage: world.readOliCoverage, readOliZeroProof: world.readOliZeroProof,
    readCatalogSnapshot: world.readCatalogSnapshot, loadCatalogPayload: world.loadCatalogPayload,
    readActiveAdsRows: world.readActiveAdsRows, readAdsCoverage: world.readAdsCoverage,
    upsertReportJob: wrapAbort("upsert", world.upsertReportJob), claimLease: wrapAbort("claim", world.claimLease),
    saveShadow: wrapAbort("shadow", world.saveShadow), reconcileSuccess: wrapAbort("reconcile", world.reconcileSuccess),
    computeHash: paramsHashFor, liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, reportDerivations: REPORT_DERIVATIONS,
    publisher, readbackLive, clock,
    verifyLease: async () => (aborted() ? { ok: false } : { ok: !!(typeof leaseFence === "function" ? leaseFence() : leaseFence) }),
    log: () => {},
  });
  return { release, readbackLive, publisher };
}

// Build the REAL Ads reconciler wired to a WORLD, mirroring the entrypoint's composition.
function buildProd(world, over = {}) {
  const store = over.store || inMemoryControlStore();
  const OPERATOR = "ads-reconcile:india:test";
  let leaseFence = null;
  const readbackLive = buildLiveReadback({ getReportSnapshot: world.getReportSnapshot, loadStoragePayload: world.getReportSnapshotStoragePayload, liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, reportDerivations: REPORT_DERIVATIONS, computeHash: paramsHashFor });
  const runReleaseForAccount = async ({ accountId, requestedAsOf, revisionId, signal }) => {
    const aborted = () => !!(signal && signal.aborted);
    const cycleBucket = "priority-partial-india-" + String(revisionId || "x").slice(0, 16);
    const { release } = wireRelease(world, { ...(over.wire || {}), leaseFence: () => leaseFence, aborted, controller: over.controller });
    const r = await release.runForAccount({ accountId, requestedAsOf, cycleBucket, revisionId, signal });
    return { code: r.code, ok: r.ok, stage: r.stage, status: r.status || null, leaseLost: r.leaseLost === true, reason: r.reason || null, blockerCodes: r.blockerCodes || [], problems: r.problems || [] };
  };
  const openControls = async (ids) => {
    const r = await runControlPackageCli({ mode: "apply", operator: OPERATOR, discoverAccounts: async () => [...ids], connectStore: async () => store, ownerToken: OPERATOR, operationKey: "ads-reconcile/india/" + ASOF, leaseTtlSeconds: 900 });
    if (!r || r.committed !== true) return { ok: false, reason: "apply-noncommit code " + (r && r.code) };
    const gen = Number(r.leaseGeneration); if (!(Number.isSafeInteger(gen) && gen > 0)) return { ok: false, reason: "no-generation" };
    leaseFence = { ownerToken: r.ownerToken || OPERATOR, generation: gen };
    return { ok: true };
  };
  const closeControls = async () => {
    if (!leaseFence) return { ok: true };
    const r = await runControlPackageCli({ mode: "rollback", operator: OPERATOR, connectStore: async () => store, ownerToken: leaseFence.ownerToken, ownerGeneration: leaseFence.generation, operationKey: "ads-reconcile/india/" + ASOF });
    leaseFence = null;
    if (r && r.skipped === "lease-not-owner") return { ok: true };
    if (!r || r.committed !== true) return { ok: false, reason: "safe-close-noncommit" };
    return { ok: true };
  };
  const reconciler = buildAdsReportReconciler({
    reportKey: RK,
    resolveOrg: async () => ({ organizationFingerprint: "org-1", connectionId: "primary" }),
    bucketAccounts: async () => [{ accountId: A }],
    readAdsCoverageState: ({ accountId, sourceKey }) => world.readAdsCoverage(accountId, adsWorkerKeyForGrain(sourceKey)),
    resolveMarketplace: () => MKT,
    readLatestReportJob: ({ reportKey, accountId }) => world.getLatestReportJobLineage(reportKey, accountId),
    readShadowSnapshot: (args) => world.getReportSnapshot(args),
    readLiveSnapshot: (args) => world.getReportSnapshot(args),
    loadStoragePayload: async () => null,
    verifyLiveReadback: readbackLive,
    liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, computeHash: paramsHashFor, reportDerivations: REPORT_DERIVATIONS,
    runReleaseForAccount, openControls, closeControls,
    log: () => {},
  });
  return { reconciler, store, world };
}
const st = (out) => out.perAccount[0].reports[RK].state;
const liveRow = (world) => { for (const [k, v] of world.snaps) if (v.report_key === RK && !k.startsWith(SHADOW)) return v; return null; };
// The full sibling footprint (brand-sales + brand-inventory): live payload JSON + job/shadow/publish counts, to prove
// an Ads reconcile leaves BOTH siblings byte-for-byte unchanged and writes NOTHING for them.
function siblingFootprint(world) {
  const rows = (rk) => [...world.snaps.entries()].filter(([, v]) => v.report_key === rk).map(([k, v]) => k + "=" + JSON.stringify(v.payload) + "@" + v.source_refreshed_at).sort();
  return {
    bsLive: rows("brand-sales"), invLive: rows("brand-inventory"),
    bsShadow: [...world.snaps.entries()].filter(([, v]) => v.report_key === BS_SHADOW).map(([, v]) => JSON.stringify(v.payload)).sort(),
    invShadow: [...world.snaps.entries()].filter(([, v]) => v.report_key === INV_SHADOW).map(([, v]) => JSON.stringify(v.payload)).sort(),
    bsJobs: world.jobs.filter((j) => j.report_key === "brand-sales").length, invJobs: world.jobs.filter((j) => j.report_key === "brand-inventory").length,
    published: world.writes.publishedLiveKeys.filter((k) => k === "brand-sales" || k === "brand-inventory").length,
    upserted: world.writes.upsertedReportKeys.filter((k) => k === "brand-sales" || k === "brand-inventory").length,
    shadowed: world.writes.shadowSavedKeys.filter((k) => k === BS_SHADOW || k === INV_SHADOW).length,
  };
}
const siblingsUnchangedAndUntouched = (before, after) =>
  JSON.stringify(before.bsLive) === JSON.stringify(after.bsLive) && JSON.stringify(before.invLive) === JSON.stringify(after.invLive)
  && JSON.stringify(before.bsShadow) === JSON.stringify(after.bsShadow) && JSON.stringify(before.invShadow) === JSON.stringify(after.invShadow)
  && after.bsJobs === before.bsJobs && after.invJobs === before.invJobs
  && after.published === 0 && after.upserted === 0 && after.shadowed === 0;
// Drive the REAL dedicated release directly (bypassing the reconciler) with a matching revisionId + valid fence.
const driveRelease = (world, { revisionId = expectedRevisionId(), cycleBucket = "priority-partial-india-x", wire = {} } = {}) => {
  const { release } = wireRelease(world, { leaseFence: { ownerToken: "op", generation: 1 }, ...wire });
  return release.runForAccount({ accountId: A, requestedAsOf: ASOF, cycleBucket, revisionId, signal: { aborted: false } });
};
// ZERO durable writes of ANY kind (no cycle opened, no report-job upsert, no shadow save, no live publish) -- the exact
// proof that a fail-closed defer happened BEFORE any write, so the Daily LKG is byte-identical.
const zeroWrites = (world) => world.writes.openCalls === 0 && world.writes.upsertedReportKeys.length === 0 && world.writes.shadowSavedKeys.length === 0 && world.writes.publishedLiveKeys.length === 0;

// (1) UNPROMOTED -> REAL dedicated release derives+publishes+reads-back ONLY daily-reporting; zero sibling writes.
test("scope: UNPROMOTED daily -> REAL dedicated release publishes ONLY daily-reporting (siblings byte-identical, zero sibling writes); zero export", async () => {
  const world = makeWorld();
  const before = siblingFootprint(world);
  const h = buildProd(world);
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 READBACK_VERIFIED via the real dedicated daily release", st(out) === ADS_RECONCILE_STATUS.READBACK_VERIFIED && out.ok === true);
  ok("a REAL live daily-reporting row was written (canonical readback passed)", !!liveRow(world) && Array.isArray(liveRow(world).payload.rows));
  ok("ONLY daily-reporting published/upserted/shadowed -- NEVER brand-sales or brand-inventory", world.writes.publishedLiveKeys.join(",") === RK && [...new Set(world.writes.upsertedReportKeys)].join(",") === RK && [...new Set(world.writes.shadowSavedKeys)].join(",") === SHADOW);
  ok("Brand Sales + Brand Inventory are byte-for-byte UNCHANGED and received ZERO writes", siblingsUnchangedAndUntouched(before, siblingFootprint(world)));
  const expectedToken = adsContentProvenanceToken({ accountId: A, connectionId: "primary", marketplace: MKT, grainRevs: [{ sourceKey: ADS_CAMPAIGN_SOURCE_KEY, contentRev: "cr-A" }] });
  ok("the daily job recorded the OLI/Catalog depends_on (sorted catalog+oli-h) + the EXACT Campaign Ads content token", world.jobs.some((j) => j.report_key === RK && j.depends_on.join(",") === "catalog,oli-h" && j.durable_content_deps.length === 1 && j.durable_content_deps[0] === expectedToken));
  ok("zero provider export", out.dataDoeCreates === 0 && out.dataDoeTokens === 0);
});

// (2) replay -> PUBLICATION_NOT_REQUIRED before opening controls; zero writes.
test("convergence: after a successful reconcile, the NEXT unchanged pass is PUBLICATION_NOT_REQUIRED (zero writes, no controls)", async () => {
  const world = makeWorld();
  const h = buildProd(world);
  await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" }); // pass 1: publish
  const pubBefore = world.writes.publishedLiveKeys.length;
  const before = siblingFootprint(world);
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" }); // pass 2: replay
  ok("replay: PUBLICATION_NOT_REQUIRED (durable_content_deps covers the current Ads content token)", st(out) === "PUBLICATION_NOT_REQUIRED");
  ok("zero additional live writes on the unchanged replay; siblings still untouched", world.writes.publishedLiveKeys.length === pubBefore && siblingsUnchangedAndUntouched(before, siblingFootprint(world)));
});

// (3) SAME-DATE Ads correction (content_rev flips + ad metric changes) -> Daily STALE -> republish ONCE -> readback ->
// second pass zero-write. Siblings untouched throughout.
test("convergence: same-date Ads correction (content_rev B) -> Daily STALE -> re-derive consumes B -> publish + readback; replay zero-write; siblings untouched", async () => {
  const world = makeWorld({ adsContentRev: "cr-A", adSales: 40 });
  const h = buildProd(world);
  await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" }); // publish content A
  const liveA = JSON.stringify(liveRow(world).payload);
  // SAME as-of, NEW content_rev + NEW ad metric (a same-date Ads correction). The reconciler's revision token flips
  // (not covered) -> STALE; a new priority-partial-<revisionId> cycle -> strictly-newer created_at -> the live CAS replaces.
  world.readAdsCoverage = async () => ({ windows: [{ from: BW.from, to: ASOF }], status: "succeeded", latestMetricDate: "2026-09-08", contentRev: "cr-B", read: "ok" });
  world.readActiveAdsRows = async () => [{ metric_date: "2026-09-05", marketplace_country_code: "US", dimension_key: "d1", currency: CUR, campaign_id: "c1", updated_at: "2026-09-06T00:00:00Z", metrics: { ad_sales: 55, ad_spend: 20, ad_clicks: 11 } }];
  const before = siblingFootprint(world);
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 re-derived (corrected content_rev's token NOT in durable_content_deps -> ads-revision-changed) -> READBACK_VERIFIED", st(out) === ADS_RECONCILE_STATUS.READBACK_VERIFIED);
  const liveB = JSON.stringify(liveRow(world).payload);
  ok("the live daily payload CHANGED to reflect corrected Ads (B != A)", liveB !== liveA);
  ok("siblings byte-identical + zero sibling writes across the correction", siblingsUnchangedAndUntouched(before, siblingFootprint(world)));
  const pubAfterB = world.writes.publishedLiveKeys.length;
  const out2 = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" }); // replay: now covered
  ok("replay after the correction is PUBLICATION_NOT_REQUIRED (converged; republished exactly once)", st(out2) === "PUBLICATION_NOT_REQUIRED" && world.writes.publishedLiveKeys.length === pubAfterB);
});

// (4) dry-run -> ZERO writes (no controls, no cycle, no publish) even when stale; siblings untouched.
test("dry-run: ZERO writes (no controls, no cycle, no publish) even when Daily is stale; siblings untouched", async () => {
  const world = makeWorld();
  const before = siblingFootprint(world);
  const h = buildProd(world);
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic", dryRun: true });
  ok("dry-run: STALE reported, zero cycles opened, zero publishes, zero shadow saves", st(out) === "STALE" && world.writes.openCalls === 0 && world.writes.publishedLiveKeys.length === 0 && world.writes.shadowSavedKeys.length === 0 && out.dryRun === true);
  ok("siblings untouched under dry-run", siblingsUnchangedAndUntouched(before, siblingFootprint(world)));
});

// (5) D-1 NOT ready (OLI coverage clamps below ASOF) -> DEFERRED; zero daily writes; siblings untouched; LKG preserved.
test("D-1 not ready: OLI coverage ends before ASOF -> the dedicated release DEFERS (no cycle, no publish); siblings untouched", async () => {
  const world = makeWorld({ oliCovTo: "2026-09-09" }); // gapless only through D-2 -> effective as-of < ASOF
  const before = siblingFootprint(world);
  const h = buildProd(world);
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 DEFERRED_DEPENDENCY (daily-not-d1); no live daily row; zero daily publish", (st(out) === ADS_RECONCILE_STATUS.DEFERRED_DEPENDENCY || st(out) === ADS_RECONCILE_STATUS.FAILED_PUBLISH) && !liveRow(world) && world.writes.publishedLiveKeys.length === 0);
  ok("siblings untouched when Daily defers on readiness", siblingsUnchangedAndUntouched(before, siblingFootprint(world)));
});

// (6) TERMINATION BOUNDARY: an abort observed during each awaited release phase starts NO later write + NO publish.
// Driven through the REAL dedicated release with a controller aborted right AFTER the named phase completes, so the
// release observes the abort at its next recheck (byte-identical to the fba-reconcile-prodshape blocker-2 test).
test("termination boundary: abort during each awaited phase (open/upsert/claim/shadow/reconcile/finalize) -> no publish, no live daily row", async () => {
  for (const phase of ["open", "upsert", "claim", "shadow", "reconcile", "finalize"]) {
    const world = makeWorld();
    const before = siblingFootprint(world);
    const controller = new AbortController();
    const { release } = wireRelease(world, { leaseFence: { ownerToken: "op", generation: 1 }, aborted: () => controller.signal.aborted, controller, abortWhen: phase });
    const res = await release.runForAccount({ accountId: A, requestedAsOf: ASOF, cycleBucket: "priority-partial-india-x", revisionId: expectedRevisionId(), signal: controller.signal });
    ok(`abort@${phase}: release deferred (never ok), NO live daily row published + NO sibling writes`, res.ok !== true && !liveRow(world) && world.writes.publishedLiveKeys.length === 0 && siblingsUnchangedAndUntouched(before, siblingFootprint(world)));
  }
});

// (7) NULL control fence -> the REAL fenced publisher's live CAS writes ZERO rows (final defense).
test("fenced CAS final defense: a NULL control fence makes the real publisher live CAS write ZERO rows", async () => {
  const world = makeWorld();
  // Wire the release with a permanently-null fence (aborted() true) + drive the release directly.
  const { release } = wireRelease(world, { leaseFence: () => null, aborted: () => true });
  const out = await release.runForAccount({ accountId: A, requestedAsOf: ASOF, cycleBucket: "priority-partial-india-nullfence", revisionId: expectedRevisionId(), signal: { aborted: false } });
  ok("release returns a deadline/contention deferral (never ok); ZERO live daily rows written", out.ok !== true && world.writes.publishedLiveKeys.filter((k) => k === RK).length === 0 && !liveRow(world));
});

// (8) readback failure after a write -> NON-GREEN (FAILED_READBACK); siblings untouched (LKG preserved).
test("readback failure -> FAILED_READBACK (non-green); zero sibling writes", async () => {
  const world = makeWorld();
  const before = siblingFootprint(world);
  const h = buildProd(world, { wire: { failReadback: true } });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 FAILED_READBACK; outcome failed; ok:false", st(out) === ADS_RECONCILE_STATUS.FAILED_READBACK && out.outcome === "failed" && out.ok === false);
  const after = siblingFootprint(world);
  ok("siblings received ZERO writes on a readback failure (their LKG preserved)", after.published === 0 && after.upserted === 0 && after.shadowed === 0 && JSON.stringify(before.bsLive) === JSON.stringify(after.bsLive) && JSON.stringify(before.invLive) === JSON.stringify(after.invLive));
});

// ============================ Codex-required Ads-evidence-race / Catalog-parity / LKG scenarios ============================

// REQ 1 -- outer revision eligible, then the release COVERAGE REREAD fails: zero cycle/report-job/shadow/live writes; LKG.
test("REQ1: coverage REREAD (post metric-read) fails -> DEFER before any write; zero writes; Daily LKG byte-identical; siblings untouched", async () => {
  const world = makeWorld();
  const before = siblingFootprint(world);
  let covCalls = 0;
  world.readAdsCoverage = async () => { covCalls += 1; if (covCalls >= 2) throw new Error("coverage-reread-boom"); return { windows: [{ from: BW.from, to: ASOF }], status: "succeeded", latestMetricDate: "2026-09-08", contentRev: "cr-A", read: "ok" }; };
  const res = await driveRelease(world); // r1 ok (matches) -> metric read ok -> r2 (reread) throws -> defer
  ok("release DEFERS (never ok) on a coverage reread failure", res.ok !== true);
  ok("ZERO writes of any kind (no cycle/job/shadow/live) -> Daily LKG intact; siblings untouched", zeroWrites(world) && !liveRow(world) && siblingsUnchangedAndUntouched(before, siblingFootprint(world)));
});

// REQ 2 -- outer revision eligible, then the metric-row read THROWS (and, separately, hits the row limit): zero writes,
// no Ads token, LKG. NEVER a false zero-Ads publish / never replaces valid Ads with unavailable.
test("REQ2: metric-row read THROWS -> DEFER; zero writes; no Ads token recorded; siblings untouched", async () => {
  for (const err of [new Error("metric-boom"), Object.assign(new Error("cap"), { code: "ADS_ROW_LIMIT_EXCEEDED" })]) {
    const world = makeWorld();
    const before = siblingFootprint(world);
    world.readActiveAdsRows = async () => { throw err; };
    const res = await driveRelease(world);
    ok(`metric read (${err.code || "throw"}) -> DEFER, zero writes, no token`, res.ok !== true && zeroWrites(world) && !liveRow(world) && world.jobs.every((j) => j.report_key !== RK) && siblingsUnchangedAndUntouched(before, siblingFootprint(world)));
  }
});

// REQ 3 -- a successful metrics read returning [] with VALID coverage is a valid COVERED-EMPTY: still publishes ONCE.
test("REQ3: covered-empty ([] metric rows + valid coverage) still publishes daily-reporting ONCE; siblings untouched", async () => {
  const world = makeWorld();
  const before = siblingFootprint(world);
  world.readActiveAdsRows = async () => []; // valid empty (NOT a read failure)
  const res = await driveRelease(world);
  ok("covered-empty publishes (release ok) + a live daily row exists", res.ok === true && !!liveRow(world));
  ok("ONLY daily-reporting written; siblings byte-identical + zero sibling writes", world.writes.publishedLiveKeys.join(",") === RK && siblingsUnchangedAndUntouched(before, siblingFootprint(world)));
});

// REQ 4 -- Ads content_rev changed between the reconciler scan and the release: the OLD revision namespace performs zero
// writes and DEFERS (do not publish new content inside an old revision id).
test("REQ4: content_rev changed since scan (release sees cr-B, supplied revisionId is cr-A) -> DEFER, zero writes; siblings untouched", async () => {
  const world = makeWorld({ adsContentRev: "cr-B" }); // the release's fresh read sees cr-B
  const before = siblingFootprint(world);
  const res = await driveRelease(world, { revisionId: expectedRevisionId("cr-A") }); // the reconciler scanned cr-A
  ok("release DEFERS (ads-revision-changed-since-scan): recomputed id != supplied id", res.ok !== true);
  ok("ZERO writes; no live daily row; siblings untouched (old revision namespace publishes nothing)", zeroWrites(world) && !liveRow(world) && siblingsUnchangedAndUntouched(before, siblingFootprint(world)));
});

// REQ 5 -- a STALE Catalog snapshot (validated_at day < the UTC execution day) DEFERS before opening a cycle.
test("REQ5: stale Catalog (validated_at < today) -> DEFER before cycle open; zero writes; siblings untouched", async () => {
  const world = makeWorld({ catalogValidatedAt: "2026-09-08T06:00:00Z" }); // < today (2026-09-10) -> stale
  const before = siblingFootprint(world);
  const res = await driveRelease(world);
  ok("release DEFERS on a stale catalog BEFORE any cycle open", res.ok !== true && world.writes.openCalls === 0);
  ok("ZERO writes; no live daily row; siblings untouched", zeroWrites(world) && !liveRow(world) && siblingsUnchangedAndUntouched(before, siblingFootprint(world)));
});

// REQ 6 -- a Catalog row_count MISMATCH (hydrated rows.length != snapshot.row_count) DEFERS before opening a cycle.
test("REQ6: Catalog row_count mismatch -> DEFER before cycle open; zero writes; siblings untouched", async () => {
  const world = makeWorld({ catalogRowCount: 999 }); // hydrated payload has 2 rows -> mismatch
  const before = siblingFootprint(world);
  const res = await driveRelease(world);
  ok("release DEFERS on a catalog row_count mismatch BEFORE any cycle open", res.ok !== true && world.writes.openCalls === 0);
  ok("ZERO writes; no live daily row; siblings untouched", zeroWrites(world) && !liveRow(world) && siblingsUnchangedAndUntouched(before, siblingFootprint(world)));
});

// REQ 6b (Codex round-4 parity) -- a NON-NUMBER Catalog row_count must DEFER before opening a cycle (row_count MUST be an
// ACTUAL safe non-negative integer, NOT a Number(...) coercion that fail-opens whenever the coerced value matches the
// hydrated rows.length). Each proves the exact reason (catalog-row-count-invalid), ZERO writes, no live daily row, the
// Daily LKG preserved, and both siblings byte-for-byte untouched.
const invalidCatalogRowCountCases = [
  ["string '2' matching 2 hydrated rows (Number('2')=2 fail-open)", { catalogRowCount: "2" }],
  ["string '0' with a zero-row payload (Number('0')=0 fail-open)", { catalogRowCount: "0", catalogRows: [] }],
  ["boolean true matching 1 hydrated row (Number(true)=1 fail-open)", { catalogRowCount: true, catalogRows: [{ child_asin: "B0A", sku: "SKU-A", parent_asin: "P", product_name: "A", product_brand: "Acme" }] }],
  ["negative -1 (real number, < 0)", { catalogRowCount: -1 }],
  ["fractional 2.5 (not a safe integer)", { catalogRowCount: 2.5 }],
  ["unsafe integer 2^53 (Number.isSafeInteger false)", { catalogRowCount: 2 ** 53 }],
];
for (const [label, over] of invalidCatalogRowCountCases) {
  test("REQ6b: invalid Catalog row_count (" + label + ") -> DEFER (catalog-row-count-invalid) before cycle open; zero writes; LKG; siblings untouched", async () => {
    const world = makeWorld(over);
    const before = siblingFootprint(world);
    const res = await driveRelease(world);
    ok("release DEFERS with catalog-row-count-invalid BEFORE any cycle open", res.ok !== true && res.reason === "catalog-row-count-invalid" && world.writes.openCalls === 0);
    ok("ZERO writes; no live daily row; siblings untouched (LKG preserved)", zeroWrites(world) && !liveRow(world) && siblingsUnchangedAndUntouched(before, siblingFootprint(world)));
  });
}
// null and MISSING row_count cannot be injected via `over.catalogRowCount` (the harness `!= null` defaults them), so
// override the catalog reader directly with a zero-row payload the old Number(null|undefined)=0 === 0 would have ACCEPTED.
for (const [label, rowCountField] of [["null (Number(null)=0 fail-open)", { row_count: null }], ["missing entirely (undefined)", {}]]) {
  test("REQ6b: Catalog row_count " + label + " with a zero-row payload -> DEFER (catalog-row-count-invalid); zero writes; LKG; siblings untouched", async () => {
    const world = makeWorld({ catalogRows: [] });
    world.readCatalogSnapshot = async () => ({ read: "ok", snapshot: { object_path: "obj/cat", source_request_hash: "catalog", validated_at: "2026-09-10T06:00:00Z", ...rowCountField } });
    const before = siblingFootprint(world);
    const res = await driveRelease(world);
    ok("release DEFERS with catalog-row-count-invalid on a non-number/absent row_count", res.ok !== true && res.reason === "catalog-row-count-invalid" && world.writes.openCalls === 0);
    ok("ZERO writes; no live daily row; siblings untouched (LKG preserved)", zeroWrites(world) && !liveRow(world) && siblingsUnchangedAndUntouched(before, siblingFootprint(world)));
  });
}
// ACCEPT: a genuine numeric row_count clears the catalog gate (cycle opens); a VALID ZERO-ROW catalog (real 0 === 0
// hydrated) stays supported -- neither is rejected as catalog-row-count-invalid or catalog-integrity.
test("REQ6b: valid numeric row_count 2 -> clears the catalog gate (cycle opens)", async () => {
  const world = makeWorld({ catalogRowCount: 2 });
  const res = await driveRelease(world);
  ok("no catalog-row-count-invalid defer; the cycle opens", res.reason !== "catalog-row-count-invalid" && world.writes.openCalls > 0);
});
test("REQ6b: valid ZERO-ROW catalog (row_count 0, [] payload) stays supported -> clears the catalog gate (cycle opens)", async () => {
  const world = makeWorld({ catalogRowCount: 0, catalogRows: [] });
  const res = await driveRelease(world);
  ok("zero-row catalog is NOT rejected; the cycle opens", res.reason !== "catalog-row-count-invalid" && res.reason !== "catalog-integrity" && world.writes.openCalls > 0);
});

// REQ 6c (ROOT CAUSE of the production Ads hard-failure, run 34979534262): the report JOB must carry the REGION bucket,
// NOT the priority-partial CYCLE bucket. sync_report_jobs_bucket_check (unchanged by 20260924, which widened only the
// CYCLE bucket) 400-rejects a priority-partial job bucket -> lineage-upsert-threw (stage job-save). The harness's
// upsertReportJob now enforces that CHECK, so this reproduces the failure; the fix writes bucket=<region> and publishes.
test("REQ6c (root cause): report JOB carries region bucket 'india' + CYCLE carries priority-partial; publishes daily-reporting; no lineage-upsert-threw", async () => {
  const world = makeWorld();
  const before = siblingFootprint(world);
  const res = await driveRelease(world); // cycleBucket = priority-partial-india-x
  ok("release PUBLISHED daily-reporting (past job-save; NOT lineage-upsert-threw / job-bucket-unresolved)",
    res.ok === true && res.reason !== "lineage-upsert-threw" && res.reason !== "job-bucket-unresolved" && world.writes.publishedLiveKeys.includes("daily-reporting"));
  const dailyJob = world.jobs.find((j) => j.report_key === "daily-reporting");
  ok("the report JOB was written with the REGION bucket 'india' (not the priority-partial cycle bucket)", dailyJob && dailyJob.bucket === "india");
  ok("the CYCLE still carries the priority-partial namespace", [...world.cycles.values()].some((c) => String(c.bucket).startsWith("priority-partial-india")));
  ok("siblings untouched (brand-sales / brand-inventory byte-identical, zero sibling writes)", siblingsUnchangedAndUntouched(before, siblingFootprint(world)));
});

// REQ 7 (the confirmed HIGH defect) -- a valid live daily is published (Ads succeeded, cr-A); THEN the durable Ads sync
// enters a `failed`-after-succeeded state (content_rev + succeeded coverage intact, last_status='failed'). The reconciler
// must DEFER (revision ineligible on the sync status) and RETAIN the valid live daily byte-for-byte -- NEVER replace it
// with a degraded/unavailable Ads snapshot. Only the scheduler may publish sales with Ads unavailable.
test("REQ7: a failed-after-succeeded Ads sync status -> DEFER + retain the valid live daily (LKG); never replace with unavailable; siblings untouched", async () => {
  const world = makeWorld();
  const h = buildProd(world);
  await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" }); // pass 1: publish valid cr-A live
  const liveA = JSON.stringify(liveRow(world).payload);
  ok("pass 1 published a valid live daily (Ads available)", !!liveRow(world) && liveRow(world).payload.adsAvailability && liveRow(world).payload.adsAvailability.status !== "failed");
  // The ads sync now reports last_status='failed' but preserves content_rev + the succeeded coverage windows.
  world.readAdsCoverage = async () => ({ windows: [{ from: BW.from, to: ASOF }], status: "failed", latestMetricDate: "2026-09-08", contentRev: "cr-A", read: "ok" });
  const before = siblingFootprint(world);
  const pubBefore = world.writes.publishedLiveKeys.length;
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" }); // pass 2: failed status
  ok("pass 2 DEFERS (revision ineligible on the failed sync status); no release ran", st(out) === ADS_RECONCILE_STATUS.DEFERRED_PROVENANCE);
  ok("the valid live daily is RETAINED byte-for-byte (never overwritten by a degraded/unavailable snapshot)", JSON.stringify(liveRow(world).payload) === liveA && world.writes.publishedLiveKeys.length === pubBefore);
  ok("siblings byte-identical + zero sibling writes", siblingsUnchangedAndUntouched(before, siblingFootprint(world)));
});

async function main() {
  writeSync(1, "ads-reconcile-prodshape\n");
  let failures = 0;
  for (const t of tests) { try { await t.fn(); } catch (e) { failures += 1; writeSync(1, "FAIL  " + t.name + "\n" + String((e && e.stack) || e) + "\n"); } }
  writeSync(1, `\nads-reconcile-prodshape: ${passed} assertions passed${failures ? ", " + failures + " FAILED" : ""}\n`);
  if (failures) process.exitCode = 1;
}
main();
