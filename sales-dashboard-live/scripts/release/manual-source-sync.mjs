// TRUSTED manual source-sync OPERATOR -- the Data Sync Center "Sync source" flow as a controlled CLI, running the
// SAME shared orchestration the API route uses (lib/server/sync/source-sync-operation.js):
//
//   node scripts/release/manual-source-sync.mjs --bucket=us|non-us --source=order-line-items|ads-asin-date|product-catalog [--as-of=YYYY-MM-DD]
//
// Flow: validate frozen identifiers -> sync ONLY the selected source (bounded, resumable) -> derive EVERY affected
// dashboard from the SAME persisted evidence -> finalize -> preflight-all -> publish via freshness CAS inside an
// open->publish->ALWAYS-safe-close envelope -> exact live read-back -> report. Exit 0 only on proven completion.
// Campaign Ads / FBA / unrelated reports are structurally absent (frozen registries).

import { loadReleaseEnv } from "./env-bootstrap.mjs";

loadReleaseEnv();

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const bucket = argOf("bucket");
const sourceKey = argOf("source");
const asOfArg = argOf("as-of") || new Date(Date.now() - 86400000).toISOString().slice(0, 10);

const { validateSourceSyncRequest, runReleaseSlice } = await import("../../lib/server/sync/source-sync-operation.js");
let request;
try { request = validateSourceSyncRequest({ bucket, sourceKey, origin: "admin-manual", asOf: asOfArg }); }
catch (e) { console.error("STOP " + (e && e.message ? e.message : e)); process.exit(2); }
const log = (m) => console.log("manual-sync[" + request.bucket + "/" + request.sourceKey + "@" + request.asOf + "]: " + m);
log("validated (origin=admin-manual, operationKey=" + request.operationKey + ")");

const { buildBucketSourceSyncRuntime } = await import("../../lib/server/sync/source-bucket-sync-runtime.js");
const { getSyncSourceJobs } = await import("../../lib/server/supabase.js");
const { runAsinAdsBucketSlice } = await import("../../lib/server/sync/scheduled-asin-ads-runner.js");
const { buildPriorityDashboardsRelease } = await import("../../lib/server/sync/source-priority-dashboards.js");
const { buildLiveReadback } = await import("../../lib/server/sync/source-priority-release-runner.js");
const { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } = await import("../../lib/server/sync/report-publisher.js");
const { REPORT_DERIVATIONS } = await import("../../lib/server/sync/report-derivation.js");
const { paramsHashFor } = await import("../../lib/server/report-store.js");
const { runControlPackageCli } = await import("../../lib/server/sync/source-priority-control-package.js");
const { CONTROLLED_REPORT_KEYS } = await import("../../lib/server/sync/report-controls.js");
const { connectPriorityControlStore, discoverPrimaryAccountIds } = await import("../../lib/server/sync/priority-control-pg-store.js");
const sb = await import("../../lib/server/supabase.js");

const BUDGET_MS = Number(process.env.MANUAL_SYNC_BUDGET_MS || 45 * 60 * 1000);
const startedAt = Date.now();
const outOfTime = () => Date.now() - startedAt > BUDGET_MS;

