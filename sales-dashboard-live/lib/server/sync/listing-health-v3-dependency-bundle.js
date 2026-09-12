// The COMPLETE dependency manifest + fingerprint for listing-health-v3 (WORK C/D correction, blockers 1 + 3). ONE
// shared resolver used by BOTH the reconciler scope-scan AND the release-boundary recompute, so the revision identity
// is the EXACT evidence the derive consumes -- not a "latest" timestamp.
//
// listing-health-v3's payload depends on: the durable Listings + Listings-Raw pointers (content-addressed payload_sha),
// the exact 30-day enriched OLI rows + coverage windows + completeness rows, the org Product Catalog snapshot
// (content-addressed payload_sha), and the OPTIONAL FBA inventory (proven-D-1, or an explicit stable UNAVAILABLE
// identity). fingerprintListingHealthV3Bundle folds ALL of them, so a Listings/Raw same-date correction, an OLI
// row/estimate/coverage/completeness correction, a Catalog content change, or an FBA available<->unavailable /
// date-advance / same-date correction each yields a DIFFERENT revisionId + manifest token -> revisionCoveredByJob
// (publication-binding.js) sees STALE -> re-derive; an UNCHANGED manifest converges to a zero-write no-op.
//
// The resolver is FAIL-CLOSED: any missing / unreadable / malformed / cross-account / cross-marketplace / wrong-source /
// wrong-path / SHA-mismatch / row-count-mismatch / not-D-1 mandatory evidence returns { eligible:false } (defer, LKG
// preserved). Optional FBA absence is the stable UNAVAILABLE identity, NOT an error. Every read is injected (offline-
// testable) + AbortSignal-threaded; ZERO provider export. 7-bit ASCII, LF.

import { createHash } from "node:crypto";
import { LISTINGS_SOURCE_KEY, LISTINGS_RAW_SOURCE_KEY } from "./source-durable-model.js";

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";
const US = ""; // unit separator (field)
const RS = ""; // record separator (row)
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MKT_RE = /^[A-Z]{2}$/;

export const LISTING_HEALTH_V3_BUNDLE_STATUS = Object.freeze({ AVAILABLE: "available", PROVEN_EMPTY: "proven-empty", MISSING: "missing" });

// Canonical numeric normalization: round to 4 dp then a stable decimal string, so summed-float noise
// (sales_amount / estimates) never churns the digest; non-finite -> a stable sentinel.
function canonNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "NaN";
  return (Math.round(n * 10000) / 10000).toFixed(4);
}
function sha(input) { return createHash("sha256").update(input).digest("hex"); }

// ---- Deterministic content digests over the EXACT evidence the derive consumes ----------------------------------

// The 30D enriched OLI rows: fold ONLY the value fields foldOliWindowSales consumes (sale_date, account, sku,
// child_asin, currency, sales_amount, ordered_units||units, unpriced_units). Sorted total order -> order-independent.
export function oliRowsDigest(rows) {
  const list = (Array.isArray(rows) ? rows : []).map((r) => [
    S(r && r.sale_date), S(r && r.account_id), S(r && r.sku), S(r && r.child_asin), S(r && r.currency),
    canonNum(r && r.sales_amount), canonNum(r && (r.ordered_units != null ? r.ordered_units : r.units)), canonNum(r && r.unpriced_units),
  ].join(US)).sort();
  return sha("oli-rows" + list.join(RS));
}

// OLI coverage windows (normalized {from,to}); any covered-range change flips assessOliCoverage.
export function oliCoverageDigest(windows) {
  const list = (Array.isArray(windows) ? windows : []).map((w) => S(w && w.from) + US + S(w && w.to)).sort();
  return sha("oli-coverage" + list.join(RS));
}

// OLI completeness rows: fold ONLY the fields windowCompleteness/summarizeCompleteness consume (sale_date, bucket,
// completeness_status, the counts, itemization_percent, defect_count). EXCLUDE refreshed_at / requested_as_of /
// proven_export_through (wall-clock / derivation-window metadata the fold never reads) so a re-summarize never churns.
export function oliCompletenessDigest(rows) {
  const list = (Array.isArray(rows) ? rows : []).map((r) => [
    S(r && r.sale_date), S(r && r.account_id), S(r && r.bucket), S(r && r.completeness_status),
    canonNum(r && r.itemized_order_count), canonNum(r && r.pending_order_count),
    canonNum(r && r.itemized_unit_count), canonNum(r && r.pending_unit_count),
    canonNum(r && r.defect_count), canonNum(r && r.itemization_percent),
  ].join(US)).sort();
  return sha("oli-completeness" + list.join(RS));
}

