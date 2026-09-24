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

export const TARGETS_LINE_PREFIX = "TARGETS ";
export const TARGETS_FORMAT_VERSION = 1;

const S = (v) => (v == null ? "" : String(v));

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

/** The single stdout line (prefix + compact JSON). */
export function formatTargetsLine({ family, summary }) {
  return TARGETS_LINE_PREFIX + JSON.stringify(buildTargetsPayload({ family, summary }));
}

/** Parse a TARGETS line back (consumer side). Returns null when the line is not a well-formed TARGETS line. */
export function parseTargetsLine(line) {
  const s = S(line);
  if (!s.startsWith(TARGETS_LINE_PREFIX)) return null;
  try {
    const o = JSON.parse(s.slice(TARGETS_LINE_PREFIX.length));
    if (!o || typeof o !== "object" || o.v !== TARGETS_FORMAT_VERSION || !Array.isArray(o.accounts)) return null;
    return o;
  } catch { return null; }
}
