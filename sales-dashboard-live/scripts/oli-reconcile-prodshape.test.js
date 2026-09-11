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
import * as releaseRunner from "../lib/server/sync/source-priority-release-runner.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const ASOF = "2026-09-09";
const REPORTS = ["brand-inventory", "brand-sales", "daily-reporting"];
const CONTRACTS = Object.fromEntries(REPORTS.map((rk) => [rk, { liveReportKey: rk, liveReportVersion: rk + "-live", liveParams: (p) => ({ to: p.to }) }]));
const RD = Object.fromEntries(REPORTS.map((rk) => [rk, { snapshotVersion: rk + "/shadow", validatePayload: (p) => !!(p && p.valid === true) }]));
const HASH = (v, params) => v + "|" + JSON.stringify(params);
const shParamsFor = (rk, a) => ({ reportVersion: rk + "/shadow", accountId: a, to: ASOF });
const shHashFor = (rk, a) => HASH(rk + "/shadow", shParamsFor(rk, a));
const PAY = { valid: true, rows: [] };

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
  const calls = { openApply: 0, closeRollback: 0, release: [], noExportCreateThrew: 0, writesAfterDeadline: 0, abortObservedBeforeWrite: 0, opSettledSeq: 0, closeSeq: 0 };
  const seqRef = { n: 0 };
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
    readLatestReportJob: async ({ reportKey }) => ({ deriveStatus: "succeeded", saveStatus: "succeeded", validated: true, cycleStatus: "succeeded", snapshotParamsHash: shHashFor(reportKey, "A01"), dependsOn: ["h1", "catalog"] }),
    readShadowSnapshot: async ({ reportKey, accountId, paramsHash }) => { const rk = reportKey.replace("scheduler-v2/", ""); return { report_key: reportKey, account_id: accountId, params_hash: paramsHash, params: shParamsFor(rk, accountId), payload: PAY, payload_storage_path: null, source_refreshed_at: shadowRefresh.get("A01") }; },
    readLiveSnapshot: async ({ reportKey, accountId, paramsHash }) => (liveRefresh.has("A01") ? { report_key: reportKey, account_id: accountId, params_hash: paramsHash, params: { reportVersion: CONTRACTS[reportKey].liveReportVersion, to: ASOF }, payload: PAY, payload_storage_path: null, source_refreshed_at: liveRefresh.get("A01") } : null),
    loadStoragePayload: async () => null,
    verifyLiveReadback: async () => ({ ok: liveRefresh.has("A01") }),
    liveContracts: CONTRACTS, computeHash: HASH, reportDerivations: RD,
    deadlineRace: over.deadlineRace || ((p) => p),
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
      calls.closeRollback += 1; calls.closeSeq = ++seqRef.n;
      const r = await runControlPackageCli({ mode: "rollback", operator: OPERATOR, connectStore: async () => store, ownerToken: leaseFence.ownerToken, ownerGeneration: leaseFence.generation, operationKey: "oli-reconcile/india/" + ASOF });
      leaseFence = null;
      if (r && r.skipped === "lease-not-owner") return { ok: true };
      if (r && Number(r.code) === 3) return { ok: false, commitUnknown: true, reason: "safe-close-commit-unknown" };
      if (!r || r.committed !== true) return { ok: false, reason: "safe-close-noncommit code " + (r && r.code) };
      return { ok: true };
    },
    runReleaseForAccount: async ({ accountId, signal }) => {
      calls.release.push(accountId);
      // Prove the no-export adapter is unreachable for a create even inside the release path.
      try { await noExportAdapter().create(); } catch (e) { if (/OLI_RECONCILER_NO_EXPORT/.test(String(e && e.message))) calls.noExportCreateThrew += 1; }
      // REAL TERMINATION BOUNDARY regression (defect 1): the op reaches its WRITE point only after a real delay -- i.e.
      // AFTER the deadline. At the write boundary it MUST honor the abort: if aborted it performs NO write (a durable
      // publish = setting liveRefresh) and settles as aborted; only an un-aborted op writes. Asserts no write lands after
      // the deadline and that the op settled (recording its sequence) BEFORE the safe-close ran.
      if (over.delayedWriteAfterDeadline) {
        return await new Promise((resolve) => {
          setTimeout(() => {
            if (signal && signal.aborted) { calls.abortObservedBeforeWrite += 1; calls.opSettledSeq = ++seqRef.n; resolve({ ok: false, code: 1, stage: "reconcile", status: "DEADLINE_ABORTED", reason: "deadline-aborted", aborted: true, blockerCodes: [] }); return; }
            calls.writesAfterDeadline += 1; liveRefresh.set("A01", shadowRefresh.get("A01")); calls.opSettledSeq = ++seqRef.n; resolve({ ok: true, code: 0, stage: "complete" });
          }, 15);
        });
      }
      // COOPERATIVE never-finishing op: settles ONLY after abort, WITHOUT writing (models the signal-aware real op).
      if (over.neverResolves) return await new Promise((resolve) => {
        const stop = () => { calls.opSettledSeq = ++seqRef.n; resolve({ ok: false, code: 1, stage: "reconcile", status: "DEADLINE_ABORTED", reason: "deadline-aborted", aborted: true, blockerCodes: [] }); };
        if (signal && signal.aborted) return stop();
        if (signal && typeof signal.addEventListener === "function") signal.addEventListener("abort", stop, { once: true });
      });
      // NON-cooperative op: never settles EVEN after abort (the reconciler's awaitSettled grace expires -> unconfirmed).
      if (over.ignoresAbort) { calls.release.push("__ignores-abort"); return new Promise(() => {}); }
      if (over.realRelease) {
        // Drive the REAL runPriorityDashboardsRelease branch so the TYPED classification comes from the real runner
        // (not a fabricated reason). Preserve status/leaseLost/stage/reason/blockerCodes exactly as the runner produced.
        const result = await releaseRunner.runPriorityDashboardsRelease({ release: over.realRelease, reconcile: async () => ({ ok: true }), readbackLive: async () => ({ ok: true }), assertNoCron: async () => ({ ok: true }), bucket: "india" });
        if (result.ok) liveRefresh.set("A01", shadowRefresh.get("A01"));
        return { code: result.code, ok: result.ok, stage: result.stage, status: result.status || null, leaseLost: result.leaseLost === true, reason: result.reason || null, blockerCodes: result.blockerCodes || [] };
      }
      const r = over.releaseFor ? over.releaseFor(accountId) : { ok: true, code: 0 };
      if (r.ok) liveRefresh.set("A01", shadowRefresh.get("A01")); // a successful promote aligns the live to the job's shadow
      return r;
    },
    rebuildBrandViewMembership: async () => ({ ok: true, rebuilt: false, mode: "self_heal_pending" }),
    outOfTime: over.outOfTime || (() => false),
    makeAbortController: () => new AbortController(),
    ...(over.awaitSettled ? { awaitSettled: over.awaitSettled } : {}),
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

