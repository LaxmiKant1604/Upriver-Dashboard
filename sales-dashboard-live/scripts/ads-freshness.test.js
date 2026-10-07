// India Ads 2026-10-07 follow-up (SCHEDULER line) -- "export completed for the requested window" is kept separate from
// "data observed through", and the ASIN cleanup is bounded + verified. Fixtures only: no network, database or DataDoe.
//   A. ads-row-prune.js: per-day probe/delete, one retry on a transient error, verify after a failed DELETE, sanitized
//      status + Postgres code only (no message text).
//   B. Daily period completeness (the shared pure lib): an unknown day -> "Ads partial", TACoS + ROI withheld.
//   F. The Campaign run's observed-through report (read-only, fail-soft).
// The web line's copy also covers the Daily payload's delivered days, the brand-limited projection and the rendered page.

import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const PRUNE = await import("../lib/server/ads-row-prune.js");
const DM = await import("../src/lib/daily-metrics.js");
const VM = await import("../src/lib/daily-view-model.js");

const timeout = (msg = "canceling statement due to statement timeout B0SECRET42") => Object.assign(new Error("Supabase request failed (500): " + msg), { status: 500, code: "57014" });

/* =========================================================== A. verified prune */
async function runPrune({ days, stale = new Set(), deleteError = () => null, commitDespiteError = false, probeThrows = null }) {
  const calls = { probes: [], deletes: [] };
  const attempts = new Map();
  const r = await PRUNE.pruneAdsWindowVerified({
    from: days[0], to: days[days.length - 1], sleep: async () => {}, retryDelayMs: 0,
    probeStale: async (d) => { calls.probes.push(d); if (probeThrows) throw probeThrows; return stale.has(d); },
    deleteStale: async (d) => {
      const n = (attempts.get(d) || 0) + 1; attempts.set(d, n); calls.deletes.push(d);
      const err = deleteError(d, n);
      if (err && !commitDespiteError) throw err;
      stale.delete(d);
      if (err) throw err;
    },
  });
  return { r, calls };
}

test("A1 clean window: one bounded probe per day, ZERO DELETE statements (the AAKRITI case)", async () => {
  const { r, calls } = await runPrune({ days: ["2026-10-04", "2026-10-05", "2026-10-06"], deleteError: () => timeout() });
  assert.equal(r.write, "ok"); assert.equal(r.skippedDays, 3); assert.equal(r.deletedDays, 0);
  assert.deepEqual(calls.deletes, []);
});
test("A2 a stale day is deleted; a transient (57014) failure is retried ONCE; a 400 is not retried", async () => {
  const one = await runPrune({ days: ["2026-10-05", "2026-10-06"], stale: new Set(["2026-10-06"]), deleteError: (_d, n) => (n === 1 ? timeout() : null) });
  assert.equal(one.r.write, "ok"); assert.deepEqual(one.calls.deletes, ["2026-10-06", "2026-10-06"]);
  const bad = await runPrune({ days: ["2026-10-06"], stale: new Set(["2026-10-06"]), deleteError: () => Object.assign(new Error("bad"), { status: 400, code: "PGRST100" }) });
  assert.equal(bad.r.write, "write-failed"); assert.deepEqual(bad.calls.deletes, ["2026-10-06"]);
});
test("A3 a DELETE that failed but committed is verified clean (success); one that left the row is a typed failure with ONLY status + code", async () => {
  const landed = await runPrune({ days: ["2026-10-06"], stale: new Set(["2026-10-06"]), deleteError: () => timeout(), commitDespiteError: true });
  assert.equal(landed.r.write, "ok"); assert.equal(landed.r.verifiedDays, 1);
  const stuck = await runPrune({ days: ["2026-10-05", "2026-10-06", "2026-10-07"], stale: new Set(["2026-10-06"]), deleteError: () => timeout() });
  assert.equal(stuck.r.write, "write-failed");
  assert.deepEqual({ ...stuck.r }, { write: "write-failed", error: "ADS_ROWS_PRUNE_FAILED", stage: "delete", httpStatus: 500, pgCode: "57014", kind: "http", stale: "present", day: "2026-10-06" });
  assert.deepEqual(stuck.calls.probes.filter((d) => d === "2026-10-07"), [], "the prune stops at the first real failure (no further statements)");
  const text = PRUNE.formatAdsWriteFailure(stuck.r);
  assert.equal(text, "ADS_ROWS_PRUNE_FAILED (stage=delete status=500 pg=57014 stale=present)");
  assert.ok(!JSON.stringify(stuck.r).includes("B0SECRET42") && !text.includes("B0SECRET42"), "no message text survives");
});
test("A4 an unreadable probe never skips the DELETE; a network error is retried; an abort is not", async () => {
  const { r, calls } = await runPrune({ days: ["2026-10-06"], stale: new Set(["2026-10-06"]), probeThrows: timeout() });
  assert.equal(r.write, "ok"); assert.deepEqual(calls.deletes, ["2026-10-06"]);
  assert.equal(PRUNE.isRetryableAdsWriteError(PRUNE.sanitizeAdsWriteError(new TypeError("fetch failed"))), true);
  assert.equal(PRUNE.isRetryableAdsWriteError(PRUNE.sanitizeAdsWriteError(Object.assign(new Error("x"), { name: "AbortError" }))), false);
  assert.equal(PRUNE.isRetryableAdsWriteError({ httpStatus: 503, pgCode: null, kind: "http" }), true);
  assert.equal(PRUNE.isRetryableAdsWriteError({ httpStatus: 401, pgCode: null, kind: "http" }), false);
});
test("A5 sanitization keeps only a well-formed status and SQLSTATE / PGRST code", () => {
  assert.deepEqual(PRUNE.sanitizeAdsWriteError({ status: 500, code: "57014", message: "secret" }), { httpStatus: 500, pgCode: "57014", kind: "http" });
  assert.deepEqual(PRUNE.sanitizeAdsWriteError({ status: "x", code: "drop table; --" }), { httpStatus: null, pgCode: null, kind: "network" });
  assert.equal(PRUNE.formatAdsWriteFailure({ error: "not a slug!", stage: "Del ete", httpStatus: 99.5, pgCode: "zz" }), "ADS_ROWS_PRUNE_FAILED");
  assert.equal(PRUNE.pruneDays("2026-10-06", "2026-10-05"), null);
  assert.equal(PRUNE.pruneDays("2025-01-01", "2026-12-31"), null, "an oversized window is refused, never truncated");
});
test("A6 schema-missing and a malformed window are typed (never a silent success)", async () => {
  const schema = await PRUNE.pruneAdsWindowVerified({ from: "2026-10-06", to: "2026-10-06", probeStale: async () => { throw Object.assign(new Error("x"), { code: "PGRST205" }); }, deleteStale: async () => {}, isSchemaMissing: (e) => e.code === "PGRST205" });
  assert.deepEqual(schema, { write: "schema-missing", error: "ADS_ROWS_SCHEMA_MISSING" });
  assert.equal((await PRUNE.pruneAdsWindowVerified({ from: "bad", to: "2026-10-06", probeStale: async () => false, deleteStale: async () => {} })).error, "ADS_ROWS_PRUNE_BAD_WINDOW");
});

