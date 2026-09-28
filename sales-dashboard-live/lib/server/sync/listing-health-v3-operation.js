// Advanced Listing Health v3 -- DEDICATED INGESTION OPERATOR (Phase 4B1), SAFE-CLOSED.
//
// The ONE trusted v3 ingestion core. It is a SEPARATE dispatch path from the live 13-report control plane: v3 is
// deliberately absent from CONTROLLED_REPORT_KEYS / SCHEDULER_V2_READY_REPORT_KEYS, so runtime.run() (the scheduled/
// manual dispatcher) can never select it. This operator is the only way v3 ingestion runs, and it runs ONLY behind an
// explicit operator authorization AND an independent, default-DISABLED ingestion gate. It is NOT wired to any route,
// GitHub cron, or watchdog in this phase, and it is NOT invoked here -- Phase 4B1 builds + deploys it dark.
//
// Sequence (every step fails closed; last-known-good is always preserved on failure):
//   1  authenticate an explicitly authorized invocation;
//   2  require the independent v3 ingestion gate (default disabled); live mode refuses while it is disabled;
//   3  accept ONLY india | europe-au | us-ca;
//   4  discover fresh authoritative primary accounts (injected);
//   5  resolve region from account metadata (accountInScope by marketplace country -- never browser input / clock);
//   6  build + FREEZE buildShadowReportPlan({ reportKeys: ["listing-health-v3"] }) with the regional cycle's
//      freshnessNotBefore (date-free request_hash; freshness travels as a NON-hash field);
//   7  validate the frozen plan fingerprint + the per-region create ceiling + pricing/reservation support +
//      DataDoe usable balance (minus an emergency reserve) BEFORE any POST -- abort on any drift/unknown/shortfall;
//   7a (WP16, live, opt-in) a base cycle that is ALREADY terminal is decided read-only here -- never appended to, never
//      re-acquired: each account must PROVE already-current (content + lineage + live/served read-back), else a typed
//      real failure (see the WP16 block below);
//   8  run source jobs through the existing resumable source worker (listings + listings-raw CREATE within the frozen
//      budget; inventory is REUSE-ONLY -- adopt the current FBA Plan inventory cache, never a v3 create);
//   9  materialize validated batch results into isolated per-account aliases (newer-only overwrite);
//  10  run report jobs -> save ONLY the scheduler-v2/listing-health-v3 shadow snapshot (never a live snapshot), and
//      DEFER the derive if current FBA inventory is unavailable (never publish stale inventory as current);
//  10b (WP16, opt-in) a 'partial' finalize caused ONLY by failed shadow saves succeeds only when every such account is
//      PROVEN already-current against the durable evidence this run persisted;
//  11  return structured per-region evidence (incl. alreadyCurrent + refusedReal on the WP16 paths).
//
// PURE orchestration over INJECTED collaborators (offline-testable; ZERO DataDoe unless the caller wires + enables a
// live run). Dry-run performs ZERO creates/writes/tokens. Live mode refuses while the gate is disabled.

import { buildShadowReportPlan } from "./report-planner.js";
import { accountInScope, isRoutingScope } from "./scheduler-scope.js";
// ONE pricing definition (all-region scheduler repair Work 2): the estimate MUST price each create by its real
// registry token class -- the SAME sourceTokenCost(registryIsPremiumOf(job)) the frozen tranche budget uses -- so
// the displayed estimate + the first authorization gate + the frozen binding agree. A flat per-export price
// understates a premium listings export (5) as standard (2) and lets the first gate pass deceptively.
import { sourceTokenCost } from "./source-tranche-budget.js";
import { registryIsPremiumOf } from "./source-registry.js";
import {
  listingHealthV3PlannedExports,
  assertListingHealthV3ExportCeiling,
  assertNoDuplicatePerAccountReadIdentities,
} from "./listing-health-v3-materialize.js";
import {
  LISTING_HEALTH_V3_PRICING_REVISION,
  readListingHealthV3Authorization,
  decideListingHealthV3Authorization,
  computeListingHealthV3AuthorizationBinding,
  verifyListingHealthV3ReplayBinding,
} from "./listing-health-v3-authorization.js";
// WP16 already-current proof: the SHARED publisher-identical binding primitives + the pure served-row verdict (no I/O).
import { PUBLICATION_STATE, jobIsPromotable, revisionCoveredByJob, evaluatePublicationBinding, hydrateSnapshotPayload } from "./publication-binding.js";
import { defaultServedVerdict, servedRowIdentity } from "../recovery/serve-selectors.js";

const S = (v) => (v == null ? "" : String(v));
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(S(v));
const safe = (e) => S(e && e.message ? e.message : e).slice(0, 200);
export const V3_INGESTION_REGIONS = Object.freeze(["india", "europe-au", "us-ca"]);
// PER-EXPORT token price is NO LONGER a flat constant: it is the source's real registry token class (standard=2 /
// premium=5) via sourceTokenCost(registryIsPremiumOf(job)) -- the SAME definition the frozen tranche budget uses.
// rowCountBilling=true means every per-source price is an ESTIMATE, never a guaranteed maximum -- the balance gate
// keeps an emergency reserve on top, and the frozen tranche budget's atomic pre-POST reservation is the true ceiling.
export const V3_DEFAULT_EMERGENCY_RESERVE_TOKENS = 50;

/** The durable, replay-stable operation identity for one regional cycle. */
export function listingHealthV3OperationId(region, cycleDate) {
  return `listing-health-v3/${S(region)}/${S(cycleDate)}`;
}

/**
 * Default plan builder: the frozen v3 batched plan for one regional cycle (freshnessNotBefore = the cycle date).
 * `overflowSellers` (default empty) applies the inventory-only single-seller split so a proven-overflow seller's v3
 * inventory read hash matches the FBA single-seller child recovered for it (empty set => byte-identical plan). Listings
 * + Listings-Raw stay batched regardless (the planner splits inventory only).
 */
export function buildListingHealthV3Plan({ accounts, connections, cycleDate, overflowSellers = new Set() }) {
  return buildShadowReportPlan({
    accounts,
    reportKeys: ["listing-health-v3"],
    connections,
    asOfFor: () => cycleDate,
    inventoryAsOf: cycleDate, // attaches freshnessNotBefore = cycleDate to every v3 source (see the planner)
    overflowSellers,
  });
}

/**
 * Freshness-aware pre-POST cost of a frozen v3 plan (ZERO creates). Mirrors planFbaBucketCost: a NEW export
 * (listings / listings-raw) is adoptable -- and therefore free -- only when a cache entry exists whose fetched_at is
 * at/after the source's freshnessNotBefore (the current cycle boundary); a stale entry is NOT adoptable and would be
 * refreshed. Inventory is REUSE-ONLY: it is never counted as a create, and `inventoryAdoptable` reports whether the
 * current FBA Plan inventory cache is fresh (the precondition to derive/publish).
 */
export async function planListingHealthV3IngestionCost({ plan, getSourceExportCache }) {
  if (typeof getSourceExportCache !== "function") throw new Error("planListingHealthV3IngestionCost requires getSourceExportCache (fail closed).");
  const v3Requests = (plan.reportRequests || []).filter((r) => r && r.reportKey === "listing-health-v3");
  const { newExports, reusedExports, newExportHashes, reusedExportHashes } = listingHealthV3PlannedExports(v3Requests);
  const plannedByHash = new Map(v3Requests.flatMap((r) => (r.sources || []).map((s) => [s.requestHash, s])));
  // ONE pricing definition: the real per-source token class (standard=2 / premium=5), identical to the frozen
  // tranche budget. An unregistered source throws (fail closed -> awaiting-budget), never a silent default price.
  const tokenCostOfHash = (h) => sourceTokenCost(registryIsPremiumOf({ sourceKey: plannedByHash.get(h)?.sourceKey ?? plannedByHash.get(h)?.source_key }));
  const adoptable = new Set();
  for (const h of [...newExportHashes, ...reusedExportHashes]) {
    try {
      const entry = await getSourceExportCache(h);
      const since = plannedByHash.get(h)?.freshnessNotBefore;
      if (entry && (!since || Date.parse(entry.fetched_at ?? entry.fetchedAt ?? "") >= Date.parse(since))) adoptable.add(h);
    } catch (_e) { /* treat as not-adoptable (fail toward a refresh, never toward a fabricated success) */ }
  }
  const createHashes = newExportHashes.filter((h) => !adoptable.has(h));
  // PER-ACCOUNT (per reuse-hash) inventory adoptability (optional-inventory contract). The region no longer defers
  // wholesale when ONE account's FBA inventory is not adoptable: the run proceeds, publishes listings/OLI for all
  // accounts, adopts inventory where fresh, and leaves inventory-dependent fields unavailable for the rest.
  const inventoryAdoptableByHash = Object.fromEntries(reusedExportHashes.map((h) => [h, adoptable.has(h)]));
  const inventoryAdoptableCount = reusedExportHashes.filter((h) => adoptable.has(h)).length;
  const anyInventoryAdoptable = inventoryAdoptableCount > 0;
  // Real per-source estimate (sum of each create's registry token class) -- equals the frozen tranche budget for
  // the same create set, so the first authorization gate no longer passes deceptively while the binding gate defers.
  const estimatedTokens = createHashes.reduce((sum, h) => sum + tokenCostOfHash(h), 0);
  return {
    newExports, reusedExports,
    creates: createHashes.length,
    estimatedTokens,
    createHashes, adoptedNewHashes: newExportHashes.filter((h) => adoptable.has(h)),
    inventoryHashes: reusedExportHashes,
    // Back-compat field kept, but it is NO LONGER a region-wide gate: it now reports whether ANY account's inventory
    // is adoptable (the run proceeds regardless; inventory is adopted per account where fresh).
    inventoryAdoptable: anyInventoryAdoptable,
    inventoryAdoptableByHash, inventoryAdoptableCount, anyInventoryAdoptable,
    adoptable,
  };
}

