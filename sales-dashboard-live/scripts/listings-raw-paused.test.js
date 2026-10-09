// Listings (Raw JSON) PAUSE -- "no path plans, budgets or creates a Raw export; Listing Health stays truthful".
//
// The code-level pause (lib/server/source-pause.js, owner request 2026-10-09) pauses the DataDoe source "listings-raw"
// (6ea445cd...). The canonical Listings export (ba689c05..., fba-plan:awd == listing-health-v3:listings) is UNCHANGED.
// Offline: global fetch is a fake DataDoe that COUNTS every request (a Raw create is a test failure), zero database,
// zero DataDoe, zero tokens. Supabase is deliberately NOT configured here (the legacy single-invocation export flow).
//   (0) the switch: exact / >=10-char prefix / upper-case Raw id + key match; the Listings id and EVERY other registered
//       source id do not; the typed code LISTINGS_RAW_PAUSED is distinct from the DB operator pause SOURCE_PAUSED.
//   (1) export boundary: createExport refuses the Raw id with ZERO network even inside an AUTHORIZED paid request; the
//       Listings id reaches the transport; fetchExportRows still returns already-saved Raw rows (no create) and refuses
//       only a cache miss -- before the in-flight share / continuation marker / create.
//   (2) planners, india / europe-au / us-ca: every scheduled + dedicated (LHv3) + v1 + shadow plan carries ZERO Raw
//       jobs; the LHv3 dedicated plan's Listings batches == fba-plan:awd (same hashes, <=5 sellers, 18 columns incl.
//       fba_quantity_inbound/_reserved/_fc_transfer, 50,000 cap); the FBA Plan plan is byte-identical to the unpaused one.
//   (3) budgets: LHv3 cost / frozen tranche = Listings only (1 premium create per batch); the UNCHANGED stored
//       authorization stays valid (plan cost only went down) and binds; the DSC card is none/source-paused.
//   (4) worker: a leftover (pre-pause frozen) Raw job is recorded TERMINAL LISTINGS_RAW_PAUSED before any claim /
//       reservation / POST (with and without a frozen budget); the refusal classifies terminal + non-transient.
//   (5) admin: DSC PATCH/POST for listings-raw -> typed 409 with zero writes / runtime / reads; the sample probe refuses
//       the Raw id before its direct POST; the route error mapping is a typed non-retryable 409; onboarding binds
//       Listings only; the recovery Listings route / LHv3 reconciler are zero-export.
//   (6) v1 manual refresh: buildListingHealth runs Listings + Sales + Catalog over the fake DataDoe and NEVER fetches
//       Raw; issues unavailable with the paused reason.
//   (7) LHv3 truthfulness: the derive ignores even a validated Raw fragment (issues unavailable + paused reason + code,
//       rawFetchedAt null, Listings-only flags kept); the view's As-of never uses a Raw fetch time, Priority Actions
//       never says "none"/"No action needed"; the Priority Feed keeps Listings alerts and names the pause.
//   (8) static scan: the Raw id appears (in CODE) only in the registry / contract / pause files.
// 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

delete process.env.SUPABASE_URL; // the legacy (no durable store) export flow: no persisted cache, no continuation marker
process.env.DATADOE_API_KEY = process.env.DATADOE_API_KEY || "dd_api_test";

const RAW_ID = "6ea445cdc459f9fbb9517c5c009384da60ef31a1e70d4de9187ea3d4c28535c4";
const LISTINGS_ID = "ba689c05d7f7cee1a1690990c28995680a0654b7ed258230f4173d61bbcd1ab3";

// ---- the fake DataDoe network: COUNTS every request; a POST /exports answers COMPLETED and the download returns the
// rows registered for that source id. Anything else is refused. `net.creates` records every create's sourceId. ----
const net = { calls: [], creates: [], rowsBySource: new Map(), seq: 0, exports: new Map() };
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = String((opts && opts.method) || "GET").toUpperCase();
  net.calls.push(method + " " + u);
  if (method === "POST" && /\/exports$/.test(u)) {
    const body = JSON.parse(String(opts.body || "{}"));
    net.creates.push(String(body.sourceId));
    const id = "exp-" + (net.seq += 1);
    net.exports.set(id, String(body.sourceId));
    return { ok: true, status: 200, json: async () => ({ exportId: id, status: "COMPLETED" }), text: async () => "" };
  }
  const m = u.match(/\/exports\/([^/]+)\/raw$/);
  if (method === "GET" && m && net.exports.has(m[1])) {
    const rows = net.rowsBySource.get(net.exports.get(m[1])) || [];
    return { ok: true, status: 200, json: async () => rows.map((r) => ({ ...r })), text: async () => "" };
  }
  throw new Error("NETWORK_REFUSED_BY_TEST: " + u);
};

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const isRawJob = (s) => !!s && (s.sourceKey === "listings-raw" || s.source_key === "listings-raw"
  || String(s.sourceId || s.source_id || "").toLowerCase() === RAW_ID || /:listings-raw$/.test(String(s.requestKey || s.request_key || "")));

let SP, DD, SC, RSC, PLANNER, OP, COMP, AUTH, MAT, WORKER, DRIVER, ADMIN, API, BOOT, DERIV, LHB, VIEW, INS;

