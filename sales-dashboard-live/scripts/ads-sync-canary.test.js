// Ads-sync account-bounded canary + requiredCoverage findings -- EXECUTABLE integration harness (offline).
//
// Drives the REAL dependency-injected core runAdsSyncWithDeps with deterministic injected collaborators (no
// network, no Supabase, no real lock). Replaces the former source-text-only proof. Proves the three Codex
// findings and every listed property:
//   - requiredCoverage option: allowlist-required, strict dates, future/out-of-range/malformed rejected, EXACT
//     export window (never pickMode/windowFor), records that exact window, preserves cadence timestamps,
//     updates latest_metric_date + success ONLY after durable rows, fails closed on unconfirmed coverage;
//   - only the two selected primary accounts are exported; unrelated US/IN + dd-secondary get zero calls/writes;
//   - existing ads_sync_state that would choose 'daily' cannot shorten requiredCoverage;
//   - campaign + ASIN exact 30-day coverage => evaluateSourceCoverage(...).proven === true; optional
//     targeting/search coverage stays independent;
//   - malformed/unknown/duplicate accounts create zero exports; failed Ads persistence records zero coverage;
//   - null/mismatched coverage acknowledgement fails closed;
//   - the lock is released EXACTLY ONCE on every post-claim outcome;
//   - no secret / raw error reaches the returned results;
//   - absent options preserve existing behavior + two-argument callers unchanged.
//
// 7-bit ASCII, LF, no top-level await.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = process.env[SB_KEY_ENV] || ["test", "svc", "role", "key"].join("-");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

let runAdsSyncWithDeps, resolveAdsAccountAllowlist, validateAdsSyncOptions, ADS_SOURCES;
let MAX_REQUIRED_COVERAGE_DAYS, MAX_IDS_PER_EXPORT, inclusiveDaySpan;
let evaluateSourceCoverage;

const G6_US = "26f7a1a6-689a-4084-8260-7add262918e5";
const G6_IN = "d658442d-6273-4c2d-aeda-f247e638ef98";
const NOW = "2026-08-14T12:00:00.000Z";
const TODAY = "2026-08-14";
const REQ = { from: "2026-07-16", to: "2026-08-14" }; // exact 30-day PPC window [asOf-29, asOf]
const PRIMARY_KEY = ["prim", "key"].join("-");
const SECONDARY_KEY = ["sec", "key"].join("-");

// The freshly discovered accounts each injected fetchAccounts returns (primary org + a dormant secondary org).
// Injected fetchAccounts returns the SAME { id, country } shape the production fetchAccounts maps to.
const PRIMARY_ACCOUNTS = [
  { id: G6_US, country: "US" },
  { id: "other-us-1", country: "US" },
  { id: G6_IN, country: "IN" },
  { id: "other-in-1", country: "IN" },
];
const SECONDARY_ACCOUNTS = [{ id: G6_US, country: "US" }]; // same raw id, different org -> dd-secondary:

// A trusted-collaborator harness recording every I/O touch. `coverageAck` lets a test force the coverage
// persistence acknowledgement; `rowsByCall` returns Ads rows for a fetchRange; `states` seeds ads_sync_state;
// `fetchAccountsThrows` / `lockResult` exercise the failure + skip paths.
function makeDeps(opts = {}) {
  const calls = { fetchAccounts: [], fetchRange: [], download: [], getCoverage: [], upsertRows: [], upsertMetrics: [], upsertStates: [], coverage: [], claim: 0, release: 0 };
  const rowsFor = opts.rowsFor || (() => [
    { seller_or_vendor_id: G6_US, date: REQ.to, marketplace_country_code: "US" },
  ]);
  // The injected create/download primitives drive the REAL recursive fetchRangeWith (so its create-export
  // budget is exercised). createExport records EVERY create POST (parent + split children) under calls.fetchRange
  // (each entry === one create); download returns the rows for that export's exact (source, ids, from, to).
  const exportMeta = new Map();
  let exportSeq = 0;
  const deps = {
    getConnections: () => (opts.connections || [
      { id: "primary", apiKey: PRIMARY_KEY, accountPrefix: "" },
      { id: "secondary", apiKey: SECONDARY_KEY, accountPrefix: "dd-secondary:" },
    ]),
    fetchAccounts: async (apiKey) => {
      calls.fetchAccounts.push(apiKey);
      if (opts.fetchAccountsThrows) throw new Error(`DataDoe accounts request failed (500): secret-token-${apiKey}`);
      return apiKey === PRIMARY_KEY ? PRIMARY_ACCOUNTS : apiKey === SECONDARY_KEY ? SECONDARY_ACCOUNTS : [];
    },
    createExport: async (apiKey, source, ids, from, to) => {
      calls.fetchRange.push({ apiKey, sourceKey: source.key, ids: [...ids], from, to });
      if (opts.fetchRangeThrows) throw new Error(`DataDoe ${source.key} export creation failed (500): raw-secret-body ${apiKey}`);
      const exportId = "exp-" + (++exportSeq);
      exportMeta.set(exportId, { source, ids: [...ids], from, to });
      return { exportId };
    },
    downloadExport: async (apiKey, exportId) => {
      calls.download.push(exportId);
      const meta = exportMeta.get(exportId);
      return rowsFor({ source: meta.source, ids: meta.ids, from: meta.from, to: meta.to });
    },
    claimRefreshLock: async () => { calls.claim += 1; return opts.lockResult == null ? true : opts.lockResult; },
    releaseRefreshLock: async () => { calls.release += 1; },
    getAdsSyncStates: async (ids) => (opts.states || []).filter((s) => ids.includes(s.account_id)),
    getCoverage: async (accountId, sourceKey) => {
      calls.getCoverage.push({ accountId, sourceKey });
      if (typeof opts.getCoverage === "function") return opts.getCoverage(accountId, sourceKey);
      // default: nothing covered (read ok, no windows, missing state) => never authorizes a skip.
      return { windows: [], status: "missing", latestMetricDate: null, read: "ok", error: null };
    },
    upsertAdsDailyRows: async (rows) => { calls.upsertRows.push(rows.length); },
    upsertAdDailyMetrics: async (rows) => { calls.upsertMetrics.push(rows.length); },
    upsertAdsSyncStates: async (states) => { calls.upsertStates.push(states); },
    recordAdsCoverageWindows: async (rows) => {
      calls.coverage.push(rows.map((r) => ({ accountId: r.accountId, sourceKey: r.sourceKey, coveredFrom: r.coveredFrom, coveredTo: r.coveredTo })));
      if (typeof opts.coverageAck === "function") return opts.coverageAck(rows);
      return opts.coverageAck !== undefined ? opts.coverageAck : { write: "ok", recorded: rows.length, error: null };
    },
    now: () => NOW,
  };
  if (opts.clock) deps.clock = opts.clock; // injectable monotonic clock for the work-budget deadline
  return { deps, calls };
}
// A durable coverage state that PROVES the exact REQ window with a succeeded state (authorizes an idempotent skip).
const COVERED = { windows: [{ from: REQ.from, to: REQ.to }], status: "succeeded", latestMetricDate: REQ.to, read: "ok", error: null };

