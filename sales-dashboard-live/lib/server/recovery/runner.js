// Publication recovery worker -- the ONLY place a child process is spawned (WP11 route runner). It runs exactly ONE
// declared publication route's CLI (routes.js): a 'legacy-cli' route runs its pre-existing zero-export reconciler with
// the EXACT pre-existing argv; a 'route-cli' route runs scripts/release/publication-route-reconcile.mjs --route=<id>.
// Every child gets NODE_OPTIONS='--max-old-space-size=<heap> --import=<file URL of zero-export-guard.mjs>' (the RUNTIME
// zero-export guard is preloaded into every child, legacy ones included) and a per-route hard OS timeout. It keeps
// ONLY the machine lines (RESULT / TARGETS / ZEROEXPORT from stdout AND stderr / STOP) plus a small sanitized stderr
// tail (bounded memory; child logs are never persisted), never passes --mode=immediate or --mode=scheduler, never runs
// --live without an explicit non-empty target list, always passes a unique --run-token with --live (the route CLI
// STOPs without it), and never runs a script outside the allow-list (FORBIDDEN_WORKER_SCRIPTS are refused even if
// mis-registered). The fba-plan route's --as-of MUST be fbaInventoryAsOf(now) (UTC D-1; fba-plan-operation.js).

import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { routeById, ALLOWED_WORKER_SCRIPTS, ROUTE_CLI_MAX_TARGETS, utcDMinus1 } from "./routes.js";
import { FORBIDDEN_WORKER_SCRIPTS, isForbiddenWorkerScript } from "./registry.js";
import { ROUTE_REGIONS, REGION_TARGET_PREFIX } from "./route-contract.js";
import { parseTargetsLine, normalizeTargets, TARGETS_MAX_LINE_BYTES } from "../sync/reconcile-targets-output.js";
import { RUN_ARGS_ERRORS } from "./classify.js";

const S = (v) => (v == null ? "" : String(v));
// Legacy CLIs accept a <=200-char canonical token (source-priority-control-package.js); the route CLI <=150
// (route-publication-release.js parseRouteCliArgs RUN_TOKEN_RE) -- the worker's tokens are always <=150.
const LEGACY_RUN_TOKEN_RE = /^[A-Za-z0-9._:-]{8,200}$/;
const ROUTE_RUN_TOKEN_RE = /^[A-Za-z0-9._:-]{8,150}$/;
// Target grammars (WP11 fixer P3): a LEGACY-CLI account keeps the EXACT pre-route runner bound ({1,120}; the ffb035b
// ACCOUNT_RE -- a 121..160-char id the old runner refused must stay refused, or the legacy argv would no longer be
// byte-identical); a ROUTE-CLI target is a job target key ({1,160} incl. ':' for 'region:<r>'; == route-contract.js
// TARGET_KEY_RE and the 20260934 target_key CHECK).
export const LEGACY_ACCOUNT_RE = /^[A-Za-z0-9._:-]{1,120}$/;
export const ROUTE_TARGET_RE = /^[A-Za-z0-9._:-]{1,160}$/;
/** @deprecated alias of ROUTE_TARGET_RE (the route-cli target-key grammar). */
export const ACCOUNT_RE = ROUTE_TARGET_RE;
const OWNER_RE = /^[A-Za-z0-9._-]{1,120}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// The UTC calendar day after a worker epoch 'YYYY-MM-DD' (the worker's OWN job as-of text -- never a Postgres date).
const utcDayAfter = (d) => { const t = Date.parse(S(d) + "T00:00:00Z"); return Number.isFinite(t) ? new Date(t + 86400000).toISOString().slice(0, 10) : ""; };
export const RUNNER_KINDS = Object.freeze(["dry-run", "verify", "live", "repair", "cleanup"]);
export const CLEANUP_HARD_TIMEOUT_SECONDS = 180;
// The runtime guard module the children preload (path relative to the app root; never imported here -- importing it
// would install the guard into the worker process itself).
export const ZERO_EXPORT_GUARD_RELATIVE_PATH = "lib/server/recovery/zero-export-guard.mjs";
export const ZERO_EXPORT_LINE_PREFIX = "ZEROEXPORT ";
export { FORBIDDEN_WORKER_SCRIPTS };

