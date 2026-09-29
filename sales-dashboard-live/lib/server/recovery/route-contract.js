// Publication recovery WP4 -- the ROUTE MODULE CONTRACT. A publication-recovery route is declared by TWO modules:
//   WORKER side  lib/server/recovery/routes/<id>.route.js  -- the declarative scheduling contract the recovery worker
//                (WP11/WP12) drives: which CLI + args, which publisher/live keys, grain + unit, awaits, source/report
//                deps, metadata-only evidence SQL + compose, the tier-1 live-row scope, timeouts and heap;
//   CLI side     lib/server/sync/routes/<id>.release.js    -- the zero-export release the generic route CLI
//                (scripts/release/publication-route-reconcile.mjs) runs through route-publication-release.js: build(deps)
//                returns the runtime hooks (evidence read + revision, bundle resolve, derive, identity, served selector).
// Both are validated FAIL-CLOSED here before anything runs: an unknown key (a typo such as `servedSelecter`), a missing
// hook, a non-read-only evidence SQL, a runner-owned argv flag in fixedArgs, an out-of-range timeout, a self/duplicate
// await, or a worker/CLI pair that disagrees on the id / publisher key / script is REFUSED (the CLI STOPs; the worker
// registry THROWS). Pure; no I/O; no import. 7-bit ASCII, LF.

const S = (v) => (v == null ? "" : String(v));
const isFn = (f) => typeof f === "function";
const isPlainObject = (o) => !!o && typeof o === "object" && !Array.isArray(o) && (Object.getPrototypeOf(o) === Object.prototype || Object.getPrototypeOf(o) === null);
const isInt = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
const uniqueStrings = (xs, re) => Array.isArray(xs) && xs.every((x) => typeof x === "string" && (!re || re.test(x))) && new Set(xs).size === xs.length;

// The route id grammar (== the 20260934 publication_recovery_routes.route_id CHECK) and the job target-key grammar.
export const ROUTE_ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
export const TARGET_KEY_RE = /^[A-Za-z0-9._:-]{1,160}$/;
export const ROUTE_KINDS = Object.freeze(["legacy-cli", "route-cli"]);
export const ROUTE_GRAINS = Object.freeze(["account", "region"]);
export const ROUTE_UNITS = Object.freeze(["none", "brand", "region-brand"]);
export const ROUTE_STAMP_POLICIES = Object.freeze(["cycle", "evidence"]);
// The ONE generic route CLI, and the four pre-existing zero-export reconciler CLIs a legacy-cli wrapper may name.
export const ROUTE_CLI_SCRIPT = "scripts/release/publication-route-reconcile.mjs";
export const LEGACY_CLI_SCRIPTS = Object.freeze([
  "scripts/release/oli-publication-reconcile.mjs",
  "scripts/release/ads-publication-reconcile.mjs",
  "scripts/release/fba-publication-reconcile.mjs",
  "scripts/release/listing-health-v3-reconcile.mjs",
]);
// argv the RUNNER owns (per-job, never a static per-route default): live mode, fencing, scope, cleanup, verification.
const RUNNER_OWNED_FLAGS = Object.freeze(["--live", "--run-token", "--targets", "--accounts", "--cleanup", "--verify-exact", "--bucket", "--as-of", "--route", "--mode", "--deadline-seconds", "--emit-targets", "--lease-wait-seconds", "--prune-shadows", "--owner-generation"]);
const FIXED_ARG_RE = /^--[a-z][a-z0-9-]*(=[A-Za-z0-9._:,-]{0,120})?$/;
const SQL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SCAN_GROUP_RE = /^[a-z][a-z0-9-]{0,39}$/;
// Evidence SQL is METADATA-ONLY + READ-ONLY: a single SELECT / WITH statement, no ';', none of these keywords/functions.
const SQL_FORBIDDEN_RE = /\b(insert|update|delete|merge|upsert|truncate|alter|drop|create|grant|revoke|copy|vacuum|call|lock|refresh|reindex|cluster|execute|prepare|listen|notify|begin|commit|rollback|savepoint|pg_sleep|set_config|dblink|lo_import|lo_export|pg_read_file|pg_read_binary_file|pg_write_file)\b/i;

