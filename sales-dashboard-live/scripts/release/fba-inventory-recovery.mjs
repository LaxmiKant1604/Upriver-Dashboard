// TRUSTED operator for the ADAPTIVE FBA Inventory overflow recovery. It recovers the accounts blocked by a terminal
// TRUNCATED (oversized) inventory batch by re-fetching them as SINGLE-SELLER inventory exports -- reusing the SHARED
// fba-plan operation core (fetch -> derive -> publish -> read-back -> safe-close), a FROZEN inventory recovery tranche
// (atomic pre-POST reservation), and the adaptive planner split (overflowSellers). It NEVER retries/recreates the
// failed parent export or the successful sibling batch, and NEVER raises the 50000 row cap.
//
//   node scripts/release/fba-inventory-recovery.mjs --region=india --mode=dry-run   [--cycle-date=YYYY-MM-DD]
//   node scripts/release/fba-inventory-recovery.mjs --region=india --mode=recover --cycle-date=YYYY-MM-DD \
//       --confirm=fba-inventory-recovery/india/YYYY-MM-DD [--max-creates=3]
//
// dry-run: ZERO creates -- discovers accounts, derives the proven-overflow sellers from recent terminal TRUNCATED
//   evidence, plans the single-seller children, proves the create/token cost vs --max-creates. It never fetches.
// recover: refuses unless the operator is authorized + --confirm is exact; then runs ONE bounded recovery to
//   completion, creating at most --max-creates single-seller inventory exports (a frozen tranche caps it atomically).
//   If any single-seller child reaches the 50000 cap it is a HARD STOP for that account (never auto-raise the limit).

import { loadReleaseEnv } from "./env-bootstrap.mjs";
loadReleaseEnv();

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const region = (argOf("region") || "").toLowerCase();
const mode = argOf("mode") || "dry-run";
const confirm = argOf("confirm");
const maxCreates = Number(argOf("max-creates") || 3);
const AUTHORIZED_OPERATOR = "laxmikant@superboring.in";
const operator = process.env.PRIORITY_OPERATOR || argOf("operator") || AUTHORIZED_OPERATOR;
const cycleDate = argOf("cycle-date") || new Date().toISOString().slice(0, 10);
if (!["india", "europe-au", "us-ca"].includes(region)) { console.error("STOP --region must be india | europe-au | us-ca"); process.exit(2); }
if (mode !== "dry-run" && mode !== "recover") { console.error("STOP --mode must be dry-run | recover"); process.exit(2); }
const operationId = `fba-inventory-recovery/${region}/${cycleDate}`;
const log = (m) => console.log(`fba-inv-recovery[${mode}/${region}]: ${m}`);

const { buildFbaPlanRelease } = await import("../../lib/server/sync/fba-plan-release-composition.js");
const { fbaBucketAccounts, planFbaBucketCost, advanceFbaPlanBucket } = await import("../../lib/server/sync/fba-plan-operation.js");
const { buildSchedulerV2Runtime } = await import("../../lib/server/sync/runtime-composition.js");
const { registryBudgetPlanner } = await import("../../lib/server/sync/source-fixpoint.js");
const { getDataDoeConnections, resolveDataDoeAccountIds } = await import("../../lib/server/datadoe-connections.js");
const { getDataDoeTokenBalance } = await import("../../lib/server/datadoe-usage.js");
const { materializeListingHealthV3PerAccount } = await import("../../lib/server/sync/listing-health-v3-materialize.js");
const { planListingHealthV3BucketBatched } = await import("../../lib/server/sync/report-planner.js");
const { getSourceExportCache, saveSourceExportCache, getSourceExportCacheMeta } = await import("../../lib/server/supabase.js");

if (mode === "recover") {
  if (confirm !== operationId) { console.error(`STOP recover requires --confirm=${operationId} (exact); got ${confirm ? "a mismatched value" : "none"}.`); process.exit(2); }
  if (operator !== AUTHORIZED_OPERATOR) { console.error("STOP operator identity is not authorized for a recovery run."); process.exit(2); }
}

// A recovery runtime scoped to the INVENTORY tranche + the registry budget planner, so the dispatcher freezes a
// per-(cycle,tranche) create/token budget over the inventory hashes and reserves every create atomically before POST.
const makeRecoveryRuntime = () => buildSchedulerV2Runtime({ sourceTranche: { sourceKeys: ["fba-inventory-health"], name: `fba-inv-recovery#${region}` }, budgetPlanner: registryBudgetPlanner() });
const release = buildFbaPlanRelease({ operator, makeRuntime: makeRecoveryRuntime });
const connections = getDataDoeConnections();
const primaryApiKey = (connections.find((c) => c && c.id === "primary") || {}).apiKey || null;
const balanceNow = async () => { if (!primaryApiKey) return null; const b = await getDataDoeTokenBalance({ apiKey: primaryApiKey }); return b && b.read === "ok" ? b.usable : null; };

// Stage 0: discover + scope to the region.
const accounts = await release.loadAccounts();
const bucketAccounts = fbaBucketAccounts(accounts, region);
log(`discovered ${accounts.length} primary accounts; ${bucketAccounts.length} in region ${region}`);
if (!bucketAccounts.length) { console.error("STOP no accounts in region."); process.exit(1); }

