// Publication recovery WP8 -- WORKER-side declaration of the zero-export `brand-view` recovery route (the account-scoped
// Brand View, api/datadoe.js brand-view: report_key brand-view, version brand-view-account-scoped-v2, live account
// brandViewScopeId(owner, brand), params { accountId: owner, brand, asOf }). Job per ACCOUNT; units = the brands of the
// account's exact live brand-view-brands row (each unit its own cycle / job / shadow / publish; the gate account is the
// owner). Validated fail-closed by route-contract.js; CLI-side twin: lib/server/sync/routes/brand-view.release.js.
//
// EVIDENCE (metadata-only, read-only SQL; the SAME pure compose runs in the worker and the CLI, so the worker's job token
// and the CLI's TARGETS v2 'tok' are byte-identical). Per account, the COMPLETE, STABLE upstream content identity the
// Brand View payload is assembled from -- never "whoever wrote last":
//   - the LATEST row identity { id, params_hash, source_refreshed_at, updated_at, reportVersion } of EVERY report the
//     builder reads: brand-sales, brand-inventory, and the ASIN->brand map inputs fba-plan, sku-pl, listing-health,
//     sales-movers, returns-leakage, buy-box-loss, listing-optimizer (a TIE at the newest updated_at is AMBIGUOUS ->
//     typed deferral);
//   - the SELECTED authoritative brand-inventory compact (selectAuthoritativeInventorySnapshot over the SAME two
//     candidates getInventorySnapshotCandidates returns: the newest available compact + the newest row);
//   - the Ads state (ads_sync_state last_status / latest_metric_date / content_rev + the succeeded coverage windows of
//     the ACTIVE Ads grain): a same-window Ads correction (content_rev only) changes it;
//   - the durable Ads ROWS the build reads (ads_daily_source_rows, the ACTIVE source over the build window
//     brandViewAdsWindow(asOf) = monthBack(asOf, 5).from .. asOf, per account at ITS marketplace as-of): the EXACT
//     order-independent content digest 'adr1:' (brand-view-dependency-readers.js adsRowsDigestSql -- the SAME definition
//     the portfolio route and the derive's strict REST cross-check use), taken over the window of the evidence as-of
//     (echo-checked by the compose: 'ads-rows-window-mismatch' / 'ads-rows-evidence-missing' fail closed). content_rev
//     alone does NOT bind them (it digests only the last MAX_REQUIRED_COVERAGE_DAYS of the sync run, and the rows are not
//     atomic with ads_sync_state); the digest changes on ANY row insert / update / delete in the window;
//   - the campaign->brand mapping (row count, newest updated_at, content md5): any mapping edit changes it;
//   - the org Product Catalog pointer (payload_sha, validated_at);
//   - the durable directory country / name (the builder's account meta) and the IDENTITY as-of
//     marketplaceToday(country, now) -- the browser's own value (BrandView.jsx) -- so a local-midnight roll re-enqueues;
//   - the exact live brand-view-brands row identity + its brand list (the unit set);
//   - the DERIVATION-CODE identity BRAND_VIEW_CODE_IDENTITY (brandViewCodeIdentity(DERIVE_REV): the Brand View report
//     versions, the compact inventory version, ACTIVE_ADS_SOURCE_KEY and this route's DERIVE_REV), so a deploy that
//     changes the derivation re-arms every account whose inputs did not change.
//   L1 token = 'bv1:' + sha256(stableJson(all of the above + BRAND_VIEW_VERSION)). The CLI's per-unit manifest 'bvm1:'
//   hashes this token, so it binds all of the above too.
// A TIED latest row enters the material as { ambiguous: true, ids } (never as null), and an ineligible account's typed
// problems are bound too -- so an ambiguous / ineligible evidence set can never share a token with an eligible one whose
// source is merely absent (the tie binding adds nothing to an eligible account). The worker compose returns token null + the
// typed reason for an ineligible or unroutable account (the returns-v3 compose contract); the CLI's revision refuses it
// with the SAME reason.
// It is a SUPERSET of the legacy dependency-fingerprint inputs (brand-view-dependency-fingerprint.js), which stays the
// serve-parity params.depFingerprint (computed by the CLI with the extracted readers). Pure; no I/O. paramsHashFor comes
// from the PURE leaf report-params-hash.js (never report-store.js, whose supabase.js writers must stay out of the
// worker's import graph). 7-bit ASCII, LF.

