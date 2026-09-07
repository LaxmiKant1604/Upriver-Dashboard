// Round-11 -- BIND PUBLICATION TO THE EXACT GENERATION THE MATCHING --apply CREATED + ATOMIC SAFE-CLOSE.
//
// Proves (fully offline; no Postgres, no network -- the lease RPC SQL itself stays offline-modeled +
// static-guarded in gate7/bootstrap):
//   P0-A publication RENEWS (never re-acquires): scheduler publication threads the EXACT --owner-generation the
//        matching --apply emitted and RENEWS that immutable fence. A/gen1 opens controls, gen1 expires, B applies
//        gen2 -> A's publication renew returns 'lost' -> CONTROL_LEASE_LOST, ZERO writes, and it NEVER re-acquires
//        (which would mint gen3 and publish under B's controls). A same-token stale gen1 renew is likewise 'lost'.
//   P0-B ATOMIC SAFE-CLOSE: runControlPackageTransaction verifies ownership UNDER A HELD LOCK (lockAndVerify)
//        through the safe-close + release + commit, so no takeover can wedge between verification and close; and
//        the release RESULT is CHECKED -- only disposition='released' may commit, else the WHOLE control
//        transaction rolls back every safe-close write and reports non-success.
//   SOURCE GUARDS: both publication scripts contain renew but NO acquire call + require --owner-generation; the
//        standalone acquire wrapper is gone from supabase.js; the workflow passes the matching apply generation;
//        the transaction uses lockAndVerify + the release-result check; the pg store's lockAndVerify holds the
//        advisory + FOR UPDATE row lock.
//
// 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildPriorityControlPackage, runControlPackageTransaction } from "../lib/server/sync/source-priority-control-package.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); };
writeSync(1, "round11-publication-fence\n");

const OPERATOR = "laxmikant@superboring.in";
const ACCT = ["IN1", "IN2"];
const validGen = (g) => Number.isSafeInteger(g) && g > 0;

