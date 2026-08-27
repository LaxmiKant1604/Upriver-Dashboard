// TRUSTED, DEFERRED D-1 OLI refresh operator for ONE bucket. Usage (run from sales-dashboard-live/, in the
// GitHub scheduler OR the admin Data Sync Center backend):
//   node scripts/release/oli-refresh-d1.mjs --bucket=us|non-us --requested-as-of=YYYY-MM-DD --refresh-mode=normal|force-latest [--run-id=<github.run_id>]
//
// It guarantees a GENUINE attempt at the previous day (D-1), decoupling cycle-completion from source-freshness:
//   - no cycle / running / pending head        -> run the ordinary OLI drain on it.
//   - TERMINAL head + coverage complete THRU D-1 -> idempotent D-1 complete (ZERO creates).
//   - TERMINAL head + coverage BELOW D-1        -> the terminal cycle is STALE evidence: open a durable SUPERSEDING
//                                                  running attempt (never mutating the terminal one) and re-fetch
//                                                  FRESH OLI (forceFreshOli bypasses the stale 20h cache).
//   - unreadable coverage / ambiguous head      -> fail closed BEFORE any create.
// After the drain, if any account is still behind D-1, it AUTOMATICALLY escalates ONE bounded fresh re-fetch of only
// the still-missing <=5-seller batches (durable freshness reservation; idempotent by operation identity). The whole
// run stays within the per-bucket create/token ceiling (Non-US 5 creates/10 tokens, US 2/4) across normal + forced
// work. It NEVER reopens/resets/mutates a terminal cycle, NEVER retries an ambiguous create, and preserves the LKG.

import pg from "pg";
import { loadReleaseEnv } from "./env-bootstrap.mjs";

loadReleaseEnv();

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const bucket = argOf("bucket");
const requestedAsOf = argOf("requested-as-of") || argOf("as-of");
const refreshMode = argOf("refresh-mode") || "normal";
const runId = argOf("run-id");
if (bucket !== "us" && bucket !== "non-us") { console.error("STOP --bucket must be us|non-us (got: " + bucket + ")"); process.exit(2); }
if (!requestedAsOf || !/^\d{4}-\d{2}-\d{2}$/.test(requestedAsOf)) { console.error("STOP --requested-as-of must be YYYY-MM-DD (got: " + requestedAsOf + ")"); process.exit(2); }

const { getDataDoeConnections, classifyDirectoryAccounts } = await import("../../lib/server/datadoe-connections.js");
const { fetchAccounts } = await import("../../lib/server/datadoe.js");
const { bucketForCountry } = await import("../../lib/server/sync/registry.js");
const { buildBucketSourceSyncRuntime } = await import("../../lib/server/sync/source-bucket-sync-runtime.js");
const { getSyncCycleByBucketDate, getSyncSourceJobs, getSyncSourceJobOwnersForCycle, getSourceCoverageWindows, openSupersedingSyncCycle, reserveOliFreshnessCreate, recordOliFreshnessExport } = await import("../../lib/server/supabase.js");
const { OLI_SOURCE_KEY, windowsProve } = await import("../../lib/server/sync/source-durable-model.js");
const { classifyScheduledOliCycle, assessScheduledOliCycle, assessDurableOliCoverageComplete, oliBucketPlan } = await import("../../lib/server/sync/source-scheduled-oli.js");
const { sourceRegistryEntry } = await import("../../lib/server/sync/source-registry.js");
const { organizationFingerprint } = await import("../../lib/server/source-identity.js");
const { freshnessOperationKey, attemptKindForMode } = await import("../../lib/server/sync/source-oli-freshness.js");
const { planForceLatestBatches, runOliForceLatest } = await import("../../lib/server/sync/source-oli-force-latest.js");

const OLI = OLI_SOURCE_KEY;
const log = (m) => console.log("oli-d1[" + bucket + "@" + requestedAsOf + "/" + refreshMode + "]: " + m);
const BUDGET_MS = Number(process.env.SCHEDULED_OLI_BUDGET_MS || 70 * 60 * 1000);
const MAX_ITERS = Number(process.env.SCHEDULED_OLI_MAX_ITERS || 200);
// A normal (scheduled) run carries NO run_id (its operation identity is scheduled-fresh/<bucket>/<asOf>); only a
// force-latest run uses the github.run_id. The workflow may always pass --run-id; it is ignored in normal mode.
const effRunId = refreshMode === "force-latest" ? runId : null;
const operationKey = freshnessOperationKey({ mode: refreshMode, bucket, requestedAsOf, runId: effRunId }); // validates mode + run_id
const attemptKind = attemptKindForMode(refreshMode);
log("operation key = " + operationKey);

