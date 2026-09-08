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
import {
  listingHealthV3PlannedExports,
  assertListingHealthV3ExportCeiling,
  assertNoDuplicatePerAccountReadIdentities,
} from "./listing-health-v3-materialize.js";
import {
  LISTING_HEALTH_V3_PRICING_REVISION,
  readListingHealthV3Authorization,
  decideListingHealthV3Authorization,
} from "./listing-health-v3-authorization.js";

const S = (v) => (v == null ? "" : String(v));
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(S(v));
const safe = (e) => S(e && e.message ? e.message : e).slice(0, 200);
export const V3_INGESTION_REGIONS = Object.freeze(["india", "europe-au", "us-ca"]);
// OBSERVED per-export token price (standard export). rowCountBilling=true means this is an ESTIMATE, never a
// guaranteed maximum -- the balance gate keeps an emergency reserve on top, and the frozen tranche budget's atomic
// pre-POST reservation is the true ceiling at execution time.
export const V3_OBSERVED_TOKENS_PER_EXPORT = 2;
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
export async function planListingHealthV3IngestionCost({ plan, getSourceExportCache, tokenPerExport = V3_OBSERVED_TOKENS_PER_EXPORT }) {
  if (typeof getSourceExportCache !== "function") throw new Error("planListingHealthV3IngestionCost requires getSourceExportCache (fail closed).");
  const v3Requests = (plan.reportRequests || []).filter((r) => r && r.reportKey === "listing-health-v3");
  const { newExports, reusedExports, newExportHashes, reusedExportHashes } = listingHealthV3PlannedExports(v3Requests);
  const plannedByHash = new Map(v3Requests.flatMap((r) => (r.sources || []).map((s) => [s.requestHash, s])));
  const adoptable = new Set();
  for (const h of [...newExportHashes, ...reusedExportHashes]) {
    try {
      const entry = await getSourceExportCache(h);
      const since = plannedByHash.get(h)?.freshnessNotBefore;
      if (entry && (!since || Date.parse(entry.fetched_at ?? entry.fetchedAt ?? "") >= Date.parse(since))) adoptable.add(h);
    } catch (_e) { /* treat as not-adoptable (fail toward a refresh, never toward a fabricated success) */ }
  }
  const createHashes = newExportHashes.filter((h) => !adoptable.has(h));
  const inventoryAdoptable = reusedExportHashes.length > 0 && reusedExportHashes.every((h) => adoptable.has(h));
  return {
    newExports, reusedExports,
    creates: createHashes.length,
    estimatedTokens: createHashes.length * Number(tokenPerExport),
    tokenPerExport: Number(tokenPerExport),
    createHashes, adoptedNewHashes: newExportHashes.filter((h) => adoptable.has(h)),
    inventoryHashes: reusedExportHashes, inventoryAdoptable,
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
  ev.inventoryAdoptable = !!cost.inventoryAdoptable;

  // P1 ORDERING GATE (LIVE only): DEFER on non-adoptable FBA Plan inventory IMMEDIATELY after cost/ceiling validation
  // and BEFORE the balance check, runSources, openCycle/persistBudget, any export reservation/POST, materialize,
  // reports, or finalize. This GUARANTEES no paid Listings/Listings-Raw export -- and NO v3 cycle -- is ever opened
  // when the required inventory is unavailable (the FBA job can report success while one regional account lacks
  // adoptable inventory). Returns a typed deferred-inventory result with creates=0, tokens=0, snapshots=0; LKG stands.
  // Dry-run is unaffected: it falls through to the planned return below, which reports inventoryAdoptable + cost.
  if (!dryRun && !cost.inventoryAdoptable) {
    return {
      ...ev, phase: "deferred-inventory", ok: false, deferred: true, dryRun: false,
      creates: 0, tokens: 0, snapshots: 0, inventoryAdoptable: false,
      note: "current FBA Plan inventory unavailable -- deferred BEFORE any cycle/create (no v3 cycle opened, zero creates/tokens); last-known-good preserved",
    };
  }
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
    const authDecision = decideListingHealthV3Authorization({ region: S(region), accountCount: regionAccounts.length, requiredCreates, requiredTokens, authorization: authz });
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
    return { ...ev, phase: "planned", ok: true, dryRun: true, creates: 0, tokens: 0, plannedCreates: Number(cost.creates || 0), estimatedTokens: Number(cost.estimatedTokens || 0), inventoryAdoptable: !!cost.inventoryAdoptable, note: gateEnabled ? "gate-enabled" : "gate-disabled (dry-run only)" };
  }

  // A live run also REQUIRES the finalize collaborator (the durable success gate). Refuse before any create if missing.
  if (typeof finalizeCycle !== "function") return fail("finalize", "finalizeCycle collaborator is required for a live run (fail closed)");

  // 8) run source jobs (listings + listings-raw CREATE within the frozen budget; inventory REUSE-ONLY). LKG preserved.
  let sourceRes;
  try { sourceRes = await runSources({ plan, region: S(region), cycleDate: S(cycleDate), operationId: ev.operationId, budget: cost }); }
  catch (e) { return fail("source", "source run failed (last-known-good preserved): " + safe(e)); }
  ev.creates = Number(sourceRes && sourceRes.creates || 0);
  ev.tokens = Number(sourceRes && sourceRes.tokens || 0);
  ev.drained = !!(sourceRes && sourceRes.drained);
  ev.inventoryCreated = !!(sourceRes && sourceRes.inventoryCreated);
  // CONTRACT: inventory is REUSE-ONLY. A v3 inventory CREATE is a hard violation of the zero-inventory-export contract
  // (finalize counts inventory jobs as "succeeded" and would not distinguish create from reuse -- only this catches it).
  if (ev.inventoryCreated) return fail("source", "inventory export was CREATED but v3 inventory must be reuse-only; fail closed (last-known-good preserved)");

  // 9) materialize validated batch results into isolated per-account aliases (newer-only overwrite).
  let matSummary = null;
  try { matSummary = await materialize({ plans: v3Requests, connections }); }
  catch (e) { return fail("materialize", "per-account materialization failed (last-known-good preserved): " + safe(e)); }
  ev.aliases = matSummary;
  // A REJECTED (unattributable / cross-account) fragment is never reflected in the cycle job counters, so guard it here.
  const matRejected = Number((matSummary && matSummary.rejected) || 0);
  if (matRejected > 0) return fail("materialize", `materialization rejected ${matRejected} unattributable fragment(s); fail closed (last-known-good preserved)`);

  // 10) INVARIANT (defense in depth): a LIVE run proved inventory adoptability at the pre-create gate ABOVE, before any
  //     cycle/create. Reaching here with non-adoptable inventory would mean paid work happened before readiness -- the
  //     exact P1 this ordering fix removes. It is unreachable in the normal flow; assert it can never permit a stale
  //     derive (guards against a future re-ordering re-introducing the defect).
  if (!cost.inventoryAdoptable) return fail("invariant", "inventory adoptability regressed after the pre-create gate; refusing to derive on stale inventory (fail closed; should be unreachable)");

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
