// Adaptive FBA Inventory self-heal -- PROVEN-OVERFLOW seller evidence (pure + injectable I/O).
//
// A strict, seller-scoped FBA Inventory Health batch that returns exactly its 50000-row cap is rejected TRUNCATED
// (terminal) and never saved -- a legitimate DATA-VOLUME overflow. Left alone, the SAME sellers re-batch together every
// cycle and truncate identically forever. This module derives, from recent terminal TRUNCATED evidence, the set of
// sellers that must be proactively routed into SINGLE-SELLER inventory jobs so a future cycle self-heals -- scoped by
// organization + connection + source + region (via the region-fba cycle bucket) + marketplace, never hard-coded, with a
// reviewed recency window (expiry). It applies ONLY to fba-inventory-health; a batch of ONE seller that still truncates
// is a HARD STOP (it cannot split further -- the caller must escalate, never auto-raise the limit).
//
// OWNERSHIP-BASED MATCHING (2026-09-08 fix): a TRUNCATED inventory export's request_hash ENCODES the inventory DATE
// (from/to). So a prior cycle's date-D hash NEVER equals the current plan's date-D+1 hash -- comparing hashes made
// overflowSellers empty every day after the truncation (the reproduced defect). Instead we resolve WHICH SELLERS owned
// each TRUNCATED export from DURABLE evidence: the sync_source_job_owners rows carry each batch member's
// account_scope_hash = accountScopeHash([rawSellerId]) (a pure hash of the seller id, DATE-INDEPENDENT). We match those
// against the current plan's sellers (which recompute the same scope hash), so the overflow set survives the daily date
// rollover, follows membership changes (only current sellers isolate), and stays scoped/compatible (org/connection/
// source/region/marketplace). Export/cache identity keeps the date; nothing stale is reused; row caps are never raised.

import { accountScopeHash } from "../source-identity.js";

const S = (v) => (v == null ? "" : String(v));
const TRUNCATED = "TRUNCATED";
const INVENTORY_SOURCE_KEY = "fba-inventory-health";
const INVENTORY_REQUEST_KEY = "fba-plan:inventory-health"; // the owner memberships to trust (source compatibility)
export const DEFAULT_OVERFLOW_EVIDENCE_MAX_AGE_DAYS = 14; // recency window (expiry/reset): older evidence is ignored

/**
 * The inventory batches (requestHash -> its exact seller ids) of a DEFAULT (no-override) FBA plan, from the current
 * plan's report requests. Used to translate a proven-overflow account (by its date-independent scope hash) back to the
 * raw seller id the planner isolates on.
 */
export function defaultInventoryBatchesOf(fbaReportRequests) {
  const byHash = new Map();
  for (const r of fbaReportRequests || []) {
    for (const s of r.sources || []) {
      if (s.requestKey !== INVENTORY_REQUEST_KEY) continue;
      if (!byHash.has(s.requestHash)) byHash.set(s.requestHash, { requestHash: s.requestHash, sellerOrVendorIds: (s.sellerOrVendorIds || []).map(String) });
    }
  }
  return [...byHash.values()];
}

/**
 * PURE core: given the current default inventory batches + the DURABLE ownership of recent terminal-TRUNCATED inventory
 * exports, return { overflowSellers:Set<rawSellerId>, singleSellerHardStops:string[] }.
 *
 *   defaultInventoryBatches : [{ requestHash, sellerOrVendorIds:[rawSellerId] }]  (the CURRENT plan's batches)
 *   truncatedOwnership      : [{ scopeHashes:[accountScopeHash], accountIds?:[...] }]  (one entry per recent terminal-
 *                             TRUNCATED inventory export; scopeHashes are its batch members' individual scope hashes)
 *
 * A MULTI-member truncated export (scopeHashes.length >= 2) marks each of its members as OVERFLOW -- isolate them.
 * A SINGLE-member truncated export (scopeHashes.length === 1) is a HARD STOP -- it cannot split further; report it,
 * never re-route, never auto-raise the cap. Hard-stop precedence: a seller that has truncated ALONE stays a hard stop
 * even if it also appears in an older multi-member truncation. Matching is by scope hash (date-independent): a current
 * seller `sid` is affected iff accountScopeHash([sid]) is in the truncated ownership -- so a departed seller (not in the
 * current plan) is ignored, and the daily date rollover never empties the set.
 */