const CONNS = [{ id: "primary", apiKey: "fixture-key", accountPrefix: "" }];
const D1 = "2026-10-08";
const acct = (id, country, currency) => ({ accountId: id, country, currency, name: id.toUpperCase() });
const REGIONS = {
  india: ["in-1", "in-2", "in-3", "in-4", "in-5", "in-6", "in-7"].map((id) => acct(id, "IN", "INR")), // 7 -> 2 batches
  "europe-au": [["uk-1", "UK"], ["uk-2", "UK"], ["de-1", "DE"], ["de-2", "DE"], ["fr-1", "FR"], ["it-1", "IT"], ["es-1", "ES"], ["nl-1", "NL"], ["be-1", "BE"], ["pl-1", "PL"], ["au-1", "AU"], ["au-2", "AU"]]
    .map(([id, c]) => acct(id, c, c === "AU" ? "AUD" : c === "UK" ? "GBP" : c === "PL" ? "PLN" : "EUR")), // 12 -> 3 batches
  "us-ca": [["us-1", "US"], ["us-2", "US"], ["us-3", "US"], ["us-4", "US"], ["us-5", "US"], ["us-6", "US"], ["ca-1", "CA"], ["ca-2", "CA"]].map(([id, c]) => acct(id, c, c === "CA" ? "CAD" : "USD")), // 8 -> 2
};
const ALL_ACCOUNTS = Object.values(REGIONS).flat();
let seamRawCreates = 0; // Raw creates made ONLY inside the explicit unpaused (pre-pause) seam of 1c
// Run inside an AUTHORIZED paid-export request where the line has the paid-export authorization backstop (web); the
// scheduler line has no such backstop, so the callback runs directly (the pause refusal is independent of it).
const authorizedPaidRequest = (fn) => (typeof DD.withPaidExportAuthorization === "function"
  ? DD.withPaidExportAuthorization(async () => { DD.allowPaidExportsForThisRequest(true); return fn(); })
  : fn());
const unpaused = (fn) => { SP.__setSourcePauseForTests({}); try { return fn(); } finally { SP.__resetSourcePauseForTests(); } };

/* ============================== (0) the switch ============================== */
test("0a. the switch pauses exactly listings-raw (key + id: long / 10-char prefix / upper-case / padded); a <10-char prefix, the Listings id and EVERY other registered source id are NOT paused", () => {
  assert.deepEqual([...SP.PAUSED_SOURCE_KEYS], ["listings-raw"]);
  assert.deepEqual([...SP.PAUSED_DATADOE_SOURCE_IDS], [RAW_ID]);
  assert.equal(SC.sourceContractForKey("listings-raw").ids[0], RAW_ID, "the paused id IS the registered Listings (Raw JSON) id");
  for (const id of [RAW_ID, RAW_ID.slice(0, 10), RAW_ID.toUpperCase(), "  " + RAW_ID + "  "]) assert.equal(SP.isPausedDataDoeSourceId(id), true, id);
  for (const id of [RAW_ID.slice(0, 9), "", null, undefined, LISTINGS_ID, LISTINGS_ID.slice(0, 10)]) assert.equal(SP.isPausedDataDoeSourceId(id), false, String(id));
  for (const c of SC.SOURCE_CONTRACTS) {
    for (const id of c.ids) assert.equal(SP.isPausedDataDoeSourceId(id), c.key === "listings-raw", c.key + " " + id);
    assert.equal(SP.isPausedSourceKey(c.key), c.key === "listings-raw", c.key);
  }
  assert.equal(SP.isListingsRawPaused(), true);
  assert.equal(SP.SOURCE_CODE_PAUSED_ERROR_CODE, "LISTINGS_RAW_PAUSED");
  assert.notEqual(SP.SOURCE_CODE_PAUSED_ERROR_CODE, "SOURCE_PAUSED", "distinct from the retryable DB operator pause");
  assert.throws(() => SP.assertSourceNotPaused(RAW_ID), (e) => e.code === "LISTINGS_RAW_PAUSED" && e.status === 409 && e.retryable === false && /paused/i.test(e.message));
  SP.assertSourceNotPaused(LISTINGS_ID); // no throw
  assert.equal(RSC.isPausedRequestKey("listing-health-v3:listings-raw"), true);
  assert.equal(RSC.isPausedRequestKey("listing-health:listings-raw"), true);
  assert.equal(RSC.isPausedRequestKey("listing-health-v3:listings"), false);
  assert.equal(RSC.isPausedRequestKey("fba-plan:awd"), false);
  // Rollback = empty the lists: nothing is paused.
  unpaused(() => { assert.equal(SP.isPausedDataDoeSourceId(RAW_ID), false); assert.equal(SP.isListingsRawPaused(), false); });
  assert.equal(SP.isListingsRawPaused(), true, "the seam restores the production pause");
});

/* ============================== (1) export boundary ============================== */
test("1a. createExport refuses the Raw id (long / 10-char prefix / upper-case) with ZERO network -- even inside an AUTHORIZED paid request", async () => {
  const before = net.calls.length;
  for (const id of [RAW_ID, RAW_ID.slice(0, 10), RAW_ID.toUpperCase()]) {
    await authorizedPaidRequest(async () => {
      await assert.rejects(() => DD.createExport("k", id, ["sku"], ["S1"], null, null, 50000, { orderByColumn: "child_asin" }), (e) => SP.isPausedSourceError(e) && e.retryable === false && e.status === 409);
    });
  }
  assert.equal(net.calls.length, before, "ZERO network calls");
  assert.equal(net.creates.filter((s) => s === RAW_ID).length, 0);
});

