// Scheduler v2 -- Gate-7 REVIEWED SHADOW-TO-LIVE PUBLISHER (fail-closed; DISABLED BY DEFAULT).
//
// Promotes ONE validated scheduler-v2/<reportKey> shadow snapshot into the EXACT live report_snapshots
// identity the frontend already reads -- and nothing else. Publishing happens ONLY when ALL FOUR independent
// gates hold (each fails closed):
//   1. CODE readiness  -- reportKey is in SCHEDULER_V2_READY_REPORT_KEYS (frozen EMPTY today, so the publisher
//                         is disabled by default at the code level);
//   2. DURABLE report enable -- report_sync_settings.schedule_enabled === true for the report;
//   3. DURABLE account enable -- the Gate-7 account rollout selects the exact account (allowlist/all-primary);
//   4. EXPLICIT publish approval -- scheduler_publish_approvals.approved === true for the exact
//                        (report_key, account_id).
// It publishes ONLY a report job whose derive_status AND save_status succeeded inside a TERMINAL source cycle
// (succeeded, or partial WITH that exact report succeeded), reads the LATEST scheduler-v2/<reportKey> snapshot
// for the account, validates payload shape (REPORT_DERIVATIONS.validatePayload) + report version + account +
// params BEFORE any write, maps to the CANONICAL live report_key/version/params contract (inspected from the
// real api/datadoe.js routes -- never guessed), and writes via a compare-and-swap primitive so a REPLAY can
// never duplicate a publish and a NEWER live snapshot always wins. Live LKG is preserved on EVERY failure
// (no write happens unless every validation passed). Returns TYPED SAFE dispositions only -- never a payload,
// a raw DB/HTTP error, or a secret. Publishing one (report, account) can never touch another (the CAS
// primitive is keyed to the one natural-key row). NO browser route imports this module (structurally tested).

import { REPORT_DERIVATIONS, shadowSnapshotKey } from "./report-derivation.js";
import { SCHEDULER_V2_READY_REPORT_KEYS } from "./report-controls.js";
import { resolveRolloutAccounts } from "./account-rollout.js";
import { paramsHashFor } from "../report-store.js";

const norm = (s) => String(s ?? "").trim();
const isYmd = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * The CANONICAL scheduler->live snapshot mapping for ALL 13 reports, transcribed from the EXECUTABLE live
 * routes (api/datadoe.js sharedSnapshotSpec + the six insight serveSharedReport call sites) -- report_key,
 * reportVersion, and the params builder each map the shadow snapshot's planned params onto the exact live
 * params contract. `liveParams` returns null when a required planned param is missing/malformed (fail closed).
 */
