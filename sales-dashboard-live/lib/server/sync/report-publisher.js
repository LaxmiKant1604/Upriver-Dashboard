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
import { listingHealthV3SemanticIdentity } from "../reports/listing-health-v3-live-identity.js";
// WP1 route hooks: the SAME pure helpers the binding + candidate resolver use, so a hook means one thing everywhere.
import {
  contractGatesNeedShadow, contractLiveAccountId, contractGateAccountIds, contractLiveParamsExtra, contractTargetIdentityOk,
} from "./publication-binding.js";
// The CANONICAL Brand View scope-id rules (brand-view.js:112-120) -- the route contracts' targetIdentity proves the
// target IS that scope, never a re-implemented copy.
import { brandViewScopeId, brandViewPortfolioScopeId } from "../reports/brand-view.js";

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
const nb = (v) => norm(v) !== "";

// WP1 route-contract helpers. `pickExtra` builds a liveParamsExtra hook that copies ONLY the named shadow params that are
// present (an absent key contributes nothing -- so a paid fba-plan shadow, which carries no route token, stores exactly
// the pre-hook params); the publisher then validates the picked values (allowlisted keys, nonblank strings <= 200).
const pickExtra = (...keys) => (p) => {
  const out = {};
  for (const k of keys) if (p && Object.prototype.hasOwnProperty.call(p, k) && p[k] !== undefined) out[k] = p[k];
  return out;
};
// A route liveParams builder must be IDEMPOTENT over its own stored live params, because the shared read-back
// (live-promoted-resolver.js) re-derives the identity hash from contract.liveParams(<stored live params>). So each
// identity field is read from the shadow's route field when present, else from the stored live field it maps to.
const brandViewOwner = (p) => (p && typeof p === "object" && "ownerAccountId" in p ? p.ownerAccountId : p && p.accountId);
// Portfolio members: the shadow's `members` array, else the stored `accountIds` string. Canonical ids only (nonblank,
// untrimmed-equal, no ',' -- the live identity joins them); SORTED + de-duplicated exactly like
// brandViewPortfolioScopeId and the serve (api/datadoe.js brand-view-portfolio). null when malformed/empty.
const portfolioMembers = (p) => {
  const raw = Array.isArray(p.members) ? p.members : (typeof p.accountIds === "string" && p.accountIds !== "" ? p.accountIds.split(",") : null);
  if (!raw || raw.length === 0) return null;
  if (!raw.every((id) => typeof id === "string" && id.trim() !== "" && id === id.trim() && !id.includes(","))) return null;
  return [...new Set(raw)].sort();
};
const semOk = { ok: true };
const semFail = (reason) => ({ ok: false, reason });

