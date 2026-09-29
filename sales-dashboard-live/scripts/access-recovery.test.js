// Cold access-load RECOVERY (production incident 2026-09-29: "Access unavailable / Authentication request failed").
// The first /api/access?action=me of a session failed transiently (500 while the database behind Supabase Auth was
// overloaded) and the error pinned "Access unavailable" for good: a later successful focus revalidation applied the
// access but never cleared the error. This suite drives the REAL loader App.jsx uses (src/lib/session-lifecycle.js
// createAccessLoader) with a fake clock + scripted responses, and pins the App.jsx wiring (static):
//   A. failure classification, bounded backoff, the authorized-body rule;
//   B. the loader: a transient first failure retries automatically (bounded) and a later success CLEARS the error
//      (the regression); a definitive 401 / 403 never auto-retries; Retry loads now; nothing signs out; a malformed body
//      is a failure; once access is applied no failure (background or late) sets the error; dispose cancels;
//   C. App.jsx wiring: authFetch carries error.status, the effect drives createAccessLoader, the error screen offers
//      Retry (not only Sign out), retryAccess is declared before every early return (#310).
// Offline, zero network. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { readFileSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  accessFailureKind, accessRetryDelayMs, shouldAutoRetryAccess, isAuthorizedAccessBody, createAccessLoader, ACCESS_AUTO_RETRY_LIMIT,
} from "../src/lib/session-lifecycle.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); };
const err = (status, message = "x") => Object.assign(new Error(message), status == null ? {} : { status });
const ACCESS = { userId: "u1", role: "member", accountGrants: { A1: { mode: "ALL_BRANDS", brandKeys: null } } };

/* ========================= A. classification + backoff ========================= */
ok("A1 a network failure (no status) and 5xx / 408 / 429 are TRANSIENT",
  ["transient"].every((k) => [err(null), new TypeError("Failed to fetch"), err(500), err(502), err(503), err(504), err(408), err(429)].every((e) => accessFailureKind(e) === k)));
ok("A2 401 is 'unauthenticated'; 403 / 400 / 404 are 'denied' (definitive, fail-closed)",
  accessFailureKind(err(401)) === "unauthenticated" && [403, 400, 404, 409].every((s) => accessFailureKind(err(s)) === "denied"));
ok("A3 the backoff is bounded: 2 s, 4 s, 8 s, 16 s, never over 30 s",
  [1, 2, 3, 4].map(accessRetryDelayMs).join(",") === "2000,4000,8000,16000" && accessRetryDelayMs(10) === 30000 && accessRetryDelayMs(0) === 2000);
ok("A4 only a transient failure auto-retries, and only while under the bound",
  shouldAutoRetryAccess(err(500), 0) && shouldAutoRetryAccess(err(null), ACCESS_AUTO_RETRY_LIMIT - 1) && !shouldAutoRetryAccess(err(500), ACCESS_AUTO_RETRY_LIMIT)
  && !shouldAutoRetryAccess(err(401), 0) && !shouldAutoRetryAccess(err(403), 0));
ok("A5 an access body is AUTHORIZED only with an access object carrying a userId and a role",
  isAuthorizedAccessBody({ access: ACCESS }) && !isAuthorizedAccessBody({}) && !isAuthorizedAccessBody(null) && !isAuthorizedAccessBody({ access: null })
  && !isAuthorizedAccessBody({ access: { role: "member" } }) && !isAuthorizedAccessBody({ access: { userId: "u1" } }) && !isAuthorizedAccessBody({ access: { userId: "", role: "admin" } })
  && !isAuthorizedAccessBody({ access: [] }) && !isAuthorizedAccessBody({ error: "Authentication request failed." }));

/* ========================= B. the loader ========================= */
// A harness with a fake clock: the scripted responses are consumed in order (a function is called; an Error rejects).
function rig(responses) {
  const q = [...responses];
  const state = { error: "", retry: null, applied: null, fetches: 0, timers: new Map(), nextId: 1, busy: [], externalApplied: true };
  const loader = createAccessLoader({
    fetchAccess: () => { state.fetches += 1; const r = q.length ? q.shift() : err(500); if (r instanceof Error) return Promise.reject(r); return Promise.resolve(typeof r === "function" ? r() : r); },
    applyAccess: (a) => { state.applied = a; },
    showError: (m) => { state.error = m; },
    showRetry: (r) => { state.retry = r; },
    showBusy: (b) => { state.busy.push(b); },
    hasAppliedAccess: () => state.externalApplied && state.applied !== null,
    setTimer: (fn, ms) => { const id = state.nextId++; state.timers.set(id, { fn, ms }); return id; },
    clearTimer: (id) => { state.timers.delete(id); },
  });
  const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };
  const fireTimer = async () => { const [id, t] = [...state.timers.entries()][0] || []; if (!id) return null; state.timers.delete(id); t.fn(); await flush(); return t.ms; };
  return { loader, state, flush, fireTimer };
}

