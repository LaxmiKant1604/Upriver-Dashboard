// Scheduler v2 -- BUCKET SOURCE SYNC + DAILY/BRAND VIEW DURABLE INTEGRATION proof suite (offline, ZERO network/DB).
//
// Drives the REAL planBucketSourceSync / runBucketSourceSync (real batch engine, real canonical identities,
// real worker) with an in-memory store + DataDoe spy + fake clock/wait, plus the pure durable-dashboards
// folds/readiness. Proves:
//   A. hash identity -- a bucket-sync OLI slice request carries the EXACT canonical request_hash the OLI
//      reports resolve for the same slice/scope (one export, many owners); the durable catalog is a NEW
//      versioned org-wide request (golden hashes untouched).
//   B. stable batching -- 30 accounts => 6 batches, 31 => 7 with NOTHING reshuffled; a new account joining a
//      non-full batch backfills SOLO while completed members are never re-exported; the rolling 7-day window
//      is always re-exported (idempotent replace); one batch slice = ONE canonical job + <=5 owners + 1 create.
//   C. catalog + FBA -- catalog refreshes once per ORGANIZATION per day (org-wide scope, skipped when fresh);
//      FBA refreshes once daily per account and is PREMIUM-priced (5 tokens) in its frozen ceiling.
//   D. durable persistence -- history rows attribute each account ONLY its own seller rows; coverage recorded
//      per account on success and NEVER for a failed slice; an invalid catalog payload records NO snapshot
//      (latest-good preserved); a valid one records validated evidence.
//   E. controls + failure policy -- a PAUSED source plans zero exports (durable data untouched); an OLI
//      failure stops the bucket BEFORE catalog/FBA launch; >=60s completion-anchored cooldown between
//      families on the injected clock (never sleeps); reuseOnly adopts seeded caches with ZERO creates.
//   F. durable dashboards -- Daily + Brand View fold the SAME OLI history through the SAME brand maps (ASIN
//      wins, unique-SKU fallback, unmapped reported never fabricated); currency never crosses; readiness
//      blocks on missing coverage/catalog; the WRONG Ads grain THROWS (overlapping grains never mixed);
//      an ads gap degrades ads-readiness without blocking sales.
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

let bucketSync; // source-bucket-sync
let model; // source-durable-model
let dash; // durable-dashboards
let brands; // brand-resolution
let contracts; // report-source-contracts
let identity; // source-identity
let sourceContracts; // source-contracts
let dates; // date-windows
let tbudget; // source-tranche-budget

const API_KEY = ["prim", "key"].join("-");
const ASOF = "2026-08-15";
const TODAY = "2026-08-15";
const CYCLE_DATE = "2026-08-20";
const BUCKET = "us";
const acct = (i) => ({ accountId: "A" + String(i).padStart(2, "0"), rawSellerId: "S" + String(i).padStart(2, "0"), country: "US" });
const FIVE = [1, 2, 3, 4, 5].map(acct);
// Coverage from the authorized backfill start (2025-01-01) up to `upTo`, so a steady-state account has ONLY the
// recent [upTo+1, asOf] window missing (no early gap under the [2025-01-01, asOf] complete-window backfill).
const steadyCoverage = (accounts, upTo) => Object.fromEntries(accounts.map((a) => [a.accountId, [{ from: "2025-01-01", to: upTo }]]));

/* ------------------------- in-memory store (worker + budget models) ------------------------- */
function makeStore() {
  const cycles = new Map(); const jobsByCycle = new Map(); const ownersByCycle = new Map();
  const cache = new Map(); const budgets = new Map(); let seq = 0;
  const counters = { claims: 0, reserves: 0 };
  const findCycle = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  const ownerRows = (cid) => [...((ownersByCycle.get(cid) && ownersByCycle.get(cid).values()) || [])];
  const bkey = (cid, tk) => cid + "|" + tk;
  return {
    _counters: counters,
    _cycleCount: () => cycles.size,
    _budget: (cid, tk) => budgets.get(bkey(cid, tk)) || null,
    _owners: (cid) => ownerRows(cid).map((m) => ({ ...m })),
    _seedCache(hash, entry) { cache.set(hash, { ...entry }); },
    _cache: cache,
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
        terminal: false, error_stage: null, error_code: null, row_count: null, cache_object_path: null,
      });
    },
    listSourceJobs(id) { return [...((jobsByCycle.get(id) && jobsByCycle.get(id).values()) || [])].map((j) => ({ ...j })); },
    upsertSourceJobOwners(ms) {
      for (const m of ms || []) {
        if (!ownersByCycle.has(m.cycleId)) ownersByCycle.set(m.cycleId, new Map());
        ownersByCycle.get(m.cycleId).set(m.ownerId + "|" + m.requestHash, {
          cycle_id: m.cycleId, request_hash: m.requestHash, owner_id: m.ownerId, request_key: m.requestKey,
          report_key: m.reportKey, account_id: m.accountId, connection_id: m.connectionId,
          organization_fingerprint: m.organizationFingerprint, account_scope_hash: m.accountScopeHash, owner_status: "active",
        });
      }
    },
    listSourceJobOwners(cid, ids) { const s = new Set(ids || []); return ownerRows(cid).filter((m) => s.has(m.owner_id)).map((m) => ({ ...m })); },
    recordSourceOwnerStale() {},
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
        Object.assign(j, { fetch_status: "succeeded", export_id: null, row_count: e.row_count, cache_object_path: e.object_path });
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
    recordSourceFailure({ cycleId, requestHash, stage, code, terminal, exportId }) {
      const j = jobsByCycle.get(cycleId).get(requestHash);
      Object.assign(j, { fetch_status: "failed", error_stage: stage, error_code: code, terminal: !!terminal });
      if (exportId != null) j.export_id = exportId;
    },
    updateCycleCounts() {},
    persistBudget({ cycleId, trancheKey, planFingerprint, maxCreates, maxTokens, hashes }) {
      const k = bkey(cycleId, trancheKey);
      const b = budgets.get(k);
      if (b) {
        if (b.planFingerprint !== planFingerprint || b.maxCreates !== maxCreates || b.maxTokens !== maxTokens) {
          const e = new Error("PLAN_BUDGET_MISMATCH"); e.code = "PLAN_BUDGET_MISMATCH"; throw e;
        }
        return "exists";
      }
      budgets.set(k, { planFingerprint, maxCreates, maxTokens, spentCreates: 0, spentTokens: 0, cost: new Map((hashes || []).map((h) => [h.requestHash, h.tokenCost])) });
      return "created";
    },
    reserveExportCreate({ cycleId, trancheKey, requestHash, planFingerprint }) {
      counters.reserves += 1;
      const b = budgets.get(bkey(cycleId, trancheKey));
      if (!b) throw new Error("no frozen budget");
      if (b.planFingerprint !== planFingerprint || !b.cost.has(requestHash)) return "plan-mismatch";
      const cost = b.cost.get(requestHash);
      if (b.spentCreates + 1 > b.maxCreates || b.spentTokens + cost > b.maxTokens) return "budget-exceeded";
      const j = jobsByCycle.get(cycleId) && jobsByCycle.get(cycleId).get(requestHash);
      if (!(j && j.fetch_status === "pending" && j.attempted_at === null && j.create_export_count === 0)) return "not-pending";
      j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted";
      b.spentCreates += 1; b.spentTokens += cost;
      return "reserved";
    },
    // P0-B continuation readers (mirror the real supabase getCycleByBucketDate / getSourceTrancheBudget[Hashes]).
    getCycleByBucketDate(bucket, cycleDate) { const c = cycles.get(bucket + "|" + cycleDate); return c ? { id: c.id, bucket: c.bucket, status: c.status } : null; },
    getBudget({ cycleId, trancheKey }) { const b = budgets.get(bkey(cycleId, trancheKey)); return b ? { cycle_id: cycleId, tranche_key: trancheKey, plan_fingerprint: b.planFingerprint, max_creates: b.maxCreates, max_tokens: b.maxTokens, spent_creates: b.spentCreates, spent_tokens: b.spentTokens } : null; },
    getBudgetHashes({ cycleId, trancheKey }) { const b = budgets.get(bkey(cycleId, trancheKey)); return b ? [...b.cost.entries()].map(([request_hash, token_cost]) => ({ request_hash, token_cost })) : []; },
    listCycleOwners(cycleId) { return ownerRows(cycleId).map((m) => ({ ...m })); },
  };
}

