// Scheduler v2 -- Daily Reporting + Brand View PRIORITY RELEASE unit + integration regressions (offline).
//
//   P1  the DURABLE Catalog guard: ONLY product-catalog; at most ONE create for the whole OPERATION (identity =
//       operation_key alone); a DIFFERENT canonical hash for the same operation is hash-mismatch (zero create);
//       commit-unknown + concurrency are AMBIGUOUS (never a second create); exact export-id adoption spends zero.
//   P2  the frozen publication set is EXACTLY [daily-reporting, brand-sales, brand-inventory], brand-sales first.
//   P3  the bucket PLAN for all 30 covered accounts (8 US + 22 non-US) emits ZERO OLI/FBA jobs, ONE Catalog job.
//   P4  the release composition: deriveBucket takes ONLY the bucket (own deadline + own production preflight, no
//       caller scope); finalizeBucket INDEPENDENTLY reconstructs the durable scope (fresh discovery + cycle row +
//       reserved hash + org-scoped catalog job + accounts x 3 validated report jobs) and refuses everything else.
//   P5  Brand View inventory renders missing FBA as inventoryAvailable:false.
//   P6  the REAL publisher returns not-successful for all 3 before finalization and publishes all 3 after.
//   P7  the REAL buildAccountBrandSlice reads published brand-sales + brand-inventory and renders fresh sales,
//       inventory unavailable.
//   P8  the REAL supabase reservation wrappers validate every acknowledgement STRICTLY (mocked fetch).
//
// 7-bit ASCII, LF, no top-level await, synchronous writeSync progress, dynamic imports after a dummy env.

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

const OLI = "order-line-items";
const CATALOG = "product-catalog";
const FBA = "fba-inventory-health";
const ORG = "__organization";
const TODAY = "2026-08-20";
const ASOF = "2026-08-19";
const TS = "2026-08-19T10:00:00.000Z";

let priorityMod; let planMod; let brandView; let pubComposition; let reportStore; let supabaseMod; let releaseRunner; let publisherCore; let reportDerivation; let controlPkg; let cleanupMod;

/* ---- a FAITHFUL fake of the OPERATION-WIDE durable reservation table (PK = operation_key alone) ---- */
function makeFakeReservation() {
  const rows = new Map(); // operationKey -> { catalog_request_hash, export_id, status, tokens_spent }
  return {
    _rows: rows,
    reserve: async ({ operationKey, catalogRequestHash }) => {
      const r = rows.get(operationKey);
      if (r) {
        if (r.catalog_request_hash !== catalogRequestHash) return { disposition: "hash-mismatch", reservedHash: r.catalog_request_hash, requestedHash: catalogRequestHash, exportId: null, tokensSpent: 0 };
        return { disposition: "exists", exportId: r.export_id, status: r.status, tokensSpent: r.tokens_spent, catalogRequestHash };
      }
      rows.set(operationKey, { catalog_request_hash: catalogRequestHash, export_id: null, status: "reserved", tokens_spent: 0 });
      return { disposition: "reserved", exportId: null, status: "reserved", tokensSpent: 0, catalogRequestHash };
    },
    recordExport: async ({ operationKey, catalogRequestHash, exportId, tokens }) => {
      const r = rows.get(operationKey);
      if (!r) return { disposition: "not-reserved", exportId: null, tokensSpent: 0 };
      if (r.catalog_request_hash !== catalogRequestHash) return { disposition: "hash-mismatch", reservedHash: r.catalog_request_hash, exportId: null, tokensSpent: 0 };
      if (r.export_id != null) return r.export_id === exportId ? { disposition: "already-recorded", exportId: r.export_id, tokensSpent: 2, status: "created" } : { disposition: "conflict", exportId: r.export_id, tokensSpent: r.tokens_spent, status: r.status };
      r.export_id = exportId; r.status = "created"; r.tokens_spent = tokens;
      return { disposition: "recorded", exportId, tokensSpent: 2, status: "created" };
    },
    get: async ({ operationKey }) => { const r = rows.get(operationKey); return r ? { operationKey, catalogRequestHash: r.catalog_request_hash, exportId: r.export_id, tokensSpent: r.tokens_spent, status: r.status } : null; },
  };
}
function makeInner(created, opts = {}) {
  let n = 0;
  return {
    create: async (job) => { n += 1; created.push(job.sourceKey); if (opts.throwOnCreate) throw new Error("commit-unknown boom"); return { exportId: "e_" + n }; },
    poll: async () => "polled",
    download: async () => ["row"],
  };
}
const OP = () => priorityMod.PRIORITY_DASHBOARDS.operationKey;
const catJob = (hash) => ({ sourceKey: CATALOG, requestHash: hash || "cat-hash" });

/* ============================= P1. operation-wide durable Catalog guard ============================= */
group("P1. DURABLE Catalog guard: one create for the whole OPERATION; hash-mismatch / ambiguous / adoption");

test("P1a. winner creates once + records; a second guard sharing the operation ADOPTS (zero create), 2 tokens total", async () => {
  const reservation = makeFakeReservation();
  const c1 = []; const g1 = priorityMod.makeDurableCatalogGuard({ inner: makeInner(c1), reservation, operationKey: OP() });
  const r1 = await g1.create(catJob());
  assert.deepEqual(c1, [CATALOG]);
  const c2 = []; const g2 = priorityMod.makeDurableCatalogGuard({ inner: makeInner(c2), reservation, operationKey: OP() });
  const r2 = await g2.create(catJob());
  assert.equal(c2.length, 0, "second bucket created nothing (adopted)");
  assert.equal(r2.adopted, true);
  assert.equal(r2.exportId, r1.exportId);
  const row = await reservation.get({ operationKey: OP() });
  assert.equal(row.tokensSpent, 2);
});

test("P1b. ANY non-catalog create throws PRIORITY_FORBIDDEN_CREATE (never reaches adapter/reservation)", async () => {
  const created = []; const g = priorityMod.makeDurableCatalogGuard({ inner: makeInner(created), reservation: makeFakeReservation(), operationKey: OP() });
  for (const sk of [OLI, FBA, "ads-campaign-date", "settlements", ""]) await assert.rejects(() => g.create({ sourceKey: sk, requestHash: "h" }), (e) => /PRIORITY_FORBIDDEN_CREATE/.test(e.message));
  assert.equal(created.length, 0);
});

test("P1c. HASH-MISMATCH: a DIFFERENT canonical hash for the SAME operation is refused (zero create) -- the midnight/date-drift second export", async () => {
  const reservation = makeFakeReservation();
  const c1 = []; await priorityMod.makeDurableCatalogGuard({ inner: makeInner(c1), reservation, operationKey: OP() }).create(catJob("hash-day1"));
  const c2 = []; const g2 = priorityMod.makeDurableCatalogGuard({ inner: makeInner(c2), reservation, operationKey: OP() });
  await assert.rejects(() => g2.create(catJob("hash-day2")), (e) => /PRIORITY_CATALOG_HASH_MISMATCH/.test(e.message));
  assert.equal(c2.length, 0, "a different-hash create is never performed");
});

test("P1d. COMMIT-UNKNOWN: the winner's create throws -> reservation open -> a retry is AMBIGUOUS, never a second create", async () => {
  const reservation = makeFakeReservation();
  const c1 = []; await assert.rejects(() => priorityMod.makeDurableCatalogGuard({ inner: makeInner(c1, { throwOnCreate: true }), reservation, operationKey: OP() }).create(catJob()), (e) => /commit-unknown boom/.test(e.message));
  const c2 = []; await assert.rejects(() => priorityMod.makeDurableCatalogGuard({ inner: makeInner(c2), reservation, operationKey: OP() }).create(catJob()), (e) => /PRIORITY_CATALOG_RESERVATION_AMBIGUOUS/.test(e.message));
  assert.equal(c2.length, 0);
});

test("P1e. CONCURRENCY: a reservation already held (no export yet) makes a concurrent create AMBIGUOUS, never a second create", async () => {
  const reservation = makeFakeReservation();
  await reservation.reserve({ operationKey: OP(), catalogRequestHash: "cat-hash" });
  const created = []; await assert.rejects(() => priorityMod.makeDurableCatalogGuard({ inner: makeInner(created), reservation, operationKey: OP() }).create(catJob()), (e) => /PRIORITY_CATALOG_RESERVATION_AMBIGUOUS/.test(e.message));
  assert.equal(created.length, 0);
});

test("P1f. poll + download pass through; a hash-less Catalog job fails closed", async () => {
  const g = priorityMod.makeDurableCatalogGuard({ inner: makeInner([]), reservation: makeFakeReservation(), operationKey: OP() });
  assert.equal(await g.poll({}), "polled");
  assert.deepEqual(await g.download({}), ["row"]);
  const created = []; const g2 = priorityMod.makeDurableCatalogGuard({ inner: makeInner(created), reservation: makeFakeReservation(), operationKey: OP() });
  await assert.rejects(() => g2.create({ sourceKey: CATALOG, requestHash: "" }), (e) => /PRIORITY_CATALOG_HASH_MISSING/.test(e.message));
  assert.equal(created.length, 0);
});

/* ============================= P2. the frozen publication set (three reports) ============================= */
group("P2. publish allowlist + order: daily-reporting, brand-sales BEFORE brand-inventory");

test("P2a. the three priority reports are admitted; every other report is refused", () => {
  for (const rk of ["daily-reporting", "brand-sales", "brand-inventory"]) assert.equal(priorityMod.assertPriorityPublishReportKey(rk), rk);
  for (const rk of ["reconciliation", "keyword-rank", "content-changes", "listing-optimizer", "", "brand-inventory "]) assert.throws(() => priorityMod.assertPriorityPublishReportKey(rk), (e) => /PRIORITY_PUBLISH_FORBIDDEN/.test(e.message));
});

test("P2b. frozen scope constants are exactly the reviewed values; brand-sales precedes brand-inventory", () => {
  const C = priorityMod.PRIORITY_DASHBOARDS;
  assert.deepEqual([...C.reportKeys], ["daily-reporting", "brand-sales", "brand-inventory"]);
  assert.deepEqual([...C.publishOrder], ["daily-reporting", "brand-sales", "brand-inventory"]);
  assert.ok(C.publishOrder.indexOf("brand-sales") < C.publishOrder.indexOf("brand-inventory"));
  assert.deepEqual([...C.buckets], ["us", "non-us"]);
  assert.equal(C.catalogSourceKey, CATALOG); assert.equal(C.maxCatalogCreates, 1); assert.equal(C.maxTokens, 2);
  assert.ok(typeof C.operationKey === "string" && C.operationKey.length > 0);
  assert.ok(Object.isFrozen(C));
});
test("P2c. the operation is versioned to priority-dashboards/v2 (a DISTINCT reservation key -- the failed v1 reservation is never touched); the guard + composition key on it", async () => {
  assert.equal(priorityMod.PRIORITY_DASHBOARDS.operationKey, "priority-dashboards/v2");
  assert.notEqual(priorityMod.PRIORITY_DASHBOARDS.operationKey, "priority-dashboards/v1", "v2 is a different operation key than the rejected v1");
  // The durable guard reserves/records/gets against THIS (v2) operation key ONLY: a fresh reservation table has
  // no v2 row until v2 creates one, and the v1 row (a different key) is a separate, untouched record.
  const reservation = makeFakeReservation();
  const created = []; const g = priorityMod.makeDurableCatalogGuard({ inner: makeInner(created), reservation, operationKey: OP() });
  await g.create(catJob());
  assert.ok(reservation._rows.has("priority-dashboards/v2"), "the guard keyed the reservation on v2");
  assert.ok(!reservation._rows.has("priority-dashboards/v1"), "the guard NEVER touches the v1 reservation");
});

/* ===================== P3. the bucket PLAN emits zero OLI/FBA jobs, one Catalog job ===================== */
group("P3. plan for all 30 covered accounts: zero OLI/FBA exports, one org-scoped Catalog export per bucket");

