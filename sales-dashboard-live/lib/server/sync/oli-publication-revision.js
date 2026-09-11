// Durable OLI revision identity + per-(account, report) reconciliation classification -- PURE (no I/O; the reconciler
// supplies the durable evidence + the live-snapshot lookup). This is WORK 3 of the OLI saved-data-to-dashboard system:
// a deterministic per-account OLI revision derived ONLY from durable evidence, and the decision of whether a canonical
// live report needs re-derivation.
//
// The revision identity includes the COMPLETE account boundary (organizationFingerprint + connectionId + accountId --
// never account_id alone) plus the requested as-of, the OLI start, and the SORTED proven OLI request hashes (positive-
// sales provenance OR the proven zero-row export chain), via the SAME resolveOliLineageProvenance the derive runtime
// and the partial preflight use. It NEVER fabricates a hash: MISSING / malformed / capped / ambiguous provenance is
// ineligible (revisionId:null) and must be deferred, never published. Coverage alone is never sufficient (the resolver
// requires a real request hash). 7-bit ASCII, LF.

import { createHash } from "node:crypto";
import { resolveOliLineageProvenance, OLI_LINEAGE_STATUS } from "./source-durable-model.js";
import {
  PUBLICATION_STATE,
  liveSnapshotAsOf,
  revisionCoveredByJob,
  stableJson,
  jobIsPromotable,
  isCalendarDate,
  evaluatePublicationBinding as evaluatePublicationBindingCore,
  classifyReportTarget as classifyReportTargetCore,
} from "./publication-binding.js";

const S = (v) => (v == null ? "" : String(v));

// The OLI reconciliation states + the pure binding/classifier primitives are now the SHARED source-agnostic core
// (publication-binding.js). This module keeps its historical OLI-named API by re-exporting the shared primitives and
// supplying the OLI-specific durable revision (computeOliAccountRevision) + the OLI "oli-revision-changed" reason. The
// re-exports are byte-identical to the extracted originals, so the OLI suites stay behaviorally green.
export const OLI_PUBLICATION_STATE = PUBLICATION_STATE;
export { liveSnapshotAsOf, stableJson, jobIsPromotable, isCalendarDate };
export const oliRevisionCoveredByJob = revisionCoveredByJob;
// The OLI-facing binding + classifier default the revision-changed reason to "oli-revision-changed" (the exact string
// the OLI runtime + tests expect). The shared core defaults to the generic "source-revision-changed".
export function evaluatePublicationBinding(args = {}) {
  return evaluatePublicationBindingCore({ revisionChangedReason: "oli-revision-changed", ...args });
}
export function classifyOliReportTarget(args = {}) {
  return classifyReportTargetCore({ revisionChangedReason: "oli-revision-changed", ...args });
}

/**
 * Deterministic durable OLI revision for ONE account. Returns:
 *   { eligible:true,  status, revisionId:<32 hex>, deps:[...sorted hashes], reason:null }  when durable OLI is provable
 *   { eligible:false, status, revisionId:null, deps:[], reason:<token> }                   otherwise (defer, never publish)
 * `status` is one of OLI_LINEAGE_STATUS. A blank account boundary (missing orgFp/accountId/oliStart/asOf) is ineligible.
 */
export function computeOliAccountRevision({ organizationFingerprint, connectionId = "primary", accountId, oliStart, requestedAsOf, positiveHashes = [], zeroRowExports = [] } = {}) {
  if (!organizationFingerprint || !accountId || !oliStart || !requestedAsOf) {
    return { eligible: false, status: OLI_LINEAGE_STATUS.MISSING, revisionId: null, deps: [], reason: "incomplete-account-boundary" };
  }
  const res = resolveOliLineageProvenance({ historyProvenanceHashes: positiveHashes, zeroRowExports, oliStart, requestedAsOf });
  const eligible = res.status === OLI_LINEAGE_STATUS.NONEMPTY || res.status === OLI_LINEAGE_STATUS.PROVEN_EMPTY;
  if (!eligible) return { eligible: false, status: res.status, revisionId: null, deps: [], reason: res.reason || "provenance-missing" };
  const deps = [...new Set(res.deps || [])].sort();
  if (deps.length === 0) return { eligible: false, status: OLI_LINEAGE_STATUS.MISSING, revisionId: null, deps: [], reason: "eligible-without-deps" };
  const revisionId = createHash("sha256")
    .update([S(organizationFingerprint), S(connectionId), S(accountId), S(oliStart), S(requestedAsOf), res.status, deps.join(",")].join("|"))
    .digest("hex").slice(0, 32);
  return { eligible: true, status: res.status, revisionId, deps, reason: null };
}
