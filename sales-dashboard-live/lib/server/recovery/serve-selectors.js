// Publication recovery WP4 -- PURE SERVE SELECTORS: which report_snapshots row does the dashboard SERVE actually return
// for a (report, account/scope, params) read? The recovery routes must verify THAT row (the served row), never only the
// canonical row they wrote (C3/C4: a newer row of another version, an out-of-line latest row, an exact-today refresh
// row or another identity can hold the served slot while the canonical row sits unread).
//
// Each selector REPRODUCES one existing serve read path EXACTLY, with every REST reader INJECTED (offline-testable; this
// module imports no transport, no Supabase client and no report store -- it is safe on the recovery VM):
//   selectExactThenLatest        -- report-store.js serveSharedReport (no staleScopeKeys): the EXACT identity row with
//                                   an INLINE payload, else the ONE latest row by updated_at for (report, account)
//                                   (supabase.js getLatestReportSnapshot), which must carry an inline payload AND the
//                                   requested reportVersion (a newer row of ANOTHER version HIDES an older LKG:
//                                   null 'version-hidden', exactly what the page shows -- nothing);
//   selectExactThenScopeLatest   -- serveSharedReport WITH staleScopeKeys (e.g. the portfolio's ['region']): the exact
//                                   row, else the latest row for the scope (getLatestReportSnapshotForScope, version-
//                                   filtered), which must match the version AND every scope key;
//   selectLatestForScope         -- the dedicated durable serves (Returns v3, SKU Movement): the latest row for
//                                   (report, account, version, scope) with an inline payload;
//   selectExact                  -- the exact identity row with an inline payload (brand-view-brands directory read);
//   selectInventoryAuthoritative -- Brand View's authoritative brand-inventory compact: the two candidate reads +
//                                   the SHARED pure selectAuthoritativeInventorySnapshot (brand-view.js);
//   selectLhv3                   -- the flag-aware Listing Health v3 live serve: ONLY when LHV3_PUBLISH_LIVE and
//                                   LISTING_HEALTH_V3 are both 'true', the exact row at {to: UTC D-1} (the strict
//                                   resolver's identity), else null 'serve-flag-off' (the page is the preview).
// Every selector returns { row, reason, via } where row = { id, report_key, account_id, params_hash,
// source_refreshed_at, updated_at } (identity only -- never a payload) or null with a typed reason. A reader THROW is
// null 'read-failed' (never a guess). The helpers below are copied from report-store.js (serveSharedReport's stale-
// scope rules) and pinned IDENTICAL by scripts/serve-selectors-parity.test.js, which also runs the REAL
// serveSharedReport over the same fake readers. The browser identity date comes from lib/marketplaces.js
// marketplaceToday (the value the page itself sends). 7-bit ASCII, LF.

import { marketplaceToday } from "../../marketplaces.js";
import { selectAuthoritativeInventorySnapshot } from "../reports/brand-view.js";

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";

export const SERVED_ROW_FIELDS = Object.freeze(["id", "report_key", "account_id", "params_hash", "source_refreshed_at", "updated_at"]);

/** The served row's IDENTITY only (never a payload). null for a non-object. */
export function servedRowIdentity(row) {
  if (!row || typeof row !== "object") return null;
  const out = {};
  for (const k of SERVED_ROW_FIELDS) out[k] = row[k] == null ? null : S(row[k]);
  return out;
}

// serveSharedReport serves a stored row only when `snapshot.payload` is TRUTHY (an out-of-line row -- payload null,
// payload_storage_path set -- is never served by the shared serve).
const hasInlinePayload = (row) => !!(row && row.payload);

