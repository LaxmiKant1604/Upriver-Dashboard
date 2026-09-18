// Advanced Listing Health v3 -- READ-ONLY preview serve (Phase 3). ZERO DataDoe exports, ZERO production writes.
//
// Assembles the advanced Listing Health payload from ALREADY-SAVED evidence only:
//   - sales/units: DURABLE enriched Order Line Items (getEnrichedOli) for the requested inclusive window, plus the
//     account's OLI coverage windows + completeness rows (honest Covered/Partial/Unavailable);
//   - identity: the DURABLE org Product Catalog snapshot;
//   - status/price/fulfilment/FBM + On-Hand FBA + issues: the LATEST SAVED source rows in source_export_cache
//     (cache-only reads keyed by the v3 request_hash -- inventory reuses the fba-plan:inventory-health identity;
//     a cache MISS never triggers an export -- the dimension is honestly Unavailable).
// The window changes ONLY the OLI sales/units; status/issues/inventory always use the latest saved snapshot.
// Account + marketplace identity are PINNED by the caller (owner from server-resolved accountScope); buildAdvanced-
// ListingHealth re-asserts the trusted-owner projection boundary so no cross-account row can appear. No snapshot is
// written -- this is a live derivation from durable/saved evidence, returned directly.

import { buildAdvancedListingHealth, resolveListingHealthWindow } from "./listing-health-advanced.js";
import { listingHealthV3PerAccountReadHashes } from "../sync/listing-health-v3-materialize.js";
import { organizationFingerprint as orgFingerprintOf } from "../source-identity.js";
import { getEnrichedOliHistoryRows } from "../sync/oli-enriched-history.js";
import { getSourceCoverageWindows, getOliCompleteness, getSourceSnapshot, getSourceSnapshotPayload, getSourceExportCache } from "../supabase.js";

const S = (v) => (v == null ? "" : String(v));

// Production READ-ONLY default readers (all Supabase/durable reads; NEVER a DataDoe export). Overridable for tests.
const defaultCatalogReader = async ({ organizationFingerprint, connectionId }) => {
  const res = await getSourceSnapshot({ organizationFingerprint, connectionId, sourceKey: "product-catalog", scopeKey: "__organization" });
  const snapshot = res && res.snapshot;
  if (!snapshot || !snapshot.object_path) return [];
  const payload = await getSourceSnapshotPayload(snapshot.object_path);
  return Array.isArray(payload && payload.rows) ? payload.rows : [];
};
// Cache-ONLY read (getSourceExportCache returns only UNEXPIRED entries and hydrates rows); a miss returns null and is
// NEVER answered by creating an export. Returns { rows, fetchedAt } so the caller can surface the snapshot's honest
// as-of date (the UI shows it per row and can label stale evidence). Never triggers a fetch.
const defaultSavedSourceReader = async (requestHash) => {
  const e = await getSourceExportCache(requestHash);
  if (!e || !Array.isArray(e.rows)) return null;
  const meta = e.request_meta && typeof e.request_meta === "object" ? e.request_meta : {};
  return {
    rows: e.rows,
    fetchedAt: e.fetched_at || null,                          // when the per-account fragment was materialized (saved time)
    effectiveAt: meta.batchFetchedAt || e.fetched_at || null, // the batch's real DataDoe download time (truer data as-of)
    sourceType: e.source_id || null,                          // the source type (e.g. the listings/raw/inventory source id)
  };
};

/**
 * Serve the v3 preview payload for ONE pinned account + window from durable/saved evidence. Pure orchestration over
 * INJECTED read-only readers (production defaults are wired by api/datadoe.js). Never writes, never exports.
 *
 * owner            : { accountId (public), rawSellerId (raw, server-resolved), marketplace }
 * identity         : { apiKey, organizationFingerprint, connectionId }
 * windowControls   : { preset, from, to, month } (from the request; validated here)
 * asOf             : the report as-of (account/marketplace date; server-supplied, never the browser clock beyond `to`)
 * readers          : { getEnrichedOli, getOliCoverage, getCompleteness, getCatalog, getSavedSourceRows }
 */
