// ASIN Ads ("Ad Performance by ASIN & Date", asin-performance-v1) as an ADDITIONAL, independently scheduled durable
// source -- EXECUTABLE offline proof (no network: every fetch is refused; every I/O collaborator is injected). Covers:
//   A exact request contract (columns / groupBy / six summed aliases / limit / skip / order) + alias -> metric persist;
//   B the runner-only export guard (decoupled from the active READ grain, which stays Campaign);
//   C per-account windows from REAL coverage (rolling / one-time catch-up / initial / covered / unreadable; D-1 end;
//     never before the 60-day horizon; a missing day is never a zero);
//   D region routing, <=5-seller batches per window, saved-row chunking, new-account onboarding;
//   E a full 50,000-row page (never persisted; date bisection; fragment validation; budget), duplicates,
//     out-of-window rows, provider loading notices / issues, failed / torn pages;
//   F LKG-preserving persistence (upsert-then-prune), idempotent replay, ownership + marketplace + currency;
//   G the region slice: hard create cap (budget-deferred with zero writes), create-time split / isolation, transient,
//     completed-export reuse + adopt-only, multi-chunk accounts, token accounting;
//   H scheduler / manual parity + workflow wiring (one owner, no new cron, per-region caps);
//   I operator status rows + the folded Data Sync Center card;
//   J no regression to Campaign Ads (skip pagination, no delete/prune, default recovery engine, active grain).
// 7-bit ASCII, LF, no top-level await in the test bodies.

import assert from "node:assert/strict";
import { readFileSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = process.env[SB_KEY_ENV] || ["test", "svc", "role", "key"].join("-");
process.env.DATADOE_API_KEY = process.env.DATADOE_API_KEY || ["dd", "test"].join("_");
// ZERO network: any real fetch is a test failure.
globalThis.fetch = async (u) => { throw new Error("NETWORK REFUSED IN TEST: " + String(u).slice(0, 60)); };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
let passed = 0; const tests = []; const test = (name, fn) => tests.push({ name, fn });

const AS = await import("../lib/server/ads-sync.js");
const AAS = await import("../lib/server/active-ads-source.js");
const R = await import("../lib/server/sync/scheduled-asin-ads-runner.js");
const PRUNE = await import("../lib/server/ads-row-prune.js");
const C = await import("../lib/server/sync/scheduled-campaign-ads-runner.js");
const ST = await import("../lib/server/sync/source-status.js");
const REG = await import("../lib/server/sync/registry.js");
const SSO = await import("../lib/server/sync/source-scheduled-oli.js");
const FAM = await import("../lib/server/sync/scheduled-family-registry.js");
const { evaluateSourceCoverage } = await import("../lib/server/sync/ppc-ads-loader.js");

const ASIN = AS.ADS_SOURCES.find((s) => s.key === "asin-performance-v1");
const CAMP = AS.ADS_SOURCES.find((s) => s.key === "campaign-performance-v1");
const NOW = "2026-10-03T09:00:00.000Z";
const ASOF = "2026-10-02";
const KEY = ["prim", "key"].join("-");
const CONNS = [{ id: "primary", apiKey: KEY, accountPrefix: "" }];
const id = (n) => "a" + String(n).padStart(7, "0") + "-0000-4000-8000-000000000000";

// ---------------------------------------------------------------------------------------------------------------
// An in-memory durable store + DataDoe double (one per test). rowsFor({ ids, from, to, skip }) returns the rows the
// provider "has" for that export (or a page object to force a malformed page). Every create is recorded.
// ---------------------------------------------------------------------------------------------------------------
function world(opts = {}) {
  const accounts = opts.accounts || [{ id: id(1), country: "IN" }];
  const store = new Map(); // pk -> row
  const pk = (r) => [r.source_key, r.account_id, r.marketplace_country_code, r.metric_date, r.dimension_key].join("|");
  for (const r of opts.seedRows || []) store.set(pk(r), { ...r });
  const states = new Map((opts.states || []).map((s) => [s.account_id + "|" + s.source_key, s]));
  const coverage = new Map(); // account -> windows
  for (const [a, ws] of Object.entries(opts.coverage || {})) coverage.set(a, ws.slice());
  const calls = { creates: [], downloads: 0, upserts: 0, prunes: [], deletes: [], states: [], coverage: [], claim: 0, release: 0, order: [] };
  const meta = new Map(); let seq = 0;
  const workerDeps = {
    getConnections: () => CONNS,
    fetchAccounts: async () => accounts,
    downloadExport: async (_k, exportId) => {
      calls.downloads += 1;
      const listedExport = (opts.listed || []).find((x) => x.id === exportId);
      const m = meta.get(exportId) || (listedExport ? { ids: listedExport.sellerOrVendorIds, from: String(listedExport.from).slice(0, 10), to: String(listedExport.to).slice(0, 10), skip: listedExport.skip || 0, n: 0 } : null);
      if (!m) throw new Error("unknown export " + exportId);
      if (opts.downloadThrows) throw new Error("DataDoe export download failed (502).");
      const page = (opts.rowsFor || (() => []))({ ids: m.ids, from: m.from, to: m.to, skip: m.skip, n: m.n });
      if (page && !Array.isArray(page)) return page;
      return { status: "COMPLETED", rowCount: page.length, rows: page, loadingNotice: null, dataSourceIssues: [] };
    },
    claimRefreshLock: async () => { calls.claim += 1; return true; },
    releaseRefreshLock: async () => { calls.release += 1; },
    getAdsSyncStates: async (ids) => [...states.values()].filter((s) => ids.includes(s.account_id)),
    getCoverage: async (a, sk) => ({ windows: (coverage.get(a) || []).slice(), status: (states.get(a + "|" + sk) || {}).last_status || "missing", read: "ok", error: null }),
    upsertAdsDailyRows: async (rows) => {
      calls.order.push("upsert"); calls.upserts += 1;
      if (opts.upsertThrowsAfter != null) { rows.slice(0, opts.upsertThrowsAfter).forEach((r) => store.set(pk(r), { ...r })); throw new Error("Supabase request failed (500): upsert"); }
      for (const r of rows) store.set(pk(r), { ...r });
    },
    deleteAdsDailyRows: async (o) => { calls.deletes.push(o); for (const [k, r] of store) if (r.source_key === o.sourceKey && r.account_id === o.accountId && r.metric_date >= o.from && r.metric_date <= o.to) store.delete(k); return { write: "ok" }; },
    pruneAdsDailyRows: async (o) => {
      calls.order.push("prune"); calls.prunes.push(o);
      if (opts.pruneFails) return { write: "write-failed", error: "ADS_ROWS_PRUNE_FAILED" };
      if (opts.verifiedPrune) {
        // The production orchestration (ads-row-prune.js) over this store: probe = "any row of the day not stamped by
        // this run"; delete = remove exactly those. deleteError(day, attempt) scripts a failure; commitDespiteError
        // makes the failed DELETE still land (a client-side timeout after the server committed).
        const vp = opts.verifiedPrune;
        const stale = (day) => (r) => r.source_key === o.sourceKey && r.account_id === o.accountId && r.metric_date === day && r.source_refreshed_at !== o.keepRefreshedAt;
        const attempts = new Map();
        calls.pruneDeletes = calls.pruneDeletes || []; calls.pruneProbes = calls.pruneProbes || 0;
        return PRUNE.pruneAdsWindowVerified({
          from: o.from, to: o.to, sleep: async () => {}, retryDelayMs: 0,
          probeStale: async (day) => { calls.pruneProbes += 1; if (vp.probeThrows) throw vp.probeThrows; return [...store.values()].some(stale(day)); },
          deleteStale: async (day) => {
            const n = (attempts.get(day) || 0) + 1; attempts.set(day, n); calls.pruneDeletes.push(day);
            const err = vp.deleteError ? vp.deleteError(day, n) : null;
            if (err && !vp.commitDespiteError) throw err;
            for (const [k, r] of store) if (stale(day)(r)) store.delete(k);
            if (err) throw err;
          },
        });
      }
      for (const [k, r] of store) if (r.source_key === o.sourceKey && r.account_id === o.accountId && r.metric_date >= o.from && r.metric_date <= o.to && r.source_refreshed_at !== o.keepRefreshedAt) store.delete(k);
      return { write: "ok" };
    },
    upsertAdDailyMetrics: async () => {},
    upsertAdsSyncStates: async (sts) => { calls.states.push(...sts); for (const s of sts) states.set(s.account_id + "|" + s.source_key, { ...(states.get(s.account_id + "|" + s.source_key) || {}), ...s }); },
    recordAdsCoverageWindows: async (rows) => { calls.coverage.push(...rows); for (const r of rows) coverage.set(r.accountId, (coverage.get(r.accountId) || []).concat([{ from: r.coveredFrom, to: r.coveredTo }])); return { write: "ok", recorded: rows.length }; },
    readDurableRows: async ({ accountId, sourceKeys, from, to }) => [...store.values()].filter((r) => r.account_id === accountId && sourceKeys.includes(r.source_key) && r.metric_date >= from && r.metric_date <= to),
    now: () => opts.now || NOW,
    clock: () => Date.parse(opts.now || NOW),
  };
  const createExport = async (_k, source, ids, from, to, skip = 0) => {
    if (opts.createThrows) { const e = opts.createThrows({ ids, from, to }); if (e) throw e; }
    const exportId = "exp-" + (++seq);
    calls.creates.push({ sourceKey: source.key, ids: [...ids], from, to, skip, body: AS.buildAdsExportRequestBody(source, ids, from, to, skip) });
    meta.set(exportId, { ids: [...ids], from, to, skip, n: seq });
    return { exportId };
  };
  const deps = {
    getConnections: () => CONNS, fetchAccounts: async () => accounts,
    fetchCompatibleSourceNames: async (_k, acct) => new Set((opts.incompatible || []).includes(acct) ? ["ad performance by campaign & date"] : ["ad performance by asin & date", "ad performance by campaign & date"]),
    getCoverage: workerDeps.getCoverage,
    getAdsDailySourceRowCount: async ({ accountId }) => ({ rows: (opts.rowCounts || {})[accountId] || 0 }),
    createExport, workerDeps,
    listRecentExports: async () => (opts.listed || []),
    nowMs: () => Date.parse(NOW),
    upsertSourceRunStatus: async (e) => { (calls.runStatus = calls.runStatus || []).push(e); return { write: "ok" }; },
    sleep: async () => {},
  };
  return { deps, workerDeps, calls, store, states, coverage, accounts };
}
const asinRow = (seller, mkt, date, asin, m = {}) => ({ seller_or_vendor_id: seller, marketplace_country_code: mkt, date, child_asin: asin,
  ad_sales_same_sku_sum: "sales" in m ? m.sales : 10, ad_clicks_sum: "clicks" in m ? m.clicks : 2, ad_impressions_sum: "imps" in m ? m.imps : 50,
  ad_spend_sum: "spend" in m ? m.spend : 1.5, ad_units_sold_same_sku_sum: "units" in m ? m.units : 1, ad_orders_same_sku_sum: "orders" in m ? m.orders : 1 });
const daysOf = (from, to) => { const out = []; let d = from; while (d <= to) { out.push(d); const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + 1); d = x.toISOString().slice(0, 10); } return out; };
const covOk = (windows, status = "succeeded") => ({ windows, status, read: "ok", error: null });
const AUTH = AAS.ASIN_ADS_RUNNER_AUTHORIZATION;
const runAsin = (w, ids, window) => AS.runAdsSyncWithDeps({ ...AS.PRODUCTION_ADS_SYNC_DEPS, ...w.workerDeps, createExport: w.deps.createExport }, [...new Set(w.accounts.map((a) => a.country))], ["asin-performance-v1"], { accountIds: ids, requiredCoverage: window, adsRunnerAuthorization: AUTH });