function accountsFor(bucket, n) {
  const cc = bucket === "us" ? "US" : "DE";
  return Array.from({ length: n }, (_, i) => ({ accountId: bucket + "-A" + String(i + 1).padStart(2, "0"), rawSellerId: bucket + "-S" + String(i + 1).padStart(2, "0"), country: cc, currency: "USD" }));
}
const CARRIER = "carrier-seller-01"; // a canonical primary seller id (identical across buckets)
function planPriorityBucket(bucket, n) {
  const pausedSources = new Set([OLI, FBA, "ads-campaign-date", "ads-asin-date", "settlements", "returns", "listings"]);
  const accounts = accountsFor(bucket, n); const coverageByAccountId = {};
  for (const a of accounts) coverageByAccountId[a.accountId] = [{ from: "2025-01-01", to: TODAY }];
  return planMod.planBucketSourceSync({ apiKey: "prim-key", bucket, accounts, existingMembership: new Map(), coverageByAccountId, catalogSnapshot: null, fbaSnapshotsByAccount: {}, pausedSources, asOf: ASOF, today: TODAY, catalogCarrierSeller: CARRIER, forceCatalogRefresh: true });
}
test("P3a. US bucket (8): ZERO OLI + ZERO FBA jobs, EXACTLY one Catalog job", () => { const jf = planPriorityBucket("us", 8).summary.plannedJobsByFamily; assert.equal(jf[OLI] || 0, 0); assert.equal(jf[FBA] || 0, 0); assert.equal(jf[CATALOG], 1); });
test("P3b. Non-US bucket (22): ZERO OLI + ZERO FBA jobs, EXACTLY one Catalog job", () => { const jf = planPriorityBucket("non-us", 22).summary.plannedJobsByFamily; assert.equal(jf[OLI] || 0, 0); assert.equal(jf[FBA] || 0, 0); assert.equal(jf[CATALOG], 1); });
test("P3c. WITHOUT the priority pauses a normal plan WOULD create OLI + FBA (the cost the path avoids)", () => {
  const accounts = accountsFor("us", 8); const coverageByAccountId = {};
  for (const a of accounts) coverageByAccountId[a.accountId] = [];
  const jf = planMod.planBucketSourceSync({ apiKey: "prim-key", bucket: "us", accounts, existingMembership: new Map(), coverageByAccountId, catalogSnapshot: null, fbaSnapshotsByAccount: {}, pausedSources: new Set(), asOf: ASOF, today: TODAY, catalogCarrierSeller: CARRIER }).summary.plannedJobsByFamily;
  assert.ok((jf[OLI] || 0) > 0); assert.ok((jf[FBA] || 0) > 0);
});
// The corrected org-wide Catalog request (mission items 1-4, 6-7, 10).
function catalogJobOf(bucket, n) {
  const fam = planPriorityBucket(bucket, n).families.find((f) => f.sourceKey === CATALOG);
  return fam.plannedJobs[0];
}
test("P3d. the Catalog request sends EXACTLY one carrier seller, OMITS from/to, and requests ONLY the four supported columns (no sku)", () => {
  const req = planMod.resolvedDurableCatalog({ apiKey: "prim-key", carrierSellerId: CARRIER, bucket: "us" });
  assert.deepEqual(req.sellerOrVendorIds, [CARRIER], "exactly one carrier seller");
  assert.equal(req.from, null); assert.equal(req.to, null);
  assert.deepEqual([...req.columns], ["child_asin", "parent_asin", "product_name", "product_brand"]);
  assert.ok(!req.columns.includes("sku"), "no unproven sku column");
  assert.equal(req.options.orderByColumn, "child_asin"); assert.equal(req.options.orderByDirection, "ASC");
  assert.equal(req.sourceScope, "organization"); assert.equal(req.limit, 20000);
  assert.equal(req.sourceId, "68d2de238e");
});
test("P3e. US and Non-US produce the SAME carrier + the SAME canonical Catalog request hash (organization-scoped)", () => {
  const us = planMod.resolvedDurableCatalog({ apiKey: "prim-key", carrierSellerId: CARRIER, bucket: "us" });
  const nonus = planMod.resolvedDurableCatalog({ apiKey: "prim-key", carrierSellerId: CARRIER, bucket: "non-us" });
  assert.equal(us.requestHash, nonus.requestHash, "one canonical hash across both buckets");
  assert.equal(catalogJobOf("us", 8).requestHash, catalogJobOf("non-us", 22).requestHash, "the planned catalog job hash matches across buckets");
});
test("P3f. adding accounts does NOT change the Catalog request identity (still ONE org-scoped request)", () => {
  assert.equal(catalogJobOf("us", 3).requestHash, catalogJobOf("us", 8).requestHash, "more accounts => same one catalog hash");
  assert.equal(planPriorityBucket("us", 20).families.find((f) => f.sourceKey === CATALOG).plannedJobs.length, 1, "exactly one catalog job regardless of account count");
});
test("P3g. selectCatalogCarrierSeller is deterministic, primary-only, and null when no canonical primary exists", () => {
  const dir = [{ accountId: "S-03" }, { accountId: "S-01" }, { accountId: "dd-secondary:X" }, { accountId: "S-02" }, { accountId: "" }];
  assert.equal(planMod.selectCatalogCarrierSeller(dir), "S-01", "deterministic sorted-first primary");
  assert.equal(planMod.selectCatalogCarrierSeller([{ accountId: "dd-secondary:A" }, { accountId: "" }]), null, "no canonical primary => null");
  // US + Non-US directories are the SAME full primary set, so the carrier is identical.
  assert.equal(planMod.selectCatalogCarrierSeller(dir), planMod.selectCatalogCarrierSeller([...dir].reverse()), "order-independent");
});
test("P3h. a missing / secondary / noncanonical carrier FAILS CLOSED before any reservation/create", () => {
  for (const bad of [undefined, null, "", "  ", "dd-secondary:S1"]) {
    assert.throws(() => planMod.resolvedDurableCatalog({ apiKey: "prim-key", carrierSellerId: bad, bucket: "us" }), /canonical primary carrier/);
  }
  // and the planner refuses to plan a Catalog without a carrier (fail closed at plan time).
  assert.throws(() => planMod.planBucketSourceSync({ apiKey: "prim-key", bucket: "us", accounts: accountsFor("us", 2), existingMembership: new Map(), coverageByAccountId: {}, catalogSnapshot: null, fbaSnapshotsByAccount: {}, pausedSources: new Set([OLI, FBA, "ads-campaign-date", "ads-asin-date", "settlements", "returns", "listings"]), asOf: ASOF, today: TODAY, forceCatalogRefresh: true }), /canonical primary carrier/);
});

/* ===================== P4. the release composition (no caller-forgeable scope) ===================== */
group("P4. release composition: deriveBucket(bucket) only; finalizeBucket independently reconstructs scope");

const CAT_JOB_COLD = [{ source_key: CATALOG, request_hash: "cat-hash", fetch_status: "succeeded", create_export_count: 1, export_id: "e1" }];
const CAT_JOB_WARM = [{ source_key: CATALOG, request_hash: "cat-hash", fetch_status: "succeeded", create_export_count: 0, cache_object_path: "source-cache/v2/cat-hash.json" }];
const XBUCKET_RESV = { catalog_request_hash: "cat-hash", export_id: "e1", status: "created", tokens_spent: 2 };
const CAT_OWNERS_OK = [{ request_hash: "cat-hash", account_id: ORG }];
function repJobsFor(accts, over = {}) {
  const jobs = [];
  for (const a of accts) for (const rk of ["daily-reporting", "brand-sales", "brand-inventory"]) jobs.push({ report_key: rk, account_id: a, validated: true, derive_status: "succeeded", save_status: "succeeded", snapshot_params_hash: "h_" + rk });
  return over.mutate ? over.mutate(jobs) : jobs;
}
function makeRelease(over = {}) {
  const reservation = over.reservation || makeFakeReservation();
  if (over.reservationRow) reservation._rows.set(OP(), over.reservationRow);
  else if (over.reservedHash) reservation._rows.set(OP(), { catalog_request_hash: over.reservedHash, export_id: "e1", status: "created", tokens_spent: 2 });
  return priorityMod.buildPriorityDashboardsRelease({
    buildRuntime: over.buildRuntime || (() => ({ makeDeadline: () => ({}), preflightEvidence: async () => ({ accounts: over.accounts || [], today: over.today || TODAY }), run: async () => ({}) })),
    makeInnerAdapter: over.makeInnerAdapter || (() => makeInner([])),
    buildPublisher: over.buildPublisher || (() => ({ publish: async () => ({ disposition: "published" }) })),
    reservation,
    makeStore: over.makeStore || (() => ({ listSourceJobs: async () => over.srcJobs || [], listCycleOwners: async () => over.owners || [], finalizeCycle: async () => over.finalizeResp || {} })),
    listReportJobs: over.listReportJobs || (async () => over.repJobs || []),
    getCycleByBucketDate: over.getCycleByBucketDate || (async () => over.cycle || null),
  });
}

test("P4a. deriveBucket accepts ONLY the bucket, runs its OWN deadline+preflight, and installs the catalog-only guard (priority build-time)", async () => {
  let captured = null; const runCalls = []; let pfCalls = 0;
  const rel = makeRelease({ buildRuntime: (o) => { captured = o; return { makeDeadline: () => ({}), preflightEvidence: async (a) => { pfCalls += 1; return { bucket: a.bucket, accounts: [], today: TODAY }; }, run: async (a) => { runCalls.push(a); return { cycleId: "cyc", derived: { skipped: null } }; } }; } });
  await rel.deriveBucket("us");
  assert.equal(captured.priorityMode, true, "priorityMode bound at build");
  assert.equal(pfCalls, 1, "deriveBucket ran its OWN preflight");
  assert.equal(runCalls[0].bucket, "us");
  assert.ok(!("priority" in runCalls[0]), "run() received NO priority argument (priority is build-time)");
  const guarded = captured.makeAdapter({});
  await assert.rejects(() => guarded.create({ sourceKey: OLI, requestHash: "h" }), (e) => /PRIORITY_FORBIDDEN_CREATE/.test(e.message));
  await assert.rejects(() => rel.deriveBucket("europe"), (e) => /bucket in us\|non-us/.test(e.message));
});

const finBase = { accounts: [{ accountId: "A01" }], today: TODAY, cycle: { id: "cyc", bucket: "us", status: "running", trigger: "manual" }, owners: CAT_OWNERS_OK, repJobs: repJobsFor(["A01"]), finalizeResp: { disposition: "finalized", cycle: { status: "succeeded" } } };

test("P4b. COLD finalize ACCEPTS: create_export_count=1 + the EXACT created reservation (hash/export/2 tokens)", async () => {
  const res = await makeRelease({ ...finBase, srcJobs: CAT_JOB_COLD, reservedHash: "cat-hash" }).finalizeBucket("us");
  assert.equal(res.disposition, "finalized"); assert.deepEqual(res.accounts, ["A01"]);
});
test("P4b2. WARM-CACHE-FIRST finalize ACCEPTS: create_export_count=0 + cache evidence + NO reservation (zero tokens)", async () => {
  const res = await makeRelease({ ...finBase, srcJobs: CAT_JOB_WARM }).finalizeBucket("us"); // no reservedHash -> no reservation
  assert.equal(res.disposition, "finalized");
});
test("P4b3. RETRY: create_export_count=1 with an already-created reservation still ACCEPTS (idempotent)", async () => {
  const res = await makeRelease({ ...finBase, srcJobs: CAT_JOB_COLD, reservationRow: { catalog_request_hash: "cat-hash", export_id: "e1", status: "created", tokens_spent: 2 } }).finalizeBucket("us");
  assert.equal(res.disposition, "finalized");
});
test("P4b4. CROSS-BUCKET WARM finalize ACCEPTS: create_export_count=0 + cache evidence + the OTHER bucket's EXACT created reservation (zero new tokens)", async () => {
  const res = await makeRelease({ ...finBase, srcJobs: CAT_JOB_WARM, reservationRow: XBUCKET_RESV }).finalizeBucket("us");
  assert.equal(res.disposition, "finalized");
});