{
  // B1 THE REGRESSION: a transient first failure, then a later success -> the error is CLEARED and access applied.
  const { loader, state, flush, fireTimer } = rig([err(500, "Authentication request failed."), { access: ACCESS }]);
  loader.load(); await flush();
  const afterFail = { error: state.error, retry: state.retry, timers: state.timers.size };
  const ms = await fireTimer();
  ok("B1 [regression] a transient first failure shows the error + schedules an automatic retry; the retry's SUCCESS clears the error and applies access",
    afterFail.error === "Authentication request failed." && afterFail.retry && afterFail.retry.attempt === 1 && afterFail.retry.of === ACCESS_AUTO_RETRY_LIMIT && afterFail.timers === 1 && ms === 2000
    && state.error === "" && state.retry === null && state.applied === ACCESS && state.timers.size === 0 && state.fetches === 2);
}
{
  // B2 a focus revalidation success (not a timer) also clears the error (the exact production path before the fix).
  const { loader, state, flush } = rig([err(503), { access: ACCESS }]);
  loader.load(); await flush();
  loader.load(); await flush(); // focus / visibility revalidation
  ok("B2 [regression] a later successful FOCUS revalidation clears the cold error and cancels the pending automatic retry",
    state.error === "" && state.applied === ACCESS && state.timers.size === 0 && state.retry === null);
}
{
  // B3 the automatic retries are BOUNDED: after ACCESS_AUTO_RETRY_LIMIT transient failures nothing more is scheduled.
  const { loader, state, flush, fireTimer } = rig(Array.from({ length: 10 }, () => err(504)));
  loader.load(); await flush();
  const delays = [];
  for (let i = 0; i < 10; i += 1) { const ms = await fireTimer(); if (ms == null) break; delays.push(ms); }
  ok("B3 the automatic retries are bounded (4: 2 s, 4 s, 8 s, 16 s), then stop with the error + Retry still shown; nothing signs out",
    delays.join(",") === "2000,4000,8000,16000" && state.fetches === 1 + ACCESS_AUTO_RETRY_LIMIT && state.timers.size === 0 && state.retry === null && state.error !== "" && state.applied === null);
}
{
  // B4 a network failure (no status) is transient too.
  const { loader, state, flush } = rig([new TypeError("Failed to fetch")]);
  loader.load(); await flush();
  ok("B4 a network failure (fetch rejected, no status) is retried automatically", state.timers.size === 1 && state.retry && state.retry.attempt === 1 && state.error === "Failed to fetch");
}
{
  // B5 definitive answers are NOT retried automatically (fail-closed), but Retry still works.
  const { loader, state, flush } = rig([err(401, "Please sign in to access the dashboard."), err(403, "no profile"), { access: ACCESS }]);
  loader.load(); await flush();
  const after401 = { timers: state.timers.size, retry: state.retry, error: state.error };
  await loader.retryNow(); await flush();
  const after403 = { timers: state.timers.size, error: state.error };
  await loader.retryNow(); await flush();
  ok("B5 a 401 / 403 is NOT auto-retried (fail-closed: error shown, no timer); the Retry button loads again and a success clears the error",
    after401.timers === 0 && after401.retry === null && after401.error === "Please sign in to access the dashboard."
    && after403.timers === 0 && after403.error === "no profile" && state.error === "" && state.applied === ACCESS && state.fetches === 3);
}
{
  // B6 Retry loads NOW (cancelling the scheduled retry) and restarts the bound.
  const { loader, state, flush, fireTimer } = rig([err(500), err(500), err(500), { access: ACCESS }]);
  loader.load(); await flush();              // fail 1 -> retry #1 scheduled
  await fireTimer();                           // fail 2 -> retry #2 scheduled
  const beforeManual = state.retry && state.retry.attempt;
  await loader.retryNow(); await flush();     // manual: cancels #2, loads now -> fail 3 -> retry #1 (bound restarted)
  const afterManual = state.retry && state.retry.attempt;
  await fireTimer();                           // success
  ok("B6 the Retry button cancels the pending retry, loads immediately and restarts the bounded retries; the next success clears the error",
    beforeManual === 2 && afterManual === 1 && state.error === "" && state.applied === ACCESS && state.fetches === 4);
}
{
  // B7 a malformed / unauthorized 200 body is a FAILURE, never an access (fail-closed account scoping).
  const { loader, state, flush } = rig([{ access: { role: "member" } }, {}, { access: ACCESS }]);
  loader.load(); await flush();
  const afterBad = { error: state.error, applied: state.applied, timers: state.timers.size };
  ok("B7 a 200 body without an authorized access object is a FAILURE: error shown, nothing applied, retried (never a dashboard on an empty access)",
    afterBad.error === "Dashboard access response was incomplete." && afterBad.applied === null && afterBad.timers === 1);
}
{
  // B8 once access is applied, NO failure sets the error: background revalidation failures (transient AND definitive)
  // never blank the working dashboard. (Requests never overlap -- B10 -- so a "late" earlier request cannot exist.)
  const { loader, state, flush } = rig([{ access: ACCESS }, err(500, "bg"), err(403, "revoked?"), new TypeError("offline")]);
  loader.load(); await flush();          // cold load succeeds -> access applied
  loader.load(); await flush();          // background 500
  loader.load(); await flush();          // background 403
  loader.load(); await flush();          // background network failure
  ok("B8 once authorized access is applied, background failures (500, 403, network) change nothing: no error, no retry timer, access kept",
    state.applied === ACCESS && state.error === "" && state.retry === null && state.timers.size === 0 && state.fetches === 4);
}
{
  // B9 dispose (identity change / unmount) while a request is IN FLIGHT: its late success never applies, its late
  // failure never shows; a pending automatic retry is cancelled.
  let releaseOk, releaseErr;
  const okP = new Promise((res) => { releaseOk = () => res({ access: ACCESS }); });
  const errP = new Promise((_, rej) => { releaseErr = () => rej(err(500, "late")); });
  const a = rig([() => okP]);
  a.loader.load(); await a.flush();                // success request IN FLIGHT
  a.loader.dispose(); releaseOk(); await a.flush();
  const b = rig([() => errP]);
  b.loader.load(); await b.flush();                // failing request IN FLIGHT
  b.loader.dispose(); releaseErr(); await b.flush();
  const c = rig([err(500)]);
  c.loader.load(); await c.flush();                // fail -> automatic retry scheduled
  const timersBefore = c.state.timers.size;
  c.loader.dispose();
  ok("B9 dispose() while a request is in flight: its late SUCCESS never applies and its late FAILURE never shows (no error, no retry); a scheduled retry is cancelled",
    a.state.applied === null && a.state.error === "" && a.state.fetches === 1
    && b.state.error === "" && b.state.timers.size === 0 && b.state.retry === null && b.state.fetches === 1
    && timersBefore === 1 && c.state.timers.size === 0);
}
{
  // B10 ONE request at a time: 10 Retry presses + a focus/visibility double-fire during a pending cold request share it;
  // the busy signal brackets the request (Retry disabled meanwhile).
  let release;
  const pend = new Promise((_, rej) => { release = () => rej(err(503, "down")); });
  const { loader, state, flush } = rig([() => pend, { access: ACCESS }]);
  loader.load(); await flush();
  for (let i = 0; i < 10; i += 1) loader.retryNow();
  loader.load(); loader.load();
  await flush();
  const fetchesWhilePending = state.fetches;
  const busyWhilePending = state.busy.slice();
  release(); await flush();
  ok("B10 ONE access request at a time: 10 Retry presses + a focus/visibility double-fire during a pending cold request start NO extra fetch; busy is raised once and cleared after; the failure schedules exactly one retry",
    fetchesWhilePending === 1 && JSON.stringify(busyWhilePending) === JSON.stringify([true]) && JSON.stringify(state.busy) === JSON.stringify([true, false]) && state.timers.size === 1 && state.error === "down");
}
{
  // B11 a background revalidation after access is applied is SILENT: no busy signal, no error, no retry.
  const { loader, state, flush } = rig([{ access: ACCESS }, err(500, "bg"), { access: ACCESS }]);
  loader.load(); await flush();
  const busyAfterCold = state.busy.length;
  loader.load(); await flush();
  loader.load(); await flush();
  ok("B11 a background revalidation after access is applied raises NO busy signal and shows nothing (silent); the cold load did bracket busy",
    busyAfterCold === 2 && state.busy.length === 2 && state.error === "" && state.timers.size === 0);
}
{
  // B12 the sign-out window: the caller's applied-state is reset BEFORE dispose(); a background failure landing then
  // must not raise a stale error (the loader remembers it already applied access).
  let release;
  const pend = new Promise((_, rej) => { release = () => rej(err(500, "stale")); });
  const { loader, state, flush } = rig([{ access: ACCESS }, () => pend]);
  loader.load(); await flush();
  loader.load(); await flush();          // background request in flight
  state.externalApplied = false;         // SIGNED_OUT handler reset the fingerprint; dispose() not yet run
  release(); await flush();
  ok("B12 [sign-out window] once THIS loader applied access, a failure landing after the caller's applied-state was reset (before dispose) shows no error and schedules no retry",
    state.error === "" && state.timers.size === 0 && state.retry === null);
}
{
  // B13 a failure while an automatic retry is ALREADY scheduled keeps exactly one timer.
  const { loader, state, flush } = rig([err(500), err(502)]);
  loader.load(); await flush();          // fail -> timer #1
  loader.load(); await flush();          // focus revalidation fails too (no request in flight)
  ok("B13 a second failure while an automatic retry is already scheduled keeps exactly ONE timer (no duplicate chain)",
    state.timers.size === 1 && state.fetches === 2 && state.retry && state.retry.attempt === 1);
}

