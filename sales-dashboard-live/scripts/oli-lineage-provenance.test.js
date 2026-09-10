// PURE shared OLI lineage-provenance resolver + zero-row reader/runtime WIRING guards (offline, ZERO network/DB).
//
// Proves resolveOliLineageProvenance (source-durable-model.js) -- the ONE resolver used by BOTH the partial-
// publication preflight and the derive runtime -- classifies exactly: nonempty (positive hashes) / proven-empty
// (a real, bounded, succeeded, row_count=0 zero-row export chain gaplessly covering [oliStart..asOf]) / missing
// (everything else, fail-closed). Also guards that the narrow supabase reader enforces the durable proof
// conditions and that the runtime binds + marks the proven-empty path. 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const group = (label) => tests.push({ marker: label });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // sales-dashboard-live
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

const OLI_START = "2025-01-01";
const ASOF = "2026-09-09";

let R;

group("A. resolveOliLineageProvenance -- nonempty (positive-sales) path (unchanged behaviour)");

test("A1. positive hashes -> nonempty, deps = sorted-unique hashes", () => {
  const r = R.resolveOliLineageProvenance({ historyProvenanceHashes: ["h2", "h1", "h2"], oliStart: OLI_START, requestedAsOf: ASOF });
  assert.equal(r.status, "nonempty");
  assert.deepEqual(r.deps, ["h1", "h2"]);
});

test("A2. a positive account with a BLANK/null provenance hash fails closed -> missing (never published unproven)", () => {
  assert.equal(R.resolveOliLineageProvenance({ historyProvenanceHashes: ["h1", null], oliStart: OLI_START, requestedAsOf: ASOF }).status, "missing");
  assert.equal(R.resolveOliLineageProvenance({ historyProvenanceHashes: ["h1", "  "], oliStart: OLI_START, requestedAsOf: ASOF }).status, "missing");
});

test("A3. positive hashes take PRECEDENCE over any zero-row exports (never mixes the two provenance kinds)", () => {
  const r = R.resolveOliLineageProvenance({ historyProvenanceHashes: ["h1"], zeroRowExports: [{ requestHash: "z1", from: OLI_START, to: ASOF }], oliStart: OLI_START, requestedAsOf: ASOF });
  assert.equal(r.status, "nonempty");
  assert.deepEqual(r.deps, ["h1"]);
});

group("B. proven-empty path (real, bounded, gapless zero-row proof only)");

test("B1. one succeeded row_count=0 export gaplessly covering [oliStart..asOf] -> proven-empty, deps = its hash", () => {
  const r = R.resolveOliLineageProvenance({ historyProvenanceHashes: [], zeroRowExports: [{ requestHash: "z1", from: OLI_START, to: ASOF }], oliStart: OLI_START, requestedAsOf: ASOF });
  assert.equal(r.status, "proven-empty");
  assert.deepEqual(r.deps, ["z1"]);
});

test("B2. MULTIPLE contiguous windows collectively prove the range -> proven-empty, deps = both hashes", () => {
  const r = R.resolveOliLineageProvenance({
    historyProvenanceHashes: [],
    zeroRowExports: [{ requestHash: "zB", from: "2026-03-18", to: ASOF }, { requestHash: "zA", from: OLI_START, to: "2026-03-17" }],
    oliStart: OLI_START, requestedAsOf: ASOF,
  });
  assert.equal(r.status, "proven-empty");
  assert.deepEqual(r.deps, ["zA", "zB"]);
});

group("C. proven-empty FAIL-CLOSED cases (missing)");

test("C1. NO zero-row exports (empty) -> missing (a failed/absent/non-owned export leaves nothing for the reader to return)", () => {
  assert.equal(R.resolveOliLineageProvenance({ historyProvenanceHashes: [], zeroRowExports: [], oliStart: OLI_START, requestedAsOf: ASOF }).reason, "no-zero-row-proof");
  assert.equal(R.resolveOliLineageProvenance({ historyProvenanceHashes: [], zeroRowExports: [], oliStart: OLI_START, requestedAsOf: ASOF }).status, "missing");
});

test("C2. a GAP before asOf -> missing (window proof is real; coverage-alone can never substitute)", () => {
  const r = R.resolveOliLineageProvenance({ historyProvenanceHashes: [], zeroRowExports: [{ requestHash: "z1", from: OLI_START, to: "2026-06-01" }], oliStart: OLI_START, requestedAsOf: ASOF });
  assert.equal(r.status, "missing");
  assert.equal(r.reason, "zero-row-window-gap");
});

test("C3. two windows with an INTERIOR gap -> missing", () => {
  const r = R.resolveOliLineageProvenance({
    historyProvenanceHashes: [],
    zeroRowExports: [{ requestHash: "z1", from: OLI_START, to: "2026-01-01" }, { requestHash: "z2", from: "2026-06-01", to: ASOF }],
    oliStart: OLI_START, requestedAsOf: ASOF,
  });
  assert.equal(r.status, "missing");
});

test("C4. a start AFTER oliStart (short at the start) -> missing", () => {
  assert.equal(R.resolveOliLineageProvenance({ historyProvenanceHashes: [], zeroRowExports: [{ requestHash: "z1", from: "2025-02-01", to: ASOF }], oliStart: OLI_START, requestedAsOf: ASOF }).status, "missing");
});