// ============ A transactional, lease-capable in-memory control store mirroring priority-control-pg-store.js ====
// BEGIN snapshots control + lease state; ROLLBACK restores it; the lease acquire/renew/release/assert/lockAndVerify
// mirror the SQL RPCs (generation-fenced, exact equality). lockAndVerify sets a tx-scoped lock; a CONCURRENT
// operation (tryConcurrentAcquire) is BLOCKED while that lock is held -- modeling the advisory + FOR UPDATE locks.
// `forceRelease`, when PRESENT (an object { result }), makes releaseControlLease return exactly result.result --
// even when that is null/{}/undefined (so the "unexpected result" branch of item 5 is exercised faithfully).
function makeControlStore({ lease, forceRelease = undefined, onDisableRollout = null } = {}) {
  const clone = (m) => new Map(m);
  let rollout = new Map(ACCT.map((a) => [a, true]));
  let dispatch = new Map([["daily-reporting", true], ["brand-sales", true], ["returns-leakage", false]]);
  let promoted = new Map([["brand-inventory", true]]);
  let approvals = new Map(ACCT.flatMap((a) => ["daily-reporting", "brand-sales", "brand-inventory"].map((rk) => [rk + "|" + a, true])));
  let L = { owner: lease.owner, generation: lease.generation, expired: !!lease.expired };
  let snap = null; let lockHeld = false;
  const held = () => L.owner != null && !L.expired;
  const snapshot = () => ({ rollout: clone(rollout), dispatch: clone(dispatch), promoted: clone(promoted), approvals: clone(approvals), L: { ...L } });
  const restore = (s) => { rollout = clone(s.rollout); dispatch = clone(s.dispatch); promoted = clone(s.promoted); approvals = clone(s.approvals); L = { ...s.L }; };
  const store = {
    _state: () => snapshot(),
    _lockHeld: () => lockHeld,
    tryConcurrentAcquire: (owner) => {
      if (lockHeld) return { disposition: "blocked" }; // a different operation waits on the held advisory/row lock
      const gen = (L.generation || 0) + 1; L = { owner, generation: gen, expired: false };
      return { disposition: "acquired", generation: gen, owner_token: owner };
    },
    begin: async () => { snap = snapshot(); },
    commit: async () => { snap = null; lockHeld = false; },
    rollback: async () => { if (snap) restore(snap); snap = null; lockHeld = false; },
    readAllPrimary: async () => false,
    hasCron: async () => false,
    rolloutRows: async () => [...rollout].map(([account_id, enabled]) => ({ account_id, enabled })),
    dispatchRows: async () => [...dispatch].map(([report_key, schedule_enabled]) => ({ report_key, schedule_enabled })),
    promotedRows: async () => [...promoted].map(([report_key, publish_enabled]) => ({ report_key, publish_enabled })),
    approvalRows: async () => [...approvals].map(([k, approved]) => { const [rk, a] = k.split("|"); return { report_key: rk, account_id: a, approved }; }),
    setRolloutEnabled: async (ids) => { for (const a of ids) rollout.set(a, true); for (const a of [...rollout.keys()]) if (!ids.includes(a)) rollout.set(a, false); },
    setDispatchEnabled: async (keys, controlled) => { for (const rk of controlled) dispatch.set(rk, keys.includes(rk)); },
    setPromotedEnabled: async (keys) => { for (const rk of keys) promoted.set(rk, true); for (const rk of [...promoted.keys()]) if (!keys.includes(rk)) promoted.set(rk, false); },
    setApprovalsApproved: async (pairs) => { for (const p of pairs) approvals.set(p, true); for (const k of [...approvals.keys()]) if (!pairs.includes(k)) approvals.set(k, false); },
    disableAllRollout: async () => { if (onDisableRollout) await onDisableRollout(store); for (const a of [...rollout.keys()]) rollout.set(a, false); },
    pauseAllDispatch: async (controlled) => { for (const rk of controlled) dispatch.set(rk, false); },
    disableAllPromoted: async () => { for (const rk of [...promoted.keys()]) promoted.set(rk, false); },
    revokeAllApprovals: async () => { for (const k of [...approvals.keys()]) approvals.set(k, false); },
    acquireControlLease: async (owner) => {
      if (!held() || L.owner === owner) { const gen = L.owner === owner ? L.generation : (L.generation || 0) + 1; L = { owner, generation: gen, expired: false }; return { disposition: "acquired", generation: gen, owner_token: owner }; }
      return { disposition: "held", owner_token: L.owner };
    },
    renewControlLease: async (owner, gen) => { if (!validGen(gen)) return { disposition: "lost", reason: "invalid-generation" }; return held() && L.owner === owner && L.generation === gen ? { disposition: "renewed" } : { disposition: "lost" }; },
    releaseControlLease: async (owner, gen) => {
      if (forceRelease) return forceRelease.result;
      if (!validGen(gen)) return { disposition: "not-owner", reason: "invalid-generation" };
      if (held() && L.owner === owner && L.generation === gen) { L = { owner: null, generation: L.generation, expired: true }; return { disposition: "released" }; }
      return { disposition: L.generation !== gen ? "generation-superseded" : "not-owner" };
    },
    assertControlLeaseOwner: async (owner, gen) => validGen(gen) && held() && L.owner === owner && L.generation === gen,
    lockAndVerifyControlLease: async (owner, gen) => { if (!validGen(gen)) return false; lockHeld = true; return held() && L.owner === owner && L.generation === gen; },
  };
  return store;
}

const PKG = buildPriorityControlPackage({ accounts: ACCT, operator: OPERATOR });
const OWNER = "runA"; const GEN = 7;