const WORKER_KEYS = Object.freeze(["id", "kind", "cli", "publisherKeys", "liveReportKeys", "grain", "unit", "awaits", "deps", "evidence", "identityAsOf", "tier1", "deadlineSeconds", "hardTimeoutSeconds", "childHeapMb", "minChildHeapMb", "priority", "scanGroup"]);
const CLI_KEYS = Object.freeze(["id", "publisherKey", "stampPolicy", "build"]);
// The RUNTIME a CLI-side module's build(deps) returns (deps: { bucket, epoch, directory, orgFp, connectionId, sb (READ-ONLY
// supabase facade), pgReadOnly, selectors, computeHash, liveContracts, reportDerivations, marketplaceToday,
// normalizeMarketplace, now, strict, log, ... }). The generic release (route-publication-release.js) relies on these shapes:
//   readScopeEvidence({ scope, epoch, bucket, directory, organizationFingerprint, connectionId, signal? })
//       -> { ok:true, perAccount: Map<targetId, evidence> } | { ok:false, failCode }          (durable, metadata-level)
//   computeRevision({ accountId, evidence, epoch, bucket, directory })
//       -> { eligible:true, revisionId, evidenceToken, deps:[...], contentDeps? } | { eligible:false, reason }   (PURE)
//   resolveBundle(unit, { strict:true, epoch, bucket, revision, signal })
//       -> { eligible:true, revisionId, evidenceToken, manifestToken, deps, evidenceInstant?, depFingerprint?,
//            serveToken?, guard?, bundle } | { eligible:false, reason }      (the SAME revision/token the scan computed;
//            guard = optional plain-JSON publishGuard data)
//   derive(bundle, { unit, epoch, bucket, strict, signal }) -> { payload, latestDataDate? } | { notReady:true, reason }
//   identityParams(unit, { bundle, epoch }) -> the shadow identity params (plain scalars / string arrays; never a key
//       the release owns: reportVersion / accountId / route / rev / evidenceToken / manifestToken / depFingerprint /
//       serveToken)
//   servedSelector(unit, { epoch, bucket, signal }) -> { row, reason, via } (lib/server/recovery/serve-selectors.js)
//   optional: expandUnits (the reconciler units; unit.targetAsOf = the identity as-of), identityAsOf(unit, { bundle,
//       epoch, now }), currentPredicate, servedVerdict(served, expected), postPublish (non-fatal), scopeTargets({ directory,
//       bucket, epoch }), readEvidenceToken(unit, ctx).
//   currentPredicate verdicts may carry the content-equivalence PROOF marker { state: PUBLICATION_NOT_REQUIRED,
//       proof: 'content-equivalent' (route-publication-release.js ROUTE_PROOF_CONTENT_EQUIVALENT), h, sra } ONLY when the
//       predicate proved the SERVED row (h / sra) content-equivalent to a fresh derive of the current bundle; verify-exact
//       then honours it instead of requiring route lineage (see buildRouteReconcileAdapter).
//   stampPolicy 'evidence': the bundle's evidenceInstant MUST advance with EVERY content input the payload depends on,
//       else a content change whose evidence stamp did not advance defers 'evidence-instant-not-advanced' (the live row
//       at exactly that instant with different content tokens; alert-worthy DEFERRED_DEPENDENCY) -- a strictly newer
//       live / served row defers NEWER_LIVE 'evidence-not-newer-than-live|served'.
//   publishGuard(unit, prepared, { epoch, bucket, signal }) (optional) -> null (proceed) | { state: 'NEWER_LIVE' |
//       'DEFERRED_DEPENDENCY' | 'DEFERRED_PROVENANCE', reason }: publishGuard runs inside the control lease immediately
//       before the fenced publish; the paid publisher needs the same lease, so a check here cannot race. prepared.guard
//       carries resolveBundle's optional `guard` (plain JSON, stableJson-equal at the prepare's two reads). A verdict
//       returns its typed result with ZERO CAS; a throw defers 'publish-guard-threw:<msg>' (fail closed).
export const ROUTE_RUNTIME_REQUIRED_HOOKS = Object.freeze(["readScopeEvidence", "computeRevision", "resolveBundle", "derive", "identityParams", "servedSelector"]);
export const ROUTE_RUNTIME_OPTIONAL_HOOKS = Object.freeze(["expandUnits", "identityAsOf", "currentPredicate", "servedVerdict", "postPublish", "scopeTargets", "readEvidenceToken", "publishGuard"]);

/** True when `text` is a single read-only SELECT/WITH statement (no ';', no write/lock/admin keyword). */
export function isReadOnlyEvidenceSql(text) {
  const t = S(text).trim();
  if (!t || t.includes(";")) return false;
  if (!/^(select|with)\b/i.test(t)) return false;
  return !SQL_FORBIDDEN_RE.test(t);
}

