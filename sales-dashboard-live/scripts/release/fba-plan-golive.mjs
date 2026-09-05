// TRUSTED operator for the FBA Shipment Plan go-live + the automatic per-bucket scheduled refresh. It runs the
// SHARED fba-plan operation core (lib/server/sync/fba-plan-operation.js) wired by the reviewed release seam
// (lib/server/sync/fba-plan-release-composition.js) -- the EXACT collaborators + pipeline the Data Sync Center
// route uses -- so the CLI, the scheduler, and the manual route cannot drift. The core runs the reviewed
// Scheduler-v2 machinery: the shadow dispatcher (batched marketplace-safe FBA Health/AWD fetch + durable
// OLI/catalog derive), the four-gate CAS publisher, the guarded fba-plan control package, an apply-gates ->
// publish -> read-back -> ownership -> ALWAYS-safe-close envelope, bounded by a hard token ceiling.
//
//   node scripts/release/fba-plan-golive.mjs --mode=dry-run   [--as-of=YYYY-MM-DD] [--max-blocked=2] [--region=india|europe-au|us-ca|all] [--bucket=us|non-us|both]
//   node scripts/release/fba-plan-golive.mjs --mode=go-live   [--as-of=YYYY-MM-DD] [--max-tokens=80] [--max-blocked=2] [--region=...] [--bucket=...]
//
// SCOPE: `--region` (a region india|europe-au|us-ca, or `all`) is the ACTIVE routing used by the regional
// coordinator -- it takes precedence when present and runs exactly that region (or all three). `--bucket`
// (us|non-us|both) is the legacy scope retained for manual runs + rollback. Either way FBA routes by
// scope-membership; AWD is fetched per-account for the AWD-capable marketplaces (US + the EU5: GB/UK, DE, FR, IT, ES;
// AU + others excluded -- see lib/server/reports/awd-capability.js), orthogonal to the region.
// dry-run: ZERO creates, ZERO control changes -- resolves the coverage-maximizing as-of, builds the exact batched
//   plan, proves how much is already adoptable from cache, and prints the create/token cost vs the ceiling.
// go-live: refuses to start if the plan exceeds --max-tokens; otherwise, PER SELECTED SCOPE, runs the shared
//   bounded pass to completion (fetch -> derive -> finalize -> open gates -> publish -> read-back -> ownership ->
//   ALWAYS safe-close). Scopes run INDEPENDENTLY. Genuinely-stale-OLI accounts fail closed (never fabricated) and
//   publish on a later run once their OLI catches up. The dedicated cycle (scope-fba, as-of) makes a replay
//   (watchdog / retry) a zero-create idempotent no-op.

import { loadReleaseEnv } from "./env-bootstrap.mjs";
import { REGION_SCOPES, isRegionScope } from "../../lib/server/sync/scheduler-scope.js";
loadReleaseEnv();

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const mode = argOf("mode");
if (mode !== "dry-run" && mode !== "go-live") { console.error("STOP --mode must be dry-run | go-live"); process.exit(2); }
const asOfArg = argOf("as-of");
const maxTokens = Number(argOf("max-tokens") || 80);
const maxBlocked = Number(argOf("max-blocked") || 2);
const regionArg = (argOf("region") || "").toLowerCase();
const bucketArg = (argOf("bucket") || "both").toLowerCase();
// Region takes precedence (the active regional path); fall back to the legacy bucket scope otherwise.
let selectedScopes;
if (regionArg) {
  if (regionArg === "all") selectedScopes = [...REGION_SCOPES];
  else if (isRegionScope(regionArg)) selectedScopes = [regionArg];
  else { console.error("STOP --region must be india | europe-au | us-ca | all"); process.exit(2); }
} else {
  if (!["us", "non-us", "both"].includes(bucketArg)) { console.error("STOP --bucket must be us | non-us | both"); process.exit(2); }
  selectedScopes = ["us", "non-us"].filter((b) => bucketArg === "both" || bucketArg === b);
}
const scopeLabel = regionArg ? (regionArg === "all" ? "all-regions" : regionArg) : (bucketArg === "both" ? "" : bucketArg);
const log = (m) => console.log("fba-golive[" + mode + (scopeLabel ? "/" + scopeLabel : "") + "]: " + m);

