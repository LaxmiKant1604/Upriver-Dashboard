// Publication recovery WP8 -- WORKER-side declaration of the zero-export `brand-view-brands` recovery route (the Brand
// View per-account brand DIRECTORY, api/datadoe.js brandViewDirectory: report_key brand-view-brands, version
// brand-view-brands-v1, identity { accountId } at the raw account). Validated fail-closed by route-contract.js; its
// CLI-side twin is lib/server/sync/routes/brand-view-brands.release.js.
//
// EVIDENCE (metadata-only, read-only): ONE SQL over report_snapshots returning, for each of the directory's three brand
// sources (brand-view.js BRAND_SOURCE_SNAPSHOT_KEYS: brand-sales, fba-plan, sku-pl), the LATEST row by updated_at -- the
// exact row getLatestReportSnapshot returns, which the serve rebuild (api/datadoe.js brandViewDirectory) and the CLI
// derive both read through the storage-first getLatestReportSnapshotHydrated (WP10; an out-of-line payload is hydrated
// from its storage object, an absent object defers 'storage-missing:<report>') -- as its identity { id, params_hash,
// source_refreshed_at, updated_at, params->>reportVersion }. rank() (not DISTINCT ON)
// so a TIE at the newest updated_at is VISIBLE: an ambiguous latest row is a typed deferral, never a coin flip.
//   L1 token = 'bb1:' + sha256(stableJson({ a: account, r: [[reportKey, identity | null | { ambiguous, ids }] x3],
//                                          code: BRAND_VIEW_BRANDS_CODE_IDENTITY }))
// (code = the shared Brand View derivation-code identity + this route's DERIVE_REV -- a deploy that changes the directory
// derivation re-arms every account whose inputs did not change).
// An AMBIGUOUS source (a tie) enters the token material as { ambiguous: true, ids: [the tied row ids, sorted] } -- never
// as null -- so a tie can never share a token with an ABSENT row (the tie binding adds nothing to an account without ambiguity).
// Equal L1 => an equal payload (buildBrandViewBrandDirectory is deterministic over those rows: no clock). The SAME pure
// compose runs in the worker (tier-1 / watermark) and in the CLI (computeRevision), so the worker's job token and the
// CLI's TARGETS v2 'tok' echo are byte-identical by construction for every ELIGIBLE account; an ineligible (tied) or
// unroutable account is { token: null, reason } on the worker side (the returns-v3 compose contract), exactly as the
// CLI's revision is ineligible with the SAME typed reason.
//
// This module also exports the SHARED latest-rows SQL + helpers the brand-view route reuses (incl. the worker-hook
// argument normalizers targetAccountId / recoveryNowDate). Pure (no I/O); imports only pure modules. 7-bit ASCII, LF.

import { createHash } from "node:crypto";
import { ROUTE_CLI_SCRIPT } from "../route-contract.js";
import { BRAND_SOURCE_SNAPSHOT_KEYS } from "../../reports/brand-view.js";
import { accountInScope, REGION_SCOPES } from "../../sync/scheduler-scope.js";
import { stableJson } from "../../sync/publication-binding.js";
import { snapshotRowIdentity, brandViewCodeIdentity } from "../../sync/brand-view-dependency-readers.js";

const S = (v) => (v == null ? "" : String(v));
const sha256 = (v) => createHash("sha256").update(String(v)).digest("hex");

// DERIVATION REVISION of this route: BUMP IT on ANY change to the code that turns unchanged inputs into a different
// directory payload -- brand-view.js buildBrandViewBrandDirectory / brandNamesFromPayload / sortBrands or the release
// derive (brand-view-brands.release.js). Folded into bb1 via BRAND_VIEW_BRANDS_CODE_IDENTITY.
export const DERIVE_REV = 1;
// The derivation-code identity bb1 binds (the shared Brand View code identity + DERIVE_REV).
export const BRAND_VIEW_BRANDS_CODE_IDENTITY = Object.freeze(brandViewCodeIdentity(DERIVE_REV));

