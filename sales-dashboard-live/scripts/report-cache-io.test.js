// Async report-cache I/O scope isolation (the two remaining defects in 80fab37), tested against the REAL production
// core (src/lib/report-cache-io.js) with controllable IndexedDB open/get/write + storage.
//
// Defect 1: a late IndexedDB failure after a scope change made writeLargeApiCache fall back to localStorage, RECOMPUTING
//           the key from the CURRENT global scope -> the old ALL_BRANDS body written under the new SELECTED_BRANDS key.
// Defect 2: cachedLargeApiGet's cache-hit branch returned the pending-get result with NO generation check -> a revoked
//           payload returned after a mid-read scope change.
//
// 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { readFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { scopedLargeRead, scopedLargeWrite, runCachedLargeGet, runSharedLoad } from "../src/lib/report-cache-io.js";
import {
  configureReportCacheScope, cacheFingerprintId, currentAuthGeneration, isAuthScopeChangedError,
  __resetReportCacheScopeForTest,
} from "../src/lib/report-cache-scope.js";

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); };
const tick = () => new Promise((r) => setTimeout(r, 0));
const deferred = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };

// Controllable fake IndexedDB: get()/put() requests QUEUE and are fired by the test (flushGet/flushWrite), so a scope
// change can be interleaved while an operation is pending. Transaction commit/abort is modeled explicitly.
function makeIdb() {
  const data = new Map();
  const gets = []; const writes = [];
  const db = {
    transaction() {
      const tx = { oncomplete: null, onabort: null, onerror: null, abort() { if (this.onabort) this.onabort(); } };
      tx.objectStore = () => ({
        get(key) { const req = { onsuccess: null, onerror: null, result: null }; gets.push({ req, key, tx }); return req; },
        put(val, key) { const req = { onsuccess: null, onerror: null }; writes.push({ req, key, val, tx }); return req; },
      });
      return tx;
    },
    close() {},
  };
  return {
    data, db,
    flushGet({ error = false } = {}) { const g = gets.shift(); if (!g) return; if (error) { g.req.onerror && g.req.onerror(); } else { g.req.result = data.has(g.key) ? data.get(g.key) : undefined; g.req.onsuccess && g.req.onsuccess(); } },
    flushWrite({ mode = "complete" } = {}) { const w = writes.shift(); if (!w) return; if (mode === "abort") { w.tx.onabort && w.tx.onabort(); } else if (mode === "error") { w.req.onerror && w.req.onerror(); w.tx.onabort && w.tx.onabort(); } else { data.set(w.key, w.val); w.req.onsuccess && w.req.onsuccess(); w.tx.oncomplete && w.tx.oncomplete(); } },
    pendingWrites: () => writes.length, pendingGets: () => gets.length,
  };
}
// Auto-resolving fake (get/put settle on a microtask AFTER the caller attaches handlers) -- for happy-path reads/writes.
function makeAutoIdb(seed = new Map()) {
  const data = new Map(seed);
  const db = {
    transaction() {
      const tx = { oncomplete: null, onabort: null, onerror: null, abort() { if (this.onabort) this.onabort(); } };
      tx.objectStore = () => ({
        get(key) { const req = { onsuccess: null, onerror: null, result: null }; queueMicrotask(() => { req.result = data.has(key) ? data.get(key) : undefined; req.onsuccess && req.onsuccess(); }); return req; },
        put(val, key) { const req = { onsuccess: null, onerror: null }; queueMicrotask(() => { data.set(key, val); req.onsuccess && req.onsuccess(); tx.oncomplete && tx.oncomplete(); }); return req; },
      });
      return tx;
    },
    close() {},
  };
  return { data, db };
}
function makeStorage() { const store = new Map(); return { store, getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) }; }
const trustedBarrier = { ready: async () => ({ ok: true }) };

writeSync(1, "report-cache-io\n");