test("P4c. finalizeBucket REFUSES every unrelated / open / malformed / mis-scoped / ambiguous-token condition", async () => {
  const base = { ...finBase, srcJobs: CAT_JOB_COLD, reservedHash: "cat-hash" };
  const cases = [
    ["no discovered accounts", { accounts: [] }, "no-discovered-accounts"],
    ["cycle not found", { cycle: null }, "cycle-not-found"],
    ["cycle bucket mismatch", { cycle: { id: "cyc", bucket: "non-us", status: "running", trigger: "manual" } }, "cycle-bucket-mismatch"],
    ["cycle not running", { cycle: { id: "cyc", bucket: "us", status: "pending", trigger: "manual" } }, "cycle-not-running"],
    ["cycle not manual", { cycle: { id: "cyc", bucket: "us", status: "running", trigger: "scheduled" } }, "cycle-not-manual"],
    ["source job count != 1", { srcJobs: CAT_JOB_COLD.concat(CAT_JOB_COLD) }, "source-job-count"],
    ["source not catalog", { srcJobs: [{ source_key: OLI, request_hash: "cat-hash", fetch_status: "succeeded", create_export_count: 1 }] }, "source-job-not-catalog"],
    ["source not succeeded", { srcJobs: [{ source_key: CATALOG, request_hash: "cat-hash", fetch_status: "pending", create_export_count: 1 }] }, "source-job-not-succeeded"],
    ["catalog not org scope", { owners: [{ request_hash: "cat-hash", account_id: "A01" }] }, "catalog-not-org-scope"],
    // COLD (create_export_count=1) token/reservation coherence:
    ["cold but no reservation", { reservedHash: null }, "no-reservation-for-create"],
    ["cold but reservation still 'reserved'", { reservationRow: { catalog_request_hash: "cat-hash", export_id: null, status: "reserved", tokens_spent: 0 } }, "reservation-not-created"],
    ["cold but reservation hash != job hash", { reservationRow: { catalog_request_hash: "other-hash", export_id: "e1", status: "created", tokens_spent: 2 } }, "reservation-hash-mismatch"],
    ["cold but blank export id", { reservationRow: { catalog_request_hash: "cat-hash", export_id: "", status: "created", tokens_spent: 2 } }, "reservation-no-export"],
    ["cold but tokens != 2", { reservationRow: { catalog_request_hash: "cat-hash", export_id: "e1", status: "created", tokens_spent: 5 } }, "reservation-tokens"],
    ["cold but reservation export != the job's created export", { reservationRow: { catalog_request_hash: "cat-hash", export_id: "eX", status: "created", tokens_spent: 2 } }, "reservation-export-mismatch"],
    // WARM (create_export_count=0) cross-bucket reservation coherence:
    ["warm but no cache evidence", { srcJobs: [{ source_key: CATALOG, request_hash: "cat-hash", fetch_status: "succeeded", create_export_count: 0 }], reservedHash: null }, "no-cache-evidence"],
    ["warm cross-bucket but reservation still 'reserved'", { srcJobs: CAT_JOB_WARM, reservationRow: { catalog_request_hash: "cat-hash", export_id: null, status: "reserved", tokens_spent: 0 } }, "reservation-not-created"],
    ["warm cross-bucket but reservation hash != job hash", { srcJobs: CAT_JOB_WARM, reservationRow: { catalog_request_hash: "other-hash", export_id: "e1", status: "created", tokens_spent: 2 } }, "reservation-hash-mismatch"],
    ["warm cross-bucket but blank export id", { srcJobs: CAT_JOB_WARM, reservationRow: { catalog_request_hash: "cat-hash", export_id: "", status: "created", tokens_spent: 2 } }, "reservation-no-export"],
    ["warm cross-bucket but tokens != 2", { srcJobs: CAT_JOB_WARM, reservationRow: { catalog_request_hash: "cat-hash", export_id: "e1", status: "created", tokens_spent: 5 } }, "reservation-tokens"],
    ["impossible create_export_count", { srcJobs: [{ source_key: CATALOG, request_hash: "cat-hash", fetch_status: "succeeded", create_export_count: 2 }], reservationRow: { catalog_request_hash: "cat-hash", export_id: "e1", status: "created", tokens_spent: 2 } }, "bad-create-count"],
    // report-job scope:
    ["unrelated report job", { repJobs: repJobsFor(["A01"]).concat([{ report_key: "keyword-rank", account_id: "A01", validated: true, derive_status: "succeeded", save_status: "succeeded", snapshot_params_hash: "h" }]) }, "unrelated-report-job"],
    ["unexpected account", { repJobs: repJobsFor(["A02"]) }, "unexpected-account-report-job"],
    ["duplicate report job", { repJobs: repJobsFor(["A01"]).concat(repJobsFor(["A01"]).slice(0, 1)) }, "duplicate-report-job"],
    ["report not validated", { repJobs: repJobsFor(["A01"], { mutate: (j) => { j[0].validated = false; return j; } }) }, "report-job-not-validated"],
    ["missing report job (short count)", { repJobs: repJobsFor(["A01"]).filter((j) => j.report_key !== "brand-sales") }, "report-job-count"],
    ["finalize open-work", { finalizeResp: { disposition: "open-work", cycle: { status: "running" } } }, "open-work"],
    ["finalize not-found", { finalizeResp: { disposition: "not-found" } }, "finalize-not-found"],
  ];
  for (const [name, over, reason] of cases) {
    const patch = { ...base, ...over };
    if ("reservationRow" in over) delete patch.reservedHash; // an explicit row overrides the default seed
    const res = await makeRelease(patch).finalizeBucket("us");
    assert.equal(res.disposition, "refused", name + " must be refused (got " + JSON.stringify(res) + ")");
    assert.equal(res.reason, reason, name + " reason");
  }
});

test("P4d. publishAccount publishes daily-reporting, brand-sales, brand-inventory (brand-sales first), carrying each pair's live identity", async () => {
  const pubCalls = [];
  const rel = makeRelease({ buildPublisher: () => ({ publish: async (rk, a) => { pubCalls.push(rk); return { disposition: "published", liveReportKey: rk, paramsHash: "ph_" + rk + "_" + a }; } }) });
  const outp = await rel.publishAccount("A01");
  assert.deepEqual(pubCalls, ["daily-reporting", "brand-sales", "brand-inventory"]);
  assert.ok(pubCalls.indexOf("brand-sales") < pubCalls.indexOf("brand-inventory"));
  assert.equal(outp.results.length, 3);
  for (const r of outp.results) { assert.equal(r.liveReportKey, r.reportKey); assert.equal(r.paramsHash, "ph_" + r.reportKey + "_A01"); }
});

test("P4e. preflightAccount runs the SHARED publisher preflight for all 3 keys, carrying the live identity; a non-ready pair surfaces", async () => {
  const pfCalls = [];
  const rel = makeRelease({ buildPublisher: () => ({ publish: async () => ({ disposition: "published" }), preflight: async (rk, a) => { pfCalls.push(rk); return { disposition: rk === "brand-inventory" ? "report-disabled" : "ready", liveReportKey: rk, paramsHash: "ph_" + rk + "_" + a }; } }) });
  const outp = await rel.preflightAccount("A01");
  assert.deepEqual(pfCalls.sort(), ["brand-inventory", "brand-sales", "daily-reporting"]);
  assert.equal(outp.results.filter((r) => r.disposition === "ready").length, 2);
  assert.equal(outp.results.find((r) => r.reportKey === "brand-inventory").disposition, "report-disabled");
});

/* ===================== P5. Brand View inventory renders missing FBA as unavailable ===================== */
group("P5. Brand View inventory contract: missing FBA => inventoryAvailable:false");
test("P5a. buildBrandInventoryPayload with empty rows yields inventoryAvailable:false, null date, empty table", () => {
  const payload = brandView.buildBrandInventoryPayload({ accountId: "A01", invRows: [], brandByAsin: new Map([["B0A", "Acme"]]), accountCountry: "US", from: "2026-06-01", to: ASOF, rowLimit: 100000 });
  assert.equal(payload.inventoryAvailable, false); assert.equal(payload.inventoryDate, null); assert.deepEqual(payload.inventoryByBrandCountry, []);
});

/* ===================== P6. the REAL publisher: not-successful before finalization, published after ===================== */
group("P6. real publisher terminal-cycle gate: all 3 refused before finalization, all 3 pass after");
const SPECS = {
  "daily-reporting": { version: "daily-reporting/v2d-3", params: { reportVersion: "daily-reporting/v2d-3", accountId: "A01", from: "2026-03-19", to: ASOF, brand: "ALL" }, payload: { rows: [], brandFiltered: false, adsAvailability: { status: "unavailable" } } },
  "brand-sales": { version: "brand-sales/v2d-2", params: { reportVersion: "brand-sales/v2d-2", accountId: "A01", from: "2025-01-01", to: ASOF }, payload: { rows: [], catalogBrands: [], asinBrand: { B0A: "Acme" } } },
  "brand-inventory": { version: "brand-inventory-shared-v1", params: { reportVersion: "brand-inventory-shared-v1", accountId: "A01", to: ASOF }, payload: { inventoryByBrandCountry: [], inventoryDate: null, inventoryAvailable: false } },
};
function hashFor(rk) { return reportStore.paramsHashFor(SPECS[rk].version, SPECS[rk].params); }
function realPublisher(cycleStatus) {
  return pubComposition.buildSchedulerV2Publisher({
    connections: [{ id: "primary", apiKey: "k", accountPrefix: "" }],
    fetchAccounts: async () => [{ id: "A01", name: "A01", country: "US", currency: "USD", status: "active" }],
    getAccountRollout: async () => ({ read: "ok", allPrimary: false, enabledAccountIds: ["A01"] }),
    getSettings: async () => [{ report_key: "daily-reporting", schedule_enabled: true }, { report_key: "brand-sales", schedule_enabled: true }],
    getPromotedSettings: async () => [{ report_key: "brand-inventory", publish_enabled: true }],
    getApproval: async () => ({ read: "ok", approved: true }),
    getJob: async (rk) => ({ cycle_id: "cyc", validated: true, snapshot_params_hash: hashFor(rk), derive_status: "succeeded", save_status: "succeeded", cycle_status: cycleStatus }),
    getSnapshot: async ({ reportKey }) => { const rk = reportKey.replace("scheduler-v2/", ""); return { params_hash: hashFor(rk), params: SPECS[rk].params, payload: SPECS[rk].payload, payload_storage_path: null, source_refreshed_at: TS }; },
    publishLive: async () => ({ outcome: "inserted" }),
  });
}
function releaseWithPublisher(pub) {
  return priorityMod.buildPriorityDashboardsRelease({ buildRuntime: () => ({ makeDeadline: () => ({}), preflightEvidence: async () => ({}), run: async () => ({}) }), makeInnerAdapter: () => makeInner([]), buildPublisher: () => pub, reservation: makeFakeReservation(), makeStore: () => ({ listSourceJobs: async () => [], listCycleOwners: async () => [], finalizeCycle: async () => ({}) }), listReportJobs: async () => [], getCycleByBucketDate: async () => null });
}
test("P6a. BEFORE finalization (cycle running) the real publisher returns not-successful for ALL THREE", async () => {
  const outp = await releaseWithPublisher(realPublisher("running")).publishAccount("A01");
  assert.equal(outp.results.length, 3);
  for (const r of outp.results) assert.equal(r.disposition, "not-successful", r.reportKey);
});
test("P6b. AFTER a terminal cycle the real publisher PUBLISHES all three (carrying live identity)", async () => {
  const outp = await releaseWithPublisher(realPublisher("succeeded")).publishAccount("A01");
  assert.deepEqual(outp.results.map((r) => r.reportKey), ["daily-reporting", "brand-sales", "brand-inventory"]);
  for (const r of outp.results) { assert.equal(r.disposition, "published", r.reportKey); assert.ok(r.liveReportKey && r.paramsHash, r.reportKey + " live identity"); }
});
test("P6c. the SHARED preflight (same collaborators) returns not-successful for ALL THREE before finalization -- zero writes", async () => {
  let writes = 0;
  const pub = realPublisher("running"); const orig = pub.publish;
  const traced = Object.freeze({ preflight: pub.preflight, publish: async (rk, a) => { writes += 1; return orig(rk, a); } });
  const outp = await releaseWithPublisher(traced).preflightAccount("A01");
  assert.equal(outp.results.length, 3);
  for (const r of outp.results) assert.equal(r.disposition, "not-successful", r.reportKey);
  assert.equal(writes, 0, "the preflight performed NO publish (read-only)");
});
test("P6d. the SHARED preflight returns 'ready' + the exact live identity for ALL THREE after a terminal cycle", async () => {
  const outp = await releaseWithPublisher(realPublisher("succeeded")).preflightAccount("A01");
  assert.equal(outp.results.length, 3);
  for (const r of outp.results) { assert.equal(r.disposition, "ready", r.reportKey); assert.equal(r.liveReportKey, r.reportKey); assert.ok(typeof r.paramsHash === "string" && r.paramsHash.length > 0, r.reportKey + " live paramsHash"); }
  // the preflight's live paramsHash EQUALS what the real publish would use (same live identity).
  const pubOut = await releaseWithPublisher(realPublisher("succeeded")).publishAccount("A01");
  const byKey = new Map(pubOut.results.map((r) => [r.reportKey, r.paramsHash]));
  for (const r of outp.results) assert.equal(r.paramsHash, byKey.get(r.reportKey), r.reportKey + " preflight hash == publish hash");
});