// Discover EXACTLY this bucket's primary accounts (zero tokens).
const connections = getDataDoeConnections();
const primaryConn = connections.find((c) => c.id === "primary");
const rows = (await fetchAccounts(primaryConn.apiKey)) || [];
const { active } = classifyDirectoryAccounts(rows, connections);
const seen = new Set(); const discovered = [];
for (const a of active) { const id = String((a && (a.accountId ?? a.id)) || "").trim(); const country = String((a && a.country) || "").toUpperCase(); if (!id || id.includes(":") || seen.has(id)) continue; if (bucketForCountry(country) !== bucket) continue; seen.add(id); discovered.push({ accountId: id }); }
if (!discovered.length) { console.error("STOP no discovered " + bucket + " primary accounts"); process.exit(1); }
const ids = discovered.map((a) => a.accountId);
const oliStart = sourceRegistryEntry(OLI).initialBackfill.start;
const orgFp = primaryConn.organizationFingerprint || organizationFingerprint(primaryConn.apiKey);
const plan = oliBucketPlan(discovered);
const ceilingCreates = plan.maxCreates; const ceilingTokens = plan.maxTokens;

// Read durable OLI coverage -> which accounts are behind D-1? (used for the classifier + the escalation set)
async function coverageState() {
  const coverageByAccountId = {}; const missing = [];
  for (const id of ids) { let w = null; try { const cov = await getSourceCoverageWindows({ organizationFingerprint: orgFp, connectionId: "primary", accountId: id, sourceKey: OLI }); w = cov && cov.read === "ok" ? (cov.windows || []) : null; } catch { w = null; } coverageByAccountId[id] = w; let proven = false; try { proven = w != null && windowsProve(w, oliStart, requestedAsOf) === true; } catch { proven = false; } if (!proven) missing.push(id); }
  const durable = assessDurableOliCoverageComplete({ discoveredAccounts: discovered, coverageByAccountId: Object.fromEntries(ids.map((id) => [id, coverageByAccountId[id] || []])), start: oliStart, asOf: requestedAsOf });
  return { coverageByAccountId, missing, durableComplete: durable.complete, anyUnreadable: ids.some((id) => coverageByAccountId[id] == null) };
}

let cov0 = await coverageState();
log(cov0.missing.length + "/" + ids.length + " account(s) behind D-1 (unreadable=" + cov0.anyUnreadable + ")");
if (cov0.durableComplete) { log("durable coverage ALREADY complete through D-1 -- ZERO creates."); console.log("RESULT " + JSON.stringify({ ok: true, bucket, requestedAsOf, creates: 0, tokens: 0, d1Complete: true, alreadyComplete: true })); process.exit(0); }
if (cov0.anyUnreadable) { console.error("STOP OLI coverage unreadable -- fail closed (never classify freshness without evidence)."); process.exit(1); }

// Classify the (bucket, today) ACTIVE head. A terminal head below D-1 => SUPERSEDE; a running/pending head => run.
const cycleDate = new Date().toISOString().slice(0, 10);
let head = null;
try { head = await getSyncCycleByBucketDate(bucket, cycleDate); }
catch (e) { console.error("STOP AMBIGUOUS_CYCLE_HEAD: " + (e && e.message)); process.exit(1); }
let workingCycleId = head && head.id ? String(head.id) : null;

const runtime = buildBucketSourceSyncRuntime({ budgetMs: BUDGET_MS, asOfOverride: requestedAsOf });
const deadline = runtime.makeDeadline();
const preflight = await runtime.preflightEvidence({ bucket, sourceKey: OLI, deadline });
const isOpen = (j) => { const st = j.fetch_status ?? j.fetchStatus; return st === "pending" || st === "attempted"; };
const oliOpen = async (cid) => (await getSyncSourceJobs(cid)).filter((j) => (j.source_key ?? j.sourceKey) === OLI && isOpen(j)).length;
const oliCreatesSoFar = async (cid) => { const jobs = (await getSyncSourceJobs(cid)).filter((j) => (j.source_key ?? j.sourceKey) === OLI); return jobs.reduce((n, j) => n + (Number(j.create_export_count ?? j.createExportCount) === 1 ? 1 : 0), 0); };

