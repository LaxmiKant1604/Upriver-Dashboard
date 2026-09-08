// FBA lead-time import + account-safe config INTEGRATION tests (audit 2026-09-08, round 2). Renders a REAL React
// component with react-test-renderer that wires the SAME extracted helpers App.jsx uses (import-lifecycle +
// scoped-loader) + the REAL parser (validateFbaLeadTimeText) + a controllable fetch, and drives the real callbacks:
// file-select -> delayed parse -> preview -> account switch -> confirm -> POST -> reload. Asserts request account
// identity (zero wrong-account writes), account-keyed visible values, and persisted notes through inline edit /
// Start-Reset / template round-trip. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import TestRenderer from "react-test-renderer";
import { makeScopedLoader } from "../src/lib/scoped-loader.js";
import { importScopeKey, resolveLeadTimeNote, canApplyImport, tagConfigAccount, isConfigReady } from "../src/lib/import-lifecycle.js";
import { validateFbaLeadTimeText, buildFbaLeadTimeMatrix, validateFbaLeadTimeRows, FBA_LEAD_TIME_COLUMNS } from "../src/lib/fba-lead-time-import.js";

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); };
writeSync(1, "fba-import-integration\n");
const act = TestRenderer.act;
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

// Per-account durable config the fake server returns (mirrors GET /api/fba-plan-config leadTimes rows). Same child
// ASIN B0SHARED exists in BOTH accounts with DIFFERENT notes/days -> proves account isolation + no cross-account write.
function serverPayloads() {
  return {
    A: { settings: null, overrides: [], warehouse: [], wddWeights: [], leadTimes: [
      { child_asin: "B0SHARED", production_days: 5, shipping_days: 10, awd_transfer_days: 3, safety_stock_days: 7, inbound_started_date: null, inbound_eta: null, note: "A-note", updated_by_email: "" },
    ] },
    B: { settings: null, overrides: [], warehouse: [], wddWeights: [], leadTimes: [
      { child_asin: "B0SHARED", production_days: 1, shipping_days: 2, awd_transfer_days: 1, safety_stock_days: 1, inbound_started_date: null, inbound_eta: null, note: "B-note", updated_by_email: "" },
    ] },
  };
}

// A controllable config server: each fetch(acct) returns a promise held until release(acct[,index]); or auto-resolves.
function makeServer(payloads) {
  const pending = []; // { acct, resolve, reject, settled }
  const fetchImpl = (acct) => new Promise((resolve, reject) => pending.push({ acct, resolve, reject }));
  const take = (acct) => pending.find((p) => p.acct === acct && !p.settled);
  return {
    fetchImpl,
    release: (acct) => { const p = take(acct); if (!p) throw new Error("no pending fetch for " + acct); p.settled = true; p.resolve(JSON.parse(JSON.stringify(payloads[acct]))); },
    fail: (acct, msg) => { const p = take(acct); if (!p) throw new Error("no pending fetch for " + acct); p.settled = true; p.reject(new Error(msg || "db down")); },
    pendingCount: (acct) => pending.filter((p) => p.acct === acct && !p.settled).length,
  };
}