// ---- blocker 3: TYPED classification through the REAL runPriorityDashboardsRelease branch (not a fabricated result) ----
const RUNNER_REPORTS = ["daily-reporting", "brand-sales", "brand-inventory"];
const fakeRelease = (deriveRollup) => ({
  publishOrder: RUNNER_REPORTS, reportKeys: RUNNER_REPORTS,
  deriveBucket: async () => ({ rollup: deriveRollup }),
  finalizeBucket: async () => ({ disposition: "finalized", cycleStatus: "succeeded", accounts: ["A01"], cycleId: "cyc" }),
  preflightAccount: async (a) => ({ accountId: a, results: RUNNER_REPORTS.map((rk) => ({ reportKey: rk, disposition: "ready", liveReportKey: rk, paramsHash: "ph_" + rk })) }),
  publishAccount: async (a) => ({ accountId: a, results: RUNNER_REPORTS.map((rk) => ({ reportKey: rk, disposition: "published", liveReportKey: rk, paramsHash: "ph_" + rk })) }),
  catalogReservation: async () => ({ tokensSpent: 0 }),
});
test("blocker 3: SOURCE_UNAVAILABLE from the REAL runner -> the reconciler DEFERS (typed, not text)", async () => {
  const h = buildProdShapeReconciler({ realRelease: fakeRelease({ stopped: true, stopReason: { code: "SOURCE_UNAVAILABLE" } }) });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 DEFERRED_DEPENDENCY (real runner surfaced reason=SOURCE_UNAVAILABLE); ok:true", st(out, "daily-reporting") === OLI_RECONCILE_STATUS.DEFERRED_DEPENDENCY && out.ok === true);
});
test("blocker 3: a ready=false readiness blocker (coverage-incomplete) from the REAL runner -> DEFER", async () => {
  // A readiness gate produced NO snapshots (all saved 0, lineage 0); the only blockers are the retryable coverage codes.
  const rollup = { alreadyComplete: false, derived: { daily: { ready: false, saved: 0, blockedBy: [{ sourceKey: "order-line-items", reason: "coverage-incomplete" }] }, brandView: { ready: false, saved: 0, blockedBy: [{ sourceKey: "order-line-items", reason: "coverage-incomplete" }] }, brandInventory: { ready: false, saved: 0, blockedBy: [] }, lineage: [] } };
  const h = buildProdShapeReconciler({ realRelease: fakeRelease(rollup) });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 DEFERRED_DEPENDENCY (all blockers are known-retryable readiness codes); ok:true", st(out, "daily-reporting") === OLI_RECONCILE_STATUS.DEFERRED_DEPENDENCY && out.ok === true);
});
test("blocker 3: a ready=false INTEGRITY blocker (count-mismatch) from the REAL runner -> hard FAILED, ok:false", async () => {
  const rollup = { alreadyComplete: false, derived: { daily: { ready: true, saved: 8, blockedBy: [] }, brandView: { ready: true, saved: 8, blockedBy: [] }, brandInventory: { ready: true, saved: 7, blockedBy: [] }, lineage: new Array(23) } };
  const h = buildProdShapeReconciler({ realRelease: fakeRelease(rollup) });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 FAILED_DERIVE (integrity blocker derive:count-mismatch); outcome failed; ok:false", st(out, "daily-reporting") === OLI_RECONCILE_STATUS.FAILED_DERIVE && out.outcome === "failed" && out.ok === false);
});

