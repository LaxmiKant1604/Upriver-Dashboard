// "Publish from saved data" -- the EXECUTOR CORE (queue-driven; ONE request at a time). PURE over injected
// collaborators (store / gates / executor / read-back / control cleanup / clock), so every behaviour is offline-testable.
//
// ONE ITERATION (runOnce):
//   0. CHEAP PRE-CLAIM GATES (optional preGates): database / auth slow, a regional scheduler run in progress, the global
//      control lease held -> NO claim at all (no attempt used); the executor beats 'paused:<why>' (the dashboard shows
//      it) and sleeps (capped, so the liveness beat stays fresh). The database also refuses a second concurrent claim.
//   1. claim ONE due request with a database lease (claim_publish_request; an expired lease is re-claimed = crash
//      resume). Nothing due -> idle. The claim is the ONLY idle query: no scan, no polling of report tables.
//   2. LOAD GATES (before any work on the claimed request): another operation holds the global control-plane lease, a
//      regional scheduler run is in progress, the database / auth probe is slow, or a previous attempt left the control
//      plane unproven -> the request is RELEASED back to the queue (no attempt consumed) with reason 'waiting:<why>'
//      (the dashboard shows it) and the executor backs off.
//   3. EXECUTE with a heartbeat (renew_publish_request every leaseSeconds/3). A lost claim aborts the run: the fenced
//      publisher's control fence goes null, so the fenced CAS writes nothing.
//   4. VERIFY: a release that reported a publish (or current) is NEVER recorded on its own word -- the executor reads
//      the exact dashboard-served row back (brand-view-currency.js: the serve's own freshness rule) and records
//      'published' / 'already_current' ONLY when it is current; otherwise the request is retried (bounded by
//      max_attempts -> 'failed').
//   5. FINISH (bound to the claim token) + the zero-export tripwire: any blocked DataDoe request during the job fails the
//      request 'zero-export-violation' and STOPS the executor.
// Last-known-good is never touched on a failure: the only live writer is the fenced publisher, and it writes only after
// every release gate passed. 7-bit ASCII, LF.

import { REQUEST_STATUS, boundedReason } from "./contract.js";

const S = (v) => (v == null ? "" : String(v));
const errMsg = (e) => S(e && e.message ? e.message : e).replace(/[^\x20-\x7e]/g, "").slice(0, 160);

export const DEFAULTS = Object.freeze({
  leaseSeconds: 120,        // the request claim lease (renewed every leaseSeconds / 3)
  idleSeconds: 10,          // sleep when nothing is due
  maxBackoffSeconds: 120,   // cap for load / error backoff (short enough that the liveness beat stays fresh)
});

