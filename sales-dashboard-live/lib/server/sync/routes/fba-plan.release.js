// Publication recovery WP7 -- the CLI-side fba-plan ZERO-EXPORT recovery route (scripts/release/publication-route-
// reconcile.mjs --route=fba-plan, through the generic route-publication-release.js). It rebuilds FBA Shipment Plan from
// validated DURABLE evidence only (fba-plan-dependency-bundle.js): never the paid acquisition path, never the 20-hour
// source-export cache, never a DataDoe export; the ONLY write path is the generic release's fenced lineage + the
// reviewed four-gate publisher (the 'fba-plan' contract's WP1 promotedGateKey opens GATE 2 on the PROMOTED row, so the
// paid dispatch control is never opened).
//
// FILL-ONLY BY DESIGN (WP7 round 4 -- the orchestrator's decision after three verification rounds each reproduced a way
// to lose / regress NEWER PAID data: the route and the ACTIVE paid publisher write the SAME live key through the same
// latest-job-promoting publisher). The PAID path is authoritative by construction; the route only FILLS a D-1 the paid
// path has not published and may replace only a row it wrote itself (fba-plan-dependency-bundle.js header):
//   - OWNERSHIP: a live row is ROUTE-WRITTEN iff its STORED params carry this route's evidence token version + manifest
//     token (the contract's liveParamsExtra; the shadow's route / rev never reach the live row). Anything else is
//     PAID-OWNED and NEVER replaced: equal content -> current (the proof marker below, zero writes), different content
//     -> 'superseded-newer-live:paid-owned' (zero writes). Never a CAS over it -- in resolve (the predicate, prepare b1 /
//     b2) AND in publishGuard (inside the lease, fresh).
//   - FILL: only when no exact row exists at {to: salesAsOf} (or it is route-written), the SERVED row's sales as-of
//     (params.to / payload.asOf) is STRICTLY older ('superseded-newer-live:served-newer-to'), no served / exact row holds
//     a newer inventory day / fetch or AWD fetch ('superseded-newer-live:served-newer-inventory|awd'), and no PAID job
//     can still publish at >= salesAsOf: the NEWEST FOREIGN (non-route-lineage) fba-plan job is read with its cycle
//     (FBA_PLAN_FOREIGN_JOB_SQL through the CLI's verified read-only pg client -- getLatestReportJobLineage carries no
//     cycle_date): validated + still the LATEST job + its shadow not yet live -> ordered by sales as-of
//     (':paid-publish-pending:to') then per component (':paid-publish-pending:inventory|awd'); not yet validated with
//     its cycle pending / running -> 'paid-job-in-flight' (retryable) when its cycle_date >= the epoch, and
//     'paid-job-stale-in-flight' (retryable + ALERT) when it was created > 6 h ago; an in-flight job of an OLDER
//     cycle_date (it can only carry an older inventory day: the paid op's cycle_date IS its inventoryAsOf,
//     fba-plan-operation.js advanceFbaPlanBucket) and a validated job that is no longer the latest (the four-gate
//     publisher promotes ONLY the latest job) never block.
//   - NO OPEN PAID CYCLE: a paid fba-plan operation opens its cycle BEFORE its fba-plan report job exists: the dispatch
//     (sync-dispatch.js runSchedulerV2Shadow) runs its first source round, then calls runReportJobs in the SAME
//     invocation (sync-dispatch.js ~:421-430), which upserts EVERY planned report job up front (report-worker.js
//     ~:398-410) -- so the job lands SECONDS after the cycle opened on a cache-hit re-run (a DSC re-sync, a bootstrap
//     wave, a natural cycle reusing the 20 h source-export cache), longer when real exports are created (its owners are
//     recorded at planning, source-worker.js:742, before any export). So the route also reads
//     (FBA_PLAN_PAID_CYCLE_SQL, one read-only statement) every PENDING / RUNNING sync_cycles row that can still produce
//     an fba-plan paid job for the account (fbaPlanPaidCycleBuckets): an ACTIVE one (last activity of the cycle row, its
//     source jobs or its report jobs within FBA_PLAN_PAID_CYCLE_ACTIVE_MS = 6 h) defers 'paid-cycle-open:<bucket>'
//     (retryable, zero writes; in publishGuard zero CAS); one idle longer than that on the CURRENT epoch (cycle_date >=
//     the epoch) defers 'paid-cycle-stale-open:<bucket>' (retryable + ALERT: a stuck paid cycle -- it stops blocking
//     when the epoch rolls past it or the reaper closes it, never forever); an idle one of an OLDER epoch never blocks
//     (it can only resume into an older inventory day) and is logged once. Why 6 h: the paid operation is bounded-
//     resumable -- a continuation slice re-enters the SAME cycle (open_sync_cycle touches updated_at; its source / report
//     jobs touch theirs), and the scheduler-recovery re-dispatch reaches it well within that; a cycle silent for longer
//     is stuck, not in progress. This closes the paid-job-not-yet-created window. RESIDUAL (not closable from this
//     module): a paid cycle that was NOT open at the route's last cycle check (b2) opens in the ~sub-second between b2
//     and the route's job insert AND inserts its fba-plan job inside the ~1-RTT gap between the generic release's
//     FINAL latest-job re-read and its upsertReportJob (a job landing before that re-read defers
//     'lineage-advanced-before-write'; one landing after the route's insert is the latest job and wins). No runtime
//     hook runs between that re-read and the upsert (route-publication-release.js is not this package's file), so a
//     cycle re-read cannot be placed there; the publishGuard post-insert check ('paid-job-raced-insert', zero CAS) is
//     the backstop, and only an atomic compare-and-insert (WP12) removes the interleaving.
//   - STAMP INVERSION (round-4 verifier P2): the route stamps with the durable pointer's validated_at (the PERSIST
//     instant, after the paid fetch it holds), so a later PAID publish of the SAME D-1 built from CACHED fetches (DSC
//     re-sync, bootstrap wave, natural cycle with 20 h cache hits -- its shadow stamped at the cached fetch) is OLDER
//     than the route row: the fenced CAS refuses it 'newer-live' and fba-plan-operation counts that as success. The
//     route therefore reads such a job as the 'refused' paid slot (readPaidPending: the validated LATEST foreign job,
//     its live identity a ROUTE-written row stamped at / after its shadow, DIFFERENT masked content) and refuses
//     'superseded-newer-live:paid-publish-refused-by-route-stamp' (an ALERT: the page does not show the paid
//     content; never the benign 'evidence-instant-not-advanced'), so it never re-derives over -- never orphans -- that
//     shadow. It releases it ONLY by CONVERGENCE: its evidence instant strictly after the route row AND its derive
//     content-equivalent to the refused shadow (e.g. the paid op's durable persist re-recorded that fetch later) -- the
//     paid content then goes live through the route row. OWNER-LEVEL COMPLETE FIX (outside this route's files, NOT
//     implemented here): either (1) record the paid FETCH instant durably -- e.g. a fetched_at on the durable FBA /
//     Listings pointer (fba-durable-source-persist.js + the source_snapshots / source_listings_snapshot DDL, copied from
//     the source-export cache fetched_at) -- and stamp route rows STRICTLY BELOW it (max over components of fetched_at,
//     never validated_at), so every later paid publish of the same or a newer fetch out-ranks the route row in the
//     IfNewer CAS; or (2) let the paid operation (fba-plan-operation.js publish phase / report-publisher.js) treat
//     'newer-live' against a ROUTE-OWNED live row as NOT-success (retry / alert, or publish over it), so a paid run
//     never reports success while the page keeps route content.
//   - ROUTE-OVER-ROUTE: a route-written exact row is replaced when the durable evidence moved (fenced CAS, stamp-ordered).
//   - STAMP (stampPolicy 'evidence'): source_refreshed_at = max(FBA validated_at, AWD validated_at when used) -- the
//     PAID-FETCH-DERIVED instants only (never OLI coverage / catalog, never the wall clock), so any later genuinely new
//     paid fetch out-ranks a route row in the fenced IfNewer CAS and an unrelated OLI re-ack can never lift a route row
//     above paid data. ACCEPTED CONSEQUENCE: an OLI / catalog-only change of a ROUTE row defers
//     'evidence-instant-not-advanced' (the generic release; typed, zero writes, never current) until the next paid fetch
//     or D-1 -- for fba-plan the benign 'awaiting-next-fba-fetch' class (no alert).
//   - CURRENT PREDICATE (content equivalence, replacing the job-lineage binding for this route): the served row
//     (selectExactThenLatest, exact {to: marketplaceToday(directory country)}) is current iff it IS the {to: salesAsOf}
//     row AND stableJson(omit(served.payload, {inventoryFetchedAt, awdFetchedAt})) === the same of the durable derive,
//     with the two directory display labels {accountName, marketCountry} also masked (fbaPlanRouteContentVerdict: the
//     route reads them from the durable directory, the paid job from its DataDoe accounts GET -- a label-only drift is
//     current + logged, never a flip-flop republish nor a NEWER_LIVE loop). A PAID row with equal content is therefore
//     current -- steady state has ZERO writes -- and the verdict carries the content-equivalence PROOF marker
//     { proof: ROUTE_PROOF_CONTENT_EQUIVALENT, h, sra } of the SERVED row it compared, so --verify-exact honours it (a
//     paid row has no route lineage). Otherwise: an exact-today refresh row (the paid refresh=1) holds the served slot
//     -> DEFERRED 'served-row-preempted:exact-today-row'; a served sales as-of NEWER than salesAsOf ->
//     'superseded-newer-live:served-newer-to'; a paid-owned {to: salesAsOf} row with different content ->
//     'superseded-newer-live:paid-owned'; any other FILL-ONLY refusal -> its typed deferral; else STALE.
//   - EPOCH: it MUST be the CURRENT inventory D-1 -- fbaInventoryAsOf(now()), the SAME helper the paid job resolves its
//     inventory day with -- else every account is ineligible 'epoch-not-current-d1' (an arbitrary / stale --as-of never
//     derives).
//   - PUBLISH GUARD (inside the control lease, after verifyLease, immediately before publisher.publish -- the paid
//     publisher needs the SAME lease, so this check cannot race it): prepared.guard { salesAsOf, inventoryAsOf,
//     fbaValidatedAt, awdValidatedAt, awdApplicable, foreignJobId } (stableJson-equal at b1 / b2); the latest job must
//     still BE this prepared derivation, the newest foreign job must still be the one the resolve saw (else
//     'paid-job-raced-insert': a paid job inserted inside the generic release's residual window between its last
//     latest-job re-read and its job insert -- see the residual note at publishGuard), and the SAME pure fill-only
//     verdict (fbaPlanLiveGuard) over FRESH served / exact rows + the fresh foreign job must pass. Zero CAS otherwise.
//   - ACTIVATION GATE: a LIVE write is refused unless the owner attestation FBA_PLAN_ROUTE_FENCE_ATTESTED === 'true'
//     (exactly; read ONCE at build from deps.env, else process.env) -- set ONLY after WP10b (refresh=1 read-only) is
//     deployed AND the WP15 writer fence for fba-plan is ON. Unattested: the release's derive hook (reached ONLY by
//     the live prepare, before any cycle / job / shadow write) throws the typed 'fba-plan-route-fence-not-attested'
//     (a hard, non-retryable derive failure: the unit's STOP, zero writes) and publishGuard refuses the resume path
//     (zero CAS). Dry-run scans and --verify-exact (the predicate + resolveBundle only) are unaffected.
//   - salesAsOf: the region's go-live as-of from the durable directory region accounts' OLI coverage (resolveFbaPlanScope
//     -- the paid job's pure function; maxBlocked 2, ceiling = the epoch = inventoryAsOf = UTC D-1), cross-checked
//     against the worker token's resolveGoLiveAsOf over the SAME rows (a disagreement defers, fail closed). An account
//     whose proven OLI does not reach it is DEFERRED_PROVENANCE 'oli-coverage-short'.
//   - postPublish: the fba_account_sku_ownership backfill (scripts/backfill-fba-ownership.mjs, the module
//     fba-plan-release-composition.js uses) SCOPED to the published account; non-fatal (the release logs a failure).
// Evidence reads: the SHARED metadata SQL of lib/server/recovery/routes/fba-plan.route.js through the CLI's verified
// read-only pg client (the worker evaluates the same SQL + compose -> the same L1 token). The region-wide read (4 SQL +
// the sales-date resolver) is MEMOIZED per (epoch, region, org) for the run ONLY for the scan-level current predicate
// (which evaluates exactly the evidence the scan classified; ctx.revision still guards it); every read the generic
// release's TOCTOU relies on -- readScopeEvidence itself (the scan + the publish-time token re-read) and resolveBundle
// (prepare b1 / b2, verify-exact) -- is ALWAYS fresh. Payloads: the content-hash-verified durable storage reader (a
// bounded content-addressed memo). The served / exact live rows, the latest job, a pending foreign shadow: the injected
// report_snapshots / sync_report_jobs readers (read-only facade); the newest foreign job + its cycle and the open paid
// cycles: ONE read-only statement each (FBA_PLAN_FOREIGN_JOB_SQL / FBA_PLAN_PAID_CYCLE_SQL) through the verified
// read-only pg client -- always fresh. Every read threads the
// caller's AbortSignal where the reader supports it. 7-bit ASCII, LF.

