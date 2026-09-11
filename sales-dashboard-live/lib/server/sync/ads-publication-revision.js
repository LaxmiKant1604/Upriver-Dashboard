// Durable Campaign-Ads revision identity -- PURE (no I/O; the reconciler + the normal derive supply the durable Ads
// evidence). The Ads analog of computeOliAccountRevision / computeFbaAccountRevision.
//
// Durable Ads is stored per account+grain in public.ads_daily_source_rows (campaign-performance-v1 etc.) with a
// per-account+grain ads_sync_state.content_rev + ads_sync_coverage window (migration 20260923, APPLIED). The content_rev
// is a byte-stable committed-content revision (committedContentRev in ads-sync.js): a same-window CORRECTION flips it,
// and a nonempty->empty transition flips it too. Because Ads content is grain-scoped and different reports consume
// different grain subsets (daily-reporting: campaign only; ppc-performance: campaign + targeting + search-terms), and
// the shared reconciler core applies ONE revision per account across ALL reportKeys, the revision carries a SINGLE
// per-account COMPOSITE content token folding EVERY durably-covered grain's content_rev (no as-of field). Both dependent reports record
// the SAME composite token in their sync_report_jobs.durable_content_deps (migration 20260925), so:
//   - a same-date correction on ANY covered grain flips its content_rev -> the composite changes -> every dependent
//     report is STALE (no under-detection);
//   - a report that does not consume a changed grain (e.g. daily-reporting when only targeting changed) is also flagged
//     STALE, but re-deriving it from unchanged durable inputs yields the SAME payload -> the fenced content-CAS makes it
//     an idempotent no-op (already-current, ZERO live write). Over-detection is SAFE; it never marks stale-as-fresh.
// The token is path-independent (no as-of field), exactly like fbaContentProvenanceToken: the exact requested-as-of is
// enforced separately by the publication binding's D-1 gate, so the token binds only the durable CONTENT identity.
// MISSING / not-covered-through-D-1 / blank-content-rev evidence is INELIGIBLE (unavailable; defer, never a fabricated
// zero). A genuine covered-through-D-1 grain is proven, so its (real) zero rows are a valid available-zero. 7-bit ASCII, LF.

import { createHash } from "node:crypto";
import { ADS_SOURCE_KEYS, ADS_PRIMARY_SOURCE_KEY } from "./ads-dependent-reports.js";

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const asDay = (v) => S(v).slice(0, 10); // YYYY-MM-DD prefix of a date / timestamptz string

// Ads revision status vocabulary (parallels OLI_LINEAGE_STATUS / FBA_REVISION_STATUS). AVAILABLE = the required campaign
// grain is durably covered through D-1 with a content revision; COVERED_EMPTY = covered-through-D-1 but the grain proved
// empty (a genuine available-zero); MISSING = no proven coverage / blank content rev (defer -> unavailable, never zero).
export const ADS_REVISION_STATUS = Object.freeze({ AVAILABLE: "available", COVERED_EMPTY: "covered-empty", MISSING: "missing" });

