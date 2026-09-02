// TRUSTED Campaign Ads (campaign-performance-v1) go-live operator -- a thin CLI over the shared region-aware runner
// (lib/server/sync/scheduled-campaign-ads-runner.js). Runs in GitHub Actions with the repository secrets; never
// downloads a Vercel secret and never prints an api key or seller/account/export id. Usage (from sales-dashboard-live/):
//   node scripts/release/campaign-ads-golive.mjs --mode=dry-run [--run-kind=initial|daily|monthly] [--as-of=YYYY-MM-DD] [--max-tokens=40]
//   node scripts/release/campaign-ads-golive.mjs --mode=apply   [--region=all|india|europe-au|us-ca] [--run-kind=...] [--as-of=...] [--max-tokens=40]
//
// dry-run: ZERO creates. Discovers + routes every live account into the three regions, computes the deterministic
//   <=5-seller batches, the exports/source, the token price, the exact worst-case cost, and the current usable
//   balance; prints the plan + a create_authorized decision (price known AND cost <= max-tokens AND balance >= cost).
// apply:   RE-RUNS the dry-run gate first and REFUSES (exit 1) unless create_authorized. Then runs the region
//   slices under a hard per-region create ceiling (coverage pre-filter -> already-covered accounts create nothing,
//   so replay adopts completed work and spends zero duplicate tokens), and asserts total tokens <= max-tokens.
// UNASSIGNED (unknown-marketplace) accounts are ALWAYS listed as an alert and are NEVER exported.

import { appendFileSync } from "node:fs";
import { loadReleaseEnv } from "./env-bootstrap.mjs";

loadReleaseEnv(); // portable: loads <repoRoot>/.env.local when present, maps SUPABASE_URL, never overrides CI env

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const mode = (argOf("mode") || "dry-run").toLowerCase();
const runKind = (argOf("run-kind") || "initial").toLowerCase();
const regionArg = (argOf("region") || "all").toLowerCase();
const asOf = argOf("as-of") || (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
const maxTokens = Math.max(0, Math.trunc(Number(argOf("max-tokens") ?? 40)));

if (mode !== "dry-run" && mode !== "apply") { console.error("STOP --mode must be dry-run|apply (got: " + mode + ")"); process.exit(2); }
if (!["initial", "daily", "monthly"].includes(runKind)) { console.error("STOP --run-kind must be initial|daily|monthly (got: " + runKind + ")"); process.exit(2); }
if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) { console.error("STOP --as-of must be YYYY-MM-DD (got: " + asOf + ")"); process.exit(2); }

const {
  REGIONS, REGION_SCHEDULE,
} = await import("../../lib/server/sync/campaign-region-routing.js");
const {
  planCampaignAdsDryRun, planCampaignAdsRegionRun, runCampaignAdsRegionSlice,
  CAMPAIGN_ADS_TOKENS_PER_CREATE,
} = await import("../../lib/server/sync/scheduled-campaign-ads-runner.js");

const ALL_REGIONS = [REGIONS.INDIA, REGIONS.EUROPE_AU, REGIONS.US_CA];
if (regionArg !== "all" && !ALL_REGIONS.includes(regionArg)) { console.error("STOP --region must be all|india|europe-au|us-ca (got: " + regionArg + ")"); process.exit(2); }
const regions = regionArg === "all" ? ALL_REGIONS : [regionArg];

const ghOut = (k, v) => { const f = process.env.GITHUB_OUTPUT; if (f) { try { appendFileSync(f, k + "=" + v + "\n"); } catch { /* ignore */ } } };
const ghSum = (s) => { const f = process.env.GITHUB_STEP_SUMMARY; if (f) { try { appendFileSync(f, s + "\n"); } catch { /* ignore */ } } console.log(s); };
const log = (m) => console.log("campaign-ads-golive[" + mode + "/" + runKind + "@" + asOf + "]: " + m);

// ---- The mandatory zero-create dry-run + gate (runs for BOTH modes; apply refuses unless authorized). ----
const dry = await planCampaignAdsDryRun({ asOf, runKind, tokenPrice: CAMPAIGN_ADS_TOKENS_PER_CREATE, maxTokens });