// The ONLY tables whose shared evidence may be reused ACROSS tier-1 passes: each needs a change probe in the worker's
// store (store-pg.js readAdsChangeProbe). A statement opts in with `reuseTable`; it must be `shared: true` and read that
// table ALONE (every `public.<table>` it names), so the probe covers everything its rows depend on.
export const SHARED_REUSE_TABLES = Object.freeze(["ads_daily_source_rows"]);
// The statement TEXTS allowed to opt in, pinned by a content hash (cyrb53, inline: this module has no import): a changed
// or new reusable statement needs a reviewed pin update here (review round 2: a name-based check alone admitted an
// unqualified / quoted / other-schema table or an unlisted time function).
export const SHARED_REUSE_PINS = Object.freeze({ ads_daily_source_rows: Object.freeze(["3837adcedc2ee"]) });
export function reuseTextPin(text) {
  const str = S(text); let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}
export function reuseTableValid(q) {
  if (!isPlainObject(q) || q.shared !== true || !SHARED_REUSE_TABLES.includes(q.reuseTable)) return false;
  if (!(SHARED_REUSE_PINS[q.reuseTable] || []).includes(reuseTextPin(q.text))) return false;
  // Defence in depth (the pin is the gate): every public.<name> is the table, and no time function.
  const tables = new Set((S(q.text).toLowerCase().match(/public.[a-z_][a-z0-9_]*/g) || []).map((x) => x.slice(7)));
  return tables.size === 1 && tables.has(q.reuseTable)
    && !/(now|clock_timestamp|statement_timestamp|transaction_timestamp|current_date|current_time|current_timestamp|localtime|localtimestamp|timeofday|random|txid_current|current_setting)/i.test(S(q.text));
}