const { buildFbaPlanRelease } = await import("../../lib/server/sync/fba-plan-release-composition.js");
const {
  resolveFbaPlanScope, planFbaBucketCost, fbaBucketAccounts, advanceFbaPlanBucket, fbaServerCeiling, fbaInventoryAsOf,
} = await import("../../lib/server/sync/fba-plan-operation.js");

const CEILING = fbaServerCeiling();
const inventoryAsOf = fbaInventoryAsOf();
const OPERATOR = process.env.PRIORITY_OPERATOR || "laxmikant@superboring.in";
const release = buildFbaPlanRelease({ operator: OPERATOR });

// ---------------- Stage 0: discover primaries + their authoritative directory metadata (ZERO DataDoe) --------
const accounts = await release.loadAccounts();
if (!accounts.length) { console.error("STOP no primary accounts with directory metadata discovered."); process.exit(1); }
log("discovered " + accounts.length + " primary accounts with metadata");

// ---------------- Stage 1: resolve the coverage-maximizing go-live as-of (SHARED core) ----------------
log("inventory requested through " + inventoryAsOf + "; sales coverage resolved independently per region");

// ---------------- Stage 2: build the exact batched plan + prove the token cost (ZERO creates, SHARED core) ----
const bucketPlan = new Map();
let totalCreates = 0; let totalTokens = 0; let totalBatches = 0;
for (const bucket of selectedScopes) {
  const bucketAccounts = fbaBucketAccounts(accounts, bucket);
  if (!bucketAccounts.length) continue;
  const scope = await resolveFbaPlanScope({ accounts: bucketAccounts, connections: release.connections, asOfArg, maxBlocked, ceiling: CEILING, readers: release.scopeReaders });
  if (!scope.asOf) { console.error("STOP " + bucket + " has no durable sales coverage; inventory export not started."); process.exit(1); }
  // Adaptive self-heal: proactively route proven-overflow sellers (recent terminal TRUNCATED inventory evidence) into
  // single-seller inventory jobs so a persistently-oversized batch does not waste one failed export every cycle. Empty
  // => byte-identical default batching; fail-soft. Single-seller HARD STOPS are surfaced (never auto-raise the limit).
  const { overflowSellers, singleSellerHardStops } = await release.resolveOverflowSellers({ bucket, bucketAccounts, asOf: scope.asOf, inventoryAsOf });
  if (overflowSellers.size) log(bucket + " adaptive split: isolating " + overflowSellers.size + " proven-overflow seller(s) into single-seller inventory jobs");
  if (singleSellerHardStops.length) log(bucket + " WARN " + singleSellerHardStops.length + " single-seller inventory batch(es) still exceed 50000 (cannot split further; not auto-raising the limit)");
  const { plan, cost } = await planFbaBucketCost({ bucketAccounts, connections: release.connections, asOf: scope.asOf, inventoryAsOf, getSourceExportCache: release.getSourceExportCache, overflowSellers });
  bucketPlan.set(bucket, { bucketAccounts, plan, cost, scope, overflowSellers });
  log(bucket + " sales through " + scope.asOf + "; inventory through " + inventoryAsOf + "; included=" + scope.included.length + " blocked=" + scope.blocked.length);
  const unique = new Map(plan.reportRequests.flatMap((r) => r.sources.map((s) => [s.requestHash, s])));
  for (const s of unique.values()) log("BATCH " + s.requestKey + " " + JSON.stringify({ sellers: s.sellerOrVendorIds, pairs: s.marketplacePairs, from: s.from, to: s.to, freshAfter: s.freshnessNotBefore }));
  totalCreates += Number(cost.creates || 0); totalTokens += Number(cost.tokens || 0); totalBatches += plan.sourceJobs.length;
  log("PLAN " + bucket + ": " + plan.sourceJobs.length + " batched exports; creates=" + cost.creates + " tokens=" + cost.tokens + " byFamily=" + JSON.stringify(cost.byFamily));
}
log("PLAN TOTAL: " + totalBatches + " batched exports across " + selectedScopes.join("+") + " => " + totalCreates + " creates / " + totalTokens + " tokens (ceiling " + maxTokens + " -> " + (totalTokens <= maxTokens ? "WITHIN budget" : "EXCEEDS budget") + ")");

