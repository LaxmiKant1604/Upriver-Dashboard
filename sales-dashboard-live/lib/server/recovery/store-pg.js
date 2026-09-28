// Publication recovery worker -- Postgres store (WP12 route design): thin wrappers over the 20260934 RPCs + READ-ONLY
// metadata reads (route evidence through each route's own evidence SQL, the durable account directory, the global
// scheduler gate, served-row writes since verification, live-state upstream blockers, the control lease, the writer
// fence, the report-key universe). It NEVER writes report_snapshots, the control plane, sync tables, the writer fence or
// any source table, and it never loads a source payload (metadata columns only; the one exception is the tiny
// account-directory row's account list -- the SAME row the route CLI's durable directory is built from).
//
// TIMEOUTS WITHOUT A STARTUP PARAMETER. Every statement runs inside a short transaction that first issues
// `SET LOCAL statement_timeout` (the proven scripts/release/reconciliation-runner.mjs pattern; valid through the
// production Supavisor transaction pooler), plus a client-side query_timeout backstop. No `statement_timeout` /
// `options` startup parameter is ever sent (never proven accepted by the pooler: a rejection would fail every read).
// Reads use `begin transaction isolation level repeatable read read only` (one consistent snapshot per route evidence
// evaluation; a write is refused by the server).
//
// DATES AS TEXT. A Postgres `date` is returned as its exact 'YYYY-MM-DD' text (recoveryPgTypes); instants the worker
// compares are returned as epoch-ms numbers computed IN SQL (never a JS Date parse of a local-time string).
//
// The PURE helpers below (cycle bucket grammar, the global scheduler gate, the upstream-blocker filter, the durable
// directory builder, the live-row scope batching) are shared with the in-memory test store so both stores decide
// identically; scripts/worker/publication-recovery-sql-selftest.mjs runs these exact statements against PGlite.

import pg from "pg";
import { verifiedPgConfig } from "../pg-tls.js";
// WP11: the four legacy families' evidence-token compose lives with the legacy route wrappers (token strings
// byte-identical); re-exported here for existing importers.
import { composeEvidenceTokens } from "./routes/oli.route.js";
import { evaluateRouteEvidence, sweepMemoQuery } from "./routes.js";
import { ROUTE_REGIONS } from "./route-contract.js";
import { normalizeMarketplace } from "../sync/oli-sales-estimate.js";
import { readReportWriterFence } from "../sync/report-writer-fence.js";

export { composeEvidenceTokens };

const S = (v) => (v == null ? "" : String(v));
const iso = (v) => (v instanceof Date ? v.toISOString() : v == null ? "" : String(v));
const num = (v) => (v == null || v === "" ? null : Number(v));

// A Postgres `date` (OID 1082) is returned as its exact 'YYYY-MM-DD' text. node-postgres' default parses it to a JS Date
// at LOCAL midnight, whose toISOString() is the PREVIOUS day on any host east of UTC -- which would make every claimed
// job look like an older as-of and be superseded. Scoped to this pool (never the global pg.types).
const DATE_OID = 1082;
export const recoveryPgTypes = Object.freeze({
  getTypeParser: (oid, format) => (oid === DATE_OID && format !== "binary" ? (v) => v : pg.types.getTypeParser(oid, format)),
});

// ---- the sync_cycles bucket grammar (EXHAUSTIVE against sync_cycles_bucket_check, 20260924_priority_partial_cycle_
// bucket.sql:40-42) -------------------------------------------------------------------------------------------------
// FIXED values of the CHECK (13) and its two regex families. Every bucket shape is classified; an UNKNOWN shape is
// treated as scheduler-owned (fail closed: it blocks) and alerted.
export const SCHEDULER_FIXED_CYCLE_BUCKETS = Object.freeze([
  "us", "non-us", "us-fba", "non-us-fba", "india", "europe-au", "us-ca", "india-fba", "europe-au-fba", "us-ca-fba",
  "listing-health-v3-india", "listing-health-v3-europe-au", "listing-health-v3-us-ca",
]);
const BOOTSTRAP_BUCKET_RE = /^bootstrap(-fba)?-(india|europe-au|us-ca)-[0-9a-f]{16}$/;
const PRIORITY_PARTIAL_BUCKET_RE = /^priority-partial-(india|europe-au|us-ca)-[0-9a-f]{16}$/;

/**
 * The kind of a sync_cycles bucket:
 *   'paid-fba'          a PAID cycle that can produce an fba-plan paid job: '<scope>-fba' (fba-plan-operation.js:41
 *                       fbaCycleBucket; callers scripts/release/fba-plan-golive.mjs and the Data Sync Center paid FBA sync
 *                       api/admin/sources.js:436-448, whose us|non-us bucket (:313-314) gives us-fba / non-us-fba) and
 *                       'bootstrap-fba-<region>-<hex16>' (account-onboarding.js:377-386; fba-plan-golive.mjs);
 *   'scheduler'         every other scheduler-owned cycle: the natural '<region>' / legacy 'us' | 'non-us', the LHv3
 *                       'listing-health-v3-<region>', 'bootstrap-<region>-<hex16>';
 *   'priority-partial'  'priority-partial-<region>-<hex16>' (the route / priority release cycles -- EXCLUDED from the gate);
 *   'unknown'           anything else (fail closed: blocks + alert 'unknown-cycle-bucket').
 */
