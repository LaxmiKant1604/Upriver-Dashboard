// Publication recovery WP4 -- the RUNTIME ZERO-EXPORT GUARD (a NODE_OPTIONS `--import` preload for every recovery child,
// and self-installed by scripts/release/publication-route-reconcile.mjs). It sits ON TOP of the static import-closure
// proof (scripts/route-cli-closure.test.js): even if some code path the static proof missed tried to reach DataDoe, the
// request is refused IN-PROCESS, BEFORE any request byte is written.
//
// RULE: every request to a DataDoe host (datadoe.com or any *.datadoe.com, case-insensitive, trailing dot ignored) is
// BLOCKED unless it is EXACTLY a GET of the pinned accounts-list endpoint path(s) the shared DataDoe helpers'
// fetchAccounts / fetchAccountsDetailed use (ENDPOINTS.sellers -- pinned equal by
// scripts/zero-export-guard.test.js), with no query string, issued through the guarded fetch or the guarded
// node:http(s) request / get. That one read is the publisher's GATE-3 discovery (zero tokens). Everything else -- POST
// /exports (a create), GET /exports/sources, GET /exports/{id}, /raw downloads, any other path or method -- increments
// the blocked counter, writes `ZEROEXPORT {"blocked":n,...}` to stderr, and is refused with a typed ZERO_EXPORT_BLOCKED
// error before the request is issued. LAYERS (each refusal counts once, at the layer that refused it):
//   1. ENTRY WRAPPERS: globalThis.fetch and node:http / node:https request + get (classified by the REAL method --
//      http(s).get honours options.method). The ADMITTED accounts GET runs inside a ONE-SHOT ADMISSION (an
//      AsyncLocalStorage token bound to the admitted host:port) with ONE request slot and ONE connect slot:
//        - the fetch runs with redirect:'manual' and ANY redirect response is refused (undici would otherwise follow a
//          302 to /exports/{id}/raw INSIDE the admitted call, over the same pooled socket, with no new connect);
//        - the admission DIES when the fetch settles / when the http request gets its socket (or closes), and the
//          user's response callback runs OUTSIDE it -- so no continuation of the admitted request (its callbacks, its
//          socket's later events) can open a DataDoe connection or request on the strength of it.
//   2. REQUEST TRIPWIRE (node:diagnostics_channel, whatever the entry point -- `new http.ClientRequest`, a keep-alive
//      socket reuse, a redirect, a WebSocket / other undici user): 'http.client.request.created' (published inside the
//      ClientRequest constructor, BEFORE the request is attached to a socket -- a pooled socket attaches on the next
//      tick, so a destroy here writes nothing) destroys every DataDoe request that is not the admitted accounts GET of a
//      live admission (whose method / path / host are then pinned read-only); 'http.client.request.start' re-checks at
//      finish (a late mutation tripwire); 'undici:request:create' marks every non-admitted DataDoe undici request
//      errored, so undici aborts it in onConnect before writing its request line.
//   3. CONNECT GUARD below the HTTP layer: node:tls connect, node:http2 connect, node:net connect / createConnection
//      (the http Agent's createConnection and undici's plain-http connector go through them) and net.Socket#connect
//      (the one chokepoint every TCP / TLS client socket passes) REFUSE any connection naming a DataDoe host
//      (host / hostname / servername) unless it is opened inside a LIVE admission for exactly that host:port whose
//      connect slot is unused. The outer layers check; net.Socket#connect CONSUMES the slot -- one DataDoe connect per
//      admitted request, ever. A direct call is refused with a synchronous throw; inside the http Agent (which also
//      connects from its own event handlers, e.g. for a queued request) the refusal takes the agent's error path
//      instead (the request emits it), so a refusal never surfaces as an uncaught exception. Connections by raw IP
//      address with no DataDoe servername / Host cannot be attributed to a host and are out of this guard's reach
//      (the static import-closure proof is the defense there).
// Non-DataDoe hosts (Supabase REST/Storage, the pg pooler) pass through untouched. On process exit the guard prints its
// summary line (`ZEROEXPORT {"blocked":n,"allowedAccountsGets":m,"final":true}`) so the parent (the recovery worker's
// runner) can trip the route even when the child swallowed the thrown error. `blocked` counts REFUSALS: one refused
// attempt is normally one refusal; an undici request refused at creation that then also needs a fresh connection is
// refused (and counted) again at that connect -- over-counting is conservative, a block is never uncounted.
//
// Idempotent (one install per process, keyed by a global Symbol); the pure classifiers + wrappers are exported for tests.
// Imports ONLY node builtins. 7-bit ASCII, LF.

