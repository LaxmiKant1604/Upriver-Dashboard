// Publication recovery worker -- the ONLY place a child process is spawned. It runs exactly one of the four existing
// zero-export reconciler CLIs (RECOVERY_FAMILIES[*].script) with a hard OS timeout, keeps ONLY the machine lines
// (RESULT / TARGETS) plus a small sanitized stderr tail (bounded memory; reconciler logs are never persisted), and never
// passes --mode=immediate, never runs --live without an explicit non-empty account list, and never runs a script
// outside the allow-list (FORBIDDEN_WORKER_SCRIPTS are refused even if mis-registered).

import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import { RECOVERY_FAMILIES, FORBIDDEN_WORKER_SCRIPTS } from "./registry.js";
import { parseTargetsLine } from "../sync/reconcile-targets-output.js";

const S = (v) => (v == null ? "" : String(v));
const RUN_TOKEN_RE = /^[A-Za-z0-9._:-]{8,200}$/;
const ACCOUNT_RE = /^[A-Za-z0-9._:-]{1,120}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A canonical, whitespace-free, <=200-char owner run token (source-priority-control-package.js requirement). */
export function makeRunToken({ workerId, family, region, now = Date.now(), nonce = Math.random().toString(36).slice(2, 10) }) {
  const w = S(workerId).replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40) || "worker";
  return `prw-${w}-${family}-${region}-${now}-${nonce}`.slice(0, 200);
}

/**
 * PURE argv builder (tested). kind: "dry-run" | "live" | "cleanup".
 *   dry-run: zero writes; accounts optional (omitted = the reconciler's full-region scan, read-only).
 *   live   : REQUIRES a non-empty region-filtered account list + a unique run token (never a full-region live pass).
 *   cleanup: evidence-based control safe-close for the SAME run token after an abnormal exit.
 */
export function buildReconcileArgs({ family, region, asOf, accounts = null, kind, runToken = null }) {
  const fam = RECOVERY_FAMILIES[family];
  if (!fam) throw new Error(`buildReconcileArgs: unknown family '${family}' (fail closed)`);
  const base = path.basename(fam.script);
  if (FORBIDDEN_WORKER_SCRIPTS.includes(base)) throw new Error(`buildReconcileArgs: '${base}' is forbidden (fail closed)`);
  if (!["india", "europe-au", "us-ca"].includes(S(region))) throw new Error(`buildReconcileArgs: bad region '${region}'`);
  if (!DATE_RE.test(S(asOf))) throw new Error(`buildReconcileArgs: bad as-of '${asOf}'`);
  const args = [fam.script, `--bucket=${region}`, `--as-of=${asOf}`, "--mode=periodic"];
  const list = Array.isArray(accounts) ? [...new Set(accounts.map(S).filter(Boolean))].sort() : null;
  if (list) for (const a of list) if (!ACCOUNT_RE.test(a)) throw new Error("buildReconcileArgs: malformed account id (fail closed)");
  if (kind === "cleanup") {
    if (!RUN_TOKEN_RE.test(S(runToken))) throw new Error("buildReconcileArgs: cleanup requires the run token (fail closed)");
    return [...args, `--run-token=${runToken}`, "--cleanup"];
  }
  if (kind === "live") {
    if (!list || !list.length) throw new Error("buildReconcileArgs: a live pass requires a non-empty account list (never a full-region live pass)");
    if (!RUN_TOKEN_RE.test(S(runToken))) throw new Error("buildReconcileArgs: a live pass requires a unique run token (fail closed)");
    return [...args, `--accounts=${list.join(",")}`, `--deadline-seconds=${fam.deadlineSeconds}`, `--run-token=${runToken}`, "--emit-targets", "--live"];
  }
  if (kind === "dry-run") {
    return [...args, ...(list && list.length ? [`--accounts=${list.join(",")}`] : []), `--deadline-seconds=${fam.deadlineSeconds}`, "--emit-targets"];
  }
  throw new Error(`buildReconcileArgs: unknown kind '${kind}'`);
}

const STDERR_TAIL_LINES = 8;
const MAX_LINE = 64 * 1024; // a TARGETS line for 40 accounts is ~10 KB; anything larger is truncated (and so unparsable)

/** Keep only the last few stderr lines, reduced to safe tokens (no payload can survive). */
function sanitizeLine(line) { return S(line).replace(/[^\x20-\x7E]/g, "").slice(0, 200); }

/**
 * Spawn one reconciler child. Resolves (never rejects) with
 * { exitCode, signal, timedOut, spawnError, result, targets, stderrTail, durationMs, maxRssMb? }.
 * deps.spawn is injectable for tests.
 */
export function runReconcile({ appRoot, family, region, asOf, accounts, kind, runToken, env = process.env, childMaxOldSpaceMb = 512, spawnImpl = nodeSpawn, killGraceMs = 15000, onChild = null, now = () => Date.now() }) {
  const fam = RECOVERY_FAMILIES[family];
  const args = buildReconcileArgs({ family, region, asOf, accounts, kind, runToken });
  const hardTimeoutMs = (kind === "cleanup" ? 180 : fam.hardTimeoutSeconds) * 1000;
  const started = now();
  return new Promise((resolve) => {
    let child;
    const childEnv = { ...env, NODE_OPTIONS: `--max-old-space-size=${Math.max(128, Number(childMaxOldSpaceMb) || 512)}` };
    // Never let a debug dump env leak per-account detail into logs from a worker-spawned child.
    delete childEnv.OLI_RECONCILE_DUMP; delete childEnv.RECONCILE_DUMP;
    try { child = spawnImpl(process.execPath, args, { cwd: appRoot, env: childEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }
    catch (e) { resolve({ exitCode: null, signal: null, timedOut: false, spawnError: S(e && e.code) || "spawn-error", result: null, targets: null, stderrTail: [], durationMs: now() - started }); return; }
    if (typeof onChild === "function") { try { onChild(child); } catch { /* ignore */ } }
    let result = null, targets = null, timedOut = false, settled = false;
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
    lineReader(child.stdout, (line) => {
      if (line.startsWith("RESULT ")) { try { result = JSON.parse(line.slice(7)); } catch { /* malformed -> no result */ } }
      else if (line.startsWith("TARGETS ")) { const t = parseTargetsLine(line); if (t) targets = t; }
    });
    lineReader(child.stderr, (line) => { if (line.trim()) { tail.push(sanitizeLine(line)); if (tail.length > STDERR_TAIL_LINES) tail.shift(); } });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      setTimeout(() => { if (!settled) { try { child.kill("SIGKILL"); } catch { /* ignore */ } } }, killGraceMs).unref?.();
    }, hardTimeoutMs);
    timer.unref?.();
    const finish = (exitCode, signal, spawnError = null) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ exitCode, signal, timedOut, spawnError, result, targets, stderrTail: tail, durationMs: now() - started, args: args.map((a) => (a.startsWith("--accounts=") ? `--accounts=<${a.split(",").length}>` : a)) });
    };
    child.on("error", (e) => finish(null, null, S(e && e.code) || "child-error"));
    child.on("close", (code, signal) => finish(code, signal));
  });
}
