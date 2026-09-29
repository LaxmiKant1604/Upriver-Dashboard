// Publication recovery worker -- the ROUTE REGISTRY (WP11; replaces the ffb035b four-family RECOVERY_FAMILIES design).
//
// ONE explicit, FAIL-CLOSED classification of EVERY report key the codebase knows (REPORT_MATERIALIZATION,
// SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, SOURCE_PROMOTED_REPORT_KEYS, CONTROLLED_REPORT_KEYS, the static KNOWN_SNAPSHOT_KEYS
// list and the operational lock / owner keys) into exactly ONE class:
//   route:<id>[+<id>...]          published from durable saved evidence by those publication routes (routes.js)
//   manual-paid                   only a PAID refresh / admin dispatch produces it (no durable evidence)
//   dormant                       no automatic writer and no page caller
//   read-only-self-heal           derived on every read from durable rows; no stored publication target
//   legacy-superseded:<id>        a superseded publisher CONTRACT (never served) whose report the route <id> owns
//   source-snapshot-not-report    an operational / source row (or a lock / owner key), never a dashboard publication
//   shadow-namespace-never-live   the scheduler-v2/* shadow namespace (a shadow is never a publication)
// Every non-route class carries a reason. validateRouteRegistry() THROWS when a key is unclassified or double-
// classified, when a route lacks deps / evidence / a served selector for any publisher contract, when a publisher key
// has no REPORT_DERIVATIONS entry or is outside READY u SOURCE_PROMOTED, when awaits name an unknown id or form a cycle,
// when a route-cli has no lib/server/sync/routes/<id>.release.js, when a script is forbidden, and when a
// REPORT_MATERIALIZATION.materializationOwner contradicts the classification (C10: a scheduler-owned report MUST be
// route-owned) -- so registering a report without deciding how the worker treats it breaks the suite and the worker's
// startup check instead of being silently skipped.
//
// WORKER GRAPH: this module is imported by the worker entrypoint, so it imports ONLY pure registries (report-controls,
// report-derivation, report-materialization-registry, serve-selectors) and never report-publisher.js (whose closure
// holds the publisher, report-store.js and supabase.js writers -- scripts/worker-closure.test.js forbids them). The
// live-contract table is therefore PINNED here as { publisherKey: liveReportKey } (LIVE_CONTRACT_PINS) and
// scripts/recovery-registry-completeness.test.js asserts it EQUALS SCHEDULER_LIVE_SNAPSHOT_CONTRACTS; tests (and any
// caller that already holds the real table) pass `liveContracts` to validate against the real contracts. 7-bit ASCII, LF.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLICATION_ROUTES, ALLOWED_WORKER_SCRIPTS } from "./routes.js";
import { workerRouteProblems, routeTopoOrder, ROUTE_ID_RE, ROUTE_REGIONS } from "./route-contract.js";
import * as SERVE_SELECTORS from "./serve-selectors.js";
import { ADS_CLI_OPERATION_REPORT_KEYS as ADS_OPERATION_KEYS } from "./routes/ads.route.js";
import { REPORT_DERIVATIONS } from "../sync/report-derivation.js";
import { CONTROLLED_REPORT_KEYS, SCHEDULER_V2_READY_REPORT_KEYS, SOURCE_PROMOTED_REPORT_KEYS } from "../sync/report-controls.js";
import { REPORT_MATERIALIZATION } from "../reports/report-materialization-registry.js";

const S = (v) => (v == null ? "" : String(v));
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const RECOVERY_REGIONS = ROUTE_REGIONS;
export const ADS_CLI_OPERATION_REPORT_KEYS = ADS_OPERATION_KEYS;
export const SHADOW_NAMESPACE_PREFIX = "scheduler-v2/";
export const CLASS_KINDS = Object.freeze(["route", "manual-paid", "dormant", "read-only-self-heal", "legacy-superseded", "source-snapshot-not-report", "shadow-namespace-never-live"]);

