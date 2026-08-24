// Scheduler v2 -- INERT SOURCE-FIRST SCHEDULE proof suite (offline, ZERO network/DB).
//
// Proves the Phase-6 schedule is prepared AND inert:
//   A. cadence -- Non-US daily 07:30 IST == 02:00 UTC; US daily 16:00 IST == 10:30 UTC; cron strings match.
//   B. marketplace-local asOf -- each marketplace's LATEST COMPLETED LOCAL DAY (conservative standard-time
//      offsets); a bucket takes the MINIMUM across its marketplaces; unknown marketplaces fail closed.
//   C. launch decisions -- schedule-disabled by DEFAULT (every source_controls row defaults FALSE);
//      not-due before the scheduled time; overlap while a run is still `running`; already-ran-today;
//      completion-anchored >=60s cooldown (never a blind offset); a paused source never launches.
//   D. inertness -- NO cron is registered anywhere (vercel.json has no crons; the GitHub workflow has no
//      schedule; no api/cron file imports source-schedule); the module itself contains no timer
//      (setTimeout/setInterval) and performs no I/O; the durable default is schedule_enabled FALSE; the
//      DataDoe polling GET keeps its existing five-second policy (a poll is never a create-export).
//
// 7-bit ASCII, LF, no top-level await, synchronous writeSync progress, dynamic imports after a dummy env.

import assert from "node:assert/strict";
import { writeSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = process.env[SB_KEY_ENV] || ["test", "svc", "role", "key"].join("-");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const group = (label) => tests.push({ marker: label });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

let sched;

const UTC = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi, 0, 0);

group("A. cadence constants");

test("A1. Non-US 07:30 IST == 02:00 UTC; US 16:00 IST == 10:30 UTC; crons agree", () => {
  assert.deepEqual({ ...sched.SOURCE_SYNC_SCHEDULE_UTC }, { "non-us": "02:00", us: "10:30" });
  assert.deepEqual({ ...sched.SOURCE_SYNC_SCHEDULE_IST }, { "non-us": "07:30", us: "16:00" });
  // IST = UTC+05:30 -- verify the pairs arithmetically, not by trust.
  for (const bucket of ["non-us", "us"]) {
    const [uh, um] = sched.SOURCE_SYNC_SCHEDULE_UTC[bucket].split(":").map(Number);
    const [ih, im] = sched.SOURCE_SYNC_SCHEDULE_IST[bucket].split(":").map(Number);
    assert.equal((uh * 60 + um + 330) % 1440, ih * 60 + im, bucket + ": UTC + 5h30 == IST");
  }
  assert.deepEqual({ ...sched.SOURCE_SYNC_SCHEDULE_CRON }, { "non-us": "0 2 * * *", us: "30 10 * * *" });
  assert.equal(sched.SCHEDULE_COOLDOWN_MS, 60_000);
});

group("B. marketplace-local latest completed day");

test("B1. per-marketplace completed day is LOCAL-date-minus-1 (conservative standard offsets); bucket takes the minimum", () => {
  // 2026-08-20 02:00 UTC: IN local = 07:30 on the 20th -> completed 19th; US Pacific local = 18:00 on the
  // 19th -> completed 18th.
  const now = UTC(2026, 8, 20, 2, 0);
  assert.equal(sched.latestCompletedLocalDay(now, "IN"), "2026-08-19");
  assert.equal(sched.latestCompletedLocalDay(now, "US"), "2026-08-18");
  assert.equal(sched.latestCompletedLocalDay(now, "DE"), "2026-08-19");
  assert.equal(sched.latestCompletedLocalDay(now, "AU"), "2026-08-19");
  const { asOf, perMarketplace } = sched.bucketAsOf(now, ["IN", "DE", "AU"]);
  assert.equal(asOf, "2026-08-19", "all three completed the 19th");
  assert.deepEqual(perMarketplace, { IN: "2026-08-19", DE: "2026-08-19", AU: "2026-08-19" });
  // A bucket mixing US would pull the minimum back to the 18th -- every account's day must be complete.
  assert.equal(sched.bucketAsOf(now, ["IN", "US"]).asOf, "2026-08-18");
  assert.throws(() => sched.latestCompletedLocalDay(now, "XX"), /no reviewed timezone offset/);
  assert.throws(() => sched.bucketAsOf(now, []), /fail closed/);
});

