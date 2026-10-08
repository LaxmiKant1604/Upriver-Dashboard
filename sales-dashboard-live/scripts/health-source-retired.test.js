// FBA Inventory Health RETIREMENT -- "every create path is refused" (Listings inventory cutover, 2026-10).
//
// No new FBA Inventory Health export may be created from ANY path; every caller gets a typed, user-readable refusal
// (never a loop, a retry or a generic failure). The SAVED Health snapshots stay readable (the dated read-only bridge,
// lib/server/inventory-source.js) -- only creation is removed. Offline: global fetch is COUNTED and REFUSED (zero
// network), zero database, zero DataDoe.
//   (1) planners: ZERO Health jobs for every planned report across all three regions (the generic shadow plan over every
//       scheduled + dedicated report key, the batched fba-plan + listing-health-v3 planners, the staged Sales Movers
//       plan, the single-account fba-plan planner) and every bucket source sync; no report contract, source-registry
//       record, tranche, scheduled family or Data Sync Center readiness source names Health. The canonical Listings
//       export (fba-plan:awd == listing-health-v3:listings, one hash per <=5-seller batch) is STILL planned.
//   (2) createExport refuses the Health id (long, >=10-char prefix, upper-case) BEFORE authorization or any network
//       call; fetchExportRows / fetchExportRowsStrict refuse BEFORE the export cache / manual continuation marker; the
//       Listings id is NOT refused (it reaches the transport).
//   (3) the source worker records a stale (pre-cutover frozen) Health job TERMINAL HEALTH_SOURCE_RETIRED before any
//       claim / reservation / POST; a createExport refusal classifies terminal + non-transient (never retried).
//   (4) Data Sync Center: PATCH / POST for fba-inventory-health -> typed 409 HEALTH_SOURCE_RETIRED with ZERO writes /
//       runtime / preflight; its card kind is none/source-retired; the FBA operation source is Listings only.
//   (5) onboarding: the fba step binds only the canonical Listings request; a Health key is never a batch member.
//   (6) admin probe + manual refresh: the api/datadoe.js sample probe refuses the Health id BEFORE its direct POST; the
//       route error mapping turns a refused Health fetch into a typed, non-retryable 409.
//   (7) static scan of lib/ api/ src/ scripts/release: the Health source id appears (in CODE) only in the refusal list,
//       the retired registry identity and the (unimported) reports/sources.js identity constant; the retired recovery
//       operator is a zero-I/O stub; the retired overflow / latest-snapshot modules are gone; the runtime never applies
//       the daily stale-day policy to the read-only Health bridge.
// 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import path from "node:path";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = process.env[SB_KEY_ENV] || ["test", "svc", "role", "key"].join("-");
process.env.DATADOE_API_KEY = process.env.DATADOE_API_KEY || "dd_api_test";

// ---- the offline network: COUNT every request and refuse it (a test that expects zero network asserts the count). ----
const net = { calls: [], allowListingsCreate: false };
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  net.calls.push(String((opts && opts.method) || "GET").toUpperCase() + " " + u);
  if (net.allowListingsCreate && /\/exports$/.test(u) && String((opts && opts.method) || "").toUpperCase() === "POST") {
    return { ok: true, status: 200, json: async () => ({ exportId: "exp-listings", status: "COMPLETED" }), text: async () => "" };
  }
  throw new Error("NETWORK_REFUSED_BY_TEST: " + u);
};

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
const HEALTH_ID = "44fc5ba0ce81a7807601f6d7a9b8b7aaec64be4c7e046ea30dc6864d1a4aa823";
const LISTINGS_ID = "ba689c05d7f7cee1a1690990c28995680a0654b7ed258230f4173d61bbcd1ab3";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

const isHealthJob = (s) => !!s && (s.sourceKey === "fba-inventory-health" || s.source_key === "fba-inventory-health"
  || String(s.sourceId || s.source_id || "").toLowerCase() === HEALTH_ID || /:inventory(-health)?$/.test(String(s.requestKey || s.request_key || "")));

let DD, RSC, PLANNER, REG, SC, TRANCHE, FAM, STATUS, SBS, WORKER, DRIVER, ADMIN, OP, BOOT, API, MAT;

