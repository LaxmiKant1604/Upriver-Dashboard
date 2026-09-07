// The TRUSTED scheduler-v2 BOOTSTRAP scope + the ENFORCED, region-local wave-budget gate.
//
// A scheduler-v2 run dispatched with run_scope=bootstrap --dispatch-id=<id> may spend tokens ONLY on the
// accounts that dispatch WAVE authorized: the IMMUTABLE (region, dispatch_id) row records the exact
// claimed account ids + operation ids, and every bootstrap step resolves its account set FROM THAT ROW
// (resolveBootstrapScopeByDispatch) -- NEVER by recomputing membership from current onboarding status,
// and NEVER from workflow inputs. A status change to partially_ready/ready mid-run does NOT remove an
// account from the run; a DataDoe readiness flap DEFERS that account safely (it is skipped this run, its
// LKG untouched) and NEVER widens scope.
//
// The region-local wave (computeOnboardingWaveIdentity(rows, region)) is used ONLY by the discovery
// worker to DECIDE the current wave identity + hold awaiting-budget; once a wave is dispatched, its
// scope is the frozen dispatch row.
//
// Every bootstrap-scoped PAID step must additionally pass the durable wave-budget gate BEFORE its first
// create POST: build its exact plan, compute the per-step plan hash (binding dates/windows/sources/
// batches/membership), reserve the APPROVED step ceiling against the authorized wave budget
// (reserve_onboarding_spend -- retry-safe: a same-day/next-day/post-crash retry REUSES the one
// reservation and cumulative actuals can never exceed the approved ceiling), and REFUSE when no
// authorized budget exists, the plan drifted, or the ceiling would be exceeded.

import { fetchAccountsDetailed } from "../datadoe.js";
import {
  getAccountOnboardingRows, getOnboardingBudget, getOnboardingDispatchRow,
  reserveOnboardingSpend, recordOnboardingSpendActual,
} from "../supabase.js";
import {
  filterBootstrapPendingAccounts, toLegacyAccountShape, accountDataDoeReady,
  computeOnboardingWaveIdentity, computeAllRegionOnboardingWaves, bootstrapAccountSetHash,
  onboardingPlanFingerprint, onboardingStepPlanHash, ONBOARDING_REGIONS,
  bootstrapCycleBucket, dispatchMembershipHash,
} from "./account-onboarding.js";

const S = (v) => (v == null ? "" : String(v).trim());

// The wave-identity primitives live in the PURE core (account-onboarding.js) so the structurally
// zero-export discovery worker can share them; re-exported here as the bootstrap-facing surface.
export {
  computeOnboardingWaveIdentity, computeAllRegionOnboardingWaves, bootstrapAccountSetHash,
  onboardingPlanFingerprint, onboardingStepPlanHash, bootstrapCycleBucket, dispatchMembershipHash,
};

// Parse a jsonb array column that may come back as an array or a JSON string (fail closed to []).
function asIdArray(v) {
  if (Array.isArray(v)) return v.map(S).filter(Boolean);
  if (typeof v === "string" && v.trim()) { try { const p = JSON.parse(v); return Array.isArray(p) ? p.map(S).filter(Boolean) : []; } catch { return []; } }
  return [];
}

/**
 * Resolve the CURRENT region-local bootstrap wave for a region (used by the DISCOVERY WORKER's
 * dispatch decision only -- it derives the wave identity + the currently-claimed, currently-ready set
 * to hold/lease). Legacy-shaped accounts, exactly like the gated discovery emits. FAIL CLOSED: an
 * invalid region throws; unreadable onboarding rows throw. Returns
 * { region, accounts, waveKey, dispatchId, accountSetHash, operationIds }.
 */