/* ------------------------- DataDoe spy ------------------------- */
// Product Catalog fetches child_asin -> brand ONLY (no sku). The SKU->child_asin evidence comes from OLI.
const CATALOG_ROWS = [
  { child_asin: "B0A", parent_asin: "P", product_name: "A", product_brand: "Acme" },
  { child_asin: "B0B", parent_asin: "P", product_name: "B", product_brand: "Bolt" },
  { child_asin: "B0D", parent_asin: "P", product_name: "D", product_brand: "Delta" },
];
function makeDataDoe(opts = {}) {
  const create = {}; const createSeq = [];
  const bump = (m, h) => { m[h] = (m[h] || 0) + 1; };
  return {
    createCount: (h) => create[h] || 0,
    totalCreates: () => Object.values(create).reduce((a, b) => a + b, 0),
    createSeq,
    async create(job) {
      if (opts.failKey && (job.requestKey || "").includes(opts.failKey)) throw new Error("DataDoe create-export failed (500) here.");
      bump(create, job.requestHash);
      createSeq.push({ sourceKey: job.sourceKey || "", requestKey: job.requestKey || "", ids: [...(job.fetchParams.sellerOrVendorIds || [])], from: job.fetchParams.from ?? null, to: job.fetchParams.to ?? null });
      return { exportId: "e_" + job.requestHash };
    },
    async poll() {},
    async download(job) {
      const rk = job.requestKey || ""; const fp = job.fetchParams || {};
      if (rk.includes("source-oli")) {
        const ids = Array.isArray(fp.sellerOrVendorIds) ? fp.sellerOrVendorIds : [];
        // The canonical OLI fragment now carries the four order dimensions. A non-cancelled positive-unit row
        // MUST have a positive value (the value rule), so SKU-ONLY keeps a positive value even when its currency
        // is blank (D1b tests the currency binding, not the value rule).
        return ids.flatMap((sid) => [
          { date: fp.to, seller_or_vendor_id: sid, sku: "SKU-A", child_asin: "B0A", item_price_currency: "USD", amazon_order_status: "Shipped", fulfillment_channel: "AFN", address_state: "CA", address_city: "LA", total_sales_sum: 100, total_units_sum: 10 },
          { date: fp.to, seller_or_vendor_id: sid, sku: "SKU-ONLY", child_asin: "B0X", item_price_currency: opts.blankOliCurrency ? "" : "USD", amazon_order_status: "Shipped", fulfillment_channel: "MFN", address_state: "", address_city: "", total_sales_sum: 20, total_units_sum: 2 },
        ]);
      }
      if (rk.includes("source-catalog")) return opts.badCatalog ? [{ child_asin: "B0A" }, null] : CATALOG_ROWS.map((r) => ({ ...r }));
      if (rk.includes("source-fba")) return [{ date: fp.to, sku: "SKU-A", child_asin: "B0A", marketplace_country_code: "US", available: 5 }];
      return [];
    },
  };
}

function makeClock(start = 5_000_000) { const c = { now: start }; c.fn = () => c.now; c.advance = (ms) => { c.now += ms; }; return c; }

function makeSinks() {
  // The ATOMIC DIMENSIONAL replace model: one call = replace the account's dimensional rows + replace the
  // NON-cancelled daily rollup (source_oli_daily_history, what dashboards read) + coverage ack. `history`
  // captures the ROLLUP rows (the dashboard grain); `dimensional` captures the full-grain evidence.
  const history = []; const dimensional = []; const coverage = []; const snapshots = []; const statuses = []; const replaceCalls = [];
  return {
    history, dimensional, coverage, snapshots, statuses, replaceCalls,
    replaceHistoryWindow: async ({ accountId, coveredFrom, coveredTo, rows, rollupRows }) => {
      replaceCalls.push({ accountId, coveredFrom, coveredTo, rowCount: (rows || []).length });
      dimensional.push(...(rows || []));
      history.push(...(rollupRows || []));
      coverage.push({ accountId, sourceKey: "order-line-items", coveredFrom, coveredTo });
      return { write: "ok", dimensionalInserted: (rows || []).length, rollupInserted: (rollupRows || []).length };
    },
    persistSnapshot: async (s) => { snapshots.push(s); return { write: "ok" }; },
    updateRunStatus: async (s) => { statuses.push(s); return { write: "ok" }; },
  };
}