export const BRAND_VIEW_BRANDS_ROUTE_ID = "brand-view-brands";
export const BRAND_VIEW_BRANDS_PUBLISHER_KEY = "brand-view-brands";
export const BRAND_VIEW_BRANDS_TOKEN_PREFIX = "bb1:";
// The directory's brand sources, in the builder's own order (never a re-typed copy).
export const BRAND_VIEW_BRANDS_EVIDENCE_REPORT_KEYS = Object.freeze([...BRAND_SOURCE_SNAPSHOT_KEYS]);

// The canonical instant rendering both routes' evidence SQL uses (UTC, microseconds) -- canonicalInstant parses it.
const TS = (col) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * The SHARED latest-rows evidence SQL: $1 text[] report keys, $2 text[] account ids. Every rank-1 row (newest
 * updated_at) per (report_key, account_id) -- more than one row per pair means a TIE (ambiguous latest). The
 * brand-inventory columns (the four payload fields selectAuthoritativeInventorySnapshot reads) are extracted ONLY for
 * brand-inventory rows and ONLY for the rank-1 rows (CASE + the outer filter), so no large payload is ever detoasted.
 */
export const LATEST_ROWS_SQL = "with ranked as ("
  + " select s.id, rank() over (partition by s.report_key, s.account_id order by s.updated_at desc) as rnk"
  + " from public.report_snapshots s where s.report_key = any($1::text[]) and s.account_id = any($2::text[])"
  + ") select s.report_key, s.account_id, s.id::text as id, s.params_hash,"
  + ` ${TS("s.source_refreshed_at")} as source_refreshed_at, ${TS("s.updated_at")} as updated_at,`
  + " s.params->>'reportVersion' as report_version,"
  + " case when s.report_key = 'brand-inventory' then s.payload->'inventoryAvailable' end as inv_available,"
  + " case when s.report_key = 'brand-inventory' then s.payload->'inventoryDate' end as inv_date,"
  + " case when s.report_key = 'brand-inventory' then s.payload->'inventorySnapshotDate' end as inv_snapshot_date,"
  + " case when s.report_key = 'brand-inventory' then jsonb_typeof(s.payload->'inventoryByBrandCountry') end as inv_ibbc_type"
  + " from ranked r join public.report_snapshots s on s.id = r.id where r.rnk = 1";

/** The canonical primary account ids an evidence read covers: ctx.accountIds, else the durable directory's ids. */
export function evidenceAccountIds(ctx = {}) {
  const raw = Array.isArray(ctx.accountIds) ? ctx.accountIds : (ctx.directory instanceof Map ? [...ctx.directory.keys()] : []);
  return [...new Set(raw.map(S).filter((id) => id !== "" && id === id.trim() && !id.includes(":")))].sort();
}

/** The scheduler region of a directory country (the ONE canonical marketplace->region mapping), or null. */
export function regionOfCountry(country) {
  const c = S(country).trim().toUpperCase();
  if (!c) return null;
  return REGION_SCOPES.find((r) => accountInScope(r, c)) || null;
}

/** A directory entry for an account (Map or plain object), or null. */
export function directoryEntry(directory, accountId) {
  if (directory instanceof Map) return directory.get(accountId) || null;
  if (directory && typeof directory === "object") return directory[accountId] || null;
  return null;
}

/**
 * The account id a worker hook's `target` names: the id itself (string) or a record { targetKey | accountId } (the
 * returns-v3 / sku-movement tier-1 shape). Never a unit targetId (a brand-view unit's targetId is a scope id, not an
 * account). "" when absent.
 */
export function targetAccountId(target) {
  if (target == null) return "";
  if (typeof target === "object") return S(target.targetKey ?? target.accountId).trim();
  return S(target).trim();
}

/**
 * The worker hooks' `now`, normalized ONCE: a function (called once), a Date, or an epoch-ms number; null/undefined
 * = the wall clock. -> a fresh Date. Anything that does not yield a finite instant THROWS (fail closed -- an invalid
 * clock never becomes an "Invalid Date" as-of).
 */
export function recoveryNowDate(now) {
  const v = typeof now === "function" ? now() : now;
  const ms = v == null ? Date.now() : (v instanceof Date ? v.getTime() : (typeof v === "number" ? v : Number.NaN));
  if (!Number.isFinite(ms)) throw new Error("brand-view route: `now` must be a function, a Date or an epoch-ms number (fail closed).");
  return new Date(ms);
}

