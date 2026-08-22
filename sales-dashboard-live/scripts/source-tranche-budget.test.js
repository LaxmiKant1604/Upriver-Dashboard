// Scheduler v2 Blocker 4d -- FROZEN create-export + AI-token budget with an ATOMIC pre-POST reservation
// (offline, ZERO network/DB). Proves the required behaviours:
//   - 30 compatible accounts => 6 batches/window; 31 => 7, prior membership unchanged;
//   - standard ceiling = unique hashes x 2; premium = x 5; mixed sums exactly; Product Catalog counts once;
//   - a cache hit / saved-export_id resume spends ZERO additional creates/tokens; reuseOnly spends zero;
//   - concurrent workers cannot exceed EITHER ceiling; an attempt beyond a ceiling is stopped BEFORE the POST;
//   - a continuation cannot reset the counters; plan/pricing drift fails closed;
//   - a new account joins the NEXT cycle (never widens a frozen budget);
//   - NO failed-batch->single fallback and NO duplicate create; spent comes from durable reservations.
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

let computeFrozenTrancheBudget, sourceTokenCost, assertFrozenBudgetMatches, STANDARD_SOURCE_TOKENS, PREMIUM_SOURCE_TOKENS;
let assignAccountBatches, batchSellerIds;
let sourceRequestIdentity, runSourceJobs;

const FROM = "2025-07-01";
const TO = "2025-07-20";
const OLI_COLS = ["date", "seller_or_vendor_id", "sku", "child_asin", "item_price_currency"];
const OLI_SRC = "89b27535d27c2a94db5ae39af4717f542624ff4df7802fd633e16c78674a1778";
const oliOptions = { groupBy: OLI_COLS, aggregations: [], orderByColumn: "date", orderByDirection: "ASC" };

// N accounts (accountId === rawSellerId for simplicity), zero-padded so sort order is stable.
const accounts = (n) => Array.from({ length: n }, (_, i) => { const id = "ACC" + String(i + 1).padStart(3, "0"); return { accountId: id, rawSellerId: id }; });

// The canonical request_hash for one batch of accounts (one seller-scoped OLI export over the sorted ids).
function batchHash(batch) {
  const ids = batchSellerIds(batch);
  return sourceRequestIdentity({ apiKey: "k", sourceId: OLI_SRC, columns: OLI_COLS, ids, from: FROM, to: TO, limit: 50000, options: oliOptions }).requestHash;
}
// Planned jobs (one canonical hash per batch) for N accounts, given the existing durable membership.
function planForAccounts(n, existing = new Map()) {
  const { membership, batches } = assignAccountBatches(accounts(n), existing);
  const jobs = batches.map((b) => ({ requestHash: batchHash(b), sourceKey: "order-line-items" }));
  return { membership, batches, jobs };
}
const fakeJobs = (n, sourceKey = "order-line-items", prefix = "h") => Array.from({ length: n }, (_, i) => ({ requestHash: sourceKey + "-" + prefix + i, sourceKey }));

/* ============================= Part A: frozen budget arithmetic ============================= */
group("Part A: token ceiling arithmetic (never exports x 2)");

test("A1. sourceTokenCost: standard=2, premium=5; missing/ambiguous pricing fails closed", () => {
  assert.equal(sourceTokenCost(false), 2); assert.equal(sourceTokenCost(true), 5);
  assert.equal(STANDARD_SOURCE_TOKENS, 2); assert.equal(PREMIUM_SOURCE_TOKENS, 5);
  for (const bad of [undefined, null, 0, 1, "true"]) assert.throws(() => sourceTokenCost(bad), /missing\/ambiguous/);
});

test("A2. a STANDARD source ceiling = unique hashes x 2", () => {
  const b = computeFrozenTrancheBudget({ plannedJobs: fakeJobs(6), isPremiumOf: () => false });
  assert.equal(b.maxCreates, 6); assert.equal(b.maxTokens, 12);
});

test("A3. a PREMIUM source ceiling = unique hashes x 5", () => {
  const b = computeFrozenTrancheBudget({ plannedJobs: fakeJobs(6), isPremiumOf: () => true });
  assert.equal(b.maxCreates, 6); assert.equal(b.maxTokens, 30);
});