// The FBA inventory identity: proven-D-1 -> request_hash + payload_sha; absent/older/other-day/empty -> a stable
// UNAVAILABLE sentinel. available<->unavailable, a date advance, and a same-date content correction all change it.
export function inventoryFingerprintToken({ accountId, connectionId, requestedAsOf, available, sourceRequestHash, payloadSha } = {}) {
  const base = "fba-inventory|" + S(accountId) + "|" + S(connectionId) + "|" + S(requestedAsOf) + "|";
  return available === true ? base + S(sourceRequestHash) + "|" + S(payloadSha) : base + "UNAVAILABLE";
}

/**
 * The PURE canonical fingerprint over a resolved bundle's content components. Deterministic; changes iff ANY selected
 * input that can change the payload changes. Returns { revisionId:<32 hex>, status, manifestToken }.
 * manifestToken is the SINGLE self-describing content-dep the reconciler records in the report job's
 * durable_content_deps (revisionCoveredByJob subset-checks it), embedding the full fingerprint.
 */
export function fingerprintListingHealthV3Bundle({
  organizationFingerprint, connectionId, accountId, marketplace, requestedAsOf,
  listings, listingsRaw, catalogPayloadSha, inventoryToken, oliDigests, status,
} = {}) {
  const fp = sha([
    "lhv3-dep-v1",
    S(organizationFingerprint), S(connectionId), S(accountId), S(marketplace), S(requestedAsOf), S(status),
    "L", S(listings && listings.sourceRequestHash), S(listings && listings.payloadSha), S(listings && listings.asOf),
    "R", S(listingsRaw && listingsRaw.sourceRequestHash), S(listingsRaw && listingsRaw.payloadSha), S(listingsRaw && listingsRaw.asOf),
    "C", S(catalogPayloadSha),
    "I", S(inventoryToken),
    "O", S(oliDigests && oliDigests.rows), S(oliDigests && oliDigests.coverage), S(oliDigests && oliDigests.completeness),
  ].join("|")).slice(0, 32);
  const manifestToken = "listing-health-v3-manifest|" + S(organizationFingerprint) + "|" + S(connectionId) + "|" + S(accountId) + "|" + S(requestedAsOf) + "|" + fp;
  return { revisionId: fp, status, manifestToken };
}

// ---- PURE pointer integrity (blocker 3): validate ONE Listings/Listings-Raw pointer against the expected identity.
// Returns { ok:true } or { ok:false, reason }. `expectedObjectPath` is the injected recompute of sourceSnapshotObjectPath
// from (org, durableConn, sourceKey, accountId, payload_sha) -- proves the object belongs to the expected namespace.
export function validateListingsPointer({ snapshot, expectedOrg, durableConn, sourceKey, accountId, marketplace, requestedAsOf, expectedObjectPath } = {}) {
  if (!snapshot || typeof snapshot !== "object") return { ok: false, reason: "no-durable-snapshot" };
  if (S(snapshot.organization_fingerprint) !== S(expectedOrg)) return { ok: false, reason: "org-mismatch" };
  if (S(snapshot.connection_id) !== S(durableConn) || (durableConn !== "primary" && durableConn !== "dd-secondary")) return { ok: false, reason: "connection-mismatch" };
  if (S(snapshot.account_id) !== S(accountId)) return { ok: false, reason: "account-mismatch" };
  if (!MKT_RE.test(S(snapshot.marketplace)) || S(snapshot.marketplace) !== S(marketplace)) return { ok: false, reason: "marketplace-mismatch" };
  if (S(snapshot.source_key) !== S(sourceKey)) return { ok: false, reason: "source-key-mismatch" };
  if (!DATE_RE.test(S(snapshot.as_of)) || S(snapshot.as_of) !== S(requestedAsOf)) return { ok: false, reason: "not-d1" };
  if (!nb(snapshot.validated_at)) return { ok: false, reason: "validated-at-blank" };
  if (!nb(snapshot.source_request_hash)) return { ok: false, reason: "request-hash-blank" };
  const sha256Hex = S(snapshot.payload_sha);
  if (!nb(sha256Hex)) return { ok: false, reason: "payload-sha-blank" };
  const rc = Number(snapshot.row_count);
  if (!Number.isFinite(rc) || !Number.isInteger(rc) || rc < 0) return { ok: false, reason: "row-count-invalid" };
  const path = S(snapshot.object_path);
  if (!path.endsWith("/" + sha256Hex + ".json")) return { ok: false, reason: "path-sha-mismatch" };
  if (S(expectedObjectPath) !== path) return { ok: false, reason: "path-namespace-mismatch" };
  return { ok: true };
}

