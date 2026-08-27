// TRUSTED, DEFERRED operator: a BOUNDED "force latest" OLI re-fetch of the still-missing previous-day (D-1)
// rolling window for ONE bucket. Usage (run from sales-dashboard-live/, in the GitHub force-latest job or the
// admin Data Sync Center):
//   node scripts/release/oli-force-latest.mjs --bucket=us|non-us --requested-as-of=YYYY-MM-DD --run-id=<github.run_id>
//
// It re-queries DataDoe fresh (forceFreshOli skips the 20h stale-cache adoption) for ONLY the <=5-seller batches
// whose owners include a D-1-missing account, under the durable freshness reservation (one forced create per
// (operation_key, request_hash); idempotent by run_id; a new authorized run_id may re-attempt). It reopens each
// missing batch's OLI job to pending on the RUNNING cycle, runs ONE forced fresh pass, records each forced export,
// then re-reads coverage. It NEVER touches the other bucket, NEVER re-creates an ambiguous/committed export, NEVER
// exceeds the per-bucket batch ceiling, and PRESERVES the LKG on every failure. Prints counts/dates/8-char prefixes.

import pg from "pg";
import { loadReleaseEnv } from "./env-bootstrap.mjs";

loadReleaseEnv();

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const bucket = argOf("bucket");
const requestedAsOf = argOf("requested-as-of") || argOf("as-of");
const runId = argOf("run-id");
if (bucket !== "us" && bucket !== "non-us") { console.error("STOP --bucket must be us|non-us (got: " + bucket + ")"); process.exit(2); }
if (!requestedAsOf || !/^\d{4}-\d{2}-\d{2}$/.test(requestedAsOf)) { console.error("STOP --requested-as-of must be YYYY-MM-DD (got: " + requestedAsOf + ")"); process.exit(2); }

const { getDataDoeConnections, classifyDirectoryAccounts } = await import("../../lib/server/datadoe-connections.js");
const { fetchAccounts } = await import("../../lib/server/datadoe.js");
const { bucketForCountry } = await import("../../lib/server/sync/registry.js");
const { buildBucketSourceSyncRuntime } = await import("../../lib/server/sync/source-bucket-sync-runtime.js");
const { getSyncCycleByBucketDate, getSyncSourceJobs, getSyncSourceJobOwnersForCycle, getSourceCoverageWindows, reserveOliFreshnessCreate, recordOliFreshnessExport } = await import("../../lib/server/supabase.js");
const { OLI_SOURCE_KEY, windowsProve } = await import("../../lib/server/sync/source-durable-model.js");
const { sourceRegistryEntry } = await import("../../lib/server/sync/source-registry.js");
const { organizationFingerprint } = await import("../../lib/server/source-identity.js");
const { freshnessOperationKey } = await import("../../lib/server/sync/source-oli-freshness.js");
const { planForceLatestBatches, runOliForceLatest } = await import("../../lib/server/sync/source-oli-force-latest.js");

const OLI = OLI_SOURCE_KEY;
const log = (m) => console.log("oli-force-latest[" + bucket + "@" + requestedAsOf + "]: " + m);
const BUDGET_MS = Number(process.env.SCHEDULED_OLI_BUDGET_MS || 60 * 60 * 1000);

const operationKey = freshnessOperationKey({ mode: "force-latest", bucket, requestedAsOf, runId }); // validates run_id
log("operation key = " + operationKey);

// Discover EXACTLY this bucket's primary accounts (zero tokens).
const connections = getDataDoeConnections();
const primaryConn = connections.find((c) => c.id === "primary");
const rows = (await fetchAccounts(primaryConn.apiKey)) || [];
const { active } = classifyDirectoryAccounts(rows, connections);
const seen = new Set();
const discovered = [];
for (const a of active) { const id = String((a && (a.accountId ?? a.id)) || "").trim(); const country = String((a && a.country) || "").toUpperCase(); if (!id || id.includes(":") || seen.has(id)) continue; if (bucketForCountry(country) !== bucket) continue; seen.add(id); discovered.push({ accountId: id }); }
if (!discovered.length) { console.error("STOP no discovered " + bucket + " primary accounts"); process.exit(1); }
const ids = discovered.map((a) => a.accountId);