import { createHash } from "node:crypto";
import { ROUTE_CLI_SCRIPT } from "../route-contract.js";
import {
  ASIN_BRAND_SNAPSHOT_KEYS, BRAND_INVENTORY_SNAPSHOT_KEY, BRAND_INVENTORY_REPORT_VERSION, BRAND_VIEW_BRANDS_VERSION, BRAND_VIEW_VERSION,
  selectAuthoritativeInventorySnapshot,
} from "../../reports/brand-view.js";
import { ACTIVE_ADS_SOURCE_KEY } from "../../active-ads-source.js";
import { paramsHashFor } from "../../report-params-hash.js";
import { marketplaceToday } from "../../../marketplaces.js";
import { stableJson } from "../../sync/publication-binding.js";
import {
  snapshotRowIdentity, canonicalInstant, adsRowsDigestSql, brandViewAdsWindow, brandViewCodeIdentity,
} from "../../sync/brand-view-dependency-readers.js";
import {
  LATEST_ROWS_SQL, evidenceAccountIds, regionOfCountry, directoryEntry, groupLatestRows, evidenceMaterialEntry, targetAccountId, recoveryNowDate,
  routingIneligibleReason,
} from "./brand-view-brands.route.js";

const S = (v) => (v == null ? "" : String(v));
const sha256 = (v) => createHash("sha256").update(String(v)).digest("hex");

// DERIVATION REVISION of this route: BUMP IT on ANY change to the code that turns unchanged inputs into a different
// account-scoped Brand View payload -- brand-view.js buildBrandViewSnapshot / buildAccountBrandSlice /
// assembleBrandViewPayload (and the aggregators they call), the composition's deriveBrandView
// (report-materialization-brandview-composition.js) or this route's release derive (brand-view.release.js). It is
// folded into bv1 (and so into the CLI's bvm1 manifest) via BRAND_VIEW_CODE_IDENTITY.
export const DERIVE_REV = 1;
// The derivation-code identity bv1 binds (report versions + ACTIVE_ADS_SOURCE_KEY + DERIVE_REV).
export const BRAND_VIEW_CODE_IDENTITY = Object.freeze(brandViewCodeIdentity(DERIVE_REV));

export const BRAND_VIEW_ROUTE_ID = "brand-view";
export const BRAND_VIEW_PUBLISHER_KEY = "brand-view";
export const BRAND_VIEW_TOKEN_PREFIX = "bv1:";
// EVERY report_snapshots key buildAccountBrandSlice reads for one account (brand-sales, the ASIN->brand map inputs, the
// compact inventory + its fba-plan / listing-health fallbacks), in a stable order.
export const BRAND_VIEW_EVIDENCE_REPORT_KEYS = Object.freeze([...new Set(["brand-sales", BRAND_INVENTORY_SNAPSHOT_KEY, ...ASIN_BRAND_SNAPSHOT_KEYS])]);
// The pseudo report key the newest-AVAILABLE-compact rows are grouped under (never a real report_snapshots key).
const INVENTORY_AVAILABLE_KEY = "brand-inventory-available";

const TS = (col) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const INV_COLS = "s.params->>'reportVersion' as report_version, s.payload->'inventoryAvailable' as inv_available, s.payload->'inventoryDate' as inv_date,"
  + " s.payload->'inventorySnapshotDate' as inv_snapshot_date, jsonb_typeof(s.payload->'inventoryByBrandCountry') as inv_ibbc_type";

// The newest AVAILABLE compact per account (getInventorySnapshotCandidates' first read): $1 accounts, $2 the compact version.
export const INVENTORY_AVAILABLE_SQL = "with ranked as ("
  + " select s.id, rank() over (partition by s.account_id order by s.updated_at desc) as rnk from public.report_snapshots s"
  + " where s.report_key = 'brand-inventory' and s.account_id = any($1::text[]) and s.payload->>'inventoryAvailable' = 'true' and s.params->>'reportVersion' = $2::text"
  + ") select s.report_key, s.account_id, s.id::text as id, s.params_hash,"
  + ` ${TS("s.source_refreshed_at")} as source_refreshed_at, ${TS("s.updated_at")} as updated_at, ${INV_COLS}`
  + " from ranked r join public.report_snapshots s on s.id = r.id where r.rnk = 1";