/* ===================== P7. buildAccountBrandSlice reads published brand-sales + brand-inventory ===================== */
group("P7. Brand View slice reads fresh brand-sales + brand-inventory; fresh sales, inventory unavailable");
test("P7a. the REAL buildAccountBrandSlice renders fresh sales from published brand-sales and inventory unavailable from an empty compact brand-inventory", async () => {
  const brandSalesPayload = { rows: [{ date: "2026-07-27", marketplace_country_code: "US", currency: "USD", product_brand: "Acme", total_sales: 210, total_units_sold: 21 }], catalogBrands: ["Acme"], asinBrand: { B0A: "Acme" } };
  const compactInventory = { params: { reportVersion: "brand-inventory-shared-v1" }, payload: { inventoryByBrandCountry: [], inventoryDate: null, inventoryAvailable: false }, source_refreshed_at: TS };
  const getSnapshot = async ({ reportKey }) => { if (reportKey === "brand-sales") return { params: SPECS["brand-sales"].params, payload: brandSalesPayload, source_refreshed_at: TS }; if (reportKey === "brand-inventory") return compactInventory; return null; };
  const slice = await brandView.buildAccountBrandSlice({ accountId: "A01", brand: "Acme", asOf: ASOF, account: { country: "US" }, getSnapshot, getAdsRows: async () => [] });
  assert.ok(slice.sales && slice.sales.series && slice.sales.series.size > 0, "fresh sales rendered");
  assert.equal(slice.inventory.scope, "unavailable", "inventory UNAVAILABLE");
  assert.equal(slice.inventoryDate, null);
});

/* ===================== P8. the REAL supabase reservation wrappers validate strictly (mocked fetch) ===================== */
group("P8. mocked-real-wrapper strict validation: reserve / record / get");
function withFetch(body, fn, status) {
  const orig = global.fetch;
  global.fetch = async () => new Response(body === undefined ? "" : JSON.stringify(body), { status: status || 200, headers: { "content-type": "application/json" } });
  return (async () => { try { return await fn(); } finally { global.fetch = orig; } })();
}
const OPK = "op-1"; const HSH = "hash-1";
test("P8a. reserve: valid 'reserved' / 'exists'+created / 'hash-mismatch' are accepted and normalized", async () => {
  await withFetch({ disposition: "reserved", operation_key: OPK, catalog_request_hash: HSH, export_id: null, status: "reserved", tokens_spent: 0 }, async () => {
    assert.deepEqual(await supabaseMod.reservePriorityCatalogCreate(OPK, HSH), { disposition: "reserved", exportId: null, status: "reserved", tokensSpent: 0, catalogRequestHash: HSH });
  });
  await withFetch({ disposition: "exists", operation_key: OPK, catalog_request_hash: HSH, export_id: "e9", status: "created", tokens_spent: 2 }, async () => {
    assert.deepEqual(await supabaseMod.reservePriorityCatalogCreate(OPK, HSH), { disposition: "exists", exportId: "e9", status: "created", tokensSpent: 2, catalogRequestHash: HSH });
  });
  await withFetch({ disposition: "hash-mismatch", operation_key: OPK, catalog_request_hash: "reserved-hash", requested_hash: HSH }, async () => {
    const r = await supabaseMod.reservePriorityCatalogCreate(OPK, HSH); assert.equal(r.disposition, "hash-mismatch"); assert.equal(r.reservedHash, "reserved-hash");
  });
});
test("P8b. reserve: malformed acknowledgements FAIL CLOSED (null / two rows / bad echo / reserved-with-export / unknown disposition)", async () => {
  const bad = [
    null,
    [{ disposition: "reserved", operation_key: OPK, catalog_request_hash: HSH, export_id: null, status: "reserved", tokens_spent: 0 }, { disposition: "reserved" }],
    { disposition: "reserved", operation_key: "WRONG", catalog_request_hash: HSH, export_id: null, status: "reserved", tokens_spent: 0 },
    { disposition: "reserved", operation_key: OPK, catalog_request_hash: HSH, export_id: "leak", status: "reserved", tokens_spent: 0 },
    { disposition: "exists", operation_key: OPK, catalog_request_hash: HSH, export_id: null, status: "created", tokens_spent: 2 },
    { disposition: "bogus", operation_key: OPK, catalog_request_hash: HSH },
  ];
  for (const b of bad) await withFetch(b, async () => { await assert.rejects(() => supabaseMod.reservePriorityCatalogCreate(OPK, HSH), (e) => /priority reserve/.test(e.message)); });
});
test("P8c. record: recorded/already-recorded require the exact export_id + 2 tokens; conflict a DIFFERENT id; malformed fails closed", async () => {
  await withFetch({ disposition: "recorded", operation_key: OPK, catalog_request_hash: HSH, export_id: "e7", status: "created", tokens_spent: 2 }, async () => {
    assert.deepEqual(await supabaseMod.recordPriorityCatalogExport(OPK, HSH, "e7", 2), { disposition: "recorded", exportId: "e7", tokensSpent: 2, status: "created" });
  });
  await withFetch({ disposition: "conflict", operation_key: OPK, catalog_request_hash: HSH, export_id: "other", status: "created", tokens_spent: 2 }, async () => {
    assert.equal((await supabaseMod.recordPriorityCatalogExport(OPK, HSH, "e7", 2)).disposition, "conflict");
  });
  // recorded but WRONG export_id echo -> fail closed; tokens != 2 -> fail closed.
  await withFetch({ disposition: "recorded", operation_key: OPK, catalog_request_hash: HSH, export_id: "DIFFERENT", status: "created", tokens_spent: 2 }, async () => { await assert.rejects(() => supabaseMod.recordPriorityCatalogExport(OPK, HSH, "e7", 2), (e) => /priority record/.test(e.message)); });
  await withFetch({ disposition: "recorded", operation_key: OPK, catalog_request_hash: HSH, export_id: "e7", status: "created", tokens_spent: 5 }, async () => { await assert.rejects(() => supabaseMod.recordPriorityCatalogExport(OPK, HSH, "e7", 2), (e) => /priority record/.test(e.message)); });
});
test("P8d. get: canonical valid row accepted; identity/coherence violations fail closed", async () => {
  await withFetch([{ operation_key: OPK, catalog_request_hash: HSH, export_id: "e1", tokens_spent: 2, status: "created" }], async () => {
    assert.deepEqual(await supabaseMod.getPriorityCatalogReservation(OPK, HSH), { operationKey: OPK, catalogRequestHash: HSH, exportId: "e1", tokensSpent: 2, status: "created" });
  });
  await withFetch([], async () => { assert.equal(await supabaseMod.getPriorityCatalogReservation(OPK, HSH), null); });
  const badRows = [
    [{ operation_key: "WRONG", catalog_request_hash: HSH, export_id: "e1", tokens_spent: 2, status: "created" }],
    [{ operation_key: OPK, catalog_request_hash: HSH, export_id: null, tokens_spent: 0, status: "created" }], // incoherent: created w/o export
    [{ operation_key: OPK, catalog_request_hash: HSH, export_id: "e1", tokens_spent: 2, status: "created" }, { operation_key: OPK, catalog_request_hash: HSH, export_id: "e2", tokens_spent: 2, status: "created" }], // 2 rows
  ];
  for (const b of badRows) await withFetch(b, async () => { await assert.rejects(() => supabaseMod.getPriorityCatalogReservation(OPK, HSH), (e) => /priority reservation read/.test(e.message)); });
});

/* ===================== P9. the STRICT production operator runner ===================== */
group("P9. production runner: exits nonzero on every non-success; no partial publish; read-only recon first");

const THREE = ["daily-reporting", "brand-sales", "brand-inventory"];
const idResults = (a, disp) => THREE.map((rk) => ({ reportKey: rk, disposition: disp, liveReportKey: rk, paramsHash: "ph_" + rk + "_" + a }));
function fakeRelease(over = {}) {
  return {
    publishOrder: THREE, reportKeys: THREE,
    deriveBucket: over.deriveBucket || (async () => ({ rollup: { stopped: false, derived: { skipped: null } } })),
    finalizeBucket: over.finalizeBucket || (async (b) => ({ disposition: "finalized", cycleStatus: "succeeded", accounts: b === "us" ? ["A01"] : ["B01"] })),
    preflightAccount: over.preflightAccount || (async (a) => ({ accountId: a, results: idResults(a, "ready") })),
    publishAccount: over.publishAccount || (async (a) => ({ accountId: a, results: idResults(a, "published") })),
    catalogReservation: over.catalogReservation || (async () => ({ tokensSpent: 2, status: "created" })),
  };
}
function runnerDeps(over = {}) {
  return {
    release: over.release || fakeRelease(over.releaseOver || {}),
    reconcile: over.reconcile || (async () => ({ ok: true })),
    readbackLive: over.readbackLive || (async () => ({ ok: true })),
    assertNoCron: over.assertNoCron || (async () => ({ ok: true })),
  };
}

test("P9a. happy path: reconcile -> derive US+Non-US -> finalize -> gates -> publish -> readback => code 0", async () => {
  const r = await releaseRunner.runPriorityDashboardsRelease(runnerDeps());
  assert.equal(r.code, 0); assert.equal(r.ok, true);
  assert.equal(r.evidence.accounts, 2); assert.equal(r.evidence.published, 6); assert.equal(r.evidence.tokensSpent, 2);
});
test("P9b. a failed READ-ONLY reconciliation stops BEFORE deriving => code 1 (reconcile)", async () => {
  let derived = 0;
  const r = await releaseRunner.runPriorityDashboardsRelease(runnerDeps({ reconcile: async () => ({ ok: false, problems: ["135k unexpected"] }), releaseOver: { deriveBucket: async () => { derived += 1; return { rollup: {} }; } } }));
  assert.equal(r.code, 1); assert.equal(r.stage, "reconcile"); assert.equal(derived, 0, "never derived after a failed reconciliation");
});
test("P9c. a skipped/stopped derive stops => code 1 (derive)", async () => {
  const r = await releaseRunner.runPriorityDashboardsRelease(runnerDeps({ releaseOver: { deriveBucket: async () => ({ rollup: { stopped: false, derived: { skipped: "not-drained" } } }) } }));
  assert.equal(r.code, 1); assert.equal(r.stage, "derive:us");
});
test("P9d. the durable reservation exceeding two tokens stops => code 1 (token-ceiling)", async () => {
  const r = await releaseRunner.runPriorityDashboardsRelease(runnerDeps({ releaseOver: { catalogReservation: async () => ({ tokensSpent: 4 }) } }));
  assert.equal(r.code, 1); assert.equal(r.stage, "token-ceiling");
});
test("P9e. a refused finalize stops => code 1 (finalize)", async () => {
  const r = await releaseRunner.runPriorityDashboardsRelease(runnerDeps({ releaseOver: { finalizeBucket: async () => ({ disposition: "refused", reason: "open-work" }) } }));
  assert.equal(r.code, 1); assert.equal(r.stage, "finalize:us");
});
test("P9f. a NOT-ready publisher preflight stops BEFORE any publish (no partial publish) => code 1 (publish-gates)", async () => {
  let published = 0;
  const r = await releaseRunner.runPriorityDashboardsRelease(runnerDeps({ releaseOver: {
    preflightAccount: async (a) => ({ accountId: a, results: [{ reportKey: "daily-reporting", disposition: "ready" }, { reportKey: "brand-sales", disposition: "ready" }, { reportKey: "brand-inventory", disposition: "report-disabled" }] }),
    publishAccount: async (a) => { published += 1; return { accountId: a, results: [] }; },
  } }));
  assert.equal(r.code, 1); assert.equal(r.stage, "publish-gates");
  assert.equal(published, 0, "no account was published when a preflight was not ready");
});
test("P9g. a non-success publish disposition stops => code 1 (publish)", async () => {
  const r = await releaseRunner.runPriorityDashboardsRelease(runnerDeps({ releaseOver: { publishAccount: async (a) => ({ accountId: a, results: [{ reportKey: "daily-reporting", disposition: "not-successful" }] }) } }));
  assert.equal(r.code, 1); assert.equal(r.stage, "publish");
});
test("P9h. a failed live read-back stops => code 1 (readback)", async () => {
  const r = await releaseRunner.runPriorityDashboardsRelease(runnerDeps({ readbackLive: async () => ({ ok: false, reason: "payload contract" }) }));
  assert.equal(r.code, 1); assert.equal(r.stage, "readback");
});
test("P9i. an existing scheduler cron stops immediately => code 1 (assert-no-cron)", async () => {
  const r = await releaseRunner.runPriorityDashboardsRelease(runnerDeps({ assertNoCron: async () => ({ ok: false, reason: "cron.job present" }) }));
  assert.equal(r.code, 1); assert.equal(r.stage, "assert-no-cron");
});
test("P9j. 'already-current' publish + 'already-terminal' finalize are accepted as success => code 0", async () => {
  const r = await releaseRunner.runPriorityDashboardsRelease(runnerDeps({ releaseOver: {
    finalizeBucket: async (b) => ({ disposition: "already-terminal", cycleStatus: "succeeded", accounts: b === "us" ? ["A01"] : ["B01"] }),
    publishAccount: async (a) => ({ accountId: a, results: idResults(a, "already-current") }),
  } }));
  assert.equal(r.code, 0);
});
test("P9k. WARM-CACHE-FIRST: a reservation-absent (zero-token) run is accepted (evidence.tokensSpent=0)", async () => {
  const r = await releaseRunner.runPriorityDashboardsRelease(runnerDeps({ releaseOver: { catalogReservation: async () => null } }));
  assert.equal(r.code, 0); assert.equal(r.evidence.tokensSpent, 0);
});
test("P9l. a publish result missing its live identity stops => code 1 (publish)", async () => {
  const r = await releaseRunner.runPriorityDashboardsRelease(runnerDeps({ releaseOver: { publishAccount: async (a) => ({ accountId: a, results: [{ reportKey: "daily-reporting", disposition: "published" }] }) } }));
  assert.equal(r.code, 1); assert.equal(r.stage, "publish");
});
test("P9m. a preflight result set that is not EXACTLY the frozen 3 (missing / extra / duplicate) stops BEFORE any publish => code 1 (publish-gates)", async () => {
  const R = (rk) => ({ reportKey: rk, disposition: "ready", liveReportKey: rk, paramsHash: "ph" });
  const variants = [
    [R("daily-reporting"), R("brand-sales")],                                  // missing brand-inventory
    [R("daily-reporting"), R("brand-sales"), R("brand-inventory"), R("reconciliation")], // extra key
    [R("daily-reporting"), R("daily-reporting"), R("brand-inventory")],        // duplicate + missing brand-sales
  ];
  for (const results of variants) {
    let published = 0;
    const r = await releaseRunner.runPriorityDashboardsRelease(runnerDeps({ releaseOver: {
      preflightAccount: async (a) => ({ accountId: a, results }),
      publishAccount: async (a) => { published += 1; return { accountId: a, results: [] }; },
    } }));
    assert.equal(r.code, 1, JSON.stringify(results)); assert.equal(r.stage, "publish-gates");
    assert.equal(published, 0, "no partial publish for a malformed preflight result set");
  }
});
test("P9n. a preflight whose accountId does not echo the requested account stops => code 1 (publish-gates)", async () => {
  let published = 0;
  const r = await releaseRunner.runPriorityDashboardsRelease(runnerDeps({ releaseOver: {
    preflightAccount: async () => ({ accountId: "SOMEONE-ELSE", results: idResults("SOMEONE-ELSE", "ready") }),
    publishAccount: async (a) => { published += 1; return { accountId: a, results: [] }; },
  } }));
  assert.equal(r.code, 1); assert.equal(r.stage, "publish-gates"); assert.equal(published, 0);
});
test("P9o. a preflight result that is ready but carries a BLANK live identity stops => code 1 (publish-gates)", async () => {
  const r = await releaseRunner.runPriorityDashboardsRelease(runnerDeps({ releaseOver: {
    preflightAccount: async (a) => ({ accountId: a, results: THREE.map((rk) => ({ reportKey: rk, disposition: "ready", liveReportKey: "", paramsHash: "" })) }),
  } }));
  assert.equal(r.code, 1); assert.equal(r.stage, "publish-gates");
});

