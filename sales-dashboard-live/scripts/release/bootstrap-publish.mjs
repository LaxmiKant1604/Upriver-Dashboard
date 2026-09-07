// TRUSTED, SCOPED bootstrap PUBLICATION operator. Usage (from sales-dashboard-live/):
//   node scripts/release/bootstrap-publish.mjs --region=<india|europe-au|us-ca> --dispatch-id=<id> [--strict-d1]
//
// It derives, finalizes, publishes and live-reads-back the Daily Reporting + Brand Sales + Brand Inventory
// dashboards for EXACTLY the immutable dispatch-wave accounts -- and nothing outside the wave:
//   - the account set is the FROZEN (region, dispatch_id) row (resolveBootstrapScopeByDispatch), readiness
//     re-checked so a flapped account is DEFERRED (never dropped-to-widen);
//   - a DEDICATED cycle namespace (bootstrap-<region>) so it NEVER collides with the natural (region,
//     cycle_date) daily cycle (exactly like FBA's <region>-fba);
//   - the runtime discovers EXACTLY the wave accounts (build-time fetchAccounts override), so derive +
//     finalize + publish + read-back cover only them; no unrelated account is written/approved/republished;
//   - the ONE org-wide Product Catalog create the derive may make is gated against the wave budget's
//     approved 'catalog' step BEFORE any create; OLI/FBA were already fetched by their gated steps.
// It reuses the reviewed full-region composition + runner unchanged (no full-region contract is weakened).
// Exit 0 ONLY on a proven full success (every wave account's three dashboards published + read back live).

import pg from "pg";
import { loadReleaseEnv } from "./env-bootstrap.mjs";
import { ONBOARDING_REGIONS } from "../../lib/server/sync/account-onboarding.js";

loadReleaseEnv();

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const region = (argOf("region") || "").trim();
const dispatchId = (argOf("dispatch-id") || "").trim();
// The ACTIVE run token (github run_id-run_attempt) -- the dispatch's active_run_token. It BINDS the manifest
// provenance to THIS attempt (Round-7 blocker 2): the RPC rejects a manifest write whose run token is not the
// dispatch's active token, and the completion proof requires it to match, so a stale/superseded attempt can
// neither complete nor overwrite the live one.
const runToken = (argOf("run-token") || "").trim();
// Round-11 P0-A: the EXACT fencing generation the matching --apply (bootstrap_controls) emitted. Publication
// RENEWS this immutable fence -- it NEVER re-acquires -- so it can only publish under the SAME controls that
// apply opened; an expired/mismatched fence is CONTROL_LEASE_LOST (zero writes). Required + positive safe integer.
const rawOwnerGen = (argOf("owner-generation") || "").trim();
const ownerGeneration = /^\d+$/.test(rawOwnerGen) ? Number(rawOwnerGen) : NaN;
const strictD1 = process.argv.includes("--strict-d1");
if (!ONBOARDING_REGIONS.includes(region)) { console.error("STOP --region must be india | europe-au | us-ca (got: " + region + ")"); process.exit(2); }
if (!dispatchId) { console.error("STOP --dispatch-id is required (the immutable wave identity)"); process.exit(2); }
if (!runToken) { console.error("STOP --run-token is required (the active run token that binds the publication manifest to this attempt)"); process.exit(2); }
if (!(Number.isSafeInteger(ownerGeneration) && ownerGeneration > 0)) { console.error("STOP --owner-generation is required (a positive integer: the EXACT generation the matching --apply emitted)."); process.exit(2); }
const log = (m) => console.log("bootstrap-publish[" + region + "/" + dispatchId.slice(-8) + "]: " + m);

const { getDataDoeConnections } = await import("../../lib/server/datadoe-connections.js");
const { resolveBootstrapScopeByDispatch, gateOnboardingBudget, recordOnboardingActualSpend, findApprovedStepEntry, bootstrapStepRef, assertBootstrapStepPlan } = await import("../../lib/server/sync/account-onboarding-bootstrap.js");
const { buildPriorityDashboardsRelease, PRIORITY_DASHBOARDS } = await import("../../lib/server/sync/source-priority-dashboards.js");
const { runPriorityDashboardsRelease, buildLiveReadback } = await import("../../lib/server/sync/source-priority-release-runner.js");
const { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } = await import("../../lib/server/sync/report-publisher.js");
const { REPORT_DERIVATIONS } = await import("../../lib/server/sync/report-derivation.js");
const { paramsHashFor } = await import("../../lib/server/report-store.js");
const sb = await import("../../lib/server/supabase.js");

