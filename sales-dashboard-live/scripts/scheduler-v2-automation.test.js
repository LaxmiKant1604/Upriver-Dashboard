// Scheduler v2 -- AUTOMATIC scheduler (GitHub Actions) tests: portable env loading, the scheduled Catalog
// operation key, the daily OLI plan + per-bucket ceilings, the strict post-drain OLI assessment, and the
// workflow cron / single-scheduler pinning. Pure + offline (no network, no DB, no real .env.local read).

import assert from "node:assert/strict";
import { writeSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseEnvFile, applyEnv } from "./release/env-bootstrap.mjs";
import { oliBucketPlan, assessScheduledOliCycle, classifyScheduledOliCycle, OLI_TOKENS_PER_CREATE, scheduledSourceControlPlan, SCHEDULED_ENABLED_SOURCE_KEYS } from "../lib/server/sync/source-scheduled-oli.js";
import { getDataDoeTokenBalance, confirmUsableTokens, COMBINED_DAILY_TOKEN_CEILING } from "../lib/server/datadoe-usage.js";
import { asinAdsBucketPlan, asinAdsRefreshWindow, assessScheduledAsinAdsCycle, ASIN_ADS_TOKENS_PER_CREATE, ASIN_ADS_ROLLING_WINDOW_DAYS } from "../lib/server/sync/source-scheduled-asin-ads.js";

const HERE = dirname(fileURLToPath(import.meta.url));            // <repo>/sales-dashboard-live/scripts
const WORKFLOWS_DIR = resolve(HERE, "..", "..", ".github", "workflows");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const group = (label) => tests.push({ marker: label });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

// ---- helpers ----
const acct = (i) => "A" + String(i).padStart(2, "0");
const accountsN = (n) => Array.from({ length: n }, (_, i) => ({ accountId: acct(i + 1) }));
// Build a set of OLI jobs + owners that batch `n` accounts into groups of <=5, each a create.
function oliCycle(n, over = {}) {
  const ids = Array.from({ length: n }, (_, i) => acct(i + 1));
  const jobs = []; const owners = [];
  for (let b = 0; b * 5 < n; b += 1) {
    const members = ids.slice(b * 5, b * 5 + 5);
    const hash = "oli-" + b;
    jobs.push({ source_key: "order-line-items", request_hash: hash, fetch_status: "succeeded", create_export_count: 1 });
    for (const m of members) owners.push({ request_hash: hash, account_id: m });
  }
  return { discoveredAccounts: ids.map((accountId) => ({ accountId })), sourceJobs: jobs, owners, open: 0, ...over };
}

group("A. portable env bootstrap (with + without .env.local; CI env wins; SUPABASE_URL mapping)");

test("A1. parseEnvFile parses KEY=VALUE, strips quotes, ignores comments/blank lines", () => {
  const p = parseEnvFile("# comment\n\nFOO=bar\nBAZ=\"q u x\"\nSINGLE='sq'\nEMPTY=\n  SPACED = v \nnot a var line\n");
  assert.equal(p.FOO, "bar");
  assert.equal(p.BAZ, "q u x");
  assert.equal(p.SINGLE, "sq");
  assert.equal(p.EMPTY, "");
  assert.equal(p.SPACED, "v");
  assert.ok(!("# comment" in p));
});

test("A2. applyEnv loads a PRESENT file but NEVER overrides an already-set (CI) variable; fills gaps; maps SUPABASE_URL", () => {
  const env = { EXISTING: "keep-me" };
  const res = applyEnv({ envFilePath: "/fake/.env.local", env, exists: () => true, read: () => "EXISTING=override\nNEWVAR=hello\nVITE_SUPABASE_URL=https://x.supabase.co" });
  assert.equal(res.loadedEnvFile, true);
  assert.equal(env.EXISTING, "keep-me", "CI-supplied value is NOT overridden by the file");
  assert.equal(env.NEWVAR, "hello", "file fills a gap");
  assert.equal(env.SUPABASE_URL, "https://x.supabase.co", "SUPABASE_URL mapped from VITE_SUPABASE_URL");
  assert.equal(res.mappedSupabaseUrl, true);
});