// The EXACT brand-view-brands row per account (the serve's cache-first identity): $1 accounts, $2 their params hashes.
export const DIRECTORY_ROWS_SQL = "select s.account_id, s.id::text as id, s.params_hash,"
  + ` ${TS("s.source_refreshed_at")} as source_refreshed_at, ${TS("s.updated_at")} as updated_at,`
  + " s.params->>'reportVersion' as report_version, (s.payload is not null) as inline_payload, s.payload->'brands' as brands,"
  + " s.payload->>'accountId' as payload_account_id"
  + " from public.report_snapshots s where s.report_key = 'brand-view-brands' and s.account_id = any($1::text[]) and s.params_hash = any($2::text[])";

// The ACTIVE Ads grain state + succeeded coverage windows per account (getDailyAdsCoverage's two reads): $1 accounts, $2 source key.
// Dates are rendered with an explicit to_char (never date::text, whose output follows the session DateStyle).
export const ADS_STATE_SQL = "select a.account_id, (st.account_id is not null) as has_state, st.last_status,"
  + " to_char(st.latest_metric_date, 'YYYY-MM-DD') as latest_metric_date, st.content_rev,"
  + " (select string_agg(to_char(c.covered_from, 'YYYY-MM-DD') || '..' || to_char(c.covered_to, 'YYYY-MM-DD'), ',' order by c.covered_from, c.covered_to)"
  + " from public.ads_sync_coverage c where c.account_id = a.account_id and c.source_key = $2::text and c.status = 'succeeded') as windows"
  + " from unnest($1::text[]) as a(account_id) left join public.ads_sync_state st on st.account_id = a.account_id and st.source_key = $2::text";

// The primary-connection campaign->brand mapping per account (getCampaignBrandMappings' filter): $1 accounts, $2 org.
export const CAMPAIGN_MAPPING_SQL = "select m.account_id, count(*)::int as n, " + TS("max(m.updated_at)") + " as max_updated_at,"
  + " md5(string_agg(m.marketplace || '|' || m.ads_profile_id || '|' || m.ad_campaign_id || '|' || m.canonical_brand_key || '|'"
  + " || m.brand_display_name || '|' || m.mapping_source || '|' || " + TS("m.updated_at") + ", ','"
  + " order by m.marketplace collate \"C\", m.ads_profile_id collate \"C\", m.ad_campaign_id collate \"C\")) as content_md5"
  + " from public.campaign_brand_mapping m where m.organization_fingerprint = $2::text and m.connection_id = 'primary'"
  + " and m.account_id = any($1::text[]) group by m.account_id";

// The org Product Catalog pointer (getSourceSnapshot's read; never the payload): $1 org.
export const PRODUCT_CATALOG_SQL = "select c.organization_fingerprint, c.payload_sha, " + TS("c.validated_at") + " as validated_at, c.source_request_hash"
  + " from public.source_snapshots c where c.connection_id = 'primary' and c.source_key = 'product-catalog' and c.scope_key = '__organization'"
  + " and c.organization_fingerprint = $1::text";

// The EXACT content digest of each account's durable Ads rows over ITS build window (the rows buildAccountBrandSlice's
// getAdsRows reads): $1 accounts, $2 / $3 their window from / to ('YYYY-MM-DD' text, only ever cast to date), $4 the
// ACTIVE source key. The SHARED adsRowsDigestSql (brand-view-dependency-readers.js; the derive's strict REST cross-check
// computes its JS twin adsRowsDigest over the rows it read). LEFT JOIN from the account list: EVERY requested account has
// exactly one result row (no rows -> the empty-set digest); the window is echoed through a DateStyle-independent to_char
// so the compose can prove the digest was taken over the window of ITS as-of (a params / compose clock split across a
// local midnight fails closed, typed 'ads-rows-window-mismatch').
export const ADS_ROWS_SQL = "select a.account_id, to_char(a.win_from::date, 'YYYY-MM-DD') as win_from, to_char(a.win_to::date, 'YYYY-MM-DD') as win_to, "
  + adsRowsDigestSql("r.") + " as rows_digest"
  + " from unnest($1::text[], $2::text[], $3::text[]) as a(account_id, win_from, win_to)"
  + " left join public.ads_daily_source_rows r on r.account_id = a.account_id and r.source_key = $4::text"
  + " and r.metric_date >= a.win_from::date and r.metric_date <= a.win_to::date"
  + " group by a.account_id, a.win_from, a.win_to";