/* ===================== A. runControlPackageTransaction: atomic verify + release-result check ============= */
{
  // (A1) HAPPY PATH: a valid owner+gen safe-close verifies under the lock, safe-closes, RELEASES ('released'), COMMITS.
  const store = makeControlStore({ lease: { owner: OWNER, generation: GEN, expired: false } });
  const r = await runControlPackageTransaction({ store, pkg: PKG, mode: "rollback", ownerToken: OWNER, ownerGeneration: GEN });
  const s = store._state();
  ok("A1: valid owner+gen safe-close commits, disables every control, revokes every approval, releases the lease",
    r.committed === true && [...s.rollout.values()].every((v) => v === false) && [...s.approvals.values()].every((v) => v === false)
    && [...s.promoted.values()].every((v) => v === false) && s.L.expired === true);
}
{
  // (A2) RELEASE FAILS after the safe-close writes -> throw -> WHOLE tx rolls back -> committed:false + REVERT.
  const store = makeControlStore({ lease: { owner: OWNER, generation: GEN, expired: false }, forceRelease: { result: { disposition: "not-owner" } } });
  const before = store._state();
  const r = await runControlPackageTransaction({ store, pkg: PKG, mode: "rollback", ownerToken: OWNER, ownerGeneration: GEN });
  const after = store._state();
  ok("A2: a non-'released' release result rolls back EVERY safe-close write + reports non-success (code 1, CONTROL_LEASE_RELEASE_FAILED, never committed:true)",
    r.committed === false && r.code === 1 && /CONTROL_LEASE_RELEASE_FAILED/.test(String(r.problem || ""))
    && JSON.stringify([...after.rollout.entries()]) === JSON.stringify([...before.rollout.entries()])
    && JSON.stringify([...after.approvals.entries()]) === JSON.stringify([...before.approvals.entries()])
    && JSON.stringify([...after.promoted.entries()]) === JSON.stringify([...before.promoted.entries()]));
}
{
  // (A3) each non-'released' disposition (generation-superseded / invalid-generation / unexpected / null) must
  //      THROW before commit -- never a silent committed:true.
  let allRollBack = true;
  for (const bad of [{ disposition: "generation-superseded" }, { disposition: "invalid-generation" }, { disposition: "weird" }, null, {}]) {
    const store = makeControlStore({ lease: { owner: OWNER, generation: GEN, expired: false }, forceRelease: { result: bad } });
    const before = store._state();
    const r = await runControlPackageTransaction({ store, pkg: PKG, mode: "rollback", ownerToken: OWNER, ownerGeneration: GEN });
    const after = store._state();
    if (!(r.committed === false && r.code === 1 && JSON.stringify([...after.rollout.entries()]) === JSON.stringify([...before.rollout.entries()]))) allRollBack = false;
  }
  ok("A3: EVERY non-'released' release outcome (superseded/invalid/unexpected/null/empty) rolls back the whole transaction", allRollBack);
}
{
  // (A4) SUPERSEDED at verify: B now owns gen9; A's stale gen7 lockAndVerify is false -> typed lease-not-owner
  //      skip, ZERO control writes.
  const store = makeControlStore({ lease: { owner: "runB", generation: 9, expired: false } });
  const before = store._state();
  const r = await runControlPackageTransaction({ store, pkg: PKG, mode: "rollback", ownerToken: OWNER, ownerGeneration: GEN });
  const after = store._state();
  ok("A4: a superseded generation at verification => lease-not-owner skip with ZERO control writes (never closes another owner's controls)",
    r.committed === false && r.leaseNotOwner === true && r.skipped === "lease-not-owner"
    && JSON.stringify([...after.rollout.entries()]) === JSON.stringify([...before.rollout.entries()])
    && JSON.stringify([...after.approvals.entries()]) === JSON.stringify([...before.approvals.entries()]));
}
{
  // (A5) ATOMICITY: while THIS tx holds the lock (from lockAndVerify through safe-close + release + commit) a
  //      CONCURRENT B takeover is BLOCKED; only AFTER commit can B acquire. Injected at the disableAllRollout
  //      seam, which runs AFTER verification -- inside the locked safe-close window.
  let during = null;
  const store = makeControlStore({
    lease: { owner: OWNER, generation: GEN, expired: false },
    onDisableRollout: (s) => { during = s.tryConcurrentAcquire("runB"); },
  });
  const r = await runControlPackageTransaction({ store, pkg: PKG, mode: "rollback", ownerToken: OWNER, ownerGeneration: GEN });
  const afterCommit = store.tryConcurrentAcquire("runB");
  ok("A5: the safe-close is ATOMIC w.r.t. ownership -- a concurrent takeover DURING the close is blocked; B can acquire ONLY after commit",
    r.committed === true && during && during.disposition === "blocked" && afterCommit.disposition === "acquired");
}
{
  // (A6) a rollback against a lease-capable store WITHOUT a valid ownerGeneration fails closed BEFORE BEGIN
  //      (a stale/missing generation can never close/release a newer lease). No writes.
  let threwCount = 0;
  for (const badGen of [null, undefined, 0, -1, 1.5, NaN, "7"]) {
    const store = makeControlStore({ lease: { owner: OWNER, generation: GEN, expired: false } });
    const before = store._state();
    let threw = false;
    try { await runControlPackageTransaction({ store, pkg: PKG, mode: "rollback", ownerToken: OWNER, ownerGeneration: badGen }); }
    catch (e) { threw = /valid ownerGeneration/.test(String(e && e.message)); }
    const after = store._state();
    if (threw && JSON.stringify([...after.rollout.entries()]) === JSON.stringify([...before.rollout.entries()])) threwCount += 1;
  }
  ok("A6: a rollback with an invalid/missing ownerGeneration fails closed BEFORE BEGIN (zero writes) for every bad value", threwCount === 7);
}

