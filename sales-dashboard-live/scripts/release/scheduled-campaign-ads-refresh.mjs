// TRUSTED, DEFERRED scheduled Campaign Ads (campaign-performance-v1) refresh operator for ONE Scheduler-v2 bucket --
// a thin CLI over the shared region-aware runner (lib/server/sync/scheduled-campaign-ads-runner.js). It REPLACES the
// retired ASIN Ads step in scheduler-v2.yml: after the ASIN->Campaign cutover the scheduler keeps Daily Reporting +
// Brand View ad data fresh by refreshing the CAMPAIGN grain for the bucket's regions in coverage mode (21-day rolling
// window), <=5-seller batches, zero-token connection pre-flight + durable-coverage pre-filter (already-covered
// accounts create nothing -> replay adopts completed work), and a guarded create ceiling. Usage (from sales-dashboard-live/):
//   node scripts/release/scheduled-campaign-ads-refresh.mjs --bucket=india|europe-au|us-ca|us|non-us [--as-of=YYYY-MM-DD] [--max-creates=N]
// `--bucket` accepts a REGION (the regional coordinator passes exactly one region -> that one region refreshes) or a
// legacy bucket (fans out to its member regions, for the pre-cutover compat window). Never prints an api key or a
// seller/account/export id.

import { loadReleaseEnv } from "./env-bootstrap.mjs";
import { isRegionScope, isRoutingScope } from "../../lib/server/sync/scheduler-scope.js";

loadReleaseEnv();

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const bucket = argOf("bucket");
let asOf = argOf("as-of") || (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
const maxCreatesArg = argOf("max-creates");
// --account-scope: 'full' (default) | 'bootstrap' (ONLY the accounts the dispatch WAVE authorized,
// resolved from the IMMUTABLE (region, --dispatch-id) row -- never workflow inputs -- and gated by the
// ENFORCED wave budget before any create). asOf is PINNED from the approved plan in bootstrap mode.
const accountScope = argOf("account-scope") || "full";
const dispatchId = argOf("dispatch-id");
if (!isRoutingScope(bucket)) { console.error("STOP --bucket must be a routing scope (india|europe-au|us-ca|us|non-us; got: " + bucket + ")"); process.exit(2); }
if (accountScope !== "full" && accountScope !== "bootstrap") { console.error("STOP --account-scope must be full | bootstrap (got: " + accountScope + ")"); process.exit(2); }
if (accountScope === "bootstrap") {
  if (!dispatchId) { console.error("STOP --account-scope=bootstrap requires --dispatch-id (the immutable wave identity)"); process.exit(2); }
  if (!isRegionScope(bucket)) { console.error("STOP --account-scope=bootstrap requires ONE explicit region --bucket"); process.exit(2); }
} else if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) { console.error("STOP --as-of must be YYYY-MM-DD (got: " + asOf + ")"); process.exit(2); }

const { regionsForBucket, planCampaignAdsRegionRun, runCampaignAdsRegionSlice } = await import("../../lib/server/sync/scheduled-campaign-ads-runner.js");
const { REGION_SCHEDULE } = await import("../../lib/server/sync/campaign-region-routing.js");
const { resolveBootstrapScopeByDispatch, gateOnboardingBudget, recordOnboardingActualSpend, findApprovedStepEntry, bootstrapStepRef, assertBootstrapStepPlan } = await import("../../lib/server/sync/account-onboarding-bootstrap.js");
const log = (m) => console.log("scheduled-campaign-ads[" + bucket + "@" + asOf + "/" + accountScope + "]: " + m);

// A region scope refreshes EXACTLY that region (the regional coordinator's one-region path); a legacy bucket fans out
// to its member regions (compat). Either way Campaign Ads runs ONCE per region -- one automatic owner, no double-refresh.
const regions = isRegionScope(bucket) ? [bucket] : regionsForBucket(bucket);
if (!regions.length) { console.error("STOP no regions for scope " + bucket); process.exit(2); }