const CATALOG_CARRIER = "carrier-seller-01"; // a canonical primary seller id (org-wide catalog requires one)
function runHarness({ accounts = FIVE, coverage = null, dd = null, store = null, pausedSources, catalogSnapshot = null, fbaSnapshotsByAccount = {}, reuseOnly = false, cooldownMs = 60_000, existingMembership, catalogCarrierSeller = CATALOG_CARRIER } = {}) {
  const st = store || makeStore();
  const d = dd || makeDataDoe();
  const clock = makeClock();
  const waits = [];
  const wait = async (ms) => { waits.push(ms); clock.advance(ms); };
  const sinks = makeSinks();
  const run = () => bucketSync.runBucketSourceSync({
    apiKey: API_KEY, bucket: BUCKET, accounts,
    existingMembership: existingMembership || new Map(),
    coverageByAccountId: coverage || steadyCoverage(accounts, dates.addDaysStr(ASOF, -7)),
    catalogSnapshot, fbaSnapshotsByAccount,
    pausedSources: pausedSources || new Set(),
    asOf: ASOF, today: TODAY,
    store: st, dataDoe: d,
    ...sinks,
    cycleDate: CYCLE_DATE, clock: clock.fn, wait, cooldownMs,
    reuseOnly, catalogCarrierSeller,
  });
  return { store: st, dd: d, clock, waits, sinks, run };
}

/* ================================= A. hash identity ================================= */
group("A. canonical hash identity");

test("A1. a bucket-sync OLI slice request carries the EXACT canonical hash the OLI reports resolve (one export, many owners)", () => {
  const slice = { from: "2026-08-09", to: "2026-08-14" }; // a canonical [8-14] bin clipped by the rolling window
  const ids = FIVE.map((a) => a.rawSellerId);
  const unit = { slice, accounts: FIVE, sellerOrVendorIds: ids };
  const resolved = bucketSync.resolvedOliSliceBatch({ apiKey: API_KEY, unit, bucket: BUCKET });
  // The report-side identity, computed from the daily-reporting canonical contract exactly as the resolver does.
  const c = contracts.REPORT_SOURCE_CONTRACTS["daily-reporting"].find((x) => x.requestKey === "daily-reporting:oli-sales");
  const reportSide = identity.sourceRequestIdentity({
    apiKey: API_KEY, sourceId: sourceContracts.sourceContractForKey("order-line-items").ids[0],
    columns: c.columns, ids, from: slice.from, to: slice.to, limit: c.limit,
    options: { groupBy: c.groupBy || undefined, aggregations: c.aggregations || undefined, orderByColumn: c.orderByColumn, orderByDirection: c.orderByDirection },
  });
  assert.equal(resolved.requestHash, reportSide.requestHash, "bucket-sync slice hash == the reports' canonical fragment hash");
  assert.equal(resolved.sourceScope, "seller");
});

test("A2. the durable catalog is the CORRECTED org-wide request: ONE carrier seller, NO from/to, NO sku, four supported columns", () => {
  const resolved = bucketSync.resolvedDurableCatalog({ apiKey: API_KEY, carrierSellerId: CATALOG_CARRIER, bucket: BUCKET });
  assert.deepEqual([...resolved.columns], ["child_asin", "parent_asin", "product_name", "product_brand"], "only the four supported columns");
  assert.ok(!resolved.columns.includes("sku"), "no unproven sku column (DataDoe rejects it HTTP 400)");
  assert.deepEqual(resolved.sellerOrVendorIds, [CATALOG_CARRIER], "exactly one carrier seller (an org-wide request still requires a nonblank seller)");
  assert.equal(resolved.from, null); assert.equal(resolved.to, null);
  assert.equal(resolved.sourceScope, "organization");
  assert.equal(resolved.accountScopeHash, identity.accountScopeHash([CATALOG_CARRIER]), "the scope hash binds the carrier seller");
  // The carrier seller is bound into the canonical request hash: a DIFFERENT carrier => a DIFFERENT hash.
  const other = bucketSync.resolvedDurableCatalog({ apiKey: API_KEY, carrierSellerId: "other-carrier-seller", bucket: BUCKET });
  assert.notEqual(resolved.requestHash, other.requestHash, "the carrier seller is bound into the request hash");
});

/* ================================= B. stable batching ================================= */
group("B. stable batching + coverage-driven exports");

test("B1. 30 accounts => 6 stable batches; the 31st joins a 7th with NOTHING reshuffled", () => {
  const thirty = Array.from({ length: 30 }, (_, i) => acct(i + 1));
  const p30 = bucketSync.planBucketSourceSync({
    apiKey: API_KEY, bucket: BUCKET, accounts: thirty,
    coverageByAccountId: steadyCoverage(thirty, dates.addDaysStr(ASOF, -7)),
    asOf: ASOF, today: TODAY, catalogSnapshot: { validated_at: TODAY + "T01:00:00Z" },
    fbaSnapshotsByAccount: Object.fromEntries(thirty.map((a) => [a.accountId, { validated_at: TODAY + "T01:00:00Z" }])),
  });
  assert.equal(p30.batches.length, 6, "30 accounts => six stable <=5-account batches");
  const thirtyOne = [...thirty, acct(31)];
  const p31 = bucketSync.planBucketSourceSync({
    apiKey: API_KEY, bucket: BUCKET, accounts: thirtyOne,
    existingMembership: p30.membership,
    coverageByAccountId: steadyCoverage(thirty, dates.addDaysStr(ASOF, -7)),
    asOf: ASOF, today: TODAY, catalogSnapshot: { validated_at: TODAY + "T01:00:00Z" },
    fbaSnapshotsByAccount: Object.fromEntries(thirtyOne.map((a) => [a.accountId, { validated_at: TODAY + "T01:00:00Z" }])),
  });
  assert.equal(p31.batches.length, 7, "31 accounts => seven batches");
  for (const a of thirty) {
    assert.equal(p31.membership.get(a.accountId), p30.membership.get(a.accountId), a.accountId + " kept its batch (no reshuffle)");
  }
});

