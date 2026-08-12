// Phase 1e -- canonical Scheduler v2 SHADOW dispatcher tests.
//
// Proves, with ZERO real DataDoe/Supabase (store + dataDoe + account directory + persisted-Ads readers +
// snapshot saver all injected):
//   * report keys route through EXACTLY ONE canonical path (generic plan, each dedicated staged cycle,
//     derived-only no-source, unsupported => fail closed);
//   * report-level controls/readiness gate work: only enabled reports dispatch; a locked/paused report spends
//     zero exports; a manual request runs only the named report; no report is unlocked;
//   * dynamic primary-account discovery (a newly connected primary account participates automatically) and
//     primary-only routing (a stale dd-secondary is skipped read-only, never routed through the primary key);
//   * shared canonical source hashes dedup across report owners (one export, both owners active);
//   * one cumulative maxJobs + deadline budget across all drivers, with deferral/resume and NO duplicate
//     create-export; a partial report stays pending then later saves exactly once; a failed report never
//     blocks an unrelated ready report; derivation makes zero DataDoe/network calls.
//
// 7-bit ASCII, LF, no top-level await; dynamic imports after a dummy Supabase env.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = process.env[SB_KEY_ENV] || ["test", "svc", "role", "key"].join("-");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const group = (label) => tests.push({ marker: label });
const START = Date.now();
const mark = (m) => { try { writeSync(2, "[+" + (Date.now() - START) + "ms] " + m + "\n"); } catch (_e) { /* ignore */ } };
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

let runSchedulerV2Shadow, classifySchedulerV2ReportKey, selectSchedulerV2ReportKeys;
let buildShadowReportPlan, SHADOW_PLANNED_REPORT_KEYS, STAGED_CYCLE_REPORT_KEYS;

const ASOF = "2025-08-10";
const LO_DATE = "2025-06-01"; // inside [asOf-84d, asOf]
const dash = (...p) => p.join("-");
const CONNS = [
  { id: "primary", apiKey: dash("org", "primary"), accountPrefix: "" },
  { id: "secondary", apiKey: dash("org", "secondary"), accountPrefix: dash("dd", "secondary") + ":" },
];
const asOfForUS = () => ASOF;

// ---- injected backends -------------------------------------------------------------------

// Rows a succeeded source download returns, keyed by requestKey. Listing Optimizer gets faithful rows so its
// derive succeeds; other reports get minimal rows (their strict derives may go unavailable/invalid -- that is
// isolated and never asserted as success here, only their SOURCE routing/dedup is).
function rowsFor(job) {
  const rk = job.requestKey || "";
  if (rk === "listing-optimizer:sqp-weekly") return [{ date: LO_DATE, child_asin: "A", search_query: "q" }];
  if (rk === "listing-optimizer:catalog") return [{ child_asin: "A", product_brand: "Acme" }];
  if (rk.endsWith(":catalog")) return [{ child_asin: "A", parent_asin: "P", product_name: "P", product_brand: "Acme" }];
  return [{ x: 1 }];
}

function makeDataDoe(opts = {}) {
  const create = {};
  const pollHits = {};
  const deadlineErr = () => Object.assign(new Error("deferred"), { code: "DATADOE_DEADLINE" });
  return {
    createCount: (h) => create[h] || 0,
    totalCreates: () => Object.values(create).reduce((a, b) => a + b, 0),
    async create(job) {
      create[job.requestHash] = (create[job.requestHash] || 0) + 1;
      if (opts.failCreateKey && (job.requestKey || "") === opts.failCreateKey) throw new Error("boom");
      return { exportId: "e_" + job.requestHash };
    },
    async poll(job) {
      const k = job.requestKey || "";
      if (opts.deferPollKey && k === opts.deferPollKey) { pollHits[k] = (pollHits[k] || 0) + 1; if (pollHits[k] === 1) throw deadlineErr(); }
    },
    async download(job) { return rowsFor(job); },
  };
}

// Combined source-job + report-job + owner + cache store (the shape runStagedSourceCycle, the dedicated
// cycles, and runReportJobs all share). Mirrors the proven store used by the generic-path report tests.
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

// A control catalog resolver: `ready` reports are runtime-ready; `enabled` (default = ready) are also
// schedule-enabled. The dispatcher consumes exactly this shape (reportControlCatalog's contract).
const mkCatalog = (ready = [], enabled = ready) => () => [...new Set([...ready, ...enabled])].map((rk) => ({ reportKey: rk, ready: ready.includes(rk), scheduleEnabled: enabled.includes(rk) }));

