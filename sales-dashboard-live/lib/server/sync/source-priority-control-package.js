// Scheduler v2 -- the EXACT publication control package for the Daily Reporting + Brand View priority go-live.
//
// A PURE builder (no I/O) that computes the exact durable control writes + their reversal for the freshly
// discovered primary accounts, so the operator can apply it as ONE guarded transaction with exact pre/post
// assertions. It is offline-testable; the CLI wires production + a --apply/--rollback flag (default: dry-run).
//
// The package (apply): all_primary STAYS false; an exact rollout row per primary account (enabled); ONLY the two
// dispatch controls daily-reporting + brand-sales are schedule_enabled (EVERY other controlled report is paused);
// the source-promoted brand-inventory control is enabled; an exact audited approval for all THREE publication
// keys x every primary account; no cron is created. The rollback reverses exactly those writes.

import { CONTROLLED_REPORT_KEYS } from "./report-controls.js";
import { PRIORITY_DASHBOARDS } from "./source-priority-dashboards.js";

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";

// The two Scheduler-v2 DISPATCH controls the priority go-live enables (report_sync_settings.schedule_enabled).
// brand-inventory is NOT here: it is source-promoted and gated by source_promoted_publish_settings.publish_enabled.
export const PRIORITY_DISPATCH_ENABLED = Object.freeze(["daily-reporting", "brand-sales"]);
export const PRIORITY_PROMOTED_ENABLED = "brand-inventory";

/**
 * Build the exact control package for the given freshly-discovered primary accounts. Returns
 * { accounts, apply, rollback, post } -- all plain data. `accounts` must be the primary account ids (no
 * dd-secondary); `operator` audits the approvals. Fails closed on an empty account set / blank operator.
 */
export function buildPriorityControlPackage({ accounts, operator = "", controlledReportKeys = CONTROLLED_REPORT_KEYS } = {}) {
  const acct = [...new Set((Array.isArray(accounts) ? accounts : []).map(S).filter(nb))].sort();
  if (!acct.length) throw new Error("buildPriorityControlPackage requires >=1 primary account (fail closed).");
  if (acct.some((a) => a.startsWith("dd-secondary:"))) throw new Error("buildPriorityControlPackage refuses a dd-secondary account (primary only, fail closed).");
  if (!nb(operator)) throw new Error("buildPriorityControlPackage requires an operator id for the audited approvals (fail closed).");
  const publishKeys = PRIORITY_DASHBOARDS.reportKeys; // daily-reporting, brand-sales, brand-inventory
  const controlled = [...controlledReportKeys];

  // report_sync_settings for EVERY controlled report: the two dispatch keys enabled, every other paused.
  const reportSyncSettings = controlled.map((rk) => ({ report_key: rk, schedule_enabled: PRIORITY_DISPATCH_ENABLED.includes(rk) }));

  const apply = {
    allPrimary: false, // MUST remain false
    rollout: acct.map((a) => ({ account_id: a, enabled: true, note: "priority dashboards go-live" })),
    reportSyncSettings,
    promoted: [{ report_key: PRIORITY_PROMOTED_ENABLED, publish_enabled: true }],
    approvals: acct.flatMap((a) => publishKeys.map((rk) => ({ report_key: rk, account_id: a, approved: true, approved_by: operator }))),
  };
  const rollback = {
    allPrimary: false,
    rollout: acct.map((a) => ({ account_id: a, enabled: false, note: "priority dashboards go-live rolled back" })),
    // Disable ONLY what the package enabled (the two dispatch keys); the other controlled reports were already paused.
    reportSyncSettings: PRIORITY_DISPATCH_ENABLED.map((rk) => ({ report_key: rk, schedule_enabled: false })),
    promoted: [{ report_key: PRIORITY_PROMOTED_ENABLED, publish_enabled: false }],
    approvals: acct.flatMap((a) => publishKeys.map((rk) => ({ report_key: rk, account_id: a, approved: false, approved_by: operator }))),
  };
  // Declarative POST assertions the guarded transaction must prove before COMMIT.
  const post = {
    allPrimaryFalse: true,
    rolloutEnabled: [...acct],
    dispatchEnabled: [...PRIORITY_DISPATCH_ENABLED],
    dispatchPaused: controlled.filter((rk) => !PRIORITY_DISPATCH_ENABLED.includes(rk)).sort(),
    promotedEnabled: PRIORITY_PROMOTED_ENABLED,
    approvals: acct.flatMap((a) => publishKeys.map((rk) => rk + "|" + a)).sort(),
    noCron: true,
  };
  return { accounts: acct, apply, rollback, post };
}
