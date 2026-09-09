// TRUSTED, DEFERRED operator runner for the Daily Reporting + Brand View priority release.
// Usage:  node scripts/release/priority-dashboards-release.mjs   (run from sales-dashboard-live/, AFTER Codex
// sign-off AND after migration 20260825 is applied via the guarded release step). It NEVER applies a migration,
// NEVER pushes/deploys, NEVER enables the scheduler/cron, and NEVER touches unrelated reports.
//
// It only WIRES production collaborators into the reviewed, offline-tested orchestrator
// (runPriorityDashboardsRelease): a read-only reconciliation, the trusted composition (derive US then Non-US,
// finalize each exact cycle), a per-(report, account) publication-gate read-proof BEFORE any live write, the
// ordered publish (brand-sales before brand-inventory), and a live-identity read-back with the frontend payload
// contract. It exits NONZERO on every derive/finalize/publish disposition except a proven success.

import pg from "pg";
import { loadReleaseEnv } from "./env-bootstrap.mjs";
import { isRoutingScope } from "../../lib/server/sync/scheduler-scope.js";

loadReleaseEnv(); // portable: loads <repoRoot>/.env.local when present, maps SUPABASE_URL, never overrides CI env

const { buildPriorityDashboardsRelease, PRIORITY_DASHBOARDS } = await import("../../lib/server/sync/source-priority-dashboards.js");
const { runPriorityDashboardsRelease, buildLiveReadback } = await import("../../lib/server/sync/source-priority-release-runner.js");
const { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } = await import("../../lib/server/sync/report-publisher.js");
const { REPORT_DERIVATIONS } = await import("../../lib/server/sync/report-derivation.js");
const { paramsHashFor } = await import("../../lib/server/report-store.js");
const sb = await import("../../lib/server/supabase.js");

// Optional --as-of=YYYY-MM-DD: pin the derive window's asOf to the last proven durable-OLI covered_to day when
// the wall clock has drifted past it (NO new OLI fetch; the cycle date stays clock-today). Validated here too.
// The SCHEDULER passes the bucket's honestly-proven effectivePublishAsOf here so the published snapshots carry
// that exact coversAsOf; the derive independently re-clamps (belt + suspenders) and will agree.
const asOfArg = (process.argv.find((a) => a.startsWith("--as-of=")) || "").split("=")[1] || null;
if (asOfArg != null && !/^\d{4}-\d{2}-\d{2}$/.test(asOfArg)) { console.error("STOP --as-of must be YYYY-MM-DD (got: " + asOfArg + ")"); process.exit(2); }
if (asOfArg) console.log("priority-release: asOf pinned to " + asOfArg + " (derive window; cycle date stays clock-today).");

// Optional --bucket=us|non-us: publish EXACTLY that one bucket's accounts (Scheduler v2 independent buckets),
// preserving the OTHER bucket's latest-known-good snapshots byte-identically. Omitted => the legacy combined
// US+Non-US release (both buckets published together). The account scope is discovered + verified INTERNALLY by
// the composition (deriveBucket/finalizeBucket) -- never accepted from this flag beyond the bucket name.
const bucketArg = (process.argv.find((a) => a.startsWith("--bucket=")) || "").split("=")[1] || null;
if (bucketArg != null && !isRoutingScope(bucketArg)) { console.error("STOP --bucket must be a routing scope (india|europe-au|us-ca|us|non-us; got: " + bucketArg + ")"); process.exit(2); }
if (bucketArg) console.log("priority-release: scope = " + bucketArg + " ONLY (every other scope's snapshots are preserved untouched).");

