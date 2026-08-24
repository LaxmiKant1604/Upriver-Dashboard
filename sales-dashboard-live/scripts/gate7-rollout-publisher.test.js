// Gate-7 -- durable ACCOUNT ROLLOUT + reviewed SHADOW-TO-LIVE PUBLISHER regressions.
//
// Proves, with ZERO real DataDoe/Supabase (every backend injected; the wrapper tests stub global fetch):
//   1.  DEFAULT locked/empty controls => a real scheduled invocation performs ZERO discovery / cycle /
//       export / publish work (drained no-op before any I/O);
//   2.  EVERY dispatch (scheduled AND manual) with READY reports but NO trusted rollout loader REFUSES to
//       run (fail closed) -- a manual production run can never bypass the durable rollout; manualReportKeys
//       selects REPORTS only, and the BUILD-TIME trusted canary composition (exact ids, validated against
//       fresh primary discovery) is the ONLY way to scope an isolated canary -- no per-run bypass exists;
//   3.  a rollout read/schema failure selects ZERO accounts BEFORE discovery;
//   4.  the DEFAULT durable state (no rows, all_primary=false) selects ZERO accounts BEFORE discovery;
//   5.  an exact-id allowlist selects ONLY the enabled account out of a 30-account discovery -- the other
//       29 accounts (and the other bucket) get ZERO writes;
//   6.  dd-secondary can NEVER enter scheduled scope -- rejected as a discovered account AND as an
//       allowlist row (even when the secondary connection is configured and the row classifies ACTIVE);
//   7.  stale/unknown allowlist rows match nothing and spend nothing;
//   8.  the all-primary durable switch auto-includes a NEWLY CONNECTED primary account with no code change;
//   9.  a caller of the composed runtime's run() can NOT override the rollout loader / discovery / control
//       catalog per run (RUN_OPERATIONAL_ARGS is pinned);
//   10. the Supabase wrappers are typed + fail-closed (ok / schema-missing / read-failed) and the CAS
//       publish primitive is insert-if-absent + strictly-older guarded PATCH on the ONE natural-key row;
//   11. the publisher is DISABLED BY DEFAULT (code lock) and publishes ONLY when code readiness + durable
//       report enable + durable account enable (resolved against REAL memoized fresh discovery -- an
//       undiscovered/stale or dd-secondary account can never publish, even under all_primary) + explicit
//       publish approval ALL hold; the trusted composition's publish(reportKey, accountId) caller can
//       inject NOTHING (no code readiness, no collaborator);
//   12. publication binds to the EXACT successful job snapshot: a VALIDATED derive+save-succeeded job in a
//       terminal cycle names its snapshot_params_hash, the shadow row is loaded by that exact natural
//       identity and must echo the same hash (job A can never authorize snapshot B; blank/missing/
//       mismatched hashes never publish); storage-backed payloads hydrate through the trusted loader and a
//       missing/unreadable object fails CLOSED; publish exactly once; replay idempotent (already-current);
//       a newer live row wins byte-identically (newer-live); a CAS replacement CLEARS payload_storage_path;
//       failed/blocked/running/invalid/unavailable/stale snapshots NEVER touch live (LKG preserved);
//       unaudited/blank approval schema rows fail the schema contract (EM1/EM2);
//   13. all 13 scheduler->live report_key/reportVersion/params mappings are STATICALLY PINNED against the
//       real live route truths (api/datadoe.js literals + the insight modules' exported constants);
//   14. STRUCTURAL isolation: no api/ route (browser-reachable surface) imports the publisher or the
//       rollout module, and the dispatcher never auto-publishes. (Post-Gate-7b the v2 readiness allowlist is
//       the 13 approved keys; the durable account rollout + report controls + publish approval still gate
//       every dispatch/publish.)
//
// 7-bit ASCII, LF, no top-level await; dynamic imports after a dummy Supabase env.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = process.env[SB_KEY_ENV] || ["test", "svc", "role", "key"].join("-");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const group = (label) => tests.push({ marker: label });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let resolveRolloutAccounts;
let runSchedulerV2Shadow;
let buildSchedulerV2Runtime, buildSchedulerV2CanaryRuntime, RUN_OPERATIONAL_ARGS;
let SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, PUBLISH_DISPOSITIONS, publishSchedulerV2Snapshot;
let buildSchedulerV2Publisher;
let auditSchemaContract;
let SCHEDULER_V2_READY_REPORT_KEYS;
let CONTROLLED_REPORT_KEYS;
let SHADOW_PLANNED_REPORT_KEYS;
let paramsHashFor;
let getSchedulerAccountRollout, getSchedulerPublishApproval, publishLiveSnapshotIfNewer;
let insightConsts; // { key: [REPORT_KEY const, VERSION const] } from lib/server/reports/*.js

const ASOF = "2025-08-10";
const dash = (...p) => p.join("-");
const CONNS = [
  { id: "primary", apiKey: dash("org", "primary"), accountPrefix: "" },
  { id: "secondary", apiKey: dash("org", "secondary"), accountPrefix: dash("dd", "secondary") + ":" },
];
const SEC_ID = dash("dd", "secondary") + ":IN1";

// ---- injected dispatcher backends (mirrors the proven sync-dispatch harness) ---------------------

function rowsFor(job) {
  const rk = job.requestKey || "";
  if (rk.endsWith(":catalog")) return [{ child_asin: "A", parent_asin: "P", product_name: "P", product_brand: "Acme" }];
  return [{ x: 1 }];
}

function makeDataDoe() {
  const create = {};
  return {
    totalCreates: () => Object.values(create).reduce((a, b) => a + b, 0),
    async create(job) { create[job.requestHash] = (create[job.requestHash] || 0) + 1; return { exportId: "e_" + job.requestHash }; },
    async poll() {},
    async download(job) { return rowsFor(job); },
  };
}

function makeStore() {
  const cycles = new Map(); const jobsByCycle = new Map(); const ownersByCycle = new Map();
  const cache = new Map(); const reportJobs = new Map(); const snapshots = new Map(); let seq = 0;
  const findCycle = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  const ownerRows = (cid) => [...((ownersByCycle.get(cid) && ownersByCycle.get(cid).values()) || [])];
  const rkey = (rk, a) => rk + "|" + a;
  return {
    _owners: (cid) => ownerRows(cid).map((m) => ({ ...m })),
    openCycle({ bucket, cycleDate }) { const k = bucket + "|" + cycleDate; if (!cycles.has(k)) { const id = "cyc_" + (seq += 1); cycles.set(k, { id, bucket, status: "pending" }); jobsByCycle.set(id, new Map()); } return cycles.get(k).id; },
    claimCycle(id) { const c = findCycle(id); if (c && c.status === "pending") { c.status = "running"; return true; } return false; },
    getCycle(id) { return findCycle(id); },
    upsertSourceJob(job) { const m = jobsByCycle.get(job.cycleId); if (m.has(job.requestHash)) return; m.set(job.requestHash, { request_hash: job.requestHash, request_key: job.requestKey, source_id: job.sourceId, source_key: job.sourceKey, connection_id: job.connectionId, organization_fingerprint: job.organizationFingerprint, account_scope_hash: job.accountScopeHash, fetch_status: "pending", attempted_at: null, create_export_count: 0, export_id: null, terminal: false, row_count: null }); },
    listSourceJobs(id) { return [...((jobsByCycle.get(id) && jobsByCycle.get(id).values()) || [])].map((j) => ({ ...j })); },
    upsertSourceJobOwners(ms) { for (const m of ms || []) { if (!ownersByCycle.has(m.cycleId)) ownersByCycle.set(m.cycleId, new Map()); ownersByCycle.get(m.cycleId).set(m.ownerId + "|" + m.requestHash, { cycle_id: m.cycleId, request_hash: m.requestHash, owner_id: m.ownerId, request_key: m.requestKey, report_key: m.reportKey, account_id: m.accountId, connection_id: m.connectionId, organization_fingerprint: m.organizationFingerprint, account_scope_hash: m.accountScopeHash, owner_status: "active", error_code: null }); } },
    listSourceJobOwners(cid, ids) { const s = new Set(ids || []); return ownerRows(cid).filter((m) => s.has(m.owner_id)).map((m) => ({ ...m })); },
    listSourceJobsForOwners(cid, ids) { const s = new Set(ids || []); const hs = new Set(ownerRows(cid).filter((m) => s.has(m.owner_id) && m.owner_status !== "stale").map((m) => m.request_hash)); return this.listSourceJobs(cid).filter((j) => hs.has(j.request_hash)); },
    recordSourceOwnerStale({ cycleId, requestHash, ownerId, code }) { const m = ownersByCycle.get(cycleId) && ownersByCycle.get(cycleId).get(ownerId + "|" + requestHash); if (m) { m.owner_status = "stale"; m.error_code = code || "STALE_PLAN"; } },
    claimExportAttempt(id, h) { const j = jobsByCycle.get(id) && jobsByCycle.get(id).get(h); if (j && j.attempted_at === null) { j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted"; return true; } return false; },
    recordExportCreated({ cycleId, requestHash, exportId }) { jobsByCycle.get(cycleId).get(requestHash).export_id = exportId; },
    loadSourceRows(h) { const e = cache.get(h); return e ? { rows: e.rows } : null; },
    saveSourceRows({ job, rows }) { const h = job.request_hash != null ? job.request_hash : job.requestHash; cache.set(h, { rows: [...rows] }); return "p/" + h; },
    recordSourceSuccess({ cycleId, requestHash, exportId, rowCount, cacheObjectPath }) { Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "succeeded", export_id: exportId, row_count: rowCount, cache_object_path: cacheObjectPath }); },
    recordSourceFailure({ cycleId, requestHash, stage, code, terminal }) { Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "failed", error_stage: stage, error_code: code, terminal: !!terminal }); },
    updateCycleCounts() {},
    finalizeCycle({ cycleId }) {
      const c = findCycle(cycleId);
      if (!c) return { disposition: "not-found", cycle: null };
      if (["succeeded", "partial", "failed"].includes(c.status)) return { disposition: "already-terminal", cycle: { ...c } };
      const open = this.listSourceJobs(cycleId).some((j) => ["pending", "attempted"].includes(j.fetch_status));
      if (open) return { disposition: "open-work", cycle: null };
      c.status = "succeeded"; c.finished_at = "t";
      return { disposition: "finalized", cycle: { ...c } };
    },
    seedSnapshot(rk, a, payload) { snapshots.set(rkey(rk, a), { payload }); },
    report(rk, a) { return reportJobs.get(rkey(rk, a)); },
    listReportJobs() { return [...reportJobs.values()].map((j) => ({ ...j })); },
    upsertReportJob({ reportKey, accountId, connectionId, bucket, reportVersion, dependsOn }) { const k = rkey(reportKey, accountId); if (reportJobs.has(k)) return; reportJobs.set(k, { report_key: reportKey, account_id: accountId, connection_id: connectionId, bucket, report_version: reportVersion, depends_on: dependsOn || [], fetch_status: "pending", derive_status: "pending", save_status: "pending", validated: false }); },
    claimReportDerive(_c, rk, a) { const j = reportJobs.get(rkey(rk, a)); if (j && j.derive_status === "pending") { j.derive_status = "running"; return true; } return false; },
    recordReportBlocked({ reportKey, accountId }) { Object.assign(reportJobs.get(rkey(reportKey, accountId)), { fetch_status: "blocked", derive_status: "skipped", save_status: "skipped" }); },
    recordReportFailure({ reportKey, accountId, stage, code }) { Object.assign(reportJobs.get(rkey(reportKey, accountId)), { derive_status: stage === "save" ? "succeeded" : "failed", save_status: stage === "save" ? "failed" : "pending", error_code: code }); },
    recordReportSuccess({ reportKey, accountId, latestDataDate }) { Object.assign(reportJobs.get(rkey(reportKey, accountId)), { fetch_status: "ready", derive_status: "succeeded", save_status: "succeeded", validated: true, latest_data_date: latestDataDate ?? null }); },
  };
}

function makeSaver() {
  const saved = new Map();
  const saver = async ({ reportKey, accountId, payload }) => { saver.calls += 1; saved.set(reportKey + "|" + accountId, payload); return { paramsHash: "ph" }; };
  saver.calls = 0; saver.saved = saved;
  saver.savedKeys = () => [...saved.keys()];
  return saver;
}