test("1b. the Listings export is NOT refused: createExport for the Listings id reaches the transport (exactly one POST)", async () => {
  const before = net.calls.length;
  const created = await DD.createExport("k", LISTINGS_ID, ["sku"], ["S1"], null, null, 50000, { orderByColumn: "child_asin" });
  assert.ok(String(created.exportId).startsWith("exp-"));
  assert.equal(net.calls.length, before + 1);
  assert.equal(net.creates[net.creates.length - 1], LISTINGS_ID);
});

test("1c. fetchExportRows: ALREADY-SAVED Raw rows stay readable (cache hit, zero network); a cache MISS is refused typed with zero network (no in-flight share / marker / create)", async () => {
  net.rowsBySource.set(RAW_ID, [{ sku: "A", child_asin: "ASIN-A", issues: "[]" }]);
  // Save the rows the way a pre-pause run did (seam = unpaused), then re-apply the pause.
  const rawBefore = net.creates.filter((x) => x === RAW_ID).length;
  const saved = await (async () => { SP.__setSourcePauseForTests({}); try { return await DD.fetchExportRows("k", RAW_ID, ["sku", "child_asin", "issues"], ["S1"], null, null, 50000, { orderByColumn: "child_asin" }); } finally { SP.__resetSourcePauseForTests(); } })();
  assert.equal(saved.length, 1);
  seamRawCreates += net.creates.filter((x) => x === RAW_ID).length - rawBefore;
  const before = net.calls.length;
  const again = await DD.fetchExportRows("k", RAW_ID, ["sku", "child_asin", "issues"], ["S1"], null, null, 50000, { orderByColumn: "child_asin" });
  assert.deepEqual(again, saved, "the saved Raw rows are still readable while paused");
  assert.equal(net.calls.length, before, "a cache hit makes ZERO network calls (no create)");
  await assert.rejects(() => DD.fetchExportRows("k", RAW_ID, ["sku", "child_asin", "issues"], ["S2"], null, null, 50000, { orderByColumn: "child_asin" }), (e) => SP.isPausedSourceError(e));
  await assert.rejects(() => DD.fetchExportRowsStrict("k", RAW_ID, ["sku"], ["S3"], null, null, 50000, {}, "Raw"), (e) => SP.isPausedSourceError(e));
  assert.equal(net.calls.length, before, "a paused cache miss is refused with ZERO network calls");
});

/* ============================== (2) planners ============================== */
test("2a. india / europe-au / us-ca: every scheduled + dedicated (LHv3) shadow plan carries ZERO Raw jobs; the same plan unpaused DID carry Raw (the pause is what removed it)", () => {
  const keys = [...new Set([...PLANNER.SHADOW_PLANNED_REPORT_KEYS, ...PLANNER.DEDICATED_BATCHED_SHADOW_REPORT_KEYS])];
  for (const [region, accounts] of Object.entries(REGIONS)) {
    const plan = PLANNER.buildShadowReportPlan({ accounts, reportKeys: keys, connections: CONNS, asOfFor: () => D1, inventoryAsOf: D1 });
    const all = [...plan.reportRequests.flatMap((r) => r.sources), ...plan.sourceJobs];
    assert.ok(all.length > 20, region + ": the planners ran (" + all.length + ")");
    assert.deepEqual(all.filter(isRawJob).map((s) => s.requestKey), [], region + ": zero Raw jobs");
    assert.ok(plan.reportRequests.some((r) => r.reportKey === "listing-health") && plan.reportRequests.some((r) => r.reportKey === "listing-health-v3"), region + ": v1 + v3 still planned");
    const before = unpaused(() => PLANNER.buildShadowReportPlan({ accounts, reportKeys: keys, connections: CONNS, asOfFor: () => D1, inventoryAsOf: D1 }));
    assert.ok(before.sourceJobs.some(isRawJob), region + ": the unpaused plan carried Raw");
    // Removing Raw removes ONLY Raw: every other planned job is byte-identical.
    const strip = (p) => JSON.stringify(p.sourceJobs.filter((j) => !isRawJob(j)).map((j) => j.requestHash).sort());
    assert.equal(strip(plan), strip(before), region + ": every non-Raw job is unchanged");
  }
});

test("2b. the v1 listing-health planner: ZERO Raw jobs; Listings / Sales / Catalog unchanged", () => {
  for (const a of [REGIONS.india[0], REGIONS["europe-au"][0], REGIONS["us-ca"][0]]) {
    const p = PLANNER.planListingHealth({ ...a, connections: CONNS, asOf: D1 });
    assert.deepEqual(p.sources.map((s) => s.requestKey).sort(), ["listing-health:catalog", "listing-health:listings", "listing-health:sales"]);
    const u = unpaused(() => PLANNER.planListingHealth({ ...a, connections: CONNS, asOf: D1 }));
    assert.deepEqual(p.sources.map((s) => s.requestHash).sort(), u.sources.filter((s) => !isRawJob(s)).map((s) => s.requestHash).sort());
  }
});