export const SCHEDULER_LIVE_SNAPSHOT_CONTRACTS = Object.freeze({
  "brand-sales": Object.freeze({
    liveReportKey: "brand-sales", liveReportVersion: "brand-sales-shared-v1",
    liveParams: (p) => (isYmd(p.from) && isYmd(p.to) ? { from: p.from, to: p.to } : null),
  }),
  "daily-reporting": Object.freeze({
    liveReportKey: "daily-reporting", liveReportVersion: "daily-reporting-shared-v1",
    liveParams: (p) => (isYmd(p.from) && isYmd(p.to) ? { from: p.from, to: p.to, brand: norm(p.brand) || "ALL" } : null),
  }),
  reconciliation: Object.freeze({
    liveReportKey: "reconciliation", liveReportVersion: "reconciliation-shared-v1",
    liveParams: (p) => (isYmd(p.from) && isYmd(p.to) ? { from: p.from, to: p.to } : null),
  }),
  "sku-pl": Object.freeze({
    liveReportKey: "sku-pl", liveReportVersion: "sku-pl-shared-v1",
    liveParams: (p) => (isYmd(p.from) && isYmd(p.to) ? { from: p.from, to: p.to } : null),
  }),
  "keyword-rank": Object.freeze({
    liveReportKey: "keyword-rank", liveReportVersion: "keyword-rank-shared-v1",
    liveParams: (p) => (isYmd(p.to) ? { to: p.to } : null),
  }),
  "content-changes": Object.freeze({
    // The live route keys Content Changes params by `asOf` (the request's as-of date); the scheduler's planned
    // context carries it as `to`.
    liveReportKey: "content-changes", liveReportVersion: "content-changes-shared-v1",
    liveParams: (p) => (isYmd(p.to) ? { asOf: p.to } : null),
  }),
  "fba-plan": Object.freeze({
    liveReportKey: "fba-plan", liveReportVersion: "fba-plan-shared-v1",
    liveParams: (p) => (isYmd(p.to) ? { to: p.to } : null),
  }),
  "sales-movers": Object.freeze({
    liveReportKey: "sales-movers", liveReportVersion: "sales-movers-v1",
    liveParams: (p) => (isYmd(p.to) ? { to: p.to } : null),
  }),
  "listing-health": Object.freeze({
    liveReportKey: "listing-health", liveReportVersion: "listing-health-v1",
    liveParams: (p) => (isYmd(p.to) ? { to: p.to } : null),
  }),
  "buy-box-loss": Object.freeze({
    liveReportKey: "buy-box-loss", liveReportVersion: "buy-box-loss-v1",
    liveParams: (p) => (isYmd(p.to) ? { to: p.to } : null),
  }),
  "returns-leakage": Object.freeze({
    liveReportKey: "returns-leakage", liveReportVersion: "returns-leakage-v1",
    liveParams: (p) => (isYmd(p.to) ? { to: p.to } : null),
  }),
  "ppc-performance": Object.freeze({
    liveReportKey: "ppc-performance", liveReportVersion: "ppc-performance-v1",
    liveParams: (p) => (isYmd(p.to) ? { to: p.to } : null),
  }),
  "listing-optimizer": Object.freeze({
    liveReportKey: "listing-optimizer", liveReportVersion: "listing-optimizer-v1",
    liveParams: (p) => (isYmd(p.to) ? { to: p.to } : null),
  }),
});

// Typed safe dispositions (the ONLY values publishSchedulerV2Snapshot returns in `disposition`).
export const PUBLISH_DISPOSITIONS = Object.freeze([
  "published", "already-current", "newer-live",
  "unknown-report", "code-locked", "report-disabled", "account-disabled", "publish-not-approved",
  "not-successful", "invalid-snapshot", "publish-failed",
]);

/**
 * Publish ONE (reportKey, accountId) shadow snapshot to its live identity, fail-closed. `deps` supplies every
 * trusted collaborator (production wiring below; tests inject doubles):
 *   codeReadyKeys        -- default SCHEDULER_V2_READY_REPORT_KEYS (frozen EMPTY => publisher disabled);
 *   getReportSyncSettings() -> rows with { report_key, schedule_enabled };
 *   loadAccountRollout() -> typed rollout state (getSchedulerAccountRollout);
 *   getPublishApproval(reportKey, accountId) -> { read, approved };
 *   getLatestReportJob(reportKey, accountId) -> { derive_status, save_status, cycle_status } | null
 *                        (the report job in its LATEST cycle + that cycle's status);
 *   getShadowSnapshot(shadowKey, accountId) -> LATEST { payload, params, source_refreshed_at } | null;
 *   publishLive({...}) -> { outcome: "inserted"|"replaced"|"skipped", liveRefreshedAt } (CAS primitive).
 * Returns { disposition, reportKey, accountId, liveReportKey?, paramsHash? } -- typed safe fields ONLY.
 */