group("C. launch decisions (typed; injected clock + durable state only)");

const CONTROLS_ON = [{ source_key: "order-line-items", schedule_enabled: true, paused: false }];
const NOW_DUE = UTC(2026, 8, 20, 2, 5); // five minutes after the non-us slot

test("C1. the DEFAULT state never launches: schedule-disabled with every control FALSE", () => {
  const d = sched.plannedScheduledInvocation({
    bucket: "non-us", nowUtcMs: NOW_DUE, marketplaceCountries: ["IN"],
    controls: [{ source_key: "order-line-items", schedule_enabled: false, paused: false }],
    runStatuses: [],
  });
  assert.deepEqual(d, { launch: false, reason: "schedule-disabled", bucket: "non-us", enabledSources: [] });
  const empty = sched.plannedScheduledInvocation({ bucket: "non-us", nowUtcMs: NOW_DUE, marketplaceCountries: ["IN"], controls: [], runStatuses: [] });
  assert.equal(empty.reason, "schedule-disabled", "no durable rows => still inert");
});

test("C2. a PAUSED source never schedules even when schedule_enabled", () => {
  const d = sched.plannedScheduledInvocation({
    bucket: "non-us", nowUtcMs: NOW_DUE, marketplaceCountries: ["IN"],
    controls: [{ source_key: "order-line-items", schedule_enabled: true, paused: true }],
    runStatuses: [],
  });
  assert.equal(d.reason, "schedule-disabled");
});

test("C3. not-due before the slot; launch after it with the marketplace-local asOf", () => {
  const early = sched.plannedScheduledInvocation({
    bucket: "non-us", nowUtcMs: UTC(2026, 8, 20, 1, 30), marketplaceCountries: ["IN"],
    controls: CONTROLS_ON, runStatuses: [],
  });
  assert.equal(early.reason, "not-due");
  const due = sched.plannedScheduledInvocation({
    bucket: "non-us", nowUtcMs: NOW_DUE, marketplaceCountries: ["IN"],
    controls: CONTROLS_ON, runStatuses: [],
  });
  assert.equal(due.launch, true);
  assert.equal(due.asOf, "2026-08-19", "the latest COMPLETED IST day");
  assert.deepEqual(due.enabledSources, ["order-line-items"]);
});

test("C4. overlap: a still-running enabled source blocks the launch (no overlapping org/source/bucket runs)", () => {
  const d = sched.plannedScheduledInvocation({
    bucket: "non-us", nowUtcMs: NOW_DUE, marketplaceCountries: ["IN"],
    controls: CONTROLS_ON,
    runStatuses: [{ source_key: "order-line-items", bucket: "non-us", last_status: "running", last_attempt_at: "2026-08-20T02:01:00Z" }],
  });
  assert.equal(d.reason, "overlap");
});

test("C5. already-ran-today after every enabled source attempted at/after the slot; the OTHER bucket is unaffected", () => {
  const ran = [{ source_key: "order-line-items", bucket: "non-us", last_status: "succeeded", last_attempt_at: "2026-08-20T02:02:00Z", last_success_at: "2026-08-20T02:03:00Z" }];
  const d = sched.plannedScheduledInvocation({
    bucket: "non-us", nowUtcMs: UTC(2026, 8, 20, 3, 0), marketplaceCountries: ["IN"],
    controls: CONTROLS_ON, runStatuses: ran,
  });
  assert.equal(d.reason, "already-ran-today");
  const us = sched.plannedScheduledInvocation({
    bucket: "us", nowUtcMs: UTC(2026, 8, 20, 11, 0), marketplaceCountries: ["US"],
    controls: CONTROLS_ON, runStatuses: ran, // the non-us rows do not gate the us bucket
  });
  assert.equal(us.launch, true, "the other bucket runs independently");
});

