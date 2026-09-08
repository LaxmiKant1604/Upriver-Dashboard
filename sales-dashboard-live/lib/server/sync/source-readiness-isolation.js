// Readiness-driven single-seller isolation for seller-batched DataDoe sources (pure + injectable I/O).
//
// DataDoe hard-rejects a MULTI-seller export with HTTP 400 "... requires Seller Central data on every selected
// seller, but the initial data load is not complete." when even ONE selected seller's Seller Central initial load
// is incomplete. That one unready seller POISONS every healthy seller batched with it -- the whole export is
// rejected, nothing is saved, and all members preserve LKG (no data this cycle). The onboarding readiness filter
// (accountDataDoeReady = readiness.sellerCentralReady === true) already excludes not-ready accounts at DISCOVERY,
// but it cannot catch readiness that flips AFTER a frozen cycle's membership was created, nor a frozen continuation
// that retains an account which later becomes unready -- in both cases the frozen batch still 400s.
//
// This module is the OLI/source-worker analogue of fba-inventory-overflow.js. From recent DURABLE typed evidence
// (source jobs that failed terminal with error_code === DATADOE_INITIAL_LOAD_INCOMPLETE), matched by the
// date-INDEPENDENT account_scope_hash on sync_source_job_owners (a readiness-rejected export's request_hash encodes
// the window, so it changes daily; the scope hash of a seller id does not), it derives -- per source, scoped by
// organization + connection + region cycle bucket + a recency window -- the raw seller ids the NEXT FRESH cycle
// must ISOLATE into single-seller jobs so healthy sellers stop being poisoned.
//
// RECENCY-AWARE, SELF-CLEARING (the fix for the batch-poisoning review). A seller is isolated iff its NEWEST
// readiness event across the recent cycles is a REJECTION rather than a single-seller SUCCESS. Because the cycle
// ids arrive newest-first (getRecentSyncCycleIds orders by cycle_date desc), the reader resolves each scope's
// newest event by first-seen-wins: a later single-seller SUCCESS therefore CLEARS an older rejection (readiness
// positively restored), and -- crucially -- a NEWER rejection is NEVER masked by a STALE success. Isolation is
// UNIFORM (no multi-vs-single reclassification): every member of a readiness-rejected export whose newest event is
// still a rejection is isolated into its own single-seller job. On the next cycle the healthy members' single-seller
// exports SUCCEED (their newest event flips to success -> they drop out of the isolate set and rejoin the batch),
// while the genuinely unready member's single-seller export 400s ALONE (it stays isolated) -- a typed "waiting" /
// "Setting up" no-op that saves nothing (LKG preserved) and self-clears the moment it finally succeeds. No exclude/
// hard-stop state is persisted, so a recovered seller can never get stuck out of the plan.
//
// The split is PLANNING-TIME by design: the frozen per-(cycle, tranche) create/token budget forbids inventing a
// NEW single-seller request_hash mid-cycle (it is refused as PLAN_BUDGET_MISMATCH), so the single-seller children
// are planned FROM THE START of the recovery (fresh) cycle and frozen with it -- no ceiling is ever raised, and a
// continuation of an already-frozen cycle is never reshaped. Fail-soft: any read error yields no isolation
// (byte-identical default batching). This applies ONLY to the exact DATADOE_INITIAL_LOAD_INCOMPLETE signature;
// every other terminal HTTP 400 stays terminal and NEVER triggers a split.

import { accountScopeHash } from "../source-identity.js";

const S = (v) => (v == null ? "" : String(v));
export const READINESS_INCOMPLETE_CODE = "DATADOE_INITIAL_LOAD_INCOMPLETE";
export const DEFAULT_READINESS_EVIDENCE_MAX_AGE_DAYS = 14; // recency window (expiry/reset): older evidence is ignored

// The NARROW, proven provider signature. BOTH phrases must be present so an ordinary malformed-request 400 is never
// misclassified as a readiness split. Matched case-insensitively against the sanitized provider detail/body.
export function isInitialLoadIncompleteMessage(text) {
  const t = S(text).toLowerCase();
  return t.includes("initial data load is not complete") && t.includes("seller central");
}

