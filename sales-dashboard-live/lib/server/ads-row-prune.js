// BOUNDED, VERIFIED prune of ONE account's reduced-grain Ads rows (asin-performance-v1) after the fresh window was
// upserted. Pure orchestration over two injected transport calls so it is unit-testable without a database:
//   probeStale(day)  -> true when at least one row of that day was NOT refreshed by this run (source_refreshed_at absent
//                       or different from the run's stamp), false when none is left; THROWS when unreadable.
//   deleteStale(day) -> DELETE exactly those rows of that day; THROWS on failure (commit state unknown).
// Why per day (2026-10-07 India, AAKRITI): ONE window-wide DELETE (~25k rows, 21 days) ran into the 8 s PostgREST
// statement timeout right after the same rows were upserted, and the failure discarded its status/code. A day is a
// small, bounded statement (one lookup-index range), so the work per statement no longer grows with the window.
// Rules, per day:
//   * A DELETE is skipped ONLY when the probe PROVES no stale row exists for that day. An unreadable probe never skips.
//   * A failed DELETE is retried ONCE when the error is transient (statement/lock timeout, serialization, connection,
//     5xx/408/429, network). The predicate is stamp-based, so a retry (or a commit that did land) is idempotent.
//   * After a DELETE that still failed, the day is re-probed: no stale row left = the delete committed or became
//     unnecessary -> the day is clean. Anything else is a typed failure and the prune stops (no further statements).
// Errors keep ONLY a sanitized HTTP status and PostgREST/Postgres code -- never a message, row value or credential.

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const ADS_PRUNE_MAX_DAYS = 400;
export const ADS_PRUNE_RETRY_DELAY_MS = 1500;

// Postgres SQLSTATEs / PostgREST codes that describe a transient condition, not a bad request.
const RETRYABLE_PG_CODES = new Set([
  "57014", // query_canceled (statement_timeout)
  "55P03", // lock_not_available (lock_timeout)
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "53300", // too_many_connections
  "57P01", "57P02", "57P03", // admin/crash shutdown, cannot connect now
  "08000", "08001", "08003", "08004", "08006", // connection exceptions
  "PGRST000", "PGRST001", "PGRST002", "PGRST003", // PostgREST: db connection / pool / schema cache / pool timeout
]);
const RETRYABLE_HTTP = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

/** PURE: the sanitized diagnostic of a thrown Supabase/PostgREST error -- { httpStatus, pgCode, kind } only. */
export function sanitizeAdsWriteError(error) {
  const status = Number(error && error.status);
  const httpStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
  const code = error && typeof error.code === "string" ? error.code.trim() : "";
  const pgCode = /^(?:[0-9A-Z]{5}|PGRST\d{3})$/.test(code) ? code : null;
  const aborted = !!error && (error.name === "AbortError" || error.code === "ABORT_ERR");
  return { httpStatus, pgCode, kind: httpStatus != null ? "http" : (aborted ? "aborted" : "network") };
}

/** PURE: may this sanitized failure be retried once? An intentional abort never is. */
export function isRetryableAdsWriteError(info) {
  if (!info || info.kind === "aborted") return false;
  if (info.pgCode && RETRYABLE_PG_CODES.has(info.pgCode)) return true;
  if (info.httpStatus != null) return RETRYABLE_HTTP.has(info.httpStatus);
  return info.kind === "network";
}

/** PURE: the inclusive list of YYYY-MM-DD days in [from,to], or null for a malformed / oversized window. */
export function pruneDays(from, to, maxDays = ADS_PRUNE_MAX_DAYS) {
  if (!DAY.test(String(from)) || !DAY.test(String(to)) || from > to) return null;
  const out = [];
  for (let d = new Date(`${from}T00:00:00.000Z`); ; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.toISOString().slice(0, 10);
    if (day > to) break;
    out.push(day);
    if (out.length > maxDays) return null;
  }
  return out;
}