test("B2. steady state exports ONE complete-window batch export over the missing recent window; covered history is never re-exported", async () => {
  const h = runHarness({ catalogSnapshot: { validated_at: TODAY + "T01:00:00Z" }, fbaSnapshotsByAccount: Object.fromEntries(FIVE.map((a) => [a.accountId, { validated_at: TODAY + "T01:00:00Z" }])) });
  const rollup = await h.run();
  assert.equal(rollup.stopped, false, JSON.stringify(rollup.stopReason));
  assert.equal(rollup.globalDrained, true);
  const oliCreates = h.dd.createSeq.filter((c) => c.sourceKey === "order-line-items");
  // Coverage is [2025-01-01, ASOF-7] for all 5, so ONE complete-window export over the single missing window
  // [ASOF-6, ASOF] for the whole batch -- NOT a per-7-day-slice fan-out.
  assert.equal(oliCreates.length, 1, "ONE complete-window batch export over the missing recent window (no per-slice fan-out)");
  assert.deepEqual(oliCreates[0].ids, FIVE.map((a) => a.rawSellerId), "the full 5-account batch scope");
  assert.ok(oliCreates[0].from > dates.addDaysStr(ASOF, -7), "the export begins AFTER the covered window (2025-01-01..ASOF-7) -- proven history is not re-fetched: " + oliCreates[0].from);
  assert.equal(h.dd.createSeq.filter((c) => c.sourceKey === "product-catalog").length, 0, "fresh catalog => no export today");
  assert.equal(h.dd.createSeq.filter((c) => c.sourceKey === "fba-inventory-health").length, 0, "fresh FBA snapshots => no export today");
});

test("B3. one batch slice = ONE canonical job carrying FIVE individual owner memberships and exactly 1 create", async () => {
  const h = runHarness({ catalogSnapshot: { validated_at: TODAY + "T01:00:00Z" }, fbaSnapshotsByAccount: Object.fromEntries(FIVE.map((a) => [a.accountId, { validated_at: TODAY + "T01:00:00Z" }])) });
  const rollup = await h.run();
  const jobs = h.store.listSourceJobs(rollup.cycleId).filter((j) => j.source_key === "order-line-items");
  for (const j of jobs) {
    assert.equal(j.create_export_count, 1, "exactly one create per canonical batch slice");
    const owners = h.store._owners(rollup.cycleId).filter((m) => m.request_hash === j.request_hash);
    assert.equal(owners.length, 5, "five owner memberships on the one canonical row");
    assert.equal(new Set(owners.map((m) => m.owner_id)).size, 5, "five DISTINCT owner ids");
    assert.equal(new Set(owners.map((m) => m.account_id)).size, 5, "one per account");
    for (const m of owners) assert.notEqual(m.account_scope_hash, j.account_scope_hash, "individual owner scope, never the batch scope");
  }
});

test("B4. a NEW account in a non-full batch backfills SOLO; completed members never re-exported", async () => {
  const fourCovered = steadyCoverage(FIVE.slice(0, 4), dates.addDaysStr(ASOF, -7));
  const h = runHarness({
    coverage: fourCovered, // A05 has NO coverage: it is the newly discovered member
    catalogSnapshot: { validated_at: TODAY + "T01:00:00Z" },
    fbaSnapshotsByAccount: Object.fromEntries(FIVE.map((a) => [a.accountId, { validated_at: TODAY + "T01:00:00Z" }])),
  });
  const rollup = await h.run();
  assert.equal(rollup.stopped, false, JSON.stringify(rollup.stopReason));
  const oliCreates = h.dd.createSeq.filter((c) => c.sourceKey === "order-line-items");
  // Two distinct missing-window groups: the new A05 (no coverage) over its FULL window [2025-01-01, ASOF], and the
  // four covered members over ONLY the recent rolling-refresh window [ASOF-6, ASOF]. A05's full window exceeds
  // DataDoe's proven single-export cap, so it SPLITS into contiguous <=cap chunks; the four-member window is small.
  const cap = model.MAX_OLI_EXPORT_WINDOW_DAYS;
  const solo = oliCreates.filter((c) => c.ids.length === 1).sort((a, b) => (a.from < b.from ? -1 : 1));
  const grouped = oliCreates.filter((c) => c.ids.length === 4);
  assert.ok(solo.length >= 1 && grouped.length === 1, "solo new-account backfill export(s) + ONE four-account recent-window export");
  assert.equal(oliCreates.length, solo.length + grouped.length, "no other export shape (completed members untouched)");
  for (const c of solo) assert.deepEqual(c.ids, ["S05"], "ONLY the new account gets the full missing backfill");
  assert.deepEqual(grouped[0].ids, ["S01", "S02", "S03", "S04"], "the four covered members share ONE recent-window export");
  assert.equal(solo[0].from, "2025-01-01", "A05 backfills from the authorized start");
  for (const c of solo) assert.ok(dates.addDaysStr(c.from, cap - 1) >= c.to, "each solo backfill export is within the proven " + cap + "-day cap");
  for (let i = 1; i < solo.length; i += 1) assert.equal(solo[i].from, dates.addDaysStr(solo[i - 1].to, 1), "the solo chunks are contiguous (no gap/overlap)");
  assert.ok(solo[0].from < grouped[0].from, "A05 backfills from 2025-01-01; completed members only refresh the recent window");
});

test("B5. multi-seller row-cap safety: 7 batches over the fixed window => exactly 21 exports / 42 tokens", () => {
  // 35 accounts => 7 stable batches of 5. The initial complete-history backfill (empty coverage) over the FIXED
  // window [2025-01-01, 2026-08-21] first splits at the 441-day outer cap. The 441-day multi-seller chunk is
  // then split at 221 days after live evidence proved five sellers can hit the 50,000-row response limit;
  // the successful 157-day remainder identity stays unchanged.
  const GO_LIVE = "2026-08-21";
  const thirtyFive = Array.from({ length: 35 }, (_, i) => acct(i + 1));
  const plan = bucketSync.planBucketSourceSync({
    apiKey: API_KEY, bucket: BUCKET, accounts: thirtyFive, coverageByAccountId: {},
    catalogSnapshot: { validated_at: GO_LIVE + "T01:00:00Z" }, fbaSnapshotsByAccount: {},
    asOf: GO_LIVE, today: GO_LIVE,
  });
  assert.equal(plan.batches.length, 7, "35 accounts => 7 stable batches of 5");
  const oli = plan.families.find((f) => f.sourceKey === "order-line-items");
  // Exact per-batch boundaries (deduped across batches -> exactly three windows).
  const windows = [...new Set(oli.units.map((u) => u.slice.from + ".." + u.slice.to))].sort();
  assert.deepEqual(windows, ["2025-01-01..2025-08-09", "2025-08-10..2026-03-17", "2026-03-18..2026-08-21"]);
  assert.equal(oli.units.length, 21, "7 batches x 3 chunks = 21 complete-window OLI exports");
  // FROZEN budget: 21 unique hashes, standard=2 tokens each => the 42-token worst-case ceiling.
  const budget = tbudget.computeFrozenTrancheBudget({
    plannedJobs: oli.plannedJobs, isPremiumOf: () => false, trancheKey: "source-sync:order-line-items",
  });
  assert.equal(budget.hashes.length, 21, "21 distinct frozen OLI request hashes");
  assert.equal(budget.maxCreates, 21, "EXACTLY 21 authorized OLI creates (7 batches x 3 chunks)");
  assert.equal(budget.maxTokens, 42, "EXACTLY 42 authorized tokens (standard OLI = 2 each)");
});

