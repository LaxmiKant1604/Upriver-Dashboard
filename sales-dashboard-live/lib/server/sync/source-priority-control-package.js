// Scheduler v2 -- the EXACT publication control package for the Daily Reporting + Brand View priority go-live.
//
// TWO parts, both offline-testable; the CLI wires production + a --apply/--rollback flag (default: dry-run):
//   1. buildPriorityControlPackage(...)          -- a PURE builder: the exact target control state (+ its
//      declarative global POST assertions) for the freshly discovered primary accounts.
//   2. runControlPackageTransaction({ store, pkg, mode }) -- the guarded transaction that ACTIVELY produces
//      exactly that target (apply) or safely closes every priority control (rollback), asserting the COMPLETE
//      global sets before COMMIT and rolling back on ANY mismatch. All gate logic lives here (never duplicated
//      in the CLI); the `store` abstracts the durable writes/reads so a fake store drives transaction-level tests.
//
// APPLY target: all_primary STAYS false; EXACTLY one enabled rollout row per primary account and NO other
// enabled rollout row; EXACTLY the two dispatch controls daily-reporting + brand-sales are schedule_enabled and
// every other controlled report is paused; EXACTLY the source-promoted brand-inventory control is enabled and no
// other promoted control; EXACTLY an audited approval for all THREE publication keys x every primary account and
// no other approval; no cron. The apply reconciles AWAY any pre-existing extra so the target is produced exactly.
//
// ROLLBACK is a documented SAFE-CLOSE (option B), NOT a restoration: it disables EVERY rollout row, pauses ALL
// controlled dispatch settings, disables EVERY promoted control, and revokes EVERY approval -- complete and
// correct regardless of what discovery returns at rollback time (a dynamically rediscovered blind disable would
// NOT be an honest restoration, so we never call it one).

import { CONTROLLED_REPORT_KEYS } from "./report-controls.js";
import { PRIORITY_DASHBOARDS } from "./source-priority-dashboards.js";

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";
const uniqSort = (xs) => [...new Set((Array.isArray(xs) ? xs : []).map(S).filter(nb))].sort();
const setEq = (a, b) => { const x = uniqSort(a); const y = uniqSort(b); return x.length === y.length && x.every((v, i) => v === y[i]); };

// The two Scheduler-v2 DISPATCH controls the priority go-live enables (report_sync_settings.schedule_enabled).
// brand-inventory is NOT here: it is source-promoted and gated by source_promoted_publish_settings.publish_enabled.
export const PRIORITY_DISPATCH_ENABLED = Object.freeze(["daily-reporting", "brand-sales"]);
export const PRIORITY_PROMOTED_ENABLED = "brand-inventory";

/**
 * Build the exact control package for the given freshly-discovered primary accounts. Returns
 * { accounts, operator, controlled, apply, rollback, post } -- all plain data. `accounts` must be the primary
 * account ids (no dd-secondary); `operator` audits the approvals. Fails closed on an empty account set / blank
 * operator. `post` carries the COMPLETE global target sets the guarded transaction asserts before COMMIT.
 */
