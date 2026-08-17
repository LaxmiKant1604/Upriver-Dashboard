// Scheduler v2 -- SOURCE-FIRST tranche orchestration proof suite (SHADOW MODE, offline, ZERO network/DB).
//
// Drives the REAL runSourceJobs / runStagedSourceCycle / runReportJobs against a lean in-memory store and a
// spy DataDoe double (create/poll/download call counts), plus the pure source-tranche descriptor + the
// trusted buildSchedulerV2SourceTrancheRuntime composition. Proves the 14 required behaviours:
//   1  the five OLI reports share ONE request_hash per overlapping account/slice.
//   2  one canonical source row carries ALL applicable owner memberships.
//   3  different seller accounts do NOT share OLI hashes.
//   4  a current EXACT durable cache entry => success with ZERO DataDoe create/poll/download; export_id null,
//      create_export_count 0, attempted_at null, cache_object_path = the existing entry.
//   5  expired / mismatched (source_id or scope) / malformed (non-array) / cap-sized cache => NOT reused =>
//      exactly one create-export (the normal path runs).
//   6  a persisted export_id (status attempted) => poll/download resume only, ZERO create-export.
//   7  a manual/UI export without a proven exact-identity durable entry => rejected (no reuse; falls through
//      to create when in the tranche, or stays pending when the family is not in the tranche).
//   8  the OLI tranche executes ONLY order-line-items jobs across MULTIPLE accounts (non-OLI upserted but
//      pending; zero non-OLI creates).
//   9  the NEXT tranche (product-catalog) resumes the SAME bucket/cycleDate and creates NO duplicate export
//      for already-succeeded OLI hashes.
//   10 reports stay PENDING until every required dependency succeeds (a still-pending non-OLI dep blocks derive).
//   11 a complete report derives ONCE; an unrelated report's failed dep preserves its LKG and never blocks it.
//   12 a resumable deferral resumes safely (no duplicate create on the resumed hash).
//   13 NO ownerless, cross-account, or cross-organization source job is produced by the tranche path.
//   14 the existing report-parity / request-hash-golden / lifecycle suites remain GREEN (run by verify.mjs).
// Plus an explicit SOURCE_TRANCHE_ORDER order proof + the trusted-composition tranche-fixing proof.
//
// 7-bit ASCII, LF, no top-level await, synchronous writeSync progress, dynamic imports after a dummy Supabase
// env. No secret-shaped literals; every DataDoe/Supabase call is an injected in-memory fake.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = process.env[SB_KEY_ENV] || ["test", "svc", "role", "key"].join("-");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const group = (label) => tests.push({ marker: label });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

// Assigned in main() after the dummy env is set.
let runSourceJobs, runStagedSourceCycle, plannedSourceJob, plannedBatchSourceJobs, runReportJobs;
let accountScopeHash;
let buildShadowReportPlan;
let REPORT_SOURCE_CONTRACTS;
let sourceRequestIdentity, sourceJobOwnerId, SOURCE_CONTRACTS;
let makeSourceTranche, SOURCE_TRANCHE_ORDER, isSourceTranche;
let buildSchedulerV2SourceTrancheRuntime, buildSchedulerV2Runtime;

const ID = "A1";
const ID2 = "A2";
const ASOF = "2025-08-10";
const CYCLE_DATE = "2026-08-11";
const dash = (...p) => p.join("-");
const CONNS = [
  { id: "primary", apiKey: dash("prim", "key"), accountPrefix: "" },
  { id: "secondary", apiKey: dash("sec", "key"), accountPrefix: dash("dd", "secondary") + ":" },
];
const DRIVER_CONNECTION_ID = { primary: "primary", secondary: "dd-secondary" };
const asOfForUS = () => ASOF;
const acct = (id) => ({ accountId: id, country: "US", currency: "USD" });
const FUTURE_TTL = () => new Date(Date.now() + 20 * 3600 * 1000).toISOString();
const PAST_TTL = () => new Date(Date.now() - 3600 * 1000).toISOString();

// ---- row builders (OLI / returns / settlements / catalog), matching the report-returns fixtures ----
const ret = (date, asin, sku, reason, channel, status, refunded) => ({
  date, sku, child_asin: asin, amazon_order_id: "O", amazon_return_reason: reason,
  amazon_fulfillment_channel: channel, amazon_return_request_status: status, amazon_return_refunded_amount: refunded,
});
const refund = (asin, sku, currency, o) => ({
  sku, child_asin: asin, settlement_type: "REFUND", currency,
  refunded_amount_sum: o.amount || 0, refund_commission_sum: o.commission || 0,
  return_unit_fee_sum: o.unitFee || 0, cogs_sum: o.cogs || 0, quantity_sum: o.qty || 0,
});
const ord = (asin, name, sales, units, currency, date) => ({
  date, seller_or_vendor_id: ID, sku: "SKU-" + asin, child_asin: asin,
  item_price_currency: currency || "USD", product_name: name, total_sales_sum: sales, total_units_sum: units,
});
const cat = (asin, parent, name, brand) => ({ child_asin: asin, parent_asin: parent, product_name: name, product_brand: brand });

