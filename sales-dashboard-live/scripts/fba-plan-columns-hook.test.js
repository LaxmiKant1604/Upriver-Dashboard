// ACCOUNT-scoped FBA Shipment Plan column hook (src/lib/use-fba-plan-columns.js) async-safety proof suite. Mounts the
// REAL production hook with react-test-renderer + a controllable DEFERRED fetch, and drives its real load/save/toggle
// under account switches. Proves the account-switch + async-race lifecycle (requirement 4): a delayed A GET never
// renders under B; A->B->A discards obsolete A; a delayed A save never mutates B; a newer same-account save wins over
// an older one; optimistic save rolls back on failure; account sharing/isolation at the render gate. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import React from "react";
import TestRenderer from "react-test-renderer";
import { useFbaPlanColumns } from "../src/lib/use-fba-plan-columns.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "fba-plan-columns-hook\n");
const act = TestRenderer.act;
const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };
const fakeStorage = { removeItem() {}, getItem() { return null; }, setItem() {} };

// A controllable server: GET (path carries ?accountId=) and POST are both DEFERRED until released, so a test pins the
// exact interleaving. Every POST body is recorded. A released GET/POST echoes the requested accountId (as production).
function makeServer() {
  const gets = []; const posts = []; const recorded = [];
  const apiFetch = (path, _token, opts) => {
    if (!opts || !opts.method || opts.method === "GET") {
      const acct = decodeURIComponent(String(path).split("accountId=")[1] || "");
      return new Promise((resolve, reject) => gets.push({ acct, resolve, reject, settled: false }));
    }
    const body = JSON.parse(opts.body); recorded.push(body);
    return new Promise((resolve, reject) => posts.push({ acct: body.accountId, body, resolve, reject, settled: false }));
  };
  const takeGet = (acct) => gets.find((g) => g.acct === acct && !g.settled);
  // Match a pending POST by acct AND (when bodyHidden is given) its exact request body -- so a test can resolve a
  // SPECIFIC in-flight save (e.g. the newer one first), not merely the first-enqueued.
  const takePost = (acct, bodyHidden) => posts.find((p) => p.acct === acct && !p.settled && (bodyHidden === undefined || [...(p.body.hiddenColumns || [])].sort().join(",") === [...bodyHidden].sort().join(",")));
  return {
    apiFetch, recorded,
    releaseGet: (acct, hidden, updatedAt = "2026-01-01T00:00:00.000Z") => { const g = takeGet(acct); if (!g) throw new Error("no pending GET " + acct); g.settled = true; g.resolve({ accountId: acct, hiddenColumns: hidden, updatedAt }); },
    releaseGetUnsaved: (acct) => { const g = takeGet(acct); if (!g) throw new Error("no pending GET " + acct); g.settled = true; g.resolve({ accountId: acct, hiddenColumns: [], updatedAt: null }); },
    releasePost: (acct, bodyHidden) => { const p = takePost(acct, bodyHidden); if (!p) throw new Error("no pending POST " + acct + " " + JSON.stringify(bodyHidden)); p.settled = true; p.resolve({ accountId: acct, hiddenColumns: [...(p.body.hiddenColumns || [])], updatedAt: "2026-02-02T00:00:00.000Z" }); },
    failPost: (acct, msg) => { const p = takePost(acct); if (!p) throw new Error("no pending POST " + acct); p.settled = true; p.reject(new Error(msg || "save failed")); },
    pendingPosts: (acct) => posts.filter((p) => p.acct === acct && !p.settled).length,
    getCount: () => gets.length,
  };
}

// The harness exposes the live hook api + last error to the test via a shared ref object.
function makeHarness() {
  const box = { api: null, errors: [] };
  function Harness({ accountId, token }) {
    box.api = useFbaPlanColumns({ accountId, token, active: true, apiFetch: box.server.apiFetch, onWriteError: (m) => box.errors.push(m), userId: "u1", storage: fakeStorage });
    return null;
  }
  return { box, Harness };
}
const hiddenList = (box) => [...box.api.hiddenCols].sort().join(",");

async function mount(accountId) {
  const server = makeServer();
  const { box, Harness } = makeHarness();
  box.server = server;
  let root; let acctNow = accountId; let tokNow = "tok";
  await act(async () => { root = TestRenderer.create(React.createElement(Harness, { accountId: acctNow, token: tokNow })); });
  const switchTo = async (acct) => { acctNow = acct; await act(async () => { root.update(React.createElement(Harness, { accountId: acctNow, token: tokNow })); }); await flush(); };
  const refreshToken = async (tok) => { tokNow = tok; await act(async () => { root.update(React.createElement(Harness, { accountId: acctNow, token: tokNow })); }); await flush(); };
  return { server, box, switchTo, refreshToken, root };
}

/* ===================== load + sharing/isolation (render gate) ===================== */
await (async () => {
  const { server, box } = await mount("X");
  ok("load: before the GET resolves, hiddenCols is the DEFAULT (never blank/undefined, never another account)", box.api.hiddenCols instanceof Set && hiddenList(box).includes("reservedFcTransfer"));
  await act(async () => { server.releaseGet("X", ["m1", "wdd"]); }); await flush();
  ok("load: the account's SAVED layout renders after the GET", hiddenList(box) === "m1,wdd" && box.api.ready === true);
})();