// HEALTHY-SUBSET publication (Codex per-account isolation): when the OLI outcome is a PARTIAL, the workflow passes the
// EXACT eligible (healthy) account ids here. The release then discovers EXACTLY that subset (a fetchAccounts override
// that filters the real directory to those ids -- the account objects keep full marketplace metadata for routing) and
// derives/finalizes/publishes into a DEDICATED cycle bucket derived from the region + the sorted eligible membership
// (mirrors bootstrap's dedicated cycle) so the natural daily (region, today) cycle is NEVER finalized with a partial
// set. Deferred accounts are simply out of scope: their dated LKG snapshots are untouched. Omitted => whole-region
// natural-cycle publication (byte-identical). Requires --bucket (the region the subset belongs to).
const eligibleArg = ((process.argv.find((a) => a.startsWith("--eligible-accounts=")) || "").split("=").slice(1).join("=") || "").trim();
let subsetFetchAccounts = null; let subsetCycleBucket = null;
if (eligibleArg !== "") {
  if (!bucketArg) { console.error("STOP --eligible-accounts REQUIRES --bucket (the region the healthy subset belongs to)."); process.exit(2); }
  // Healthy-subset publication is REGION-scoped (india|europe-au|us-ca) -- the ONLY regions the priority-partial cycle
  // namespace + migration 20260924 regex permit. isRoutingScope also accepts the legacy us|non-us buckets, which the
  // regex does NOT, so reject them HERE (before building the bucket or any write) rather than passing the general-
  // namespace preflight and then hard-crashing on openCycle after a lease write. Fail closed, ZERO writes.
  if (!["india", "europe-au", "us-ca"].includes(bucketArg)) {
    console.error("STOP PRIORITY_PARTIAL_REGION_UNSUPPORTED: healthy-subset publication is region-scoped (india|europe-au|us-ca); got --bucket=" + bucketArg + " -- fail closed (ZERO publication-control/lease/cycle/reservation/publication writes; source refresh already ran independently).");
    process.exit(2);
  }
  const wanted = [...new Set(eligibleArg.split(",").map((s) => s.trim()).filter(Boolean))].sort();
  if (wanted.length === 0) { console.error("STOP --eligible-accounts was provided but parsed empty (fail closed)."); process.exit(2); }
  const wantedSet = new Set(wanted);
  const { sha256 } = await import("../../lib/server/source-identity.js");
  const { fetchAccounts: fetchDirectory } = await import("../../lib/server/datadoe.js");
  // Deterministic dedicated cycle bucket: the SAME eligible set (a watchdog replay) resolves the SAME cycle (idempotent);
  // a DIFFERENT eligible set (readiness advanced) gets its own cycle -- neither ever touches the natural daily cycle.
  // Format priority-partial-<region>-<16 hex> matches the CHECK/open_sync_cycle regex added by migration 20260924
  // (a DISTINCT namespace from bootstrap-<region>-<16hex>; never a disguised bootstrap cycle).
  subsetCycleBucket = "priority-partial-" + bucketArg + "-" + sha256(JSON.stringify(wanted)).slice(0, 16);
  subsetFetchAccounts = async (apiKey) => {
    const rows = (await fetchDirectory(apiKey)) || [];
    return rows.filter((r) => wantedSet.has(String((r && (r.accountId ?? r.account_id ?? r.id)) || "").trim()));
  };
  // PRODUCTION-SCHEMA PREFLIGHT (read-only, fail-closed; DEFENSE IN DEPTH -- the workflow ALSO runs this exact check
  // BEFORE opening publication controls). The priority-partial namespace is permitted ONLY once the approval-gated
  // migration 20260924 widens BOTH open_sync_cycle's EXACT-signature guard AND the sync_cycles_bucket_check constraint
  // to contain the exact priority-partial regex -- verified by the SHARED readPartialCycleCapability (never "any
  // pg_proc whose text mentions priority-partial"). Missing OR unreadable => STOP before ANY publication-control /
  // lease / cycle / reservation / publication write (those have not happened yet at this point; the earlier OLI/
  // Campaign SOURCE refreshes already ran independently and are unaffected -- this is NOT an overall zero-write claim).
  {
    const { readPartialCycleCapability } = await import("../../lib/server/sync/priority-partial-capability.js");
    const probe = new pg.Client({ connectionString: String(process.env.POSTGRES_URL).split("?")[0], ssl: { rejectUnauthorized: false } });
    let cap = { permitted: false, reason: "capability-unreadable: connect failed" };
    try {
      await probe.connect();
      cap = await readPartialCycleCapability((sql) => probe.query(sql).then((r) => r.rows));
    } catch (e) { cap = { permitted: false, reason: "capability-unreadable: " + (e && e.message ? e.message : e) }; }
    finally { try { await probe.end(); } catch { /* ignore */ } }
    if (!cap.permitted) {
      console.error("STOP PRIORITY_PARTIAL_MIGRATION_PENDING: the priority-partial cycle namespace ('" + subsetCycleBucket
        + "') is NOT yet permitted by the production schema (" + cap.reason + "). Apply the approval-gated migration"
        + " 20260924_priority_partial_cycle_bucket.sql (MIGRATE_ONLY) first. Healthy-subset publication is DEFERRED (the"
        + " healthy + deferred accounts keep their dated last-known-good); ZERO publication-control/lease/cycle/reservation/"
        + "publication writes (the earlier source refresh already ran independently).");
      process.exit(1);
    }
  }
  console.log("priority-release: HEALTHY-SUBSET publication of " + wanted.length + " eligible account(s) in " + bucketArg
    + " into dedicated cycle bucket '" + subsetCycleBucket + "' (deferred accounts keep dated LKG, out of scope; natural daily cycle untouched).");
}

