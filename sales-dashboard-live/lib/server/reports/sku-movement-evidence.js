// SKU MOVEMENT -- the SHARED, PURE evidence / serve-token module (publication recovery WP6). One definition of every
// token the sku-movement route writes and the serve (api/datadoe.js serveSelfHealingSkuMovement, WP10) reads, so the
// route that PUBLISHES a row and the serve that decides whether that stored row is CURRENT can never drift:
//   computeSkuServeToken       -- 'sms2:' + sha256([effectiveAsOf, the OLI coverage windows WITH each window's
//                                 updated_at, the org catalog payload_sha, the operational-units row count +
//                                 max(updated_at) in [monthBack(effectiveAsOf, 3), effectiveAsOf], the canonical
//                                 brand]). It covers OLI CONTENT, not only dates: every OLI history / dimensional writer
//                                 RPC re-acknowledges its coverage window (updated_at = now()) in the SAME transaction,
//                                 and a standalone operational-units backfill moves the unit-row count / max(updated_at)
//                                 -- so after a same-effectiveAsOf correction the SERVE stops serving the older stored
//                                 row even before the route republishes (the page re-derives read-only instead).
//                                 The retired 'sms1:' token (dates + catalog only) is NEVER current (see below);
//   skuMovementStoredIsCurrent -- the serve's "serve stored vs re-derive" predicate: a row carrying params.serveToken is
//                                 current ONLY when that token is a CURRENT-version ('sms2:') token equal to the freshly
//                                 computed one AND its payload is at the same effectiveAsOf; a LEGACY row (no token)
//                                 keeps the pre-route predicate of api/datadoe.js serveSelfHealingSkuMovement VERBATIM
//                                 (skuMovementLegacyStoredIsCurrent: source_refreshed_at === the freshly probed
//                                 provenance AND the same effectiveAsOf);
//   stripStoredExtras          -- the stored live params minus reportVersion and the route's stored-only extras
//                                 (depFingerprint / evidenceToken / serveToken / manifestToken): the extras ride the
//                                 stored params OUTSIDE the identity hash, so the serve's response paramsHash must be
//                                 computed from the stripped params to stay the canonical { asOf, brand } hash;
//   computeSkuEvidenceToken    -- the route's L1 evidence token 'sm1:' + sha256(canonical parts) (the parts are composed
//                                 by the route module from metadata-only evidence SQL; this is only the hash);
//   computeSkuManifestToken    -- 'smm1:' + sha256 over a digest of the HYDRATED ordered-OLI history rows + catalog rows
//                                 (the exact derive inputs; --verify-exact proves the job lineage carries it).
//
// THE SERVE-SIDE CONTRACT (what WP10's api/datadoe.js serveSelfHealingSkuMovement must read + compute; the route's
// served selector models exactly this, and scripts/sku-movement-route.test.js S6 pins the parity over PostgREST-shaped
// fixtures):
//   (1) coverage   getSourceCoverageWindows({ organizationFingerprint, connectionId: 'primary', accountId,
//                  sourceKey: 'order-line-items' }) -- EXTENDED (supabase.js) to select covered_from, covered_to AND
//                  updated_at and map each row to { from, to, updatedAt } (status = 'succeeded' filter unchanged; the
//                  existing consumers ignore updatedAt). windows = read === 'ok' ? windows : [] (as today);
//   (2) as-of      effectiveAsOf = skuMovementProvenDates(windows, UTC calendar date).effectiveAsOf (as today);
//   (3) catalog    getSourceSnapshot({ ..., sourceKey: 'product-catalog', scopeKey: '__organization' }).snapshot
//                  .payload_sha (the read the serve already makes);
//   (4) opunits    ONE cheap stats read of public.source_oli_operational_units for (organization_fingerprint,
//                  connection_id 'primary', account_id) with sale_date in skuServeOpunitsWindow(effectiveAsOf) =
//                  [monthBackStr(effectiveAsOf, 3), effectiveAsOf] over ALL rows (NO additiveOnly filter): the exact
//                  row count + max(updated_at) (null when 0 rows) -> { windowFrom, windowTo, rows, maxUpdatedAt }
//                  (REST: select=updated_at&order=updated_at.desc&limit=1 with Prefer: count=exact). A failed read ->
//                  no token (the serve re-derives);
//   (5) token      computeSkuServeToken({ effectiveAsOf, coverageWindows: windows, catalogPayloadSha, opunits,
//                  brand: brandScope.brand }) -- timestamps in ANY ISO-8601 offset form (PostgREST '+00:00', to_char
//                  'Z') digest identically (canonicalSkuInstant);
//   (6) predicate  skuMovementStoredIsCurrent({ stored, effectiveAsOf, serveToken, legacyProvenance: freshRefreshedAt })
//                  replaces the fast-path condition; the response paramsHash is paramsHashFor(version,
//                  stripStoredExtras(snap.params)).
// Until THAT serve is deployed the route's served selector must model the LEGACY serve (the owner attests the deploy
// with SKU_MOVEMENT_SERVE_TOKEN_ATTESTED='true'; sku-movement.release.js).
// PURE: no I/O, no DataDoe, no Supabase; imports only node:crypto, the pure canonical-JSON helper and the pure date
// helper. 7-bit ASCII, LF.

