// ACCOUNT-scoped FBA Shipment Plan column-visibility lifecycle as a real, reusable hook -- the SINGLE production
// implementation App.jsx renders AND the tests drive. The saved hidden set is a SHARED account-level display layout
// (any authorized user of the account sees the same one); each account keeps its own. Every side effect is guarded by
// account identity + a monotonic request generation (makeScopedLoader), so a delayed A response can never render or
// save under B, and A->B->A never lets an obsolete A op overwrite the latest A.
//
// No local cache: it is optional and, dropped, removes a whole class of stale-cross-account bugs. First paint shows
// PLAN_DEFAULT_HIDDEN_COLS (never the previous account's columns) until the durable server value -- the sole
// authority -- arrives. The legacy per-user key `fbaplan.cols.<userId>` is actively abandoned (never authoritative).
//
// Collaborators are INJECTED so the hook is offline-testable: `apiFetch(path, token, opts)` (authFetch in prod),
// `onWriteError(msg)` (surface a save error). `storage` defaults to window.localStorage (only to purge the old key).
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { makeScopedLoader } from "./scoped-loader.js";
import { PLAN_DEFAULT_HIDDEN_COLS, validateHiddenColumns } from "../../lib/fba-plan-columns.js";

const uniq = (arr) => Array.from(new Set((Array.isArray(arr) ? arr : []).map(String)));
const DEFAULT_HIDDEN = () => uniq(PLAN_DEFAULT_HIDDEN_COLS);

