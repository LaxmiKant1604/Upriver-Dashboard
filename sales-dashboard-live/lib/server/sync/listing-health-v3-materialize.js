// Advanced Listing Health v3 -- PER-ACCOUNT SOURCE MATERIALIZATION (Phase 4A).
//
// THE DEFECT THIS FIXES: regional Listings / Listings-Raw / inventory are exported in <=5-seller BATCHES, so the
// batch rows live in source_export_cache under the BATCH request_hash (ids = up to five sellers). The v3 read path
// (serveListingHealthV3Preview) resolves a PER-ACCOUNT request identity (ids = [one seller]) whose request_hash is
// DIFFERENT from the batch hash, so a valid per-account read always MISSES and the page shows Unavailable.
//
// THE FIX (ZERO new DataDoe exports): after a batch source download has already succeeded + been validated + saved
// under its batch hash, split it back per account and PERSIST each isolated fragment under that account's OWN
// per-account read identity -- the exact request_hash the serve computes. So one batch export materializes N
// per-account cache entries, each containing ONLY that seller's rows.
//
// SAFETY (all fail-closed):
//   - the per-account read identity is computed by the SAME shared helper the serve uses (byte-identical hash);
//   - rows are isolated by the trusted planned OWNER (rawSellerId + marketplace + org + connection) via the pure
//     isolateFragmentRowsForOwner -- a row that cannot be attributed to the owner (cross-org / cross-connection /
//     blank owner) is REJECTED and NEVER written, so one seller's rows can never land in another seller's cache;
//   - a genuinely empty owner fragment ([]) is written as VALID-EMPTY (distinct from a missing alias = Unavailable);
//   - a missing/failed batch is SKIPPED (no write, no delete) so the previous per-account alias (last-known-good)
//     survives;
//   - the write is an UPSERT keyed by request_hash, so replay can never duplicate a row;
//   - inventory reuses the FBA Plan batch export byte-identically -- this module reads that batch and only ALIASES
//     the per-account fragment; it never plans, creates, or alters any FBA/AWD export or hash.

import { reportSourceRequestHashes } from "./report-source-contracts.js";
import { isolateFragmentRowsForOwner } from "./source-account-isolation.js";
import { organizationFingerprint as orgFingerprintOf } from "../source-identity.js";

// The three v3 source families that need per-account materialization. Catalog + OLI are DURABLE, org/per-account
// reads (never batched here), so they are deliberately absent.
export const LISTING_HEALTH_V3_READ_KEYS = Object.freeze([
  "listing-health-v3:listings",
  "listing-health-v3:listings-raw",
  "listing-health-v3:inventory",
]);

// The per-account READ identity uses DATE-FREE windows for ALL three keys, so it is a STABLE key that both the writer
// (this module) and the reader (the serve) agree on regardless of the day. The inventory alias is deliberately
// date-free too: inventory is the "latest snapshot", not a windowed series, so coupling its read identity to a
// rolling as-of would make the serve miss the freshly-written alias on the next day. The dated batch export
// (fba-plan:inventory-health) is UNCHANGED -- this only governs the per-account alias/read identity.
const DATE_FREE_WINDOWS = Object.freeze({
  "listing-health-v3:listings": [{ from: null, to: null }],
  "listing-health-v3:listings-raw": [{ from: null, to: null }],
  "listing-health-v3:inventory": [{ from: null, to: null }],
});

/**
 * The full per-account READ identities (requestHash + sourceId + org + scope + requestMeta) for ONE account, keyed
 * by requestKey. marketplaceCountry does NOT affect the request_hash (it only gates conditional contracts, of which
 * v3 has none), so serve (which may pass null) and this module (which passes the owner marketplace) resolve the
 * IDENTICAL hash. Throws only on a malformed contract set (never for a normal account).
 */