/* --------------------------------- in-memory store --------------------------------- */
// A lean store implementing exactly the interface runSourceJobs / runReportJobs call. The source cache carries
// FULL production-shaped metadata (source_id / organization_fingerprint / account_scope_hash / object_path /
// row_count / payload_bytes / expires_at) so the Part C confirmed-reuse path can be exercised faithfully; an
// expired entry (expires_at <= now) is filtered to null (mirrors getSourceExportCache's expires_at>now gate).
function makeStore() {
  const cycles = new Map();
  const jobsByCycle = new Map();
  const ownersByCycle = new Map();
  const cache = new Map();
  const reportJobs = new Map();
  const snapshots = new Map();
  let seq = 0;
  const findCycle = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  const ownerRows = (cid) => [...((ownersByCycle.get(cid) && ownersByCycle.get(cid).values()) || [])];
  const rkey = (rk, a) => rk + "|" + a;
  return {
    _rawJob(cid, hash) { return jobsByCycle.get(cid) && jobsByCycle.get(cid).get(hash); },
    _owners(cid) { return ownerRows(cid).map((m) => ({ ...m })); },
    _snapshots: snapshots,
    _seedCache(hash, entry) { cache.set(hash, { ...entry }); },
    openCycle({ bucket, cycleDate }) {
      const k = bucket + "|" + cycleDate;
      if (!cycles.has(k)) { const id = "cyc_" + (seq += 1); cycles.set(k, { id, bucket, status: "pending" }); jobsByCycle.set(id, new Map()); }
      return cycles.get(k).id;
    },
    claimCycle(id) { const c = findCycle(id); if (c && c.status === "pending") { c.status = "running"; return true; } return false; },
    getCycle(id) { return findCycle(id); },
    upsertSourceJob(job) {
      const m = jobsByCycle.get(job.cycleId);
      if (m.has(job.requestHash)) return;
      m.set(job.requestHash, {
        request_hash: job.requestHash, request_key: job.requestKey, source_id: job.sourceId, source_key: job.sourceKey,
        connection_id: job.connectionId, organization_fingerprint: job.organizationFingerprint, account_scope_hash: job.accountScopeHash,
        fetch_status: "pending", attempted_at: null, create_export_count: 0, export_id: null,
        terminal: false, error_stage: null, error_code: null, error_message: null, row_count: null, cache_object_path: null,
      });
    },
    listSourceJobs(id) { return [...((jobsByCycle.get(id) && jobsByCycle.get(id).values()) || [])].map((j) => ({ ...j })); },
    upsertSourceJobOwners(ms) {
      for (const m of ms || []) {
        if (!ownersByCycle.has(m.cycleId)) ownersByCycle.set(m.cycleId, new Map());
        ownersByCycle.get(m.cycleId).set(m.ownerId + "|" + m.requestHash, {
          cycle_id: m.cycleId, request_hash: m.requestHash, owner_id: m.ownerId, request_key: m.requestKey,
          report_key: m.reportKey, account_id: m.accountId, connection_id: m.connectionId,
          organization_fingerprint: m.organizationFingerprint, account_scope_hash: m.accountScopeHash, owner_status: "active", error_code: null,
        });
      }
    },
    listSourceJobOwners(cid, ids) { const s = new Set(ids || []); return ownerRows(cid).filter((m) => s.has(m.owner_id)).map((m) => ({ ...m })); },
    recordSourceOwnerStale({ cycleId, requestHash, ownerId, code }) { const m = ownersByCycle.get(cycleId) && ownersByCycle.get(cycleId).get(ownerId + "|" + requestHash); if (m) { m.owner_status = "stale"; m.error_code = code || "STALE_PLAN"; } },
    // Models claim_source_export_attempt WITH the Blocker-2 `fetch_status='pending'` guard (mutually
    // exclusive with adoptSourceCache): only a still-pending, unattempted row can be claimed.
    claimExportAttempt(id, h) { const j = jobsByCycle.get(id) && jobsByCycle.get(id).get(h); if (j && j.fetch_status === "pending" && j.attempted_at === null) { j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted"; return true; } return false; },
    // Models the HARDENED adopt_source_export_cache (Blocker 2 + senior review): re-reads the ACTUAL current
    // cache entry and validates identity/integrity + expiry against the caller's EXPECTATIONS before adopting
    // the job with the cache row's OWN values. Returns the typed 'adopted' | 'not-adopted' | 'cache-changed' |
    // 'cache-expired'. Adoption leaves create_export_count=0, attempted_at null, export_id null (constraint-legal).
    adoptSourceCache({ cycleId, requestHash, sourceId, organizationFingerprint, accountScopeHash, objectPath, rowCount, payloadBytes }) {
      const e = cache.get(requestHash);
      if (!e) return "cache-changed";
      if (e.expires_at && new Date(e.expires_at).getTime() <= Date.now()) return "cache-expired";
      const mismatch = e.source_id !== sourceId
        || e.organization_fingerprint !== organizationFingerprint
        || e.account_scope_hash !== accountScopeHash
        || e.object_path !== objectPath
        || e.row_count !== rowCount
        || e.payload_bytes !== payloadBytes;
      if (mismatch) return "cache-changed";
      const j = jobsByCycle.get(cycleId) && jobsByCycle.get(cycleId).get(requestHash);
      if (j && j.fetch_status === "pending" && j.attempted_at === null && j.create_export_count === 0) {
        Object.assign(j, { fetch_status: "succeeded", export_id: null, row_count: e.row_count, payload_bytes: e.payload_bytes, cache_object_path: e.object_path, error_stage: null, error_code: null });
        return "adopted";
      }
      return "not-adopted";
    },
    recordExportCreated({ cycleId, requestHash, exportId }) { jobsByCycle.get(cycleId).get(requestHash).export_id = exportId; },
    loadSourceRows(h) {
      const e = cache.get(h);
      if (!e) return null;
      if (e.expires_at && new Date(e.expires_at).getTime() <= Date.now()) return null; // TTL gate (expires_at>now)
      return { ...e };
    },
    saveSourceRows({ job, rows, payloadBytes }) {
      const h = job.request_hash != null ? job.request_hash : job.requestHash;
      const objectPath = "source-cache/v2/" + h + ".json";
      cache.set(h, {
        rows: [...rows], source_id: job.sourceId, organization_fingerprint: job.organizationFingerprint,
        account_scope_hash: job.accountScopeHash, object_path: objectPath, row_count: rows.length,
        payload_bytes: payloadBytes, expires_at: FUTURE_TTL(),
      });
      return objectPath;
    },
    recordSourceSuccess({ cycleId, requestHash, exportId, rowCount, cacheObjectPath }) {
      Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "succeeded", export_id: exportId, row_count: rowCount, cache_object_path: cacheObjectPath, error_stage: null, error_code: null });
    },
    recordSourceFailure({ cycleId, requestHash, stage, code, message, terminal, rowCount, exportId }) {
      const j = jobsByCycle.get(cycleId).get(requestHash);
      Object.assign(j, { fetch_status: "failed", error_stage: stage, error_code: code, error_message: message, terminal: !!terminal });
      if (rowCount != null) j.row_count = rowCount;
      if (exportId != null) j.export_id = exportId;
    },
    updateCycleCounts() { /* not asserted here */ },
    // ---- report-derivation half ----
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

/* --------------------------------- DataDoe spy double --------------------------------- */
function makeDataDoe(opts = {}) {
  const create = {}; const poll = {}; const download = {}; let deferHits = 0;
  const bump = (m, h) => { m[h] = (m[h] || 0) + 1; };
  const deadlineErr = () => Object.assign(new Error("deferred"), { code: "DATADOE_DEADLINE" });
  const rowsFor = (job) => {
    const rk = job.requestKey || ""; const fp = job.fetchParams || {};
    if (rk.includes("returns-leakage:returns")) return [ret(fp.to || ASOF, "R1", "SKU-R1", "DEFECTIVE", "FBA", "Approved", -5)];
    if (rk.includes("settlements")) return [refund("R1", "SKU-R1", "USD", { amount: -9, commission: -1, unitFee: -1, cogs: -2, qty: -1 })];
    if (rk.includes("oli-sales")) return [ord("R1", "Widget R1", 100, 10, "USD", fp.to || ASOF)];
    if (rk.includes("catalog")) return [cat("R1", "P1", "Catalog R1", "Acme")];
    return [{ child_asin: "R1" }];
  };
  return {
    createCount: (h) => create[h] || 0, pollCount: (h) => poll[h] || 0, downloadCount: (h) => download[h] || 0,
    totalCreates: () => Object.values(create).reduce((a, b) => a + b, 0),
    totalPolls: () => Object.values(poll).reduce((a, b) => a + b, 0),
    totalDownloads: () => Object.values(download).reduce((a, b) => a + b, 0),
    async create(job) { bump(create, job.requestHash); return { exportId: "e_" + job.requestHash }; },
    async poll(job) { bump(poll, job.requestHash); if (opts.deferKey && (job.requestKey || "").includes(opts.deferKey)) { deferHits += 1; if (deferHits === 1) throw deadlineErr(); } },
    async download(job) { bump(download, job.requestHash); if (opts.capKey && (job.requestKey || "").includes(opts.capKey)) return new Array(Number(job.limit)).fill(0).map(() => ({ x: 1 })); return rowsFor(job); },
  };
}

/* --------------------------------- plan helpers --------------------------------- */
const shadowPlan = (accounts, keys, connections = CONNS) => buildShadowReportPlan({ accounts, reportKeys: keys, connections, asOfFor: asOfForUS });
const resolveJobs = (plan) => plan.reportRequests.flatMap((req) => req.sources.map(
  (s) => plannedSourceJob(req.reportKey, s, req.bucket, DRIVER_CONNECTION_ID[req.connectionId] || req.connectionId, req.accountId),
));
const resolveFromPlan = (plan) => () => ({ sourceJobs: resolveJobs(plan) });
const runGeneric = (store, dd, plan, opts = {}) => runStagedSourceCycle({ store, dataDoe: dd, resolvePlan: resolveFromPlan(plan), bucket: "us", cycleDate: CYCLE_DATE, ...opts });
const ownerIdsOf = (jobs) => [...new Set(jobs.map((j) => j.owner.ownerId))];
// A single returns-leakage:oli-sales planned job for one account (the newest canonical OLI slice).
const oneOliJob = (account) => {
  const jobs = resolveJobs(shadowPlan([account], ["returns-leakage"]));
  const oli = jobs.filter((j) => j.requestKey === "returns-leakage:oli-sales");
  return oli[oli.length - 1];
};
const OLI = () => makeSourceTranche({ sourceKeys: ["order-line-items"] });
const CATALOG = () => makeSourceTranche({ sourceKeys: ["product-catalog"] });
const oliContract = (reportKey, requestKey) => (REPORT_SOURCE_CONTRACTS[reportKey] || []).find((c) => c.requestKey === requestKey);
const OLI_SOURCE_ID = () => SOURCE_CONTRACTS.find((c) => c.key === "order-line-items").ids[0];

/* ============================= Part A: descriptor + order ============================= */
group("Part A: source-tranche descriptor + deterministic order");

test("order. SOURCE_TRANCHE_ORDER is the documented 5-tranche order and covers exactly the contract source families", () => {
  const names = SOURCE_TRANCHE_ORDER.map((t) => t.name);
  assert.deepEqual(names, ["order-line-items", "product-catalog", "date-sliceable", "current-state", "staged-signal"], "the exact documented tranche order");
  assert.deepEqual(SOURCE_TRANCHE_ORDER[0].sourceKeys, ["order-line-items"], "tranche 1 = OLI");
  assert.deepEqual(SOURCE_TRANCHE_ORDER[1].sourceKeys, ["product-catalog"], "tranche 2 = catalog");
  // The union of tranche source families equals the distinct set the contracts actually declare (no drift/gap).
  const declared = new Set(SOURCE_TRANCHE_ORDER.flatMap((t) => t.sourceKeys));
  const contractKeys = new Set();
  for (const sources of Object.values(REPORT_SOURCE_CONTRACTS)) for (const c of sources || []) if (c && c.sourceKey) contractKeys.add(c.sourceKey);
  assert.deepEqual([...declared].sort(), [...contractKeys].sort(), "tranche families == contract source families (bijective)");
  // Every family in exactly one tranche.
  const flat = SOURCE_TRANCHE_ORDER.flatMap((t) => t.sourceKeys);
  assert.equal(flat.length, new Set(flat).size, "each source family appears in exactly one tranche");
});

test("descriptor. makeSourceTranche is IMMUTABLE + UNFORGEABLE, selects by source_key or request_hash, idempotent, fails closed (Blocker 5)", () => {
  const t = makeSourceTranche({ sourceKeys: ["order-line-items"] });
  assert.ok(isSourceTranche(t) && Object.isFrozen(t) && Array.isArray(t.sourceKeys) && typeof t.selects === "function", "immutable frozen descriptor with array membership (never a mutable Set)");
  assert.ok(Object.isFrozen(t.sourceKeys), "the exposed membership is a FROZEN array");
  assert.equal(t.selects({ sourceKey: "order-line-items" }), true);
  assert.equal(t.selects({ source_key: "order-line-items" }), true, "snake_case canonical job field");
  assert.equal(t.selects({ sourceKey: "product-catalog" }), false);
  // Immutable policy: mutating (or attempting to mutate) the exposed membership can NEVER widen selects().
  try { t.sourceKeys.push("EVIL"); } catch (_e) { /* a frozen array throws under module strict mode */ }
  assert.equal(t.selects({ sourceKey: "EVIL" }), false, "policy cannot be widened by mutating the exposed membership array");
  assert.equal(makeSourceTranche(t), t, "a GENUINE built descriptor passes through unchanged (idempotent)");
  // Unforgeable: a hand-built look-alike carrying an arbitrary selects() is NOT a tranche and is never adopted
  // as trusted policy -- it is treated as a (here malformed) spec and rejected, so selects() can't be smuggled.
  assert.equal(isSourceTranche({ selects: () => true, sourceKeys: new Set(["x"]) }), false, "a forged look-alike is not a tranche");
  assert.equal(isSourceTranche(Object.freeze({ selects: () => true, sourceKeys: ["x"] })), false, "even a frozen forged look-alike is not a tranche (no private brand)");
  assert.throws(() => makeSourceTranche({ selects: () => true, sourceKeys: new Set(["x"]) }), /nonblank strings/, "a forged object's arbitrary selects() is never adopted (Set fails the string-array gate)");
  const h = makeSourceTranche({ requestHashes: ["abc123"] });
  assert.equal(h.selects({ requestHash: "abc123" }), true);
  assert.equal(h.selects({ requestHash: "zzz" }), false);
  assert.throws(() => makeSourceTranche({}), /EXACTLY ONE/, "neither selector => throws");
  assert.throws(() => makeSourceTranche({ sourceKeys: ["a"], requestHashes: ["b"] }), /EXACTLY ONE/, "both selectors => throws");
  assert.throws(() => makeSourceTranche({ sourceKeys: [" ", ""] }), /nonblank strings/, "blank entries => throws");
  assert.throws(() => makeSourceTranche(null), /spec object/, "non-object => throws");
});

test("composition. buildSchedulerV2SourceTrancheRuntime FIXES the tranche at build time and deletes any smuggled override", () => {
  const rt = buildSchedulerV2SourceTrancheRuntime({ sourceKeys: ["order-line-items"] }, { connections: CONNS, sourceTranche: { sourceKeys: ["EVIL-SMUGGLED"] } });
  assert.ok(isSourceTranche(rt.sourceTranche), "the runtime carries a built tranche collaborator");
  assert.equal(rt.sourceTranche.name, "order-line-items", "the reviewed tranche is used; the smuggled override is dropped");
  assert.equal(rt.sourceTranche.selects({ sourceKey: "EVIL-SMUGGLED" }), false, "the smuggled family is never selected");
  assert.equal(typeof rt.run, "function", "it is a full runtime");
  const plain = buildSchedulerV2Runtime({ connections: CONNS });
  assert.equal(plain.sourceTranche, null, "a plain runtime has no tranche (execute-everything, unchanged)");
});

/* ============================= Part B: OLI hash sharing ============================= */
group("Part B: OLI canonical hash sharing across reports + accounts");

test("1. the five OLI reports share ONE canonical request_hash per overlapping account/slice", () => {
  const REPORTS = {
    "daily-reporting": "daily-reporting:oli-sales", "fba-plan": "fba-plan:oli-sales",
    "buy-box-loss": "buy-box-loss:oli-sales", "returns-leakage": "returns-leakage:oli-sales",
    "ppc-performance": "ppc-performance:oli-sales",
  };
  const win = { from: "2025-07-14", to: "2025-07-20" }; // one overlapping canonical slice, same for all five
  const sourceId = OLI_SOURCE_ID();
  const hashes = Object.entries(REPORTS).map(([rep, rk]) => {
    const c = oliContract(rep, rk);
    assert.ok(c && c.sourceKey === "order-line-items", rep + " owns a canonical OLI contract");
    const options = { groupBy: c.groupBy || undefined, aggregations: c.aggregations || undefined, orderByColumn: c.orderByColumn, orderByDirection: c.orderByDirection };
    return sourceRequestIdentity({ apiKey: "k", sourceId, columns: c.columns, ids: [ID], from: win.from, to: win.to, limit: c.limit, options }).requestHash;
  });
  assert.equal(new Set(hashes).size, 1, "all five OLI reports resolve to ONE identical request_hash for the shared slice");
});

test("2. one canonical source row carries ALL applicable owner memberships (two OLI reports, one export)", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const jobs = resolveJobs(shadowPlan([acct(ID)], ["buy-box-loss", "returns-leakage"]));
  const bbOli = jobs.filter((j) => j.requestKey === "buy-box-loss:oli-sales");
  const retOli = jobs.filter((j) => j.requestKey === "returns-leakage:oli-sales");
  const shared = bbOli.find((b) => retOli.some((r) => r.requestHash === b.requestHash));
  assert.ok(shared, "buy-box and returns share at least one canonical OLI slice hash");
  const r = await runSourceJobs({ store, dataDoe: dd, plannedJobs: jobs, ownerIds: ownerIdsOf(jobs), bucket: "us", cycleDate: CYCLE_DATE, sourceTranche: OLI() });
  assert.equal(store.listSourceJobs(r.cycleId).filter((j) => j.request_hash === shared.requestHash).length, 1, "ONE canonical source row for the shared slice");
  const owners = store._owners(r.cycleId).filter((m) => m.request_hash === shared.requestHash);
  assert.equal(owners.length, 2, "the one canonical row carries BOTH report-owner memberships");
  assert.deepEqual([...new Set(owners.map((m) => m.report_key))].sort(), ["buy-box-loss", "returns-leakage"]);
  assert.equal(dd.createCount(shared.requestHash), 1, "the shared canonical OLI export is created exactly once");
});

test("3. different seller accounts do NOT share OLI hashes (OLI is seller-scoped)", () => {
  const c = oliContract("returns-leakage", "returns-leakage:oli-sales");
  const options = { groupBy: c.groupBy || undefined, aggregations: c.aggregations || undefined, orderByColumn: c.orderByColumn, orderByDirection: c.orderByDirection };
  const idA = sourceRequestIdentity({ apiKey: "k", sourceId: OLI_SOURCE_ID(), columns: c.columns, ids: [ID], from: "2025-07-14", to: "2025-07-20", limit: c.limit, options });
  const idB = sourceRequestIdentity({ apiKey: "k", sourceId: OLI_SOURCE_ID(), columns: c.columns, ids: [ID2], from: "2025-07-14", to: "2025-07-20", limit: c.limit, options });
  assert.equal(idA.organizationFingerprint, idB.organizationFingerprint, "same api key => same organization fingerprint");
  assert.notEqual(idA.accountScopeHash, idB.accountScopeHash, "different seller ids => different account scope");
  assert.notEqual(idA.requestHash, idB.requestHash, "different accounts NEVER merge OLI request hashes");
});

test("4b. FIVE accounts BATCH into ONE canonical source row and retain FIVE separate account/report owners (Blocker 4b)", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const sellers = ["S1", "S2", "S3", "S4", "S5"];
  const accts = sellers.map((s, i) => ({ accountId: "ACC" + (i + 1), rawSellerId: s }));
  const c = oliContract("returns-leakage", "returns-leakage:oli-sales");
  const options = { groupBy: c.groupBy || undefined, aggregations: c.aggregations || undefined, orderByColumn: c.orderByColumn, orderByDirection: c.orderByDirection };
  const id = sourceRequestIdentity({ apiKey: "k", sourceId: OLI_SOURCE_ID(), columns: c.columns, ids: sellers, from: "2025-07-14", to: "2025-07-20", limit: c.limit, options });
  // The batch's resolved canonical source (one request_hash over the sorted batch seller ids).
  const resolvedBatch = {
    requestHash: id.requestHash, requestKey: "returns-leakage:oli-sales", sourceId: OLI_SOURCE_ID(), sourceKey: "order-line-items",
    organizationFingerprint: id.organizationFingerprint, accountScopeHash: id.accountScopeHash, requestMeta: id.requestMeta,
    bucket: "us", strict: true, limit: c.limit, from: "2025-07-14", to: "2025-07-20", options, sellerOrVendorIds: sellers,
  };
  const batchAccounts = accts.map((a) => ({ accountId: a.accountId, ownerAccountScopeHash: accountScopeHash([a.rawSellerId]) }));
  const jobs = plannedBatchSourceJobs("returns-leakage", resolvedBatch, "us", "primary", batchAccounts);
  assert.equal(jobs.length, 5, "five planned entries (one per account)");
  assert.equal(new Set(jobs.map((j) => j.requestHash)).size, 1, "all five share ONE canonical request_hash (the batch)");
  assert.equal(new Set(jobs.map((j) => j.owner.ownerId)).size, 5, "five DISTINCT owner ids (individual account scope, no collision)");
  const r = await runSourceJobs({ store, dataDoe: dd, plannedJobs: jobs, ownerIds: [...new Set(jobs.map((j) => j.owner.ownerId))], bucket: "us", cycleDate: CYCLE_DATE });
  const rows = store.listSourceJobs(r.cycleId).filter((j) => j.request_hash === id.requestHash);
  assert.equal(rows.length, 1, "exactly ONE canonical source row for the batch");
  assert.equal(rows[0].account_scope_hash, id.accountScopeHash, "the canonical row carries the BATCH scope");
  const owners = store._owners(r.cycleId).filter((m) => m.request_hash === id.requestHash);
  assert.equal(owners.length, 5, "FIVE owner memberships on the one canonical row");
  assert.equal(new Set(owners.map((m) => m.owner_id)).size, 5, "five distinct owner ids");
  assert.equal(new Set(owners.map((m) => m.account_id)).size, 5, "five distinct account ids");
  assert.equal(new Set(owners.map((m) => m.account_scope_hash)).size, 5, "five distinct INDIVIDUAL owner scopes");
  assert.ok(owners.every((m) => m.account_scope_hash !== id.accountScopeHash), "no owner uses the BATCH scope as its owner scope (Blocker 4b)");
  assert.equal(dd.createCount(id.requestHash), 1, "the shared batched OLI export is created EXACTLY once");
});

