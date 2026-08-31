// Scheduler v2 -- AUTOMATIC scheduler (GitHub Actions) tests: portable env loading, the scheduled Catalog
// operation key, the daily OLI plan + per-bucket ceilings, the strict post-drain OLI assessment, and the
// workflow cron / single-scheduler pinning. Pure + offline (no network, no DB, no real .env.local read).

import assert from "node:assert/strict";
import { writeSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseEnvFile, applyEnv } from "./release/env-bootstrap.mjs";
import { oliBucketPlan, assessScheduledOliCycle, classifyScheduledOliCycle, assessDurableOliCoverageComplete, OLI_TOKENS_PER_CREATE, scheduledSourceControlPlan, SCHEDULED_ENABLED_SOURCE_KEYS } from "../lib/server/sync/source-scheduled-oli.js";
import { getDataDoeTokenBalance, confirmUsableTokens, COMBINED_DAILY_TOKEN_CEILING, tokenGateDecision, NON_US_RUN_TOKEN_CEILING, US_RUN_TOKEN_CEILING, LOW_BALANCE_WARN_TOKENS } from "../lib/server/datadoe-usage.js";
import { asinAdsBucketPlan, asinAdsRefreshWindow, assessScheduledAsinAdsCycle, ASIN_ADS_TOKENS_PER_CREATE, ASIN_ADS_ROLLING_WINDOW_DAYS } from "../lib/server/sync/source-scheduled-asin-ads.js";
import { fetchCompatibleSourceNames } from "../lib/server/datadoe.js";
import { ARCHIVE_CYCLES, PROTECTED_TABLES, assessArchivePre, assessArchivePost, runArchiveTransaction, assessFrozenSetCoherent } from "../lib/server/sync/source-archive-collision-cycles.js";
import { assessNonUsPrerequisites } from "../lib/server/sync/source-scheduled-prerequisites.js";

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

group("D. GitHub Actions workflow: INDEPENDENT per-bucket publish + always-safe-close shape");

test("D1. scheduler-v2.yml: cron ACTIVE at exactly 02:00 UTC (non-us) + 10:30 UTC (us), bucket resolved FROM the fired cron, dispatch kept, concurrency, Node 24, >=90-min timeout", () => {
  const yml = readFileSync(resolve(WORKFLOWS_DIR, "scheduler-v2.yml"), "utf8");
  assert.match(yml, /workflow_dispatch:/, "manual dispatch kept");
  // Non-US keeps PRIMARY + FALLBACK (02:00/03:00 UTC); US keeps one GitHub primary (10:30 UTC) and uses the
  // independent Cloudflare workflow_dispatch watchdog as its backup.
  const crons = [...yml.matchAll(/- cron:\s*"([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(crons, ["0 2 * * *", "0 3 * * *", "30 10 * * *"], "Non-US primary/fallback + one US GitHub primary");
  // The bucket comes from WHICH cron fired -- deterministic mapping, never inferred from the clock. Primary AND
  // fallback of a bucket map to the SAME bucket.
  assert.match(yml, /"0 2 \* \* \*"\)\s*bucket="non-us"/, "02:00 UTC (primary) maps to non-us");
  assert.match(yml, /"0 3 \* \* \*"\)\s*bucket="non-us"/, "03:00 UTC (fallback) maps to non-us");
  assert.match(yml, /"30 10 \* \* \*"\)\s*bucket="us"/, "10:30 UTC (primary) maps to us");
  assert.doesNotMatch(yml, /30 11 \* \* \*/, "the duplicate US GitHub fallback is removed");
  assert.match(yml, /Unknown cron[^\n]*refusing/, "an unknown cron fails closed");
  assert.doesNotMatch(yml, /only workflow_dispatch is accepted/, "the pause-era dispatch-only gate is gone");
  assert.match(yml, /concurrency:\s*\n\s*group:\s*scheduler-v2/, "single-run concurrency group");
  assert.match(yml, /cancel-in-progress:\s*false/, "runs serialize, never overlap");
  assert.match(yml, /node-version:\s*"24"/, "Node 24");
  const tm = /timeout-minutes:\s*(\d+)/.exec(yml);
  assert.ok(tm && Number(tm[1]) >= 90, "timeout >= 90 minutes");
});