export async function publishSchedulerV2Snapshot(deps, { reportKey, accountId }) {
  const {
    codeReadyKeys = SCHEDULER_V2_READY_REPORT_KEYS,
    getReportSyncSettings, loadAccountRollout, getPublishApproval,
    getLatestReportJob, getShadowSnapshot, publishLive,
  } = deps || {};
  const key = norm(reportKey);
  const acct = norm(accountId);
  const base = { reportKey: key, accountId: acct };
  try {
    const contract = SCHEDULER_LIVE_SNAPSHOT_CONTRACTS[key];
    if (!contract || !acct) return { disposition: "unknown-report", ...base };

    // GATE 1 -- code readiness (frozen empty today => disabled by default).
    if (!Array.isArray(codeReadyKeys) || !codeReadyKeys.includes(key)) return { disposition: "code-locked", ...base };

    // GATE 2 -- durable report enable (report_sync_settings.schedule_enabled).
    const settings = (await getReportSyncSettings()) || [];
    const row = settings.find((s) => s && String(s.report_key ?? s.reportKey) === key);
    if (!row || row.schedule_enabled !== true) return { disposition: "report-disabled", ...base };

    // GATE 3 -- durable account enable (the Gate-7 rollout must select this EXACT account).
    const rollout = await loadAccountRollout();
    const resolved = resolveRolloutAccounts(rollout, [{ accountId: acct }]);
    if (resolved.accounts.length !== 1) return { disposition: "account-disabled", ...base };

    // GATE 4 -- explicit durable publish approval for the exact (report, account).
    const approval = await getPublishApproval(key, acct);
    if (!approval || approval.read !== "ok" || approval.approved !== true) return { disposition: "publish-not-approved", ...base };

    // SOURCE-OF-TRUTH -- the report job must have derive+save succeeded inside a TERMINAL cycle (succeeded,
    // or partial WITH this exact report succeeded). Anything else -- running, failed, blocked, missing -- is
    // not publishable (live LKG preserved).
    const job = await getLatestReportJob(key, acct);
    const jobOk = !!job && job.derive_status === "succeeded" && job.save_status === "succeeded"
      && (job.cycle_status === "succeeded" || job.cycle_status === "partial");
    if (!jobOk) return { disposition: "not-successful", ...base };

    // SNAPSHOT -- the exact scheduler-v2/<reportKey> identity, strictly validated BEFORE any write.
    const shadow = await getShadowSnapshot(shadowSnapshotKey(key), acct);
    const entry = REPORT_DERIVATIONS[key];
    const params = shadow && typeof shadow.params === "object" && shadow.params != null ? shadow.params : null;
    const payload = shadow ? shadow.payload : null;
    const versionOk = !!params && params.reportVersion === (entry && entry.snapshotVersion);
    const accountOk = !!params && norm(params.accountId) === acct;
    const payloadOk = !!entry && typeof entry.validatePayload === "function" && payload != null && entry.validatePayload(payload) === true;
    // A derived payload that DECLARES itself unavailable is structurally valid but must NEVER be promoted
    // over the live row (the live LKG for that report/account stays untouched).
    const availableOk = !(payload && payload.dataUnavailable === true);
    const refreshedOk = !!shadow && norm(shadow.source_refreshed_at) !== "";
    if (!shadow || !versionOk || !accountOk || !payloadOk || !availableOk || !refreshedOk) return { disposition: "invalid-snapshot", ...base };

    // LIVE identity -- canonical mapping; a missing/malformed planned param fails closed.
    const liveParams = contract.liveParams(params);
    if (!liveParams) return { disposition: "invalid-snapshot", ...base };
    const paramsHash = paramsHashFor(contract.liveReportVersion, liveParams);

    // CAS publish -- inserted/replaced => published; an equal-or-newer live row is never overwritten.
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
    if (res && (res.outcome === "inserted" || res.outcome === "replaced")) return { disposition: "published", ...out };
    if (res && res.outcome === "skipped") {
      return { disposition: norm(res.liveRefreshedAt) === norm(shadow.source_refreshed_at) ? "already-current" : "newer-live", ...out };
    }
    return { disposition: "publish-failed", ...base };
  } catch (_e) {
    // NEVER a raw error in the result; live LKG untouched (the CAS write either fully happened or did not).
    return { disposition: "publish-failed", ...base };
  }
}