export function buildPriorityControlPackage({ accounts, operator = "", controlledReportKeys = CONTROLLED_REPORT_KEYS } = {}) {
  const acct = uniqSort(accounts);
  if (!acct.length) throw new Error("buildPriorityControlPackage requires >=1 primary account (fail closed).");
  if (acct.some((a) => a.startsWith("dd-secondary:"))) throw new Error("buildPriorityControlPackage refuses a dd-secondary account (primary only, fail closed).");
  if (!nb(operator)) throw new Error("buildPriorityControlPackage requires an operator id for the audited approvals (fail closed).");
  const publishKeys = PRIORITY_DASHBOARDS.reportKeys; // daily-reporting, brand-sales, brand-inventory
  const controlled = uniqSort(controlledReportKeys);

  // report_sync_settings for EVERY controlled report: the two dispatch keys enabled, every other paused.
  const reportSyncSettings = controlled.map((rk) => ({ report_key: rk, schedule_enabled: PRIORITY_DISPATCH_ENABLED.includes(rk) }));
  const approvals = acct.flatMap((a) => publishKeys.map((rk) => rk + "|" + a)).sort();

  // The exact target rows (for the dry-run print + the CLI's pg-backed reconcile writes).
  const apply = {
    allPrimary: false, // MUST remain false
    rollout: acct.map((a) => ({ account_id: a, enabled: true, note: "priority dashboards go-live" })),
    reportSyncSettings,
    promoted: [{ report_key: PRIORITY_PROMOTED_ENABLED, publish_enabled: true }],
    approvals: acct.flatMap((a) => publishKeys.map((rk) => ({ report_key: rk, account_id: a, approved: true, approved_by: operator }))),
  };
  // Rollback is a SAFE-CLOSE descriptor (option B), not per-row restoration data.
  const rollback = {
    mode: "safe-close",
    allPrimary: false,
    disablesAllRollout: true,
    pausesAllControlledDispatch: true,
    disablesAllPromoted: true,
    revokesAllApprovals: true,
  };
  // Declarative POST assertions the guarded transaction proves before COMMIT -- COMPLETE global sets.
  const post = {
    allPrimaryFalse: true,
    rolloutEnabled: [...acct],
    dispatchEnabled: [...PRIORITY_DISPATCH_ENABLED].sort(),
    dispatchPaused: controlled.filter((rk) => !PRIORITY_DISPATCH_ENABLED.includes(rk)).sort(),
    promotedEnabled: PRIORITY_PROMOTED_ENABLED,
    approvals,
    noCron: true,
  };
  return { accounts: acct, operator, controlled, apply, rollback, post };
}

/**
 * Run the guarded control-package transaction against an injected `store`, in `mode` "apply" or "rollback".
 * ALL pre/post gate logic lives here (the CLI never duplicates it): open a transaction; PRE-assert all_primary
 * is false + no scheduler cron; WRITE (apply: reconcile to the EXACT target, disabling any extra; rollback:
 * safe-close every priority control); POST-assert the COMPLETE global sets (never filtering unexpected rows
 * away); COMMIT only if every assertion holds, else ROLLBACK. Returns { committed, mode, problems, problem? }.
 *
 * store contract (every method may be async):
 *   readAllPrimary()                              -> boolean
 *   hasCron()                                     -> boolean
 *   setRolloutEnabled(accountIds)                 -- enable EXACTLY these, disable every other rollout row
 *   disableAllRollout()                           -- disable EVERY rollout row
 *   setDispatchEnabled(enabledKeys, controlled)   -- schedule_enabled = (key in enabledKeys) for ALL controlled
 *   pauseAllDispatch(controlled)                  -- schedule_enabled = false for ALL controlled
 *   setPromotedEnabled(enabledKeys)               -- enable EXACTLY these promoted controls, disable others
 *   disableAllPromoted()                          -- disable EVERY promoted control
 *   setApprovalsApproved(pairs, operator)         -- approve EXACTLY these "reportKey|accountId", revoke others
 *   revokeAllApprovals()                          -- approved=false for EVERY approval
 *   rolloutRows()/dispatchRows()/promotedRows()/approvalRows() -- the COMPLETE current rows for global assertions
 *   begin()/commit()/rollback()                   -- transaction control
 */