/* ========================= C. App.jsx wiring (static) ========================= */
const app = readFileSync(path.join(root, "src/App.jsx"), "utf8");
ok("C1 authFetch attaches the HTTP status to the thrown error (transient vs definitive is decidable)",
  /if \(!response\.ok\) \{ const error = new Error\(body\.error \|\| `Request failed \(\$\{response\.status\}\)`\); error\.status = response\.status; throw error; \}/.test(app));
ok("C2 the access effect drives createAccessLoader (fetchAccess = /api/access?action=me, the fingerprint gate, the applied-access guard)",
  /import \{[\s\S]{0,300}createAccessLoader[\s\S]{0,40}\} from "\.\/lib\/session-lifecycle\.js";/.test(app)
  && /const loader = createAccessLoader\(\{[\s\S]{0,300}authFetch\("\/api\/access\?action=me"/.test(app)
  && /if \(accessScopeChanged\(accessFpRef\.current, fp\)\) \{ accessFpRef\.current = fp; setAccess\(nextAccess\); \}/.test(app)
  && /hasAppliedAccess: \(\) => accessFpRef\.current !== null/.test(app) && /loader\.dispose\(\);/.test(app));
ok("C3 the old error-pinning path is gone (no `if (active && initial) setAccessError` catch)", !/if \(active && initial\) setAccessError/.test(app));
const screen = (app.match(/if \(accessError\) return [^\n]*/) || [""])[0];
ok("C4 the 'Access unavailable' screen offers Retry (retryAccess) AND Sign out, plus the automatic-retry status",
  /onClick=\{retryAccess\} disabled=\{accessChecking\}>\{accessChecking \? "Checking access[^"]*" : "Retry"\}<\/button>/.test(screen) && /onClick=\{signOut\}>Sign out<\/button>/.test(screen) && /Retrying automatically/.test(screen));
const firstEarlyReturn = app.indexOf("if (!supabase) return <div");
const retryHook = app.indexOf("const retryAccess = useCallback(");
ok("C5 retryAccess is a hook declared BEFORE every early return of App (#310 hook order)", retryHook > 0 && firstEarlyReturn > 0 && retryHook < firstEarlyReturn);
ok("C6 nothing in the recovery path signs the user out automatically (signOut only on the button / auth events)",
  !/createAccessLoader\(\{[\s\S]{0,1500}signOut/.test(app.slice(app.indexOf("const loader = createAccessLoader"), app.indexOf("const loader = createAccessLoader") + 1600)));

ok("C7 App.jsx wires the loader to the real state: showError=setAccessError, showRetry=setAccessRetry, showBusy=setAccessChecking; focus + visibilitychange revalidate through loader.load(); retryAccess calls retryNow(); sign-out / no session clears the error",
  /showError: setAccessError,/.test(app) && /showRetry: setAccessRetry,/.test(app) && /showBusy: setAccessChecking,/.test(app)
  && /const revalidate = \(\) => \{[^\n]*loader\.load\(\); \};/.test(app) && /window\.addEventListener\("focus", revalidate\);/.test(app) && /document\.addEventListener\("visibilitychange", revalidate\);/.test(app)
  && /const retryAccess = useCallback\(\(\) => \{ if \(accessLoaderRef\.current\) accessLoaderRef\.current\.retryNow\(\); \}, \[\]\);/.test(app)
  && /if \(!session\?\.access_token\) \{ setAccess\(null\); setAccessError\(""\); setAccessRetry\(null\); setAccessChecking\(false\);/.test(app)
  && /if \(authEventClearsAccess\(event\)\) \{ setAccess\(null\); setAccessError\(""\);/.test(app));

writeSync(1, `\naccess-recovery: ${passed} assertions passed\n`);