ghSum("### Campaign Ads " + mode + " -- " + runKind + " @ " + asOf);
ghSum("- source: **Ad Performance by Campaign & Date** (`campaign-performance-v1`) -- STANDARD, " + dry.tokenPrice + " tokens/export");
ghSum("- window: [" + dry.window.from + " .. " + dry.window.to + "] (" + dry.window.days + " days) · discovered accounts: **" + dry.accountCount + "**");
for (const rp of dry.plan.regions) {
  const sch = REGION_SCHEDULE[rp.region];
  ghSum("- region **" + rp.label + "** (primary " + sch.primaryUtc + " UTC / watchdog " + sch.watchdogUtc + " UTC): " + rp.accountCount + " accounts -> " + rp.batchCount + " batch(es) of <=5 sellers");
}
ghSum("- worst-case exports: **" + dry.plan.exportCount + "** · max token spend: **" + dry.plan.maxTokenSpend + "** (<= " + maxTokens + "? **" + dry.withinCeiling + "**)");
ghSum("- usable DataDoe balance: **" + (dry.balanceProven ? dry.balance : "UNREADABLE (" + dry.balanceRead + ")") + "** · sufficient? **" + dry.balanceSufficient + "**");
ghSum("- **create_authorized: " + dry.createAuthorized + "**" + (dry.createAuthorized ? "" : " (price/ceiling/balance not all proven -> refuse)"));
if (dry.unassigned.length) {
  ghSum("- :warning: **UNASSIGNED (unknown marketplace) -- SKIPPED, never exported, admin action required:** " + dry.unassigned.map((u) => u.accountId.slice(0, 8) + "(" + (u.marketplace || "blank") + ")").join(" "));
}
ghOut("create_authorized", String(dry.createAuthorized));
ghOut("export_count", String(dry.plan.exportCount));
ghOut("max_token_spend", String(dry.plan.maxTokenSpend));
ghOut("usable_balance", String(dry.balanceProven ? dry.balance : ""));
ghOut("unassigned_count", String(dry.unassigned.length));

if (mode === "dry-run") {
  log("DRY-RUN complete (ZERO creates). exports=" + dry.plan.exportCount + " maxTokens=" + dry.plan.maxTokenSpend + " balance=" + (dry.balanceProven ? dry.balance : "unreadable") + " create_authorized=" + dry.createAuthorized + " unassigned=" + dry.unassigned.length);
  process.exit(0);
}

// ---- apply: refuse unless the dry-run gate authorized the create. ----
if (!dry.createAuthorized) {
  console.error("STOP create NOT authorized: price=" + dry.tokenPrice + " withinCeiling(<=" + maxTokens + ")=" + dry.withinCeiling + " balanceProven=" + dry.balanceProven + " balanceSufficient=" + dry.balanceSufficient + " -- creating nothing (fail closed).");
  process.exit(1);
}

const MAX_PASSES = Number(process.env.CAMPAIGN_ADS_MAX_ITERS || 40);
let totalCreates = 0; let totalTokens = 0; const proven = [];
for (const region of regions) {
  const regionLabel = REGION_SCHEDULE[region].label;
  let result = null;
  for (let pass = 1; pass <= MAX_PASSES; pass += 1) {
    const passPlan = await planCampaignAdsRegionRun({ region, asOf, runKind });
    // Per-region create ceiling = this region's pending batch count; the global token cap is enforced after.
    result = await runCampaignAdsRegionSlice({ region, asOf, runKind, plan: passPlan, log });
    if (result.phase === "complete") break;
    if (result.continuationRequired === true) { log(regionLabel + " pass " + pass + " deferred (work-budget); resuming"); continue; }
    console.error("STOP Campaign Ads region " + regionLabel + " failed: " + JSON.stringify(result.problems || []));
    process.exit(1);
  }
  if (!result || result.phase !== "complete") { console.error("STOP Campaign Ads region " + regionLabel + " exhausted " + MAX_PASSES + " passes"); process.exit(1); }
  totalCreates += result.creates; totalTokens += result.tokens;
  proven.push({ region: regionLabel, covered: result.covered, creates: result.creates, tokens: result.tokens, incompatible: result.incompatible });
  log("region " + regionLabel + " PROVEN: covered=" + result.covered + " creates=" + result.creates + " tokens=" + result.tokens + " (disconnected excluded=" + result.incompatible + ")");
  // Belt-and-suspenders: never exceed the authorized token ceiling even across regions.
  if (totalTokens > maxTokens) { console.error("STOP total tokens " + totalTokens + " > authorized " + maxTokens + " (fail closed)"); process.exit(1); }
}

ghSum("### Campaign Ads apply -- PROVEN");
for (const p of proven) ghSum("- **" + p.region + "**: covered " + p.covered + " accounts, " + p.creates + " creates / " + p.tokens + " tokens (" + p.incompatible + " disconnected excluded)");
ghSum("- **TOTAL: " + totalCreates + " creates / " + totalTokens + " tokens** (authorized ceiling " + maxTokens + ")");
log("APPLY complete. total creates=" + totalCreates + " tokens=" + totalTokens + " (<= " + maxTokens + ").");
process.exit(0);
