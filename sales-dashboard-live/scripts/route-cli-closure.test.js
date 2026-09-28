// Publication recovery WP4 -- the route CLI's STATIC IMPORT CLOSURE (scripts/release/publication-route-reconcile.mjs).
//
// A module-level closure is not enough: the CLI must use the EXISTING four-gate publisher (publisher-composition.js),
// whose module imports the scheduler runtime composition -- so the sync runtime MODULES are evaluated even though none of
// their export code can run. This test therefore runs a CONSERVATIVE, BINDING-LEVEL static reachability analysis from the
// CLI entry (every top-level statement of the entry; then every module-level binding any reached code names, across
// static imports, re-exports, `export *`, namespace imports and literal dynamic imports; a namespace used as a whole
// value, or a literal dynamic import not bound by name, reaches EVERY export of its module; a module's top-level
// statements run when it is loaded) and proves:
//   C1 the module closure imports exactly ONE npm package (pg) -- the recovery VM installs only pg;
//   C2 NO DataDoe export / create / poll / download / source-listing function is reachable (createExport, pollExport,
//      downloadExport, fetchExportRows(Strict), fetchCompatibleSourceNames, fetchSourceChunk, runManualSourceAttempt,
//      makeDataDoeAdapter, the source worker), NO source-bucket-sync fetch and NO sync runtime (runSchedulerV2Shadow,
//      buildSchedulerV2Runtime, the dispatcher / report worker); the ONLY datadoe.js request helper reached (ddFetch) is
//      reached solely through fetchAccountsDetailed, and runtime-composition.js contributes ONLY the publisher's GATE-3
//      discovery (makeProductionDiscoverAccounts); AND the URL constants: every reached reference to datadoe.js ENDPOINTS
//      comes from fetchAccountsDetailed / fetchAccounts (DATADOE_BASE only from the ENDPOINTS table), and no loaded
//      module except datadoe.js carries a 'datadoe.com' literal in code (the runtime guard only inside isDataDoeHost) --
//      so a module fetching an ENDPOINTS / DATADOE_BASE / literal DataDoe URL directly can never hide from the proof;
//   C3 the DERIVE path (everything except the publisher composition itself) reaches NO DataDoe request function at all
//      -- the account directory is the DURABLE snapshot (getAccountDirectorySnapshotAccounts) + the local raw-seller map;
//   C4 Postgres is reached ONLY through lib/server/pg-tls.js verifiedPgConfig: every pg client construction in the loaded
//      closure is `new pg.Client(verifiedPgConfig(...))` (or the CLI's pgConfig() wrapper of it), and no loaded module
//      disables TLS verification (rejectUnauthorized:false, NODE_TLS_REJECT_UNAUTHORIZED, sslmode=no-verify);
//   C5 ANALYZER SOUNDNESS canaries: the same analysis DOES report createExport reachable from buildSchedulerV2Runtime and
//      from makeDataDoeAdapter (it sees the forbidden path when one exists), the URL-constant check FLAGS an injected
//      ENDPOINTS / DATADOE_BASE / literal DataDoe fetch (and a stray literal in the guard), and every loaded module parses into
//      balanced top-level chunks with every exported function/const/class registered.
// Route modules are loaded by the CLI through a computed (validated) path, so any lib/server/sync/routes/*.release.js and
// lib/server/recovery/routes/*.route.js present are analysed as ADDITIONAL entries. Pure static text analysis: nothing
// is imported or executed. 7-bit ASCII, LF.
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

// ---- a small JS stripper: comments removed, string contents emptied, template text emptied (its ${} code kept),
// regex literals replaced by /r/ -- newlines preserved so chunks keep their line structure -----------------------------
const KEYWORDS_BEFORE_REGEX = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await", "instanceof"]);
function stripJs(src) {
  let o = ""; let i = 0; const n = src.length;
  let lastSig = ""; let lastWord = "";
  const regexOk = () => lastSig === "" || "(,=:[!&|?{};+-*%<>~^".includes(lastSig) || KEYWORDS_BEFORE_REGEX.has(lastWord);
  function code(stopAtBrace) {
    let depth = 0;
    while (i < n) {
      const c = src[i]; const d = src[i + 1];
      if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") i++; continue; }
      if (c === "/" && d === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] === "\n") o += "\n"; i++; } i += 2; continue; }
      if (c === "'" || c === '"') { const q = c; i++; while (i < n && src[i] !== q) { if (src[i] === "\\") i++; else if (src[i] === "\n") break; i++; } i++; o += q + q; lastSig = q; lastWord = ""; continue; }
      if (c === "`") { i++; o += "`"; while (i < n && src[i] !== "`") { if (src[i] === "\\") { i += 2; continue; } if (src[i] === "$" && src[i + 1] === "{") { i += 2; o += "${"; code(true); o += "}"; continue; } if (src[i] === "\n") o += "\n"; i++; } i++; o += "`"; lastSig = "`"; lastWord = ""; continue; }
      if (c === "/" && regexOk()) { i++; let cls = false; while (i < n) { const ch = src[i]; if (ch === "\\") { i += 2; continue; } if (ch === "[") cls = true; else if (ch === "]") cls = false; else if (ch === "/" && !cls) break; else if (ch === "\n") break; i++; } i++; while (i < n && /[a-z]/.test(src[i])) i++; o += "/r/"; lastSig = "/"; lastWord = ""; continue; }
      if (stopAtBrace) { if (c === "{") depth++; else if (c === "}") { if (depth === 0) { i++; return; } depth--; } }
      o += c;
      if (/[A-Za-z0-9_$]/.test(c)) { let w = c; let j = i + 1; while (j < n && /[A-Za-z0-9_$]/.test(src[j])) { w += src[j]; o += src[j]; j++; } i = j; lastWord = w; lastSig = "a"; continue; }
      if (!/\s/.test(c)) { lastSig = c; lastWord = ""; }
      i++;
    }
  }
  code(false);
  return o;
}

