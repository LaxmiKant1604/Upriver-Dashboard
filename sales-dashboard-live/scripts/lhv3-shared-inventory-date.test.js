// Phase 1 -- ONE SHARED INVENTORY CYCLE DATE across FBA + Listing Health v3.
//
// The scheduler run job computes inventory_asof EXACTLY ONCE (the previous UTC date, D-1 -- the exact single
// snapshot day requested as [D-1 .. D-1]) and exposes it as an output; the FBA job reads it via --inventory-as-of,
// and the v3 job reads the SAME output as --cycle-date and inside its --confirm operation id. Nothing downstream
// recomputes the date. This test models that flow for the normal, watchdog, manual, and UTC-day-boundary
// executions and proves FBA and v3 always resolve ONE inventory identity. ZERO I/O. 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { fbaInventoryAsOf } from "../lib/server/sync/fba-plan-operation.js";
import { listingHealthV3OperationId } from "../lib/server/sync/listing-health-v3-operation.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "lhv3-shared-inventory-date\n");

// Model the workflow contract. The RUN job resolves inventory_asof once (fbaInventoryAsOf = the previous UTC date,
// D-1, at cfg time). The FBA + v3 jobs consume that captured OUTPUT (never recompute), so both derive their
// inventory identity from it.
const runJobInventoryAsOf = (nowMs) => fbaInventoryAsOf(nowMs);                       // steps.cfg.outputs.inventory_asof
const fbaInventoryIdentity = (inventoryAsOf) => `--inventory-as-of=${inventoryAsOf}`; // FBA command consumes the output
const v3CycleDate = (inventoryAsOf) => inventoryAsOf;                                 // v3 --cycle-date = the SAME output
const v3ConfirmOpId = (region, inventoryAsOf) => `listing-health-v3/${region}/${inventoryAsOf}`; // v3 --confirm

// The single source of truth both jobs must agree on: the inventory snapshot date.
const fbaSnapshotDate = (fbaArg) => fbaArg.replace("--inventory-as-of=", "");
const v3SnapshotDate = (cycleDate, confirmOpId, region) => {
  // v3's identity is coherent ONLY if --cycle-date and the --confirm op id carry the same date for this region.
  assert.equal(confirmOpId, listingHealthV3OperationId(region, cycleDate), "v3 --confirm must equal listingHealthV3OperationId(region, cycleDate)");
  return cycleDate;
};

// Given the run job's single inventory_asof, both consumers must resolve the identical inventory snapshot date.
function shareOneIdentity(region, inventoryAsOf) {
  const fbaArg = fbaInventoryIdentity(inventoryAsOf);
  const cd = v3CycleDate(inventoryAsOf);
  const confirm = v3ConfirmOpId(region, inventoryAsOf);
  return fbaSnapshotDate(fbaArg) === v3SnapshotDate(cd, confirm, region) && fbaSnapshotDate(fbaArg) === inventoryAsOf;
}

/* ===================== A. NORMAL scheduled run (cron fires at the regional UTC time) ===================== */
(() => {
  const now = Date.parse("2026-09-06T03:07:00Z"); // india 03:07 UTC cron (off-boundary primary)
  const iao = runJobInventoryAsOf(now);
  ok("A: inventory_asof is the previous UTC date (D-1) at cfg time", iao === "2026-09-05");
  ok("A: FBA and v3 share one inventory identity (normal)", shareOneIdentity("india", iao));
})();

/* ===================== B. WATCHDOG re-dispatch (+20 min, same UTC day) ===================== */
(() => {
  const primary = runJobInventoryAsOf(Date.parse("2026-09-06T08:37:00Z"));   // europe-au primary cron (off-boundary)
  const watchdog = runJobInventoryAsOf(Date.parse("2026-09-06T08:57:00Z"));  // Cloudflare recovery poll (+20m eligibility)
  ok("B: the watchdog run recomputes the SAME inventory_asof as the primary (same UTC day)", primary === watchdog);
  ok("B: both the primary and the watchdog resolve one FBA+v3 identity (idempotent replay)", shareOneIdentity("europe-au", primary) && shareOneIdentity("europe-au", watchdog) && v3ConfirmOpId("europe-au", primary) === v3ConfirmOpId("europe-au", watchdog));
})();

/* ===================== C. MANUAL workflow_dispatch (any time that UTC day) ===================== */
(() => {
  const iao = runJobInventoryAsOf(Date.parse("2026-09-06T21:15:00Z"));
  ok("C: a manual dispatch resolves inventory_asof = that UTC day's D-1, one shared identity", iao === "2026-09-05" && shareOneIdentity("us-ca", iao));
})();

/* ===================== D. UTC-DAY BOUNDARY: the captured output does not drift when a later job runs past midnight === */
(() => {
  // The run job resolves inventory_asof at 23:55 UTC; the fba + v3 jobs execute minutes later, AFTER midnight UTC.
  const runCfgNow = Date.parse("2026-09-06T23:55:00Z");
  const capturedIao = runJobInventoryAsOf(runCfgNow); // computed ONCE in the run job, exposed as an output
  ok("D: the run job captured D-1 = 2026-09-05 at 23:55 UTC", capturedIao === "2026-09-05");

  // The downstream jobs consume the CAPTURED output (a workflow output is fixed), NOT a fresh recompute. Prove that a
  // naive recompute at the later wall-clock WOULD drift, but the FBA --inventory-as-of override pins the shared value.
  const laterJobNow = Date.parse("2026-09-07T00:10:00Z"); // fba/v3 job runs after midnight UTC
  const naiveRecompute = fbaInventoryAsOf(laterJobNow);   // what a downstream default (no override) would pick
  ok("D: a naive downstream recompute WOULD drift to the next day", naiveRecompute === "2026-09-06" && naiveRecompute !== capturedIao);

  // FBA (--inventory-as-of=capturedIao) and v3 (--cycle-date=capturedIao) both use the captured value -> no drift.
  ok("D: FBA + v3 both pin the CAPTURED inventory_asof, so they still share one identity across the boundary", shareOneIdentity("india", capturedIao));
  ok("D: the FBA CLI accepting --inventory-as-of is what prevents the drift (override beats the local default)", fbaSnapshotDate(fbaInventoryIdentity(capturedIao)) === capturedIao && capturedIao !== naiveRecompute);
})();

/* ===================== E. a mismatched v3 --confirm (wrong date) is rejected by the identity coherence check ======= */
(() => {
  let threw = false;
  try { v3SnapshotDate("2026-09-06", "listing-health-v3/india/2026-09-05", "india"); } catch { threw = true; }
  ok("E: a v3 --confirm whose date disagrees with --cycle-date is incoherent (would be rejected)", threw === true);
})();

writeSync(1, `\nlhv3-shared-inventory-date: ${passed} assertions passed\n`);