const MAX_PASSES = Number(process.env.SCHEDULED_CAMPAIGN_ADS_MAX_ITERS || 40);
const maxFallbackArg = argOf("max-fallback-creates");
const TOK_PER_CREATE = 2; // STANDARD Campaign export
let totalCreates = 0; let totalTokens = 0; let totalCovered = 0; let totalRejected = 0; let totalTransient = 0; let totalAmbiguous = 0;
for (const region of regions) {
  const label = REGION_SCHEDULE[region].label;
  // BOOTSTRAP scope: the FROZEN dispatch-wave account set (resolveBootstrapScopeByDispatch -- immutable
  // row, readiness-rechecked to DEFER flapped accounts, never widened). asOf pinned from the approved plan.
  let scopeDeps = {};
  let bootstrapScope = null; // resolveBootstrapScopeByDispatch result
  let bootstrapEntry = null; // approved plan entry for (campaign, region)
  if (accountScope === "bootstrap") {
    bootstrapScope = await resolveBootstrapScopeByDispatch({ region, dispatchId });
    if (!bootstrapScope.ok) { console.error("STOP BOOTSTRAP_SCOPE_UNRESOLVED (" + bootstrapScope.reason + ") for " + region + "/" + dispatchId + " -- ZERO exports (fail closed)."); process.exit(1); }
    bootstrapEntry = findApprovedStepEntry(bootstrapScope.approvedPlan, "campaign", region);
    if (!bootstrapEntry) { console.error("STOP BOOTSTRAP_STEP_NOT_APPROVED: no approved 'campaign' plan entry for " + region + " (fail closed)."); process.exit(1); }
    // DEFER THE ENTIRE WAVE if any frozen account is not currently DataDoe-ready (never a ready subset).
    if (!bootstrapScope.allReady) {
      log("BOOTSTRAP_WAVE_DEFERRED: " + bootstrapScope.deferred.length + " of " + bootstrapScope.frozenAccountIds.length + " frozen account(s) not DataDoe-ready -- ENTIRE wave deferred (ZERO creates).");
      console.log("RESULT " + JSON.stringify({ ok: true, region, classification: "BOOTSTRAP_WAVE_DEFERRED", creates: 0, tokens: 0 }));
      process.exit(0);
    }
    asOf = String(bootstrapEntry.planAsOf || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) { console.error("STOP BOOTSTRAP_BAD_PIN: approved campaign planAsOf is not a date (" + asOf + ")"); process.exit(1); }
    const frozenAccounts = bootstrapScope.accounts;
    scopeDeps = { deps: { fetchAccounts: async () => frozenAccounts } };
  }
  let result = null;
  let regionCreates = 0; let regionTokens = 0;
  let budgetRef = null;
  for (let pass = 1; pass <= MAX_PASSES; pass += 1) {
    // Daily rolling window (21-day) so only the still-missing recent dates are fetched; already-covered => zero
    // creates. A NEVER-covered (new) account plans the INITIAL 56-day window in its own batch (initialPending).
    const plan = await planCampaignAdsRegionRun({ region, asOf, runKind: "daily", ...scopeDeps });
    const initialPending = Array.isArray(plan.initialPending) ? plan.initialPending : [];
    const pendingAll = plan.pending.length + initialPending.length;
    if (pass === 1) {
      // Print the exact bounded plan BEFORE any create: normal exports/token ceiling, worst-case fallback exports/
      // tokens a create-time-4xx split could add, and whether this run is zero-create / normal-create / fallback.
      const normalBatches = Math.ceil(plan.pending.length / 5) + Math.ceil(initialPending.length / 5);
      const fallbackMax = maxFallbackArg != null ? Number(maxFallbackArg) : pendingAll;
      const mode = pendingAll === 0 ? "ZERO-CREATE" : "NORMAL-CREATE (fallback split only if DataDoe rejects a batch)";
      log(label + ": " + plan.compatible.length + " compatible, " + plan.incompatible.length + " missing-connection, " + plan.covered.length + " already covered, " + plan.pending.length + " pending rolling + " + initialPending.length + " pending initial-56d; window [" + plan.window.from + ".." + plan.window.to + "]");
      log(label + " PLAN: normal<=" + normalBatches + " exports/" + (normalBatches * TOK_PER_CREATE) + " tokens; fallback<=" + fallbackMax + " exports/" + (fallbackMax * TOK_PER_CREATE) + " tokens; hard-ceiling=" + (normalBatches + fallbackMax) + " creates; mode=" + mode);
      // BOOTSTRAP BUDGET GATE (before ANY create POST): reserve this attempt's plan (normal + fallback
      // ceiling) against the durable WAVE budget, bound to the wave key + account-set hash + approved plan
      // fingerprint + the approved STEP PLAN HASH (pins dates/window/source). The ref is DATE-FREE so a
      // retry REUSES the ONE reservation (cumulative actuals capped by the approved ceiling). Refusal
      // stops this region cold.
      if (accountScope === "bootstrap" && pendingAll > 0) {
        if (!bootstrapScope || !bootstrapScope.waveKey) { console.error("STOP BOOTSTRAP_SCOPE_NO_WAVE: pending campaign work without a claimed wave identity (fail closed)."); process.exit(1); }
        // RECOMPUTE the step plan hash from the ACTUAL runtime plan and REQUIRE it to equal the approved
        // hash -- NEVER echo. Batch membership is the STABLE frozen-set <=5 chunking (not the
        // coverage-dependent residual pending), so a legitimate retry never drifts while a changed
        // frozen account/date/window still does.
        const sortedFrozen = [...bootstrapScope.frozenAccountIds].sort();
        const runtimeBatches = [];
        for (let i = 0; i < sortedFrozen.length; i += 5) runtimeBatches.push(sortedFrozen.slice(i, i + 5));
        const chk = assertBootstrapStepPlan(bootstrapEntry, {
          step: "campaign", region, accounts: bootstrapScope.frozenAccountIds, operationIds: bootstrapScope.operationIds,
          accountSetHash: bootstrapScope.accountSetHash, planAsOf: asOf,
          sourceKeys: ["campaign-performance-v1"], windows: [{ sourceKey: "campaign-performance-v1", from: plan.window.from, to: plan.window.to }],
          batchMembership: runtimeBatches, requestHashes: [], limits: [],
        });
        if (!chk.ok) { console.error("STOP BOOTSTRAP_STEP_PLAN_DRIFT (" + chk.reason + "): the runtime campaign plan does not match the approved stepPlanHash -- ZERO creates (fail closed before any reservation/POST)."); process.exit(1); }
        budgetRef = bootstrapStepRef({ step: "campaign", region, stepPlanHash: chk.stepPlanHash });
        const plannedCreates = normalBatches + fallbackMax;
        const gate = await gateOnboardingBudget({
          waveKey: bootstrapScope.waveKey, ref: budgetRef, stepType: "campaign", region,
          accountSetHash: bootstrapScope.accountSetHash, stepPlanHash: chk.stepPlanHash, plannedTokens: plannedCreates * TOK_PER_CREATE, plannedCreates,
        });
        if (!gate.ok) {
          console.error("STOP ONBOARDING_BUDGET_REFUSED (" + gate.refusal + (gate.detail ? "/" + gate.detail : "") + "): planned " + (plannedCreates * TOK_PER_CREATE) + " token(s) for " + budgetRef + " (wave " + bootstrapScope.waveKey + ") -- ZERO creates issued (fail closed before any POST).");
          process.exit(1);
        }
        log("onboarding budget " + gate.disposition + " for " + budgetRef + " (runtime plan hash MATCHES approved; reserved " + gate.reservedTokens + "/" + gate.authorizedTokens + ")");
      }
    }
    result = await runCampaignAdsRegionSlice({ region, asOf, runKind: "daily", plan, ...(maxCreatesArg != null ? { maxCreates: Number(maxCreatesArg) } : {}), ...(maxFallbackArg != null ? { maxFallbackCreates: Number(maxFallbackArg) } : {}), log });
    regionCreates += Number(result.creates) || 0; regionTokens += Number(result.tokens) || 0;
    // COMPLETE (all fresh) or PARTIAL (some accounts isolated with LKG, honestly reported) are BOTH a successful
    // bounded pass -- the failure is bounded/classified/isolated, not suppressed. Only a SYSTEMIC failure exits 1.
    if (result.phase === "complete" || result.phase === "partial") break;
    if (result.continuationRequired === true) { log(label + " pass " + pass + " deferred (work-budget); resuming"); continue; }
    console.error("STOP scheduled Campaign Ads region " + label + " failed: " + JSON.stringify(result.problems || []));
    process.exit(1);
  }
  if (!result || (result.phase !== "complete" && result.phase !== "partial")) { console.error("STOP scheduled Campaign Ads region " + label + " exhausted " + MAX_PASSES + " passes"); process.exit(1); }
  // AGGREGATE budget tracking (bootstrap scope): record the region's cumulative ACTUAL creates/tokens.
  // An 'over-reservation' answer is surfaced LOUDLY (never silent).
  if (accountScope === "bootstrap" && budgetRef) {
    const rec = await recordOnboardingActualSpend({ waveKey: bootstrapScope.waveKey, ref: budgetRef, actualTokens: regionTokens, actualCreates: regionCreates });
    if (rec && rec.disposition === "over-reservation") {
      console.error("WARNING ONBOARDING_OVER_RESERVATION: " + budgetRef + " actuals " + regionTokens + " tok/" + regionCreates
        + " creates EXCEEDED reservation " + rec.reserved_tokens + " tok/" + rec.reserved_creates + " -- investigate before the next wave step.");
    }
  }
  totalCreates += result.creates; totalTokens += result.tokens; totalCovered += result.covered;
  const rej = (result.rejected || []).length, tr = (result.transient || []).length, amb = (result.ambiguous || []).length;
  totalRejected += rej; totalTransient += tr; totalAmbiguous += amb;
  // Isolated accounts are reported HONESTLY (never a silent zero): they retain their last-known-good Campaign data;
  // the next scheduled pass retries transient/ambiguous, a definitively-rejected seller stays isolated until fixed upstream.
  if (rej || tr || amb) log("region " + label + " ISOLATED (retain last-known-good): rejected=" + rej + " transient=" + tr + " ambiguous=" + amb + "; diagnostics=" + JSON.stringify((result.diagnostics || []).map((d) => ({ classification: d.classification, status: d.status, batchSize: d.batchSize }))));
  log("region " + label + " covered=" + result.covered + " creates=" + result.creates + " tokens=" + result.tokens + " (disconnected excluded=" + result.incompatible + ")");
}
log("bucket " + bucket + ": covered=" + totalCovered + " accounts across " + regions.length + " region(s); " + totalCreates + " creates / " + totalTokens + " tokens; isolated rejected=" + totalRejected + " transient=" + totalTransient + " ambiguous=" + totalAmbiguous + " (ASIN creates=0).");
process.exit(0);
