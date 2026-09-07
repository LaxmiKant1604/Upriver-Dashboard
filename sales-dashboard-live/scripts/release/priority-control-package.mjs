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
import { isRoutingScope } from "../../lib/server/sync/scheduler-scope.js";

loadReleaseEnv(); // portable: loads <repoRoot>/.env.local when present, maps SUPABASE_URL, never overrides CI env

const MODE = process.argv.includes("--apply") ? "apply"
  : process.argv.includes("--rollback") ? "rollback"
  : process.argv.includes("--reclaim-stale") ? "reclaim" // Round-8 blocker 1: expired-lease cleanup (safe-close ONLY if no live owner)
  : "dry-run";
const OPERATOR = process.env.PRIORITY_OPERATOR || "laxmikant@superboring.in";
// Optional --bucket: open controls for EXACTLY that routing scope's primary accounts (region india|europe-au|us-ca
// or legacy us|non-us; independent scopes). Omitted => ALL primary accounts (legacy combined). --rollback ignores
// it (the safe-close is global).
const BUCKET = (process.argv.find((a) => a.startsWith("--bucket=")) || "").split("=")[1] || null;
if (BUCKET != null && !isRoutingScope(BUCKET)) { console.error("STOP --bucket must be a routing scope (india|europe-au|us-ca|us|non-us; got: " + BUCKET + ")"); process.exit(2); }
// --account-scope: 'full' (default) | 'bootstrap' (the accounts a dispatch WAVE authorized, resolved
// from the IMMUTABLE (region, --dispatch-id) row -- NEVER workflow inputs, NEVER recomputed from current
// onboarding status). A bootstrap apply opens the publication controls for EXACTLY the frozen wave set so
// the dispatched run can publish those accounts' dashboards (Daily Reporting + Brand Sales) automatically;
// no unrelated account enters the scope. Requires ONE explicit region --bucket + --dispatch-id; an EMPTY
// ready set is a green no-op (ZERO writes -- it must never reconcile the global controls against nothing).
const ACCOUNT_SCOPE = (process.argv.find((a) => a.startsWith("--account-scope=")) || "").split("=")[1] || "full";
const DISPATCH_ID = (process.argv.find((a) => a.startsWith("--dispatch-id=")) || "").split("=").slice(1).join("=") || null;
if (ACCOUNT_SCOPE !== "full" && ACCOUNT_SCOPE !== "bootstrap") { console.error("STOP --account-scope must be full | bootstrap (got: " + ACCOUNT_SCOPE + ")"); process.exit(2); }
if (ACCOUNT_SCOPE === "bootstrap" && MODE !== "rollback" && (!BUCKET || !DISPATCH_ID)) { console.error("STOP --account-scope=bootstrap requires ONE explicit region --bucket AND --dispatch-id"); process.exit(2); }
// Round-8 blocker 2: the control-plane owner-lease token is REQUIRED for a LIVE apply/rollback (NO generated
// fallback -- a separate --apply and --rollback process MUST share the SAME explicit token, else the rollback
// could not own the apply's lease). In the workflow this is github run_id-run_attempt. dry-run + reclaim do not
// need it (dry-run writes nothing; reclaim mints its own token to acquire the free/expired lease).
const OWNER_TOKEN = ((process.argv.find((a) => a.startsWith("--owner-token=")) || "").split("=").slice(1).join("=") || "").trim();
if ((MODE === "apply" || MODE === "rollback") && !OWNER_TOKEN) {
  console.error("STOP --owner-token is REQUIRED for a live --apply/--rollback (a separate apply/rollback must pass the SAME explicit token; no fallback is generated).");
  process.exit(2);
}
// Round-9 P1-C: the EXPECTED fencing generation for a --rollback (the exact generation the --apply acquired,
// THREADED explicitly -- never inferred). A --rollback that omits it can still close only if it is the current
// owner, but with it a superseded generation is refused so a stale process cannot close a newer lease. --apply
// EMITS its acquired generation (below) for the workflow to thread into --rollback.
const rawOwnerGen = ((process.argv.find((a) => a.startsWith("--owner-generation=")) || "").split("=").slice(1).join("=") || "").trim();
const OWNER_GENERATION = /^\d+$/.test(rawOwnerGen) ? Number(rawOwnerGen) : null;
// reclaim mints its own unique token: it acquires ONLY a free/expired lease (a live owner blocks it), then closes.
const RECLAIM_TOKEN = "reclaim-stale/" + (BUCKET || "all") + "/" + process.pid + "-" + Date.now();
const EFFECTIVE_TOKEN = MODE === "reclaim" ? RECLAIM_TOKEN : OWNER_TOKEN;

console.log("CONTROL-PACKAGE mode=" + MODE + " operator=" + OPERATOR + (BUCKET ? " bucket=" + BUCKET : "") + (ACCOUNT_SCOPE === "bootstrap" ? " account-scope=bootstrap dispatch=" + DISPATCH_ID : ""));
console.log("  dispatch enabled: " + PRIORITY_DISPATCH_ENABLED.join(", ") + "; promoted enabled: " + PRIORITY_PROMOTED_ENABLED + "; all_primary=false; unrelated reports paused; no cron.");
console.log("  --rollback is a DISCOVERY-INDEPENDENT SAFE-CLOSE: NO DataDoe call, disables EVERY rollout row, pauses ALL " + CONTROLLED_REPORT_KEYS.length + " controlled settings, disables EVERY promoted control, revokes EVERY approval (audited).");