// ===================== WP16: TERMINAL-CYCLE REPLAY + REFUSED-SHADOW SEMANTICS (ZERO acquisition change) =====================
// Two PROVEN production failures of the natural scheduler `listing-health-v3` job:
//   (a) TERMINAL-CYCLE REPLAY (us-ca 2026-09-24): the dedicated base cycle listing-health-v3-<region>/<cycle_date> had
//       ALREADY been finalized 'succeeded' by an earlier (owner-authorized, Listings-only) operation. The live path still
//       ran runSources -> materialize -> runReports BEFORE finalize, and runReports' report-job upsert hit the durable
//       reject_append_to_terminal_cycle trigger (400 "sync cycle ... is terminal (succeeded); refusing to append/alter
//       child work") -- so the documented "already-terminal succeeded replay = zero-create success" (finalize step) was
//       UNREACHABLE and the job failed although listing-health-v3 was already current.
//   (b) REFUSED / FAILED SHADOW SAVE (india 2026-09-25): one account's natural shadow save failed (report-worker records
//       EVERY saver throw as save-stage SNAPSHOT_SAVE_FAILED with a static message) after the zero-export reconciler had
//       already published that account's to=<cycle_date> -> reportFailed=1 -> cycle 'partial' -> job exit 1.
// The fix NEVER appends to a terminal cycle and NEVER re-acquires: a terminal base cycle is detected up front (live only,
// opt-in readBaseCycle) and short-circuits BEFORE any gate / balance read / cycle / reservation / source / materialize /
// report / finalize call. Instead, for each account, and for each account whose natural shadow save failed, the SAME
// three-part ALREADY-CURRENT proof decides (owner rule -- timestamp / date / job row / shadow row alone never count):
//   (i)   CONTENT IDENTITY: the listing-health-v3 manifest token (the complete-dependency fingerprint of
//         resolveListingHealthV3DependencyBundle; equal token => byte-identical derived payload, see
//         listing-health-v3-fingerprint-invariant) of the durable evidence this run would publish EQUALS the content
//         identity recorded by the newest publication lineage (its job's durable_content_deps). On the refused-shadow path
//         the durable Listings + Listings-Raw pointers must ALSO be exactly what THIS run persisted (materialize's per-
//         account durable ack 'replaced'|'unchanged' + the same content sha) -- never an older/newer pointer;
//   (ii)  LINEAGE: that newest publication job (the latest sync_report_jobs row for (listing-health-v3, account) OUTSIDE
//         this run's own base cycle, whose natural-shape jobs -- batch depends_on, no durable_content_deps -- are never a
//         listing-health-v3 publication lineage) is PROMOTABLE and revisionCoveredByJob covers the evidence, and its
//         scheduler-v2 shadow is publisher-valid for EXACTLY requestedAsOf (evaluatePublicationBinding);
//   (iii) LIVE READ-BACK: the canonical live row IS that shadow's promotion (the shared publisher read-back + exact stamp
//         + equal hydrated payload, evaluatePublicationBinding) AND the dashboard's served selector returns EXACTLY that
//         live row (defaultServedVerdict).
// All match -> 'already-current' (counted, never 'published'); any mismatch / read error -> a REAL typed failure
// ('base-cycle-terminal:not-current:<check>' / 'shadow-refused:<check>'), fail closed. The zero-export reconciler /
// recovery worker repairs publication from durable evidence; the natural job never re-acquires. Every WP16 collaborator
// is OPTIONAL and default-absent, so a run without them is byte-identical to the pre-WP16 operator.
const TERMINAL_CYCLE_STATUSES = Object.freeze(["succeeded", "partial", "failed"]);
export const LHV3_ALREADY_CURRENT_CHECKS = Object.freeze(["content", "lineage", "readback"]);
const LHV3_REPORT_KEY = "listing-health-v3";
const LHV3_SHADOW_KEY = "scheduler-v2/" + LHV3_REPORT_KEY;
// The two DURABLE families the natural run persists (materialize WORK B); inventory is reuse-only (already durable).
const LHV3_RUN_EVIDENCE_KEYS = Object.freeze({ listings: "listing-health-v3:listings", listingsRaw: "listing-health-v3:listings-raw" });
// Only these acks prove the durable pointer IS this run's batch ('replaced' = written now; 'unchanged' = equal
// validated_at + payload_sha + object_path already durable). 'stale-save' (a strictly-newer pointer won), 'conflict',
// 'schema-missing', 'write-failed', 'skipped-evidence' or no record at all never do.
const LHV3_RUN_EVIDENCE_ACKS = new Set(["replaced", "unchanged"]);
// evaluatePublicationBinding STALE reasons that are LIVE READ-BACK failures (check iii); every other reason is LINEAGE.
const LHV3_READBACK_BINDING_REASON = /^(live-unpromoted|live-identity-mismatch|live-readback|live-refresh-differs|live-payload-unavailable|live-payload-differs|live-params-extra-differs)(:|$)/;

// A SAFE, bounded diagnostic token from a typed reason: the leading code segment (plus ONE following segment only when
// it is itself a static token), lowercased to [a-z0-9-]. A thrown message / URL / id tail is never carried.
function reasonToken(v) {
  const parts = S(v).split(":");
  const head = S(parts[0]).trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "unknown";
  const second = parts.length > 1 ? S(parts[1]).trim() : "";
  return /^[a-z0-9-]{1,48}$/.test(second) ? head + ":" + second : head;
}
const uniqSorted = (a) => [...new Set((Array.isArray(a) ? a : []).map((x) => S(x)).filter((x) => x.trim() !== ""))].sort();

// ---- WP16 fixer: PURE helpers the ingestion CLI wires (no I/O; exported so the CLI wiring is offline-testable) ----

// SERVE-GATE ATTESTATION (P2-A). Check (iii) runs the dashboard's OWN served selector (selectLhv3), which serves the
// live row ONLY when the VERCEL production flags LHV3_PUBLISH_LIVE + LISTING_HEALTH_V3 are both exactly 'true'. The
// scheduler never sees Vercel's env, and the workflow must NEVER set LISTING_HEALTH_V3 (the build-time UI flag; pinned by
// scheduler-v2-lhv3-workflow.test.js C). So the CLI reads ONE dedicated owner ATTESTATION variable instead:
// LHV3_SERVE_GATE_ATTESTED exactly 'true' attests that BOTH Vercel prod flags are 'true' -> the selector env carries
// both flags; ANY other value ('TRUE' / '1' / ' true' / unset / ...) -> an EMPTY env -> selectLhv3 'serve-flag-off' ->
// the proof fails closed ('served-serve-flag-off') exactly as before. The literal flag names in the caller's env are
// NEVER read, so a stray LHV3_PUBLISH_LIVE / LISTING_HEALTH_V3 in the scheduler env can never fake the attestation.
// Owner procedure: change the repository variable together with the Vercel flags (WP13 wires it into the job env).
export const LHV3_SERVE_GATE_ATTESTATION_VAR = "LHV3_SERVE_GATE_ATTESTED";
export function lhv3ServeEnvFromAttestation(env) {
  const attested = !!env && typeof env === "object" && env[LHV3_SERVE_GATE_ATTESTATION_VAR] === "true";
  return attested ? { LHV3_PUBLISH_LIVE: "true", LISTING_HEALTH_V3: "true" } : {};
}

