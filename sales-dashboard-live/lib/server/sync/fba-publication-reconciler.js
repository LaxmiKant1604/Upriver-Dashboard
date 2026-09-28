// FBA-inventory publication RECONCILER -- the FBA FAMILY WRAPPER over the shared saved-data reconciler core
// (saved-data-reconciler.js). It re-derives + promotes the FBA-dependent canonical live dashboard(s) for accounts
// whose durable FBA inventory advanced past (or was never promoted to) their live snapshots, using ALREADY-SAVED
// durable FBA inventory (public.source_snapshots). ZERO provider export.
//
// The reconciliation ENGINE (scope iteration, exact publication binding, typed classification, control lifecycle,
// deadline/abort/confirmed-settlement, honest outcome, per-account isolation, zero-export) is the SHARED core. This
// wrapper supplies ONLY the FBA-specific ADAPTER: a per-account durable FBA snapshot read (per-account ISOLATED -- a
// single account's unreadable/absent snapshot defers ONLY that account, never the healthy ones) + the deterministic
// FBA revision (fba-inventory-revision.js). No post-promotion hook: brand-inventory is not the Brand View membership
// source (that is brand-sales, the OLI reconciler's concern).
//
// DEPENDENCY-SAFE: imports ONLY node:crypto (the fair-order tie hash) + the FBA leaf registry + the FBA revision module +
// the shared reconciler core. It has NO
// import path to a provider export transport or a token reservation; the production entrypoint forces the release's
// inner adapter to refuse creates (zero export, structurally). 7-bit ASCII, LF.

import { createHash } from "node:crypto";
import { fbaDependentLiveReportKeys } from "./fba-dependent-reports.js";
import { computeFbaAccountRevision, FBA_REVISION_STATUS } from "./fba-inventory-revision.js";
import { buildSavedDataReconciler, RECONCILE_STATUS } from "./saved-data-reconciler.js";

export const FBA_RECONCILE_STATUS = RECONCILE_STATUS;

const S = (v) => (v == null ? "" : String(v));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---- FAIR EXECUTION ORDER (publication recovery D3) -----------------------------------------------------------------
// Every run executes the stale accounts in ONE order and its deadline defers the TAIL of that order
// ('deadline-cleanup-reserved', LKG kept). The shared core's sorted order made the tail the SAME accounts every day: the
// scheduler's immediate reconcile (deadline 300 s) always reached the first 8 europe-au ids and the 20:48 backstop the
// middle ones, so the last 5 FBA-active accounts were refreshed ONLY by the (WP13-retired, unfenced) brand-inventory
// rebuild. fbaFairOrder ranks the stale accounts by
//   1. the durable revision status: 'available' (real stock rows to publish) before 'proven-empty' (a valid empty D-1
//      snapshot -> an honest UNAVAILABLE placeholder) before anything else;
//   2. ONLY among 'available' accounts: the brand-inventory date the dashboard SERVES today, OLDEST first (null = never
//      served / unavailable / unread = the most starved). Publishing a stocked account advances its served date, so the
//      next run starts with whoever the last one left behind: no STOCKED account waits more than ceil(stale / per-run
//      capacity) runs. (A proven-empty account's served date never advances -- its publish is a placeholder the serve
//      never prefers over an older available compact -- so that group is ordered by the per-day tie alone.)
//   3. a per-day hash of (requestedAsOf, account): deterministic within a day (the evening backstop continues exactly
//      where the morning run stopped) and reshuffled across days (no fixed tail among equals).
// A hung account cannot monopolize the order it leads: the FBA CLI gives every account its own time budget
// (fba-publication-reconcile.mjs ACCOUNT_DEADLINE_SECONDS -> the core's per-account deadline, 'deadline-account-in-flight').
// It only ORDERS: which accounts are stale, what is derived, and what the fenced CAS publishes are unchanged.
export const FBA_FAIR_STATUS_RANK = Object.freeze({ [FBA_REVISION_STATUS.AVAILABLE]: 0, [FBA_REVISION_STATUS.PROVEN_EMPTY]: 1 });
const fairTie = (requestedAsOf, accountId) => createHash("sha256").update("fba-fair-order/v1\u0000" + S(requestedAsOf) + "\u0000" + S(accountId)).digest("hex");
// The served-date reads are ordering-only: a per-read cap and a total budget keep them from delaying the run (an unread
// account is 'most starved', null).
export const FBA_FAIR_READ_CAP_MS = 10000;
export const FBA_FAIR_READ_BUDGET_MS = 60000;
// A read capped at `ms`: resolves null when the cap wins (the read itself is not aborted -- it is read-only and only
// feeds the order). The cap timer is cleared as soon as the read settles; it is deliberately NOT unref'd -- a hung read
// with nothing else pending must still be resolved by the cap, never end the process on an unsettled await.
const capRead = (p, ms) => {
  let t = null;
  const cap = new Promise((resolve) => { t = setTimeout(() => resolve(null), ms); });
  return Promise.race([Promise.resolve(p).finally(() => clearTimeout(t)), cap]).finally(() => clearTimeout(t));
};

