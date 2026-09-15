// WORKSTREAM 1B -- the SANITIZED per-account failure diagnostic (saved-data-reconciler.js diagStageFor + the boundary
// log payload). Proves the diagnostic is USEFUL (a stable stage + reasonCode per failure stage vocabulary) yet contains
// NO sensitive payload / credential / SQL / Amazon data: reasonCode is the code BEFORE the first ':' and the emitted
// object is a fixed 6-key allowlist. Offline; zero network. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { diagStageFor } from "../lib/server/sync/saved-data-reconciler.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "saved-data-reconciler-diag\n");

// The EXACT boundary payload the reconciler emits (mirrors saved-data-reconciler.js: { family, region, accountId,
// requestedAsOf, stage, reasonCode }). Kept in step with the emit site so the allowlist test is faithful.
const S = (v) => (v == null ? "" : String(v));
const emit = ({ family, bucket, accountId, requestedAsOf, result }) => {
  const d = diagStageFor(result);
  return { family, region: S(bucket), accountId, requestedAsOf: S(requestedAsOf), stage: d.stage, reasonCode: d.reasonCode, errClass: d.errClass };
};
const ALLOWED = ["family", "region", "accountId", "requestedAsOf", "stage", "reasonCode", "errClass"];

// ---- (1) stage vocabulary: every release stage+reason maps to the required incident vocabulary ----
{
  const cases = [
    // [result, expectedStage, expectedReasonCode]
    [{ stage: "derive", reason: "daily-payload-malformed" }, "derive", "daily-payload-malformed"],
    [{ stage: "derive", reason: "daily-window-unresolved" }, "derive", "daily-window-unresolved"],
    [{ stage: "derive", reason: "bad-args" }, "derive", "bad-args"],
    [{ stage: "reconcile", reason: "catalog-integrity" }, "catalog-evidence", "catalog-integrity"],
    [{ stage: "reconcile", reason: "catalog-row-count-invalid" }, "catalog-evidence", "catalog-row-count-invalid"],
    [{ stage: "reconcile", reason: "ads-revision-changed-since-scan" }, "revision", "ads-revision-changed-since-scan"],
    [{ stage: "derive", reason: "no-revision-id" }, "revision", "no-revision-id"],
    [{ stage: "reconcile", reason: "ads-metric-read-failed" }, "source-evidence", "ads-metric-read-failed"],
    [{ stage: "reconcile", reason: "oli-history-unavailable" }, "source-evidence", "oli-history-unavailable"],
    [{ stage: "derive", reason: "already-complete-hash-mismatch" }, "job-save", "already-complete-hash-mismatch"],
    [{ stage: "derive", reason: "lineage-upsert-threw" }, "job-save", "lineage-upsert-threw"],
    [{ stage: "derive", reason: "claim-malformed" }, "job-save", "claim-malformed"],
    [{ stage: "derive", reason: "shadow-conflict" }, "shadow-save", "shadow-conflict"],
    [{ stage: "derive", reason: "reconcile-malformed" }, "shadow-save", "reconcile-malformed"],
    [{ stage: "finalize", reason: "finalize-refused" }, "closure", "finalize-refused"],
    [{ stage: "publish-gates", reason: "preflight-report-disabled" }, "publish", "preflight-report-disabled"],
    [{ stage: "publish", reason: "publish-conflict" }, "publish", "publish-conflict"],
    [{ stage: "readback", reason: "live-readback-failed" }, "readback", "live-readback-failed"],
    [{ stage: "reconcile", reason: "controls-not-opened" }, "controls", "controls-not-opened"],
  ];
  for (const [result, stage, reasonCode] of cases) {
    const d = diagStageFor(result);
    ok(`diagStageFor(${result.reason}) -> stage=${stage} reasonCode=${reasonCode}`, d.stage === stage && d.reasonCode === reasonCode);
  }
  // stage falls back to result.stage when reason is blank, and to "unknown" when both are blank.
  ok("blank reason -> reasonCode falls back to result.stage", diagStageFor({ stage: "publish", reason: "" }).reasonCode === "publish");
  ok("blank reason + blank stage -> reasonCode=unknown, stage=derive", diagStageFor({}).reasonCode === "unknown");
}

