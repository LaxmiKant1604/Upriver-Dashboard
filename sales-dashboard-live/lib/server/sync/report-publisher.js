// Scheduler v2 -- Gate-7 REVIEWED SHADOW-TO-LIVE PUBLISHER (fail-closed; DISABLED BY DEFAULT).
//
// Promotes ONE validated scheduler-v2/<reportKey> shadow snapshot into the EXACT live report_snapshots
// identity the frontend already reads -- and nothing else. Publishing happens ONLY when ALL FOUR independent
// gates hold (each fails closed):
//   1. CODE readiness  -- reportKey is in SCHEDULER_V2_READY_REPORT_KEYS (post-Gate-7b: EXACTLY the 13 approved
//                         CONTROLLED_REPORT_KEYS; an unknown/rogue key is still code-locked). Passing this gate
//                         does NOT publish -- gates 2-4 (durable report enable, durable account enable, and an
//                         explicit publish approval) remain, and are all closed at cutover;
//   2. DURABLE report enable -- report_sync_settings.schedule_enabled === true for the report;
//   3. DURABLE account enable -- the Gate-7 account rollout selects the exact account (allowlist/all-primary);
//   4. EXPLICIT publish approval -- scheduler_publish_approvals.approved === true for the exact
//                        (report_key, account_id).
// It publishes ONLY a VALIDATED report job (validated=true, derive+save succeeded) inside a TERMINAL source
// cycle (succeeded, or partial WITH that exact report succeeded), and loads the shadow snapshot by the EXACT
// natural identity that job proved it saved -- (scheduler-v2/<reportKey>, accountId, job.snapshot_params_hash)
// -- never an unrelated "latest" row (job A can never authorize snapshot B). It PROVES provenance by
// recomputing paramsHashFor(params.reportVersion, params) EXACTLY as the saver did and requiring the
// recomputed hash, the row's params_hash, and job.snapshot_params_hash to be ALL identical. The account gate
// resolves the durable rollout against REAL fresh primary discovery (memoized per composition), so an
// undiscovered/stale or dd-secondary account can never publish, even under all_primary=true. It validates
// payload shape (REPORT_DERIVATIONS.validatePayload) + report version + account + STRICT calendar-date params
// (impossible dates and reversed from/to rejected) BEFORE any write,
// hydrates a storage-backed payload through the trusted loader (missing/unreadable => fail closed), maps to
// the CANONICAL live report_key/version/params contract (inspected from the real api/datadoe.js routes --
// never guessed), and writes via a compare-and-swap primitive so a REPLAY can never duplicate a publish and
// a NEWER live snapshot always wins. Live LKG is preserved on EVERY failure (no write happens unless every
// validation passed). Returns TYPED SAFE dispositions only -- never a payload, a raw DB/HTTP error, or a
// secret. Publishing one (report, account) can never touch another (the CAS primitive is keyed to the one
// natural-key row). NO browser route imports this module (structurally tested).

import { REPORT_DERIVATIONS, shadowSnapshotKey } from "./report-derivation.js";
import { SCHEDULER_V2_READY_REPORT_KEYS, SOURCE_PROMOTED_REPORT_KEYS } from "./report-controls.js";
import { resolveRolloutAccounts } from "./account-rollout.js";
import { isValidCalendarDate } from "./report-source-contracts.js";
import { paramsHashFor } from "../report-store.js";

// Round-6 fix 3: the publisher's CODE-readiness set = the 13 approved DISPATCH keys plus the
// source-promoted keys (compact brand-inventory). Source-promoted keys are publishable through the SAME
// four gates (code readiness + durable enable + rollout + audited approval) and the SAME CAS/LKG live
// write, but stay OUTSIDE CONTROLLED_REPORT_KEYS so no dispatcher can ever select them (see
// report-controls.js SOURCE_PROMOTED_REPORT_KEYS).
export const SCHEDULER_V2_PUBLISHABLE_REPORT_KEYS = Object.freeze([
  ...SCHEDULER_V2_READY_REPORT_KEYS,
  ...SOURCE_PROMOTED_REPORT_KEYS,
]);