const mkCatalog = (ready = [], enabled = ready) => () => [...new Set([...ready, ...enabled])].map((rk) => ({ reportKey: rk, ready: ready.includes(rk), scheduleEnabled: enabled.includes(rk) }));

const US_ACCTS = [{ accountId: "A1", country: "US", currency: "USD", name: "Acct One" }];
const IN1 = { accountId: "IN1", country: "IN", currency: "INR", name: "India One" };
const IN2 = { accountId: "IN2", country: "IN", currency: "INR", name: "India Two" };
const SEC_ROW = { accountId: SEC_ID, country: "IN", currency: "INR", name: "India One (stale secondary)" };
const US_MANY = Array.from({ length: 28 }, (_, i) => ({ accountId: "US" + (i + 1), country: "US", currency: "USD", name: "US " + (i + 1) }));
const BIG_DIRECTORY = [...US_MANY, IN1, SEC_ROW]; // 30 rows: 28 US primary + IN1 primary + 1 dd-secondary

// Dispatch helper: counts discovery + cycle opens so a drained no-op can PROVE zero I/O happened.
function dispatch(over = {}) {
  const store = over.store || makeStore();
  const counts = { discover: 0, opens: 0 };
  const origOpen = store.openCycle.bind(store);
  store.openCycle = (args) => { counts.opens += 1; return origOpen(args); };
  const dd = over.dataDoe || makeDataDoe();
  const saver = over.saver || makeSaver();
  const accounts = over.accounts || US_ACCTS;
  const args = {
    bucket: over.bucket || "us",
    cycleDate: over.cycleDate || "2026-08-16",
    asOf: "asOf" in over ? over.asOf : ASOF,
    asOfFor: "asOfFor" in over ? over.asOfFor : (() => ASOF),
    connections: over.connections || CONNS,
    discoverAccounts: async () => { counts.discover += 1; return accounts; },
    store, dataDoe: dd, saveSnapshot: saver,
    controlCatalog: over.controlCatalog,
    settings: over.settings || [],
    manualReportKeys: over.manualReportKeys,
    maxJobs: over.maxJobs, deadlineMs: over.deadlineMs,
  };
  if ("loadAccountRollout" in over) args.loadAccountRollout = over.loadAccountRollout;
  return { store, dd, saver, counts, promise: runSchedulerV2Shadow(args) };
}

const okAllowlist = (ids) => async () => ({ read: "ok", allPrimary: false, enabledAccountIds: ids });
const okAllPrimary = async () => ({ read: "ok", allPrimary: true, enabledAccountIds: [] });
const zeroDefaultState = async () => ({ read: "ok", allPrimary: false, enabledAccountIds: [] });

const assertZeroWork = (r, dd, saver, counts, { discovered = false } = {}) => {
  assert.equal(r.drained, true, "drained no-op");
  assert.equal(r.cycleId, null, "no cycle id");
  assert.equal(r.spent, 0, "zero budget spent");
  assert.equal(counts.opens, 0, "zero cycles opened");
  assert.equal(dd.totalCreates(), 0, "zero DataDoe exports created");
  assert.equal(saver.calls, 0, "zero shadow snapshots saved");
  assert.equal(counts.discover, discovered ? 1 : 0, discovered ? "discovery ran once (read-only)" : "zero discovery calls");
};

// ---- publisher fixtures --------------------------------------------------------------------------

const SHADOW_TS = "2026-08-14T10:00:00.000Z";
// The shadow row's params EXACTLY as makeShadowSnapshotSaver saved them: { reportVersion, accountId, ...context }.
const SHADOW_PARAMS = { reportVersion: dash("sales", "movers") + "/v2d-1", accountId: "IN1", to: "2026-08-14" };
// The GENUINE snapshot identity: paramsHashFor(SHADOW_PARAMS.reportVersion, SHADOW_PARAMS). Recomputed in
// loadModules() from the SAME hasher the saver + the publisher's provenance check use, so a fixture snapshot
// really was produced by its own params (never a made-up hash the provenance check would reject).
let JOB_HASH;
function mkPubDeps(over = {}) {
  const calls = { settings: 0, rollout: 0, discover: 0, approval: 0, job: 0, shadow: 0, storage: 0, publish: [] };
  const shadow = {
    params_hash: JOB_HASH,
    params: { ...SHADOW_PARAMS },
    // A payload the REAL sales-movers derivation validator accepts as an AVAILABLE result.
    payload: {
      accountId: "IN1", asOf: "2026-08-14", dataUnavailable: false, rows: [], catalogBrands: [],
      salesLatestDate: "2026-08-13", currencies: ["INR"], buyBoxEvaluated: false,
      inventoryAvailable: true, inventorySnapshotDate: "2026-08-13", windows: { recent: {}, prior: {} },
    },
    payload_storage_path: null,
    source_refreshed_at: SHADOW_TS,
  };
  const seen = { shadowKey: null, shadowAcct: null, shadowHash: null, storagePath: null };
  const deps = {
    codeReadyKeys: [dash("sales", "movers")],
    getReportSyncSettings: async () => { calls.settings += 1; return [{ report_key: dash("sales", "movers"), schedule_enabled: true }]; },
    loadAccountRollout: async () => { calls.rollout += 1; return { read: "ok", allPrimary: false, enabledAccountIds: ["IN1"] }; },
    // REAL-shaped fresh discovery: IN1 is a currently discovered active primary account.
    discoverPrimaryAccounts: async () => { calls.discover += 1; return "discovered" in over ? over.discovered : [IN1, ...US_ACCTS]; },
    getPublishApproval: async () => { calls.approval += 1; return { read: "ok", approved: true }; },
    getLatestReportJob: async () => {
      calls.job += 1;
      return "job" in over ? over.job : {
        cycle_id: "cyc-1", validated: true, snapshot_params_hash: JOB_HASH,
        derive_status: "succeeded", save_status: "succeeded", cycle_status: "succeeded",
      };
    },
    getShadowSnapshot: async (k, a, h) => { calls.shadow += 1; seen.shadowKey = k; seen.shadowAcct = a; seen.shadowHash = h; return "shadow" in over ? over.shadow : shadow; },
    loadStoragePayload: async (p) => {
      calls.storage += 1; seen.storagePath = p;
      if (over.storageThrows) throw new Error("storage transport boom");
      return "storagePayload" in over ? over.storagePayload : null;
    },
    publishLive: async (args) => {
      calls.publish.push(args);
      if (over.publishThrows) throw new Error("transport boom");
      return over.publishRes || { outcome: "inserted", liveRefreshedAt: args.sourceRefreshedAt };
    },
    ...(over.deps || {}),
  };
  return { deps, calls, shadow, seen };
}
const SM = dash("sales", "movers");
const observedDispositions = new Set();
async function pub(over = {}, args = { reportKey: SM, accountId: "IN1" }) {
  const h = mkPubDeps(over);
  const res = await publishSchedulerV2Snapshot(h.deps, args);
  observedDispositions.add(res.disposition);
  return { ...h, res };
}

// ---- fetch stubbing for the real Supabase wrappers ----------------------------------------------

function stubFetch(handler) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const rec = { url: String(url), method: opts.method || "GET", headers: opts.headers || {}, body: opts.body === undefined ? undefined : JSON.parse(opts.body) };
    calls.push(rec);
    const res = handler(rec, calls.length) || {};
    return { ok: res.ok !== false, status: res.status || 200, json: async () => (res.json === undefined ? null : res.json) };
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

// =================================================================================================
group("A. pure rollout resolver (fail-closed selection semantics)");

test("(A1) the DEFAULT durable state and every non-ok read select ZERO accounts", () => {
  const disc = [IN1, { accountId: "IN2", country: "IN" }];
  for (const [state, reason] of [
    [{ read: "ok", allPrimary: false, enabledAccountIds: [] }, "allowlist-empty"],
    [{ read: "schema-missing", allPrimary: false, enabledAccountIds: [] }, "rollout-read-not-ok"],
    [{ read: "read-failed", allPrimary: true, enabledAccountIds: ["IN1"] }, "rollout-read-not-ok"],
    [null, "rollout-read-not-ok"],
    ["ok", "rollout-read-not-ok"],
    [{}, "rollout-read-not-ok"],
  ]) {
    const r = resolveRolloutAccounts(state, disc);
    assert.deepEqual(r.accounts, [], "zero accounts for " + reason);
    assert.equal(r.reason, reason);
  }
});

test("(A2) allowlist mode selects by EXACT CANONICAL public id only; stale rows match nothing and are reported", () => {
  const disc = [{ accountId: "US1", country: "US" }, IN1, IN2];
  const r = resolveRolloutAccounts({ read: "ok", allPrimary: false, enabledAccountIds: ["IN1", "GONE9"] }, disc);
  assert.deepEqual(r.selectedIds, ["IN1"], "exact CANONICAL id match only");
  assert.deepEqual(r.accounts, [IN1], "discovery order preserved; original row object kept");
  assert.deepEqual(r.staleIds, ["GONE9"], "unknown allowlist row reported stale, selects nothing");
  assert.equal(r.reason, "allowlist");
  // A partial/prefix/case id can never match.
  const r2 = resolveRolloutAccounts({ read: "ok", allPrimary: false, enabledAccountIds: ["IN", "in1", "IN11"] }, disc);
  assert.deepEqual(r2.accounts, [], "no wildcard, no prefix, no case-folding");
});

test("(A2b) a NONCANONICAL durable id fails closed -- never silently trimmed into another account", () => {
  const disc = [{ accountId: "US1", country: "US" }, IN1, IN2];
  // " IN1 " is NOT trimmed-and-matched to IN1; a single noncanonical id makes the whole allowlist untrusted.
  for (const bad of [[" IN1 "], ["IN1 "], [" IN1"], ["\tIN1"], ["  "], ["IN1", " IN2 "], [123]]) {
    const r = resolveRolloutAccounts({ read: "ok", allPrimary: false, enabledAccountIds: bad }, disc);
    assert.deepEqual(r.accounts, [], JSON.stringify(bad) + " selects zero");
    assert.equal(r.reason, "rollout-noncanonical-id", JSON.stringify(bad) + " => rollout-noncanonical-id");
  }
  // A genuinely canonical, blank-free id still selects normally (control).
  assert.deepEqual(resolveRolloutAccounts({ read: "ok", allPrimary: false, enabledAccountIds: ["IN1"] }, disc).selectedIds, ["IN1"]);
});

test("(A3) dd-secondary is rejected on BOTH sides (discovered account and allowlist row)", () => {
  const disc = [IN1, SEC_ROW];
  const viaAllow = resolveRolloutAccounts({ read: "ok", allPrimary: false, enabledAccountIds: [SEC_ID] }, disc);
  assert.deepEqual(viaAllow.accounts, [], "a dd-secondary allowlist row selects nothing");
  assert.equal(viaAllow.reason, "allowlist-empty", "the prefixed row is dropped BEFORE matching");
  const viaAll = resolveRolloutAccounts({ read: "ok", allPrimary: true, enabledAccountIds: [] }, disc);
  assert.deepEqual(viaAll.selectedIds, ["IN1"], "all-primary still excludes the dd-secondary row");
});

test("(A4) all-primary selects EVERY discovered primary account (deliberate durable switch)", () => {
  const r = resolveRolloutAccounts({ read: "ok", allPrimary: true, enabledAccountIds: ["ignored"] }, [IN1, IN2]);
  assert.deepEqual(r.selectedIds, ["IN1", "IN2"]);
  assert.equal(r.reason, "all-primary");
});

// =================================================================================================
group("B. dispatcher enforcement (scheduled runs; manual canaries unchanged)");

test("(B1) DEFAULT fail-closed controls: a real scheduled invocation is a drained no-op with ZERO I/O and needs NO rollout loader", async () => {
  const { dd, saver, counts, promise } = dispatch({}); // no controlCatalog => production default (all locked); no loader
  const r = await promise;
  assertZeroWork(r, dd, saver, counts);
  assert.deepEqual(r.selected, [], "nothing selected under the default locked catalog");
});

test("(B2) a scheduled run with a READY report but NO trusted rollout loader REFUSES to dispatch", async () => {
  const GK = SHADOW_PLANNED_REPORT_KEYS[0];
  const { counts, dd, saver, promise } = dispatch({ controlCatalog: mkCatalog([GK]) });
  await assert.rejects(promise, /trusted durable account-rollout loader/);
  assert.equal(counts.discover + counts.opens + dd.totalCreates() + saver.calls, 0, "zero I/O before the refusal");
});