// The AUTHORITATIVE durable Ads CONTENT-provenance token: a deterministic, self-describing, subset-checkable string
// binding the EXACT durable Ads content an Ads-dependent report consumed -- account + connection + marketplace + the
// SORTED (grain -> content_rev) tuples for every durably-covered grain. Recorded in the report job's
// durable_content_deps (migration 20260925) by BOTH the normal scheduler derive and the reconciler derive (SAME
// semantics), and it is the revision's ONLY contentDeps entry the shared revisionCoveredByJob checks against. Never a
// bare sha (ambiguous with a request hash) -- a pipe-delimited provenance string. content_rev (adsWindowContentRev,
// ads-sync.js) is a content sha over the durable rows across the MAX Ads coverage window, so BOTH a same-date
// correction AND a D-1 coverage advance flip it -> the token changes -> the live dashboard built from the old content
// is provably STALE. There is deliberately NO as-of / covered-through field in the token (only content_rev), exactly
// like fbaContentProvenanceToken: a through/as-of field would let the normal derive's cycle as-of and the reconciler's
// requested as-of disagree and produce non-equal tokens for the SAME durable content (perpetual re-derive). The exact
// requested-as-of is enforced separately by the publication binding's D-1 gate.
export function adsContentProvenanceToken({ accountId, connectionId = "primary", marketplace = "", grainRevs = [] } = {}) {
  const folded = [...(Array.isArray(grainRevs) ? grainRevs : [])]
    .filter((g) => g && ADS_SOURCE_KEYS.includes(S(g.sourceKey)) && nb(g.contentRev))
    .map((g) => ({ k: S(g.sourceKey), rev: S(g.contentRev) }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  const body = folded.map((g) => g.k + "=" + g.rev).join(",");
  return ["ads", S(accountId), S(connectionId), S(marketplace), body].join("|");
}

/**
 * Deterministic durable Campaign-Ads revision for ONE account. Inputs:
 *   grains -- { [sourceKey]: { contentRev, latestMetricDate, coveredThrough, read } } for the Ads grains the account has;
 *             coveredThrough is the MAX ads_sync_coverage covered_to (YYYY-MM-DD or timestamptz), read is 'ok' on a
 *             successful durable read. A grain is FOLDED (counts toward the content token + eligibility) ONLY when it is
 *             read:'ok', durably covered THROUGH requestedAsOf (D-1), and carries a nonblank content_rev.
 *   marketplace -- the account's marketplace (bound into the token for cross-marketplace isolation; "" when unknown).
 * Returns:
 *   { eligible:true,  status, revisionId:<32 hex>, deps:[], contentDeps:[<ads content token>], reason:null }  when provable
 *   { eligible:false, status, revisionId:null, deps:[], contentDeps:[], reason:<token> }                       otherwise (defer)
 * The REQUIRED campaign grain (ADS_PRIMARY_SOURCE_KEY) must be covered-through-D-1 with a content_rev, else the account
 * is UNAVAILABLE (never a fabricated zero). `deps` is EMPTY (Ads is not bound into report depends_on in the normal
 * derive -- see ads-dependent-reports.js); all Ads provenance is carried by the single composite content token in
 * contentDeps, which the shared revisionCoveredByJob checks against the report job's durable_content_deps.
 */
export function computeAdsAccountRevision({ organizationFingerprint, connectionId = "primary", accountId, marketplace = "", requestedAsOf, grains = {} } = {}) {
  const miss = (reason) => ({ eligible: false, status: ADS_REVISION_STATUS.MISSING, revisionId: null, deps: [], contentDeps: [], reason });
  if (!nb(organizationFingerprint) || !nb(accountId) || !DATE_RE.test(S(requestedAsOf))) return miss("incomplete-account-boundary");
  const g = grains && typeof grains === "object" ? grains : {};
  // A grain is durably PROVEN for this as-of iff the read succeeded, coverage extends THROUGH requestedAsOf, and a
  // content_rev exists. Anything weaker is unavailable for that grain (never a manufactured zero).
  const proven = (sk) => {
    const e = g[sk];
    if (!e || S(e.read) !== "ok") return null;
    if (!nb(e.contentRev)) return null;
    const through = asDay(e.coveredThrough);
    if (!DATE_RE.test(through) || through < S(requestedAsOf)) return null;
    return { sourceKey: sk, contentRev: S(e.contentRev), coveredThrough: through, latestMetricDate: asDay(e.latestMetricDate) };
  };
  // REQUIRED campaign grain: without proven durable coverage through D-1 + a content_rev, Ads is UNAVAILABLE for this
  // account -- defer, never publish a fabricated zero, never shadow a proven LKG with an unproven snapshot.
  const primary = proven(ADS_PRIMARY_SOURCE_KEY);
  if (!primary) return miss("ads-campaign-not-covered-through-d1");
  // Fold every PROVEN grain (campaign required + targeting/search when present) into the composite content token.
  const grainRevs = ADS_SOURCE_KEYS.map(proven).filter(Boolean);
  const contentToken = adsContentProvenanceToken({ accountId, connectionId, marketplace, grainRevs });
  // COVERED_EMPTY vs AVAILABLE: a proven grain whose latest metric date is blank/absent is a genuine covered-empty
  // (available-zero); otherwise there is real Ads activity. Either way the account is ELIGIBLE (coverage is proven).
  const status = nb(primary.latestMetricDate) ? ADS_REVISION_STATUS.AVAILABLE : ADS_REVISION_STATUS.COVERED_EMPTY;
  const revisionId = createHash("sha256")
    .update([S(organizationFingerprint), S(connectionId), S(accountId), S(marketplace), S(requestedAsOf), status, contentToken].join("|"))
    .digest("hex").slice(0, 32);
  return { eligible: true, status, revisionId, deps: [], contentDeps: [contentToken], reason: null };
}
