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
import { accountInScope, isRoutingScope } from "../../lib/server/sync/scheduler-scope.js";

loadReleaseEnv();

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const bucket = argOf("bucket");
const requestedAsOf = argOf("requested-as-of") || argOf("as-of");
const refreshMode = argOf("refresh-mode") || "normal";
const runId = argOf("run-id");
if (!isRoutingScope(bucket)) { console.error("STOP --bucket must be a routing scope (india|europe-au|us-ca|us|non-us; got: " + bucket + ")"); process.exit(2); }
if (!requestedAsOf || !/^\d{4}-\d{2}-\d{2}$/.test(requestedAsOf)) { console.error("STOP --requested-as-of must be YYYY-MM-DD (got: " + requestedAsOf + ")"); process.exit(2); }

const { getDataDoeConnections, classifyDirectoryAccounts } = await import("../../lib/server/datadoe-connections.js");
const { fetchAccounts } = await import("../../lib/server/datadoe.js");
const { buildBucketSourceSyncRuntime } = await import("../../lib/server/sync/source-bucket-sync-runtime.js");
const { getSyncCycleByBucketDate, getSyncSourceJobs, getSyncSourceJobOwnersForCycle, getSourceCoverageWindows, openSupersedingSyncCycle, reserveOliFreshnessCreate, recordOliFreshnessExport, getOliCompleteness } = await import("../../lib/server/supabase.js");
const { OLI_SOURCE_KEY, windowsProve } = await import("../../lib/server/sync/source-durable-model.js");
const { classifyScheduledOliCycle, assessScheduledOliCycle, assessDurableOliCoverageComplete, oliBucketPlan, OLI_TOKENS_PER_CREATE } = await import("../../lib/server/sync/source-scheduled-oli.js");
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
for (const a of active) { const id = String((a && (a.accountId ?? a.id)) || "").trim(); const country = String((a && a.country) || "").toUpperCase(); if (!id || id.includes(":") || seen.has(id)) continue; if (!accountInScope(bucket, country)) continue; seen.add(id); discovered.push({ accountId: id }); }
if (!discovered.length) { console.error("STOP no discovered " + bucket + " primary accounts"); process.exit(1); }
const ids = discovered.map((a) => a.accountId);
const oliStart = sourceRegistryEntry(OLI).initialBackfill.start;
const orgFp = primaryConn.organizationFingerprint || organizationFingerprint(primaryConn.apiKey);
const plan = oliBucketPlan(discovered);

// Read durable OLI coverage -> which accounts are behind D-1? (used for the classifier + the escalation set)
async function coverageState() {
  const coverageByAccountId = {}; const missing = [];
  for (const id of ids) { let w = null; try { const cov = await getSourceCoverageWindows({ organizationFingerprint: orgFp, connectionId: "primary", accountId: id, sourceKey: OLI }); w = cov && cov.read === "ok" ? (cov.windows || []) : null; } catch { w = null; } coverageByAccountId[id] = w; let proven = false; try { proven = w != null && windowsProve(w, oliStart, requestedAsOf) === true; } catch { proven = false; } if (!proven) missing.push(id); }
  const durable = assessDurableOliCoverageComplete({ discoveredAccounts: discovered, coverageByAccountId: Object.fromEntries(ids.map((id) => [id, coverageByAccountId[id] || []])), start: oliStart, asOf: requestedAsOf });
  return { coverageByAccountId, missing, durableComplete: durable.complete, anyUnreadable: ids.some((id) => coverageByAccountId[id] == null) };
}