/* ============ Defect 1: late IndexedDB open failure must not write the old body under the new scope ============ */
// LEGACY reproduction: the pre-fix fallback recomputed the key from the CURRENT global scope (no captured key, no gen).
await (async () => {
  __resetReportCacheScopeForTest();
  const storage = makeStorage();
  const legacyWrite = async (params, body, openLargeCache) => {
    const cachedAt = Date.now();
    try { await openLargeCache(); return cachedAt; }
    catch (_e) { const key = `owner:__fp=${cacheFingerprintId()}:ids=${params.id}`; storage.setItem(key, JSON.stringify({ body, cachedAt })); return cachedAt; }
  };
  const openGate = deferred();
  configureReportCacheScope("fpA"); const keyA = `owner:__fp=${cacheFingerprintId()}:ids=acct1`;
  const p = legacyWrite({ id: "acct1" }, "ALL_BRANDS-body", () => openGate.promise);
  await tick();
  configureReportCacheScope("fpB"); const keyB = `owner:__fp=${cacheFingerprintId()}:ids=acct1`;
  openGate.reject(new Error("open failed"));
  await p.catch(() => {});
  ok("REPRO: the legacy fallback writes the OLD body under the NEW scope's key (the leak)", keyB !== keyA && storage.getItem(keyB) !== null);
})();

// FIX: scopedLargeWrite uses the CAPTURED key + generation; a scope change during the pending open -> throw, no write.
await (async () => {
  __resetReportCacheScopeForTest();
  const storage = makeStorage();
  const openGate = deferred();
  const io = { openLargeCache: () => openGate.promise, largeStore: "responses", storage, purgeBarrier: trustedBarrier };
  configureReportCacheScope("fpA");
  const gen = currentAuthGeneration();
  const capturedKey = "owner:__fp=fpA:ids=acct1";
  const p = scopedLargeWrite(capturedKey, gen, "ALL_BRANDS-body", io);
  await tick();
  configureReportCacheScope("fpB"); // narrow while the open is pending
  openGate.reject(new Error("indexeddb open failed"));
  const res = await p.then(() => ({ threw: false }), (e) => ({ threw: true, e }));
  ok("FIX D1: a pending-open failure after a scope change throws AuthScopeChangedError", res.threw && isAuthScopeChangedError(res.e));
  ok("FIX D1: NOTHING is written (not under the new scope, not under the old)", storage.store.size === 0);
})();

// FIX D1 contrast: a storage failure with the SAME scope still falls back to localStorage under the CAPTURED key.
await (async () => {
  __resetReportCacheScopeForTest();
  const storage = makeStorage();
  const io = { openLargeCache: () => Promise.reject(new Error("no indexeddb")), largeStore: "responses", storage, purgeBarrier: trustedBarrier };
  configureReportCacheScope("fpA");
  const gen = currentAuthGeneration();
  const key = "owner:__fp=fpA:ids=acct1";
  const res = await scopedLargeWrite(key, gen, "same-scope-body", io);
  ok("FIX D1: same-scope storage failure falls back to localStorage under the CAPTURED key", typeof res === "number" && JSON.parse(storage.getItem(key)).body === "same-scope-body");
  ok("FIX D1: the fallback wrote ONLY the captured key", storage.store.size === 1 && storage.store.has(key));
})();

/* ============ Defect 2: cache-hit after a mid-read scope change must not return the revoked payload ============ */
await (async () => {
  __resetReportCacheScopeForTest();
  const storage = makeStorage();
  const idb = makeIdb();
  const key = "owner:__fp=fpA:ids=acct1";
  idb.data.set(key, { body: "ALL_BRANDS-payload", cachedAt: 1 });
  const io = { openLargeCache: () => Promise.resolve(idb.db), largeStore: "responses", storage, purgeBarrier: trustedBarrier };
  configureReportCacheScope("fpA");
  const gen = currentAuthGeneration();
  let fetched = false;
  const p = runCachedLargeGet({ key, generation: gen, force: false, apiGet: async () => { fetched = true; return "x"; }, io });
  await tick(); await tick(); // reach the pending get
  configureReportCacheScope("fpB"); // narrow while the get is pending
  idb.flushGet(); // the OLD-scope cache entry comes back
  const res = await p.then((v) => ({ threw: false, v }), (e) => ({ threw: true, e }));
  ok("FIX D2: a cache hit resolving after a scope change is rejected, not returned", res.threw && isAuthScopeChangedError(res.e));
  ok("FIX D2: the revoked cache hit never triggered a network fetch either", fetched === false);
})();

