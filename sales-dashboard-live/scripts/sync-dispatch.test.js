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

let runSchedulerV2Shadow, classifySchedulerV2ReportKey, selectSchedulerV2ReportKeys, composeDerivedContextLoaders;
let buildShadowReportPlan, SHADOW_PLANNED_REPORT_KEYS, STAGED_CYCLE_REPORT_KEYS;
let addDaysStr, monthStartStr, monthBackStr;
let makeDailyAdsContextLoader, makePpcAdsContextLoader;
let reportControlCatalog, schedulerV2ReportControlCatalog;

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
    async download(job) {
      // capKey: return an EXACTLY-cap-sized page for that source so a strict contract rejects it as TRUNCATED.
      if (opts.capKey && (job.requestKey || "") === opts.capKey) return new Array(Number(job.limit)).fill({ x: 1 });
      return rowsFor(job);
    },
  };
}

// A dataDoe that returns FAITHFUL download rows for named request keys (else rowsFor) and RECORDS every
// downloaded request key -- used by the Daily+PPC integration to prove derivation makes zero DataDoe calls.
function seededDataDoe(faithful = {}) {
  const dd = makeDataDoe();
  const fetched = [];
  const baseDownload = dd.download;
  dd.download = async (job, exportId) => {
    fetched.push(job.requestKey || "");
    return Object.prototype.hasOwnProperty.call(faithful, job.requestKey || "") ? faithful[job.requestKey] : baseDownload(job, exportId);
  };
  dd.fetchedKeys = () => fetched.slice();
  return dd;
}

// Wide durable coverage that trivially spans any requested window (the resolvers clamp it to [from,to], so
// a validated/proven state results without pinning exact dates). Used to seed valid Daily + PPC coverage.
const WIDE_COVERAGE = [{ from: "2000-01-01", to: "2099-12-31" }];

// Real Daily Ads context loader seeds: injected ad_daily_metrics reader + durable ads_sync_coverage reader
// (Supabase-style, NEVER DataDoe). Records reader calls so a test can prove the derive read from here.
function makeDailyAdsSeed() {
  const calls = { metrics: 0, coverage: 0 };
  return {
    calls,
    getAdMetrics: async (_accountId, _from, _to) => { calls.metrics += 1; return [{ metric_date: "2025-08-01", currency: "USD", ad_sales: 40, ad_spend: 10, ad_clicks: 100 }]; },
    getCoverageState: async (_accountId, _sourceKey) => { calls.coverage += 1; return { windows: WIDE_COVERAGE, status: "succeeded", read: "ok", latestMetricDate: "2025-08-01" }; },
  };
}

