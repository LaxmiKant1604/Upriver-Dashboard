// Brand View FRESHNESS + serve-mode decision (pure) -- the core of the "never stale, never blank 504" contract.
//
// Brand View (single-account and portfolio) is ASSEMBLED at read time from the per-account brand-sales +
// brand-inventory snapshots and durable ASIN Ads. The assembled snapshot is cached under a params hash that
// includes asOf -- but WITHIN a day the contributing sources can advance (e.g. brand-sales rolls 21 -> 25 Aug
// after a sync) while the cached assembly stays behind. serveSharedReport only matches the params hash, so it
// would keep serving the 21-Aug assembly as if current. This module makes the source-provenance staleness
// explicit so the read can serve the last-known-good immediately AND signal that a zero-export rebuild is due.
//
// It is PURE (no I/O): the caller supplies the candidate snapshots + the current contributing provenance; the
// caller performs the (cheap, indexed) provenance read and the (bounded) rebuild.

const S = (v) => (v == null ? "" : String(v));
const at = (snap) => (snap ? S(snap.source_refreshed_at || snap.sourceRefreshedAt || snap.updated_at || snap.updatedAt) : "");

/**
 * The newest provenance timestamp across the contributing brand-sales snapshots -- the signal a Brand View
 * assembly must be at least as fresh as. `rows` is [{ source_refreshed_at | updated_at }]. Returns "" when none.
 */
export function contributingProvenanceAt(rows) {
  let mx = "";
  for (const r of Array.isArray(rows) ? rows : []) {
    const t = S(r && (r.source_refreshed_at ?? r.sourceRefreshedAt ?? r.updated_at ?? r.updatedAt));
    if (t && t > mx) mx = t;
  }
  return mx;
}

/**
 * Decide how to serve a Brand View read.
 *   exact           -- the snapshot for the EXACT requested params hash (or null);
 *   lkg             -- the latest snapshot for this scope regardless of hash (last-known-good, or null);
 *   contributingAt  -- newest contributing brand-sales provenance (from contributingProvenanceAt), or "";
 *   deadlineExceeded -- (refresh path only) a bounded rebuild ran out of route budget without publishing.
 *
 * Returns { mode, snapshot, staleScope, updating, reason }:
 *   mode "serve-fresh"    -- serve `snapshot`; sources have NOT advanced past it; updating:false;
 *   mode "serve-stale"    -- serve `snapshot` (LKG) NOW, but a zero-export rebuild is due; updating:true;
 *   mode "updating-missing" -- no snapshot at all -> a typed "updating" state (NEVER a blank fatal error).
 * A served snapshot that is the LKG for a DIFFERENT params hash also carries staleScope:true (the across-day
 * fallback), independently of source-provenance staleness -- either reason yields updating:true.
 */
export function decideBrandViewServe({ exact = null, lkg = null, contributingAt = "", deadlineExceeded = false } = {}) {
  const served = exact || lkg || null;
  if (!served) {
    return { mode: "updating-missing", snapshot: null, staleScope: false, updating: true, reason: deadlineExceeded ? "rebuild-deadline-no-lkg" : "no-snapshot" };
  }
  const isExact = !!exact;
  const servedAt = at(served);
  const provAt = S(contributingAt);
  // Source-provenance staleness: a contributing brand-sales snapshot is NEWER than this assembly.
  const sourceStale = !!(provAt && servedAt && servedAt < provAt);
  // Scope staleness: we could only find the LKG for a different params hash (older asOf / account set).
  const scopeStale = !isExact;
  const updating = sourceStale || scopeStale || deadlineExceeded;
  return {
    mode: updating ? "serve-stale" : "serve-fresh",
    snapshot: served,
    staleScope: scopeStale,
    updating,
    reason: sourceStale ? "source-advanced" : scopeStale ? "scope-fallback" : deadlineExceeded ? "rebuild-deadline" : "fresh",
  };
}
