// TRUSTED, ZERO-CREATE onboarding-wave PLAN operator -- the exact dry-run plan the human authorizes.
// Usage (from sales-dashboard-live/):
//   node scripts/release/onboarding-wave-plan.mjs [--as-of=YYYY-MM-DD] [--out-dir=scripts/release]
//
// Waves are REGION-LOCAL: each region has its OWN wave identity + budget, so this emits ONE plan file
// PER REGION (.onboarding-wave-plan-<region>.json). For each region it reads the CURRENT durable claim
// state + the zero-token DataDoe directory, computes the region-local wave identity, and plans every
// bootstrap step's exact worst-case spend from current evidence -- each step entry binding the FULL
// approved work via a stepPlanHash (dates/windows/sources/batches/membership), so a later run with any
// changed parameter is PLAN_DRIFT even at identical token counts:
//   oli      -- coverage-derived ceiling (steady batches + one create per account behind D-1),
//   campaign -- normal + worst-case-fallback ceiling (a never-covered account plans its INITIAL 56d),
//   fba      -- planFbaBucketCost's adoption-aware batched cost (reusable durable cache => 0 tokens),
//   catalog  -- the ONE org-wide Product Catalog create the scoped publication may make (<=1 create/2 tok).
// It writes the plan JSON the authorize operator records verbatim. ZERO DataDoe creates, ZERO Supabase writes.

import { writeFileSync } from "node:fs";
import { loadReleaseEnv } from "./env-bootstrap.mjs";

loadReleaseEnv();

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const asOf = argOf("as-of") || (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) { console.error("STOP --as-of must be YYYY-MM-DD (got: " + asOf + ")"); process.exit(2); }
const outDir = argOf("out-dir") || "scripts/release";
const log = (m) => console.log("wave-plan[" + asOf + "]: " + m);

const { getDataDoeConnections } = await import("../../lib/server/datadoe-connections.js");
const { fetchAccountsDetailed } = await import("../../lib/server/datadoe.js");
const { computeOnboardingWaveIdentity, onboardingPlanFingerprint, ONBOARDING_REGIONS } = await import("../../lib/server/sync/account-onboarding.js");
const { resolveBootstrapScope, buildOnboardingStepEntry, fbaPlanStructure } = await import("../../lib/server/sync/account-onboarding-bootstrap.js");
const { getAccountOnboardingRows, getSourceCoverageWindows, getSourceExportCache } = await import("../../lib/server/supabase.js");
const { oliBucketPlan, OLI_TOKENS_PER_CREATE } = await import("../../lib/server/sync/source-scheduled-oli.js");
const { OLI_SOURCE_KEY, windowsProve } = await import("../../lib/server/sync/source-durable-model.js");
const { sourceRegistryEntry } = await import("../../lib/server/sync/source-registry.js");
const { organizationFingerprint } = await import("../../lib/server/source-identity.js");
const { planCampaignAdsRegionRun, campaignAdsWindow } = await import("../../lib/server/sync/scheduled-campaign-ads-runner.js");
const { planFbaBucketCost } = await import("../../lib/server/sync/fba-plan-operation.js");

const CAMPAIGN_TOK_PER_CREATE = 2; // STANDARD Campaign export
const CATALOG_TOK_PER_CREATE = 2;  // STANDARD Product Catalog export (org-wide; at most one per publication)

const connections = getDataDoeConnections();
const primaryConn = connections.find((c) => c.id === "primary");
if (!primaryConn || !primaryConn.apiKey) { console.error("STOP primary DataDoe connection is not configured."); process.exit(1); }
const orgFp = primaryConn.organizationFingerprint || organizationFingerprint(primaryConn.apiKey);

// ONE zero-token directory GET + ONE onboarding read, shared by every region's scope resolution.
const detailed = (await fetchAccountsDetailed(primaryConn.apiKey)) || [];
const onboardingRows = await getAccountOnboardingRows();
if (!Array.isArray(onboardingRows)) { console.error("STOP account_onboarding unreadable -- apply migration 20260919 first (fail closed)."); process.exit(1); }

const oliStart = sourceRegistryEntry(OLI_SOURCE_KEY).initialBackfill.start;
let anyWave = false;