import { deriveReportSnapshot } from "../report-derivation.js";
import { resolveFbaPlanScope, fbaInventoryAsOf } from "../fba-plan-operation.js";
import { resolveDataDoeAccountIds } from "../../datadoe-connections.js";
import { accountInScope, REGION_SCOPES, ROUTING_SCOPES, FBA_SUFFIX } from "../scheduler-scope.js";
import { regionAccountIds, ROUTE_PROOF_CONTENT_EQUIVALENT } from "../route-publication-release.js";
import { PUBLICATION_STATE, isCalendarDate, jobIsPromotable } from "../publication-binding.js";
import { RECONCILE_STATUS } from "../saved-data-reconciler.js";
import { FBA_PLAN_ROUTE_ID, FBA_PLAN_EVIDENCE_SQL, FBA_PLAN_MAX_BLOCKED, FBA_PLAN_TOKEN_PREFIX, composeFbaPlanEvidence, offsetInstantMs } from "../../recovery/routes/fba-plan.route.js";
import {
  evaluateFbaPlanEvidence, resolveFbaPlanDependencyBundle, ambiguousRawSellerAccounts, fbaPlanRouteContentVerdict,
  fbaPlanLiveGuard, fbaPlanAwdRegressionReason, fbaPlanRowSalesAsOf, FBA_PLAN_MANIFEST_PREFIX, FBA_PLAN_STALE_IN_FLIGHT_MS,
  FBA_PLAN_SERVED_NEWER_TO, FBA_PLAN_PAID_RACED_INSERT, FBA_PLAN_PAID_CYCLE_ACTIVE_MS, FBA_PLAN_PAID_CYCLE_STALE_OPEN,
  FBA_PLAN_PAID_REFUSED_BY_ROUTE_STAMP, fbaPlanRowOwner,
} from "../fba-plan-dependency-bundle.js";

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";
const PUBLISHER_KEY = "fba-plan";
const SHADOW_KEY = "scheduler-v2/" + PUBLISHER_KEY;
const CYCLE_STATES = new Set(["pending", "running", "succeeded", "partial", "failed"]);
// The publishGuard verdict states (route-publication-release.js PUBLISH_GUARD_STATES).
const GUARD_NEWER_LIVE = "NEWER_LIVE";
const PAYLOAD_MEMO_MAX = 12; // content-addressed durable payloads (org catalog + per-account FBA / AWD) kept per run
const REGION_MEMO_MAX = 4; // scan-level region evidence reads kept per run (one per (epoch, region, org) in practice)

// THE ACTIVATION GATE (see the header): the owner attestation env var, read ONCE at build. ONLY the exact string
// 'true' attests (unset / 'TRUE' / '1' / ' true' / a boolean -> NOT attested: fail closed) -- the same pattern as
// SKU_MOVEMENT_SERVE_TOKEN_ATTESTED / LHV3_SERVE_GATE_ATTESTED. Set it ONLY after WP10b (dashboard refresh=1 read-only for
// fba-plan) is DEPLOYED and the WP15 writer fence for 'fba-plan' is ON (report_publication_writer_fence.fenced_only).
export const FBA_PLAN_ROUTE_FENCE_ATTESTED_ENV = "FBA_PLAN_ROUTE_FENCE_ATTESTED";
export const FBA_PLAN_ROUTE_FENCE_NOT_ATTESTED = "fba-plan-route-fence-not-attested";
export function fbaPlanRouteFenceAttested(env) {
  return !!(env && typeof env === "object" && env[FBA_PLAN_ROUTE_FENCE_ATTESTED_ENV] === "true");
}