test("A3. applyEnv with NO file present does not throw, does not read, and still maps SUPABASE_URL from VITE", () => {
  const env = { VITE_SUPABASE_URL: "https://y.supabase.co" };
  const res = applyEnv({ envFilePath: "/fake/.env.local", env, exists: () => false, read: () => { throw new Error("must not read an absent file"); } });
  assert.equal(res.loadedEnvFile, false);
  assert.equal(env.SUPABASE_URL, "https://y.supabase.co", "mapping happens even with no file (GitHub Actions path)");
});

test("A4. an explicit SUPABASE_URL is never clobbered by VITE_SUPABASE_URL", () => {
  const env = { SUPABASE_URL: "explicit", VITE_SUPABASE_URL: "vite" };
  const res = applyEnv({ env, exists: () => false });
  assert.equal(env.SUPABASE_URL, "explicit");
  assert.equal(res.mappedSupabaseUrl, false);
});

group("B. daily OLI plan + per-bucket ceilings");

test("B1. Non-US daily plan: 22 accounts -> EXACTLY 5 batches, <= 10 tokens", () => {
  const plan = oliBucketPlan(accountsN(22));
  assert.equal(plan.expectedBatches, 5, "22 accounts / 5-per-batch = 5 batches");
  assert.equal(plan.maxCreates, 5);
  assert.equal(plan.maxTokens, 10);
  assert.ok(plan.batches.every((b) => b.accounts.length <= 5), "no batch exceeds 5 sellers");
});

test("B2. US daily plan: 8 accounts -> EXACTLY 2 batches, <= 4 tokens", () => {
  const plan = oliBucketPlan(accountsN(8));
  assert.equal(plan.expectedBatches, 2);
  assert.equal(plan.maxCreates, 2);
  assert.equal(plan.maxTokens, 4);
});

test("B3. combined OLI+Catalog maximum daily ceiling = 8 creates / 16 tokens", () => {
  const us = oliBucketPlan(accountsN(8));
  const nonus = oliBucketPlan(accountsN(22));
  const catalogCreates = 1; const catalogTokens = 2; // one org-wide Catalog create per scheduled date
  const totalCreates = us.maxCreates + nonus.maxCreates + catalogCreates;
  const totalTokens = us.maxTokens + nonus.maxTokens + catalogTokens;
  assert.equal(totalCreates, 8, "2 (US OLI) + 5 (Non-US OLI) + 1 (Catalog) = 8 creates");
  assert.equal(totalTokens, 16, "4 + 10 + 2 = 16 standard tokens");
  assert.equal(OLI_TOKENS_PER_CREATE, 2);
});

test("B4. dd-secondary / colon-scoped accounts are excluded from the primary OLI plan", () => {
  const plan = oliBucketPlan([...accountsN(3), { accountId: "dd-secondary:zzz" }, { accountId: "x:y" }]);
  assert.equal(plan.expectedBatches, 1, "only the 3 primary accounts are batched");
});

test("B5. durable source_controls target: ONLY order-line-items + product-catalog + ads-asin-date are schedule-enabled + unpaused; Campaign Ads / FBA / every other source stays schedule-disabled", () => {
  const allKeys = ["order-line-items", "product-catalog", "ads-asin-date", "ads-campaign-date", "settlements", "returns", "fba-inventory-health", "listings", "content-changes"];
  const plan = scheduledSourceControlPlan(allKeys);
  const enabled = plan.filter((p) => p.scheduleEnabled === true).map((p) => p.sourceKey).sort();
  assert.deepEqual(enabled, [...SCHEDULED_ENABLED_SOURCE_KEYS].sort(), "exactly OLI + catalog + ASIN Ads enabled");
  assert.ok(enabled.includes("ads-asin-date"), "ASIN Ads is scheduled");
  for (const p of plan) {
    if (SCHEDULED_ENABLED_SOURCE_KEYS.includes(p.sourceKey)) { assert.equal(p.scheduleEnabled, true); assert.equal(p.paused, false, p.sourceKey + " unpaused"); }
    else { assert.equal(p.scheduleEnabled, false, p.sourceKey + " schedule-disabled"); assert.equal(p.paused, undefined, p.sourceKey + " paused state left untouched"); }
  }
  // Campaign Ads / FBA / settlements / returns are NEVER schedule-enabled by this scheduler.
  for (const forbidden of ["ads-campaign-date", "fba-inventory-health", "settlements", "returns"]) {
    assert.ok(!enabled.includes(forbidden), forbidden + " must never be scheduled (Campaign Ads stays paused)");
  }
});