// The static report_snapshots keys that are NOT in any registry (plan WP11): directory / catalog / FX operational rows
// and the read-only / dormant report keys a page may still request.
export const KNOWN_SNAPSHOT_KEYS = Object.freeze([
  "account-directory", "brand-catalog", "brand-catalog-attempt", "brand-catalog-action", "fx-rates",
  "sales", "brand-portfolio", "brand-directory", "oli-quality", "oli-quality-summary",
]);
// Operational LOCK / OWNER keys that reuse the reportKey field (found by the static literal scan of lib/, api/ and
// scripts/release/): never a report_snapshots publication.
export const OPERATIONAL_REPORT_KEYS = Object.freeze(["source-sync", "scheduled-sync", "account-directory-sync", "automated-ads-sync-v1", "manual-source-attempt"]);

// The 10 ACTIVE publication-required dashboard reports -- each MUST be route-owned.
export const ACTIVE_PUBLICATION_REPORT_KEYS = Object.freeze([
  "brand-sales", "daily-reporting", "brand-inventory", "listing-health-v3", "fba-plan", "sku-movement", "returns-leakage",
  "brand-view-brands", "brand-view", "brand-view-portfolio",
]);

// SCHEDULER_LIVE_SNAPSHOT_CONTRACTS pinned as { publisherKey: { liveReportKey } } (report-publisher.js must stay OUT of
// the worker graph). The completeness suite asserts this EQUALS the real table (keys + liveReportKey).
export const LIVE_CONTRACT_PINS = Object.freeze(Object.fromEntries([
  ["brand-sales", "brand-sales"], ["daily-reporting", "daily-reporting"], ["reconciliation", "reconciliation"], ["sku-pl", "sku-pl"],
  ["keyword-rank", "keyword-rank"], ["content-changes", "content-changes"], ["fba-plan", "fba-plan"], ["sales-movers", "sales-movers"],
  ["listing-health", "listing-health"], ["buy-box-loss", "buy-box-loss"], ["returns-leakage", "returns-leakage"], ["ppc-performance", "ppc-performance"],
  ["listing-optimizer", "listing-optimizer"], ["brand-inventory", "brand-inventory"], ["listing-health-v3", "listing-health-v3"],
  ["sku-movement", "sku-movement"], ["returns-leakage-v3", "returns-leakage"], ["brand-view-brands", "brand-view-brands"],
  ["brand-view", "brand-view"], ["brand-view-portfolio", "brand-view-portfolio"],
].map(([k, live]) => [k, Object.freeze({ liveReportKey: live })])));

// The SERVE read path each route publisher key is verified against (lib/server/recovery/serve-selectors.js; the
// perReportMatrix freshness proofs): a route without a served selector for any of its publisher contracts is refused.
export const SERVED_SELECTOR_FOR_PUBLISHER_KEY = Object.freeze({
  "brand-sales": "selectExactThenLatest",                 // serveSharedReport: exact, else the ONE latest row
  "daily-reporting": "selectExactThenScopeLatest",        // latest-for-scope { brand: ALL } + version filter
  "brand-inventory": "selectInventoryAuthoritative",      // Brand View's authoritative compact selection
  "listing-health-v3": "selectLhv3",                      // flag-aware LHv3 live serve
  "fba-plan": "selectExactThenLatest",
  "returns-leakage-v3": "selectLatestForScope",           // serveSelfHealingReturns (version returns-leakage-v3, scope {})
  "sku-movement": "selectLatestForScope",                 // serveSelfHealingSkuMovement (sku-movement/v2, { brand })
  "brand-view-brands": "selectExact",                     // brandViewDirectory exact { accountId }
  "brand-view": "selectExactThenLatest",                  // exact at the browser as-of, else the latest for the scope id
  "brand-view-portfolio": "selectExactThenScopeLatest",   // exact identity; stale scope { region }
});

