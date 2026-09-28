// The SHARED Brand View dependency-fingerprint READERS (publication recovery WP8), MOVED VERBATIM out of
// report-materialization-brandview-composition.js so the scheduler materializer AND the zero-export brand-view recovery
// route fingerprint EXACTLY the same dependency set with EXACTLY the same readers (the serve -- api/datadoe.js
// brandViewDepFingerprintReaders -- computes it over the same REST readers, so writer, route and serve agree by
// construction and the serve's 'updating' flag keeps its meaning with NO serve change). Plus the per-account MEMOISED
// hydrated snapshot reader the brand-view route derives its N brand units through (brand-sales hydrated ONCE per
// account, not once per brand).
//
// Every reader is INJECTED (the composition passes supabase.js readers; the route passes the READ-ONLY supabase facade),
// so this module does NO I/O of its own, imports no transport, and makes ZERO DataDoe calls. It also carries the ONE
// exact durable Ads-row content digest (SQL text + JS twin) and the ONE derivation-code identity both Brand View
// recovery routes fold into their tokens (see the sections at the end). 7-bit ASCII, LF.

import { createHash } from "node:crypto";
import { campaignMappingRevision } from "../reports/campaign-ads-aggregation.js";
import { ACTIVE_ADS_SOURCE_KEY } from "../active-ads-source.js";
import {
  BRAND_INVENTORY_REPORT_VERSION, BRAND_VIEW_VERSION, BRAND_VIEW_BRANDS_VERSION, BRAND_VIEW_PORTFOLIO_VERSION,
  selectAuthoritativeInventorySnapshot, monthBack, monthStart,
} from "../reports/brand-view.js";

const BRAND_INVENTORY_LIVE_REPORT_KEY = "brand-inventory";

/**
 * The org-scoped campaign->brand mapping reader (moved verbatim from the composition): the account's CURRENT mappings
 * for the primary connection, [] when there is no org fingerprint or on ANY read failure (fail-soft, exactly like the
 * serve's campaignMappingsReader). `getMappings` is supabase.js getCampaignBrandMappings (or a fake).
 */
export function makeCampaignMappingsReader({ orgFp = null, getMappings } = {}) {
  return async ({ accountId }) => (orgFp ? getMappings({ organizationFingerprint: orgFp, connectionId: "primary", accountId }).catch(() => []) : []);
}

/**
 * The org Product Catalog validated_at reader (moved verbatim from the composition): the cheap source_snapshots POINTER
 * (never the payload) for the dependency fingerprint -- validated_at, else payload_sha, else null. A catalog
 * re-validation (new mapping content) advances it, so Brand View rebuilds when the ASIN->brand map changes.
 */
export function makeCatalogValidatedAtReader({ orgFp = null, getSourceSnap } = {}) {
  return orgFp ? async () => {
    const read = await getSourceSnap({ organizationFingerprint: orgFp, connectionId: "primary", sourceKey: "product-catalog", scopeKey: "__organization" });
    const ptr = read && typeof read === "object" && "snapshot" in read ? read.snapshot : read;
    return (ptr && (ptr.validated_at || ptr.payload_sha)) || null;
  } : async () => null;
}

/**
 * makeBrandViewDepReaders({ orgFp, readers }) -> the dependency-fingerprint readers object collectBrandViewDependency-
 * Fingerprint consumes. The returned object is the composition's former `depReaders` literal, MOVED VERBATIM (so the
 * legacy fingerprint is byte-identical). `readers`:
 *   getSnapshotMeta({ reportKey, accountId })      supabase.js getLatestReportSnapshotMeta
 *   getAdsCoverageState(accountId, sourceKey)      supabase.js getDailyAdsCoverage
 *   getInventoryCandidates({ reportKey, accountId, reportVersion })   supabase.js getInventorySnapshotCandidates
 *   getCampaignMappings({ accountId })             optional; default makeCampaignMappingsReader({ orgFp, getMappings })
 *   getCatalogValidatedAt()                        optional; default makeCatalogValidatedAtReader({ orgFp, getSourceSnap })
 *   getMappings / getSourceSnap                    the raw readers the two defaults above wrap
 */