group("C. strict post-drain OLI assessment");

test("C1. happy path: drained, OLI-only, owners cover the discovered accounts, create<=1 -> ok within ceiling", () => {
  const a = assessScheduledOliCycle({ bucket: "us", ...oliCycle(8) });
  assert.equal(a.ok, true, JSON.stringify(a.problems));
  assert.equal(a.creates, 2);
  assert.equal(a.tokens, 4);
  assert.equal(a.batches, 2);
  assert.equal(a.ceilingCreates, 2);
  assert.equal(a.ceilingTokens, 4);
});

test("C2. a warm-cache run (create_export_count=0) is ok and spends ZERO tokens", () => {
  const cyc = oliCycle(8);
  for (const j of cyc.sourceJobs) j.create_export_count = 0;
  const a = assessScheduledOliCycle({ bucket: "us", ...cyc });
  assert.equal(a.ok, true, JSON.stringify(a.problems));
  assert.equal(a.creates, 0);
  assert.equal(a.tokens, 0);
});

test("C3. rejects every violation: not-drained, non-OLI source, failed job, batch>5, unexpected owner, coverage gap, create>1, over-ceiling", () => {
  const cases = [
    ["family not drained", { bucket: "us", ...oliCycle(8, { open: 1 }) }, "family-not-drained:1"],
    ["a non-OLI source job present", { bucket: "us", ...(() => { const c = oliCycle(8); c.sourceJobs.push({ source_key: "product-catalog", request_hash: "cat", fetch_status: "succeeded", create_export_count: 0 }); return c; })() }, "non-oli-source:product-catalog"],
    ["a job that is not succeeded", { bucket: "us", ...(() => { const c = oliCycle(8); c.sourceJobs[0].fetch_status = "attempted"; return c; })() }, "job-not-succeeded"],
    ["a batch of 6 sellers", { bucket: "us", ...(() => { const c = oliCycle(5); c.discoveredAccounts.push({ accountId: "A06" }); c.owners.push({ request_hash: "oli-0", account_id: "A06" }); return c; })() }, "batch-oversized:6"],
    ["an owner outside the discovered set", { bucket: "us", ...(() => { const c = oliCycle(3); c.owners.push({ request_hash: "oli-0", account_id: "A99" }); return c; })() }, "owner-unexpected"],
    ["a discovered account with no OLI owner", { bucket: "us", ...(() => { const c = oliCycle(3); c.owners = c.owners.filter((o) => o.account_id !== "A03"); return c; })() }, "owner-coverage-missing"],
    ["a multi-create OLI job", { bucket: "us", ...(() => { const c = oliCycle(3); c.sourceJobs[0].create_export_count = 2; return c; })() }, "bad-create-count:2"],
    ["more creates than the plan ceiling", { bucket: "us", ...(() => {
      // 8 accounts -> ceiling 2 creates; force 3 OLI jobs (3 batches) each create=1 -> creates 3 > 2
      const ids = accountsN(8).map((a) => a.accountId);
      const groups = [ids.slice(0, 3), ids.slice(3, 6), ids.slice(6, 8)];
      const sourceJobs = []; const owners = [];
      groups.forEach((g, b) => { const h = "oli-x-" + b; sourceJobs.push({ source_key: "order-line-items", request_hash: h, fetch_status: "succeeded", create_export_count: 1 }); g.forEach((m) => owners.push({ request_hash: h, account_id: m })); });
      return { discoveredAccounts: ids.map((accountId) => ({ accountId })), sourceJobs, owners, open: 0 };
    })() }, "creates-over-ceiling:3>2"],
    ["an org-scoped OLI owner (must be per-account)", { bucket: "us", ...(() => { const c = oliCycle(3); c.owners.push({ request_hash: "oli-0", account_id: "__organization" }); return c; })() }, "owner-org-scope"],
  ];
  for (const [name, input, reason] of cases) {
    const a = assessScheduledOliCycle(input);
    assert.equal(a.ok, false, name + " must be rejected");
    assert.ok(a.problems.includes(reason), name + " -> expected problem '" + reason + "' in " + JSON.stringify(a.problems));
  }
});

