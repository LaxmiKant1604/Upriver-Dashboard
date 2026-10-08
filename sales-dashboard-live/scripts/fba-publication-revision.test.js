// FBA-inventory durable revision + registry: proves the PURE fba-inventory-revision.js decisions and the
// fba-dependent-reports registry consistency. Since the Listings inventory cutover the durable evidence is the account's
// SAVED LISTINGS pointer (public.source_listings_snapshot: as_of / source_request_hash / payload_sha / row_count /
// validated_at / object_path); the requested-day proof is the pointer's as_of. Offline; zero network. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { computeFbaAccountRevision, FBA_REVISION_STATUS, fbaContentProvenanceToken, FBA_INVENTORY_DURABLE_SOURCE_KEY } from "../lib/server/sync/fba-inventory-revision.js";
import { fbaDependentLiveReportKeys, isFbaDependentLiveReport, FBA_LINEAGE_DEPENDS_ON, assertFbaDependentReportsConsistency, FBA_INVENTORY_EVIDENCE_SOURCE_KEY as FBA_INVENTORY_SOURCE_KEY } from "../lib/server/sync/fba-dependent-reports.js";
import { revisionCoveredByJob } from "../lib/server/sync/publication-binding.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const ASOF = "2026-09-10";
const ORG = "org-1";
const A = "A01";
const RH = "listings-batch-hash"; // the date-free Listings batch request hash
const base = { organizationFingerprint: ORG, connectionId: "primary", accountId: A, requestedAsOf: ASOF };
// A saved Listings pointer for the requested day (override any field).
const ptr = (over = {}) => ({
  as_of: ASOF, source_request_hash: RH, payload_sha: "psA", row_count: 12,
  validated_at: "2026-09-11T03:20:00.000Z", object_path: "source-snapshots/listings/A01/psA.json", ...over,
});

// ---- eligibility of a requested-day pointer ----
test("a non-empty pointer for the requested day -> eligible, available, deps=[] + contentDeps=[listings content token]", () => {
  const r = computeFbaAccountRevision({ ...base, snapshot: ptr() });
  ok("eligible + available", r.eligible === true && r.status === FBA_REVISION_STATUS.AVAILABLE && r.reason === null);
  ok("deps is EMPTY (the inventory export is not a cycle job; provenance rides contentDeps)", r.deps.length === 0);
  ok("contentDeps is ONE token 'listings|account|connection|requestHash|payload_sha'", r.contentDeps.length === 1 && r.contentDeps[0] === ["listings", A, "primary", RH, "psA"].join("|"));
  ok("the token's source key is the saved Listings family (never fba-inventory-health)", FBA_INVENTORY_DURABLE_SOURCE_KEY === "listings" && r.contentDeps[0].startsWith("listings|") && !r.contentDeps[0].includes("fba-inventory-health"));
  ok("revisionId is a 32-hex content identity", /^[0-9a-f]{32}$/.test(r.revisionId));
});

test("camelCase pointer fields (asOf / sourceRequestHash / payloadSha / rowCount) are read identically", () => {
  const snake = computeFbaAccountRevision({ ...base, snapshot: ptr() });
  const camel = computeFbaAccountRevision({ ...base, snapshot: { asOf: ASOF, sourceRequestHash: RH, payloadSha: "psA", rowCount: 12 } });
  ok("same eligibility, revisionId and token", camel.eligible === true && camel.revisionId === snake.revisionId && camel.contentDeps[0] === snake.contentDeps[0]);
  const ts = computeFbaAccountRevision({ ...base, snapshot: ptr({ as_of: ASOF + "T00:00:00.000Z" }) });
  ok("an as_of carrying a time suffix still proves the requested DAY", ts.eligible === true);
});

test("a VALID EMPTY pointer (row_count=0) for the requested day -> eligible, PROVEN_EMPTY, still binds a content token (unavailable, never zero)", () => {
  const r = computeFbaAccountRevision({ ...base, snapshot: ptr({ payload_sha: "psEmpty", row_count: 0 }) });
  ok("eligible + proven-empty", r.eligible === true && r.status === FBA_REVISION_STATUS.PROVEN_EMPTY);
  ok("valid-empty participates in the SAME content-binding contract (contentDeps binds its empty payload_sha)", r.deps.length === 0 && r.contentDeps.length === 1 && r.contentDeps[0].includes("psEmpty"));
});