/**
 * The per-account Ads build windows an evidence read digests (PURE): for every evidence account with a directory country,
 * brandViewAdsWindow(marketplaceToday(country, now)) -- `now` normalized ONCE (recoveryNowDate). -> { ids, froms, tos }
 * (parallel arrays; an account without a country has no window -- it is ineligible 'directory-country-missing').
 */
export function adsRowsWindows(ctx = {}) {
  const nowDate = recoveryNowDate(ctx.now);
  const ids = []; const froms = []; const tos = [];
  for (const acct of evidenceAccountIds(ctx)) {
    const country = S((directoryEntry(ctx.directory, acct) || {}).country).trim();
    if (!country) continue;
    const w = brandViewAdsWindow(marketplaceToday(country, nowDate));
    ids.push(acct); froms.push(w.from); tos.push(w.to);
  }
  return { ids, froms, tos };
}

/** The params hash of an account's exact brand-view-brands identity (api/datadoe.js brandViewDirectory). */
export const directoryParamsHash = (accountId) => paramsHashFor(BRAND_VIEW_BRANDS_VERSION, { accountId });

// A pseudo candidate row (exactly the fields selectAuthoritativeInventorySnapshot + snapshotRowIdentity read) from an
// evidence-SQL row -- the payload fields arrive as parsed jsonb, the instants canonical.
function inventoryCandidate(r) {
  if (!r) return null;
  return {
    id: r.id, params_hash: r.params_hash, source_refreshed_at: r.source_refreshed_at, updated_at: r.updated_at,
    report_version: r.report_version, params: { reportVersion: r.report_version },
    payload: { inventoryAvailable: r.inv_available, inventoryDate: r.inv_date, inventorySnapshotDate: r.inv_snapshot_date, inventoryByBrandCountry: r.inv_ibbc_type === "array" ? [] : null },
  };
}

/** The normalized Ads identity (the SAME shape the CLI builds from getDailyAdsCoverage's REST result). */
export function adsIdentity({ hasState, status, latest, rev, windows }) {
  return {
    status: hasState ? (S(status) || "missing") : "missing",
    latest: latest == null || latest === "" ? null : S(latest),
    rev: rev == null || rev === "" ? null : S(rev),
    wins: [...(Array.isArray(windows) ? windows : [])].map(S).filter(Boolean).sort(),
  };
}

/**
 * The L1 token of one account's Brand View evidence at an identity as-of (PURE). The tied ids (ev.ambiguousIds) and
 * the typed problems (ev.problems) are bound ONLY when present. The durable Ads-row content digest (ev.adsRows.digest)
 * and the derivation-code identity (`code`, default BRAND_VIEW_CODE_IDENTITY -- the argument is a TEST seam only, no
 * production caller passes it) are ALWAYS bound. The digest's WINDOW is not material of its own: it is a pure function
 * of the evidence as-of (brandViewAdsWindow, echo-checked by the compose), and a token bound at another as-of than the
 * evidence's never publishes (the release defers 'asof-rolled') -- so a local-midnight roll that leaves the rows
 * unchanged keeps the token and still defers as the as-of roll it is.
 */
export function brandViewToken(ev, asOf, code = BRAND_VIEW_CODE_IDENTITY) {
  const tied = ev.ambiguousIds && typeof ev.ambiguousIds === "object" ? ev.ambiguousIds : {};
  const material = {
    v: BRAND_VIEW_VERSION, a: S(ev.accountId), country: S(ev.country), name: ev.name == null ? null : S(ev.name), asOf: asOf == null ? null : S(asOf),
    r: BRAND_VIEW_EVIDENCE_REPORT_KEYS.map((rk) => [rk, evidenceMaterialEntry(ev.identities[rk], tied[rk])]),
    inv: ev.inventorySelected || null, ads: ev.ads, adsRows: ev.adsRows ? S(ev.adsRows.digest) : null, map: ev.mapping, cat: ev.catalog,
    bvb: { id: ev.directory.identity, brands: ev.directory.brands },
    code: { ...code },
  };
  if (Array.isArray(tied[INVENTORY_AVAILABLE_KEY]) && tied[INVENTORY_AVAILABLE_KEY].length) material.invTied = tied[INVENTORY_AVAILABLE_KEY].map(S).sort();
  if (Array.isArray(ev.problems) && ev.problems.length) material.p = ev.problems.map(S);
  return BRAND_VIEW_TOKEN_PREFIX + sha256(stableJson(material));
}

