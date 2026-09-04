// Permission-cache scope isolation (the two remaining findings).
//
// F-a: apiCacheKey + the module-global read coalescer identified requests by user + params, NOT the authorization
//      fingerprint. After permissions narrow, a new subtree could join an older in-flight coalesced request, receive
//      revoked-brand data, and let it repopulate the cleared cache.
// F-b: the large-cache purge barrier swallowed purge failures and read existing entries anyway, so a failed purge
//      could return previous-scope data.
//
// This suite (A) REPRODUCES the leak using the REAL coalescer (src/lib/session-lifecycle.js#createInFlightCoalescer),
// (B) proves the fix logic in src/lib/report-cache-scope.js closes it, and (C) statically proves App.jsx wires it.
// 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { readFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createInFlightCoalescer } from "../src/lib/session-lifecycle.js";
import {
  configureReportCacheScope, cacheFingerprintId, currentAuthGeneration, isObsoleteGeneration,
  AuthScopeChangedError, isAuthScopeChangedError, createPurgeBarrier, __resetReportCacheScopeForTest,
} from "../src/lib/report-cache-scope.js";

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); };
const deferred = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };

// The PRE-FIX App.jsx#loadSharedReport: coalesce by the (unscoped) key, run apiGet, write + return. No fingerprint in
// the key, no generation check -> the leak.
function makeLoadOld(coalescer, store) {
  return function load(key, params, apiGet) {
    return coalescer.run(key, async () => {
      const body = await apiGet();
      store[key] = body; // "write cache"
      return { body, fromCache: false };
    });
  };
}
// The FIXED App.jsx#loadSharedReport: coalesce by a fingerprint-SCOPED key, run apiGet, then REJECT an obsolete-scope
// result (captured generation) BEFORE returning/writing; otherwise write + return.
function makeLoad(coalescer, store) {
  return function load(key, params, apiGet) {
    const gen = currentAuthGeneration();
    return coalescer.run(key, async () => {
      const body = await apiGet();
      if (isObsoleteGeneration(gen)) throw new AuthScopeChangedError();
      store[key] = body; // "write cache"
      return { body, fromCache: false };
    });
  };
}
// A faithful stand-in for App.jsx#readLargeApiCache with the barrier: bypass (null) when the purge is untrustworthy.
function makeRead(barrier, store) {
  return async function read(key) {
    const { ok: purgeOk } = await barrier.ready();
    if (!purgeOk) return null; // fail-closed: uncertain cache -> bypass -> caller does a network read
    return key in store ? store[key] : null;
  };
}

writeSync(1, "permission-cache-scope\n");

/* ===================== A. REPRODUCE the leak (real coalescer) ===================== */
// The OLD key ignored the fingerprint: both scopes produce the SAME key, so a new-scope caller JOINS the old in-flight
// request and receives the old scope's body. This documents the confirmed finding.
await (async () => {
  __resetReportCacheScopeForTest();
  const coalescer = createInFlightCoalescer();
  const store = {};
  const load = makeLoadOld(coalescer, store); // the PRE-FIX loader (no fingerprint key, no generation check)
  const gate = deferred();
  configureReportCacheScope("fpA-ALL_BRANDS");
  const unscopedKey = "upriver:owner:ids=acct1"; // no fingerprint -> the pre-fix apiCacheKey shape
  const first = load(unscopedKey, { ids: "acct1" }, async () => { await gate.promise; return "ALL_BRANDS-rows"; });
  // permissions narrow while the first read is in flight:
  configureReportCacheScope("fpB-SELECTED_BRANDS");
  const second = load(unscopedKey, { ids: "acct1" }, async () => "SHOULD-NOT-RUN");
  gate.resolve();
  const secondResult = await second.catch((e) => ({ leaked: false, err: e }));
  ok("REPRO: with an UNSCOPED key a new SELECTED_BRANDS caller JOINS the old ALL_BRANDS in-flight read (the leak)",
    secondResult && secondResult.body === "ALL_BRANDS-rows");
  await first.catch(() => {});
})();

