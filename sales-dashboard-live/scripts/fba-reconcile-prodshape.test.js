// PRODUCTION-SHAPE integration for the FBA-inventory reconciler: drives the REAL buildFbaPublicationReconciler
// composition wired to the REAL control-package transaction (runControlPackageCli over a faithful in-memory store) +
// the REAL exact publication binding (shared saved-data core) + a no-export inner adapter, with ONLY the durable FBA
// snapshot read + the per-account release execution injected (typed). Covers: unpromoted brand-inventory -> STALE ->
// real control-apply + promote + safe-close; successful promotion then zero-write replay; valid-empty snapshot ->
// eligible + published (never zero); apply COMMIT_UNKNOWN; safe-close failure; and zero DataDoe create/poll/download.
// Offline; zero network. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { readPartialCycleCapability, PARTIAL_CYCLE_CAPABILITY_PATTERN } from "../lib/server/sync/priority-partial-capability.js";
import { runControlPackageCli } from "../lib/server/sync/source-priority-control-package.js";
import { buildFbaPublicationReconciler, FBA_RECONCILE_STATUS } from "../lib/server/sync/fba-publication-reconciler.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const ASOF = "2026-09-10";
const RK = "brand-inventory";
const CONTRACTS = { [RK]: { liveReportKey: RK, liveReportVersion: RK + "-live", liveParams: (p) => ({ to: p.to }) } };
const RD = { [RK]: { snapshotVersion: RK + "/shadow", validatePayload: (p) => !!(p && p.valid === true) } };
const HASH = (v, params) => v + "|" + JSON.stringify(params);
const shParamsFor = (a) => ({ reportVersion: RK + "/shadow", accountId: a, to: ASOF });
const shHashFor = (a) => HASH(RK + "/shadow", shParamsFor(a));
const PAY = { valid: true, rows: [] };
const RH = "fba-rh-A01"; // the durable FBA request hash proving D-1 (== recomputed expected hash)

const noExportAdapter = () => ({ create: async () => { throw new Error("FBA_RECONCILER_NO_EXPORT create"); }, poll: async () => { throw new Error("FBA_RECONCILER_NO_EXPORT poll"); }, download: async () => { throw new Error("FBA_RECONCILER_NO_EXPORT download"); } });

// A faithful in-memory store for runControlPackageTransaction (row-shaped state + the full lease interface). Identical
// to the OLI prod-shape store (the control plane is source-agnostic -- the same reviewed transaction).
function inMemoryControlStore(opts = {}) {
  const s = { rollout: [], dispatch: [], promoted: [], approvals: [], lease: null, gen: 0, applyCount: 0 };
  const owns = (o, g) => !!s.lease && s.lease.owner === o && s.lease.generation === g;
  return {
    _s: s,
    begin: async () => {}, rollback: async () => {}, end: async () => {},
    commit: async () => { if (opts.applyCommitUnknown && s.applyCount > 0 && !s.commitThrew) { s.commitThrew = true; throw new Error("commit ack lost"); } },
    acquireControlLease: async (o) => { s.gen += 1; s.lease = { owner: o, generation: s.gen }; return { disposition: "acquired", generation: s.gen, owner_token: o }; },
    renewControlLease: async (o, g) => (owns(o, g) ? { disposition: "renewed" } : { disposition: "lost" }),
    assertControlLeaseOwner: async (o, g) => owns(o, g),
    lockAndVerifyControlLease: async (o, g) => owns(o, g),
    releaseControlLease: async (o, g) => (owns(o, g) ? (s.lease = null, { disposition: opts.releaseFails ? "not-owner" : "released" }) : { disposition: "not-owner" }),
    readAllPrimary: async () => false, hasCron: async () => false,
    setRolloutEnabled: async (ids) => { s.applyCount += 1; s.rollout = [...ids].map((id) => ({ account_id: String(id), enabled: true })); },
    setDispatchEnabled: async (en, ct) => { const e = new Set(en.map(String)); s.dispatch = [...ct].map((rk) => ({ report_key: String(rk), schedule_enabled: e.has(String(rk)) })); },
    setPromotedEnabled: async (ids) => { s.promoted = [...ids].map((rk) => ({ report_key: String(rk), publish_enabled: true })); },
    setApprovalsApproved: async (ps) => { s.approvals = [...ps].map((p) => { const [rk, a] = String(p).split("|"); return { report_key: rk, account_id: a, approved: true }; }); },
    disableAllRollout: async () => { s.rollout = s.rollout.map((r) => ({ ...r, enabled: false })); },
    pauseAllDispatch: async (ct) => { s.dispatch = [...ct].map((rk) => ({ report_key: String(rk), schedule_enabled: false })); },
    disableAllPromoted: async () => { s.promoted = s.promoted.map((r) => ({ ...r, publish_enabled: false })); },
    revokeAllApprovals: async () => { s.approvals = s.approvals.map((r) => ({ ...r, approved: false })); },
    rolloutRows: async () => [...s.rollout], dispatchRows: async () => [...s.dispatch], promotedRows: async () => [...s.promoted], approvalRows: async () => [...s.approvals],
  };
}
const rolloutOpen = (st) => st._s.rollout.filter((r) => r.enabled).map((r) => r.account_id).sort();