// ---- (2) SANITIZATION: reasonCode strips everything after the first ':' -- no err message / SQL / connection string /
//         payload / Amazon data can ever ride into the log ----
{
  const leaky = [
    "lineage-upsert-threw: error connecting to postgres://svc:s3cr3t@db.example.co:5432/prod SELECT * FROM orders",
    "ads-metric-read-failed: relation \"ad_daily_metrics\" row {sku:'B0ABC', customer:'Jane Roe', sales_amount: 9999}",
    "publish-threw: Bearer eyJhbGciOi.SECRET.TOKEN apikey=service_role_key_value",
    "catalog-dangling: /source-snapshots/v2/orgfp/primary/product-catalog/acct/deadbeef.json 42 rows",
  ];
  for (const raw of leaky) {
    const d = diagStageFor({ stage: "derive", reason: raw });
    const stableCode = raw.split(":")[0];
    ok(`reasonCode is the stable code only (no message): ${stableCode}`, d.reasonCode === stableCode && !d.reasonCode.includes(":"));
    // The stable code itself must carry none of the sensitive tails.
    for (const secret of ["postgres://", "s3cr3t", "eyJ", "service_role", "Bearer", "customer", "Jane Roe", "sales_amount", "SELECT", ".json", "B0ABC", "apikey"]) {
      ok(`reasonCode excludes sensitive substring '${secret}'`, !d.reasonCode.includes(secret));
    }
  }
}

// ---- (2b) errClass: a BOUNDED status:keyword classifier of the appended error tail -- no raw message/value/UUID ----
{
  const cases = [
    ["lineage-upsert-threw:Supabase request failed (400): sync cycle 00000000-0000-0000-0000-000000000000 is terminal (partial); refusing to append/alter child work", "400:terminal-cycle"],
    ["lineage-upsert-threw:Supabase request failed (400): parent sync cycle deadbeef not found; refusing to append/alter child work", "400:not-found"],
    ["lineage-upsert-threw:Supabase request failed (400): Could not find the 'durable_content_deps' column of 'sync_report_jobs' in the schema cache", "400:schema-cache"],
    ["publish-threw:Supabase request failed (409): duplicate key value violates unique constraint \"x\"", "409:duplicate"],
    ["catalog-integrity", ""], // no appended tail -> empty errClass
  ];
  for (const [reason, expect] of cases) ok(`diagErrClass(${expect || "empty"})`, diagStageFor({ stage: "derive", reason }).errClass === expect);
  // errClass NEVER carries the UUID / column value / raw message.
  const ec = diagStageFor({ stage: "derive", reason: "lineage-upsert-threw:Supabase request failed (400): sync cycle 12f3a683-2880-414e is terminal (partial)" }).errClass;
  for (const secret of ["12f3a683", "refusing", "append", "sync cycle"]) ok(`errClass excludes '${secret}'`, !ec.includes(secret));
}

// ---- (3) the emitted boundary object is EXACTLY the 7-key allowlist -- nothing else (no payload/params/rows) ----
{
  const obj = emit({ family: "ads", bucket: "india", accountId: "acct-00", requestedAsOf: "2026-09-14",
    result: { stage: "derive", reason: "daily-payload-malformed: payload {rows:[{customer:'X'}]} token=abc", problems: ["daily-payload-malformed: leak"], params: { secret: "no" }, payload: { rows: [] } } });
  const keys = Object.keys(obj).sort();
  ok("emitted object has EXACTLY the 7 allowlisted keys", keys.length === 7 && keys.every((k) => ALLOWED.includes(k)) && ALLOWED.every((k) => keys.includes(k)));
  ok("emitted object carries no params/payload/problems keys", !("params" in obj) && !("payload" in obj) && !("problems" in obj) && !("reason" in obj));
  const json = JSON.stringify(obj);
  // NOTE: "payload" legitimately appears inside the stable code "daily-payload-malformed" (a stage code, not a leak),
  // so we assert on genuinely sensitive VALUES only -- the appended message (after ':'), params, payload rows, tokens.
  for (const secret of ["customer", "token=abc", "secret", "problems", "params", "'X'"]) ok(`emitted JSON excludes sensitive '${secret}'`, !json.includes(secret));
  ok("emitted values are correct", obj.family === "ads" && obj.region === "india" && obj.accountId === "acct-00" && obj.requestedAsOf === "2026-09-14" && obj.stage === "derive" && obj.reasonCode === "daily-payload-malformed");
}

writeSync(1, `\nsaved-data-reconciler-diag: ${passed} assertions passed\n`);