/* ===================== B. PUBLICATION RENEWS the apply generation -- NEVER re-acquires ===================== */
// An in-memory lease + a FENCED-CAS model mirroring cas_report_snapshot_if_newer_fenced. The publication gate
// under test is EXACTLY the scripts' shape: renew the SUPPLIED (owner, generation); renewed => publish under that
// fence; NOT-renewed => CONTROL_LEASE_LOST, publish nothing, and NEVER call acquire.
function makeLease({ owner, generation, expired = false }) {
  let L = { owner, generation, expired };
  const held = () => L.owner != null && !L.expired;
  return {
    _peek: () => ({ ...L }),
    renew: (o, g) => (validGen(g) && held() && L.owner === o && L.generation === g) ? { disposition: "renewed" } : { disposition: "lost" },
    // A re-acquire WOULD mint a NEW generation for a free/expired lease or a different owner -- the exact bug
    // publication must avoid. Spied so the test can assert it is NEVER called on the publication path.
    acquire: (o) => { const gen = (L.generation || 0) + 1; L = { owner: o, generation: gen, expired: false }; return { disposition: "acquired", generation: gen }; },
  };
}
// The fenced CAS: writes ONLY when the passed fence matches the live lease (owner + generation + unexpired).
function fencedCas(lease, fence, writes) {
  const L = lease._peek();
  if (!fence || !fence.ownerToken || !validGen(fence.generation)) return { outcome: "lease-lost", reason: "no-fence" };
  if (L.owner !== fence.ownerToken) return { outcome: "lease-lost", reason: "owner-changed" };
  if (L.generation !== fence.generation) return { outcome: "lease-lost", reason: "generation-superseded" };
  if (L.expired) return { outcome: "lease-lost", reason: "expired" };
  writes.push(fence); return { outcome: "inserted" };
}
// The publication gate EXACTLY as bootstrap-publish.mjs / priority-dashboards-release.mjs implement it.
function runPublicationGate({ lease, acquireSpy, runToken, ownerGeneration }) {
  const writes = [];
  const r = lease.renew(runToken, ownerGeneration); // RENEW the supplied fence -- never acquire
  if (!r || r.disposition !== "renewed") {
    return { classification: "CONTROL_LEASE_LOST", published: 0, writes, reAcquired: acquireSpy.calls > 0 };
  }
  const fence = { ownerToken: runToken, generation: ownerGeneration }; // EXACTLY the supplied fence (never adopted)
  const w = fencedCas(lease, fence, writes);
  return { classification: w.outcome === "inserted" ? "PUBLISHED" : "CONTROL_LEASE_LOST", published: writes.length, writes, reAcquired: acquireSpy.calls > 0 };
}
function spyAcquire(lease) { const spy = { calls: 0 }; const orig = lease.acquire.bind(lease); lease.acquire = (o) => { spy.calls += 1; return orig(o); }; return spy; }