/* ===================== B. FIX: scoped key + generation + barrier ===================== */

// B1: a SCOPED key means the new scope does NOT join the old in-flight read.
await (async () => {
  __resetReportCacheScopeForTest();
  const coalescer = createInFlightCoalescer();
  const store = {};
  const load = makeLoad(coalescer, store);
  const key = (id) => `upriver:owner:__fp=${cacheFingerprintId()}:ids=${id}`;
  const gate = deferred();
  configureReportCacheScope("fpA-ALL_BRANDS");
  const first = load(key("acct1"), { ids: "acct1" }, async () => { await gate.promise; return "ALL_BRANDS-rows"; });
  configureReportCacheScope("fpB-SELECTED_BRANDS");
  let secondRan = false;
  const second = load(key("acct1"), { ids: "acct1" }, async () => { secondRan = true; return "SELECTED-rows"; });
  gate.resolve();
  const secondResult = await second;
  ok("FIX: a scoped key stops the new scope from joining the old in-flight read", secondRan === true);
  ok("FIX: the new scope receives ONLY its own scope's data", secondResult.body === "SELECTED-rows");
  ok("FIX: the old ALL_BRANDS body is never stored under the new scope's key", store[key("acct1")] === "SELECTED-rows");
  await first.catch(() => {});
})();

// B2: an obsolete-generation response is REJECTED before it can return or write.
await (async () => {
  __resetReportCacheScopeForTest();
  const coalescer = createInFlightCoalescer();
  const store = {};
  const load = makeLoad(coalescer, store);
  const gate = deferred();
  configureReportCacheScope("fpA");
  const key = `upriver:owner:__fp=${cacheFingerprintId()}:ids=acct1`;
  const inflight = load(key, { ids: "acct1" }, async () => { await gate.promise; return "old-scope-body"; });
  configureReportCacheScope("fpB"); // scope changes while in flight (generation advances)
  gate.resolve();
  const result = await inflight.then(() => ({ threw: false }), (e) => ({ threw: true, e }));
  ok("FIX: a late old-scope response is rejected (AuthScopeChangedError), not returned", result.threw && isAuthScopeChangedError(result.e));
  ok("FIX: the rejected old-scope response never wrote the cache", store[key] === undefined);
})();

// B3: generation semantics.
(() => {
  __resetReportCacheScopeForTest();
  const g0 = currentAuthGeneration();
  const g1 = configureReportCacheScope("fpA");
  ok("generation advances on a new fingerprint", g1 === g0 + 1);
  const g1b = configureReportCacheScope("fpA");
  ok("generation does NOT advance on the same fingerprint (silent token refresh stays valid)", g1b === g1);
  const capturedA = currentAuthGeneration();
  configureReportCacheScope("fpB");
  ok("a read captured under fpA is obsolete after the change to fpB", isObsoleteGeneration(capturedA));
  ok("a read captured under the current scope is NOT obsolete", !isObsoleteGeneration(currentAuthGeneration()));
})();

// B4: same-scope concurrent reads still DEDUPLICATE (race protection preserved).
await (async () => {
  __resetReportCacheScopeForTest();
  const coalescer = createInFlightCoalescer();
  const store = {};
  const load = makeLoad(coalescer, store);
  configureReportCacheScope("fpA");
  const key = `upriver:owner:__fp=${cacheFingerprintId()}:ids=acct1`;
  let calls = 0;
  const gate = deferred();
  const a = load(key, { ids: "acct1" }, async () => { calls += 1; await gate.promise; return "rows"; });
  const b = load(key, { ids: "acct1" }, async () => { calls += 1; return "rows"; });
  gate.resolve();
  await Promise.all([a, b]);
  ok("same-scope concurrent reads deduplicate to ONE underlying request", calls === 1);
})();

