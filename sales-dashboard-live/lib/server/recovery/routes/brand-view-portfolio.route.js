// Publication recovery WP9 -- the WORKER-side declaration of the brand-view-portfolio route (route-contract.js shape) PLUS
// the ONE pure evidence composition both sides share: the recovery worker's tier-1 scan (evidence.sql + compose) and the
// CLI-side release (lib/server/sync/routes/brand-view-portfolio.release.js readScopeEvidence) run the SAME read-only SQL
// through the SAME composeBrandViewPortfolioEvidence, so the L1 token a job is claimed with and the token its verify child
// evaluates are identical by construction (a job is VERIFIED only when they are).
//
// GRAIN region: ONE job target per scheduler region ('region:<r>'); its UNITS are the portfolio brands (unit
// 'region-brand'; each brand unit has its own cycle, job, shadow and publish -- units never appear in job keys or argv).
//
// L1 EVIDENCE TOKEN  'pf1:' + sha256(canonical JSON of):
//   - the region + the IN as-of the browser sends (marketplaceToday('IN', now) -- BrandPortfolio.jsx), so the 18:30 UTC
//     IN midnight rollover changes the token and every portfolio of the region re-publishes once for the new identity;
//   - the region's BROWSER-PARITY account universe from the latest account-directory snapshot, exactly as the page and
//     the serve see it: entries with active !== false (the 'accounts' action's selectable filter), keyed by String(id),
//     region by the TRUSTED `country` (the serve's filterAccountIdsToRegion over { name: entry.name || null, country:
//     entry.country || null } -- the JSON VALUES, re-typed from ->> text + jsonb_typeof, so a non-string name / country
//     keeps the serve's type in the payload), with the per-account name / country / settingUp / duplicate flags (they
//     change payload labels or unit eligibility);
//   - the brand-sales latest-row identity of EVERY selectable account in ANY region: the page's brand directory computes
//     membership over all of them, and a brand's DISPLAY label (the `brand` the portfolio request carries) is the
//     smallest variant across ALL accounts -- so an out-of-region brand-sales change can relabel an in-region portfolio;
//   - per universe account, the latest-row identity (id, params_hash, params.reportVersion, source_refreshed_at,
//     updated_at) of every report the portfolio build reads -- brand-sales (membership + sales), the brand-inventory
//     candidates (the newest AVAILABLE compact + the newest row: selectAuthoritativeInventorySnapshot's inputs), fba-plan,
//     listing-health, and the ASIN->brand map inputs sku-pl / sales-movers / returns-leakage / buy-box-loss /
//     listing-optimizer (report_snapshots.updated_at is trigger-touched on EVERY update, so the identity pins the content).
//     The latest row is rank()-selected (never DISTINCT ON): a TIE at the newest updated_at is VISIBLE and enters the
//     material as { ambiguous: true, ids } -- the account's units defer 'latest-row-ambiguous:<report>', never a coin flip;
//   - per account, the ACTIVE Ads grain's durable state (last_status, latest_metric_date, content_rev -- a same-window
//     value correction bumps content_rev) + its succeeded coverage windows, and the durable ads_daily_source_rows over
//     the EXACT build window (brand-view.js buildAccountBrandSlice: monthBack(asOf, 5).from .. asOf) as count(*) +
//     max(updated_at) AND the EXACT order-independent content digest 'adr1:' (brand-view-dependency-readers.js
//     adsRowsDigestSql -- every row's primary key, scalar columns, source_refreshed_at and updated_at; shared with the
//     brand-view route, JS twin adsRowsDigest). count + max(updated_at) ALONE is NOT a content identity: Postgres now()
//     is the TRANSACTION START time, so an UPDATE (or a delete + insert) whose updated_at is not above the current max,
//     with an unchanged count and content_rev, moves neither (the WP9 v2 probe Q1a/Q1b false 'current'); the digest
//     changes on ANY row insert / update / delete in the window (updated_at is trigger-touched to now() on every
//     UPDATE -- 20260729_automated_ads_sync.sql -- and defaults to now() on INSERT, so every write gives its key a new
//     instant). Plus the campaign->brand mapping revision (campaignMappingRevision -- the SAME function the Brand View
//     fingerprint uses) per organization;
//   - the org Product Catalog pointer(s) (payload_sha, validated_at, object_path);
//   - the DERIVATION-CODE identity (brandViewCodeIdentity(DERIVE_REV): the Brand View report versions, the compact
//     inventory version, ACTIVE_ADS_SOURCE_KEY and this route's DERIVE_REV), so a deploy that changes the derivation
//     re-arms every unit whose inputs did not change.
// A write to ANY of those inputs changes the token; a re-read of unchanged inputs yields the same token (stable).
//
// SQL: single read-only SELECT/WITH statements over metadata columns (plus the tiny jsonb fields the serve's own reads
// filter on: payload->>'inventoryAvailable', params->>'reportVersion', the directory entries; the Ads-row digest hashes
// the rows' SCALAR columns in the database and returns one short string per account). Every timestamp is read
// as TEXT in one canonical UTC microsecond form (to_char ... 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') and every date as
// ::text -- never a JS Date (an IST host shifts a day). No DataDoe; no payload beyond those jsonb fields. 7-bit ASCII, LF.