const norm = (s) => String(s ?? "").trim();
// STRICT calendar-date gate (shared validator): the value must be a REAL YYYY-MM-DD day -- an impossible
// date (2026-02-30, 2026-13-01, a non-leap Feb 29) is rejected, a leap day (2024-02-29) accepted. A
// from/to contract additionally requires from <= to (lexicographic == chronological for valid ISO dates).
const isDate = (v) => isValidCalendarDate(v);
const orderedRange = (from, to) => isDate(from) && isDate(to) && from <= to;

/**
 * The CANONICAL scheduler->live snapshot mapping for ALL 13 reports, transcribed from the EXECUTABLE live
 * routes (api/datadoe.js sharedSnapshotSpec + the six insight serveSharedReport call sites) -- report_key,
 * reportVersion, and the params builder each map the shadow snapshot's planned params onto the exact live
 * params contract. `liveParams` returns null when a required planned param is missing/malformed (fail closed).
 */
export const SCHEDULER_LIVE_SNAPSHOT_CONTRACTS = Object.freeze({
  "brand-sales": Object.freeze({
    liveReportKey: "brand-sales", liveReportVersion: "brand-sales-shared-v1",
    liveParams: (p) => (orderedRange(p.from, p.to) ? { from: p.from, to: p.to } : null),
  }),
  "daily-reporting": Object.freeze({
    liveReportKey: "daily-reporting", liveReportVersion: "daily-reporting-shared-v1",
    liveParams: (p) => (orderedRange(p.from, p.to) ? { from: p.from, to: p.to, brand: norm(p.brand) || "ALL" } : null),
  }),
  reconciliation: Object.freeze({
    liveReportKey: "reconciliation", liveReportVersion: "reconciliation-shared-v1",
    liveParams: (p) => (orderedRange(p.from, p.to) ? { from: p.from, to: p.to } : null),
  }),
  "sku-pl": Object.freeze({
    liveReportKey: "sku-pl", liveReportVersion: "sku-pl-shared-v1",
    liveParams: (p) => (orderedRange(p.from, p.to) ? { from: p.from, to: p.to } : null),
  }),
  "keyword-rank": Object.freeze({
    liveReportKey: "keyword-rank", liveReportVersion: "keyword-rank-shared-v1",
    liveParams: (p) => (isDate(p.to) ? { to: p.to } : null),
  }),
  "content-changes": Object.freeze({
    // The live route keys Content Changes params by `asOf` (the request's as-of date); the scheduler's planned
    // context carries it as `to`.
    liveReportKey: "content-changes", liveReportVersion: "content-changes-shared-v1",
    liveParams: (p) => (isDate(p.to) ? { asOf: p.to } : null),
  }),
  "fba-plan": Object.freeze({
    liveReportKey: "fba-plan", liveReportVersion: "fba-plan-shared-v1",
    liveParams: (p) => (isDate(p.to) ? { to: p.to } : null),
  }),
  "sales-movers": Object.freeze({
    liveReportKey: "sales-movers", liveReportVersion: "sales-movers-v1",
    liveParams: (p) => (isDate(p.to) ? { to: p.to } : null),
  }),
  "listing-health": Object.freeze({
    liveReportKey: "listing-health", liveReportVersion: "listing-health-v1",
    liveParams: (p) => (isDate(p.to) ? { to: p.to } : null),
  }),
  "buy-box-loss": Object.freeze({
    liveReportKey: "buy-box-loss", liveReportVersion: "buy-box-loss-v1",
    liveParams: (p) => (isDate(p.to) ? { to: p.to } : null),
  }),
  "returns-leakage": Object.freeze({
    liveReportKey: "returns-leakage", liveReportVersion: "returns-leakage-v2",
    liveParams: (p) => (isDate(p.to) ? { to: p.to } : null),
  }),
  "ppc-performance": Object.freeze({
    liveReportKey: "ppc-performance", liveReportVersion: "ppc-performance-v1",
    liveParams: (p) => (isDate(p.to) ? { to: p.to } : null),
  }),
  "listing-optimizer": Object.freeze({
    liveReportKey: "listing-optimizer", liveReportVersion: "listing-optimizer-v1",
    liveParams: (p) => (isDate(p.to) ? { to: p.to } : null),
  }),
  // Round-6 fix 3: the compact Brand View inventory, PRODUCED by the source-first durable runtime and
  // PROMOTED (never dispatched) -- transcribed from the EXECUTABLE live route (api/datadoe.js
  // sharedSnapshotSpec case "brand-inventory": reportKey brand-inventory, reportVersion
  // brand-inventory-shared-v1, params { to }). The live shared version EQUALS the shadow snapshotVersion:
  // the compact contract IS the live contract (lib/server/reports/brand-view.js
  // BRAND_INVENTORY_REPORT_VERSION), so isCompactInventorySnapshot accepts the promoted row unchanged.
  "brand-inventory": Object.freeze({
    liveReportKey: "brand-inventory", liveReportVersion: "brand-inventory-shared-v1",
    liveParams: (p) => (isDate(p.to) ? { to: p.to } : null),
  }),
});