const rowsOf = (payload) => (Array.isArray(payload) ? payload : (payload && Array.isArray(payload.rows) ? payload.rows : null));

/**
 * Resolve + integrity-validate the COMPLETE dependency bundle for ONE account, and compute its fingerprint. Every read
 * is injected + { signal }-threaded. Returns:
 *   { eligible:true, status, revisionId, deps:[], contentDeps:[manifestToken], bundle:{ listingsRows, rawRows,
 *     inventorySource, context } }   when every mandatory input is proven,
 *   { eligible:false, status:MISSING, revisionId:null, deps:[], contentDeps:[], reason }   otherwise (defer, LKG kept).
 *
 * deps (injected): readListingsSnapshot, readListingsRawSnapshot, readInventorySnapshot, loadSnapshotPayload,
 *   resolveExpectedInventoryRequestHash, loadDurableContext, buildObjectPath (= sourceSnapshotObjectPath).
 * args: { organizationFingerprint, connectionId, accountId, marketplace, rawSellerId, requestedAsOf, signal }.
 */
export async function resolveListingHealthV3DependencyBundle(deps = {}, args = {}) {
  const { readListingsSnapshot, readListingsRawSnapshot, readInventorySnapshot, loadSnapshotPayload, resolveExpectedInventoryRequestHash, loadDurableContext, buildObjectPath } = deps;
  const { organizationFingerprint, connectionId = "primary", accountId, marketplace, rawSellerId, requestedAsOf, signal = null } = args;
  const miss = (reason) => ({ eligible: false, status: LISTING_HEALTH_V3_BUNDLE_STATUS.MISSING, revisionId: null, deps: [], contentDeps: [], reason });
  const aborted = () => !!(signal && signal.aborted);
  for (const [n, f] of [["readListingsSnapshot", readListingsSnapshot], ["readListingsRawSnapshot", readListingsRawSnapshot], ["readInventorySnapshot", readInventorySnapshot], ["loadSnapshotPayload", loadSnapshotPayload], ["resolveExpectedInventoryRequestHash", resolveExpectedInventoryRequestHash], ["loadDurableContext", loadDurableContext], ["buildObjectPath", buildObjectPath]]) {
    if (typeof f !== "function") throw new Error("resolveListingHealthV3DependencyBundle requires " + n + " (fail closed).");
  }
  if (!nb(organizationFingerprint) || !nb(accountId) || !DATE_RE.test(S(requestedAsOf)) || !MKT_RE.test(S(marketplace)) || !nb(rawSellerId)) return miss("incomplete-account-boundary");
  if (aborted()) return miss("aborted");

  // --- Listings + Listings-Raw pointers: read, full integrity, storage-first hydrate, rows.length===row_count. ---
  async function proveAndHydrate(reader, sourceKey) {
    let res;
    try { res = await reader({ organizationFingerprint, connectionId, accountId, signal }); }
    catch (e) { return { reason: sourceKey + "-read-threw:" + S(e && e.message) }; }
    if (aborted()) return { reason: "aborted" };
    const snapshot = res && res.read === "ok" ? (res.snapshot || null) : null;
    const expectedObjectPath = snapshot ? buildObjectPath({ organizationFingerprint, connectionId, sourceKey, scopeKey: accountId, payloadSha: S(snapshot.payload_sha) }) : "";
    const v = validateListingsPointer({ snapshot, expectedOrg: organizationFingerprint, durableConn: connectionId, sourceKey, accountId, marketplace, requestedAsOf, expectedObjectPath });
    if (!v.ok) return { reason: sourceKey + "-" + v.reason };
    let rows;
    try { rows = rowsOf(await loadSnapshotPayload(S(snapshot.object_path), { signal })); }
    catch (e) { return { reason: sourceKey + "-payload-unreadable:" + S(e && e.message) }; }
    if (aborted()) return { reason: "aborted" };
    if (!Array.isArray(rows)) return { reason: sourceKey + "-payload-dangling" };
    if (rows.length !== Number(snapshot.row_count)) return { reason: sourceKey + "-row-count-mismatch" };
    return { snapshot, rows };
  }
  const l = await proveAndHydrate(readListingsSnapshot, LISTINGS_SOURCE_KEY);
  if (l.reason) return miss(l.reason);
  const r = await proveAndHydrate(readListingsRawSnapshot, LISTINGS_RAW_SOURCE_KEY);
  if (r.reason) return miss(r.reason);

  // --- OPTIONAL FBA inventory: proven-D-1 (recomputed request hash) with rows>0, else UNAVAILABLE sentinel. ---
  let inventorySource = { available: false };
  let inventorySnapshot = null;
  {
    let expected = "";
    try { expected = S(await resolveExpectedInventoryRequestHash({ accountId, requestedAsOf })); } catch { expected = ""; }
    if (aborted()) return miss("aborted");
    if (nb(expected)) {
      let invRes = null;
      try { invRes = await readInventorySnapshot({ organizationFingerprint, connectionId, accountId, signal }); } catch { invRes = null; }
      if (aborted()) return miss("aborted");
      const snap = invRes && invRes.read === "ok" ? (invRes.snapshot || null) : null;
      if (snap && S(snap.source_request_hash) === expected) {
        let invRows = null;
        try { invRows = rowsOf(await loadSnapshotPayload(S(snap.object_path), { signal })); } catch { invRows = null; }
        if (aborted()) return miss("aborted");
        const d1Rows = Array.isArray(invRows) ? invRows.filter((row) => row && S(row.date) === S(requestedAsOf)) : [];
        if (d1Rows.length > 0) {
          inventorySource = { available: true, rows: d1Rows, fragments: [{ requestKey: "listing-health-v3:inventory", from: requestedAsOf, to: requestedAsOf, sellerOrVendorIds: [rawSellerId], rows: d1Rows }], disabled: false, disabledPolicy: null, reason: null };
          inventorySnapshot = snap;
        }
      }
    }
  }
  const inventoryToken = inventoryFingerprintToken({ accountId, connectionId, requestedAsOf, available: inventorySource.available === true, sourceRequestHash: inventorySnapshot && inventorySnapshot.source_request_hash, payloadSha: inventorySnapshot && inventorySnapshot.payload_sha });

  // --- Durable OLI (rows+coverage+completeness) + Product Catalog (rows + payload_sha), via the SAME loader the
  //     shadow worker uses. Both are HARD-REQUIRED (the derive throws 'unavailable' without them). ---
  let durableCtx;
  try { durableCtx = await loadDurableContext({ reportKey: "listing-health-v3", accountId, planned: { context: { to: requestedAsOf } }, signal }); }
  catch (e) { return miss("durable-context-threw:" + S(e && e.message)); }
  if (aborted()) return miss("aborted");
  if (!durableCtx || typeof durableCtx !== "object") return miss("durable-context-unavailable");
  const durableOli = durableCtx.listingHealthV3DurableOli;
  const durableCatalog = durableCtx.listingHealthV3DurableCatalog;
  if (!durableOli || durableOli.available !== true || !Array.isArray(durableOli.rows)) return miss("durable-oli-unavailable");
  if (!durableCatalog || durableCatalog.available !== true || !Array.isArray(durableCatalog.rows)) return miss("durable-catalog-unavailable");
  if (!nb(durableCatalog.payloadSha)) return miss("durable-catalog-sha-missing");

  const oliDigests = {
    rows: oliRowsDigest(durableOli.rows),
    coverage: oliCoverageDigest(durableOli.coverageWindows),
    completeness: oliCompletenessDigest(durableOli.completenessRows),
  };
  const status = Number(l.snapshot.row_count) === 0 && Number(r.snapshot.row_count) === 0 ? LISTING_HEALTH_V3_BUNDLE_STATUS.PROVEN_EMPTY : LISTING_HEALTH_V3_BUNDLE_STATUS.AVAILABLE;
  const fp = fingerprintListingHealthV3Bundle({
    organizationFingerprint, connectionId, accountId, marketplace, requestedAsOf,
    listings: { sourceRequestHash: l.snapshot.source_request_hash, payloadSha: l.snapshot.payload_sha, asOf: l.snapshot.as_of },
    listingsRaw: { sourceRequestHash: r.snapshot.source_request_hash, payloadSha: r.snapshot.payload_sha, asOf: r.snapshot.as_of },
    catalogPayloadSha: durableCatalog.payloadSha, inventoryToken, oliDigests, status,
  });

  const context = {
    to: requestedAsOf, inventoryAsOf: requestedAsOf, accountId, rawSellerId,
    listingsFetchedAt: S(l.snapshot.validated_at) || null,
    rawFetchedAt: S(r.snapshot.validated_at) || null,
    inventoryFetchedAt: inventorySnapshot ? (S(inventorySnapshot.validated_at) || null) : null,
    catalogFetchedAt: S(durableCatalog.validatedAt) || null,
    listingHealthV3DurableOli: durableOli,
    listingHealthV3DurableCatalog: durableCatalog,
  };
  return {
    eligible: true, status, revisionId: fp.revisionId, deps: [], contentDeps: [fp.manifestToken],
    bundle: { listingsRows: l.rows, rawRows: r.rows, inventorySource, context, listingsSnapshot: l.snapshot, rawSnapshot: r.snapshot, inventorySnapshot },
  };
}
