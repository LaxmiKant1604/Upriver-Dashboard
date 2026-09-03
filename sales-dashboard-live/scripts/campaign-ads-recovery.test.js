// Campaign Ads BOUNDED / IDEMPOTENT failure-recovery regressions (pure, offline, ZERO network). Proves the typed
// classifier, the deterministic batch splitter, and the recovery engine: a create-time multi-seller 400
// deterministically binary-splits to ISOLATE the poison seller while every sibling still succeeds; a single-seller
// 400/422 is SOURCE_ACCOUNT_REJECTED (last-known-good retained, never a fabricated zero); 429 / 5xx are transient
// (retry next pass); an ambiguous create is NEVER blind-recreated (zero duplicate create); a partial coverage-failure
// inside a successful export isolates only those accounts; every sub-batch stays <=5; covered U isolated == input.
// 7-bit ASCII, LF, synchronous progress.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { classifySourceFailure, classifyThrownSourceError, SOURCE_FAILURE, sanitizeExcerpt } from "../lib/server/sync/source-failure-classifier.js";
import { splitBatchAllowlist } from "../lib/server/sync/campaign-region-routing.js";
import { runCampaignAdsBatchesWithRecovery, CAMPAIGN_ADS_GRAIN } from "../lib/server/sync/scheduled-campaign-ads-runner.js";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const httpErr = (status) => { const e = new Error("x"); e.httpStatus = status; e.sourceStage = "create"; return e; };
const netErr = () => { const e = new Error("connection reset"); e.sourceStage = "create"; e.network = true; return e; };
const okSummary = () => ({ status: "completed", coverageComplete: true, sources: { [CAMPAIGN_ADS_GRAIN]: { failedAccounts: [], coverageFailedAccounts: [] } } });
const recover = (batches, runOne) => runCampaignAdsBatchesWithRecovery({ batches, runOne, classifyError: classifyThrownSourceError });

/* ===================== classifier ===================== */
test("classify: create 400 multi-seller -> REQUEST_REJECTED (terminal); single-seller -> ACCOUNT_REJECTED", () => {
  const multi = classifySourceFailure({ stage: "create", status: 400, singleSeller: false });
  assert.equal(multi.classification, SOURCE_FAILURE.REQUEST_REJECTED); assert.ok(multi.terminal && !multi.retryable && !multi.ambiguous);
  assert.equal(classifySourceFailure({ stage: "create", status: 422, singleSeller: true }).classification, SOURCE_FAILURE.ACCOUNT_REJECTED);
  passed += 1;
});
test("classify: 429 -> RATE_LIMITED (retryable, Retry-After honored); 5xx -> UPSTREAM_TRANSIENT (retryable)", () => {
  const r = classifySourceFailure({ stage: "create", status: 429, retryAfterSeconds: 3 });
  assert.equal(r.classification, SOURCE_FAILURE.RATE_LIMITED); assert.equal(r.retryAfterMs, 3000); assert.ok(r.retryable && !r.terminal);
  assert.equal(classifySourceFailure({ stage: "create", status: 503 }).classification, SOURCE_FAILURE.UPSTREAM_TRANSIENT);
  passed += 1;
});
test("classify: network create -> CREATE_AMBIGUOUS; a free GET poll/download network throw is a retryable stage failure", () => {
  const amb = classifySourceFailure({ stage: "create", network: true });
  assert.equal(amb.classification, SOURCE_FAILURE.CREATE_AMBIGUOUS); assert.ok(amb.ambiguous && !amb.terminal);
  assert.equal(classifySourceFailure({ stage: "poll", network: true }).classification, SOURCE_FAILURE.POLL_FAILED);
  assert.equal(classifySourceFailure({ stage: "download", network: true }).classification, SOURCE_FAILURE.DOWNLOAD_FAILED);
  passed += 1;
});
test("classify: parse -> SCHEMA_INVALID; coverage -> SELLER_COVERAGE_MISSING; poll/download 4xx -> typed stage failure", () => {
  assert.equal(classifySourceFailure({ stage: "parse" }).classification, SOURCE_FAILURE.SCHEMA_INVALID);
  assert.equal(classifySourceFailure({ stage: "coverage" }).classification, SOURCE_FAILURE.SELLER_COVERAGE_MISSING);
  assert.equal(classifySourceFailure({ stage: "poll", status: 404 }).classification, SOURCE_FAILURE.POLL_FAILED);
  assert.equal(classifySourceFailure({ stage: "download", status: 404 }).classification, SOURCE_FAILURE.DOWNLOAD_FAILED);
  passed += 1;
});
test("sanitizeExcerpt redacts api key / authorization / bearer and bounds the excerpt length", () => {
  const s = sanitizeExcerpt("datadoe-api-key: dd_api_SECRET123 authorization: Bearer abc.def " + "x".repeat(500));
  assert.ok(!/SECRET123/.test(s)); assert.ok(!/abc\.def/.test(s)); assert.ok(s.length <= 300);
  passed += 1;
});

