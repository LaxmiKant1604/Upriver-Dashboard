// The COMPLETE dependency manifest + fingerprint for listing-health-v3 (WORK C/D corrections, blockers 1-4). ONE
// shared resolver used by BOTH the reconciler scope-scan AND the release-boundary recompute, so the revision identity
// is the EXACT evidence the derive consumes -- not a "latest" timestamp.
//
// INVARIANT (Codex final blocker 2): equal revision fingerprint => byte-identical canonical derived payload. Every
// input field that affects the derived payload's rows/totals/completeness/provenance/inventory/coverage/visible
// freshness is folded into the fingerprint at the EXACT numeric/field semantics the derivation consumes (no lossy
// rounding, no "anti-churn" omission of a payload-affecting field). This includes each durable dependency's validated_at
// (Listings/Raw/Catalog/FBA): those surface into payload.provenance.*FetchedAt, so a same-date content-identical
// re-validation that only advances validated_at genuinely changes the payload's freshness label and MUST re-promote.
// See canonNum + oliRowsDigest + oliCompletenessDigest + the folded validated_at in fingerprintListingHealthV3Bundle.
//
// FAIL-CLOSED (blockers 3 + 4): any missing / unreadable / malformed / cross-account / cross-marketplace / wrong-source
// / wrong-path / SHA-mismatch / row-count-mismatch / not-a-real-calendar-D-1 mandatory evidence returns
// { eligible:false } (defer, LKG preserved). A durable READ FAILURE (throw / typed read!=ok) on OLI coverage/
// completeness or FBA DEFERS (never degrades valid live LKG to a partial payload); a genuine successful EMPTY stays
// honest. Optional FBA: a proven successful absence (or a valid pointer for a different day) is the stable UNAVAILABLE
// identity, but an FBA read failure / pointer corruption DEFERS. Dates are validated by a REAL UTC calendar round-trip
// (not shape-only), validated_at by a real timestamp parse. Every read is injected + AbortSignal-threaded; ZERO
// provider export. 7-bit ASCII, LF.

import { createHash } from "node:crypto";
import { LISTINGS_SOURCE_KEY, LISTINGS_RAW_SOURCE_KEY, FBA_INVENTORY_SOURCE_KEY } from "./source-durable-model.js";
import { isValidRfc3339Timestamp } from "../rfc3339-timestamp.js";

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";
const US = ""; // unit separator (field)
const RS = ""; // record separator (row)
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MKT_RE = /^[A-Z]{2}$/;

export const LISTING_HEALTH_V3_BUNDLE_STATUS = Object.freeze({ AVAILABLE: "available", PROVEN_EMPTY: "proven-empty", MISSING: "missing" });