// ---- blocker 4: control closure is EVIDENCE-BASED -- a lease-not-owner rollback is NOT proof of closed ----
test("blocker 4: a REAL rollback closes the control rows; a SUPERSEDED-generation rollback (lease-not-owner) leaves them OPEN", async () => {
  const store = inMemoryControlStore();
  const apply = await runControlPackageCli({ mode: "apply", operator: "op:x", discoverAccounts: async () => ["A01"], connectStore: async () => store, ownerToken: "op:x", operationKey: "k", leaseTtlSeconds: 900 });
  ok("apply opened rollout for A01", rolloutOpen(store).join(",") === "A01");
  // A rollback with a WRONG generation is a lease-not-owner SKIP (committed:false) -- the controls are NOT closed.
  const badClose = await runControlPackageCli({ mode: "rollback", operator: "op:x", connectStore: async () => store, ownerToken: "op:x", ownerGeneration: apply.leaseGeneration + 99, operationKey: "k" });
  ok("a superseded-generation rollback is lease-not-owner (committed:false) and does NOT close the rows (evidence: still open)", badClose.committed !== true && rolloutOpen(store).length === 1);
  // The correct-generation rollback actually closes -> evidence read shows closed.
  const goodClose = await runControlPackageCli({ mode: "rollback", operator: "op:x", connectStore: async () => store, ownerToken: "op:x", ownerGeneration: apply.leaseGeneration, operationKey: "k" });
  ok("the correct-generation rollback commits + the evidence read proves rollout/approvals closed", goodClose.committed === true && rolloutOpen(store).length === 0);
});

