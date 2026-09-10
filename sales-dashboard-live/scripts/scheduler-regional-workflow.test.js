// Regional scheduler WORKFLOW proof suite (offline, ZERO network/DB).
//
// Proves the cron cutover + ownership invariants on the ACTUAL .github/workflows files + the REGION_SCHEDULE source:
//   A. scheduler-v2 = the 3-region coordinator: EXACTLY the three GitHub primary crons (0 3 / 30 8 / 30 16), each
//      DETERMINISTICALLY mapped to one region via a case on github.event.schedule; a region workflow_dispatch input;
//      NO legacy us/non-us cron anywhere.
//   B. ONE automatic Campaign owner: scheduler-v2 refreshes Campaign once; campaign-ads-golive carries no cron.
//   C. FBA runs as an ISOLATED, needs-gated job (independent failure boundary) using regional routing;
//      fba-plan-golive carries no cron (old 0 4 / 0 5 / 30 12 / 30 13 removed); its manual modes are preserved.
//   D. Returns & Refund Leakage stays manual-only (no cron).
//   E. the three Cloudflare watchdog crons are the +20-minute twins (20 3 / 50 8 / 50 16), mapped 1:1 to the regions.
//
// 7-bit ASCII, LF, no top-level await, synchronous writeSync progress, dynamic imports after a dummy env.

import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const group = (label) => tests.push({ marker: label });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // sales-dashboard-live
const WF = path.resolve(ROOT, "..", ".github", "workflows");
const read = (f) => readFileSync(path.join(WF, f), "utf8");
const crons = (yml) => (yml.match(/^\s*-\s*cron:\s*"([^"]+)"/gm) || []).map((l) => l.match(/"([^"]+)"/)[1]);

let schedulerYml, fbaYml, campaignYml, returnsYml, regionSched;
// The old 2-bucket + FBA crons AND the retired :00/:30-boundary regional primaries (moved 2026-09-10 to off-boundary
// minutes to dodge GitHub's dropped scheduled-cron deliveries) must all be gone from scheduler-v2.
const LEGACY_CRONS = ["0 2 * * *", "30 10 * * *", "0 4 * * *", "0 5 * * *", "30 12 * * *", "30 13 * * *", "0 3 * * *", "30 8 * * *", "30 16 * * *"];

group("A. scheduler-v2 = the 3-region coordinator");

test("A1. EXACTLY the three GitHub primary crons: 7 3 (india), 37 8 (europe-au), 37 16 (us-ca) -- off the :00/:30 boundaries", () => {
  const c = crons(schedulerYml);
  assert.deepEqual([...c].sort(), ["7 3 * * *", "37 16 * * *", "37 8 * * *"].sort());
  assert.equal(c.length, 3, "exactly three crons");
});

test("A2. each cron maps DETERMINISTICALLY to one region via a case on github.event.schedule (never the clock)", () => {
  assert.match(schedulerYml, /case "\$\{\{ github\.event\.schedule \}\}" in/);
  assert.match(schedulerYml, /"7 3 \* \* \*"\)\s*region="india"/);
  assert.match(schedulerYml, /"37 8 \* \* \*"\)\s*region="europe-au"/);
  assert.match(schedulerYml, /"37 16 \* \* \*"\)\s*region="us-ca"/);
});

test("A3. a region workflow_dispatch input exists (never a browser-supplied region; validated in cfg)", () => {
  assert.match(schedulerYml, /workflow_dispatch:/);
  assert.match(schedulerYml, /region:\s*\n\s*description:/);
  assert.match(schedulerYml, /if \[ "\$region" != "india" \] && \[ "\$region" != "europe-au" \] && \[ "\$region" != "us-ca" \]/);
});

test("A4. NO legacy us/non-us (or old FBA) cron remains in scheduler-v2", () => {
  const c = crons(schedulerYml);
  for (const legacy of LEGACY_CRONS) assert.ok(!c.includes(legacy), "legacy cron must be gone: " + legacy);
});

test("A5. native primaries and Cloudflare dispatches share the same per-region concurrency key", () => {
  const groupLine = schedulerYml.split("\n").find((line) => line.trim().startsWith("group: scheduler-v2-")) || "";
  assert.match(groupLine, /github\.event_name == 'schedule'/);
  assert.match(groupLine, /github\.event\.schedule == '7 3 \* \* \*' && 'india'/);
  assert.match(groupLine, /github\.event\.schedule == '37 8 \* \* \*' && 'europe-au'/);
  assert.match(groupLine, /github\.event\.schedule == '37 16 \* \* \*' && 'us-ca'/);
  assert.match(groupLine, /\|\| inputs\.region/);
  assert.ok(!groupLine.includes("github.event.schedule || inputs.region"), "cron text must not become the concurrency key");
});