// 1. FROZEN scope + PINNED dates from the approved plan.
const primaryConn = getDataDoeConnections().find((c) => c.id === "primary");
if (!primaryConn || !primaryConn.apiKey) { console.error("STOP primary DataDoe connection not configured."); process.exit(1); }
const scope = await resolveBootstrapScopeByDispatch({ apiKey: primaryConn.apiKey, region, dispatchId });
if (!scope.ok) { console.error("STOP BOOTSTRAP_SCOPE_UNRESOLVED (" + scope.reason + ") -- ZERO publication (fail closed)."); process.exit(1); }
if (!scope.allReady) {
  // DEFER THE ENTIRE WAVE: not every frozen account is DataDoe-ready. Publish NOTHING (never a ready
  // subset that would terminalize the wave's cycle and strand the deferred accounts). The completion
  // gate finds the wave not-live and the run acks 'failed' (retryable) -- never a false completion.
  log("BOOTSTRAP_WAVE_DEFERRED: " + scope.deferred.length + " of " + scope.frozenAccountIds.length + " frozen account(s) not DataDoe-ready -- ENTIRE wave deferred; nothing published this pass.");
  console.log("RESULT " + JSON.stringify({ ok: true, region, published: 0, deferred: scope.deferred.length, classification: "BOOTSTRAP_WAVE_DEFERRED" }));
  process.exit(0);
}
const catalogEntry = findApprovedStepEntry(scope.approvedPlan, "catalog", region);
if (!catalogEntry) { console.error("STOP BOOTSTRAP_STEP_NOT_APPROVED: no approved 'catalog' plan entry for " + region + " (fail closed)."); process.exit(1); }
const planAsOf = String(catalogEntry.planAsOf || "").trim();
if (!/^\d{4}-\d{2}-\d{2}$/.test(planAsOf)) { console.error("STOP BOOTSTRAP_BAD_PIN: approved catalog planAsOf is not a date (" + planAsOf + ")"); process.exit(1); }
log(scope.accounts.length + " frozen wave account(s) ALL ready; planAsOf pinned to " + planAsOf + "; wave-bound cycle " + scope.cycleBucket);

// 2. CATALOG BUDGET GATE (before ANY create): the publication derive may make ONE org-wide Product Catalog
// create. RECOMPUTE the catalog step plan hash from the ACTUAL runtime plan (frozen accounts + pinned
// planAsOf + the org-current catalog identity) and REQUIRE it to equal the approved hash -- NEVER echo.
const catChk = assertBootstrapStepPlan(catalogEntry, {
  step: "catalog", region, accounts: scope.frozenAccountIds, operationIds: scope.operationIds,
  accountSetHash: scope.accountSetHash, planAsOf,
  sourceKeys: ["product-catalog"], windows: [{ sourceKey: "product-catalog", snapshotIdentity: "org-current" }],
  batchMembership: [], requestHashes: [], limits: [],
});
if (!catChk.ok) { console.error("STOP BOOTSTRAP_STEP_PLAN_DRIFT (" + catChk.reason + "): the runtime catalog plan does not match the approved stepPlanHash -- ZERO creates (fail closed)."); process.exit(1); }
const catalogRef = bootstrapStepRef({ step: "catalog", region, stepPlanHash: catChk.stepPlanHash });
const catGate = await gateOnboardingBudget({
  waveKey: scope.waveKey, ref: catalogRef, stepType: "catalog", region,
  accountSetHash: scope.accountSetHash, stepPlanHash: catChk.stepPlanHash,
  plannedTokens: Number(catalogEntry.plannedTokens) || 0, plannedCreates: Number(catalogEntry.plannedCreates) || 0,
});
if (!catGate.ok) { console.error("STOP ONBOARDING_BUDGET_REFUSED (" + catGate.refusal + (catGate.detail ? "/" + catGate.detail : "") + ") for " + catalogRef + " -- ZERO creates (fail closed before any POST)."); process.exit(1); }
log("catalog budget " + catGate.disposition + " for " + catalogRef + " (runtime plan hash MATCHES approved; reserved " + catGate.reservedTokens + "/" + catGate.authorizedTokens + ")");

