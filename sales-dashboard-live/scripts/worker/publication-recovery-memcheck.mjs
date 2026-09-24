// Publication recovery worker -- repeatable local MEMORY / THROUGHPUT check for the 1 GB Oracle Micro.
//
//   node scripts/worker/publication-recovery-memcheck.mjs                       # synthetic: worker loop RSS + throughput
//   node scripts/worker/publication-recovery-memcheck.mjs --real [--regions=india,europe-au,us-ca] [--families=oli,fba,ads,listings]
//
// --real spawns the EXISTING reconciler CLIs in DRY-RUN (zero writes, zero DataDoe creates/tokens; one zero-token
// account-directory GET each) exactly as the worker's full scan does, samples each child's peak RSS, and reports the
// per-step duration + whether one full scan fits the 1 GB budget and the scan interval. Needs the same env as the worker.
// Verdict lines are honest: a FAIL means do NOT activate the worker on the Micro with the current settings.

import os from "node:os";
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadReleaseEnv } from "../release/env-bootstrap.mjs";
loadReleaseEnv();

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..", "..");
const argOf = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const MB = (b) => Math.round((b / 1048576) * 10) / 10;
const VM_TOTAL_MB = 1024, OS_RESERVE_MB = 250; // Ubuntu 24.04 minimal + sshd + journald headroom on the Micro