test("2c. the LHv3 DEDICATED plan per region keeps EXACTLY the canonical Listings batches: same hashes as fba-plan:awd, <=5 sellers, 18 columns (incl. fba_quantity_inbound/_reserved/_fc_transfer), 50,000 cap; the FBA Plan plan is byte-identical to the unpaused one", () => {
  const listingsContract = RSC.REPORT_SOURCE_CONTRACTS["listing-health-v3"].find((c) => c.requestKey === "listing-health-v3:listings");
  const awdContract = RSC.REPORT_SOURCE_CONTRACTS["fba-plan"].find((c) => c.requestKey === "fba-plan:awd");
  assert.equal(listingsContract.columns.length, 18);
  for (const col of ["fba_quantity_inbound", "fba_quantity_reserved", "fba_quantity_fc_transfer"]) assert.ok(listingsContract.columns.includes(col), col);
  assert.deepEqual(listingsContract.columns, awdContract.columns);
  assert.equal(listingsContract.limit, 50000);
  for (const [region, accounts] of Object.entries(REGIONS)) {
    const v3 = OP.buildListingHealthV3Plan({ accounts, connections: CONNS, cycleDate: D1 }).reportRequests.filter((r) => r.reportKey === "listing-health-v3");
    const fba = PLANNER.planFbaPlanBucketBatched({ accounts, connections: CONNS, asOfFor: () => D1, inventoryAsOf: D1 });
    const v3Sources = v3.flatMap((r) => r.sources);
    assert.ok(v3Sources.length > 0 && v3Sources.every((s) => s.requestKey === "listing-health-v3:listings" && s.sourceId === LISTINGS_ID && s.limit === 50000), region + ": v3 = canonical Listings only");
    const batches = new Map(v3Sources.map((s) => [s.requestHash, s]));
    assert.equal(batches.size, Math.ceil(accounts.length / 5), region + ": one Listings batch per <=5 sellers");
    assert.ok([...batches.values()].every((s) => s.sellerOrVendorIds.length <= 5), region + ": <=5 sellers per batch");
    const fbaHashes = new Set(fba.flatMap((r) => r.sources.filter((s) => s.requestKey === "fba-plan:awd").map((s) => s.requestHash)));
    assert.deepEqual([...batches.keys()].sort(), [...fbaHashes].sort(), region + ": v3 Listings hashes == fba-plan:awd hashes");
    const fbaUnpaused = unpaused(() => PLANNER.planFbaPlanBucketBatched({ accounts, connections: CONNS, asOfFor: () => D1, inventoryAsOf: D1 }));
    assert.equal(JSON.stringify(fba), JSON.stringify(fbaUnpaused), region + ": the FBA Plan plan is byte-identical (pause never touches it)");
  }
});

test("2d. every bucket source sync (legacy + regional buckets; the Data Sync Center whole-bucket path) plans ZERO Raw jobs", async () => {
  const SBS = await import("../lib/server/sync/source-bucket-sync.js");
  for (const bucket of ["us", "non-us", "india", "europe-au", "us-ca"]) {
    const accounts = Array.from({ length: 6 }, (_, i) => ({ accountId: bucket + "-A" + i, rawSellerId: bucket + "-S" + i, country: bucket === "india" ? "IN" : (bucket === "us" || bucket === "us-ca" ? "US" : "DE"), currency: "USD" }));
    const coverageByAccountId = Object.fromEntries(accounts.map((a) => [a.accountId, []]));
    const plan = SBS.planBucketSourceSync({ apiKey: "prim-key", bucket, accounts, existingMembership: new Map(), coverageByAccountId, catalogSnapshot: null, fbaSnapshotsByAccount: {}, pausedSources: new Set(), asOf: "2026-08-19", today: "2026-08-20", catalogCarrierSeller: accounts[0].rawSellerId });
    assert.ok(plan.families.length > 0, bucket + ": planned");
    assert.ok(!plan.families.some((f) => f.sourceKey === "listings-raw"), bucket + ": no Raw family");
    assert.ok(plan.families.flatMap((f) => f.plannedJobs).every((j) => !isRawJob(j)), bucket + ": no Raw job identity");
  }
});

/* ============================== (3) budgets + authorization ============================== */
function makeRelease(accounts) {
  const runtime = {
    store: { reserveExportCreate: async () => "reserved", getCycleByBucketDate: async () => null, getBudget: async () => null, getBudgetHashes: async () => [] },
    dataDoe: {}, saveSnapshot: async () => ({ paramsHash: "ph" }), loadDerivedContext: async () => ({}),
  };
  return COMP.buildListingHealthV3IngestionRelease({
    operator: "test", makeRuntime: () => runtime, getConnections: () => CONNS,
    discoverAccountIds: async () => accounts.map((a) => a.accountId), readDirectoryAccounts: async () => accounts,
    getExportCache: async () => null, getTokenBalance: async () => ({ read: "ok", usable: 100000 }),
  });
}

