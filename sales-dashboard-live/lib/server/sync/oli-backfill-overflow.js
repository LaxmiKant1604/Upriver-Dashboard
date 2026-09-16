// Adaptive OLI-backfill ROW-CAP self-heal -- PROVEN-TRUNCATED backfill evidence (pure + injectable I/O).
//
// The durable OLI backfill fetches a new/long-behind account's missing history in day-bounded chunks (<=441 solo /
// <=221 multi-seller). Those bounds are DAYS, not the 5,000-row DataDoe create cap, so a DENSE account's chunk returns
// exactly the cap and is rejected TRUNCATED (terminal) -- and, because the same missing window re-plans the same chunk
// every cycle, the account's history NEVER fills. It stays deferred (a leading/interior OLI gap), and the region's daily
// cycle never finalizes (proven: REELLEO Express DE stalled every europe-au cycle). This module derives, from recent
// PRIOR-cycle terminal TRUNCATED source-oli:slice-v1 evidence, the set of RAW seller ids whose backfill must be re-sliced
// by the canonical weekly bins (row-cap-safe) so a future cycle self-heals -- scoped by organization + connection +
// source + region (via the region cycle bucket) + a reviewed recency window, never hard-coded.
//
// Like the FBA inventory self-heal, ownership is resolved DATE-INDEPENDENTLY: each TRUNCATED backfill export's OWNER
// rows (sync_source_job_owners, request_key source-oli:slice-v1) carry each member's account_scope_hash =
// accountScopeHash([rawSellerId]); we match those against the current plan's sellers (which recompute the same scope
// hash), so the set survives the daily date rollover and follows membership changes. The CURRENT cycle is EXCLUDED so
// the evidence is stable across a cycle's continuations (a continuation re-derives the SAME set -> the SAME weekly plan,
// with no frozen state). Fail-soft: any read error yields an empty set (byte-identical default chunking). This is
// PLANNING evidence only -- it never reuses stale data, never raises a cap, and never re-fetches a proven window.

import { accountScopeHash } from "../source-identity.js";

const S = (v) => (v == null ? "" : String(v));
const TRUNCATED = "TRUNCATED";
const OLI_SOURCE_KEY = "order-line-items";
const OLI_BACKFILL_REQUEST_KEY = "source-oli:slice-v1"; // the owner memberships to trust (source compatibility)
export const DEFAULT_OLI_BACKFILL_EVIDENCE_MAX_AGE_DAYS = 14; // recency window (expiry/reset): older evidence is ignored

/**
 * PURE: given the current plan's raw seller ids + the individual OWNER scope hashes of recent terminal-TRUNCATED OLI
 * backfill exports, return the Set of RAW seller ids whose backfill must be weekly-sliced. A current seller `sid` is
 * affected iff accountScopeHash([sid]) is in the truncated-owner scope set -- so a departed seller is ignored and the
 * daily date rollover never empties the set.
 */
export function oliBackfillWeeklySellersFrom({ truncatedScopeHashes = [], sellerIds = [] } = {}) {
  const scopes = new Set((Array.isArray(truncatedScopeHashes) ? truncatedScopeHashes : [...(truncatedScopeHashes || [])]).map(S).filter(Boolean));
  const out = new Set();
  if (scopes.size === 0) return out;
  for (const sid of sellerIds || []) {
    const raw = S(sid);
    if (!raw) continue;
    if (scopes.has(accountScopeHash([raw]))) out.add(raw);
  }
  return out;
}