// ================================================ A. request contract ================================================
test("A1 exact reduced-grain request: 4 grouped dimensions, six summed <metric>_sum aliases, limit 50000, skip 0, JSON, date ASC", () => {
  const b = AS.buildAdsExportRequestBody(ASIN, ["s1", "s2"], "2026-09-12", "2026-10-02", 0);
  assert.equal(b.sourceId, "d0017e92fb089c2c8c3fe65f81d08666ecb4fe937ffbce9969ce2fc7d28c805c");
  assert.deepEqual(b.columns, ["marketplace_country_code", "seller_or_vendor_id", "date", "child_asin"]);
  assert.deepEqual(b.groupBy, ["marketplace_country_code", "seller_or_vendor_id", "date", "child_asin"]);
  assert.deepEqual(b.aggregations, ["ad_sales_same_sku", "ad_clicks", "ad_impressions", "ad_spend", "ad_units_sold_same_sku", "ad_orders_same_sku"].map((c) => ({ column: c, aggregation: "sum", alias: c + "_sum" })));
  assert.equal(b.limit, 50000); assert.equal(b.skip, 0); assert.equal(b.outputType, "JSON");
  assert.equal(b.orderByColumn, "date"); assert.equal(b.orderByDirection, "ASC");
  for (const bad of ["sku", "ad_campaign_id", "ad_group_id", "ad_id", "ad_campaign_type"]) assert.ok(!b.columns.includes(bad) && !b.groupBy.includes(bad), "older wide grain field present: " + bad);
});
test("A2 the six summed aliases persist under their EXISTING metric names; dimension_key is the child ASIN; a null metric stays null (never 0)", async () => {
  const w = world({ accounts: [{ id: id(1), country: "IN" }], rowsFor: () => [asinRow(id(1), "IN", "2026-10-02", "B0AAA", { clicks: null, spend: 7.25 })] });
  const s = await runAsin(w, [id(1)], { from: "2026-10-02", to: "2026-10-02" });
  assert.equal(s.status, "completed");
  const rows = [...w.store.values()];
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0].metrics).sort(), ["ad_clicks", "ad_impressions", "ad_orders_same_sku", "ad_sales_same_sku", "ad_spend", "ad_units_sold_same_sku"]);
  assert.equal(rows[0].metrics.ad_spend, 7.25); assert.equal(rows[0].metrics.ad_clicks, null);
  assert.equal(rows[0].dimension_key, JSON.stringify(["B0AAA"]));
  assert.equal(rows[0].source_key, "asin-performance-v1");
});
test("A3 the ASIN source declaration: 60 initial / 21 daily / 49 monthly days, <=5 sellers, child_asin key, split-window full-page policy, 7-create invocation ceiling", () => {
  assert.equal(ASIN.initialDays, 60); assert.equal(ASIN.dailyDays, 21); assert.equal(ASIN.monthlyDays, 49);
  assert.equal(ASIN.batchSize, 5); assert.deepEqual(ASIN.keyFields, ["child_asin"]);
  assert.equal(ASIN.fullPagePolicy, "split-window"); assert.equal(ASIN.maxCoverageCreateExports, 7);
  assert.deepEqual(R.ASIN_ADS_WINDOWS, { initialDays: 60, dailyDays: 21 });
  assert.equal(R.ASIN_ADS_TOKENS_PER_CREATE, 2);
});