/* ============================== (1) planners: zero Health jobs, Listings still planned ============================== */
const CONNS = [{ id: "primary", apiKey: "fixture-key", accountPrefix: "" }];
const REGION_ACCOUNTS = [
  { accountId: "in-1", country: "IN", currency: "INR", name: "IN1" }, { accountId: "in-2", country: "IN", currency: "INR", name: "IN2" },
  { accountId: "de-1", country: "DE", currency: "EUR", name: "DE1" }, { accountId: "uk-1", country: "UK", currency: "GBP", name: "UK1" },
  { accountId: "au-1", country: "AU", currency: "AUD", name: "AU1" },
  { accountId: "us-1", country: "US", currency: "USD", name: "US1" }, { accountId: "us-2", country: "US", currency: "USD", name: "US2" },
  { accountId: "ca-1", country: "CA", currency: "CAD", name: "CA1" },
];
const D1 = "2026-10-07";

test("1a. every scheduled + dedicated report plan, in every region, carries ZERO FBA Inventory Health jobs", () => {
  const keys = [...PLANNER.SHADOW_PLANNED_REPORT_KEYS, "fba-plan", "listing-health-v3"];
  const plan = PLANNER.buildShadowReportPlan({ accounts: REGION_ACCOUNTS, reportKeys: [...new Set(keys)], connections: CONNS, asOfFor: () => D1, inventoryAsOf: D1 });
  const all = [...plan.reportRequests.flatMap((r) => r.sources), ...plan.sourceJobs];
  assert.ok(all.length > 40, "the planners actually ran (" + all.length + " sources)");
  assert.deepEqual(all.filter(isHealthJob).map((s) => s.requestKey), [], "no Health job anywhere");
  const fbaBatched = PLANNER.planFbaPlanBucketBatched({ accounts: REGION_ACCOUNTS, connections: CONNS, asOfFor: () => D1, inventoryAsOf: D1, overflowSellers: new Set(["in-1", "us-1"]) });
  const v3Batched = PLANNER.planListingHealthV3BucketBatched({ accounts: REGION_ACCOUNTS, connections: CONNS, asOfFor: () => D1, inventoryAsOf: D1, overflowSellers: new Set(["in-1"]) });
  const staged = PLANNER.planSalesMovers({ ...REGION_ACCOUNTS[5], connections: CONNS, asOf: D1, probeSignal: { status: "success", validated: true, latestReportedDate: "2026-10-05" } });
  const single = PLANNER.planFbaPlan({ accountId: "us-1", name: "US1", country: "US", currency: "USD", connections: CONNS, asOf: D1 });
  for (const [label, srcs] of [["fba batched", fbaBatched.flatMap((r) => r.sources)], ["v3 batched", v3Batched.flatMap((r) => r.sources)], ["sales-movers staged", staged.sources], ["fba single", single.sources]]) {
    assert.ok(srcs.length > 0, label + ": planned");
    assert.equal(srcs.filter(isHealthJob).length, 0, label + ": zero Health jobs");
  }
});

test("1b. the canonical Listings export is STILL planned: ONE shared hash per <=5-seller batch for fba-plan:awd and listing-health-v3:listings (LHv3 derives from Listings)", () => {
  const fba = PLANNER.planFbaPlanBucketBatched({ accounts: REGION_ACCOUNTS, connections: CONNS, asOfFor: () => D1, inventoryAsOf: D1 });
  const v3 = PLANNER.planListingHealthV3BucketBatched({ accounts: REGION_ACCOUNTS, connections: CONNS, asOfFor: () => D1, inventoryAsOf: D1 });
  const hashes = (plan, key) => new Set(plan.flatMap((r) => r.sources.filter((x) => x.requestKey === key).map((x) => x.requestHash)));
  const fbaL = hashes(fba, "fba-plan:awd");
  const v3L = hashes(v3, "listing-health-v3:listings");
  assert.ok(fbaL.size >= 3, "Listings batches planned for every region (" + fbaL.size + ")");
  assert.deepEqual([...v3L].sort(), [...fbaL].sort(), "fba-plan:awd and listing-health-v3:listings share the SAME Listings hashes");
  assert.ok(fba.every((r) => r.sources.every((x) => x.sourceKey === "listings" && x.sourceId === LISTINGS_ID)), "the fba-plan owned export is the canonical Listings source");
  assert.ok(v3.every((r) => r.sources.every((x) => x.requestKey === "listing-health-v3:listings" || x.requestKey === "listing-health-v3:listings-raw")), "v3 keeps listings + listings-raw only");
  assert.deepEqual([...MAT.LISTING_HEALTH_V3_READ_KEYS], ["listing-health-v3:listings", "listing-health-v3:listings-raw"], "v3 per-account read identities resolve without any inventory key");
  assert.equal(DD.isRetiredDataDoeSourceId(LISTINGS_ID), false, "the Listings source is NOT retired");
});

