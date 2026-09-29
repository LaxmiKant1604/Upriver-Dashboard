// Publication recovery WP11 -- the 'oli' LEGACY-CLI route (worker side): the pre-existing zero-export OLI publication
// reconciler (scripts/release/oli-publication-reconcile.mjs) declared in the route shape (route-contract.js) so the ONE
// route registry drives it next to the new route-cli routes. NOTHING about the CLI changes: the runner builds its EXACT
// pre-existing argv (--bucket / --as-of / --mode=periodic / --accounts / --deadline-seconds=330 / --run-token /
// --emit-targets / --live), under the SAME `timeout 420` hard bound the backstop workflow uses; its TARGETS line stays
// v1 (the consumer lifts it with normalizeTargets).
//
// This module is ALSO the home of the four legacy families' shared evidence-token compose (composeEvidenceTokens,
// MOVED VERBATIM from lib/server/recovery/store-pg.js so every token string stays byte-identical) and of the SIX
// metadata-only statements it composes from (the exact texts store-pg.js readEvidenceTokens runs). The ads / fba /
// listings wrappers import both from here. Every token is composed from METADATA columns only -- never a payload.
//
// The pinned evidence ctx (route-contract.js makeEvidenceContext): params(ctx) reads ctx.epoch only (the completeness
// window); compose(rowsByName, ctx) returns an entry for EVERY ctx.accountIds account -- an account with no token
// material is { token: null, reason: 'no-evidence-token' } (the old watermark skipped it: never enqueued, never
// verified). 7-bit ASCII, LF.

import { oliDependentLiveReportKeys } from "../../sync/oli-dependent-reports.js";
import { accountInScope, REGION_SCOPES } from "../../sync/scheduler-scope.js";

const S = (v) => (v == null ? "" : String(v));
const iso = (v) => (v instanceof Date ? v.toISOString() : v == null ? "" : String(v));