import { createHash } from "node:crypto";
import { marketplaceToday } from "../../../marketplaces.js";
import { stableJson } from "../../sync/publication-binding.js";
import { regionForCountry, REGION_SCOPES } from "../../sync/scheduler-scope.js";
import { campaignMappingRevision } from "../../reports/campaign-ads-aggregation.js";
import { BRAND_INVENTORY_REPORT_VERSION } from "../../reports/brand-view.js";
import { ACTIVE_ADS_SOURCE_KEY } from "../../active-ads-source.js";
import { brandViewAdsWindow, adsRowsDigestSql, EMPTY_ADS_ROWS_DIGEST, brandViewCodeIdentity } from "../../sync/brand-view-dependency-readers.js";
import { ROUTE_CLI_SCRIPT } from "../route-contract.js";

const S = (v) => (v == null ? "" : String(v));
const sha256 = (v) => createHash("sha256").update(String(v)).digest("hex");

// DERIVATION REVISION of this route: BUMP IT on ANY change to the code that turns unchanged inputs into a different
// portfolio payload -- brand-view.js buildBrandViewPortfolioSnapshot / buildAccountBrandSlice / assembleBrandViewPayload
// (and the aggregators they call), the composition's deriveBrandViewPortfolio (report-materialization-brandview-
// composition.js), the shared membership (brand-directory-membership.js) or this route's release derive. It is folded
// into pf1 AND pfm2 (PORTFOLIO_CODE_IDENTITY), so a deploy that changes derivation re-publishes every unit once.
export const DERIVE_REV = 1;
// The derivation-code identity pf1 / pfm2 bind (report versions + ACTIVE_ADS_SOURCE_KEY + DERIVE_REV).
export const PORTFOLIO_CODE_IDENTITY = Object.freeze(brandViewCodeIdentity(DERIVE_REV));

export const ROUTE_ID = "brand-view-portfolio";
export const PUBLISHER_KEY = "brand-view-portfolio";
export const REGION_TARGET_PREFIX = "region:";
export const BRAND_SALES_KEY = "brand-sales";
export const BRAND_INVENTORY_KEY = "brand-inventory";
// Every report_snapshots key a portfolio build reads per member account (buildAccountBrandSlice: brand-sales, the
// ASIN->brand map inputs incl. fba-plan + listing-health, the brand-inventory compact + its legacy fallback).
export const PORTFOLIO_SNAPSHOT_KEYS = Object.freeze([
  "brand-sales", "brand-inventory", "fba-plan", "listing-health",
  "sku-pl", "sales-movers", "returns-leakage", "buy-box-loss", "listing-optimizer",
]);
// The pseudo report key a TIED newest-AVAILABLE compact is reported under (never a real report_snapshots key).
export const INVENTORY_AVAILABLE_KEY = "brand-inventory-available";
// The browser identity as-of marketplace (BrandPortfolio.jsx: marketplaceToday("IN")).
export const PORTFOLIO_ASOF_MARKETPLACE = "IN";
// The rollout-owner id grammar (saved-data-reconciler.js ROUTE_OWNER_ID_RE): a universe id outside it can never own
// controls, so its region fails closed (typed) instead of silently shrinking a member set.
const OWNER_ID_RE = /^[A-Za-z0-9._-]{1,120}$/;