export async function runControlPackageTransaction({ store, pkg, mode, controlledReportKeys = CONTROLLED_REPORT_KEYS } = {}) {
  if (!store || typeof store.begin !== "function") throw new Error("runControlPackageTransaction requires a transactional store (fail closed).");
  if (!pkg || !pkg.post || !Array.isArray(pkg.accounts)) throw new Error("runControlPackageTransaction requires a built package (fail closed).");
  if (mode !== "apply" && mode !== "rollback") throw new Error("runControlPackageTransaction mode must be 'apply' | 'rollback' (fail closed).");
  const controlled = uniqSort(controlledReportKeys);

  const controlledSet = new Set(controlled);
  const enabledRollout = async () => (await store.rolloutRows()).filter((r) => r.enabled === true).map((r) => S(r.account_id));
  // enabled dispatch is GLOBAL (a stray enabled dispatch outside the controlled set is a real anomaly to catch);
  // paused dispatch is scoped to the controlled set for the "all N settings paused" completeness count.
  const enabledDispatch = async () => (await store.dispatchRows()).filter((r) => r.schedule_enabled === true).map((r) => S(r.report_key));
  const pausedDispatch = async () => (await store.dispatchRows()).filter((r) => r.schedule_enabled === false && controlledSet.has(S(r.report_key))).map((r) => S(r.report_key));
  const enabledPromoted = async () => (await store.promotedRows()).filter((r) => r.publish_enabled === true).map((r) => S(r.report_key));
  const approvedPairs = async () => (await store.approvalRows()).filter((r) => r.approved === true).map((r) => S(r.report_key) + "|" + S(r.account_id));

  const problems = [];
  const need = (cond, msg) => { if (!cond) problems.push(msg); };
  const needSet = (actual, expected, label) => need(setEq(actual, expected), label + ": {" + uniqSort(actual).join(",") + "} != {" + uniqSort(expected).join(",") + "}");

  await store.begin();
  try {
    // ---- PRE assertions (both modes) ----
    if ((await store.readAllPrimary()) !== false) throw new Error("PRE: all_primary must be false");
    if ((await store.hasCron()) === true) throw new Error("PRE: a scheduler cron exists");

    if (mode === "apply") {
      if (!pkg.accounts.length) throw new Error("PRE: zero discovered primary accounts");
      // ---- WRITES: ACTIVELY produce EXACTLY the approved target (reconcile away any pre-existing extra) ----
      await store.setRolloutEnabled(pkg.post.rolloutEnabled);
      await store.setDispatchEnabled(pkg.post.dispatchEnabled, controlled);
      await store.setPromotedEnabled([pkg.post.promotedEnabled]);
      await store.setApprovalsApproved(pkg.post.approvals, pkg.operator);
      // ---- POST: COMPLETE global sets (NEVER filtered) ----
      needSet(await enabledRollout(), pkg.post.rolloutEnabled, "rollout-enabled");
      needSet(await enabledDispatch(), pkg.post.dispatchEnabled, "dispatch-enabled");
      needSet(await pausedDispatch(), pkg.post.dispatchPaused, "dispatch-paused");
      needSet(await enabledPromoted(), [pkg.post.promotedEnabled], "promoted-enabled");
      needSet(await approvedPairs(), pkg.post.approvals, "approved");
    } else {
      // ---- WRITES: SAFE-CLOSE every priority control (documented; NOT a restoration) ----
      await store.disableAllRollout();
      await store.pauseAllDispatch(controlled);
      await store.disableAllPromoted();
      await store.revokeAllApprovals();
      // ---- POST: full completeness -- every rollout disabled, ALL controlled paused, promoted/approvals empty ----
      needSet(await enabledRollout(), [], "rollback-rollout-still-enabled");
      needSet(await enabledDispatch(), [], "rollback-dispatch-still-enabled");
      needSet(await pausedDispatch(), controlled, "rollback-not-all-settings-paused");
      needSet(await enabledPromoted(), [], "rollback-promoted-still-enabled");
      needSet(await approvedPairs(), [], "rollback-approvals-still-true");
    }

    // ---- POST assertions (both modes) ----
    if ((await store.readAllPrimary()) !== false) throw new Error("POST: all_primary changed");
    if ((await store.hasCron()) === true) throw new Error("POST: a scheduler cron appeared");
    if (problems.length) throw new Error("POST: " + problems.join("; "));

    await store.commit();
    return { committed: true, mode, problems: [] };
  } catch (e) {
    try { await store.rollback(); } catch { /* ignore */ }
    return { committed: false, mode, problems, problem: (e && e.message) || String(e) };
  }
}
