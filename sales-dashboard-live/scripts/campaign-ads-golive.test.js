// Campaign Ads GO-LIVE runner + operator regressions (offline; ZERO network/DB/DataDoe). Covers: dynamic account
// discovery + 3-region routing + future-account auto-join; deterministic mixed-marketplace <=5-seller batches; the
// mandatory zero-create dry-run gate (price/ceiling/balance) + ceiling refusal + unprovable-balance refusal;
// idempotency (already-covered -> zero creates); the guarded create ceiling; per-region assessment (ownership +
// currency isolation, non-campaign-source rejection); Campaign windows (56/21/49); LKG on failure; and the
// operator/workflow wiring. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  discoverRoutedAccounts, planCampaignAdsRegionRun, runCampaignAdsRegionSlice, assessCampaignAdsRegionCycle,
  planCampaignAdsDryRun, campaignAdsWindow,
  CAMPAIGN_ADS_GRAIN, CAMPAIGN_ADS_TOKENS_PER_CREATE, CAMPAIGN_ADS_SOURCE_NAME,
} from "../lib/server/sync/scheduled-campaign-ads-runner.js";
import { REGIONS } from "../lib/server/sync/campaign-region-routing.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const CONNS = [{ id: "primary", apiKey: "k" }];
const ACCTS = () => [
  { id: "in1", country: "IN" }, { id: "in2", country: "IN" },
  { id: "de1", country: "DE" }, { id: "gb1", country: "GB" }, { id: "au1", country: "AU" },
  { id: "us1", country: "US" }, { id: "ca1", country: "CA" },
  { id: "jp1", country: "JP" }, // unknown region -> UNASSIGNED
];
// Default deps: every account Ads-compatible; none yet covered (all pending); healthy balance.
const mkDeps = (over = {}) => ({
  getConnections: over.getConnections || (() => CONNS),
  fetchAccounts: over.fetchAccounts || (async () => (over.accounts || ACCTS())),
  fetchCompatibleSourceNames: over.fetchCompatibleSourceNames || (async () => new Set([CAMPAIGN_ADS_SOURCE_NAME])),
  getCoverage: over.getCoverage || (async () => ({ read: "error" })), // not covered -> pending
  getDataDoeTokenBalance: over.getDataDoeTokenBalance || (async () => ({ read: "ok", usable: over.usable ?? 100 })),
  // A safe stub createExport by default so no slice test can ever reach the real DataDoe POST.
  createExport: over.createExport || (async () => ({ id: "stub-export" })),
  ...(over.runAdsSyncWithDeps ? { runAdsSyncWithDeps: over.runAdsSyncWithDeps } : {}),
  ...(over.workerDeps ? { workerDeps: over.workerDeps } : {}),
});
// A clean per-batch coverage-mode summary for N accounts (all campaign grain, no failures).
const okSummary = (n) => ({ status: "completed", coverageComplete: true, successfulCoveragePairs: n, expectedCoveragePairs: n, deferred: false, sources: { [CAMPAIGN_ADS_GRAIN]: { failedAccounts: [], coverageFailedAccounts: [] } } });

/* ================= discovery + routing ================= */

test("RT1. dynamic discovery routes accounts into the 3 regions + isolates UNASSIGNED (never exported)", async () => {
  const r = await discoverRoutedAccounts({ deps: mkDeps() });
  assert.deepEqual(r.byRegion[REGIONS.INDIA].map((a) => a.accountId).sort(), ["in1", "in2"]);
  assert.deepEqual(r.byRegion[REGIONS.EUROPE_AU].map((a) => a.accountId).sort(), ["au1", "de1", "gb1"]);
  assert.deepEqual(r.byRegion[REGIONS.US_CA].map((a) => a.accountId).sort(), ["ca1", "us1"]);
  assert.deepEqual(r.unassigned.map((a) => a.accountId), ["jp1"]);
  passed += 1;
});

test("RT2. a newly connected account auto-joins its region on the next discovery (no static list)", async () => {
  const before = await discoverRoutedAccounts({ deps: mkDeps() });
  assert.ok(!before.byRegion[REGIONS.EUROPE_AU].some((a) => a.accountId === "nl9"));
  const after = await discoverRoutedAccounts({ deps: mkDeps({ accounts: [...ACCTS(), { id: "nl9", country: "NL" }] }) });
  assert.ok(after.byRegion[REGIONS.EUROPE_AU].some((a) => a.accountId === "nl9"), "new NL seller auto-routes to Europe+AU");
  passed += 1;
});

