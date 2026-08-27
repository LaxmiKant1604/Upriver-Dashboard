// Scheduler v2 -- PURE resolution of the ACTIVE cycle ATTEMPT for a (bucket, cycle_date) slot (ZERO I/O).
//
// With the superseding-attempt model (20260830) a stale terminal cycle may be SUPERSEDED by a new running attempt
// on the same slot. The ACTIVE attempt is the HEAD of the supersession chain -- the cycle that NO other cycle
// supersedes. A well-formed slot has exactly one head; a fork (two heads) or a headless chain (every row superseded)
// is corruption and FAILS CLOSED. The historical superseded cycles stay in the rows but are never returned as active.

const S = (v) => (v == null ? "" : String(v));

/**
 * Resolve the active (non-superseded) head from the rows of a single (bucket, cycle_date). Returns the head row,
 * null when there are no rows, or throws on an ambiguous fork / headless chain (fail closed). Never chooses "latest".
 */
export function resolveActiveCycleHead(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];
  const superseded = new Set(
    list.map((r) => (r && r.supersedes_cycle_id != null ? S(r.supersedes_cycle_id) : null)).filter(Boolean),
  );
  const heads = list.filter((r) => !superseded.has(S(r && r.id)));
  if (heads.length === 0) throw new Error("resolveActiveCycleHead: supersession chain has no active head; failing closed.");
  if (heads.length > 1) throw new Error("resolveActiveCycleHead: more than one active (non-superseded) cycle for the slot; failing closed.");
  return heads[0];
}