export function cycleBucketKind(bucket) {
  const b = S(bucket);
  if (PRIORITY_PARTIAL_BUCKET_RE.test(b)) return "priority-partial";
  const m = BOOTSTRAP_BUCKET_RE.exec(b);
  if (m) return m[1] ? "paid-fba" : "scheduler";
  if (SCHEDULER_FIXED_CYCLE_BUCKETS.includes(b)) return b.endsWith("-fba") ? "paid-fba" : "scheduler";
  return "unknown";
}

/** Region a scheduler-v2 sync_cycles bucket belongs to (null for legacy us/non-us or unknown buckets). */
export function regionForCycleBucket(bucket) {
  const m = /^(?:listing-health-v3-|bootstrap-(?:fba-)?|priority-partial-)?(india|europe-au|us-ca)(?:-fba)?(?:-[0-9a-f]{16})?$/.exec(S(bucket));
  return m ? m[1] : null;
}

// The gate's windows (seconds). IN_FLIGHT: a scheduler-owned cycle pending/running that STARTED within 4 h blocks.
// PAID_STALE: an open PAID cycle idle > 6 h / an open paid fba-plan job older than 6 h is alerted (the fba-plan route's
// own staleness rule: last activity = greatest(cycle updated_at, its source/report jobs' max updated_at) within 6 h;
// fba-plan-dependency-bundle.js FBA_PLAN_STALE_IN_FLIGHT_MS -- pinned equal by the worker suite).
export const GATE_IN_FLIGHT_SECONDS = 4 * 3600;
export const PAID_STALE_SECONDS = 6 * 3600;
// A running priority-partial cycle older than 2 x the longest route hard timeout (840 s) holding a job is stranded.
export const STRANDED_PARTIAL_SECONDS = 2 * 840;

/**
 * THE GLOBAL SCHEDULER GATE (pure; both stores). rows = one per sync_cycles row that is open (pending/running) OR was
 * updated within the cooldown: { id, bucket, status, cycle_date, age_seconds (since started_at|created_at), idle_seconds
 * (since the last activity: greatest(cycle, report jobs, source jobs updated_at)), report_jobs, source_jobs,
 * open_report_jobs, failed_report_jobs, open_source_jobs, open_fba_plan_age_seconds }.
 * Blocks (any region -- the gate is GLOBAL) when a scheduler-owned / paid / unknown-bucket cycle is open and started
 * within 4 h, OR had any activity within the cooldown (open or just finished -- covers the run -> fba gap). A
 * priority-partial cycle never blocks. -> { blocked, reason, blockers: [{ bucket, why }], alerts: [{ code, ... }],
 * orphanPartial } (orphanPartial = job-less running priority-partial cycles past the stranded bound: a crash between
 * claim and job upsert -- IGNORED as a stall; the reaper may finalize them).
 */
