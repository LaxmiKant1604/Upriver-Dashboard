// TRUSTED, DEFERRED scheduled ASIN Ads (ads-asin-date) refresh operator for ONE bucket -- a thin CLI over the
// SHARED runner (lib/server/sync/scheduled-asin-ads-runner.js) that the Data Sync Center manual action uses too,
// so the scheduled and manual paths cannot drift. Usage (run from sales-dashboard-live/):
//   node scripts/release/scheduled-asin-ads-refresh.mjs --bucket=us|non-us [--as-of=YYYY-MM-DD] [--page-allowance=N] [--max-creates=N]
//
// The runner enforces: <=5-seller stable batches, US/Non-US never mixed, the zero-token Amazon-Ads connection
// pre-flight (disconnected accounts typed unavailable, never poisoning a batch), the zero-token durable-coverage
// pre-filter (fully covered accounts need ZERO creates), and a guarded create ceiling checked BEFORE every POST.
// A failed create is never auto-retried. Never prints a seller/account/export id.

import { loadReleaseEnv } from "./env-bootstrap.mjs";

loadReleaseEnv(); // portable: loads <repoRoot>/.env.local when present, maps SUPABASE_URL, never overrides CI env

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const bucket = argOf("bucket");
const asOf = argOf("as-of") || (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
const pageAllowance = Math.max(0, Math.trunc(Number(argOf("page-allowance") ?? 1)));
const maxCreatesArg = argOf("max-creates");
if (bucket !== "us" && bucket !== "non-us") { console.error("STOP --bucket must be us|non-us (got: " + bucket + ")"); process.exit(2); }
if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) { console.error("STOP --as-of must be YYYY-MM-DD (got: " + asOf + ")"); process.exit(2); }

const { planAsinAdsBucketRun, runAsinAdsBucketSlice } = await import("../../lib/server/sync/scheduled-asin-ads-runner.js");
const log = (m) => console.log("scheduled-asin-ads[" + bucket + "@" + asOf + "]: " + m);

const plan = await planAsinAdsBucketRun({ bucket, asOf });
log("pre-flight Amazon-Ads connection: " + plan.compatible.length + " compatible, " + plan.incompatible.length + " missing-connection, " + plan.unreadable.length + " unreadable (excluded)");
if (plan.incompatible.length) log("  no Amazon Ads connection (excluded; ads stay unavailable): " + plan.incompatible.map((a) => a.accountId.slice(0, 8) + "(" + a.country + ")").join(" "));
if (plan.unreadable.length) log("  compatible-sources unreadable (excluded this run): " + plan.unreadable.map((a) => a.accountId.slice(0, 8)).join(" "));
log("coverage pre-filter: " + plan.covered.length + " already fully covered (zero creates), " + plan.pending.length + " pending; window [" + plan.window.from + ".." + plan.window.to + "]");

const MAX_PASSES = Number(process.env.SCHEDULED_ASIN_ADS_MAX_ITERS || 40);
let result = null;
for (let pass = 1; pass <= MAX_PASSES; pass += 1) {
  // Re-plan on each pass so the coverage pre-filter reflects work persisted by the previous (deferred) pass.
  const passPlan = pass === 1 ? plan : await planAsinAdsBucketRun({ bucket, asOf });
  result = await runAsinAdsBucketSlice({ bucket, asOf, plan: passPlan, pageAllowance, ...(maxCreatesArg != null ? { maxCreates: Number(maxCreatesArg) } : {}), log });
  if (result.phase === "complete") break;
  if (result.continuationRequired === true) { log("pass " + pass + " deferred (work-budget); resuming"); continue; }
  console.error("STOP scheduled ASIN Ads failed: " + JSON.stringify(result.problems || []));
  process.exit(1);
}
if (!result || result.phase !== "complete") { console.error("STOP scheduled ASIN Ads exhausted " + MAX_PASSES + " passes"); process.exit(1); }
log("PROVEN: covered=" + result.covered + " accounts; " + result.creates + " creates / " + result.tokens + " tokens; " + result.incompatible + " disconnected excluded (typed unavailable).");
process.exit(0);
