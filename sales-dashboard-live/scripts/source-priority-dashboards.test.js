// Scheduler v2 -- Daily Reporting + Brand View PRIORITY RELEASE unit + integration regressions (offline).
//
//   P1  the DURABLE Catalog create guard: ONLY product-catalog, at most ONE across the whole run (both buckets,
//       retries, restarts, concurrency, commit-unknown) via an atomic reservation keyed to the frozen operation
//       + exact canonical Catalog request hash; exact export-id adoption spends zero; ambiguous never re-creates.
//   P2  the frozen publication set is EXACTLY [daily-reporting, brand-sales, brand-inventory]; brand-sales is
//       ordered before brand-inventory; the allowlist refuses anything else (unknown never reaches the publisher).
//   P3  the bucket PLAN for all 30 covered accounts (8 US + 22 non-US) emits ZERO OLI/FBA jobs, ONE Catalog job.
//   P4  the release composition: priority bound at build time; verifyAndFinalize refuses unrelated/open/malformed
//       work and accepts only a strict finalized/terminal ack; publishAccount publishes the 3 reports in order.
//   P5  Brand View inventory renders missing FBA as inventoryAvailable:false.
//   P6  the REAL publisher returns not-successful for all 3 before finalization (running cycle) and publishes all
//       3 after a terminal cycle.
//   P7  the REAL buildAccountBrandSlice reads the published brand-sales + brand-inventory and renders fresh sales
//       with inventory unavailable.
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
const TODAY = "2026-08-20";
const ASOF = "2026-08-19";
const TS = "2026-08-19T10:00:00.000Z";

let priorityMod; let planMod; let brandView; let pubComposition; let publisherCore; let reportStore;