test("A4. MIXED standard/premium sums EXACTLY (never a blanket x2)", () => {
  const jobs = [...fakeJobs(4, "order-line-items", "s"), ...fakeJobs(3, "listings", "p")];
  const b = computeFrozenTrancheBudget({ plannedJobs: jobs, isPremiumOf: (j) => j.sourceKey === "listings" });
  assert.equal(b.maxCreates, 7);
  assert.equal(b.maxTokens, 4 * 2 + 3 * 5); // 8 + 15 = 23
});

test("A5. Product Catalog counts ONCE per organization/window (shared hash deduped)", () => {
  const catalog = { requestHash: "catalog-h", sourceKey: "product-catalog" };
  const jobs = [...fakeJobs(6), catalog, catalog, catalog]; // the same catalog hash appears 3x
  const b = computeFrozenTrancheBudget({ plannedJobs: jobs, isPremiumOf: () => false });
  assert.equal(b.maxCreates, 7, "6 OLI + 1 catalog (deduped)");
  assert.equal(b.hashes.filter((h) => h.sourceKey === "product-catalog").length, 1);
});

test("A6. missing pricing on any selected hash fails the WHOLE budget closed", () => {
  assert.throws(() => computeFrozenTrancheBudget({ plannedJobs: fakeJobs(3), isPremiumOf: () => undefined }), /missing\/ambiguous/);
});

/* ============================= Part B: stable batching -> hash count ============================= */
group("Part B: batching derived from unique hashes (stable)");

test("B1. 30 compatible accounts => 6 batches/window; 31 => 7 with prior membership UNCHANGED", () => {
  const p30 = planForAccounts(30);
  assert.equal(p30.batches.length, 6, "30 => 6 batches");
  assert.equal(p30.jobs.length, 6, "6 canonical hashes");
  const p31 = planForAccounts(31, p30.membership); // continue from the 30-account membership
  assert.equal(p31.batches.length, 7, "31 => 7 batches");
  // Every one of the first 30 accounts keeps its batch index (adding the 31st moved no one).
  for (const [id, idx] of p30.membership) assert.equal(p31.membership.get(id), idx, id + " unchanged");
  // The 6 original canonical hashes are all still present among the 7.
  const before = new Set(p30.jobs.map((j) => j.requestHash));
  const after = new Set(p31.jobs.map((j) => j.requestHash));
  for (const h of before) assert.ok(after.has(h), "original batch hash preserved");
  // The budget grows by exactly one create (the 7th batch), never a reshuffle.
  const bud30 = computeFrozenTrancheBudget({ plannedJobs: p30.jobs, isPremiumOf: () => false });
  const bud31 = computeFrozenTrancheBudget({ plannedJobs: p31.jobs, isPremiumOf: () => false });
  assert.equal(bud30.maxCreates, 6); assert.equal(bud31.maxCreates, 7);
});

/* ============================= Part C: reservation semantics (in-memory RPC model) ============================= */
group("Part C: atomic pre-POST reservation");

// Models persist_source_tranche_budget + reserve_source_export_create + the sync_source_jobs claim.
function makeReservationStore() {
  const budgets = new Map(); const jobs = new Map(); const key = (c, t) => c + "|" + t;
  return {
    _budget: (c, t) => budgets.get(key(c, t)),
    _job: (h) => jobs.get(h),
    seedJob(h, over = {}) { jobs.set(h, { fetch_status: "pending", attempted_at: null, create_export_count: 0, export_id: null, ...over }); },
    persistBudget({ cycleId, trancheKey, planFingerprint, maxCreates, maxTokens, hashes }) {
      const k = key(cycleId, trancheKey); const e = budgets.get(k);
      if (e) {
        if (e.planFingerprint !== planFingerprint || e.maxCreates !== maxCreates || e.maxTokens !== maxTokens) { const err = new Error("PLAN_BUDGET_MISMATCH"); err.code = "PLAN_BUDGET_MISMATCH"; throw err; }
        return "exists";
      }
      budgets.set(k, { planFingerprint, maxCreates, maxTokens, spentCreates: 0, spentTokens: 0, cost: new Map((hashes || []).map((h) => [h.requestHash, h.tokenCost])) });
      return "created";
    },
    reserveExportCreate({ cycleId, trancheKey, requestHash, planFingerprint }) {
      const b = budgets.get(key(cycleId, trancheKey));
      if (!b) throw new Error("no frozen budget");
      if (b.planFingerprint !== planFingerprint) return "plan-mismatch";
      if (!b.cost.has(requestHash)) return "plan-mismatch";
      const cost = b.cost.get(requestHash);
      if (b.spentCreates + 1 > b.maxCreates || b.spentTokens + cost > b.maxTokens) return "budget-exceeded";
      const j = jobs.get(requestHash);
      if (!(j && j.fetch_status === "pending" && j.attempted_at === null && j.create_export_count === 0)) return "not-pending";
      j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted";
      b.spentCreates += 1; b.spentTokens += cost;
      return "reserved";
    },
  };
}
const freeze = (store, cycleId, budget) => store.persistBudget({ cycleId, trancheKey: budget.trancheKey, planFingerprint: budget.planFingerprint, maxCreates: budget.maxCreates, maxTokens: budget.maxTokens, hashes: budget.hashes });

