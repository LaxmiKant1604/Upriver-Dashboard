// FBA-inventory durable revision + registry: proves the PURE fba-inventory-revision.js decisions and the
// fba-dependent-reports registry consistency. Offline; zero network. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { computeFbaAccountRevision, FBA_REVISION_STATUS } from "../lib/server/sync/fba-inventory-revision.js";
import { fbaDependentLiveReportKeys, isFbaDependentLiveReport, FBA_LINEAGE_DEPENDS_ON, assertFbaDependentReportsConsistency, FBA_INVENTORY_SOURCE_KEY } from "../lib/server/sync/fba-dependent-reports.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const ASOF = "2026-09-10";
const ORG = "org-1";
const A = "A01";
const RH = "reqhash-d1"; // the recomputed D-1 request hash
const base = { organizationFingerprint: ORG, connectionId: "primary", accountId: A, requestedAsOf: ASOF, expectedRequestHash: RH };

// ---- eligibility of a proven-D-1 snapshot ----
test("a non-empty snapshot proving D-1 (request hash matches) -> eligible, status available, deps=[requestHash]", () => {
  const r = computeFbaAccountRevision({ ...base, snapshot: { source_request_hash: RH, payload_sha: "psA", row_count: 12 } });
  ok("eligible + available", r.eligible === true && r.status === FBA_REVISION_STATUS.AVAILABLE);
  ok("deps is EXACTLY the durable request hash (the value brand-inventory depends_on records)", r.deps.length === 1 && r.deps[0] === RH);
  ok("revisionId is a 32-hex content identity", /^[0-9a-f]{32}$/.test(r.revisionId));
});

test("a VALID EMPTY snapshot (row_count=0) proving D-1 -> eligible, status PROVEN_EMPTY (inventory unavailable, never zero)", () => {
  const r = computeFbaAccountRevision({ ...base, snapshot: { source_request_hash: RH, payload_sha: "psEmpty", row_count: 0 } });
  ok("eligible + proven-empty (a bounded single-day zero-row snapshot is valid-empty, not missing)", r.eligible === true && r.status === FBA_REVISION_STATUS.PROVEN_EMPTY);
  ok("deps still binds the durable request hash", r.deps.length === 1 && r.deps[0] === RH);
});

// ---- same-date correction: content folds into revisionId (deps unchanged -> detection rides the next date advance) ----
test("SAME-DATE correction (same request hash, NEW payload_sha) -> DIFFERENT revisionId (content folded); deps unchanged", () => {
  const r1 = computeFbaAccountRevision({ ...base, snapshot: { source_request_hash: RH, payload_sha: "psOld", row_count: 5 } });
  const r2 = computeFbaAccountRevision({ ...base, snapshot: { source_request_hash: RH, payload_sha: "psNEW", row_count: 5 } });
  ok("both eligible", r1.eligible === true && r2.eligible === true);
  ok("payload_sha change -> different revisionId (distinct deterministic cycle-bucket identity)", r1.revisionId !== r2.revisionId);
  ok("deps identical (the date-addressed request hash is unchanged intra-day)", r1.deps.join(",") === r2.deps.join(","));
});

test("an UNCHANGED re-sync (identical request hash + payload_sha) -> byte-identical revisionId", () => {
  const r1 = computeFbaAccountRevision({ ...base, snapshot: { source_request_hash: RH, payload_sha: "psSame", row_count: 5 } });
  const r2 = computeFbaAccountRevision({ ...base, snapshot: { source_request_hash: RH, payload_sha: "psSame", row_count: 5 } });
  ok("identical content -> identical revisionId (zero-write replay holds)", r1.revisionId === r2.revisionId);
});

// ---- ineligibility (defer; never publish stale/unproven; never manufacture zero) ----
test("NO durable snapshot -> ineligible no-durable-fba-snapshot (defer, LKG preserved)", () => {
  const r = computeFbaAccountRevision({ ...base, snapshot: null });
  ok("ineligible + missing", r.eligible === false && r.status === FBA_REVISION_STATUS.MISSING && r.reason === "no-durable-fba-snapshot" && r.revisionId === null);
});

test("snapshot for an OLDER/other day (request hash != recomputed D-1) -> ineligible snapshot-not-d1 (never publish stale as fresh)", () => {
  const r = computeFbaAccountRevision({ ...base, snapshot: { source_request_hash: "reqhash-d2-older", payload_sha: "psA", row_count: 12 } });
  ok("ineligible snapshot-not-d1", r.eligible === false && r.reason === "snapshot-not-d1");
});

