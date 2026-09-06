// Phase 3 Increment 2: every report GET is READ-ONLY (zero backend mutation on a plain read).
//
// Two layers:
//   (A) BEHAVIORAL, instrumented: the shared self-heal used by the Daily read path (selfHealFromDurable) is driven with
//       an injected store whose every write function (claimRefreshLock/saveReportSnapshot/publishSnapshotUpdate) records
//       calls. In readOnly mode it must DERIVE + SERVE with ZERO writes (miss AND clamped), and a not-ready derive must
//       degrade to "waiting" with ZERO writes. (The legacy persist path is retained + still proven, for completeness.)
//   (B) STATIC source guard: the four dedicated durable serves in api/datadoe.js (serveSelfHealingReturns,
//       serveSelfHealingSkuMovement, serveSelfHealingBrandDirectory, brandViewDirectory) contain NO snapshot-write call
//       (saveReportSnapshot / claimRefreshLock / releaseRefreshLock / publishSnapshotUpdate / insertReportSnapshotIfAbsent)
//       anywhere in their bodies, and the Daily read path wires the self-heal with readOnly:true. This proves the read
//       paths cannot insert/update/upsert/lock/enqueue -- opening a page performs read-only operations only.
// Pure/offline; ZERO real I/O. 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { selfHealFromDurable } from "../lib/server/report-store.js";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "report-readonly-serve\n");

// A store whose every WRITE records the call, so a "zero writes" claim is provable, not asserted by inspection.
function recordingStore() {
  const calls = { claimRefreshLock: 0, releaseRefreshLock: 0, saveReportSnapshot: 0, publishSnapshotUpdate: 0, getReportSnapshot: 0 };
  return {
    calls,
    claimRefreshLock: async () => { calls.claimRefreshLock += 1; return true; },
    releaseRefreshLock: async () => { calls.releaseRefreshLock += 1; },
    getReportSnapshot: async () => { calls.getReportSnapshot += 1; return null; },
    saveReportSnapshot: async (snap) => { calls.saveReportSnapshot += 1; return { id: "x", source_refreshed_at: snap.sourceRefreshedAt, updated_at: null }; },
    publishSnapshotUpdate: async () => { calls.publishSnapshotUpdate += 1; },
  };
}
function fakeRes() {
  const r = { code: null, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } };
  return r;
}

/* ===================== (A) BEHAVIORAL: selfHealFromDurable readOnly = ZERO writes ===================== */
await (async () => {
  const store = recordingStore();
  const res = fakeRes();
  const derived = { payload: { rows: [{ date: "2026-09-05", total_sales: 10 }] }, sourceRefreshedAt: "2026-09-05T12:00:00.000Z" };
  const out = await selfHealFromDurable({
    deriveDurable: async () => derived, reportKey: "daily-reporting", reportVersion: "daily-reporting-shared-v2",
    accountId: "acctA", paramsHash: "h", params: { from: "2026-04-01", to: "2026-09-06", brand: "BrandX" },
    present: (p) => p, res, label: "Daily Reporting", lockSeconds: 60, readOnly: true,
  }, store);
  ok("A: readOnly derive SERVES the payload", out.served === true && res.code === 200 && Array.isArray(res.body.rows) && res.body.rows.length === 1);
  ok("A: readOnly derive claimed NO lock", store.calls.claimRefreshLock === 0 && store.calls.releaseRefreshLock === 0);
  ok("A: readOnly derive wrote NO snapshot and published NO update", store.calls.saveReportSnapshot === 0 && store.calls.publishSnapshotUpdate === 0);
  ok("A: readOnly derive labels the response rederived + readOnly", res.body.snapshot && res.body.snapshot.rederived === true && res.body.snapshot.readOnly === true);
})();

// readOnly + a CLAMPED derive (effectiveParams differ) still writes nothing and serves under the effective identity.
await (async () => {
  const store = recordingStore();
  const res = fakeRes();
  const derived = { payload: { rows: [] }, effectiveParams: { from: "2026-04-01", to: "2026-09-04", brand: "BrandX" }, sourceRefreshedAt: "2026-09-04T12:00:00.000Z" };
  const out = await selfHealFromDurable({
    deriveDurable: async () => derived, reportKey: "daily-reporting", reportVersion: "daily-reporting-shared-v2",
    accountId: "acctA", paramsHash: "hRequested", params: { from: "2026-04-01", to: "2026-09-06", brand: "BrandX" },
    present: (p) => p, res, label: "Daily Reporting", lockSeconds: 60, readOnly: true,
  }, store);
  ok("A: readOnly clamped derive serves under the effective (staleScope) identity", out.served === true && res.body.snapshot.staleScope === true);
  ok("A: readOnly clamped derive still wrote NOTHING", store.calls.saveReportSnapshot === 0 && store.calls.claimRefreshLock === 0 && store.calls.publishSnapshotUpdate === 0);
})();