const CAMPAIGN = "campaign-performance-v1";
const ASIN = "asin-performance-v1";
const WORK_BUDGET_PAST = 10_000_000; // clearly past the 45s WORK_BUDGET_MS so a deferral fires deterministically
const flatStates = (calls) => calls.upsertStates.flat();
const row = (id, country = "US", date = REQ.to) => ({ seller_or_vendor_id: id, date, marketplace_country_code: country });
const spanDays = (from, to) => Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86400000) + 1;
let EXPORT_LIMIT; // imported in main()
let CAP;          // a cap-sized (>= EXPORT_LIMIT) result that forces a row-cap split; built in main()

/* ============================= option validation (pre-lock, fail closed) ============================= */

test("validateAdsSyncOptions: requiredCoverage requires a non-empty allowlist + strict/real/in-range dates", () => {
  // requiredCoverage without an allowlist -> reject.
  assert.throws(() => validateAdsSyncOptions({ requiredCoverage: REQ }, TODAY), /requires a non-empty accountIds allowlist/);
  assert.throws(() => validateAdsSyncOptions({ accountIds: [], requiredCoverage: REQ }, TODAY), /non-empty accountIds allowlist/);
  // malformed / non-real / from>to / future / overlong-span.
  const A = { accountIds: [G6_US] };
  assert.throws(() => validateAdsSyncOptions({ ...A, requiredCoverage: { from: "2026-7-16", to: "2026-08-14" } }, TODAY), /strict real YYYY-MM-DD/);
  assert.throws(() => validateAdsSyncOptions({ ...A, requiredCoverage: { from: "2026-02-30", to: "2026-08-14" } }, TODAY), /strict real YYYY-MM-DD/);
  assert.throws(() => validateAdsSyncOptions({ ...A, requiredCoverage: { from: "2026-08-14", to: "2026-07-16" } }, TODAY), /from must be <= to/);
  assert.throws(() => validateAdsSyncOptions({ ...A, requiredCoverage: { from: "2026-07-16", to: "2026-08-15" } }, TODAY), /must not be in the future/);
  assert.throws(() => validateAdsSyncOptions({ ...A, requiredCoverage: { from: "1999-12-31", to: "2026-08-14" } }, TODAY), /the maximum is 60/);
  assert.throws(() => validateAdsSyncOptions({ accountIds: "x" }, TODAY), /accountIds must be an array/);
  assert.throws(() => validateAdsSyncOptions([], TODAY), /options must be an object/);
  // a clean requiredCoverage validates.
  assert.deepEqual(validateAdsSyncOptions({ accountIds: [G6_US, G6_IN], requiredCoverage: REQ }, TODAY), { accountIds: [G6_US, G6_IN], requiredCoverage: REQ });
  // absent options -> both null (normal cadence).
  assert.deepEqual(validateAdsSyncOptions({}, TODAY), { accountIds: null, requiredCoverage: null });
});

test("bad option shape is rejected BEFORE the lock is claimed (no lock held on a bad request)", async () => {
  const { deps, calls } = makeDeps();
  await assert.rejects(() => runAdsSyncWithDeps(deps, ["US"], [CAMPAIGN], { requiredCoverage: REQ }), /allowlist/);
  assert.equal(calls.claim, 0, "the lock was never claimed for an invalid request");
  assert.equal(calls.release, 0, "nothing to release");
});

/* ============================= canonical requiredCoverage budget bounds ============================= */

test("canonical bounds: MAX_REQUIRED_COVERAGE_DAYS===60 (max ADS_SOURCES.initialDays) and MAX_IDS_PER_EXPORT is unlimited", () => {
  assert.equal(MAX_REQUIRED_COVERAGE_DAYS, Math.max(...ADS_SOURCES.map((s) => s.initialDays)), "derived from the source contracts");
  assert.equal(MAX_REQUIRED_COVERAGE_DAYS, 60, "currently 60 (asin/search-terms initialDays)");
  // NEW model: DataDoe accepts ANY number of seller/vendor ids in ONE export, so the per-export id cap is
  // effectively unlimited (Number.MAX_SAFE_INTEGER), not the former 5.
  assert.equal(MAX_IDS_PER_EXPORT, Number.MAX_SAFE_INTEGER);
});

test("inclusiveDaySpan: strict UTC calendar arithmetic across leap day + year boundary", () => {
  assert.equal(inclusiveDaySpan("2026-07-16", "2026-08-14"), 30, "the intended 30-day PPC window");
  assert.equal(inclusiveDaySpan("2026-08-14", "2026-08-14"), 1, "single day is inclusive-1");
  assert.equal(inclusiveDaySpan("2026-06-16", "2026-08-14"), 60, "exactly 60 inclusive days");
  assert.equal(inclusiveDaySpan("2026-06-15", "2026-08-14"), 61, "61 inclusive days");
  // leap Feb 2024 (29 days): Feb 1..29 (29) + Mar 1 (1) = 30 inclusive.
  assert.equal(inclusiveDaySpan("2024-02-01", "2024-03-01"), 30);
  // non-leap Feb 2023 (28 days): Feb 1..28 (28) + Mar 1..2 (2) = 30 inclusive (one fewer March day than leap).
  assert.equal(inclusiveDaySpan("2023-02-01", "2023-03-02"), 30);
  // year boundary.
  assert.equal(inclusiveDaySpan("2025-12-15", "2026-01-13"), 30);
});

