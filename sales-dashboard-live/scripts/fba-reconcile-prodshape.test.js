// PRODUCTION-SHAPE integration for the FBA brand-inventory reconciler (blocker 3). Drives the REAL composition end to
// end over FAITHFUL in-memory stores -- NOTHING about the release/lineage/publish is injected as a fake success:
//   - the REAL buildFbaPublicationReconciler + shared saved-data core + REAL revision/binding;
//   - the REAL dedicated buildFbaBrandInventoryRelease (open cycle -> read durable FBA + validated brand-sales ->
//     buildBrandInventorySnapshot -> upsert report-job lineage + durable_content_deps -> claim -> shadow CAS ->
//     reconcile -> finalize_sync_cycle -> publish -> read back);
//   - the REAL buildSchedulerV2Publisher (four durable gates + fenced live CAS) wired to in-memory backing;
//   - the REAL buildLiveReadback (canonical live identity + payload contract);
//   - the REAL runControlPackageCli control apply/safe-close over the faithful in-memory control store.
// It PROVES: unpromoted -> derive+publish+readback; replay -> zero-write no-op (no controls opened); same-date content
// correction -> STALE -> republish + verify; missing brand-sales -> defer + LKG; valid-empty -> inventoryAvailable
// false (never zero); and -- CRITICALLY -- that ONLY brand-inventory is ever written/published: the test FAILS if the
// path writes a daily-reporting or brand-sales report job or live snapshot. Offline; zero network. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { buildFbaPublicationReconciler, FBA_RECONCILE_STATUS } from "../lib/server/sync/fba-publication-reconciler.js";
import { buildFbaBrandInventoryRelease } from "../lib/server/sync/fba-brand-inventory-release.js";
import { buildSchedulerV2Publisher } from "../lib/server/sync/publisher-composition.js";
import { buildLiveReadback } from "../lib/server/sync/source-priority-release-runner.js";
import { buildBrandInventorySnapshot, BRAND_INVENTORY_REPORT_VERSION } from "../lib/server/reports/brand-view.js";
import { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } from "../lib/server/sync/report-publisher.js";
import { REPORT_DERIVATIONS } from "../lib/server/sync/report-derivation.js";
import { paramsHashFor } from "../lib/server/report-store.js";
import { runControlPackageCli } from "../lib/server/sync/source-priority-control-package.js";
import { fbaContentProvenanceToken } from "../lib/server/sync/fba-inventory-revision.js";
import { FBA_INVENTORY_SOURCE_KEY } from "../lib/server/sync/source-durable-model.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const ASOF = "2026-09-10";
const A = "A01";
const RK = "brand-inventory";
const SHADOW = "scheduler-v2/brand-inventory";

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