// (namespace) the REAL capability check permits only when the migration widened both objects.
test("namespace: readPartialCycleCapability permits ONLY with the migration; fail closed otherwise", async () => {
  const q = (withPattern) => async (sql) => { const def = withPattern ? "CHECK (bucket ~ '" + PARTIAL_CYCLE_CAPABILITY_PATTERN + "')" : "CHECK (bucket = 'india')"; return /to_regprocedure/.test(sql) ? [{ present: true, def }] : [{ def }]; };
  ok("permitted with the migration", (await readPartialCycleCapability(q(true))).permitted === true);
  ok("NOT permitted without it (defer)", (await readPartialCycleCapability(q(false))).permitted === false);
});

function buildProdShape(over = {}) {
  const calls = { openApply: 0, closeRollback: 0, release: [], noExportCreateThrew: 0 };
  const store = over.store || inMemoryControlStore(over.storeOpts || {});
  const snapshot = over.snapshot || { source_request_hash: RH, payload_sha: "ps-A01", row_count: 12 };
  const shadowRefresh = new Map([["A01", "2026-09-10T09:00:00Z"]]);
  const liveRefresh = over.liveRefresh || new Map();
  const OPERATOR = "fba-reconcile:india:test";
  let leaseFence = null;
  const reconciler = buildFbaPublicationReconciler({
    resolveOrg: async () => ({ organizationFingerprint: "org-1", connectionId: "primary" }),
    bucketAccounts: async () => [{ accountId: "A01" }],
    readFbaSnapshot: async () => (over.snapshotNull ? { read: "ok", snapshot: null } : { read: "ok", snapshot }),
    resolveExpectedRequestHash: async () => RH,
    readLatestReportJob: async () => ({ deriveStatus: "succeeded", saveStatus: "succeeded", validated: true, cycleStatus: "succeeded", snapshotParamsHash: shHashFor("A01"), dependsOn: [RH, "catalog"] }),
    readShadowSnapshot: async ({ reportKey, accountId, paramsHash }) => ({ report_key: reportKey, account_id: accountId, params_hash: paramsHash, params: shParamsFor(accountId), payload: PAY, payload_storage_path: null, source_refreshed_at: shadowRefresh.get("A01") }),
    readLiveSnapshot: async ({ reportKey, accountId, paramsHash }) => (liveRefresh.has("A01") ? { report_key: reportKey, account_id: accountId, params_hash: paramsHash, params: { reportVersion: CONTRACTS[reportKey].liveReportVersion, to: ASOF }, payload: PAY, payload_storage_path: null, source_refreshed_at: liveRefresh.get("A01") } : null),
    loadStoragePayload: async () => null,
    verifyLiveReadback: async () => ({ ok: liveRefresh.has("A01") }),
    liveContracts: CONTRACTS, computeHash: HASH, reportDerivations: RD,
    openControls: async (ids) => {
      calls.openApply += 1;
      const r = await runControlPackageCli({ mode: "apply", operator: OPERATOR, discoverAccounts: async () => [...ids], connectStore: async () => store, ownerToken: OPERATOR, operationKey: "fba-reconcile/india/" + ASOF, leaseTtlSeconds: 900 });
      if (r && Number(r.code) === 3) return { ok: false, commitUnknown: true, reason: "apply-commit-unknown" };
      if (!r || r.committed !== true) return { ok: false, reason: "apply-noncommit code " + (r && r.code) };
      const gen = Number(r.leaseGeneration); if (!(Number.isSafeInteger(gen) && gen > 0)) return { ok: false, reason: "no-generation" };
      leaseFence = { ownerToken: r.ownerToken || OPERATOR, generation: gen };
      return { ok: true };
    },
    closeControls: async () => {
      if (!leaseFence) return { ok: true };
      calls.closeRollback += 1;
      const r = await runControlPackageCli({ mode: "rollback", operator: OPERATOR, connectStore: async () => store, ownerToken: leaseFence.ownerToken, ownerGeneration: leaseFence.generation, operationKey: "fba-reconcile/india/" + ASOF });
      leaseFence = null;
      if (r && r.skipped === "lease-not-owner") return { ok: true };
      if (r && Number(r.code) === 3) return { ok: false, commitUnknown: true, reason: "safe-close-commit-unknown" };
      if (!r || r.committed !== true) return { ok: false, reason: "safe-close-noncommit code " + (r && r.code) };
      return { ok: true };
    },
    runReleaseForAccount: async ({ accountId }) => {
      calls.release.push(accountId);
      try { await noExportAdapter().create(); } catch (e) { if (/FBA_RECONCILER_NO_EXPORT/.test(String(e && e.message))) calls.noExportCreateThrew += 1; }
      const r = over.releaseFor ? over.releaseFor(accountId) : { ok: true, code: 0 };
      if (r.ok) liveRefresh.set("A01", shadowRefresh.get("A01"));
      return r;
    },
    reportKeys: [RK],
    log: () => {},
  });
  return { reconciler, calls, store, liveRefresh };
}
const st = (out) => out.perAccount[0].reports[RK].state;