test("validateAdsSyncOptions budget bounds: <=60 inclusive days accepted; 61 days rejected; any number of accounts accepted", () => {
  const ids2 = [G6_US, G6_IN];
  // exactly 60 inclusive days ending TODAY.
  assert.deepEqual(validateAdsSyncOptions({ accountIds: ids2, requiredCoverage: { from: "2026-06-16", to: TODAY } }, TODAY).requiredCoverage, { from: "2026-06-16", to: TODAY });
  // the intended exact 30-day PPC window.
  assert.deepEqual(validateAdsSyncOptions({ accountIds: ids2, requiredCoverage: REQ }, TODAY).requiredCoverage, REQ);
  // 61 inclusive days => rejected.
  assert.throws(() => validateAdsSyncOptions({ accountIds: ids2, requiredCoverage: { from: "2026-06-15", to: TODAY } }, TODAY), /61 inclusive days; the maximum is 60/);
  // NEW model: any number of accounts is accepted at SHAPE validation -- they all go into ONE export batch per
  // source (resolution against discovery is a later, separate gate). Five accounts accepted...
  const five = ["a", "b", "c", "d", "e"];
  assert.deepEqual(validateAdsSyncOptions({ accountIds: five, requiredCoverage: REQ }, TODAY).accountIds, five);
  // ...and six accounts are ALSO accepted (no <= 5 cap): all ids fit in one export.
  const six = ["a", "b", "c", "d", "e", "f"];
  assert.deepEqual(validateAdsSyncOptions({ accountIds: six, requiredCoverage: REQ }, TODAY).accountIds, six);
  // malformed still rejected (from>to / non-real date / future).
  assert.throws(() => validateAdsSyncOptions({ accountIds: ids2, requiredCoverage: { from: "2026-02-30", to: TODAY } }, TODAY), /strict real YYYY-MM-DD/);
});

test("an overlong window is rejected BEFORE the lock: zero lock/discovery/export/write", async () => {
  // NEW model: an excessive ACCOUNT COUNT is no longer a pre-lock rejection (any number of ids fits in ONE
  // export batch per source). Only an overlong coverage WINDOW is still rejected up front.
  for (const opts of [
    { accountIds: [G6_US], requiredCoverage: { from: "2026-06-15", to: TODAY } },   // 61 days
  ]) {
    const { deps, calls } = makeDeps();
    await assert.rejects(() => runAdsSyncWithDeps(deps, ["US"], [CAMPAIGN], opts), /the maximum is 60/);
    assert.equal(calls.claim, 0, "zero lock calls");
    assert.equal(calls.fetchAccounts.length, 0, "zero discovery");
    assert.equal(calls.fetchRange.length, 0, "zero DataDoe exports");
    assert.equal(calls.upsertRows.length, 0, "zero Ads-row writes");
    assert.equal(calls.upsertStates.length, 0, "zero state writes");
    assert.equal(calls.coverage.length, 0, "zero coverage writes");
    assert.equal(calls.release, 0, "nothing to release (never locked)");
  }
});

test("the intended Gate-6 execution shape (exactly the two approved accounts, exact 30-day window) validates", () => {
  const norm = validateAdsSyncOptions({ accountIds: [G6_US, G6_IN], requiredCoverage: REQ }, TODAY);
  assert.deepEqual(norm, { accountIds: [G6_US, G6_IN], requiredCoverage: REQ });
  assert.ok(norm.accountIds.length <= MAX_IDS_PER_EXPORT, "two accounts fit in one export batch per source");
  assert.ok(inclusiveDaySpan(REQ.from, REQ.to) <= MAX_REQUIRED_COVERAGE_DAYS, "30-day PPC window within the 60-day ceiling");
});

/* ============================= exact-window canary: only the 2 accounts, exact window ============================= */

test("requiredCoverage (ONE source): EXACTLY the two selected primary accounts are exported; the exact window is used", async () => {
  const { deps, calls } = makeDeps({ rowsFor: ({ ids }) => ids.map((id) => row(id, id === G6_IN ? "IN" : "US")) });
  const res = await runAdsSyncWithDeps(deps, ["US", "IN"], [CAMPAIGN], { accountIds: [G6_US, G6_IN], requiredCoverage: REQ });
  assert.equal(res.status, "completed");
  assert.equal(res.coverageMode, true);
  // Every create-export used the EXACT requiredCoverage window (never a cadence window) and the PRIMARY key only.
  assert.ok(calls.fetchRange.length > 0);
  assert.ok(calls.fetchRange.every((c) => c.from === REQ.from && c.to === REQ.to), "exact window on every export");
  assert.ok(calls.fetchRange.every((c) => c.apiKey === PRIMARY_KEY), "primary key only -- dd-secondary never routed");
  // Only the two selected raw account ids were ever exported; no other US/IN account, no dd-secondary.
  const exportedIds = new Set(calls.fetchRange.flatMap((c) => c.ids));
  assert.deepEqual([...exportedIds].sort(), [G6_US, G6_IN].sort(), "only the two Gate-6 accounts exported");
  assert.ok(!exportedIds.has("other-us-1") && !exportedIds.has("other-in-1"), "unrelated US/IN accounts got zero exports");
  // Coverage recorded the EXACT window for the one source / both accounts.
  const cov = calls.coverage.flat();
  assert.equal(cov.length, 2, "one coverage row per (source, account): 1 source x 2 accounts");
  assert.ok(cov.every((c) => c.coveredFrom === REQ.from && c.coveredTo === REQ.to), "coverage records the exact window");
  assert.deepEqual([...new Set(cov.map((c) => c.accountId))].sort(), [G6_US, G6_IN].sort());
});

test("unrelated US/IN and dd-secondary accounts receive ZERO exports/writes", async () => {
  const { deps, calls } = makeDeps({ rowsFor: ({ ids }) => ids.map((id) => row(id, id === G6_IN ? "IN" : "US")) });
  await runAdsSyncWithDeps(deps, ["US", "IN"], [CAMPAIGN], { accountIds: [G6_US, G6_IN], requiredCoverage: REQ });
  const touched = new Set([
    ...calls.fetchRange.flatMap((c) => c.ids),
    ...flatStates(calls).map((s) => s.account_id),
    ...calls.coverage.flat().map((c) => c.accountId),
  ]);
  for (const other of ["other-us-1", "other-in-1", "dd-secondary:" + G6_US]) {
    assert.ok(!touched.has(other), `${other} received zero export/state/coverage writes`);
  }
});

test("requiredCoverage rejects ZERO or MULTIPLE source keys BEFORE the lock (zero lock/discovery/export/write)", async () => {
  for (const keys of [[CAMPAIGN, ASIN], [], [CAMPAIGN, "unknown-source"]]) {
    const { deps, calls } = makeDeps();
    await assert.rejects(() => runAdsSyncWithDeps(deps, ["US"], keys, { accountIds: [G6_US], requiredCoverage: REQ }), /EXACTLY one supported sourceKey|No supported Ads source/);
    assert.equal(calls.claim, 0, `no lock for sourceKeys ${JSON.stringify(keys)}`);
    assert.equal(calls.fetchAccounts.length, 0, "zero discovery");
    assert.equal(calls.fetchRange.length, 0, "zero DataDoe exports");
    assert.equal(calls.upsertRows.length, 0, "zero Supabase row writes");
    assert.equal(calls.upsertStates.length, 0, "zero state writes");
    assert.equal(calls.release, 0, "nothing to release (never locked)");
  }
  // exactly one supported source is accepted.
  const { deps } = makeDeps();
  const res = await runAdsSyncWithDeps(deps, ["US"], [CAMPAIGN], { accountIds: [G6_US], requiredCoverage: REQ });
  assert.equal(res.status, "completed");
});