test("3a. LHv3 budget = Listings only per region (1 premium create / 5 tokens per batch); the UNCHANGED stored authorization stays valid, authorizes and BINDS it (plan cost only went down)", async () => {
  assert.equal(AUTH.LISTING_HEALTH_V3_PRICING_REVISION, "2026-09-10-lhv3-premium5-raw-std2", "pricing revision unchanged (stored authorizations stay valid)");
  assert.deepEqual([AUTH.V3_CREATES_PER_BATCH, AUTH.V3_TOKENS_PER_BATCH], [2, 7], "authorization ceilings unchanged");
  for (const [region, accounts] of Object.entries(REGIONS)) {
    const batches = Math.ceil(accounts.length / 5);
    const rel = makeRelease(accounts);
    const plan = await rel.buildPlan({ accounts, connections: CONNS, cycleDate: D1, region });
    const cost = await OP.planListingHealthV3IngestionCost({ plan, getSourceExportCache: async () => null });
    assert.deepEqual([cost.newExports, cost.creates, cost.estimatedTokens], [batches, batches, batches * 5], region + ": cost = Listings only");
    const ceil = MAT.assertListingHealthV3ExportCeiling({ region, plans: plan.reportRequests, accountCount: accounts.length });
    assert.equal(ceil.ceiling, batches, region + ": computed ceiling = 1 x batches");
    const frozen = rel.freezeBudget({ plan, region });
    assert.deepEqual([frozen.maxCreates, frozen.maxTokens, frozen.hashes.length], [batches, batches * 5, batches], region + ": frozen tranche = Listings only");
    const authz = AUTH.readListingHealthV3Authorization({ region });
    assert.equal(authz.authorized, true, region + ": the stored authorization is still valid (drift guard passes)");
    const decision = AUTH.decideListingHealthV3Authorization({ region, accountCount: accounts.length, requiredCreates: cost.creates, requiredTokens: cost.estimatedTokens, authorization: authz });
    assert.equal(decision.ok, true, region + ": authorized");
    const bound = AUTH.computeListingHealthV3AuthorizationBinding({ region, cycleDate: D1, operationId: "op", trancheKey: "lhv3-new#" + region, accountIds: accounts.map((a) => a.accountId), frozen, pricingRevision: AUTH.LISTING_HEALTH_V3_PRICING_REVISION, authorization: authz });
    assert.equal(bound.ok, true, region + ": binds");
  }
});

test("3b. the Data Sync Center Raw card is none/source-paused (never paid-syncable); the Listings card still runs the FBA operation", () => {
  if (typeof ADMIN.paidSyncCardKind !== "function") { out("    (paidSyncCardKind not on this line -- card pricing is checked by the 409 refusals in 5a)"); return; }
  assert.deepEqual(ADMIN.paidSyncCardKind("listings-raw"), { kind: "none", reason: "source-paused" });
  assert.deepEqual(ADMIN.paidSyncCardKind("listings"), { kind: "fba" });
});

/* ============================== (4) source worker ============================== */
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

test("4a. a leftover (pre-pause frozen) Raw job is recorded TERMINAL LISTINGS_RAW_PAUSED before any claim / reservation / POST -- with and without a frozen budget -- and is never re-attempted", async () => {
  const rawSource = unpaused(() => PLANNER.planListingHealthV3BucketBatched({ accounts: REGIONS["us-ca"], connections: CONNS, asOfFor: () => D1, inventoryAsOf: D1 }))[0].sources.find(isRawJob);
  assert.ok(rawSource, "a pre-pause Raw source identity");
  for (const budget of [null, { trancheKey: "lhv3-new#us-ca", planFingerprint: "fp" }]) {
    const job = DRIVER.plannedSourceJob("listing-health-v3", rawSource, "us-ca", "primary", "us-1", "us-1", "US");
    const store = makeStore();
    let creates = 0;
    const dataDoe = { async create() { creates += 1; return { exportId: "x" }; }, async poll() {}, async download() { return []; } };
    const res = await WORKER.runSourceJobs({ bucket: "us-ca", cycleDate: D1, store, dataDoe, plannedJobs: [job], ...(budget ? { budget } : {}) });
    const row = store._rawJob(res.cycleId, job.requestHash);
    assert.equal(row.error_code, "LISTINGS_RAW_PAUSED");
    assert.equal(row.terminal, true, "terminal (never retried)");
    assert.equal(creates, 0, "ZERO create POSTs");
    assert.equal(store.calls.claim + store.calls.reserve, 0, "no claim and no token reservation");
    await WORKER.runSourceJobs({ bucket: "us-ca", cycleDate: D1, store, dataDoe, plannedJobs: [job], ...(budget ? { budget } : {}) });
    assert.equal(creates, 0, "a repeated worker run never re-attempts it");
  }
});

test("4b. a createExport paused refusal classifies TERMINAL + non-transient (no EXPORT_ERROR retry loop)", async () => {
  let err = null;
  try { await DD.createExport("k", RAW_ID, ["sku"], ["S1"], null, null, 1); } catch (e) { err = e; }
  const cls = WORKER.classifyFetchError(err, "create-export");
  assert.deepEqual([cls.code, cls.terminal, cls.transient], ["LISTINGS_RAW_PAUSED", true, false]);
});

/* ============================== (5) admin / onboarding / recovery ============================== */
function fakeRes() { return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; }
function adminDeps() {
  const calls = { writes: 0, runtime: 0, reads: 0 };
  const count = (k) => async () => { calls[k] += 1; return { rows: [], read: "ok" }; };
  const deps = {
    getDashboardAccess: async () => ({ userId: "admin-raw-pause-test" }), assertAdmin: () => {},
    isAdsRegistryKeyRetired: () => false,
    insertAuditLog: count("writes"), setSourceControl: count("writes"),
    getSourceControls: count("reads"), getSourceRunStatuses: count("reads"), getAccountDirectoryRows: async () => { calls.reads += 1; return []; },
    getAccountOliQualityCounts: async () => ({}), primaryOrganizationFingerprint: () => "org-fp",
    buildBucketSourceSyncRuntime: () => { calls.runtime += 1; throw new Error("runtime must never be built for a paused source"); },
    now: () => Date.UTC(2026, 9, 9, 3, 0),
    getDataDoeConnections: () => [{ id: "primary", apiKey: "b-key", accountPrefix: "", organizationFingerprint: "org-fp" }],
  };
  return { deps, calls };
}