// A faithful in-memory WORLD: report_snapshots (shadow + live) + sync_report_jobs + sync_cycles + the durable FBA
// source_snapshots + the validated brand-sales snapshot/lineage. Every REAL module reads/writes THIS backing.
function makeWorld(over = {}) {
  const snaps = new Map();           // report_snapshots: report_key|account_id|params_hash -> row
  const jobs = [];                   // sync_report_jobs rows
  const cycles = new Map();          // sync_cycles: bucket|cycle_date -> row
  const writes = { publishedLiveKeys: [], upsertedReportKeys: [], shadowSavedKeys: [] };
  let seq = 0;
  const fbaSnapshot = { object_path: "obj/fba/A01", payload_sha: over.fbaPayloadSha || "ps-A01", source_request_hash: "rh-A01", row_count: over.fbaRowCount != null ? over.fbaRowCount : 2, validated_at: "2026-09-10T09:00:00Z" };
  const fbaRows = over.fbaRows || [{ date: ASOF, child_asin: "ASIN1", available: 10, marketplace_country_code: "US" }];
  const brandSalesValidated = over.brandSalesValidated !== false;
  const brandSalesPayload = over.brandSalesPayload || { asinBrand: { ASIN1: "BrandA" } };

  const world = {
    snaps, jobs, cycles, writes, fbaSnapshot,
    // --- durable FBA reader + hydration ---
    readFbaSnapshot: async () => (over.noFba ? { read: "ok", snapshot: null } : { read: "ok", snapshot: { ...fbaSnapshot } }),
    loadSnapshotPayload: async () => ({ rows: fbaRows }),
    resolveExpectedRequestHash: async () => fbaSnapshot.source_request_hash, // proven-D-1
    resolveAccountCountry: async () => "US",
    // --- validated brand-sales (attribution) reader ---
    readBrandSalesSnapshot: async () => (over.noBrandSales ? null : { payload: brandSalesPayload, payload_storage_path: null }),
    loadReportPayload: async () => null,
    readBrandSalesLineage: async () => (over.noBrandSales ? null : { validated: brandSalesValidated, cycleStatus: brandSalesValidated ? "succeeded" : "running", dependsOn: ["oli-h", "catalog"], snapshotParamsHash: "bs-h" }),
    // --- report_snapshots (shadow + live) ---
    getReportSnapshot: async ({ reportKey, accountId, paramsHash }) => snaps.get(reportKey + "|" + accountId + "|" + paramsHash) || null,
    getReportSnapshotStoragePayload: async () => null,
    // shadow CAS (saveShadowSnapshotIfNewer semantics)
    saveShadow: async ({ reportKey, accountId, paramsHash, params, payload, sourceRefreshedAt }) => {
      const k = reportKey + "|" + accountId + "|" + paramsHash; writes.shadowSavedKeys.push(reportKey);
      const cur = snaps.get(k);
      if (cur && String(cur.source_refreshed_at) > String(sourceRefreshedAt)) return { outcome: "newer-live" };
      if (cur && String(cur.source_refreshed_at) === String(sourceRefreshedAt) && JSON.stringify(cur.payload) === JSON.stringify(payload)) return { outcome: "already-current" };
      snaps.set(k, { report_key: reportKey, account_id: accountId, params_hash: paramsHash, params, payload, payload_storage_path: null, source_refreshed_at: sourceRefreshedAt });
      return { outcome: cur ? "replaced" : "inserted" };
    },
    // live CAS (publishLiveSnapshotFencedIfNewer semantics) -- records the live report key it writes.
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
      writes.upsertedReportKeys.push(job.reportKey);
      const existing = jobs.find((j) => j.cycle_id === job.cycleId && j.report_key === job.reportKey && j.account_id === job.accountId);
      if (existing) return; // insert-if-absent (on_conflict ignore-duplicates)
      jobs.push({ cycle_id: job.cycleId, report_key: job.reportKey, account_id: job.accountId, connection_id: "primary", bucket: job.bucket, depends_on: job.dependsOn || [], durable_content_deps: job.durableContentDeps || [], derive_status: "pending", save_status: "pending", validated: false, snapshot_params_hash: null, latest_data_date: null, created_at: ++seq });
    },
    claimLease: async (cycleId, reportKey, accountId) => {
      const j = jobs.find((x) => x.cycle_id === cycleId && x.report_key === reportKey && x.account_id === accountId);
      if (!j) return { disposition: "not-found", leaseToken: null, snapshotParamsHash: null };
      if (j.validated === true) return { disposition: "already-complete", leaseToken: null, snapshotParamsHash: j.snapshot_params_hash };
      j.derive_status = "running";
      return { disposition: "claimed", leaseToken: "lease-" + (++seq), snapshotParamsHash: null };
    },
    reconcileSuccess: async ({ cycleId, reportKey, accountId, snapshotParamsHash, latestDataDate }) => {
      const j = jobs.find((x) => x.cycle_id === cycleId && x.report_key === reportKey && x.account_id === accountId);
      if (!j) return { disposition: "not-found" };
      j.validated = true; j.derive_status = "succeeded"; j.save_status = "succeeded"; j.snapshot_params_hash = snapshotParamsHash; j.latest_data_date = latestDataDate;
      return { disposition: "reconciled" };
    },
    latestJob: (reportKey, accountId) => {
      const matching = jobs.filter((j) => j.report_key === reportKey && j.account_id === accountId).sort((a, b) => b.created_at - a.created_at);
      const j = matching[0];
      if (!j) return null;
      const cyc = [...cycles.values()].find((c) => c.id === j.cycle_id);
      return { j, cycleStatus: cyc ? cyc.status : null };
    },
    getLatestReportJobLineage: async (reportKey, accountId) => {
      const r = world.latestJob(reportKey, accountId);
      if (!r) return null;
      const { j, cycleStatus } = r;
      return { reportKey: j.report_key, accountId: j.account_id, deriveStatus: j.derive_status, saveStatus: j.save_status, validated: j.validated === true, dependsOn: j.depends_on.map(String), durableContentDeps: (j.durable_content_deps || []).map(String), snapshotParamsHash: j.snapshot_params_hash, latestDataDate: j.latest_data_date, cycleStatus };
    },
    getLatestReportJob: async (reportKey, accountId) => {
      const r = world.latestJob(reportKey, accountId);
      if (!r) return null;
      const { j, cycleStatus } = r;
      return { cycle_id: j.cycle_id, report_key: j.report_key, account_id: j.account_id, derive_status: j.derive_status, save_status: j.save_status, validated: j.validated === true, snapshot_params_hash: j.snapshot_params_hash, cycle_status: cycleStatus };
    },
    // --- sync_cycles ---
    // created_at is MONOTONIC per open (production wall-clock): a later reconcile cycle (e.g. after a same-date FBA
    // correction, published into a DIFFERENT priority-partial-<revisionId> bucket) gets a strictly-newer
    // source_refreshed_at, so the live CAS REPLACES the older content instead of a false equal-freshness conflict.
    openCycle: async ({ bucket, cycleDate }) => { const k = bucket + "|" + cycleDate; if (!cycles.has(k)) cycles.set(k, { id: "cyc-" + (++seq), bucket, cycle_date: cycleDate, status: "running", trigger: "manual", created_at: new Date(Date.UTC(2026, 8, 10, 9, 30, 0) + (++seq) * 1000).toISOString() }); },
    getBaseSyncCycleByBucketDate: async (bucket, cycleDate) => cycles.get(bucket + "|" + cycleDate) || null,
    finalizeCycle: async ({ cycleId }) => {
      const cyc = [...cycles.values()].find((c) => c.id === cycleId);
      if (!cyc) return { disposition: "not-found" };
      const hasValidated = jobs.some((j) => j.cycle_id === cycleId && j.validated === true);
      cyc.status = hasValidated ? "succeeded" : "partial";
      return { disposition: "finalized", cycle: { status: cyc.status } };
    },
  };
  return world;
}

