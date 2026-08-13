// Phase 1f -- Scheduler v2 PRODUCTION RUNTIME COMPOSITION + preflight + migration-readiness tests.
//
// Proves, with ZERO real DataDoe/Supabase (every primitive injected):
//   * runtime construction performs zero I/O (no collaborator method is invoked at build time);
//   * the combined store exposes EVERY source + report worker method, fail-closed on a real conflict;
//   * source rows are read cache-only; derivation never invokes DataDoe;
//   * the no-side-effect preflight makes zero DataDoe exports + zero writes and returns typed SAFE blockers;
//   * default v2 controls dispatch zero reports/exports; an injected ready control drives one complete cycle;
//   * a new primary account is discovered automatically; a dormant dd-secondary account spends zero exports;
//   * the static migration<->wrapper audit passes on the real migrations and fails closed on drift;
//   * no secret / raw Supabase/DataDoe error ever enters returned telemetry.
//
// 7-bit ASCII, LF, no top-level await; dynamic imports after a dummy Supabase/DataDoe env.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = process.env[SB_KEY_ENV] || ["test", "svc", "role", "key"].join("-");
process.env.DATADOE_API_KEY = process.env.DATADOE_API_KEY || ["dd", "primary", "key"].join("-");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const group = (label) => tests.push({ marker: label });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

let buildSchedulerV2Runtime, combineStores, makeProductionDiscoverAccounts, schedulerV2Preflight, REQUIRED_WRAPPERS;
let auditSchemaContract, SCHEDULER_V2_SCHEMA_CONTRACT;

const dash = (...p) => p.join("-");
const PRIMARY_KEY = dash("dd", "primary", "secret", "key"); // a "secret" api key we assert never leaks
const CONNS = [{ id: "primary", apiKey: PRIMARY_KEY, accountPrefix: "" }];
const CONNS_WITH_SECONDARY = [...CONNS, { id: "secondary", apiKey: dash("dd", "secondary", "secret"), accountPrefix: dash("dd", "secondary") + ":" }];

// ---- a combined backing store (source + report halves over ONE set of maps) --------------------

const SOURCE_METHODS = ["openCycle", "claimCycle", "getCycle", "upsertSourceJob", "listSourceJobs", "upsertSourceJobOwners",
  "listSourceJobOwners", "listSourceJobsForOwners", "recordSourceOwnerStale", "claimExportAttempt", "recordExportCreated",
  "loadSourceRows", "saveSourceRows", "recordSourceSuccess", "recordSourceFailure", "updateCycleCounts"];
const REPORT_METHODS = ["listSourceJobs", "upsertReportJob", "listReportJobs", "claimReportDerive", "recordReportBlocked",
  "recordReportFailure", "recordReportSuccess"];

function makeBackingStore() {
  const cycles = new Map(); const jobsByCycle = new Map(); const ownersByCycle = new Map();
  const cache = new Map(); const reportJobs = new Map(); const snapshots = new Map(); let seq = 0;
  const findCycle = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  const ownerRows = (cid) => [...((ownersByCycle.get(cid) && ownersByCycle.get(cid).values()) || [])];
  const rkey = (rk, a) => rk + "|" + a;
  const store = {
    _snapshots: snapshots,
    openCycle({ bucket, cycleDate }) { const k = bucket + "|" + cycleDate; if (!cycles.has(k)) { const id = "cyc_" + (seq += 1); cycles.set(k, { id, bucket, status: "pending" }); jobsByCycle.set(id, new Map()); } return cycles.get(k).id; },
    claimCycle(id) { const c = findCycle(id); if (c && c.status === "pending") { c.status = "running"; return true; } return false; },
    getCycle(id) { return findCycle(id); },
    upsertSourceJob(job) { const m = jobsByCycle.get(job.cycleId); if (m.has(job.requestHash)) return; m.set(job.requestHash, { request_hash: job.requestHash, request_key: job.requestKey, source_id: job.sourceId, connection_id: job.connectionId, organization_fingerprint: job.organizationFingerprint, fetch_status: "pending", attempted_at: null, create_export_count: 0, export_id: null, terminal: false, row_count: null }); },
    listSourceJobs(id) { return [...((jobsByCycle.get(id) && jobsByCycle.get(id).values()) || [])].map((j) => ({ ...j })); },
    upsertSourceJobOwners(ms) { for (const m of ms || []) { if (!ownersByCycle.has(m.cycleId)) ownersByCycle.set(m.cycleId, new Map()); ownersByCycle.get(m.cycleId).set(m.ownerId + "|" + m.requestHash, { cycle_id: m.cycleId, request_hash: m.requestHash, owner_id: m.ownerId, request_key: m.requestKey, report_key: m.reportKey, account_id: m.accountId, owner_status: "active", error_code: null }); } },
    listSourceJobOwners(cid, ids) { const s = new Set(ids || []); return ownerRows(cid).filter((m) => s.has(m.owner_id)).map((m) => ({ ...m })); },
    listSourceJobsForOwners(cid, ids) { const s = new Set(ids || []); const hs = new Set(ownerRows(cid).filter((m) => s.has(m.owner_id) && m.owner_status !== "stale").map((m) => m.request_hash)); return store.listSourceJobs(cid).filter((j) => hs.has(j.request_hash)); },
    recordSourceOwnerStale({ cycleId, requestHash, ownerId, code }) { const m = ownersByCycle.get(cycleId) && ownersByCycle.get(cycleId).get(ownerId + "|" + requestHash); if (m) { m.owner_status = "stale"; m.error_code = code || "STALE_PLAN"; } },
    claimExportAttempt(id, h) { const j = jobsByCycle.get(id) && jobsByCycle.get(id).get(h); if (j && j.attempted_at === null) { j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted"; return true; } return false; },
    recordExportCreated({ cycleId, requestHash, exportId }) { jobsByCycle.get(cycleId).get(requestHash).export_id = exportId; },
    loadSourceRows(h) { const e = cache.get(h); return e ? { rows: e.rows } : null; },
    saveSourceRows({ job, rows }) { const h = job.request_hash != null ? job.request_hash : job.requestHash; cache.set(h, { rows: [...rows] }); return "p/" + h; },
    recordSourceSuccess({ cycleId, requestHash, exportId, rowCount, cacheObjectPath }) { Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "succeeded", export_id: exportId, row_count: rowCount, cache_object_path: cacheObjectPath }); },
    recordSourceFailure({ cycleId, requestHash, stage, code, terminal }) { Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "failed", error_stage: stage, error_code: code, terminal: !!terminal }); },
    updateCycleCounts() {},
    report(rk, a) { return reportJobs.get(rkey(rk, a)); },
    listReportJobs() { return [...reportJobs.values()].map((j) => ({ ...j })); },
    upsertReportJob({ reportKey, accountId, connectionId, bucket, reportVersion, dependsOn }) { const k = rkey(reportKey, accountId); if (reportJobs.has(k)) return; reportJobs.set(k, { report_key: reportKey, account_id: accountId, connection_id: connectionId, bucket, report_version: reportVersion, depends_on: dependsOn || [], fetch_status: "pending", derive_status: "pending", save_status: "pending", validated: false }); },
    claimReportDerive(_c, rk, a) { const j = reportJobs.get(rkey(rk, a)); if (j && j.derive_status === "pending") { j.derive_status = "running"; return true; } return false; },
    recordReportBlocked({ reportKey, accountId }) { Object.assign(reportJobs.get(rkey(reportKey, accountId)), { fetch_status: "blocked", derive_status: "skipped", save_status: "skipped" }); },
    recordReportFailure({ reportKey, accountId, stage, code }) { Object.assign(reportJobs.get(rkey(reportKey, accountId)), { derive_status: stage === "save" ? "succeeded" : "failed", save_status: stage === "save" ? "failed" : "pending", error_code: code }); },
    recordReportSuccess({ reportKey, accountId, latestDataDate }) { Object.assign(reportJobs.get(rkey(reportKey, accountId)), { fetch_status: "ready", derive_status: "succeeded", save_status: "succeeded", validated: true, latest_data_date: latestDataDate ?? null }); },
  };
  return store;
}
const pick = (store, names) => Object.fromEntries(names.map((n) => [n, store[n].bind(store)]));