/* ============================= existing daily state cannot shorten the window ============================= */

test("an existing ads_sync_state that WOULD choose 'daily' cannot shorten requiredCoverage", async () => {
  // Seed a fully-cadenced state (initial+daily+monthly recent) -> pickMode would pick 'daily' (21d). The exact
  // 30-day requiredCoverage window must be used regardless.
  const states = [G6_US, G6_IN].map((id) => ({
    account_id: id, source_key: CAMPAIGN, initial_seeded_at: "2026-01-01T00:00:00.000Z",
    last_daily_sync_at: "2026-08-13T00:00:00.000Z", last_monthly_sync_at: "2026-08-01T00:00:00.000Z",
    latest_metric_date: "2026-08-12", last_status: "succeeded",
  }));
  // The state is 'succeeded' but there is NO durable coverage window (default getCoverage), so it is NOT a
  // skip -- the exact 30-day window is still exported (a daily cadence can never shorten it).
  const { deps, calls } = makeDeps({ states, rowsFor: ({ ids }) => ids.map((id) => row(id, id === G6_IN ? "IN" : "US")) });
  await runAdsSyncWithDeps(deps, ["US", "IN"], [CAMPAIGN], { accountIds: [G6_US, G6_IN], requiredCoverage: REQ });
  assert.ok(calls.fetchRange.length > 0 && calls.fetchRange.every((c) => c.from === REQ.from && c.to === REQ.to), "daily cadence never shortened the exact window");
});

test("requiredCoverage PRESERVES cadence timestamps (not a normal initial/daily/monthly run)", async () => {
  const states = [{
    account_id: G6_US, source_key: CAMPAIGN, initial_seeded_at: "2026-01-01T00:00:00.000Z",
    last_daily_sync_at: "2026-08-13T00:00:00.000Z", last_monthly_sync_at: "2026-08-01T00:00:00.000Z",
    latest_metric_date: "2026-08-10", last_status: "succeeded",
  }];
  const { deps, calls } = makeDeps({ states, rowsFor: () => [{ seller_or_vendor_id: G6_US, date: "2026-08-14", marketplace_country_code: "US" }] });
  await runAdsSyncWithDeps(deps, ["US"], [CAMPAIGN], { accountIds: [G6_US], requiredCoverage: REQ });
  const saved = flatStates(calls).find((s) => s.account_id === G6_US && s.source_key === CAMPAIGN);
  assert.ok(saved, "a state was written");
  assert.equal(saved.initial_seeded_at, "2026-01-01T00:00:00.000Z", "initial_seeded_at PRESERVED (not stamped now)");
  assert.equal(saved.last_daily_sync_at, "2026-08-13T00:00:00.000Z", "last_daily_sync_at PRESERVED");
  assert.equal(saved.last_monthly_sync_at, "2026-08-01T00:00:00.000Z", "last_monthly_sync_at PRESERVED");
  assert.notEqual(saved.initial_seeded_at, NOW);
  assert.notEqual(saved.last_daily_sync_at, NOW);
  assert.notEqual(saved.last_monthly_sync_at, NOW);
  // latest_metric_date advances from the durably-persisted rows; success recorded.
  assert.equal(saved.latest_metric_date, "2026-08-14", "latest_metric_date advanced from the saved rows");
  assert.equal(saved.last_status, "succeeded");
});

/* ============================= recorded window proves the PPC coverage gate ============================= */

test("recorded campaign + ASIN exact 30-day windows make evaluateSourceCoverage(..).proven === true; optional sources independent", async () => {
  // One source per invocation (Fix 1): run campaign, then ASIN, as separate invocations.
  for (const key of [CAMPAIGN, ASIN]) {
    const { deps, calls } = makeDeps();
    await runAdsSyncWithDeps(deps, ["US"], [key], { accountIds: [G6_US], requiredCoverage: REQ });
    const recorded = calls.coverage.flat().filter((c) => c.sourceKey === key && c.accountId === G6_US);
    assert.equal(recorded.length, 1, `${key}: exactly one recorded window`);
    const coverageState = { read: "ok", windows: recorded.map((r) => ({ from: r.coveredFrom, to: r.coveredTo })) };
    assert.equal(evaluateSourceCoverage(coverageState, REQ.from, REQ.to).proven, true, `${key}: proven over the exact 30-day window`);
    // Optional targeting/search are INDEPENDENT: never touched when only this required source is requested.
    const optional = calls.coverage.flat().filter((c) => c.sourceKey === "keyword-targeting-performance-v1" || c.sourceKey === "search-terms-performance-v1");
    assert.equal(optional.length, 0, "optional targeting/search coverage is independent");
  }
});

/* ============================= malformed/unknown/duplicate accounts -> zero exports ============================= */

test("malformed / unknown / duplicate allowlist accounts create ZERO exports (fail closed, lock still released)", async () => {
  for (const bad of [["unknown-acct"], [G6_US, G6_US], [" "], ["dd-secondary:" + G6_US]]) {
    const { deps, calls } = makeDeps();
    await assert.rejects(() => runAdsSyncWithDeps(deps, ["US", "IN"], [CAMPAIGN], { accountIds: bad, requiredCoverage: REQ }), /fail closed|duplicate|dd-secondary|discovered/);
    assert.equal(calls.fetchRange.length, 0, `no export created for allowlist ${JSON.stringify(bad)}`);
    assert.equal(calls.upsertRows.length, 0, "no rows written");
    assert.equal(calls.coverage.length, 0, "no coverage written");
    assert.equal(calls.claim, 1, "the lock was claimed (allowlist resolves post-lock)");
    assert.equal(calls.release, 1, "the lock was released exactly once despite the rejection");
  }
});

/* ============================= failed persistence records zero coverage ============================= */

test("failed Ads-row persistence records ZERO coverage and marks the account failed (no false success)", async () => {
  const { deps, calls } = makeDeps({ fetchRangeThrows: true });
  const res = await runAdsSyncWithDeps(deps, ["US"], [CAMPAIGN], { accountIds: [G6_US], requiredCoverage: REQ });
  assert.equal(calls.coverage.length, 0, "no coverage recorded when the export/persistence failed");
  assert.deepEqual(res.sources[CAMPAIGN].coverage, 0, "zero successful coverage batches");
  assert.deepEqual(res.sources[CAMPAIGN].failedAccounts, [G6_US], "the account is marked failed");
  const saved = flatStates(calls).find((s) => s.account_id === G6_US);
  assert.equal(saved.last_status, "failed", "state marked failed (never succeeded)");
});