/**
 * PURE: the durable, SAFE text of a typed write failure for ads_sync_state.last_error and run summaries, e.g.
 *   "ADS_ROWS_PRUNE_FAILED (stage=delete status=500 pg=57014 stale=present)".
 * Only the typed code and allow-listed slug fields are kept; anything else is dropped.
 */
export function formatAdsWriteFailure(ack, fallbackCode = "ADS_ROWS_PRUNE_FAILED") {
  const a = ack && typeof ack === "object" ? ack : {};
  const code = /^[A-Z][A-Z0-9_]{2,63}$/.test(String(a.error || "")) ? String(a.error) : fallbackCode;
  const parts = [];
  if (/^[a-z]{3,12}$/.test(String(a.stage || ""))) parts.push(`stage=${a.stage}`);
  if (Number.isInteger(a.httpStatus)) parts.push(`status=${a.httpStatus}`);
  if (a.pgCode && /^(?:[0-9A-Z]{5}|PGRST\d{3})$/.test(String(a.pgCode))) parts.push(`pg=${a.pgCode}`);
  if (a.kind === "network" || a.kind === "aborted") parts.push(`transport=${a.kind}`);
  if (a.stale === "present" || a.stale === "unknown") parts.push(`stale=${a.stale}`);
  return parts.length ? `${code} (${parts.join(" ")})` : code;
}

/**
 * Run the bounded, verified prune. Returns a typed ack (never throws for a transport failure):
 *   { write: "ok", error: null, days, deletedDays, skippedDays, verifiedDays }
 *   { write: "write-failed", error: "ADS_ROWS_PRUNE_FAILED", stage, httpStatus, pgCode, kind, stale, day }
 *   { write: "write-failed", error: "ADS_ROWS_PRUNE_BAD_WINDOW" }
 *   { write: "schema-missing", error: "ADS_ROWS_SCHEMA_MISSING" }
 */
export async function pruneAdsWindowVerified({ from, to, probeStale, deleteStale, isSchemaMissing = () => false, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retryDelayMs = ADS_PRUNE_RETRY_DELAY_MS, signal = null } = {}) {
  const days = pruneDays(from, to);
  if (!days || typeof probeStale !== "function" || typeof deleteStale !== "function") return { write: "write-failed", error: "ADS_ROWS_PRUNE_BAD_WINDOW" };
  const fail = (stage, err, stale, day) => ({ write: "write-failed", error: "ADS_ROWS_PRUNE_FAILED", stage, ...(err ? sanitizeAdsWriteError(err) : { httpStatus: null, pgCode: null, kind: null }), stale, day });
  let deletedDays = 0; let skippedDays = 0; let verifiedDays = 0;
  for (const day of days) {
    if (signal && signal.aborted) return fail("probe", { name: "AbortError" }, "unknown", day);
    let stale = null;
    try { stale = (await probeStale(day)) === true; } catch (e) {
      if (isSchemaMissing(e)) return { write: "schema-missing", error: "ADS_ROWS_SCHEMA_MISSING" };
      stale = null; // unreadable -> NOT proven clean -> the delete still runs
    }
    if (stale === false) { skippedDays += 1; continue; }
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try { await deleteStale(day); lastError = null; break; } catch (e) {
        if (isSchemaMissing(e)) return { write: "schema-missing", error: "ADS_ROWS_SCHEMA_MISSING" };
        lastError = e;
        if (attempt === 0 && isRetryableAdsWriteError(sanitizeAdsWriteError(e)) && !(signal && signal.aborted)) { await sleep(retryDelayMs); continue; }
        break;
      }
    }
    if (!lastError) { deletedDays += 1; continue; }
    // The DELETE's commit state is unknown: only a fresh probe proving no stale row is left makes the day clean.
    let after = null;
    try { after = (await probeStale(day)) === true; } catch { after = null; }
    if (after === false) { verifiedDays += 1; continue; }
    return fail("delete", lastError, after === true ? "present" : "unknown", day);
  }
  return { write: "ok", error: null, days: days.length, deletedDays, skippedDays, verifiedDays };
}