// Fresh PRIMARY discovery -- the exact account set the publisher's rollout resolves against. ONLY apply/dry-run
// need it; --rollback never calls this (the safe-close is global and must work even if DataDoe is unavailable).
// When --bucket is set, discovery is restricted to that bucket so the apply opens controls for ONLY those accounts.
// Bootstrap scope replaces discovery with the FROZEN dispatch-wave set (backend-resolved from the immutable row).
const discoverAccounts = ACCOUNT_SCOPE === "bootstrap"
  ? async () => {
    const { resolveBootstrapScopeByDispatch } = await import("../../lib/server/sync/account-onboarding-bootstrap.js");
    const { getDataDoeConnections } = await import("../../lib/server/datadoe-connections.js");
    const primary = getDataDoeConnections().find((c) => c.id === "primary");
    const scope = await resolveBootstrapScopeByDispatch({ apiKey: primary.apiKey, region: BUCKET, dispatchId: DISPATCH_ID });
    if (!scope.ok) throw new Error("BOOTSTRAP_SCOPE_UNRESOLVED (" + scope.reason + ")");
    return scope.accounts.map((a) => String((a && (a.accountId ?? a.id)) || "").trim()).filter(Boolean);
  }
  : () => discoverPrimaryAccountIds(BUCKET);

// EMPTY-SET GUARD (bootstrap apply/dry-run): reconciling the global controls against an empty set would
// disable every account's rollout -- with nothing ready to publish, exit green with ZERO writes before
// any store connection.
if (ACCOUNT_SCOPE === "bootstrap" && MODE !== "rollback") {
  let bootstrapIds = [];
  try { bootstrapIds = await discoverAccounts(); } catch (e) { console.error("STOP " + (e && e.message)); process.exit(1); }
  if (!bootstrapIds.length) {
    console.log("BOOTSTRAP_SCOPE_EMPTY: no ready bootstrap accounts for " + BUCKET + "/" + DISPATCH_ID + " -- ZERO control writes.");
    process.exit(0);
  }
}

// The pg-backed store implementing the runControlPackageTransaction contract now lives VERBATIM in
// lib/server/sync/priority-control-pg-store.js (shared with the manual source-sync operator -- one
// implementation, no drift). It is created ONLY for a live apply/rollback (dry-run never connects).
const connectStore = connectPriorityControlStore;

let result = { committed: false, code: 1 };
try {
  result = await runControlPackageCli({ mode: MODE, operator: OPERATOR, discoverAccounts, connectStore, controlledReportKeys: CONTROLLED_REPORT_KEYS, ownerToken: EFFECTIVE_TOKEN, ownerGeneration: OWNER_GENERATION, operationKey: "priority-control/" + (BUCKET || "all") + "/" + ACCOUNT_SCOPE, log: (m) => console.log("  " + m) });
  // Round-9/10 P1-C: EMIT the acquired fencing generation so the workflow threads it into this run's --rollback
  // (and so bootstrap-publish / FBA go-live fence the exact generation). Never inferred downstream. A committed
  // apply ALWAYS carries a valid generation (the transaction fails closed otherwise). Round-10 (blocker 4):
  // FAILING to write the generation to GITHUB_OUTPUT is FATAL -- we must NOT silently downgrade fencing; the run
  // exits nonzero so the safe-close is honestly left for expiry/reclaim rather than run with a blank generation.
  if (MODE === "apply" && result && result.committed === true) {
    const gen = Number(result.leaseGeneration);
    if (!(Number.isSafeInteger(gen) && gen > 0)) {
      console.error("STOP apply committed WITHOUT a valid fencing generation (" + result.leaseGeneration + ") -- refusing (fail closed).");
      process.exit(1);
    }
    console.log("CONTROL_LEASE_GENERATION=" + gen);
    if (process.env.GITHUB_OUTPUT) {
      try { (await import("node:fs")).appendFileSync(process.env.GITHUB_OUTPUT, "generation=" + gen + "\n"); }
      catch (e) { console.error("STOP could not write the apply generation to GITHUB_OUTPUT (" + (e && e.message) + ") -- FATAL: cleanup is left for expiry/reclaim, never a blank-generation safe-close."); process.exit(1); }
    }
  }
  if (result.dryRun) {
    console.log("  DRY RUN -- discovered " + result.pkg.accounts.length + " primary accounts; APPLY target: rollout=" + result.pkg.post.rolloutEnabled.length + ", dispatch=" + result.pkg.post.dispatchEnabled.length + " (paused=" + result.pkg.post.dispatchPaused.length + "), promoted=1, approvals=" + result.pkg.post.approvals.length + ".");
    console.log("  No writes. Re-run with --apply (or --rollback) to execute the guarded transaction.");
  } else if (result.skipped === "lease-not-owner" || result.leaseNotOwner === true) {
    // TYPED NON-SUCCESS (blocker 2): NEVER reported as "safe-close complete" / committed success.
    console.log("SKIPPED control package (" + MODE + "): NOT the control-plane lease owner (another operation owns it, or it already expired/released) -- NO controls were closed. This is a typed skip, not a committed safe-close.");
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
// exit 0 = committed / dry-run / typed lease-not-owner SKIP (a correct no-op: nothing closed, NOT a committed
// safe-close); 3 = COMMIT_UNKNOWN (read-only reconcile required); 1 = ordinary failure.
const leaseSkip = result && (result.skipped === "lease-not-owner" || result.leaseNotOwner === true);
process.exit(result.committed || result.dryRun || leaseSkip ? 0 : (result.code === 3 ? 3 : 1));