test("D2. workflow shape: INDEPENDENT per-bucket ordered pipeline -- token ceilings, cycle preflight, per-bucket readiness/effectivePublishAsOf, bucket-scoped controls+release, token-gate skip conditionals, and BOTH-bucket always-safe-close", () => {
  const yml = readFileSync(resolve(WORKFLOWS_DIR, "scheduler-v2.yml"), "utf8");
  const idx = (s) => yml.indexOf(s);
  // per-run token ceiling (20 Non-US / 10 US) resolved + passed as --min. NOT increased.
  assert.match(yml, /if \[ "\$bucket" = "non-us" \]; then tokenmin=20; else tokenmin=10; fi/, "per-run ceilings 20/10");
  assert.match(yml, /confirm-token-budget\.mjs --min=\$\{\{ steps\.cfg\.outputs\.tokenmin \}\} --bucket=/, "token gate uses the per-run min");
  // exact order: secrets -> resolve -> npm ci -> cycle preflight -> token gate -> OLI -> ASIN Ads -> readiness ->
  // control apply -> release -> membership rebuild.
  assert.ok(idx("Verify required secrets") < idx("Resolve bucket"), "secrets before resolve");
  assert.ok(idx("npm ci") < idx("scheduled-cycle-preflight.mjs"), "npm ci before cycle preflight");
  assert.ok(idx("scheduled-cycle-preflight.mjs") < idx("confirm-token-budget.mjs"), "cycle preflight before token gate");
  assert.ok(idx("confirm-token-budget.mjs") < idx("oli-refresh-d1.mjs"), "token gate before OLI");
  assert.ok(idx("oli-refresh-d1.mjs") < idx("scheduled-asin-ads-refresh.mjs"), "OLI before ASIN Ads");
  assert.ok(idx("scheduled-asin-ads-refresh.mjs") < idx("verify-bucket-readiness.mjs"), "Ads before the readiness proof");
  assert.ok(idx("verify-bucket-readiness.mjs") < idx("priority-control-package.mjs --apply"), "readiness/effectivePublishAsOf BEFORE opening controls");
  assert.ok(idx("priority-control-package.mjs --apply") < idx("priority-dashboards-release.mjs"), "open controls before release");
  assert.ok(idx("priority-dashboards-release.mjs") < idx("rebuild-brand-membership.mjs"), "release before membership rebuild");
  // The US path NO LONGER depends on the same-day Non-US run -- the old prerequisite gate is gone entirely.
  assert.doesNotMatch(yml, /verify-scheduled-prerequisites/, "US-depends-on-Non-US prerequisite gate removed");
  // Controls + release are BUCKET-SCOPED (no cross-bucket publish): both carry --bucket=<the fired bucket>.
  assert.match(yml, /priority-control-package\.mjs --apply --bucket=\$\{\{ steps\.cfg\.outputs\.bucket \}\}/, "control apply is bucket-scoped");
  assert.match(yml, /priority-dashboards-release\.mjs --bucket=\$\{\{ steps\.cfg\.outputs\.bucket \}\}/, "release is bucket-scoped");
  // Readiness has its own id and computes the honest effectivePublishAsOf, which the release consumes as --as-of.
  assert.match(yml, /id:\s*readiness/, "readiness step exposes an id");
  assert.match(yml, /verify-bucket-readiness\.mjs --bucket=\$\{\{ steps\.cfg\.outputs\.bucket \}\} --requested-as-of=\$\{\{ steps\.cfg\.outputs\.asof \}\}/, "readiness proves the bucket at the requestedAsOf");
  assert.match(yml, /priority-dashboards-release\.mjs --bucket=[^\n]*--as-of=\$\{\{ steps\.readiness\.outputs\.effective_asof \}\}/, "release publishes at the HONEST effectivePublishAsOf, not the requestedAsOf");
  // every create/control step (incl. readiness) is gated on the token-gate proceed output (typed skip => nothing).
  for (const step of ["oli-refresh-d1.mjs", "scheduled-asin-ads-refresh.mjs", "verify-bucket-readiness.mjs", "priority-control-package.mjs --apply", "priority-dashboards-release.mjs", "rebuild-brand-membership.mjs"]) {
    const at = idx(step); const before = yml.slice(Math.max(0, at - 260), at);
    assert.match(before, /steps\.tokengate\.outputs\.proceed == 'true'/, step + " is gated on the token-gate proceed");
  }
  assert.match(yml, /SKIPPED_INSUFFICIENT_TOKENS/, "the run visibly reports the insufficient-tokens skip");
  // safe-close ALWAYS after any pipeline execution; the read-only US duplicate no-op skips this write entirely.
  assert.match(yml, /if:\s*always\(\) && \(steps\.cfg\.outputs\.bucket != 'us' \|\| steps\.us_guard\.outputs\.run_required == 'true'\)\n\s*run:\s*node scripts\/release\/priority-control-package\.mjs --rollback/, "safe-close ALWAYS after a pipeline execution");
  // date-scoped operation key uses the requestedAsOf (shared Catalog reservation across both buckets on a date).
  assert.match(yml, /--operation-key=priority-dashboards\/scheduled\/\$\{\{ steps\.cfg\.outputs\.asof \}\}/, "date-scoped (requestedAsOf) operation key");
  assert.match(yml, /timeout-minutes:\s*(1[0-9][0-9]|[2-9][0-9])/, "job timeout covers OLI+Ads+publication");
  // Campaign Ads / FBA / unrelated reports structurally ABSENT: no run command invokes a campaign/fba/cron script.
  assert.doesNotMatch(yml, /node scripts\/[^\n]*(campaign|fba)/i, "no run step invokes a Campaign Ads / FBA script");
  assert.doesNotMatch(yml, /api\/cron\/sync/, "never drives the deprecated Vercel cron endpoint");
});

