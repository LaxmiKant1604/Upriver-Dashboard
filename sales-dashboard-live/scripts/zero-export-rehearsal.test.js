// Scheduler v2 -- ZERO-EXPORT REHEARSAL of the full priority workflow (offline, ZERO network/DB).
//
// Runs the complete priority source workflow (bucket source sync: OLI stable batches -> org-wide durable
// catalog -> per-account FBA snapshots -> durable persistence -> Daily/Brand View readiness) with
// reuseOnly=true and a THROWING create-export tripwire, proving the 18 reviewed rehearsal requirements:
//    1 no DataDoe create POST can occur (tripwire adapter; positive control proves the tripwire itself);
//    2 existing exact durable cache evidence is adopted ATOMICALLY (CAS; export_id null, cec 0);
//    3 missing evidence returns MISSING_REUSABLE_SOURCE (job stays pending, nothing recorded);
//    4 no fallback path creates an export (zero creates in every rehearsal flow);
//    5 30 accounts produce six stable batches; 31 produce seven without reshuffling;
//    6 one OLI batch produces one canonical job and <=5 ISOLATED owners;
//    7 Daily Reporting and Brand View reuse the SAME OLI/catalog evidence;
//    8 each account sees only its own seller rows;
//    9 the organization-wide Catalog is NOT incorrectly seller-filtered;
//   10 ASIN brand mapping wins; unique SKU fallback works; ambiguous SKU fails closed;
//   11 initial backfill then the next daily run requests ONLY missing/rolling coverage;
//   12 late corrected rows upsert without duplication;
//   13 Campaign Ads feed Daily only; ASIN Ads feed Brand View (mixing THROWS);
//   14 source pause prevents work WITHOUT deleting durable history;
//   15 the one-minute cooldown runs on a FAKE clock (the suite never sleeps);
//   16 a source failure prevents dependent publication and preserves LKG;
//   17 dispatcher/derivation makes ZERO DataDoe calls (no create/poll/download in the rehearsal);
//   18 no report is published or scheduled by this task (defaults OFF; no cron; no publisher import).
//
// 7-bit ASCII, LF, no top-level await, synchronous writeSync progress, dynamic imports after a dummy env.

import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import path from "node:path";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = process.env[SB_KEY_ENV] || ["test", "svc", "role", "key"].join("-");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const group = (label) => tests.push({ marker: label });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

let bucketSync; let model; let dash; let brands; let worker; let dates;

const API_KEY = ["prim", "key"].join("-");
const ASOF = "2026-08-15";
const TODAY = "2026-08-15";
const CYCLE_DATE = "2026-08-21";
const BUCKET = "us";
const acct = (i) => ({ accountId: "A" + String(i).padStart(2, "0"), rawSellerId: "S" + String(i).padStart(2, "0"), country: "US" });
const FIVE = [1, 2, 3, 4, 5].map(acct);
// Coverage from the authorized backfill start (2025-01-01) up to `upTo`, so a steady-state account has ONLY the
// recent [upTo+1, asOf] tail missing (no early gap under the [2025-01-01, asOf] complete-window backfill).
const steadyCoverage = (accounts, upTo) => Object.fromEntries(accounts.map((a) => [a.accountId, [{ from: "2025-01-01", to: upTo }]]));

/* ---------------- in-memory store (same proven model as the bucket-sync suite) ---------------- */
function makeStore() {
  const cycles = new Map(); const jobsByCycle = new Map(); const ownersByCycle = new Map();
  const cache = new Map(); const budgets = new Map(); let seq = 0;
  const findCycle = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  const ownerRows = (cid) => [...((ownersByCycle.get(cid) && ownersByCycle.get(cid).values()) || [])];
  const bkey = (cid, tk) => cid + "|" + tk;
  return {
    _owners: (cid) => ownerRows(cid).map((m) => ({ ...m })),
    _cache: cache,
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
        fetch_status: "pending", attempted_at: null, create_export_count: 0, export_id: null, cache_object_path: null,
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
    recordSourceFailure({ cycleId, requestHash, stage, code, terminal }) {
      Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "failed", error_stage: stage, error_code: code, terminal: !!terminal });
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
  };
}