/* ---- a FAITHFUL fake of the durable reservation table (atomic insert-if-absent + record-if-absent) ---- */
function makeFakeReservation() {
  const rows = new Map(); // op|hash -> { export_id, status, tokens_spent }
  const k = (op, h) => op + "|" + h;
  return {
    _rows: rows,
    reserve: async ({ operationKey, catalogRequestHash }) => {
      const key = k(operationKey, catalogRequestHash);
      if (rows.has(key)) { const r = rows.get(key); return { disposition: "exists", exportId: r.export_id, status: r.status, tokensSpent: r.tokens_spent }; }
      rows.set(key, { export_id: null, status: "reserved", tokens_spent: 0 });
      return { disposition: "reserved" };
    },
    recordExport: async ({ operationKey, catalogRequestHash, exportId, tokens }) => {
      const r = rows.get(k(operationKey, catalogRequestHash));
      if (!r) return { disposition: "not-reserved" };
      if (r.export_id != null) return r.export_id === exportId ? { disposition: "already-recorded", exportId: r.export_id } : { disposition: "conflict", exportId: r.export_id };
      r.export_id = exportId; r.status = "created"; r.tokens_spent = tokens;
      return { disposition: "recorded", exportId };
    },
    get: async ({ operationKey, catalogRequestHash }) => rows.get(k(operationKey, catalogRequestHash)) || null,
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
const catalogJob = { sourceKey: CATALOG, requestHash: "cat-hash" };

/* ============================= P1. durable one-Catalog-export / two-token guard ============================= */
group("P1. DURABLE Catalog guard: only product-catalog, at most one across buckets/retries/restart/concurrency");

test("P1a. winner creates once + records; a second guard sharing the reservation ADOPTS (zero create), 2 tokens total", async () => {
  const reservation = makeFakeReservation();
  const c1 = []; const g1 = priorityMod.makeDurableCatalogGuard({ inner: makeInner(c1), reservation, operationKey: OP() });
  const r1 = await g1.create(catalogJob);
  assert.deepEqual(c1, [CATALOG], "the winner performed the one create");
  assert.ok(r1 && r1.exportId, "winner returned an export id");
  // A SECOND guard (models the Non-US bucket / a restart) -- ADOPTS the recorded export id, ZERO create.
  const c2 = []; const g2 = priorityMod.makeDurableCatalogGuard({ inner: makeInner(c2), reservation, operationKey: OP() });
  const r2 = await g2.create(catalogJob);
  assert.equal(c2.length, 0, "the second bucket created NOTHING (adopted)");
  assert.equal(r2.adopted, true, "the second bucket adopted the export");
  assert.equal(r2.exportId, r1.exportId, "same export id adopted");
  const row = await reservation.get({ operationKey: OP(), catalogRequestHash: "cat-hash" });
  assert.equal(row.tokens_spent, 2, "exactly two tokens ever spent");
  assert.equal(row.status, "created");
});

test("P1b. ANY non-catalog create throws PRIORITY_FORBIDDEN_CREATE and never reaches the adapter or a reservation", async () => {
  const created = []; const g = priorityMod.makeDurableCatalogGuard({ inner: makeInner(created), reservation: makeFakeReservation(), operationKey: OP() });
  for (const sk of [OLI, FBA, "ads-campaign-date", "settlements", ""]) {
    await assert.rejects(() => g.create({ sourceKey: sk, requestHash: "h" }), (e) => /PRIORITY_FORBIDDEN_CREATE/.test(e.message), "rejected " + sk);
  }
  assert.equal(created.length, 0);
});

test("P1c. COMMIT-UNKNOWN: the winner's create throws -> reservation stays open -> a retry is AMBIGUOUS, never a second create", async () => {
  const reservation = makeFakeReservation();
  const c1 = []; const g1 = priorityMod.makeDurableCatalogGuard({ inner: makeInner(c1, { throwOnCreate: true }), reservation, operationKey: OP() });
  await assert.rejects(() => g1.create(catalogJob), (e) => /commit-unknown boom/.test(e.message));
  assert.deepEqual(c1, [CATALOG], "exactly one create was ATTEMPTED (its commit is unknown)");
  // A retry / another process must NOT create a second export.
  const c2 = []; const g2 = priorityMod.makeDurableCatalogGuard({ inner: makeInner(c2), reservation, operationKey: OP() });
  await assert.rejects(() => g2.create(catalogJob), (e) => /PRIORITY_CATALOG_RESERVATION_AMBIGUOUS/.test(e.message));
  assert.equal(c2.length, 0, "no second create after a commit-unknown");
});

test("P1d. CONCURRENCY: a reservation already held (no export yet) makes a concurrent create AMBIGUOUS, never a second create", async () => {
  const reservation = makeFakeReservation();
  await reservation.reserve({ operationKey: OP(), catalogRequestHash: "cat-hash" }); // a concurrent winner reserved first
  const created = []; const g = priorityMod.makeDurableCatalogGuard({ inner: makeInner(created), reservation, operationKey: OP() });
  await assert.rejects(() => g.create(catalogJob), (e) => /PRIORITY_CATALOG_RESERVATION_AMBIGUOUS/.test(e.message));
  assert.equal(created.length, 0);
});

test("P1e. poll + download pass through untouched", async () => {
  const g = priorityMod.makeDurableCatalogGuard({ inner: makeInner([]), reservation: makeFakeReservation(), operationKey: OP() });
  assert.equal(await g.poll({}), "polled");
  assert.deepEqual(await g.download({}), ["row"]);
});

test("P1f. a Catalog job with no canonical request hash fails closed (no create, no reservation)", async () => {
  const created = []; const g = priorityMod.makeDurableCatalogGuard({ inner: makeInner(created), reservation: makeFakeReservation(), operationKey: OP() });
  await assert.rejects(() => g.create({ sourceKey: CATALOG, requestHash: "" }), (e) => /PRIORITY_CATALOG_HASH_MISSING/.test(e.message));
  assert.equal(created.length, 0);
});

/* ============================= P2. the frozen publication set (three reports) ============================= */
group("P2. publish allowlist + order: daily-reporting, brand-sales BEFORE brand-inventory");

test("P2a. the three priority reports are admitted; every other report is refused", () => {
  for (const rk of ["daily-reporting", "brand-sales", "brand-inventory"]) assert.equal(priorityMod.assertPriorityPublishReportKey(rk), rk);
  for (const rk of ["reconciliation", "keyword-rank", "content-changes", "listing-optimizer", "", "brand-inventory "]) {
    assert.throws(() => priorityMod.assertPriorityPublishReportKey(rk), (e) => /PRIORITY_PUBLISH_FORBIDDEN/.test(e.message), "refused " + JSON.stringify(rk));
  }
});

test("P2b. frozen scope constants are exactly the reviewed values; brand-sales precedes brand-inventory", () => {
  const C = priorityMod.PRIORITY_DASHBOARDS;
  assert.deepEqual([...C.reportKeys], ["daily-reporting", "brand-sales", "brand-inventory"]);
  assert.deepEqual([...C.publishOrder], ["daily-reporting", "brand-sales", "brand-inventory"]);
  assert.ok(C.publishOrder.indexOf("brand-sales") < C.publishOrder.indexOf("brand-inventory"), "brand-sales BEFORE brand-inventory");
  assert.deepEqual([...C.buckets], ["us", "non-us"]);
  assert.equal(C.catalogSourceKey, CATALOG);
  assert.equal(C.maxCatalogCreates, 1);
  assert.equal(C.maxTokens, 2);
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
  const accounts = accountsFor(bucket, n);
  const coverageByAccountId = {};
  for (const a of accounts) coverageByAccountId[a.accountId] = [{ from: "2025-01-01", to: TODAY }];
  return planMod.planBucketSourceSync({ apiKey: "prim-key", bucket, accounts, existingMembership: new Map(), coverageByAccountId, catalogSnapshot: null, fbaSnapshotsByAccount: {}, pausedSources, asOf: ASOF, today: TODAY, forceCatalogRefresh: true });
}
test("P3a. US bucket (8): ZERO OLI + ZERO FBA jobs, EXACTLY one Catalog job", () => {
  const jf = planPriorityBucket("us", 8).summary.plannedJobsByFamily;
  assert.equal(jf[OLI] || 0, 0); assert.equal(jf[FBA] || 0, 0); assert.equal(jf[CATALOG], 1);
});
test("P3b. Non-US bucket (22): ZERO OLI + ZERO FBA jobs, EXACTLY one Catalog job", () => {
  const jf = planPriorityBucket("non-us", 22).summary.plannedJobsByFamily;
  assert.equal(jf[OLI] || 0, 0); assert.equal(jf[FBA] || 0, 0); assert.equal(jf[CATALOG], 1);
});
test("P3c. WITHOUT the priority pauses a normal plan WOULD create OLI + FBA (the cost the path avoids)", () => {
  const accounts = accountsFor("us", 8); const coverageByAccountId = {};
  for (const a of accounts) coverageByAccountId[a.accountId] = [];
  const jf = planMod.planBucketSourceSync({ apiKey: "prim-key", bucket: "us", accounts, existingMembership: new Map(), coverageByAccountId, catalogSnapshot: null, fbaSnapshotsByAccount: {}, pausedSources: new Set(), asOf: ASOF, today: TODAY }).summary.plannedJobsByFamily;
  assert.ok((jf[OLI] || 0) > 0); assert.ok((jf[FBA] || 0) > 0);
});

/* ===================== P4. the release composition (build-time priority, verify+finalize, publish) ===================== */
group("P4. release composition: priority bound at build, reviewed cycle-close, ordered publish");

function makeRelease(over = {}) {
  return priorityMod.buildPriorityDashboardsRelease({
    buildRuntime: over.buildRuntime || (() => ({ makeDeadline: () => ({}), preflightEvidence: async () => ({}), run: async () => ({}) })),
    makeInnerAdapter: over.makeInnerAdapter || (() => makeInner([])),
    buildPublisher: over.buildPublisher || (() => ({ publish: async () => ({ disposition: "published" }) })),
    reservation: over.reservation || makeFakeReservation(),
    makeStore: over.makeStore || (() => ({ listSourceJobs: async () => [], finalizeCycle: async () => ({}) })),
    listReportJobs: over.listReportJobs || (async () => []),
  });
}

test("P4a. deriveBucket binds priorityMode at BUILD time, passes NO run() priority arg, and installs the catalog-only guard", async () => {
  let captured = null; const runCalls = [];
  const rel = makeRelease({ buildRuntime: (o) => { captured = o; return { makeDeadline: () => ({}), preflightEvidence: async () => ({}), run: async (a) => { runCalls.push(a); return { cycleId: "cyc", derived: { skipped: null } }; } }; } });
  await rel.deriveBucket("us", {});
  assert.equal(captured.priorityMode, true, "priorityMode bound at build");
  assert.equal(runCalls[runCalls.length - 1].bucket, "us");
  assert.ok(!("priority" in runCalls[runCalls.length - 1]), "run() received NO priority argument");
  const guarded = captured.makeAdapter({});
  await assert.rejects(() => guarded.create({ sourceKey: OLI, requestHash: "h" }), (e) => /PRIORITY_FORBIDDEN_CREATE/.test(e.message));
});

test("P4b. deriveBucket refuses an unknown bucket", async () => {
  await assert.rejects(() => makeRelease().deriveBucket("europe", {}), (e) => /bucket in us\|non-us/.test(e.message));
});

const CAT_OK = [{ source_key: CATALOG, fetch_status: "succeeded" }];
function repJobsFor(accts, over = {}) {
  const jobs = [];
  for (const a of accts) for (const rk of ["daily-reporting", "brand-sales", "brand-inventory"]) {
    jobs.push({ report_key: rk, account_id: a, validated: true, derive_status: "succeeded", save_status: "succeeded", snapshot_params_hash: "h_" + rk });
  }
  return over.mutate ? over.mutate(jobs) : jobs;
}

test("P4c. verifyAndFinalize ACCEPTS a catalog-only cycle whose 3 report jobs are all validated, then finalizes terminal", async () => {
  const rel = makeRelease({ makeStore: () => ({ listSourceJobs: async () => CAT_OK, finalizeCycle: async () => ({ disposition: "finalized", cycle: { status: "succeeded" } }) }), listReportJobs: async () => repJobsFor(["A01"]) });
  const res = await rel.verifyAndFinalize({ cycleId: "cyc", expectedAccountIds: ["A01"] });
  assert.equal(res.disposition, "finalized");
  assert.equal(res.cycleStatus, "succeeded");
});

test("P4d. verifyAndFinalize REFUSES unrelated/open/malformed work and non-terminal finalize acks", async () => {
  const cases = [
    { name: "unrelated source job", store: { listSourceJobs: async () => [{ source_key: OLI, fetch_status: "succeeded" }], finalizeCycle: async () => ({}) }, rep: repJobsFor(["A01"]), reason: "unrelated-source-job" },
    { name: "source job not succeeded", store: { listSourceJobs: async () => [{ source_key: CATALOG, fetch_status: "pending" }], finalizeCycle: async () => ({}) }, rep: repJobsFor(["A01"]), reason: "source-job-not-terminal-successful" },
    { name: "unrelated report job", store: { listSourceJobs: async () => CAT_OK, finalizeCycle: async () => ({}) }, rep: repJobsFor(["A01"]).concat([{ report_key: "keyword-rank", account_id: "A01", validated: true, derive_status: "succeeded", save_status: "succeeded", snapshot_params_hash: "h" }]), reason: "unrelated-report-job" },
    { name: "unexpected account", store: { listSourceJobs: async () => CAT_OK, finalizeCycle: async () => ({}) }, rep: repJobsFor(["A02"]), reason: "unexpected-account-report-job" },
    { name: "report not validated", store: { listSourceJobs: async () => CAT_OK, finalizeCycle: async () => ({}) }, rep: repJobsFor(["A01"], { mutate: (j) => { j[0].validated = false; return j; } }), reason: "report-job-not-validated" },
    { name: "missing report job", store: { listSourceJobs: async () => CAT_OK, finalizeCycle: async () => ({}) }, rep: repJobsFor(["A01"]).filter((j) => j.report_key !== "brand-sales"), reason: "missing-report-job" },
    { name: "finalize open-work", store: { listSourceJobs: async () => CAT_OK, finalizeCycle: async () => ({ disposition: "open-work", cycle: { status: "running" } }) }, rep: repJobsFor(["A01"]), reason: "open-work" },
    { name: "finalize not-found", store: { listSourceJobs: async () => CAT_OK, finalizeCycle: async () => ({ disposition: "not-found" }) }, rep: repJobsFor(["A01"]), reason: "finalize-not-found" },
  ];
  for (const c of cases) {
    const rel = makeRelease({ makeStore: () => c.store, listReportJobs: async () => c.rep });
    const res = await rel.verifyAndFinalize({ cycleId: "cyc", expectedAccountIds: ["A01"] });
    assert.equal(res.disposition, "refused", c.name + " must be refused");
    assert.equal(res.reason, c.reason, c.name + " reason");
  }
});

test("P4e. publishAccount publishes daily-reporting, brand-sales, brand-inventory -- brand-sales BEFORE brand-inventory", async () => {
  const pubCalls = [];
  const rel = makeRelease({ buildPublisher: () => ({ publish: async (rk) => { pubCalls.push(rk); return { disposition: "published" }; } }) });
  const out = await rel.publishAccount("A01");
  assert.deepEqual(pubCalls, ["daily-reporting", "brand-sales", "brand-inventory"]);
  assert.ok(pubCalls.indexOf("brand-sales") < pubCalls.indexOf("brand-inventory"));
  assert.equal(out.results.length, 3);
  assert.ok(out.results.every((r) => r.disposition === "published"));
});

/* ===================== P5. Brand View inventory renders missing FBA as unavailable ===================== */
group("P5. Brand View inventory contract: missing FBA => inventoryAvailable:false");

test("P5a. buildBrandInventoryPayload with empty rows yields inventoryAvailable:false, null date, empty table", () => {
  const payload = brandView.buildBrandInventoryPayload({ accountId: "A01", invRows: [], brandByAsin: new Map([["B0A", "Acme"]]), accountCountry: "US", from: "2026-06-01", to: ASOF, rowLimit: 100000 });
  assert.equal(payload.inventoryAvailable, false);
  assert.equal(payload.inventoryDate, null);
  assert.deepEqual(payload.inventoryByBrandCountry, []);
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
    getSnapshot: async ({ reportKey, accountId }) => { const rk = reportKey.replace("scheduler-v2/", ""); return { params_hash: hashFor(rk), params: SPECS[rk].params, payload: SPECS[rk].payload, payload_storage_path: null, source_refreshed_at: TS }; },
    publishLive: async () => ({ outcome: "inserted" }),
  });
}
function releaseWithRealPublisher(cycleStatus) {
  return priorityMod.buildPriorityDashboardsRelease({
    buildRuntime: () => ({ makeDeadline: () => ({}), preflightEvidence: async () => ({}), run: async () => ({}) }),
    makeInnerAdapter: () => makeInner([]),
    buildPublisher: () => realPublisher(cycleStatus),
    reservation: makeFakeReservation(),
    makeStore: () => ({ listSourceJobs: async () => [], finalizeCycle: async () => ({}) }),
    listReportJobs: async () => [],
  });
}

test("P6a. BEFORE finalization (cycle running) the real publisher returns not-successful for ALL THREE", async () => {
  const out = await releaseWithRealPublisher("running").publishAccount("A01");
  assert.equal(out.results.length, 3);
  for (const r of out.results) assert.equal(r.disposition, "not-successful", r.reportKey + " must be not-successful before finalization");
});

test("P6b. AFTER a terminal cycle the real publisher PUBLISHES all three", async () => {
  const out = await releaseWithRealPublisher("succeeded").publishAccount("A01");
  assert.deepEqual(out.results.map((r) => r.reportKey), ["daily-reporting", "brand-sales", "brand-inventory"]);
  for (const r of out.results) assert.equal(r.disposition, "published", r.reportKey + " must publish after finalization");
});

/* ===================== P7. buildAccountBrandSlice reads the published brand-sales + brand-inventory ===================== */
group("P7. Brand View slice reads fresh brand-sales + brand-inventory; renders fresh sales, inventory unavailable");

test("P7a. the REAL buildAccountBrandSlice renders fresh sales from published brand-sales and inventory unavailable from an empty compact brand-inventory", async () => {
  const brandSalesPayload = { rows: [{ date: "2026-07-27", marketplace_country_code: "US", currency: "USD", product_brand: "Acme", total_sales: 210, total_units_sold: 21 }], catalogBrands: ["Acme"], asinBrand: { B0A: "Acme" } };
  const compactInventory = { params: { reportVersion: "brand-inventory-shared-v1" }, payload: { inventoryByBrandCountry: [], inventoryDate: null, inventoryAvailable: false }, source_refreshed_at: TS };
  const getSnapshot = async ({ reportKey }) => {
    if (reportKey === "brand-sales") return { params: SPECS["brand-sales"].params, payload: brandSalesPayload, source_refreshed_at: TS };
    if (reportKey === "brand-inventory") return compactInventory;
    return null;
  };
  const slice = await brandView.buildAccountBrandSlice({ accountId: "A01", brand: "Acme", asOf: ASOF, account: { country: "US" }, getSnapshot, getAdsRows: async () => [] });
  assert.ok(slice.sales && slice.sales.series && slice.sales.series.size > 0, "fresh sales rendered from the published brand-sales");
  assert.equal(slice.inventory.scope, "unavailable", "inventory is UNAVAILABLE (empty compact brand-inventory)");
  assert.equal(slice.inventoryDate, null, "no fabricated inventory date");
});

async function main() {
  out("priority dashboards release proof suite");
  priorityMod = await import("../lib/server/sync/source-priority-dashboards.js");
  planMod = await import("../lib/server/sync/source-bucket-sync.js");
  brandView = await import("../lib/server/reports/brand-view.js");
  pubComposition = await import("../lib/server/sync/publisher-composition.js");
  publisherCore = await import("../lib/server/sync/report-publisher.js");
  reportStore = await import("../lib/server/report-store.js");

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
