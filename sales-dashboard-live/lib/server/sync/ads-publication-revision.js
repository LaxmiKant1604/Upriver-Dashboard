// Durable Campaign-Ads REPORT-SPECIFIC revision identity -- PURE (no I/O; the reconciler + the normal derive supply the
// durable Ads evidence). The Ads analog of computeOliAccountRevision / computeFbaAccountRevision.
//
// Durable Ads is stored per account+grain in public.ads_daily_source_rows (campaign-performance-v1 etc.) with a
// per-account+grain ads_sync_state.content_rev + ads_sync_coverage windows (migration 20260923, APPLIED). content_rev is
// a byte-stable committed-content revision (committedContentRev / adsWindowContentRev, ads-sync.js): a same-window
// CORRECTION flips it, and a D-1 coverage advance flips it too.
//
// REPORT-SPECIFIC (Codex blocker 5): different reports consume different Ads grains -- daily-reporting the CAMPAIGN
// grain only; ppc-performance CAMPAIGN + TARGETING + SEARCH-TERMS. The revision is therefore computed PER REPORT (the
// caller runs one single-report reconciler operation per Ads-dependent report) and its content token folds ONLY that
// report's REQUIRED grains. So a targeting/search-terms-only correction changes ppc-performance's token but NOT
// daily-reporting's -- daily is never falsely marked changed, and a missing PPC-only grain never blocks daily.
//
// FAIL-CLOSED (Codex blocker 4): dates are validated by REAL UTC calendar round-trip (isCalendarDate), so an impossible
// date defers; a blank/unreadable marketplace defers (never a blank-market token); coverage is proven by the strict
// continuous-range evaluator (coverageProvesContinuousRange), NEVER MAX(covered_to) -- a gap anywhere in the required
// window (even one ending at D-1) is unavailable. A grain that is missing / unreadable / blank-content_rev / gapped is
// unavailable; a grain proven CONTINUOUSLY covered through D-1 with no activity is a genuine covered-empty
// (available-zero). The token is path-independent (no as-of field, exactly like fbaContentProvenanceToken) so the normal
// derive and the reconciler produce identical tokens; the exact requested-as-of is enforced by the publication binding's
// D-1 gate. 7-bit ASCII, LF.

import { createHash } from "node:crypto";
import { isCalendarDate } from "./publication-binding.js";
import { ADS_SOURCE_KEYS, ADS_PRIMARY_SOURCE_KEY } from "./ads-dependent-reports.js";

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";
const asDay = (v) => S(v).slice(0, 10); // YYYY-MM-DD prefix of a date / timestamptz string
// CANONICAL marketplace-country form for the content token. The token is produced by BOTH the reconciler
// (computeAdsReportRevision) and the hot scheduler derive (durable_content_deps binding), from DIFFERENT directory-read
// paths that normalize the country differently (the reconciler upper-cases; the hot derive kept the raw trimmed value).
// A marketplace-code is a case-insensitive ISO code, so normalize it HERE -- at the single token chokepoint both paths
// share -- so the two independently-computed tokens are byte-identical (else [token] would never be a subset of
// durable_content_deps and the reconciler could never converge). A blank stays blank (rejected upstream).
const normMarket = (v) => S(v).trim().toUpperCase();

export const ADS_REVISION_STATUS = Object.freeze({ AVAILABLE: "available", COVERED_EMPTY: "covered-empty", MISSING: "missing" });