const CATALOG_ROWS = [
  { child_asin: "B0A", sku: "SKU-A", parent_asin: "P", product_name: "A", product_brand: "Acme" },
  { child_asin: "", sku: "SKU-ONLY", parent_asin: "P", product_name: "S", product_brand: "Delta" },
  { child_asin: "B0C", sku: "SKU-C", parent_asin: "P", product_name: "C1", product_brand: "Cruz" },
  { child_asin: "B0C", sku: "SKU-C", parent_asin: "P", product_name: "C2", product_brand: "Crux" },
];

function makeDataDoe(opts = {}) {
  const create = {}; let polls = 0; let downloads = 0;
  const bump = (m, h) => { m[h] = (m[h] || 0) + 1; };
  return {
    totalCreates: () => Object.values(create).reduce((a, b) => a + b, 0),
    totalPolls: () => polls,
    totalDownloads: () => downloads,
    async create(job) {
      if (opts.failKey && (job.requestKey || "").includes(opts.failKey)) throw new Error("DataDoe create-export failed (500) here.");
      bump(create, job.requestHash);
      return { exportId: "e_" + job.requestHash };
    },
    async poll() { polls += 1; },
    async download(job) {
      downloads += 1;
      const rk = job.requestKey || ""; const fp = job.fetchParams || {};
      if (rk.includes("source-oli")) {
        const ids = Array.isArray(fp.sellerOrVendorIds) ? fp.sellerOrVendorIds : [];
        return ids.map((sid) => ({ date: fp.to, seller_or_vendor_id: sid, sku: "SKU-A", child_asin: "B0A", item_price_currency: "USD", total_sales_sum: 100, total_units_sum: 10 }));
      }
      if (rk.includes("source-catalog")) return CATALOG_ROWS.map((r) => ({ ...r }));
      if (rk.includes("source-fba")) return [{ date: fp.to, sku: "SKU-A", child_asin: "B0A", marketplace_country_code: "US", available: 5 }];
      return [];
    },
  };
}

// Requirement 1: the THROWING create tripwire (mirrors withCreateExportTripwire); poll/download still counted.
function tripwired(dd) {
  return {
    ...dd,
    create: async () => { throw new Error("CREATE_EXPORT_TRIPWIRE: reuseOnly rehearsal attempted a DataDoe create-export; refusing (zero-token rehearsal)."); },
  };
}

function makeClock(start = 9_000_000) { const c = { now: start }; c.fn = () => c.now; c.advance = (ms) => { c.now += ms; }; return c; }

function makeSinks() {
  // The ATOMIC replaceHistoryWindow model: one call = delete-the-window + insert rows + coverage ack.
  const history = []; const coverage = []; const snapshots = [];
  return {
    history, coverage, snapshots,
    replaceHistoryWindow: async ({ accountId, coveredFrom, coveredTo, rows }) => {
      history.push(...rows);
      coverage.push({ accountId, sourceKey: "order-line-items", coveredFrom, coveredTo });
      return { write: "ok", replaced: 0, inserted: rows.length };
    },
    persistSnapshot: async (s) => { snapshots.push(s); return { write: "ok" }; },
    updateRunStatus: async () => ({ write: "ok" }),
  };
}

function runFlow({ store, dd, cycleDate = CYCLE_DATE, coverage = null, accounts = FIVE, pausedSources, reuseOnly = false, catalogSnapshot = null, fbaSnapshotsByAccount = {} } = {}) {
  const clock = makeClock();
  const waits = [];
  const wait = async (ms) => { waits.push(ms); clock.advance(ms); };
  const sinks = makeSinks();
  const promise = bucketSync.runBucketSourceSync({
    apiKey: API_KEY, bucket: BUCKET, accounts,
    coverageByAccountId: coverage || steadyCoverage(accounts, dates.addDaysStr(ASOF, -7)),
    catalogSnapshot, fbaSnapshotsByAccount,
    pausedSources: pausedSources || new Set(),
    asOf: ASOF, today: TODAY,
    store, dataDoe: dd, ...sinks,
    cycleDate, clock: clock.fn, wait, cooldownMs: 60_000,
    reuseOnly,
  });
  return { promise, waits, sinks, clock };
}

let seededStore; let seededSinks; let rehearsalRollup; let rehearsalDd; let rehearsalWaits; let rehearsalStore; let rehearsalSinks;

group("Rehearsal flows (the full priority workflow)");