// GITHUB_OUTPUT lines of one ingestion run (WP13 gates the immediate listing-health-v3 reconcile on them):
//   lhv3_phase             = the evidence phase ('complete' | 'base-cycle-terminal' | 'partial' | ...), a bounded
//                            [a-z0-9-] token, else 'unknown' (never a free-form / multi-line value);
//   lhv3_durable_persisted = 'true' ONLY when THIS run's materialize acked at least one durable Listings / Listings-Raw
//                            pointer 'replaced' | 'unchanged' (the durable evidence the zero-export reconciler publishes
//                            from includes this run's batch) -- read from the per-account durableByAccount record (the
//                            SAME acks the refused-shadow proof uses), else from the durableWritten + durableUnchanged
//                            counters; 'false' for a dry-run, a stop before materialize, the read-only terminal
//                            base-cycle path, or zero durable acks.
export function lhv3IngestionGithubOutputs(evidence) {
  const e = evidence && typeof evidence === "object" ? evidence : {};
  const phase = /^[a-z0-9-]{1,64}$/.test(S(e.phase)) ? S(e.phase) : "unknown";
  const mat = e.aliases && typeof e.aliases === "object" ? e.aliases : null;
  let persisted = false;
  if (mat && mat.durableByAccount && typeof mat.durableByAccount === "object") {
    persisted = Object.values(mat.durableByAccount).some((rec) => rec && typeof rec === "object"
      && Object.values(LHV3_RUN_EVIDENCE_KEYS).some((k) => rec[k] && LHV3_RUN_EVIDENCE_ACKS.has(S(rec[k].ack))));
  }
  if (!persisted && mat) {
    const acked = Number(mat.durableWritten || 0) + Number(mat.durableUnchanged || 0);
    persisted = Number.isFinite(acked) && acked > 0;
  }
  return [["lhv3_phase", phase], ["lhv3_durable_persisted", persisted ? "true" : "false"]];
}

// The CLI's ONE long-lived READ-ONLY pg client for the publication-job read (P3-B), as a pure factory over an injected
// (sync or async) client constructor -- offline-testable with a fake. Lazily connected on first use. A construction /
// connect failure is MEMOIZED (every later read fails FAST, closed). The client's 'error' event (an idle-connection drop /
// pooler restart; WITHOUT a listener Node raises it as an UNCAUGHT exception that kills the CLI before its EVIDENCE line)
// is listened and MEMOIZED (lib/server/recovery/store-pg.js convention): every later read throws a typed
// 'pg-client-error:<code>' -> the proof fails closed (content 'published-identity-unreadable') and the EVIDENCE line
// still prints. The CLI's client config carries statement_timeout + query_timeout so a hung query cannot stall the run.
export function buildLhv3ReadOnlyPgReader({ makeClient } = {}) {
  if (typeof makeClient !== "function") throw new Error("buildLhv3ReadOnlyPgReader requires makeClient (fail closed).");
  let clientPromise = null;
  let failure = null;
  const code = (e) => S(e && (e.code || e.name)).replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 40) || "error";
  async function rows(sql, params) {
    if (failure) throw new Error(failure);
    if (!clientPromise) {
      clientPromise = (async () => {
        let client = null;
        try {
          client = await makeClient();
          if (!client || typeof client.query !== "function" || typeof client.connect !== "function") throw new Error("malformed pg client");
          if (typeof client.on === "function") client.on("error", (e) => { if (!failure) failure = "pg-client-error:" + code(e); });
          await client.connect();
          return client;
        } catch (e) {
          if (!failure) failure = "pg-connect-failed:" + code(e);
          throw new Error(failure);
        }
      })();
    }
    const client = await clientPromise;
    if (failure) throw new Error(failure);
    const res = await client.query(sql, params);
    return Array.isArray(res && res.rows) ? res.rows : [];
  }
  async function close() {
    if (!clientPromise) return;
    try { const client = await clientPromise; await client.end(); } catch (_e) { /* never affects the exit code */ }
  }
  return Object.freeze({ rows, close, failure: () => failure });
}

/**
 * Build the per-account ALREADY-CURRENT proof (pure orchestration over INJECTED read-only collaborators; ZERO writes,
 * ZERO DataDoe). Collaborators (production wiring: scripts/release/listing-health-v3-ingestion.mjs):
 *   resolveBundle({ accountId, country, requestedAsOf }) -> resolveListingHealthV3DependencyBundle result (the SAME
 *       resolver + readers the zero-export listing-health-v3 reconciler uses, so the manifest token is byte-identical)
 *   readPublicationJob({ reportKey, accountId, excludeCycleId }) -> the LATEST sync_report_jobs lineage row for
 *       (reportKey, accountId) whose cycle_id != excludeCycleId (getLatestReportJobLineage shape) | null
 *   readSnapshot({ reportKey, accountId, paramsHash }) -> report_snapshots row | null  (getReportSnapshot)
 *   loadStoragePayload(path) -> payload                                                 (storage-first hydration)
 *   verifyLiveReadback({ reportKey, liveReportKey, accountId, paramsHash }) -> { ok, reason } (buildLiveReadback)
 *   selectServed({ accountId, requestedAsOf }) -> { row, reason, via }                  (serve-selectors selectLhv3)
 *   liveContracts, computeHash, reportDerivations                                       (the publisher's own)
 * Returns async ({ accountId, country, requestedAsOf, excludeCycleId?, runEvidence? }) ->
 *   { ok:true, check:null, reason:null } | { ok:false, check:'content'|'lineage'|'readback', reason:<safe token> }.
 * Checks run in order content -> lineage -> read-back; the first failing check is reported. Any read error fails closed.
 */