export async function resolveBootstrapScope(apiKey, { region, fetchDetailed = fetchAccountsDetailed, readOnboardingRows = getAccountOnboardingRows } = {}) {
  const r = S(region);
  if (!ONBOARDING_REGIONS.includes(r)) {
    throw new Error(`BOOTSTRAP_SCOPE_BAD_REGION: bootstrap scope requires a routing region (india|europe-au|us-ca; got "${r}") (fail closed).`);
  }
  const detailed = (await fetchDetailed(apiKey)) || [];
  const onboardingRows = await readOnboardingRows(); // null => filter throws (fail closed)
  const { accounts, operationIds } = filterBootstrapPendingAccounts({ detailedAccounts: detailed, onboardingRows, region: r });
  const wave = computeOnboardingWaveIdentity(onboardingRows, r);
  return {
    region: r,
    accounts: accounts.map(toLegacyAccountShape),
    waveKey: wave.waveKey,
    dispatchId: wave.dispatchId,
    accountSetHash: bootstrapAccountSetHash(accounts.map((a) => a.id)),
    operationIds,
  };
}

/**
 * Resolve the FROZEN bootstrap scope of a DISPATCHED wave by its EXACT (region, dispatch_id) -- the
 * authoritative path every bootstrap WORKFLOW STEP uses. It:
 *   1. loads the durable dispatch ROW (the IMMUTABLE wave scope: account_ids + operation_ids + wave_key);
 *   2. validates the wave has an AUTHORIZED budget whose key == the row's wave_key (identity match);
 *   3. takes the account + operation ids FROM THE ROW (never recomputed from onboarding status);
 *   4. re-reads current DataDoe readiness; if ANY frozen account is not ready, DEFERS THE ENTIRE WAVE
 *      (allReady=false, accounts=[]) so no paid export / cycle finalize / publication / materializer
 *      write ever touches a partial wave (Round-5 correction; the whole wave completes on a later retry
 *      once every account is ready). The scope NEVER widens.
 * Returns { region, dispatchId, waveKey, membershipHash, cycleBucket, accountSetHash, operationIds,
 *   frozenAccountIds, deferred, allReady, accounts (legacy shape -- the frozen set when allReady, else []),
 *   budget, approvedPlan, ok, reason }.
 * ok=false with a typed reason when the row/budget is missing, unauthorized, or identity-mismatched.
 */
export async function resolveBootstrapScopeByDispatch({
  apiKey, region, dispatchId,
  fetchDetailed = fetchAccountsDetailed, readDispatchRow = getOnboardingDispatchRow, readBudget = getOnboardingBudget,
} = {}) {
  const r = S(region);
  const did = S(dispatchId);
  if (!ONBOARDING_REGIONS.includes(r)) {
    throw new Error(`BOOTSTRAP_SCOPE_BAD_REGION: bootstrap scope requires a routing region (india|europe-au|us-ca; got "${r}") (fail closed).`);
  }
  if (!did) throw new Error("BOOTSTRAP_SCOPE_NO_DISPATCH_ID: a bootstrap workflow step requires --dispatch-id (fail closed).");
  const membershipHash = dispatchMembershipHash(did);
  if (!membershipHash) return { ok: false, reason: "DISPATCH_ID_MALFORMED", region: r, dispatchId: did };

  const row = await readDispatchRow({ region: r, dispatchId: did }); // STRICT read: throws on transport failure
  if (!row) return { ok: false, reason: "DISPATCH_ROW_NOT_FOUND", region: r, dispatchId: did };
  const waveKey = S(row.wave_key);
  const frozenAccountIds = asIdArray(row.account_ids).slice().sort();
  const operationIds = asIdArray(row.operation_ids).slice().sort();
  if (!waveKey || !frozenAccountIds.length) return { ok: false, reason: "DISPATCH_ROW_EMPTY_SCOPE", region: r, dispatchId: did };

  // The authorized budget must exist AND be bound to THIS wave key (an old/other wave's budget can
  // never authorize this dispatch).
  let budget = null;
  try { budget = await readBudget(waveKey); } catch { budget = null; }
  if (!budget) return { ok: false, reason: "BUDGET_NOT_AUTHORIZED", region: r, dispatchId: did, waveKey };
  if (S(budget.status) !== "authorized") return { ok: false, reason: "BUDGET_CLOSED", region: r, dispatchId: did, waveKey };
  if (S(budget.budget_key) !== waveKey) return { ok: false, reason: "WAVE_IDENTITY_MISMATCH", region: r, dispatchId: did, waveKey };

  // Re-read readiness for the FROZEN set. ALL-OR-NOTHING: if even one frozen account is not currently
  // DataDoe-ready, the ENTIRE wave is deferred (accounts=[]) -- never a ready subset.
  const detailed = (await fetchDetailed(apiKey)) || [];
  const byId = new Map(detailed.filter((a) => S(a && a.id)).map((a) => [S(a.id), a]));
  const frozenSet = new Set(frozenAccountIds);
  const readyAccounts = [];
  const deferred = [];
  for (const id of frozenAccountIds) {
    const acct = byId.get(id);
    if (acct && accountDataDoeReady(acct)) readyAccounts.push(toLegacyAccountShape(acct));
    else deferred.push(id);
  }
  const allReady = deferred.length === 0 && readyAccounts.length === frozenAccountIds.length;
  const cycleBucket = bootstrapCycleBucket(r, membershipHash);

  return {
    ok: true, region: r, dispatchId: did, waveKey, membershipHash, cycleBucket,
    accountSetHash: bootstrapAccountSetHash(frozenAccountIds),
    operationIds, frozenAccountIds, deferred, allReady,
    // Defense in depth: never a non-frozen account; empty until EVERY frozen account is ready.
    accounts: allReady ? readyAccounts.filter((a) => frozenSet.has(S(a.id))) : [],
    budget,
    approvedPlan: Array.isArray(budget.approved_plan) ? budget.approved_plan : [],
  };
}

