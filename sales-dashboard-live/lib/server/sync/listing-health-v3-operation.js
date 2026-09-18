// Advanced Listing Health v3 -- DEDICATED INGESTION OPERATOR (Phase 4B1), SAFE-CLOSED.
//
// The ONE trusted v3 ingestion core. It is a SEPARATE dispatch path from the live 13-report control plane: v3 is
// deliberately absent from CONTROLLED_REPORT_KEYS / SCHEDULER_V2_READY_REPORT_KEYS, so runtime.run() (the scheduled/
// manual dispatcher) can never select it. This operator is the only way v3 ingestion runs, and it runs ONLY behind an
// explicit operator authorization AND an independent, default-DISABLED ingestion gate. It is NOT wired to any route,
// GitHub cron, or watchdog in this phase, and it is NOT invoked here -- Phase 4B1 builds + deploys it dark.
//
// Sequence (every step fails closed; last-known-good is always preserved on failure):
//   1  authenticate an explicitly authorized invocation;
//   2  require the independent v3 ingestion gate (default disabled); live mode refuses while it is disabled;
//   3  accept ONLY india | europe-au | us-ca;
//   4  discover fresh authoritative primary accounts (injected);
//   5  resolve region from account metadata (accountInScope by marketplace country -- never browser input / clock);
//   6  build + FREEZE buildShadowReportPlan({ reportKeys: ["listing-health-v3"] }) with the regional cycle's
//      freshnessNotBefore (date-free request_hash; freshness travels as a NON-hash field);
//   7  validate the frozen plan fingerprint + the per-region create ceiling + pricing/reservation support +
//      DataDoe usable balance (minus an emergency reserve) BEFORE any POST -- abort on any drift/unknown/shortfall;
//   8  run source jobs through the existing resumable source worker (listings + listings-raw CREATE within the frozen
//      budget; inventory is REUSE-ONLY -- adopt the current FBA Plan inventory cache, never a v3 create);
//   9  materialize validated batch results into isolated per-account aliases (newer-only overwrite);
//  10  run report jobs -> save ONLY the scheduler-v2/listing-health-v3 shadow snapshot (never a live snapshot), and
//      DEFER the derive if current FBA inventory is unavailable (never publish stale inventory as current);
//  11  return structured per-region evidence.
//
// PURE orchestration over INJECTED collaborators (offline-testable; ZERO DataDoe unless the caller wires + enables a
// live run). Dry-run performs ZERO creates/writes/tokens. Live mode refuses while the gate is disabled.

import { buildShadowReportPlan } from "./report-planner.js";
import { accountInScope, isRoutingScope } from "./scheduler-scope.js";
// ONE pricing definition (all-region scheduler repair Work 2): the estimate MUST price each create by its real
// registry token class -- the SAME sourceTokenCost(registryIsPremiumOf(job)) the frozen tranche budget uses -- so
// the displayed estimate + the first authorization gate + the frozen binding agree. A flat per-export price
// understates a premium listings export (5) as standard (2) and lets the first gate pass deceptively.
import { sourceTokenCost } from "./source-tranche-budget.js";
import { registryIsPremiumOf } from "./source-registry.js";
import {
  listingHealthV3PlannedExports,
  assertListingHealthV3ExportCeiling,
  assertNoDuplicatePerAccountReadIdentities,
} from "./listing-health-v3-materialize.js";
import {
  LISTING_HEALTH_V3_PRICING_REVISION,
  readListingHealthV3Authorization,
  decideListingHealthV3Authorization,
  computeListingHealthV3AuthorizationBinding,
  verifyListingHealthV3ReplayBinding,
} from "./listing-health-v3-authorization.js";

const S = (v) => (v == null ? "" : String(v));
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(S(v));
const safe = (e) => S(e && e.message ? e.message : e).slice(0, 200);
export const V3_INGESTION_REGIONS = Object.freeze(["india", "europe-au", "us-ca"]);
// PER-EXPORT token price is NO LONGER a flat constant: it is the source's real registry token class (standard=2 /
// premium=5) via sourceTokenCost(registryIsPremiumOf(job)) -- the SAME definition the frozen tranche budget uses.
// rowCountBilling=true means every per-source price is an ESTIMATE, never a guaranteed maximum -- the balance gate
// keeps an emergency reserve on top, and the frozen tranche budget's atomic pre-POST reservation is the true ceiling.
export const V3_DEFAULT_EMERGENCY_RESERVE_TOKENS = 50;