/** A canonical, whitespace-free, <=150-char owner run token (unique per invocation). */
export function makeRunToken({ workerId, route, family, region, now = Date.now(), nonce = Math.random().toString(36).slice(2, 10) }) {
  const w = S(workerId).replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40) || "worker";
  const id = S(route ?? family).replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40);
  return `prw-${w}-${id}-${S(region).replace(/[^A-Za-z0-9._-]/g, "")}-${now}-${S(nonce).replace(/[^A-Za-z0-9._-]/g, "")}`.slice(0, 150);
}

/** The file URL of the zero-export guard under `appRoot` (the NODE_OPTIONS --import preload target). */
export function zeroExportGuardUrl(appRoot) {
  return S(appRoot) ? pathToFileURL(path.join(S(appRoot), ZERO_EXPORT_GUARD_RELATIVE_PATH)).href : new URL("./zero-export-guard.mjs", import.meta.url).href;
}

/** The child NODE_OPTIONS: the heap cap + the guard preload (nothing else is inherited). */
export function childNodeOptions({ heapMb, guardUrl }) {
  const h = Number(heapMb);
  if (!Number.isInteger(h) || h < 128) throw new Error("childNodeOptions: heapMb must be an integer >= 128 (fail closed).");
  if (!/^file:\/\/\S+zero-export-guard\.mjs$/.test(S(guardUrl))) throw new Error("childNodeOptions: the zero-export guard file URL is required (fail closed).");
  return `--max-old-space-size=${h} --import=${guardUrl}`;
}

/** The child heap: min(route.childHeapMb, the configured cap); below route.minChildHeapMb -> null (capacity-exceeded). */
export function childHeapFor(route, capMb) {
  const cap = Number(capMb) || 512;
  const heap = Math.min(route.childHeapMb, Math.max(128, cap));
  return heap < route.minChildHeapMb ? null : heap;
}

/**
 * PURE argv builder (tested). kind: 'dry-run' | 'verify' | 'live' | 'repair' | 'cleanup'.
 *   dry-run : zero writes; targets optional (omitted = the CLI's full-region scan, read-only).
 *   verify  : route-cli -> dry-run + --verify-exact (read-only manifest pass); legacy -> its dry-run (no manifest pass).
 *   live    : REQUIRES a non-empty target list + a unique run token (never a full-region live pass).
 *   repair  : route-cli only -> live + --verify-exact (re-derive a 'manifest-differs' unit, fenced publish).
 *   cleanup : evidence-based control safe-close for the SAME run token (+ the SAME as-of) after an abnormal exit.
 * legacy-cli argv is BYTE-IDENTICAL to the pre-route runner; route-cli argv =
 *   [script, --route=<id>, --bucket=<r>, --as-of=<epoch>, --mode=periodic, --targets=<sorted>, --deadline-seconds=<n>,
 *    --emit-targets] (+ --verify-exact | --run-token=<t> --live [--verify-exact]).
 * `now` (epoch ms) is REQUIRED for a non-cleanup fba-plan pass: its --as-of must be fbaInventoryAsOf(now).
 */