/**
 * Group latest-rows SQL rows per account: -> Map(accountId -> { rows: { reportKey: row }, ambiguous: [reportKey],
 * ambiguousIds: { reportKey: [tied row ids, sorted] } }). A (report, account) pair with more than one rank-1 row is
 * AMBIGUOUS (its row is not taken; every tied id is kept for the token material).
 */
export function groupLatestRows(sqlRows) {
  const out = new Map();
  const seen = new Map();
  for (const r of Array.isArray(sqlRows) ? sqlRows : []) {
    const acct = S(r && r.account_id); const rk = S(r && r.report_key);
    if (!acct || !rk) continue;
    const k = rk + "\u0000" + acct;
    if (!seen.has(k)) seen.set(k, []);
    const ids = seen.get(k);
    ids.push(S(r.id));
    if (!out.has(acct)) out.set(acct, { rows: {}, ambiguous: [], ambiguousIds: {} });
    const g = out.get(acct);
    if (ids.length === 1) g.rows[rk] = r;
    else { delete g.rows[rk]; if (!g.ambiguous.includes(rk)) g.ambiguous.push(rk); g.ambiguousIds[rk] = ids; }
  }
  for (const g of out.values()) {
    g.ambiguous.sort();
    for (const rk of Object.keys(g.ambiguousIds)) g.ambiguousIds[rk] = [...g.ambiguousIds[rk]].sort();
  }
  return out;
}

/**
 * The token-material entry of one evidence source: the row identity, null when ABSENT, or { ambiguous: true, ids }
 * when TIED (so an ambiguous source never hashes like an absent one). Shared by both routes' tokens.
 */
export function evidenceMaterialEntry(identity, tiedIds) {
  if (Array.isArray(tiedIds) && tiedIds.length) return { ambiguous: true, ids: tiedIds.map(S).sort() };
  return identity || null;
}

/**
 * The L1 token of one account's directory evidence (PURE). `ambiguousIds` (optional) = groupLatestRows' tied ids.
 * `code` (default BRAND_VIEW_BRANDS_CODE_IDENTITY) is a TEST seam only -- no production caller passes it.
 */
export function brandViewBrandsToken(accountId, identities, ambiguousIds = null, code = BRAND_VIEW_BRANDS_CODE_IDENTITY) {
  const tied = ambiguousIds && typeof ambiguousIds === "object" ? ambiguousIds : {};
  return BRAND_VIEW_BRANDS_TOKEN_PREFIX + sha256(stableJson({ a: S(accountId), r: BRAND_VIEW_BRANDS_EVIDENCE_REPORT_KEYS.map((rk) => [rk, evidenceMaterialEntry(identities[rk], tied[rk])]), code: { ...code } }));
}

/**
 * The typed reason one account's directory evidence is INELIGIBLE, or null (PURE; the ONE predicate both the CLI's
 * revision -- brand-view-brands.release.js brandViewBrandsRevision -- and the worker compose apply).
 */
export function brandViewBrandsIneligibleReason(evidence) {
  if (!evidence || typeof evidence !== "object" || !evidence.identities) return "brand-directory-evidence-missing";
  if (Array.isArray(evidence.ambiguous) && evidence.ambiguous.length) return "latest-row-ambiguous:" + evidence.ambiguous[0];
  return null;
}

/**
 * PURE compose (shared by the worker and the CLI): rowsByName ({ latest_rows: [...] }) -> Map(accountId -> evidence)
 * for EVERY account in `accountIds` (an account with no source row at all still gets its all-absent evidence):
 *   { accountId, identities: { reportKey: identity|null }, ambiguous: [reportKey], ambiguousIds, token }
 */