/* ============================= Part C: durable cache reuse ============================= */
group("Part C: confirmed-exact-match durable source-cache reuse");

test("4. a current EXACT durable cache entry => success with ZERO DataDoe create/poll/download; export_id null, create_export_count 0, attempted_at null, cache points at the entry", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const oli = oneOliJob(acct(ID));
  const rows = [ord("R1", "Widget", 100, 10, "USD", ASOF)];
  store._seedCache(oli.requestHash, {
    rows, source_id: oli.sourceId, organization_fingerprint: oli.organizationFingerprint, account_scope_hash: oli.accountScopeHash,
    object_path: "durable/exact/" + oli.requestHash + ".json", row_count: rows.length, payload_bytes: 123, expires_at: FUTURE_TTL(),
  });
  const r = await runSourceJobs({ store, dataDoe: dd, plannedJobs: [oli], ownerIds: [oli.owner.ownerId], bucket: "us", cycleDate: CYCLE_DATE });
  assert.equal(dd.totalCreates(), 0, "ZERO create POSTs");
  assert.equal(dd.totalPolls(), 0, "ZERO poll GETs");
  assert.equal(dd.totalDownloads(), 0, "ZERO download GETs");
  const jobRow = store._rawJob(r.cycleId, oli.requestHash);
  assert.equal(jobRow.fetch_status, "succeeded", "the source job succeeds from the durable cache");
  assert.equal(jobRow.create_export_count, 0, "create_export_count stays 0 (claim RPC untouched)");
  assert.equal(jobRow.attempted_at, null, "attempted_at stays null (claim RPC untouched)");
  assert.equal(jobRow.export_id, null, "no fabricated export id");
  assert.equal(jobRow.cache_object_path, "durable/exact/" + oli.requestHash + ".json", "points at the existing durable object");
  assert.equal(jobRow.row_count, rows.length);
  const outcome = r.outcomes.find((o) => o.requestHash === oli.requestHash);
  assert.equal(outcome.reused, true, "the outcome is flagged as a cache reuse");
  assert.equal(outcome.status, "success");
});