// ================================================ B. runner-only guard ================================================
test("B1 an ASIN export WITHOUT the runner authorization is refused before any lock / I/O (ASIN_ADS_EXPORT_RUNNER_ONLY)", async () => {
  const w = world();
  await assert.rejects(() => AS.runAdsSyncWithDeps({ ...w.workerDeps, createExport: w.deps.createExport }, ["IN"], ["asin-performance-v1"], { accountIds: [id(1)], requiredCoverage: { from: ASOF, to: ASOF } }), (e) => e.code === "ASIN_ADS_EXPORT_RUNNER_ONLY");
  await assert.rejects(() => AS.runAdsSyncWithDeps({ ...w.workerDeps, createExport: w.deps.createExport }, ["IN"]), (e) => e.code === "ASIN_ADS_EXPORT_RUNNER_ONLY"); // legacy default all-sources cadence call
  assert.equal(w.calls.claim, 0); assert.equal(w.calls.creates.length, 0);
});
test("B2 authorization WITHOUT coverage mode, or a forged look-alike capability, is refused", async () => {
  const w = world();
  await assert.rejects(() => AS.runAdsSyncWithDeps({ ...w.workerDeps, createExport: w.deps.createExport }, ["IN"], ["asin-performance-v1"], { adsRunnerAuthorization: AUTH }), (e) => e.code === "ASIN_ADS_EXPORT_RUNNER_ONLY");
  await assert.rejects(() => AS.runAdsSyncWithDeps({ ...w.workerDeps, createExport: w.deps.createExport }, ["IN"], ["asin-performance-v1"], { accountIds: [id(1)], requiredCoverage: { from: ASOF, to: ASOF }, adsRunnerAuthorization: Symbol("asin-ads-runner-authorization") }), (e) => e.code === "ASIN_ADS_EXPORT_RUNNER_ONLY");
  assert.equal(w.calls.claim, 0);
});
test("B3 the active READ grain stays Campaign; ASIN is runner-only, not retired; the legacy Scheduler-v1 ASIN entry stays disabled; the raw-sourceId probe still refuses ASIN", () => {
  assert.equal(AAS.ADS_ACTIVE_SOURCE, "campaign");
  assert.equal(AAS.ACTIVE_ADS_SOURCE_KEY, "campaign-performance-v1");
  assert.equal(AAS.ACTIVE_ADS_REGISTRY_KEY, "ads-campaign-date");
  assert.deepEqual([...AAS.RETIRED_ADS_REGISTRY_KEYS], []);
  assert.equal(AAS.isAdsExportRunnerOnlyFor("asin-performance-v1"), true);
  assert.equal(AAS.isAdsExportRunnerOnlyFor("campaign-performance-v1"), false);
  assert.equal(AAS.isAdsExportRunnerOnlyForSourceId(AAS.ASIN_ADS_SOURCE_ID), true);
  const legacy = REG.SYNC_REGISTRY ? REG.SYNC_REGISTRY.find((e) => e.sourceKey === "asin-performance-v1") : null;
  if (legacy) assert.equal(legacy.enabled, false);
  const probe = readFileSync(path.join(ROOT, "api/datadoe.js"), "utf8");
  assert.match(probe, /if \(isAdsExportRunnerOnlyForSourceId\(sourceId\)\) \{\s*res\.status\(409\)/);
});
test("B4 Campaign coverage-mode exports need NO runner authorization (unchanged)", async () => {
  const w = world({ accounts: [{ id: id(1), country: "IN" }], rowsFor: () => [{ seller_or_vendor_id: id(1), marketplace_country_code: "IN", date: ASOF, ad_campaign_id: "c1", ad_campaign_type: "SPONSORED_PRODUCTS", ad_spend: 3 }] });
  const s = await AS.runAdsSyncWithDeps({ ...w.workerDeps, createExport: w.deps.createExport }, ["IN"], ["campaign-performance-v1"], { accountIds: [id(1)], requiredCoverage: { from: ASOF, to: ASOF } });
  assert.equal(s.status, "completed"); assert.equal(w.calls.creates.length, 1);
});

// ================================================ C. windows from coverage ================================================
test("C1 the windows end at D-1: horizon = 60 inclusive days, rolling = 21", () => {
  const w = R.asinAdsWindows(ASOF);
  assert.deepEqual(w.horizon, { from: "2026-08-04", to: ASOF, days: 60 });
  assert.deepEqual(w.rolling, { from: "2026-09-12", to: ASOF, days: 21 });
});
test("C2 covered (succeeded + proven rolling window) -> zero creates", () => {
  assert.equal(R.asinAdsAccountWindow({ asOf: ASOF, coverage: covOk([{ from: "2026-08-01", to: ASOF }]) }).kind, "covered");
});
test("C3 one-time CATCH-UP from the first uncovered date (coverage through 09-01 -> 09-02..D-1), never re-fetching covered history", () => {
  assert.deepEqual(R.asinAdsAccountWindow({ asOf: ASOF, coverage: covOk([{ from: "2026-06-27", to: "2026-09-01" }]) }), { kind: "catch-up", from: "2026-09-02", to: ASOF });
});
test("C4 INITIAL 60-day window for an account with no coverage (new / never covered / failed-only)", () => {
  assert.deepEqual(R.asinAdsAccountWindow({ asOf: ASOF, coverage: covOk([], "missing") }), { kind: "initial", from: "2026-08-04", to: ASOF });
  assert.deepEqual(R.asinAdsAccountWindow({ asOf: ASOF, coverage: covOk([], "failed") }), { kind: "initial", from: "2026-08-04", to: ASOF });
});
test("C5 an INTERIOR gap older than the rolling window starts the catch-up at the gap (not at latest_metric_date)", () => {
  const cov = covOk([{ from: "2026-08-04", to: "2026-08-20" }, { from: "2026-08-25", to: "2026-10-01" }]);
  assert.deepEqual(R.asinAdsAccountWindow({ asOf: ASOF, coverage: cov }), { kind: "catch-up", from: "2026-08-21", to: ASOF });
});
test("C6 a gap only inside the rolling window (e.g. D-1 missing) re-reads the reviewed 21-day rolling window", () => {
  assert.deepEqual(R.asinAdsAccountWindow({ asOf: ASOF, coverage: covOk([{ from: "2026-08-01", to: "2026-10-01" }]) }), { kind: "rolling", from: "2026-09-12", to: ASOF });
});
test("C7 a FAILED last run is never 'covered', even with full windows (rolling re-read)", () => {
  assert.equal(R.asinAdsAccountWindow({ asOf: ASOF, coverage: covOk([{ from: "2026-08-01", to: ASOF }], "failed") }).kind, "rolling");
});
test("C8 unreadable / malformed coverage fails CLOSED (excluded, reported) -- never a guessed window", () => {
  assert.equal(R.asinAdsAccountWindow({ asOf: ASOF, coverage: { windows: [], status: "missing", read: "read-failed" } }).kind, "unreadable");
  assert.equal(R.asinAdsAccountWindow({ asOf: ASOF, coverage: null }).kind, "unreadable");
  assert.equal(R.asinAdsAccountWindow({ asOf: ASOF, coverage: covOk([{ from: "2026-09-30", to: "2026-09-01" }]) }).kind, "unreadable");
});
test("C9 coverage only BEFORE the horizon -> the 60-day initial window (no unrequested historical backfill before 08-04)", () => {
  const w = R.asinAdsAccountWindow({ asOf: ASOF, coverage: covOk([{ from: "2026-06-01", to: "2026-07-01" }]) });
  assert.equal(w.from, "2026-08-04"); assert.equal(w.kind, "initial");
});
test("C10 earliestUncoveredDate handles overlap, adjacency, interior gaps and full coverage", () => {
  assert.equal(R.earliestUncoveredDate([], "2026-08-04", ASOF), "2026-08-04");
  assert.equal(R.earliestUncoveredDate([{ from: "2026-08-01", to: "2026-08-10" }, { from: "2026-08-11", to: "2026-08-20" }], "2026-08-04", "2026-08-20"), null);
  assert.equal(R.earliestUncoveredDate([{ from: "2026-08-04", to: "2026-08-10" }, { from: "2026-08-08", to: "2026-08-12" }, { from: "2026-08-14", to: ASOF }], "2026-08-04", ASOF), "2026-08-13");
});
test("C11 a day the provider returned no rows for is NOT saved as a zero row (only real rows persist)", async () => {
  const w = world({ rowsFor: ({ from, to }) => daysOf(from, to).filter((d) => d !== "2026-10-01").map((d) => asinRow(id(1), "IN", d, "B0X")) });
  await runAsin(w, [id(1)], { from: "2026-09-29", to: ASOF });
  const dates = [...w.store.values()].map((r) => r.metric_date).sort();
  assert.deepEqual(dates, ["2026-09-29", "2026-09-30", "2026-10-02"]);
});

// ================================================ D. routing / batching / onboarding ================================================
test("D1 <=5-seller batches per (region, window): accounts with different windows never share an export; deterministic by id", () => {
  const pend = (n, from) => ({ accountId: id(n), marketplace: "DE", window: { from, to: ASOF }, ratePerDay: 1 });
  const items = R.planAsinAdsItems([...Array.from({ length: 12 }, (_, i) => pend(i + 1, "2026-09-02")), pend(20, "2026-08-04"), pend(21, "2026-08-04")]);
  assert.deepEqual(items.map((it) => it.allowlist.length), [2, 5, 5, 2]); // 08-04 group first (sorted), then 09-02 group 5/5/2
  for (const it of items) assert.ok(it.allowlist.length <= 5);
  assert.deepEqual(items[0].allowlist, [id(20), id(21)]);
  assert.deepEqual(items[1].allowlist, [id(1), id(2), id(3), id(4), id(5)]);
  for (const it of items.slice(1)) assert.equal(it.window.from, "2026-09-02");
});
test("D2 saved-row CHUNKING: a batch predicted above the safe target is split into contiguous date chunks covering the window exactly", () => {
  const p = [{ accountId: id(1), window: { from: "2026-09-02", to: ASOF }, ratePerDay: 1266 }, { accountId: id(2), window: { from: "2026-09-02", to: ASOF }, ratePerDay: 560 }];
  const items = R.planAsinAdsItems(p);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => [i.window.from, i.window.to]), [["2026-09-02", "2026-09-17"], ["2026-09-18", ASOF]]);
  for (const it of items) { assert.ok(it.expectedRows <= R.ASIN_ADS_PLAN_TARGET_ROWS); assert.deepEqual(it.allowlist, [id(1), id(2)]); }
  assert.deepEqual(R.chunkWindow({ from: "2026-09-02", to: ASOF }, 3).map((w) => AS.inclusiveDaySpan(w.from, w.to)), [11, 10, 10]);
});
test("D3 REGION routing from the live directory (IN / UK-GB-DE-...-AU / US-CA); unknown marketplaces and prefixed ids never export", async () => {
  const accounts = [{ id: id(1), country: "IN" }, { id: id(2), country: "UK" }, { id: id(3), country: "DE" }, { id: id(4), country: "AU" }, { id: id(5), country: "US" }, { id: id(6), country: "CA" }, { id: id(7), country: "BR" }, { id: "dd-secondary:x", country: "US" }];
  const r = await C.discoverRoutedAccounts({ deps: { getConnections: () => CONNS, fetchAccounts: async () => accounts } });
  assert.deepEqual(r.byRegion.india.map((a) => a.accountId), [id(1)]);
  assert.deepEqual(r.byRegion["europe-au"].map((a) => a.accountId).sort(), [id(2), id(3), id(4)]);
  assert.deepEqual(r.byRegion["us-ca"].map((a) => a.accountId).sort(), [id(5), id(6)]);
  assert.deepEqual(r.unassigned.map((a) => a.accountId), [id(7)]);
});
test("D4 the region plan: incompatible accounts typed + excluded; coverage-derived windows; saved-row rate; an allowlist outside the region is refused", async () => {
  const w = world({ accounts: [{ id: id(1), country: "IN" }, { id: id(2), country: "IN" }, { id: id(3), country: "DE" }], incompatible: [id(2)],
    coverage: { [id(1)]: [{ from: "2026-06-27", to: "2026-09-01" }] }, states: [{ account_id: id(1), source_key: "asin-performance-v1", last_status: "succeeded" }], rowCounts: { [id(1)]: 2800 } });
  const p = await R.planAsinAdsRegionRun({ region: "india", asOf: ASOF, deps: w.deps });
  assert.deepEqual(p.incompatible.map((a) => a.accountId), [id(2)]);
  assert.equal(p.pending.length, 1); assert.equal(p.pending[0].kind, "catch-up"); assert.deepEqual([p.pending[0].window.from, p.pending[0].window.to], ["2026-09-02", ASOF]);
  assert.equal(p.pending[0].ratePerDay, 100); // 2800 rows over the 28-day look-back
  await assert.rejects(() => R.planAsinAdsRegionRun({ region: "india", asOf: ASOF, accountAllowlist: [id(3)], deps: w.deps }), (e) => e.code === "ASIN_ADS_ALLOWLIST_NOT_IN_REGION");
});
test("D5 NEW-ACCOUNT ONBOARDING: a newly export-eligible account joins its region on the next plan with the 60-day initial window, nothing else changes", async () => {
  const base = [{ id: id(1), country: "GB" }];
  const w1 = world({ accounts: base, coverage: { [id(1)]: [{ from: "2026-08-01", to: ASOF }] }, states: [{ account_id: id(1), source_key: "asin-performance-v1", last_status: "succeeded" }] });
  const p1 = await R.planAsinAdsRegionRun({ region: "europe-au", asOf: ASOF, deps: w1.deps });
  assert.equal(p1.items.length, 0);
  const w2 = world({ accounts: [...base, { id: id(9), country: "FR" }], coverage: { [id(1)]: [{ from: "2026-08-01", to: ASOF }] }, states: [{ account_id: id(1), source_key: "asin-performance-v1", last_status: "succeeded" }] });
  const p2 = await R.planAsinAdsRegionRun({ region: "europe-au", asOf: ASOF, deps: w2.deps });
  assert.equal(p2.items.length, 1); assert.deepEqual(p2.items[0].allowlist, [id(9)]);
  assert.deepEqual([p2.items[0].window.from, p2.items[0].window.to], ["2026-08-04", ASOF]);
  assert.equal(p2.pending[0].kind, "initial");
});

