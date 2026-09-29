// Publication recovery WP6 -- the WORKER-SIDE declaration of the ZERO-EXPORT 'sku-movement' recovery route (validated
// fail-closed by route-contract.js validateRouteModule side:'worker'; its CLI-side twin is
// lib/server/sync/routes/sku-movement.release.js, run by scripts/release/publication-route-reconcile.mjs --route=sku-movement).
//
// GRAIN + UNITS: one job per ACCOUNT (the job target key is the raw account id). Its units are the account's ALL scope
// plus one unit per brand of the account's VERIFIED live brand-view-brands row (awaits ['brand-view-brands']); each unit
// publishes the live row report_key 'sku-movement', account_id = the owner, params { asOf: effectiveAsOf, brand }.
//
// L1 EVIDENCE TOKEN (metadata-only, read-only SQL; the SAME statements + compose the CLI re-runs through its read-only pg
// client, so the worker's claimed token and the child's evaluated token are computed identically):
//   'sm1:' + sha256([ the derivation-code identity SKU_MOVEMENT_CODE_IDENTITY (the live version + SKU_MOVEMENT_DERIVE_REV),
//     effectiveAsOf (skuMovementProvenDates over the account's OLI coverage, ceiling = the UTC calendar
//     date of `now` -- the SERVE's ceiling, serveSelfHealingSkuMovement in the api serve), coverageFrom,
//     every OLI coverage window (covered_from, covered_to, source_refreshed_at, updated_at),
//     the operational-units row count + max(updated_at) in [monthBack(effectiveAsOf, 3), effectiveAsOf],
//     the org Product Catalog pointer (payload_sha, source_request_hash), the directory marketplace (UK -> GB),
//     the account's EXACT live brand-view-brands row (params_hash, source_refreshed_at, updated_at) ]).
// A SAME-effectiveAsOf OLI correction re-acknowledges its coverage window in the SAME transaction as the history
// replacement (replace_oli_history_window / replace_oli_dimensional_window upsert source_coverage: source_refreshed_at +
// updated_at move) and a standalone operational-units backfill (replace_oli_operational_units_window) moves the unit-row
// count / max(updated_at) -- so the token changes on OLI CONTENT changes, not only on date changes.
// (source_coverage has NO source_request_hash column -- verified against 20260820_source_durable_model.sql -- so the
// window's updated_at, which every coverage upsert sets to now(), stands in for it.)
// Timestamps are read as UTC ISO TEXT (to_char ... at time zone 'UTC') and dates as ::text -- never through a JS Date on
// a local-timezone machine.
//
// WORKER CONTEXT this module assumes (WP11/WP12 supply it): sql[i].params(ctx) with ctx = { organizationFingerprint,
// connectionId? ('primary'), accountIds? (else the durable directory Map's ids), now?, directory? } (throws -- fail
// closed -- on anything malformed, including a PRESENT but invalid `now`); evidence.compose(rowsByName, { now,
// directory, accountIds? }) -> Map<accountId, { token, owners, region, targetAsOf, alerts } | { token: null, owners,
// region, alerts, reason }> (the returns-v3.route.js shape: an ineligible target carries token null + its typed reason
// 'coverage-incomplete' | 'no-marketplace' | 'catalog-missing' | 'evidence-inconsistent'); compose REQUIRES `now` (the
// effectiveAsOf ceiling = its UTC calendar date; throws without it). tier1.liveRowScope(target) with target = the
// account id (or a record { targetKey | accountId }).
// `now` IN PARAMS: the only statement that needs the ceiling is sku_opunits ($4). A ctx WITHOUT `now` binds $4 = NULL,
// and Postgres LEAST() ignores a NULL argument, so the statement then computes the opunits window at the UNCAPPED
// max(covered_to); compose (which always has `now`) re-derives effectiveAsOf WITH the ceiling and cross-checks the
// window -- a disagreement (only when the ceiling binds: coverage past the UTC date of `now`) is the typed
// 'evidence-inconsistent', never a token over the wrong window. The worker MUST therefore pass the SAME `now` to
// params and compose (WP11 pins ONE ctx shape); the CLI (sku-movement.release.js) always does. 7-bit ASCII, LF.

