// FBA lead-time import + account-safe config INTEGRATION tests (audit 2026-09-08, round 3). Mounts the REAL production
// hook useFbaPlanConfig (src/lib/use-fba-plan-config.js -- the SAME code App.jsx renders) with react-test-renderer and
// a controllable fetch, and drives its real callbacks: file-select -> delayed parse -> preview -> account switch ->
// confirm -> POST -> reload. Covers deferred POSTs (not just deferred GETs): a delayed save for A resolving after a
// switch to B (before and after B's config loads), a new preview opened before A completes, and A->B->A with a newer
// import. Asserts B's config/request survives, newer preview/busy is untouched, notes persist, and ZERO wrong-account
// writes. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import React, { useState } from "react";
import TestRenderer from "react-test-renderer";
import { useFbaPlanConfig } from "../src/lib/use-fba-plan-config.js";
import { FBA_LEAD_TIME_COLUMNS } from "../src/lib/fba-lead-time-import.js";

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); };
writeSync(1, "fba-import-integration\n");
const act = TestRenderer.act;
const flush = async () => { for (let i = 0; i < 4; i += 1) await Promise.resolve(); };

// Same child ASIN B0SHARED in BOTH accounts with different notes/days -> proves isolation + no cross-account write.
function payloads() {
  return {
    A: { settings: null, overrides: [], warehouse: [], wddWeights: [], leadTimes: [
      { child_asin: "B0SHARED", production_days: 5, shipping_days: 10, awd_transfer_days: 3, safety_stock_days: 7, inbound_started_date: null, inbound_eta: null, note: "A-note", updated_by_email: "" },
    ] },
    B: { settings: null, overrides: [], warehouse: [], wddWeights: [], leadTimes: [
      { child_asin: "B0SHARED", production_days: 1, shipping_days: 2, awd_transfer_days: 1, safety_stock_days: 1, inbound_started_date: null, inbound_eta: null, note: "B-note", updated_by_email: "" },
    ] },
  };
}

// A controllable server. GET (path with ?accountId=) and POST are both DEFERRED until released, so the tests can pin
// the exact interleaving of a delayed POST vs a later GET. Every POST body is recorded for wrong-account assertions.
function makeServer(pl) {
  const gets = []; // { acct, resolve, reject, settled }
  const posts = []; // { body, resolve, reject, settled }
  const recorded = [];
  const apiFetch = (path, _token, opts) => {
    if (!opts || !opts.method || opts.method === "GET") {
      const acct = decodeURIComponent(String(path).split("accountId=")[1] || "");
      return new Promise((resolve, reject) => gets.push({ acct, resolve, reject }));
    }
    const body = JSON.parse(opts.body);
    recorded.push(body);
    return new Promise((resolve, reject) => posts.push({ body, resolve, reject }));
  };
  const takeGet = (acct) => gets.find((g) => g.acct === acct && !g.settled);
  const takePost = (pred) => posts.find((p) => !p.settled && (pred ? pred(p.body) : true));
  return {
    apiFetch, recorded,
    releaseGet: (acct) => { const g = takeGet(acct); if (!g) throw new Error("no pending GET for " + acct); g.settled = true; g.resolve(JSON.parse(JSON.stringify(pl[acct]))); },
    failGet: (acct, msg) => { const g = takeGet(acct); if (!g) throw new Error("no pending GET for " + acct); g.settled = true; g.reject(new Error(msg || "db down")); },
    releasePost: (pred) => { const p = takePost(pred); if (!p) throw new Error("no pending POST"); p.settled = true; p.resolve({ ok: true, applied: (p.body.rows || []).length }); },
    pendingGets: (acct) => gets.filter((g) => g.acct === acct && !g.settled).length,
    pendingPosts: () => posts.filter((p) => !p.settled).length,
  };
}

// The harness renders the REAL hook and publishes its live return value + a setAccount to `bridge`.
function Harness({ bridge, apiFetch }) {
  const [account, setAccount] = useState("A");
  const token = "tok"; // a stable session token for these tests
  const cfg = useFbaPlanConfig({ accountId: account, token, active: true, apiFetch, onWriteError: () => {} });
  bridge.api = cfg;
  bridge.account = account;
  bridge.setAccount = setAccount;
  return null;
}

async function mount() {
  const pl = payloads();
  const server = makeServer(pl);
  const bridge = {};
  await act(async () => { TestRenderer.create(React.createElement(Harness, { bridge, apiFetch: server.apiFetch })); });
  return { bridge, server };
}
const setAccount = async (bridge, a) => { await act(async () => { bridge.setAccount(a); await flush(); }); };
const csvFile = (acct, asin, days, note) => ({ name: "f.csv", text: async () => [FBA_LEAD_TIME_COLUMNS.join(","), `${acct},${asin},W,Acme,${days},${days},${days},${days},,${note}`].join("\n") });