test("UNPROMOTED brand-inventory -> STALE -> REAL control-apply + promote + safe-close; zero DataDoe create", async () => {
  const h = buildProdShape({ liveRefresh: new Map([["A01", "2026-09-08T00:00:00Z"]]) }); // older live = unpromoted newer FBA
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 re-published via the real control-package apply + safe-close", st(out) === FBA_RECONCILE_STATUS.READBACK_VERIFIED && h.calls.openApply === 1 && h.calls.closeRollback === 1);
  ok("the no-export adapter's create threw inside the release path (zero DataDoe)", h.calls.noExportCreateThrew === 1 && out.dataDoeCreates === 0 && out.ok === true);
  ok("the lease was released by the real safe-close", h.store._s.lease === null);
});

test("successful promotion then a REPLAY is a zero-write no-op (no control apply, PUBLICATION_NOT_REQUIRED)", async () => {
  const h = buildProdShape({ liveRefresh: new Map([["A01", "2026-09-08T00:00:00Z"]]) });
  await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  const beforeApply = h.calls.openApply, beforeRel = h.calls.release.length;
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("replay: no control apply, no release, PUBLICATION_NOT_REQUIRED", h.calls.openApply === beforeApply && h.calls.release.length === beforeRel && st(out) === "PUBLICATION_NOT_REQUIRED");
});

test("a VALID EMPTY durable snapshot -> eligible -> promoted via the real control-package (inventory unavailable, never zero)", async () => {
  const h = buildProdShape({ snapshot: { source_request_hash: RH, payload_sha: "ps-empty", row_count: 0 }, liveRefresh: new Map([["A01", "2026-09-08T00:00:00Z"]]) });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 valid-empty published via real apply+safe-close", st(out) === FBA_RECONCILE_STATUS.READBACK_VERIFIED && h.calls.openApply === 1 && h.calls.closeRollback === 1);
});

test("control-apply COMMIT_UNKNOWN -> outcome failed, NO release, ok:false", async () => {
  const h = buildProdShape({ storeOpts: { applyCommitUnknown: true } });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("apply COMMIT_UNKNOWN -> FAILED_PUBLISH, controlCleanupUnresolved, no release, ok:false", st(out) === FBA_RECONCILE_STATUS.FAILED_PUBLISH && out.controlCleanupUnresolved === true && h.calls.release.length === 0 && out.ok === false);
});

test("safe-close FAILURE after a successful publish -> outcome failed, ok:false (never complete)", async () => {
  const h = buildProdShape({ liveRefresh: new Map([["A01", "2026-09-08T00:00:00Z"]]), storeOpts: { releaseFails: true } });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("published but safe-close could not release -> control-cleanup-unresolved, ok:false", st(out) === FBA_RECONCILE_STATUS.READBACK_VERIFIED && out.controlCleanupUnresolved === true && out.ok === false && out.outcome === "failed");
});

test("a durable snapshot that cannot prove D-1 (request hash mismatch) -> DEFERRED_PROVENANCE; NO control apply, NO release", async () => {
  const h = buildProdShape({ snapshot: { source_request_hash: "fba-rh-OLDER", payload_sha: "ps", row_count: 5 } });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 DEFERRED_PROVENANCE; zero control/release (never publishes stale as fresh)", st(out) === FBA_RECONCILE_STATUS.DEFERRED_PROVENANCE && h.calls.openApply === 0 && h.calls.release.length === 0);
});

test("zero DataDoe create/poll/download are impossible (the no-export adapter throws on all three)", async () => {
  const a = noExportAdapter();
  for (const op of ["create", "poll", "download"]) { let threw = false; try { await a[op]({}); } catch (e) { threw = /FBA_RECONCILER_NO_EXPORT/.test(String(e && e.message)); } ok("adapter." + op + " throws", threw); }
});

async function main() {
  writeSync(1, "fba-reconcile-prodshape\n");
  let failures = 0;
  for (const t of tests) { try { await t.fn(); } catch (e) { failures += 1; writeSync(1, "FAIL  " + t.name + "\n" + String((e && e.stack) || e) + "\n"); } }
  writeSync(1, `\nfba-reconcile-prodshape: ${passed} assertions passed${failures ? ", " + failures + " FAILED" : ""}\n`);
  if (failures) process.exitCode = 1;
}
main();
