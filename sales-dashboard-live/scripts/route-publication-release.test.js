// Publication recovery WP4 -- the GENERIC ROUTE RELEASE (route-publication-release.js), its saved-data reconciler
// adapter + CLI helpers, the ROUTE control package + opt-in bounded lease-wait (source-priority-control-package.js), the
// hoisted terminal-cycle resume predicate (publication-binding.js) and the route module contract (route-contract.js).
//
// Proves, fully offline (a faithful in-memory lineage world: sync_cycles open=pending -> claim=running -> finalize, an
// insert-if-absent sync_report_jobs with the derive lease + reconcile, the report_snapshots shadow CAS and the FENCED
// live CAS (lease-lost on a stale fence; equal stamp => canonical params THEN payload identity), driven by the REAL
// four-gate publisher (publisher-composition.js buildSchedulerV2Publisher with build-time overrides), the REAL shared
// live read-back, the REAL serve selector and the REAL saved-data reconciler two-phase core; ZERO DataDoe / Supabase /
// network -- the global fetch is a refusing stub and its call count is asserted 0):
//   A. release: normal publish end to end (+ through the reconciler: publish, then PUBLICATION_NOT_REQUIRED with the
//      served-row check + the TARGETS v2 tok echo); crash after finalize resumes with ZERO new cycle/job/shadow writes;
//      crash before finalize resumes the running cycle; A -> B -> A converges through a NEW nonce cycle; TOCTOU at entry /
//      before the first write / before publish each defer with zero writes; asof-rolled; shadow newer-live (identical ->
//      adopted, then proven; different -> typed integrity failure); payload-too-large; payload-invalid; dataUnavailable
//      never promoted; publish outcomes NEWER_LIVE / refused-but-identical already-current / lease-lost / served-row-
//      differs vs preempted; stampPolicy 'evidence'; two concurrent prepares of different revisions; identity hooks
//      (sku-movement: target != live account).
//   B. adapter + CLI helpers: normalizeRouteRevision, the evidence-token echo, servedCheck mapping, verify-exact,
//      parseRouteCliArgs, the operator bound, the durable directory, the read-only supabase facade.
//   C. control package: every dispatch paused + the POST assertion, array promoted keys, the string-input call surface
//      BYTE-IDENTICAL to the pre-WP4 module (pinned golden digest), the bounded lease-wait (CONTROL_LEASE_HELD only).
//   D. the hoisted resumableAtTerminalCycle (identical to the pre-hoist inline predicate; the three releases share it)
//      and the route module contract.
//   E. the WP4 verifier findings: E1 no terminal-cycle strand (A -> B -> C killed after its job insert -> A nonces over
//      the non-promotable latest job); E2 the zero-CAS fast paths require live stamp == the latest shadow's (probe2
//      converges: the live pass publishes, verify passes); E3 content digests over the STORED form (undefined keys,
//      Dates); E4 the multi-route CLI sequence STOPS after an unresolved control plane (real runControlPackageCli over a
//      fake control store whose safe-close ack is lost); E5 a manifest drift: typed 'manifest-differs' kept through
//      TARGETS, repaired by a LIVE exact pass (new content-addressed shadow, fenced publish); E6 a content-equivalence
//      currentPredicate proof honoured by verify-exact (only with the explicit marker); E7 the prune DELETE takes the
//      signal and never starts after an abort; E8 'lineage-advanced-before-write'; E9 the lease-wait capped at the
//      deadline minus START_RESERVE.
//   F. the round-2 verifier findings: F1 (P3-2) stampPolicy 'evidence' + a manifest drift under an unchanged revision
//      AND evidence instant (probeA) defers the typed 'evidence-instant-not-advanced' (never NEWER_LIVE / superseded,
//      zero writes), a strictly newer live row stays NEWER_LIVE, and the drift converges once the instant advances
//      (probeB shape: alternating drifts with advancing instants publish + verify every pass, idle passes write
//      nothing); F2 (P3-3) the claimed job-less cycle of a 'lineage-advanced-before-write' deferral is finalized under
//      the REAL finalize_sync_cycle state table (zero jobs -> 'succeeded', report_total 0), a same-bucket twin's open
//      job keeps it running ('open-work'), an unclaimed cycle is never finalized; F3 (WP7 round-2 P1) the optional
//      publishGuard hook: resolveBundle's guard equal at b1/b2 and carried on EVERY prepared result (resumed too),
//      run inside the lease after verifyLease and immediately before publisher.publish, NEWER_LIVE / deferral /
//      throw / malformed -> typed results with ZERO CAS; absent -> no prepared.guard key, unchanged flow.
// 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

process.env.SUPABASE_URL = "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = ["test", "svc", "role", "key"].join("-");

// The network is NEVER reached: every fetch is recorded and refused.
const net = { calls: [] };
globalThis.fetch = async (url, opts = {}) => { net.calls.push(String(opts.method || "GET") + " " + String(url)); throw new Error("network refused in an offline test"); };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(path.join(ROOT, p), "utf8");

const REL = await import("../lib/server/sync/route-publication-release.js");
const { buildSchedulerV2Publisher } = await import("../lib/server/sync/publisher-composition.js");
const { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, skuMovementTargetId } = await import("../lib/server/sync/report-publisher.js");
const { REPORT_DERIVATIONS } = await import("../lib/server/sync/report-derivation.js");
const { paramsHashFor } = await import("../lib/server/report-store.js");
const B = await import("../lib/server/sync/publication-binding.js");
const SDR = await import("../lib/server/sync/saved-data-reconciler.js");
const CP = await import("../lib/server/sync/source-priority-control-package.js");
const RC = await import("../lib/server/recovery/route-contract.js");
const SEL = await import("../lib/server/recovery/serve-selectors.js");
const TGT = await import("../lib/server/sync/reconcile-targets-output.js");
const { CONTROLLED_REPORT_KEYS, SOURCE_PROMOTED_REPORT_KEYS } = await import("../lib/server/sync/report-controls.js");
const { accountInScope } = await import("../lib/server/sync/scheduler-scope.js");
const SB = await import("../lib/server/supabase.js");

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; out("  ok  " + name); };
const S = (v) => (v == null ? "" : String(v));

const RL = "returns-leakage-v3";
const SKU = "sku-movement";
const ACC = "IN1";
const ACC2 = "IN2";
const EPOCH = "2026-09-24";
const ASOF = "2026-09-23";
const REGION = "india";
const RS = { NR: "PUBLICATION_NOT_REQUIRED", RV: "READBACK_VERIFIED", DD: "DEFERRED_DEPENDENCY", FD: "FAILED_DERIVE", FP: "FAILED_PUBLISH", FR: "FAILED_READBACK" };

// A VALID returns-leakage-v3 payload (REPORT_DERIVATIONS[returns-leakage-v3].validatePayload).
const returnsPayload = (acct, asOf, total = 1) => ({ version: "returns-leakage-v3", accountId: acct, asOf, rows: [{ asin: "B0X", refunds: total }], currencies: ["INR"], window: { from: "2026-07-26", to: asOf }, dayAxis: [asOf], series: { refunds: [total] }, freshness: { latestDataDate: asOf }, latestDataDate: asOf });
// A VALID sku-movement/v2 payload whose own identity is (owner, brand, asOf).
const skuPayload = (acct, asOf, brand = "ALL") => ({ rows: [], brandFiltered: String(brand).toUpperCase() !== "ALL", effectiveAsOf: asOf, accountId: acct, brand });

// =====================================================================================================================
// The faithful in-memory lineage world.
// =====================================================================================================================
function makeWorld({ key = RL, promoted = [key], rollout = [ACC, ACC2], discovered = [ACC, ACC2] } = {}) {
  const cycles = new Map(); const jobs = []; const snaps = new Map(); const storage = new Map();
  const n = { cycleCreate: 0, jobInsert: 0, claimLease: 0, shadowCas: 0, shadowWrite: 0, reconcile: 0, finalize: 0, liveCas: 0, liveWrite: 0, preflight: 0, publish: 0, snapshotUpdate: 0, prune: 0 };
  let seq = 0; let clock = Date.UTC(2026, 8, 24, 6, 0, 0);
  const iso = (ms) => new Date(ms).toISOString();
  const w = { cycles, jobs, snaps, storage, n, promoted: [...promoted], rollout: [...rollout], discovered: [...discovered] };
  w.now = () => clock;
  w.tick = (ms = 60000) => { clock += ms; return clock; };
  w.fence = { ownerToken: "op-owner", generation: 7 };
  w.lease = { ownerToken: "op-owner", generation: 7 };
  w.leaseOk = true;
  const cycleById = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  const jobOf = (cycleId, rk, a) => jobs.find((j) => j.cycle_id === cycleId && j.report_key === rk && j.account_id === a) || null;
  const snapKey = (rk, a, h) => rk + "|" + a + "|" + h;
  w.openCycle = async ({ bucket, cycleDate }) => { const k = bucket + "|" + cycleDate; if (!cycles.has(k)) { n.cycleCreate += 1; cycles.set(k, { id: "cyc-" + (++seq), bucket, cycle_date: cycleDate, status: "pending", created_at: iso(w.tick()) }); } };
  w.getCycleByBucketDate = async (bucket, cycleDate) => { const c = cycles.get(bucket + "|" + cycleDate); return c ? { ...c } : null; };
  w.claimCycle = async (id) => { const c = cycleById(id); if (c && c.status === "pending") { c.status = "running"; return true; } return false; };
  w.readCycle = async (id) => { const c = cycleById(id); return c ? { ...c } : null; };
  w.upsertReportJob = async (job) => {
    if (jobOf(job.cycleId, job.reportKey, job.accountId)) return;
    n.jobInsert += 1;
    jobs.push({ id: "job-" + (++seq), cycle_id: job.cycleId, report_key: job.reportKey, account_id: job.accountId, bucket: job.bucket, connection_id: job.connectionId, report_version: job.reportVersion, depends_on: [...(job.dependsOn || [])], durable_content_deps: [...(job.durableContentDeps || [])], derive_status: "pending", save_status: "pending", validated: false, snapshot_params_hash: null, lease_token: null, lease_expires: 0, created_at: ++seq });
  };
  w.claimLease = async (cycleId, rk, a, { leaseSeconds = 300 } = {}) => {
    n.claimLease += 1;
    const j = jobOf(cycleId, rk, a);
    if (!j) return { disposition: "not-found", leaseToken: null, snapshotParamsHash: null };
    if (j.validated === true) return { disposition: "already-complete", leaseToken: null, snapshotParamsHash: j.snapshot_params_hash };
    if (j.derive_status === "running" && j.lease_expires > clock) return { disposition: "held", leaseToken: null, snapshotParamsHash: null };
    const disposition = j.derive_status === "running" ? "reclaimed" : "claimed";
    j.derive_status = "running"; j.lease_token = "lt-" + (++seq); j.lease_expires = clock + leaseSeconds * 1000;
    return { disposition, leaseToken: j.lease_token, snapshotParamsHash: null };
  };
  w.saveShadow = async ({ reportKey, accountId, paramsHash, params, payload, sourceRefreshedAt }) => {
    n.shadowCas += 1;
    if (typeof w.onShadowCas === "function") { const forced = w.onShadowCas({ reportKey, accountId, paramsHash, params, payload, sourceRefreshedAt }); if (forced) return forced; }
    const k = snapKey(reportKey, accountId, paramsHash); const cur = snaps.get(k);
    const cand = Date.parse(sourceRefreshedAt);
    if (cur) {
      const have = Date.parse(cur.source_refreshed_at);
      if (have > cand) return { outcome: "newer-live" };
      if (have === cand) return B.stableJson(cur.params) === B.stableJson(params) && B.stableJson(cur.payload) === B.stableJson(payload) ? { outcome: "already-current" } : { outcome: "conflict" };
    }
    n.shadowWrite += 1;
    snaps.set(k, { id: "snap-" + (++seq), report_key: reportKey, account_id: accountId, params_hash: paramsHash, params: JSON.parse(JSON.stringify(params)), payload: JSON.parse(JSON.stringify(payload)), payload_storage_path: null, source_refreshed_at: sourceRefreshedAt, updated_at: iso(w.tick(1000)) });
    return { outcome: cur ? "replaced" : "inserted" };
  };
  w.reconcileSuccess = async ({ cycleId, reportKey, accountId, snapshotParamsHash, leaseToken }) => {
    n.reconcile += 1;
    const j = jobOf(cycleId, reportKey, accountId); if (!j) return { disposition: "not-found" };
    if (j.validated === true) return { disposition: "already-complete" };
    if (j.lease_token !== leaseToken) return { disposition: "lease-lost" };
    Object.assign(j, { validated: true, derive_status: "succeeded", save_status: "succeeded", snapshot_params_hash: snapshotParamsHash });
    return { disposition: "reconciled" };
  };
  w.finalizeCycle = async ({ cycleId }) => {
    n.finalize += 1;
    const c = cycleById(cycleId); if (!c) return { disposition: "not-found" };
    if (c.status === "succeeded" || c.status === "partial") return { disposition: "already-terminal" };
    if (c.status !== "running") return { disposition: "invalid-status" };
    c.status = jobs.some((j) => j.cycle_id === cycleId && j.validated === true) ? "succeeded" : "partial";
    return { disposition: "finalized" };
  };
  const latestJobRow = (rk, a) => jobs.filter((x) => x.report_key === rk && x.account_id === a).sort((x, y) => y.created_at - x.created_at)[0] || null;
  w.lineage = (rk, a) => {
    const j = latestJobRow(rk, a); if (!j) return null;
    const c = cycleById(j.cycle_id);
    return { reportKey: j.report_key, accountId: j.account_id, deriveStatus: j.derive_status, saveStatus: j.save_status, validated: j.validated === true, dependsOn: j.depends_on.map(String), durableContentDeps: j.durable_content_deps.map(String), snapshotParamsHash: j.snapshot_params_hash, latestDataDate: null, cycleStatus: c ? c.status : null, id: j.id, cycleId: j.cycle_id, createdAt: j.created_at };
  };
  w.readLatestJob = async (rk, a) => w.lineage(rk, a);
  w.readSnapshot = async ({ reportKey, accountId, paramsHash }) => { const r = snaps.get(snapKey(reportKey, accountId, paramsHash)); return r ? JSON.parse(JSON.stringify(r)) : null; };
  w.loadStoragePayload = async (p) => (storage.has(p) ? JSON.parse(JSON.stringify(storage.get(p))) : null);
  // The serve readers (report-store / supabase.js selector semantics) over the same rows.
  const byAcct = (rk, a) => [...snaps.values()].filter((r) => r.report_key === rk && r.account_id === a);
  const newest = (rows) => rows.sort((x, y) => (x.updated_at < y.updated_at ? 1 : x.updated_at > y.updated_at ? -1 : 0))[0] || null;
  w.readers = {
    getReportSnapshot: w.readSnapshot,
    getLatestReportSnapshot: async ({ reportKey, accountId }) => newest(byAcct(reportKey, accountId)),
    getLatestReportSnapshotForScope: async ({ reportKey, accountId, reportVersion = null, scope = {} }) => newest(byAcct(reportKey, accountId).filter((r) => (reportVersion == null || S(r.params && r.params.reportVersion) === S(reportVersion)) && Object.entries(scope || {}).every(([k, v]) => v == null || S(r.params && r.params[k]) === S(v)))),
  };
  // The FENCED live CAS (publishLiveSnapshotFencedIfNewer + cas_report_snapshot_if_newer_fenced semantics).
  w.liveCas = async ({ reportKey, accountId, paramsHash, params, payload, sourceRefreshedAt, ownerToken, generation }) => {
    n.liveCas += 1;
    if (ownerToken !== w.lease.ownerToken || Number(generation) !== Number(w.lease.generation)) return { outcome: "lease-lost", reason: "fence-mismatch" };
    const k = snapKey(reportKey, accountId, paramsHash); const cur = snaps.get(k);
    const cand = Date.parse(sourceRefreshedAt);
    if (cur) {
      const have = Date.parse(cur.source_refreshed_at);
      if (have > cand) return { outcome: "newer-live" };
      if (have === cand) return B.stableJson(cur.params) === B.stableJson(params) && B.stableJson(cur.payload) === B.stableJson(payload) ? { outcome: "already-current" } : { outcome: "conflict" };
    }
    n.liveWrite += 1;
    snaps.set(k, { id: "live-" + (++seq), report_key: reportKey, account_id: accountId, params_hash: paramsHash, params: JSON.parse(JSON.stringify(params)), payload: JSON.parse(JSON.stringify(payload)), payload_storage_path: null, source_refreshed_at: sourceRefreshedAt, updated_at: iso(w.tick(1000)) });
    return { outcome: cur ? "replaced" : "inserted" };
  };
  // The REAL four-gate publisher (production composition with BUILD-TIME overrides only).
  let publisher = null;
  w.publisherFor = (signal) => {
    w.activeSignal = signal || null;
    if (!publisher) {
      const real = buildSchedulerV2Publisher({
        connections: [{ id: "primary", apiKey: "test-key", label: "Primary" }],
        fetchAccounts: async () => w.discovered.map((id) => ({ id, name: id, country: "IN" })),
        getAccountRollout: async () => ({ read: "ok", allPrimary: false, enabledAccountIds: w.rollout }),
        getSettings: async () => [],
        getPromotedSettings: async () => w.promoted.map((rk) => ({ report_key: rk, publish_enabled: true })),
        getApproval: async () => ({ read: "ok", approved: true }),
        getJob: async (rk, a) => { const j = latestJobRow(rk, a); if (!j) return null; const c = cycleById(j.cycle_id); return { cycle_id: j.cycle_id, report_key: rk, account_id: a, derive_status: j.derive_status, save_status: j.save_status, validated: j.validated === true, snapshot_params_hash: j.snapshot_params_hash, cycle_status: c ? c.status : null }; },
        getSnapshot: w.readSnapshot,
        loadStoragePayload: w.loadStoragePayload,
        publishLiveFenced: (args) => w.liveCas(args),
        getControlFence: () => (w.activeSignal && w.activeSignal.aborted ? null : w.fence),
      });
      publisher = {
        preflight: async (rk, a) => { n.preflight += 1; return real.preflight(rk, a); },
        publish: async (rk, a) => { n.publish += 1; return real.publish(rk, a); },
      };
    }
    return publisher;
  };
  w.verifyLease = async () => (w.leaseOk ? { ok: true } : { ok: false, reason: "lease-expired" });
  w.readbackLive = REL.buildRouteLiveReadback({ getReportSnapshot: w.readSnapshot, loadStoragePayload: w.loadStoragePayload, liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, reportDerivations: REPORT_DERIVATIONS, computeHash: paramsHashFor });
  w.writes = () => n.cycleCreate + n.jobInsert + n.shadowWrite + n.reconcile + n.finalize + n.liveWrite;
  return w;
}

// The release deps over a world (+ overrides).
const releaseDeps = (w, over = {}) => ({
  openCycle: w.openCycle, getCycleByBucketDate: w.getCycleByBucketDate, claimCycle: w.claimCycle, readCycle: w.readCycle,
  upsertReportJob: w.upsertReportJob, claimLease: w.claimLease, saveShadow: w.saveShadow, reconcileSuccess: w.reconcileSuccess, finalizeCycle: w.finalizeCycle,
  readLatestJob: w.readLatestJob, readSnapshot: w.readSnapshot, loadStoragePayload: w.loadStoragePayload,
  publisherFor: w.publisherFor, verifyLease: w.verifyLease, readbackLive: w.readbackLive,
  liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, reportDerivations: REPORT_DERIVATIONS, computeHash: paramsHashFor,
  publishSnapshotUpdate: async () => { w.n.snapshotUpdate += 1; },
  now: () => w.now(),
  ...over,
});