test("1c. no report contract / registry record / tranche / scheduled family / readiness source names FBA Inventory Health; resolving a retired contract fails closed", () => {
  for (const [rk, cs] of Object.entries(RSC.REPORT_SOURCE_CONTRACTS)) {
    for (const c of cs) assert.ok(!isHealthJob(c), rk + ":" + c.requestKey + " is not a Health contract");
  }
  assert.ok(!RSC.SELLER_SCOPED_REQUEST_KEYS.some((k) => /inventory/.test(k)), "no Health request key is seller-scoped/batchable");
  assert.ok(RSC.RETIRED_FBA_HEALTH_REQUEST.retired === true && Object.isFrozen(RSC.RETIRED_FBA_HEALTH_REQUEST), "the Health recipe survives ONLY as a frozen retired identity");
  assert.throws(() => REG.sourceRegistryEntry("fba-inventory-health"), /UNREGISTERED_SOURCE/, "no registry record (no card, no price)");
  assert.ok(!TRANCHE.SOURCE_TRANCHE_ORDER.some((t) => t.sourceKeys.includes("fba-inventory-health")), "in no tranche");
  assert.ok(!FAM.SCHEDULED_FAMILY_REGISTRY["fba-inventory-health"] && FAM.RETIRED_FAMILIES.includes("fba-inventory-health"), "not a scheduled family (and declared retired)");
  assert.equal(FAM.validateScheduledFamilyRegistry().ok, true, "the family guard passes");
  assert.ok(!JSON.stringify(STATUS.PRIORITY_DASHBOARD_SOURCES).includes("inventory-health"), "no dashboard readiness source names Health");
  assert.equal(SC.isRetiredSourceKey("fba-inventory-health"), true);
  assert.equal(SC.isRetiredSourceKey("listings"), false);
  assert.ok(!Object.values(SC.REPORT_SOURCE_REQUIREMENTS).flat().includes("fba-inventory-health"), "no report requires a fetched Health source");
  // Fail closed: a (hypothetical) contract naming the retired source is refused before any request identity is built.
  assert.throws(() => REG.assertSourceRegistryConsistency({ reportContracts: { ...RSC.REPORT_SOURCE_CONTRACTS, "fba-plan": [...RSC.REPORT_SOURCE_CONTRACTS["fba-plan"], { ...RSC.RETIRED_FBA_HEALTH_REQUEST }] } }), /fba-inventory-health/);
});

test("1d. every bucket source sync (legacy + regional buckets), nothing paused, plans ZERO Health jobs", () => {
  for (const bucket of ["us", "non-us", "india", "europe-au", "us-ca"]) {
    const accounts = Array.from({ length: 6 }, (_, i) => ({ accountId: bucket + "-A" + i, rawSellerId: bucket + "-S" + i, country: bucket === "india" ? "IN" : (bucket === "us" || bucket === "us-ca" ? "US" : "DE"), currency: "USD" }));
    const coverageByAccountId = Object.fromEntries(accounts.map((a) => [a.accountId, []]));
    const plan = SBS.planBucketSourceSync({ apiKey: "prim-key", bucket, accounts, existingMembership: new Map(), coverageByAccountId, catalogSnapshot: null, fbaSnapshotsByAccount: {}, pausedSources: new Set(), asOf: "2026-08-19", today: "2026-08-20", catalogCarrierSeller: accounts[0].rawSellerId });
    assert.equal(plan.summary.plannedJobsByFamily["fba-inventory-health"] || 0, 0, bucket + ": zero Health jobs");
    assert.ok(!plan.families.some((f) => f.sourceKey === "fba-inventory-health"), bucket + ": no Health family");
    assert.ok(plan.families.flatMap((f) => f.plannedJobs).every((j) => !isHealthJob(j)), bucket + ": no Health job identity");
  }
});

