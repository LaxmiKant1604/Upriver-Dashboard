// TRUSTED, DEFERRED durable-scheduler-status operator for source_controls.
// Usage (run from sales-dashboard-live/):
//   node scripts/release/scheduled-source-controls.mjs           -> DRY RUN: print current vs target (NO writes)
//   node scripts/release/scheduled-source-controls.mjs --apply   -> set the target rows
//
// It makes the durable source_controls reflect the automatic scheduler's reality: ONLY order-line-items +
// product-catalog show schedule_enabled=true AND paused=false; every OTHER registered source stays
// schedule_enabled=false (its paused state is left untouched). GitHub Actions is the sole TIMING authority --
// this row is durable STATUS only (no cron reads it to auto-run). It never touches publication controls, never
// enables the scheduler cron, and never prints a secret.

import { loadReleaseEnv } from "./env-bootstrap.mjs";

loadReleaseEnv(); // portable: loads <repoRoot>/.env.local when present, maps SUPABASE_URL, never overrides CI env

const MODE = process.argv.includes("--apply") ? "apply" : "dry-run";
const OPERATOR = process.env.PRIORITY_OPERATOR || "laxmikant@superboring.in";

const { SOURCE_REGISTRY } = await import("../../lib/server/sync/source-registry.js");
const { scheduledSourceControlPlan, SCHEDULED_ENABLED_SOURCE_KEYS } = await import("../../lib/server/sync/source-scheduled-oli.js");
const { getSourceControls, setSourceControl } = await import("../../lib/server/supabase.js");

const registryKeys = SOURCE_REGISTRY.map((r) => r.sourceKey);
const plan = scheduledSourceControlPlan(registryKeys);
const log = (m) => console.log("source-controls: " + m);

log("mode=" + MODE + " operator=" + OPERATOR);
log("schedule-ENABLED + unpaused: " + SCHEDULED_ENABLED_SOURCE_KEYS.join(", ") + "; every other source stays schedule-disabled.");

const before = await getSourceControls();
if (before.read !== "ok") { console.error("STOP could not read source_controls (" + before.read + "/" + before.error + ")"); process.exit(1); }
const byKey = new Map(before.rows.map((r) => [r.source_key, r]));
const enabledNow = before.rows.filter((r) => r.schedule_enabled === true).map((r) => r.source_key).sort();
log("current schedule_enabled: [" + enabledNow.join(", ") + "]");

// Show the exact intended target for the two enabled families + a count of the disabled remainder.
for (const key of SCHEDULED_ENABLED_SOURCE_KEYS) {
  const cur = byKey.get(key);
  log("  TARGET " + key + " -> schedule_enabled=true paused=false (was schedule_enabled=" + (cur ? cur.schedule_enabled : "absent") + " paused=" + (cur ? cur.paused : "absent") + ")");
}
const disabledTargets = plan.filter((p) => !SCHEDULED_ENABLED_SOURCE_KEYS.includes(p.sourceKey));
log("  TARGET " + disabledTargets.length + " other source keys -> schedule_enabled=false (paused untouched)");

if (MODE !== "apply") {
  log("DRY RUN -- no writes. Re-run with --apply to set the target.");
  process.exit(0);
}

for (const p of plan) {
  await setSourceControl({ sourceKey: p.sourceKey, scheduleEnabled: p.scheduleEnabled, ...(p.paused !== undefined ? { paused: p.paused } : {}), updatedBy: OPERATOR });
}

// Re-read + verify EXACTLY the two enabled families + that nothing else is schedule-enabled.
const after = await getSourceControls();
if (after.read !== "ok") { console.error("STOP post-apply read failed (" + after.read + ")"); process.exit(1); }
const afterByKey = new Map(after.rows.map((r) => [r.source_key, r]));
const problems = [];
for (const key of SCHEDULED_ENABLED_SOURCE_KEYS) {
  const r = afterByKey.get(key);
  if (!r || r.schedule_enabled !== true || r.paused !== false) problems.push(key + " not enabled+unpaused");
}
const stillEnabled = after.rows.filter((r) => r.schedule_enabled === true).map((r) => r.source_key).sort();
const extra = stillEnabled.filter((k) => !SCHEDULED_ENABLED_SOURCE_KEYS.includes(k));
if (extra.length) problems.push("unexpected schedule_enabled: " + extra.join(", "));
if (problems.length) { console.error("STOP source_controls verification failed: " + problems.join("; ")); process.exit(1); }
log("COMMITTED. schedule_enabled now EXACTLY [" + stillEnabled.join(", ") + "], both unpaused; every other source schedule-disabled.");
process.exit(0);