test("(B3) a rollout READ FAILURE selects zero accounts BEFORE discovery (fail closed)", async () => {
  const GK = SHADOW_PLANNED_REPORT_KEYS[0];
  for (const read of ["read-failed", "schema-missing"]) {
    const { dd, saver, counts, promise } = dispatch({
      controlCatalog: mkCatalog([GK]),
      loadAccountRollout: async () => ({ read, allPrimary: false, enabledAccountIds: [] }),
    });
    const r = await promise;
    assertZeroWork(r, dd, saver, counts);
    assert.deepEqual(r.accountRollout, { selected: 0, reason: "rollout-read-not-ok" });
  }
});

test("(B4) the DEFAULT durable state (zero rows, all_primary=false) drains BEFORE discovery", async () => {
  const GK = SHADOW_PLANNED_REPORT_KEYS[0];
  const { dd, saver, counts, promise } = dispatch({ controlCatalog: mkCatalog([GK]), loadAccountRollout: zeroDefaultState });
  const r = await promise;
  assertZeroWork(r, dd, saver, counts);
  assert.deepEqual(r.accountRollout, { selected: 0, reason: "zero-accounts-enabled" });
});

test("(B4b) a NONCANONICAL durable id drains BEFORE discovery (fail closed; never trimmed into an account)", async () => {
  const GK = SHADOW_PLANNED_REPORT_KEYS[0];
  const { dd, saver, counts, promise } = dispatch({
    bucket: "non-us", accounts: [IN1],
    controlCatalog: mkCatalog([GK]),
    loadAccountRollout: async () => ({ read: "ok", allPrimary: false, enabledAccountIds: [" IN1 "] }),
  });
  const r = await promise;
  assertZeroWork(r, dd, saver, counts);
  assert.deepEqual(r.accountRollout, { selected: 0, reason: "rollout-noncanonical-id" }, "a whitespace-padded durable id spends zero discovery/cycle/store/DataDoe I/O");
});

test("(B5) allowlist [IN1] out of a 30-account discovery: ONLY IN1 is dispatched; every write is IN1's", async () => {
  const GK = SHADOW_PLANNED_REPORT_KEYS[0];
  const { store, dd, saver, promise } = dispatch({
    bucket: "non-us", accounts: BIG_DIRECTORY,
    controlCatalog: mkCatalog([GK]), loadAccountRollout: okAllowlist(["IN1"]),
  });
  const r = await promise;
  assert.ok(r.cycleId, "the enabled account really runs (a cycle opened)");
  assert.ok(r.spent > 0, "budget was spent on IN1's work");
  assert.deepEqual(r.accountsDispatched, ["IN1"], "exactly the one enabled account");
  assert.deepEqual(r.accountRollout, { selected: 1, staleIds: [], reason: "allowlist" });
  assert.ok(dd.totalCreates() > 0, "IN1's source work actually happened");
  const owners = store._owners(r.cycleId);
  assert.ok(owners.length > 0, "source-job owners recorded");
  assert.ok(owners.every((m) => m.account_id === "IN1"), "every source-job owner row belongs to IN1");
  assert.ok(store.listReportJobs().every((j) => j.account_id === "IN1"), "every report job belongs to IN1");
  assert.ok(saver.savedKeys().every((k) => k.endsWith("|IN1")), "every saved shadow snapshot belongs to IN1");
});

test("(B6) the SAME allowlist leaves the US bucket UNTOUCHED: post-discovery drain, zero writes", async () => {
  const GK = SHADOW_PLANNED_REPORT_KEYS[0];
  const { dd, saver, counts, promise } = dispatch({
    bucket: "us", accounts: BIG_DIRECTORY,
    controlCatalog: mkCatalog([GK]), loadAccountRollout: okAllowlist(["IN1"]),
  });
  const r = await promise;
  assertZeroWork(r, dd, saver, counts, { discovered: true });
  assert.equal(r.accountRollout.selected, 0, "no US account is selected by the IN allowlist");
  assert.deepEqual(r.accountRollout.staleIds, ["IN1"], "IN1 is out-of-bucket here, so it matches nothing");
});

test("(B7) dd-secondary can NEVER enter scheduled scope -- not via discovery, not via an allowlist row", async () => {
  const GK = SHADOW_PLANNED_REPORT_KEYS[0];
  // (a) all-primary with an ACTIVE dd-secondary directory row: only the primary account runs.
  const a = dispatch({ bucket: "non-us", accounts: [IN1, SEC_ROW], controlCatalog: mkCatalog([GK]), loadAccountRollout: okAllPrimary });
  const ra = await a.promise;
  assert.deepEqual(ra.accountsDispatched, ["IN1"], "the dd-secondary row is excluded under all-primary");
  assert.ok(a.store._owners(ra.cycleId).every((m) => m.account_id === "IN1"), "no dd-secondary write exists");
  // (b) an allowlist row naming the dd-secondary id selects NOTHING.
  const b = dispatch({ bucket: "non-us", accounts: [IN1, SEC_ROW], controlCatalog: mkCatalog([GK]), loadAccountRollout: okAllowlist([SEC_ID]) });
  const rb = await b.promise;
  assertZeroWork(rb, b.dd, b.saver, b.counts);
  assert.deepEqual(rb.accountRollout, { selected: 0, reason: "zero-accounts-enabled" }, "the prefixed allowlist row is dropped up front");
});

test("(B8) a stale allowlist row spends ZERO while the valid row still runs", async () => {
  const GK = SHADOW_PLANNED_REPORT_KEYS[0];
  const { store, promise } = dispatch({
    bucket: "non-us", accounts: [IN1, IN2],
    controlCatalog: mkCatalog([GK]), loadAccountRollout: okAllowlist(["IN1", "GONE9"]),
  });
  const r = await promise;
  assert.deepEqual(r.accountsDispatched, ["IN1"]);
  assert.deepEqual(r.accountRollout, { selected: 1, staleIds: ["GONE9"], reason: "allowlist" });
  assert.ok(store._owners(r.cycleId).every((m) => m.account_id === "IN1"), "no write for the stale id or IN2");
});

test("(B9) all-primary AUTO-INCLUDES a newly connected primary account with no code change", async () => {
  const GK = SHADOW_PLANNED_REPORT_KEYS[0];
  const before = dispatch({ bucket: "non-us", accounts: [IN1], controlCatalog: mkCatalog([GK]), loadAccountRollout: okAllPrimary });
  assert.deepEqual((await before.promise).accountsDispatched, ["IN1"]);
  const after = dispatch({ bucket: "non-us", accounts: [IN1, IN2], controlCatalog: mkCatalog([GK]), loadAccountRollout: okAllPrimary });
  assert.deepEqual((await after.promise).accountsDispatched, ["IN1", "IN2"], "IN2 joins the moment discovery returns it");
});

test("(B10) a MANUAL production run can NOT bypass the durable rollout: reports-only selection, account scope always durable", async () => {
  const GK = SHADOW_PLANNED_REPORT_KEYS[0];
  // (a) manual WITHOUT the trusted loader REFUSES to dispatch (no bypass exists).
  const a = dispatch({ manualReportKeys: [GK], controlCatalog: mkCatalog([GK]), loadAccountRollout: undefined });
  await assert.rejects(a.promise, /trusted durable account-rollout loader/);
  assert.equal(a.counts.discover + a.counts.opens + a.dd.totalCreates() + a.saver.calls, 0, "zero I/O before the refusal");
  // (b) manual + the DEFAULT durable zero state => drained no-op BEFORE discovery.
  const b = dispatch({ manualReportKeys: [GK], controlCatalog: mkCatalog([GK]), loadAccountRollout: zeroDefaultState });
  const rb = await b.promise;
  assertZeroWork(rb, b.dd, b.saver, b.counts);
  assert.deepEqual(rb.accountRollout, { selected: 0, reason: "zero-accounts-enabled" });
  // (c) manual + a rollout READ FAILURE => drained no-op BEFORE discovery (fail closed).
  const c = dispatch({ manualReportKeys: [GK], controlCatalog: mkCatalog([GK]), loadAccountRollout: async () => ({ read: "read-failed", allPrimary: true, enabledAccountIds: [] }) });
  const rc = await c.promise;
  assertZeroWork(rc, c.dd, c.saver, c.counts);
  // (d) manual + a durable allowlist: manualReportKeys still selects the REPORT; the ACCOUNT scope is the
  //     durable state's -- an account outside it never dispatches.
  const d = dispatch({
    manualReportKeys: [GK], controlCatalog: mkCatalog([GK]),
    accounts: [...US_ACCTS, { accountId: "A2", country: "US", currency: "USD", name: "Two" }],
    loadAccountRollout: okAllowlist(["A1"]),
  });
  const rd = await d.promise;
  assert.equal(rd.manual, true);
  assert.deepEqual(rd.selected, [GK], "manualReportKeys selected the report");
  assert.deepEqual(rd.accountsDispatched, ["A1"], "the durable allowlist bounded the manual run's accounts");
  assert.deepEqual(rd.accountRollout, { selected: 1, staleIds: [], reason: "allowlist" });
});

test("(B11) the BUILD-TIME trusted canary composition scopes accounts with NO per-run bypass", async () => {
  const GK = SHADOW_PLANNED_REPORT_KEYS[0];
  const SOURCE_METHODS = ["openCycle", "claimCycle", "getCycle", "upsertSourceJob", "listSourceJobs", "upsertSourceJobOwners",
    "listSourceJobOwners", "listSourceJobsForOwners", "recordSourceOwnerStale", "claimExportAttempt", "recordExportCreated",
    "loadSourceRows", "saveSourceRows", "recordSourceSuccess", "recordSourceFailure", "updateCycleCounts", "finalizeCycle"];
  const REPORT_METHODS = ["listSourceJobs", "upsertReportJob", "listReportJobs", "claimReportDerive", "recordReportBlocked",
    "recordReportFailure", "recordReportSuccess"];
  const pick = (store, names) => Object.fromEntries(names.map((n) => [n, store[n].bind(store)]));
  const mkCanary = (ids, directory) => {
    const backing = makeStore();
    const dd = makeDataDoe();
    const saver = makeSaver();
    const rt = buildSchedulerV2CanaryRuntime({
      canaryAccountIds: ids,
      connections: CONNS,
      makeSourceStore: () => pick(backing, SOURCE_METHODS),
      makeReportStore: () => pick(backing, REPORT_METHODS),
      makeDataDoeAdapter: () => dd,
      makeShadowSnapshotSaver: () => saver,
      fetchAccounts: async () => directory,
      getAdMetrics: async () => [], getCoverageState: async () => ({ windows: [], status: "missing", read: "ok" }),
      getAdsDailySourceRows: async () => [], getAdsSyncStates: async () => [],
      getAdsSyncCoverage: async () => ({ windows: [], status: "missing", read: "ok" }),
      getReportSyncSettings: async () => [],
      controlCatalog: mkCatalog([GK]),
    });
    return { rt, dd, saver };
  };
  const dir = [{ id: "A1", country: "US", currency: "USD", name: "One" }, { id: "A2", country: "US", currency: "USD", name: "Two" }];
  // (a) exact reviewed ids run EXACTLY those accounts (manual reports selection unchanged).
  const good = mkCanary(["A1"], dir);
  const rg = await good.rt.run({ bucket: "us", cycleDate: "2026-08-16", asOf: ASOF, manualReportKeys: [GK] });
  assert.deepEqual(rg.accountsDispatched, ["A1"], "the canary runs exactly its reviewed account");
  // (b) an id that fresh discovery does NOT return selects NOTHING (validated against real discovery).
  const ghost = mkCanary(["GHOST9"], dir);
  const rgh = await ghost.rt.run({ bucket: "us", cycleDate: "2026-08-16", asOf: ASOF, manualReportKeys: [GK] });
  assert.equal(rgh.cycleId, null, "an undiscovered canary id opens no cycle");
  assert.equal(ghost.dd.totalCreates() + ghost.saver.calls, 0, "and spends nothing");
  assert.deepEqual(rgh.accountRollout, { selected: 0, staleIds: ["GHOST9"], reason: "allowlist" });
  // (c) build-time validation: empty / blank / dd-secondary / WHITESPACE-PADDED / DUPLICATE ids REFUSE to
  //     compose (ids are NEVER normalized -- a trimmed id could point the canary at a different account).
  for (const bad of [[], [""], ["  "], [SEC_ID], ["A1", SEC_ID], [" A1 "], ["A1 "], ["\tA1"], ["A1", "A1"], [123]]) {
    assert.throws(() => mkCanary(bad, dir), /canary/i, JSON.stringify(bad) + " must not compose");
  }
  // (d) NO per-run bypass: run-level rollout/scope args are dropped (RUN_OPERATIONAL_ARGS is pinned).
  const pinned = mkCanary(["A1"], dir);
  const rp = await pinned.rt.run({
    bucket: "us", cycleDate: "2026-08-17", asOf: ASOF, manualReportKeys: [GK],
    loadAccountRollout: okAllPrimary, getAccountRollout: okAllPrimary,
    canaryAccountIds: ["A1", "A2"], discoverAccounts: async () => dir,
  });
  assert.deepEqual(rp.accountsDispatched, ["A1"], "a per-run widening attempt changes nothing");
});