// ---- report-store.js stale-scope rules (copied verbatim; pinned identical by the parity test) ----------------------
const BRAND_SCOPE_DEFAULT = "ALL";
function scopeValue(key, value) {
  if (key === "brand") { const b = value == null ? "" : String(value).trim(); return b || BRAND_SCOPE_DEFAULT; }
  return value == null ? "" : String(value);
}
export function pickStaleScope(params, keys) {
  const scope = {};
  for (const k of keys || []) scope[k] = scopeValue(k, params ? params[k] : undefined);
  return scope;
}
export function staleSnapshotMatchesScope(snapshot, params, keys) {
  if (!keys || !keys.length) return true;
  const sp = snapshot && snapshot.params ? snapshot.params : {};
  return keys.every((k) => scopeValue(k, sp[k]) === scopeValue(k, params ? params[k] : undefined));
}
export function staleSnapshotMatchesReportVersion(snapshot, reportVersion) {
  return snapshot?.params?.reportVersion === reportVersion;
}

/** The browser's identity as-of for a marketplace (the date the page itself sends): lib/marketplaces.js. */
export function browserAsOf(country, now = new Date()) {
  return marketplaceToday(country, now instanceof Date ? now : new Date(now));
}

const hit = (row, via) => ({ row: servedRowIdentity(row), reason: null, via });
const miss = (reason, via = null) => ({ row: null, reason, via });

function requireFn(readers, name) {
  const fn = readers && readers[name];
  if (typeof fn !== "function") throw new Error(`serve-selectors: readers.${name} is required (fail closed).`);
  return fn;
}
function requireHash(computeHash) {
  if (typeof computeHash !== "function") throw new Error("serve-selectors: computeHash (paramsHashFor) is required (fail closed).");
  return computeHash;
}

// The EXACT-identity read shared by the exact-first selectors. -> { row } | { row:null, readFailed }
async function readExact({ reportKey, accountId, reportVersion, params, readers, computeHash }) {
  const read = requireFn(readers, "getReportSnapshot");
  const paramsHash = requireHash(computeHash)(reportVersion, params || {});
  try { return { row: (await read({ reportKey, accountId, paramsHash })) || null, readFailed: false, paramsHash }; }
  catch { return { row: null, readFailed: true, paramsHash }; }
}

/**
 * serveSharedReport's read path WITHOUT staleScopeKeys (fba-plan, brand-view, brand-sales, ...): exact inline row, else
 * the single latest row by updated_at -- served only with an inline payload AND the requested reportVersion.
 */
export async function selectExactThenLatest({ reportKey, accountId, reportVersion, params = {}, readers, computeHash } = {}) {
  const exact = await readExact({ reportKey, accountId, reportVersion, params, readers, computeHash });
  if (exact.readFailed) return miss("read-failed", "exact");
  if (hasInlinePayload(exact.row)) return hit(exact.row, "exact");
  const readLatest = requireFn(readers, "getLatestReportSnapshot");
  let latest;
  try { latest = await readLatest({ reportKey, accountId }); } catch { return miss("read-failed", "latest"); }
  if (!latest) return miss(exact.row ? "out-of-line" : "missing", "latest");
  if (!hasInlinePayload(latest)) return miss("out-of-line", "latest");
  // C3: the ONE latest row is of ANOTHER version -> it HIDES any older same-version LKG (the serve shows nothing).
  if (!staleSnapshotMatchesReportVersion(latest, reportVersion)) return miss("version-hidden", "latest");
  return hit(latest, "latest");
}

/**
 * serveSharedReport's read path WITH staleScopeKeys (e.g. brand-view-portfolio ['region'], named-brand Daily ['brand']):
 * exact inline row, else the latest row for the scope (version-filtered reader), served only with an inline payload,
 * the requested version AND every scope key matching. Empty keys == selectExactThenLatest (the serve's own branch).
 */