// B5: the purge barrier -- fail-closed on failure, never deadlocks.
await (async () => {
  const store = { "k1": "old-scope-payload" };
  const barrier = createPurgeBarrier();
  const read = makeRead(barrier, store);
  ok("default barrier trusts the cache (no purge pending)", (await read("k1")) === "old-scope-payload");
  barrier.arm(Promise.reject(new Error("indexeddb transaction aborted")));
  ok("F-b: a FAILED purge makes the read BYPASS the cache (no previous-scope payload returned)", (await read("k1")) === null);
  barrier.arm(Promise.resolve());
  ok("a SUCCEEDED purge lets the (now current-scope) cache be read again", (await read("k1")) === "old-scope-payload");
  // never rejects -> no deadlock
  let settled = false;
  barrier.arm(Promise.reject(new Error("x")));
  await barrier.ready().then(() => { settled = true; }, () => { settled = true; });
  ok("barrier.ready() always settles (never deadlocks)", settled === true);
})();

// B6: legacy (pre-fingerprint) keys are never matched by a scoped read.
(() => {
  __resetReportCacheScopeForTest();
  configureReportCacheScope("fpA");
  const scopedKey = `upriver:owner:__fp=${cacheFingerprintId()}:ids=acct1`;
  const legacyKey = "upriver:owner:ids=acct1"; // no __fp
  ok("a legacy unscoped key differs from the current scoped key (never reused)", scopedKey !== legacyKey);
})();

/* ===================== C. WIRING (real App.jsx) ===================== */
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const app = readFileSync(path.join(root, "src/App.jsx"), "utf8");
ok("App.jsx imports the report-cache-scope module", /from "\.\/lib\/report-cache-scope\.js"/.test(app));
ok("apiCacheKey embeds the authorization fingerprint (__fp)", /qs\.set\("__fp", cacheFingerprintId\(\)\)/.test(app));
ok("App establishes the cache scope before the subtree reads (configureReportCacheScope at the root, from the access fingerprint)",
  /const scopeFingerprint = accessFingerprintClient\(access\);/.test(app)
  && /configureReportCacheScope\(scopeFingerprint\);/.test(app)
  && app.indexOf("configureReportCacheScope(scopeFingerprint);") < app.indexOf("<DashboardApp key={scopeFingerprint}"));
ok("loadSharedReport captures the generation + key and runs the obsolete-guarded shared load inside the coalescer",
  /async function loadSharedReport[\s\S]{0,500}const generation = currentAuthGeneration\(\)[\s\S]{0,300}sharedReadCoalescer\.run\([\s\S]{0,160}runSharedLoad\(/.test(app));
ok("refreshSharedReport captures the generation + key and delegates to the obsolete-guarded shared load",
  /async function refreshSharedReport[\s\S]{0,500}const generation = currentAuthGeneration\(\)[\s\S]{0,300}runSharedLoad\(/.test(app));
// The purge-barrier gate (bypass on a failed/aborted purge) now lives in the report-cache-io core; App threads the
// hardened barrier into it and readLargeApiCache delegates there.
ok("App threads the purge barrier into the cache I/O core, and readLargeApiCache delegates to it",
  /purgeBarrier: reportLargeCacheBarrier/.test(app) && /function readLargeApiCache[\s\S]{0,200}scopedLargeRead\(/.test(app));
ok("the permission-change purge ARMS the barrier", /CacheBarrier\.arm\(clearAllOwnerLargeCache\(\)\)/.test(app));
ok("clearAllOwnerLargeCache keys off TRANSACTION completion/abort (not only request success)",
  /\.oncomplete\s*=/.test(app) && /\.onabort\s*=/.test(app));
ok("cachedBrandsForAccount only reads current-scope brand caches (__fp check)",
  /params\.get\("__fp"\) !== cacheFingerprintId\(\)\) continue/.test(app));

writeSync(1, `\npermission-cache-scope: ${passed} assertions passed\n`);