// The harness: a REAL component that mirrors App.jsx's FBA config + import handlers using the shared helpers. It
// publishes its live state + callbacks to `bridge` after every render so the test can drive them inside act().
function Plan({ bridge, fetchImpl, posted }) {
  const [account, setAccount] = useState("A");
  const [token, setToken] = useState("tok");
  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState(null);
  const [preview, setPreview] = useState(null);
  const [notice, setNotice] = useState(null);
  const accountRef = useRef(account); useEffect(() => { accountRef.current = account; }, [account]);
  const tokenRef = useRef(token); useEffect(() => { tokenRef.current = token; }, [token]);
  const loader = useRef(null); if (!loader.current) loader.current = makeScopedLoader(() => accountRef.current);
  const importLoader = useRef(null); if (!importLoader.current) importLoader.current = makeScopedLoader(() => importScopeKey(accountRef.current, tokenRef.current));
  const ltRef = useRef(new Map());

  const loadConfig = useCallback(async () => {
    const acct = account, tok = token;
    if (!acct || !tok) { setConfig(null); setConfigError(null); return; }
    const isCurrent = loader.current.begin(acct);
    setConfig((prev) => (prev && prev.__accountId === acct ? prev : null));
    setConfigError(null);
    try { const cfg = await fetchImpl(acct); if (!isCurrent()) return; setConfig(tagConfigAccount(cfg, acct)); setConfigError(null); }
    catch (e) { if (!isCurrent()) return; setConfig(null); setConfigError(String(e.message || e)); }
  }, [account, token]);
  useEffect(() => { loadConfig(); }, [loadConfig]);
  useEffect(() => { setPreview(null); setNotice(null); }, [account, token]);

  const leadTimeByAsin = useMemo(() => {
    const m = new Map();
    for (const lt of config?.leadTimes || []) m.set(String(lt.child_asin || "").toUpperCase(), { production: lt.production_days ?? null, shipping: lt.shipping_days ?? null, awd: lt.awd_transfer_days ?? null, safety: lt.safety_stock_days ?? null, inboundEta: lt.inbound_eta || null, note: lt.note || "" });
    return m;
  }, [config?.leadTimes]);
  useEffect(() => { ltRef.current = leadTimeByAsin; }, [leadTimeByAsin]);
  const configReady = isConfigReady(config, account);

  const saveLeadTime = useCallback(async ({ childAsin, production, shipping, awd, safety, note, action = "set", startedDate } = {}) => {
    const acct = account, tok = token;
    if (!acct || !tok || !childAsin) return;
    const body = { kind: "lead-time", accountId: acct, childAsin, action };
    if (action !== "clear") {
      body.production = production; body.shipping = shipping; body.awd = awd; body.safety = safety;
      body.note = resolveLeadTimeNote(note, ltRef.current.get(String(childAsin).toUpperCase())?.note);
      if (action === "start") body.startedDate = startedDate;
    }
    posted.push(body);
    await loadConfig();
  }, [account, token, loadConfig]);

  // Mirrors onImportLeadTimeFile: capture identity, delayed read, guarded parse -> preview.
  const parseFile = useCallback(async (fileText, read) => {
    const acct = account, tok = token;
    if (!acct || !tok) { setNotice({ tone: "error", msg: "no account" }); return; }
    if (!configReady) { setNotice({ tone: "warning", msg: "loading" }); return; }
    const scope = importScopeKey(acct, tok);
    const isCurrent = importLoader.current.begin(scope);
    setNotice(null); setPreview(null);
    const text = await read(fileText); // deliberately delayed read
    if (!isCurrent()) return;
    const result = validateFbaLeadTimeText(text, { expectedAccountId: acct, currentByAsin: leadTimeByAsin });
    if (!isCurrent()) return;
    if (!result.ok) { setNotice({ tone: "error", msg: result.message }); return; }
    setPreview({ result, fileName: "f.csv", accountId: acct, token: tok, scope, isCurrent });
  }, [account, token, configReady, leadTimeByAsin]);

  // Mirrors applyLeadTimePreview: recheck identity before POST; POST targets the PARSED account.
  const applyPreview = useCallback(async () => {
    const pv = preview; const rows = pv?.result?.applyRows;
    if (!rows || !rows.length) { setPreview(null); return; }
    const guard = canApplyImport(pv.scope, account, token);
    if (!guard.ok || (typeof pv.isCurrent === "function" && !pv.isCurrent())) { setPreview(null); setNotice({ tone: "warning", msg: "cancelled" }); return; }
    posted.push({ kind: "lead-time-bulk", accountId: pv.accountId, rows: rows.map((r) => ({ childAsin: r.childAsin, production: r.production, shipping: r.shipping, awd: r.awd, safety: r.safety, inboundEta: r.inboundEta, note: r.note || "" })) });
    await loadConfig();
    if (typeof pv.isCurrent !== "function" || pv.isCurrent()) setNotice({ tone: "success", msg: "applied to " + pv.accountId });
    setPreview(null);
  }, [preview, account, token, loadConfig]);

  // Mirrors downloadLeadTimeTemplate row construction: the SAVED note is used (never hardcoded "").
  const buildTemplate = useCallback(() => {
    const rows = [];
    for (const [asin, lt] of leadTimeByAsin) rows.push({ asin, production: lt.production, shipping: lt.shipping, awd: lt.awd, safety: lt.safety, inboundEta: lt.inboundEta, note: lt.note ?? "" });
    return buildFbaLeadTimeMatrix({ accountId: account, rows });
  }, [leadTimeByAsin, account]);

  useEffect(() => {
    bridge.api = { account, token, config, configReady, configError, preview, notice, setAccount, setToken, saveLeadTime, parseFile, applyPreview, buildTemplate, leadTimeByAsin };
  });
  return null;
}

async function mount() {
  const posted = [];
  const payloads = serverPayloads();
  const server = makeServer(payloads);
  const bridge = {};
  let renderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(Plan, { bridge, fetchImpl: server.fetchImpl, posted })); });
  return { bridge, server, posted, payloads, renderer };
}