/**
 * The canonical per-step approved-plan ENTRY builder, shared by the dry-run planner AND every runtime
 * paid operator so the stepPlanHash is computed identically on both sides. Given the wave identity + the
 * step's exact approved parameters, returns { step, region, accountSetHash, stepPlanHash, planAsOf,
 * inventoryAsOf, sourceKeys, windows, requestHashes, batchMembership, plannedCreates, plannedTokens }.
 */
export function buildOnboardingStepEntry({
  step, region, accounts, operationIds, accountSetHash,
  planAsOf = "", inventoryAsOf = "", sourceKeys = [], windows = [], requestHashes = [], batchMembership = [], limits = [],
  structure = null, plannedCreates = 0, plannedTokens = 0,
} = {}) {
  const stepPlanHash = onboardingStepPlanHash({
    step, region, accounts, operationIds, accountSetHash,
    planAsOf, inventoryAsOf, sourceKeys, windows, requestHashes, batchMembership, limits, structure,
  });
  return {
    step: S(step), region: S(region), accountSetHash: S(accountSetHash), stepPlanHash,
    planAsOf: S(planAsOf), inventoryAsOf: S(inventoryAsOf),
    sourceKeys: [...sourceKeys], windows: [...windows], requestHashes: [...requestHashes], batchMembership: [...batchMembership], limits: [...limits],
    ...(structure != null ? { structure } : {}),
    plannedCreates: Number(plannedCreates) || 0, plannedTokens: Number(plannedTokens) || 0,
  };
}

/**
 * The canonical, STABLE FBA seller-batch membership of a built FBA plan -- the sorted seller-id groups of
 * every FBA-inventory source request (deterministic from the frozen sellers + inventoryAsOf, independent
 * of the sales asOf). Shared by the wave planner AND the FBA operator so both hash identically.
 */
export function fbaSellerBatches(fbaPlan) {
  const requests = (fbaPlan && Array.isArray(fbaPlan.reportRequests)) ? fbaPlan.reportRequests : [];
  const seen = new Set();
  const batches = [];
  for (const r of requests) {
    for (const s of (r && Array.isArray(r.sources) ? r.sources : [])) {
      const family = S(s && (s.requestKey || s.sourceKey));
      if (!/inventory-health/i.test(family)) continue; // the FBA inventory family is "fba-plan:inventory-health"
      const sellers = [...new Set((s.sellerOrVendorIds || []).map(S).filter(Boolean))].sort();
      const key = sellers.join(",");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      batches.push(sellers);
    }
  }
  return batches.sort((a, b) => a.join(",").localeCompare(b.join(",")));
}

