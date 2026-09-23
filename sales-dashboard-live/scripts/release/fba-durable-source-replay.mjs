// ZERO-EXPORT recovery for the durable FBA source-snapshot backstop.
//
// WHY: a scheduler FBA go-live can drain + publish fba-plan yet leave public.source_snapshots(fba-inventory-health)
// EMPTY when the plan was not threaded into the persist (the plan-drop bug this repair closes). This operator RE-LANDS
// the durable source rows for already-fetched accounts using ONLY the evidence already in the durable source-export
// cache -- it NEVER creates a DataDoe export, never re-fetches FBA, and never spends a token. It rebuilds the exact
// batched plan (deterministic in bucketAccounts/asOf/inventoryAsOf/overflow), then reuses the SAME canonical
// isolate -> validate -> per-seller-identity persist the go-live uses (persistDurableFbaSnapshotsFromPlan). Idempotent
// (the record_source_snapshot CAS treats an identical re-persist as 'unchanged'); per-account isolated.
//
//   node scripts/release/fba-durable-source-replay.mjs --region=india|europe-au|us-ca|all [--mode=report|replay]
//        [--inventory-as-of=YYYY-MM-DD] [--as-of=YYYY-MM-DD] [--max-blocked=2] [--bucket=us|non-us|both]
//
// --mode=report (default): READ-ONLY preview. Exercises the full isolate/validate path with DRY writes and reports,
//        per account, whether the already-fetched cache holds recoverable evidence (persisted-eligible / cache-miss ->
//        needs the next natural cycle / owner-incomplete / invalid). ZERO writes, ZERO export.
// --mode=replay: writes the durable source_snapshots(fba-inventory-health) rows for the eligible accounts (idempotent
//        CAS). ZERO DataDoe export, ZERO token. Absent/invalid evidence is reported precisely, never fabricated.

import { loadReleaseEnv } from "./env-bootstrap.mjs";
import { REGION_SCOPES, isRegionScope } from "../../lib/server/sync/scheduler-scope.js";
loadReleaseEnv();

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const mode = (argOf("mode") || "report").toLowerCase();
if (mode !== "report" && mode !== "replay") { console.error("STOP --mode must be report | replay"); process.exit(2); }
const regionArg = (argOf("region") || "").toLowerCase();
const bucketArg = (argOf("bucket") || "both").toLowerCase();
const asOfArg = argOf("as-of");
const maxBlocked = Number(argOf("max-blocked") || 2);

let selectedScopes;
if (regionArg) {
  if (regionArg === "all") selectedScopes = [...REGION_SCOPES];
  else if (isRegionScope(regionArg)) selectedScopes = [regionArg];
  else { console.error("STOP --region must be india | europe-au | us-ca | all"); process.exit(2); }
} else {
  if (!["us", "non-us", "both"].includes(bucketArg)) { console.error("STOP --bucket must be us | non-us | both"); process.exit(2); }
  selectedScopes = ["us", "non-us"].filter((b) => bucketArg === "both" || bucketArg === b);
}
const label = regionArg || bucketArg;
const log = (m) => console.log("fba-durable-replay[" + mode + "/" + label + "]: " + m);

const { buildFbaPlanRelease } = await import("../../lib/server/sync/fba-plan-release-composition.js");
const { resolveFbaPlanScope, buildFbaBucketPlan, fbaBucketAccounts, fbaServerCeiling, fbaInventoryAsOf } = await import("../../lib/server/sync/fba-plan-operation.js");
const { persistDurableFbaSnapshotsFromPlan } = await import("../../lib/server/sync/fba-durable-source-persist.js");
const { getDataDoeConnections } = await import("../../lib/server/datadoe-connections.js");

const CEILING = fbaServerCeiling();
const inventoryAsOfArg = argOf("inventory-as-of");
if (inventoryAsOfArg != null) {
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(inventoryAsOfArg) && new Date(`${inventoryAsOfArg}T00:00:00Z`).toISOString().slice(0, 10) === inventoryAsOfArg;
  if (!ok) { console.error("STOP --inventory-as-of must be a real YYYY-MM-DD calendar date"); process.exit(2); }
}
const inventoryAsOf = inventoryAsOfArg || fbaInventoryAsOf();

const release = buildFbaPlanRelease({ operator: process.env.PRIORITY_OPERATOR || "laxmikant@superboring.in" });
const accounts = await release.loadAccounts();
if (!accounts.length) { console.error("STOP no primary accounts with directory metadata discovered."); process.exit(1); }
log("discovered " + accounts.length + " primary accounts; inventory as-of " + inventoryAsOf + " (ceiling " + CEILING + ")");

const primary = (getDataDoeConnections() || []).find((c) => c && c.id === "primary");
if (!primary || !primary.apiKey) { console.error("STOP primary DataDoe connection/apiKey unavailable (cannot recompute the per-seller identity)."); process.exit(1); }