/* ---- P9 (cont). The PUBLISH acknowledgement is validated as strictly as the preflight (blocker 1) ---- */
test("P9p. PINNED DEFECT: a publishAccount response with results=[] returns NONZERO (never code 0)", async () => {
  const r = await releaseRunner.runPriorityDashboardsRelease(runnerDeps({ releaseOver: { publishAccount: async (a) => ({ accountId: a, results: [] }) } }));
  assert.equal(r.code, 1, "results=[] must be code 1, NEVER a false success"); assert.equal(r.stage, "publish");
});
test("P9q. a publish result set that is not EXACTLY the frozen 3 (missing / extra / duplicate) stops => code 1 (publish)", async () => {
  const P = (rk, disp) => ({ reportKey: rk, disposition: disp || "published", liveReportKey: rk, paramsHash: "ph" });
  const variants = [
    [P("daily-reporting"), P("brand-sales")],                                          // missing brand-inventory
    [P("daily-reporting"), P("brand-sales"), P("brand-inventory"), P("reconciliation")], // extra key
    [P("daily-reporting"), P("daily-reporting"), P("brand-inventory")],                // duplicate + missing brand-sales
    [P("daily-reporting"), P("brand-sales"), P("unknown-report")],                     // unknown key
  ];
  for (const results of variants) {
    const r = await releaseRunner.runPriorityDashboardsRelease(runnerDeps({ releaseOver: { publishAccount: async (a) => ({ accountId: a, results }) } }));
    assert.equal(r.code, 1, JSON.stringify(results)); assert.equal(r.stage, "publish");
  }
});
test("P9r. a publish whose accountId does not echo the requested account stops => code 1 (publish)", async () => {
  const r = await releaseRunner.runPriorityDashboardsRelease(runnerDeps({ releaseOver: { publishAccount: async () => ({ accountId: "WRONG", results: idResults("WRONG", "published") }) } }));
  assert.equal(r.code, 1); assert.equal(r.stage, "publish");
});
test("P9s. a malformed publish envelope (non-array / missing results) stops => code 1 (publish)", async () => {
  for (const bad of [{ accountId: "A01" }, { accountId: "A01", results: null }, { accountId: "A01", results: "nope" }, null]) {
    const r = await releaseRunner.runPriorityDashboardsRelease(runnerDeps({ releaseOver: {
      finalizeBucket: async () => ({ disposition: "finalized", cycleStatus: "succeeded", accounts: ["A01"] }),
      publishAccount: async () => bad,
    } }));
    assert.equal(r.code, 1, JSON.stringify(bad)); assert.equal(r.stage, "publish");
  }
});
test("P9t. a publish result with a non-accepted disposition or a blank live identity stops => code 1 (publish)", async () => {
  const bad1 = THREE.map((rk) => ({ reportKey: rk, disposition: "not-successful", liveReportKey: rk, paramsHash: "ph" }));
  const r1 = await releaseRunner.runPriorityDashboardsRelease(runnerDeps({ releaseOver: { publishAccount: async (a) => ({ accountId: a, results: bad1 }) } }));
  assert.equal(r1.code, 1); assert.equal(r1.stage, "publish");
  const bad2 = THREE.map((rk) => ({ reportKey: rk, disposition: "published", liveReportKey: "", paramsHash: "" }));
  const r2 = await releaseRunner.runPriorityDashboardsRelease(runnerDeps({ releaseOver: { publishAccount: async (a) => ({ accountId: a, results: bad2 }) } }));
  assert.equal(r2.code, 1); assert.equal(r2.stage, "publish");
});
test("P9u. success REQUIRES published.length === provenAccountCount * 3 (a short account count can never return code 0)", async () => {
  // finalize proves TWO accounts (A01 + B01) but one account publishes only 2 of 3 -> short total -> code 1.
  const r = await releaseRunner.runPriorityDashboardsRelease(runnerDeps({ releaseOver: {
    publishAccount: async (a) => a === "A01"
      ? ({ accountId: a, results: [{ reportKey: "daily-reporting", disposition: "published", liveReportKey: "daily-reporting", paramsHash: "ph" }, { reportKey: "brand-sales", disposition: "published", liveReportKey: "brand-sales", paramsHash: "ph" }] })
      : ({ accountId: a, results: idResults(a, "published") }),
  } }));
  assert.equal(r.code, 1); assert.equal(r.stage, "publish");
});

/* ===================== P10. the EXACT-identity live read-back (buildLiveReadback) ===================== */
group("P10. exact-identity read-back: omitted/wrong params hash fails; exact identity passes");
function readbackFor(rowsByHash, over = {}) {
  return releaseRunner.buildLiveReadback({
    getReportSnapshot: async ({ reportKey, accountId, paramsHash }) => rowsByHash.get(reportKey + "|" + accountId + "|" + paramsHash) || null,
    loadStoragePayload: over.loadStoragePayload || (async () => null),
    liveContracts: publisherCore.SCHEDULER_LIVE_SNAPSHOT_CONTRACTS,
    reportDerivations: reportDerivation.REPORT_DERIVATIONS,
    computeHash: reportStore.paramsHashFor,
  });
}
// The EXACT live-snapshot row the REAL publisher writes: params = { reportVersion, ...liveParams } with NO
// accountId; identity lives in the ROW columns report_key + account_id + params_hash (report-publisher.js:294).
function liveRow(liveReportKey, accountId, paramsHash, params, payload, over = {}) {
  return { report_key: liveReportKey, account_id: accountId, params_hash: paramsHash, params, payload, payload_storage_path: null, source_refreshed_at: TS, ...over };
}
test("P10a. the EXACT publisher row (params carry NO accountId) passes; omitted/wrong hash + wrong live key + wrong row report/account echoes fail", async () => {
  const RK = "daily-reporting";
  const contract = publisherCore.SCHEDULER_LIVE_SNAPSHOT_CONTRACTS[RK];
  const liveParams = { from: "2026-03-19", to: ASOF, brand: "ALL" };
  const PH = reportStore.paramsHashFor(contract.liveReportVersion, liveParams);
  // EXACTLY what the publisher's publishLive receives -- reportVersion + the live params, NOTHING else.
  const params = { reportVersion: contract.liveReportVersion, ...liveParams };
  const payload = { rows: [], brandFiltered: false, adsAvailability: { status: "unavailable" } };
  const rows = new Map([["daily-reporting|A01|" + PH, liveRow("daily-reporting", "A01", PH, params, payload)]]);
  const readback = readbackFor(rows);
  // A fabricated params.accountId is UNNECESSARY: the exact object (no accountId) passes.
  assert.equal("accountId" in params, false, "the real published live params carry NO accountId");
  assert.deepEqual(await readback({ reportKey: RK, liveReportKey: "daily-reporting", accountId: "A01", paramsHash: PH }), { ok: true });
  assert.equal((await readback({ reportKey: RK, liveReportKey: "daily-reporting", accountId: "A01", paramsHash: "" })).reason, "blank-params-hash");
  assert.equal((await readback({ reportKey: RK, liveReportKey: "daily-reporting", accountId: "A01", paramsHash: "WRONG" })).reason, "no-live-snapshot");
  assert.equal((await readback({ reportKey: RK, liveReportKey: "brand-sales", accountId: "A01", paramsHash: PH })).reason, "live-report-key-mismatch");
  // WRONG row echoes fail: a row whose OWN report_key/account_id do not match the requested identity.
  const wrongReport = new Map([["daily-reporting|A01|" + PH, liveRow("brand-sales", "A01", PH, params, payload)]]);
  assert.equal((await readbackFor(wrongReport)({ reportKey: RK, liveReportKey: "daily-reporting", accountId: "A01", paramsHash: PH })).reason, "identity-report-key");
  const wrongAccount = new Map([["daily-reporting|A01|" + PH, liveRow("daily-reporting", "A99", PH, params, payload)]]);
  assert.equal((await readbackFor(wrongAccount)({ reportKey: RK, liveReportKey: "daily-reporting", accountId: "A01", paramsHash: PH })).reason, "identity-account");
});
test("P10b. a mutated-after-save row fails provenance; a dangling storage payload fails; a bad payload fails the contract", async () => {
  const RK = "brand-sales";
  const contract = publisherCore.SCHEDULER_LIVE_SNAPSHOT_CONTRACTS[RK];
  const liveParams = { from: "2025-01-01", to: ASOF };
  const PH = reportStore.paramsHashFor(contract.liveReportVersion, liveParams);
  const good = { rows: [], catalogBrands: [], asinBrand: { B0A: "Acme" } };
  // params say a DIFFERENT to-date than the hash was computed from -> provenance fails (no fabricated accountId).
  const mutated = new Map([["brand-sales|A01|" + PH, liveRow("brand-sales", "A01", PH, { reportVersion: contract.liveReportVersion, from: "2025-01-01", to: "2026-01-01" }, good)]]);
  assert.equal((await readbackFor(mutated)({ reportKey: RK, liveReportKey: "brand-sales", accountId: "A01", paramsHash: PH })).reason, "params-provenance");
  const params = { reportVersion: contract.liveReportVersion, ...liveParams };
  const dangling = new Map([["brand-sales|A01|" + PH, liveRow("brand-sales", "A01", PH, params, null, { payload_storage_path: "missing" })]]);
  assert.equal((await readbackFor(dangling)({ reportKey: RK, liveReportKey: "brand-sales", accountId: "A01", paramsHash: PH })).reason, "payload-dangling");
  const badPayload = new Map([["brand-sales|A01|" + PH, liveRow("brand-sales", "A01", PH, params, { rows: [], catalogBrands: [], asinBrand: {} })]]); // empty asinBrand -> invalid
  assert.equal((await readbackFor(badPayload)({ reportKey: RK, liveReportKey: "brand-sales", accountId: "A01", paramsHash: PH })).reason, "payload-contract");
});