// ---- SKU Movement ROUTE target identity (WP1 follow-up F2) -----------------------------------------------------------
// The ONE canonical target id of a SKU Movement (owner account, brand) unit: "sku-movement:<owner>::<canonical brand>".
// The canonical brand is the serve's scope brand (api/datadoe.js serveSelfHealingSkuMovement + report-materialization-
// operation.js canonicalBrand): trimmed, blank -> "ALL", case PRESERVED (the stored scope is case-sensitive). The owner
// is taken VERBATIM and must be a canonical id (nonblank, untrimmed-equal) -- a padded/blank/non-string owner yields
// null (never trimmed into another account's target). Used by the sku-movement contract's targetIdentity below AND by
// the route that keys its jobs + shadows, so both sides derive the SAME id from one helper.
export const SKU_MOVEMENT_TARGET_PREFIX = "sku-movement:";
export function skuMovementCanonicalBrand(brand) {
  const s = String(brand ?? "").trim();
  return s === "" ? "ALL" : s;
}
export function skuMovementTargetId(ownerAccountId, brand) {
  if (typeof ownerAccountId !== "string" || ownerAccountId.trim() === "" || ownerAccountId !== ownerAccountId.trim()) return null;
  return SKU_MOVEMENT_TARGET_PREFIX + ownerAccountId + "::" + skuMovementCanonicalBrand(brand);
}
// SKU Movement payload self-identity (sku-movement-core skuMovementPayload, built by rederiveSkuMovement with the owner
// account): its OWN honest as-of, account and brand scope must equal the live identity it is promoted under -- the
// effectiveAsOf is the identity asOf, the accountId is the LIVE (owner) account, the brand is the identity brand, and
// brandFiltered agrees with that brand (a named brand is filtered; "ALL" in any case is not). A structurally-valid
// payload derived for another account / brand / day / scope is never promoted (and never read back as current).
const skuMovementSemanticIdentity = (payload, { accountId, liveParams } = {}) => {
  if (!payload || typeof payload !== "object" || !liveParams || typeof liveParams !== "object") return semFail("payload-not-object");
  if (!isDate(payload.effectiveAsOf) || payload.effectiveAsOf !== liveParams.asOf) return semFail("payload-effective-asof-mismatch");
  if (typeof payload.accountId !== "string" || payload.accountId === "" || payload.accountId !== accountId) return semFail("payload-account-mismatch");
  if (typeof payload.brand !== "string" || payload.brand !== liveParams.brand) return semFail("payload-brand-mismatch");
  if (payload.brandFiltered !== (String(liveParams.brand).toUpperCase() !== "ALL")) return semFail("payload-brand-scope-mismatch");
  return semOk;
};
// Brand View payload self-identity (assembleBrandViewPayload): the payload's OWN scope/brand/asOf (and, for the
// single-account view, its accountId) must equal the live identity it is promoted under.
const brandViewSemanticIdentity = (scope) => (payload, { liveParams } = {}) => {
  if (!payload || typeof payload !== "object" || !liveParams || typeof liveParams !== "object") return semFail("payload-not-object");
  if (payload.scope !== scope) return semFail("payload-scope-mismatch");
  if (payload.brand !== liveParams.brand) return semFail("payload-brand-mismatch");
  if (payload.asOf !== liveParams.asOf) return semFail("payload-asof-mismatch");
  if (scope === "account" && String(payload.accountId ?? "") !== liveParams.accountId) return semFail("payload-account-mismatch");
  return semOk;
};

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
    liveReportKey: "daily-reporting", liveReportVersion: "daily-reporting-shared-v2",
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
    // WP1 (fba-plan zero-export route): GATE 2 also opens on the PROMOTED row source_promoted_publish_settings
    // ['fba-plan'] -- so the route never has to open the paid DISPATCH control (report_sync_settings) -- and the
    // route's evidence/manifest tokens ride the stored live params (never the { to } identity hash). A paid scheduler
    // shadow carries neither token, so its pick is {} and the paid publish is byte-identical.
    promotedGateKey: "fba-plan",
    liveParamsExtra: pickExtra("evidenceToken", "manifestToken"),
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
    liveReportKey: "ppc-performance", liveReportVersion: "ppc-performance-v2-campaign",
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
  // WORK D: advanced Listing Health (v3), PRODUCED by the source-first durable runtime and PROMOTED (never
  // dispatched) through the listing-health-v3 saved-data reconciler -- like brand-inventory, DELIBERATELY OUTSIDE
  // CONTROLLED_REPORT_KEYS (structurally undispatchable) and inside SOURCE_PROMOTED_REPORT_KEYS. The live shared
  // version is DELIBERATELY DISTINCT from the shadow snapshotVersion ("listing-health/v3-oli-window"): the promoted
  // row is the default 30D-window view, keyed by { to } only (mirroring brand-inventory + fba-plan). The exact
  // requested-as-of gate (evaluatePublicationBinding) then enforces liveParams.to === requestedAsOf. Gated at the
  // serve boundary by the DOUBLE flag LHV3_PUBLISH_LIVE && LISTING_HEALTH_V3 (both default OFF), so a promoted row is
  // invisible until deliberately enabled; the promoted publish control (source_promoted_publish_settings) defaults
  // OFF (fail-closed), so nothing is promoted until that control is enabled either.
  "listing-health-v3": Object.freeze({
    liveReportKey: "listing-health-v3", liveReportVersion: "listing-health-v3-shared-v1",
    liveParams: (p) => (isDate(p.to) ? { to: p.to } : null),
    // WORK C/D blocker 1: prove the promoted payload's OWN accountId/asOf/window agree with the account + params.to
    // (the exact D-1) + the canonical 30D default window. Run by the shared live resolver (readback + serve) AND above,
    // before the CAS. Only this report defines the hook -> every other report's live proof is byte-for-byte unchanged.
    semanticIdentity: listingHealthV3SemanticIdentity,
  }),
  // ---- Publication recovery WP1: the five ZERO-EXPORT recovery ROUTE contracts (SOURCE_PROMOTED; never dispatched).
  // Each live identity is transcribed from the EXECUTABLE serve (api/datadoe.js) so the route's promoted row IS the
  // row the page reads. The shadow is saved at scheduler-v2/<publisher key> keyed by the route TARGET id (params
  // .accountId === targetId); the hooks map that target onto the live account + the gate accounts.
  // SKU Movement (api/datadoe.js sharedSnapshotSpec "sku-movement": params { asOf, brand } at the RAW account). The
  // target is one (account, brand) unit (skuMovementTargetId: "sku-movement:<acct>::<brand>"); the live row + both gates
  // are the owner.
  "sku-movement": Object.freeze({
    liveReportKey: "sku-movement", liveReportVersion: "sku-movement/v2",
    liveParams: (p) => (isDate(p.asOf) && nb(p.brand) ? { asOf: p.asOf, brand: norm(p.brand) } : null),
    asOfField: "asOf",
    // Ids are passed through VERBATIM: the shared helpers refuse a noncanonical id (never trimmed into another account).
    liveAccountId: (p) => p.ownerAccountId,
    gateAccountIds: (p) => [p.ownerAccountId],
    // F2: the job/shadow TARGET must BE the canonical target of the shadow's (owner, brand) -- a job keyed for target X
    // can never promote another account's or another brand's shadow (invalid-snapshot BEFORE any gate read / write).
    targetIdentity: (p, targetId) => nb(p.brand) && typeof targetId === "string" && skuMovementTargetId(p.ownerAccountId, p.brand) === targetId,
    liveParamsExtra: pickExtra("evidenceToken", "serveToken", "manifestToken"),
    // The payload's own as-of + account + brand scope must be the live identity (skuMovementSemanticIdentity above).
    semanticIdentity: skuMovementSemanticIdentity,
  }),
  // Returns & Refund Leakage v3 (api/datadoe.js serveSelfHealingReturns: report_key "returns-leakage", version
  // RETURNS_ADVANCED_VERSION, params { to }). A PUBLISHER key distinct from the v2 dispatch contract above (which is
  // untouched); both map onto live report_key "returns-leakage", each under its own version => its own paramsHash.
  "returns-leakage-v3": Object.freeze({
    liveReportKey: "returns-leakage", liveReportVersion: "returns-leakage-v3",
    liveParams: (p) => (isDate(p.to) ? { to: p.to } : null),
    liveParamsExtra: pickExtra("evidenceToken", "manifestToken"),
  }),
  // Brand View brand directory (api/datadoe.js brandViewDirectory: paramsHashFor(BRAND_VIEW_BRANDS_VERSION,
  // { accountId }) at the raw account). No as-of in the identity => asOfField null (only the requested-as-of gate is
  // skipped; every other binding check applies).
  "brand-view-brands": Object.freeze({
    liveReportKey: "brand-view-brands", liveReportVersion: "brand-view-brands-v1",
    liveParams: (p) => (nb(p.accountId) ? { accountId: norm(p.accountId) } : null),
    asOfField: null,
    liveParamsExtra: pickExtra("evidenceToken"),
    // The directory payload names its own account (buildBrandViewBrandDirectory) -- never another account's list.
    semanticIdentity: (payload, { liveParams } = {}) => (payload && typeof payload === "object" && liveParams
      && String(payload.accountId ?? "") === liveParams.accountId ? semOk : semFail("payload-account-mismatch")),
  }),
  // Account-scoped Brand View (api/datadoe.js brand-view: account_id brandViewScopeId(owner, brand), params
  // { accountId: owner, brand, asOf }). The target + live account is the SCOPE id; the gates run on the OWNER only.
  "brand-view": Object.freeze({
    liveReportKey: "brand-view", liveReportVersion: "brand-view-account-scoped-v2",
    liveParams: (p) => {
      const owner = brandViewOwner(p);
      return nb(owner) && nb(p.brand) && isDate(p.asOf) ? { accountId: norm(owner), brand: norm(p.brand), asOf: p.asOf } : null;
    },
    asOfField: "asOf",
    gateAccountIds: (p) => [p.ownerAccountId],
    targetIdentity: (p, targetId) => nb(p.ownerAccountId) && nb(p.brand) && targetId === brandViewScopeId(norm(p.ownerAccountId), norm(p.brand)),
    liveParamsExtra: pickExtra("depFingerprint", "evidenceToken"),
    semanticIdentity: brandViewSemanticIdentity("account"),
  }),
  // Cross-account Brand View (api/datadoe.js brand-view-portfolio: account_id brandViewPortfolioScopeId(members,
  // brand), params { accountIds: sorted members joined ",", brand, asOf, region? }). The target + live account is the
  // SCOPE id; GATES 3+4 are an AND over EVERY member (one member not rolled out / unapproved => no publish).
  "brand-view-portfolio": Object.freeze({
    liveReportKey: "brand-view-portfolio", liveReportVersion: "brand-view-portfolio-v1",
    liveParams: (p) => {
      const members = portfolioMembers(p);
      if (!members || !nb(p.brand) || !isDate(p.asOf)) return null;
      // `region` participates only when present, exactly like the serve's `...(region ? { region } : {})`.
      return { accountIds: members.join(","), brand: norm(p.brand), asOf: p.asOf, ...(nb(p.region) ? { region: norm(p.region) } : {}) };
    },
    asOfField: "asOf",
    gateAccountIds: (p) => portfolioMembers(p) || [],
    targetIdentity: (p, targetId) => {
      const members = Array.isArray(p.members) ? portfolioMembers(p) : null;
      return !!members && nb(p.brand) && targetId === brandViewPortfolioScopeId(members, norm(p.brand));
    },
    // manifestToken = the route's PER-UNIT manifest (only this brand unit's inputs): stored so a region-token advance
    // that leaves the unit's inputs unchanged is provably current from the live row itself (never re-published).
    liveParamsExtra: pickExtra("depFingerprint", "evidenceToken", "manifestToken"),
    semanticIdentity: brandViewSemanticIdentity("portfolio"),
  }),
});