group("B. ONE automatic Campaign owner");

test("B1. scheduler-v2 refreshes Campaign exactly once per run (the ONE automatic owner)", () => {
  const n = (schedulerYml.match(/scheduled-campaign-ads-refresh\.mjs/g) || []).length;
  assert.equal(n, 1, "Campaign refresh invoked exactly once");
  assert.match(schedulerYml, /scheduled-campaign-ads-refresh\.mjs --bucket=\$\{\{ steps\.cfg\.outputs\.region \}\}/);
});

test("B2. campaign-ads-golive carries NO cron (manual-only), so Campaign is never double-refreshed", () => {
  assert.equal(crons(campaignYml).length, 0, "campaign-ads-golive has no cron");
  assert.ok(!/^on:\s*\n\s*schedule:/m.test(campaignYml), "no schedule block");
  assert.match(campaignYml, /workflow_dispatch:/);
});

group("C. FBA = isolated, needs-gated job with regional routing; no FBA cron");

test("C1. scheduler-v2 has an isolated fba job: needs run, always()+shared-guard gate, regional invocation", () => {
  assert.match(schedulerYml, /\n\s{2}fba:\n/, "a separate fba job exists");
  assert.match(schedulerYml, /needs:\s*run/);
  assert.match(schedulerYml, /if:\s*always\(\) && needs\.run\.outputs\.region != '' && \(needs\.run\.outputs\.already_published == 'true' \|\| needs\.run\.outputs\.token_proceed == 'true'\)/);
  assert.match(schedulerYml, /fba-plan-golive\.mjs --mode=go-live --region=\$\{\{ needs\.run\.outputs\.region \}\}/);
  // The coordinator still exposes OLI readiness for observability, plus the shared guard outputs used by FBA.
  assert.match(schedulerYml, /oli_ready:\s*\$\{\{ steps\.guard\.outputs\.already_published == 'true' \|\| steps\.readiness\.outputs\.proceed == 'true' \}\}/);
  assert.match(schedulerYml, /already_published:\s*\$\{\{ steps\.guard\.outputs\.already_published \}\}/);
  assert.match(schedulerYml, /token_proceed:\s*\$\{\{ steps\.tokengate\.outputs\.proceed \}\}/);
});

test("C1b. OLI, Campaign Ads and FBA have independent failure boundaries; INDEPENDENT sales publication (publication gated on the REQUIRED sales source OLI, NOT on Campaign Ads)", () => {
  assert.match(schedulerYml, /id:\s*oli\n\s*continue-on-error:\s*true/);
  assert.match(schedulerYml, /id:\s*campaign\n\s*continue-on-error:\s*true\n\s*if:\s*always\(\)/);
  assert.match(schedulerYml, /SOURCE_REFRESH_FAILED/, "independent sequencing must not hide a real REQUIRED-source (OLI) failure");
  const applyAt = schedulerYml.indexOf("priority-control-package.mjs --apply");
  const applyGuard = schedulerYml.slice(Math.max(0, applyAt - 420), applyAt);
  // The publication controls require the REQUIRED sales source (OLI) + strict D-1 readiness -- but NO LONGER Campaign
  // Ads: a Campaign failure degrades the ads band to honestly unavailable/stale and must never block sales publication
  // (Codex blocker 2). The honesty gate reddens on OLI only; Campaign failure is a non-failing CAMPAIGN_ADS_UNAVAILABLE
  // notice.
  assert.match(applyGuard, /steps\.oli\.outcome == 'success'/);
  assert.doesNotMatch(applyGuard, /steps\.campaign\.outcome == 'success'/, "controls are NOT gated on Campaign Ads (independent sales publication)");
  assert.match(applyGuard, /steps\.readiness\.outputs\.proceed == 'true'/);
  assert.match(schedulerYml, /CAMPAIGN_ADS_UNAVAILABLE/, "a Campaign failure is surfaced by a non-failing unavailable notice, not a publication block");
});

