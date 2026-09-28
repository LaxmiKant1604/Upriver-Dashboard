// Publication recovery WP4 -- the RUNTIME ZERO-EXPORT GUARD (lib/server/recovery/zero-export-guard.mjs). Proves, fully
// offline (a recording fake base fetch stands in for the network; blocked requests are refused BEFORE they reach it):
//   G1 the allowlist is PINNED to the shared DataDoe helpers: exactly the accounts-list path of ENDPOINTS.sellers (the
//      GET fetchAccounts / fetchAccountsDetailed issue), on the DataDoe base host;
//   G2 the classifier: POST /exports (a create), GET /exports/sources, GET /exports/{id}, /exports/{id}/raw, a sellers GET
//      with a query, a non-GET sellers call and ANY other DataDoe path are BLOCKED; the plain accounts GET is allowed; the
//      Supabase REST / Storage hosts and look-alike non-DataDoe hosts pass through; host matching is case-insensitive
//      and ignores a trailing root dot; string / URL / Request-like inputs;
//   G3 the wrapper: a blocked call increments the counter, reports, and THROWS a typed ZERO_EXPORT_BLOCKED before the
//      base fetch is ever called; an allowed call reaches it (counted separately);
//   G4 END TO END through the REAL DataDoe helpers (lib/server/datadoe.js) with the guard installed in THIS process:
//      createExport / downloadExport / fetchCompatibleSourceNames are refused with ZERO base-fetch calls, while
//      fetchAccountsDetailed (the publisher's GATE-3 discovery) is allowed;
//   G5 a CHILD process with the guard as a --import preload (DNS stubbed: fully offline): fetch, node:https request
//      (default AND named ESM imports), node:http get, an https.get whose options.method is POST, raw tls.connect
//      (default + named import) and http2.connect to DataDoe are refused before any I/O, while the ADMITTED accounts GET
//      (real undici fetch + real https.get) passes the connect guard; a ZEROEXPORT line is written per block, and the
//      final summary line ({"blocked":n,...,"final":true}) is printed on exit even though the child swallowed the errors;
//   G7 (pure) http(s) request/get classified by the REAL method; the tls / http2 connect guard (DataDoe hosts refused
//      outside the admitted accounts-GET context, other hosts untouched, the admission flowing from the guarded fetch);
//   G8 (in-process, round-2 P3-1) the ONE-SHOT admission: bound to the admitted host:port, ONE connect slot (consumed by
//      the net.Socket#connect chokepoint; the outer layers respect it) and ONE request slot; the admitted fetch runs
//      with redirect:'manual' and a redirect response is REFUSED (counted), never followed; the admission DIES when the
//      fetch settles (a timer the base scheduled inside it cannot connect later); the diagnostics-channel request
//      tripwire (http.client.request.created / undici:request:create) refuses every non-admitted DataDoe request
//      whatever its entry point, admits the one allowed GET once per admission, and pins its identity;
//   G9 (child process, round-2 P3-1, a loopback server with DNS stubbed -- fully offline) the verifier's probes, each
//      refused with the server NEVER seeing the request: a 302 from the admitted accounts GET to /exports/{id}/raw; a
//      raw tls.connect / net.connect to the SAME DataDoe host:port inside the admitted https.get's response callback
//      and inside a 'response' listener; `new http.ClientRequest` POST /exports on a fresh agent (the agent's error
//      path, never an uncaught exception); keep-alive reuse after the admitted GET (the pooled-socket ClientRequest
//      POST, http.request POST and a non-admitted ClientRequest GET on that agent; fetch POST after a pooled fetch);
//      a WebSocket (undici outside the fetch wrapper); net.connect / net.createConnection / new net.Socket().connect;
//      a second connect inside one admission and a connect to another port; a Host header mutated to DataDoe after
//      construction (the request.start tripwire). The ZEROEXPORT lines count EVERY block (monotonic, final summary).
//   G10 (WP11 verifier F5) every ZEROEXPORT line is written with a LEADING newline: newline-less stderr writes right
//      before a block / exit never hide a guard line from the runner's line-prefix parse (real child bytes replayed
//      through runner.runRoute); plus the child helper's ONE retry of a child that could not be CREATED (W10: Windows
//      EPERM / EAGAIN process-creation contention) -- a child that ran and failed is never retried.
//   G6 the machine line round-trips; the install is idempotent; the route CLI imports the guard FIRST and fails closed
//      when it is absent. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import dc from "node:diagnostics_channel";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

process.env.SUPABASE_URL = "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = ["test", "svc", "role", "key"].join("-");

// The recording BASE fetch -- installed BEFORE the guard wraps globalThis.fetch (the preload order in production).
const base = { calls: [] };
const okJson = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body, clone() { return this; } });
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : (input && (input.href || input.url));
  base.calls.push(String((init && init.method) || (input && input.method) || "GET").toUpperCase() + " " + url);
  if (/sellers-and-vendors/.test(String(url))) return okJson({ data: [{ id: "IN1", name: "India One", marketplaceCountryCode: "IN", currency: "INR", sellerCentralConnection: { initialLoadComplete: true } }] });
  return okJson({});
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUARD_PATH = path.join(ROOT, "lib", "server", "recovery", "zero-export-guard.mjs");
const G = await import(pathToFileURL(GUARD_PATH).href); // installs the guard into THIS process (wrapping the fake base)
const DD = await import("../lib/server/datadoe.js");

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; out("  ok  " + name); };
// A child with the guard as its --import preload (G5 / G9 / G10). Windows process-creation contention can make spawnSync
// fail to CREATE the child at all (status null, no signal, error EPERM / EAGAIN, no output: nothing ran) -- that ONE case
// is retried once. A child that ran and failed (any exit status, a signal, a timeout, any output) is NEVER retried, so
// what G5 / G9 / G10 prove is unchanged.
const CHILD_NOT_CREATED_CODES = Object.freeze(["EPERM", "EAGAIN"]);
const childNotCreated = (c) => !!c && c.status === null && c.signal === null && !!c.error && CHILD_NOT_CREATED_CODES.includes(c.error.code) && !(c.stdout || "") && !(c.stderr || "");
function spawnGuardedChild(script, spawnImpl = spawnSync, note = out) {
  const run = () => spawnImpl(process.execPath, ["--import", pathToFileURL(GUARD_PATH).href, "--input-type=module", "-e", script], { encoding: "utf8", timeout: 60000, env: { PATH: process.env.PATH || "", SystemRoot: process.env.SystemRoot || "" } });
  const first = run();
  if (!childNotCreated(first)) return first;
  note("  (the child process could not be created: " + first.error.code + " -- retried once)");
  return run();
}
const blocked = (input, init) => { const c = G.classifyFetch(input, init); return c.datadoe === true && c.allowed === false; };
const allowed = (input, init) => { const c = G.classifyFetch(input, init); return c.allowed === true; };

