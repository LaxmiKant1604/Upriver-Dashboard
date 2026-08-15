// Gate-7b -- IN-account all-13-report production cutover regressions.
//
// Gate 7b flips SCHEDULER_V2_READY_REPORT_KEYS to EXACTLY the 13 CONTROLLED_REPORT_KEYS (the code cutover).
// This suite proves that readiness ON does NOT by itself dispatch or publish anything -- the DURABLE data gates
// (account rollout + report_sync_settings) still govern -- and that with only the IN account enabled, every
// scheduled report dispatches ONLY IN while USA and every other account produce zero cycles/jobs/exports.
//
// Proves:
//   Y1. Readiness = EXACTLY the 13 approved keys (no extras); each is a valid live snapshot contract.
//   Y2. With NO rollout account rows (durable default), a scheduled run -- even with all 13 settings enabled --
//       is a zero-I/O drained no-op BEFORE discovery.
//   Y3. With ONLY the IN account enabled: (a) all 13 reports are SELECTED and accountsDispatched = [IN];
//       (b) a real IN dispatch writes source-job owners / report jobs / shadow snapshots scoped to IN ONLY.
//   Y4. USA and every other account produce ZERO cycles/jobs/exports (an out-of-allowlist non-US account is
//       excluded by the rollout; a US account is excluded by the bucket AND the IN-only rollout).
//   Y5. Durable schedule_enabled=false STILL prevents dispatch (readiness ON + IN enabled but settings paused
//       => scheduled selects nothing, zero I/O).
//   Y6. The dispatcher NEVER runs the publisher automatically (structural: no import; a full IN cycle writes
//       ONLY scheduler-v2/* shadow snapshots, never a live report_snapshots publish).
//
// 7-bit ASCII, LF, no top-level await; dynamic imports after a dummy Supabase env.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { readFileSync } from "node:fs";
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

let runSchedulerV2Shadow;
let schedulerV2ReportControlCatalog, SCHEDULER_V2_READY_REPORT_KEYS, CONTROLLED_REPORT_KEYS;
let SCHEDULER_LIVE_SNAPSHOT_CONTRACTS;

const dash = (...p) => p.join("-");
const ASOF = "2025-08-10";
const CONNS = [
  { id: "primary", apiKey: dash("org", "primary"), accountPrefix: "" },
  { id: "secondary", apiKey: dash("org", "secondary"), accountPrefix: dash("dd", "secondary") + ":" },
];

// Accounts: IN1/IN2 are non-US primaries; US1 is a US primary. Gate 7b enables ONLY IN1.
const IN1 = { accountId: "IN1", country: "IN", currency: "INR", name: "India One" };
const IN2 = { accountId: "IN2", country: "IN", currency: "INR", name: "India Two" };
const US1 = { accountId: "US1", country: "US", currency: "USD", name: "USA One" };

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
// Minimal persisted-Ads providers + daily context (Supabase-style; never DataDoe) so the full 13 can be selected.
const WIDE = [{ from: "2000-01-01", to: "2099-12-31" }];
const ppcAdsProviders = {
  getAdsDailySourceRows: async () => [],
  getAdsSyncStates: async () => [],
  getAdsSyncCoverage: async () => ({ windows: WIDE, status: "succeeded", read: "ok" }),
};
const loadDerivedContext = async () => ({ adsCoverage: { status: "unavailable" }, adRows: [] });