group("D. GitHub Actions workflow: cron times + single-scheduler rule + US publish/safe-close shape");

test("D1. scheduler-v2.yml pins BOTH daily crons, workflow_dispatch, concurrency, Node 24, and a >=90-min timeout", () => {
  const yml = readFileSync(resolve(WORKFLOWS_DIR, "scheduler-v2.yml"), "utf8");
  assert.match(yml, /cron:\s*"0 2 \* \* \*"/, "non-us 02:00 UTC cron");
  assert.match(yml, /cron:\s*"30 10 \* \* \*"/, "us 10:30 UTC cron");
  assert.match(yml, /workflow_dispatch:/, "manual dispatch kept");
  assert.match(yml, /concurrency:\s*\n\s*group:\s*scheduler-v2/, "single-run concurrency group");
  assert.match(yml, /cancel-in-progress:\s*false/, "runs serialize, never overlap");
  assert.match(yml, /node-version:\s*"24"/, "Node 24");
  const tm = /timeout-minutes:\s*(\d+)/.exec(yml);
  assert.ok(tm && Number(tm[1]) >= 90, "timeout >= 90 minutes");
});

test("D2. workflow shape: token gate BEFORE creates; OLI + ASIN Ads (both buckets); US opens controls, publishes date-scoped, rebuilds membership, and ALWAYS safe-closes", () => {
  const yml = readFileSync(resolve(WORKFLOWS_DIR, "scheduler-v2.yml"), "utf8");
  // Token gate runs before the source refreshes (fail-closed >= 30).
  assert.match(yml, /confirm-token-budget\.mjs --min=30/, "confirms >= 30 usable tokens before any create");
  const gateIdx = yml.indexOf("confirm-token-budget.mjs");
  const oliIdx = yml.indexOf("scheduled-oli-refresh.mjs");
  const adsIdx = yml.indexOf("scheduled-asin-ads-refresh.mjs");
  assert.ok(gateIdx > 0 && gateIdx < oliIdx && oliIdx < adsIdx, "order: token gate -> OLI -> ASIN Ads");
  assert.match(yml, /scheduled-oli-refresh\.mjs --bucket=\$\{\{ steps\.cfg\.outputs\.bucket \}\} --as-of=/, "OLI refresh runs for the resolved bucket");
  assert.match(yml, /scheduled-asin-ads-refresh\.mjs --bucket=\$\{\{ steps\.cfg\.outputs\.bucket \}\} --as-of=/, "ASIN Ads refresh runs for the resolved bucket (both buckets)");
  assert.match(yml, /priority-control-package\.mjs --apply/, "US run opens publication controls");
  assert.match(yml, /priority-dashboards-release\.mjs --as-of=[^\n]*--operation-key=priority-dashboards\/scheduled\//, "release uses the date-scoped operation key");
  assert.match(yml, /rebuild-brand-membership\.mjs/, "US run rebuilds Brand View membership from the fresh brand-sales");
  assert.match(yml, /if:\s*always\(\)\s*&&\s*steps\.cfg\.outputs\.bucket == 'us'\n\s*run:\s*node scripts\/release\/priority-control-package\.mjs --rollback/, "safe-close ALWAYS runs on the US path");
  // No unrelated source/report is ever run: no Campaign Ads, no FBA, no deprecated Vercel cron endpoint.
  assert.doesNotMatch(yml, /campaign|fba-|api\/cron\/sync/i, "never runs Campaign Ads / FBA / the deprecated Vercel cron endpoint");
});

test("D3. single-scheduler rule: EXACTLY ONE workflow file declares a schedule: trigger", () => {
  const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  const scheduled = files.filter((f) => /\n\s*schedule:\s*\n/.test(readFileSync(resolve(WORKFLOWS_DIR, f), "utf8")));
  assert.deepEqual(scheduled, ["scheduler-v2.yml"], "only scheduler-v2.yml schedules; got " + JSON.stringify(scheduled));
});

group("E. DataDoe token-confirmation gate (read-only balance from usage-logs; fail-closed)");

const usageResp = (rows) => ({ ok: true, json: async () => ({ data: rows, meta: {} }) });
const mkFetch = (resp) => async () => resp;

test("E1. getDataDoeTokenBalance reads the LATEST usage-log row's pool balances (balance + extra + bundle)", async () => {
  const rows = [
    { usedAt: "2026-08-20T00:00:00Z", balanceAfter: 100, extraTokensAfter: 0, bundleTokensAfter: 0 },
    { usedAt: "2026-08-24T09:42:00Z", balanceAfter: 0, extraTokensAfter: 84, bundleTokensAfter: null },
    { usedAt: "2026-08-22T00:00:00Z", balanceAfter: 10, extraTokensAfter: 84, bundleTokensAfter: 0 },
  ];
  const bal = await getDataDoeTokenBalance({ apiKey: "k", fetchImpl: mkFetch(usageResp(rows)) });
  assert.equal(bal.read, "ok");
  assert.equal(bal.usable, 84, "latest row (2026-08-24) -> 0 + 84 + 0");
  assert.equal(bal.asOf, "2026-08-24T09:42:00Z");
});

test("E2. confirmUsableTokens: >= required confirms; below refuses; a failed/empty/null read is NEVER a confirmation (fail-closed)", () => {
  assert.equal(confirmUsableTokens({ read: "ok", usable: 84 }, 30).confirmed, true);
  assert.equal(confirmUsableTokens({ read: "ok", usable: 30 }, 30).confirmed, true);
  const low = confirmUsableTokens({ read: "ok", usable: 12 }, 30);
  assert.equal(low.confirmed, false); assert.equal(low.reason, "insufficient-tokens");
  assert.equal(confirmUsableTokens({ read: "error", usable: null }, 30).confirmed, false, "read error is not a confirmation");
  assert.equal(confirmUsableTokens({ read: "empty", usable: null }, 30).confirmed, false, "empty log is not a confirmation");
  assert.equal(confirmUsableTokens(null, 30).confirmed, false, "null balance is not a confirmation");
  assert.equal(COMBINED_DAILY_TOKEN_CEILING, 30, "default required = the combined daily ceiling");
});

test("E3. getDataDoeTokenBalance FAILS CLOSED on non-200 / empty / missing key (usable=null, never a bogus number)", async () => {
  const bad = await getDataDoeTokenBalance({ apiKey: "k", fetchImpl: mkFetch({ ok: false, status: 500, json: async () => ({}) }) });
  assert.equal(bad.read, "error"); assert.equal(bad.usable, null);
  const empty = await getDataDoeTokenBalance({ apiKey: "k", fetchImpl: mkFetch(usageResp([])) });
  assert.equal(empty.read, "empty"); assert.equal(empty.usable, null);
  await assert.rejects(() => getDataDoeTokenBalance({ fetchImpl: mkFetch(usageResp([])) }), /apiKey/);
});

group("F. scheduled ASIN Ads: <=5-seller plan, 21-day rolling window, coverage assessment + per-bucket ceiling");

const adsSummary = (n, over = {}) => ({
  status: "completed", coverageMode: true, coverageComplete: true,
  expectedCoveragePairs: n, successfulCoveragePairs: n, deferred: false,
  sources: { "asin-performance-v1": { coverage: n, skipped: 0, rows: 10, failedAccounts: [], coverageFailedAccounts: [] } },
  ...over,
});
const adsBatchesFor = (n) => {
  const ids = Array.from({ length: n }, (_, i) => acct(i + 1));
  const out = [];
  for (let b = 0; b * 5 < n; b += 1) { const batchIds = ids.slice(b * 5, b * 5 + 5); out.push({ accountIds: batchIds, summary: adsSummary(batchIds.length) }); }
  return out;
};

test("F1. ASIN Ads plan: Non-US 22 -> 5 batches/10 tokens; US 8 -> 2 batches/4 tokens (standard export = 2 tokens)", () => {
  const nonus = asinAdsBucketPlan(accountsN(22));
  assert.equal(nonus.expectedBatches, 5); assert.equal(nonus.maxCreates, 5); assert.equal(nonus.maxTokens, 10);
  const us = asinAdsBucketPlan(accountsN(8));
  assert.equal(us.expectedBatches, 2); assert.equal(us.maxCreates, 2); assert.equal(us.maxTokens, 4);
  assert.equal(ASIN_ADS_TOKENS_PER_CREATE, 2);
});

test("F2. ASIN Ads rolling window is EXACTLY 21 inclusive days ending at asOf", () => {
  assert.equal(ASIN_ADS_ROLLING_WINDOW_DAYS, 21);
  const w = asinAdsRefreshWindow("2026-08-24");
  assert.equal(w.to, "2026-08-24");
  assert.equal(w.from, "2026-08-04", "asOf-20 days = 21-day inclusive window");
});

test("F3. combined full Ads refresh ceiling = 7 exports / 14 tokens (US 2/4 + Non-US 5/10)", () => {
  const total = asinAdsBucketPlan(accountsN(8)).maxCreates + asinAdsBucketPlan(accountsN(22)).maxCreates;
  const tokens = asinAdsBucketPlan(accountsN(8)).maxTokens + asinAdsBucketPlan(accountsN(22)).maxTokens;
  assert.equal(total, 7); assert.equal(tokens, 14);
});

test("F4. assessment happy path: every batch completed + full coverage; a WARM run (0 creates, all skipped) is ok", () => {
  const fresh = assessScheduledAsinAdsCycle({ bucket: "us", discoveredAccounts: accountsN(8), batchResults: adsBatchesFor(8), creates: 2 });
  assert.equal(fresh.ok, true, JSON.stringify(fresh.problems));
  assert.equal(fresh.creates, 2); assert.equal(fresh.tokens, 4); assert.equal(fresh.ceilingCreates, 2);
  // WARM: skipped==covered, zero creates -> still ok.
  const warmBatches = adsBatchesFor(8).map((b) => ({ ...b, summary: adsSummary(b.accountIds.length, { sources: { "asin-performance-v1": { coverage: b.accountIds.length, skipped: b.accountIds.length, rows: 0, failedAccounts: [], coverageFailedAccounts: [] } } }) }));
  const warm = assessScheduledAsinAdsCycle({ bucket: "us", discoveredAccounts: accountsN(8), batchResults: warmBatches, creates: 0 });
  assert.equal(warm.ok, true, JSON.stringify(warm.problems));
  assert.equal(warm.creates, 0); assert.equal(warm.tokens, 0);
});

test("F5. assessment rejects every violation: not-completed, coverage-incomplete, non-ASIN source, failed accounts, coverage-failed, over-ceiling, coverage gap, oversized batch", () => {
  const base = () => adsBatchesFor(8);
  const cases = [
    ["a batch not 'completed'", { bucket: "us", discoveredAccounts: accountsN(8), batchResults: base().map((b, i) => i === 0 ? { ...b, summary: adsSummary(b.accountIds.length, { status: "partial" }) } : b), creates: 2 }, /batch-not-completed:partial/],
    ["coverage incomplete", { bucket: "us", discoveredAccounts: accountsN(8), batchResults: base().map((b, i) => i === 0 ? { ...b, summary: adsSummary(b.accountIds.length, { coverageComplete: false }) } : b), creates: 2 }, /batch-coverage-incomplete/],
    ["a non-ASIN source leaked into a batch", { bucket: "us", discoveredAccounts: accountsN(8), batchResults: base().map((b, i) => i === 0 ? { ...b, summary: adsSummary(b.accountIds.length, { sources: { "asin-performance-v1": { coverage: b.accountIds.length, skipped: 0, rows: 1, failedAccounts: [], coverageFailedAccounts: [] }, "campaign-performance-v1": { coverage: 1 } } }) } : b), creates: 2 }, /non-asin-source:campaign-performance-v1/],
    ["a failed account", { bucket: "us", discoveredAccounts: accountsN(8), batchResults: base().map((b, i) => i === 0 ? { ...b, summary: adsSummary(b.accountIds.length, { sources: { "asin-performance-v1": { coverage: b.accountIds.length, skipped: 0, rows: 1, failedAccounts: [b.accountIds[0]], coverageFailedAccounts: [] } } }) } : b), creates: 2 }, /failed-accounts:1/],
    ["a coverage-failed account", { bucket: "us", discoveredAccounts: accountsN(8), batchResults: base().map((b, i) => i === 0 ? { ...b, summary: adsSummary(b.accountIds.length, { sources: { "asin-performance-v1": { coverage: b.accountIds.length, skipped: 0, rows: 1, failedAccounts: [], coverageFailedAccounts: [b.accountIds[0]] } } }) } : b), creates: 2 }, /coverage-failed-accounts:1/],
    ["more creates than the ceiling", { bucket: "us", discoveredAccounts: accountsN(8), batchResults: base(), creates: 3 }, /creates-over-ceiling:3>2/],
    ["a discovered account not covered by any batch", { bucket: "us", discoveredAccounts: accountsN(9), batchResults: adsBatchesFor(8), creates: 2 }, /account-coverage-missing/],
    ["an oversized (>5) batch", { bucket: "us", discoveredAccounts: accountsN(6), batchResults: [{ accountIds: ["A01", "A02", "A03", "A04", "A05", "A06"], summary: adsSummary(6) }], creates: 1 }, /batch-oversized:6/],
  ];
  for (const [name, input, re] of cases) {
    const a = assessScheduledAsinAdsCycle(input);
    assert.equal(a.ok, false, name + " must be rejected");
    assert.ok(a.problems.some((p) => re.test(p)), name + " -> expected " + re + " in " + JSON.stringify(a.problems));
  }
});

group("G. scheduled OLI cycle-identity classification (fix: a same-date terminal priority cycle must never be reused)");

// A complete scheduled OLI cycle for n accounts: ceil(n/5) OLI batch jobs (create=1) with per-account owners.
const oliCompleteCycle = (n) => {
  const ids = Array.from({ length: n }, (_, i) => acct(i + 1));
  const sourceJobs = []; const owners = [];
  for (let b = 0; b * 5 < n; b += 1) {
    const members = ids.slice(b * 5, b * 5 + 5); const h = "oli-" + b;
    sourceJobs.push({ source_key: "order-line-items", request_hash: h, fetch_status: "succeeded", create_export_count: 1 });
    for (const m of members) owners.push({ request_hash: h, account_id: m });
  }
  return { sourceJobs, owners };
};

test("G1. a same-date TERMINAL catalog/priority cycle (0 OLI jobs) + missing coverage -> terminal-refuse; zero jobs cannot pass merely because open=0", () => {
  const cls = classifyScheduledOliCycle({
    bucket: "non-us",
    cycle: { id: "e8d5521f-91fa-446e-bfa0-97e52796024e", bucket: "non-us", status: "succeeded" },
    discoveredAccounts: accountsN(22),
    sourceJobs: [{ source_key: "product-catalog", request_hash: "cat", fetch_status: "succeeded", create_export_count: 1 }],
    owners: [{ request_hash: "cat", account_id: "__organization" }],
  });
  assert.equal(cls.disposition, "terminal-refuse", "the terminal catalog cycle is NOT adopted as an OLI cycle");
  assert.ok(cls.assessment.problems.includes("no-oli-jobs"), "the strict assessment (open=0) still refuses zero OLI jobs");
  assert.ok(cls.assessment.problems.some((p) => p.startsWith("owner-coverage-missing")) || cls.assessment.problems.includes("owner-coverage-missing"), "no owner coverage is fabricated");
});

test("G2. a TERMINAL cycle that IS a complete scheduled OLI run (22 accts -> 5 batches, exact owner union) -> idempotent-complete (same-day replay, zero re-fetch)", () => {
  const { sourceJobs, owners } = oliCompleteCycle(22);
  const cls = classifyScheduledOliCycle({ bucket: "non-us", cycle: { id: "cyc", status: "succeeded" }, discoveredAccounts: accountsN(22), sourceJobs, owners });
  assert.equal(cls.disposition, "idempotent-complete");
  assert.equal(cls.assessment.ok, true, JSON.stringify(cls.assessment.problems));
  assert.equal(cls.assessment.batches, 5, "22 accounts -> exactly 5 OLI batches");
  assert.equal(cls.assessment.creates, 5); assert.equal(cls.assessment.tokens, 10);
});

test("G3. an ABSENT or RUNNING cycle -> run (create/continue OLI); an unexpected status fails closed", () => {
  assert.equal(classifyScheduledOliCycle({ bucket: "non-us", cycle: null }).disposition, "run");
  assert.equal(classifyScheduledOliCycle({ bucket: "non-us", cycle: { id: "c", status: "running" } }).disposition, "run");
  const bad = classifyScheduledOliCycle({ bucket: "non-us", cycle: { id: "c", status: "pending" }, discoveredAccounts: accountsN(22), sourceJobs: [], owners: [] });
  assert.equal(bad.disposition, "refuse");
  assert.match(bad.reason, /unexpected-cycle-status/);
});

test("G4. a terminal cycle with OLI jobs but a MISSING owner (incomplete coverage) -> terminal-refuse (never fabricates owner coverage)", () => {
  const { sourceJobs, owners } = oliCompleteCycle(22);
  const cls = classifyScheduledOliCycle({ bucket: "non-us", cycle: { id: "c", status: "succeeded" }, discoveredAccounts: accountsN(22), sourceJobs, owners: owners.slice(1) });
  assert.equal(cls.disposition, "terminal-refuse");
  assert.ok(cls.assessment.problems.includes("owner-coverage-missing"));
});

test("G5. a terminal cycle whose only jobs are UNRELATED (Ads/FBA) can never satisfy the OLI assessment -> terminal-refuse; the classifier only ever looks at order-line-items", () => {
  const cls = classifyScheduledOliCycle({
    bucket: "us", cycle: { id: "c", status: "partial" }, discoveredAccounts: accountsN(8),
    sourceJobs: [
      { source_key: "ads-asin-date", request_hash: "a", fetch_status: "succeeded", create_export_count: 1 },
      { source_key: "fba-inventory-health", request_hash: "f", fetch_status: "succeeded", create_export_count: 1 },
    ],
    owners: [{ request_hash: "a", account_id: acct(1) }],
  });
  assert.equal(cls.disposition, "terminal-refuse");
  assert.ok(cls.assessment.problems.includes("no-oli-jobs"), "Ads/FBA jobs are not OLI and never adopt the cycle");
});

// ---- run ----
let failures = 0;
for (const t of tests) {
  if (t.marker) { out("== " + t.marker); continue; }
  try { await t.fn(); passed += 1; out("  ok  " + t.name); }
  catch (err) { failures += 1; out("FAIL  " + t.name); out(String(err && err.stack ? err.stack : err)); }
}
out("\n" + passed + " assertions passed" + (failures ? (", " + failures + " FAILED") : ""));
if (failures) process.exitCode = 1;