if (head && head.id) {
  const jobs = (await getSyncSourceJobs(workingCycleId)).filter((j) => (j.source_key ?? j.sourceKey) === OLI);
  const owners = await getSyncSourceJobOwnersForCycle(workingCycleId);
  const durableCoverage = { complete: cov0.durableComplete, missingAccounts: cov0.missing };
  const cls = classifyScheduledOliCycle({ bucket, cycle: head, discoveredAccounts: discovered, sourceJobs: jobs, owners, durableCoverage });
  log("head " + workingCycleId.slice(0, 8) + " status=" + head.status + " -> classification=" + cls.disposition + (cls.reason ? " (" + cls.reason + ")" : ""));
  if (cls.disposition === "refuse" || cls.disposition === "terminal-refuse") { console.error("STOP CYCLE_REFUSED (" + cls.reason + ") -- fail closed."); process.exit(1); }
  if (cls.disposition === "idempotent-complete") { log("idempotent D-1 complete; ZERO creates."); console.log("RESULT " + JSON.stringify({ ok: true, bucket, requestedAsOf, creates: 0, tokens: 0, d1Complete: true })); process.exit(0); }
  if (cls.disposition === "supersede") {
    // Open a durable SUPERSEDING running attempt on the same slot; the terminal cycle stays IMMUTABLE.
    let newId;
    try { newId = await openSupersedingSyncCycle({ bucket, cycleDate, operationKey, supersedesCycleId: workingCycleId, attemptKind }); }
    catch (e) { console.error("STOP SUPERSEDE_FAILED: " + (e && e.message)); process.exit(1); }
    workingCycleId = String(newId);
    log("SUPERSEDED terminal " + String(head.id).slice(0, 8) + " -> fresh attempt " + workingCycleId.slice(0, 8) + " (op=" + operationKey + ")");
  }
}
// else: no head -> a fresh base cycle is created by the runtime's head-aware openCycle on the first fetch.

// FRESH FETCH: run the OLI family (forceFreshOli bypasses the stale cache) on the ACTIVE head (the superseding
// attempt when we just created one, else the running/fresh base). Bounded resume until drained.
let iter = 0; let prevOpen = Infinity; let stall = 0;
const blockedCodes = {}; // account-blocking reasons from the fresh fetch (e.g. OLI_NON_CANCELLED_VALUE_MISSING = unpriced D-1 orders)
while (iter < MAX_ITERS) {
  iter += 1;
  const res = await runtime.runSourceCardAction({ bucket, sourceKey: OLI, forceFreshOli: true, deadline, preflight });
  if (res && res.refused === true) { console.error("STOP runSourceCardAction refused: " + (res.code || "unknown")); process.exit(1); }
  for (const b of (res && Array.isArray(res.blockedAccounts) ? res.blockedAccounts : [])) { const code = String(b.code || "unknown"); blockedCodes[code] = (blockedCodes[code] || 0) + 1; }
  const cid = (res && res.cycleId) || workingCycleId;
  workingCycleId = cid ? String(cid) : workingCycleId;
  if (!workingCycleId) { console.error("STOP no working cycle id after fetch"); process.exit(1); }
  const open = await oliOpen(workingCycleId);
  log("fresh OLI iter " + iter + ": cycle=" + workingCycleId.slice(0, 8) + " oli_open=" + open);
  if (open === 0) break;
  if (deadline && typeof deadline.outOfTime === "function" && deadline.outOfTime()) { log("deadline reached with open=" + open); break; }
  stall = open >= prevOpen ? stall + 1 : 0; prevOpen = open;
  if (stall >= 2) { log("no progress for 2 resumptions; stopping"); break; }
}

// Enforce the per-bucket create/token ceiling across ALL work on this attempt (normal + any forced).
let creates = await oliCreatesSoFar(workingCycleId);
if (creates > ceilingCreates) { console.error("STOP TOKEN_CEILING_EXCEEDED: " + creates + " creates > " + ceilingCreates + " (fail closed)."); process.exit(1); }