{
  // (B1) VALID matching fence: A/gen1 still holds -> renew 'renewed' -> the fenced CAS writes exactly once.
  const lease = makeLease({ owner: "A", generation: 1 });
  const spy = spyAcquire(lease);
  const res = runPublicationGate({ lease, acquireSpy: spy, runToken: "A", ownerGeneration: 1 });
  ok("B1: publication with the EXACT matching apply fence renews + publishes exactly once (no acquire)",
    res.classification === "PUBLISHED" && res.published === 1 && res.reAcquired === false);
}
{
  // (B2) A/gen1 opens controls, gen1 EXPIRES, B applies gen2. A's publication (token A/gen1) renews -> 'lost' ->
  //      CONTROL_LEASE_LOST, ZERO writes, and it NEVER re-acquires (which would mint gen3 under B's controls).
  const lease = makeLease({ owner: "B", generation: 2 }); // B took over at gen2
  const spy = spyAcquire(lease);
  const res = runPublicationGate({ lease, acquireSpy: spy, runToken: "A", ownerGeneration: 1 });
  ok("B2: after gen1 expires and B applies gen2, A's publication is CONTROL_LEASE_LOST, writes ZERO, and NEVER re-acquires (no gen3, no publish under B's controls)",
    res.classification === "CONTROL_LEASE_LOST" && res.published === 0 && res.reAcquired === false && lease._peek().generation === 2);
}
{
  // (B3) SAME-TOKEN stale generation: A holds gen1 but publication is handed a stale gen (its own expired gen1
  //      after expiry) -> renew 'lost' -> zero writes, no reacquire. Modeled as an expired self-lease.
  const lease = makeLease({ owner: "A", generation: 1, expired: true });
  const spy = spyAcquire(lease);
  const res = runPublicationGate({ lease, acquireSpy: spy, runToken: "A", ownerGeneration: 1 });
  ok("B3: a same-token EXPIRED gen1 renew is 'lost' => CONTROL_LEASE_LOST, zero writes, never re-acquires a fresh generation",
    res.classification === "CONTROL_LEASE_LOST" && res.published === 0 && res.reAcquired === false);
}
{
  // (B4) even a WRONG generation for the CURRENT owner (A holds gen5, publication handed gen1) fails closed --
  //      the fence must be the EXACT emitted generation, not merely the same owner.
  const lease = makeLease({ owner: "A", generation: 5 });
  const spy = spyAcquire(lease);
  const res = runPublicationGate({ lease, acquireSpy: spy, runToken: "A", ownerGeneration: 1 });
  ok("B4: the SAME owner at a DIFFERENT generation still fails closed (exact-generation fence, zero writes, no reacquire)",
    res.classification === "CONTROL_LEASE_LOST" && res.published === 0 && res.reAcquired === false);
}