// =================================================================================================
group("C. composed-runtime enforcement (caller overrides can NOT widen scope)");

test("(C1) RUN_OPERATIONAL_ARGS is pinned: no trusted collaborator is per-run overridable", () => {
  assert.deepEqual([...RUN_OPERATIONAL_ARGS], [
    "bucket", "cycleDate", "asOf", "asOfFor", "manualReportKeys",
    "clock", "deadlineMs", "reserveMs", "maxJobs", "scheduledAt", "trigger",
  ]);
  for (const trusted of ["loadAccountRollout", "getAccountRollout", "discoverAccounts", "controlCatalog", "settings", "connections", "store", "dataDoe", "saveSnapshot"]) {
    assert.ok(!RUN_OPERATIONAL_ARGS.includes(trusted), trusted + " is fixed by the composition");
  }
});

test("(C2) rt.run() drops a malicious rollout/discovery/catalog override: the durable ZERO state still drains", async () => {
  const GK = SHADOW_PLANNED_REPORT_KEYS[0];
  const SOURCE_METHODS = ["openCycle", "claimCycle", "getCycle", "upsertSourceJob", "listSourceJobs", "upsertSourceJobOwners",
    "listSourceJobOwners", "listSourceJobsForOwners", "recordSourceOwnerStale", "claimExportAttempt", "recordExportCreated",
    "loadSourceRows", "saveSourceRows", "recordSourceSuccess", "recordSourceFailure", "updateCycleCounts", "finalizeCycle"];
  const REPORT_METHODS = ["listSourceJobs", "upsertReportJob", "listReportJobs", "claimReportDerive", "recordReportBlocked",
    "recordReportFailure", "recordReportSuccess"];
  const pick = (store, names) => Object.fromEntries(names.map((n) => [n, store[n].bind(store)]));
  const counts = { fetch: 0, rollout: 0 };
  const backing = makeStore();
  const dd = makeDataDoe();
  const saver = makeSaver();
  const makeRt = (getAccountRollout) => buildSchedulerV2Runtime({
    connections: CONNS,
    makeSourceStore: () => pick(backing, SOURCE_METHODS),
    makeReportStore: () => pick(backing, REPORT_METHODS),
    makeDataDoeAdapter: () => dd,
    makeShadowSnapshotSaver: () => saver,
    fetchAccounts: async () => { counts.fetch += 1; return [{ id: "A1", country: "US", currency: "USD", name: "Acct One" }]; },
    getAdMetrics: async () => [],
    getCoverageState: async () => ({ windows: [], status: "missing", read: "ok" }),
    getAdsDailySourceRows: async () => [],
    getAdsSyncStates: async () => [],
    getAdsSyncCoverage: async () => ({ windows: [], status: "missing", read: "ok" }),
    getReportSyncSettings: async () => [],
    controlCatalog: mkCatalog([GK]),
    getAccountRollout,
  });
  // Composed with the durable DEFAULT (zero accounts). The caller tries to widen scope per run -- every
  // override is dropped, the composed zero state wins, and NO discovery or write happens.
  const rt = makeRt(async () => { counts.rollout += 1; return { read: "ok", allPrimary: false, enabledAccountIds: [] }; });
  const r = await rt.run({
    bucket: "us", cycleDate: "2026-08-16", asOf: ASOF,
    loadAccountRollout: okAllPrimary,           // dropped (not operational)
    getAccountRollout: okAllPrimary,            // dropped
    discoverAccounts: async () => [{ accountId: "EVIL1", country: "US" }], // dropped
    controlCatalog: mkCatalog([GK]),            // dropped
    settings: [{ report_key: GK, schedule_enabled: true }], // dropped
  });
  assert.equal(r.drained, true, "the composed durable zero state wins");
  assert.deepEqual(r.accountRollout, { selected: 0, reason: "zero-accounts-enabled" });
  assert.equal(counts.rollout, 1, "the COMPOSED trusted loader was consulted");
  assert.equal(counts.fetch, 0, "zero discovery");
  assert.equal(dd.totalCreates() + saver.calls, 0, "zero writes");
  // Positive control: the composed durable state (not the caller) is what grants scope.
  const rt2 = makeRt(async () => ({ read: "ok", allPrimary: false, enabledAccountIds: ["A1"] }));
  const r2 = await rt2.run({ bucket: "us", cycleDate: "2026-08-17", asOf: ASOF });
  assert.deepEqual(r2.accountsDispatched, ["A1"], "the durable allowlist grants exactly A1");
});

// =================================================================================================
group("D. Supabase wrappers: typed fail-closed reads + the CAS publish primitive (stubbed fetch)");

test("(D1) getSchedulerAccountRollout: ok / schema-missing / read-failed are typed; non-ok selects zero", async () => {
  let s = stubFetch((rec) => {
    if (rec.url.includes("scheduler_rollout_mode")) return { json: [{ all_primary: false }] };
    if (rec.url.includes("scheduler_account_rollout")) return { json: [{ account_id: "IN1" }, { account_id: "IN2" }] };
    return { json: [] };
  });
  try {
    const ok = await getSchedulerAccountRollout();
    assert.deepEqual(ok, { read: "ok", allPrimary: false, enabledAccountIds: ["IN1", "IN2"] }, "canonical ids pass through EXACTLY (no trim, order preserved)");
  } finally { s.restore(); }
  // A NONCANONICAL durable id (whitespace) fails the READ closed -- it is NEVER trimmed into another account.
  for (const badId of [" IN1 ", "IN1 ", "\tIN1", "  "]) {
    s = stubFetch((rec) => {
      if (rec.url.includes("scheduler_rollout_mode")) return { json: [{ all_primary: false }] };
      if (rec.url.includes("scheduler_account_rollout")) return { json: [{ account_id: "IN1" }, { account_id: badId }] };
      return { json: [] };
    });
    try {
      const nc = await getSchedulerAccountRollout();
      assert.deepEqual(nc, { read: "noncanonical-id", allPrimary: false, enabledAccountIds: [] }, JSON.stringify(badId) + " => noncanonical-id read");
      assert.deepEqual(resolveRolloutAccounts(nc, [IN1]).accounts, [], "noncanonical-id read selects zero");
    } finally { s.restore(); }
  }
  s = stubFetch(() => ({ ok: false, status: 404, json: { code: "PGRST205", message: "Could not find the table 'public.scheduler_rollout_mode' in the schema cache" } }));
  try {
    const miss = await getSchedulerAccountRollout();
    assert.deepEqual(miss, { read: "schema-missing", allPrimary: false, enabledAccountIds: [] });
    assert.deepEqual(resolveRolloutAccounts(miss, [IN1]).accounts, [], "schema-missing selects zero");
  } finally { s.restore(); }
  s = stubFetch(() => ({ ok: false, status: 500, json: { message: "boom" } }));
  try {
    const fail = await getSchedulerAccountRollout();
    assert.deepEqual(fail, { read: "read-failed", allPrimary: false, enabledAccountIds: [] });
    assert.deepEqual(resolveRolloutAccounts(fail, [IN1]).accounts, [], "read-failed selects zero");
  } finally { s.restore(); }
});

test("(D2) getSchedulerPublishApproval: approved only on an exact approved=true row; errors fail closed", async () => {
  let s = stubFetch(() => ({ json: [{ approved: true }] }));
  try { assert.deepEqual(await getSchedulerPublishApproval(SM, "IN1"), { read: "ok", approved: true }); } finally { s.restore(); }
  s = stubFetch(() => ({ json: [] }));
  try { assert.deepEqual(await getSchedulerPublishApproval(SM, "IN1"), { read: "ok", approved: false }, "absent row => NOT approved"); } finally { s.restore(); }
  s = stubFetch(() => ({ ok: false, status: 500, json: { message: "boom" } }));
  try { assert.deepEqual(await getSchedulerPublishApproval(SM, "IN1"), { read: "read-failed", approved: false }); } finally { s.restore(); }
});