/**
 * PURE: the fair execution order of `staleAccounts`. statusOf: Map<accountId, revision status>; servedAsOf:
 * Map<accountId, 'YYYY-MM-DD' | null> (the served brand-inventory date; absent / malformed = null = most starved;
 * consulted for 'available' accounts only).
 */
export function fbaFairOrder({ staleAccounts = [], statusOf = new Map(), servedAsOf = new Map(), requestedAsOf = "" } = {}) {
  const rankOf = (a) => { const st = S(statusOf.get(a)); return Object.prototype.hasOwnProperty.call(FBA_FAIR_STATUS_RANK, st) ? FBA_FAIR_STATUS_RANK[st] : 2; };
  const servedOf = (a) => { if (rankOf(a) !== 0) return ""; const d = S(servedAsOf.get(a)); return DATE_RE.test(d) ? d : ""; };
  return [...new Set((Array.isArray(staleAccounts) ? staleAccounts : []).map(S))].map((a) => ({ a, rank: rankOf(a), served: servedOf(a), tie: fairTie(requestedAsOf, a) }))
    .sort((x, y) => (x.rank - y.rank) || (x.served < y.served ? -1 : x.served > y.served ? 1 : 0) || (x.tie < y.tie ? -1 : x.tie > y.tie ? 1 : 0))
    .map((x) => x.a);
}

/**
 * Build the FBA-inventory publication reconciler. FBA-specific collaborators:
 *   readFbaSnapshot({ organizationFingerprint, connectionId, accountId }) -> { read, snapshot }
 *       -- the durable source_snapshots row for (account, fba-inventory-health). read!='ok' or a throw is a PER-ACCOUNT
 *          defer (that account keeps its LKG); it NEVER fails the whole run (per-account isolation).
 *   resolveExpectedRequestHash({ accountId, requestedAsOf }) -> "<request hash>" | ""
 *       -- the recomputed resolvedFbaSnapshot({asOf:requestedAsOf}).requestHash for EXACTLY the D-1 single-day export
 *          (proves the durable snapshot IS the requested-D-1 snapshot). "" => cannot prove D-1 for this account (defer).
 *   readServedInventoryDate({ accountId }) -> 'YYYY-MM-DD' | null   (OPTIONAL, read-only)
 *       -- the inventory date the dashboard serves for the account today (the serve's own selection); feeds ONLY the
 *          fair execution order (fbaFairOrder). A throw / malformed value is null (most starved); absent -> the order
 *          uses the revision status + the per-day tie only.
 * Every other collaborator is passed straight through to the shared core.
 */