// The durable owner request_keys whose readiness evidence is WIRED into single-seller isolation, per source:
//   - source-oli:slice-v1        -> OLI, isolated in the source-sync runtime (planBucketSourceSync peel-off).
//   - fba-plan:inventory-health  -> FBA Inventory Health AND Listing Health v3 inventory (v3 REUSES this export
//                                   identity), isolated by folding into the existing inventory overflow channel in
//                                   fba-plan-release-composition + listing-health-v3-ingestion-composition.
// AWD (fba-plan:awd) also carries the all-selected-sellers requirement and its rejections ARE classified + recorded,
// but AWD batch-isolation is intentionally NOT wired here: the planner splits inventory batches only, and AWD is a
// stable no-date export that never runs single-seller (so it could neither be split nor self-clear on this channel).
// A dedicated AWD single-seller split is the follow-up; folding AWD here would only force needless inventory splits.
export const READINESS_PROTECTED_REQUEST_KEYS = Object.freeze([
  "source-oli:slice-v1",       // Order Line Items (order-line-items) -- runtime isolation
  "fba-plan:inventory-health", // FBA Inventory Health + Listing Health v3 inventory (shared identity) -- overflow fold
]);

/**
 * The batches (each { sellerOrVendorIds:[rawSellerId] }) of a source's DEFAULT (no-override) plan. Used to translate
 * an isolate scope hash (date-independent) back to the raw seller id the planner isolates on, and to ignore a seller
 * that has since departed the plan. Accepts a plain array of { sellerOrVendorIds } or { accounts:[{ rawSellerId }] }.
 */
export function defaultBatchesToSellerIds(batches) {
  const out = [];
  for (const b of Array.isArray(batches) ? batches : []) {
    if (Array.isArray(b && b.sellerOrVendorIds)) out.push(b.sellerOrVendorIds.map(S).filter(Boolean));
    else if (Array.isArray(b && b.accounts)) out.push(b.accounts.map((a) => S(a && (a.rawSellerId ?? a.sellerId))).filter(Boolean));
  }
  return out;
}

/**
 * PURE core: given a source's current default batches + the recency-resolved isolate scope hashes, return
 *   { isolateSellers:Set<rawSellerId> }.
 * A CURRENT seller `sid` is isolated iff accountScopeHash([sid]) is in isolateScopeHashes -- so a departed seller
 * (not in the current plan) is ignored, and the daily date rollover never affects the set (scope hashes are
 * date-independent).
 */
export function readinessIsolationFrom({ defaultBatches = [], isolateScopeHashes = [] } = {}) {
  const isolate = new Set((Array.isArray(isolateScopeHashes) ? isolateScopeHashes : []).map(S).filter(Boolean));
  const isolateSellers = new Set();
  if (isolate.size === 0) return { isolateSellers };
  for (const ids of defaultBatchesToSellerIds(defaultBatches)) {
    for (const sid of ids) { if (isolate.has(accountScopeHash([sid]))) isolateSellers.add(sid); }
  }
  return { isolateSellers };
}

const isSucceeded = (v) => { const s = S(v); return s === "succeeded" || s === "success"; };
const isFailed = (v) => S(v) === "failed";

/**
 * Read the recency-resolved isolate scope hashes for ONE source + region cycle bucket, within the recency window.
 * Injectable readers (offline-testable), identical shape to readRecentTruncatedInventoryOwnership:
 *   readRecentCycleIds(cycleBucket, sinceDate) -> [cycleId]   (MUST be ordered newest-first; getRecentSyncCycleIds is)
 *   readSourceJobs(cycleId) -> [{ request_hash, source_key, fetch_status, error_code, terminal }]
 *   readOwners(cycleId)     -> [{ request_hash, request_key, account_id, account_scope_hash, connection_id,
 *                                 organization_fingerprint, owner_status }]
 * COMPATIBILITY SCOPE (kept, never widened): only owner memberships for the given source `requestKey` + connection +
 * organization (when provided) + ACTIVE owner_status are trusted. Walks cycles NEWEST-first and records each scope's
 * NEWEST readiness event (first-seen wins): a single-seller SUCCESS marks the scope RESTORED (never isolated); a
 * terminal readiness REJECTION membership marks it ISOLATE -- unless an already-seen newer success cleared it. Within
 * one cycle, successes are applied before rejections so a same-cycle single-seller success wins. Returns
 *   { isolateScopeHashes:[...] }. Fail-soft: any read error yields []. Planning evidence only -- never reuses a stale
 * export and never raises a row cap.
 */