export function buildRouteArgs({ route, region, asOf, targets = null, kind, runToken = null, now = null, mode = "periodic" }) {
  const r = routeById(route);
  const script = r.cli.script;
  const base = path.basename(script);
  if (!ALLOWED_WORKER_SCRIPTS.includes(script) || isForbiddenWorkerScript(base)) throw new Error(`buildRouteArgs: '${base}' is not an allowed worker script (fail closed)`);
  if (!RUNNER_KINDS.includes(kind)) throw new Error(`buildRouteArgs: unknown kind '${S(kind).slice(0, 20)}'`);
  if (mode !== "periodic") throw new Error("buildRouteArgs: the worker only ever runs --mode=periodic (never immediate / scheduler) (fail closed)");
  if (!ROUTE_REGIONS.includes(S(region))) throw new Error(`buildRouteArgs: bad region '${S(region).slice(0, 20)}'`);
  if (!DATE_RE.test(S(asOf))) throw new Error(`buildRouteArgs: bad as-of '${S(asOf).slice(0, 20)}'`);
  if (r.id === "fba-plan" && kind !== "cleanup") {
    if (typeof now !== "number" || !Number.isFinite(now) || asOf !== utcDMinus1(now)) throw new Error("buildRouteArgs: the fba-plan --as-of must be fbaInventoryAsOf(now) (UTC D-1) (fail closed)");
  }
  const list = Array.isArray(targets) ? [...new Set(targets.map(S).filter(Boolean))].sort() : null;
  if (list) {
    const targetRe = r.kind === "legacy-cli" ? LEGACY_ACCOUNT_RE : ROUTE_TARGET_RE;
    for (const a of list) if (!targetRe.test(a)) throw new Error("buildRouteArgs: malformed account / target id (fail closed)");
    for (const a of list) {
      if (r.grain === "region" && a !== REGION_TARGET_PREFIX + region) throw new Error("buildRouteArgs: a region-grain target must be 'region:<bucket>' (fail closed)");
      if (r.grain === "account" && r.kind === "route-cli" && !OWNER_RE.test(a)) throw new Error("buildRouteArgs: malformed account target (fail closed)");
    }
  }
  if (r.kind === "legacy-cli") {
    const args = [script, `--bucket=${region}`, `--as-of=${asOf}`, "--mode=periodic"];
    if (kind === "cleanup") {
      if (!LEGACY_RUN_TOKEN_RE.test(S(runToken))) throw new Error("buildRouteArgs: cleanup requires the run token (fail closed)");
      return [...args, `--run-token=${runToken}`, "--cleanup"];
    }
    if (kind === "live") {
      if (!list || !list.length) throw new Error("buildRouteArgs: a live pass requires a non-empty account list (never a full-region live pass)");
      if (!LEGACY_RUN_TOKEN_RE.test(S(runToken))) throw new Error("buildRouteArgs: a live pass requires a unique run token (fail closed)");
      return [...args, `--accounts=${list.join(",")}`, `--deadline-seconds=${r.deadlineSeconds}`, `--run-token=${runToken}`, "--emit-targets", "--live"];
    }
    if (kind === "repair") throw new Error(`buildRouteArgs: legacy route '${r.id}' has no --verify-exact repair pass (fail closed)`);
    return [...args, ...(list && list.length ? [`--accounts=${list.join(",")}`] : []), `--deadline-seconds=${r.deadlineSeconds}`, "--emit-targets"];
  }
  const args = [script, `--route=${r.id}`, `--bucket=${region}`, `--as-of=${asOf}`, "--mode=periodic"];
  if (list && list.length > ROUTE_CLI_MAX_TARGETS) throw new Error(`buildRouteArgs: at most ${ROUTE_CLI_MAX_TARGETS} targets per route CLI run (fail closed)`);
  if (kind === "cleanup") {
    if (!ROUTE_RUN_TOKEN_RE.test(S(runToken))) throw new Error("buildRouteArgs: cleanup requires the run token (fail closed)");
    return [...args, `--run-token=${runToken}`, "--cleanup"];
  }
  const scan = [...args, ...(list && list.length ? [`--targets=${list.join(",")}`] : []), `--deadline-seconds=${r.deadlineSeconds}`, "--emit-targets"];
  if (kind === "dry-run") return scan;
  if (kind === "verify") return [...scan, "--verify-exact"];
  if (!list || !list.length) throw new Error("buildRouteArgs: a live pass requires a non-empty target list (never a full-region live pass)");
  if (!ROUTE_RUN_TOKEN_RE.test(S(runToken))) throw new Error("buildRouteArgs: a live pass requires a unique run token (the route CLI STOPs without --run-token) (fail closed)");
  return [...scan, `--run-token=${runToken}`, "--live", ...(kind === "repair" ? ["--verify-exact"] : [])];
}

const STDERR_TAIL_LINES = 8;
// A TARGETS v2 line is bounded to TARGETS_MAX_LINE_BYTES (256 KB); anything larger is truncated (and so unparsable).
export const MAX_LINE = TARGETS_MAX_LINE_BYTES;
const OOM_RE = /JavaScript heap out of memory|Reached heap limit|ERR_WORKER_OUT_OF_MEMORY|FATAL ERROR: .*Allocation failed/;

/** Keep only a few stderr lines, reduced to safe tokens (no payload can survive). */
function sanitizeLine(line) { return S(line).replace(/[^\x20-\x7E]/g, "").slice(0, 200); }