import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import http2 from "node:http2";
import diagnosticsChannel from "node:diagnostics_channel";
import { AsyncLocalStorage } from "node:async_hooks";
import { syncBuiltinESMExports } from "node:module";
import { writeSync } from "node:fs";

// The ONLY DataDoe request the guard admits: GET <DataDoe base>/util/sellers-and-vendors (the accounts directory).
export const DATADOE_ACCOUNTS_LIST_PATHS = Object.freeze(["/api/v1/util/sellers-and-vendors"]);
export const ZERO_EXPORT_LINE_PREFIX = "ZEROEXPORT ";
export const ZERO_EXPORT_BLOCKED_CODE = "ZERO_EXPORT_BLOCKED";
// The request-level tripwire channels (node:http client + undici, the engine of Node's fetch / WebSocket).
export const ZERO_EXPORT_DIAGNOSTIC_CHANNELS = Object.freeze(["http.client.request.created", "http.client.request.start", "undici:request:create"]);
const STATE_KEY = Symbol.for("publication-recovery.zero-export-guard");
// The ONE-SHOT admission of the one allowed DataDoe request (read by the request tripwire + the connect guard).
const ADMISSION = new AsyncLocalStorage();
const ADMISSION_BRAND = Symbol("zero-export-admission");

const S = (v) => (v == null ? "" : String(v));

/** True for datadoe.com and every *.datadoe.com host (case-insensitive; a trailing root dot is ignored). */
export function isDataDoeHost(hostname) {
  const h = S(hostname).trim().toLowerCase().replace(/\.+$/, "");
  return h === "datadoe.com" || h.endsWith(".datadoe.com");
}

const normHost = (h) => S(h).trim().toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.+$/, "");
const portOf = (v) => { if (v == null || v === "" || typeof v === "boolean") return null; const n = Number(v); return Number.isInteger(n) && n > 0 && n < 65536 ? n : null; };
const defaultPortFor = (protocol) => (S(protocol).toLowerCase() === "http:" ? 80 : 443);

// A fresh ONE-SHOT admission bound to host:port: one request slot, one connect slot; dead once burned.
function newAdmission(host, port) {
  return { [ADMISSION_BRAND]: true, host: normHost(host), port: portOf(port), requestUsed: false, connectUsed: false, dead: false };
}
function liveAdmission() {
  const a = ADMISSION.getStore();
  return a && typeof a === "object" && a[ADMISSION_BRAND] === true && a.dead !== true ? a : null;
}
const burn = (a) => { if (a) a.dead = true; };
// A USER callback runs OUTSIDE any admission (so do all continuations it schedules).
const outsideAdmission = (fn) => function zeroExportOutsideAdmission(...a) { return ADMISSION.run(undefined, () => fn.apply(this, a)); };

// Resolve (url, method) from a fetch(input, init) call: input may be a string, a URL, or a Request-like { url, method }.
function fetchTarget(input, init) {
  let raw = "";
  let method = "";
  if (typeof input === "string") raw = input;
  else if (input && typeof input === "object") {
    if (typeof input.href === "string") raw = input.href;          // URL
    else if (typeof input.url === "string") raw = input.url;       // Request
    if (typeof input.method === "string") method = input.method;
  }
  if (init && typeof init === "object" && typeof init.method === "string") method = init.method;
  let url = null;
  try { url = new URL(raw); } catch { url = null; }
  return { url, method: (method || "GET").toUpperCase() };
}

/**
 * Classify ONE outgoing request. -> { datadoe, allowed, method, path }
 * A URL that cannot be parsed is not a DataDoe request (fetch itself rejects it before any I/O).
 */
export function classifyRequest({ url, method }) {
  if (!url) return { datadoe: false, allowed: true, method, path: "" };
  if (!isDataDoeHost(url.hostname)) return { datadoe: false, allowed: true, method, path: url.pathname };
  const allowed = method === "GET" && url.search === "" && DATADOE_ACCOUNTS_LIST_PATHS.includes(url.pathname);
  return { datadoe: true, allowed, method, path: url.pathname };
}