/* ============ write completes during scope change: data lands ONLY under the captured (old) key, result rejected == */
await (async () => {
  __resetReportCacheScopeForTest();
  const storage = makeStorage();
  const idb = makeIdb();
  const io = { openLargeCache: () => Promise.resolve(idb.db), largeStore: "responses", storage, purgeBarrier: trustedBarrier };
  configureReportCacheScope("fpA");
  const gen = currentAuthGeneration();
  const capturedKey = "owner:__fp=fpA:ids=acct1";
  const p = runSharedLoad({ key: capturedKey, generation: gen, apiGet: async () => "ALL_BRANDS-body", io });
  await tick(); await tick(); await tick(); // apiGet + open resolve; the write reaches the store, still pending commit
  configureReportCacheScope("fpB"); // scope changes before the tx completes
  idb.flushWrite({ mode: "complete" });
  const res = await p.then(() => ({ threw: false }), (e) => ({ threw: true, e }));
  ok("write-during-change: the result is rejected (never delivered to the new scope)", res.threw && isAuthScopeChangedError(res.e));
  ok("write-during-change: any persisted entry is under the CAPTURED (old) key only, never the new scope's key",
    ![...idb.data.keys()].some((k) => k.includes("fpB")));
})();

/* ============ storage abort + fallback after scope change ============ */
await (async () => {
  __resetReportCacheScopeForTest();
  const storage = makeStorage();
  const idb = makeIdb();
  const io = { openLargeCache: () => Promise.resolve(idb.db), largeStore: "responses", storage, purgeBarrier: trustedBarrier };
  configureReportCacheScope("fpA");
  const gen = currentAuthGeneration();
  const key = "owner:__fp=fpA:ids=acct1";
  const p = scopedLargeWrite(key, gen, "body", io);
  await tick(); await tick();
  configureReportCacheScope("fpB"); // scope changes, then the write transaction aborts
  idb.flushWrite({ mode: "abort" });
  const res = await p.then(() => ({ threw: false }), (e) => ({ threw: true, e }));
  ok("abort-after-change: throws (no cross-scope fallback write)", res.threw && isAuthScopeChangedError(res.e));
  ok("abort-after-change: nothing written to localStorage under any key", storage.store.size === 0);
})();

// contrast: a same-scope abort DOES fall back to localStorage (availability preserved).
await (async () => {
  __resetReportCacheScopeForTest();
  const storage = makeStorage();
  const idb = makeIdb();
  const io = { openLargeCache: () => Promise.resolve(idb.db), largeStore: "responses", storage, purgeBarrier: trustedBarrier };
  configureReportCacheScope("fpA");
  const gen = currentAuthGeneration();
  const key = "owner:__fp=fpA:ids=acct1";
  const p = scopedLargeWrite(key, gen, "same-scope-body", io);
  await tick(); await tick();
  idb.flushWrite({ mode: "abort" }); // same scope, transaction aborts
  const res = await p;
  ok("abort same-scope: falls back to localStorage under the captured key (availability kept)", typeof res === "number" && JSON.parse(storage.getItem(key)).body === "same-scope-body");
})();