// --strict-d1: FAIL CLOSED (DATADOE_D1_NOT_READY, never publish) if the derive clamps effectivePublishAsOf below the
// requested D-1 (--as-of). The scheduler passes it so a lagged/regressed bucket keeps its LKG instead of publishing D-2.
const strictD1 = process.argv.includes("--strict-d1");
if (strictD1) console.log("priority-release: --strict-d1 (a derive that clamps below the requested D-1 fails closed; LKG retained).");
// Optional --operation-key: the Catalog reservation key. Default = the historical v2 go-live key; an AUTOMATIC
// scheduled run passes "priority-dashboards/scheduled/YYYY-MM-DD" so each date owns its one-Catalog-create
// reservation. buildPriorityDashboardsRelease validates it STRICTLY (any other shape fails closed).
const opKeyArg = (process.argv.find((a) => a.startsWith("--operation-key=")) || "").split("=").slice(1).join("=") || null;
if (opKeyArg) console.log("priority-release: catalog operation key = " + opKeyArg);
// Round-9/10/11 P0-A + property 11: the control-plane run token + the EXACT generation whose controls were
// opened by the SEPARATE --apply (full_controls) step. Both are REQUIRED for publication: this run RENEWS that
// immutable fence (owner_token + --owner-generation) -- it NEVER re-acquires -- so EVERY report write fences the
// exact apply generation at the report_snapshots write boundary. An expired/mismatched fence is CONTROL_LEASE_LOST
// (zero writes), so we STOP rather than publish under another generation's controls.
const runToken = ((process.argv.find((a) => a.startsWith("--run-token=")) || "").split("=").slice(1).join("=") || "").trim();
if (!runToken) { console.error("STOP --run-token is REQUIRED for publication (the control fence; the separate --apply step opened the controls under this token)."); process.exit(2); }
const rawOwnerGen = ((process.argv.find((a) => a.startsWith("--owner-generation=")) || "").split("=").slice(1).join("=") || "").trim();
const ownerGeneration = /^\d+$/.test(rawOwnerGen) ? Number(rawOwnerGen) : NaN;
if (!(Number.isSafeInteger(ownerGeneration) && ownerGeneration > 0)) { console.error("STOP --owner-generation is REQUIRED for publication (a positive integer: the EXACT generation the matching --apply emitted)."); process.exit(2); }
let leaseFence = null;
let release;
try {
  // Resolve the BASE cycle (the one that owns the shared Product Catalog job), not the OLI-only superseding HEAD --
  // so the release's Catalog reservation + finalize verification target the cycle that actually carries the catalog.
  release = buildPriorityDashboardsRelease({ asOfOverride: asOfArg, ...(opKeyArg ? { operationKey: opKeyArg } : {}), getCycleByBucketDate: sb.getBaseSyncCycleByBucketDate, getControlFence: () => leaseFence, ...(subsetFetchAccounts ? { fetchAccounts: subsetFetchAccounts, cycleBucket: subsetCycleBucket } : {}) });
} catch (e) { console.error("STOP " + (e && e.message ? e.message : e)); process.exit(2); }

// A dedicated read-only pg client for the cron proof (never mutates).
const pgBase = String(process.env.POSTGRES_URL).split("?")[0];
const makePgReadOnly = () => new pg.Client({ connectionString: pgBase, ssl: { rejectUnauthorized: false } });

