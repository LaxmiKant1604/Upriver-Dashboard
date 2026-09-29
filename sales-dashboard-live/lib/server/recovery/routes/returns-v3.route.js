// Publication recovery WP5 -- the returns-v3 recovery ROUTE, WORKER side (the declarative scheduling contract; validated
// FAIL-CLOSED by route-contract.js validateRouteModule side:'worker' and paired with lib/server/sync/routes/
// returns-v3.release.js by validateRoutePair). It targets the Returns & Refund Leakage report users actually SEE: live
// report_key 'returns-leakage' at version 'returns-leakage-v3' (api/datadoe.js serveSelfHealingReturns), published
// through the publisher key 'returns-leakage-v3' (report-publisher.js; SOURCE_PROMOTED, never dispatched). The unserved
// 'returns-leakage' v2 dispatch contract is NOT this route's (legacy-superseded).
//
// EVIDENCE (the L1 token) is METADATA ONLY -- five single read-only SELECTs, never a payload, never a DataDoe call:
//   returns     source_returns_history     per account in returnsWindow(epoch): count, max(refreshed_at),
//                                           max(created_at), max(updated_at), max(return_date) -- created_at moves on
//                                           every replace (delete + insert), updated_at on any in-place UPDATE (the
//                                           20260914 source_returns_hist_touch trigger -> touch_updated_at());
//   settlement  source_settlement_history  the same over settlement_date (+ source_settle_hist_touch), plus the max
//                                           settlement_date of a row with a nonblank child_asin (the builder's
//                                           latestSettlementDate rule);
//   oli         source_coverage            the succeeded 'order-line-items' windows overlapping the window: count,
//                                           max(covered_to), md5 digest of (from, to, source_refreshed_at, updated_at);
//   opunits     source_oli_operational_units  count + max(updated_at) in the window (updated_at verified against the
//                                           20260901 DDL by scripts/returns-v3-route.test.js);
//   catalog     source_snapshots           the org 'product-catalog' pointer payload_sha (+ validated_at);
// plus the DURABLE directory country (normalized, UK -> GB). Every timestamp is rendered as UTC text inside SQL
// (to_char ... at time zone 'UTC') and every date as ::text -- never a JS Date on a local-timezone host.
//   L1 = 'rl1:' + sha256(stableJson([epoch, window.from, returns, settlement, oli, opunits, catalog sha, country])).
// The SAME SQL + the SAME pure compose run on BOTH sides: the worker's tier-1 scan (compose below) and the CLI's
// readScopeEvidence (returns-v3.release.js runs these exact texts through its read-only verified pg), so the token the
// worker claims a job with and the token the child evaluates are equal by construction.
//
// ELIGIBILITY (typed DEFERRED_PROVENANCE, never a zero payload, never an export): no Returns AND no Settlement row in
// the window -> 'returns-evidence-missing'; no dated evidence -> 'returns-evidence-missing'; no catalog pointer ->
// 'catalog-missing'; no directory country -> 'directory-country-missing'; OLI coverage ending before the identity date
// -> 'oli-coverage-short'. The identity as-of (the live { to }) is the evidence's latestDataDate = max(return date,
// nonblank-ASIN settlement date) <= epoch -- exactly what buildReturnsAdvancedPayload computes from the same rows.
// SOURCE AGE: when max(Returns, Settlement refreshed_at) is older than 168 h the target is still verified but carries
// the 'source-stale-manual' alert (the dedicated Returns acquisition is MANUAL-ONLY); it never triggers an export.
//
// WORKER CONTEXT this module assumes (WP11/WP12 supply it): sql[i].params(ctx) with ctx = { epoch, accountIds,
// organizationFingerprint, connectionId? } (throws -- fail closed -- on anything malformed); evidence.compose(rowsByName,
// { epoch, now, directory, accountIds? }) -> Map<accountId, { token, owners, region, targetAsOf?, alerts, reason? }>
// (an ineligible target carries token null + its typed reason); tier1.liveRowScope(target) with target.targetKey (or
// .accountId) = the account id. Pure; no I/O. 7-bit ASCII, LF.