export function makeBrandViewDepReaders({ orgFp = null, readers = {} } = {}) {
  const { getSnapshotMeta, getAdsCoverageState, getInventoryCandidates } = readers;
  const getCampaignMappings = typeof readers.getCampaignMappings === "function"
    ? readers.getCampaignMappings
    : makeCampaignMappingsReader({ orgFp, getMappings: readers.getMappings });
  const getCatalogValidatedAt = typeof readers.getCatalogValidatedAt === "function"
    ? readers.getCatalogValidatedAt
    : makeCatalogValidatedAtReader({ orgFp, getSourceSnap: readers.getSourceSnap });

  // The SHARED dependency-fingerprint readers (zero-export). deriveBrandView / deriveBrandViewPortfolio compute
  // the fingerprint over EXACTLY these dependencies; the serve (api/datadoe.js) computes it over the same ones.
  const depReaders = {
    getSnapshotMeta: ({ reportKey, accountId }) => getSnapshotMeta({ reportKey, accountId }).catch(() => null),
    getAdsCoverage: (accountId) => getAdsCoverageState(accountId, ACTIVE_ADS_SOURCE_KEY).catch(() => null),
    getMappingRev: async (accountId) => campaignMappingRevision(await getCampaignMappings({ accountId }).catch(() => [])),
    getCatalogValidatedAt: () => getCatalogValidatedAt().catch(() => null),
    // Round-4 Defect 2: the inventory dependency identity is the SELECTED authoritative compact (the available LKG
    // the builder actually serves), NOT the latest-by-updated_at row. So a selected-row change (a fresh available
    // compact) flips the fingerprint even when the latest placeholder's metadata is unchanged, and the serve does
    // NOT needlessly rebuild when an unavailable placeholder republishes but the selection is unchanged. Writer +
    // serve use the SAME selection, so they agree.
    getInventorySelected: (accountId) => getInventoryCandidates({ reportKey: BRAND_INVENTORY_LIVE_REPORT_KEY, accountId, reportVersion: BRAND_INVENTORY_REPORT_VERSION })
      .then((rows) => selectAuthoritativeInventorySnapshot(rows)).catch(() => null),
  };
  return depReaders;
}

// ---- DURABLE EVIDENCE IDENTITY helpers (the brand-view recovery routes) ---------------------------------------------
// The routes bind every snapshot a derive consumes to the EXACT row identity their metadata-only evidence SQL saw (C4:
// never "whatever the latest row is by the time the build reads it"). The SQL renders instants with to_char(... at
// time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'); PostgREST renders the same timestamptz as e.g.
// "2026-09-24T00:16:00.1234+00:00" (trailing fraction zeros trimmed). canonicalInstant maps BOTH (and any ISO/Postgres
// text form with an offset) onto ONE microsecond UTC string, so an identity comparison is exact, timezone-free and never
// goes through a local-time JS Date parse of a date column.
const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|z|[+-]\d{2}(?::?\d{2})?)?$/;

/** The canonical microsecond UTC form "YYYY-MM-DDTHH:MM:SS.ffffffZ" of an instant string, or null when unparseable. */
export function canonicalInstant(value) {
  if (value == null) return null;
  const m = INSTANT_RE.exec(String(value).trim());
  if (!m) return null;
  const [y, mo, d, h, mi, se] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number);
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d || h > 23 || mi > 59 || se > 59) return null;
  let offsetMinutes = 0;
  const tz = m[8];
  if (tz && tz !== "Z" && tz !== "z") {
    const body = tz.slice(1).replace(":", "");
    offsetMinutes = (tz[0] === "-" ? -1 : 1) * (Number(body.slice(0, 2)) * 60 + Number(body.slice(2, 4) || 0));
  }
  const ms = Date.UTC(y, mo - 1, d, h, mi, se) - offsetMinutes * 60000;
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 19) + "." + (m[7] || "").padEnd(6, "0").slice(0, 6) + "Z";
}

/**
 * The IDENTITY of one report_snapshots row -- from a REST row (params.reportVersion) or an evidence-SQL row
 * (report_version): { id, h, sra, upd, v } with canonical instants, or null for no row. Never the payload.
 */