test("RT3. Campaign windows: initial 56 / daily 21 / monthly 49 inclusive days ending at asOf", () => {
  assert.deepEqual(campaignAdsWindow("2026-03-01", "initial"), { from: "2026-01-05", to: "2026-03-01", days: 56 });
  assert.deepEqual(campaignAdsWindow("2026-03-01", "daily"), { from: "2026-02-09", to: "2026-03-01", days: 21 });
  assert.deepEqual(campaignAdsWindow("2026-03-01", "monthly"), { from: "2026-01-12", to: "2026-03-01", days: 49 });
  assert.throws(() => campaignAdsWindow("bad", "initial"), /CAMPAIGN_ADS_BAD_ASOF/);
  passed += 1;
});

/* ================= zero-create dry-run gate ================= */

test("DR1. dry-run: exports = <=5-seller batch count; cost = exports x 2; authorized when balance >= cost <= max", async () => {
  const dry = await planCampaignAdsDryRun({ asOf: "2026-03-01", runKind: "initial", maxTokens: 40, deps: mkDeps() });
  // IN 2->1 batch, EU+AU 3->1 batch, US+CA 2->1 batch = 3 exports; JP unassigned (no export).
  assert.equal(dry.plan.exportCount, 3);
  assert.equal(dry.tokenPrice, CAMPAIGN_ADS_TOKENS_PER_CREATE);
  assert.equal(dry.plan.maxTokenSpend, 6, "3 exports x 2 tokens");
  assert.equal(dry.withinCeiling, true);
  assert.equal(dry.balanceProven, true);
  assert.equal(dry.balanceSufficient, true);
  assert.equal(dry.createAuthorized, true);
  assert.deepEqual(dry.unassigned.map((u) => u.accountId), ["jp1"], "UNASSIGNED surfaced, never batched");
  passed += 1;
});

test("DR2. dry-run REFUSES (createAuthorized=false) when worst-case cost exceeds the token ceiling", async () => {
  const dry = await planCampaignAdsDryRun({ asOf: "2026-03-01", runKind: "initial", maxTokens: 2, deps: mkDeps() });
  assert.equal(dry.withinCeiling, false, "6 > 2");
  assert.equal(dry.createAuthorized, false);
  passed += 1;
});

test("DR3. dry-run REFUSES when balance is UNREADABLE (never assume tokens exist)", async () => {
  const dry = await planCampaignAdsDryRun({ asOf: "2026-03-01", runKind: "initial", maxTokens: 40, deps: mkDeps({ getDataDoeTokenBalance: async () => ({ read: "error", usable: null }) }) });
  assert.equal(dry.balanceProven, false);
  assert.equal(dry.balanceSufficient, false);
  assert.equal(dry.createAuthorized, false);
  passed += 1;
});

test("DR4. dry-run REFUSES when balance is readable but < worst-case cost", async () => {
  const dry = await planCampaignAdsDryRun({ asOf: "2026-03-01", runKind: "initial", maxTokens: 40, deps: mkDeps({ usable: 4 }) });
  assert.equal(dry.plan.maxTokenSpend, 6);
  assert.equal(dry.balanceSufficient, false, "4 < 6");
  assert.equal(dry.createAuthorized, false);
  passed += 1;
});

/* ================= region slice: batching, idempotency, ceiling, LKG ================= */

test("BT1. deterministic mixed-marketplace <=5-seller batches; allowlist passed as accountIds; region grain only", async () => {
  const seven = ["s7", "s1", "s3", "s2", "s5", "s4", "s6"].map((id, i) => ({ accountId: id, marketplace: i % 2 ? "DE" : "GB" }));
  const calls = [];
  const runWorker = async (workerDeps, countries, grains, opts) => { await workerDeps.createExport(); calls.push({ countries, grains, ids: opts.accountIds, coverage: opts.requiredCoverage }); return okSummary(opts.accountIds.length); };
  const plan = { region: REGIONS.EUROPE_AU, window: { from: "2026-01-05", to: "2026-03-01" }, compatible: seven, pending: seven, covered: [], incompatible: [] };
  const res = await runCampaignAdsRegionSlice({ region: REGIONS.EUROPE_AU, asOf: "2026-03-01", plan, deps: mkDeps({ runAdsSyncWithDeps: runWorker }) });
  assert.equal(res.phase, "complete");
  assert.equal(calls.length, 2, "7 sellers -> 2 batches of <=5");
  assert.deepEqual(calls[0].ids, ["s1", "s2", "s3", "s4", "s5"], "sorted, first 5");
  assert.deepEqual(calls[1].ids, ["s6", "s7"]);
  assert.ok(calls.every((c) => c.ids.length <= 5));
  assert.ok(calls.every((c) => c.grains.length === 1 && c.grains[0] === CAMPAIGN_ADS_GRAIN), "campaign grain ONLY");
  assert.ok(calls[0].countries.includes("DE") || calls[0].countries.includes("GB"), "mixed marketplaces may share one export");
  assert.equal(res.creates, 2); assert.equal(res.tokens, 4);
  passed += 1;
});

