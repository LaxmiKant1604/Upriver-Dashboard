// Publication recovery WP15 -- the DB-ENFORCED REPORT WRITER FENCE: pure helpers, ONE read-only fence-row reader and the
// REPORT_WRITER_FENCED error classifier.
//
// WHY. An unconditional code cutover does not stop an ALREADY-RUNNING old scheduler job (or any stale code path: a
// refresh=1 builder, a backfill script, the retired brand-inventory rebuild) from writing a route-owned live report key.
// Migration 20260935 therefore enforces the fence IN THE DATABASE: a BEFORE INSERT/UPDATE/DELETE (+ TRUNCATE) trigger on
// public.report_snapshots rejects every write of a report_key whose public.report_publication_writer_fence row has
// fenced_only = true, UNLESS the writing transaction was marked by the fenced CAS itself
// (public.cas_report_snapshot_if_newer_fenced runs a TRANSACTION-LOCAL set_config('app.report_publication_fenced', 'on',
// true) only AFTER its control-plane lease/generation fence passed). Flipping fenced_only is ONE approved UPDATE that is
// instant for every connection, so an in-flight old writer's NEXT write fails closed with SQLSTATE RWF01 and message
// 'REPORT_WRITER_FENCED:<key>' -- and the live row it would have replaced stays byte-identical (last-known-good).
//
// THIS MODULE never writes anything. It provides:
//   * the contract constants shared with the migration (tests pin them to the SQL text);
//   * classifyReportWriterError(err): recognises the rejection from BOTH transports -- a node-postgres error
//     ({ code: 'RWF01', message: 'REPORT_WRITER_FENCED:<key>' }) and a supabase.js request() error
//     ({ status: 400, code: 'RWF01', message: 'Supabase request failed (400): REPORT_WRITER_FENCED:<key>' }), also when
//     wrapped in an Error `cause` chain -- and returns a TYPED 'writer-fenced' verdict (LKG preserved, never retryable,
//     never a generic failure). Legacy writers that are still reachable log THIS instead of a generic error;
//   * readReportWriterFence(query): a READ-ONLY reader of the fence rows through an injected query function (the worker's
//     pg pool or any `(sql) => rows | { rows }`), fail-closed on malformed rows, 'absent' when 20260935 is not applied;
//   * fenceStatusSummary / fenceStateForKey: the redacted per-key fence state the worker status surfaces.
//
// A report key NOT in the fence table (or seeded with fenced_only = false) is unaffected; scheduler-v2/* shadow keys can
// never be fenced (a CHECK constraint forbids seeding them), so the unfenced shadow CAS keeps working. 7-bit ASCII, LF.

export const REPORT_WRITER_FENCE_TABLE = "report_publication_writer_fence";
// The transaction-local GUC the fenced CAS sets after its lease/generation fence passes. NOTHING else may set it: the
// writer-fence test fails if any lib/, api/, scripts/ or src/ file other than this contract module names it.
export const REPORT_WRITER_FENCE_SETTING = "app.report_publication_fenced";
export const REPORT_WRITER_FENCE_SETTING_ON = "on";
// The DEDICATED SQLSTATE of the rejection. Class 'RW' is not mapped by PostgREST, so a REST write surfaces as HTTP 400
// with this code; node-postgres surfaces it as err.code.
export const REPORT_WRITER_FENCED_SQLSTATE = "RWF01";
export const REPORT_WRITER_FENCED_PREFIX = "REPORT_WRITER_FENCED:";
// The typed event a legacy writer logs when the fence rejects it (never a generic failure).
export const REPORT_WRITER_FENCED_EVENT = "writer-fenced";
// The key a TRUNCATE rejection names (a statement-level trigger has no row key).
export const REPORT_WRITER_FENCED_ALL_KEYS = "*";
export const SHADOW_REPORT_KEY_PREFIX = "scheduler-v2/";
// The ROUTE-OWNED live report keys 20260935 seeds (every row fenced_only = false). Pinned to the migration's seed by
// scripts/report-writer-fence.test.js; flipping a key to true is a separate, owner-approved UPDATE per key.
export const FENCED_WRITER_REPORT_KEYS = Object.freeze([
  "brand-sales", "daily-reporting", "brand-inventory", "listing-health-v3", "fba-plan",
  "sku-movement", "returns-leakage", "brand-view", "brand-view-portfolio", "brand-view-brands",
]);
// The ONE read the reader issues (read-only; dates as TEXT -- never parsed through a local-timezone JS Date).
export const REPORT_WRITER_FENCE_READ_SQL = "select report_key, fenced_only, updated_at::text as updated_at, updated_by "
  + "from public.report_publication_writer_fence order by report_key";