// ---- the returns-v3 FIXTURE route (a minimal CLI-side route; the real one is WP5) -----------------------------------
// Evidence per account: { v (revision), m (manifest), asOf, total, instant }. The L1 token is "rl1:<v>".
const RL_ROUTE = Object.freeze({ id: "returns-v3", publisherKey: RL, stampPolicy: "cycle" });
function makeRlRuntime(w, { evidence, stamp = "cycle", over = {} } = {}) {
  const calls = { resolve: 0, derive: 0, served: 0 };
  const ev = (a) => (typeof evidence === "function" ? evidence(a, calls) : evidence.get(a));
  const bundleOf = (a) => { const e = ev(a); return e ? { eligible: true, revisionId: "rev-" + e.v, evidenceToken: "rl1:" + e.v, manifestToken: "mf1:" + e.m, deps: ["dep:" + a], evidenceInstant: e.instant, bundle: { e } } : { eligible: false, reason: "returns-evidence-missing" }; };
  const runtime = {
    readScopeEvidence: async ({ scope }) => ({ ok: true, perAccount: new Map(scope.map((a) => [a, ev(a) || null])) }),
    computeRevision: ({ accountId, evidence: e }) => (e ? { eligible: true, revisionId: "rev-" + e.v, evidenceToken: "rl1:" + e.v, deps: ["dep:" + accountId], status: "available" } : { eligible: false, reason: "returns-evidence-missing" }),
    resolveBundle: async (unit) => { calls.resolve += 1; return bundleOf(unit.targetId); },
    derive: async (bundle) => { calls.derive += 1; return { payload: returnsPayload(ACC, bundle.e.asOf, bundle.e.total), latestDataDate: bundle.e.asOf }; },
    identityParams: (unit, { bundle }) => ({ to: bundle.e.asOf }),
    identityAsOf: (unit, { bundle }) => bundle.e.asOf,
    // The unit binds at the EVIDENCE's identity as-of (the returns latestDataDate), never the run epoch.
    expandUnits: async ({ accountId, evidence: e }) => [{ unitKey: "-", targetId: accountId, liveAccountId: accountId, ownerAccountIds: [accountId], targetAsOf: e ? e.asOf : null, reportKeys: [RL] }],
    servedSelector: async (unit) => { calls.served += 1; return SEL.selectLatestForScope({ reportKey: "returns-leakage", accountId: unit.liveAccountId, reportVersion: "returns-leakage-v3", scope: {}, readers: w.readers }); },
    ...over,
  };
  return { runtime, calls, route: stamp === "evidence" ? { ...RL_ROUTE, stampPolicy: "evidence" } : RL_ROUTE };
}
const rlUnit = (acct = ACC, asOf = ASOF) => ({ unitKey: "-", targetId: acct, liveAccountId: acct, ownerAccountIds: [acct], targetAsOf: asOf, reportKeys: [RL] });
const rlRevision = (v, acct = ACC) => REL.normalizeRouteRevision({ eligible: true, revisionId: "rev-" + v, evidenceToken: "rl1:" + v, deps: ["dep:" + acct] });
const liveHashRl = (asOf = ASOF) => paramsHashFor("returns-leakage-v3", { to: asOf });
const liveRowRl = (w, acct = ACC, asOf = ASOF) => w.snaps.get("returns-leakage|" + acct + "|" + liveHashRl(asOf)) || null;

function build(w, { evidence, stamp = "cycle", runtimeOver = {}, depsOver = {} } = {}) {
  const { runtime, calls, route } = makeRlRuntime(w, { evidence, stamp, over: runtimeOver });
  const release = REL.buildRoutePublicationRelease({ route, runtime, deps: releaseDeps(w, depsOver) });
  return { release, runtime, calls, route };
}
const prep = (release, { v, acct = ACC, unit = rlUnit(acct), signal = null } = {}) => release.prepareForUnit({ unit, revision: rlRevision(v, acct), epoch: EPOCH, region: REGION, bucket: REGION, accountId: acct, signal });
const pub = (release, prepared, { acct = ACC, unit = rlUnit(acct), signal = null } = {}) => release.publishForUnit({ unit, prepared, epoch: EPOCH, region: REGION, bucket: REGION, accountId: acct, signal });
const evMap = (entries) => new Map(Object.entries(entries));
const E1 = { v: "1", m: "a", asOf: ASOF, total: 1, instant: "2026-09-24T05:00:00.000Z" };
const E2 = { v: "2", m: "b", asOf: ASOF, total: 2, instant: "2026-09-24T05:30:00.000Z" };

// =====================================================================================================================
// A. the release
// =====================================================================================================================
{
  // A1. normal publish end to end.
  const w = makeWorld();
  const { release, calls } = build(w, { evidence: evMap({ [ACC]: E1 }) });
  const p = await prep(release, { v: "1" });
  ok("A1 prepare returns the typed two-phase contract { ok:true, prepared:true, code:0 } (statusFromRelease-compatible)", p.ok === true && p.prepared === true && p.code === 0 && p.resumed === false && p.alreadyCurrent === false && ["inserted", "replaced"].includes(p.shadowOutcome));
  const cyc = [...w.cycles.values()][0];
  ok("A1 prepare wrote EXACTLY one priority-partial cycle (the deterministic route bucket, epoch cycle_date) + one job + one shadow + reconcile + finalize", w.n.cycleCreate === 1 && w.n.jobInsert === 1 && w.n.shadowWrite === 1 && w.n.reconcile === 1 && w.n.finalize === 1 && w.n.liveWrite === 0
    && cyc.bucket === REL.routeCycleBucket({ region: REGION, routeId: "returns-v3", targetId: ACC, revisionId: "rev-1", nonce: "none" }) && /^priority-partial-india-[0-9a-f]{16}$/.test(cyc.bucket) && cyc.cycle_date === EPOCH && cyc.status === "succeeded");
  const job = w.jobs[0];
  ok("A1 the job carries the REAL region bucket, lineage depends_on = the bundle deps, durable_content_deps = [evidence, manifest] tokens", job.bucket === REGION && JSON.stringify(job.depends_on) === JSON.stringify(["dep:" + ACC]) && JSON.stringify(job.durable_content_deps) === JSON.stringify(["rl1:1", "mf1:a"]) && job.connection_id === "primary" && job.report_version === "returns-leakage/v3-route");
  const shadow = w.snaps.get("scheduler-v2/" + RL + "|" + ACC + "|" + p.shadowParamsHash);
  ok("A1 the shadow is content-addressed: params { reportVersion, accountId: target, to, route, rev, evidenceToken, manifestToken } hashed by paramsHashFor", !!shadow && shadow.params.route === "returns-v3" && shadow.params.rev === "rev-1" && shadow.params.evidenceToken === "rl1:1" && shadow.params.manifestToken === "mf1:a" && shadow.params.to === ASOF && shadow.params.accountId === ACC && paramsHashFor(shadow.params.reportVersion, shadow.params) === p.shadowParamsHash && shadow.source_refreshed_at === cyc.created_at);
  const r = await pub(release, p);
  const live = liveRowRl(w);
  ok("A1 publish -> published through the REAL four-gate publisher + fenced CAS + read-back + served-row check (code 0)", r.ok === true && r.code === 0 && r.disposition === "published" && r.alreadyCurrent === false && w.n.preflight === 1 && w.n.publish === 1 && w.n.liveWrite === 1 && SDR.statusFromRelease(r) === RS.RV);
  ok("A1 the live row: exact identity { to } hash, the route tokens STORED (never hashed), the shadow's stamp; the served row IS it", !!live && live.params.evidenceToken === "rl1:1" && live.params.manifestToken === "mf1:a" && live.params.reportVersion === "returns-leakage-v3" && live.source_refreshed_at === shadow.source_refreshed_at && r.served && r.served.id === live.id && r.served.params_hash === liveHashRl() && w.n.snapshotUpdate === 1);
  ok("A1 zero network (zero DataDoe) across prepare + publish; the served selector ran", net.calls.length === 0 && calls.served >= 1);

  // A1b. the SAME world through the REAL saved-data reconciler two-phase core + the route adapter.
  const w2 = makeWorld();
  const ev2 = evMap({ [ACC]: E1 });
  const b2 = build(w2, { evidence: ev2 });
  const controls = { opened: [], closed: 0 };
  const reconciler = (dry = false) => SDR.buildSavedDataReconciler({
    resolveOrg: async () => ({ organizationFingerprint: "org-fp", connectionId: "primary" }),
    bucketAccounts: async () => [{ accountId: ACC }],
    adapter: REL.buildRouteReconcileAdapter({ route: b2.route, runtime: b2.runtime, bucket: REGION, liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, readLatestJob: w2.readLatestJob }),
    readLatestReportJob: ({ reportKey, accountId }) => w2.readLatestJob(reportKey, accountId),
    readShadowSnapshot: (a) => w2.readSnapshot(a), readLiveSnapshot: (a) => w2.readSnapshot(a), loadStoragePayload: w2.loadStoragePayload,
    verifyLiveReadback: w2.readbackLive, liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, computeHash: paramsHashFor, reportDerivations: REPORT_DERIVATIONS,
    runPrepareForUnit: (a) => b2.release.prepareForUnit(a), runPublishForUnit: (a) => b2.release.publishForUnit(a),
    openControls: async (x) => { controls.opened.push(x); return { ok: true }; }, closeControls: async () => { controls.closed += 1; return { ok: true }; },
    reportKeys: [RL], family: "returns-v3",
  });
  const s1 = await reconciler().run({ bucket: REGION, requestedAsOf: EPOCH, mode: "periodic", dryRun: false });
  ok("A1b reconciler: the stale unit prepares (no controls) then publishes inside ONE control window for its owner + publisher key -> READBACK_VERIFIED", s1.ok === true && s1.counts.targetsPublished === 1 && controls.opened.length === 1 && JSON.stringify(controls.opened[0]) === JSON.stringify({ owners: [ACC], publisherKeys: [RL] }) && controls.closed === 1);
  const s2 = await reconciler().run({ bucket: REGION, requestedAsOf: EPOCH, mode: "periodic", dryRun: true });
  const u2 = s2.perAccount[0].reports[RL];
  ok("A1b re-scan: PUBLICATION_NOT_REQUIRED via the exact binding AND the served-row check (served = the canonical live row)", u2.state === RS.NR && u2.served && u2.served.h === liveHashRl() && u2.h === liveHashRl());
  const tline = TGT.parseTargetsLine(TGT.formatTargetsLine({ v: 2, route: "returns-v3", summary: { ...s2, bucket: REGION, requestedAsOf: EPOCH, dryRun: true } }));
  ok("A1b TARGETS v2: the target's tok echoes the route's evaluated evidence token (computeAccountRevision.evidenceToken)", tline && tline.targets[0].tok === "rl1:1" && tline.targets[0].units[0].s === RS.NR && !("r" in tline.targets[0]));
  const writesBefore = w2.writes();
  const s3 = await reconciler().run({ bucket: REGION, requestedAsOf: EPOCH, mode: "periodic", dryRun: false });
  ok("A1b a live pass over a current unit performs ZERO writes and opens ZERO controls", s3.ok === true && s3.counts.targetsAlreadyCurrent === 1 && w2.writes() === writesBefore && controls.opened.length === 1);
  // A1c: the live row re-stamped NEWER (identical content, same tokens) -> the binding says STALE (live-refresh-differs).
  // The zero-CAS fast path no longer proves it (the live stamp != the latest shadow's stamp), so the unit goes through
  // the fenced publish: the CAS REFUSES the older shadow ('newer-live', zero rows written) and the release PROVES it
  // already current (content + lineage + served read-back) -> counted PUBLICATION_NOT_REQUIRED 'already-current'
  // (never published), ONE refused CAS attempt, ZERO writes.
  const lk = "returns-leakage|" + ACC + "|" + liveHashRl();
  w2.snaps.get(lk).source_refreshed_at = "2026-09-24T23:00:00.000Z";
  const cas4 = w2.n.liveCas; const writes4 = w2.writes();
  const s4 = await reconciler().run({ bucket: REGION, requestedAsOf: EPOCH, mode: "periodic", dryRun: false });
  const u4 = s4.perAccount[0].reports[RL];
  ok("A1c a NEWER-stamped content-identical live row is counted ALREADY-CURRENT (PUBLICATION_NOT_REQUIRED, reason 'already-current', served = the live row) -- never 'published', one REFUSED CAS, zero writes", s4.ok === true && s4.counts.targetsPublished === 0 && s4.counts.targetsAlreadyCurrent === 1 && u4.state === RS.NR && u4.reason === "already-current" && u4.served && u4.served.h === liveHashRl() && u4.sra === "2026-09-24T23:00:00.000Z" && w2.n.liveCas === cas4 + 1 && w2.writes() === writes4);
}

{
  // A2. crash AFTER finalize (before publish): the retry resumes with ZERO cycle/job/shadow/finalize writes.
  const w = makeWorld();
  const { release } = build(w, { evidence: evMap({ [ACC]: E1 }) });
  const p1 = await prep(release, { v: "1" });
  const before = { ...w.n };
  const p2 = await prep(release, { v: "1" });
  ok("A2 crash after finalize: the retry RESUMES (latest job promotable + covers the revision + its shadow valid) -- zero new cycle/job/shadow/finalize writes", p2.ok === true && p2.prepared === true && p2.code === 0 && p2.resumed === true && p2.shadowParamsHash === p1.shadowParamsHash && w.n.cycleCreate === before.cycleCreate && w.n.jobInsert === before.jobInsert && w.n.shadowCas === before.shadowCas && w.n.finalize === before.finalize);
  const r = await pub(release, p2);
  ok("A2 ... and publishes (never a TERMINAL_CYCLE strand)", r.ok === true && r.disposition === "published" && w.n.liveWrite === 1);
  const p3 = await prep(release, { v: "1" });
  const writes = w.writes(); const casBefore = w.n.liveCas;
  const r3 = await pub(release, p3);
  ok("A2 an identical re-run after publish: resumed -> proven already-current (content + lineage + read-back) with ZERO CAS", p3.resumed === true && r3.ok === true && r3.alreadyCurrent === true && r3.disposition === "already-current" && w.n.liveCas === casBefore && w.writes() === writes && w.n.publish === 1);

  // A3. crash BEFORE finalize: the retry resumes the RUNNING cycle (no new cycle).
  const w3 = makeWorld();
  let failFinalize = true;
  const b3 = build(w3, { evidence: evMap({ [ACC]: E1 }), depsOver: { finalizeCycle: async (a) => { if (failFinalize) { failFinalize = false; throw new Error("process killed"); } return w3.finalizeCycle(a); } } });
  const f1 = await prep(b3.release, { v: "1" });
  ok("A3 a crash at finalize is a typed hard failure (finalize stage)", f1.ok === false && f1.stage === "finalize" && SDR.statusFromRelease(f1) === RS.FP);
  const cyc1 = [...w3.cycles.values()][0];
  const f2 = await prep(b3.release, { v: "1" });
  ok("A3 the retry RESUMES the running cycle (same bucket, zero new cycle / job / shadow; lease already-complete) and finalizes it", f2.ok === true && f2.prepared === true && w3.n.cycleCreate === 1 && w3.n.jobInsert === 1 && w3.n.shadowWrite === 1 && f2.shadowOutcome === "already-complete" && [...w3.cycles.values()][0].id === cyc1.id && [...w3.cycles.values()][0].status === "succeeded");
  ok("A3 ... then publishes", (await pub(b3.release, f2)).disposition === "published");

  // A3b. crash mid-derive (lease held): defers claim-held until the lease expires, then reclaims.
  const w4 = makeWorld();
  let failShadow = true;
  const b4 = build(w4, { evidence: evMap({ [ACC]: E1 }), depsOver: { saveShadow: async (a) => { if (failShadow) { failShadow = false; throw new Error("killed mid-derive"); } return w4.saveShadow(a); } } });
  const h1 = await prep(b4.release, { v: "1" });
  const h2 = await prep(b4.release, { v: "1" });
  ok("A3b a crash mid-derive leaves the derive lease HELD -> the retry defers claim-held (retryable), zero new cycle", h1.ok === false && h2.ok === false && h2.reason === "claim-held" && SDR.statusFromRelease(h2) === RS.DD && w4.n.cycleCreate === 1);
  w4.tick(10 * 60 * 1000);
  const h3 = await prep(b4.release, { v: "1" });
  ok("A3b after the lease expires the retry RECLAIMS the same job in the same running cycle and completes", h3.ok === true && h3.prepared === true && w4.n.cycleCreate === 1 && w4.n.jobInsert === 1 && (await pub(b4.release, h3)).disposition === "published");
}

{
  // A4. A -> B -> A converges: each revision change opens a NEW nonce cycle; shadows are distinct by rev.
  const w = makeWorld();
  const ev = evMap({ [ACC]: E1 });
  const { release } = build(w, { evidence: ev });
  const pa = await prep(release, { v: "1" }); await pub(release, pa);
  ev.set(ACC, E2);
  const pb = await prep(release, { v: "2" }); const rb = await pub(release, pb);
  ev.set(ACC, E1);
  const pa2 = await prep(release, { v: "1" }); const ra2 = await pub(release, pa2);
  const buckets = [...w.cycles.values()].map((c) => c.bucket);
  const jobA = w.jobs[0];
  ok("A4 A->B->A: three DISTINCT cycles (the return to A nonces over B's promotable job id -- never the terminal A cycle)", new Set(buckets).size === 3 && buckets[2] === REL.routeCycleBucket({ region: REGION, routeId: "returns-v3", targetId: ACC, revisionId: "rev-1", nonce: w.jobs[1].id }) && jobA.id !== w.jobs[1].id);
  ok("A4 A->B->A: shadows are content-addressed by rev (A and B distinct; the return to A re-uses A's hash)", pa.shadowParamsHash !== pb.shadowParamsHash && pa2.shadowParamsHash === pa.shadowParamsHash && pa2.resumed === false);
  const live = liveRowRl(w);
  ok("A4 A->B->A converges: every publish landed, the live row carries A's tokens again with the newest cycle stamp", rb.disposition === "published" && ra2.disposition === "published" && live.params.evidenceToken === "rl1:1" && live.source_refreshed_at === [...w.cycles.values()][2].created_at);
}

{
  // A5. TOCTOU: entry / before the first write / before publish.
  const w = makeWorld();
  const { release } = build(w, { evidence: evMap({ [ACC]: E2 }) });
  const e1 = await prep(release, { v: "1" });
  ok("A5 TOCTOU at entry: the bundle is at another revision -> defer 'revision-advanced-at-entry', ZERO writes", e1.ok === false && e1.reason === "revision-advanced-at-entry" && SDR.statusFromRelease(e1) === RS.DD && w.writes() === 0);

  const wB = makeWorld();
  const seqEv = (a, calls) => (calls.resolve <= 1 ? E1 : E2); // the first resolve sees E1, the recheck E2
  const bB = build(wB, { evidence: seqEv });
  const e2 = await prep(bB.release, { v: "1" });
  ok("A5 TOCTOU before the first write: the recheck sees a new revision -> defer 'revision-advanced-before-write', ZERO writes", e2.ok === false && e2.reason === "revision-advanced-before-write" && wB.writes() === 0 && bB.calls.derive === 1);

  const wM = makeWorld();
  const bM = build(wM, { evidence: (a, calls) => (calls.resolve <= 1 ? E1 : { ...E1, m: "z" }) });
  const e3 = await prep(bM.release, { v: "1" });
  ok("A5 TOCTOU: a manifest-only advance before the first write -> defer 'manifest-advanced-before-write', ZERO writes", e3.ok === false && e3.reason === "manifest-advanced-before-write" && wM.writes() === 0);

  const wP = makeWorld();
  const evP = evMap({ [ACC]: E1 });
  const bP = build(wP, { evidence: evP });
  const pp = await prep(bP.release, { v: "1" });
  evP.set(ACC, E2);
  const before = wP.writes();
  const e4 = await pub(bP.release, pp);
  ok("A5 TOCTOU before publish: the L1 evidence token advanced -> defer 'evidence-advanced' with ZERO preflight / publish / CAS", e4.ok === false && e4.reason === "evidence-advanced" && SDR.statusFromRelease(e4) === RS.DD && wP.n.preflight === 0 && wP.n.publish === 0 && wP.n.liveCas === 0 && wP.writes() === before);
}

{
  // A6. asof-rolled.
  const w = makeWorld();
  const b = build(w, { evidence: evMap({ [ACC]: E1 }), runtimeOver: { identityAsOf: (() => { let k = 0; return () => (++k === 1 ? ASOF : "2026-09-24"); })() } });
  const r1 = await prep(b.release, { v: "1" });
  ok("A6 the identity as-of rolled between entry and the pre-write recheck -> defer 'asof-rolled', ZERO writes", r1.ok === false && r1.reason === "asof-rolled" && w.writes() === 0);
  const w2 = makeWorld();
  const b2 = build(w2, { evidence: evMap({ [ACC]: E1 }) });
  const r2 = await prep(b2.release, { v: "1", unit: rlUnit(ACC, "2026-09-22") });
  ok("A6 the derived identity as-of differs from the scan's unit.targetAsOf -> defer 'asof-rolled', ZERO writes", r2.ok === false && r2.reason === "asof-rolled" && w2.writes() === 0);
}