// WP1: the five recovery ROUTE publisher keys added to the contract table above (pinned equal to the route contracts +
// SOURCE_PROMOTED by publisher-route-hooks.test.js). A consumer that enumerates the PRE-EXISTING live-contract universe
// for a read-only view (delivery-status.js LIVE_PUBLISHABLE_REPORT_KEYS) excludes them, so it stays byte-identical until
// it deliberately adopts the routes.
export const RECOVERY_ROUTE_PUBLISHER_KEYS = Object.freeze([
  "sku-movement", "returns-leakage-v3", "brand-view-brands", "brand-view", "brand-view-portfolio",
]);

// Typed safe dispositions (the ONLY values publishSchedulerV2Snapshot returns in `disposition`).
// 'data-unavailable' is DISTINCT from 'invalid-snapshot': the derived payload is structurally VALID but
// declares itself unavailable (e.g. an account with no FBA inventory) -- a legitimate source-capability
// outcome, never a malformed/failed snapshot. Both stay NOT-published (identical live-LKG behavior);
// only a caller that must distinguish source-incapability from failure (the bootstrap FBA honesty +
// typed-unavailable evidence) reads the two apart.
export const PUBLISH_DISPOSITIONS = Object.freeze([
  "published", "already-current", "newer-live", "publish-conflict",
  "unknown-report", "code-locked", "report-disabled", "account-disabled", "publish-not-approved",
  "not-successful", "invalid-snapshot", "data-unavailable", "publish-failed",
  // Round-9 P0-A: the WRITE-BOUNDARY fence proved the control lease was lost (expired/superseded/reclaimed) inside
  // the CAS transaction, so ZERO rows were written -- a typed, retryable contention outcome (LKG untouched).
  "lease-lost",
]);