/**
 * The CANONICAL FBA plan STRUCTURE (Round-6 blocker 6) -- the exact approved FBA work bound into the step
 * hash, extracted from a DEFAULT (no-overflow) FBA plan so it is retry-stable yet detects any modified
 * seller/marketplace-pair/default-batch/request-hash/source/limit/inventoryAsOf. Includes ONLY the
 * fba-plan:* source families (asOf-independent). Adaptive single-seller overflow-splitting is represented
 * NOT by the actual runtime split (which varies) but by the `adaptiveSplitAllowed` flag on the entry -- a
 * reviewed deterministic split envelope over these exact default batches -- so a legitimate split never
 * drifts while a changed seller/pair/batch/request/limit does. Returns a canonical object.
 */
export function fbaPlanStructure(fbaPlan, inventoryAsOf) {
  const requests = (fbaPlan && Array.isArray(fbaPlan.reportRequests)) ? fbaPlan.reportRequests : [];
  const sellers = new Set();
  const pairs = new Set();
  const requestHashes = new Set();
  const sourceKeys = new Set();
  const limits = new Set();
  const batches = [];
  const seenBatch = new Set();
  for (const r of requests) {
    for (const s of (r && Array.isArray(r.sources) ? r.sources : [])) {
      const family = S(s && (s.requestKey || s.sourceKey));
      if (!/^fba-plan:/i.test(family)) continue; // ONLY the FBA export families (asOf-independent)
      sourceKeys.add(family);
      const rh = S(s.requestHash ?? s.request_hash);
      if (rh) requestHashes.add(rh);
      const lim = Number(s.limit ?? s.rowLimit);
      if (Number.isFinite(lim) && lim > 0) limits.add(lim);
      const batchSellers = [...new Set((s.sellerOrVendorIds || []).map(S).filter(Boolean))].sort();
      for (const id of batchSellers) sellers.add(id);
      for (const p of (Array.isArray(s.marketplacePairs) ? s.marketplacePairs : [])) {
        pairs.add(S(p && p.sellerId) + "@" + S(p && p.marketplace));
      }
      if (/inventory-health/i.test(family)) { // the FBA inventory family is "fba-plan:inventory-health"
        const key = batchSellers.join(",");
        if (key && !seenBatch.has(key)) { seenBatch.add(key); batches.push(batchSellers); }
      }
    }
  }
  return {
    inventoryAsOf: S(inventoryAsOf),
    sellers: [...sellers].sort(),
    marketplacePairs: [...pairs].sort(),
    defaultBatches: batches.sort((a, b) => a.join(",").localeCompare(b.join(","))),
    requestHashes: [...requestHashes].sort(),
    sourceKeys: [...sourceKeys].sort(),
    rowLimits: [...limits].sort((a, b) => a - b),
    adaptiveSplitAllowed: true,
  };
}

/**
 * RECOMPUTE the step plan hash from the ACTUAL runtime plan and REQUIRE it to equal the approved entry's
 * stepPlanHash BEFORE any reservation/POST (Round-5 correction for PLAN-HASH ECHO). The caller passes the
 * runtime-derived structural inputs (frozen accounts, operation ids, accountSetHash, pinned dates,
 * windows, live seller batches, request identities, limits); a modified runtime account/batch/date/
 * window/source/request produces a DIFFERENT hash than the approved entry and is rejected here -- the
 * approved hash is NEVER echoed. Returns { ok, stepPlanHash (the RECOMPUTED value to pass to the gate),
 * reason }.
 */
export function assertBootstrapStepPlan(approvedEntry, runtimeInputs) {
  if (!approvedEntry || !S(approvedEntry.stepPlanHash)) return { ok: false, reason: "NO_APPROVED_STEP" };
  const recomputed = onboardingStepPlanHash(runtimeInputs);
  if (recomputed !== S(approvedEntry.stepPlanHash)) {
    return { ok: false, reason: "STEP_PLAN_DRIFT", recomputed, approved: S(approvedEntry.stepPlanHash) };
  }
  return { ok: true, stepPlanHash: recomputed };
}