// ================================================ E. the 50,000-row page + fragment validation ================================================
const fullPage = (rows) => ({ status: "COMPLETED", rowCount: rows.length, rows, loadingNotice: null, dataSourceIssues: [] });
test("E1 an export of EXACTLY 50,000 rows is never persisted: the window is bisected; fragments are contiguous, cover it exactly, each < limit", async () => {
  const w = world({ rowsFor: ({ from, to }) => {
    if (from === "2026-09-12" && to === ASOF) return fullPage(Array.from({ length: 50000 }, (_, i) => asinRow(id(1), "IN", "2026-09-20", "BFULL" + i)));
    return daysOf(from, to).map((d) => asinRow(id(1), "IN", d, "B1"));
  } });
  const s = await runAsin(w, [id(1)], { from: "2026-09-12", to: ASOF });
  assert.equal(s.status, "completed");
  assert.deepEqual(w.calls.creates.map((c) => [c.from, c.to, c.skip]), [["2026-09-12", ASOF, 0], ["2026-09-12", "2026-09-22", 0], ["2026-09-23", ASOF, 0]]);
  const fr = s.sources["asin-performance-v1"].fragments;
  assert.deepEqual(fr.map((f) => [f.from, f.to]), [["2026-09-12", "2026-09-22"], ["2026-09-23", ASOF]]);
  for (const f of fr) assert.ok(f.rowCount < 50000);
  assert.ok(![...w.store.values()].some((r) => String(r.child_asin).startsWith("BFULL")), "a row of the full page was persisted");
  assert.equal(w.store.size, 21);
  assert.deepEqual(w.calls.coverage.map((c) => [c.coveredFrom, c.coveredTo]), [["2026-09-12", ASOF]]);
});
test("E2 nested bisection stays inside the 7-create invocation ceiling; beyond it the whole window fails closed (nothing persisted)", async () => {
  const always = ({ from }) => fullPage(Array.from({ length: 50000 }, (_, i) => asinRow(id(1), "IN", from, "BF" + i)));
  const w = world({ rowsFor: always });
  const s = await runAsin(w, [id(1)], { from: "2026-09-12", to: ASOF });
  assert.ok(w.calls.creates.length <= 7);
  assert.equal(s.status, "failed"); assert.equal(w.store.size, 0); assert.equal(w.calls.coverage.length, 0);
  assert.match(String(w.calls.states.at(-1).last_error), /ADS_COVERAGE_EXPORT_BUDGET_EXCEEDED|ADS_EXPORT_DAY_AT_ROW_LIMIT/);
  // a window whose every >=2-day fragment is full needs 15 creates: the 8th is refused BEFORE its POST
  const w2 = world({ rowsFor: ({ from, to }) => (from === to ? [asinRow(id(1), "IN", from, "B1")] : fullPage(Array.from({ length: 50000 }, (_, i) => asinRow(id(1), "IN", from, "BF" + i)))) });
  const s2 = await runAsin(w2, [id(1)], { from: "2026-09-25", to: ASOF });
  assert.equal(w2.calls.creates.length, 7); assert.equal(s2.status, "failed"); assert.equal(w2.store.size, 0);
  assert.match(String(w2.calls.states.at(-1).last_error), /ADS_COVERAGE_EXPORT_BUDGET_EXCEEDED/);
});
test("E3 a SINGLE day still at the limit cannot be split by date -> typed fail closed", async () => {
  const w = world({ rowsFor: () => fullPage(Array.from({ length: 50000 }, (_, i) => asinRow(id(1), "IN", ASOF, "BD" + i))) });
  const s = await runAsin(w, [id(1)], { from: ASOF, to: ASOF });
  assert.equal(s.status, "failed"); assert.equal(w.store.size, 0);
  assert.match(String(w.calls.states.at(-1).last_error), /ADS_EXPORT_DAY_AT_ROW_LIMIT/);
});
test("E4 a DUPLICATE natural grain (same seller / marketplace / date / ASIN twice) fails closed -- never double counted", async () => {
  const w = world({ rowsFor: () => [asinRow(id(1), "IN", ASOF, "BDUP"), asinRow(id(1), "IN", ASOF, "BDUP")] });
  const s = await runAsin(w, [id(1)], { from: ASOF, to: ASOF });
  assert.equal(s.status, "failed"); assert.equal(w.store.size, 0);
  assert.match(String(w.calls.states.at(-1).last_error), /ADS_EXPORT_DUPLICATE_GRAIN/);
});
test("E5 a row dated OUTSIDE the requested window fails closed", async () => {
  const w = world({ rowsFor: () => [asinRow(id(1), "IN", "2026-09-01", "BOLD")] });
  const s = await runAsin(w, [id(1)], { from: ASOF, to: ASOF });
  assert.equal(s.status, "failed"); assert.equal(w.store.size, 0);
});
test("E6 a provider history-still-loading notice or a data-source issue fails closed (incomplete coverage never saved)", async () => {
  for (const extra of [{ loadingNotice: "Historical data is still loading" }, { dataSourceIssues: [{ code: "ADS_CONNECTION" }] }]) {
    const w = world({ rowsFor: () => ({ ...fullPage([asinRow(id(1), "IN", ASOF, "B1")]), ...extra }) });
    const s = await runAsin(w, [id(1)], { from: ASOF, to: ASOF });
    assert.equal(s.status, "failed"); assert.equal(w.store.size, 0); assert.equal(w.calls.coverage.length, 0);
  }
});
test("E7 failed / torn pages fail closed: FAILED status, rowCount != raw length, non-array payload", async () => {
  for (const page of [{ status: "FAILED", rowCount: 0, rows: [] }, { status: "COMPLETED", rowCount: 3, rows: [asinRow(id(1), "IN", ASOF, "B1")] }, { status: "COMPLETED", rowCount: 1, rows: "x" }]) {
    const w = world({ rowsFor: () => page });
    const s = await runAsin(w, [id(1)], { from: ASOF, to: ASOF });
    assert.equal(s.status, "failed"); assert.equal(w.store.size, 0);
  }
});

test("E8 a provider DATA-SHAPE change (a summed alias or a grain column no longer returned) fails closed -- never saved as null metrics", async () => {
  for (const drop of ["ad_spend_sum", "ad_orders_same_sku_sum", "child_asin", "marketplace_country_code"]) {
    const w = world({ rowsFor: () => { const r = asinRow(id(1), "IN", ASOF, "B1"); delete r[drop]; return [r]; } });
    const s = await runAsin(w, [id(1)], { from: ASOF, to: ASOF });
    assert.equal(s.status, "failed", drop); assert.equal(w.store.size, 0);
    assert.match(String(w.calls.states.at(-1).last_error), /ADS_EXPORT_SHAPE_MISMATCH/);
  }
});

// ================================================ F. persistence ================================================
test("F1 LKG-preserving replace: UPSERT first, then PRUNE only rows this run did not refresh, scoped to account + source + window", async () => {
  const w = world({ rowsFor: () => [asinRow(id(1), "IN", ASOF, "B1")] });
  await runAsin(w, [id(1)], { from: "2026-10-01", to: ASOF });
  assert.deepEqual(w.calls.order, ["upsert", "prune"]);
  assert.deepEqual(w.calls.prunes, [{ accountId: id(1), sourceKey: "asin-performance-v1", from: "2026-10-01", to: ASOF, keepRefreshedAt: NOW }]);
  assert.equal(w.calls.deletes.length, 0);
});
test("F2 an upsert failing part-way NEVER empties the window: no prune, prior saved rows stay, account failed, no coverage recorded", async () => {
  const seed = [{ source_key: "asin-performance-v1", account_id: id(1), marketplace_country_code: "IN", metric_date: "2026-10-01", dimension_key: JSON.stringify(["OLD"]), metrics: { ad_spend: 9 }, source_refreshed_at: "2026-09-30T00:00:00.000Z" }];
  const w = world({ seedRows: seed, upsertThrowsAfter: 1, rowsFor: () => [asinRow(id(1), "IN", "2026-10-01", "N1"), asinRow(id(1), "IN", ASOF, "N2")] });
  const s = await runAsin(w, [id(1)], { from: "2026-10-01", to: ASOF });
  assert.equal(s.status, "failed"); assert.equal(w.calls.prunes.length, 0); assert.equal(w.calls.coverage.length, 0);
  assert.ok([...w.store.values()].some((r) => r.dimension_key === JSON.stringify(["OLD"])), "the last-known-good row was deleted");
  assert.equal(w.calls.states.at(-1).last_status, "failed");
});
test("F3 a failed PRUNE excludes the account (failed state, no coverage, no success)", async () => {
  const w = world({ pruneFails: true, rowsFor: () => [asinRow(id(1), "IN", ASOF, "B1")] });
  const s = await runAsin(w, [id(1)], { from: ASOF, to: ASOF });
  assert.equal(s.status, "failed"); assert.equal(w.calls.coverage.length, 0);
  assert.match(String(w.calls.states.at(-1).last_error), /ADS_ROWS_PRUNE_FAILED/);
});
const pgTimeout = () => Object.assign(new Error("Supabase request failed (500): canceling statement due to statement timeout B0SECRET42"), { status: 500, code: "57014" });
const staleRow = (d, asin, at = "2026-09-30T00:00:00.000Z") => ({ source_key: "asin-performance-v1", account_id: id(1), marketplace_country_code: "IN", metric_date: d, dimension_key: JSON.stringify([asin]), metrics: { ad_spend: 7 }, source_refreshed_at: at });
const prevState = { account_id: id(1), source_key: "asin-performance-v1", last_status: "succeeded", latest_metric_date: "2026-10-01", content_rev: "rev-prev" };