test("BT2. IDEMPOTENT: an already-fully-covered region creates ZERO exports (replay adopts completed work)", async () => {
  let created = 0;
  const runWorker = async (workerDeps) => { await workerDeps.createExport(); created += 1; return okSummary(1); };
  const plan = { region: REGIONS.INDIA, window: { from: "2026-01-05", to: "2026-03-01" }, compatible: [{ accountId: "in1", marketplace: "IN" }], pending: [], covered: [{ accountId: "in1", marketplace: "IN" }], incompatible: [] };
  const res = await runCampaignAdsRegionSlice({ region: REGIONS.INDIA, asOf: "2026-03-01", plan, deps: mkDeps({ runAdsSyncWithDeps: runWorker }) });
  assert.equal(res.phase, "complete");
  assert.equal(res.creates, 0); assert.equal(res.tokens, 0);
  assert.equal(created, 0, "no create for an already-covered account");
  passed += 1;
});

test("BT3. the guarded create ceiling REFUSES a create beyond the cap (fail closed, LKG preserved)", async () => {
  const runWorker = async (workerDeps) => { await workerDeps.createExport(); return okSummary(1); };
  const two = [{ accountId: "a1", marketplace: "US" }, { accountId: "a2", marketplace: "US" }, { accountId: "a3", marketplace: "US" }, { accountId: "a4", marketplace: "US" }, { accountId: "a5", marketplace: "US" }, { accountId: "a6", marketplace: "US" }];
  const plan = { region: REGIONS.US_CA, window: { from: "2026-01-05", to: "2026-03-01" }, compatible: two, pending: two, covered: [], incompatible: [] };
  const res = await runCampaignAdsRegionSlice({ region: REGIONS.US_CA, asOf: "2026-03-01", plan, maxCreates: 1, deps: mkDeps({ runAdsSyncWithDeps: runWorker }) });
  assert.equal(res.phase, "sync"); assert.equal(res.ok, false);
  assert.ok(res.problems.some((p) => /CEILING|batch failed/.test(p)), "ceiling refusal is a typed failure");
  passed += 1;
});

test("BT4. a worker failure is a typed LKG-preserving problem, never a fabricated success", async () => {
  const runWorker = async (workerDeps) => { await workerDeps.createExport(); throw new Error("datadoe 500 boom"); };
  const one = [{ accountId: "a1", marketplace: "US" }];
  const plan = { region: REGIONS.US_CA, window: { from: "2026-01-05", to: "2026-03-01" }, compatible: one, pending: one, covered: [], incompatible: [] };
  const res = await runCampaignAdsRegionSlice({ region: REGIONS.US_CA, asOf: "2026-03-01", plan, deps: mkDeps({ runAdsSyncWithDeps: runWorker }) });
  assert.equal(res.phase, "sync"); assert.equal(res.ok, false);
  assert.ok(res.problems.length >= 1);
  passed += 1;
});

/* ================= assessment: ownership + currency isolation, source purity ================= */

test("AS1. assessment PASSES a clean campaign-only, fully-covered, in-set batch set", () => {
  const discovered = [{ accountId: "a1" }, { accountId: "a2" }];
  const a = assessCampaignAdsRegionCycle({ region: REGIONS.US_CA, discoveredAccounts: discovered, batchResults: [{ accountIds: ["a1", "a2"], summary: okSummary(2) }], creates: 1 });
  assert.equal(a.ok, true, JSON.stringify(a.problems));
  assert.equal(a.tokens, 2);
  passed += 1;
});