/** Every problem with a WORKER-side route declaration ([] when valid). */
export function workerRouteProblems(route) {
  const p = [];
  if (!isPlainObject(route)) return ["route-not-object"];
  for (const k of Object.keys(route)) if (!WORKER_KEYS.includes(k)) p.push("unknown-key:" + k);
  if (!ROUTE_ID_RE.test(S(route.id))) p.push("id-invalid");
  if (!ROUTE_KINDS.includes(route.kind)) p.push("kind-invalid");
  const cli = route.cli;
  if (!isPlainObject(cli) || typeof cli.script !== "string") p.push("cli-invalid");
  else {
    if (route.kind === "route-cli" && cli.script !== ROUTE_CLI_SCRIPT) p.push("cli-script-not-route-cli");
    if (route.kind === "legacy-cli" && !LEGACY_CLI_SCRIPTS.includes(cli.script)) p.push("cli-script-not-legacy");
    if (!Array.isArray(cli.fixedArgs) || !cli.fixedArgs.every((a) => typeof a === "string" && FIXED_ARG_RE.test(a))) p.push("cli-fixed-args-invalid");
    else if (cli.fixedArgs.some((a) => RUNNER_OWNED_FLAGS.includes(a.split("=")[0]))) p.push("cli-fixed-args-runner-owned");
  }
  if (!uniqueStrings(route.publisherKeys) || route.publisherKeys.length === 0) p.push("publisher-keys-invalid");
  if (!uniqueStrings(route.liveReportKeys) || route.liveReportKeys.length === 0) p.push("live-report-keys-invalid");
  if (!ROUTE_GRAINS.includes(route.grain)) p.push("grain-invalid");
  if (!ROUTE_UNITS.includes(route.unit)) p.push("unit-invalid");
  else if (route.unit === "region-brand" && route.grain !== "region") p.push("unit-region-brand-needs-region-grain");
  if (!uniqueStrings(route.awaits, ROUTE_ID_RE)) p.push("awaits-invalid");
  else if (route.awaits.includes(route.id)) p.push("awaits-self");
  const deps = route.deps;
  if (!isPlainObject(deps) || !uniqueStrings(deps.sources) || deps.sources.length === 0 || !uniqueStrings(deps.reports)) p.push("deps-invalid");
  const ev = route.evidence;
  if (!isPlainObject(ev)) p.push("evidence-invalid");
  else {
    if (!Array.isArray(ev.sql) || ev.sql.length === 0) p.push("evidence-sql-empty");
    else {
      const names = new Set();
      for (const q of ev.sql) {
        if (!isPlainObject(q) || !SQL_NAME_RE.test(S(q.name)) || names.has(q.name)) { p.push("evidence-sql-name-invalid"); continue; }
        names.add(q.name);
        if (!isReadOnlyEvidenceSql(q.text)) p.push("evidence-sql-not-read-only:" + q.name);
        if (!isFn(q.params)) p.push("evidence-sql-params-not-fn:" + q.name);
        // `shared` (the worker's sweep cache) must be a real boolean: a truthy string must never enable cross-evaluation reuse.
        if (q.shared !== undefined && typeof q.shared !== "boolean") p.push("evidence-sql-shared-invalid:" + q.name);
        // `sharedVariant` (run INSTEAD in sweep mode): a read-only `shared: true` statement with its own params; a statement
        // is either shared itself or carries a shared variant, never both.
        if (q.sharedVariant !== undefined) {
          const v = q.sharedVariant;
          if (!isPlainObject(v) || v.shared !== true || !isReadOnlyEvidenceSql(v.text) || !isFn(v.params) || v.sharedVariant !== undefined || q.shared === true) p.push("evidence-sql-shared-variant-invalid:" + q.name);
          if (v && v.reuseTable !== undefined && !reuseTableValid(v)) p.push("evidence-sql-reuse-table-invalid:" + q.name);
        }
        if (q.reuseTable !== undefined && !reuseTableValid(q)) p.push("evidence-sql-reuse-table-invalid:" + q.name);
      }
    }
    if (!isFn(ev.compose)) p.push("evidence-compose-not-fn");
    if (!isInt(ev.everySeconds, 10, 86400)) p.push("evidence-every-seconds-invalid");
  }
  if (!(route.identityAsOf === null || route.identityAsOf === undefined || isFn(route.identityAsOf))) p.push("identity-as-of-invalid");
  if (!isPlainObject(route.tier1) || !isFn(route.tier1.liveRowScope)) p.push("tier1-invalid");
  if (!isInt(route.deadlineSeconds, 30, 3600)) p.push("deadline-seconds-invalid");
  if (!isInt(route.hardTimeoutSeconds, 60, 7200) || !(route.hardTimeoutSeconds > route.deadlineSeconds)) p.push("hard-timeout-seconds-invalid");
  if (!isInt(route.childHeapMb, 128, 4096)) p.push("child-heap-mb-invalid");
  if (!isInt(route.minChildHeapMb, 128, 4096) || (Number.isInteger(route.childHeapMb) && route.minChildHeapMb > route.childHeapMb)) p.push("min-child-heap-mb-invalid");
  if (!isInt(route.priority, 0, 100)) p.push("priority-invalid");
  if (!SCAN_GROUP_RE.test(S(route.scanGroup))) p.push("scan-group-invalid");
  return p;
}

/**
 * Every problem with a CLI-side route module ([] when valid). With `liveContracts` + `reportDerivations` supplied, the
 * publisher key must also have a live snapshot contract and a report derivation entry.
 */
export function cliRouteProblems(route, { liveContracts = null, reportDerivations = null } = {}) {
  const p = [];
  if (!isPlainObject(route)) return ["route-not-object"];
  for (const k of Object.keys(route)) if (!CLI_KEYS.includes(k)) p.push("unknown-key:" + k);
  if (!ROUTE_ID_RE.test(S(route.id))) p.push("id-invalid");
  if (typeof route.publisherKey !== "string" || route.publisherKey.trim() === "" || route.publisherKey !== route.publisherKey.trim()) p.push("publisher-key-invalid");
  if (!ROUTE_STAMP_POLICIES.includes(route.stampPolicy)) p.push("stamp-policy-invalid");
  if (!isFn(route.build)) p.push("build-not-fn");
  if (liveContracts && typeof route.publisherKey === "string" && !liveContracts[route.publisherKey]) p.push("publisher-key-no-live-contract");
  if (reportDerivations && typeof route.publisherKey === "string" && !(reportDerivations[route.publisherKey] && typeof reportDerivations[route.publisherKey].validatePayload === "function")) p.push("publisher-key-no-derivation");
  return p;
}