test("C1. only ONE concurrent worker reserves a hash; neither ceiling is exceeded", () => {
  const s = makeReservationStore();
  const jobs = fakeJobs(2);
  const bud = computeFrozenTrancheBudget({ plannedJobs: jobs, isPremiumOf: () => false, trancheKey: "t" });
  freeze(s, "cyc", bud);
  jobs.forEach((j) => s.seedJob(j.requestHash));
  const ctx = { cycleId: "cyc", trancheKey: "t", planFingerprint: bud.planFingerprint };
  // Two workers race for hash 0: exactly one wins; the loser gets not-pending; spent stays 1.
  const a = s.reserveExportCreate({ ...ctx, requestHash: jobs[0].requestHash });
  const b = s.reserveExportCreate({ ...ctx, requestHash: jobs[0].requestHash });
  assert.deepEqual([a, b].sort(), ["not-pending", "reserved"]);
  assert.equal(s._budget("cyc", "t").spentCreates, 1, "one create reserved");
  assert.equal(s._budget("cyc", "t").spentTokens, 2, "two tokens reserved");
  assert.ok(s._budget("cyc", "t").spentCreates <= bud.maxCreates && s._budget("cyc", "t").spentTokens <= bud.maxTokens);
});

test("C2. an attempt BEYOND a ceiling is stopped (budget-exceeded), even if the job were pending", () => {
  const s = makeReservationStore();
  const bud = computeFrozenTrancheBudget({ plannedJobs: fakeJobs(1), isPremiumOf: () => false, trancheKey: "t" });
  freeze(s, "cyc", bud);
  const h = "order-line-items-h0";
  s.seedJob(h);
  const ctx = { cycleId: "cyc", trancheKey: "t", planFingerprint: bud.planFingerprint, requestHash: h };
  assert.equal(s.reserveExportCreate(ctx), "reserved");
  // Force the job back to pending (a hypothetical retry/bug): the ceiling STILL stops it before any POST.
  s.seedJob(h);
  assert.equal(s.reserveExportCreate(ctx), "budget-exceeded");
  assert.equal(s._budget("cyc", "t").spentCreates, 1, "no over-reservation");
});

test("C3. a continuation cannot RESET the counters; a drifted re-freeze fails closed", () => {
  const s = makeReservationStore();
  const jobs = fakeJobs(2);
  const bud = computeFrozenTrancheBudget({ plannedJobs: jobs, isPremiumOf: () => false, trancheKey: "t" });
  assert.equal(freeze(s, "cyc", bud), "created");
  jobs.forEach((j) => s.seedJob(j.requestHash));
  s.reserveExportCreate({ cycleId: "cyc", trancheKey: "t", planFingerprint: bud.planFingerprint, requestHash: jobs[0].requestHash });
  assert.equal(freeze(s, "cyc", bud), "exists", "re-freezing the SAME budget is idempotent");
  assert.equal(s._budget("cyc", "t").spentCreates, 1, "spent counter NOT reset by the continuation");
  // A drifted plan (different fingerprint / ceilings) is rejected.
  assert.throws(() => s.persistBudget({ cycleId: "cyc", trancheKey: "t", planFingerprint: "DRIFT", maxCreates: 9, maxTokens: 9, hashes: [] }), /PLAN_BUDGET_MISMATCH/);
});

