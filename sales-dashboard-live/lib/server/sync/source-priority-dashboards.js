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
import { getSyncReportJobs, reservePriorityCatalogCreate, recordPriorityCatalogExport, getPriorityCatalogReservation } from "../supabase.js";

// FROZEN scope. Never overridable from an HTTP body / card action / scheduler.
export const PRIORITY_DASHBOARDS = Object.freeze({
  // The ONLY reports this path derives + publishes. daily-reporting + brand-sales are Scheduler-v2 dispatch keys
  // (gated by report_sync_settings.schedule_enabled); brand-inventory is the source-promoted Brand View (gated by
  // source_promoted_publish_settings.publish_enabled). All three are code-publishable via the reviewed publisher.
  reportKeys: Object.freeze(["daily-reporting", "brand-sales", "brand-inventory"]),
  // Publish brand-sales BEFORE brand-inventory so Brand View can never combine stale sales with fresh inventory.
  publishOrder: Object.freeze(["daily-reporting", "brand-sales", "brand-inventory"]),
  catalogSourceKey: "product-catalog",
  buckets: Object.freeze(["us", "non-us"]),
  maxCatalogCreates: 1,
  maxTokens: 2,
  catalogTokenCost: 2, // one STANDARD Catalog export
  // The frozen operation id the DURABLE Catalog reservation is keyed to (with the exact canonical Catalog
  // request hash). One reservation => one Catalog create / two tokens for the WHOLE go-live.
  operationKey: "priority-dashboards/v1",
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

/**
 * The production DURABLE Catalog reservation collaborator (source_priority_catalog_reservation +
 * reserve/record RPCs, 20260825_priority_catalog_reservation.sql -- PREPARED, UNAPPLIED). Injectable for tests.
 */
export function makeSupabaseCatalogReservation() {
  return {
    reserve: async ({ operationKey, catalogRequestHash }) => {
      const r = (await reservePriorityCatalogCreate(operationKey, catalogRequestHash)) || {};
      return { disposition: S(r.disposition), exportId: r.export_id ?? null, status: r.status ?? null, tokensSpent: Number(r.tokens_spent ?? 0) };
    },
    recordExport: async ({ operationKey, catalogRequestHash, exportId, tokens }) => {
      const r = (await recordPriorityCatalogExport(operationKey, catalogRequestHash, exportId, tokens)) || {};
      return { disposition: S(r.disposition), exportId: r.export_id ?? null };
    },
    get: async ({ operationKey, catalogRequestHash }) => getPriorityCatalogReservation(operationKey, catalogRequestHash),
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
  budgetMs = 550_000,
} = {}) {
  if (typeof buildRuntime !== "function") throw new Error("buildPriorityDashboardsRelease requires buildRuntime (fail closed).");
  if (typeof makeInnerAdapter !== "function") throw new Error("buildPriorityDashboardsRelease requires makeInnerAdapter (fail closed).");
  if (typeof buildPublisher !== "function") throw new Error("buildPriorityDashboardsRelease requires buildPublisher (fail closed).");
  if (typeof listReportJobs !== "function") throw new Error("buildPriorityDashboardsRelease requires listReportJobs (fail closed).");
  const operationKey = PRIORITY_DASHBOARDS.operationKey;
  const REPORT_SET = new Set(PRIORITY_DASHBOARDS.reportKeys);

  // priorityMode is bound at BUILD time; the guarded adapter enforces the durable one-Catalog-export ceiling.
  const runtime = buildRuntime({
    priorityMode: true,
    budgetMs,
    makeAdapter: (connections) => makeDurableCatalogGuard({ inner: makeInnerAdapter(connections), reservation, operationKey }),
  });
  const publisher = buildPublisher(); // frozen production publisher; the composed surface is publish(rk, acct)
  const store = makeStore({ deadline: null });

  async function deriveBucket(bucket, { deadline = null, preflight = null } = {}) {
    if (!PRIORITY_DASHBOARDS.buckets.includes(bucket)) {
      throw new Error(`deriveBucket requires bucket in ${PRIORITY_DASHBOARDS.buckets.join("|")} (got "${bucket}") (fail closed).`);
    }
    // The priority SOURCE runtime never finalizes the shared cycle -- verifyAndFinalize is the only finalize.
    const rollup = await runtime.run({ bucket, deadline, preflight });
    return { rollup };
  }

  // Verify the EXACT cycle + its children, then finalize via the reviewed RPC. Refuses unrelated/open/malformed
  // work; accepts only a strict finalized/already-terminal acknowledgement with a terminal cycle.
  async function verifyAndFinalize({ cycleId, expectedAccountIds }) {
    if (!nb(cycleId)) return { disposition: "refused", reason: "blank-cycle-id" };
    const accounts = [...new Set((Array.isArray(expectedAccountIds) ? expectedAccountIds : []).map(S).filter(nb))];
    if (!accounts.length) return { disposition: "refused", reason: "no-expected-accounts" };

    // (1) source jobs: ONLY product-catalog, ALL terminal-successful.
    const srcJobs = await store.listSourceJobs(cycleId);
    if (!Array.isArray(srcJobs) || srcJobs.length === 0) return { disposition: "refused", reason: "no-source-jobs" };
    for (const j of srcJobs) {
      if (S(j.source_key ?? j.sourceKey) !== PRIORITY_DASHBOARDS.catalogSourceKey) return { disposition: "refused", reason: "unrelated-source-job" };
      if (S(j.fetch_status ?? j.fetchStatus) !== "succeeded") return { disposition: "refused", reason: "source-job-not-terminal-successful" };
    }

    // (2) report jobs: ONLY the 3 keys, EXACT account scope, each derive/save succeeded + validated + nonblank hash.
    const repJobs = await listReportJobs(cycleId);
    if (!Array.isArray(repJobs)) return { disposition: "refused", reason: "report-jobs-unavailable" };
    for (const j of repJobs) {
      const rk = S(j.report_key ?? j.reportKey);
      if (!REPORT_SET.has(rk)) return { disposition: "refused", reason: "unrelated-report-job", detail: rk };
      const aid = S(j.account_id ?? j.accountId);
      if (!accounts.includes(aid)) return { disposition: "refused", reason: "unexpected-account-report-job" };
      const ok = j.validated === true
        && S(j.derive_status ?? j.deriveStatus) === "succeeded"
        && S(j.save_status ?? j.saveStatus) === "succeeded"
        && nb(j.snapshot_params_hash ?? j.snapshotParamsHash);
      if (!ok) return { disposition: "refused", reason: "report-job-not-validated", detail: rk };
    }
    // EXACT scope: every (account x reportKey) present (no missing).
    const present = new Set(repJobs.map((j) => S(j.report_key ?? j.reportKey) + "|" + S(j.account_id ?? j.accountId)));
    for (const a of accounts) {
      for (const rk of PRIORITY_DASHBOARDS.reportKeys) {
        if (!present.has(rk + "|" + a)) return { disposition: "refused", reason: "missing-report-job", detail: rk + "|" + a };
      }
    }

    // (3) finalize -- accept ONLY a strict finalized/already-terminal acknowledgement with a terminal cycle.
    const disp = await store.finalizeCycle({ cycleId });
    const d = disp && disp.disposition;
    if (d === "finalized" || d === "already-terminal") {
      const status = disp.cycle && typeof disp.cycle === "object" ? disp.cycle.status : null;
      if (status !== "succeeded" && status !== "partial") return { disposition: "refused", reason: "finalize-status-" + S(status || "malformed") };
      return { disposition: d, cycleStatus: status };
    }
    if (d === "open-work") return { disposition: "refused", reason: "open-work" };
    return { disposition: "refused", reason: "finalize-" + S(d || "malformed") };
  }

  // Publish the COMPLETE surface for one account: daily-reporting, brand-sales, brand-inventory -- brand-sales
  // BEFORE brand-inventory. Every publish goes through the real publisher's four durable gates; an unknown key
  // can never reach it (assertPriorityPublishReportKey). This never enables a control or an approval.
  async function publishAccount(accountId) {
    const acct = S(accountId).trim();
    if (!nb(acct)) throw new Error("publishAccount requires a non-blank accountId (fail closed).");
    const results = [];
    for (const reportKey of PRIORITY_DASHBOARDS.publishOrder) {
      assertPriorityPublishReportKey(reportKey);
      const res = await publisher.publish(reportKey, acct);
      results.push({ reportKey, disposition: res && res.disposition });
    }
    return { accountId: acct, results };
  }

  return Object.freeze({
    operationKey,
    reportKeys: PRIORITY_DASHBOARDS.reportKeys,
    publishOrder: PRIORITY_DASHBOARDS.publishOrder,
    makeDeadline: runtime.makeDeadline,
    preflightEvidence: runtime.preflightEvidence,
    catalogReservation: (catalogRequestHash) => reservation.get({ operationKey, catalogRequestHash }),
    deriveBucket,
    verifyAndFinalize,
    publishAccount,
  });
}
