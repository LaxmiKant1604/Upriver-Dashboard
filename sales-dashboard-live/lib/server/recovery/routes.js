// Publication recovery WP11 -- the ONE ordered list of worker-side PUBLICATION ROUTES (route-contract.js shape) the
// recovery worker drives: the four pre-existing zero-export reconciler CLIs as 'legacy-cli' wrappers (oli, ads, fba,
// listings -- exact argv, unchanged) and the six zero-export 'route-cli' routes of scripts/release/publication-route-
// reconcile.mjs (fba-plan, returns-v3, brand-view-brands, sku-movement, brand-view, brand-view-portfolio).
//
// ORDER = priority (non-decreasing; ties keep this declared order): oli, listings, fba-plan, returns-v3, ads, fba,
// brand-view-brands, sku-movement, brand-view, brand-view-portfolio. topoOrder() is the Kahn order over `awaits`
// (route-contract.js routeTopoOrder; a cycle THROWS).
//
// THE ONE EVIDENCE CONTEXT (route-contract.js makeEvidenceContext): buildEvidenceContext() computes the region's
// durable-directory account set with the SAME rule the route CLI scopes a bucket with (route-publication-release.js
// regionAccountIds: accountInScope(bucket, country.toUpperCase()); pinned equal by the registry suite), and
// evaluateRouteEvidence() hands that SAME frozen ctx object to every evidence.sql[i].params(ctx) and to
// evidence.compose(rowsByName, ctx) -- one clock, one scope -- then validates the compose result (fail closed).
// Every module here is PURE (no I/O at import); the only I/O is the injected read-only `query`. 7-bit ASCII, LF.

import {
  routeTopoOrder, validateRouteModule, makeEvidenceContext, evidenceContextProblems, makeTier1Target, normalizeLiveRowScopes, validateComposeResult,
  ROUTE_CLI_SCRIPT, LEGACY_CLI_SCRIPTS, ROUTE_REGIONS, REGION_TARGET_PREFIX,
} from "./route-contract.js";
import { accountInScope } from "../sync/scheduler-scope.js";
import OLI from "./routes/oli.route.js";
import ADS from "./routes/ads.route.js";
import FBA from "./routes/fba.route.js";
import LISTINGS from "./routes/listings.route.js";
import FBA_PLAN from "./routes/fba-plan.route.js";
import RETURNS_V3 from "./routes/returns-v3.route.js";
import BRAND_VIEW_BRANDS from "./routes/brand-view-brands.route.js";
import SKU_MOVEMENT from "./routes/sku-movement.route.js";
import BRAND_VIEW from "./routes/brand-view.route.js";
import BRAND_VIEW_PORTFOLIO from "./routes/brand-view-portfolio.route.js";

const S = (v) => (v == null ? "" : String(v));

// Validated FAIL-CLOSED at import: a malformed route module makes the worker refuse to start.
export const PUBLICATION_ROUTES = Object.freeze([
  OLI, LISTINGS, FBA_PLAN, RETURNS_V3, ADS, FBA, BRAND_VIEW_BRANDS, SKU_MOVEMENT, BRAND_VIEW, BRAND_VIEW_PORTFOLIO,
].map((r) => validateRouteModule(r, { side: "worker" })));
export const ROUTE_IDS = Object.freeze(PUBLICATION_ROUTES.map((r) => r.id));
export const LEGACY_ROUTE_IDS = Object.freeze(PUBLICATION_ROUTES.filter((r) => r.kind === "legacy-cli").map((r) => r.id));
export const ROUTE_CLI_ROUTE_IDS = Object.freeze(PUBLICATION_ROUTES.filter((r) => r.kind === "route-cli").map((r) => r.id));
const BY_ID = new Map(PUBLICATION_ROUTES.map((r) => [r.id, r]));
// The ONLY scripts a worker child may ever run (the runner refuses anything else, even a mis-registered route).
export const ALLOWED_WORKER_SCRIPTS = Object.freeze([...LEGACY_CLI_SCRIPTS, ROUTE_CLI_SCRIPT]);
// scripts/release/publication-route-reconcile.mjs --targets bound (route-publication-release.js ROUTE_CLI_MAX_TARGETS;
// pinned equal by the registry suite).
export const ROUTE_CLI_MAX_TARGETS = 25;

/** The declared route (THROWS on an unknown id -- fail closed). */
export function routeById(id, routes = PUBLICATION_ROUTES) {
  const r = routes === PUBLICATION_ROUTES ? BY_ID.get(S(id)) : (Array.isArray(routes) ? routes.find((x) => x && x.id === S(id)) : null);
  if (!r) throw new Error(`publication-recovery routes: unknown route '${S(id).slice(0, 60)}' (fail closed).`);
  return r;
}