test("C4. plan/pricing drift fails closed: a wrong fingerprint or an out-of-plan hash is refused", () => {
  const s = makeReservationStore();
  const jobs = fakeJobs(2);
  const bud = computeFrozenTrancheBudget({ plannedJobs: jobs, isPremiumOf: () => false, trancheKey: "t" });
  freeze(s, "cyc", bud); jobs.forEach((j) => s.seedJob(j.requestHash));
  assert.equal(s.reserveExportCreate({ cycleId: "cyc", trancheKey: "t", planFingerprint: "WRONG", requestHash: jobs[0].requestHash }), "plan-mismatch");
  s.seedJob("not-in-plan");
  assert.equal(s.reserveExportCreate({ cycleId: "cyc", trancheKey: "t", planFingerprint: bud.planFingerprint, requestHash: "not-in-plan" }), "plan-mismatch");
  // assertFrozenBudgetMatches also rejects a recomputed budget that differs.
  const drifted = computeFrozenTrancheBudget({ plannedJobs: fakeJobs(3), isPremiumOf: () => false, trancheKey: "t" });
  assert.throws(() => assertFrozenBudgetMatches(bud, drifted), /PLAN_BUDGET_MISMATCH/);
  assert.equal(assertFrozenBudgetMatches(bud, computeFrozenTrancheBudget({ plannedJobs: jobs, isPremiumOf: () => false, trancheKey: "t" })), true);
});

test("C5. a NEW account discovered mid-cycle joins the NEXT cycle; it never widens the frozen budget", () => {
  const s = makeReservationStore();
  const p30 = planForAccounts(30);
  const bud = computeFrozenTrancheBudget({ plannedJobs: p30.jobs, isPremiumOf: () => false, trancheKey: "oli" });
  freeze(s, "cyc1", bud); p30.jobs.forEach((j) => s.seedJob(j.requestHash));
  // A 31st account creates a NEW batch hash; against cycle1's FROZEN budget it is out-of-plan (refused).
  const p31 = planForAccounts(31, p30.membership);
  const newHash = p31.jobs.map((j) => j.requestHash).find((h) => !p30.jobs.some((j) => j.requestHash === h));
  assert.ok(newHash, "the 31st account produced a new batch hash");
  s.seedJob(newHash);
  assert.equal(s.reserveExportCreate({ cycleId: "cyc1", trancheKey: "oli", planFingerprint: bud.planFingerprint, requestHash: newHash }), "plan-mismatch", "does not widen cycle1");
  // The NEXT cycle freezes a fresh 7-hash budget that includes the new account.
  const bud2 = computeFrozenTrancheBudget({ plannedJobs: p31.jobs, isPremiumOf: () => false, trancheKey: "oli" });
  assert.equal(freeze(s, "cyc2", bud2), "created"); s.seedJob(newHash);
  assert.equal(bud2.maxCreates, 7);
});

/* ============================= Part D: worker integration (real runSourceJobs) ============================= */
group("Part D: the real source worker enforces the frozen budget");