export function buildFbaPublicationReconciler({
  resolveOrg, bucketAccounts,
  readFbaSnapshot, resolveExpectedRequestHash, readServedInventoryDate = null,
  readLatestReportJob, readShadowSnapshot, readLiveSnapshot, loadStoragePayload, verifyLiveReadback,
  liveContracts, computeHash, reportDerivations, shadowKeyFor = (rk) => "scheduler-v2/" + rk,
  runReleaseForAccount,
  openControls = async () => ({ ok: true }), closeControls = async () => ({ ok: true }),
  outOfTime = () => false, deadlineRace = (p) => p,
  makeAbortController = () => new AbortController(),
  awaitSettled = async (p) => { try { await p; } catch { /* a rejection is a settlement -- the op stopped */ } return { settled: true }; },
  reportKeys = fbaDependentLiveReportKeys(),
  withTimeout = (p) => p, clock = () => new Date(), log = () => {},
  readCapMs = FBA_FAIR_READ_CAP_MS, readBudgetMs = FBA_FAIR_READ_BUDGET_MS,
} = {}) {
  for (const [name, fn] of [["readFbaSnapshot", readFbaSnapshot], ["resolveExpectedRequestHash", resolveExpectedRequestHash]]) {
    if (typeof fn !== "function") throw new Error(`buildFbaPublicationReconciler requires ${name} (fail closed).`);
  }
  if (readServedInventoryDate != null && typeof readServedInventoryDate !== "function") throw new Error("buildFbaPublicationReconciler readServedInventoryDate must be a function when provided (fail closed).");

  // The FBA ADAPTER. readScopeEvidence reads each account's durable FBA snapshot + recomputed D-1 request hash with
  // PER-ACCOUNT isolation: a per-account read error/absence stores null evidence (that account defers), and never
  // aborts the scope. computeAccountRevision proves the snapshot is the requested-D-1 snapshot (fba-inventory-revision).
  const adapter = {
    async readScopeEvidence({ organizationFingerprint, connectionId, scope, requestedAsOf, withTimeout: wt }) {
      const timeout = typeof wt === "function" ? wt : withTimeout;
      const perAccount = new Map();
      for (const accountId of scope) {
        let snapshot = null;
        let expectedRequestHash = "";
        try {
          const res = await timeout(readFbaSnapshot({ organizationFingerprint, connectionId, accountId }), "fba-snapshot:" + accountId);
          // read!='ok' (schema-missing / read-failed) -> treat as no durable snapshot for THIS account (defer, LKG kept).
          snapshot = res && res.read === "ok" ? (res.snapshot || null) : null;
        } catch { snapshot = null; }
        try { expectedRequestHash = S(await resolveExpectedRequestHash({ accountId, requestedAsOf })); } catch { expectedRequestHash = ""; }
        perAccount.set(accountId, { snapshot, expectedRequestHash });
      }
      return { ok: true, perAccount };
    },
    computeAccountRevision({ organizationFingerprint, connectionId, accountId, requestedAsOf, evidence }) {
      return computeFbaAccountRevision({
        organizationFingerprint, connectionId, accountId, requestedAsOf,
        snapshot: evidence && evidence.snapshot,
        expectedRequestHash: evidence && evidence.expectedRequestHash,
      });
    },
    // The fair execution order (see fbaFairOrder). The served-date reads (for 'available' accounts only) are per-account
    // isolated, capped at FBA_FAIR_READ_CAP_MS each and FBA_FAIR_READ_BUDGET_MS in total (an unread account is null =
    // most starved), run BEFORE the controls open, and can only reorder -- never change what is stale or published.
    async orderStale({ staleAccounts, perAccount, requestedAsOf }) {
      const statusOf = new Map((Array.isArray(perAccount) ? perAccount : []).map((r) => [S(r && r.accountId), r && r.status]));
      const servedAsOf = new Map();
      let budgetHit = false;
      if (typeof readServedInventoryDate === "function") {
        const t0 = clock().getTime();
        // Read in the PER-DAY TIE order (never the sorted order): if the budget cuts the reads, WHICH accounts stay unread
        // ('most starved', first) reshuffles daily instead of always being the sorted tail.
        const readOrder = [...staleAccounts].sort((x, y) => { const a = fairTie(requestedAsOf, x), b = fairTie(requestedAsOf, y); return a < b ? -1 : a > b ? 1 : 0; });
        for (const accountId of readOrder) {
          if (statusOf.get(accountId) !== FBA_REVISION_STATUS.AVAILABLE) continue;
          if (clock().getTime() - t0 >= readBudgetMs) { budgetHit = true; break; }
          let d = null;
          try { d = await capRead(readServedInventoryDate({ accountId }), readCapMs); } catch { d = null; }
          servedAsOf.set(accountId, DATE_RE.test(S(d)) ? S(d) : null);
        }
      }
      const order = fbaFairOrder({ staleAccounts, statusOf, servedAsOf, requestedAsOf });
      const avail = order.filter((a) => statusOf.get(a) === FBA_REVISION_STATUS.AVAILABLE);
      log(`fair order: ${order.length} stale account(s) -- ${avail.length} available first, ${avail.filter((a) => servedAsOf.get(a) == null).length} of them with no served available date (most starved)${budgetHit ? "; served-date read budget reached" : ""}`);
      return order;
    },
  };

  return buildSavedDataReconciler({
    resolveOrg, bucketAccounts, adapter,
    readLatestReportJob, readShadowSnapshot, readLiveSnapshot, loadStoragePayload, verifyLiveReadback,
    liveContracts, computeHash, reportDerivations, shadowKeyFor,
    runReleaseForAccount,
    postPromotionHook: null, membershipSourceReport: null, postPromotionSummaryKey: "brandView",
    revisionChangedReason: "fba-revision-changed",
    family: "fba",
    reportKeys,
    openControls, closeControls,
    outOfTime, deadlineRace, makeAbortController, awaitSettled,
    withTimeout, clock, log,
  });
}
