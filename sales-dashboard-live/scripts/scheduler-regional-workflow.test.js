// Regional scheduler WORKFLOW proof suite (offline, ZERO network/DB).
//
// Proves the trigger ownership invariants on the ACTUAL .github/workflows files + the REGION_SCHEDULE source:
//   A. scheduler-v2 = the dispatch-only 3-region coordinator with a validated region input and no native cron.
//   B. ONE automatic Campaign owner: scheduler-v2 refreshes Campaign once; campaign-ads-golive carries no cron.
//   C. FBA runs as an ISOLATED, needs-gated job (independent failure boundary) using regional routing;
//      fba-plan-golive carries no cron (old 0 4 / 0 5 / 30 12 / 30 13 removed); its manual modes are preserved.
//   D. Returns & Refund Leakage stays manual-only (no cron).
//   E/F. the recovery model: ONE global Cloudflare */10 poller + per-region eligibility (primary+20..primary+180) +
//        three low-cost GitHub backstop crons (primary+40, one per region) -- NOT three false per-region watchdog crons.
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

let schedulerYml, fbaYml, campaignYml, returnsYml, regionSched, cloudflarePollerCron;
// The old 2-bucket + FBA crons AND the retired :00/:30-boundary regional primaries (moved 2026-09-10 to off-boundary
// minutes to dodge GitHub's dropped scheduled-cron deliveries) must all be gone from scheduler-v2.
const LEGACY_CRONS = ["0 2 * * *", "30 10 * * *", "0 4 * * *", "0 5 * * *", "30 12 * * *", "30 13 * * *", "0 3 * * *", "30 8 * * *", "30 16 * * *"];

group("A. scheduler-v2 = the dispatch-only 3-region coordinator");

test("A1. no native GitHub primary cron (Cloudflare dispatch + scheduler-recovery only)", () => {
  const c = crons(schedulerYml);
  assert.deepEqual(c, []);
});