const strip = (k) => String(k).replace("scheduler-v2/", "");
function makeSaver() {
  const saved = new Map();
  const saver = async ({ reportKey, accountId, payload }) => { saver.calls += 1; saved.set(strip(reportKey) + "|" + accountId, payload); return { paramsHash: "ph" }; };
  saver.calls = 0;
  saver.saved = saved;
  saver.has = (rk, a) => saved.has(rk + "|" + a);
  return saver;
}

const US_ACCTS = [{ accountId: "A1", country: "US", currency: "USD", name: "Acct One" }];
const emptyAds = { getAdsDailySourceRows: async () => [], getAdsSyncStates: async () => [], getAdsSyncCoverage: async () => null };

// Dispatch helper with the common injected backends.
function dispatch(over = {}) {
  const store = over.store || makeStore();
  const dd = over.dataDoe || makeDataDoe(over.ddOpts || {});
  const saver = over.saver || makeSaver();
  const accounts = over.accounts || US_ACCTS;
  const p = runSchedulerV2Shadow({
    bucket: "us", cycleDate: "2026-08-11", asOf: ASOF, asOfFor: asOfForUS,
    connections: over.connections || CONNS,
    discoverAccounts: over.discoverAccounts || (async () => accounts),
    store, dataDoe: dd, saveSnapshot: saver,
    controlCatalog: over.controlCatalog, settings: over.settings, manualReportKeys: over.manualReportKeys,
    ppcAdsProviders: over.ppcAdsProviders, maxJobs: over.maxJobs, deadlineMs: over.deadlineMs, clock: over.clock,
  });
  return { store, dd, saver, promise: p };
}
const srcKeys = (store, cid) => store.listSourceJobs(cid).map((j) => j.request_key);

/* ============================= routing + selection + fail-closed ============================= */

group("scheduler-v2 dispatch: routing + selection + fail-closed");

test("classifySchedulerV2ReportKey maps each key to exactly one canonical route", () => {
  assert.equal(classifySchedulerV2ReportKey("keyword-rank"), "staged");
  assert.equal(classifySchedulerV2ReportKey("sales-movers"), "staged");
  assert.equal(classifySchedulerV2ReportKey("ppc-performance"), "staged");
  assert.equal(classifySchedulerV2ReportKey("listing-optimizer"), "staged");
  assert.equal(classifySchedulerV2ReportKey("buy-box-loss"), "generic");
  assert.equal(classifySchedulerV2ReportKey("returns-leakage"), "generic");
  assert.equal(classifySchedulerV2ReportKey("brand-directory"), "derived-only");
  assert.equal(classifySchedulerV2ReportKey("brand-sales"), "unsupported", "an adapter with no wired dispatch path is unsupported");
  assert.equal(classifySchedulerV2ReportKey("nope"), "unsupported");
});

test("selectSchedulerV2ReportKeys: scheduled selects ready+enabled; manual runs only the named keys", () => {
  const catalog = mkCatalog(["listing-optimizer", "buy-box-loss", "keyword-rank"], ["listing-optimizer", "buy-box-loss"]);
  const sched = selectSchedulerV2ReportKeys({ controlCatalog: catalog });
  assert.deepEqual(sched.requested.sort(), ["buy-box-loss", "listing-optimizer"], "keyword-rank is ready but NOT schedule-enabled => excluded");
  assert.equal(sched.manual, false);
  const man = selectSchedulerV2ReportKeys({ controlCatalog: catalog, manualReportKeys: ["keyword-rank"] });
  assert.deepEqual(man.requested, ["keyword-rank"]);
  assert.equal(man.manual, true);
  assert.ok(man.readySet.has("keyword-rank"), "readySet reflects runtime readiness for the lock gate");
});

test("an unsupported/ambiguous report key fails closed BEFORE any cycle or token", async () => {
  const { dd, promise } = dispatch({ manualReportKeys: ["brand-sales"], controlCatalog: mkCatalog(["brand-sales"]) });
  await assert.rejects(promise, /no canonical dispatch path.*brand-sales.*fail closed/s);
  assert.equal(dd.totalCreates(), 0, "zero exports on a fail-closed refusal");
});

test("dispatching ppc-performance without its persisted-Ads readers fails closed", async () => {
  const { promise } = dispatch({ manualReportKeys: ["ppc-performance"], controlCatalog: mkCatalog(["ppc-performance"]) });
  await assert.rejects(promise, /ppc-performance requires injected ppcAdsProviders.*fail closed/s);
});