export function classifyFetch(input, init) { return classifyRequest(fetchTarget(input, init)); }

function blockedError(c) {
  const e = new Error(`ZERO_EXPORT_BLOCKED: a DataDoe ${c.method} ${c.path || "/"} was refused by the publication-recovery zero-export guard (only GET ${DATADOE_ACCOUNTS_LIST_PATHS.join(" | ")} is allowed).`);
  e.code = ZERO_EXPORT_BLOCKED_CODE;
  return e;
}

// Count + report ONE refusal and return the typed error (the caller throws / destroys with it).
function refuse(counters, onBlock, c) {
  counters.blocked += 1;
  try { onBlock(c); } catch { /* reporting never masks the refusal */ }
  return blockedError(c);
}

// A fetch response that is a redirect (redirect:'manual' returns the 3xx itself; an opaque-redirect filtered response
// has no status). -> { path } of the Location, or null when it is not a redirect.
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
function redirectOf(res, baseHref) {
  if (!res || typeof res !== "object") return null;
  const opaque = res.type === "opaqueredirect";
  if (!opaque && !REDIRECT_STATUSES.has(Number(res.status))) return null;
  let loc = "";
  try { loc = S(res.headers && typeof res.headers.get === "function" ? res.headers.get("location") : ""); } catch { loc = ""; }
  if (!opaque && !loc) return null; // a 3xx without a Location is not a redirect (there is nothing to follow)
  let path = "/";
  try { path = loc ? new URL(loc, baseHref).pathname : "/"; } catch { path = "/"; }
  return { path };
}

/**
 * Wrap a fetch implementation with the rule above. `counters` { blocked, allowedAccountsGets } is mutated; `onBlock(c)`
 * is called (after the increment, before the throw) -- the installed guard writes the stderr line there. The admitted
 * accounts GET runs inside a ONE-SHOT admission bound to its host:port, with redirect:'manual'; a redirect response is
 * REFUSED (counted), never followed; the admission dies when the fetch settles.
 */
export function makeGuardedFetch(baseFetch, counters, { onBlock = () => {} } = {}) {
  if (typeof baseFetch !== "function") throw new Error("makeGuardedFetch requires a base fetch (fail closed).");
  const guarded = async function guardedFetch(input, init) {
    const c = classifyFetch(input, init);
    if (!c.datadoe) return baseFetch(input, init);
    if (!c.allowed) throw refuse(counters, onBlock, c);
    counters.allowedAccountsGets += 1;
    const { url } = fetchTarget(input, init);
    const admission = newAdmission(url.hostname, portOf(url.port) || defaultPortFor(url.protocol));
    const guardedInit = { ...(init && typeof init === "object" ? init : {}), redirect: "manual" };
    let res;
    try { res = await ADMISSION.run(admission, () => baseFetch(input, guardedInit)); }
    finally { burn(admission); }
    const redirect = redirectOf(res, url.href);
    if (redirect) {
      try { if (res.body && typeof res.body.cancel === "function") Promise.resolve(res.body.cancel()).catch(() => {}); } catch { /* ignore */ }
      throw refuse(counters, onBlock, { datadoe: true, allowed: false, method: "REDIRECT", path: redirect.path });
    }
    return res;
  };
  return guarded;
}

// node:http / node:https request(options|url[, options][, cb]) -> the target host/path/method + the port it connects to.
function httpTarget(args, defaultProtocol) {
  const [a, b] = args;
  let url = null; let opts = {};
  if (typeof a === "string") { try { url = new URL(a); } catch { url = null; } if (b && typeof b === "object" && typeof b !== "function") opts = b; }
  else if (a && typeof a === "object" && typeof a.href === "string") { url = a; if (b && typeof b === "object" && typeof b !== "function") opts = b; }
  else if (a && typeof a === "object") opts = a;
  const hostname = S(opts.hostname || opts.host || (url && url.hostname) || "").replace(/:\d+$/, "");
  const path = S(opts.path || (url ? url.pathname + url.search : "/"));
  let parsed = null;
  try { parsed = new URL((defaultProtocol || "https:") + "//" + (hostname || "invalid.invalid") + (path.startsWith("/") ? path : "/" + path)); } catch { parsed = null; }
  const protocol = S(opts.protocol || (url && url.protocol) || defaultProtocol || "https:");
  const port = portOf(opts.port) || portOf(url && url.port) || portOf(opts.defaultPort) || defaultPortFor(protocol);
  return { url: parsed, method: S(opts.method || "GET").toUpperCase() || "GET", port };
}