export async function serveListingHealthV3Preview({ owner, identity, windowControls = {}, asOf, readers = {} }) {
  if (!owner || S(owner.rawSellerId).trim() === "" || S(owner.accountId).trim() === "") {
    throw new Error("serveListingHealthV3Preview requires a server-pinned owner { accountId, rawSellerId } (fail closed).");
  }
  const getEnrichedOli = readers.getEnrichedOli || getEnrichedOliHistoryRows;
  const getOliCoverage = readers.getOliCoverage || getSourceCoverageWindows;
  const getCompleteness = readers.getCompleteness || getOliCompleteness;
  const getCatalog = readers.getCatalog || defaultCatalogReader;
  const getSavedSourceRows = readers.getSavedSourceRows || defaultSavedSourceReader;
  // Window (throws typed on an invalid/reversed/future control -> the caller maps it to 400).
  const window = resolveListingHealthWindow({ preset: windowControls.preset, from: windowControls.from, to: windowControls.to, month: windowControls.month, asOf });
  const accountId = S(owner.accountId);
  const rawSellerId = S(owner.rawSellerId);
  const org = (identity && identity.organizationFingerprint) || orgFingerprintOf(identity && identity.apiKey);
  const connectionId = (identity && identity.connectionId) || "primary";

  // 1) DURABLE enriched OLI for the window + coverage + completeness (never an export). A read failure => throw
  //    (caller returns unavailable/LKG-safe error); an empty result is honest (payload reports unavailable/partial).
  const enrichedOliRows = await getEnrichedOli({ organizationFingerprint: org, connectionId, accountIds: [accountId], from: window.from, to: window.to });
  if (!Array.isArray(enrichedOliRows)) throw new Error("listing-health-v3 preview: durable OLI read returned no array (fail closed).");
  let oliCoverageWindows = [];
  try {
    const cov = await getOliCoverage({ organizationFingerprint: org, connectionId, accountId, sourceKey: "order-line-items" });
    const raw = cov && cov.read === "ok" ? (cov.windows || []) : (Array.isArray(cov) ? cov : []);
    oliCoverageWindows = raw.map((w) => ({ from: S(w.from ?? w.covered_from ?? w.coveredFrom), to: S(w.to ?? w.covered_to ?? w.coveredTo) })).filter((w) => /^\d{4}-\d{2}-\d{2}$/.test(w.from) && /^\d{4}-\d{2}-\d{2}$/.test(w.to));
  } catch (_e) { oliCoverageWindows = []; }
  let completenessRows = [];
  try { const c = await getCompleteness({ organizationFingerprint: org, connectionId, accountIds: [accountId], from: window.from, to: window.to }); completenessRows = Array.isArray(c) ? c : []; } catch (_e) { completenessRows = []; }

  // 2) DURABLE org Product Catalog snapshot (identity only; org-wide rows never prove account ownership).
  let catalogRows = [];
  try { const cat = await getCatalog({ organizationFingerprint: org, connectionId }); catalogRows = Array.isArray(cat) ? cat : []; } catch (_e) { catalogRows = []; }

  // 3) LATEST SAVED listings / inventory / listings-raw via the PER-ACCOUNT read identities (cache-only; NO create).
  //    These date-free single-seller identities are byte-identical to what the scheduler ingestion writes when it
  //    splits each <=5-seller batch export back per account (see listing-health-v3-materialize.js). A cache MISS
  //    means that per-account fragment has not been materialized yet -> the dimension is honestly Unavailable.
  const readHashes = listingHealthV3PerAccountReadHashes({ apiKey: identity && identity.apiKey, rawSellerId, marketplaceCountry: owner.marketplace || null });
  const hashOf = (rk) => readHashes[rk] || null;
  // Capture each saved fragment's provenance (source type + saved time + truer effective/as-of) alongside its rows.
  // Accepts BOTH an injected reader that returns a plain array (no metadata) and the production { rows, fetchedAt,
  // effectiveAt, sourceType } shape -- never fabricates a date.
  const savedMeta = {};
  const readSaved = async (rk) => {
    const h = hashOf(rk); if (!h || typeof getSavedSourceRows !== "function") return null;
    try {
      const res = await getSavedSourceRows(h);
      if (Array.isArray(res)) return res;
      if (res && Array.isArray(res.rows)) {
        savedMeta[rk] = {
          fetchedAt: res.fetchedAt || res.fetched_at || null,
          effectiveAt: res.effectiveAt || res.fetchedAt || res.fetched_at || null,
          sourceType: res.sourceType || res.source_id || null,
        };
        return res.rows;
      }
      return null;
    } catch (_e) { return null; }
  };
  const listingRows = await readSaved("listing-health-v3:listings");
  const inventoryRows = await readSaved("listing-health-v3:inventory");
  const rawRows = await readSaved("listing-health-v3:listings-raw");
  const metaOf = (rk) => savedMeta[rk] || {};

  // OPERATIONAL LOGGING (observable in server logs; NEVER a write/export). Records which dimensions are Unavailable for
  // this owner so missing-source evidence is inspectable. Best-effort: a logging failure never affects the response.
  try {
    // Availability is the actual hydrated rows (Array.isArray), NOT savedMeta presence -- an injected plain-array
    // reader (tests) has no savedMeta yet still has rows, so keying off savedMeta would falsely log everything missing.
    const missing = [["listing-health-v3:listings", listingRows], ["listing-health-v3:listings-raw", rawRows], ["listing-health-v3:inventory", inventoryRows]]
      .filter(([, v]) => !Array.isArray(v)).map(([rk]) => rk);
    if (missing.length && typeof console !== "undefined" && console.warn) {
      console.warn(JSON.stringify({ evt: "lhv3.serve.unavailable_fragments", accountId, marketplace: owner.marketplace || null, missing }));
    }
  } catch (_e) { /* logging is best-effort */ }

  const issuesAvailable = Array.isArray(rawRows);
  const payload = buildAdvancedListingHealth({
    // Forward the caller-resolved canonical marketplace so buildAdvancedListingHealth's ownership boundary rejects any
    // cross-marketplace row (defence-in-depth). Null when the caller did not resolve it -> the assert stays fail-open.
    owner: { accountId, rawSellerId, marketplace: owner.marketplace || null },
    asOf, window,
    enrichedOliRows, oliCoverageWindows, completenessRows,
    listingRows: Array.isArray(listingRows) ? listingRows : [],
    inventoryRows: Array.isArray(inventoryRows) ? inventoryRows : [],
    catalogRows,
    rawRows: Array.isArray(rawRows) ? rawRows : [],
    issuesAvailable,
    issuesUnavailableReason: issuesAvailable ? null : "Listings (Raw JSON) evidence is not yet saved for this account (populated when v3 ingestion is scheduled).",
    // Honest per-fragment provenance so the read-only UI shows each row's evidence source + as-of and labels stale
    // evidence. `*FetchedAt` is the truer EFFECTIVE date (the batch's real download time, batchFetchedAt) falling back
    // to the materialization time; `*SavedAt` is the materialization time; `*SourceType` is the source id. Null when
    // the dimension is Unavailable -- never a fabricated date.
    provenance: {
      listingsFetchedAt: metaOf("listing-health-v3:listings").effectiveAt || null,
      inventoryFetchedAt: metaOf("listing-health-v3:inventory").effectiveAt || null,
      rawFetchedAt: metaOf("listing-health-v3:listings-raw").effectiveAt || null,
      listingsSavedAt: metaOf("listing-health-v3:listings").fetchedAt || null,
      inventorySavedAt: metaOf("listing-health-v3:inventory").fetchedAt || null,
      rawSavedAt: metaOf("listing-health-v3:listings-raw").fetchedAt || null,
      listingsSourceType: metaOf("listing-health-v3:listings").sourceType || null,
      inventorySourceType: metaOf("listing-health-v3:inventory").sourceType || null,
      rawSourceType: metaOf("listing-health-v3:listings-raw").sourceType || null,
    },
  });

  // Preview provenance so the read-only UI can render honest Available/Unavailable states for each dimension.
  return {
    ...payload,
    preview: true,
    evidence: {
      salesSource: "order-line-items (durable)",
      listingsEvidenceAvailable: Array.isArray(listingRows),
      inventoryEvidenceAvailable: Array.isArray(inventoryRows),
      issuesEvidenceAvailable: issuesAvailable,
      listingsUnavailableReason: Array.isArray(listingRows) ? null : "No saved Listings snapshot for this account yet (read-only preview creates no export; populated when v3 ingestion is scheduled).",
    },
  };
}