// G1 -- the pinned allowlist.
{
  const sellers = new URL(DD.ENDPOINTS.sellers);
  ok("G1 the allowlist is EXACTLY the accounts-list path of ENDPOINTS.sellers (lib/server/datadoe.js), with no query", JSON.stringify(G.DATADOE_ACCOUNTS_LIST_PATHS) === JSON.stringify([sellers.pathname]) && sellers.search === "" && G.isDataDoeHost(sellers.hostname) && G.isDataDoeHost(new URL(DD.DATADOE_BASE).hostname));
  const src = readFileSync(path.join(ROOT, "lib", "server", "datadoe.js"), "utf8");
  const body = (name) => { const i = src.indexOf("export async function " + name + "("); const j = src.indexOf("\nexport ", i + 10); return i < 0 ? "" : src.slice(i, j < 0 ? undefined : j); };
  ok("G1 fetchAccountsDetailed issues ONLY the ENDPOINTS.sellers GET (no method / body), and fetchAccounts delegates to it", /ddFetch\(ENDPOINTS\.sellers, \{ headers: authHeaders\(apiKey\) \}\)/.test(body("fetchAccountsDetailed")) && !/method:/.test(body("fetchAccountsDetailed")) && /fetchAccountsDetailed\(apiKey, attempt\)/.test(body("fetchAccounts")) && !/ddFetch|fetch\(/.test(body("fetchAccounts")));
}

// G2 -- the classifier.
{
  const E = DD.ENDPOINTS;
  ok("G2 POST /exports (a create) is BLOCKED", blocked(E.exportsCreate, { method: "POST", body: "{}" }));
  ok("G2 GET /exports/sources is BLOCKED", blocked(E.exportsSources("S1")));
  ok("G2 GET /exports/{id} (poll) and /exports/{id}/raw (download) are BLOCKED", blocked(E.exportStatus("e-1")) && blocked(E.exportRaw("e-1")));
  ok("G2 the accounts-list GET is ALLOWED (string, URL object, Request-like, lowercase method)", allowed(E.sellers) && allowed(new URL(E.sellers)) && allowed({ url: E.sellers, method: "GET" }) && allowed(E.sellers, { method: "get" }));
  ok("G2 a sellers call with a QUERY, or with any non-GET method, is BLOCKED", blocked(E.sellers + "?page=2") && blocked(E.sellers, { method: "POST" }) && blocked(E.sellers, { method: "HEAD" }) && blocked({ url: E.sellers, method: "DELETE" }));
  ok("G2 any other DataDoe host/path is BLOCKED (case-insensitive host, trailing root dot, any subdomain)", blocked("https://API.DATADOE.COM/api/v1/exports") && blocked("https://api.datadoe.com./api/v1/exports") && blocked("https://datadoe.com/anything") && blocked("https://eu.api.datadoe.com/api/v1/util/sellers-and-vendors/x"));
  ok("G2 non-DataDoe hosts pass through (Supabase REST + Storage, look-alike hosts)", allowed("https://abc.supabase.co/rest/v1/report_snapshots?select=id") && allowed("https://abc.supabase.co/storage/v1/object/x", { method: "POST" }) && allowed("https://api.datadoe.com.evil.test/api/v1/exports", { method: "POST" }) && allowed("https://notdatadoe.com/x") && !G.classifyFetch("https://abc.supabase.co/rest/v1/x").datadoe);
}

// G3 -- the wrapper.
{
  const calls = []; const counters = { blocked: 0, allowedAccountsGets: 0 }; const reported = [];
  const f = G.makeGuardedFetch(async (u) => { calls.push(String(u)); return okJson({}); }, counters, { onBlock: (c) => reported.push(c.method + " " + c.path) });
  let err = null;
  try { await f(DD.ENDPOINTS.exportsCreate, { method: "POST" }); } catch (e) { err = e; }
  ok("G3 a blocked call THROWS a typed ZERO_EXPORT_BLOCKED, counts, reports -- and NEVER reaches the base fetch", !!err && err.code === G.ZERO_EXPORT_BLOCKED_CODE && counters.blocked === 1 && calls.length === 0 && JSON.stringify(reported) === JSON.stringify(["POST /api/v1/exports"]));
  await f(DD.ENDPOINTS.sellers);
  await f("https://abc.supabase.co/rest/v1/x");
  ok("G3 an allowed accounts GET and a Supabase call reach the base fetch (the accounts GET counted separately)", calls.length === 2 && counters.allowedAccountsGets === 1 && counters.blocked === 1);
  let noBase = null;
  try { G.makeGuardedFetch(null, counters); } catch (e) { noBase = e; }
  ok("G3 a guard without a base fetch is refused (fail closed)", !!noBase);
}

// G4 -- END TO END through the REAL DataDoe helpers in THIS process (the guard wraps the recording base).
{
  const st0 = G.zeroExportGuardState();
  ok("G4 the guard is INSTALLED in this process on import", !!st0 && st0.installed === true);
  const baseBefore = base.calls.length;
  const refused = [];
  for (const [name, fn] of [["createExport", () => DD.createExport("k", "src", ["a"], ["S1"], "2026-09-01", "2026-09-02", 100)], ["downloadExport", () => DD.downloadExport("k", "e-1")], ["fetchCompatibleSourceNames", () => DD.fetchCompatibleSourceNames("k", "S1")]]) {
    try { await fn(); refused.push(name + ":not-refused"); } catch (e) { refused.push(name + ":" + (e && e.code)); }
  }
  ok("G4 createExport / downloadExport / fetchCompatibleSourceNames are REFUSED by the installed guard with ZERO base-fetch calls", JSON.stringify(refused) === JSON.stringify(["createExport:ZERO_EXPORT_BLOCKED", "downloadExport:ZERO_EXPORT_BLOCKED", "fetchCompatibleSourceNames:ZERO_EXPORT_BLOCKED"]) && base.calls.length === baseBefore);
  const accounts = await DD.fetchAccountsDetailed("k");
  const st1 = G.zeroExportGuardState();
  ok("G4 fetchAccountsDetailed (the publisher's GATE-3 discovery) is ALLOWED: exactly ONE base GET of the sellers endpoint", accounts.length === 1 && accounts[0].id === "IN1" && base.calls.length === baseBefore + 1 && base.calls[baseBefore] === "GET " + DD.ENDPOINTS.sellers && st1.blocked === st0.blocked + 3 && st1.allowedAccountsGets === st0.allowedAccountsGets + 1);
  const again = G.installZeroExportGuard();
  const wrappedOnce = globalThis.fetch;
  G.installZeroExportGuard();
  ok("G4 the install is IDEMPOTENT (same state, fetch never double-wrapped)", again.counters.blocked === st1.blocked && globalThis.fetch === wrappedOnce);
}

// G5 -- a CHILD process with the guard as a --import preload (the recovery runner's NODE_OPTIONS contract).
{
  // OFFLINE: the child's DNS is stubbed to fail immediately, so even an ADMITTED request never leaves the process (it
  // proves the admitted accounts GET gets PAST the tls / http2 connect guard -- it reaches the DNS lookup -- while
  // every refused call throws before the lookup: the lookup log lists ONLY the two admitted requests).
  const script = [
    "import dns from 'node:dns';",
    "import https from 'node:https';",
    "import { request as namedRequest } from 'node:https';",
    "import http from 'node:http';",
    "import tls from 'node:tls';",
    "import { connect as namedTlsConnect } from 'node:tls';",
    "import http2 from 'node:http2';",
    "const lookups = [];",
    "dns.lookup = (host, opts, cb) => { if (typeof opts === 'function') cb = opts; lookups.push(String(host)); process.nextTick(() => cb(Object.assign(new Error('offline test: no DNS'), { code: 'ENOTFOUND' }))); };",
    "const results = [];",
    "try { await fetch('https://api.datadoe.com/api/v1/exports', { method: 'POST', body: '{}' }); results.push('fetch:not-refused'); } catch (e) { results.push('fetch:' + e.code); }",
    "try { https.request({ hostname: 'api.datadoe.com', path: '/api/v1/exports', method: 'POST' }); results.push('https:not-refused'); } catch (e) { results.push('https:' + e.code); }",
    "try { namedRequest('https://api.datadoe.com/api/v1/exports/e-1/raw'); results.push('named:not-refused'); } catch (e) { results.push('named:' + e.code); }",
    "try { http.get('http://api.datadoe.com:80/api/v1/exports/e-1'); results.push('http:not-refused'); } catch (e) { results.push('http:' + e.code); }",
    "try { https.get({ hostname: 'api.datadoe.com', path: '/api/v1/util/sellers-and-vendors', method: 'POST' }); results.push('get-post:not-refused'); } catch (e) { results.push('get-post:' + e.code); }",
    "try { tls.connect({ host: 'api.datadoe.com', port: 443 }); results.push('tls:not-refused'); } catch (e) { results.push('tls:' + e.code); }",
    "try { namedTlsConnect(443, 'api.datadoe.com'); results.push('named-tls:not-refused'); } catch (e) { results.push('named-tls:' + e.code); }",
    "try { http2.connect('https://api.datadoe.com'); results.push('http2:not-refused'); } catch (e) { results.push('http2:' + e.code); }",
    "try { await fetch('https://api.datadoe.com/api/v1/util/sellers-and-vendors'); results.push('allowed-fetch:resolved'); } catch (e) { results.push('allowed-fetch:' + ((e.cause && e.cause.code) || e.code)); }",
    "await new Promise((res) => { const r = https.get('https://api.datadoe.com/api/v1/util/sellers-and-vendors'); r.on('error', (e) => { results.push('allowed-https-get:' + e.code); res(); }); });",
    "console.log('RESULTS ' + JSON.stringify(results) + ' LOOKUPS ' + JSON.stringify(lookups));",
  ].join("\n");
  const child = spawnGuardedChild(script);
  const results = (String(child.stdout).match(/^RESULTS (.*) LOOKUPS /m) || [])[1];
  const lookups = (String(child.stdout).match(/ LOOKUPS (.*)$/m) || [])[1];
  ok("G5 a preloaded child: fetch, node:https (default + NAMED ESM import) and node:http to DataDoe are ALL refused before any I/O", child.status === 0 && !!results && JSON.parse(results).slice(0, 4).join(",") === ["fetch:ZERO_EXPORT_BLOCKED", "https:ZERO_EXPORT_BLOCKED", "named:ZERO_EXPORT_BLOCKED", "http:ZERO_EXPORT_BLOCKED"].join(","));
  ok("G5 P3-2: https.get classified by its REAL method (a POST to the allowlisted sellers path is refused); raw tls.connect (default + NAMED ESM import) and http2.connect to DataDoe are refused before any socket / DNS lookup", !!results && JSON.parse(results).slice(4, 8).join(",") === ["get-post:ZERO_EXPORT_BLOCKED", "tls:ZERO_EXPORT_BLOCKED", "named-tls:ZERO_EXPORT_BLOCKED", "http2:ZERO_EXPORT_BLOCKED"].join(","));
  ok("G5 ... while the ADMITTED accounts GET (real undici fetch AND real node:https.get) passes the connect guard -- it reaches the (stubbed, offline) DNS lookup -- and ONLY those two requests ever looked a host up", !!results && JSON.parse(results).slice(8).join(",") === "allowed-fetch:ENOTFOUND,allowed-https-get:ENOTFOUND" && lookups === JSON.stringify(["api.datadoe.com", "api.datadoe.com"]));
  const lines = String(child.stderr).split(/\r?\n/).filter((l) => l.startsWith(G.ZERO_EXPORT_LINE_PREFIX)).map(G.parseZeroExportLine);
  const final = lines.filter((l) => l && l.final === true);
  ok("G5 a ZEROEXPORT line is written per block and the FINAL summary is printed on exit (blocked:8, 2 admitted accounts GETs) even though the child swallowed every error", lines.length === 9 && final.length === 1 && final[0].blocked === 8 && final[0].allowedAccountsGets === 2 && lines.slice(0, 8).map((l) => l.blocked).join(",") === "1,2,3,4,5,6,7,8");
}

// G7 -- P3-2 (pure, in-process): http(s) request/get classified by the REAL method; the tls / http2 connect guard.
{
  const sellersPath = new URL(DD.ENDPOINTS.sellers).pathname;
  const C = (args) => G.classifyHttpArgs(args, "https:");
  ok("G7 classifyHttpArgs: options.method wins for request AND get (a POST to the allowlisted path is BLOCKED); no method -> GET (allowed only on the sellers path, no query)",
    C([{ hostname: "api.datadoe.com", path: sellersPath, method: "POST" }]).allowed === false && C([{ hostname: "api.datadoe.com", path: sellersPath, method: "post" }]).allowed === false
    && C([{ hostname: "api.datadoe.com", path: sellersPath }]).allowed === true && C([DD.ENDPOINTS.sellers]).allowed === true && C([DD.ENDPOINTS.sellers, { method: "DELETE" }]).allowed === false
    && C([{ hostname: "abc.supabase.co", path: "/rest/v1/x", method: "POST" }]).datadoe === false);
  const counters = { blocked: 0, allowedAccountsGets: 0 }; const opened = []; const reported = [];
  const tlsConnect = G.makeGuardedConnect((...a) => { opened.push(a); return "socket"; }, "tls", counters, { onBlock: (c) => reported.push(c.method) });
  const h2Connect = G.makeGuardedConnect((...a) => { opened.push(a); return "session"; }, "http2", counters, { onBlock: (c) => reported.push(c.method) });
  const refused = (fn) => { try { fn(); return false; } catch (e) { return e.code === G.ZERO_EXPORT_BLOCKED_CODE; } };
  ok("G7 tls.connect to a DataDoe host (options.host / servername with an IP host / positional host) and http2.connect to a DataDoe authority are REFUSED before the base connect runs",
    refused(() => tlsConnect({ host: "api.datadoe.com", port: 443 })) && refused(() => tlsConnect({ host: "203.0.113.7", servername: "API.DataDoe.com.", port: 443 })) && refused(() => tlsConnect(443, "eu.api.datadoe.com"))
    && refused(() => h2Connect("https://api.datadoe.com")) && refused(() => h2Connect(new URL("https://api.datadoe.com:443"))) && refused(() => h2Connect("https://proxy.test", { servername: "api.datadoe.com" }))
    && opened.length === 0 && counters.blocked === 6 && reported.join(",") === "TLS-CONNECT,TLS-CONNECT,TLS-CONNECT,HTTP2-CONNECT,HTTP2-CONNECT,HTTP2-CONNECT");
  ok("G7 non-DataDoe connects pass through untouched (the Supabase pooler / REST hosts, look-alike hosts)", tlsConnect({ host: "aws-0-ap-south-1.pooler.supabase.com", port: 6543 }) === "socket" && h2Connect("https://abc.supabase.co") === "session" && tlsConnect({ host: "api.datadoe.com.evil.test", port: 443 }) === "socket" && counters.blocked === 6);
  ok("G7 a DataDoe connect opened INSIDE the admitted accounts-GET context is allowed (the admission never leaks to the caller)", G.withZeroExportAdmission(() => tlsConnect({ host: "api.datadoe.com", port: 443 }), DD.ENDPOINTS.sellers) === "socket" && refused(() => tlsConnect({ host: "api.datadoe.com", port: 443 })));
  // The admission flows from the guarded fetch into the connect its base performs (undici's model), and ONLY for the
  // allowed request: a blocked request never reaches its base at all.
  const c2 = { blocked: 0, allowedAccountsGets: 0 };
  const connect2 = G.makeGuardedConnect(() => "socket", "tls", c2);
  const f = G.makeGuardedFetch(async (input) => { await Promise.resolve(); return connect2({ host: new URL(String(input)).hostname, port: 443 }); }, c2);
  const got = await f(DD.ENDPOINTS.sellers);
  let err = null; try { await f(DD.ENDPOINTS.exportsCreate, { method: "POST" }); } catch (e) { err = e; }
  ok("G7 the guarded fetch ADMITS the allowed accounts GET's own connect (across an await) and refuses a blocked request before its base/connect runs", got === "socket" && c2.allowedAccountsGets === 1 && !!err && err.code === G.ZERO_EXPORT_BLOCKED_CODE && c2.blocked === 1);
  let noBase = null; try { G.makeGuardedConnect(null, "tls", c2); } catch (e) { noBase = e; }
  ok("G7 a connect guard without a base connect is refused (fail closed)", !!noBase);
}

// G8 -- round-2 P3-1 (in-process): the ONE-SHOT admission, redirects, the admission dying on settle, the tripwire.
{
  const sellers = DD.ENDPOINTS.sellers;
  const sellersPath = new URL(sellers).pathname;
  const refused = (fn) => { try { fn(); return false; } catch (e) { return e.code === G.ZERO_EXPORT_BLOCKED_CODE; } };
  const c = { blocked: 0, allowedAccountsGets: 0 };
  const tlsConnect = G.makeGuardedConnect(() => "socket", "tls", c);
  const sockConnect = G.makeGuardedConnect(() => "socket", "socket", c, { consume: true });
  // (a) host:port binding + the ONE connect slot (consumed by the chokepoint; the outer layers respect it).
  const inOne = G.withZeroExportAdmission(() => [
    refused(() => tlsConnect({ host: "api.datadoe.com", port: 8443 })), refused(() => tlsConnect({ host: "eu.api.datadoe.com", port: 443 })),
    tlsConnect({ host: "api.datadoe.com", port: 443 }), sockConnect([{ host: "api.datadoe.com", port: 443, servername: "api.datadoe.com" }, null]),
    refused(() => sockConnect({ host: "api.datadoe.com", port: 443 })), refused(() => tlsConnect({ host: "api.datadoe.com", port: 443 })), refused(() => sockConnect(443, "api.datadoe.com")),
    sockConnect({ host: "aws-0-ap-south-1.pooler.supabase.com", port: 6543 }),
  ], sellers);
  ok("G8 the admission is BOUND to the admitted host:port (another port / another DataDoe host refused) and has ONE connect slot: the net.Socket#connect chokepoint consumes it (node's normalized [options, cb] form included); a second socket connect AND the outer tls check then refuse; non-DataDoe hosts untouched",
    JSON.stringify(inOne) === JSON.stringify([true, true, "socket", "socket", true, true, true, "socket"]) && c.blocked === 5);
  const fresh = G.withZeroExportAdmission(() => sockConnect({ host: "api.datadoe.com", port: 443 }), sellers);
  ok("G8 a fresh admission has its own slot; no admission (or an admission with no target) admits nothing", fresh === "socket" && refused(() => sockConnect({ host: "api.datadoe.com", port: 443 })) && G.withZeroExportAdmission(() => refused(() => sockConnect({ host: "api.datadoe.com", port: 443 }))));
  // (b) the admitted fetch: redirect:'manual', any redirect REFUSED (counted); the admission dies when it settles.
  const c2 = { blocked: 0, allowedAccountsGets: 0 };
  const inits = [];
  const res302 = { status: 302, type: "basic", headers: { get: (k) => (String(k).toLowerCase() === "location" ? "/api/v1/exports/123/raw" : null) }, body: { cancel: async () => { res302.cancelled = true; } } };
  const f302 = G.makeGuardedFetch(async (input, init) => { inits.push(init); return res302; }, c2);
  let e302 = null; try { await f302(sellers, { headers: { a: "1" } }); } catch (e) { e302 = e; }
  ok("G8 the admitted accounts GET runs with redirect:'manual' (caller init kept) and a 302 to /exports/{id}/raw is REFUSED + counted (never followed; its body cancelled)",
    !!e302 && e302.code === G.ZERO_EXPORT_BLOCKED_CODE && /REDIRECT \/api\/v1\/exports\/123\/raw/.test(e302.message) && inits.length === 1 && inits[0].redirect === "manual" && inits[0].headers.a === "1" && c2.blocked === 1 && c2.allowedAccountsGets === 1 && res302.cancelled === true);
  const opaque = G.makeGuardedFetch(async () => ({ status: 0, type: "opaqueredirect", headers: { get: () => null } }), c2);
  let eOp = null; try { await opaque(sellers); } catch (e) { eOp = e; }
  const not3xx = G.makeGuardedFetch(async () => ({ status: 304, headers: { get: () => null } }), c2);
  ok("G8 an opaque-redirect response is refused too; a 3xx with no Location (nothing to follow) is returned as-is", !!eOp && eOp.code === G.ZERO_EXPORT_BLOCKED_CODE && c2.blocked === 2 && (await not3xx(sellers)).status === 304);
  const c3 = { blocked: 0, allowedAccountsGets: 0 };
  const connect3 = G.makeGuardedConnect(() => "socket", "socket", c3, { consume: true });
  let later = null; let inside = null;
  const fDie = G.makeGuardedFetch(async () => {
    later = new Promise((res) => setTimeout(() => res(refused(() => connect3({ host: "api.datadoe.com", port: 443 }))), 5));
    return { status: 200, headers: { get: () => null } };
  }, c3);
  const fIn = G.makeGuardedFetch(async () => { await Promise.resolve(); inside = connect3({ host: "api.datadoe.com", port: 443 }); return { status: 200, headers: { get: () => null } }; }, c3);
  await fDie(sellers); const laterRefused = await later;
  await fIn(sellers);
  ok("G8 the admission DIES when the admitted fetch settles: a timer the base scheduled inside it cannot connect afterwards (refused, counted); inside the live admission the connect passes", laterRefused === true && inside === "socket" && c3.blocked === 1 && c3.allowedAccountsGets === 2);
  // (c) the diagnostics-channel request tripwire of the guard INSTALLED in this process.
  const pub = (name, request) => dc.channel(name).publish({ request });
  const st0 = G.zeroExportGuardState();
  const fakeUndici = (path, method = "GET", origin = "https://api.datadoe.com") => ({ origin, path, method, host: null, servername: null });
  const uPost = fakeUndici("/api/v1/exports", "POST"); const uRaw = fakeUndici("/api/v1/exports/e-1/raw"); const uLone = fakeUndici(sellersPath); const uSupa = fakeUndici("/rest/v1/x", "POST", "https://abc.supabase.co");
  for (const r of [uPost, uRaw, uLone, uSupa]) pub("undici:request:create", r);
  const uA = fakeUndici(sellersPath); const uB = fakeUndici(sellersPath);
  G.withZeroExportAdmission(() => { pub("undici:request:create", uA); pub("undici:request:create", uB); }, sellers);
  const isRefusal = (e) => !!e && e.code === G.ZERO_EXPORT_BLOCKED_CODE;
  const st1 = G.zeroExportGuardState();
  ok("G8 undici:request:create (any undici entry point): POST /exports, GET /exports/{id}/raw and even the sellers GET OUTSIDE an admission are marked errored (undici aborts them before the request line) and counted; the sellers GET inside an admission is admitted ONCE (a second request in the same admission -- e.g. a followed redirect -- is refused); non-DataDoe untouched",
    isRefusal(uPost.error) && isRefusal(uRaw.error) && isRefusal(uLone.error) && uSupa.error === undefined && uA.error === undefined && isRefusal(uB.error) && st1.blocked === st0.blocked + 4);
  const fakeReq = (props) => { const r = { destroyed: null, ...props, destroy(err) { this.destroyed = err; return this; } }; r.getHeader = (k) => (String(k).toLowerCase() === "host" ? r.hostHeader || null : null); return r; };
  const hPost = fakeReq({ host: "api.datadoe.com", method: "POST", path: "/api/v1/exports" });
  const hProxied = fakeReq({ host: "proxy.test", method: "GET", path: "https://api.datadoe.com/api/v1/exports/e-1" });
  const hHostHdr = fakeReq({ host: "203.0.113.7", method: "POST", path: "/api/v1/exports", hostHeader: "api.datadoe.com:443" });
  const hLone = fakeReq({ host: "api.datadoe.com", method: "GET", path: sellersPath });
  const hSupa = fakeReq({ host: "abc.supabase.co", method: "POST", path: "/rest/v1/x" });
  for (const r of [hPost, hProxied, hHostHdr, hLone, hSupa]) pub("http.client.request.created", r);
  const hA = fakeReq({ host: "api.datadoe.com", method: "GET", path: sellersPath });
  G.withZeroExportAdmission(() => pub("http.client.request.created", hA), sellers);
  let pinned = false; try { hA.method = "POST"; } catch (e) { pinned = e instanceof TypeError; }
  pub("http.client.request.start", hA);
  const hLate = fakeReq({ host: "10.0.0.9", method: "POST", path: "/api/v1/exports" });
  pub("http.client.request.created", hLate); hLate.hostHeader = "api.datadoe.com"; pub("http.client.request.start", hLate);
  const st2 = G.zeroExportGuardState();
  ok("G8 http.client.request.created (ANY ClientRequest -- new http.ClientRequest, pooled keep-alive reuse): a DataDoe POST, an absolute-form proxied /exports path, a DataDoe Host header on an IP host and an un-admitted sellers GET are DESTROYED with the typed refusal + counted; the admitted sellers GET passes with its method/path/host PINNED read-only (and passes request.start); a Host mutated to DataDoe after creation is refused at request.start",
    isRefusal(hPost.destroyed) && isRefusal(hProxied.destroyed) && isRefusal(hHostHdr.destroyed) && isRefusal(hLone.destroyed) && hSupa.destroyed === null && hA.destroyed === null && pinned && hA.method === "GET" && isRefusal(hLate.destroyed) && st2.blocked === st1.blocked + 5);
  ok("G8 the pure request classifiers: classifyClientRequest / classifyUndiciRequest (origin, Host header, servername, absolute-form path)",
    G.classifyClientRequest(fakeReq({ host: "api.datadoe.com", method: "GET", path: sellersPath })).allowed === true && G.classifyClientRequest(fakeReq({ host: "api.datadoe.com", method: "GET", path: sellersPath + "?p=2" })).allowed === false
    && G.classifyUndiciRequest(fakeUndici(sellersPath)).allowed === true && G.classifyUndiciRequest({ origin: "https://1.2.3.4", path: "/api/v1/exports", method: "POST", servername: "api.datadoe.com" }).datadoe === true
    && G.classifyUndiciRequest(fakeUndici("/x", "GET", "https://abc.supabase.co")).datadoe === false && JSON.stringify(G.ZERO_EXPORT_DIAGNOSTIC_CHANNELS) === JSON.stringify(["http.client.request.created", "http.client.request.start", "undici:request:create"]));
}

// G9 -- round-2 P3-1 (child process with the guard as the --import preload; loopback server + DNS stubbed: offline).
{
  const script = [
    "import dns from 'node:dns';",
    "import http from 'node:http';",
    "import net from 'node:net';",
    "import tls from 'node:tls';",
    "const G = await import(" + JSON.stringify(pathToFileURL(GUARD_PATH).href) + ");",
    "const seen = [];",
    "const server = http.createServer((req, res) => {",
    "  seen.push(req.method + ' ' + String(req.headers.host).split(':')[0].split('.')[0] + ' ' + req.url);",
    "  if (/^redir\\./.test(String(req.headers.host)) && req.url === '/api/v1/util/sellers-and-vendors') { res.writeHead(302, { Location: '/api/v1/exports/123/raw' }); return res.end(); }",
    "  res.writeHead(200, { 'content-type': 'application/json' }); res.end('{\"data\":[]}');",
    "});",
    "server.on('upgrade', (req, sock) => { seen.push('UPGRADE ' + req.url); sock.destroy(); });",
    "await new Promise((r) => server.listen(0, '127.0.0.1', r));",
    "const port = server.address().port;",
    "const lookup0 = dns.lookup;",
    "dns.lookup = (host, opts, cb) => { if (typeof opts === 'function') { cb = opts; opts = {}; } if (/datadoe\\.com$/i.test(host)) return process.nextTick(() => (opts && opts.all) ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)); return lookup0(host, opts, cb); };",
    "const H = 'api.datadoe.com';",
    "const SELLERS = '/api/v1/util/sellers-and-vendors';",
    "const R = {};",
    "const codeOf = (e) => (e && (e.code || (e.cause && e.cause.code))) || 'none';",
    "const tryc = (fn) => { try { const s = fn(); try { if (s && s.on) s.on('error', () => {}); if (s && s.destroy) s.destroy(); } catch {} return 'not-refused'; } catch (e) { return codeOf(e); } };",
    "const blockedNow = () => G.zeroExportGuardState().blocked;",
    "try { const r = await fetch('http://redir.' + H + ':' + port + SELLERS); R.redirect = 'not-refused:' + r.status; } catch (e) { R.redirect = codeOf(e); }",
    "R.cb = await new Promise((res) => {",
    "  const o = {};",
    "  const req = http.get('http://' + H + ':' + port + SELLERS, (resp) => { o.cbTls = tryc(() => tls.connect({ host: H, port })); o.cbNet = tryc(() => net.connect({ host: H, port })); resp.resume(); resp.on('end', () => res(o)); });",
    "  req.on('response', () => { o.listenerTls = tryc(() => tls.connect({ host: H, port })); });",
    "  req.on('error', (e) => res('err:' + codeOf(e)));",
    "});",
    "R.freshCR = await new Promise((res) => { try { const r = new http.ClientRequest({ hostname: H, port, path: '/api/v1/exports', method: 'POST', agent: new http.Agent() }, () => res('SENT')); r.on('error', (e) => res('err:' + codeOf(e))); r.end('{}'); } catch (e) { res('threw:' + codeOf(e)); } });",
    "const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });",
    "R.kaFirst = await new Promise((res) => { const r = http.get({ hostname: H, port, path: SELLERS, agent }, (resp) => { resp.resume(); resp.on('end', () => res('ok:' + resp.statusCode)); }); r.on('error', (e) => res('err:' + codeOf(e))); });",
    "await new Promise((r) => setImmediate(r));",
    "R.kaCR = await new Promise((res) => { try { const r = new http.ClientRequest({ hostname: H, port, path: '/api/v1/exports', method: 'POST', agent }, () => res('SENT')); r.on('error', (e) => res('err:' + codeOf(e) + ':reused=' + r.reusedSocket)); r.end('{}'); } catch (e) { res('threw:' + codeOf(e)); } });",
    "R.kaWrapped = tryc(() => http.request({ hostname: H, port, path: '/api/v1/exports', method: 'POST', agent }));",
    "R.kaAllowedCR = await new Promise((res) => { try { const r = new http.ClientRequest({ hostname: H, port, path: SELLERS, agent }, () => res('SENT')); r.on('error', (e) => res('err:' + codeOf(e))); r.end(); } catch (e) { res('threw:' + codeOf(e)); } });",
    "try { const r = await fetch('http://' + H + ':' + port + SELLERS); await r.text(); R.fetchOk = r.status; } catch (e) { R.fetchOk = codeOf(e); }",
    "try { await fetch('http://' + H + ':' + port + '/api/v1/exports', { method: 'POST', body: '{}' }); R.fetchPost = 'not-refused'; } catch (e) { R.fetchPost = codeOf(e); }",
    "const b0 = blockedNow();",
    "R.ws = await new Promise((res) => { try { const ws = new WebSocket('ws://' + H + ':' + port + '/api/v1/exports'); ws.onerror = () => res('error'); ws.onopen = () => res('OPEN'); } catch (e) { res('threw:' + codeOf(e)); } });",
    "R.wsDelta = blockedNow() - b0;",
    "R.net = tryc(() => net.connect({ host: H, port }));",
    "R.netCreate = tryc(() => net.createConnection(port, H));",
    "R.sock = tryc(() => new net.Socket().connect(port, H));",
    "R.oneShot = G.withZeroExportAdmission(() => [tryc(() => net.connect({ host: H, port })), tryc(() => net.connect({ host: H, port }))], 'http://' + H + ':' + port + '/');",
    "R.wrongPort = G.withZeroExportAdmission(() => tryc(() => net.connect({ host: H, port: port + 1 })), 'http://' + H + ':' + port + '/');",
    "R.lateHost = await new Promise((res) => { const r = http.request({ host: '127.0.0.1', port, path: '/api/v1/exports', method: 'POST', agent: new http.Agent() }, (resp) => { resp.resume(); res('SENT'); }); r.on('error', (e) => res('err:' + codeOf(e))); r.setHeader('host', H); r.end('{}'); });",
    "await new Promise((r) => setTimeout(r, 150));",
    "R.seen = seen;",
    "console.log('RESULTS ' + JSON.stringify(R));",
    "agent.destroy(); server.close(); if (server.closeAllConnections) server.closeAllConnections();",
    "setTimeout(() => process.exit(0), 20);",
  ].join("\n");
  const child = spawnGuardedChild(script);
  const m = String(child.stdout).match(/^RESULTS (.*)$/m);
  const R = m ? JSON.parse(m[1]) : null;
  const B = G.ZERO_EXPORT_BLOCKED_CODE;
  ok("G9 the child ran to completion (exit 0, no uncaught exception) with the guard preloaded", child.status === 0 && !!R && !/Uncaught|uncaughtException/.test(String(child.stderr)));
  ok("G9 (1) a 302 from the ADMITTED accounts GET to /api/v1/exports/123/raw is REFUSED: the server saw the sellers GET and never the /raw download (no redirect followed inside undici)", !!R && R.redirect === B && R.seen.includes("GET redir /api/v1/util/sellers-and-vendors") && !R.seen.some((s) => /\/raw|exports\/123/.test(s)));
  ok("G9 (2) inherited admission is gone: a raw tls.connect / net.connect to the SAME DataDoe host:port inside the admitted request's response callback AND inside a 'response' listener are refused", !!R && R.cb && R.cb.cbTls === B && R.cb.cbNet === B && R.cb.listenerTls === B);
  ok("G9 (3) `new http.ClientRequest` POST /api/v1/exports on a fresh agent is refused before any socket (the agent's error path: an 'error' event, never an uncaught exception)", !!R && R.freshCR === "err:" + B);
  ok("G9 (4) keep-alive reuse after the admitted GET: the ClientRequest POST on the POOLED socket is refused (reusedSocket=true, nothing written), as are http.request POST and an un-admitted ClientRequest GET on that agent; after a pooled admitted fetch, fetch POST /exports is refused",
    !!R && R.kaFirst === "ok:200" && R.kaCR === "err:" + B + ":reused=true" && R.kaWrapped === B && R.kaAllowedCR === "err:" + B && R.fetchOk === 200 && R.fetchPost === B);
  ok("G9 a WebSocket to a DataDoe /exports path (undici outside the fetch wrapper) is refused by the undici:request:create tripwire (the server never sees the upgrade)", !!R && R.ws === "error" && R.wsDelta >= 1 && !R.seen.some((s) => /UPGRADE/.test(s)));
  ok("G9 (5) net.connect / net.createConnection / new net.Socket().connect to the DataDoe host are refused; inside ONE admission exactly ONE connect passes (the second is refused) and a connect to another port is refused", !!R && R.net === B && R.netCreate === B && R.sock === B && JSON.stringify(R.oneShot) === JSON.stringify(["not-refused", B]) && R.wrongPort === B);
  ok("G9 a Host header mutated to DataDoe AFTER construction is refused at http.client.request.start (the server never sees the POST)", !!R && R.lateHost === "err:" + B);
  ok("G9 the server saw ONLY the four admitted accounts GETs (no POST, no /raw, no upgrade)", !!R && JSON.stringify(R.seen) === JSON.stringify(["GET redir /api/v1/util/sellers-and-vendors", "GET api /api/v1/util/sellers-and-vendors", "GET api /api/v1/util/sellers-and-vendors", "GET api /api/v1/util/sellers-and-vendors"]));
  const lines = String(child.stderr).split(/\r?\n/).filter((l) => l.startsWith(G.ZERO_EXPORT_LINE_PREFIX)).map(G.parseZeroExportLine);
  const final = lines.filter((l) => l && l.final === true);
  const perBlock = lines.filter((l) => l && l.final !== true);
  const expected = 15 + (R ? R.wsDelta : 0); // redirect 1 + callback 3 + fresh CR 1 + keep-alive 3 + fetch POST 1 + net 3 + one-shot 1 + wrong port 1 + late Host 1 (+ the WebSocket's refusals)
  ok("G9 the ZEROEXPORT lines count EVERY block: one line per refusal (monotonic 1..n) and the FINAL summary blocked === n with the four admitted accounts GETs",
    final.length === 1 && final[0].blocked === expected && final[0].allowedAccountsGets === 4 && perBlock.length === expected && perBlock.map((l) => l.blocked).join(",") === Array.from({ length: expected }, (_, i) => i + 1).join(","));
}

// G10 -- WP11 verifier F5: a newline-less stderr write the child makes right before a block (or before exit) can never
// hide a ZEROEXPORT line from the runner's line-PREFIX parse (the guard writes "\n" + line + "\n"; the rule is unchanged).
{
  const script = [
    "import { writeSync } from 'node:fs';",
    "writeSync(2, 'warn: a partial stderr write with no newline');",
    "try { await fetch('https://api.datadoe.com/api/v1/exports', { method: 'POST', body: '{}' }); } catch {}",
    "writeSync(2, 'another partial write');",
    "try { await fetch('https://api.datadoe.com/api/v1/exports/e-1/raw'); } catch {}",
    "writeSync(2, 'a tail right before exit, no newline');",
    "console.log('DONE');",
  ].join("\n");
  const child = spawnGuardedChild(script);
  const stderr = String(child.stderr || "");
  const lines = stderr.split(/\r?\n/).filter((l) => l.startsWith(G.ZERO_EXPORT_LINE_PREFIX)).map(G.parseZeroExportLine);
  ok("G10 (F5) the guard writes a LEADING newline before every ZEROEXPORT line (per block AND the final summary): after newline-less stderr writes, all 3 lines still start a line and parse (blocked 1, 2, final 2); the partial writes survive as their own lines",
    child.status === 0 && /^DONE/m.test(String(child.stdout)) && lines.length === 3 && lines.every(Boolean) && lines.map((l) => l.blocked).join(",") === "1,2,2" && lines[2].final === true
    && /(^|\n)warn: a partial stderr write with no newline\r?\n/.test(stderr) && /(^|\n)a tail right before exit, no newline\r?\n/.test(stderr) && !/partial stderr write with no newlineZEROEXPORT/.test(stderr));
  // The RUNNER's own parse (runRoute's line reader + parseZeroExportLine) over the child's REAL bytes, fed in awkward
  // chunks: the violation is counted and the run classifies ZERO_EXPORT_VIOLATION.
  const { runRoute } = await import("../lib/server/recovery/runner.js");
  const { classifyRun, CLASSES } = await import("../lib/server/recovery/classify.js");
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const replay = () => {
    const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.kill = () => {};
    setImmediate(() => {
      for (let i = 0; i < stderr.length; i += 7) c.stderr.write(stderr.slice(i, i + 7));
      c.stdout.write(String(child.stdout || "")); c.stdout.end(); c.stderr.end();
      setImmediate(() => c.emit("close", 0, null));
    });
    return c;
  };
  const r = await runRoute({ appRoot: ROOT, route: "returns-v3", region: "india", asOf: "2026-09-24", kind: "dry-run", spawnImpl: replay });
  // The PRE-FIX framing of the same writes (no leading newline) loses every guard line to the prefix rule.
  const oldFraming = stderr.replace(/\n(ZEROEXPORT )/g, "$1");
  const lostBefore = oldFraming.split(/\r?\n/).filter((l) => l.startsWith(G.ZERO_EXPORT_LINE_PREFIX)).length;
  ok("G10 (F5) ... and the runner's line reader + parseZeroExportLine count it from the real bytes (blocked 2, final, 3 lines) -> classifyRun ZERO_EXPORT_VIOLATION; with the pre-fix framing the same writes would have hidden every guard line",
    r.zeroExport.blocked === 2 && r.zeroExport.final === true && r.zeroExport.lines === 3 && classifyRun(r).cls === CLASSES.ZERO_EXPORT_VIOLATION && lostBefore === 0);
  // W10: the child-creation retry is exactly ONE retry of a child that never ran.
  const fakeSeq = (results) => { const calls = []; const impl = () => { calls.push(1); return results[Math.min(calls.length - 1, results.length - 1)]; }; impl.calls = calls; return impl; };
  const notCreated = { status: null, signal: null, error: Object.assign(new Error("spawn EPERM"), { code: "EPERM" }) };
  const good = { status: 0, signal: null, stdout: "RESULTS {}", stderr: "" };
  const s1 = fakeSeq([notCreated, good]); const r1 = spawnGuardedChild("x", s1, () => {});
  const s2 = fakeSeq([{ status: 1, signal: null, stdout: "", stderr: "boom" }, good]); const r2 = spawnGuardedChild("x", s2, () => {});
  const s3 = fakeSeq([{ status: null, signal: "SIGTERM", error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }) }, good]); const r3 = spawnGuardedChild("x", s3, () => {});
  const s4 = fakeSeq([{ ...notCreated, stderr: "partial" }, good]); const r4 = spawnGuardedChild("x", s4, () => {});
  const s5 = fakeSeq([notCreated, notCreated, good]); const r5 = spawnGuardedChild("x", s5, () => {});
  ok("G10 (W10) the G5 / G9 / G10 child helper retries ONCE only a child that was never CREATED (status null, no signal, EPERM / EAGAIN, no output); a child that ran and failed, a timeout, or an EPERM with output is returned as-is; a second creation failure is returned (never a loop)",
    s1.calls.length === 2 && r1 === good && s2.calls.length === 1 && r2.status === 1 && s3.calls.length === 1 && r3.signal === "SIGTERM" && s4.calls.length === 1 && s5.calls.length === 2 && r5 === notCreated);
}

