// Publication recovery WP7 -- the WORKER-side declaration of the fba-plan ZERO-EXPORT recovery route, plus the ONE
// shared, PURE evidence definition (metadata SQL + L1 token compose) that BOTH sides evaluate:
//   - the recovery worker runs FBA_PLAN_EVIDENCE_SQL over its read-only pool and composes the per-account L1 token
//     (default export .evidence.compose) that it claims a job with;
//   - the route CLI (lib/server/sync/routes/fba-plan.release.js) runs the SAME SQL through its verified read-only pg
//     client and the SAME composeFbaPlanEvidence, so the token the child evaluates is byte-identical to the token the
//     job was claimed with (the worker's VERIFIED rule). There is exactly ONE definition of the token -- here.
//
// L1 TOKEN (plan.json perReportMatrix fba-plan): 'fp2:' + sha256(JSON [inventoryAsOf, salesAsOf, FBA pointer
// source_request_hash, FBA payload_sha, AWD 'l_sha@l_at' | 'AWD-NA', OLI coverage digest, catalog payload_sha, country,
// rawSellerId, accountName]). Every derive input is folded: the FBA / AWD / catalog payloads are CONTENT-ADDRESSED
// (payload_sha), the OLI history is covered by the coverage digest (every OLI history write acknowledges its window in
// source_coverage with a fresh source_refreshed_at in the SAME transaction -- migration 20260901), and the directory
// name/country reach the payload (accountName / marketCountry / isUS). So equal token => equal derived payload modulo
// the two fetch stamps {inventoryFetchedAt, awdFetchedAt}.
// TOKEN VERSION 'fp2:' (WP7 round 4) = the FILL-ONLY publication policy + the paid-fetch-only evidence stamp (the route's
// source_refreshed_at is max(FBA validated_at, AWD validated_at) -- no longer OLI / catalog instants). The inputs are
// unchanged; the version moves so NO state keyed by an 'fp1:' token (a worker verdict such as a token-terminal
// 'superseded', an fp1 route job's lineage, an fp1 route row) is ever reused under the new policy: an fp1 job / row
// carries no fp2 lineage, so the route treats it as FOREIGN (fail closed: never replaced, never resumed).
//
// salesAsOf is the REGION's go-live as-of: resolveGoLiveAsOf over every region account's proven OLI covered_to
// (maxBlocked 2, ceiling = the epoch = inventoryAsOf = UTC D-1) -- the SAME pure function the paid fba-plan job uses
// (fba-plan-operation.js resolveFbaPlanScope). It is always computed over the WHOLE region (never the scan scope), so a
// single-account re-read at publish time yields the same value.
//
// METADATA ONLY: the SQL reads pointer / coverage columns (never a payload); dates are cast ::text (a Postgres `date`
// read through node-postgres' default parser becomes a LOCAL-midnight Date -- an IST host would shift it a day);
// timestamps are normalized to millisecond UTC ISO by isoMs (a Date or an OFFSET-BEARING string -- a naive string is
// refused, never parsed as local time), so the worker pool (Date objects) and the CLI client produce the SAME token text.
// Pure; no I/O. 7-bit ASCII, LF.

import { createHash } from "node:crypto";
import { ROUTE_CLI_SCRIPT } from "../route-contract.js";
import { isValidRfc3339Timestamp } from "../../rfc3339-timestamp.js";
import { resolveGoLiveAsOf } from "../../sync/fba-plan-golive-plan.js";
import { awdCapableMarketplace } from "../../reports/awd-capability.js";
import { planMonthWindows } from "../../date-windows.js";
import { accountInScope, regionForCountry, REGION_SCOPES } from "../../sync/scheduler-scope.js";
import { normalizeMarketplace } from "../../sync/oli-sales-estimate.js";

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";
const sha256 = (v) => createHash("sha256").update(String(v)).digest("hex");
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v) => typeof v === "string" && DATE_RE.test(v) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;

export const FBA_PLAN_ROUTE_ID = "fba-plan";
export const FBA_PLAN_TOKEN_PREFIX = "fp2:";
export const FBA_PLAN_MAX_BLOCKED = 2;
export const AWD_NA = "AWD-NA";

// An OFFSET-BEARING timestamp string: RFC3339 ('T' / 't') or the Postgres timestamptz text rendering (' ' separator),
// an optional fraction, and Z or a numeric offset +-HH / +-HHMM / +-HH:MM. A string WITHOUT an offset is NOT an instant:
// V8's Date.parse reads '2026-09-24T10:00:00' as LOCAL time (an IST host shifts it 5h30 earlier), so it is refused.
const OFFSET_TS_RE = /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}:\d{2}:\d{2})(\.\d{1,9})?([Zz]|[+-]\d{2}(?::?\d{2})?)$/;