// Build the REAL reconciler wired to a WORLD, mirroring the entrypoint's runReleaseForAccount composition exactly
// (only the storage is in-memory). leaseFence is captured by the REAL control-package apply.
function buildProd(world, over = {}) {
  const store = over.store || inMemoryControlStore();
  const OPERATOR = "fba-reconcile:india:test";
  let leaseFence = null;
  const readbackLive = buildLiveReadback({ getReportSnapshot: world.getReportSnapshot, loadStoragePayload: world.getReportSnapshotStoragePayload, liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, reportDerivations: REPORT_DERIVATIONS, computeHash: paramsHashFor });
  const runReleaseForAccount = async ({ accountId, requestedAsOf, revisionId, signal }) => {
    const aborted = () => !!(signal && signal.aborted);
    const cycleBucket = "priority-partial-india-" + String(revisionId || "x").slice(0, 16);
    const publisher = buildSchedulerV2Publisher({
      connections: [{ id: "primary", apiKey: "k", organizationFingerprint: "org-1", label: "primary" }],
      // RAW DataDoe account shape (decorateDataDoeAccount reads account.id -> publicAccountId; primary returns it
      // unprefixed as the public account id A01), so the publisher's fresh discovery + rollout gate select A01.
      fetchAccounts: async () => [{ id: A, name: A, country: "US" }],
      getAccountRollout: async () => ({ read: "ok", allPrimary: false, enabledAccountIds: [A] }),
      getSettings: async () => [],
      getPromotedSettings: async () => [{ report_key: RK, publish_enabled: true }],
      getApproval: async () => ({ read: "ok", approved: true }),
      getJob: (rk, a) => world.getLatestReportJob(rk, a),
      getSnapshot: (args) => world.getReportSnapshot(args),
      loadStoragePayload: async () => null,
      publishLiveFenced: world.publishLiveFenced,
      getControlFence: () => (aborted() ? null : leaseFence),
    });
    const release = buildFbaBrandInventoryRelease({
      resolveOrg: async () => ({ organizationFingerprint: "org-1", connectionId: "primary" }),
      openCycle: world.openCycle, getCycleByBucketDate: world.getBaseSyncCycleByBucketDate,
      readFbaSnapshot: world.readFbaSnapshot, loadSnapshotPayload: world.loadSnapshotPayload,
      resolveExpectedRequestHash: world.resolveExpectedRequestHash, resolveAccountCountry: world.resolveAccountCountry,
      readBrandSalesSnapshot: world.readBrandSalesSnapshot, loadReportPayload: world.loadReportPayload, readBrandSalesLineage: world.readBrandSalesLineage,
      buildInventorySnapshot: buildBrandInventorySnapshot, computeHash: paramsHashFor,
      upsertReportJob: world.upsertReportJob, claimLease: world.claimLease, saveShadow: world.saveShadow, reconcileSuccess: world.reconcileSuccess,
      finalizeCycle: world.finalizeCycle, publisher, readbackLive,
      verifyLease: async () => (aborted() ? { ok: false } : { ok: !!leaseFence }),
      log: () => {},
    });
    return release.runForAccount({ accountId, requestedAsOf, cycleBucket, signal });
  };
  const openControls = async (ids) => {
    const r = await runControlPackageCli({ mode: "apply", operator: OPERATOR, discoverAccounts: async () => [...ids], connectStore: async () => store, ownerToken: OPERATOR, operationKey: "fba-reconcile/india/" + ASOF, leaseTtlSeconds: 900 });
    if (!r || r.committed !== true) return { ok: false, reason: "apply-noncommit code " + (r && r.code) };
    const gen = Number(r.leaseGeneration); if (!(Number.isSafeInteger(gen) && gen > 0)) return { ok: false, reason: "no-generation" };
    leaseFence = { ownerToken: r.ownerToken || OPERATOR, generation: gen };
    return { ok: true };
  };
  const closeControls = async () => {
    if (!leaseFence) return { ok: true };
    const r = await runControlPackageCli({ mode: "rollback", operator: OPERATOR, connectStore: async () => store, ownerToken: leaseFence.ownerToken, ownerGeneration: leaseFence.generation, operationKey: "fba-reconcile/india/" + ASOF });
    leaseFence = null;
    if (r && r.skipped === "lease-not-owner") return { ok: true };
    if (!r || r.committed !== true) return { ok: false, reason: "safe-close-noncommit" };
    return { ok: true };
  };
  const reconciler = buildFbaPublicationReconciler({
    resolveOrg: async () => ({ organizationFingerprint: "org-1", connectionId: "primary" }),
    bucketAccounts: async () => [{ accountId: A }],
    readFbaSnapshot: world.readFbaSnapshot,
    resolveExpectedRequestHash: world.resolveExpectedRequestHash,
    readLatestReportJob: ({ reportKey, accountId }) => world.getLatestReportJobLineage(reportKey, accountId),
    readShadowSnapshot: (args) => world.getReportSnapshot(args),
    readLiveSnapshot: (args) => world.getReportSnapshot(args),
    loadStoragePayload: async () => null,
    verifyLiveReadback: readbackLive,
    liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, computeHash: paramsHashFor, reportDerivations: REPORT_DERIVATIONS,
    runReleaseForAccount, openControls, closeControls,
    reportKeys: [RK], log: () => {},
  });
  return { reconciler, store, world };
}
const st = (out) => out.perAccount[0].reports[RK].state;
const liveRow = (world) => { for (const [k, v] of world.snaps) if (v.report_key === RK && !k.startsWith(SHADOW)) return v; return null; };