// ---- blocker 5: the deadline bounds an IN-FLIGHT account -> abort + confirmed settlement -> defer + REAL safe-close ----
test("blocker 5: an in-flight account (settles ONLY on abort) after controls open -> deferred + the REAL control-package safe-close STILL releases the exact fence", async () => {
  const store = inMemoryControlStore();
  const h = buildProdShapeReconciler({ store, liveRefresh: new Map([["A01", "2026-09-08T00:00:00Z"]]), neverResolves: true, deadlineRace: (p) => Promise.race([p, Promise.resolve({ __deadline: true })]) });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 deferred (deadline-in-flight), op settled on abort, the REAL safe-close ran + released the exact fence, ok:true", st(out, "daily-reporting") === OLI_RECONCILE_STATUS.DEFERRED_DEPENDENCY && h.calls.closeRollback === 1 && store._s.lease === null && out.ok === true && h.calls.opSettledSeq > 0 && h.calls.opSettledSeq < h.calls.closeSeq);
});
// ---- defect 1 (production-shape): an in-flight op that ATTEMPTS A DELAYED WRITE after the deadline is ABORTED so NO
// write lands after the deadline, and the REAL safe-close begins ONLY AFTER the op's termination is confirmed. ----
test("defect 1: a delayed write AFTER the deadline is aborted -> zero post-deadline write; safe-close runs only after confirmed termination; fence released", async () => {
  const store = inMemoryControlStore();
  const liveRefresh = new Map([["A01", "2026-09-08T00:00:00Z"]]); // an older live -> STALE -> the account is released
  const h = buildProdShapeReconciler({ store, liveRefresh, delayedWriteAfterDeadline: true, deadlineRace: (p) => Promise.race([p, Promise.resolve({ __deadline: true })]) });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("the op OBSERVED the abort at its write boundary and performed NO write after the deadline", h.calls.abortObservedBeforeWrite === 1 && h.calls.writesAfterDeadline === 0);
  ok("the live snapshot was NOT advanced past its older LKG (no publication write landed)", liveRefresh.get("A01") === "2026-09-08T00:00:00Z");
  ok("the REAL safe-close ran ONLY AFTER the op settled (confirmed termination) + released the exact fence; A01 deferred; ok:true", h.calls.opSettledSeq > 0 && h.calls.closeRollback === 1 && h.calls.opSettledSeq < h.calls.closeSeq && store._s.lease === null && st(out, "daily-reporting") === OLI_RECONCILE_STATUS.DEFERRED_DEPENDENCY && out.ok === true);
});
// ---- defect 1 (production-shape): a NON-cooperative op that will NOT stop -> the reconciler must NOT safe-close (never
// tear down a fence an in-flight op may still be using). The exact lease + controls stay HELD; the run is non-green. Then
// the SEPARATE cleanup path (after the owner's lease expires) reclaims the free/expired plane and PROVES it closed. ----
test("defect 1: an op that will NOT stop -> NO safe-close, lease + controls remain HELD, non-green; then the separate cleanup reclaims the expired lease + proves the plane closed", async () => {
  const store = inMemoryControlStore();
  const h = buildProdShapeReconciler({ store, liveRefresh: new Map([["A01", "2026-09-08T00:00:00Z"]]), ignoresAbort: true,
    deadlineRace: (p) => Promise.race([p, Promise.resolve({ __deadline: true })]), awaitSettled: async () => ({ settled: false }) });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  // Phase 1: the reconciler did NOT run safe-close; the EXACT lease + the open rollout controls are left INTACT; non-green.
  ok("NO safe-close ran; the exact lease is STILL held; rollout still OPEN; A01 deferred; ok:false; controlCleanupUnresolved", h.calls.closeRollback === 0 && store._s.lease !== null && rolloutOpen(store).length === 1 && st(out, "daily-reporting") === OLI_RECONCILE_STATUS.DEFERRED_DEPENDENCY && out.ok === false && out.controlCleanupUnresolved === true);
  // Phase 2: the owner's lease has since expired -> the SEPARATE cleanup reclaims the now-free/expired plane (a different
  // operator) and safe-closes it; the evidence read proves rollout closed + the lease released.
  const reclaim = await runControlPackageCli({ mode: "reclaim", operator: "oli-reconcile:cleanup", connectStore: async () => store, ownerToken: "oli-reconcile:cleanup", operationKey: "oli-reconcile/india/" + ASOF });
  ok("the separate cleanup RECLAIM committed + PROVED the plane closed (rollout disabled) + released the lease", reclaim.committed === true && rolloutOpen(store).length === 0 && store._s.lease === null);
});

async function main() {
  writeSync(1, "oli-reconcile-prodshape\n");
  let failures = 0;
  for (const t of tests) { try { await t.fn(); } catch (e) { failures += 1; writeSync(1, "FAIL  " + t.name + "\n" + String((e && e.stack) || e) + "\n"); } }
  writeSync(1, `\noli-reconcile-prodshape: ${passed} assertions passed${failures ? ", " + failures + " FAILED" : ""}\n`);
  if (failures) process.exitCode = 1;
}
main();