// A dataDoe adapter that records every download key + total creates; faithful rows for named keys else minimal.
function makeDataDoe(faithful = {}) {
  const create = {}; const fetched = [];
  return {
    createCount: (h) => create[h] || 0,
    totalCreates: () => Object.values(create).reduce((a, b) => a + b, 0),
    fetchedKeys: () => fetched.slice(),
    async create(job) { create[job.requestHash] = (create[job.requestHash] || 0) + 1; return { exportId: "e_" + job.requestHash }; },
    async poll() {},
    async download(job) { fetched.push(job.requestKey || ""); const rk = job.requestKey || ""; if (Object.prototype.hasOwnProperty.call(faithful, rk)) return faithful[rk]; return rk.endsWith(":catalog") ? [{ child_asin: "A", product_brand: "Acme" }] : [{ x: 1 }]; },
  };
}
// A recording shadow snapshot saver (fake makeShadowSnapshotSaver): records the shadow report_key it saved under.
function makeSaver() {
  const saved = new Map();
  const saver = async ({ reportKey, accountId, payload }) => { saver.calls += 1; saved.set(reportKey + "|" + accountId, payload); return { paramsHash: "ph" }; };
  saver.calls = 0; saver.saved = saved;
  saver.savedKeys = () => [...saved.keys()];
  return saver;
}
// A control catalog resolver marking `ready` reports runtime-ready (and, by default, schedule-enabled).
const mkCatalog = (ready = [], enabled = ready) => () => [...new Set([...ready, ...enabled])].map((rk) => ({ reportKey: rk, ready: ready.includes(rk), scheduleEnabled: enabled.includes(rk) }));

const US = [{ id: "A1", country: "US", currency: "USD", name: "Acct One" }];
const asOfForUS = () => "2025-08-10";

// Build a runtime wired to the split combined store + fakes; returns { rt, store, dd, saver }.
function makeRuntime(over = {}) {
  const store = over.store || makeBackingStore();
  const dd = over.dataDoe || makeDataDoe(over.faithful || {});
  const saver = over.saver || makeSaver();
  const directory = over.directory || US;
  const rt = buildSchedulerV2Runtime({
    connections: over.connections || CONNS,
    makeSourceStore: () => pick(store, SOURCE_METHODS),
    makeReportStore: () => pick(store, REPORT_METHODS),
    makeDataDoeAdapter: () => dd,
    makeShadowSnapshotSaver: () => saver,
    fetchAccounts: over.fetchAccounts || (async () => directory),
    getAdMetrics: over.getAdMetrics || (async () => []),
    getCoverageState: over.getCoverageState || (async () => ({ windows: [], status: "missing", read: "ok" })),
    getAdsDailySourceRows: over.getAdsDailySourceRows || (async () => []),
    getAdsSyncStates: over.getAdsSyncStates || (async () => []),
    getAdsSyncCoverage: over.getAdsSyncCoverage || (async () => ({ windows: [], status: "missing", read: "ok" })),
    getReportSyncSettings: over.getReportSyncSettings || (async () => []), // durable scheduled controls (injected)
    controlCatalog: over.controlCatalog, // undefined => production fail-closed default
  });
  return { rt, store, dd, saver };
}

// A control catalog whose scheduleEnabled is DRIVEN by durable settings (mirrors schedulerV2ReportControlCatalog:
// `ready` from a fixed v2-ready set; `scheduleEnabled` = ready AND settings[report_key].schedule_enabled===true).
const settingsAwareCatalog = (readyKeys) => (settings = []) => {
  const byKey = new Map((settings || []).map((row) => [row.report_key ?? row.reportKey, row]));
  return readyKeys.map((rk) => ({ reportKey: rk, ready: true, scheduleEnabled: (byKey.get(rk) || {}).schedule_enabled === true }));
};

// Real-file readers for the audit/preflight (fs reads are permitted; they are not DataDoe exports or db writes).
const MIG_DIR = join(process.cwd(), "supabase", "migrations");
const realReadFile = (name) => (name === "supabase.js" ? readFileSync(join(process.cwd(), "lib", "server", "supabase.js"), "utf8") : readFileSync(join(MIG_DIR, name), "utf8"));

/* ===================== construction: zero I/O ===================== */

group("runtime composition: zero-I/O construction");

test("(zero I/O) buildSchedulerV2Runtime invokes NO collaborator at construction", () => {
  let io = 0;
  // Real method names (so combineStores can enumerate them) whose bodies THROW if ever called at build time.
  const throwingStore = (names, label) => Object.fromEntries(names.map((n) => [n, () => { io += 1; throw new Error("I/O during construction: " + label + "." + n); }]));
  const rt = buildSchedulerV2Runtime({
    connections: CONNS,
    makeSourceStore: () => throwingStore(SOURCE_METHODS, "source"),
    makeReportStore: () => throwingStore(REPORT_METHODS, "report"),
    makeDataDoeAdapter: () => ({ create: () => { io += 1; throw new Error("create"); }, poll: () => {}, download: () => {} }),
    makeShadowSnapshotSaver: () => (() => { io += 1; throw new Error("save"); }),
    makeSourceRowLoader: () => (() => { io += 1; throw new Error("loadSourceRows"); }),
    fetchAccounts: async () => { io += 1; throw new Error("discovery"); },
    getAdMetrics: async () => { io += 1; throw new Error("ads"); },
    getCoverageState: async () => { io += 1; throw new Error("coverage"); },
    getAdsDailySourceRows: async () => { io += 1; throw new Error("ppc rows"); },
    getAdsSyncStates: async () => { io += 1; throw new Error("ppc states"); },
    getAdsSyncCoverage: async () => { io += 1; throw new Error("ppc coverage"); },
    controlCatalog: mkCatalog([]),
  });
  assert.equal(io, 0, "no collaborator was invoked during construction");
  // But the runtime IS fully assembled (combineStores would throw on the trap store if it saw a non-function;
  // the trap Proxy returns functions, so the combine still runs -- the collaborators just are never CALLED).
  for (const k of ["connections", "store", "dataDoe", "saveSnapshot", "ppcAdsProviders", "loadDerivedContext", "discoverAccounts", "controlCatalog", "run"]) {
    assert.ok(k in rt, "runtime exposes " + k);
  }
  assert.equal(typeof rt.run, "function");
  assert.equal(typeof rt.discoverAccounts, "function");
});

/* ===================== combined store ===================== */

group("runtime composition: combined store (explicit, fail-closed)");

test("(combined store) exposes EVERY source + report worker method; listSourceJobs is the shared overlap", () => {
  const backing = makeBackingStore();
  const combined = combineStores([
    { label: "source", store: pick(backing, SOURCE_METHODS) },
    { label: "report", store: pick(backing, REPORT_METHODS) },
  ], { shared: ["listSourceJobs"] });
  for (const m of SOURCE_METHODS) assert.equal(typeof combined[m], "function", "combined store has source method " + m);
  for (const m of REPORT_METHODS) assert.equal(typeof combined[m], "function", "combined store has report method " + m);
  // No method silently dropped: the union (source + report minus the shared duplicate).
  const expected = new Set([...SOURCE_METHODS, ...REPORT_METHODS]);
  assert.equal(Object.keys(combined).length, expected.size, "combined store is exactly the method union");
});