test("5. expired / mismatched (source_id or scope) / malformed (non-array) / cap-sized cache => NOT reused => exactly one create-export", async () => {
  const base = () => { const j = oneOliJob(acct(ID)); return j; };
  const rowsOk = [ord("R1", "Widget", 100, 10, "USD", ASOF)];
  const scenarios = {
    expired: (j) => ({ rows: rowsOk, source_id: j.sourceId, organization_fingerprint: j.organizationFingerprint, account_scope_hash: j.accountScopeHash, object_path: "p.json", row_count: 1, payload_bytes: 1, expires_at: PAST_TTL() }),
    "mismatched source_id": (j) => ({ rows: rowsOk, source_id: "WRONG-SOURCE", organization_fingerprint: j.organizationFingerprint, account_scope_hash: j.accountScopeHash, object_path: "p.json", row_count: 1, payload_bytes: 1, expires_at: FUTURE_TTL() }),
    "mismatched scope": (j) => ({ rows: rowsOk, source_id: j.sourceId, organization_fingerprint: j.organizationFingerprint, account_scope_hash: "WRONG-SCOPE", object_path: "p.json", row_count: 1, payload_bytes: 1, expires_at: FUTURE_TTL() }),
    "malformed non-array": (j) => ({ rows: "not-an-array", source_id: j.sourceId, organization_fingerprint: j.organizationFingerprint, account_scope_hash: j.accountScopeHash, object_path: "p.json", row_count: 1, payload_bytes: 1, expires_at: FUTURE_TTL() }),
    "cap-sized": (j) => { const capped = new Array(Number(j.limit)).fill(0).map(() => ({})); return { rows: capped, source_id: j.sourceId, organization_fingerprint: j.organizationFingerprint, account_scope_hash: j.accountScopeHash, object_path: "p.json", row_count: capped.length, payload_bytes: 1, expires_at: FUTURE_TTL() }; },
  };
  for (const [label, mk] of Object.entries(scenarios)) {
    const store = makeStore(); const dd = makeDataDoe();
    const oli = base();
    store._seedCache(oli.requestHash, mk(oli));
    const r = await runSourceJobs({ store, dataDoe: dd, plannedJobs: [oli], ownerIds: [oli.owner.ownerId], bucket: "us", cycleDate: CYCLE_DATE });
    assert.equal(dd.createCount(oli.requestHash), 1, label + ": NOT reused => exactly one create-export");
    const outcome = r.outcomes.find((o) => o.requestHash === oli.requestHash);
    assert.notEqual(outcome && outcome.reused, true, label + ": the outcome is never flagged reused");
    assert.equal(store._rawJob(r.cycleId, oli.requestHash).create_export_count, 1, label + ": one real claimed attempt");
  }
});