/* ============================= controls / readiness ============================= */

group("scheduler-v2 dispatch: report controls + readiness");

test("(enabled-only) only ready+enabled reports dispatch; a ready-but-unscheduled report is not run", async () => {
  const catalog = mkCatalog(["listing-optimizer", "keyword-rank"], ["listing-optimizer"]); // keyword-rank ready but NOT enabled
  const { store, promise } = dispatch({ controlCatalog: catalog });
  const r = await promise;
  assert.deepEqual(r.selected, ["listing-optimizer"], "only the schedule-enabled ready report dispatched");
  assert.ok(srcKeys(store, r.cycleId).some((k) => k.startsWith("listing-optimizer:")), "listing-optimizer sources created");
  assert.ok(!srcKeys(store, r.cycleId).some((k) => k.startsWith("keyword-rank:")), "the unscheduled report created no sources");
});

test("(locked) a manual request for a NOT-ready report spends zero exports and never unlocks it", async () => {
  const { dd, promise } = dispatch({ manualReportKeys: ["keyword-rank"], controlCatalog: mkCatalog(["listing-optimizer"]) }); // keyword-rank not ready
  const r = await promise;
  assert.deepEqual(r.selected, [], "a locked report is never dispatched");
  assert.deepEqual(r.lockedOut, ["keyword-rank"], "it is reported locked-out");
  assert.equal(dd.totalCreates(), 0, "zero exports for a locked report");
});

test("(manual single) a manual request runs ONLY the named report even when others are enabled", async () => {
  const catalog = mkCatalog(["listing-optimizer", "buy-box-loss"], ["listing-optimizer", "buy-box-loss"]);
  const { store, promise } = dispatch({ manualReportKeys: ["listing-optimizer"], controlCatalog: catalog });
  const r = await promise;
  assert.deepEqual(r.selected, ["listing-optimizer"]);
  assert.ok(!srcKeys(store, r.cycleId).some((k) => k.startsWith("buy-box-loss:")), "the other enabled report is NOT run by a single-report manual request");
});

test("(derived-only) a derived-only report creates zero source jobs", async () => {
  const { store, dd, promise } = dispatch({ manualReportKeys: ["brand-directory"], controlCatalog: mkCatalog([]) });
  const r = await promise;
  assert.deepEqual(r.derivedOnly, ["brand-directory"]);
  assert.equal(dd.totalCreates(), 0, "zero DataDoe exports for a derived-only report");
  assert.equal(r.cycleId, null, "no source cycle opened");
  assert.equal(store.listReportJobs().length, 0, "no source-backed report job created");
});

/* ============================= discovery + primary-only ============================= */

group("scheduler-v2 dispatch: dynamic discovery + primary-only routing");

test("(new account) a newly connected primary account is included automatically on the next invocation", async () => {
  const store = makeStore();
  const dd = makeDataDoe();
  const saver = makeSaver();
  let directory = [{ accountId: "A1", country: "US", currency: "USD" }];
  const common = { store, dataDoe: dd, saver, discoverAccounts: async () => directory, controlCatalog: mkCatalog(["listing-optimizer"]) };
  const r1 = await dispatch(common).promise;
  assert.deepEqual(r1.accountsDispatched, ["A1"]);
  directory = [{ accountId: "A1", country: "US", currency: "USD" }, { accountId: "A2", country: "US", currency: "USD" }];
  const r2 = await dispatch(common).promise;
  assert.deepEqual(r2.accountsDispatched.sort(), ["A1", "A2"], "the new primary account participates with no code change");
});

test("(primary-only) a stale dd-secondary account (secondary org not configured) is skipped read-only, zero exports", async () => {
  const primaryOnly = [CONNS[0]];
  const directory = [{ accountId: "dd-secondary:Z9", country: "US", currency: "USD" }];
  const { dd, promise } = dispatch({ connections: primaryOnly, discoverAccounts: async () => directory, controlCatalog: mkCatalog(["listing-optimizer"]) });
  const r = await promise;
  assert.equal(dd.totalCreates(), 0, "a stale secondary account spends zero exports");
  assert.deepEqual(r.accountsDispatched, [], "it is never routed through the primary key");
  assert.ok((r.unavailableAccounts || []).some((a) => String(a.accountId).includes("dd-secondary:Z9")), "reported unavailable, not planned");
});

/* ============================= canonical paths + shared dedup ============================= */