let cov0 = await coverageState();
// Create/token ceiling = the steady <=5-seller batch count PLUS one create per account behind D-1. Rationale:
// planOliSliceExports scopes each export to batch members sharing a contiguous MISSING window, so a batch holding
// an account behind D-1 (heterogeneous coverage -- normal settlement lag, or a fresh region cycle's first run)
// SPLITS into an extra slice for that account. This headroom is bounded (<= discovered accounts), keeps steady
// state (0 behind) byte-identical to the old expectedBatches ceiling, and never enables runaway. Legacy us/non-us
// steady-state runs are unchanged; a region's first run (or any lagged day) can now complete instead of tripping
// a false TOKEN_CEILING_EXCEEDED.
const ceilingCreates = plan.maxCreates + cov0.missing.length;
const ceilingTokens = ceilingCreates * OLI_TOKENS_PER_CREATE;
log(cov0.missing.length + "/" + ids.length + " account(s) behind D-1 (unreadable=" + cov0.anyUnreadable + "); create ceiling=" + ceilingCreates + " (" + plan.maxCreates + " batches + " + cov0.missing.length + " behind)");
if (cov0.durableComplete) { log("ALREADY_PUBLISHED_D1: durable coverage complete through D-1 -- ZERO creates, ZERO tokens (idempotent primary/fallback no-op)."); console.log("RESULT " + JSON.stringify({ ok: true, bucket, requestedAsOf, classification: "ALREADY_PUBLISHED_D1", creates: 0, tokens: 0, d1Complete: true, alreadyComplete: true })); process.exit(0); }
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
  if (cls.disposition === "idempotent-complete") { log("ALREADY_PUBLISHED_D1: idempotent D-1 complete; ZERO creates, ZERO tokens."); console.log("RESULT " + JSON.stringify({ ok: true, bucket, requestedAsOf, classification: "ALREADY_PUBLISHED_D1", creates: 0, tokens: 0, d1Complete: true })); process.exit(0); }
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
const blockedCodes = {}; // account-block reasons: OLI_D1_PENDING_ITEMIZATION (Amazon item-level lag) | OLI_ITEMIZED_VALUE_MISSING (real defect) | OLI_ORDER_STATUS_MISSING
const itemz = { resolved: 0, pending: 0, notItemized: 0, presale: 0, defect: 0, pctByAccount: [] }; // itemization diagnostics across held/blocked accounts
while (iter < MAX_ITERS) {
  iter += 1;
  const res = await runtime.runSourceCardAction({ bucket, sourceKey: OLI, forceFreshOli: true, deadline, preflight });
  if (res && res.refused === true) { console.error("STOP runSourceCardAction refused: " + (res.code || "unknown")); process.exit(1); }
  for (const b of (res && Array.isArray(res.blockedAccounts) ? res.blockedAccounts : [])) {
    const code = String(b.code || "unknown"); blockedCodes[code] = (blockedCodes[code] || 0) + 1;
    const d = b && b.detail;
    if (d && typeof d === "object") {
      itemz.resolved += Number(d.resolved || 0); itemz.pending += Number(d.pending || 0);
      itemz.notItemized += Number(d.notItemized || 0); itemz.presale += Number(d.presalePending || 0);
      itemz.defect += Number(d.defect || 0);
      if (d.latestItemizedPct != null) itemz.pctByAccount.push(Number(d.latestItemizedPct));
    }
  }
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
const a = assessScheduledOliCycle({ bucket, discoveredAccounts: discovered, sourceJobs: jobsF, owners: ownersF, open: await oliOpen(workingCycleId), extraCreatesHeadroom: cov0.missing.length });
const d1Complete = cov1.missing.length === 0;
// PRECISE, PROVEN not-ready reason (never a vague "settlement delay"). A genuinely fresh D-1 export was fetched
// (forceFreshOli), but coverage did not advance for some accounts. The item_status classifier separates two cases:
//   - OLI_D1_PENDING_ITEMIZATION: the D-1 orders EXIST but Amazon has not yet populated their per-line item detail
//     (item_status / item_price_value are genuinely null in the raw source ~1-2 days after placement). This is an
//     expected, transient item-level lag -- an HONEST wait (LKG retained); the next refresh advances D-1 as Amazon
//     itemizes. NOT a stale-cycle block, NOT our code, NOT a fabricatable value.
//   - OLI_ITEMIZED_VALUE_MISSING: an itemized recognized-sale with a genuinely null value -> a REAL source-data
//     defect on that account (investigate; do not publish).
const realDefect = Number(blockedCodes.OLI_ITEMIZED_VALUE_MISSING || 0);
// BUSINESS MODEL: pending itemization NO LONGER holds. The real itemized D-1 data PUBLISHES immediately, labelled
// PROVISIONAL while some order shells are not yet itemized; it promotes to FINAL as Amazon itemizes. Read the
// two-layer completeness the sync just recorded for the requested D-1 date and classify the bucket run:
//   D1_FINAL       every account's D-1 is fully itemized;
//   D1_PROVISIONAL some account's D-1 has pending order shells (expected item-level lag) -- a SUCCESS, GREEN run;
//   SOURCE_DEFECT  an itemized recognized-sale had a null value (that account keeps LKG; escalate).
let provisional = 0, final = 0, sourceDefect = 0, itemizedOrders = 0, pendingOrders = 0, pendingUnits = 0;
try {
  const rows = await getOliCompleteness({ organizationFingerprint: orgFp, connectionId: "primary", accountIds: ids, from: requestedAsOf, to: requestedAsOf });
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (r.completeness_status === "provisional") provisional += 1;
    else if (r.completeness_status === "final") final += 1;
    else if (r.completeness_status === "source-defect") sourceDefect += 1;
    itemizedOrders += Number(r.itemized_order_count) || 0;
    pendingOrders += Number(r.pending_order_count) || 0;
    pendingUnits += Number(r.pending_unit_count) || 0;
  }
} catch (e) { log("completeness read failed: " + (e && e.message ? e.message : e)); }
const totOrders = itemizedOrders + pendingOrders;
const overallPct = totOrders > 0 ? Math.round((itemizedOrders / totOrders) * 1000) / 10 : 100;
const classification = sourceDefect > 0 || realDefect > 0 ? "SOURCE_DEFECT" : (provisional > 0 ? "D1_PROVISIONAL" : "D1_FINAL");
log("D-1 completeness: " + classification + " -- " + final + " final + " + provisional + " provisional + " + (sourceDefect || realDefect) + " source-defect of " + ids.length + " accounts; " + overallPct + "% orders itemized (" + itemizedOrders + " itemized / " + pendingOrders + " pending, " + pendingUnits + " pending units)"
  + (provisional > 0 ? " -- provisional D-1 PUBLISHES now; sales/ratios increase automatically as Amazon itemizes (never a fabricated value)" : "")
  + (realDefect ? " -- WARNING " + realDefect + " itemized-value defect account(s) keep LKG (escalate to DataDoe)" : ""));
if (Object.keys(blockedCodes).length) log("fresh-fetch defect/status blocks: " + JSON.stringify(blockedCodes));
log("assessment: creates=" + a.creates + "/" + a.ceilingCreates + " tokens=" + a.tokens + "/" + a.ceilingTokens + " ok=" + a.ok + " | coverage behind D-1: " + cov1.missing.length + "/" + ids.length);
console.log("RESULT " + JSON.stringify({ ok: a.ok, bucket, requestedAsOf, operationKey, workingCycle: workingCycleId.slice(0, 8), creates: a.creates, tokens: a.tokens, ceilingTokens, classification, d1Complete, coverageBehindD1: cov1.missing.length, completeness: { provisional, final, sourceDefect: sourceDefect || realDefect, itemizedOrders, pendingOrders, pendingUnits, overallItemizedPct: overallPct }, blockedCodes, realDefect: realDefect > 0 }));
if (!a.ok) { console.error("STOP OLI assessment FAILED: " + a.problems.join(", ")); process.exit(1); }
// GREEN exit for provisional: expected pending itemization is a SUCCESS (D1_PROVISIONAL publishes now), never a red run.
process.exit(0);