// DRY writers for report mode: exercise isolate/validate exactly, but write NOTHING (zero-side-effect preview).
const drySave = async (a) => ({ objectPath: "(dry)/" + a.scopeKey, payloadSha: "(dry)", payloadBytes: 0 });
const dryRecord = async () => ({ write: "dry", ack: "dry" });

let totals = { persisted: 0, skipped: 0, failed: 0, needNextCycle: 0, expected: 0 };
const perScope = [];

for (const bucket of selectedScopes) {
  const bucketAccounts = fbaBucketAccounts(accounts, bucket);
  if (!bucketAccounts.length) { log(bucket + ": no accounts -- skipping."); continue; }
  const scope = await resolveFbaPlanScope({ accounts: bucketAccounts, connections: release.connections, asOfArg, maxBlocked, ceiling: CEILING, readers: release.scopeReaders });
  if (!scope.asOf) { log(bucket + ": no durable sales coverage -- cannot resolve an as-of (nothing was fetchable; skipping)."); continue; }
  // Match the go-live's overflow-aware plan identities where possible (fail-soft to default batching).
  let overflowSellers = new Set();
  try { const ov = await release.resolveOverflowSellers({ bucket, bucketAccounts, asOf: scope.asOf, inventoryAsOf }); overflowSellers = (ov && ov.overflowSellers) || new Set(); }
  catch { overflowSellers = new Set(); }
  const plan = buildFbaBucketPlan({ bucketAccounts, connections: release.connections, asOf: scope.asOf, inventoryAsOf, overflowSellers });
  const includedIds = scope.included.filter((id) => bucketAccounts.some((a) => a.accountId === id));
  const accountsById = new Map(bucketAccounts.filter((a) => a && a.accountId).map((a) => [String(a.accountId), { country: String(a.country) }]));
  log(bucket + ": as-of " + scope.asOf + "; included " + includedIds.length + "/" + bucketAccounts.length + " (blocked " + scope.blocked.length + "); " + plan.sourceJobs.length + " batched source jobs" + (overflowSellers.size ? "; overflow-split " + overflowSellers.size : ""));

  const out = await persistDurableFbaSnapshotsFromPlan({
    reportRequests: plan.reportRequests, includedIds, inventoryAsOf, bucket, accountsById,
    apiKey: primary.apiKey, connectionId: "primary",
    loadSourceExportCache: (h) => release.getSourceExportCache(h),
    saveSnapshotPayload: mode === "replay" ? undefined : drySave,
    recordSnapshot: mode === "replay" ? undefined : dryRecord,
    // In replay mode wire the REAL writers via the release seam by delegating to its collaborator instead.
    log: () => {},
  });

  // In replay mode, use the release's real persist (real save/record CAS). We re-run with the real writers.
  let real = out;
  if (mode === "replay") {
    real = await release.persistDurableFbaSnapshots({ reportRequests: plan.reportRequests, includedIds, inventoryAsOf, bucket, accountsById, outOfTime: () => false, log: () => {} });
  }

  const persisted = (real.persisted || []);
  const skipped = (real.skipped || []);
  const failed = (real.failed || []);
  const cacheMiss = skipped.filter((s) => s.reason === "source-cache-miss");
  totals.expected += includedIds.length;
  totals.persisted += persisted.length; totals.skipped += skipped.length; totals.failed += failed.length; totals.needNextCycle += cacheMiss.length;
  perScope.push({ bucket, asOf: scope.asOf, expected: includedIds.length, persisted: persisted.length, skipped: skipped.length, failed: failed.length, cacheMiss: cacheMiss.length });

  log(bucket + " " + (mode === "replay" ? "REPLAYED" : "PREVIEW") + ": persisted " + persisted.length + "/" + includedIds.length
    + (skipped.length ? "; skipped " + skipped.length + " [" + [...new Set(skipped.map((s) => s.reason))].join(",") + "]" : "")
    + (failed.length ? "; FAILED " + failed.length + " [" + [...new Set(failed.map((s) => s.reason))].join(",") + "]" : "")
    + (real.error ? "; ERROR " + real.error : ""));
  if (cacheMiss.length) log(bucket + " NEEDS NEXT NATURAL CYCLE (no cached evidence): " + cacheMiss.map((s) => String(s.accountId).slice(0, 8)).join(", "));
  if (failed.length) for (const f of failed) console.error("  FAIL " + String(f.accountId).slice(0, 8) + " " + f.reason);
}

log("TOTAL (" + mode + "): persisted " + totals.persisted + "/" + totals.expected + "; skipped " + totals.skipped + " (need-next-cycle " + totals.needNextCycle + "); failed " + totals.failed
  + " -- " + perScope.map((s) => s.bucket + " " + s.persisted + "/" + s.expected).join("; "));
log("ZERO DataDoe export, ZERO token spent (recovery reused the durable source-export cache only).");
process.exit(totals.failed > 0 ? 1 : 0);