{
  // A7. shadow newer-live (a strictly-newer shadow at the SAME content-addressed hash).
  const w = makeWorld();
  const { release } = build(w, { evidence: evMap({ [ACC]: E1 }) });
  const first = await prep(release, { v: "1" });
  const shadowKey = "scheduler-v2/" + RL + "|" + ACC + "|" + first.shadowParamsHash;
  // Force a fresh cycle for the same revision (as a concurrent prepare in another nonce would) whose shadow CAS is refused
  // because the existing identical shadow is NEWER.
  w.snaps.get(shadowKey).source_refreshed_at = "2099-01-01T00:00:00.000Z";
  w.jobs.length = 0; // a new target history: no promotable job -> nonce 'none' bucket, but that cycle is terminal ...
  w.cycles.clear();
  const adopted = await prep(release, { v: "1" });
  ok("A7 a REFUSED shadow whose existing row is CONTENT-IDENTICAL (validated + equal payload digest) is ADOPTED: the job is reconciled to it + finalized (never counted current by itself)", adopted.ok === true && adopted.prepared === true && adopted.shadowOutcome === "adopted-newer" && adopted.alreadyCurrent === false && adopted.sourceRefreshedAt === "2099-01-01T00:00:00.000Z" && w.jobs[0].validated === true);
  const ra = await pub(release, adopted);
  ok("A7 ... and the unit still goes through the fenced publish + read-back + served check", ra.ok === true && ra.disposition === "published" && liveRowRl(w).source_refreshed_at === "2099-01-01T00:00:00.000Z");

  const wD = makeWorld();
  const bD = build(wD, { evidence: evMap({ [ACC]: E1 }) });
  const pD = await prep(bD.release, { v: "1" });
  const kD = "scheduler-v2/" + RL + "|" + ACC + "|" + pD.shadowParamsHash;
  wD.snaps.get(kD).source_refreshed_at = "2099-01-01T00:00:00.000Z";
  wD.snaps.get(kD).payload.rows = [{ asin: "B0X", refunds: 999 }];
  wD.jobs.length = 0; wD.cycles.clear();
  const d2 = await prep(bD.release, { v: "1" });
  ok("A7 a refused shadow with DIFFERENT content at the same hash -> typed integrity failure (FAILED_DERIVE), never adopted, never published", d2.ok === false && d2.reason === "shadow-newer-live:content-differs" && SDR.statusFromRelease(d2) === RS.FD && wD.n.liveWrite === 0);

  const wU = makeWorld();
  const bU = build(wU, { evidence: evMap({ [ACC]: E1 }), depsOver: {} });
  wU.onShadowCas = () => ({ outcome: "newer-live" }); // refused, but no readable row
  const u2 = await prep(bU.release, { v: "1" });
  ok("A7 a refused shadow that cannot be read back -> retryable deferral 'shadow-newer-live:<reason>', zero live writes", u2.ok === false && /^shadow-newer-live:shadow-missing$/.test(u2.reason) && SDR.statusFromRelease(u2) === RS.DD && wU.n.liveWrite === 0);
}

{
  // A8. payload gates: too large / invalid / dataUnavailable.
  const w = makeWorld();
  const b = build(w, { evidence: evMap({ [ACC]: E1 }), depsOver: { maxSnapshotBytes: 50 } });
  const r = await prep(b.release, { v: "1" });
  ok("A8 payload > MAX_SNAPSHOT_BYTES -> hard 'payload-too-large' (FAILED_DERIVE), ZERO writes", r.ok === false && r.reason === "payload-too-large" && SDR.statusFromRelease(r) === RS.FD && w.writes() === 0);
  const wI = makeWorld();
  const bI = build(wI, { evidence: evMap({ [ACC]: E1 }), runtimeOver: { derive: async () => ({ payload: { version: "returns-leakage-v2", rows: [] } }) } });
  const ri = await prep(bI.release, { v: "1" });
  ok("A8 a payload the REAL validatePayload rejects (a v2 payload) -> hard 'payload-invalid', ZERO writes", ri.ok === false && ri.reason === "payload-invalid" && SDR.statusFromRelease(ri) === RS.FD && wI.writes() === 0);
  const wU = makeWorld();
  const bU = build(wU, { evidence: evMap({ [ACC]: E1 }), runtimeOver: { derive: async (bundle) => ({ payload: { ...returnsPayload(ACC, bundle.e.asOf), dataUnavailable: true } }) } });
  const ru = await prep(bU.release, { v: "1" });
  ok("A8 a dataUnavailable payload is NEVER promoted over the live LKG -> defer 'data-unavailable', ZERO writes", ru.ok === false && ru.reason === "data-unavailable" && SDR.statusFromRelease(ru) === RS.DD && wU.writes() === 0);
  const wN = makeWorld();
  const bN = build(wN, { evidence: evMap({ [ACC]: E1 }), runtimeOver: { derive: async () => ({ notReady: true, reason: "oli-coverage-short" }) } });
  const rn = await prep(bN.release, { v: "1" });
  ok("A8 a notReady derive -> typed deferral, ZERO writes", rn.ok === false && rn.reason === "derive-not-ready:oli-coverage-short" && wN.writes() === 0);
  const wX = makeWorld();
  const bX = build(wX, { evidence: evMap({ [ACC]: E1 }), runtimeOver: { resolveBundle: async () => ({ eligible: false, reason: "returns-evidence-missing" }) } });
  const rx = await prep(bX.release, { v: "1" });
  ok("A8 missing evidence -> typed deferral 'bundle-<reason>', ZERO writes (never a zero payload)", rx.ok === false && rx.reason === "bundle-returns-evidence-missing" && wX.writes() === 0);
}

{
  // A9. publish outcomes.
  // NEWER_LIVE: a strictly-newer live row with OTHER content holds the identity.
  const w = makeWorld();
  const { release } = build(w, { evidence: evMap({ [ACC]: E1 }) });
  const p = await prep(release, { v: "1" });
  w.snaps.set("returns-leakage|" + ACC + "|" + liveHashRl(), { id: "paid-1", report_key: "returns-leakage", account_id: ACC, params_hash: liveHashRl(), params: { reportVersion: "returns-leakage-v3", to: ASOF }, payload: returnsPayload(ACC, ASOF, 77), payload_storage_path: null, source_refreshed_at: "2099-01-01T00:00:00.000Z", updated_at: "2099-01-01T00:00:00.000Z" });
  const r = await pub(release, p);
  ok("A9 publish 'newer-live' (other content) -> NEWER_LIVE (retryable DEFERRED_DEPENDENCY), the newer live row untouched", r.ok === false && r.status === "NEWER_LIVE" && r.reason === "publish-newer-live" && SDR.statusFromRelease(r) === RS.DD && liveRowRl(w).id === "paid-1" && w.n.liveWrite === 0);

  // refused newer-live with IDENTICAL content + lineage + read-back -> already-current (never 'published').
  const wI = makeWorld();
  const bI = build(wI, { evidence: evMap({ [ACC]: E1 }) });
  const pI = await prep(bI.release, { v: "1" });
  await pub(bI.release, pI);
  const lk = "returns-leakage|" + ACC + "|" + liveHashRl();
  wI.snaps.get(lk).source_refreshed_at = "2099-01-01T00:00:00.000Z"; // the same promotion, re-stamped newer
  const pI2 = { ...pI, resumed: false, shadowOutcome: "inserted" }; // force the CAS path
  const rI = await pub(bI.release, pI2);
  ok("A9 a REFUSED live write whose content identity + lineage + served read-back ALL match -> already-current (alreadyCurrent:true), zero writes", rI.ok === true && rI.alreadyCurrent === true && rI.disposition === "refused-newer-live" && wI.n.liveWrite === 1);
  const wJ = makeWorld();
  const bJ = build(wJ, { evidence: evMap({ [ACC]: E1 }), runtimeOver: { servedSelector: async () => ({ row: null, reason: "version-hidden", via: "latest" }) } });
  const pJ = await prep(bJ.release, { v: "1" });
  await wJ.liveCas({ reportKey: "returns-leakage", accountId: ACC, paramsHash: liveHashRl(), params: { reportVersion: "returns-leakage-v3", to: ASOF, evidenceToken: "rl1:1", manifestToken: "mf1:a" }, payload: returnsPayload(ACC, ASOF, 1), sourceRefreshedAt: "2099-01-01T00:00:00.000Z", ownerToken: "op-owner", generation: 7 });
  const rJ = await pub(bJ.release, pJ);
  ok("A9 a refused write with matching content + lineage but a served read-back MISMATCH -> NEWER_LIVE (never already-current by stamp/content alone)", rJ.ok === false && rJ.status === "NEWER_LIVE");

  // lease-lost: a stale fence at the write boundary, and a failed verifyLease before the write.
  const wL = makeWorld();
  const bL = build(wL, { evidence: evMap({ [ACC]: E1 }) });
  const pL = await prep(bL.release, { v: "1" });
  wL.lease = { ownerToken: "someone-else", generation: 9 };
  const rL = await pub(bL.release, pL);
  ok("A9 a stale fence at the fenced CAS -> contention 'publish-lease-lost' (leaseLost, DEFERRED_DEPENDENCY), zero live rows", rL.ok === false && rL.leaseLost === true && rL.reason === "publish-lease-lost" && SDR.statusFromRelease(rL) === RS.DD && wL.n.liveWrite === 0);
  const wV = makeWorld();
  const bV = build(wV, { evidence: evMap({ [ACC]: E1 }) });
  const pV = await prep(bV.release, { v: "1" });
  wV.leaseOk = false;
  const rV = await pub(bV.release, pV);
  ok("A9 verifyLease fails before the write -> contention with ZERO publish calls", rV.ok === false && rV.leaseLost === true && /^lease-lost-before-publish:/.test(rV.reason) && wV.n.publish === 0);

  // served-row-differs (fixable) vs preempted (not fixable).
  const wF = makeWorld();
  const bF = build(wF, { evidence: evMap({ [ACC]: E1 }), runtimeOver: { servedSelector: async () => ({ row: null, reason: "missing", via: "scope-latest" }) } });
  const pF = await prep(bF.release, { v: "1" });
  const rF = await pub(bF.release, pF);
  ok("A9 the served selector returns nothing (fixable) after a landed publish -> FAILED_READBACK 'served-row-differs'", rF.ok === false && rF.reason === "served-row-differs" && SDR.statusFromRelease(rF) === RS.FR);
  const wP = makeWorld();
  const foreign = { id: "x", report_key: "returns-leakage", account_id: ACC, params_hash: "f".repeat(40), source_refreshed_at: "2099-01-01T00:00:00.000Z", updated_at: "2099-01-01T00:00:00.000Z" };
  const bP = build(wP, { evidence: evMap({ [ACC]: E1 }), runtimeOver: { servedSelector: async () => ({ row: foreign, reason: null, via: "exact" }) } });
  const pP = await prep(bP.release, { v: "1" });
  const rP = await pub(bP.release, pP);
  ok("A9 another identity holds the browser's exact served slot (not fixable) -> DEFERRED 'served-row-preempted:exact-identity-row'", rP.ok === false && rP.reason === "served-row-preempted:exact-identity-row" && SDR.statusFromRelease(rP) === RS.DD);
}

{
  // A10. stampPolicy 'evidence'.
  const w = makeWorld();
  const b = build(w, { evidence: evMap({ [ACC]: E1 }), stamp: "evidence" });
  const p = await prep(b.release, { v: "1" });
  const r = await pub(b.release, p);
  ok("A10 'evidence' stamp: the shadow + live carry the EVIDENCE instant (never the wall clock / cycle time)", p.sourceRefreshedAt === E1.instant && r.disposition === "published" && liveRowRl(w).source_refreshed_at === E1.instant);
  const cas = w.n.liveCas; const writes = w.writes();
  const p2 = await prep(b.release, { v: "1" });
  const r2 = await pub(b.release, p2);
  ok("A10 identical evidence -> already-current with ZERO CAS and zero writes", r2.ok === true && r2.alreadyCurrent === true && w.n.liveCas === cas && w.writes() === writes);
  const wN = makeWorld();
  const bN = build(wN, { evidence: evMap({ [ACC]: E1 }), stamp: "evidence" });
  wN.snaps.set("returns-leakage|" + ACC + "|" + liveHashRl(), { id: "paid-9", report_key: "returns-leakage", account_id: ACC, params_hash: liveHashRl(), params: { reportVersion: "returns-leakage-v3", to: ASOF }, payload: returnsPayload(ACC, ASOF, 5), payload_storage_path: null, source_refreshed_at: "2026-09-24T05:10:00.000Z", updated_at: "2026-09-24T05:10:00.000Z" });
  const pN = await prep(bN.release, { v: "1" });
  ok("A10 evidence <= the live/served stamp (a fresher paid row) -> NEWER_LIVE deferral with ZERO writes (fresher data never overwritten)", pN.ok === false && pN.status === "NEWER_LIVE" && pN.reason === "evidence-not-newer-than-live" && SDR.statusFromRelease(pN) === RS.DD && wN.writes() === 0);
  const wF = makeWorld();
  const bF = build(wF, { evidence: evMap({ [ACC]: { ...E1, instant: "2099-01-01T00:00:00.000Z" } }), stamp: "evidence" });
  const pF = await prep(bF.release, { v: "1" });
  ok("A10 an evidence instant in the future is a hard integrity failure (never stamped ahead of now), ZERO writes", pF.ok === false && pF.reason === "evidence-instant-future" && wF.writes() === 0);
}

{
  // A11. two concurrent prepares of DIFFERENT revisions: distinct shadows; the binding never pairs a job with another
  // revision's content; the publisher only ever promotes the LATEST job's own shadow.
  // Two releases over the SAME world, each seeing its OWN evidence (two processes preparing concurrently, no lease).
  // DETERMINISTIC interleaving: B inserts its job, then PAUSES at its shadow CAS until A's whole prepare has run (A
  // sees B's in-flight job as the latest -> nonces over it; B's own lineage re-reads all happened before A wrote).
  const w = makeWorld();
  let releaseB; const gateB = new Promise((r) => { releaseB = r; });
  const bA = build(w, { evidence: () => E1 });
  const bB = build(w, { evidence: () => E2, depsOver: { saveShadow: async (a) => { await gateB; return w.saveShadow(a); } } });
  const pbP = prep(bB.release, { v: "2" });
  while (w.jobs.length === 0) await new Promise((r) => setImmediate(r));
  const pa = await prep(bA.release, { v: "1" });
  releaseB();
  const pb = await pbP;
  const shA = w.snaps.get("scheduler-v2/" + RL + "|" + ACC + "|" + pa.shadowParamsHash);
  const shB = w.snaps.get("scheduler-v2/" + RL + "|" + ACC + "|" + pb.shadowParamsHash);
  ok("A11 two CONCURRENT prepares of different revisions write DISTINCT shadows (content-addressed by rev) in distinct cycles", pa.ok === true && pb.ok === true && pa.shadowParamsHash !== pb.shadowParamsHash && shA.params.rev === "rev-1" && shB.params.rev === "rev-2" && w.cycles.size === 2 && w.jobs.length === 2);
  for (const j of w.jobs) {
    const sh = w.snaps.get("scheduler-v2/" + RL + "|" + ACC + "|" + j.snapshot_params_hash);
    ok("A11 job " + j.id + " is paired ONLY with its own revision's shadow (its content deps carry exactly that shadow's evidence + manifest tokens)", !!sh && j.durable_content_deps.includes(sh.params.evidenceToken) && j.durable_content_deps.includes(sh.params.manifestToken) && sh.params.rev === (sh.params.evidenceToken === "rl1:1" ? "rev-1" : "rev-2"));
  }
  const latest = w.lineage(RL, ACC);
  const latestIsB = S(latest.snapshotParamsHash) === pb.shadowParamsHash;
  const [loser, loserPrep, loserRev, winner, winnerPrep, winnerTok] = latestIsB ? [bA, pa, "1", bB, pb, "rl1:2"] : [bB, pb, "2", bA, pa, "rl1:1"];
  const latestShadow = latestIsB ? shB : shA;
  const binding = B.evaluatePublicationBinding({ revision: rlRevision(loserRev), accountId: ACC, reportKey: RL, requestedAsOf: ASOF, expectedShadowKey: "scheduler-v2/" + RL, job: latest, shadow: latestShadow, hydratedShadowPayload: latestShadow.payload, live: null, hydratedLivePayload: null, liveReadback: null, contract: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS[RL], computeHash: paramsHashFor, reportDerivations: REPORT_DERIVATIONS, liveAccountId: ACC });
  ok("A11 the binding for the OTHER revision never accepts the latest job/content -> STALE", binding.state === "STALE");
  const casBefore = w.n.liveCas;
  const rl = await pub(loser.release, loserPrep);
  ok("A11 publishing the revision whose job is NOT the latest -> defer 'lineage-advanced' with ZERO CAS (the publisher would promote the other shadow)", rl.ok === false && rl.reason === "lineage-advanced" && w.n.liveCas === casBefore && SDR.statusFromRelease(rl) === RS.DD);
  const rw = await pub(winner.release, winnerPrep);
  ok("A11 the latest job's revision publishes its OWN shadow", rw.disposition === "published" && liveRowRl(w).params.evidenceToken === winnerTok);
}

{
  // A12. identity hooks: SKU Movement (target 'sku-movement:<owner>::<brand>' != the live OWNER account).
  const w = makeWorld({ key: SKU, promoted: [SKU] });
  const target = skuMovementTargetId(ACC, "ALL");
  const unit = { unitKey: "ALL", targetId: target, liveAccountId: ACC, ownerAccountIds: [ACC], targetAsOf: ASOF, reportKeys: [SKU] };
  const ev = { v: "1", m: "a", asOf: ASOF };
  const runtime = {
    readScopeEvidence: async ({ scope }) => ({ ok: true, perAccount: new Map(scope.map((a) => [a, ev])) }),
    computeRevision: () => ({ eligible: true, revisionId: "rev-1", evidenceToken: "sm1:1", deps: ["dep:sku"] }),
    resolveBundle: async () => ({ eligible: true, revisionId: "rev-1", evidenceToken: "sm1:1", manifestToken: "mf1:a", serveToken: "sms1:x", deps: ["dep:sku"], bundle: { ev } }),
    derive: async () => ({ payload: skuPayload(ACC, ASOF, "ALL"), latestDataDate: ASOF }),
    identityParams: () => ({ ownerAccountId: ACC, asOf: ASOF, brand: "ALL" }),
    servedSelector: async (u) => SEL.selectLatestForScope({ reportKey: SKU, accountId: u.liveAccountId, reportVersion: "sku-movement/v2", scope: { brand: "ALL" }, readers: w.readers }),
  };
  const release = REL.buildRoutePublicationRelease({ route: { id: "sku-movement", publisherKey: SKU, stampPolicy: "cycle" }, runtime, deps: releaseDeps(w) });
  const revision = REL.normalizeRouteRevision({ eligible: true, revisionId: "rev-1", evidenceToken: "sm1:1", deps: ["dep:sku"] });
  const p = await release.prepareForUnit({ unit, revision, epoch: EPOCH, region: REGION });
  const r = await release.publishForUnit({ unit, prepared: p, epoch: EPOCH, region: REGION, accountId: ACC });
  const liveHash = paramsHashFor("sku-movement/v2", { asOf: ASOF, brand: "ALL" });
  const live = w.snaps.get(SKU + "|" + ACC + "|" + liveHash);
  ok("A12 sku-movement: the job + shadow are keyed by the TARGET, the live row by the OWNER, with the serve token stored", p.ok === true && w.jobs[0].account_id === target && r.disposition === "published" && !!live && live.params.serveToken === "sms1:x" && live.params.evidenceToken === "sm1:1");
  const w2 = makeWorld({ key: SKU, promoted: [SKU] });
  const release2 = REL.buildRoutePublicationRelease({ route: { id: "sku-movement", publisherKey: SKU, stampPolicy: "cycle" }, runtime, deps: releaseDeps(w2) });
  const bad = await release2.prepareForUnit({ unit: { ...unit, liveAccountId: ACC2 }, revision, epoch: EPOCH, region: REGION });
  ok("A12 a unit whose liveAccountId disagrees with the contract-derived live account -> hard 'live-account-mismatch', ZERO writes", bad.ok === false && bad.reason === "live-account-mismatch" && w2.writes() === 0);
  const bad2 = await release2.prepareForUnit({ unit: { ...unit, targetId: skuMovementTargetId(ACC2, "ALL") }, revision, epoch: EPOCH, region: REGION });
  ok("A12 a target that is not the canonical target of the shadow's (owner, brand) -> hard 'target-identity-mismatch', ZERO writes", bad2.ok === false && bad2.reason === "target-identity-mismatch" && w2.writes() === 0);
  let threw = null;
  try { REL.buildRoutePublicationRelease({ route: { id: "sku-movement", publisherKey: SKU, stampPolicy: "cycle" }, runtime: { ...runtime, servedSelecter: runtime.servedSelector }, deps: releaseDeps(w2) }); } catch (e) { threw = e; }
  ok("A12 a runtime with an unknown hook (a typo) is REFUSED at build (fail closed)", !!threw && /unknown-hook:servedSelecter/.test(threw.message));
}

{
  // A13. abort before any write + the prune follow-up.
  const w = makeWorld();
  const b = build(w, { evidence: evMap({ [ACC]: E1 }) });
  const ac = new AbortController(); ac.abort();
  const r = await prep(b.release, { v: "1", signal: ac.signal });
  ok("A13 an aborted signal -> DEADLINE deferral before any read or write", r.ok === false && r.reason === "deadline-aborted" && w.writes() === 0);
  const wp = makeWorld();
  const pruned = [];
  const bp = build(wp, { evidence: evMap({ [ACC]: E1 }), depsOver: { prune: true, pruneShadows: async (a) => { pruned.push(a); return { deleted: 2, payloadStoragePaths: [] }; } } });
  const pp = await prep(bp.release, { v: "1" });
  await pub(bp.release, pp);
  ok("A13 --prune-shadows: after a verified publish, ONE guarded prune keeping the latest job's + this hash, cutoff >= 24 h back", pruned.length === 1 && pruned[0].routeId === "returns-v3" && pruned[0].publisherKey === RL && pruned[0].targetId === ACC && JSON.stringify(pruned[0].keepParamsHashes) === JSON.stringify([pp.shadowParamsHash]) && Date.parse(pruned[0].olderThanIso) <= wp.now() - SB.ROUTE_SHADOW_PRUNE_MIN_AGE_MS);
  let threw = null;
  try { build(makeWorld(), { evidence: evMap({}), depsOver: { prune: true, pruneShadows: null } }); } catch (e) { threw = e; }
  ok("A13 prune without a pruneShadows collaborator is refused at build", !!threw);
}