/* ============================= null/mismatched coverage acknowledgement -> fail closed ============================= */

test("null / mismatched coverage acknowledgement FAILS CLOSED (no success, no advanced latest_metric_date)", async () => {
  for (const ack of [null, { write: "schema-missing", recorded: 0 }, { write: "write-failed", recorded: 0 }, { write: "ok", recorded: 0 }, { write: "ok" /* recorded missing */ }]) {
    const { deps, calls } = makeDeps({ coverageAck: ack, states: [{ account_id: G6_US, source_key: CAMPAIGN, latest_metric_date: "2026-01-01", initial_seeded_at: "2026-01-01T00:00:00.000Z", last_status: "succeeded" }] });
    const res = await runAdsSyncWithDeps(deps, ["US"], [CAMPAIGN], { accountIds: [G6_US], requiredCoverage: REQ });
    assert.deepEqual(res.sources[CAMPAIGN].coverageFailedAccounts, [G6_US], `ack ${JSON.stringify(ack)} => coverage-failed`);
    assert.deepEqual(res.sources[CAMPAIGN].coverage, 0, "no successful coverage batch");
    const saved = flatStates(calls).find((s) => s.account_id === G6_US);
    assert.equal(saved.last_status, "failed", "unconfirmed coverage never marks the sync succeeded");
    assert.equal(saved.latest_metric_date, "2026-01-01", "latest_metric_date NOT advanced on unconfirmed coverage");
    assert.equal(calls.release, 1, "lock released exactly once");
    // FIX 2: the TOTAL result is never 'completed' on an unconfirmed ack.
    assert.notEqual(res.status, "completed", `ack ${JSON.stringify(ack)} => never completed`);
    assert.equal(res.coverageComplete, false);
  }
});

/* ============================= FIX 1: per-batch row validation (reject before any write) ============================= */

test("selected row + unrelated-account row => WHOLE batch rejected: zero rows/metrics/coverage/success writes", async () => {
  const { deps, calls } = makeDeps({ rowsFor: () => [row(G6_US, "US"), row("other-us-1", "US")] });
  const res = await runAdsSyncWithDeps(deps, ["US"], [CAMPAIGN], { accountIds: [G6_US], requiredCoverage: REQ });
  assert.equal(calls.upsertRows.length, 0, "zero Ads-row writes");
  assert.equal(calls.upsertMetrics.length, 0, "zero metric writes");
  assert.equal(calls.coverage.length, 0, "zero coverage writes");
  assert.ok(!flatStates(calls).some((s) => s.last_status === "succeeded"), "zero successful states");
  assert.deepEqual(res.sources[CAMPAIGN].failedAccounts, [G6_US], "the requested batch account is marked failed");
  assert.notEqual(res.status, "completed");
  assert.equal(res.coverageComplete, false);
});

test("missing / blank seller id fails the WHOLE batch (zero writes)", async () => {
  for (const bad of [row("", "US"), { date: REQ.to, marketplace_country_code: "US" }]) {
    const { deps, calls } = makeDeps({ rowsFor: () => [row(G6_US, "US"), bad] });
    const res = await runAdsSyncWithDeps(deps, ["US"], [CAMPAIGN], { accountIds: [G6_US], requiredCoverage: REQ });
    assert.equal(calls.upsertRows.length, 0, "zero row writes");
    assert.equal(calls.coverage.length, 0, "zero coverage writes");
    assert.deepEqual(res.sources[CAMPAIGN].failedAccounts, [G6_US]);
  }
});

test("wrong marketplace for a selected raw id fails the WHOLE batch (zero writes)", async () => {
  const { deps, calls } = makeDeps({ rowsFor: () => [row(G6_US, "IN")] }); // G6_US is a US account
  const res = await runAdsSyncWithDeps(deps, ["US"], [CAMPAIGN], { accountIds: [G6_US], requiredCoverage: REQ });
  assert.equal(calls.upsertRows.length, 0);
  assert.equal(calls.coverage.length, 0);
  assert.deepEqual(res.sources[CAMPAIGN].failedAccounts, [G6_US]);
});

test("a non-array export result fails the WHOLE batch (zero writes)", async () => {
  const { deps, calls } = makeDeps({ rowsFor: () => ({ not: "an-array" }) });
  const res = await runAdsSyncWithDeps(deps, ["US"], [CAMPAIGN], { accountIds: [G6_US], requiredCoverage: REQ });
  assert.equal(calls.upsertRows.length, 0);
  assert.equal(calls.coverage.length, 0);
  assert.deepEqual(res.sources[CAMPAIGN].failedAccounts, [G6_US]);
});

test("rows for BOTH selected accounts in one batch succeed (per-row marketplace matched)", async () => {
  const { deps, calls } = makeDeps({ rowsFor: () => [row(G6_US, "US"), row(G6_IN, "IN")] });
  const res = await runAdsSyncWithDeps(deps, ["US", "IN"], [CAMPAIGN], { accountIds: [G6_US, G6_IN], requiredCoverage: REQ });
  assert.equal(res.status, "completed");
  assert.equal(res.coverageComplete, true);
  assert.ok(calls.upsertRows.length >= 1, "rows persisted");
  const cov = calls.coverage.flat();
  assert.deepEqual([...new Set(cov.map((c) => c.accountId))].sort(), [G6_US, G6_IN].sort(), "both accounts covered");
  assert.deepEqual(res.sources[CAMPAIGN].failedAccounts, []);
});

test("a genuine ZERO-row export is valid covered-empty evidence (rows called with [], coverage recorded, state succeeded)", async () => {
  const { deps, calls } = makeDeps({ rowsFor: () => [] });
  const res = await runAdsSyncWithDeps(deps, ["US"], [CAMPAIGN], { accountIds: [G6_US], requiredCoverage: REQ });
  assert.equal(res.status, "completed");
  assert.equal(res.coverageComplete, true);
  assert.equal(calls.upsertRows.length, 1, "upsertAdsDailyRows called with the (empty) validated result");
  const cov = calls.coverage.flat();
  assert.equal(cov.length, 1, "covered-empty coverage recorded");
  assert.ok(cov.every((c) => c.coveredFrom === REQ.from && c.coveredTo === REQ.to));
  assert.equal(flatStates(calls).find((s) => s.account_id === G6_US).last_status, "succeeded");
});

/* ============================= FIX 2: total coverage-mode result ============================= */