test("(fail closed) a genuine method-name conflict aborts the combine; a bad shared decl also fails", () => {
  assert.throws(() => combineStores([
    { label: "source", store: { upsertReportJob() {} } },
    { label: "report", store: { upsertReportJob() {} } },
  ]), /conflicting method "upsertReportJob".*fail closed/s);
  assert.throws(() => combineStores([{ label: "s", store: { a() {} } }], { shared: ["not-present"] }), /shared method "not-present" was declared but no store provided it/);
  assert.throws(() => combineStores([{ label: "s", store: { a: 1 } }]), /is not a function; refusing to combine/);
});

/* ===================== preflight: no side effects, typed blockers ===================== */

group("runtime composition: no-side-effect preflight");

// A spy wrapper module: every wrapper is a call-counting function; the preflight only typeof-checks them.
function makeWrapperSpies() {
  const calls = { total: 0 };
  const w = {};
  for (const n of REQUIRED_WRAPPERS) w[n] = (...a) => { calls.total += 1; return null; };
  w._calls = calls;
  return w;
}

test("(preflight zero side effects) passes cleanly and invokes NO wrapper / discovery / export / write", () => {
  const wrappers = makeWrapperSpies();
  let connCalls = 0; let readCalls = 0;
  const pf = schedulerV2Preflight({
    env: { DATADOE_API_KEY: "x", SUPABASE_URL: "u", SUPABASE_SERVICE_ROLE_KEY: "k" },
    getConnections: () => { connCalls += 1; return CONNS; },
    controlCatalog: mkCatalog([]),
    wrappers,
    readFile: (n) => { readCalls += 1; return realReadFile(n); },
  });
  assert.equal(pf.ready, true, "preflight is ready with valid config + a locked catalog + matching schema");
  assert.deepEqual(pf.blockers, [], "no blockers");
  assert.equal(wrappers._calls.total, 0, "preflight NEVER called a wrapper (only typeof-checked)");
  assert.ok(connCalls >= 1 && readCalls >= 1, "preflight only READ (connections + files)");
  assert.equal(pf.checks.v2ControlsLocked.ok, true, "v2 controls confirmed locked");
  assert.ok(pf.checks.schema.ok, "schema audit ok");
});

test("(typed blockers) missing config / missing audit reader / unlocked control return SAFE typed codes", () => {
  const missing = schedulerV2Preflight({ env: {}, getConnections: () => { throw new Error("DATADOE_API_KEY is not configured."); }, controlCatalog: mkCatalog([]), readFile: null });
  assert.equal(missing.ready, false);
  const codes = missing.blockers.map((b) => b.code);
  assert.ok(codes.includes("ENV_MISSING"), "missing env => ENV_MISSING");
  assert.ok(codes.includes("PRIMARY_CONNECTION_MISSING"), "unconfigured connection => PRIMARY_CONNECTION_MISSING");
  assert.ok(codes.includes("SCHEMA_AUDIT_UNAVAILABLE"), "no readFile => SCHEMA_AUDIT_UNAVAILABLE (never a vacuous pass)");
  // An unexpectedly-unlocked v2 control fails closed.
  const unlocked = schedulerV2Preflight({ env: { DATADOE_API_KEY: "x", SUPABASE_URL: "u", SUPABASE_SERVICE_ROLE_KEY: "k" }, getConnections: () => CONNS, controlCatalog: mkCatalog(["brand-sales"]), readFile: realReadFile });
  assert.ok(unlocked.blockers.some((b) => b.code === "V2_CONTROLS_UNLOCKED"), "a ready v2 control => V2_CONTROLS_UNLOCKED");
});

/* ===================== migration readiness (static audit) ===================== */

group("runtime composition: migration<->wrapper compatibility audit");

test("(audit real) the four unapplied migrations match the calling wrappers", () => {
  const res = auditSchemaContract({ readFile: realReadFile });
  assert.equal(res.ok, true, "audit passes against the real migrations + wrappers");
  assert.deepEqual(res.blockers, []);
  // Every declared table/rpc/wrapper is accounted for in the matrix.
  assert.equal(res.matrix.length, SCHEDULER_V2_SCHEMA_CONTRACT.length);
});

test("(audit drift) a renamed table / dropped column / missing RPC / dropped wrapper each fails closed", () => {
  const base = {}; for (const e of SCHEDULER_V2_SCHEMA_CONTRACT) base[e.migration] = realReadFile(e.migration);
  base["supabase.js"] = realReadFile("supabase.js");
  const withMut = (mutator) => auditSchemaContract({ readFile: (n) => mutator(n, base[n]) });
  // Rename a table in its migration.
  const renamed = withMut((n, t) => n === "20260807_scheduler_v2.sql" ? t.replace(/public\.sync_cycles\b/g, "public.sync_cycles_RENAMED") : t);
  assert.ok(renamed.blockers.some((b) => b.code === "TABLE_MISSING" && b.table === "sync_cycles"), "renamed table => TABLE_MISSING");
  // Drop a wrapper-required column.
  const droppedCol = withMut((n, t) => n === "20260807_scheduler_v2.sql" ? t.replace(/\n\s*latest_data_date date,.*/, "\n") : t);
  assert.ok(droppedCol.blockers.some((b) => b.code === "COLUMN_MISSING"), "dropped column => COLUMN_MISSING");
  // Remove an RPC.
  const noRpc = withMut((n, t) => n === "20260807_scheduler_v2.sql" ? t.replace(/create or replace function public\.claim_sync_cycle/g, "create or replace function public.claim_sync_cycle_GONE") : t);
  assert.ok(noRpc.blockers.some((b) => b.code === "RPC_MISSING" && b.rpc === "claim_sync_cycle"), "removed RPC => RPC_MISSING");
  // Remove a wrapper export.
  const noWrap = withMut((n, t) => n === "supabase.js" ? t.replace(/export async function getSyncCycle\b/, "async function getSyncCycle_GONE") : t);
  assert.ok(noWrap.blockers.some((b) => b.code === "WRAPPER_MISSING" && b.wrapper === "getSyncCycle"), "removed wrapper => WRAPPER_MISSING");
  // A missing migration file fails closed.
  const noFile = auditSchemaContract({ readFile: (n) => { if (n === "20260811_sync_source_job_owners.sql") throw new Error("ENOENT"); return base[n]; } });
  assert.ok(noFile.blockers.some((b) => b.code === "MIGRATION_MISSING"), "absent migration => MIGRATION_MISSING");
});