// THE NEWEST FOREIGN fba-plan JOB of ONE account + its owning cycle, in ONE read-only statement (one snapshot): the
// newest (created_at desc, id desc) sync_report_jobs row for ('fba-plan', $1) that is NOT this route's lineage -- a job is
// route lineage iff its durable_content_deps (jsonb array) holds BOTH a current-version evidence token ($2 = the
// FBA_PLAN_TOKEN_PREFIX + '%') AND a manifest token ($3 = FBA_PLAN_MANIFEST_PREFIX + '%'), exactly what the generic
// release records -- with its cycle's status and cycle_date (::text: never a JS Date of a Postgres date on an IST
// host), plus latest_id = the id of the newest job of ANY lineage (the only one the four-gate publisher promotes, in the
// SAME created_at order as getLatestReportJobLineage). Metadata only (no payload). getLatestReportJobLineage carries no
// cycle_date, and supabase.js is not this package's file -- the route CLI's verified read-only pg client (pgReadOnly:
// single SELECT inside a READ ONLY transaction) is the release's own read-only query path.
export const FBA_PLAN_FOREIGN_JOB_SQL = Object.freeze({
  name: "fba_plan_foreign_job",
  text: "select j.id::text as id, j.cycle_id::text as cycle_id, j.derive_status, j.save_status, j.validated, j.snapshot_params_hash, j.created_at, c.status as cycle_status, c.cycle_date::text as cycle_date, (select l.id::text from public.sync_report_jobs l where l.report_key = 'fba-plan' and l.account_id = $1 order by l.created_at desc, l.id desc limit 1) as latest_id from public.sync_report_jobs j join public.sync_cycles c on c.id = j.cycle_id where j.report_key = 'fba-plan' and j.account_id = $1 and not (exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(j.durable_content_deps) = 'array' then j.durable_content_deps else '[]'::jsonb end) as d(dep) where d.dep like $2) and exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(j.durable_content_deps) = 'array' then j.durable_content_deps else '[]'::jsonb end) as d(dep) where d.dep like $3)) order by j.created_at desc, j.id desc limit 1",
  params: (accountId) => [String(accountId == null ? "" : accountId), FBA_PLAN_TOKEN_PREFIX + "%", FBA_PLAN_MANIFEST_PREFIX + "%"],
});

/**
 * The sync_cycles buckets that can produce an fba-plan PAID job for an account of `country` (PURE; read from the code,
 * the sync_cycles bucket CHECK being 20260924_priority_partial_cycle_bucket.sql:40-42):
 *   dedicated  '<scope>-fba' for EVERY routing scope covering the country (region: india-fba / europe-au-fba /
 *              us-ca-fba; legacy: us-fba / non-us-fba) -- fba-plan-operation.js:41 fbaCycleBucket + :219
 *              (advanceFbaPlanBucket's cycle), the ONE core behind the scheduled go-live (scripts/release/
 *              fba-plan-golive.mjs:226, --region | legacy --bucket) AND the Data Sync Center paid FBA sync
 *              (api/admin/sources.js:436-448, legacy bucket us | non-us, :313-314). Always fba-plan-only (manualReportKeys
 *              ['fba-plan'], fba-plan-operation.js:266) -> an open one blocks unconditionally;
 *   bootstrapLike 'bootstrap-fba-<region>-%' -- the wave-bound bootstrap FBA go-live (account-onboarding.js:377-386
 *              bootstrapFbaCycleBucket; fba-plan-golive.mjs:241 cycleBucketOverride) -> blocks unconditionally;
 *   natural    the routing scopes themselves ('<region>' / 'us' | 'non-us') + 'bootstrap-<region>-%' -- a scheduler-v2
 *              natural cycle plans fba-plan only when it is SELECTED (report_sync_settings.schedule_enabled, which every
 *              dispatch keeps paused outside the fba operation's own control window, or an explicit manual key;
 *              sync-dispatch.js:75 selectSchedulerV2ReportKeys; the priority / bootstrap dashboards path never does,
 *              source-priority-dashboards.js:35) -> blocks ONLY when it holds an fba-plan source-job OWNER
 *              (sync_source_job_owners.report_key = 'fba-plan', written at planning before any export).
 * NOT paid fba-plan cycles (excluded by construction): 'priority-partial-*' (this route's own cycles + the priority
 * release), 'listing-health-v3-<region>' (listing-health-v3 jobs only). The manual source-sync operator
 * (scripts/release/manual-source-sync.mjs: FBA structurally absent), fba-inventory-recovery.mjs (source cache only) and
 * fba-durable-source-replay.mjs (source_snapshots only) open NO cycle that produces an fba-plan job.
 * -> { dedicated: [..], bootstrapLike, natural: [..], naturalLike, region } | null (no routing scope: fail closed)
 */
export function fbaPlanPaidCycleBuckets(country) {
  const c = S(country).trim().toUpperCase();
  if (!c) return null;
  const scopes = ROUTING_SCOPES.filter((s) => { try { return accountInScope(s, c); } catch { return false; } });
  const region = scopes.find((s) => REGION_SCOPES.includes(s)) || null;
  if (!region) return null;
  return {
    dedicated: scopes.map((s) => s + FBA_SUFFIX).sort(),
    bootstrapLike: "bootstrap-fba-" + region + "-%",
    natural: [...scopes].sort(),
    naturalLike: "bootstrap-" + region + "-%",
    region,
  };
}
// The OPEN (pending / running) sync_cycles that can still produce an fba-plan paid job (see fbaPlanPaidCycleBuckets),
// in ONE read-only statement: id, bucket, status, cycle_date ::text (never a JS Date of a Postgres date) and the LAST
// ACTIVITY = greatest(the cycle row's updated_at, max(updated_at) of its source jobs, max(updated_at) of its report jobs)
// -- every progress write touches one of them (touch_updated_at triggers, 20260807_scheduler_v2.sql:167-175;
// open_sync_cycle re-entry touches the cycle). $1 dedicated buckets, $2 the bootstrap-fba LIKE, $3 natural buckets, $4
// the natural bootstrap LIKE (the last two only with an fba-plan owner). Metadata only.
export const FBA_PLAN_PAID_CYCLE_SQL = Object.freeze({
  name: "fba_plan_paid_cycles",
  text: "select c.id::text as id, c.bucket, c.status, c.cycle_date::text as cycle_date, greatest(c.updated_at, coalesce((select max(s.updated_at) from public.sync_source_jobs s where s.cycle_id = c.id), c.updated_at), coalesce((select max(r.updated_at) from public.sync_report_jobs r where r.cycle_id = c.id), c.updated_at)) as last_activity_at from public.sync_cycles c where c.status in ('pending', 'running') and (c.bucket = any($1::text[]) or c.bucket like $2 or ((c.bucket = any($3::text[]) or c.bucket like $4) and exists (select 1 from public.sync_source_job_owners o where o.cycle_id = c.id and o.report_key = 'fba-plan'))) order by c.bucket, c.cycle_date, c.id",
  params: (b) => [b.dedicated, b.bootstrapLike, b.natural, b.naturalLike],
});

const st = (state, reason, extra = {}) => ({ state, reason, ...extra });
const deferDep = (reason) => st(RECONCILE_STATUS.DEFERRED_DEPENDENCY, reason);
const deferProv = (reason) => st(RECONCILE_STATUS.DEFERRED_PROVENANCE, reason);
const stale = (reason) => st(PUBLICATION_STATE.STALE, reason);

// The production ownership backfill, scoped to ONE published account (zero DataDoe; atomic per-account replace).
async function productionOwnershipBackfill({ accountId }) {
  const mod = await import("../../../../scripts/backfill-fba-ownership.mjs");
  return mod.backfillFbaOwnership({ dry: false, readers: { listAccounts: async () => [S(accountId)] } });
}

/**
 * Build the fba-plan route RUNTIME from the CLI deps (publication-route-reconcile.mjs: { bucket, epoch, directory, orgFp,
 * connectionId, primaryConnection, connections, sb (READ-ONLY facade), pgReadOnly, selectors, computeHash, liveContracts,
 * reportDerivations, marketplaceToday, normalizeMarketplace, now, strict, log }). A build-time test seam may also inject
 * ownershipBackfill({ accountId }) and env (the ACTIVATION GATE's attestation source; default process.env). Fails
 * CLOSED on any missing collaborator.
 */