/* ===================== splitter ===================== */
test("splitBatchAllowlist: deterministic binary split, ORDER preserved, no child > input; single/empty -> [] (isolate)", () => {
  assert.deepEqual(splitBatchAllowlist(["a", "b", "c", "d", "e"]), [["a", "b", "c"], ["d", "e"]]);
  assert.deepEqual(splitBatchAllowlist(["a", "b", "c", "d"]), [["a", "b"], ["c", "d"]]);
  assert.deepEqual(splitBatchAllowlist(["a", "b"]), [["a"], ["b"]]);
  assert.deepEqual(splitBatchAllowlist(["a"]), []);
  assert.deepEqual(splitBatchAllowlist([]), []);
  passed += 1;
});

/* ===================== recovery engine ===================== */
test("REC: create-time multi-seller 400 BINARY-SPLITS to isolate ONLY the poison seller; siblings covered; all <=5", async () => {
  const calls = [];
  const runOne = async (ids, depth) => {
    calls.push({ ids: [...ids], depth });
    if (ids.includes("bad") && ids.length > 1) throw httpErr(400); // the multi-seller batch containing the poison is rejected
    if (ids.length === 1 && ids[0] === "bad") throw httpErr(400);   // isolated single poison seller is definitively rejected
    return okSummary();
  };
  const rec = await recover([{ allowlist: ["a", "b", "bad", "d", "e"] }], runOne);
  assert.deepEqual([...rec.covered].sort(), ["a", "b", "d", "e"], "every non-poison seller is covered");
  assert.deepEqual(rec.rejected.sort(), ["bad"], "the poison seller is isolated (retain LKG, never fabricated)");
  assert.ok(calls.every((c) => c.ids.length <= 5), "no sub-batch ever exceeds 5 sellers");
  assert.ok(calls.some((c) => c.depth > 0), "the failed batch was split (child creates at depth>0)");
  assert.deepEqual([...new Set([...rec.covered, ...rec.rejected])].sort(), ["a", "b", "bad", "d", "e"], "CONSERVATION: covered U rejected == input");
  passed += 1;
});
test("REC: a single-seller definitive 400/422 is ACCOUNT_REJECTED (isolated, LKG); sibling batches unaffected", async () => {
  const runOne = async (ids) => { if (ids.length === 1 && ids[0] === "x") throw httpErr(422); return okSummary(); };
  const rec = await recover([{ allowlist: ["x"] }, { allowlist: ["y", "z"] }], runOne);
  assert.deepEqual(rec.rejected, ["x"]);
  assert.deepEqual([...rec.covered].sort(), ["y", "z"], "the other batch succeeds regardless of the isolated rejection");
  assert.equal((rec.diagnostics[0] || {}).classification, "SOURCE_ACCOUNT_REJECTED");
  passed += 1;
});
test("REC: a transient 5xx isolates the batch's accounts (retry next pass) and never aborts the siblings", async () => {
  const runOne = async (ids) => { if (ids.includes("t")) throw httpErr(503); return okSummary(); };
  const rec = await recover([{ allowlist: ["t"] }, { allowlist: ["ok1"] }], runOne);
  assert.deepEqual(rec.transient, ["t"]); assert.deepEqual([...rec.covered], ["ok1"]);
  passed += 1;
});
test("REC: an AMBIGUOUS create is attempted ONCE and never blind-recreated (zero duplicate create) -- reconcile next pass", async () => {
  let creates = 0;
  const runOne = async (ids) => { creates += 1; if (ids.includes("amb")) throw netErr(); return okSummary(); };
  const rec = await recover([{ allowlist: ["amb"] }], runOne);
  assert.deepEqual(rec.ambiguous, ["amb"]);
  assert.equal(creates, 1, "exactly one attempt; the ambiguous create is reconciled by the next coverage-pre-filtered pass, never re-POSTed");
  passed += 1;
});
test("REC: a partial coverage-failure WITHIN a successful export isolates only those accounts (transient), covers the rest", async () => {
  const runOne = async () => ({ status: "completed", coverageComplete: false, sources: { [CAMPAIGN_ADS_GRAIN]: { failedAccounts: ["f1"], coverageFailedAccounts: [] } } });
  const rec = await recover([{ allowlist: ["f1", "g2"] }], runOne);
  assert.deepEqual(rec.transient, ["f1"]); assert.deepEqual([...rec.covered], ["g2"]);
  passed += 1;
});
test("REC: a deep multi-seller split terminates (every account either covered or isolated -- no unbounded loop)", async () => {
  // Every multi-seller create rejects; the splitter drives it all the way to singles which then succeed.
  const runOne = async (ids) => { if (ids.length > 1) throw httpErr(400); return okSummary(); };
  const rec = await recover([{ allowlist: ["a", "b", "c", "d", "e"] }], runOne);
  assert.deepEqual([...rec.covered].sort(), ["a", "b", "c", "d", "e"], "each seller succeeds once isolated to a single-seller create");
  assert.equal(rec.rejected.length, 0);
  passed += 1;
});

async function main() {
  out("campaign-ads-recovery");
  let failures = 0;
  for (const t of tests) {
    try { await t.fn(); out("  ok  " + t.name); }
    catch (e) { failures += 1; out("FAIL  " + t.name); out(String((e && e.stack) || e)); }
  }
  out("\n" + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : ""));
  if (failures) process.exitCode = 1;
}
main();