const oliStart = sourceRegistryEntry(OLI).initialBackfill.start;
const orgFp = primaryConn.organizationFingerprint || organizationFingerprint(primaryConn.apiKey);

// Read durable OLI coverage -> which accounts are still behind D-1 (requestedAsOf)?
const coverageByAccountId = {};
for (const id of ids) {
  try { const cov = await getSourceCoverageWindows({ organizationFingerprint: orgFp, connectionId: "primary", accountId: id, sourceKey: OLI }); coverageByAccountId[id] = cov && cov.read === "ok" ? (cov.windows || []) : null; }
  catch { coverageByAccountId[id] = null; }
}
const missingAccounts = ids.filter((id) => { const w = coverageByAccountId[id]; if (w == null) return true; try { return windowsProve(w, oliStart, requestedAsOf) !== true; } catch { return true; } });
log(missingAccounts.length + "/" + ids.length + " account(s) behind D-1 " + requestedAsOf + (missingAccounts.length ? "" : " -- already complete, ZERO creates"));
if (!missingAccounts.length) { console.log("RESULT " + JSON.stringify({ ok: true, bucket, requestedAsOf, creates: 0, tokens: 0, alreadyComplete: true })); process.exit(0); }

// The (bucket, today) cycle + its OLI jobs/owners.
const cycleDate = new Date().toISOString().slice(0, 10);
let cycle = null;
try { cycle = await getSyncCycleByBucketDate(bucket, cycleDate); }
catch (e) { console.error("STOP AMBIGUOUS_CYCLE: more than one " + bucket + " cycle for " + cycleDate + " -- refusing (fail closed): " + (e && e.message)); process.exit(1); }
if (!cycle || !cycle.id) { console.error("STOP NO_RUNNING_CYCLE: no " + bucket + " cycle for " + cycleDate + " -- run the normal OLI refresh first (fail closed)."); process.exit(1); }
const cycleId = String(cycle.id);
const cycleStatus = String(cycle.status);
if (cycleStatus !== "running" && cycleStatus !== "partial") {
  console.error("STOP CYCLE_NOT_REOPENABLE: " + bucket + " cycle " + cycleId.slice(0, 8) + " is " + cycleStatus + " (terminal); force-latest re-fetches only on a RUNNING cycle. A terminal cycle that already published D-1 has no missing accounts; a stale terminal publish must be reconciled first (fail closed).");
  process.exit(1);
}
const oliJobs = (await getSyncSourceJobs(cycleId)).filter((j) => (j.source_key ?? j.sourceKey) === OLI);
const owners = await getSyncSourceJobOwnersForCycle(cycleId);
const batches = planForceLatestBatches({ missingAccounts, oliJobs, owners });
log("force-latest batches: " + batches.length + " (of " + oliJobs.length + " OLI jobs)");
if (!batches.length) { console.error("STOP NO_MATCHING_BATCH: missing accounts have no OLI job in the cycle -- run the normal OLI refresh first (fail closed)."); process.exit(1); }

// Production collaborators for the reviewed orchestration.
const base = String(process.env.POSTGRES_URL).split("?")[0];
const pgc = new pg.Client({ connectionString: base, ssl: { rejectUnauthorized: false } });
await pgc.connect();

const runtime = buildBucketSourceSyncRuntime({ budgetMs: BUDGET_MS, asOfOverride: requestedAsOf });
const deadline = runtime.makeDeadline();
const preflight = await runtime.preflightEvidence({ bucket, sourceKey: OLI, deadline });