export function snapshotRowIdentity(row) {
  if (!row || typeof row !== "object") return null;
  const v = row.report_version !== undefined ? row.report_version : (row.params && typeof row.params === "object" ? row.params.reportVersion : undefined);
  return {
    id: row.id == null ? null : String(row.id),
    h: row.params_hash == null ? null : String(row.params_hash),
    sra: canonicalInstant(row.source_refreshed_at),
    upd: canonicalInstant(row.updated_at),
    v: v == null ? null : String(v),
  };
}

/** Two row identities (snapshotRowIdentity) are the SAME row at the SAME write: both absent, or id + hash + both instants + version equal. */
export function sameSnapshotIdentity(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return a.id === b.id && a.h === b.h && a.sra === b.sra && a.upd === b.upd && a.v === b.v && a.upd != null;
}

/** A metadata read (params_hash + instants, no id / version -- getLatestReportSnapshotMeta) matches an identity. */
export function sameMetaIdentity(meta, identity) {
  if (meta == null || identity == null) return meta == null && identity == null;
  return String(meta.params_hash ?? "") === String(identity.h ?? "") && canonicalInstant(meta.updated_at) === identity.upd
    && canonicalInstant(meta.source_refreshed_at) === identity.sra && identity.upd != null;
}

/**
 * makeMemoHydratedReader(getLatestReportSnapshotHydrated) -> read({ reportKey, accountId }) with a per-(reportKey,
 * accountId) Map cache that lives for ONE account's units and is CLEARED the moment a read for a different account
 * arrives (so at most one account's hydrated payloads are ever held -- the brand-view route builds all of an account's
 * brand units back to back). The in-flight PROMISE is cached (concurrent reads of one key share one fetch); a rejected
 * read is evicted (never a cached failure). The caller owns content identity: read.invalidate({ reportKey, accountId })
 * evicts one key (the route evicts a memoised row whose identity no longer equals the durable evidence, then re-reads),
 * read.clear() drops everything, read.stats counts underlying reads / cache hits / clears. The cached rows are SHARED
 * (never copied -- a multi-MB brand-sales payload is the whole point); the Brand View builders only read them.
 */
export function makeMemoHydratedReader(getHydrated) {
  if (typeof getHydrated !== "function") throw new Error("makeMemoHydratedReader requires a hydrated snapshot reader (fail closed).");
  const cache = new Map();
  let owner = null;
  const stats = { reads: 0, hits: 0, clears: 0 };
  const keyOf = (reportKey, accountId) => String(reportKey) + "\u0000" + String(accountId);
  const read = ({ reportKey, accountId }) => {
    const acct = String(accountId);
    if (owner !== null && owner !== acct) { cache.clear(); stats.clears += 1; }
    owner = acct;
    const k = keyOf(reportKey, acct);
    if (cache.has(k)) { stats.hits += 1; return cache.get(k); }
    stats.reads += 1;
    const p = Promise.resolve().then(() => getHydrated({ reportKey, accountId }));
    cache.set(k, p);
    p.catch(() => { if (cache.get(k) === p) cache.delete(k); });
    return p;
  };
  read.invalidate = ({ reportKey, accountId }) => { cache.delete(keyOf(reportKey, accountId)); };
  read.clear = () => { if (cache.size) stats.clears += 1; cache.clear(); owner = null; };
  read.stats = stats;
  read.size = () => cache.size;
  return read;
}

// ---- THE BRAND VIEW ADS BUILD WINDOW --------------------------------------------------------------------------------
/**
 * The durable Ads window a Brand View build reads at `asOf`: EXACTLY buildAccountBrandSlice's getAdsRows window
 * (brand-view.js: `monthBack(asOf, 5)?.from || monthStart(asOf)` .. asOf -- six calendar months; pinned by the route
 * tests against the builder source). Both routes' Ads-row evidence is taken over this window.
 */
export function brandViewAdsWindow(asOf) {
  const m = monthBack(asOf, 5);
  return { from: (m && m.from) || monthStart(asOf), to: asOf == null ? "" : String(asOf) };
}