// =====================================================================================================================
// B. adapter + CLI helpers
// =====================================================================================================================
{
  const nr = REL.normalizeRouteRevision;
  ok("B1 normalizeRouteRevision: eligible needs revisionId + a printable evidenceToken + canonical deps; contentDeps default [evidenceToken]", JSON.stringify(nr({ eligible: true, revisionId: "r", evidenceToken: "t:1", deps: ["b", "a", "a"] })) === JSON.stringify({ eligible: true, revisionId: "r", evidenceToken: "t:1", deps: ["a", "b"], contentDeps: ["t:1"], status: "available", reason: null })
    && nr({ eligible: true, revisionId: "r", evidenceToken: "has space", deps: [] }).eligible === false && nr({ eligible: true, revisionId: "", evidenceToken: "t", deps: [] }).eligible === false && nr(null).reason === "revision-missing" && nr({ eligible: false, reason: "returns-evidence-missing: detail" }).reason === "returns-evidence-missing:");
  const w = makeWorld();
  const { runtime, route } = makeRlRuntime(w, { evidence: evMap({ [ACC]: E1 }) });
  const adapter = REL.buildRouteReconcileAdapter({ route, runtime, bucket: REGION, liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, readLatestJob: w.readLatestJob, verifyExact: true });
  const rev = adapter.computeAccountRevision({ accountId: ACC, requestedAsOf: EPOCH, evidence: E1 });
  ok("B2 the adapter's computeAccountRevision returns the evidenceToken (the TARGETS v2 'tok' echo)", rev.eligible === true && rev.evidenceToken === "rl1:1" && JSON.stringify(rev.contentDeps) === JSON.stringify(["rl1:1"]));
  const scMissing = await adapter.servedCheck({ unit: rlUnit(), rk: RL, accountId: ACC, h: liveHashRl(), sra: "2026-09-24T06:00:00.000Z", epoch: EPOCH });
  ok("B3 servedCheck: nothing served -> fixable (the core then re-publishes: 'served-row-differs')", scMissing.ok === false && scMissing.fixable === true && scMissing.reason === "missing");
  const b = build(w, { evidence: evMap({ [ACC]: E1 }) });
  const p = await prep(b.release, { v: "1" }); await pub(b.release, p);
  const live = liveRowRl(w);
  const scOk = await adapter.servedCheck({ unit: rlUnit(), rk: RL, accountId: ACC, h: live.params_hash, sra: live.source_refreshed_at, epoch: EPOCH });
  ok("B3 servedCheck: the served row IS the bound canonical row + verify-exact finds the manifest in the latest job's content deps -> ok", scOk.ok === true && scOk.served.id === live.id);
  const adapterM = REL.buildRouteReconcileAdapter({ route, runtime: { ...runtime, resolveBundle: async () => ({ eligible: true, revisionId: "rev-1", evidenceToken: "rl1:1", manifestToken: "mf1:OTHER", deps: [] }) }, bucket: REGION, liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, readLatestJob: w.readLatestJob, verifyExact: true });
  adapterM.computeAccountRevision({ accountId: ACC, requestedAsOf: EPOCH, evidence: E1 });
  const scM = await adapterM.servedCheck({ unit: rlUnit(), rk: RL, accountId: ACC, h: live.params_hash, sra: live.source_refreshed_at, epoch: EPOCH });
  ok("B3 verify-exact: a re-resolved manifest NOT in the latest job's content deps -> fixable 'manifest-differs'", scM.ok === false && scM.fixable === true && scM.reason === "manifest-differs");
  const scPre = await REL.buildRouteReconcileAdapter({ route, runtime: { ...runtime, servedSelector: async () => ({ row: { ...SEL.servedRowIdentity(live), params_hash: "e".repeat(40) }, reason: null, via: "exact" }) }, bucket: REGION, liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS }).servedCheck({ unit: rlUnit(), rk: RL, accountId: ACC, h: live.params_hash, sra: live.source_refreshed_at, epoch: EPOCH });
  ok("B3 servedCheck: another identity at the browser's exact slot -> NOT fixable (preempted)", scPre.ok === false && scPre.fixable === false && scPre.reason === "exact-identity-row");
  let threw = null;
  try { REL.buildRouteReconcileAdapter({ route, runtime, bucket: REGION, liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, verifyExact: true }); } catch (e) { threw = e; }
  ok("B3 verify-exact without a job reader is refused at build (fail closed)", !!threw);
  // An EMPTY unit expansion is never "verified": the record + the TARGETS v2 line carry r:'units-empty'.
  const b2 = build(w, { evidence: evMap({ [ACC]: E1 }) });
  const emptyAdapter = { ...REL.buildRouteReconcileAdapter({ route, runtime, bucket: REGION, liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS }), expandUnits: async () => [] };
  const rec = SDR.buildSavedDataReconciler({
    resolveOrg: async () => ({ organizationFingerprint: "org", connectionId: "primary" }), bucketAccounts: async () => [{ accountId: ACC }], adapter: emptyAdapter,
    readLatestReportJob: ({ reportKey, accountId }) => w.readLatestJob(reportKey, accountId), readShadowSnapshot: (a) => w.readSnapshot(a), readLiveSnapshot: (a) => w.readSnapshot(a), loadStoragePayload: w.loadStoragePayload, verifyLiveReadback: w.readbackLive,
    liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, computeHash: paramsHashFor, reportDerivations: REPORT_DERIVATIONS,
    runPrepareForUnit: (a) => b2.release.prepareForUnit(a), runPublishForUnit: (a) => b2.release.publishForUnit(a), reportKeys: [RL],
  });
  const se = await rec.run({ bucket: REGION, requestedAsOf: EPOCH, dryRun: true });
  const te = TGT.parseTargetsLine(TGT.formatTargetsLine({ v: 2, route: "returns-v3", summary: se }));
  ok("B4 an EMPTY unit list is never verified: TARGETS v2 marks the target r:'units-empty' with zero unit rows", te.targets[0].r === "units-empty" && te.targets[0].units.length === 0 && se.perAccount[0].unitsReason === "units-empty");
}

{
  const P = REL.parseRouteCliArgs;
  const good = P(["--route=returns-v3", "--bucket=india", "--as-of=2026-09-24", "--targets=IN1,IN2", "--live", "--run-token=prw-abc-12345678", "--emit-targets", "--prune-shadows"]);
  ok("B5 parseRouteCliArgs: a well-formed live worker invocation parses", good.ok === true && good.args.live === true && good.args.dryRun === false && JSON.stringify(good.args.targets) === JSON.stringify(["IN1", "IN2"]) && good.args.pruneShadows === true && good.args.mode === "periodic" && good.args.leaseWaitSeconds === 0);
  const bad = (argv, c) => { const r = P(argv); return r.ok === false && r.code === c; };
  const base = ["--route=returns-v3", "--bucket=india", "--as-of=2026-09-24"];
  const TOK = "--run-token=prw-abc-12345678";
  ok("B5 parseRouteCliArgs refuses: --live without --targets (periodic), --lease-wait outside scheduler, --prune-shadows without --live, --cleanup without a token, a bad route id, >25 targets, a bad target, an over-long token, an unknown flag, a duplicate flag, an impossible date",
    bad([...base, "--live", TOK], "ROUTE_CLI_LIVE_TARGETS") && P([...base, "--live", "--mode=scheduler", TOK]).ok === true
    && bad([...base, "--lease-wait-seconds=600"], "ROUTE_CLI_LEASE_WAIT") && P([...base, "--mode=scheduler", "--lease-wait-seconds=600", TOK]).args.leaseWaitSeconds === 600 && bad([...base, "--mode=scheduler", "--lease-wait-seconds=901", TOK], "ROUTE_CLI_LEASE_WAIT")
    && bad([...base, "--prune-shadows"], "ROUTE_CLI_PRUNE") && bad([...base, "--cleanup"], "ROUTE_CLI_CLEANUP")
    && bad(["--route=Returns_V3", "--bucket=india", "--as-of=2026-09-24"], "ROUTE_CLI_ROUTE") && bad(["--route=a,a", "--bucket=india", "--as-of=2026-09-24"], "ROUTE_CLI_ROUTE")
    && bad([...base, "--targets=" + Array.from({ length: 26 }, (_, i) => "A" + i).join(",")], "ROUTE_CLI_TARGETS") && bad([...base, "--targets=A B"], "ROUTE_CLI_TARGETS")
    && bad([...base, "--run-token=" + "x".repeat(151)], "ROUTE_CLI_RUN_TOKEN") && bad([...base, "--accounts=IN1"], "ROUTE_CLI_ARG") && bad([...base, "--bucket=us-ca"], "ROUTE_CLI_ARG")
    && bad(["--route=returns-v3", "--bucket=india", "--as-of=2026-02-30"], "ROUTE_CLI_AS_OF") && bad(["--route=returns-v3", "--bucket=eu", "--as-of=2026-09-24"], "ROUTE_CLI_BUCKET"));
  // P3-4: a LIVE run and ANY scheduler-mode run need a UNIQUE run token (the lease-owner identity), checked first.
  ok("B5b --live (with or without --targets / --mode=scheduler) and --mode=scheduler (even read-only / with --lease-wait-seconds) WITHOUT --run-token -> STOP ROUTE_CLI_LIVE_RUN_TOKEN; a read-only periodic run needs none",
    bad([...base, "--live", "--targets=IN1"], "ROUTE_CLI_LIVE_RUN_TOKEN") && bad([...base, "--live", "--mode=scheduler"], "ROUTE_CLI_LIVE_RUN_TOKEN") && bad([...base, "--live"], "ROUTE_CLI_LIVE_RUN_TOKEN")
    && bad([...base, "--mode=scheduler"], "ROUTE_CLI_LIVE_RUN_TOKEN") && bad([...base, "--mode=scheduler", "--lease-wait-seconds=600"], "ROUTE_CLI_LIVE_RUN_TOKEN") && bad([...base, "--live", "--targets=IN1", "--run-token="], "ROUTE_CLI_LIVE_RUN_TOKEN")
    && P(base).ok === true && P(base).args.dryRun === true && P([...base, "--verify-exact"]).ok === true && P([...base, "--cleanup", TOK]).ok === true
    && P([...base, "--live", "--targets=IN1", TOK]).args.runToken === "prw-abc-12345678");
  // P2-5: --live --verify-exact is a LIVE exact pass (no longer refused).
  const lx = P([...base, "--live", "--targets=IN1", "--verify-exact", TOK]);
  ok("B5b --live --verify-exact parses as a LIVE EXACT pass (live, verifyExact, not dry-run); --verify-exact alone stays read-only", lx.ok === true && lx.args.live === true && lx.args.verifyExact === true && lx.args.dryRun === false && P([...base, "--verify-exact"]).args.dryRun === true);
  const opMax = REL.routeCliOperator({ bucket: "europe-au", runToken: "x".repeat(150), asOf: "2026-09-24" });
  ok("B6 the audited control operator stays canonical (<= 200 chars, no whitespace) for the longest accepted run token, and equals across run + --cleanup", opMax.length <= 200 && !/\s/.test(opMax) && opMax === REL.routeCliOperator({ bucket: "europe-au", runToken: "x".repeat(150), asOf: "2099-01-01" }) && REL.routeCliOperator({ bucket: "india", runToken: "", asOf: EPOCH }) === "publication-route-reconcile:india:" + EPOCH);
  const dir = REL.buildDurableDirectory({ rows: [{ accountId: "IN1", country: "IN" }, { accountId: "GB1", country: "UK" }, { accountId: "dd-secondary:X", country: "IN" }, { accountId: "DUP", country: "IN" }, { accountId: "DUP", country: "IN" }, { accountId: "NOC", country: "" }, { accountId: "NORAW", country: "IN" }], resolveRawSellerId: (id) => (id === "NORAW" ? "" : "raw-" + id), normalizeMarketplace: (c) => (c === "UK" ? "GB" : c) });
  ok("B7 the DURABLE directory: prefixed / duplicate / marketplace-less / raw-seller-unresolved rows are EXCLUDED (typed), UK->GB normalized, zero DataDoe", [...dir.directory.keys()].join(",") === "IN1,GB1" && dir.directory.get("GB1").marketplace === "GB" && dir.directory.get("IN1").rawSellerId === "raw-IN1" && JSON.stringify(dir.excluded.map((x) => x.reason).sort()) === JSON.stringify(["duplicate-directory-row", "duplicate-directory-row", "no-marketplace", "not-primary", "raw-seller-unresolved"]));
  ok("B7 regionAccountIds: the directory accounts in the region (accountInScope over the directory country), sorted", JSON.stringify(REL.regionAccountIds(dir.directory, "india", accountInScope)) === JSON.stringify(["IN1"]) && JSON.stringify(REL.regionAccountIds(dir.directory, "europe-au", accountInScope)) === JSON.stringify(["GB1"]));
  const ro = REL.readOnlySupabase(SB);
  const names = Object.keys(ro);
  ok("B8 readOnlySupabase exposes READERS only (get*/list* + pure helpers): no save / publish / upsert / insert / delete / claim / record / reconcile / finalize / open / renew / replace / set", names.length > 20 && names.includes("getReportSnapshot") && names.includes("getLatestReportSnapshotForScope") && names.every((nm) => /^(get|list)[A-Z]/.test(nm) || REL.ROUTE_PURE_SUPABASE_HELPERS.includes(nm))
    && !names.some((nm) => /^(save|publish|upsert|insert|delete|claim|record|reconcile|finalize|open|renew|replace|set|reserve|update|prune|acquire|release|cas|adopt|assign|complete|lease|mark|persist|ack|invite|resume|reclaim)/.test(nm)) && Object.isFrozen(ro));
}

// =====================================================================================================================
// C. the ROUTE control package + the bounded lease-wait
// =====================================================================================================================
const CONTROLLED = ["brand-sales", "daily-reporting", "reconciliation", "fba-plan", "sku-pl", "keyword-rank", "content-changes", "sales-movers", "listing-health", "buy-box-loss", "returns-leakage", "ppc-performance", "listing-optimizer"];
const PROMOTED_ROWS = ["brand-inventory", "listing-health-v3", "sku-movement", "returns-leakage-v3", "brand-view-brands", "brand-view", "brand-view-portfolio", "fba-plan"];
// A faithful, RECORDING in-memory control store (the priority-control-pg-store contract) with the COMPLETE lease iface.
function makeTraceStore({ leaseHeld = false, commitThrows = false, strayDispatch = null, release = "released", commitThrowsAfter = null } = {}) {
  const trace = [];
  let commits = 0;
  const rec = (m, ...args) => trace.push([m, ...args.map((a) => (Array.isArray(a) ? [...a] : a))]);
  const st = {
    rollout: new Map([["OLD1", true], ["OLD2", false]]),
    dispatch: new Map(CONTROLLED.map((k) => [k, false])),
    promoted: new Map(PROMOTED_ROWS.map((k) => [k, false])),
    approvals: new Map([["daily-reporting|OLD1", true]]),
  };
  if (strayDispatch) st.dispatch.set(strayDispatch, true);
  return {
    trace, st,
    begin: async () => rec("begin"),
    commit: async () => { rec("commit"); commits += 1; if (commitThrows || (commitThrowsAfter != null && commits > commitThrowsAfter)) throw new Error("ack lost"); },
    rollback: async () => rec("rollback"),
    end: async () => rec("end"),
    readAllPrimary: async () => { rec("readAllPrimary"); return false; },
    hasCron: async () => { rec("hasCron"); return false; },
    setRolloutEnabled: async (ids) => { rec("setRolloutEnabled", ids); for (const k of st.rollout.keys()) st.rollout.set(k, false); for (const id of ids) st.rollout.set(String(id), true); },
    disableAllRollout: async () => { rec("disableAllRollout"); for (const k of st.rollout.keys()) st.rollout.set(k, false); },
    setDispatchEnabled: async (enabled, controlled) => { rec("setDispatchEnabled", enabled, controlled); for (const k of controlled) st.dispatch.set(k, enabled.includes(k)); },
    pauseAllDispatch: async (controlled) => { rec("pauseAllDispatch", controlled); for (const k of controlled) st.dispatch.set(k, false); },
    setPromotedEnabled: async (keys) => { rec("setPromotedEnabled", keys); for (const k of st.promoted.keys()) st.promoted.set(k, false); for (const k of keys) st.promoted.set(String(k), true); },
    disableAllPromoted: async () => { rec("disableAllPromoted"); for (const k of st.promoted.keys()) st.promoted.set(k, false); },
    setApprovalsApproved: async (pairs, op) => { rec("setApprovalsApproved", pairs, op); for (const k of st.approvals.keys()) st.approvals.set(k, false); for (const p of pairs) st.approvals.set(String(p), true); },
    revokeAllApprovals: async (op) => { rec("revokeAllApprovals", op); for (const k of st.approvals.keys()) st.approvals.set(k, false); },
    rolloutRows: async () => { rec("rolloutRows"); return [...st.rollout].map(([account_id, enabled]) => ({ account_id, enabled })); },
    dispatchRows: async () => { rec("dispatchRows"); return [...st.dispatch].map(([report_key, schedule_enabled]) => ({ report_key, schedule_enabled })); },
    promotedRows: async () => { rec("promotedRows"); return [...st.promoted].map(([report_key, publish_enabled]) => ({ report_key, publish_enabled })); },
    approvalRows: async () => { rec("approvalRows"); return [...st.approvals].map(([k, approved]) => ({ report_key: k.split("|")[0], account_id: k.split("|")[1], approved })); },
    acquireControlLease: async (owner, op, ttl) => { rec("acquireControlLease", owner, op, ttl); return leaseHeld ? { disposition: "held", owner_token: "someone-else-token" } : { disposition: "acquired", generation: 41 }; },
    renewControlLease: async (owner, gen, ttl) => { rec("renewControlLease", owner, gen, ttl); return { disposition: "renewed" }; },
    releaseControlLease: async (owner, gen) => { rec("releaseControlLease", owner, gen); return { disposition: release }; },
    assertControlLeaseOwner: async (owner, gen) => { rec("assertControlLeaseOwner", owner, gen); return true; },
    lockAndVerifyControlLease: async (owner, gen) => { rec("lockAndVerifyControlLease", owner, gen); return true; },
  };
}
const stripPkg = (r) => JSON.parse(JSON.stringify(r, (k, v) => (k === "pkg" ? undefined : v)));
// The string-promotedEnabled (pre-WP4) call surface: every pre-existing package builder x apply through BOTH the
// transaction and the CLI orchestrator (DEFAULT leaseWaitSeconds), the lease-held / commit-unknown / POST-failure
// outcomes, rollback / reclaim / a failed release and dry-run. The digest was computed against the PRE-WP4 module (git
// HEAD 6a59a1f) and must never change.
async function controlTraceDigest(M) {
  const outRows = [];
  const run = async (label, fn, storeOpts = {}) => {
    const store = makeTraceStore(storeOpts);
    let result;
    try { result = await fn(store); } catch (e) { result = { threw: String(e && e.message) }; }
    outRows.push({ label, trace: store.trace, result: stripPkg(result) });
  };
  const accts = ["IN2", "IN1"];
  const op = "golden-operator@example.com";
  for (const [name, bld] of [["priority", M.buildPriorityControlPackage], ["fba-plan", M.buildFbaPlanControlPackage], ["lhv3", M.buildListingHealthV3ControlPackage]]) {
    const pkg = () => bld({ accounts: accts, operator: op, controlledReportKeys: CONTROLLED });
    await run("txn-apply-" + name, (store) => M.runControlPackageTransaction({ store, pkg: pkg(), mode: "apply", controlledReportKeys: CONTROLLED, ownerToken: "owner-1", operationKey: "op/" + name, leaseTtlSeconds: 900 }));
    await run("cli-apply-" + name, (store) => M.runControlPackageCli({ mode: "apply", operator: op, discoverAccounts: async () => accts, connectStore: async () => store, controlledReportKeys: CONTROLLED, buildApplyPackage: bld, ownerToken: "owner-1", operationKey: "op/" + name, leaseTtlSeconds: 900 }));
    await run("cli-apply-held-" + name, (store) => M.runControlPackageCli({ mode: "apply", operator: op, discoverAccounts: async () => accts, connectStore: async () => store, controlledReportKeys: CONTROLLED, buildApplyPackage: bld, ownerToken: "owner-1", operationKey: "op/" + name }), { leaseHeld: true });
    await run("txn-apply-commit-unknown-" + name, (store) => M.runControlPackageTransaction({ store, pkg: pkg(), mode: "apply", controlledReportKeys: CONTROLLED, ownerToken: "owner-1", operationKey: "op" }), { commitThrows: true });
    await run("txn-apply-stray-dispatch-" + name, (store) => M.runControlPackageTransaction({ store, pkg: pkg(), mode: "apply", controlledReportKeys: CONTROLLED, ownerToken: "owner-1", operationKey: "op" }), { strayDispatch: "not-controlled-key" });
  }
  await run("cli-rollback", (store) => M.runControlPackageCli({ mode: "rollback", operator: op, connectStore: async () => store, controlledReportKeys: CONTROLLED, ownerToken: "owner-1", ownerGeneration: 41, operationKey: "op" }));
  await run("cli-reclaim", (store) => M.runControlPackageCli({ mode: "reclaim", operator: op, connectStore: async () => store, controlledReportKeys: CONTROLLED, ownerToken: "owner-1", operationKey: "op" }));
  await run("cli-rollback-release-failed", (store) => M.runControlPackageCli({ mode: "rollback", operator: op, connectStore: async () => store, controlledReportKeys: CONTROLLED, ownerToken: "owner-1", ownerGeneration: 41, operationKey: "op" }), { release: "generation-superseded" });
  await run("cli-dry-run", (store) => M.runControlPackageCli({ mode: "dry-run", operator: op, discoverAccounts: async () => accts, connectStore: async () => store, controlledReportKeys: CONTROLLED }));
  return createHash("sha256").update(JSON.stringify(outRows)).digest("hex");
}
const PRE_WP4_CONTROL_TRACE_DIGEST = "f4904358e6011fb60a9987daee5f88d0fed8f1c426f371b4d2a6c8d660463155";

