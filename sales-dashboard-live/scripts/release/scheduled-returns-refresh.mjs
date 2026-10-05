// TRUSTED daily "Returns (FBA & FBM)"-ONLY refresh operator for ONE region (DESIGN-v2 4.1) -- a thin CLI over the region
// runner lib/server/sync/returns-event-runner.js. It creates ONLY Returns exports (never Settlements / OLI / any other
// source; the legacy returns-leakage-golive.mjs operator is not used) and writes ONLY the Returns event source through its
// RPCs. Usage (from sales-dashboard-live/):
//   node scripts/release/scheduled-returns-refresh.mjs --bucket=india|europe-au|us-ca --max-creates=N [--as-of=YYYY-MM-DD]
//        [--scheduled] [--dry-run] [--accounts=id,id] [--confirm-paid] [--reserve-tokens=N] [--allow-shrink=id,id]
//        [--no-adopt-list] [--evidence-file[=path]]
//   --scheduled      the scheduler-v2 returns_source job: runs ONLY while source_controls['returns'] is schedule_enabled and
//                    not paused (the durable switch -- no redeploy); otherwise a SILENT typed skip with zero creates.
//   (operator)       without --scheduled a paid run needs --confirm-paid; it still refuses while the source is paused.
//                    --accounts restricts the region to exact export-eligible ids; --allow-shrink=<ids> lets ONLY those
//                    accounts replace a window that held rows with an empty one (the RPC's sudden-empty guard);
//                    --no-adopt-list skips the free export listing (laptop runs while the publish monitor is active).
//   --as-of          REQUIRED for every paid run (the scheduler passes the run's UTC D-1) and must lie inside
//                    [today-3, today-1] UTC (validateOperatorAsOf) -- never a backfill date. A dry-run defaults to the
//                    previous UTC date.
//   --dry-run        the plan, windows, exposure and balance only: ZERO creates, ZERO export listing, ZERO writes.
//   --max-creates    REQUIRED for a paid run (0..60): the DB-enforced per-(region, UTC claim day) create ceiling,
//                    claimed BEFORE every POST (so an overlapping invocation -- whatever its --as-of -- shares it).
//   --reserve-tokens the balance kept for OLI / Campaign / ASIN (default 100): a fresh balance is read before every create
//                    and creating stops when usable - remaining x 2 < reserve.
// Arguments are parsed STRICTLY (a duplicate, unknown or malformed flag -- e.g. a typo'd --dry-run, or --dry-run=true -- is
// a usage STOP, exit 2, before anything else; a value is never echoed). Then loadReleaseEnv() and the typed Supabase
// configuration gate run BEFORE any dynamic import (supabase.js captures its credentials at module evaluation): a missing
// configuration is an honest STOP (exit 1), never a silent "controls unreadable" skip.
// Controls: unreadable or a missing 'returns' control row -> typed skip + a failed source_run_status row; paused /
// schedule-not-enabled -> a silent skip. Writes rows_written=true|false to $GITHUB_OUTPUT (when set) right after the first
// persisted window and on EVERY exit path (the route step publishes only after real writes). Exit 0 on a typed skip or an
// isolated / partial run, 1 on a systemic failure, 2 on a usage error (STOP). Logs, the RESULT line and the step summary
// carry counts, typed codes, dates and 8-character id prefixes only; full export ids go ONLY to --evidence-file (a local
// file OUTSIDE the git work tree; a bare flag or a relative name resolves under os.tmpdir(); a path inside the work tree is
// refused).

import { appendFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, relative, isAbsolute, dirname, basename } from "node:path";
import { loadReleaseEnv, assertSupabaseReleaseConfig, REPO_ROOT } from "./env-bootstrap.mjs";

const ghOut = (k, v) => { const f = process.env.GITHUB_OUTPUT; if (f) { try { appendFileSync(f, k + "=" + v + "\n"); } catch { /* never affects the exit code */ } } };
const summaryOut = (md) => { const f = process.env.GITHUB_STEP_SUMMARY; if (f) { try { appendFileSync(f, md + "\n"); } catch { /* ignore */ } } };
let rowsWritten = false;
const finish = (code) => { ghOut("rows_written", rowsWritten ? "true" : "false"); process.exit(code); };
const stop = (m, code = 2) => { console.error("STOP " + m); finish(code); };