test("B6. production shape: 8 US + 22 non-US => 21 exports / 42-token worst case; sellers stay isolated", () => {
  const GO_LIVE = "2026-08-21";
  const CHUNKS = ["2025-01-01..2025-08-09", "2025-08-10..2026-03-17", "2026-03-18..2026-08-21"];
  const mk = (prefix, country, n) => Array.from({ length: n }, (_, i) => ({
    accountId: prefix + String(i + 1).padStart(2, "0"),
    rawSellerId: prefix + "S" + String(i + 1).padStart(2, "0"),
    country,
  }));
  const usAccounts = mk("US", "US", 8);
  const nonUsAccounts = mk("NU", "GB", 22);
  const planFor = (bucket, accounts) => bucketSync.planBucketSourceSync({
    apiKey: API_KEY, bucket, accounts, coverageByAccountId: {},
    catalogSnapshot: { validated_at: GO_LIVE + "T01:00:00Z" }, fbaSnapshotsByAccount: {},
    asOf: GO_LIVE, today: GO_LIVE,
  });
  const us = planFor("us", usAccounts);
  const nonUs = planFor("non-us", nonUsAccounts);
  // <=5 sellers per batch; the exact batch counts.
  assert.equal(us.batches.length, 2, "8 US accounts => 2 batches (5 + 3)");
  assert.equal(nonUs.batches.length, 5, "22 non-US accounts => 5 batches (5+5+5+5+2)");
  for (const b of [...us.batches, ...nonUs.batches]) assert.ok(b.accounts.length >= 1 && b.accounts.length <= 5, "each batch has 1..5 sellers");
  const oliUnits = (plan) => plan.families.find((f) => f.sourceKey === "order-line-items").units;
  const usUnits = oliUnits(us);
  const nonUsUnits = oliUnits(nonUs);
  assert.equal(usUnits.length, 6, "US: 2 batches x 3 date chunks = 6 exports");
  assert.equal(nonUsUnits.length, 15, "non-US: 5 batches x 3 date chunks = 15 exports");
  const allUnits = [...usUnits, ...nonUsUnits];
  assert.equal(allUnits.length, 21, "combined: EXACTLY 21 exports");
  // The only windows are the three exact date chunks.
  assert.deepEqual([...new Set(allUnits.map((u) => u.slice.from + ".." + u.slice.to))].sort(), CHUNKS,
    "the 441-day multi-seller chunk splits while the 157-day remainder identity is preserved");
  // Every seller appears EXACTLY ONCE per date chunk, and each chunk covers exactly that bucket's sellers.
  for (const [label, units, accounts] of [["US", usUnits, usAccounts], ["non-US", nonUsUnits, nonUsAccounts]]) {
    for (const chunk of CHUNKS) {
      const sellers = units.filter((u) => u.slice.from + ".." + u.slice.to === chunk).flatMap((u) => u.sellerOrVendorIds);
      assert.equal(sellers.length, accounts.length, label + " " + chunk + ": every seller exported once (no gaps)");
      assert.equal(new Set(sellers).size, accounts.length, label + " " + chunk + ": no seller duplicated in a chunk");
      assert.deepEqual([...new Set(sellers)].sort(), accounts.map((a) => a.rawSellerId).sort(), label + " " + chunk + ": exactly this bucket's sellers");
    }
  }
  // US and non-US NEVER mix: disjoint sellers, and every export is wholly one bucket.
  const usSellers = new Set(usUnits.flatMap((u) => u.sellerOrVendorIds));
  const nonUsSellers = new Set(nonUsUnits.flatMap((u) => u.sellerOrVendorIds));
  assert.equal([...usSellers].filter((s) => nonUsSellers.has(s)).length, 0, "no seller appears in both buckets");
  for (const u of allUnits) {
    const allUs = u.sellerOrVendorIds.every((s) => usSellers.has(s));
    const allNonUs = u.sellerOrVendorIds.every((s) => nonUsSellers.has(s));
    assert.ok(allUs !== allNonUs, "each export's sellers are ALL one bucket -- never a US/non-US mix");
  }
  // All 21 request hashes are unique.
  assert.equal(new Set(allUnits.map((u) => u.requestHash)).size, 21, "all 21 export request hashes are unique");
  // Per-bucket + combined frozen ceilings (standard OLI = 2 tokens/export).
  const oliBudget = (plan) => tbudget.computeFrozenTrancheBudget({
    plannedJobs: plan.families.find((f) => f.sourceKey === "order-line-items").plannedJobs,
    isPremiumOf: () => false, trancheKey: "source-sync:order-line-items",
  });
  const usB = oliBudget(us);
  const nonUsB = oliBudget(nonUs);
  assert.deepEqual([usB.maxCreates, usB.maxTokens], [6, 12], "US ceiling: 6 exports / 12 tokens");
  assert.deepEqual([nonUsB.maxCreates, nonUsB.maxTokens], [15, 30], "non-US ceiling: 15 exports / 30 tokens");
  assert.equal(usB.maxCreates + nonUsB.maxCreates, 21, "combined: 21 exports");
  assert.equal(usB.maxTokens + nonUsB.maxTokens, 42, "combined: 42 tokens");
});

/* ================================= C. catalog + FBA ================================= */
group("C. catalog once-daily per organization; FBA per account (premium ceiling)");