/* ===================== A. account-keyed config: A's values never show under B while B loads ===================== */
await (async () => {
  const { bridge, server, posted } = await mount();
  await act(async () => { server.release("A"); await flush(); });
  ok("A1: A's config loads and is tagged to A (note visible = A-note)", bridge.api.configReady === true && bridge.api.config.__accountId === "A" && bridge.api.leadTimeByAsin.get("B0SHARED").note === "A-note");
  // Switch to B: config must clear IMMEDIATELY (no A data under B) and actions disabled until B loads.
  await act(async () => { bridge.api.setAccount("B"); await flush(); });
  ok("A2: switching to B clears A's config at once -> not ready, NO A values exposed under B", bridge.api.configReady === false && (bridge.api.config === null || bridge.api.config.__accountId !== "A"));
  await act(async () => { server.release("B"); await flush(); });
  ok("A3: once B loads, only B's values show (note = B-note), tagged to B", bridge.api.configReady === true && bridge.api.config.__accountId === "B" && bridge.api.leadTimeByAsin.get("B0SHARED").note === "B-note");
  ok("A4: zero writes from switching accounts", posted.length === 0);
})();

/* ===================== B. A->B->A config race: the second A wins, no stale/other-account data ===================== */
await (async () => {
  const { bridge, server } = await mount();
  await act(async () => { server.release("A"); await flush(); }); // initial A
  await act(async () => { bridge.api.setAccount("B"); await flush(); }); // A load #2 pending? no -> B pending
  await act(async () => { bridge.api.setAccount("A"); await flush(); }); // back to A -> a new A fetch pending
  // Resolve OUT OF ORDER: the stale B first, then the newest A.
  await act(async () => { server.release("B"); await flush(); });
  ok("B1: the superseded B response never applies (live account is A)", bridge.api.account === "A" && (bridge.api.config === null || bridge.api.config.__accountId !== "B"));
  await act(async () => { server.release("A"); await flush(); });
  ok("B2: the newest A response applies (A-note), never a stale one", bridge.api.configReady === true && bridge.api.config.__accountId === "A" && bridge.api.leadTimeByAsin.get("B0SHARED").note === "A-note");
})();

/* ===================== C. delayed parse + account switch: an A-parsed preview never opens/applies under B ===== */
await (async () => {
  const { bridge, server, posted } = await mount();
  await act(async () => { server.release("A"); await flush(); });
  const csv = [FBA_LEAD_TIME_COLUMNS.join(","), "A,B0SHARED,Widget,Acme,9,9,9,9,,A parsed note"].join("\n");
  // Start a parse whose file READ is held; switch to B mid-read; then let the read finish.
  let releaseRead; const heldRead = () => new Promise((res) => { releaseRead = res; });
  let parseDone;
  await act(async () => { parseDone = bridge.api.parseFile(csv, () => heldRead()); await flush(); });
  await act(async () => { bridge.api.setAccount("B"); await flush(); }); // switch to B while the A read is in flight
  await act(async () => { server.release("B"); await flush(); }); // B config loads
  await act(async () => { releaseRead(csv); await parseDone; await flush(); }); // the A read completes LATE
  ok("C1: the A-parsed preview is DISCARDED after the switch to B (no preview opens under B)", bridge.api.preview === null);
  ok("C2: zero writes from the abandoned parse", posted.length === 0);
})();

/* ===================== D. same ASIN in both accounts: a preview parsed under A cannot be applied under B ===== */
await (async () => {
  const { bridge, server, posted } = await mount();
  await act(async () => { server.release("A"); await flush(); });
  const csv = [FBA_LEAD_TIME_COLUMNS.join(","), "A,B0SHARED,Widget,Acme,20,20,20,20,,A-import-note"].join("\n");
  await act(async () => { await bridge.api.parseFile(csv, (t) => Promise.resolve(t)); await flush(); });
  ok("D1: a preview opened for A", bridge.api.preview && bridge.api.preview.accountId === "A" && bridge.api.preview.result.applyRows[0].childAsin === "B0SHARED");
  // Switch to B (which also holds the same ASIN), then try to apply the A-preview.
  await act(async () => { bridge.api.setAccount("B"); await flush(); });
  await act(async () => { server.release("B"); await flush(); });
  ok("D2: switching to B invalidated the pending A-preview (cleared on account change)", bridge.api.preview === null);
  // Even a stale preview object cannot be applied to B: recheck refuses.
  const stalePv = { result: { applyRows: [{ childAsin: "B0SHARED", production: 20, shipping: 20, awd: 20, safety: 20, inboundEta: null, note: "A-import-note" }] }, accountId: "A", token: "tok", scope: importScopeKey("A", "tok"), isCurrent: () => true };
  const guard = canApplyImport(stalePv.scope, bridge.api.account, bridge.api.token);
  ok("D3: canApplyImport refuses to apply the A-scope preview under B (never retargeted)", guard.ok === false && guard.reason === "scope-changed");
  ok("D4: zero wrong-account writes (nothing posted)", posted.length === 0);
})();