for (const region of ONBOARDING_REGIONS) {
  const wave = computeOnboardingWaveIdentity(onboardingRows, region);
  if (!wave.waveKey) { log(region + ": no claimed accounts -- nothing to plan."); continue; }
  anyWave = true;

  const scope = await resolveBootstrapScope(primaryConn.apiKey, {
    region, fetchDetailed: async () => detailed, readOnboardingRows: async () => onboardingRows,
  });
  const discovered = scope.accounts
    .map((a) => ({ accountId: String((a && (a.accountId ?? a.id)) || "").trim(), country: String((a && a.country) || "").toUpperCase(), currency: (a && a.currency) || null, name: (a && a.name) || null }))
    .filter((a) => a.accountId && !a.accountId.includes(":"));
  const accountSetHash = scope.accountSetHash;
  const common = { region, accounts: wave.accounts, operationIds: wave.operations, accountSetHash };

  // --- oli: coverage-derived ceiling; window = the full backfill [oliStart .. asOf]. ---
  let oliMissing = 0;
  for (const a of discovered) {
    let proven = false;
    try {
      const cov = await getSourceCoverageWindows({ organizationFingerprint: orgFp, connectionId: "primary", accountId: a.accountId, sourceKey: OLI_SOURCE_KEY });
      const windows = cov && cov.read === "ok" ? (cov.windows || []) : null;
      proven = windows != null && windowsProve(windows, oliStart, asOf) === true;
    } catch { proven = false; }
    if (!proven) oliMissing += 1;
  }
  const oliPlan = oliBucketPlan(discovered);
  // STABLE worst-case ceiling (every frozen account behind D-1) so a retry whose residual is smaller never
  // exceeds the approved ceiling; oliMissing is only logged. For a fresh bootstrap wave the two are equal.
  void oliMissing;
  const oliCreates = discovered.length ? oliPlan.maxCreates + discovered.length : 0;
  const oliBatches = (oliPlan.batches || []).map((b) => (b.accounts || []).map((x) => String(x.accountId || x)).sort());
  const oliEntry = buildOnboardingStepEntry({
    ...common, step: "oli", planAsOf: asOf,
    sourceKeys: [OLI_SOURCE_KEY], windows: [{ sourceKey: OLI_SOURCE_KEY, from: oliStart, to: asOf }],
    batchMembership: oliBatches, plannedCreates: oliCreates, plannedTokens: oliCreates * OLI_TOKENS_PER_CREATE,
  });

  // --- campaign: normal + worst-case fallback ceiling; STABLE frozen-set <=5 batch membership. ---
  let campaignCreates = 0;
  const campWin = campaignAdsWindow(asOf, "daily");
  if (discovered.length) {
    const plan = await planCampaignAdsRegionRun({ region, asOf, runKind: "daily", deps: { fetchAccounts: async () => scope.accounts } });
    const initialPending = Array.isArray(plan.initialPending) ? plan.initialPending : [];
    const pendingAll = plan.pending.length + initialPending.length;
    const normalBatches = Math.ceil(plan.pending.length / 5) + Math.ceil(initialPending.length / 5);
    campaignCreates = normalBatches + pendingAll;
  }
  const sortedForCampaign = [...common.accounts].sort();
  const campaignBatches = [];
  for (let i = 0; i < sortedForCampaign.length; i += 5) campaignBatches.push(sortedForCampaign.slice(i, i + 5));
  const campaignEntry = buildOnboardingStepEntry({
    ...common, step: "campaign", planAsOf: asOf,
    sourceKeys: ["campaign-performance-v1"], windows: [{ sourceKey: "campaign-performance-v1", from: campWin.from, to: campWin.to }],
    batchMembership: campaignBatches, plannedCreates: campaignCreates, plannedTokens: campaignCreates * CAMPAIGN_TOK_PER_CREATE,
  });

  // --- fba: adoption-aware batched cost; inventory window = [asOf .. asOf]. The hash binds the EXACT
  // DEFAULT (no-overflow) FBA plan STRUCTURE -- frozen sellers, marketplace pairs, default <=5 batches,
  // request hashes, source keys, row limits, inventoryAsOf -- plus adaptiveSplitAllowed (a reviewed
  // deterministic single-seller split envelope over those default batches), so a modified seller/pair/
  // batch/request/limit is drift while a legitimate overflow-split at execution is not.
  let fbaCreates = 0; let fbaTokens = 0; let fbaStructure = null;
  if (discovered.length) {
    const { plan: fbaPlan, cost } = await planFbaBucketCost({ bucketAccounts: discovered, connections, asOf, inventoryAsOf: asOf, getSourceExportCache });
    fbaCreates = Number(cost.creates) || 0; fbaTokens = Number(cost.tokens) || 0;
    fbaStructure = fbaPlanStructure(fbaPlan, asOf);
  }
  const fbaEntry = buildOnboardingStepEntry({
    ...common, step: "fba", planAsOf: asOf, inventoryAsOf: asOf,
    sourceKeys: ["fba-inventory-health"], windows: [{ sourceKey: "fba-inventory-health", from: asOf, to: asOf }],
    structure: fbaStructure, plannedCreates: fbaCreates, plannedTokens: fbaTokens,
  });

  // --- catalog: the ONE org-wide Product Catalog create the scoped publication derive may make. ---
  const catalogEntry = buildOnboardingStepEntry({
    ...common, step: "catalog", planAsOf: asOf,
    sourceKeys: ["product-catalog"], windows: [{ sourceKey: "product-catalog", snapshotIdentity: "org-current" }],
    plannedCreates: 1, plannedTokens: CATALOG_TOK_PER_CREATE,
  });

  const steps = [oliEntry, campaignEntry, fbaEntry, catalogEntry];
  const planFingerprint = onboardingPlanFingerprint(steps);
  const totals = steps.reduce((t, s) => ({ creates: t.creates + s.plannedCreates, tokens: t.tokens + s.plannedTokens }), { creates: 0, tokens: 0 });
  const outPath = `${outDir}/.onboarding-wave-plan-${region}.json`;
  const planDoc = {
    generatedAt: new Date().toISOString(), planAsOf: asOf,
    region, waveKey: wave.waveKey, dispatchId: wave.dispatchId, membershipHash: wave.membershipHash,
    accounts: wave.accounts, operations: wave.operations,
    steps, planFingerprint, totals,
  };
  writeFileSync(outPath, JSON.stringify(planDoc, null, 2) + "\n");
  log(region + " wave " + wave.waveKey + " (" + wave.accounts.length + " account(s), set " + String(accountSetHash).slice(0, 12) + "): <=" + totals.creates + " creates / <=" + totals.tokens + " tokens; planFingerprint=" + planFingerprint);
  log("  plan -> " + outPath);
  log("  AUTHORIZE: node scripts/release/authorize-onboarding-budget.mjs --region=" + region + " --wave-key=" + wave.waveKey + " --plan-fingerprint=" + planFingerprint + " --plan-file=" + outPath + " --tokens=" + totals.tokens + " --confirm=onboarding-budget/" + wave.waveKey + "/" + totals.tokens);
}

if (!anyWave) { log("NO CLAIMED WAVE in any region -- nothing to plan or authorize."); }
process.exit(0);