/**
 * The ENFORCED, RETRY-SAFE pre-POST budget gate for ONE bootstrap-scoped paid step, bound to the EXACT
 * wave + the EXACT per-step plan hash. A missing budget row is BUDGET_NOT_AUTHORIZED; a mismatched
 * account-set hash or step-plan hash, or an over-ceiling attempt, is PLAN_DRIFT / BUDGET_EXCEEDED --
 * refused BEFORE any create POST. `stepPlanHash` MUST be recomputed by the caller from its ACTUAL
 * planned work (via buildOnboardingStepEntry). Returns:
 *   { ok:true,  disposition:'reserved'|'already-reserved' }
 *   { ok:false, refusal:'BUDGET_NOT_AUTHORIZED'|'BUDGET_CLOSED'|'BUDGET_EXCEEDED'|'PLAN_DRIFT'|'BUDGET_UNREADABLE' }
 * A refusal never throws (typed outcome); the caller MUST issue zero create POSTs when ok is false.
 */
export async function gateOnboardingBudget({ waveKey, ref, stepType, region, accountSetHash, stepPlanHash, plannedTokens, plannedCreates, readBudget = getOnboardingBudget, reserve = reserveOnboardingSpend } = {}) {
  for (const [name, value] of [["waveKey", waveKey], ["ref", ref], ["stepType", stepType], ["region", region], ["accountSetHash", accountSetHash], ["stepPlanHash", stepPlanHash]]) {
    if (!S(value)) throw new Error(`gateOnboardingBudget requires a non-blank ${name} (fail closed).`);
  }
  const tokens = Number(plannedTokens);
  const creates = Number(plannedCreates);
  if (!Number.isInteger(tokens) || tokens < 0 || !Number.isInteger(creates) || creates < 0) {
    throw new Error("gateOnboardingBudget requires non-negative integer plannedTokens/plannedCreates (fail closed).");
  }
  let budget = null;
  try { budget = await readBudget(S(waveKey)); } catch { budget = null; }
  if (!budget) return { ok: false, refusal: "BUDGET_NOT_AUTHORIZED", ref, plannedTokens: tokens };
  if (S(budget.status) !== "authorized") return { ok: false, refusal: "BUDGET_CLOSED", ref, plannedTokens: tokens };
  let outcome = null;
  try {
    outcome = await reserve({
      budgetKey: S(waveKey), ref: S(ref), stepType: S(stepType), region: S(region),
      accountSetHash: S(accountSetHash), planFingerprint: S(budget.plan_fingerprint), stepPlanHash: S(stepPlanHash),
      tokens, creates,
    });
  } catch { outcome = null; }
  const disposition = S(outcome && outcome.disposition);
  if (disposition === "reserved" || disposition === "already-reserved") {
    return { ok: true, disposition, ref, plannedTokens: tokens, reservedTokens: outcome.reserved_tokens ?? null, authorizedTokens: outcome.authorized_tokens ?? budget.authorized_tokens };
  }
  if (disposition === "refused") return { ok: false, refusal: S(outcome.reason) || "BUDGET_EXCEEDED", detail: S(outcome.detail) || null, ref, plannedTokens: tokens, authorizedTokens: budget.authorized_tokens };
  return { ok: false, refusal: "BUDGET_UNREADABLE", ref, plannedTokens: tokens };
}

// Find the APPROVED plan entry for (step, region) in a wave budget's approved_plan (null when absent).
export function findApprovedStepEntry(approvedPlan, step, region) {
  const s = S(step); const r = S(region);
  return (Array.isArray(approvedPlan) ? approvedPlan : []).find((e) => e && S(e.step) === s && S(e.region) === r) || null;
}

/**
 * The STABLE per-step reservation ref (identity), derived from the step + region + the approved step
 * plan hash -- DATE-FREE, so a same-day / next-day / post-crash retry of the SAME approved work reuses
 * the ONE reservation without needing a new day or ref. `stepPlanHash` is the approved entry's hash.
 */
export function bootstrapStepRef({ step, region, stepPlanHash }) {
  return `${S(step)}/${S(region)}/${S(stepPlanHash).slice(0, 16)}`;
}