// preGates (optional, CHEAP, run BEFORE a claim -- a slow database / a scheduler run / a held control lease never costs a
// request an attempt); gates (run AFTER the claim: the control-plane closure proof); beat (optional liveness + state for
// the dashboard); onTrip (optional DURABLE stop -- disables the feature in the database so a restart cannot resume).
export function createPublishRequestWorker({
  workerId, store, gates, execute, readBack, cleanupControls = null, zeroExportBlocked = () => 0,
  preGates = null, beat = null, onTrip = null,
  newClaimToken, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {},
  config = {},
} = {}) {
  for (const [n, f] of [["store.claim", store && store.claim], ["store.renew", store && store.renew], ["store.finish", store && store.finish], ["gates", gates], ["execute", execute], ["readBack", readBack], ["newClaimToken", newClaimToken]]) {
    if (typeof f !== "function") throw new Error("createPublishRequestWorker requires " + n + " (fail closed).");
  }
  if (!/^[A-Za-z0-9._:-]{3,120}$/.test(S(workerId))) throw new Error("createPublishRequestWorker requires a workerId (fail closed).");
  const cfg = { ...DEFAULTS, ...config };
  let stopped = false;
  let tripped = null;
  let loadBackoff = 0;
  const zeroAtStart = () => Number(zeroExportBlocked()) || 0;

  async function finish(job, claimToken, status, { reason = null, result = null, retrySeconds = null } = {}) {
    try {
      const r = await store.finish({ id: job.id, claimToken, status, reason: boundedReason(reason), result, retrySeconds });
      return r && typeof r === "object" ? r : { outcome: "unknown" };
    } catch (e) { log("finish failed for " + job.id + ": " + errMsg(e)); return { outcome: "finish-threw" }; }
  }

  function startHeartbeat(job, claimToken, controller) {
    const everyMs = Math.max(5000, Math.floor((cfg.leaseSeconds * 1000) / 3));
    let failures = 0;
    const timer = setInterval(async () => {
      try {
        const ok = await store.renew({ id: job.id, claimToken, leaseSeconds: cfg.leaseSeconds });
        if (ok === true) { failures = 0; return; }
        failures = 99; // explicit loss of the claim (another executor re-claimed an expired lease)
      } catch { failures += 1; }
      if (failures >= 2) { log("claim lost for " + job.id + " -- aborting the run (the fenced CAS writes nothing)"); controller.abort(); clearInterval(timer); }
    }, everyMs);
    if (typeof timer.unref === "function") timer.unref();
    return () => clearInterval(timer);
  }

  async function safeBeat(state) { if (typeof beat === "function") { try { await beat({ worker: workerId, state }); } catch { /* liveness only */ } } }
  async function trip(reason) {
    tripped = reason;
    if (typeof onTrip === "function") { try { await onTrip({ reason }); } catch (e) { log("durable trip failed: " + errMsg(e)); } }
  }
  const backoff = () => { loadBackoff = Math.min(cfg.maxBackoffSeconds, loadBackoff ? loadBackoff * 2 : 30); return loadBackoff; };

  /** One iteration. -> { did: 'idle'|'released'|'finished'|'stopped'|'claim-error', status?, reason?, waitSeconds } */
  async function runOnce() {
    if (stopped || tripped) return { did: "stopped", reason: tripped, waitSeconds: 0 };
    // (1a) CHEAP pre-claim gates: pause WITHOUT claiming (no attempt consumed, nothing written but the beat).
    if (typeof preGates === "function") {
      let pre;
      try { pre = await preGates(); } catch (e) { pre = { ok: false, reason: "gate-probe-failed:" + errMsg(e), load: true }; }
      if (!pre || pre.ok !== true) {
        const wait = pre && pre.load ? backoff() : Math.min(cfg.maxBackoffSeconds, Math.max(30, Number(pre && pre.waitSeconds) || 60));
        await safeBeat("paused:" + S(pre && pre.reason).slice(0, 100));
        return { did: "paused", reason: S(pre && pre.reason), waitSeconds: wait };
      }
      loadBackoff = 0;
      await safeBeat("ready");
    }
    const claimToken = newClaimToken();
    let job = null;
    try { job = await store.claim({ worker: workerId, claimToken, leaseSeconds: cfg.leaseSeconds }); }
    catch (e) { log("claim failed: " + errMsg(e)); return { did: "claim-error", reason: errMsg(e), waitSeconds: backoff() }; }
    if (!job || !job.id) return { did: "idle", waitSeconds: cfg.idleSeconds };

    // (2) load gates -- before ANY work on this request.
    let gate;
    try { gate = await gates({ job }); } catch (e) { gate = { ok: false, reason: "gate-probe-failed:" + errMsg(e), load: true }; }
    // The control plane was left OPEN by a crashed window (ours or any publisher's) whose lease has EXPIRED: reclaim +
    // safe-close it (evidence-based, the route CLI's --cleanup) before opening a new window. A LIVE owner is never
    // touched (that is 'control-lease-held', a plain wait).
    if (gate && gate.ok !== true && gate.needsCleanup === true && typeof cleanupControls === "function") {
      let c;
      try { c = await cleanupControls({ job, runToken: S(job.run_token) }); } catch (e) { c = { closed: false, reason: errMsg(e) }; }
      if (c && c.closed === true) { log("stale control window reclaimed + safe-closed before " + job.id); gate = { ok: true }; }
      else gate = { ok: false, reason: "controls-unresolved", waitSeconds: 120 };
    }
    if (!gate || gate.ok !== true) {
      const wait = gate && gate.load ? backoff() : Math.min(cfg.maxBackoffSeconds, Math.max(30, Number(gate && gate.waitSeconds) || 60));
      await finish(job, claimToken, "release", { reason: "waiting:" + S(gate && gate.reason), retrySeconds: wait });
      return { did: "released", reason: S(gate && gate.reason), waitSeconds: wait };
    }
    loadBackoff = 0;

    // (3) execute with a heartbeat.
    const controller = new AbortController();
    const stopBeat = startHeartbeat(job, claimToken, controller);
    const z0 = zeroAtStart();
    let exec;
    try { exec = await execute({ job, signal: controller.signal }); }
    catch (e) { exec = { finish: "retry", retrySeconds: 300, reason: "execute-threw:" + errMsg(e) }; }
    finally { stopBeat(); }
    // (5a) zero-export tripwire FIRST (any blocked DataDoe request during this job -- even a run whose claim was lost).
    if ((Number(zeroExportBlocked()) || 0) > z0) {
      await trip("zero-export-violation");
      if (!controller.signal.aborted) await finish(job, claimToken, REQUEST_STATUS.FAILED, { reason: "zero-export-violation", result: { runToken: S(job.run_token) } });
      log("ZERO-EXPORT VIOLATION during " + job.id + " -- executor stopped");
      return { did: "stopped", status: REQUEST_STATUS.FAILED, reason: tripped, waitSeconds: 0 };
    }
    if (controller.signal.aborted) {
      // Our claim was lost: another executor owns this request now; record nothing.
      return { did: "finished", status: "claim-lost", reason: "claim-lost", waitSeconds: cfg.idleSeconds };
    }
    if (exec && exec.controlCleanupUnresolved === true) log("control plane left unproven by " + job.id + " -- the next claim of any request cleans up first");

    const base = { runToken: S(job.run_token), unitState: exec && exec.unitState ? S(exec.unitState) : null, unitReason: exec && exec.unitReason ? S(exec.unitReason).slice(0, 160) : null, execMs: exec && Number.isFinite(exec.ms) ? exec.ms : null };
    const f = S(exec && exec.finish);
    // (4) verify by reading the exact dashboard-served row back.
    if (f === "verify" || f === "verify-or-fail") {
      const t = now();
      let rb;
      try { rb = await readBack({ job }); } catch (e) { rb = { current: false, reason: "readback-threw:" + errMsg(e) }; }
      const result = { ...base, readbackMs: now() - t, served: rb && rb.served ? rb.served : null, fingerprint: rb && rb.fingerprint ? S(rb.fingerprint) : null };
      if (rb && rb.current === true) {
        const status = f === "verify" && S(exec.unitState) === "READBACK_VERIFIED" ? REQUEST_STATUS.PUBLISHED : REQUEST_STATUS.ALREADY_CURRENT;
        const r = await finish(job, claimToken, status, { reason: status === REQUEST_STATUS.PUBLISHED ? "served-row-verified" : "served-row-current", result });
        return { did: "finished", status: r.status || status, waitSeconds: 0 };
      }
      if (f === "verify-or-fail") {
        const r = await finish(job, claimToken, REQUEST_STATUS.FAILED, { reason: "superseded-newer-live:" + S(rb && rb.reason), result });
        return { did: "finished", status: r.status || REQUEST_STATUS.FAILED, waitSeconds: 0 };
      }
      const r = await finish(job, claimToken, "retry", { reason: "readback-not-current:" + S(rb && rb.reason), result, retrySeconds: 120 });
      return { did: "finished", status: r.status || "queued", waitSeconds: 0 };
    }
    if (f === REQUEST_STATUS.MISSING_EVIDENCE || f === REQUEST_STATUS.FAILED) {
      const r = await finish(job, claimToken, f, { reason: exec.reason || f, result: base });
      return { did: "finished", status: r.status || f, waitSeconds: 0 };
    }
    if (f === "release") {
      const wait = Math.max(30, Number(exec.retrySeconds) || 120);
      await finish(job, claimToken, "release", { reason: "waiting:" + S(exec.reason || "contention"), result: base, retrySeconds: wait });
      return { did: "released", reason: S(exec.reason), waitSeconds: Math.min(wait, 60) };
    }
    const r = await finish(job, claimToken, "retry", { reason: exec && exec.reason ? exec.reason : "retry", result: base, retrySeconds: Math.max(30, Number(exec && exec.retrySeconds) || 120) });
    return { did: "finished", status: r.status || "queued", waitSeconds: 0 };
  }

  async function loop({ maxIterations = Infinity } = {}) {
    let i = 0;
    while (!stopped && !tripped && i < maxIterations) {
      i += 1;
      const r = await runOnce();
      if (r.did === "stopped") break;
      if (r.waitSeconds > 0 && !stopped) await sleep(Math.min(r.waitSeconds, cfg.maxBackoffSeconds) * 1000);
    }
    return { iterations: i, tripped };
  }

  return Object.freeze({ runOnce, loop, stop: () => { stopped = true; }, tripped: () => tripped });
}
