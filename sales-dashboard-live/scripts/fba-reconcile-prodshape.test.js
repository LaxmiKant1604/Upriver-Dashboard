// PRODUCTION-SHAPE integration for the FBA brand-inventory reconciler (blockers 1-3). Drives the REAL composition end
// to end over FAITHFUL in-memory stores -- NOTHING about the release/lineage/publish/candidate-binding is injected as a
// fake success:
//   - the REAL buildFbaPublicationReconciler + shared saved-data core + REAL revision/binding;
//   - the REAL dedicated buildFbaBrandInventoryRelease (open cycle -> read durable FBA -> resolve ONE publisher-
//     identical brand-sales candidate via the REAL resolveValidatedLiveCandidate -> buildBrandInventorySnapshot ->
//     upsert report-job lineage + durable_content_deps -> claim -> shadow CAS -> reconcile -> finalize_sync_cycle ->
//     publish -> read back);
//   - the REAL buildSchedulerV2Publisher (four durable gates + fenced live CAS) wired to in-memory backing;
//   - the REAL buildLiveReadback (canonical live identity + payload contract), used for BOTH the brand-inventory
//     read-back AND the brand-sales candidate live read-back;
//   - the REAL runControlPackageCli control apply/safe-close over the faithful in-memory control store.
//
// It PROVES: unpromoted -> derive+publish+readback; replay -> zero-write no-op; same-date content correction -> STALE
// -> republish + verify; valid-empty -> inventoryAvailable false (never zero); and -- CRITICALLY --
//   BLOCKER 1 (bind Brand Sales to its exact validated lineage): the brand-inventory payload + lineage come from ONE
//     proven brand-sales candidate. A newer UNPROMOTED brand-sales job, a mismatched job/shadow hash, a wrong
//     account/report-version, an impossible as-of, an invalid/unreadable storage-first payload, or a missing/mismatched
//     live each DEFER brand-inventory and leave its live/shadow/job state UNCHANGED (LKG preserved). Only the exact,
//     fully-validated candidate publishes.
//   BLOCKER 2 (preserve the termination boundary): an abort OBSERVED during any awaited release phase (open, upsert,
//     claim, shadow-save, reconcile, finalize) starts NO later durable write and NO publish; and with a NULL control
//     fence the REAL publisher's live CAS writes ZERO rows (the fenced CAS is the final defense).
//   and that ONLY brand-inventory is ever written/published (the test FAILS if a daily-reporting or brand-sales report
//   job or live snapshot is written). Offline; zero network. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { buildFbaPublicationReconciler, FBA_RECONCILE_STATUS } from "../lib/server/sync/fba-publication-reconciler.js";
import { buildFbaBrandInventoryRelease } from "../lib/server/sync/fba-brand-inventory-release.js";
import { buildSchedulerV2Publisher } from "../lib/server/sync/publisher-composition.js";
import { buildLiveReadback } from "../lib/server/sync/source-priority-release-runner.js";
import { buildBrandInventorySnapshot } from "../lib/server/reports/brand-view.js";
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
const BS_SHADOW_KEY = "scheduler-v2/brand-sales";

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
// source_snapshots + ONE publisher-identical brand-sales candidate (job + scheduler-v2/brand-sales shadow + canonical
// brand-sales live). Every REAL module reads/writes THIS backing.
function makeWorld(over = {}) {
  const snaps = new Map();           // report_snapshots: report_key|account_id|params_hash -> row
  const jobs = [];                   // sync_report_jobs rows
  const cycles = new Map();          // sync_cycles: key -> row
  const writes = { publishedLiveKeys: [], upsertedReportKeys: [], shadowSavedKeys: [], openCalls: 0, claimCalls: 0, reconcileCalls: 0, finalizeCalls: 0 };
  let seq = 0;
  const fbaSnapshot = { object_path: "obj/fba/A01", payload_sha: over.fbaPayloadSha || "ps-A01", source_request_hash: "rh-A01", row_count: over.fbaRowCount != null ? over.fbaRowCount : 2, validated_at: "2026-09-10T09:00:00Z" };
  const fbaRows = over.fbaRows || [{ date: ASOF, child_asin: "ASIN1", available: 10, marketplace_country_code: "US" }];

  const world = {
    snaps, jobs, cycles, writes, fbaSnapshot,
    // --- durable FBA reader + hydration (signal accepted + ignored by the store, threaded by the release) ---
    readFbaSnapshot: async () => (over.noFba ? { read: "ok", snapshot: null } : { read: "ok", snapshot: { ...fbaSnapshot } }),
    loadSnapshotPayload: async () => ({ rows: fbaRows }),
    resolveExpectedRequestHash: async () => fbaSnapshot.source_request_hash, // proven-D-1
    resolveAccountCountry: async () => "US",
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
    // live CAS (publishLiveSnapshotFencedIfNewer semantics) -- FENCE is checked FIRST: no owner -> zero rows written.
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
    // FAITHFUL: a freshly-opened cycle is 'pending' (claim -> 'running' -> finalize; finalize rejects non-'running').
    openCycle: async ({ bucket, cycleDate }) => { writes.openCalls += 1; const k = bucket + "|" + cycleDate; if (!cycles.has(k)) cycles.set(k, { id: "cyc-" + (++seq), bucket, cycle_date: cycleDate, status: "pending", trigger: "manual", created_at: new Date(Date.UTC(2026, 8, 10, 9, 30, 0) + (++seq) * 1000).toISOString() }); },
    getBaseSyncCycleByBucketDate: async (bucket, cycleDate) => cycles.get(bucket + "|" + cycleDate) || null,
    claimCycle: async (cycleId) => { const cyc = [...cycles.values()].find((c) => c.id === cycleId); if (cyc && cyc.status === "pending") { cyc.status = "running"; return true; } return false; },
    finalizeCycle: async ({ cycleId }) => {
      writes.finalizeCalls += 1;
      const cyc = [...cycles.values()].find((c) => c.id === cycleId);
      if (!cyc) return { disposition: "not-found" };
      if (cyc.status !== "running") return { disposition: "invalid-status" };
      const hasValidated = jobs.some((j) => j.cycle_id === cycleId && j.validated === true);
      cyc.status = hasValidated ? "succeeded" : "partial";
      return { disposition: "finalized", cycle: { status: cyc.status } };
    },
  };

  // ---- Seed ONE publisher-identical brand-sales candidate (valid by default; adversarial cases mutate world.snaps /
  // world.jobs after construction). Shadow params carry accountId + reportVersion (folded into the params hash), a real
  // ordered from/to range; the canonical live carries only the contract's liveParams (from/to). Shadow<->live are proven
  // equal (identical source_refreshed_at + identical payload); the payload passes REPORT_DERIVATIONS['brand-sales']. ----
  // over.bsTo overrides the candidate window END (for exact-requested-as-of tests: older/future/malformed dates);
  // over.bsMissingTo drops `to` entirely; over.bsShadowStoragePath makes the shadow payload storage-first (for the
  // storage-hydration abort test). Default candidate ends on ASOF (= the FBA requestedAsOf), so it binds exactly.
  const bsTo = over.bsMissingTo ? undefined : (over.bsTo != null ? over.bsTo : "2026-09-10");
  const bs = { version: "brand-sales/v2d-2", from: "2026-09-01", to: bsTo, refresh: "2026-09-09T08:00:00Z" };
  bs.payload = { rows: [], catalogBrands: ["BrandA"], asinBrand: { ASIN1: "BrandA" } };
  bs.shadowParams = bsTo === undefined ? { accountId: A, reportVersion: bs.version, from: bs.from } : { accountId: A, reportVersion: bs.version, from: bs.from, to: bsTo };
  bs.BSH = paramsHashFor(bs.version, bs.shadowParams);
  bs.liveParams = bsTo === undefined ? { from: bs.from } : { from: bs.from, to: bsTo };
  bs.candHash = paramsHashFor(SCHEDULER_LIVE_SNAPSHOT_CONTRACTS["brand-sales"].liveReportVersion, bs.liveParams);
  bs.shadowKey = BS_SHADOW_KEY + "|" + A + "|" + bs.BSH;
  bs.liveKey = "brand-sales|" + A + "|" + bs.candHash;
  bs.shadowStoragePath = over.bsShadowStoragePath || null;
  if (!over.noBrandSales) {
    cycles.set("bs-seed", { id: "cyc-bs", bucket: "bs", cycle_date: ASOF, status: "succeeded", trigger: "manual", created_at: "2026-09-09T08:00:00Z" });
    jobs.push({ cycle_id: "cyc-bs", report_key: "brand-sales", account_id: A, connection_id: "primary", bucket: "bs", depends_on: ["oli-h", "catalog"], durable_content_deps: [], derive_status: "succeeded", save_status: "succeeded", validated: true, snapshot_params_hash: bs.BSH, latest_data_date: bs.to || null, created_at: 0 });
    if (bs.shadowStoragePath) world._storage[bs.shadowStoragePath] = bs.payload;
    snaps.set(bs.shadowKey, { report_key: BS_SHADOW_KEY, account_id: A, params_hash: bs.BSH, params: { ...bs.shadowParams }, payload: bs.shadowStoragePath ? null : bs.payload, payload_storage_path: bs.shadowStoragePath, source_refreshed_at: bs.refresh });
    // Live params echo the contract's live version (the real publisher stores it; buildLiveReadback checks it), while
    // params_hash re-derives from ONLY the contract.liveParams output (from/to) -- exactly the publisher's identity.
    snaps.set(bs.liveKey, { report_key: "brand-sales", account_id: A, params_hash: bs.candHash, params: { reportVersion: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS["brand-sales"].liveReportVersion, ...bs.liveParams }, payload: bs.payload, payload_storage_path: null, source_refreshed_at: bs.refresh });
  }
  world.bs = bs;
  return world;
}