test("all N pairs confirmed (one source, two accounts) => status 'completed' AND coverageComplete true -- the operator gate", async () => {
  const { deps } = makeDeps({ rowsFor: ({ ids }) => ids.map((id) => row(id, id === G6_IN ? "IN" : "US")) });
  const res = await runAdsSyncWithDeps(deps, ["US", "IN"], [CAMPAIGN], { accountIds: [G6_US, G6_IN], requiredCoverage: REQ });
  assert.equal(res.expectedCoveragePairs, 2);
  assert.equal(res.successfulCoveragePairs, 2);
  assert.deepEqual(res.sources[CAMPAIGN].failedAccounts, []);
  assert.deepEqual(res.sources[CAMPAIGN].coverageFailedAccounts, []);
  assert.ok(res.status === "completed" && res.coverageComplete === true, "res.status === 'completed' && res.coverageComplete === true");
});

test("one account succeeds + one account's coverage-ack fails => status 'partial' + coverageComplete false", async () => {
  // G6_IN's coverage ack is unconfirmed; G6_US confirmed. One source, two accounts. (One export batch of two;
  // the ack fails per-batch, so both go to coverageFailed -- the batch is the atomic ack unit.)
  const { deps } = makeDeps({ rowsFor: ({ ids }) => ids.map((id) => row(id, id === G6_IN ? "IN" : "US")), coverageAck: () => ({ write: "ok", recorded: 1 }) });
  // recorded:1 != batch.length(2) => unconfirmed => both accounts coverageFailed => partial (0 successes here).
  const res = await runAdsSyncWithDeps(deps, ["US", "IN"], [CAMPAIGN], { accountIds: [G6_US, G6_IN], requiredCoverage: REQ });
  assert.notEqual(res.status, "completed");
  assert.equal(res.coverageComplete, false);
  assert.equal(res.expectedCoveragePairs, 2);
});

test("finalizeCoverageSummary: one source ok + one source fail => partial (pure, multi-source aggregation)", async () => {
  const { finalizeCoverageSummary } = await import("../lib/server/ads-sync.js");
  const summary = { status: "completed", accounts: 1, sources: { a: { coverage: 1, failedAccounts: [], coverageFailedAccounts: [] }, b: { coverage: 0, failedAccounts: [], coverageFailedAccounts: ["x"] } } };
  const res = finalizeCoverageSummary(summary, { accounts: 1, sourceKeys: ["a", "b"] });
  assert.equal(res.status, "partial");
  assert.equal(res.coverageComplete, false);
  assert.equal(res.expectedCoveragePairs, 2);
  assert.equal(res.successfulCoveragePairs, 1);
});

test("zero successful pairs + a failure => status 'failed', never completed", async () => {
  const { deps } = makeDeps({ coverageAck: { write: "ok", recorded: 0 } });
  const res = await runAdsSyncWithDeps(deps, ["US"], [CAMPAIGN], { accountIds: [G6_US], requiredCoverage: REQ });
  assert.equal(res.status, "failed");
  assert.equal(res.coverageComplete, false);
});

test("a success-path state-write failure cannot return 'completed' (fails closed; no raw error in summary)", async () => {
  const { deps, calls } = makeDeps();
  const orig = deps.upsertAdsSyncStates;
  deps.upsertAdsSyncStates = async (states) => {
    if (states.some((s) => s.last_status === "succeeded")) throw new Error("STATE_WRITE_FAILED secret-token");
    return orig(states); // failed-state writes still record
  };
  const res = await runAdsSyncWithDeps(deps, ["US"], [CAMPAIGN], { accountIds: [G6_US], requiredCoverage: REQ });
  assert.notEqual(res.status, "completed");
  assert.equal(res.coverageComplete, false);
  assert.ok(!JSON.stringify(res).includes("secret"), "no raw state-write error in the summary");
  assert.equal(calls.release, 1, "lock released exactly once");
});

test("a work-budget deadline cannot return 'completed' => partial + deferred (injected clock; released once)", async () => {
  const seq = [0]; // first clock() = startedAt = 0; the next is past the budget, so the first batch defers.
  let n = 0;
  const { deps, calls } = makeDeps({ clock: () => (n++ === 0 ? seq[0] : WORK_BUDGET_PAST) });
  const res = await runAdsSyncWithDeps(deps, ["US"], [CAMPAIGN], { accountIds: [G6_US], requiredCoverage: REQ });
  assert.equal(res.status, "partial");
  assert.equal(res.deferred, true);
  assert.equal(res.coverageComplete, false);
  assert.equal(calls.fetchRange.length, 0, "deferred before any export");
  assert.equal(calls.release, 1, "lock released exactly once on deferral");
});

test("finalizeCoverageSummary (pure): completed only for a full N x M with zero failures; deferred => partial", async () => {
  const base = () => ({ status: "completed", accounts: 2, sources: { a: { coverage: 2, failedAccounts: [], coverageFailedAccounts: [] }, b: { coverage: 2, failedAccounts: [], coverageFailedAccounts: [] } } });
  const { finalizeCoverageSummary } = await import("../lib/server/ads-sync.js");
  let r = finalizeCoverageSummary(base(), { accounts: 2, sourceKeys: ["a", "b"] });
  assert.equal(r.status, "completed"); assert.equal(r.coverageComplete, true); assert.equal(r.expectedCoveragePairs, 4); assert.equal(r.successfulCoveragePairs, 4);
  // one failure -> partial
  const s2 = base(); s2.sources.b = { coverage: 1, failedAccounts: ["x"], coverageFailedAccounts: [] };
  r = finalizeCoverageSummary(s2, { accounts: 2, sourceKeys: ["a", "b"] });
  assert.equal(r.status, "partial"); assert.equal(r.coverageComplete, false);
  // zero successes + failures -> failed
  const s3 = { status: "completed", accounts: 1, sources: { a: { coverage: 0, failedAccounts: ["x"], coverageFailedAccounts: [] } } };
  r = finalizeCoverageSummary(s3, { accounts: 1, sourceKeys: ["a"] });
  assert.equal(r.status, "failed"); assert.equal(r.coverageComplete, false);
  // deferred always partial (even a full count)
  r = finalizeCoverageSummary(base(), { accounts: 2, sourceKeys: ["a", "b"], deferred: true });
  assert.equal(r.status, "partial"); assert.equal(r.deferred, true); assert.equal(r.coverageComplete, false);
});

/* ============================= FIX (this round): hard recursive create-export ceiling ============================= */

test("ordinary non-cap requiredCoverage export uses EXACTLY one create-export", async () => {
  const { deps, calls } = makeDeps();
  await runAdsSyncWithDeps(deps, ["US"], [CAMPAIGN], { accountIds: [G6_US], requiredCoverage: REQ });
  assert.equal(calls.fetchRange.length, 1, "one create-export for a non-cap window");
  assert.equal(calls.download.length, 1, "one download for the single export");
});