group("scheduler-v2 dispatch: one canonical path per report + shared-source dedup");

test("generic + each dedicated cycle each go through its ONE canonical path", async () => {
  const keys = ["buy-box-loss", "keyword-rank", "sales-movers", "listing-optimizer", "ppc-performance"];
  const { store, promise } = dispatch({ controlCatalog: mkCatalog(keys, keys), ppcAdsProviders: emptyAds });
  const r = await promise;
  const units = r.perUnit.map((u) => u.unit);
  assert.ok(units.some((u) => u.startsWith("generic:") && u.includes("buy-box-loss")), "buy-box-loss went through the generic plan unit");
  for (const k of ["keyword-rank", "sales-movers", "listing-optimizer", "ppc-performance"]) {
    assert.ok(units.includes(k), `${k} went through its dedicated staged cycle unit`);
  }
  const keysSeen = srcKeys(store, r.cycleId);
  assert.ok(keysSeen.includes("buy-box-loss:catalog"), "generic buy-box source created");
  assert.ok(keysSeen.includes("keyword-rank:sqp-weekly"), "keyword-rank kickoff created");
  assert.ok(keysSeen.includes("sales-movers:sales-latest-probe"), "sales-movers probe created");
  assert.ok(keysSeen.includes("listing-optimizer:sqp-weekly"), "listing-optimizer kickoff created");
  // PPC with unseeded Ads plans NOTHING (zero DataDoe tokens) but still ran its dedicated cycle.
  assert.ok(!keysSeen.some((k) => k.startsWith("ppc-performance:")), "ppc-performance with unvalidated Ads spends zero tokens");
});

test("(shared dedup) a canonical catalog hash shared across two report owners is created once; both owners stay active", async () => {
  const store = makeStore();
  const dd = makeDataDoe();
  const plan = buildShadowReportPlan({ accounts: US_ACCTS, reportKeys: ["buy-box-loss", "returns-leakage"], connections: CONNS, asOfFor: asOfForUS });
  const bbCat = plan.reportRequests.find((r) => r.reportKey === "buy-box-loss").sources.find((s) => s.requestKey === "buy-box-loss:catalog");
  const retCat = plan.reportRequests.find((r) => r.reportKey === "returns-leakage").sources.find((s) => s.requestKey === "returns-leakage:catalog");
  assert.equal(bbCat.requestHash, retCat.requestHash, "the two reports share ONE canonical catalog request_hash");
  const r = await dispatch({ store, dataDoe: dd, controlCatalog: mkCatalog(["buy-box-loss", "returns-leakage"]) }).promise;
  assert.equal(dd.createCount(bbCat.requestHash), 1, "the shared catalog export is created exactly once across owners");
  const owners = store._owners(r.cycleId).filter((m) => m.request_hash === bbCat.requestHash);
  assert.deepEqual(owners.map((m) => m.report_key).sort(), ["buy-box-loss", "returns-leakage"], "both report families own the shared hash");
  assert.ok(owners.every((m) => m.owner_status === "active"), "neither owner's shared membership is staled by the other");
});

/* ============================= budget + lifecycle ============================= */

group("scheduler-v2 dispatch: cumulative budget + partial/resume lifecycle");

test("(maxJobs resume) a spent budget stages one source; a fresh invocation resumes with NO duplicate create + saves exactly once", async () => {
  const store = makeStore();
  const dd = makeDataDoe();
  const saver = makeSaver();
  const common = { store, dataDoe: dd, saver, controlCatalog: mkCatalog(["listing-optimizer"]), manualReportKeys: ["listing-optimizer"] };
  const r1 = await dispatch({ ...common, maxJobs: 1 }).promise;
  assert.equal(dd.totalCreates(), 1, "a budget of one spends exactly the SQP kickoff");
  assert.ok(!srcKeys(store, r1.cycleId).includes("listing-optimizer:catalog"), "catalog not staged under a spent budget");
  assert.equal(saver.calls, 0, "nothing saved while the catalog is unstaged");
  assert.equal(store.report("listing-optimizer", "A1").derive_status, "pending", "the partial report stays PENDING (LKG intact)");
  const sqpHash = store.listSourceJobs(r1.cycleId).find((j) => j.request_key === "listing-optimizer:sqp-weekly").request_hash;
  // Resume (fresh invocation, full budget).
  const r2 = await dispatch({ ...common }).promise;
  assert.equal(dd.createCount(sqpHash), 1, "the SQP export is NEVER re-created on resume");
  assert.equal(dd.totalCreates(), 2, "resume created only the catalog");
  assert.equal(saver.calls, 1, "the report saves EXACTLY once after resume");
  assert.ok(saver.has("listing-optimizer", "A1"), "the resumed report snapshot is saved");
  // A third invocation is idempotent (finished report is never re-derived/re-saved).
  await dispatch({ ...common }).promise;
  assert.equal(saver.calls, 1, "a further invocation writes no second snapshot");
});