export function composeBrandViewBrandsEvidence(rowsByName, { accountIds = [] } = {}) {
  const grouped = groupLatestRows(rowsByName && rowsByName.latest_rows);
  const out = new Map();
  for (const acct of accountIds) {
    const g = grouped.get(acct) || { rows: {}, ambiguous: [], ambiguousIds: {} };
    const identities = {};
    const ambiguousIds = {};
    for (const rk of BRAND_VIEW_BRANDS_EVIDENCE_REPORT_KEYS) {
      identities[rk] = snapshotRowIdentity(g.rows[rk] || null);
      if (g.ambiguousIds[rk]) ambiguousIds[rk] = [...g.ambiguousIds[rk]];
    }
    const ambiguous = g.ambiguous.filter((rk) => BRAND_VIEW_BRANDS_EVIDENCE_REPORT_KEYS.includes(rk));
    out.set(acct, { accountId: acct, identities, ambiguous, ambiguousIds, token: brandViewBrandsToken(acct, identities, ambiguousIds) });
  }
  return out;
}

/**
 * The typed reason an account is NOT ROUTABLE to a scheduler region (the worker dispatches per region), or null:
 * 'directory-country-missing' (no durable directory country) | 'directory-region-unassigned' (a country no region
 * serves). The CLI never scans such an account (its bucket is region-filtered), so no CLI token exists to match.
 */
export function routingIneligibleReason(country, region) {
  if (!S(country).trim()) return "directory-country-missing";
  return region ? null : "directory-region-unassigned";
}

const route = Object.freeze({
  id: BRAND_VIEW_BRANDS_ROUTE_ID,
  kind: "route-cli",
  cli: Object.freeze({ script: ROUTE_CLI_SCRIPT, fixedArgs: Object.freeze([]) }),
  publisherKeys: Object.freeze([BRAND_VIEW_BRANDS_PUBLISHER_KEY]),
  liveReportKeys: Object.freeze(["brand-view-brands"]),
  grain: "account",
  unit: "none",
  // fba-plan feeds the directory directly (C6: never the previous cycle's fba-plan); brand-sales is the OLI route's.
  awaits: Object.freeze(["oli", "fba-plan"]),
  deps: Object.freeze({
    sources: Object.freeze(["order-line-items", "product-catalog", "fba-inventory-health"]),
    reports: Object.freeze([...BRAND_VIEW_BRANDS_EVIDENCE_REPORT_KEYS]),
  }),
  evidence: Object.freeze({
    sql: Object.freeze([
      Object.freeze({ name: "latest_rows", text: LATEST_ROWS_SQL, params: (ctx = {}) => [[...BRAND_VIEW_BRANDS_EVIDENCE_REPORT_KEYS], evidenceAccountIds(ctx)] }),
    ]),
    // -> Map<targetKey (the account), { token, owners, region, alerts } | { token: null, owners, region, alerts, reason }>
    // (the returns-v3 compose contract) for EVERY evidence account: an eligible, routable account carries the CLI's
    // exact L1 token; an INELIGIBLE one (a tied latest row: 'latest-row-ambiguous:<report>', the CLI revision's own
    // typed reason) or an UNROUTABLE one ('directory-country-missing' / 'directory-region-unassigned' -- the directory
    // owns region membership) carries token null + its typed reason, never a token the CLI would refuse to publish under.
    compose: (rowsByName, ctx = {}) => {
      const ids = evidenceAccountIds(ctx);
      const ev = composeBrandViewBrandsEvidence(rowsByName, { accountIds: ids });
      const out = new Map();
      for (const acct of ids) {
        const dir = directoryEntry(ctx.directory, acct);
        const country = S(dir && dir.country).trim();
        const region = regionOfCountry(country);
        const e = ev.get(acct);
        const reason = routingIneligibleReason(country, region) || brandViewBrandsIneligibleReason(e);
        out.set(acct, reason ? { token: null, owners: [acct], region, alerts: [], reason } : { token: e.token, owners: [acct], region, alerts: [] });
      }
      return out;
    },
    everySeconds: 300,
  }),
  // The directory identity carries no as-of (asOfField null): nothing rolls over.
  identityAsOf: null,
  // target = the account id, or a record { targetKey | accountId }.
  tier1: Object.freeze({ liveRowScope: (target) => ({ reportKey: "brand-view-brands", accountIdEq: targetAccountId(target) }) }),
  deadlineSeconds: 330,
  hardTimeoutSeconds: 420,
  childHeapMb: 448,
  minChildHeapMb: 192,
  priority: 5,
  scanGroup: "brand-view",
});

export default route;
