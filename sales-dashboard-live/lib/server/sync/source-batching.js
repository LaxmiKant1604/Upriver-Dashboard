// Scheduler v2 -- STABLE, automatic <=5-account SOURCE batching (SHADOW MODE, pure core).
//
// A "batch" groups up to FIVE compatible primary accounts so their shared canonical source (Order Line
// Items, order-lines) is fetched as ONE DataDoe export over the sorted batch seller ids instead of one
// export per account. The canonical source scope is the BATCH (its request_hash folds the sorted batch
// seller ids); OWNER scope stays one exact (report, account) so five accounts can own one source job
// without colliding (see source-identity.sourceJobOwnerId, which folds the INDIVIDUAL account).
//
// STABILITY is the core requirement: adding one newly discovered/approved account must NOT reshuffle the
// existing accounts (which would invalidate every existing request_hash / cached export). This module keeps
// every existing assignment and only PLACES new accounts, into the smallest non-full batch (or a fresh
// batch when all are full). Durable membership (source_batch_membership + assign_source_account_batch RPC)
// makes the assignment stable across processes and enforces the five-account maximum transactionally; this
// pure engine is the model the durable RPC mirrors and the in-memory test double.
//
// COMPATIBILITY (two accounts may share one export) requires identical organization, connection, bucket,
// source id, columns, grouping, aggregations, ordering, limit, window SHAPE and marketplace constraint --
// everything the export request identity depends on EXCEPT the per-account seller ids and the concrete
// date window (a batch serves every window of a cycle uniformly, and all accounts of a bucket/cycle share
// the same asOf-derived windows). Primary and dd-secondary (or different organizations) NEVER mix: the
// connection id + organization fingerprint are part of the family key.

import { createHash } from "node:crypto";

export const MAX_ACCOUNTS_PER_BATCH = 5;

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stableJson(value[k])]));
}

/**
 * The STABLE compatibility family key. Two accounts share one canonical batched export iff they resolve to
 * the same key. It folds every compatibility dimension EXCEPT the per-account seller ids and the concrete
 * date window (so membership is stable as the window advances each cycle); the window SHAPE (windowKind) IS
 * folded so incompatible window shapes never merge. connection_id + organization_fingerprint are folded, so
 * primary/dd-secondary and different organizations can never batch together. Returns a 32-hex string.
 */
export function batchFamilyKey({
  organizationFingerprint, connectionId, bucket, sourceId,
  columns, groupBy, aggregations, orderByColumn, orderByDirection, limit,
  windowKind, marketplaceConstraint,
}) {
  const norm = stableJson({
    org: String(organizationFingerprint || ""),
    conn: String(connectionId || ""),
    bucket: String(bucket || ""),
    source: String(sourceId || ""),
    columns: [...(columns || [])].map(String).sort(),
    groupBy: [...(groupBy || [])].map(String).sort(),
    aggregations: [...(aggregations || [])].map(stableJson).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    orderByColumn: String(orderByColumn || "date"),
    orderByDirection: String(orderByDirection || "ASC"),
    limit: limit == null ? null : Number(limit),
    windowKind: String(windowKind || ""),
    marketplace: String(marketplaceConstraint || ""),
  });
  return createHash("sha256").update(JSON.stringify(norm)).digest("hex").slice(0, 32);
}

/**
 * PURE, STABLE assignment. Given the eligible `accounts` (each `{ accountId, ... }`) and the EXISTING
 * durable membership (Map accountId -> batchIndex), return `{ membership, batches }` where:
 *   - every EXISTING assignment is preserved unchanged (adding an account never moves another);
 *   - each NEW account is placed into the SMALLEST-index batch that currently has < max members, or, when
 *     all existing batches are full, into a fresh batch (max existing index + 1);
 *   - new accounts are considered in sorted accountId order (deterministic);
 *   - `batches` is an ascending-by-index array of `{ batchIndex, accounts: [sorted by accountId] }`, with
 *     NO batch larger than `max`.
 * This mirrors what the durable assign_source_account_batch RPC does one account at a time (arrival order in
 * production), and is the exact model the batch tests assert against.
 */
export function assignAccountBatches(accounts, existing = new Map(), max = MAX_ACCOUNTS_PER_BATCH) {
  if (!(max >= 1)) throw new Error("assignAccountBatches: max must be >= 1.");
  const membership = new Map(existing); // accountId -> batchIndex, existing preserved
  const counts = new Map();             // batchIndex -> current member count
  for (const idx of membership.values()) counts.set(idx, (counts.get(idx) || 0) + 1);

  const known = new Set(membership.keys());
  const fresh = (accounts || [])
    .map((a) => String(a.accountId))
    .filter((id) => id && !known.has(id))
    .sort();

  for (const id of fresh) {
    let chosen = null;
    for (const idx of [...counts.keys()].sort((a, b) => a - b)) {
      if ((counts.get(idx) || 0) < max) { chosen = idx; break; }
    }
    if (chosen === null) chosen = counts.size === 0 ? 0 : Math.max(...counts.keys()) + 1;
    membership.set(id, chosen);
    counts.set(chosen, (counts.get(chosen) || 0) + 1);
  }

  const byIndex = new Map();
  for (const a of accounts || []) {
    const idx = membership.get(String(a.accountId));
    if (idx == null) continue;
    if (!byIndex.has(idx)) byIndex.set(idx, []);
    byIndex.get(idx).push(a);
  }
  const batches = [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([batchIndex, accs]) => ({
      batchIndex,
      accounts: accs.slice().sort((x, y) => String(x.accountId).localeCompare(String(y.accountId))),
    }));

  // Defensive: the placement above can never exceed `max`, but assert it so a future edit can't regress.
  for (const b of batches) {
    if (b.accounts.length > max) {
      throw new Error(`assignAccountBatches produced a batch of ${b.accounts.length} > max ${max} (invariant violation).`);
    }
  }
  return { membership, batches };
}

/**
 * The sorted seller-id list a batch presents to sourceRequestIdentity as `ids` (the canonical request_hash
 * folds the SORTED batch seller ids). Accepts each account's raw seller id via `sellerIdOf` (defaults to
 * account.rawSellerId || account.accountId). Deduplicates and sorts, matching source-identity's own sort.
 */
export function batchSellerIds(batch, sellerIdOf = (a) => a.rawSellerId ?? a.accountId) {
  const ids = (batch.accounts || []).map((a) => String(sellerIdOf(a))).filter(Boolean);
  return [...new Set(ids)].sort();
}