{
  ok("C0 the pinned CONTROLLED list equals report-controls.js (the golden's premise)", JSON.stringify(CONTROLLED) === JSON.stringify(CONTROLLED_REPORT_KEYS));
  ok("C1 string promotedEnabled + default leaseWaitSeconds: EVERY pre-existing package's call sequence + result is BYTE-IDENTICAL to the pre-WP4 module (golden digest)", (await controlTraceDigest(CP)) === PRE_WP4_CONTROL_TRACE_DIGEST);
  const keys = ["returns-leakage-v3", "fba-plan", "sku-movement"];
  const pkg = CP.buildRouteControlPackage({ accounts: ["IN2", "IN1", "IN1"], operator: "op@x", publisherKeys: keys, controlledReportKeys: CONTROLLED });
  ok("C2 route package: rollout = the owners; EVERY controlled dispatch paused; dispatchEnabled []; promoted = the gate keys as a SORTED ARRAY (fba-plan -> 'fba-plan'); approvals = publisherKey x owner; allDispatchPaused POST flag",
    JSON.stringify(pkg.post.rolloutEnabled) === JSON.stringify(["IN1", "IN2"]) && pkg.apply.reportSyncSettings.every((r) => r.schedule_enabled === false) && pkg.apply.reportSyncSettings.length === CONTROLLED.length
    && JSON.stringify(pkg.post.dispatchEnabled) === "[]" && JSON.stringify(pkg.post.dispatchPaused) === JSON.stringify([...CONTROLLED].sort()) && JSON.stringify(pkg.post.promotedEnabled) === JSON.stringify(["fba-plan", "returns-leakage-v3", "sku-movement"])
    && pkg.post.approvals.length === 6 && pkg.post.approvals.includes("fba-plan|IN1") && pkg.post.allDispatchPaused === true && pkg.post.noCron === true);
  const contractGates = Object.fromEntries(Object.entries(SCHEDULER_LIVE_SNAPSHOT_CONTRACTS).filter(([, c]) => typeof c.promotedGateKey === "string").map(([k, c]) => [k, c.promotedGateKey]));
  ok("C2 ROUTE_PROMOTED_GATE_KEYS is pinned EQUAL to every live contract's promotedGateKey; every other route key gates on its own SOURCE_PROMOTED control", JSON.stringify(CP.ROUTE_PROMOTED_GATE_KEYS) === JSON.stringify(contractGates) && ["sku-movement", "returns-leakage-v3", "brand-view-brands", "brand-view", "brand-view-portfolio", "brand-inventory", "listing-health-v3"].every((k) => CP.routePromotedGateKey(k) === k && SOURCE_PROMOTED_REPORT_KEYS.includes(k)));
  const thrown = (fn) => { try { fn(); return false; } catch { return true; } };
  ok("C2 route package fails closed: a DISPATCH key without a promoted gate (a route never opens a dispatch control), a prefixed owner, no owners, a blank operator, no publisher keys",
    thrown(() => CP.buildRouteControlPackage({ accounts: ["IN1"], operator: "op", publisherKeys: ["daily-reporting"] })) && thrown(() => CP.buildRouteControlPackage({ accounts: ["dd-secondary:X"], operator: "op", publisherKeys: [RL] }))
    && thrown(() => CP.buildRouteControlPackage({ accounts: [], operator: "op", publisherKeys: [RL] })) && thrown(() => CP.buildRouteControlPackage({ accounts: ["IN1"], operator: "", publisherKeys: [RL] })) && thrown(() => CP.buildRouteControlPackage({ accounts: ["IN1"], operator: "op", publisherKeys: [] })));
  const st = makeTraceStore();
  const applied = await CP.runControlPackageTransaction({ store: st, pkg, mode: "apply", controlledReportKeys: CONTROLLED, ownerToken: "owner-1", operationKey: "op" });
  ok("C3 applying the route package commits EXACTLY: the owners' rollout, zero dispatch, the ARRAY of promoted gates (setPromotedEnabled got the array), the approvals", applied.committed === true && JSON.stringify(st.trace.find((t) => t[0] === "setPromotedEnabled")[1]) === JSON.stringify(["fba-plan", "returns-leakage-v3", "sku-movement"])
    && [...st.st.dispatch.values()].every((v) => v === false) && st.st.promoted.get("fba-plan") === true && st.st.promoted.get("brand-inventory") === false);
  const stray = makeTraceStore({ strayDispatch: "some-other-dispatch" });
  const refused = await CP.runControlPackageTransaction({ store: stray, pkg, mode: "apply", controlledReportKeys: CONTROLLED, ownerToken: "owner-1", operationKey: "op" });
  ok("C3 the POST assertion FAILS the whole apply (rolled back, not committed) if ANY dispatch row is enabled anywhere", refused.committed === false && refused.code === 1 && /route-dispatch-must-be-paused/.test(refused.problem) && stray.trace.some((t) => t[0] === "rollback") && !stray.trace.some((t) => t[0] === "commit"));
  let blankThrew = null;
  try { await CP.runControlPackageTransaction({ store: makeTraceStore(), pkg: { ...pkg, post: { ...pkg.post, promotedEnabled: ["fba-plan", " "] } }, mode: "apply", controlledReportKeys: CONTROLLED, ownerToken: "owner-1", operationKey: "op" }); } catch (e) { blankThrew = e; }
  ok("C3 an array promotedEnabled with a blank/noncanonical key is refused BEFORE BEGIN (never silently dropped)", !!blankThrew && /before BEGIN/.test(blankThrew.message));

  // Bounded lease-wait.
  const mkCli = ({ leaseWaitSeconds, heldFor = Infinity, other = null }) => {
    let attempt = 0; let clock = 0; const sleeps = [];
    const connectStore = async () => { attempt += 1; return other ? makeTraceStore(other) : makeTraceStore({ leaseHeld: attempt <= heldFor }); };
    const run = () => CP.runControlPackageCli({ mode: "apply", operator: "op@x", discoverAccounts: async () => ["IN1"], connectStore, controlledReportKeys: CONTROLLED, buildApplyPackage: ({ accounts, operator, controlledReportKeys }) => CP.buildRouteControlPackage({ accounts, operator, publisherKeys: [RL], controlledReportKeys }), ownerToken: "owner-1", operationKey: "op", leaseWaitSeconds, sleep: async (ms) => { sleeps.push(ms); clock += ms; }, now: () => clock });
    return { run, attempts: () => attempt, sleeps };
  };
  const z = mkCli({ leaseWaitSeconds: 0 });
  const zr = await z.run();
  ok("C4 leaseWaitSeconds 0 (default): a CONTROL_LEASE_HELD apply is attempted EXACTLY once (byte-identical)", zr.committed === false && /^CONTROL_LEASE_HELD/.test(zr.problem) && z.attempts() === 1 && z.sleeps.length === 0);
  const w2 = mkCli({ leaseWaitSeconds: 60, heldFor: 2 });
  const wr = await w2.run();
  ok("C4 lease-wait: retries every 15 s ONLY while CONTROL_LEASE_HELD, then commits", wr.committed === true && w2.attempts() === 3 && JSON.stringify(w2.sleeps) === JSON.stringify([15000, 15000]));
  const w3 = mkCli({ leaseWaitSeconds: 60 });
  const wr3 = await w3.run();
  ok("C4 lease-wait is BOUNDED: never starts an attempt after start + leaseWaitSeconds (60 s -> 5 attempts), returns the last lease-held result", wr3.committed === false && /^CONTROL_LEASE_HELD/.test(wr3.problem) && w3.attempts() === 5 && w3.sleeps.length === 4);
  const w4 = mkCli({ leaseWaitSeconds: 600, other: { strayDispatch: "x-dispatch" } });
  const wr4 = await w4.run();
  ok("C4 lease-wait NEVER retries a non-lease failure (a POST assertion failure returns after ONE attempt)", wr4.committed === false && w4.attempts() === 1 && w4.sleeps.length === 0);
  const w5 = mkCli({ leaseWaitSeconds: 600, other: { commitThrows: true } });
  const wr5 = await w5.run();
  ok("C4 lease-wait NEVER retries a COMMIT_UNKNOWN (code 3)", wr5.code === 3 && w5.attempts() === 1);
  let rangeThrew = 0;
  for (const v of [-1, 3601, Number.NaN, "abc"]) { try { await CP.runControlPackageCli({ mode: "apply", operator: "op@x", discoverAccounts: async () => ["IN1"], connectStore: async () => makeTraceStore(), leaseWaitSeconds: v }); } catch { rangeThrew += 1; } }
  ok("C4 a malformed / out-of-range lease-wait bound is refused before any discovery (never 'wait forever')", rangeThrew === 4);
  ok("C4 a held lease is recognised ONLY by the typed CONTROL_LEASE_HELD prefix on an uncommitted code-1 result", CP.isControlLeaseHeldResult({ committed: false, code: 1, problem: "CONTROL_LEASE_HELD: x" }) && !CP.isControlLeaseHeldResult({ committed: false, code: 3, commitUnknown: true, problem: "CONTROL_LEASE_HELD" }) && !CP.isControlLeaseHeldResult({ committed: false, code: 1, problem: "POST: dispatch" }) && !CP.isControlLeaseHeldResult({ committed: true, code: 0 }));
}

// =====================================================================================================================
// D. the hoisted resume predicate + the route module contract
// =====================================================================================================================
{
  // The PRE-HOIST inline predicate (verbatim from the three releases at 6a59a1f).
  const nb = (v) => S(v).trim() !== "";
  function legacyResumable(job, { cycleId, paramsHash, dependsOn, durableContentDeps }) {
    return !!job && nb(cycleId)
      && S(job.cycleId) === S(cycleId)
      && B.jobIsPromotable(job)
      && S(job.snapshotParamsHash) === S(paramsHash)
      && B.revisionCoveredByJob({ eligible: true, deps: dependsOn, contentDeps: durableContentDeps }, job);
  }
  const J = { cycleId: "c1", deriveStatus: "succeeded", saveStatus: "succeeded", validated: true, cycleStatus: "succeeded", snapshotParamsHash: "h1", dependsOn: ["d1", "d2"], durableContentDeps: ["t1"] };
  const A = { cycleId: "c1", paramsHash: "h1", dependsOn: ["d1"], durableContentDeps: ["t1"] };
  const cases = [
    [J, A], [null, A], [J, { ...A, cycleId: "" }], [J, { ...A, cycleId: "c2" }], [{ ...J, validated: false }, A], [{ ...J, cycleStatus: "running" }, A], [{ ...J, cycleStatus: "partial" }, A],
    [J, { ...A, paramsHash: "h2" }], [J, { ...A, dependsOn: ["d9"] }], [J, { ...A, durableContentDeps: ["t9"] }], [J, { ...A, dependsOn: [], durableContentDeps: [] }], [{ ...J, snapshotParamsHash: "" }, { ...A, paramsHash: "" }], [{ ...J, cycleId: null }, A],
  ];
  ok("D1 the hoisted resumableAtTerminalCycle is IDENTICAL to the pre-hoist inline predicate over the whole case matrix", cases.every(([j, a]) => B.resumableAtTerminalCycle(j, a) === legacyResumable(j, a)) && cases.filter(([j, a]) => B.resumableAtTerminalCycle(j, a)).length === 2);
  const rels = ["lib/server/sync/listing-health-v3-release.js", "lib/server/sync/fba-brand-inventory-release.js", "lib/server/sync/daily-reporting-release.js", "lib/server/sync/route-publication-release.js"];
  ok("D1 the three dedicated releases AND the generic route release all import the ONE shared predicate and none defines its own", rels.every((f) => /import \{[^}]*\bresumableAtTerminalCycle\b[^}]*\} from "\.\/publication-binding\.js"/.test(src(f)) && !/function resumableAtTerminalCycle\b/.test(src(f))));

  const workerRoute = {
    id: "returns-v3", kind: "route-cli", cli: { script: RC.ROUTE_CLI_SCRIPT, fixedArgs: [] }, publisherKeys: [RL], liveReportKeys: ["returns-leakage"], grain: "account", unit: "none", awaits: [],
    deps: { sources: ["returns", "settlement"], reports: [] }, evidence: { sql: [{ name: "returns_meta", text: "select account_id, count(*) n from source_returns_history where account_id = any($1) group by 1", params: () => [] }], compose: () => new Map(), everySeconds: 600 },
    identityAsOf: null, tier1: { liveRowScope: () => ({ reportKey: "returns-leakage" }) }, deadlineSeconds: 330, hardTimeoutSeconds: 420, childHeapMb: 256, minChildHeapMb: 192, priority: 3, scanGroup: "returns",
  };
  const cliRoute = { id: "returns-v3", publisherKey: RL, stampPolicy: "cycle", build: () => ({}) };
  ok("D2 a well-formed worker + CLI route pair validates", RC.validateRouteModule({ default: workerRoute }, { side: "worker" }) === workerRoute && RC.validateRouteModule(cliRoute, { side: "cli", liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, reportDerivations: REPORT_DERIVATIONS }) === cliRoute && RC.validateRoutePair(workerRoute, cliRoute, { liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS }) === true);
  const probs = (r) => RC.workerRouteProblems(r);
  ok("D2 the worker contract refuses: an unknown key, a non-read-only evidence SQL, a runner-owned fixed arg, a self await, a hard timeout <= deadline, empty source deps, a legacy script under route-cli",
    probs({ ...workerRoute, servedSelecter: 1 }).includes("unknown-key:servedSelecter")
    && probs({ ...workerRoute, evidence: { ...workerRoute.evidence, sql: [{ name: "x", text: "delete from report_snapshots", params: () => [] }] } }).includes("evidence-sql-not-read-only:x")
    && probs({ ...workerRoute, evidence: { ...workerRoute.evidence, sql: [{ name: "x", text: "select 1; select 2", params: () => [] }] } }).includes("evidence-sql-not-read-only:x")
    && probs({ ...workerRoute, cli: { script: RC.ROUTE_CLI_SCRIPT, fixedArgs: ["--live"] } }).includes("cli-fixed-args-runner-owned")
    && probs({ ...workerRoute, awaits: ["returns-v3"] }).includes("awaits-self") && probs({ ...workerRoute, hardTimeoutSeconds: 330 }).includes("hard-timeout-seconds-invalid")
    && probs({ ...workerRoute, deps: { sources: [], reports: [] } }).includes("deps-invalid") && probs({ ...workerRoute, cli: { script: "scripts/release/oli-publication-reconcile.mjs", fixedArgs: [] } }).includes("cli-script-not-route-cli"));
  ok("D2 the CLI contract refuses an unknown key, a bad stamp policy, a publisher key with no live contract / derivation; the runtime contract refuses a missing required hook",
    RC.cliRouteProblems({ ...cliRoute, extra: 1 }).includes("unknown-key:extra") && RC.cliRouteProblems({ ...cliRoute, stampPolicy: "wall" }).includes("stamp-policy-invalid")
    && RC.cliRouteProblems({ ...cliRoute, publisherKey: "nope" }, { liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, reportDerivations: REPORT_DERIVATIONS }).includes("publisher-key-no-live-contract")
    && RC.routeRuntimeProblems({ readScopeEvidence() {}, computeRevision() {}, resolveBundle() {}, derive() {}, identityParams() {} }).includes("missing-hook:servedSelector")
    && RC.routePairProblems(workerRoute, { ...cliRoute, publisherKey: SKU }, { liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS }).includes("pair-publisher-key-mismatch"));
  let cyc = null;
  try { RC.routeTopoOrder([{ id: "a", awaits: ["b"] }, { id: "b", awaits: ["a"] }]); } catch (e) { cyc = e; }
  ok("D3 routeTopoOrder runs routes in awaits order (Kahn, stable ties) and THROWS on a cycle", JSON.stringify(RC.routeTopoOrder([{ id: "ads", awaits: ["oli"] }, { id: "oli", awaits: [] }, { id: "fba", awaits: ["oli"] }])) === JSON.stringify(["oli", "ads", "fba"]) && !!cyc);
}

// =====================================================================================================================
// E. the WP4 verifier findings (regressions for every fixed defect)
// =====================================================================================================================
// A reconciler over a world + route build (the A1b wiring), optionally verify-exact and with injected control hooks.
const mkRec = (w, b, { verifyExact = false, openControls = async () => ({ ok: true }), closeControls = async () => ({ ok: true }), runtime = b.runtime } = {}) => SDR.buildSavedDataReconciler({
  resolveOrg: async () => ({ organizationFingerprint: "org-fp", connectionId: "primary" }),
  bucketAccounts: async () => [{ accountId: ACC }],
  adapter: REL.buildRouteReconcileAdapter({ route: b.route, runtime, bucket: REGION, liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, readLatestJob: w.readLatestJob, verifyExact }),
  readLatestReportJob: ({ reportKey, accountId }) => w.readLatestJob(reportKey, accountId),
  readShadowSnapshot: (a) => w.readSnapshot(a), readLiveSnapshot: (a) => w.readSnapshot(a), loadStoragePayload: w.loadStoragePayload,
  verifyLiveReadback: w.readbackLive, liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, computeHash: paramsHashFor, reportDerivations: REPORT_DERIVATIONS,
  runPrepareForUnit: (a) => b.release.prepareForUnit(a), runPublishForUnit: (a) => b.release.publishForUnit(a),
  openControls, closeControls, reportKeys: [RL], family: "returns-v3",
});
const unitOf = (s) => s.perAccount[0].reports[RL];
const E3 = { v: "3", m: "c", asOf: ASOF, total: 3, instant: "2026-09-24T05:40:00.000Z" };