test("(D3) publishLiveSnapshotIfNewer CAS: insert / strictly-older replace / newer-live / equal-freshness identity", async () => {
  const CAND_PARAMS = { reportVersion: SM + "-v1", to: "2026-08-14" };
  const CAND_PAYLOAD = { ok: true, rows: [1, 2, 3] };
  const args = { reportKey: SM, accountId: "IN1", paramsHash: "h".repeat(40), params: CAND_PARAMS, payload: CAND_PAYLOAD, payloadBytes: 20, sourceRefreshedAt: SHADOW_TS };
  const OLDER = "2026-08-10T00:00:00.000Z";
  const NEWER = "2026-08-20T00:00:00.000Z";
  // A dispatcher keyed by request KIND (insert POST / readLive GET / PATCH / storage GET). `live` is the row
  // the readLive GET returns; `storagePayload` is what a storage GET returns (or throws when `storageFail`).
  const casStub = ({ insert = [], live = null, patch = [], storagePayload, storageFail = false }) => stubFetch((rec) => {
    if (rec.method === "POST") return { json: insert };
    if (rec.method === "PATCH") return { json: patch };
    if (rec.url.includes("/storage/v1/object/")) return storageFail ? { ok: false, status: 500 } : { json: storagePayload === undefined ? null : storagePayload };
    return { json: live == null ? [] : [live] }; // readLive GET
  });

  // (a) INSERTED: absent row -> a single insert-if-absent write, natural-key targeted, no read/patch.
  let s = casStub({ insert: [{ report_key: SM }] });
  try {
    const r = await publishLiveSnapshotIfNewer(args);
    assert.deepEqual(r, { outcome: "inserted" });
    assert.equal(s.calls.length, 1, "one write, nothing else");
    assert.ok(s.calls[0].url.includes("on_conflict=report_key,account_id,params_hash"), "natural-key conflict target");
    assert.equal(s.calls[0].headers.Prefer, "resolution=ignore-duplicates,return=representation", "idempotent insert");
  } finally { s.restore(); }

  // (b) REPLACED: conflict, live STRICTLY OLDER. insert(empty) -> readLive(older) -> guarded PATCH clears the
  //     storage pointer and writes the inline payload; the lt filter pins it to a strictly-older row.
  s = casStub({ insert: [], live: { params: CAND_PARAMS, payload: null, payload_storage_path: "old/obj.json", source_refreshed_at: OLDER }, patch: [{ report_key: SM }] });
  try {
    const r = await publishLiveSnapshotIfNewer(args);
    assert.deepEqual(r, { outcome: "replaced" });
    const patch = s.calls.find((c) => c.method === "PATCH");
    const patchUrl = decodeURIComponent(patch.url);
    assert.ok(patchUrl.includes("report_key=eq." + SM) && patchUrl.includes("account_id=eq.IN1") && patchUrl.includes("params_hash=eq." + args.paramsHash), "pinned to the ONE natural-key row");
    assert.ok(patchUrl.includes("source_refreshed_at=lt." + SHADOW_TS), "replaces ONLY a strictly-older live row");
    assert.equal(patch.body.payload_storage_path, null, "replacement CLEARS the storage pointer");
    assert.deepEqual(patch.body.payload, CAND_PAYLOAD, "the inline payload is what replaced it");
  } finally { s.restore(); }

  // (c) NEWER-LIVE: conflict, live STRICTLY NEWER -> zero write (insert + readLive only, no PATCH).
  s = casStub({ insert: [], live: { params: CAND_PARAMS, payload: CAND_PAYLOAD, payload_storage_path: null, source_refreshed_at: NEWER } });
  try {
    const r = await publishLiveSnapshotIfNewer(args);
    assert.deepEqual(r, { outcome: "newer-live" });
    assert.ok(!s.calls.some((c) => c.method === "PATCH"), "a strictly-newer live row is NEVER patched");
  } finally { s.restore(); }

  // (d) ALREADY-CURRENT: EQUAL freshness + canonically identical params (reordered keys) + identical inline
  //     payload -> zero write. Proves equality is PROVEN, not assumed from the timestamp.
  s = casStub({ insert: [], live: { params: { to: "2026-08-14", reportVersion: SM + "-v1" }, payload: { rows: [1, 2, 3], ok: true }, payload_storage_path: null, source_refreshed_at: SHADOW_TS } });
  try {
    const r = await publishLiveSnapshotIfNewer(args);
    assert.deepEqual(r, { outcome: "already-current" });
    assert.ok(!s.calls.some((c) => c.method === "PATCH"), "no write when already current");
  } finally { s.restore(); }

  // (e) PUBLISH-CONFLICT: EQUAL freshness but DIFFERENT payload -> zero write, live LKG untouched.
  s = casStub({ insert: [], live: { params: CAND_PARAMS, payload: { ok: true, rows: [9, 9, 9] }, payload_storage_path: null, source_refreshed_at: SHADOW_TS } });
  try {
    assert.deepEqual(await publishLiveSnapshotIfNewer(args), { outcome: "conflict" });
    assert.ok(!s.calls.some((c) => c.method === "PATCH"), "an equal-timestamp content mismatch is NEVER overwritten");
  } finally { s.restore(); }

  // (f) PUBLISH-CONFLICT: EQUAL freshness but DIFFERENT params -> zero write.
  s = casStub({ insert: [], live: { params: { reportVersion: SM + "-v1", to: "2026-08-13" }, payload: CAND_PAYLOAD, payload_storage_path: null, source_refreshed_at: SHADOW_TS } });
  try { assert.deepEqual(await publishLiveSnapshotIfNewer(args), { outcome: "conflict" }); } finally { s.restore(); }

  // (g) STORAGE-BACKED live row at EQUAL freshness, hydrated identical -> already-current (no write).
  s = casStub({ insert: [], live: { params: CAND_PARAMS, payload: null, payload_storage_path: "live/obj.json", source_refreshed_at: SHADOW_TS }, storagePayload: { ok: true, rows: [1, 2, 3] } });
  try {
    assert.deepEqual(await publishLiveSnapshotIfNewer(args), { outcome: "already-current" });
    assert.ok(s.calls.some((c) => c.url.includes("/storage/v1/object/")), "the live storage payload was HYDRATED for comparison");
  } finally { s.restore(); }

  // (h) STORAGE-BACKED live row at EQUAL freshness, hydrated DIFFERENT -> conflict (no write).
  s = casStub({ insert: [], live: { params: CAND_PARAMS, payload: null, payload_storage_path: "live/obj.json", source_refreshed_at: SHADOW_TS }, storagePayload: { ok: true, rows: [4, 5, 6] } });
  try { assert.deepEqual(await publishLiveSnapshotIfNewer(args), { outcome: "conflict" }); } finally { s.restore(); }

  // (i) STORAGE UNREADABLE at EQUAL freshness -> cannot prove identity -> conflict (fail closed, no write).
  s = casStub({ insert: [], live: { params: CAND_PARAMS, payload: null, payload_storage_path: "live/obj.json", source_refreshed_at: SHADOW_TS }, storageFail: true });
  try {
    assert.deepEqual(await publishLiveSnapshotIfNewer(args), { outcome: "conflict" });
    assert.ok(!s.calls.some((c) => c.method === "PATCH"), "an unprovable equal-timestamp row is never overwritten");
  } finally { s.restore(); }
});

// =================================================================================================
group("E. publisher: disabled by default; 4 independent gates; CAS; typed dispositions; LKG preserved");

test("(E1) code readiness = EXACTLY the 13 approved keys (Gate-7b cutover); the code-lock gate still refuses an unknown key with ZERO collaborator calls", async () => {
  // Post-Gate-7b: production readiness is EXACTLY the 13 CONTROLLED_REPORT_KEYS (no extras), NOT empty.
  assert.deepEqual([...SCHEDULER_V2_READY_REPORT_KEYS].slice().sort(), [...CONTROLLED_REPORT_KEYS].slice().sort(), "readiness = exactly the 13 approved keys");
  assert.equal(SCHEDULER_V2_READY_REPORT_KEYS.length, 13, "exactly 13, no extras");
  // The code-lock gate STILL functions (defensive): with an injected EMPTY codeReadyKeys, a known report is
  // code-locked BEFORE any collaborator runs -- proving the gate mechanism independent of the production set.
  const h = mkPubDeps({ deps: { codeReadyKeys: [] } });
  const res = await publishSchedulerV2Snapshot(h.deps, { reportKey: SM, accountId: "IN1" });
  observedDispositions.add(res.disposition);
  assert.equal(res.disposition, "code-locked");
  assert.deepEqual(
    [h.calls.settings, h.calls.rollout, h.calls.discover, h.calls.approval, h.calls.job, h.calls.shadow, h.calls.storage, h.calls.publish.length],
    [0, 0, 0, 0, 0, 0, 0, 0], "zero collaborator calls");
  // With the PRODUCTION default readiness (the 13 keys), an UNKNOWN report key is still refused (unknown-report).
  const h2 = mkPubDeps({ deps: { codeReadyKeys: undefined } });
  delete h2.deps.codeReadyKeys; // production default (SCHEDULER_V2_READY_REPORT_KEYS)
  const unknown = await publishSchedulerV2Snapshot(h2.deps, { reportKey: "not-a-v2-report", accountId: "IN1" });
  observedDispositions.add(unknown.disposition);
  assert.equal(unknown.disposition, "unknown-report", "an unknown key is refused at the contract lookup");
});

test("(E2) each gate fails closed with a typed disposition and ZERO publish calls", async () => {
  const cases = [
    [{ }, { reportKey: "not-a-report", accountId: "IN1" }, "unknown-report"],
    [{ deps: { getReportSyncSettings: async () => [{ report_key: SM, schedule_enabled: false }] } }, undefined, "report-disabled"],
    [{ deps: { getReportSyncSettings: async () => [] } }, undefined, "report-disabled"],
    [{ deps: { loadAccountRollout: zeroDefaultState } }, undefined, "account-disabled"],
    [{ deps: { loadAccountRollout: okAllowlist(["US9"]) } }, undefined, "account-disabled"],
    [{ deps: { loadAccountRollout: async () => ({ read: "read-failed", allPrimary: true, enabledAccountIds: [] }) } }, undefined, "account-disabled"],
    [{ deps: { getPublishApproval: async () => ({ read: "ok", approved: false }) } }, undefined, "publish-not-approved"],
    [{ deps: { getPublishApproval: async () => ({ read: "read-failed", approved: true }) } }, undefined, "publish-not-approved"],
  ];
  for (const [over, args, want] of cases) {
    const { res, calls } = await pub(over, args || { reportKey: SM, accountId: "IN1" });
    assert.equal(res.disposition, want);
    assert.equal(calls.publish.length, 0, want + " never publishes");
  }
});

test("(E2b) the account gate resolves against REAL fresh discovery: undiscovered and dd-secondary accounts can NEVER publish, even under all_primary", async () => {
  // (a) allowlisted but NOT currently discovered => account-disabled (a stale allowlist row publishes nothing).
  const stale = await pub({ discovered: US_ACCTS }); // IN1 enabled, but discovery has no IN1
  assert.equal(stale.res.disposition, "account-disabled");
  // (b) all_primary=true + undiscovered account => account-disabled (all-primary widens ONLY to discovered primaries).
  const ghost = await pub({ deps: { loadAccountRollout: okAllPrimary } , discovered: US_ACCTS }, { reportKey: SM, accountId: "GHOST9" });
  assert.equal(ghost.res.disposition, "account-disabled");
  // (c) a DISCOVERED dd-secondary account (secondary connection configured => classified active) still cannot
  //     publish under all_primary: the resolver rejects the prefix.
  const sec = await pub({ deps: { loadAccountRollout: okAllPrimary }, discovered: [IN1, SEC_ROW] }, { reportKey: SM, accountId: SEC_ID });
  assert.equal(sec.res.disposition, "account-disabled");
  // (d) the discovery IS consulted on the happy path (never a synthetic record).
  const ok = await pub({});
  assert.equal(ok.res.disposition, "published");
  assert.equal(ok.calls.discover, 1, "the account gate read the real discovery exactly once");
  for (const r of [stale, ghost, sec]) assert.equal(r.calls.publish.length, 0, "no gated case ever published");
});

test("(E3) only a VALIDATED derive+save-SUCCEEDED job (with its exact snapshot hash) in a TERMINAL succeeded/partial cycle can publish", async () => {
  const GOOD = { cycle_id: "cyc-1", validated: true, snapshot_params_hash: JOB_HASH, derive_status: "succeeded", save_status: "succeeded", cycle_status: "succeeded" };
  const bad = [
    null,
    { ...GOOD, derive_status: "failed", save_status: "pending" },
    { ...GOOD, save_status: "failed" },
    { ...GOOD, derive_status: "skipped", save_status: "skipped" }, // blocked report
    { ...GOOD, cycle_status: "running" },
    { ...GOOD, cycle_status: "failed" },
    { ...GOOD, cycle_status: null },
    { ...GOOD, validated: false },                       // an unvalidated "success" can never publish
    { ...GOOD, snapshot_params_hash: null },             // a hash-less job authorizes NO snapshot
    { ...GOOD, snapshot_params_hash: "" },
    { ...GOOD, snapshot_params_hash: "   " },
  ];
  for (const job of bad) {
    const { res, calls } = await pub({ job });
    assert.equal(res.disposition, "not-successful", JSON.stringify(job && { v: job.validated, d: job.derive_status, s: job.save_status, c: job.cycle_status, h: job.snapshot_params_hash }));
    assert.equal(calls.publish.length + calls.shadow, 0, "no snapshot read, no publish -- live LKG untouched");
  }
  const partial = await pub({ job: { ...GOOD, cycle_status: "partial" } });
  assert.equal(partial.res.disposition, "published", "a partial cycle WITH this exact report succeeded may publish");
});

test("(E4) an unavailable/blocked/invalid/truncated/stale/null/malformed/mismatched snapshot can NEVER publish", async () => {
  const good = mkPubDeps().shadow;
  const variants = [
    ["null snapshot (job hash points at nothing)", null],
    ["MISMATCHED params_hash echo (job A cannot authorize snapshot B)", { ...good, params_hash: "b".repeat(40) }],
    ["blank params_hash echo", { ...good, params_hash: "" }],
    ["wrong report version", { ...good, params: { ...good.params, reportVersion: SM + "/v2d-0" } }],
    ["wrong account identity", { ...good, params: { ...good.params, accountId: "US9" } }],
    ["payload fails the derivation validator", { ...good, payload: { accountId: "IN1", asOf: "2026-08-14" } }],
    ["structurally-valid but UNAVAILABLE payload", { ...good, payload: { accountId: "IN1", asOf: "2026-08-14", dataUnavailable: true, rows: [], catalogBrands: [], salesLatestDate: null } }],
    ["null payload with NO storage pointer", { ...good, payload: null }],
    ["null payload with a BLANK storage pointer", { ...good, payload: null, payload_storage_path: "   " }],
    ["blank source_refreshed_at", { ...good, source_refreshed_at: "  " }],
    ["missing planned param (no live identity)", { ...good, params: { reportVersion: good.params.reportVersion, accountId: "IN1" } }],
    ["malformed params", { ...good, params: "oops" }],
  ];
  for (const [label, shadow] of variants) {
    const { res, calls } = await pub({ shadow });
    assert.equal(res.disposition, "invalid-snapshot", label);
    assert.equal(calls.publish.length, 0, label + " never publishes");
  }
});

