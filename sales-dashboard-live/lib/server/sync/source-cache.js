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
 * Order: read old pointer -> upload NEW immutable object -> switch pointer -> prune OLD.
 * A pointer-write failure deletes the NEW orphan and leaves the OLD object + metadata
 * intact and readable. A successful save REQUIRES a non-empty object path.
 * Returns the committed object path.
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
  const previous = await metadata.read(requestHash);
  const previousPath = previous && previous.object_path ? previous.object_path : null;

  // 2) Upload the NEW immutable object. The old object is untouched.
  await storage.put(newPath, JSON.stringify({ rows }));

  // 3) Switch the pointer to the new object ONLY after the upload succeeds. If this
  //    fails, remove the new orphan and preserve the old object + metadata.
  let saved;
  try {
    saved = await metadata.write({
      requestHash, sourceId, organizationFingerprint, accountScopeHash, requestMeta,
      objectPath: newPath, rowCount: rows.length, payloadBytes, expiresAt,
    });
  } catch (error) {
    await Promise.resolve(storage.delete(newPath)).catch(() => {});
    throw error;
  }
  if (!saved || !saved.object_path) {
    await Promise.resolve(storage.delete(newPath)).catch(() => {});
    throw new Error("Source cache pointer did not persist an object path.");
  }

  // 4) Prune the OLD object only after the new pointer is committed.
  if (previousPath && previousPath !== newPath) {
    await Promise.resolve(storage.delete(previousPath)).catch(() => {});
  }
  return saved.object_path;
}