/* =========================================================== B. Daily period completeness */
const days = (from, to) => { const o = []; for (let d = from; d <= to;) { o.push(d); const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + 1); d = x.toISOString().slice(0, 10); } return o; };
// The India 2026-10-07 shape: MTD Oct 1..6, the provider has not delivered Oct 6 for the account.
const mtdCell = (known, extra = {}) => ({ sales: 10000, units: 50, adSales: 4000, adSpend: 1000, clicks: 300, hasAd: true, status: "covered",
  ...DM.adPeriodCompleteness({ from: "2026-10-01", to: "2026-10-06", knownAdDates: new Set(known), hasAd: true }), ...extra });
const REPORT = (cell) => ({ columns: [{ key: "mtd", group: "mtd", label: "Oct '26 MTD", from: "2026-10-01", to: "2026-10-06" }], cells: [cell] });

test("B1 returned-but-missing recent date: MTD keeps the known-day sums, is Ads partial, TACoS + ROI withheld, ACoS kept", () => {
  const c = mtdCell(days("2026-10-01", "2026-10-05"));
  assert.deepEqual([c.adKnownDays, c.adTotalDays, c.adPartial], [5, 6, true]);
  const k = VM.dailyMtdKpis(REPORT(c));
  assert.equal(k.adSpend, 1000, "the known days' spend is shown (labelled partial), never inflated or zeroed");
  assert.equal(k.adsPartial, true); assert.equal(k.adKnownDays, 5); assert.equal(k.adTotalDays, 6);
  assert.equal(k.tacos, DM.EM_DASH); assert.equal(k.roi, DM.EM_DASH);
  assert.equal(k.acos, "25.0%", "ACoS = spend / ad sales of the SAME reported days");
  const fmt = Object.fromEntries(DM.DAILY_METRICS.map((m) => [m.key, m.fmt(c, "INR")]));
  assert.equal(fmt.tacos, DM.EM_DASH); assert.equal(fmt.roi, DM.EM_DASH); assert.equal(fmt.acos, "25.0%");
  assert.notEqual(fmt.adSpend, DM.EM_DASH);
});
test("B2 late backfill: once Oct 6 is delivered the same period is complete and TACoS / ROI are shown", () => {
  const c = mtdCell(days("2026-10-01", "2026-10-06"));
  assert.equal(c.adPartial, false);
  const k = VM.dailyMtdKpis(REPORT(c));
  assert.equal(k.tacos, "10.0%"); assert.equal(k.roi, "10.00"); assert.equal(k.adsPartial, false);
});
test("B3 a partial PRIOR day (mid-month gap) also makes the period partial (no 'a later day proves earlier days' assumption)", () => {
  const known = days("2026-10-01", "2026-10-06").filter((d) => d !== "2026-10-03");
  assert.equal(mtdCell(known).adPartial, true);
});
test("B4 a legitimately inactive scope (every day delivered for the account, no ad row in scope) stays unavailable, never partial or 0", () => {
  const c = { sales: 500, units: 3, adSales: 0, adSpend: 0, clicks: 0, hasAd: false, status: "covered",
    ...DM.adPeriodCompleteness({ from: "2026-10-01", to: "2026-10-06", knownAdDates: new Set(days("2026-10-01", "2026-10-06")), hasAd: false }) };
  assert.equal(c.adPartial, false);
  const fmt = Object.fromEntries(DM.DAILY_METRICS.map((m) => [m.key, m.fmt(c, "INR")]));
  assert.equal(fmt.adSpend, DM.EM_DASH); assert.equal(fmt.tacos, DM.EM_DASH);
});
test("B5 OLI partial still blocks the ratios on its own (unchanged rule)", () => {
  const k = VM.dailyMtdKpis(REPORT(mtdCell(days("2026-10-01", "2026-10-06"), { status: "partial" })));
  assert.equal(k.tacos, DM.EM_DASH); assert.equal(k.adsPartial, false);
});

