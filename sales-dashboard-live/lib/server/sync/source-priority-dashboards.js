// Scheduler v2 -- TRUSTED Daily Reporting + Brand View "priority path" RELEASE composition (offline-built;
// operator-run). The ONE reviewed place the priority derive, the durable one-Catalog-export ceiling, the
// reviewed cycle-close, and the real publisher are wired together behind FROZEN operations.
//
// User-facing scope = TWO surfaces (Daily Reporting + Brand View). Brand View is assembled from TWO live
// snapshot keys -- brand-sales (the sales + ASIN-brand evidence buildAccountBrandSlice reads) and
// brand-inventory (the compact inventory) -- so the frozen priority publication set is EXACTLY:
//   ["daily-reporting", "brand-sales", "brand-inventory"].
// This authorizes no other dashboard.
//
// TRUST BOUNDARY: priority mode is bound at BUILD time on the runtime (priorityMode), never a run() argument
// an ordinary caller can flip. This composition freezes the report keys, the collaborators (runtime, publisher,
// store, reservation), the account scope check, and the publish order; its public surface takes only identifier
// strings. A caller cannot inject or widen report keys, readiness, controls, approvals, or publish behaviour,
// and an unknown report key can never reach the publisher (assertPriorityPublishReportKey + the publisher's own
// unknown-report/code-locked gates). Publishing still requires EVERY durable gate (code readiness, exact
// report/promoted control, primary rollout, audited per-(report, account) approval, validated job inside a
// TERMINAL cycle, exact shadow identity, payload contract, CAS). This module never enables any control or
// approval and never enables the scheduler.

import { buildBucketSourceSyncRuntime } from "./source-bucket-sync-runtime.js";
import { makeDataDoeAdapter, makeSupabaseSourceStore } from "./source-sync-driver.js";
import { buildSchedulerV2Publisher } from "./publisher-composition.js";
import { ORGANIZATION_SCOPE_KEY, OLI_SOURCE_KEY } from "./source-durable-model.js";
import { MAX_ACCOUNTS_PER_BATCH } from "./source-batching.js";
import { getSyncReportJobs, getSyncCycleByBucketDate, reservePriorityCatalogCreate, recordPriorityCatalogExport, getPriorityCatalogReservation } from "../supabase.js";

// FROZEN scope. Never overridable from an HTTP body / card action / scheduler.
export const PRIORITY_DASHBOARDS = Object.freeze({
  // The ONLY reports this path derives + publishes. daily-reporting + brand-sales are Scheduler-v2 dispatch keys
  // (gated by report_sync_settings.schedule_enabled); brand-inventory is the source-promoted Brand View (gated by
  // source_promoted_publish_settings.publish_enabled). All three are code-publishable via the reviewed publisher.
  reportKeys: Object.freeze(["daily-reporting", "brand-sales", "brand-inventory"]),
  // Publish brand-sales BEFORE brand-inventory so Brand View can never combine stale sales with fresh inventory.
  publishOrder: Object.freeze(["daily-reporting", "brand-sales", "brand-inventory"]),
  catalogSourceKey: "product-catalog",
  // Every account-routing scope this path may derive/finalize/publish: the three ACTIVE regions plus the legacy
  // revenue buckets (retained for historical cycles + one-flag rollback). deriveBucket/finalizeBucket + the release
  // runner validate against this list, so adding the regions here is the single lever that region-enables the
  // priority (Dashboard/Daily/Brand View) publish path. The shared date-only Catalog operation key still caps the
  // Catalog at ONE create per day across ALL scopes (the first region to run creates it; the rest reuse it).
  buckets: Object.freeze(["us", "non-us", "india", "europe-au", "us-ca"]),
  maxCatalogCreates: 1,
  maxTokens: 2,
  catalogTokenCost: 2, // one STANDARD Catalog export
  // The frozen operation id the DURABLE Catalog reservation is keyed to (with the exact canonical Catalog
  // request hash). One reservation => one Catalog create / two tokens for the WHOLE go-live. Versioned to v2
  // after the v1 Catalog request (empty sellerOrVendorIds + from/to + unproven `sku`) was rejected HTTP 400:
  // the v1 reservation stays untouched as historical fail-closed evidence; v2 carries the corrected request +
  // its own immutable hash + its own one-create/two-token reservation (Migration 9 already keys by operation_key,
  // so no migration change is needed to run a second operation key).
  operationKey: "priority-dashboards/v2",
});

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";