// ---------------- Stage 1: sync ONLY the selected source ----------------
if (request.sourceKey === "ads-asin-date") {
  // The durable Ads architecture (coverage mode): connection pre-flight excludes disconnected accounts (typed
  // unavailable, never blocking the rest); coverage pre-filter needs zero creates for covered accounts.
  let passes = 0;
  for (;;) {
    passes += 1;
    const res = await runAsinAdsBucketSlice({ bucket: request.bucket, asOf: request.asOf, log });
    if (res.phase === "complete") { log("ads sync complete: creates=" + res.creates + " tokens=" + res.tokens + " covered=" + res.covered + " disconnected=" + res.incompatible); break; }
    if (res.continuationRequired === true) { if (outOfTime() || passes > 40) { console.error("STOP ads sync exhausted the operator budget"); process.exit(1); } continue; }
    console.error("STOP ads sync failed: " + JSON.stringify(res.problems || [])); process.exit(1);
  }
} else {
  // OLI / Catalog through the bucket source runtime (single-family drain; other families untouched).
  const { runCycleCreateReconcile } = await import("../../lib/server/sync/source-create-reconcile-driver.js");
  const runtime = buildBucketSourceSyncRuntime({ budgetMs: BUDGET_MS, asOfOverride: request.asOf });
  const deadline = runtime.makeDeadline();
  const preflight = await runtime.preflightEvidence({ bucket: request.bucket, sourceKey: request.sourceKey, deadline });
  const isOpen = (j) => { const st = j.fetch_status ?? j.fetchStatus; return st === "pending" || st === "attempted"; };
  const isFailedResumable = (j) => (j.fetch_status ?? j.fetchStatus) === "failed" && j.terminal !== true;
  let cycleId = null; let prevOutstanding = Infinity; let stall = 0; let reconcileTried = false;
  for (let iter = 1; iter <= 200; iter += 1) {
    const res = await runtime.runSourceCardAction({ bucket: request.bucket, sourceKey: request.sourceKey, deadline, preflight });
    if (res && res.refused === true) { console.error("STOP source action refused: " + (res.code || "unknown")); process.exit(1); }
    if (res && res.alreadyTerminal === true) {
      // The day's cycle already completed (terminal) -- nothing may be appended to it. The release stage below
      // independently re-proves the durable evidence and publishes/reads back idempotently.
      log("cycle " + String(res.cycleId).slice(0, 8) + " is already terminal (" + res.cycleStatus + ") -> the day's source sync is complete; proceeding to release");
      break;
    }
    cycleId = (res && res.cycleId) || cycleId;
    if (!cycleId) { log("nothing to sync (no cycle opened: zero missing work)"); break; }
    const jobs = await getSyncSourceJobs(cycleId);
    const family = jobs.filter((j) => (j.source_key ?? j.sourceKey) === request.sourceKey);
    const open = family.filter(isOpen).length;
    const failed = family.filter(isFailedResumable).length;
    // DRAINED means every family job SUCCEEDED -- a typed-failed non-terminal job (transient 503 / interrupted
    // create) is NOT drained: the engine re-attempts it on the next pass (its own reviewed resume semantics), so
    // keep resuming while ANY outstanding work remains, with the stall guard as the honest stop.
    const outstanding = open + failed;
    log("iter " + iter + ": cycle=" + String(cycleId).slice(0, 8) + " open=" + open + " failed=" + failed);
    if (outstanding === 0) break;
    if (outOfTime()) { console.error("STOP operator budget exhausted with open=" + open + " failed=" + failed); process.exit(1); }
    stall = outstanding >= prevOutstanding ? stall + 1 : 0; prevOutstanding = outstanding;
    if (stall >= 2) {
      // Network failure class 4: an AMBIGUOUS create (typed create-stage failure whose create may have LANDED)
      // is never blindly retried by the engine -- reconcile ONCE against the real exports list and adopt only an
      // exact identity (zero new creates), then keep draining. Anything else is an honest stop.
      if (!reconcileTried && failed > 0) {
        reconcileTried = true;
        const rr = await runCycleCreateReconcile({ preflight, bucket: request.bucket, deadline, log });
        if (rr.ran === true && rr.recovered > 0) { stall = 0; prevOutstanding = Infinity; continue; }
      }
      console.error("STOP no progress for 2 consecutive resumptions (open=" + open + " failed=" + failed + ") -- transient source failures persisted; LKG intact, re-run later."); process.exit(1);
    }
  }
  log("source sync drained (every family job succeeded)");
}

// ---------------- Stage 2: derive + publish EVERY affected dashboard (same evidence, zero new exports) ----------
const release = buildPriorityDashboardsRelease({ asOfOverride: request.asOf, operationKey: request.operationKey });
const readbackLive = buildLiveReadback({
  getReportSnapshot: sb.getReportSnapshot,
  loadStoragePayload: sb.getReportSnapshotStoragePayload,
  liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS,
  reportDerivations: REPORT_DERIVATIONS,
  computeHash: paramsHashFor,
});
const OPERATOR = process.env.PRIORITY_OPERATOR || "laxmikant@superboring.in";
// The SAME reviewed pg store + discovery the control-package CLI uses (moved verbatim into the shared lib).
const connectStore = connectPriorityControlStore;
const discoverAccounts = discoverPrimaryAccountIds;
const controls = {
  apply: async () => {
    const r = await runControlPackageCli({ mode: "apply", operator: OPERATOR, discoverAccounts, connectStore, controlledReportKeys: CONTROLLED_REPORT_KEYS, log: (m) => log("controls: " + m) });
    if (!r || r.committed !== true) throw new Error("controls apply did not commit (code " + (r && r.code) + ")");
  },
  close: async () => {
    const r = await runControlPackageCli({ mode: "rollback", operator: OPERATOR, connectStore, controlledReportKeys: CONTROLLED_REPORT_KEYS, log: (m) => log("controls: " + m) });
    if (!r || r.committed !== true) throw new Error("SAFE-CLOSE did not commit (code " + (r && r.code) + ") -- verify controls manually");
  },
};

let slices = 0;
for (;;) {
  slices += 1;
  const res = await runReleaseSlice({ bucket: request.bucket, release, controls, readbackLive, outOfTime, log });
  if (res.phase === "complete" && res.ok === true) { log("RELEASE COMPLETE: " + res.published + " accounts x 3 reports published + read back live"); break; }
  if (res.continuationRequired === true) { if (outOfTime() || slices > 60) { console.error("STOP release exhausted the operator budget at phase=" + res.phase); process.exit(1); } log("release slice " + slices + ": phase=" + res.phase + " -> continuing"); continue; }
  console.error("STOP release failed at phase=" + res.phase + ": " + JSON.stringify(res.problems || [])); process.exit(1);
}

log("DONE: source=" + request.sourceKey + " synced; affected dashboards (" + request.dependencies.reports.join(", ") + ") derived from the same evidence, published, read back; controls safe-closed.");
process.exit(0);