/* =========================================================== F. Campaign observed-through (scheduler summary) */
test("F1 the Campaign run report separates 'export completed' from 'rows observed through' (India 2026-10-07 shape)", async () => {
  const { campaignObservedThrough } = await import("../lib/server/sync/ads-observed-through.js");
  const st = (id, latest, status = "succeeded") => ({ account_id: id, source_key: "campaign-performance-v1", latest_metric_date: latest, last_status: status });
  const r = campaignObservedThrough({
    accountIds: ["ok1", "lag1", "lag2", "none", "fail", "missing"],
    states: [st("ok1", "2026-10-06"), st("lag1", "2026-10-05"), st("lag2", "2026-10-03"), st("none", null), st("fail", "2026-10-06", "failed"),
      { account_id: "ok1", source_key: "asin-performance-v1", latest_metric_date: "2026-09-01", last_status: "failed" }],
    requestedAsOf: "2026-10-06",
  });
  assert.deepEqual(r.reportedThrough, ["ok1"], "another source's state never leaks in");
  assert.deepEqual(r.noRowForDate, [{ id: "lag1", observedThrough: "2026-10-05" }, { id: "lag2", observedThrough: "2026-10-03" }]);
  assert.deepEqual(r.noRows, ["none", "missing"]);
  assert.deepEqual(r.failed, ["fail"]);
  assert.deepEqual(campaignObservedThrough({ accountIds: ["a"], states: [], requestedAsOf: "bad" }), { reportedThrough: [], noRowForDate: [], noRows: [], failed: [] });
  // The CLI wiring is read-only and fail-soft: it never changes the exit code and never creates an export.
  const cli = readFileSync(path.join(appRoot, "scripts/release/scheduled-campaign-ads-refresh.mjs"), "utf8");
  const fn = cli.slice(cli.indexOf("async function reportObservedThrough"), cli.indexOf("\n}\n", cli.indexOf("async function reportObservedThrough")));
  assert.match(fn, /await getAdsSyncStates\(ids\)/);
  assert.match(fn, /catch \(e\) \{\s*log\("observed-through report unavailable \(non-fatal\)/);
  assert.ok(!/process\.exit|createExport|runCampaignAdsRegionSlice/.test(fn), "no exit / export inside the report");
  assert.match(cli, /await reportObservedThrough\(region, label, lastPlan, asOf\);/);
  // Neutral wording: delayed data and genuinely no ad activity cannot be told apart.
  assert.ok(!/not yet reported/i.test(fn), "never claims the data is merely late");
  assert.match(fn, /No Campaign Ads row received for /);
  assert.match(fn, /::notice title=No Campaign Ads row received \(/);
});

let passed = 0;
for (const t of tests) {
  try { await t.fn(); passed += 1; out("  ok  " + t.name); }
  catch (e) { out("FAIL  " + t.name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; }
}
out(`\nads-freshness: ${passed}/${tests.length} passed`);