const seedExactCacheAndJob = (store, cid, oli, over = {}) => {
  const entry = { rows: [{ x: 1 }], source_id: oli.sourceId, organization_fingerprint: oli.organizationFingerprint, account_scope_hash: oli.accountScopeHash, object_path: "p.json", row_count: 1, payload_bytes: 10, expires_at: FUTURE_TTL(), ...over };
  store._seedCache(oli.requestHash, entry);
  store.upsertSourceJob({ cycleId: cid, requestHash: oli.requestHash, requestKey: oli.requestKey, sourceId: oli.sourceId, sourceKey: oli.sourceKey, connectionId: oli.connectionId, organizationFingerprint: oli.organizationFingerprint, accountScopeHash: oli.accountScopeHash });
  return entry;
};
const adoptExpect = (cid, oli, over = {}) => ({ cycleId: cid, requestHash: oli.requestHash, sourceId: oli.sourceId, organizationFingerprint: oli.organizationFingerprint, accountScopeHash: oli.accountScopeHash, objectPath: "p.json", rowCount: 1, payloadBytes: 10, ...over });

test("cas. cache-adopt CAS vs create-claim on the SAME pending row: exactly ONE winner, zero unnecessary POSTs (Blocker 2)", async () => {
  // Adopt-first: the reuse wins; a subsequent create-claim on the now-succeeded row is refused (zero POST).
  {
    const store = makeStore();
    const cid = store.openCycle({ bucket: "us", cycleDate: CYCLE_DATE }); store.claimCycle(cid);
    const oli = oneOliJob(acct(ID)); seedExactCacheAndJob(store, cid, oli);
    assert.equal(store.adoptSourceCache(adoptExpect(cid, oli)), "adopted", "adopt wins on the pending row");
    assert.equal(store.claimExportAttempt(cid, oli.requestHash), false, "the create-claim on the now-succeeded row is refused (zero POST)");
    const j = store._rawJob(cid, oli.requestHash);
    assert.equal(j.fetch_status, "succeeded"); assert.equal(j.create_export_count, 0); assert.equal(j.attempted_at, null); assert.equal(j.export_id, null);
  }
  // Claim-first: the create-claim wins; a subsequent cache-adopt is refused (no clobber of the in-flight export).
  {
    const store = makeStore();
    const cid = store.openCycle({ bucket: "us", cycleDate: CYCLE_DATE }); store.claimCycle(cid);
    const oli = oneOliJob(acct(ID)); seedExactCacheAndJob(store, cid, oli);
    assert.equal(store.claimExportAttempt(cid, oli.requestHash), true, "create-claim wins on the pending row");
    assert.equal(store.adoptSourceCache(adoptExpect(cid, oli)), "not-adopted", "cache-adopt on the now-attempted row is refused (no clobber)");
    const j = store._rawJob(cid, oli.requestHash);
    assert.equal(j.fetch_status, "attempted"); assert.equal(j.create_export_count, 1);
  }
});