/* ===================== P11. the exact publication control package builder (prepared) ===================== */
group("P11. control package builder: exact global target sets; safe-close rollback; fails closed");
test("P11a. buildPriorityControlPackage: exact rollout, ONLY 2 dispatch enabled (others paused), promoted enabled, 3xN approvals", () => {
  const pkg = controlPkg.buildPriorityControlPackage({ accounts: ["A02", "A01", "A01"], operator: "op@x" });
  assert.deepEqual(pkg.accounts, ["A01", "A02"]);
  assert.equal(pkg.operator, "op@x");
  assert.equal(pkg.apply.allPrimary, false);
  assert.deepEqual(pkg.apply.rollout.map((r) => [r.account_id, r.enabled]), [["A01", true], ["A02", true]]);
  assert.deepEqual(pkg.apply.reportSyncSettings.filter((s) => s.schedule_enabled).map((s) => s.report_key).sort(), ["brand-sales", "daily-reporting"]);
  assert.ok(pkg.apply.reportSyncSettings.some((s) => s.report_key === "keyword-rank" && s.schedule_enabled === false), "unrelated reports paused");
  assert.ok(!pkg.apply.reportSyncSettings.some((s) => s.report_key === "brand-inventory"), "brand-inventory is NOT a dispatch control");
  assert.deepEqual(pkg.apply.promoted, [{ report_key: "brand-inventory", publish_enabled: true }]);
  assert.equal(pkg.apply.approvals.length, 6);
  assert.ok(pkg.apply.approvals.every((a) => a.approved === true && a.approved_by === "op@x"));
});
test("P11b. rollback is a documented SAFE-CLOSE descriptor (NOT per-account restoration data)", () => {
  const pkg = controlPkg.buildPriorityControlPackage({ accounts: ["A01"], operator: "op" });
  assert.equal(pkg.rollback.mode, "safe-close");
  assert.equal(pkg.rollback.disablesAllRollout, true);
  assert.equal(pkg.rollback.pausesAllControlledDispatch, true);
  assert.equal(pkg.rollback.disablesAllPromoted, true);
  assert.equal(pkg.rollback.revokesAllApprovals, true);
  assert.equal(pkg.rollback.allPrimary, false);
});
test("P11c. post assertions describe the exact COMPLETE target sets (all_primary false, exact scope, no cron)", () => {
  const pkg = controlPkg.buildPriorityControlPackage({ accounts: ["A01", "A02"], operator: "op" });
  assert.equal(pkg.post.allPrimaryFalse, true);
  assert.deepEqual(pkg.post.rolloutEnabled, ["A01", "A02"]);
  assert.deepEqual([...pkg.post.dispatchEnabled].sort(), ["brand-sales", "daily-reporting"]);
  assert.equal(pkg.post.promotedEnabled, "brand-inventory");
  assert.equal(pkg.post.approvals.length, 6);
  assert.deepEqual(pkg.post.approvals, ["brand-inventory|A01", "brand-inventory|A02", "brand-sales|A01", "brand-sales|A02", "daily-reporting|A01", "daily-reporting|A02"]);
  assert.equal(pkg.post.noCron, true);
  assert.equal(pkg.post.dispatchPaused.length, pkg.controlled.length - 2);
  assert.ok(pkg.post.dispatchPaused.includes("keyword-rank") && !pkg.post.dispatchPaused.includes("daily-reporting"));
});
test("P11d. fails closed: empty accounts / dd-secondary account / blank operator", () => {
  assert.throws(() => controlPkg.buildPriorityControlPackage({ accounts: [], operator: "op" }), /primary account/);
  assert.throws(() => controlPkg.buildPriorityControlPackage({ accounts: ["dd-secondary:x"], operator: "op" }), /dd-secondary/);
  assert.throws(() => controlPkg.buildPriorityControlPackage({ accounts: ["A01"], operator: "" }), /operator id/);
});

/* ===================== P12. the guarded control-package TRANSACTION (runControlPackageTransaction) ===================== */
group("P12. control transaction: exact-global apply, safe-close rollback, fail-closed rollback on every mismatch");

// A faithful in-memory model of the four durable control tables + all_primary + a scheduler cron flag, exposing
// the exact store contract runControlPackageTransaction drives. `begin/commit/rollback` snapshot + restore so a
// FAILED transaction leaves NO write behind (proving the guard truly rolls back) -- INCLUDING the approval audit
// columns (approved_by + approved_at). Approvals are AUDITED: every approve/revoke stamps operator + a logical
// clock tick (modelling now()), so a test can prove the revoked rows received the operator + a new timestamp.
// Knobs: `opts.freezeWritesFor` models a broken/racing reconcile (a write that leaves a stray row) to force a
// POST mismatch + rollback; `opts.failCommit` / `opts.failRollback` model a lost/failed commit or rollback ack.
function makeControlStore(initial = {}, opts = {}) {
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const asAppr = (e) => (typeof e === "string" ? { approved: true, approved_by: null, approved_at: 0 } : { approved: e.approved !== false, approved_by: e.approved_by ?? null, approved_at: e.approved_at ?? 0 });
  const keyOf = (e) => (typeof e === "string" ? e : e.pair);
  const st = {
    allPrimary: initial.allPrimary === true,
    cron: initial.cron === true,
    rollout: new Map((initial.rollout || []).map((r) => [r.account_id, !!r.enabled])),          // acct -> enabled
    dispatch: new Map((initial.dispatch || []).map((r) => [r.report_key, !!r.schedule_enabled])), // rk -> enabled
    promoted: new Map((initial.promoted || []).map((r) => [r.report_key, !!r.publish_enabled])),   // rk -> enabled
    approvals: new Map((initial.approvals || []).map((e) => [keyOf(e), asAppr(e)])),               // "rk|acct" -> {approved, approved_by, approved_at}
  };
  let snapshot = null;
  let clk = 100; const tick = () => (clk += 1); // logical PostgreSQL now(); monotonic so a new stamp is provable
  const frozen = new Set(opts.freezeWritesFor || []); // e.g. "rollout" -> reconcile leaves the stray row
  const calls = { begin: 0, commit: 0, rollback: 0 };
  const S2 = (v) => String(v);
  const stamp = (p, approved, operator) => st.approvals.set(S2(p), { approved, approved_by: S2(operator), approved_at: tick() });
  return {
    _state: st, _calls: calls, _clock: () => clk,
    begin: async () => { calls.begin += 1; snapshot = { allPrimary: st.allPrimary, cron: st.cron, rollout: clone([...st.rollout]), dispatch: clone([...st.dispatch]), promoted: clone([...st.promoted]), approvals: clone([...st.approvals]) }; },
    commit: async () => { calls.commit += 1; if (opts.failCommit) throw new Error("commit ack lost (network)"); snapshot = null; },
    rollback: async () => { calls.rollback += 1; if (opts.failRollback) throw new Error("rollback failed (connection dropped)"); if (snapshot) { st.allPrimary = snapshot.allPrimary; st.cron = snapshot.cron; st.rollout = new Map(snapshot.rollout); st.dispatch = new Map(snapshot.dispatch); st.promoted = new Map(snapshot.promoted); st.approvals = new Map(snapshot.approvals.map(([k, v]) => [k, { ...v }])); } },
    readAllPrimary: async () => st.allPrimary,
    hasCron: async () => st.cron,
    setRolloutEnabled: async (ids) => { for (const a of ids) st.rollout.set(S2(a), true); if (!frozen.has("rollout")) for (const a of [...st.rollout.keys()]) if (!ids.map(S2).includes(a)) st.rollout.set(a, false); },
    disableAllRollout: async () => { for (const a of [...st.rollout.keys()]) st.rollout.set(a, false); },
    setDispatchEnabled: async (keys, controlled) => { for (const rk of controlled) st.dispatch.set(S2(rk), keys.includes(rk)); },
    pauseAllDispatch: async (controlled) => { for (const rk of controlled) st.dispatch.set(S2(rk), false); },
    setPromotedEnabled: async (keys) => { for (const rk of keys) st.promoted.set(S2(rk), true); for (const rk of [...st.promoted.keys()]) if (!keys.map(S2).includes(rk)) st.promoted.set(rk, false); },
    disableAllPromoted: async () => { for (const rk of [...st.promoted.keys()]) st.promoted.set(rk, false); },
    setApprovalsApproved: async (pairs, operator) => { for (const p of pairs) stamp(p, true, operator); if (!frozen.has("approvals")) for (const p of [...st.approvals.keys()]) if (!pairs.map(S2).includes(p)) stamp(p, false, operator); },
    revokeAllApprovals: async (operator) => { for (const p of [...st.approvals.keys()]) stamp(p, false, operator); },
    rolloutRows: async () => [...st.rollout].map(([account_id, enabled]) => ({ account_id, enabled })),
    dispatchRows: async () => [...st.dispatch].map(([report_key, schedule_enabled]) => ({ report_key, schedule_enabled })),
    promotedRows: async () => [...st.promoted].map(([report_key, publish_enabled]) => ({ report_key, publish_enabled })),
    approvalRows: async () => [...st.approvals].map(([p, v]) => { const [report_key, account_id] = p.split("|"); return { report_key, account_id, approved: v.approved, approved_by: v.approved_by, approved_at: v.approved_at }; }),
  };
}
const CONTROLLED = ["daily-reporting", "brand-sales", "reconciliation", "fba-plan", "sku-pl", "keyword-rank", "content-changes", "sales-movers", "listing-health", "buy-box-loss", "returns-leakage", "ppc-performance", "listing-optimizer"];
// a clean production baseline: the 13 settings present + paused, brand-inventory promoted row present + off.
function baseline(over = {}) {
  return { allPrimary: false, cron: false, rollout: over.rollout || [], dispatch: CONTROLLED.map((rk) => ({ report_key: rk, schedule_enabled: false })), promoted: [{ report_key: "brand-inventory", publish_enabled: false }], approvals: over.approvals || [] };
}
function runTxn(store, pkg, mode) { return controlPkg.runControlPackageTransaction({ store, pkg, mode, controlledReportKeys: CONTROLLED }); }