export function listingHealthV3PerAccountReadIdentities({ apiKey, rawSellerId, marketplaceCountry = null }) {
  const resolved = reportSourceRequestHashes({
    reportKey: "listing-health-v3",
    apiKey,
    ids: [rawSellerId],
    windowsByRequestKey: DATE_FREE_WINDOWS,
    marketplaceCountry,
  }) || [];
  const by = {};
  for (const r of resolved) by[r.requestKey] = r;
  return by;
}

/** Convenience: just the per-account read request_hash per requestKey (what the serve needs). */
export function listingHealthV3PerAccountReadHashes(args) {
  const identities = listingHealthV3PerAccountReadIdentities(args);
  const by = {};
  for (const k of Object.keys(identities)) by[k] = identities[k].requestHash;
  return by;
}

const S = (v) => (v == null ? "" : String(v));
function approxBytes(rows) { try { return Buffer.byteLength(JSON.stringify({ rows })); } catch { return 0; } }

// ===================== DEDICATED PER-REGION EXPORT CEILING (budget safety) =====================
// The ONLY NEW DataDoe exports v3 creates are Listings + Listings-Raw (one create per <=5-seller batch). Inventory
// reuses the FBA Plan batch export (a shared request_hash -> a cache adoption, never a v3 create), and OLI + Catalog
// are DERIVED durable reads -- so all three count as ZERO incremental exports. The ceiling is a STRUCTURAL create
// count (not a token maximum): DataDoe reports rowCountBilling=true, so the observed 2-token price is NOT an
// unconditional maximum -- the defensive gate bounds the number of creates so a plan drift can never fan out exports.
export const LISTING_HEALTH_V3_NEW_EXPORT_KEYS = Object.freeze(["listing-health-v3:listings", "listing-health-v3:listings-raw"]);
export const LISTING_HEALTH_V3_REUSED_EXPORT_KEYS = Object.freeze(["listing-health-v3:inventory"]);

// Expected per-region ceilings = 2 x (regional batch count) at the reviewed baseline (India 2 / Europe-AU 4 / US-CA 2
// batches -> 4 / 8 / 4 new exports). A reviewed phase raises these deliberately; account growth beyond a ceiling
// FAILS CLOSED (no runaway create) until the ceiling is re-reviewed.
export const LISTING_HEALTH_V3_REGION_EXPORT_CEILING = Object.freeze({ india: 4, "europe-au": 8, "us-ca": 4 });

/** Count the DISTINCT planned v3 export request_hashes, split into NEW (listings + listings-raw) vs REUSED (inventory). */
export function listingHealthV3PlannedExports(plans) {
  const newHashes = new Set();
  const reusedHashes = new Set();
  for (const plan of plans || []) {
    if (!plan || plan.reportKey !== "listing-health-v3") continue;
    for (const s of plan.sources || []) {
      if (LISTING_HEALTH_V3_NEW_EXPORT_KEYS.includes(s.requestKey)) newHashes.add(s.requestHash);
      else if (LISTING_HEALTH_V3_REUSED_EXPORT_KEYS.includes(s.requestKey)) reusedHashes.add(s.requestHash);
    }
  }
  return { newExports: newHashes.size, reusedExports: reusedHashes.size, newExportHashes: [...newHashes], reusedExportHashes: [...reusedHashes] };
}

/**
 * FAIL-CLOSED per-region export-ceiling gate. Counts ONLY the new Listings + Listings-Raw creates (inventory reuse =
 * zero incremental) and throws BEFORE any create when the planned count exceeds the region's ceiling. Returns the
 * counts + ceiling when within budget. `ceiling` overrides the region default (for a reviewed bump / a test).
 */
