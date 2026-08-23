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

let priorityMod; let planMod; let brandView; let pubComposition; let reportStore; let supabaseMod; let releaseRunner; let publisherCore; let reportDerivation; let controlPkg;

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

/* ===================== P3. the bucket PLAN emits zero OLI/FBA jobs, one Catalog job ===================== */
group("P3. plan for all 30 covered accounts: zero OLI/FBA exports, one org-scoped Catalog export per bucket");

function accountsFor(bucket, n) {
  const cc = bucket === "us" ? "US" : "DE";
  return Array.from({ length: n }, (_, i) => ({ accountId: bucket + "-A" + String(i + 1).padStart(2, "0"), rawSellerId: bucket + "-S" + String(i + 1).padStart(2, "0"), country: cc, currency: "USD" }));
}
function planPriorityBucket(bucket, n) {
  const pausedSources = new Set([OLI, FBA, "ads-campaign-date", "ads-asin-date", "settlements", "returns", "listings"]);
  const accounts = accountsFor(bucket, n); const coverageByAccountId = {};
  for (const a of accounts) coverageByAccountId[a.accountId] = [{ from: "2025-01-01", to: TODAY }];
  return planMod.planBucketSourceSync({ apiKey: "prim-key", bucket, accounts, existingMembership: new Map(), coverageByAccountId, catalogSnapshot: null, fbaSnapshotsByAccount: {}, pausedSources, asOf: ASOF, today: TODAY, forceCatalogRefresh: true });
}
test("P3a. US bucket (8): ZERO OLI + ZERO FBA jobs, EXACTLY one Catalog job", () => { const jf = planPriorityBucket("us", 8).summary.plannedJobsByFamily; assert.equal(jf[OLI] || 0, 0); assert.equal(jf[FBA] || 0, 0); assert.equal(jf[CATALOG], 1); });
test("P3b. Non-US bucket (22): ZERO OLI + ZERO FBA jobs, EXACTLY one Catalog job", () => { const jf = planPriorityBucket("non-us", 22).summary.plannedJobsByFamily; assert.equal(jf[OLI] || 0, 0); assert.equal(jf[FBA] || 0, 0); assert.equal(jf[CATALOG], 1); });
test("P3c. WITHOUT the priority pauses a normal plan WOULD create OLI + FBA (the cost the path avoids)", () => {
  const accounts = accountsFor("us", 8); const coverageByAccountId = {};
  for (const a of accounts) coverageByAccountId[a.accountId] = [];
  const jf = planMod.planBucketSourceSync({ apiKey: "prim-key", bucket: "us", accounts, existingMembership: new Map(), coverageByAccountId, catalogSnapshot: null, fbaSnapshotsByAccount: {}, pausedSources: new Set(), asOf: ASOF, today: TODAY }).summary.plannedJobsByFamily;
  assert.ok((jf[OLI] || 0) > 0); assert.ok((jf[FBA] || 0) > 0);
});

/* ===================== P4. the release composition (no caller-forgeable scope) ===================== */
group("P4. release composition: deriveBucket(bucket) only; finalizeBucket independently reconstructs scope");