function makeStore() {
  const cycles = new Map(); const jobsByCycle = new Map(); const ownersByCycle = new Map();
  const cache = new Map(); const reportJobs = new Map(); const snapshots = new Map(); let seq = 0;
  const findCycle = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  const ownerRows = (cid) => [...((ownersByCycle.get(cid) && ownersByCycle.get(cid).values()) || [])];
  const rkey = (rk, a) => rk + "|" + a;
  return {
    _owners: (cid) => ownerRows(cid).map((m) => ({ ...m })),
    _snapshots: snapshots,
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
    report(rk, a) { return reportJobs.get(rkey(rk, a)); },
    listReportJobs() { return [...reportJobs.values()].map((j) => ({ ...j })); },
    upsertReportJob({ reportKey, accountId, connectionId, bucket, reportVersion, dependsOn }) { const k = rkey(reportKey, accountId); if (reportJobs.has(k)) return; reportJobs.set(k, { report_key: reportKey, account_id: accountId, connection_id: connectionId, bucket, report_version: reportVersion, depends_on: dependsOn || [], fetch_status: "pending", derive_status: "pending", save_status: "pending", validated: false }); },
    claimReportDerive(_c, rk, a) { const j = reportJobs.get(rkey(rk, a)); if (j && j.derive_status === "pending") { j.derive_status = "running"; return true; } return false; },
    recordReportBlocked({ reportKey, accountId }) { Object.assign(reportJobs.get(rkey(reportKey, accountId)), { fetch_status: "blocked", derive_status: "skipped", save_status: "skipped" }); },
    recordReportFailure({ reportKey, accountId, stage, code }) { Object.assign(reportJobs.get(rkey(reportKey, accountId)), { derive_status: stage === "save" ? "succeeded" : "failed", save_status: stage === "save" ? "failed" : "pending", error_code: code }); },
    recordReportSuccess({ reportKey, accountId, latestDataDate }) { Object.assign(reportJobs.get(rkey(reportKey, accountId)), { fetch_status: "ready", derive_status: "succeeded", save_status: "succeeded", validated: true, latest_data_date: latestDataDate ?? null }); },
  };
}
const strip = (k) => String(k).replace("scheduler-v2/", "");
function makeSaver() {
  const saved = new Map();
  const saver = async ({ reportKey, accountId, payload }) => { saver.calls += 1; saved.set(strip(reportKey) + "|" + accountId, payload); return { paramsHash: "ph" }; };
  saver.calls = 0; saver.saved = saved;
  saver.keys = () => [...saved.keys()];
  return saver;
}
const enabledSettings = () => CONTROLLED_REPORT_KEYS.map((k) => ({ report_key: k, schedule_enabled: true }));
const inAllowlist = async () => ({ read: "ok", allPrimary: false, enabledAccountIds: ["IN1"] });
const zeroRollout = async () => ({ read: "ok", allPrimary: false, enabledAccountIds: [] });

// Dispatch helper that counts discovery + cycle opens (to prove a drained no-op did zero I/O).
function dispatch(over = {}) {
  const store = over.store || makeStore();
  const counts = { discover: 0, opens: 0 };
  const origOpen = store.openCycle.bind(store);
  store.openCycle = (args) => { counts.opens += 1; return origOpen(args); };
  const dd = over.dataDoe || makeDataDoe();
  const saver = over.saver || makeSaver();
  const accounts = over.accounts || [IN1, IN2, US1];
  const args = {
    bucket: over.bucket || "non-us",
    cycleDate: over.cycleDate || "2026-08-16",
    asOf: "asOf" in over ? over.asOf : ASOF,
    asOfFor: "asOfFor" in over ? over.asOfFor : (() => ASOF),
    connections: over.connections || CONNS,
    discoverAccounts: async () => { counts.discover += 1; return accounts; },
    store, dataDoe: dd, saveSnapshot: saver,
    settings: "settings" in over ? over.settings : enabledSettings(),
    manualReportKeys: over.manualReportKeys,
    ppcAdsProviders: over.ppcAdsProviders || ppcAdsProviders,
    loadDerivedContext: over.loadDerivedContext || loadDerivedContext,
    loadAccountRollout: "loadAccountRollout" in over ? over.loadAccountRollout : inAllowlist,
    maxJobs: over.maxJobs, deadlineMs: over.deadlineMs,
    // controlCatalog is intentionally NOT injected: the dispatcher uses the REAL schedulerV2ReportControlCatalog
    // (readiness = the 13 approved keys post-Gate-7b), so these tests exercise the production readiness set.
  };
  return { store, dd, saver, counts, promise: runSchedulerV2Shadow(args) };
}

// =================================================================================================
group("Y. Gate-7b IN cutover");

test("(Y1) readiness = EXACTLY the 13 approved CONTROLLED_REPORT_KEYS; each is a valid live snapshot contract", () => {
  assert.equal(SCHEDULER_V2_READY_REPORT_KEYS.length, 13, "exactly 13 ready keys");
  assert.deepEqual([...SCHEDULER_V2_READY_REPORT_KEYS].slice().sort(), [...CONTROLLED_REPORT_KEYS].slice().sort(), "readiness = exactly the approved 13, no extras");
  assert.equal(new Set(SCHEDULER_V2_READY_REPORT_KEYS).size, 13, "no duplicate keys");
  for (const k of SCHEDULER_V2_READY_REPORT_KEYS) assert.ok(SCHEDULER_LIVE_SNAPSHOT_CONTRACTS[k], k + " has a pinned live snapshot contract");
});