test("(E4b) storage-backed shadow payloads: the exact job-linked snapshot publishes; missing/unreadable storage fails CLOSED", async () => {
  const base = mkPubDeps().shadow;
  const goodPayload = base.payload;
  const stored = { ...base, payload: null, payload_storage_path: "report-snapshots/scheduler-v2/sales-movers/IN1.json" };
  // (a) a readable storage payload publishes -- hydrated through the trusted loader, byte-counted inline.
  const ok = await pub({ shadow: stored, storagePayload: goodPayload });
  assert.equal(ok.res.disposition, "published");
  assert.equal(ok.calls.storage, 1, "hydrated exactly once");
  assert.equal(ok.seen.storagePath, stored.payload_storage_path, "hydrated from the row's OWN pointer");
  assert.deepEqual(ok.calls.publish[0].payload, goodPayload, "the HYDRATED payload is what publishes");
  assert.equal(ok.calls.publish[0].payloadBytes, Buffer.byteLength(JSON.stringify(goodPayload), "utf8"));
  // (b) a MISSING storage object (loader returns null) fails closed; live LKG untouched.
  const missing = await pub({ shadow: stored, storagePayload: null });
  assert.equal(missing.res.disposition, "invalid-snapshot");
  // (c) an UNREADABLE storage object (loader throws) fails closed; live LKG untouched.
  const broken = await pub({ shadow: stored, storageThrows: true });
  assert.equal(broken.res.disposition, "invalid-snapshot");
  // (d) a hydrated payload that fails validation (e.g. truncated JSON shape) fails closed.
  const truncated = await pub({ shadow: stored, storagePayload: { accountId: "IN1" } });
  assert.equal(truncated.res.disposition, "invalid-snapshot");
  // (e) a hydrated payload that declares itself UNAVAILABLE fails closed.
  const unavailable = await pub({ shadow: stored, storagePayload: { accountId: "IN1", asOf: "2026-08-14", dataUnavailable: true, rows: [], catalogBrands: [], salesLatestDate: null } });
  assert.equal(unavailable.res.disposition, "invalid-snapshot");
  for (const r of [missing, broken, truncated, unavailable]) assert.equal(r.calls.publish.length, 0, "no failed hydration ever published");
});

test("(E5) publish EXACTLY ONCE with the EXACT live identity the frontend reads", async () => {
  const { res, calls, seen, shadow } = await pub();
  assert.equal(res.disposition, "published");
  assert.equal(seen.shadowKey, "scheduler-v2/" + SM, "reads the exact scheduler-v2/<reportKey> shadow identity");
  assert.equal(seen.shadowAcct, "IN1");
  assert.equal(seen.shadowHash, JOB_HASH, "loaded by the JOB'S OWN snapshot_params_hash -- never a 'latest' row");
  assert.equal(calls.publish.length, 1, "exactly one CAS write");
  const w = calls.publish[0];
  const wantHash = paramsHashFor(SM + "-v1", { to: "2026-08-14" });
  assert.equal(w.reportKey, SM, "the LIVE report key the frontend queries");
  assert.equal(w.accountId, "IN1");
  assert.equal(w.paramsHash, wantHash, "params hash computed EXACTLY like the live report-store");
  assert.deepEqual(w.params, { reportVersion: SM + "-v1", to: "2026-08-14" }, "stored params carry the LIVE reportVersion (report-store shape)");
  assert.equal(w.sourceRefreshedAt, shadow.source_refreshed_at);
  assert.equal(w.payloadBytes, Buffer.byteLength(JSON.stringify(shadow.payload), "utf8"));
  assert.equal(res.paramsHash, wantHash);
  assert.equal(res.liveReportKey, SM);
});

test("(E6) the CAS outcome maps to the typed disposition: replay idempotent, newer-live wins, EQUAL-freshness content mismatch => publish-conflict; transport failure is typed-safe", async () => {
  // The primitive already decided against the REAL live row; the publisher only maps its typed outcome.
  const replay = await pub({ publishRes: { outcome: "already-current" } });
  assert.equal(replay.res.disposition, "already-current", "proven-identical replay => no duplicate");
  const newer = await pub({ publishRes: { outcome: "newer-live" } });
  assert.equal(newer.res.disposition, "newer-live", "a newer live row is never overwritten");
  // EQUAL source_refreshed_at but DIFFERENT content is NOT assumed to be a replay -> publish-conflict (zero
  // write, live LKG byte-identical). A fresh shadow cycle with newer source evidence is the safe remediation.
  const conflict = await pub({ publishRes: { outcome: "conflict" } });
  assert.equal(conflict.res.disposition, "publish-conflict", "equal-timestamp content mismatch => publish-conflict, never a blind overwrite");
  assert.equal(conflict.res.liveReportKey, SM, "typed-safe identity only -- no payload/path/digest leaked");
  const failed = await pub({ publishThrows: true });
  assert.equal(failed.res.disposition, "publish-failed");
  assert.deepEqual(Object.keys(failed.res).sort(), ["accountId", "disposition", "reportKey"], "typed safe fields ONLY -- no raw error leaks");
});

test("(E6b) HASH PROVENANCE: the loaded shadow.params must RECOMPUTE to job.snapshot_params_hash (an unchanged row hash + mutated params fails)", async () => {
  // (a) same row params_hash + MUTATED params (so paramsHashFor(params) != the hash) => invalid-snapshot.
  const mutated = { ...mkPubDeps().shadow, params: { ...SHADOW_PARAMS, to: "2026-08-13" } }; // hash field still JOB_HASH
  const a = await pub({ shadow: mutated });
  assert.equal(a.res.disposition, "invalid-snapshot", "row hash unchanged but params no longer derive it => rejected");
  assert.equal(a.calls.publish.length, 0);
  // (b) params whose reportVersion does NOT derive the claimed hash => invalid-snapshot (recompute mismatch),
  //     even though the version also fails the derivation-version check -- provenance is proven independently.
  const wrongVer = { ...mkPubDeps().shadow, params: { ...SHADOW_PARAMS, reportVersion: SM + "/v2d-9" } };
  const b = await pub({ shadow: wrongVer });
  assert.equal(b.res.disposition, "invalid-snapshot");
  // (c) the row's params_hash echoes the job hash but the RECOMPUTE differs (params tampered post-save) =>
  //     still invalid even if we force the row hash to match: recompute is the independent third check.
  const forced = { ...mkPubDeps().shadow, params_hash: JOB_HASH, params: { ...SHADOW_PARAMS, to: "2026-08-12" } };
  const c = await pub({ shadow: forced, job: { cycle_id: "cyc-1", validated: true, snapshot_params_hash: JOB_HASH, derive_status: "succeeded", save_status: "succeeded", cycle_status: "succeeded" } });
  assert.equal(c.res.disposition, "invalid-snapshot", "recompute(params) != job hash => rejected before hydration/publish");
  // (d) the GENUINE job-linked snapshot (recompute == row hash == job hash) still publishes.
  const ok = await pub({});
  assert.equal(ok.res.disposition, "published");
});

test("(E7) every observed disposition is in the typed PUBLISH_DISPOSITIONS contract", () => {
  assert.ok(observedDispositions.size >= 9, "the suite exercised the disposition space");
  for (const d of observedDispositions) assert.ok(PUBLISH_DISPOSITIONS.includes(d), d + " is a declared typed disposition");
});

// =================================================================================================
group("E2. trusted publisher composition (build-time wiring; the publish() caller can inject NOTHING)");

test("(EC1) the composition exposes ONLY publish(reportKey, accountId), is frozen, and wires the code-lock gate (refuses before discovery)", async () => {
  const rt = buildSchedulerV2Publisher({
    codeReadyKeys: [], // BUILD-TIME seam: force the code lock to prove the composition wires it + refuses early
    connections: CONNS,
    fetchAccounts: async () => { throw new Error("discovery must not run for a code-locked publish"); },
  });
  assert.deepEqual(Object.keys(rt), ["publish", "preflight"], "only publish + the read-only preflight are exposed");
  assert.ok(Object.isFrozen(rt), "the composition is frozen");
  const res = await rt.publish(SM, "IN1");
  observedDispositions.add(res.disposition);
  assert.equal(res.disposition, "code-locked", "the code-lock gate is bound; a non-ready key is refused before discovery runs");
  // The read-only preflight is bound to the SAME gates -- a code-locked key is refused there too (no discovery).
  const pf = await rt.preflight(SM, "IN1");
  assert.equal(pf.disposition, "code-locked", "the preflight shares the code-lock gate");
});

test("(EC2) a publish() caller cannot inject code readiness or any trusted collaborator", async () => {
  let discoveries = 0;
  const fakes = mkPubDeps({});
  const rt = buildSchedulerV2Publisher({
    connections: [CONNS[0]], // one configured connection => fetchAccounts count == discovery count
    fetchAccounts: async () => { discoveries += 1; return [{ id: "IN1", country: "IN", currency: "INR", name: "India One" }]; },
    getAccountRollout: async () => ({ read: "ok", allPrimary: false, enabledAccountIds: ["IN1"] }),
    getSettings: fakes.deps.getReportSyncSettings,
    getApproval: fakes.deps.getPublishApproval,
    getJob: fakes.deps.getLatestReportJob,
    getSnapshot: async ({ reportKey, accountId, paramsHash }) => fakes.deps.getShadowSnapshot(reportKey, accountId, paramsHash),
    loadStoragePayload: fakes.deps.loadStoragePayload,
    publishLive: fakes.deps.publishLive,
    codeReadyKeys: [SM], // BUILD-TIME test seam (production passes nothing => frozen EMPTY)
  });
  // Injection attempts through the ONLY public surface: extra args are ignored; a non-string coerces to ""
  // (=> unknown-report). Nothing a caller passes can reach the composed collaborators.
  const evil = { codeReadyKeys: [SM], deps: { publishLive: async () => ({ outcome: "inserted" }) }, toString: () => SM };
  const r1 = await rt.publish(evil, "IN1");
  observedDispositions.add(r1.disposition);
  assert.equal(r1.disposition, "unknown-report", "a non-string reportKey (object smuggling deps) is refused, never coerced into scope");
  const r2 = await rt.publish(SM, "IN1", { codeReadyKeys: ["anything"], publishLive: async () => ({ outcome: "inserted" }) });
  assert.equal(r2.disposition, "published", "a third argument is IGNORED -- the composed collaborators did the work");
  assert.equal(fakes.calls.publish.length, 1, "exactly the composed CAS primitive published");
  // Memoized fresh discovery: a second publish reuses the composition's ONE discovery read.
  const r3 = await rt.publish(SM, "IN1");
  assert.equal(r3.disposition, "published");
  assert.equal(discoveries, 1, "ONE memoized fresh discovery served both publishes");
});

// =================================================================================================
group("E3. migration-6 audit integrity (DB-enforced identity + audited approval decisions)");

const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");
const realReadFile = (name) => readFileSync(name === "supabase.js"
  ? path.join(ROOT, "lib", "server", "supabase.js")
  : path.join(MIGRATION_DIR, name), "utf8");

test("(EM1) the REAL migration 6 proves every DB-enforced constraint: nonblank + CANONICAL ids, dd-secondary rejection, audited decisions", () => {
  const audit = auditSchemaContract({ readFile: realReadFile });
  assert.equal(audit.ok, true, "the full schema contract audits clean: " + JSON.stringify(audit.blockers));
  const m6 = audit.matrix.find((m) => m.migration === "20260816_account_rollout.sql");
  const constraintNames = m6.tables.flatMap((t) => t.namedConstraints.map((c) => `${t.name}.${c.name}:${c.proven}`));
  assert.deepEqual(constraintNames, [
    "scheduler_account_rollout.scheduler_account_rollout_account_id_nonblank:true",
    "scheduler_account_rollout.scheduler_account_rollout_account_id_canonical:true",
    "scheduler_account_rollout.scheduler_account_rollout_account_id_primary_only:true",
    "scheduler_rollout_mode.scheduler_rollout_mode_singleton:true",
    "scheduler_publish_approvals.scheduler_publish_approvals_report_key_nonblank:true",
    "scheduler_publish_approvals.scheduler_publish_approvals_report_key_canonical:true",
    "scheduler_publish_approvals.scheduler_publish_approvals_account_id_nonblank:true",
    "scheduler_publish_approvals.scheduler_publish_approvals_account_id_canonical:true",
    "scheduler_publish_approvals.scheduler_publish_approvals_account_id_primary_only:true",
    "scheduler_publish_approvals.scheduler_publish_approvals_approved_by_canonical:true",
    "scheduler_publish_approvals.scheduler_publish_approvals_audited:true",
  ], "every table-scoped constraint proof passes against the real migration");
});