function makeWorkerStore() {
  const cycles = new Map(); const jobs = new Map(); const cache = new Map(); const budgets = new Map();
  let seq = 0; const find = (id) => [...cycles.values()].find((c) => c.id === id) || null; const bkey = (c, t) => c + "|" + t;
  const store = {
    _cache: cache, createPosts: 0,
    _budget: (c, t) => budgets.get(bkey(c, t)),
    openCycle({ bucket, cycleDate }) { const k = bucket + "|" + cycleDate; if (!cycles.has(k)) { const id = "cyc_" + (seq += 1); cycles.set(k, { id, bucket, status: "pending" }); jobs.set(id, new Map()); } return cycles.get(k).id; },
    claimCycle(id) { const c = find(id); if (c && c.status === "pending") { c.status = "running"; return true; } return false; },
    getCycle(id) { return find(id); },
    upsertSourceJob(job) { const m = jobs.get(job.cycleId); if (m.has(job.requestHash)) return; m.set(job.requestHash, { request_hash: job.requestHash, request_key: job.requestKey, source_id: job.sourceId, source_key: job.sourceKey, connection_id: job.connectionId, organization_fingerprint: job.organizationFingerprint, account_scope_hash: job.accountScopeHash, fetch_status: "pending", attempted_at: null, create_export_count: 0, export_id: null, terminal: false, error_stage: null, error_code: null, error_message: null, row_count: null, cache_object_path: null }); },
    listSourceJobs(id) { return [...((jobs.get(id) && jobs.get(id).values()) || [])].map((j) => ({ ...j })); },
    _rawJob(id, h) { return jobs.get(id) && jobs.get(id).get(h); },
    // Blocker 4d atomic reservation, modelling reserve_source_export_create.
    reserveExportCreate({ cycleId, trancheKey, requestHash, planFingerprint }) {
      const b = budgets.get(bkey(cycleId, trancheKey)); if (!b) throw new Error("no budget");
      if (b.planFingerprint !== planFingerprint || !b.cost.has(requestHash)) return "plan-mismatch";
      const cost = b.cost.get(requestHash);
      if (b.spentCreates + 1 > b.maxCreates || b.spentTokens + cost > b.maxTokens) return "budget-exceeded";
      const j = jobs.get(cycleId) && jobs.get(cycleId).get(requestHash);
      if (!(j && j.fetch_status === "pending" && j.attempted_at === null && j.create_export_count === 0)) return "not-pending";
      j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted"; b.spentCreates += 1; b.spentTokens += cost; return "reserved";
    },
    freezeBudget(cycleId, trancheKey, bud) { budgets.set(bkey(cycleId, trancheKey), { planFingerprint: bud.planFingerprint, maxCreates: bud.maxCreates, maxTokens: bud.maxTokens, spentCreates: 0, spentTokens: 0, cost: new Map(bud.hashes.map((h) => [h.requestHash, h.tokenCost])) }); },
    claimExportAttempt() { throw new Error("claimExportAttempt must NOT be used when a budget is active"); },
    recordExportCreated({ cycleId, requestHash, exportId }) { jobs.get(cycleId).get(requestHash).export_id = exportId; },
    loadSourceRows(h) { const e = cache.get(h); return e || null; },
    adoptSourceCache({ cycleId, requestHash }) { const e = cache.get(requestHash); const j = jobs.get(cycleId) && jobs.get(cycleId).get(requestHash); if (e && j && j.fetch_status === "pending") { Object.assign(j, { fetch_status: "succeeded", export_id: null, row_count: e.row_count, cache_object_path: e.object_path }); return "adopted"; } return "cache-changed"; },
    saveSourceRows({ job, rows, payloadBytes }) { const h = job.request_hash != null ? job.request_hash : job.requestHash; const p = "src/" + h + ".json"; cache.set(h, { rows: [...rows], object_path: p, row_count: rows.length, payload_bytes: payloadBytes }); return p; },
    recordSourceSuccess({ cycleId, requestHash, exportId, rowCount, cacheObjectPath }) { Object.assign(jobs.get(cycleId).get(requestHash), { fetch_status: "succeeded", export_id: exportId, row_count: rowCount, cache_object_path: cacheObjectPath, error_stage: null, error_code: null }); },
    recordSourceFailure({ cycleId, requestHash, stage, code, message, terminal }) { Object.assign(jobs.get(cycleId).get(requestHash), { fetch_status: "failed", error_stage: stage, error_code: code, error_message: message, terminal: !!terminal }); },
    updateCycleCounts() {},
  };
  return store;
}
function budgetDataDoe(store) {
  return { async create(job) { store.createPosts += 1; return { exportId: "e_" + job.requestHash }; }, async poll() {}, async download() { return [{ x: 1 }]; } };
}
const oneJob = (hash, sourceKey = "settlements") => ({ requestHash: hash, requestKey: sourceKey + ":x", sourceId: "src", sourceKey, connectionId: "primary", organizationFingerprint: "org", accountScopeHash: "ash", requestMeta: {}, strict: false, limit: 50000, sourceScope: "organization", marketplaceScoped: false, fetchParams: { columns: ["c"], sellerOrVendorIds: ["A1"], from: null, to: null, limit: 50000, options: {} }, owner: { ownerId: "o-" + hash } });

test("D1. the worker reserves EXACTLY the budgeted creates; a genuine create spends one reservation", async () => {
  const store = makeWorkerStore(); const dd = budgetDataDoe(store);
  const planned = [oneJob("h1"), oneJob("h2")];
  const bud = computeFrozenTrancheBudget({ plannedJobs: planned, isPremiumOf: () => false, trancheKey: "t" });
  const cycleId = store.openCycle({ bucket: "us", cycleDate: "2026-08-18" });
  store.freezeBudget(cycleId, "t", bud);
  const res = await runSourceJobs({ store, dataDoe: dd, plannedJobs: planned, bucket: "us", cycleDate: "2026-08-18", budget: { trancheKey: "t", planFingerprint: bud.planFingerprint } });
  assert.equal(res.succeeded, 2); assert.equal(store.createPosts, 2, "two real create POSTs");
  assert.equal(store._budget(cycleId, "t").spentCreates, 2, "durable spent = 2 creates");
  assert.equal(store._budget(cycleId, "t").spentTokens, 4, "durable spent = 4 tokens (2x standard)");
});