test("blocker 3: UNPROMOTED brand-inventory -> REAL dedicated release derives+publishes+reads-back ONLY brand-inventory; zero export", async () => {
  const world = makeWorld();
  const h = buildProd(world);
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 READBACK_VERIFIED via the real dedicated release", st(out) === FBA_RECONCILE_STATUS.READBACK_VERIFIED && out.ok === true);
  ok("a REAL live brand-inventory row was written (canonical readback passed)", !!liveRow(world) && liveRow(world).payload.inventoryAvailable === true);
  ok("ONLY brand-inventory published/written -- NEVER daily-reporting or brand-sales", world.writes.publishedLiveKeys.join(",") === RK && [...new Set(world.writes.upsertedReportKeys)].join(",") === RK && [...new Set(world.writes.shadowSavedKeys)].join(",") === SHADOW);
  ok("the brand-inventory report job recorded the durable FBA content token + the brand-sales OLI deps", world.jobs.some((j) => j.report_key === RK && j.durable_content_deps.length === 1 && j.durable_content_deps[0].includes("rh-A01") && j.depends_on.join(",") === "oli-h,catalog"));
  ok("zero provider export", out.dataDoeCreates === 0 && out.dataDoeTokens === 0);
});

test("blocker 1: after a successful reconciliation, the NEXT unchanged pass is PUBLICATION_NOT_REQUIRED before opening controls (zero write)", async () => {
  const world = makeWorld();
  const h = buildProd(world);
  await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" }); // pass 1: publish
  const publishedBefore = world.writes.publishedLiveKeys.length;
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" }); // pass 2: replay
  ok("replay: PUBLICATION_NOT_REQUIRED (the job's durable_content_deps covers the current FBA content token)", st(out) === "PUBLICATION_NOT_REQUIRED");
  ok("zero additional live writes on the unchanged replay", world.writes.publishedLiveKeys.length === publishedBefore);
});