/* ===================== D. Round-12: the atomic lock is MANDATORY (partial lease store fails closed) ========= */
{
  // A PARTIAL lease store -- provides SOME lease methods but NOT the atomic lockAndVerifyControlLease -- must be
  // REFUSED before BEGIN with ZERO writes (a missing atomic lock can never silently downgrade the safe-close to a
  // non-locking check). Build a full control store, then DELETE lockAndVerifyControlLease to simulate the defect.
  const partial = makeControlStore({ lease: { owner: OWNER, generation: GEN, expired: false } });
  delete partial.lockAndVerifyControlLease; // now: acquire/renew/release/assert present, lockAndVerify MISSING
  const before = partial._state();
  let threw = false; let msg = "";
  try { await runControlPackageTransaction({ store: partial, pkg: PKG, mode: "rollback", ownerToken: OWNER, ownerGeneration: GEN }); }
  catch (e) { threw = true; msg = String(e && e.message); }
  const after = partial._state();
  ok("D1: a PARTIAL lease store (missing lockAndVerifyControlLease) is refused BEFORE BEGIN with zero writes (no non-locking fallback)",
    threw === true && /COMPLETE coherent lease interface/.test(msg) && /lockAndVerifyControlLease/.test(msg)
    && JSON.stringify([...after.rollout.entries()]) === JSON.stringify([...before.rollout.entries()]));
  // The SAME defect on APPLY is also refused before BEGIN (fencing can never be silently disabled on any mode).
  {
    const p2 = makeControlStore({ lease: { owner: "", generation: 0, expired: true } });
    delete p2.renewControlLease; // missing a DIFFERENT interface method
    let t2 = false; try { await runControlPackageTransaction({ store: p2, pkg: PKG, mode: "apply", ownerToken: OWNER }); } catch { t2 = true; }
    ok("D2: a PARTIAL lease store is refused on APPLY too (any missing interface method fails closed, zero writes)", t2 === true);
  }
  // A COMPLETE store still applies + safe-closes normally (positive control that the mandatory-interface guard
  // does not over-reject a coherent store).
  {
    const full = makeControlStore({ lease: { owner: "", generation: 0, expired: true } });
    const ap = await runControlPackageTransaction({ store: full, pkg: PKG, mode: "apply", ownerToken: OWNER });
    const cl = await runControlPackageTransaction({ store: full, pkg: PKG, mode: "rollback", ownerToken: OWNER, ownerGeneration: ap.leaseGeneration });
    ok("D3: a COMPLETE lease store still applies (acquires a generation) then safe-closes + releases (no over-rejection)",
      ap.committed === true && Number.isSafeInteger(ap.leaseGeneration) && ap.leaseGeneration > 0 && cl.committed === true);
  }
}