/**
 * PURE, INJECTABLE EXACT-IDENTITY completion proof for a bootstrap wave (Round-6 blocker 7 + Round-7 blocker 2
 * PROVENANCE). For EVERY frozen account + required report (INCLUDING fba-plan) it binds the EXACT live identity
 * the wave PRODUCED (from the durable publication MANIFEST) and re-reads THAT exact snapshot -- never merely
 * the newest per report/account, and never an earlier/superseded ATTEMPT's row:
 *   - a manifest row must exist for (account, report) (a missing entry => the wave did not publish it);
 *   - the manifest row's PROVENANCE must bind the CURRENT attempt: a nonblank durable cycle_id (never a cycle
 *     bucket label) AND, when an expectedRunToken is supplied, a run_token EQUAL to it (a row written by an
 *     earlier/superseded attempt with a different active run token can NEVER complete the current attempt);
 *   - the live snapshot is read by the EXACT (report_key, account, params_hash) the manifest recorded;
 *   - it must echo report_key + account + params_hash, carry the live report version (provenance), have
 *     coversAsOf (params.to) EQUAL to the manifest's coversAsOf AND the approved D-1 (a stale earlier-date
 *     snapshot fails), a nonblank source_refreshed_at, and a valid + available hydrated payload.
 *   - FBA (blocker 3 HONESTY): an fba-plan manifest entry proven EXACTLY like the others. An empty validated
 *     D-1 inventory is a VALID published snapshot (inventoryAvailable:false) with its own manifest identity;
 *     there is NO "typed unavailable" fallback (fba-plan never self-declares unavailable). Absence FAILS.
 * deps: publicationRows [{account_id, report_key, params_hash, covers_asof, cycle_id, run_token, ...}];
 *   expectedRunToken (the dispatch's ACTIVE run token; when nonblank, every manifest row must match it);
 *   readByIdentity({reportKey, accountId, paramsHash}) -> live row | null; hydrate(path) -> payload | null;
 *   liveContracts (report_key -> {liveReportKey, liveReportVersion}); reportDerivations (report_key ->
 *   {validatePayload}). Returns { ok, problems[] }.
 */