test("blocker 2 lifecycle: R/content A published -> durable changes to R/content B -> STALE -> re-derive consumes B -> publish + readback B; then replay is zero-write", async () => {
  const world = makeWorld({ fbaPayloadSha: "ps-A", fbaRows: [{ date: ASOF, child_asin: "ASIN1", available: 10, marketplace_country_code: "US" }] });
  const h = buildProd(world);
  await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" }); // publish content A
  const liveA = JSON.stringify(liveRow(world).payload);
  // SAME request hash (same D-1), NEW payload_sha + NEW rows (a same-date correction).
  world.fbaSnapshot.payload_sha = "ps-B"; world.fbaSnapshot.validated_at = "2026-09-10T18:00:00Z";
  world.loadSnapshotPayload = async () => ({ rows: [{ date: ASOF, child_asin: "ASIN1", available: 99, marketplace_country_code: "US" }] });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("same-date correction -> STALE -> re-derived + re-published (READBACK_VERIFIED)", st(out) === FBA_RECONCILE_STATUS.READBACK_VERIFIED);
  const liveB = JSON.stringify(liveRow(world).payload);
  ok("the live payload CHANGED to content B (the corrected inventory was published)", liveA !== liveB && liveRow(world).payload.inventoryByBrandCountry.some((r) => r.fbaAvailable === 99));
  const publishedAfterB = world.writes.publishedLiveKeys.length;
  const out2 = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" }); // replay of B
  ok("a subsequent unchanged pass is a zero-write no-op (PUBLICATION_NOT_REQUIRED)", st(out2) === "PUBLICATION_NOT_REQUIRED" && world.writes.publishedLiveKeys.length === publishedAfterB);
});

test("blocker 3: MISSING validated brand-sales input defers brand-inventory ONLY (LKG preserved; no publish; no brand-sales write)", async () => {
  const world = makeWorld({ noBrandSales: true });
  const h = buildProd(world);
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 DEFERRED_DEPENDENCY (brand-sales not validated); no live write", st(out) === FBA_RECONCILE_STATUS.DEFERRED_DEPENDENCY && world.writes.publishedLiveKeys.length === 0);
  ok("no brand-sales was written or published (never republished)", !world.writes.upsertedReportKeys.includes("brand-sales") && !world.writes.publishedLiveKeys.includes("brand-sales"));
});

test("valid FBA empty (row_count=0, rows=[]) publishes inventoryAvailable:false, NEVER a manufactured zero", async () => {
  const world = makeWorld({ fbaRowCount: 0, fbaRows: [], fbaPayloadSha: "ps-empty" });
  const h = buildProd(world);
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 published a valid-empty brand-inventory (READBACK_VERIFIED)", st(out) === FBA_RECONCILE_STATUS.READBACK_VERIFIED);
  const lr = liveRow(world);
  ok("inventoryAvailable is FALSE (unavailable), NOT zero rows presented as data", lr && lr.payload.inventoryAvailable === false);
});

test("dry-run performs ZERO writes even with a stale account (no controls, no cycle, no publish)", async () => {
  const world = makeWorld();
  const h = buildProd(world);
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic", dryRun: true });
  ok("dry-run: STALE reported, zero live writes, zero cycles opened, zero jobs", st(out) === "STALE" && world.writes.publishedLiveKeys.length === 0 && world.cycles.size === 0 && world.jobs.length === 0);
});

async function main() {
  writeSync(1, "fba-reconcile-prodshape\n");
  let failures = 0;
  for (const t of tests) { try { await t.fn(); } catch (e) { failures += 1; writeSync(1, "FAIL  " + t.name + "\n" + String((e && e.stack) || e) + "\n"); } }
  writeSync(1, `\nfba-reconcile-prodshape: ${passed} assertions passed${failures ? ", " + failures + " FAILED" : ""}\n`);
  if (failures) process.exitCode = 1;
}
main();