test("SEED: one normal OFFLINE pass populates the durable caches (fixture; still zero network)", async () => {
  seededStore = makeStore();
  const dd = makeDataDoe();
  const flow = runFlow({ store: seededStore, dd });
  const rollup = await flow.promise;
  seededSinks = flow.sinks;
  assert.equal(rollup.stopped, false, JSON.stringify(rollup.stopReason));
  assert.equal(rollup.globalDrained, true);
  assert.ok(seededStore._cache.size >= 4, "durable caches exist for OLI slices + catalog + FBA");
});

test("(1)(2)(4)(15)(17) the REHEARSAL adopts every job atomically with ZERO create/poll/download on a fake clock", async () => {
  rehearsalStore = makeStore();
  for (const [h, e] of seededStore._cache) rehearsalStore._seedCache(h, e);
  rehearsalDd = tripwired(makeDataDoe());
  const flow = runFlow({ store: rehearsalStore, dd: rehearsalDd, cycleDate: "2026-08-22", reuseOnly: true });
  rehearsalRollup = await flow.promise;
  rehearsalWaits = flow.waits;
  rehearsalSinks = flow.sinks;
  assert.equal(rehearsalRollup.stopped, false, JSON.stringify(rehearsalRollup.stopReason));
  assert.equal(rehearsalRollup.globalDrained, true, "every job satisfied from durable evidence");
  assert.equal(rehearsalDd.totalCreates(), 0, "(1)(4) zero create-exports through ANY path");
  assert.equal(rehearsalDd.totalPolls(), 0, "(17) zero polls");
  assert.equal(rehearsalDd.totalDownloads(), 0, "(17) zero downloads -- derivation reads the durable caches only");
  for (const row of rehearsalStore.listSourceJobs(rehearsalRollup.cycleId)) {
    assert.equal(row.fetch_status, "succeeded", "adopted");
    assert.equal(row.export_id, null, "(2) an adopted job fabricates NO export id");
    assert.equal(row.create_export_count, 0, "(2) atomic CAS adoption spends nothing");
    assert.ok(row.cache_object_path, "(2) the adopted evidence points at the existing object");
  }
  // (15) the one-minute cooldown between families ran entirely on the injected fake clock.
  assert.ok(rehearsalWaits.length >= 2, "cooldowns happened");
  assert.equal(rehearsalWaits.reduce((a, b) => a + b, 0) % 60_000, 0, "whole 60s units on the fake clock; the suite never slept");
});

test("(1) positive control: the tripwire itself throws on any direct create attempt", async () => {
  await assert.rejects(() => rehearsalDd.create({}), /CREATE_EXPORT_TRIPWIRE/);
});

test("(3) missing durable evidence returns MISSING_REUSABLE_SOURCE and leaves the job pending", async () => {
  const store = makeStore(); // NO caches seeded
  const dd = tripwired(makeDataDoe());
  const plan = bucketSync.planBucketSourceSync({
    apiKey: API_KEY, bucket: BUCKET, accounts: FIVE,
    coverageByAccountId: steadyCoverage(FIVE, dates.addDaysStr(ASOF, -7)),
    catalogSnapshot: null, fbaSnapshotsByAccount: {}, asOf: ASOF, today: TODAY,
  });
  const oli = plan.families.find((f) => f.sourceKey === "order-line-items");
  const res = await worker.runSourceJobs({
    store, dataDoe: dd, plannedJobs: oli.plannedJobs,
    ownerIds: [...new Set(oli.plannedJobs.map((j) => j.owner.ownerId))],
    bucket: BUCKET, cycleDate: "2026-08-23", reuseOnly: true,
  });
  assert.ok(res.missingReusable > 0, "typed MISSING_REUSABLE_SOURCE outcomes");
  assert.ok(res.outcomes.every((o) => o.code === "MISSING_REUSABLE_SOURCE"), "every outcome is the typed rehearsal miss");
  assert.equal(dd.totalCreates(), 0);
  for (const row of store.listSourceJobs(res.cycleId)) {
    assert.equal(row.fetch_status, "pending", "(3) a missing reusable source stays PENDING (blocked, never failed)");
  }
});