// A REAL UTC calendar date (round-trip) -- rejects shape-valid-but-impossible dates: 2026-02-30, 2026-99-99,
// 0000-00-00, a non-leap Feb 29. NOT the shape-only DATE_RE (blocker 4).
export function isRealCalendarDate(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const d = new Date(s + "T00:00:00.000Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
// validated_at is validated by the SHARED strict RFC3339/timestamptz validator (string only, real calendar date + valid
// time + Z/numeric offset + finite instant) -- NOT a loose Date.parse, which Node accepts for "2026-02-30T00:00:00Z",
// "1", and the date-only "2026-09-04".
const isRealTimestamp = isValidRfc3339Timestamp;
// Canonical numeric normalization -- FULL precision, matching the derivation's exact coercion (derivation-core
// num = Number(v) || 0, applied by foldOliWindowSales + summarizeCompleteness). NO rounding: a 4dp round COLLIDED
// 1.00001 vs 1.00002 (Codex repro) while the fold sums them to different dashboard sales. So equal token <=> equal
// Number(v)||0 <=> equal fold contribution (NaN / blank / undefined / -0 all fold to 0, and canonNum maps them to "0").
function canonNum(v) { return String(Number(v) || 0); }
function sha(input) { return createHash("sha256").update(input).digest("hex"); }

// ---- Deterministic content digests over the EXACT evidence the derive consumes ----------------------------------

// The 30D enriched OLI rows: fold EXACTLY the fields + aliases + coercion foldOliWindowSales consumes
// (listing-health-advanced.js:155-172) -- sale_date??saleDate, sku (trimmed; a BLANK sku is SKIPPED by the fold and so
// here), currency (trimmed), canonNum(sales_amount??salesAmount) / canonNum(ordered_units??orderedUnits??units) /
// canonNum(unpriced_units??unpricedUnits). account_id + child_asin are NOT read by the fold -> NOT folded. Sorted total
// order -> order-independent. So equal digest <=> equal fold input per sku <=> equal salesBySku <=> equal sales payload.
export function oliRowsDigest(rows) {
  const list = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const sku = S(r && r.sku).trim();
    if (!sku) continue;
    list.push([
      S(r && (r.sale_date != null ? r.sale_date : r.saleDate)),
      sku,
      S(r && r.currency).trim(),
      canonNum(r && (r.sales_amount != null ? r.sales_amount : r.salesAmount)),
      canonNum(r && (r.ordered_units != null ? r.ordered_units : (r.orderedUnits != null ? r.orderedUnits : r.units))),
      canonNum(r && (r.unpriced_units != null ? r.unpriced_units : r.unpricedUnits)),
    ].join(US));
  }
  list.sort();
  return sha("oli-rows" + list.join(RS));
}

// OLI coverage windows (normalized {from,to}); any covered-range change flips assessOliCoverage's verdict.
export function oliCoverageDigest(windows) {
  const list = (Array.isArray(windows) ? windows : []).map((w) => S(w && w.from) + US + S(w && w.to)).sort();
  return sha("oli-coverage" + list.join(RS));
}

// OLI completeness rows: fold EVERY field summarizeCompleteness surfaces INTO the payload (oli-completeness-serve.js:
// 91-104) -- sale_date, bucket, completeness_status, the four counts, itemization_percent, AND requested_as_of /
// proven_export_through / refreshed_at (these appear in the payload's `completeness` object from the LATEST in-window
// row, so per the equal-fingerprint=>equal-payload invariant they MUST be folded -- a refreshed_at advance genuinely
// changes the payload's freshness label, so re-promoting is correct, not churn). defect_count is NOT read by
// summarizeCompleteness (it never reaches the payload) -> NOT folded (avoids a spurious re-derive).
export function oliCompletenessDigest(rows) {
  const list = (Array.isArray(rows) ? rows : []).map((r) => [
    S(r && r.sale_date), S(r && r.account_id), S(r && r.bucket), S(r && r.completeness_status),
    canonNum(r && r.itemized_order_count), canonNum(r && r.pending_order_count),
    canonNum(r && r.itemized_unit_count), canonNum(r && r.pending_unit_count),
    canonNum(r && r.itemization_percent),
    S(r && r.requested_as_of), S(r && r.proven_export_through), S(r && r.refreshed_at),
  ].join(US)).sort();
  return sha("oli-completeness" + list.join(RS));
}

// The FBA inventory identity: proven-D-1 -> request_hash + payload_sha + validated_at; absent/other-day/empty -> a
// stable UNAVAILABLE sentinel. available<->unavailable, a date advance, a same-date content correction, AND a same-date
// content-identical re-validation that advances validated_at (inventoryFetchedAt reaches payload.provenance) all change it.
export function inventoryFingerprintToken({ accountId, connectionId, requestedAsOf, available, sourceRequestHash, payloadSha, validatedAt } = {}) {
  const base = "fba-inventory|" + S(accountId) + "|" + S(connectionId) + "|" + S(requestedAsOf) + "|";
  return available === true ? base + S(sourceRequestHash) + "|" + S(payloadSha) + "|" + S(validatedAt) : base + "UNAVAILABLE";
}

/**
 * The PURE canonical fingerprint over a resolved bundle's content components. Deterministic; changes iff ANY selected
 * input that can change the payload changes. Returns { revisionId:<32 hex>, status, manifestToken }.
 */
export function fingerprintListingHealthV3Bundle({
  organizationFingerprint, connectionId, accountId, marketplace, requestedAsOf,
  listings, listingsRaw, catalogPayloadSha, catalogValidatedAt, inventoryToken, oliDigests, status,
} = {}) {
  const fp = sha([
    "lhv3-dep-v1",
    S(organizationFingerprint), S(connectionId), S(accountId), S(marketplace), S(requestedAsOf), S(status),
    // Each dependency's validated_at is folded too: listingsFetchedAt/rawFetchedAt/catalogFetchedAt (and the FBA
    // validated_at inside inventoryToken) surface into payload.provenance.*FetchedAt, so a same-date content-identical
    // re-validation that only advances validated_at MUST flip the fingerprint (blocker 2: equal fp => equal payload).
    "L", S(listings && listings.sourceRequestHash), S(listings && listings.payloadSha), S(listings && listings.asOf), S(listings && listings.validatedAt),
    "R", S(listingsRaw && listingsRaw.sourceRequestHash), S(listingsRaw && listingsRaw.payloadSha), S(listingsRaw && listingsRaw.asOf), S(listingsRaw && listingsRaw.validatedAt),
    "C", S(catalogPayloadSha), S(catalogValidatedAt),
    "I", S(inventoryToken),
    "O", S(oliDigests && oliDigests.rows), S(oliDigests && oliDigests.coverage), S(oliDigests && oliDigests.completeness),
  ].join("|")).slice(0, 32);
  const manifestToken = "listing-health-v3-manifest|" + S(organizationFingerprint) + "|" + S(connectionId) + "|" + S(accountId) + "|" + S(requestedAsOf) + "|" + fp;
  return { revisionId: fp, status, manifestToken };
}

// ---- PURE pointer integrity (blockers 3 + 4): validate ONE Listings/Listings-Raw pointer against the expected
// identity. Returns { ok:true } or { ok:false, reason }. `expectedObjectPath` is the injected recompute of
// sourceSnapshotObjectPath from (org, durableConn, sourceKey, accountId, payload_sha) -- proves the object belongs to
// the expected namespace. Dates are validated by a REAL calendar round-trip; validated_at by a real timestamp.
export function validateListingsPointer({ snapshot, expectedOrg, durableConn, sourceKey, accountId, marketplace, requestedAsOf, expectedObjectPath } = {}) {
  if (!snapshot || typeof snapshot !== "object") return { ok: false, reason: "no-durable-snapshot" };
  if (S(snapshot.organization_fingerprint) !== S(expectedOrg)) return { ok: false, reason: "org-mismatch" };
  if (S(snapshot.connection_id) !== S(durableConn) || (durableConn !== "primary" && durableConn !== "dd-secondary")) return { ok: false, reason: "connection-mismatch" };
  if (S(snapshot.account_id) !== S(accountId)) return { ok: false, reason: "account-mismatch" };
  if (!MKT_RE.test(S(snapshot.marketplace)) || S(snapshot.marketplace) !== S(marketplace)) return { ok: false, reason: "marketplace-mismatch" };
  if (S(snapshot.source_key) !== S(sourceKey)) return { ok: false, reason: "source-key-mismatch" };
  // Listings + Listings-Raw are DATE-FREE, current-state sources: the outbound DataDoe request carries windowKind "none"
  // (from/to null, order-by child_asin only, NO date in the request hash -> stable day-to-day). Their durable as_of is
  // the CYCLE / publication LABEL (materialize.js: plan.context.to = the cycle D-1), NOT a source data date, and their
  // freshness is validated_at + that stable date-free request hash. So we DO NOT gate them on as_of === requestedAsOf --
  // that exact-D-1 equality is for the DATED evidence (FBA inventory single-day D-1 + OLI window), never a date-free
  // source; applying it here wrongly deferred LHv3 whenever the latest-good Listings label lagged the cycle D-1. We keep
  // only a shape sanity that the label is a real calendar date and adopt the LATEST validated pointer regardless of which
  // cycle label it carries (its strictly-newer CAS + validated_at + content-addressed namespace prove it is the freshest).
  if (!isRealCalendarDate(S(snapshot.as_of))) return { ok: false, reason: "as-of-invalid" };
  if (!isRealTimestamp(snapshot.validated_at)) return { ok: false, reason: "validated-at-invalid" };
  if (!nb(snapshot.source_request_hash)) return { ok: false, reason: "request-hash-blank" };
  const sha256Hex = S(snapshot.payload_sha);
  if (!nb(sha256Hex)) return { ok: false, reason: "payload-sha-blank" };
  // row_count MUST be an ACTUAL number (a SAFE non-negative integer), NOT a Number(...) coercion. Number(null)=0,
  // Number("")=0, Number(false)=0, Number("0")=0, Number(true)=1, Number("2")=2 FAIL-OPEN whenever the hydrated
  // rows.length happens to match the coerced value; typeof + Number.isSafeInteger reject every non-number. This is the
  // SAME P2 strictness round-4 applied to the Catalog snapshot in listing-health-v3-durable-loader.js -- applied here to
  // the mandatory Listings/Listings-Raw pointer for internal consistency (an int8/bigint row_count that node-postgres
  // returns as a STRING is a genuine masquerade this rejects; a legitimate int4 arrives as a real number).
  if (typeof snapshot.row_count !== "number" || !Number.isSafeInteger(snapshot.row_count) || snapshot.row_count < 0) return { ok: false, reason: "row-count-invalid" };
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
 *     inventorySource, context, listingsSnapshot, rawSnapshot, inventorySnapshot } }   when every mandatory input is proven,
 *   { eligible:false, status:MISSING, revisionId:null, deps:[], contentDeps:[], reason }   otherwise (defer, LKG kept).
 *
 * deps (injected): readListingsSnapshot, readListingsRawSnapshot, readInventorySnapshot, loadSnapshotPayload,
 *   resolveExpectedInventoryRequestHash, loadDurableContext (the STRICT reconciler loader), buildObjectPath.
 */
