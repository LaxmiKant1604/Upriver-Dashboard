// TRUSTED OPERATOR SCRIPT -- Non-US OLI download-only recovery (Phase 2).
//
// Runs the reviewed lib builder buildNonUsOliDownloadRecovery against the REAL Supabase store + DataDoe adapter.
// Every recovery constraint is FROZEN in the lib module (exact cycle / source / error shape / window / owners /
// five sellers); this script only supplies the collaborators and the RE-PLANNED canonical OLI jobs (the source of
// the batch fetchParams the download validation needs). It NEVER creates an export (the builder guards the
// adapter's create), NEVER touches any other cycle/source/report, and prints ONLY typed/aggregate evidence --
// never seller ids, export ids, payloads or secrets.
//
// This is an OPERATOR action requiring production access. It is NOT wired to any API route, card action or
// scheduler (those keep recoverFailedDownloads=false). Run manually only, after Codex sign-off:
//   node scripts/release/recover-nonus-oli-download.mjs
import { readFileSync } from "node:fs";

const repoRoot = "C:/Users/laxmi/Documents/Codex/2026-07-01/can/Upriver-Dashboard";
for (const line of readFileSync(repoRoot + "/.env.local", "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line); if (!m) continue;
  let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (process.env[m[1]] === undefined) process.env[m[1]] = v;
}
process.env.SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;

const { buildBucketSourceSyncRuntime } = await import("../../lib/server/sync/source-bucket-sync-runtime.js");
const { makeSupabaseSourceStore, makeDataDoeAdapter } = await import("../../lib/server/sync/source-sync-driver.js");
const bucketSync = await import("../../lib/server/sync/source-bucket-sync.js");
const { getDataDoeConnections } = await import("../../lib/server/datadoe-connections.js");
const { buildNonUsOliDownloadRecovery, NONUS_OLI_DOWNLOAD_RECOVERY, recoveryExitDecision } = await import("../../lib/server/sync/source-oli-recovery-operation.js");

const C = NONUS_OLI_DOWNLOAD_RECOVERY;
const runtime = buildBucketSourceSyncRuntime({ budgetMs: 550_000 });
const dl = runtime.makeDeadline();

// RE-PLAN the fixed Non-US bucket with the ACTUAL durable evidence, so the canonical OLI jobs (and the target
// request_hash) match the running cycle. Read-only: preflight + the pure planner issue no writes / no creates.
const pf = await runtime.preflightEvidence({ bucket: C.bucket, deadline: dl });
const coverageByAccountId = {};
for (const a of pf.accounts || []) coverageByAccountId[a.accountId] = [...((pf.oliCoverageByAccountId || {})[a.accountId] || [])];
const plan = bucketSync.planBucketSourceSync({
  apiKey: process.env.DATADOE_API_KEY, bucket: C.bucket, accounts: pf.accounts || [],
  existingMembership: pf.membership,
  coverageByAccountId,
  catalogSnapshot: pf.catalogSnapshot || null, fbaSnapshotsByAccount: pf.fbaSnapshotsByAccount || {},
  asOf: pf.asOf, today: pf.today,
});
const plannedOliJobs = ((plan.families || []).find((f) => f.sourceKey === C.sourceKey) || {}).plannedJobs || [];

const store = makeSupabaseSourceStore({ deadline: dl });
const dataDoe = makeDataDoeAdapter(getDataDoeConnections());
const op = buildNonUsOliDownloadRecovery({ store, dataDoe, plannedOliJobs });

const res = await op.run();
// Honest exit: 0 ONLY for a genuine recovered success; every non-success class prints typed/redacted evidence
// and exits NONZERO so release automation cannot continue past a refusal/failure.
const { code, ok, evidence } = recoveryExitDecision(res);
console.log("nonus-oli-download-recovery:", JSON.stringify({ ok, ...evidence }));
process.exit(code);