import { createHash } from "node:crypto";
import { ROUTE_CLI_SCRIPT } from "../route-contract.js";
import { returnsWindow } from "../../sync/returns-source-refresh.js";
import { regionForCountry } from "../../sync/scheduler-scope.js";
import { normalizeMarketplace } from "../../sync/oli-sales-estimate.js";
import { stableJson, isCalendarDate } from "../../sync/publication-binding.js";

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";
const sha256 = (v) => createHash("sha256").update(String(v)).digest("hex");
const txt = (v) => (v == null || S(v) === "" ? null : S(v));
const int = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 0 ? n : 0; };
const maxOf = (xs) => xs.filter((x) => typeof x === "string" && x !== "").sort().slice(-1)[0] || null;

export const RETURNS_V3_ROUTE_ID = "returns-v3";
export const RETURNS_V3_PUBLISHER_KEY = "returns-leakage-v3";
export const RETURNS_V3_LIVE_REPORT_KEY = "returns-leakage";
export const RETURNS_V3_LIVE_VERSION = "returns-leakage-v3";
export const RETURNS_EVIDENCE_TOKEN_PREFIX = "rl1:";
export const RETURNS_SOURCE_STALE_HOURS = 168;
export const RETURNS_SOURCE_STALE_REASON = "source-stale-manual";
const OLI_SOURCE_KEY = "order-line-items";
const CATALOG_SOURCE_KEY = "product-catalog";
const ORGANIZATION_SCOPE_KEY = "__organization";