export async function resolveListingHealthV3DependencyBundle(deps = {}, args = {}) {
  const { readListingsSnapshot, readListingsRawSnapshot, readInventorySnapshot, loadSnapshotPayload, resolveExpectedInventoryRequestHash, loadDurableContext, buildObjectPath } = deps;
  const { organizationFingerprint, connectionId = "primary", accountId, marketplace, rawSellerId, requestedAsOf, signal = null } = args;
  const miss = (reason) => ({ eligible: false, status: LISTING_HEALTH_V3_BUNDLE_STATUS.MISSING, revisionId: null, deps: [], contentDeps: [], reason });
  const aborted = () => !!(signal && signal.aborted);
  for (const [n, f] of [["readListingsSnapshot", readListingsSnapshot], ["readListingsRawSnapshot", readListingsRawSnapshot], ["readInventorySnapshot", readInventorySnapshot], ["loadSnapshotPayload", loadSnapshotPayload], ["resolveExpectedInventoryRequestHash", resolveExpectedInventoryRequestHash], ["loadDurableContext", loadDurableContext], ["buildObjectPath", buildObjectPath]]) {
    if (typeof f !== "function") throw new Error("resolveListingHealthV3DependencyBundle requires " + n + " (fail closed).");
  }
  if (!nb(organizationFingerprint) || !nb(accountId) || !isRealCalendarDate(S(requestedAsOf)) || !MKT_RE.test(S(marketplace)) || !nb(rawSellerId)) return miss("incomplete-account-boundary");
  if (aborted()) return miss("aborted");

  // --- Listings + Listings-Raw pointers: read, full integrity, storage-first hydrate, rows.length===row_count. ---
  async function proveAndHydrate(reader, sourceKey) {
    let res;
    try { res = await reader({ organizationFingerprint, connectionId, accountId, signal }); }
    catch (e) { return { reason: sourceKey + "-read-threw:" + S(e && e.message) }; }
    if (aborted()) return { reason: "aborted" };
    if (res && res.read && res.read !== "ok") return { reason: sourceKey + "-read-" + S(res.read) }; // typed read failure -> defer
    const snapshot = res && res.read === "ok" ? (res.snapshot || null) : null;
    const expectedObjectPath = snapshot ? buildObjectPath({ organizationFingerprint, connectionId, sourceKey, scopeKey: accountId, payloadSha: S(snapshot.payload_sha) }) : "";
    const v = validateListingsPointer({ snapshot, expectedOrg: organizationFingerprint, durableConn: connectionId, sourceKey, accountId, marketplace, requestedAsOf, expectedObjectPath });
    if (!v.ok) return { reason: sourceKey + "-" + v.reason };
    let rows;
    try { rows = rowsOf(await loadSnapshotPayload(S(snapshot.object_path), { signal })); }
    catch (e) { return { reason: sourceKey + "-payload-unreadable:" + S(e && e.message) }; }
    if (aborted()) return { reason: "aborted" };
    if (!Array.isArray(rows)) return { reason: sourceKey + "-payload-dangling" };
    // row_count was already proven an actual safe non-negative integer by validateListingsPointer -> compare DIRECTLY
    // (no re-coercion, which would re-open the P2 fail-open).
    if (rows.length !== snapshot.row_count) return { reason: sourceKey + "-row-count-mismatch" };
    return { snapshot, rows };
  }
  const l = await proveAndHydrate(readListingsSnapshot, LISTINGS_SOURCE_KEY);
  if (l.reason) return miss(l.reason);
  const r = await proveAndHydrate(readListingsRawSnapshot, LISTINGS_RAW_SOURCE_KEY);
  if (r.reason) return miss(r.reason);

  // --- OPTIONAL FBA inventory (blockers 3 + 4): a READ THROW / typed read!=ok / pointer corruption / hydration
  //     failure / row-count mismatch DEFERS (preserve LKG). A proven successful absence, or a VALID pointer whose
  //     request_hash != the expected D-1 identity, or a proven-D-1 pointer with zero D-1 rows -> the stable
  //     UNAVAILABLE sentinel (FBA is optional). ONLY a proven-D-1, integrity-valid, non-empty snapshot is included. ---
  let inventorySource = { available: false };
  let inventorySnapshot = null;
  {
    let expected = "";
    try { expected = S(await resolveExpectedInventoryRequestHash({ accountId, requestedAsOf })); }
    catch (e) { return miss("inventory-expected-hash-threw:" + S(e && e.message)); }
    if (aborted()) return miss("aborted");
    if (nb(expected)) {
      let invRes;
      try { invRes = await readInventorySnapshot({ organizationFingerprint, connectionId, accountId, signal }); }
      catch (e) { return miss("inventory-read-threw:" + S(e && e.message)); }
      if (aborted()) return miss("aborted");
      if (invRes && invRes.read && invRes.read !== "ok") return miss("inventory-read-" + S(invRes.read)); // transient/schema -> defer
      const snap = invRes && invRes.read === "ok" ? (invRes.snapshot || null) : null;
      if (snap && S(snap.source_request_hash) === expected) {
        const invSha = S(snap.payload_sha);
        const expectedInvPath = buildObjectPath({ organizationFingerprint, connectionId, sourceKey: FBA_INVENTORY_SOURCE_KEY, scopeKey: accountId, payloadSha: invSha });
        if (S(snap.organization_fingerprint) !== S(organizationFingerprint) || S(snap.connection_id) !== S(connectionId)
          || S(snap.source_key) !== S(FBA_INVENTORY_SOURCE_KEY) || S(snap.scope_key) !== S(accountId)
          || !nb(invSha) || !S(snap.object_path).endsWith("/" + invSha + ".json") || S(snap.object_path) !== expectedInvPath) return miss("inventory-pointer-corrupt");
        // row_count strictness parity with validateListingsPointer / the round-4 Catalog check: an ACTUAL safe
        // non-negative integer, never a Number(...) coercion of a string/null/bool that fail-opens when it matches
        // invRows.length.
        if (typeof snap.row_count !== "number" || !Number.isSafeInteger(snap.row_count) || snap.row_count < 0 || !isRealTimestamp(snap.validated_at)) return miss("inventory-pointer-invalid");
        let invRows;
        try { invRows = rowsOf(await loadSnapshotPayload(S(snap.object_path), { signal })); }
        catch (e) { return miss("inventory-payload-unreadable:" + S(e && e.message)); }
        if (aborted()) return miss("aborted");
        if (!Array.isArray(invRows) || invRows.length !== snap.row_count) return miss("inventory-row-count-mismatch");
        const d1Rows = invRows.filter((row) => row && S(row.date) === S(requestedAsOf));
        if (d1Rows.length > 0) {
          inventorySource = { available: true, rows: d1Rows, fragments: [{ requestKey: "listing-health-v3:inventory", from: requestedAsOf, to: requestedAsOf, sellerOrVendorIds: [rawSellerId], rows: d1Rows }], disabled: false, disabledPolicy: null, reason: null };
          inventorySnapshot = snap;
        }
        // proven-D-1 pointer with zero D-1 rows -> genuine "no usable D-1 FBA" -> UNAVAILABLE (leave available:false)
      }
      // snap absent (read ok, no pointer) OR request_hash != expected (valid pointer for another day) -> UNAVAILABLE
    }
    // expected blank (unresolvable) -> UNAVAILABLE (FBA optional)
  }
  const inventoryToken = inventoryFingerprintToken({ accountId, connectionId, requestedAsOf, available: inventorySource.available === true, sourceRequestHash: inventorySnapshot && inventorySnapshot.source_request_hash, payloadSha: inventorySnapshot && inventorySnapshot.payload_sha, validatedAt: inventorySnapshot && inventorySnapshot.validated_at });

  // --- Durable OLI (rows+coverage+completeness) + Product Catalog (rows + payload_sha), via the SHARED loader in its
  //     STRICT reconciler mode: a read failure on OLI rows/coverage/completeness or a Catalog integrity failure returns
  //     {} (or omits the mandatory catalog) -> defer here (never a degraded payload replacing valid live LKG). ---
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
  // Both row_counts are proven ACTUAL numbers (=== their hydrated rows.length) by proveAndHydrate above -> compare
  // DIRECTLY (no Number(...) re-coercion).
  const status = l.snapshot.row_count === 0 && r.snapshot.row_count === 0 ? LISTING_HEALTH_V3_BUNDLE_STATUS.PROVEN_EMPTY : LISTING_HEALTH_V3_BUNDLE_STATUS.AVAILABLE;
  const fp = fingerprintListingHealthV3Bundle({
    organizationFingerprint, connectionId, accountId, marketplace, requestedAsOf,
    listings: { sourceRequestHash: l.snapshot.source_request_hash, payloadSha: l.snapshot.payload_sha, asOf: l.snapshot.as_of, validatedAt: l.snapshot.validated_at },
    listingsRaw: { sourceRequestHash: r.snapshot.source_request_hash, payloadSha: r.snapshot.payload_sha, asOf: r.snapshot.as_of, validatedAt: r.snapshot.validated_at },
    catalogPayloadSha: durableCatalog.payloadSha, catalogValidatedAt: durableCatalog.validatedAt, inventoryToken, oliDigests, status,
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
