// TRUSTED, ONE-TIME ASIN Ads HISTORY BACKFILL for ONE bucket -- brings every Amazon-Ads-connected account to
// CONSISTENT canonical coverage of the DAILY CONTRACT window (monthBackStr(asOf, 5)..asOf), fixing the
// "some accounts show July, others only August" inconsistency (the scheduled runner only extends a 21-day
// rolling window, so recently-seeded accounts never reach the earlier displayed months).
//
//   node scripts/release/asin-ads-history-backfill.mjs --bucket=us|non-us [--as-of=YYYY-MM-DD] [--apply] [--max-creates=N]
//
// It is a thin CLI over the SAME shared runner the scheduled/manual paths use, with a BACKFILL windowOverride:
//   - the zero-token Amazon-Ads connection pre-flight excludes the disconnected accounts (typed unavailable);
//   - the zero-token coverage pre-filter needs ZERO creates for accounts already covering the contract window;
//   - <=5-seller stable batches, US/Non-US never mixed;
//   - adoption of an exact completed export first (zero new tokens), then one wide export per pending batch;
//   - a guarded create ceiling checked BEFORE every POST (frozen from --max-creates); a failed create is never
//     auto-retried. Never prints a seller/account/export id.
// DRY by default (prints the plan + the frozen ceiling, writes nothing). --apply performs the fetch + persist.
// Campaign Ads / FBA are never touched (a frozen ASIN-only grain).

import { loadReleaseEnv } from "./env-bootstrap.mjs";

loadReleaseEnv();

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const bucket = argOf("bucket");
const asOf = argOf("as-of") || (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
const APPLY = process.argv.includes("--apply");
const maxCreatesArg = argOf("max-creates");
if (bucket !== "us" && bucket !== "non-us") { console.error("STOP --bucket must be us|non-us (got: " + bucket + ")"); process.exit(2); }
if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) { console.error("STOP --as-of must be YYYY-MM-DD (got: " + asOf + ")"); process.exit(2); }

const { planAsinAdsBucketRun, runAsinAdsBucketSlice } = await import("../../lib/server/sync/scheduled-asin-ads-runner.js");
const { addDaysStr } = await import("../../lib/server/date-windows.js");
const { MAX_REQUIRED_COVERAGE_DAYS } = await import("../../lib/server/ads-sync.js");

// The ASIN Ads INITIAL coverage window = the source's own initialDays (MAX_REQUIRED_COVERAGE_DAYS, currently 60):
// the deepest canonical history a single reviewed export may request, and the practical limit of Amazon Ads
// reporting (data older than ~60 days is not obtainable). Backfilling every connected account to this SAME window
// makes coverage CONSISTENT (all cover ~late-June..asOf), fixing "some accounts show July, others only August";
// months before it are honestly em-dash (Amazon has no data), uniformly across accounts.
const windowOverride = { from: addDaysStr(asOf, -(MAX_REQUIRED_COVERAGE_DAYS - 1)), to: asOf };
const log = (m) => console.log("asin-ads-backfill[" + bucket + "@" + asOf + "]: " + m);
log("initial coverage backfill window [" + windowOverride.from + ".." + windowOverride.to + "] (" + MAX_REQUIRED_COVERAGE_DAYS + "-day ASIN Ads initial depth)");

const plan = await planAsinAdsBucketRun({ bucket, asOf, windowOverride });
log("connection pre-flight: " + plan.compatible.length + " compatible, " + plan.incompatible.length + " disconnected, " + plan.unreadable.length + " unreadable (excluded)");
if (plan.incompatible.length) log("  disconnected (typed unavailable; not backfilled): " + plan.incompatible.map((a) => a.accountId.slice(0, 8) + "(" + a.country + ")").join(" "));
log("coverage pre-filter vs contract window: " + plan.covered.length + " already covered (zero creates), " + plan.pending.length + " need backfill");

// The frozen create ceiling. The runner groups <=5-account batches BY REGION, so the batch count can exceed
// ceil(pending/5); the safe upper bound is one export per pending account (batching makes it fewer, and the
// runner's own per-invocation bucketPlan.maxCreates is the tighter ceiling checked before every POST). A create
// that would exceed it is refused. --max-creates may only LOWER it.
const upperBound = plan.pending.length;
const ceiling = maxCreatesArg != null ? Math.min(upperBound, Math.max(0, Math.trunc(Number(maxCreatesArg)))) : upperBound;
log("FROZEN ceiling: <=" + ceiling + " creates / <=" + (ceiling * 2) + " tokens for " + plan.pending.length + " pending accounts (region-batched <=5; adoption of an exact completed export spends zero).");

if (!APPLY) {
  log("DRY RUN complete (no writes). Re-run with --apply to fetch + persist the missing complements.");
  process.exit(0);
}

const MAX_PASSES = Number(process.env.ASIN_ADS_BACKFILL_MAX_ITERS || 40);
let result = null;
for (let pass = 1; pass <= MAX_PASSES; pass += 1) {
  // Re-plan each pass so the coverage pre-filter reflects work persisted by a previous (deferred) pass.
  const passPlan = pass === 1 ? plan : await planAsinAdsBucketRun({ bucket, asOf, windowOverride });
  result = await runAsinAdsBucketSlice({ bucket, asOf, windowOverride, plan: passPlan, maxCreates: ceiling, log });
  if (result.phase === "complete") break;
  if (result.continuationRequired === true) { log("pass " + pass + " deferred (work-budget); resuming"); continue; }
  console.error("STOP ASIN Ads backfill failed: " + JSON.stringify(result.problems || []));
  process.exit(1);
}
if (!result || result.phase !== "complete") { console.error("STOP ASIN Ads backfill exhausted " + MAX_PASSES + " passes"); process.exit(1); }
log("PROVEN: covered=" + result.covered + " accounts to the contract window; " + result.creates + " creates / " + result.tokens + " tokens; " + result.incompatible + " disconnected excluded (typed unavailable).");
process.exit(0);
