// SHARED production-schema capability check for the HEALTHY-SUBSET (priority-partial) publication cycle.
//
// The dedicated partial cycle bucket `priority-partial-<region>-<16hex>` can be opened ONLY once the approval-gated
// migration 20260924 has widened BOTH (a) the `public.sync_cycles` bucket CHECK constraint `sync_cycles_bucket_check`
// AND (b) the EXACT `public.open_sync_cycle(text, date, timestamptz, text)` guard to permit that namespace. This
// module verifies BOTH -- resolving the function by EXACT OID via to_regprocedure (which matches by argument TYPES,
// ignoring argument NAMES and canonicalising type aliases like timestamptz -> "timestamp with time zone"), and the
// constraint by its exact name -- and checking the exact regex the migration adds, NOT "any pg_proc whose text
// contains 'priority-partial'" (which a comment or an unrelated overload could satisfy). It is READ-ONLY: it only
// issues the two SELECTs below and NEVER writes.
//
// Reused by BOTH the workflow's pre-controls preflight (scripts/release/priority-partial-preflight.mjs) and the
// publisher entrypoint (scripts/release/priority-dashboards-release.mjs) for defense in depth. Missing OR unreadable
// capability => permitted:false (fail closed) so the caller performs ZERO publication-control / lease / cycle /
// reservation / publication writes. It DISTINGUISHES "function missing" (the exact-signature open_sync_cycle does not
// exist) from "function found, capability absent" (it exists but its guard lacks the priority-partial regex --
// i.e. the migration is not yet applied). 7-bit ASCII, LF.

const S = (v) => (v == null ? "" : String(v));
const safe = (e) => S(e && e.message ? e.message : e).slice(0, 200);

// The EXACT alternative the migration adds to BOTH objects (the function guard + the constraint). Matched as a literal
// substring of the rendered definition -- so a mere comment mentioning "priority-partial" never satisfies it.
export const PARTIAL_CYCLE_CAPABILITY_PATTERN = "^priority-partial-(india|europe-au|us-ca)-[0-9a-f]{16}$";
// The EXACT open_sync_cycle signature, resolved by OID via to_regprocedure (argument TYPES only; NAME-agnostic).
export const OPEN_SYNC_CYCLE_REGPROCEDURE = "public.open_sync_cycle(text, date, timestamptz, text)";

/** The two READ-ONLY capability SELECTs (shared so callers + tests use the identical, exact-OID + exact-name queries). */
export function partialCycleCapabilityQueries() {
  return Object.freeze({
    // EXACT OID resolution -- to_regprocedure matches by argument TYPES (ignores arg NAMES + canonicalises timestamptz),
    // returns NULL when no function of that exact signature exists. One row: present (bool) + the rendered def (or null).
    functionDef:
      "select r.oid is not null as present,"
      + " case when r.oid is null then null else pg_get_functiondef(r.oid) end as def"
      + " from (select to_regprocedure('" + OPEN_SYNC_CYCLE_REGPROCEDURE + "') as oid) r",
    constraintDef:
      "select pg_get_constraintdef(c.oid) as def from pg_constraint c"
      + " join pg_class t on c.conrelid = t.oid join pg_namespace n on t.relnamespace = n.oid"
      + " where n.nspname = 'public' and t.relname = 'sync_cycles' and c.conname = 'sync_cycles_bucket_check'",
  });
}

/**
 * PURE decision (no I/O): given the EXACT-signature function's presence + rendered guard, and the named constraint's
 * definitions, is the priority-partial cycle namespace permitted? Requires the exact-signature function to EXIST and
 * its guard to contain the exact migration regex, AND exactly one sync_cycles_bucket_check whose def contains it.
 * `functionPresent` distinguishes "function missing" from "function found, capability absent" in the reason.
 */
export function evaluatePartialCycleCapability({ functionPresent = false, functionDef = null, constraintDefs = [] } = {}) {
  const fnPresent = functionPresent === true;
  const fnDef = S(functionDef);
  const ck = (Array.isArray(constraintDefs) ? constraintDefs : []).map(S).filter((d) => d.trim() !== "");
  const constraintPresent = ck.length === 1;
  const functionPermits = fnPresent && fnDef.includes(PARTIAL_CYCLE_CAPABILITY_PATTERN);
  const constraintPermits = constraintPresent && ck[0].includes(PARTIAL_CYCLE_CAPABILITY_PATTERN);
  const permitted = functionPermits && constraintPermits;
  let reason = "permitted";
  if (!permitted) {
    if (!fnPresent) reason = "function missing: no " + OPEN_SYNC_CYCLE_REGPROCEDURE + " (exact signature) exists";
    else if (!functionPermits) reason = "function found, capability absent: open_sync_cycle exists but its guard does not permit the priority-partial namespace (migration 20260924 not applied)";
    else if (!constraintPresent) reason = "public.sync_cycles_bucket_check not found (exactly one expected; got " + ck.length + ")";
    else reason = "constraint found, capability absent: sync_cycles_bucket_check exists but does not permit the priority-partial namespace (migration 20260924 not applied)";
  }
  return { permitted, functionPresent: fnPresent, constraintPresent, functionPermits, constraintPermits, reason };
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
    const fnRow = (Array.isArray(fnRows) ? fnRows : [])[0] || {};
    const functionPresent = fnRow.present === true || fnRow.present === "t" || fnRow.present === "true";
    const functionDef = fnRow.def ?? fnRow.pg_get_functiondef ?? null;
    const constraintDefs = (Array.isArray(ckRows) ? ckRows : []).map((r) => (r && (r.def ?? r.pg_get_constraintdef)) || "");
    return evaluatePartialCycleCapability({ functionPresent, functionDef, constraintDefs });
  } catch (e) {
    return { permitted: false, functionPresent: false, constraintPresent: false, functionPermits: false, constraintPermits: false, reason: "capability-unreadable: " + safe(e) };
  }
}