export function evaluateSchedulerGate(rows, { cooldownSeconds = 900, inFlightSeconds = GATE_IN_FLIGHT_SECONDS, paidStaleSeconds = PAID_STALE_SECONDS, strandedSeconds = STRANDED_PARTIAL_SECONDS, rowLimit = Infinity } = {}) {
  const blockers = []; const alerts = []; let orphanPartial = 0;
  const list = Array.isArray(rows) ? rows : [];
  // FAIL CLOSED on a truncated read (WP12 verifier P3): the gate SQL returns at most SCHEDULER_GATE_ROW_LIMIT rows ordered
  // by updated_at desc, so under heavy priority-partial churn a running scheduler cycle could fall off the end and the
  // gate would open. A read that hit the limit cannot prove "no blocker" -> blocked + alert.
  // The SQL sorts every blocking-capable (non-priority-partial) bucket FIRST, so a cut that ends on a priority-partial row
  // provably kept every scheduler row: alert only (stranded priority-partial cycles can never close the gate for good --
  // final review P3). A cut that ends on a scheduler row may have dropped one -> fail closed.
  if (list.length >= rowLimit) {
    const lastKind = cycleBucketKind(list[list.length - 1] && list[list.length - 1].bucket);
    if (lastKind !== "priority-partial") blockers.push({ bucket: "*", why: "gate-read-truncated" });
    alerts.push({ code: "scheduler-gate-truncated", rows: list.length, blocking: lastKind !== "priority-partial" });
  }
  for (const r of list) {
    const kind = cycleBucketKind(r.bucket);
    const open = r.status === "pending" || r.status === "running";
    const age = num(r.age_seconds); const idle = num(r.idle_seconds);
    const jobs = (num(r.report_jobs) || 0) + (num(r.source_jobs) || 0);
    if (kind === "priority-partial") {
      if (r.status === "running" && age != null && age > strandedSeconds) {
        if (jobs === 0) orphanPartial += 1;
        else alerts.push({ code: "stranded-partial-cycle", bucket: S(r.bucket).slice(0, 60), cycle_date: S(r.cycle_date), age_seconds: age, open_report_jobs: num(r.open_report_jobs) || 0, failed_report_jobs: num(r.failed_report_jobs) || 0 });
      }
      continue;
    }
    if (kind === "unknown") alerts.push({ code: "unknown-cycle-bucket", bucket: S(r.bucket).slice(0, 60) });
    if (open && age != null && age < inFlightSeconds) blockers.push({ bucket: S(r.bucket), why: "in-flight" });
    else if (idle != null && idle < cooldownSeconds) blockers.push({ bucket: S(r.bucket), why: open ? "active" : "cooldown" });
    // RELAXED (WP12 verifier P3): an OPEN scheduler-owned / paid / unknown cycle older than the in-flight bound AND idle
    // past the cooldown no longer blocks -- say so AT ONCE (not only after the 6 h paid-cycle-stale-open threshold), so a
    // relaxed gate is never silent. The fba-plan route's own in-lease paid-cycle check + the control lease still guard.
    else if (open) alerts.push({ code: "scheduler-cycle-relaxed-open", bucket: S(r.bucket).slice(0, 60), cycle_date: S(r.cycle_date), kind, age_seconds: age, idle_seconds: idle });
    if (open && kind === "paid-fba" && idle != null && idle > paidStaleSeconds) alerts.push({ code: "paid-cycle-stale-open", bucket: S(r.bucket).slice(0, 60), cycle_date: S(r.cycle_date), idle_seconds: idle });
    const fpAge = num(r.open_fba_plan_age_seconds);
    if (open && fpAge != null && fpAge > paidStaleSeconds) alerts.push({ code: "paid-job-stale-in-flight", bucket: S(r.bucket).slice(0, 60), cycle_date: S(r.cycle_date), age_seconds: fpAge });
  }
  const b = blockers[0];
  return { blocked: blockers.length > 0, reason: b ? `scheduler-${b.why}:${b.bucket.slice(0, 60)}` : null, blockers, alerts, orphanPartial };
}

/**
 * The REAPER's decision (pure; the operator tool scripts/worker/publication-recovery-reaper.mjs -- NEVER the worker,
 * whose graph never names the cycle-finalize RPC). Over the SCHEDULER_GATE_SQL rows:
 *   'finalize-orphan-partial'  a RUNNING priority-partial cycle past the stranded bound with ZERO report AND source jobs
 *                              (a crash between the cycle claim and the job upsert): the guarded finalize yields
 *                              'succeeded' with report_total 0 -- safe;
 *   'finalize-drained'         a RUNNING scheduler-owned / paid cycle idle > 6 h whose every report + source job is
 *                              finished (the process died after draining): the guarded finalize applies the counters;
 *   'never'                    ANY priority-partial cycle holding a job (pending / failed / any -- incl. an LHv3 salted
 *                              foreign-retry cycle: finalizing it could strand the retry again), and any cycle with an OPEN
 *                              job (the guarded RPC would refuse 'open-work' anyway) -> surfaced as an alert only; an open
 *                              stuck PAID cycle is superseded by the next natural paid cycle or needs the reviewed paid
 *                              re-run.
 * -> [{ id, bucket, cycle_date, action, why }] for the stale rows only (fresh rows are not candidates at all).
 */
export function reaperCandidates(rows, { paidStaleSeconds = PAID_STALE_SECONDS, strandedSeconds = STRANDED_PARTIAL_SECONDS, epoch = null } = {}) {
  const out = [];
  // The CURRENT epoch (UTC D-1, 'YYYY-MM-DD'). A job-less priority-partial cycle of the current (or a later) epoch is NOT
  // finalized (WP12 verifier P2-2): its bucket key is (route, target, revision, latest job id), so the next run with the
  // same evidence RESUMES it; finalizing it would make that run find a TERMINAL cycle ('cycle-not-running:succeeded' ->
  // terminal-cycle, dead-letter) and block the target until its evidence or the UTC day changes. Unknown epoch -> never.
  const epochOk = typeof epoch === "string" && /^\d{4}-\d{2}-\d{2}$/.test(epoch);
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r.status !== "running") continue;
    const kind = cycleBucketKind(r.bucket);
    const age = num(r.age_seconds); const idle = num(r.idle_seconds);
    const jobs = (num(r.report_jobs) || 0) + (num(r.source_jobs) || 0);
    const open = (num(r.open_report_jobs) || 0) + (num(r.open_source_jobs) || 0);
    const base = { id: S(r.id), bucket: S(r.bucket), cycle_date: S(r.cycle_date) };
    if (kind === "priority-partial") {
      if (age == null || age <= strandedSeconds) continue;
      if (jobs !== 0) out.push({ ...base, action: "never", why: "priority-partial cycle holding " + jobs + " job(s) -- never finalized by the reaper (stranded-partial-cycle alert)" });
      else if (!epochOk) out.push({ ...base, action: "never", why: "job-less priority-partial cycle, but the current epoch is unknown -- refusing (a current-epoch orphan resumes on its own)" });
      else if (!(S(r.cycle_date) < epoch)) out.push({ ...base, action: "never", why: "job-less priority-partial cycle of the CURRENT epoch " + S(r.cycle_date) + ": the next run with the same evidence resumes it; finalizing it would dead-letter that target for the day" });
      else out.push({ ...base, action: "finalize-orphan-partial", why: "job-less running priority-partial cycle of a PAST epoch (crash between claim and job upsert)" });
      continue;
    }
    if (idle == null || idle <= paidStaleSeconds) continue;
    out.push(open === 0 ? { ...base, action: "finalize-drained", why: "every job finished; the process died before finalizing" }
      : { ...base, action: "never", why: open + " open job(s) -- superseded by the next natural cycle or the reviewed paid re-run (paid-cycle-stale-open)" });
  }
  return out;
}

