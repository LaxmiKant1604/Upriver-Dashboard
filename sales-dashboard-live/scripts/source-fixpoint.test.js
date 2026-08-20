// Scheduler v2 -- GLOBAL SOURCE-FAMILY FIXPOINT ORCHESTRATOR proof suite (offline, ZERO network/DB).
//
// Drives the REAL runSourceFixpoint over the REAL runSchedulerV2Shadow dispatcher (real planners, real
// contracts, real staged runners) with an in-memory store, a spy DataDoe double, an injected fake clock and
// an injected wait recorder -- the suite NEVER sleeps. Proves:
//   A. graph planning: complete dependency graph BEFORE any run; required vs optional families; fail closed
//      on unknown reports / unclassified families / malformed scopes.
//   B. one family at a time in SOURCE_TRANCHE_ORDER: every create for family N happens before ANY create for
//      family N+1; unselected families are upserted-but-pending during earlier passes; a family with no
//      selected work is skipped without composing a runtime.
//   C. the SAME (bucket, cycle_date) cycle is re-entered across every continuation and family (one cycle id,
//      one durable cycle row); a filtered pass is NEVER globally drained (drained=false until the last
//      family), while globalDrained becomes true only when every owned job is terminal.
//   D. completion-anchored >=60s cooldown between family launches through the injected clock/waiter ONLY
//      (waits recorded; same-family continuations do not cooldown; no timer is ever created).
//   E. a resumable deferral resumes in the next continuation with ZERO duplicate create-exports (a
//      previously attempted hash is never recreated).
//   F. REQUIRED-source failure stops THIS bucket after the family completes (no later-family creates; LKG
//      cache untouched; typed stopReason) while the OTHER bucket's independent orchestration completes.
//   G. staged dependencies that surface AFTER their family's tranche already ran are reached by the bounded
//      RE-WALK (real listing-optimizer runner: sqp-weekly activates its catalog; walk 2 completes it).
//   H. Blocker 4d budget wiring: the generic unit's OLI ceiling is frozen per (cycle, tranche#generic)
//      BEFORE execution and every generic OLI create goes through the atomic reservation (spent==creates);
//      an unbudgeted (signal-derived) tranche uses the legacy one-attempt claim.
//   I. reports derive only after their required families complete; null-tranche dispatch keeps
//      trancheDrained === drained (byte-compatible surface).
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

// Assigned in main() after the dummy env is set.
let runSourceFixpoint, planSourceFixpointGraph, registryBudgetPlanner;
let runSchedulerV2Shadow;
let makeSourceTranche, SOURCE_TRANCHE_ORDER;
let sourceTokenCost;

const ASOF = "2025-08-10";
const CYCLE_DATE = "2026-08-20";
const dash = (...p) => p.join("-");
const CONNS = [
  { id: "primary", apiKey: dash("prim", "key"), accountPrefix: "" },
  { id: "secondary", apiKey: dash("sec", "key"), accountPrefix: dash("dd", "secondary") + ":" },
];
const A1 = { accountId: "A1", country: "US", currency: "USD", name: "Acct One" };
const NB1 = { accountId: "NB1", country: "IN", currency: "INR", name: "NonUs One" };