export function overflowSellersFromTruncated({ defaultInventoryBatches = [], truncatedOwnership = [] } = {}) {
  const overflowScopeHashes = new Set();
  const hardStopScopeHashes = new Set();
  for (const t of Array.isArray(truncatedOwnership) ? truncatedOwnership : []) {
    const scopes = [...new Set((t && Array.isArray(t.scopeHashes) ? t.scopeHashes : []).map(S).filter(Boolean))];
    if (scopes.length > 1) for (const h of scopes) overflowScopeHashes.add(h);
    else if (scopes.length === 1) hardStopScopeHashes.add(scopes[0]);
  }
  const overflowSellers = new Set();
  const singleSellerHardStops = [];
  const seenHard = new Set();
  for (const b of Array.isArray(defaultInventoryBatches) ? defaultInventoryBatches : []) {
    for (const sid of (b.sellerOrVendorIds || []).map(S).filter(Boolean)) {
      const scope = accountScopeHash([sid]);
      if (hardStopScopeHashes.has(scope)) { if (!seenHard.has(sid)) { seenHard.add(sid); singleSellerHardStops.push(sid); } continue; } // hard-stop precedence
      if (overflowScopeHashes.has(scope)) overflowSellers.add(sid);
    }
  }
  return { overflowSellers, singleSellerHardStops };
}

/**
 * Read the DURABLE ownership of recent terminal-TRUNCATED fba-inventory-health exports for one region-fba cycle bucket,
 * within the recency window. Injectable readers (offline-testable):
 *   readRecentCycleIds(cycleBucket, sinceDate) -> [cycleId]                          (recent region-fba cycles)
 *   readSourceJobs(cycleId) -> [{ request_hash, source_key, fetch_status, error_code, terminal }]
 *   readOwners(cycleId)     -> [{ request_hash, request_key, account_id, account_scope_hash, connection_id,
 *                                 organization_fingerprint, owner_status }]
 * COMPATIBILITY SCOPE (kept, never widened): only owner memberships for the inventory REQUEST KEY (source) + the given
 * connection + organization (when provided) + ACTIVE owner_status are trusted; region + expiry come from the cycle
 * bucket + recency window the caller already scopes. Returns [{ requestHash, scopeHashes:[...], accountIds:[...] }] --
 * one entry per truncated export, its members resolved from ownership. Fail-soft: any read error yields [] (no
 * override -> default batching). Never reuses stale inventory or raises a row cap -- this is planning evidence only.
 */
export async function readRecentTruncatedInventoryOwnership({
  cycleBucket, now = () => Date.now(), maxAgeDays = DEFAULT_OVERFLOW_EVIDENCE_MAX_AGE_DAYS,
  connectionId = null, organizationFingerprint = null,
  readRecentCycleIds, readSourceJobs, readOwners,
} = {}) {
  const out = [];
  if (typeof readRecentCycleIds !== "function" || typeof readSourceJobs !== "function" || typeof readOwners !== "function") return out;
  const sinceDate = new Date(now() - maxAgeDays * 86400000).toISOString().slice(0, 10);
  let cycleIds = [];
  try { cycleIds = (await readRecentCycleIds(cycleBucket, sinceDate)) || []; } catch (_e) { return out; }
  const byHash = new Map(); // requestHash -> { scopeHashes:Set, accountIds:Set }
  for (const cid of cycleIds) {
    let jobs = [];
    try { jobs = (await readSourceJobs(cid)) || []; } catch (_e) { jobs = []; }
    const truncatedHashes = new Set();
    for (const j of jobs) {
      if ((j.source_key ?? j.sourceKey) !== INVENTORY_SOURCE_KEY) continue;
      const failed = (j.fetch_status ?? j.fetchStatus) === "failed";
      const truncated = (j.error_code ?? j.errorCode) === TRUNCATED;
      const terminal = (j.terminal ?? false) === true;
      if (failed && truncated && terminal) truncatedHashes.add(S(j.request_hash ?? j.requestHash));
    }
    if (truncatedHashes.size === 0) continue;
    let owners = [];
    try { owners = (await readOwners(cid)) || []; } catch (_e) { owners = []; }
    for (const o of owners) {
      const hash = S(o.request_hash ?? o.requestHash);
      if (!truncatedHashes.has(hash)) continue;
      if (S(o.request_key ?? o.requestKey) !== INVENTORY_REQUEST_KEY) continue;         // SOURCE compatibility
      if (S(o.owner_status ?? o.ownerStatus ?? "active") === "stale") continue;          // only active memberships
      if (connectionId != null && S(o.connection_id ?? o.connectionId) !== S(connectionId)) continue;             // CONNECTION
      if (organizationFingerprint != null && S(o.organization_fingerprint ?? o.organizationFingerprint) !== S(organizationFingerprint)) continue; // ORGANIZATION
      const scope = S(o.account_scope_hash ?? o.accountScopeHash);
      if (!scope) continue;
      if (!byHash.has(hash)) byHash.set(hash, { requestHash: hash, scopeHashes: new Set(), accountIds: new Set() });
      const e = byHash.get(hash);
      e.scopeHashes.add(scope);
      const acct = S(o.account_id ?? o.accountId);
      if (acct) e.accountIds.add(acct);
    }
  }
  for (const e of byHash.values()) out.push({ requestHash: e.requestHash, scopeHashes: [...e.scopeHashes], accountIds: [...e.accountIds] });
  return out;
}