export function assertListingHealthV3ExportCeiling({ region, plans, ceiling = null }) {
  const counts = listingHealthV3PlannedExports(plans);
  const cap = ceiling != null ? ceiling : LISTING_HEALTH_V3_REGION_EXPORT_CEILING[String(region)];
  if (typeof cap !== "number" || !Number.isFinite(cap) || cap < 0) {
    throw new Error(`listing-health-v3 has no reviewed export ceiling for region "${region}" (fail closed).`);
  }
  if (counts.newExports > cap) {
    throw new Error(`listing-health-v3 planned ${counts.newExports} new Listings/Listings-Raw exports for region "${region}" exceeds its reviewed ceiling ${cap}; refusing to create (fail closed).`);
  }
  return { region: String(region), ceiling: cap, withinCeiling: true, ...counts };
}

/**
 * Materialize per-account aliases for a set of v3 report plans (planListingHealthV3BucketBatched output). PURE
 * orchestration over INJECTED read-only cache I/O -- it makes ZERO DataDoe exports and never writes a snapshot.
 *
 *   plans            : v3 report requests, each { owner, sources[], connectionId } (per account).
 *   connections      : [{ id, apiKey }] -- resolves the owner's apiKey for the read identity.
 *   readSourceCache  : async (requestHash) -> { rows, fetched_at?, expires_at?, ... } | null  (getSourceExportCache; cache-only).
 *   writeSourceCache : async ({ requestHash, sourceId, organizationFingerprint, accountScopeHash, requestMeta, rows,
 *                      payloadBytes, expiresAt }) -> void  (saveSourceExportCache; UPSERT by request_hash).
 *   readAliasMeta    : OPTIONAL async (requestHash) -> { batchFetchedAt } | null. When provided, an alias is
 *                      OVERWRITTEN only from a STRICTLY NEWER validated batch (compared by the source batch's
 *                      fetched_at). A late/older or same-cycle-replay batch is SKIPPED, so an older or concurrent
 *                      completion can never replace newer alias data and a replay writes nothing. Omitted -> writes
 *                      unconditionally (backward compatible).
 *
 * Returns a summary { accounts, aliasesWritten, emptyAliases, rejected, batchMissing, skippedAccounts, skippedStale,
 * aliases[], rejections[] } -- never a secret. One plan's failure never aborts the others.
 */