export async function readRecentReadinessRejectionOwnership({
  requestKey, cycleBucket, now = () => Date.now(), maxAgeDays = DEFAULT_READINESS_EVIDENCE_MAX_AGE_DAYS,
  connectionId = null, organizationFingerprint = null,
  readRecentCycleIds, readSourceJobs, readOwners,
} = {}) {
  const empty = { isolateScopeHashes: [] };
  if (!S(requestKey) || typeof readRecentCycleIds !== "function" || typeof readSourceJobs !== "function" || typeof readOwners !== "function") return empty;
  const sinceDate = new Date(now() - maxAgeDays * 86400000).toISOString().slice(0, 10);
  let cycleIds = [];
  try { cycleIds = (await readRecentCycleIds(cycleBucket, sinceDate)) || []; } catch (_e) { return empty; }
  const decided = new Set();          // scope hashes whose NEWEST readiness event is already resolved
  const isolateScopeHashes = new Set();
  for (const cid of cycleIds) {       // NEWEST cycle first -> first-seen per scope wins (recency)
    let jobs = [];
    try { jobs = (await readSourceJobs(cid)) || []; } catch (_e) { jobs = []; }
    const rejectedHashes = new Set();
    const succeededHashes = new Set();
    for (const j of jobs) {
      const hash = S(j.request_hash ?? j.requestHash);
      if (!hash) continue;
      if (isFailed(j.fetch_status ?? j.fetchStatus) && (j.terminal ?? false) === true && S(j.error_code ?? j.errorCode) === READINESS_INCOMPLETE_CODE) rejectedHashes.add(hash);
      else if (isSucceeded(j.fetch_status ?? j.fetchStatus)) succeededHashes.add(hash);
    }
    if (rejectedHashes.size === 0 && succeededHashes.size === 0) continue;
    let owners = [];
    try { owners = (await readOwners(cid)) || []; } catch (_e) { owners = []; }
    const membersByHash = new Map();
    for (const o of owners) {
      if (S(o.request_key ?? o.requestKey) !== S(requestKey)) continue;                                            // SOURCE compatibility
      if (S(o.owner_status ?? o.ownerStatus ?? "active") === "stale") continue;                                    // active memberships only
      if (connectionId != null && S(o.connection_id ?? o.connectionId) !== S(connectionId)) continue;             // CONNECTION
      if (organizationFingerprint != null && S(o.organization_fingerprint ?? o.organizationFingerprint) !== S(organizationFingerprint)) continue; // ORGANIZATION
      const sc = S(o.account_scope_hash ?? o.accountScopeHash);
      if (!sc) continue;
      const hash = S(o.request_hash ?? o.requestHash);
      if (!membersByHash.has(hash)) membersByHash.set(hash, []);
      membersByHash.get(hash).push(sc);
    }
    // SUCCESS first (a single-seller success in this cycle clears the scope); then REJECTION membership.
    for (const [hash, members] of membersByHash) {
      if (succeededHashes.has(hash) && members.length === 1) { const sc = members[0]; if (!decided.has(sc)) decided.add(sc); }
    }
    for (const [hash, members] of membersByHash) {
      if (!rejectedHashes.has(hash)) continue;
      for (const sc of members) { if (!decided.has(sc)) { decided.add(sc); isolateScopeHashes.add(sc); } }
    }
  }
  return { isolateScopeHashes: [...isolateScopeHashes] };
}