// The CAS primitive's typed outcome -> the publisher's typed disposition. EQUAL source freshness with
// DIFFERENT content is a `publish-conflict` (never an unconditional overwrite): the primitive proved the
// live row is not identical, so the safe remediation is a fresh shadow cycle with newer source evidence.
// 'lease-lost' is the fenced-CAS outcome when the control fence no longer holds at the write boundary.
const CAS_OUTCOME_DISPOSITION = Object.freeze({
  inserted: "published",
  replaced: "published",
  "newer-live": "newer-live",
  "already-current": "already-current",
  conflict: "publish-conflict",
  "lease-lost": "lease-lost",
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
 * Returns { disposition, reportKey, accountId, liveReportKey?, paramsHash?, liveAccountId? } -- typed safe fields ONLY
 * (`liveAccountId` only for a contract with an identity hook -- every pre-existing result shape is unchanged).
 *
 * WP1 OPTIONAL CONTRACT HOOKS (all absent on the 15 pre-existing contracts except fba-plan's promotedGateKey +
 * liveParamsExtra, whose pick is empty for a paid shadow => byte-identical dispositions, stored params, paramsHash and
 * collaborator calls; pinned by gate7-rollout-publisher.test.js G7R). `accountId` is the route TARGET id the job +
 * shadow are keyed by:
 *   promotedGateKey  -- GATE 2 (dispatch branch) ALSO passes on source_promoted_publish_settings[key].publish_enabled,
 *                       read ONLY when the dispatch control is not enabled (a failed read fails closed as before);
 *   targetIdentity / liveAccountId / gateAccountIds -- the gate + live identity is resolved from the PROVEN shadow, so
 *                       GATES 3+4 run AFTER the exact job-linked shadow + hash provenance (and targetIdentity) passed,
 *                       over EVERY gate account (AND); the live row is written at liveAccountId;
 *   liveParamsExtra  -- validated extras merged into the STORED live params only, NEVER into paramsHash;
 *   semanticIdentity -- now also receives the full liveParams (LHv3 ignores it).
 */
export async function publishSchedulerV2Snapshot(deps, { reportKey, accountId, preflight = false }) {
  const {
    codeReadyKeys = SCHEDULER_V2_PUBLISHABLE_REPORT_KEYS,
    getReportSyncSettings, getPromotedPublishSettings, loadAccountRollout, discoverPrimaryAccounts, getPublishApproval,
    getLatestReportJob, getShadowSnapshot, loadStoragePayload, publishLive,
  } = deps || {};
  const key = norm(reportKey);
  const acct = norm(accountId);
  const base = { reportKey: key, accountId: acct };
  // GATES 3+4 over a set of gate accounts (ONE rollout + discovery read; approvals in order). With [acct] this is
  // EXACTLY the pre-hook call sequence: loadAccountRollout, discoverPrimaryAccounts, getPublishApproval(key, acct).
  const accountGates = async (ids) => {
    const rollout = await loadAccountRollout();
    const discovered = (await discoverPrimaryAccounts()) || [];
    const resolved = resolveRolloutAccounts(rollout, discovered);
    if (!ids.every((id) => resolved.selectedIds.includes(id))) return "account-disabled";
    for (const id of ids) {
      const approval = await getPublishApproval(key, id);
      if (!approval || approval.read !== "ok" || approval.approved !== true) return "publish-not-approved";
    }
    return null;
  };
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
      if (!row || row.schedule_enabled !== true) {
        // WP1 promotedGateKey (fba-plan only): the zero-export route opens its OWN promoted row, never the paid
        // dispatch control. Consulted ONLY when the dispatch control is closed; any read failure / absent row / non-true
        // value keeps the pre-hook 'report-disabled'. A contract without the hook never reads the promoted table here.
        const gateKey = typeof contract.promotedGateKey === "string" ? norm(contract.promotedGateKey) : "";
        let promotedOpen = false;
        if (gateKey) {
          try {
            const promoted = (typeof getPromotedPublishSettings === "function" ? await getPromotedPublishSettings() : null) || [];
            const prow = Array.isArray(promoted) ? promoted.find((s) => s && String(s.report_key ?? s.reportKey) === gateKey) : null;
            promotedOpen = !!prow && prow.publish_enabled === true;
          } catch (_e) {
            promotedOpen = false;
          }
        }
        if (!promotedOpen) return { disposition: "report-disabled", ...base };
      }
    }

    // A contract whose gate / live identity is NOT the target id (WP1 identity hooks) defers GATES 3+4 until the exact
    // job-linked shadow is proven below; every other contract gates the target id HERE, byte-identically.
    const gatesNeedShadow = contractGatesNeedShadow(contract);
    if (!gatesNeedShadow) {
      // GATE 3 -- durable account enable, resolved against REAL fresh primary discovery (never a synthetic
      // record): the requested id must be a CURRENTLY DISCOVERED active primary account that the durable
      // rollout state selects. An unknown/stale id and every dd-secondary id fail here -- including when
      // all_primary=true (all-primary widens to every DISCOVERED primary account, nothing else).
      // GATE 4 -- explicit durable publish approval for the exact (report, account).
      const denied = await accountGates([acct]);
      if (denied) return { disposition: denied, ...base };
    }

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

    // WP1 IDENTITY HOOKS -- resolved ONLY from the proven shadow params (never a caller input). targetIdentity first: the
    // target must BE the scope the shadow names (brand-view / portfolio scope id), else invalid-snapshot with zero gate
    // reads. Then the live account, then GATES 3+4 over EVERY gate account (the owner for brand-view / sku-movement,
    // every member for the portfolio -- an AND gate; a scope id is never a gate account).
    let liveAcct = acct;
    if (gatesNeedShadow) {
      if (!contractTargetIdentityOk(contract, params, acct)) return { disposition: "invalid-snapshot", ...base };
      liveAcct = contractLiveAccountId(contract, params, acct);
      if (liveAcct === null) return { disposition: "invalid-snapshot", ...base };
      const gate = contractGateAccountIds(contract, params, acct);
      // A prefixed (dd-secondary / scope) id can never be a rollout account -> the account gate refuses it; any other
      // malformed gate set is a malformed shadow.
      if (!gate.ok) return { disposition: gate.reason === "gate-account-prefixed" ? "account-disabled" : "invalid-snapshot", ...base };
      const denied = await accountGates(gate.ids);
      if (denied) return { disposition: denied, ...base };
    }

    // PAYLOAD -- STORAGE-FIRST precedence (round-9 finding 3): a nonblank payload_storage_path is
    // AUTHORITATIVE and is always hydrated through the trusted loader, EVEN IF an inline payload is also
    // present (a stale inline can never win over the authoritative storage object). The inline payload is
    // used ONLY when the storage path is blank. A snapshot with neither a readable storage payload nor (when
    // the path is blank) an inline payload is unpublishable -- fail CLOSED, the live LKG stays untouched.
    const storagePath = norm(shadow.payload_storage_path);
    let payload;
    if (storagePath) {
      if (typeof loadStoragePayload !== "function") return { disposition: "invalid-snapshot", ...base };
      try {
        payload = await loadStoragePayload(storagePath);
      } catch (_e) {
        payload = null;
      }
      if (payload == null) return { disposition: "invalid-snapshot", ...base };
    } else {
      payload = shadow.payload;
      if (payload == null) return { disposition: "invalid-snapshot", ...base };
    }
    const payloadOk = !!entry && typeof entry.validatePayload === "function" && entry.validatePayload(payload) === true;
    if (!payloadOk) return { disposition: "invalid-snapshot", ...base };
    // A derived payload that is structurally VALID but DECLARES itself unavailable is never promoted over
    // the live row (LKG untouched) -- but it is a legitimate source-capability outcome, reported as the
    // DISTINCT 'data-unavailable' disposition (not a failure) so the FBA honesty path can tell them apart.
    if (payload && payload.dataUnavailable === true) return { disposition: "data-unavailable", ...base };

    // LIVE identity -- canonical mapping; a missing/malformed planned param fails closed.
    const liveParams = contract.liveParams(params);
    if (!liveParams) return { disposition: "invalid-snapshot", ...base };
    // WP1 liveParamsExtra: allowlisted, bounded string extras STORED with the live params (tokens the recovery worker
    // proves freshness with). Any unknown key / non-string / blank / over-long value / identity collision => invalid.
    let extra = null;
    if (typeof contract.liveParamsExtra === "function") {
      const x = contractLiveParamsExtra(contract, params, liveParams);
      if (!x.ok) return { disposition: "invalid-snapshot", ...base };
      extra = x.extra;
    }
    // OPTIONAL per-report SEMANTIC identity (WORK C/D blocker 1): prove the payload's OWN account/date/window agree
    // with the promoted account + live params.to, BEFORE the live CAS -- so a structurally-valid but wrong-account /
    // wrong-day / wrong-window payload is never promoted. A contract with no hook is byte-for-byte unchanged. WP1: the
    // hook also receives the full liveParams, and `accountId` is the LIVE account (=== acct for every hookless contract).
    if (typeof contract.semanticIdentity === "function") {
      const sem = contract.semanticIdentity(payload, { accountId: liveAcct, to: liveParams.to, liveParams });
      if (!sem || sem.ok !== true) return { disposition: "invalid-snapshot", ...base };
    }
    // The live IDENTITY hash is ALWAYS computed from contract.liveParams alone -- extras are never hashed, so the serve's
    // identity (and the read-back's re-derived hash, live-promoted-resolver.js) is unchanged by a stored token.
    const paramsHash = paramsHashFor(contract.liveReportVersion, liveParams);
    // `liveAccountId` is surfaced ONLY for an identity-hooked contract (every pre-existing result shape is unchanged).
    const liveOut = gatesNeedShadow ? { liveAccountId: liveAcct } : {};

    // READ-ONLY PREFLIGHT: every gate (code readiness, dispatch/promoted control, primary rollout resolved
    // against fresh discovery, audited approval), the source-of-truth validated job inside a terminal cycle, the
    // exact shadow identity + hash provenance, storage-first payload hydration + the payload contract, and the
    // live-params mapping have ALL passed -- so this (report, account) IS publishable. Return 'ready' WITHOUT the
    // CAS write, carrying the exact live identity (liveReportKey + paramsHash) the eventual publish + read-back
    // will use. Same collaborators + logic as the real publish; the CLI never duplicates any gate.
    if (preflight === true) return { disposition: "ready", ...base, liveReportKey: contract.liveReportKey, paramsHash, ...liveOut };

    // CAS publish -- the primitive decides fail-closed against the REAL live row: inserted/replaced =>
    // published; strictly-newer live => newer-live; EQUAL freshness proven identical => already-current;
    // EQUAL freshness with DIFFERENT content => publish-conflict (zero write, live LKG byte-identical). An
    // equal timestamp is NEVER assumed to be an idempotent replay.
    const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    const res = await publishLive({
      reportKey: contract.liveReportKey,
      accountId: liveAcct,
      paramsHash,
      // Stored params = { reportVersion, ...liveParams } exactly as before; a WP1 route's validated extras follow them.
      params: extra ? { reportVersion: contract.liveReportVersion, ...liveParams, ...extra } : { reportVersion: contract.liveReportVersion, ...liveParams },
      payload,
      payloadBytes,
      sourceRefreshedAt: shadow.source_refreshed_at,
    });
    const out = { ...base, liveReportKey: contract.liveReportKey, paramsHash, ...liveOut };
    const disposition = res && CAS_OUTCOME_DISPOSITION[res.outcome];
    if (disposition) return { disposition, ...out };
    return { disposition: "publish-failed", ...base };
  } catch (e) {
    // NEVER a raw error in the result; live LKG untouched (the CAS write either fully happened or did not). ONE typed bit
    // is surfaced (WP14 final review P2-1): a refusal by the DB WRITER FENCE (SQLSTATE RWF01 / 'REPORT_WRITER_FENCED:<key>'
    // -- from a FENCED writer a defect or a fence / deploy mismatch) sets writerFenced:true so a caller can type it; the
    // disposition and every other field are exactly as before (absent for any other error: byte-identical).
    const fenced = !!e && (String(e.code || "") === "RWF01" || /REPORT_WRITER_FENCED/.test(String(e.message || "")));
    return fenced ? { disposition: "publish-failed", writerFenced: true, ...base } : { disposition: "publish-failed", ...base };
  }
}