/** Every problem with the runtime a CLI-side module's build(deps) returned ([] when valid). Unknown hooks are refused. */
export function routeRuntimeProblems(runtime) {
  const p = [];
  if (!isPlainObject(runtime)) return ["runtime-not-object"];
  for (const k of Object.keys(runtime)) if (!ROUTE_RUNTIME_REQUIRED_HOOKS.includes(k) && !ROUTE_RUNTIME_OPTIONAL_HOOKS.includes(k)) p.push("unknown-hook:" + k);
  for (const h of ROUTE_RUNTIME_REQUIRED_HOOKS) if (!isFn(runtime[h])) p.push("missing-hook:" + h);
  for (const h of ROUTE_RUNTIME_OPTIONAL_HOOKS) if (runtime[h] != null && !isFn(runtime[h])) p.push("hook-not-fn:" + h);
  return p;
}

/** Problems with a (worker, CLI) module PAIR for one route id: they must agree on id, kind, script and publisher key. */
export function routePairProblems(workerRoute, cliRoute, { liveContracts = null } = {}) {
  const p = [];
  if (!isPlainObject(workerRoute) || !isPlainObject(cliRoute)) return ["pair-not-objects"];
  if (S(workerRoute.id) !== S(cliRoute.id)) p.push("pair-id-mismatch");
  if (workerRoute.kind !== "route-cli") p.push("pair-worker-not-route-cli");
  if (!workerRoute.cli || workerRoute.cli.script !== ROUTE_CLI_SCRIPT) p.push("pair-script-mismatch");
  if (!Array.isArray(workerRoute.publisherKeys) || workerRoute.publisherKeys.length !== 1 || workerRoute.publisherKeys[0] !== cliRoute.publisherKey) p.push("pair-publisher-key-mismatch");
  const contract = liveContracts && typeof cliRoute.publisherKey === "string" ? liveContracts[cliRoute.publisherKey] : null;
  if (liveContracts && (!contract || !Array.isArray(workerRoute.liveReportKeys) || workerRoute.liveReportKeys.length !== 1 || workerRoute.liveReportKeys[0] !== contract.liveReportKey)) p.push("pair-live-report-key-mismatch");
  return p;
}

function assertNone(problems, label) {
  if (problems.length) throw new Error(`${label} is invalid (fail closed): ${problems.join(", ")}`);
}

/**
 * validateRouteModule(mod, { side: 'worker' | 'cli', liveContracts?, reportDerivations? }) -> the validated declaration
 * (mod.default when present, else mod itself). THROWS on any problem (fail closed).
 */
export function validateRouteModule(mod, { side, liveContracts = null, reportDerivations = null } = {}) {
  const route = mod && typeof mod === "object" && "default" in mod ? mod.default : mod;
  if (side === "worker") assertNone(workerRouteProblems(route), "worker route module");
  else if (side === "cli") assertNone(cliRouteProblems(route, { liveContracts, reportDerivations }), "cli route module");
  else throw new Error("validateRouteModule side must be 'worker' | 'cli' (fail closed).");
  return route;
}

/** THROWS unless the runtime returned by a CLI module's build(deps) is complete + well-formed. Returns it. */
export function validateRouteRuntime(runtime, routeId = "") {
  assertNone(routeRuntimeProblems(runtime), `route runtime${routeId ? " '" + routeId + "'" : ""}`);
  return runtime;
}

/** THROWS unless the worker + CLI declarations of ONE route agree. */
export function validateRoutePair(workerRoute, cliRoute, { liveContracts = null } = {}) {
  assertNone(routePairProblems(workerRoute, cliRoute, { liveContracts }), `route pair '${S(cliRoute && cliRoute.id)}'`);
  return true;
}

/**
 * Kahn topological order of route ids by `awaits` (an await naming a route OUTSIDE `ids` only orders nothing). Ties
 * keep the given order. THROWS on a cycle (fail closed).
 */
export function routeTopoOrder(routes) {
  const list = Array.isArray(routes) ? routes : [];
  const ids = list.map((r) => S(r && r.id));
  const inSet = new Set(ids);
  const indeg = new Map(ids.map((id) => [id, 0]));
  const edges = new Map(ids.map((id) => [id, []]));
  for (const r of list) {
    for (const a of (Array.isArray(r && r.awaits) ? r.awaits : [])) {
      if (!inSet.has(a) || a === r.id) continue;
      edges.get(a).push(r.id);
      indeg.set(r.id, indeg.get(r.id) + 1);
    }
  }
  const out = [];
  const ready = ids.filter((id) => indeg.get(id) === 0);
  while (ready.length) {
    const id = ready.shift();
    out.push(id);
    for (const n of edges.get(id)) { indeg.set(n, indeg.get(n) - 1); if (indeg.get(n) === 0) ready.push(n); }
  }
  if (out.length !== ids.length) throw new Error("routeTopoOrder: the awaits graph has a cycle (fail closed): " + ids.filter((id) => !out.includes(id)).join(","));
  return out;
}