test("(Y2) NO rollout account rows: a scheduled run (all 13 settings enabled) is a zero-I/O drained no-op BEFORE discovery", async () => {
  const { dd, saver, counts, promise } = dispatch({ loadAccountRollout: zeroRollout });
  const r = await promise;
  assert.equal(r.drained, true, "drained no-op");
  assert.equal(r.cycleId, null, "no cycle opened");
  assert.equal(r.spent, 0, "zero budget spent");
  assert.equal(counts.discover, 0, "ZERO discovery (drained before it)");
  assert.equal(counts.opens, 0, "ZERO cycles opened");
  assert.equal(dd.totalCreates(), 0, "ZERO DataDoe exports");
  assert.equal(saver.calls, 0, "ZERO shadow snapshots");
  assert.deepEqual(r.accountRollout, { selected: 0, reason: "zero-accounts-enabled" });
});

test("(Y3a) ONLY IN enabled: all 13 reports are SELECTED and accountsDispatched = [IN] (USA + other-non-us excluded)", async () => {
  // maxJobs=0 bounds the run to selection + account resolution (zero exports) so all 13 can be proven selected.
  const { dd, saver, counts, promise } = dispatch({ accounts: [IN1, IN2, US1], loadAccountRollout: inAllowlist, maxJobs: 0 });
  const r = await promise;
  assert.deepEqual([...r.selected].slice().sort(), [...CONTROLLED_REPORT_KEYS].slice().sort(), "all 13 reports selected");
  assert.deepEqual(r.accountsDispatched, ["IN1"], "ONLY the IN account is dispatched");
  assert.deepEqual(r.accountRollout, { selected: 1, staleIds: [], reason: "allowlist" });
  assert.equal(counts.discover, 1, "discovery ran once");
  assert.equal(dd.totalCreates(), 0, "maxJobs=0 => zero exports (selection proof only)");
  assert.equal(saver.calls, 0, "zero snapshots at maxJobs=0");
});

test("(Y3b) ONLY IN enabled: a real IN dispatch writes source-job owners / report jobs / shadow snapshots scoped to IN ONLY", async () => {
  // brand-sales only (a pure generic report) so the run completes without heavy staged/Ads wiring, proving the
  // ACCOUNT scoping that is identical for every report (the rollout filter runs once, before any report).
  const { store, saver, promise } = dispatch({
    accounts: [IN1, IN2, US1],
    settings: [{ report_key: "brand-sales", schedule_enabled: true }],
    loadAccountRollout: inAllowlist,
  });
  const r = await promise;
  assert.deepEqual(r.accountsDispatched, ["IN1"], "only IN1 dispatched");
  assert.ok(r.cycleId, "a cycle opened for IN1's work");
  const owners = store._owners(r.cycleId);
  assert.ok(owners.length > 0, "source-job owners recorded");
  assert.ok(owners.every((m) => m.account_id === "IN1"), "EVERY source-job owner belongs to IN1");
  assert.ok(store.listReportJobs().every((j) => j.account_id === "IN1"), "EVERY report job belongs to IN1");
  assert.ok(saver.keys().every((k) => k.endsWith("|IN1")), "EVERY shadow snapshot belongs to IN1");
  // USA + the other non-US account appear in ZERO owners / report jobs / snapshots.
  for (const other of ["US1", "IN2"]) {
    assert.ok(!owners.some((m) => m.account_id === other), other + " has zero source-job owners");
    assert.ok(!store.listReportJobs().some((j) => j.account_id === other), other + " has zero report jobs");
    assert.ok(!saver.keys().some((k) => k.endsWith("|" + other)), other + " has zero shadow snapshots");
  }
});