// Stage 1: derive proven-overflow sellers from recent terminal TRUNCATED evidence.
const { overflowSellers, singleSellerHardStops } = await release.resolveOverflowSellers({ bucket: region, bucketAccounts, asOf: cycleDate, inventoryAsOf: cycleDate });
if (singleSellerHardStops.length) log(`HARD STOP: ${singleSellerHardStops.length} single-seller inventory batch(es) still exceed 50000 -- cannot split further; NOT recovered (never auto-raise the limit): ${singleSellerHardStops.map((s) => String(s).slice(0, 6)).join(",")}`);
if (!overflowSellers.size) { log("no proven-overflow (multi-seller TRUNCATED) sellers to recover. Nothing to do."); process.exit(singleSellerHardStops.length ? 1 : 0); }

// The accounts to recover: those whose raw seller id is a proven-overflow seller.
const overflowAccounts = bucketAccounts.filter((a) => { try { const r = resolveDataDoeAccountIds([a.accountId], connections); return r && r.rawAccountIds.length === 1 && overflowSellers.has(String(r.rawAccountIds[0])); } catch { return false; } });
log(`recovering ${overflowAccounts.length} account(s) as single-seller inventory exports: ${overflowAccounts.map((a) => String(a.accountId).slice(0, 6)).join(",")}`);

// Stage 2: prove the freshness-aware cost (ZERO creates) with the split applied.
const { plan, cost } = await planFbaBucketCost({ bucketAccounts: overflowAccounts, connections: release.connections, asOf: cycleDate, inventoryAsOf: cycleDate, getSourceExportCache: release.getSourceExportCache, overflowSellers });
const childSources = [...new Map(plan.reportRequests.flatMap((r) => r.sources.filter((s) => s.requestKey === "fba-plan:inventory-health").map((s) => [s.requestHash, s]))).values()];
log(`PLAN: ${childSources.length} single-seller inventory children; every child sellers=${childSources.every((s) => s.sellerOrVendorIds.length === 1)}; creates=${cost.creates} tokens=${cost.tokens} (ceiling ${maxCreates})`);
for (const s of childSources) log(`  child seller=${String(s.sellerOrVendorIds[0]).slice(0, 6)} hash=${String(s.requestHash).slice(0, 12)} window=${s.from}..${s.to} strict=${s.strict} limit=${s.limit}`);
if (childSources.length !== overflowAccounts.length || !childSources.every((s) => s.sellerOrVendorIds.length === 1)) { console.error("STOP the split did not produce exactly one single-seller child per overflow account; refusing (fail closed)."); process.exit(1); }
if (Number(cost.creates || 0) > maxCreates) { console.error(`STOP planned creates ${cost.creates} exceed --max-creates ${maxCreates}; refusing.`); process.exit(1); }

if (mode === "dry-run") { log(`DRY-RUN complete: ${childSources.length} children, ${cost.creates} creates / ~${cost.tokens} tokens (observed estimate; rowCountBilling=true). ZERO creates made.`); process.exit(0); }

// Stage 3: RECOVER. Record balance, run the bounded pass to completion (<= maxCreates creates, atomic reservation).
const before = await balanceNow();
log(`usable balance before: ${before}`);
let result = null;
for (let pass = 1; pass <= 20; pass += 1) {
  result = await advanceFbaPlanBucket({
    bucket: region, asOf: cycleDate, inventoryAsOf: cycleDate,
    includedIds: overflowAccounts.map((a) => a.accountId), bucketAccounts: overflowAccounts, cost, maxTokens: maxCreates * 2,
    runtime: release.runtime, publisher: release.publisher, controls: release.controls, readbackLive: release.readbackLive,
    overflowSellers, trigger: "manual", deadlineMs: Infinity, reserveMs: 0, outOfTime: () => false, log,
  });
  log(`pass ${pass}: phase=${result.phase} published=${result.published} readback=${result.readback}${result.continuationRequired ? " (continuation)" : ""}${result.problems ? " problems=" + JSON.stringify(result.problems) : ""}`);
  if (result.phase === "complete" && result.ok === true) break;
  if (result.ok === false) break;
  if (result.continuationRequired !== true) break;
}
const after = await balanceNow();
log(`usable balance after: ${after}; attributable usage: ${before != null && after != null ? before - after : "unknown"} tokens`);

// Stage 4: materialize the per-account v3 inventory aliases for the recovered accounts (zero export). v3 single-seller
// inventory hashes match the FBA children, so the materializer reads each child inventory + writes the per-account alias.
try {
  const v3Plan = planListingHealthV3BucketBatched({ accounts: overflowAccounts, connections: release.connections, asOfFor: () => cycleDate, inventoryAsOf: cycleDate, overflowSellers });
  const mat = await materializeListingHealthV3PerAccount({
    plans: v3Plan, connections: release.connections,
    readSourceCache: getSourceExportCache, writeSourceCache: saveSourceExportCache,
    readAliasMeta: async (h) => { const e = await getSourceExportCacheMeta(h); return e && e.request_meta ? { batchFetchedAt: e.request_meta.batchFetchedAt } : null; },
  });
  log(`v3 per-account inventory aliases materialized: written=${mat.aliasesWritten} empty=${mat.emptyAliases} batchMissing=${mat.batchMissing}`);
} catch (e) { log("WARN v3 alias materialization failed (non-fatal, re-runnable): " + String(e && e.message ? e.message : e)); }

if (result && result.phase === "complete" && result.ok === true) { log(`DONE: recovered + published ${result.published} account(s); controls safe-closed.`); process.exit(0); }
console.error(`STOP recovery did not complete: phase=${result && result.phase} problems=${JSON.stringify(result && result.problems)}`);
process.exit(1);