const deps = {
  // Reopen ONE succeeded/failed OLI job to pending on the RUNNING cycle (guarded; exactly one row).
  reopenJob: async (hash) => {
    const res = await pgc.query(
      `update public.sync_source_jobs j
          set fetch_status='pending', export_id=null, create_export_count=0, cache_object_path=null,
              terminal=false, error_stage=null, error_code=null, updated_at=now()
         from public.sync_cycles c
        where j.cycle_id = c.id and c.id = $1 and c.status in ('running','partial')
          and j.request_hash = $2 and j.source_key = 'order-line-items'
          and j.fetch_status in ('succeeded','failed') and coalesce(j.terminal,false) = false`,
      [cycleId, hash],
    );
    return { reopened: res.rowCount === 1, reason: res.rowCount === 1 ? null : "not-reopenable" };
  },
  reserve: async (hash) => reserveOliFreshnessCreate(operationKey, hash),
  runFreshOli: async () => {
    // ONE forced fresh OLI pass; forceFreshOli skips stale-cache adoption for the reopened pending jobs. Bounded
    // resume until the family drains (open===0) or the deadline is reached.
    let iter = 0;
    const isOpen = (j) => { const st = j.fetch_status ?? j.fetchStatus; return st === "pending" || st === "attempted"; };
    while (iter < 30) {
      iter += 1;
      const r = await runtime.runSourceCardAction({ bucket, sourceKey: OLI, forceFreshOli: true, deadline, preflight });
      if (r && r.refused === true) throw new Error("runSourceCardAction refused: " + (r.code || "unknown"));
      const open = (await getSyncSourceJobs(cycleId)).filter((j) => (j.source_key ?? j.sourceKey) === OLI && isOpen(j)).length;
      log("forced OLI pass iter " + iter + ": oli_open=" + open);
      if (open === 0) break;
      if (deadline && typeof deadline.outOfTime === "function" && deadline.outOfTime()) { log("deadline reached with open=" + open); break; }
    }
  },
  readJobExport: async (hash) => {
    const r = await pgc.query("select fetch_status, export_id from public.sync_source_jobs where cycle_id=$1 and request_hash=$2 and source_key='order-line-items' limit 1", [cycleId, hash]);
    if (!r.rows.length) return { status: "missing", exportId: null };
    return { status: String(r.rows[0].fetch_status), exportId: r.rows[0].export_id || null };
  },
  record: async (hash, exportId, tokens) => recordOliFreshnessExport(operationKey, hash, exportId, tokens),
  log,
};

let outcome;
try { outcome = await runOliForceLatest({ operationKey, batches, deps }); }
catch (e) { console.error("STOP force-latest failed: " + (e && e.message ? e.message : e)); try { await pgc.end(); } catch { /* ignore */ } process.exit(1); }
finally { /* pg closed below */ }

// Re-read coverage after the forced fetch -> did D-1 advance?
const stillMissing = [];
for (const id of missingAccounts) {
  try { const cov = await getSourceCoverageWindows({ organizationFingerprint: orgFp, connectionId: "primary", accountId: id, sourceKey: OLI }); const w = cov && cov.read === "ok" ? (cov.windows || []) : null; if (w == null || windowsProve(w, oliStart, requestedAsOf) !== true) stillMissing.push(id); }
  catch { stillMissing.push(id); }
}
try { await pgc.end(); } catch { /* ignore */ }

const d1Advanced = stillMissing.length === 0;
log("forced " + outcome.creates + " create(s) / " + outcome.tokens + " token(s); adopted " + outcome.adopted + "; ambiguous " + outcome.ambiguous + "; reopened " + outcome.reopened + "; STILL behind D-1 after fetch: " + stillMissing.length + "/" + ids.length);
console.log("RESULT " + JSON.stringify({
  ok: outcome.problems.length === 0 || outcome.creates > 0,
  bucket, requestedAsOf, operationKey,
  creates: outcome.creates, tokens: outcome.tokens, adopted: outcome.adopted, ambiguous: outcome.ambiguous,
  d1Advanced, stillMissing: stillMissing.length,
  provenThrough: d1Advanced ? requestedAsOf : "< " + requestedAsOf,
  problems: outcome.problems,
}));
// Exit 0 even when D-1 did not settle: a genuine bounded fresh attempt was made; the strict D-1 gate downstream
// (verify-bucket-readiness) decides publish vs DATADOE_D1_NOT_READY. A hard ambiguity with ZERO progress is nonzero.
if (outcome.creates === 0 && outcome.adopted === 0 && outcome.problems.length) { process.exit(1); }
process.exit(0);