/**
 * The epoch ms of a Date or an OFFSET-BEARING timestamp string (canonicalized to strict RFC3339 -- a real calendar date
 * + time, the fraction truncated to ms exactly as V8 does -- and validated by isValidRfc3339Timestamp); NaN for anything
 * else: a naive (offset-less) / malformed string, a number, null. Never a local-time parse.
 */
export function offsetInstantMs(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v !== "string") return NaN;
  const m = OFFSET_TS_RE.exec(v);
  if (!m) return NaN;
  const off = /^[Zz]$/.test(m[4]) ? "Z" : m[4].slice(0, 3) + ":" + (m[4].slice(3).replace(":", "") || "00");
  const canon = m[1] + "T" + m[2] + (m[3] ? m[3].slice(0, 4) : "") + off;
  return isValidRfc3339Timestamp(canon) ? Date.parse(canon) : NaN;
}

/** A timestamp (Date | offset-bearing string) as millisecond UTC ISO ("" when absent / naive / unparseable). */
export function isoMs(v) {
  if (v == null || v === "") return "";
  const t = offsetInstantMs(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : "";
}

// The worker's ctx and the CLI's ctx both carry the organization fingerprint and the REGION's account ids (the CLI
// passes accountIds; a worker ctx may instead carry directory + region).
const orgOf = (ctx) => S(ctx && (ctx.organizationFingerprint != null ? ctx.organizationFingerprint : ctx.orgFp));
function regionIdsOf(ctx) {
  if (ctx && Array.isArray(ctx.accountIds)) return [...new Set(ctx.accountIds.map(S).filter(nb))].sort();
  const dir = ctx && ctx.directory instanceof Map ? ctx.directory : new Map();
  const region = S(ctx && (ctx.region || ctx.bucket));
  const out = [];
  for (const [id, m] of dir) if (!region || accountInScope(region, S(m && m.country).toUpperCase())) out.push(S(id));
  return out.sort();
}

// METADATA-ONLY, READ-ONLY evidence SQL (route-contract.js isReadOnlyEvidenceSql): one SELECT each, no ';'. $1 = the
// organization fingerprint, $2 = the region's account ids. Only the PRIMARY connection (the durable directory holds
// primary accounts only). Column names verified against the DDL: source_snapshots (20260820), source_listings_snapshot
// (20260926), source_coverage (20260820: covered_from / covered_to / status / source_refreshed_at).
export const FBA_PLAN_EVIDENCE_SQL = Object.freeze([
  Object.freeze({
    name: "fba_pointers",
    text: "select s.scope_key as account_id, s.organization_fingerprint, s.connection_id, s.source_key, s.scope_key, s.object_path, s.payload_sha, s.row_count, s.source_request_hash, s.validated_at from public.source_snapshots s where s.organization_fingerprint = $1 and s.connection_id = 'primary' and s.source_key = 'fba-inventory-health' and s.scope_key = any($2::text[])",
    params: (ctx) => [orgOf(ctx), regionIdsOf(ctx)],
  }),
  Object.freeze({
    name: "awd_pointers",
    text: "select l.account_id, l.organization_fingerprint, l.connection_id, l.marketplace, l.source_key, l.as_of::text as as_of, l.object_path, l.payload_sha, l.row_count, l.source_request_hash, l.validated_at from public.source_listings_snapshot l where l.organization_fingerprint = $1 and l.connection_id = 'primary' and l.account_id = any($2::text[])",
    params: (ctx) => [orgOf(ctx), regionIdsOf(ctx)],
  }),
  Object.freeze({
    name: "oli_coverage",
    text: "select c.account_id, c.covered_from::text as covered_from, c.covered_to::text as covered_to, c.source_refreshed_at from public.source_coverage c where c.organization_fingerprint = $1 and c.connection_id = 'primary' and c.source_key = 'order-line-items' and c.status = 'succeeded' and c.account_id = any($2::text[])",
    params: (ctx) => [orgOf(ctx), regionIdsOf(ctx)],
  }),
  Object.freeze({
    name: "catalog_pointer",
    text: "select s.organization_fingerprint, s.connection_id, s.source_key, s.scope_key, s.object_path, s.payload_sha, s.row_count, s.source_request_hash, s.validated_at from public.source_snapshots s where s.organization_fingerprint = $1 and s.connection_id = 'primary' and s.source_key = 'product-catalog' and s.scope_key = '__organization'",
    params: (ctx) => [orgOf(ctx)],
  }),
]);

// A pointer row with its timestamp normalized (never mutates the input).
const pointerOf = (r) => (r && typeof r === "object" ? { ...r, validated_at: isoMs(r.validated_at) } : null);

/** The OLI plan window [completed[0].from .. salesAsOf] of fba-plan (planMonthWindows), or null for a non-date. */
export function fbaPlanOliWindow(salesAsOf) {
  if (!isDate(salesAsOf)) return null;
  const { completed } = planMonthWindows(salesAsOf);
  return { from: completed[0].from, to: salesAsOf };
}

/**
 * The OLI coverage digest: the (from, to, source_refreshed_at) of every coverage window OVERLAPPING the plan window
 * (all windows when salesAsOf is unresolved), sorted. Any OLI history write in the window re-acknowledges its coverage
 * row with a fresh source_refreshed_at, so the digest moves whenever the derive's OLI input can.
 */
export function fbaPlanCoverageDigest(windows, salesAsOf) {
  const w = fbaPlanOliWindow(salesAsOf);
  const list = (Array.isArray(windows) ? windows : [])
    .filter((x) => x && isDate(x.from) && isDate(x.to) && (!w || (x.to >= w.from && x.from <= w.to)))
    .map((x) => x.from + "|" + x.to + "|" + S(x.refreshedAt))
    .sort();
  return sha256("fba-plan-oli-coverage-v1" + JSON.stringify(list));
}

/**
 * The AWD part of the token: 'l_sha@l_at' of the durable Listings pointer when the marketplace is AWD-capable (US +
 * EU5, UK->GB) AND the pointer exists with as_of >= inventoryAsOf; otherwise 'AWD-NA'. Metadata-level (the CLI's deep
 * checks may still refuse the rows; the token only identifies the evidence).
 */
export function fbaPlanAwdTokenPart({ awdPointer, country, inventoryAsOf }) {
  if (!awdCapableMarketplace(normalizeMarketplace(country))) return AWD_NA;
  if (!awdPointer || !isDate(S(awdPointer.as_of)) || !isDate(S(inventoryAsOf)) || S(awdPointer.as_of) < S(inventoryAsOf)) return AWD_NA;
  return S(awdPointer.payload_sha) + "@" + isoMs(awdPointer.validated_at);
}

/** The L1 evidence token ('fp2:' + sha256 of the canonical JSON input list). Missing parts are typed sentinels. */
export function fbaPlanEvidenceToken({ inventoryAsOf, salesAsOf, fbaPointer, awdPart, coverageDigest, catalogPointer, country, rawSellerId, accountName }) {
  return FBA_PLAN_TOKEN_PREFIX + sha256(JSON.stringify([
    S(inventoryAsOf),
    nb(salesAsOf) ? S(salesAsOf) : "SALES-NA",
    fbaPointer ? S(fbaPointer.source_request_hash) : "FBA-NA",
    fbaPointer ? S(fbaPointer.payload_sha) : "FBA-NA",
    S(awdPart) || AWD_NA,
    S(coverageDigest),
    catalogPointer ? S(catalogPointer.payload_sha) : "CAT-NA",
    S(country),
    S(rawSellerId),
    S(accountName),
  ]));
}

/** The region's go-live sales as-of (resolveGoLiveAsOf; the paid job's pure function) over { accountId, provenTo }. */
export function fbaPlanRegionSalesAsOf(proven, inventoryAsOf) {
  if (!isDate(S(inventoryAsOf))) return { asOf: null, included: [], blocked: [] };
  return resolveGoLiveAsOf(proven, { ceiling: S(inventoryAsOf), maxBlocked: FBA_PLAN_MAX_BLOCKED });
}

/**
 * Compose the per-account fba-plan evidence (PURE) from the evidence SQL rows. ctx: { epoch (= inventoryAsOf, UTC D-1),
 * directory: Map(accountId -> { country, rawSellerId, name }), region? | accountIds? }. Accounts: ctx.accountIds when
 * given, else every directory account (in ctx.region when given). salesAsOf is computed PER REGION over every region
 * account's proven OLI coverage. Returns { perAccount: Map(accountId -> evidence), salesAsOfByRegion }. Each evidence:
 *   { accountId, region, country, marketplace, rawSellerId, accountName, inventoryAsOf, salesAsOf, provenTo,
 *     fbaPointer|null, awdPointer|null, catalogPointer|null, coverage:[{from,to,refreshedAt}], duplicatePointer, token }
 */
export function composeFbaPlanEvidence(rowsByName, ctx = {}) {
  const rows = (name) => (rowsByName && Array.isArray(rowsByName[name]) ? rowsByName[name] : []);
  const inventoryAsOf = S(ctx.epoch);
  const dir = ctx.directory instanceof Map ? ctx.directory : new Map();
  const ids = regionIdsOf(ctx).filter((id) => dir.has(id) || Array.isArray(ctx.accountIds));
  const byAcct = (list) => { const m = new Map(); for (const r of list) { const a = S(r && r.account_id); if (!m.has(a)) m.set(a, []); m.get(a).push(r); } return m; };
  const fba = byAcct(rows("fba_pointers"));
  const awd = byAcct(rows("awd_pointers"));
  const cov = byAcct(rows("oli_coverage"));
  const catRows = rows("catalog_pointer");
  const catalogPointer = catRows.length === 1 ? pointerOf(catRows[0]) : null;
  const catalogDuplicate = catRows.length > 1;
  const coverageOf = (a) => (cov.get(a) || []).map((r) => ({ from: S(r.covered_from), to: S(r.covered_to), refreshedAt: isoMs(r.source_refreshed_at) }));
  const provenToOf = (a) => { const tos = coverageOf(a).map((w) => w.to).filter(isDate); return tos.length ? tos.reduce((m, t) => (t > m ? t : m)) : null; };
  const regionOf = (a) => { const m = dir.get(a); return S(ctx.region) || regionForCountry(S(m && m.country).toUpperCase()); };

  // Per REGION: the go-live as-of over EVERY region account (never the scan scope).
  const salesAsOfByRegion = new Map();
  for (const region of REGION_SCOPES) {
    const members = ids.filter((a) => regionOf(a) === region);
    if (!members.length) continue;
    salesAsOfByRegion.set(region, fbaPlanRegionSalesAsOf(members.map((a) => ({ accountId: a, provenTo: provenToOf(a) })), inventoryAsOf));
  }

  const perAccount = new Map();
  for (const a of ids) {
    const m = dir.get(a) || {};
    const region = regionOf(a);
    const scope = salesAsOfByRegion.get(region) || { asOf: null };
    const salesAsOf = isDate(S(scope.asOf)) ? S(scope.asOf) : null;
    const fbaList = fba.get(a) || [];
    const awdList = awd.get(a) || [];
    const fbaPointer = fbaList.length === 1 ? pointerOf(fbaList[0]) : null;
    const awdPointer = awdList.length === 1 ? pointerOf(awdList[0]) : null;
    const coverage = coverageOf(a);
    const country = S(m.country);
    const accountName = m.name ? S(m.name) : "";
    const rawSellerId = S(m.rawSellerId);
    const awdPart = fbaPlanAwdTokenPart({ awdPointer, country, inventoryAsOf });
    const coverageDigest = fbaPlanCoverageDigest(coverage, salesAsOf);
    perAccount.set(a, Object.freeze({
      accountId: a, region, country, marketplace: normalizeMarketplace(country), rawSellerId, accountName,
      inventoryAsOf, salesAsOf, provenTo: provenToOf(a),
      fbaPointer, awdPointer, catalogPointer,
      duplicatePointer: fbaList.length > 1 || awdList.length > 1 || catalogDuplicate,
      coverage, awdPart, coverageDigest,
      token: fbaPlanEvidenceToken({ inventoryAsOf, salesAsOf, fbaPointer, awdPart, coverageDigest, catalogPointer, country, rawSellerId, accountName }),
    }));
  }
  return { perAccount, salesAsOfByRegion };
}

// The live-row scope of a target for the tier-1 consistency scan (account grain: the target IS the account).
const targetAccountId = (target) => S(typeof target === "string" ? target : target && (target.targetKey || target.accountId || target.targetId));

export default Object.freeze({
  id: FBA_PLAN_ROUTE_ID,
  kind: "route-cli",
  cli: Object.freeze({ script: ROUTE_CLI_SCRIPT, fixedArgs: Object.freeze([]) }),
  publisherKeys: Object.freeze(["fba-plan"]),
  liveReportKeys: Object.freeze(["fba-plan"]),
  grain: "account",
  unit: "none",
  awaits: Object.freeze([]),
  deps: Object.freeze({
    sources: Object.freeze(["fba-inventory-health", "listings", "order-line-items", "product-catalog", "account-directory"]),
    reports: Object.freeze([]),
  }),
  evidence: Object.freeze({
    sql: FBA_PLAN_EVIDENCE_SQL,
    // -> Map<targetKey (the account id), { token, owners, region, alerts }>; the token is the CLI's L1 evidence token
    // (WP11 pinned compose shape: alerts always present -- none here).
    compose: (rowsByName, ctx = {}) => {
      const { perAccount } = composeFbaPlanEvidence(rowsByName, ctx);
      const out = new Map();
      for (const [id, e] of perAccount) out.set(id, { token: e.token, owners: [id], region: e.region, alerts: [] });
      return out;
    },
    everySeconds: 300,
  }),
  // The identity as-of (salesAsOf) depends on durable OLI coverage -- it is resolved by the evidence compose / the CLI,
  // never from (target, now) alone.
  identityAsOf: null,
  tier1: Object.freeze({ liveRowScope: (target) => ({ reportKey: "fba-plan", accountIdEq: targetAccountId(target) }) }),
  deadlineSeconds: 600,
  hardTimeoutSeconds: 720,
  childHeapMb: 448,
  minChildHeapMb: 320,
  priority: 2,
  scanGroup: "fba-plan",
});