// UTC calendar-day arithmetic on YYYY-MM-DD (production code; not a workflow script, so Date is available).
export function addUtcDaysStr(d, n) {
  const dt = new Date(S(d) + "T00:00:00Z");
  if (!Number.isFinite(dt.getTime())) return "";
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
export const subUtcDaysStr = (d, n) => addUtcDaysStr(d, -n);

// STRICT continuous-coverage proof: does the union of coverage windows contain ONE continuous segment spanning the
// entire [from .. to] (inclusive), with NO interior gap? Windows are {from,to} (or covered_from/covered_to). Two
// windows are continuous iff the next starts on or before the day AFTER the current segment's end. A gap anywhere in
// [from .. to] -- even when some later window ends exactly at `to` -- returns false (never MAX(covered_to) as proof).
export function coverageProvesContinuousRange(windows, from, to) {
  if (!isCalendarDate(from) || !isCalendarDate(to) || from > to) return false;
  const wins = (Array.isArray(windows) ? windows : [])
    .map((w) => ({ f: asDay(w && (w.from ?? w.covered_from ?? w.coveredFrom)), t: asDay(w && (w.to ?? w.covered_to ?? w.coveredTo)) }))
    .filter((w) => isCalendarDate(w.f) && isCalendarDate(w.t) && w.f <= w.t)
    .sort((a, b) => (a.f < b.f ? -1 : a.f > b.f ? 1 : (a.t < b.t ? -1 : a.t > b.t ? 1 : 0)));
  let segF = null, segT = null;
  for (const w of wins) {
    if (segF === null) { segF = w.f; segT = w.t; continue; }
    if (w.f <= addUtcDaysStr(segT, 1)) { if (w.t > segT) segT = w.t; } // adjacent/overlapping -> extend the segment
    else { if (segF <= from && segT >= to) return true; segF = w.f; segT = w.t; } // interior gap -> new segment
  }
  return segF !== null && segF <= from && segT >= to;
}

// The AUTHORITATIVE durable Ads CONTENT-provenance token for ONE report: a deterministic, self-describing,
// subset-checkable string binding account + connection + marketplace + the SORTED (grain -> content_rev) tuples for the
// report's REQUIRED grains. Recorded in the report job's durable_content_deps (migration 20260925) by BOTH the normal
// derive and the reconciler derive, and it is the revision's ONLY contentDeps entry the shared revisionCoveredByJob
// checks. NO as-of/covered-through field (matches fbaContentProvenanceToken) so the derive side and the reconciler
// produce identical tokens for the same content; the D-1 gate lives in the publication binding. A blank marketplace is
// rejected upstream (computeAdsReportRevision), so this never emits a blank-market token for an eligible account.
export function adsContentProvenanceToken({ accountId, connectionId = "primary", marketplace = "", grainRevs = [] } = {}) {
  const folded = [...(Array.isArray(grainRevs) ? grainRevs : [])]
    .filter((g) => g && ADS_SOURCE_KEYS.includes(S(g.sourceKey)) && nb(g.contentRev))
    .map((g) => ({ k: S(g.sourceKey), rev: S(g.contentRev) }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  const body = folded.map((g) => g.k + "=" + g.rev).join(",");
  return ["ads", S(accountId), S(connectionId), normMarket(marketplace), body].join("|");
}

/**
 * Deterministic durable Campaign-Ads revision for ONE (account, report). Inputs:
 *   requiredGrains -- the report's REQUIRED Ads grains (daily-reporting: [ads-campaign-date]; ppc-performance: all 3).
 *                     The token folds EXACTLY these; the campaign grain is mandatory.
 *   requiredFrom   -- the start of the report's required continuous-coverage window (requestedAsOf-(days-1)); the
 *                     reconciler computes it from adsRequiredCoverageDays(reportKey).
 *   grains         -- { [sourceKey]: { contentRev, latestMetricDate, windows:[{from,to}], read } } for the account.
 * Returns { eligible:true, status, revisionId:<32hex>, deps:[], contentDeps:[<token>], reason:null } when EVERY required
 * grain is read:'ok' + nonblank content_rev + CONTINUOUSLY covered over [requiredFrom .. requestedAsOf]; else
 * { eligible:false, status:MISSING, ... reason } (defer -> unavailable, never a fabricated zero). A missing PPC-only
 * grain fails ONLY ppc's operation, never daily's (they are separate operations with different requiredGrains).
 */
export function computeAdsReportRevision({ organizationFingerprint, connectionId = "primary", accountId, marketplace = "", requestedAsOf, requiredFrom, requiredGrains = [], grains = {} } = {}) {
  const miss = (reason) => ({ eligible: false, status: ADS_REVISION_STATUS.MISSING, revisionId: null, deps: [], contentDeps: [], reason });
  if (!nb(organizationFingerprint) || !nb(accountId)) return miss("incomplete-account-boundary");
  if (!isCalendarDate(requestedAsOf)) return miss("requested-asof-invalid");
  if (!isCalendarDate(requiredFrom) || requiredFrom > S(requestedAsOf)) return miss("required-window-invalid");
  marketplace = normMarket(marketplace); // canonical form -> eligibility, revisionId, and the token all agree cross-path
  if (!nb(marketplace)) return miss("marketplace-unavailable"); // blank/unreadable marketplace defers (no blank-market token)
  const req = [...new Set((Array.isArray(requiredGrains) ? requiredGrains : []).map(S).filter((k) => ADS_SOURCE_KEYS.includes(k)))].sort();
  if (req.length === 0 || !req.includes(ADS_PRIMARY_SOURCE_KEY)) return miss("required-grains-invalid");
  const g = grains && typeof grains === "object" ? grains : {};
  const grainRevs = [];
  let anyActivity = false;
  for (const sk of req) {
    const e = g[sk];
    if (!e || S(e.read) !== "ok" || !nb(e.contentRev)) return miss("ads-grain-unavailable:" + sk);
    if (!coverageProvesContinuousRange(e.windows, requiredFrom, requestedAsOf)) return miss("ads-grain-coverage-gap:" + sk);
    grainRevs.push({ sourceKey: sk, contentRev: S(e.contentRev) });
    if (nb(asDay(e.latestMetricDate))) anyActivity = true;
  }
  const contentToken = adsContentProvenanceToken({ accountId, connectionId, marketplace, grainRevs });
  const status = anyActivity ? ADS_REVISION_STATUS.AVAILABLE : ADS_REVISION_STATUS.COVERED_EMPTY;
  const revisionId = createHash("sha256")
    .update([S(organizationFingerprint), S(connectionId), S(accountId), S(marketplace), S(requestedAsOf), S(requiredFrom), status, req.join(","), contentToken].join("|"))
    .digest("hex").slice(0, 32);
  return { eligible: true, status, revisionId, deps: [], contentDeps: [contentToken], reason: null };
}
