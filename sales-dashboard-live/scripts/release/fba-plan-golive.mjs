// TRUSTED operator for the FBA Shipment Plan go-live + the automatic per-bucket scheduled refresh. It runs the
// SHARED fba-plan operation core (lib/server/sync/fba-plan-operation.js) wired by the reviewed release seam
// (lib/server/sync/fba-plan-release-composition.js) -- the EXACT collaborators + pipeline the Data Sync Center
// route uses -- so the CLI, the scheduler, and the manual route cannot drift. The core runs the reviewed
// Scheduler-v2 machinery: the shadow dispatcher (batched marketplace-safe FBA Health/AWD fetch + durable
// OLI/catalog derive), the four-gate CAS publisher, the guarded fba-plan control package, an apply-gates ->
// publish -> read-back -> ownership -> ALWAYS-safe-close envelope, bounded by a hard token ceiling.
//
//   node scripts/release/fba-plan-golive.mjs --mode=dry-run   [--as-of=YYYY-MM-DD] [--inventory-as-of=YYYY-MM-DD] [--max-blocked=2] [--region=india|europe-au|us-ca|all] [--bucket=us|non-us|both]
//   node scripts/release/fba-plan-golive.mjs --mode=go-live   [--as-of=YYYY-MM-DD] [--inventory-as-of=YYYY-MM-DD] [--max-tokens=80] [--max-blocked=2] [--region=...] [--bucket=...]
//
// --inventory-as-of: OPTIONAL. Overrides the inventory snapshot date (default: fbaInventoryAsOf() = the previous
//   UTC date, D-1). Inventory is requested as EXACTLY [inventory-as-of .. inventory-as-of] (one snapshot day). The
//   regional scheduler passes ONE shared inventory_asof (D-1) so this FBA run and the downstream Listing Health v3
//   job adopt the SAME inventory identity. Manual callers that omit it get the same canonical D-1.
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

import { appendFileSync } from "node:fs";
import { loadReleaseEnv } from "./env-bootstrap.mjs";
import { REGION_SCOPES, isRegionScope } from "../../lib/server/sync/scheduler-scope.js";
loadReleaseEnv();

// HONEST COMPLETENESS signal: an EXPLICIT durable output, never inferred from the job's green status. Downstream
// completeness (per-account) is proven from `fba_complete` + the logged per-account breakdown, not the exit code.
const ghOut = (key, value) => { const f = process.env.GITHUB_OUTPUT; if (f) { try { appendFileSync(f, key + "=" + value + "\n"); } catch { /* summary must never fail the run */ } } };
const ghSum = (line) => { const f = process.env.GITHUB_STEP_SUMMARY; if (f) { try { appendFileSync(f, line + "\n"); } catch { /* ignore */ } } };

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
// Optional shared inventory snapshot date (regional scheduler passes ONE inventory_asof to both FBA and v3). Validate a
// real calendar date; default to fbaInventoryAsOf() (the previous UTC date, D-1 -- the canonical single snapshot day).
const inventoryAsOfArg = argOf("inventory-as-of");
if (inventoryAsOfArg != null) {
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(inventoryAsOfArg) && new Date(`${inventoryAsOfArg}T00:00:00Z`).toISOString().slice(0, 10) === inventoryAsOfArg;
  if (!ok) { console.error("STOP --inventory-as-of must be a real YYYY-MM-DD calendar date"); process.exit(2); }
}
let inventoryAsOf = inventoryAsOfArg || fbaInventoryAsOf();
// --account-scope: 'full' (default) | 'bootstrap' (ONLY the accounts the dispatch WAVE authorized,
// resolved from the IMMUTABLE (region, --dispatch-id) row -- never workflow inputs -- and gated by the
// ENFORCED wave budget before any create). inventoryAsOf is PINNED from the approved plan in bootstrap mode.
const accountScope = argOf("account-scope") || "full";
const dispatchId = argOf("dispatch-id");
if (accountScope !== "full" && accountScope !== "bootstrap") { console.error("STOP --account-scope must be full | bootstrap"); process.exit(2); }
if (accountScope === "bootstrap" && (!regionArg || regionArg === "all")) { console.error("STOP --account-scope=bootstrap requires ONE explicit --region"); process.exit(2); }
if (accountScope === "bootstrap" && !dispatchId) { console.error("STOP --account-scope=bootstrap requires --dispatch-id (the immutable wave identity)"); process.exit(2); }
const OPERATOR = process.env.PRIORITY_OPERATOR || "laxmikant@superboring.in";
// Round-7 blocker 1+2: the control-plane owner-lease token AND the publication-manifest run token. In the
// workflow this is github run_id-run_attempt (the SAME token as the priority --apply/--rollback steps + the
// dispatch's active_run_token), so the FBA operation serializes on the global control-plane lease with the
// priority publication and its manifest rows bind to the active attempt. A manual CLI run gets a
// process-stable token (unique per run) so the lease still serializes it against concurrent operations.
const runToken = (argOf("run-token") || "").trim() || ("fba-golive/" + (scopeLabel || "all") + "/" + process.pid + "-" + Date.now());
const { resolveBootstrapScopeByDispatch, gateOnboardingBudget, recordOnboardingActualSpend, findApprovedStepEntry, bootstrapStepRef, assertBootstrapStepPlan, fbaPlanStructure } = await import("../../lib/server/sync/account-onboarding-bootstrap.js");
const { bootstrapFbaCycleBucket, dispatchMembershipHash } = await import("../../lib/server/sync/account-onboarding.js");
const { getDataDoeConnections } = await import("../../lib/server/datadoe-connections.js");