const CAT_JOB_COLD = [{ source_key: CATALOG, request_hash: "cat-hash", fetch_status: "succeeded", create_export_count: 1 }];
const CAT_JOB_WARM = [{ source_key: CATALOG, request_hash: "cat-hash", fetch_status: "succeeded", create_export_count: 0, cache_object_path: "source-cache/v2/cat-hash.json" }];
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
    // token/reservation coherence (item 3):
    ["cold but no reservation", { reservedHash: null }, "no-reservation-for-create"],
    ["cold but reservation still 'reserved'", { reservationRow: { catalog_request_hash: "cat-hash", export_id: null, status: "reserved", tokens_spent: 0 } }, "reservation-not-created"],
    ["cold but reservation hash != job hash", { reservationRow: { catalog_request_hash: "other-hash", export_id: "e1", status: "created", tokens_spent: 2 } }, "reservation-hash-mismatch"],
    ["cold but blank export id", { reservationRow: { catalog_request_hash: "cat-hash", export_id: "", status: "created", tokens_spent: 2 } }, "reservation-no-export"],
    ["cold but tokens != 2", { reservationRow: { catalog_request_hash: "cat-hash", export_id: "e1", status: "created", tokens_spent: 5 } }, "reservation-tokens"],
    ["warm but a stray reservation exists", { srcJobs: CAT_JOB_WARM, reservedHash: "cat-hash" }, "reservation-present-without-create"],
    ["warm but no cache evidence", { srcJobs: [{ source_key: CATALOG, request_hash: "cat-hash", fetch_status: "succeeded", create_export_count: 0 }], reservedHash: null }, "no-cache-evidence"],
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
test("P10a. the EXACT live identity passes; an omitted or wrong params hash fails; a wrong live key fails", async () => {
  const RK = "daily-reporting";
  const contract = publisherCore.SCHEDULER_LIVE_SNAPSHOT_CONTRACTS[RK];
  const liveParams = { from: "2026-03-19", to: ASOF, brand: "ALL" };
  const PH = reportStore.paramsHashFor(contract.liveReportVersion, liveParams);
  const params = { reportVersion: contract.liveReportVersion, accountId: "A01", ...liveParams };
  const rows = new Map([["daily-reporting|A01|" + PH, { params_hash: PH, params, payload: { rows: [], brandFiltered: false, adsAvailability: { status: "unavailable" } }, payload_storage_path: null, source_refreshed_at: TS }]]);
  const readback = readbackFor(rows);
  assert.deepEqual(await readback({ reportKey: RK, liveReportKey: "daily-reporting", accountId: "A01", paramsHash: PH }), { ok: true });
  assert.equal((await readback({ reportKey: RK, liveReportKey: "daily-reporting", accountId: "A01", paramsHash: "" })).reason, "blank-params-hash");
  assert.equal((await readback({ reportKey: RK, liveReportKey: "daily-reporting", accountId: "A01", paramsHash: "WRONG" })).reason, "no-live-snapshot");
  assert.equal((await readback({ reportKey: RK, liveReportKey: "brand-sales", accountId: "A01", paramsHash: PH })).reason, "live-report-key-mismatch");
});
test("P10b. a mutated-after-save row fails provenance; a dangling storage payload fails; a bad payload fails the contract", async () => {
  const RK = "brand-sales";
  const contract = publisherCore.SCHEDULER_LIVE_SNAPSHOT_CONTRACTS[RK];
  const liveParams = { from: "2025-01-01", to: ASOF };
  const PH = reportStore.paramsHashFor(contract.liveReportVersion, liveParams);
  const good = { rows: [], catalogBrands: [], asinBrand: { B0A: "Acme" } };
  // params say a DIFFERENT to-date than the hash was computed from -> provenance fails.
  const mutated = new Map([["brand-sales|A01|" + PH, { params_hash: PH, params: { reportVersion: contract.liveReportVersion, accountId: "A01", from: "2025-01-01", to: "2026-01-01" }, payload: good, payload_storage_path: null, source_refreshed_at: TS }]]);
  assert.equal((await readbackFor(mutated)({ reportKey: RK, liveReportKey: "brand-sales", accountId: "A01", paramsHash: PH })).reason, "params-provenance");
  const params = { reportVersion: contract.liveReportVersion, accountId: "A01", ...liveParams };
  const dangling = new Map([["brand-sales|A01|" + PH, { params_hash: PH, params, payload: null, payload_storage_path: "missing", source_refreshed_at: TS }]]);
  assert.equal((await readbackFor(dangling)({ reportKey: RK, liveReportKey: "brand-sales", accountId: "A01", paramsHash: PH })).reason, "payload-dangling");
  const badPayload = new Map([["brand-sales|A01|" + PH, { params_hash: PH, params, payload: { rows: [], catalogBrands: [], asinBrand: {} }, payload_storage_path: null, source_refreshed_at: TS }]]); // empty asinBrand -> invalid
  assert.equal((await readbackFor(badPayload)({ reportKey: RK, liveReportKey: "brand-sales", accountId: "A01", paramsHash: PH })).reason, "payload-contract");
});

