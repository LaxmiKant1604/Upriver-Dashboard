// TRUSTED OPERATOR -- reconcile-and-adopt AMBIGUOUS OLI create-exports for ONE bucket's TODAY cycle, with ZERO
// new creates (the adapter's create is guarded off; adoption binds only an EXACT-identity COMPLETED export).
//   node scripts/release/reconcile-failed-creates.mjs --bucket=us|non-us [--as-of=YYYY-MM-DD] [--apply]
// Default is DRY-RUN (prints the per-job dispositions, writes nothing). --apply performs the guarded adoption
// writes + the download-only recovery via the SAME production driver the scheduled OLI runner and the manual
// source-sync operator use (lib/server/sync/source-create-reconcile-driver.js). Never prints seller ids /
// export ids / payloads.

import { loadReleaseEnv } from "./env-bootstrap.mjs";

loadReleaseEnv();

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const bucket = argOf("bucket");
const asOf = argOf("as-of");
const APPLY = process.argv.includes("--apply");
if (bucket !== "us" && bucket !== "non-us") { console.error("STOP --bucket must be us|non-us"); process.exit(2); }

const { buildBucketSourceSyncRuntime } = await import("../../lib/server/sync/source-bucket-sync-runtime.js");
const { runCycleCreateReconcile } = await import("../../lib/server/sync/source-create-reconcile-driver.js");
const { makeSupabaseSourceStore } = await import("../../lib/server/sync/source-sync-driver.js");
const bucketSync = await import("../../lib/server/sync/source-bucket-sync.js");
const { sourceContractForKey } = await import("../../lib/server/source-contracts.js");
const { getDataDoeConnections } = await import("../../lib/server/datadoe-connections.js");
const { getSyncCycleByBucketDate } = await import("../../lib/server/supabase.js");
const { matchExportForFailedCreate, reconcileEligibility } = await import("../../lib/server/sync/source-create-reconcile.js");
const { OLI_SOURCE_KEY } = await import("../../lib/server/sync/source-durable-model.js");

const log = (m) => console.log("reconcile-creates[" + bucket + "]: " + m);
const runtime = buildBucketSourceSyncRuntime({ budgetMs: 550_000, ...(asOf ? { asOfOverride: asOf } : {}) });
const dl = runtime.makeDeadline();
const pf = await runtime.preflightEvidence({ bucket, deadline: dl });

if (APPLY) {
  const rr = await runCycleCreateReconcile({ preflight: pf, bucket, deadline: dl, log });
  if (rr.ran !== true) { log("nothing to reconcile (" + rr.reason + ")."); process.exit(0); }
  log("RESULT attempted=" + rr.attempted + " adopted=" + rr.adopted + " recovered=" + rr.recovered + " " + JSON.stringify(rr.results));
  process.exit(rr.attempted === rr.recovered ? 0 : 1);
}

// ---------------- DRY: report eligibility + matches only (no writes, no recovery) ----------------
const today = String(pf.today || "");
const cycle = await getSyncCycleByBucketDate(bucket, today);
if (!cycle || !cycle.id) { log("no (" + bucket + ", " + today + ") cycle -> nothing to reconcile."); process.exit(0); }

const evidenceBundle = pf.evidence || {};
const coverageByAccountId = {};
for (const a of pf.accounts || []) coverageByAccountId[a.accountId] = [...((evidenceBundle.oliCoverageByAccountId || {})[a.accountId] || [])];
const plan = bucketSync.planBucketSourceSync({
  apiKey: process.env.DATADOE_API_KEY, bucket, accounts: pf.accounts || [],
  existingMembership: pf.membership, coverageByAccountId,
  catalogCarrierSeller: pf.catalogCarrierSeller || null,
  catalogSnapshot: evidenceBundle.catalogSnapshot || null,
  fbaSnapshotsByAccount: evidenceBundle.fbaSnapshotsByAccount || {},
  asOf: pf.asOf, today: pf.today,
});
const plannedOliJobs = ((plan.families || []).find((f) => f.sourceKey === OLI_SOURCE_KEY) || {}).plannedJobs || [];
const oliSourceId = sourceContractForKey(OLI_SOURCE_KEY).ids[0];
const primary = getDataDoeConnections().find((c) => c && c.id === "primary");
const store = makeSupabaseSourceStore({ deadline: dl });
const jobs = await store.listSourceJobsWithMeta(String(cycle.id));
const eligible = jobs.filter((j) => reconcileEligibility(j).eligible);
log("eligible failed create-stage OLI jobs: " + eligible.length);
if (eligible.length) {
  const listExports = async () => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const r = await fetch("https://api.datadoe.com/api/v1/exports?pageSize=25", { headers: { "datadoe-api-key": primary.apiKey } });
        if (r.ok) return ((await r.json()).data) || [];
        if (attempt >= 5) throw new Error("DataDoe exports list failed (" + r.status + ")");
      } catch (e) { if (attempt >= 5) throw e; }
      await new Promise((res2) => setTimeout(res2, 8000 * attempt));
    }
  };
  const exports = await listExports();
  for (const row of eligible) {
    const hash = String(row.request_hash || "");
    const p0 = plannedOliJobs.find((p) => String(p.requestHash ?? p.request_hash) === hash);
    const sellers = p0 && p0.fetchParams ? (p0.fetchParams.sellerOrVendorIds || []) : [];
    const meta = row.request_meta || {};
    const m = matchExportForFailedCreate({ windowFrom: meta.from, windowTo: meta.to, sellerIds: sellers, exports, oliSourceId });
    log("  " + hash.slice(0, 12) + " window=" + String(meta.from) + ".." + String(meta.to) + " sellers=" + sellers.length + " -> " + m.disposition);
  }
}
log("DRY RUN complete (no writes). Re-run with --apply to adopt + recover.");
process.exit(0);