/** The durable, replay-stable operation identity for one regional cycle. */
export function listingHealthV3OperationId(region, cycleDate) {
  return `listing-health-v3/${S(region)}/${S(cycleDate)}`;
}

/**
 * Default plan builder: the frozen v3 batched plan for one regional cycle (freshnessNotBefore = the cycle date).
 * `overflowSellers` (default empty) applies the inventory-only single-seller split so a proven-overflow seller's v3
 * inventory read hash matches the FBA single-seller child recovered for it (empty set => byte-identical plan). Listings
 * + Listings-Raw stay batched regardless (the planner splits inventory only).
 */
export function buildListingHealthV3Plan({ accounts, connections, cycleDate, overflowSellers = new Set() }) {
  return buildShadowReportPlan({
    accounts,
    reportKeys: ["listing-health-v3"],
    connections,
    asOfFor: () => cycleDate,
    inventoryAsOf: cycleDate, // attaches freshnessNotBefore = cycleDate to every v3 source (see the planner)
    overflowSellers,
  });
}

/**
 * Freshness-aware pre-POST cost of a frozen v3 plan (ZERO creates). Mirrors planFbaBucketCost: a NEW export
 * (listings / listings-raw) is adoptable -- and therefore free -- only when a cache entry exists whose fetched_at is
 * at/after the source's freshnessNotBefore (the current cycle boundary); a stale entry is NOT adoptable and would be
 * refreshed. Inventory is REUSE-ONLY: it is never counted as a create, and `inventoryAdoptable` reports whether the
 * current FBA Plan inventory cache is fresh (the precondition to derive/publish).
 */
export async function planListingHealthV3IngestionCost({ plan, getSourceExportCache }) {
  if (typeof getSourceExportCache !== "function") throw new Error("planListingHealthV3IngestionCost requires getSourceExportCache (fail closed).");
  const v3Requests = (plan.reportRequests || []).filter((r) => r && r.reportKey === "listing-health-v3");
  const { newExports, reusedExports, newExportHashes, reusedExportHashes } = listingHealthV3PlannedExports(v3Requests);
  const plannedByHash = new Map(v3Requests.flatMap((r) => (r.sources || []).map((s) => [s.requestHash, s])));
  // ONE pricing definition: the real per-source token class (standard=2 / premium=5), identical to the frozen
  // tranche budget. An unregistered source throws (fail closed -> awaiting-budget), never a silent default price.
  const tokenCostOfHash = (h) => sourceTokenCost(registryIsPremiumOf({ sourceKey: plannedByHash.get(h)?.sourceKey ?? plannedByHash.get(h)?.source_key }));
  const adoptable = new Set();
  for (const h of [...newExportHashes, ...reusedExportHashes]) {
    try {
      const entry = await getSourceExportCache(h);
      const since = plannedByHash.get(h)?.freshnessNotBefore;
      if (entry && (!since || Date.parse(entry.fetched_at ?? entry.fetchedAt ?? "") >= Date.parse(since))) adoptable.add(h);
    } catch (_e) { /* treat as not-adoptable (fail toward a refresh, never toward a fabricated success) */ }
  }
  const createHashes = newExportHashes.filter((h) => !adoptable.has(h));
  // PER-ACCOUNT (per reuse-hash) inventory adoptability (optional-inventory contract). The region no longer defers
  // wholesale when ONE account's FBA inventory is not adoptable: the run proceeds, publishes listings/OLI for all
  // accounts, adopts inventory where fresh, and leaves inventory-dependent fields unavailable for the rest.
  const inventoryAdoptableByHash = Object.fromEntries(reusedExportHashes.map((h) => [h, adoptable.has(h)]));
  const inventoryAdoptableCount = reusedExportHashes.filter((h) => adoptable.has(h)).length;
  const anyInventoryAdoptable = inventoryAdoptableCount > 0;
  // Real per-source estimate (sum of each create's registry token class) -- equals the frozen tranche budget for
  // the same create set, so the first authorization gate no longer passes deceptively while the binding gate defers.
  const estimatedTokens = createHashes.reduce((sum, h) => sum + tokenCostOfHash(h), 0);
  return {
    newExports, reusedExports,
    creates: createHashes.length,
    estimatedTokens,
    createHashes, adoptedNewHashes: newExportHashes.filter((h) => adoptable.has(h)),
    inventoryHashes: reusedExportHashes,
    // Back-compat field kept, but it is NO LONGER a region-wide gate: it now reports whether ANY account's inventory
    // is adoptable (the run proceeds regardless; inventory is adopted per account where fresh).
    inventoryAdoptable: anyInventoryAdoptable,
    inventoryAdoptableByHash, inventoryAdoptableCount, anyInventoryAdoptable,
    adoptable,
  };
}