// CONTRACT-level overrides: a SCHEDULER_LIVE_SNAPSHOT_CONTRACTS key whose contract is superseded by a route while its
// live report_key is route-owned. 'returns-leakage' is the UNSERVED v2 dispatch contract (liveReportVersion
// returns-leakage-v2); the served v3 report is published by route returns-v3 under publisher key returns-leakage-v3.
export const CONTRACT_CLASSIFICATION_OVERRIDES = Object.freeze({
  "returns-leakage": Object.freeze({ cls: "legacy-superseded:returns-v3", reason: "the unserved v2 dispatch contract (liveReportVersion returns-leakage-v2); the served Returns & Refund Leakage v3 row is published by route returns-v3 under publisher key returns-leakage-v3" }),
});

const MANUAL_PAID_REASON = "no durable source evidence: only a paid refresh=1 / admin dispatch produces it; not an active publication target";
const SRC_REASON = "an operational or source row stored in report_snapshots, not a dashboard publication";
const LOCK_REASON = "an operational lock / owner key (report_locks / sync ownership), never a report_snapshots publication";

// THE classification (an ARRAY so a double classification is detectable -- an object literal silently keeps the last).
export const REPORT_RECOVERY_CLASSIFICATION_ENTRIES = Object.freeze([
  { reportKey: "brand-sales", cls: "route:oli", reason: "Dashboard / Account brand sales: published from durable OLI by the zero-export OLI reconciler (legacy-cli route oli)" },
  { reportKey: "daily-reporting", cls: "route:oli+ads", reason: "Daily Reporting (ALL brand): the OLI reconciler and the Campaign-Ads reconciler (ads awaits oli); named brands derive read-only at serve" },
  { reportKey: "brand-inventory", cls: "route:oli+fba", reason: "compact Brand View inventory: the OLI trio and the FBA brand-inventory reconciler (fba awaits oli)" },
  { reportKey: "listing-health-v3", cls: "route:listings", reason: "Listing Health v3: the zero-export LHv3 reconciler (legacy-cli route listings)" },
  { reportKey: "fba-plan", cls: "route:fba-plan", reason: "FBA Shipment Plan: zero-export route fba-plan (content-equivalent to the paid job's publish)" },
  { reportKey: "sku-movement", cls: "route:sku-movement", reason: "SKU Movement: zero-export route sku-movement (units ALL + the verified brand directory)" },
  { reportKey: "returns-leakage", cls: "route:returns-v3", reason: "the SERVED Returns & Refund Leakage v3 (live report_key returns-leakage, version returns-leakage-v3): route returns-v3; its unserved v2 dispatch contract is legacy-superseded:returns-v3 (CONTRACT_CLASSIFICATION_OVERRIDES)" },
  { reportKey: "returns-leakage-v3", cls: "route:returns-v3", reason: "the route publisher key of the served Returns v3 report" },
  { reportKey: "brand-view-brands", cls: "route:brand-view-brands", reason: "the Brand View per-account brand directory: zero-export route brand-view-brands" },
  { reportKey: "brand-view", cls: "route:brand-view", reason: "account-scoped Brand View: zero-export route brand-view (one unit per verified brand)" },
  { reportKey: "brand-view-portfolio", cls: "route:brand-view-portfolio", reason: "cross-account Brand View portfolio: zero-export route brand-view-portfolio (region grain)" },
  ...["reconciliation", "sku-pl", "keyword-rank", "content-changes", "sales-movers", "listing-health", "buy-box-loss", "listing-optimizer", "ppc-performance"]
    .map((reportKey) => ({ reportKey, cls: "manual-paid", reason: MANUAL_PAID_REASON + (reportKey === "ppc-performance" ? " (the Ads CLI deliberately supersedes it; the campaign view derives at serve)" : "") })),
  { reportKey: "sales", cls: "dormant", reason: "no src/ caller; manual-refresh only; no automatic writer" },
  { reportKey: "brand-portfolio", cls: "dormant", reason: "legacy brand portfolio: no src/ caller; written only by refresh=1 (api/datadoe.js); no automatic writer" },
  { reportKey: "brand-directory", cls: "read-only-self-heal", reason: "derived on every read from durable brand-sales membership (membership fingerprint); no stored publication target" },
  { reportKey: "oli-quality", cls: "read-only-self-heal", reason: "derived at serve from durable OLI rows; no stored publication target" },
  { reportKey: "oli-quality-summary", cls: "read-only-self-heal", reason: "derived at serve from durable OLI rows; no stored publication target" },
  ...["account-directory", "brand-catalog", "brand-catalog-attempt", "brand-catalog-action", "fx-rates"].map((reportKey) => ({ reportKey, cls: "source-snapshot-not-report", reason: SRC_REASON })),
  ...OPERATIONAL_REPORT_KEYS.map((reportKey) => ({ reportKey, cls: "source-snapshot-not-report", reason: LOCK_REASON })),
  { reportKey: SHADOW_NAMESPACE_PREFIX + "*", cls: "shadow-namespace-never-live", reason: "the scheduler-v2/<key> shadow namespace: a shadow / job row is never a publication (completion needs the live served row)" },
].map((e) => Object.freeze(e)));