/* ============================== (2) createExport + transport refusal ============================== */
test("2a. createExport refuses the Health id (long, 10-char prefix, upper-case) BEFORE authorization or ANY network call; a short <10 prefix is not a match", async () => {
  assert.equal(DD.isRetiredDataDoeSourceId(HEALTH_ID), true);
  assert.equal(DD.isRetiredDataDoeSourceId("44fc5ba0ce"), true);
  assert.equal(DD.isRetiredDataDoeSourceId("44FC5BA0CE81A7"), true);
  assert.equal(DD.isRetiredDataDoeSourceId("44fc5"), false, "too short to identify a source");
  assert.equal(DD.isRetiredDataDoeSourceId(""), false);
  const before = net.calls.length;
  for (const id of [HEALTH_ID, "44fc5ba0ce", "44FC5BA0CE"]) {
    // (Scheduler line: there is no paid-export authorization wrapper; the RETIRED refusal is the first statement.)
    await assert.rejects(() => DD.createExport("k", id, ["sku"], ["S1"], "2026-10-06", "2026-10-06", 50000), (e) => e.code === DD.RETIRED_SOURCE_ERROR_CODE && e.retryable === false && e.status === 409 && /retired/i.test(e.message));
  }
  assert.equal(net.calls.length, before, "ZERO network calls");
});

test("2b. fetchExportRows / fetchExportRowsStrict refuse the Health id BEFORE the export cache, the continuation marker or any network call", async () => {
  const before = net.calls.length;
  await assert.rejects(() => DD.fetchExportRows("k", HEALTH_ID, ["sku"], ["S1", "S2"], "2026-10-06", "2026-10-06", 15000), (e) => DD.isRetiredSourceError(e));
  await assert.rejects(() => DD.fetchExportRowsStrict("k", HEALTH_ID, ["sku"], ["S1"], "2026-10-06", "2026-10-06", 15000, { orderByColumn: "date", orderByDirection: "DESC" }, "FBA inventory snapshot export"), (e) => DD.isRetiredSourceError(e));
  assert.equal(net.calls.length, before, "ZERO network calls (no cache read, no marker write, no create)");
});

test("2c. the Listings export is NOT refused: createExport for the Listings id reaches the transport", async () => {
  const before = net.calls.length;
  net.allowListingsCreate = true;
  try {
    const created = await DD.createExport("k", LISTINGS_ID, ["sku"], ["S1"], null, null, 50000, { orderByColumn: "child_asin" });
    assert.equal(created.exportId, "exp-listings");
  } finally { net.allowListingsCreate = false; }
  assert.equal(net.calls.length, before + 1, "exactly one create POST for Listings");
});

/* ============================== (3) source worker ============================== */
function makeStore() {
  const cycles = new Map(); const jobsByCycle = new Map(); let seq = 0;
  const calls = { claim: 0, reserve: 0 };
  const findCycle = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  return {
    calls,
    _rawJob(cycleId, hash) { return jobsByCycle.get(cycleId) && jobsByCycle.get(cycleId).get(hash); },
    openCycle({ bucket, cycleDate }) {
      const key = bucket + "|" + cycleDate;
      if (!cycles.has(key)) { const id = "cyc_" + (seq += 1); cycles.set(key, { id, bucket, cycle_date: cycleDate, status: "pending" }); jobsByCycle.set(id, new Map()); }
      return cycles.get(key).id;
    },
    claimCycle(id) { const c = findCycle(id); if (c && c.status === "pending") { c.status = "running"; return true; } return false; },
    getCycle(id) { return findCycle(id); },
    upsertSourceJob(job) {
      const m = jobsByCycle.get(job.cycleId); if (m.has(job.requestHash)) return;
      m.set(job.requestHash, { request_hash: job.requestHash, request_key: job.requestKey, source_id: job.sourceId, source_key: job.sourceKey, connection_id: job.connectionId, fetch_status: "pending", attempted_at: null, create_export_count: 0, export_id: null, terminal: false, error_stage: null, error_code: null, error_message: null, row_count: null, cache_object_path: null });
    },
    listSourceJobs(id) { return [...((jobsByCycle.get(id) && jobsByCycle.get(id).values()) || [])].map((j) => ({ ...j })); },
    claimExportAttempt(id, hash) { calls.claim += 1; const j = jobsByCycle.get(id).get(hash); if (j && j.attempted_at === null) { j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted"; return true; } return false; },
    reserveExportCreate() { calls.reserve += 1; return "reserved"; },
    recordExportCreated({ cycleId, requestHash, exportId }) { jobsByCycle.get(cycleId).get(requestHash).export_id = exportId; },
    loadSourceRows() { return null; },
    saveSourceRows() { return "source-cache/v2/x.json"; },
    recordSourceSuccess({ cycleId, requestHash }) { jobsByCycle.get(cycleId).get(requestHash).fetch_status = "succeeded"; },
    recordSourceFailure({ cycleId, requestHash, stage, code, message, terminal }) { Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "failed", error_stage: stage, error_code: code, error_message: message, terminal: !!terminal }); },
    updateCycleCounts() {},
  };
}