test("blank recomputed expected request hash -> ineligible expected-request-hash-unresolved", () => {
  const r = computeFbaAccountRevision({ ...base, expectedRequestHash: "", snapshot: { source_request_hash: RH, payload_sha: "psA", row_count: 12 } });
  ok("ineligible expected-request-hash-unresolved", r.eligible === false && r.reason === "expected-request-hash-unresolved");
});

test("blank payload_sha (no content hash) -> ineligible snapshot-content-hash-blank", () => {
  const r = computeFbaAccountRevision({ ...base, snapshot: { source_request_hash: RH, payload_sha: "  ", row_count: 12 } });
  ok("ineligible snapshot-content-hash-blank", r.eligible === false && r.reason === "snapshot-content-hash-blank");
});

test("blank request hash -> ineligible snapshot-request-hash-blank", () => {
  const r = computeFbaAccountRevision({ ...base, snapshot: { source_request_hash: "", payload_sha: "psA", row_count: 12 } });
  ok("ineligible snapshot-request-hash-blank", r.eligible === false && r.reason === "snapshot-request-hash-blank");
});

test("negative / non-finite row_count -> ineligible snapshot-row-count-invalid (a malformed snapshot is never eligible)", () => {
  const r1 = computeFbaAccountRevision({ ...base, snapshot: { source_request_hash: RH, payload_sha: "psA", row_count: -1 } });
  const r2 = computeFbaAccountRevision({ ...base, snapshot: { source_request_hash: RH, payload_sha: "psA", row_count: "NaN" } });
  ok("negative row_count ineligible", r1.eligible === false && r1.reason === "snapshot-row-count-invalid");
  ok("non-finite row_count ineligible", r2.eligible === false && r2.reason === "snapshot-row-count-invalid");
});

test("incomplete account boundary (blank org / accountId / asOf) -> ineligible incomplete-account-boundary", () => {
  const r = computeFbaAccountRevision({ organizationFingerprint: "", accountId: A, requestedAsOf: ASOF, expectedRequestHash: RH, snapshot: { source_request_hash: RH, payload_sha: "psA", row_count: 1 } });
  ok("ineligible incomplete-account-boundary", r.eligible === false && r.reason === "incomplete-account-boundary");
});

test("the full account boundary (org + connection + accountId) is folded into revisionId (no cross-account collision)", () => {
  const rA = computeFbaAccountRevision({ ...base, snapshot: { source_request_hash: RH, payload_sha: "ps", row_count: 3 } });
  const rB = computeFbaAccountRevision({ ...base, accountId: "B02", snapshot: { source_request_hash: RH, payload_sha: "ps", row_count: 3 } });
  ok("different accountId -> different revisionId even with identical content", rA.revisionId !== rB.revisionId);
});

// ---- registry ----
test("registry: fbaDependentLiveReportKeys() is EXACTLY ['brand-inventory']", () => {
  ok("brand-inventory only", fbaDependentLiveReportKeys().join(",") === "brand-inventory");
  ok("isFbaDependentLiveReport(brand-inventory) true; (fba-plan) false (durable-inventory bridge pending)", isFbaDependentLiveReport("brand-inventory") === true && isFbaDependentLiveReport("fba-plan") === false);
  ok("the declared family includes the fba source key", FBA_LINEAGE_DEPENDS_ON["brand-inventory"].includes(FBA_INVENTORY_SOURCE_KEY));
});

test("registry consistency guard rejects an empty or non-FBA declaration (fail closed)", () => {
  let threwEmpty = false, threwNonFba = false;
  try { assertFbaDependentReportsConsistency({}); } catch { threwEmpty = true; }
  try { assertFbaDependentReportsConsistency({ "some-report": ["order-line-items"] }); } catch { threwNonFba = true; }
  ok("empty map rejected", threwEmpty);
  ok("a report without the fba source key rejected", threwNonFba);
});

async function main() {
  writeSync(1, "fba-publication-revision\n");
  let failures = 0;
  for (const t of tests) { try { await t.fn(); } catch (e) { failures += 1; writeSync(1, "FAIL  " + t.name + "\n" + String((e && e.stack) || e) + "\n"); } }
  writeSync(1, `\nfba-publication-revision: ${passed} assertions passed${failures ? ", " + failures + " FAILED" : ""}\n`);
  if (failures) process.exitCode = 1;
}
main();