export async function materializeListingHealthV3PerAccount({ plans = [], connections = [], readSourceCache, writeSourceCache, readAliasMeta = null, clock = () => Date.now() }) {
  if (typeof readSourceCache !== "function" || typeof writeSourceCache !== "function") {
    throw new Error("materializeListingHealthV3PerAccount requires readSourceCache + writeSourceCache callbacks (fail closed).");
  }
  const summary = { accounts: 0, aliasesWritten: 0, emptyAliases: 0, rejected: 0, batchMissing: 0, skippedAccounts: 0, skippedStale: 0, aliases: [], rejections: [] };
  const connById = new Map((connections || []).map((c) => [String(c.id), c]));

  for (const plan of plans || []) {
    if (!plan || plan.reportKey !== "listing-health-v3") continue; // only ever act on v3 plans
    const owner = plan.owner;
    // Fail closed: an incomplete owner can never attribute rows safely -> skip the whole account (no write).
    if (!owner || S(owner.rawSellerId).trim() === "" || S(owner.accountId).trim() === "" || S(owner.connectionId).trim() === "" || S(owner.organizationFingerprint).trim() === "") {
      summary.skippedAccounts += 1;
      continue;
    }
    const conn = connById.get(S(owner.connectionId));
    const apiKey = conn ? conn.apiKey : null;
    if (!apiKey) { summary.skippedAccounts += 1; continue; }
    // Belt-and-suspenders: the resolved connection's org fingerprint MUST match the planned owner's -- otherwise the
    // read identity would be computed under the wrong organization. Fail closed rather than write a mis-scoped alias.
    if (orgFingerprintOf(apiKey) !== S(owner.organizationFingerprint)) { summary.skippedAccounts += 1; continue; }

    let identities;
    try { identities = listingHealthV3PerAccountReadIdentities({ apiKey, rawSellerId: owner.rawSellerId, marketplaceCountry: owner.marketplace || null }); }
    catch (_e) { summary.skippedAccounts += 1; continue; }
    summary.accounts += 1;

    for (const src of plan.sources || []) {
      if (!LISTING_HEALTH_V3_READ_KEYS.includes(src.requestKey)) continue;
      const ident = identities[src.requestKey];
      if (!ident || !ident.requestHash) continue;

      // 1) Read the ALREADY-SAVED batch payload (cache-only; never an export). A miss/malformed batch means the
      //    batch has not (yet) succeeded this cycle -> leave the per-account alias UNTOUCHED (previous LKG survives).
      let batch = null;
      try { batch = await readSourceCache(src.requestHash); } catch (_e) { batch = null; }
      if (!batch || !Array.isArray(batch.rows)) { summary.batchMissing += 1; continue; }

      // 2) Isolate ONLY this owner's rows (by trusted rawSellerId + marketplace + org + connection). A rejected
      //    fragment (blank owner / cross-org / cross-connection) is NEVER written -- fail closed.
      const iso = isolateFragmentRowsForOwner(
        { rows: batch.rows, sourceScope: src.sourceScope, sellerOrVendorIds: src.sellerOrVendorIds, organizationFingerprint: src.organizationFingerprint, connectionId: src.connectionId },
        owner,
      );
      if (iso.rejected || !Array.isArray(iso.rows)) {
        summary.rejected += 1;
        summary.rejections.push({ accountId: owner.accountId, requestKey: src.requestKey });
        continue;
      }

      // 3) FRESHNESS GUARD: overwrite an existing alias ONLY from a STRICTLY NEWER validated batch (compared by the
      //    batch's fetched_at). A late/older completion or a same-cycle replay is skipped -> newer alias data is never
      //    replaced and a replay writes nothing. Skipped when readAliasMeta is not injected or the batch has no
      //    fetched_at (backward compatible).
      const incomingFetchedAt = batch.fetched_at || batch.fetchedAt || null;
      if (incomingFetchedAt && typeof readAliasMeta === "function") {
        let existingMeta = null;
        try { existingMeta = await readAliasMeta(ident.requestHash); } catch (_e) { existingMeta = null; }
        const existingFetchedAt = existingMeta && (existingMeta.batchFetchedAt || existingMeta.batch_fetched_at) || null;
        if (existingFetchedAt && Date.parse(String(existingFetchedAt)) >= Date.parse(String(incomingFetchedAt))) {
          summary.skippedStale += 1; // an equal-or-newer alias already exists -> preserve it (LKG / idempotent replay)
          continue;
        }
      }

      // 4) Persist the isolated fragment under the PER-ACCOUNT read identity (UPSERT by request_hash -> idempotent,
      //    no duplicates). A genuinely empty fragment ([]) is a VALID-EMPTY alias (distinct from a missing alias). The
      //    source batch's fetched_at is stamped so a later pass can enforce newer-only overwrites (above).
      const rows = iso.rows;
      try {
        await writeSourceCache({
          requestHash: ident.requestHash,
          sourceId: ident.sourceId,
          organizationFingerprint: ident.organizationFingerprint,
          accountScopeHash: ident.accountScopeHash,
          requestMeta: { ...(ident.requestMeta || {}), batchFetchedAt: incomingFetchedAt || null, materializedFromHash: src.requestHash },
          rows,
          payloadBytes: approxBytes(rows),
          expiresAt: batch.expires_at || batch.expiresAt || null,
        });
      } catch (_e) {
        // A write failure for one account/source is isolated (previous alias preserved); record nothing fabricated.
        summary.rejections.push({ accountId: owner.accountId, requestKey: src.requestKey, error: "write-failed" });
        continue;
      }
      if (rows.length === 0) summary.emptyAliases += 1; else summary.aliasesWritten += 1;
      summary.aliases.push({ accountId: owner.accountId, requestKey: src.requestKey, requestHash: ident.requestHash, rowCount: rows.length });
    }
  }
  return summary;
}