export async function selectExactThenScopeLatest({ reportKey, accountId, reportVersion, params = {}, staleScopeKeys = [], readers, computeHash } = {}) {
  const keys = Array.isArray(staleScopeKeys) ? staleScopeKeys : [];
  if (!keys.length) return selectExactThenLatest({ reportKey, accountId, reportVersion, params, readers, computeHash });
  const exact = await readExact({ reportKey, accountId, reportVersion, params, readers, computeHash });
  if (exact.readFailed) return miss("read-failed", "exact");
  if (hasInlinePayload(exact.row)) return hit(exact.row, "exact");
  const readScope = requireFn(readers, "getLatestReportSnapshotForScope");
  let latest;
  try { latest = await readScope({ reportKey, accountId, reportVersion, scope: pickStaleScope(params, keys) }); } catch { return miss("read-failed", "scope-latest"); }
  if (!latest) return miss(exact.row ? "out-of-line" : "missing", "scope-latest");
  if (!hasInlinePayload(latest)) return miss("out-of-line", "scope-latest");
  if (!staleSnapshotMatchesReportVersion(latest, reportVersion)) return miss("version-hidden", "scope-latest");
  if (!staleSnapshotMatchesScope(latest, params, keys)) return miss("scope-mismatch", "scope-latest");
  return hit(latest, "scope-latest");
}

/**
 * The dedicated durable serves' stored-row read (api serveSelfHealingReturns: scope {} + RETURNS_ADVANCED_VERSION;
 * serveSelfHealingSkuMovement: scope { brand }): the latest row for (report, account, version, scope), served only with
 * an inline payload. (SKU Movement additionally re-derives when its freshness probe disagrees -- the route's own
 * current predicate owns that; this selector returns the stored row the page would serve when it is current.)
 */
export async function selectLatestForScope({ reportKey, accountId, reportVersion, scope = {}, readers } = {}) {
  const readScope = requireFn(readers, "getLatestReportSnapshotForScope");
  let row;
  try { row = await readScope({ reportKey, accountId, reportVersion, scope: scope || {} }); } catch { return miss("read-failed", "scope-latest"); }
  if (!row) return miss("missing", "scope-latest");
  if (!hasInlinePayload(row)) return miss("out-of-line", "scope-latest");
  return hit(row, "scope-latest");
}

/** The exact identity row with an inline payload (the brand-view-brands directory read). */
export async function selectExact({ reportKey, accountId, reportVersion, params = {}, readers, computeHash } = {}) {
  const exact = await readExact({ reportKey, accountId, reportVersion, params, readers, computeHash });
  if (exact.readFailed) return miss("read-failed", "exact");
  if (!exact.row) return miss("missing", "exact");
  if (!hasInlinePayload(exact.row)) return miss("out-of-line", "exact");
  return hit(exact.row, "exact");
}

/**
 * Brand View's AUTHORITATIVE brand-inventory compact for an account: the candidate rows (the newest AVAILABLE compact +
 * the newest row overall -- supabase.js getInventorySnapshotCandidates) reduced by the SHARED pure
 * selectAuthoritativeInventorySnapshot (brand-view.js), the exact function the Brand View serve + materializer use.
 */
export async function selectInventoryAuthoritative({ accountId, reportKey = "brand-inventory", reportVersion, readers, select = selectAuthoritativeInventorySnapshot } = {}) {
  const readCandidates = requireFn(readers, "getInventorySnapshotCandidates");
  let rows;
  try { rows = await readCandidates({ reportKey, accountId, reportVersion }); } catch { return miss("read-failed", "inventory"); }
  const chosen = typeof select === "function" ? select(Array.isArray(rows) ? rows : []) : null;
  if (!chosen) return miss(Array.isArray(rows) && rows.length ? "no-compact" : "missing", "inventory");
  return hit(chosen, "inventory");
}

// The UTC D-1 the strict LHv3 live resolver looks up (listing-health-v3-live-resolver.js expectedListingHealthV3LiveAsOf;
// pinned identical by the parity test).
export function lhv3ExpectedLiveAsOf(nowMs = Date.now()) {
  return new Date(Number(nowMs) - 86400000).toISOString().slice(0, 10);
}