test("(EM2) an UNAUDITED/weakened approvals schema FAILS the contract (blank decisions cannot become possible silently)", () => {
  const real6 = realReadFile("20260816_account_rollout.sql");
  const tamper = (mutate) => (name) => (name === "20260816_account_rollout.sql" ? mutate(real6) : realReadFile(name));
  // (a) the audited-decision constraint removed entirely => typed blocker.
  const removed = auditSchemaContract({ readFile: tamper((t) => t.replace(/,\s*constraint scheduler_publish_approvals_audited check \(char_length\(btrim\(approved_by\)\) > 0 and approved_at is not null\)/, "")) });
  assert.equal(removed.ok, false);
  assert.ok(removed.blockers.some((b) => b.code === "NAMED_CONSTRAINT_MISSING" && b.table === "scheduler_publish_approvals" && b.constraints.includes("scheduler_publish_approvals_audited")), "removal is a typed NAMED_CONSTRAINT_MISSING blocker");
  // (b) the constraint WEAKENED (approved_at requirement dropped) => exact-canonical-body mismatch.
  const weakened = auditSchemaContract({ readFile: tamper((t) => t.replace("check (char_length(btrim(approved_by)) > 0 and approved_at is not null)", "check (char_length(btrim(approved_by)) > 0)")) });
  assert.equal(weakened.ok, false);
  assert.ok(weakened.blockers.some((b) => b.code === "NAMED_CONSTRAINT_MISSING" && b.table === "scheduler_publish_approvals"), "a weakened CHECK body fails the exact token comparison");
  // (c) the dd-secondary rejection dropped from the allowlist table => typed blocker.
  const noPrefix = auditSchemaContract({ readFile: tamper((t) => t.replace(/,\s*constraint scheduler_account_rollout_account_id_primary_only check \(account_id not like 'dd-secondary:%'\)/, "")) });
  assert.equal(noPrefix.ok, false);
  assert.ok(noPrefix.blockers.some((b) => b.code === "NAMED_CONSTRAINT_MISSING" && b.table === "scheduler_account_rollout"), "dropping the prefix rejection is a typed blocker");
});

test("(EM3) each CANONICAL-identity constraint is table-scoped, exact, and MANDATORY (removal fails the contract)", () => {
  const real6 = realReadFile("20260816_account_rollout.sql");
  const tamper = (mutate) => (name) => (name === "20260816_account_rollout.sql" ? mutate(real6) : realReadFile(name));
  // Baseline: all four canonical constraints prove against the real migration.
  const CANON = [
    ["scheduler_account_rollout", "scheduler_account_rollout_account_id_canonical", "account_id = btrim(account_id)"],
    ["scheduler_publish_approvals", "scheduler_publish_approvals_report_key_canonical", "report_key = btrim(report_key)"],
    ["scheduler_publish_approvals", "scheduler_publish_approvals_account_id_canonical", "account_id = btrim(account_id)"],
    ["scheduler_publish_approvals", "scheduler_publish_approvals_approved_by_canonical", "approved_by = btrim(approved_by)"],
  ];
  const base = auditSchemaContract({ readFile: realReadFile });
  for (const [table, name] of CANON) {
    const row = base.matrix.find((m) => m.migration === "20260816_account_rollout.sql").tables.find((t) => t.name === table);
    assert.ok(row.namedConstraints.some((c) => c.name === name && c.proven), name + " proves for " + table);
  }
  // (a) MANDATORY: removing ANY canonical constraint (literal, name-scoped) => NAMED_CONSTRAINT_MISSING for
  //     its OWN table. The name is in the literal, so the two identical `account_id = btrim(account_id)`
  //     bodies (one per table) are removed INDEPENDENTLY -- proving each is table-scoped.
  for (const [table, name, body] of CANON) {
    const decl = `constraint ${name} check (${body})`;
    assert.ok(real6.includes(decl), name + " declaration is present verbatim in the migration");
    const removed = auditSchemaContract({ readFile: tamper((t) => t.replace(decl, "")) });
    assert.equal(removed.ok, false, name + " removal must fail the contract");
    assert.ok(removed.blockers.some((b) => b.code === "NAMED_CONSTRAINT_MISSING" && b.table === table && b.constraints.includes(name)), name + " => typed blocker on " + table);
    // The OTHER table's identically-bodied canonical constraint is UNAFFECTED (table-scoped removal).
    const otherCanon = CANON.find(([t2, n2]) => n2 !== name && t2 !== table && base.matrix);
    if (otherCanon) assert.ok(!removed.blockers.some((b) => b.code === "NAMED_CONSTRAINT_MISSING" && b.constraints && b.constraints.includes(otherCanon[1])), "removing " + name + " leaves other-table canonical constraints intact");
  }
  // (b) EXACT: the allowlist canonical check WEAKENED to a tautology (btrim(x) = btrim(x)) fails the token
  //     comparison (name-scoped literal so ONLY that constraint changes).
  const weakened = auditSchemaContract({ readFile: tamper((t) => t.replace(
    "constraint scheduler_account_rollout_account_id_canonical check (account_id = btrim(account_id))",
    "constraint scheduler_account_rollout_account_id_canonical check (btrim(account_id) = btrim(account_id))")) });
  assert.equal(weakened.ok, false);
  assert.ok(weakened.blockers.some((b) => b.code === "NAMED_CONSTRAINT_MISSING" && b.constraints.includes("scheduler_account_rollout_account_id_canonical")), "a weakened canonical body fails the EXACT token comparison");
});

test("(EM4) least-privilege service_role ACL: proven for all 3 tables; missing-revoke / GRANT ALL / added-DELETE / wrong-table / comment-only / string-only each FAIL with a typed blocker", () => {
  const real6 = realReadFile("20260816_account_rollout.sql");
  const tamper = (mutate) => (name) => (name === "20260816_account_rollout.sql" ? mutate(real6) : realReadFile(name));
  const TABLES = ["scheduler_account_rollout", "scheduler_rollout_mode", "scheduler_publish_approvals"];
  const REVOKE = (t) => `revoke all on public.${t} from public, anon, authenticated, service_role;`;
  const GRANT = (t) => `grant select, insert, update on public.${t} to service_role;`;

  // Baseline: the REAL migration REVOKEs ALL from service_role AND grants EXACTLY {select,insert,update} on
  // all three tables (so Supabase's default-privilege ALL is stripped -- no delete/truncate/references/
  // trigger/maintain).
  const base = auditSchemaContract({ readFile: realReadFile });
  assert.equal(base.ok, true, "real migration audits clean: " + JSON.stringify(base.blockers));
  for (const t of TABLES) {
    assert.ok(real6.includes(REVOKE(t)), "REVOKE ALL ... from service_role present verbatim for " + t);
    assert.ok(real6.includes(GRANT(t)), "GRANT select,insert,update to service_role present verbatim for " + t);
    const row = base.matrix.find((m) => m.migration === "20260816_account_rollout.sql").tables.find((x) => x.name === t);
    assert.ok(row.serviceRoleAcl && row.serviceRoleAcl.ok, t + " service_role ACL proven");
  }

  const T = "scheduler_account_rollout"; // the audit is table-scoped; mutate one table
  const failsWith = (code, mutate, label) => {
    const a = auditSchemaContract({ readFile: tamper(mutate) });
    assert.equal(a.ok, false, label + " must fail the contract");
    assert.ok(a.blockers.some((b) => b.code === code && b.table === T), label + " => typed " + code + " on " + T);
    return a;
  };

  // (a) MISSING REVOKE (the exact original production defect): drop service_role from the revoke list -- the
  //     Supabase default ALL grant survives, so this must be caught.
  failsWith("SERVICE_ROLE_REVOKE_MISSING",
    (t) => t.replace(REVOKE(T), `revoke all on public.${T} from public, anon, authenticated;`), "missing REVOKE-from-service_role");

  // (b) GRANT ALL instead of exactly SIU.
  const grantAll = failsWith("SERVICE_ROLE_GRANT_MISMATCH",
    (t) => t.replace(GRANT(T), `grant all on public.${T} to service_role;`), "GRANT ALL");
  assert.ok(grantAll.blockers.some((b) => b.code === "SERVICE_ROLE_GRANT_MISMATCH" && /\[all\]/.test(b.message)), "GRANT ALL reports the [all] set");

  // (c) added DELETE beyond SIU.
  const withDelete = failsWith("SERVICE_ROLE_GRANT_MISMATCH",
    (t) => t.replace(GRANT(T), `grant select, insert, update, delete on public.${T} to service_role;`), "added DELETE");
  assert.ok(withDelete.blockers.some((b) => b.code === "SERVICE_ROLE_GRANT_MISMATCH" && /delete/.test(b.message)), "added DELETE reported in the got-set");

  // (d) WRONG TABLE: the grant names a different object, so THIS table has no service_role grant.
  failsWith("SERVICE_ROLE_GRANT_MISSING",
    (t) => t.replace(GRANT(T), `grant select, insert, update on public.some_other_table to service_role;`), "wrong-table grant");

  // (e) COMMENT-ONLY grant: masked blanks comments, so a commented grant proves nothing.
  failsWith("SERVICE_ROLE_GRANT_MISSING",
    (t) => t.replace(GRANT(T), `-- ${GRANT(T)}`), "comment-only grant");

  // (f) STRING-ONLY grant: the grant text lives only inside a string literal (blanked in masked).
  failsWith("SERVICE_ROLE_GRANT_MISSING",
    (t) => t.replace(GRANT(T), `select '${GRANT(T)}'::text;`), "string-only grant");

  // TABLE-SCOPING: a mutation on scheduler_account_rollout leaves the other two tables' ACL proofs intact.
  const scoped = auditSchemaContract({ readFile: tamper((t) => t.replace(GRANT(T), `-- ${GRANT(T)}`)) });
  for (const other of ["scheduler_rollout_mode", "scheduler_publish_approvals"]) {
    assert.ok(!scoped.blockers.some((b) => /SERVICE_ROLE/.test(b.code) && b.table === other), other + " ACL unaffected by a " + T + " mutation");
  }
});

// =================================================================================================
group("F. all 13 scheduler->live mappings statically pinned against the REAL live route truths");

test("(F1) exactly 14 contracts (13 dispatch + the source-promoted brand-inventory); key/version/params pinned; insight versions equal the live modules' constants", () => {
  const EXPECTED_VERSIONS = {
    "brand-sales": "brand-sales-shared-v1",
    "daily-reporting": "daily-reporting-shared-v2",
    reconciliation: "reconciliation-shared-v1",
    "sku-pl": "sku-pl-shared-v1",
    "keyword-rank": "keyword-rank-shared-v1",
    "content-changes": "content-changes-shared-v1",
    "fba-plan": "fba-plan-shared-v1",
    "sales-movers": "sales-movers-v1",
    "listing-health": "listing-health-v1",
    "buy-box-loss": "buy-box-loss-v1",
    "returns-leakage": "returns-leakage-v2",
    "ppc-performance": "ppc-performance-v1",
    "listing-optimizer": "listing-optimizer-v1",
    // Round-6 fix 3: the source-promoted compact Brand View inventory -- publishable through the same
    // four gates, NEVER dispatchable (not in CONTROLLED_REPORT_KEYS; proven below).
    "brand-inventory": "brand-inventory-shared-v1",
  };
  assert.ok(Object.isFrozen(SCHEDULER_LIVE_SNAPSHOT_CONTRACTS), "the contract table is frozen");
  assert.deepEqual(Object.keys(SCHEDULER_LIVE_SNAPSHOT_CONTRACTS).sort(), Object.keys(EXPECTED_VERSIONS).sort(), "exactly the 13 dispatch reports + the 1 source-promoted report");
  for (const [key, version] of Object.entries(EXPECTED_VERSIONS)) {
    const c = SCHEDULER_LIVE_SNAPSHOT_CONTRACTS[key];
    assert.equal(c.liveReportKey, key, key + ": live key === scheduler key");
    assert.equal(c.liveReportVersion, version, key + ": pinned live version");
  }
  // The six insight versions/keys must equal the constants the LIVE routes import (single source of truth).
  for (const [key, [K, V]] of Object.entries(insightConsts)) {
    assert.equal(SCHEDULER_LIVE_SNAPSHOT_CONTRACTS[key].liveReportKey, K, key + ": matches the live module's REPORT_KEY");
    assert.equal(SCHEDULER_LIVE_SNAPSHOT_CONTRACTS[key].liveReportVersion, V, key + ": matches the live module's VERSION");
  }
});

