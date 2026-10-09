// CODE-LEVEL SOURCE PAUSE (owner request 2026-10-09): the ONE reversible switch that pauses a DataDoe source.
//
// While a source is listed here NO path may plan, budget or create an export for it: the planners drop its windows,
// the Listing Health v3 ingestion / authorization / ceiling count only the remaining families, the source worker refuses
// a leftover (pre-pause frozen) job before any claim / reservation / POST, createExport refuses its id before
// authorization or any network call, and the admin Data Sync Center + sample probe refuse it with a typed 409. Saved
// data for it stays STORED and READABLE (never deleted or rewritten) but is never presented as current while paused.
//
// Paused: Listings (Raw JSON) ("listings-raw"). Its Amazon issue / buyable / discoverable / live-offer details are
// shown as UNAVAILABLE (with the paused reason below) -- never as "zero issues". The canonical Listings export
// ("listings", ba689c05...) is NOT paused and is unchanged.
//
// This is DISTINCT from the database operator pause (source_controls.paused, code SOURCE_PAUSED, retryable, a
// per-family operator toggle): a code-level pause is non-retryable and is read by every planner / budget / derive.
//
// ROLLBACK: empty BOTH lists below (or revert the change). Nothing else stores the pause (no migration, no DB row).
// Pure leaf module (no imports). 7-bit ASCII, LF.

export const PAUSED_SOURCE_KEYS = Object.freeze(["listings-raw"]);
// Lowercase full DataDoe source ids of the paused families (the matcher below also accepts a >= 10-char prefix).
export const PAUSED_DATADOE_SOURCE_IDS = Object.freeze(["6ea445cdc459f9fbb9517c5c009384da60ef31a1e70d4de9187ea3d4c28535c4"]);

export const SOURCE_CODE_PAUSED_ERROR_CODE = "LISTINGS_RAW_PAUSED";
export const PAUSED_SOURCE_MESSAGE = "Listings (Raw JSON) is paused: Amazon issue, buyable, discoverable and live-offer details are unavailable while it is paused. No export was created.";
// The Listing Health "issues unavailable" wording while paused (replaces the DataDoe "enable Listings (Raw JSON)" hint,
// which would be misleading: the table is enabled, the application has paused it).
export const LISTINGS_RAW_PAUSED_REASON_CODE = "listings-raw-paused";
export const LISTINGS_RAW_PAUSED_ISSUES_REASON = "Listings (Raw JSON) is paused: Amazon issue, buyable, discoverable and live-offer checks are unavailable (not zero). Listings-based checks (status, price, stock) still apply.";

const norm = (v) => String(v == null ? "" : v).trim().toLowerCase();

// The ACTIVE pause lists every helper reads. Production = the frozen lists above. An OFFLINE TEST may swap them through
// __setSourcePauseForTests (e.g. to keep exercising the Raw fold / persistence code the pause bypasses) and MUST restore
// them with __resetSourcePauseForTests. Every pause-aware module reads these lazily (never a value cached at import).
let activeKeys = PAUSED_SOURCE_KEYS;
let activeIds = PAUSED_DATADOE_SOURCE_IDS;
export function __setSourcePauseForTests({ sourceKeys = [], sourceIds = [] } = {}) {
  activeKeys = Object.freeze([...sourceKeys].map(norm));
  activeIds = Object.freeze([...sourceIds].map(norm));
}
export function __resetSourcePauseForTests() {
  activeKeys = PAUSED_SOURCE_KEYS;
  activeIds = PAUSED_DATADOE_SOURCE_IDS;
}
export function pausedSourceKeys() { return [...activeKeys]; }

export function isPausedSourceKey(sourceKey) {
  const k = norm(sourceKey);
  return !!k && activeKeys.includes(k);
}

// Exact id, or a >= 10-char prefix of a paused id; trimmed + lowercased (the SAME matcher shape as
// isRetiredDataDoeSourceId). A shorter prefix never identifies a source.
export function isPausedDataDoeSourceId(sourceId) {
  const id = norm(sourceId);
  if (!id) return false;
  return activeIds.some((p) => p === id || (id.length >= 10 && p.startsWith(id)));
}

export function isPausedSourceError(error) {
  return !!error && error.code === SOURCE_CODE_PAUSED_ERROR_CODE;
}

export function pausedSourceError() {
  const err = new Error(PAUSED_SOURCE_MESSAGE);
  err.code = SOURCE_CODE_PAUSED_ERROR_CODE;
  err.status = 409;
  err.retryable = false;
  return err;
}

// Throws the typed, non-retryable 409 for a paused DataDoe source id; a no-op for every other id.
export function assertSourceNotPaused(sourceId) {
  if (isPausedDataDoeSourceId(sourceId)) throw pausedSourceError();
}

// Convenience: true while Listings (Raw JSON) is paused (the Listing Health truthfulness branches read this; a
// function, never a cached constant, so the offline test seam reaches every caller).
export function isListingsRawPaused() { return isPausedSourceKey("listings-raw"); }
