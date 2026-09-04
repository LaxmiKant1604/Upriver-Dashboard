// Advanced Listing Health -- Listings / Listings Raw ingestion BATCHING (dormant backend foundation).
//
// PURE, additive, and NOT wired to any exporter/scheduler/route. It proves the ingestion SHAPE for the reviewed
// activation phase: for each (organization, connection, REGION) partition it packs the region's accounts into
// STABLE <=5-seller batches ACROSS MARKETPLACES (marketplace is NOT a partition -- the correction), carrying the
// EXACT seller-marketplace pairs every returned row must be validated against (SKU/ASIN alone can never attribute
// a row across accounts). It reuses the SAME stable packer the FBA regional inventory batching uses
// (source-batching.assignAccountBatches / batchSellerIds), so adding a newly discovered account never reshuffles
// existing batches (and thus never invalidates a cached export/request_hash).
//
// It does NOT compute request_hashes and does NOT mutate any existing source contract, so no FBA/AWD hash or
// behaviour is touched. Turning these batches into real exports (request_hashes, freshnessNotBefore, owner
// metadata) is the activation step, gated on the live Listings-Raw charging re-verify (see the audit).

import { assignAccountBatches, batchSellerIds, MAX_ACCOUNTS_PER_BATCH } from "../sync/source-batching.js";
import { regionForMarketplace } from "../sync/campaign-region-routing.js";

// DataDoe marketplace code (UK -> GB); every other code passes through uppercased.
export function listingHealthMarketplaceCode(country) {
  const c = String(country || "").trim().toUpperCase();
  return c === "UK" ? "GB" : c;
}

// The connection ids the planner/driver actually route (resolveAccountScope yields "primary" | "secondary";
// the source driver maps "secondary" -> "dd-secondary"). Any other value is unsupported routing (fail closed).
export const SUPPORTED_CONNECTION_IDS = Object.freeze(new Set(["primary", "secondary"]));

/**
 * Pack accounts into stable <=5-seller batches per (organization, connection, region), across marketplaces.
 * `accounts`: [{ accountId, rawSellerId, country, connectionId, organizationFingerprint }].
 * `existingMembershipByPartition`: optional Map partitionKey -> Map(accountId -> batchIndex) for stability.
 * Returns { batches, countsByRegion } where each batch is:
 *   { partitionKey, region, connectionId, organizationFingerprint, batchIndex,
 *     sellerOrVendorIds (sorted, <=5), marketplacePairs [{ sellerId, marketplace }],
 *     marketplaceConstraint (the single code, or null when the batch mixes marketplaces) }.
 * Throws (fail closed) on an account with no supported regional assignment or a missing raw seller id.
 */
export function planListingHealthSourceBatches({ accounts = [], existingMembershipByPartition = new Map() } = {}) {
  const partitions = new Map(); // partitionKey -> { region, connectionId, organizationFingerprint, members: [] }
  const identityByAccount = new Map(); // accountId -> canonical identity string (contradiction guard)
  const accountBySeller = new Map();   // "conn|org|rawSellerId" -> accountId (ambiguous-ownership guard)
  for (const a of accounts || []) {
    const rawSellerId = a == null ? "" : String(a.rawSellerId || "").trim();
    const accountId = a == null ? "" : String(a.accountId || "").trim();
    if (!accountId) throw new Error("planListingHealthSourceBatches: account is missing accountId.");
    if (!rawSellerId) throw new Error(`planListingHealthSourceBatches: account "${accountId}" is missing rawSellerId (incomplete trusted identity).`);
    const connectionId = String(a.connectionId || "").trim();
    const organizationFingerprint = String(a.organizationFingerprint || "").trim();
    // COMPLETE trusted identity + SUPPORTED connection routing (never a blank "||region" partition).
    if (!connectionId) throw new Error(`planListingHealthSourceBatches: account "${accountId}" is missing connectionId (incomplete trusted identity).`);
    if (!organizationFingerprint) throw new Error(`planListingHealthSourceBatches: account "${accountId}" is missing organizationFingerprint (incomplete trusted identity).`);
    if (!SUPPORTED_CONNECTION_IDS.has(connectionId)) throw new Error(`planListingHealthSourceBatches: account "${accountId}" has unsupported connection routing "${connectionId}".`);
    const marketplace = listingHealthMarketplaceCode(a.country);
    const region = regionForMarketplace(marketplace);
    if (!region || region === "unassigned") throw new Error(`planListingHealthSourceBatches: account "${accountId}" (${marketplace}) has no supported regional assignment.`);
    // Reject CONTRADICTORY mappings: the same public accountId must resolve to ONE identity, and one raw seller
    // id must not be claimed by two accounts within the same organization/connection (ambiguous ownership).
    const identity = `${rawSellerId}|${marketplace}|${connectionId}|${organizationFingerprint}`;
    const priorIdentity = identityByAccount.get(accountId);
    if (priorIdentity != null && priorIdentity !== identity) throw new Error(`planListingHealthSourceBatches: account "${accountId}" has contradictory mappings (${priorIdentity} vs ${identity}).`);
    identityByAccount.set(accountId, identity);
    const sellerKey = `${connectionId}|${organizationFingerprint}|${rawSellerId}`;
    const priorAccount = accountBySeller.get(sellerKey);
    if (priorAccount != null && priorAccount !== accountId) throw new Error(`planListingHealthSourceBatches: raw seller id "${rawSellerId}" is claimed by both "${priorAccount}" and "${accountId}" (ambiguous ownership).`);
    accountBySeller.set(sellerKey, accountId);
    if (priorIdentity === identity) continue; // an exact duplicate of the same account is idempotent, not a new member
    const partitionKey = `${connectionId}|${organizationFingerprint}|${region}`;
    if (!partitions.has(partitionKey)) partitions.set(partitionKey, { region, connectionId, organizationFingerprint, members: [] });
    partitions.get(partitionKey).members.push({ accountId, rawSellerId, marketplace });
  }

  const batches = [];
  const countsByRegion = {};
  for (const [partitionKey, part] of partitions) {
    const existing = existingMembershipByPartition.get(partitionKey) || new Map();
    const { batches: packed } = assignAccountBatches(
      part.members.map((m) => ({ accountId: m.accountId, rawSellerId: m.rawSellerId })),
      existing, MAX_ACCOUNTS_PER_BATCH,
    );
    const byId = new Map(part.members.map((m) => [m.accountId, m]));
    for (const batch of packed) {
      const owners = batch.accounts.map((a) => byId.get(a.accountId));
      const pairs = owners.map((m) => ({ sellerId: m.rawSellerId, marketplace: m.marketplace }));
      const markets = [...new Set(pairs.map((p) => p.marketplace))];
      batches.push({
        partitionKey,
        region: part.region,
        connectionId: part.connectionId,
        organizationFingerprint: part.organizationFingerprint,
        batchIndex: batch.batchIndex,
        sellerOrVendorIds: batchSellerIds(batch),
        marketplacePairs: pairs,
        marketplaceConstraint: markets.length === 1 ? markets[0] : null,
      });
    }
    countsByRegion[part.region] = (countsByRegion[part.region] || 0) + packed.length;
  }
  return { batches, countsByRegion };
}
