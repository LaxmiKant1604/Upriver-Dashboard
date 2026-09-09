// TRUSTED, READ-ONLY production-schema capability preflight for the HEALTHY-SUBSET (priority-partial) publication.
// Usage (run from sales-dashboard-live/, in the scheduler BEFORE opening any publication control, ONLY on a PARTIAL):
//   node scripts/release/priority-partial-preflight.mjs --bucket=india|europe-au|us-ca
//
// It proves the production schema can OPEN a `priority-partial-<region>-<16hex>` cycle -- i.e. the approval-gated
// migration 20260924 has widened BOTH the EXACT `public.open_sync_cycle(text, date, timestamptz, text)` guard AND the
// `public.sync_cycles_bucket_check` constraint to contain the exact priority-partial regex (verified via the SHARED
// readPartialCycleCapability; NOT "any pg_proc whose text mentions priority-partial"). Exit 0 = permitted (the workflow
// may open controls + publish the healthy subset). Exit NONZERO = NOT permitted / unreadable -> the workflow MUST NOT
// open controls, and NO publication-control / lease / cycle / reservation / publication write occurs. This step itself
// is strictly READ-ONLY. It runs AFTER OLI/Campaign source refresh (which already ran independently) -- so a failure
// here is NOT an overall zero-write claim, only zero PUBLICATION-side writes. 7-bit ASCII, LF.

import { appendFileSync } from "node:fs";
import pg from "pg";
import { loadReleaseEnv } from "./env-bootstrap.mjs";
import { readPartialCycleCapability } from "../../lib/server/sync/priority-partial-capability.js";

loadReleaseEnv();

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const bucket = argOf("bucket");
const ghOut = (k, v) => { const f = process.env.GITHUB_OUTPUT; if (f) { try { appendFileSync(f, k + "=" + v + "\n"); } catch { /* ignore */ } } };

// The partial publication is REGION-scoped: only india|europe-au|us-ca match the priority-partial regex (the legacy
// us|non-us buckets do NOT). Reject anything else BEFORE any DB read, fail closed.
if (!["india", "europe-au", "us-ca"].includes(String(bucket))) {
  ghOut("permitted", "false");
  console.error("STOP PRIORITY_PARTIAL_REGION_UNSUPPORTED: healthy-subset publication is region-scoped (india|europe-au|us-ca); got --bucket=" + bucket + " -- fail closed (ZERO publication writes).");
  process.exit(2);
}

const base = String(process.env.POSTGRES_URL || "").split("?")[0];
if (!base) { ghOut("permitted", "false"); console.error("STOP PRIORITY_PARTIAL_PREFLIGHT_UNREADABLE: POSTGRES_URL unavailable -- fail closed."); process.exit(1); }
const client = new pg.Client({ connectionString: base, ssl: { rejectUnauthorized: false } });
let cap = { permitted: false, reason: "capability-unreadable: connect failed" };
try {
  await client.connect();
  // READ-ONLY, and belt-and-suspenders: a read-only repeatable-read transaction so the two capability SELECTs see a
  // consistent snapshot and can never mutate.
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  cap = await readPartialCycleCapability((sql) => client.query(sql).then((r) => r.rows));
  await client.query("ROLLBACK");
} catch (e) {
  cap = { permitted: false, reason: "capability-unreadable: " + (e && e.message ? e.message : e) };
  try { await client.query("ROLLBACK"); } catch { /* ignore */ }
} finally { try { await client.end(); } catch { /* ignore */ } }

ghOut("permitted", cap.permitted ? "true" : "false");
if (!cap.permitted) {
  console.error("STOP PRIORITY_PARTIAL_MIGRATION_PENDING (" + bucket + "): the priority-partial cycle namespace is NOT permitted by the production schema (" + cap.reason
    + "). Apply the approval-gated migration 20260924_priority_partial_cycle_bucket.sql (MIGRATE_ONLY) first. The workflow will NOT open controls or publish;"
    + " ZERO publication-control/lease/cycle/reservation/publication writes occur (the earlier OLI/Campaign source refresh already ran independently; dashboard LKG preserved).");
  process.exit(1);
}
console.log("PRIORITY_PARTIAL_CAPABILITY_OK (" + bucket + "): open_sync_cycle + sync_cycles_bucket_check permit the priority-partial namespace; the workflow may open controls + publish the healthy subset.");
process.exit(0);
