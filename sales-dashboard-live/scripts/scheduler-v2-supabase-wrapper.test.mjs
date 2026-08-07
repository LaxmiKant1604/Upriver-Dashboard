// Scheduler v2 Phase 1c -- production Supabase-wrapper tests (offline).
//
// Exercises the REAL lib/server/supabase.js wrappers -- not an in-memory double -- to
// prove a durable-write invariant: upsertSyncSourceJob REJECTS a job with a missing/empty
// organization_fingerprint BEFORE issuing any PostgREST request, so a fingerprint-less job
// is never written (never as an empty string) and never reaches the one-attempt claim
// (claim_source_export_attempt), which keys organization routing off that durable row.
//
// Dummy Supabase env is set BEFORE supabase.js is imported (it reads env at module load),
// then global fetch is replaced with a spy that RECORDS every call and throws a sentinel.
// A guarded rejection with ZERO recorded fetches proves the guard short-circuits before the
// network; a well-formed job is the positive control that DOES reach fetch. No module body
// top-level await (keeps `node --check` and piped runs happy). Every byte is 7-bit ASCII/LF.
//
// Run with: npm run test:scheduler-v2

import assert from "node:assert/strict";

// Set dummy configuration BEFORE the dynamic import of supabase.js so requireConfiguration()
// passes and the code actually reaches the fetch boundary in the positive control.
process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

let passed = 0;
const tests = [];
const atest = (name, fn) => tests.push({ name, fn });

// Install a fetch spy that records each request URL and throws a recognizable sentinel, so
// ANY PostgREST/network call is both observable and prevented from doing real I/O.
function withFetchSpy(run) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const e = new Error("SPY_FETCH_CALLED");
    e.code = "SPY_FETCH_CALLED";
    throw e;
  };
  return Promise.resolve(run(calls)).finally(() => { globalThis.fetch = original; });
}

const wellFormed = {
  cycleId: "cyc_1", requestHash: "h1", sourceId: "src", sourceKey: "sk",
  connectionId: "primary", organizationFingerprint: "org-fingerprint-abc",
  accountScopeHash: "ash", requestMeta: {}, bucket: "us",
};

atest("upsertSyncSourceJob REJECTS an empty organization fingerprint BEFORE any PostgREST request", async () => {
  const { upsertSyncSourceJob } = await import("../lib/server/supabase.js");
  await withFetchSpy(async (calls) => {
    await assert.rejects(
      upsertSyncSourceJob({ ...wellFormed, organizationFingerprint: "" }),
      /organization fingerprint|organizationFingerprint/i,
    );
    assert.equal(calls.length, 0, "no PostgREST request was issued for a fingerprint-less job");
  });
});

atest("upsertSyncSourceJob REJECTS a missing/undefined organization fingerprint (fail closed, no request)", async () => {
  const { upsertSyncSourceJob } = await import("../lib/server/supabase.js");
  const noFp = { ...wellFormed };
  delete noFp.organizationFingerprint;
  await withFetchSpy(async (calls) => {
    await assert.rejects(upsertSyncSourceJob(noFp), /organization fingerprint|organizationFingerprint/i);
    assert.equal(calls.length, 0, "still no PostgREST request for an undefined fingerprint");
  });
});

atest("positive control: a well-formed job DOES reach the sync_source_jobs PostgREST insert", async () => {
  const { upsertSyncSourceJob } = await import("../lib/server/supabase.js");
  await withFetchSpy(async (calls) => {
    // The spy throws at the network boundary; the point is that a well-formed job GETS there.
    await assert.rejects(upsertSyncSourceJob({ ...wellFormed }), /SPY_FETCH_CALLED/);
    assert.equal(calls.length, 1, "a well-formed job issues exactly one PostgREST request");
    assert.match(calls[0], /\/rest\/v1\/sync_source_jobs/, "and it targets the sync_source_jobs table");
  });
});

atest("the fingerprint guard runs before the one-attempt claim: a rejected upsert never writes the row the claim needs", async () => {
  const { upsertSyncSourceJob, claimSourceExportAttempt } = await import("../lib/server/supabase.js");
  await withFetchSpy(async (calls) => {
    // In the worker's order, upsertSyncSourceJob writes the durable row FIRST; only later does
    // claim_source_export_attempt operate on it. A fingerprint-less job dies at the upsert with
    // zero requests, so the claim RPC is never reachable for it.
    await assert.rejects(upsertSyncSourceJob({ ...wellFormed, organizationFingerprint: "" }), /fingerprint/i);
    assert.ok(!calls.some((u) => /claim_source_export_attempt/.test(u)), "the one-attempt claim RPC was never called");
    assert.ok(!calls.some((u) => /sync_source_jobs/.test(u)), "and no durable job row was inserted");
    // Sanity: the claim wrapper itself is a real PostgREST call (proves the guard, not a stub,
    // is what stopped us above).
    await assert.rejects(claimSourceExportAttempt("cyc_1", "h1"), /SPY_FETCH_CALLED/);
    assert.ok(calls.some((u) => /rpc\/claim_source_export_attempt/.test(u)), "claim RPC hits PostgREST when actually invoked");
  });
});

/* ---- run the async suite with NO top-level await; deterministic exit ---- */
async function main() {
  let failures = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      console.log("  ok  " + t.name);
    } catch (err) {
      failures += 1;
      console.error("FAIL  " + t.name);
      console.error(err && err.message ? err.message : err);
    }
  }
  console.log("\n" + passed + " assertions passed");
  return failures;
}

main().then((failures) => {
  if (failures) process.exitCode = 1;
}).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
