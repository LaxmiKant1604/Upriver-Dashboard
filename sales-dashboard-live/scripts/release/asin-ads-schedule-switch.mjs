// TRUSTED operator switch for the ASIN Ads schedule: the ONE durable on/off the scheduler-v2 asin_ads job reads
// (source_controls['ads-asin-date'].schedule_enabled). Turning it on is an owner-approved paid-schedule step; turning it
// off is the immediate rollback (the next regional run SKIPs with zero creates; nothing is redeployed, no data changes).
//   node scripts/release/asin-ads-schedule-switch.mjs --enable|--disable          -> DRY RUN (prints current -> target)
//   node scripts/release/asin-ads-schedule-switch.mjs --enable|--disable --apply  -> write + read back
// It touches ONLY that one row's schedule_enabled (never paused, never another source) and never prints a secret.

import { loadReleaseEnv } from "./env-bootstrap.mjs";

loadReleaseEnv();

const enable = process.argv.includes("--enable"); const disable = process.argv.includes("--disable");
const APPLY = process.argv.includes("--apply");
if (enable === disable) { console.error("STOP pass exactly one of --enable | --disable"); process.exit(2); }
const KEY = "ads-asin-date";
const { getSourceControls, setSourceControl } = await import("../../lib/server/supabase.js");
const read = async () => {
  const r = await getSourceControls();
  if (r.read !== "ok") { console.error("STOP source_controls unreadable (" + r.read + ")"); process.exit(1); }
  const row = (r.rows || []).find((x) => x.source_key === KEY);
  if (!row) { console.error("STOP no source_controls row for " + KEY); process.exit(1); }
  return row;
};
const before = await read();
console.log("asin-ads-schedule: current schedule_enabled=" + before.schedule_enabled + " paused=" + before.paused + " -> target schedule_enabled=" + enable + (APPLY ? "" : " (DRY RUN)"));
if (!APPLY) process.exit(0);
await setSourceControl({ sourceKey: KEY, scheduleEnabled: enable });
const after = await read();
if (after.schedule_enabled !== enable) { console.error("STOP read-back schedule_enabled=" + after.schedule_enabled + " != " + enable); process.exit(1); }
console.log("asin-ads-schedule: COMMITTED schedule_enabled=" + after.schedule_enabled + " paused=" + after.paused + " updated_at=" + after.updated_at);
process.exit(0);