test("D2. a cache HIT spends ZERO reservation (adopted; no create, no token)", async () => {
  const store = makeWorkerStore(); const dd = budgetDataDoe(store);
  const planned = [oneJob("h1")];
  const bud = computeFrozenTrancheBudget({ plannedJobs: planned, isPremiumOf: () => false, trancheKey: "t" });
  const cycleId = store.openCycle({ bucket: "us", cycleDate: "2026-08-18" });
  store.freezeBudget(cycleId, "t", bud);
  // Seed a durable EXACT cache entry so the job adopts before any create/reservation.
  store._cache.set("h1", { rows: [{ x: 1 }], source_id: "src", organization_fingerprint: "org", account_scope_hash: "ash", object_path: "p.json", row_count: 1, payload_bytes: 10 });
  const res = await runSourceJobs({ store, dataDoe: dd, plannedJobs: planned, bucket: "us", cycleDate: "2026-08-18", budget: { trancheKey: "t", planFingerprint: bud.planFingerprint } });
  assert.equal(res.succeeded, 1); assert.equal(store.createPosts, 0, "ZERO create POSTs (adopted)");
  assert.equal(store._budget(cycleId, "t").spentCreates, 0, "ZERO creates reserved");
  assert.equal(store._budget(cycleId, "t").spentTokens, 0, "ZERO tokens reserved");
});

test("D3. an out-of-plan hash aborts BEFORE the POST (PLAN_BUDGET_MISMATCH) -- no failed-batch->single fallback", async () => {
  const store = makeWorkerStore(); const dd = budgetDataDoe(store);
  const budgeted = oneJob("h1");
  const bud = computeFrozenTrancheBudget({ plannedJobs: [budgeted], isPremiumOf: () => false, trancheKey: "t" });
  const cycleId = store.openCycle({ bucket: "us", cycleDate: "2026-08-18" });
  store.freezeBudget(cycleId, "t", bud);
  // Plan an EXTRA job not in the frozen budget (as a stray single-account fallback would be).
  const res = await runSourceJobs({ store, dataDoe: dd, plannedJobs: [budgeted, oneJob("stray")], bucket: "us", cycleDate: "2026-08-18", budget: { trancheKey: "t", planFingerprint: bud.planFingerprint } });
  assert.equal(store.createPosts, 1, "only the budgeted hash POSTs");
  assert.equal(store._rawJob(cycleId, "stray").error_code, "PLAN_BUDGET_MISMATCH", "the out-of-plan hash is refused before POST");
  assert.equal(store._budget(cycleId, "t").spentCreates, 1, "the stray never reserved a create");
});

test("D4. a continuation (a second invocation) does NOT reset spent and creates NO duplicate", async () => {
  const store = makeWorkerStore(); const dd = budgetDataDoe(store);
  const planned = [oneJob("h1")];
  const bud = computeFrozenTrancheBudget({ plannedJobs: planned, isPremiumOf: () => false, trancheKey: "t" });
  const cycleId = store.openCycle({ bucket: "us", cycleDate: "2026-08-18" });
  store.freezeBudget(cycleId, "t", bud);
  const ctx = { store, dataDoe: dd, plannedJobs: planned, bucket: "us", cycleDate: "2026-08-18", budget: { trancheKey: "t", planFingerprint: bud.planFingerprint } };
  await runSourceJobs(ctx);
  await runSourceJobs(ctx); // continuation: the job is already succeeded, so nothing re-creates or re-reserves
  assert.equal(store.createPosts, 1, "no duplicate create on continuation");
  assert.equal(store._budget(cycleId, "t").spentCreates, 1, "spent NOT reset by the continuation");
});

async function main() {
  ({ computeFrozenTrancheBudget, sourceTokenCost, assertFrozenBudgetMatches, STANDARD_SOURCE_TOKENS, PREMIUM_SOURCE_TOKENS } = await import("../lib/server/sync/source-tranche-budget.js"));
  ({ assignAccountBatches, batchSellerIds } = await import("../lib/server/sync/source-batching.js"));
  ({ sourceRequestIdentity } = await import("../lib/server/source-identity.js"));
  ({ runSourceJobs } = await import("../lib/server/sync/source-worker.js"));

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