// ---------------- Stage 0: BOOTSTRAP -- resolve the FROZEN wave scope BEFORE building the release, so the
// whole FBA release (runtime rollout, control discovery, source planning, fetching, deriving, publishing,
// readback, ownership) is constrained to EXACTLY frozenAccountIds via accountScopeIds. inventoryAsOf +
// the wave-bound FBA cycle are pinned here too.
let accounts;
let bootstrapScope = null;   // resolveBootstrapScopeByDispatch result (bootstrap mode only)
let bootstrapEntry = null;   // approved plan entry for (fba, region)
let bootstrapCycleBucket = null; // the WAVE-BOUND FBA cycle bucket (bootstrap-fba-<region>-<hash16>)
let release;
if (accountScope === "bootstrap") {
  const primaryConn = getDataDoeConnections().find((c) => c.id === "primary");
  bootstrapScope = await resolveBootstrapScopeByDispatch({ apiKey: primaryConn.apiKey, region: regionArg, dispatchId });
  if (!bootstrapScope.ok) { console.error("STOP BOOTSTRAP_SCOPE_UNRESOLVED (" + bootstrapScope.reason + ") for " + regionArg + "/" + dispatchId + " -- ZERO exports (fail closed)."); process.exit(1); }
  bootstrapEntry = findApprovedStepEntry(bootstrapScope.approvedPlan, "fba", regionArg);
  if (!bootstrapEntry) { console.error("STOP BOOTSTRAP_STEP_NOT_APPROVED: no approved 'fba' plan entry for " + regionArg + " (fail closed)."); process.exit(1); }
  // DEFER THE ENTIRE WAVE if any frozen account is not currently DataDoe-ready (never a ready subset).
  if (!bootstrapScope.allReady) {
    log("BOOTSTRAP_WAVE_DEFERRED: " + bootstrapScope.deferred.length + " of " + bootstrapScope.frozenAccountIds.length + " frozen account(s) not DataDoe-ready -- ENTIRE wave deferred (ZERO creates).");
    process.exit(0);
  }
  inventoryAsOf = String(bootstrapEntry.inventoryAsOf || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inventoryAsOf)) { console.error("STOP BOOTSTRAP_BAD_PIN: approved fba inventoryAsOf is not a date (" + inventoryAsOf + ")"); process.exit(1); }
  bootstrapCycleBucket = bootstrapFbaCycleBucket(regionArg, dispatchMembershipHash(dispatchId));
  // BUILD the release SCOPED to exactly the frozen accounts (blocker 1): the runtime rollout override +
  // control discovery + ownership are constrained here, so no outside-wave account is fetched/derived/
  // published/controlled.
  release = buildFbaPlanRelease({ operator: OPERATOR, accountScopeIds: bootstrapScope.frozenAccountIds, ownerToken: runToken, controlOperationKey: "fba-plan/bootstrap/" + regionArg + "/" + dispatchId.slice(-8) });
  accounts = bootstrapScope.accounts.map((a) => ({ accountId: String(a.id), country: String(a.country || ""), currency: a.currency || null, name: a.name || null }));
  if (!accounts.length) { log("BOOTSTRAP_SCOPE_EMPTY: no ready bootstrap accounts in " + regionArg + " (deferred " + bootstrapScope.deferred.length + ") -- ZERO creates, ZERO tokens."); process.exit(0); }
} else {
  release = buildFbaPlanRelease({ operator: OPERATOR, ownerToken: runToken, controlOperationKey: "fba-plan/" + (scopeLabel || "all") });
  accounts = await release.loadAccounts();
}
if (!accounts.length) { console.error("STOP no primary accounts with directory metadata discovered."); process.exit(1); }
log("discovered " + accounts.length + " primary accounts with metadata" + (accountScope === "bootstrap" ? " (bootstrap scope)" : ""));