test("3a. a stale (pre-cutover frozen) Health job is recorded TERMINAL HEALTH_SOURCE_RETIRED before any claim / reservation / create POST, and is never re-attempted", async () => {
  const ident = SBS.resolvedFbaSnapshot({ apiKey: "fixture-key", account: { rawSellerId: "S1", country: "US" }, asOf: "2026-08-19", bucket: "us" });
  assert.ok(ident.retired === true && ident.readOnly === true, "the Health identity is a READ-ONLY retired identity (bridge verification only)");
  const job = DRIVER.plannedSourceJob("fba-plan", ident, "us", "primary", "acct-S1", "S1", "US");
  const store = makeStore();
  let creates = 0;
  const dataDoe = { async create() { creates += 1; return { exportId: "x" }; }, async poll() {}, async download() { return []; } };
  const res = await WORKER.runSourceJobs({ bucket: "us", cycleDate: "2026-08-20", store, dataDoe, plannedJobs: [job] });
  const row = store._rawJob(res.cycleId, job.requestHash);
  assert.equal(row.error_code, "HEALTH_SOURCE_RETIRED");
  assert.equal(row.terminal, true, "terminal (never retried)");
  assert.equal(creates, 0, "ZERO create POSTs");
  assert.equal(store.calls.claim + store.calls.reserve, 0, "no claim and no token reservation");
  await WORKER.runSourceJobs({ bucket: "us", cycleDate: "2026-08-20", store, dataDoe, plannedJobs: [job] });
  assert.equal(creates, 0, "a repeated worker run never re-attempts it");
});

test("3b. a createExport refusal classifies TERMINAL + non-transient (no EXPORT_ERROR retry loop)", async () => {
  let err = null;
  try { await DD.createExport("k", HEALTH_ID, ["sku"], ["S1"], null, null, 1); } catch (e) { err = e; }
  const cls = WORKER.classifyFetchError(err, "create-export");
  assert.deepEqual([cls.code, cls.terminal, cls.transient], ["HEALTH_SOURCE_RETIRED", true, false]);
});

/* ============================== (4) Data Sync Center ============================== */
function fakeRes() { return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; }
function adminDeps() {
  const calls = { writes: 0, runtime: 0, reads: 0 };
  const count = (k) => async () => { calls[k] += 1; return { rows: [], read: "ok" }; };
  const deps = {
    getDashboardAccess: async () => ({ userId: "admin-health-test" }), assertAdmin: () => {},
    isAdsRegistryKeyRetired: () => false,
    insertAuditLog: count("writes"), setSourceControl: count("writes"),
    getSourceControls: count("reads"), getSourceRunStatuses: count("reads"), getAccountDirectoryRows: async () => { calls.reads += 1; return []; },
    getAccountOliQualityCounts: async () => ({}), primaryOrganizationFingerprint: () => "org-fp",
    buildBucketSourceSyncRuntime: () => { calls.runtime += 1; throw new Error("runtime must never be built for a retired source"); },
    now: () => Date.UTC(2026, 9, 8, 3, 0),
    getDataDoeConnections: () => [{ id: "primary", apiKey: "b-key", accountPrefix: "", organizationFingerprint: "org-fp" }],
  };
  return { deps, calls };
}