/** The browser's portfolio identity as-of at `now` (ms | Date): the IN calendar day. */
export function portfolioAsOf(now) {
  const d = now instanceof Date ? now : new Date(Number(now));
  return marketplaceToday(PORTFOLIO_ASOF_MARKETPLACE, d);
}

// The evidence clock of one read (ms): ctx.now as a number | Date | () => number, else the wall clock. The SQL params and
// the compose of ONE evidence read MUST share it (the Ads build window below is derived from the IN as-of).
const nowMsOf = (now) => (typeof now === "function" ? Number(now()) : (now instanceof Date ? now.getTime() : (now == null ? Date.now() : Number(now))));

/**
 * The Ads BUILD WINDOW of a portfolio at `asOf`: EXACTLY buildAccountBrandSlice's getAdsRows window (brand-view.js:
 * `monthBack(asOf, 5)?.from || monthStart(asOf)` .. asOf -- six calendar months; pinned by the route test). The ONE
 * implementation both Brand View routes share (brand-view-dependency-readers.js brandViewAdsWindow).
 */
export function adsBuildWindow(asOf) {
  return brandViewAdsWindow(asOf);
}

// ---- canonical instants: REST ('2026-09-24T00:16:03.1234+00:00') and SQL to_char ('...03.123400Z') compare EQUAL ----
const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?\s*(Z|z|[+-]\d{2}(?::?\d{2})?)$/;
/** A timestamptz text in ONE canonical UTC microsecond form 'YYYY-MM-DDTHH:MM:SS.ffffffZ' ('' when unparsable). */
export function canonicalInstant(value) {
  const m = INSTANT_RE.exec(S(value).trim());
  if (!m) return "";
  let offMin = 0;
  if (m[8] !== "Z" && m[8] !== "z") {
    const sign = m[8][0] === "-" ? -1 : 1;
    const digits = m[8].slice(1).replace(":", "");
    offMin = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || 0));
  }
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) - offMin * 60000;
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toISOString().slice(0, 19) + "." + (m[7] || "").padEnd(6, "0").slice(0, 6) + "Z";
}

/** A report_snapshots row's canonical IDENTITY { id, h, v, sra, ua } (null for no row) -- REST or SQL shaped. */
export function snapshotIdentity(row) {
  if (!row) return null;
  const params = row.params && typeof row.params === "object" ? row.params : null;
  return {
    id: S(row.id),
    h: S(row.params_hash),
    v: row.report_version != null ? S(row.report_version) : S(params && params.reportVersion),
    sra: canonicalInstant(row.source_refreshed_at != null ? row.source_refreshed_at : row.sra),
    ua: canonicalInstant(row.updated_at != null ? row.updated_at : row.ua),
  };
}

/** The token-material entry of a rank-1 row group: its identity, null when ABSENT, { ambiguous, ids } when TIED. */
export function groupIdentity(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return null;
  if (list.length === 1) return snapshotIdentity(list[0]);
  return { ambiguous: true, ids: list.map((r) => S(r.id)).sort() };
}
/** True for a TIED (ambiguous) latest-row identity. */
export const isAmbiguousIdentity = (ident) => !!(ident && ident.ambiguous === true);