/**
 * Parse a ZEROEXPORT guard line (the SAME rule as zero-export-guard.mjs parseZeroExportLine). null when not one. The
 * machine prefix is matched ONLY at the START of a line (a 'ZEROEXPORT {...}' fragment anywhere else in a line -- quoted
 * in a log message, embedded in a RESULT / TARGETS payload -- is never a guard line; WP11 fixer P3).
 */
export function parseZeroExportLine(line) {
  const s = S(line);
  if (!s.startsWith(ZERO_EXPORT_LINE_PREFIX)) return null;
  try { const o = JSON.parse(s.slice(ZERO_EXPORT_LINE_PREFIX.length)); return o && typeof o === "object" && Number.isFinite(Number(o.blocked)) ? o : null; } catch { return null; }
}

/** Fold one parsed ZEROEXPORT line into the run's running maximum (counters are monotonic per process). */
export function foldZeroExport(acc, z) {
  const a = acc || { blocked: 0, allowedAccountsGets: 0, final: false, lines: 0 };
  if (!z) return a;
  return { blocked: Math.max(a.blocked, Number(z.blocked) || 0), allowedAccountsGets: Math.max(a.allowedAccountsGets, Number(z.allowedAccountsGets) || 0), final: a.final || z.final === true, lines: a.lines + 1 };
}

// runRoute's typed argv refusals (WP11 fixer P3): a malformed invocation RESOLVES { argsError } (classifyRun maps it)
// instead of throwing past the worker. ARGS_ERROR_FBA_PLAN_AS_OF_ROLLED = the fba-plan job's as-of is the PREVIOUS
// UTC D-1 because the day rolled after the claim (a legitimate mid-run midnight roll -> evidence-advanced: the next claim
// supersedes the job under the new epoch); anything else is ARGS_ERROR_REFUSED (the worker's own invocation is wrong).
export const ARGS_ERROR_FBA_PLAN_AS_OF_ROLLED = RUN_ARGS_ERRORS.FBA_PLAN_AS_OF_ROLLED;
export const ARGS_ERROR_REFUSED = RUN_ARGS_ERRORS.REFUSED;

/**
 * Spawn one route child. Resolves (never rejects, never throws) with { route, kind, exitCode, signal, timedOut,
 * spawnError, argsError, capacityExceeded, oom, stop, result, targets (the raw parsed TARGETS -- v1 for a legacy CLI),
 * targetsV2 (normalized), targetLines, zeroExport, stderrTail, durationMs, heapMb, args (targets redacted) }. A refused
 * argv (buildRouteArgs threw: an unknown route, a malformed target / as-of / token, an fba-plan as-of that is not
 * fbaInventoryAsOf(now)) resolves WITHOUT a spawn with argsError (ARGS_ERROR_*) + argsErrorMessage (bounded, sanitized).
 * deps.spawn is injectable.
 */