/** Kahn topological order of the route ids by `awaits` (ties keep the priority order). THROWS on a cycle. */
export function topoOrder(routes = PUBLICATION_ROUTES) {
  return routeTopoOrder(routes);
}

/**
 * The UTC D-1 epoch of an instant: the job as-of of EVERY route, and exactly fba-plan-operation.js fbaInventoryAsOf(now)
 * (the fba-plan route's --as-of MUST equal it; pinned identical by the registry suite).
 */
export function utcDMinus1(now = Date.now()) {
  return new Date(Number(now) - 86400000).toISOString().slice(0, 10);
}

/** The region's durable-directory account ids (accountInScope over the directory country), sorted -- the CLI's rule. */
export function regionEvidenceAccountIds(directory, region) {
  const out = [];
  for (const [id, m] of directory instanceof Map ? directory : new Map()) if (accountInScope(region, S(m && m.country).toUpperCase())) out.push(id);
  return out.sort();
}

/**
 * THE ONE evidence ctx of a (region, epoch, now) read: { epoch, now, accountIds: every directory account of the region,
 * directory, region, organizationFingerprint, connectionId: 'primary' } (frozen; THROWS on anything malformed).
 */
export function buildEvidenceContext({ epoch, now, directory, region, organizationFingerprint } = {}) {
  if (!ROUTE_REGIONS.includes(region)) throw new Error("publication-recovery routes: evidence region must be india | europe-au | us-ca (fail closed).");
  return makeEvidenceContext({ epoch, now, accountIds: regionEvidenceAccountIds(directory, region), directory, region, organizationFingerprint });
}

/**
 * Run ONE route's metadata-only evidence statements through the injected READ-ONLY `query(text, values) -> rows` and
 * compose them -- the SAME ctx object for every params() and the compose. -> the validated compose Map (each entry's
 * region null or ctx.region; a region-grain route yields at most its own 'region:<region>' target). THROWS on a read or
 * a malformed result (the caller defers; never a partial token set).
 */
export async function evaluateRouteEvidence(route, query, ctx, { sweep = false } = {}) {
  const r = typeof route === "string" ? routeById(route) : route;
  if (typeof query !== "function") throw new Error("evaluateRouteEvidence: a read-only query function is required (fail closed).");
  const problems = evidenceContextProblems(ctx); // re-validated: a caller-built ctx is never trusted blindly
  if (problems.length) throw new Error(`evaluateRouteEvidence: the evidence context is invalid (fail closed): ${problems.join(", ")}`);
  const c = ctx; // the SAME object for every params() and the compose
  const rowsByName = {};
  for (const q of r.evidence.sql) {
    // SWEEP MODE (a caller holding a sweep cache: the worker's tier-1 / watermark pass, memcheck --real): a statement
    // with a `sharedVariant` runs that region-independent `shared: true` variant instead (its rows land under THIS
    // statement's name -- the compose folds both identically). Without sweep mode the statement's own text runs.
    const st = sweep === true && q.sharedVariant ? q.sharedVariant : q;
    // The statement itself is passed as a 3rd argument (ignored by a plain query; read by sweepMemoQuery for `shared`).
    const rows = await query(st.text, st.params(c), st);
    if (!Array.isArray(rows)) throw new Error(`evaluateRouteEvidence: '${r.id}' statement '${q.name}' returned no rows array (fail closed).`);
    rowsByName[q.name] = rows;
  }
  return validateComposeResult(r.evidence.compose(rowsByName, c), { ctx: c, grain: r.grain, routeId: r.id });
}

/**
 * THE SWEEP CACHE (tier-1 performance): wrap a read-only `query(text, values, statement)` so a statement DECLARED
 * `shared: true` (region-independent text + params: ads-daily-evidence.js ADS_DAILY_STATEMENT) runs ONCE per sweep --
 * a later route x region evaluation issuing the IDENTICAL (text, values) reuses the first result. Every other statement
 * runs exactly as before, in its own evaluation's snapshot. The cached rows are FROZEN copies (a compose that mutated a
 * shared row would throw -> that evaluation defers, fail closed); a non-array result is never cached. A FAILED shared
 * read fails FAST for the rest of THIS pass (every later evaluation re-throws its code at once instead of re-issuing a
 * scan that just failed -- up to 6 x the statement timeout); the next pass (a new cache) retries it.
 * A cached result is at most one sweep older than the evaluation using it -- a write landing mid-sweep is seen by the
 * next sweep, exactly as for a write landing after a route's own read. No cache (null) -> the query unchanged.
 */
