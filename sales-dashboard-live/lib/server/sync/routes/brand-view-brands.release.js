// Publication recovery WP8 -- CLI-side `brand-view-brands` route: the zero-export release of the Brand View per-account
// brand DIRECTORY through the generic route release (route-publication-release.js -> the fenced four-gate publisher).
// Worker-side twin: lib/server/recovery/routes/brand-view-brands.route.js (the evidence SQL + pure compose it shares).
//
// build(deps) returns the route runtime:
//   readScopeEvidence -- the worker's OWN latest-rows evidence SQL through deps.pgReadOnly (a READ ONLY transaction),
//                        composed by the SAME pure compose -> per-account { identities, ambiguous, token }; an unreadable
//                        read is { ok:false } (the whole run defers -- never an empty directory);
//   computeRevision   -- PURE: the L1 token 'bb1:...' (revisionId == evidenceToken), deps = the three row identities;
//                        an AMBIGUOUS latest row (a tie at the newest updated_at) is ineligible (typed);
//   resolveBundle     -- re-reads the evidence (strict) -> the same revision + a manifest token over it;
//   derive            -- buildBrandViewBrandDirectory({ accountId, getSnapshot }) over the SAME STORAGE-FIRST HYDRATED
//                        reader the serve's rebuild uses (api/datadoe.js brandViewDirectory: getLatestReportSnapshotHydrated
//                        -- WP10 moved the serve and this route to it TOGETHER), so the published directory IS what the
//                        page would derive. STRICT: each of the three reads must be ok AND return EXACTLY the evidence
//                        row (id + hash + instants + version); a read throw, a missing read, or an advanced row DEFERS
//                        (notReady) -- an EMPTY brand list is published only when all three reads were ok and genuinely
//                        carry no brand. An OUT-OF-LINE source row (a payload_storage_path whose inline payload is not
//                        usable -- supabase.js inlinePayloadUsable, applied inside the hydrated reader) is read from its
//                        storage object and contributes its brands; when that object is ABSENT (the storage read returns
//                        null) the derive DEFERS 'storage-missing:<report>', and when the storage read THROWS it defers
//                        'hydrate-failed:<report>' -- the hydrated reader would otherwise fall back to the inline stub and
//                        this route would publish a FABRICATED empty / reduced directory over the LKG (the serve answers
//                        the same case with a typed 503 UNAVAILABLE, never a list). A storage path with a USABLE inline
//                        payload is read inline, exactly like the serve;
//   identityParams    -- {} (the live param accountId is the target itself); stampPolicy 'cycle';
//   servedSelector    -- selectExact('brand-view-brands', account, { accountId }) (the serve's cache-first exact read).
// The runtime sees READ-ONLY readers only (deps.sb is the get*/list* facade); zero DataDoe. 7-bit ASCII, LF.

import { createHash } from "node:crypto";
import { buildBrandViewBrandDirectory, BRAND_VIEW_BRANDS_VERSION } from "../../reports/brand-view.js";
import { selectExact } from "../../recovery/serve-selectors.js";
import { stableJson } from "../publication-binding.js";
import { snapshotRowIdentity, sameSnapshotIdentity } from "../brand-view-dependency-readers.js";
import workerRoute, {
  BRAND_VIEW_BRANDS_ROUTE_ID, BRAND_VIEW_BRANDS_PUBLISHER_KEY, BRAND_VIEW_BRANDS_EVIDENCE_REPORT_KEYS, composeBrandViewBrandsEvidence,
  brandViewBrandsIneligibleReason,
} from "../../recovery/routes/brand-view-brands.route.js";

const S = (v) => (v == null ? "" : String(v));
const sha256 = (v) => createHash("sha256").update(String(v)).digest("hex");
const errCode = (e) => (S(e && e.message).match(/^[A-Za-z0-9_.:-]+/) || [""])[0].slice(0, 80) || "error";

/** The dependency identity strings a revision records (sync_report_jobs.depends_on; printable ASCII, bounded). */
export function brandViewBrandsDeps(identities) {
  return BRAND_VIEW_BRANDS_EVIDENCE_REPORT_KEYS.map((rk) => {
    const id = identities && identities[rk];
    return "bb:" + rk + ":" + (id ? S(id.id) + "@" + S(id.upd) : "absent");
  }).sort();
}

/** PURE revision of one account's directory evidence (the ineligibility predicate is the worker compose's own). */
export function brandViewBrandsRevision(evidence) {
  const reason = brandViewBrandsIneligibleReason(evidence);
  if (reason) return { eligible: false, reason };
  const token = S(evidence.token);
  return { eligible: true, revisionId: token, evidenceToken: token, deps: brandViewBrandsDeps(evidence.identities), status: "available" };
}

