// TRUSTED, READ-ONLY completion gate for a bootstrap wave -- the ONLY thing that authorizes a 'completed'
// ack. Usage (from sales-dashboard-live/):
//   node scripts/release/verify-bootstrap-published.mjs --region=<...> --dispatch-id=<id>
//
// It resolves the IMMUTABLE (region, dispatch_id) wave scope + the approved planAsOf/inventoryAsOf, then
// performs an EXACT LIVE-READ (never snapshot-presence) for EVERY account in the FULL frozen set:
//   - loads the latest LIVE snapshot for daily-reporting / brand-sales / brand-inventory,
//   - proves the row's report identity + account scope,
//   - proves its coversAsOf (params.to) EQUALS the wave's approved D-1 (a STALE earlier-date/earlier-wave
//     snapshot has coversAsOf < planAsOf and FAILS -- presence never satisfies it),
//   - proves the live report version (provenance) + a valid, available payload (storage-first hydration).
//   - FBA: fba-plan live at the EXACT approved inventory D-1, OR a DURABLE TYPED unavailable row for the
//     EXACT (region, dispatch, account, 'fba-plan', inventory D-1). Absence alone FAILS.
// An EMPTY/unresolved scope, or ANY frozen account missing a required fresh live report (with no typed
// unavailable evidence for FBA), exits NONZERO -- so the workflow acks 'failed' (retryable), NEVER
// 'completed'. A changed membership mints a different dispatch id, so a drifted scope can never certify.

import { loadReleaseEnv } from "./env-bootstrap.mjs";
import { ONBOARDING_REGIONS } from "../../lib/server/sync/account-onboarding.js";

loadReleaseEnv();

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const region = (argOf("region") || "").trim();
const dispatchId = (argOf("dispatch-id") || "").trim();
if (!ONBOARDING_REGIONS.includes(region)) { console.error("STOP --region must be india | europe-au | us-ca (got: " + region + ")"); process.exit(2); }
if (!dispatchId) { console.error("STOP --dispatch-id is required (the immutable wave identity)"); process.exit(2); }
const log = (m) => console.log("verify-bootstrap-published[" + region + "/" + dispatchId.slice(-8) + "]: " + m);

const sb = await import("../../lib/server/supabase.js");
const { findApprovedStepEntry, verifyBootstrapCompletion } = await import("../../lib/server/sync/account-onboarding-bootstrap.js");
const { bootstrapCycleBucket, bootstrapFbaCycleBucket, dispatchMembershipHash } = await import("../../lib/server/sync/account-onboarding.js");
const { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } = await import("../../lib/server/sync/report-publisher.js");
const { REPORT_DERIVATIONS } = await import("../../lib/server/sync/report-derivation.js");

const S = (v) => (v == null ? "" : String(v).trim());

// The FROZEN, immutable scope -- the FULL set (not a ready subset): completion requires EVERY wave
// account live, so a deferred/never-published account correctly keeps the wave incomplete.
const row = await sb.getOnboardingDispatchRow({ region, dispatchId });
if (!row) { console.error("STOP DISPATCH_ROW_NOT_FOUND for " + region + "/" + dispatchId + " -- cannot certify (fail closed)."); process.exit(1); }
const frozen = (Array.isArray(row.account_ids) ? row.account_ids : []).map((x) => S(x)).filter(Boolean);
if (!frozen.length) { console.error("STOP EMPTY_WAVE_SCOPE -- an empty scope can never be a successful completion."); process.exit(1); }

// The approved D-1 dates (planAsOf/inventoryAsOf) come from the wave budget's approved plan.
const budget = await sb.getOnboardingBudget(S(row.wave_key));
if (!budget) { console.error("STOP BUDGET_NOT_AUTHORIZED for wave " + S(row.wave_key) + " -- cannot certify (fail closed)."); process.exit(1); }
const approvedPlan = Array.isArray(budget.approved_plan) ? budget.approved_plan : [];
const oliEntry = findApprovedStepEntry(approvedPlan, "oli", region);
const fbaEntry = findApprovedStepEntry(approvedPlan, "fba", region);
const planAsOf = S(oliEntry && oliEntry.planAsOf);
const inventoryAsOf = S(fbaEntry && fbaEntry.inventoryAsOf);
if (!/^\d{4}-\d{2}-\d{2}$/.test(planAsOf) || !/^\d{4}-\d{2}-\d{2}$/.test(inventoryAsOf)) {
  console.error("STOP BOOTSTRAP_BAD_APPROVED_DATES: planAsOf=" + planAsOf + " inventoryAsOf=" + inventoryAsOf + " (fail closed)."); process.exit(1);
}