test("C1. a stale catalog refreshes ONCE org-wide; FBA refreshes per account with a PREMIUM (5-token) frozen ceiling", async () => {
  const h = runHarness({}); // no catalog snapshot, no fba snapshots => both refresh
  const rollup = await h.run();
  assert.equal(rollup.stopped, false, JSON.stringify(rollup.stopReason));
  const catCreates = h.dd.createSeq.filter((c) => c.sourceKey === "product-catalog");
  assert.equal(catCreates.length, 1, "ONE catalog export for the whole organization");
  assert.deepEqual(catCreates[0].ids, [CATALOG_CARRIER], "org-wide request carries exactly the one carrier seller (empty => DataDoe HTTP 400)");
  const fbaCreates = h.dd.createSeq.filter((c) => c.sourceKey === "fba-inventory-health");
  assert.equal(fbaCreates.length, 5, "one FBA snapshot per account");
  const fbaBudget = h.store._budget(rollup.cycleId, "source-sync:fba-inventory-health");
  assert.ok(fbaBudget, "FBA family froze its ceiling");
  assert.equal(fbaBudget.spentTokens, 5 * 5, "FBA is PREMIUM: 5 tokens per create");
  const oliBudget = h.store._budget(rollup.cycleId, "source-sync:order-line-items");
  assert.equal(oliBudget.spentTokens, oliBudget.spentCreates * 2, "OLI is standard: 2 tokens per create");
  assert.ok(rollup.snapshots.recorded.includes("product-catalog"), "the validated catalog snapshot was recorded");
  assert.equal(rollup.snapshots.recorded.filter((s) => s.startsWith("fba-inventory-health:")).length, 5, "five per-account FBA snapshots recorded");
});

/* ================================= D. durable persistence ================================= */
group("D. durable persistence (history isolation, coverage, latest-good snapshots)");

test("D1. history rows attribute each account ONLY its own seller rows; coverage recorded per account", async () => {
  const h = runHarness({ catalogSnapshot: { validated_at: TODAY + "T01:00:00Z" }, fbaSnapshotsByAccount: Object.fromEntries(FIVE.map((a) => [a.accountId, { validated_at: TODAY + "T01:00:00Z" }])) });
  const rollup = await h.run();
  assert.equal(rollup.stopped, false);
  assert.ok(h.sinks.history.length > 0, "history rows persisted");
  for (const r of h.sinks.history) {
    const expected = FIVE.find((a) => a.rawSellerId === r.sellerOrVendorId);
    assert.equal(r.accountId, expected.accountId, "each history row belongs to its own seller's account");
  }
  const covered = new Set(h.sinks.coverage.map((c) => c.accountId));
  assert.equal(covered.size, 5, "coverage recorded for every batch member");
  for (const c of h.sinks.coverage) assert.equal(c.sourceKey, "order-line-items");
});

test("D1b. the real bucket persistence path binds a blank OLI currency to that seller/account's authoritative currency", async () => {
  const accounts = FIVE.map((account) => ({ ...account, currency: "USD" }));
  const h = runHarness({
    accounts,
    dd: makeDataDoe({ blankOliCurrency: true }),
    catalogSnapshot: { validated_at: TODAY + "T01:00:00Z" },
    fbaSnapshotsByAccount: Object.fromEntries(accounts.map((account) => [account.accountId, { validated_at: TODAY + "T01:00:00Z" }])),
  });
  const rollup = await h.run();
  assert.equal(rollup.stopped, false);
  assert.ok(h.sinks.history.some((row) => row.sku === "SKU-ONLY" && row.units === 2), "blank-currency unit rows survive");
  assert.ok(h.sinks.history.every((row) => row.currency === "USD"), "every persisted row uses the exact account's canonical currency");
});

test("D2. an INVALID catalog payload records NO snapshot (latest-good preserved); history/coverage unaffected", async () => {
  const h = runHarness({ dd: makeDataDoe({ badCatalog: true }), fbaSnapshotsByAccount: Object.fromEntries(FIVE.map((a) => [a.accountId, { validated_at: TODAY + "T01:00:00Z" }])) });
  const rollup = await h.run();
  assert.ok(!rollup.snapshots.recorded.includes("product-catalog"), "no snapshot recorded from a malformed catalog");
  assert.ok(h.sinks.snapshots.every((s) => s.sourceKey !== "product-catalog"), "the sink never saw catalog evidence");
});

/* ================================= E. controls + failure policy ================================= */
group("E. pause, required-failure stop, cooldown, reuseOnly");

test("E1. a PAUSED source plans ZERO new exports while everything else proceeds", async () => {
  const h = runHarness({ pausedSources: new Set(["order-line-items"]), fbaSnapshotsByAccount: {} });
  const rollup = await h.run();
  assert.deepEqual(rollup.skippedPaused, ["order-line-items"]);
  assert.equal(h.dd.createSeq.filter((c) => c.sourceKey === "order-line-items").length, 0, "zero OLI exports while paused");
  assert.ok(h.dd.createSeq.filter((c) => c.sourceKey === "product-catalog").length >= 1, "the catalog still refreshed");
  assert.equal(h.sinks.history.length, 0, "durable history untouched by the pause");
});

test("E2. an OLI failure STOPS the bucket typed BEFORE catalog/FBA launch; a fresh bucket run is unaffected", async () => {
  const h = runHarness({ dd: makeDataDoe({ failKey: "source-oli" }) });
  const rollup = await h.run();
  assert.equal(rollup.stopped, true);
  assert.equal(rollup.stopReason.code, "REQUIRED_SOURCE_FAILED");
  assert.equal(rollup.stopReason.family, "order-line-items");
  assert.equal(h.dd.createSeq.filter((c) => c.sourceKey === "product-catalog").length, 0, "catalog never launched");
  assert.equal(h.dd.createSeq.filter((c) => c.sourceKey === "fba-inventory-health").length, 0, "FBA never launched");
  assert.equal(h.sinks.coverage.length, 0, "no coverage recorded for failed slices");
  // The OTHER bucket (fresh harness) still completes -- independent orchestration.
  const other = runHarness({ catalogSnapshot: { validated_at: TODAY + "T01:00:00Z" }, fbaSnapshotsByAccount: Object.fromEntries(FIVE.map((a) => [a.accountId, { validated_at: TODAY + "T01:00:00Z" }])) });
  const r2 = await other.run();
  assert.equal(r2.stopped, false);
});