// Typed safe dispositions (the ONLY values publishSchedulerV2Snapshot returns in `disposition`).
export const PUBLISH_DISPOSITIONS = Object.freeze([
  "published", "already-current", "newer-live", "publish-conflict",
  "unknown-report", "code-locked", "report-disabled", "account-disabled", "publish-not-approved",
  "not-successful", "invalid-snapshot", "publish-failed",
]);

// The CAS primitive's typed outcome -> the publisher's typed disposition. EQUAL source freshness with
// DIFFERENT content is a `publish-conflict` (never an unconditional overwrite): the primitive proved the
// live row is not identical, so the safe remediation is a fresh shadow cycle with newer source evidence.
const CAS_OUTCOME_DISPOSITION = Object.freeze({
  inserted: "published",
  replaced: "published",
  "newer-live": "newer-live",
  "already-current": "already-current",
  conflict: "publish-conflict",
});

/**
 * Publish ONE (reportKey, accountId) shadow snapshot to its live identity, fail-closed. `deps` supplies every
 * trusted collaborator (the trusted production composition wires them; tests inject doubles -- a caller of
 * the composed publish() can NEVER supply any of these):
 *   codeReadyKeys        -- default SCHEDULER_V2_READY_REPORT_KEYS (post-Gate-7b: the 13 approved keys; an
 *                        unknown key is code-locked); passing this gate still requires gates 2-4;
 *   getReportSyncSettings() -> rows with { report_key, schedule_enabled };
 *   loadAccountRollout() -> typed rollout state (getSchedulerAccountRollout);
 *   discoverPrimaryAccounts() -> FRESH (memoized per composition) classified ACTIVE PRIMARY directory rows
 *                        [{ accountId, ... }] -- the account gate resolves the durable rollout against THIS
 *                        real discovery, never a synthetic record, so an undiscovered/stale account or a
 *                        dd-secondary account can never publish, including under all_primary=true;
 *   getPublishApproval(reportKey, accountId) -> { read, approved };
 *   getLatestReportJob(reportKey, accountId) -> { cycle_id, validated, snapshot_params_hash, derive_status,
 *                        save_status, cycle_status } | null (the LATEST job row + its OWN cycle's status);
 *   getShadowSnapshot(shadowKey, accountId, paramsHash) -> the EXACT-identity row
 *                        { params_hash, params, payload, payload_storage_path, source_refreshed_at } | null;
 *   loadStoragePayload(objectPath) -> parsed payload | null (trusted storage hydration; throws on transport);
 *   publishLive({...}) -> { outcome: "inserted"|"replaced"|"newer-live"|"already-current"|"conflict" } (CAS
 *                        primitive; it decides fail-closed against the REAL live row -- an EQUAL source
 *                        timestamp is "already-current" ONLY when the content is PROVEN identical, else
 *                        "conflict"; it never returns a payload/path/digest).
 * Returns { disposition, reportKey, accountId, liveReportKey?, paramsHash? } -- typed safe fields ONLY.
 */