// readOnly + a not-ready derive -> waiting, ZERO writes, no fabricated value.
await (async () => {
  const store = recordingStore();
  const res = fakeRes();
  const out = await selfHealFromDurable({
    deriveDurable: async () => ({ notReady: "not-ready", blockedBy: [{ sourceKey: "order-line-items" }] }),
    reportKey: "daily-reporting", reportVersion: "daily-reporting-shared-v2", accountId: "acctA", paramsHash: "h",
    params: { from: "2026-04-01", to: "2026-09-06", brand: "BrandX" }, present: (p) => p, res, label: "Daily Reporting", lockSeconds: 60, readOnly: true,
  }, store);
  ok("A: readOnly not-ready derive returns waiting (not served, notReady)", out.served === false && out.notReady === true);
  ok("A: readOnly not-ready derive wrote NOTHING and never responded with a fabricated payload", store.calls.saveReportSnapshot === 0 && store.calls.claimRefreshLock === 0 && res.body === null);
})();

// readOnly + a THROWING derive -> waiting, ZERO writes (never a 500, never a write).
await (async () => {
  const store = recordingStore();
  const res = fakeRes();
  const out = await selfHealFromDurable({
    deriveDurable: async () => { throw new Error("durable read blip"); },
    reportKey: "daily-reporting", reportVersion: "daily-reporting-shared-v2", accountId: "acctA", paramsHash: "h",
    params: {}, present: (p) => p, res, label: "Daily Reporting", lockSeconds: 60, readOnly: true,
  }, store);
  ok("A: readOnly throwing derive degrades to waiting with ZERO writes", out.served === false && out.notReady === true && store.calls.saveReportSnapshot === 0 && store.calls.claimRefreshLock === 0);
})();

// The legacy (readOnly:false) persist path is retained + still writes (proves the readOnly flag is what gates writes).
await (async () => {
  const store = recordingStore();
  const res = fakeRes();
  await selfHealFromDurable({
    deriveDurable: async () => ({ payload: { rows: [] }, sourceRefreshedAt: "2026-09-05T12:00:00.000Z" }),
    reportKey: "daily-reporting", reportVersion: "daily-reporting-shared-v2", accountId: "acctA", paramsHash: "h",
    params: { from: "2026-04-01", to: "2026-09-06", brand: "ALL" }, present: (p) => p, res, label: "Daily Reporting", lockSeconds: 60, readOnly: false,
  }, store);
  ok("A: the legacy persist path (readOnly:false) DOES write (the flag is what gates the write)", store.calls.saveReportSnapshot === 1 && store.calls.claimRefreshLock === 1);
})();

/* ===================== (B) STATIC: the datadoe serve read paths contain NO write call ===================== */
const datadoeSrc = readFileSync(path.join(appRoot, "api/datadoe.js"), "utf8");
const storeSrc = readFileSync(path.join(appRoot, "lib/server/report-store.js"), "utf8");
const WRITE_CALL = /\b(saveReportSnapshot|claimRefreshLock|releaseRefreshLock|publishSnapshotUpdate|insertReportSnapshotIfAbsent)\s*\(/;

// Extract a function body from its `async function NAME(` (or `function NAME(`) to the next top-level function decl.
function functionBody(src, name) {
  const re = new RegExp(`\\n(?:export )?(?:async )?function ${name}\\(`);
  const m = re.exec(src);
  assert.ok(m, `could not find function ${name}`);
  const start = m.index;
  const rest = src.slice(start + 1);
  const next = /\n(?:export )?(?:async )?function [A-Za-z0-9_]+\(/.exec(rest);
  return rest.slice(0, next ? next.index : rest.length);
}

for (const fn of ["serveSelfHealingReturns", "serveSelfHealingSkuMovement", "serveSelfHealingBrandDirectory", "brandViewDirectory"]) {
  const body = functionBody(datadoeSrc, fn);
  ok(`B: ${fn} contains NO snapshot-write call (read path is mutation-free)`, !WRITE_CALL.test(body));
}

// The Daily read path wires the durable self-heal in READ-ONLY mode (readOnly:true) at every call in serveSharedReport.
const serveShared = functionBody(storeSrc, "serveSharedReport");
const selfHealCalls = serveShared.match(/selfHealFromDurable\(\{[\s\S]*?\}, store\)/g) || [];
ok("B: serveSharedReport calls selfHealFromDurable at least once (the Daily read path)", selfHealCalls.length >= 1);
ok("B: EVERY serveSharedReport self-heal call passes readOnly:true (no write on a Daily read)", selfHealCalls.length > 0 && selfHealCalls.every((c) => /readOnly:\s*true/.test(c)));

// The ONLY writer the READ (non-refresh) branch can reach is selfHealFromDurable -- and every such call is readOnly
// (asserted above). The refresh branch (explicit refresh=1) legitimately writes and is out of scope for page-open GETs.
// Prove the read branch itself never calls the durable writer directly: the read path (before the `refresh` lock at
// `const locked = await claimRefreshLock`) contains no direct saveReportSnapshot call.
const readBranch = serveShared.split(/const locked = await claimRefreshLock/)[0];
ok("B: serveSharedReport READ branch calls no saveReportSnapshot directly (only the readOnly self-heal)", !/\bsaveReportSnapshot\s*\(/.test(readBranch));

writeSync(1, `\nreport-readonly-serve: ${passed} assertions passed\n`);