import { ROUTE_CLI_SCRIPT } from "../route-contract.js";
import { paramsHashFor } from "../../report-params-hash.js"; // the PURE leaf: keeps report-store.js / supabase.js writers out of the worker graph
import { BRAND_VIEW_BRANDS_VERSION, BRAND_VIEW_BRANDS_REPORT_KEY } from "../../reports/brand-view.js";
import { skuMovementProvenDates } from "../../reports/sku-movement-durable-rederive.js";
import { computeSkuEvidenceToken } from "../../reports/sku-movement-evidence.js";
import { monthBackStr } from "../../date-windows.js";
import { normalizeMarketplace } from "../../sync/oli-sales-estimate.js";
import { regionForCountry } from "../../sync/scheduler-scope.js";

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";

export const SKU_MOVEMENT_ROUTE_ID = "sku-movement";
export const SKU_MOVEMENT_PUBLISHER_KEY = "sku-movement";
export const SKU_MOVEMENT_LIVE_REPORT_KEY = "sku-movement";
const RECOVERY_REGIONS = Object.freeze(["india", "europe-au", "us-ca"]);
// DERIVATION-CODE IDENTITY (publication recovery WP14 cross-cutting). Every other sm1 part identifies an INPUT, so a
// deploy that changes the SKU Movement derivation (sku-movement-durable-rederive.js buildSkuMovementUnit) would leave an
// input-unchanged account 'current' on the OLD derivation -- indefinitely for a dormant account whose OLI coverage no
// longer advances (effectiveAsOf frozen). BUMP SKU_MOVEMENT_DERIVE_REV with every derivation change: every account's token
// changes, the worker re-arms and the route republishes each unit once (content-identical units only re-stamp). `v` is
// the live report version the route publishes (pinned equal to sku-movement.release.js SKU_MOVEMENT_LIVE_VERSION by
// sku-movement-route.test.js). The serve-side 'sms2:' token is a SEPARATE contract (WP10a) and does NOT include it.
export const SKU_MOVEMENT_DERIVE_REV = 1;
export const SKU_MOVEMENT_CODE_IDENTITY = Object.freeze({ v: "sku-movement/v2", rev: String(SKU_MOVEMENT_DERIVE_REV) });