test("C2. fba-plan-golive carries NO cron (old 0 4 / 0 5 / 30 12 / 30 13 removed); manual modes preserved", () => {
  assert.equal(crons(fbaYml).length, 0, "fba-plan-golive has no cron");
  assert.ok(!/schedule:/.test(fbaYml), "no schedule block at all");
  for (const m of ["preflight", "dry-run-cost", "golive-dry-run", "golive"]) assert.ok(fbaYml.includes(m), "manual mode kept: " + m);
  assert.match(fbaYml, /fba-plan-golive\.mjs --mode=go-live/);
});

test("C3. the region guard runs for EVERY region (not hardcoded US), enabling per-region watchdog no-op", () => {
  assert.match(schedulerYml, /verify-us-d1-published\.mjs --bucket=\$\{\{ steps\.cfg\.outputs\.region \}\}/);
  // the pipeline is gated on the guard's run_required, for all regions (no bucket=='us' special-case)
  assert.match(schedulerYml, /steps\.guard\.outputs\.run_required == 'true'/);
  assert.ok(!/bucket == 'us'/.test(schedulerYml), "no US-only special-casing remains");
});

group("D. Returns & Refund Leakage stays manual-only");

test("D1. returns-leakage carries NO cron", () => {
  assert.equal(crons(returnsYml).length, 0, "returns-leakage has no cron");
});

group("E. the whole workflow tree has no legacy schedule + one cron owner");

test("E1. across the report/paid workflows, the ONLY crons are the 3 regional primaries in scheduler-v2", () => {
  // account-onboarding.yml (*/30, zero-export discovery) and scheduler-recovery.yml (*/10, zero-export trigger
  // backstop) are the two NON-report scheduled workers; they are excluded here and asserted in their own suites.
  const all = ["scheduler-v2.yml", "fba-plan-golive.yml", "campaign-ads-golive.yml", "returns-leakage.yml", "db-migrate.yml", "regional-dry-run.yml"];
  let total = [];
  for (const f of all) total = total.concat(crons(read(f)));
  assert.deepEqual([...total].sort(), ["7 3 * * *", "37 16 * * *", "37 8 * * *"].sort(), "only the 3 regional primaries exist in the report/paid workflows");
});

group("F. Cloudflare watchdog spec = the +20-minute twins mapped 1:1 to the regions");

test("F1. REGION_SCHEDULE carries the exact primary + watchdog crons required (off-boundary primaries + 20m twins)", () => {
  assert.equal(regionSched.india.primaryCron, "7 3 * * *");
  assert.equal(regionSched.india.watchdogCron, "27 3 * * *");
  assert.equal(regionSched["europe-au"].primaryCron, "37 8 * * *");
  assert.equal(regionSched["europe-au"].watchdogCron, "57 8 * * *");
  assert.equal(regionSched["us-ca"].primaryCron, "37 16 * * *");
  assert.equal(regionSched["us-ca"].watchdogCron, "57 16 * * *");
});

test("F2. each watchdog cron is EXACTLY its primary + 20 minutes (same hour)", () => {
  for (const region of ["india", "europe-au", "us-ca"]) {
    const [pm, ph] = regionSched[region].primaryCron.split(" ");
    const [wm, wh] = regionSched[region].watchdogCron.split(" ");
    assert.equal(Number(wh), Number(ph), region + " watchdog shares the primary hour");
    assert.equal(Number(wm), Number(pm) + 20, region + " watchdog = primary + 20 min");
  }
});

test("F3. the GitHub primary crons in scheduler-v2 match REGION_SCHEDULE (single source of truth)", () => {
  const c = crons(schedulerYml);
  for (const region of ["india", "europe-au", "us-ca"]) {
    assert.ok(c.includes(regionSched[region].primaryCron), region + " primary cron present in scheduler-v2.yml");
  }
});

async function main() {
  out("regional scheduler workflow proof suite");
  schedulerYml = read("scheduler-v2.yml");
  fbaYml = read("fba-plan-golive.yml");
  campaignYml = read("campaign-ads-golive.yml");
  returnsYml = read("returns-leakage.yml");
  regionSched = (await import("../lib/server/sync/campaign-region-routing.js")).REGION_SCHEDULE;

  let failures = 0;
  for (const t of tests) {
    if (t.marker) { out("-- " + t.marker); continue; }
    try {
      await t.fn();
      passed += 1;
      out("  ok  " + t.name);
    } catch (e) {
      failures += 1;
      out("FAIL  " + t.name);
      out(String((e && e.stack) || e));
    }
  }
  out("\n" + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : ""));
  if (failures) process.exitCode = 1;
}

main();