test("F5 AAKRITI 2026-10-07: every row saved and NOTHING stale -> the probe proves each day clean, ZERO DELETE statements, the window is covered and the state succeeds (rows, coverage and state agree)", async () => {
  const w = world({ states: [prevState], verifiedPrune: { deleteError: () => pgTimeout() }, rowsFor: () => [asinRow(id(1), "IN", "2026-10-01", "B1"), asinRow(id(1), "IN", ASOF, "B1")] });
  const s = await runAsin(w, [id(1)], { from: "2026-10-01", to: ASOF });
  assert.equal(s.status, "completed");
  assert.deepEqual(w.calls.pruneDeletes, [], "no stale row -> no DELETE at all (the statement that timed out is never sent)");
  assert.equal(w.calls.pruneProbes, 2, "one bounded probe per day");
  assert.deepEqual(w.calls.coverage.map((c) => [c.coveredFrom, c.coveredTo]), [["2026-10-01", ASOF]]);
  const st = w.states.get(id(1) + "|asin-performance-v1");
  assert.equal(st.last_status, "succeeded"); assert.equal(st.latest_metric_date, ASOF, "the newest saved day is now the observed-through date");
});
test("F6 a stale row + a DELETE that times out but DID commit -> the re-probe proves the day clean: success, stale row gone, no false failure", async () => {
  const w = world({ seedRows: [staleRow(ASOF, "GONE")], verifiedPrune: { deleteError: () => pgTimeout(), commitDespiteError: true }, rowsFor: () => [asinRow(id(1), "IN", ASOF, "B1")] });
  const s = await runAsin(w, [id(1)], { from: ASOF, to: ASOF });
  assert.equal(s.status, "completed");
  assert.ok(![...w.store.values()].some((r) => r.dimension_key === JSON.stringify(["GONE"])));
  assert.equal(w.calls.coverage.length, 1);
});
test("F7 a stale row the DELETE cannot remove (timeout twice) -> failed state with ONLY the sanitized status + Postgres code, no coverage, the previous observed-through date and content rev kept", async () => {
  const w = world({ states: [prevState], seedRows: [staleRow(ASOF, "GONE")], verifiedPrune: { deleteError: () => pgTimeout() }, rowsFor: () => [asinRow(id(1), "IN", ASOF, "B1")] });
  const s = await runAsin(w, [id(1)], { from: ASOF, to: ASOF });
  assert.equal(s.status, "failed"); assert.equal(w.calls.coverage.length, 0);
  assert.deepEqual(w.calls.pruneDeletes, [ASOF, ASOF], "exactly one retry of a transient (57014) failure");
  const st = w.states.get(id(1) + "|asin-performance-v1");
  assert.equal(st.last_status, "failed");
  assert.equal(st.last_error, "ADS_ROWS_PRUNE_FAILED (stage=delete status=500 pg=57014 stale=present)");
  assert.equal(st.latest_metric_date, "2026-10-01"); assert.equal(st.content_rev, "rev-prev");
  assert.ok(!JSON.stringify([...w.states.values(), s]).includes("B0SECRET42"), "the raw database message never reaches state or the summary");
});
test("F8 CLEANUP RETRY is idempotent: the next run (new stamp) re-saves the same rows, removes the stale row and succeeds; a further run changes nothing", async () => {
  const rows = () => [asinRow(id(1), "IN", ASOF, "B1")];
  const w1 = world({ states: [prevState], seedRows: [staleRow(ASOF, "GONE")], verifiedPrune: { deleteError: () => pgTimeout() }, rowsFor: rows });
  await runAsin(w1, [id(1)], { from: ASOF, to: ASOF });
  const carried = [...w1.store.values()];
  const w2 = world({ states: [...w1.states.values()], seedRows: carried, verifiedPrune: {}, rowsFor: rows, now: "2026-10-04T09:00:00.000Z" });
  const s2 = await runAsin(w2, [id(1)], { from: ASOF, to: ASOF });
  assert.equal(s2.status, "completed");
  const after2 = [...w2.store.values()].map((r) => r.dimension_key).sort();
  assert.deepEqual(after2, [JSON.stringify(["B1"])]);
  const w3 = world({ states: [...w2.states.values()], seedRows: [...w2.store.values()], verifiedPrune: {}, rowsFor: rows, now: "2026-10-05T09:00:00.000Z" });
  await runAsin(w3, [id(1)], { from: ASOF, to: ASOF });
  assert.deepEqual([...w3.store.values()].map((r) => r.dimension_key).sort(), after2, "re-running is a no-op on content");
  assert.deepEqual(w3.calls.pruneDeletes, [], "nothing stale -> no DELETE on the re-run");
});
test("F9 a single transient DELETE failure is retried once and succeeds; a non-transient (400) failure is not retried", async () => {
  const w = world({ seedRows: [staleRow(ASOF, "GONE")], verifiedPrune: { deleteError: (_d, n) => (n === 1 ? pgTimeout() : null) }, rowsFor: () => [asinRow(id(1), "IN", ASOF, "B1")] });
  assert.equal((await runAsin(w, [id(1)], { from: ASOF, to: ASOF })).status, "completed");
  assert.deepEqual(w.calls.pruneDeletes, [ASOF, ASOF]);
  const bad = Object.assign(new Error("Supabase request failed (400): bad filter"), { status: 400, code: "PGRST100" });
  const w2 = world({ seedRows: [staleRow(ASOF, "GONE")], verifiedPrune: { deleteError: () => bad }, rowsFor: () => [asinRow(id(1), "IN", ASOF, "B1")] });
  await runAsin(w2, [id(1)], { from: ASOF, to: ASOF });
  assert.deepEqual(w2.calls.pruneDeletes, [ASOF], "a 400 is not retried");
  assert.equal(w2.states.get(id(1) + "|asin-performance-v1").last_error, "ADS_ROWS_PRUNE_FAILED (stage=delete status=400 pg=PGRST100 stale=present)");
});
test("F10 an UNREADABLE probe never skips the DELETE (only a proven-clean day is skipped)", async () => {
  const w = world({ seedRows: [staleRow(ASOF, "GONE")], verifiedPrune: { probeThrows: pgTimeout() }, rowsFor: () => [asinRow(id(1), "IN", ASOF, "B1")] });
  const s = await runAsin(w, [id(1)], { from: ASOF, to: ASOF });
  assert.deepEqual(w.calls.pruneDeletes, [ASOF], "the delete still ran");
  assert.ok(![...w.store.values()].some((r) => r.dimension_key === JSON.stringify(["GONE"])));
  // The day cannot be READ back as clean, so it is not claimed complete -- but the DELETE succeeded, which is proof.
  assert.equal(s.status, "completed");
});

test("F4 stale rows of the OLDER wide grain inside the window are pruned (no mixed grain / double count); outside the window and other sources untouched", async () => {
  const wide = (d) => ({ source_key: "asin-performance-v1", account_id: id(1), marketplace_country_code: "IN", metric_date: d, dimension_key: JSON.stringify(["SKU", "C1", "G1", "AD1", "B1"]), metrics: { ad_spend: 5 }, source_refreshed_at: "2026-08-01T00:00:00.000Z" });
  const camp = { source_key: "campaign-performance-v1", account_id: id(1), marketplace_country_code: "IN", metric_date: ASOF, dimension_key: JSON.stringify(["c1", "SP"]), metrics: { ad_spend: 4 }, source_refreshed_at: "2026-08-01T00:00:00.000Z" };
  const w = world({ seedRows: [wide(ASOF), wide("2026-09-01"), camp], rowsFor: () => [asinRow(id(1), "IN", ASOF, "B1")] });
  await runAsin(w, [id(1)], { from: "2026-10-01", to: ASOF });
  const rows = [...w.store.values()];
  assert.ok(!rows.some((r) => r.source_key === "asin-performance-v1" && r.metric_date === ASOF && r.dimension_key !== JSON.stringify(["B1"])), "wide grain survived in the window");
  assert.ok(rows.some((r) => r.metric_date === "2026-09-01"), "a row outside the window was touched");
  assert.ok(rows.some((r) => r.source_key === "campaign-performance-v1"), "a Campaign row was touched");
});
test("F5 IDEMPOTENT replay: the same window twice yields the identical saved set (no duplicates)", async () => {
  const w = world({ rowsFor: ({ from, to }) => daysOf(from, to).map((d) => asinRow(id(1), "IN", d, "B1")) });
  await runAsin(w, [id(1)], { from: "2026-09-30", to: ASOF });
  const first = JSON.stringify([...w.store.keys()].sort());
  await runAsin(w, [id(1)], { from: "2026-09-30", to: ASOF });
  assert.equal(JSON.stringify([...w.store.keys()].sort()), first); assert.equal(w.store.size, 3);
});
test("F6 OWNERSHIP + marketplace + CURRENCY: a cross-account row or a foreign marketplace rejects the whole batch; currency comes from each row's marketplace", async () => {
  const w1 = world({ accounts: [{ id: id(1), country: "IN" }, { id: id(2), country: "IN" }], rowsFor: () => [asinRow(id(1), "IN", ASOF, "B1"), asinRow("someone-else", "IN", ASOF, "B2")] });
  const s1 = await runAsin(w1, [id(1), id(2)], { from: ASOF, to: ASOF });
  assert.equal(s1.status, "failed"); assert.equal(w1.store.size, 0);
  const w2 = world({ rowsFor: () => [asinRow(id(1), "US", ASOF, "B1")] });
  assert.equal((await runAsin(w2, [id(1)], { from: ASOF, to: ASOF })).status, "failed");
  const w3 = world({ accounts: [{ id: id(1), country: "IN" }, { id: id(2), country: "UK" }, { id: id(3), country: "DE" }], rowsFor: () => [asinRow(id(1), "IN", ASOF, "B1"), asinRow(id(2), "GB", ASOF, "B2"), asinRow(id(3), "DE", ASOF, "B3")] });
  assert.equal((await runAsin(w3, [id(1), id(2), id(3)], { from: ASOF, to: ASOF })).status, "completed");
  const cur = Object.fromEntries([...w3.store.values()].map((r) => [r.account_id, r.currency]));
  assert.deepEqual(cur, { [id(1)]: "INR", [id(2)]: "GBP", [id(3)]: "EUR" });
});

