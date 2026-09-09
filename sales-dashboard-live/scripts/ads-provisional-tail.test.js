// Defect C regression: resolveDailyAdsAvailability marks the trailing covered-but-not-yet-itemized sub-window
// PROVISIONAL when the durable latestMetricDate trails the coverage end (a known provider item-level lag), instead
// of presenting it as a completed zero-ad assessment through coveredTo. It NEVER invents a zero, never drops
// covered-empty semantics for a genuinely quiet day, and leaves a fully-empty (no-metric) covered window to the
// existing status. Offline, pure. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { resolveDailyAdsAvailability } from "../lib/server/sync/report-source-contracts.js";

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); };
writeSync(1, "ads-provisional-tail (Defect C)\n");

const planned = { from: "2026-04-01", to: "2026-09-08", currency: "INR", rawSellerId: "S1", accountId: "a1" };
const coverage = (over = {}) => ({
  accountId: "a1", rawSellerId: "S1", requested: { from: "2026-04-01", to: "2026-09-08" },
  windows: [{ from: "2026-07-08", to: "2026-09-08" }], coverageRead: "ok", metricsRead: "ok",
  syncStatus: "succeeded", latestMetricDate: "2026-09-06", adRows: [], ...over,
});

// The Indya case: covered through Sep 8, but the durable metrics stop Sep 6.
{
  const { availability } = resolveDailyAdsAvailability(coverage(), planned);
  ok("A: coverage past the requested start is partial (Jul 8 start != Apr 1)", availability.status === "partial");
  ok("A: latestMetricDate is carried honestly (Sep 6)", availability.latestMetricDate === "2026-09-06");
  ok("A: the VERIFIED window ends at latestMetricDate (Sep 6) -- a no-spend day inside it is a real zero", availability.verifiedThrough === "2026-09-06");
  ok("A: the trailing covered tail (Sep 7..Sep 8) is the UNKNOWN/unverified window (not a completed zero, not asserted delay)",
    availability.provisionalFrom === "2026-09-07" && availability.provisionalTo === "2026-09-08" && availability.provisionalState === "unknown-unverified");
}

// Fully itemized through the covered end => NO provisional tail.
{
  const { availability } = resolveDailyAdsAvailability(coverage({ latestMetricDate: "2026-09-08" }), planned);
  ok("B: latestMetricDate == coveredTo => no provisional tail (fully itemized)", availability.provisionalFrom === null && availability.provisionalTo === null);
}

// A genuinely empty covered window (no metrics at all) is NOT relabeled provisional (a real zero-ad account).
{
  const { availability } = resolveDailyAdsAvailability(coverage({ latestMetricDate: null }), planned);
  ok("C: no latestMetricDate => no provisional tail (a legitimately quiet/zero-ad account is not relabeled)", availability.provisionalFrom === null);
}

// A fully-validated window with metrics through the end => validated, no provisional.
{
  const full = { from: "2026-07-08", to: "2026-09-08", currency: "INR", rawSellerId: "S1", accountId: "a1" };
  const { availability } = resolveDailyAdsAvailability(coverage({ requested: { from: "2026-07-08", to: "2026-09-08" }, latestMetricDate: "2026-09-08" }), full);
  ok("D: covered == requested with metrics through the end => validated, no provisional tail", availability.status === "validated" && availability.provisionalFrom === null);
}

writeSync(1, `\nads-provisional-tail: ${passed} assertions passed\n`);