/**
 * Publisher-side allowlist: the priority path publishes ONLY daily-reporting + brand-sales + brand-inventory.
 * Any other reportKey is refused BEFORE the publisher is called, so an operator publish loop can never promote
 * an unrelated (paused) report.
 */
export function assertPriorityPublishReportKey(reportKey) {
  const rk = S(reportKey);
  if (!PRIORITY_DASHBOARDS.reportKeys.includes(rk)) {
    throw new Error(`PRIORITY_PUBLISH_FORBIDDEN: the priority dashboards path publishes ONLY ${PRIORITY_DASHBOARDS.reportKeys.join(" + ")} (got "${rk}"); refusing (fail closed).`);
  }
  return rk;
}

// The date-scoped operation key for an AUTOMATIC scheduled run. Each scheduled DATE gets its own reservation, so
// one calendar date authorizes at most ONE Catalog create across US + Non-US (the second bucket adopts the same
// export for zero tokens; a different canonical Catalog hash for the same key fails closed in the guard).
export const SCHEDULED_OPERATION_KEY_PREFIX = "priority-dashboards/scheduled/";
const SCHEDULED_OPERATION_KEY_RE = /^priority-dashboards\/scheduled\/(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Validate a caller-supplied Catalog operation key. ONLY two shapes are ever accepted:
 *   - the default historical key `priority-dashboards/v2` (the initial go-live reservation); OR
 *   - the scheduled key `priority-dashboards/scheduled/YYYY-MM-DD` with a REAL calendar date.
 * Every other shape (blank, unknown prefix, malformed / impossible date, trailing junk) fails closed. Returns the
 * exact key on success.
 */
export function assertPriorityOperationKey(operationKey) {
  const k = S(operationKey);
  if (k === PRIORITY_DASHBOARDS.operationKey) return k;
  const m = SCHEDULED_OPERATION_KEY_RE.exec(k);
  if (m) {
    const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d) return k;
    throw new Error(`PRIORITY_OPERATION_KEY_INVALID: "${k}" is not a real calendar date (fail closed).`);
  }
  throw new Error(`PRIORITY_OPERATION_KEY_INVALID: operationKey must be "${PRIORITY_DASHBOARDS.operationKey}" or "${SCHEDULED_OPERATION_KEY_PREFIX}YYYY-MM-DD" (got "${k}"); refusing (fail closed).`);
}

/**
 * The production DURABLE Catalog reservation collaborator (source_priority_catalog_reservation +
 * reserve/record RPCs, 20260825_priority_catalog_reservation.sql -- PREPARED, UNAPPLIED). Injectable for tests.
 */
export function makeSupabaseCatalogReservation() {
  // The supabase.js wrappers already validate every acknowledgement STRICTLY and return normalized
  // { disposition, exportId, tokensSpent, ... } objects, so this collaborator is a thin pass-through.
  return {
    reserve: ({ operationKey, catalogRequestHash }) => reservePriorityCatalogCreate(operationKey, catalogRequestHash),
    recordExport: ({ operationKey, catalogRequestHash, exportId, tokens }) => recordPriorityCatalogExport(operationKey, catalogRequestHash, exportId, tokens),
    get: ({ operationKey, catalogRequestHash }) => getPriorityCatalogReservation(operationKey, catalogRequestHash),
  };
}

/**
 * Wrap a DataDoe adapter so a create is authorized ONLY by winning the DURABLE reservation for
 * (operationKey, canonical Catalog request hash). Non-catalog creates throw. The reservation winner performs
 * the ONE create (2 tokens) then records the export id. A later attempt for the same hash whose reservation
 * already carries an export id ADOPTS it (poll/download only, ZERO create/tokens). A reservation without a
 * recorded export id (a create in flight / commit-unknown) is AMBIGUOUS -> fail closed, never a second create.
 * This is durable across US + Non-US, retries, restarts, and concurrent invocations (a process-local counter
 * could not survive any of those). poll/download pass through untouched.
 */