/* ===================== D: A->B delayed GET ===================== */
await (async () => {
  const { server, box, switchTo } = await mount("A");
  await switchTo("B");                              // switch before A resolves
  await act(async () => { server.releaseGet("A", ["zzz-A-only"]); }); await flush(); // A's delayed GET
  ok("D: a delayed A GET never renders under B (A's payload discarded)", !hiddenList(box).includes("zzz-A-only"));
  await act(async () => { server.releaseGet("B", ["m2"]); }); await flush();
  ok("D: B renders B's own layout", hiddenList(box) === "m2");
})();

/* ===================== D: A->B->A delayed GET (obsolete A1 discarded) ===================== */
await (async () => {
  const { server, box, switchTo } = await mount("A");   // GET A1 pending
  await switchTo("B");                                   // GET B pending
  await switchTo("A");                                   // GET A2 pending; live scope = A
  await act(async () => { server.releaseGet("A", ["A1-old"]); }); await flush(); // resolves the FIRST pending A (A1)
  ok("D: A->B->A -- the obsolete A1 response does not win", !hiddenList(box).includes("A1-old"));
  await act(async () => { server.releaseGet("A", ["A2-new"]); await flush(); }); await flush(); // A2
  ok("D: A->B->A -- the latest A (A2) wins", hiddenList(box) === "A2-new");
  await act(async () => { try { server.releaseGet("B", ["B-late"]); } catch { /* B may have no pending */ } }); await flush();
  ok("D: a late B GET never renders under the live A", hiddenList(box) === "A2-new");
})();

/* ===================== D: delayed A save after switching to B ===================== */
await (async () => {
  const { server, box, switchTo } = await mount("A");
  await act(async () => { server.releaseGet("A", ["m1"]); }); await flush();
  await act(async () => { box.api.save(["m1", "priority"]); }); await flush(); // optimistic + POST(A) pending
  ok("D: optimistic apply on A before the save resolves", hiddenList(box) === "m1,priority");
  await switchTo("B");
  await act(async () => { server.releaseGet("B", ["m9"]); }); await flush();
  ok("D: B loaded independently while A's save is still in flight", hiddenList(box) === "m9");
  await act(async () => { server.releasePost("A", ["m1", "priority"]); }); await flush(); // A's delayed save resolves under B
  ok("D: a delayed A save never mutates B", hiddenList(box) === "m9");
  ok("D: busy is NOT stranded true after a save is superseded by an account switch (chooser stays usable)", box.api.busy === false);
})();

/* ===================== D: newer same-account save wins over an older one ===================== */
await (async () => {
  const { server, box } = await mount("A");
  await act(async () => { server.releaseGetUnsaved("A"); }); await flush(); // A unsaved -> default
  await act(async () => { box.api.save(["m1"]); box.api.save(["m2"]); }); await flush(); // POST1 then POST2, both pending
  await act(async () => { server.releasePost("A", ["m2"]); }); await flush(); // newer completes first
  ok("D: the newer save's result is applied", hiddenList(box) === "m2");
  await act(async () => { server.releasePost("A", ["m1"]); }); await flush(); // older completes late -> obsolete
  ok("D: the older save cannot overwrite the newer result", hiddenList(box) === "m2");
})();

/* ===================== optimistic save + rollback on failure ===================== */
await (async () => {
  const { server, box } = await mount("A");
  await act(async () => { server.releaseGet("A", ["m1"]); }); await flush();
  await act(async () => { box.api.toggle("m2"); }); await flush(); // optimistic add m2
  ok("rollback: optimistic apply shows m1,m2", hiddenList(box) === "m1,m2");
  await act(async () => { server.failPost("A", "server 500"); }); await flush();
  ok("rollback: a failed save rolls back to the pre-save layout", hiddenList(box) === "m1");
  ok("rollback: a clear error was surfaced (never a silent success)", box.errors.length >= 1 && /500|save/i.test(box.errors[box.errors.length - 1]));
})();

/* ===================== a silent token refresh mid-save neither re-fetches nor reverts the save ===================== */
await (async () => {
  const { server, box, refreshToken } = await mount("A");
  await act(async () => { server.releaseGet("A", ["m1"]); }); await flush();
  const getsAfterLoad = server.getCount();
  await act(async () => { box.api.save(["m1", "priority"]); }); await flush(); // optimistic + POST(A) in flight
  await refreshToken("tok-2"); // a silent SWR/focus token refresh (same user, new token)
  ok("refresh: a silent token refresh does NOT fire a new reload GET (no save-racing fetch)", server.getCount() === getsAfterLoad);
  ok("refresh: the optimistic save is preserved across the token refresh", hiddenList(box) === "m1,priority");
  await act(async () => { server.releasePost("A", ["m1", "priority"]); }); await flush();
  ok("refresh: the successful save stands (never silently reverted)", hiddenList(box) === "m1,priority" && box.api.busy === false);
})();

/* ===================== Select All + Reset commands ===================== */
await (async () => {
  const { server, box } = await mount("A");
  await act(async () => { server.releaseGet("A", ["m1", "m2"]); }); await flush();
  await act(async () => { box.api.selectAll(); }); await flush();
  ok("cmd: Select All optimistically shows an empty hidden set + POSTs []", hiddenList(box) === "" && server.recorded[server.recorded.length - 1].hiddenColumns.length === 0);
  await act(async () => { server.releasePost("A", []); }); await flush();
  await act(async () => { box.api.reset(); }); await flush();
  ok("cmd: Reset Default optimistically shows the default set + POSTs the default", hiddenList(box).includes("reservedFcTransfer") && server.recorded[server.recorded.length - 1].hiddenColumns.includes("inboundWorking"));
})();

writeSync(1, `\nfba-plan-columns-hook: ${passed} assertions passed\n`);
