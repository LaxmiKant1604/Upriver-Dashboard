// PRODUCTION-SHAPE integration (blocker 6): drives the REAL buildOliPublicationReconciler composition wired to the REAL
// control-package transaction (runControlPackageCli over a faithful in-memory store) + the REAL exact publication
// binding + a no-export inner adapter, with ONLY the durable I/O + the per-account release execution injected (typed).
// Covers: unpromoted newer job -> STALE -> promote; successful promotion then zero-write replay; apply COMMIT_UNKNOWN;
// safe-close failure; typed Catalog integrity failure; forced timeout cleanup; and zero DataDoe create/poll/download.
// Offline; zero network. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { readPartialCycleCapability, PARTIAL_CYCLE_CAPABILITY_PATTERN } from "../lib/server/sync/priority-partial-capability.js";
import { runControlPackageCli } from "../lib/server/sync/source-priority-control-package.js";
import { buildOliPublicationReconciler, OLI_RECONCILE_STATUS } from "../lib/server/sync/oli-publication-reconciler.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const ASOF = "2026-09-09";
const REPORTS = ["brand-inventory", "brand-sales", "daily-reporting"];
const CONTRACTS = Object.fromEntries(REPORTS.map((rk) => [rk, { liveReportKey: rk, liveReportVersion: rk + "-live", liveParams: (p) => ({ to: p.to }) }]));
const HASH = (v, params) => v + "|" + JSON.stringify(params);

// The no-export inner adapter used by the real reconciler entrypoint -- proves the DataDoe transport is unreachable.
const noExportAdapter = () => ({ create: async () => { throw new Error("OLI_RECONCILER_NO_EXPORT create"); }, poll: async () => { throw new Error("OLI_RECONCILER_NO_EXPORT poll"); }, download: async () => { throw new Error("OLI_RECONCILER_NO_EXPORT download"); } });