import { createHash } from "node:crypto";
import { stableJson } from "../sync/publication-binding.js";
import { monthBackStr } from "../date-windows.js";

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";
const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const sha256 = (v) => createHash("sha256").update(String(v)).digest("hex");

export const SKU_EVIDENCE_TOKEN_PREFIX = "sm1:";
// The CURRENT serve-token version. 'sms1:' (effectiveAsOf + coverage (from, to) + catalog sha + brand -- blind to a
// same-date OLI correction or an operational-units backfill) is RETIRED: a stored 'sms1:' row is never current.
export const SKU_SERVE_TOKEN_PREFIX = "sms2:";
export const SKU_MANIFEST_TOKEN_PREFIX = "smm1:";
// The keys the serve strips from the STORED params before hashing its response identity (reportVersion + every
// stored-only live extra the publisher may store -- publication-binding.js LIVE_PARAMS_EXTRA_KEYS).
export const SKU_STORED_EXTRA_KEYS = Object.freeze(["reportVersion", "depFingerprint", "evidenceToken", "serveToken", "manifestToken"]);

// The serve's canonical scope brand (api/datadoe.js brandScope; report-publisher.js skuMovementCanonicalBrand): trimmed,
// blank -> "ALL", case PRESERVED. Kept local so this module stays import-light for the serve; pinned IDENTICAL to
// skuMovementCanonicalBrand by scripts/sku-movement-route.test.js.
export function skuServeCanonicalBrand(brand) {
  const s = S(brand).trim();
  return s === "" ? "ALL" : s;
}

/**
 * The OLI coverage windows' BOUNDS: [[from, to], ...] over the windows whose bounds are both YYYY-MM-DD (the SAME
 * accessor skuMovementProvenDates uses: from ?? covered_from ?? coveredFrom), sorted. A window list read through
 * getSourceCoverageWindows ({ from, to }) and the raw column spelling compare identically (the route's cross-check of
 * two reads of the same windows; the serve token itself digests normalizeSkuServeWindows).
 */
export function normalizeSkuCoverageWindows(windows) {
  const wFrom = (w) => S(w && (w.from ?? w.covered_from ?? w.coveredFrom)).slice(0, 10);
  const wTo = (w) => S(w && (w.to ?? w.covered_to ?? w.coveredTo)).slice(0, 10);
  return (Array.isArray(windows) ? windows : [])
    .filter((w) => w && isDate(wFrom(w)) && isDate(wTo(w)))
    .map((w) => [wFrom(w), wTo(w)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
}

/**
 * A timestamp as ONE canonical UTC text with microsecond precision ('YYYY-MM-DDTHH:MM:SS.ffffffZ'), whatever ISO-8601
 * offset form it was read in: Postgres to_char(... at time zone 'UTC', '...US"Z"') (the route's SQL) and PostgREST's
 * '+00:00' rendering (the serve's REST reads) of the SAME timestamptz digest identically. Microseconds are kept
 * textually (never through a JS Date, which would drop them). Anything else -- a JS Date object, a blank, a non-ISO
 * string, an impossible calendar date / time -- is null (the caller fails closed: no token).
 */
export function canonicalSkuInstant(v) {
  if (typeof v !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/i.exec(v.trim());
  if (!m) return null;
  const [, date, hh, mi, ss, frac = "", offRaw] = m;
  if (new Date(date + "T00:00:00Z").toISOString().slice(0, 10) !== date || Number(hh) > 23 || Number(mi) > 59 || Number(ss) > 59) return null;
  let off = "Z";
  if (offRaw.toUpperCase() !== "Z") {
    const digits = offRaw.slice(1).replace(":", "");
    const oh = digits.slice(0, 2); const om = digits.slice(2) || "00";
    if (Number(oh) > 14 || Number(om) > 59) return null;
    off = offRaw[0] + oh + ":" + om;
  }
  const t = Date.parse(`${date}T${hh}:${mi}:${ss}${off}`);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 19) + "." + frac.padEnd(6, "0") + "Z";
}

/**
 * The OLI coverage windows as the SERVE token digests them: [[from, to, canonical updated_at], ...] over the windows
 * whose bounds are both YYYY-MM-DD (the normalizeSkuCoverageWindows accessor; updated_at read as updatedAt ??
 * updated_at), sorted. null when ANY such window lacks a canonical updated_at (fail closed -- never a token blind to a
 * window's re-acknowledgement).
 */
export function normalizeSkuServeWindows(windows) {
  const wFrom = (w) => S(w && (w.from ?? w.covered_from ?? w.coveredFrom)).slice(0, 10);
  const wTo = (w) => S(w && (w.to ?? w.covered_to ?? w.coveredTo)).slice(0, 10);
  const out = [];
  for (const w of Array.isArray(windows) ? windows : []) {
    if (!w || !isDate(wFrom(w)) || !isDate(wTo(w))) continue;
    const upd = canonicalSkuInstant(w.updatedAt ?? w.updated_at);
    if (!upd) return null;
    out.push([wFrom(w), wTo(w), upd]);
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return out.sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]) || cmp(a[2], b[2]));
}

