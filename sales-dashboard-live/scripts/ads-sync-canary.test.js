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
  const calls = { fetchAccounts: [], fetchRange: [], upsertRows: [], upsertMetrics: [], upsertStates: [], coverage: [], claim: 0, release: 0 };
  const rowsFor = opts.rowsFor || (() => [
    { seller_or_vendor_id: G6_US, date: REQ.to, marketplace_country_code: "US" },
  ]);
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
    fetchRange: async (apiKey, source, ids, from, to) => {
      calls.fetchRange.push({ apiKey, sourceKey: source.key, ids: [...ids], from, to });
      if (opts.fetchRangeThrows) throw new Error(`DataDoe ${source.key} export creation failed (500): raw-secret-body ${apiKey}`);
      return rowsFor({ source, ids, from, to });
    },
    claimRefreshLock: async () => { calls.claim += 1; return opts.lockResult == null ? true : opts.lockResult; },
    releaseRefreshLock: async () => { calls.release += 1; },
    getAdsSyncStates: async (ids) => (opts.states || []).filter((s) => ids.includes(s.account_id)),
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
  return { deps, calls };
}

const CAMPAIGN = "campaign-performance-v1";
const ASIN = "asin-performance-v1";
const flatStates = (calls) => calls.upsertStates.flat();

/* ============================= option validation (pre-lock, fail closed) ============================= */