/* ===================== P11. the exact publication control package (prepared, guarded transaction) ===================== */
group("P11. control package: exact rollout/dispatch/promoted/approvals; rollback reverses it; fails closed");
test("P11a. buildPriorityControlPackage: exact rollout, ONLY 2 dispatch enabled (others paused), promoted enabled, 3xN approvals", () => {
  const pkg = controlPkg.buildPriorityControlPackage({ accounts: ["A02", "A01", "A01"], operator: "op@x" });
  assert.deepEqual(pkg.accounts, ["A01", "A02"]);
  assert.equal(pkg.apply.allPrimary, false);
  assert.deepEqual(pkg.apply.rollout.map((r) => [r.account_id, r.enabled]), [["A01", true], ["A02", true]]);
  assert.deepEqual(pkg.apply.reportSyncSettings.filter((s) => s.schedule_enabled).map((s) => s.report_key).sort(), ["brand-sales", "daily-reporting"]);
  assert.ok(pkg.apply.reportSyncSettings.some((s) => s.report_key === "keyword-rank" && s.schedule_enabled === false), "unrelated reports paused");
  assert.ok(!pkg.apply.reportSyncSettings.some((s) => s.report_key === "brand-inventory"), "brand-inventory is NOT a dispatch control");
  assert.deepEqual(pkg.apply.promoted, [{ report_key: "brand-inventory", publish_enabled: true }]);
  assert.equal(pkg.apply.approvals.length, 6);
  assert.ok(pkg.apply.approvals.every((a) => a.approved === true && a.approved_by === "op@x"));
});
test("P11b. rollback reverses exactly the package (rollout disabled, 2 dispatch paused, promoted disabled, approvals revoked)", () => {
  const pkg = controlPkg.buildPriorityControlPackage({ accounts: ["A01"], operator: "op" });
  assert.ok(pkg.rollback.rollout.every((r) => r.enabled === false));
  assert.deepEqual(pkg.rollback.reportSyncSettings.map((s) => [s.report_key, s.schedule_enabled]).sort(), [["brand-sales", false], ["daily-reporting", false]]);
  assert.deepEqual(pkg.rollback.promoted, [{ report_key: "brand-inventory", publish_enabled: false }]);
  assert.equal(pkg.rollback.approvals.length, 3);
  assert.ok(pkg.rollback.approvals.every((a) => a.approved === false));
});
test("P11c. post assertions describe the exact target state (all_primary false, exact scope, no cron)", () => {
  const pkg = controlPkg.buildPriorityControlPackage({ accounts: ["A01", "A02"], operator: "op" });
  assert.equal(pkg.post.allPrimaryFalse, true);
  assert.deepEqual(pkg.post.rolloutEnabled, ["A01", "A02"]);
  assert.deepEqual([...pkg.post.dispatchEnabled].sort(), ["brand-sales", "daily-reporting"]);
  assert.equal(pkg.post.promotedEnabled, "brand-inventory");
  assert.equal(pkg.post.approvals.length, 6);
  assert.equal(pkg.post.noCron, true);
  assert.ok(pkg.post.dispatchPaused.includes("keyword-rank") && !pkg.post.dispatchPaused.includes("daily-reporting"));
});
test("P11d. fails closed: empty accounts / dd-secondary account / blank operator", () => {
  assert.throws(() => controlPkg.buildPriorityControlPackage({ accounts: [], operator: "op" }), /primary account/);
  assert.throws(() => controlPkg.buildPriorityControlPackage({ accounts: ["dd-secondary:x"], operator: "op" }), /dd-secondary/);
  assert.throws(() => controlPkg.buildPriorityControlPackage({ accounts: ["A01"], operator: "" }), /operator id/);
});

async function main() {
  out("priority dashboards release proof suite");
  priorityMod = await import("../lib/server/sync/source-priority-dashboards.js");
  releaseRunner = await import("../lib/server/sync/source-priority-release-runner.js");
  controlPkg = await import("../lib/server/sync/source-priority-control-package.js");
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