{
  // E1 (P2-1). A -> B -> C (killed AFTER its job insert) -> A: the latest job is C's (NOT promotable, another revision).
  // The return to A nonces over C's job id -- never A's own TERMINAL 'none' cycle or B's earlier nonce -- and publishes.
  const w = makeWorld();
  const ev = evMap({ [ACC]: E1 });
  let crash = false;
  const { release } = build(w, { evidence: ev, depsOver: { saveShadow: async (a) => { if (crash) throw new Error("deadline-killed"); return w.saveShadow(a); } } });
  const ra = await pub(release, await prep(release, { v: "1" }));
  ev.set(ACC, E2);
  const rb = await pub(release, await prep(release, { v: "2" }));
  ev.set(ACC, E3); crash = true;
  const pc = await prep(release, { v: "3" });
  crash = false;
  const cJob = w.lineage(RL, ACC);
  ok("E1 setup: A and B published; C's prepare was killed AFTER its job insert (its job is the latest: not promotable, cycle running, another revision)", ra.disposition === "published" && rb.disposition === "published" && pc.ok === false && /^shadow-cas-threw/.test(pc.reason) && cJob.validated === false && cJob.cycleStatus === "running" && liveRowRl(w).params.evidenceToken === "rl1:2");
  ev.set(ACC, E1);
  const cyclesBefore = w.cycles.size;
  const pa2 = await prep(release, { v: "1" });
  const newest = [...w.cycles.values()].pop();
  ok("E1 the return to A opens a FRESH cycle nonced over C's (non-promotable) job id -- never 'cycle-not-running:succeeded' on A's terminal 'none' cycle", pa2.ok === true && pa2.prepared === true && w.cycles.size === cyclesBefore + 1 && newest.bucket === REL.routeCycleBucket({ region: REGION, routeId: "returns-v3", targetId: ACC, revisionId: "rev-1", nonce: cJob.id }) && newest.bucket !== REL.routeCycleBucket({ region: REGION, routeId: "returns-v3", targetId: ACC, revisionId: "rev-1", nonce: "none" }) && newest.status === "succeeded");
  const ra2 = await pub(release, pa2);
  ok("E1 ... and A publishes over B's stale content (the live row carries A's tokens again)", ra2.ok === true && ra2.disposition === "published" && liveRowRl(w).params.evidenceToken === "rl1:1");

  // The first-ever variant (probe1): A (nonce 'none') published; B killed after its job insert; back to A.
  const wF = makeWorld();
  const evF = evMap({ [ACC]: E1 });
  let crashF = false;
  const bF = build(wF, { evidence: evF, depsOver: { saveShadow: async (a) => { if (crashF && a.params.rev === "rev-2") throw new Error("killed"); return wF.saveShadow(a); } } });
  await pub(bF.release, await prep(bF.release, { v: "1" }));
  evF.set(ACC, E2); crashF = true;
  await prep(bF.release, { v: "2" });
  evF.set(ACC, E1);
  const bJob = wF.lineage(RL, ACC);
  const again = await prep(bF.release, { v: "1" });
  const rAgain = await pub(bF.release, again);
  ok("E1 first-ever variant: A('none') -> B killed after its job insert -> A: nonces over B's job id and completes (no terminal strand)", again.ok === true && [...wF.cycles.values()].pop().bucket === REL.routeCycleBucket({ region: REGION, routeId: "returns-v3", targetId: ACC, revisionId: "rev-1", nonce: bJob.id }) && rAgain.ok === true && ["published", "already-current"].includes(rAgain.disposition));
  // Precedence: a crashed prepare of THIS derivation still RESUMES its own running cycle (A3 semantics unchanged).
  const wR = makeWorld();
  let killR = true;
  const bR = build(wR, { evidence: evMap({ [ACC]: E1 }), depsOver: { saveShadow: async (a) => { if (killR) { killR = false; throw new Error("killed"); } return wR.saveShadow(a); } } });
  await prep(bR.release, { v: "1" });
  wR.tick(10 * 60 * 1000);
  const r2 = await prep(bR.release, { v: "1" });
  ok("E1 precedence: THIS derivation's crashed in-flight job still resumes its own RUNNING cycle (no new cycle)", r2.ok === true && wR.n.cycleCreate === 1 && wR.jobs.length === 1);
}

{
  // E2 (P2-2). The fast path must not call a unit current when the live stamp differs from the latest promotable
  // shadow's (probe2): A published (live t1); B prepared but its publish deferred; A re-prepared in a NEW nonce cycle
  // (its shadow REPLACED at A's hash with a newer stamp t3); killed before publish.
  const w = makeWorld();
  const ev = evMap({ [ACC]: E1 });
  const b = build(w, { evidence: ev });
  await pub(b.release, await prep(b.release, { v: "1" }));
  const t1 = liveRowRl(w).source_refreshed_at;
  ev.set(ACC, E2); const pB = await prep(b.release, { v: "2" }); ev.set(ACC, E1);
  const rB = await pub(b.release, pB);
  const pA2 = await prep(b.release, { v: "1" });
  ok("E2 setup: B's publish deferred (evidence-advanced); A re-prepared -> its shadow REPLACED with a newer stamp while the live row keeps t1", rB.reason === "evidence-advanced" && pA2.shadowOutcome === "replaced" && pA2.sourceRefreshedAt > t1 && liveRowRl(w).source_refreshed_at === t1);
  const v0 = unitOf(await mkRec(w, b).run({ bucket: REGION, requestedAsOf: EPOCH, dryRun: true }));
  const cas0 = w.n.liveCas;
  const s1 = await mkRec(w, b).run({ bucket: REGION, requestedAsOf: EPOCH, dryRun: false });
  const u1 = unitOf(s1);
  const v1 = unitOf(await mkRec(w, b).run({ bucket: REGION, requestedAsOf: EPOCH, dryRun: true }));
  ok("E2 verify said STALE 'live-refresh-differs'; the LIVE pass now PUBLISHES (the fenced CAS replaces the older live row: stamp == the shadow's) instead of a stamp-blind 'already-current'", v0.state === "STALE" && v0.reason === "live-refresh-differs" && u1.state === RS.RV && s1.counts.targetsPublished === 1 && w.n.liveCas === cas0 + 1 && liveRowRl(w).source_refreshed_at === pA2.sourceRefreshedAt);
  ok("E2 ... and verify then CONVERGES (PUBLICATION_NOT_REQUIRED) -- no livelock", v1.state === RS.NR);
  const cas2 = w.n.liveCas; const wr2 = w.writes();
  const s2 = await mkRec(w, b).run({ bucket: REGION, requestedAsOf: EPOCH, dryRun: false });
  ok("E2 a further live pass: current by the exact binding, ZERO CAS, zero writes", unitOf(s2).state === RS.NR && w.n.liveCas === cas2 && w.writes() === wr2);
  // The evidence-stamp zero-CAS paths: a stamp-only difference also falls through to the fenced publish.
  const wE = makeWorld();
  const bE = build(wE, { evidence: evMap({ [ACC]: E1 }), stamp: "evidence" });
  const pE = await prep(bE.release, { v: "1" }); await pub(bE.release, pE);
  const shKey = "scheduler-v2/" + RL + "|" + ACC + "|" + pE.shadowParamsHash;
  // (i) a prepare that PROVED the unit current with zero writes (alreadyCurrent), while the live row is OLDER than the
  // latest promotable shadow (synthesised from a real prepare: the publish-branch contract under test).
  liveRowRl(wE).source_refreshed_at = "2026-09-24T04:00:00.000Z";
  const pAC = { ...(await prep(bE.release, { v: "1" })), resumed: false, alreadyCurrent: true, shadowOutcome: "not-written", cycleId: null };
  const casI = wE.n.liveCas;
  const rI = await pub(bE.release, pAC);
  const vI = unitOf(await mkRec(wE, bE).run({ bucket: REGION, requestedAsOf: EPOCH, dryRun: true }));
  ok("E2 an alreadyCurrent prepare whose live stamp is OLDER than the latest shadow's -> falls through to the fenced publish (CAS replaces it) -> verify then PASSES", rI.ok === true && rI.disposition === "published" && wE.n.liveCas === casI + 1 && liveRowRl(wE).source_refreshed_at === E1.instant && vI.state === RS.NR);
  // (ii) a resumed prepare while the live row is NEWER than the shadow: one refused CAS, proven already-current.
  liveRowRl(wE).source_refreshed_at = "2026-09-24T05:20:00.000Z";
  const pE2 = await prep(bE.release, { v: "1" });
  const casE = wE.n.liveCas; const wrE = wE.writes();
  const rE2 = await pub(bE.release, pE2);
  ok("E2 a resumed prepare whose live row is NEWER than the shadow goes through the fenced CAS (refused, zero writes) and is proven already-current -- never a stamp-blind zero-CAS verdict", pE2.resumed === true && rE2.ok === true && rE2.alreadyCurrent === true && rE2.disposition === "refused-newer-live" && wE.n.liveCas === casE + 1 && wE.writes() === wrE && wE.snaps.get(shKey).source_refreshed_at === E1.instant);
}

{
  // E3 (P2-3). Content identity is the STORED form: an undefined-valued key and a Date digest as storage keeps them.
  const withQuirks = (p) => ({ ...p, note: undefined, generatedAt: new Date(Date.UTC(2026, 8, 24, 6, 0, 0)), nested: { keep: 1, drop: undefined }, list: [1, undefined] });
  const mem = withQuirks(returnsPayload(ACC, ASOF));
  const stored = JSON.parse(JSON.stringify(mem));
  ok("E3 payloadDigest(in-memory) === payloadDigest(stored JSON round-trip) for undefined keys, a Date, nested undefined and array holes; a real content change still differs",
    REL.payloadDigest(mem) === REL.payloadDigest(stored) && stored.generatedAt === "2026-09-24T06:00:00.000Z" && !("note" in stored) && REL.payloadDigest(mem) !== REL.payloadDigest({ ...stored, rows: [{ asin: "B0X", refunds: 2 }] }) && REL.payloadDigest(undefined) === REL.payloadDigest(null));
  const derive = async (bundle) => ({ payload: withQuirks(returnsPayload(ACC, bundle.e.asOf, bundle.e.total)), latestDataDate: bundle.e.asOf });
  // (a) a refused shadow CAS whose existing row is the SAME stored content -> adopted (never 'content-differs').
  const w = makeWorld();
  const b = build(w, { evidence: evMap({ [ACC]: E1 }), runtimeOver: { derive } });
  const first = await prep(b.release, { v: "1" });
  w.snaps.get("scheduler-v2/" + RL + "|" + ACC + "|" + first.shadowParamsHash).source_refreshed_at = "2099-01-01T00:00:00.000Z";
  w.jobs.length = 0; w.cycles.clear();
  const adopted = await prep(b.release, { v: "1" });
  ok("E3 a refused shadow holding the identical STORED content (undefined keys dropped, Date serialized) is ADOPTED -- never a false 'shadow-newer-live:content-differs'", adopted.ok === true && adopted.shadowOutcome === "adopted-newer" && SDR.statusFromRelease(adopted) !== RS.FD);
  // (b) a refused LIVE write whose stored live payload is the same content -> proven already-current.
  const wL = makeWorld();
  const bL = build(wL, { evidence: evMap({ [ACC]: E1 }), runtimeOver: { derive } });
  const pL = await prep(bL.release, { v: "1" });
  await pub(bL.release, pL);
  liveRowRl(wL).source_refreshed_at = "2099-01-01T00:00:00.000Z";
  const rL = await pub(bL.release, { ...pL, resumed: false, shadowOutcome: "inserted" });
  ok("E3 a refused live write over the identical STORED content is proven already-current (no false 'payload-differs' -> NEWER_LIVE)", rL.ok === true && rL.alreadyCurrent === true && rL.disposition === "refused-newer-live");
}

{
  // E4 (P2-4). The multi-route CLI sequence STOPS after a route leaves the control plane unproven. The control windows
  // run through the REAL runControlPackageCli + buildRouteControlPackage (buildRouteCliControls) over a FAKE control
  // store whose SAFE-CLOSE commit acknowledgement is lost (COMMIT_UNKNOWN).
  const run2 = async (storeOpts) => {
    const w = makeWorld();
    const b = build(w, { evidence: evMap({ [ACC]: E1 }) });
    const store = makeTraceStore(storeOpts);
    const connectStore = async () => store;
    const controls = REL.buildRouteCliControls({
      runControlPackageCli: CP.runControlPackageCli, connectStore, buildRouteControlPackage: CP.buildRouteControlPackage,
      partialNamespacePermitted: async () => ({ permitted: true }),
      readControlPlaneClosed: () => REL.readRouteControlPlaneClosed({ connectStore, controlledReportKeys: CONTROLLED }),
      operator: "publication-route-reconcile:india:prw-e4-run-0001", operationKey: "publication-route-reconcile/returns-v3+sku-movement/india/" + EPOCH,
    });
    const ran = [];
    const runRoute = async (id) => { ran.push(id); return mkRec(w, b, { openControls: controls.openControls, closeControls: controls.closeControls }).run({ bucket: REGION, requestedAsOf: EPOCH, dryRun: false }); };
    const seq = await REL.runRouteCliSequence({ order: ["returns-v3", "sku-movement"], runRoute });
    return { w, store, seq, ran };
  };
  const bad = await run2({ commitThrowsAfter: 1 }); // apply commits; the safe-close commit ack is lost
  const first = bad.seq.runs[0];
  ok("E4 route 1 published inside a real control window, then its safe-close hit COMMIT_UNKNOWN -> its summary is control-cleanup-unresolved", first.summary.controlCleanupUnresolved === true && first.summary.code === "CONTROL_CLEANUP_UNRESOLVED" && bad.w.n.liveWrite === 1 && bad.store.trace.filter((t) => t[0] === "commit").length === 2);
  ok("E4 the sequence STOPS: route 2 is NEVER built / run (no second control window opens over the unproven plane) and is recorded skipped 'controls-unresolved'", bad.seq.stoppedBy === "returns-v3" && JSON.stringify(bad.ran) === JSON.stringify(["returns-v3"]) && bad.seq.runs[1].skipped === true && bad.seq.runs[1].reason === REL.ROUTE_CLI_CONTROLS_UNRESOLVED && bad.store.trace.filter((t) => t[0] === "acquireControlLease").length === 1);
  const routeResults = [{ id: "returns-v3", ok: first.summary.ok === true, outcome: first.summary.outcome, code: first.summary.code }, REL.routeCliSkippedRoute("sku-movement")];
  const verdict = REL.routeCliOutcome({ routeResults, zeroExportViolation: false, anyControlUnresolved: bad.seq.stoppedBy != null });
  const tl = TGT.parseTargetsLine(TGT.formatTargetsLine({ v: 2, route: "sku-movement", summary: REL.routeCliSkippedTargetsSummary({ bucket: REGION, asOf: EPOCH, dryRun: false }) }));
  ok("E4 RESULT: the skipped route is DEFERRED 'controls-unresolved' (ok:false, zero counts); the run is CONTROL_CLEANUP_UNRESOLVED with exit 1 (the LHv3 CLI's unresolved-control exit)", routeResults[1].ok === false && routeResults[1].reason === "controls-unresolved" && routeResults[1].counts.targetsExamined === 0 && verdict.ok === false && verdict.code === "CONTROL_CLEANUP_UNRESOLVED" && verdict.exitCode === 1);
  ok("E4 TARGETS v2 for the skipped route: code 'controls-unresolved', ZERO targets (nothing proven current)", tl && tl.v === 2 && tl.route === "sku-movement" && tl.code === "controls-unresolved" && tl.targets.length === 0 && tl.dataDoeCreates === 0);
  const good = await run2({});
  ok("E4 with a clean safe-close (evidence-proven closed) the SAME sequence runs every route", good.seq.stoppedBy === null && good.seq.runs.length === 2 && good.seq.runs.every((r) => r.skipped === false) && JSON.stringify(good.ran) === JSON.stringify(["returns-v3", "sku-movement"]) && good.seq.runs[0].summary.ok === true);
  ok("E4 routeCliOutcome: a zero-export block fails the run (ZERO_EXPORT_VIOLATION); all-ok -> OK exit 0; a hard failure without control issues -> HARD_FAILURES",
    REL.routeCliOutcome({ routeResults: [{ ok: true, outcome: "complete" }], zeroExportViolation: true }).code === "ZERO_EXPORT_VIOLATION" && REL.routeCliOutcome({ routeResults: [{ ok: true, outcome: "partial" }] }).exitCode === 0
    && REL.routeCliOutcome({ routeResults: [{ ok: true, outcome: "partial" }] }).outcome === "partial" && REL.routeCliOutcome({ routeResults: [{ ok: false, outcome: "failed" }] }).code === "HARD_FAILURES");
}

{
  // E5 (P2-5). A manifest drift under an UNCHANGED L1 token (probe3): verify-exact reports it with its typed reason, a
  // LIVE exact pass repairs it through a NEW content-addressed shadow + the fenced publish, and verify then passes.
  const w = makeWorld();
  const ev = evMap({ [ACC]: E1 });
  const b = build(w, { evidence: ev });
  const p1 = await prep(b.release, { v: "1" }); await pub(b.release, p1);
  const oldJob = w.lineage(RL, ACC);
  const oldShadow = JSON.parse(JSON.stringify(w.snaps.get("scheduler-v2/" + RL + "|" + ACC + "|" + p1.shadowParamsHash)));
  ev.set(ACC, { ...E1, m: "DRIFT", total: 42 });
  const vx = await mkRec(w, b, { verifyExact: true }).run({ bucket: REGION, requestedAsOf: EPOCH, dryRun: true });
  const tx = TGT.parseTargetsLine(TGT.formatTargetsLine({ v: 2, route: "returns-v3", summary: { ...vx, bucket: REGION, requestedAsOf: EPOCH, dryRun: true } }));
  ok("E5 verify-exact: STALE with the typed reason 'manifest-differs' kept through the core AND the TARGETS v2 line (never relabelled 'served-row-differs')", unitOf(vx).state === "STALE" && unitOf(vx).reason === "manifest-differs" && tx.targets[0].units[0].r === "manifest-differs");
  const plain = await mkRec(w, b).run({ bucket: REGION, requestedAsOf: EPOCH, dryRun: false });
  ok("E5 (a non-exact live pass cannot see a manifest drift under an unchanged L1 token: current, zero writes -- the reason --live --verify-exact exists)", unitOf(plain).state === RS.NR && liveRowRl(w).payload.rows[0].refunds === 1);
  const cyc0 = w.cycles.size;
  const lx = await mkRec(w, b, { verifyExact: true }).run({ bucket: REGION, requestedAsOf: EPOCH, dryRun: false });
  const live = liveRowRl(w);
  const newJob = w.lineage(RL, ACC);
  ok("E5 LIVE exact pass: the drifted unit is RE-DERIVED (the resume gate refuses the old shadow: manifest differs) into a NEW content-addressed shadow in a NEW nonce cycle and PUBLISHED through the fenced path", unitOf(lx).state === RS.RV && live.payload.rows[0].refunds === 42 && live.params.manifestToken === "mf1:DRIFT" && newJob.snapshotParamsHash !== p1.shadowParamsHash && newJob.durableContentDeps.includes("mf1:DRIFT") && w.cycles.size === cyc0 + 1 && [...w.cycles.values()].pop().bucket === REL.routeCycleBucket({ region: REGION, routeId: "returns-v3", targetId: ACC, revisionId: "rev-1", nonce: oldJob.id }));
  ok("E5 the OLD shadow is untouched (a distinct hash -- never overwritten / collided)", JSON.stringify(w.snaps.get("scheduler-v2/" + RL + "|" + ACC + "|" + p1.shadowParamsHash)) === JSON.stringify(oldShadow));
  const vx2 = await mkRec(w, b, { verifyExact: true }).run({ bucket: REGION, requestedAsOf: EPOCH, dryRun: true });
  const wr = w.writes();
  const lx2 = await mkRec(w, b, { verifyExact: true }).run({ bucket: REGION, requestedAsOf: EPOCH, dryRun: false });
  ok("E5 verify-exact then PASSES and a further live exact pass is a zero-write no-op (converged)", unitOf(vx2).state === RS.NR && unitOf(lx2).state === RS.NR && w.writes() === wr);
  // The resume gate in isolation: same revision, drifted manifest -> never resumed.
  const w2 = makeWorld();
  const ev2 = evMap({ [ACC]: E1 });
  const b2 = build(w2, { evidence: ev2 });
  const q1 = await prep(b2.release, { v: "1" });
  ev2.set(ACC, { ...E1, m: "z2" });
  const q2 = await prep(b2.release, { v: "1" });
  ev2.set(ACC, E1);
  const q3 = await prep(b2.release, { v: "1" });
  ok("E5 resume gate: a promotable same-revision job whose shadow manifest != the fresh bundle's is NOT resumed (fresh derive, distinct hash); an unchanged manifest still resumes with zero writes", q1.ok && q2.ok === true && q2.resumed === false && q2.shadowParamsHash !== q1.shadowParamsHash && q3.ok === true && q3.resumed === false && q3.shadowParamsHash === q1.shadowParamsHash && (await prep(b2.release, { v: "1" })).resumed === true);
}