test("(F2) each params builder emits the EXACT live params shape and fails closed on malformed input", () => {
  const P = { from: "2026-07-01", to: "2026-08-14" };
  const lp = (k, p) => SCHEDULER_LIVE_SNAPSHOT_CONTRACTS[k].liveParams(p);
  assert.deepEqual(lp("brand-sales", P), { from: "2026-07-01", to: "2026-08-14" });
  assert.deepEqual(lp("reconciliation", P), { from: "2026-07-01", to: "2026-08-14" });
  assert.deepEqual(lp("sku-pl", P), { from: "2026-07-01", to: "2026-08-14" });
  assert.deepEqual(lp("daily-reporting", P), { from: "2026-07-01", to: "2026-08-14", brand: "ALL" }, "live default brand is ALL");
  assert.deepEqual(lp("daily-reporting", { ...P, brand: "Acme" }), { from: "2026-07-01", to: "2026-08-14", brand: "Acme" });
  assert.deepEqual(lp("keyword-rank", P), { to: "2026-08-14" });
  assert.deepEqual(lp("fba-plan", P), { to: "2026-08-14" });
  assert.deepEqual(lp("content-changes", P), { asOf: "2026-08-14" }, "the live route keys Content Changes by asOf");
  for (const k of ["sales-movers", "listing-health", "buy-box-loss", "returns-leakage", "ppc-performance", "listing-optimizer"]) {
    assert.deepEqual(lp(k, P), { to: "2026-08-14" }, k + ": insight live params are { to }");
  }
  for (const k of Object.keys(SCHEDULER_LIVE_SNAPSHOT_CONTRACTS)) {
    assert.equal(lp(k, {}), null, k + ": missing planned params fail closed");
    assert.equal(lp(k, { from: "2026-7-1", to: "2026-8-14" }), null, k + ": malformed dates fail closed");
  }
});

test("(F2b) STRICT calendar-date validation: impossible dates and reversed from/to fail; leap-day + boundaries pass", () => {
  const lp = (k, p) => SCHEDULER_LIVE_SNAPSHOT_CONTRACTS[k].liveParams(p);
  const RANGE = ["brand-sales", "reconciliation", "sku-pl", "daily-reporting"]; // { from, to } contracts
  const TO = ["keyword-rank", "fba-plan", "content-changes", "sales-movers", "listing-health", "buy-box-loss", "returns-leakage", "ppc-performance", "listing-optimizer"]; // { to } contracts
  // IMPOSSIBLE dates are rejected everywhere (2026-02-30, 2026-13-01, non-leap Feb 29, 0000-00-00, bad shape).
  for (const bad of ["2026-02-30", "2026-13-01", "2026-00-10", "2026-02-29", "0000-00-00", "2026-8-14", "2026-08-1", "20260814", "2026-08-14 ", ""]) {
    for (const k of TO) assert.equal(lp(k, { to: bad }), null, k + ": impossible `to` " + JSON.stringify(bad) + " fails closed");
    for (const k of RANGE) assert.equal(lp(k, { from: "2026-07-01", to: bad }), null, k + ": impossible `to` " + JSON.stringify(bad) + " fails closed");
    for (const k of RANGE) assert.equal(lp(k, { from: bad, to: "2026-08-14" }), null, k + ": impossible `from` " + JSON.stringify(bad) + " fails closed");
  }
  // REVERSED from/to (from > to) is rejected; from == to is allowed (a single-day window).
  for (const k of RANGE) {
    assert.equal(lp(k, { from: "2026-08-14", to: "2026-07-01" }), null, k + ": reversed from/to fails closed");
    assert.ok(lp(k, { from: "2026-08-14", to: "2026-08-14" }), k + ": from == to (single day) is allowed");
  }
  // LEAP DAY (real) + calendar BOUNDARIES pass everywhere.
  for (const good of ["2024-02-29", "2026-01-01", "2026-12-31"]) {
    for (const k of TO) assert.ok(lp(k, { to: good }), k + ": valid date " + good + " passes");
    for (const k of RANGE) assert.ok(lp(k, { from: "2020-01-01", to: good }), k + ": valid range end " + good + " passes");
  }
});

test("(F3) the pinned shared mappings appear VERBATIM in the live api/datadoe.js route", () => {
  const src = readFileSync(path.join(ROOT, "api", "datadoe.js"), "utf8");
  for (const [key, version] of [
    ["brand-sales", "brand-sales-shared-v1"], ["daily-reporting", "daily-reporting-shared-v2"],
    ["reconciliation", "reconciliation-shared-v1"], ["sku-pl", "sku-pl-shared-v1"],
    ["keyword-rank", "keyword-rank-shared-v1"], ["content-changes", "content-changes-shared-v1"],
    ["fba-plan", "fba-plan-shared-v1"],
  ]) {
    assert.ok(src.includes(`reportKey: "${key}", reportVersion: "${version}"`), key + ": live route literal present");
  }
  assert.match(src, /reportKey: "content-changes"[\s\S]{0,220}params: \{ asOf:/, "live Content Changes params are keyed by asOf");
  assert.match(src, /reportKey: "daily-reporting"[\s\S]{0,220}params: \{ from, to, brand:/, "live Daily params carry from/to/brand");
  assert.match(src, /reportKey: "keyword-rank"[\s\S]{0,120}params: \{ to \}/, "live Keyword Rank params are { to }");
  for (const ident of ["SALES_MOVERS_VERSION", "LISTING_HEALTH_VERSION", "BUY_BOX_VERSION", "RETURNS_VERSION", "PPC_VERSION", "OPTIMIZER_VERSION"]) {
    assert.match(src, new RegExp("reportVersion: " + ident + ",[\\s\\S]{0,220}params: \\{ to \\}"), ident + ": live insight serves params { to }");
  }
});

// =================================================================================================
group("G. structural isolation: no browser route can promote; the scheduler never auto-publishes");

test("(G1) NO api/ route references the publisher or the rollout module (recursive)", () => {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : (e.name.endsWith(".js") ? [p] : []);
  });
  const files = walk(path.join(ROOT, "api"));
  assert.ok(files.length >= 4, "the api/ surface was actually scanned");
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    assert.ok(!src.includes("report-publisher"), path.relative(ROOT, f) + " must not import the publisher");
    assert.ok(!src.includes("publisher-composition"), path.relative(ROOT, f) + " must not import the trusted publisher composition");
    assert.ok(!src.includes("account-rollout"), path.relative(ROOT, f) + " must not import the rollout module");
    assert.ok(!src.includes("publishLiveSnapshotIfNewer"), path.relative(ROOT, f) + " must not reach the CAS publish primitive");
  }
});

test("(G2) the dispatcher never auto-publishes and the publisher touches no route", () => {
  const dispatcher = readFileSync(path.join(ROOT, "lib", "server", "sync", "sync-dispatch.js"), "utf8");
  assert.ok(!dispatcher.includes("report-publisher"), "a scheduled cycle can NEVER publish as a side effect");
  const publisher = readFileSync(path.join(ROOT, "lib", "server", "sync", "report-publisher.js"), "utf8");
  assert.ok(!/from "\.\.\/\.\.\/\.\.\/api\//.test(publisher), "the publisher imports no api route");
  assert.ok(!publisher.includes("supabase.js"), "the publisher is PURE DI -- production wiring stays outside");
});

test("(G3) the rollout-table wrappers need only SELECT/INSERT/UPDATE -- every runtime reference is a read (no write method), and NO DELETE targets the three tables (revoke/disable are UPDATEs, never DELETEs)", () => {
  const src = readFileSync(path.join(ROOT, "lib", "server", "supabase.js"), "utf8");
  const TABLES = ["scheduler_account_rollout", "scheduler_rollout_mode", "scheduler_publish_approvals"];
  for (const t of TABLES) {
    assert.ok(new RegExp(`/rest/v1/${t}\\b`).test(src), t + " is referenced by a wrapper");
    // Every runtime `request(...<table>...)` is a DEFAULT GET (read): no method option appears within the
    // request arguments after the URL. A POST/PATCH/DELETE against these tables would surface here.
    for (const method of ["POST", "PATCH", "DELETE"]) {
      assert.ok(!new RegExp(`/rest/v1/${t}\\b[\\s\\S]{0,300}?method:\\s*["']${method}["']`).test(src), `no ${method} request targets public.${t} (runtime wrappers only read)`);
      assert.ok(!new RegExp(`method:\\s*["']${method}["'][\\s\\S]{0,300}?/rest/v1/${t}\\b`).test(src), `no ${method} request targets public.${t} (method-first form)`);
    }
  }
  // The migration grants EXACTLY these three privileges -- SELECT for the wrappers, INSERT+UPDATE for the
  // operator's enable/approve (INSERT) and disable/revoke (UPDATE) in Appendix V. DELETE/TRUNCATE never needed.
  assert.ok(!/\bgrant\b[^;]*\b(delete|truncate|references|trigger|maintain)\b[^;]*\bto\s+service_role/i.test(realReadFile("20260816_account_rollout.sql")), "the migration never grants service_role delete/truncate/references/trigger/maintain");
});

// =================================================================================================

async function loadModules() {
  ({ resolveRolloutAccounts } = await import("../lib/server/sync/account-rollout.js"));
  ({ runSchedulerV2Shadow } = await import("../lib/server/sync/sync-dispatch.js"));
  ({ buildSchedulerV2Runtime, buildSchedulerV2CanaryRuntime, RUN_OPERATIONAL_ARGS } = await import("../lib/server/sync/runtime-composition.js"));
  ({ SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, PUBLISH_DISPOSITIONS, publishSchedulerV2Snapshot } = await import("../lib/server/sync/report-publisher.js"));
  ({ buildSchedulerV2Publisher } = await import("../lib/server/sync/publisher-composition.js"));
  ({ auditSchemaContract } = await import("../lib/server/sync/schema-contract.js"));
  ({ SCHEDULER_V2_READY_REPORT_KEYS, CONTROLLED_REPORT_KEYS } = await import("../lib/server/sync/report-controls.js"));
  ({ SHADOW_PLANNED_REPORT_KEYS } = await import("../lib/server/sync/report-planner.js"));
  ({ paramsHashFor } = await import("../lib/server/report-store.js"));
  // The GENUINE snapshot hash for the fixture params, from the SAME hasher the saver + publisher use.
  JOB_HASH = paramsHashFor(SHADOW_PARAMS.reportVersion, SHADOW_PARAMS);
  ({ getSchedulerAccountRollout, getSchedulerPublishApproval, publishLiveSnapshotIfNewer } = await import("../lib/server/supabase.js"));
  const sm = await import("../lib/server/reports/sales-movers.js");
  const lh = await import("../lib/server/reports/listing-health.js");
  const bb = await import("../lib/server/reports/buy-box.js");
  const rl = await import("../lib/server/reports/returns.js");
  const ppc = await import("../lib/server/reports/ppc.js");
  const lo = await import("../lib/server/reports/listing-optimizer.js");
  insightConsts = {
    "sales-movers": [sm.SALES_MOVERS_REPORT_KEY, sm.SALES_MOVERS_VERSION],
    "listing-health": [lh.LISTING_HEALTH_REPORT_KEY, lh.LISTING_HEALTH_VERSION],
    "buy-box-loss": [bb.BUY_BOX_REPORT_KEY, bb.BUY_BOX_VERSION],
    "returns-leakage": [rl.RETURNS_REPORT_KEY, rl.RETURNS_VERSION],
    "ppc-performance": [ppc.PPC_REPORT_KEY, ppc.PPC_VERSION],
    "listing-optimizer": [lo.OPTIMIZER_REPORT_KEY, lo.OPTIMIZER_VERSION],
  };
}

async function main() {
  await loadModules();
  for (const t of tests) {
    if (t.marker) { out("== " + t.marker); continue; }
    try {
      await t.fn();
      passed += 1;
      out("  ok  " + t.name);
    } catch (e) {
      out("FAIL  " + t.name);
      throw e;
    }
  }
  out(passed + " checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