export function buildListingHealthV3AlreadyCurrentProof({
  resolveBundle, readPublicationJob, readSnapshot, loadStoragePayload, verifyLiveReadback, selectServed,
  liveContracts, computeHash, reportDerivations,
} = {}) {
  for (const [name, fn] of [["resolveBundle", resolveBundle], ["readPublicationJob", readPublicationJob], ["readSnapshot", readSnapshot], ["loadStoragePayload", loadStoragePayload], ["verifyLiveReadback", verifyLiveReadback], ["selectServed", selectServed], ["computeHash", computeHash]]) {
    if (typeof fn !== "function") throw new Error(`buildListingHealthV3AlreadyCurrentProof requires ${name} (fail closed).`);
  }
  const contract = liveContracts && liveContracts[LHV3_REPORT_KEY];
  if (!contract || typeof contract.liveParams !== "function" || !S(contract.liveReportKey).trim()) throw new Error("buildListingHealthV3AlreadyCurrentProof requires the listing-health-v3 live contract (fail closed).");
  const derivation = reportDerivations && reportDerivations[LHV3_REPORT_KEY];
  if (!derivation || typeof derivation.validatePayload !== "function") throw new Error("buildListingHealthV3AlreadyCurrentProof requires the listing-health-v3 derivation (fail closed).");
  const hydrate = (row) => hydrateSnapshotPayload(row, loadStoragePayload);

  return async function proveListingHealthV3AlreadyCurrent({ accountId, country = null, requestedAsOf, excludeCycleId = null, runEvidence = null } = {}) {
    const no = (check, reason) => ({ ok: false, check, reason: reasonToken(reason) });
    const acct = S(accountId);
    if (acct.trim() === "" || !isDate(requestedAsOf)) return no("content", "bad-args");

    // ---- (i) CONTENT IDENTITY ----
    // The identity of the evidence this run would publish: the complete-dependency manifest token of the DURABLE
    // evidence (the only evidence a listing-health-v3 live row is ever promoted from).
    let b;
    try { b = await resolveBundle({ accountId: acct, country, requestedAsOf: S(requestedAsOf) }); }
    catch (_e) { return no("content", "evidence-unreadable"); }
    if (!b || b.eligible !== true) return no("content", "evidence-" + S(b && b.reason));
    const contentDeps = uniqSorted(b.contentDeps);
    if (!contentDeps.length) return no("content", "evidence-identity-empty");
    const revision = { eligible: true, revisionId: b.revisionId || null, deps: Array.isArray(b.deps) ? b.deps : [], contentDeps, status: b.status || null };
    // Refused-shadow path: the durable Listings + Listings-Raw pointers must be EXACTLY what THIS run persisted (content
    // sha), so the identity is this run's evidence -- never an older pointer a failed persist left behind, nor a newer one.
    if (runEvidence) {
      const bb = (b.bundle && typeof b.bundle === "object") ? b.bundle : {};
      const lSha = S(bb.listingsSnapshot && bb.listingsSnapshot.payload_sha);
      const rSha = S(bb.rawSnapshot && bb.rawSnapshot.payload_sha);
      if (!S(runEvidence.listingsPayloadSha) || lSha !== S(runEvidence.listingsPayloadSha)) return no("content", "run-evidence-not-durable:listings");
      if (!S(runEvidence.rawPayloadSha) || rSha !== S(runEvidence.rawPayloadSha)) return no("content", "run-evidence-not-durable:listings-raw");
    }
    // The existing live/shadow content identity: the manifest token recorded by the NEWEST publication lineage (a
    // listing-health-v3 live row is only ever promoted from a job carrying its manifest in durable_content_deps).
    let job;
    try { job = await readPublicationJob({ reportKey: LHV3_REPORT_KEY, accountId: acct, excludeCycleId }); }
    catch (_e) { return no("content", "published-identity-unreadable"); }
    if (!job) return no("content", "published-identity-absent");
    if (excludeCycleId != null && S(job.cycleId) === S(excludeCycleId)) return no("lineage", "job-in-excluded-cycle"); // defensive: the reader must exclude it
    if (uniqSorted(job.durableContentDeps).join("\n") !== contentDeps.join("\n")) return no("content", "published-identity-differs");

    // ---- (ii) LINEAGE ----
    // The newest publication job must ITSELF be promotable (a newer in-flight / failed derivation is never skipped over)
    // and cover the evidence; its shadow is then proven publisher-valid for EXACTLY requestedAsOf by the shared binding.
    if (!jobIsPromotable(job)) return no("lineage", "latest-job-not-promotable");
    if (!revisionCoveredByJob(revision, job)) return no("lineage", "job-does-not-cover-evidence");
    let shadow = null; let hydShadow = null; let live = null; let hydLive = null; let liveReadback = null;
    try { shadow = await readSnapshot({ reportKey: LHV3_SHADOW_KEY, accountId: acct, paramsHash: S(job.snapshotParamsHash) }); } catch (_e) { shadow = null; }
    hydShadow = await hydrate(shadow);
    const shadowParams = shadow && shadow.params && typeof shadow.params === "object" && !Array.isArray(shadow.params) ? shadow.params : null;
    if (shadowParams) {
      let liveParams = null;
      try { liveParams = contract.liveParams(shadowParams); } catch (_e) { liveParams = null; }
      const candHash = liveParams ? computeHash(contract.liveReportVersion, liveParams) : null;
      if (candHash) {
        try { live = await readSnapshot({ reportKey: contract.liveReportKey, accountId: acct, paramsHash: candHash }); } catch (_e) { live = null; }
        hydLive = await hydrate(live);
        try { liveReadback = await verifyLiveReadback({ reportKey: LHV3_REPORT_KEY, liveReportKey: contract.liveReportKey, accountId: acct, paramsHash: candHash }); }
        catch (_e) { liveReadback = { ok: false, reason: "readback-threw" }; }
      }
    }
    let binding;
    try {
      binding = evaluatePublicationBinding({
        revision, accountId: acct, reportKey: LHV3_REPORT_KEY, requestedAsOf: S(requestedAsOf), expectedShadowKey: LHV3_SHADOW_KEY,
        job, shadow, hydratedShadowPayload: hydShadow, live, hydratedLivePayload: hydLive, liveReadback,
        contract, computeHash, reportDerivations, revisionChangedReason: "job-does-not-cover-evidence",
      });
    } catch (_e) { binding = { state: PUBLICATION_STATE.STALE, reason: "binding-threw" }; }
    if (!binding || binding.state !== PUBLICATION_STATE.PUBLICATION_NOT_REQUIRED) {
      const r = S(binding && binding.reason) || "binding-malformed";
      return no(LHV3_READBACK_BINDING_REASON.test(r) ? "readback" : "lineage", r);
    }

    // ---- (iii) LIVE READ-BACK: the dashboard's served selector must return EXACTLY that proven live row ----
    let served;
    try { served = await selectServed({ accountId: acct, requestedAsOf: S(requestedAsOf) }); } catch (_e) { served = { row: null, reason: "read-failed", via: null }; }
    let verdict;
    try { verdict = defaultServedVerdict(served, servedRowIdentity(live)); } catch (_e) { verdict = { ok: false, reason: "verdict-threw" }; }
    if (!verdict || verdict.ok !== true) return no("readback", "served-" + S(verdict && verdict.reason));
    return { ok: true, check: null, reason: null };
  };
}

// Run the already-current proof for each account, SEQUENTIALLY (deterministic order, bounded read load). A missing
// proof / thrown proof / malformed result is a REAL failure (fail closed). `runEvidenceOf(accountId)` (refused path)
// must prove the run's own durable evidence first. -> [{ accountId, current, check, reason, detail }]
async function evaluateAlreadyCurrent({ accounts, prove, requestedAsOf, excludeCycleId, prefix, runEvidenceOf = null }) {
  const out = [];
  for (const a of accounts) {
    const accountId = S(a && a.accountId);
    const realFailure = (check, detail) => out.push({ accountId, current: false, check, reason: `${prefix}:${check}`, detail: reasonToken(detail) });
    if (typeof prove !== "function") { realFailure("content", "proof-unavailable"); continue; }
    let runEvidence = null;
    if (typeof runEvidenceOf === "function") {
      const re = runEvidenceOf(accountId);
      if (!re || re.ok !== true) { realFailure("content", (re && re.reason) || "run-evidence-not-durable"); continue; }
      runEvidence = re.evidence;
    }
    let r;
    try { r = await prove({ accountId, country: a && a.country != null ? a.country : null, requestedAsOf, excludeCycleId, runEvidence }); }
    catch (_e) { r = { ok: false, check: "content", reason: "proof-threw" }; }
    if (r && r.ok === true) { out.push({ accountId, current: true, check: null, reason: null, detail: null }); continue; }
    realFailure(LHV3_ALREADY_CURRENT_CHECKS.includes(r && r.check) ? r.check : "content", (r && r.reason) || "proof-malformed");
  }
  return out;
}

// The run's OWN durable evidence for one account (refused path): BOTH durable families were persisted by THIS pass as
// 'replaced' | 'unchanged' with a content sha (materialize summary.durableByAccount). Anything else fails closed.
function runEvidenceFromMaterialize(matSummary, accountId) {
  const byAcct = matSummary && matSummary.durableByAccount && typeof matSummary.durableByAccount === "object" ? matSummary.durableByAccount : null;
  const rec = byAcct && Object.prototype.hasOwnProperty.call(byAcct, accountId) ? byAcct[accountId] : null;
  const l = rec ? rec[LHV3_RUN_EVIDENCE_KEYS.listings] : null;
  const r = rec ? rec[LHV3_RUN_EVIDENCE_KEYS.listingsRaw] : null;
  const good = (e) => !!e && LHV3_RUN_EVIDENCE_ACKS.has(S(e.ack)) && S(e.payloadSha).trim() !== "";
  if (!good(l)) return { ok: false, reason: "run-evidence-not-durable:" + (l ? reasonToken(l.ack) : "missing") };
  if (!good(r)) return { ok: false, reason: "run-evidence-not-durable:" + (r ? reasonToken(r.ack) : "missing") };
  return { ok: true, evidence: { listingsPayloadSha: S(l.payloadSha), rawPayloadSha: S(r.payloadSha) } };
}

// Aggregate per-account results into the evidence counters. refusedReal = accounts whose write was refused (the
// terminal base cycle refuses every append; a failed shadow save) and that did NOT prove already-current.
function alreadyCurrentCounts(results) {
  const refusals = results.filter((r) => !r.current).map((r) => ({ accountId: r.accountId, reason: r.reason, detail: r.detail }));
  return { alreadyCurrent: results.filter((r) => r.current).length, refusedReal: refusals.length, refusals };
}

/**
 * Run (or dry-run) the dedicated Listing Health v3 ingestion for ONE region + cycle. INJECTABLE collaborators:
 *   discoverAccounts()                    -> [{ accountId, country, currency, name }]  (authoritative primary directory)
 *   buildPlan({accounts,connections,cycleDate}) -> frozen plan (default buildListingHealthV3Plan)
 *   resolveCost({plan})                   -> the freshness-aware cost object (default binds planListingHealthV3IngestionCost)
 *   checkBalance()                        -> { usable:number, reserve?:number }         (DataDoe usable balance)
 *   runSources({plan,region,cycleDate,operationId,budget}) -> { drained, creates, tokens, ... } (resumable source worker)
 *   materialize({plans,connections})      -> materialization summary                    (per-account aliases)
 *   runReports({plan,region,cycleDate})   -> { succeeded, blocked, failed, drained }    (shadow snapshot derive/save)
 *   finalizeCycle({region,cycleDate})     -> { disposition, status, cycleId }            (guarded finalize_sync_cycle)
 * WP16 OPTIONAL collaborators (all default null => byte-identical pre-WP16 behaviour):
 *   readBaseCycle({region,cycleDate})     -> { id, status } | null  (the dedicated base cycle head; read-only)
 *   readCycleJobs({region,cycleDate})     -> { cycleId, reportJobs:[...], sourceJobs:[...] } (durable rows; read-only)
 *   proveAlreadyCurrent(args)             -> buildListingHealthV3AlreadyCurrentProof(...) result
 * Config: region, cycleDate, mode ("dry-run"|"live"), authorized (bool), gate ({enabled}), connections,
 *   ceiling (override), emergencyReserveTokens, reservationSupported (store capability), pricingKnown.
 * A LIVE scheduled operation is a SUCCESS (ok:true, phase:"complete") ONLY when the dedicated cycle finalizes to a
 * DURABLE terminal status "succeeded" (zero source/report failures). partial/failed/open-work/deferred all return
 * ok:false so the CLI exits nonzero, while last-known-good is preserved (no snapshot is rolled back). WP16 adds exactly
 * two further successes, both requiring EVERY account to be published or PROVEN already-current: (1) a base cycle that
 * was ALREADY terminal before this run (zero appends, zero exports, every account proven already-current); (2) a
 * 'partial' finalize whose ONLY non-successes are failed natural shadow saves each proven already-current (no source
 * failure, no other report failure).
 */