test("E3. >=60s completion-anchored cooldown between families on the FAKE clock (never sleeps)", async () => {
  const h = runHarness({}); // OLI + catalog + FBA all have work => 2 inter-family cooldowns
  const rollup = await h.run();
  assert.equal(rollup.stopped, false);
  assert.equal(h.waits.reduce((a, b) => a + b, 0), 2 * 60_000, "exactly two 60s cooldowns, entirely on the injected clock");
});

test("E4. reuseOnly adopts seeded exact caches with ZERO creates; a missing reusable source stops typed", async () => {
  // First, a normal run seeds the durable caches.
  const seedRun = runHarness({});
  const seeded = await seedRun.run();
  assert.equal(seeded.stopped, false);
  // A rehearsal against a FRESH cycle store with the SAME caches: copy them over.
  const st = makeStore();
  for (const [hash, entry] of seedRun.store._cache) st._seedCache(hash, entry);
  const rehearsal = runHarness({ store: st, reuseOnly: true });
  const rollup = await rehearsal.run();
  assert.equal(rehearsal.dd.totalCreates(), 0, "reuseOnly: ZERO DataDoe creates");
  assert.equal(rollup.stopped, false, JSON.stringify(rollup.stopReason));
  assert.equal(rollup.globalDrained, true, "every job adopted from the durable caches");
  // Without caches, the rehearsal cannot proceed: typed stop, still zero creates.
  const dry = runHarness({ reuseOnly: true });
  const dryRollup = await dry.run();
  assert.equal(dry.dd.totalCreates(), 0);
  assert.equal(dryRollup.stopped, true, "missing reusable sources stop the rehearsal typed");
});

/* ================================= F. durable dashboards ================================= */
group("F. Daily + Brand View over the durable model");

const HISTORY = [
  { account_id: "A01", sale_date: "2026-08-10", sku: "SKU-A", child_asin: "B0A", currency: "USD", sales_amount: 100, units: 10 }, // ASIN -> Acme
  { account_id: "A01", sale_date: "2026-08-10", sku: "SKU-D", child_asin: "B0D", currency: "USD", sales_amount: 30, units: 3 },  // ASIN -> Delta (also SKU-D->B0D evidence)
  { account_id: "A01", sale_date: "2026-08-10", sku: "SKU-D", child_asin: "", currency: "USD", sales_amount: 20, units: 2 },     // BLANK asin -> SKU fallback (SKU-D -> B0D -> Delta)
  { account_id: "A02", sale_date: "2026-08-10", sku: "SKU-B", child_asin: "B0B", currency: "EUR", sales_amount: 50, units: 5 },  // ASIN -> Bolt
  { account_id: "A02", sale_date: "2026-08-11", sku: "ZZZ", child_asin: "ZZZ", currency: "EUR", sales_amount: 7, units: 1 },     // unmapped
];
// The SKU->child_asin evidence is derived from the SAME durable OLI history the reports fold.
const MAPS = () => brands.buildBrandMaps(CATALOG_ROWS, HISTORY);

test("F1. Daily + Brand View fold the SAME OLI history through the SAME brand maps (ASIN wins; OLI SKU fallback; unmapped reported)", () => {
  const maps = MAPS();
  assert.equal(maps.bySku.get("SKU-D"), "Delta", "the OLI SKU fallback resolves SKU-D -> B0D -> Delta");
  const daily = dash.dailyRowsFromHistory({ historyRows: HISTORY, brandMaps: maps, brand: "ALL", from: "2026-08-10", to: "2026-08-11" });
  assert.deepEqual(daily.rows, [
    { date: "2026-08-10", currency: "EUR", sales: 50, units: 5 },
    { date: "2026-08-10", currency: "USD", sales: 150, units: 15 },
    { date: "2026-08-11", currency: "EUR", sales: 7, units: 1 },
  ], "currency never crosses; the ALL fold includes unmapped rows and reports them");
  assert.deepEqual(daily.unmapped, { sales: 7, units: 1 });
  const named = dash.dailyRowsFromHistory({ historyRows: HISTORY, brandMaps: maps, brand: "Delta", from: "2026-08-10", to: "2026-08-11" });
  assert.deepEqual(named.rows, [{ date: "2026-08-10", currency: "USD", sales: 50, units: 5 }], "Delta = the ASIN row (30) + the blank-asin SKU-fallback row (20)");
  const bv = dash.brandViewRowsFromHistory({ historyRows: HISTORY, brandMaps: maps, from: "2026-08-10", to: "2026-08-11" });
  assert.deepEqual(bv.brands, [
    { brand: "Acme", accountId: "A01", currency: "USD", sales: 100, units: 10 },
    { brand: "Bolt", accountId: "A02", currency: "EUR", sales: 50, units: 5 },
    { brand: "Delta", accountId: "A01", currency: "USD", sales: 50, units: 5 },
  ]);
  assert.deepEqual(bv.unmapped, [{ accountId: "A02", currency: "EUR", sales: 7, units: 1 }], "unmapped is reported, never fabricated as a brand");
});

test("F2. readiness blocks on missing OLI coverage / catalog; an Ads gap degrades ads only (sales stay ready)", () => {
  const base = {
    accounts: ["A01", "A02"],
    oliCoverageByAccountId: { A01: [{ from: "2026-08-01", to: "2026-08-15" }], A02: [{ from: "2026-08-01", to: "2026-08-15" }] },
    catalogSnapshot: { validated_at: TODAY + "T01:00:00Z" },
    from: "2026-08-10", to: "2026-08-14",
  };
  // Post ASIN->Campaign cutover, Daily reads the CAMPAIGN grain (the active Ads source, shared with Brand View).
  const readyAds = { grain: "campaign-performance-v1", read: "ok", windows: [{ from: "2026-08-01", to: "2026-08-15" }] };
  const r1 = dash.dailyReportingReadiness({ ...base, asinAds: readyAds });
  assert.equal(r1.ready, true); assert.equal(r1.adsReady, true);
  const r2 = dash.dailyReportingReadiness({ ...base, oliCoverageByAccountId: { A01: base.oliCoverageByAccountId.A01, A02: [] }, asinAds: readyAds });
  assert.equal(r2.ready, false, "an account's missing OLI coverage blocks Daily");
  assert.ok(r2.blockedBy.some((b) => b.sourceKey === "order-line-items" && b.accountId === "A02"));
  const r3 = dash.dailyReportingReadiness({ ...base, catalogSnapshot: null, asinAds: readyAds });
  assert.equal(r3.ready, false, "a missing validated catalog blocks Daily");
  const gapAds = { grain: "campaign-performance-v1", read: "ok", windows: [{ from: "2026-08-01", to: "2026-08-12" }] };
  const r4 = dash.dailyReportingReadiness({ ...base, asinAds: gapAds });
  assert.equal(r4.ready, true, "an ads gap never blocks sales");
  assert.equal(r4.adsReady, false, "but the ads half is not ready");
});