// ---- WP11: the ONE worker evidence CONTEXT + the tier-1 target / live-row scope / compose result shapes -------------
// Every WORKER-side route module (the 10 route modules AND the 4 legacy-cli wrappers) is driven with EXACTLY these
// shapes; routes.js builds them (makeEvidenceContext / makeTier1Target) and validates every compose / liveRowScope
// result against them, and the recovery-registry / units suites run every route through them. PINNED:
//   EVIDENCE CONTEXT  ctx = { epoch, now, accountIds, directory, region, organizationFingerprint, connectionId }
//     epoch                   'YYYY-MM-DD' -- the job as-of (UTC D-1; for fba-plan = fbaInventoryAsOf(now))
//     now                     a FINITE epoch-ms NUMBER -- the ONE evidence clock of this read (the sku-movement
//                             effectiveAsOf ceiling, the Brand View / portfolio identity as-of + Ads build window)
//     accountIds              frozen, sorted, de-duplicated canonical PRIMARY account ids (nonblank, trimmed, no ':'):
//                             EVERY durable-directory account of `region` (never a sub-scope -- fba-plan's salesAsOf is
//                             a whole-region function), each a key of `directory`
//     directory               the buildDurableDirectory Map (accountId -> { accountId, country, marketplace,
//                             rawSellerId, name, currency }) -- the SAME Map shape the route CLI builds
//     region                  'india' | 'europe-au' | 'us-ca' (the scan bucket)
//     organizationFingerprint the PRIMARY connection's organization fingerprint (nonblank)
//     connectionId            exactly 'primary'
//   The worker passes the SAME ctx OBJECT to every evidence.sql[i].params(ctx) AND to evidence.compose(rowsByName, ctx)
//   (never two clocks: a params/compose `now` split is exactly the typed 'evidence-inconsistent' /
//   'ads-rows-window-mismatch' failure the routes fail closed on).
//   COMPOSE RESULT    Map<targetKey, { token: string | null, owners: [ownerId], region: region | null, targetAsOf?,
//                     alerts: [code], reason? }> -- token null REQUIRES a typed reason code; a region-grain target key
//                     is 'region:<region>'. Owners of a REGION target are informational only (they never gate it: the
//                     per-unit publisher AND gate covers every member).
//   TIER-1 TARGET     tier1.liveRowScope(target) and identityAsOf(target, { now, directory }) receive
//                     target = { targetKey, accountId?, region } (accountId = targetKey for an account-grain route).
//   LIVE-ROW SCOPE    tier1.liveRowScope(target) -> { reportKey, accountIdEq | accountIdLike, paramsEq? } or a NON-EMPTY
//                     array of them (a legacy family publishes several live reports); paramsEq = { param: text } scopes
//                     a LIKE read by stored params (the portfolio's params->>'region').
export const ROUTE_REGIONS = Object.freeze(["india", "europe-au", "us-ca"]);
export const EVIDENCE_CONNECTION_ID = "primary";
export const EVIDENCE_CTX_KEYS = Object.freeze(["epoch", "now", "accountIds", "directory", "region", "organizationFingerprint", "connectionId"]);
export const COMPOSE_RESULT_KEYS = Object.freeze(["token", "owners", "region", "targetAsOf", "alerts", "reason"]);
export const TIER1_TARGET_KEYS = Object.freeze(["targetKey", "accountId", "region"]);
export const REGION_TARGET_PREFIX = "region:";
// A canonical PRIMARY account id (the rollout-owner grammar: no ':' -- a prefixed dd-secondary id is never an evidence account).
export const EVIDENCE_ACCOUNT_ID_RE = /^[A-Za-z0-9._-]{1,120}$/;
const CTX_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isCalendarDate = (v) => typeof v === "string" && CTX_DATE_RE.test(v) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;
const CODE_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const PRINTABLE_TOKEN_RE = /^[\x21-\x7e]{1,512}$/;
const PARAM_NAME_RE = /^[a-z][A-Za-z0-9_]{0,63}$/;