/** Parse a class string -> { kind, routes: [ids] } (THROWS on an unknown / malformed class). */
export function parseRecoveryClass(cls) {
  const s = S(cls);
  if (s.startsWith("route:")) {
    const ids = s.slice(6).split("+");
    if (!ids.length || !ids.every((id) => ROUTE_ID_RE.test(id)) || new Set(ids).size !== ids.length) throw new Error(`publication-recovery registry: malformed class '${s}' (fail closed).`);
    return { kind: "route", routes: ids };
  }
  if (s.startsWith("legacy-superseded:")) {
    const id = s.slice("legacy-superseded:".length);
    if (!ROUTE_ID_RE.test(id)) throw new Error(`publication-recovery registry: malformed class '${s}' (fail closed).`);
    return { kind: "legacy-superseded", routes: [id] };
  }
  if (CLASS_KINDS.includes(s) && s !== "route" && s !== "legacy-superseded") return { kind: s, routes: [] };
  throw new Error(`publication-recovery registry: unknown class '${s.slice(0, 60)}' (fail closed).`);
}

/** entries -> Map(reportKey -> entry). THROWS on a double classification or a malformed entry. */
export function buildClassificationMap(entries = REPORT_RECOVERY_CLASSIFICATION_ENTRIES) {
  const m = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    const key = S(e && e.reportKey);
    if (!key) throw new Error("publication-recovery registry: a classification entry has no reportKey (fail closed).");
    if (m.has(key)) throw new Error(`publication-recovery registry: report '${key}' is double-classified (fail closed).`);
    const c = parseRecoveryClass(e.cls);
    if (c.kind !== "route" && S(e.reason).trim() === "") throw new Error(`publication-recovery registry: report '${key}' class '${e.cls}' needs a reason (fail closed).`);
    m.set(key, Object.freeze({ reportKey: key, cls: S(e.cls), kind: c.kind, routes: Object.freeze(c.routes), reason: S(e.reason) }));
  }
  return m;
}
export const REPORT_RECOVERY_CLASSIFICATION = buildClassificationMap();

/** The classification of ONE key (the scheduler-v2/* namespace included), or null when unclassified. */
export function classifyReportKey(reportKey, map = REPORT_RECOVERY_CLASSIFICATION) {
  const k = S(reportKey);
  if (k.startsWith(SHADOW_NAMESPACE_PREFIX)) return map.get(SHADOW_NAMESPACE_PREFIX + "*") || null;
  return map.get(k) || null;
}

/**
 * The report keys a route's TARGETS units carry = its PUBLISHER keys (a route CLI's units carry the publisher key, e.g.
 * 'returns-leakage-v3'; a legacy family's v1 reports are keyed by its publisher keys too). The ONE source the worker
 * uses to select a target's units for jobVerdict (never the live report keys: 'returns-leakage' != 'returns-leakage-v3').
 */
export const verdictReportKeys = (route) => route.publisherKeys;

/** The owner hand-off class of a NON-route report class ('not-applicable:<type>'), or null for a route class. */
export function handoffForReportClass(entry) {
  if (!entry || entry.kind === "route") return null;
  if (entry.kind === "manual-paid") return "not-applicable:manual-paid";
  if (entry.kind === "read-only-self-heal") return "not-applicable:read-only-self-heal";
  return "not-applicable:" + entry.kind;
}