test("(audit blocker 3) RPC param rename, comment-only constraint, removed named invariant, and required-wrapper coverage all fail closed", () => {
  const base = {}; for (const e of SCHEDULER_V2_SCHEMA_CONTRACT) base[e.migration] = realReadFile(e.migration);
  base["supabase.js"] = realReadFile("supabase.js");
  const withMut = (mutator) => auditSchemaContract({ readFile: (n) => mutator(n, base[n]) });
  // 1) Renamed RPC parameter p_request_hash -> p_hash must FAIL (exact names/order validated, not just the name).
  const renamedParam = withMut((n, t) => n === "20260807_scheduler_v2.sql" ? t.replace(/p_request_hash text/, "p_hash text") : t);
  assert.ok(renamedParam.blockers.some((b) => b.code === "RPC_PARAM_MISMATCH" && b.rpc === "claim_source_export_attempt"), "renamed p_request_hash => RPC_PARAM_MISMATCH");
  // 2) A removed UNIQUE constraint whose matching text survives ONLY in a comment must FAIL (comments ignored).
  const commentedOut = withMut((n, t) => n === "20260807_scheduler_v2.sql"
    ? t.replace("constraint sync_source_jobs_cycle_hash_unique unique (cycle_id, request_hash),", "-- constraint sync_source_jobs_cycle_hash_unique unique (cycle_id, request_hash)")
    : t);
  assert.ok(commentedOut.blockers.some((b) => (b.code === "CONSTRAINT_MISSING" || b.code === "NAMED_CONSTRAINT_MISSING") && b.table === "sync_source_jobs"), "unique-only-in-comment => CONSTRAINT/NAMED_CONSTRAINT_MISSING");
  // 3) A removed critical named invariant (the one-attempt guard) must FAIL by name.
  const noOneAttempt = withMut((n, t) => n === "20260807_scheduler_v2.sql" ? t.replace(/constraint sync_source_jobs_one_attempt/g, "constraint sync_source_jobs_one_attempt_GONE") : t);
  assert.ok(noOneAttempt.blockers.some((b) => b.code === "NAMED_CONSTRAINT_MISSING" && (b.constraints || []).includes("sync_source_jobs_one_attempt")), "removed one-attempt guard => NAMED_CONSTRAINT_MISSING");
  // 4) The owner FK + connection/identity constraints are audited by name too.
  const noFk = withMut((n, t) => n === "20260811_sync_source_job_owners.sql" ? t.replace(/constraint sync_source_job_owners_source_fk/g, "constraint sync_source_job_owners_source_fk_GONE") : t);
  assert.ok(noFk.blockers.some((b) => b.code === "NAMED_CONSTRAINT_MISSING" && (b.constraints || []).includes("sync_source_job_owners_source_fk")), "removed owner FK => NAMED_CONSTRAINT_MISSING");
  // 5) Every REQUIRED wrapper export is verified (not only the per-migration subset): dropping one outside the
  //    four migrations' tables (saveReportSnapshot) still fails closed.
  const noSaver = withMut((n, t) => n === "supabase.js" ? t.replace(/export async function saveReportSnapshot\b/, "async function saveReportSnapshot_GONE") : t);
  assert.ok(noSaver.blockers.some((b) => b.code === "REQUIRED_WRAPPER_MISSING" && b.wrapper === "saveReportSnapshot"), "unexported saveReportSnapshot => REQUIRED_WRAPPER_MISSING");
  assert.equal(auditSchemaContract({ readFile: (n) => base[n] }).requiredWrappers.ok, true, "all required wrappers exported in the real source");
});

test("(audit fix 1) named constraints are PROVEN for the expected table by kind/body: ADD->DROP, wrong table, mutated CHECK/FK all fail; canonical passes", () => {
  const base = {}; for (const e of SCHEDULER_V2_SCHEMA_CONTRACT) base[e.migration] = realReadFile(e.migration);
  base["supabase.js"] = realReadFile("supabase.js");
  const A = (mut) => auditSchemaContract({ readFile: (n) => mut ? mut(n, base[n]) : base[n] });
  const named = (r) => r.blockers.filter((b) => b.code === "NAMED_CONSTRAINT_MISSING");
  // canonical: the real migrations prove every named constraint (inline CREATE-body AND ALTER TABLE ADD forms).
  assert.equal(A().blockers.filter((b) => b.code === "NAMED_CONSTRAINT_MISSING").length, 0, "canonical migrations prove all named constraints");
  // ADD then DROP the one-attempt CHECK => not proven (present-then-removed).
  const dropped = A((n, t) => n === "20260807_scheduler_v2.sql" ? t + "\nalter table public.sync_source_jobs drop constraint sync_source_jobs_one_attempt;\n" : t);
  assert.ok(named(dropped).some((b) => b.constraints.includes("sync_source_jobs_one_attempt")), "ADD->DROP one_attempt => NAMED_CONSTRAINT_MISSING");
  // Correct name on the WRONG table (move the connection_id CHECK's ALTER to a different table) => not proven.
  const wrongTable = A((n, t) => n === "20260811_sync_source_job_owners.sql"
    ? t.replace("alter table public.sync_source_job_owners\n      add constraint sync_source_job_owners_connection_id_check", "alter table public.sync_cycles\n      add constraint sync_source_job_owners_connection_id_check")
    : t);
  assert.ok(named(wrongTable).some((b) => b.constraints.includes("sync_source_job_owners_connection_id_check")), "correct name on the wrong table => NAMED_CONSTRAINT_MISSING");
  // Mutated CHECK body (create_export_count = 1 -> = 2) => not proven.
  const badCheck = A((n, t) => n === "20260807_scheduler_v2.sql" ? t.replace("create_export_count = 1", "create_export_count = 2") : t);
  assert.ok(named(badCheck).some((b) => b.constraints.includes("sync_source_jobs_one_attempt")), "mutated one_attempt CHECK body => NAMED_CONSTRAINT_MISSING");
  // Mutated FK target (references public.sync_source_jobs -> public.sync_cycles) => not proven.
  const badFk = A((n, t) => n === "20260811_sync_source_job_owners.sql" ? t.replace("references public.sync_source_jobs", "references public.sync_cycles") : t);
  assert.ok(named(badFk).some((b) => b.constraints.includes("sync_source_job_owners_source_fk")), "mutated FK target => NAMED_CONSTRAINT_MISSING");
  // Mutated FK columns => not proven.
  const badFkCols = A((n, t) => n === "20260811_sync_source_job_owners.sql" ? t.replace("foreign key (cycle_id, request_hash)", "foreign key (cycle_id, owner_id)") : t);
  assert.ok(named(badFkCols).some((b) => b.constraints.includes("sync_source_job_owners_source_fk")), "mutated FK columns => NAMED_CONSTRAINT_MISSING");
});

test("(audit blocker: exact CHECK semantics + quoted SQL ignored) AND<->OR, extra IN value, operand reorder / extra clause, and quoted-only ADD CONSTRAINT all fail; canonical passes", () => {
  const base = {}; for (const e of SCHEDULER_V2_SCHEMA_CONTRACT) base[e.migration] = realReadFile(e.migration);
  base["supabase.js"] = realReadFile("supabase.js");
  const A = (mut) => auditSchemaContract({ readFile: (n) => mut ? mut(n, base[n]) : base[n] });
  const failsFor = (r, name) => r.blockers.some((b) => b.code === "NAMED_CONSTRAINT_MISSING" && b.constraints.includes(name));
  const V2 = "20260807_scheduler_v2.sql", OWN = "20260811_sync_source_job_owners.sql";
  assert.equal(A().ok, true, "canonical migrations still prove every exact CHECK (do-block ALTER ADDs discovered)");
  // 1) one-attempt AND -> OR weakening.
  const andOr = A((n, t) => n === V2 ? t.replace("create_export_count = 0 and attempted_at is null", "create_export_count = 0 or attempted_at is null") : t);
  assert.ok(failsFor(andOr, "sync_source_jobs_one_attempt"), "one-attempt AND->OR fails");
  // 2) connection_id permits an extra value 'evil'.
  const extraVal = A((n, t) => n === OWN ? t.replace("connection_id in ('primary', 'dd-secondary')", "connection_id in ('primary', 'dd-secondary', 'evil')") : t);
  assert.ok(failsFor(extraVal, "sync_source_job_owners_connection_id_check"), "connection_id extra value 'evil' fails");
  // 3) owner identity AND -> OR weakening.
  const idOr = A((n, t) => n === OWN ? t.replace("char_length(report_key) > 0 and char_length(account_id) > 0", "char_length(report_key) > 0 or char_length(account_id) > 0") : t);
  assert.ok(failsFor(idOr, "sync_source_job_owners_identity_nonempty"), "identity AND->OR fails");
  // 4a) the real one-attempt CHECK removed; its full text survives ONLY inside a single-quoted string.
  const quotedSingle = A((n, t) => n === V2
    ? t.replace(/constraint sync_source_jobs_one_attempt check \([\s\S]*?\)\s*\)/, "x_removed_placeholder integer")
       + "\ncomment on table public.sync_source_jobs is 'constraint sync_source_jobs_one_attempt check ((create_export_count = 0 and attempted_at is null) or (create_export_count = 1 and attempted_at is not null))';\n"
    : t);
  assert.ok(failsFor(quotedSingle, "sync_source_jobs_one_attempt"), "ADD text only inside a single-quoted string fails");
  // 4b) the real connection_id ALTER removed; its full text survives ONLY inside a dollar-quoted string.
  const quotedDollar = A((n, t) => n === OWN
    ? t.replace(/alter table public\.sync_source_job_owners\s*\n\s*add constraint sync_source_job_owners_connection_id_check check \(connection_id in \('primary', 'dd-secondary'\)\);/,
      "perform $q$ alter table public.sync_source_job_owners add constraint sync_source_job_owners_connection_id_check check (connection_id in ('primary', 'dd-secondary')) $q$;")
    : t);
  assert.ok(failsFor(quotedDollar, "sync_source_job_owners_connection_id_check"), "ADD text only inside a dollar-quoted string fails");
  // 5) operand reorder + 6) extra clause both change the exact token sequence => fail.
  const reorder = A((n, t) => n === V2 ? t.replace("create_export_count = 0 and attempted_at is null", "attempted_at is null and create_export_count = 0") : t);
  assert.ok(failsFor(reorder, "sync_source_jobs_one_attempt"), "operand reorder fails");
  const extraClause = A((n, t) => n === V2 ? t.replace("(create_export_count = 1 and attempted_at is not null)", "(create_export_count = 1 and attempted_at is not null and 1 = 1)") : t);
  assert.ok(failsFor(extraClause, "sync_source_jobs_one_attempt"), "extra CHECK clause fails");
});