/**
 * The flag-aware Listing Health v3 live serve (api listing-health-v3 action, default window): served ONLY when BOTH
 * LHV3_PUBLISH_LIVE and LISTING_HEALTH_V3 are exactly 'true' in `env`; then the exact row at the contract identity
 * {to: UTC D-1}. An optional `prove(row)` (the strict resolver body) must also return { ok:true } -- the serve falls
 * through to the preview otherwise, so an unproven row is null 'unproven'. Flags off -> null 'serve-flag-off'.
 */
export async function selectLhv3({ accountId, env = {}, now = () => Date.now(), readers, computeHash, contract, prove = null } = {}) {
  if (!env || env.LHV3_PUBLISH_LIVE !== "true" || env.LISTING_HEALTH_V3 !== "true") return miss("serve-flag-off", "lhv3");
  if (!contract || typeof contract.liveParams !== "function" || !nb(contract.liveReportKey)) return miss("no-live-contract", "lhv3");
  const liveParams = contract.liveParams({ to: lhv3ExpectedLiveAsOf(now()) });
  if (!liveParams) return miss("bad-expected-d1", "lhv3");
  const read = requireFn(readers, "getReportSnapshot");
  const paramsHash = requireHash(computeHash)(contract.liveReportVersion, liveParams);
  let row;
  try { row = await read({ reportKey: contract.liveReportKey, accountId, paramsHash }); } catch { return miss("read-failed", "lhv3"); }
  if (!row) return miss("missing", "lhv3");
  if (typeof prove === "function") {
    let p; try { p = await prove(row); } catch { p = null; }
    if (!p || p.ok !== true) return miss("unproven", "lhv3");
  }
  return hit(row, "lhv3");
}

// ---- served-row verdict -------------------------------------------------------------------------------------------
// Reasons a NULL selection can carry that re-publishing THIS route's row would fix (nothing else holds the slot).
const FIXABLE_NULL_REASONS = new Set(["missing", "no-compact"]);
const iso = (v) => { const t = Date.parse(S(v)); return Number.isFinite(t) ? t : null; };

/**
 * The DEFAULT served-row verdict: does the served selection equal the EXPECTED canonical row { report_key, account_id,
 * params_hash, source_refreshed_at }? -> { ok:true } | { ok:false, fixable, reason }. Routes may supply their own.
 *   - equal identity (all four fields)                      -> ok
 *   - nothing served ('missing' / 'no-compact')             -> fixable  (re-publishing this route's row fixes it)
 *   - nothing served for another reason (version-hidden, out-of-line, scope-mismatch, serve-flag-off, read-failed, ...)
 *                                                           -> NOT fixable (preempted:<reason>; alert, never a loop)
 *   - the served row IS the expected identity but an OLDER stamp  -> fixable 'stale-sra'
 *   - the served row IS the expected identity but a NEWER stamp   -> NOT fixable 'newer-write' (another writer won)
 *   - another identity / report / account holds the served slot   -> NOT fixable ('exact-identity-row' when the
 *                                                                     browser's EXACT identity is a different row,
 *                                                                     else 'other-identity' / 'foreign-row')
 */
export function defaultServedVerdict(served, expected) {
  const e = expected && typeof expected === "object" ? expected : {};
  const row = served && served.row ? served.row : null;
  if (!row) {
    const reason = S(served && served.reason) || "missing";
    return { ok: false, fixable: FIXABLE_NULL_REASONS.has(reason), reason };
  }
  if (S(row.report_key) !== S(e.report_key) || S(row.account_id) !== S(e.account_id)) return { ok: false, fixable: false, reason: "foreign-row" };
  if (S(row.params_hash) !== S(e.params_hash)) return { ok: false, fixable: false, reason: S(served.via) === "exact" ? "exact-identity-row" : "other-identity" };
  if (S(row.source_refreshed_at) === S(e.source_refreshed_at) && nb(e.source_refreshed_at)) return { ok: true, fixable: false, reason: null };
  const rs = iso(row.source_refreshed_at); const es = iso(e.source_refreshed_at);
  if (rs != null && es != null && rs > es) return { ok: false, fixable: false, reason: "newer-write" };
  return { ok: false, fixable: true, reason: "stale-sra" };
}