test("5a. Data Sync Center PATCH + POST (preview or execute) for listings-raw -> typed 409 LISTINGS_RAW_PAUSED, ZERO writes / runtime / reads", async () => {
  for (const req of [
    { method: "PATCH", body: { sourceKey: "listings-raw", paused: false } },
    { method: "PATCH", body: { sourceKey: "listings-raw", paused: true } },
    { method: "POST", body: { bucket: "us", sourceKey: "listings-raw", preview: true } },
    { method: "POST", body: { bucket: "non-us", sourceKey: "listings-raw" } },
  ]) {
    const { deps, calls } = adminDeps();
    const res = fakeRes();
    await ADMIN.handler(req, res, deps);
    assert.equal(res.statusCode, 409, req.method + " " + JSON.stringify(res.body));
    assert.equal(res.body.code, "LISTINGS_RAW_PAUSED");
    assert.equal(res.body.retryable, false);
    assert.match(String(res.body.message), /paused/i, "user-readable message");
    assert.deepEqual(calls, { writes: 0, runtime: 0, reads: 0 }, "zero writes / runtime / reads");
  }
});

test("5b. the api/datadoe.js sample probe refuses the Raw id BEFORE its direct export POST (typed 409); the route error mapping is a typed NON-retryable 409", async () => {
  const src = read("api/datadoe.js");
  const start = src.indexOf('if (action === "sample") {');
  assert.ok(start > 0);
  const block = src.slice(start, src.indexOf("res.status(400).json({ error: \"Unknown action.", start));
  const guard = block.indexOf("isPausedDataDoeSourceId(sourceId)");
  const post = block.indexOf("ddFetch(ENDPOINTS.exportsCreate");
  assert.ok(guard > 0 && post > 0 && guard < post, "the paused-source guard precedes the direct POST");
  assert.ok(/res\.status\(409\)\.json\(\{ error: SOURCE_CODE_PAUSED_ERROR_CODE, code: SOURCE_CODE_PAUSED_ERROR_CODE/.test(block.slice(guard, post)), "a typed 409");
  let err = null;
  try { await DD.fetchExportRowsStrict("k", RAW_ID, ["sku"], ["S9"], null, null, 50000, {}, "Raw"); } catch (e) { err = e; }
  const mapped = API.classifyDataDoeRouteError(err);
  assert.equal(mapped.status, 409);
  assert.deepEqual([mapped.body.code, mapped.body.retryable], ["LISTINGS_RAW_PAUSED", false]);
  assert.match(mapped.body.error, /paused/i);
  assert.equal(API.classifyDataDoeRouteError(new Error("ordinary failure")), null, "other errors keep their handling");
});

test("5c. onboarding binds ONLY the canonical Listings request; the recovery Listings route (web) and the LHv3 reconciler CLI are zero-export (no create path)", () => {
  assert.deepEqual([...BOOT.FBA_STEP_SOURCE_KEYS], ["listings"]);
  assert.ok(!JSON.stringify(BOOT.fbaStepWindows()).includes("listings-raw"));
  const createApi = /\b(createExport|fetchExportRows|fetchExportRowsStrict|exportsCreate)\b/;
  for (const f of ["scripts/release/listing-health-v3-reconcile.mjs", "lib/server/recovery/routes/listings.route.js"]) {
    if (!existsSync(path.join(ROOT, f))) { out("    (" + f + " not on this line)"); continue; }
    const code = read(f).split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    assert.ok(!createApi.test(code), f + " has no export-create path");
  }
});

/* ============================== (6) v1 manual refresh ============================== */
test("6a. a v1 Listing Health refresh runs Listings + Sales + Catalog over the fake DataDoe and NEVER fetches Raw; issues are unavailable with the PAUSED reason (not the enable hint)", async () => {
  const LISTINGS_V1_ID = SC.sourceContractForKey("listings").ids[0];
  const PROFIT_ID = SC.sourceContractForKey("profit-by-sku-date").ids[0];
  const CATALOG_ID = SC.sourceContractForKey("product-catalog").ids[0];
  net.rowsBySource.set(LISTINGS_V1_ID, [{ sku: "SKU-A", child_asin: "ASIN-A", listing_name: "A", listing_status: "Inactive", listing_price_value: 9, listing_price_currency: "USD", listing_current_quantity: 3, listing_fulfillment_channel: "DEFAULT" }]);
  net.rowsBySource.set(PROFIT_ID, [{ sku: "SKU-A", child_asin: "ASIN-A", currency: "USD", sales_sum: 50, units_sum: 5, profit_sum: 10 }]);
  net.rowsBySource.set(CATALOG_ID, [{ child_asin: "ASIN-A", product_name: "Product A", product_brand: "BrandA" }]);
  const createsBefore = net.creates.length;
  const none = async () => ({ read: "ok", snapshot: null });
  const payload = await authorizedPaidRequest(async () => {
    return LHB.buildListingHealth({ apiKey: "v1-key", ids: ["V1SELLER"], to: D1, listings: { readPointer: none, readPayload: async () => null, readHealthPointer: none, readHealthPayload: async () => null } });
  });
  const made = net.creates.slice(createsBefore);
  assert.equal(made.filter((s) => s === RAW_ID).length, 0, "ZERO Raw creates");
  assert.deepEqual([...made].sort(), [LISTINGS_V1_ID, PROFIT_ID, CATALOG_ID].sort(), "Listings + Sales + Catalog each created once (unchanged)");
  assert.equal(payload.issuesAvailable, false);
  assert.match(payload.issuesUnavailableReason, /Listings \(Raw JSON\) is paused/);
  assert.ok(!/enable Listings \(Raw JSON\)/.test(payload.issuesUnavailableReason), "never the DataDoe enable hint");
  assert.equal(payload.rows.length, 1);
  assert.deepEqual([payload.rows[0].issues, payload.rows[0].summary, payload.rows[0].hasLiveOffer], [[], null, null], "no Raw-derived evidence");
  assert.equal(payload.rows[0].sales30d, 50, "the Sales source still feeds the report");
});

/* ============================== (7) LHv3 truthfulness ============================== */
const SELLER = "SELLER-1";
const noDate = (requestKey, rows) => ({ available: true, rows, fragments: [{ requestKey, from: null, to: null, sellerOrVendorIds: [SELLER], rows }], disabled: false, disabledPolicy: null, reason: null });
const v3Context = () => ({
  to: D1, rawSellerId: SELLER, accountId: "acct-1", marketCountry: "US",
  listingsFetchedAt: "2026-10-08T06:00:00.000Z", rawFetchedAt: "2026-09-01T06:00:00.000Z", catalogFetchedAt: "2026-10-08T05:00:00.000Z",
  listingHealthV3DurableOli: { available: true, rows: [{ account_id: "acct-1", seller_or_vendor_id: SELLER, sale_date: "2026-10-01", sku: "A", child_asin: "ASIN-A", currency: "USD", sales_amount: 100, ordered_units: 10, unpriced_units: 0 }], coverageWindows: [{ from: "2024-01-01", to: D1 }], completenessRows: [] },
  listingHealthV3DurableCatalog: { available: true, rows: [{ child_asin: "ASIN-A", product_name: "P A", product_brand: "BrandX" }, { child_asin: "ASIN-B", product_name: "P B", product_brand: "BrandX" }] },
  listingHealthV3DurableInventory: { available: false, reason: "health-snapshot-missing" },
});
const v3Listings = [
  { seller_or_vendor_id: SELLER, marketplace_country_code: "US", sku: "A", child_asin: "ASIN-A", listing_name: "L A", listing_status: "Active", listing_price_value: 25, listing_price_currency: "USD", listing_current_quantity: 0, fba_quantity_available: 30, listing_fulfillment_channel: "AMAZON_NA", listing_open_date: "2024-01-01" },
  { seller_or_vendor_id: SELLER, marketplace_country_code: "US", sku: "B", child_asin: "ASIN-B", listing_name: "L B", listing_status: "Inactive", listing_price_value: 0, listing_price_currency: "USD", listing_current_quantity: 7, fba_quantity_available: 0, listing_fulfillment_channel: "DEFAULT", listing_open_date: "2024-01-01" },
];
// A VALIDATED (but, while paused, never usable) Raw fragment that would flag SKU A as an Amazon error / not buyable.
const v3Raw = [{ seller_or_vendor_id: SELLER, marketplace_country_code: "US", sku: "A", child_asin: "ASIN-A", summaries: JSON.stringify({ status: [] }), issues: JSON.stringify([{ severity: "ERROR", code: "1", message: "x" }]), offers: JSON.stringify([]) }];

async function deriveV3(withRaw) {
  const sources = { "listing-health-v3:listings": noDate("listing-health-v3:listings", v3Listings) };
  if (withRaw) sources["listing-health-v3:listings-raw"] = noDate("listing-health-v3:listings-raw", v3Raw);
  return DERIV.deriveReportSnapshot({ reportKey: "listing-health-v3", sources, context: v3Context() });
}

test("7a. LHv3 derive while PAUSED: no Raw source needed; even a VALIDATED Raw fragment is ignored -> issuesAvailable false + PAUSED reason + code, rawFetchedAt null, Listings-only flags kept, Raw-only flags absent", async () => {
  for (const withRaw of [false, true]) {
    const d = await deriveV3(withRaw);
    assert.equal(d.status, "derived", "derived (withRaw=" + withRaw + ")");
    const p = d.payload;
    assert.equal(p.issuesAvailable, false);
    assert.equal(p.issuesUnavailableCode, "listings-raw-paused");
    assert.match(p.issuesUnavailableReason, /Listings \(Raw JSON\) is paused/);
    assert.ok(!/enable Listings \(Raw JSON\)/.test(p.issuesUnavailableReason), "never the DataDoe enable hint");
    assert.equal(p.provenance.rawFetchedAt, null, "a saved Raw fetch time is never presented");
    const a = p.rows.find((r) => r.sku === "A"); const b = p.rows.find((r) => r.sku === "B");
    assert.deepEqual([a.buyable, a.discoverable, a.liveOffer, a.issues.length], [null, null, null, 0], "no Raw-only evidence");
    assert.ok(!(a.flagReasons || []).some((x) => ["amazon_issue_error", "not_buyable", "not_discoverable", "no_live_offer"].includes(x.code)), "no Raw-only flag");
    assert.equal(b.flagged, true, "the Listings-only flag (Inactive) still applies");
  }
  // Rollback proof: unpaused, the SAME validated Raw fragment IS used (the pause is the only thing hiding it).
  SP.__setSourcePauseForTests({});
  try {
    const d = await deriveV3(true);
    assert.equal(d.payload.issuesAvailable, true);
    assert.ok((d.payload.rows.find((r) => r.sku === "A").flagReasons || []).some((x) => x.code === "amazon_issue_error"));
  } finally { SP.__resetSourcePauseForTests(); }
});

test("7b. view: the As-of never uses a Raw fetch time when issues are unavailable; Priority Actions never says 'none' / 'No action needed' while paused", async () => {
  const p = (await deriveV3(true)).payload;
  const rows = VIEW.buildV3Rows(p);
  assert.ok(rows.length === 2 && rows.every((r) => r.evidenceAsOf === "2026-10-08"), "As-of = the Listings fetch date (never the 2026-09-01 Raw time)");
  assert.ok(rows.every((r) => r.evidenceStale === false));
  const t0 = VIEW.v3PriorityActionsText(p, 0);
  assert.ok(t0.paused === true && t0.issuesUnavailable === true);
  assert.ok(!/none/i.test(t0.headerSuffix) && !/No action needed/i.test(t0.emptyNote), "never an all-clear");
  assert.match(t0.emptyNote, /paused/);
  const ok0 = VIEW.v3PriorityActionsText({ issuesAvailable: true }, 0);
  assert.equal(ok0.emptyNote, "No action needed from this preview right now.", "the unpaused wording is unchanged");
  const jsx = read("src/views/ListingHealthV3.jsx");
  assert.ok(jsx.includes("priorityText.headerSuffix") && jsx.includes("{priorityText.emptyNote}") && !jsx.includes("No action needed from this preview right now."), "the page renders the pause-aware wording");
});

test("7c. Priority Feed: Listings-only alerts still appear while paused, no Raw-derived claim, and the freshness names the pause", async () => {
  const p = (await deriveV3(true)).payload;
  const ins = INS.buildListingHealthV3Insights(p);
  assert.ok(ins.length >= 1 && ins.some((i) => i.sku === "B" && i.category === "inactive"), "the Inactive listing alert still appears");
  assert.ok(ins.every((i) => !["error", "suppressed", "no_live_offer"].includes(i.category)), "no Raw-only alert");
  assert.ok(ins.every((i) => /paused/.test(JSON.stringify(i.freshness))), "the freshness names the pause");
});

/* ============================== (8) static scan ============================== */
test("8a. the Raw source id appears (in CODE) only in the registry / contract / pause files", () => {
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(m?js|jsx|cjs)$/.test(name)) continue;
      const rel = path.relative(ROOT, p).split(path.sep).join("/");
      const code = readFileSync(p, "utf8").split("\n").filter((l) => { const t = l.trim(); return !t.startsWith("//") && !t.startsWith("*"); });
      if (code.some((l) => l.toLowerCase().includes("6ea445cd"))) hits.push(rel);
    }
  };
  for (const d of ["lib", "api", "src", "scripts/release"]) if (existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
  assert.deepEqual(hits.sort(), ["lib/server/reports/sources.js", "lib/server/source-contracts.js", "lib/server/source-pause.js", "lib/server/sync/source-registry.js"], "unexpected Raw id references: " + hits.join(", "));
});