/**
 * Classify ONE node:http / node:https request(...) or get(...) call from its arguments. BOTH are classified by the
 * REAL method (options.method || 'GET'): node's get() only DEFAULTS the method to GET -- an explicit options.method
 * (e.g. POST) is what it sends, so forcing 'GET' here would admit a POST to the allowlisted path.
 */
export function classifyHttpArgs(args, protocol = "https:") {
  const t = httpTarget(Array.isArray(args) ? args : [], protocol);
  return classifyRequest({ url: t.url, method: t.method });
}

function guardHttpModule(mod, protocol, counters, onBlock) {
  for (const fnName of ["request", "get"]) {
    const orig = mod[fnName];
    if (typeof orig !== "function" || orig.__zeroExportGuarded) continue;
    const wrapped = function zeroExportGuardedRequest(...args) {
      const t = httpTarget(args, protocol);
      const c = classifyRequest({ url: t.url, method: t.method });
      if (!c.datadoe) return orig.apply(this, args);
      if (!c.allowed) throw refuse(counters, onBlock, c);
      counters.allowedAccountsGets += 1;
      // The admitted accounts GET: its ClientRequest + socket connect run inside a ONE-SHOT admission; the user's
      // response callback (the last function argument) runs OUTSIDE it.
      const admission = newAdmission(t.url.hostname, t.port);
      let cbAt = -1;
      for (let i = args.length - 1; i >= 0; i -= 1) if (typeof args[i] === "function") { cbAt = i; break; }
      const callArgs = cbAt < 0 ? args : args.map((v, i) => (i === cbAt ? outsideAdmission(v) : v));
      let req;
      try { req = ADMISSION.run(admission, () => orig.apply(this, callArgs)); }
      catch (e) { burn(admission); throw e; }
      // The admission dies once the request holds its socket (a fresh connect has consumed the slot; a pooled
      // keep-alive socket needed none) or closes -- nothing after that may connect / request on its strength.
      if (req && typeof req.once === "function") { const end = () => burn(admission); req.once("socket", end); req.once("close", end); }
      else burn(admission);
      return req;
    };
    wrapped.__zeroExportGuarded = true;
    mod[fnName] = wrapped;
  }
}

// ---- the request tripwire (diagnostics channels) ----------------------------------------------------------------------

