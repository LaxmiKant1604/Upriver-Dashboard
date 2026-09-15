// Scheduler v2 -- Advanced Listing Health (SHADOW) durable OLI + Catalog derived-context loader.
//
// The report worker's `loadDerivedContext` for listing-health-v3. Sales/units are a DERIVED durable dependency
// (REPORT_DERIVED_SOURCE_KEYS["listing-health-v3"] = order-line-items + product-catalog): instead of owning a
// Profit-by-SKU / OLI export, v3 reads the ALREADY-persisted ENRICHED durable OLI (source_oli_daily_history +
// operational units + estimates -- via the established production wrapper getEnrichedOliHistoryRows) for the requested
// INCLUSIVE window, plus the account's proven coverage windows + completeness rows, plus the canonical org Product
// Catalog snapshot. So selecting a 7D/14D/30D/MONTH/CUSTOM window re-aggregates stored rows and spends ZERO tokens.
//
// KEY DIFFERENCE from fba-plan's loader: v3 does NOT fail closed on PARTIAL coverage. Partial/absent coverage is
// carried through honestly (coverageWindows) so buildAdvancedListingHealth reports salesWindowStatus
// covered/partial/unavailable -- it never fabricates a proven zero. It fails closed (returns {}) only when a durable
// READ itself fails (a DB error must never masquerade as "no sales"), preserving last-known-good.
//
// All I/O is injected (offline-testable, ZERO DataDoe). This loader is NOT wired into any active dispatch: v3 is
// dormant. It is exercised by the shadow build/verify path and its unit test.

import { resolveDataDoeAccountIds } from "../datadoe-connections.js";
import { organizationFingerprint as organizationFingerprintOf } from "../source-identity.js";
import { resolveListingHealthWindow } from "../reports/listing-health-advanced.js";
import { getEnrichedOliHistoryRows } from "./oli-enriched-history.js";
import { getSourceCoverageWindows, getOliCompleteness } from "../supabase.js";
import { isValidRfc3339Timestamp } from "../rfc3339-timestamp.js";

const S = (v) => (v == null ? "" : String(v));
const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const OLI_SOURCE_KEY = "order-line-items";
const CATALOG_SOURCE_KEY = "product-catalog";
const ORGANIZATION_SCOPE_KEY = "__organization";

function durableConnectionId(connection) {
  return connection && connection.id === "secondary" ? "dd-secondary" : "primary";
}

// Normalize source_coverage rows to [{from,to}] (covered_from/covered_to -> from/to), keeping only real dates.
export function normalizeCoverageWindows(windows) {
  return (Array.isArray(windows) ? windows : [])
    .map((w) => ({ from: S(w && (w.from ?? w.covered_from ?? w.coveredFrom)), to: S(w && (w.to ?? w.covered_to ?? w.coveredTo)) }))
    .filter((w) => isDate(w.from) && isDate(w.to) && w.from <= w.to);
}

/**
 * Make the report-worker `loadDerivedContext` callback for listing-health-v3. For every OTHER report key it returns {}.
 * For listing-health-v3 it resolves the authoritative durable identity (org fingerprint + connection + raw seller id)
 * from account metadata, resolves the requested inclusive window from the planned context controls, and reads:
 *   - ENRICHED durable OLI rows for [window.from, window.to] (getEnrichedOli, default getEnrichedOliHistoryRows);
 *   - the account's OLI coverage windows (getOliCoverage) -- carried through (NOT a fail-closed gate);
 *   - the account's OLI completeness rows for the window (getCompleteness);
 *   - the org Product Catalog snapshot (getCatalogSnapshot + loadCatalogPayload, injected like fba-plan's loader).
 * Returns { listingHealthV3DurableOli, listingHealthV3DurableCatalog }. A durable READ FAILURE fails closed (returns
 * {} for OLI, or omits catalog) so the derive preserves last-known-good rather than fabricating a zero.
 */