// ---- same-day correction: content token CHANGES so the binding classifies STALE (not just revisionId) ----
test("SAME-DAY re-fetch / correction (same request hash, NEW payload_sha) -> DIFFERENT contentDeps token AND revisionId", () => {
  const r1 = computeFbaAccountRevision({ ...base, snapshot: ptr({ payload_sha: "psOld", row_count: 5 }) });
  const r2 = computeFbaAccountRevision({ ...base, snapshot: ptr({ payload_sha: "psNEW", row_count: 5 }) });
  ok("both eligible", r1.eligible === true && r2.eligible === true);
  ok("payload_sha change -> DIFFERENT contentDeps token (so revisionCoveredByJob marks the old dashboard STALE)", r1.contentDeps[0] !== r2.contentDeps[0]);
  ok("payload_sha change -> different revisionId (distinct deterministic cycle-bucket identity)", r1.revisionId !== r2.revisionId);
});

test("an UNCHANGED re-persist (identical pointer) -> byte-identical revisionId; validated_at / object_path do not enter the identity", () => {
  const r1 = computeFbaAccountRevision({ ...base, snapshot: ptr({ payload_sha: "psSame", row_count: 5 }) });
  const r2 = computeFbaAccountRevision({ ...base, snapshot: ptr({ payload_sha: "psSame", row_count: 5, validated_at: "2026-09-11T09:00:00.000Z" }) });
  ok("identical content -> identical revisionId + token (zero-write replay holds)", r1.revisionId === r2.revisionId && r1.contentDeps[0] === r2.contentDeps[0]);
});

test("a NEW cycle day (pointer re-recorded with a new as_of, same date-free request hash) -> a different revisionId for that day", () => {
  const d1 = computeFbaAccountRevision({ ...base, snapshot: ptr() });
  const d2 = computeFbaAccountRevision({ ...base, requestedAsOf: "2026-09-11", snapshot: ptr({ as_of: "2026-09-11" }) });
  ok("both eligible for their own day", d1.eligible === true && d2.eligible === true);
  ok("different requested day -> different revisionId", d1.revisionId !== d2.revisionId);
});

// ---- ineligibility (defer; never publish stale/unproven; never manufacture zero) ----
test("NO saved Listings pointer -> ineligible no-durable-listings-snapshot (defer, LKG preserved)", () => {
  const r = computeFbaAccountRevision({ ...base, snapshot: null });
  ok("ineligible + missing", r.eligible === false && r.status === FBA_REVISION_STATUS.MISSING && r.reason === "no-durable-listings-snapshot" && r.revisionId === null && r.contentDeps.length === 0);
});

test("a WRONG-DAY pointer (as_of != requested day) -> ineligible listings-snapshot-not-requested-day (never publish stale as fresh)", () => {
  const older = computeFbaAccountRevision({ ...base, snapshot: ptr({ as_of: "2026-09-09" }) });
  ok("an OLDER pointer defers", older.eligible === false && older.reason === "listings-snapshot-not-requested-day" && older.revisionId === null && older.contentDeps.length === 0);
  const newer = computeFbaAccountRevision({ ...base, snapshot: ptr({ as_of: "2026-09-11" }) });
  ok("a NEWER pointer (another day) also defers for this requested day", newer.eligible === false && newer.reason === "listings-snapshot-not-requested-day");
  const blank = computeFbaAccountRevision({ ...base, snapshot: ptr({ as_of: null }) });
  ok("a pointer with no as_of cannot prove the day -> defers", blank.eligible === false && blank.reason === "listings-snapshot-not-requested-day");
  const junk = computeFbaAccountRevision({ ...base, snapshot: ptr({ as_of: "not-a-date" }) });
  ok("a malformed as_of defers", junk.eligible === false && junk.reason === "listings-snapshot-not-requested-day");
});

