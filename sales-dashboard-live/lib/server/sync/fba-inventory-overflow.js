// Adaptive FBA Inventory self-heal -- PROVEN-OVERFLOW seller evidence (pure + injectable I/O).
//
// A strict, seller-scoped FBA Inventory Health batch that returns exactly its 50000-row cap is rejected TRUNCATED
// (terminal) and never saved -- a legitimate DATA-VOLUME overflow. Left alone, the SAME sellers re-batch together every
// cycle and truncate identically forever. This module derives, from recent terminal TRUNCATED evidence, the set of
// sellers that must be proactively routed into SINGLE-SELLER inventory jobs so a future cycle self-heals -- scoped by
// organization + source + region + marketplace (via the region-fba cycle bucket), never hard-coded, with a reviewed
// recency window (expiry). It applies ONLY to fba-inventory-health; a batch of ONE seller that still truncates is a
// HARD STOP (it cannot split further -- the caller must escalate, never auto-raise the limit).

const S = (v) => (v == null ? "" : String(v));
const TRUNCATED = "TRUNCATED";
const INVENTORY_SOURCE_KEY = "fba-inventory-health";
export const DEFAULT_OVERFLOW_EVIDENCE_MAX_AGE_DAYS = 14; // recency window (expiry/reset): older evidence is ignored

/**
 * The inventory batches (requestHash -> its exact seller ids) of a DEFAULT (no-override) FBA plan. Because batching is
 * stable for a fixed account set, a prior cycle's TRUNCATED batch hash equals the current default plan's batch hash,
 * so a TRUNCATED hash maps deterministically back to its sellers.
 */
export function defaultInventoryBatchesOf(fbaReportRequests) {
  const byHash = new Map();
  for (const r of fbaReportRequests || []) {
    for (const s of r.sources || []) {
      if (s.requestKey !== "fba-plan:inventory-health") continue;
      if (!byHash.has(s.requestHash)) byHash.set(s.requestHash, { requestHash: s.requestHash, sellerOrVendorIds: (s.sellerOrVendorIds || []).map(String) });
    }
  }
  return [...byHash.values()];
}

/**
 * PURE core: given the default inventory batches + the set of recent terminal-TRUNCATED inventory request hashes,
 * return { overflowSellers:Set, singleSellerHardStops:string[] }. A MULTI-seller truncated batch contributes all its
 * sellers to `overflowSellers` (they must be isolated). A SINGLE-seller truncated batch cannot split further -> it is a
 * HARD STOP (reported, never re-routed, never auto-limit-raised).
 */
export function overflowSellersFromTruncated({ defaultInventoryBatches = [], recentTruncatedHashes = new Set() }) {
  const overflowSellers = new Set();
  const singleSellerHardStops = [];
  for (const b of defaultInventoryBatches) {
    if (!recentTruncatedHashes.has(b.requestHash)) continue;
    const sellers = (b.sellerOrVendorIds || []).map(String).filter(Boolean);
    if (sellers.length > 1) for (const s of sellers) overflowSellers.add(s);
    else if (sellers.length === 1) singleSellerHardStops.push(sellers[0]);
  }
  return { overflowSellers, singleSellerHardStops };
}

/**
 * Read the recent terminal-TRUNCATED fba-inventory-health request hashes for one region-fba cycle bucket, within the
 * recency window. Injectable readers (offline-testable):
 *   readRecentCycleIds(cycleBucket, sinceDate) -> [cycleId]         (recent region-fba cycles)
 *   readSourceJobs(cycleId) -> [{ request_hash, source_key, fetch_status, error_code, terminal }]
 * Returns a Set of request hashes. Fail-soft: a read error yields an empty set (no override -> default batching).
 */
export async function readRecentTruncatedInventoryHashes({ cycleBucket, now = () => Date.now(), maxAgeDays = DEFAULT_OVERFLOW_EVIDENCE_MAX_AGE_DAYS, readRecentCycleIds, readSourceJobs }) {
  const hashes = new Set();
  if (typeof readRecentCycleIds !== "function" || typeof readSourceJobs !== "function") return hashes;
  const sinceDate = new Date(now() - maxAgeDays * 86400000).toISOString().slice(0, 10);
  let cycleIds = [];
  try { cycleIds = (await readRecentCycleIds(cycleBucket, sinceDate)) || []; } catch (_e) { return hashes; }
  for (const cid of cycleIds) {
    let jobs = [];
    try { jobs = (await readSourceJobs(cid)) || []; } catch (_e) { jobs = []; }
    for (const j of jobs) {
      if ((j.source_key ?? j.sourceKey) !== INVENTORY_SOURCE_KEY) continue;
      const failed = (j.fetch_status ?? j.fetchStatus) === "failed";
      const truncated = (j.error_code ?? j.errorCode) === TRUNCATED;
      const terminal = (j.terminal ?? false) === true;
      if (failed && truncated && terminal) hashes.add(S(j.request_hash ?? j.requestHash));
    }
  }
  return hashes;
}