function build(deps = {}) {
  const { sb, pgReadOnly, computeHash } = deps;
  if (!sb || typeof sb.getReportSnapshot !== "function") throw new Error("brand-view-brands route requires the read-only supabase facade (getReportSnapshot) (fail closed).");
  // The serve's storage-first HYDRATED reader + the storage loader it is observed through (WP10).
  if (typeof sb.getLatestReportSnapshotHydrated !== "function" || typeof sb.getReportSnapshotStoragePayload !== "function") throw new Error("brand-view-brands route requires the hydrated reader (getLatestReportSnapshotHydrated + getReportSnapshotStoragePayload) on the read-only facade (fail closed).");
  if (typeof pgReadOnly !== "function") throw new Error("brand-view-brands route requires pgReadOnly (fail closed).");
  if (typeof computeHash !== "function") throw new Error("brand-view-brands route requires computeHash (paramsHashFor) (fail closed).");
  const SQL = workerRoute.evidence.sql;

  // The worker's own evidence SQL, run read-only for `scope`, composed by the shared pure compose.
  async function readEvidence(scope) {
    const accountIds = [...new Set((Array.isArray(scope) ? scope : []).map(S).filter(Boolean))].sort();
    const rowsByName = {};
    for (const q of SQL) rowsByName[q.name] = await pgReadOnly(q.text, q.params({ accountIds }));
    return composeBrandViewBrandsEvidence(rowsByName, { accountIds });
  }

  async function resolve(accountId) {
    let ev;
    try { ev = (await readEvidence([accountId])).get(accountId); } catch (e) { return { eligible: false, reason: "evidence-unreadable:" + errCode(e) }; }
    const rev = brandViewBrandsRevision(ev);
    if (!rev.eligible) return rev;
    const manifestToken = "bbm1:" + sha256(stableJson([rev.evidenceToken, accountId]));
    return { eligible: true, revisionId: rev.revisionId, evidenceToken: rev.evidenceToken, manifestToken, deps: rev.deps, bundle: { accountId, evidence: ev } };
  }

  return {
    readScopeEvidence: async ({ scope }) => {
      try { return { ok: true, perAccount: await readEvidence(scope) }; }
      catch (e) { return { ok: false, failCode: "brand-view-brands-evidence-unreadable:" + errCode(e) }; }
    },
    computeRevision: ({ evidence }) => brandViewBrandsRevision(evidence),
    resolveBundle: async (unit) => resolve(S(unit && unit.targetId)),
    derive: async (bundle) => {
      const accountId = S(bundle && bundle.accountId);
      const want = (bundle && bundle.evidence && bundle.evidence.identities) || {};
      const problems = []; const readOk = new Set();
      // The serve's HYDRATED reader (storage-first), strict: every read must succeed AND be exactly the evidence row; an
      // out-of-line row is read from its storage object, whose load is OBSERVED -- an ABSENT object (null) or a failed
      // load is a typed deferral, never the inline stub read as "no brands" (a fabricated empty directory over the LKG).
      const getSnapshot = async ({ reportKey, accountId: acct }) => {
        let storage = null; // null (not read, or hydrated) | 'missing' | 'failed'
        const readStorage = async (objectPath, opt) => {
          let hydrated;
          try { hydrated = await sb.getReportSnapshotStoragePayload(objectPath, opt); } catch (e) { storage = "failed"; throw e; }
          if (hydrated == null) storage = "missing";
          return hydrated;
        };
        let row;
        try { row = await sb.getLatestReportSnapshotHydrated({ reportKey, accountId: acct }, { readStorage }); }
        catch (e) { problems.push("read-failed:" + reportKey); throw e; }
        if (acct !== accountId || !Object.prototype.hasOwnProperty.call(want, reportKey)) problems.push("unbound-read:" + reportKey);
        else if (!sameSnapshotIdentity(snapshotRowIdentity(row), want[reportKey])) problems.push("evidence-advanced:" + reportKey);
        else if (storage === "missing") problems.push("storage-missing:" + reportKey);
        else if (storage === "failed") problems.push("hydrate-failed:" + reportKey);
        else readOk.add(reportKey);
        return row;
      };
      let payload;
      try { payload = await buildBrandViewBrandDirectory({ accountId, getSnapshot }); }
      catch (e) { return { notReady: true, reason: problems[0] || "directory-build-failed:" + errCode(e) }; }
      if (problems.length) return { notReady: true, reason: problems[0] };
      // ALL three reads must have happened and been ok -- an empty list is never the product of a skipped read.
      const missing = BRAND_VIEW_BRANDS_EVIDENCE_REPORT_KEYS.find((rk) => !readOk.has(rk));
      if (missing) return { notReady: true, reason: "read-missing:" + missing };
      return { payload };
    },
    identityParams: () => ({}),
    servedSelector: async (unit) => {
      const accountId = S(unit && unit.liveAccountId);
      return selectExact({
        reportKey: "brand-view-brands", accountId, reportVersion: BRAND_VIEW_BRANDS_VERSION, params: { accountId },
        readers: { getReportSnapshot: sb.getReportSnapshot }, computeHash,
      });
    },
  };
}

export default Object.freeze({
  id: BRAND_VIEW_BRANDS_ROUTE_ID,
  publisherKey: BRAND_VIEW_BRANDS_PUBLISHER_KEY,
  stampPolicy: "cycle",
  build,
});