// A directory entry field's JSON VALUE from its ->> text + jsonb_typeof (the serve reads the parsed JSON: a numeric
// name stays a number). A row without the *_kind column (an older projection) reads the text as a string.
function jsonFieldValue(row, col) {
  const text = row ? row[col] : null;
  const kind = row && Object.prototype.hasOwnProperty.call(row, col + "_kind") ? row[col + "_kind"] : (text == null ? null : "string");
  if (text == null || kind == null || kind === "null") return null;
  if (kind === "string") return S(text);
  if (kind === "number") return Number(text);
  if (kind === "boolean") return S(text) === "true";
  try { return JSON.parse(S(text)); } catch (_e) { return S(text); }
}

// ---- the evidence SQL (read-only; route-contract.js isReadOnlyEvidenceSql) ------------------------------------------
const TS = (col) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export const EVIDENCE_SQL = Object.freeze([
  Object.freeze({
    name: "account_directory",
    // The serve's directory read (getLatestReportSnapshot account-directory / __account-directory__), expanded to the
    // entry fields the page + serve use. `inactive` = active === false; `setting_up` = settingUp === true (JSON booleans).
    text: "with d as (select payload from public.report_snapshots where report_key = 'account-directory' and account_id = '__account-directory__' order by updated_at desc limit 1) "
      + "select e.ord::int as ord, jsonb_typeof(e.value) as kind, e.value->>'id' as id, e.value->>'name' as name, jsonb_typeof(e.value->'name') as name_kind, "
      + "e.value->>'country' as country, jsonb_typeof(e.value->'country') as country_kind, "
      + "coalesce((e.value->'active') = 'false'::jsonb, false) as inactive, coalesce((e.value->'settingUp') = 'true'::jsonb, false) as setting_up "
      + "from d cross join lateral jsonb_array_elements(case when jsonb_typeof(d.payload->'accounts') = 'array' then d.payload->'accounts' else '[]'::jsonb end) with ordinality as e(value, ord) "
      + "order by e.ord",
    params: () => [],
  }),
  Object.freeze({
    name: "snapshot_latest",
    // EVERY rank-1 row (newest updated_at) per (report_key, account_id) -- getLatestReportSnapshot's selection. rank(),
    // never DISTINCT ON: more than one row per pair is a TIE (ambiguous latest -- the serve's own pick is then arbitrary).
    text: "with ranked as (select id, rank() over (partition by report_key, account_id order by updated_at desc) as rnk "
      + "from public.report_snapshots where report_key = any($1::text[])) "
      + "select report_key, account_id, id::text as id, params_hash, "
      + "coalesce(params->>'reportVersion', '') as report_version, " + TS("source_refreshed_at") + " as sra, " + TS("updated_at") + " as ua "
      + "from public.report_snapshots where id in (select id from ranked where rnk = 1) "
      + "order by report_key, account_id, id",
    params: () => [PORTFOLIO_SNAPSHOT_KEYS.slice()],
  }),
  Object.freeze({
    name: "inventory_available",
    // getInventorySnapshotCandidates' AVAILABLE read: the newest compact whose inline payload says available, at the
    // compact report version -- every rank-1 row (a tie is ambiguous, like snapshot_latest).
    text: "with ranked as (select id, rank() over (partition by account_id order by updated_at desc) as rnk "
      + "from public.report_snapshots where report_key = 'brand-inventory' and payload->>'inventoryAvailable' = 'true' and params->>'reportVersion' = $1) "
      + "select account_id, id::text as id, params_hash, coalesce(params->>'reportVersion', '') as report_version, "
      + TS("source_refreshed_at") + " as sra, " + TS("updated_at") + " as ua "
      + "from public.report_snapshots where id in (select id from ranked where rnk = 1) "
      + "order by account_id, id",
    params: () => [BRAND_INVENTORY_REPORT_VERSION],
  }),
  Object.freeze({
    name: "ads_state",
    text: "select account_id, coalesce(last_status, '') as last_status, coalesce(latest_metric_date::text, '') as latest_metric_date, coalesce(content_rev, '') as content_rev "
      + "from public.ads_sync_state where source_key = $1 order by account_id",
    params: () => [ACTIVE_ADS_SOURCE_KEY],
  }),
  Object.freeze({
    name: "ads_coverage",
    text: "select account_id, covered_from::text as covered_from, covered_to::text as covered_to "
      + "from public.ads_sync_coverage where source_key = $1 and status = 'succeeded' order by account_id, covered_from, covered_to",
    params: () => [ACTIVE_ADS_SOURCE_KEY],
  }),
  Object.freeze({
    name: "ads_rows",
    // The durable Ads rows the build reads per account over the EXACT build window (adsBuildWindow of the IN as-of at the
    // read's `now`): count(*) + max(updated_at) and the EXACT content digest rows_digest ('adr1:', the SHARED
    // adsRowsDigestSql -- count + max alone is not a content identity, see the header). The window is echoed so the
    // compose can prove the rows were digested over ITS window (a params/compose clock split across the IN midnight
    // fails closed). $2 / $3 are only ever cast to date (one deduced parameter type) and echoed through a DateStyle-
    // independent to_char. An account with no row in the window has no result row (its digest is EMPTY_ADS_ROWS_DIGEST).
    text: "select account_id, count(*)::text as n, " + TS("max(updated_at)") + " as max_ua, "
      + adsRowsDigestSql("") + " as rows_digest, "
      + "to_char($2::date, 'YYYY-MM-DD') as win_from, to_char($3::date, 'YYYY-MM-DD') as win_to "
      + "from public.ads_daily_source_rows where source_key = $1 and metric_date >= $2::date and metric_date <= $3::date "
      + "group by account_id order by account_id",
    params: (ctx = {}) => { const w = adsBuildWindow(portfolioAsOf(nowMsOf(ctx && ctx.now))); return [ACTIVE_ADS_SOURCE_KEY, w.from, w.to]; },
  }),
  Object.freeze({
    name: "campaign_mappings",
    text: "select organization_fingerprint, account_id, marketplace, ads_profile_id, ad_campaign_id, canonical_brand_key "
      + "from public.campaign_brand_mapping where connection_id = 'primary' "
      + "order by organization_fingerprint, account_id, marketplace, ads_profile_id, ad_campaign_id",
    params: () => [],
  }),
  Object.freeze({
    name: "catalog",
    text: "select organization_fingerprint, payload_sha, object_path, " + TS("validated_at") + " as validated_at "
      + "from public.source_snapshots where connection_id = 'primary' and source_key = 'product-catalog' and scope_key = '__organization' "
      + "order by organization_fingerprint",
    params: () => [],
  }),
]);

