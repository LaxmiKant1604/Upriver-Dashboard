// Defect 4 (Round 4, Codex finding 1) regression: resolveDailyAdsAvailability makes NO unsupported completeness
// claim. There is no durable per-date validated-completeness signal (ads_sync_coverage records the REQUESTED synced
// range, not a validated data extent), so a covered day with no recorded ad row is UNKNOWN, never a measured zero.
// It reports ONLY the FACTUAL recorded-data extent from actual rows -- pure durable evidence (coverage window +
// recorded rows), INVARIANT to requestedTo. It uses NO reporting-lag constant and NEVER infers that a later metric
// completes earlier days. Offline, pure. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { resolveDailyAdsAvailability } from "../lib/server/sync/report-source-contracts.js";

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); };
writeSync(1, "ads-provisional-tail (Round-4 Defect 4)\n");

const adRow = (date, over = {}) => ({ date, seller_or_vendor_id: "S1", currency: "INR", ad_sales: 10, ad_spend: 5, ad_clicks: 2, ...over });
const planned = { from: "2026-04-01", to: "2026-09-08", currency: "INR", rawSellerId: "S1", accountId: "a1" };
const coverage = (over = {}) => ({
  accountId: "a1", rawSellerId: "S1", requested: { from: "2026-04-01", to: "2026-09-08" },
  windows: [{ from: "2026-07-08", to: "2026-09-08" }], coverageRead: "ok", metricsRead: "ok",
  syncStatus: "succeeded", latestMetricDate: null, adRows: [], ...over,
});

// A: a covered window (Jul 8..Sep 8 = 63 days) with recorded rows on only a few days. Completeness is UNVALIDATED,
// so the whole covered window is provisional/unknown; only the FACTUAL recorded extent is reported.
{
  const { availability } = resolveDailyAdsAvailability(coverage({ adRows: [adRow("2026-07-08"), adRow("2026-09-05")] }), planned);
  ok("A: completeness is never validated (no durable per-date signal)", availability.completenessValidated === false);
  ok("A: the FACTUAL recorded extent is reported (Jul 8..Sep 5, 2 of 63 covered days)",
    availability.recordedFrom === "2026-07-08" && availability.recordedThrough === "2026-09-05" && availability.recordedDayCount === 2 && availability.coveredDayCount === 63);
  ok("A: because covered days lack a recorded row, the WHOLE covered window is provisional/unknown (never a measured zero)",
    availability.provisionalFrom === "2026-07-08" && availability.provisionalTo === "2026-09-08" && availability.provisionalState === "unknown-unverified");
  ok("A: NO verifiedThrough/verifiedFrom claim is emitted (the discarded assumptions are gone)",
    availability.verifiedThrough === undefined && availability.verifiedFrom === undefined);
}

// B: every covered day carries a recorded row => nothing unconfirmed => no provisional region.
{
  const small = { from: "2026-09-06", to: "2026-09-08", currency: "INR", rawSellerId: "S1", accountId: "a1" };
  const { availability } = resolveDailyAdsAvailability(coverage({
    requested: { from: "2026-09-06", to: "2026-09-08" }, windows: [{ from: "2026-09-06", to: "2026-09-08" }],
    adRows: [adRow("2026-09-06"), adRow("2026-09-07"), adRow("2026-09-08")],
  }), small);
  ok("B: every covered day recorded => recordedDayCount == coveredDayCount, no provisional region",
    availability.recordedDayCount === 3 && availability.coveredDayCount === 3 && availability.provisionalFrom === null && availability.provisionalState === null);
}

// C (INVARIANT -- Codex finding 1): IDENTICAL durable evidence (same coverage window + same rows) must yield the
// IDENTICAL completeness result regardless of requestedTo. Advancing requestedTo Sep 8 -> Sep 9 must NOT flip any
// day to verified-zero. (The `status` field may legitimately differ -- partial vs stale -- but the recorded/
// provisional completeness fields must be byte-identical.)
{
  const rows = [adRow("2026-07-08"), adRow("2026-09-05")]; // DURABLE ad rows -- unchanged across the two requests
  const windows = [{ from: "2026-07-08", to: "2026-09-08" }]; // DURABLE coverage -- unchanged across the two requests
  // The REQUEST advances (planned.to + the coherent coverage.requested.to), the DURABLE evidence does not.
  const a = resolveDailyAdsAvailability(coverage({ adRows: rows, windows, requested: { from: "2026-04-01", to: "2026-09-08" } }), { ...planned, to: "2026-09-08" }).availability;
  const b = resolveDailyAdsAvailability(coverage({ adRows: rows, windows, requested: { from: "2026-04-01", to: "2026-09-09" } }), { ...planned, to: "2026-09-09" }).availability;
  const completeness = (x) => JSON.stringify([x.recordedFrom, x.recordedThrough, x.recordedDayCount, x.coveredDayCount, x.provisionalFrom, x.provisionalTo, x.provisionalState, x.completenessValidated]);
  ok("C: identical durable evidence gives an identical completeness result when the request advances (invariant to requestedTo)",
    completeness(a) === completeness(b) && a.provisionalFrom === "2026-07-08");
}

// D: no recorded rows at all in the covered window => nothing confirmed, the WHOLE covered window is unknown.
{
  const { availability } = resolveDailyAdsAvailability(coverage({ adRows: [] }), planned);
  ok("D: a covered window with no recorded rows => recordedThrough null, whole covered window provisional/unknown",
    availability.recordedThrough === null && availability.recordedFrom === null && availability.recordedDayCount === 0
    && availability.provisionalFrom === "2026-07-08" && availability.provisionalTo === "2026-09-08");
}

// E (reject "a later metric proves earlier days complete"): a lone late recorded row (only Sep 8) does NOT confirm
// the long preceding no-row span. The whole covered window stays provisional; only Sep 8 is a recorded day.
{
  const { availability } = resolveDailyAdsAvailability(coverage({ adRows: [adRow("2026-09-08")] }), planned);
  ok("E: a lone late recorded row does NOT confirm earlier covered days -> whole covered window provisional (recorded=1)",
    availability.recordedDayCount === 1 && availability.recordedThrough === "2026-09-08"
    && availability.provisionalFrom === "2026-07-08" && availability.provisionalTo === "2026-09-08");
}

writeSync(1, `\nads-provisional-tail: ${passed} assertions passed\n`);