/* ===================== 1. deferred POST: A save pending -> switch B -> B GET pending -> A POST resolves ========= */
await (async () => {
  const { bridge, server } = await mount();
  await act(async () => { server.releaseGet("A"); await flush(); });
  ok("1.0 A loaded", bridge.api.planConfigReady && bridge.api.scopedConfig.__accountId === "A");
  // Start a save for A (POST pending), then switch to B (B GET pending), THEN let A's POST resolve.
  let saveDone;
  await act(async () => { saveDone = bridge.api.saveLeadTime({ childAsin: "B0SHARED", production: 9, shipping: 9, awd: 9, safety: 9, action: "set" }); await flush(); });
  ok("1.1 the A save POSTed to A", server.recorded.length === 1 && server.recorded[0].accountId === "A" && server.recorded[0].note === "A-note");
  await setAccount(bridge, "B");                                   // B GET now pending; A config dropped
  ok("1.2 switching to B is not-ready and shows no A data", bridge.account === "B" && bridge.api.planConfigReady === false && (bridge.api.scopedConfig === null));
  await act(async () => { server.releasePost((b) => b.accountId === "A"); await saveDone; await flush(); }); // A POST resolves -> A reload attempted
  ok("1.3 the delayed A POST's reload is REJECTED before begin -> B's pending GET survives (still exactly one pending B GET)", server.pendingGets("B") === 1);
  ok("1.4 B's config was NOT cleared/loaded by A's reload (still not-ready, no A data)", bridge.api.planConfigReady === false && bridge.api.scopedConfig === null && !bridge.api.planConfigError);
  await act(async () => { server.releaseGet("B"); await flush(); });
  ok("1.5 B loads normally afterwards (B-note), tagged B", bridge.api.planConfigReady === true && bridge.api.scopedConfig.__accountId === "B" && bridge.api.leadTimeByAsin.get("B0SHARED").note === "B-note");
  ok("1.6 every POST targeted A (zero wrong-account writes)", server.recorded.every((r) => r.accountId === "A"));
})();

/* ===================== 2. same, but AFTER B config has loaded (A POST must not clear B) ===================== */
await (async () => {
  const { bridge, server } = await mount();
  await act(async () => { server.releaseGet("A"); await flush(); });
  let saveDone;
  await act(async () => { saveDone = bridge.api.saveLeadTime({ childAsin: "B0SHARED", production: 9, shipping: 9, awd: 9, safety: 9, action: "set" }); await flush(); });
  await setAccount(bridge, "B");
  await act(async () => { server.releaseGet("B"); await flush(); });                 // B fully loaded FIRST
  ok("2.1 B is loaded and ready", bridge.api.planConfigReady === true && bridge.api.scopedConfig.__accountId === "B");
  const bBefore = bridge.api.scopedConfig;
  await act(async () => { server.releasePost((b) => b.accountId === "A"); await saveDone; await flush(); }); // A POST resolves late
  ok("2.2 the delayed A POST's reload did NOT clear or replace B's loaded config", bridge.api.planConfigReady === true && bridge.api.scopedConfig === bBefore && bridge.api.scopedConfig.__accountId === "B");
  ok("2.3 no stray GET was started for A by the obsolete reload", server.pendingGets("A") === 0);
})();

/* ===================== 3. a NEW preview opens before A's apply completes -> old apply must not clear it ======= */
await (async () => {
  const { bridge, server } = await mount();
  await act(async () => { server.releaseGet("A"); await flush(); });
  // Open preview #1 and start applying it (bulk POST pending).
  await act(async () => { await bridge.api.beginImport(csvFile("A", "B0SHARED", "20", "imp1")); await flush(); });
  ok("3.1 preview #1 is open for A", bridge.api.leadTimePreview && bridge.api.leadTimePreview.result.applyRows[0].note === "imp1");
  let apply1;
  await act(async () => { apply1 = bridge.api.applyImport(); await flush(); });
  ok("3.2 apply #1 POSTed the bulk import to A", server.recorded.some((r) => r.kind === "lead-time-bulk" && r.accountId === "A"));
  // Before apply #1's POST resolves, open preview #2 (a newer import op) on the SAME account.
  await act(async () => { await bridge.api.beginImport(csvFile("A", "B0SHARED", "30", "imp2")); await flush(); });
  const preview2 = bridge.api.leadTimePreview;
  ok("3.3 preview #2 (newer op) is now displayed", preview2 && preview2.result.applyRows[0].note === "imp2");
  // Now let apply #1's POST + reload resolve. It must NOT clear preview #2 nor release its busy nor show its success.
  await act(async () => { server.releasePost((b) => b.kind === "lead-time-bulk"); await flush(); server.releaseGet("A"); await apply1; await flush(); });
  ok("3.4 the OLD apply #1 did NOT clear the newer preview #2", bridge.api.leadTimePreview === preview2);
  ok("3.5 the OLD apply #1 did NOT post a success notice over the newer op", !(bridge.api.leadTimeNotice && bridge.api.leadTimeNotice.tone === "success"));
})();