/** Every problem with a worker evidence context ([] when it is exactly the pinned shape). */
export function evidenceContextProblems(ctx) {
  const p = [];
  if (!isPlainObject(ctx)) return ["ctx-not-object"];
  for (const k of Object.keys(ctx)) if (!EVIDENCE_CTX_KEYS.includes(k)) p.push("ctx-unknown-key:" + k);
  for (const k of EVIDENCE_CTX_KEYS) if (!(k in ctx)) p.push("ctx-missing-key:" + k);
  if (!isCalendarDate(ctx.epoch)) p.push("ctx-epoch-invalid");
  if (typeof ctx.now !== "number" || !Number.isFinite(ctx.now)) p.push("ctx-now-not-epoch-ms");
  if (!(ctx.directory instanceof Map)) p.push("ctx-directory-not-map");
  if (!ROUTE_REGIONS.includes(ctx.region)) p.push("ctx-region-invalid");
  if (typeof ctx.organizationFingerprint !== "string" || ctx.organizationFingerprint.trim() === "" || ctx.organizationFingerprint !== ctx.organizationFingerprint.trim()) p.push("ctx-org-invalid");
  if (ctx.connectionId !== EVIDENCE_CONNECTION_ID) p.push("ctx-connection-not-primary");
  const ids = ctx.accountIds;
  if (!Array.isArray(ids) || !ids.every((a) => typeof a === "string" && EVIDENCE_ACCOUNT_ID_RE.test(a))) p.push("ctx-account-ids-invalid");
  else {
    if (new Set(ids).size !== ids.length || ids.some((a, i) => i > 0 && ids[i - 1] > a)) p.push("ctx-account-ids-not-sorted-unique");
    if (ctx.directory instanceof Map && !ids.every((a) => ctx.directory.has(a))) p.push("ctx-account-not-in-directory");
  }
  return p;
}

/**
 * The ONE evidence context (frozen; accountIds frozen). THROWS on any problem (fail closed). The caller (routes.js
 * buildEvidenceContext) computes accountIds = every directory account of the region.
 */
export function makeEvidenceContext({ epoch, now, accountIds, directory, region, organizationFingerprint } = {}) {
  const ctx = { epoch, now, accountIds: Array.isArray(accountIds) ? Object.freeze([...accountIds]) : accountIds, directory, region, organizationFingerprint, connectionId: EVIDENCE_CONNECTION_ID };
  assertNone(evidenceContextProblems(ctx), "route evidence context");
  return Object.freeze(ctx);
}

/** Every problem with a tier-1 target ([] when valid). grain 'account': accountId === targetKey; 'region': 'region:<region>'. */
export function tier1TargetProblems(target, grain = null) {
  const p = [];
  if (!isPlainObject(target)) return ["target-not-object"];
  for (const k of Object.keys(target)) if (!TIER1_TARGET_KEYS.includes(k)) p.push("target-unknown-key:" + k);
  if (!TARGET_KEY_RE.test(S(target.targetKey))) p.push("target-key-invalid");
  if (!ROUTE_REGIONS.includes(target.region)) p.push("target-region-invalid");
  if (target.accountId != null && (!EVIDENCE_ACCOUNT_ID_RE.test(S(target.accountId)) || target.accountId !== target.targetKey)) p.push("target-account-invalid");
  if (grain === "account" && target.accountId !== target.targetKey) p.push("target-account-missing");
  if (grain === "region" && (target.targetKey !== REGION_TARGET_PREFIX + target.region || target.accountId != null)) p.push("target-region-key-invalid");
  return p;
}

/** The frozen tier-1 target for a route grain. THROWS on any problem. */
export function makeTier1Target({ targetKey, region, grain } = {}) {
  const t = grain === "account" ? { targetKey, accountId: targetKey, region } : { targetKey, region };
  assertNone(tier1TargetProblems(t, grain), "tier-1 target");
  return Object.freeze(t);
}