// Scripts the worker must NEVER spawn (paid exports, lease / control primitives, scheduler operators, legacy
// materializers, the returns go-live and EVERY backfill). Enforced at the runner boundary (plus the allow-list:
// ALLOWED_WORKER_SCRIPTS) and by a static test that enumerates scripts/release/backfill-*.mjs.
export const FORBIDDEN_WORKER_SCRIPTS = Object.freeze([
  "fba-plan-golive.mjs", "listing-health-v3-ingestion.mjs", "priority-dashboards-release.mjs", "priority-control-package.mjs",
  "bootstrap-publish.mjs", "oli-refresh-d1.mjs", "campaign-ads-golive.mjs", "manual-source-sync.mjs",
  "scheduled-campaign-ads-refresh.mjs", "report-materialization.mjs", "report-materialization-brandview.mjs",
  "returns-leakage-golive.mjs", "backfill-sku-movement.mjs", "backfill-brand-sales.mjs", "backfill-daily-named-brands.mjs",
  "backfill-daily-v2.mjs", "scheduled-oli-refresh.mjs", "scheduled-asin-ads-refresh.mjs", "fba-inventory-recovery.mjs",
]);
// Every scripts/release/backfill-*.mjs (present or future) is forbidden by pattern too.
export const FORBIDDEN_WORKER_SCRIPT_PATTERNS = Object.freeze([/^backfill-[A-Za-z0-9._-]*\.mjs$/]);
/** True when a script (path or basename) may never be spawned by the worker. */
export function isForbiddenWorkerScript(script) {
  const base = path.basename(S(script).replace(/\\/g, "/"));
  return FORBIDDEN_WORKER_SCRIPTS.includes(base) || FORBIDDEN_WORKER_SCRIPT_PATTERNS.some((re) => re.test(base));
}

const defaultReleaseModuleExists = (id) => existsSync(path.join(APP_ROOT, "lib", "server", "sync", "routes", id + ".release.js"));
// materializationOwner -> the classes it may coexist with (C10).
const OWNER_ALLOWED_KINDS = Object.freeze({
  "scheduler-v2:priority": ["route"], "scheduler-v2:fba": ["route"], "scheduler-v2:v3-shadow": ["route"], "scheduler-v2:materialize": ["route"],
  "serve:derive-durable": ["read-only-self-heal", "dormant"], "manual-refresh": ["manual-paid", "dormant"],
});

/**
 * Validate the whole route registry. THROWS (fail closed) on any violation; returns { classification, order, universe }.
 * Every input is injectable (tests inject bad routes / keys); defaults are the real registries (+ LIVE_CONTRACT_PINS).
 */