export function useFbaPlanColumns({ accountId, token, active = true, apiFetch, onWriteError, userId = null, storage = undefined } = {}) {
  // State is TAGGED with the account it belongs to, so a render can prove which account it is showing.
  const [state, setState] = useState({ accountId: null, hidden: DEFAULT_HIDDEN() });
  const [busy, setBusy] = useState(false);

  const accountRef = useRef(accountId);
  const tokenRef = useRef(token);
  useEffect(() => { accountRef.current = accountId; tokenRef.current = token; }, [accountId, token]);
  const loader = useRef(null); if (!loader.current) loader.current = makeScopedLoader(() => accountRef.current);
  const saveSeq = useRef(0); // the latest save's sequence; `busy` clears when the LATEST save settles (any account).

  // Abandon the LEGACY user-only authoritative cache once (never read it as the FBA preference again). Best-effort.
  useEffect(() => {
    if (userId == null) return;
    try { const s = storage || (typeof localStorage !== "undefined" ? localStorage : null); if (s) s.removeItem(`fbaplan.cols.${userId}`); } catch { /* ignore */ }
  }, [userId, storage]);

  // Reject an OBSOLETE load BEFORE begin()/state clear: a delayed op for A that resolves after a switch to B must not
  // touch B. Bound to `accountId`/`token` (its closure); if the LIVE scope (refs) moved on, this load is a no-op.
  const reload = useCallback(async () => {
    const acct = accountId;
    const tok = tokenRef.current;                                 // read FRESH: a silent token refresh must NOT re-fire
    if (!acct || !tok) { setState({ accountId: acct || null, hidden: DEFAULT_HIDDEN() }); return; } // this reload nor race a save
    if (accountRef.current !== acct) return;                      // obsolete: the live account already moved on
    const isCurrent = loader.current.begin(acct);
    // GATE immediately: drop any other-account layout so the previous account's columns never flash under this one.
    setState((prev) => (prev && prev.accountId === acct ? prev : { accountId: acct, hidden: DEFAULT_HIDDEN() }));
    try {
      const r = await apiFetch(`/api/fba-plan-columns?accountId=${encodeURIComponent(acct)}`, tok);
      if (!isCurrent()) return;                                   // superseded or scope moved -> discard
      if (!r || String(r.accountId) !== String(acct)) return;    // response is for a DIFFERENT account -> never apply
      // A SAVED layout (updatedAt present) wins even when empty (the user chose "Select all"); an unsaved account
      // uses the default. The durable server value is authoritative -- never a prior local value.
      const hidden = r.updatedAt ? uniq(r.hiddenColumns) : DEFAULT_HIDDEN();
      setState({ accountId: acct, hidden });
    } catch { /* keep the gated default; column prefs are non-critical -- do not error the whole page on a GET */ }
  }, [accountId, apiFetch]);
  // Fire on the ACTIVE view + account change + the COLD arrival of a token (false->true) -- NOT on a token VALUE change
  // (a silent SWR/focus refresh), so an in-flight save is never raced by a spurious reload GET (the session-SWR invariant).
  const hasToken = !!token;
  useEffect(() => { if (active && hasToken) reload(); else if (!active) setState({ accountId: null, hidden: DEFAULT_HIDDEN() }); }, [active, hasToken, reload]);

  // Account-FILTERED hidden set for render: expose the saved layout ONLY when it belongs to the LIVE account; else the
  // default (never account A's columns under B), even if raw state transiently lags before the reload's gate commits.
  const hiddenCols = useMemo(
    () => new Set(state && state.accountId === accountId ? state.hidden : DEFAULT_HIDDEN()),
    [state, accountId],
  );
  const ready = !!(state && state.accountId === accountId);

  // Persist a COMPLETE hidden set for the CURRENTLY selected account: optimistic apply, guarded POST, rollback on
  // failure. `nextHidden` is any iterable of ids; it is client-validated (server re-validates authoritatively).
  const save = useCallback(async (nextHidden) => {
    const acct = accountId;
    if (!acct) return;
    const check = validateHiddenColumns(uniq(Array.from(nextHidden || [])));
    if (!check.ok) { if (typeof onWriteError === "function") onWriteError(check.error); return; }
    const applied = check.cleaned;
    const prev = state && state.accountId === acct ? { accountId: acct, hidden: [...state.hidden] } : { accountId: acct, hidden: DEFAULT_HIDDEN() };
    setState({ accountId: acct, hidden: applied }); // optimistic (this is the current account at click time)
    const tok = tokenRef.current;
    if (!tok) return;
    const isCurrent = loader.current.begin(acct);
    const mySeq = (saveSeq.current += 1);
    setBusy(true);
    try {
      const r = await apiFetch("/api/fba-plan-columns", tok, { method: "POST", body: JSON.stringify({ accountId: acct, hiddenColumns: applied }) });
      if (!isCurrent()) return;                                   // switched away / superseded -> never touch B, never rollback B
      if (!r || String(r.accountId) !== String(acct)) throw new Error("save response was for a different account.");
      setState({ accountId: acct, hidden: uniq(r.hiddenColumns) }); // canonical server result wins
    } catch (e) {
      if (!isCurrent()) return;                                   // obsolete failure -> zero state change
      setState(prev);                                             // ROLLBACK the optimistic change
      if (typeof onWriteError === "function") onWriteError(String(e && e.message ? e.message : e) || "Could not save column layout.");
    } finally {
      // Release the busy lock when the LATEST save settles -- regardless of account switch / token refresh (which
      // supersede isCurrent). This can never strand busy=true (the old `if (isCurrent())` guard could, deadlocking
      // the chooser); an older overlapping same-account save does NOT clear it early (its mySeq is stale).
      if (saveSeq.current === mySeq) setBusy(false);
    }
  }, [accountId, state, apiFetch, onWriteError]);

  const toggle = useCallback((id) => {
    const next = new Set(state && state.accountId === accountId ? state.hidden : DEFAULT_HIDDEN());
    if (next.has(id)) next.delete(id); else next.add(id);
    return save(next);
  }, [state, accountId, save]);
  const selectAll = useCallback(() => save([]), [save]);
  const reset = useCallback(() => save(DEFAULT_HIDDEN()), [save]);

  return { hiddenCols, ready, busy, save, toggle, selectAll, reset, reload };
}