/** The operational-units window the serve token's stats cover: [monthBackStr(effectiveAsOf, 3), effectiveAsOf]. */
export function skuServeOpunitsWindow(effectiveAsOf) {
  if (!isDate(effectiveAsOf)) return null;
  return { from: monthBackStr(effectiveAsOf, 3), to: effectiveAsOf };
}

// The canonical operational-units stats part: ['opunits', from, to, rows, canonical max(updated_at) | null]. null (no
// token) unless the stats cover EXACTLY skuServeOpunitsWindow(effectiveAsOf), rows is a non-negative integer, and
// max(updated_at) is canonical when rows > 0 / absent when rows === 0.
function skuServeOpunitsPart(opunits, effectiveAsOf) {
  const win = skuServeOpunitsWindow(effectiveAsOf);
  if (!win || !opunits || typeof opunits !== "object") return null;
  if (S(opunits.windowFrom) !== win.from || S(opunits.windowTo) !== win.to) return null;
  const rows = opunits.rows;
  if (typeof rows !== "number" || !Number.isInteger(rows) || rows < 0) return null;
  if (rows === 0) return opunits.maxUpdatedAt == null || opunits.maxUpdatedAt === "" ? ["opunits", win.from, win.to, 0, null] : null;
  const max = canonicalSkuInstant(opunits.maxUpdatedAt);
  return max ? ["opunits", win.from, win.to, rows, max] : null;
}

/**
 * The SERVE token of one (account, brand) SKU Movement row: 'sms2:' + sha256([effectiveAsOf, the coverage windows with
 * their canonical updated_at, catalog payload_sha, the operational-units stats, canonical brand]). null (no token -- the
 * serve then re-derives; the route defers) when effectiveAsOf is not a date, the catalog payload_sha is blank, a
 * window's updated_at is missing / unparseable, or the operational-units stats are missing / malformed / of another
 * window. `opunits` = { windowFrom, windowTo, rows, maxUpdatedAt } over skuServeOpunitsWindow(effectiveAsOf) (ALL rows
 * of the account in the window -- no additive filter). The route stores it in params.serveToken (computed from the SAME
 * metadata its L1 evidence token read); the serve recomputes it from its own reads (see THE SERVE-SIDE CONTRACT above).
 */
export function computeSkuServeToken({ effectiveAsOf, coverageWindows, catalogPayloadSha, opunits, brand } = {}) {
  if (!isDate(effectiveAsOf) || !nb(catalogPayloadSha)) return null;
  const windows = normalizeSkuServeWindows(coverageWindows);
  if (!windows) return null;
  const ops = skuServeOpunitsPart(opunits, effectiveAsOf);
  if (!ops) return null;
  const parts = ["sms2", effectiveAsOf, windows, S(catalogPayloadSha).trim(), ops, skuServeCanonicalBrand(brand)];
  return SKU_SERVE_TOKEN_PREFIX + sha256(stableJson(parts));
}

/**
 * The pre-route "stored row is current" predicate of api/datadoe.js serveSelfHealingSkuMovement, VERBATIM (the DEPLOYED
 * serve today): stored.payload && effectiveAsOf && legacyProvenance && String(stored.source_refreshed_at || "") ===
 * String(legacyProvenance) && stored.payload.effectiveAsOf === effectiveAsOf (legacyProvenance =
 * skuMovementRefreshedAt({ catalogSnapshot, effectiveAsOf })). It never looks at a serve token.
 */