// Real PPC persisted-Ads providers: seeded campaign+ASIN rows + durable coverage (all four sources proven).
// Supabase-style readers, NEVER DataDoe. Records reader calls.
function makePpcAdsSeed() {
  const calls = { rows: 0, states: 0, coverage: 0 };
  const rows = [
    { account_id: "A1", source_key: "campaign-performance-v1", metric_date: "2025-08-01", currency: "USD", dimensions: {}, metrics: { ad_spend: 10, ad_sales: 40, ad_clicks: 100 } },
    { account_id: "A1", source_key: "asin-performance-v1", metric_date: "2025-08-01", currency: "USD", dimensions: {}, metrics: { ad_spend: 6, ad_sales_same_sku: 30, ad_clicks: 40 } },
  ];
  return {
    calls,
    getAdsDailySourceRows: async ({ accountId, sourceKeys, from, to }) => { calls.rows += 1; return rows.filter((r) => r.account_id === accountId && sourceKeys.includes(r.source_key) && r.metric_date >= from && r.metric_date <= to); },
    getAdsSyncStates: async (_accountIds) => { calls.states += 1; return []; },
    getAdsSyncCoverage: async (_accountId, _sourceKey) => { calls.coverage += 1; return { windows: WIDE_COVERAGE, status: "succeeded", read: "ok" }; },
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
    // Models finalize_sync_cycle: typed disposition; finalizes only a running cycle with no open source jobs.
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
    bucket: "us", cycleDate: "2026-08-11",
    asOf: "asOf" in over ? over.asOf : ASOF,
    asOfFor: "asOfFor" in over ? over.asOfFor : asOfForUS,
    connections: over.connections || CONNS,
    discoverAccounts: over.discoverAccounts || (async () => accounts),
    store, dataDoe: dd, saveSnapshot: saver,
    controlCatalog: over.controlCatalog, settings: over.settings, manualReportKeys: over.manualReportKeys,
    ppcAdsProviders: over.ppcAdsProviders, loadDerivedContext: over.loadDerivedContext,
    maxJobs: over.maxJobs, deadlineMs: over.deadlineMs, clock: over.clock,
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
  // Blocker 1: both controlled, source-backed reports now route through their ONE canonical generic path.
  assert.equal(classifySchedulerV2ReportKey("brand-sales"), "generic", "brand-sales is a wired generic source-backed report");
  assert.equal(classifySchedulerV2ReportKey("content-changes"), "generic", "content-changes is a wired generic source-backed report");
  assert.equal(classifySchedulerV2ReportKey("brand-view"), "derived-only", "a derive-from-snapshots report owns no source contracts");
  assert.equal(classifySchedulerV2ReportKey("no-such-report"), "unsupported");
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
  const { dd, promise } = dispatch({ manualReportKeys: ["no-such-report"], controlCatalog: mkCatalog(["no-such-report"]) });
  await assert.rejects(promise, /no canonical dispatch path.*no-such-report.*fail closed/s);
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

/* ===================== blocker 1: brand-sales + content-changes canonical dispatch ===================== */

group("scheduler-v2 dispatch: brand-sales + content-changes canonical dispatch (blocker 1)");

test("(source-plan) brand-sales + content-changes each plan their canonical sources over the exact windows", () => {
  const plan = buildShadowReportPlan({ accounts: US_ACCTS, reportKeys: ["brand-sales", "content-changes"], connections: CONNS, asOfFor: asOfForUS });
  const bs = plan.reportRequests.find((r) => r.reportKey === "brand-sales");
  const cc = plan.reportRequests.find((r) => r.reportKey === "content-changes");
  assert.ok(bs && cc, "both reports are planned generically");
  // brand-sales: order-lines + catalog BOTH over [monthStart(asOf)-420d, asOf].
  const bsFrom = addDaysStr(monthStartStr(ASOF), -420);
  for (const rk of ["brand-sales:order-lines", "brand-sales:catalog"]) {
    const s = bs.sources.find((x) => x.requestKey === rk);
    assert.ok(s, rk + " planned");
    assert.equal(s.from, bsFrom, rk + " from = monthStart(asOf)-420");
    assert.equal(s.to, ASOF, rk + " to = asOf");
  }
  // content-changes: events is a no-date source; catalog over [asOf-365d, asOf].
  const ev = cc.sources.find((x) => x.requestKey === "content-changes:events");
  const cat = cc.sources.find((x) => x.requestKey === "content-changes:catalog");
  assert.equal(ev.from, null, "events source is no-date (from null)");
  assert.equal(ev.to, null, "events source is no-date (to null)");
  assert.equal(cat.from, addDaysStr(ASOF, -365), "catalog from = asOf-365");
  assert.equal(cat.to, ASOF, "catalog to = asOf");
});

test("(one canonical path + worker) both dispatch through the ONE generic unit and derive + save", async () => {
  const keys = ["brand-sales", "content-changes"];
  const { store, saver, promise } = dispatch({ controlCatalog: mkCatalog(keys, keys) });
  const r = await promise;
  const genUnits = r.perUnit.filter((u) => u.kind === "generic");
  assert.equal(genUnits.length, 1, "exactly one generic unit runs both (no separate paths)");
  assert.ok(genUnits[0].unit.includes("brand-sales") && genUnits[0].unit.includes("content-changes"), "both share the one generic plan/cycle");
  assert.ok(!r.perUnit.some((u) => u.kind === "staged"), "neither report opens a dedicated staged cycle");
  const seen = srcKeys(store, r.cycleId);
  assert.ok(seen.includes("brand-sales:order-lines") && seen.includes("brand-sales:catalog"), "brand-sales canonical sources created");
  assert.ok(seen.includes("content-changes:events") && seen.includes("content-changes:catalog"), "content-changes canonical sources created");
  assert.ok(saver.has("brand-sales", "A1"), "brand-sales derived + saved from its saved source rows");
  assert.ok(saver.has("content-changes", "A1"), "content-changes derived + saved from its saved source rows");
});

test("(coexist) brand-sales + content-changes run alongside other reports without blocking them", async () => {
  // buy-box-loss derives INVALID (minimal rows fail its strict contract), listing-optimizer derives cleanly;
  // adding brand-sales + content-changes must change neither outcome.
  const keys = ["brand-sales", "content-changes", "buy-box-loss", "listing-optimizer"];
  const { saver, promise } = dispatch({ controlCatalog: mkCatalog(keys, keys) });
  const r = await promise;
  assert.ok(saver.has("brand-sales", "A1"), "brand-sales saved");
  assert.ok(saver.has("content-changes", "A1"), "content-changes saved");
  assert.ok(saver.has("listing-optimizer", "A1"), "the unrelated healthy report still saved");
  assert.ok(!saver.has("buy-box-loss", "A1"), "the failing report still did not save (isolated)");
  assert.deepEqual(r.selected.slice().sort(), keys.slice().sort(), "all four are selected/dispatched");
});

test("(LKG) a failed required source blocks brand-sales and preserves last-known-good (zero save)", async () => {
  const saver = makeSaver();
  saver.saved.set("brand-sales|A1", { lkg: true }); // a prior good snapshot
  const { store, promise } = dispatch({
    saver, manualReportKeys: ["brand-sales"], controlCatalog: mkCatalog(["brand-sales"]),
    ddOpts: { failCreateKey: "brand-sales:order-lines" },
  });
  await promise;
  assert.equal(saver.calls, 0, "no snapshot written while a required source failed");
  assert.deepEqual(saver.saved.get("brand-sales|A1"), { lkg: true }, "the prior last-known-good snapshot is untouched");
  assert.notEqual(store.report("brand-sales", "A1").derive_status, "succeeded", "brand-sales did not derive-succeed");
});

test("(request-hash + account isolation) canonical hashes are deterministic and isolated across organizations", () => {
  const primaryAcct = [{ accountId: "A1", country: "US", currency: "USD", name: "One" }];
  const secondaryAcct = [{ accountId: dash("dd", "secondary") + ":Z9", country: "US", currency: "USD", name: "Two" }];
  const hashOf = (accounts) => buildShadowReportPlan({ accounts, reportKeys: ["brand-sales"], connections: CONNS, asOfFor: asOfForUS })
    .reportRequests[0].sources.find((s) => s.requestKey === "brand-sales:order-lines").requestHash;
  const hp = hashOf(primaryAcct);
  const hs = hashOf(secondaryAcct);
  assert.ok(hp && hs, "both accounts resolve a request hash");
  assert.notEqual(hp, hs, "primary and dd-secondary organizations never share a canonical request hash");
  assert.equal(hashOf(primaryAcct), hp, "the request hash is deterministic across replans");
});

/* ===================== blocker 2: composed derived-context loaders ===================== */

group("scheduler-v2 dispatch: composed derived-context loaders (blocker 2)");

test("composeDerivedContextLoaders invokes only the relevant loader per report and merges safely", async () => {
  const daily = async ({ reportKey }) => (reportKey === "daily-reporting" ? { adsCoverage: { c: 1 } } : {});
  const ppc = async ({ reportKey }) => (reportKey === "ppc-performance" ? { ppcAds: { p: 1 } } : {});
  const composed = composeDerivedContextLoaders([daily, ppc]);
  assert.deepEqual(await composed({ reportKey: "daily-reporting" }), { adsCoverage: { c: 1 } }, "Daily gets adsCoverage; the PPC loader contributes nothing");
  assert.deepEqual(await composed({ reportKey: "ppc-performance" }), { ppcAds: { p: 1 } }, "PPC gets ppcAds; the Daily loader contributes nothing");
  assert.deepEqual(await composed({ reportKey: "brand-sales" }), {}, "an unrelated report gets neither");
});

test("composeDerivedContextLoaders: passthrough + a throwing loader never suppresses its sibling", async () => {
  const boom = async () => { throw new Error("boom"); };
  const ppc = async ({ reportKey }) => (reportKey === "ppc-performance" ? { ppcAds: { p: 1 } } : {});
  assert.equal(composeDerivedContextLoaders([]), null, "no loaders => null");
  assert.equal(composeDerivedContextLoaders([ppc]), ppc, "a single loader passes through unchanged");
  const composed = composeDerivedContextLoaders([boom, ppc]);
  assert.deepEqual(await composed({ reportKey: "ppc-performance" }), { ppcAds: { p: 1 } }, "the surviving loader still contributes");
});

test("(routing, real loaders) the real Daily + PPC loaders give each report ONLY its own field; a throwing sibling never suppresses", async () => {
  const daily = makeDailyAdsSeed();
  const ppc = makePpcAdsSeed();
  const dailyLoader = makeDailyAdsContextLoader({ connections: CONNS, getAdMetrics: daily.getAdMetrics, getCoverageState: daily.getCoverageState });
  const ppcLoader = makePpcAdsContextLoader({ getAdsDailySourceRows: ppc.getAdsDailySourceRows, getAdsSyncStates: ppc.getAdsSyncStates, getAdsSyncCoverage: ppc.getAdsSyncCoverage });
  const composed = composeDerivedContextLoaders([dailyLoader, ppcLoader]);
  // Daily Reporting (ALL brand) -> ONLY adsCoverage (the PPC loader returns {} for it).
  const ctxD = await composed({ reportKey: "daily-reporting", accountId: "A1", planned: { context: { brand: "ALL", from: monthBackStr(ASOF, 5), to: ASOF, currency: "USD", rawSellerId: "A1" } } });
  assert.deepEqual(Object.keys(ctxD).sort(), ["adsCoverage"], "Daily receives ONLY adsCoverage");
  // PPC Performance -> ONLY ppcAds (the Daily loader returns {} for it), validated from the seeded coverage.
  const ctxP = await composed({ reportKey: "ppc-performance", accountId: "A1", planned: { context: { to: ASOF, rawSellerId: "A1" } } });
  assert.deepEqual(Object.keys(ctxP).sort(), ["ppcAds"], "PPC receives ONLY ppcAds");
  assert.equal(ctxP.ppcAds.status, "ok", "PPC ppcAds validated from the seeded durable campaign+ASIN coverage");
  // One throwing report-specific loader never suppresses its sibling.
  const boom = async () => { throw new Error("boom"); };
  const survived = composeDerivedContextLoaders([boom, ppcLoader]);
  const ctxP2 = await survived({ reportKey: "ppc-performance", accountId: "A1", planned: { context: { to: ASOF, rawSellerId: "A1" } } });
  assert.deepEqual(Object.keys(ctxP2).sort(), ["ppcAds"], "a throwing sibling does not suppress the surviving PPC loader");
});

test("(daily+ppc integration) one dispatcher invocation derives + saves BOTH Daily and PPC from seeded durable coverage/rows; derivation makes zero DataDoe calls", async () => {
  const store = makeStore();
  const saver = makeSaver();
  const daily = makeDailyAdsSeed();
  const ppc = makePpcAdsSeed();
  // Faithful Daily superset so the sales snapshot is meaningful; PPC catalog/total-sales come from rowsFor.
  const dd = seededDataDoe({ "daily-reporting:asin-day-superset": [{ date: "2025-08-01", seller_or_vendor_id: "A1", total_sales_sum: 100, total_units_sum: 5 }] });
  const general = makeDailyAdsContextLoader({ connections: CONNS, getAdMetrics: daily.getAdMetrics, getCoverageState: daily.getCoverageState });
  const keys = ["daily-reporting", "ppc-performance"];
  await dispatch({ store, dataDoe: dd, saver, controlCatalog: mkCatalog(keys, keys), loadDerivedContext: general, ppcAdsProviders: ppc }).promise;
  // BOTH snapshots derive + save.
  assert.ok(saver.has("daily-reporting", "A1"), "Daily Reporting derived + saved");
  assert.ok(saver.has("ppc-performance", "A1"), "PPC Performance derived + saved");
  // Daily consumed the seeded durable Ads coverage (validated); PPC folded the seeded campaign+ASIN rows.
  assert.equal(saver.saved.get("daily-reporting|A1").adsAvailability.status, "validated", "Daily resolved the seeded durable Ads coverage to validated");
  assert.equal(saver.saved.get("ppc-performance|A1").adsRowCount, 2, "PPC folded the two seeded campaign+ASIN Ads rows");
  // The derive-context loaders read from injected Supabase-style readers (NEVER DataDoe).
  assert.ok(daily.calls.metrics > 0 && daily.calls.coverage > 0, "the Daily loader read ad_daily_metrics + durable coverage");
  assert.ok(ppc.calls.rows > 0 && ppc.calls.coverage > 0, "the PPC loader read persisted Ads rows + durable coverage");
  // ZERO DataDoe/network in derivation: no persisted-Ads source was EVER fetched via DataDoe (Daily ads come
  // from the loader; PPC creates zero Ads exports). Every DataDoe download was a planned report source.
  const allowed = ["daily-reporting:asin-day-superset", "daily-reporting:catalog", "ppc-performance:catalog", "ppc-performance:total-sales"];
  assert.ok(dd.fetchedKeys().every((k) => allowed.includes(k)), "every DataDoe fetch was a planned source; derivation issued zero DataDoe/network calls");
});

/* ===================== blocker 3: manual selection semantics ===================== */

group("scheduler-v2 dispatch: manual selection semantics (blocker 3)");

test("(empty manual) manualReportKeys=[] runs ZERO reports and spends ZERO cycles/jobs/exports (never the schedule)", async () => {
  const catalog = mkCatalog(["brand-sales", "listing-optimizer", "buy-box-loss"], ["brand-sales", "listing-optimizer", "buy-box-loss"]);
  const { store, dd, saver, promise } = dispatch({ manualReportKeys: [], controlCatalog: catalog });
  const r = await promise;
  assert.equal(r.manual, true, "[] is a manual request");
  assert.deepEqual(r.selected, [], "zero reports selected -- never falls back to the enabled schedule");
  assert.equal(r.cycleId, null, "no source cycle opened");
  assert.equal(dd.totalCreates(), 0, "zero DataDoe exports");
  assert.equal(saver.calls, 0, "zero snapshots saved");
  assert.equal(store.listReportJobs().length, 0, "zero report jobs created");
});

test("(selection) selectSchedulerV2ReportKeys treats [] as manual with an empty request", () => {
  const sel = selectSchedulerV2ReportKeys({ controlCatalog: mkCatalog(["brand-sales"], ["brand-sales"]), manualReportKeys: [] });
  assert.equal(sel.manual, true);
  assert.deepEqual(sel.requested, [], "[] never falls back to the scheduled enabled set");
});

test("(malformed manual) a non-array / blank / non-string manual input fails closed", async () => {
  assert.throws(() => selectSchedulerV2ReportKeys({ controlCatalog: mkCatalog([]), manualReportKeys: "brand-sales" }), /must be an array.*fail closed/s);
  assert.throws(() => selectSchedulerV2ReportKeys({ controlCatalog: mkCatalog([]), manualReportKeys: [null] }), /report-key string.*fail closed/s);
  assert.throws(() => selectSchedulerV2ReportKeys({ controlCatalog: mkCatalog([]), manualReportKeys: ["  "] }), /blank report key.*fail closed/s);
  const { dd, promise } = dispatch({ manualReportKeys: "brand-sales", controlCatalog: mkCatalog(["brand-sales"]) });
  await assert.rejects(promise, /must be an array.*fail closed/s);
  assert.equal(dd.totalCreates(), 0, "zero exports on a malformed manual input");
});

/* ===================== blocker 5: global asOf vs per-country asOfFor for generic planning ===================== */

group("scheduler-v2 dispatch: global asOf vs per-country asOfFor (blocker 5)");

const genericHashes = (store, cid) => store.listSourceJobs(cid).map((j) => j.request_hash).sort();

test("(global asOf) with NO asOfFor, the validated global asOf drives the EXACT canonical generic windows", async () => {
  const common = { manualReportKeys: ["brand-sales"], controlCatalog: mkCatalog(["brand-sales"]) };
  const ref = dispatch({ ...common, asOfFor: asOfForUS });
  const rRef = await ref.promise;
  const hashesRef = genericHashes(ref.store, rRef.cycleId);
  const glob = dispatch({ ...common, asOfFor: null, asOf: ASOF });
  const rGlob = await glob.promise;
  const hashesGlob = genericHashes(glob.store, rGlob.cycleId);
  assert.ok(hashesGlob.length > 0, "generic sources were planned from the global asOf");
  assert.deepEqual(hashesGlob, hashesRef, "global asOf yields byte-identical canonical windows to per-country asOfFor");
});

test("(per-country asOfFor) asOfFor(country) is honored; a different per-country date => different canonical windows", async () => {
  const common = { manualReportKeys: ["brand-sales"], controlCatalog: mkCatalog(["brand-sales"]) };
  const ref = dispatch({ ...common, asOfFor: asOfForUS });
  const hashesRef = genericHashes(ref.store, (await ref.promise).cycleId);
  const seen = [];
  const other = dispatch({ ...common, asOfFor: (c) => { seen.push(c); return dash("2025", "07", "01"); } });
  const hashesOther = genericHashes(other.store, (await other.promise).cycleId);
  assert.ok(seen.includes("US"), "asOfFor is invoked with the account's marketplace country");
  assert.notDeepEqual(hashesOther, hashesRef, "a different per-country asOf produces different canonical windows");
});

test("(asOf fail-closed) generic planning with neither asOfFor nor a valid global asOf fails closed BEFORE any cycle", async () => {
  const { dd, promise } = dispatch({ manualReportKeys: ["brand-sales"], controlCatalog: mkCatalog(["brand-sales"]), asOfFor: null, asOf: null });
  await assert.rejects(promise, /generic report planning requires.*asOf.*fail closed/s);
  assert.equal(dd.totalCreates(), 0, "zero exports on the fail-closed refusal");
});

/* ===================== blocker 6: drained reflects actual unit outcomes ===================== */

group("scheduler-v2 dispatch: drained reflects actual unit outcomes (blocker 6)");

test("(final/only unit maxJobs) a truncated ONLY unit returns drained:false + continuationRequired, then resumes with NO duplicate exports", async () => {
  const store = makeStore();
  const dd = makeDataDoe();
  const saver = makeSaver();
  const common = { store, dataDoe: dd, saver, manualReportKeys: ["brand-sales"], controlCatalog: mkCatalog(["brand-sales"]) };
  // brand-sales plans exactly two canonical sources (order-lines + catalog); maxJobs:1 truncates the ONLY unit
  // with NO deadline and NO deferral -- the pure maxJobs-exhaustion case blocker 6 targets.
  const r1 = await dispatch({ ...common, maxJobs: 1 }).promise;
  assert.equal(dd.totalCreates(), 1, "a budget of one spends exactly one export");
  assert.equal(r1.drained, false, "a final/only unit that did not fully drain => dispatcher drained:false");
  assert.equal(r1.continuationRequired, true, "continuation is required");
  assert.ok(r1.stoppedForBudget, "the invocation reports it stopped for budget");
  assert.equal(saver.calls, 0, "nothing saved while the second source is unstaged");
  const firstHash = store.listSourceJobs(r1.cycleId).find((j) => j.fetch_status === "succeeded").request_hash;
  const r2 = await dispatch({ ...common }).promise;
  assert.equal(dd.createCount(firstHash), 1, "the already-created export is NEVER recreated on resume");
  assert.equal(dd.totalCreates(), 2, "resume created only the remaining source");
  assert.equal(r2.drained, true, "the resumed invocation fully drains");
  assert.equal(r2.continuationRequired, false, "no further continuation required after resume");
  assert.equal(saver.calls, 1, "brand-sales saves EXACTLY once after resume");
  assert.ok(saver.has("brand-sales", "A1"));
});

test("(multi-unit, final unit truncates) an earlier unit fully drains, the final unit truncates => drained:false; resume completes with no duplicate exports", async () => {
  const store = makeStore();
  const dd = makeDataDoe();
  const saver = makeSaver();
  const keys = ["brand-sales", "listing-optimizer"]; // unit order: generic (2 sources) then the staged cycle
  const common = { store, dataDoe: dd, saver, controlCatalog: mkCatalog(keys, keys), manualReportKeys: keys };
  // Budget = 3: brand-sales fully drains (2), listing-optimizer stages its SQP kickoff (1) then truncates.
  const r1 = await dispatch({ ...common, maxJobs: 3 }).promise;
  const gen = r1.perUnit.find((u) => u.kind === "generic");
  const lo = r1.perUnit.find((u) => u.unit === "listing-optimizer");
  assert.equal(gen.drained, true, "the earlier generic unit fully drained");
  assert.ok(lo && lo.drained === false, "the final staged unit truncated (drained:false)");
  assert.equal(r1.drained, false, "a final unit that did not drain makes the dispatcher drained:false");
  assert.equal(r1.continuationRequired, true, "continuation is required");
  assert.equal(dd.totalCreates(), 3, "exactly the budget of three exports was spent");
  const r2 = await dispatch({ ...common }).promise;
  assert.ok(store.listSourceJobs(r2.cycleId).every((j) => dd.createCount(j.request_hash) === 1), "no source export is EVER created twice across the resume");
  assert.equal(r2.drained, true, "the resumed invocation fully drains every unit");
  assert.ok(saver.has("listing-optimizer", "A1"), "the staged report saves after resume");
});

/* ===================== re-review finding 1: Scheduler-v2 readiness is fail-closed + distinct from v1 ===================== */

group("scheduler-v2 dispatch: v2 readiness is fail-closed, distinct from v1 (finding 1)");

test("(v1 vs v2 readiness) Scheduler v1 readiness is unchanged; Scheduler v2 readiness is fail-closed for EVERY report", () => {
  const v1 = reportControlCatalog([]);
  const v2 = schedulerV2ReportControlCatalog([]);
  assert.equal(v1.find((c) => c.reportKey === "brand-sales").ready, true, "Scheduler v1 still runs Brand Sales (v1 readiness untouched)");
  assert.equal(v2.find((c) => c.reportKey === "brand-sales").ready, false, "Scheduler v2 Brand Sales is locked (fail-closed, NOT derived from v1 enabled)");
  assert.ok(v2.every((c) => c.ready === false && c.scheduleEnabled === false), "EVERY Scheduler v2 report is not-ready + not-scheduled by default");
});

test("(default v2 lock) a DEFAULT manual OR scheduled Brand Sales request is locked out and spends ZERO exports", async () => {
  // No injected controlCatalog => the dispatcher uses its fail-closed schedulerV2ReportControlCatalog default.
  const sched = await dispatch({}).promise; // scheduled (no manualReportKeys)
  assert.deepEqual(sched.selected, [], "scheduled v2 selects nothing (no report is v2 schedule-enabled)");
  assert.equal(sched.cycleId, null, "scheduled v2 opens no source cycle");
  const dd = makeDataDoe();
  const man = await dispatch({ dataDoe: dd, manualReportKeys: ["brand-sales"] }).promise; // manual Brand Sales
  assert.deepEqual(man.selected, [], "manual Brand Sales is NOT dispatched under the fail-closed v2 catalog");
  assert.deepEqual(man.lockedOut, ["brand-sales"], "brand-sales is reported locked-out (v2 not-ready)");
  assert.equal(dd.totalCreates(), 0, "a default v2 Brand Sales request spends ZERO exports");
});

/* ===================== re-review finding 2: strict truncation on the newly dispatched contracts ===================== */

group("scheduler-v2 dispatch: strict truncation on the new contracts (finding 2)");

test("(strict + hash invariance) all four newly dispatched contracts are strict:true; request_hash is unchanged (golden)", () => {
  // Golden hashes captured at HEAD 554b859 BEFORE strict was added; strict stays OUTSIDE sourceRequestIdentity.
  const GOLDEN = {
    "brand-sales:order-lines": "72a5ecdc9d8992a2bd60f222682155ca694cf9e18a37f5c291b225dd6895c315",
    "brand-sales:catalog": "0e9c4e5a4653e92e8fb4aea2de50b5cade8f3f379daddce5bc8e3f392b33abac",
    "content-changes:events": "94e6c902b901cb48fe3ce785144f8a0d6529c635c702d376be71a5d5e7b29d69",
    "content-changes:catalog": "314e46657501b9d6515cefa0b10bd8b9bc661ba958312986213755dfb9751acf",
  };
  const plan = buildShadowReportPlan({ accounts: US_ACCTS, reportKeys: ["brand-sales", "content-changes"], connections: CONNS, asOfFor: asOfForUS });
  let checked = 0;
  for (const rk of ["brand-sales", "content-changes"]) {
    for (const s of plan.reportRequests.find((r) => r.reportKey === rk).sources) {
      assert.equal(s.strict, true, s.requestKey + " carries strict:true");
      assert.equal(s.requestHash, GOLDEN[s.requestKey], s.requestKey + " request_hash is unchanged by strict");
      checked += 1;
    }
  }
  assert.equal(checked, 4, "all four new contracts were checked");
});

test("(strict truncation) an exactly-cap-sized brand-sales source records TRUNCATED, saves no payload/snapshot, keeps LKG, and never blocks an unrelated report", async () => {
  const store = makeStore();
  const saver = makeSaver();
  saver.saved.set("brand-sales|A1", { lkg: true }); // a prior good snapshot (must be preserved)
  const dd = makeDataDoe({ capKey: "brand-sales:order-lines" }); // that source's download returns EXACTLY the row cap
  const keys = ["brand-sales", "content-changes"];
  const r = await dispatch({ store, dataDoe: dd, saver, controlCatalog: mkCatalog(keys, keys) }).promise;
  const ol = store.listSourceJobs(r.cycleId).find((j) => j.request_key === "brand-sales:order-lines");
  // records TRUNCATED (terminal) + saves NO source payload.
  assert.equal(ol.fetch_status, "failed", "the cap-sized strict source is failed");
  assert.equal(ol.error_code, "TRUNCATED", "it records TRUNCATED");
  assert.equal(ol.terminal, true, "TRUNCATED is terminal (no in-cycle retry)");
  assert.equal(store.loadSourceRows(ol.request_hash), null, "no source payload was saved for the truncated source");
  // writes NO report snapshot + preserves last-known-good.
  assert.equal(saver.calls, 1, "brand-sales wrote no snapshot (only the unrelated report saved)");
  assert.deepEqual(saver.saved.get("brand-sales|A1"), { lkg: true }, "the prior last-known-good brand-sales snapshot is untouched");
  assert.notEqual(store.report("brand-sales", "A1").derive_status, "succeeded", "brand-sales did not derive-succeed");
  // does NOT prevent an unrelated source/report from completing.
  assert.ok(saver.has("content-changes", "A1"), "the unrelated content-changes report still derived + saved");
});

/* ============================= runner ============================= */

async function main() {
  ({ runSchedulerV2Shadow, classifySchedulerV2ReportKey, selectSchedulerV2ReportKeys, composeDerivedContextLoaders } = await import("../lib/server/sync/sync-dispatch.js"));
  ({ buildShadowReportPlan, SHADOW_PLANNED_REPORT_KEYS, STAGED_CYCLE_REPORT_KEYS } = await import("../lib/server/sync/report-planner.js"));
  ({ addDaysStr, monthStartStr, monthBackStr } = await import("../lib/server/date-windows.js"));
  ({ makeDailyAdsContextLoader } = await import("../lib/server/sync/daily-ads-loader.js"));
  ({ makePpcAdsContextLoader } = await import("../lib/server/sync/ppc-ads-loader.js"));
  ({ reportControlCatalog, schedulerV2ReportControlCatalog } = await import("../lib/server/sync/report-controls.js"));
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