/** Pure: compose per-family evidence tokens from metadata rows (exported for tests). */
export function composeEvidenceTokens({ oli = [], oliCompleteness = [], fba = [], ads = [], listings = [], catalog = null }) {
  const oliTok = new Map();
  const comp = new Map(oliCompleteness.map((r) => [S(r.account_id), iso(r.refreshed)]));
  for (const r of oli) oliTok.set(S(r.account_id), `cov:${S(r.covered_to)}@${iso(r.refreshed)}|cmp:${comp.get(S(r.account_id)) || "-"}`);
  const fbaTok = new Map(fba.map((r) => [S(r.account_id), `fba:${S(r.source_request_hash)}:${S(r.payload_sha)}`]));
  const adsTok = new Map(ads.map((r) => [S(r.account_id), `ads:${S(r.revs)}`]));
  const cat = catalog ? `cat:${S(catalog.payload_sha)}` : "cat:-";
  const lstTok = new Map();
  for (const r of listings) {
    const a = S(r.account_id);
    lstTok.set(a, `lst:${S(r.l_sha)}@${iso(r.l_at)}|raw:${S(r.r_sha) || "-"}@${iso(r.r_at) || "-"}|${fbaTok.get(a) || "fba:-"}|${cat}|${oliTok.get(a) || "oli:-"}`);
  }
  return { oli: oliTok, fba: fbaTok, ads: adsTok, listings: lstTok };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const epochParam = (ctx) => {
  const e = S(ctx && ctx.epoch);
  if (!DATE_RE.test(e) || new Date(e + "T00:00:00Z").toISOString().slice(0, 10) !== e) throw new Error("legacy evidence params: ctx.epoch must be a real YYYY-MM-DD date (fail closed).");
  return [e];
};

// The SIX metadata-only statements (texts IDENTICAL to store-pg.js readEvidenceTokens). The ads statement's worker
// keys are bound by the ads wrapper (its params).
export const LEGACY_EVIDENCE_SQL = Object.freeze({
  oli_coverage: Object.freeze({ name: "oli_coverage", text: "select account_id, max(covered_to)::text covered_to, max(source_refreshed_at) refreshed from public.source_coverage where connection_id = 'primary' and source_key = 'order-line-items' and status = 'succeeded' group by account_id", params: () => [] }),
  oli_completeness: Object.freeze({ name: "oli_completeness", text: "select account_id, max(refreshed_at) refreshed from public.source_oli_completeness where connection_id = 'primary' and sale_date between ($1::date - 3) and $1::date group by account_id", params: epochParam }),
  fba_pointers: Object.freeze({ name: "fba_pointers", text: "select scope_key account_id, source_request_hash, payload_sha from public.source_snapshots where connection_id = 'primary' and source_key = 'fba-inventory-health'", params: () => [] }),
  ads_revs: Object.freeze({ name: "ads_revs", text: "select account_id, string_agg(source_key || '=' || coalesce(content_rev, '') || '@' || coalesce(latest_metric_date::text, ''), ',' order by source_key) revs from public.ads_sync_state where source_key = any($1) group by account_id", params: () => { throw new Error("legacy ads_revs params are bound by the ads route (fail closed)."); } }),
  listings_pointers: Object.freeze({ name: "listings_pointers", text: "select l.account_id, l.payload_sha l_sha, l.validated_at l_at, r.payload_sha r_sha, r.validated_at r_at from public.source_listings_snapshot l left join public.source_listings_raw_snapshot r on r.organization_fingerprint = l.organization_fingerprint and r.connection_id = l.connection_id and r.account_id = l.account_id where l.connection_id = 'primary'", params: () => [] }),
  catalog_pointer: Object.freeze({ name: "catalog_pointer", text: "select payload_sha from public.source_snapshots where connection_id = 'primary' and source_key = 'product-catalog' order by validated_at desc limit 1", params: () => [] }),
});

/** composeEvidenceTokens over a rowsByName record of the legacy statements (the catalog read is ONE row or none). */
export function composeLegacyTokens(rowsByName = {}) {
  const rows = (n) => (Array.isArray(rowsByName && rowsByName[n]) ? rowsByName[n] : []);
  const cat = rows("catalog_pointer");
  return composeEvidenceTokens({ oli: rows("oli_coverage"), oliCompleteness: rows("oli_completeness"), fba: rows("fba_pointers"), ads: rows("ads_revs"), listings: rows("listings_pointers"), catalog: cat[0] || null });
}

/** The scheduler region of an account's durable-directory country (null when unknown / unserved). */
export function legacyRegionOf(directory, accountId) {
  const m = directory instanceof Map ? directory.get(accountId) : null;
  const c = S(m && m.country).trim().toUpperCase();
  return c ? (REGION_SCOPES.find((r) => accountInScope(r, c)) || null) : null;
}

/**
 * The legacy wrappers' compose contract: Map<accountId, { token, owners: [accountId], region, alerts: [] } |
 * { token: null, owners, region, alerts: [], reason: 'no-evidence-token' }> for EVERY ctx.accountIds account (without
 * accountIds: every account the family token map holds).
 */
export function legacyTargets(tokenMap, ctx = {}) {
  const ids = Array.isArray(ctx.accountIds) ? ctx.accountIds : [...tokenMap.keys()].sort();
  const out = new Map();
  for (const a of ids) {
    const tok = tokenMap.get(a) || null;
    const region = legacyRegionOf(ctx.directory, a);
    out.set(a, tok ? { token: tok, owners: [a], region, alerts: [] } : { token: null, owners: [a], region, alerts: [], reason: "no-evidence-token" });
  }
  return out;
}

const accountOf = (target) => S(typeof target === "string" ? target : target && (target.targetKey ?? target.accountId));
/** The tier-1 scopes of a legacy family: every live report it publishes, at the account. */
export const legacyLiveRowScope = (reportKeys) => (target) => reportKeys.map((reportKey) => ({ reportKey, accountIdEq: accountOf(target) }));

export const OLI_ROUTE_REPORT_KEYS = Object.freeze([...oliDependentLiveReportKeys()]);

export default Object.freeze({
  id: "oli",
  kind: "legacy-cli",
  cli: Object.freeze({ script: "scripts/release/oli-publication-reconcile.mjs", fixedArgs: Object.freeze([]) }),
  // The legacy reconcilers publish each live report under its OWN live contract key (publisher key == live key).
  publisherKeys: OLI_ROUTE_REPORT_KEYS,
  liveReportKeys: OLI_ROUTE_REPORT_KEYS,
  grain: "account",
  unit: "none",
  awaits: Object.freeze([]),
  deps: Object.freeze({ sources: Object.freeze(["order-line-items"]), reports: Object.freeze([]) }),
  evidence: Object.freeze({
    sql: Object.freeze([LEGACY_EVIDENCE_SQL.oli_coverage, LEGACY_EVIDENCE_SQL.oli_completeness]),
    compose: (rowsByName, ctx = {}) => legacyTargets(composeLegacyTokens(rowsByName).oli, ctx),
    everySeconds: 60,
  }),
  identityAsOf: null,
  tier1: Object.freeze({ liveRowScope: legacyLiveRowScope(OLI_ROUTE_REPORT_KEYS) }),
  deadlineSeconds: 330,
  hardTimeoutSeconds: 420,
  // 512 = the config ceiling: the child heap stays EXACTLY PRW_CHILD_MAX_OLD_SPACE_MB, as before the route registry.
  childHeapMb: 512,
  minChildHeapMb: 192,
  priority: 1,
  scanGroup: "oli",
});