export function makeDurableCatalogGuard({ inner, reservation, operationKey }) {
  if (!inner || typeof inner.create !== "function" || typeof inner.poll !== "function" || typeof inner.download !== "function") {
    throw new Error("makeDurableCatalogGuard requires an inner adapter exposing create/poll/download (fail closed).");
  }
  if (!reservation || typeof reservation.reserve !== "function" || typeof reservation.recordExport !== "function") {
    throw new Error("makeDurableCatalogGuard requires a reservation exposing reserve + recordExport (fail closed).");
  }
  if (!nb(operationKey)) throw new Error("makeDurableCatalogGuard requires a non-blank operationKey (fail closed).");
  return {
    create: async (job) => {
      const sk = S(job && job.sourceKey);
      if (sk !== PRIORITY_DASHBOARDS.catalogSourceKey) {
        throw new Error(`PRIORITY_FORBIDDEN_CREATE: the priority dashboards path may create ONLY "${PRIORITY_DASHBOARDS.catalogSourceKey}" exports (got "${sk}"); refusing (fail closed).`);
      }
      const hash = S(job && (job.requestHash ?? job.request_hash));
      if (!nb(hash)) throw new Error("PRIORITY_CATALOG_HASH_MISSING: the Catalog job carries no canonical request hash; refusing (fail closed).");
      const res = await reservation.reserve({ operationKey, catalogRequestHash: hash });
      if (res.disposition === "reserved") {
        // This caller WON the one create. POST once, then record the export id + tokens.
        const result = await inner.create(job);
        const exportId = S(result && result.exportId);
        if (!nb(exportId)) throw new Error("PRIORITY_CATALOG_EXPORT_ID_MISSING: the Catalog create returned no export id; the reservation stays open (fail closed).");
        const rec = await reservation.recordExport({ operationKey, catalogRequestHash: hash, exportId, tokens: PRIORITY_DASHBOARDS.catalogTokenCost });
        if (rec.disposition !== "recorded" && rec.disposition !== "already-recorded") {
          throw new Error(`PRIORITY_CATALOG_RECORD_FAILED: durable reservation returned "${rec.disposition}" recording the Catalog export; failing closed.`);
        }
        return result;
      }
      if (res.disposition === "exists") {
        if (nb(res.exportId)) {
          // The one create already happened -> ADOPT its export id (poll/download only). ZERO create/tokens.
          return { exportId: res.exportId, adopted: true };
        }
        // Reserved but no recorded export id yet -> a create is in flight / its commit is unknown. AMBIGUOUS.
        throw new Error("PRIORITY_CATALOG_RESERVATION_AMBIGUOUS: a Catalog create is reserved but its export id is unrecorded (in-flight or commit-unknown); refusing a second create (fail closed).");
      }
      if (res.disposition === "hash-mismatch") {
        // The operation already reserved a DIFFERENT canonical Catalog hash (e.g. midnight / asOf date drift).
        // One operation authorizes at most one Catalog create ever -> refuse; never a second create.
        throw new Error("PRIORITY_CATALOG_HASH_MISMATCH: this operation reserved a different canonical Catalog request hash; refusing a second create (fail closed).");
      }
      throw new Error(`PRIORITY_CATALOG_RESERVE_UNEXPECTED: durable reservation returned "${res.disposition}"; failing closed.`);
    },
    poll: (...a) => inner.poll(...a),
    download: (...a) => inner.download(...a),
  };
}

/**
 * Build the trusted priority-dashboards RELEASE composition. All collaborators are BUILD-TIME seams (tests pass
 * doubles); production callers pass nothing and get the frozen production wiring. Returns FROZEN operations:
 *   - deriveBucket(bucket)              -> priority derive off durable OLI + Catalog (never finalizes a cycle);
 *   - verifyAndFinalize({cycleId,...})  -> verify the exact catalog-only cycle + its 3-report children, then the
 *                                          reviewed finalizeCycle RPC (accepts only strict finalized/terminal);
 *   - publishAccount(accountId)         -> publish daily-reporting, brand-sales, brand-inventory (brand-sales
 *                                          BEFORE brand-inventory) through the real publisher's four durable gates.
 * The caller cannot inject/widen report keys, collaborators, readiness, controls, approvals, scope, or publish
 * behaviour, and an unknown report key never reaches the publisher.
 */
