// Opt-in, machine-readable per-account output for the four zero-export reconciler CLIs (--emit-targets).
//
// The CLIs' RESULT line carries only aggregate counts; an external consumer (the independent publication recovery
// worker) needs the exact per-(account, report) state the shared core already computed. This formats the core's
// summary.perAccount into ONE `TARGETS {json}` line. It is ADDITIVE: the CLIs print it ONLY when --emit-targets is
// passed, so every existing invocation (workflows, scheduler hooks, operators) is byte-identical.
//
// SAFE BY CONSTRUCTION: only account ids, the revision id/status, and per-report {state, reason CODE} are emitted -- no
// payload, row, credential, SQL, or Amazon data. A reason is reduced to its stable machine code (allowed characters
// [A-Za-z0-9_.:-] only, truncated at the first disallowed character, max 120 chars), so a free-text error message can
// never leak through.
//
// TARGETS v2 (publication recovery WP3; OPT-IN via formatTargetsLine({ ..., v: 2 }) -- the four existing CLIs keep
// emitting v1 byte-identically): one entry per scope TARGET (the job target key: an account id, or 'region:<r>') with
// its owners, its evaluated evidence token and its UNITS -- { u: unit key ('-' | 'ALL' | sha12(brand)), rk, s, r, asOf,
// h, sra, served }. A unit's targetId (which may carry brand text) is NEVER emitted. The line is bounded to
// TARGETS_MAX_LINE_BYTES by dropping WHOLE targets (never a partial unit set a consumer could misread as "all units
// current"), flagged truncated:true + omittedTargets:n. parseTargetsLine accepts v1 and v2; normalizeTargets lifts a v1
// line into the v2 shape (one unit per report, u '-') so a consumer handles a single shape. A target with NO unit rows
// (e.g. an empty unit expansion, the core's rec.unitsReason 'units-empty') carries r:'units-empty' EXPLICITLY -- a
// consumer must treat an empty unit list as NOT verified (nothing was proven current). Owners are filtered by
// TARGETS_OWNER_ID_RE, the SAME grammar the reconciler core enforces on every unit owner (ROUTE_OWNER_ID_RE), so an owner
// a unit opened controls for is never missing from the line.

export const TARGETS_LINE_PREFIX = "TARGETS ";
export const TARGETS_FORMAT_VERSION = 1;
export const TARGETS_FORMAT_VERSION_V2 = 2;
export const TARGETS_MAX_LINE_BYTES = 256 * 1024;