test("cas-validate. adopt returns cache-changed on ANY identity/integrity mismatch and cache-expired past TTL (caller values are only expectations)", async () => {
  const store = makeStore();
  const cid = store.openCycle({ bucket: "us", cycleDate: CYCLE_DATE }); store.claimCycle(cid);
  const oli = oneOliJob(acct(ID)); seedExactCacheAndJob(store, cid, oli);
  // Each mismatched EXPECTATION is rejected against the actual locked cache row (models cache-pointer replacement).
  assert.equal(store.adoptSourceCache(adoptExpect(cid, oli, { objectPath: "REPLACED.json" })), "cache-changed", "object_path replaced => cache-changed");
  assert.equal(store.adoptSourceCache(adoptExpect(cid, oli, { rowCount: 999 })), "cache-changed", "row_count changed => cache-changed");
  assert.equal(store.adoptSourceCache(adoptExpect(cid, oli, { payloadBytes: 999 })), "cache-changed", "payload_bytes changed => cache-changed");
  assert.equal(store.adoptSourceCache(adoptExpect(cid, oli, { sourceId: "OTHER" })), "cache-changed", "source_id changed => cache-changed");
  assert.equal(store.adoptSourceCache(adoptExpect(cid, oli, { accountScopeHash: "OTHER" })), "cache-changed", "account scope changed => cache-changed");
  assert.equal(store._rawJob(cid, oli.requestHash).fetch_status, "pending", "no mismatch ever mutated the job");
  // Expired cache row.
  const store2 = makeStore();
  const cid2 = store2.openCycle({ bucket: "us", cycleDate: CYCLE_DATE }); store2.claimCycle(cid2);
  const oli2 = oneOliJob(acct(ID)); seedExactCacheAndJob(store2, cid2, oli2, { expires_at: PAST_TTL() });
  assert.equal(store2.adoptSourceCache(adoptExpect(cid2, oli2)), "cache-expired", "expired cache row => cache-expired");
  assert.equal(store2._rawJob(cid2, oli2.requestHash).fetch_status, "pending", "an expired row never mutates the job");
});

test("cas-failclosed. a store with cache evidence but a MISSING adopt CAS fails closed with ZERO creates (no non-CAS fallback)", async () => {
  const base = makeStore();
  const oli = oneOliJob(acct(ID));
  base._seedCache(oli.requestHash, { rows: [{ x: 1 }], source_id: oli.sourceId, organization_fingerprint: oli.organizationFingerprint, account_scope_hash: oli.accountScopeHash, object_path: "p.json", row_count: 1, payload_bytes: 10, expires_at: FUTURE_TTL() });
  const noCas = { ...base, adoptSourceCache: undefined }; // durable cache present, but the atomic CAS is unavailable
  const dd = makeDataDoe();
  const r = await runSourceJobs({ store: noCas, dataDoe: dd, plannedJobs: [oli], ownerIds: [oli.owner.ownerId], bucket: "us", cycleDate: CYCLE_DATE });
  assert.equal(dd.totalCreates(), 0, "ZERO create POSTs (never fabricate, never fall back to a non-CAS record-success)");
  const outcome = r.outcomes.find((o) => o.requestHash === oli.requestHash);
  assert.equal(outcome.code, "ADOPT_CAS_UNAVAILABLE", "fails closed with a typed ADOPT_CAS_UNAVAILABLE");
});

test("cas-malformed. a MALFORMED adopt acknowledgement fails closed with ZERO creates", async () => {
  const base = makeStore();
  const oli = oneOliJob(acct(ID));
  base._seedCache(oli.requestHash, { rows: [{ x: 1 }], source_id: oli.sourceId, organization_fingerprint: oli.organizationFingerprint, account_scope_hash: oli.accountScopeHash, object_path: "p.json", row_count: 1, payload_bytes: 10, expires_at: FUTURE_TTL() });
  const badAck = { ...base, adoptSourceCache: () => "totally-unexpected-value" };
  const dd = makeDataDoe();
  const r = await runSourceJobs({ store: badAck, dataDoe: dd, plannedJobs: [oli], ownerIds: [oli.owner.ownerId], bucket: "us", cycleDate: CYCLE_DATE });
  assert.equal(dd.totalCreates(), 0, "ZERO create POSTs on a malformed acknowledgement");
  const outcome = r.outcomes.find((o) => o.requestHash === oli.requestHash);
  assert.equal(outcome.code, "ADOPT_ACK_MALFORMED", "fails closed with a typed ADOPT_ACK_MALFORMED");
});

test("cas-changed-e2e. a cache-changed acknowledgement mid-adoption falls through to a fresh create (never fabricates)", async () => {
  const base = makeStore();
  const oli = oneOliJob(acct(ID));
  base._seedCache(oli.requestHash, { rows: [{ x: 1 }], source_id: oli.sourceId, organization_fingerprint: oli.organizationFingerprint, account_scope_hash: oli.accountScopeHash, object_path: "p.json", row_count: 1, payload_bytes: 10, expires_at: FUTURE_TTL() });
  // The cache the worker validated was replaced between its read and the CAS -> the RPC returns cache-changed.
  const replaced = { ...base, adoptSourceCache: () => "cache-changed" };
  const dd = makeDataDoe();
  const r = await runSourceJobs({ store: replaced, dataDoe: dd, plannedJobs: [oli], ownerIds: [oli.owner.ownerId], bucket: "us", cycleDate: CYCLE_DATE });
  assert.equal(dd.createCount(oli.requestHash), 1, "falls through to exactly one fresh create (the stale cache is not reused, never fabricated)");
  const outcome = r.outcomes.find((o) => o.requestHash === oli.requestHash);
  assert.notEqual(outcome && outcome.reused, true, "the outcome is never flagged reused");
});

test("reuseonly-miss. reuseOnly with NO durable cache creates ZERO exports, returns MISSING_REUSABLE_SOURCE, leaves the job pending (Blocker 3)", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const oli = oneOliJob(acct(ID));
  const r = await runSourceJobs({ store, dataDoe: dd, plannedJobs: [oli], ownerIds: [oli.owner.ownerId], bucket: "us", cycleDate: CYCLE_DATE, reuseOnly: true });
  assert.equal(dd.totalCreates(), 0, "ZERO create POSTs in reuseOnly rehearsal");
  const outcome = r.outcomes.find((o) => o.requestHash === oli.requestHash);
  assert.equal(outcome.code, "MISSING_REUSABLE_SOURCE", "typed missing-reusable-source outcome");
  assert.ok((r.missingReusable || 0) >= 1, "the pass counts a missing reusable source");
  assert.equal(store._rawJob(r.cycleId, oli.requestHash).fetch_status, "pending", "the job stays pending (blocked, never a POST, never falsely failed)");
  assert.equal(store._rawJob(r.cycleId, oli.requestHash).create_export_count, 0, "create_export_count stays 0");
});

test("reuseonly-hit. reuseOnly WITH a current exact durable cache adopts via the atomic CAS with ZERO exports (Blocker 3 + 2)", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const oli = oneOliJob(acct(ID));
  const rows = [ord("R1", "Widget", 100, 10, "USD", ASOF)];
  store._seedCache(oli.requestHash, { rows, source_id: oli.sourceId, organization_fingerprint: oli.organizationFingerprint, account_scope_hash: oli.accountScopeHash, object_path: "durable/" + oli.requestHash + ".json", row_count: rows.length, payload_bytes: 55, expires_at: FUTURE_TTL() });
  const r = await runSourceJobs({ store, dataDoe: dd, plannedJobs: [oli], ownerIds: [oli.owner.ownerId], bucket: "us", cycleDate: CYCLE_DATE, reuseOnly: true });
  assert.equal(dd.totalCreates(), 0, "ZERO create POSTs");
  const outcome = r.outcomes.find((o) => o.requestHash === oli.requestHash);
  assert.equal(outcome.reused, true, "reused via the atomic CAS even in reuseOnly");
  const j = store._rawJob(r.cycleId, oli.requestHash);
  assert.equal(j.fetch_status, "succeeded"); assert.equal(j.export_id, null); assert.equal(j.create_export_count, 0);
  assert.equal(j.cache_object_path, "durable/" + oli.requestHash + ".json", "points at the existing durable object");
});