test("(audit blocker 1) an FK REFERENCES clause OUTSIDE the constraint's own CREATE-body/ALTER cannot satisfy the FK target: real REFERENCES removed + an unrelated later FK to the same target => NAMED_CONSTRAINT_MISSING; canonical passes", () => {
  const base = {}; for (const e of SCHEDULER_V2_SCHEMA_CONTRACT) base[e.migration] = realReadFile(e.migration);
  base["supabase.js"] = realReadFile("supabase.js");
  const A = (mut) => auditSchemaContract({ readFile: (n) => mut ? mut(n, base[n]) : base[n] });
  const named = (r) => r.blockers.filter((b) => b.code === "NAMED_CONSTRAINT_MISSING");
  const OWN = "20260811_sync_source_job_owners.sql";
  // canonical proves the FK -- its REFERENCES lives inside the SAME CREATE body as the constraint.
  assert.equal(named(A()).length, 0, "canonical proves sync_source_job_owners_source_fk");
  // Delete the FK's REAL `references public.sync_source_jobs (cycle_id, request_hash)` from the owner table body,
  // then append an UNRELATED table whose FK references the SAME target LATER in the file. A REFERENCES lookup
  // that escaped the constraint's [from,to) declaration would wrongly adopt that out-of-scope target; the scoped
  // lookup must find NO in-scope target and fail closed.
  const escaped = A((n, t) => n === OWN
    ? t.replace(/\n\s*references public\.sync_source_jobs \(cycle_id, request_hash\) on delete cascade/, "")
       + "\ncreate table if not exists public.unrelated_fk_probe (\n"
       + "  cycle_id uuid,\n  request_hash text,\n"
       + "  constraint unrelated_fk_probe_fk foreign key (cycle_id, request_hash)\n"
       + "    references public.sync_source_jobs (cycle_id, request_hash)\n);\n"
    : t);
  assert.ok(named(escaped).some((b) => b.constraints.includes("sync_source_job_owners_source_fk")), "FK target satisfiable only by an out-of-scope later REFERENCES => NAMED_CONSTRAINT_MISSING");
});

test("(audit blocker 2) wrapper-export + endpoint evidence must be REAL JavaScript: comment / string / template-text / regex fakes never satisfy an export, a commented endpoint never satisfies a reference, removing a real wrapper => REQUIRED_WRAPPER_MISSING (named); canonical passes", () => {
  const base = {}; for (const e of SCHEDULER_V2_SCHEMA_CONTRACT) base[e.migration] = realReadFile(e.migration);
  base["supabase.js"] = realReadFile("supabase.js");
  const A = (mut) => auditSchemaContract({ readFile: (n) => mut ? mut(n, base[n]) : base[n] });
  const wrapperMissing = (r, name) => r.blockers.some((b) => b.code === "REQUIRED_WRAPPER_MISSING" && b.wrapper === name) && r.requiredWrappers.missing.includes(name);
  // canonical: the real supabase.js exports every required wrapper AND references every table/rpc from a real
  // string/template literal (proves genuine literal endpoints -- including template literals -- still count).
  const real = A();
  assert.equal(real.requiredWrappers.ok, true, "canonical: all required wrappers exported");
  assert.equal(real.blockers.filter((b) => b.code === "REQUIRED_WRAPPER_MISSING" || b.code === "TABLE_WRAPPER_MISSING" || b.code === "RPC_WRAPPER_MISSING").length, 0, "canonical: every table/rpc referenced from a real literal");
  // Remove the REAL saveReportSnapshot export, then re-add fake "evidence" in four non-code forms. NONE may
  // satisfy the export: each must STILL report REQUIRED_WRAPPER_MISSING naming saveReportSnapshot.
  const disable = (t) => t.replace(/export async function saveReportSnapshot\b/, "async function saveReportSnapshot_DISABLED");
  const fakes = {
    "line comment": "\n// export async function saveReportSnapshot(x) { return x; }\n",
    "block comment": "\n/* export async function saveReportSnapshot( */\n",
    "quoted string": "\nconst f1 = \"export async function saveReportSnapshot(\";\n",
    "template text": "\nconst f2 = `export async function saveReportSnapshot(`;\n",
    "regex literal": "\nconst f3 = /export async function saveReportSnapshot\\(/;\n",
  };
  for (const [label, fake] of Object.entries(fakes)) {
    const r = A((n, t) => n === "supabase.js" ? disable(t) + fake : t);
    assert.ok(wrapperMissing(r, "saveReportSnapshot"), label + " fake export => still REQUIRED_WRAPPER_MISSING (naming saveReportSnapshot)");
  }
  // Baseline: removing the real wrapper with NO fake also fails (confirms `disable` truly un-exports it).
  assert.ok(wrapperMissing(A((n, t) => n === "supabase.js" ? disable(t) : t), "saveReportSnapshot"), "removed real wrapper => REQUIRED_WRAPPER_MISSING");
  // Endpoint evidence: move the ONLY /rest/v1/rpc/open_sync_cycle occurrence into a comment. A comment must NOT
  // satisfy the RPC reference (genuine literals still do -- proven by the canonical pass above).
  const commentedRpc = A((n, t) => n === "supabase.js"
    ? t.replace("\"/rest/v1/rpc/open_sync_cycle\"", "\"/rest/v1/rpc/OPEN_DISABLED\" /* /rest/v1/rpc/open_sync_cycle */")
    : t);
  assert.ok(commentedRpc.blockers.some((b) => b.code === "RPC_WRAPPER_MISSING" && b.rpc === "open_sync_cycle"), "endpoint only in a comment => RPC_WRAPPER_MISSING");
});

