// Deterministic tests for the scheduled-sync foundation. No network: pure
// functions, injected persistence, and a fetch stub that emulates the lock RPC.
//
// Run with: npm run test:sync
//
// Intentionally imports ONLY light modules — never api/datadoe.js — so the suite
// stays free of the DataDoe/report module graph.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// supabase.js reads config at module load; give it obvious fakes. The fetch stub
// below is installed only for the lock test and never lets a real request out.
process.env.SUPABASE_URL = "https://sync-test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.DATADOE_API_KEY = "test-primary-key";

const {
  bucketForCountry, countriesForBucket, SCHEDULE_UTC, SCHEDULE_CRON,
  ADS_SOURCE_KEYS, SYNC_REGISTRY, registryReportKeys, entriesForBucket, orderedWork,
  addDaysStr, monthStartStr,
} = await import("../lib/server/sync/registry.js");
const { shapeSyncStatus } = await import("../lib/server/sync/status.js");
const { runReportAdapter } = await import("../lib/server/sync/adapters/report-adapter.js");
const { isAdsExportRetiredFor } = await import("../lib/server/active-ads-source.js");
const { expandSyncWork, targetDisposition, MAX_TARGET_ATTEMPTS } = await import("../lib/server/sync/planner.js");
const { publicAccountId, resolveDataDoeAccountIds } = await import("../lib/server/datadoe-connections.js");
const { ADS_SOURCES } = await import("../lib/server/ads-sync.js");
const { isDataDoeDeadlineError, sleep, withDataDoeDeadline } = await import("../lib/server/datadoe.js");
const { claimRefreshLock, releaseRefreshLock } = await import("../lib/server/supabase.js");