{
  // E6 (WP7 addendum). A route whose currentPredicate PROVES content equivalence against the SERVED row (fba-plan: a
  // row published by the PAID job, no route lineage) is honoured by verify-exact -- ONLY with the explicit marker.
  const liveKey = "returns-leakage|" + ACC + "|" + liveHashRl();
  const seedPaid = (w, refunds) => w.snaps.set(liveKey, { id: "paid-1", report_key: "returns-leakage", account_id: ACC, params_hash: liveHashRl(), params: { reportVersion: "returns-leakage-v3", to: ASOF }, payload: returnsPayload(ACC, ASOF, refunds), payload_storage_path: null, source_refreshed_at: "2026-09-24T04:00:00.000Z", updated_at: "2026-09-24T04:00:00.000Z" });
  const predicateFor = (w, runtime, { marker = true } = {}) => async (rk, unit, ctx = {}) => {
    const served = await SEL.selectLatestForScope({ reportKey: "returns-leakage", accountId: unit.liveAccountId, reportVersion: "returns-leakage-v3", scope: {}, readers: w.readers });
    if (!served.row) return { state: "STALE", reason: "served-missing" };
    const full = w.snaps.get("returns-leakage|" + unit.liveAccountId + "|" + served.row.params_hash);
    const bnd = await runtime.resolveBundle(unit, { strict: true, revision: ctx.revision });
    if (!bnd || bnd.eligible !== true) return { state: "DEFERRED_DEPENDENCY", reason: "bundle-unresolved" };
    const d = await runtime.derive(bnd.bundle);
    if (B.stableJson(full.payload) !== B.stableJson(d.payload)) return { state: "STALE", reason: "content-differs" };
    return { state: RS.NR, reason: "content-equivalent", h: served.row.params_hash, sra: served.row.source_refreshed_at, ...(marker ? { proof: REL.ROUTE_PROOF_CONTENT_EQUIVALENT } : {}) };
  };
  const setup = ({ refunds, marker = true }) => {
    const w = makeWorld();
    seedPaid(w, refunds);
    const b = build(w, { evidence: evMap({ [ACC]: E1 }) });
    const runtime = { ...b.runtime, currentPredicate: predicateFor(w, b.runtime, { marker }) };
    const bb = { ...b, runtime, release: REL.buildRoutePublicationRelease({ route: b.route, runtime, deps: releaseDeps(w) }) };
    return { w, b: bb };
  };
  const eq = setup({ refunds: 1 });
  const sN = await mkRec(eq.w, eq.b).run({ bucket: REGION, requestedAsOf: EPOCH, dryRun: true });
  const sX = await mkRec(eq.w, eq.b, { verifyExact: true }).run({ bucket: REGION, requestedAsOf: EPOCH, dryRun: true });
  const wr = eq.w.writes(); const cas = eq.w.n.liveCas;
  const sL = await mkRec(eq.w, eq.b, { verifyExact: true }).run({ bucket: REGION, requestedAsOf: EPOCH, dryRun: false });
  ok("E6 a PAID-published, content-equivalent served row (no route lineage at all): the normal scan AND the verify-exact scan both report PUBLICATION_NOT_REQUIRED 'content-equivalent'", unitOf(sN).state === RS.NR && unitOf(sN).reason === "content-equivalent" && unitOf(sX).state === RS.NR && unitOf(sX).reason === "content-equivalent" && eq.w.jobs.length === 0);
  ok("E6 ... and a LIVE exact pass never re-derives / overwrites it: zero writes, zero CAS, the paid row stays served", unitOf(sL).state === RS.NR && eq.w.writes() === wr && eq.w.n.liveCas === cas && liveRowRl(eq.w).id === "paid-1");
  const noMark = setup({ refunds: 1, marker: false });
  const sXn = await mkRec(noMark.w, noMark.b, { verifyExact: true }).run({ bucket: REGION, requestedAsOf: EPOCH, dryRun: true });
  ok("E6 verify-exact is NOT weakened without the explicit proof marker: the same predicate verdict minus proof -> STALE 'manifest-differs'", unitOf(sXn).state === "STALE" && unitOf(sXn).reason === "manifest-differs");
  const diff = setup({ refunds: 77 });
  const dN = await mkRec(diff.w, diff.b).run({ bucket: REGION, requestedAsOf: EPOCH, dryRun: true });
  const dX = await mkRec(diff.w, diff.b, { verifyExact: true }).run({ bucket: REGION, requestedAsOf: EPOCH, dryRun: true });
  ok("E6 a content-DIFFERENT paid row -> STALE 'content-differs' in BOTH scans", unitOf(dN).state === "STALE" && unitOf(dN).reason === "content-differs" && unitOf(dX).state === "STALE" && unitOf(dX).reason === "content-differs");
}

{
  // E7 (P3-3). The optional prune: the signal threads into the DELETE, and an op aborted before it never starts it.
  const w = makeWorld();
  const pruned = [];
  const b = build(w, { evidence: evMap({ [ACC]: E1 }), depsOver: { prune: true, pruneShadows: async (a, opt) => { pruned.push({ a, opt }); return { deleted: 0 }; } } });
  const ac = new AbortController();
  const p = await prep(b.release, { v: "1" });
  const r = await pub(b.release, p, { signal: ac.signal });
  ok("E7 --prune-shadows: the DELETE receives the op's AbortSignal (deleteRouteShadowSnapshots(args, { signal }))", r.disposition === "published" && pruned.length === 1 && pruned[0].opt && pruned[0].opt.signal === ac.signal);
  const w2 = makeWorld();
  const pruned2 = [];
  const ac2 = new AbortController();
  const b2 = build(w2, { evidence: evMap({ [ACC]: E1 }), runtimeOver: { postPublish: async () => { ac2.abort(); } }, depsOver: { prune: true, pruneShadows: async (a, opt) => { pruned2.push({ a, opt }); return { deleted: 0 }; } } });
  const p2 = await prep(b2.release, { v: "1" });
  const r2 = await pub(b2.release, p2, { signal: ac2.signal });
  ok("E7 an op ABORTED after the verified publish never STARTS the prune DELETE (rechecked immediately before it); the verified publish stands", r2.ok === true && r2.disposition === "published" && pruned2.length === 0 && w2.n.liveWrite === 1);
}

{
  // E8 (P3-5). The latest job advanced between step (1) and the lineage write -> 'lineage-advanced-before-write'.
  const foreignJob = (w) => w.upsertReportJob({ cycleId: "cyc-foreign-" + w.jobs.length, reportKey: RL, reportVersion: "returns-leakage/v3-route", accountId: ACC, connectionId: "primary", bucket: REGION, dependsOn: ["dep:x"], durableContentDeps: ["rl1:9"] });
  const w = makeWorld();
  const b = build(w, { evidence: evMap({ [ACC]: E1 }), runtimeOver: { derive: async (bundle) => { await foreignJob(w); return { payload: returnsPayload(ACC, bundle.e.asOf, bundle.e.total), latestDataDate: bundle.e.asOf }; } } });
  const r = await prep(b.release, { v: "1" });
  ok("E8 another prepare wrote lineage DURING the derive -> DEFER 'lineage-advanced-before-write' with ZERO writes (no cycle, no job, no shadow)", r.ok === false && r.reason === "lineage-advanced-before-write" && SDR.statusFromRelease(r) === RS.DD && w.n.cycleCreate === 0 && w.jobs.length === 1 && w.n.shadowWrite === 0);
  const w2 = makeWorld();
  let inject = true;
  const b2 = build(w2, { evidence: evMap({ [ACC]: E1 }), depsOver: { claimCycle: async (id) => { const c = await w2.claimCycle(id); if (inject) { inject = false; await foreignJob(w2); } return c; } } });
  const r2 = await prep(b2.release, { v: "1" });
  const orphan = [...w2.cycles.values()];
  ok("E8 the latest job advanced AFTER the cycle open, just before the job upsert -> DEFER 'lineage-advanced-before-write': no job / shadow / reconcile write; the opened, CLAIMED, job-less cycle is FINALIZED (round-2 P3-3: never left 'running' as a phantom stall)", r2.ok === false && r2.reason === "lineage-advanced-before-write" && w2.jobs.length === 1 && w2.jobs[0].cycle_id.startsWith("cyc-foreign") && w2.n.shadowWrite === 0 && w2.n.reconcile === 0 && w2.n.finalize === 1 && orphan.length === 1 && orphan[0].status !== "running" && orphan[0].status !== "pending");
  const r3 = await prep(b2.release, { v: "1" });
  ok("E8 the retry nonces over the NEW latest job and completes", r3.ok === true && r3.prepared === true && [...w2.cycles.values()].pop().bucket === REL.routeCycleBucket({ region: REGION, routeId: "returns-v3", targetId: ACC, revisionId: "rev-1", nonce: w2.jobs[0].id }));
}