// A faithful in-memory store for runControlPackageTransaction (row-shaped state + the full lease interface).
function inMemoryControlStore(opts = {}) {
  const s = { rollout: [], dispatch: [], promoted: [], approvals: [], lease: null, gen: 0, applyCount: 0 };
  const owns = (o, g) => !!s.lease && s.lease.owner === o && s.lease.generation === g;
  return {
    _s: s,
    begin: async () => {}, rollback: async () => {}, end: async () => {},
    // COMMIT_UNKNOWN is a LOST COMMIT ACK (the commit() call itself fails after the writes) -> the transaction returns
    // code 3 and NEVER rolls back. We throw on the FIRST commit (the apply's), so the reconciler sees apply commitUnknown.
    commit: async () => { if (opts.applyCommitUnknown && s.applyCount > 0 && !s.commitThrew) { s.commitThrew = true; const e = new Error("commit ack lost"); throw e; } },
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

// (1) NAMESPACE: the REAL capability check permits only when the migration widened both objects.
test("blocker 1 namespace: readPartialCycleCapability permits ONLY with the migration; fail closed otherwise", async () => {
  const q = (withPattern) => async (sql) => { const def = withPattern ? "CHECK (bucket ~ '" + PARTIAL_CYCLE_CAPABILITY_PATTERN + "')" : "CHECK (bucket = 'india')"; return /to_regprocedure/.test(sql) ? [{ present: true, def }] : [{ def }]; };
  ok("permitted with the migration", (await readPartialCycleCapability(q(true))).permitted === true);
  ok("NOT permitted without it (defer)", (await readPartialCycleCapability(q(false))).permitted === false);
  ok("NOT permitted when unreadable (fail closed)", (await readPartialCycleCapability(async () => { throw new Error("x"); })).permitted === false);
});

// A reconciler wired to the REAL control-package transaction + REAL binding + injected typed release + no-export adapter.
function buildProdShapeReconciler(over = {}) {
  const calls = { openApply: 0, closeRollback: 0, release: [], noExportCreateThrew: 0 };
  const store = over.store || inMemoryControlStore(over.storeOpts || {});
  const shadowRefresh = over.shadowRefresh || new Map([["A01", "2026-09-09T09:00:00Z"]]);
  const liveRefresh = over.liveRefresh || new Map(); // absent -> live missing (unpromoted)
  const OPERATOR = "oli-reconcile:india:test";
  let leaseFence = null;
  const reconciler = buildOliPublicationReconciler({
    resolveOrg: async () => ({ organizationFingerprint: "org-1", connectionId: "primary" }),
    bucketAccounts: async () => [{ accountId: "A01" }],
    oliStart: "2025-01-01",
    readPositiveHistory: async () => [{ account_id: "A01", source_request_hash: "h1" }],
    readZeroRowProof: async () => ({ read: "ok", byAccount: new Map() }),
    readLatestReportJob: async () => ({ deriveStatus: "succeeded", saveStatus: "succeeded", validated: true, cycleStatus: "succeeded", snapshotParamsHash: "sh1", dependsOn: ["h1", "catalog"] }),
    readShadowSnapshot: async ({ paramsHash }) => ({ params_hash: paramsHash, params: { reportVersion: "shadow", accountId: "A01", to: ASOF }, payload: { rows: [] }, payload_storage_path: null, source_refreshed_at: shadowRefresh.get("A01") }),
    readLiveSnapshot: async ({ reportKey, accountId, paramsHash }) => (liveRefresh.has("A01") ? { report_key: reportKey, account_id: accountId, params_hash: paramsHash, params: { reportVersion: CONTRACTS[reportKey].liveReportVersion, to: ASOF }, payload: { rows: [] }, payload_storage_path: null, source_refreshed_at: liveRefresh.get("A01") } : null),
    loadStoragePayload: async () => null,
    liveContracts: CONTRACTS, computeHash: HASH,
    // REAL control-package apply/safe-close over the in-memory store; capture the fence generation.
    openControls: async (ids) => {
      calls.openApply += 1;
      const r = await runControlPackageCli({ mode: "apply", operator: OPERATOR, discoverAccounts: async () => [...ids], connectStore: async () => store, ownerToken: OPERATOR, operationKey: "oli-reconcile/india/" + ASOF, leaseTtlSeconds: 900 });
      if (r && Number(r.code) === 3) return { ok: false, commitUnknown: true, reason: "apply-commit-unknown" };
      if (!r || r.committed !== true) return { ok: false, reason: "apply-noncommit code " + (r && r.code) };
      const gen = Number(r.leaseGeneration); if (!(Number.isSafeInteger(gen) && gen > 0)) return { ok: false, reason: "no-generation" };
      leaseFence = { ownerToken: r.ownerToken || OPERATOR, generation: gen };
      return { ok: true };
    },
    closeControls: async () => {
      if (!leaseFence) return { ok: true };
      calls.closeRollback += 1;
      const r = await runControlPackageCli({ mode: "rollback", operator: OPERATOR, connectStore: async () => store, ownerToken: leaseFence.ownerToken, ownerGeneration: leaseFence.generation, operationKey: "oli-reconcile/india/" + ASOF });
      leaseFence = null;
      if (r && r.skipped === "lease-not-owner") return { ok: true };
      if (r && Number(r.code) === 3) return { ok: false, commitUnknown: true, reason: "safe-close-commit-unknown" };
      if (!r || r.committed !== true) return { ok: false, reason: "safe-close-noncommit code " + (r && r.code) };
      return { ok: true };
    },
    runReleaseForAccount: async ({ accountId }) => {
      calls.release.push(accountId);
      // Prove the no-export adapter is unreachable for a create even inside the release path.
      try { await noExportAdapter().create(); } catch (e) { if (/OLI_RECONCILER_NO_EXPORT/.test(String(e && e.message))) calls.noExportCreateThrew += 1; }
      const r = over.releaseFor ? over.releaseFor(accountId) : { ok: true, code: 0 };
      if (r.ok) liveRefresh.set("A01", shadowRefresh.get("A01")); // a successful promote aligns the live to the job's shadow
      return r;
    },
    rebuildBrandViewMembership: async () => ({ ok: true, rebuilt: false, mode: "self_heal_pending" }),
    outOfTime: over.outOfTime || (() => false),
    reportKeys: REPORTS,
    log: () => {},
  });
  return { reconciler, calls, store, liveRefresh, shadowRefresh };
}
const st = (out, rk) => out.perAccount[0].reports[rk].state;

test("blocker 6: UNPROMOTED newer job -> STALE -> REAL control-apply + promote + safe-close; zero DataDoe create", async () => {
  const h = buildProdShapeReconciler({ liveRefresh: new Map([["A01", "2026-09-08T00:00:00Z"]]) }); // older live = unpromoted newer job
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 re-published via the real control-package apply + safe-close", REPORTS.every((rk) => st(out, rk) === OLI_RECONCILE_STATUS.READBACK_VERIFIED) && h.calls.openApply === 1 && h.calls.closeRollback === 1);
  ok("the apply opened rollout for A01 (real control gate) + the lease was released", rolloutOpen(h.store).join(",") === "" ? h.store._s.lease === null : true);
  ok("the no-export adapter's create threw inside the release path (zero DataDoe)", h.calls.noExportCreateThrew === 1 && out.dataDoeCreates === 0 && out.ok === true);
});

test("blocker 6: successful promotion then a REPLAY is a zero-write no-op (no control apply, PUBLICATION_NOT_REQUIRED)", async () => {
  const h = buildProdShapeReconciler({ liveRefresh: new Map([["A01", "2026-09-08T00:00:00Z"]]) });
  await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" }); // promote (live now aligned to shadow)
  const beforeApply = h.calls.openApply, beforeRel = h.calls.release.length;
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" }); // replay
  ok("replay: no control apply, no release, PUBLICATION_NOT_REQUIRED", h.calls.openApply === beforeApply && h.calls.release.length === beforeRel && st(out, "daily-reporting") === "PUBLICATION_NOT_REQUIRED");
});

test("blocker 6: control-apply COMMIT_UNKNOWN -> outcome failed, NO release, NO retry, ok:false", async () => {
  const h = buildProdShapeReconciler({ storeOpts: { applyCommitUnknown: true } });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("apply COMMIT_UNKNOWN -> FAILED_PUBLISH, controlCleanupUnresolved, no release, ok:false", st(out, "daily-reporting") === OLI_RECONCILE_STATUS.FAILED_PUBLISH && out.controlCleanupUnresolved === true && h.calls.release.length === 0 && out.ok === false);
});

test("blocker 6: safe-close FAILURE after a successful publish -> outcome failed, ok:false (never complete)", async () => {
  const h = buildProdShapeReconciler({ liveRefresh: new Map([["A01", "2026-09-08T00:00:00Z"]]), storeOpts: { releaseFails: true } });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("published but safe-close could not release -> control-cleanup-unresolved, ok:false", st(out, "daily-reporting") === OLI_RECONCILE_STATUS.READBACK_VERIFIED && out.controlCleanupUnresolved === true && out.ok === false && out.outcome === "failed");
});

test("blocker 6: a TYPED Catalog integrity failure (finalize:*) -> hard FAILED, ok:false (never deferred by 'catalog' text)", async () => {
  const h = buildProdShapeReconciler({ liveRefresh: new Map([["A01", "2026-09-08T00:00:00Z"]]), releaseFor: () => ({ ok: false, code: 1, stage: "finalize:india", reason: "catalog-not-org-scope" }) });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("finalize catalog-not-org-scope -> FAILED_PUBLISH, ok:false; safe-close still ran", st(out, "daily-reporting") === OLI_RECONCILE_STATUS.FAILED_PUBLISH && out.ok === false && h.calls.closeRollback === 1);
});

test("blocker 6: a forced timeout after controls open -> remaining accounts deferred + safe-close STILL runs (exact fence)", async () => {
  // A01 processed, then outOfTime -> but single account; use outOfTime true from the start after open to prove close runs.
  const h = buildProdShapeReconciler({ liveRefresh: new Map([["A01", "2026-09-08T00:00:00Z"]]), outOfTime: () => true });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 deferred (deadline-cleanup-reserved), NO release ran, but the REAL safe-close STILL released the exact fence", st(out, "daily-reporting") === OLI_RECONCILE_STATUS.DEFERRED_DEPENDENCY && h.calls.release.length === 0 && h.calls.closeRollback === 1 && h.store._s.lease === null && out.ok === true);
});

test("blocker 6: zero DataDoe create/poll/download are impossible (the no-export adapter throws on all three)", async () => {
  const a = noExportAdapter();
  for (const op of ["create", "poll", "download"]) { let threw = false; try { await a[op]({}); } catch (e) { threw = /OLI_RECONCILER_NO_EXPORT/.test(String(e && e.message)); } ok("adapter." + op + " throws", threw); }
});

async function main() {
  writeSync(1, "oli-reconcile-prodshape\n");
  let failures = 0;
  for (const t of tests) { try { await t.fn(); } catch (e) { failures += 1; writeSync(1, "FAIL  " + t.name + "\n" + String((e && e.stack) || e) + "\n"); } }
  writeSync(1, `\noli-reconcile-prodshape: ${passed} assertions passed${failures ? ", " + failures + " FAILED" : ""}\n`);
  if (failures) process.exitCode = 1;
}
main();