// Deferred classes an upstream job may carry that will NOT converge soon (missing evidence, capacity, not activated /
// not live, a preempted served slot, a config alert, an unmapped reason, not applicable): such an open job never blocks a
// downstream route (a dead or missing-evidence upstream does not block -- plan WP12).
export const NON_BLOCKING_UPSTREAM_CLASSES = Object.freeze(["missing-evidence", "capacity-exceeded", "route-not-activated", "route-not-live", "served-row-preempted", "config-alert", "unclassified", "not-applicable"]);
// Deferred (route, class, reason-prefix) triples that are an ACCEPTED STEADY STATE, not a pending publish: the fba-plan
// fill-only 'evidence-instant-not-advanced' deferral (plan-addendum orchestratorDesignDecisions WP7 + recordedDeviations
// WP11) waits for the next PAID FBA fetch / D-1, while the paid-published live fba-plan row stays authoritative -- so its
// dependents must read that row now instead of waiting PRW_AWAIT_MAX_MINUTES for an 'await-timeout' (WP14 e2e S2c').
export const NON_BLOCKING_UPSTREAM_REASONS = Object.freeze([Object.freeze({ route: "fba-plan", cls: "dependency-deferral", reasonPrefix: "evidence-instant-not-advanced" })]);
const acceptedSteadyState = (j) => NON_BLOCKING_UPSTREAM_REASONS.some((x) => S(j.route_id) === x.route && S(j.last_class) === x.cls && S(j.last_reason).startsWith(x.reasonPrefix));

/**
 * LIVE-STATE AWAITS (pure; both stores). jobs = open (pending/claimed/deferred) jobs of the awaited routes in the region
 * at the epoch; states = state rows of the awaited routes (region, epoch) whose last_class is 'stale'. An owner is
 * blocked only by an OPEN upstream job (a deferred one only with a class that will converge) or a 'stale' upstream state
 * for that owner. owners null = the whole region (a region-grain target: its owners never gate it -- any upstream in the
 * region does). -> [{ route_id, target_key, why: 'open-job' | 'stale-state', created_ms? }] (bounded).
 */
export function upstreamBlockersFrom({ jobs = [], states = [], owners = null } = {}) {
  const want = owners == null ? null : new Set(owners.map(S));
  const hits = (row) => want == null || want.has(S(row.target_key)) || (Array.isArray(row.owner_account_ids) && row.owner_account_ids.some((o) => want.has(S(o))));
  const out = [];
  for (const j of jobs) {
    if (!hits(j)) continue;
    if (j.status === "deferred" && (NON_BLOCKING_UPSTREAM_CLASSES.includes(S(j.last_class)) || acceptedSteadyState(j))) continue;
    out.push({ route_id: S(j.route_id), target_key: S(j.target_key), why: "open-job", created_ms: num(j.created_ms) });
    if (out.length >= 50) return out;
  }
  for (const s of states) {
    if (S(s.last_class) !== "stale" || !hits(s)) continue;
    out.push({ route_id: S(s.route_id), target_key: S(s.target_key), why: "stale-state" });
    if (out.length >= 50) return out;
  }
  return out;
}

/**
 * The DURABLE account directory from the latest 'account-directory' report_snapshots payload's account list -- the SAME
 * rows the route CLI reads (supabase.js getAccountDirectorySnapshotAccounts: settingUp entries excluded; accountId |
 * id | account_id; country | marketCountry | marketplace) folded with the SAME rules as route-publication-release.js
 * buildDurableDirectory (':'-prefixed / blank ids, blank countries and duplicate ids are excluded; the primary
 * connection's raw seller id IS the account id -- datadoe-connections.js resolveDataDoeAccountIds). Pinned equal to the
 * CLI builder by scripts/publication-recovery-worker.test.js. -> { directory: Map, excluded: [{ accountId, reason }] }.
 */