/* ============================= Part D: existing export resume / no manual adoption ============================= */
group("Part D: existing export resume + manual-adoption rejection");

test("6. a persisted export_id (status attempted) => poll/download resume only, ZERO create POSTs", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const cid = store.openCycle({ bucket: "us", cycleDate: CYCLE_DATE }); store.claimCycle(cid);
  const oli = oneOliJob(acct(ID));
  store.upsertSourceJob({ cycleId: cid, requestHash: oli.requestHash, requestKey: oli.requestKey, sourceId: oli.sourceId, sourceKey: oli.sourceKey, connectionId: oli.connectionId, organizationFingerprint: oli.organizationFingerprint, accountScopeHash: oli.accountScopeHash });
  // Simulate a prior invocation that created + persisted the export id, then was interrupted before download.
  const row = store._rawJob(cid, oli.requestHash);
  row.fetch_status = "attempted"; row.attempted_at = "t"; row.create_export_count = 1; row.export_id = "exp-persisted";
  const r = await runSourceJobs({ store, dataDoe: dd, plannedJobs: [oli], ownerIds: [oli.owner.ownerId], bucket: "us", cycleDate: CYCLE_DATE });
  assert.equal(dd.totalCreates(), 0, "the persisted export is resumed with ZERO create POSTs");
  assert.ok(dd.pollCount(oli.requestHash) >= 1 && dd.downloadCount(oli.requestHash) >= 1, "resumed via poll + download only");
  const done = store._rawJob(r.cycleId, oli.requestHash);
  assert.equal(done.fetch_status, "succeeded");
  assert.equal(done.export_id, "exp-persisted", "resumed the EXACT persisted export id (never a new one)");
  assert.equal(done.create_export_count, 1, "still exactly one create-export ever");
});

test("7. a manual/UI export without a proven exact-identity durable entry is REJECTED (no reuse); a family not in the tranche stays pending", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const jobs = resolveJobs(shadowPlan([acct(ID)], ["returns-leakage"]));
  const oli = jobs.filter((j) => j.requestKey === "returns-leakage:oli-sales").pop();
  const settle = jobs.find((j) => j.requestKey === "returns-leakage:settlements");
  // A "manual/UI export" is modeled as a durable entry that does NOT match the exact canonical identity
  // (wrong source_id) -- exactly what a report-name/source-name-only match would produce. It must be rejected.
  store._seedCache(oli.requestHash, { rows: [ord("R1", "W", 1, 1, "USD", ASOF)], source_id: "manual-ui-export", organization_fingerprint: oli.organizationFingerprint, account_scope_hash: oli.accountScopeHash, object_path: "manual.json", row_count: 1, payload_bytes: 1, expires_at: FUTURE_TTL() });
  const r = await runSourceJobs({ store, dataDoe: dd, plannedJobs: jobs, ownerIds: ownerIdsOf(jobs), bucket: "us", cycleDate: CYCLE_DATE, sourceTranche: OLI() });
  const oliOutcome = r.outcomes.find((o) => o.requestHash === oli.requestHash);
  assert.notEqual(oliOutcome && oliOutcome.reused, true, "the manual/mismatched export is NOT adopted");
  assert.equal(dd.createCount(oli.requestHash), 1, "the real canonical export is created instead (manual export rejected)");
  // A settlements job (no durable entry, not in the OLI tranche) is upserted but stays pending -- never auto-adopted.
  assert.equal(store._rawJob(r.cycleId, settle.requestHash).fetch_status, "pending", "a family not in the tranche stays pending");
  assert.equal(dd.createCount(settle.requestHash), 0, "nothing is created or adopted for the un-tranched family");
});

/* ============================= Part A/B/E: tranche execution + resume ============================= */
group("tranche execution: OLI-only, multi-account, resume, derive-gating");

test("8. the OLI tranche executes ONLY order-line-items jobs across MULTIPLE accounts (non-OLI upserted but pending; zero non-OLI creates)", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const jobs = resolveJobs(shadowPlan([acct(ID), acct(ID2)], ["returns-leakage"]));
  const r = await runSourceJobs({ store, dataDoe: dd, plannedJobs: jobs, ownerIds: ownerIdsOf(jobs), bucket: "us", cycleDate: CYCLE_DATE, sourceTranche: OLI() });
  const rows = store.listSourceJobs(r.cycleId);
  const oliRows = rows.filter((j) => j.source_key === "order-line-items");
  const nonOli = rows.filter((j) => j.source_key !== "order-line-items");
  assert.ok(oliRows.length >= 2, "OLI jobs planned for BOTH accounts");
  assert.equal(new Set(oliRows.map((j) => j.account_scope_hash)).size, 2, "the two accounts have DISTINCT OLI scopes (never merged)");
  assert.ok(oliRows.every((j) => j.fetch_status === "succeeded"), "every OLI job (both accounts) executed to success");
  assert.ok(nonOli.length > 0 && nonOli.every((j) => j.fetch_status === "pending"), "every non-OLI family is upserted but left pending");
  assert.ok(nonOli.every((j) => dd.createCount(j.request_hash) === 0), "ZERO non-OLI create-exports");
  assert.equal(r.drained, false, "the filtered pass is NOT drained => continuation required for the next tranche");
});

test("9. the NEXT tranche (product-catalog) resumes the SAME bucket/cycleDate and creates NO duplicate export for already-succeeded OLI hashes", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const plan = shadowPlan([acct(ID)], ["returns-leakage"]);
  const r1 = await runGeneric(store, dd, plan, { sourceTranche: OLI() });
  const cid = r1.cycleId;
  const oliHashes = store.listSourceJobs(cid).filter((j) => j.source_key === "order-line-items").map((j) => j.request_hash);
  assert.ok(oliHashes.length > 0 && oliHashes.every((h) => dd.createCount(h) === 1), "each OLI hash created exactly once in tranche 1");
  const r2 = await runGeneric(store, dd, plan, { sourceTranche: CATALOG() });
  assert.equal(r2.cycleId, cid, "the next tranche resumes the SAME (bucket, cycle_date) cycle");
  oliHashes.forEach((h) => assert.equal(dd.createCount(h), 1, "NO duplicate export for an already-succeeded OLI hash"));
  const catRows = store.listSourceJobs(cid).filter((j) => j.source_key === "product-catalog");
  assert.ok(catRows.length > 0 && catRows.every((j) => j.fetch_status === "succeeded"), "the catalog family now succeeds");
  catRows.forEach((j) => assert.equal(dd.createCount(j.request_hash), 1, "the catalog export is created exactly once"));
});

test("10. a report stays PENDING until ALL deps succeed (a still-pending non-OLI dep does not derive after the OLI tranche)", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const plan = shadowPlan([acct(ID)], ["returns-leakage"]);
  const r = await runGeneric(store, dd, plan, { sourceTranche: OLI() });
  assert.ok(store.listSourceJobs(r.cycleId).some((j) => j.source_key !== "order-line-items" && j.fetch_status === "pending"), "at least one non-OLI dep is still pending");
  let saveCalls = 0;
  const saveSnapshot = async () => { saveCalls += 1; return { paramsHash: "ph" }; };
  const rj = await runReportJobs({ store, cycleId: r.cycleId, sourceRows: (h) => store.loadSourceRows(h), saveSnapshot, plannedReports: plan.reportRequests });
  assert.equal(rj.pending, 1, "the report is gated PENDING while a required non-OLI dep is unresolved");
  assert.equal(rj.succeeded, 0, "no derive");
  assert.equal(saveCalls, 0, "zero snapshot writes (nothing derived)");
  assert.equal(store.report("returns-leakage", ID).derive_status, "pending", "the report job stays pending");
});

