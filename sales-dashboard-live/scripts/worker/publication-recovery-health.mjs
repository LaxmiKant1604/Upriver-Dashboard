// Publication recovery worker -- health check (read-only; for systemd ExecStartPost/cron/operator use).
//
//   node scripts/worker/publication-recovery-health.mjs [--worker-id=ID] [--max-beat-age=SECONDS] [--max-dead=N]
//
// Exit 0 healthy | 1 unhealthy (stale/missing heartbeat, stopped, or dead-letters over --max-dead) | 2 config | 3 DB.
// Prints a REDACTED one-line JSON summary (counts, ages, codes) -- never a secret or payload.

import { loadReleaseEnv } from "../release/env-bootstrap.mjs";
loadReleaseEnv();
const argOf = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const { loadRecoveryConfig } = await import("../../lib/server/recovery/config.js");
const cfg = loadRecoveryConfig();
if (!cfg.config.secretsPresent.POSTGRES_URL) { console.log(JSON.stringify({ ok: false, reason: "POSTGRES_URL not set" })); process.exit(2); }
const workerId = argOf("worker-id") || cfg.config.workerId;
// The worker also beats every 60 s while a child runs, so this window only has to absorb a slow DB round-trip.
const maxAge = Number(argOf("max-beat-age")) || (cfg.config.pollSeconds * 3 + 300);
const maxDead = argOf("max-dead") == null ? null : Number(argOf("max-dead"));
const { createRecoveryStore } = await import("../../lib/server/recovery/store-pg.js");
let store;
try { store = createRecoveryStore({ connectionString: process.env.POSTGRES_URL, max: 1 }); }
catch { console.log(JSON.stringify({ ok: false, reason: "POSTGRES_URL invalid (value not printed)" })); process.exit(2); }
let s;
try { s = await store.status(50); } catch (e) { console.log(JSON.stringify({ ok: false, reason: "db:" + String((e && e.code) || "error") })); await store.close(); process.exit(3); }
await store.close();
const w = (s.workers || []).find((x) => x.worker_id === workerId) || null;
const dead = Number(s.jobs && s.jobs.dead_letter) || 0;
const problems = [];
if (!w) problems.push("no-heartbeat-row");
else {
  if (Number(w.beat_age_seconds) > maxAge) problems.push(`heartbeat-stale:${w.beat_age_seconds}s>${maxAge}s`);
  if (w.mode === "stopped") problems.push("worker-stopped");
  if (w.last_error_code) problems.push("last-error:" + w.last_error_code);
}
if (maxDead != null && dead > maxDead) problems.push(`dead-letters:${dead}>${maxDead}`);
const summary = {
  ok: problems.filter((p) => !p.startsWith("last-error:")).length === 0, problems, workerId,
  beatAgeSeconds: w ? w.beat_age_seconds : null, mode: w ? w.mode : null, version: w ? w.version : null,
  control: s.control ? { enabled: s.control.enabled, live_families: s.control.live_families } : null,
  scan: s.scan ? { last_started_at: s.scan.last_started_at, last_finished_at: s.scan.last_finished_at, last_outcome: s.scan.last_outcome } : null,
  jobs: s.jobs ? { by_status: s.jobs.by_status, ready: s.jobs.ready, retrying: s.jobs.retrying, dead_letter: dead, oldest_open_lag_seconds: s.jobs.oldest_open_lag_seconds } : null,
};
console.log(JSON.stringify(summary));
process.exit(summary.ok ? 0 : 1);