test("expectedRequestHash is IGNORED (Listings has a date-free request hash; the as_of is the proof)", () => {
  const plain = computeFbaAccountRevision({ ...base, snapshot: ptr() });
  const mismatched = computeFbaAccountRevision({ ...base, expectedRequestHash: "some-other-hash", snapshot: ptr() });
  const blank = computeFbaAccountRevision({ ...base, expectedRequestHash: "", snapshot: ptr() });
  ok("a mismatched / blank expectedRequestHash changes nothing", mismatched.eligible === true && blank.eligible === true && mismatched.revisionId === plain.revisionId && blank.contentDeps[0] === plain.contentDeps[0]);
});

test("blank payload_sha (no content hash) -> ineligible snapshot-content-hash-blank", () => {
  const r = computeFbaAccountRevision({ ...base, snapshot: ptr({ payload_sha: "  " }) });
  ok("ineligible snapshot-content-hash-blank", r.eligible === false && r.reason === "snapshot-content-hash-blank");
});

test("blank request hash -> ineligible snapshot-request-hash-blank", () => {
  const r = computeFbaAccountRevision({ ...base, snapshot: ptr({ source_request_hash: "" }) });
  ok("ineligible snapshot-request-hash-blank", r.eligible === false && r.reason === "snapshot-request-hash-blank");
});

test("negative / non-finite row_count -> ineligible snapshot-row-count-invalid (a malformed pointer is never eligible)", () => {
  const r1 = computeFbaAccountRevision({ ...base, snapshot: ptr({ row_count: -1 }) });
  const r2 = computeFbaAccountRevision({ ...base, snapshot: ptr({ row_count: "NaN" }) });
  ok("negative row_count ineligible", r1.eligible === false && r1.reason === "snapshot-row-count-invalid");
  ok("non-finite row_count ineligible", r2.eligible === false && r2.reason === "snapshot-row-count-invalid");
});

test("incomplete account boundary (blank org / accountId / asOf) -> ineligible incomplete-account-boundary", () => {
  const r = computeFbaAccountRevision({ organizationFingerprint: "", accountId: A, requestedAsOf: ASOF, snapshot: ptr({ row_count: 1 }) });
  ok("ineligible incomplete-account-boundary", r.eligible === false && r.reason === "incomplete-account-boundary");
});

test("the full account boundary (org + connection + accountId) is folded into revisionId (no cross-account collision)", () => {
  const rA = computeFbaAccountRevision({ ...base, snapshot: ptr({ payload_sha: "ps", row_count: 3 }) });
  const rB = computeFbaAccountRevision({ ...base, accountId: "B02", snapshot: ptr({ payload_sha: "ps", row_count: 3 }) });
  ok("different accountId -> different revisionId even with identical content", rA.revisionId !== rB.revisionId);
});

// ---- revisionCoveredByJob: the shared binding's content-dep check ----
test("revisionCoveredByJob: FBA revision is COVERED iff its content token is in the job's durableContentDeps", () => {
  const r = computeFbaAccountRevision({ ...base, snapshot: ptr({ row_count: 7 }) });
  const token = r.contentDeps[0];
  ok("covered: token present in durable_content_deps", revisionCoveredByJob(r, { validated: true, dependsOn: ["oli-h", "catalog"], durableContentDeps: [token] }) === true);
  ok("NOT covered: durable_content_deps empty (never recorded) -> re-derive", revisionCoveredByJob(r, { validated: true, dependsOn: ["oli-h", "catalog"], durableContentDeps: [] }) === false);
  ok("NOT covered: durable_content_deps holds a DIFFERENT (older-content) token -> same-day correction STALE", revisionCoveredByJob(r, { validated: true, dependsOn: ["oli-h", "catalog"], durableContentDeps: [token.replace("psA", "psOLD")] }) === false);
  // A brand-inventory job published BEFORE the cutover recorded a Health token ('fba-inventory-health|...') -- it never
  // covers the Listings revision, so the first Listings pointer always re-derives the compact.
  const healthToken = ["fba-inventory-health", A, "primary", RH, "psA"].join("|");
  ok("NOT covered: a pre-cutover Health-keyed token over the SAME hashes never covers the Listings revision", revisionCoveredByJob(r, { validated: true, dependsOn: [], durableContentDeps: [healthToken] }) === false);
  ok("NOT covered: unvalidated job", revisionCoveredByJob(r, { validated: false, dependsOn: [], durableContentDeps: [token] }) === false);
});