export function buildWorkerDirectory(accounts) {
  const rows = (Array.isArray(accounts) ? accounts : [])
    .filter((a) => !(a && a.settingUp === true))
    .map((a) => ({
      accountId: S(a && (a.accountId || a.id || a.account_id)).trim(),
      country: S(a && (a.country || a.marketCountry || a.marketplace)).trim(),
      currency: (a && a.currency) || null,
      name: (a && a.name) || null,
    })).filter((a) => a.accountId);
  const directory = new Map(); const excluded = []; const seen = new Map();
  for (const r of rows) seen.set(r.accountId, (seen.get(r.accountId) || 0) + 1);
  for (const r of rows) {
    const id = r.accountId;
    if (id.includes(":")) { excluded.push({ accountId: "prefixed", reason: "not-primary" }); continue; }
    if ((seen.get(id) || 0) > 1) { excluded.push({ accountId: id, reason: "duplicate-directory-row" }); continue; }
    if (!r.country) { excluded.push({ accountId: id, reason: "no-marketplace" }); continue; }
    directory.set(id, { accountId: id, country: r.country, marketplace: normalizeMarketplace(r.country), rawSellerId: id, name: r.name != null ? S(r.name) : null, currency: r.currency != null ? S(r.currency) : null });
  }
  return { directory, excluded };
}

/** A LIKE pattern as a RegExp (the in-memory store's mirror of `account_id like <pat>`; '\' escapes). */
export function likeToRegExp(pattern) {
  let re = "^";
  const p = S(pattern);
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i];
    if (c === "\\" && i + 1 < p.length) { re += p[i + 1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); i += 1; }
    else if (c === "%") re += "[\\s\\S]*";
    else if (c === "_") re += "[\\s\\S]";
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(re + "$");
}

// ---- SQL (metadata only; every statement is a single SELECT / WITH -- the selftest runs each against PGlite) ------
export const DIRECTORY_SQL = "select case when jsonb_typeof(payload->'accounts') = 'array' then payload->'accounts' when jsonb_typeof(payload) = 'array' then payload else '[]'::jsonb end as accounts, updated_at::text as updated_at from public.report_snapshots where report_key = 'account-directory' order by updated_at desc limit 1";
// The gate read's row cap; a read that returns this many rows is TRUNCATED and the gate fails closed (evaluateSchedulerGate).
export const SCHEDULER_GATE_ROW_LIMIT = 500;
const OPEN_REPORT_JOB = "not (j.fetch_status = 'blocked' or (j.derive_status = 'succeeded' and j.save_status = 'succeeded') or j.derive_status in ('failed','skipped') or j.save_status = 'failed')";
export const SCHEDULER_GATE_SQL = "select c.id::text as id, c.bucket, c.status, c.cycle_date::text as cycle_date, "
  + "extract(epoch from (now() - coalesce(c.started_at, c.created_at)))::bigint as age_seconds, "
  + "extract(epoch from (now() - greatest(c.updated_at, coalesce((select max(j.updated_at) from public.sync_report_jobs j where j.cycle_id = c.id), c.updated_at), coalesce((select max(s.updated_at) from public.sync_source_jobs s where s.cycle_id = c.id), c.updated_at))))::bigint as idle_seconds, "
  + "(select count(*)::int from public.sync_report_jobs j where j.cycle_id = c.id) as report_jobs, "
  + "(select count(*)::int from public.sync_source_jobs s where s.cycle_id = c.id) as source_jobs, "
  + `(select count(*)::int from public.sync_report_jobs j where j.cycle_id = c.id and ${OPEN_REPORT_JOB}) as open_report_jobs, `
  + "(select count(*)::int from public.sync_report_jobs j where j.cycle_id = c.id and (j.derive_status = 'failed' or j.save_status = 'failed' or j.fetch_status in ('blocked','failed'))) as failed_report_jobs, "
  + "(select count(*)::int from public.sync_source_jobs s where s.cycle_id = c.id and s.fetch_status in ('pending','attempted')) as open_source_jobs, "
  + `(select extract(epoch from (now() - min(j.created_at)))::bigint from public.sync_report_jobs j where j.cycle_id = c.id and j.report_key = 'fba-plan' and ${OPEN_REPORT_JOB}) as open_fba_plan_age_seconds `
  + "from public.sync_cycles c where c.status in ('pending','running') or c.updated_at > now() - make_interval(secs => $1::int) "
  // Scheduler-owned / paid / unknown buckets sort FIRST (the rows that can block), priority-partial rows after them, so a
  // truncated read only ever drops priority-partial rows unless the scheduler rows alone exceed the cap (see evaluate).
  + "order by (c.bucket like 'priority-partial-%'), c.updated_at desc limit " + SCHEDULER_GATE_ROW_LIMIT;
export const CONTROL_LEASE_SQL = "select owner_token, operation_key, expires_at::text as expires_at, (expires_at is not null and expires_at > now()) as live from public.control_plane_lease limit 1";
export const LIVE_WRITES_EQ_SQL = "select x.k, (extract(epoch from max(s.updated_at)) * 1000)::bigint as max_ms "
  + "from unnest($1::text[], $2::text[], $3::text[]) as x(k, rk, acct) "
  + "join public.report_snapshots s on s.report_key = x.rk and s.account_id = x.acct group by x.k";
