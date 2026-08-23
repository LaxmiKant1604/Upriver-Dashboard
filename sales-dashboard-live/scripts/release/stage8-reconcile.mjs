// THROWAWAY STRICTLY READ-ONLY stage-8 protected-data reconciliation (Scheduler-v2 release).
// Usage:  node scripts/release/stage8-reconcile.mjs   (run from sales-dashboard-live/, BEFORE any stage-8 apply)
//
// Adding Migration 9 to release-manifest.mjs changed the manifest fingerprint, so the pre-existing baselines are
// stale and the protected-data pins must be RE-CONFIRMED against production before a stage-8 re-anchor. This
// script does NOT change any pin by assumption. It validates the pinned approved identity BEFORE connecting,
// reads under BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY, captures ALL EIGHT protected digests, and
// CLASSIFIES every one against the manifest pins (matched | drifted | missing | unpinned; plus any extra key).
// It ALWAYS ROLLS BACK and writes NOTHING. It exits NONZERO (STOP) if ANY drift is observed, so a human reviews
// the drift, records intentional-state evidence, and only THEN (separately) updates pins/invariants + regenerates
// the stage-8 baseline at the final reviewed HEAD.

import { readFileSync } from "node:fs";
import pg from "pg";
import { validateIdentity, PROTECTED_DIGESTS } from "./release-manifest.mjs";
import { beginReadOnlySnapshot, captureProtectedDigest, classifyProtectedDrift } from "./release-state.mjs";
import { parseEnv } from "./release-fs.mjs";

const repoRoot = "C:/Users/laxmi/Documents/Codex/2026-07-01/can/Upriver-Dashboard";
const env = parseEnv(readFileSync(repoRoot + "/.env.local", "utf8"));
const id = validateIdentity(env);
console.log(`IDENTITY  approved_ref=${id.projectRef} supabase_host=${id.supaHost} postgres_host=${id.pgHost} ok=${id.ok}`);
if (!id.ok) { console.error("STOP identity: " + id.problems.join("; ")); process.exit(1); }

const u = new URL(env.POSTGRES_URL); u.searchParams.set("sslmode", "no-verify");
const client = new pg.Client({ connectionString: u.toString() });
const q = (text, params) => client.query(text, params);
await client.connect();

let observed = null;
let queryError = null;
let rolledBack = false;
try {
  await beginReadOnlySnapshot(client);
  observed = await captureProtectedDigest(q);
} catch (e) {
  queryError = e && e.message;
} finally {
  try { await client.query("ROLLBACK"); rolledBack = true; } catch { rolledBack = false; }
  await client.end();
}

if (queryError) { console.error("STOP protected-digest capture failed: " + queryError); process.exit(1); }
if (!rolledBack) { console.error("STOP read-only transaction did not roll back cleanly; refusing to report"); process.exit(1); }

const cls = classifyProtectedDrift(PROTECTED_DIGESTS, observed || {});
for (const row of cls.perKey) {
  console.log(`DIGEST ${row.status.toUpperCase().padEnd(8)} ${row.key.padEnd(18)} pin=${row.pin ? row.pin.c + "/" + row.pin.h : "-"} observed=${row.observed ? row.observed.c + "/" + row.observed.h : "-"}`);
}
if (cls.extra.length) console.log("EXTRA observed digest keys: " + cls.extra.join(", "));
console.log("RESULT " + JSON.stringify({ ok: cls.ok, driftCount: cls.driftCount }));
if (!cls.ok) {
  console.error(`STOP ${cls.driftCount} protected-digest drift(s) from the manifest pins. Do NOT change pins by assumption: review each drift, record intentional-state evidence, then (separately) update the manifest pins/invariants and regenerate the stage-8 baseline at the final reviewed HEAD.`);
  process.exit(1);
}
console.log("RESULT    stage-8 reconciliation OK -- protected digests match the manifest pins; safe to re-anchor stage 8");
process.exit(0);