test("revisionCoveredByJob: an OLI-shape revision (deps only, no contentDeps) is UNAFFECTED by durableContentDeps (byte-for-byte)", () => {
  const oli = { eligible: true, deps: ["oli-h1", "oli-h2"] }; // no contentDeps field (undefined)
  ok("covered by deps alone (durable_content_deps absent)", revisionCoveredByJob(oli, { validated: true, dependsOn: ["oli-h1", "oli-h2", "catalog"] }) === true);
  ok("not covered when a dep is missing", revisionCoveredByJob(oli, { validated: true, dependsOn: ["oli-h1", "catalog"] }) === false);
});

test("fbaContentProvenanceToken is path-independent: identical inputs -> identical token (source-first runtime == reconciler)", () => {
  const a1 = fbaContentProvenanceToken({ sourceKey: FBA_INVENTORY_DURABLE_SOURCE_KEY, accountId: A, connectionId: "primary", requestHash: RH, contentSha: "psA" });
  const a2 = fbaContentProvenanceToken({ sourceKey: FBA_INVENTORY_DURABLE_SOURCE_KEY, accountId: A, connectionId: "primary", requestHash: RH, contentSha: "psA" });
  ok("deterministic + path-independent", a1 === a2 && a1 === computeFbaAccountRevision({ ...base, snapshot: ptr({ row_count: 3 }) }).contentDeps[0]);
  ok("different content -> different token", a1 !== fbaContentProvenanceToken({ sourceKey: FBA_INVENTORY_DURABLE_SOURCE_KEY, accountId: A, connectionId: "primary", requestHash: RH, contentSha: "psB" }));
  ok("different account -> different token (no cross-account collision)", a1 !== fbaContentProvenanceToken({ sourceKey: FBA_INVENTORY_DURABLE_SOURCE_KEY, accountId: "B02", connectionId: "primary", requestHash: RH, contentSha: "psA" }));
});

// ---- registry ----
test("registry: fbaDependentLiveReportKeys() is EXACTLY ['brand-inventory'] over the saved Listings source key", () => {
  ok("brand-inventory only", fbaDependentLiveReportKeys().join(",") === "brand-inventory");
  ok("isFbaDependentLiveReport(brand-inventory) true; (fba-plan) false", isFbaDependentLiveReport("brand-inventory") === true && isFbaDependentLiveReport("fba-plan") === false);
  ok("the declared family includes the inventory evidence source key", FBA_LINEAGE_DEPENDS_ON["brand-inventory"].includes(FBA_INVENTORY_SOURCE_KEY));
  ok("the inventory evidence source key IS the revision's token source key ('listings')", FBA_INVENTORY_SOURCE_KEY === FBA_INVENTORY_DURABLE_SOURCE_KEY && FBA_INVENTORY_SOURCE_KEY === "listings");
});

test("registry consistency guard rejects an empty, non-FBA, or retired-Health declaration (fail closed)", () => {
  let threwEmpty = false, threwNonFba = false, threwHealth = false;
  try { assertFbaDependentReportsConsistency({}); } catch { threwEmpty = true; }
  try { assertFbaDependentReportsConsistency({ "some-report": ["order-line-items"] }); } catch { threwNonFba = true; }
  try { assertFbaDependentReportsConsistency({ "brand-inventory": ["fba-inventory-health"] }); } catch { threwHealth = true; }
  ok("empty map rejected", threwEmpty);
  ok("a report without the inventory source key rejected", threwNonFba);
  ok("a report declaring ONLY the retired fba-inventory-health key rejected", threwHealth);
});

async function main() {
  writeSync(1, "fba-publication-revision\n");
  let failures = 0;
  for (const t of tests) { try { await t.fn(); } catch (e) { failures += 1; writeSync(1, "FAIL  " + t.name + "\n" + String((e && e.stack) || e) + "\n"); } }
  writeSync(1, `\nfba-publication-revision: ${passed} assertions passed${failures ? ", " + failures + " FAILED" : ""}\n`);
  if (failures) process.exitCode = 1;
}
main();