export function makeListingHealthV3DurableContextLoader({
  connections,
  getEnrichedOli = getEnrichedOliHistoryRows,
  getOliCoverage = getSourceCoverageWindows,
  getCompleteness = getOliCompleteness,
  getCatalogSnapshot,
  loadCatalogPayload,
  // STRICT reconciler mode (WORK C/D blockers 3 + 4; default OFF -> preview/shadow behavior byte-unchanged): a durable
  // READ FAILURE (throw / typed read!=ok) on OLI coverage OR completeness returns {} (the derive/bundle then DEFERS,
  // preserving valid live LKG) instead of degrading to []; a genuine successful EMPTY set stays honest. The Catalog is
  // additionally integrity-checked (payload_sha embedded in the recomputed object-path namespace + rows.length===
  // row_count); a mandatory-catalog integrity failure returns {} (defer). `buildObjectPath` (= sourceSnapshotObjectPath)
  // is required for the strict catalog namespace recompute.
  strict = false,
  buildObjectPath = null,
} = {}) {
  return async ({ reportKey, accountId, planned, signal = null }) => {
    if (reportKey !== "listing-health-v3") return {};
    const context = (planned && planned.context) || {};
    const asOf = context.to != null ? String(context.to) : "";
    if (!isDate(asOf)) return {}; // no authoritative asOf -> derive fails closed

    let resolved;
    try { resolved = resolveDataDoeAccountIds([accountId], connections); } catch (_e) { return {}; }
    if (!resolved || resolved.rawAccountIds.length !== 1) return {};
    const rawSellerId = S(resolved.rawAccountIds[0]);
    const connectionId = durableConnectionId(resolved.connection);
    const orgFingerprint = resolved.connection && resolved.connection.organizationFingerprint
      ? resolved.connection.organizationFingerprint
      : organizationFingerprintOf(resolved.connection && resolved.connection.apiKey);
    if (!orgFingerprint) return {};

    // The requested inclusive window (only an omitted control uses the 30D default; an invalid supplied control throws
    // in resolveListingHealthWindow -> caught here -> {} -> derive fails closed).
    let win;
    try {
      win = resolveListingHealthWindow({ preset: context.windowPreset, from: context.windowFrom, to: context.windowTo, month: context.windowMonth, asOf });
    } catch (_e) { return {}; }

    // 1) ENRICHED durable OLI for the window (established production wrapper). A READ FAILURE fails closed (LKG); an
    //    empty result is honest evidence (payload reports unavailable/partial, never a fabricated proven zero).
    let rows;
    try {
      rows = await getEnrichedOli({ organizationFingerprint: orgFingerprint, connectionId, accountIds: [S(accountId)], from: win.from, to: win.to, signal });
    } catch (_e) { return {}; }
    if (!Array.isArray(rows)) return {};

    // 2) Coverage windows -- carried through for honest covered/partial/unavailable reporting. A read failure fails
    //    closed (we must not present rows as fully covered when coverage is unknown).
    let coverageWindows;
    try {
      const cov = await getOliCoverage({ organizationFingerprint: orgFingerprint, connectionId, accountId: S(accountId), sourceKey: OLI_SOURCE_KEY, signal });
      // STRICT (reconciler): a typed read failure (read!=ok) is a READ FAILURE, not "no coverage" -> defer (never
      // degrade valid live LKG by presenting rows as uncovered when coverage is merely unreadable).
      if (strict && cov && typeof cov === "object" && "read" in cov && cov.read !== "ok") return {};
      const raw = cov && cov.read === "ok" ? (cov.windows || []) : (Array.isArray(cov) ? cov : []);
      coverageWindows = normalizeCoverageWindows(raw);
    } catch (_e) { return {}; }

    // 3) Completeness rows for the window (provisional/final). PREVIEW: a read failure degrades to [] (advisory).
    //    STRICT (reconciler): a read THROW or a non-array response is a READ FAILURE -> defer (never degrade a valid
    //    live payload to "provisional/unknown"); a genuine successful empty array stays honest.
    let completenessRows = [];
    try {
      const comp = await getCompleteness({ organizationFingerprint: orgFingerprint, connectionId, accountIds: [S(accountId)], from: win.from, to: win.to }, { signal });
      if (strict && !Array.isArray(comp)) return {};
      completenessRows = Array.isArray(comp) ? comp : [];
    } catch (_e) { if (strict) return {}; completenessRows = []; }

    const listingHealthV3DurableOli = { available: true, rows, coverageWindows, completenessRows };

    // 4) Org Product Catalog snapshot (reused canonical evidence, never a new export). Unreadable/missing catalog ->
    //    omit it so the derive blocks on the missing catalog (fail closed, LKG preserved).
    if (typeof getCatalogSnapshot !== "function" || typeof loadCatalogPayload !== "function") {
      return { listingHealthV3DurableOli };
    }
    let catRead;
    try {
      catRead = await getCatalogSnapshot({ organizationFingerprint: orgFingerprint, connectionId, sourceKey: CATALOG_SOURCE_KEY, scopeKey: ORGANIZATION_SCOPE_KEY, signal });
    } catch (_e) { return { listingHealthV3DurableOli }; }
    const catalogSnapshot = catRead && typeof catRead === "object" && "snapshot" in catRead ? catRead.snapshot : catRead;
    const catalogReadOk = !catRead || typeof catRead !== "object" || !("read" in catRead) || catRead.read === "ok";
    // STRICT (reconciler): a typed catalog read failure DEFERS (mandatory catalog; return {} not "omit catalog then
    // degrade"). PREVIEW: unreadable/missing catalog -> omit (the derive blocks on the missing catalog).
    if (strict && catRead && typeof catRead === "object" && "read" in catRead && catRead.read !== "ok") return {};
    if (!catalogReadOk || !catalogSnapshot || !catalogSnapshot.object_path) return { listingHealthV3DurableOli };
    // STRICT: FULL Catalog pointer integrity (blockers 2 + 4) -- FAIL CLOSED (return {} -> the dependency bundle DEFERS
    // before cycle open or any shadow/live write; LKG preserved). The snapshot must echo the EXACT expected identity
    // (organization_fingerprint + connection_id + source_key=product-catalog + scope_key=__organization), carry a
    // nonblank source_request_hash + payload_sha and a REAL validated_at timestamp, declare a FINITE INTEGER row_count
    // >= 0, and its object_path must embed the declared payload_sha AND equal the recomputed content-addressed
    // namespace path (getSourceSnapshotPayload additionally recomputes the content-address sha on hydrate). row_count
    // is required valid FIRST -- a missing / null / malformed / negative / non-integer row_count is itself a failure,
    // never skipped (the earlier code fail-OPEN when row_count was not an integer). A zero-row Catalog with an
    // otherwise-valid pointer is honest evidence and passes (row_count 0 === hydrated rows.length 0).
    if (strict) {
      const cat = catalogSnapshot;
      const catSha = S(cat.payload_sha);
      if (typeof buildObjectPath !== "function") return {}; // cannot verify the namespace path -> defer (fail closed)
      // Cheap identity + row_count + sha + validated_at checks FIRST (this includes catSha nonblank, so the namespace
      // recompute below never receives a blank sha -- sourceSnapshotObjectPath fails closed on a blank sha). row_count
      // MUST be an ACTUAL JavaScript number (a SAFE non-negative integer) -- NEVER a coerced string/null/boolean/array/
      // object. Number(null)=0, Number("")=0, Number(false)=0, Number("0")=0, Number(true)=1, Number("2")=2 previously
      // FAIL-OPEN whenever the hydrated count happened to match the coerced value; typeof + Number.isSafeInteger reject
      // every non-number. validated_at is validated by the strict RFC3339 validator (not a loose Date.parse).
      if (S(cat.organization_fingerprint) !== S(orgFingerprint)
        || S(cat.connection_id) !== S(connectionId)
        || S(cat.source_key) !== CATALOG_SOURCE_KEY
        || S(cat.scope_key) !== ORGANIZATION_SCOPE_KEY
        || S(cat.source_request_hash).trim() === ""
        || catSha.trim() === ""
        || !isValidRfc3339Timestamp(cat.validated_at)
        || typeof cat.row_count !== "number" || !Number.isSafeInteger(cat.row_count) || cat.row_count < 0
        || !S(cat.object_path).endsWith("/" + catSha + ".json")) return {};
      // catSha is nonblank and the path embeds it -> recompute the content-addressed namespace path and require an
      // EXACT match (a valid-looking pointer in a DIFFERENT org/conn/source/scope namespace is rejected here).
      if (S(cat.object_path) !== buildObjectPath({ organizationFingerprint: orgFingerprint, connectionId, sourceKey: CATALOG_SOURCE_KEY, scopeKey: ORGANIZATION_SCOPE_KEY, payloadSha: catSha })) return {};
    }
    let catalogRows = [];
    {
      let hydrated;
      try {
        hydrated = await loadCatalogPayload(catalogSnapshot.object_path, { signal });
      } catch (_e) { if (strict) return {}; return { listingHealthV3DurableOli }; }
      if (strict) {
        // STRICT: the hydrated payload MUST contain an ACTUAL rows array (an array payload, or { rows: [...] }). A
        // missing / non-array rows property DEFERS -- INCLUDING when row_count is 0 -- so a malformed payload ({},
        // { rows: "bad" }) can never masquerade as a valid zero-row Catalog. Then rows.length must EXACTLY equal the
        // (already-validated real-number) declared row_count.
        const rows = Array.isArray(hydrated) ? hydrated : (hydrated && typeof hydrated === "object" && Array.isArray(hydrated.rows) ? hydrated.rows : null);
        if (rows === null || rows.length !== catalogSnapshot.row_count) return {};
        catalogRows = rows;
      } else {
        // PREVIEW (non-strict): byte-for-byte UNCHANGED -- a non-array payload degrades to [].
        catalogRows = Array.isArray(hydrated) ? hydrated : (hydrated && Array.isArray(hydrated.rows) ? hydrated.rows : []);
      }
    }

    // Surface the catalog's content-addressed payload_sha + validated_at so the dependency-bundle fingerprint can fold
    // the exact catalog content identity (WORK C/D blocker 1); additive -- the derive ignores these extra fields.
    return { listingHealthV3DurableOli, listingHealthV3DurableCatalog: { available: true, rows: catalogRows, payloadSha: S(catalogSnapshot.payload_sha), validatedAt: catalogSnapshot.validated_at || null } };
  };
}