// Classify an outgoing request from its host candidates + method + request-target (origin-form or absolute-form).
function classifyOutgoing(hostCandidates, method, rawPath) {
  let path = S(rawPath) || "/";
  const hosts = hostCandidates.map(S).filter((h) => h !== "");
  if (/^https?:\/\//i.test(path)) { try { const u = new URL(path); hosts.unshift(u.hostname); path = u.pathname + u.search; } catch { /* classified below */ } }
  const dd = hosts.map((h) => normHost(h.replace(/:\d+$/, ""))).filter(isDataDoeHost);
  const m = S(method || "GET").toUpperCase() || "GET";
  if (!dd.length) return { datadoe: false, allowed: true, method: m, path, host: "" };
  let url = null;
  try { url = new URL("https://" + dd[0] + (path.startsWith("/") ? path : "/" + path)); } catch { url = null; }
  const c = url ? classifyRequest({ url, method: m }) : { allowed: false, method: m, path };
  return { ...c, datadoe: true, host: dd[0] };
}

/** Classify a node:http ClientRequest (host, Host header, method, path -- incl. an absolute-form proxied path). */
export function classifyClientRequest(req) {
  if (!req || typeof req !== "object") return { datadoe: false, allowed: true, method: "", path: "", host: "" };
  let hostHeader = null;
  try { hostHeader = typeof req.getHeader === "function" ? req.getHeader("host") : null; } catch { hostHeader = null; }
  return classifyOutgoing([req.host, Array.isArray(hostHeader) ? hostHeader[0] : hostHeader], req.method, req.path);
}

/** Classify an undici core Request (origin, Host header, servername, method, path). */
export function classifyUndiciRequest(req) {
  if (!req || typeof req !== "object") return { datadoe: false, allowed: true, method: "", path: "", host: "" };
  let originHost = "";
  try { originHost = new URL(S(req.origin)).hostname; } catch { originHost = ""; }
  return classifyOutgoing([originHost, req.host, req.servername], req.method, req.path);
}

// The request slot of a LIVE admission: ONLY the allowed accounts GET, to the admission's host, once.
function admitRequest(c) {
  if (!c.datadoe) return true;
  if (!c.allowed) return false;
  const a = liveAdmission();
  if (!a || a.requestUsed || normHost(c.host) !== a.host) return false;
  a.requestUsed = true;
  return true;
}

// Pin an admitted ClientRequest's identity: a later method / path / host change can never turn it into another request.
function pinRequestIdentity(req) {
  for (const k of ["method", "path", "host"]) {
    try { Object.defineProperty(req, k, { value: req[k], writable: false, enumerable: true, configurable: false }); } catch { /* ignore */ }
  }
}

function onHttpClientRequest(state, phase) {
  return (message) => {
    const request = message && message.request;
    if (!request || typeof request !== "object" || state.refusedRequests.has(request)) return;
    const c = classifyClientRequest(request);
    if (!c.datadoe) return;
    if (phase === "created") {
      if (admitRequest(c)) { state.admittedRequests.add(request); pinRequestIdentity(request); return; }
    } else if (c.allowed && state.admittedRequests.has(request)) {
      return; // 'start': the admitted accounts GET, unchanged
    }
    const err = refuse(state.counters, state.onBlock, c);
    state.refusedRequests.set(request, err);
    try { request.destroy(err); } catch { /* ignore */ }
  };
}

// node:http Agent#createSocket (inherited by the https Agent): the agent also opens sockets from INSIDE its own event
// handlers (removeSocket makes a socket for a QUEUED request when another socket closes), where a thrown refusal would
// be an uncaught exception. So (a) a request the tripwire already refused (destroyed while queued) never gets a
// connection -- the agent is handed its refusal; (b) a connect the connect guard refuses (counted there) takes the
// agent's OWN error path -- the request emits the refusal (async), exactly like a failed connect. Either way: no
// socket, no request byte, one count.
function guardHttpAgent(state) {
  const proto = http.Agent && http.Agent.prototype;
  const orig = proto && proto.createSocket;
  if (typeof orig !== "function" || orig.__zeroExportGuarded) return;
  const wrapped = function zeroExportGuardedCreateSocket(req, options, cb) {
    if (req && typeof req === "object" && state.refusedRequests.has(req) && typeof cb === "function") { cb(state.refusedRequests.get(req)); return undefined; }
    try { return orig.call(this, req, options, cb); }
    catch (e) {
      if (!e || e.code !== ZERO_EXPORT_BLOCKED_CODE || typeof cb !== "function") throw e;
      if (req && typeof req === "object" && !state.refusedRequests.has(req)) state.refusedRequests.set(req, e);
      cb(e);
      return undefined;
    }
  };
  wrapped.__zeroExportGuarded = true;
  proto.createSocket = wrapped;
}

function onUndiciRequestCreate(state) {
  return (message) => {
    const request = message && message.request;
    if (!request || typeof request !== "object") return;
    const c = classifyUndiciRequest(request);
    if (admitRequest(c)) return;
    // undici's Request#onConnect aborts with `error` BEFORE the request line is written (pooled or fresh connection).
    const err = refuse(state.counters, state.onBlock, c);
    try { request.error = err; } catch { /* ignore */ }
  };
}

// ---- the connect guard --------------------------------------------------------------------------------------------

const CONNECT_METHOD = Object.freeze({ tls: "TLS-CONNECT", http2: "HTTP2-CONNECT", net: "NET-CONNECT", socket: "SOCKET-CONNECT" });

// The host names + port a connect call names: tls.connect / net.connect / net.createConnection (options | port[, host]
// [, options] | path) with options.host / hostname / servername, net.Socket#connect (the same shapes or node's
// pre-normalized [options, cb] array), and http2.connect(authority[, options]).
function connectTarget(kind, args) {
  const hosts = []; let port = null;
  const opt = (o) => {
    if (!o || typeof o !== "object" || Array.isArray(o)) return;
    for (const k of ["host", "hostname", "servername"]) if (o[k] != null) hosts.push(S(o[k]));
    if (port == null) port = portOf(o.port);
  };
  let [a, b, c] = args;
  if (kind === "socket" && Array.isArray(a)) [a, b, c] = a;
  if (kind === "http2") {
    let u = null;
    if (typeof a === "string") { try { u = new URL(a); } catch { hosts.push(a); } }
    else if (a && typeof a === "object") { if (typeof a.href === "string") { try { u = new URL(a.href); } catch { /* ignore */ } } else opt(a); }
    if (u) { hosts.push(u.hostname); port = portOf(u.port) || defaultPortFor(u.protocol); }
    opt(b);
    return { hosts, port };
  }
  if (a && typeof a === "object") opt(a);
  else if (portOf(a) != null) port = portOf(a);
  if (typeof b === "string") hosts.push(b);
  opt(b); opt(c);
  return { hosts, port };
}

// Check (and, for the consuming chokepoint, consume) the connect slot of a LIVE admission.
function admitConnect(kind, args, consume) {
  const t = connectTarget(kind, Array.isArray(args) ? args : []);
  const dd = t.hosts.filter(isDataDoeHost).map(normHost);
  const c = { datadoe: dd.length > 0, allowed: true, method: CONNECT_METHOD[kind] || "CONNECT", path: "/", host: dd[0] || "", port: t.port };
  if (!c.datadoe) return c;
  const a = liveAdmission();
  c.allowed = !!a && !a.connectUsed && a.port != null && a.port === t.port && dd.every((h) => h === a.host);
  if (c.allowed && consume) a.connectUsed = true;
  return c;
}

/**
 * Classify ONE tls / http2 / net connect (or net.Socket#connect) call -> { datadoe, allowed, method, path, host, port }.
 * A connect naming ANY DataDoe host is refused unless it is opened INSIDE a live admission for exactly that host:port
 * whose connect slot is still unused; every other host passes through untouched. (Pure check: consumes nothing.)
 */
export function classifyConnect(kind, args) { return admitConnect(kind, args, false); }

/**
 * Wrap a connect function (tls.connect / http2.connect / net.connect / net.Socket#connect) with the rule above
 * (refused BEFORE any socket / DNS lookup). `consume` marks the chokepoint that CONSUMES the admission's one connect slot
 * (net.Socket#connect); the outer layers only check it.
 */
export function makeGuardedConnect(orig, kind, counters, { onBlock = () => {}, consume = false } = {}) {
  if (typeof orig !== "function") throw new Error("makeGuardedConnect requires a base connect (fail closed).");
  const wrapped = function zeroExportGuardedConnect(...args) {
    const c = admitConnect(kind, args, consume);
    if (!c.allowed) throw refuse(counters, onBlock, c);
    return orig.apply(this, args);
  };
  wrapped.__zeroExportGuarded = true;
  return wrapped;
}

/**
 * Run fn inside a fresh ONE-SHOT admission bound to `target`'s host:port (a URL / URL string; exported ONLY for the
 * offline tests of the connect guard). Without a target the admission matches no host.
 */
export function withZeroExportAdmission(fn, target = null) {
  let host = ""; let port = null;
  if (target != null) {
    try { const u = new URL(typeof target === "object" && typeof target.href === "string" ? target.href : S(target)); host = u.hostname; port = portOf(u.port) || defaultPortFor(u.protocol); }
    catch { host = ""; port = null; }
  }
  return ADMISSION.run(newAdmission(host, port), fn);
}

function guardConnectModule(mod, kind, counters, onBlock) {
  const orig = mod && mod.connect;
  if (typeof orig !== "function" || orig.__zeroExportGuarded) return;
  mod.connect = makeGuardedConnect(orig, kind, counters, { onBlock });
}

// node:net connect + createConnection (the SAME function in node; the http Agent's createConnection and undici's
// plain-http connector call them through the module object) and the net.Socket#connect chokepoint (consuming).
function guardNet(counters, onBlock) {
  const origConnect = net.connect;
  const origCreate = net.createConnection;
  if (typeof origConnect === "function" && !origConnect.__zeroExportGuarded) {
    const w = makeGuardedConnect(origConnect, "net", counters, { onBlock });
    net.connect = w;
    if (origCreate === origConnect) net.createConnection = w;
  }
  if (typeof net.createConnection === "function" && !net.createConnection.__zeroExportGuarded) net.createConnection = makeGuardedConnect(net.createConnection, "net", counters, { onBlock });
  const proto = net.Socket && net.Socket.prototype;
  if (proto && typeof proto.connect === "function" && !proto.connect.__zeroExportGuarded) proto.connect = makeGuardedConnect(proto.connect, "socket", counters, { onBlock, consume: true });
}

/** The installed guard's live counters (null when not installed in this process). */
export function zeroExportGuardState() {
  const st = globalThis[STATE_KEY];
  return st ? { installed: true, blocked: st.counters.blocked, allowedAccountsGets: st.counters.allowedAccountsGets } : null;
}

/** The machine line for a counters snapshot. */
export function formatZeroExportLine(counters, extra = {}) {
  return ZERO_EXPORT_LINE_PREFIX + JSON.stringify({ blocked: Number(counters && counters.blocked) || 0, allowedAccountsGets: Number(counters && counters.allowedAccountsGets) || 0, ...extra });
}

/** Parse a ZEROEXPORT line back (consumer side). null when it is not one. */
export function parseZeroExportLine(line) {
  const s = S(line);
  if (!s.startsWith(ZERO_EXPORT_LINE_PREFIX)) return null;
  try { const o = JSON.parse(s.slice(ZERO_EXPORT_LINE_PREFIX.length)); return o && typeof o === "object" && Number.isFinite(Number(o.blocked)) ? o : null; } catch { return null; }
}

/**
 * Install the guard into this process ONCE (idempotent): wraps globalThis.fetch + node:http/https request/get +
 * node:tls / node:http2 / node:net connect + net.Socket#connect + the http Agent's createSocket, subscribes the request
 * tripwire channels, and registers the exit summary. Returns the live state. `write` defaults to a synchronous stderr write (safe in 'exit').
 */
export function installZeroExportGuard({ target = globalThis, write = (s) => { try { writeSync(2, s); } catch { /* ignore */ } }, onExit = true } = {}) {
  if (globalThis[STATE_KEY]) return globalThis[STATE_KEY];
  const counters = { blocked: 0, allowedAccountsGets: 0 };
  // Every ZEROEXPORT line is written as "\n" + line + "\n": a newline-less stderr write the child made just before it
  // can never glue itself in front of the machine prefix (the runner matches the prefix ONLY at a line start; an empty
  // line is ignored by every consumer). The parse rule is unchanged.
  const onBlock = () => write("\n" + formatZeroExportLine(counters) + "\n");
  const state = { counters, installed: true, onBlock, admittedRequests: new WeakSet(), refusedRequests: new WeakMap(), channels: [] };
  globalThis[STATE_KEY] = state;
  if (typeof target.fetch === "function") target.fetch = makeGuardedFetch(target.fetch, counters, { onBlock });
  guardHttpModule(http, "http:", counters, onBlock);
  guardHttpModule(https, "https:", counters, onBlock);
  guardConnectModule(tls, "tls", counters, onBlock);
  guardConnectModule(http2, "http2", counters, onBlock);
  guardNet(counters, onBlock);
  guardHttpAgent(state);
  const handlers = [onHttpClientRequest(state, "created"), onHttpClientRequest(state, "start"), onUndiciRequestCreate(state)];
  ZERO_EXPORT_DIAGNOSTIC_CHANNELS.forEach((name, i) => {
    // dc.subscribe keeps the channel alive; the channel objects are ALSO held here (strong refs, never collected).
    if (typeof diagnosticsChannel.subscribe === "function") diagnosticsChannel.subscribe(name, handlers[i]);
    else diagnosticsChannel.channel(name).subscribe(handlers[i]);
    state.channels.push(diagnosticsChannel.channel(name));
  });
  try { syncBuiltinESMExports(); } catch { /* the default-export objects are still guarded */ }
  if (onExit && typeof process !== "undefined" && typeof process.on === "function") {
    process.on("exit", () => write("\n" + formatZeroExportLine(counters, { final: true }) + "\n"));
  }
  return state;
}

// Installed on import (the --import preload contract): nothing to configure, nothing read from the environment.
installZeroExportGuard();
