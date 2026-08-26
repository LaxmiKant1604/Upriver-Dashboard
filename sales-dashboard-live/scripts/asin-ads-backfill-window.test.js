// ASIN Ads backfill window override -- deterministic OFFLINE proof that the shared runner accepts a wider
// historical window (the Daily contract window) for the one-time consistency backfill, and that the default
// (no override) stays the reviewed 21-day rolling refresh.
//
// 7-bit ASCII, LF, no top-level await. Uses empty accounts so the plan returns immediately with just the window.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ["t", "svc", "role", "key"].join("-");
process.env.DATADOE_API_KEY = process.env.DATADOE_API_KEY || "dd_api_test";

const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
let passed = 0; const tests = []; const test = (name, fn) => tests.push({ name, fn });

const { planAsinAdsBucketRun } = await import("../lib/server/sync/scheduled-asin-ads-runner.js");
const { asinAdsRefreshWindow } = await import("../lib/server/sync/source-scheduled-asin-ads.js");

// Minimal deps: a primary connection + zero accounts, so the plan short-circuits to just the resolved window.
const deps = {
  getConnections: () => [{ id: "primary", apiKey: "k", organizationFingerprint: "org" }],
  fetchAccounts: async () => [],
  fetchCompatibleSourceNames: async () => new Set(),
  getCoverage: async () => ({ read: "ok", status: "succeeded", windows: [] }),
};

test("default (no override) uses the reviewed 21-day rolling window", async () => {
  const p = await planAsinAdsBucketRun({ bucket: "non-us", asOf: "2026-08-25", deps });
  assert.deepEqual(p.window, asinAdsRefreshWindow("2026-08-25"));
});

test("a valid windowOverride WIDENS the plan window to the backfill window", async () => {
  const p = await planAsinAdsBucketRun({ bucket: "non-us", asOf: "2026-08-25", windowOverride: { from: "2026-03-01", to: "2026-08-25" }, deps });
  assert.deepEqual(p.window, { from: "2026-03-01", to: "2026-08-25" });
});

test("a malformed override falls back to the rolling window (never a garbage window)", async () => {
  for (const bad of [{ from: "nope", to: "2026-08-25" }, { from: "2026-03-01" }, {}, null]) {
    const p = await planAsinAdsBucketRun({ bucket: "us", asOf: "2026-08-25", windowOverride: bad, deps });
    assert.deepEqual(p.window, asinAdsRefreshWindow("2026-08-25"), "bad override " + JSON.stringify(bad));
  }
});

test("from > to is refused (fail closed)", async () => {
  await assert.rejects(
    () => planAsinAdsBucketRun({ bucket: "us", asOf: "2026-08-25", windowOverride: { from: "2026-08-25", to: "2026-03-01" }, deps }),
    /ASIN_ADS_BAD_WINDOW/,
  );
});

let failures = 0;
for (const t of tests) {
  try { await t.fn(); passed += 1; out("  ok  " + t.name); }
  catch (e) { failures += 1; out("FAIL  " + t.name); out(String((e && e.stack) || e)); }
}
out("\n" + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : ""));
if (failures) process.exitCode = 1;
