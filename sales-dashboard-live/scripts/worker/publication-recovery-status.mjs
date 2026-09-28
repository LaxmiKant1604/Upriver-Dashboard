// Publication recovery worker -- operational status (read-only, redacted): heartbeat(s), the per-route canary switches
// and counts, the tier-1 summary + deep-sweep progress, pending / retry / dead-letter counts, ALERTS (dead letters by
// class, missing-evidence > 6 h, served-row-preempted, zero-export-violation, capacity-exceeded, source-stale-manual,
// await-timeout, stranded-partial-cycle, paid-cycle-stale-open, paid-job-stale-in-flight, unregistered-live-report-key,
// scheduler-gate starvation > 12 h, writer-fenced, ...), the DB WRITER FENCE state PER KEY (20260935; 'absent' until it is
// applied), and the owner HAND-OFF MATRIX per region x account x report with EXACTLY the classes repaired |
// already-current | deferred | missing-source | failed | not-applicable (typed). Shaped for a future Delivery Status
// "details" panel; this script only prints it. Never a payload, never a secret.
//
//   node scripts/worker/publication-recovery-status.mjs [--limit=200] [--summary] [--matrix]

import { loadReleaseEnv } from "../release/env-bootstrap.mjs";
loadReleaseEnv();
const argOf = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.split("=").slice(1).join("=") : null; };
if (!String(process.env.POSTGRES_URL || "").trim()) { console.error("STOP POSTGRES_URL not set"); process.exit(2); }
const { createRecoveryStore } = await import("../../lib/server/recovery/store-pg.js");
const { buildHandoffMatrix } = await import("../../lib/server/recovery/worker.js");
const { fenceStatusSummary } = await import("../../lib/server/sync/report-writer-fence.js");
let store;
try { store = createRecoveryStore({ connectionString: process.env.POSTGRES_URL, max: 1 }); }
catch { console.error("STOP POSTGRES_URL invalid (value not printed)"); process.exit(2); }
try {
  const s = await store.status(Math.max(1, Math.min(Number(argOf("limit")) || 200, 1000)));
  const fence = fenceStatusSummary(await store.readFence());
  let directory = new Map();
  try { directory = await store.readDirectory(); } catch { /* the matrix then lists region rows only */ }
  const matrix = buildHandoffMatrix({ stateRows: (s && s.state) || [], directory });
  const matrixCounts = {};
  for (const r of matrix) { const k = `${r.region}:${r.handoff}`; matrixCounts[k] = (matrixCounts[k] || 0) + 1; }
  if (process.argv.includes("--summary")) {
    const { problems, last_verified, state, ...rest } = s || {};
    console.log(JSON.stringify({ ...rest, problems: (problems || []).length, last_verified: (last_verified || []).slice(0, 5), fence, handoff: matrixCounts }, null, 1));
  } else if (process.argv.includes("--matrix")) {
    console.log(JSON.stringify({ state_epoch: s && s.state_epoch, fence, handoff: matrixCounts, matrix }, null, 1));
  } else console.log(JSON.stringify({ ...s, fence, handoff: matrixCounts, matrix }, null, 1));
} catch (e) { console.error("STOP status read failed: " + String((e && e.code) || "error")); await store.close(); process.exit(3); }
await store.close();