if (mode === "dry-run") { log("DRY-RUN complete: ZERO creates, ZERO control changes."); process.exit(0); }

// ---------------- go-live: HARD total token gate BEFORE any create / control change ----------------
if (totalTokens > maxTokens) { console.error("STOP the plan costs " + totalTokens + " tokens > the " + maxTokens + "-token ceiling; refusing to start (zero creates, zero control changes)."); process.exit(1); }

// ---------------- go-live: run each SELECTED bucket to completion via the SHARED bounded pass ----------------
let anyPublished = 0; let anyFailure = false;
try {
  for (const bucket of selectedScopes) {
    if (!bucketPlan.has(bucket)) continue;
    const { bucketAccounts, cost, scope, overflowSellers } = bucketPlan.get(bucket);
    const asOf = scope.asOf;
    if (!bucketAccounts.length) { log(bucket + ": no accounts in this bucket -- skipping."); continue; }
    const includedIds = scope.included.filter((id) => bucketAccounts.some((a) => a.accountId === id));
    let result = null;
    // The CLI runs an effectively-unbounded slice budget (deadlineMs=Infinity, outOfTime=false), so each pass
    // drains fully; the loop re-enters only across the fetch->publish phase boundary or a defer. Each pass is
    // idempotent + resumable, bounded by a generous cap.
    for (let pass = 1; pass <= 80; pass += 1) {
      result = await advanceFbaPlanBucket({
        bucket, asOf, inventoryAsOf, includedIds, bucketAccounts, cost, maxTokens,
        runtime: release.runtime, publisher: release.publisher, controls: release.controls,
        readbackLive: release.readbackLive, ownershipBackfill: release.ownershipBackfill,
        trigger: "github", deadlineMs: Infinity, reserveMs: 0, outOfTime: () => false,
        overflowSellers,
        log: (m) => log(m),
      });
      log(bucket + " pass " + pass + ": phase=" + result.phase + " published=" + result.published + " readback=" + result.readback + (result.continuationRequired ? " (continuation)" : "") + (result.problems ? " problems=" + JSON.stringify(result.problems) : ""));
      if (result.phase === "complete" && result.ok === true) break;
      if (result.ok === false) break;
      if (result.continuationRequired !== true) break;
    }
    if (result && result.phase === "complete" && result.ok === true) {
      anyPublished += result.published;
      log(bucket + " DONE: fba-plan published for " + result.published + " accounts (read back " + result.readback + "); controls safe-closed.");
    } else {
      anyFailure = true;
      console.error("STOP " + bucket + " did not complete: phase=" + (result && result.phase) + " problems=" + JSON.stringify(result && result.problems));
    }
  }
} catch (e) {
  console.error("STOP go-live failed: " + (e && e.message ? e.message : e));
  // Safety net: the core safe-closes per bucket in a finally, but a throw before/around a pass could leave gates
  // open -- close them explicitly through the same release seam.
  try { await release.controls.close(); log("controls safe-closed (catch)."); } catch (ce) { console.error("STOP SAFE-CLOSE FAILED: " + (ce && ce.message ? ce.message : ce)); }
  process.exit(1);
}
if (anyFailure && !anyPublished) { console.error("STOP zero accounts published live -- see problems above."); process.exit(1); }
log("DONE: fba-plan published for " + anyPublished + " accounts total (inventory requested through " + inventoryAsOf + "); controls safe-closed.");
process.exit(anyFailure ? 1 : 0);