function build(deps = {}) {
  const {
    bucket, epoch, directory, orgFp, connectionId = "primary", primaryConnection, connections, sb, pgReadOnly, selectors,
    computeHash, liveContracts, marketplaceToday, now = () => Date.now(), log = () => {},
  } = deps;
  const ownershipBackfill = typeof deps.ownershipBackfill === "function" ? deps.ownershipBackfill : productionOwnershipBackfill;
  // THE ACTIVATION GATE, read ONCE (deps.env when injected -- tests / a future runner --, else the CLI's process env).
  const fenceAttested = fbaPlanRouteFenceAttested(deps.env && typeof deps.env === "object" ? deps.env : process.env);
  const need = (cond, what) => { if (!cond) throw new Error("fba-plan route build requires " + what + " (fail closed)."); };
  need(directory instanceof Map, "the durable directory");
  need(nb(orgFp), "the organization fingerprint");
  need(connectionId === "primary", "the primary connection id");
  need(primaryConnection && nb(primaryConnection.apiKey), "the primary connection (D-1 request identity)");
  need(Array.isArray(connections) && connections.length > 0, "the DataDoe connection map (LOCAL raw seller resolution)");
  need(sb && ["getReportSnapshot", "getLatestReportSnapshot", "getLatestReportJobLineage", "getSourceSnapshotPayload", "getSourceOliHistoryRows", "sourceSnapshotObjectPath"].every((f) => typeof sb[f] === "function"), "the read-only durable readers");
  need(typeof pgReadOnly === "function", "the verified read-only pg query");
  need(selectors && typeof selectors.selectExactThenLatest === "function", "the serve selectors");
  need(typeof computeHash === "function", "computeHash");
  need(typeof marketplaceToday === "function", "marketplaceToday");
  const contract = liveContracts && liveContracts[PUBLISHER_KEY];
  need(contract && contract.liveReportKey === "fba-plan" && nb(contract.liveReportVersion), "the fba-plan live contract");
  const apiKey = S(primaryConnection.apiKey);
  const buildObjectPath = (a) => sb.sourceSnapshotObjectPath(a);
  if (!fenceAttested) log("fba-plan: " + FBA_PLAN_ROUTE_FENCE_ATTESTED_ENV + " is not exactly 'true' -- every LIVE fba-plan write is REFUSED ('" + FBA_PLAN_ROUTE_FENCE_NOT_ATTESTED + "', zero writes); dry-run / verify-exact are unaffected");

  // Content-addressed durable payload memo (the object path embeds the payload sha; the reader re-verifies it), bounded
  // LRU -- the org catalog + per-account FBA / AWD payloads are read by the scan's predicate AND the prepare's b1/b2.
  const memo = new Map();
  const loadSnapshotPayload = (objectPath, { signal = null } = {}) => {
    const k = S(objectPath);
    if (memo.has(k)) { const hit = memo.get(k); memo.delete(k); memo.set(k, hit); return hit; }
    const p = Promise.resolve().then(() => sb.getSourceSnapshotPayload(k, { signal }));
    memo.set(k, p);
    p.catch(() => { if (memo.get(k) === p) memo.delete(k); });
    while (memo.size > PAYLOAD_MEMO_MAX) memo.delete(memo.keys().next().value);
    return p;
  };
  const readOliHistory = (q) => sb.getSourceOliHistoryRows(q);
  const localRawSellerId = (id) => { try { const r = resolveDataDoeAccountIds([id], connections); return r && Array.isArray(r.rawAccountIds) && r.rawAccountIds.length === 1 ? S(r.rawAccountIds[0]) : ""; } catch { return ""; } };

  // ---- evidence (metadata; the SHARED worker SQL + compose) ---------------------------------------------------------
  // The validated (epoch, region, org, directory) of an evidence read, or its typed failCode.
  function evidenceArgs({ epoch: epochArg, bucket: bucketArg, directory: dirArg, organizationFingerprint } = {}) {
    const dir = dirArg instanceof Map ? dirArg : directory;
    const ep = S(epochArg || epoch);
    const region = S(bucketArg || bucket);
    const org = S(organizationFingerprint || orgFp);
    if (!isCalendarDate(ep)) return { ok: false, failCode: "FBA_PLAN_EPOCH_INVALID" };
    if (org !== S(orgFp)) return { ok: false, failCode: "FBA_PLAN_ORG_MISMATCH" };
    return { ok: true, dir, ep, region, org };
  }

  // ONE region-wide evidence read (always FRESH): the 4 metadata statements, the paid job's resolveFbaPlanScope cross-
  // check, the duplicate-seller guard and the epoch check.
  //   -> { ok:true, dir, org, composed, salesAsOfAgrees, ambiguous, epochCurrent } | { ok:false, failCode }
  async function readRegionEvidence({ dir, ep, region, org, signal = null }) {
    const regionIds = regionAccountIds(dir, region, accountInScope);
    const rows = {};
    try {
      // Sequential: the CLI's read-only client runs one READ ONLY transaction per statement (abort rechecked between).
      for (const q of FBA_PLAN_EVIDENCE_SQL) {
        if (signal && signal.aborted) return { ok: false, failCode: "FBA_PLAN_EVIDENCE_ABORTED" };
        rows[q.name] = await pgReadOnly(q.text, q.params({ organizationFingerprint: org, accountIds: regionIds }));
      }
    } catch (_e) {
      return { ok: false, failCode: "DURABLE_SOURCE_UNREADABLE: fba-plan evidence read failed" };
    }
    const composed = composeFbaPlanEvidence(rows, { epoch: ep, directory: dir, region, accountIds: regionIds });
    // The paid job's pure resolveFbaPlanScope over the SAME coverage rows must agree with the token's salesAsOf.
    let scopeAsOf = null;
    let scopeOk = true;
    try {
      const covOf = (id) => ((composed.perAccount.get(id) || {}).coverage || []).map((w) => ({ from: w.from, to: w.to }));
      const scopeRes = await resolveFbaPlanScope({
        accounts: regionIds.map((id) => ({ accountId: id, country: S((dir.get(id) || {}).country) })),
        connections, maxBlocked: FBA_PLAN_MAX_BLOCKED, ceiling: ep,
        readers: {
          resolveDataDoeAccountIds,
          getSourceCoverageWindows: async ({ organizationFingerprint: o, connectionId: c, accountId, sourceKey }) => (S(o) === org && S(c) === "primary" && sourceKey === "order-line-items" && regionIds.includes(S(accountId))
            ? { read: "ok", windows: covOf(S(accountId)) } : { read: "read-failed", windows: [] }),
        },
      });
      scopeAsOf = scopeRes && scopeRes.asOf ? S(scopeRes.asOf) : null;
    } catch (_e) { scopeOk = false; }
    const regionSales = composed.salesAsOfByRegion.get(region) || { asOf: null };
    const salesAsOfAgrees = scopeOk && S(scopeAsOf) === S(regionSales.asOf);
    const ambiguous = ambiguousRawSellerAccounts({ accounts: regionIds.map((id) => { const m = dir.get(id) || {}; return { accountId: id, rawSellerId: S(m.rawSellerId), marketplace: S(m.marketplace) }; }), connections });
    // THE EPOCH (never go backwards): it (= inventoryAsOf) must be the CURRENT inventory D-1 -- fbaInventoryAsOf(now()),
    // the SAME helper the paid job derives its inventory day from. A stale / arbitrary --as-of would otherwise derive
    // an OLDER inventory day under a live key ({to: salesAsOf}) the paid job may already have filled with a newer one.
    // CLASSIFICATION (WP11): 'epoch-not-current-d1' reaches the reconciler core in THREE shapes -- BARE from the scan's
    // computeRevision (the ineligible revision -> DEFERRED_PROVENANCE), 'bundle-epoch-not-current-d1' from a prepare
    // resolve (DEFERRED_DEPENDENCY), and as 'evidence-advanced' from the publish-time token re-read. It is an OPERATOR
    // ALERT only when the run's --as-of != fbaInventoryAsOf(run START) (a mis-configured runner). When --as-of WAS the
    // D-1 at run start, the UTC midnight simply rolled mid-run (the scan, a prepare or the publish crossed 00:00Z): a
    // plain RETRY -- the next run passes the new D-1 -- never an alert and never superseded (zero writes either way).
    let epochCurrent = false;
    try { epochCurrent = ep === fbaInventoryAsOf(Number(now())); } catch { epochCurrent = false; }
    return { ok: true, dir, org, composed, salesAsOfAgrees, ambiguous, epochCurrent };
  }

  // The per-account evidence of `scope` from one region read (the shape computeRevision / the bundle consume).
  function perAccountOf(re, scope) {
    const perAccount = new Map();
    for (const a of (Array.isArray(scope) ? scope : []).map(S)) {
      const e = re.composed.perAccount.get(a);
      perAccount.set(a, e
        ? { ...e, organizationFingerprint: re.org, inRegion: true, directoryMissing: !re.dir.has(a), ambiguous: re.ambiguous.has(a), salesAsOfAgrees: re.salesAsOfAgrees, epochCurrent: re.epochCurrent, resolvedRawSellerId: localRawSellerId(a) }
        : { accountId: a, organizationFingerprint: re.org, inRegion: false, directoryMissing: !re.dir.has(a), epochCurrent: re.epochCurrent });
    }
    return perAccount;
  }

  // The SCAN-LEVEL memo (the current predicate ONLY -- see the header): region evidence per (epoch, region, org) for the
  // run's build directory. Seeded by every fresh readScopeEvidence (the scan's own read), filled on a miss; a failed
  // read is never kept. Never consulted by readScopeEvidence or resolveBundle (the TOCTOU re-reads stay fresh).
  const regionMemo = new Map();
  const regionMemoKey = (a) => JSON.stringify([a.ep, a.region, a.org]);
  const memoPut = (k, p) => {
    regionMemo.delete(k);
    regionMemo.set(k, p);
    while (regionMemo.size > REGION_MEMO_MAX) regionMemo.delete(regionMemo.keys().next().value);
  };
  function scanRegionEvidence(a) {
    if (a.dir !== directory) return readRegionEvidence(a);
    const k = regionMemoKey(a);
    if (regionMemo.has(k)) return regionMemo.get(k);
    const p = readRegionEvidence(a).catch(() => ({ ok: false, failCode: "DURABLE_SOURCE_UNREADABLE: fba-plan evidence read failed" }));
    memoPut(k, p);
    p.then((r) => { if ((!r || r.ok !== true) && regionMemo.get(k) === p) regionMemo.delete(k); });
    return p;
  }

  // THE HOOK: always a FRESH region read (the scan + the publish-time token re-read); it seeds the scan-level memo.
  async function readScopeEvidence({ scope = [], epoch: epochArg, bucket: bucketArg, directory: dirArg, organizationFingerprint, signal = null } = {}) {
    const a = evidenceArgs({ epoch: epochArg, bucket: bucketArg, directory: dirArg, organizationFingerprint });
    if (!a.ok) return { ok: false, failCode: a.failCode };
    const re = await readRegionEvidence({ ...a, signal });
    if (!re.ok) return { ok: false, failCode: re.failCode };
    if (a.dir === directory) memoPut(regionMemoKey(a), Promise.resolve(re));
    return { ok: true, perAccount: perAccountOf(re, scope) };
  }

  // PURE: the account's L1 revision (revisionId === evidenceToken === the worker's token) or a typed ineligibility.
  function computeRevision({ accountId, evidence } = {}) {
    const e = evidence && typeof evidence === "object" ? evidence : null;
    const no = (reason) => ({ eligible: false, reason });
    if (!e || S(e.accountId) !== S(accountId)) return no("evidence-missing");
    if (e.epochCurrent !== true) return no("epoch-not-current-d1");
    if (e.directoryMissing === true) return no("directory-missing");
    if (e.inRegion !== true) return no("account-out-of-region");
    if (e.ambiguous === true) return no("pan-eu-ambiguous");
    if (e.salesAsOfAgrees !== true) return no("sales-asof-mismatch");
    if (!nb(e.resolvedRawSellerId) || S(e.resolvedRawSellerId) !== S(e.rawSellerId)) return no("raw-seller-mismatch");
    const v = evaluateFbaPlanEvidence(e, { apiKey, buildObjectPath, organizationFingerprint: S(e.organizationFingerprint), connectionId });
    if (!v.ok) return no(v.reason);
    return { eligible: true, revisionId: S(e.token), evidenceToken: S(e.token), deps: v.deps, status: "available" };
  }

  // ---- the served row (+ its full params / payload, captured from the SAME reads the pure selector made) -------------
  async function readServed(accountId, { signal = null } = {}) {
    const m = directory.get(S(accountId));
    let today;
    try { today = marketplaceToday(S(m && m.country), new Date(Number(now()))); } catch { return { row: null, reason: "read-failed", via: null, full: null, today: null }; }
    const got = { exact: null, latest: null };
    const readers = {
      getReportSnapshot: async (a) => { const r = await sb.getReportSnapshot(a, { signal }); got.exact = r || null; return r; },
      getLatestReportSnapshot: async (a) => { const r = await sb.getLatestReportSnapshot(a); got.latest = r || null; return r; },
    };
    let sel;
    try { sel = await selectors.selectExactThenLatest({ reportKey: contract.liveReportKey, accountId: S(accountId), reportVersion: contract.liveReportVersion, params: { to: today }, readers, computeHash }); }
    catch { sel = { row: null, reason: "read-failed", via: null }; }
    const cand = sel.row ? got[sel.via] : null;
    return { row: sel.row, reason: sel.reason, via: sel.via, today, full: cand && S(cand.id) === S(sel.row.id) ? cand : null };
  }

  // ---- the fill-only guard rows (fba-plan-dependency-bundle.js readLiveRows / readPaidPending) ----------------------
  // A report_snapshots row's payload STORAGE-FIRST (a nonblank payload_storage_path is authoritative, hydrated through the
  // read-only facade's storage reader) -> a plain object, or null (unreadable / absent / malformed).
  async function rowPayload(row, signal) {
    let payload = null;
    const path = S(row && row.payload_storage_path).trim();
    if (path) {
      if (typeof sb.getReportSnapshotStoragePayload !== "function") return null;
      try { payload = await sb.getReportSnapshotStoragePayload(path, { signal }); } catch { return null; }
    } else payload = row ? row.payload : null;
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  }
  // The exact live row at {to: salesAsOf} -- the fenced CAS target -- as a typed slot, with the row's own
  // source_refreshed_at (the ordering's fetch upper bound for a missing / unparseable payload fetch stamp) and its STORED
  // params (the FILL-ONLY ownership: route-written iff they carry this route's tokens).
  async function readExactLive(acct, salesAsOf, { signal = null } = {}) {
    const bad = { state: "unreadable" };
    let liveParams = null;
    try { liveParams = isCalendarDate(S(salesAsOf)) ? contract.liveParams({ to: S(salesAsOf) }) : null; } catch { liveParams = null; }
    if (!liveParams) return bad;
    let paramsHash = "";
    try { paramsHash = S(computeHash(contract.liveReportVersion, liveParams)); } catch { return bad; }
    let row;
    try { row = await sb.getReportSnapshot({ reportKey: contract.liveReportKey, accountId: acct, paramsHash }, { signal }); } catch { return bad; }
    if (!row) return { state: "missing" };
    if (S(row.report_key) !== contract.liveReportKey || S(row.account_id) !== acct || S(row.params_hash) !== paramsHash) return bad;
    const payload = await rowPayload(row, signal);
    const params = row.params && typeof row.params === "object" && !Array.isArray(row.params) ? row.params : null;
    return payload && params ? { state: "row", payload, refreshedAt: S(row.source_refreshed_at), params } : bad;
  }
  // The SERVED row (the page's selection) + the exact live row: { served, exact } slots (row | missing | empty |
  // unreadable). A served miss other than a true 'missing' (out-of-line / version-hidden / ...) is EMPTY: the page
  // shows no fba-plan row (the AWD regression guard fails closed on it; the inventory order has nothing to compare).
  async function readLiveRows({ accountId, salesAsOf, signal = null } = {}) {
    const acct = S(accountId);
    const s = await readServed(acct, { signal });
    let served;
    if (s.reason === "read-failed") served = { state: "unreadable" };
    else if (s.row) {
      const ok = s.full && s.full.payload && typeof s.full.payload === "object" && s.full.params && typeof s.full.params === "object" && !Array.isArray(s.full.params);
      served = ok ? { state: "row", payload: s.full.payload, refreshedAt: S(s.full.source_refreshed_at), params: s.full.params } : { state: "unreadable" };
    }
    else served = S(s.reason) === "missing" ? { state: "missing" } : { state: "empty" };
    return { served, exact: await readExactLive(acct, salesAsOf, { signal }) };
  }

  // THE NEWEST FOREIGN (fba-plan, target) JOB as the bundle's paid slot (FILL-ONLY (d); fba-plan-dependency-bundle.js
  // paidSlot). This route's OWN lineage is excluded by the statement itself (the generic release resumes / re-nonces it).
  // The foreign job (its id rides every readable slot as jobId -- publishGuard's post-insert check):
  //   - not promotable:
  //       derive / save failed or skipped, or its cycle terminal                        -> 'none' (nothing to publish);
  //       its cycle pending / running with cycle_date < the epoch                        -> 'none' (P3 liveness: the paid
  //         op's cycle_date IS its inventoryAsOf, so it can only carry an OLDER inventory day; a stuck old cycle never
  //         blocks the route);
  //       ... with cycle_date >= the epoch                                              -> 'in-flight', or
  //         'stale-in-flight' once created more than FBA_PLAN_STALE_IN_FLIGHT_MS ago (retryable + ALERT: a stuck paid
  //         cycle -- WP12's reaper / superseding must close it);
  //   - promotable (validated in a terminal cycle):
  //       no longer the LATEST job (a later -- route -- job exists; the publisher promotes ONLY the latest)   -> 'none';
  //       its shadow absent / not a live identity (the publisher refuses it: 'invalid-snapshot')              -> 'none';
  //       its shadow a route shadow of an older token version (route / rev params; not paid content)          -> 'none';
  //       its live identity already holds a row stamped at or after the shadow (already live / superseded)    -> 'none',
  //         EXCEPT a ROUTE-written live row whose masked content DIFFERS from the shadow -> 'refused' { payload,
  //         refreshedAt, params, liveRefreshedAt } (STAMP INVERSION: the fenced CAS refused the paid publish because
  //         the route row's persist-instant stamp is newer than the cached paid fetch -- see the header);
  //       otherwise 'pending' { payload (storage-first), refreshedAt, params (its sales as-of is params.to) }.
  // Any unreadable / malformed read -> 'unreadable' (fail closed). Every read is fresh.
  async function readPaidPending({ accountId, inventoryAsOf, signal = null } = {}) {
    const bad = { state: "unreadable", jobId: null };
    const acct = S(accountId);
    const epochDay = S(inventoryAsOf);
    if (!nb(acct) || !isCalendarDate(epochDay) || (signal && signal.aborted)) return bad;
    let rows;
    try { rows = await pgReadOnly(FBA_PLAN_FOREIGN_JOB_SQL.text, FBA_PLAN_FOREIGN_JOB_SQL.params(acct)); } catch { return bad; }
    if (!Array.isArray(rows) || rows.length > 1) return bad;
    if (rows.length === 0) return { state: "none", jobId: null };
    const j = rows[0];
    if (!j || typeof j !== "object" || !nb(j.id) || !nb(j.latest_id) || !CYCLE_STATES.has(S(j.cycle_status)) || !isCalendarDate(S(j.cycle_date)) || typeof j.validated !== "boolean") return bad;
    const jobId = S(j.id);
    const lineage = { deriveStatus: j.derive_status, saveStatus: j.save_status, validated: j.validated, cycleStatus: j.cycle_status, snapshotParamsHash: j.snapshot_params_hash };
    if (!jobIsPromotable(lineage)) {
      const cs = S(j.cycle_status);
      const failed = ["failed", "skipped"].includes(S(j.derive_status)) || ["failed", "skipped"].includes(S(j.save_status));
      if (failed || (cs !== "pending" && cs !== "running")) return { state: "none", jobId };
      if (S(j.cycle_date) < epochDay) return { state: "none", jobId };
      const createdMs = offsetInstantMs(j.created_at);
      const stale = Number.isFinite(createdMs) && Number(now()) - createdMs > FBA_PLAN_STALE_IN_FLIGHT_MS;
      return { state: stale ? "stale-in-flight" : "in-flight", jobId };
    }
    if (S(j.latest_id) !== jobId) return { state: "none", jobId };
    const h = S(j.snapshot_params_hash);
    let sh;
    try { sh = await sb.getReportSnapshot({ reportKey: SHADOW_KEY, accountId: acct, paramsHash: h }, { signal }); } catch { return bad; }
    if (!sh) return { state: "none", jobId };
    const params = sh.params && typeof sh.params === "object" && !Array.isArray(sh.params) ? sh.params : null;
    if (S(sh.report_key) !== SHADOW_KEY || S(sh.account_id) !== acct || S(sh.params_hash) !== h || !params) return bad;
    if (S(params.route) === FBA_PLAN_ROUTE_ID && nb(params.rev)) return { state: "none", jobId };
    let liveParams = null;
    try { liveParams = contract.liveParams(params); } catch { liveParams = null; }
    if (!liveParams) return { state: "none", jobId };
    let liveHash = "";
    try { liveHash = S(computeHash(contract.liveReportVersion, liveParams)); } catch { return bad; }
    let live;
    try { live = await sb.getReportSnapshot({ reportKey: contract.liveReportKey, accountId: acct, paramsHash: liveHash }, { signal }); } catch { return bad; }
    const shAt = offsetInstantMs(sh.source_refreshed_at);
    const liveAt = live ? offsetInstantMs(live.source_refreshed_at) : NaN;
    if (live && Number.isFinite(shAt) && Number.isFinite(liveAt) && liveAt >= shAt) {
      // Not a ROUTE row -> a paid / newer writer superseded it (nothing pending). A ROUTE row holding the SAME masked
      // content -> the refusal lost nothing. A ROUTE row with DIFFERENT content -> the paid content is NOT served.
      if (fbaPlanRowOwner(live.params) !== "route") return { state: "none", jobId };
      const livePayload = await rowPayload(live, signal);
      const shPayload = await rowPayload(sh, signal);
      if (!livePayload || !shPayload) return bad;
      if (fbaPlanRouteContentVerdict(livePayload, shPayload).equal) return { state: "none", jobId };
      return { state: "refused", jobId, payload: shPayload, refreshedAt: S(sh.source_refreshed_at), params, liveRefreshedAt: S(live.source_refreshed_at) };
    }
    const payload = await rowPayload(sh, signal);
    return payload ? { state: "pending", jobId, payload, refreshedAt: S(sh.source_refreshed_at), params } : bad;
  }

  // THE OPEN PAID CYCLES as the bundle's cycle slot (fba-plan-dependency-bundle.js cycleSlot; see the header): ACTIVE
  // (last activity within the window, any cycle_date) -> 'open'; idle on the CURRENT epoch (cycle_date >= the epoch) ->
  // 'stale-open'; idle of an OLDER epoch -> ignored (logged once per cycle). An active one outranks a stale one. An
  // unknowable last activity is ACTIVE (fail closed); any malformed row / read failure -> 'unreadable'.
  const loggedStaleCycles = new Set();
  async function readPaidCycles({ accountId, inventoryAsOf, signal = null } = {}) {
    const bad = { state: "unreadable" };
    const acct = S(accountId);
    const epochDay = S(inventoryAsOf);
    const m = directory.get(acct);
    const b = fbaPlanPaidCycleBuckets(S(m && m.country));
    if (!nb(acct) || !isCalendarDate(epochDay) || !b || (signal && signal.aborted)) return bad;
    let rows;
    try { rows = await pgReadOnly(FBA_PLAN_PAID_CYCLE_SQL.text, FBA_PLAN_PAID_CYCLE_SQL.params(b)); } catch { return bad; }
    if (!Array.isArray(rows)) return bad;
    let open = null;
    let stale = null;
    for (const r of rows) {
      if (!r || typeof r !== "object" || !nb(r.id) || !nb(r.bucket) || !["pending", "running"].includes(S(r.status)) || !isCalendarDate(S(r.cycle_date))) return bad;
      const at = offsetInstantMs(r.last_activity_at);
      const active = !Number.isFinite(at) || Number(now()) - at <= FBA_PLAN_PAID_CYCLE_ACTIVE_MS;
      if (active) { if (!open) open = S(r.bucket); continue; }
      if (S(r.cycle_date) >= epochDay) { if (!stale) stale = S(r.bucket); continue; }
      if (!loggedStaleCycles.has(S(r.id))) {
        loggedStaleCycles.add(S(r.id));
        log("fba-plan ALERT " + FBA_PLAN_PAID_CYCLE_STALE_OPEN + ":" + S(r.bucket) + " (cycle_date " + S(r.cycle_date) + " < the epoch " + epochDay + ", idle beyond the activity window) -- an OLDER-epoch stuck paid cycle; NOT blocking");
      }
    }
    if (open) return { state: "open", bucket: open };
    if (stale) return { state: "stale-open", bucket: stale };
    return { state: "none" };
  }

  // ---- the deep bundle (the SAME revision the scan classified) ------------------------------------------------------
  // scanMemo + newerLive 'report': ONLY the route's own current predicate (the scan-level verdict) reads the memoized
  // region evidence and resolves past a FILL-ONLY refusal (it never writes; it proves equal content current, else
  // reports the typed refusal); the resolveBundle HOOK (prepare b1 / b2, verify-exact) always re-reads fresh and REFUSES
  // (paid-owned / a newer sales as-of or component / a pending or in-flight paid job).
  async function resolveBundleWith(unit, { epoch: epochArg, bucket: bucketArg, signal = null, scanMemo = false, newerLive = "refuse" } = {}) {
    const acct = S(unit && unit.targetId);
    const a = evidenceArgs({ epoch: epochArg || epoch, bucket: bucketArg || bucket, directory, organizationFingerprint: orgFp });
    if (!a.ok) return { eligible: false, reason: "evidence-unreadable" };
    if (signal && signal.aborted) return { eligible: false, reason: "aborted" };
    let re;
    try { re = await (scanMemo ? scanRegionEvidence({ ...a, signal }) : readRegionEvidence({ ...a, signal })); }
    catch { re = null; }
    if (!re || re.ok !== true) return { eligible: false, reason: "evidence-unreadable" };
    const e = perAccountOf(re, [acct]).get(acct);
    const rev = computeRevision({ accountId: acct, evidence: e });
    if (!rev.eligible) return { eligible: false, reason: rev.reason };
    const deep = await resolveFbaPlanDependencyBundle(
      // deriveContent: the route's own (ungated, pure) derive -- used ONLY to prove a refused paid shadow's convergence.
      { loadSnapshotPayload, readOliHistory, readLiveRows, readPaidPending, readPaidCycles, connections, buildObjectPath, deriveContent: async (b) => { const r = await derive(b); return r && r.payload ? r.payload : null; } },
      { evidence: e, organizationFingerprint: S(e.organizationFingerprint), connectionId, apiKey, signal, newerLive: newerLive === "report" ? "report" : "refuse" },
    );
    if (!deep.eligible) return { eligible: false, reason: deep.reason };
    // `guard` (the fill-only components + the newest foreign job id) rides the prepare into publishGuard (see the header).
    return { eligible: true, revisionId: rev.revisionId, evidenceToken: rev.evidenceToken, manifestToken: deep.manifestToken, deps: rev.deps, evidenceInstant: deep.evidenceInstant, guard: deep.guard, bundle: deep.bundle, ...(deep.newerLive ? { newerLive: deep.newerLive } : {}) };
  }
  const resolveBundle = (unit, { epoch: epochArg, bucket: bucketArg, signal = null } = {}) => resolveBundleWith(unit, { epoch: epochArg, bucket: bucketArg, signal, scanMemo: false, newerLive: "refuse" });

  // THE PUBLISH GUARD (see the header): INSIDE the control lease, after verifyLease, immediately before the fenced CAS.
  // prepared.guard is the resolve's `guard` (equal at b1 / b2). Every read is FRESH (never the scan memo); the verdict is
  // the SAME pure fbaPlanLiveGuard the resolve applied. -> null (proceed) | { state, reason } (ZERO CAS; the release maps
  // it: NEWER_LIVE -> superseded, a deferral -> DEFERRED_DEPENDENCY).
  //   0. the ACTIVATION GATE (the resume path never reaches the gated derive);
  //   1. the latest job must still BE this prepared derivation (else a foreign latest job is ordered below, and anything
  //      else defers 'publish-guard:lineage-advanced');
  //   2. POST-INSERT CHECK (item 5 of the fill-only design): the newest FOREIGN job must still be the one this prepare's
  //      resolve saw (guard.foreignJobId). The generic release re-reads the latest job before its cycle open AND before
  //      its job upsert, but a foreign (paid) job inserted in the residual window between that last re-read and the
  //      route's own job insert sits BEHIND the route's job: it is not the latest (so step 1 passes) and the resolve
  //      never saw it. Such a job -> 'paid-job-raced-insert' (retryable, zero CAS). This is the SECOND line of defence:
  //      the FIRST is the open-paid-cycle check (b1 / b2 + step 3 here) -- a paid fba-plan job is inserted after its
  //      cycle opened (seconds later on a cache-hit re-run: runReportJobs upserts every planned job after the first
  //      source round), so a raced insert now needs a paid cycle that was NOT open at b2 to open in the ~sub-second
  //      before the route's job insert AND land its job in the ~1-RTT gap between the release's final latest-job
  //      re-read and upsertReportJob (no runtime hook runs there: a cycle re-read cannot be placed at that point). If
  //      it ever happened: the route's validated job IS then the latest job, so the paid op's own publish phase
  //      (report-publisher.js promotes the LATEST (report, account) job's shadow: getLatestReportJob orders by
  //      created_at) promotes the ROUTE's shadow and the paid job's own shadow is never promoted, until the paid op's
  //      durable persist moves the route token (route-over-route) or the next paid fetch / D-1. Only an ATOMIC
  //      compare-and-insert (insert the route job only while the latest job id is still the one read and no paid
  //      cycle is open) removes that theoretical interleaving entirely.
  //   3. the fill-only verdict over the FRESH served / exact rows + the fresh foreign job + the fresh OPEN PAID CYCLES
  //      (paid-owned, served-newer-to, newer components, pending / in-flight paid job, an open paid cycle, a refused
  //      paid shadow other than the one the prepare proved it serves) + the EU5 AWD regression guard.
  const guardShapeOk = (g) => !!g && typeof g === "object" && !Array.isArray(g) && isCalendarDate(S(g.salesAsOf)) && isCalendarDate(S(g.inventoryAsOf))
    && nb(g.fbaValidatedAt) && (g.awdValidatedAt === null || nb(g.awdValidatedAt)) && typeof g.awdApplicable === "boolean"
    && (g.foreignJobId === null || nb(g.foreignJobId)) && (g.refusedPaidDigest === null || nb(g.refusedPaidDigest));
  async function publishGuard(unit, prepared, { epoch: epochArg, signal = null } = {}) {
    if (!fenceAttested) return deferDep(FBA_PLAN_ROUTE_FENCE_NOT_ATTESTED);
    const g = prepared && prepared.guard;
    if (!guardShapeOk(g)) return deferDep("publish-guard:guard-missing");
    const targetId = S(unit && unit.targetId);
    if (S(g.salesAsOf) !== S(unit && unit.targetAsOf) || (epochArg != null && S(g.inventoryAsOf) !== S(epochArg))) return deferDep("publish-guard:guard-mismatch");
    // (1) The latest job (the one the publisher promotes).
    let job;
    try { job = await sb.getLatestReportJobLineage(PUBLISHER_KEY, targetId, { signal }); } catch { return deferDep("inventory-guard:paid-lineage-unreadable"); }
    const ours = jobIsPromotable(job) && S(job.snapshotParamsHash) === S(prepared.shadowParamsHash);
    // (2) The newest FOREIGN job, fresh -- the post-insert check.
    let paid = null;
    try { paid = await readPaidPending({ accountId: targetId, inventoryAsOf: g.inventoryAsOf, signal }); } catch { paid = null; }
    if (!paid || typeof paid !== "object" || paid.state === "unreadable") return deferDep("inventory-guard:paid-lineage-unreadable");
    if (ours && S(paid.jobId) !== S(g.foreignJobId)) return deferDep(FBA_PLAN_PAID_RACED_INSERT);
    // (3) The exact live row at {to: salesAsOf} (the CAS target) + the SERVED row, fresh; the SAME fill-only verdict.
    let live = null;
    try { live = await readLiveRows({ accountId: S(unit && unit.liveAccountId), salesAsOf: g.salesAsOf, signal }); } catch { live = null; }
    let cycles = null;
    try { cycles = await readPaidCycles({ accountId: targetId, inventoryAsOf: g.inventoryAsOf, signal }); } catch { cycles = null; }
    // A REFUSED paid shadow passes ONLY when it is the SAME content the prepare's resolve proved the route serves
    // (guard.refusedPaidDigest); any other refused shadow is the typed ALERT, zero CAS.
    const v = fbaPlanLiveGuard({ live, paid, cycles, salesAsOf: g.salesAsOf, inventoryAsOf: g.inventoryAsOf, inventoryValidatedAt: g.fbaValidatedAt, awdValidatedAt: g.awdValidatedAt, acceptRefusedDigest: g.refusedPaidDigest });
    if (v.hard) return deferDep(v.hard);
    if (v.newerLive) return /^superseded-newer-live:/.test(v.newerLive) ? st(GUARD_NEWER_LIVE, v.newerLive) : deferDep(v.newerLive);
    // A payload WITHOUT AWD on an AWD-capable marketplace (EU5 durable AWD unavailable): the regression guard.
    if (g.awdApplicable === true && g.awdValidatedAt === null) {
      const regression = fbaPlanAwdRegressionReason(v);
      if (regression) return deferDep(regression);
    }
    if (!ours) return deferDep("publish-guard:lineage-advanced");
    return null;
  }

  async function derive(bundle) {
    const r = deriveReportSnapshot({ reportKey: PUBLISHER_KEY, sources: bundle && bundle.sources, context: bundle && bundle.context });
    if (r.status === "derived") return { payload: r.payload, latestDataDate: r.latestDataDate || null };
    // A genuine integrity error is a HARD derive failure (typed, never a deferral that hides it); a missing durable
    // dependency is a typed not-ready deferral. Never a fabricated payload.
    if (r.status === "invalid") throw new Error("fba-plan-derive-invalid:" + S(r.errorCode || r.errorStage || "derive"));
    return { notReady: true, reason: "derive-" + S(r.status) };
  }
  // THE ACTIVATION GATE at the release's derive hook: the generic release calls runtime.derive ONLY from prepareForUnit
  // (a LIVE run; the scan and --verify-exact use the predicate's private derive + resolveBundle), BEFORE the first cycle
  // / job / shadow write -- so an unattested live run STOPS each unit with the typed hard derive failure
  // 'derive-threw:fba-plan-route-fence-not-attested: ...' and ZERO writes.
  async function gatedDerive(bundle) {
    if (!fenceAttested) throw new Error(FBA_PLAN_ROUTE_FENCE_NOT_ATTESTED + ": " + FBA_PLAN_ROUTE_FENCE_ATTESTED_ENV + " is not exactly 'true' -- LIVE fba-plan route writes are refused (zero writes)");
    return derive(bundle);
  }

  return {
    readScopeEvidence,
    computeRevision,
    // ONE unit per account; it binds at the region's salesAsOf (the live identity {to: salesAsOf}).
    expandUnits: async ({ accountId, evidence }) => [{
      unitKey: "-", targetId: S(accountId), liveAccountId: S(accountId), ownerAccountIds: [S(accountId)],
      targetAsOf: evidence && isCalendarDate(evidence.salesAsOf) ? S(evidence.salesAsOf) : null, reportKeys: [PUBLISHER_KEY],
    }],
    resolveBundle,
    derive: gatedDerive,
    // The report-planner.js fba-plan shadow params (to, inventoryAsOf, rawSellerId, accountName, marketCountry, isUS); a
    // null accountName / marketCountry is omitted (route identity params are strings / booleans only).
    identityParams: (unit, { bundle }) => {
      const c = bundle.context;
      return {
        to: S(c.to), inventoryAsOf: S(c.inventoryAsOf), rawSellerId: S(c.rawSellerId),
        ...(nb(c.accountName) ? { accountName: S(c.accountName) } : {}),
        ...(nb(c.marketCountry) ? { marketCountry: S(c.marketCountry) } : {}),
        isUS: c.isUS === true,
      };
    },
    identityAsOf: (unit, { bundle }) => S(bundle && bundle.context && bundle.context.to),
    servedSelector: async (unit, { signal = null } = {}) => { const s = await readServed(unit.liveAccountId, { signal }); return { row: s.row, reason: s.reason, via: s.via }; },
    // THE ROUTE'S VERDICT (content equivalence over the SERVED row; see the header).
    currentPredicate: async (rk, unit, ctx = {}) => {
      if (rk !== PUBLISHER_KEY) return null;
      const signal = ctx && ctx.signal ? ctx.signal : null;
      const salesAsOf = S(unit && unit.targetAsOf);
      if (!isCalendarDate(salesAsOf)) return deferProv("target-asof-unresolved");
      const served = await readServed(unit.liveAccountId, { signal });
      if (served.reason === "read-failed") return deferDep("served-read-failed");
      if (!served.row) return stale("served-" + S(served.reason || "missing"));
      if (!served.full || !served.full.params || typeof served.full.params !== "object") return deferDep("served-row-unreadable");
      const servedTo = S(served.full.params.to);
      if (served.via === "exact" && servedTo !== salesAsOf) return deferDep("served-row-preempted:exact-today-row");
      // FILL-ONLY (b): the served SALES as-of is the later of its identity {to} and payload.asOf.
      const servedAsOf = fbaPlanRowSalesAsOf({ params: served.full.params, payload: served.full.payload });
      if (isCalendarDate(servedAsOf) && servedAsOf > salesAsOf) return deferDep(FBA_PLAN_SERVED_NEWER_TO);
      if (servedTo !== salesAsOf) return stale("served-older-to"); // the prepare's resolve applies the full fill guard
      // The scan-level memoized evidence (exactly what the scan classified; ctx.revision guards a drift), resolved past a
      // FILL-ONLY refusal ('report'): equal content is still current -- a PAID row included (zero writes, proof marker);
      // different content is then that typed refusal ('superseded-newer-live:paid-owned' for a paid row), else STALE
      // (a route-written row whose evidence moved: route-over-route).
      const b = await resolveBundleWith(unit, { epoch: ctx.epoch || epoch, bucket: ctx.bucket || bucket, signal, scanMemo: true, newerLive: "report" });
      if (!b || b.eligible !== true) return deferDep("bundle-" + S(b && b.reason));
      if (ctx.revision && S(b.revisionId) !== S(ctx.revision.revisionId)) return deferDep("revision-advanced");
      // STAMP INVERSION: a refused paid shadow the route cannot serve is the ALERT even when the served (route) row
      // equals the route's own derive -- the page is not showing the paid path's content (never 'current').
      if (b.newerLive === FBA_PLAN_PAID_REFUSED_BY_ROUTE_STAMP) return deferDep(FBA_PLAN_PAID_REFUSED_BY_ROUTE_STAMP);
      let d;
      try { d = await derive(b.bundle); } catch { return b.newerLive ? deferDep(b.newerLive) : stale("content-derive-failed"); }
      if (!d || d.notReady) return deferDep("derive-not-ready:" + S(d && d.reason));
      const v = fbaPlanRouteContentVerdict(served.full.payload, d.payload);
      // FILL-ONLY: a PAID-OWNED row / a newer component / a pending or in-flight paid job with different content is its
      // typed refusal (zero writes; the prepare's resolve refuses it too) -- never STALE, which would try to overwrite it.
      if (!v.equal) return b.newerLive ? deferDep(b.newerLive) : stale("content-differs");
      // A directory LABEL-only drift (the durable directory vs the paid job's DataDoe accounts GET) is current by design
      // (fbaPlanRouteContentVerdict) -- logged (label names only), never republished.
      if (v.labelDrift.length) log("fba-plan " + S(unit.liveAccountId) + ": served row differs from the durable directory only in display label(s) [" + v.labelDrift.join(",") + "] -- content-equivalent (labels masked), no republish");
      // The content-equivalence PROOF of exactly the SERVED row read + compared above (h / sra), so --verify-exact
      // honours a paid-published row that carries no route lineage (route-publication-release.js adapter).
      return st(PUBLICATION_STATE.PUBLICATION_NOT_REQUIRED, "content-equivalent", { proof: ROUTE_PROOF_CONTENT_EQUIVALENT, h: S(served.row.params_hash), sra: S(served.row.source_refreshed_at) });
    },
    // FILL-ONLY at the CAS: the fresh re-check inside the control lease (see publishGuard above).
    publishGuard,
    // The fba_account_sku_ownership backfill for the PUBLISHED account only (non-fatal: the release catches + logs).
    postPublish: async ({ published } = {}) => {
      const acct = S(published && published.liveAccountId);
      if (!nb(acct)) return;
      const r = await ownershipBackfill({ accountId: acct });
      log("fba-plan ownership backfill (scoped to the published account): applied=" + S(r && r.applied) + " rows=" + S(r && r.totalRows));
    },
  };
}

export default Object.freeze({ id: FBA_PLAN_ROUTE_ID, publisherKey: PUBLISHER_KEY, stampPolicy: "evidence", build });