test("4a. PATCH + POST (preview or execute) for fba-inventory-health -> typed 409 HEALTH_SOURCE_RETIRED, ZERO writes / runtime / reads; the card is not paid-syncable", async () => {
  for (const req of [
    { method: "PATCH", body: { sourceKey: "fba-inventory-health", paused: false } },
    { method: "POST", body: { bucket: "us", sourceKey: "fba-inventory-health", preview: true } },
    { method: "POST", body: { bucket: "non-us", sourceKey: "fba-inventory-health" } },
  ]) {
    const { deps, calls } = adminDeps();
    const res = fakeRes();
    await ADMIN.handler(req, res, deps);
    assert.equal(res.statusCode, 409, req.method + " " + JSON.stringify(res.body));
    assert.equal(res.body.code, "HEALTH_SOURCE_RETIRED");
    assert.equal(res.body.retryable, false);
    assert.match(String(res.body.message), /retired/i, "user-readable message");
    assert.deepEqual(calls, { writes: 0, runtime: 0, reads: 0 }, "zero writes / runtime / reads");
  }
  assert.deepEqual([...OP.FBA_OPERATION_SOURCE_KEYS], ["listings"], "the FBA operation (DSC card) source is Listings only");
  assert.equal(OP.isFbaOperationSource("fba-inventory-health"), false);
});

/* ============================== (5) onboarding ============================== */
test("5a. the onboarding fba step binds ONLY the canonical Listings request; a Health key is never a batch member", () => {
  assert.deepEqual([...BOOT.FBA_STEP_SOURCE_KEYS], ["listings"]);
  assert.ok(!JSON.stringify(BOOT.fbaStepWindows()).includes("inventory-health"), "no Health window");
  const bucketAccounts = OP.fbaBucketAccounts(REGION_ACCOUNTS, "india");
  const plan = OP.buildFbaBucketPlan({ bucketAccounts, connections: CONNS, asOf: D1, inventoryAsOf: D1 });
  assert.ok(plan.reportRequests.length > 0 && !JSON.stringify(plan).includes("inventory-health"), "the onboarding FBA plan has no Health request");
  const st = BOOT.fbaPlanStructure(plan, D1);
  assert.deepEqual(st.sourceKeys, ["fba-plan:awd"]);
  assert.equal(st.adaptiveSplitAllowed, false);
  const mixed = { reportRequests: [{ sources: [{ requestKey: "fba-plan:inventory-health", sellerOrVendorIds: ["s9"] }, { requestKey: "fba-plan:awd", sellerOrVendorIds: ["s2", "s1"] }] }] };
  assert.deepEqual(BOOT.fbaSellerBatches(mixed), [["s1", "s2"]], "a stale Health key is never a batch");
});