/** The typed reason one account's Brand View evidence is INELIGIBLE, or null (PURE; the CLI revision + the worker compose). */
export function brandViewIneligibleReason(ev) {
  if (!ev || typeof ev !== "object" || !ev.identities || !ev.directory) return "brand-view-evidence-missing";
  if (Array.isArray(ev.problems) && ev.problems.length) return S(ev.problems[0]);
  return null;
}

/**
 * PURE compose (shared by the worker and the CLI): rowsByName -> Map(accountId -> evidence) for EVERY account in
 * `accountIds`. ctx: { accountIds, directory (Map id -> { country, name, currency }), now (a function, a Date or epoch
 * ms -- normalized ONCE by recoveryNowDate; absent = the wall clock; the SQL params MUST have been computed with the
 * SAME now -- the Ads-row window is checked), organizationFingerprint }.
 * evidence: { accountId, country, name, currency, region, asOf, identities, ambiguousIds, inventorySelected, ads,
 *             adsRows: { from, to, digest } | null, mapping, catalog, directory: { identity, inline, brands },
 *             problems: [typed reason], token }
 */
export function composeBrandViewEvidence(rowsByName, ctx = {}) {
  const accountIds = Array.isArray(ctx.accountIds) ? ctx.accountIds : evidenceAccountIds(ctx);
  const nowDate = recoveryNowDate(ctx.now);
  const org = S(ctx.organizationFingerprint);
  const R = rowsByName || {};
  const latest = groupLatestRows(R.latest_rows);
  const available = groupLatestRows((R.inventory_available || []).map((r) => ({ ...r, report_key: INVENTORY_AVAILABLE_KEY })));
  const byAcct = (rows) => { const m = new Map(); for (const r of Array.isArray(rows) ? rows : []) { const a = S(r && r.account_id); if (!m.has(a)) m.set(a, []); m.get(a).push(r); } return m; };
  const dirRows = byAcct(R.directory_rows); const adsRows = byAcct(R.ads_state); const mapRows = byAcct(R.campaign_mapping);
  const adsRowDigests = byAcct(R.ads_rows);
  const catRows = (Array.isArray(R.product_catalog) ? R.product_catalog : []).filter((r) => org !== "" && S(r && r.organization_fingerprint) === org);
  const catalog = catRows.length === 1 ? { sha: S(catRows[0].payload_sha), at: canonicalInstant(catRows[0].validated_at) } : null;
  const out = new Map();
  for (const acct of accountIds) {
    const problems = [];
    const dir = directoryEntry(ctx.directory, acct) || {};
    const country = S(dir.country).trim();
    if (!country) problems.push("directory-country-missing");
    const g = latest.get(acct) || { rows: {}, ambiguous: [], ambiguousIds: {} };
    const identities = {};
    // The tied row ids of every ambiguous source (token material only -- a tie never hashes like an absent row).
    const ambiguousIds = {};
    for (const rk of BRAND_VIEW_EVIDENCE_REPORT_KEYS) {
      identities[rk] = snapshotRowIdentity(g.rows[rk] || null);
      if (g.ambiguousIds[rk]) ambiguousIds[rk] = [...g.ambiguousIds[rk]];
    }
    for (const rk of g.ambiguous) if (BRAND_VIEW_EVIDENCE_REPORT_KEYS.includes(rk)) problems.push("latest-row-ambiguous:" + rk);
    // The selected compact, over EXACTLY getInventorySnapshotCandidates' two candidates (available first, deduped by id).
    const av = available.get(acct) || { rows: {}, ambiguous: [], ambiguousIds: {} };
    if (av.ambiguous.length) {
      problems.push("latest-row-ambiguous:" + INVENTORY_AVAILABLE_KEY);
      ambiguousIds[INVENTORY_AVAILABLE_KEY] = [...(av.ambiguousIds[INVENTORY_AVAILABLE_KEY] || [])];
    }
    const cands = [];
    const avRow = inventoryCandidate(av.rows[INVENTORY_AVAILABLE_KEY] || null);
    const latestInv = inventoryCandidate(g.rows[BRAND_INVENTORY_SNAPSHOT_KEY] || null);
    if (avRow) cands.push(avRow);
    if (latestInv && (!avRow || S(latestInv.id) !== S(avRow.id))) cands.push(latestInv);
    const inventorySelected = snapshotRowIdentity(selectAuthoritativeInventorySnapshot(cands));
    const a = (adsRows.get(acct) || [])[0] || null;
    const ads = adsIdentity({ hasState: !!(a && a.has_state === true), status: a && a.last_status, latest: a && a.latest_metric_date, rev: a && a.content_rev, windows: a && a.windows ? S(a.windows).split(",") : [] });
    const m = (mapRows.get(acct) || [])[0] || null;
    const mapping = m ? { n: Number(m.n) || 0, max: canonicalInstant(m.max_updated_at), md5: m.content_md5 == null ? null : S(m.content_md5) } : { n: 0, max: null, md5: null };
    const want = directoryParamsHash(acct);
    const drows = (dirRows.get(acct) || []).filter((r) => S(r.params_hash) === want);
    const d = drows.length === 1 ? drows[0] : null;
    const directory = { identity: snapshotRowIdentity(d), inline: !!(d && d.inline_payload === true), brands: null };
    if (!d) problems.push("brand-directory-unpublished");
    else if (!directory.inline) problems.push("brand-directory-out-of-line");
    else if (!Array.isArray(d.brands) || !d.brands.every((b) => typeof b === "string" && b.trim() !== "" && b === b.trim()) || S(d.payload_account_id) !== acct) problems.push("brand-directory-invalid");
    else directory.brands = [...d.brands];
    const asOf = country ? marketplaceToday(country, nowDate) : null;
    // The durable Ads rows' EXACT content digest over the build window of THIS as-of (exactly one LEFT JOIN row per
    // requested account; a missing row or a row digested over another window fails closed, typed).
    let adsRowsEv = null;
    if (asOf) {
      const win = brandViewAdsWindow(asOf);
      const got = adsRowDigests.get(acct) || [];
      if (got.length !== 1 || S(got[0].rows_digest) === "") problems.push("ads-rows-evidence-missing");
      else if (S(got[0].win_from) !== win.from || S(got[0].win_to) !== win.to) problems.push("ads-rows-window-mismatch");
      else adsRowsEv = { from: win.from, to: win.to, digest: S(got[0].rows_digest) };
    }
    const ev = {
      accountId: acct, country, name: dir.name == null ? null : S(dir.name), currency: dir.currency == null ? null : S(dir.currency),
      region: regionOfCountry(country), asOf, identities, ambiguousIds, inventorySelected, ads, adsRows: adsRowsEv, mapping, catalog, directory, problems,
    };
    ev.token = brandViewToken(ev, asOf);
    out.set(acct, ev);
  }
  return out;
}

