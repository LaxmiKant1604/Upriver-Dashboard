// The shared-Catalog COLD-CACHE latch for the zero-export OLI publication reconciler's per-account loop.
//
// The reconciler's Catalog carrier is ORG-SCOPED and DATE-INDEPENDENT: one canonical request hash covers every account
// in a pass. When that carrier is not adoptable from the durable 24h export cache this pass, EVERY account's derive
// defers identically -- makeDurableCatalogGuard's no-export adapter refuses `create` before it reserves, so a cache
// MISS can never be satisfied and the derive returns SOURCE_READINESS_PENDING (a clean, LKG-preserving deferral by
// design; it publishes once a natural scheduler cycle re-warms the cache and it can ADOPT instead of create).
//
// Running a full per-account preflight + derive for all N accounts only to hit the SAME shared refusal wastes roughly
// (preflight cost) x N and, once it crosses the cooperative deadline, leaves the region's termination UNCONFIRMED so
// the global control lease stays held and the other regions defer on CONTROL_LEASE_HELD. The latch removes that waste:
// once ANY account proves the shared carrier cold, the remaining accounts are fast-deferred with the byte-identical
// typed outcome. This is zero data risk -- they would defer regardless (the carrier is shared, so cold-for-one is
// cold-for-all) -- and the pass now finishes well within the deadline, so the lease safe-closes and the next region
// proceeds. A WARM pass publishes its first account (reason != SOURCE_READINESS_PENDING), so the latch never engages
// and behaviour is byte-identical to today. 7-bit ASCII, LF.

// The ONLY reason the priority reconciler emits for a shared-carrier cold defer. OLI/Ads/FBA are paused in
// priorityMode, and account-specific derive lags carry their own distinct codes (e.g. DATADOE_D1_NOT_READY), so this
// reason uniquely identifies the org-scoped Catalog carrier being unadoptable this pass.
export const CATALOG_COLD_DEFER_REASON = "SOURCE_READINESS_PENDING";

// True when a per-account release result proves the SHARED Catalog carrier was not adoptable this pass.
export function isSharedCatalogColdDefer(result) {
  return !!(result && result.reason === CATALOG_COLD_DEFER_REASON);
}

// The byte-identical typed deferral a fast-defer returns -- the SAME shape a genuine Catalog-cold derive defer produces
// (code 1 / ok false / status null / no blockerCodes / reason SOURCE_READINESS_PENDING), so the reconciler classifies
// it as a retryable DEFERRAL exactly as it would a real one. Only the free-text `problems` note differs, for traceability
// (the reconciler classifies on the typed fields, never on problems text).
export function buildCatalogColdFastDefer(bucket) {
  return {
    code: 1,
    ok: false,
    stage: "derive:" + String(bucket),
    status: null,
    leaseLost: false,
    reason: CATALOG_COLD_DEFER_REASON,
    blockerCodes: [],
    problems: ["shared Catalog carrier proved not adoptable this pass; fast-deferred (a peer account already deferred SOURCE_READINESS_PENDING)"],
  };
}
