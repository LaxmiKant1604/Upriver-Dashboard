// Shared report snapshot limits -- a DEPENDENCY-FREE leaf (imports nothing).
//
// One source of truth for the payload-size ceiling so every write path (the interactive
// report-store, the Scheduler v2 report worker, and the shadow snapshot saver) enforces the
// SAME limit and a pure worker never has to import Supabase to know it.

// Canonical shared-snapshot payload ceiling (8 MB). Do NOT redefine this value anywhere else.
export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

// Authoritative UTF-8 byte size of a snapshot payload, recomputed from JSON.stringify. This is
// what the storage boundary MUST validate against -- never a caller-supplied byte count (which
// may be stale, understated, or forged and is only telemetry). A payload that cannot be
// serialized returns Infinity so it fails the limit check (never silently saved).
export function snapshotByteSize(payload) {
  try { return Buffer.byteLength(JSON.stringify(payload ?? null)); } catch { return Infinity; }
}

// Throw (code SNAPSHOT_TOO_LARGE) when the RECOMPUTED payload exceeds the limit; otherwise
// return the actual byte size. Callers use the returned value as the trustworthy byte count.
export function assertSnapshotWithinLimit(payload, maxBytes = MAX_SNAPSHOT_BYTES) {
  const bytes = snapshotByteSize(payload);
  if (bytes > maxBytes) {
    const error = new Error(`Snapshot payload ${(bytes / (1024 * 1024)).toFixed(1)} MB exceeds the ${maxBytes / (1024 * 1024)} MB limit; not saved.`);
    error.code = "SNAPSHOT_TOO_LARGE";
    error.actualBytes = bytes;
    throw error;
  }
  return bytes;
}
