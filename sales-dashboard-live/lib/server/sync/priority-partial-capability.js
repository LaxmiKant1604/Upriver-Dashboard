// SHARED production-schema capability check for the HEALTHY-SUBSET (priority-partial) publication cycle.
//
// The dedicated partial cycle bucket `priority-partial-<region>-<16hex>` can be opened ONLY once the approval-gated
// migration 20260924 has widened BOTH (a) the `public.sync_cycles` bucket CHECK constraint `sync_cycles_bucket_check`
// AND (b) the EXACT `public.open_sync_cycle(text, date, timestamptz, text)` guard to permit that namespace. This module
// verifies BOTH -- by the EXACT function identity-arguments signature + the exact constraint name, and by the exact
// regex the migration adds -- NOT by "any pg_proc whose text contains 'priority-partial'" (which a comment or an
// unrelated overload could satisfy). It is READ-ONLY: it only issues the two SELECTs below and NEVER writes.
//
// Reused by BOTH the workflow's pre-controls preflight (scripts/release/priority-partial-preflight.mjs) and the
// publisher entrypoint (scripts/release/priority-dashboards-release.mjs) for defense in depth. Missing OR unreadable
// capability => permitted:false (fail closed) so the caller performs ZERO publication-control / lease / cycle /
// reservation / publication writes. 7-bit ASCII, LF.

const S = (v) => (v == null ? "" : String(v));
const safe = (e) => S(e && e.message ? e.message : e).slice(0, 200);

// The EXACT alternative the migration adds to BOTH objects (the function guard + the constraint). Matched as a literal
// substring of the rendered definition -- so a mere comment mentioning "priority-partial" never satisfies it.
export const PARTIAL_CYCLE_CAPABILITY_PATTERN = "^priority-partial-(india|europe-au|us-ca)-[0-9a-f]{16}$";
// The EXACT open_sync_cycle signature (pg identity arguments render timestamptz as 'timestamp with time zone').
export const OPEN_SYNC_CYCLE_IDENTITY_ARGS = "text, date, timestamp with time zone, text";

/** The two READ-ONLY capability SELECTs (shared so callers + tests use the identical, exact-signature queries). */
export function partialCycleCapabilityQueries() {
  return Object.freeze({
    functionDef:
      "select pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on p.pronamespace = n.oid"
      + " where n.nspname = 'public' and p.proname = 'open_sync_cycle'"
      + " and pg_get_function_identity_arguments(p.oid) = 'text, date, timestamp with time zone, text'",
    constraintDef:
      "select pg_get_constraintdef(c.oid) as def from pg_constraint c"
      + " join pg_class t on c.conrelid = t.oid join pg_namespace n on t.relnamespace = n.oid"
      + " where n.nspname = 'public' and t.relname = 'sync_cycles' and c.conname = 'sync_cycles_bucket_check'",
  });
}

/**
 * PURE decision (no I/O): given the rendered definitions returned by the two queries, is the priority-partial cycle
 * namespace permitted? Requires EXACTLY ONE matching object each (the exact-signature function + the named constraint)
 * whose definition contains the exact migration regex. Any other shape (zero rows, >1 row, missing regex) => not
 * permitted, with a precise reason.
 */
export function evaluatePartialCycleCapability({ functionDefs = [], constraintDefs = [] } = {}) {
  const fn = (Array.isArray(functionDefs) ? functionDefs : []).map(S).filter((d) => d.trim() !== "");
  const ck = (Array.isArray(constraintDefs) ? constraintDefs : []).map(S).filter((d) => d.trim() !== "");
  const functionPresent = fn.length === 1;
  const constraintPresent = ck.length === 1;
  const functionPermits = functionPresent && fn[0].includes(PARTIAL_CYCLE_CAPABILITY_PATTERN);
  const constraintPermits = constraintPresent && ck[0].includes(PARTIAL_CYCLE_CAPABILITY_PATTERN);
  const permitted = functionPermits && constraintPermits;
  let reason = "permitted";
  if (!permitted) {
    if (!functionPresent) reason = "open_sync_cycle(" + OPEN_SYNC_CYCLE_IDENTITY_ARGS + ") not found (exactly one expected; got " + fn.length + ")";
    else if (!constraintPresent) reason = "public.sync_cycles_bucket_check not found (exactly one expected; got " + ck.length + ")";
    else if (!functionPermits) reason = "open_sync_cycle guard does not permit the priority-partial namespace (migration 20260924 not applied)";
    else reason = "sync_cycles_bucket_check does not permit the priority-partial namespace (migration 20260924 not applied)";
  }
  return { permitted, functionPresent, constraintPresent, functionPermits, constraintPermits, reason };
}

/**
 * Run the two READ-ONLY capability queries via an injected `query(sql) -> rows` and evaluate. A read error (unreadable
 * capability) => permitted:false, reason 'capability-unreadable: ...' (FAIL CLOSED -- the caller must then do ZERO
 * control/lease/cycle/reservation/publication writes). Never writes.
 */
export async function readPartialCycleCapability(query) {
  if (typeof query !== "function") return { permitted: false, functionPresent: false, constraintPresent: false, functionPermits: false, constraintPermits: false, reason: "capability-unreadable: no query reader (fail closed)" };
  const q = partialCycleCapabilityQueries();
  try {
    const fnRows = await query(q.functionDef);
    const ckRows = await query(q.constraintDef);
    const functionDefs = (Array.isArray(fnRows) ? fnRows : []).map((r) => (r && (r.def ?? r.pg_get_functiondef)) || "");
    const constraintDefs = (Array.isArray(ckRows) ? ckRows : []).map((r) => (r && (r.def ?? r.pg_get_constraintdef)) || "");
    return evaluatePartialCycleCapability({ functionDefs, constraintDefs });
  } catch (e) {
    return { permitted: false, functionPresent: false, constraintPresent: false, functionPermits: false, constraintPermits: false, reason: "capability-unreadable: " + safe(e) };
  }
}