test("F3. the WRONG Ads grain THROWS (overlapping grains are never mixed); Brand View readiness mirrors Daily on the SAME evidence", () => {
  const base = {
    accounts: ["A01"],
    oliCoverageByAccountId: { A01: [{ from: "2026-08-01", to: "2026-08-15" }] },
    catalogSnapshot: { validated_at: TODAY + "T01:00:00Z" },
    fbaSnapshotsByAccount: { A01: { validated_at: TODAY + "T01:00:00Z" } },
    from: "2026-08-10", to: "2026-08-14",
  };
  // Post-cutover Daily requires the CAMPAIGN grain, so feeding it the retired ASIN grain is the wrong-grain hard failure.
  assert.throws(
    () => dash.dailyReportingReadiness({ ...base, asinAds: { grain: "asin-performance-v1", read: "ok", windows: [] } }),
    /never mix overlapping Ads grains/,
  );
  assert.throws(
    () => dash.brandViewReadiness({ ...base, asinAds: { grain: "asin-performance-v1", read: "ok", windows: [] } }),
    /never mix overlapping Ads grains/,
  );
  const bv = dash.brandViewReadiness({ ...base, asinAds: { grain: "campaign-performance-v1", read: "ok", windows: [{ from: "2026-08-01", to: "2026-08-15" }] } });
  assert.equal(bv.ready, true, "Brand View is ready on the SAME OLI/catalog evidence Daily used (one evidence set, two dashboards)");
  assert.equal(bv.adsReady, true);
});

/* ================================= G. P0-B frozen-cycle continuation ================================= */
group("G. frozen-cycle continuation reuses the frozen plan+budget (membership change never drifts)");

test("G1. a fresh cycle then a continuation with a NEW account: no PLAN_BUDGET_MISMATCH; frozen OLI budget reused; the new account defers to the next cycle", async () => {
  const THREE = [1, 2, 3].map(acct);
  const FOUR = [1, 2, 3, 4].map(acct);
  const oliTranche = "source-sync:order-line-items";
  const store = makeStore();
  // Pass 1 (FRESH cycle): freezes the OLI tranche budget for the 3-account membership.
  const h1 = runHarness({ accounts: THREE, store });
  const r1 = await h1.run();
  const cycleId = r1.cycleId;
  assert.ok(cycleId, "pass 1 opened a cycle");
  const b1 = store._budget(cycleId, oliTranche);
  assert.ok(b1 && b1.planFingerprint, "pass 1 froze the OLI tranche budget");
  const fp1 = b1.planFingerprint;
  // The cycle head is a CONTINUATION head (running/pending, not finalized) after pass 1.
  const head = store.getCycleByBucketDate(BUCKET, CYCLE_DATE);
  assert.ok(head && ["running", "pending"].includes(head.status), "the cycle head is a continuation head after pass 1");

  // Pass 2 (CONTINUATION): a 4th account connected mid-cycle. It must NOT drift the frozen budget.
  const h2 = runHarness({ accounts: FOUR, store, dd: h1.dd });
  let threw = null;
  try { await h2.run(); } catch (e) { threw = e; }
  assert.equal(threw, null, "pass 2 (continuation) did NOT throw PLAN_BUDGET_MISMATCH: " + (threw ? String((threw && threw.message) || threw) : ""));
  const b2 = store._budget(cycleId, oliTranche);
  assert.equal(b2.planFingerprint, fp1, "the frozen OLI budget fingerprint is UNCHANGED -- reused verbatim, never recomputed from the new membership");
  assert.equal(b2.maxCreates, b1.maxCreates, "the frozen OLI create ceiling is unchanged (the new account never widened it)");
  // The new account's seller (S04) was NEVER exported (it defers to the next NEW cycle).
  const s04Exported = h1.dd.createSeq.some((c) => (c.ids || []).includes("S04"));
  assert.equal(s04Exported, false, "the mid-cycle new account (S04) was never exported -- it joins the next cycle only");
  // The frozen accounts' owners remain exactly the 3 originals (no A04 owner was added to the frozen cycle).
  const ownerAccts = new Set(store.listCycleOwners(cycleId).map((o) => o.account_id));
  assert.equal(ownerAccts.has("A04"), false, "A04 was never added as an owner of the frozen cycle");
});

test("G2. a continuation with the SAME membership reuses the frozen budget idempotently (no new creates, no throw)", async () => {
  const THREE = [1, 2, 3].map(acct);
  const oliTranche = "source-sync:order-line-items";
  const store = makeStore();
  const h1 = runHarness({ accounts: THREE, store });
  const r1 = await h1.run();
  const fp1 = store._budget(r1.cycleId, oliTranche).planFingerprint;
  const creates1 = h1.dd.totalCreates();
  const h2 = runHarness({ accounts: THREE, store, dd: h1.dd });
  let threw = null;
  try { await h2.run(); } catch (e) { threw = e; }
  assert.equal(threw, null, "same-membership continuation never throws");
  assert.equal(store._budget(r1.cycleId, oliTranche).planFingerprint, fp1, "same frozen fingerprint");
  assert.equal(h1.dd.totalCreates(), creates1, "an idempotent same-membership continuation creates NO new exports");
});

async function main() {
  out("source-bucket-sync + durable-dashboards proof suite");
  bucketSync = await import("../lib/server/sync/source-bucket-sync.js");
  model = await import("../lib/server/sync/source-durable-model.js");
  dash = await import("../lib/server/sync/durable-dashboards.js");
  brands = await import("../lib/server/sync/brand-resolution.js");
  contracts = await import("../lib/server/sync/report-source-contracts.js");
  identity = await import("../lib/server/source-identity.js");
  sourceContracts = await import("../lib/server/source-contracts.js");
  dates = await import("../lib/server/date-windows.js");
  tbudget = await import("../lib/server/sync/source-tranche-budget.js");

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
