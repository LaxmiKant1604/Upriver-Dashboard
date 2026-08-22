// Scheduler v2 -- STABLE, automatic ONE-BATCH-PER-FAMILY SOURCE batching (SHADOW MODE, pure core).
//
// DataDoe confirmed IN WRITING that ANY number of sellerOrVendorIds may be combined in one export (multiple
// marketplaces safely; the only cap is 5,000,000 rows, a separate per-source concern). So a "batch" groups
// ALL compatible accounts of a family into ONE DataDoe export over the sorted batch seller ids -- one US
// export and one Non-US export per seller-scoped source/window (the family key folds the bucket, so US and
// Non-US resolve to different families and never share an export). [Superseded: the former <=5-account cap.]
// The canonical source scope is the BATCH (its request_hash folds the sorted batch seller ids); OWNER scope
// stays one exact (report, account) so many accounts can own one source job without colliding (see
// source-identity.sourceJobOwnerId, which folds the INDIVIDUAL account). Per-account isolation of the
// downloaded rows is enforced separately (source-account-isolation.js), independent of batch size.
//
// STABILITY: adding a newly discovered/approved compatible account simply JOINS the family's single batch
// (no new batch, no reshuffle). Durable membership (source_batch_membership + assign_source_account_batch
// RPC) records the assignment; this pure engine is the model the durable RPC mirrors and the test double.
//
// COMPATIBILITY (two accounts may share one export) requires identical organization, connection, bucket,
// source id, columns, grouping, aggregations, ordering, limit, window SHAPE and marketplace constraint --
// everything the export request identity depends on EXCEPT the per-account seller ids and the concrete
// date window. Primary and dd-secondary (or different organizations) NEVER mix: the connection id +
// organization fingerprint are part of the family key.

import { createHash } from "node:crypto";

// One batch per family: no per-batch account cap (DataDoe allows any number of sellers per export).
export const MAX_ACCOUNTS_PER_BATCH = Number.MAX_SAFE_INTEGER;

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
// The batching-policy version folded into EVERY family key. Bumping it (here: to the unlimited one-batch-per
// US/Non-US-family policy) moves ALL new cycles into a FRESH canonical membership namespace, so historical
// source_batch_membership rows created under the old <=5 policy live under a DIFFERENT family key and can never
// combine with -- or be reinterpreted by -- a new plan. Historical cycles keep their own request hashes,
// owners, scopes, budgets and evidence unchanged (they folded the old policy version / no version).
export const BATCHING_POLICY_VERSION = "us-nonus-unlimited/v2";

export function batchFamilyKey({
  organizationFingerprint, connectionId, bucket, sourceId,
  columns, groupBy, aggregations, orderByColumn, orderByDirection, limit,
  windowKind, marketplaceConstraint, batchingPolicyVersion = BATCHING_POLICY_VERSION,
}) {
  const norm = stableJson({
    policy: String(batchingPolicyVersion || ""), // explicit batching-policy version -> fresh namespace on bump
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