const rowsOf = (rowsByName, name) => {
  const v = rowsByName instanceof Map ? rowsByName.get(name) : rowsByName && rowsByName[name];
  return Array.isArray(v) ? v : [];
};

/**
 * The browser-parity DIRECTORY projection of the account-directory entry rows (PURE):
 *   serveAccountsById  { id: { name, country } }  -- the serve's accountsById (LAST entry of a duplicated id wins, exactly
 *                                                    like Object.fromEntries), used by filterAccountIdsToRegion + the build;
 *   displayIds         sorted ids                 -- EVERY selectable primary account (active !== false, any region): the
 *                                                    account set the page's brand directory computes membership over, so
 *                                                    it decides each brand's DISPLAY label (brand-membership.js pickDisplay
 *                                                    picks the smallest variant ACROSS ALL accounts, not per region);
 *   byRegion           Map(region -> sorted ids)  -- the selectable accounts whose TRUSTED country routes to the region
 *                                                    (the region's member universe + the region target's owners);
 *   flags              { id: { settingUp, dup } } -- per-id unit-eligibility flags;
 *   problems           typed region problems (a selectable in-region id that can never be a rollout owner).
 */
export function projectDirectory(entryRows) {
  const serveAccountsById = {};
  const counts = new Map();
  const selectable = new Map(); // id -> { settingUp }
  const byRegion = new Map(REGION_SCOPES.map((r) => [r, new Set()]));
  const problems = new Map(REGION_SCOPES.map((r) => [r, []]));
  for (const r of Array.isArray(entryRows) ? entryRows : []) {
    if (!r || S(r.kind) !== "object" || r.id == null) continue;
    const id = String(r.id);
    counts.set(id, (counts.get(id) || 0) + 1);
    // The serve's `entry.name || null` / `entry.country || null` over the entry's JSON VALUES (never the ->> text).
    serveAccountsById[id] = { name: jsonFieldValue(r, "name") || null, country: jsonFieldValue(r, "country") || null };
    if (r.inactive === true) continue;
    const prev = selectable.get(id);
    selectable.set(id, { settingUp: r.setting_up === true || !!(prev && prev.settingUp) });
  }
  const flags = {};
  const display = new Set();
  for (const [id, sel] of selectable) {
    // The page's membership scope: primaryAccountIdsOnly (trimmed, nonblank, never a dd-secondary / prefixed id).
    if (id.trim() === "" || id.trim() !== id || id.includes(":")) continue;
    display.add(id);
    const region = regionForCountry(serveAccountsById[id] && serveAccountsById[id].country);
    if (!byRegion.has(region)) continue;
    if (!OWNER_ID_RE.test(id)) { problems.get(region).push("directory-id-invalid"); continue; }
    byRegion.get(region).add(id);
    flags[id] = { settingUp: sel.settingUp === true, dup: (counts.get(id) || 0) > 1 };
  }
  const regions = new Map();
  for (const [r, set] of byRegion) regions.set(r, [...set].sort());
  return { serveAccountsById, displayIds: [...display].sort(), byRegion: regions, flags, problems };
}