async function main() {
  out("listings-raw-paused");
  SP = await import("../lib/server/source-pause.js");
  DD = await import("../lib/server/datadoe.js");
  SC = await import("../lib/server/source-contracts.js");
  RSC = await import("../lib/server/sync/report-source-contracts.js");
  PLANNER = await import("../lib/server/sync/report-planner.js");
  OP = await import("../lib/server/sync/listing-health-v3-operation.js");
  COMP = await import("../lib/server/sync/listing-health-v3-ingestion-composition.js");
  AUTH = await import("../lib/server/sync/listing-health-v3-authorization.js");
  MAT = await import("../lib/server/sync/listing-health-v3-materialize.js");
  WORKER = await import("../lib/server/sync/source-worker.js");
  DRIVER = await import("../lib/server/sync/source-sync-driver.js");
  ADMIN = await import("../api/admin/sources.js");
  API = await import("../api/datadoe.js");
  BOOT = await import("../lib/server/sync/account-onboarding-bootstrap.js");
  DERIV = await import("../lib/server/sync/report-derivation.js");
  LHB = await import("../lib/server/reports/listing-health.js");
  VIEW = await import("../src/lib/listing-health-v3-view.js");
  INS = await import("../src/lib/insights.js");
  assert.ok(ALL_ACCOUNTS.length === 27);
  let failures = 0;
  for (const t of tests) {
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (e) { failures += 1; out("FAIL  " + t.name + "\n" + (e && e.stack ? e.stack : e)); }
  }
  const rawCreates = net.creates.filter((s) => s === RAW_ID).length;
  try { assert.equal(rawCreates, seamRawCreates, "every Raw create happened inside the explicit unpaused seam"); passed += 1; out("  ok  9. ZERO Raw creates while paused across the whole suite (" + seamRawCreates + " only inside the explicit unpaused seam)"); }
  catch (e) { failures += 1; out("FAIL  9. ZERO Raw creates while paused: " + e.message); }
  out("  (fake DataDoe: " + net.calls.length + " request(s), " + net.creates.length + " create(s))");
  out(`\nlistings-raw-paused: ${passed} passed${failures ? ", " + failures + " FAILED" : ""}`);
  if (failures) process.exitCode = 1;
}
main();
