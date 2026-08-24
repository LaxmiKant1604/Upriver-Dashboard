// Scheduler v2 -- AUTOMATIC scheduler (GitHub Actions) tests: portable env loading, the scheduled Catalog
// operation key, the daily OLI plan + per-bucket ceilings, the strict post-drain OLI assessment, and the
// workflow cron / single-scheduler pinning. Pure + offline (no network, no DB, no real .env.local read).

import assert from "node:assert/strict";
import { writeSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseEnvFile, applyEnv } from "./release/env-bootstrap.mjs";
import { oliBucketPlan, assessScheduledOliCycle, OLI_TOKENS_PER_CREATE, scheduledSourceControlPlan, SCHEDULED_ENABLED_SOURCE_KEYS } from "../lib/server/sync/source-scheduled-oli.js";

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

test("B5. durable source_controls target: ONLY order-line-items + product-catalog are schedule-enabled + unpaused; every other source is schedule-disabled", () => {
  const allKeys = ["order-line-items", "product-catalog", "settlements", "returns", "fba-inventory-health", "ads-campaign-date", "listings", "content-changes"];
  const plan = scheduledSourceControlPlan(allKeys);
  const enabled = plan.filter((p) => p.scheduleEnabled === true).map((p) => p.sourceKey).sort();
  assert.deepEqual(enabled, [...SCHEDULED_ENABLED_SOURCE_KEYS].sort(), "exactly OLI + catalog enabled");
  for (const p of plan) {
    if (SCHEDULED_ENABLED_SOURCE_KEYS.includes(p.sourceKey)) { assert.equal(p.scheduleEnabled, true); assert.equal(p.paused, false, p.sourceKey + " unpaused"); }
    else { assert.equal(p.scheduleEnabled, false, p.sourceKey + " schedule-disabled"); assert.equal(p.paused, undefined, p.sourceKey + " paused state left untouched"); }
  }
  // Ads/FBA/settlements/returns are NEVER schedule-enabled by this scheduler.
  for (const forbidden of ["ads-campaign-date", "fba-inventory-health", "settlements", "returns"]) {
    assert.ok(!enabled.includes(forbidden), forbidden + " must never be scheduled");
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

test("D2. the US path refreshes OLI, opens controls, publishes under the DATE-SCOPED key, and ALWAYS safe-closes", () => {
  const yml = readFileSync(resolve(WORKFLOWS_DIR, "scheduler-v2.yml"), "utf8");
  assert.match(yml, /scheduled-oli-refresh\.mjs --bucket=\$\{\{ steps\.cfg\.outputs\.bucket \}\} --as-of=/, "OLI refresh runs for the resolved bucket");
  assert.match(yml, /priority-control-package\.mjs --apply/, "US run opens publication controls");
  assert.match(yml, /priority-dashboards-release\.mjs --as-of=[^\n]*--operation-key=priority-dashboards\/scheduled\//, "release uses the date-scoped operation key");
  assert.match(yml, /if:\s*always\(\)\s*&&\s*steps\.cfg\.outputs\.bucket == 'us'\n\s*run:\s*node scripts\/release\/priority-control-package\.mjs --rollback/, "safe-close ALWAYS runs on the US path");
  // The workflow is the sole timing authority: it never invokes the deprecated Vercel cron sync endpoint.
  assert.doesNotMatch(yml, /api\/cron\/sync/, "does not drive the deprecated Vercel cron endpoint");
});

test("D3. single-scheduler rule: EXACTLY ONE workflow file declares a schedule: trigger", () => {
  const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  const scheduled = files.filter((f) => /\n\s*schedule:\s*\n/.test(readFileSync(resolve(WORKFLOWS_DIR, f), "utf8")));
  assert.deepEqual(scheduled, ["scheduler-v2.yml"], "only scheduler-v2.yml schedules; got " + JSON.stringify(scheduled));
});

// ---- run ----
let failures = 0;
for (const t of tests) {
  if (t.marker) { out("== " + t.marker); continue; }
  try { t.fn(); passed += 1; out("  ok  " + t.name); }
  catch (err) { failures += 1; out("FAIL  " + t.name); out(String(err && err.stack ? err.stack : err)); }
}
out("\n" + passed + " assertions passed" + (failures ? (", " + failures + " FAILED") : ""));
if (failures) process.exitCode = 1;