/**
 * The FULL evidence of every region (PURE over the SQL rows) -> Map(region -> evidence), each:
 *   { region, asOf, adsWindow, token, universe: sorted ids, accounts: { id: { name, country, settingUp, dup } },
 *     snaps: { id: { reportKey: identity|null|{ ambiguous, ids } } }, invAvail: { id: identity|null|{ ambiguous, ids } },
 *     ambiguous: { id: [reportKey | 'brand-inventory-available'] } (only accounts with a TIED latest row),
 *     ads: { id: { status, latestMetricDate, contentRev, windows, rows, rowsMaxUa, rowsDigest } }, maps: { id: { org: rev } },
 *     catalog: { org: { payloadSha, validatedAt, objectPath } }, displayIds, display: { id: brand-sales identity|... },
 *     serveAccountsById, code: the derivation-code identity, problems: [...] }
 * A region with an EMPTY universe is still returned (token over the empty set) -- callers decide eligibility.
 * `code` is a TEST seam only (default PORTFOLIO_CODE_IDENTITY; no production caller passes it).
 */
export function composeBrandViewPortfolioEvidence(rowsByName, { now, code = PORTFOLIO_CODE_IDENTITY } = {}) {
  const nowMs = nowMsOf(now);
  const asOf = portfolioAsOf(nowMs);
  const adsWindow = adsBuildWindow(asOf);
  const codeIdentity = { ...code };
  const dir = projectDirectory(rowsOf(rowsByName, "account_directory"));
  const group = (list, keyOf) => { const m = new Map(); for (const r of list) { const k = keyOf(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
  const latest = group(rowsOf(rowsByName, "snapshot_latest"), (r) => S(r.report_key) + "|" + S(r.account_id)); // -> rank-1 rows
  const avail = group(rowsOf(rowsByName, "inventory_available"), (r) => S(r.account_id));
  const adsState = new Map(rowsOf(rowsByName, "ads_state").map((r) => [S(r.account_id), r]));
  // The Ads row stats + exact content digest: every row must have been digested over THIS evidence's build window (else
  // fail closed, typed).
  const adsRows = new Map();
  const globalProblems = [];
  for (const r of rowsOf(rowsByName, "ads_rows")) {
    if (S(r.win_from) !== adsWindow.from || S(r.win_to) !== adsWindow.to) { if (!globalProblems.includes("ads-rows-window-mismatch")) globalProblems.push("ads-rows-window-mismatch"); continue; }
    adsRows.set(S(r.account_id), { n: S(r.n) || "0", maxUa: canonicalInstant(r.max_ua), digest: S(r.rows_digest) });
  }
  const adsWin = new Map();
  for (const r of rowsOf(rowsByName, "ads_coverage")) {
    const id = S(r.account_id);
    if (!adsWin.has(id)) adsWin.set(id, []);
    adsWin.get(id).push(S(r.covered_from) + ".." + S(r.covered_to));
  }
  const mapRows = new Map(); // `${org}|${id}` -> rows
  const orgs = new Set();
  for (const r of rowsOf(rowsByName, "campaign_mappings")) {
    const org = S(r.organization_fingerprint); orgs.add(org);
    const k = org + "|" + S(r.account_id);
    if (!mapRows.has(k)) mapRows.set(k, []);
    mapRows.get(k).push(r);
  }
  const catalog = {};
  for (const r of rowsOf(rowsByName, "catalog")) {
    const org = S(r.organization_fingerprint); orgs.add(org);
    catalog[org] = { payloadSha: S(r.payload_sha), validatedAt: canonicalInstant(r.validated_at), objectPath: S(r.object_path) };
  }
  const orgList = [...orgs].sort();
  // The DISPLAY universe's brand-sales identities (every selectable account, any region): a change there can relabel a
  // region brand (pickDisplay is global), so it is part of EVERY region's token.
  const display = {};
  for (const id of dir.displayIds) display[id] = groupIdentity(latest.get(BRAND_SALES_KEY + "|" + id));
  const out = new Map();
  for (const region of REGION_SCOPES) {
    const universe = dir.byRegion.get(region) || [];
    const accounts = {}; const snaps = {}; const invAvail = {}; const ads = {}; const maps = {}; const ambiguous = {};
    for (const id of universe) {
      const meta = dir.serveAccountsById[id] || { name: null, country: null };
      accounts[id] = { name: meta.name, country: meta.country, settingUp: dir.flags[id].settingUp, dup: dir.flags[id].dup };
      snaps[id] = {};
      const tied = [];
      for (const rk of PORTFOLIO_SNAPSHOT_KEYS) { snaps[id][rk] = groupIdentity(latest.get(rk + "|" + id)); if (isAmbiguousIdentity(snaps[id][rk])) tied.push(rk); }
      invAvail[id] = groupIdentity(avail.get(id));
      if (isAmbiguousIdentity(invAvail[id])) tied.push(INVENTORY_AVAILABLE_KEY);
      if (tied.length) ambiguous[id] = tied;
      const st = adsState.get(id) || null;
      const rs = adsRows.get(id) || null;
      ads[id] = {
        status: st ? (S(st.last_status) || "missing") : "missing",
        latestMetricDate: st ? S(st.latest_metric_date) : "",
        contentRev: st ? S(st.content_rev) : "",
        windows: (adsWin.get(id) || []).slice().sort(),
        rows: rs ? rs.n : "0",
        rowsMaxUa: rs ? rs.maxUa : "",
        // The EXACT content digest of the account's build-window Ads rows (no row -> the empty-set digest, which is what
        // the JS twin computes over an empty REST read).
        rowsDigest: rs ? rs.digest : EMPTY_ADS_ROWS_DIGEST,
      };
      maps[id] = {};
      for (const org of orgList) maps[id][org] = campaignMappingRevision(mapRows.get(org + "|" + id) || []);
    }
    const manifest = { v: "pf1", route: ROUTE_ID, region, asOf, adsWindow, universe, accounts, snaps, invAvail, ads, maps, catalog, display, code: codeIdentity };
    out.set(region, {
      region, asOf, adsWindow, token: "pf1:" + sha256(stableJson(manifest)), universe, accounts, snaps, invAvail, ambiguous, ads, maps, catalog,
      displayIds: dir.displayIds, display, serveAccountsById: dir.serveAccountsById, code: codeIdentity,
      problems: [...new Set([...globalProblems, ...(dir.problems.get(region) || [])])].sort(),
    });
  }
  return out;
}

/**
 * The worker contract: Map<'region:<r>', { token, owners, region, alerts: [] }> for every region with a non-empty
 * universe -- ONLY `region`'s target when given (the WP11 pinned ctx: a region scan never yields another region's
 * target). The owners (every member, incl. settingUp accounts) are informational: they never gate the region target
 * (routes.js ownersGateTarget; the per-unit publisher AND gate covers the members).
 */
export function composeRegionTokens(rowsByName, { now, region: only = null } = {}) {
  const out = new Map();
  for (const [region, ev] of composeBrandViewPortfolioEvidence(rowsByName, { now })) {
    if (!ev.universe.length || (only != null && region !== only)) continue;
    out.set(REGION_TARGET_PREFIX + region, { token: ev.token, owners: ev.universe.slice(), region, alerts: [] });
  }
  return out;
}

/**
 * The tier-1 live-row scope of a REGION target: the region's OWN portfolio rows (params->>'region'), never every
 * region's -- else each region's scan would re-arm on the other regions' writes. target = { targetKey: 'region:<r>',
 * region } (the WP11 pinned tier-1 target) or the bare target key; an unresolvable region THROWS (fail closed).
 */
export function portfolioLiveRowScope(target) {
  const key = typeof target === "string" ? target : S(target && target.targetKey);
  const region = typeof target === "object" && target && target.region != null ? S(target.region) : (key.startsWith(REGION_TARGET_PREFIX) ? key.slice(REGION_TARGET_PREFIX.length) : "");
  if (!REGION_SCOPES.includes(region) || (key !== "" && key !== REGION_TARGET_PREFIX + region)) throw new Error("brand-view-portfolio liveRowScope: a 'region:<r>' target is required (fail closed).");
  return { reportKey: "brand-view-portfolio", accountIdLike: "brand-view-portfolio:%", paramsEq: { region } };
}

export default Object.freeze({
  id: ROUTE_ID,
  kind: "route-cli",
  cli: Object.freeze({ script: ROUTE_CLI_SCRIPT, fixedArgs: Object.freeze([]) }),
  publisherKeys: Object.freeze([PUBLISHER_KEY]),
  liveReportKeys: Object.freeze(["brand-view-portfolio"]),
  grain: "region",
  unit: "region-brand",
  // Every upstream a member's portfolio slice reads (region scope): brand-sales (oli), brand-inventory (fba), fba-plan,
  // returns-leakage (returns-v3), and the brand-view-brands directory route.
  awaits: Object.freeze(["oli", "fba", "fba-plan", "returns-v3", "brand-view-brands"]),
  deps: Object.freeze({
    sources: Object.freeze([ACTIVE_ADS_SOURCE_KEY, "product-catalog", "campaign-brand-mapping"]),
    reports: Object.freeze([...PORTFOLIO_SNAPSHOT_KEYS, "account-directory"]),
  }),
  evidence: Object.freeze({
    sql: EVIDENCE_SQL,
    compose: (rowsByName, ctx = {}) => composeRegionTokens(rowsByName, { now: ctx.now, region: ctx.region == null ? null : ctx.region }),
    everySeconds: 600,
  }),
  // The browser identity as-of (IN calendar day) -- identical for every region target.
  identityAsOf: (_target, { now } = {}) => portfolioAsOf(now == null ? Date.now() : now),
  tier1: Object.freeze({ liveRowScope: portfolioLiveRowScope }),
  deadlineSeconds: 720,
  hardTimeoutSeconds: 840,
  // One account's saved payloads at a time (sliceConcurrency 1); a configured child cap below this is capacity-exceeded.
  childHeapMb: 448,
  minChildHeapMb: 448,
  priority: 8,
  scanGroup: "brand-view",
});