/* ===================== E. happy path: parse -> confirm -> POST targets the PARSED account, then reload ===== */
await (async () => {
  const { bridge, server, posted } = await mount();
  await act(async () => { server.release("A"); await flush(); });
  const csv = [FBA_LEAD_TIME_COLUMNS.join(","), "A,B0SHARED,Widget,Acme,20,20,20,20,,A-import-note"].join("\n");
  await act(async () => { await bridge.api.parseFile(csv, (t) => Promise.resolve(t)); await flush(); });
  // Apply; the reload fetch is delayed to prove save-success is reported and identity holds.
  let applyDone;
  await act(async () => { applyDone = bridge.api.applyPreview(); await flush(); });
  ok("E1: the bulk POST targets account A (the parsed account) with the note carried", posted.length === 1 && posted[0].kind === "lead-time-bulk" && posted[0].accountId === "A" && posted[0].rows[0].note === "A-import-note");
  await act(async () => { server.release("A"); await applyDone; await flush(); }); // post-save reload completes
  ok("E2: success notice shown after the delayed reload; preview cleared", bridge.api.notice && bridge.api.notice.tone === "success" && bridge.api.preview === null);
  ok("E3: every POST body's accountId is 'A' (zero wrong-account writes)", posted.every((p) => p.accountId === "A"));
})();

/* ===================== F. note preservation through inline day edit + Start/Reset ===================== */
await (async () => {
  const { bridge, server, posted } = await mount();
  await act(async () => { server.release("A"); await flush(); });
  // Inline day edit: omit note -> the saved A-note must be preserved in the POST body.
  await act(async () => { const p = bridge.api.saveLeadTime({ childAsin: "B0SHARED", production: 6, shipping: 10, awd: 3, safety: 7, action: "set" }); await flush(); server.release("A"); await p; await flush(); });
  ok("F1: an inline day edit (no note supplied) PRESERVES the saved note (A-note), never clears it", posted[0].kind === "lead-time" && posted[0].note === "A-note" && posted[0].production === 6);
  // Start/Reset: omit note -> preserved.
  await act(async () => { const p = bridge.api.saveLeadTime({ childAsin: "B0SHARED", production: 6, shipping: 10, awd: 3, safety: 7, action: "start", startedDate: "2026-01-10" }); await flush(); server.release("A"); await p; await flush(); });
  ok("F2: Start/Reset (no note supplied) PRESERVES the saved note", posted[1].action === "start" && posted[1].note === "A-note");
  // Explicit note change is honored; an explicit "" clears (intentional).
  await act(async () => { const p = bridge.api.saveLeadTime({ childAsin: "B0SHARED", production: 6, shipping: 10, awd: 3, safety: 7, note: "edited", action: "set" }); await flush(); server.release("A"); await p; await flush(); });
  ok("F3: an EXPLICIT note is written verbatim", posted[2].note === "edited");
  ok("F3b: an EXPLICIT blank note clears (intentional blank-as-clear)", resolveLeadTimeNote("", "A-note") === "" && resolveLeadTimeNote(undefined, "A-note") === "A-note");
})();

/* ===================== G. template download uses the SAVED note -> round-trips unchanged ===================== */
await (async () => {
  const { bridge, server } = await mount();
  await act(async () => { server.release("A"); await flush(); });
  const matrix = bridge.api.buildTemplate();
  const noteCol = FBA_LEAD_TIME_COLUMNS.indexOf("note");
  ok("G1: the downloaded template carries the SAVED note (A-note), not a hardcoded blank", matrix[1][noteCol] === "A-note");
  const r = validateFbaLeadTimeRows(matrix, { expectedAccountId: "A" });
  ok("G2: re-importing the UNCHANGED template preserves the note through the parser", r.ok === true && r.applyRows[0].note === "A-note");
})();

/* ===================== H. failed config load: error shown, defaults NOT rendered as saved ===================== */
await (async () => {
  const { bridge, server } = await mount();
  await act(async () => { server.fail("A", "db down"); await flush(); });
  ok("H1: a read failure shows a typed error and NO config (not ready), never defaults-as-saved", bridge.api.config === null && bridge.api.configReady === false && /db down/.test(bridge.api.configError));
  // A stale failure for a superseded account must not clobber the active one.
  await act(async () => { bridge.api.setAccount("B"); await flush(); server.release("B"); await flush(); });
  ok("H2: switching to B and loading B clears A's error; B is ready", bridge.api.configReady === true && bridge.api.config.__accountId === "B" && !bridge.api.configError);
})();

writeSync(1, `\nfba-import-integration: ${passed} checks passed\n`);