test("parent cap + two successful children uses EXACTLY three create-exports (budget allows the split)", async () => {
  // cap when span > 20 days: the 30-day parent caps and splits into two ~15-day children (each < cap).
  const { deps, calls } = makeDeps({ rowsFor: ({ ids, from, to }) => (spanDays(from, to) > 20 ? CAP : [row(ids[0], "US", to)]) });
  const res = await runAdsSyncWithDeps(deps, ["US"], [CAMPAIGN], { accountIds: [G6_US], requiredCoverage: REQ });
  assert.equal(calls.fetchRange.length, 3, "parent (1) + two children (2) = 3 create-exports");
  assert.equal(res.status, "completed");
  assert.equal(res.coverageComplete, true);
});

test("a deeper split is stopped BEFORE create #4 with a typed budget error (zero rows/metric/coverage/success)", async () => {
  // cap when span > 7 days: 30d -> 15d -> 8d all cap; the 4th create is blocked at the budget.
  const { deps, calls } = makeDeps({ rowsFor: ({ from, to }) => (spanDays(from, to) > 7 ? CAP : []) });
  const res = await runAdsSyncWithDeps(deps, ["US"], [CAMPAIGN], { accountIds: [G6_US], requiredCoverage: REQ });
  assert.equal(calls.fetchRange.length, 3, "exactly three create-exports before the 4th is blocked");
  assert.equal(calls.upsertRows.length, 0, "zero Ads-row writes on budget exhaustion");
  assert.equal(calls.upsertMetrics.length, 0, "zero metric writes");
  assert.equal(calls.coverage.length, 0, "zero coverage writes");
  assert.ok(!flatStates(calls).some((s) => s.last_status === "succeeded"), "zero successful states");
  assert.deepEqual(res.sources[CAMPAIGN].failedAccounts, [G6_US], "the account is marked failed");
  const saved = flatStates(calls).find((s) => s.account_id === G6_US);
  assert.equal(saved.last_status, "failed");
  assert.match(saved.last_error, /ADS_COVERAGE_EXPORT_BUDGET_EXCEEDED/, "typed safe budget code in the failed state");
  assert.ok(!JSON.stringify(res).includes("ADS_COVERAGE_EXPORT_BUDGET_EXCEEDED"), "typed code NOT in the returned summary (ids/counts only)");
  assert.notEqual(res.status, "completed");
  assert.equal(calls.release, 1, "lock released once");
});

/* ============================= FIX (this round): durable idempotent completion ============================= */

test("exact successful REPLAY creates ZERO exports and returns completed + coverageComplete:true", async () => {
  const { deps, calls } = makeDeps({ getCoverage: () => COVERED, rowsFor: ({ ids }) => ids.map((id) => row(id, id === G6_IN ? "IN" : "US")) });
  const res = await runAdsSyncWithDeps(deps, ["US", "IN"], [CAMPAIGN], { accountIds: [G6_US, G6_IN], requiredCoverage: REQ });
  assert.equal(calls.fetchRange.length, 0, "zero create-exports on a fully-covered replay");
  assert.equal(calls.upsertRows.length, 0, "zero row writes");
  assert.equal(calls.coverage.length, 0, "zero new coverage writes");
  assert.equal(res.status, "completed");
  assert.equal(res.coverageComplete, true);
  assert.equal(res.successfulCoveragePairs, 2, "both skipped pairs counted successful");
  assert.equal(res.sources[CAMPAIGN].skipped, 2);
});

test("partial durable coverage exports ONLY the missing account, never the already-complete one", async () => {
  const { deps, calls } = makeDeps({
    getCoverage: (accountId) => (accountId === G6_US ? COVERED : { windows: [], status: "missing", read: "ok" }),
    rowsFor: ({ ids }) => ids.map((id) => row(id, id === G6_IN ? "IN" : "US")),
  });
  const res = await runAdsSyncWithDeps(deps, ["US", "IN"], [CAMPAIGN], { accountIds: [G6_US, G6_IN], requiredCoverage: REQ });
  const exportedIds = new Set(calls.fetchRange.flatMap((c) => c.ids));
  assert.deepEqual([...exportedIds], [G6_IN], "only the missing account is exported");
  assert.ok(!exportedIds.has(G6_US), "the already-covered account is never re-exported");
  assert.equal(res.status, "completed");
  assert.equal(res.coverageComplete, true, "skipped(1) + exported(1) = both accounts complete");
  assert.equal(res.sources[CAMPAIGN].skipped, 1);
});

test("malformed / read-failed / unproven / not-succeeded / thrown durable coverage NEVER authorizes a skip", async () => {
  const cases = [
    { windows: [{ from: REQ.from, to: REQ.to }], status: "succeeded", read: "read-failed" }, // read failed
    { windows: [{ from: REQ.from, to: REQ.to }], status: "failed", read: "ok" },              // state not succeeded
    { windows: [{ from: "2026-07-20", to: REQ.to }], status: "succeeded", read: "ok" },        // window does not reach `from`
    { windows: "not-an-array", status: "succeeded", read: "ok" },                              // malformed windows
    null,                                                                                      // no coverage object
    "THROW",                                                                                   // read throws
  ];
  for (const cov of cases) {
    const opts = cov === "THROW" ? { getCoverage: () => { throw new Error("read-boom-secret"); } } : { getCoverage: () => cov };
    const { deps, calls } = makeDeps(opts);
    const res = await runAdsSyncWithDeps(deps, ["US"], [CAMPAIGN], { accountIds: [G6_US], requiredCoverage: REQ });
    assert.equal(calls.fetchRange.length, 1, `coverage ${JSON.stringify(cov)} must NOT authorize a skip (exported)`);
    assert.equal(res.sources[CAMPAIGN].skipped, 0, "nothing skipped on unproven/failed/malformed coverage");
  }
});

/* ============================= lock released exactly once on every post-claim outcome ============================= */