// A UTC ISO-8601 text rendering of a timestamptz aggregate, computed IN SQL (session-timezone independent).
const utcText = (expr) => `to_char(${expr} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const ACCOUNT_WINDOW = "organization_fingerprint = $1 and connection_id = $2 and account_id = any($3::text[])";

/** The route's per-account window: [returnsWindow(epoch).from, epoch] (the exact window gatherReturnsEvidence reads). */
export function returnsEvidenceWindow(epoch) {
  if (!isCalendarDate(epoch)) throw new Error("returns-v3 evidence: epoch must be a real YYYY-MM-DD date (fail closed).");
  const w = returnsWindow(epoch);
  return { from: w.from, to: epoch };
}

// params(ctx) for the four account-window queries: [orgFp, connectionId, accountIds, from, to]. Fail closed on any
// malformed context (a blank org would silently read nothing and look like missing evidence).
function windowParams(ctx = {}) {
  const org = S(ctx.organizationFingerprint).trim();
  const conn = S(ctx.connectionId || "primary");
  const ids = Array.isArray(ctx.accountIds) ? ctx.accountIds : null;
  if (!org || (conn !== "primary" && conn !== "dd-secondary") || !ids || !ids.every((a) => typeof a === "string" && a.trim() !== "" && a === a.trim())) {
    throw new Error("returns-v3 evidence params: { organizationFingerprint, connectionId, accountIds } are required (fail closed).");
  }
  const { from, to } = returnsEvidenceWindow(ctx.epoch);
  return [org, conn, [...ids], from, to];
}
function catalogParams(ctx = {}) {
  const org = S(ctx.organizationFingerprint).trim();
  const conn = S(ctx.connectionId || "primary");
  if (!org || (conn !== "primary" && conn !== "dd-secondary")) throw new Error("returns-v3 catalog params: { organizationFingerprint, connectionId } are required (fail closed).");
  return [org, conn];
}

/** The five METADATA-ONLY evidence queries (single read-only SELECTs; the static DDL test pins every column). */
export const RETURNS_V3_EVIDENCE_SQL = Object.freeze([
  Object.freeze({
    name: "returns",
    text: `select account_id, count(*)::int as n, ${utcText("max(refreshed_at)")} as refreshed, ${utcText("max(created_at)")} as created, ${utcText("max(updated_at)")} as updated, max(return_date)::text as max_date from public.source_returns_history where ${ACCOUNT_WINDOW} and return_date between $4::date and $5::date group by account_id`,
    params: windowParams,
  }),
  Object.freeze({
    name: "settlement",
    text: `select account_id, count(*)::int as n, ${utcText("max(refreshed_at)")} as refreshed, ${utcText("max(created_at)")} as created, ${utcText("max(updated_at)")} as updated, max(settlement_date)::text as max_date, (max(settlement_date) filter (where btrim(child_asin) <> ''))::text as max_asin_date from public.source_settlement_history where ${ACCOUNT_WINDOW} and settlement_date between $4::date and $5::date group by account_id`,
    params: windowParams,
  }),
  Object.freeze({
    name: "oli",
    text: `select account_id, count(*)::int as n, max(covered_to)::text as covered_to, md5(string_agg(covered_from::text || '..' || covered_to::text || '@' || coalesce(${utcText("source_refreshed_at")}, '-') || '@' || ${utcText("updated_at")}, ',' order by covered_from, covered_to)) as digest from public.source_coverage where ${ACCOUNT_WINDOW} and source_key = '${OLI_SOURCE_KEY}' and status = 'succeeded' and covered_to >= $4::date and covered_from <= $5::date group by account_id`,
    params: windowParams,
  }),
  Object.freeze({
    name: "opunits",
    text: `select account_id, count(*)::int as n, ${utcText("max(updated_at)")} as updated from public.source_oli_operational_units where ${ACCOUNT_WINDOW} and sale_date between $4::date and $5::date group by account_id`,
    params: windowParams,
  }),
  Object.freeze({
    name: "catalog",
    text: `select payload_sha, ${utcText("validated_at")} as validated from public.source_snapshots where organization_fingerprint = $1 and connection_id = $2 and source_key = '${CATALOG_SOURCE_KEY}' and scope_key = '${ORGANIZATION_SCOPE_KEY}'`,
    params: catalogParams,
  }),
]);

// The directory's normalized marketplace for an account ("" when unknown): a Map (buildDurableDirectory) or an array
// of { accountId, country | marketplace }. An ARRAY applies buildDurableDirectory's own exclusions to the account (ids
// compared trimmed): a prefixed (non-primary, ':') id or an id carried by MORE THAN ONE row has no country -- the CLI's
// Map (built by buildDurableDirectory) never holds such an account, so the worker's compose over an array can never
// make it eligible where the CLI's evaluation would not ('directory-country-missing' on both sides).
function directoryCountry(directory, accountId) {
  let e = null;
  if (directory instanceof Map) e = directory.get(accountId) || null;
  else if (Array.isArray(directory)) {
    const id = S(accountId).trim();
    const rows = directory.filter((d) => d && S(d.accountId).trim() === id);
    e = id && !id.includes(":") && rows.length === 1 ? rows[0] : null;
  }
  return e ? normalizeMarketplace(e.marketplace || e.country) : "";
}

/**
 * Per-account evidence (PURE) from the five query results. `accountIds` bounds the scope (an account with no row in any
 * query still gets an all-zero evidence object -> 'returns-evidence-missing'); without it, every account seen.
 * -> Map<accountId, { epoch, from, returns, settlement, oli, opunits, catalog, country }>
 */
export function returnsEvidenceByAccount(rowsByName = {}, { epoch, accountIds = null, directory = null } = {}) {
  const { from } = returnsEvidenceWindow(epoch);
  const byAcct = (name) => {
    const m = new Map();
    for (const r of Array.isArray(rowsByName[name]) ? rowsByName[name] : []) { const a = S(r && r.account_id); if (a) m.set(a, r); }
    return m;
  };
  const ret = byAcct("returns"); const set = byAcct("settlement"); const oli = byAcct("oli"); const opu = byAcct("opunits");
  const catRows = Array.isArray(rowsByName.catalog) ? rowsByName.catalog : [];
  // The pointer is unique per (org, connection, source, scope) (source_snapshots_pk): anything but ONE row is no proof.
  const catalog = catRows.length === 1 && nb(catRows[0] && catRows[0].payload_sha) ? { payloadSha: S(catRows[0].payload_sha), validated: txt(catRows[0].validated) } : null;
  const ids = Array.isArray(accountIds) ? [...new Set(accountIds.map(S).filter(Boolean))] : [...new Set([...ret.keys(), ...set.keys(), ...oli.keys(), ...opu.keys()])];
  const out = new Map();
  for (const a of ids.sort()) {
    const r = ret.get(a) || {}; const s = set.get(a) || {}; const o = oli.get(a) || {}; const u = opu.get(a) || {};
    out.set(a, {
      epoch, from,
      returns: { n: int(r.n), refreshed: txt(r.refreshed), created: txt(r.created), updated: txt(r.updated), maxDate: txt(r.max_date) },
      settlement: { n: int(s.n), refreshed: txt(s.refreshed), created: txt(s.created), updated: txt(s.updated), maxDate: txt(s.max_date), maxAsinDate: txt(s.max_asin_date) },
      oli: { n: int(o.n), coveredTo: txt(o.covered_to), digest: txt(o.digest) },
      opunits: { n: int(u.n), updated: txt(u.updated) },
      catalog,
      country: directoryCountry(directory, a),
    });
  }
  return out;
}

/**
 * The L1 revision of ONE account's evidence (PURE). -> { eligible:true, revisionId, evidenceToken, deps, status,
 * targetAsOf, sourceRefreshedMax } | { eligible:false, reason, status }. revisionId === evidenceToken (content-addressed);
 * deps are per-source digests (the job lineage records WHICH source moved).
 */
export function returnsRevision(ev, { epoch } = {}) {
  const no = (reason) => ({ eligible: false, reason, status: "missing" });
  if (!ev || typeof ev !== "object" || !ev.returns || !ev.settlement || !ev.oli || !ev.opunits) return no("returns-evidence-missing");
  if (!isCalendarDate(epoch) || ev.epoch !== epoch) return no("evidence-epoch-mismatch");
  const r = ev.returns; const s = ev.settlement;
  if (!(r.n > 0) && !(s.n > 0)) return no("returns-evidence-missing");
  const targetAsOf = maxOf([r.n > 0 ? r.maxDate : null, s.n > 0 ? s.maxAsinDate : null]);
  if (!isCalendarDate(targetAsOf) || targetAsOf > epoch) return no("returns-evidence-missing");
  if (!ev.catalog || !nb(ev.catalog.payloadSha)) return no("catalog-missing");
  if (!nb(ev.country)) return no("directory-country-missing");
  if (!isCalendarDate(ev.oli.coveredTo) || ev.oli.coveredTo < targetAsOf) return no("oli-coverage-short");
  const parts = {
    returns: ["returns", r.n, r.refreshed, r.created, r.updated, r.maxDate],
    settlement: ["settlement", s.n, s.refreshed, s.created, s.updated, s.maxDate, s.maxAsinDate],
    oli: ["oli", ev.oli.n, ev.oli.coveredTo, ev.oli.digest],
    opunits: ["opunits", ev.opunits.n, ev.opunits.updated],
  };
  const evidenceToken = RETURNS_EVIDENCE_TOKEN_PREFIX + sha256(stableJson([epoch, ev.from, parts.returns, parts.settlement, parts.oli, parts.opunits, ev.catalog.payloadSha, ev.country]));
  const deps = [
    "returns:" + sha256(stableJson(parts.returns)), "settlement:" + sha256(stableJson(parts.settlement)),
    "oli:" + sha256(stableJson(parts.oli)), "opunits:" + sha256(stableJson(parts.opunits)),
    "catalog:" + S(ev.catalog.payloadSha), "directory:" + S(ev.country),
  ].sort();
  return { eligible: true, revisionId: evidenceToken, evidenceToken, deps, status: "available", reason: null, targetAsOf, sourceRefreshedMax: maxOf([r.refreshed, s.refreshed]) };
}

/**
 * The SOURCE-AGE alert (PURE): 'source-stale-manual' when the freshest Returns / Settlement refreshed_at is older than
 * RETURNS_SOURCE_STALE_HOURS before `nowMs` (an unknown stamp alerts too), else null. Informational only: the unit is
 * still verified from saved evidence, and nothing here (or anywhere on this route) can start an export.
 */
export function returnsSourceAlert(ev, nowMs) {
  if (!ev || !ev.returns || !ev.settlement) return null;
  if (!(ev.returns.n > 0) && !(ev.settlement.n > 0)) return null;
  const t = Date.parse(S(maxOf([ev.returns.refreshed, ev.settlement.refreshed])));
  if (!Number.isFinite(t)) return RETURNS_SOURCE_STALE_REASON;
  return Number(nowMs) - t > RETURNS_SOURCE_STALE_HOURS * 3600 * 1000 ? RETURNS_SOURCE_STALE_REASON : null;
}

/** The worker's tier-1 compose (PURE): Map<accountId, { token, owners, region, targetAsOf?, alerts, reason? }>. */
export function composeReturnsTargets(rowsByName, { epoch, now = () => Date.now(), directory = null, accountIds = null } = {}) {
  const out = new Map();
  const nowMs = typeof now === "function" ? now() : Number(now);
  for (const [a, ev] of returnsEvidenceByAccount(rowsByName, { epoch, accountIds, directory })) {
    const rev = returnsRevision(ev, { epoch });
    const region = regionForCountry(ev.country);
    const alert = rev.eligible ? returnsSourceAlert(ev, nowMs) : null;
    out.set(a, rev.eligible
      ? { token: rev.evidenceToken, owners: [a], region, targetAsOf: rev.targetAsOf, alerts: alert ? [alert] : [] }
      : { token: null, owners: [a], region, alerts: [], reason: rev.reason });
  }
  return out;
}

const RETURNS_V3_ROUTE = Object.freeze({
  id: RETURNS_V3_ROUTE_ID,
  kind: "route-cli",
  cli: Object.freeze({ script: ROUTE_CLI_SCRIPT, fixedArgs: Object.freeze([]) }),
  publisherKeys: Object.freeze([RETURNS_V3_PUBLISHER_KEY]),
  liveReportKeys: Object.freeze([RETURNS_V3_LIVE_REPORT_KEY]),
  grain: "account",
  unit: "none",
  awaits: Object.freeze([]),
  deps: Object.freeze({ sources: Object.freeze(["returns", "settlement", "oli", "catalog", "directory"]), reports: Object.freeze([]) }),
  evidence: Object.freeze({ sql: RETURNS_V3_EVIDENCE_SQL, compose: composeReturnsTargets, everySeconds: 600 }),
  // The identity as-of is the EVIDENCE's latestDataDate (compose's targetAsOf), never a clock: no rollover function.
  identityAsOf: null,
  // Tier-1 served-row scope: every live row of the served report for the account (the serve reads the latest v3 row).
  tier1: Object.freeze({ liveRowScope: (target) => ({ reportKey: RETURNS_V3_LIVE_REPORT_KEY, accountIdEq: S(target && (target.targetKey ?? target.accountId)) }) }),
  deadlineSeconds: 330,
  hardTimeoutSeconds: 420,
  childHeapMb: 256,
  minChildHeapMb: 192,
  priority: 3,
  scanGroup: "returns",
});

export default RETURNS_V3_ROUTE;