function rssOfPid(pid) {
  try {
    if (process.platform === "linux") { const m = readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+)\s+kB/); return m ? Number(m[1]) * 1024 : 0; }
    if (process.platform === "win32") { const out = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).WorkingSet64`], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); return Number(out) || 0; }
    const out = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); return (Number(out) || 0) * 1024;
  } catch { return 0; }
}

if (!process.argv.includes("--real") && !global.gc) {
  // Re-run under the SAME heap cap the systemd unit uses, with --expose-gc so retained heap can be measured exactly.
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, ["--expose-gc", "--max-old-space-size=160", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(r.status == null ? 1 : r.status);
}

if (!process.argv.includes("--real")) {
  // ---------------- synthetic: the orchestrator itself (fake store + fake reconciler world) ----------------
  // Retention is judged on heapUsed AFTER a full GC (what the worker actually keeps alive), sampled across the second
  // half of the run once the store's prune has reached steady state. RSS is reported too but V8 returns freed pages
  // to the OS lazily, so raw RSS growth without GC is not a leak signal on its own.
  const { createMemoryStore } = await import("../../lib/server/recovery/memory-store.js");
  const { createRecoveryWorker } = await import("../../lib/server/recovery/worker.js");
  const { RECOVERY_FAMILIES } = await import("../../lib/server/recovery/registry.js");
  const clk = { t: Date.parse("2026-09-24T10:00:00Z") };
  const store = createMemoryStore({ clock: () => clk.t });
  const ACCOUNTS = Array.from({ length: 80 }, (_, i) => `acct-${String(i).padStart(3, "0")}`); // > the 77-row directory
  for (const f of Object.keys(RECOVERY_FAMILIES)) for (const a of ACCOUNTS) store.env.tokens[f].set(a, `${f}-${a}-0`);
  let flip = 0;
  const run = async ({ family, region, asOf, kind, accounts }) => {
    const keys = RECOVERY_FAMILIES[family].reportKeys();
    const scope = accounts || ACCOUNTS;
    const s = kind === "dry-run" && (flip++ % 3 === 0) ? "STALE" : "PUBLICATION_NOT_REQUIRED";
    const accs = scope.map((id) => ({ id, eligible: true, rev: "r", status: "nonempty", reports: Object.fromEntries(keys.map((k) => [k, { s: kind === "live" ? "READBACK_VERIFIED" : s, r: null }])) }));
    return { exitCode: 0, timedOut: false, result: { ok: true, dataDoeCreates: 0, dataDoeTokens: 0 }, targets: { v: 1, family, bucket: region, requestedAsOf: asOf, dryRun: kind !== "live", dataDoeCreates: 0, dataDoeTokens: 0, accounts: accs }, durationMs: 1 };
  };
  const config = { workerId: "memcheck", host: "local", pollSeconds: 20, scanIntervalSeconds: 600, scanLeaseSeconds: 3600, batch: 5, leaseSeconds: 2400, maxAttempts: 6, maxClaims: 8, childMaxOldSpaceMb: 448, keepDays: 14, stopGraceSeconds: 1, liveFamilies: ["oli", "fba", "ads", "listings"], regions: ["india", "europe-au", "us-ca"], concurrency: 1 };
  // In production every job/state/observation row lives in Postgres, never in the worker's heap. Compact the in-memory
  // stand-in (finished jobs; rows for as-of dates before yesterday) so the retained heap measured below is the WORKER's.
  const { yesterdayUtc } = await import("../../lib/server/recovery/worker.js");
  const compactFakeDb = () => {
    for (let k = store.jobs.length - 1; k >= 0; k -= 1) if (["verified", "superseded", "dead"].includes(store.jobs[k].status)) store.jobs.splice(k, 1);
    const floor = yesterdayUtc(clk.t - 86400000);
    for (const m of [store.state, store.observations]) for (const [key, r] of m) if (r.requested_as_of < floor) m.delete(key);
  };
  const worker = createRecoveryWorker({ store, run, config, clock: () => clk.t, sleep: async (ms) => { clk.t += ms; }, randomUUID: (() => { let n = 0; return () => `c-${++n}`; })(), version: "memcheck" });
  const ITER = Number(argOf("iterations")) || 40000; // 20 s/tick -> ~9.3 simulated days, several as-of rollovers
  const heapMb = () => { global.gc(); global.gc(); return MB(process.memoryUsage().heapUsed); };
  const heap0 = heapMb();
  const rss0 = process.memoryUsage().rss;
  let peak = rss0; const t0 = Date.now();
  const samples = [];
  for (let i = 0; i < ITER; i += 1) {
    if (i % 50 === 0) for (const f of Object.keys(RECOVERY_FAMILIES)) for (const a of ACCOUNTS.slice(0, 10)) store.env.tokens[f].set(a, `${f}-${a}-${i}`);
    await worker.tick();
    clk.t += 20000;
    if (i % 50 === 0) compactFakeDb();
    if (i % 100 === 0) { const r = process.memoryUsage().rss; if (r > peak) peak = r; }
    if (i > 0 && i % Math.max(1, Math.floor(ITER / 20)) === 0) samples.push({ tick: i, heapMb: heapMb(), jobs: store.jobs.length, state: store.state.size, observations: store.observations.size });
  }
  const secs = (Date.now() - t0) / 1000;
  const heap1 = heapMb();
  const rss1 = process.memoryUsage().rss;
  const tail = samples.slice(Math.floor(samples.length / 2)); // steady-state half
  const tailMin = Math.min(...tail.map((s) => s.heapMb)), tailMax = Math.max(...tail.map((s) => s.heapMb));
  const steadyDrift = Math.round((tailMax - tailMin) * 10) / 10;
  const res = { mode: "synthetic", flags: process.execArgv, iterations: ITER, simulatedDays: Math.round((ITER * 20) / 8640) / 10, wallSeconds: Math.round(secs * 10) / 10, ticksPerSecond: Math.round(ITER / secs), heapAfterGcStartMb: heap0, heapAfterGcEndMb: heap1, steadyStateHeapDriftMb: steadyDrift, rssStartMb: MB(rss0), rssPeakMb: MB(peak), rssEndMb: MB(rss1), samples, stats: worker.stats };
  const verdict = steadyDrift < 5 && heap1 < 64 && res.rssPeakMb < 200 ? "PASS" : "FAIL";
  console.log(JSON.stringify(res, null, 1));
  console.log(`VERDICT synthetic worker memory: ${verdict} (steady-state retained-heap drift ${steadyDrift} MB < 5 MB; end heap ${heap1} MB < 64 MB; RSS peak ${res.rssPeakMb} MB < 200 MB under --max-old-space-size=160; ${ITER} ticks ~ ${res.simulatedDays} simulated days)`);
  process.exit(verdict === "PASS" ? 0 : 1);
}

// ---------------- real: the existing reconciler CLIs in DRY-RUN (zero writes) ----------------
const { runReconcile } = await import("../../lib/server/recovery/runner.js");
const { RECOVERY_FAMILIES } = await import("../../lib/server/recovery/registry.js");
const { yesterdayUtc } = await import("../../lib/server/recovery/worker.js");
const regions = (argOf("regions") || "india,europe-au,us-ca").split(",").filter(Boolean);
const families = (argOf("families") || Object.keys(RECOVERY_FAMILIES).join(",")).split(",").filter(Boolean);
const childCap = Number(argOf("child-max-old-space-mb")) || 448;
const asOf = argOf("as-of") || yesterdayUtc(Date.now());
const steps = [];
const workerRss = process.memoryUsage().rss;
for (const region of regions) for (const family of families) {
  let peak = 0, timer = null;
  const r = await runReconcile({ appRoot, family, region, asOf, kind: "dry-run", accounts: null, childMaxOldSpaceMb: childCap,
    onChild: (c) => { timer = setInterval(() => { const v = rssOfPid(c.pid); if (v > peak) peak = v; }, 1000); } });
  if (timer) clearInterval(timer);
  const t = r.targets;
  const step = { region, family, seconds: Math.round(r.durationMs / 100) / 10, childPeakRssMb: MB(peak), exit: r.exitCode, timedOut: r.timedOut, accounts: t ? t.accounts.length : null, dataDoeCreates: t ? t.dataDoeCreates : null, dataDoeTokens: t ? t.dataDoeTokens : null, stderrTail: r.targets ? undefined : r.stderrTail };
  steps.push(step);
  console.log(JSON.stringify(step));
}
const totalSeconds = Math.round(steps.reduce((s, x) => s + x.seconds, 0));
const maxChild = Math.max(0, ...steps.map((s) => s.childPeakRssMb));
// The worker figure is the synthetic check's RSS ceiling (a no-idle tight loop), not this idle process's RSS: conservative.
const WORKER_RSS_CEILING_MB = 200;
const workerBudget = Math.max(MB(workerRss), WORKER_RSS_CEILING_MB);
const budget = workerBudget + maxChild + OS_RESERVE_MB;
const allOk = steps.every((s) => s.exit === 0 && !s.timedOut && s.accounts != null);
const zero = steps.every((s) => s.dataDoeCreates === 0 && s.dataDoeTokens === 0);
console.log(JSON.stringify({ mode: "real", asOf, platform: `${process.platform}/${os.arch()}`, node: process.versions.node, steps: steps.length, fullScanSeconds: totalSeconds, maxChildPeakRssMb: maxChild, workerRssMb: MB(workerRss), workerBudgetMb: workerBudget, osReserveMb: OS_RESERVE_MB, budgetMb: budget, vmMb: VM_TOTAL_MB, childHeapCapMb: childCap }, null, 1));
console.log(`VERDICT memory on the 1 GB Micro: ${budget <= VM_TOTAL_MB * 0.85 ? "PASS" : "FAIL"} (worker ceiling ${workerBudget} + max child ${maxChild} + OS reserve ${OS_RESERVE_MB} = ${budget} MB vs 85% of ${VM_TOTAL_MB} MB)`);
console.log(`VERDICT full scan cadence: one full scan = ${totalSeconds}s ${totalSeconds <= 600 ? "<=" : ">"} the 600s interval (the scan is STEPPED, so pending work still runs between steps; the effective full-scan period is max(600s, ${totalSeconds}s + pauses))`);
console.log(`VERDICT dry-runs: ${allOk ? "all completed" : "SOME FAILED"}; DataDoe creates/tokens reported: ${zero ? "ZERO" : "NON-ZERO (STOP)"}`);
if (!existsSync(path.join(appRoot, "package.json"))) process.exit(2);
process.exit(allOk && zero && budget <= VM_TOTAL_MB * 0.85 ? 0 : 1);