/** The evidence SQL context a caller hands params(): { accountIds, organizationFingerprint }. */
const orgOf = (ctx = {}) => S(ctx.organizationFingerprint);
// LIKE-escape an account id for the tier-1 live-row scope (default '\' escape).
const likeEscape = (v) => S(v).replace(/[\\%_]/g, (c) => "\\" + c);

const route = Object.freeze({
  id: BRAND_VIEW_ROUTE_ID,
  kind: "route-cli",
  cli: Object.freeze({ script: ROUTE_CLI_SCRIPT, fixedArgs: Object.freeze([]) }),
  publisherKeys: Object.freeze([BRAND_VIEW_PUBLISHER_KEY]),
  liveReportKeys: Object.freeze(["brand-view"]),
  grain: "account",
  unit: "brand",
  awaits: Object.freeze(["oli", "fba", "fba-plan", "returns-v3", "brand-view-brands"]),
  deps: Object.freeze({
    sources: Object.freeze(["order-line-items", "product-catalog", "fba-inventory-health", "campaign-ads", "campaign-brand-mapping"]),
    reports: Object.freeze([...BRAND_VIEW_EVIDENCE_REPORT_KEYS, "brand-view-brands"]),
  }),
  evidence: Object.freeze({
    sql: Object.freeze([
      Object.freeze({ name: "latest_rows", text: LATEST_ROWS_SQL, params: (ctx = {}) => [[...BRAND_VIEW_EVIDENCE_REPORT_KEYS], evidenceAccountIds(ctx)] }),
      Object.freeze({ name: "inventory_available", text: INVENTORY_AVAILABLE_SQL, params: (ctx = {}) => [evidenceAccountIds(ctx), BRAND_INVENTORY_REPORT_VERSION] }),
      Object.freeze({ name: "directory_rows", text: DIRECTORY_ROWS_SQL, params: (ctx = {}) => { const ids = evidenceAccountIds(ctx); return [ids, ids.map(directoryParamsHash)]; } }),
      Object.freeze({ name: "ads_state", text: ADS_STATE_SQL, params: (ctx = {}) => [evidenceAccountIds(ctx), ACTIVE_ADS_SOURCE_KEY] }),
      Object.freeze({ name: "campaign_mapping", text: CAMPAIGN_MAPPING_SQL, params: (ctx = {}) => [evidenceAccountIds(ctx), orgOf(ctx)] }),
      Object.freeze({ name: "product_catalog", text: PRODUCT_CATALOG_SQL, params: (ctx = {}) => [orgOf(ctx)] }),
      // ctx.now (and ctx.directory) MUST be the ones the compose gets (the window is derived from each account's as-of).
      Object.freeze({ name: "ads_rows", text: ADS_ROWS_SQL, params: (ctx = {}) => { const w = adsRowsWindows(ctx); return [w.ids, w.froms, w.tos, ACTIVE_ADS_SOURCE_KEY]; } }),
    ]),
    // -> Map<targetKey (the owner account), { token, owners, region, targetAsOf, alerts } | { token: null, owners,
    // region, alerts, reason }> (the returns-v3 compose contract) for EVERY evidence account: an eligible, routable
    // account carries the CLI's exact L1 token + its identity as-of (the units' targetAsOf); an INELIGIBLE one (the CLI
    // revision's own typed reason: 'latest-row-ambiguous:<report>', 'brand-directory-unpublished', ...) or an
    // UNROUTABLE one ('directory-country-missing' / 'directory-region-unassigned') carries token null + its reason --
    // never a token the CLI would refuse to publish under. ctx MUST carry the primary connection's
    // organizationFingerprint (the CLI always does) -- the mapping + catalog identities are org-scoped; ctx.now is a
    // function, a Date or epoch ms (normalized once).
    compose: (rowsByName, ctx = {}) => {
      const ev = composeBrandViewEvidence(rowsByName, { ...ctx, accountIds: evidenceAccountIds(ctx) });
      const out = new Map();
      for (const [acct, e] of ev) {
        // Routing first (an unroutable account is never scanned by a region CLI), then the CLI revision's own predicate.
        const reason = routingIneligibleReason(e.country, e.region) || brandViewIneligibleReason(e);
        out.set(acct, reason
          ? { token: null, owners: [acct], region: e.region, alerts: [], reason }
          : { token: e.token, owners: [acct], region: e.region, targetAsOf: e.asOf, alerts: [] });
      }
      return out;
    },
    everySeconds: 600,
  }),
  // The identity as-of the browser sends for this account (marketplaceToday of its directory country). target = the
  // account id or a record { targetKey | accountId }; now = a function, a Date or epoch ms (normalized once).
  identityAsOf: (target, { now = null, directory = null } = {}) => {
    const dir = directoryEntry(directory, targetAccountId(target));
    const country = S(dir && dir.country).trim();
    return country ? marketplaceToday(country, recoveryNowDate(now)) : null;
  },
  tier1: Object.freeze({ liveRowScope: (target) => ({ reportKey: "brand-view", accountIdLike: "brand-view:" + likeEscape(targetAccountId(target)) + "::%" }) }),
  deadlineSeconds: 720,
  hardTimeoutSeconds: 840,
  childHeapMb: 448,
  minChildHeapMb: 320,
  priority: 7,
  scanGroup: "brand-view",
});

export default route;