/**
 * Read the DURABLE owner scope hashes of recent terminal-TRUNCATED source-oli:slice-v1 exports for one region cycle
 * bucket, within the recency window, EXCLUDING the current cycle (stability across continuations). Injectable readers
 * (offline-testable), mirroring the FBA inventory self-heal:
 *   readRecentCycleIds(cycleBucket, sinceDate) -> [cycleId]
 *   readSourceJobs(cycleId) -> [{ request_hash, source_key, fetch_status, error_code, terminal }]
 *   readOwners(cycleId)     -> [{ request_hash, request_key, account_scope_hash, connection_id, organization_fingerprint,
 *                                 owner_status }]
 * Only owners for the OLI-backfill REQUEST KEY + the given connection + organization (when provided) + ACTIVE
 * owner_status are trusted. Returns a Set of individual owner scope hashes. Fail-soft: any read error yields an empty Set.
 */
export async function readRecentTruncatedOliBackfillOwnership({
  cycleBucket, now = () => Date.now(), maxAgeDays = DEFAULT_OLI_BACKFILL_EVIDENCE_MAX_AGE_DAYS,
  connectionId = null, organizationFingerprint = null, excludeCycleId = null,
  readRecentCycleIds, readSourceJobs, readOwners,
} = {}) {
  const out = new Set();
  if (typeof readRecentCycleIds !== "function" || typeof readSourceJobs !== "function" || typeof readOwners !== "function") return out;
  const sinceDate = new Date(now() - maxAgeDays * 86400000).toISOString().slice(0, 10);
  let cycleIds = [];
  try { cycleIds = (await readRecentCycleIds(cycleBucket, sinceDate)) || []; } catch (_e) { return out; }
  const exclude = S(excludeCycleId);
  for (const cid of cycleIds) {
    if (exclude && S(cid) === exclude) continue; // NEVER the current cycle -> stable across this cycle's continuations
    let jobs = [];
    try { jobs = (await readSourceJobs(cid)) || []; } catch (_e) { jobs = []; }
    const truncatedHashes = new Set();
    for (const j of jobs) {
      if ((j.source_key ?? j.sourceKey) !== OLI_SOURCE_KEY) continue;
      const failed = (j.fetch_status ?? j.fetchStatus) === "failed";
      const truncated = (j.error_code ?? j.errorCode) === TRUNCATED;
      const terminal = (j.terminal ?? false) === true;
      if (failed && truncated && terminal) truncatedHashes.add(S(j.request_hash ?? j.requestHash));
    }
    if (truncatedHashes.size === 0) continue;
    let owners = [];
    try { owners = (await readOwners(cid)) || []; } catch (_e) { owners = []; }
    // Collect the IN-SCOPE OLI-backfill owner scope hashes per truncated export.
    const scopesByHash = new Map();
    for (const o of owners) {
      const h = S(o.request_hash ?? o.requestHash);
      if (!truncatedHashes.has(h)) continue;
      if (S(o.request_key ?? o.requestKey) !== OLI_BACKFILL_REQUEST_KEY) continue;                 // SOURCE compatibility
      if (S(o.owner_status ?? o.ownerStatus ?? "active") === "stale") continue;                     // only active memberships
      if (connectionId != null && S(o.connection_id ?? o.connectionId) !== S(connectionId)) continue;             // CONNECTION
      if (organizationFingerprint != null && S(o.organization_fingerprint ?? o.organizationFingerprint) !== S(organizationFingerprint)) continue; // ORGANIZATION
      const scope = S(o.account_scope_hash ?? o.accountScopeHash);
      if (!scope) continue;
      if (!scopesByHash.has(h)) scopesByHash.set(h, new Set());
      scopesByHash.get(h).add(scope);
    }
    // Trust ONLY a SINGLE-SELLER truncation as weekly evidence: it proves THAT seller truncates its backfill chunk even
    // ALONE, so it genuinely needs weekly slicing. A MULTI-seller export truncated on the COMBINED rows -- that never
    // proves any individual member truncates solo (isolating them into single-seller chunks may already fit), so a
    // sparse batch-mate must NOT inherit weekly slicing (the cost regression the constraint forbids).
    for (const scopes of scopesByHash.values()) {
      if (scopes.size === 1) for (const s of scopes) out.add(s);
    }
  }
  return out;
}