let passed = 0;
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") throw new Error("use asyncTest for an async case");
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}
async function asyncTest(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

/* 1. Bucket classification — metadata-driven, unknown never mis-bucketed. */
test("US marketplace is the us bucket; every other country is non-us", () => {
  assert.equal(bucketForCountry("US"), "us");
  assert.equal(bucketForCountry("us"), "us");
  for (const c of ["CA", "AU", "IN", "GB", "DE", "FR", "IT", "ES", "NL", "PL", "SE", "TR"]) {
    assert.equal(bucketForCountry(c), "non-us", `${c} should be non-us`);
  }
});
test("empty/unknown country is 'unknown' (flagged + skipped, never us/non-us)", () => {
  assert.equal(bucketForCountry(""), "unknown");
  assert.equal(bucketForCountry("   "), "unknown");
  assert.equal(bucketForCountry(undefined), "unknown");
  assert.equal(bucketForCountry(null), "unknown");
});

/* 2. Desired schedule constants + temporary production pause. */
test("schedule constants are 02:00 (non-us) and 10:30 (us) UTC", () => {
  assert.equal(SCHEDULE_UTC["non-us"], "02:00");
  assert.equal(SCHEDULE_UTC.us, "10:30");
  assert.equal(SCHEDULE_CRON["non-us"], "0 2 * * *");
  assert.equal(SCHEDULE_CRON.us, "30 10 * * *");
});
test("automatic timing: GitHub Actions scheduler-v2 is the SINGLE scheduler (exact reviewed crons); Vercel runs no cron", () => {
  const vercel = JSON.parse(readFileSync(fileURLToPath(new URL("../vercel.json", import.meta.url)), "utf8"));
  assert.equal((vercel.crons || []).length, 0, "Vercel must not invoke DataDoe automatically");
  const workflow = readFileSync(fileURLToPath(new URL("../../.github/workflows/scheduler-v2.yml", import.meta.url)), "utf8");
  // Cron is ACTIVE + REGIONAL: india 03:07 + europe-au 08:37 + us-ca 16:37 UTC (off the congested :00/:30
  // boundaries), one GitHub primary per region. Two independent recovery mechanisms re-dispatch a missed cron: a
  // Cloudflare */10 global poller (20m grace, 3h window) and the GitHub-native scheduler-recovery.yml (3 crons/day,
  // one per region at primary+40m); the exact-live duplicate guard makes repeats no-ops.
  const crons = [...workflow.matchAll(/- cron:\s*"([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(crons, ["7 3 * * *", "37 16 * * *", "37 8 * * *"].sort(), "the three regional primaries (india / europe-au / us-ca)");
  assert.match(workflow, /^\s*workflow_dispatch\s*:/m, "manual dispatch remains available");
  assert.match(workflow, /^run-name:\s*scheduler-v2 .*inputs\.dispatch_id/m, "external coordinator runs are identifiable by dispatch_id");
  assert.match(workflow, /^\s{6}dispatch_id:\s*$/m, "workflow_dispatch accepts the coordinator dispatch_id");
});

/* 3. Registry coverage of every existing report key + ads sources. */
test("registry covers every existing DataDoe report key + the 4 ads sources", () => {
  const keys = new Set(registryReportKeys());
  const expected = [
    "brand-sales", "daily-reporting", "reconciliation", "sku-pl", "keyword-rank",
    "content-changes", "fba-plan", "sales-movers", "listing-health", "buy-box-loss",
    "returns-leakage", "ppc-performance", "listing-optimizer",
    ...ADS_SOURCE_KEYS.map((k) => `ads:${k}`),
  ];
  for (const k of expected) assert.ok(keys.has(k), `registry missing ${k}`);
});
test("only NON-RETIRED ads + brand-sales are enabled; the retired ASIN ads grain is DISABLED (ASIN->Campaign cutover)", () => {
  const enabled = SYNC_REGISTRY.filter((e) => e.enabled).map((e) => e.reportKey).sort();
  // The retired ASIN ads grain (asin-performance-v1 while Campaign is active) is disabled at the Scheduler-v1
  // wiring level, so run-sync never even attempts it -- a clean retirement, not just a guard-caught failure.
  const expected = ["brand-sales", ...ADS_SOURCE_KEYS.filter((k) => !isAdsExportRetiredFor(k)).map((k) => `ads:${k}`)].sort();
  assert.deepEqual(enabled, expected);
  const byKey = new Map(SYNC_REGISTRY.map((e) => [e.reportKey, e]));
  assert.equal(byKey.get("ads:asin-performance-v1").enabled, false, "retired ASIN ads grain must be disabled");
  assert.equal(byKey.get("ads:campaign-performance-v1").enabled, true, "active Campaign ads grain stays enabled");
  assert.equal(byKey.get("brand-sales").reportVersion, "brand-sales-shared-v1");
  assert.equal(byKey.get("sales-movers").reportVersion, "sales-movers-v1");
  assert.equal(byKey.get("sales-movers").enabled, false);
  assert.equal(byKey.get("fba-plan").enabled, false);
});
test("orderedWork runs ads sources before per-account reports", () => {
  const ordered = orderedWork(entriesForBucket("us"));
  const firstReportIdx = ordered.findIndex((e) => e.domain !== "ads");
  const lastAdsIdx = ordered.map((e) => e.domain).lastIndexOf("ads");
  assert.ok(lastAdsIdx < firstReportIdx, "all ads entries must precede report entries");
});

/* 4. Secondary-org namespacing + cross-org blocking in the sync path. */
const CONNS = [
  { id: "primary", apiKey: "k-primary", accountPrefix: "" },
  { id: "secondary", apiKey: "k-secondary", accountPrefix: "dd-secondary:" },
];
test("publicAccountId namespaces secondary ids and leaves primary untouched", () => {
  assert.equal(publicAccountId(CONNS[0], "123"), "123");
  assert.equal(publicAccountId(CONNS[1], "123"), "dd-secondary:123");
});
test("resolveDataDoeAccountIds routes to the right connection and blocks cross-org", () => {
  assert.equal(resolveDataDoeAccountIds(["123"], CONNS).connection.id, "primary");
  assert.equal(resolveDataDoeAccountIds(["dd-secondary:123"], CONNS).connection.id, "secondary");
  assert.throws(() => resolveDataDoeAccountIds(["123", "dd-secondary:123"], CONNS), /one DataDoe connection|Cross-organisation/i);
});

/* 5. countriesForBucket + the DataDoe batch-size <= 5 rule. */
test("countriesForBucket maps us to ['US'] and non-us to the managed set + OTHER", () => {
  assert.deepEqual(countriesForBucket("us"), { groups: [["US"]] });
  const nonUs = countriesForBucket("non-us");
  assert.deepEqual(nonUs.groups[0], ["IN", "CA", "AU"]);
  assert.equal(nonUs.groups[1], "OTHER");
});
test("every ads source batches seller/vendor ids in groups of <= 5", () => {
  for (const s of ADS_SOURCES) assert.ok(s.batchSize <= 5, `${s.key} batchSize ${s.batchSize} > 5`);
});
test("non-US Ads work is split into separately bounded managed and OTHER targets", () => {
  const adsEntry = SYNC_REGISTRY.find((entry) => entry.reportKey === "ads:campaign-performance-v1");
  const work = expandSyncWork([adsEntry], [], "non-us");
  assert.equal(work.length, 2);
  assert.deepEqual(work.map((item) => item.scope.countries), [["IN", "CA", "AU"], "OTHER"]);
  assert.equal(new Set(work.map((item) => item.targetAccountId)).size, 2);
});
test("a completed target is skipped only for the same cycle and failures stop after three attempts", () => {
  assert.equal(targetDisposition({ cycle_date: "2026-08-04", last_status: "succeeded", attempts: 1 }, "2026-08-04").status, "complete");
  assert.equal(targetDisposition({ cycle_date: "2026-08-04", last_status: "succeeded", attempts: 1 }, "2026-08-05").status, "due");
  assert.equal(targetDisposition({ cycle_date: "2026-08-04", last_status: "failed", attempts: MAX_TARGET_ATTEMPTS }, "2026-08-04").status, "terminal-failure");
  assert.equal(targetDisposition({ cycle_date: "2026-08-04", last_status: "deferred", attempts: 20 }, "2026-08-04").status, "due");
});
await asyncTest("scheduled DataDoe sleeps defer before the server deadline", async () => {
  await assert.rejects(
    () => withDataDoeDeadline(Date.now() + 25, () => sleep(100)),
    (error) => isDataDoeDeadlineError(error),
  );
});

/* 6. Lock acquire/release + concurrent-blocked (emulated claim RPC). */
await asyncTest("bucket lock grants once, blocks while held, and re-grants after release", async () => {
  const realFetch = global.fetch;
  const lockTable = new Map();
  const resp = (value, status = 200) => ({ ok: status < 400, status, json: async () => value });
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("/rpc/claim_report_refresh_lock")) {
      const b = JSON.parse(opts.body);
      const key = `${b.p_report_key}|${b.p_account_id}|${b.p_params_hash}`;
      const until = lockTable.get(key);
      if (until && until > Date.now()) return resp(false);
      lockTable.set(key, Date.now() + b.p_lock_seconds * 1000);
      return resp(true);
    }
    if (u.includes("/report_refresh_locks") && opts.method === "DELETE") {
      const q = new URL(u).searchParams;
      const key = `${q.get("report_key").slice(3)}|${q.get("account_id").slice(3)}|${q.get("params_hash").slice(3)}`;
      lockTable.delete(key);
      return resp(null, 204);
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  try {
    const lock = { reportKey: "scheduled-sync", accountId: "bucket:us", paramsHash: "v1", lockSeconds: 90 };
    assert.equal(await claimRefreshLock(lock), true, "first claim should grant");
    assert.equal(await claimRefreshLock(lock), false, "second claim should be blocked while held");
    await releaseRefreshLock({ reportKey: lock.reportKey, accountId: lock.accountId, paramsHash: lock.paramsHash });
    assert.equal(await claimRefreshLock(lock), true, "claim should grant again after release");
  } finally {
    global.fetch = realFetch;
  }
});

/* 7. Last-known-good: a failed build never overwrites a good snapshot. */
await asyncTest("adapter build failure does NOT call saveReportSnapshot (last-known-good preserved)", async () => {
  const entry = {
    reportKey: "sales-movers", reportVersion: "sales-movers-v1",
    windowFor: () => ({ to: "2026-08-04" }), validate: () => true,
  };
  let saveCalls = 0;
  await assert.rejects(
    () => runReportAdapter({
      entry,
      account: { account_id: "123", country: "US" },
      asOf: "2026-08-04",
      connections: CONNS,
      build: async () => { throw new Error("DataDoe export failed"); },
      save: async () => { saveCalls += 1; return { id: "x" }; },
      publish: async () => {},
    }),
    /DataDoe export failed/,
  );
  assert.equal(saveCalls, 0, "saveReportSnapshot must not run when the build throws");
});
await asyncTest("adapter blocks the save when validation fails", async () => {
  const entry = {
    reportKey: "brand-sales", reportVersion: "brand-sales-shared-v1",
    windowFor: () => ({ from: "2026-01-01", to: "2026-08-04" }),
    validate: (p) => (Array.isArray(p?.rows) ? true : "no rows[]"),
  };
  let saveCalls = 0;
  await assert.rejects(
    () => runReportAdapter({
      entry, account: { account_id: "123", country: "US" }, asOf: "2026-08-04", connections: CONNS,
      build: async () => ({ notRows: true }),
      save: async () => { saveCalls += 1; return { id: "x" }; },
      publish: async () => {},
    }),
    /validation failed/,
  );
  assert.equal(saveCalls, 0);
});
await asyncTest("successful scheduled snapshots are marked, pruned and report their actual latest row date", async () => {
  const entry = {
    reportKey: "brand-sales", reportVersion: "brand-sales-shared-v1",
    windowFor: () => ({ from: "2025-06-01", to: "2026-08-04" }), validate: () => true,
  };
  let savedInput;
  let prunedInput;
  const result = await runReportAdapter({
    entry, account: { account_id: "123", country: "US" }, asOf: "2026-08-04", connections: CONNS,
    build: async () => ({ rows: [{ date: "2026-08-01" }, { date: "2026-08-03" }] }),
    save: async (input) => { savedInput = input; return { id: "snapshot-1", source_refreshed_at: "2026-08-04T10:00:00Z" }; },
    prune: async (input) => { prunedInput = input; },
    publish: async () => {},
  });
  assert.equal(savedInput.params.syncManaged, true);
  assert.deepEqual(prunedInput, { reportKey: "brand-sales", accountId: "123", keepParamsHash: savedInput.paramsHash });
  assert.equal(result.latestDataDate, "2026-08-03");
});

/* 8. Ads rolling-correction upsert dedups by natural key (no double-count). */
test("two ads rows with the same natural key dedup to one (latest value wins)", () => {
  const naturalKey = (r) => [r.source_key, r.account_id, r.marketplace_country_code, r.metric_date, r.dimension_key].join("");
  const base = { source_key: "campaign-performance-v1", account_id: "123", marketplace_country_code: "US", metric_date: "2026-08-01", dimension_key: "[\"c1\",\"SP\"]" };
  const rows = [{ ...base, spend: 10 }, { ...base, spend: 12 }]; // late attribution correction
  const merged = new Map();
  for (const r of rows) merged.set(naturalKey(r), r); // mirrors on_conflict merge-duplicates
  assert.equal(merged.size, 1);
  assert.equal(merged.get(naturalKey(base)).spend, 12);
});

/* 9. Authorization isolation: a non-admin only ever sees their own accounts. */
test("non-admin sync status is strictly scoped to the caller's accounts", () => {
  const directory = [
    { account_id: "A", name: "Acct A", sync_bucket: "us" },
    { account_id: "B", name: "Acct B", sync_bucket: "non-us" },
  ];
  const targets = [
    { account_id: "A", report_key: "brand-sales", last_status: "succeeded" },
    { account_id: "B", report_key: "brand-sales", last_status: "succeeded" },
  ];
  const snaps = [
    { account_id: "A", report_key: "brand-sales", updated_at: "2026-08-04T00:00:00Z", source_refreshed_at: "2026-08-04T00:00:00Z" },
    { account_id: "B", report_key: "brand-sales", updated_at: "2026-08-04T00:00:00Z", source_refreshed_at: "2026-08-04T00:00:00Z" },
  ];
  const out = shapeSyncStatus({
    isAdmin: false, scopeAccountIds: ["A"], reportKeys: ["brand-sales"],
    labels: { "brand-sales": "Dashboard" }, directory, targets, snaps,
  });
  assert.deepEqual(out.accounts.map((a) => a.accountId), ["A"]);
  assert.equal(out.accounts[0].reports[0].lastStatus, "succeeded");
});
test("admin sync status spans all directory accounts", () => {
  const out = shapeSyncStatus({
    isAdmin: true, scopeAccountIds: [], reportKeys: ["brand-sales"], labels: {},
    directory: [{ account_id: "A" }, { account_id: "B" }], targets: [], snaps: [],
  });
  assert.deepEqual(out.accounts.map((a) => a.accountId).sort(), ["A", "B"]);
});

/* Date helpers used by windowFor. */
test("registry date helpers are pure UTC", () => {
  assert.equal(monthStartStr("2026-08-04"), "2026-08-01");
  assert.equal(addDaysStr("2026-08-01", -1), "2026-07-31");
  assert.equal(addDaysStr("2026-03-01", -1), "2026-02-28");
});

console.log(`\n${passed} assertions passed`);
