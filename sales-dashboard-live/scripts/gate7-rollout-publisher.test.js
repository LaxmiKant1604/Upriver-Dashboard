// Gate-7 -- durable ACCOUNT ROLLOUT + reviewed SHADOW-TO-LIVE PUBLISHER regressions.
//
// Proves, with ZERO real DataDoe/Supabase (every backend injected; the wrapper tests stub global fetch):
//   1.  DEFAULT locked/empty controls => a real scheduled invocation performs ZERO discovery / cycle /
//       export / publish work (drained no-op before any I/O);
//   2.  a scheduled run with READY reports but NO trusted rollout loader REFUSES to dispatch (fail closed);
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
//       report enable + durable account enable + explicit publish approval ALL hold;
//   12. publish exactly once; a replay is idempotent (already-current); a newer live snapshot wins
//       (newer-live); failed/blocked/running/invalid/stale snapshots NEVER touch live (LKG preserved);
//       wrong report/account/params/version can never publish; dispositions are typed-safe only;
//   13. all 13 scheduler->live report_key/reportVersion/params mappings are STATICALLY PINNED against the
//       real live route truths (api/datadoe.js literals + the insight modules' exported constants);
//   14. STRUCTURAL isolation: no api/ route (browser-reachable surface) imports the publisher or the
//       rollout module, the dispatcher never auto-publishes, and the v2 code lock is still frozen EMPTY.
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
let buildSchedulerV2Runtime, RUN_OPERATIONAL_ARGS;
let SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, PUBLISH_DISPOSITIONS, publishSchedulerV2Snapshot;
let SCHEDULER_V2_READY_REPORT_KEYS;
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
function mkPubDeps(over = {}) {
  const calls = { settings: 0, rollout: 0, approval: 0, job: 0, shadow: 0, publish: [] };
  const shadow = {
    params: { reportVersion: dash("sales", "movers") + "/v2d-1", accountId: "IN1", to: "2026-08-14" },
    // A payload the REAL sales-movers derivation validator accepts as an AVAILABLE result.
    payload: {
      accountId: "IN1", asOf: "2026-08-14", dataUnavailable: false, rows: [], catalogBrands: [],
      salesLatestDate: "2026-08-13", currencies: ["INR"], buyBoxEvaluated: false,
      inventoryAvailable: true, inventorySnapshotDate: "2026-08-13", windows: { recent: {}, prior: {} },
    },
    source_refreshed_at: SHADOW_TS,
  };
  const seen = { shadowKey: null, shadowAcct: null };
  const deps = {
    codeReadyKeys: [dash("sales", "movers")],
    getReportSyncSettings: async () => { calls.settings += 1; return [{ report_key: dash("sales", "movers"), schedule_enabled: true }]; },
    loadAccountRollout: async () => { calls.rollout += 1; return { read: "ok", allPrimary: false, enabledAccountIds: ["IN1"] }; },
    getPublishApproval: async () => { calls.approval += 1; return { read: "ok", approved: true }; },
    getLatestReportJob: async () => { calls.job += 1; return { derive_status: "succeeded", save_status: "succeeded", cycle_status: "succeeded" }; },
    getShadowSnapshot: async (k, a) => { calls.shadow += 1; seen.shadowKey = k; seen.shadowAcct = a; return "shadow" in over ? over.shadow : shadow; },
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

test("(A2) allowlist mode selects by EXACT public id only; stale rows match nothing and are reported", () => {
  const disc = [{ accountId: "US1", country: "US" }, IN1, IN2];
  const r = resolveRolloutAccounts({ read: "ok", allPrimary: false, enabledAccountIds: [" IN1 ", "GONE9"] }, disc);
  assert.deepEqual(r.selectedIds, ["IN1"], "exact-id match only (trimmed)");
  assert.deepEqual(r.accounts, [IN1], "discovery order preserved; original row object kept");
  assert.deepEqual(r.staleIds, ["GONE9"], "unknown allowlist row reported stale, selects nothing");
  assert.equal(r.reason, "allowlist");
  // A partial/prefix/case id can never match.
  const r2 = resolveRolloutAccounts({ read: "ok", allPrimary: false, enabledAccountIds: ["IN", "in1", "IN11"] }, disc);
  assert.deepEqual(r2.accounts, [], "no wildcard, no prefix, no case-folding");
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

test("(B10) a MANUAL shadow canary is unchanged: no rollout loader needed, accounts NOT rollout-filtered", async () => {
  const GK = SHADOW_PLANNED_REPORT_KEYS[0];
  const { promise } = dispatch({ manualReportKeys: [GK], controlCatalog: mkCatalog([GK]), accounts: US_ACCTS });
  const r = await promise; // no loadAccountRollout passed -- must NOT throw
  assert.equal(r.manual, true);
  assert.deepEqual(r.accountsDispatched, ["A1"], "manual scope = the operator's explicit run, not the durable rollout");
  assert.equal(r.accountRollout, null, "no rollout filtering on the manual path");
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
    if (rec.url.includes("scheduler_account_rollout")) return { json: [{ account_id: " IN1 " }, { account_id: "" }] };
    return { json: [] };
  });
  try {
    const ok = await getSchedulerAccountRollout();
    assert.deepEqual(ok, { read: "ok", allPrimary: false, enabledAccountIds: ["IN1"] }, "trimmed, empties dropped");
  } finally { s.restore(); }
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

test("(D3) publishLiveSnapshotIfNewer: insert-if-absent, strictly-older guarded PATCH, one natural-key row only", async () => {
  const args = { reportKey: SM, accountId: "IN1", paramsHash: "h".repeat(40), params: { reportVersion: SM + "-v1", to: "2026-08-14" }, payload: { ok: true }, payloadBytes: 11, sourceRefreshedAt: SHADOW_TS };
  // (a) inserted: the row did not exist.
  let s = stubFetch(() => ({ json: [{ report_key: SM }] }));
  try {
    const r = await publishLiveSnapshotIfNewer(args);
    assert.deepEqual(r, { outcome: "inserted", liveRefreshedAt: SHADOW_TS });
    assert.equal(s.calls.length, 1, "one write, nothing else");
    assert.ok(s.calls[0].url.includes("on_conflict=report_key,account_id,params_hash"), "natural-key conflict target");
    assert.equal(s.calls[0].headers.Prefer, "resolution=ignore-duplicates,return=representation", "idempotent insert");
    assert.equal(s.calls[0].body.report_key, SM);
    assert.equal(s.calls[0].body.account_id, "IN1");
    assert.equal(s.calls[0].body.source_refreshed_at, SHADOW_TS);
  } finally { s.restore(); }
  // (b) replaced: conflict, live row strictly OLDER -- the guarded PATCH targets ONLY the one natural-key row.
  s = stubFetch((rec, n) => (n === 1 ? { json: [] } : { json: [{ report_key: SM }] }));
  try {
    const r = await publishLiveSnapshotIfNewer(args);
    assert.equal(r.outcome, "replaced");
    assert.equal(s.calls[1].method, "PATCH");
    const patchUrl = decodeURIComponent(s.calls[1].url);
    assert.ok(patchUrl.includes("report_key=eq." + SM), "pinned to the exact report");
    assert.ok(patchUrl.includes("account_id=eq.IN1"), "pinned to the exact account");
    assert.ok(patchUrl.includes("params_hash=eq." + args.paramsHash), "pinned to the exact params identity");
    assert.ok(patchUrl.includes("source_refreshed_at=lt." + SHADOW_TS), "replaces ONLY a strictly-older live row");
  } finally { s.restore(); }
  // (c) skipped: conflict and NOT older -- live wins; the live timestamp is read back for classification.
  s = stubFetch((rec, n) => (n <= 2 ? { json: [] } : { json: [{ source_refreshed_at: "2026-08-20T00:00:00.000Z" }] }));
  try {
    const r = await publishLiveSnapshotIfNewer(args);
    assert.deepEqual(r, { outcome: "skipped", liveRefreshedAt: "2026-08-20T00:00:00.000Z" });
    assert.equal(s.calls[2].method, "GET", "the third call is a read, never a write");
  } finally { s.restore(); }
});

// =================================================================================================
group("E. publisher: disabled by default; 4 independent gates; CAS; typed dispositions; LKG preserved");

test("(E1) DEFAULT = code-locked: the frozen-empty ready set disables publishing before ANY collaborator runs", async () => {
  assert.deepEqual([...SCHEDULER_V2_READY_REPORT_KEYS], [], "the v2 code lock is still frozen EMPTY");
  const h = mkPubDeps({ deps: { codeReadyKeys: undefined } });
  delete h.deps.codeReadyKeys; // fall back to the production default (SCHEDULER_V2_READY_REPORT_KEYS)
  const res = await publishSchedulerV2Snapshot(h.deps, { reportKey: SM, accountId: "IN1" });
  observedDispositions.add(res.disposition);
  assert.equal(res.disposition, "code-locked");
  assert.deepEqual([h.calls.settings, h.calls.rollout, h.calls.approval, h.calls.job, h.calls.shadow, h.calls.publish.length], [0, 0, 0, 0, 0, 0], "zero collaborator calls");
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
  // A dd-secondary account can never publish, even under all-primary.
  const sec = await pub({ deps: { loadAccountRollout: okAllPrimary } }, { reportKey: SM, accountId: SEC_ID });
  assert.equal(sec.res.disposition, "account-disabled");
  assert.equal(sec.calls.publish.length, 0);
});

test("(E3) only a derive+save-SUCCEEDED job in a TERMINAL succeeded/partial cycle can publish; all else preserves live LKG", async () => {
  const bad = [
    null,
    { derive_status: "failed", save_status: "pending", cycle_status: "succeeded" },
    { derive_status: "succeeded", save_status: "failed", cycle_status: "succeeded" },
    { derive_status: "skipped", save_status: "skipped", cycle_status: "succeeded" }, // blocked report
    { derive_status: "succeeded", save_status: "succeeded", cycle_status: "running" },
    { derive_status: "succeeded", save_status: "succeeded", cycle_status: "failed" },
    { derive_status: "succeeded", save_status: "succeeded", cycle_status: null },
  ];
  for (const job of bad) {
    const { res, calls } = await pub({ deps: { getLatestReportJob: async () => job } });
    assert.equal(res.disposition, "not-successful");
    assert.equal(calls.publish.length, 0, "live LKG untouched");
  }
  const partial = await pub({ deps: { getLatestReportJob: async () => ({ derive_status: "succeeded", save_status: "succeeded", cycle_status: "partial" }) } });
  assert.equal(partial.res.disposition, "published", "a partial cycle WITH this exact report succeeded may publish");
});

test("(E4) an unavailable/blocked/invalid/truncated/stale/null/malformed snapshot can NEVER publish", async () => {
  const good = mkPubDeps().shadow;
  const variants = [
    ["null snapshot", null],
    ["wrong report version", { ...good, params: { ...good.params, reportVersion: SM + "/v2d-0" } }],
    ["wrong account identity", { ...good, params: { ...good.params, accountId: "US9" } }],
    ["payload fails the derivation validator", { ...good, payload: { accountId: "IN1", asOf: "2026-08-14" } }],
    ["structurally-valid but UNAVAILABLE payload", { ...good, payload: { accountId: "IN1", asOf: "2026-08-14", dataUnavailable: true, rows: [], catalogBrands: [], salesLatestDate: null } }],
    ["null payload", { ...good, payload: null }],
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

test("(E5) publish EXACTLY ONCE with the EXACT live identity the frontend reads", async () => {
  const { res, calls, seen, shadow } = await pub();
  assert.equal(res.disposition, "published");
  assert.equal(seen.shadowKey, "scheduler-v2/" + SM, "reads the exact scheduler-v2/<reportKey> shadow identity");
  assert.equal(seen.shadowAcct, "IN1");
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

test("(E6) a REPLAY is idempotent and a NEWER live snapshot always wins; a transport failure is a typed safe disposition", async () => {
  const replay = await pub({ publishRes: { outcome: "skipped", liveRefreshedAt: SHADOW_TS } });
  assert.equal(replay.res.disposition, "already-current", "same timestamp => replay, no duplicate");
  const newer = await pub({ publishRes: { outcome: "skipped", liveRefreshedAt: "2026-08-20T00:00:00.000Z" } });
  assert.equal(newer.res.disposition, "newer-live", "a newer live row is never overwritten");
  const failed = await pub({ publishThrows: true });
  assert.equal(failed.res.disposition, "publish-failed");
  assert.deepEqual(Object.keys(failed.res).sort(), ["accountId", "disposition", "reportKey"], "typed safe fields ONLY -- no raw error leaks");
});

test("(E7) every observed disposition is in the typed PUBLISH_DISPOSITIONS contract", () => {
  assert.ok(observedDispositions.size >= 9, "the suite exercised the disposition space");
  for (const d of observedDispositions) assert.ok(PUBLISH_DISPOSITIONS.includes(d), d + " is a declared typed disposition");
});

// =================================================================================================
group("F. all 13 scheduler->live mappings statically pinned against the REAL live route truths");

test("(F1) exactly 13 contracts; key/version/params pinned; insight versions equal the live modules' constants", () => {
  const EXPECTED_VERSIONS = {
    "brand-sales": "brand-sales-shared-v1",
    "daily-reporting": "daily-reporting-shared-v1",
    reconciliation: "reconciliation-shared-v1",
    "sku-pl": "sku-pl-shared-v1",
    "keyword-rank": "keyword-rank-shared-v1",
    "content-changes": "content-changes-shared-v1",
    "fba-plan": "fba-plan-shared-v1",
    "sales-movers": "sales-movers-v1",
    "listing-health": "listing-health-v1",
    "buy-box-loss": "buy-box-loss-v1",
    "returns-leakage": "returns-leakage-v1",
    "ppc-performance": "ppc-performance-v1",
    "listing-optimizer": "listing-optimizer-v1",
  };
  assert.ok(Object.isFrozen(SCHEDULER_LIVE_SNAPSHOT_CONTRACTS), "the contract table is frozen");
  assert.deepEqual(Object.keys(SCHEDULER_LIVE_SNAPSHOT_CONTRACTS).sort(), Object.keys(EXPECTED_VERSIONS).sort(), "exactly the 13 scheduler reports");
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

test("(F3) the pinned shared mappings appear VERBATIM in the live api/datadoe.js route", () => {
  const src = readFileSync(path.join(ROOT, "api", "datadoe.js"), "utf8");
  for (const [key, version] of [
    ["brand-sales", "brand-sales-shared-v1"], ["daily-reporting", "daily-reporting-shared-v1"],
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

// =================================================================================================

async function loadModules() {
  ({ resolveRolloutAccounts } = await import("../lib/server/sync/account-rollout.js"));
  ({ runSchedulerV2Shadow } = await import("../lib/server/sync/sync-dispatch.js"));
  ({ buildSchedulerV2Runtime, RUN_OPERATIONAL_ARGS } = await import("../lib/server/sync/runtime-composition.js"));
  ({ SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, PUBLISH_DISPOSITIONS, publishSchedulerV2Snapshot } = await import("../lib/server/sync/report-publisher.js"));
  ({ SCHEDULER_V2_READY_REPORT_KEYS } = await import("../lib/server/sync/report-controls.js"));
  ({ SHADOW_PLANNED_REPORT_KEYS } = await import("../lib/server/sync/report-planner.js"));
  ({ paramsHashFor } = await import("../lib/server/report-store.js"));
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