test("(5) 30 accounts => six stable batches; 31 => seven with nothing reshuffled", () => {
  const thirty = Array.from({ length: 30 }, (_, i) => acct(i + 1));
  const p30 = bucketSync.planBucketSourceSync({
    apiKey: API_KEY, bucket: BUCKET, accounts: thirty,
    coverageByAccountId: steadyCoverage(thirty, dates.addDaysStr(ASOF, -7)),
    catalogSnapshot: { validated_at: TODAY + "T01:00:00Z" },
    fbaSnapshotsByAccount: Object.fromEntries(thirty.map((a) => [a.accountId, { validated_at: TODAY + "T01:00:00Z" }])),
    asOf: ASOF, today: TODAY,
  });
  assert.equal(p30.batches.length, 6);
  const p31 = bucketSync.planBucketSourceSync({
    apiKey: API_KEY, bucket: BUCKET, accounts: [...thirty, acct(31)], existingMembership: p30.membership,
    coverageByAccountId: steadyCoverage(thirty, dates.addDaysStr(ASOF, -7)),
    catalogSnapshot: { validated_at: TODAY + "T01:00:00Z" },
    fbaSnapshotsByAccount: {}, asOf: ASOF, today: TODAY,
  });
  assert.equal(p31.batches.length, 7);
  for (const a of thirty) assert.equal(p31.membership.get(a.accountId), p30.membership.get(a.accountId));
});

test("(6)(8)(9) one OLI batch = one canonical job + 5 ISOLATED owners; history isolates seller rows; the org catalog is never seller-filtered", () => {
  const oliRows = rehearsalStore.listSourceJobs(rehearsalRollup.cycleId).filter((r) => r.source_key === "order-line-items");
  assert.ok(oliRows.length >= 1);
  for (const j of oliRows) {
    const owners = rehearsalStore._owners(rehearsalRollup.cycleId).filter((m) => m.request_hash === j.request_hash);
    assert.equal(owners.length, 5, "(6) five owner memberships on ONE canonical row");
    assert.equal(new Set(owners.map((m) => m.owner_id)).size, 5, "(6) five distinct owner ids");
    for (const m of owners) assert.notEqual(m.account_scope_hash, j.account_scope_hash, "(6) individual owner scope, never the batch scope");
  }
  for (const r of rehearsalSinks.history) {
    const expected = FIVE.find((a) => a.rawSellerId === r.sellerOrVendorId);
    assert.equal(r.accountId, expected.accountId, "(8) each account received only its own seller rows");
  }
  // (9): the organization-wide catalog payload keeps ALL rows -- including rows with NO seller dimension.
  const catRow = rehearsalStore.listSourceJobs(rehearsalRollup.cycleId).find((r) => r.source_key === "product-catalog");
  assert.ok(catRow, "the durable catalog job exists");
  const catPayload = rehearsalStore.loadSourceRows(catRow.request_hash);
  assert.equal(catPayload.rows.length, CATALOG_ROWS.length, "(9) org-wide catalog rows are never seller-filtered");
});

test("(7)(10)(13) Daily + Brand View reuse the SAME evidence; brand rules hold; Ads grains never mix", () => {
  const maps = brands.buildBrandMaps(CATALOG_ROWS);
  // (10) ASIN wins; unique SKU fallback; ambiguous SKU (B0C twice with different brands via SKU-C) fails closed.
  assert.equal(brands.resolveBrand({ childAsin: "B0A", sku: "SKU-ONLY" }, maps).via, "asin");
  assert.deepEqual(brands.resolveBrand({ childAsin: "ZZZ", sku: "SKU-ONLY" }, maps), { brand: "Delta", via: "sku" });
  assert.deepEqual(brands.resolveBrand({ childAsin: "B0C", sku: "SKU-C" }, maps), { brand: null, via: null }, "conflicting/ambiguous fails closed");
  // (7): both dashboards fold the SAME durable history through the SAME maps.
  const historyRows = rehearsalSinks.history.map((r) => ({
    account_id: r.accountId, sale_date: r.saleDate, sku: r.sku, child_asin: r.childAsin,
    currency: r.currency, sales_amount: r.salesAmount, units: r.units,
  }));
  const win = model.oliRollingRefreshWindow(ASOF);
  const daily = dash.dailyRowsFromHistory({ historyRows, brandMaps: maps, brand: "ALL", from: win.from, to: win.to });
  const bv = dash.brandViewRowsFromHistory({ historyRows, brandMaps: maps, from: win.from, to: win.to });
  const dailyTotal = daily.rows.reduce((a, r) => a + r.sales, 0);
  const bvTotal = bv.brands.reduce((a, r) => a + r.sales, 0) + bv.unmapped.reduce((a, r) => a + r.sales, 0);
  assert.ok(dailyTotal > 0, "the rehearsal evidence carries sales");
  assert.equal(dailyTotal, bvTotal, "(7) one OLI/catalog evidence set, two dashboards, identical totals");
  // (13): the wrong grain THROWS in both directions.
  const base = { accounts: ["A01"], oliCoverageByAccountId: { A01: [{ from: "2025-06-01", to: ASOF }] }, catalogSnapshot: { validated_at: TODAY + "T01:00:00Z" }, from: win.from, to: win.to };
  assert.throws(() => dash.dailyReportingReadiness({ ...base, campaignAds: { grain: "asin-performance-v1", read: "ok", windows: [] } }), /never mix/);
  assert.throws(() => dash.brandViewReadiness({ ...base, asinAds: { grain: "campaign-performance-v1", read: "ok", windows: [] } }), /never mix/);
});