/**
 * Run (or dry-run) the dedicated Listing Health v3 ingestion for ONE region + cycle. INJECTABLE collaborators:
 *   discoverAccounts()                    -> [{ accountId, country, currency, name }]  (authoritative primary directory)
 *   buildPlan({accounts,connections,cycleDate}) -> frozen plan (default buildListingHealthV3Plan)
 *   resolveCost({plan})                   -> the freshness-aware cost object (default binds planListingHealthV3IngestionCost)
 *   checkBalance()                        -> { usable:number, reserve?:number }         (DataDoe usable balance)
 *   runSources({plan,region,cycleDate,operationId,budget}) -> { drained, creates, tokens, ... } (resumable source worker)
 *   materialize({plans,connections})      -> materialization summary                    (per-account aliases)
 *   runReports({plan,region,cycleDate})   -> { succeeded, blocked, failed, drained }    (shadow snapshot derive/save)
 *   finalizeCycle({region,cycleDate})     -> { disposition, status, cycleId }            (guarded finalize_sync_cycle)
 * Config: region, cycleDate, mode ("dry-run"|"live"), authorized (bool), gate ({enabled}), connections,
 *   ceiling (override), emergencyReserveTokens, reservationSupported (store capability), pricingKnown.
 * A LIVE scheduled operation is a SUCCESS (ok:true, phase:"complete") ONLY when the dedicated cycle finalizes to a
 * DURABLE terminal status "succeeded" (zero source/report failures). partial/failed/open-work/deferred all return
 * ok:false so the CLI exits nonzero, while last-known-good is preserved (no snapshot is rolled back).
 */