export function validateRouteRegistry({
  routes = PUBLICATION_ROUTES, classification = REPORT_RECOVERY_CLASSIFICATION_ENTRIES, liveContracts = LIVE_CONTRACT_PINS,
  reportDerivations = REPORT_DERIVATIONS, readyKeys = SCHEDULER_V2_READY_REPORT_KEYS, sourcePromotedKeys = SOURCE_PROMOTED_REPORT_KEYS,
  controlledKeys = CONTROLLED_REPORT_KEYS, materialization = REPORT_MATERIALIZATION, knownSnapshotKeys = KNOWN_SNAPSHOT_KEYS,
  operationalKeys = OPERATIONAL_REPORT_KEYS, contractOverrides = CONTRACT_CLASSIFICATION_OVERRIDES,
  servedSelectors = SERVED_SELECTOR_FOR_PUBLISHER_KEY, selectorModule = SERVE_SELECTORS, releaseModuleExists = defaultReleaseModuleExists,
  activeKeys = ACTIVE_PUBLICATION_REPORT_KEYS,
} = {}) {
  const fail = (m) => { throw new Error("publication-recovery registry: " + m + " (fail closed)."); };
  const map = buildClassificationMap(classification);
  const list = Array.isArray(routes) ? routes : [];
  // (1) routes: the worker contract, unique ids, allowed + never-forbidden scripts, priority order.
  const ids = new Set();
  let lastPriority = -Infinity;
  for (const r of list) {
    const p = workerRouteProblems(r);
    if (p.length) fail(`route '${S(r && r.id).slice(0, 40)}' is invalid: ${p.join(", ")}`);
    if (ids.has(r.id)) fail(`route '${r.id}' is declared twice`);
    ids.add(r.id);
    if (!ALLOWED_WORKER_SCRIPTS.includes(r.cli.script)) fail(`route '${r.id}' names a script outside the worker allow-list`);
    if (isForbiddenWorkerScript(r.cli.script)) fail(`route '${r.id}' maps to a forbidden script`);
    if (r.priority < lastPriority) fail(`route '${r.id}' breaks the priority order`);
    lastPriority = r.priority;
    if (r.kind === "route-cli" && !releaseModuleExists(r.id)) fail(`route-cli '${r.id}' has no lib/server/sync/routes/${r.id}.release.js`);
  }
  // (2) awaits: known ids, no cycle.
  for (const r of list) for (const a of r.awaits) if (!ids.has(a)) fail(`route '${r.id}' awaits unknown route '${a}'`);
  let order;
  try { order = routeTopoOrder(list); } catch (e) { fail(S(e && e.message)); }
  // (3) publisher contracts: live contract, derivation, readiness, served selector, live-key agreement.
  const publishedBy = new Map(); // report key -> Set(route ids) (publisher keys AND live report keys)
  const addPub = (k, id) => { if (!publishedBy.has(k)) publishedBy.set(k, new Set()); publishedBy.get(k).add(id); };
  const publishable = new Set([...readyKeys, ...sourcePromotedKeys]);
  for (const r of list) {
    const liveOfPks = new Set();
    for (const pk of r.publisherKeys) {
      const c = liveContracts[pk];
      if (!c) fail(`route '${r.id}' publisher key '${pk}' has no live snapshot contract`);
      if (!reportDerivations[pk]) fail(`route '${r.id}' publisher key '${pk}' has no REPORT_DERIVATIONS entry`);
      if (!publishable.has(pk)) fail(`route '${r.id}' publisher key '${pk}' is outside READY u SOURCE_PROMOTED`);
      const sel = servedSelectors[pk];
      if (!sel || typeof selectorModule[sel] !== "function") fail(`route '${r.id}' has no served selector for publisher contract '${pk}'`);
      liveOfPks.add(S(c.liveReportKey));
      addPub(pk, r.id);
    }
    if (JSON.stringify([...liveOfPks].sort()) !== JSON.stringify([...r.liveReportKeys].sort())) fail(`route '${r.id}' liveReportKeys disagree with its publisher contracts`);
    for (const lk of r.liveReportKeys) addPub(lk, r.id);
  }
  // (4) the key universe: every key classified exactly once -- incl. SCHEDULER_V2_READY_REPORT_KEYS (WP11 fixer: a key
  // the scheduler marks publish-ready must be classified even before it gains a live contract).
  const universe = new Set([
    ...Object.keys(materialization).map((k) => S(materialization[k] && materialization[k].reportKey) || k),
    ...Object.keys(liveContracts), ...readyKeys, ...sourcePromotedKeys, ...controlledKeys, ...knownSnapshotKeys, ...operationalKeys,
  ]);
  for (const k of universe) if (!classifyReportKey(k, map)) fail(`report '${k}' is unclassified`);
  // (5) route classes agree EXACTLY with the routes that publish the key; every route key is classified to its routes.
  for (const e of map.values()) {
    if (e.kind === "legacy-superseded") fail(`report '${e.reportKey}' may be legacy-superseded only as a CONTRACT override`);
    if (e.kind !== "route") continue;
    for (const id of e.routes) if (!ids.has(id)) fail(`report '${e.reportKey}' names unknown route '${id}'`);
    const actual = [...(publishedBy.get(e.reportKey) || [])].sort();
    if (JSON.stringify(actual) !== JSON.stringify([...e.routes].sort())) fail(`report '${e.reportKey}' class '${e.cls}' disagrees with the routes that publish it [${actual.join(",")}]`);
  }
  for (const k of publishedBy.keys()) { const e = map.get(k); if (!e || e.kind !== "route") fail(`route-published key '${k}' is not route-classified`); }
  for (const k of activeKeys) { const e = map.get(k); if (!e || e.kind !== "route") fail(`active publication report '${k}' does not map to a route`); }
  // (6) contract level: a route-classified live contract key is one of its routes' publisher keys, or a legacy-superseded
  // override whose route publishes the SAME live report key under another contract.
  for (const k of Object.keys(liveContracts)) {
    const e = classifyReportKey(k, map);
    const ov = contractOverrides[k];
    if (ov) {
      const oc = parseRecoveryClass(ov.cls);
      if (oc.kind !== "legacy-superseded" || S(ov.reason).trim() === "") fail(`contract override '${k}' must be legacy-superseded:<id> with a reason`);
      const sup = list.find((r) => r.id === oc.routes[0]);
      if (!sup) fail(`contract override '${k}' names unknown route '${oc.routes[0]}'`);
      if (sup.publisherKeys.includes(k)) fail(`contract '${k}' is both published by and superseded by route '${sup.id}'`);
      if (!sup.liveReportKeys.includes(S(liveContracts[k].liveReportKey))) fail(`contract override '${k}': route '${sup.id}' does not own its live report key`);
      continue;
    }
    if (e.kind === "route" && !e.routes.some((id) => list.find((r) => r.id === id).publisherKeys.includes(k))) fail(`live contract '${k}' is route-classified but no route publishes it (needs a legacy-superseded override)`);
  }
  for (const k of Object.keys(contractOverrides)) if (!liveContracts[k]) fail(`contract override '${k}' has no live contract`);
  // (7) C10: the materialization owner must agree with the classification.
  for (const [mk, decl] of Object.entries(materialization)) {
    const key = S(decl && decl.reportKey) || mk;
    const owner = S(decl && decl.materializationOwner);
    const allowed = OWNER_ALLOWED_KINDS[owner];
    if (!allowed) fail(`report '${key}' has an unknown materializationOwner '${owner}'`);
    const e = classifyReportKey(key, map);
    if (!allowed.includes(e.kind)) fail(`report '${key}' materializationOwner '${owner}' contradicts its class '${e.cls}' (C10)`);
  }
  return { classification: map, order, universe: [...universe].sort() };
}