test("P12a. APPLY on a clean baseline COMMITS and produces EXACTLY the global target sets", async () => {
  const pkg = controlPkg.buildPriorityControlPackage({ accounts: ["A01", "A02"], operator: "op@x", controlledReportKeys: CONTROLLED });
  const store = makeControlStore(baseline());
  const r = await runTxn(store, pkg, "apply");
  assert.equal(r.committed, true, JSON.stringify(r));
  assert.deepEqual((await store.rolloutRows()).filter((x) => x.enabled).map((x) => x.account_id).sort(), ["A01", "A02"]);
  assert.deepEqual((await store.dispatchRows()).filter((x) => x.schedule_enabled).map((x) => x.report_key).sort(), ["brand-sales", "daily-reporting"]);
  assert.deepEqual((await store.promotedRows()).filter((x) => x.publish_enabled).map((x) => x.report_key), ["brand-inventory"]);
  assert.equal((await store.approvalRows()).filter((x) => x.approved).length, 6);
});
test("P12b. APPLY actively RECONCILES AWAY a pre-existing EXTRA rollout row + EXTRA approval (produces exactly the target) and COMMITS", async () => {
  const pkg = controlPkg.buildPriorityControlPackage({ accounts: ["A01"], operator: "op", controlledReportKeys: CONTROLLED });
  const store = makeControlStore(baseline({ rollout: [{ account_id: "STRAY", enabled: true }], approvals: ["daily-reporting|STRAY"] }));
  const r = await runTxn(store, pkg, "apply");
  assert.equal(r.committed, true, JSON.stringify(r));
  assert.deepEqual((await store.rolloutRows()).filter((x) => x.enabled).map((x) => x.account_id), ["A01"], "the STRAY enabled rollout was disabled");
  assert.deepEqual((await store.approvalRows()).filter((x) => x.approved).map((x) => x.report_key + "|" + x.account_id).sort(), ["brand-inventory|A01", "brand-sales|A01", "daily-reporting|A01"], "the STRAY approval was revoked");
});
test("P12c. APPLY ROLLS BACK (zero writes persisted) when the reconcile cannot remove a stray -> global POST mismatch", async () => {
  const pkg = controlPkg.buildPriorityControlPackage({ accounts: ["A01"], operator: "op", controlledReportKeys: CONTROLLED });
  const store = makeControlStore(baseline({ rollout: [{ account_id: "STRAY", enabled: true }] }), { freezeWritesFor: ["rollout"] });
  const r = await runTxn(store, pkg, "apply");
  assert.equal(r.committed, false);
  assert.ok(r.problems.some((p) => /rollout-enabled/.test(p)), JSON.stringify(r.problems));
  // rolled back: the STRAY is untouched AND A01 was NOT enabled (no partial write survived).
  assert.deepEqual((await store.rolloutRows()).filter((x) => x.enabled).map((x) => x.account_id).sort(), ["STRAY"]);
});
test("P12d. APPLY ROLLS BACK when an EXTRA approval cannot be revoked -> global approved-set mismatch (transaction rollback)", async () => {
  const pkg = controlPkg.buildPriorityControlPackage({ accounts: ["A01"], operator: "op", controlledReportKeys: CONTROLLED });
  const store = makeControlStore(baseline({ approvals: ["keyword-rank|A01"] }), { freezeWritesFor: ["approvals"] });
  const r = await runTxn(store, pkg, "apply");
  assert.equal(r.committed, false);
  assert.ok(r.problems.some((p) => /approved/.test(p)), JSON.stringify(r.problems));
  // Rollback restores the ORIGINAL state exactly: the pre-existing stray is untouched AND none of the target
  // approvals (daily-reporting/brand-sales/brand-inventory|A01) were left behind by the aborted write.
  assert.deepEqual((await store.approvalRows()).filter((x) => x.approved).map((x) => x.report_key + "|" + x.account_id), ["keyword-rank|A01"], "no target approval write survived the rollback");
});
test("P12e. APPLY fails CLOSED on a PRE violation: all_primary=true or a scheduler cron -> zero writes", async () => {
  const pkg = controlPkg.buildPriorityControlPackage({ accounts: ["A01"], operator: "op", controlledReportKeys: CONTROLLED });
  const s1 = makeControlStore(baseline({ }));
  s1._state.allPrimary = true;
  const r1 = await runTxn(s1, pkg, "apply");
  assert.equal(r1.committed, false); assert.match(r1.problem, /all_primary/);
  assert.equal((await s1.rolloutRows()).filter((x) => x.enabled).length, 0, "no write under a bad PRE");
  const s2 = makeControlStore(baseline({ })); s2._state.cron = true;
  const r2 = await runTxn(s2, pkg, "apply");
  assert.equal(r2.committed, false); assert.match(r2.problem, /cron/);
});
test("P12f. ROLLBACK safe-close DISABLES EVERYTHING and COMMITS: every rollout disabled, all 13 paused, promoted off, approvals false", async () => {
  const pkg = controlPkg.buildPriorityControlPackage({ accounts: ["A01", "A02"], operator: "op", controlledReportKeys: CONTROLLED });
  // A fully-applied state (as if apply ran): plus an UNRELATED enabled rollout the safe-close must ALSO disable.
  const applied = { allPrimary: false, cron: false,
    rollout: [{ account_id: "A01", enabled: true }, { account_id: "A02", enabled: true }, { account_id: "LEGACY", enabled: true }],
    dispatch: CONTROLLED.map((rk) => ({ report_key: rk, schedule_enabled: ["daily-reporting", "brand-sales"].includes(rk) })),
    promoted: [{ report_key: "brand-inventory", publish_enabled: true }],
    approvals: pkg.post.approvals };
  const store = makeControlStore(applied);
  const r = await runTxn(store, pkg, "rollback");
  assert.equal(r.committed, true, JSON.stringify(r));
  assert.equal((await store.rolloutRows()).filter((x) => x.enabled).length, 0, "every rollout row (incl. LEGACY) disabled");
  assert.equal((await store.dispatchRows()).filter((x) => x.schedule_enabled).length, 0, "no dispatch enabled");
  assert.equal((await store.dispatchRows()).filter((x) => x.schedule_enabled === false).length, CONTROLLED.length, "all 13 settings paused");
  assert.equal((await store.promotedRows()).filter((x) => x.publish_enabled).length, 0, "promoted disabled");
  assert.equal((await store.approvalRows()).filter((x) => x.approved).length, 0, "approvals revoked");
});
test("P12g. ROLLBACK is a SAFE-CLOSE independent of discovery: a CHANGED account set between apply and rollback still fully closes", async () => {
  // apply discovered [A01,A02]; at rollback the operator rebuilds the package with a DIFFERENT set [A03] (drift).
  const applied = { allPrimary: false, cron: false,
    rollout: [{ account_id: "A01", enabled: true }, { account_id: "A02", enabled: true }],
    dispatch: CONTROLLED.map((rk) => ({ report_key: rk, schedule_enabled: ["daily-reporting", "brand-sales"].includes(rk) })),
    promoted: [{ report_key: "brand-inventory", publish_enabled: true }],
    approvals: ["daily-reporting|A01", "brand-sales|A01", "brand-inventory|A01", "daily-reporting|A02", "brand-sales|A02", "brand-inventory|A02"] };
  const store = makeControlStore(applied);
  const driftPkg = controlPkg.buildPriorityControlPackage({ accounts: ["A03"], operator: "op", controlledReportKeys: CONTROLLED });
  const r = await runTxn(store, driftPkg, "rollback");
  assert.equal(r.committed, true, "safe-close closes the ACTUAL applied state, not the rediscovered set");
  assert.equal((await store.rolloutRows()).filter((x) => x.enabled).length, 0, "A01+A02 disabled even though the rollback package named A03");
  assert.equal((await store.approvalRows()).filter((x) => x.approved).length, 0);
});
test("P12h. ROLLBACK ROLLS BACK if the safe-close leaves any control enabled (a stray rollout it could not disable)", async () => {
  const pkg = controlPkg.buildPriorityControlPackage({ accounts: ["A01"], operator: "op", controlledReportKeys: CONTROLLED });
  const store = makeControlStore({ allPrimary: false, cron: false, rollout: [{ account_id: "A01", enabled: true }], dispatch: CONTROLLED.map((rk) => ({ report_key: rk, schedule_enabled: false })), promoted: [{ report_key: "brand-inventory", publish_enabled: false }], approvals: [] });
  const orig = store.disableAllRollout; store.disableAllRollout = async () => { /* broken: leaves A01 enabled */ };
  const r = await runTxn(store, pkg, "rollback");
  store.disableAllRollout = orig;
  assert.equal(r.committed, false);
  assert.ok(r.problems.some((p) => /rollback-rollout-still-enabled/.test(p)), JSON.stringify(r.problems));
  assert.equal((await store.rolloutRows()).find((x) => x.account_id === "A01").enabled, true, "the incomplete safe-close was rolled back (A01 still as it was)");
});
test("P12i. runControlPackageTransaction fails closed on a bad mode / missing store / missing package", async () => {
  const pkg = controlPkg.buildPriorityControlPackage({ accounts: ["A01"], operator: "op", controlledReportKeys: CONTROLLED });
  await assert.rejects(() => controlPkg.runControlPackageTransaction({ store: makeControlStore(baseline()), pkg, mode: "sideways" }), /apply.*rollback/);
  await assert.rejects(() => controlPkg.runControlPackageTransaction({ store: null, pkg, mode: "apply" }), /store/);
  await assert.rejects(() => controlPkg.runControlPackageTransaction({ store: makeControlStore(baseline()), pkg: null, mode: "apply" }), /package/);
});

/* ---- P12 (cont). Honest COMMIT_UNKNOWN: phase-aware failure handling ---- */
test("P12j. a SUCCESSFUL commit returns code 0 committed, with exactly one begin + one commit + zero rollback", async () => {
  const pkg = controlPkg.buildPriorityControlPackage({ accounts: ["A01"], operator: "op", controlledReportKeys: CONTROLLED });
  const store = makeControlStore(baseline());
  const r = await runTxn(store, pkg, "apply");
  assert.equal(r.committed, true); assert.equal(r.code, 0);
  assert.deepEqual(store._calls, { begin: 1, commit: 1, rollback: 0 });
});
test("P12k. a PRE-COMMIT failure performs EXACTLY ONE rollback and returns ordinary failure (code 1, never COMMIT_UNKNOWN)", async () => {
  const pkg = controlPkg.buildPriorityControlPackage({ accounts: ["A01"], operator: "op", controlledReportKeys: CONTROLLED });
  const store = makeControlStore(baseline({ rollout: [{ account_id: "STRAY", enabled: true }] }), { freezeWritesFor: ["rollout"] });
  const r = await runTxn(store, pkg, "apply");
  assert.equal(r.committed, false); assert.equal(r.code, 1); assert.notEqual(r.commitUnknown, true);
  assert.deepEqual(store._calls, { begin: 1, commit: 0, rollback: 1 }, "exactly one rollback, commit never attempted");
});
test("P12l. COMMIT_UNKNOWN: a lost commit ack returns code 3, does NOT rollback, does NOT retry, and demands read-only reconciliation", async () => {
  const pkg = controlPkg.buildPriorityControlPackage({ accounts: ["A01"], operator: "op", controlledReportKeys: CONTROLLED });
  const store = makeControlStore(baseline(), { failCommit: true });
  const r = await runTxn(store, pkg, "apply");
  assert.equal(r.committed, false); assert.equal(r.code, 3); assert.equal(r.commitUnknown, true);
  assert.match(r.problem, /COMMIT_UNKNOWN/);
  assert.match(r.instruction, /READ-ONLY reconciliation/i);
  assert.deepEqual(store._calls, { begin: 1, commit: 1, rollback: 0 }, "the commit was attempted; NO rollback, NO retry");
});
test("P12m. a rollback FAILURE on a pre-commit error does NOT hide the ORIGINAL pre-commit error", async () => {
  const pkg = controlPkg.buildPriorityControlPackage({ accounts: ["A01"], operator: "op", controlledReportKeys: CONTROLLED });
  const store = makeControlStore(baseline({ rollout: [{ account_id: "STRAY", enabled: true }] }), { freezeWritesFor: ["rollout"], failRollback: true });
  const r = await runTxn(store, pkg, "apply");
  assert.equal(r.committed, false); assert.equal(r.code, 1);
  assert.ok(r.problems.some((p) => /rollout-enabled/.test(p)), "the ORIGINAL pre-commit POST error is preserved");
  assert.match(r.rollbackError, /rollback failed/, "the rollback failure is reported SEPARATELY, not hiding the original");
});

/* ---- P12 (cont). Audited approval revocation (operator + PostgreSQL now() on every revoke) ---- */
test("P12n. APPLY-time removal of an EXTRA approval is AUDITED: the revoked row gets the operator + a NEW timestamp", async () => {
  const pkg = controlPkg.buildPriorityControlPackage({ accounts: ["A01"], operator: "auditor@x", controlledReportKeys: CONTROLLED });
  const store = makeControlStore(baseline({ approvals: [{ pair: "keyword-rank|A01", approved_by: "old-op", approved_at: 5 }] }));
  const r = await runTxn(store, pkg, "apply");
  assert.equal(r.committed, true, JSON.stringify(r));
  const revoked = (await store.approvalRows()).find((x) => x.report_key === "keyword-rank" && x.account_id === "A01");
  assert.equal(revoked.approved, false); assert.equal(revoked.approved_by, "auditor@x", "revocation audited with the operator");
  assert.ok(revoked.approved_at > 5, "revocation stamped a NEW timestamp (" + revoked.approved_at + " > 5)");
});
test("P12o. SAFE-CLOSE revocation is AUDITED: every approval gets the operator + a NEW timestamp", async () => {
  const pkg = controlPkg.buildPriorityControlPackage({ accounts: ["A01"], operator: "closer@x", controlledReportKeys: CONTROLLED });
  const store = makeControlStore(baseline({ approvals: [{ pair: "daily-reporting|A01", approved_by: "old", approved_at: 3 }, { pair: "brand-sales|A01", approved_by: "old", approved_at: 3 }] }));
  const r = await runTxn(store, pkg, "rollback");
  assert.equal(r.committed, true, JSON.stringify(r));
  for (const row of await store.approvalRows()) {
    assert.equal(row.approved, false);
    assert.equal(row.approved_by, "closer@x", row.report_key + " revocation audited");
    assert.ok(row.approved_at > 3, row.report_key + " revocation stamped a new timestamp");
  }
});
test("P12p. a later transaction FAILURE restores the PREVIOUS approved + audit values (rollback of audited writes)", async () => {
  const pkg = controlPkg.buildPriorityControlPackage({ accounts: ["A01"], operator: "op", controlledReportKeys: CONTROLLED });
  // seed a prior audited approval; a POST mismatch (frozen rollout stray) rolls the whole txn back.
  const store = makeControlStore(baseline({ rollout: [{ account_id: "STRAY", enabled: true }], approvals: [{ pair: "keyword-rank|A01", approved_by: "prev-op", approved_at: 7 }] }), { freezeWritesFor: ["rollout"] });
  const r = await runTxn(store, pkg, "apply");
  assert.equal(r.committed, false);
  const row = (await store.approvalRows()).find((x) => x.report_key === "keyword-rank" && x.account_id === "A01");
  assert.equal(row.approved, true, "the previous approval is restored"); assert.equal(row.approved_by, "prev-op"); assert.equal(row.approved_at, 7, "the previous audit timestamp is restored");
});
test("P12q. runControlPackageTransaction rejects a blank / noncanonical operator BEFORE begin (zero begin calls)", async () => {
  const store = makeControlStore(baseline());
  const blankPkg = { mode: "safe-close", operator: "", controlled: CONTROLLED, post: {} };
  await assert.rejects(() => controlPkg.runControlPackageTransaction({ store, pkg: blankPkg, mode: "rollback", controlledReportKeys: CONTROLLED }), /canonical operator/);
  const spacePkg = { mode: "safe-close", operator: "has space", controlled: CONTROLLED, post: {} };
  await assert.rejects(() => controlPkg.runControlPackageTransaction({ store, pkg: spacePkg, mode: "rollback", controlledReportKeys: CONTROLLED }), /canonical operator/);
  assert.equal(store._calls.begin, 0, "no transaction was opened for a bad operator");
});