test("(deferral resume) a poll deferral stops the invocation pending, then resumes with no duplicate create-export", async () => {
  const store = makeStore();
  const saver = makeSaver();
  const dd1 = makeDataDoe({ deferPollKey: "listing-optimizer:sqp-weekly" });
  const common = { store, saver, controlCatalog: mkCatalog(["listing-optimizer"]), manualReportKeys: ["listing-optimizer"] };
  const r1 = await dispatch({ ...common, dataDoe: dd1 }).promise;
  assert.ok(r1.stoppedForBudget, "the invocation stops on the resumable deferral");
  const sqpHash = store.listSourceJobs(r1.cycleId).find((j) => j.request_key === "listing-optimizer:sqp-weekly").request_hash;
  assert.equal(dd1.createCount(sqpHash), 1, "the SQP export was created once before deferring");
  assert.equal(saver.calls, 0, "nothing saved while the SQP is deferred");
  assert.equal(store.report("listing-optimizer", "A1").derive_status, "pending", "the report is PENDING on a deferral");
  // Resume with a fresh dataDoe that no longer defers; the persisted export_id is reused (no second create).
  const dd2 = makeDataDoe();
  await dispatch({ ...common, dataDoe: dd2 }).promise;
  assert.equal(dd2.createCount(sqpHash), 0, "resume never re-creates the already-created SQP export");
  assert.equal(saver.calls, 1, "the report saves exactly once after the resume");
});

test("(deadline) an exhausted wall-clock budget opens no report and leaves state resumable", async () => {
  const now = 10_000;
  const { dd, promise } = dispatch({ controlCatalog: mkCatalog(["listing-optimizer"]), clock: () => now, deadlineMs: now + 1_000 }); // reserveMs(3000) > 1000 => out of time
  const r = await promise;
  assert.equal(dd.totalCreates(), 0, "no export when the deadline budget is already spent");
  assert.ok(r.stoppedForBudget, "the invocation reports it stopped for budget");
  assert.equal(r.drained, false, "not drained => a fresh invocation will resume");
});

test("(failure isolation) one report whose derive fails never blocks an unrelated ready report", async () => {
  // buy-box-loss derives INVALID here (minimal rows fail its strict 4-slice contract); listing-optimizer
  // derives cleanly. The failed report must not stop the good one from saving.
  const catalog = mkCatalog(["buy-box-loss", "listing-optimizer"], ["buy-box-loss", "listing-optimizer"]);
  const { store, saver, promise } = dispatch({ controlCatalog: catalog });
  const r = await promise;
  assert.ok(saver.has("listing-optimizer", "A1"), "the healthy report still derived + saved");
  assert.ok(!saver.has("buy-box-loss", "A1"), "the failing report did not save (last-known-good preserved)");
  assert.notEqual(store.report("buy-box-loss", "A1").derive_status, "succeeded", "the failing report is recorded non-success");
  assert.equal(store.report("listing-optimizer", "A1").derive_status, "succeeded", "the unrelated report succeeded");
});

/* ============================= runner ============================= */

async function main() {
  ({ runSchedulerV2Shadow, classifySchedulerV2ReportKey, selectSchedulerV2ReportKeys } = await import("../lib/server/sync/scheduler-v2-dispatch.js"));
  ({ buildShadowReportPlan, SHADOW_PLANNED_REPORT_KEYS, STAGED_CYCLE_REPORT_KEYS } = await import("../lib/server/sync/report-planner.js"));
  void SHADOW_PLANNED_REPORT_KEYS; void STAGED_CYCLE_REPORT_KEYS;

  for (const t of tests) {
    if (t.marker) { mark("group -> " + t.marker); continue; }
    try {
      await t.fn();
      passed += 1;
      out("  ok  " + t.name);
    } catch (e) {
      out("FAIL  " + t.name);
      out(String(e && e.stack ? e.stack : e));
      process.exitCode = 1;
      return;
    }
  }
  out("\n" + passed + " assertions passed");
}

main();