test("A2. dispatch region is explicit and validated before production work", () => {
  assert.match(schedulerYml, /region="\$\{\{ github\.event\.inputs\.region \}\}"/);
  assert.match(schedulerYml, /Unknown region/);
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

test("A5. Cloudflare, recovery, and manual dispatches share the same per-region concurrency key", () => {
  const groupLine = schedulerYml.split("\n").find((line) => line.trim().startsWith("group: scheduler-v2-")) || "";
  assert.equal(groupLine.trim(), "group: scheduler-v2-${{ inputs.region }}");
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
  // FBA runs only when THIS invocation owns real regional work (execute_downstream) AND the token gate proceeded. The
  // old `already_published == 'true'` disjunct was the duplicate-run hole (a delayed duplicate re-ran FBA); it is gone.
  assert.match(schedulerYml, /if:\s*always\(\) && needs\.run\.outputs\.region != '' && needs\.run\.outputs\.execute_downstream == 'true' && needs\.run\.outputs\.token_proceed == 'true'/);
  assert.doesNotMatch(schedulerYml, /needs\.run\.outputs\.already_published == 'true' \|\| needs\.run\.outputs\.token_proceed == 'true'/, "the FBA gate no longer runs on the already-published duplicate arm");
  assert.match(schedulerYml, /fba-plan-golive\.mjs --mode=go-live --region=\$\{\{ needs\.run\.outputs\.region \}\}/);
  // The coordinator still exposes OLI readiness for observability, the shared guard outputs, and the NEW typed
  // execute_downstream signal (run_required=='true' -> real work) that every downstream regional job gates on.
  assert.match(schedulerYml, /oli_ready:\s*\$\{\{ steps\.guard\.outputs\.already_published == 'true' \|\| steps\.readiness\.outputs\.proceed == 'true' \}\}/);
  assert.match(schedulerYml, /already_published:\s*\$\{\{ steps\.guard\.outputs\.already_published \}\}/);
  assert.match(schedulerYml, /token_proceed:\s*\$\{\{ steps\.tokengate\.outputs\.proceed \}\}/);
  assert.match(schedulerYml, /execute_downstream:\s*\$\{\{ steps\.guard\.outputs\.run_required == 'true' \}\}/);
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

group("E. the paid workflow is dispatch-only; timing is externally owned");

test("E1. report/paid workflows carry no native cron", () => {
  // account-onboarding.yml (*/30, zero-export discovery) and scheduler-recovery.yml (*/10, zero-export trigger
  // backstop) are the two NON-report scheduled workers; they are excluded here and asserted in their own suites.
  const all = ["scheduler-v2.yml", "fba-plan-golive.yml", "campaign-ads-golive.yml", "returns-leakage.yml", "db-migrate.yml", "regional-dry-run.yml"];
  let total = [];
  for (const f of all) total = total.concat(crons(read(f)));
  assert.deepEqual(total, [], "Cloudflare dispatches scheduler-v2; report/paid workflows carry no native cron");
});

group("F. recovery model = ONE global Cloudflare poller + per-region eligibility + 3 daily GitHub backstop crons");

test("F1. REGION_SCHEDULE carries the off-boundary primaries + GitHub recovery crons (primary + 40m); NO false per-region watchdog crons", () => {
  assert.equal(regionSched.india.primaryCron, "7 3 * * *");
  assert.equal(regionSched.india.githubRecoveryCron, "47 3 * * *");
  assert.equal(regionSched["europe-au"].primaryCron, "37 8 * * *");
  assert.equal(regionSched["europe-au"].githubRecoveryCron, "17 9 * * *");
  assert.equal(regionSched["us-ca"].primaryCron, "37 16 * * *");
  assert.equal(regionSched["us-ca"].githubRecoveryCron, "17 17 * * *");
  // The dishonest "three per-region Cloudflare watchdog crons" model is GONE.
  for (const region of ["india", "europe-au", "us-ca"]) {
    assert.equal(regionSched[region].watchdogCron, undefined, region + " has no false per-region watchdog cron");
    assert.equal(regionSched[region].watchdogUtc, undefined, region + " has no false per-region watchdog time");
  }
});

test("F2. Cloudflare recovery is ONE global */10 poller (not per-region crons); per-region eligibility = primary+20..primary+180", () => {
  assert.equal(cloudflarePollerCron, "*/10 * * * *", "one global Cloudflare recovery poller cron");
  const toMin = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
  for (const region of ["india", "europe-au", "us-ca"]) {
    const s = regionSched[region];
    assert.equal((toMin(s.recoveryEligibleUtc) - toMin(s.primaryUtc) + 1440) % 1440, 20, region + " recovery-eligible = primary + 20m");
    assert.equal((toMin(s.recoveryWindowEndUtc) - toMin(s.primaryUtc) + 1440) % 1440, 180, region + " window end = primary + 180m");
    // The GitHub backstop cron is 40m after the primary and sits inside the eligibility window.
    const [gm, gh] = s.githubRecoveryCron.split(" ");
    assert.equal((Number(gh) * 60 + Number(gm) - toMin(s.primaryUtc) + 1440) % 1440, 40, region + " GitHub recovery cron = primary + 40m");
  }
});

test("F3. scheduler-v2 is dispatch-only and recovery crons match REGION_SCHEDULE", () => {
  const c = crons(schedulerYml);
  const recoveryCrons = crons(read("scheduler-recovery.yml"));
  assert.deepEqual(c, [], "scheduler-v2 has no native GitHub primary crons");
  for (const region of ["india", "europe-au", "us-ca"]) {
    assert.ok(recoveryCrons.includes(regionSched[region].githubRecoveryCron), region + " recovery cron present in scheduler-recovery.yml");
  }
  assert.equal(recoveryCrons.length, 3, "exactly three GitHub recovery crons (3 jobs/day)");
});

async function main() {
  out("regional scheduler workflow proof suite");
  schedulerYml = read("scheduler-v2.yml");
  fbaYml = read("fba-plan-golive.yml");
  campaignYml = read("campaign-ads-golive.yml");
  returnsYml = read("returns-leakage.yml");
  const routing = await import("../lib/server/sync/campaign-region-routing.js");
  regionSched = routing.REGION_SCHEDULE;
  cloudflarePollerCron = routing.CLOUDFLARE_RECOVERY_POLLER_CRON;

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