// Every problem with ONE live-row scope object ([] when valid).
function oneScopeProblems(s) {
  const p = [];
  if (!isPlainObject(s)) return ["scope-not-object"];
  for (const k of Object.keys(s)) if (!["reportKey", "accountIdEq", "accountIdLike", "paramsEq"].includes(k)) p.push("scope-unknown-key:" + k);
  if (typeof s.reportKey !== "string" || !/^[a-z][a-z0-9-]{1,63}$/.test(s.reportKey)) p.push("scope-report-key-invalid");
  const eq = s.accountIdEq != null; const like = s.accountIdLike != null;
  if (eq === like) p.push("scope-needs-exactly-one-account-matcher");
  if (eq && (typeof s.accountIdEq !== "string" || !TARGET_KEY_RE.test(s.accountIdEq))) p.push("scope-account-eq-invalid");
  if (like && (typeof s.accountIdLike !== "string" || s.accountIdLike.length < 2 || s.accountIdLike.length > 400 || !s.accountIdLike.endsWith("%"))) p.push("scope-account-like-invalid");
  if (s.paramsEq != null) {
    if (!isPlainObject(s.paramsEq) || Object.keys(s.paramsEq).length === 0) p.push("scope-params-eq-invalid");
    else for (const [k, v] of Object.entries(s.paramsEq)) if (!PARAM_NAME_RE.test(k) || typeof v !== "string" || v.trim() === "" || v.length > 200) p.push("scope-params-eq-invalid:" + k);
  }
  return p;
}

/** Every problem with a liveRowScope result (one scope or a non-empty array of scopes). */
export function liveRowScopeProblems(scope) {
  if (Array.isArray(scope)) return scope.length === 0 ? ["scope-array-empty"] : scope.flatMap((s, i) => oneScopeProblems(s).map((x) => i + ":" + x));
  return oneScopeProblems(scope);
}

/** The liveRowScope result as a validated, frozen ARRAY of scopes. THROWS on any problem. */
export function normalizeLiveRowScopes(scope) {
  assertNone(liveRowScopeProblems(scope), "tier-1 live-row scope");
  return Object.freeze((Array.isArray(scope) ? scope : [scope]).map((s) => Object.freeze({ ...s })));
}

/**
 * Every problem with an evidence.compose result ([] when valid). With `ctx`, each entry's region must be null or
 * ctx.region (a region scan never yields another region's target); `grain` 'region' requires 'region:<r>' keys,
 * 'account' canonical account-id keys.
 */
export function composeResultProblems(result, { ctx = null, grain = null } = {}) {
  const p = [];
  if (!(result instanceof Map)) return ["compose-not-map"];
  for (const [key, v] of result) {
    const k = S(key).slice(0, 40);
    if (typeof key !== "string" || !TARGET_KEY_RE.test(key)) { p.push("compose-key-invalid"); continue; }
    if (grain === "region" && !(key.startsWith(REGION_TARGET_PREFIX) && ROUTE_REGIONS.includes(key.slice(REGION_TARGET_PREFIX.length)))) p.push("compose-region-key-invalid:" + k);
    if (grain === "account" && !EVIDENCE_ACCOUNT_ID_RE.test(key)) p.push("compose-account-key-invalid:" + k);
    if (!isPlainObject(v)) { p.push("compose-value-not-object:" + k); continue; }
    for (const f of Object.keys(v)) if (!COMPOSE_RESULT_KEYS.includes(f)) p.push("compose-unknown-field:" + f + ":" + k);
    if (!(v.token === null || (typeof v.token === "string" && PRINTABLE_TOKEN_RE.test(v.token)))) p.push("compose-token-invalid:" + k);
    if (!Array.isArray(v.owners) || v.owners.length === 0 || !v.owners.every((o) => typeof o === "string" && EVIDENCE_ACCOUNT_ID_RE.test(o)) || new Set(v.owners).size !== v.owners.length) p.push("compose-owners-invalid:" + k);
    if (!(v.region === null || ROUTE_REGIONS.includes(v.region))) p.push("compose-region-invalid:" + k);
    else if (ctx && v.region !== null && v.region !== ctx.region) p.push("compose-region-foreign:" + k);
    if (!Array.isArray(v.alerts) || !v.alerts.every((a) => typeof a === "string" && CODE_RE.test(a))) p.push("compose-alerts-invalid:" + k);
    if (v.targetAsOf != null && !isCalendarDate(v.targetAsOf)) p.push("compose-target-asof-invalid:" + k);
    if (v.token === null && !(typeof v.reason === "string" && CODE_RE.test(v.reason))) p.push("compose-null-token-needs-reason:" + k);
    if (v.token !== null && v.reason != null) p.push("compose-token-with-reason:" + k);
  }
  return p;
}

/** THROWS unless an evidence.compose result is well-formed for the ctx / grain. Returns it. */
export function validateComposeResult(result, { ctx = null, grain = null, routeId = "" } = {}) {
  assertNone(composeResultProblems(result, { ctx, grain }), `route '${routeId}' evidence.compose result`);
  return result;
}