export async function publishSchedulerV2Snapshot(deps, { reportKey, accountId }) {
  const {
    codeReadyKeys = SCHEDULER_V2_PUBLISHABLE_REPORT_KEYS,
    getReportSyncSettings, getPromotedPublishSettings, loadAccountRollout, discoverPrimaryAccounts, getPublishApproval,
    getLatestReportJob, getShadowSnapshot, loadStoragePayload, publishLive,
  } = deps || {};
  const key = norm(reportKey);
  const acct = norm(accountId);
  const base = { reportKey: key, accountId: acct };
  try {
    const contract = SCHEDULER_LIVE_SNAPSHOT_CONTRACTS[key];
    if (!contract || !acct) return { disposition: "unknown-report", ...base };

    // GATE 1 -- code readiness (frozen empty today => disabled by default).
    if (!Array.isArray(codeReadyKeys) || !codeReadyKeys.includes(key)) return { disposition: "code-locked", ...base };

    // GATE 2 -- durable report enable. Round-6 blocker 2: a SOURCE-PROMOTED report (brand-inventory) is
    // gated by its OWN durable control (source_promoted_publish_settings.publish_enabled), NOT by
    // report_sync_settings -- which production only seeds/manages for the 13 DISPATCH reports and whose
    // admin surface rejects a promoted key. A dispatch report stays gated by schedule_enabled. Both default
    // OFF and fail closed (absent row / non-"ok" read => report-disabled), and the two controls are
    // independent (enabling a dispatch report can never enable a promoted one, and vice versa).
    if (SOURCE_PROMOTED_REPORT_KEYS.includes(key)) {
      const promoted = (typeof getPromotedPublishSettings === "function" ? await getPromotedPublishSettings() : null) || [];
      const prow = Array.isArray(promoted) ? promoted.find((s) => s && String(s.report_key ?? s.reportKey) === key) : null;
      if (!prow || prow.publish_enabled !== true) return { disposition: "report-disabled", ...base };
    } else {
      const settings = (await getReportSyncSettings()) || [];
      const row = settings.find((s) => s && String(s.report_key ?? s.reportKey) === key);
      if (!row || row.schedule_enabled !== true) return { disposition: "report-disabled", ...base };
    }

    // GATE 3 -- durable account enable, resolved against REAL fresh primary discovery (never a synthetic
    // record): the requested id must be a CURRENTLY DISCOVERED active primary account that the durable
    // rollout state selects. An unknown/stale id and every dd-secondary id fail here -- including when
    // all_primary=true (all-primary widens to every DISCOVERED primary account, nothing else).
    const rollout = await loadAccountRollout();
    const discovered = (await discoverPrimaryAccounts()) || [];
    const resolved = resolveRolloutAccounts(rollout, discovered);
    if (!resolved.selectedIds.includes(acct)) return { disposition: "account-disabled", ...base };

    // GATE 4 -- explicit durable publish approval for the exact (report, account).
    const approval = await getPublishApproval(key, acct);
    if (!approval || approval.read !== "ok" || approval.approved !== true) return { disposition: "publish-not-approved", ...base };

    // SOURCE-OF-TRUTH -- the LATEST report job must be a VALIDATED success (validated=true AND derive+save
    // succeeded) inside a TERMINAL cycle (succeeded, or partial WITH this exact report succeeded), and must
    // carry the EXACT snapshot identity it saved (nonblank snapshot_params_hash). Anything else -- running,
    // failed, blocked, missing, unvalidated, or hash-less -- is not publishable (live LKG preserved).
    const job = await getLatestReportJob(key, acct);
    const jobHash = job ? norm(job.snapshot_params_hash) : "";
    const jobOk = !!job && job.validated === true
      && job.derive_status === "succeeded" && job.save_status === "succeeded"
      && (job.cycle_status === "succeeded" || job.cycle_status === "partial")
      && jobHash !== "";
    if (!jobOk) return { disposition: "not-successful", ...base };

    // SNAPSHOT -- loaded by the EXACT natural identity the job proved it saved:
    // (scheduler-v2/<reportKey>, accountId, job.snapshot_params_hash). A "latest" row or any other snapshot
    // can never stand in: the returned row must echo the SAME params_hash (job A can never authorize
    // snapshot B), match the derivation version and the exact account, and carry a nonblank refresh time.
    const shadow = await getShadowSnapshot(shadowSnapshotKey(key), acct, jobHash);
    const entry = REPORT_DERIVATIONS[key];
    const params = shadow && typeof shadow.params === "object" && shadow.params != null ? shadow.params : null;
    // HASH PROVENANCE -- PROVE the loaded shadow.params is what produced job.snapshot_params_hash: recompute
    // the hash EXACTLY as makeShadowSnapshotSaver did (paramsHashFor(params.reportVersion, params)) and require
    // the recomputed value, the returned row.params_hash, AND job.snapshot_params_hash to be ALL identical.
    // A row whose stored params were mutated after saving (same params_hash, different params) fails here, as
    // does a row whose reportVersion no longer derives the claimed hash. Checked BEFORE any hydration/publish.
    const recomputedHash = params && typeof params.reportVersion === "string" ? paramsHashFor(params.reportVersion, params) : "";
    const rowHash = shadow ? norm(shadow.params_hash) : "";
    const hashOk = !!shadow && rowHash === jobHash && recomputedHash === jobHash;
    const versionOk = !!params && params.reportVersion === (entry && entry.snapshotVersion);
    const accountOk = !!params && norm(params.accountId) === acct;
    const refreshedOk = !!shadow && norm(shadow.source_refreshed_at) !== "";
    if (!shadow || !hashOk || !versionOk || !accountOk || !refreshedOk) return { disposition: "invalid-snapshot", ...base };

    // PAYLOAD -- inline, or HYDRATED from the trusted storage pointer. A snapshot with neither an inline
    // payload nor a readable storage payload is unpublishable (missing/unreadable storage fails CLOSED and
    // the live LKG stays untouched).
    let payload = shadow.payload;
    if (payload == null) {
      const storagePath = norm(shadow.payload_storage_path);
      if (!storagePath || typeof loadStoragePayload !== "function") return { disposition: "invalid-snapshot", ...base };
      try {
        payload = await loadStoragePayload(storagePath);
      } catch (_e) {
        payload = null;
      }
      if (payload == null) return { disposition: "invalid-snapshot", ...base };
    }
    const payloadOk = !!entry && typeof entry.validatePayload === "function" && entry.validatePayload(payload) === true;
    // A derived payload that DECLARES itself unavailable is structurally valid but must NEVER be promoted
    // over the live row (the live LKG for that report/account stays untouched).
    const availableOk = !(payload && payload.dataUnavailable === true);
    if (!payloadOk || !availableOk) return { disposition: "invalid-snapshot", ...base };

    // LIVE identity -- canonical mapping; a missing/malformed planned param fails closed.
    const liveParams = contract.liveParams(params);
    if (!liveParams) return { disposition: "invalid-snapshot", ...base };
    const paramsHash = paramsHashFor(contract.liveReportVersion, liveParams);

    // CAS publish -- the primitive decides fail-closed against the REAL live row: inserted/replaced =>
    // published; strictly-newer live => newer-live; EQUAL freshness proven identical => already-current;
    // EQUAL freshness with DIFFERENT content => publish-conflict (zero write, live LKG byte-identical). An
    // equal timestamp is NEVER assumed to be an idempotent replay.
    const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    const res = await publishLive({
      reportKey: contract.liveReportKey,
      accountId: acct,
      paramsHash,
      params: { reportVersion: contract.liveReportVersion, ...liveParams },
      payload,
      payloadBytes,
      sourceRefreshedAt: shadow.source_refreshed_at,
    });
    const out = { ...base, liveReportKey: contract.liveReportKey, paramsHash };
    const disposition = res && CAS_OUTCOME_DISPOSITION[res.outcome];
    if (disposition) return { disposition, ...out };
    return { disposition: "publish-failed", ...base };
  } catch (_e) {
    // NEVER a raw error in the result; live LKG untouched (the CAS write either fully happened or did not).
    return { disposition: "publish-failed", ...base };
  }
}