export function runRoute({ appRoot, route, region, asOf, targets = null, kind, runToken = null, env = process.env, childMaxOldSpaceMb = 512, spawnImpl = nodeSpawn, killGraceMs = 15000, onChild = null, now = () => Date.now(), guardUrl = null }) {
  const started = now();
  const zero = { blocked: 0, allowedAccountsGets: 0, final: false, lines: 0 };
  const base = { route: S(route), kind, exitCode: null, signal: null, timedOut: false, spawnError: null, argsError: null, capacityExceeded: null, oom: false, stop: null, result: null, targets: null, targetsV2: null, targetLines: 0, zeroExport: zero, stderrTail: [], durationMs: 0, heapMb: null };
  const refused = (e, rolled = false) => Promise.resolve({ ...base, argsError: rolled ? ARGS_ERROR_FBA_PLAN_AS_OF_ROLLED : ARGS_ERROR_REFUSED, argsErrorMessage: sanitizeLine(e && e.message).slice(0, 160), durationMs: now() - started });
  let r;
  try { r = routeById(route); } catch (e) { return refused(e); }
  const heap = childHeapFor(r, childMaxOldSpaceMb);
  const empty = { ...base, route: r.id, heapMb: heap };
  // The configured child cap is below what this route needs: never spawn a child that would OOM -- capacity-exceeded.
  if (heap == null) return Promise.resolve({ ...empty, capacityExceeded: "child-heap-cap-below-minimum" });
  let args;
  try { args = buildRouteArgs({ route: r.id, region, asOf, targets, kind, runToken, now: started }); }
  catch (e) {
    // The ONE legitimate refusal: an fba-plan pass whose (well-formed) job as-of is OLDER than the UTC D-1 at spawn --
    // the day rolled between the claim and this child (the job's as-of was D-1 when claimed; ISO dates compare as text).
    const rolled = r.id === "fba-plan" && kind !== "cleanup" && DATE_RE.test(S(asOf)) && utcDayAfter(S(asOf)) === utcDMinus1(started);
    return refused(e, rolled);
  }
  const hardTimeoutMs = (kind === "cleanup" ? CLEANUP_HARD_TIMEOUT_SECONDS : r.hardTimeoutSeconds) * 1000;
  // The guard preload is mandatory: a missing / malformed guard URL is a refused invocation (never a guard-less child).
  let nodeOptions;
  try { nodeOptions = childNodeOptions({ heapMb: heap, guardUrl: guardUrl || zeroExportGuardUrl(appRoot) }); } catch (e) { return refused(e); }
  return new Promise((resolve) => {
    let child;
    const childEnv = { ...env, NODE_OPTIONS: nodeOptions };
    // Never let a debug dump env leak per-account detail into logs from a worker-spawned child.
    delete childEnv.OLI_RECONCILE_DUMP; delete childEnv.RECONCILE_DUMP;
    try { child = spawnImpl(process.execPath, args, { cwd: appRoot, env: childEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }
    catch (e) { resolve({ ...empty, spawnError: S(e && e.code) || "spawn-error", durationMs: now() - started }); return; }
    if (typeof onChild === "function") { try { onChild(child); } catch { /* ignore */ } }
    let result = null, parsedTargets = null, targetLines = 0, timedOut = false, settled = false, oom = false, stop = null;
    let zeroExport = { blocked: 0, allowedAccountsGets: 0, final: false, lines: 0 };
    const tail = [];
    const lineReader = (stream, onLine) => {
      let buf = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        buf += chunk;
        if (buf.length > MAX_LINE * 2) buf = buf.slice(-MAX_LINE * 2);
        let i;
        while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1); onLine(line); }
      });
      stream.on("end", () => { if (buf) onLine(buf); buf = ""; });
    };
    const zeroLine = (line) => { const z = parseZeroExportLine(line); if (z) zeroExport = foldZeroExport(zeroExport, z); return !!z; };
    lineReader(child.stdout, (line) => {
      if (zeroLine(line)) return;
      if (line.startsWith("RESULT ")) { try { result = JSON.parse(line.slice(7)); } catch { /* malformed -> no result */ } }
      else if (line.startsWith("TARGETS ")) { targetLines += 1; const t = parseTargetsLine(line); if (t) parsedTargets = t; }
    });
    lineReader(child.stderr, (line) => {
      if (zeroLine(line)) return;
      if (OOM_RE.test(line)) oom = true;
      const m = /^STOP ([A-Z][A-Z0-9_]{1,63})\b/.exec(line);
      if (m && !stop) stop = { code: m[1] };
      if (line.trim()) { tail.push(sanitizeLine(line)); if (tail.length > STDERR_TAIL_LINES) tail.shift(); }
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      setTimeout(() => { if (!settled) { try { child.kill("SIGKILL"); } catch { /* ignore */ } } }, killGraceMs).unref?.();
    }, hardTimeoutMs);
    timer.unref?.();
    const finish = (exitCode, signal, spawnError = null) => {
      if (settled) return; settled = true; clearTimeout(timer);
      // A V8 abort (exit 134 / SIGABRT) with no RESULT line is treated as the heap OOM it almost always is.
      const aborted = !result && (exitCode === 134 || signal === "SIGABRT");
      resolve({
        route: r.id, kind, exitCode, signal, timedOut, spawnError, argsError: null, capacityExceeded: null, oom: oom || aborted, stop, result,
        targets: parsedTargets, targetsV2: parsedTargets ? normalizeTargets(parsedTargets) : null, targetLines, zeroExport,
        stderrTail: tail, durationMs: now() - started, heapMb: heap,
        args: args.map((a) => (a.startsWith("--accounts=") || a.startsWith("--targets=") ? a.split("=")[0] + `=<${a.split(",").length}>` : a)),
      });
    };
    child.on("error", (e) => finish(null, null, S(e && e.code) || "child-error"));
    child.on("close", (code, signal) => finish(code, signal));
  });
}