/* ============================== (6) admin probe + manual refresh ============================== */
test("6a. the api/datadoe.js sample probe refuses the Health id BEFORE its direct export POST (typed 409)", () => {
  const src = read("api/datadoe.js");
  const start = src.indexOf('if (action === "sample") {');
  assert.ok(start > 0);
  const block = src.slice(start, src.indexOf("res.status(400).json({ error: \"Unknown action.", start));
  const guard = block.indexOf("isRetiredDataDoeSourceId(sourceId)");
  const post = block.indexOf("ddFetch(ENDPOINTS.exportsCreate");
  assert.ok(guard > 0 && post > 0 && guard < post, "the retired-source guard precedes the direct POST");
  assert.ok(/res\.status\(409\)\.json\(\{ error: RETIRED_SOURCE_ERROR_CODE, code: RETIRED_SOURCE_ERROR_CODE/.test(block.slice(guard, post)), "a typed 409");
});

test("6b. a manual refresh whose builder still asks for Health gets a typed, user-readable, NON-retryable 409 (never a 500 / spinner)", async () => {
  let err = null;
  try { await DD.fetchExportRowsStrict("k", HEALTH_ID, ["sku"], ["S1"], "2026-10-06", "2026-10-06", 15000, {}, "FBA inventory snapshot export"); } catch (e) { err = e; }
  const mapped = API.classifyDataDoeRouteError(err);
  assert.equal(mapped.status, 409);
  assert.deepEqual([mapped.body.code, mapped.body.retryable], ["HEALTH_SOURCE_RETIRED", false]);
  assert.match(mapped.body.error, /retired/i);
  assert.equal(API.classifyDataDoeRouteError(new Error("ordinary failure")), null, "other errors keep their handling");
});

/* ============================== (7) static scan ============================== */
test("7a. the Health source id appears in CODE only in the refusal list, the retired registry identity and the unimported reports/sources.js constant; nothing imports FBA_INVENTORY_HEALTH", () => {
  const idHits = []; const constHits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(m?js|jsx|cjs)$/.test(name)) continue;
      const rel = path.relative(ROOT, p).replace(/\\/g, "/");
      const code = readFileSync(p, "utf8").split("\n").filter((l) => { const t = l.trim(); return !t.startsWith("//") && !t.startsWith("*"); });
      if (code.some((l) => l.toLowerCase().includes("44fc5ba0"))) idHits.push(rel);
      if (rel !== "lib/server/reports/sources.js" && code.some((l) => /\bFBA_INVENTORY_HEALTH\b/.test(l))) constHits.push(rel);
    }
  };
  for (const d of ["lib", "api", "src", "scripts/release"]) walk(path.join(ROOT, d));
  assert.deepEqual(idHits.sort(), ["lib/server/datadoe.js", "lib/server/reports/sources.js", "lib/server/source-contracts.js"], "unexpected Health id references: " + idHits.join(", "));
  assert.deepEqual(constHits, [], "FBA_INVENTORY_HEALTH is imported/used by: " + constHits.join(", "));
});

test("7b. the retired recovery operator is a zero-I/O stub (exit 2, typed); the overflow / latest-snapshot modules are gone; the runtime never applies stale-day to the read-only Health bridge", () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/release/fba-inventory-recovery.mjs"), "--region=india", "--mode=recover"], { encoding: "utf8", env: { PATH: process.env.PATH || "" }, timeout: 20000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /HEALTH_SOURCE_RETIRED/);
  assert.ok(!/import\b/.test(read("scripts/release/fba-inventory-recovery.mjs").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")), "the stub imports nothing");
  for (const f of ["lib/server/sync/fba-inventory-overflow.js", "lib/server/sync/fba-inventory-latest-snapshot.js"]) assert.equal(existsSync(path.join(ROOT, f)), false, f + " removed");
  assert.match(read("lib/server/sync/source-bucket-sync-runtime.js"), /if \(today && sourceKey !== FBA_INVENTORY_SOURCE_KEY\)/, "the saved Health bridge is exempt from the daily stale-day (sales-blocking) policy");
});

async function main() {
  out("health-source-retired");
  DD = await import("../lib/server/datadoe.js");
  RSC = await import("../lib/server/sync/report-source-contracts.js");
  PLANNER = await import("../lib/server/sync/report-planner.js");
  REG = await import("../lib/server/sync/source-registry.js");
  SC = await import("../lib/server/source-contracts.js");
  TRANCHE = await import("../lib/server/sync/source-tranche.js");
  FAM = await import("../lib/server/sync/scheduled-family-registry.js");
  STATUS = await import("../lib/server/sync/source-status.js");
  SBS = await import("../lib/server/sync/source-bucket-sync.js");
  WORKER = await import("../lib/server/sync/source-worker.js");
  DRIVER = await import("../lib/server/sync/source-sync-driver.js");
  ADMIN = await import("../api/admin/sources.js");
  OP = await import("../lib/server/sync/fba-plan-operation.js");
  BOOT = await import("../lib/server/sync/account-onboarding-bootstrap.js");
  API = await import("../api/datadoe.js");
  MAT = await import("../lib/server/sync/listing-health-v3-materialize.js");
  let failures = 0;
  for (const t of tests) {
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (e) { failures += 1; out("FAIL  " + t.name + "\n" + (e && e.stack ? e.stack : e)); }
  }
  out(`\nhealth-source-retired: ${passed} passed${failures ? ", " + failures + " FAILED" : ""}`);
  if (failures) process.exitCode = 1;
}
main();