// ================================================ G. the region slice ================================================
const planFor = (w, region = "india", extra = {}) => R.planAsinAdsRegionRun({ region, asOf: ASOF, deps: w.deps, ...extra });
test("G1 the HARD create cap: beyond it the remaining exports are budget-deferred with ZERO worker calls / state writes", async () => {
  const accts = Array.from({ length: 11 }, (_, i) => ({ id: id(i + 1), country: "IN" }));
  const w = world({ accounts: accts, rowsFor: ({ ids, from, to }) => ids.flatMap((s) => daysOf(from, to).slice(0, 1).map((d) => asinRow(s, "IN", d, "B1"))) });
  const p = await planFor(w);
  assert.equal(p.items.length, 3);
  const r = await R.runAsinAdsRegionSlice({ region: "india", asOf: ASOF, plan: p, maxTotalCreates: 1, deps: w.deps });
  assert.equal(r.creates, 1); assert.equal(r.tokens, 2);
  assert.equal(r.covered.length, 5); assert.equal(r.budgetDeferred.length, 6); assert.equal(r.phase, "partial");
  const stateIds = new Set(w.calls.states.map((s) => s.account_id));
  for (const d of r.budgetDeferred) assert.ok(!stateIds.has(d), "a budget-deferred account got a state write");
});
test("G2 a create-time 400 on a multi-seller batch splits it; the single rejected seller is isolated (LKG), the rest covered", async () => {
  const bad = id(3);
  const accts = Array.from({ length: 5 }, (_, i) => ({ id: id(i + 1), country: "IN" }));
  const w = world({ accounts: accts, createThrows: ({ ids }) => (ids.includes(bad) ? Object.assign(new Error("DataDoe asin-performance-v1 export creation failed (400)"), { httpStatus: 400, sourceStage: "create" }) : null), rowsFor: ({ ids, to }) => ids.map((s) => asinRow(s, "IN", to, "B1")) });
  const r = await R.runAsinAdsRegionSlice({ region: "india", asOf: ASOF, plan: await planFor(w), maxTotalCreates: 20, deps: w.deps });
  assert.deepEqual(r.rejected, [bad]);
  assert.deepEqual(r.covered.sort(), [id(1), id(2), id(4), id(5)]);
  assert.equal(r.phase, "partial");
});
test("G3 a transient download failure keeps last-known-good and is reported transient (never covered)", async () => {
  const w = world({ downloadThrows: true });
  const r = await R.runAsinAdsRegionSlice({ region: "india", asOf: ASOF, plan: await planFor(w), maxTotalCreates: 5, deps: w.deps });
  assert.deepEqual(r.transient, [id(1)]); assert.equal(r.covered.length, 0); assert.equal(w.store.size, 0);
});
test("G4 completed-export REUSE: an exact-identity COMPLETED export is adopted at ZERO tokens; any identity / age / expiry difference is not", async () => {
  const w0 = world();
  const p = await planFor(w0);
  const it = p.items[0];
  const body = AS.buildAdsExportRequestBody(ASIN, it.allowlist, it.window.from, it.window.to, 0);
  const listed = (o = {}) => ({ id: "reuse-1", status: "COMPLETED", createdAt: "2026-10-03T08:00:00.000Z", expiresAt: "2026-10-04T08:00:00.000Z", ...body, from: body.from + "T00:00:00.000Z", to: body.to + "T00:00:00.000Z", ...o });
  const w = world({ listed: [listed()], rowsFor: ({ to }) => [asinRow(id(1), "IN", to, "B1")] });
  const r = await R.runAsinAdsRegionSlice({ region: "india", asOf: ASOF, plan: p, maxTotalCreates: 5, deps: w.deps });
  assert.equal(r.creates, 0); assert.equal(r.tokens, 0); assert.equal(r.reused, 1); assert.deepEqual(r.covered, [id(1)]);
  for (const bad of [{ columns: body.columns.slice(0, 3) }, { skip: 50000 }, { limit: 5000 }, { sellerOrVendorIds: [id(2)] }, { to: "2026-10-01" }, { status: "PROCESSING" }, { createdAt: "2026-10-02T00:00:00.000Z" }, { expiresAt: "2026-10-03T09:05:00.000Z" }, { aggregations: body.aggregations.slice(0, 5) }, { groupBy: ["date"] }]) {
    assert.equal(R.matchReusableExport({ exports: [listed(bad)], body, nowMs: Date.parse(NOW) }).disposition, "none", "adopted a non-identical export: " + JSON.stringify(bad).slice(0, 60));
  }
  assert.equal(R.matchReusableExport({ exports: [listed({ sellerOrVendorIds: [...body.sellerOrVendorIds].reverse(), aggregations: [...body.aggregations].reverse() })], body, nowMs: Date.parse(NOW) }).disposition, "adopt");
});
test("G4b REUSE with DataDoe's ABBREVIATED listing sourceId (10 hex chars, verified 2026-10-07) + the matching source name is adopted; a wrong name, a shorter prefix or no opt-in never matches", async () => {
  const w0 = world();
  const it = (await planFor(w0)).items[0];
  const body = AS.buildAdsExportRequestBody(ASIN, it.allowlist, it.window.from, it.window.to, 0);
  const listed = (o = {}) => ({ id: "reuse-1", status: "COMPLETED", createdAt: "2026-10-03T08:00:00.000Z", expiresAt: "2026-10-04T08:00:00.000Z", ...body, sourceId: body.sourceId.slice(0, 10), sourceName: "Ad Performance by ASIN & Date", from: body.from + "T00:00:00.000Z", to: body.to + "T00:00:00.000Z", ...o });
  const now = Date.parse(NOW);
  assert.equal(R.matchReusableExport({ exports: [listed()], body, nowMs: now, listedSourceName: R.ASIN_ADS_SOURCE_NAME }).disposition, "adopt");
  assert.equal(R.matchReusableExport({ exports: [listed()], body, nowMs: now }).disposition, "none", "no opt-in (the Returns runner) -> exact identity only, unchanged");
  assert.equal(R.matchReusableExport({ exports: [listed({ sourceName: "Ad Performance by Campaign & Date" })], body, nowMs: now, listedSourceName: R.ASIN_ADS_SOURCE_NAME }).disposition, "none");
  assert.equal(R.matchReusableExport({ exports: [listed({ sourceId: body.sourceId.slice(0, 6) })], body, nowMs: now, listedSourceName: R.ASIN_ADS_SOURCE_NAME }).disposition, "none");
  assert.equal(R.matchReusableExport({ exports: [listed({ sourceId: "ffffffffff" })], body, nowMs: now, listedSourceName: R.ASIN_ADS_SOURCE_NAME }).disposition, "none");
  assert.equal(R.matchReusableExport({ exports: [listed({ to: "2026-10-01T00:00:00.000Z" })], body, nowMs: now, listedSourceName: R.ASIN_ADS_SOURCE_NAME }).disposition, "none", "every other identity field still exact");
  // End to end: the region pass adopts it with ZERO creates.
  const w = world({ listed: [listed()], rowsFor: ({ to }) => [asinRow(id(1), "IN", to, "B1")] });
  const r = await R.runAsinAdsRegionSlice({ region: "india", asOf: ASOF, plan: await planFor(w0), maxTotalCreates: 5, deps: w.deps });
  assert.equal(r.creates, 0); assert.equal(r.reused, 1); assert.deepEqual(r.covered, [id(1)]);
});
test("G4c a prune failure is reported with its typed reason; the ADOPT-ONLY reconcile then re-persists from the SAME completed export at zero tokens and the account is covered", async () => {
  const w = world({ seedRows: [staleRow(ASOF, "GONE")], verifiedPrune: { deleteError: () => pgTimeout() }, rowsFor: ({ to }) => [asinRow(id(1), "IN", to, "B1")] });
  const r = await R.runAsinAdsRegionSlice({ region: "india", asOf: ASOF, plan: await planFor(w), maxTotalCreates: 5, deps: w.deps });
  assert.equal(r.creates, 1); assert.deepEqual(r.transient, [id(1)]);
  assert.deepEqual(r.reasons, { [id(1)]: "ADS_ROWS_PRUNE_FAILED (stage=delete status=500 pg=57014 stale=present)" });
  const entry = R.asinAdsRunStatusEntry({ region: "india", plan: { windows: R.asinAdsWindows(ASOF), compatible: [1], covered: [], unreadable: [], items: [1] }, maxCreates: 4, nowIso: NOW, outcome: r });
  assert.equal(entry.lastStatus, "partial"); assert.equal(entry.safeErrorCode, "ASIN_ADS_ACCOUNTS_ISOLATED"); assert.equal(entry.safeErrorStage, "ADS_ROWS_PRUNE_FAILED x1");
  // The created export is now listed (abbreviated sourceId, as DataDoe lists it); the DB recovered -> the reconcile adopts it.
  const made = w.calls.creates[0].body;
  const listedMade = { id: "exp-1", status: "COMPLETED", createdAt: NOW, expiresAt: "2026-10-04T09:00:00.000Z", ...made, sourceId: made.sourceId.slice(0, 10), sourceName: "Ad Performance by ASIN & Date", from: made.from + "T00:00:00.000Z", to: made.to + "T00:00:00.000Z" };
  const w2 = world({ states: [...w.states.values()], seedRows: [...w.store.values()], coverage: {}, listed: [listedMade], verifiedPrune: {}, rowsFor: ({ to }) => [asinRow(id(1), "IN", to, "B1")] });
  const rr = await R.runAsinAdsRegionSlice({ region: "india", asOf: ASOF, plan: await planFor(w2), maxTotalCreates: 0, adoptOnly: true, deps: w2.deps });
  assert.equal(rr.creates, 0); assert.equal(rr.reused, 1); assert.deepEqual(rr.covered, [id(1)]);
  assert.ok(![...w2.store.values()].some((x) => x.dimension_key === JSON.stringify(["GONE"])));
});
test("G4e an OLDER run's failed state is never reported as this pass's reason (only a state written by this pass counts)", async () => {
  const old = { account_id: id(1), source_key: "asin-performance-v1", last_status: "failed", last_error: "ADS_ROWS_PRUNE_FAILED (stage=delete status=500 pg=57014 stale=present)", updated_at: "2026-10-01T03:00:00.000Z" };
  // Adopt-only with nothing to adopt: the pass fails BEFORE the worker writes any state, so the stored state is stale.
  const w = world({ states: [old], rowsFor: ({ to }) => [asinRow(id(1), "IN", to, "B1")] });
  const r = await R.runAsinAdsRegionSlice({ region: "india", asOf: ASOF, plan: await planFor(w), maxTotalCreates: 0, adoptOnly: true, deps: w.deps });
  assert.deepEqual(r.transient, [id(1)]);
  assert.ok(!String(r.reasons[id(1)]).startsWith("ADS_ROWS_PRUNE_FAILED"), "the stale prune error is not today's reason: " + r.reasons[id(1)]);
  assert.match(String(r.reasons[id(1)]), /^SOURCE_[A-Z_]+/, "this pass's own classification is used");
});
test("G4d safe reasons: a typed slug (+ sanitized key=value detail) passes; free text never does", () => {
  assert.equal(R.safeAsinAdsReason("ADS_ROWS_PRUNE_FAILED (stage=delete status=500 pg=57014 stale=present)"), "ADS_ROWS_PRUNE_FAILED (stage=delete status=500 pg=57014 stale=present)");
  assert.equal(R.safeAsinAdsReason("INVALID_EXPORT_EVIDENCE (cross-account)"), "INVALID_EXPORT_EVIDENCE");
  assert.equal(R.safeAsinAdsReason("Supabase request failed (500): canceling statement B0SECRET"), "UNCLASSIFIED");
  assert.equal(R.safeAsinAdsReason("ADS_X (k=v; drop table)"), "ADS_X");
  assert.equal(R.summarizeAsinAdsReasons({ a: "ADS_ROWS_PRUNE_FAILED (stage=delete)", b: "BUDGET_DEFERRED", c: "ADS_ROWS_PRUNE_FAILED" }), "ADS_ROWS_PRUNE_FAILED x2; BUDGET_DEFERRED x1");
});
test("G5 ADOPT-ONLY reconcile: never creates; adopts only an exact completed export", async () => {
  const w = world({ rowsFor: ({ to }) => [asinRow(id(1), "IN", to, "B1")] });
  const r = await R.runAsinAdsRegionSlice({ region: "india", asOf: ASOF, plan: await planFor(w), maxTotalCreates: 0, adoptOnly: true, deps: w.deps });
  assert.equal(w.calls.creates.length, 0); assert.equal(r.creates, 0); assert.deepEqual(r.transient, [id(1)]);
});
test("G6 a multi-chunk account is covered ONLY when every chunk succeeded", async () => {
  let n = 0;
  const w = world({ rowCounts: { [id(1)]: 1266 * 28 }, coverage: { [id(1)]: [{ from: "2026-06-27", to: "2026-09-01" }] }, states: [{ account_id: id(1), source_key: "asin-performance-v1", last_status: "succeeded" }],
    rowsFor: ({ from, to }) => { n += 1; return n === 2 ? { status: "FAILED", rowCount: 0, rows: [] } : [asinRow(id(1), "IN", from, "B1")]; } });
  const p = await planFor(w);
  assert.equal(p.items.length, 2);
  const r = await R.runAsinAdsRegionSlice({ region: "india", asOf: ASOF, plan: p, maxTotalCreates: 5, deps: w.deps });
  assert.equal(r.covered.length, 0); assert.deepEqual(r.transient, [id(1)]);
});
test("G7 the strict assessment rejects a fragment at the row limit, a foreign grain and an oversized batch", () => {
  const ok = { status: "completed", coverageComplete: true, successfulCoveragePairs: 1, expectedCoveragePairs: 1, sources: { "asin-performance-v1": { failedAccounts: [], coverageFailedAccounts: [] } } };
  assert.equal(R.assessAsinAdsRegionCycle({ region: "india", pendingAccounts: [id(1)], batchResults: [{ accountIds: [id(1)], summary: ok }], coveredAccounts: [id(1)], fragments: [{ rowCount: 10 }] }).ok, true);
  assert.equal(R.assessAsinAdsRegionCycle({ region: "india", pendingAccounts: [id(1)], batchResults: [{ accountIds: [id(1)], summary: ok }], coveredAccounts: [id(1)], fragments: [{ rowCount: 50000 }] }).ok, false);
  assert.equal(R.assessAsinAdsRegionCycle({ region: "india", pendingAccounts: [id(1)], batchResults: [{ accountIds: [id(1)], summary: { ...ok, sources: { ...ok.sources, "campaign-performance-v1": {} } } }], coveredAccounts: [id(1)] }).ok, false);
  const six = Array.from({ length: 6 }, (_, i) => id(i + 1));
  assert.equal(R.assessAsinAdsRegionCycle({ region: "india", pendingAccounts: six, batchResults: [{ accountIds: six, summary: ok }], coveredAccounts: six }).ok, false);
});
test("G8 exposure + tokens: 2 tokens per create; a reused export costs nothing; the split allowance is bounded", async () => {
  const w = world({ accounts: Array.from({ length: 7 }, (_, i) => ({ id: id(i + 1), country: "US" })) });
  const p = await R.planAsinAdsRegionRun({ region: "us-ca", asOf: ASOF, deps: w.deps });
  const x = R.asinAdsPlanExposure(p);
  assert.deepEqual([x.normalCreates, x.expectedTokens, x.splitAllowance, x.worstCaseTokens], [2, 4, 2, 8]);
});