test("11. a complete report derives ONCE; an unrelated report's failed dep preserves its LKG and does not block the complete one", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const plan = shadowPlan([acct(ID)], ["returns-leakage"]);
  const r = await runGeneric(store, dd, plan); // no tranche: every returns-leakage source succeeds
  assert.ok(store.listSourceJobs(r.cycleId).every((j) => j.fetch_status === "succeeded"), "all returns-leakage sources complete");
  // An UNRELATED report (buy-box-loss) with a genuinely FAILED dependency + a seeded last-known-good snapshot.
  const failedHash = "failed-dep-hash";
  store.upsertSourceJob({ cycleId: r.cycleId, requestHash: failedHash, requestKey: "buy-box-loss:oli-sales", sourceId: "s", sourceKey: "order-line-items", connectionId: "primary", organizationFingerprint: "org", accountScopeHash: "sch" });
  store.recordSourceFailure({ cycleId: r.cycleId, requestHash: failedHash, stage: "download", code: "HTTP_500", message: "x", terminal: false });
  store.seedSnapshot("buy-box-loss", ID, { lkg: true });
  const buyBoxStub = { reportKey: "buy-box-loss", accountId: ID, connectionId: "primary", bucket: "us", sources: [{ requestKey: "buy-box-loss:oli-sales", requestHash: failedHash }], context: { to: ASOF, rawSellerId: ID } };
  let saveCalls = 0;
  const saveSnapshot = async ({ reportKey, accountId, payload }) => { saveCalls += 1; store.seedSnapshot(reportKey, accountId, payload); return { paramsHash: "ph" }; };
  const plannedReports = [...plan.reportRequests, buyBoxStub];
  const rj = await runReportJobs({ store, cycleId: r.cycleId, sourceRows: (h) => store.loadSourceRows(h), saveSnapshot, plannedReports });
  assert.equal(rj.succeeded, 1, "the complete report derives");
  assert.equal(rj.blocked, 1, "the unrelated report is blocked by its failed dep");
  assert.equal(saveCalls, 1, "the complete report saved EXACTLY once");
  assert.deepEqual(store._snapshots.get("buy-box-loss|" + ID).payload, { lkg: true }, "the blocked report's LKG snapshot is preserved");
  assert.equal(store.report("returns-leakage", ID).derive_status, "succeeded");
  // Idempotent: a repeat derive re-derives nothing and never re-saves.
  const rj2 = await runReportJobs({ store, cycleId: r.cycleId, sourceRows: (h) => store.loadSourceRows(h), saveSnapshot, plannedReports });
  assert.equal(rj2.succeeded, 0, "the finished report is not re-derived");
  assert.equal(saveCalls, 1, "still exactly one save for the complete report");
});

test("12. a resumable deferral resumes safely across invocations: the OLI export is created EXACTLY once", async () => {
  const store = makeStore();
  const ddDefer = makeDataDoe({ deferKey: "oli-sales" }); // the first OLI poll defers (resumable), export_id already saved
  const plan = shadowPlan([acct(ID)], ["returns-leakage"]);
  const r1 = await runGeneric(store, ddDefer, plan, { sourceTranche: OLI() });
  assert.ok((r1.deferred || 0) > 0, "the driver surfaces the resumable deferral");
  const ddOk = makeDataDoe();
  const r2 = await runGeneric(store, ddOk, plan, { sourceTranche: OLI() });
  const oliRows = store.listSourceJobs(r2.cycleId).filter((j) => j.source_key === "order-line-items");
  oliRows.forEach((j) => assert.equal(ddDefer.createCount(j.request_hash) + ddOk.createCount(j.request_hash), 1, "each OLI export created exactly once across deferral + resume"));
  assert.ok(oliRows.every((j) => j.fetch_status === "succeeded"), "all OLI sources complete after the resume");
});

test("13. NO ownerless, cross-account, or cross-organization source job is produced by the tranche path", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const jobs = resolveJobs(shadowPlan([acct(ID), acct(ID2)], ["returns-leakage"]));
  const r = await runSourceJobs({ store, dataDoe: dd, plannedJobs: jobs, ownerIds: ownerIdsOf(jobs), bucket: "us", cycleDate: CYCLE_DATE, sourceTranche: OLI() });
  const rows = store.listSourceJobs(r.cycleId);
  const owners = store._owners(r.cycleId);
  for (const j of rows) {
    const mine = owners.filter((m) => m.request_hash === j.request_hash);
    assert.ok(mine.length >= 1, "every canonical source job carries at least one owner membership (never ownerless): " + j.request_key);
    // No membership crosses account/org: every owner on a hash shares that hash's org fingerprint + account scope,
    // and its owner_id is the RECOMPUTED deterministic id (so a buggy caller can never place a cross-account job).
    for (const m of mine) {
      assert.equal(m.organization_fingerprint, j.organization_fingerprint, "owner org fingerprint matches the canonical job (no cross-organization)");
      assert.equal(m.account_scope_hash, j.account_scope_hash, "owner account scope matches the canonical job (no cross-account)");
      const expected = sourceJobOwnerId({ reportKey: m.report_key, connectionId: m.connection_id, organizationFingerprint: m.organization_fingerprint, accountScopeHash: m.account_scope_hash });
      assert.equal(m.owner_id, expected, "owner_id is the recomputed account/org-safe id");
    }
  }
  // The two accounts stayed in disjoint scopes (never merged into one owner).
  assert.equal(new Set(owners.map((m) => m.account_scope_hash)).size, 2, "two accounts => two disjoint owner scopes");
});

async function main() {
  ({ runSourceJobs } = await import("../lib/server/sync/source-worker.js"));
  ({ runStagedSourceCycle, plannedSourceJob, plannedBatchSourceJobs } = await import("../lib/server/sync/source-sync-driver.js"));
  ({ runReportJobs } = await import("../lib/server/sync/report-worker.js"));
  ({ buildShadowReportPlan } = await import("../lib/server/sync/report-planner.js"));
  ({ REPORT_SOURCE_CONTRACTS } = await import("../lib/server/sync/report-source-contracts.js"));
  ({ sourceRequestIdentity, sourceJobOwnerId, accountScopeHash } = await import("../lib/server/source-identity.js"));
  ({ SOURCE_CONTRACTS } = await import("../lib/server/source-contracts.js"));
  ({ makeSourceTranche, SOURCE_TRANCHE_ORDER, isSourceTranche } = await import("../lib/server/sync/source-tranche.js"));
  ({ buildSchedulerV2SourceTrancheRuntime, buildSchedulerV2Runtime } = await import("../lib/server/sync/runtime-composition.js"));

  let failures = 0;
  for (const t of tests) {
    if (t.marker) { out("\n# " + t.marker); continue; }
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (err) { failures += 1; out("FAIL  " + t.name); out(String(err && err.stack ? err.stack : err)); }
  }
  out("\n" + passed + " assertions passed");
  return failures;
}

main().then((failures) => { if (failures) process.exitCode = 1; }).catch((err) => { out("FATAL " + String(err && err.stack ? err.stack : err)); process.exitCode = 1; });
