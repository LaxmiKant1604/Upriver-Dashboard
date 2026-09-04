// F3 + F7 regressions: closing the permission-change cache/render window.
//
// F3 (behavioral, real React via react-test-renderer): keying the scope subtree by the access FINGERPRINT means a
// permission change atomically replaces it with a fresh instance -- previous-scope in-memory data is gone in the same
// commit (no unauthorized frame) and old in-flight reads land on the unmounted instance. A same-fingerprint update
// (a token refresh) does NOT remount, so silent background refresh + state are preserved.
// F7 (behavioral contract + static wiring): a large-cache READ gated on a purge barrier observes the POST-purge store,
// never a not-yet-deleted previous-scope payload.
//
// 7-bit ASCII, LF.

import assert from "node:assert/strict";
import React from "react";
import TestRenderer from "react-test-renderer";
import { readFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const { act } = TestRenderer;
const h = React.createElement;
let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); }

writeSync(1, "permission-cache-window\n");

/* ================= F3: fingerprint-keyed remount resets in-memory scope ================= */
// A stand-in for DashboardApp: on mount it "loads" the current scope's rows into state (empty-deps effect, like a
// report loader), and never re-loads on a plain re-render. `mounts` counts fresh instances.
let scopeData = [];
let mounts = 0;
function ScopeSubtree() {
  const [rows, setRows] = React.useState([]);
  React.useEffect(() => { mounts += 1; setRows(scopeData.slice()); }, []);
  return h("div", null, rows.join(","));
}
function Root({ fp }) { return h(ScopeSubtree, { key: fp }); }

{
  scopeData = ["A-brandX", "A-brandY"]; // scope A payload (all-brands)
  let r;
  act(() => { r = TestRenderer.create(h(Root, { fp: "fpA" })); });
  const afterA = JSON.stringify(r.toJSON());
  ok("scope A renders its rows on first mount", /A-brandX/.test(afterA) && mounts === 1);

  // Token refresh: SAME fingerprint -> no remount, state preserved, no reload.
  const mountsBefore = mounts;
  act(() => { r.update(h(Root, { fp: "fpA" })); });
  ok("same fingerprint (token refresh) does NOT remount (silent refresh preserved)", mounts === mountsBefore);
  ok("same fingerprint keeps the existing rows", /A-brandX/.test(JSON.stringify(r.toJSON())));

  // Permission change: NEW fingerprint (scope narrowed) -> remount; scope A rows must be gone atomically.
  scopeData = ["B-brandX"]; // the new, narrower scope's payload
  act(() => { r.update(h(Root, { fp: "fpB" })); });
  const afterB = JSON.stringify(r.toJSON());
  ok("fingerprint change remounts a fresh instance", mounts === mountsBefore + 1);
  ok("previous-scope rows (A) are NOT present after the fingerprint change", !/A-brandX|A-brandY/.test(afterB));
  ok("only the new scope's rows render under the new fingerprint", /B-brandX/.test(afterB));
}

/* ================= F7: a read gated on the purge barrier never returns pre-purge data ================= */
await (async () => {
  let store = "STALE-scopeA-payload";
  let releasePurge;
  const purge = new Promise((res) => { releasePurge = res; }).then(() => { store = "PURGED"; });
  // mirrors src/App.jsx: setLargeCachePurgeBarrier(clearAllOwnerLargeCache()) + readLargeApiCache awaits the barrier
  let barrier = Promise.resolve(purge).catch(() => {});
  const gatedRead = async () => { try { await barrier; } catch (_e) { /* fail-safe */ } return store; };

  const readPromise = gatedRead();     // a report read fired while the purge is still in flight
  releasePurge();                       // purge completes (previous-scope entries deleted)
  const value = await readPromise;
  ok("a large-cache read waits for the in-flight purge (never returns pre-purge scope data)", value === "PURGED");

  // Fail-safe: a purge that REJECTS must still unblock the read (never a deadlock).
  let barrier2 = Promise.resolve(Promise.reject(new Error("indexeddb blocked"))).catch(() => {});
  const readNoDeadlock = async () => { try { await barrier2; } catch (_e) {} return "read-proceeded"; };
  ok("a failed/blocked purge still unblocks reads (no deadlock)", (await readNoDeadlock()) === "read-proceeded");
})();

/* ================= wiring: the real App.jsx uses these mechanisms ================= */
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const app = readFileSync(path.join(root, "src/App.jsx"), "utf8");
ok("App keys DashboardApp by the access fingerprint (F3)", /<DashboardApp key=\{scopeFingerprint\}/.test(app) && /const scopeFingerprint = accessFingerprintClient\(access\);/.test(app));
ok("readLargeApiCache consults the purge barrier (F7, now the hardened reportLargeCacheBarrier)", /reportLargeCacheBarrier\.ready\(\)/.test(app));
ok("the permission-change purge ARMS the barrier with the large-cache purge (F7)", /reportLargeCacheBarrier\.arm\(clearAllOwnerLargeCache\(\)\)/.test(app));
ok("cache keys remain owner-namespaced (no cross-user reuse)", /API_CACHE_PREFIX \+ encodeURIComponent\(apiCacheOwner\)/.test(app));

writeSync(1, `\npermission-cache-window: ${passed} assertions passed\n`);