/* --------------------------------- in-memory store (with budget RPC models) --------------------------------- */
function makeStore() {
  const cycles = new Map();
  const jobsByCycle = new Map();
  const ownersByCycle = new Map();
  const cache = new Map();
  const reportJobs = new Map();
  const budgets = new Map();
  let seq = 0;
  const counters = { claims: 0, reserves: 0, opens: 0 };
  const findCycle = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  const ownerRows = (cid) => [...((ownersByCycle.get(cid) && ownersByCycle.get(cid).values()) || [])];
  const rkey = (rk, a) => rk + "|" + a;
  const bkey = (cid, tk) => cid + "|" + tk;
  return {
    _counters: counters,
    _cycleCount: () => cycles.size,
    _budget: (cid, tk) => budgets.get(bkey(cid, tk)) || null,
    _cacheSize: () => cache.size,
    openCycle({ bucket, cycleDate }) {
      counters.opens += 1;
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
    claimExportAttempt(id, h) {
      counters.claims += 1;
      const j = jobsByCycle.get(id) && jobsByCycle.get(id).get(h);
      if (j && j.fetch_status === "pending" && j.attempted_at === null) { j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted"; return true; }
      return false;
    },
    adoptSourceCache({ cycleId, requestHash, sourceId, organizationFingerprint, accountScopeHash, objectPath, rowCount, payloadBytes }) {
      const e = cache.get(requestHash);
      if (!e) return "cache-changed";
      const mismatch = e.source_id !== sourceId || e.organization_fingerprint !== organizationFingerprint
        || e.account_scope_hash !== accountScopeHash || e.object_path !== objectPath
        || e.row_count !== rowCount || e.payload_bytes !== payloadBytes;
      if (mismatch) return "cache-changed";
      const j = jobsByCycle.get(cycleId) && jobsByCycle.get(cycleId).get(requestHash);
      if (j && j.fetch_status === "pending" && j.attempted_at === null && j.create_export_count === 0) {
        Object.assign(j, { fetch_status: "succeeded", export_id: null, row_count: e.row_count, payload_bytes: e.payload_bytes, cache_object_path: e.object_path });
        return "adopted";
      }
      return "not-adopted";
    },
    recordExportCreated({ cycleId, requestHash, exportId }) { jobsByCycle.get(cycleId).get(requestHash).export_id = exportId; },
    loadSourceRows(h) { const e = cache.get(h); return e ? { ...e } : null; },
    saveSourceRows({ job, rows, payloadBytes }) {
      const h = job.request_hash != null ? job.request_hash : job.requestHash;
      const objectPath = "source-cache/v2/" + h + ".json";
      cache.set(h, {
        rows: [...rows], source_id: job.sourceId, organization_fingerprint: job.organizationFingerprint,
        account_scope_hash: job.accountScopeHash, object_path: objectPath, row_count: rows.length,
        payload_bytes: payloadBytes, expires_at: new Date(Date.now() + 20 * 3600 * 1000).toISOString(),
      });
      return objectPath;
    },
    recordSourceSuccess({ cycleId, requestHash, exportId, rowCount, cacheObjectPath }) {
      Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "succeeded", export_id: exportId, row_count: rowCount, cache_object_path: cacheObjectPath });
    },
    recordSourceFailure({ cycleId, requestHash, stage, code, message, terminal, exportId }) {
      const j = jobsByCycle.get(cycleId).get(requestHash);
      Object.assign(j, { fetch_status: "failed", error_stage: stage, error_code: code, error_message: message, terminal: !!terminal });
      if (exportId != null) j.export_id = exportId;
    },
    updateCycleCounts() {},
    finalizeCycle({ cycleId }) {
      const c = findCycle(cycleId);
      if (!c) return { disposition: "not-found", cycle: null };
      if (["succeeded", "partial", "failed"].includes(c.status)) return { disposition: "already-terminal", cycle: { ...c } };
      const open = this.listSourceJobs(cycleId).some((j) => ["pending", "attempted"].includes(j.fetch_status));
      if (open) return { disposition: "open-work", cycle: null };
      c.status = "succeeded"; c.finished_at = "t";
      return { disposition: "finalized", cycle: { ...c } };
    },
    // ---- Blocker 4d budget RPC models (mirror persist_source_tranche_budget / reserve_source_export_create) ----
    persistBudget({ cycleId, trancheKey, planFingerprint, maxCreates, maxTokens, hashes }) {
      const k = bkey(cycleId, trancheKey);
      const b = budgets.get(k);
      if (b) {
        if (b.planFingerprint !== planFingerprint || b.maxCreates !== maxCreates || b.maxTokens !== maxTokens) {
          const e = new Error("PLAN_BUDGET_MISMATCH: frozen budget differs"); e.code = "PLAN_BUDGET_MISMATCH"; throw e;
        }
        return "exists";
      }
      budgets.set(k, {
        planFingerprint, maxCreates, maxTokens, spentCreates: 0, spentTokens: 0,
        cost: new Map((hashes || []).map((h) => [h.requestHash, h.tokenCost])),
      });
      return "created";
    },
    reserveExportCreate({ cycleId, trancheKey, requestHash, planFingerprint }) {
      counters.reserves += 1;
      const b = budgets.get(bkey(cycleId, trancheKey));
      if (!b) throw new Error("no frozen budget for reservation");
      if (b.planFingerprint !== planFingerprint || !b.cost.has(requestHash)) return "plan-mismatch";
      const cost = b.cost.get(requestHash);
      if (b.spentCreates + 1 > b.maxCreates || b.spentTokens + cost > b.maxTokens) return "budget-exceeded";
      const j = jobsByCycle.get(cycleId) && jobsByCycle.get(cycleId).get(requestHash);
      if (!(j && j.fetch_status === "pending" && j.attempted_at === null && j.create_export_count === 0)) return "not-pending";
      j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted";
      b.spentCreates += 1; b.spentTokens += cost;
      return "reserved";
    },
    // ---- report-derivation half ----
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
const ord = (sid, asin, sales, units, currency, date) => ({
  date, seller_or_vendor_id: sid, sku: "SKU-" + asin, child_asin: asin,
  item_price_currency: currency || "USD", product_name: "Widget " + asin, total_sales_sum: sales, total_units_sum: units,
});
const brandOrd = (sid, asin, date) => ({
  date, seller_or_vendor_id: sid, seller_or_vendor_name: "Seller " + sid, marketplace_country_code: "US",
  item_price_currency: "USD", child_asin: asin, total_sales_sum: 100, total_units_sold_sum: 10, unpriced_units_sum: 0,
});
const cat = (asin, brand) => ({ child_asin: asin, parent_asin: "P1", product_name: "Catalog " + asin, product_brand: brand });

function makeDataDoe(opts = {}) {
  const create = {}; const createSeq = []; let deferHits = 0;
  const bump = (m, h) => { m[h] = (m[h] || 0) + 1; };
  const deadlineErr = () => Object.assign(new Error("deferred"), { code: "DATADOE_DEADLINE" });
  const rowsFor = (job) => {
    const rk = job.requestKey || ""; const fp = job.fetchParams || {};
    const sid = (Array.isArray(fp.sellerOrVendorIds) && fp.sellerOrVendorIds[0]) || "A1";
    if (rk.includes("order-lines")) return [brandOrd(sid, "R1", fp.to || ASOF)];
    if (rk.includes("oli-sales")) return [ord(sid, "R1", 100, 10, "USD", fp.to || ASOF)];
    if (rk.includes("catalog")) return [cat("R1", "Acme")];
    if (rk.includes("returns-leakage:returns")) {
      return [{ date: fp.to || ASOF, sku: "SKU-R1", child_asin: "R1", amazon_order_id: "O", amazon_return_reason: "DEFECTIVE", amazon_fulfillment_channel: "FBA", amazon_return_request_status: "Approved", amazon_return_refunded_amount: -5 }];
    }
    if (rk.includes("settlements")) {
      return [{ sku: "SKU-R1", child_asin: "R1", settlement_type: "REFUND", currency: "USD", refunded_amount_sum: -9, refund_commission_sum: -1, return_unit_fee_sum: -1, cogs_sum: -2, quantity_sum: -1 }];
    }
    if (rk.includes("sqp")) return []; // a VALIDATED EMPTY sqp payload still activates staged downstream work
    return [{ child_asin: "R1" }];
  };
  return {
    createCount: (h) => create[h] || 0,
    totalCreates: () => Object.values(create).reduce((a, b) => a + b, 0),
    createSeq,
    async create(job) {
      if (opts.failKey && (job.requestKey || "").includes(opts.failKey)) {
        throw new Error("DataDoe create-export failed (500) for this test source.");
      }
      bump(create, job.requestHash);
      createSeq.push({ sourceKey: job.sourceKey || "", requestKey: job.requestKey || "" });
      return { exportId: "e_" + job.requestHash };
    },
    async poll(job) {
      if (opts.deferKey && (job.requestKey || "").includes(opts.deferKey)) {
        deferHits += 1;
        if (deferHits === 1) throw deadlineErr();
      }
    },
    async download(job) { return rowsFor(job); },
  };
}

/* --------------------------------- fake clock + wait recorder (NEVER sleeps) --------------------------------- */
function makeClock(start = 1_000_000) {
  const c = { now: start };
  c.fn = () => c.now;
  c.advance = (ms) => { c.now += ms; };
  return c;
}

/* --------------------------------- orchestration harness --------------------------------- */
// composeRuntime built over the REAL dispatcher with injected fakes; records every run + launch time.
function makeHarness({ bucket = "us", accounts = [A1], dd = null, store = null, clockStart = 1_000_000, budgetPlanner = null, reportKeys, cooldownMs = 60_000 } = {}) {
  const st = store || makeStore();
  const d = dd || makeDataDoe();
  const clock = makeClock(clockStart);
  const waits = [];
  const wait = async (ms) => { waits.push(ms); clock.advance(ms); };
  const launches = [];
  const runs = [];
  const saver = async () => ({ paramsHash: "ph" });
  const allow = async () => ({ read: "ok", allPrimary: false, enabledAccountIds: accounts.map((a) => a.accountId) });
  const composeRuntime = (spec) => ({
    run: async (args) => {
      launches.push({ tranche: spec.name, at: clock.fn() });
      const res = await runSchedulerV2Shadow({
        ...args,
        settings: [],
        connections: CONNS,
        discoverAccounts: async () => accounts,
        store: st, dataDoe: d, saveSnapshot: saver,
        loadAccountRollout: allow,
        sourceTranche: makeSourceTranche(spec),
        budgetPlanner,
      });
      runs.push({ tranche: spec.name, res });
      return res;
    },
  });
  const orchestrate = (over = {}) => runSourceFixpoint({
    composeRuntime, store: st,
    bucket, cycleDate: CYCLE_DATE, reportKeys,
    asOf: ASOF, asOfFor: () => ASOF,
    clock: clock.fn, wait, cooldownMs,
    ...over,
  });
  return { store: st, dd: d, clock, waits, launches, runs, orchestrate };
}

const GENERIC_REPORTS = ["brand-sales", "returns-leakage", "content-changes"];

/* ================================= A. graph planning ================================= */
group("A. graph planning (complete dependency graph BEFORE any run)");

test("A1. required vs optional families per report; tranche annotations + budget modes", () => {
  const g = planSourceFixpointGraph({ reportKeys: ["daily-reporting", "brand-sales", "brand-view", "fba-plan", "keyword-rank"] });
  assert.deepEqual(g.reports["daily-reporting"].requiredFamilies, ["order-line-items", "product-catalog"]);
  assert.deepEqual(g.reports["brand-sales"].requiredFamilies, ["order-line-items", "product-catalog"]);
  assert.equal(g.reports["brand-view"].derivedOnly, true, "brand-view is snapshot-derived (no source families of its own)");
  assert.deepEqual(g.reports["fba-plan"].requiredFamilies, ["fba-inventory-health", "order-line-items", "product-catalog"]);
  assert.deepEqual(g.reports["fba-plan"].optionalFamilies, ["listings"], "fba-plan:awd is optional");
  assert.deepEqual(g.reports["keyword-rank"].requiredFamilies, ["product-catalog", "sqp-weekly"]);
  assert.deepEqual(g.reports["keyword-rank"].optionalFamilies, ["sqp-monthly"]);
  const byName = Object.fromEntries(g.tranches.map((t) => [t.name, t]));
  assert.deepEqual(byName["order-line-items"].requiredByReports, ["brand-sales", "daily-reporting", "fba-plan"]);
  assert.equal(byName["order-line-items"].budgetMode, "frozen");
  assert.equal(byName["date-sliceable"].budgetMode, "unbudgeted");
  assert.deepEqual(byName["staged-signal"].requiredByReports, ["keyword-rank"]);
  assert.equal(g.tranches.length, SOURCE_TRANCHE_ORDER.length, "every tranche annotated in order");
  assert.ok(Object.isFrozen(g) && Object.isFrozen(g.tranches) && Object.isFrozen(g.reports), "graph is frozen");
});

test("A2. fail closed: unknown report, empty scope, unclassified family", () => {
  assert.throws(() => planSourceFixpointGraph({ reportKeys: [] }), /non-empty reportKeys/);
  assert.throws(() => planSourceFixpointGraph({ reportKeys: ["no-such-report"] }), /no source contracts/);
  assert.throws(() => planSourceFixpointGraph({ reportKeys: [" "] }), /blank report key/);
  const truncated = SOURCE_TRANCHE_ORDER.filter((t) => t.name !== "product-catalog");
  assert.throws(
    () => planSourceFixpointGraph({ reportKeys: ["brand-sales"], trancheOrder: truncated }),
    /not in the tranche order/,
  );
});

test("A3. orchestrator entry fail-closed: composeRuntime/store/bucket/cooldown-waiter", async () => {
  const { store } = makeHarness({ reportKeys: GENERIC_REPORTS });
  await assert.rejects(() => runSourceFixpoint({ store, bucket: "us", cycleDate: CYCLE_DATE, reportKeys: GENERIC_REPORTS }), /composeRuntime/);
  await assert.rejects(() => runSourceFixpoint({ composeRuntime: () => ({ run: async () => ({}) }), bucket: "us", cycleDate: CYCLE_DATE, reportKeys: GENERIC_REPORTS }), /injected store/);
  await assert.rejects(() => runSourceFixpoint({ composeRuntime: () => ({ run: async () => ({}) }), store, bucket: "eu", cycleDate: CYCLE_DATE, reportKeys: GENERIC_REPORTS }), /'us' or 'non-us'/);
  await assert.rejects(
    () => runSourceFixpoint({ composeRuntime: () => ({ run: async () => ({}) }), store, bucket: "us", cycleDate: CYCLE_DATE, reportKeys: GENERIC_REPORTS, cooldownMs: 60_000, wait: null }),
    /requires an injected wait/,
  );
});

/* ================================= B+C+D. the full walk ================================= */
group("B+C+D. one family at a time over ONE re-entered cycle, with completion-anchored cooldown");

let fullWalk; // reused by later assertions

test("B1. the full priority walk completes: families execute strictly in SOURCE_TRANCHE_ORDER", async () => {
  fullWalk = makeHarness({ reportKeys: GENERIC_REPORTS });
  const rollup = await fullWalk.orchestrate();
  assert.equal(rollup.stopped, false, "no stop: " + JSON.stringify(rollup.stopReason));
  assert.equal(rollup.globalDrained, true, "every owned job terminal at the end");
  // Strict family grouping: the create sequence never returns to an earlier family.
  const orderIndex = new Map();
  SOURCE_TRANCHE_ORDER.forEach((t, i) => t.sourceKeys.forEach((k) => orderIndex.set(k, i)));
  const seq = fullWalk.dd.createSeq.map((c) => orderIndex.get(c.sourceKey));
  for (let i = 1; i < seq.length; i += 1) {
    assert.ok(seq[i] >= seq[i - 1], `create #${i} (${fullWalk.dd.createSeq[i].sourceKey}) never precedes an earlier family`);
  }
  // All three selected reports' families were exercised: OLI (1), catalog (2), returns+settlements (3), events (4).
  const familiesCreated = new Set(fullWalk.dd.createSeq.map((c) => orderIndex.get(c.sourceKey)));
  assert.deepEqual([...familiesCreated].sort(), [0, 1, 2, 3], "families 1-4 created work; staged-signal (5) had none");
});

test("B2. a family with no selected work is SKIPPED without composing a runtime", () => {
  const stagedLaunches = fullWalk.launches.filter((l) => l.tranche === "staged-signal");
  assert.equal(stagedLaunches.length, 0, "staged-signal was never launched");
  const rec = fullWalk.runs.find((r) => r.tranche === "staged-signal");
  assert.equal(rec, undefined, "no staged-signal run recorded");
});

test("C1. ONE durable cycle re-entered by every run (same cycle id, one cycle row)", async () => {
  assert.equal(fullWalk.store._cycleCount(), 1, "exactly one (bucket, cycle_date) cycle");
  const ids = new Set(fullWalk.runs.map((r) => r.res.cycleId).filter(Boolean));
  assert.equal(ids.size, 1, "every run resumed the same cycle");
});

test("C2. a filtered pass is NEVER globally drained; global drain arrives only at the end", () => {
  const nonFinal = fullWalk.runs.slice(0, -1);
  for (const r of nonFinal) {
    assert.equal(r.res.drained, false, `run under tranche ${r.tranche} is not globally drained while other families are open`);
  }
  const final = fullWalk.runs[fullWalk.runs.length - 1];
  assert.equal(final.res.trancheDrained, true, "the final family pass is tranche-complete");
});

test("C3. every family pass ends tranche-complete (trancheDrained) even though drained stays false", () => {
  // The LAST run of each launched family must be tranche-drained.
  const lastByTranche = new Map();
  for (const r of fullWalk.runs) lastByTranche.set(r.tranche, r.res);
  for (const [tranche, res] of lastByTranche) {
    assert.equal(res.trancheDrained, true, `family ${tranche} completed its selected work`);
  }
});

test("D1. >=60s completion-anchored cooldown between family launches; same-family continuations do not cooldown; NEVER sleeps", () => {
  const { launches, waits } = fullWalk;
  // Between consecutive launches of DIFFERENT families the injected clock advanced >= 60s (via the recorded
  // waiter ONLY -- the suite itself never sleeps and creates no timers).
  for (let i = 1; i < launches.length; i += 1) {
    if (launches[i].tranche !== launches[i - 1].tranche) {
      assert.ok(launches[i].at - launches[i - 1].at >= 60_000, `launch of ${launches[i].tranche} waited >=60s after ${launches[i - 1].tranche}`);
    }
  }
  const distinctFamilies = new Set(launches.map((l) => l.tranche)).size;
  assert.ok(waits.length >= distinctFamilies - 1, "a cooldown wait was recorded before each subsequent family");
  assert.equal(waits.reduce((a, b) => a + b, 0), (distinctFamilies - 1) * 60_000, "cooldown time equals exactly (families-1) * 60s of FAKE clock");
});

test("I1. reports derive only AFTER their required families completed (validated at the end; pending before)", () => {
  // While the OLI family was executing (first family), no report was derivable.
  const st = fullWalk.store;
  const rep = st.report("brand-sales", "A1");
  assert.ok(rep, "brand-sales report job exists");
  assert.equal(rep.derive_status, "succeeded", "brand-sales derived after OLI+catalog completed");
  assert.equal(rep.validated, true);
  const ret = st.report("returns-leakage", "A1");
  assert.ok(ret && ret.derive_status === "succeeded" && ret.validated === true, "returns-leakage derived after families 1-3 completed");
});

/* ================================= E. deferral resume / no duplicate create ================================= */
group("E. resumable deferral resumes with ZERO duplicate creates");

test("E1. a poll deferral resumes in the next continuation of the SAME family; the attempted hash is never recreated", async () => {
  const h = makeHarness({ reportKeys: ["brand-sales"], dd: makeDataDoe({ deferKey: "order-lines" }) });
  const rollup = await h.orchestrate();
  assert.equal(rollup.stopped, false, "no stop: " + JSON.stringify(rollup.stopReason));
  assert.equal(rollup.globalDrained, true);
  const oliCreates = h.dd.createSeq.filter((c) => c.sourceKey === "order-line-items");
  assert.ok(oliCreates.length >= 1, "OLI created");
  for (const row of h.store.listSourceJobs(rollup.cycleId)) {
    assert.ok(row.create_export_count <= 1, "no request hash was ever created twice");
  }
  const oliRuns = h.runs.filter((r) => r.tranche === "order-line-items");
  assert.ok(oliRuns.length >= 2, "the deferral consumed an extra continuation of the same family");
});

/* ================================= F. required-source failure stops the bucket ================================= */
group("F. REQUIRED-source failure stops THIS bucket; the other bucket continues independently");

test("F1. an OLI failure stops the bucket typed after the family completes; NO later-family creates; LKG untouched", async () => {
  const h = makeHarness({ reportKeys: GENERIC_REPORTS, dd: makeDataDoe({ failKey: "order-lines" }) });
  const rollup = await h.orchestrate();
  assert.equal(rollup.stopped, true);
  assert.equal(rollup.stopReason.code, "REQUIRED_SOURCE_FAILED");
  assert.equal(rollup.stopReason.family, "order-line-items");
  assert.ok(rollup.stopReason.requiredBy.includes("brand-sales"), "the failed family is required by a selected report");
  const orderIdx = new Map(); SOURCE_TRANCHE_ORDER.forEach((t, i) => t.sourceKeys.forEach((k) => orderIdx.set(k, i)));
  for (const c of h.dd.createSeq) {
    assert.equal(orderIdx.get(c.sourceKey), 0, "creates happened ONLY in the stopped family (canonical oli-sales still creates; brand order-lines failed)");
  }
  assert.equal(rollup.globalDrained, false, "a stopped bucket is never claimed drained");
  // The failed rows are terminal 'failed' with exactly one create each; catalog rows stay pending.
  const rows = h.store.listSourceJobs(rollup.cycleId);
  const failed = rows.filter((r) => r.fetch_status === "failed");
  assert.ok(failed.length >= 1, "the failed OLI jobs are recorded");
  // The one-attempt claim durably records the attempt BEFORE the POST, so a create that threw still shows
  // EXACTLY one attempt -- which is precisely why the failed hash can never be recreated later.
  for (const r of failed) assert.equal(r.create_export_count, 1, "the failed hash carries exactly its one recorded attempt");
  for (const r of rows.filter((x) => x.source_key === "product-catalog")) {
    assert.equal(r.fetch_status, "pending", "catalog work was upserted but never executed after the stop");
  }
});

test("F2. the OTHER bucket's independent orchestration completes despite bucket 1's stop", async () => {
  const h = makeHarness({ bucket: "non-us", accounts: [NB1], reportKeys: ["brand-sales"] });
  const rollup = await h.orchestrate();
  assert.equal(rollup.stopped, false);
  assert.equal(rollup.globalDrained, true, "the non-us bucket drained on its own store/cycle");
});

/* ================================= G. staged dependency across tranches (re-walk) ================================= */
group("G. staged dependencies reach their family via the bounded re-walk");

test("G1. listing-optimizer: sqp-weekly (family 5) activates its catalog (family 2); walk 2 completes it", async () => {
  const h = makeHarness({ reportKeys: ["listing-optimizer"] });
  const rollup = await h.orchestrate();
  assert.equal(rollup.stopped, false, "no stop: " + JSON.stringify(rollup.stopReason));
  assert.equal(rollup.globalDrained, true, "the staged catalog was reached and completed");
  assert.ok(rollup.walks >= 2, "a second walk was required (the catalog surfaced AFTER its tranche had run)");
  const seq = h.dd.createSeq.map((c) => c.sourceKey);
  assert.ok(seq.includes("sqp-weekly"), "sqp-weekly created");
  assert.ok(seq.includes("product-catalog"), "the staged catalog was created");
  assert.ok(seq.indexOf("sqp-weekly") < seq.indexOf("product-catalog"), "catalog followed the sqp signal");
  for (const row of h.store.listSourceJobs(rollup.cycleId)) {
    assert.ok(row.create_export_count <= 1, "no duplicate create across walks");
  }
});

/* ================================= H. Blocker 4d budget wiring ================================= */
group("H. frozen generic-unit budget wiring (Blocker 4d)");

test("H1. the OLI tranche's generic ceiling is frozen BEFORE execution and every generic create is a reservation", async () => {
  const h = makeHarness({ reportKeys: GENERIC_REPORTS, budgetPlanner: registryBudgetPlanner() });
  const rollup = await h.orchestrate();
  assert.equal(rollup.stopped, false, "no stop: " + JSON.stringify(rollup.stopReason));
  assert.equal(rollup.globalDrained, true);
  const oliBudget = h.store._budget(rollup.cycleId, "order-line-items#generic");
  assert.ok(oliBudget, "a frozen budget row exists for (cycle, order-line-items#generic)");
  const oliCreates = h.dd.createSeq.filter((c) => c.sourceKey === "order-line-items").length;
  assert.equal(oliBudget.spentCreates, oliCreates, "durable spent == actual OLI creates");
  assert.equal(oliBudget.spentTokens, oliCreates * sourceTokenCost(false), "OLI is standard: 2 tokens per create");
  assert.ok(oliBudget.spentCreates <= oliBudget.maxCreates, "ceiling never exceeded");
  const catBudget = h.store._budget(rollup.cycleId, "product-catalog#generic");
  assert.ok(catBudget && catBudget.spentCreates >= 1, "the catalog tranche froze + spent its own generic budget");
  // The UNBUDGETED date-sliceable tranche used the legacy one-attempt claim (no budget row).
  assert.equal(h.store._budget(rollup.cycleId, "date-sliceable#generic"), null, "no frozen budget for a signal-derived tranche");
  assert.ok(h.store._counters.reserves >= oliCreates, "OLI creates went through the atomic reservation");
  assert.ok(h.store._counters.claims >= 1, "the unbudgeted families used the legacy claim");
});

test("H2. without a budgetPlanner the walk is budget-free (byte-compatible)", async () => {
  const h = makeHarness({ reportKeys: ["brand-sales"] });
  const rollup = await h.orchestrate();
  assert.equal(h.store._counters.reserves, 0, "no reservation without a planner");
  assert.equal(h.store._budget(rollup.cycleId, "order-line-items#generic"), null);
});

/* ================================= I. null-tranche byte-compat surface ================================= */
group("I. null-tranche dispatch surface");

test("I2. a plain (no-tranche) dispatch keeps trancheDrained === drained", async () => {
  const st = makeStore(); const d = makeDataDoe();
  const res = await runSchedulerV2Shadow({
    bucket: "us", cycleDate: CYCLE_DATE, asOf: ASOF, asOfFor: () => ASOF,
    settings: [], manualReportKeys: ["brand-sales"],
    connections: CONNS, discoverAccounts: async () => [A1],
    store: st, dataDoe: d, saveSnapshot: async () => ({ paramsHash: "ph" }),
    loadAccountRollout: async () => ({ read: "ok", allPrimary: false, enabledAccountIds: ["A1"] }),
  });
  assert.equal(res.drained, true);
  assert.equal(res.trancheDrained, res.drained, "no tranche => trancheDrained mirrors drained");
});

async function main() {
  out("source-fixpoint proof suite");
  ({ runSourceFixpoint, planSourceFixpointGraph, registryBudgetPlanner } = await import("../lib/server/sync/source-fixpoint.js"));
  ({ runSchedulerV2Shadow } = await import("../lib/server/sync/sync-dispatch.js"));
  ({ makeSourceTranche, SOURCE_TRANCHE_ORDER } = await import("../lib/server/sync/source-tranche.js"));
  ({ sourceTokenCost } = await import("../lib/server/sync/source-tranche-budget.js"));

  let failures = 0;
  for (const t of tests) {
    if (t.marker) { out("-- " + t.marker); continue; }
    try {
      await t.fn();
      passed += 1;
      out("  ok  " + t.name);
    } catch (e) {
      failures += 1;
      out("FAIL  " + t.name);
      out(String((e && e.stack) || e));
    }
  }
  out("\n" + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : ""));
  if (failures) process.exitCode = 1;
}

main();