const REGIONS = ["india", "europe-au", "us-ca"];
const VALUE_FLAGS = new Set(["--bucket", "--max-creates", "--as-of", "--accounts", "--reserve-tokens", "--allow-shrink", "--evidence-file"]);
const BOOLEAN_FLAGS = new Set(["--scheduled", "--dry-run", "--confirm-paid", "--no-adopt-list", "--evidence-file"]);
const DEFAULT_DEADLINE_SECONDS = 2280; // inside the workflow step's 45 minutes, with room for the end-of-run passes
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
const idList = (v) => (v == null ? null : String(v).split(",").map((x) => x.trim()).filter(Boolean));

/**
 * argv (process.argv.slice(2)) -> { ok:true, values: Map(name -> raw value), flags: Set(name) } | { ok:false, message }.
 * Every argument must be a KNOWN flag in its exact form (--name for a boolean, --name=value for a valued flag; only
 * --evidence-file takes both), at most once. The message names a well-formed flag or the argument's position -- never a
 * value (an --accounts list holds full seller ids).
 */
function parseArgv(argv) {
  const values = new Map(); const flags = new Set(); const seen = new Set();
  const list = Array.isArray(argv) ? argv.map((a) => String(a)) : [];
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    const eq = a.indexOf("=");
    const name = eq < 0 ? a : a.slice(0, eq);
    const label = /^--[a-z][a-z-]{0,39}$/.test(name) ? name : "#" + (i + 1);
    if (seen.has(name)) return { ok: false, message: "duplicate argument " + label };
    seen.add(name);
    if (eq < 0 && BOOLEAN_FLAGS.has(name)) { flags.add(name.slice(2)); continue; }
    if (eq > 0 && VALUE_FLAGS.has(name)) { values.set(name.slice(2), a.slice(eq + 1)); continue; }
    if (eq < 0 && VALUE_FLAGS.has(name)) return { ok: false, message: label + " needs =<value>" };
    if (eq > 0 && BOOLEAN_FLAGS.has(name)) return { ok: false, message: label + " takes no value" };
    return { ok: false, message: "unknown argument " + label };
  }
  return { ok: true, values, flags };
}

// The canonical (symlink-resolved, case-folded on Windows) form of a path whose tail may not exist yet.
function canonicalPath(p) {
  const abs = resolve(p);
  let dir = abs; const tail = [];
  while (!existsSync(dir)) { const parent = dirname(dir); if (parent === dir) break; tail.unshift(basename(dir)); dir = parent; }
  let real = dir;
  try { real = realpathSync.native(dir); } catch { real = dir; }
  const full = resolve(real, ...tail);
  return process.platform === "win32" ? full.toLowerCase() : full;
}
function isInsideDir(child, parent) {
  const rel = relative(canonicalPath(parent), canonicalPath(child));
  return rel === "" || (!isAbsolute(rel) && rel.split(/[\\/]/)[0] !== "..");
}
// --evidence-file: a bare flag -> a fresh file under os.tmpdir(); a relative name -> under os.tmpdir(); an absolute path as
// given. Refused inside the git work tree (REPO_ROOT, resolved from this file's own location).
function resolveEvidencePath(arg, { bare, region, asOf, repoRoot = REPO_ROOT, tmp = tmpdir() } = {}) {
  if (arg == null && !bare) return { path: null };
  const name = arg && String(arg).trim() ? String(arg).trim() : "returns-evidence-" + region + "-" + asOf + "-" + Date.now() + ".json";
  const p = isAbsolute(name) ? resolve(name) : resolve(tmp, name);
  if (isInsideDir(p, repoRoot)) return { path: null, refused: true };
  return { path: p };
}