export async function verifyBootstrapCompletion({
  frozenAccountIds, planAsOf, inventoryAsOf, publicationRows = [], expectedRunToken = "", expectedProvenance = null,
  readByIdentity, hydrate, liveContracts, reportDerivations,
} = {}) {
  const frozen = [...new Set((frozenAccountIds || []).map(S).filter(Boolean))];
  if (!frozen.length) return { ok: false, problems: ["EMPTY_WAVE_SCOPE"] };
  const wantToken = S(expectedRunToken).trim();
  // Round-8 blocker 3: the EXACT expected provenance PER REPORT (cycleId + operationKey + runToken) resolved by
  // the caller from durable state (the actual sync_cycles id for the report's bootstrap bucket/date, the
  // deterministic operation key, and the active run token). When provided for a report, the manifest's recorded
  // provenance must EQUAL it exactly -- an arbitrary/foreign cycle or operation FAILS.
  const expProv = expectedProvenance && typeof expectedProvenance === "object" ? expectedProvenance : null;
  // The required live reports + which approved D-1 each must cover. fba-plan is a first-class required report
  // (blocker 3): its EMPTY-inventory snapshot is a valid published identity, proven exactly like the rest.
  const required = [
    { reportKey: "daily-reporting", coversAsOf: S(planAsOf) },
    { reportKey: "brand-sales", coversAsOf: S(planAsOf) },
    { reportKey: "brand-inventory", coversAsOf: S(inventoryAsOf) },
    { reportKey: "fba-plan", coversAsOf: S(inventoryAsOf) },
  ];
  // Manifest index: (account|liveReportKey) -> { paramsHash, coversAsOf, cycleId, operationKey, runToken }.
  const manifest = new Map();
  for (const m of (Array.isArray(publicationRows) ? publicationRows : [])) {
    manifest.set(S(m.account_id) + "|" + S(m.report_key), {
      paramsHash: S(m.params_hash), coversAsOf: S(m.covers_asof).slice(0, 10),
      cycleId: S(m.cycle_id).trim(), operationKey: S(m.operation_key).trim(), runToken: S(m.run_token).trim(),
    });
  }

  // Read the EXACT wave-produced identity and prove PROVENANCE + freshness + payload validity.
  const exactOk = async (reportKey, accountId, requiredCoversAsOf) => {
    const contract = liveContracts[reportKey];
    const entry = reportDerivations[reportKey];
    if (!contract || !entry) return { ok: false, reason: "no-contract" };
    const man = manifest.get(S(accountId) + "|" + contract.liveReportKey);
    if (!man || !man.paramsHash) return { ok: false, reason: "no-manifest-entry" };
    // PROVENANCE (blocker 2): a real durable cycle id (never a bucket label) + the CURRENT attempt's run token.
    if (!man.cycleId) return { ok: false, reason: "no-cycle-provenance" };
    if (/^bootstrap(-fba)?-/.test(man.cycleId)) return { ok: false, reason: "cycle-is-bucket-label" };
    if (wantToken && man.runToken !== wantToken) return { ok: false, reason: "superseded-attempt" };
    // EXACT per-report provenance (blocker 3): compare cycleId + operationKey + runToken against the expected.
    const exp = expProv ? expProv[reportKey] : null;
    if (exp) {
      if (man.cycleId !== S(exp.cycleId).trim()) return { ok: false, reason: "cycle-mismatch" };
      if (man.operationKey !== S(exp.operationKey).trim()) return { ok: false, reason: "operation-mismatch" };
      if (man.runToken !== S(exp.runToken).trim()) return { ok: false, reason: "run-token-mismatch" };
    }
    // The manifest's coversAsOf must itself equal the approved D-1 (a wave that published a stale date is caught).
    if (man.coversAsOf !== S(requiredCoversAsOf)) return { ok: false, reason: "manifest-stale-coversAsOf" };
    let snap;
    try { snap = await readByIdentity({ reportKey: contract.liveReportKey, accountId, paramsHash: man.paramsHash }); } catch (e) { return { ok: false, reason: "read-failed" }; }
    if (!snap) return { ok: false, reason: "no-live-snapshot-at-identity" };
    if (S(snap.report_key) !== contract.liveReportKey || S(snap.account_id) !== S(accountId) || S(snap.params_hash) !== man.paramsHash) return { ok: false, reason: "identity-mismatch" };
    const params = snap.params && typeof snap.params === "object" && !Array.isArray(snap.params) ? snap.params : null;
    if (!params) return { ok: false, reason: "no-params" };
    if (S(params.reportVersion) !== contract.liveReportVersion) return { ok: false, reason: "live-version" };
    if (S(params.to) !== S(requiredCoversAsOf)) return { ok: false, reason: "stale-coversAsOf" };
    if (!S(snap.source_refreshed_at)) return { ok: false, reason: "blank-refresh" };
    let payload;
    const path = S(snap.payload_storage_path);
    if (path) { try { payload = await hydrate(path); } catch { payload = null; } if (payload == null) return { ok: false, reason: "payload-dangling" }; }
    else { payload = snap.payload; if (payload == null) return { ok: false, reason: "payload-unavailable" }; }
    if (typeof entry.validatePayload !== "function" || entry.validatePayload(payload) !== true || (payload && payload.dataUnavailable === true)) return { ok: false, reason: "payload-contract" };
    return { ok: true };
  };

  const problems = [];
  for (const accountId of frozen) {
    for (const req of required) {
      const r = await exactOk(req.reportKey, accountId, req.coversAsOf);
      if (!r.ok) problems.push(`${accountId}:${req.reportKey}(${r.reason})`);
    }
  }
  return { ok: problems.length === 0, problems };
}

// Record ONE attempt's ACTUAL spend after its run. Actuals ACCUMULATE across attempts; cumulative
// actuals above the step ceiling are NEVER silent (the RPC answers 'over-reservation' -- surface loudly).
export async function recordOnboardingActualSpend({ waveKey, ref, actualTokens, actualCreates, record = recordOnboardingSpendActual } = {}) {
  try {
    return await record({ budgetKey: S(waveKey), ref: S(ref), actualTokens: Number(actualTokens) || 0, actualCreates: Number(actualCreates) || 0 });
  } catch {
    return { disposition: "record-failed" };
  }
}