export const LIVE_WRITES_LIKE_SQL = "select x.k, (extract(epoch from max(s.updated_at)) * 1000)::bigint as max_ms "
  + "from unnest($1::text[], $2::text[], $3::text[], $4::text[]) as x(k, rk, pat, pe) "
  + "join public.report_snapshots s on s.report_key = x.rk and s.account_id like x.pat and s.params @> x.pe::jsonb group by x.k";
export const UPSTREAM_JOBS_SQL = "select route_id, target_key, owner_account_ids, status, last_class, last_reason, (extract(epoch from created_at) * 1000)::bigint as created_ms "
  + "from public.publication_recovery_jobs where route_id = any($1::text[]) and region = $2 and requested_as_of = $3::date and status in ('pending','claimed','deferred') "
  + "order by created_at limit 500";
export const UPSTREAM_STATE_SQL = "select route_id, target_key, owner_account_ids, last_class from public.publication_recovery_state "
  + "where route_id = any($1::text[]) and region = $2 and requested_as_of = $3::date and last_class = 'stale' limit 500";
export const STATE_SQL = "select target_key, owner_account_ids, verified_token, observed_token, (extract(epoch from verified_at) * 1000)::bigint as verified_ms, "
  + "verified_rows, last_class, last_reason, handoff, served_confirmed from public.publication_recovery_state where route_id = $1 and region = $2 and requested_as_of = $3::date";
export const REPORT_KEYS_SQL = "select report_key, count(*)::int as n from public.report_snapshots where report_key not like 'scheduler-v2/%' group by report_key order by report_key";
export const CONTROL_SQL = "select c.enabled, coalesce((select jsonb_object_agg(r.route_id, jsonb_build_object('liveEnabled', r.live_enabled, 'liveRegions', to_jsonb(r.live_regions))) from public.publication_recovery_routes r), '{}'::jsonb) as routes from public.publication_recovery_control c where c.id = true";
export const SCAN_STATE_SQL = "select deep_sweep, holder, (extract(epoch from last_tier1_at) * 1000)::bigint as last_tier1_ms from public.publication_recovery_scan where id = true";

/** Split live-row scopes into the eq / like batches (pure). scopes: [{ key, reportKey, accountIdEq | accountIdLike, paramsEq? }]. */
export function liveWriteBatches(scopes) {
  const eq = { k: [], rk: [], acct: [] }; const like = { k: [], rk: [], pat: [], pe: [] };
  for (const s of Array.isArray(scopes) ? scopes : []) {
    if (s.accountIdEq != null) { eq.k.push(S(s.key)); eq.rk.push(S(s.reportKey)); eq.acct.push(S(s.accountIdEq)); }
    else { like.k.push(S(s.key)); like.rk.push(S(s.reportKey)); like.pat.push(S(s.accountIdLike)); like.pe.push(JSON.stringify(s.paramsEq && typeof s.paramsEq === "object" ? s.paramsEq : {})); }
  }
  return { eq, like };
}

/**
 * The worker's pool config: VERIFIED TLS (chain pinned to the Supabase root CA + hostname checked; lib/server/pg-tls.js)
 * -- never sslmode=no-verify / rejectUnauthorized:false. The URL query (incl. sslmode=require) is dropped so it cannot
 * override the verified `ssl`. A malformed URL throws a REDACTED error (Node's ERR_INVALID_URL prints the password).
 * NO startup-parameter statement_timeout: statements are bounded by SET LOCAL inside each transaction + the client-side
 * query_timeout backstop.
 */
export function recoveryPoolConfig(connectionString, { max = 2 } = {}) {
  return verifiedPgConfig(connectionString, { max, idleTimeoutMillis: 30000, connectionTimeoutMillis: 15000, query_timeout: 120000, types: recoveryPgTypes });
}

const READ_BEGIN = "begin transaction isolation level repeatable read read only";
const WRITE_BEGIN = "begin";