// ---- THE EXACT DURABLE ADS-ROW CONTENT DIGEST ('adr1:') ------------------------------------------------------------
// One per-account digest of the ads_daily_source_rows a Brand View build reads (the ACTIVE source over the build window),
// computed IDENTICALLY by the evidence SQL (adsRowsDigestSql -- Postgres) and by the route's strict REST cross-check
// (adsRowsDigest -- JS over the rows getAdsDailySourceRows returned), so the token binds the rows' CONTENT IDENTITY, not
// "count + newest updated_at" (Postgres now() is the TRANSACTION START time: an UPDATE / delete+insert whose updated_at
// is not above the current max, with an unchanged count, moved neither -- the WP9 v2 probe Q1a/Q1b).
//
// PER ROW (ads_daily_source_rows, 20260729_automated_ads_sync.sql: PK (source_key, account_id, marketplace_country_code,
// metric_date, dimension_key); every column NOT NULL) the canonical text is
//   L(source_key) L(account_id) L(marketplace_country_code) D(metric_date) L(dimension_key) L(campaign_id)
//   L(campaign_type) L(child_asin) L(targeting_id) L(currency) T(source_refreshed_at) T(updated_at)
// with L(x) = <UTF-8 byte length of x> ':' x '|'  (octet_length in a UTF8 database == Buffer.byteLength(x, 'utf8')),
//      D(d) = 'YYYY-MM-DD' '|'                     (to_char(date, 'YYYY-MM-DD') == PostgREST's date text),
//      T(t) = 'YYYY-MM-DDTHH:MM:SS.ffffffZ' '|'    (to_char(t at time zone 'UTC', ...US"Z") == canonicalInstant(REST)).
// Every variable-length field is LENGTH-PREFIXED and the only unprefixed fields are fixed-width, so the encoding is
// INJECTIVE (a '|' / ':' / newline inside a dimension_key can never make two different rows share a text). These are
// EXACTLY the scalar columns the REST read selects (supabase.js getAdsDailySourceRows). The jsonb `metrics` /
// `dimensions` are NOT hashed (a JS re-serialisation of PostgREST's parsed JSON can not reproduce jsonb::text exactly:
// numeric scale '1.50', key order): they are bound through updated_at -- the touch_updated_at BEFORE UPDATE trigger sets
// now() on EVERY update (incl. the writer's upsert ON CONFLICT DO UPDATE) and an INSERT defaults now(); the Ads writer
// (ads-sync.js adRowRecord -> supabase.js upsertAdsDailyRows) never supplies updated_at. So ANY insert / update / delete
// in the window changes the row multiset (a new / vanished primary key, or a new updated_at for that key).
//
// AGGREGATE (order-independent, per account): 'adr1:' || count || ':' || sum(lane1) || ':' || sum(lane2), where
// lane1 / lane2 are hex digits 1-15 / 16-30 of md5(row text) read as 60-bit unsigned integers (('x' || hex)::bit(60)
// ::bigint) and the sums are EXACT (sum(bigint) is numeric -- no overflow, no modulus; JS uses BigInt). A multiset sum
// needs NO sort, so there is no collation to agree on (the byte-order 'C' concern of an ordered string_agg vanishes) and
// no multi-MB per-account string: the SQL streams the 6-month window with O(1) state per account (HashAggregate
// allowed; an ordered string_agg forces a per-group sort and holds the whole string). Any single-row change moves the
// sums unless a 120-bit md5 prefix collides; the count pins inserts / deletes. The empty set is 'adr1:0:0:0'.
export const ADS_ROWS_DIGEST_PREFIX = "adr1:";
export const EMPTY_ADS_ROWS_DIGEST = ADS_ROWS_DIGEST_PREFIX + "0:0:0";
const ADS_DIGEST_TS = (col) => `coalesce(to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '')`;

/** The SQL expression of one row's canonical digest text (`p` = the table alias prefix, e.g. "r." or ""). */
export function adsRowDigestTextSql(p = "") {
  const L = (col) => `octet_length(coalesce(${p}${col}, ''))::text || ':' || coalesce(${p}${col}, '') || '|'`;
  return [
    L("source_key"), L("account_id"), L("marketplace_country_code"), `coalesce(to_char(${p}metric_date, 'YYYY-MM-DD'), '') || '|'`,
    L("dimension_key"), L("campaign_id"), L("campaign_type"), L("child_asin"), L("targeting_id"), L("currency"),
    `${ADS_DIGEST_TS(p + "source_refreshed_at")} || '|'`, `${ADS_DIGEST_TS(p + "updated_at")} || '|'`,
  ].join(" || ");
}

