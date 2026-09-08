// Account-keyed load-guard tests (audit 2026-09-08). Drives the REAL makeScopedLoader the FBA plan config load uses in
// App.jsx, over deliberately-delayed async, to prove that a slow/failed/superseded response can never overwrite the
// active account's state: account A->B and A->B->A races, and a failed request. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { makeScopedLoader } from "../src/lib/scoped-loader.js";

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); };
writeSync(1, "scoped-loader\n");

// A tiny simulator of the App load: `live` mirrors selectedAccountIdRef.current; each load begins a guard, awaits its
// OWN deferred response (one per load, so an A->B->A sequence has two distinct A responses), and only writes `applied`
// when isCurrent(). `resolve(acct, cfg)`/`reject(acct, err)` settle the OLDEST unsettled load for that account, so a
// test can resolve A1 before A2.
function makeSim() {
  const state = { live: null, applied: null, error: null };
  const loader = makeScopedLoader(() => state.live);
  const pending = []; // { acct, resolve, reject, settled }
  const load = (acct) => {
    state.live = acct; // switching to this account (mirrors setSelectedAccountId + the ref effect)
    const isCurrent = loader.begin(acct);
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    pending.push({ acct, resolve, reject });
    return promise.then((cfg) => { if (isCurrent()) { state.applied = { acct, cfg }; state.error = null; } },
      (e) => { if (isCurrent()) { state.applied = null; state.error = { acct, message: String(e.message || e) }; } });
  };
  const take = (acct) => pending.find((p) => p.acct === acct && !p.settled);
  const resolve = (acct, cfg) => { const p = take(acct); p.settled = true; p.resolve(cfg); };
  const reject = (acct, err) => { const p = take(acct); p.settled = true; p.reject(err); };
  const settle = () => Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve()); // flush microtasks
  return { state, load, resolve, reject, settle };
}

/* ===== A. A -> B: a slow A response that resolves AFTER switching to B never overwrites B ===== */
await (async () => {
  const sim = makeSim();
  const pA = sim.load("A"); // A in flight
  const pB = sim.load("B"); // switch to B (B in flight, live = B)
  sim.resolve("B", { for: "B" });
  await pB; await sim.settle();
  ok("A1: B applied while A still in flight", sim.state.applied && sim.state.applied.acct === "B");
  sim.resolve("A", { for: "A" }); // A resolves LATE
  await pA; await sim.settle();
  ok("A2: the late A response is DISCARDED (B stays applied, not overwritten by the stale account)", sim.state.applied.acct === "B" && sim.state.applied.cfg.for === "B");
})();

/* ===== B. A -> B -> A: the FIRST A and the B load are both superseded by the SECOND A ===== */
await (async () => {
  const sim = makeSim();
  const pA1 = sim.load("A"); // first A
  const pB = sim.load("B");  // B
  const pA2 = sim.load("A"); // back to A (live = A, newest generation)
  // Resolve out of order: A1 first, then B, then A2.
  sim.resolve("A", { seq: "A1" }); await sim.settle();
  ok("B1: the FIRST A response does not apply (superseded by the later A load's generation)", sim.state.applied === null || sim.state.applied.cfg.seq !== "A1");
  sim.resolve("B", { seq: "B" }); await sim.settle();
  ok("B2: the B response does not apply (live account is A)", sim.state.applied === null || sim.state.applied.acct !== "B");
  sim.resolve("A", { seq: "A2" }); await pA2; await sim.settle();
  await Promise.allSettled([pA1, pB]);
  ok("B3: only the SECOND A response (current generation + live scope) applies", sim.state.applied && sim.state.applied.acct === "A" && sim.state.applied.cfg.seq === "A2");
})();

/* ===== C. a FAILED request for a stale account never clobbers the active account (no defaults-as-saved) ===== */
await (async () => {
  const sim = makeSim();
  const pA = sim.load("A");
  const pB = sim.load("B");
  sim.resolve("B", { for: "B" }); await pB; await sim.settle();
  ok("C1: B applied", sim.state.applied && sim.state.applied.acct === "B" && sim.state.error === null);
  sim.reject("A", new Error("db down")); // A's request fails LATE
  await Promise.allSettled([pA]); await sim.settle();
  ok("C2: the stale A FAILURE is discarded -> no error shown for B, B config intact (a read failure never wipes the active account)", sim.state.error === null && sim.state.applied.acct === "B");
})();

/* ===== D. a failure for the CURRENT account DOES surface (so the UI can show 'couldn't load', not defaults) ===== */
await (async () => {
  const sim = makeSim();
  const pA = sim.load("A");
  sim.reject("A", new Error("db down"));
  await Promise.allSettled([pA]); await sim.settle();
  ok("D1: a failure for the still-current account surfaces a typed error (never silently applies defaults)", sim.state.applied === null && sim.state.error && sim.state.error.acct === "A" && /db down/.test(sim.state.error.message));
})();

/* ===== E. same-account reload (post-upload) applies normally ===== */
await (async () => {
  const sim = makeSim();
  const p1 = sim.load("A"); sim.resolve("A", { v: 1 }); await p1; await sim.settle();
  const p2 = sim.load("A"); sim.resolve("A", { v: 2 }); await p2; await sim.settle();
  ok("E1: a same-account reload applies the newest response", sim.state.applied.acct === "A" && sim.state.applied.cfg.v === 2);
})();

writeSync(1, `\nscoped-loader: ${passed} checks passed\n`);