// Wire the REAL dedicated release with a WORLD, mirroring the entrypoint's runReleaseForAccount composition exactly
// (only the storage is in-memory + the candidate readers are the entrypoint's). `abortWhen` (optional) makes the named
// awaited phase abort the controller AFTER completing -- so the release observes the abort at its NEXT recheck.
function wireRelease(world, { leaseFence, aborted = () => false, controller = null, abortWhen = null, abortOnReadback = null, abortOnStorage = null } = {}) {
  const rawReadback = buildLiveReadback({ getReportSnapshot: world.getReportSnapshot, loadStoragePayload: world.getReportSnapshotStoragePayload, liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, reportDerivations: REPORT_DERIVATIONS, computeHash: paramsHashFor });
  // abortOnReadback=<reportKey>: abort the controller the instant that report's live read-back settles (models the
  // deadline firing DURING the awaited read-back). abortOnStorage=<path>: abort when that storage object is hydrated.
  const readbackLive = (controller && abortOnReadback)
    ? async (a) => { const r = await rawReadback(a); if (String(a && a.reportKey) === abortOnReadback) controller.abort(); return r; }
    : rawReadback;
  const loadStoragePayload = (controller && abortOnStorage)
    ? async (path, opt) => { const r = await world.getReportSnapshotStoragePayload(path, opt); if (String(path) === abortOnStorage) controller.abort(); return r; }
    : (path, opt) => world.getReportSnapshotStoragePayload(path, opt);
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
    getControlFence: () => (aborted() ? null : (typeof leaseFence === "function" ? leaseFence() : leaseFence)),
  });
  const wrapAbort = (name, fn) => (controller && abortWhen === name ? async (...a) => { const r = await fn(...a); controller.abort(); return r; } : fn);
  const release = buildFbaBrandInventoryRelease({
    resolveOrg: async () => ({ organizationFingerprint: "org-1", connectionId: "primary" }),
    openCycle: wrapAbort("open", world.openCycle), getCycleByBucketDate: world.getBaseSyncCycleByBucketDate, claimCycle: (cycleId) => world.claimCycle(cycleId),
    readFbaSnapshot: world.readFbaSnapshot, loadSnapshotPayload: world.loadSnapshotPayload,
    resolveExpectedRequestHash: world.resolveExpectedRequestHash, resolveAccountCountry: world.resolveAccountCountry,
    // BLOCKER 1: the candidate readers (resolveValidatedLiveCandidate wires these) -- the entrypoint's exact wiring.
    readReportJob: (reportKey, a, opt) => world.getLatestReportJobLineage(reportKey, a, opt),
    readSnapshot: (args, opt) => world.getReportSnapshot(args, opt),
    loadStoragePayload,
    liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, reportDerivations: REPORT_DERIVATIONS,
    buildInventorySnapshot: buildBrandInventorySnapshot, computeHash: paramsHashFor,
    upsertReportJob: wrapAbort("upsert", world.upsertReportJob), claimLease: wrapAbort("claim", world.claimLease),
    saveShadow: wrapAbort("shadow", world.saveShadow), reconcileSuccess: wrapAbort("reconcile", world.reconcileSuccess),
    finalizeCycle: wrapAbort("finalize", world.finalizeCycle), publisher, readbackLive,
    verifyLease: async () => (aborted() ? { ok: false } : { ok: !!(typeof leaseFence === "function" ? leaseFence() : leaseFence) }),
    log: () => {},
  });
  return { release, readbackLive, publisher };
}