// ---- the evidence SQL (metadata only; one SELECT/WITH each; ctx = { organizationFingerprint, connectionId?, accountIds,
// now? }) -----------------------------------------------------------------------------------------------------------
const ISO = (expr) => `to_char(${expr} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** The UTC calendar date of `now` (ms | Date | ISO): the serve's future-guard ceiling for effectiveAsOf. */
export function skuMovementEvidenceCeiling(now) {
  const t = now instanceof Date ? now.getTime() : (typeof now === "number" ? now : Date.parse(S(now)));
  if (!Number.isFinite(t)) throw new Error("sku-movement evidence: a valid `now` is required for the ceiling (fail closed).");
  return new Date(t).toISOString().slice(0, 10);
}
/** The exact live brand-view-brands identity hash of an account (the api serve's brandViewDirectory identity). */
export function brandViewBrandsLiveHash(accountId) {
  return paramsHashFor(BRAND_VIEW_BRANDS_VERSION, { accountId });
}
// The scope a statement covers: ctx.accountIds, else the durable directory's ids (a Map) -- the sibling routes' rule.
function scopeIds(c) {
  return Array.isArray(c.accountIds) ? c.accountIds : (c.directory instanceof Map ? [...c.directory.keys()] : null);
}
function scopeArgs(ctx) {
  const c = ctx && typeof ctx === "object" ? ctx : {};
  if (!nb(c.organizationFingerprint)) throw new Error("sku-movement evidence: ctx.organizationFingerprint is required (fail closed).");
  const raw = scopeIds(c);
  const ids = Array.isArray(raw) ? raw.map(S) : null;
  if (!ids || !ids.every((a) => nb(a) && a === a.trim() && !a.includes(":"))) throw new Error("sku-movement evidence: ctx.accountIds must be canonical raw account ids (fail closed).");
  const conn = c.connectionId == null ? "primary" : S(c.connectionId);
  if (conn !== "primary" && conn !== "dd-secondary") throw new Error("sku-movement evidence: ctx.connectionId must be primary | dd-secondary (fail closed).");
  return { org: S(c.organizationFingerprint), conn, ids: [...new Set(ids)].sort() };
}

export const SKU_MOVEMENT_EVIDENCE_SQL = Object.freeze([
  Object.freeze({
    name: "sku_coverage",
    text: [
      "select c.account_id, c.covered_from::text as covered_from, c.covered_to::text as covered_to,",
      `  ${ISO("c.source_refreshed_at")} as source_refreshed_at, ${ISO("c.updated_at")} as updated_at`,
      "from public.source_coverage c",
      "where c.organization_fingerprint = $1 and c.connection_id = $2 and c.source_key = 'order-line-items'",
      "  and c.status = 'succeeded' and c.account_id = any($3::text[])",
      "order by c.account_id, c.covered_from, c.covered_to",
    ].join("\n"),
    params: (ctx) => { const a = scopeArgs(ctx); return [a.org, a.conn, a.ids]; },
  }),
  Object.freeze({
    name: "sku_opunits",
    text: [
      "with eff as (",
      "  select c.account_id, least(max(c.covered_to), $4::date) as eff_as_of",
      "  from public.source_coverage c",
      "  where c.organization_fingerprint = $1 and c.connection_id = $2 and c.source_key = 'order-line-items'",
      "    and c.status = 'succeeded' and c.account_id = any($3::text[])",
      "  group by c.account_id",
      ")",
      "select e.account_id, e.eff_as_of::text as eff_as_of,",
      "  (date_trunc('month', e.eff_as_of::timestamp) - interval '3 months')::date::text as window_from,",
      `  count(u.account_id)::int as unit_rows, ${ISO("max(u.updated_at)")} as max_updated_at`,
      "from eff e",
      "left join public.source_oli_operational_units u",
      "  on u.organization_fingerprint = $1 and u.connection_id = $2 and u.account_id = e.account_id",
      "  and u.sale_date >= (date_trunc('month', e.eff_as_of::timestamp) - interval '3 months')::date",
      "  and u.sale_date <= e.eff_as_of",
      "group by e.account_id, e.eff_as_of",
      "order by e.account_id",
    ].join("\n"),
    // $4 = the ceiling (UTC date of ctx.now), or NULL when the worker ctx carries no `now` (LEAST ignores NULL; compose
    // cross-checks the window -- see WORKER CONTEXT). A present-but-invalid `now` throws (fail closed).
    params: (ctx) => { const a = scopeArgs(ctx); return [a.org, a.conn, a.ids, ctx.now == null ? null : skuMovementEvidenceCeiling(ctx.now)]; },
  }),
  Object.freeze({
    name: "sku_catalog",
    text: [
      `select s.payload_sha, s.source_request_hash, ${ISO("s.validated_at")} as validated_at`,
      "from public.source_snapshots s",
      "where s.organization_fingerprint = $1 and s.connection_id = $2 and s.source_key = 'product-catalog'",
      "  and s.scope_key = '__organization'",
    ].join("\n"),
    params: (ctx) => { const a = scopeArgs(ctx); return [a.org, a.conn]; },
  }),
  Object.freeze({
    name: "sku_brands",
    text: [
      `select r.account_id, r.params_hash, ${ISO("r.source_refreshed_at")} as source_refreshed_at, ${ISO("r.updated_at")} as updated_at`,
      "from public.report_snapshots r",
      "join unnest($1::text[], $2::text[]) as t(account_id, params_hash)",
      "  on r.account_id = t.account_id and r.params_hash = t.params_hash",
      `where r.report_key = '${BRAND_VIEW_BRANDS_REPORT_KEY}'`,
      "order by r.account_id",
    ].join("\n"),
    params: (ctx) => { const a = scopeArgs(ctx); return [a.ids, a.ids.map(brandViewBrandsLiveHash)]; },
  }),
]);

// The directory's country for an account: a Map (the CLI's durable directory), an array of rows, or a plain object.
function directoryCountry(directory, accountId) {
  let m = null;
  if (directory instanceof Map) m = directory.get(accountId) || null;
  else if (Array.isArray(directory)) m = directory.find((r) => r && S(r.accountId ?? r.account_id ?? r.id).trim() === accountId) || null;
  else if (directory && typeof directory === "object") m = directory[accountId] || null;
  return m ? S(m.country ?? m.marketCountry ?? m.marketplace).trim() : "";
}
const rowsOf = (rowsByName, name) => {
  const r = rowsByName instanceof Map ? rowsByName.get(name) : (rowsByName && typeof rowsByName === "object" ? rowsByName[name] : null);
  if (!Array.isArray(r)) throw new Error(`sku-movement evidence: rows for '${name}' are missing (fail closed).`);
  return r;
};
const textOrNull = (v) => (v == null ? null : S(v));

/**
 * Compose the per-account DETAILED evidence from the four statements' rows (PURE). ctx = { now, directory,
 * accountIds? } (accountIds: the scope -- every scope account gets an entry, even one with no rows). Per account:
 *   { accountId, token, owners, region, ceiling, effectiveAsOf, coverageFrom, windows, opunits, catalog, marketplace,
 *     brands, ineligibleReason }
 * ineligibleReason (typed, never a guess): 'coverage-incomplete' (no proven OLI coverage), 'no-marketplace',
 * 'catalog-missing' (no org catalog pointer -- never a brandless payload), 'evidence-inconsistent' (the operational-units
 * window disagrees with the coverage the token was composed from -- a concurrent write between statements, or params
 * bound without `now` while the ceiling binds; retried).
 */
export function composeSkuMovementScopeEvidence(rowsByName, ctx = {}) {
  const ceiling = skuMovementEvidenceCeiling(ctx && ctx.now);
  const coverage = rowsOf(rowsByName, "sku_coverage");
  const opunits = rowsOf(rowsByName, "sku_opunits");
  const catalogRows = rowsOf(rowsByName, "sku_catalog");
  const brandRows = rowsOf(rowsByName, "sku_brands");
  const scope = (scopeIds(ctx && typeof ctx === "object" ? ctx : {}) || []).map(S);
  const ids = [...new Set([...scope, ...coverage.map((r) => S(r.account_id))].filter(nb))].sort();
  const cat = catalogRows.length === 1 && nb(catalogRows[0].payload_sha) ? catalogRows[0] : null;
  const catalog = cat ? { payloadSha: S(cat.payload_sha), sourceRequestHash: S(cat.source_request_hash), validatedAt: textOrNull(cat.validated_at) } : null;
  const out = new Map();
  for (const accountId of ids) {
    const windows = coverage.filter((r) => S(r.account_id) === accountId)
      .map((r) => ({ from: S(r.covered_from).slice(0, 10), to: S(r.covered_to).slice(0, 10), sourceRefreshedAt: textOrNull(r.source_refreshed_at), updatedAt: textOrNull(r.updated_at) }))
      .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
    const { effectiveAsOf, coverageFrom } = skuMovementProvenDates(windows.map((w) => ({ from: w.from, to: w.to })), ceiling);
    const op = opunits.find((r) => S(r.account_id) === accountId) || null;
    const opu = op ? { windowFrom: S(op.window_from).slice(0, 10), windowTo: S(op.eff_as_of).slice(0, 10), rows: Number(op.unit_rows) || 0, maxUpdatedAt: textOrNull(op.max_updated_at) } : null;
    const br = brandRows.find((r) => S(r.account_id) === accountId && S(r.params_hash) === brandViewBrandsLiveHash(accountId)) || null;
    const brands = br ? { paramsHash: S(br.params_hash), sourceRefreshedAt: textOrNull(br.source_refreshed_at), updatedAt: textOrNull(br.updated_at) } : null;
    const country = directoryCountry(ctx && ctx.directory, accountId);
    const marketplace = country ? normalizeMarketplace(country) : "";
    const reg = country ? regionForCountry(country.toUpperCase()) : null;
    const region = RECOVERY_REGIONS.includes(reg) ? reg : null;
    const token = computeSkuEvidenceToken([
      "sm1", SKU_MOVEMENT_CODE_IDENTITY, effectiveAsOf, coverageFrom,
      windows.map((w) => [w.from, w.to, w.sourceRefreshedAt, w.updatedAt]),
      opu ? [opu.windowFrom, opu.windowTo, opu.rows, opu.maxUpdatedAt] : null,
      catalog ? [catalog.payloadSha, catalog.sourceRequestHash] : null,
      marketplace || null,
      brands ? [brands.paramsHash, brands.sourceRefreshedAt, brands.updatedAt] : null,
    ]);
    let ineligibleReason = null;
    if (!effectiveAsOf) ineligibleReason = "coverage-incomplete";
    else if (!marketplace) ineligibleReason = "no-marketplace";
    else if (!catalog || !nb(catalog.sourceRequestHash)) ineligibleReason = "catalog-missing";
    else if (!opu || opu.windowTo !== effectiveAsOf || opu.windowFrom !== monthBackStr(effectiveAsOf, 3)) ineligibleReason = "evidence-inconsistent";
    out.set(accountId, { accountId, token, owners: [accountId], region, ceiling, effectiveAsOf, coverageFrom, windows, opunits: opu, catalog, marketplace, brands, ineligibleReason });
  }
  return out;
}

/**
 * The worker compose (route-contract evidence.compose), in the returns-v3.route.js shape: Map<targetKey = accountId,
 * { token, owners, region, targetAsOf: effectiveAsOf, alerts: [] }> for an eligible account, and { token: null, owners,
 * region, alerts: [], reason } (reason = the typed ineligibleReason: coverage-incomplete / no-marketplace /
 * catalog-missing / evidence-inconsistent) otherwise -- never a token the CLI would refuse to publish under.
 */
export function composeSkuMovementEvidence(rowsByName, ctx = {}) {
  const out = new Map();
  for (const [accountId, ev] of composeSkuMovementScopeEvidence(rowsByName, ctx)) {
    out.set(accountId, ev.ineligibleReason
      ? { token: null, owners: ev.owners.slice(), region: ev.region, alerts: [], reason: ev.ineligibleReason }
      : { token: ev.token, owners: ev.owners.slice(), region: ev.region, targetAsOf: ev.effectiveAsOf, alerts: [] });
  }
  return out;
}

/**
 * Run the evidence statements through a READ-ONLY query function (the CLI's pgReadOnly; the worker's own read-only
 * client) and compose the DETAILED per-account evidence. `query(text, values) -> rows`. Throws on any read failure
 * (the caller defers -- never a partial token).
 */
export async function readSkuMovementScopeEvidence(query, ctx) {
  if (typeof query !== "function") throw new Error("sku-movement evidence: a read-only query function is required (fail closed).");
  const rowsByName = {};
  for (const q of SKU_MOVEMENT_EVIDENCE_SQL) rowsByName[q.name] = await query(q.text, q.params(ctx));
  return composeSkuMovementScopeEvidence(rowsByName, ctx);
}

const route = Object.freeze({
  id: SKU_MOVEMENT_ROUTE_ID,
  kind: "route-cli",
  cli: Object.freeze({ script: ROUTE_CLI_SCRIPT, fixedArgs: Object.freeze([]) }),
  publisherKeys: Object.freeze([SKU_MOVEMENT_PUBLISHER_KEY]),
  liveReportKeys: Object.freeze([SKU_MOVEMENT_LIVE_REPORT_KEY]),
  grain: "account",
  unit: "brand",
  // Named units come ONLY from the live brand-view-brands row, so that route runs first.
  awaits: Object.freeze(["brand-view-brands"]),
  deps: Object.freeze({
    sources: Object.freeze(["order-line-items", "oli-operational-units", "oli-sku-asin-resolution", "product-catalog", "account-directory"]),
    reports: Object.freeze(["brand-view-brands"]),
  }),
  evidence: Object.freeze({ sql: SKU_MOVEMENT_EVIDENCE_SQL, compose: composeSkuMovementEvidence, everySeconds: 600 }),
  // The identity as-of is the account's proven OLI date (evidence-derived, inside the token) -- no clock rollover.
  identityAsOf: null,
  // Every live row of the account (all brand scopes) sits at account_id = the owner.
  // (target: the job target key string, or a target record { targetKey | accountId }.)
  tier1: Object.freeze({ liveRowScope: (target) => ({ reportKey: SKU_MOVEMENT_LIVE_REPORT_KEY, accountIdEq: S(typeof target === "string" ? target : target && (target.targetKey ?? target.accountId)) }) }),
  deadlineSeconds: 330,
  hardTimeoutSeconds: 420,
  childHeapMb: 384,
  minChildHeapMb: 256,
  priority: 6,
  scanGroup: "sku-movement",
});

export default route;