const S = (v) => (v == null ? "" : String(v));
// The job target key grammar (the recovery jobs' target_key CHECK) + a rollout-owner id (no ':'). The owner grammar is
// exported so the reconciler core's ROUTE_OWNER_ID_RE can be pinned IDENTICAL to it (saved-data-reconciler-routes.test).
const TARGET_ID_RE = /^[A-Za-z0-9._:-]{1,160}$/;
export const TARGETS_OWNER_ID_RE = /^[A-Za-z0-9._-]{1,120}$/;
const OWNER_ID_RE = TARGETS_OWNER_ID_RE;
// The explicit target-level mark of an EMPTY unit list (equal to the core's UNITS_EMPTY_REASON).
export const TARGETS_UNITS_EMPTY = "units-empty";
const UNIT_KEY_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const CODE_RE = /^[A-Za-z0-9._:-]+$/;
const ISO_RE = /^[0-9TZ:.+-]{1,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PRINTABLE_RE = /^[\x21-\x7e]+$/;
// A bounded machine code (whole value must match; never truncated into a different identity) or null.
const machineCode = (v, max) => { const s = S(v); return s && s.length <= max && CODE_RE.test(s) ? s : null; };
const utf8Bytes = (s) => new TextEncoder().encode(s).length;

/** Reduce a free-form reason to its stable machine code (e.g. "controls-not-opened:CONTROL_LEASE_HELD"). */
export function sanitizeReasonCode(reason) {
  const s = S(reason).trim();
  if (!s) return null;
  const m = s.match(/^[A-Za-z0-9_.:-]+/);
  const code = m ? m[0].slice(0, 120) : "";
  return code || "unclassified";
}

/**
 * Build the TARGETS payload from a saved-data-reconciler summary. `family` is the CLI's family id
 * (oli | fba | ads | listings). Pure; never throws on a malformed summary (it emits what it can prove).
 */
export function buildTargetsPayload({ family, summary }) {
  const out = summary && typeof summary === "object" ? summary : {};
  const accounts = [];
  for (const rec of Array.isArray(out.perAccount) ? out.perAccount : []) {
    if (!rec || !S(rec.accountId)) continue;
    const reports = {};
    for (const [rk, v] of Object.entries(rec.reports && typeof rec.reports === "object" ? rec.reports : {})) {
      reports[rk] = { s: S(v && v.state) || "UNKNOWN", r: sanitizeReasonCode(v && v.reason) };
    }
    accounts.push({ id: S(rec.accountId), eligible: rec.eligible === true, rev: rec.revisionId ? S(rec.revisionId).slice(0, 64) : null, status: rec.status ? sanitizeReasonCode(rec.status) : null, reports });
  }
  return {
    v: TARGETS_FORMAT_VERSION,
    family: S(family),
    bucket: S(out.bucket),
    requestedAsOf: S(out.requestedAsOf),
    dryRun: out.dryRun === true,
    outcome: S(out.outcome) || null,
    code: S(out.code) || null,
    dataDoeCreates: Number(out.dataDoeCreates || 0),
    dataDoeTokens: Number(out.dataDoeTokens || 0),
    controlCleanupUnresolved: out.controlCleanupUnresolved === true,
    accounts,
  };
}

// ---- v2 --------------------------------------------------------------------------------------------------------------
// One unit row per (unit, report) of a summary record. A record WITHOUT units[] (a pre-hook summary) is its own single
// default unit '-' at the run's as-of.
function v2UnitRows(rec, epoch) {
  const units = Array.isArray(rec.units) ? rec.units : [{ unitKey: "-", targetAsOf: epoch, reports: rec.reports }];
  const rows = [];
  for (const unit of units) {
    if (!unit || typeof unit !== "object") continue;
    const u = UNIT_KEY_RE.test(S(unit.unitKey)) ? S(unit.unitKey) : null;
    if (!u) return null; // an unrepresentable unit key -> the WHOLE target is omitted (never a partial unit set)
    const asOf = DATE_RE.test(S(unit.targetAsOf)) ? S(unit.targetAsOf) : null;
    for (const [rk, v] of Object.entries(unit.reports && typeof unit.reports === "object" ? unit.reports : {})) {
      const sv = v && v.served && typeof v.served === "object" ? v.served : null;
      rows.push({
        u, rk: machineCode(rk, 120) || "invalid-report-key",
        s: machineCode(v && v.state, 40) || "UNKNOWN",
        r: sanitizeReasonCode(v && v.reason),
        asOf,
        h: machineCode(v && v.h, 128),
        sra: ISO_RE.test(S(v && v.sra)) ? S(v.sra) : null,
        served: sv ? { id: machineCode(sv.id, 64), h: machineCode(sv.h, 128), sra: ISO_RE.test(S(sv.sra)) ? S(sv.sra) : null } : null,
      });
    }
  }
  return rows;
}

// The target's owners: the record's owner union (or its units' owners), else the target itself; only canonical
// rollout ids survive (a 'region:<r>' scope id is never an owner).
function v2Owners(rec, id) {
  const raw = Array.isArray(rec.ownerAccountIds) ? rec.ownerAccountIds
    : (Array.isArray(rec.units) ? rec.units.flatMap((u) => (u && Array.isArray(u.ownerAccountIds) ? u.ownerAccountIds : [])) : [id]);
  return [...new Set(raw.map(S).filter((o) => OWNER_ID_RE.test(o)))].sort();
}

/**
 * Build the TARGETS v2 payload from a saved-data-reconciler summary (with or without units[]). `route` (alias `family`)
 * is the route id. Pure; never throws; bounded to TARGETS_MAX_LINE_BYTES by dropping whole targets from the END
 * (truncated:true + omittedTargets). A target whose id is not a valid job target key is omitted (counted).
 */
export function buildTargetsPayloadV2({ route, family, summary }) {
  const out = summary && typeof summary === "object" ? summary : {};
  const epoch = S(out.requestedAsOf);
  const targets = [];
  let omitted = 0;
  for (const rec of Array.isArray(out.perAccount) ? out.perAccount : []) {
    if (!rec || typeof rec !== "object") continue;
    const id = S(rec.accountId);
    const units = TARGET_ID_RE.test(id) ? v2UnitRows(rec, epoch) : null;
    if (!units) { omitted += 1; continue; }
    const tokRaw = S(rec.evidenceToken) || S(rec.revisionId);
    const target = { id, owners: v2Owners(rec, id), tok: tokRaw && tokRaw.length <= 512 && PRINTABLE_RE.test(tokRaw) ? tokRaw : null, units };
    // An EMPTY unit list (the core's rec.unitsReason 'units-empty', or any record yielding no unit rows) is flagged
    // EXPLICITLY -- never an implicit "every unit current". Absent on every non-empty target (shape unchanged).
    if (units.length === 0 || S(rec.unitsReason) === TARGETS_UNITS_EMPTY) target.r = TARGETS_UNITS_EMPTY;
    targets.push(target);
  }
  const payload = {
    v: TARGETS_FORMAT_VERSION_V2,
    route: S(route ?? family),
    bucket: S(out.bucket),
    epoch,
    dryRun: out.dryRun === true,
    outcome: S(out.outcome) || null,
    code: S(out.code) || null,
    dataDoeCreates: Number(out.dataDoeCreates || 0),
    dataDoeTokens: Number(out.dataDoeTokens || 0),
    controlCleanupUnresolved: out.controlCleanupUnresolved === true,
    targets,
  };
  if (omitted > 0) payload.omittedTargets = omitted;
  // LINE BOUND: keep the longest PREFIX of whole targets whose full line fits, dropping the rest from the end (the
  // consumer treats a missing target as unverified -- fail safe). Sized in ONE pass: the fixed part is measured once
  // with the widest omittedTargets the count can take, then each target's own bytes (+ its ',') are added.
  if (utf8Bytes(TARGETS_LINE_PREFIX + JSON.stringify(payload)) > TARGETS_MAX_LINE_BYTES) {
    const all = payload.targets;
    payload.truncated = true;
    payload.targets = [];
    payload.omittedTargets = Number.MAX_SAFE_INTEGER; // reserve the widest count while sizing
    let used = utf8Bytes(TARGETS_LINE_PREFIX + JSON.stringify(payload));
    for (const t of all) {
      const b = utf8Bytes(JSON.stringify(t)) + (payload.targets.length ? 1 : 0);
      if (used + b > TARGETS_MAX_LINE_BYTES) break;
      payload.targets.push(t); used += b;
    }
    payload.omittedTargets = omitted + (all.length - payload.targets.length);
  }
  return payload;
}

/**
 * The single stdout line (prefix + compact JSON). v1 (the default) is byte-identical to before for the four existing
 * CLIs; v:2 emits the route/units shape.
 */
export function formatTargetsLine({ family, summary, v, route }) {
  if (v === TARGETS_FORMAT_VERSION_V2) return TARGETS_LINE_PREFIX + JSON.stringify(buildTargetsPayloadV2({ route, family, summary }));
  return TARGETS_LINE_PREFIX + JSON.stringify(buildTargetsPayload({ family, summary }));
}

// A v2 payload is well-formed only when every target has a string id and a units array (a malformed line is refused
// whole -- the consumer then classifies the run as missing its TARGETS, never as partially current).
function wellFormedV2(o) {
  return Array.isArray(o.targets) && o.targets.every((t) => t && typeof t === "object" && typeof t.id === "string" && Array.isArray(t.units)
    && t.units.every((x) => x && typeof x === "object" && typeof x.u === "string" && typeof x.rk === "string" && typeof x.s === "string"));
}

/**
 * Parse a TARGETS line back (consumer side). Accepts v1 (unchanged rule) and v2 (bounded to TARGETS_MAX_LINE_BYTES +
 * well-formed targets/units). Returns null when the line is not a well-formed TARGETS line.
 */
export function parseTargetsLine(line) {
  const s = S(line);
  if (!s.startsWith(TARGETS_LINE_PREFIX)) return null;
  try {
    const o = JSON.parse(s.slice(TARGETS_LINE_PREFIX.length));
    if (!o || typeof o !== "object") return null;
    if (o.v === TARGETS_FORMAT_VERSION) return Array.isArray(o.accounts) ? o : null;
    if (o.v === TARGETS_FORMAT_VERSION_V2) return utf8Bytes(s) <= TARGETS_MAX_LINE_BYTES && wellFormedV2(o) ? o : null;
    return null;
  } catch { return null; }
}

/**
 * Normalize a parsed TARGETS payload (v1 or v2) to the v2 shape (consumer side). v1 accounts become v2 targets with
 * owners [id], tok null (a v1 line carries no evaluated evidence token -- its `rev` is the family's revision id, not
 * the worker's token) and ONE unit per report: { u:'-', rk, s, r, asOf: the run's requestedAsOf, h:null, sra:null,
 * served:null }, preserving the report order. A v2 payload is returned as-is. null for anything else.
 */
export function normalizeTargets(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.v === TARGETS_FORMAT_VERSION_V2) return wellFormedV2(parsed) ? parsed : null;
  if (parsed.v !== TARGETS_FORMAT_VERSION || !Array.isArray(parsed.accounts)) return null;
  const epoch = S(parsed.requestedAsOf);
  const asOf = DATE_RE.test(epoch) ? epoch : null;
  return {
    v: TARGETS_FORMAT_VERSION_V2,
    route: S(parsed.family),
    bucket: S(parsed.bucket),
    epoch,
    dryRun: parsed.dryRun === true,
    outcome: parsed.outcome == null ? null : S(parsed.outcome),
    code: parsed.code == null ? null : S(parsed.code),
    dataDoeCreates: Number(parsed.dataDoeCreates || 0),
    dataDoeTokens: Number(parsed.dataDoeTokens || 0),
    controlCleanupUnresolved: parsed.controlCleanupUnresolved === true,
    targets: parsed.accounts.filter((a) => a && typeof a === "object" && S(a.id)).map((a) => ({
      id: S(a.id),
      owners: [S(a.id)],
      tok: null,
      // s is carried VERBATIM (a missing state stays "" -- exactly what the v1 verdict saw); r re-sanitized (idempotent
      // on a v1 code).
      units: Object.entries(a.reports && typeof a.reports === "object" ? a.reports : {}).map(([rk, x]) => ({
        u: "-", rk, s: S(x && x.s), r: x && x.r != null ? sanitizeReasonCode(x.r) : null, asOf, h: null, sra: null, served: null,
      })),
    })),
  };
}