// ---------------- Stage 1: resolve the coverage-maximizing go-live as-of (SHARED core) ----------------
log("inventory requested through " + inventoryAsOf + "; sales coverage resolved independently per region");

// ---------------- Stage 2: build the exact batched plan + prove the token cost (ZERO creates, SHARED core) ----
const bucketPlan = new Map();
let totalCreates = 0; let totalTokens = 0; let totalBatches = 0;
for (const bucket of selectedScopes) {
  const bucketAccounts = fbaBucketAccounts(accounts, bucket);
  if (!bucketAccounts.length) continue;
  const scope = await resolveFbaPlanScope({ accounts: bucketAccounts, connections: release.connections, asOfArg, maxBlocked, ceiling: CEILING, readers: release.scopeReaders });
  if (!scope.asOf && accountScope === "bootstrap") {
    // A claimed account whose OLI bootstrap has not landed yet has no coverage: a GREEN typed skip
    // (zero creates; the lease backoff / next natural run retries once OLI coverage exists).
    log("BOOTSTRAP_FBA_WAITING_FOR_OLI: no durable sales coverage yet for the bootstrap accounts -- ZERO creates; retry after the OLI bootstrap lands.");
    process.exit(0);
  }
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

// BOOTSTRAP BUDGET GATE (before ANY create/control change): reserve this attempt's adoption-aware
// planned cost against the durable WAVE budget, bound to the wave key + account-set hash + approved plan
// fingerprint + the approved STEP PLAN HASH (pins inventoryAsOf/source). The ref is DATE-FREE so a retry
// REUSES the ONE reservation (cumulative actuals capped by the approved ceiling). Refusal stops cold.
let fbaBudgetRef = null;
if (accountScope === "bootstrap") {
  // RECOMPUTE the fba step plan hash from the EXACT DEFAULT (no-overflow) runtime FBA plan STRUCTURE
  // (frozen sellers, marketplace pairs, default <=5 batches, request hashes, source keys, row limits,
  // inventoryAsOf) + the reviewed adaptiveSplitAllowed envelope, and REQUIRE it to equal the approved
  // hash -- NEVER echo. A modified seller/pair/batch/request/limit/date is drift; a legitimate overflow
  // split at execution is not. (The default plan is deterministic; the sales asOf never enters it.)
  const bootBucket = selectedScopes[0];
  const bp = bucketPlan.get(bootBucket);
  const { plan: defaultFbaPlan } = await planFbaBucketCost({ bucketAccounts: bp.bucketAccounts, connections: release.connections, asOf: bp.scope.asOf, inventoryAsOf, getSourceExportCache: release.getSourceExportCache, overflowSellers: new Set() });
  const structure = fbaPlanStructure(defaultFbaPlan, inventoryAsOf);
  const chk = assertBootstrapStepPlan(bootstrapEntry, {
    step: "fba", region: regionArg, accounts: bootstrapScope.frozenAccountIds, operationIds: bootstrapScope.operationIds,
    accountSetHash: bootstrapScope.accountSetHash, inventoryAsOf,
    sourceKeys: ["fba-inventory-health"], windows: [{ sourceKey: "fba-inventory-health", from: inventoryAsOf, to: inventoryAsOf }],
    structure,
  });
  if (!chk.ok) { console.error("STOP BOOTSTRAP_STEP_PLAN_DRIFT (" + chk.reason + "): the runtime FBA plan structure does not match the approved stepPlanHash -- ZERO creates (fail closed before any reservation/POST)."); process.exit(1); }
  fbaBudgetRef = bootstrapStepRef({ step: "fba", region: regionArg, stepPlanHash: chk.stepPlanHash });
  const gate = await gateOnboardingBudget({
    waveKey: bootstrapScope.waveKey, ref: fbaBudgetRef, stepType: "fba", region: regionArg,
    accountSetHash: bootstrapScope.accountSetHash, stepPlanHash: chk.stepPlanHash,
    plannedTokens: totalTokens, plannedCreates: totalCreates,
  });
  if (!gate.ok) {
    console.error("STOP ONBOARDING_BUDGET_REFUSED (" + gate.refusal + (gate.detail ? "/" + gate.detail : "") + "): planned " + totalTokens + " token(s) for " + fbaBudgetRef + " (wave " + bootstrapScope.waveKey + ") -- ZERO creates issued (fail closed before any POST).");
    process.exit(1);
  }
  log("onboarding budget " + gate.disposition + " for " + fbaBudgetRef + ": planned " + totalTokens + " token(s) (reserved " + gate.reservedTokens + "/" + gate.authorizedTokens + "); deferred " + bootstrapScope.deferred.length + " not-ready account(s)");
}

// ---------------- go-live: run each SELECTED bucket to completion via the SHARED bounded pass ----------------
let anyPublished = 0; let anyFailure = false; let anyIncomplete = false;
// Per-bucket published/expected/failed breakdown for the honest completeness report (never a green "complete").
const bucketCompleteness = []; // [{ bucket, published, expected, failed }]
// Per-wave fba-plan publication identities (blocker 2): the EXACT live identity + the ACTUAL durable cycle id
// + operation identity this operation produced. There is NO "source-incapable" evidence (blocker 3): an
// empty-inventory account still PUBLISHES (inventoryAvailable:false) and earns a manifest identity here.
const waveFbaPublished = []; // [{ accountId, liveReportKey, paramsHash, cycleId, operationId }]
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
        verifyLease: release.verifyLease,
        // ZERO-EXPORT durable FBA source persist: land source_snapshots(fba-inventory-health) from the just-fetched
        // cache so the zero-export FBA reconciler can converge (the fba-plan derive alone never wrote it).
        persistDurableFbaSnapshots: release.persistDurableFbaSnapshots,
        trigger: "github", deadlineMs: Infinity, reserveMs: 0, outOfTime: () => false,
        overflowSellers,
        // BOOTSTRAP: a WAVE-BOUND FBA cycle (no collision with a terminal natural <region>-fba cycle) +
        // STRICT per-account honesty (any failed included account makes the whole result partial, so the
        // wave stays incomplete/retryable and never falsely completes).
        ...(accountScope === "bootstrap" ? { cycleBucketOverride: bootstrapCycleBucket, strict: true } : {}),
        log: (m) => log(m),
      });
      log(bucket + " pass " + pass + ": phase=" + result.phase + " published=" + result.published + " readback=" + result.readback + (result.continuationRequired ? " (continuation)" : "") + (result.problems ? " problems=" + JSON.stringify(result.problems) : ""));
      if (result.phase === "complete" && result.ok === true) break;
      if (result.phase === "partial") break; // natural per-account partial (ok:true, complete:false) or strict (ok:false)
      if (result.ok === false) break;
      if (result.continuationRequired !== true) break;
    }
    const bucketPublished = Number(result && result.published) || 0;
    const bucketFailed = result && Array.isArray(result.failedAccounts) ? result.failedAccounts : [];
    bucketCompleteness.push({ bucket, published: bucketPublished, expected: includedIds.length, failed: bucketFailed });
    if (result && result.phase === "complete" && result.ok === true && result.complete === true) {
      anyPublished += bucketPublished;
      for (const pi of (Array.isArray(result.publishedIdentities) ? result.publishedIdentities : [])) {
        if (pi.liveReportKey && pi.paramsHash) waveFbaPublished.push({ accountId: String(pi.accountId), liveReportKey: String(pi.liveReportKey), paramsHash: String(pi.paramsHash), cycleId: String(result.cycleId || ""), operationId: String(result.operationId || "") });
      }
      log(bucket + " DONE: fba-plan published for " + bucketPublished + "/" + includedIds.length + " accounts (read back " + result.readback + "); controls safe-closed.");
    } else if (result && result.phase === "partial" && result.ok === true) {
      // NATURAL per-account partial: the published accounts are LIVE (counted); the failed accounts keep their
      // last-known-good (no live write happened for them). The region is HONESTLY NOT complete -- this is never
      // reported as a green "complete". Siblings still proceed (LKG-tolerant); completeness is the explicit signal.
      anyPublished += bucketPublished;
      anyIncomplete = true;
      console.error("WARNING " + bucket + " PARTIAL: " + bucketPublished + "/" + includedIds.length + " accounts published live; failed=" + JSON.stringify(bucketFailed) + " (LKG preserved). Region FBA is NOT complete -- fba_complete=false.");
    } else {
      anyFailure = true;
      console.error("STOP " + bucket + " did not complete: phase=" + (result && result.phase) + (bucketFailed.length ? " failedAccounts=" + JSON.stringify(bucketFailed) : "") + " problems=" + JSON.stringify(result && result.problems));
    }
    // AGGREGATE budget tracking (bootstrap scope): record the ACTUAL creates/tokens this run spent.
    // An 'over-reservation' answer is surfaced LOUDLY (never silent).
    if (fbaBudgetRef && result) {
      const rec = await recordOnboardingActualSpend({ waveKey: bootstrapScope.waveKey, ref: fbaBudgetRef, actualTokens: Number(result.tokens) || 0, actualCreates: Number(result.creates) || 0 });
      if (rec && rec.disposition === "over-reservation") {
        console.error("WARNING ONBOARDING_OVER_RESERVATION: " + fbaBudgetRef + " actuals " + (Number(result.tokens) || 0) + " tok/" + (Number(result.creates) || 0)
          + " creates EXCEEDED reservation " + rec.reserved_tokens + " tok/" + rec.reserved_creates + " -- investigate before the next wave step.");
      }
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

// BOOTSTRAP fba-plan PUBLICATION MANIFEST (blocker 7 + Round-7 blocker 2 PROVENANCE): record the EXACT live
// fba-plan identity per published frozen account -- with the ACTUAL durable cycle id (result.cycleId, never a
// bucket label), the operation identity, and the ACTIVE run token -- so the completion proof re-reads by exact
// identity (never the newest) and rejects a stale/superseded attempt. Only on a fully-successful FBA go-live.
if (accountScope === "bootstrap" && !anyFailure && waveFbaPublished.length) {
  try {
    const { recordOnboardingPublication } = await import("../../lib/server/supabase.js");
    let recorded = 0; let staleToken = 0;
    for (const p of waveFbaPublished) {
      if (!p.cycleId || /^bootstrap(-fba)?-/.test(p.cycleId)) { console.error("WARNING skipping fba-plan manifest for " + String(p.accountId).slice(0, 8) + ": missing/label cycle id (" + p.cycleId + ")"); continue; }
      const rec = await recordOnboardingPublication({ region: regionArg, dispatchId, accountId: p.accountId, reportKey: p.liveReportKey, paramsHash: p.paramsHash, coversAsOf: inventoryAsOf, cycleId: p.cycleId, cycleBucket: bootstrapCycleBucket, operationKey: p.operationId, runToken });
      if (rec && rec.disposition === "stale-run-token") { staleToken += 1; continue; }
      recorded += 1;
    }
    log("recorded " + recorded + " fba-plan publication-manifest identit(ies) at " + inventoryAsOf + (staleToken ? " (" + staleToken + " refused: not the active run token)" : "") + ".");
  } catch (e) { console.error("WARNING could not record fba-plan publication manifest: " + (e && e.message ? e.message : e)); }
}
// HONEST completeness: complete ONLY when no bucket hard-failed AND no bucket published a partial account set.
// Emitted as an EXPLICIT durable signal + step summary -- downstream must read this, never the green job status.
const fbaComplete = !anyFailure && !anyIncomplete;
const completenessSummary = bucketCompleteness.map((b) => b.bucket + " " + b.published + "/" + b.expected + (b.failed.length ? " (failed " + b.failed.length + ")" : "")).join("; ");
if (mode === "go-live") {
  ghOut("fba_complete", fbaComplete ? "true" : "false");
  // Emit a BOOLEAN string ("true"/"false"), not the numeric count -- the listing-health-v3 job gate is
  // `needs.fba.outputs.fba_published == 'true'` (a GitHub Actions STRING compare), so a count like "8" would never
  // equal "true" and would silently skip v3 on every region. true = at least one account published (partial OR
  // complete FBA region -> v3 runs, adopting inventory per account); false = a hard FBA crash (zero published ->
  // v3 skipped). The `anyPublished` COUNT is still used verbatim in the log lines below.
  ghOut("fba_published", anyPublished > 0 ? "true" : "false");
  ghSum("### FBA go-live completeness\n- **fba_complete=" + fbaComplete + "** -- " + (completenessSummary || "(no buckets)") + "\n- Completeness is per-account (every eligible account published at its exact live identity); a green job is NOT completeness evidence.");
}
if (fbaComplete) {
  log("DONE: fba-plan COMPLETE for " + anyPublished + " accounts total (" + (completenessSummary || "no buckets") + "; inventory requested through " + inventoryAsOf + "); controls safe-closed.");
} else if (!anyFailure) {
  console.error("PARTIAL: fba-plan published " + anyPublished + " account(s) but the region is NOT complete (" + completenessSummary + "); last-known-good preserved for unpublished accounts; fba_complete=false.");
}
process.exit(anyFailure ? 1 : 0);