/** The classification table (report keys + contract overrides) for status / hand-off output. */
export function classificationTable(map = REPORT_RECOVERY_CLASSIFICATION) {
  const rows = [...map.values()].map((e) => ({ reportKey: e.reportKey, class: e.cls, reason: e.reason }));
  for (const [k, ov] of Object.entries(CONTRACT_CLASSIFICATION_OVERRIDES)) rows.push({ reportKey: k + " (publisher contract)", class: ov.cls, reason: ov.reason });
  return rows;
}

// The ffb035b four-family COMPAT view (RECOVERY_FAMILIES / FAMILY_IDS / detectOnlyReports / the registry's
// adsEvidenceWorkerKeys alias / routesForLiveReport) is REMOVED (WP12): the worker drives routes.js directly. The Ads
// route's evidence keys live in routes/ads.route.js (adsEvidenceWorkerKeys).
/**
 * The worker's startup check (kept for the entrypoint + publisher-route-hooks A7): the FULL route registry validation
 * (throws fail-closed), returning { reportKey: { kind, cls, routes } } for every key of the validated universe (the
 * class only, so two keys of one class compare equal).
 */
export function validateRecoveryRegistry(opts = {}) {
  const v = validateRouteRegistry(opts);
  const out = {};
  for (const k of v.universe) { const e = classifyReportKey(k, v.classification); out[k] = { kind: e.kind, cls: e.cls, routes: [...e.routes] }; }
  return out;
}