test("C5. a BLANK request_hash, an UNBOUNDED/malformed date, or an inverted window -> missing (any malformed export fails the WHOLE proof)", () => {
  assert.equal(R.resolveOliLineageProvenance({ historyProvenanceHashes: [], zeroRowExports: [{ requestHash: "", from: OLI_START, to: ASOF }], oliStart: OLI_START, requestedAsOf: ASOF }).reason, "zero-row-proof-malformed");
  assert.equal(R.resolveOliLineageProvenance({ historyProvenanceHashes: [], zeroRowExports: [{ requestHash: "z1", from: "", to: ASOF }], oliStart: OLI_START, requestedAsOf: ASOF }).status, "missing");
  assert.equal(R.resolveOliLineageProvenance({ historyProvenanceHashes: [], zeroRowExports: [{ requestHash: "z1", from: "2026-13-40", to: ASOF }], oliStart: OLI_START, requestedAsOf: ASOF }).status, "missing");
  assert.equal(R.resolveOliLineageProvenance({ historyProvenanceHashes: [], zeroRowExports: [{ requestHash: "z1", from: ASOF, to: OLI_START }], oliStart: OLI_START, requestedAsOf: ASOF }).status, "missing");
  // one good + one malformed export -> still missing (never a partial proof).
  assert.equal(R.resolveOliLineageProvenance({ historyProvenanceHashes: [], zeroRowExports: [{ requestHash: "z1", from: OLI_START, to: ASOF }, { requestHash: "", from: OLI_START, to: ASOF }], oliStart: OLI_START, requestedAsOf: ASOF }).status, "missing");
});

test("C6. a bad DERIVATION window (non-date oliStart/asOf, or start>end) -> missing", () => {
  assert.equal(R.resolveOliLineageProvenance({ historyProvenanceHashes: [], zeroRowExports: [{ requestHash: "z1", from: OLI_START, to: ASOF }], oliStart: "nope", requestedAsOf: ASOF }).status, "missing");
  assert.equal(R.resolveOliLineageProvenance({ historyProvenanceHashes: [], zeroRowExports: [{ requestHash: "z1", from: OLI_START, to: ASOF }], oliStart: ASOF, requestedAsOf: OLI_START }).status, "missing");
});

group("D. narrow zero-row reader (supabase.js) enforces the durable proof conditions (source guard)");

test("D1. getSourceOliZeroRowProof filters to active-owner + succeeded + row_count=0 + exact org/connection/source, fail-closed on a bad read", () => {
  const src = read("lib/server/supabase.js");
  const i = src.indexOf("export async function getSourceOliZeroRowProof");
  assert.ok(i > 0, "the reader exists");
  const body = src.slice(i, i + 3200);
  assert.match(body, /sync_source_job_owners/, "reads the durable ownership");
  assert.match(body, /owner_status.*eq\.active|owner_status: "eq\.active"/, "ACTIVE owner membership only");
  assert.match(body, /request_key: `eq\.\$\{ownerRequestKey\}`/, "scoped to the OLI slice request key");
  assert.match(body, /sync_source_jobs/, "reads the durable source jobs");
  assert.match(body, /fetch_status: "eq\.succeeded"/, "SUCCEEDED source job only");
  assert.match(body, /row_count: "eq\.0"/, "row_count = 0 only");
  assert.match(body, /source_key: `eq\.\$\{sourceKey\}`/, "exact OLI source key");
  assert.match(body, /organization_fingerprint: `eq\.\$\{organizationFingerprint\}`/, "exact org fingerprint");
  assert.match(body, /connection_id: `eq\.\$\{connectionId\}`/, "exact connection");
  assert.match(body, /read: "read-failed"|read: "schema-missing"/, "fail-closed typed read state (never a fabricated proof)");
});

group("E. runtime + preflight WIRING (one shared resolver; distinct COMPLETE marker)");

test("E1. the derive runtime imports the shared resolver, loads the zero-row proof, and marks durable-oli-proven-empty as COMPLETE", () => {
  const src = read("lib/server/sync/source-bucket-sync-runtime.js");
  assert.match(src, /resolveOliLineageProvenance/, "runtime uses the SHARED resolver (no second implementation)");
  assert.match(src, /loadOliZeroRowProof/, "runtime loads the durable zero-row proof");
  assert.match(src, /COMPLETE_OUTCOMES = new Set\(\["recorded", "recovered", "already-complete", DURABLE_OLI_PROVEN_EMPTY\]\)/, "proven-empty is a COMPLETE outcome; provenance-missing is NOT");
  assert.match(src, /note\(DURABLE_OLI_PROVEN_EMPTY\)/, "the distinct proven-empty marker is emitted");
  assert.match(src, /note\("durable-oli-provenance-missing"\)/, "the fail-closed missing outcome is preserved");
});

test("E2. the resolver + constants are exported from source-durable-model.js (imported by both runtime and preflight)", () => {
  assert.equal(typeof R.resolveOliLineageProvenance, "function");
  assert.equal(R.OLI_LINEAGE_STATUS.PROVEN_EMPTY, "proven-empty");
  assert.equal(R.DURABLE_OLI_PROVEN_EMPTY, "durable-oli-proven-empty");
  assert.equal(R.DURABLE_OLI_PROVENANCE_MISSING, "durable-oli-provenance-missing");
});

async function main() {
  out("oli-lineage-provenance proof suite");
  R = await import("../lib/server/sync/source-durable-model.js");
  let failures = 0;
  for (const t of tests) {
    if (t.marker) { out("-- " + t.marker); continue; }
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (e) { failures += 1; out("FAIL  " + t.name); out(String((e && e.stack) || e)); }
  }
  out("\n" + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : ""));
  if (failures) process.exitCode = 1;
}

main();