// Build the REAL reconciler wired to a WORLD, mirroring the entrypoint's runReleaseForAccount composition exactly.
function buildProd(world, over = {}) {
  const store = over.store || inMemoryControlStore();
  const OPERATOR = "fba-reconcile:india:test";
  let leaseFence = null;
  const readbackLive = buildLiveReadback({ getReportSnapshot: world.getReportSnapshot, loadStoragePayload: world.getReportSnapshotStoragePayload, liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, reportDerivations: REPORT_DERIVATIONS, computeHash: paramsHashFor });
  const runReleaseForAccount = async ({ accountId, requestedAsOf, revisionId, signal }) => {
    const aborted = () => !!(signal && signal.aborted);
    const cycleBucket = "priority-partial-india-" + String(revisionId || "x").slice(0, 16);
    const { release } = wireRelease(world, { leaseFence: () => leaseFence, aborted });
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
// The brand-inventory live/shadow/job footprint -- to assert an adversarial defer leaves brand-inventory UNCHANGED.
const invFootprint = (world) => ({ published: world.writes.publishedLiveKeys.filter((k) => k === RK).length, shadow: world.writes.shadowSavedKeys.filter((k) => k === SHADOW).length, invJobs: world.jobs.filter((j) => j.report_key === RK).length, live: !!liveRow(world) });

test("blocker 3: UNPROMOTED brand-inventory -> REAL dedicated release derives+publishes+reads-back ONLY brand-inventory; zero export", async () => {
  const world = makeWorld();
  const h = buildProd(world);
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 READBACK_VERIFIED via the real dedicated release", st(out) === FBA_RECONCILE_STATUS.READBACK_VERIFIED && out.ok === true);
  ok("a REAL live brand-inventory row was written (canonical readback passed)", !!liveRow(world) && liveRow(world).payload.inventoryAvailable === true);
  ok("ONLY brand-inventory published/written -- NEVER daily-reporting or brand-sales", world.writes.publishedLiveKeys.join(",") === RK && [...new Set(world.writes.upsertedReportKeys)].join(",") === RK && [...new Set(world.writes.shadowSavedKeys)].join(",") === SHADOW);
  const expectedToken = fbaContentProvenanceToken({ sourceKey: FBA_INVENTORY_SOURCE_KEY, accountId: A, connectionId: "primary", requestHash: "rh-A01", contentSha: "ps-A01" });
  ok("the brand-inventory report job recorded the EXACT durable FBA content token + the PROVEN brand-sales candidate's OLI deps", world.jobs.some((j) => j.report_key === RK && j.durable_content_deps.length === 1 && j.durable_content_deps[0] === expectedToken && j.depends_on.join(",") === "oli-h,catalog"));
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

test("lifecycle: R/content A published -> durable changes to R/content B -> STALE -> re-derive consumes B -> publish + readback B; then replay is zero-write", async () => {
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
  ok("dry-run: STALE reported, zero live writes, zero cycles opened, zero jobs", st(out) === "STALE" && world.writes.publishedLiveKeys.length === 0 && world.writes.openCalls === 0 && world.jobs.filter((j) => j.report_key === RK).length === 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// BLOCKER 1 -- bind Brand Sales to its EXACT validated lineage. Each case makes resolveValidatedLiveCandidate return a
// NON-ok result; brand-inventory MUST defer and leave its live/shadow/job state UNCHANGED (never combine an older live
// payload with a newer/unproven job's dependsOn, never publish stale as fresh).
// ---------------------------------------------------------------------------------------------------------------------
async function expectCandidateDefer(name, mutate) {
  const world = makeWorld();
  mutate(world);
  const h = buildProd(world);
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  const fp = invFootprint(world);
  ok(name + ": brand-inventory DEFERRED_DEPENDENCY", st(out) === FBA_RECONCILE_STATUS.DEFERRED_DEPENDENCY && out.ok === true);
  ok(name + ": ZERO brand-inventory live/shadow/job writes (LKG preserved)", fp.published === 0 && fp.shadow === 0 && fp.invJobs === 0 && fp.live === false);
  ok(name + ": brand-sales NEVER written or republished", !world.writes.upsertedReportKeys.includes("brand-sales") && !world.writes.publishedLiveKeys.includes("brand-sales") && !world.writes.shadowSavedKeys.includes(BS_SHADOW_KEY));
}

test("blocker 1: MISSING brand-sales candidate (no promotable job) -> defer; zero brand-inventory writes", async () => {
  await expectCandidateDefer("missing-brand-sales", (world) => {
    world.jobs = world.jobs.filter((j) => j.report_key !== "brand-sales");
    world.snaps.delete(world.bs.shadowKey); world.snaps.delete(world.bs.liveKey);
  });
});

test("blocker 1: NEWER UNPROMOTED brand-sales job + older validated live -> the latest job is not promotable -> defer (never lends its dependsOn to the older live)", async () => {
  await expectCandidateDefer("newer-unpromoted-job", (world) => {
    // A strictly-newer brand-sales job (running/unvalidated) shadows the promoted one; resolveValidatedLiveCandidate
    // reads the LATEST job -> jobIsPromotable false -> defer. The older live payload is NEVER combined with it.
    world.cycles.set("bs-new", { id: "cyc-bs-new", status: "running" });
    world.jobs.push({ cycle_id: "cyc-bs-new", report_key: "brand-sales", account_id: A, connection_id: "primary", bucket: "bs", depends_on: ["oli-h", "catalog", "NEWER-UNPROMOTED"], durable_content_deps: [], derive_status: "running", save_status: "pending", validated: false, snapshot_params_hash: null, latest_data_date: null, created_at: 999999 });
  });
});

test("blocker 1: MISMATCHED job/shadow hash (shadow.params_hash != recomputed) -> defer", async () => {
  await expectCandidateDefer("shadow-hash-mismatch", (world) => {
    const row = world.snaps.get(world.bs.shadowKey);
    row.params_hash = "tampered-hash"; // recompute(params) still == BSH != 'tampered-hash' -> shadow-hash-mismatch
  });
});

test("blocker 1: WRONG account in shadow params -> defer", async () => {
  await expectCandidateDefer("shadow-wrong-account", (world) => {
    const row = world.snaps.get(world.bs.shadowKey);
    row.params = { ...row.params, accountId: "OTHER" }; // publisher-identical accountOk fails -> defer
  });
});

test("blocker 1: WRONG report version in shadow params -> defer", async () => {
  await expectCandidateDefer("shadow-wrong-version", (world) => {
    // Re-key the shadow + job at a hash computed from a WRONG reportVersion, so the resolver reaches the version gate.
    world.snaps.delete(world.bs.shadowKey);
    const badParams = { accountId: A, reportVersion: "brand-sales/WRONG-vX", from: world.bs.from, to: world.bs.to };
    const badHash = paramsHashFor(badParams.reportVersion, badParams);
    const j = world.jobs.find((x) => x.report_key === "brand-sales"); j.snapshot_params_hash = badHash;
    world.snaps.set(BS_SHADOW_KEY + "|" + A + "|" + badHash, { report_key: BS_SHADOW_KEY, account_id: A, params_hash: badHash, params: badParams, payload: world.bs.payload, payload_storage_path: null, source_refreshed_at: world.bs.refresh });
  });
});

// The brand-sales contract's liveParams (orderedRange(from,to)) itself rejects an impossible date, so an impossible
// candidate as-of DEFERS at the resolver's live-params-derivation step (contract.liveParams -> null -> "live-params-
// underivable"), BEFORE the resolver's own isCalendarDate loop -- which is a defense-in-depth backstop for any future
// contract whose liveParams would pass an unvalidated date through. Either way: an impossible as-of NEVER publishes.
test("blocker 1: IMPOSSIBLE candidate as-of (2026-02-30) -> defer (contract live-params derivation rejects it; zero writes)", async () => {
  await expectCandidateDefer("impossible-asof", (world) => {
    world.snaps.delete(world.bs.shadowKey); world.snaps.delete(world.bs.liveKey);
    const params = { accountId: A, reportVersion: world.bs.version, from: world.bs.from, to: "2026-02-30" };
    const BSH = paramsHashFor(world.bs.version, params);
    const j = world.jobs.find((x) => x.report_key === "brand-sales"); j.snapshot_params_hash = BSH; j.latest_data_date = "2026-02-30";
    world.snaps.set(BS_SHADOW_KEY + "|" + A + "|" + BSH, { report_key: BS_SHADOW_KEY, account_id: A, params_hash: BSH, params, payload: world.bs.payload, payload_storage_path: null, source_refreshed_at: world.bs.refresh });
  });
});

test("blocker 1: INVALID storage-first payload (fails the brand-sales validator) -> defer", async () => {
  await expectCandidateDefer("invalid-payload", (world) => {
    const row = world.snaps.get(world.bs.shadowKey);
    row.payload = { rows: [], catalogBrands: [], asinBrand: {} }; // asinBrand empty -> validatePayload false
  });
});

test("blocker 1: UNREADABLE storage-first payload (dangling storage path) -> defer", async () => {
  await expectCandidateDefer("unreadable-payload", (world) => {
    const row = world.snaps.get(world.bs.shadowKey);
    row.payload_storage_path = "dangling/brand-sales/path"; row.payload = null; // loadStoragePayload -> null -> unavailable
  });
});

test("blocker 1: canonical live MISSING (job+shadow valid, live never promoted) -> defer", async () => {
  await expectCandidateDefer("live-missing", (world) => { world.snaps.delete(world.bs.liveKey); });
});

test("blocker 1: live payload DIFFERS from the shadow (not this derivation's promotion) -> defer", async () => {
  await expectCandidateDefer("live-payload-differs", (world) => {
    const row = world.snaps.get(world.bs.liveKey);
    row.payload = { rows: [{ x: 1 }], catalogBrands: ["BrandA"], asinBrand: { ASIN1: "BrandA" } }; // != shadow payload
  });
});

test("blocker 1: live source_refreshed_at DIFFERS from the shadow (not the same promotion) -> defer", async () => {
  await expectCandidateDefer("live-refresh-differs", (world) => {
    const row = world.snaps.get(world.bs.liveKey);
    row.source_refreshed_at = "2026-09-09T23:59:59Z"; // != shadow.source_refreshed_at
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// WORK 1A -- the Brand Sales candidate must be built for EXACTLY the requested D-1 window end. The FBA release passes
// requestedAsOf=ASOF; the candidate's live `to` must EQUAL it. An older OR future window DEFERS at the exact-as-of gate;
// a malformed / impossible / missing `to` DEFERS at the contract's live-params derivation (orderedRange rejects a bad
// date before the exact-as-of gate). Every refused case = zero Brand Inventory writes; Brand Sales + Daily Reporting are
// never written or republished (so Brand Inventory dated ASOF is never attributed from a different report window).
// ---------------------------------------------------------------------------------------------------------------------
async function expectCandidateDeferOver(name, over) {
  const world = makeWorld(over);
  const h = buildProd(world);
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  const fp = invFootprint(world);
  ok(name + ": brand-inventory DEFERRED_DEPENDENCY", st(out) === FBA_RECONCILE_STATUS.DEFERRED_DEPENDENCY && out.ok === true);
  ok(name + ": ZERO brand-inventory live/shadow/job writes (LKG preserved)", fp.published === 0 && fp.shadow === 0 && fp.invJobs === 0 && fp.live === false);
  ok(name + ": Brand Sales + Daily Reporting NEVER written/republished", !world.writes.upsertedReportKeys.includes("brand-sales") && !world.writes.upsertedReportKeys.includes("daily-reporting") && !world.writes.publishedLiveKeys.includes("brand-sales") && !world.writes.publishedLiveKeys.includes("daily-reporting") && !world.writes.shadowSavedKeys.includes(BS_SHADOW_KEY));
}

test("work1A: EXACT requested-as-of candidate (to === requestedAsOf) SUCCEEDS + publishes brand-inventory; Brand Sales/Daily Reporting untouched", async () => {
  const world = makeWorld({ bsTo: ASOF }); // candidate window ends EXACTLY on the FBA requested D-1
  const h = buildProd(world);
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("exact-as-of candidate -> READBACK_VERIFIED", st(out) === FBA_RECONCILE_STATUS.READBACK_VERIFIED && out.ok === true);
  ok("brand-inventory published with the PROVEN candidate's OLI deps", world.jobs.some((j) => j.report_key === RK && j.depends_on.join(",") === "oli-h,catalog") && !!liveRow(world));
  ok("neither Brand Sales nor Daily Reporting was written or published", !world.writes.upsertedReportKeys.includes("brand-sales") && !world.writes.upsertedReportKeys.includes("daily-reporting") && !world.writes.publishedLiveKeys.includes("brand-sales") && !world.writes.publishedLiveKeys.includes("daily-reporting"));
});

test("work1A: VALID OLDER candidate window (to = requestedAsOf-1) DEFERS (exact-as-of gate) -> zero brand-inventory writes", async () => {
  await expectCandidateDeferOver("older-window", { bsTo: "2026-09-09" });
});
test("work1A: VALID FUTURE candidate window (to = requestedAsOf+1) DEFERS (exact-as-of gate) -> zero brand-inventory writes", async () => {
  await expectCandidateDeferOver("future-window", { bsTo: "2026-09-11" });
});
test("work1A: MALFORMED candidate `to` (not a date) DEFERS -> zero brand-inventory writes", async () => {
  await expectCandidateDeferOver("malformed-to", { bsTo: "not-a-date" });
});
test("work1A: IMPOSSIBLE calendar `to` (2026-02-30) DEFERS -> zero brand-inventory writes", async () => {
  await expectCandidateDeferOver("impossible-to", { bsTo: "2026-02-30" });
});
test("work1A: MISSING candidate `to` DEFERS -> zero brand-inventory writes", async () => {
  await expectCandidateDeferOver("missing-to", { bsMissingTo: true });
});

// ---------------------------------------------------------------------------------------------------------------------
// BLOCKER 2 -- preserve the termination boundary. An abort OBSERVED during any awaited release phase must start NO later
// durable write and NO publish. Driven through the REAL dedicated release with a controller aborted right after the
// named phase's own await settles.
// ---------------------------------------------------------------------------------------------------------------------
const PHASES = [
  { phase: "open", next: (w) => w.writes.upsertedReportKeys.length === 0, label: "no lineage upsert" },
  { phase: "upsert", next: (w) => w.writes.claimCalls === 0, label: "no lease claim" },
  { phase: "claim", next: (w) => w.writes.shadowSavedKeys.length === 0, label: "no shadow save" },
  { phase: "shadow", next: (w) => w.writes.reconcileCalls === 0, label: "no reconcile-success" },
  { phase: "reconcile", next: (w) => w.writes.finalizeCalls === 0, label: "no cycle finalize" },
  { phase: "finalize", next: (w) => w.writes.publishedLiveKeys.length === 0, label: "no publish" },
];
for (const { phase, next, label } of PHASES) {
  test(`blocker 2 (behavioral): abort OBSERVED during '${phase}' -> deadline-aborted; ${label}; NO live publish`, async () => {
    const world = makeWorld();
    const controller = new AbortController();
    const { release } = wireRelease(world, { leaseFence: { ownerToken: "op", generation: 1 }, aborted: () => controller.signal.aborted, controller, abortWhen: phase });
    const res = await release.runForAccount({ accountId: A, requestedAsOf: ASOF, cycleBucket: "priority-partial-india-x", signal: controller.signal });
    ok(`${phase}: returns a deadline-aborted deferral`, res.ok === false && res.status === "DEADLINE_ABORTED");
    ok(`${phase}: the immediately-following write did not start (${label})`, next(world));
    ok(`${phase}: NO brand-inventory live publish landed after the abort`, world.writes.publishedLiveKeys.length === 0);
  });
}

// WORK 1B -- abort OBSERVED during a live read-back or storage hydration must return a BOUNDED deadline result, start NO
// subsequent write, and NEVER claim an issued write was undone. Driven through the REAL release with the controller
// aborted the instant the named read settles (the release rechecks abort immediately after every such awaited read).
test("work1B (behavioral): abort during the BRAND SALES candidate live read-back -> deadline-aborted; ZERO brand-inventory writes (candidate resolves BEFORE the cycle opens)", async () => {
  const world = makeWorld();
  const controller = new AbortController();
  const { release } = wireRelease(world, { leaseFence: { ownerToken: "op", generation: 1 }, aborted: () => controller.signal.aborted, controller, abortOnReadback: "brand-sales" });
  const res = await release.runForAccount({ accountId: A, requestedAsOf: ASOF, cycleBucket: "priority-partial-india-x", signal: controller.signal });
  ok("bounded deadline-aborted result", res.ok === false && res.status === "DEADLINE_ABORTED");
  ok("ZERO brand-inventory writes (no cycle open / upsert / shadow / publish)", world.writes.openCalls === 0 && world.writes.upsertedReportKeys.length === 0 && world.writes.shadowSavedKeys.length === 0 && world.writes.publishedLiveKeys.length === 0);
});

test("work1B (behavioral): abort during BRAND SALES storage hydration -> deadline-aborted; ZERO brand-inventory writes", async () => {
  const world = makeWorld({ bsShadowStoragePath: "storage/bs-shadow" });
  const controller = new AbortController();
  const { release } = wireRelease(world, { leaseFence: { ownerToken: "op", generation: 1 }, aborted: () => controller.signal.aborted, controller, abortOnStorage: "storage/bs-shadow" });
  const res = await release.runForAccount({ accountId: A, requestedAsOf: ASOF, cycleBucket: "priority-partial-india-x", signal: controller.signal });
  ok("bounded deadline-aborted result", res.ok === false && res.status === "DEADLINE_ABORTED");
  ok("ZERO brand-inventory writes", world.writes.openCalls === 0 && world.writes.upsertedReportKeys.length === 0 && world.writes.shadowSavedKeys.length === 0 && world.writes.publishedLiveKeys.length === 0);
});

test("work1B (behavioral): abort during the FINAL brand-inventory live read-back -> deadline-aborted; the publish already LANDED (exactly one), NO subsequent write, never a claimed undo/success", async () => {
  const world = makeWorld();
  const controller = new AbortController();
  const { release } = wireRelease(world, { leaseFence: { ownerToken: "op", generation: 1 }, aborted: () => controller.signal.aborted, controller, abortOnReadback: "brand-inventory" });
  const res = await release.runForAccount({ accountId: A, requestedAsOf: ASOF, cycleBucket: "priority-partial-india-x", signal: controller.signal });
  ok("bounded deadline-aborted result (NOT a claimed readback-verified success)", res.ok === false && res.status === "DEADLINE_ABORTED");
  ok("the brand-inventory publish LANDED exactly once -- an issued write is NEVER claimed undone", world.writes.publishedLiveKeys.filter((k) => k === RK).length === 1 && !!liveRow(world));
  ok("no write starts after the read-back abort (the read-back is the last step)", world.writes.publishedLiveKeys.length === 1);
});

test("blocker 2 (fenced CAS final defense): a NULL control fence makes the REAL publisher's live CAS write ZERO rows", async () => {
  // Establish a real live row + a ready brand-inventory shadow via a normal successful reconcile.
  const world = makeWorld();
  const h = buildProd(world);
  await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  const liveBefore = JSON.stringify(liveRow(world).payload);
  const publishedBefore = world.writes.publishedLiveKeys.length;
  // Now build the REAL publisher with a NULL control fence (as if the op was aborted) and attempt to publish the SAME
  // ready shadow. The fenced CAS is the FINAL defense: no owner token/generation -> zero rows written.
  const { publisher } = wireRelease(world, { leaseFence: () => null, aborted: () => false });
  const res = await publisher.publish(RK, A);
  ok("the null-fenced publish reports lease-lost (no ownership to write)", res && String(res.disposition) === "lease-lost");
  ok("ZERO additional live rows written; the live payload is byte-for-byte unchanged", world.writes.publishedLiveKeys.length === publishedBefore && JSON.stringify(liveRow(world).payload) === liveBefore);
});

export { makeWorld, wireRelease, buildProd, liveRow };

async function main() {
  writeSync(1, "fba-reconcile-prodshape\n");
  let failures = 0;
  for (const t of tests) { try { await t.fn(); } catch (e) { failures += 1; writeSync(1, "FAIL  " + t.name + "\n" + String((e && e.stack) || e) + "\n"); } }
  writeSync(1, `\nfba-reconcile-prodshape: ${passed} assertions passed${failures ? ", " + failures + " FAILED" : ""}\n`);
  if (failures) process.exitCode = 1;
}
if (import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(String(process.argv[1]).replace(/\\/g, "/"))) main();