/* ---- P12 (cont). Discovery-independent safe-close via runControlPackageCli ---- */
test("P12r. runControlPackageCli --rollback executes the safe-close EVEN WHEN DataDoe discovery throws (zero discovery calls)", async () => {
  let discoveryCalls = 0;
  const applied = { allPrimary: false, cron: false,
    rollout: [{ account_id: "A01", enabled: true }, { account_id: "A02", enabled: true }],
    dispatch: CONTROLLED.map((rk) => ({ report_key: rk, schedule_enabled: ["daily-reporting", "brand-sales"].includes(rk) })),
    promoted: [{ report_key: "brand-inventory", publish_enabled: true }],
    approvals: [{ pair: "daily-reporting|A01", approved_by: "x", approved_at: 1 }, { pair: "brand-sales|A02", approved_by: "x", approved_at: 1 }] };
  const store = makeControlStore(applied);
  const r = await controlPkg.runControlPackageCli({
    mode: "rollback", operator: "closer@x", controlledReportKeys: CONTROLLED,
    discoverAccounts: async () => { discoveryCalls += 1; throw new Error("DataDoe unavailable"); },
    connectStore: async () => store,
  });
  assert.equal(r.committed, true, "safe-close committed even though DataDoe was down: " + JSON.stringify(r));
  assert.equal(discoveryCalls, 0, "the safe-close made ZERO DataDoe discovery calls");
  assert.equal((await store.rolloutRows()).filter((x) => x.enabled).length, 0, "every rollout disabled");
  assert.equal((await store.dispatchRows()).filter((x) => x.schedule_enabled).length, 0, "all dispatch paused");
  assert.equal((await store.promotedRows()).filter((x) => x.publish_enabled).length, 0, "promoted disabled");
  const appr = await store.approvalRows();
  assert.equal(appr.filter((x) => x.approved).length, 0, "every approval revoked");
  assert.ok(appr.every((x) => x.approved_by === "closer@x"), "every revocation audited with the operator");
});
test("P12s. runControlPackageCli --apply DOES discover (and propagates a discovery failure); dry-run discovers but never writes", async () => {
  await assert.rejects(() => controlPkg.runControlPackageCli({ mode: "apply", operator: "op@x", controlledReportKeys: CONTROLLED, discoverAccounts: async () => { throw new Error("DataDoe unavailable"); }, connectStore: async () => makeControlStore(baseline()) }), /DataDoe unavailable/);
  let connected = 0;
  const dry = await controlPkg.runControlPackageCli({ mode: "dry-run", operator: "op@x", controlledReportKeys: CONTROLLED, discoverAccounts: async () => ["A01", "A02"], connectStore: async () => { connected += 1; return makeControlStore(baseline()); } });
  assert.equal(dry.dryRun, true); assert.deepEqual(dry.pkg.accounts, ["A01", "A02"]);
  assert.equal(connected, 0, "dry-run never connects the store / writes");
});
test("P12t. buildPrioritySafeClosePackage needs NO accounts and fails closed on a blank/noncanonical operator", () => {
  const pkg = controlPkg.buildPrioritySafeClosePackage({ operator: "op@x" });
  assert.equal(pkg.mode, "safe-close"); assert.equal(pkg.operator, "op@x"); assert.ok(!("accounts" in pkg) || pkg.accounts === undefined);
  assert.throws(() => controlPkg.buildPrioritySafeClosePackage({ operator: "" }), /canonical operator/);
  assert.throws(() => controlPkg.buildPrioritySafeClosePackage({ operator: "bad op" }), /canonical operator/);
});

/* ===================== P13. the failed-v1-cycle cleanup (exact benign footprint only) ===================== */
group("P13. failed-cycle cleanup: exact footprint proof; dry-run; guarded delete; every mismatch => zero writes");
const ORG_SCOPE = "__organization";
function benignCycle() {
  return {
    cycle: { id: "cyc-v1-us", bucket: "us", status: "running", trigger: "manual" },
    sourceJobs: [{ source_key: "product-catalog", fetch_status: "failed", terminal: true, export_id: null, error_stage: "create-export", create_export_count: 1 }],
    owners: [{ request_hash: "h", account_id: ORG_SCOPE }],
    reportJobs: [],
    budgets: [{ tranche_key: "source-sync:product-catalog", spent_creates: 1, spent_tokens: 2 }], // reserved the one (failed) create's cost -- no REAL token spent (export_id null)
    snapshotCount: 0,
  };
}
function makeCleanupStore(initial, opts = {}) {
  const clone = (o) => (o == null ? null : JSON.parse(JSON.stringify(o)));
  let state = clone(initial);
  let snapshot = null;
  const calls = { begin: 0, commit: 0, rollback: 0, del: 0 };
  return {
    _calls: calls, _state: () => state,
    begin: async () => { calls.begin += 1; snapshot = clone(state); if (opts.mutateOnLock) opts.mutateOnLock(state); },
    commit: async () => { calls.commit += 1; if (opts.failCommit) throw new Error("commit ack lost"); snapshot = null; },
    rollback: async () => { calls.rollback += 1; if (opts.failRollback) throw new Error("rollback failed"); if (snapshot) state = snapshot; },
    read: async () => clone(state),
    deleteFootprint: async () => { calls.del += 1; if (opts.brokenDelete) return; state = { cycle: null, sourceJobs: [], owners: [], reportJobs: [], budgets: [], snapshotCount: 0 }; },
  };
}
const runCleanup = (store, mode) => cleanupMod.runFailedCycleCleanupTransaction({ store, cycleId: "cyc-v1-us", mode, organizationScopeKey: ORG_SCOPE });

test("P13a. the EXACT benign failed-Catalog footprint: dry-run writes nothing; apply deletes the cycle footprint and COMMITS", async () => {
  const dryStore = makeCleanupStore(benignCycle());
  const dry = await runCleanup(dryStore, "dry-run");
  assert.equal(dry.dryRun, true); assert.equal(dry.code, 0); assert.deepEqual(dryStore._calls, { begin: 0, commit: 0, rollback: 0, del: 0 }, "dry-run writes nothing");
  const store = makeCleanupStore(benignCycle());
  const r = await runCleanup(store, "apply");
  assert.equal(r.committed, true); assert.equal(r.code, 0);
  assert.equal(store._state().cycle, null, "the cycle row is gone");
  assert.deepEqual(store._calls, { begin: 1, commit: 1, rollback: 0, del: 1 });
});
test("P13b. EVERY footprint mismatch is refused with ZERO writes (dry-run AND apply)", async () => {
  const mutations = [
    ["terminal cycle", (c) => { c.cycle.status = "succeeded"; }, /cycle-not-running/],
    ["two source jobs", (c) => { c.sourceJobs.push({ ...c.sourceJobs[0] }); }, /source-job-count/],
    ["a non-catalog source job", (c) => { c.sourceJobs[0].source_key = "order-line-items"; }, /non-catalog-source-job/],
    ["a succeeded source job", (c) => { c.sourceJobs[0].fetch_status = "succeeded"; }, /has-succeeded-source-job|source-job-not-failed/],
    ["a real export id", (c) => { c.sourceJobs[0].export_id = "e_1"; }, /has-datadoe-export-id/],
    ["report jobs present", (c) => { c.reportJobs.push({ report_key: "daily-reporting", validated: false }); }, /has-report-jobs/],
    ["a non-org owner", (c) => { c.owners[0].account_id = "A01"; }, /owner-not-org-scope/],
    ["a stray snapshot", (c) => { c.snapshotCount = 3; }, /has-snapshots/],
    ["more than one recorded create", (c) => { c.budgets[0].spent_creates = 2; }, /budget-multiple-creates/],
    ["wrong error stage", (c) => { c.sourceJobs[0].error_stage = "poll"; }, /error-stage-not-create-export/],
  ];
  for (const [name, mut, re] of mutations) {
    const fixture = benignCycle(); mut(fixture);
    const dryStore = makeCleanupStore(fixture);
    const dry = await runCleanup(dryStore, "dry-run");
    assert.equal(dry.code, 1, name + " (dry)"); assert.ok(dry.problems.some((p) => re.test(p)), name + " -> " + JSON.stringify(dry.problems));
    assert.deepEqual(dryStore._calls, { begin: 0, commit: 0, rollback: 0, del: 0 }, name + " dry writes nothing");
    const store = makeCleanupStore(fixture);
    const r = await runCleanup(store, "apply");
    assert.equal(r.code, 1, name + " (apply)"); assert.equal(store._calls.del, 0, name + " apply deletes nothing");
    assert.ok(store._state().cycle, name + " cycle preserved");
  }
});
test("P13c. COMMIT_UNKNOWN: a lost commit ack returns code 3, does NOT rollback, demands read-only reconciliation", async () => {
  const store = makeCleanupStore(benignCycle(), { failCommit: true });
  const r = await runCleanup(store, "apply");
  assert.equal(r.code, 3); assert.equal(r.commitUnknown, true); assert.match(r.instruction, /READ-ONLY reconciliation/i);
  assert.deepEqual(store._calls, { begin: 1, commit: 1, rollback: 0, del: 1 }, "attempted commit; NO rollback");
});
test("P13d. a footprint that CHANGES under the advisory lock is refused inside the transaction (rollback, cycle preserved)", async () => {
  // the locked re-read observes a second source job that appeared after the dry assessment.
  const store = makeCleanupStore(benignCycle(), { mutateOnLock: (s) => { s.sourceJobs.push({ source_key: "product-catalog", fetch_status: "failed", terminal: true, export_id: null, error_stage: "create-export" }); } });
  const r = await runCleanup(store, "apply");
  assert.equal(r.code, 1); assert.match(r.problem, /PRE \(locked\)/); assert.equal(store._calls.del, 0, "nothing deleted");
  assert.deepEqual(store._calls, { begin: 1, commit: 0, rollback: 1, del: 0 });
});
test("P13e. a broken delete that leaves the cycle fails the POST and rolls back (code 1)", async () => {
  const store = makeCleanupStore(benignCycle(), { brokenDelete: true });
  const r = await runCleanup(store, "apply");
  assert.equal(r.code, 1); assert.match(r.problem, /POST/); assert.equal(store._calls.rollback, 1);
});
test("P13f. fails closed on a bad mode / missing store / blank cycleId", async () => {
  await assert.rejects(() => cleanupMod.runFailedCycleCleanupTransaction({ store: makeCleanupStore(benignCycle()), cycleId: "c", mode: "delete" }), /apply.*dry-run/);
  await assert.rejects(() => cleanupMod.runFailedCycleCleanupTransaction({ store: null, cycleId: "c", mode: "dry-run" }), /store/);
  await assert.rejects(() => cleanupMod.runFailedCycleCleanupTransaction({ store: makeCleanupStore(benignCycle()), cycleId: "", mode: "dry-run" }), /exact cycleId/);
});

async function main() {
  out("priority dashboards release proof suite");
  priorityMod = await import("../lib/server/sync/source-priority-dashboards.js");
  releaseRunner = await import("../lib/server/sync/source-priority-release-runner.js");
  controlPkg = await import("../lib/server/sync/source-priority-control-package.js");
  cleanupMod = await import("../lib/server/sync/source-failed-cycle-cleanup.js");
  planMod = await import("../lib/server/sync/source-bucket-sync.js");
  brandView = await import("../lib/server/reports/brand-view.js");
  pubComposition = await import("../lib/server/sync/publisher-composition.js");
  publisherCore = await import("../lib/server/sync/report-publisher.js");
  reportDerivation = await import("../lib/server/sync/report-derivation.js");
  reportStore = await import("../lib/server/report-store.js");
  supabaseMod = await import("../lib/server/supabase.js");

  let failures = 0;
  for (const t of tests) {
    if (t.marker) { out("-- " + t.marker); continue; }
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (e) { failures += 1; out("FAIL  " + t.name); out(String((e && e.stack) || e)); }
  }
  out("\n" + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : ""));
  if (failures) process.exitCode = 1;
}

main();