test("(audit blocker: endpoint evidence only from real literals) division / ternary / identifiers / split-splices / ${ordinary code} never forge an endpoint; genuine single/double/template literals (and a genuine nested literal inside ${...}) do; canonical passes", () => {
  const base = {}; for (const e of SCHEDULER_V2_SCHEMA_CONTRACT) base[e.migration] = realReadFile(e.migration);
  base["supabase.js"] = realReadFile("supabase.js");
  const A = (mut) => auditSchemaContract({ readFile: (n) => mut ? mut(n, base[n]) : base[n] });
  const rpcMissing = (r) => r.blockers.some((b) => b.code === "RPC_WRAPPER_MISSING" && b.rpc === "open_sync_cycle");
  const tblMissing = (r) => r.blockers.some((b) => b.code === "TABLE_WRAPPER_MISSING" && b.table === "sync_cycles");
  // Remove the genuine endpoint literals so ONLY the appended fake could satisfy the reference.
  const stripRpc = (t) => t.replaceAll("\"/rest/v1/rpc/open_sync_cycle\"", "\"/rest/v1/rpc/OPEN_DISABLED\"");
  const stripTbl = (t) => t.replaceAll("/rest/v1/sync_cycles?", "/rest/v1/DISABLED_cycles?");
  // canonical: genuine double-quoted (open_sync_cycle) + template-literal (sync_cycles) endpoints are recognized.
  const real = A();
  assert.ok(!rpcMissing(real) && !tblMissing(real), "canonical: genuine string + template endpoints recognized");
  // (1) RPC division expression `a/rest/v1/rpc/open_sync_cycle` is ordinary CODE, not a literal.
  const rpcDiv = A((n, t) => n === "supabase.js" ? stripRpc(t) + "\nfunction fake(a, rest, v1, rpc, open_sync_cycle) {\n  return a/rest/v1/rpc/open_sync_cycle;\n}\n" : t);
  assert.ok(rpcMissing(rpcDiv), "RPC division expression => RPC_WRAPPER_MISSING");
  // (2) Table division/ternary `a/rest/v1/sync_cycles ? yes : no` (spaced AND unspaced) is ordinary CODE.
  const tblTernary = A((n, t) => n === "supabase.js" ? stripTbl(t) + "\nfunction fakeTable(a, rest, v1, sync_cycles, yes, no) {\n  return a/rest/v1/sync_cycles ? yes : no;\n}\n" : t);
  assert.ok(tblMissing(tblTernary), "table ternary (spaced) => TABLE_WRAPPER_MISSING");
  const tblTernary2 = A((n, t) => n === "supabase.js" ? stripTbl(t) + "\nfunction fakeTable2(a, rest, v1, sync_cycles, yes, no) {\n  return a/rest/v1/sync_cycles?yes:no;\n}\n" : t);
  assert.ok(tblMissing(tblTernary2), "table ternary (unspaced) => TABLE_WRAPPER_MISSING");
  // (3) Split across two adjacent string literals, or a literal spliced with code, must NOT concatenate.
  const splitLit = A((n, t) => n === "supabase.js" ? stripTbl(t) + "\nconst sp = \"/rest/v1/sync_cycles\" + \"?on_conflict=x\";\n" : t);
  assert.ok(tblMissing(splitLit), "adjacent-literal split => TABLE_WRAPPER_MISSING (boundaries stay blank)");
  const litCode = A((n, t) => n === "supabase.js" ? stripTbl(t) + "\nconst lc = \"/rest/v1/sync_cycles\" + qs;\n" : t);
  assert.ok(tblMissing(litCode), "literal + code splice => TABLE_WRAPPER_MISSING");
  // (4) Endpoint text inside ${ordinary code} does NOT count; inside a genuine nested string literal it DOES.
  const interpCode = A((n, t) => n === "supabase.js" ? stripTbl(t) + "\nconst ic = `p${ z/rest/v1/sync_cycles?y:w }q`;\n" : t);
  assert.ok(tblMissing(interpCode), "endpoint as ${ordinary code} => TABLE_WRAPPER_MISSING");
  const interpLit = A((n, t) => n === "supabase.js" ? stripTbl(t) + "\nconst il = `p${ cond ? \"/rest/v1/sync_cycles?\" : \"\" }q`;\n" : t);
  assert.ok(!tblMissing(interpLit), "genuine nested string literal inside ${...} => recognized");
  // (5) A regex literal shaped like the endpoint is blanked in the literal view.
  const rpcRegex = A((n, t) => n === "supabase.js" ? stripRpc(t) + "\nconst rx = /\\/rest\\/v1\\/rpc\\/open_sync_cycle/;\n" : t);
  assert.ok(rpcMissing(rpcRegex), "regex-shaped endpoint => RPC_WRAPPER_MISSING");
  // (6) Genuine SINGLE-quoted endpoint literal is recognized (double-quoted + template proven by canonical).
  const singleQuoted = A((n, t) => n === "supabase.js" ? t.replace("\"/rest/v1/rpc/open_sync_cycle\"", "'/rest/v1/rpc/open_sync_cycle'") : t);
  assert.ok(!rpcMissing(singleQuoted), "genuine single-quoted endpoint => recognized");
});

test("(audit fix 2) auditSchemaContract always returns a TOTAL {ok,matrix,blockers,requiredWrappers}; a null/throwing supabase.js reader never crashes", () => {
  const base = {}; for (const e of SCHEDULER_V2_SCHEMA_CONTRACT) base[e.migration] = realReadFile(e.migration);
  const shapeOk = (r) => r && typeof r.ok === "boolean" && Array.isArray(r.matrix) && Array.isArray(r.blockers)
    && r.requiredWrappers && typeof r.requiredWrappers.total === "number" && Array.isArray(r.requiredWrappers.missing) && typeof r.requiredWrappers.ok === "boolean";
  const nullSrc = auditSchemaContract({ readFile: (n) => (n === "supabase.js" ? null : base[n]) });
  assert.ok(shapeOk(nullSrc), "missing supabase.js still returns the TOTAL result shape");
  assert.equal(nullSrc.ok, false);
  assert.ok(nullSrc.blockers.some((b) => b.code === "WRAPPER_SOURCE_MISSING"), "missing wrapper source => typed WRAPPER_SOURCE_MISSING");
  assert.equal(nullSrc.requiredWrappers.ok, false);
  const throwSrc = auditSchemaContract({ readFile: (n) => { if (n === "supabase.js") throw new Error("EACCES"); return base[n]; } });
  assert.ok(shapeOk(throwSrc), "a throwing supabase.js reader still returns the TOTAL result shape (no crash)");
  // The preflight must also survive a missing wrapper source WITHOUT crashing, returning typed safe blockers.
  const pf = schedulerV2Preflight({ env: { DATADOE_API_KEY: "x", SUPABASE_URL: "u", SUPABASE_SERVICE_ROLE_KEY: "k" }, getConnections: () => CONNS, controlCatalog: mkCatalog([]), readFile: (n) => (n === "supabase.js" ? null : "x") });
  assert.equal(pf.ready, false, "preflight fails closed when the wrapper source is unreadable");
  assert.equal(pf.checks.wrappers.ok, false, "wrapper availability is NOT claimed proven");
  assert.ok(pf.blockers.every((b) => typeof b.code === "string"), "every preflight blocker is a typed safe code");
  assert.ok(!JSON.stringify(pf).includes(PRIMARY_KEY), "no secret in preflight telemetry");
});

/* ===================== dispatch behavior via the composed runtime ===================== */

group("runtime composition: dispatch behavior (cache-only, locked, ready cycle, discovery)");

test("(default locked) the composed runtime with DEFAULT v2 controls dispatches zero reports/exports", async () => {
  const { rt, dd } = makeRuntime({}); // no controlCatalog override => production fail-closed default
  const r = await rt.run({ bucket: "us", cycleDate: "2026-08-11", asOf: "2025-08-10", asOfFor: asOfForUS, manualReportKeys: ["brand-sales"] });
  assert.deepEqual(r.selected, [], "brand-sales is v2-locked by the default catalog");
  assert.deepEqual(r.lockedOut, ["brand-sales"]);
  assert.equal(dd.totalCreates(), 0, "zero DataDoe exports under the default locked controls");
});