export function buildPriorityDashboardsRelease({
  buildRuntime = buildBucketSourceSyncRuntime,
  makeInnerAdapter = makeDataDoeAdapter,
  buildPublisher = buildSchedulerV2Publisher,
  reservation = makeSupabaseCatalogReservation(),
  makeStore = makeSupabaseSourceStore,
  listReportJobs = getSyncReportJobs,
  getCycleByBucketDate = getSyncCycleByBucketDate,
  budgetMs = 550_000,
  // Optional YYYY-MM-DD asOf pin: when the wall clock has drifted past the last proven durable-OLI covered_to
  // day, derive up to that day (no new OLI fetch). null => clock today-1. Validated (fail closed on a malformed
  // value); bound at BUILD time onto the priority runtime, so the cycle date stays clock-today.
  asOfOverride = null,
  // The Catalog reservation operation key. Default = the historical v2 key (initial go-live). An AUTOMATIC
  // scheduled run passes "priority-dashboards/scheduled/YYYY-MM-DD" so each date owns its one-Catalog-create
  // reservation. Validated STRICTLY (any other shape fails closed).
  operationKey = PRIORITY_DASHBOARDS.operationKey,
  // ADDITIVE OLI sales estimates (missing/zero-price filled from same-product historical prices): ON in production
  // so Daily + Brand View publish the estimate-included Total Sales. Offline harnesses pass false to prove the
  // priced derive is byte-identical (the estimate layer is purely additive) and to avoid touching the estimate tables.
  enableSalesEstimates = true,
  // TRUSTED, BUILD-TIME-ONLY DEDICATED CYCLE NAMESPACE (e.g. "bootstrap-india"). When set, deriveBucket +
  // finalizeBucket operate on a DEDICATED sync_cycles bucket -- exactly like FBA's "<region>-fba" -- so a
  // scoped bootstrap publication NEVER collides with (or short-circuits on) the natural (region, today)
  // daily cycle. null => the scheduler-v2 daily path is byte-identical (the cycle bucket IS the region).
  cycleBucket = null,
  // TRUSTED, BUILD-TIME-ONLY SCOPED discovery override: when set, the runtime discovers EXACTLY these
  // accounts (a bootstrap publication passes ONLY its immutable dispatch set), so the derive/finalize/
  // publish covers exactly them and nothing outside the wave. null => the runtime's real full-region
  // discovery (unchanged). This is a runtime seam only -- the finalizer's exact-count proofs still hold
  // against whatever discovery returns, so no full-region contract is weakened.
  fetchAccounts = null,
  // Round-9 P0-A + P0-B: an OPTIONAL control-fence provider () => {ownerToken, generation} | null. When set,
  // the release's publisher becomes CONTROL-ENABLED -- EVERY report write fences the exact captured fence inside
  // the report_snapshots CAS and FAILS CLOSED (lease-lost) when no live fence exists. null => unfenced (the
  // natural non-bootstrap path is byte-identical).
  getControlFence = null,
} = {}) {
  if (typeof buildRuntime !== "function") throw new Error("buildPriorityDashboardsRelease requires buildRuntime (fail closed).");
  if (asOfOverride != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(asOfOverride))) throw new Error("buildPriorityDashboardsRelease asOfOverride must be a YYYY-MM-DD date (fail closed).");
  if (typeof makeInnerAdapter !== "function") throw new Error("buildPriorityDashboardsRelease requires makeInnerAdapter (fail closed).");
  if (typeof buildPublisher !== "function") throw new Error("buildPriorityDashboardsRelease requires buildPublisher (fail closed).");
  if (typeof listReportJobs !== "function") throw new Error("buildPriorityDashboardsRelease requires listReportJobs (fail closed).");
  if (typeof getCycleByBucketDate !== "function") throw new Error("buildPriorityDashboardsRelease requires getCycleByBucketDate (fail closed).");
  if (cycleBucket != null && !(typeof cycleBucket === "string" && cycleBucket.trim())) throw new Error("buildPriorityDashboardsRelease cycleBucket must be a non-blank string when set (fail closed).");
  assertPriorityOperationKey(operationKey); // validate the reservation operation key (default v2 | scheduled/YYYY-MM-DD)
  const REPORT_SET = new Set(PRIORITY_DASHBOARDS.reportKeys);
  const cycleBucketFor = (bucket) => (cycleBucket != null ? cycleBucket : bucket);

  // priorityMode is bound at BUILD time; the guarded adapter enforces the durable one-Catalog-export ceiling.
  const runtime = buildRuntime({
    priorityMode: true,
    budgetMs,
    asOfOverride,
    enableSalesEstimates,
    ...(typeof fetchAccounts === "function" ? { fetchAccounts } : {}),
    makeAdapter: (connections) => makeDurableCatalogGuard({ inner: makeInnerAdapter(connections), reservation, operationKey }),
  });
  // Round-10: buildSchedulerV2Publisher is ALWAYS fenced. Thread getControlFence through unconditionally -- when
  // it is null (no fence provider), EVERY live write fails closed (lease-lost), so a bare release without a
  // control fence can never write through the Gate-7 composition.
  const publisher = buildPublisher({ getControlFence });
  const store = makeStore({ deadline: null });
  const refuse = (reason, detail) => (detail === undefined ? { disposition: "refused", reason } : { disposition: "refused", reason, detail });

  // deriveBucket takes ONLY the bucket identifier. It creates its OWN deadline and runs its OWN production
  // preflight (fresh discovery/coverage/snapshot evidence); no caller-supplied preflight, account list,
  // collaborators, dates, readiness, or scope is accepted. priorityMode is build-time; the run never finalizes.
  async function deriveBucket(bucket) {
    if (!PRIORITY_DASHBOARDS.buckets.includes(bucket)) {
      throw new Error(`deriveBucket requires bucket in ${PRIORITY_DASHBOARDS.buckets.join("|")} (got "${bucket}") (fail closed).`);
    }
    const deadline = runtime.makeDeadline();
    const preflight = await runtime.preflightEvidence({ bucket, deadline });
    // RESUMABLE re-run: if THIS bucket's cycle for today is ALREADY terminal (a prior release pass derived AND
    // finalized it), the derive is done and re-running would be REFUSED by the durable "cycle is terminal;
    // refusing to append/alter child work" guard. Skip the re-derive and return a clean already-complete rollup;
    // finalizeBucket still INDEPENDENTLY re-proves the durable scope before accepting it. A running/absent cycle
    // derives normally. getCycleByBucketDate fails closed (throws) on >1 cycle for the (bucket, date).
    const sig = deadline && deadline.signal ? { signal: deadline.signal } : {};
    const existingCycle = await getCycleByBucketDate(cycleBucketFor(bucket), S(preflight.today), sig);
    const existingStatus = existingCycle ? S(existingCycle.status) : null;
    if (existingStatus === "succeeded" || existingStatus === "partial") {
      return { rollup: { stopped: false, continuationRequired: false, globalDrained: true, alreadyComplete: true, cycleId: S(existingCycle.id), cycleStatus: existingStatus, derived: { skipped: null, lineage: [] } } };
    }
    const rollup = await runtime.run({ bucket, deadline, preflight, ...(cycleBucket != null ? { cycleBucket } : {}) });
    return { rollup };
  }

  // finalizeBucket takes ONLY the bucket. It INDEPENDENTLY reconstructs and re-proves the durable scope from
  // fresh, primary-only discovery + the durable cycle/jobs/owners + the durable reservation -- never an
  // in-memory attestation or a caller-supplied cycle id / account scope -- then finalizes via the reviewed RPC.
  async function finalizeBucket(bucket) {
    if (!PRIORITY_DASHBOARDS.buckets.includes(bucket)) return refuse("bad-bucket");
    const deadline = runtime.makeDeadline();
    const sig = deadline && deadline.signal ? { signal: deadline.signal } : {};

    // (1) EXPECTED account scope = fresh, primary-only discovery for THIS bucket (never caller-supplied).
    const preflight = await runtime.preflightEvidence({ bucket, deadline });
    const expected = [...new Set((preflight.accounts || []).map((a) => S(a.accountId)).filter(nb))].sort();
    if (!expected.length) return refuse("no-discovered-accounts");
    const expectedSet = new Set(expected);
    const cycleDate = S(preflight.today);
    if (!nb(cycleDate)) return refuse("no-cycle-date");

    // (2) reconstruct + verify the CYCLE ROW itself: exact (dedicated) bucket, running status, reviewed
    // manual trigger. In a scoped bootstrap release the cycle lives under the dedicated cycle bucket.
    const cycleKeyBucket = cycleBucketFor(bucket);
    const cycle = await getCycleByBucketDate(cycleKeyBucket, cycleDate, sig);
    if (!cycle || !nb(S(cycle.id))) return refuse("cycle-not-found");
    if (S(cycle.bucket) !== cycleKeyBucket) return refuse("cycle-bucket-mismatch");
    // RESUMABLE: 'running' finalizes here; an ALREADY-terminal 'succeeded'/'partial' cycle (a prior release pass
    // finalized it) is accepted IDEMPOTENTLY -- but only AFTER the SAME strict durable-scope proofs below; any
    // other status is refused.
    const priorStatus = S(cycle.status);
    if (priorStatus !== "running" && priorStatus !== "succeeded" && priorStatus !== "partial") return refuse("cycle-not-running", priorStatus);
    if (S(cycle.trigger) !== "manual") return refuse("cycle-not-manual", S(cycle.trigger));
    const cycleId = S(cycle.id);

    // (3) source jobs: EXACTLY ONE org-scoped succeeded product-catalog job, PLUS zero-or-more succeeded
    // order-line-items jobs (a SCHEDULED cycle refreshes OLI first; the initial catalog-only go-live has none).
    // NO other source key may appear -- Ads/FBA/any unrelated family is refused. Every job must be succeeded.
    const srcJobs = await store.listSourceJobs(cycleId);
    if (!Array.isArray(srcJobs) || srcJobs.length < 1) return refuse("source-job-count", String(Array.isArray(srcJobs) ? srcJobs.length : "na"));
    const CATALOG_KEY = PRIORITY_DASHBOARDS.catalogSourceKey;
    for (const j of srcJobs) {
      const sk = S(j.source_key ?? j.sourceKey);
      if (sk !== CATALOG_KEY && sk !== OLI_SOURCE_KEY) return refuse("unrelated-source-job", sk);
      if (S(j.fetch_status ?? j.fetchStatus) !== "succeeded") return refuse("source-job-not-succeeded");
    }
    const catalogJobs = srcJobs.filter((j) => S(j.source_key ?? j.sourceKey) === CATALOG_KEY);
    const oliJobs = srcJobs.filter((j) => S(j.source_key ?? j.sourceKey) === OLI_SOURCE_KEY);
    if (catalogJobs.length !== 1) return refuse("catalog-job-count", String(catalogJobs.length));
    const cj = catalogJobs[0];
    const catalogHash = S(cj.request_hash ?? cj.requestHash);
    if (!nb(catalogHash)) return refuse("catalog-hash-blank");
    const ownersRaw = await store.listCycleOwners(cycleId);
    const owners = Array.isArray(ownersRaw) ? ownersRaw : [];
    const catOwners = owners.filter((o) => S(o.request_hash ?? o.requestHash) === catalogHash);
    if (catOwners.length !== 1 || S(catOwners[0].account_id ?? catOwners[0].accountId) !== ORGANIZATION_SCOPE_KEY) return refuse("catalog-not-org-scope");

    // (3b) OLI jobs (scheduled cycle only): each create<=1, batch<=5 (owner count), owners are per-ACCOUNT (never
    // org scope), every OLI owner is a DISCOVERED account, and the OLI owner union EXACTLY covers the discovered
    // bucket accounts (no missing/extra). This proves the scheduled OLI refresh stayed inside the bucket's scope
    // and its token/create ceiling, without weakening any Catalog proof above.
    if (oliJobs.length) {
      const ownersByHash = new Map();
      for (const o of owners) {
        const h = S(o.request_hash ?? o.requestHash);
        if (!ownersByHash.has(h)) ownersByHash.set(h, []);
        ownersByHash.get(h).push(S(o.account_id ?? o.accountId));
      }
      const oliOwnerUnion = new Set();
      for (const j of oliJobs) {
        if (Number(j.create_export_count ?? j.createExportCount) > 1) return refuse("oli-create-count", S(j.create_export_count ?? j.createExportCount));
        const h = S(j.request_hash ?? j.requestHash);
        if (!nb(h)) return refuse("oli-hash-blank");
        const jobOwners = ownersByHash.get(h) || [];
        if (!jobOwners.length) return refuse("oli-owners-missing");
        if (jobOwners.length > MAX_ACCOUNTS_PER_BATCH) return refuse("oli-batch-oversized", String(jobOwners.length));
        for (const a of jobOwners) {
          if (a === ORGANIZATION_SCOPE_KEY) return refuse("oli-owner-org-scope");
          if (!expectedSet.has(a)) return refuse("oli-owner-unexpected", a);
          oliOwnerUnion.add(a);
        }
      }
      for (const a of expected) if (!oliOwnerUnion.has(a)) return refuse("oli-owner-coverage-missing", a);
    }

    // (4) TOKEN/RESERVATION coherence with the Catalog job's create_export_count -- CROSS-BUCKET aware. The one
    // org-scoped Catalog export is shared by BOTH buckets against ONE operation-wide reservation, so a bucket
    // legitimately finalizes in either role:
    //   create_export_count=1 -> THIS bucket made the create: the EXACT created reservation (same hash, tokens=2)
    //                            whose export id is the one THIS job created.
    //   create_export_count=0 -> zero tokens here, but durable cache evidence is REQUIRED, and the reservation is
    //                            EITHER absent (true warm-cache-first) OR the OTHER bucket's EXACT created
    //                            reservation (same hash/export/tokens=2). Any reserved-not-created / different
    //                            hash / malformed export / wrong tokens / unrelated reservation is refused.
    const cec = Number(cj.create_export_count ?? cj.createExportCount);
    const jobExportId = S(cj.export_id ?? cj.exportId);
    const reservationRow = await reservation.get({ operationKey, catalogRequestHash: null });
    // An EXACT created reservation for THIS operation's one Catalog export: created status, THIS catalog hash,
    // a nonblank export id, exactly two tokens. Returns a typed refusal reason, or null when coherent.
    const provenCreatedReservation = () => {
      if (S(reservationRow.status) !== "created") return "reservation-not-created";
      if (S(reservationRow.catalogRequestHash) !== catalogHash) return "reservation-hash-mismatch";
      if (!nb(S(reservationRow.exportId))) return "reservation-no-export";
      if (Number(reservationRow.tokensSpent) !== 2) return "reservation-tokens";
      return null;
    };
    if (cec === 1) {
      if (!reservationRow) return refuse("no-reservation-for-create");
      const bad = provenCreatedReservation();
      if (bad) return refuse(bad);
      if (!nb(jobExportId) || jobExportId !== S(reservationRow.exportId)) return refuse("reservation-export-mismatch");
    } else if (cec === 0) {
      if (!nb(S(cj.cache_object_path ?? cj.cacheObjectPath))) return refuse("no-cache-evidence");
      if (reservationRow) {
        const bad = provenCreatedReservation();
        if (bad) return refuse(bad);
        // If THIS warm job recorded an adopted export id, it must be the SAME org export the reservation created.
        if (nb(jobExportId) && jobExportId !== S(reservationRow.exportId)) return refuse("reservation-export-mismatch");
      }
    } else {
      return refuse("bad-create-count", String(cec));
    }

    // (5) report jobs: EXACTLY expected x 3, ONLY the 3 keys, NO duplicate natural identities, each validated.
    const repJobs = await listReportJobs(cycleId);
    if (!Array.isArray(repJobs)) return refuse("report-jobs-unavailable");
    const seen = new Set();
    for (const j of repJobs) {
      const rk = S(j.report_key ?? j.reportKey);
      if (!REPORT_SET.has(rk)) return refuse("unrelated-report-job", rk);
      const aid = S(j.account_id ?? j.accountId);
      if (!expectedSet.has(aid)) return refuse("unexpected-account-report-job");
      const key = rk + "|" + aid;
      if (seen.has(key)) return refuse("duplicate-report-job", key);
      seen.add(key);
      const ok = j.validated === true
        && S(j.derive_status ?? j.deriveStatus) === "succeeded"
        && S(j.save_status ?? j.saveStatus) === "succeeded"
        && nb(j.snapshot_params_hash ?? j.snapshotParamsHash);
      if (!ok) return refuse("report-job-not-validated", key);
    }
    if (seen.size !== expected.length * PRIORITY_DASHBOARDS.reportKeys.length) return refuse("report-job-count", String(seen.size));
    for (const a of expected) {
      for (const rk of PRIORITY_DASHBOARDS.reportKeys) {
        if (!seen.has(rk + "|" + a)) return refuse("missing-report-job", rk + "|" + a);
      }
    }

    // (6) finalize. An ALREADY-terminal cycle (scope re-proven above) is accepted idempotently WITHOUT re-issuing
    // the finalize RPC (the durable row is already terminal; re-finalizing is unnecessary and the RPC may reject
    // appending to a terminal cycle). A 'running' cycle is finalized via the reviewed RPC as before.
    if (priorStatus === "succeeded" || priorStatus === "partial") {
      return { disposition: "already-terminal", cycleStatus: priorStatus, cycleId, accounts: expected };
    }
    const disp = await store.finalizeCycle({ cycleId });
    const d = disp && disp.disposition;
    if (d === "finalized" || d === "already-terminal") {
      const status = disp.cycle && typeof disp.cycle === "object" ? disp.cycle.status : null;
      if (status !== "succeeded" && status !== "partial") return refuse("finalize-status-" + S(status || "malformed"));
      return { disposition: d, cycleStatus: status, cycleId, accounts: expected };
    }
    if (d === "open-work") return refuse("open-work");
    return refuse("finalize-" + S(d || "malformed"));
  }

  // READ-ONLY pre-publish proof: run the REAL publisher's shared preflight (same collaborators + gates) for all
  // three keys, carrying each pair's exact live identity (liveReportKey + paramsHash). The operator proves EVERY
  // (account, report) pair is publishable BEFORE any live write; a non-'ready' disposition blocks all writes.
  async function preflightAccount(accountId) {
    const acct = S(accountId).trim();
    if (!nb(acct)) throw new Error("preflightAccount requires a non-blank accountId (fail closed).");
    if (typeof publisher.preflight !== "function") throw new Error("the composed publisher exposes no preflight (fail closed).");
    const results = [];
    for (const reportKey of PRIORITY_DASHBOARDS.reportKeys) {
      assertPriorityPublishReportKey(reportKey);
      const res = await publisher.preflight(reportKey, acct);
      results.push({ reportKey, disposition: res && res.disposition, liveReportKey: res && res.liveReportKey, paramsHash: res && res.paramsHash });
    }
    return { accountId: acct, results };
  }

  // Publish the COMPLETE surface for one account: daily-reporting, brand-sales, brand-inventory -- brand-sales
  // BEFORE brand-inventory. Every publish goes through the real publisher's four durable gates; an unknown key
  // can never reach it (assertPriorityPublishReportKey). Each result carries the EXACT live identity
  // (liveReportKey + paramsHash) so the read-back can query the live row by its exact natural key. This never
  // enables a control or an approval.
  async function publishAccount(accountId) {
    const acct = S(accountId).trim();
    if (!nb(acct)) throw new Error("publishAccount requires a non-blank accountId (fail closed).");
    const results = [];
    for (const reportKey of PRIORITY_DASHBOARDS.publishOrder) {
      assertPriorityPublishReportKey(reportKey);
      const res = await publisher.publish(reportKey, acct);
      results.push({ reportKey, disposition: res && res.disposition, liveReportKey: res && res.liveReportKey, paramsHash: res && res.paramsHash });
    }
    return { accountId: acct, results };
  }

  return Object.freeze({
    operationKey,
    reportKeys: PRIORITY_DASHBOARDS.reportKeys,
    publishOrder: PRIORITY_DASHBOARDS.publishOrder,
    catalogReservation: (catalogRequestHash) => reservation.get({ operationKey, catalogRequestHash }),
    preflightAccount,
    deriveBucket,
    finalizeBucket,
    publishAccount,
  });
}
