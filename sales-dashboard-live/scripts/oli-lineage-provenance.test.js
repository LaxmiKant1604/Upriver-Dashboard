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

group("E. shared module contract (the resolver + partition are the ONE shared implementation)");

test("E1. source-durable-model exports the shared resolver + the partition helper + constants", () => {
  assert.equal(typeof R.resolveOliLineageProvenance, "function");
  assert.equal(typeof R.partitionPartialCycleByLineage, "function", "the preflight partition composes the shared resolver");
  assert.equal(R.OLI_LINEAGE_STATUS.PROVEN_EMPTY, "proven-empty");
  assert.equal(R.DURABLE_OLI_PROVEN_EMPTY, "durable-oli-proven-empty");
});

group("F. PREFLIGHT eligibility (BEHAVIORAL: partitionPartialCycleByLineage classifies the proposed cycle account set)");

test("F1. positive -> eligible; proven-empty -> eligible; missing -> deferred (before the cycle identity is frozen)", () => {
  const p = R.partitionPartialCycleByLineage({
    accountIds: ["POS", "EMPTY", "MISS"],
    positiveHashesByAccount: { POS: ["h1"] },
    zeroRowExportsByAccount: { EMPTY: [{ requestHash: "z1", from: OLI_START, to: ASOF }] },
    // MISS: no positive rows AND no zero-row export -> resolver 'missing'
    oliStart: OLI_START, requestedAsOf: ASOF,
  });
  assert.deepEqual(p.eligible, ["EMPTY", "POS"]);
  assert.deepEqual(p.deferred.map((d) => d.accountId), ["MISS"]);
});

test("F2. REPRODUCTION -- a non-positive `row_count > 0` export (only explicit-zero/pending/cancelled rows) is DEFERRED, never entering the frozen cycle to block healthy accounts", () => {
  // Such an account has NO positive-sales history rows (the positive-sales reader excludes explicit-zero/pending/
  // cancelled), and its export is row_count>0 so the zero-row (row_count=0) reader returns NOTHING for it -> the
  // resolver sees no positive hashes AND no zero-row export -> 'missing' -> deferred. Healthy + proven-empty stay in.
  const p = R.partitionPartialCycleByLineage({
    accountIds: ["HEALTHY", "PROVEN_EMPTY", "CANCELLED_ONLY"],
    positiveHashesByAccount: { HEALTHY: ["oli-h"] },
    zeroRowExportsByAccount: { PROVEN_EMPTY: [{ requestHash: "z0", from: OLI_START, to: ASOF }] }, // CANCELLED_ONLY: absent from BOTH maps
    oliStart: OLI_START, requestedAsOf: ASOF,
  });
  assert.deepEqual(p.eligible, ["HEALTHY", "PROVEN_EMPTY"], "the non-positive row_count>0 account is NOT eligible");
  assert.deepEqual(p.deferred.map((d) => d.accountId), ["CANCELLED_ONLY"], "it is deferred at preflight (kept dated LKG)");
});

test("F3. the dedicated-cycle IDENTITY is recomputed from the PROVEN set (deferring an account changes the sha256; deferring none is byte-identical)", async () => {
  const { sha256 } = await import("../lib/server/source-identity.js");
  const bucketOf = (ids) => "priority-partial-europe-au-" + sha256(JSON.stringify([...ids].sort())).slice(0, 16);
  const proposed = ["A", "B", "CANCELLED_ONLY"];
  const p = R.partitionPartialCycleByLineage({
    accountIds: proposed,
    positiveHashesByAccount: { A: ["ha"], B: ["hb"] },
    zeroRowExportsByAccount: {},
    oliStart: OLI_START, requestedAsOf: ASOF,
  });
  assert.deepEqual(p.eligible, ["A", "B"]);
  assert.notEqual(bucketOf(p.eligible), bucketOf(proposed), "the frozen cycle identity is over the survivors, NOT the proposed set");
  // no deferral -> byte-identical identity (the whole-region healthy case is unchanged).
  const all = R.partitionPartialCycleByLineage({ accountIds: ["A", "B"], positiveHashesByAccount: { A: ["ha"], B: ["hb"] }, oliStart: OLI_START, requestedAsOf: ASOF });
  assert.equal(bucketOf(all.eligible), bucketOf(["A", "B"]), "no deferral -> identical cycle identity");
});

test("F4. ALL proposed accounts unresolvable -> eligible is EMPTY (the operator then publishes nothing)", () => {
  const p = R.partitionPartialCycleByLineage({ accountIds: ["X", "Y"], oliStart: OLI_START, requestedAsOf: ASOF });
  assert.deepEqual(p.eligible, []);
  assert.equal(p.deferred.length, 2);
});

test("F5. the release operator ACTUALLY wires the preflight: reads both durable readers, calls the partition, recomputes the cycle bucket from survivors, publishes nothing on empty, fail-safe on unreadable", () => {
  const mjs = read("scripts/release/priority-dashboards-release.mjs");
  assert.match(mjs, /partitionPartialCycleByLineage\(/, "the operator CALLS the shared partition (not comment-only)");
  assert.match(mjs, /getSourceOliHistoryRows\(/, "reads positive-sales provenance");
  assert.match(mjs, /getSourceOliZeroRowProof\(/, "reads the zero-row proof");
  assert.match(mjs, /wanted = part\.eligible/, "the frozen set becomes the PROVEN survivors");
  assert.match(mjs, /sha256\(JSON\.stringify\(wanted\)\)/, "the cycle identity is recomputed from the survivors");
  assert.match(mjs, /wanted\.length === 0[\s\S]{0,200}process\.exit\(0\)/, "zero eligible -> publish nothing");
  assert.match(mjs, /keeping the proposed set; the derive runtime remains the fail-closed authority/, "fail-safe on unreadable evidence");
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