export async function runListingHealthV3Ingestion({
  region, cycleDate, mode = "dry-run",
  authorized = false, gate = null, connections = [],
  discoverAccounts, buildPlan = buildListingHealthV3Plan, resolveCost, checkBalance,
  runSources, materialize, runReports, finalizeCycle,
  // EXACT AUTHORIZATION BINDING collaborators (live): freezeBudget({plan,region,cycleDate}) computes the frozen NEW-tranche
  // budget (fingerprint + request hashes + ceilings) WITHOUT persisting; readFrozenBudget({region,cycleDate,trancheKey})
  // returns the durable frozen budget already on this region's v3 cycle (or null for a NEW cycle). Both are REQUIRED for
  // a live run: a missing collaborator returns typed awaiting-budget (binding-unavailable) before any paid work.
  freezeBudget = null, readFrozenBudget = null,
  ceiling = null, emergencyReserveTokens = V3_DEFAULT_EMERGENCY_RESERVE_TOKENS,
  // P1-3: EXPLICIT DURABLE AUTHORIZATION -- read from the durable control system (default: the reviewed region
  // config), bound to the region + pricing revision. INJECTABLE so a future migration-backed operator-runtime
  // authorization table can replace it without touching this operation's logic. `readAuthorization` returns a typed
  // decision (never throws for missing/stale/malformed authz -> those become awaiting-budget, not a crash).
  readAuthorization = readListingHealthV3Authorization,
  pricingRevision = LISTING_HEALTH_V3_PRICING_REVISION,
  reservationSupported = true, pricingKnown = true,
  // WP16 (terminal-cycle replay + refused-shadow semantics): OPTIONAL read-only collaborators, default ABSENT so every
  // existing caller/test is byte-identical. See buildListingHealthV3AlreadyCurrentProof.
  readBaseCycle = null, readCycleJobs = null, proveAlreadyCurrent = null,
  now = () => Date.now(), log = () => {},
} = {}) {
  const dryRun = mode !== "live";
  const ev = { region: S(region), cycleDate: S(cycleDate), mode: dryRun ? "dry-run" : "live", operationId: listingHealthV3OperationId(region, cycleDate), phase: "auth", ok: false, creates: 0, tokens: 0, accounts: 0, newExports: 0, ceiling: null, estimatedTokens: 0, snapshots: 0, problems: [] };
  const fail = (phase, problem) => ({ ...ev, phase, ok: false, problems: [...ev.problems, problem] });
  // Structured observability sink: route SAFE, structured events (an UPPERCASE_SNAKE tag + a JSON body of primitive,
  // non-secret fields) into the operator's EXISTING log sink -- reuse, no new vendor. This is the established operator
  // log convention. Callers that don't inject `log` get the no-op default. It NEVER throws and NEVER carries a
  // credential/token/cookie, a raw seller id, the org fingerprint, a signed URL, row content, or PII.
  const emit = (tag, obj) => { try { log(S(tag) + " " + JSON.stringify(obj)); } catch (_e) { /* observability must never affect the operation */ } };

  // 1) explicit operator authorization.
  if (authorized !== true) return fail("auth", "operator invocation is not explicitly authorized (fail closed)");
  // 2) independent ingestion gate (default DISABLED). Live refuses while disabled; dry-run may proceed to prove cost.
  const gateEnabled = !!(gate && gate.enabled === true);
  ev.gateEnabled = gateEnabled;
  if (!dryRun && !gateEnabled) return fail("gate", "live mode refused: the listing-health-v3 ingestion gate is disabled (default)");
  // 3) region allowlist (routing scope).
  if (!V3_INGESTION_REGIONS.includes(S(region)) || !isRoutingScope(S(region))) return fail("region", `unsupported region "${region}" (only india | europe-au | us-ca)`);
  if (!isDate(cycleDate)) return fail("cycle", `cycleDate must be a real calendar date (got "${cycleDate}")`);
  if (typeof discoverAccounts !== "function") return fail("discover", "discoverAccounts collaborator is required (fail closed)");

  // 4) discover authoritative primary accounts.
  let accounts;
  try { accounts = await discoverAccounts(); } catch (e) { return fail("discover", "account discovery failed: " + safe(e)); }
  accounts = Array.isArray(accounts) ? accounts : [];
  // 5) resolve region from account metadata (marketplace country). Drop connection-prefixed / missing-country ids.
  const regionAccounts = accounts.filter((a) => a && a.accountId && !String(a.accountId).includes(":") && S(a.country).trim() && accountInScope(S(region), a.country));
  ev.accounts = regionAccounts.length;
  if (!regionAccounts.length) return { ...ev, phase: "complete", ok: true, note: "no-accounts-in-region", creates: 0, tokens: 0 };

  // 6) build + FREEZE the plan. `region` is forwarded so a composition-provided buildPlan can derive the inventory-only
  //    overflow split from that region's FBA cycle evidence; buildPlan may be sync or async, so it is awaited.
  let plan;
  try { plan = await buildPlan({ accounts: regionAccounts, connections, cycleDate, region: S(region) }); } catch (e) { return fail("plan", "plan build failed: " + safe(e)); }
  const v3Requests = (plan.reportRequests || []).filter((r) => r && r.reportKey === "listing-health-v3");
  if (!v3Requests.length) return fail("plan", "frozen plan contains no listing-health-v3 requests (fail closed)");

  // 6b) FUTURE ACCOUNT-IDENTITY GUARD (pure; dry-run + live): refuse BEFORE any create if two distinct accounts would
  //     resolve to one marketplace-independent per-account read hash (a shared seller id across marketplaces would
  //     cross-contaminate aliases). Diagnostics name only safe public account-id prefixes.
  try { assertNoDuplicatePerAccountReadIdentities({ v3Requests, connections }); }
  catch (e) { return fail("identity", safe(e)); }

  // 7) validate ceiling + cost + pricing/reservation + balance BEFORE any POST.
  let ceilingCheck;
  let authorizationBinding = null; // set by the live binding gate; handed to runSources
  // The ceiling is COMPUTED from the frozen plan's eligible account membership (2 creates per <=5-seller batch), so
  // account growth scales the ceiling instead of hard-failing against a fixed 4/8/4 literal (an explicit `ceiling`
  // still overrides for a reviewed test). A plan fanning out more creates than the membership justifies is drift.
  try { ceilingCheck = assertListingHealthV3ExportCeiling({ region: S(region), plans: v3Requests, accountCount: regionAccounts.length, ceiling }); }
  catch (e) { return fail("ceiling", "export-ceiling gate failed (fail closed): " + safe(e)); }
  ev.newExports = ceilingCheck.newExports;
  ev.ceiling = ceilingCheck.ceiling;
  if (typeof resolveCost !== "function") return fail("budget", "resolveCost collaborator is required (fail closed)");
  let cost;
  try { cost = await resolveCost({ plan }); } catch (e) { return fail("budget", "cost resolution failed (fail closed): " + safe(e)); }
  ev.creates = Number(cost.creates || 0);
  ev.estimatedTokens = Number(cost.estimatedTokens || 0);
  // The ceiling bounds the number of CREATES structurally (not tokens); re-assert against the freshness-aware count.
  if (Number(cost.creates || 0) > Number(ceilingCheck.ceiling)) {
    return fail("ceiling", `freshness-aware create count ${cost.creates} exceeds the region ceiling ${ceilingCheck.ceiling}; refusing (fail closed)`);
  }
  ev.inventoryAdoptable = !!cost.anyInventoryAdoptable;
  ev.inventoryAdoptableCount = Number(cost.inventoryAdoptableCount || 0);

  // OPTIONAL-INVENTORY CONTRACT (per-account partial publication): the run PROCEEDS regardless of inventory
  // adoptability. Listings + durable OLI publish for every eligible account; FBA inventory is adopted PER ACCOUNT
  // where its reuse-only cache is fresh, and inventory-dependent fields resolve unavailable for the rest (the derive
  // yields inventory.available:false, never a fabricated zero). The region-wide "defer the whole region when ANY
  // account's inventory is not adoptable" gate is REMOVED: it blocked every account on one account's FBA gap. The
  // paid-create budget/ceiling/identity/authorization/balance gates below are UNCHANGED (they gate listings/
  // listings-raw creates only), and inventory stays REUSE-ONLY (the inventoryCreated hard-guard still fails closed).

  // 7a) WP16 TERMINAL BASE CYCLE (LIVE only; opt-in -- readBaseCycle absent => byte-identical). The dedicated base cycle
  //     listing-health-v3-<region>/<cycleDate> can already be TERMINAL before this run (an earlier operation -- e.g. an
  //     owner-authorized Listings-only ingestion -- finalized it). Every child append to it is refused by the durable
  //     reject_append_to_terminal_cycle trigger, so the run must NEVER reach runSources / materialize / runReports /
  //     finalize (nor the authorization / binding / DataDoe balance reads that only guard paid work): it is decided HERE,
  //     read-only -- ZERO creates, ZERO DataDoe exports/polls/downloads/balance reads, ZERO cycle/job/shadow writes. Each
  //     regional account is 'already-current' ONLY by the three-part proof (content + lineage + live/served read-back);
  //     any other account is a REAL typed failure 'base-cycle-terminal:not-current:<check>' (LKG preserved; the zero-
  //     export reconciler / recovery worker republishes from durable evidence -- the natural job never re-acquires).
  //     A base-cycle read error fails closed. A pending/running/absent base cycle continues on the UNCHANGED path.
  //     KNOWN LIMITATION (WP16 P3-A, decided with evidence -- materialize is deliberately NOT run on this path): a cycle
  //     that finalized with a MISSING / stale durable Listings or Listings-Raw pointer (materialize's FAIL-SOFT durable
  //     write: schema-missing / write-failed / skipped-evidence / stale-save) is NOT repaired by a same-date rerun. Running
  //     materialize here is NOT provably safe: (1) the Listings / Listings-Raw batch request_hash is DATE-FREE (freshness
  //     travels as a non-hash field), so the export-cache entry under it is proven fresh for THIS cycle only by runSources
  //     (a create, or an adoption only when fetched_at >= freshnessNotBefore) -- which this read-only path never runs, so
  //     nothing here proves a cached entry under a planned hash is not OLDER than this cycle's boundary; and (2) the durable
  //     record RPC is as_of-DOMINANT (p_as_of > existing.as_of -> 'replaced' REGARDLESS of validated_at; migrations
  //     20260926/20260927), so persisting such an older cached batch under as_of = cycleDate would FALSELY advance -- and
  //     could REGRESS -- the durable pointer. Instead each account is proven against the durable evidence AS IT STANDS:
  //     truthfully typed 'base-cycle-terminal:not-current:content' when it is absent / differs, LKG preserved; the next
  //     cycle date's natural run re-persists the durable pointer from a runSources-proven fresh batch (materialize
  //     persists durable on the alias skippedStale path too), and the zero-export reconciler publishes from it.
  if (!dryRun && typeof readBaseCycle === "function") {
    let base;
    try { base = await readBaseCycle({ region: S(region), cycleDate: S(cycleDate) }); }
    catch (e) { return fail("base-cycle", "base cycle unreadable (fail closed; zero appends, zero exports): " + safe(e)); }
    const baseStatus = base ? S(base.status) : "";
    if (base && TERMINAL_CYCLE_STATUSES.includes(baseStatus)) {
      const results = await evaluateAlreadyCurrent({
        accounts: regionAccounts, prove: proveAlreadyCurrent, requestedAsOf: S(cycleDate),
        excludeCycleId: base.id == null ? null : S(base.id), prefix: "base-cycle-terminal:not-current",
      });
      const counts = alreadyCurrentCounts(results);
      emit("LHV3_ALREADY_CURRENT", {
        runId: ev.operationId, region: ev.region, cycleDate: ev.cycleDate, path: "base-cycle-terminal", baseCycleStatus: baseStatus,
        accounts: results.length, alreadyCurrent: counts.alreadyCurrent, refusedReal: counts.refusedReal,
        refusals: counts.refusals.map((x) => ({ account: x.accountId, reason: x.reason, detail: x.detail })),
      });
      const out = {
        ...ev, dryRun: false, creates: 0, tokens: 0, snapshots: 0,
        baseCycleTerminal: true, baseCycleStatus: baseStatus, cycleStatus: baseStatus, ...counts,
      };
      if (counts.refusedReal === 0 && counts.alreadyCurrent === results.length) {
        return { ...out, phase: "complete", ok: true, note: `base cycle already terminal (${baseStatus}) before this run: every one of ${results.length} account(s) PROVEN already-current (content + lineage + live/served read-back); zero appends, zero exports.` };
      }
      return {
        ...out, phase: "base-cycle-terminal", ok: false,
        problems: [...ev.problems, `base-cycle-terminal:not-current for ${counts.refusedReal} of ${results.length} account(s)`],
        note: `base cycle already terminal (${baseStatus}) before this run: ${counts.alreadyCurrent} account(s) proven already-current, ${counts.refusedReal} NOT current (typed); zero appends, zero exports; last-known-good preserved -- the zero-export listing-health-v3 reconciler republishes from durable evidence (the natural job never re-acquires).`,
      };
    }
  }

  if (!dryRun) {
    if (pricingKnown !== true) return fail("budget", "DataDoe pricing state is unknown; refusing to create (fail closed)");
    if (reservationSupported !== true) return fail("budget", "atomic pre-POST create reservation is unavailable; refusing to create (fail closed)");
    // The three spend concepts are enforced as THREE SEPARATE gates, in order:
    //   (1) STRUCTURAL required  -- 2 creates per <=5-seller batch (ceilingCheck.newExports); tokens = the
    //       freshness-aware estimate. This is what the run NEEDS and scales with account growth.
    const requiredCreates = Number(ceilingCheck.newExports || 0);
    const requiredTokens = Number(cost.estimatedTokens || 0);
    ev.requiredCreates = requiredCreates; ev.requiredTokens = requiredTokens;

    //   (2) EXPLICIT DURABLE AUTHORIZATION -- what an operator has reviewed and authorized for the region (bound to
    //       the pricing revision), read from the durable control system. NOT derived from the token balance and it
    //       does NOT auto-increase when accounts are added: growth beyond the authorized ceiling defers here. A
    //       missing / stale (pricing) / malformed / below-required authorization returns a TYPED awaiting-budget
    //       BEFORE any cycle/reservation/POST (zero creates, LKG preserved) -- an operator must review/raise it.
    if (typeof readAuthorization !== "function") return fail("authorization", "readAuthorization collaborator is required for a live run (fail closed)");
    let authz;
    try { authz = await readAuthorization({ region: S(region), pricingRevision: S(pricingRevision) }); }
    catch (e) { authz = { authorized: false, reason: "authorization-unreadable", detail: safe(e) }; }
    const authDecision = decideListingHealthV3Authorization({ region: S(region), accountCount: regionAccounts.length, requiredCreates, requiredTokens, authorization: authz, pricingRevision: S(pricingRevision) });
    ev.authorization = authDecision.authorization && authDecision.authorization.authorized
      ? { maxAccounts: authDecision.authorization.maxAccounts, maxCreates: authDecision.authorization.maxCreates, maxTokens: authDecision.authorization.maxTokens, pricingRevision: authDecision.authorization.pricingRevision }
      : null;
    ev.authorizedCreates = authDecision.authorization && authDecision.authorization.authorized ? authDecision.authorization.maxCreates : null;
    ev.authorizedTokens = authDecision.authorization && authDecision.authorization.authorized ? authDecision.authorization.maxTokens : null;
    if (!authDecision.ok) {
      return {
        ...ev, phase: "awaiting-budget", ok: false, deferred: true, awaitingBudget: true,
        authorizationReason: authDecision.reason, creates: 0, tokens: 0, snapshots: 0,
        note: `NOT authorized (${authDecision.reason}${authDecision.detail ? ": " + authDecision.detail : ""}) for ${S(region)} -- deferred BEFORE any cycle/reservation/POST (zero creates); last-known-good preserved. An operator must review/raise the durable Listing Health v3 authorization (this is SEPARATE from funding the token balance).`,
      };
    }

    //   (2b) EXACT BINDING -- the standing regional authorization is bound to THIS run's actual frozen work: region +
    //        cycleDate + operationId + tranche + sorted membership + sorted frozen request hashes + frozen plan fingerprint
    //        + pricing revision + frozen ceilings. A standing policy authorizes a NEW frozen cycle within its limits (no
    //        daily manual approval); on REPLAY (a frozen budget already persisted on this region's v3 cycle) every bound
    //        element must match EXACTLY, else typed awaiting-budget BEFORE any cycle/reservation/POST. The binding is
    //        handed to runSources, which refuses to persist/POST anything that differs from it (fail closed).
    const trancheKey = `lhv3-new#${S(region)}`;
    const awaitingBinding = (reason, detail) => ({
      ...ev, phase: "awaiting-budget", ok: false, deferred: true, awaitingBudget: true,
      authorizationReason: reason, creates: 0, tokens: 0, snapshots: 0,
      note: `authorization NOT bound (${reason}${detail ? ": " + detail : ""}) for ${S(region)} -- deferred BEFORE any cycle/reservation/POST (zero creates); last-known-good preserved.`,
    });
    if (typeof freezeBudget !== "function") return awaitingBinding("binding-unavailable", "freezeBudget collaborator is required for a live run");
    if (typeof readFrozenBudget !== "function") return awaitingBinding("binding-unavailable", "readFrozenBudget collaborator is required for a live run");
    let frozen = null;
    try { frozen = await freezeBudget({ plan, region: S(region), cycleDate: S(cycleDate) }); } catch (e) { return awaitingBinding("binding-unavailable", safe(e)); }
    const bound = computeListingHealthV3AuthorizationBinding({
      region: S(region), cycleDate: S(cycleDate), operationId: ev.operationId, trancheKey,
      accountIds: regionAccounts.map((a) => a.accountId), frozen, pricingRevision: S(pricingRevision), authorization: authDecision.authorization,
    });
    if (!bound.ok) return awaitingBinding(bound.reason, bound.detail);
    let persisted = null;
    try { persisted = await readFrozenBudget({ region: S(region), cycleDate: S(cycleDate), trancheKey }); } catch (e) { return awaitingBinding("frozen-budget-unreadable", safe(e)); }
    const replay = verifyListingHealthV3ReplayBinding({ binding: bound.binding, persisted });
    if (!replay.ok) return awaitingBinding(replay.reason, replay.detail);
    authorizationBinding = bound.binding;
    ev.authorizationBinding = {
      bindingHash: bound.binding.bindingHash, membershipHash: bound.binding.membershipHash, requestHashesHash: bound.binding.requestHashesHash,
      planFingerprint: bound.binding.planFingerprint, trancheKey, maxCreates: bound.binding.maxCreates,
      estimatedTokens: bound.binding.estimatedTokens, pricingRevision: S(pricingRevision), replay: replay.replay,
    };
    //   (3) LIVE AFFORDABILITY -- even WITH authorization, the usable DataDoe balance minus the emergency reserve
    //       must cover the required tokens. Authorization does NOT imply affordability. estimatedTokens is an
    //       OBSERVED estimate (rowCountBilling=true), so requiring headroom above the reserve also stops a
    //       heavier-than-expected bill from exhausting the account. The atomic pre-POST reservation + frozen tranche
    //       budget remain the true runtime ceiling on top of this.
    if (typeof checkBalance !== "function") return fail("balance", "checkBalance collaborator is required for a live run (fail closed)");
    let bal;
    try { bal = await checkBalance(); } catch (e) { return fail("balance", "balance check failed (fail closed): " + safe(e)); }
    if (!bal || typeof bal.usable !== "number" || !Number.isFinite(bal.usable)) return fail("balance", "usable DataDoe balance is unknown (fail closed)");
    const reserve = typeof bal.reserve === "number" ? bal.reserve : Number(emergencyReserveTokens);
    ev.usableBalance = bal.usable; ev.emergencyReserve = reserve;
    const affordableTokens = bal.usable - reserve;
    ev.affordableTokens = affordableTokens;
    if (requiredTokens > affordableTokens) {
      return {
        ...ev, phase: "awaiting-budget", ok: false, deferred: true, awaitingBudget: true,
        authorizationReason: "insufficient-balance", creates: 0, tokens: 0, snapshots: 0,
        note: `required ${requiredCreates} create(s) / ${requiredTokens} token(s) exceed the usable DataDoe balance minus the emergency reserve (usable ${bal.usable} - reserve ${reserve} = ${affordableTokens}); deferred BEFORE any cycle/reservation/POST (zero creates); last-known-good preserved. Fund to proceed (authorization is already in place).`,
      };
    }
  }

  // DRY-RUN stops here -- ZERO creates, writes, and tokens.
  if (dryRun) {
    return { ...ev, phase: "planned", ok: true, dryRun: true, creates: 0, tokens: 0, plannedCreates: Number(cost.creates || 0), estimatedTokens: Number(cost.estimatedTokens || 0), inventoryAdoptable: !!cost.anyInventoryAdoptable, anyInventoryAdoptable: !!cost.anyInventoryAdoptable, inventoryAdoptableCount: Number(cost.inventoryAdoptableCount || 0), inventoryAdoptableByHash: cost.inventoryAdoptableByHash || {}, note: gateEnabled ? "gate-enabled" : "gate-disabled (dry-run only)" };
  }

  // A live run also REQUIRES the finalize collaborator (the durable success gate). Refuse before any create if missing.
  if (typeof finalizeCycle !== "function") return fail("finalize", "finalizeCycle collaborator is required for a live run (fail closed)");

  // 8) run source jobs (listings + listings-raw CREATE within the frozen budget; inventory REUSE-ONLY). LKG preserved.
  let sourceRes;
  try { sourceRes = await runSources({ plan, region: S(region), cycleDate: S(cycleDate), operationId: ev.operationId, budget: cost, authorizationBinding }); }
  catch (e) { return fail("source", "source run failed (last-known-good preserved): " + safe(e)); }
  ev.creates = Number(sourceRes && sourceRes.creates || 0);
  ev.tokens = Number(sourceRes && sourceRes.tokens || 0);
  ev.drained = !!(sourceRes && sourceRes.drained);
  ev.inventoryCreated = !!(sourceRes && sourceRes.inventoryCreated);
  // CONTRACT: inventory is REUSE-ONLY. A v3 inventory CREATE is a hard violation of the zero-inventory-export contract
  // (finalize counts inventory jobs as "succeeded" and would not distinguish create from reuse -- only this catches it).
  if (ev.inventoryCreated) return fail("source", "inventory export was CREATED but v3 inventory must be reuse-only; fail closed (last-known-good preserved)");

  // 9) materialize validated batch results into isolated per-account aliases (newer-only overwrite). Per-fragment
  //    structured events flow to `emit` (the operator log sink), correlated by this run's operationId.
  let matSummary = null;
  try { matSummary = await materialize({ plans: v3Requests, connections, emit, runId: ev.operationId }); }
  catch (e) { return fail("materialize", "per-account materialization failed (last-known-good preserved): " + safe(e)); }
  ev.aliases = matSummary;
  // RUN SUMMARY (materialization observability): per-account discovery/eligibility/exclusion, the planned new-vs-reused
  // export split, the region create-ceiling, and the aggregate per-result materialization + durable counts. SAFE
  // metadata only (counts / dates / region / ceiling) -- emitted here so it is recorded even if the rejected-fragment
  // guard below then fails the run closed.
  emit("LHV3_RUN_SUMMARY", {
    runId: ev.operationId, region: ev.region, cycleDate: ev.cycleDate, mode: ev.mode,
    accountsDiscovered: accounts.length,
    accountsEligible: regionAccounts.length,
    accountsExcludedPreplan: accounts.length - regionAccounts.length,
    accountsMaterialized: Number((matSummary && matSummary.accounts) || 0),
    accountsSkippedAtMaterialize: Number((matSummary && matSummary.skippedAccounts) || 0),
    newExportsPlanned: Number((cost && cost.newExports) || 0),
    newExportsCreated: Number(ev.creates || 0),
    reusedExports: Number((cost && cost.reusedExports) || 0),
    inventoryCreated: !!ev.inventoryCreated,
    tokens: Number(ev.tokens || 0),
    ceiling: ev.ceiling == null ? null : Number(ev.ceiling),
    // Reaching materialize means the frozen create-ceiling gate already PASSED (a breach defers the whole run before
    // any create); no account/export was excluded by the ceiling on this path.
    ceilingExclusions: 0,
    fragments: {
      materialized: Number(((matSummary && matSummary.aliasesWritten) || 0)) + Number(((matSummary && matSummary.emptyAliases) || 0)),
      emptyAliases: Number((matSummary && matSummary.emptyAliases) || 0),
      reusedOrStale: Number((matSummary && matSummary.skippedStale) || 0),
      missing: Number((matSummary && matSummary.batchMissing) || 0),
      rejected: Number((matSummary && matSummary.rejected) || 0),
    },
    durable: {
      written: Number((matSummary && matSummary.durableWritten) || 0),
      unchanged: Number((matSummary && matSummary.durableUnchanged) || 0),
      stale: Number((matSummary && matSummary.durableStale) || 0),
      skippedEvidence: Number((matSummary && matSummary.durableSkippedEvidence) || 0),
      schemaMissing: Number((matSummary && matSummary.durableSchemaMissing) || 0),
      writeFailed: Number((matSummary && matSummary.durableWriteFailed) || 0),
    },
  });
  // A REJECTED (unattributable / cross-account) fragment is never reflected in the cycle job counters, so guard it here.
  const matRejected = Number((matSummary && matSummary.rejected) || 0);
  if (matRejected > 0) return fail("materialize", `materialization rejected ${matRejected} unattributable fragment(s); fail closed (last-known-good preserved)`);

  // 10) OPTIONAL-INVENTORY: under partial inventory, a non-adoptable account is an EXPECTED state (its inventory
  //     fields resolve unavailable in the derive), NOT a regression -- so there is no region-wide adoptability
  //     invariant here. The zero-inventory-export contract is still enforced by the inventoryCreated hard-guard
  //     above (a v3 inventory CREATE fails closed); inventory remains strictly reuse-only.

  // 11) run report jobs -> the scheduler-v2/listing-health-v3 SHADOW snapshot only. LKG preserved on any failure.
  let reportRes;
  try { reportRes = await runReports({ plan, region: S(region), cycleDate: S(cycleDate) }); }
  catch (e) { return fail("report", "shadow snapshot derive/save failed (last-known-good preserved): " + safe(e)); }
  ev.snapshots = Number(reportRes && reportRes.succeeded || 0);
  ev.reportBlocked = Number(reportRes && reportRes.blocked || 0);
  ev.reportFailed = Number(reportRes && reportRes.failed || 0);
  ev.reportDrained = !!(reportRes && reportRes.drained);

  // 12) HONEST COMPLETION. Never return ok:true merely because runReports returned. Finalize the dedicated cycle and
  //     use the DURABLE terminal status as the replay-safe source of truth: a LIVE scheduled operation SUCCEEDS only
  //     when finalize_sync_cycle yields status "succeeded" (zero source AND report failures). open-work (undrained),
  //     partial, failed, not-found and invalid-status are all ok:false; LKG is preserved (no snapshot is rolled back).
  //     An already-terminal "succeeded" cycle (a watchdog replay) returns disposition 'already-terminal' + succeeded
  //     -> a zero-create idempotent success.
  let fin;
  try { fin = await finalizeCycle({ region: S(region), cycleDate: S(cycleDate) }); }
  catch (e) { return fail("finalize", "cycle finalization failed (last-known-good preserved): " + safe(e)); }
  ev.finalizeDisposition = fin && fin.disposition;
  ev.cycleStatus = fin && fin.status;
  const finalized = !!fin && (fin.disposition === "finalized" || fin.disposition === "already-terminal");
  if (finalized && fin.status === "succeeded") {
    return { ...ev, phase: "complete", ok: true, dryRun: false, cycleStatus: "succeeded" };
  }
  if (fin && fin.disposition === "open-work") {
    return { ...ev, phase: "incomplete", ok: false, note: "source/report work still open (cycle not drained) -- a retry will resume; last-known-good preserved" };
  }
  // 12b) WP16 REFUSED / FAILED SHADOW SAVE (opt-in -- readCycleJobs + proveAlreadyCurrent absent => byte-identical). The
  //      cycle finalized 'partial' with report failures. Read the now-TERMINAL (hence immutable) cycle's durable job rows:
  //      a report job whose derive SUCCEEDED but whose shadow save failed (save-stage SNAPSHOT_SAVE_FAILED -- the report
  //      worker records EVERY saver throw, incl. a refusal, that way) is re-evaluated with the three-part already-current
  //      proof, bound to the durable evidence THIS run persisted (materialize durableByAccount). The run is a SUCCESS
  //      only when EVERY such account is proven already-current AND there is no source failure and no other report
  //      failure; otherwise each unproven account is a REAL typed failure 'shadow-refused:<check>' (never counted by
  //      timestamp). The job rows are never rewritten (the cycle stays honestly 'partial').
  if (finalized && fin.status === "partial" && ev.reportFailed > 0 && typeof readCycleJobs === "function" && typeof proveAlreadyCurrent === "function") {
    let jobs = null;
    try { jobs = await readCycleJobs({ region: S(region), cycleDate: S(cycleDate) }); } catch (_e) { jobs = null; }
    const reportJobs = jobs && Array.isArray(jobs.reportJobs) ? jobs.reportJobs : null;
    const sourceJobs = jobs && Array.isArray(jobs.sourceJobs) ? jobs.sourceJobs : null;
    if (!reportJobs || !sourceJobs) {
      Object.assign(ev, { alreadyCurrent: 0, refusedReal: ev.reportFailed, refusals: [], refusalAudit: { read: "failed" } });
    } else {
      const f = (j, a, b) => (j ? (j[a] ?? j[b] ?? null) : null);
      const isSucceeded = (j) => f(j, "derive_status", "deriveStatus") === "succeeded" && f(j, "save_status", "saveStatus") === "succeeded";
      const isRefusedSave = (j) => f(j, "report_key", "reportKey") === LHV3_REPORT_KEY && f(j, "derive_status", "deriveStatus") === "succeeded"
        && f(j, "save_status", "saveStatus") === "failed" && f(j, "error_stage", "errorStage") === "save" && f(j, "error_code", "errorCode") === "SNAPSHOT_SAVE_FAILED";
      const refusedJobs = reportJobs.filter((j) => !isSucceeded(j) && isRefusedSave(j));
      const otherFailures = reportJobs.filter((j) => !isSucceeded(j) && !isRefusedSave(j)).length;
      const sourceFailed = sourceJobs.filter((j) => f(j, "fetch_status", "fetchStatus") === "failed").length;
      const byId = new Map(regionAccounts.map((a) => [S(a.accountId), a]));
      const results = await evaluateAlreadyCurrent({
        accounts: refusedJobs.map((j) => byId.get(S(f(j, "account_id", "accountId"))) || { accountId: S(f(j, "account_id", "accountId")), country: null }),
        prove: proveAlreadyCurrent, requestedAsOf: S(cycleDate),
        excludeCycleId: S(jobs.cycleId || (fin && fin.cycleId) || "") || null, prefix: "shadow-refused",
        runEvidenceOf: (accountId) => runEvidenceFromMaterialize(matSummary, accountId),
      });
      const counts = alreadyCurrentCounts(results);
      Object.assign(ev, counts, { refusalAudit: { read: "ok", reportJobs: reportJobs.length, refusedSaves: refusedJobs.length, otherReportFailures: otherFailures, sourceFailed } });
      emit("LHV3_ALREADY_CURRENT", {
        runId: ev.operationId, region: ev.region, cycleDate: ev.cycleDate, path: "shadow-refused", cycleStatus: S(fin.status),
        accounts: results.length, alreadyCurrent: counts.alreadyCurrent, refusedReal: counts.refusedReal, otherReportFailures: otherFailures, sourceFailed,
        refusals: counts.refusals.map((x) => ({ account: x.accountId, reason: x.reason, detail: x.detail })),
      });
      if (refusedJobs.length > 0 && counts.refusedReal === 0 && counts.alreadyCurrent === refusedJobs.length && otherFailures === 0 && sourceFailed === 0) {
        return {
          ...ev, phase: "complete", ok: true, dryRun: false, cycleStatus: "partial",
          note: `cycle finalized partial ONLY because ${refusedJobs.length} natural shadow save(s) failed; every one PROVEN already-current (content + lineage + live/served read-back) -- every account is published or already-current; job rows unchanged (honest partial).`,
        };
      }
    }
  }
  // partial | failed | not-found | invalid-status | finalized-but-not-succeeded -> honest non-success.
  return {
    ...ev, ok: false,
    phase: finalized ? S(fin.status) : (fin && fin.disposition ? S(fin.disposition) : "finalize-failed"),
    note: `cycle did not finalize as succeeded (disposition=${fin && fin.disposition}, status=${fin && fin.status}; reportBlocked=${ev.reportBlocked} reportFailed=${ev.reportFailed} reportDrained=${ev.reportDrained}); last-known-good preserved`,
  };
}
