// The FBA Shipment Plan CONFIGURATION lifecycle as a real, reusable hook -- the SINGLE production implementation that
// App.jsx renders AND the tests drive (no separately-copied test component). It owns the account-scoped config load,
// the obsolete-reload rejection, the account-filtered config, and the whole lead-time import lifecycle
// (file -> async parse -> preview -> confirm -> POST -> reload), each side effect guarded by operation identity.
//
// Collaborators are INJECTED so the hook is offline-testable: `apiFetch(path, token, opts)` (authFetch in prod),
// `onWriteError(msg)` (surface a save error), `readXlsx(arrayBuffer)` (the .xlsx reader; prod lazy-imports it).
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { makeScopedLoader } from "./scoped-loader.js";
import { importScopeKey, resolveLeadTimeNote, canApplyImport, tagConfigAccount, configForAccount, isConfigReady } from "./import-lifecycle.js";
import { validateFbaLeadTimeRows, validateFbaLeadTimeText } from "./fba-lead-time-import.js";

export function useFbaPlanConfig({ accountId, token, active = true, apiFetch, onWriteError, readXlsx } = {}) {
  const [planConfig, setPlanConfig] = useState(null);
  const [planConfigError, setPlanConfigError] = useState(null);
  const [planConfigBusy, setPlanConfigBusy] = useState(false);
  const [leadTimePreview, setLeadTimePreview] = useState(null);
  const [leadTimeNotice, setLeadTimeNotice] = useState(null);
  const [leadTimeImportBusy, setLeadTimeImportBusy] = useState(false);

  // LIVE account + token mirrored into refs (kept in ONE effect keyed on both; never a token-only effect, which would
  // re-fire on every silent refresh -- the session-SWR invariant) so an in-flight load/import/reload sees the truth.
  const accountRef = useRef(accountId);
  const tokenRef = useRef(token);
  useEffect(() => { accountRef.current = accountId; tokenRef.current = token; }, [accountId, token]);
  const loader = useRef(null); if (!loader.current) loader.current = makeScopedLoader(() => accountRef.current);
  const importLoader = useRef(null); if (!importLoader.current) importLoader.current = makeScopedLoader(() => importScopeKey(accountRef.current, tokenRef.current));
  const leadTimeByAsinRef = useRef(new Map());

  // DEFECT 1: reject an OBSOLETE reload BEFORE loader.begin(), before clearing state, before touching the error. A
  // delayed POST for account A that resolves after a switch to B must NOT start an A reload (which would bump the
  // generation and invalidate B's in-flight request) nor clear B's config. The reload is bound to `accountId`/`token`
  // (its closure); if the LIVE account/token (refs) no longer match, this reload is obsolete -> no-op.
  const reload = useCallback(async () => {
    const acct = accountId, tok = token;
    if (!acct || !tok) { setPlanConfig(null); setPlanConfigError(null); return; }
    if (accountRef.current !== acct || tokenRef.current !== tok) return; // obsolete: the live scope moved on
    const isCurrent = loader.current.begin(acct);
    setPlanConfig((prev) => (prev && prev.__accountId === acct ? prev : null)); // drop other-account config at once
    setPlanConfigError(null);
    try {
      const cfg = await apiFetch(`/api/fba-plan-config?accountId=${encodeURIComponent(acct)}`, tok);
      if (!isCurrent()) return;
      setPlanConfig(tagConfigAccount(cfg, acct));
      setPlanConfigError(null);
    } catch (e) {
      if (!isCurrent()) return;
      setPlanConfig(null);
      setPlanConfigError(String(e && e.message ? e.message : e) || "Could not load this account's configuration.");
    }
  }, [accountId, token, apiFetch]);
  useEffect(() => { if (active) reload(); else { setPlanConfig(null); setPlanConfigError(null); } }, [active, reload]);
  // Invalidate any pending import parse / preview + its notice/busy the instant the account or session changes.
  useEffect(() => { setLeadTimePreview(null); setLeadTimeNotice(null); setLeadTimeImportBusy(false); }, [accountId, token]);

  // DEFECT 3: account-FILTERED config for every render-time derived value (settings, warehouse, overrides, WDD, lead
  // times, template/preview). Even if the raw state transiently holds account A while the live account is B (before
  // the reload's clear commits), scopedConfig is null for B -> no A data is ever derived under B, at render time.
  const scopedConfig = useMemo(() => configForAccount(planConfig, accountId), [planConfig, accountId]);
  const planConfigReady = !!scopedConfig;
  const planActionsBusy = planConfigBusy || !planConfigReady;

  const leadTimeByAsin = useMemo(() => {
    const m = new Map();
    for (const lt of scopedConfig?.leadTimes || []) m.set(String(lt.child_asin || "").toUpperCase(), {
      production: lt.production_days ?? null, shipping: lt.shipping_days ?? null, awd: lt.awd_transfer_days ?? null, safety: lt.safety_stock_days ?? null,
      inboundStarted: lt.inbound_started_date || null, inboundEta: lt.inbound_eta || null, note: lt.note || "", updatedByEmail: lt.updated_by_email || "",
    });
    return m;
  }, [scopedConfig]);
  useEffect(() => { leadTimeByAsinRef.current = leadTimeByAsin; }, [leadTimeByAsin]);

  // Generic guarded write for EVERY config save: POST then the guarded reload (defect 1 covers all saves). `busy`
  // toggles planConfigBusy (off for the warehouse modal, which owns its own applying state); `rethrow` for callers
  // that surface their own error. onError defaults to the injected onWriteError.
  const write = useCallback(async (body, { busy = true, rethrow = false, onError = onWriteError } = {}) => {
    const acct = accountId, tok = token;
    if (!acct || !tok) return null;
    if (busy) setPlanConfigBusy(true);
    try { const res = await apiFetch("/api/fba-plan-config", tok, { method: "POST", body: JSON.stringify(body) }); await reload(); return res; }
    catch (e) { if (typeof onError === "function") onError(String(e && e.message ? e.message : e)); if (rethrow) throw e; return null; }
    finally { if (busy) setPlanConfigBusy(false); }
  }, [accountId, token, apiFetch, reload, onWriteError]);

  // Inline per-ASIN lead-time save. PRESERVES the existing note when the caller omits it (day edit / Start-Reset).
  const saveLeadTime = useCallback(async ({ childAsin, production, shipping, awd, safety, note, action = "set", startedDate } = {}) => {
    if (!accountId || !token || !childAsin) return;
    const body = { kind: "lead-time", accountId, childAsin, action };
    if (action !== "clear") {
      body.production = production; body.shipping = shipping; body.awd = awd; body.safety = safety;
      body.note = resolveLeadTimeNote(note, leadTimeByAsinRef.current.get(String(childAsin).toUpperCase())?.note);
      if (action === "start") body.startedDate = startedDate;
    }
    await write(body, { rethrow: true });
  }, [accountId, token, write]);

  // Atomic bulk lead-time import. `targetAccountId` (the account the preview was PARSED for) is used verbatim so the
  // POST can never be retargeted to a different live account; the caller rechecks identity immediately before this.
  const bulkImportLeadTimes = useCallback(async (rows, targetAccountId) => {
    const acct = targetAccountId || accountId, tok = token;
    if (!acct || !tok) throw new Error("No account selected.");
    const res = await apiFetch("/api/fba-plan-config", tok, { method: "POST", body: JSON.stringify({ kind: "lead-time-bulk", accountId: acct, rows }) });
    await reload();
    return res;
  }, [accountId, token, apiFetch, reload]);

  // file-select -> delayed read -> guarded parse -> preview. The whole parse is bound to an immutable scope; a
  // mid-flight account/session change (or a newer file) discards it (isCurrent() false) so it never becomes a preview.
  const beginImport = useCallback(async (file) => {
    if (!file) return;
    const acct = accountId, tok = token;
    if (!acct || !tok) { setLeadTimeNotice({ tone: "error", msg: "Select an account before importing." }); return; }
    if (!isConfigReady(planConfig, acct)) { setLeadTimeNotice({ tone: "warning", msg: "This account's configuration is still loading; try again in a moment." }); return; }
    const scope = importScopeKey(acct, tok);
    const isCurrent = importLoader.current.begin(scope);
    setLeadTimeNotice(null); setLeadTimePreview(null); setLeadTimeImportBusy(true);
    try {
      const opts = { expectedAccountId: acct, currentByAsin: leadTimeByAsin };
      let result;
      if (/\.xlsx$/i.test(file.name)) {
        const read = readXlsx || (await import("./xlsx-read.js")).readXlsxFirstSheet;
        const buf = await file.arrayBuffer();
        if (!isCurrent()) return;
        result = validateFbaLeadTimeRows(await read(buf), opts);
      } else {
        const text = await file.text();
        if (!isCurrent()) return;
        result = validateFbaLeadTimeText(text, opts);
      }
      if (!isCurrent()) return; // account/session changed (or a newer file) while parsing -> discard silently
      if (!result.ok) { setLeadTimeNotice({ tone: result.nothingToApply ? "warning" : "error", msg: result.message || "Import invalid; nothing was written." }); return; }
      setLeadTimePreview({ result, fileName: file.name, accountId: acct, token: tok, scope, isCurrent });
    } catch (e) { if (isCurrent()) setLeadTimeNotice({ tone: "error", msg: (e && e.message) || "Could not read the file; nothing was written." }); }
    finally { if (isCurrent()) setLeadTimeImportBusy(false); }
  }, [accountId, token, planConfig, leadTimeByAsin, readXlsx]);

  // DEFECT 2: guard EVERY completion side effect by operation identity. `current()` is true only when THIS import op
  // is still the active one (its generation + the live scope). Preview clears use a functional update keyed on the
  // exact preview object, so an OLD apply can NEVER clear a NEWER preview; busy/notice only fire when still current.
  const applyImport = useCallback(async () => {
    const pv = leadTimePreview;
    const rows = pv?.result?.applyRows;
    const current = () => !!pv && (typeof pv.isCurrent !== "function" || pv.isCurrent()) && canApplyImport(pv.scope, accountRef.current, tokenRef.current).ok;
    const clearThisPreview = () => setLeadTimePreview((cur) => (cur === pv ? null : cur));
    if (!pv || !rows || !rows.length) { clearThisPreview(); return; }
    if (!current()) { clearThisPreview(); return; } // superseded (account/session/newer import) -> never retarget
    setLeadTimeImportBusy(true); setLeadTimeNotice(null);
    try {
      const res = await bulkImportLeadTimes(rows.map((r) => ({ childAsin: r.childAsin, production: r.production, shipping: r.shipping, awd: r.awd, safety: r.safety, inboundEta: r.inboundEta, note: r.note || "" })), pv.accountId);
      if (current()) { setLeadTimeNotice({ tone: "success", msg: `Applied ${res?.applied ?? rows.length} ASIN lead-time row(s) to ${pv.accountId}.` }); clearThisPreview(); }
    } catch (e) { if (current()) setLeadTimeNotice({ tone: "error", msg: (e && e.message) || "Could not import lead times; nothing was written." }); }
    finally { if (current()) setLeadTimeImportBusy(false); }
  }, [leadTimePreview, bulkImportLeadTimes]);

  const dismissPreview = useCallback(() => setLeadTimePreview(null), []);

  return {
    planConfig, scopedConfig, planConfigError, planConfigReady, planConfigBusy, planActionsBusy, leadTimeByAsin,
    reload, write, saveLeadTime, bulkImportLeadTimes,
    leadTimePreview, leadTimeNotice, leadTimeImportBusy, beginImport, applyImport, dismissPreview, setLeadTimeNotice,
  };
}