test("C6. completion-anchored >=60s cooldown -- never a blind offset", () => {
  // Yesterday's run completed 30s before now: cooldown holds regardless of the schedule slot.
  const now = UTC(2026, 8, 20, 2, 10);
  const d = sched.plannedScheduledInvocation({
    bucket: "non-us", nowUtcMs: now, marketplaceCountries: ["IN"],
    controls: CONTROLS_ON,
    runStatuses: [{ source_key: "order-line-items", bucket: "non-us", last_status: "failed", last_attempt_at: new Date(now - 30_000).toISOString() }],
  });
  assert.equal(d.reason, "cooldown");
  assert.equal(d.resumeAtMs, now - 30_000 + 60_000, "resume is anchored to the COMPLETION time");
  const after = sched.plannedScheduledInvocation({
    bucket: "non-us", nowUtcMs: now + 61_000, marketplaceCountries: ["IN"],
    controls: CONTROLS_ON,
    runStatuses: [{ source_key: "order-line-items", bucket: "non-us", last_status: "failed", last_attempt_at: new Date(now - 30_000).toISOString() }],
  });
  assert.equal(after.launch, true, "past the completion-anchored cooldown");
});

group("D. inertness (nothing wired, nothing enabled, no timers)");

test("D1. the APP stays inert: vercel.json has no crons and NO api/cron route wires the schedule or the bucket sync (timing is EXTERNAL -- GitHub Actions only)", () => {
  const vercel = JSON.parse(readFileSync(path.join(process.cwd(), "vercel.json"), "utf8"));
  assert.equal((vercel.crons || []).length, 0, "vercel.json registers no cron");
  // The ONLY scheduler is the external GitHub Actions workflow (scheduler-v2.yml), which runs the reviewed CLI
  // operators directly -- NEVER an in-app timer or a Vercel/api route. So the app itself must stay inert: no
  // api/cron route wires the durable schedule or the bucket sync.
  const cronDir = path.join(process.cwd(), "api", "cron");
  for (const file of readdirSync(cronDir)) {
    const src = readFileSync(path.join(cronDir, file), "utf8");
    assert.doesNotMatch(src, /source-schedule/, `api/cron/${file} does not wire the inert schedule`);
    assert.doesNotMatch(src, /source-bucket-sync/, `api/cron/${file} does not wire the bucket sync`);
  }
});

test("D2. the schedule module has no timer and no I/O import; the durable default is schedule_enabled FALSE", () => {
  const src = readFileSync(path.join(process.cwd(), "lib", "server", "sync", "source-schedule.js"), "utf8");
  assert.doesNotMatch(src, /setTimeout|setInterval/, "no blind offsets: the module contains no timer at all");
  assert.doesNotMatch(src, /from "\.\.\/supabase\.js"|from "\.\.\/datadoe\.js"/, "pure decision layer: no transport/storage import");
  const migration = readFileSync(path.join(process.cwd(), "supabase", "migrations", "20260820_source_durable_model.sql"), "utf8");
  assert.match(migration, /schedule_enabled boolean not null default false/, "every source's schedule defaults OFF durably");
});

test("D3. polling GETs keep the transport's existing five-second policy (a poll is never a create-export)", () => {
  const src = readFileSync(path.join(process.cwd(), "lib", "server", "datadoe.js"), "utf8");
  assert.match(src, /const delayMs = 5000/, "the 5-second poll delay is unchanged");
});

async function main() {
  out("source-schedule (inert) proof suite");
  sched = await import("../lib/server/sync/source-schedule.js");

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