// 3. Build the SCOPED release: WAVE-BOUND cycle bucket (bootstrap-<region>-<membership-hash>) + build-time
// discovery narrowed to EXACTLY the frozen wave accounts. operationKey shares the natural scheduled
// Catalog reservation for planAsOf (org-wide, one create/day), pinned asOf = planAsOf (retry-stable).
const frozenAccounts = scope.accounts; // legacy shape == fetchAccounts(apiKey) output
// Round-9/11 P0-A: the control fence captured below (via renewControlPlaneLease of the SUPPLIED apply fence, never
// re-acquired). getControlFence reads this MUTABLE reference at each write so EVERY report write goes through the
// WRITE-BOUNDARY-FENCED CAS at the exact apply generation.
let leaseFence = null;
let release;
try {
  release = buildPriorityDashboardsRelease({
    asOfOverride: planAsOf,
    operationKey: "priority-dashboards/scheduled/" + planAsOf,
    cycleBucket: scope.cycleBucket,
    fetchAccounts: async () => frozenAccounts,
    getCycleByBucketDate: sb.getBaseSyncCycleByBucketDate,
    getControlFence: () => leaseFence,
  });
} catch (e) { console.error("STOP " + (e && e.message ? e.message : e)); process.exit(2); }

const pgBase = String(process.env.POSTGRES_URL).split("?")[0];
const makePgReadOnly = () => new pg.Client({ connectionString: pgBase, ssl: { rejectUnauthorized: false } });
async function assertNoCron() {
  const client = makePgReadOnly();
  try {
    await client.connect();
    const t = await client.query("select to_regclass('cron.job')::text cron_table");
    if (!t.rows[0].cron_table) return { ok: true };
    const n = await client.query("select count(*)::int n from cron.job where command ilike '%scheduler%' or command ilike '%sync%' or command ilike '%priority%'");
    return n.rows[0].n === 0 ? { ok: true } : { ok: false, reason: "scheduler cron present (" + n.rows[0].n + ")" };
  } catch (e) { return { ok: false, reason: "cron read failed: " + (e && e.message) }; }
  finally { try { await client.end(); } catch { /* ignore */ } }
}
async function reconcile() {
  const cron = await assertNoCron();
  if (!cron.ok) return { ok: false, problems: [cron.reason] };
  try {
    const rollout = await sb.getSchedulerAccountRollout();
    if (!rollout || rollout.read !== "ok" || rollout.allPrimary === true) return { ok: false, problems: ["scheduler rollout not read-ok / all_primary=true"] };
    return { ok: true };
  } catch (e) { return { ok: false, problems: ["reconcile read failed: " + (e && e.message)] }; }
}
const readbackLive = buildLiveReadback({
  getReportSnapshot: sb.getReportSnapshot,
  loadStoragePayload: sb.getReportSnapshotStoragePayload,
  liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS,
  reportDerivations: REPORT_DERIVATIONS,
  computeHash: paramsHashFor,
});

// Round-11 P0-A PUBLICATION FENCING: the priority controls were opened by a SEPARATE --apply (bootstrap_controls)
// process that holds the global lease under THIS run token at THIS EXACT generation. Publication RENEWS that
// immutable fence (owner_token + the supplied --owner-generation) -- it NEVER re-acquires -- so it can only
// publish under the SAME controls apply opened. renewed => use exactly the supplied fence; expired/mismatch =>
// CONTROL_LEASE_LOST, zero publication writes (the apply lease lapsed / another generation took over). The fence
// is enforced INSIDE each report_snapshots CAS (via getControlFence -> the fenced CAS) AND heartbeated per account.
try {
  const r = await sb.renewControlPlaneLease({ ownerToken: runToken, generation: ownerGeneration, ttlSeconds: 900 });
  if (!r || r.disposition !== "renewed") {
    console.error("STOP CONTROL_LEASE_LOST: could not RENEW the apply fence (owner " + String(runToken).slice(0, 16) + " gen " + ownerGeneration + " -> " + String(r && (r.reason || r.disposition)) + "); the apply lease lapsed or another generation took over -- publishing nothing (retryable). NEVER re-acquiring.");
    console.log("RESULT " + JSON.stringify({ ok: false, region, published: 0, classification: "CONTROL_LEASE_LOST" }));
    process.exit(1);
  }
  // Use EXACTLY the supplied immutable fence (never adopt/read-back/replace the generation).
  leaseFence = { ownerToken: runToken, generation: ownerGeneration };
} catch (e) { console.error("STOP could not renew the control-plane lease (" + (e && e.message) + ") -- failing closed (retryable)."); process.exit(1); }
const verifyLease = async () => {
  try { const r = await sb.renewControlPlaneLease({ ownerToken: leaseFence.ownerToken, generation: leaseFence.generation, ttlSeconds: 900 }); return { ok: !!(r && r.disposition === "renewed"), reason: r && (r.reason || r.disposition) }; }
  catch (e) { return { ok: false, reason: "renew-error:" + (e && e.message ? e.message : e) }; }
};

