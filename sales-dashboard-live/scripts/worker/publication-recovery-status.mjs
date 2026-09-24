// Publication recovery worker -- operational status (read-only, redacted): heartbeat(s), last scan, pending/retry/
// dead-letter counts, oldest lag, per-region/account/report reason codes, last verified publications. Shaped for a
// future Delivery Status "details" panel; this script only prints it.
//
//   node scripts/worker/publication-recovery-status.mjs [--limit=200] [--summary]

import { loadReleaseEnv } from "../release/env-bootstrap.mjs";
loadReleaseEnv();
const argOf = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.split("=").slice(1).join("=") : null; };
if (!String(process.env.POSTGRES_URL || "").trim()) { console.error("STOP POSTGRES_URL not set"); process.exit(2); }
const { createRecoveryStore } = await import("../../lib/server/recovery/store-pg.js");
let store;
try { store = createRecoveryStore({ connectionString: process.env.POSTGRES_URL, max: 1 }); }
catch { console.error("STOP POSTGRES_URL invalid (value not printed)"); process.exit(2); }
try {
  const s = await store.status(Math.max(1, Math.min(Number(argOf("limit")) || 200, 1000)));
  if (process.argv.includes("--summary")) {
    const { problems, last_verified, ...rest } = s || {};
    console.log(JSON.stringify({ ...rest, problems: (problems || []).length, last_verified: (last_verified || []).slice(0, 5) }, null, 1));
  } else console.log(JSON.stringify(s, null, 1));
} catch (e) { console.error("STOP status read failed: " + String((e && e.code) || "error")); await store.close(); process.exit(3); }
await store.close();