const MAX_KEY_CHARS = 200;
const MAX_CAUSE_DEPTH = 6;
// The token after the prefix (up to whitespace / a quote / a delimiter). It is echoed as reportKey ONLY when it is the
// TRUNCATE marker '*' or a fenceable key; anything else (a shadow key, garbage) is reported as reportKey null.
const FENCED_KEY_IN_MESSAGE_RE = /REPORT_WRITER_FENCED:([^\s"'`,;)]{1,200})/;

const isObj = (v) => v !== null && typeof v === "object";

export function isShadowReportKey(key) {
  return typeof key === "string" && key.startsWith(SHADOW_REPORT_KEY_PREFIX);
}

/** A report_key the fence table can hold: a nonblank, untrimmed-equal string <= 200 chars that is NOT a shadow key. */
export function isFenceableReportKey(key) {
  return typeof key === "string" && key.trim() !== "" && key === key.trim() && key.length <= MAX_KEY_CHARS && !isShadowReportKey(key);
}

export function isSeededFenceKey(key) {
  return FENCED_WRITER_REPORT_KEYS.includes(key);
}

// One error object's own fence evidence (no cause walk): the SQLSTATE and/or the message prefix.
function ownFenceEvidence(err) {
  if (err == null) return null;
  const message = typeof err === "string" ? err : (isObj(err) && typeof err.message === "string" ? err.message : "");
  const code = isObj(err) && typeof err.code === "string" ? err.code : null;
  const byCode = code === REPORT_WRITER_FENCED_SQLSTATE;
  const m = message.match(FENCED_KEY_IN_MESSAGE_RE);
  if (!byCode && !m) return null;
  const key = m ? m[1] : null;
  return { reportKey: key === REPORT_WRITER_FENCED_ALL_KEYS || isFenceableReportKey(key) ? key : null, sqlstate: byCode ? code : null };
}

/**
 * Classify ANY error a report_snapshots writer caught. Returns
 *   { fenced: true, event: 'writer-fenced', reportKey: <key> | '*' | null, sqlstate: 'RWF01' | null, reason, lkgPreserved: true, retryable: false }
 * when the database writer fence rejected the write (the live row is untouched), else { fenced: false }. Walks the
 * `cause` chain (bounded) so a wrapper error that preserved the database error is still recognised. Never throws.
 */
export function classifyReportWriterError(error) {
  let cur = error;
  const seen = new Set();
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cur != null && !seen.has(cur); depth += 1) {
    if (isObj(cur)) seen.add(cur);
    const ev = ownFenceEvidence(cur);
    if (ev) {
      return {
        fenced: true,
        event: REPORT_WRITER_FENCED_EVENT,
        reportKey: ev.reportKey,
        sqlstate: ev.sqlstate,
        reason: REPORT_WRITER_FENCED_EVENT + ":" + (ev.reportKey || "unknown"),
        lkgPreserved: true,
        retryable: false,
      };
    }
    cur = isObj(cur) ? cur.cause : null;
  }
  return { fenced: false };
}

export function isReportWriterFencedError(error) {
  return classifyReportWriterError(error).fenced === true;
}

/**
 * The typed, REDACTED log event a legacy writer emits when the fence rejected it: only the event name, the fenced key,
 * the writer label (a code-supplied constant), an optional account id and the SQLSTATE -- never a payload, a message
 * body or a credential. Returns null when `error` is not a writer-fence rejection (the caller keeps its own handling).
 */
export function writerFencedEvent({ error, writer = null, reportKey = null, accountId = null } = {}) {
  const c = classifyReportWriterError(error);
  if (!c.fenced) return null;
  const label = (v) => (typeof v === "string" && /^[A-Za-z0-9_.:/-]{1,120}$/.test(v) ? v : null);
  return {
    event: REPORT_WRITER_FENCED_EVENT,
    reportKey: c.reportKey || label(reportKey),
    writer: label(writer),
    accountId: label(accountId),
    sqlstate: c.sqlstate || REPORT_WRITER_FENCED_SQLSTATE,
    lkgPreserved: true,
  };
}

/**
 * Validate fence rows FAIL-CLOSED. Accepts snake_case (SQL / REST) rows. A row whose key is not fenceable, whose
 * fenced_only is not a real boolean, or a duplicate key is a problem; the caller treats any problem as 'invalid' (never
 * as "open"). Returns { rows: [{ reportKey, fencedOnly, updatedAt, updatedBy }], problems: [string] }.
 */
export function normalizeFenceRows(rows) {
  const out = []; const problems = []; const seen = new Set();
  if (!Array.isArray(rows)) return { rows: out, problems: ["rows-not-array"] };
  for (const r of rows) {
    const key = isObj(r) ? r.report_key : undefined;
    if (!isFenceableReportKey(key)) { problems.push("bad-report-key"); continue; }
    if (seen.has(key)) { problems.push("duplicate:" + key); continue; }
    seen.add(key);
    if (typeof r.fenced_only !== "boolean") { problems.push("bad-fenced-only:" + key); continue; }
    out.push({
      reportKey: key,
      fencedOnly: r.fenced_only,
      updatedAt: typeof r.updated_at === "string" ? r.updated_at : null,
      updatedBy: typeof r.updated_by === "string" ? r.updated_by.slice(0, 200) : null,
    });
  }
  return { rows: out.sort((a, b) => (a.reportKey < b.reportKey ? -1 : a.reportKey > b.reportKey ? 1 : 0)), problems };
}

// The 'invalid' problem for an empty read (see readReportWriterFence).
export const NO_ROWS_VISIBLE = "no-rows-visible";

const isMissingRelation = (err) => isObj(err) && (err.code === "42P01" || err.code === "PGRST205"
  || /relation .*report_publication_writer_fence.* does not exist/i.test(String(err.message || "")));

/**
 * READ-ONLY fence reader. `query` is injected: `(sql) => rows | { rows }` (a pg client/pool `.query` bound, or a test
 * fake). Exactly ONE statement (REPORT_WRITER_FENCE_READ_SQL) is issued. Returns
 *   { state: 'ok',        rows, fencedKeys, openKeys, missingKeys, extraKeys }
 *   { state: 'invalid',   rows, problems, ... }        (malformed rows, or ZERO visible rows ('no-rows-visible': the
 *                                                        seed guarantees 10) -> fail closed: never reported as open)
 *   { state: 'absent' }                                 (20260935 not applied: relation missing)
 *   { state: 'unreadable', code }                       (transport / permission / any other error; code only)
 * fencedKeys = rows with fenced_only true; openKeys = rows false; missingKeys = seeded keys with no row; extraKeys = rows
 * outside the seeded set (an owner may fence another key; reported, not rejected).
 */
export async function readReportWriterFence(query) {
  if (typeof query !== "function") return { state: "unreadable", code: "no-query" };
  let res;
  try {
    res = await query(REPORT_WRITER_FENCE_READ_SQL);
  } catch (err) {
    if (isMissingRelation(err)) return { state: "absent" };
    return { state: "unreadable", code: isObj(err) && typeof err.code === "string" ? err.code.slice(0, 16) : "error" };
  }
  const raw = Array.isArray(res) ? res : (isObj(res) && Array.isArray(res.rows) ? res.rows : null);
  const { rows, problems } = normalizeFenceRows(raw);
  // ZERO visible rows is never a clean read: 20260935 seeds all 10 keys, so an empty result means the reader cannot
  // see the table (RLS with no policy returns zero rows to a role without BYPASSRLS, instead of an error) or the seed
  // was removed. Fail closed: 'invalid', every key 'unknown' -- never reported as 'ok' / open.
  if (Array.isArray(raw) && raw.length === 0) problems.push(NO_ROWS_VISIBLE);
  const present = new Set(rows.map((r) => r.reportKey));
  const view = {
    rows,
    fencedKeys: rows.filter((r) => r.fencedOnly).map((r) => r.reportKey),
    openKeys: rows.filter((r) => !r.fencedOnly).map((r) => r.reportKey),
    missingKeys: FENCED_WRITER_REPORT_KEYS.filter((k) => !present.has(k)),
    extraKeys: rows.map((r) => r.reportKey).filter((k) => !isSeededFenceKey(k)),
  };
  if (problems.length) return { state: "invalid", problems, ...view };
  return { state: "ok", ...view };
}

/**
 * The per-key fence state: 'fenced' | 'open' | 'unknown'. 'unknown' whenever the read is not a clean 'ok' (absent /
 * unreadable / invalid) or the key has no row -- a status surface must never claim a key is open or fenced unproven.
 */
export function fenceStateForKey(result, reportKey) {
  if (!isObj(result) || result.state !== "ok" || !Array.isArray(result.rows)) return "unknown";
  const row = result.rows.find((r) => r.reportKey === reportKey);
  if (!row) return "unknown";
  return row.fencedOnly ? "fenced" : "open";
}

/**
 * The REDACTED fence summary for the worker status / health surfaces (WP12): the read state plus the key lists, and
 * `allSeededFenced` true only when EVERY seeded route-owned key is proven fenced. No timestamps of other tables, no SQL.
 */
export function fenceStatusSummary(result) {
  const state = isObj(result) && typeof result.state === "string" ? result.state : "unreadable";
  const pick = (k) => (isObj(result) && Array.isArray(result[k]) ? [...result[k]] : []);
  const perKey = {};
  for (const k of FENCED_WRITER_REPORT_KEYS) perKey[k] = fenceStateForKey(result, k);
  return {
    state,
    fencedKeys: pick("fencedKeys"),
    openKeys: pick("openKeys"),
    missingKeys: state === "ok" || state === "invalid" ? pick("missingKeys") : [...FENCED_WRITER_REPORT_KEYS],
    extraKeys: pick("extraKeys"),
    perKey,
    allSeededFenced: FENCED_WRITER_REPORT_KEYS.every((k) => perKey[k] === "fenced"),
    ...(isObj(result) && typeof result.code === "string" ? { code: result.code } : {}),
    ...(isObj(result) && Array.isArray(result.problems) ? { problems: result.problems.slice(0, 20) } : {}),
  };
}