/** One EXACT digest lane sum over the grouped rows: hex digits start..start+14 of md5(row text) as 60-bit unsigned. */
export function adsLaneSumSql(p = "", start = 1) {
  return `coalesce(sum(('x' || substr(md5(${adsRowDigestTextSql(p)}), ${start}, 15))::bit(60)::bigint), 0)::text`;
}

/**
 * The SQL AGGREGATE expression of the per-account digest over the grouped rows (`p` = the table alias prefix). Counts
 * `<p>account_id` (never count(*)) and coalesces the sums, so a LEFT JOIN group with no row yields EMPTY_ADS_ROWS_DIGEST.
 */
export function adsRowsDigestSql(p = "") {
  return `'${ADS_ROWS_DIGEST_PREFIX}' || count(${p}account_id)::text || ':' || ${adsLaneSumSql(p, 1)} || ':' || ${adsLaneSumSql(p, 16)}`;
}

// ---- THE SHARED PER-DAY PARTIALS OF THE SAME DIGEST (publication recovery tier-1 performance) -----------------------
// The 'adr1:' digest is ADDITIVE: count, lane-1 sum and lane-2 sum are plain sums over rows, so the digest of a window
// equals the sums of the per-(account, metric_date) partials of the days inside it -- EXACTLY (count + BigInt sums, no
// modulus), and max(updated_at) of a window is the max of its days' maxima. ONE heap scan of the ACTIVE source over the
// UNION of every window a sweep needs (ADS_DAILY_PARTIALS_SQL) therefore yields every per-account window digest the
// Brand View and portfolio evidence used to compute with SIX separate scans of the same wide, disk-bound table (the
// 2026-09-28 VM tier-1 took 82 s against the 60 s gate; EXPLAIN: ~11-15 s of heap I/O per scan, md5 only ~2-5 s).
// adsWindowRowsFromDaily folds the partials back into rows IDENTICAL to what ADS_ROWS_SQL (Brand View, one LEFT JOIN
// row per requested account: an account with no row -> EMPTY_ADS_ROWS_DIGEST) and the portfolio's per-account group
// (accounts with >= 1 row only, with n + max_ua) returned -- pinned against both old statements on real Postgres
// (scripts/worker/ads-digest-equivalence-selftest.mjs) and in JS (scripts/ads-daily-digest.test.js).
// THE SCANNED RANGE IS ECHOED: every partial row AND one always-present SENTINEL row (account_id NULL, zero sums) carry
// range_from / range_to = $2 / $3 through a DateStyle-independent to_char, so a compose can PROVE the partials cover its
// windows even when the scan found no row at all (a params / compose clock split across a local midnight -> a window
// outside the scanned range -> fail closed typed 'ads-rows-window-mismatch', exactly as the old per-window echo did).
// $2 / $3 are only ever cast to date (one deduced parameter type).
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const BIGINT_RE = /^\d+$/;
const ADS_DAILY_TS = (col) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const ADS_DAILY_RANGE ="to_char($2::date, 'YYYY-MM-DD') as range_from, to_char($3::date, 'YYYY-MM-DD') as range_to";
export const ADS_DAILY_PARTIALS_SQL = "select p.account_id, p.metric_date, p.n, p.s1, p.s2, p.max_ua, " + ADS_DAILY_RANGE + " from ("
  + "select account_id, to_char(metric_date, 'YYYY-MM-DD') as metric_date, "
  + "count(account_id)::text as n, " + adsLaneSumSql("", 1) + " as s1, " + adsLaneSumSql("", 16) + " as s2, "
  + ADS_DAILY_TS("max(updated_at)") + " as max_ua "
  + "from public.ads_daily_source_rows where source_key = $1 and metric_date >= $2::date and metric_date <= $3::date "
  + "group by account_id, metric_date) p "
  + "union all select null::text, null::text, '0', '0', '0', null::text, " + ADS_DAILY_RANGE;