test("(ready cycle) an injected ready control drives ONE complete shadow cycle; snapshot is scheduler-v2/* namespaced; derivation is cache-only (zero DataDoe in derive)", async () => {
  const { rt, store, dd, saver } = makeRuntime({ controlCatalog: mkCatalog(["brand-sales"]) });
  const r = await rt.run({ bucket: "us", cycleDate: "2026-08-11", asOf: "2025-08-10", asOfFor: asOfForUS });
  assert.deepEqual(r.selected, ["brand-sales"], "the ready report is selected");
  assert.ok(r.cycleId, "a source cycle opened");
  assert.equal(saver.calls, 1, "brand-sales derived + saved exactly one snapshot");
  assert.ok(saver.savedKeys().every((k) => k.startsWith("scheduler-v2/")), "the snapshot is saved under the scheduler-v2/* shadow namespace");
  assert.ok(saver.saved.has("scheduler-v2/brand-sales|A1"), "the shadow snapshot key is namespaced + account-scoped");
  // Cache-only derivation: every DataDoe download was a brand-sales SOURCE; the derive read rows via the
  // cache-only store.loadSourceRows, never a DataDoe export.
  assert.ok(dd.fetchedKeys().every((k) => k.startsWith("brand-sales:")), "every DataDoe fetch was a planned source; derive made zero DataDoe calls");
  assert.equal(store.report("brand-sales", "A1").derive_status, "succeeded");
});

test("(new primary account) discovery reflects a newly connected primary account with NO code change", async () => {
  let directory = [{ id: "A1", country: "US", currency: "USD", name: "One" }];
  const common = { controlCatalog: mkCatalog(["brand-sales"]), fetchAccounts: async () => directory, store: makeBackingStore() };
  const first = makeRuntime({ ...common });
  const r1 = await first.rt.run({ bucket: "us", cycleDate: "2026-08-11", asOf: "2025-08-10", asOfFor: asOfForUS });
  assert.deepEqual(r1.accountsDispatched, ["A1"]);
  directory = [{ id: "A1", country: "US", currency: "USD", name: "One" }, { id: "A2", country: "US", currency: "USD", name: "Two" }];
  const second = makeRuntime({ ...common, store: makeBackingStore() });
  const r2 = await second.rt.run({ bucket: "us", cycleDate: "2026-08-11", asOf: "2025-08-10", asOfFor: asOfForUS });
  assert.deepEqual(r2.accountsDispatched.sort(), ["A1", "A2"], "the newly connected primary account participates automatically");
});

test("(dormant dd-secondary) a stale dd-secondary account is read-only/unavailable and spends ZERO exports", async () => {
  // Primary-only connections; the directory still lists a dd-secondary account (secondary org retired).
  const directory = [{ id: dash("dd", "secondary") + ":Z9", country: "US", currency: "USD", name: "Stale" }];
  const { rt, dd } = makeRuntime({ connections: CONNS, directory, controlCatalog: mkCatalog(["brand-sales"]) });
  const r = await rt.run({ bucket: "us", cycleDate: "2026-08-11", asOf: "2025-08-10", asOfFor: asOfForUS });
  assert.deepEqual(r.accountsDispatched, [], "the dormant dd-secondary account is never routed through the primary key");
  assert.ok((r.unavailableAccounts || []).some((a) => String(a.accountId).includes(dash("dd", "secondary") + ":Z9")), "it is reported unavailable/read-only");
  assert.equal(dd.totalCreates(), 0, "a dormant dd-secondary account spends zero exports");
});

test("(discovery fail-closed) a discovery failure rejects BEFORE any source export", async () => {
  const { rt, dd } = makeRuntime({ controlCatalog: mkCatalog(["brand-sales"]), fetchAccounts: async () => { throw new Error("directory unavailable"); } });
  await assert.rejects(rt.run({ bucket: "us", cycleDate: "2026-08-11", asOf: "2025-08-10", asOfFor: asOfForUS }), /directory unavailable/);
  assert.equal(dd.totalCreates(), 0, "discovery failure spends zero exports (fails closed before dispatch)");
});

/* ===================== review blockers 1, 2, 4 ===================== */

group("runtime composition: durable settings + protected collaborators + locked zero-I/O (blockers 1,2,4)");

const throwingHalf = (names, label) => Object.fromEntries(names.map((n) => [n, () => { throw new Error("I/O: " + label + "." + n); }]));

test("(blocker 1: durable settings drive selection) scheduled loads report_sync_settings (NOT caller-supplied); manual stays readiness-gated", async () => {
  const catalog = settingsAwareCatalog(["brand-sales"]); // ready via the v2 set; scheduleEnabled from durable settings
  // schedule_enabled=true => the v2-ready report is selected.
  const on = makeRuntime({ controlCatalog: catalog, getReportSyncSettings: async () => [{ report_key: "brand-sales", schedule_enabled: true }] });
  const rOn = await on.rt.run({ bucket: "us", cycleDate: "2026-08-11", asOf: "2025-08-10", asOfFor: asOfForUS });
  assert.deepEqual(rOn.selected, ["brand-sales"], "durable schedule_enabled=true selects the v2-ready report");
  // schedule_enabled=false => NOT selected; a caller-supplied `settings` override is IGNORED (never the control source).
  const off = makeRuntime({ controlCatalog: catalog, getReportSyncSettings: async () => [{ report_key: "brand-sales", schedule_enabled: false }] });
  const rOff = await off.rt.run({ bucket: "us", cycleDate: "2026-08-11", asOf: "2025-08-10", asOfFor: asOfForUS, settings: [{ report_key: "brand-sales", schedule_enabled: true }] });
  assert.deepEqual(rOff.selected, [], "durable schedule_enabled=false does not select; caller-supplied settings are ignored");
  // A manual request is readiness-gated (a NOT-v2-ready report is locked out) and never loads durable settings.
  const man = makeRuntime({ controlCatalog: settingsAwareCatalog([]), getReportSyncSettings: async () => { throw new Error("settings must not load for manual"); } });
  const rMan = await man.rt.run({ bucket: "us", cycleDate: "2026-08-11", asOf: "2025-08-10", asOfFor: asOfForUS, manualReportKeys: ["brand-sales"] });
  assert.deepEqual(rMan.selected, [], "manual brand-sales (not v2-ready) is readiness-gated => not dispatched");
  assert.deepEqual(rMan.lockedOut, ["brand-sales"]);
});

test("(blocker 1: settings fail closed) a getReportSyncSettings failure on a scheduled run fails closed BEFORE discovery/cycle/store/DataDoe", async () => {
  let discovery = 0;
  const rt = buildSchedulerV2Runtime({
    connections: CONNS,
    makeSourceStore: () => throwingHalf(SOURCE_METHODS, "source"),
    makeReportStore: () => throwingHalf(REPORT_METHODS, "report"),
    makeDataDoeAdapter: () => ({ create: () => { throw new Error("create"); }, poll: () => {}, download: () => {} }),
    makeShadowSnapshotSaver: () => (() => { throw new Error("save"); }),
    fetchAccounts: async () => { discovery += 1; throw new Error("discovery"); },
    getReportSyncSettings: async () => { throw new Error("settings read failed"); },
    controlCatalog: mkCatalog(["brand-sales"]), // even a READY report must not proceed if durable settings cannot load
  });
  await assert.rejects(rt.run({ bucket: "us", cycleDate: "2026-08-11", asOf: "2025-08-10", asOfFor: asOfForUS }), /settings read failed/);
  assert.equal(discovery, 0, "settings-read failure fails closed BEFORE discovery / cycle / store / DataDoe");
});

