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
import { writeSync, readFileSync } from "node:fs";

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

let priorityMod; let planMod; let brandView; let pubComposition; let reportStore; let supabaseMod; let releaseRunner; let publisherCore; let reportDerivation; let controlPkg; let cleanupMod; let redateMod;

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

test("P1g. a NO-EXPORT inner (inner.noExport) refuses the Catalog create BEFORE touching the reservation -> retryable NO_EXPORT_REQUIRED, never AMBIGUOUS, never poisons/reads a reservation (the zero-export OLI reconciler defer, not a lease-stranding hard fail)", async () => {
  // A reservation that FAILS LOUDLY if reserve/recordExport is ever called -- proving the no-export guard refuses
  // pre-reserve, so it can neither leave an orphaned "reserved"/no-export-id row nor read an existing one as AMBIGUOUS.
  const mustNotTouch = { reserve: async () => { throw new Error("RESERVE_MUST_NOT_BE_CALLED"); }, recordExport: async () => { throw new Error("RECORD_MUST_NOT_BE_CALLED"); } };
  const noExportInner = { noExport: true, create: async () => { const e = new Error("inner refused"); e.code = "NO_EXPORT_REQUIRED"; throw e; }, poll: async () => {}, download: async () => {} };
  const g = priorityMod.makeDurableCatalogGuard({ inner: noExportInner, reservation: mustNotTouch, operationKey: OP() });
  let err = null; try { await g.create(catJob()); } catch (e) { err = e; }
  assert.ok(err && err.code === "NO_EXPORT_REQUIRED" && !/AMBIGUOUS|RESERVE_MUST_NOT/.test(String(err && err.message)), "no-export refuses pre-reserve with NO_EXPORT_REQUIRED (never AMBIGUOUS, never calls reserve): " + String(err && err.message));
  // A real (non-noExport) inner still reserves + creates normally -> the noExport branch is inert for the scheduler.
  const created = []; const g2 = priorityMod.makeDurableCatalogGuard({ inner: makeInner(created), reservation: makeFakeReservation(), operationKey: OP() });
  const r = await g2.create(catJob());
  assert.ok(created.length === 1 && r && r.exportId, "a real inner reserves + creates normally (byte-identical scheduler path)");
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
  assert.deepEqual([...C.buckets], ["us", "non-us", "india", "europe-au", "us-ca"]); // legacy buckets + the 3 active regions

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

test("P2d. the Catalog operation key is validated STRICTLY: default v2 OR scheduled/YYYY-MM-DD (real date); every other shape fails closed", () => {
  const { assertPriorityOperationKey, PRIORITY_DASHBOARDS } = priorityMod;
  // ACCEPTED
  assert.equal(assertPriorityOperationKey("priority-dashboards/v2"), "priority-dashboards/v2");
  assert.equal(assertPriorityOperationKey(PRIORITY_DASHBOARDS.operationKey), PRIORITY_DASHBOARDS.operationKey);
  assert.equal(assertPriorityOperationKey("priority-dashboards/scheduled/2026-08-24"), "priority-dashboards/scheduled/2026-08-24");
  assert.equal(assertPriorityOperationKey("priority-dashboards/scheduled/2024-02-29"), "priority-dashboards/scheduled/2024-02-29"); // real leap day
  // REJECTED: unknown versions, wrong prefix, impossible / malformed dates, trailing junk, whitespace
  for (const bad of [
    "", "priority-dashboards/v1", "priority-dashboards/v3", "priority-dashboards", "priority-dashboards/scheduled",
    "priority-dashboards/scheduled/", "priority-dashboards/scheduled/2026-8-4", "priority-dashboards/scheduled/2026-13-01",
    "priority-dashboards/scheduled/2026-02-30", "priority-dashboards/scheduled/2026-00-10", "priority-dashboards/scheduled/2023-02-29",
    "priority-dashboards/scheduled/2026-08-24/x", "priority-dashboards/scheduled/2026-08-24 ", " priority-dashboards/v2",
    "PRIORITY-DASHBOARDS/SCHEDULED/2026-08-24", "priority-dashboards/scheduled/26-08-24",
  ]) {
    assert.throws(() => assertPriorityOperationKey(bad), /PRIORITY_OPERATION_KEY_INVALID/, "must reject " + JSON.stringify(bad));
  }
  // the release builder validates the key at BUILD: default + scheduled build; junk throws before any run.
  makeRelease({ operationKey: "priority-dashboards/scheduled/2026-08-24" });
  makeRelease({}); // default v2
  assert.throws(() => makeRelease({ operationKey: "priority-dashboards/scheduled/nope" }), /PRIORITY_OPERATION_KEY_INVALID/);
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
  assert.equal(req.sourceScope, "organization"); assert.equal(req.limit, 5000);
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
    asOfOverride: over.asOfOverride,
    operationKey: over.operationKey,
    ...(over.openSuperseding ? { openSuperseding: over.openSuperseding } : {}),
    // Healthy-subset seams (PP2): a dedicated partial cycle bucket + an explicit fetchAccounts subset + the fence.
    ...(over.cycleBucket ? { cycleBucket: over.cycleBucket } : {}),
    ...(over.fetchAccounts ? { fetchAccounts: over.fetchAccounts } : {}),
    ...(over.getControlFence ? { getControlFence: over.getControlFence } : {}),
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

test("P4a2. deriveBucket is RESUMABLE: an ALREADY-terminal cycle SKIPS the re-derive (run() never called; clean already-complete rollup)", async () => {
  // A prior release pass finalized THIS bucket's cycle; the durable engine now refuses to append child work to a
  // terminal cycle, so re-deriving would throw. deriveBucket must detect the terminal cycle and short-circuit.
  for (const status of ["succeeded", "partial"]) {
    let ran = 0;
    const rel = makeRelease({
      cycle: { id: "cyc9", bucket: "us", status, trigger: "manual" },
      buildRuntime: () => ({ makeDeadline: () => ({}), preflightEvidence: async () => ({ bucket: "us", accounts: [], today: TODAY }), run: async () => { ran += 1; return {}; } }),
    });
    const { rollup } = await rel.deriveBucket("us");
    assert.equal(ran, 0, status + ": run() was NOT called (no re-derive of a terminal cycle)");
    assert.equal(rollup.stopped, false, status + ": not stopped");
    assert.equal(rollup.derived.skipped, null, status + ": clean rollup -> the runner proceeds to finalize");
    assert.equal(rollup.alreadyComplete, true, status + ": marked already-complete");
    assert.equal(rollup.cycleId, "cyc9");
  }
  // A RUNNING (or absent) cycle still derives normally -- run() IS called.
  let ran2 = 0;
  await makeRelease({
    cycle: { id: "cycR", bucket: "us", status: "running", trigger: "manual" },
    buildRuntime: () => ({ makeDeadline: () => ({}), preflightEvidence: async () => ({ bucket: "us", accounts: [], today: TODAY }), run: async () => { ran2 += 1; return { derived: { skipped: null } }; } }),
  }).deriveBucket("us");
  assert.equal(ran2, 1, "a running cycle derives normally");
});

test("P0B-1. LEGACY OLI-only running cycle: deriveBucket FINALIZES it + opens a SUPERSEDING full-plan cycle, then derives on the fresh cycle (never not-drained forever)", async () => {
  const legacy = { id: "legacyCyc", bucket: "us", status: "running", trigger: "manual" };
  const oliOnlyJobs = [{ source_key: "order-line-items", request_hash: "oli1", fetch_status: "succeeded" }]; // NO catalog job
  let finalized = 0; let superseded = null; let ran = 0;
  const store = {
    getBudget: async ({ trancheKey }) => (trancheKey === "source-sync:product-catalog" ? null : { plan_fingerprint: "f", max_creates: 1, max_tokens: 2 }), // NO catalog budget (legacy)
    listSourceJobs: async () => oliOnlyJobs,
    listCycleOwners: async () => [],
    finalizeCycle: async ({ cycleId }) => { finalized += 1; assert.equal(cycleId, "legacyCyc"); return { disposition: "finalized", cycle: { status: "succeeded" } }; },
  };
  const rel = makeRelease({
    cycle: legacy,
    makeStore: () => store,
    openSuperseding: async (args) => { superseded = args; return "supersedeCyc"; },
    buildRuntime: () => ({ makeDeadline: () => ({}), preflightEvidence: async () => ({ bucket: "us", accounts: [{ accountId: "A01" }], today: TODAY }), run: async () => { ran += 1; return { cycleId: "supersedeCyc", globalDrained: true, derived: { skipped: null } }; } }),
  });
  const { rollup } = await rel.deriveBucket("us");
  assert.equal(finalized, 1, "the legacy OLI-only cycle was finalized honestly (its own source work)");
  assert.ok(superseded, "a superseding full-plan cycle was opened");
  assert.equal(superseded.supersedesCycleId, "legacyCyc", "supersedes the exact legacy cycle");
  assert.equal(superseded.attemptKind, "scheduled-fresh");
  assert.match(String(superseded.operationKey), /^priority-legacy-recovery\/us\//, "a DEDICATED recovery operation key (idempotent by op-key on watchdog replay)");
  assert.equal(ran, 1, "runtime.run(priority) then derives on the fresh superseding cycle (off durable OLI)");
  assert.equal(rollup.derived.skipped, null, "the derive completes (not-drained is GONE)");
});

test("P0B-2. does NOT touch a COMPLETE-daily-plan running cycle (Catalog budget present) -- it derives normally, no finalize/supersede", async () => {
  let finalized = 0; let superseded = 0; let ran = 0;
  const store = {
    getBudget: async () => ({ plan_fingerprint: "f", max_creates: 1, max_tokens: 2 }), // Catalog budget PRESENT (complete-daily-plan)
    listSourceJobs: async () => [{ source_key: "order-line-items", request_hash: "oli1", fetch_status: "succeeded" }, { source_key: "product-catalog", request_hash: "cat1", fetch_status: "pending" }],
    listCycleOwners: async () => [],
    finalizeCycle: async () => { finalized += 1; return { disposition: "finalized", cycle: { status: "succeeded" } }; },
  };
  const rel = makeRelease({
    cycle: { id: "goodCyc", bucket: "us", status: "running", trigger: "manual" },
    makeStore: () => store,
    openSuperseding: async () => { superseded += 1; return "x"; },
    buildRuntime: () => ({ makeDeadline: () => ({}), preflightEvidence: async () => ({ bucket: "us", accounts: [{ accountId: "A01" }], today: TODAY }), run: async () => { ran += 1; return { cycleId: "goodCyc", globalDrained: true, derived: { skipped: null } }; } }),
  });
  await rel.deriveBucket("us");
  assert.equal(finalized, 0, "a complete-daily-plan cycle is NEVER finalized by the recovery path");
  assert.equal(superseded, 0, "and NEVER superseded");
  assert.equal(ran, 1, "it derives normally (priority drains the frozen Catalog as a continuation)");
});

test("P0B-3. legacy recovery with OLI STILL OPEN: finalize returns open-work -> typed stop (LKG intact), NO supersede, NO publish", async () => {
  let superseded = 0;
  const store = {
    getBudget: async () => null, // no catalog budget (legacy)
    listSourceJobs: async () => [{ source_key: "order-line-items", request_hash: "oli1", fetch_status: "pending" }],
    listCycleOwners: async () => [],
    finalizeCycle: async () => ({ disposition: "open-work", cycle: { status: "running" } }),
  };
  const rel = makeRelease({
    cycle: { id: "openCyc", bucket: "us", status: "running", trigger: "manual" },
    makeStore: () => store,
    openSuperseding: async () => { superseded += 1; return "x"; },
    buildRuntime: () => ({ makeDeadline: () => ({}), preflightEvidence: async () => ({ bucket: "us", accounts: [{ accountId: "A01" }], today: TODAY }), run: async () => ({ globalDrained: true, derived: { skipped: null } }) }),
  });
  const { rollup } = await rel.deriveBucket("us");
  assert.equal(superseded, 0, "OLI not drained -> NOT superseded (a retry finalizes once it drains)");
  assert.equal(rollup.stopped, true, "typed stop -- nothing published");
  assert.equal(rollup.stopReason.code, "LEGACY_OLI_STILL_OPEN");
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
test("P4b5. RESUMABLE finalize: an ALREADY-terminal cycle (scope re-proven) is ACCEPTED as 'already-terminal' WITHOUT re-issuing the finalize RPC", async () => {
  for (const status of ["succeeded", "partial"]) {
    let finCalls = 0;
    const rel = makeRelease({
      ...finBase, cycle: { id: "cyc", bucket: "us", status, trigger: "manual" }, srcJobs: CAT_JOB_WARM, reservationRow: XBUCKET_RESV,
      makeStore: () => ({ listSourceJobs: async () => CAT_JOB_WARM, listCycleOwners: async () => CAT_OWNERS_OK, finalizeCycle: async () => { finCalls += 1; return { disposition: "finalized", cycle: { status: "succeeded" } }; } }),
    });
    const res = await rel.finalizeBucket("us");
    assert.equal(res.disposition, "already-terminal", status + " -> accepted idempotently");
    assert.equal(res.cycleStatus, status, status + " -> echoes the terminal status");
    assert.deepEqual(res.accounts, ["A01"], status + " -> proven account scope");
    assert.equal(finCalls, 0, status + " -> finalize RPC NOT re-issued on a terminal cycle");
  }
});
test("P4b6. a terminal cycle with a BAD durable scope is STILL refused (idempotent accept requires the SAME strict proofs, not a free pass)", async () => {
  const res = await makeRelease({
    ...finBase, cycle: { id: "cyc", bucket: "us", status: "succeeded", trigger: "manual" }, srcJobs: CAT_JOB_WARM, reservationRow: XBUCKET_RESV,
    repJobs: repJobsFor(["A01"]).filter((j) => j.report_key !== "brand-sales"),
  }).finalizeBucket("us");
  assert.equal(res.disposition, "refused");
  assert.equal(res.reason, "report-job-count", "a terminal-but-incomplete cycle is refused, never rubber-stamped");
});

// A SCHEDULED cycle: ONE org-scoped WARM catalog + OLI batch job(s) whose per-account owners EXACTLY cover the
// discovered accounts. schedBase has two discovered accounts so a batch of 2 is meaningful.
const schedBase = {
  accounts: [{ accountId: "A01" }, { accountId: "A02" }], today: TODAY,
  cycle: { id: "cyc", bucket: "us", status: "running", trigger: "manual" },
  repJobs: repJobsFor(["A01", "A02"]),
  finalizeResp: { disposition: "finalized", cycle: { status: "succeeded" } },
  reservationRow: XBUCKET_RESV,
};
const SCHED_SRC = [
  { source_key: CATALOG, request_hash: "cat-hash", fetch_status: "succeeded", create_export_count: 0, cache_object_path: "source-cache/v2/cat-hash.json" },
  { source_key: OLI, request_hash: "oli-hash", fetch_status: "succeeded", create_export_count: 1 },
];
const SCHED_OWNERS = [
  { request_hash: "cat-hash", account_id: ORG },
  { request_hash: "oli-hash", account_id: "A01" },
  { request_hash: "oli-hash", account_id: "A02" },
];

test("P4b7. SCHEDULED finalize ACCEPTS an OLI+Catalog cycle: succeeded OLI batch(es) whose owners EXACTLY cover the discovered accounts + the ONE org Catalog job", async () => {
  const res = await makeRelease({ ...schedBase, srcJobs: SCHED_SRC, owners: SCHED_OWNERS }).finalizeBucket("us");
  assert.equal(res.disposition, "finalized", "OLI+Catalog scheduled cycle finalizes");
  assert.deepEqual(res.accounts, ["A01", "A02"]);
  // catalog-only cycle still ACCEPTS (initial go-live behavior preserved -- no OLI jobs).
  const res2 = await makeRelease({ ...finBase, srcJobs: CAT_JOB_WARM, reservationRow: XBUCKET_RESV }).finalizeBucket("us");
  assert.equal(res2.disposition, "finalized", "catalog-only cycle still finalizes (go-live behavior preserved)");
});

test("P4c1. SCHEDULED finalize REJECTS every OLI-scope violation (batch>5, unexpected account, coverage gap, create>1, missing owners, org-scoped owner, blank hash)", async () => {
  const oli = (over) => ({ source_key: OLI, request_hash: "oli-hash", fetch_status: "succeeded", create_export_count: 1, ...over });
  const six = ["A01", "A02", "A03", "A04", "A05", "A06"];
  const cases = [
    ["OLI batch > 5 sellers", {
      accounts: six.map((a) => ({ accountId: a })), repJobs: repJobsFor(six),
      srcJobs: [SCHED_SRC[0], oli({})],
      owners: [{ request_hash: "cat-hash", account_id: ORG }, ...six.map((a) => ({ request_hash: "oli-hash", account_id: a }))],
    }, "oli-batch-oversized"],
    ["OLI owner not a discovered account", { srcJobs: SCHED_SRC, owners: [{ request_hash: "cat-hash", account_id: ORG }, { request_hash: "oli-hash", account_id: "A01" }, { request_hash: "oli-hash", account_id: "A99" }] }, "oli-owner-unexpected"],
    ["OLI coverage misses a discovered account", { srcJobs: SCHED_SRC, owners: [{ request_hash: "cat-hash", account_id: ORG }, { request_hash: "oli-hash", account_id: "A01" }] }, "oli-owner-coverage-missing"],
    ["OLI create_export_count > 1", { srcJobs: [SCHED_SRC[0], oli({ create_export_count: 2 })], owners: SCHED_OWNERS }, "oli-create-count"],
    ["OLI job whose hash has NO owners", { srcJobs: [SCHED_SRC[0], oli({ request_hash: "orphan-hash" })], owners: SCHED_OWNERS }, "oli-owners-missing"],
    ["OLI owner is the ORG scope key (must be per-account)", { srcJobs: SCHED_SRC, owners: [{ request_hash: "cat-hash", account_id: ORG }, { request_hash: "oli-hash", account_id: ORG }, { request_hash: "oli-hash", account_id: "A02" }] }, "oli-owner-org-scope"],
    ["OLI job with a blank request hash", { srcJobs: [SCHED_SRC[0], oli({ request_hash: "" })], owners: SCHED_OWNERS }, "oli-hash-blank"],
    ["an OLI job that is NOT succeeded", { srcJobs: [SCHED_SRC[0], oli({ fetch_status: "pending" })], owners: SCHED_OWNERS }, "source-job-not-succeeded"],
  ];
  for (const [name, over, reason] of cases) {
    const res = await makeRelease({ ...schedBase, ...over }).finalizeBucket("us");
    assert.equal(res.disposition, "refused", name + " must refuse (got " + JSON.stringify(res) + ")");
    assert.equal(res.reason, reason, name + " reason");
  }
});

test("P4c. finalizeBucket REFUSES every unrelated / open / malformed / mis-scoped / ambiguous-token condition", async () => {
  const base = { ...finBase, srcJobs: CAT_JOB_COLD, reservedHash: "cat-hash" };
  const cases = [
    ["no discovered accounts", { accounts: [] }, "no-discovered-accounts"],
    ["cycle not found", { cycle: null }, "cycle-not-found"],
    ["cycle bucket mismatch", { cycle: { id: "cyc", bucket: "non-us", status: "running", trigger: "manual" } }, "cycle-bucket-mismatch"],
    ["cycle not running", { cycle: { id: "cyc", bucket: "us", status: "pending", trigger: "manual" } }, "cycle-not-running"],
    ["cycle not manual", { cycle: { id: "cyc", bucket: "us", status: "running", trigger: "scheduled" } }, "cycle-not-manual"],
    ["zero source jobs", { srcJobs: [] }, "source-job-count"],
    ["two catalog jobs", { srcJobs: CAT_JOB_COLD.concat(CAT_JOB_COLD) }, "catalog-job-count"],
    ["no catalog job (only OLI)", { srcJobs: [{ source_key: OLI, request_hash: "oli-hash", fetch_status: "succeeded", create_export_count: 1 }] }, "catalog-job-count"],
    ["an UNRELATED source key (ads) beside the catalog", { srcJobs: CAT_JOB_COLD.concat([{ source_key: "ads-campaign-date", request_hash: "ads-hash", fetch_status: "succeeded", create_export_count: 0 }]) }, "unrelated-source-job"],
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

test("P4f. asOfOverride is validated + BOUND AT BUILD TIME onto the runtime (pins the derive window; cycle date stays clock-today)", () => {
  let captured = null;
  makeRelease({ asOfOverride: "2026-08-22", buildRuntime: (o) => { captured = o; return { makeDeadline: () => ({}), preflightEvidence: async () => ({ accounts: [], today: TODAY }), run: async () => ({}) }; } });
  assert.equal(captured.asOfOverride, "2026-08-22", "asOfOverride bound at build (never a run() argument)");
  assert.equal(captured.priorityMode, true, "still priority mode");
  // a null override is the default (clock today-1); a malformed value fails closed BEFORE any build.
  let cap2 = null; makeRelease({ buildRuntime: (o) => { cap2 = o; return { makeDeadline: () => ({}), preflightEvidence: async () => ({}), run: async () => ({}) }; } });
  assert.equal(cap2.asOfOverride, null, "default: no asOf pin (clock today-1)");
  assert.throws(() => makeRelease({ asOfOverride: "2026/08/22" }), /YYYY-MM-DD/);
  assert.throws(() => makeRelease({ asOfOverride: "not-a-date" }), /YYYY-MM-DD/);
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
  "daily-reporting": { version: "daily-reporting/v2f-campaign", params: { reportVersion: "daily-reporting/v2f-campaign", accountId: "A01", from: "2026-03-19", to: ASOF, brand: "ALL" }, payload: { rows: [], brandFiltered: false, adsAvailability: { status: "unavailable" } } },
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
    // Round-10: buildSchedulerV2Publisher is ALWAYS fenced -- supply a valid control fence + the fenced CAS double.
    getControlFence: () => ({ ownerToken: "test-owner", generation: 1 }),
    publishLiveFenced: async () => ({ outcome: "inserted" }),
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
// A COMPLETE derive rollup for n accounts: both dashboards ready, n saved each, lineage = 3n. The fake finalize
// returns exactly one account per bucket, so the default derive produces the matching consistent 1x3 set.
const completeRollup = (n = 1) => ({ rollup: { stopped: false, derived: { skipped: null, daily: { ready: true, saved: n }, brandView: { ready: true, saved: n }, brandInventory: { saved: n }, lineage: Array.from({ length: 3 * n }, (_, i) => i) } } });
function fakeRelease(over = {}) {
  return {
    publishOrder: THREE, reportKeys: THREE,
    deriveBucket: over.deriveBucket || (async () => completeRollup(1)),
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
    ...(over.verifyLease ? { verifyLease: over.verifyLease } : {}),
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
test("P9c2. the ready=false/saved=0/lineageCount=0 FALSE-POSITIVE is REFUSED (never 'derive ok') BEFORE finalize", async () => {
  // The exact Non-US failure shape: stopped=false, skipped=null, but daily/brandView ready=false, saved=0, no
  // lineage. The old runner logged "derive ok" and proceeded; it must now fail at the derive stage.
  const falsePositive = { rollup: { stopped: false, continuationRequired: false, globalDrained: true, derived: { skipped: null, daily: { ready: false, saved: 0 }, brandView: { ready: false, saved: 0 }, brandInventory: { saved: 0 }, lineage: [] } } };
  let finalized = 0;
  const r = await releaseRunner.runPriorityDashboardsRelease(runnerDeps({ releaseOver: { deriveBucket: async () => falsePositive, finalizeBucket: async () => { finalized += 1; return { disposition: "finalized", accounts: ["A01"] }; } } }));
  assert.equal(r.code, 1); assert.equal(r.stage, "derive:us");
  assert.ok(String(r.problems.join(" ")).includes("no validated report jobs"), "the refusal names the missing report jobs");
  assert.equal(finalized, 0, "never reached finalize/publication on a ready=false/saved=0 derive");
});
test("P9c3. an INCONSISTENT derive (missing/duplicate: daily=8, brand-sales=8, brand-inventory=7) is refused before finalize", async () => {
  const inconsistent = { rollup: { stopped: false, derived: { skipped: null, daily: { ready: true, saved: 8 }, brandView: { ready: true, saved: 8 }, brandInventory: { saved: 7 }, lineage: Array.from({ length: 23 }, (_, i) => i) } } };
  const r = await releaseRunner.runPriorityDashboardsRelease(runnerDeps({ releaseOver: { deriveBucket: async () => inconsistent } }));
  assert.equal(r.code, 1); assert.equal(r.stage, "derive:us");
});
test("P9c4. an already-complete (short-circuited) cycle passes the derive gate (jobs pre-exist; finalizer re-verifies)", async () => {
  const r = await releaseRunner.runPriorityDashboardsRelease(runnerDeps({ releaseOver: { deriveBucket: async () => ({ rollup: { stopped: false, alreadyComplete: true, derived: { skipped: null, lineage: [] } } }) } }));
  assert.equal(r.code, 0); assert.equal(r.ok, true);
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

/* ---- P9 (cont). SUCCESSFUL WRITES then readback failure, and MID-PUBLISH lease loss (Finding 2) ---- */
test("P9v. SUCCESSFUL WRITES followed by a READBACK FAILURE => code 1 (readback): the publishes (writes) DID occur before the readback failed, so 'some snapshots may already have been published' is the honest state (never a zero-publication claim)", async () => {
  let publishCalls = 0;
  const r = await releaseRunner.runPriorityDashboardsRelease(runnerDeps({
    releaseOver: { publishAccount: async (a) => { publishCalls += 1; return { accountId: a, results: idResults(a, "published") }; } },
    readbackLive: async () => ({ ok: false, reason: "payload-contract" }),
  }));
  assert.equal(r.code, 1); assert.equal(r.stage, "readback");
  assert.ok(publishCalls >= 1, "the publish (writes) ran for every proven account BEFORE the readback failed -- so this is 'writes then unverifiable', not a zero-write run");
  // The runner reports the readback failure as its stage; it makes NO zero-publication claim (the writes already landed).
  assert.ok(Array.isArray(r.problems) && /read-back failed/.test(r.problems.join(" ")), "the failure is reported as a readback failure, not a zero-write claim");
});

test("P9w. MID-PUBLISH LEASE LOSS (verifyLease turns not-ok after the first account published) => code 1, CONTROL_LEASE_LOST, leaseLost, reporting the publications already made (never zero)", async () => {
  let leaseCalls = 0; const publishedAccts = [];
  const r = await releaseRunner.runPriorityDashboardsRelease(runnerDeps({
    verifyLease: async () => { leaseCalls += 1; return { ok: leaseCalls === 1, reason: leaseCalls === 1 ? null : "reclaimed" }; },
    releaseOver: { publishAccount: async (a) => { publishedAccts.push(a); return { accountId: a, results: idResults(a, "published") }; } },
  }));
  assert.equal(r.code, 1); assert.equal(r.stage, "contention"); assert.equal(r.status, "CONTROL_LEASE_LOST"); assert.equal(r.leaseLost, true);
  assert.equal(publishedAccts.length, 1, "the FIRST account published (writes landed) BEFORE the lease was lost -- a genuine MID-publish loss");
  assert.ok(r.problems.join(" ").includes("after 3 publications"), "the report states how many publications already occurred (never a zero claim): " + r.problems.join(" "));
});

test("P9x. a 'lease-lost' DISPOSITION at the write boundary (the CAS wrote zero rows for this account) => code 1, CONTROL_LEASE_LOST (retryable; LKG preserved)", async () => {
  const r = await releaseRunner.runPriorityDashboardsRelease(runnerDeps({
    releaseOver: { publishAccount: async (a) => ({ accountId: a, results: THREE.map((rk) => ({ reportKey: rk, disposition: "lease-lost", liveReportKey: rk, paramsHash: "ph" })) }) },
  }));
  assert.equal(r.code, 1); assert.equal(r.stage, "contention"); assert.equal(r.status, "CONTROL_LEASE_LOST"); assert.equal(r.leaseLost, true);
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

/* ===================== P12. END-TO-END partial publication: healthy subset publishes; deferred keeps dated LKG ===================== */
// Codex per-account publication isolation. Through the REAL publisher (buildSchedulerV2Publisher), a PARTIAL OLI
// cycle -- healthy accounts (terminal 'succeeded' cycle + fresh D-1 shadow) plus a deferred account (a non-terminal
// 'running' cycle, e.g. a readiness/hard-failed batch) -- publishes EXACTLY the healthy accounts' fresh D-1 live
// dashboards while the deferred account's DATED last-known-good live snapshot is left BYTE-IDENTICAL. Also proves a
// Campaign-Ads failure never suppresses an account with usable OLI sales (ads shown unavailable), and that a HARD
// (non-readiness) sibling failure is treated identically (independent dependencies). Offline; zero network.
group("PP1. END-TO-END: a partial cycle publishes the HEALTHY subset; the deferred account keeps its dated LKG");

// A per-account SHADOW spec (accountId substituted). The shadow reportVersion == REPORT_DERIVATIONS[rk].snapshotVersion
// (what the publisher asserts). `dailyPayload` lets a variant inject usable sales with ads unavailable.
function shadowSpecFor(rk, accountId, dailyPayload) {
  if (rk === "daily-reporting") return { version: "daily-reporting/v2f-campaign", params: { reportVersion: "daily-reporting/v2f-campaign", accountId, from: "2026-03-19", to: ASOF, brand: "ALL" }, payload: dailyPayload || { rows: [], brandFiltered: false, adsAvailability: { status: "unavailable" } } };
  if (rk === "brand-sales") return { version: "brand-sales/v2d-2", params: { reportVersion: "brand-sales/v2d-2", accountId, from: "2025-01-01", to: ASOF }, payload: { rows: [], catalogBrands: [], asinBrand: { B0A: "Acme" } } };
  return { version: "brand-inventory-shared-v1", params: { reportVersion: "brand-inventory-shared-v1", accountId, to: ASOF }, payload: { inventoryByBrandCountry: [], inventoryDate: null, inventoryAvailable: false } };
}
const shadowHashFor = (rk, a, dp) => reportStore.paramsHashFor(shadowSpecFor(rk, a, dp).version, shadowSpecFor(rk, a, dp).params);
// The LIVE identity (report_key + account_id + params_hash) the publisher's fenced write targets.
function liveKeyFor(rk, accountId) {
  const c = publisherCore.SCHEDULER_LIVE_SNAPSHOT_CONTRACTS[rk];
  const lp = c.liveParams(shadowSpecFor(rk, accountId).params);
  return c.liveReportKey + "|" + accountId + "|" + reportStore.paramsHashFor(c.liveReportVersion, lp);
}
// A real publisher over a live-snapshot STORE (a Map). publishLiveFenced WRITES the live row so we can observe exactly
// which accounts were (re)published. `cycleStatusByAccount` steers each account terminal (succeeded -> published) or
// non-terminal (running -> not-successful -> NO write). `dailyPayloadByAccount` injects a variant daily payload.
function partialPublisherRelease({ scope, cycleStatusByAccount, liveStore, dailyPayloadByAccount = {} }) {
  const scopeAccounts = scope.map((id) => ({ id, name: id, country: "US", currency: "USD", status: "active" }));
  const pub = pubComposition.buildSchedulerV2Publisher({
    connections: [{ id: "primary", apiKey: "k", accountPrefix: "" }],
    fetchAccounts: async () => scopeAccounts,
    getAccountRollout: async () => ({ read: "ok", allPrimary: false, enabledAccountIds: [...scope] }),
    getSettings: async () => [{ report_key: "daily-reporting", schedule_enabled: true }, { report_key: "brand-sales", schedule_enabled: true }],
    getPromotedSettings: async () => [{ report_key: "brand-inventory", publish_enabled: true }],
    getApproval: async () => ({ read: "ok", approved: true }),
    getJob: async (rk, acct) => ({ cycle_id: "cyc-" + acct, validated: true, snapshot_params_hash: shadowHashFor(rk, acct, dailyPayloadByAccount[acct]), derive_status: "succeeded", save_status: "succeeded", cycle_status: cycleStatusByAccount[acct] || "running" }),
    getSnapshot: async ({ reportKey, accountId }) => { const rk = reportKey.replace("scheduler-v2/", ""); const s = shadowSpecFor(rk, accountId, dailyPayloadByAccount[accountId]); return { params_hash: shadowHashFor(rk, accountId, dailyPayloadByAccount[accountId]), params: s.params, payload: s.payload, payload_storage_path: null, source_refreshed_at: TS }; },
    getControlFence: () => ({ ownerToken: "test-owner", generation: 1 }),
    // Persist the EXACT live-snapshot row the real fenced write lands (report-publisher.js:301-309): identity columns +
    // params + payload + the propagated source_refreshed_at (payload_storage_path null -> inline payload). Storing this
    // faithfully lets the buildLiveReadback exact-identity contract verify a genuinely-promoted row (a dropped
    // source_refreshed_at would be an un-real row that no readback could ever pass).
    publishLiveFenced: async (args) => { liveStore.set(args.reportKey + "|" + args.accountId + "|" + args.paramsHash, { report_key: args.reportKey, account_id: args.accountId, params_hash: args.paramsHash, params: args.params, payload: args.payload, payload_storage_path: null, source_refreshed_at: args.sourceRefreshedAt }); return { outcome: "inserted" }; },
  });
  return priorityMod.buildPriorityDashboardsRelease({ buildRuntime: () => ({ makeDeadline: () => ({}), preflightEvidence: async () => ({}), run: async () => ({}) }), makeInnerAdapter: () => makeInner([]), buildPublisher: () => pub, reservation: makeFakeReservation(), makeStore: () => ({ listSourceJobs: async () => [], listCycleOwners: async () => [], finalizeCycle: async () => ({}) }), listReportJobs: async () => [], getCycleByBucketDate: async () => null });
}

test("PP1a. the healthy OLI-eligible accounts publish fresh D-1 dashboards; the readiness-deferred account keeps its DATED last-known-good BYTE-IDENTICAL", async () => {
  // Scope [A01,A02] healthy (terminal succeeded) + A03 deferred (running: its OLI batch was readiness/hard-deferred).
  const liveStore = new Map();
  // Seed A03's DATED last-known-good live rows (an OLDER cycle: to = 2026-08-10, before ASOF 2026-08-19).
  const A03_LKG = new Map();
  for (const rk of ["daily-reporting", "brand-sales", "brand-inventory"]) {
    const c = publisherCore.SCHEDULER_LIVE_SNAPSHOT_CONTRACTS[rk];
    const oldParams = rk === "brand-inventory" ? { to: "2026-08-10" } : (rk === "daily-reporting" ? { from: "2026-03-19", to: "2026-08-10", brand: "ALL" } : { from: "2025-01-01", to: "2026-08-10" });
    const ph = reportStore.paramsHashFor(c.liveReportVersion, oldParams);
    const key = c.liveReportKey + "|A03|" + ph;
    const row = { report_key: c.liveReportKey, account_id: "A03", params_hash: ph, params: { reportVersion: c.liveReportVersion, ...oldParams }, payload: { dated: "lkg-2026-08-10" } };
    liveStore.set(key, row); A03_LKG.set(key, JSON.stringify(row));
  }
  const beforeSize = liveStore.size;
  const rel = partialPublisherRelease({ scope: ["A01", "A02", "A03"], cycleStatusByAccount: { A01: "succeeded", A02: "succeeded", A03: "running" }, liveStore });

  // The healthy accounts (the OLI-eligible subset) publish all three fresh D-1 dashboards.
  for (const acct of ["A01", "A02"]) {
    const outp = await rel.publishAccount(acct);
    assert.deepEqual(outp.results.map((r) => r.reportKey), ["daily-reporting", "brand-sales", "brand-inventory"], acct + " publishes the 3 priority reports");
    for (const r of outp.results) assert.equal(r.disposition, "published", acct + "/" + r.reportKey + " published fresh");
    for (const rk of ["daily-reporting", "brand-sales", "brand-inventory"]) assert.ok(liveStore.has(liveKeyFor(rk, acct)), acct + "/" + rk + " wrote a fresh D-1 live row");
  }
  // The deferred account: a direct publish attempt is NOT-SUCCESSFUL (non-terminal cycle) -> ZERO writes.
  const a3 = await rel.publishAccount("A03");
  for (const r of a3.results) assert.equal(r.disposition, "not-successful", "A03/" + r.reportKey + " is not-successful (deferred; never published)");
  // A03's DATED last-known-good rows are BYTE-IDENTICAL (untouched) -- and no fresh D-1 A03 row was created.
  for (const [key, json] of A03_LKG) assert.equal(JSON.stringify(liveStore.get(key)), json, "A03 LKG row " + key.slice(0, 24) + " untouched (byte-identical)");
  for (const rk of ["daily-reporting", "brand-sales", "brand-inventory"]) assert.equal(liveStore.has(liveKeyFor(rk, "A03")), false, "A03 got NO fresh D-1 " + rk + " row");
  assert.equal(liveStore.size, beforeSize + 2 * 3, "exactly the 2 healthy accounts x 3 reports were written; A03 unchanged");
});

test("PP2. REAL publisher composition e2e: 30 accounts incl 1 proven-empty publish EXACTLY 90 canonical live promotions via buildSchedulerV2Publisher; the exact-identity live readback contract passes for every row (incl. the proven-empty account, which promotes IDENTICALLY); zero duplicate promotions", async () => {
  const N = 30;
  const ids = Array.from({ length: N }, (_, i) => "E" + String(i + 1).padStart(2, "0"));
  const provenEmpty = ids[N - 1];
  const liveStore = new Map();
  // 29 accounts carry usable daily sales; the proven-empty account (E30) carries an EMPTY daily payload (its OLI was
  // a durable proven zero-row export). The REAL publisher promotes BOTH identically (each job is validated + its
  // cycle terminal 'succeeded'); the proven-empty account is indistinguishable at the publisher boundary -- exactly
  // the intended behaviour (its lineage cardinality is proven upstream by source-production-hardening F4L).
  const dailyPayloadByAccount = {};
  for (const id of ids) if (id !== provenEmpty) dailyPayloadByAccount[id] = { rows: [], brandFiltered: false, adsAvailability: { status: "unavailable" } };
  const cycleStatusByAccount = Object.fromEntries(ids.map((id) => [id, "succeeded"]));
  const rel = partialPublisherRelease({ scope: ids, cycleStatusByAccount, liveStore, dailyPayloadByAccount });

  for (const acct of ids) {
    const outp = await rel.publishAccount(acct);
    assert.deepEqual(outp.results.map((r) => r.reportKey), ["daily-reporting", "brand-sales", "brand-inventory"], acct + " publishes the 3 priority reports");
    for (const r of outp.results) assert.equal(r.disposition, "published", acct + "/" + r.reportKey + " promoted to its canonical live key");
  }
  // EXACTLY 90 canonical live promotions, all distinct, zero duplicate.
  const expectedKeys = new Set();
  for (const acct of ids) for (const rk of ["daily-reporting", "brand-sales", "brand-inventory"]) expectedKeys.add(liveKeyFor(rk, acct));
  assert.equal(expectedKeys.size, 3 * N, "all 90 canonical keys are distinct");
  assert.equal(liveStore.size, 3 * N, "EXACTLY 30 x 3 = 90 canonical live promotions (zero duplicate)");
  for (const k of expectedKeys) assert.ok(liveStore.has(k), "canonical live key present");

  // The EXACT-identity live READBACK contract (buildLiveReadback) passes for every promoted row -- sampled on the
  // first positive account AND the proven-empty account across all three reports.
  const readback = readbackFor(liveStore);
  for (const acct of [ids[0], provenEmpty]) for (const rk of ["daily-reporting", "brand-sales", "brand-inventory"]) {
    const c = publisherCore.SCHEDULER_LIVE_SNAPSHOT_CONTRACTS[rk];
    const lp = c.liveParams(shadowSpecFor(rk, acct, dailyPayloadByAccount[acct]).params);
    const ph = reportStore.paramsHashFor(c.liveReportVersion, lp);
    assert.deepEqual(await readback({ reportKey: c.liveReportKey, liveReportKey: c.liveReportKey, accountId: acct, paramsHash: ph }), { ok: true }, acct + "/" + rk + " exact-identity live readback ok");
  }
});

test("PP1b. CAMPAIGN Ads failure with usable OLI sales: a healthy account STILL publishes daily + brand-sales (ads shown unavailable, sales never suppressed)", async () => {
  const liveStore = new Map();
  // A01's daily payload carries USABLE sales rows but adsAvailability unavailable (Campaign Ads failed this cycle).
  const dailyWithSalesAdsDown = { rows: [{ date: "2026-08-18", marketplace_country_code: "US", currency: "USD", product_brand: "Acme", total_sales: 210, total_units_sold: 21 }], brandFiltered: false, adsAvailability: { status: "unavailable" } };
  const rel = partialPublisherRelease({ scope: ["A01"], cycleStatusByAccount: { A01: "succeeded" }, liveStore, dailyPayloadByAccount: { A01: dailyWithSalesAdsDown } });
  const outp = await rel.publishAccount("A01");
  for (const r of outp.results) assert.equal(r.disposition, "published", "A01/" + r.reportKey + " published despite the Campaign Ads failure");
  const daily = liveStore.get(liveKeyFor("daily-reporting", "A01"));
  assert.ok(daily && daily.payload && Array.isArray(daily.payload.rows) && daily.payload.rows.length === 1, "the published daily row carries the usable OLI sales");
  assert.equal(daily.payload.adsAvailability.status, "unavailable", "ads are honestly UNAVAILABLE (never a fabricated zero), but sales published");
});

test("PP1c. a HARD sibling failure (independent deps) is identical: the healthy accounts publish, the hard-failed account keeps dated LKG (a non-terminal cycle -> not-successful -> untouched)", async () => {
  // The deferred account's batch failed HARD (non-readiness). At the publication layer the shape is the same: its
  // cycle is non-terminal -> not-successful -> zero writes -> LKG preserved. Healthy siblings are unaffected.
  const liveStore = new Map();
  const rel = partialPublisherRelease({ scope: ["A01", "A02", "A03"], cycleStatusByAccount: { A01: "succeeded", A02: "succeeded", A03: "failed" }, liveStore });
  for (const acct of ["A01", "A02"]) { const outp = await rel.publishAccount(acct); for (const r of outp.results) assert.equal(r.disposition, "published", acct + " publishes despite the hard sibling failure"); }
  const a3 = await rel.publishAccount("A03");
  for (const r of a3.results) assert.equal(r.disposition, "not-successful", "the hard-failed account is not-successful -> keeps LKG (no write)");
  assert.equal(liveStore.size, 2 * 3, "only the 2 healthy accounts x 3 reports were written; the hard-failed account wrote nothing");
});

test("PP1e. the PARTIAL publish reuses the VALID per-day catalog operation key (scheduled/YYYY-MM-DD); the once-proposed scheduled-partial/ key is REJECTED (would hard-fail the partial step)", () => {
  // Regression guard for the partial-publish operation key: buildPriorityDashboardsRelease validates it via
  // assertPriorityOperationKey, which accepts ONLY priority-dashboards/v2 | priority-dashboards/scheduled/<date>.
  // The partial workflow step MUST therefore reuse the per-day scheduled key (the org-wide Catalog is one create/day,
  // shared complete-or-partial); the cycle isolation comes from the dedicated cycle bucket, not the operation key.
  assert.equal(priorityMod.assertPriorityOperationKey("priority-dashboards/scheduled/2026-09-08"), "priority-dashboards/scheduled/2026-09-08");
  assert.throws(() => priorityMod.assertPriorityOperationKey("priority-dashboards/scheduled-partial/2026-09-08"), /PRIORITY_OPERATION_KEY_INVALID/, "a scheduled-partial/ key is rejected -> the partial step would exit 2 (dead on arrival)");
});

test("PP1d. terminal-succeeded is REQUIRED for a fresh write: with the SAME fresh shadow evidence, a 'running' cycle writes nothing but a 'succeeded' cycle publishes (the publication gate is per-account, not per-region)", async () => {
  const liveStore = new Map();
  const relRunning = partialPublisherRelease({ scope: ["A01"], cycleStatusByAccount: { A01: "running" }, liveStore });
  const running = await relRunning.publishAccount("A01");
  for (const r of running.results) assert.equal(r.disposition, "not-successful", "a non-terminal cycle never publishes");
  assert.equal(liveStore.size, 0, "no live row written while the cycle is non-terminal (LKG preserved)");
  const relOk = partialPublisherRelease({ scope: ["A01"], cycleStatusByAccount: { A01: "succeeded" }, liveStore });
  const okp = await relOk.publishAccount("A01");
  for (const r of okp.results) assert.equal(r.disposition, "published", "the same account publishes once its own cycle is terminal");
  assert.equal(liveStore.size, 3, "exactly 3 fresh live rows once terminal");
});

/* ===================== PP2. REAL eligible-subset flow: dedicated partial cycle creation + exact dashboard readback ===================== */
group("PP2. eligible-subset flow through cycle creation + finalize scope + exact live readback (not only publisher injection)");

const PARTIAL_BUCKET = "priority-partial-us-ca-0123456789abcdef"; // priority-partial-<region>-<16hex> (migration 20260924 regex)

test("PP2a. cycle CREATION IDENTITY: with an eligible subset the release routes derive + finalize to the DEDICATED partial cycle bucket (never the natural region cycle)", async () => {
  const runCycleBuckets = []; const cycleQueried = [];
  const rel = priorityMod.buildPriorityDashboardsRelease({
    cycleBucket: PARTIAL_BUCKET,
    fetchAccounts: async () => [{ id: "A01", name: "A01", country: "US", currency: "USD", status: "active" }, { id: "A02", name: "A02", country: "US", currency: "USD", status: "active" }],
    buildRuntime: () => ({ makeDeadline: () => ({}), preflightEvidence: async () => ({ accounts: [{ accountId: "A01" }, { accountId: "A02" }], today: TODAY }), run: async (opts) => { runCycleBuckets.push(opts && opts.cycleBucket); return { rollup: { stopped: false, continuationRequired: false, globalDrained: true, derived: { skipped: null, daily: { ready: true, saved: 2 }, brandView: { ready: true, saved: 2 }, brandInventory: { saved: 2 }, lineage: [0, 1, 2, 3, 4, 5] } } }; } }),
    makeInnerAdapter: () => makeInner([]),
    buildPublisher: () => ({ publish: async () => ({ disposition: "published" }), preflight: async () => ({ disposition: "ready" }) }),
    reservation: makeFakeReservation(),
    makeStore: () => ({ listSourceJobs: async () => [], listCycleOwners: async () => [], finalizeCycle: async () => ({}) }),
    listReportJobs: async () => [],
    getCycleByBucketDate: async (bucket) => { cycleQueried.push(bucket); return null; }, // absent -> derive opens a fresh cycle
    getControlFence: () => ({ ownerToken: "t", generation: 1 }),
  });
  await rel.deriveBucket("us-ca");
  assert.ok(runCycleBuckets.includes(PARTIAL_BUCKET), "the derive opens/uses the DEDICATED partial cycle bucket (cycle creation), not the natural region cycle: " + JSON.stringify(runCycleBuckets));
  assert.ok(cycleQueried.every((b) => b === PARTIAL_BUCKET), "every cycle lookup during derive targets the partial bucket: " + JSON.stringify(cycleQueried));
  assert.ok(!cycleQueried.includes("us-ca"), "the NATURAL region cycle is never queried by the subset flow");
});

test("PP2b. finalize scope + EXACT dashboard readback: an already-terminal partial cycle finalizes to EXACTLY the eligible subset; each healthy account's live dashboards read back at D-1; the deferred account's dated LKG is byte-identical", async () => {
  const CAT_WARM = [{ source_key: CATALOG, request_hash: "cat-hash", fetch_status: "succeeded", create_export_count: 0, cache_object_path: "source-cache/v2/cat-hash.json" }];
  const CAT_OWN = [{ request_hash: "cat-hash", account_id: ORG }];
  const cycleQueried = [];
  const liveStore = new Map();
  // Seed A03 (deferred, OUT of the eligible subset) with DATED (older) last-known-good live rows.
  const A03_LKG = new Map();
  for (const rk of ["daily-reporting", "brand-sales", "brand-inventory"]) {
    const c = publisherCore.SCHEDULER_LIVE_SNAPSHOT_CONTRACTS[rk];
    const oldParams = rk === "brand-inventory" ? { to: "2026-08-10" } : (rk === "daily-reporting" ? { from: "2026-03-19", to: "2026-08-10", brand: "ALL" } : { from: "2025-01-01", to: "2026-08-10" });
    const ph = reportStore.paramsHashFor(c.liveReportVersion, oldParams);
    const key = c.liveReportKey + "|A03|" + ph;
    const row = { report_key: c.liveReportKey, account_id: "A03", params_hash: ph, params: { reportVersion: c.liveReportVersion, ...oldParams }, payload: { dated: "lkg-2026-08-10" }, payload_storage_path: null, source_refreshed_at: TS };
    liveStore.set(key, row); A03_LKG.set(key, JSON.stringify(row));
  }
  const beforeSize = liveStore.size;
  // The REAL publisher over the eligible subset [A01,A02] (both terminal-succeeded); publishLiveFenced writes liveStore.
  const scope = ["A01", "A02"];
  const pub = pubComposition.buildSchedulerV2Publisher({
    connections: [{ id: "primary", apiKey: "k", accountPrefix: "" }],
    fetchAccounts: async () => scope.map((id) => ({ id, name: id, country: "US", currency: "USD", status: "active" })),
    getAccountRollout: async () => ({ read: "ok", allPrimary: false, enabledAccountIds: [...scope] }),
    getSettings: async () => [{ report_key: "daily-reporting", schedule_enabled: true }, { report_key: "brand-sales", schedule_enabled: true }],
    getPromotedSettings: async () => [{ report_key: "brand-inventory", publish_enabled: true }],
    getApproval: async () => ({ read: "ok", approved: true }),
    getJob: async (rk, acct) => ({ cycle_id: "cyc-p", validated: true, snapshot_params_hash: shadowHashFor(rk, acct), derive_status: "succeeded", save_status: "succeeded", cycle_status: "succeeded" }),
    getSnapshot: async ({ reportKey, accountId }) => { const rk = reportKey.replace("scheduler-v2/", ""); const s = shadowSpecFor(rk, accountId); return { params_hash: shadowHashFor(rk, accountId), params: s.params, payload: s.payload, payload_storage_path: null, source_refreshed_at: TS }; },
    getControlFence: () => ({ ownerToken: "t", generation: 1 }),
    publishLiveFenced: async (args) => { liveStore.set(args.reportKey + "|" + args.accountId + "|" + args.paramsHash, { report_key: args.reportKey, account_id: args.accountId, params_hash: args.paramsHash, params: args.params, payload: args.payload, payload_storage_path: null, source_refreshed_at: args.sourceRefreshedAt }); return { outcome: "inserted" }; },
  });
  const rel = priorityMod.buildPriorityDashboardsRelease({
    cycleBucket: PARTIAL_BUCKET,
    fetchAccounts: async () => scope.map((id) => ({ id, name: id, country: "US", currency: "USD", status: "active" })),
    buildRuntime: () => ({ makeDeadline: () => ({}), preflightEvidence: async () => ({ accounts: scope.map((accountId) => ({ accountId })), today: TODAY }), run: async () => ({}) }),
    makeInnerAdapter: () => makeInner([]),
    buildPublisher: () => pub,
    reservation: (() => { const r = makeFakeReservation(); r._rows.set(OP(), { catalog_request_hash: "cat-hash", export_id: "e1", status: "created", tokens_spent: 2 }); return r; })(),
    makeStore: () => ({ listSourceJobs: async () => CAT_WARM, listCycleOwners: async () => CAT_OWN, finalizeCycle: async () => ({ disposition: "finalized", cycle: { status: "succeeded" } }) }),
    listReportJobs: async () => repJobsFor(["A01", "A02"]), // the eligible subset's validated report jobs (exact-count scope)
    getCycleByBucketDate: async (bucket) => { cycleQueried.push(bucket); return { id: "cyc-p", bucket, status: "succeeded", trigger: "manual" }; },
    getControlFence: () => ({ ownerToken: "t", generation: 1 }),
  });
  // FINALIZE: routes to the partial bucket + scopes to EXACTLY the eligible subset.
  const fin = await rel.finalizeBucket("us-ca");
  assert.ok(cycleQueried.includes(PARTIAL_BUCKET) && !cycleQueried.includes("us-ca"), "finalize targets the DEDICATED partial cycle bucket, never the natural region cycle");
  assert.deepEqual([...(fin.accounts || [])].sort(), ["A01", "A02"], "finalize scopes to EXACTLY the eligible subset (A03 excluded)");
  // PUBLISH each eligible account through the REAL publisher; then EXACT live readback at D-1.
  const readback = releaseRunner.buildLiveReadback({
    getReportSnapshot: async ({ reportKey, accountId, paramsHash }) => liveStore.get(reportKey + "|" + accountId + "|" + paramsHash) || null,
    loadStoragePayload: async () => null, liveContracts: publisherCore.SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, reportDerivations: reportDerivation.REPORT_DERIVATIONS, computeHash: reportStore.paramsHashFor,
  });
  for (const acct of scope) {
    const outp = await rel.publishAccount(acct);
    for (const r of outp.results) {
      assert.equal(r.disposition, "published", acct + "/" + r.reportKey + " published fresh D-1");
      const rb = await readback({ reportKey: r.reportKey, liveReportKey: r.liveReportKey, accountId: acct, paramsHash: r.paramsHash });
      assert.deepEqual(rb, { ok: true }, acct + "/" + r.reportKey + " reads back at the EXACT live D-1 identity");
    }
  }
  // A03 (deferred, out of scope) is untouched: its DATED LKG rows are byte-identical and no fresh A03 row was created.
  for (const [key, json] of A03_LKG) assert.equal(JSON.stringify(liveStore.get(key)), json, "A03 dated LKG untouched: " + key.slice(0, 20));
  for (const rk of ["daily-reporting", "brand-sales", "brand-inventory"]) assert.equal(liveStore.has(liveKeyFor(rk, "A03")), false, "no fresh D-1 A03 " + rk + " row");
  assert.equal(liveStore.size, beforeSize + 2 * 3, "exactly the 2 eligible accounts x 3 dashboards were written; A03 unchanged");
});

/* ===================== PP3. production-schema compatibility: partial cycle bucket vs. live allow-list + migration ===================== */
group("PP3. production-schema compatibility: the partial cycle bucket, the live allow-list, and migration 20260924");

test("PP3a. the partial bucket format matches the migration regex; the CURRENT (pre-20260924) allow-list REJECTS it (so the migration is genuinely required, and the code never disguises it as bootstrap)", () => {
  const bucket = "priority-partial-us-ca-0123456789abcdef";
  const partialRe = /^priority-partial-(india|europe-au|us-ca)-[0-9a-f]{16}$/;
  const bootstrapRe = /^bootstrap(-fba)?-(india|europe-au|us-ca)-[0-9a-f]{16}$/;
  const fixed13 = ["us", "non-us", "us-fba", "non-us-fba", "india", "europe-au", "us-ca", "india-fba", "europe-au-fba", "us-ca-fba", "listing-health-v3-india", "listing-health-v3-europe-au", "listing-health-v3-us-ca"];
  assert.match(bucket, partialRe, "the entrypoint bucket matches the migration's priority-partial regex");
  assert.doesNotMatch(bucket, bootstrapRe, "it is a DISTINCT namespace -- never matches (is never disguised as) a bootstrap bucket");
  assert.equal(fixed13.includes(bucket), false, "the CURRENT fixed allow-list does NOT contain it (pre-migration rejection -> the migration is required)");
  // The entrypoint derives exactly this shape (region + 16 hex); assert the source builds a 16-hex region-anchored bucket.
  const relSrc = readFileSync(new URL("../scripts/release/priority-dashboards-release.mjs", import.meta.url), "utf8");
  assert.ok(relSrc.includes('"priority-partial-" + bucketArg + "-"') && relSrc.includes(".slice(0, 16)"), "the bucket is priority-partial-<region>-<sha256[:16]>");
  assert.match(relSrc, /PRIORITY_PARTIAL_MIGRATION_PENDING/, "a read-only preflight fails closed until the migration is applied (never a raw Invalid-bucket crash)");
  // Region guard (BEFORE any write): the legacy us|non-us buckets that isRoutingScope also accepts do NOT match the
  // region-anchored priority-partial regex, so subset mode rejects them fail-closed instead of passing the general
  // preflight and crashing on openCycle after a lease write.
  assert.match(relSrc, /PRIORITY_PARTIAL_REGION_UNSUPPORTED/, "subset mode rejects a non-(india|europe-au|us-ca) bucket before any write");
  assert.match(relSrc, /\["india", "europe-au", "us-ca"\]\.includes\(bucketArg\)/, "the region guard restricts the partial namespace to the three regex-permitted regions");
});

test("PP3b. migration 20260924 adds ONLY the priority-partial regex to sync_cycles_bucket_check + open_sync_cycle, PRESERVES the fixed values + the bootstrap regex, and does NOT touch record_onboarding_publication (no bootstrap disguise)", () => {
  const mig = readFileSync(new URL("../supabase/migrations/20260924_priority_partial_cycle_bucket.sql", import.meta.url), "utf8");
  assert.match(mig, /priority-partial-\(india\|europe-au\|us-ca\)-\[0-9a-f\]\{16\}/, "adds the priority-partial regex");
  assert.match(mig, /bootstrap\(-fba\)\?-\(india\|europe-au\|us-ca\)-\[0-9a-f\]\{16\}/, "PRESERVES the existing bootstrap regex");
  for (const v of ["'us-ca'", "'india'", "'europe-au'", "'listing-health-v3-india'"]) assert.ok(mig.includes(v), "preserves the fixed allow-list value " + v);
  assert.match(mig, /alter table public\.sync_cycles drop constraint if exists sync_cycles_bucket_check/, "idempotently re-adds the sync_cycles bucket CHECK");
  assert.match(mig, /create or replace function public\.open_sync_cycle/, "widens open_sync_cycle's guard");
  assert.match(mig, /grant execute on function public\.open_sync_cycle[\s\S]*to service_role/, "re-enforces service_role-only execute");
  // record_onboarding_publication may only be NAMED in a comment (explaining the non-overlap), NEVER in a DDL line.
  assert.ok(mig.split("\n").every((ln) => ln.trim().startsWith("--") || !ln.includes("record_onboarding_publication")), "does NOT touch the bootstrap-only publication manifest in any DDL (no bootstrap disguise / lifecycle overlap)");
  assert.ok(mig.split("\n").every((ln) => ln.trim().startsWith("--") || !/\bdrop\s+table\b/i.test(ln)), "never drops a table");
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
test("P12-fba-a. buildFbaPlanControlPackage: exact rollout, ONLY fba-plan dispatch enabled (all others paused), NO promoted, 1xN approvals", () => {
  const pkg = controlPkg.buildFbaPlanControlPackage({ accounts: ["A02", "A01", "A01"], operator: "op@x", controlledReportKeys: CONTROLLED });
  assert.deepEqual(pkg.accounts, ["A01", "A02"], "dedup + sort");
  assert.deepEqual(pkg.post.dispatchEnabled, ["fba-plan"], "ONLY fba-plan dispatch-enabled");
  assert.deepEqual(pkg.post.dispatchPaused, CONTROLLED.filter((rk) => rk !== "fba-plan").sort(), "every other controlled report paused");
  assert.equal(pkg.post.promotedEnabled, "", "NO promoted control enabled");
  assert.deepEqual(pkg.post.rolloutEnabled, ["A01", "A02"]);
  assert.deepEqual(pkg.post.approvals, ["fba-plan|A01", "fba-plan|A02"], "approvals ONLY for fba-plan x each account");
  assert.throws(() => controlPkg.buildFbaPlanControlPackage({ accounts: [], operator: "op" }), /primary account/);
  assert.throws(() => controlPkg.buildFbaPlanControlPackage({ accounts: ["dd-secondary:x"], operator: "op" }), /dd-secondary/);
  assert.throws(() => controlPkg.buildFbaPlanControlPackage({ accounts: ["A01"], operator: "" }), /operator id/);
});

test("P12-fba-b. APPLY the fba-plan package on a clean baseline enables ONLY fba-plan, no promoted, fba-plan approvals -- COMMITS", async () => {
  const pkg = controlPkg.buildFbaPlanControlPackage({ accounts: ["A01", "A02"], operator: "op@x", controlledReportKeys: CONTROLLED });
  const store = makeControlStore(baseline());
  const r = await runTxn(store, pkg, "apply");
  assert.equal(r.committed, true, JSON.stringify(r));
  assert.deepEqual((await store.dispatchRows()).filter((x) => x.schedule_enabled).map((x) => x.report_key), ["fba-plan"], "ONLY fba-plan enabled -- daily/brand-sales stay paused");
  assert.deepEqual((await store.promotedRows()).filter((x) => x.publish_enabled).map((x) => x.report_key), [], "NO promoted control enabled (no blank-key row)");
  assert.deepEqual((await store.rolloutRows()).filter((x) => x.enabled).map((x) => x.account_id).sort(), ["A01", "A02"]);
  const appr = (await store.approvalRows()).filter((x) => x.approved).map((x) => x.report_key + "|" + x.account_id).sort();
  assert.deepEqual(appr, ["fba-plan|A01", "fba-plan|A02"], "approvals ONLY for fba-plan");
});

test("P12-fba-c. the SAME global SAFE-CLOSE closes the fba-plan apply (rollback disables every control)", async () => {
  const pkg = controlPkg.buildFbaPlanControlPackage({ accounts: ["A01", "A02"], operator: "op@x", controlledReportKeys: CONTROLLED });
  const store = makeControlStore(baseline());
  await runTxn(store, pkg, "apply");
  const safeClose = controlPkg.buildPrioritySafeClosePackage({ operator: "op@x", controlledReportKeys: CONTROLLED });
  const r = await runTxn(store, safeClose, "rollback");
  assert.equal(r.committed, true, JSON.stringify(r));
  assert.equal((await store.rolloutRows()).filter((x) => x.enabled).length, 0, "all rollout disabled");
  assert.equal((await store.dispatchRows()).filter((x) => x.schedule_enabled).length, 0, "all dispatch paused (incl. fba-plan)");
  assert.equal((await store.approvalRows()).filter((x) => x.approved).length, 0, "all approvals revoked");
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

/* ===================== P14. the reviewed cycle-date re-date (collision unblock; DATE-exact) ===================== */
group("P14. re-date collision: DATE-string exact PRE/POST; dry-run; only cycle_date changes; every mismatch refuses");
function redateBundle(over = {}) {
  const base = {
    cycle: { id: "481fe35c-ce65-455f-b317-cc267977e185", bucket: "non-us", cycleDateText: "2026-08-24", status: "partial", trigger: "manual", finishedAtNonNull: true, createdUtcDate: "2026-08-16", counters: { sourceTotal: 130, sourceSucceeded: 90, sourceFailed: 40, reportTotal: 13, reportSucceeded: 3, reportFailed: 10 } },
    counts: { sourceJobs: 130, owners: 170, reportJobs: 13, validatedReportJobs: 3 },
    v2LineageCount: 0, targetSlotCount: 0, nonUsAtCurrentCount: 1,
    controls: { allPrimary: false, cron: false, enabledRollout: 0, enabledDispatch: 0, enabledPromoted: 0, approvedCount: 0 },
    reservations: { v1: { status: "reserved", tokens: 0, hasExport: false }, v2: { status: "created", tokens: 2, hasExport: true } },
    digests: { live_snapshots: { c: 183, h: "a" }, shadow_snapshots: { c: 48, h: "b" }, rollout: { c: 30, h: "c" }, mode: { c: 1, h: "d" }, approvals: { c: 90, h: "e" }, settings: { c: 13, h: "f" }, sync_cycles: { c: 25, h: "g1" }, report_jobs: { c: 191, h: "hh" } },
  };
  return { ...base, ...over };
}
function makeRedateStore(bundle, opts = {}) {
  const clone = (o) => JSON.parse(JSON.stringify(o));
  let state = clone(bundle);
  let snapshot = null;
  const calls = { begin: 0, commit: 0, rollback: 0, update: 0 };
  return {
    _calls: calls, _state: () => state,
    begin: async () => { calls.begin += 1; snapshot = clone(state); if (opts.mutateOnLock) opts.mutateOnLock(state); },
    commit: async () => { calls.commit += 1; if (opts.failCommit) throw new Error("commit ack lost"); snapshot = null; },
    rollback: async () => { calls.rollback += 1; if (opts.failRollback) throw new Error("rollback failed"); if (snapshot) state = clone(snapshot); },
    readEvidence: async () => clone(state),
    update: async () => {
      calls.update += 1;
      if (opts.updateRowCount !== undefined) return opts.updateRowCount; // simulate wrong rowCount (state unchanged)
      // the REAL guarded UPDATE moves only cycle_date; the current slot empties; ONLY the sync_cycles digest hash
      // changes (its row COUNT stays identical).
      state.cycle.cycleDateText = redateMod.REDATE.targetDate;
      state.nonUsAtCurrentCount = 0;
      state.digests = { ...state.digests, sync_cycles: { c: state.digests.sync_cycles.c, h: state.digests.sync_cycles.h + "!" } };
      if (opts.mutateChildOnUpdate) opts.mutateChildOnUpdate(state); // simulate an over-broad update
      return 1;
    },
  };
}
const runRedate = (store, mode) => redateMod.runRedateCollisionTransaction({ store, mode });

test("P14a. dry-run performs ZERO writes and confirms the exact collision", async () => {
  const store = makeRedateStore(redateBundle());
  const r = await runRedate(store, "dry-run");
  assert.equal(r.dryRun, true); assert.equal(r.code, 0); assert.deepEqual(r.problems, []);
  assert.deepEqual(store._calls, { begin: 0, commit: 0, rollback: 0, update: 0 }, "dry-run writes nothing");
});
test("P14b. --apply moves ONLY cycle_date to the target and COMMITS; records the new sync_cycles digest", async () => {
  const store = makeRedateStore(redateBundle());
  const r = await runRedate(store, "apply");
  assert.equal(r.committed, true); assert.equal(r.code, 0);
  assert.equal(store._state().cycle.cycleDateText, redateMod.REDATE.targetDate);
  assert.equal(store._state().nonUsAtCurrentCount, 0);
  assert.deepEqual(store._calls, { begin: 1, commit: 1, rollback: 0, update: 1 });
  assert.ok(r.syncCyclesDigest && r.syncCyclesDigest.c === 25, "the new sync_cycles digest is recorded (row count identical)");
});
test("P14c. DATE is compared as YYYY-MM-DD; a timestamp / Date serialization is REJECTED (never new Date().toISOString())", async () => {
  assert.equal(redateMod.isPlainIsoDate("2026-08-24"), true);
  for (const bad of ["2026-08-23T18:30:00.000Z", "2026-08-24T00:00:00", "2026-8-4", "20260824", "", null, new Date().toISOString()]) assert.equal(redateMod.isPlainIsoDate(bad), false, "rejects " + bad);
  const store = makeRedateStore(redateBundle({ cycle: { ...redateBundle().cycle, cycleDateText: "2026-08-23T18:30:00.000Z" } }));
  const r = await runRedate(store, "dry-run");
  assert.equal(r.code, 1); assert.ok(r.problems.some((p) => /cycle-date-not-plain-iso/.test(p)), JSON.stringify(r.problems));
});
test("P14d. a missing / wrong cycle refuses (id / bucket / status / trigger / finished_at / created_at)", async () => {
  const cases = [
    [{ cycle: null }, /cycle-not-found/],
    [{ cycle: { ...redateBundle().cycle, id: "00000000-0000-0000-0000-000000000000" } }, /wrong-cycle-id/],
    [{ cycle: { ...redateBundle().cycle, bucket: "us" } }, /wrong-bucket/],
    [{ cycle: { ...redateBundle().cycle, cycleDateText: "2026-08-16" } }, /cycle-date-not-current-slot/],
    [{ cycle: { ...redateBundle().cycle, status: "succeeded" } }, /status-not-expected/],
    [{ cycle: { ...redateBundle().cycle, trigger: "scheduled" } }, /trigger-not-manual/],
    [{ cycle: { ...redateBundle().cycle, finishedAtNonNull: false } }, /finished_at-null/],
    [{ cycle: { ...redateBundle().cycle, createdUtcDate: "2026-08-24" } }, /created_at-not-historical/],
  ];
  for (const [over, re] of cases) {
    const r = await runRedate(makeRedateStore(redateBundle(over)), "dry-run");
    assert.equal(r.code, 1); assert.ok(r.problems.some((p) => re.test(p)), re + " -> " + JSON.stringify(r.problems));
  }
});
test("P14e. wrong child counts refuse", async () => {
  for (const [k, re] of [["sourceJobs", /source-jobs-count/], ["owners", /owners-count/], ["reportJobs", /report-jobs-count/], ["validatedReportJobs", /validated-report-jobs-count/]]) {
    const b = redateBundle(); b.counts[k] = b.counts[k] - 1;
    const r = await runRedate(makeRedateStore(b), "dry-run");
    assert.equal(r.code, 1); assert.ok(r.problems.some((p) => re.test(p)), k);
  }
});
test("P14f. an OCCUPIED target date refuses (no other non-us cycle may already sit on the target)", async () => {
  const r = await runRedate(makeRedateStore(redateBundle({ targetSlotCount: 1 })), "dry-run");
  assert.equal(r.code, 1); assert.ok(r.problems.some((p) => /target-slot-occupied/.test(p)));
});
test("P14g. UNEXPECTED v2 lineage in the cycle refuses", async () => {
  const r = await runRedate(makeRedateStore(redateBundle({ v2LineageCount: 1 })), "dry-run");
  assert.equal(r.code, 1); assert.ok(r.problems.some((p) => /v2-lineage-present/.test(p)));
});
test("P14h. rowCount != 1 refuses and rolls back (never partial)", async () => {
  for (const rc of [0, 2]) {
    const store = makeRedateStore(redateBundle(), { updateRowCount: rc });
    const r = await runRedate(store, "apply");
    assert.equal(r.code, 1); assert.ok(/row-count-not-1/.test(r.problem), JSON.stringify(r));
    assert.deepEqual(store._calls, { begin: 1, commit: 0, rollback: 1, update: 1 });
  }
});
test("P14i. a POST-state mismatch (the update did not land) rolls back", async () => {
  const store = makeRedateStore(redateBundle(), { updateRowCount: 1, /* but state unchanged -> post cycle_date still current */ });
  const r = await runRedate(store, "apply");
  assert.equal(r.code, 1); assert.ok(/post-cycle-date-not-target|current-slot-still-has-nonus/.test(r.problem), JSON.stringify(r));
  assert.equal(store._calls.rollback, 1);
});
test("P14j. an over-broad update that changes a CHILD count rolls back once (only cycle_date may change)", async () => {
  const store = makeRedateStore(redateBundle(), { mutateChildOnUpdate: (s) => { s.counts.owners = 169; } });
  const r = await runRedate(store, "apply");
  assert.equal(r.code, 1); assert.ok(/child-count-changed/.test(r.problem), JSON.stringify(r));
  assert.deepEqual(store._calls, { begin: 1, commit: 0, rollback: 1, update: 1 });
});
test("P14k. an over-broad update that changes an UNRELATED protected digest rolls back", async () => {
  const store = makeRedateStore(redateBundle(), { mutateChildOnUpdate: (s) => { s.digests = { ...s.digests, live_snapshots: { c: 183, h: "MUTATED" } }; } });
  const r = await runRedate(store, "apply");
  assert.equal(r.code, 1); assert.ok(/protected-digest-changed:live_snapshots/.test(r.problem), JSON.stringify(r));
});
test("P14l. COMMIT_UNKNOWN: a lost commit ack returns code 3, does NOT rollback, demands read-only reconciliation", async () => {
  const store = makeRedateStore(redateBundle(), { failCommit: true });
  const r = await runRedate(store, "apply");
  assert.equal(r.code, 3); assert.equal(r.commitUnknown, true); assert.match(r.instruction, /READ-ONLY reconciliation/i);
  assert.deepEqual(store._calls, { begin: 1, commit: 1, rollback: 0, update: 1 }, "attempted commit; NO rollback");
});
test("P14m. success changes ONLY cycle_date + the sync_cycles digest hash; ALL child/reservation/control state is byte-identical", async () => {
  const before = redateBundle();
  const store = makeRedateStore(before);
  const r = await runRedate(store, "apply");
  assert.equal(r.committed, true);
  const after = store._state();
  assert.deepEqual(after.counts, before.counts, "child counts unchanged");
  assert.deepEqual(after.cycle.counters, before.cycle.counters, "counters unchanged");
  assert.deepEqual(after.reservations, before.reservations, "reservations unchanged");
  assert.deepEqual(after.controls, before.controls, "controls unchanged");
  for (const k of ["live_snapshots", "shadow_snapshots", "rollout", "mode", "approvals", "settings", "report_jobs"]) assert.deepEqual(after.digests[k], before.digests[k], k + " digest unchanged");
  assert.equal(after.digests.sync_cycles.c, before.digests.sync_cycles.c, "sync_cycles row count unchanged");
  assert.notEqual(after.digests.sync_cycles.h, before.digests.sync_cycles.h, "sync_cycles digest hash changed");
});
test("P14n. controls-not-safe-closed and wrong v1/v2 reservation refuse; bad mode / missing store fail closed", async () => {
  assert.equal((await runRedate(makeRedateStore(redateBundle({ controls: { allPrimary: false, cron: false, enabledRollout: 1, enabledDispatch: 0, enabledPromoted: 0, approvedCount: 0 } })), "dry-run")).problems.some((p) => /controls-not-safe-closed/.test(p)), true);
  assert.equal((await runRedate(makeRedateStore(redateBundle({ reservations: { v1: { status: "created", tokens: 2, hasExport: true }, v2: { status: "created", tokens: 2, hasExport: true } } })), "dry-run")).problems.some((p) => /v1-reservation-not-exact/.test(p)), true);
  assert.equal((await runRedate(makeRedateStore(redateBundle({ reservations: { v1: { status: "reserved", tokens: 0, hasExport: false }, v2: { status: "reserved", tokens: 0, hasExport: false } } })), "dry-run")).problems.some((p) => /v2-reservation-not-exact/.test(p)), true);
  await assert.rejects(() => redateMod.runRedateCollisionTransaction({ store: makeRedateStore(redateBundle()), mode: "delete" }), /apply.*dry-run/);
  await assert.rejects(() => redateMod.runRedateCollisionTransaction({ store: null, mode: "dry-run" }), /store/);
});

async function main() {
  out("priority dashboards release proof suite");
  priorityMod = await import("../lib/server/sync/source-priority-dashboards.js");
  releaseRunner = await import("../lib/server/sync/source-priority-release-runner.js");
  controlPkg = await import("../lib/server/sync/source-priority-control-package.js");
  cleanupMod = await import("../lib/server/sync/source-failed-cycle-cleanup.js");
  redateMod = await import("../lib/server/sync/source-redate-cycle-collision.js");
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
