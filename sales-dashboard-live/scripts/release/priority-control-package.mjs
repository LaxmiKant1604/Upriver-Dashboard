// TRUSTED, DEFERRED control-package operator for the Daily Reporting + Brand View priority go-live.
// Usage (run from sales-dashboard-live/, AFTER Codex sign-off):
//   node scripts/release/priority-control-package.mjs            -> DRY RUN: print the exact package (NO writes)
//   node scripts/release/priority-control-package.mjs --apply    -> apply the package in ONE guarded transaction
//   node scripts/release/priority-control-package.mjs --rollback -> reverse the package in ONE guarded transaction
//
// It opens the publication gates for EXACTLY daily-reporting + brand-sales (dispatch) + brand-inventory (promoted)
// for ALL freshly discovered PRIMARY accounts, with an audited approval for every (key, account); all_primary
// STAYS false; every unrelated controlled report is paused; no cron is created. Everything happens in ONE
// advisory-locked transaction with exact PRE and POST assertions -- any failure ROLLS BACK the whole package.
// The default (no flag) is a DRY RUN that writes nothing.

import { loadReleaseEnv } from "./env-bootstrap.mjs";
import { runControlPackageCli, PRIORITY_DISPATCH_ENABLED, PRIORITY_PROMOTED_ENABLED } from "../../lib/server/sync/source-priority-control-package.js";
import { CONTROLLED_REPORT_KEYS } from "../../lib/server/sync/report-controls.js";
// The reviewed pg store + primary discovery moved VERBATIM into the shared lib (one implementation for the CLI,
// the manual source-sync operator, and any other trusted caller -- no drift).
import { connectPriorityControlStore, discoverPrimaryAccountIds } from "../../lib/server/sync/priority-control-pg-store.js";

loadReleaseEnv(); // portable: loads <repoRoot>/.env.local when present, maps SUPABASE_URL, never overrides CI env

const MODE = process.argv.includes("--apply") ? "apply" : process.argv.includes("--rollback") ? "rollback" : "dry-run";
const OPERATOR = process.env.PRIORITY_OPERATOR || "laxmikant@superboring.in";

console.log("CONTROL-PACKAGE mode=" + MODE + " operator=" + OPERATOR);
console.log("  dispatch enabled: " + PRIORITY_DISPATCH_ENABLED.join(", ") + "; promoted enabled: " + PRIORITY_PROMOTED_ENABLED + "; all_primary=false; unrelated reports paused; no cron.");
console.log("  --rollback is a DISCOVERY-INDEPENDENT SAFE-CLOSE: NO DataDoe call, disables EVERY rollout row, pauses ALL " + CONTROLLED_REPORT_KEYS.length + " controlled settings, disables EVERY promoted control, revokes EVERY approval (audited).");

// Fresh PRIMARY discovery -- the exact account set the publisher's rollout resolves against. ONLY apply/dry-run
// need it; --rollback never calls this (the safe-close is global and must work even if DataDoe is unavailable).
const discoverAccounts = discoverPrimaryAccountIds;

// The pg-backed store implementing the runControlPackageTransaction contract now lives VERBATIM in
// lib/server/sync/priority-control-pg-store.js (shared with the manual source-sync operator -- one
// implementation, no drift). It is created ONLY for a live apply/rollback (dry-run never connects).
const connectStore = connectPriorityControlStore;

let result = { committed: false, code: 1 };
try {
  result = await runControlPackageCli({ mode: MODE, operator: OPERATOR, discoverAccounts, connectStore, controlledReportKeys: CONTROLLED_REPORT_KEYS, log: (m) => console.log("  " + m) });
  if (result.dryRun) {
    console.log("  DRY RUN -- discovered " + result.pkg.accounts.length + " primary accounts; APPLY target: rollout=" + result.pkg.post.rolloutEnabled.length + ", dispatch=" + result.pkg.post.dispatchEnabled.length + " (paused=" + result.pkg.post.dispatchPaused.length + "), promoted=1, approvals=" + result.pkg.post.approvals.length + ".");
    console.log("  No writes. Re-run with --apply (or --rollback) to execute the guarded transaction.");
  } else if (result.committed) {
    console.log("COMMITTED control package (" + MODE + ")" + (result.mode === "apply" ? "" : " -- safe-close complete"));
  } else if (result.commitUnknown) {
    console.error("COMMIT_UNKNOWN control package (" + MODE + "): " + result.problem);
    console.error(result.instruction);
  } else {
    console.error("ROLLBACK control package (" + MODE + "): " + (result.problem || (result.problems || []).join("; ")) + (result.rollbackError ? " [rollback ALSO failed: " + result.rollbackError + "]" : ""));
  }
} catch (e) {
  console.error("control package (" + MODE + ") failed before any transaction: " + (e && e.message));
  result = { committed: false, code: 1 };
}
// exit 0 = committed / dry-run; 3 = COMMIT_UNKNOWN (read-only reconcile required); 1 = ordinary failure.
process.exit(result.committed || result.dryRun ? 0 : (result.code === 3 ? 3 : 1));
