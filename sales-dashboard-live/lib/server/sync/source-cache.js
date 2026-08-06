// Scheduler v2 Phase 1c — ATOMIC last-known-good source storage.
//
// The shared v1 cache (lib/server/supabase.js saveSourceExportCache) overwrites a
// STABLE object path before its Postgres pointer is updated, so a failed metadata write
// after the upload strands the old payload. This module writes every payload to a NEW
// immutable, versioned object and only switches the source_export_cache pointer AFTER the
// upload succeeds — so the previous good object is never destroyed by a partial save.
// The old object is pruned only after the new pointer is committed.
//
// Injected adapters keep it fully offline-testable:
//   storage:  { put(path, string) , get(path) -> {rows}|null , delete(path) }
//   metadata: { read(requestHash) -> { object_path }|null , write(entry) -> row }

// A DataDoe payload MUST be a real array. A missing / object / string payload is a
// failure — never coerced to []. An empty array is valid ONLY because it genuinely is an
// array (e.g. a source that reported no rows this window).
export function validateSourcePayload(rows) {
  if (!Array.isArray(rows)) {
    throw new Error("DataDoe payload is not an array; refusing to save it as a source result.");
  }
  return rows;
}

// Build the immutable versioned object path. Every save gets a distinct path
// (…/<hash>/<version>.json), so a new upload can never overwrite the previous good one.
export function versionedObjectPath(requestHash, version) {
  const safeHash = String(requestHash);
  const safeVersion = String(version);
  return `source-cache/v2/${safeHash.slice(0, 2)}/${safeHash}/${safeVersion}.json`;
}

/**
 * Atomically publish a source payload as the new last-known-good.
 *
 * Order: read old pointer -> upload NEW immutable object -> switch pointer -> READ BACK to
 * positively confirm -> prune OLD only after confirmation.
 *
 * Ambiguity safety (a metadata write can time out AFTER Postgres commits): the newly
 * uploaded immutable object is NEVER deleted here, because the pointer may already point at
 * it. A left-behind object is a harmless orphan that a later prune pass reclaims — losing a
 * committed pointer's object is not. The OLD object is pruned ONLY after a read-back
 * positively confirms the pointer now points at the new object. If the switch cannot be
 * confirmed, the previous last-known-good object + pointer are left intact and readable and
 * the caller sees a persist failure.
 *
 * A successful save REQUIRES a positively confirmed, non-empty object path.
 */
export async function atomicSaveSourcePayload({
  storage, metadata, requestHash, sourceId, organizationFingerprint,
  accountScopeHash, requestMeta, rows, payloadBytes, expiresAt, version,
}) {
  validateSourcePayload(rows);
  if (!version) throw new Error("atomicSaveSourcePayload requires a unique version token.");
  if (!requestHash) throw new Error("atomicSaveSourcePayload requires a request hash.");

  const newPath = versionedObjectPath(requestHash, version);
  // 1) The current pointer (previous good object), read BEFORE we change anything.
  const previous = await metadata.read(requestHash).catch(() => null);
  const previousPath = previous && previous.object_path ? previous.object_path : null;

  // 2) Upload the NEW immutable object. The old object is untouched.
  await storage.put(newPath, JSON.stringify({ rows }));

  // 3) Switch the pointer. The response may be AMBIGUOUS (commit + a dropped connection),
  //    so we never treat a throw as "not committed" — we confirm by reading it back.
  let saved = null;
  try {
    saved = await metadata.write({
      requestHash, sourceId, organizationFingerprint, accountScopeHash, requestMeta,
      objectPath: newPath, rowCount: rows.length, payloadBytes, expiresAt,
    });
  } catch (_ambiguous) {
    saved = null; // DB may or may not have committed; do NOT delete newPath.
  }

  // 4) Positively confirm the committed pointer with a read-back.
  const confirmed = await metadata.read(requestHash).catch(() => null);
  const confirmedPath = confirmed && confirmed.object_path ? confirmed.object_path : null;

  if (confirmedPath === newPath) {
    // Our switch is confirmed: safe to prune the previous object.
    if (previousPath && previousPath !== newPath) {
      await Promise.resolve(storage.delete(previousPath)).catch(() => {});
    }
    return newPath;
  }
  if (confirmedPath && confirmedPath !== previousPath) {
    // A CONCURRENT cycle committed a different new version for this request_hash. Its object
    // is the live pointer; ours is a harmless orphan (left for later cleanup). Never delete
    // the concurrent winner or our orphan here.
    return confirmedPath;
  }
  // Unconfirmed: the pointer still shows the previous object (or is unreadable). Leave the
  // new object as an orphan, keep the previous last-known-good intact, and fail closed so
  // the worker records a persist failure without overwriting good data.
  throw new Error("Source cache pointer switch was not positively confirmed; preserved previous last-known-good.");
}