export function createRecoveryStore({ connectionString, max = 2, poolImpl = null, onError = () => {}, statementTimeoutSeconds = 60, directoryTtlMs = 600000, clock = () => Date.now() }) {
  const pool = poolImpl || new pg.Pool(recoveryPoolConfig(connectionString, { max }));
  // pg-pool re-emits an IDLE client's error (pooler restart, network drop) on the pool; without a listener that is an
  // uncaught exception that would kill the worker (and, via KillMode=mixed, a live child). Log the code only.
  if (typeof pool.on === "function") pool.on("error", (e) => { try { onError(String((e && e.code) || "error")); } catch { /* ignore */ } });
  const timeout = `set local statement_timeout = '${Math.max(5, Math.min(Number(statementTimeoutSeconds) || 60, 300))}s'`;
  // ONE short transaction per unit of work: begin -> SET LOCAL statement_timeout -> fn(query) -> commit (rollback +
  // discard the client on any error).
  async function tx(fn, { readOnly = true } = {}) {
    const client = await pool.connect();
    let ok = false;
    try {
      await client.query(readOnly ? READ_BEGIN : WRITE_BEGIN);
      await client.query(timeout);
      const out = await fn(async (text, values = []) => (await client.query(text, values)).rows);
      await client.query("commit");
      ok = true;
      return out;
    } catch (e) {
      try { await client.query("rollback"); } catch { /* ignore */ }
      throw e;
    } finally {
      try { client.release(ok ? undefined : true); } catch { /* ignore */ }
    }
  }
  const read = (text, values = []) => tx((q) => q(text, values));
  const rpc = async (text, values = []) => (await tx((q) => q(text, values), { readOnly: false }))[0] || null;
  let dirCache = null;

  return {
    // ---------------- control ----------------
    async control() {
      const r = (await read(CONTROL_SQL))[0] || null;
      const routes = {};
      for (const [id, v] of Object.entries((r && r.routes) || {})) routes[id] = { liveEnabled: !!(v && v.liveEnabled), liveRegions: Array.isArray(v && v.liveRegions) ? v.liveRegions.map(S) : [] };
      return { enabled: !!(r && r.enabled), routes };
    },
    // ---------------- the 12 RPCs ----------------
    async enqueue({ route, region, targetKey, owners = [], asOf, token, origin, priority = 5 }) {
      const r = await rpc("select public.enqueue_publication_recovery_job($1,$2,$3,$4::text[],$5::date,$6,$7,$8::smallint) as d", [route, region, targetKey, owners, asOf, token, origin, priority]);
      return r && r.d;
    },
    async claim({ workerId, claimToken, limit, leaseSeconds, maxClaims }) {
      const rows = await tx((q) => q("select j.*, (extract(epoch from j.created_at) * 1000)::bigint as created_ms from public.claim_publication_recovery_jobs($1,$2::uuid,$3,$4,$5) j", [workerId, claimToken, limit, leaseSeconds, maxClaims]), { readOnly: false });
      return rows.map((j) => ({ ...j, requested_as_of: S(j.requested_as_of).slice(0, 10), created_ms: num(j.created_ms), owner_account_ids: Array.isArray(j.owner_account_ids) ? j.owner_account_ids : [] }));
    },
    async renewClaim({ ids, claimToken, leaseSeconds }) {
      const r = await rpc("select public.renew_publication_recovery_claim($1::uuid[],$2::uuid,$3) as n", [ids, claimToken, leaseSeconds]);
      return Number(r && r.n) || 0;
    },
    async finish({ id, claimToken, outcome, cls, reason, backoff, maxAttempts, runToken, evaluatedToken, verifiedRows = null, alert = null, published = false, handoff = null, recordState = true, servedConfirmed = null, maxRearms = 12 }) {
      const r = await rpc("select public.finish_publication_recovery_job($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16) as d",
        [id, claimToken, outcome, cls, reason, backoff, maxAttempts, runToken, evaluatedToken, verifiedRows == null ? null : JSON.stringify(verifiedRows), alert, !!published, handoff, recordState !== false, servedConfirmed == null ? null : !!servedConfirmed, maxRearms]);
      return r && r.d;
    },
    async recordBaseline(rows) { if (!rows.length) return 0; const r = await rpc("select public.record_publication_recovery_baseline($1::jsonb) as n", [JSON.stringify(rows)]); return Number(r && r.n) || 0; },
    async recordObservations(rows) { if (!rows.length) return 0; const r = await rpc("select public.record_publication_recovery_observations($1::jsonb) as n", [JSON.stringify(rows)]); return Number(r && r.n) || 0; },
    async beat({ workerId, host, pid, version, mode, startedAt, lastErrorCode, stats }) {
      await rpc("select public.beat_publication_recovery_worker($1,$2,$3,$4,$5,$6::timestamptz,$7,$8::jsonb)", [workerId, host, pid, version, mode, startedAt, lastErrorCode, JSON.stringify(stats || {})]);
    },
    async tryBeginScan({ holder, leaseSeconds, minIntervalSeconds, kind = "deep" }) {
      const r = await rpc("select public.try_begin_publication_recovery_scan($1,$2,$3,$4) as ok", [holder, leaseSeconds, minIntervalSeconds, kind]); return !!(r && r.ok);
    },
    async renewScan({ holder, leaseSeconds }) { const r = await rpc("select public.renew_publication_recovery_scan($1,$2) as ok", [holder, leaseSeconds]); return !!(r && r.ok); },
    async finishScan({ holder, outcome, summary, kind = "deep", deepSweep = null }) {
      const r = await rpc("select public.finish_publication_recovery_scan($1,$2,$3::jsonb,$4,$5::jsonb) as ok", [holder, outcome, JSON.stringify(summary || {}), kind, deepSweep == null ? null : JSON.stringify(deepSweep)]); return !!(r && r.ok);
    },
    async prune(keepDays) { const r = await rpc("select public.prune_publication_recovery($1) as n", [keepDays]); return Number(r && r.n) || 0; },
    async status(limit = 200) { const r = (await read("select public.publication_recovery_status($1) as s", [limit]))[0]; return r && r.s; },

    // ---------------- READ-ONLY metadata reads ----------------
    /** The durable account directory (cached directoryTtlMs = 600 s). */
    async readDirectory() {
      const now = clock();
      if (dirCache && now - dirCache.at < directoryTtlMs) return dirCache.directory;
      const r = (await read(DIRECTORY_SQL))[0] || null;
      const built = buildWorkerDirectory(r ? r.accounts : []);
      dirCache = { at: now, directory: built.directory, excluded: built.excluded.length };
      return built.directory;
    },
    /**
     * One route's evidence (its OWN metadata-only SQL + compose) in ONE repeatable-read read-only snapshot. sweepCache
     * (optional Map, one per tier-1 sweep): a `shared: true` statement runs once per sweep (routes.js sweepMemoQuery).
     */
    async readRouteEvidence(route, ctx, { sweepCache = null } = {}) {
      // With a sweep cache: sweep mode (a statement's shared variant, run once per pass); without: every statement's own
      // text in this evaluation's own snapshot (byte-identical to the pre-cache call).
      return tx((raw) => { const q = sweepMemoQuery(raw, sweepCache); return sweepCache instanceof Map ? evaluateRouteEvidence(route, q, ctx, { sweep: true }) : evaluateRouteEvidence(route, q, ctx); });
    },
    /** The state rows of (route, region, epoch): Map targetKey -> row (verified_ms epoch-ms; dates never parsed). */
    async readState({ route, region, epoch }) {
      const rows = await read(STATE_SQL, [route, region, epoch]);
      return new Map(rows.map((r) => [S(r.target_key), { ...r, verified_ms: num(r.verified_ms), verified_rows: Array.isArray(r.verified_rows) ? r.verified_rows : [] }]));
    },
    /** max(updated_at) (epoch ms) of the live rows in each scope key's tier-1 live-row scopes. -> Map key -> { maxMs }. */
    async readLiveRowWritesSince(scopes) {
      const { eq, like } = liveWriteBatches(scopes);
      const out = new Map();
      const fold = (rows) => { for (const r of rows) { const k = S(r.k); const m = num(r.max_ms); const prev = out.get(k); if (!prev || (m != null && (prev.maxMs == null || m > prev.maxMs))) out.set(k, { maxMs: m }); } };
      await tx(async (q) => {
        if (eq.k.length) fold(await q(LIVE_WRITES_EQ_SQL, [eq.k, eq.rk, eq.acct]));
        if (like.k.length) fold(await q(LIVE_WRITES_LIKE_SQL, [like.k, like.rk, like.pat, like.pe]));
      });
      return out;
    },
    /** Live-state awaits: the upstream blockers of (awaits, region, owners|null, epoch). */
    async readUpstreamBlockers({ awaits, region, owners = null, epoch }) {
      if (!Array.isArray(awaits) || !awaits.length) return [];
      const [jobs, states] = await tx(async (q) => [await q(UPSTREAM_JOBS_SQL, [awaits, region, epoch]), await q(UPSTREAM_STATE_SQL, [awaits, region, epoch])]);
      return upstreamBlockersFrom({ jobs, states, owners });
    },
    /** The global scheduler gate (sync_cycles metadata). */
    async readSchedulerGate({ cooldownSeconds = 900 } = {}) {
      return evaluateSchedulerGate(await read(SCHEDULER_GATE_SQL, [Math.max(0, Math.floor(Number(cooldownSeconds) || 0))]), { cooldownSeconds, rowLimit: SCHEDULER_GATE_ROW_LIMIT });
    },
    /** The global control-plane lease (READ-ONLY): held by a live owner right now? */
    async readControlLease() {
      const r = (await read(CONTROL_LEASE_SQL))[0] || null;
      return { held: !!(r && S(r.owner_token) && r.live), operationKey: r ? S(r.operation_key) : "", expiresAt: r && r.expires_at ? iso(r.expires_at) : null };
    },
    /** The DB writer fence rows (lib/server/sync/report-writer-fence.js reader; 'absent' before 20260935). */
    async readFence() {
      try { return await tx((q) => readReportWriterFence(q)); }
      catch (e) { return { state: "unreadable", code: S(e && e.code).slice(0, 16) || "error" }; }
    },
    /** Every live (non-shadow) report_key with its row count (the unregistered-live-report-key detector). */
    async readReportKeys() { return (await read(REPORT_KEYS_SQL)).map((r) => ({ report_key: S(r.report_key), n: Number(r.n) || 0 })); },
    /** The scan row's deep-sweep progress + tier-1 cadence. */
    async readScanState() {
      const r = (await read(SCAN_STATE_SQL))[0] || null;
      return { deepSweep: (r && r.deep_sweep) || {}, holder: r ? r.holder : null, lastTier1Ms: r ? num(r.last_tier1_ms) : null };
    },
    async close() { try { await pool.end(); } catch { /* ignore */ } },
  };
}

// The regions every gate / read above is keyed by (pinned to the route contract).
export const STORE_REGIONS = ROUTE_REGIONS;