test("D3. exactly TWO reviewed scheduled workflows: scheduler-v2 (OLI/Ads) + the DECOUPLED fba-plan-golive (FBA)", () => {
  const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  const scheduled = files.filter((f) => /\n\s*schedule:\s*\n/.test(readFileSync(resolve(WORKFLOWS_DIR, f), "utf8"))).sort();
  // The FBA Shipment Plan refresh is a SEPARATE, DECOUPLED scheduled workflow with its OWN dedicated cycle
  // namespace (us-fba / non-us-fba), so an FBA failure can never block Daily Reporting / Brand View and the
  // scheduler-v2 OLI/Ads schedules stay untouched. No OTHER workflow may declare a schedule (an accidental
  // third scheduled workflow still fails this pin).
  assert.deepEqual(scheduled, ["fba-plan-golive.yml", "scheduler-v2.yml"], "exactly the two reviewed scheduled workflows; got " + JSON.stringify(scheduled));
});

test("D4. previous-day (D-1) freshness shape: refresh_mode input, scheduled-always-normal, force-latest step (run_id, gated on mode + OLI-first), strict D-1 readiness + --strict-d1 release", () => {
  const yml = readFileSync(resolve(WORKFLOWS_DIR, "scheduler-v2.yml"), "utf8");
  const idx = (s) => yml.indexOf(s);
  // refresh_mode is a dispatch-only choice input; a SCHEDULED event is ALWAYS normal (force-latest can never be
  // activated by a schedule).
  assert.match(yml, /refresh_mode:/, "refresh_mode input present");
  assert.match(yml, /type:\s*choice/, "refresh_mode is a choice");
  assert.match(yml, /options:\s*\n\s*- normal\s*\n\s*- force-latest/, "the two modes");
  assert.match(yml, /mode="normal"/, "scheduled resolves to normal");
  assert.match(yml, /A SCHEDULED event is ALWAYS normal/, "documented + enforced scheduled=normal");
  assert.match(yml, /mode="\$\{\{ github\.event\.inputs\.refresh_mode \}\}"/, "dispatch reads the refresh_mode input");
  // the ONE D-1 OLI step (oli-refresh-d1.mjs) carries the refresh_mode + github.run_id (the manual-force identity),
  // supersedes a stale terminal cycle, and runs BEFORE the strict D-1 readiness proof.
  assert.match(yml, /oli-refresh-d1\.mjs[^\n]*--refresh-mode=\$\{\{ steps\.cfg\.outputs\.mode \}\}[^\n]*--run-id=\$\{\{ github\.run_id \}\}/, "the D-1 OLI step carries refresh_mode + github.run_id");
  assert.match(yml, /supersede stale terminal cycle/i, "the OLI step documents the superseding-attempt behavior");
  assert.ok(idx("oli-refresh-d1.mjs") < idx("verify-bucket-readiness.mjs"), "OLI (supersede + fresh fetch) before the D-1 proof");
  assert.ok(idx("oli-refresh-d1.mjs") > 0 && idx("oli-refresh-d1.mjs") < idx("priority-dashboards-release.mjs"), "OLI before publish");
  assert.doesNotMatch(yml, /oli-force-latest\.mjs/, "the separate force-latest step is merged into the one D-1 OLI step");
  // the readiness proof is STRICT D-1 and the publish carries --strict-d1 (never publish a clamped D-2).
  assert.match(yml, /priority-dashboards-release\.mjs[^\n]*--strict-d1/, "release fails closed below D-1");
  // schedules: Non-US primary/fallback + US primary; Cloudflare is the independent US backup.
  const crons = [...yml.matchAll(/- cron:\s*"([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(crons, ["0 2 * * *", "0 3 * * *", "30 10 * * *"], "02:00/03:00 non-us + 10:30 us");
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

test("E4. tokenGateDecision: exact per-run ceilings (Non-US 20 / US 10); proceed / typed skip / fail-closed; low-balance warning", () => {
  assert.equal(NON_US_RUN_TOKEN_CEILING, 20);
  assert.equal(US_RUN_TOKEN_CEILING, 10);
  // proceed at or above required
  assert.equal(tokenGateDecision({ read: "ok", usable: 84 }, 20).decision, "proceed");
  assert.equal(tokenGateDecision({ read: "ok", usable: 20 }, 20).decision, "proceed");
  assert.equal(tokenGateDecision({ read: "ok", usable: 10 }, 10).decision, "proceed");
  // readable-but-insufficient -> typed SAFE SKIP (not a crash)
  const skip = tokenGateDecision({ read: "ok", usable: 12 }, 20);
  assert.equal(skip.decision, "skip"); assert.equal(skip.reason, "insufficient-tokens");
  // unreadable/malformed -> fail closed
  assert.equal(tokenGateDecision({ read: "error", usable: null }, 20).decision, "fail");
  assert.equal(tokenGateDecision(null, 20).decision, "fail");
  // low-balance warning fires below the threshold (84 tokens < 90 = fewer than 3 worst-case days), but still proceeds
  assert.equal(LOW_BALANCE_WARN_TOKENS, 90);
  assert.equal(tokenGateDecision({ read: "ok", usable: 84 }, 20).lowBalance, true);
  assert.equal(tokenGateDecision({ read: "ok", usable: 120 }, 20).lowBalance, false);
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

test("F3c. fetchCompatibleSourceNames: ZERO-TOKEN pre-flight lists an account's compatible source names (fail-closed on a bad read)", async () => {
  const resp = (sources) => ({ ok: true, json: async () => ({ sources }) });
  const has = await fetchCompatibleSourceNames("k", "acc-1", async () => resp([{ name: "Ad Performance by ASIN & Date" }, { name: "Product Catalog by ASIN" }]));
  assert.equal(has.has("ad performance by asin & date"), true, "ASIN Ads source present -> compatible (lowercased)");
  assert.equal(has.has("product catalog by asin"), true);
  const none = await fetchCompatibleSourceNames("k", "acc-2", async () => resp([{ name: "Product Catalog by ASIN" }]));
  assert.equal(none.has("ad performance by asin & date"), false, "no ASIN Ads source -> not compatible (connection missing)");
  let threw = false;
  try { await fetchCompatibleSourceNames("k", "acc-3", async () => ({ ok: false, status: 500 })); } catch { threw = true; }
  assert.equal(threw, true, "a non-ok read throws (caller fails that account closed)");
});

test("F3b. pageAllowance adds create/token headroom for skip-pagination (a high-volume batch needs >1 page)", () => {
  const base = asinAdsBucketPlan(accountsN(17)); // 17 Ads-compatible Non-US accounts -> 4 batches
  assert.equal(base.expectedBatches, 4); assert.equal(base.maxCreates, 4); assert.equal(base.pageAllowance, 0);
  const withPage = asinAdsBucketPlan(accountsN(17), new Map(), { pageAllowance: 1 });
  assert.equal(withPage.expectedBatches, 4); assert.equal(withPage.maxCreates, 5); assert.equal(withPage.maxTokens, 10);
  // A run that paginated ONE batch (5 creates for 4 batches) is within the pageAllowance:1 ceiling, over the base.
  const paged = assessScheduledAsinAdsCycle({ bucket: "non-us", discoveredAccounts: accountsN(17), batchResults: adsBatchesFor(17), creates: 5, pageAllowance: 1 });
  assert.equal(paged.ceilingCreates, 5, "ceiling includes the pagination allowance");
  assert.ok(!paged.problems.includes("creates-over-ceiling:5>5"), "5 creates within the 4-batch + 1-page ceiling");
  const overBase = assessScheduledAsinAdsCycle({ bucket: "non-us", discoveredAccounts: accountsN(17), batchResults: adsBatchesFor(17), creates: 5, pageAllowance: 0 });
  assert.ok(overBase.problems.some((p) => p.startsWith("creates-over-ceiling")), "without the allowance, 5 > 4 is over the ceiling");
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

test("G2. DURABLE COVERAGE decides terminal completion, NOT the OLI-job shape: a complete-OLI-run cycle with coverage BELOW D-1 is STALE -> supersede (never idempotent on job-shape alone); with coverage through D-1 -> idempotent", () => {
  const { sourceJobs, owners } = oliCompleteCycle(22);
  // Complete OLI jobs BUT durable coverage only through D-2 -> the cycle is stale evidence -> SUPERSEDE.
  const belowD1 = assessDurableOliCoverageComplete({ discoveredAccounts: accountsN(22), coverageByAccountId: Object.fromEntries(accountsN(22).map((a) => [a.accountId, [{ from: "2025-01-01", to: "2026-08-25" }]])), start: "2025-01-01", asOf: "2026-08-26" });
  const stale = classifyScheduledOliCycle({ bucket: "non-us", cycle: { id: "cyc", status: "succeeded" }, discoveredAccounts: accountsN(22), sourceJobs, owners, durableCoverage: belowD1 });
  assert.equal(stale.disposition, "supersede", "a complete OLI run whose coverage is below D-1 is NEVER idempotent -- it is stale");
  assert.equal(stale.missingAccounts.length, 22, "every account is behind D-1");
  // The SAME cycle once coverage proves through D-1 -> idempotent-complete (zero re-fetch).
  const throughD1 = assessDurableOliCoverageComplete({ discoveredAccounts: accountsN(22), coverageByAccountId: Object.fromEntries(accountsN(22).map((a) => [a.accountId, [{ from: "2025-01-01", to: "2026-08-26" }]])), start: "2025-01-01", asOf: "2026-08-26" });
  const done = classifyScheduledOliCycle({ bucket: "non-us", cycle: { id: "cyc", status: "succeeded" }, discoveredAccounts: accountsN(22), sourceJobs, owners, durableCoverage: throughD1 });
  assert.equal(done.disposition, "idempotent-complete"); assert.equal(done.reason, "durable-coverage-complete");
});

test("G1b. DURABLE-COVERAGE authority: complete->idempotent-complete; below D-1->supersede (stale, never blocked); unreadable(null)->terminal-refuse (fail closed)", () => {
  const cat = { sourceJobs: [{ source_key: "product-catalog", request_hash: "cat", fetch_status: "succeeded", create_export_count: 1 }], owners: [{ request_hash: "cat", account_id: "__organization" }] };
  const coverageByAccountId = Object.fromEntries(accountsN(22).map((a) => [a.accountId, [{ from: "2025-01-01", to: "2026-08-25" }]]));
  const cov = assessDurableOliCoverageComplete({ discoveredAccounts: accountsN(22), coverageByAccountId, start: "2025-01-01", asOf: "2026-08-25" });
  assert.equal(cov.complete, true, "all 22 accounts prove [2025-01-01..asOf]");
  const cls = classifyScheduledOliCycle({ bucket: "non-us", cycle: { id: "c", status: "succeeded" }, discoveredAccounts: accountsN(22), ...cat, durableCoverage: cov });
  assert.equal(cls.disposition, "idempotent-complete", "complete durable coverage -> zero-create success");
  assert.equal(cls.reason, "durable-coverage-complete");
  // INCOMPLETE coverage (below D-1) -> SUPERSEDE (stale terminal evidence; never refuse/block).
  const short = assessDurableOliCoverageComplete({ discoveredAccounts: accountsN(22), coverageByAccountId: { ...coverageByAccountId, [accountsN(22)[0].accountId]: [{ from: "2025-01-01", to: "2026-08-20" }] }, start: "2025-01-01", asOf: "2026-08-25" });
  assert.equal(short.complete, false); assert.equal(short.missingAccounts.length, 1);
  const sup = classifyScheduledOliCycle({ bucket: "non-us", cycle: { id: "c", status: "succeeded" }, discoveredAccounts: accountsN(22), ...cat, durableCoverage: short });
  assert.equal(sup.disposition, "supersede", "incomplete coverage supersedes the stale terminal cycle");
  assert.equal(sup.missingAccounts.length, 1);
  // UNREADABLE coverage (null) fails closed -- never classify freshness without evidence.
  const strict = classifyScheduledOliCycle({ bucket: "non-us", cycle: { id: "c", status: "succeeded" }, discoveredAccounts: accountsN(22), ...cat, durableCoverage: null });
  assert.equal(strict.disposition, "terminal-refuse");
});

test("G3. an ABSENT / RUNNING / PENDING cycle -> run (create/continue OLI); a truly unexpected status fails closed", () => {
  assert.equal(classifyScheduledOliCycle({ bucket: "non-us", cycle: null }).disposition, "run");
  assert.equal(classifyScheduledOliCycle({ bucket: "non-us", cycle: { id: "c", status: "running" } }).disposition, "run");
  assert.equal(classifyScheduledOliCycle({ bucket: "non-us", cycle: { id: "c", status: "pending" }, discoveredAccounts: accountsN(22), sourceJobs: [], owners: [] }).disposition, "run", "a pending base cycle runs");
  const bad = classifyScheduledOliCycle({ bucket: "non-us", cycle: { id: "c", status: "archived" }, discoveredAccounts: accountsN(22), sourceJobs: [], owners: [] });
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

group("H. fixed-identity archival of the 6 future-dated collision cycles (dry-run/apply, exact PRE/POST, idempotent)");

const archiveBundlePre = (over = {}) => {
  const cyclesById = {};
  for (const a of ARCHIVE_CYCLES) cyclesById[a.cycleId] = { id: a.cycleId, bucket: a.expectedBucket, cycleDateText: a.currentDate, status: a.expectedStatus, trigger: a.expectedTrigger, counts: { sourceJobs: a.sourceJobCount, owners: a.ownerCount, reportJobs: a.reportJobCount } };
  const currentSlotNonUsCount = {}; const targetSlotCount = {};
  for (const a of ARCHIVE_CYCLES) { currentSlotNonUsCount[a.currentDate] = 1; targetSlotCount[a.targetDate] = 0; }
  const digests = {}; for (const t of PROTECTED_TABLES) digests[t] = { c: 1, h: "h-" + t };
  return { cyclesById, currentSlotNonUsCount, targetSlotCount, controls: { allPrimary: false, cron: false, enabledRollout: 0, enabledDispatch: 0, enabledPromoted: 0, approvedCount: 0 }, syncCyclesRowCount: 23, digests, ...over };
};
const archiveBundlePost = (pre) => {
  const cyclesById = {}; const currentSlotNonUsCount = {}; const targetSlotCount = {};
  for (const a of ARCHIVE_CYCLES) { cyclesById[a.cycleId] = { ...pre.cyclesById[a.cycleId], cycleDateText: a.targetDate }; currentSlotNonUsCount[a.currentDate] = 0; targetSlotCount[a.targetDate] = 1; }
  return { ...pre, cyclesById, currentSlotNonUsCount, targetSlotCount };
};

test("H0. the frozen archival set is coherent: 6 cycles, distinct ids + distinct current/target dates, all plain ISO, target != current", () => {
  assert.equal(ARCHIVE_CYCLES.length, 6);
  assert.deepEqual(assessFrozenSetCoherent(), []);
  assert.equal(new Set(ARCHIVE_CYCLES.map((a) => a.targetDate)).size, 6);
  assert.ok(ARCHIVE_CYCLES.every((a) => /^2026-01-0[2-7]$/.test(a.targetDate)), "targets are free Jan-2026 dates");
});

test("H1. assessArchivePre: the exact frozen collision set has ZERO problems", () => {
  assert.deepEqual(assessArchivePre(archiveBundlePre()), []);
});

test("H2. assessArchivePre refuses EVERY footprint mismatch (wrong date/status/counts, occupied target, double current slot, open controls, missing cycle)", () => {
  const cases = [
    ["wrong current date", (b) => { b.cyclesById[ARCHIVE_CYCLES[0].cycleId].cycleDateText = "2026-08-24"; }, /cycle-date-not-current-slot/],
    ["wrong status", (b) => { b.cyclesById[ARCHIVE_CYCLES[0].cycleId].status = "succeeded"; }, /status-not-expected/],
    ["wrong source-job count", (b) => { b.cyclesById[ARCHIVE_CYCLES[0].cycleId].counts.sourceJobs = 999; }, /source-jobs-count/],
    ["wrong owner count", (b) => { b.cyclesById[ARCHIVE_CYCLES[4].cycleId].counts.owners = 1; }, /owners-count/],
    ["target occupied", (b) => { b.targetSlotCount[ARCHIVE_CYCLES[0].targetDate] = 1; }, /target-slot-occupied/],
    ["current slot has 2", (b) => { b.currentSlotNonUsCount[ARCHIVE_CYCLES[0].currentDate] = 2; }, /current-slot-not-exactly-one/],
    ["controls open", (b) => { b.controls.approvedCount = 1; }, /controls-not-safe-closed/],
    ["cycle missing", (b) => { delete b.cyclesById[ARCHIVE_CYCLES[5].cycleId]; }, /cycle-not-found/],
  ];
  for (const [name, mut, re] of cases) {
    const b = archiveBundlePre(); mut(b);
    assert.ok(assessArchivePre(b).some((x) => re.test(x)), name + " -> " + re);
  }
});

test("H3. assessArchivePost: a correct move has ZERO problems; a changed protected digest / unmoved cycle / bad row count / changed sync_cycles count refuses", () => {
  const pre = archiveBundlePre();
  const rc = ARCHIVE_CYCLES.map(() => 1);
  assert.deepEqual(assessArchivePost(pre, archiveBundlePost(pre), rc), []);
  const post2 = archiveBundlePost(pre); post2.digests = { ...pre.digests, source_oli_daily_history: { c: 99, h: "count-only" } };
  assert.ok(assessArchivePost(pre, post2, rc).some((x) => /protected-digest-changed:source_oli_daily_history/.test(x)), "OLI history change caught");
  const post3 = archiveBundlePost(pre); post3.cyclesById[ARCHIVE_CYCLES[0].cycleId].cycleDateText = ARCHIVE_CYCLES[0].currentDate;
  assert.ok(assessArchivePost(pre, post3, rc).some((x) => /post-cycle-date-not-target/.test(x)));
  assert.ok(assessArchivePost(pre, archiveBundlePost(pre), rc.map((v, i) => (i === 0 ? 0 : v))).some((x) => /row-count-not-1/.test(x)));
  assert.ok(assessArchivePost(pre, { ...archiveBundlePost(pre), syncCyclesRowCount: 22 }, rc).some((x) => /sync_cycles-row-count-changed/.test(x)));
});

test("H4. runArchiveTransaction: dry-run writes nothing; apply commits on exact PRE/POST; PRE/POST mismatch rolls back (code 1); COMMIT_UNKNOWN never rolls back (code 3)", async () => {
  const dry = await runArchiveTransaction({ store: { readEvidence: async () => archiveBundlePre(), begin: async () => {} }, mode: "dry-run" });
  assert.equal(dry.dryRun, true); assert.equal(dry.code, 0);
  const okStore = () => ({ _s: 0, begin: async () => {}, commit: async () => {}, rollback: async () => {}, readEvidence: async function () { this._s += 1; const pre = archiveBundlePre(); return this._s === 1 ? pre : archiveBundlePost(pre); }, update: async () => ARCHIVE_CYCLES.map(() => 1) });
  const okr = await runArchiveTransaction({ store: okStore(), mode: "apply" });
  assert.equal(okr.committed, true); assert.equal(okr.code, 0);
  const badPre = { begin: async () => {}, commit: async () => {}, rollback: async () => {}, readEvidence: async () => { const b = archiveBundlePre(); b.controls.approvedCount = 1; return b; }, update: async () => ARCHIVE_CYCLES.map(() => 1) };
  const pr = await runArchiveTransaction({ store: badPre, mode: "apply" });
  assert.equal(pr.committed, false); assert.equal(pr.code, 1); assert.match(pr.problem, /PRE:/);
  const badPost = { _s: 0, begin: async () => {}, commit: async () => {}, rollback: async () => {}, readEvidence: async function () { this._s += 1; const pre = archiveBundlePre(); if (this._s === 1) return pre; const post = archiveBundlePost(pre); post.cyclesById[ARCHIVE_CYCLES[0].cycleId].cycleDateText = ARCHIVE_CYCLES[0].currentDate; return post; }, update: async () => ARCHIVE_CYCLES.map(() => 1) };
  const por = await runArchiveTransaction({ store: badPost, mode: "apply" });
  assert.equal(por.committed, false); assert.equal(por.code, 1); assert.match(por.problem, /POST:/);
  let rolled = 0;
  const cuStore = { _s: 0, begin: async () => {}, commit: async () => { throw new Error("lost ack"); }, rollback: async () => { rolled += 1; }, readEvidence: async function () { this._s += 1; const pre = archiveBundlePre(); return this._s === 1 ? pre : archiveBundlePost(pre); }, update: async () => ARCHIVE_CYCLES.map(() => 1) };
  const cur = await runArchiveTransaction({ store: cuStore, mode: "apply" });
  assert.equal(cur.commitUnknown, true); assert.equal(cur.code, 3); assert.equal(rolled, 0, "COMMIT_UNKNOWN never rolls back");
});

test("H5. idempotency: after the move the PRE no longer matches (cycles at target dates) so a re-apply REFUSES", () => {
  const b = archiveBundlePre();
  for (const a of ARCHIVE_CYCLES) { b.cyclesById[a.cycleId].cycleDateText = a.targetDate; b.currentSlotNonUsCount[a.currentDate] = 0; b.targetSlotCount[a.targetDate] = 1; }
  const p = assessArchivePre(b);
  assert.ok(p.length > 0 && p.some((x) => /cycle-date-not-current-slot/.test(x)), "a second apply is refused");
});

group("I. US-depends-on-Non-US prerequisite gate (fail-closed before any US create/control)");

const readyPerAccount = (n, over = () => ({})) => Array.from({ length: n }, (_, i) => ({ accountId: acct(i + 1), oliCoveredTo: "2026-08-23", oliGapless: true, oliProvenanceOk: true, oliFailedOrOpen: false, adsWindowCovered: true, adsFailed: false, ...over(i) }));
const completeCycleAssess = () => ({ ok: true, problems: [] });

test("I1. all 22 Non-US accounts covered + a complete Non-US OLI cycle -> ready (US may proceed)", () => {
  const r = assessNonUsPrerequisites({ asOf: "2026-08-23", discoveredAccounts: accountsN(22), perAccount: readyPerAccount(22), cyclePresent: true, cycleOliAssessment: completeCycleAssess() });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.accounts, 22);
});

test("I2. rejects EVERY incompleteness: short coverage, interior gap, blank provenance, ads gap, failed OLI/Ads, missing/incomplete Non-US cycle, isolation breach", () => {
  const base = () => ({ asOf: "2026-08-23", discoveredAccounts: accountsN(22), perAccount: readyPerAccount(22), cyclePresent: true, cycleOliAssessment: completeCycleAssess() });
  const cases = [
    ["OLI coverage short", (i) => { i.perAccount[0].oliCoveredTo = "2026-08-22"; }, /oli-coverage-short/],
    ["OLI interior gap", (i) => { i.perAccount[1].oliGapless = false; }, /oli-coverage-gap/],
    ["blank OLI provenance", (i) => { i.perAccount[2].oliProvenanceOk = false; }, /oli-provenance-blank/],
    ["ASIN-Ads window incomplete", (i) => { i.perAccount[3].adsWindowCovered = false; }, /ads-coverage-incomplete/],
    ["failed/open OLI work", (i) => { i.perAccount[4].oliFailedOrOpen = true; }, /oli-failed-or-open/],
    ["failed ASIN-Ads", (i) => { i.perAccount[5].adsFailed = true; }, /ads-failed/],
    ["an account has NO evidence", (i) => { i.perAccount = i.perAccount.slice(0, 21); }, /account-missing-evidence/],
    ["evidence account outside discovery", (i) => { i.perAccount.push({ accountId: "STRANGER", oliCoveredTo: "2026-08-23", oliGapless: true, oliProvenanceOk: true, adsWindowCovered: true }); }, /evidence-account-outside-discovery/],
  ];
  for (const [name, mut, re] of cases) {
    const input = base(); mut(input);
    const r = assessNonUsPrerequisites(input);
    assert.equal(r.ok, false, name + " must block US");
    assert.ok(r.problems.some((p) => re.test(p)), name + " -> " + re + " in " + JSON.stringify(r.problems.slice(0, 4)));
  }
});

test("I2b. EVIDENCE-FIRST cycle shape: green durable evidence + missing/manual-shape cycle -> ok WITH a note; broken evidence still reports the cycle problems", () => {
  const base = () => ({ asOf: "2026-08-23", discoveredAccounts: accountsN(22), perAccount: readyPerAccount(22), cyclePresent: true, cycleOliAssessment: completeCycleAssess() });
  // A same-asOf MANUAL Non-US operation (no scheduled cycle / a non-OLI-shape cycle) with COMPLETE durable
  // evidence must NOT strand the US run -- the US derive reads the durable evidence, which is green.
  const noCycle = base(); noCycle.cyclePresent = false;
  let r = assessNonUsPrerequisites(noCycle);
  assert.equal(r.ok, true, "complete durable evidence w/o a cycle is ready: " + JSON.stringify(r.problems));
  assert.ok((r.notes || []).some((n) => /nonus-cycle-missing/.test(n)), "the missing cycle is NOTED, not fatal");
  const oddCycle = base(); oddCycle.cycleOliAssessment = { ok: false, problems: ["no-oli-jobs"] };
  r = assessNonUsPrerequisites(oddCycle);
  assert.equal(r.ok, true, "a non-scheduled-shape cycle with green evidence is ready");
  assert.ok((r.notes || []).some((n) => /nonus-cycle-oli-incomplete/.test(n)));
  // BROKEN durable evidence: the cycle problems are reported alongside (they locate the gap) and US stays blocked.
  const broken = base(); broken.perAccount[0].oliCoveredTo = "2026-08-20"; broken.cyclePresent = false;
  r = assessNonUsPrerequisites(broken);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /oli-coverage-short/.test(p)) && r.problems.some((p) => /nonus-cycle-missing/.test(p)), "evidence + cycle problems both reported when evidence is broken");
});

test("I2c. ads-DISCONNECTED accounts are TYPED UNAVAILABLE: never a blocker (noted), while a CONNECTED account's ads gap still blocks", () => {
  // The five Amazon-Ads-disconnected accounts: no ASIN-Ads source on the connection -> adsUnavailable=true.
  // Their missing coverage / poisoned failed state must NOT strand the US run; they join automatically once
  // connected (adsUnavailable flips false and the ordinary checks resume).
  const withDisconnected = readyPerAccount(22, (i) => (i < 5 ? { adsUnavailable: true, adsWindowCovered: false, adsFailed: true } : {}));
  let r = assessNonUsPrerequisites({ asOf: "2026-08-23", discoveredAccounts: accountsN(22), perAccount: withDisconnected, cyclePresent: true, cycleOliAssessment: completeCycleAssess() });
  assert.equal(r.ok, true, "disconnected ads never block: " + JSON.stringify(r.problems.slice(0, 4)));
  assert.ok((r.notes || []).some((n) => /ads-unavailable-note/.test(n)), "typed unavailable is NOTED");
  // The same gaps on a CONNECTED account still block (adsUnavailable false/absent keeps every check).
  const connectedGap = readyPerAccount(22, (i) => (i === 0 ? { adsUnavailable: false, adsWindowCovered: false, adsFailed: true } : {}));
  r = assessNonUsPrerequisites({ asOf: "2026-08-23", discoveredAccounts: accountsN(22), perAccount: connectedGap, cyclePresent: true, cycleOliAssessment: completeCycleAssess() });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /ads-coverage-incomplete/.test(p)) && r.problems.some((p) => /ads-failed/.test(p)), "connected gaps still fail closed");
  // An OLI problem on a disconnected account still blocks (only the ads checks are downgraded).
  const oliBroken = readyPerAccount(22, (i) => (i === 0 ? { adsUnavailable: true, adsWindowCovered: false, oliGapless: false } : {}));
  r = assessNonUsPrerequisites({ asOf: "2026-08-23", discoveredAccounts: accountsN(22), perAccount: oliBroken, cyclePresent: true, cycleOliAssessment: completeCycleAssess() });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /oli-coverage-gap/.test(p)), "OLI checks apply to disconnected accounts unchanged");
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