{
  // E4b. The route CLI is WIRED to the shared helpers exercised above (static: the CLI itself is never run offline).
  const cli = src("scripts/release/publication-route-reconcile.mjs");
  ok("E4b the CLI runs routes through runRouteCliSequence (no free-running loop), reports skipped routes via routeCliSkippedRoute / routeCliSkippedTargetsSummary, exits via routeCliOutcome, opens/closes controls via buildRouteCliControls (scheduler-only lease-wait, deadline-capped) and threads the signal into the prune DELETE",
    /rel\.runRouteCliSequence\(\{ order, runRoute,/.test(cli) && !/for \(const id of order\)/.test(cli) && /rel\.routeCliSkippedRoute\(run\.id\)/.test(cli) && /rel\.routeCliSkippedTargetsSummary\(/.test(cli)
    && /process\.exit\(verdict\.exitCode\)/.test(cli) && /rel\.buildRouteCliControls\(\{/.test(cli) && /leaseWaitSeconds: A\.mode === "scheduler" \? A\.leaseWaitSeconds : 0,/.test(cli) && /deadlineSeconds: deadlineSec, runStartMs,/.test(cli)
    && /pruneShadows: \(args, opt\) => sb\.deleteRouteShadowSnapshots\(args, opt\)/.test(cli) && /verifyExact: A\.verifyExact \}\)/.test(cli) && !/let leaseFence/.test(cli));
}

{
  // E9 (P3-6). The lease-wait is CAPPED at (remaining deadline - START_RESERVE): never waits past the deadline.
  const L = REL.routeCliLeaseWaitSeconds;
  const t0 = 1_000_000;
  ok("E9 routeCliLeaseWaitSeconds: no deadline -> the requested wait; otherwise min(requested, remaining - 120 s), never negative",
    L({ leaseWaitSeconds: 600, deadlineSeconds: 0, runStartMs: t0, nowMs: t0 + 999999 }) === 600 && L({ leaseWaitSeconds: 600, deadlineSeconds: 600, runStartMs: t0, nowMs: t0 }) === 480
    && L({ leaseWaitSeconds: 60, deadlineSeconds: 600, runStartMs: t0, nowMs: t0 }) === 60 && L({ leaseWaitSeconds: 600, deadlineSeconds: 600, runStartMs: t0, nowMs: t0 + 400000 }) === 80
    && L({ leaseWaitSeconds: 600, deadlineSeconds: 600, runStartMs: t0, nowMs: t0 + 500000 }) === 0 && L({ leaseWaitSeconds: 0, deadlineSeconds: 600, runStartMs: t0, nowMs: t0 }) === 0 && REL.ROUTE_CLI_START_RESERVE_SECONDS === 120);
  // END TO END through the REAL runControlPackageCli lease-wait loop: a lease held for the whole run.
  let clock = t0 + 400000; const starts = [];
  const store = () => { starts.push(clock); return makeTraceStore({ leaseHeld: true }); };
  const controls = REL.buildRouteCliControls({
    runControlPackageCli: CP.runControlPackageCli, connectStore: async () => store(), buildRouteControlPackage: CP.buildRouteControlPackage,
    partialNamespacePermitted: async () => ({ permitted: true }), readControlPlaneClosed: async () => ({ read: "ok", closed: true, detail: {} }),
    operator: "publication-route-reconcile:india:prw-e9-run-0001", operationKey: "publication-route-reconcile/returns-v3/india/" + EPOCH,
    leaseWaitSeconds: 600, deadlineSeconds: 600, runStartMs: t0, now: () => clock, sleep: async (ms) => { clock += ms; },
  });
  const opened = await controls.openControls({ owners: [ACC], publisherKeys: [RL] });
  const lastStart = Math.max(...starts);
  ok("E9 a held lease in scheduler mode with 200 s of deadline left: attempts stop at the capped 80 s wait (6 attempts) -- the last attempt starts before deadline - START_RESERVE, never past the deadline", opened.ok === false && /CONTROL_LEASE_HELD/.test(opened.reason) && starts.length === 6 && lastStart <= t0 + (600 - 120) * 1000 && lastStart - starts[0] === 75000 && controls.fence() === null);
}

// =====================================================================================================================
// F. the round-2 verifier findings
// =====================================================================================================================
const CLS = await import("../lib/server/recovery/classify.js");
const LC = await import("../lib/server/sync/cycle-lifecycle.js");

{
  // F1 (P3-2). stampPolicy 'evidence' + a manifest drift under an UNCHANGED revision AND an UNCHANGED evidence instant
  // (probeA): the live row sits at EXACTLY the evidence instant with different content tokens -- NOT newer live data.
  const w = makeWorld();
  const ev = evMap({ [ACC]: E1 });
  const b = build(w, { evidence: ev, stamp: "evidence" });
  const r1 = await pub(b.release, await prep(b.release, { v: "1" }));
  ev.set(ACC, { ...E1, m: "DRIFT", total: 42 });
  const vx = unitOf(await mkRec(w, b, { verifyExact: true }).run({ bucket: REGION, requestedAsOf: EPOCH, dryRun: true }));
  const wr = w.writes(); const cas = w.n.liveCas; const cyc = w.cycles.size;
  const passes = [];
  for (let i = 0; i < 3; i++) passes.push(unitOf(await mkRec(w, b, { verifyExact: true }).run({ bucket: REGION, requestedAsOf: EPOCH, dryRun: false })));
  ok("F1 setup: published at the evidence instant; verify-exact then reports the drift STALE 'manifest-differs'", r1.disposition === "published" && liveRowRl(w).source_refreshed_at === E1.instant && vx.state === "STALE" && vx.reason === "manifest-differs");
  ok("F1 every LIVE exact pass DEFERS with the distinct typed reason 'evidence-instant-not-advanced' (DEFERRED_DEPENDENCY, never 'evidence-not-newer-than-live') -- ZERO writes / CAS / cycles, the live row keeps its content",
    passes.every((u) => u.state === RS.DD && u.reason === REL.EVIDENCE_INSTANT_NOT_ADVANCED) && w.writes() === wr && w.n.liveCas === cas && w.cycles.size === cyc && liveRowRl(w).payload.rows[0].refunds === 1);
  const pd = await prep(b.release, { v: "1" });
  ok("F1 the prepare result: stage 'reconcile' + status EVIDENCE_INSTANT_NOT_ADVANCED (never NEWER_LIVE) -> statusFromRelease DEFERRED_DEPENDENCY; the worker classifies it a dependency deferral (alert-worthy reason), NOT superseded-newer-live",
    pd.ok === false && pd.stage === "reconcile" && pd.status === "EVIDENCE_INSTANT_NOT_ADVANCED" && pd.status !== "NEWER_LIVE" && pd.reason === "evidence-instant-not-advanced" && SDR.statusFromRelease(pd) === RS.DD
    && CLS.classifyDeferral(pd.reason).cls === CLS.CLASSES.DEPENDENCY);
  // A strictly NEWER live row (different tokens) stays the unchanged NEWER_LIVE.
  const wN = makeWorld();
  const evN = evMap({ [ACC]: E1 });
  const bN = build(wN, { evidence: evN, stamp: "evidence" });
  await pub(bN.release, await prep(bN.release, { v: "1" }));
  liveRowRl(wN).source_refreshed_at = "2026-09-24T05:00:01.000Z";
  evN.set(ACC, { ...E1, m: "DRIFT", total: 42 });
  const wrN = wN.writes();
  const pN = await prep(bN.release, { v: "1" });
  ok("F1 a live row STRICTLY newer than the evidence instant (content differs) is still NEWER_LIVE 'evidence-not-newer-than-live' (unchanged), zero writes", pN.status === "NEWER_LIVE" && pN.reason === "evidence-not-newer-than-live" && wN.writes() === wrN);
  // Equal instant, IDENTICAL content: still proven already-current with zero CAS (A10 unchanged).
  evN.set(ACC, E1); liveRowRl(wN).source_refreshed_at = E1.instant;
  const casEq = wN.n.liveCas;
  const rEq = await pub(bN.release, await prep(bN.release, { v: "1" }));
  ok("F1 equal instant with IDENTICAL content is still already-current with ZERO CAS", rEq.ok === true && rEq.alreadyCurrent === true && wN.n.liveCas === casEq);
  // CONVERGENCE: the evidence instant advances with the drift -> the live exact pass publishes; verify then passes.
  ev.set(ACC, { ...E1, m: "DRIFT", total: 42, instant: "2026-09-24T05:10:00.000Z" });
  const lB = unitOf(await mkRec(w, b, { verifyExact: true }).run({ bucket: REGION, requestedAsOf: EPOCH, dryRun: false }));
  const vB = unitOf(await mkRec(w, b, { verifyExact: true }).run({ bucket: REGION, requestedAsOf: EPOCH, dryRun: true }));
  const wrB = w.writes();
  const lB2 = unitOf(await mkRec(w, b, { verifyExact: true }).run({ bucket: REGION, requestedAsOf: EPOCH, dryRun: false }));
  ok("F1 once the evidence instant ADVANCES the drift is published (fresh content-addressed shadow, fenced CAS, stamp = the new instant), verify-exact PASSES and a further live exact pass writes nothing",
    lB.state === RS.RV && liveRowRl(w).payload.rows[0].refunds === 42 && liveRowRl(w).params.manifestToken === "mf1:DRIFT" && liveRowRl(w).source_refreshed_at === "2026-09-24T05:10:00.000Z" && vB.state === RS.NR && lB2.state === RS.NR && w.writes() === wrB);
  // probeB shape: alternating drifts, each with an ADVANCING instant -> every pass publishes + verifies; then idle.
  const w2 = makeWorld();
  const ev2 = evMap({ [ACC]: E1 });
  const b2 = build(w2, { evidence: ev2, stamp: "evidence" });
  await pub(b2.release, await prep(b2.release, { v: "1" }));
  const trail = [];
  for (let i = 0; i < 4; i++) {
    ev2.set(ACC, { ...E1, m: i % 2 ? "a" : "b", total: i % 2 ? 1 : 9, instant: new Date(Date.parse(E1.instant) + (i + 1) * 60000).toISOString() });
    const l = unitOf(await mkRec(w2, b2, { verifyExact: true }).run({ bucket: REGION, requestedAsOf: EPOCH, dryRun: false }));
    const v = unitOf(await mkRec(w2, b2, { verifyExact: true }).run({ bucket: REGION, requestedAsOf: EPOCH, dryRun: true }));
    trail.push(l.state + "/" + v.state + "/" + liveRowRl(w2).payload.rows[0].refunds);
  }
  const c0 = w2.cycles.size; const wr2 = w2.writes();
  for (let i = 0; i < 3; i++) await mkRec(w2, b2, { verifyExact: true }).run({ bucket: REGION, requestedAsOf: EPOCH, dryRun: false });
  ok("F1 probeB shape: alternating manifest drifts with ADVANCING instants converge every pass (published + verify PASSES, the live content follows the evidence), and idle live passes add ZERO cycles / writes",
    trail.join(" ") === [RS.RV + "/" + RS.NR + "/9", RS.RV + "/" + RS.NR + "/1", RS.RV + "/" + RS.NR + "/9", RS.RV + "/" + RS.NR + "/1"].join(" ") && w2.cycles.size === c0 && w2.writes() === wr2);
}

{
  // F2 (P3-3). A 'lineage-advanced-before-write' deferral AFTER this prepare claimed its cycle finalizes the job-less
  // cycle, under the REAL finalize_sync_cycle state table (20260815; the same rows cycle-lifecycle.js documents).
  const faithfulFinalize = (w, counter) => async ({ cycleId }) => {
    counter.n += 1;
    const c = [...w.cycles.values()].find((x) => x.id === cycleId);
    if (!c) return { disposition: "not-found", cycle: null };
    if (["succeeded", "partial", "failed"].includes(c.status)) return { disposition: "already-terminal", cycle: { ...c } };
    if (c.status !== "running") return { disposition: "invalid-status", cycle: null };
    const rep = w.jobs.filter((j) => j.cycle_id === cycleId).map((j) => ({ derive_status: j.derive_status, save_status: j.save_status, fetch_status: "ready" }));
    if (!LC.cycleFullyDrained([], rep)) return { disposition: "open-work", cycle: { ...c } };
    const k = LC.computeCycleCounters([], rep);
    Object.assign(c, { status: LC.terminalCycleStatus(k), report_total: k.reportTotal, report_succeeded: k.reportSucceeded, report_failed: k.reportFailed });
    return { disposition: "finalized", cycle: { ...c } };
  };
  const foreignJob = (w, cycleId) => w.upsertReportJob({ cycleId, reportKey: RL, reportVersion: "returns-leakage/v3-route", accountId: ACC, connectionId: "primary", bucket: REGION, dependsOn: ["dep:x"], durableContentDeps: ["rl1:9"] });
  const logs = [];
  const w = makeWorld(); const fin = { n: 0 };
  let inject = true;
  const b = build(w, { evidence: evMap({ [ACC]: E1 }), depsOver: { log: (s) => logs.push(s), finalizeCycle: faithfulFinalize(w, fin), claimCycle: async (id) => { const c = await w.claimCycle(id); if (inject) { inject = false; await foreignJob(w, "cyc-foreign-1"); } return c; } } });
  const r = await prep(b.release, { v: "1" });
  const opened = [...w.cycles.values()][0];
  ok("F2 the claimed, job-less cycle is finalized EMPTY by the real state table ('succeeded', report_total 0 -- no work, nothing failed); the deferral is unchanged and no job / shadow / reconcile was written",
    r.ok === false && r.reason === "lineage-advanced-before-write" && SDR.statusFromRelease(r) === RS.DD && fin.n === 1 && w.cycles.size === 1 && opened.status === "succeeded" && opened.report_total === 0 && w.jobs.length === 1 && w.n.shadowWrite === 0 && w.n.reconcile === 0 && logs.some((s) => /empty cycle .* finalize after 'lineage-advanced-before-write': finalized/.test(s)));
  const r2 = await prep(b.release, { v: "1" });
  ok("F2 ... its bucket (nonced over the SUPERSEDED latest job) is never keyed again: the retry opens a fresh cycle over the new latest job and completes", r2.ok === true && r2.prepared === true && w.cycles.size === 2 && [...w.cycles.values()][1].bucket !== opened.bucket && [...w.cycles.values()][1].status === "succeeded");
  // A same-bucket TWIN that already put its job into THIS cycle (it passed its own check first): the RPC reports
  // 'open-work' and the cycle stays running for the twin -- the finalize never closes work underneath anyone.
  const wT = makeWorld(); const finT = { n: 0 };
  let injectT = true;
  const bT = build(wT, { evidence: evMap({ [ACC]: E1 }), depsOver: { finalizeCycle: faithfulFinalize(wT, finT), claimCycle: async (id) => { const c = await wT.claimCycle(id); if (injectT) { injectT = false; await foreignJob(wT, id); } return c; } } });
  const rT = await prep(bT.release, { v: "1" });
  const cycT = [...wT.cycles.values()][0];
  ok("F2 a twin's OPEN job in the same cycle -> finalize answers 'open-work': the cycle stays RUNNING with the twin's job untouched (still pending)", rT.reason === "lineage-advanced-before-write" && finT.n === 1 && cycT.status === "running" && wT.jobs.length === 1 && wT.jobs[0].cycle_id === cycT.id && wT.jobs[0].derive_status === "pending");
  // A cycle this prepare did NOT claim (another process claimed it; this one continued on the running cycle) is never
  // finalized by it.
  const wU = makeWorld(); const finU = { n: 0 };
  const bucketU = REL.routeCycleBucket({ region: REGION, routeId: "returns-v3", targetId: ACC, revisionId: "rev-1", nonce: "none" });
  await wU.openCycle({ bucket: bucketU, cycleDate: EPOCH }); await wU.claimCycle((await wU.getCycleByBucketDate(bucketU, EPOCH)).id);
  let injectU = true;
  const bU = build(wU, { evidence: evMap({ [ACC]: E1 }), depsOver: { finalizeCycle: faithfulFinalize(wU, finU), claimCycle: async (id) => { const c = await wU.claimCycle(id); if (injectU) { injectU = false; await foreignJob(wU, "cyc-foreign-u"); } return c; } } });
  const rU = await prep(bU.release, { v: "1" });
  ok("F2 a cycle this prepare did NOT claim (already running for another process) is NEVER finalized by it", rU.reason === "lineage-advanced-before-write" && finU.n === 0 && (await wU.getCycleByBucketDate(bucketU, EPOCH)).status === "running");
}

{
  // F3 (WP7 round-2 P1). The OPTIONAL publishGuard hook + resolveBundle's guard data.
  const GUARD = { inventoryAsOf: ASOF, fbaValidatedAt: "2026-09-24T09:00:00.000Z" };
  const traceDeps = (deps, trace) => {
    const outDeps = {};
    for (const [k, v] of Object.entries(deps)) {
      if (typeof v !== "function") { outDeps[k] = v; continue; }
      if (k === "publisherFor") outDeps[k] = (sig) => { const p = v(sig); return { preflight: async (...a) => { trace.push("preflight"); return p.preflight(...a); }, publish: async (...a) => { trace.push("publish"); return p.publish(...a); } }; };
      else outDeps[k] = (...a) => { trace.push(k); return v(...a); };
    }
    return outDeps;
  };
  const buildG = (w, { evidence = evMap({ [ACC]: E1 }), guardOf = () => GUARD, publishGuard = null, depsOver = {}, trace = null } = {}) => {
    const { runtime, calls, route } = makeRlRuntime(w, { evidence });
    const rt = { ...runtime, resolveBundle: async (unit, ctx) => { const bnd = await runtime.resolveBundle(unit, ctx); const g = guardOf(calls.resolve); return bnd.eligible && g !== undefined ? { ...bnd, guard: g } : bnd; }, ...(publishGuard ? { publishGuard } : {}) };
    let deps = releaseDeps(w, depsOver);
    if (trace) deps = traceDeps(deps, trace);
    return { release: REL.buildRoutePublicationRelease({ route, runtime: rt, deps }), runtime: rt, calls, route };
  };
  // (a) absent: no prepared.guard key and the SAME flow as the pinned suite above.
  const w0 = makeWorld(); const t0 = [];
  const b0 = buildG(w0, { guardOf: () => undefined, trace: t0 });
  const p0 = await prep(b0.release, { v: "1" }); const r0 = await pub(b0.release, p0);
  ok("F3 publishGuard + guard ABSENT: no prepared.guard key, the unchanged publish flow (preflight -> verifyLease -> publish) and a normal published result", p0.ok === true && !Object.prototype.hasOwnProperty.call(p0, "guard") && r0.disposition === "published" && t0.slice(t0.indexOf("preflight")).filter((k) => k === "preflight" || k === "verifyLease" || k === "publish").join(",") === "preflight,verifyLease,publish" && RC.ROUTE_RUNTIME_OPTIONAL_HOOKS.includes("publishGuard"));
  // (b) ordering + the guard data reaching the hook.
  const w1 = makeWorld(); const t1 = []; const seenArgs = [];
  const b1 = buildG(w1, { trace: t1, publishGuard: async (unit, p, ctx) => { t1.push("publishGuard"); seenArgs.push({ unit, p, ctx }); await Promise.resolve(); return null; } });
  const p1 = await prep(b1.release, { v: "1" });
  const i0 = t1.length;
  const r1 = await pub(b1.release, p1);
  const tail = t1.slice(i0); const gi = tail.indexOf("publishGuard");
  ok("F3 prepared.guard carries resolveBundle's guard (JSON round-trip); publishGuard receives (unit, prepared, { epoch, bucket, signal }) and a null verdict proceeds to the publish",
    JSON.stringify(p1.guard) === JSON.stringify(GUARD) && seenArgs.length === 1 && seenArgs[0].p === p1 && seenArgs[0].p.guard.fbaValidatedAt === GUARD.fbaValidatedAt && seenArgs[0].unit.targetId === ACC && seenArgs[0].ctx.epoch === EPOCH && seenArgs[0].ctx.bucket === REGION && "signal" in seenArgs[0].ctx && r1.disposition === "published");
  ok("F3 ORDERING: publishGuard runs AFTER verifyLease and IMMEDIATELY before publisher.publish -- no other collaborator call in between (inside the control lease)", gi > 0 && tail[gi - 1] === "verifyLease" && tail[gi + 1] === "publish" && tail.indexOf("preflight") < tail.indexOf("verifyLease"));
  // (c) typed verdicts: ZERO CAS, publisher.publish never called.
  const verdictCase = async (publishGuard) => {
    const w = makeWorld();
    const b = buildG(w, { publishGuard });
    const p = await prep(b.release, { v: "1" });
    const cas = w.n.liveCas; const pubs = w.n.publish; const wr = w.writes();
    const r = await pub(b.release, p);
    return { r, zero: w.n.liveCas === cas && w.n.publish === pubs && w.writes() === wr && liveRowRl(w) === null };
  };
  const vNL = await verdictCase(async () => ({ state: "NEWER_LIVE", reason: "superseded-newer-live:served-newer-inventory" }));
  const vNL2 = await verdictCase(async () => ({ state: "NEWER_LIVE", reason: "paid-row-newer" }));
  ok("F3 a NEWER_LIVE verdict -> the typed NEWER_LIVE result EXACTLY like the publish newer-live path (stage 'publish', status NEWER_LIVE -> DEFERRED_DEPENDENCY, classified superseded), ZERO CAS, publisher.publish never called, never published / already-current",
    vNL.zero && vNL.r.ok === false && vNL.r.stage === "publish" && vNL.r.status === "NEWER_LIVE" && vNL.r.reason === "superseded-newer-live:served-newer-inventory" && vNL.r.alreadyCurrent === undefined && SDR.statusFromRelease(vNL.r) === RS.DD && CLS.classifyDeferral(vNL.r.reason).cls === CLS.CLASSES.SUPERSEDED_NEWER_LIVE
    && vNL2.zero && vNL2.r.status === "NEWER_LIVE" && vNL2.r.reason === "publish-newer-live:paid-row-newer" && CLS.classifyDeferral(vNL2.r.reason).cls === CLS.CLASSES.SUPERSEDED_NEWER_LIVE);
  const vDD = await verdictCase(async () => ({ state: "DEFERRED_DEPENDENCY", reason: "awd-pending" }));
  const vDP = await verdictCase(async () => ({ state: "DEFERRED_PROVENANCE", reason: "oli-coverage-short" }));
  const vBad = await verdictCase(async () => ({ state: "PUBLISHED", reason: "x" }));
  const vThrow = await verdictCase(async () => { throw new Error("guard read failed"); });
  ok("F3 DEFERRED_DEPENDENCY / DEFERRED_PROVENANCE verdicts -> typed retryable deferrals with the route's reason; a malformed verdict -> 'publish-guard-malformed'; a THROW -> 'publish-guard-threw:<msg>' (fail closed) -- all with ZERO CAS",
    vDD.zero && vDD.r.reason === "awd-pending" && SDR.statusFromRelease(vDD.r) === RS.DD && vDP.zero && vDP.r.reason === "oli-coverage-short" && vDP.r.status === "DEFERRED_PROVENANCE" && SDR.statusFromRelease(vDP.r) === RS.DD
    && vBad.zero && vBad.r.reason === "publish-guard-malformed" && vThrow.zero && vThrow.r.reason === "publish-guard-threw:guard read failed" && SDR.statusFromRelease(vThrow.r) === RS.DD);
  // (d) b1 / b2 guard equality + a malformed guard.
  const wD = makeWorld();
  const bD = buildG(wD, { guardOf: (n) => ({ inventoryAsOf: ASOF, fetch: n }) });
  const pD = await prep(bD.release, { v: "1" });
  const wI = makeWorld();
  const bI = buildG(wI, { guardOf: () => "not-an-object" });
  const pI = await prep(bI.release, { v: "1" });
  ok("F3 a guard that DIFFERS between b1 and b2 defers 'revision-advanced-before-write' with ZERO writes; a non-object guard is a typed 'guard-invalid' derive failure (zero writes)", pD.ok === false && pD.reason === "revision-advanced-before-write" && wD.writes() === 0 && pI.ok === false && pI.reason === "guard-invalid" && wI.writes() === 0);
  // (e) a RESUMED publish still runs publishGuard (crash after finalize, before publish -> resume -> publish).
  const wR = makeWorld(); const calledR = [];
  const bR = buildG(wR, { publishGuard: async (unit, p) => { calledR.push({ resumed: p.resumed, guard: p.guard }); return calledR.length === 1 ? { state: "NEWER_LIVE", reason: "paid-newer" } : null; } });
  const pR1 = await prep(bR.release, { v: "1" });
  const pR2 = await prep(bR.release, { v: "1" });
  const rR2 = await pub(bR.release, pR2);
  const rR3 = await pub(bR.release, await prep(bR.release, { v: "1" }));
  ok("F3 a RESUMED prepare carries the guard and its publish STILL calls publishGuard (a NEWER_LIVE verdict there -> zero CAS; the next resumed publish proceeds and publishes)",
    pR1.ok && pR2.resumed === true && JSON.stringify(pR2.guard) === JSON.stringify(GUARD) && rR2.status === "NEWER_LIVE" && calledR.length === 2 && calledR[0].resumed === true && JSON.stringify(calledR[0].guard) === JSON.stringify(GUARD) && calledR[1].resumed === true && rR3.disposition === "published");
  // (f) the evidence-stamp already-current prepare also carries the guard (its publish may fall through to the CAS).
  const wE = makeWorld();
  const { runtime: rtE, route: routeE } = makeRlRuntime(wE, { evidence: evMap({ [ACC]: E1 }), stamp: "evidence" });
  const bE = REL.buildRoutePublicationRelease({ route: routeE, runtime: { ...rtE, resolveBundle: async (u, c) => ({ ...(await rtE.resolveBundle(u, c)), guard: GUARD }) }, deps: releaseDeps(wE) });
  const pE0 = await bE.prepareForUnit({ unit: rlUnit(), revision: rlRevision("1"), epoch: EPOCH, region: REGION, bucket: REGION, accountId: ACC });
  await pub(bE, pE0);
  wE.snaps.delete("scheduler-v2/" + RL + "|" + ACC + "|" + pE0.shadowParamsHash); // the resume path cannot apply
  const pE = await bE.prepareForUnit({ unit: rlUnit(), revision: rlRevision("1"), epoch: EPOCH, region: REGION, bucket: REGION, accountId: ACC });
  ok("F3 the evidence-stamp ALREADY-CURRENT prepare (live at the instant, proven) carries prepared.guard too", pE.ok === true && pE.alreadyCurrent === true && pE.resumed === false && JSON.stringify(pE.guard) === JSON.stringify(GUARD));
  ok("F3 publishGuardResult (exported for route implementers) is the pure verdict mapping", REL.publishGuardResult({ state: "NEWER_LIVE" }).reason === "publish-newer-live" && REL.publishGuardResult(null).reason === "publish-guard-malformed" && JSON.stringify(REL.PUBLISH_GUARD_STATES) === JSON.stringify(["NEWER_LIVE", "DEFERRED_DEPENDENCY", "DEFERRED_PROVENANCE"]));
}

// =====================================================================================================================
// G. WP13 verifier P2-1: the OPT-IN inter-window LEASE FAIRNESS pause of the shared two-phase core
// =====================================================================================================================
{
  // Two stale accounts, ONE unit per control window (chunkMaxTargets 1) -> two windows. The pause runs EXACTLY between a
  // PROVEN close and the next open, never inside a window, never after the last; default 0 -> no sleep call at all.
  const runWith = async ({ pause = undefined, outOfTimeAfterFirstClose = false } = {}) => {
    const w = makeWorld();
    const b = build(w, { evidence: evMap({ [ACC]: E1, [ACC2]: { ...E1 } }) });
    const trace = [];
    let closes = 0;
    const rec = SDR.buildSavedDataReconciler({
      resolveOrg: async () => ({ organizationFingerprint: "org-fp", connectionId: "primary" }),
      bucketAccounts: async () => [{ accountId: ACC }, { accountId: ACC2 }],
      adapter: REL.buildRouteReconcileAdapter({ route: b.route, runtime: { ...b.runtime, derive: async (bundle, ctx) => ({ payload: returnsPayload(ctx.unit.liveAccountId, bundle.e.asOf, bundle.e.total), latestDataDate: bundle.e.asOf }) }, bucket: REGION, liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, readLatestJob: w.readLatestJob }),
      readLatestReportJob: ({ reportKey, accountId }) => w.readLatestJob(reportKey, accountId),
      readShadowSnapshot: (a) => w.readSnapshot(a), readLiveSnapshot: (a) => w.readSnapshot(a), loadStoragePayload: w.loadStoragePayload,
      verifyLiveReadback: w.readbackLive, liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, computeHash: paramsHashFor, reportDerivations: REPORT_DERIVATIONS,
      runPrepareForUnit: (a) => b.release.prepareForUnit(a), runPublishForUnit: (a) => { trace.push("publish:" + a.accountId); return b.release.publishForUnit(a); },
      openControls: async () => { trace.push("open"); return { ok: true }; },
      closeControls: async () => { trace.push("close"); closes += 1; return { ok: true }; },
      outOfTime: () => outOfTimeAfterFirstClose && closes >= 1,
      reportKeys: [RL], family: "returns-v3", chunkMaxTargets: 1,
      ...(pause === undefined ? {} : { interWindowPauseMs: pause }),
      sleep: async (ms) => { trace.push("sleep:" + ms); },
    });
    const s = await rec.run({ bucket: REGION, requestedAsOf: EPOCH, mode: "periodic", dryRun: false });
    return { s, trace };
  };
  const on = await runWith({ pause: 30000 });
  ok("G1 interWindowPauseMs 30000: open -> publish -> close -> SLEEP 30000 -> open -> publish -> close (the pause sits exactly between a proven close and the next open; none after the last window); both units publish",
    JSON.stringify(on.trace.filter((x) => !x.startsWith("publish:")).concat([])) === JSON.stringify(["open", "close", "sleep:30000", "open", "close"])
    && on.trace.filter((x) => x.startsWith("publish:")).length === 2 && on.trace.indexOf("sleep:30000") > on.trace.indexOf("close") && on.s.counts.targetsPublished === 2);
  const off = await runWith({});
  ok("G2 default (no interWindowPauseMs) -> NO sleep call at all (byte-identical window sequence for every existing caller)", !off.trace.some((x) => x.startsWith("sleep")) && JSON.stringify(off.trace.filter((x) => !x.startsWith("publish:"))) === JSON.stringify(["open", "close", "open", "close"]) && off.s.counts.targetsPublished === 2);
  const late = await runWith({ pause: 30000, outOfTimeAfterFirstClose: true });
  ok("G3 the pause is SKIPPED once the start cutoff is reached (the loop head then defers the rest 'deadline-cleanup-reserved', exactly as without a pause)",
    !late.trace.some((x) => x.startsWith("sleep")) && JSON.stringify(late.trace.filter((x) => !x.startsWith("publish:"))) === JSON.stringify(["open", "close"]) && late.s.counts.targetsPublished === 1);
  const throwsFor = (v) => { try { SDR.buildSavedDataReconciler({ resolveOrg: async () => ({}), bucketAccounts: async () => [], adapter: { readScopeEvidence: async () => ({}), computeAccountRevision: () => ({}) }, readLatestReportJob: async () => null, readShadowSnapshot: async () => null, readLiveSnapshot: async () => null, loadStoragePayload: async () => null, verifyLiveReadback: async () => ({}), liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, computeHash: paramsHashFor, reportDerivations: REPORT_DERIVATIONS, runPrepareForUnit: async () => ({}), runPublishForUnit: async () => ({}), interWindowPauseMs: v }); return false; } catch (e) { return /interWindowPauseMs must be an integer/.test(String(e && e.message)); } };
  ok("G4 a malformed interWindowPauseMs fails closed at BUILD time (-1, 1.5, '30000', NaN, > 120000)", [-1, 1.5, "30000", NaN, 120001].every(throwsFor));
  ok("G5 the route CLI's pause constant is >= 2x the 15 s CONTROL_LEASE_HELD retry interval (a waiter always gets an attempt while the lease is free)", REL.ROUTE_CLI_INTER_WINDOW_PAUSE_MS === 30000);
}

// =====================================================================================================================
// G6. WP14 final review P2-1: a DB WRITER-FENCE refusal of the fenced CAS is TYPED end to end (never a silent retry)
// =====================================================================================================================
{
  const CLS = await import("../lib/server/recovery/classify.js");
  const runWith = async (makeErr) => {
    const w = makeWorld();
    const { release } = build(w, { evidence: evMap({ [ACC]: E1 }) });
    const p = await prep(release, { v: "1" });
    const liveBefore = JSON.stringify(liveRowRl(w));
    w.liveCas = async () => { throw makeErr(); };
    const r = await pub(release, p);
    return { r, w, liveBefore };
  };
  // The EXACT supabase.js request() error shape for a fence refusal (message + PostgREST code).
  const fenceErr = () => Object.assign(new Error("Supabase request failed (400): REPORT_WRITER_FENCED:returns-leakage"), { status: 400, code: "RWF01" });
  const f = await runWith(fenceErr);
  const v = CLS.classifyReason(RS.FP, f.r.reason, { routeKind: "route-cli", routeId: "returns-v3" });
  ok("G6 a fenced-CAS refusal by the writer fence (RWF01) -> the release fails TYPED 'publish-publish-failed:REPORT_WRITER_FENCED:<publisherKey>' (FAILED_PUBLISH), the live row untouched; classify -> INTEGRITY + alert 'writer-fenced'",
    f.r.ok === false && f.r.stage === "publish" && f.r.reason === "publish-publish-failed:REPORT_WRITER_FENCED:" + RL && JSON.stringify(liveRowRl(f.w)) === f.liveBefore
    && v.cls === CLS.CLASSES.INTEGRITY && v.alert === "writer-fenced");
  const o = await runWith(() => Object.assign(new Error("Supabase request failed (500): boom"), { status: 500, code: "XX000" }));
  ok("G6 ... while ANY other CAS error is byte-identical to before: reason exactly 'publish-publish-failed' (no writer-fence suffix)", o.r.ok === false && o.r.reason === "publish-publish-failed");
}

// =====================================================================================================================
// G7. WP14 final review: the PUBLISH-TIME live read-back is load-bearing (a landed publish whose read-back fails is a
//     typed hard failure, never 'published') -- formerly unpinned (removing it survived every suite).
// =====================================================================================================================
{
  const w = makeWorld();
  const { release } = build(w, { evidence: evMap({ [ACC]: E1 }), depsOver: { readbackLive: async () => ({ ok: false, reason: "identity-hash" }) } });
  const p = await prep(release, { v: "1" });
  const r = await pub(release, p);
  ok("G7 the fenced publish LANDED but the publisher-grade live read-back failed -> hardFail stage 'readback' reason 'live-readback-failed:identity-hash' (FAILED_READBACK), never counted published",
    p.ok === true && w.n.liveWrite === 1 && r.ok === false && r.stage === "readback" && r.reason === "live-readback-failed:identity-hash" && SDR.statusFromRelease(r) === RS.FR);
}

ok("Z zero network across the whole suite (zero DataDoe, zero Supabase)", net.calls.length === 0);
out(`route-publication-release: ${passed} passed`);