async function assertNoCron() {
  const client = makePgReadOnly();
  try {
    await client.connect();
    const t = await client.query("select to_regclass('cron.job')::text cron_table");
    if (!t.rows[0].cron_table) return { ok: true };
    const n = await client.query("select count(*)::int n from cron.job where command ilike '%scheduler%' or command ilike '%sync%' or command ilike '%priority%'");
    return n.rows[0].n === 0 ? { ok: true } : { ok: false, reason: "scheduler cron present (" + n.rows[0].n + ")" };
  } catch (e) { return { ok: false, reason: "cron read failed: " + (e && e.message) }; }
  finally { try { await client.end(); } catch { /* ignore */ } }
}

// READ-ONLY reconciliation: the scheduler must be OFF (all_primary=false) and no cron -- nothing is mutated.
async function reconcile() {
  const cron = await assertNoCron();
  if (!cron.ok) return { ok: false, problems: [cron.reason] };
  try {
    const rollout = await sb.getSchedulerAccountRollout();
    if (!rollout || rollout.read !== "ok" || rollout.allPrimary === true) return { ok: false, problems: ["scheduler rollout not read-ok / all_primary=true"] };
    return { ok: true };
  } catch (e) { return { ok: false, problems: ["reconcile read failed: " + (e && e.message)] }; }
}

// The publication gates are read-proven by the composition's SHARED publisher preflight (release.preflightAccount)
// -- the SAME collaborators + logic as the real publish -- so the CLI duplicates NO gate logic here. The
// EXACT-identity live read-back is the reviewed buildLiveReadback wired to the production readers.
const readbackLive = buildLiveReadback({
  getReportSnapshot: sb.getReportSnapshot,
  loadStoragePayload: sb.getReportSnapshotStoragePayload,
  liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS,
  reportDerivations: REPORT_DERIVATIONS,
  computeHash: paramsHashFor,
});

// Round-11 P0-A: RENEW the SUPPLIED immutable apply fence (owner_token + --owner-generation). NEVER re-acquire:
// if the apply lease lapsed or another generation took over, renew returns non-'renewed' -> CONTROL_LEASE_LOST,
// publish nothing (never adopt/read-back/replace the generation). Then heartbeat that exact fence per account.
let verifyLease;
{
  try {
    const r = await sb.renewControlPlaneLease({ ownerToken: runToken, generation: ownerGeneration, ttlSeconds: 900 });
    if (!r || r.disposition !== "renewed") {
      console.error("STOP CONTROL_LEASE_LOST: could not RENEW the apply fence (owner " + String(runToken).slice(0, 16) + " gen " + ownerGeneration + " -> " + String(r && (r.reason || r.disposition)) + ") -- publishing nothing (retryable). NEVER re-acquiring.");
      process.exit(1);
    }
    leaseFence = { ownerToken: runToken, generation: ownerGeneration };
  } catch (e) { console.error("STOP could not renew the control-plane lease (" + (e && e.message) + ") -- failing closed (retryable)."); process.exit(1); }
  verifyLease = async () => {
    try { const r = await sb.renewControlPlaneLease({ ownerToken: leaseFence.ownerToken, generation: leaseFence.generation, ttlSeconds: 900 }); return { ok: !!(r && r.disposition === "renewed"), reason: r && (r.reason || r.disposition) }; }
    catch (e) { return { ok: false, reason: "renew-error:" + (e && e.message ? e.message : e) }; }
  };
}

const result = await runPriorityDashboardsRelease({
  release, reconcile, readbackLive, assertNoCron,
  ...(bucketArg ? { bucket: bucketArg } : {}),
  ...(strictD1 ? { strictD1: true } : {}),
  ...(verifyLease ? { verifyLease } : {}),
  log: (m) => console.log("priority-release: " + m),
});
console.log("RESULT " + JSON.stringify({ ok: result.ok, stage: result.stage, status: result.status || null, bucket: bucketArg || "both", publicationScope: subsetFetchAccounts ? "healthy-subset" : "full-region", subsetCycleBucket: subsetCycleBucket || null, evidence: result.evidence || null, problems: result.problems || null, reports: [...PRIORITY_DASHBOARDS.publishOrder] }));
process.exit(result.code);