const result = await runPriorityDashboardsRelease({
  release, reconcile, readbackLive, assertNoCron, verifyLease,
  bucket: region, ...(strictD1 ? { strictD1: true } : {}),
  log: (m) => console.log("bootstrap-publish: " + m),
});

// 4. Record the ACTUAL Catalog spend (cumulative; over-reservation surfaced loudly).
try {
  const reservation = await release.catalogReservation(null);
  const catActualTokens = reservation && String(reservation.status) === "created" ? Number(reservation.tokensSpent) || 0 : 0;
  const catActualCreates = catActualTokens > 0 ? 1 : 0;
  const rec = await recordOnboardingActualSpend({ waveKey: scope.waveKey, ref: catalogRef, actualTokens: catActualTokens, actualCreates: catActualCreates });
  if (rec && rec.disposition === "over-reservation") {
    console.error("WARNING ONBOARDING_OVER_RESERVATION: " + catalogRef + " catalog actuals exceeded the approved ceiling -- investigate.");
  }
} catch { /* fail-soft accounting; the reservation ceiling already bounds the spend */ }

// 5. RECORD the PUBLICATION MANIFEST (blocker 7): the EXACT live identity (report_key, account, params_hash,
// coversAsOf, operation) this wave produced for daily-reporting / brand-sales / brand-inventory. The
// completion proof re-reads each live snapshot by THIS exact identity (never merely the newest). Only on a
// fully-successful publication (result.ok) -- a failed publication records nothing and stays incomplete.
if (result.ok && Array.isArray(result.publishedIdentities)) {
  const operationKey = "priority-dashboards/scheduled/" + planAsOf;
  let recorded = 0; let staleToken = 0;
  for (const p of result.publishedIdentities) {
    // PROVENANCE (blocker 2): the ACTUAL durable cycle id the runner finalized (NEVER the cycle bucket label),
    // the operation identity, and the ACTIVE run token. The RPC refuses a blank/bucket-label cycle id, an
    // out-of-membership account, or a non-active run token.
    const cycleId = String(p.cycleId || "");
    if (!cycleId || /^bootstrap(-fba)?-/.test(cycleId)) { console.error("WARNING skipping manifest for " + p.reportKey + "/" + String(p.accountId).slice(0, 8) + ": missing/label cycle id (" + cycleId + ")"); continue; }
    try {
      const rec = await sb.recordOnboardingPublication({
        region, dispatchId, accountId: String(p.accountId), reportKey: String(p.liveReportKey || p.reportKey),
        paramsHash: String(p.paramsHash), coversAsOf: planAsOf, cycleId, cycleBucket: scope.cycleBucket, operationKey, runToken,
      });
      if (rec && rec.disposition === "stale-run-token") { staleToken += 1; continue; }
      recorded += 1;
    } catch (e) { console.error("WARNING could not record publication manifest for " + p.reportKey + "/" + String(p.accountId).slice(0, 8) + ": " + (e && e.message)); }
  }
  log("recorded " + recorded + " publication-manifest identit(ies) for the wave at D-1 " + planAsOf + (staleToken ? " (" + staleToken + " refused: not the active run token)" : "") + ".");
}

console.log("RESULT " + JSON.stringify({ ok: result.ok, stage: result.stage, region, accounts: scope.accounts.length, deferred: scope.deferred.length, evidence: result.evidence || null, problems: result.problems || null }));
if (!result.ok) { console.error("STOP bootstrap publication did not fully succeed (stage=" + result.stage + "): " + JSON.stringify(result.problems || [])); }
process.exit(result.code);