export function sweepMemoQuery(query, sweepCache) {
  if (typeof query !== "function") throw new Error("sweepMemoQuery: a query function is required (fail closed).");
  if (!(sweepCache instanceof Map)) return query;
  return async (text, values, statement) => {
    if (!(statement && statement.shared === true)) return query(text, values, statement);
    const key = S(text) + "\u0000" + JSON.stringify(values == null ? [] : values);
    if (sweepCache.has(key)) {
      const hit = sweepCache.get(key);
      if (hit && hit.__sweepFailed === true) { const e = new Error("shared evidence read failed earlier in this pass (" + hit.code + ")"); e.code = hit.code; throw e; }
      return hit;
    }
    let rows;
    try { rows = await query(text, values, statement); }
    catch (e) { sweepCache.set(key, Object.freeze({ __sweepFailed: true, code: S(e && (e.code || e.name)).slice(0, 40) || "error" })); throw e; }
    if (!Array.isArray(rows)) return rows;
    const frozen = Object.freeze(rows.map((row) => (row && typeof row === "object" ? Object.freeze({ ...row }) : row)));
    sweepCache.set(key, frozen);
    return frozen;
  };
}

/** The pinned tier-1 target of a route target key in a region: { targetKey, accountId?, region } (THROWS if malformed). */
export function tier1Target(route, targetKey, region) {
  const r = typeof route === "string" ? routeById(route) : route;
  return makeTier1Target({ targetKey, region, grain: r.grain });
}

/** The route's validated live-row scopes (always an array) for a pinned tier-1 target. */
export function liveRowScopesFor(route, target) {
  const r = typeof route === "string" ? routeById(route) : route;
  return normalizeLiveRowScopes(r.tier1.liveRowScope(target));
}

/** The identity as-of of a pinned tier-1 target (null for a route whose as-of is evidence-derived). */
export function identityAsOfFor(route, target, { now, directory } = {}) {
  const r = typeof route === "string" ? routeById(route) : route;
  if (typeof r.identityAsOf !== "function") return null;
  if (typeof now !== "number" || !Number.isFinite(now)) throw new Error("identityAsOfFor: `now` must be epoch ms (fail closed).");
  return r.identityAsOf(target, { now, directory });
}

/**
 * Whether a target's OWNERS gate it. Account grain: the owner IS the target. Region grain: NEVER -- the region target's
 * owners (every member, incl. settingUp accounts) are informational; the per-unit publisher AND gate covers members.
 */
export function ownersGateTarget(route) {
  const r = typeof route === "string" ? routeById(route) : route;
  return r.grain === "account";
}

/** The region-grain target key of a region. */
export const regionTargetKey = (region) => REGION_TARGET_PREFIX + S(region);

/** Whether a route's CLI supports --verify-exact (the route CLI; the four legacy CLIs have no manifest pass). */
export function supportsVerifyExact(route) {
  const r = typeof route === "string" ? routeById(route) : route;
  return r.kind === "route-cli";
}

/**
 * The PERIODIC deep sweep (the verify-exact backstop): an L1 metadata token cannot see every content drift (e.g. the
 * returns SKU->ASIN resolver); the route CLI's --verify-exact manifest can. Every route is due once per
 * PRW_DEEP_SWEEP_HOURS: a route-cli sweep is a read-only 'verify' (--verify-exact) pass whose 'manifest-differs' units
 * are then repaired by a 'repair' (--live --verify-exact) pass; a legacy route's sweep is its ordinary dry-run.
 * -> [{ routeId, kind: 'verify' | 'dry-run' }] for the routes due at `now` (lastAtByRoute: routeId -> epoch ms | null).
 */
export function deepSweepDue({ now, deepSweepHours, lastAtByRoute = {}, routes = PUBLICATION_ROUTES } = {}) {
  const h = Number(deepSweepHours);
  if (!Number.isInteger(h) || h < 1 || h > 24 || typeof now !== "number" || !Number.isFinite(now)) throw new Error("deepSweepDue: now (epoch ms) + deepSweepHours in [1, 24] are required (fail closed).");
  const out = [];
  for (const r of routes) {
    const last = lastAtByRoute[r.id];
    if (typeof last === "number" && Number.isFinite(last) && now - last < h * 3600000) continue;
    out.push({ routeId: r.id, kind: supportsVerifyExact(r) ? "verify" : "dry-run" });
  }
  return out;
}