// The ACCOUNT-SCOPED twin ($4 = the evidence accounts): the SAME columns, partials, range echo and sentinel, restricted to
// the requested accounts -- an index-driven read (ads_daily_source_rows_lookup_idx: account_id, source_key, metric_date)
// for every reader WITHOUT a sweep cache (the route CLI's per-unit reads, the worker's per-job / dependency / deep-sweep
// reads). Folding its partials for the requested accounts yields EXACTLY the unscoped statement's digests.
export const ADS_DAILY_ACCOUNT_PARTIALS_SQL = ADS_DAILY_PARTIALS_SQL.replace(
  "where source_key = $1 and metric_date >= $2::date and metric_date <= $3::date ",
  "where source_key = $1 and metric_date >= $2::date and metric_date <= $3::date and account_id = any($4::text[]) ",
);
// FAIL CLOSED AT LOAD: if the base text ever changes so the replace above no longer matches, the "scoped" statement
// would silently be the full scan again -- refuse to load instead.
if (ADS_DAILY_ACCOUNT_PARTIALS_SQL === ADS_DAILY_PARTIALS_SQL || ADS_DAILY_ACCOUNT_PARTIALS_SQL.split("account_id = any($4::text[])").length !== 2) {
  throw new Error("brand-view-dependency-readers: ADS_DAILY_ACCOUNT_PARTIALS_SQL lost its account filter (fail closed).");
}

/**
 * PURE: split an ADS_DAILY_PARTIALS_SQL result into { range: { from, to }, rows: the real partials } -- or null when the
 * result is malformed (no sentinel, more than one sentinel, a row whose echoed range differs, a blank range). A caller
 * treats null as missing evidence (fail closed).
 */
export function splitAdsDailyPartials(result) {
  if (!Array.isArray(result)) return null;
  let range = null; let sentinels = 0; const rows = [];
  for (const r of result) {
    const from = String(r && r.range_from != null ? r.range_from : ""); const to = String(r && r.range_to != null ? r.range_to : "");
    if (!DAY_RE.test(from) || !DAY_RE.test(to) || from > to) return null;
    if (range && (range.from !== from || range.to !== to)) return null;
    range = { from, to };
    if (r.account_id == null) { sentinels += 1; continue; }
    rows.push(r);
  }
  return sentinels === 1 && range ? { range, rows } : null;
}

/**
 * PURE: fold ADS_DAILY_PARTIALS_SQL rows into per-window rows. windows: [{ accountId, from, to }] ('YYYY-MM-DD',
 * inclusive). includeEmpty: true -> one row per requested window even with no day inside (the LEFT JOIN semantics:
 * n '0', max_ua null, rows_digest EMPTY_ADS_ROWS_DIGEST); false -> only windows with >= 1 row (the GROUP BY semantics).
 * -> [{ account_id, win_from, win_to, n, max_ua, rows_digest }] in the windows' order. THROWS on a malformed partial
 * of a REQUESTED account (a non-date day, a non-integer count / sum): a corrupted read must never become a plausible
 * digest (fail closed). Validation is per requested account: a malformed row of an account no window asks for cannot
 * change any returned digest, so it never blocks the others (isolation).
 */
