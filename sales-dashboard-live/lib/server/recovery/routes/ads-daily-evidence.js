// Publication recovery tier-1 performance -- the ONE shared Ads evidence statement of the Brand View and portfolio
// routes. Both routes need the exact 'adr1:' content digest of each account's Ads rows over a six-month build window
// (brandViewAdsWindow): Brand View per account at its marketplace's today, the portfolio for every account at the IN
// today. They used to scan ads_daily_source_rows SIX times per tier-1 sweep (per route x region) -- a wide, disk-bound
// table (2026-09-28: 82 s VM tier-1 against the 60 s gate, ~85% of it these scans). ADS_DAILY_STATEMENT reads the
// per-(account, day) digest partials ONCE over the UNION of every window the sweep needs; each route folds them back
// into its old rows (brand-view-dependency-readers.js adsWindowRowsFromDaily -- identical digests, pinned). Its text and
// params depend ONLY on the evidence clock and the directory's marketplace countries (never on the region or the
// region's accounts), so every route x region evaluation of one sweep issues the IDENTICAL statement and the worker's
// sweep cache (store-pg.js readRouteEvidence sweepCache, `shared: true`) runs it once. PURE (no I/O). 7-bit ASCII, LF.
import { ADS_DAILY_PARTIALS_SQL, ADS_DAILY_ACCOUNT_PARTIALS_SQL, brandViewAdsWindow } from "../../sync/brand-view-dependency-readers.js";
import { marketplaceToday } from "../../../marketplaces.js";
import { ACTIVE_ADS_SOURCE_KEY } from "../../active-ads-source.js";
import { evidenceAccountIds } from "./brand-view-brands.route.js";

const S = (v) => (v == null ? "" : String(v));
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// The marketplace whose today anchors the portfolio's as-of (brand-view-portfolio.route.js PORTFOLIO_ASOF_MARKETPLACE;
// pinned equal by the route suite). Always part of the union, so the portfolio window is covered even with an empty
// directory.
export const ADS_DAILY_ANCHOR_MARKETPLACE = "IN";

/**
 * The evidence clock of a ctx -- EXACTLY brand-view-brands.route.js recoveryNowDate's rule (a function, a Date or an
 * epoch-ms number; absent -> the wall clock), so Brand View's windows and this union always agree. Every production ctx
 * carries ONE concrete value (the worker: evidenceContextProblems' epoch ms; the Brand View release: a Date; the portfolio
 * release: epoch ms), and params() + compose() read the SAME ctx, so the union they derive is identical.
 */
const clockOf = (ctx) => {
  const now = ctx ? ctx.now : undefined;
  const v = typeof now === "function" ? now() : now;
  const ms = v == null ? Date.now() : (v instanceof Date ? v.getTime() : (typeof v === "number" ? v : Number.NaN));
  if (!Number.isFinite(ms)) throw new Error("ads-daily-evidence: ctx.now must be a function, a Date or an epoch-ms number (fail closed)");
  return new Date(ms);
};

/** The sorted distinct marketplace countries of the directory + the anchor (PURE). */
export function adsDailyCountries(ctx = {}) {
  const set = new Set([ADS_DAILY_ANCHOR_MARKETPLACE]);
  const dir = ctx ? ctx.directory : null;
  // A Map (every production ctx) or a plain object (directoryEntry accepts both) -- never a silently narrower union.
  const entries = dir instanceof Map ? [...dir.values()] : (dir && typeof dir === "object" ? Object.values(dir) : []);
  for (const m of entries) { const c = S(m && m.country).trim().toUpperCase(); if (c) set.add(c); }
  return [...set].sort();
}

/**
 * The UNION of every build window a sweep at ctx.now needs: min(from) .. max(to) of brandViewAdsWindow(marketplaceToday(
 * country, now)) over adsDailyCountries(ctx). Brand View's per-account windows use the account's own directory country
 * and the portfolio's the anchor, so every window of either route is inside it by construction (each route still
 * checks -- adsWindowCovered -- and fails closed typed otherwise).
 */
export function adsDailyUnionWindow(ctx = {}) {
  const now = clockOf(ctx);
  let from = ""; let to = "";
  for (const c of adsDailyCountries(ctx)) {
    const w = brandViewAdsWindow(marketplaceToday(c, now));
    if (!DAY_RE.test(S(w.from)) || !DAY_RE.test(S(w.to))) throw new Error("ads-daily-evidence: an underivable build window (fail closed)");
    if (from === "" || w.from < from) from = w.from;
    if (to === "" || w.to > to) to = w.to;
  }
  return { from, to };
}

/** True when window { from, to } lies inside union { from, to } (inclusive 'YYYY-MM-DD'). */
export function adsWindowCovered(win, union) {
  return !!(win && union && DAY_RE.test(S(win.from)) && DAY_RE.test(S(win.to)) && S(win.from) >= S(union.from) && S(win.to) <= S(union.to));
}

// The UNSCOPED shared statement (every account over the union): the portfolio's evidence statement as-is (it needs
// every account -- its old statement was already an all-accounts scan), and the sweep-mode variant of Brand View's.
export const ADS_DAILY_STATEMENT = Object.freeze({
  name: "ads_daily",
  text: ADS_DAILY_PARTIALS_SQL,
  shared: true,
  params: (ctx = {}) => { const u = adsDailyUnionWindow(ctx); return [ACTIVE_ADS_SOURCE_KEY, u.from, u.to]; },
});

// BRAND VIEW's statement: ACCOUNT-SCOPED by default ($4 = the evidence accounts; index-driven, like the old per-account
// LEFT JOIN) for every reader WITHOUT a sweep cache -- the route CLI's per-unit reads (b1 / b2 / the publish-time token /
// verify-exact must stay FRESH, so they never share), and the worker's per-job, dependency and deep-sweep reads. Only an
// evaluation WITH a sweep cache (routes.js evaluateRouteEvidence sweep mode: the worker's tier-1 and watermark passes,
// memcheck --real) runs its sharedVariant -- the unscoped statement above -- so Brand View and the portfolio read ONE
// scan per pass. Both fold to identical digests for the evidence accounts (the partials are per account).
export const ADS_DAILY_SCOPED_STATEMENT = Object.freeze({
  name: "ads_daily",
  text: ADS_DAILY_ACCOUNT_PARTIALS_SQL,
  params: (ctx = {}) => { const u = adsDailyUnionWindow(ctx); return [ACTIVE_ADS_SOURCE_KEY, u.from, u.to, [...evidenceAccountIds(ctx)]]; },
  sharedVariant: ADS_DAILY_STATEMENT,
});