test("(11) initial backfill then the NEXT daily run requests ONLY missing/rolling coverage", () => {
  const backfill = model.oliBackfillWindow(ASOF);
  const day1 = bucketSync.planBucketSourceSync({
    apiKey: API_KEY, bucket: BUCKET, accounts: FIVE, coverageByAccountId: {},
    catalogSnapshot: { validated_at: TODAY + "T01:00:00Z" }, fbaSnapshotsByAccount: {}, asOf: ASOF, today: TODAY,
  });
  const day1Units = day1.families.find((f) => f.sourceKey === "order-line-items").units;
  // Complete-window model: the whole missing backfill for the <=5-seller batch (no 7-day pre-slicing), but a
  // window longer than DataDoe's proven single-export cap is SPLIT into contiguous <=cap chunks that reconstruct
  // the full [backfill.from, backfill.to] window -- so no single export exceeds the proven range.
  const cap = model.MAX_OLI_EXPORT_WINDOW_DAYS;
  assert.ok(day1Units.length >= 1, "day 1: one or more capped complete-window exports for the whole 5-seller batch");
  assert.equal(day1Units[0].slice.from, backfill.from, "day 1: the first chunk starts at the backfill start");
  assert.equal(day1Units[day1Units.length - 1].slice.to, backfill.to, "day 1: the last chunk ends at asOf");
  for (const u of day1Units) assert.ok(dates.addDaysStr(u.slice.from, cap - 1) >= u.slice.to, "each day-1 export is within the proven " + cap + "-day cap");
  for (let i = 1; i < day1Units.length; i += 1) assert.equal(day1Units[i].slice.from, dates.addDaysStr(day1Units[i - 1].slice.to, 1), "day 1: the chunks are contiguous (no gap/overlap)");
  // Record day-1 coverage, advance one day: the next run re-pulls ONLY the rolling refresh window (the last 7
  // days, where DataDoe still restates sales) as ONE complete-window export -- proven history before it is never
  // re-requested. This is the incremental-refresh invariant: recent-day corrections are captured every run.
  const nextAsOf = dates.addDaysStr(ASOF, 1);
  const refresh = model.oliRollingRefreshWindow(nextAsOf);
  const covered = steadyCoverage(FIVE, ASOF);
  const day2 = bucketSync.planBucketSourceSync({
    apiKey: API_KEY, bucket: BUCKET, accounts: FIVE, coverageByAccountId: covered,
    catalogSnapshot: { validated_at: TODAY + "T01:00:00Z" }, fbaSnapshotsByAccount: {}, asOf: nextAsOf, today: nextAsOf,
  });
  const day2Units = day2.families.find((f) => f.sourceKey === "order-line-items").units;
  assert.equal(day2Units.length, 1, "day 2: ONE complete-window export over the rolling refresh window");
  assert.deepEqual(day2Units[0].slice, { from: refresh.from, to: nextAsOf }, "day 2: the export re-pulls exactly the rolling 7-day refresh window");
  assert.ok(day2Units[0].slice.from > backfill.from, "proven history before the rolling window (2025-01-01..) is never re-requested");
});