/* ============ sign-out / user switch while a write is pending ============ */
await (async () => {
  __resetReportCacheScopeForTest();
  const storage = makeStorage();
  const openGate = deferred();
  const io = { openLargeCache: () => openGate.promise, largeStore: "responses", storage, purgeBarrier: trustedBarrier };
  configureReportCacheScope("fpUserA");
  const gen = currentAuthGeneration();
  const p = scopedLargeWrite("owner:__fp=fpUserA:ids=acct1", gen, "user-A-body", io);
  await tick();
  configureReportCacheScope(""); // SIGN-OUT invalidates the active generation
  openGate.resolve(makeAutoIdb().db);
  const res = await p.then(() => ({ threw: false }), (e) => ({ threw: true, e }));
  ok("sign-out while a write is pending rejects the write (no post-sign-out persistence)", res.threw && isAuthScopeChangedError(res.e));
  ok("sign-out: nothing persisted", storage.store.size === 0);
})();

/* ============ rapid A -> B -> A: a first-epoch request is obsolete in the third epoch ============ */
(() => {
  __resetReportCacheScopeForTest();
  configureReportCacheScope("A"); const genA1 = currentAuthGeneration();
  configureReportCacheScope("B");
  configureReportCacheScope("A"); const genA2 = currentAuthGeneration();
  ok("rapid A->B->A advances the generation each change (a first-A request is obsolete in the second A epoch)", genA2 !== genA1);
})();

/* ============ same-scope token refresh + failed-purge bypass ============ */
await (async () => {
  __resetReportCacheScopeForTest();
  const storage = makeStorage();
  const key = "owner:__fp=fpA:ids=acct1";
  configureReportCacheScope("fpA"); const gen1 = currentAuthGeneration();
  configureReportCacheScope("fpA"); // silent token refresh: SAME fingerprint
  ok("same-scope token refresh does NOT advance the generation (stays valid)", currentAuthGeneration() === gen1);
  const idbAuto = makeAutoIdb(new Map([[key, { body: "current-scope-payload", cachedAt: 1 }]]));
  const readHit = await scopedLargeRead(key, { openLargeCache: () => Promise.resolve(idbAuto.db), largeStore: "responses", storage, purgeBarrier: trustedBarrier });
  ok("same-scope read returns the current-scope cache hit", readHit && readHit.body === "current-scope-payload");
  const bypass = await scopedLargeRead(key, { openLargeCache: () => Promise.resolve(idbAuto.db), largeStore: "responses", storage, purgeBarrier: { ready: async () => ({ ok: false }) } });
  ok("failed-purge barrier makes the read BYPASS the cache (null)", bypass === null);
})();

/* ============ WIRING: App.jsx delegates to the tested core + invalidates scope on no-access ============ */
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const app = readFileSync(path.join(root, "src/App.jsx"), "utf8");
ok("App.jsx imports the report-cache-io core", /from "\.\/lib\/report-cache-io\.js"/.test(app));
ok("readLargeApiCache delegates to scopedLargeRead", /function readLargeApiCache[\s\S]{0,200}scopedLargeRead\(/.test(app));
ok("loadSharedReport runs the shared load body inside the coalescer", /sharedReadCoalescer\.run\([\s\S]{0,160}runSharedLoad\(/.test(app));
ok("refreshSharedReport uses runSharedLoad", /async function refreshSharedReport[\s\S]{0,400}runSharedLoad\(/.test(app));
ok("cachedLargeApiGet uses runCachedLargeGet", /async function cachedLargeApiGet[\s\S]{0,400}runCachedLargeGet\(/.test(app));
ok("the recompute-prone writeLargeApiCache wrapper is gone (callers thread the captured context)", !/async function writeLargeApiCache\(/.test(app));
ok("cachedApiGet validates the generation on the cache-hit + before write", /async function cachedApiGet[\s\S]{0,400}isObsoleteGeneration\(/.test(app));
ok("App invalidates the cache scope on no-access (sign-out/loading) before its early returns",
  /const scopeActive = Boolean\(supabase && authReady && session && !passwordSetup && !accessError && access\);/.test(app)
  && /if \(!scopeActive\) configureReportCacheScope\(""\);/.test(app)
  && app.indexOf('if (!scopeActive) configureReportCacheScope("");') < app.indexOf("if (!supabase) return <div"));

writeSync(1, `\nreport-cache-io: ${passed} assertions passed\n`);