export function skuMovementLegacyStoredIsCurrent({ stored, effectiveAsOf, legacyProvenance } = {}) {
  return !!(stored && stored.payload && effectiveAsOf && legacyProvenance
    && String(stored.source_refreshed_at || "") === String(legacyProvenance)
    && stored.payload.effectiveAsOf === effectiveAsOf);
}

/**
 * Is the STORED row the serve found (getLatestReportSnapshotForScope) CURRENT, so the serve returns it instead of a
 * read-only re-derive? (The WP10 serve predicate.)
 *   - stored.params carries a serveToken (a route-published row): current ONLY when it is a CURRENT-version token
 *     (SKU_SERVE_TOKEN_PREFIX -- a retired 'sms1:' token is NEVER current, so such a row is re-derived by the serve and
 *     republished by the route, never silently accepted) equal to `serveToken` AND stored.payload.effectiveAsOf ===
 *     effectiveAsOf;
 *   - no serveToken (a legacy materializer / self-heal row): skuMovementLegacyStoredIsCurrent (the pre-route predicate
 *     VERBATIM).
 * A present-but-blank / non-string token is never current (fail closed; it never falls back to the legacy predicate).
 */
export function skuMovementStoredIsCurrent({ stored, effectiveAsOf, serveToken, legacyProvenance } = {}) {
  if (!(stored && stored.payload && effectiveAsOf)) return false;
  const params = stored.params && typeof stored.params === "object" && !Array.isArray(stored.params) ? stored.params : null;
  if (params && Object.prototype.hasOwnProperty.call(params, "serveToken") && params.serveToken !== undefined) {
    return typeof params.serveToken === "string" && params.serveToken.startsWith(SKU_SERVE_TOKEN_PREFIX)
      && typeof serveToken === "string" && serveToken.startsWith(SKU_SERVE_TOKEN_PREFIX)
      && params.serveToken === serveToken
      && stored.payload.effectiveAsOf === effectiveAsOf;
  }
  return skuMovementLegacyStoredIsCurrent({ stored, effectiveAsOf, legacyProvenance });
}

/**
 * The stored live params minus reportVersion + every stored-only extra (SKU_STORED_EXTRA_KEYS): what the serve hashes
 * for its response paramsHash. A legacy row (params { reportVersion, asOf, brand }) strips to EXACTLY what the pre-route
 * serve hashed; a route row additionally drops its tokens, so the hash stays the canonical identity hash. A non-object
 * input returns null (the caller keeps its own fallback -- the serve falls back to the request params).
 */
export function stripStoredExtras(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  return Object.fromEntries(Object.entries(params).filter(([k]) => !SKU_STORED_EXTRA_KEYS.includes(k)));
}

/** The route's L1 evidence token over its canonical (composed) parts: 'sm1:' + sha256(stableJson(parts)). */
export function computeSkuEvidenceToken(parts) {
  return SKU_EVIDENCE_TOKEN_PREFIX + sha256(stableJson(parts));
}

// Streamed row digest (one canonical-JSON line per row) -- no giant intermediate string for a large catalog.
function digestRows(rows) {
  const h = createHash("sha256");
  let n = 0;
  for (const r of Array.isArray(rows) ? rows : []) { h.update(stableJson(r)); h.update("\n"); n += 1; }
  return { sha: h.digest("hex"), n };
}
// The catalog rows array is shared by every account of a run (the route memoizes the hydrated catalog by object path),
// so its digest is computed ONCE per array.
const catalogDigestMemo = new WeakMap();
function catalogDigest(rows) {
  if (!Array.isArray(rows)) return digestRows([]);
  if (!catalogDigestMemo.has(rows)) catalogDigestMemo.set(rows, digestRows(rows));
  return catalogDigestMemo.get(rows);
}

/**
 * The MANIFEST token of one account's hydrated derive inputs: 'smm1:' + sha256([accountId, effectiveAsOf, coverageFrom,
 * digest + count of the ordered-OLI history rows, digest + count of the catalog rows]). Every brand unit of the account
 * derives from exactly these inputs (the brand is the unit's identity, bound by the shadow's content-addressed params).
 */
export function computeSkuManifestToken({ accountId, effectiveAsOf, coverageFrom, historyRows, catalogRows } = {}) {
  const hist = digestRows(historyRows);
  const cat = catalogDigest(catalogRows);
  return SKU_MANIFEST_TOKEN_PREFIX + sha256(stableJson(["smm1", S(accountId), S(effectiveAsOf), coverageFrom == null ? null : S(coverageFrom), hist.sha, hist.n, cat.sha, cat.n]));
}
