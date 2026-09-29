// Publication recovery WP11 -- the recovery WORKER's TRANSITIVE STATIC IMPORT CLOSURE (modelled on
// scripts/route-cli-closure.test.js). Entries: the production entrypoint scripts/worker/publication-recovery-worker.mjs
// (every static import, re-export, `export *` and literal dynamic `await import(...)` it and its modules make) PLUS every
// worker-side route module lib/server/recovery/routes/*.route.js (they are loaded through routes.js, and analysed as
// entries too so a route never reached by the registry is still proven). The route CLI's own closure (which MUST load
// the fenced publisher) is route-cli-closure.test.js; the WORKER needs none of it. This test proves, MODULE-LEVEL (the
// strongest form: the forbidden modules are never even evaluated in the worker process):
//   W1 the closure imports exactly ONE npm package (pg) -- the recovery VM installs only pg;
//   W2 NO DataDoe client / export code (lib/server/datadoe.js, the source-sync driver / worker / tranche / manual
//      continuation, ads-sync), NO publisher / CAS / lease-acquire code (report-publisher.js, publisher-composition.js,
//      runtime-composition.js, route-publication-release.js, the priority control package / pg store,
//      saved-data-reconciler.js) and NO report_snapshots / source writer module (report-store.js, supabase.js) is in
//      the closure; the runtime zero-export guard is NOT loaded into the worker itself (the runner only names its file
//      URL for the children's --import preload);
//   W3 no loaded module carries, in CODE, a DataDoe host literal, a control-plane lease / CAS / publish RPC name, a
//      report_snapshots / sync-table write, a network client import (node:http / https / net / tls / http2 / dgram) or a
//      global fetch call -- the ONLY I/O primitives are pg (store-pg.js, verified TLS) and child_process (runner.js);
//   W4 the analysis is SOUND: every import in the closure is a literal specifier (a computed dynamic import / require
//      would be flagged), and canaries prove the same analysis FLAGS an injected report-store.js / supabase.js /
//      datadoe.js / publisher import and a computed dynamic import.
// Pure static text analysis: nothing is imported or executed. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = (f) => path.relative(ROOT, f).split(path.sep).join("/");
const abs = (p) => path.join(ROOT, ...p.split("/"));
let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; out("  ok  " + name); };
out("worker-closure");

// ---- a small JS stripper (route-cli-closure.test.js): comments removed, string contents KEPT only where asked -------
const KEYWORDS_BEFORE_REGEX = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await", "instanceof"]);
/** Blank comments (length-preserving); strings / templates / regex literals kept verbatim. */
function blankComments(src) {
  const a = src.split(""); const n = a.length; let i = 0; let lastSig = ""; let lastWord = "";
  const regexOk = () => lastSig === "" || "(,=:[!&|?{};+-*%<>~^".includes(lastSig) || KEYWORDS_BEFORE_REGEX.has(lastWord);
  const blank = (from, to) => { for (let k = from; k < to && k < n; k++) if (a[k] !== "\n") a[k] = " "; };
  while (i < n) {
    const c = a[i]; const d = a[i + 1];
    if (c === "/" && d === "/") { const s0 = i; while (i < n && a[i] !== "\n") i++; blank(s0, i); continue; }
    if (c === "/" && d === "*") { const s0 = i; i += 2; while (i < n && !(a[i] === "*" && a[i + 1] === "/")) i++; i += 2; blank(s0, i); continue; }
    if (c === "'" || c === '"' || c === "`") { const q = c; i++; while (i < n && a[i] !== q) { if (a[i] === "\\") i++; else if (q !== "`" && a[i] === "\n") break; i++; } i++; lastSig = q; lastWord = ""; continue; }
    if (c === "/" && regexOk()) { i++; let cls = false; while (i < n) { const ch = a[i]; if (ch === "\\") { i += 2; continue; } if (ch === "[") cls = true; else if (ch === "]") cls = false; else if (ch === "/" && !cls) break; else if (ch === "\n") break; i++; } i++; lastSig = "/"; lastWord = ""; continue; }
    if (/[A-Za-z0-9_$]/.test(c)) { let w = ""; while (i < n && /[A-Za-z0-9_$]/.test(a[i])) { w += a[i]; i++; } lastWord = w; lastSig = "a"; continue; }
    if (!/\s/.test(c)) { lastSig = c; lastWord = ""; }
    i++;
  }
  return a.join("");
}