// Split `text` at depth-0 occurrences of `sep` (a single char).
function splitTop(text, sep) {
  const parts = []; let d = 0; let cur = "";
  for (const ch of text) { if ("{[(".includes(ch)) d++; else if ("}])".includes(ch)) d--; if (ch === sep && d === 0) { parts.push(cur); cur = ""; } else cur += ch; }
  parts.push(cur);
  return parts;
}
// The binding NAMES a declarator pattern introduces (a plain id, or the value identifiers of a destructuring pattern).
function patternNames(pat) {
  const p = pat.trim();
  if (/^[A-Za-z_$][\w$]*$/.test(p)) return [p];
  const names = [];
  for (const m of p.matchAll(/([A-Za-z_$][\w$]*)\s*(:)?/g)) { if (!m[2]) names.push(m[1]); }
  return names.filter((x) => x !== "default");
}

function resolveSpec(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const p = path.resolve(path.dirname(fromFile), spec);
  if (existsSync(p) && !p.endsWith(path.sep)) return p;
  if (existsSync(p + ".js")) return p + ".js";
  return null;
}
const bareName = (spec) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);

function makeAnalyzer({ overrides = new Map() } = {}) {
  const modules = new Map();
  function parseModule(file) {
    if (modules.has(file)) return modules.get(file);
    const raw = overrides.has(file) ? overrides.get(file) : readFileSync(file, "utf8");
    const stripped = stripJs(raw);
    const sLines = stripped.split("\n"); const rLines = raw.split("\n");
    const spans = []; let depth = 0; let cur = null;
    for (let li = 0; li < sLines.length; li++) {
      const line = sLines[li];
      if (depth === 0 && /^[^\s})\].?:&|+\-*,]/.test(line)) { cur = { start: li, end: li }; spans.push(cur); } else if (cur) cur.end = li;
      for (const ch of line) { if (ch === "{" || ch === "(" || ch === "[") depth++; else if (ch === "}" || ch === ")" || ch === "]") depth--; }
    }
    const mod = { file, raw, finalDepth: depth, chunks: [], decl: new Map(), exportsLocal: new Map(), reexports: new Map(), star: [], imports: new Map(), ns: new Map(), staticDeps: new Set(), externals: new Set() };
    const addImport = (local, target, name) => mod.imports.set(local, { target, name });
    for (const sp of spans) {
      const s = sLines.slice(sp.start, sp.end + 1).join("\n");
      const r = rLines.slice(sp.start, sp.end + 1).join("\n");
      const ch = { s, r, names: [], kind: "stmt", eager: true, dyn: [], dynNsAll: [], dynTarget: null };
      mod.chunks.push(ch);
      let m;
      if (/^import\b/.test(s) && !/^import\s*\(/.test(s)) {
        ch.kind = "import"; ch.eager = false;
        const spec = (r.match(/from\s*["']([^"']+)["']/) || r.match(/^import\s*["']([^"']+)["']/) || [])[1] || null;
        const target = spec ? resolveSpec(file, spec) : null;
        const tgt = target || (spec && !spec.startsWith(".") ? "ext:" + spec : null);
        if (target) mod.staticDeps.add(target); else if (spec && !spec.startsWith(".") && !spec.startsWith("node:")) mod.externals.add(bareName(spec));
        const clause = (r.match(/^import\s+([\s\S]*?)\s+from\s/) || [])[1] || "";
        const nsM = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/); if (nsM) mod.ns.set(nsM[1], tgt);
        const defM = clause.match(/^([A-Za-z_$][\w$]*)\s*(,|$)/); if (defM) addImport(defM[1], tgt, "default");
        const namedM = clause.match(/\{([\s\S]*)\}/);
        if (namedM) for (const part of namedM[1].split(",").map((x) => x.trim()).filter(Boolean)) { const [a, b] = part.split(/\s+as\s+/); addImport((b || a).trim(), tgt, a.trim()); }
        continue;
      }
      if (/^export\s*\*/.test(s)) {
        ch.kind = "reexport"; ch.eager = false;
        const spec = (r.match(/from\s*["']([^"']+)["']/) || [])[1]; const t = spec && resolveSpec(file, spec);
        const asM = r.match(/^export\s*\*\s*as\s+([A-Za-z_$][\w$]*)/);
        if (t) { mod.staticDeps.add(t); if (asM) mod.reexports.set(asM[1], { target: t, name: "*" }); else mod.star.push(t); }
        continue;
      }
      if ((m = s.match(/^export\s*\{([\s\S]*?)\}\s*(from)?/))) {
        ch.kind = "reexport"; ch.eager = false;
        const specNames = (r.match(/^export\s*\{([\s\S]*?)\}/) || [])[1] || m[1];
        const spec = m[2] ? (r.match(/from\s*["']([^"']+)["']/) || [])[1] : null; const t = spec && resolveSpec(file, spec);
        if (t) mod.staticDeps.add(t);
        for (const part of specNames.split(",").map((x) => x.trim()).filter(Boolean)) { const [a, b] = part.split(/\s+as\s+/); const exp = (b || a).trim(); if (t) mod.reexports.set(exp, { target: t, name: a.trim() }); else mod.exportsLocal.set(exp, a.trim()); }
        continue;
      }
      const exported = /^export\s/.test(s);
      const body = s.replace(/^export\s+/, "");
      const rawBody = r.replace(/^export\s+/, "");
      if (/^default\b/.test(body)) { ch.kind = "default"; ch.names = ["default"]; mod.exportsLocal.set("default", "default"); }
      else if ((m = body.match(/^(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/))) { ch.kind = "function"; ch.names = [m[2]]; ch.eager = false; }
      else if ((m = body.match(/^class\s+([A-Za-z_$][\w$]*)/))) { ch.kind = "class"; ch.names = [m[1]]; ch.eager = false; }
      else if ((m = body.match(/^(const|let|var)\s+/))) {
        ch.kind = "var";
        const decls = splitTop(body.slice(m[0].length).replace(/;\s*$/, ""), ",");
        let allFn = true;
        for (const dcl of decls) {
          let d = 0, k = 0;
          for (; k < dcl.length; k++) { const q = dcl[k]; if ("{[(".includes(q)) d++; else if ("}])".includes(q)) d--; else if (q === "=" && d === 0 && dcl[k + 1] !== "=" && dcl[k + 1] !== ">" && dcl[k - 1] !== "=" && dcl[k - 1] !== "!" && dcl[k - 1] !== "<" && dcl[k - 1] !== ">") break; }
          const pat = dcl.slice(0, k).trim(); const init = dcl.slice(k + 1).trim();
          ch.names.push(...patternNames(pat));
          let isFn = /^(async\s+)?function\b/.test(init) || /^(async\s+)?[A-Za-z_$][\w$]*\s*=>/.test(init);
          if (!isFn && /^(async\s*)?\(/.test(init)) { const st = init.indexOf("("); let dd = 0, e = st; for (; e < init.length; e++) { if (init[e] === "(") dd++; else if (init[e] === ")") { dd--; if (dd === 0) break; } } if (/^\s*=>/.test(init.slice(e + 1))) isFn = true; }
          if (!isFn) allFn = false;
        }
        ch.eager = !allFn;
        // `const X = await import("spec")` / `const { a, b: c } = await import("spec")` -> a namespace / named bindings.
        const di = rawBody.slice(m[0].length).match(/^([\s\S]*?)=\s*await\s+import\(\s*["']([^"']+)["']\s*\)\s*;?\s*$/);
        if (di) {
          const t = resolveSpec(file, di[2]);
          const tgt = t || "ext:" + di[2];
          ch.kind = "dynimport"; ch.eager = true; ch.dynTarget = tgt;
          if (!t && !di[2].startsWith("node:")) mod.externals.add(bareName(di[2]));
          const pat = stripJs(di[1]).trim();
          if (/^[A-Za-z_$][\w$]*$/.test(pat)) mod.ns.set(pat, tgt);
          else for (const part of pat.replace(/^\{|\}$/g, "").split(",").map((x) => x.trim()).filter(Boolean)) { const [a, b] = part.split(":").map((x) => x.trim()); addImport(b || a, tgt, a); }
          continue;
        }
      } else { ch.kind = "stmt"; ch.eager = true; }
      for (const nm of ch.names) { mod.decl.set(nm, ch); if (exported) mod.exportsLocal.set(nm, nm); }
      // literal dynamic imports inside this chunk that are NOT bound by name reach EVERY export of their module.
      for (const dm of r.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
        const t = resolveSpec(file, dm[1]);
        if (t) { ch.dyn.push(t); ch.dynNsAll.push(t); } else if (!dm[1].startsWith("node:")) mod.externals.add(bareName(dm[1]));
      }
    }
    modules.set(file, mod);
    return mod;
  }

  const loaded = new Set(); const reached = new Set(); const refs = new Map(); const stopped = new Set(); const queue = [];
  let stops = new Set(); let entryOnly = false;
  const K = (file, name) => rel(file) + "#" + name;
  const edge = (to, from) => { if (!refs.has(to)) refs.set(to, new Set()); refs.get(to).add(from); };
  // Loading a module EVALUATES its top-level code (statements in full; a non-function declaration's executed calls).
  // entryOnly: follow ONLY the entry's call graph (module evaluation is not traversed) -- used to prove what the CLI's
  // own code can call, separately from what merely runs when a module is evaluated.
  function load(file) {
    if (!file || file.startsWith("ext:") || loaded.has(file) || !existsSync(file) && !overrides.has(file)) return;
    loaded.add(file);
    const mod = parseModule(file);
    for (const dep of mod.staticDeps) load(dep);
    if (!entryOnly) mod.chunks.forEach((ch, i) => { if (ch.eager) queue.push({ mod, ch, i, full: ch.kind === "stmt" || ch.kind === "default" || ch.kind === "dynimport", from: "<load:" + rel(file) + ">" }); });
  }
  // Resolve an exported name to its DEFINING declaration(s): [{ mod, ch, name }].
  function resolveExport(file, name, seen = new Set()) {
    const k = file + "#" + name; if (seen.has(k)) return []; seen.add(k);
    if (!file || file.startsWith("ext:")) return [];
    load(file);
    const mod = parseModule(file);
    const local = mod.exportsLocal.get(name);
    if (local != null) {
      if (mod.decl.has(local)) return [{ mod, ch: mod.decl.get(local), name: local }];
      if (mod.imports.has(local)) { const im = mod.imports.get(local); return resolveExport(im.target, im.name, seen); }
      if (mod.ns.has(local)) return allExports(mod.ns.get(local), seen);
    }
    if (mod.reexports.has(name)) { const re = mod.reexports.get(name); return re.name === "*" ? allExports(re.target, seen) : resolveExport(re.target, re.name, seen); }
    return mod.star.flatMap((t) => resolveExport(t, name, seen));
  }
  function exportNames(file) { const mod = parseModule(file); return [...mod.exportsLocal.keys(), ...mod.reexports.keys(), ...mod.star.flatMap((t) => exportNames(t))]; }
  function allExports(file, seen = new Set()) { if (!file || file.startsWith("ext:")) return []; load(file); return [...new Set(exportNames(file))].flatMap((n) => resolveExport(file, n, seen)); }
  function reachDecl(d, from) {
    const key = K(d.mod.file, d.ch.names[0] || d.name);
    edge(key, from);
    if (stops.has(key)) { stopped.add(key); return; }
    if (reached.has(key)) return;
    reached.add(key);
    queue.push({ mod: d.mod, ch: d.ch, full: true, from: key });
  }
  const IDENT_RE = /(?<![\w$.])([A-Za-z_$][\w$]*)(\s*\.\s*([A-Za-z_$][\w$]*))?/g;
  const CALL_RE = /(?<![\w$.])((?:[A-Za-z_$][\w$]*\s*\.\s*)*[A-Za-z_$][\w$]*)\s*\(/g;
  // Callees that never EXECUTE their arguments (they only store / inspect values). Calls NESTED in their arguments are
  // still found (and executed) on their own; only the bare identifiers they are handed are not "called" here.
  const INERT = new Set(["Object.freeze", "Object.keys", "Object.values", "Object.entries", "Object.fromEntries", "Object.assign", "Array.isArray", "JSON.stringify", "Symbol.for", "String", "Number", "Boolean", "Set", "Map", "WeakMap", "WeakSet", "RegExp"]);
  // Blank (length-preserving) every NESTED function body of a declaration's initializer: an arrow body ({...} or an
  // expression), and a `) {` body (function expressions + object-literal / class methods). Code in those bodies does not
  // run when the declaration is evaluated -- it becomes reachable only when the declared binding itself is referenced
  // (which then scans the WHOLE chunk).
  function maskFunctionBodies(s) {
    const a = s.split(""); const n = a.length;
    const blank = (from, to) => { for (let k = from; k < to && k < n; k++) if (a[k] !== "\n") a[k] = " "; };
    const closeOf = (i) => { let d = 0; for (let k = i; k < n; k++) { if ("{([".includes(a[k])) d++; else if ("})]".includes(a[k])) { d--; if (d === 0) return k; } } return n - 1; };
    for (let i = 0; i < n; i++) {
      if (a[i] === "=" && a[i + 1] === ">") {
        let j = i + 2; while (j < n && /\s/.test(a[j])) j++;
        if (a[j] === "{") { const e = closeOf(j); blank(j, e + 1); i = e; continue; }
        let d = 0, k = j;
        for (; k < n; k++) { const c = a[k]; if ("{([".includes(c)) d++; else if ("})]".includes(c)) { if (d === 0) break; d--; } else if ((c === "," || c === ";") && d === 0) break; }
        blank(j, k); i = k - 1; continue;
      }
      if (a[i] === ")") { let j = i + 1; while (j < n && /\s/.test(a[j])) j++; if (a[j] === "{") { const e = closeOf(j); blank(j, e + 1); i = e; } }
    }
    return a.join("");
  }
  // Identifiers EXECUTED when an eager (non-function) declaration is evaluated: every call NOT inside a nested function
  // body (its callee), plus -- CONSERVATIVELY -- every identifier handed to a non-INERT call (the callee may invoke it,
  // including callbacks whose bodies are therefore scanned unmasked).
  function evalRefs(s) {
    const masked = maskFunctionBodies(s);
    const o = [];
    for (const m of masked.matchAll(CALL_RE)) {
      const callee = m[1].replace(/\s+/g, "");
      const parts = callee.split(".");
      o.push([parts[0], parts[1] || null]);
      if (INERT.has(callee)) continue;
      const open = m.index + m[0].length - 1; let d = 0, e = open;
      for (; e < s.length; e++) { if (s[e] === "(") d++; else if (s[e] === ")") { d--; if (d === 0) break; } }
      for (const mm of s.slice(open + 1, e).matchAll(IDENT_RE)) o.push([mm[1], mm[3] || null]);
    }
    return o;
  }
  function drain() {
    while (queue.length) {
      const { mod, ch, full, from } = queue.shift();
      if (ch.dynTarget) load(ch.dynTarget);
      const pairs = full ? [...ch.s.matchAll(IDENT_RE)].map((mm) => [mm[1], mm[3] || null]) : evalRefs(ch.s);
      if (full) for (const t of ch.dynNsAll) for (const d of allExports(t)) reachDecl(d, from);
      for (const [base, member] of pairs) {
        if (ch.names.includes(base) && ch.kind !== "dynimport") continue;
        if (mod.ns.has(base)) {
          const t = mod.ns.get(base);
          if (member) { for (const d of resolveExport(t, member)) reachDecl(d, from); }
          else if (!(ch.kind === "dynimport" && ch.names.includes(base))) for (const d of allExports(t)) reachDecl(d, from);
          continue;
        }
        if (ch.names.includes(base)) continue;
        if (mod.decl.has(base)) { const dch = mod.decl.get(base); reachDecl({ mod, ch: dch, name: base }, from); continue; }
        if (mod.imports.has(base)) { const im = mod.imports.get(base); for (const d of resolveExport(im.target, im.name)) reachDecl(d, from); }
      }
    }
  }
  function run(entries, { stopKeys = [], entryOnly: onlyEntry = false } = {}) {
    stops = new Set(stopKeys);
    entryOnly = onlyEntry === true;
    for (const f of entries) {
      load(f);
      const mod = parseModule(f);
      mod.chunks.forEach((ch, i) => { if (ch.kind !== "import" && ch.kind !== "reexport") queue.push({ mod, ch, i, full: true, from: "<entry:" + rel(f) + ">" }); });
    }
    drain();
    const reachedBy = (file) => [...reached].filter((k) => k.startsWith(file + "#")).map((k) => k.slice(file.length + 1)).sort();
    const externals = new Set([...loaded].flatMap((f) => [...parseModule(f).externals]));
    return { loaded: [...loaded].map(rel).sort(), reached, refs, stopped, reachedBy, externals, modules };
  }
  return { run, parseModule };
}

// ---- the entries: the route CLI + any route module present ------------------------------------------------------------
const CLI = abs("scripts/release/publication-route-reconcile.mjs");
const routeModules = [["lib/server/sync/routes", ".release.js"], ["lib/server/recovery/routes", ".route.js"]].flatMap(([dir, ext]) => (existsSync(abs(dir)) ? readdirSync(abs(dir)).filter((f) => f.endsWith(ext)).map((f) => abs(dir + "/" + f)) : []));
const entries = [CLI, ...routeModules];

const full = makeAnalyzer().run(entries);
const DD = "lib/server/datadoe.js";

// C1 -- one npm package.
ok(`C1 the route CLI module closure (${full.loaded.length} modules${routeModules.length ? " incl. " + routeModules.length + " route module(s)" : ""}) imports exactly ONE npm package: pg`, JSON.stringify([...full.externals].sort()) === JSON.stringify(["pg"]));

// C2 -- no DataDoe export/create code, no source-bucket-sync fetch, no sync runtime.
const FORBIDDEN = [
  [DD, ["createExport", "pollExport", "downloadExport", "fetchExportRows", "fetchExportRowsStrict", "fetchCompatibleSourceNames", "fetchSourceChunk"]],
  ["lib/server/manual-source-continuation.js", ["runManualSourceAttempt"]],
  ["lib/server/sync/source-sync-driver.js", ["makeDataDoeAdapter"]],
  ["lib/server/sync/sync-dispatch.js", ["runSchedulerV2Shadow"]],
  ["lib/server/sync/runtime-composition.js", ["buildSchedulerV2Runtime", "buildSchedulerV2CanaryRuntime", "buildSchedulerV2SourceTrancheRuntime", "schedulerV2Preflight"]],
];
const forbiddenReached = FORBIDDEN.flatMap(([f, names]) => names.filter((nm) => full.reached.has(f + "#" + nm)).map((nm) => f + "#" + nm));
ok("C2 NO DataDoe export / create / poll / download / source-list function, manual-source continuation, DataDoe source adapter or scheduler runtime is reachable from the route CLI -- neither from its call graph NOR from any module's evaluation", forbiddenReached.length === 0);
const ddReached = full.reachedBy(DD);
const ddFns = ddReached.filter((nm) => /fetch|export|poll|download|create|dd[A-Z]|source/i.test(nm));
ok("C2 the ONLY DataDoe request functions reachable are the accounts-list GET (fetchAccounts / fetchAccountsDetailed) and its ddFetch transport", JSON.stringify(ddFns) === JSON.stringify(["ddFetch", "fetchAccounts", "fetchAccountsDetailed"]));
const ddFetchCallers = [...(full.refs.get(DD + "#ddFetch") || [])].filter((k) => k !== DD + "#ddFetch");
ok("C2 ddFetch is reached SOLELY through fetchAccountsDetailed (the publisher's GATE-3 accounts GET)", JSON.stringify(ddFetchCallers) === JSON.stringify([DD + "#fetchAccountsDetailed"]));
// The CLI's own CALL GRAPH (module evaluation not traversed): it never enters the sync runtime at all, and it enters
// runtime-composition / account-onboarding ONLY through the publisher's GATE-3 discovery.
const calls = makeAnalyzer().run(entries, { entryOnly: true });
const SYNC_RUNTIME_MODULES = ["lib/server/sync/source-bucket-sync.js", "lib/server/sync/source-sync-driver.js", "lib/server/sync/source-worker.js", "lib/server/sync/sync-dispatch.js", "lib/server/sync/report-worker.js", "lib/server/sync/source-tranche.js", "lib/server/manual-source-continuation.js"];
const runtimeCalled = SYNC_RUNTIME_MODULES.filter((f) => calls.reachedBy(f).length > 0).map((f) => f + ":" + calls.reachedBy(f).join(","));
ok("C2 the CLI's call graph reaches NO binding of source-bucket-sync / source-sync-driver / source-worker / sync-dispatch / report-worker / source-tranche / manual-source-continuation (they are only EVALUATED as modules)", runtimeCalled.length === 0);
const evalOnly = SYNC_RUNTIME_MODULES.flatMap((f) => full.reachedBy(f).map((nm) => f + "#" + nm));
ok("C2 ... and what their module EVALUATION runs is pure load-time code (never a fetch / export / job / cycle runner)", evalOnly.every((k) => !/fetch|export|download|poll|create|run[A-Z]|Job|Cycle|dispatch|Adapter|Store/i.test(k.split("#")[1])));
ok("C2 runtime-composition.js contributes ONLY the publisher's GATE-3 discovery (makeProductionDiscoverAccounts) to the call graph", JSON.stringify(calls.reachedBy("lib/server/sync/runtime-composition.js")) === JSON.stringify(["makeProductionDiscoverAccounts"]) && full.reachedBy("lib/server/sync/runtime-composition.js").filter((nm) => /^[a-z]/.test(nm)).every((nm) => nm === "makeProductionDiscoverAccounts"));
const onboardingReached = full.reachedBy("lib/server/sync/account-onboarding.js");
ok("C2 account-onboarding.js contributes ONLY the export-ELIGIBILITY directory read (fetchExportEligibleAccounts over the accounts GET + durable onboarding rows), never an export", onboardingReached.includes("fetchExportEligibleAccounts") && !onboardingReached.some((nm) => /create|reserve|dispatch|bootstrap|budget|spend|claim|record|upsert|lease/i.test(nm)));

// C2 (P3-1) -- the URL-CONSTANT blind spot: a module could build a DataDoe request from datadoe.js's ENDPOINTS /
// DATADOE_BASE (or its own 'datadoe.com' literal) and fetch it directly, never reaching a datadoe.js FUNCTION. So:
//   (a) every reached reference to ENDPOINTS must come from fetchAccountsDetailed / fetchAccounts (the accounts GET),
//       and every reference to DATADOE_BASE only from the ENDPOINTS declaration itself (datadoe.js composing its own
//       table -- which (a) already confines) -- anything else is forbidden;
//   (b) NO loaded module other than lib/server/datadoe.js may contain the literal 'datadoe.com' in CODE (comments are
//       ignored); the runtime zero-export guard is the one exception, and only inside its host predicate isDataDoeHost.
// Comments blanked (length-preserving), strings / templates / regex literals KEPT -- the literal check reads code text.
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
const GUARD = "lib/server/recovery/zero-export-guard.mjs";
function dataDoeUrlViolations(result) {
  const v = [];
  const allowedRefs = { [DD + "#ENDPOINTS"]: [DD + "#fetchAccountsDetailed", DD + "#fetchAccounts"], [DD + "#DATADOE_BASE"]: [DD + "#ENDPOINTS"] };
  for (const [k, okFrom] of Object.entries(allowedRefs)) for (const from of result.refs.get(k) || []) if (!okFrom.includes(from)) v.push("ref:" + k.split("#")[1] + "<-" + from);
  for (const f of result.loaded) {
    if (f === DD) continue;
    const mod = result.modules.get(abs(f));
    const code = blankComments(mod ? mod.raw : readFileSync(abs(f), "utf8"));
    const hits = [...code.matchAll(/datadoe\.com/gi)].map((m) => m.index);
    if (!hits.length) continue;
    if (f === GUARD) {
      // Only inside the isDataDoeHost declaration (the host predicate that REFUSES DataDoe).
      const start = code.indexOf("export function isDataDoeHost(");
      const end = start < 0 ? -1 : code.indexOf("\n}\n", start);
      if (start >= 0 && end > start && hits.every((h) => h > start && h < end)) continue;
    }
    v.push("literal:" + f + "@" + hits.length);
  }
  return v;
}
const urlViolations = dataDoeUrlViolations(full);
ok("C2 (P3-1) ENDPOINTS is referenced ONLY by fetchAccountsDetailed / fetchAccounts and DATADOE_BASE only by the ENDPOINTS table; NO loaded module but datadoe.js carries a 'datadoe.com' literal in code (the guard only in isDataDoeHost)" + (urlViolations.length ? " -- VIOLATIONS: " + urlViolations.join(" ") : ""), urlViolations.length === 0 && (full.refs.get(DD + "#ENDPOINTS") || new Set()).size > 0);

// C3 -- the DERIVE path (the publisher composition excluded) reaches NO DataDoe request function at all.
const derive = makeAnalyzer().run(entries, { stopKeys: ["lib/server/sync/publisher-composition.js#buildSchedulerV2Publisher"] });
ok("C3 the publisher composition is the ONLY way into DataDoe discovery: with it cut, the route CLI's derive path reaches ZERO datadoe.js functions and ZERO runtime-composition / account-onboarding bindings", derive.stopped.has("lib/server/sync/publisher-composition.js#buildSchedulerV2Publisher") && derive.reachedBy(DD).filter((nm) => !/^[A-Z_0-9]+$/.test(nm)).length === 0 && derive.reachedBy("lib/server/sync/runtime-composition.js").length === 0 && derive.reachedBy("lib/server/sync/account-onboarding.js").length === 0);
ok("C3 the CLI's account directory is the DURABLE snapshot (getAccountDirectorySnapshotAccounts) + the LOCAL raw-seller map (resolveDataDoeAccountIds) -- reached; no DataDoe classifyDirectoryAccounts / fetch in the CLI itself", derive.reached.has("lib/server/supabase.js#getAccountDirectorySnapshotAccounts") && derive.reached.has("lib/server/datadoe-connections.js#resolveDataDoeAccountIds") && !/fetchAccounts|fetchDirectory|classifyDirectoryAccounts|datadoe\.js/.test(readFileSync(CLI, "utf8")));

// C4 -- Postgres only through verifiedPgConfig; no TLS downgrade anywhere in the loaded closure.
const loadedSrc = full.loaded.map((f) => [f, readFileSync(abs(f), "utf8")]);
const pgSites = loadedSrc.flatMap(([f, s]) => [...stripJs(s).matchAll(/new\s+(?:pg\.)?(Client|Pool)\s*\(/g)].map((m) => [f, s, m.index]));
const cliSrc = readFileSync(CLI, "utf8");
ok("C4 every pg client in the loaded closure is built from verifiedPgConfig (the CLI via its pgConfig() wrapper = verifiedPgConfig(POSTGRES_URL))", pgSites.length >= 2 && pgSites.every(([f, s]) => /verifiedPgConfig/.test(s) && /from "(\.\.\/)+(lib\/server\/)?pg-tls\.js"|from "\.\.\/pg-tls\.js"/.test(s))
  && /const pgConfig = \(\) => verifiedPgConfig\(process\.env\.POSTGRES_URL\);/.test(cliSrc) && (cliSrc.match(/new pg\.Client\(/g) || []).length === (cliSrc.match(/new pg\.Client\(pgConfig\(\)\)/g) || []).length);
const downgrade = loadedSrc.filter(([, s]) => /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=|sslmode=no-verify/.test(stripJs(s).replace(/""/g, "")) || /process\.env\.NODE_TLS_REJECT_UNAUTHORIZED\s*=/.test(s)).map(([f]) => f);
ok("C4 no loaded module disables TLS verification (rejectUnauthorized:false / NODE_TLS_REJECT_UNAUTHORIZED= / sslmode=no-verify)", downgrade.length === 0);
ok("C4 lib/server/pg-tls.js is in the closure and pins verification (rejectUnauthorized true)", full.loaded.includes("lib/server/pg-tls.js") && /rejectUnauthorized: true/.test(readFileSync(abs("lib/server/pg-tls.js"), "utf8")));

// C5 -- analyzer soundness.
const canaryFile = abs("scripts/release/__closure_canary__.mjs");
const canary = (text) => makeAnalyzer({ overrides: new Map([[canaryFile, text]]) }).run([canaryFile]);
const c1 = canary('import { buildSchedulerV2Runtime } from "../../lib/server/sync/runtime-composition.js";\nbuildSchedulerV2Runtime({});\n');
ok("C5 canary: the SAME analysis reports createExport + makeDataDoeAdapter reachable from buildSchedulerV2Runtime (it sees a forbidden path when one exists)", c1.reached.has(DD + "#createExport") && c1.reached.has("lib/server/sync/source-sync-driver.js#makeDataDoeAdapter"));
const c2 = canary('const { makeDataDoeAdapter } = await import("../../lib/server/sync/source-sync-driver.js");\nexport const x = makeDataDoeAdapter([]);\n');
ok("C5 canary: a dynamic-import-bound adapter reaches createExport / pollExport / downloadExport", ["createExport", "pollExport", "downloadExport"].every((nm) => c2.reached.has(DD + "#" + nm)));
const c3 = canary('const sb = await import("../../lib/server/supabase.js");\nconst pick = (o) => o;\npick(sb);\n');
ok("C5 canary: a namespace passed as a whole value reaches EVERY export of its module", c3.reached.has("lib/server/supabase.js#saveReportSnapshot") && c3.reached.has("lib/server/supabase.js#getReportSnapshot"));
const c4 = canary('import { buildSchedulerV2Publisher } from "../../lib/server/sync/publisher-composition.js";\nbuildSchedulerV2Publisher({});\n');
ok("C5 canary: the publisher composition alone reaches the accounts GET but NO export code", c4.reached.has(DD + "#fetchAccountsDetailed") && !c4.reached.has(DD + "#createExport") && !c4.reached.has("lib/server/sync/source-sync-driver.js#makeDataDoeAdapter"));
// P3-1 canaries: the URL-constant check (C2) FAILS on an injected module that fetches an ENDPOINTS / DATADOE_BASE URL or
// its own 'datadoe.com' literal directly -- the paths the function-name checks alone cannot see.
const c5 = canary('import { ENDPOINTS } from "../../lib/server/datadoe.js";\nexport async function sneaky() { return fetch(ENDPOINTS.exportsCreate, { method: "POST" }); }\nawait sneaky();\n');
const c6 = canary('import { DATADOE_BASE } from "../../lib/server/datadoe.js";\nexport const poll = (id) => fetch(DATADOE_BASE + "/exports/" + id);\nawait poll("e-1");\n');
const c7 = canary('// a comment naming api.datadoe.com is fine\nexport async function sneaky() { return fetch("https://api.datadoe.com/api/v1/exports", { method: "POST" }); }\nawait sneaky();\n');
const c8 = canary('// only a comment: https://api.datadoe.com/api/v1/docs\nexport const x = 1;\n');
const v5 = dataDoeUrlViolations(c5); const v6 = dataDoeUrlViolations(c6); const v7 = dataDoeUrlViolations(c7); const v8 = dataDoeUrlViolations(c8);
ok("C5 canary (P3-1): an ENDPOINTS.exportsCreate fetch, a DATADOE_BASE-built poll and a raw 'datadoe.com' literal fetch are each FLAGGED (the function-name checks alone reach no datadoe.js FUNCTION for them); a comment-only mention is not",
  v5.some((x) => x === "ref:ENDPOINTS<-scripts/release/__closure_canary__.mjs#sneaky") && c5.reachedBy(DD).filter((nm) => /fetch|export|poll|download|create|dd[A-Z]|source/i.test(nm)).length === 0
  && v6.some((x) => x.startsWith("ref:DATADOE_BASE<-scripts/release/__closure_canary__.mjs#poll")) && v7.includes("literal:scripts/release/__closure_canary__.mjs@1") && v8.length === 0);
const guardSrc = readFileSync(abs(GUARD), "utf8");
const v9 = dataDoeUrlViolations(makeAnalyzer({ overrides: new Map([[abs(GUARD), guardSrc + '\nexport const STRAY = "https://api.datadoe.com/api/v1/exports";\n']]) }).run(entries));
ok("C5 canary (P3-1): the guard's exemption is NARROW -- a 'datadoe.com' literal anywhere outside isDataDoeHost in the (loaded) guard is flagged", full.loaded.includes(GUARD) && v9.includes("literal:" + GUARD + "@3"));
const an = makeAnalyzer();
const unbalanced = []; const unregistered = [];
for (const f of full.loaded) {
  const mod = an.parseModule(abs(f));
  if (mod.finalDepth !== 0) unbalanced.push(f + ":" + mod.finalDepth);
  for (const m of mod.raw.matchAll(/^export\s+(?:async\s+)?(?:function\s*\*?\s*|class\s+|const\s+|let\s+|var\s+)([A-Za-z_$][\w$]*)/gm)) if (!mod.decl.has(m[1])) unregistered.push(f + "#" + m[1]);
}
ok(`C5 every one of the ${full.loaded.length} loaded modules parses into BALANCED top-level chunks with every exported function / class / const registered`, unbalanced.length === 0 && unregistered.length === 0);

out(`route-cli-closure: ${passed} passed`);