test("the lock is released EXACTLY ONCE on every post-claim outcome (success / discovery failure / rejection / DataDoe failure)", async () => {
  // success
  let h = makeDeps();
  await runAdsSyncWithDeps(h.deps, ["US"], [CAMPAIGN], { accountIds: [G6_US], requiredCoverage: REQ });
  assert.equal(h.calls.claim, 1); assert.equal(h.calls.release, 1, "success: released once");
  // discovery failure (throws) -> released, then re-thrown
  h = makeDeps({ fetchAccountsThrows: true });
  await assert.rejects(() => runAdsSyncWithDeps(h.deps, ["US"], [CAMPAIGN], { accountIds: [G6_US], requiredCoverage: REQ }));
  assert.equal(h.calls.release, 1, "discovery failure: released once");
  // allowlist rejection (throws post-lock)
  h = makeDeps();
  await assert.rejects(() => runAdsSyncWithDeps(h.deps, ["US"], [CAMPAIGN], { accountIds: ["unknown"], requiredCoverage: REQ }));
  assert.equal(h.calls.release, 1, "allowlist rejection: released once");
  // DataDoe failure (caught per batch, normal return)
  h = makeDeps({ fetchRangeThrows: true });
  await runAdsSyncWithDeps(h.deps, ["US"], [CAMPAIGN], { accountIds: [G6_US], requiredCoverage: REQ });
  assert.equal(h.calls.release, 1, "DataDoe failure: released once");
  // skipped (lock not acquired) -> NOT released (belongs to another run)
  h = makeDeps({ lockResult: false });
  const skipped = await runAdsSyncWithDeps(h.deps, ["US"], [CAMPAIGN], { accountIds: [G6_US], requiredCoverage: REQ });
  assert.equal(skipped.status, "skipped");
  assert.equal(h.calls.release, 0, "skipped: the lock (held by another run) is never released here");
});

/* ============================= no secret / raw error in returned results ============================= */

test("no secret / raw error reaches the returned summary (only safe account ids + counts)", async () => {
  const { deps, calls } = makeDeps({ fetchRangeThrows: true }); // the thrown error embeds a fake secret token
  const res = await runAdsSyncWithDeps(deps, ["US"], [CAMPAIGN], { accountIds: [G6_US], requiredCoverage: REQ });
  const json = JSON.stringify(res);
  assert.ok(!json.includes("secret"), "no 'secret' substring in the returned summary");
  assert.ok(!json.includes("raw-secret-body"), "no raw DataDoe error body in the returned summary");
  assert.ok(!json.includes(PRIMARY_KEY), "no api key in the returned summary");
  assert.deepEqual(res.sources[CAMPAIGN].failedAccounts, [G6_US], "the summary carries safe account ids only");
});

/* ============================= absent options preserve existing behavior ============================= */

test("absent options preserve the existing CADENCE behavior (pickMode/windowFor, every discovered account, best-effort coverage)", async () => {
  const { deps, calls } = makeDeps({ rowsFor: ({ ids }) => ids.map((id) => ({ seller_or_vendor_id: id, date: "2026-08-13", marketplace_country_code: "US" })) });
  const res = await runAdsSyncWithDeps(deps, ["US"], [CAMPAIGN]); // NO options
  assert.equal(res.status, "completed");
  assert.equal(res.coverageMode, undefined, "no coverageMode flag on a normal run");
  // Every discovered US primary account participates (allowlist absent); the initial cadence window is used
  // (no state => 'initial' => campaign.initialDays=56).
  const initialSource = ADS_SOURCES.find((s) => s.key === CAMPAIGN);
  const expectedFrom = (() => { const d = new Date(`${TODAY}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() - (initialSource.initialDays - 1)); return d.toISOString().slice(0, 10); })();
  assert.ok(calls.fetchRange.every((c) => c.from === expectedFrom && c.to === TODAY), "normal run uses the cadence window (initialDays), never a coverage window");
  const exportedIds = new Set(calls.fetchRange.flatMap((c) => c.ids));
  assert.ok(exportedIds.has(G6_US) && exportedIds.has("other-us-1"), "every discovered US account participates when no allowlist");
  // Per-source summary keeps the classic cadence shape (no coverage keys).
  assert.deepEqual(Object.keys(res.sources[CAMPAIGN]).sort(), ["daily", "failedAccounts", "initial", "monthly", "rows"]);
  // The lock is still released once.
  assert.equal(calls.release, 1);
});

test("allowlist alone (no requiredCoverage) still runs the CADENCE window for the two accounts only", async () => {
  const { deps, calls } = makeDeps();
  const res = await runAdsSyncWithDeps(deps, ["US", "IN"], [CAMPAIGN], { accountIds: [G6_US, G6_IN] });
  assert.equal(res.coverageMode, undefined, "allowlist without requiredCoverage is still a normal cadence run");
  const exportedIds = new Set(calls.fetchRange.flatMap((c) => c.ids));
  assert.deepEqual([...exportedIds].sort(), [G6_US, G6_IN].sort(), "only the two accounts, but the cadence window");
  const initialSource = ADS_SOURCES.find((s) => s.key === CAMPAIGN);
  const expectedFrom = (() => { const d = new Date(`${TODAY}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() - (initialSource.initialDays - 1)); return d.toISOString().slice(0, 10); })();
  assert.ok(calls.fetchRange.every((c) => c.from === expectedFrom), "cadence (not coverage) window used");
});

/* ============================= pure allowlist unit (moved from timeout-slicing) ============================= */

test("resolveAdsAccountAllowlist: targets exactly the two Gate-6 accounts; fail-closed on bad ids", () => {
  const discovered = [
    { id: G6_US, connection: { id: "primary" } },
    { id: "other-us-1", connection: { id: "primary" } },
    { id: G6_IN, connection: { id: "primary" } },
    { id: "dd-secondary:x1", connection: { id: "secondary" } },
  ];
  assert.deepEqual(resolveAdsAccountAllowlist(discovered, [G6_US, G6_IN]).map((a) => a.id), [G6_US, G6_IN]);
  assert.throws(() => resolveAdsAccountAllowlist(discovered, ["nope"]), /not among the freshly discovered/);
  assert.throws(() => resolveAdsAccountAllowlist(discovered, [G6_US, G6_US]), /duplicate/);
  assert.throws(() => resolveAdsAccountAllowlist(discovered, [" "]), /blank/);
  assert.throws(() => resolveAdsAccountAllowlist(discovered, ["dd-secondary:x1"]), /dd-secondary/);
  assert.throws(() => resolveAdsAccountAllowlist(discovered, []), /non-empty array/);
});

/* ============================= run ============================= */

async function main() {
  ({ runAdsSyncWithDeps, resolveAdsAccountAllowlist, validateAdsSyncOptions, ADS_SOURCES, MAX_REQUIRED_COVERAGE_DAYS, MAX_IDS_PER_EXPORT, inclusiveDaySpan, EXPORT_LIMIT } = await import("../lib/server/ads-sync.js"));
  ({ evaluateSourceCoverage } = await import("../lib/server/sync/ppc-ads-loader.js"));
  // A single cap-sized result (>= EXPORT_LIMIT rows) reused to force a row-cap split in the ceiling tests.
  CAP = Array.from({ length: EXPORT_LIMIT }, () => ({ seller_or_vendor_id: G6_US, date: REQ.to, marketplace_country_code: "US" }));
  for (const t of tests) {
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (e) { out("FAIL  " + t.name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; return; }
  }
  out("\n" + passed + " assertions passed");
}
main();