// G6 -- the machine line + the route CLI wiring.
{
  const line = G.formatZeroExportLine({ blocked: 2, allowedAccountsGets: 1 }, { final: true });
  ok("G6 the ZEROEXPORT machine line round-trips; a non-line parses to null", line === 'ZEROEXPORT {"blocked":2,"allowedAccountsGets":1,"final":true}' && G.parseZeroExportLine(line).blocked === 2 && G.parseZeroExportLine("RESULT {}") === null && G.parseZeroExportLine("ZEROEXPORT {bad") === null);
  const cli = readFileSync(path.join(ROOT, "scripts", "release", "publication-route-reconcile.mjs"), "utf8");
  const firstImport = cli.split("\n").find((l) => /^import\s/.test(l)) || "";
  ok("G6 the route CLI imports the guard as its FIRST module and STOPs (zero work) when the guard is not installed", /from "\.\.\/\.\.\/lib\/server\/recovery\/zero-export-guard\.mjs"/.test(firstImport) && /if \(!zeroExportGuardState\(\)\) \{[^\n]*STOP ZERO_EXPORT_GUARD_MISSING[^\n]*process\.exit\(2\)/.test(cli) && cli.indexOf("ZERO_EXPORT_GUARD_MISSING") < cli.indexOf("loadReleaseEnv();"));
  const relSrc = readFileSync(path.join(ROOT, "lib", "server", "sync", "route-publication-release.js"), "utf8");
  ok("G6 the route CLI fails its RESULT on any block (ZERO_EXPORT_VIOLATION via the shared routeCliOutcome) and always reports dataDoeCreates/dataDoeTokens 0",
    /zeroExportViolation = Number\(guard\.blocked\) > 0/.test(cli) && /rel\.routeCliOutcome\(\{ routeResults, zeroExportViolation, anyControlUnresolved \}\)/.test(cli) && /process\.exit\(verdict\.exitCode\)/.test(cli)
    && /const resultCode = zeroExportViolation \? "ZERO_EXPORT_VIOLATION"/.test(relSrc) && /dataDoeCreates: 0, dataDoeTokens: 0, zeroExport:/.test(cli));
  const gsrc = readFileSync(GUARD_PATH, "utf8");
  const imports = [...gsrc.matchAll(/^import\s+[^\n]*from\s+"([^"]+)"/gm)].map((m) => m[1]);
  ok("G6 the guard imports ONLY node builtins (safe as a preload in every child) and is 7-bit ASCII", imports.length > 0 && imports.every((s) => s.startsWith("node:")) && /^[\x00-\x7f]*$/.test(gsrc));
}

out(`zero-export-guard: ${passed} passed`);