// Re-read coverage. If any account is STILL behind D-1, escalate ONE bounded forced re-fetch of the still-missing
// <=5-seller batches on THIS attempt (durable freshness reservation; idempotent by operation identity).
let cov1 = await coverageState();
if (cov1.missing.length && !cov1.anyUnreadable) {
  log("after fresh drain, still " + cov1.missing.length + " behind D-1 -> bounded escalation (missing batches only)");
  const jobs = (await getSyncSourceJobs(workingCycleId)).filter((j) => (j.source_key ?? j.sourceKey) === OLI);
  const owners = await getSyncSourceJobOwnersForCycle(workingCycleId);
  const batches = planForceLatestBatches({ missingAccounts: cov1.missing, oliJobs: jobs, owners });
  if (batches.length && creates < ceilingCreates) {
    const base = String(process.env.POSTGRES_URL).split("?")[0];
    const pgc = new pg.Client({ connectionString: base, ssl: { rejectUnauthorized: false } });
    await pgc.connect();
    const deps = {
      reserve: async (hash) => reserveOliFreshnessCreate(operationKey, hash),
      reopenJob: async (hash) => { const r = await pgc.query(`update public.sync_source_jobs j set fetch_status='pending', export_id=null, create_export_count=0, cache_object_path=null, terminal=false, error_stage=null, error_code=null, updated_at=now() from public.sync_cycles c where j.cycle_id=c.id and c.id=$1 and c.status in ('running','pending') and j.request_hash=$2 and j.source_key='order-line-items' and j.fetch_status in ('succeeded','failed') and coalesce(j.terminal,false)=false`, [workingCycleId, hash]); return { reopened: r.rowCount === 1, reason: r.rowCount === 1 ? null : "not-reopenable" }; },
      runFreshOli: async () => { let it = 0; while (it < 20) { it += 1; const r = await runtime.runSourceCardAction({ bucket, sourceKey: OLI, forceFreshOli: true, deadline, preflight }); if (r && r.refused === true) throw new Error("refused:" + (r.code || "?")); if (await oliOpen(workingCycleId) === 0) break; if (deadline.outOfTime && deadline.outOfTime()) break; } },
      readJobExport: async (hash) => { const r = await pgc.query("select fetch_status, export_id from public.sync_source_jobs where cycle_id=$1 and request_hash=$2 and source_key='order-line-items' limit 1", [workingCycleId, hash]); return r.rows.length ? { status: String(r.rows[0].fetch_status), exportId: r.rows[0].export_id || null } : { status: "missing", exportId: null }; },
      record: async (hash, exportId, tokens) => recordOliFreshnessExport(operationKey, hash, exportId, tokens),
      log,
    };
    try { const esc = await runOliForceLatest({ operationKey, batches: batches.slice(0, Math.max(0, ceilingCreates - creates)), deps }); log("escalation: creates=" + esc.creates + " adopted=" + esc.adopted + " ambiguous=" + esc.ambiguous + " problems=" + esc.problems.length); }
    finally { try { await pgc.end(); } catch { /* ignore */ } }
    creates = await oliCreatesSoFar(workingCycleId);
    cov1 = await coverageState();
  }
}

// Final proof: assess the attempt's OLI + the D-1 coverage.
const jobsF = (await getSyncSourceJobs(workingCycleId)).filter((j) => (j.source_key ?? j.sourceKey) === OLI);
const ownersF = await getSyncSourceJobOwnersForCycle(workingCycleId);
const a = assessScheduledOliCycle({ bucket, discoveredAccounts: discovered, sourceJobs: jobsF, owners: ownersF, open: await oliOpen(workingCycleId) });
const d1Complete = cov1.missing.length === 0;
// PRECISE not-ready reason: a genuinely fresh D-1 export was fetched (creates>0), but coverage did not advance for
// some accounts. OLI_NON_CANCELLED_VALUE_MISSING means the D-1 orders EXIST but Amazon has not yet settled their
// PRICES (unpriced non-cancelled units) -- the value-missing policy correctly refuses to persist them as sales;
// the next rolling refresh advances D-1 once the prices settle. This is NOT a stale-cycle block and NOT a defect.
const valueMissing = Number(blockedCodes.OLI_NON_CANCELLED_VALUE_MISSING || 0);
if (Object.keys(blockedCodes).length) log("fresh-fetch block reasons: " + JSON.stringify(blockedCodes) + (valueMissing ? " -- D-1 orders exist but prices are UNSETTLED (unpriced non-cancelled units); honest not-ready, next refresh advances it" : ""));
log("assessment: creates=" + a.creates + "/" + a.ceilingCreates + " tokens=" + a.tokens + "/" + a.ceilingTokens + " ok=" + a.ok + " | STILL behind D-1: " + cov1.missing.length + "/" + ids.length);
console.log("RESULT " + JSON.stringify({ ok: a.ok, bucket, requestedAsOf, operationKey, workingCycle: workingCycleId.slice(0, 8), creates: a.creates, tokens: a.tokens, ceilingTokens, d1Complete, stillBehindD1: cov1.missing.length, blockedCodes, d1RowsUnsettled: valueMissing > 0 }));
if (!a.ok) { console.error("STOP OLI assessment FAILED: " + a.problems.join(", ")); process.exit(1); }
// exit 0 whether or not D-1 fully settled: the strict D-1 readiness gate downstream decides publish vs not-ready.
process.exit(0);