// Every module specifier a (comment-blanked) module text names: static import / import "x" / export ... from / literal
// dynamic import. COMPUTED dynamic imports and require() are reported separately (they would make the proof unsound).
function specifiers(code) {
  const specs = [];
  for (const m of code.matchAll(/(?:^|[\n;{}])\s*import\s+(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"'\n]+)["']/g)) specs.push(m[1]);
  for (const m of code.matchAll(/(?:^|[\n;{}])\s*export\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s+["']([^"'\n]+)["']/g)) specs.push(m[1]);
  for (const m of code.matchAll(/\bimport\(\s*["']([^"'\n]+)["']\s*\)/g)) specs.push(m[1]);
  const computed = [...code.matchAll(/\bimport\(\s*(?!["'][^"'\n]+["']\s*\))/g)].length + [...code.matchAll(/\brequire\s*\(|\bcreateRequire\b/g)].length;
  return { specs, computed };
}

function closure(entries, { overrides = new Map() } = {}) {
  const seen = new Set(); const bare = new Set(); const builtins = new Set(); const computed = []; const unresolved = []; const edges = new Map();
  const queue = entries.map((e) => (path.isAbsolute(e) ? e : abs(e)));
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    if (!overrides.has(f) && !existsSync(f)) { unresolved.push(rel(f)); continue; }
    seen.add(f);
    const code = blankComments(overrides.has(f) ? overrides.get(f) : readFileSync(f, "utf8"));
    const { specs, computed: c } = specifiers(code);
    if (c) computed.push(rel(f));
    for (const s of specs) {
      if (s.startsWith("node:")) { builtins.add(s); continue; }
      if (!s.startsWith(".")) { bare.add(s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.split("/")[0]); continue; }
      let r = path.resolve(path.dirname(f), s);
      if (!existsSync(r) && existsSync(r + ".js")) r += ".js";
      if (!edges.has(rel(r))) edges.set(rel(r), rel(f));
      queue.push(r);
    }
  }
  const files = [...seen].map(rel).sort();
  return { files, bare: [...bare].sort(), builtins: [...builtins].sort(), computed, unresolved, edges, codeOf: (p) => blankComments(overrides.has(abs(p)) ? overrides.get(abs(p)) : readFileSync(abs(p), "utf8")) };
}
const chain = (res, file) => { const c = [file]; let x = file; while (res.edges.has(x) && c.length < 30) { x = res.edges.get(x); c.push(x); } return c.reverse().join(" -> "); };

const ENTRY = "scripts/worker/publication-recovery-worker.mjs";
const ROUTE_MODULES = readdirSync(abs("lib/server/recovery/routes")).filter((f) => f.endsWith(".route.js")).map((f) => "lib/server/recovery/routes/" + f).sort();
const res = closure([ENTRY, ...ROUTE_MODULES]);

ok(`W0 the worker closure covers the entrypoint, the registry / classify / runner / config / store and ALL ${ROUTE_MODULES.length} worker route modules (10 routes incl. the 4 legacy wrappers)`,
  ROUTE_MODULES.length === 10 && ["lib/server/recovery/worker.js", "lib/server/recovery/registry.js", "lib/server/recovery/routes.js", "lib/server/recovery/classify.js", "lib/server/recovery/runner.js", "lib/server/recovery/config.js", "lib/server/recovery/store-pg.js", "lib/server/recovery/route-contract.js", ...ROUTE_MODULES].every((f) => res.files.includes(f)) && res.unresolved.length === 0);

// W1 -- one npm package.
ok(`W1 the worker closure (${res.files.length} modules) imports exactly ONE npm package: pg`, JSON.stringify(res.bare) === JSON.stringify(["pg"]));

// W2 -- forbidden modules are never loaded.
const FORBIDDEN_MODULES = [
  "lib/server/datadoe.js", "lib/server/supabase.js", "lib/server/report-store.js", "lib/server/ads-sync.js",
  "lib/server/sync/report-publisher.js", "lib/server/sync/publisher-composition.js", "lib/server/sync/runtime-composition.js",
  "lib/server/sync/route-publication-release.js", "lib/server/sync/saved-data-reconciler.js",
  "lib/server/sync/source-priority-control-package.js", "lib/server/sync/priority-control-pg-store.js",
  // (source-tranche.js -- a PURE, zero-I/O descriptor module the source registry's constants import -- may load; W3
  // proves no loaded module has an I/O / write surface.)
  "lib/server/sync/source-sync-driver.js", "lib/server/sync/source-worker.js", "lib/server/sync/source-bucket-sync.js",
  "lib/server/sync/sync-dispatch.js", "lib/server/sync/report-worker.js", "lib/server/manual-source-continuation.js", "lib/server/sync/account-onboarding.js",
  "lib/server/sync/fba-plan-operation.js", "lib/server/recovery/zero-export-guard.mjs",
];
const loadedForbidden = FORBIDDEN_MODULES.filter((f) => res.files.includes(f));
ok("W2 NO DataDoe client / export code, NO publisher / CAS / lease / control-package code and NO report_snapshots / source writer module (report-store.js, supabase.js) is in the worker closure; the zero-export guard itself is never loaded into the worker" + (loadedForbidden.length ? " -- LOADED: " + loadedForbidden.map((f) => chain(res, f)).join(" | ") : ""), loadedForbidden.length === 0);
ok("W2 no lib/server/sync/routes/*.release.js (the CLI side, which builds over the fenced publisher) is in the worker closure", !res.files.some((f) => /^lib\/server\/sync\/routes\//.test(f)));

// W3 -- no forbidden I/O / write surface in any loaded module's CODE (comments blanked).
const FORBIDDEN_CODE = [
  [/datadoe\.com/i, "datadoe-host-literal"],
  [/acquire_control_plane_lease|renew_control_plane_lease|release_control_plane_lease|cas_report_snapshot|publish_live_snapshot|publishLiveSnapshot|publishSchedulerV2Snapshot|saveReportSnapshot|saveShadowSnapshot|upsertSyncReportJob|finalize_sync_cycle|openSyncCycle/, "publish-cas-lease-name"],
  [/\b(insert\s+into|update|delete\s+from|truncate)\s+public\.(report_snapshots|sync_cycles|sync_report_jobs|source_[a-z_]+|control_plane_lease|report_publication_writer_fence)\b/i, "report-or-source-write"],
  [/["']node:(http|https|net|tls|http2|dgram)["']/, "network-client-import"],
  [/(?<![\w$.])fetch\s*\(/, "global-fetch-call"],
];
const hits = [];
for (const f of res.files) { const code = res.codeOf(f); for (const [re, name] of FORBIDDEN_CODE) if (re.test(code)) hits.push(f + ":" + name); }
ok("W3 no loaded module carries a DataDoe host literal, a publish / CAS / lease / cycle-write name, a report_snapshots / sync / source-table write, a network client import or a global fetch call in code" + (hits.length ? " -- HITS: " + hits.join(" ") : ""), hits.length === 0);
const childSites = res.files.filter((f) => /["']node:child_process["']/.test(res.codeOf(f)));
const pgSites = res.files.filter((f) => /from\s+["']pg["']/.test(res.codeOf(f)));
ok("W3 the ONLY I/O primitives: child_process in runner.js alone, pg in store-pg.js alone (built from verifiedPgConfig -- verified TLS)", JSON.stringify(childSites) === JSON.stringify(["lib/server/recovery/runner.js"]) && JSON.stringify(pgSites) === JSON.stringify(["lib/server/recovery/store-pg.js"]) && /verifiedPgConfig\(/.test(res.codeOf("lib/server/recovery/store-pg.js")) && res.files.includes("lib/server/pg-tls.js"));
ok("W3 the runner never imports the guard (installing it into the worker): it names the guard's FILE URL for the children's NODE_OPTIONS --import preload", !/import\s[^;]*zero-export-guard/.test(res.codeOf("lib/server/recovery/runner.js")) && /zero-export-guard\.mjs/.test(res.codeOf("lib/server/recovery/runner.js")) && /--import=/.test(res.codeOf("lib/server/recovery/runner.js")));

// W4 -- soundness.
ok("W4 every import in the closure is a LITERAL specifier (no computed dynamic import / require: the proof covers every loaded module)" + (res.computed.length ? " -- COMPUTED: " + res.computed.join(",") : ""), res.computed.length === 0);
const canaryFile = abs("scripts/worker/__closure_canary__.mjs");
const canary = (text) => closure([canaryFile], { overrides: new Map([[canaryFile, text]]) });
const c1 = canary('import { paramsHashFor } from "../../lib/server/report-store.js";\nexport const x = paramsHashFor;\n');
const c2 = canary('const { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } = await import("../../lib/server/sync/report-publisher.js");\nexport const y = SCHEDULER_LIVE_SNAPSHOT_CONTRACTS;\n');
const c3 = canary('import { returnsWindow } from "../../lib/server/sync/returns-source-refresh.js";\nexport * from "../../lib/server/recovery/routes/returns-v3.route.js";\n');
const c4 = canary('const m = "../../lib/server/" + "supabase.js";\nconst x = await import(m);\n');
const c5 = canary('// import { createExport } from "../../lib/server/datadoe.js";\n/* import "../../lib/server/supabase.js"; */\nexport const z = 1;\n');
ok("W4 canaries: a static report-store.js import, a literal dynamic report-publisher.js import (-> supabase.js), a computed dynamic import and a re-export chain are each FLAGGED; imports inside comments are not",
  c1.files.includes("lib/server/report-store.js") && c1.files.includes("lib/server/supabase.js")
  && c2.files.includes("lib/server/sync/report-publisher.js") && c2.files.includes("lib/server/supabase.js")
  && c3.files.includes("lib/server/recovery/routes/returns-v3.route.js") && c3.files.includes("lib/server/date-windows.js")
  && c4.computed.length === 1 && c5.files.length === 1);
const w3Canary = blankComments('// fetch("https://api.datadoe.com") in a comment is fine\nimport http from "node:https";\nexport const a = () => fetch("https://api.datadoe.com/api/v1/exports", { method: "POST" });\nexport const b = "select public.acquire_control_plane_lease($1)";\nexport const c = "update public.report_snapshots set payload = $1";\n');
const w3Hits = FORBIDDEN_CODE.filter(([re]) => re.test(w3Canary)).map(([, n]) => n);
ok("W4 canary: the W3 code checks FLAG a DataDoe literal, a network client import, a global fetch, a lease RPC and a report_snapshots write (comments ignored)", JSON.stringify(w3Hits) === JSON.stringify(FORBIDDEN_CODE.map(([, n]) => n)) && FORBIDDEN_CODE.every(([re]) => !re.test(blankComments('// fetch("https://api.datadoe.com") update public.report_snapshots\nexport const z = 1;\n'))));
ok("W4 the returns window helper no longer drags the DataDoe client into the worker (returns-source-refresh.js takes addDaysStr from the pure date-windows.js leaf, the SAME function datadoe.js re-exports)",
  !c3.files.includes("lib/server/datadoe.js") && /import \{ addDaysStr \} from "\.\.\/date-windows\.js";/.test(readFileSync(abs("lib/server/sync/returns-source-refresh.js"), "utf8")));

out(`worker-closure: ${passed} passed`);