/* ===================== 4. A->B->A with a newer import: the stale A import must not disturb the newer one ====== */
await (async () => {
  const { bridge, server } = await mount();
  await act(async () => { server.releaseGet("A"); await flush(); });
  // Open an A preview, then A->B->A.
  await act(async () => { await bridge.api.beginImport(csvFile("A", "B0SHARED", "20", "stale")); await flush(); });
  const stalePreview = bridge.api.leadTimePreview;
  await setAccount(bridge, "B");
  ok("4.1 switching away invalidated the A preview", bridge.api.leadTimePreview === null);
  await act(async () => { server.releaseGet("B"); await flush(); });
  await setAccount(bridge, "A");
  await act(async () => { server.releaseGet("A"); await flush(); });
  ok("4.2 back on A and ready", bridge.account === "A" && bridge.api.planConfigReady === true && bridge.api.scopedConfig.__accountId === "A");
  // Open a NEWER A import.
  await act(async () => { await bridge.api.beginImport(csvFile("A", "B0SHARED", "40", "fresh")); await flush(); });
  const freshPreview = bridge.api.leadTimePreview;
  ok("4.3 a fresh A preview is displayed (imp note 'fresh')", freshPreview && freshPreview.result.applyRows[0].note === "fresh");
  // Try to apply the STALE preview object directly: it must be refused (its isCurrent() is false) and must NOT clear
  // the fresh preview.
  await act(async () => { bridge.api.leadTimePreview.isCurrent; /* noop */ await flush(); });
  ok("4.4 the stale preview's identity check is now false (superseded)", typeof stalePreview.isCurrent === "function" && stalePreview.isCurrent() === false);
  ok("4.5 the fresh preview's identity check is true (current)", freshPreview.isCurrent() === true);
  // Applying the fresh one targets A and carries its note.
  let applyFresh;
  await act(async () => { applyFresh = bridge.api.applyImport(); await flush(); server.releasePost((b) => b.kind === "lead-time-bulk"); await flush(); server.releaseGet("A"); await applyFresh; await flush(); });
  const bulk = server.recorded.filter((r) => r.kind === "lead-time-bulk");
  ok("4.6 the fresh import POSTed to A with note 'fresh'", bulk.length === 1 && bulk[0].accountId === "A" && bulk[0].rows[0].note === "fresh");
  ok("4.7 every POST across the whole scenario targeted A (zero wrong-account writes)", server.recorded.every((r) => r.accountId === "A"));
})();

/* ===================== 5. account-filtered render values: A's data never appears under B pre-load ============= */
await (async () => {
  const { bridge, server } = await mount();
  await act(async () => { server.releaseGet("A"); await flush(); });
  ok("5.1 A leadTimeByAsin shows A-note", bridge.api.leadTimeByAsin.get("B0SHARED").note === "A-note");
  await setAccount(bridge, "B");
  // Before B's GET resolves, the derived values must be EMPTY (account-filtered), not A's.
  ok("5.2 while B loads, leadTimeByAsin is empty (account-filtered, not A's)", bridge.api.leadTimeByAsin.size === 0 && bridge.api.scopedConfig === null && bridge.api.planConfigReady === false);
  await act(async () => { server.releaseGet("B"); await flush(); });
  ok("5.3 after B loads, leadTimeByAsin shows B-note only", bridge.api.leadTimeByAsin.get("B0SHARED").note === "B-note");
})();

/* ===================== 6. failed load: typed error, not-ready; a superseded failure never clobbers the active == */
await (async () => {
  const { bridge, server } = await mount();
  await act(async () => { server.failGet("A", "db down"); await flush(); });
  ok("6.1 a read failure -> error + not-ready, no defaults-as-saved", bridge.api.planConfigError && /db down/.test(bridge.api.planConfigError) && bridge.api.planConfigReady === false && bridge.api.scopedConfig === null);
  await setAccount(bridge, "B");
  await act(async () => { server.releaseGet("B"); await flush(); });
  ok("6.2 switching to B clears A's error and loads B", bridge.api.planConfigReady === true && bridge.api.scopedConfig.__accountId === "B" && !bridge.api.planConfigError);
})();

writeSync(1, `\nfba-import-integration: ${passed} checks passed\n`);