/* ===================== C. Round-11 SOURCE GUARDS ===================== */
{
  const bootstrapPub = read("scripts/release/bootstrap-publish.mjs");
  const priorityPub = read("scripts/release/priority-dashboards-release.mjs");
  const sbjs = read("lib/server/supabase.js");
  const ctlPkg = read("lib/server/sync/source-priority-control-package.js");
  const pgStore = read("lib/server/sync/priority-control-pg-store.js");
  const yml = read("../.github/workflows/scheduler-v2.yml");

  ok("C1: BOTH publication scripts RENEW the apply fence and contain NO acquireControlPlaneLease call (never re-acquire)",
    bootstrapPub.includes("renewControlPlaneLease") && !bootstrapPub.includes("acquireControlPlaneLease")
    && priorityPub.includes("renewControlPlaneLease") && !priorityPub.includes("acquireControlPlaneLease"));
  ok("C2: BOTH publication scripts REQUIRE a positive-integer --owner-generation (the exact generation the matching --apply emitted)",
    /--owner-generation is (required|REQUIRED)/.test(bootstrapPub) && /Number\.isSafeInteger\(ownerGeneration\) && ownerGeneration > 0/.test(bootstrapPub)
    && /STOP --owner-generation is REQUIRED/.test(priorityPub) && /Number\.isSafeInteger\(ownerGeneration\) && ownerGeneration > 0/.test(priorityPub));
  ok("C3: a non-'renewed' renew maps to CONTROL_LEASE_LOST with zero publication (exit 1) in BOTH scripts",
    /disposition !== "renewed"[\s\S]{0,400}CONTROL_LEASE_LOST/.test(bootstrapPub) && /disposition !== "renewed"[\s\S]{0,400}CONTROL_LEASE_LOST/.test(priorityPub)
    && bootstrapPub.includes("process.exit(1)") && priorityPub.includes("process.exit(1)"));
  ok("C4: supabase.js exports the renew + read heartbeat helpers but NO standalone acquireControlPlaneLease wrapper (publication can never re-acquire)",
    /export async function renewControlPlaneLease/.test(sbjs) && /export async function readControlPlaneLease/.test(sbjs)
    && !/export async function acquireControlPlaneLease/.test(sbjs) && !sbjs.includes("acquire_control_plane_lease"));
  ok("C5: the workflow threads the EXACT matching apply generation into each publication step (full -> full_controls, bootstrap -> bootstrap_controls)",
    yml.includes("priority-dashboards-release.mjs") && yml.includes("--owner-generation=${{ steps.full_controls.outputs.generation }}")
    && yml.includes("bootstrap-publish.mjs") && yml.includes("--owner-generation=${{ steps.bootstrap_controls.outputs.generation }}"));
  ok("C6: runControlPackageTransaction verifies ownership ATOMICALLY via store.lockAndVerifyControlLease(owner, ownerGeneration) with NO non-locking fallback, and CHECKS the release result (only 'released' commits)",
    ctlPkg.includes("store.lockAndVerifyControlLease(owner, ownerGeneration)") && !/verifyOwner\s*=/.test(ctlPkg)
    && /rel\.disposition !== "released"/.test(ctlPkg) && ctlPkg.includes("CONTROL_LEASE_RELEASE_FAILED"));
  ok("C7: the pg store's lockAndVerifyControlLease takes the advisory lock AND a FOR UPDATE row lock, then verifies exact owner + generation + unexpired against the POST-LOCK wall clock (clock_timestamp)",
    /lockAndVerifyControlLease:/.test(pgStore) && pgStore.includes("pg_advisory_xact_lock(hashtext('control-plane-lease'))")
    && /control_plane_lease where id = 1 for update/.test(pgStore) && pgStore.includes("expires_at > clock_timestamp()")
    && /Number\(row\.generation\) === Number\(generation\)/.test(pgStore));
  // Round-12: a PARTIAL lease store (any lease method present but not the COMPLETE interface) is refused BEFORE
  // BEGIN with zero writes -- a missing atomic lock can never silently disable fencing.
  ok("C8: a lease-enabled store must provide the COMPLETE coherent lease interface (acquire/renew/release/assert/lockAndVerify); a PARTIAL store is refused before BEGIN",
    ctlPkg.includes("LEASE_IFACE") && ctlPkg.includes("lockAndVerifyControlLease")
    && /a lease-enabled store must provide the COMPLETE coherent lease interface/.test(ctlPkg)
    && /leaseMethodsPresent\.length > 0 && leaseMethodsPresent\.length < LEASE_IFACE\.length/.test(ctlPkg));
  // Round-12: the stale-clock fix -- every lease/CAS RPC samples clock_timestamp() AFTER the blocking locks.
  const sql = read("supabase/migrations/20260919_account_onboarding.sql");
  ok("C9: every lease/CAS RPC samples clock_timestamp() AFTER pg_advisory_xact_lock + FOR UPDATE (never a stale transaction-start now() for an expiry decision)",
    (sql.match(/for update;\s*\n\s*v_now := clock_timestamp\(\);/g) || []).length >= 4
    && !/v_now timestamptz := now\(\)/.test(sql) // no lease RPC pre-samples now() into v_now
    && /'expired', \(expires_at is null or expires_at <= clock_timestamp\(\)\)/.test(sql)); // read_control_plane_lease uses wall clock
}

writeSync(1, `\nround11-publication-fence: ${passed} checks passed\n`);