async function main() {
  // ---- usage (pure; before any environment or module is loaded) ----
  const args = parseArgv(process.argv.slice(2));
  if (!args.ok) return stop(args.message + " (usage: --bucket=<region> --max-creates=N --as-of=YYYY-MM-DD [--scheduled | --confirm-paid] [--dry-run] ...)");
  const argOf = (name) => (args.values.has(name) ? args.values.get(name) : null);
  const flag = (name) => args.flags.has(name);
  const region = argOf("bucket");
  const scheduled = flag("scheduled"); const dryRun = flag("dry-run"); const confirmPaid = flag("confirm-paid"); const noAdoptList = flag("no-adopt-list");
  const asOfArg = argOf("as-of");
  const maxCreatesArg = argOf("max-creates");
  const reserveArg = argOf("reserve-tokens");
  const accountAllowlist = idList(argOf("accounts"));
  const allowShrinkIds = idList(argOf("allow-shrink"));
  if (!REGIONS.includes(region)) return stop("--bucket must be one region: india|europe-au|us-ca");
  if (asOfArg != null && !isDay(asOfArg)) return stop("--as-of must be YYYY-MM-DD");
  const asOf = asOfArg || (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
  const maxCreates = maxCreatesArg == null ? null : (/^\d{1,2}$/.test(maxCreatesArg) ? Number(maxCreatesArg) : NaN);
  if (maxCreatesArg != null && !(Number.isSafeInteger(maxCreates) && maxCreates >= 0 && maxCreates <= 60)) return stop("--max-creates must be an integer 0..60");
  if (!dryRun && maxCreates == null) return stop("--max-creates=N (an integer 0..60) is REQUIRED for a paid run");
  const reserveTokens = reserveArg == null ? 100 : (/^\d{1,6}$/.test(reserveArg) ? Number(reserveArg) : NaN);
  if (!(Number.isSafeInteger(reserveTokens) && reserveTokens >= 0)) return stop("--reserve-tokens must be a non-negative integer");
  if (!dryRun && !scheduled && !confirmPaid) return stop("an operator (non-scheduled) paid run requires --confirm-paid");
  if (!dryRun && asOfArg == null) return stop("a paid run requires an explicit --as-of=YYYY-MM-DD");
  if (scheduled && accountAllowlist) return stop("--scheduled runs the whole region (no --accounts)");
  if (scheduled && allowShrinkIds) return stop("--allow-shrink is an operator-only override (never with --scheduled)");
  if (accountAllowlist && !accountAllowlist.length) return stop("--accounts needs at least one id");
  const evidence = resolveEvidencePath(argOf("evidence-file"), { bare: flag("evidence-file"), region, asOf });
  if (evidence.refused) return stop("--evidence-file must be OUTSIDE the git work tree (full export ids never land in the repo)");

  // ---- environment, then the typed configuration gate, then (only then) the env-dependent modules ----
  loadReleaseEnv();
  try { assertSupabaseReleaseConfig(); }
  catch { return stop("RELEASE_CONFIG_UNAVAILABLE: the Supabase URL / service key is not configured (fail closed; zero creates)", 1); }
  const core = await import("../../lib/server/sync/returns-event-source.js");
  if (!dryRun) {
    const v = core.validateOperatorAsOf(asOf);
    if (!v || v.ok !== true) return stop(((v && v.code) || "RETURNS_ASOF_OUT_OF_RANGE") + ": --as-of must be within [today-3, today-1] UTC for a paid run");
  }
  const R = await import("../../lib/server/sync/returns-event-runner.js");
  const { getSourceControls, upsertSourceRunStatus } = await import("../../lib/server/supabase.js");
  const modeTag = scheduled ? "/scheduled" : dryRun ? "/dry-run" : "/operator";
  const log = (m) => console.log("returns[" + region + "@" + asOf + modeTag + "]: " + m);
  const result = (o) => console.log("RESULT " + JSON.stringify({ region, asOf, mode: dryRun ? "dry-run" : "paid", ...o }));
  const skipStatus = async (code, stage = "controls") => {
    try { await upsertSourceRunStatus(R.returnsSkipStatusEntry({ region, code, nowIso: new Date().toISOString(), stage })); }
    catch { log("run-status write failed (non-fatal)"); }
  };

  // ---- the durable control (pause / schedule switch) ----
  let controls;
  try { controls = await getSourceControls(); } catch { controls = { read: "read-failed", rows: [] }; }
  const ctl = controls && controls.read === "ok" ? (controls.rows || []).find((r) => r && r.source_key === core.RETURNS_EVENT_SOURCE_KEY) || null : null;
  if (!dryRun) {
    if (!controls || controls.read !== "ok") {
      log("source controls unreadable -- SKIP, zero creates (fail closed)");
      await skipStatus("RETURNS_CONTROLS_UNREADABLE");
      result({ ok: true, classification: "RETURNS_CONTROLS_UNREADABLE", creates: 0, tokens: 0 });
      summaryOut("### Returns (FBA & FBM) " + region + " skipped -- RETURNS_CONTROLS_UNREADABLE");
      return finish(0);
    }
    if (!ctl) {
      log("no source_controls row for 'returns' -- SKIP, zero creates (fail closed)");
      await skipStatus("RETURNS_CONTROLS_MISSING");
      result({ ok: true, classification: "RETURNS_CONTROLS_MISSING", creates: 0, tokens: 0 });
      summaryOut("### Returns (FBA & FBM) " + region + " skipped -- RETURNS_CONTROLS_MISSING");
      return finish(0);
    }
    if (ctl.paused === true) { log("source paused in the Data Sync Center -- SKIP, zero creates"); result({ ok: true, classification: "RETURNS_PAUSED", creates: 0, tokens: 0 }); return finish(0); }
    if (scheduled && ctl.schedule_enabled !== true) {
      log("deployed but the schedule is NOT enabled (source_controls.schedule_enabled=false) -- SKIP, zero creates");
      result({ ok: true, classification: "RETURNS_SCHEDULE_NOT_ENABLED", creates: 0, tokens: 0 });
      return finish(0);
    }
  } else {
    log("controls: " + (controls && controls.read === "ok" ? (ctl ? "paused=" + (ctl.paused === true) + " schedule_enabled=" + (ctl.schedule_enabled === true) : "no 'returns' row") : "unreadable") + " (dry-run: not gated)");
  }

  // ---- the run ----
  const deadlineEnv = Number(process.env.RETURNS_REFRESH_DEADLINE_SECONDS);
  const deadlineSeconds = Number.isFinite(deadlineEnv) && deadlineEnv >= 60 ? deadlineEnv : DEFAULT_DEADLINE_SECONDS;
  let out;
  try {
    out = await R.runReturnsRegion({
      region, asOf, dryRun, maxCreates, reserveTokens, accountAllowlist, allowShrinkIds, adoptList: !noAdoptList,
      deps: { deadlineAtMs: Date.now() + deadlineSeconds * 1000 }, log,
      onRowsWritten: () => { rowsWritten = true; ghOut("rows_written", "true"); },
    });
  } catch (e) {
    const code = String((e && (e.returnsCode || e.code)) || "");
    if (/^RETURNS_(ALLOWLIST_NOT_IN_REGION|ALLOW_SHRINK_NOT_IN_SCOPE|BAD_REGION|BAD_ASOF|BAD_MAX_CREATES)$/.test(code)) return stop(code);
    const safe = /^[A-Z0-9_]{1,64}$/.test(code) ? code : "RETURNS_RUN_FAILED";
    log("systemic failure " + safe);
    if (!dryRun) await skipStatus(safe, "run"); // the operator card shows the failure (a dry-run stays zero-write)
    result({ ok: false, classification: "RETURNS_FAILED", code: safe, creates: 0, tokens: 0 });
    summaryOut("### Returns (FBA & FBM) " + region + " FAILED -- " + safe);
    return finish(1);
  }
  rowsWritten = rowsWritten || out.rowsWritten === true;
  const payload = R.returnsResultPayload(out);
  console.log("RESULT " + JSON.stringify(payload));
  summaryOut(R.returnsStepSummary(out));
  if (evidence.path) {
    try {
      writeFileSync(evidence.path, JSON.stringify({
        at: new Date().toISOString(), region, asOf, mode: payload.mode, runKey: out.runKey, result: payload,
        exports: { created: out.createdExportIds || [], adopted: out.adoptedExportIds || [] },
        fragments: (out.fragments || []).map((f) => ({ from: f.from, to: f.to, rowCount: f.rowCount, sellers: f.sellers, exportId: f.exportId, requestHash: f.requestHash, via: f.via })),
        balanceBefore: out.balanceBefore,
      }, null, 1));
      log("evidence written outside the work tree (" + basename(evidence.path) + ")");
    } catch { log("evidence file not written"); }
  }
  return finish(out.ok === false ? 1 : 0);
}

main().catch((e) => {
  const code = String((e && (e.returnsCode || e.code)) || "");
  console.error("STOP " + (/^[A-Z0-9_]{1,64}$/.test(code) ? code : "RETURNS_RUN_FAILED"));
  finish(1);
});