export function adsWindowRowsFromDaily(dailyRows, windows, { includeEmpty = false } = {}) {
  const byAcct = new Map();
  for (const r of Array.isArray(dailyRows) ? dailyRows : []) {
    const a = r == null ? "" : String(r.account_id == null ? "" : r.account_id);
    if (!byAcct.has(a)) byAcct.set(a, []);
    byAcct.get(a).push(r);
  }
  const partialsOf = (accountId) => (byAcct.get(accountId) || []).map((r) => {
    const d = String(r && r.metric_date != null ? r.metric_date : "");
    const n = String(r && r.n != null ? r.n : ""); const s1 = String(r && r.s1 != null ? r.s1 : ""); const s2 = String(r && r.s2 != null ? r.s2 : "");
    if (!DAY_RE.test(d) || !BIGINT_RE.test(n) || !BIGINT_RE.test(s1) || !BIGINT_RE.test(s2)) throw new Error("adsWindowRowsFromDaily: malformed daily partial (fail closed)");
    return { d, n: BigInt(n), s1: BigInt(s1), s2: BigInt(s2), ua: r.max_ua == null ? "" : String(r.max_ua) };
  });
  const out = [];
  for (const w of Array.isArray(windows) ? windows : []) {
    const accountId = String(w && w.accountId != null ? w.accountId : "");
    const from = String(w && w.from != null ? w.from : ""); const to = String(w && w.to != null ? w.to : "");
    if (accountId === "" || !DAY_RE.test(from) || !DAY_RE.test(to)) throw new Error("adsWindowRowsFromDaily: malformed window (fail closed)");
    let n = 0n; let s1 = 0n; let s2 = 0n; let ua = "";
    for (const p of partialsOf(accountId)) {
      if (p.d < from || p.d > to) continue;
      n += p.n; s1 += p.s1; s2 += p.s2;
      if (p.ua > ua) ua = p.ua; // one fixed-width canonical UTC form -> lexicographic = chronological
    }
    if (n === 0n && !includeEmpty) continue;
    out.push({ account_id: accountId, win_from: from, win_to: to, n: n.toString(), max_ua: n === 0n ? null : ua, rows_digest: ADS_ROWS_DIGEST_PREFIX + n.toString() + ":" + s1.toString() + ":" + s2.toString() });
  }
  return out;
}

/** The JS twin of adsRowDigestTextSql over one REST row (PostgREST shapes: '+00:00' instants, trimmed fractions). */
export function adsRowDigestText(row) {
  const r = row && typeof row === "object" ? row : {};
  const L = (v) => { const s = v == null ? "" : String(v); return Buffer.byteLength(s, "utf8") + ":" + s + "|"; };
  const D = (v) => (v == null ? "" : String(v)) + "|";
  const T = (v) => (canonicalInstant(v) || "") + "|";
  return L(r.source_key) + L(r.account_id) + L(r.marketplace_country_code) + D(r.metric_date)
    + L(r.dimension_key) + L(r.campaign_id) + L(r.campaign_type) + L(r.child_asin) + L(r.targeting_id) + L(r.currency)
    + T(r.source_refreshed_at) + T(r.updated_at);
}

/** The JS twin of adsRowsDigestSql over the REST rows a build read (order-independent; [] -> EMPTY_ADS_ROWS_DIGEST). */
export function adsRowsDigest(rows) {
  let n = 0; let s1 = 0n; let s2 = 0n;
  for (const row of Array.isArray(rows) ? rows : []) {
    const h = createHash("md5").update(adsRowDigestText(row), "utf8").digest("hex");
    n += 1;
    s1 += BigInt("0x" + h.slice(0, 15));
    s2 += BigInt("0x" + h.slice(15, 30));
  }
  return ADS_ROWS_DIGEST_PREFIX + n + ":" + s1.toString() + ":" + s2.toString();
}

// ---- DERIVATION-CODE IDENTITY ----------------------------------------------------------------------------------------
/**
 * The derivation-code identity the Brand View recovery route tokens (bv1 / bvm1, pf1 / pfm2, bb1) fold in: the three
 * Brand View report versions, the brand-inventory compact version the builders select by, the ACTIVE Ads grain (a
 * rollback flip changes how Ads are attributed) and the route's own DERIVE_REV (each route module documents: bump it
 * on ANY change to its builder / derive / assembly code that can change a payload over unchanged inputs). So a deploy
 * that changes derivation moves every token and re-arms every input-unchanged unit, instead of leaving it 'current'
 * over a payload a fresh derive would no longer produce. Returns a fresh plain object (token material).
 */
export function brandViewCodeIdentity(deriveRev) {
  return {
    bv: BRAND_VIEW_VERSION, bvb: BRAND_VIEW_BRANDS_VERSION, bvp: BRAND_VIEW_PORTFOLIO_VERSION,
    inv: BRAND_INVENTORY_REPORT_VERSION, ads: ACTIVE_ADS_SOURCE_KEY, rev: String(deriveRev),
  };
}