export async function runListingHealthV3Ingestion({
  region, cycleDate, mode = "dry-run",
  authorized = false, gate = null, connections = [],
  discoverAccounts, buildPlan = buildListingHealthV3Plan, resolveCost, checkBalance,
  runSources, materialize, runReports, finalizeCycle,
  // EXACT AUTHORIZATION BINDING collaborators (live): freezeBudget({plan,region,cycleDate}) computes the frozen NEW-tranche
  // budget (fingerprint + request hashes + ceilings) WITHOUT persisting; readFrozenBudget({region,cycleDate,trancheKey})
  // returns the durable frozen budget already on this region's v3 cycle (or null for a NEW cycle). Both are REQUIRED for
  // a live run: a missing collaborator returns typed awaiting-budget (binding-unavailable) before any paid work.
  freezeBudget = null, readFrozenBudget = null,
  ceiling = null, emergencyReserveTokens = V3_DEFAULT_EMERGENCY_RESERVE_TOKENS,
  // P1-3: EXPLICIT DURABLE AUTHORIZATION -- read from the durable control system (default: the reviewed region
  // config), bound to the region + pricing revision. INJECTABLE so a future migration-backed operator-runtime
  // authorization table can replace it without touching this operation's logic. `readAuthorization` returns a typed
  // decision (never throws for missing/stale/malformed authz -> those become awaiting-budget, not a crash).
  readAuthorization = readListingHealthV3Authorization,
  pricingRevision = LISTING_HEALTH_V3_PRICING_REVISION,
  reservationSupported = true, pricingKnown = true,
  now = () => Date.now(), log = () => {},
} = {}) {
  const dryRun = mode !== "live";
  const ev = { region: S(region), cycleDate: S(cycleDate), mode: dryRun ? "dry-run" : "live", operationId: listingHealthV3OperationId(region, cycleDate), phase: "auth", ok: false, creates: 0, tokens: 0, accounts: 0, newExports: 0, ceiling: null, estimatedTokens: 0, snapshots: 0, problems: [] };
  const fail = (phase, problem) => ({ ...ev, phase, ok: false, problems: [...ev.problems, problem] });
  // Structured observability sink: route SAFE, structured events (an UPPERCASE_SNAKE tag + a JSON body of primitive,
  // non-secret fields) into the operator's EXISTING log sink -- reuse, no new vendor. This is the established operator
  // log convention. Callers that don't inject `log` get the no-op default. It NEVER throws and NEVER carries a
  // credential/token/cookie, a raw seller id, the org fingerprint, a signed URL, row content, or PII.
  const emit = (tag, obj) => { try { log(S(tag) + " " + JSON.stringify(obj)); } catch (_e) { /* observability must never affect the operation */ } };

  // 1) explicit operator authorization.
  if (authorized !== true) return fail("auth", "operator invocation is not explicitly authorized (fail closed)");
  // 2) independent ingestion gate (default DISABLED). Live refuses while disabled; dry-run may proceed to prove cost.
  const gateEnabled = !!(gate && gate.enabled === true);
  ev.gateEnabled = gateEnabled;
  if (!dryRun && !gateEnabled) return fail("gate", "live mode refused: the listing-health-v3 ingestion gate is disabled (default)");
  // 3) region allowlist (routing scope).
  if (!V3_INGESTION_REGIONS.includes(S(region)) || !isRoutingScope(S(region))) return fail("region", `unsupported region "${region}" (only india | europe-au | us-ca)`);
  if (!isDate(cycleDate)) return fail("cycle", `cycleDate must be a real calendar date (got "${cycleDate}")`);
  if (typeof discoverAccounts !== "function") return fail("discover", "discoverAccounts collaborator is required (fail closed)");

  // 4) discover authoritative primary accounts.
  let accounts;
  try { accounts = await discoverAccounts(); } catch (e) { return fail("discover", "account discovery failed: " + safe(e)); }
  accounts = Array.isArray(accounts) ? accounts : [];
  // 5) resolve region from account metadata (marketplace country). Drop connection-prefixed / missing-country ids.
  const regionAccounts = accounts.filter((a) => a && a.accountId && !String(a.accountId).includes(":") && S(a.country).trim() && accountInScope(S(region), a.country));
  ev.accounts = regionAccounts.length;
  if (!regionAccounts.length) return { ...ev, phase: "complete", ok: true, note: "no-accounts-in-region", creates: 0, tokens: 0 };

  // 6) build + FREEZE the plan. `region` is forwarded so a composition-provided buildPlan can derive the inventory-only
  //    overflow split from that region's FBA cycle evidence; buildPlan may be sync or async, so it is awaited.
  let plan;
  try { plan = await buildPlan({ accounts: regionAccounts, connections, cycleDate, region: S(region) }); } catch (e) { return fail("plan", "plan build failed: " + safe(e)); }
  const v3Requests = (plan.reportRequests || []).filter((r) => r && r.reportKey === "listing-health-v3");
  if (!v3Requests.length) return fail("plan", "frozen plan contains no listing-health-v3 requests (fail closed)");

  // 6b) FUTURE ACCOUNT-IDENTITY GUARD (pure; dry-run + live): refuse BEFORE any create if two distinct accounts would
  //     resolve to one marketplace-independent per-account read hash (a shared seller id across marketplaces would
  //     cross-contaminate aliases). Diagnostics name only safe public account-id prefixes.
  try { assertNoDuplicatePerAccountReadIdentities({ v3Requests, connections }); }
  catch (e) { return fail("identity", safe(e)); }

  // 7) validate ceiling + cost + pricing/reservation + balance BEFORE any POST.
  let ceilingCheck;
  let authorizationBinding = null; // set by the live binding gate; handed to runSources
  // The ceiling is COMPUTED from the frozen plan's eligible account membership (2 creates per <=5-seller batch), so
  // account growth scales the ceiling instead of hard-failing against a fixed 4/8/4 literal (an explicit `ceiling`
  // still overrides for a reviewed test). A plan fanning out more creates than the membership justifies is drift.
  try { ceilingCheck = assertListingHealthV3ExportCeiling({ region: S(region), plans: v3Requests, accountCount: regionAccounts.length, ceiling }); }
  catch (e) { return fail("ceiling", "export-ceiling gate failed (fail closed): " + safe(e)); }
  ev.newExports = ceilingCheck.newExports;
  ev.ceiling = ceilingCheck.ceiling;
  if (typeof resolveCost !== "function") return fail("budget", "resolveCost collaborator is required (fail closed)");
  let cost;
  try { cost = await resolveCost({ plan }); } catch (e) { return fail("budget", "cost resolution failed (fail closed): " + safe(e)); }
  ev.creates = Number(cost.creates || 0);
  ev.estimatedTokens = Number(cost.estimatedTokens || 0);
  // The ceiling bounds the number of CREATES structurally (not tokens); re-assert against the freshness-aware count.
  if (Number(cost.creates || 0) > Number(ceilingCheck.ceiling)) {
    return fail("ceiling", `freshness-aware create count ${cost.creates} exceeds the region ceiling ${ceilingCheck.ceiling}; refusing (fail closed)`);
  }
  ev.inventoryAdoptable = !!cost.anyInventoryAdoptable;
  ev.inventoryAdoptableCount = Number(cost.inventoryAdoptableCount || 0);

  // OPTIONAL-INVENTORY CONTRACT (per-account partial publication): the run PROCEEDS regardless of inventory
  // adoptability. Listings + durable OLI publish for every eligible account; FBA inventory is adopted PER ACCOUNT
  // where its reuse-only cache is fresh, and inventory-dependent fields resolve unavailable for the rest (the derive
  // yields inventory.available:false, never a fabricated zero). The region-wide "defer the whole region when ANY
  // account's inventory is not adoptable" gate is REMOVED: it blocked every account on one account's FBA gap. The
  // paid-create budget/ceiling/identity/authorization/balance gates below are UNCHANGED (they gate listings/
  // listings-raw creates only), and inventory stays REUSE-ONLY (the inventoryCreated hard-guard still fails closed).
  if (!dryRun) {
    if (pricingKnown !== true) return fail("budget", "DataDoe pricing state is unknown; refusing to create (fail closed)");
    if (reservationSupported !== true) return fail("budget", "atomic pre-POST create reservation is unavailable; refusing to create (fail closed)");
    // The three spend concepts are enforced as THREE SEPARATE gates, in order:
    //   (1) STRUCTURAL required  -- 2 creates per <=5-seller batch (ceilingCheck.newExports); tokens = the
    //       freshness-aware estimate. This is what the run NEEDS and scales with account growth.
    const requiredCreates = Number(ceilingCheck.newExports || 0);
    const requiredTokens = Number(cost.estimatedTokens || 0);
    ev.requiredCreates = requiredCreates; ev.requiredTokens = requiredTokens;

    //   (2) EXPLICIT DURABLE AUTHORIZATION -- what an operator has reviewed and authorized for the region (bound to
    //       the pricing revision), read from the durable control system. NOT derived from the token balance and it
    //       does NOT auto-increase when accounts are added: growth beyond the authorized ceiling defers here. A
    //       missing / stale (pricing) / malformed / below-required authorization returns a TYPED awaiting-budget
    //       BEFORE any cycle/reservation/POST (zero creates, LKG preserved) -- an operator must review/raise it.
    if (typeof readAuthorization !== "function") return fail("authorization", "readAuthorization collaborator is required for a live run (fail closed)");
    let authz;
    try { authz = await readAuthorization({ region: S(region), pricingRevision: S(pricingRevision) }); }
    catch (e) { authz = { authorized: false, reason: "authorization-unreadable", detail: safe(e) }; }
    const authDecision = decideListingHealthV3Authorization({ region: S(region), accountCount: regionAccounts.length, requiredCreates, requiredTokens, authorization: authz, pricingRevision: S(pricingRevision) });
    ev.authorization = authDecision.authorization && authDecision.authorization.authorized
      ? { maxAccounts: authDecision.authorization.maxAccounts, maxCreates: authDecision.authorization.maxCreates, maxTokens: authDecision.authorization.maxTokens, pricingRevision: authDecision.authorization.pricingRevision }
      : null;
    ev.authorizedCreates = authDecision.authorization && authDecision.authorization.authorized ? authDecision.authorization.maxCreates : null;
    ev.authorizedTokens = authDecision.authorization && authDecision.authorization.authorized ? authDecision.authorization.maxTokens : null;
    if (!authDecision.ok) {
      return {
        ...ev, phase: "awaiting-budget", ok: false, deferred: true, awaitingBudget: true,
        authorizationReason: authDecision.reason, creates: 0, tokens: 0, snapshots: 0,
        note: `NOT authorized (${authDecision.reason}${authDecision.detail ? ": " + authDecision.detail : ""}) for ${S(region)} -- deferred BEFORE any cycle/reservation/POST (zero creates); last-known-good preserved. An operator must review/raise the durable Listing Health v3 authorization (this is SEPARATE from funding the token balance).`,
      };
    }

    //   (2b) EXACT BINDING -- the standing regional authorization is bound to THIS run's actual frozen work: region +
    //        cycleDate + operationId + tranche + sorted membership + sorted frozen request hashes + frozen plan fingerprint
    //        + pricing revision + frozen ceilings. A standing policy authorizes a NEW frozen cycle within its limits (no
    //        daily manual approval); on REPLAY (a frozen budget already persisted on this region's v3 cycle) every bound
    //        element must match EXACTLY, else typed awaiting-budget BEFORE any cycle/reservation/POST. The binding is
    //        handed to runSources, which refuses to persist/POST anything that differs from it (fail closed).
    const trancheKey = `lhv3-new#${S(region)}`;
    const awaitingBinding = (reason, detail) => ({
      ...ev, phase: "awaiting-budget", ok: false, deferred: true, awaitingBudget: true,
      authorizationReason: reason, creates: 0, tokens: 0, snapshots: 0,
      note: `authorization NOT bound (${reason}${detail ? ": " + detail : ""}) for ${S(region)} -- deferred BEFORE any cycle/reservation/POST (zero creates); last-known-good preserved.`,
    });
    if (typeof freezeBudget !== "function") return awaitingBinding("binding-unavailable", "freezeBudget collaborator is required for a live run");
    if (typeof readFrozenBudget !== "function") return awaitingBinding("binding-unavailable", "readFrozenBudget collaborator is required for a live run");
    let frozen = null;
    try { frozen = await freezeBudget({ plan, region: S(region), cycleDate: S(cycleDate) }); } catch (e) { return awaitingBinding("binding-unavailable", safe(e)); }
    const bound = computeListingHealthV3AuthorizationBinding({
      region: S(region), cycleDate: S(cycleDate), operationId: ev.operationId, trancheKey,
      accountIds: regionAccounts.map((a) => a.accountId), frozen, pricingRevision: S(pricingRevision), authorization: authDecision.authorization,
    });
    if (!bound.ok) return awaitingBinding(bound.reason, bound.detail);
    let persisted = null;
    try { persisted = await readFrozenBudget({ region: S(region), cycleDate: S(cycleDate), trancheKey }); } catch (e) { return awaitingBinding("frozen-budget-unreadable", safe(e)); }
    const replay = verifyListingHealthV3ReplayBinding({ binding: bound.binding, persisted });
    if (!replay.ok) return awaitingBinding(replay.reason, replay.detail);
    authorizationBinding = bound.binding;
    ev.authorizationBinding = {
      bindingHash: bound.binding.bindingHash, membershipHash: bound.binding.membershipHash, requestHashesHash: bound.binding.requestHashesHash,
      planFingerprint: bound.binding.planFingerprint, trancheKey, maxCreates: bound.binding.maxCreates,
      estimatedTokens: bound.binding.estimatedTokens, pricingRevision: S(pricingRevision), replay: replay.replay,
    };
    //   (3) LIVE AFFORDABILITY -- even WITH authorization, the usable DataDoe balance minus the emergency reserve
    //       must cover the required tokens. Authorization does NOT imply affordability. estimatedTokens is an
    //       OBSERVED estimate (rowCountBilling=true), so requiring headroom above the reserve also stops a
    //       heavier-than-expected bill from exhausting the account. The atomic pre-POST reservation + frozen tranche
    //       budget remain the true runtime ceiling on top of this.
    if (typeof checkBalance !== "function") return fail("balance", "checkBalance collaborator is required for a live run (fail closed)");
    let bal;
    try { bal = await checkBalance(); } catch (e) { return fail("balance", "balance check failed (fail closed): " + safe(e)); }
    if (!bal || typeof bal.usable !== "number" || !Number.isFinite(bal.usable)) return fail("balance", "usable DataDoe balance is unknown (fail closed)");
    const reserve = typeof bal.reserve === "number" ? bal.reserve : Number(emergencyReserveTokens);
    ev.usableBalance = bal.usable; ev.emergencyReserve = reserve;
    const affordableTokens = bal.usable - reserve;
    ev.affordableTokens = affordableTokens;
    if (requiredTokens > affordableTokens) {
      return {
        ...ev, phase: "awaiting-budget", ok: false, deferred: true, awaitingBudget: true,
        authorizationReason: "insufficient-balance", creates: 0, tokens: 0, snapshots: 0,
        note: `required ${requiredCreates} create(s) / ${requiredTokens} token(s) exceed the usable DataDoe balance minus the emergency reserve (usable ${bal.usable} - reserve ${reserve} = ${affordableTokens}); deferred BEFORE any cycle/reservation/POST (zero creates); last-known-good preserved. Fund to proceed (authorization is already in place).`,
      };
    }
  }

  // DRY-RUN stops here -- ZERO creates, writes, and tokens.
  if (dryRun) {
    return { ...ev, phase: "planned", ok: true, dryRun: true, creates: 0, tokens: 0, plannedCreates: Number(cost.creates || 0), estimatedTokens: Number(cost.estimatedTokens || 0), inventoryAdoptable: !!cost.anyInventoryAdoptable, anyInventoryAdoptable: !!cost.anyInventoryAdoptable, inventoryAdoptableCount: Number(cost.inventoryAdoptableCount || 0), inventoryAdoptableByHash: cost.inventoryAdoptableByHash || {}, note: gateEnabled ? "gate-enabled" : "gate-disabled (dry-run only)" };
  }

  // A live run also REQUIRES the finalize collaborator (the durable success gate). Refuse before any create if missing.
  if (typeof finalizeCycle !== "function") return fail("finalize", "finalizeCycle collaborator is required for a live run (fail closed)");

  // 8) run source jobs (listings + listings-raw CREATE within the frozen budget; inventory REUSE-ONLY). LKG preserved.
  let sourceRes;
  try { sourceRes = await runSources({ plan, region: S(region), cycleDate: S(cycleDate), operationId: ev.operationId, budget: cost, authorizationBinding }); }
  catch (e) { return fail("source", "source run failed (last-known-good preserved): " + safe(e)); }
  ev.creates = Number(sourceRes && sourceRes.creates || 0);
  ev.tokens = Number(sourceRes && sourceRes.tokens || 0);
  ev.drained = !!(sourceRes && sourceRes.drained);
  ev.inventoryCreated = !!(sourceRes && sourceRes.inventoryCreated);
  // CONTRACT: inventory is REUSE-ONLY. A v3 inventory CREATE is a hard violation of the zero-inventory-export contract
  // (finalize counts inventory jobs as "succeeded" and would not distinguish create from reuse -- only this catches it).
  if (ev.inventoryCreated) return fail("source", "inventory export was CREATED but v3 inventory must be reuse-only; fail closed (last-known-good preserved)");

  // 9) materialize validated batch results into isolated per-account aliases (newer-only overwrite). Per-fragment
  //    structured events flow to `emit` (the operator log sink), correlated by this run's operationId.
  let matSummary = null;
  try { matSummary = await materialize({ plans: v3Requests, connections, emit, runId: ev.operationId }); }
  catch (e) { return fail("materialize", "per-account materialization failed (last-known-good preserved): " + safe(e)); }
  ev.aliases = matSummary;
  // RUN SUMMARY (materialization observability): per-account discovery/eligibility/exclusion, the planned new-vs-reused
  // export split, the region create-ceiling, and the aggregate per-result materialization + durable counts. SAFE
  // metadata only (counts / dates / region / ceiling) -- emitted here so it is recorded even if the rejected-fragment
  // guard below then fails the run closed.
  emit("LHV3_RUN_SUMMARY", {
    runId: ev.operationId, region: ev.region, cycleDate: ev.cycleDate, mode: ev.mode,
    accountsDiscovered: accounts.length,
    accountsEligible: regionAccounts.length,
    accountsExcludedPreplan: accounts.length - regionAccounts.length,
    accountsMaterialized: Number((matSummary && matSummary.accounts) || 0),
    accountsSkippedAtMaterialize: Number((matSummary && matSummary.skippedAccounts) || 0),
    newExportsPlanned: Number((cost && cost.newExports) || 0),
    newExportsCreated: Number(ev.creates || 0),
    reusedExports: Number((cost && cost.reusedExports) || 0),
    inventoryCreated: !!ev.inventoryCreated,
    tokens: Number(ev.tokens || 0),
    ceiling: ev.ceiling == null ? null : Number(ev.ceiling),
    // Reaching materialize means the frozen create-ceiling gate already PASSED (a breach defers the whole run before
    // any create); no account/export was excluded by the ceiling on this path.
    ceilingExclusions: 0,
    fragments: {
      materialized: Number(((matSummary && matSummary.aliasesWritten) || 0)) + Number(((matSummary && matSummary.emptyAliases) || 0)),
      emptyAliases: Number((matSummary && matSummary.emptyAliases) || 0),
      reusedOrStale: Number((matSummary && matSummary.skippedStale) || 0),
      missing: Number((matSummary && matSummary.batchMissing) || 0),
      rejected: Number((matSummary && matSummary.rejected) || 0),
    },
    durable: {
      written: Number((matSummary && matSummary.durableWritten) || 0),
      unchanged: Number((matSummary && matSummary.durableUnchanged) || 0),
      stale: Number((matSummary && matSummary.durableStale) || 0),
      skippedEvidence: Number((matSummary && matSummary.durableSkippedEvidence) || 0),
      schemaMissing: Number((matSummary && matSummary.durableSchemaMissing) || 0),
      writeFailed: Number((matSummary && matSummary.durableWriteFailed) || 0),
    },
  });
  // A REJECTED (unattributable / cross-account) fragment is never reflected in the cycle job counters, so guard it here.
  const matRejected = Number((matSummary && matSummary.rejected) || 0);
  if (matRejected > 0) return fail("materialize", `materialization rejected ${matRejected} unattributable fragment(s); fail closed (last-known-good preserved)`);

  // 10) OPTIONAL-INVENTORY: under partial inventory, a non-adoptable account is an EXPECTED state (its inventory
  //     fields resolve unavailable in the derive), NOT a regression -- so there is no region-wide adoptability
  //     invariant here. The zero-inventory-export contract is still enforced by the inventoryCreated hard-guard
  //     above (a v3 inventory CREATE fails closed); inventory remains strictly reuse-only.

  // 11) run report jobs -> the scheduler-v2/listing-health-v3 SHADOW snapshot only. LKG preserved on any failure.
  let reportRes;
  try { reportRes = await runReports({ plan, region: S(region), cycleDate: S(cycleDate) }); }
  catch (e) { return fail("report", "shadow snapshot derive/save failed (last-known-good preserved): " + safe(e)); }
  ev.snapshots = Number(reportRes && reportRes.succeeded || 0);
  ev.reportBlocked = Number(reportRes && reportRes.blocked || 0);
  ev.reportFailed = Number(reportRes && reportRes.failed || 0);
  ev.reportDrained = !!(reportRes && reportRes.drained);

  // 12) HONEST COMPLETION. Never return ok:true merely because runReports returned. Finalize the dedicated cycle and
  //     use the DURABLE terminal status as the replay-safe source of truth: a LIVE scheduled operation SUCCEEDS only
  //     when finalize_sync_cycle yields status "succeeded" (zero source AND report failures). open-work (undrained),
  //     partial, failed, not-found and invalid-status are all ok:false; LKG is preserved (no snapshot is rolled back).
  //     An already-terminal "succeeded" cycle (a watchdog replay) returns disposition 'already-terminal' + succeeded
  //     -> a zero-create idempotent success.
  let fin;
  try { fin = await finalizeCycle({ region: S(region), cycleDate: S(cycleDate) }); }
  catch (e) { return fail("finalize", "cycle finalization failed (last-known-good preserved): " + safe(e)); }
  ev.finalizeDisposition = fin && fin.disposition;
  ev.cycleStatus = fin && fin.status;
  const finalized = !!fin && (fin.disposition === "finalized" || fin.disposition === "already-terminal");
  if (finalized && fin.status === "succeeded") {
    return { ...ev, phase: "complete", ok: true, dryRun: false, cycleStatus: "succeeded" };
  }
  if (fin && fin.disposition === "open-work") {
    return { ...ev, phase: "incomplete", ok: false, note: "source/report work still open (cycle not drained) -- a retry will resume; last-known-good preserved" };
  }
  // partial | failed | not-found | invalid-status | finalized-but-not-succeeded -> honest non-success.
  return {
    ...ev, ok: false,
    phase: finalized ? S(fin.status) : (fin && fin.disposition ? S(fin.disposition) : "finalize-failed"),
    note: `cycle did not finalize as succeeded (disposition=${fin && fin.disposition}, status=${fin && fin.status}; reportBlocked=${ev.reportBlocked} reportFailed=${ev.reportFailed} reportDrained=${ev.reportDrained}); last-known-good preserved`,
  };
}