// Durable evidence for THIS wave (region, dispatch) -- read once (fail closed on error): the publication
// MANIFEST (the exact identities + provenance the wave produced).
let publicationRows = [];
try { publicationRows = await sb.getOnboardingPublication({ region, dispatchId }); }
catch (e) { console.error("STOP publication-manifest read failed: " + (e && e.message ? e.message : e) + " (fail closed)."); process.exit(1); }

// The ACTIVE run token that a completing manifest row must carry (Round-7 blocker 2): the dispatch's current
// active_run_token. A row written by an earlier/superseded attempt (different token) can never complete.
const expectedRunToken = S(row.active_run_token);
if (!expectedRunToken) { console.error("STOP DISPATCH_NO_ACTIVE_RUN_TOKEN -- the wave has no active run lease; nothing can be certified (fail closed)."); process.exit(1); }

// The EXPECTED provenance PER REPORT (Round-8 blocker 3): resolve the ACTUAL durable cycle id for each report's
// bootstrap cycle (priority reports share bootstrap-<region>-<hash> at planAsOf; fba-plan uses
// bootstrap-fba-<region>-<hash> at inventoryAsOf), the DETERMINISTIC operation key each operator records, and
// the active run token. The manifest's recorded (cycleId, operationKey, runToken) must EQUAL these exactly.
const membershipHash = dispatchMembershipHash(dispatchId);
const priorityBucket = bootstrapCycleBucket(region, membershipHash);
const fbaBucket = bootstrapFbaCycleBucket(region, membershipHash);
async function cycleIdFor(bucket, date) {
  try { const c = await sb.getBaseSyncCycleByBucketDate(bucket, date); return c && c.id ? S(c.id) : ""; }
  catch (e) { console.error("STOP could not resolve the durable cycle for " + bucket + "@" + date + ": " + (e && e.message) + " (fail closed)."); process.exit(1); }
}
const priorityCycleId = await cycleIdFor(priorityBucket, planAsOf);
const fbaCycleId = await cycleIdFor(fbaBucket, inventoryAsOf);
if (!priorityCycleId || !fbaCycleId) { console.error("STOP BOOTSTRAP_CYCLE_NOT_FOUND: priority=" + priorityCycleId + " fba=" + fbaCycleId + " -- the wave's durable cycles are not resolvable (fail closed)."); process.exit(1); }
const expectedProvenance = {
  "daily-reporting": { cycleId: priorityCycleId, operationKey: "priority-dashboards/scheduled/" + planAsOf, runToken: expectedRunToken },
  "brand-sales": { cycleId: priorityCycleId, operationKey: "priority-dashboards/scheduled/" + planAsOf, runToken: expectedRunToken },
  "brand-inventory": { cycleId: priorityCycleId, operationKey: "priority-dashboards/scheduled/" + planAsOf, runToken: expectedRunToken },
  "fba-plan": { cycleId: fbaCycleId, operationKey: fbaBucket + "@" + inventoryAsOf, runToken: expectedRunToken },
};

// The EXACT-IDENTITY completion proof (shared, injectable core): re-reads each live snapshot by the EXACT
// (report_key, account, params_hash) the wave's manifest recorded -- never the newest -- and compares the
// recorded provenance (cycleId + operationKey + runToken) EXACTLY against the expected per-report values.
const { ok, problems } = await verifyBootstrapCompletion({
  frozenAccountIds: frozen, planAsOf, inventoryAsOf, publicationRows, expectedRunToken, expectedProvenance,
  readByIdentity: (args) => sb.getReportSnapshot(args),
  hydrate: (pathArg) => sb.getReportSnapshotStoragePayload(pathArg),
  liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS,
  reportDerivations: REPORT_DERIVATIONS,
});

if (!ok) {
  console.error("STOP BOOTSTRAP_NOT_FULLY_PUBLISHED: " + problems.length + " required live report(s) missing/stale across " + frozen.length + " wave account(s) at D-1 " + planAsOf + ": " + problems.slice(0, 20).map((p) => p.slice(0, 8) + p.slice(p.indexOf(":"))).join(", ") + (problems.length > 20 ? " ..." : "") + " -- NOT completed (retryable).");
  console.log("RESULT " + JSON.stringify({ ok: false, region, accounts: frozen.length, problems: problems.length }));
  process.exit(1);
}
log("ALL " + frozen.length + " wave account(s) have FRESH live Daily Reporting + Brand Sales + Brand Inventory at D-1 " + planAsOf + " (+ FBA live or typed-unavailable) -- wave publication COMPLETE.");
console.log("RESULT " + JSON.stringify({ ok: true, region, accounts: frozen.length, problems: 0 }));
process.exit(0);