test("validateAdsSyncOptions: requiredCoverage requires a non-empty allowlist + strict/real/in-range dates", () => {
  // requiredCoverage without an allowlist -> reject.
  assert.throws(() => validateAdsSyncOptions({ requiredCoverage: REQ }, TODAY), /requires a non-empty accountIds allowlist/);
  assert.throws(() => validateAdsSyncOptions({ accountIds: [], requiredCoverage: REQ }, TODAY), /non-empty accountIds allowlist/);
  // malformed / non-real / from>to / future / out-of-range.
  const A = { accountIds: [G6_US] };
  assert.throws(() => validateAdsSyncOptions({ ...A, requiredCoverage: { from: "2026-7-16", to: "2026-08-14" } }, TODAY), /strict real YYYY-MM-DD/);
  assert.throws(() => validateAdsSyncOptions({ ...A, requiredCoverage: { from: "2026-02-30", to: "2026-08-14" } }, TODAY), /strict real YYYY-MM-DD/);
  assert.throws(() => validateAdsSyncOptions({ ...A, requiredCoverage: { from: "2026-08-14", to: "2026-07-16" } }, TODAY), /from must be <= to/);
  assert.throws(() => validateAdsSyncOptions({ ...A, requiredCoverage: { from: "2026-07-16", to: "2026-08-15" } }, TODAY), /must not be in the future/);
  assert.throws(() => validateAdsSyncOptions({ ...A, requiredCoverage: { from: "1999-12-31", to: "2026-08-14" } }, TODAY), /out of range/);
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

/* ============================= exact-window canary: only the 2 accounts, exact window ============================= */

test("requiredCoverage: EXACTLY the two selected primary accounts are exported; the exact window is used", async () => {
  const { deps, calls } = makeDeps();
  const res = await runAdsSyncWithDeps(deps, ["US", "IN"], [CAMPAIGN, ASIN], { accountIds: [G6_US, G6_IN], requiredCoverage: REQ });
  assert.equal(res.status, "completed");
  assert.equal(res.coverageMode, true);
  // Every fetchRange used the EXACT requiredCoverage window (never a cadence window) and the PRIMARY key only.
  assert.ok(calls.fetchRange.length > 0);
  assert.ok(calls.fetchRange.every((c) => c.from === REQ.from && c.to === REQ.to), "exact window on every export");
  assert.ok(calls.fetchRange.every((c) => c.apiKey === PRIMARY_KEY), "primary key only -- dd-secondary never routed");
  // Only the two selected raw account ids were ever exported; no other US/IN account, no dd-secondary.
  const exportedIds = new Set(calls.fetchRange.flatMap((c) => c.ids));
  assert.deepEqual([...exportedIds].sort(), [G6_US, G6_IN].sort(), "only the two Gate-6 accounts exported");
  assert.ok(!exportedIds.has("other-us-1") && !exportedIds.has("other-in-1"), "unrelated US/IN accounts got zero exports");
  // Coverage recorded the EXACT window for both sources / both accounts.
  const cov = calls.coverage.flat();
  assert.ok(cov.length === 4, "one coverage row per (source, account): 2 sources x 2 accounts");
  assert.ok(cov.every((c) => c.coveredFrom === REQ.from && c.coveredTo === REQ.to), "coverage records the exact window");
  assert.deepEqual([...new Set(cov.map((c) => c.accountId))].sort(), [G6_US, G6_IN].sort());
});

test("unrelated US/IN and dd-secondary accounts receive ZERO exports/writes", async () => {
  const { deps, calls } = makeDeps();
  await runAdsSyncWithDeps(deps, ["US", "IN"], [CAMPAIGN, ASIN], { accountIds: [G6_US, G6_IN], requiredCoverage: REQ });
  const touched = new Set([
    ...calls.fetchRange.flatMap((c) => c.ids),
    ...flatStates(calls).map((s) => s.account_id),
    ...calls.coverage.flat().map((c) => c.accountId),
  ]);
  for (const other of ["other-us-1", "other-in-1", "dd-secondary:" + G6_US]) {
    assert.ok(!touched.has(other), `${other} received zero export/state/coverage writes`);
  }
});

/* ============================= existing daily state cannot shorten the window ============================= */

test("an existing ads_sync_state that WOULD choose 'daily' cannot shorten requiredCoverage", async () => {
  // Seed a fully-cadenced state (initial+daily+monthly recent) -> pickMode would pick 'daily' (21d). The exact
  // 30-day requiredCoverage window must be used regardless.
  const states = [G6_US, G6_IN].flatMap((id) => [CAMPAIGN, ASIN].map((k) => ({
    account_id: id, source_key: k, initial_seeded_at: "2026-01-01T00:00:00.000Z",
    last_daily_sync_at: "2026-08-13T00:00:00.000Z", last_monthly_sync_at: "2026-08-01T00:00:00.000Z",
    latest_metric_date: "2026-08-12", last_status: "succeeded",
  })));
  const { deps, calls } = makeDeps({ states });
  await runAdsSyncWithDeps(deps, ["US", "IN"], [CAMPAIGN, ASIN], { accountIds: [G6_US, G6_IN], requiredCoverage: REQ });
  assert.ok(calls.fetchRange.every((c) => c.from === REQ.from && c.to === REQ.to), "daily cadence never shortened the exact window");
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
  const { deps, calls } = makeDeps();
  await runAdsSyncWithDeps(deps, ["US"], [CAMPAIGN, ASIN], { accountIds: [G6_US], requiredCoverage: REQ });
  // Build the durable coverage state the PPC loader would read for each REQUIRED source from what was recorded.
  for (const key of [CAMPAIGN, ASIN]) {
    const recorded = calls.coverage.flat().filter((c) => c.sourceKey === key && c.accountId === G6_US);
    assert.ok(recorded.length === 1, `${key}: exactly one recorded window`);
    const coverageState = { read: "ok", windows: recorded.map((r) => ({ from: r.coveredFrom, to: r.coveredTo })) };
    assert.equal(evaluateSourceCoverage(coverageState, REQ.from, REQ.to).proven, true, `${key}: proven over the exact 30-day window`);
  }
  // Optional targeting/search are INDEPENDENT: not requested here => no coverage written for them.
  const optionalRecorded = calls.coverage.flat().filter((c) => c.sourceKey === "keyword-targeting-performance-v1" || c.sourceKey === "search-terms-performance-v1");
  assert.equal(optionalRecorded.length, 0, "optional targeting/search coverage is independent (untouched when not requested)");
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
  ({ runAdsSyncWithDeps, resolveAdsAccountAllowlist, validateAdsSyncOptions, ADS_SOURCES } = await import("../lib/server/ads-sync.js"));
  ({ evaluateSourceCoverage } = await import("../lib/server/sync/ppc-ads-loader.js"));
  for (const t of tests) {
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (e) { out("FAIL  " + t.name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; return; }
  }
  out("\n" + passed + " assertions passed");
}
main();