// ================================================ H. parity + wiring ================================================
test("H1 scheduler / manual PARITY: the CLI and the Data Sync Center card drive the SAME runner functions", () => {
  const cli = readFileSync(path.join(ROOT, "scripts/release/scheduled-asin-ads-refresh.mjs"), "utf8");
  assert.match(cli, /R\.planAsinAdsRegionRun\(/); assert.match(cli, /R\.runAsinAdsRegionSlice\(/);
  const runner = readFileSync(path.join(ROOT, "lib/server/sync/scheduled-asin-ads-runner.js"), "utf8");
  const bucketFn = runner.slice(runner.indexOf("export async function runAsinAdsBucketSlice"));
  assert.match(bucketFn, /planAsinAdsRegionRun\(/); assert.match(bucketFn, /runAsinAdsRegionSlice\(/);
  const dsc = readFileSync(path.join(ROOT, "api/admin/sources.js"), "utf8");
  if (!dsc.includes("verifyPaidSyncConfirmation(")) {
    // A code line WITHOUT the WP10b paid-sync contract (the scheduler-only GitHub lineage) has NO admin ASIN create path at
    // all: the Data Sync Center POST never reaches the runner (the bucket runtime refuses every durable-ads family).
    assert.ok(!dsc.includes("runAsinAdsBucketSlice"), "no unconfirmed admin ASIN create path");
    return;
  }
  assert.match(dsc, /runAsinAdsBucketSlice\(\{/);
  // the DSC branch is behind the admin gate (assertAdmin at the top of the handler) and the paid confirmation
  assert.ok(dsc.indexOf("deps.assertAdmin(access)") < dsc.indexOf("if (onlySourceKey === ASIN_ADS_SOURCE_KEY) {"));
  assert.ok(dsc.indexOf("verifyPaidSyncConfirmation(") < dsc.indexOf("if (onlySourceKey === ASIN_ADS_SOURCE_KEY) {"));
});
test("H2 ONE scheduler owner, NO new cron: the asin_ads job is a dependent job of the per-region scheduler-v2 run with hard per-region caps", () => {
  const wf = readFileSync(path.join(ROOT, "../.github/workflows/scheduler-v2.yml"), "utf8");
  assert.ok(!/^\s*schedule:/m.test(wf), "scheduler-v2 gained a native cron");
  const job = wf.slice(wf.indexOf("\n  asin_ads:"), wf.indexOf("\n  listing-health-v3:"));
  assert.match(job, /needs: \[run, fba\]/);
  assert.match(job, /needs\.run\.outputs\.execute_downstream == 'true'/); assert.match(job, /needs\.run\.outputs\.token_proceed == 'true'/); assert.match(job, /needs\.run\.outputs\.scope != 'bootstrap'/);
  assert.match(job, /continue-on-error: true/);
  assert.match(job, /india\) CAP=4 ;;/); assert.match(job, /europe-au\) CAP=10 ;;/); assert.match(job, /us-ca\) CAP=5 ;;/);
  assert.match(job, /scheduled-asin-ads-refresh\.mjs --bucket=\$\{\{ needs\.run\.outputs\.region \}\} --as-of=\$\{\{ needs\.run\.outputs\.asof \}\} --scheduled --max-creates=\$CAP/);
  assert.ok(!/DATADOE_API_KEY_SECONDARY/.test(job), "the ASIN job must not receive the secondary organization key");
  // nothing in the run job (publication path) waits on ASIN
  const runJob = wf.slice(wf.indexOf("\n  run:"), wf.indexOf("\n  fba:"));
  assert.ok(!/scheduled-asin-ads-refresh/.test(runJob));
  assert.ok(!/needs\.asin_ads/.test(wf));
});
test("H2b PARTIAL is VISIBLE and never retried: exit 3 + a ::warning annotation naming each account's typed reason; systemic exit 1 + ::error; the step summary lists the reasons", () => {
  const cli = readFileSync(path.join(ROOT, "scripts/release/scheduled-asin-ads-refresh.mjs"), "utf8");
  assert.match(cli, /process\.exit\(systemic \? 1 : \(out\.classification === "PARTIAL" \? 3 : 0\)\);/);
  assert.match(cli, /annotate\("warning", "ASIN Ads PARTIAL \(" \+ label \+ "\)"/);
  assert.match(cli, /annotate\("error", "ASIN Ads FAILED \(" \+ label \+ "\)"/);
  assert.match(cli, /kept last-known-good \(no automatic paid retry; the next scheduled run retries\)/);
  assert.match(cli, /reasons: Object\.fromEntries\(isolatedIds\.map\(\(id\) => \[p8\(id\), reasonOf\(id\)\]\)\)/, "RESULT carries 8-char ids + typed reasons only");
  // The adopt-only reconcile stays zero-create; nothing in the CLI re-creates after a failure.
  assert.match(cli, /maxTotalCreates: 0, adoptOnly: true/);
});
test("H3 the scheduled CLI is OFF unless source_controls.schedule_enabled; the pause stops every paid path; an operator run needs --confirm-paid + --max-creates", () => {
  const cli = readFileSync(path.join(ROOT, "scripts/release/scheduled-asin-ads-refresh.mjs"), "utf8");
  assert.match(cli, /if \(scheduled && !\(ctl && ctl\.schedule_enabled === true\)\)/);
  assert.match(cli, /if \(ctl && ctl\.paused === true\)/);
  assert.match(cli, /requires --confirm-paid/); assert.match(cli, /--max-creates=N \(a non-negative integer\) is REQUIRED/);
  assert.match(cli, /balance - worstTokens < reserveTokens/);
  assert.deepEqual([...SSO.OPERATOR_SWITCHED_SOURCE_KEYS], ["ads-asin-date", "returns"]);
  assert.ok(!SSO.scheduledSourceControlPlan(["ads-asin-date", "order-line-items"]).some((p) => p.sourceKey === "ads-asin-date"), "the config sweep would overwrite the ASIN switch");
});
test("H4 the bucket slice refuses a plan above the approval with ZERO creates", async () => {
  const w = world({ accounts: Array.from({ length: 6 }, (_, i) => ({ id: id(i + 1), country: "US" })) });
  const r = await R.runAsinAdsBucketSlice({ bucket: "us", asOf: ASOF, maxTotalCreates: 1, deps: w.deps });
  assert.equal(r.refused, true); assert.equal(r.code, "ASIN_ADS_APPROVAL_EXCEEDED"); assert.equal(w.calls.creates.length, 0);
});
test("H5 the scheduled family is declared (own owner, capped per region, visibly partial) and the guard passes", () => {
  const f = FAM.SCHEDULED_FAMILY_REGISTRY["asin-performance"];
  assert.equal(f.schedulerOwner, "scheduler-v2:asin-ads"); assert.equal(f.ceiling, "capped-per-region"); assert.equal(f.partialBehavior, "stay-visibly-partial");
  assert.deepEqual(FAM.validateScheduledFamilyRegistry(), { ok: true, problems: [] });
});

// ================================================ I. status ================================================
test("I1 the region status row: succeeded only when every compatible account is covered; partial / failed otherwise; spend vs ceiling", () => {
  const plan = { windows: R.asinAdsWindows(ASOF), compatible: [1, 2, 3], covered: [{}], unreadable: [], items: [1, 2] };
  const ok = R.asinAdsRunStatusEntry({ region: "india", plan, maxCreates: 4, nowIso: NOW, outcome: { creates: 2, covered: [1, 2] } });
  assert.equal(ok.lastStatus, "succeeded"); assert.equal(ok.lastSuccessAt, NOW); assert.equal(ok.coveredTo, ASOF); assert.equal(ok.tokensSpent, 4); assert.equal(ok.tokensCeiling, 8); assert.equal(ok.bucket, "india");
  const part = R.asinAdsRunStatusEntry({ region: "india", plan, maxCreates: 4, nowIso: NOW, outcome: { creates: 1, covered: [1], transient: [2] } });
  assert.equal(part.lastStatus, "partial"); assert.equal(part.lastSuccessAt, undefined); assert.equal(part.coveredTo, null); assert.equal(part.accountsFailed, 1);
  assert.equal(R.asinAdsRunStatusEntry({ region: "india", plan, nowIso: NOW, outcome: { systemic: true } }).lastStatus, "failed");
});
test("I2 the Data Sync Center card renders ASIN in both buckets and FOLDS its region rows (worst status, summed spend, earliest coverage)", () => {
  const rows = [
    { source_key: "ads-asin-date", bucket: "india", last_status: "succeeded", last_attempt_at: "2026-10-03T03:30:00Z", last_success_at: "2026-10-03T03:30:00Z", covered_from: "2026-09-12", covered_to: ASOF, accounts_completed: 6, accounts_total: 6, creates_spent: 2, tokens_spent: 4, creates_ceiling: 4, tokens_ceiling: 8 },
    { source_key: "ads-asin-date", bucket: "europe-au", last_status: "partial", last_attempt_at: "2026-10-03T09:00:00Z", accounts_completed: 30, accounts_failed: 2, accounts_total: 32, creates_spent: 7, tokens_spent: 14, creates_ceiling: 10, tokens_ceiling: 20 },
  ];
  const cards = ST.shapeSourceCards({ bucket: "non-us", controls: [{ source_key: "ads-asin-date", paused: false, schedule_enabled: true }], runStatuses: rows });
  const card = cards.find((c) => c.sourceKey === "ads-asin-date");
  assert.ok(card, "ASIN card hidden");
  assert.equal(card.status.lastStatus, "partial"); assert.equal(card.status.tokensSpent, 18); assert.equal(card.status.tokensCeiling, 28);
  assert.equal(card.status.coveredTo, null); assert.equal(card.status.lastAttemptAt, "2026-10-03T09:00:00Z");
  assert.ok(ST.shapeSourceCards({ bucket: "us", controls: [], runStatuses: [] }).some((c) => c.sourceKey === "ads-asin-date"));
});

// ================================================ J. Campaign non-regression ================================================
test("J1 Campaign keeps its skip pagination on a full page (no date bisection, no delete/prune)", async () => {
  const w = world({ accounts: [{ id: id(1), country: "IN" }], rowsFor: ({ skip }) => (skip === 0
    ? fullPage(Array.from({ length: 50000 }, (_, i) => ({ seller_or_vendor_id: id(1), marketplace_country_code: "IN", date: ASOF, ad_campaign_id: "c" + i, ad_campaign_type: "SP" })))
    : [{ seller_or_vendor_id: id(1), marketplace_country_code: "IN", date: ASOF, ad_campaign_id: "z", ad_campaign_type: "SP" }]) });
  const s = await AS.runAdsSyncWithDeps({ ...w.workerDeps, createExport: w.deps.createExport }, ["IN"], ["campaign-performance-v1"], { accountIds: [id(1)], requiredCoverage: { from: ASOF, to: ASOF } });
  assert.equal(s.status, "completed");
  assert.deepEqual(w.calls.creates.map((c) => c.skip), [0, 50000]);
  assert.equal(w.calls.prunes.length, 0); assert.equal(w.calls.deletes.length, 0);
  assert.equal(CAMP.fullPagePolicy, undefined);
});
test("J2 the shared recovery engine's defaults are byte-identical for Campaign (Campaign grain + CAMPAIGN_ADS_CEILING)", async () => {
  const r = await C.runCampaignAdsBatchesWithRecovery({ batches: [{ allowlist: ["x"] }, { allowlist: ["y"] }], runOne: async (ids) => { if (ids[0] === "x") { const e = new Error("cap"); e.code = "CAMPAIGN_ADS_CEILING"; throw e; } return { status: "completed", sources: { "campaign-performance-v1": { failedAccounts: [] } } }; } });
  assert.equal(r.ceilingExhausted, true); assert.deepEqual(r.budgetDeferred, ["x", "y"]);
  const r2 = await C.runCampaignAdsBatchesWithRecovery({ batches: [{ allowlist: ["x"] }], runOne: async () => ({ status: "completed", sources: { "campaign-performance-v1": { failedAccounts: ["x"] } } }) });
  assert.deepEqual(r2.transient, ["x"]);
});
test("J3 every dashboard/report keeps reading Campaign: readiness degrades on ads-campaign-date only; ASIN is in no report's requirements", async () => {
  assert.deepEqual([...ST.PRIORITY_DASHBOARD_SOURCES["daily-reporting"].degrading], ["ads-campaign-date"]);
  assert.deepEqual([...ST.PRIORITY_DASHBOARD_SOURCES["brand-view"].degrading], ["ads-campaign-date", "fba-inventory-health"]);
  const { sourceRegistryEntry } = await import("../lib/server/sync/source-registry.js");
  const e = sourceRegistryEntry("ads-asin-date");
  assert.deepEqual([...e.usedByReports], []); assert.deepEqual([...e.usedByDashboards], []);
  const dep = await import("../lib/server/sync/ads-dependent-reports.js");
  assert.ok(!Object.values(dep.ADS_LINEAGE_DEPENDS_ON).flat().includes("ads-asin-date"));
});
test("J4 the coverage evaluator used by every Ads read is unchanged (a window with an interior gap is never proven)", () => {
  assert.equal(evaluateSourceCoverage(covOk([{ from: "2026-09-01", to: "2026-09-10" }, { from: "2026-09-12", to: ASOF }]), "2026-09-01", ASOF).proven, false);
});

(async () => {
  for (const t of tests) {
    try { await t.fn(); passed += 1; out("ok - " + t.name); }
    catch (e) { out("not ok - " + t.name + "\n  " + String(e && e.stack ? e.stack : e).split("\n").slice(0, 6).join("\n  ")); process.exitCode = 1; }
  }
  out("\nasin-ads-source: " + passed + "/" + tests.length + " passed");
  if (passed !== tests.length) process.exitCode = 1;
})();