test("AS2. assessment REJECTS a non-campaign source, a failed account, and an out-of-set (cross-account) id", () => {
  const bad = { status: "completed", coverageComplete: true, successfulCoveragePairs: 1, expectedCoveragePairs: 1, deferred: false, sources: { [CAMPAIGN_ADS_GRAIN]: { failedAccounts: ["x"], coverageFailedAccounts: [] }, "asin-performance-v1": {} } };
  const a = assessCampaignAdsRegionCycle({ region: REGIONS.US_CA, discoveredAccounts: [{ accountId: "a1" }], batchResults: [{ accountIds: ["a1", "STRANGER"], summary: bad }], creates: 1 });
  assert.equal(a.ok, false);
  assert.ok(a.problems.some((p) => /non-campaign-source/.test(p)), "ASIN grain must never appear in a campaign batch");
  assert.ok(a.problems.some((p) => /failed-accounts/.test(p)));
  assert.ok(a.problems.some((p) => /batch-account-unexpected/.test(p)), "a row for an out-of-batch seller is rejected");
  passed += 1;
});

test("AS3. assessment REJECTS coverage-pairs mismatch + missing account coverage", () => {
  const partial = { status: "completed", coverageComplete: true, successfulCoveragePairs: 1, expectedCoveragePairs: 2, deferred: false, sources: { [CAMPAIGN_ADS_GRAIN]: {} } };
  const a = assessCampaignAdsRegionCycle({ region: REGIONS.INDIA, discoveredAccounts: [{ accountId: "a1" }, { accountId: "a2" }], batchResults: [{ accountIds: ["a1"], summary: partial }], creates: 1 });
  assert.equal(a.ok, false);
  assert.ok(a.problems.some((p) => /coverage-pairs-mismatch/.test(p)));
  assert.ok(a.problems.some((p) => /account-coverage-missing/.test(p)), "a2 was never covered");
  passed += 1;
});

/* ================= preflight excludes disconnected accounts (never poison a batch) ================= */

test("PF1. an Ads-DISCONNECTED account is typed incompatible (excluded), never in a batch", async () => {
  const deps = mkDeps({ fetchCompatibleSourceNames: async (_k, id) => (id === "us1" ? new Set([]) : new Set([CAMPAIGN_ADS_SOURCE_NAME])) });
  const p = await planCampaignAdsRegionRun({ region: REGIONS.US_CA, asOf: "2026-03-01", deps });
  assert.ok(p.incompatible.some((a) => a.accountId === "us1"), "disconnected account excluded");
  assert.ok(!p.pending.some((a) => a.accountId === "us1"));
  assert.ok(p.pending.some((a) => a.accountId === "ca1"), "the connected account still runs");
  passed += 1;
});

/* ================= operator + workflow wiring (static) ================= */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OP = readFileSync(join(ROOT, "scripts/release/campaign-ads-golive.mjs"), "utf8");
const WF = readFileSync(join(ROOT, "../.github/workflows/campaign-ads-golive.yml"), "utf8");

test("OP1. operator refuses apply unless the dry-run gate authorized the create", () => {
  assert.ok(/if \(!dry\.createAuthorized\)/.test(OP), "apply gates on createAuthorized");
  assert.ok(/create NOT authorized/.test(OP));
  assert.ok(/planCampaignAdsDryRun/.test(OP), "the mandatory dry-run runs for both modes");
  passed += 1;
});

test("OP2. workflow is manual-only (no schedule yet), caps max_tokens at 40, runs the operator", () => {
  assert.ok(/workflow_dispatch/.test(WF));
  assert.ok(!/^on:\s*[\s\S]*schedule:/m.test(WF) || !/cron:/.test(WF), "no cron schedule in the go-live workflow yet (added at activation)");
  assert.ok(/exceeds the authorized 40 -- capping at 40/.test(WF), "max_tokens hard-capped at 40");
  assert.ok(/campaign-ads-golive\.mjs/.test(WF));
  passed += 1;
});

/* ================= run ================= */
let failures = 0;
(async () => {
  out("campaign-ads-golive");
  for (const t of tests) { try { await t.fn(); out("  ok  " + t.name); } catch (e) { failures += 1; out("FAIL  " + t.name); out(String((e && e.stack) || e)); } }
  out("\n" + passed + " groups passed" + (failures ? ", " + failures + " FAILED" : ""));
  if (failures) process.exitCode = 1;
})();