test("(blocker 2: reserved run overrides are dropped) a run cannot unlock a report, reroute organizations, or replace the shadow saver", async () => {
  // A) cannot UNLOCK: malicious controlCatalog + settings are dropped; the trusted (default) catalog keeps it locked.
  const locked = makeRuntime({ controlCatalog: mkCatalog([]) });
  const rA = await locked.rt.run({
    bucket: "us", cycleDate: "2026-08-11", asOf: "2025-08-10", asOfFor: asOfForUS,
    manualReportKeys: ["brand-sales"], controlCatalog: mkCatalog(["brand-sales"]), settings: [{ report_key: "brand-sales", schedule_enabled: true }],
  });
  assert.deepEqual(rA.selected, [], "a reserved controlCatalog/settings override cannot unlock brand-sales");
  assert.deepEqual(rA.lockedOut, ["brand-sales"]);
  // B) cannot REROUTE or REPLACE the saver: a READY cycle uses the TRUSTED discovery + saver, never the injected evil ones.
  let evilSaverCalled = false;
  const { rt, saver } = makeRuntime({ controlCatalog: mkCatalog(["brand-sales"]) });
  const rB = await rt.run({
    bucket: "us", cycleDate: "2026-08-11", asOf: "2025-08-10", asOfFor: asOfForUS,
    saveSnapshot: async () => { evilSaverCalled = true; return { paramsHash: "evil" }; },
    connections: [{ id: "primary", apiKey: "evil" }],
    discoverAccounts: async () => [{ id: "EVIL", country: "US", currency: "USD", name: "Evil" }],
    dataDoe: { create: () => { throw new Error("evil dataDoe"); }, poll: () => {}, download: () => {} },
    store: { openCycle: () => { throw new Error("evil store"); } },
    ppcAdsProviders: {}, loadDerivedContext: async () => ({ adsCoverage: "evil" }),
  });
  assert.deepEqual(rB.selected, ["brand-sales"]);
  assert.equal(saver.calls, 1, "the TRUSTED shadow saver saved");
  assert.equal(evilSaverCalled, false, "the injected evil saveSnapshot was NEVER called");
  assert.ok(saver.saved.has("scheduler-v2/brand-sales|A1"), "saved under the trusted shadow namespace for the trusted discovered account A1");
  assert.deepEqual(rB.accountsDispatched, ["A1"], "the TRUSTED discovery (A1) was used, not the injected EVIL directory");
});

test("(blocker 4: locked zero-I/O) default-locked MANUAL and SCHEDULED runs return a deterministic drained rollup and touch NO discovery/store/DataDoe", async () => {
  let discovery = 0, settings = 0;
  const make = () => buildSchedulerV2Runtime({
    connections: CONNS,
    makeSourceStore: () => throwingHalf(SOURCE_METHODS, "source"),
    makeReportStore: () => throwingHalf(REPORT_METHODS, "report"),
    makeDataDoeAdapter: () => ({ create: () => { throw new Error("create"); }, poll: () => { throw new Error("poll"); }, download: () => { throw new Error("download"); } }),
    makeShadowSnapshotSaver: () => (() => { throw new Error("save"); }),
    fetchAccounts: async () => { discovery += 1; throw new Error("discovery must not run for a locked invocation"); },
    getReportSyncSettings: async () => { settings += 1; return []; },
    controlCatalog: () => [], // default fail-closed: nothing v2-ready
  });
  const expectDrained = (r) => assert.deepEqual(
    { selected: r.selected, drained: r.drained, continuationRequired: r.continuationRequired, spent: r.spent, cycleId: r.cycleId },
    { selected: [], drained: true, continuationRequired: false, spent: 0, cycleId: null });
  expectDrained(await make().run({ bucket: "us", cycleDate: "2026-08-11", asOf: "2025-08-10", manualReportKeys: ["brand-sales"] })); // MANUAL locked
  expectDrained(await make().run({ bucket: "us", cycleDate: "2026-08-11", asOf: "2025-08-10" }));                                    // SCHEDULED locked
  assert.equal(discovery, 0, "discovery NEVER ran for a locked invocation (zero I/O before dispatch)");
  assert.equal(settings, 1, "only the scheduled run loaded durable settings once (a control READ); the manual run loaded none");
});

test("(fix 3) a malformed manualReportKeys fails closed BEFORE any settings read / discovery / store / DataDoe; null=scheduled, []=manual are preserved", async () => {
  let settings = 0, discovery = 0;
  const rt = buildSchedulerV2Runtime({
    connections: CONNS,
    makeSourceStore: () => throwingHalf(SOURCE_METHODS, "source"),
    makeReportStore: () => throwingHalf(REPORT_METHODS, "report"),
    makeDataDoeAdapter: () => ({ create: () => { throw new Error("create"); }, poll: () => {}, download: () => {} }),
    makeShadowSnapshotSaver: () => (() => { throw new Error("save"); }),
    fetchAccounts: async () => { discovery += 1; throw new Error("discovery"); },
    getReportSyncSettings: async () => { settings += 1; return []; },
    controlCatalog: () => [], // nothing v2-ready
  });
  // Every non-null, non-array manualReportKeys is a malformed manual request that fails closed with ZERO I/O.
  for (const bad of ["brand-sales", 123, {}, true, () => {}]) {
    await assert.rejects(rt.run({ bucket: "us", cycleDate: "2026-08-11", asOf: "2025-08-10", manualReportKeys: bad }), /manualReportKeys must be null\/undefined .* or an array .* Refusing \(fail closed\)/s);
  }
  assert.equal(settings, 0, "a malformed manual request read ZERO durable settings");
  assert.equal(discovery, 0, "a malformed manual request performed ZERO discovery / store / DataDoe");
  // null/undefined => scheduled (loads durable settings once, then locked zero-I/O); [] => manual (loads none).
  const rSched = await rt.run({ bucket: "us", cycleDate: "2026-08-11", asOf: "2025-08-10" });
  assert.deepEqual(rSched.selected, [], "scheduled run stays readiness-gated (nothing v2-ready)");
  assert.equal(settings, 1, "the scheduled run loaded durable settings once");
  const rEmpty = await rt.run({ bucket: "us", cycleDate: "2026-08-11", asOf: "2025-08-10", manualReportKeys: [] });
  assert.equal(rEmpty.manual, true, "[] is a manual request");
  assert.deepEqual(rEmpty.selected, [], "manual [] selects nothing");
  assert.equal(settings, 1, "manual [] loaded NO additional durable settings");
  assert.equal(discovery, 0, "no discovery across the locked scheduled + empty-manual runs");
});

/* ===================== telemetry safety: no secrets / raw errors ===================== */

group("runtime composition: telemetry never leaks secrets/raw errors");

test("(no secrets) preflight + dispatch telemetry never contain an api key or a raw error object", async () => {
  // Preflight blockers must be secret-free even when the connection reader throws a message.
  const pf = schedulerV2Preflight({ env: {}, getConnections: () => { throw new Error("DATADOE_API_KEY=" + PRIMARY_KEY); }, controlCatalog: mkCatalog([]), readFile: null });
  const pfText = JSON.stringify(pf);
  assert.ok(!pfText.includes(PRIMARY_KEY), "no api key value in preflight telemetry");
  assert.ok(!/DATADOE_API_KEY=/.test(pfText), "no raw connection error string in preflight telemetry");
  for (const b of pf.blockers) assert.equal(typeof b.code, "string", "every blocker is a typed code");
  // A completed dispatch rollup carries only safe account ids / report keys, never an api key.
  const { rt } = makeRuntime({ controlCatalog: mkCatalog(["brand-sales"]) });
  const r = await rt.run({ bucket: "us", cycleDate: "2026-08-11", asOf: "2025-08-10", asOfFor: asOfForUS });
  assert.ok(!JSON.stringify(r).includes(PRIMARY_KEY), "no api key value in the dispatch rollup telemetry");
});

/* ============================= runner ============================= */

async function main() {
  ({ buildSchedulerV2Runtime, combineStores, makeProductionDiscoverAccounts, schedulerV2Preflight, REQUIRED_WRAPPERS } = await import("../lib/server/sync/runtime-composition.js"));
  ({ auditSchemaContract, SCHEDULER_V2_SCHEMA_CONTRACT } = await import("../lib/server/sync/schema-contract.js"));
  void makeProductionDiscoverAccounts;

  for (const t of tests) {
    if (t.marker) { continue; }
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