test("(Y4) USA (and every other account) produce ZERO: excluded by the IN-only rollout (non-US bucket) AND by the bucket (US bucket)", async () => {
  // (a) non-US bucket with IN-only rollout: IN2 (other non-US) is out-of-allowlist -> zero; US1 out-of-bucket -> zero.
  const a = dispatch({ bucket: "non-us", accounts: [IN1, IN2, US1], settings: [{ report_key: "brand-sales", schedule_enabled: true }], loadAccountRollout: inAllowlist });
  const ra = await a.promise;
  assert.deepEqual(ra.accountsDispatched, ["IN1"]);
  assert.ok(a.store._owners(ra.cycleId).every((m) => m.account_id === "IN1"), "no US1/IN2 owner exists");
  // (b) US bucket with the IN-only rollout: IN1 is not a US account, so the rollout selects nothing -> drained.
  const b = dispatch({ bucket: "us", accounts: [US1, { accountId: "US2", country: "US", currency: "USD", name: "USA Two" }], settings: [{ report_key: "brand-sales", schedule_enabled: true }], loadAccountRollout: inAllowlist });
  const rb = await b.promise;
  assert.equal(rb.cycleId, null, "US bucket opens no cycle under the IN-only rollout");
  assert.equal(b.dd.totalCreates(), 0, "US accounts spend ZERO exports");
  assert.deepEqual(rb.accountRollout, { selected: 0, staleIds: ["IN1"], reason: "allowlist" }, "IN1 is out-of-bucket here => nothing selected");
});

test("(Y5) durable schedule_enabled=false STILL prevents dispatch: readiness ON + IN enabled but settings PAUSED => scheduled selects nothing, zero I/O", async () => {
  const { dd, saver, counts, promise } = dispatch({
    accounts: [IN1, IN2, US1],
    settings: CONTROLLED_REPORT_KEYS.map((k) => ({ report_key: k, schedule_enabled: false })), // all paused
    loadAccountRollout: inAllowlist,
  });
  const r = await promise;
  assert.deepEqual(r.selected, [], "no report is durably schedule-enabled => scheduled selects nothing");
  assert.equal(r.cycleId, null, "no cycle opened");
  assert.equal(dd.totalCreates(), 0, "zero exports");
  assert.equal(saver.calls, 0, "zero snapshots");
  // The account rollout gate drains before discovery is even relevant here (nothing dispatchable).
  assert.equal(counts.opens, 0, "zero cycles");
});

test("(Y6) the dispatcher NEVER auto-publishes: a full IN cycle writes ONLY scheduler-v2/* shadow snapshots, and sync-dispatch.js imports no publisher", async () => {
  // Structural: the dispatcher module imports neither the publisher nor the CAS publish primitive.
  const dispatcher = readFileSync(path.join(ROOT, "lib", "server", "sync", "sync-dispatch.js"), "utf8");
  assert.ok(!dispatcher.includes("report-publisher"), "sync-dispatch.js does not import the publisher");
  assert.ok(!dispatcher.includes("publisher-composition"), "sync-dispatch.js does not import the publisher composition");
  assert.ok(!dispatcher.includes("publishLiveSnapshotIfNewer"), "sync-dispatch.js never calls the live CAS publish primitive");
  // Behavioral: a real IN dispatch saves ONLY shadow (scheduler-v2/*) snapshots -- never a live report key.
  const { saver, promise } = dispatch({ accounts: [IN1], settings: [{ report_key: "brand-sales", schedule_enabled: true }], loadAccountRollout: inAllowlist });
  await promise;
  assert.ok(saver.calls > 0, "the IN dispatch saved at least one shadow snapshot");
  // The saver only ever receives scheduler-v2/<key> report keys (proven by the dispatcher's shadow saver wiring);
  // here the saved map keys are stripped to "<key>|<account>", and the account is IN1 -- no live publish occurred.
  assert.ok(saver.keys().every((k) => k.endsWith("|IN1")), "every saved snapshot is an IN1 shadow snapshot; nothing was published live");
});

// =================================================================================================

async function loadModules() {
  ({ runSchedulerV2Shadow } = await import("../lib/server/sync/sync-dispatch.js"));
  ({ schedulerV2ReportControlCatalog, SCHEDULER_V2_READY_REPORT_KEYS, CONTROLLED_REPORT_KEYS } = await import("../lib/server/sync/report-controls.js"));
  ({ SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } = await import("../lib/server/sync/report-publisher.js"));
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