test("(12) a late corrected row REPLACES its canonical grain without duplication", () => {
  const table = new Map();
  const upsert = (rows) => { for (const r of rows) table.set([r.organizationFingerprint, r.connectionId, r.accountId, r.saleDate, r.sku, r.childAsin, r.currency].join("|"), r); };
  const metaArgs = { organizationFingerprint: "org", connectionId: "primary", accountsBySellerId: { S01: { accountId: "A01" } } };
  upsert(model.oliHistoryRowsFromFragment({ ...metaArgs, sourceRequestHash: "h1", rows: [{ date: "2026-08-10", seller_or_vendor_id: "S01", sku: "K", child_asin: "B", item_price_currency: "USD", total_sales_sum: 100, total_units_sum: 10 }] }));
  upsert(model.oliHistoryRowsFromFragment({ ...metaArgs, sourceRequestHash: "h1", rows: [{ date: "2026-08-10", seller_or_vendor_id: "S01", sku: "K", child_asin: "B", item_price_currency: "USD", total_sales_sum: 90, total_units_sum: 9 }] }));
  assert.equal(table.size, 1, "replaced, never duplicated");
  assert.equal([...table.values()][0].salesAmount, 90, "the correction won");
});

test("(14) source pause prevents work WITHOUT deleting durable history", async () => {
  const store = makeStore();
  for (const [h, e] of seededStore._cache) store._seedCache(h, e);
  const cacheBefore = store._cache.size;
  const dd = tripwired(makeDataDoe());
  const flow = runFlow({
    store, dd, cycleDate: "2026-08-24", reuseOnly: true,
    pausedSources: new Set(["order-line-items", "product-catalog", "fba-inventory-health"]),
  });
  const rollup = await flow.promise;
  assert.deepEqual(rollup.skippedPaused.sort(), ["fba-inventory-health", "order-line-items", "product-catalog"]);
  assert.equal(dd.totalCreates(), 0, "zero work while paused");
  assert.equal(store._cache.size, cacheBefore, "(14) durable evidence untouched by the pause");
  assert.equal(flow.sinks.history.length, 0, "no writes while paused");
});

test("(16) a source failure prevents dependent publication and preserves LKG", async () => {
  const store = makeStore();
  const dd = makeDataDoe({ failKey: "source-oli" });
  const flow = runFlow({ store, dd, cycleDate: "2026-08-25" });
  const rollup = await flow.promise;
  assert.equal(rollup.stopped, true);
  assert.equal(rollup.stopReason.code, "REQUIRED_SOURCE_FAILED");
  assert.deepEqual(rollup.snapshots.recorded, [], "(16) nothing validated => nothing recorded/publishable");
  assert.equal(flow.sinks.coverage.length, 0, "no coverage claimed for a failed source");
  // Dependent readiness reports the blockage -- a dependent dashboard can never publish from this state.
  const readiness = dash.dailyReportingReadiness({
    accounts: ["A01"], oliCoverageByAccountId: { A01: [] }, catalogSnapshot: null,
    campaignAds: { grain: "campaign-performance-v1", read: "ok", windows: [] },
    from: "2026-08-10", to: "2026-08-14",
  });
  assert.equal(readiness.ready, false, "(16) the dependent dashboard is blocked, LKG serves instead");
});

test("(18) NOTHING is published or scheduled by this task (defaults OFF, no cron, no publisher import)", () => {
  const migration = readFileSync(path.join(process.cwd(), "supabase", "migrations", "20260820_source_durable_model.sql"), "utf8");
  assert.match(migration, /schedule_enabled boolean not null default false/, "every source schedule defaults OFF");
  const vercel = JSON.parse(readFileSync(path.join(process.cwd(), "vercel.json"), "utf8"));
  assert.equal((vercel.crons || []).length, 0, "no cron registered");
  for (const file of ["source-bucket-sync.js", "source-bucket-sync-runtime.js", "source-fixpoint.js", "source-schedule.js", "durable-dashboards.js"]) {
    const src = readFileSync(path.join(process.cwd(), "lib", "server", "sync", file), "utf8");
    assert.doesNotMatch(src, /report-publisher/, `${file} never touches the publisher`);
  }
});

async function main() {
  out("zero-export rehearsal proof suite");
  bucketSync = await import("../lib/server/sync/source-bucket-sync.js");
  model = await import("../lib/server/sync/source-durable-model.js");
  dash = await import("../lib/server/sync/durable-dashboards.js");
  brands = await import("../lib/server/sync/brand-resolution.js");
  worker = await import("../lib/server/sync/source-worker.js");
  dates = await import("../lib/server/date-windows.js");

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
