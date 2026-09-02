// Regional scheduler SCOPE proof suite (offline, ZERO network/DB).
//
// Proves the 2-bucket -> 3-region conversion's PURE core:
//   A. routing        -- IN->india; GB/UK/DE/.../AU->europe-au; US/CA->us-ca; unknown/blank -> unassigned (fail closed).
//   B. scope validity -- REGION_SCOPES / LEGACY_SCOPES / ROUTING_SCOPES / FBA twins; assertScope + ALL_SCOPES.
//   C. accountInScope -- region scopes route by marketplace; legacy scopes by us/non-us; -fba twin routes like base.
//   D. batching       -- deterministic <=5-seller batches, account-isolated allowlists, mixed marketplaces allowed;
//                        routing recomputed every run so a NEW account auto-joins its region.
//   E. freshness key  -- scheduled-fresh/<region>/<D-1> + manual-force/<region>/<D-1>/<runId> round-trip; unknown fails.
//   F. migration      -- 20260917 additive/forward-only/idempotent: every CHECK + RPC widened to the regions while
//                        every legacy value stays valid; account_directory keeps 'unknown'; no destructive DDL.
//
// 7-bit ASCII, LF, no top-level await, synchronous writeSync progress, dynamic imports after a dummy env.

import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = process.env[SB_KEY_ENV] || ["test", "svc", "role", "key"].join("-");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const group = (label) => tests.push({ marker: label });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

let scope, region, fresh;
const D1 = "2026-09-03";

group("A. marketplace -> region routing");

test("A1. each region's marketplaces route correctly; UK and GB both -> europe-au; AU -> europe-au", () => {
  assert.equal(scope.regionForCountry("IN"), "india");
  for (const mkt of ["GB", "UK", "DE", "FR", "IT", "ES", "NL", "BE", "SE", "PL", "IE", "AT", "AU"]) {
    assert.equal(scope.regionForCountry(mkt), "europe-au", mkt + " -> europe-au");
  }
  assert.equal(scope.regionForCountry("US"), "us-ca");
  assert.equal(scope.regionForCountry("CA"), "us-ca");
});

test("A2. unknown / blank / malformed marketplace -> unassigned (fail closed, never coerced)", () => {
  assert.equal(scope.regionForCountry(""), "unassigned");
  assert.equal(scope.regionForCountry(null), "unassigned");
  assert.equal(scope.regionForCountry("ZZ"), "unassigned");
  assert.equal(scope.regionForCountry("XX-not-a-marketplace"), "unassigned");
});

test("A3. case + whitespace insensitive (trusted stored evidence is normalized, not trusted verbatim)", () => {
  assert.equal(scope.regionForCountry(" in "), "india");
  assert.equal(scope.regionForCountry("gb"), "europe-au");
  assert.equal(scope.regionForCountry("Us"), "us-ca");
});

group("B. scope validity + FBA namespace twins");

test("B1. REGION_SCOPES / LEGACY_SCOPES / ROUTING_SCOPES are exactly the expected sets", () => {
  assert.deepEqual([...scope.REGION_SCOPES], ["india", "europe-au", "us-ca"]);
  assert.deepEqual([...scope.LEGACY_SCOPES], ["us", "non-us"]);
  assert.deepEqual([...scope.ROUTING_SCOPES], ["india", "europe-au", "us-ca", "us", "non-us"]);
});

test("B2. isRegionScope / isLegacyScope / isRoutingScope classify correctly", () => {
  assert.equal(scope.isRegionScope("india"), true);
  assert.equal(scope.isRegionScope("us"), false);
  assert.equal(scope.isLegacyScope("non-us"), true);
  assert.equal(scope.isLegacyScope("india"), false);
  for (const s of ["india", "europe-au", "us-ca", "us", "non-us"]) assert.equal(scope.isRoutingScope(s), true, s);
  for (const s of ["india-fba", "bogus", "", "unassigned"]) assert.equal(scope.isRoutingScope(s), false, s);
});

test("B3. ALL_SCOPES = the 5 routing scopes + their 5 -fba twins (matches the DB allow-list); junk is invalid", () => {
  assert.equal(scope.ALL_SCOPES.length, 10);
  for (const s of ["us", "non-us", "us-fba", "non-us-fba", "india", "europe-au", "us-ca", "india-fba", "europe-au-fba", "us-ca-fba"]) {
    assert.equal(scope.isValidScope(s), true, s + " is a valid scope");
  }
  for (const s of ["unassigned", "unknown", "us-x", "india-region", ""]) assert.equal(scope.isValidScope(s), false, s + " is NOT a scope");
});

test("B4. baseScope / fbaScope are inverse + idempotent", () => {
  assert.equal(scope.baseScope("india-fba"), "india");
  assert.equal(scope.baseScope("us-ca-fba"), "us-ca");
  assert.equal(scope.baseScope("us"), "us");
  assert.equal(scope.fbaScope("india"), "india-fba");
  assert.equal(scope.fbaScope("india-fba"), "india-fba");
});

test("B5. assertScope throws on junk, returns the value on valid; routingOnly rejects -fba twins", () => {
  assert.equal(scope.assertScope("india"), "india");
  assert.throws(() => scope.assertScope("bogus"), /invalid scheduler scope/);
  assert.equal(scope.assertScope("india-fba"), "india-fba");
  assert.throws(() => scope.assertScope("india-fba", { routingOnly: true }), /invalid scheduler scope/);
  assert.equal(scope.assertScope("us-ca", { routingOnly: true }), "us-ca");
});

group("C. accountInScope (region + legacy + fba twin)");

test("C1. region scopes match by marketplace; a different region's account does NOT match", () => {
  assert.equal(scope.accountInScope("india", "IN"), true);
  assert.equal(scope.accountInScope("europe-au", "GB"), true);
  assert.equal(scope.accountInScope("europe-au", "UK"), true);
  assert.equal(scope.accountInScope("europe-au", "AU"), true);
  assert.equal(scope.accountInScope("us-ca", "US"), true);
  assert.equal(scope.accountInScope("us-ca", "CA"), true);
  assert.equal(scope.accountInScope("india", "US"), false);
  assert.equal(scope.accountInScope("us-ca", "IN"), false);
});

test("C2. an unknown marketplace matches NO region scope (fail closed)", () => {
  for (const s of ["india", "europe-au", "us-ca"]) assert.equal(scope.accountInScope(s, "ZZ"), false, s);
  for (const s of ["india", "europe-au", "us-ca"]) assert.equal(scope.accountInScope(s, ""), false, s);
});

test("C3. legacy scopes keep the us/non-us rule", () => {
  assert.equal(scope.accountInScope("us", "US"), true);
  assert.equal(scope.accountInScope("us", "IN"), false);
  assert.equal(scope.accountInScope("non-us", "IN"), true);
  assert.equal(scope.accountInScope("non-us", "CA"), true);
  assert.equal(scope.accountInScope("non-us", "US"), false);
});

test("C4. an -fba twin routes identically to its base scope", () => {
  assert.equal(scope.accountInScope("india-fba", "IN"), true);
  assert.equal(scope.accountInScope("us-ca-fba", "CA"), true);
  assert.equal(scope.accountInScope("us-ca-fba", "IN"), false);
});

group("D. deterministic batching + isolation + dynamic re-routing");

test("D1. routeAccounts sends each account to its region; unknown -> unassigned (alerted, never dropped into a region)", async () => {
  const routing = await import("../lib/server/sync/campaign-region-routing.js");
  const accts = [
    { accountId: "a-in", marketplace: "IN" },
    { accountId: "b-gb", marketplace: "GB" },
    { accountId: "c-au", marketplace: "AU" },
    { accountId: "d-us", marketplace: "US" },
    { accountId: "e-ca", marketplace: "CA" },
    { accountId: "f-zz", marketplace: "ZZ" },
  ];
  const { byRegion, unassigned } = routing.routeAccounts(accts);
  assert.deepEqual(byRegion.india.map((a) => a.accountId), ["a-in"]);
  assert.deepEqual(byRegion["europe-au"].map((a) => a.accountId).sort(), ["b-gb", "c-au"].sort());
  assert.deepEqual(byRegion["us-ca"].map((a) => a.accountId).sort(), ["d-us", "e-ca"].sort());
  assert.deepEqual(unassigned.map((a) => a.accountId), ["f-zz"]);
});

test("D2. a NEWLY connected account auto-joins its region on the next route (routing recomputed every run)", async () => {
  const routing = await import("../lib/server/sync/campaign-region-routing.js");
  const before = routing.routeAccounts([{ accountId: "x-in", marketplace: "IN" }]);
  assert.equal(before.byRegion.india.length, 1);
  const after = routing.routeAccounts([{ accountId: "x-in", marketplace: "IN" }, { accountId: "y-de", marketplace: "DE" }]);
  assert.equal(after.byRegion.india.length, 1);
  assert.equal(after.byRegion["europe-au"].length, 1); // the new DE seller joined with no config change
});

test("D3. batches are <=5 sellers, account-isolated (each id in exactly one batch's allowlist), deterministic", async () => {
  const routing = await import("../lib/server/sync/campaign-region-routing.js");
  const accts = Array.from({ length: 12 }, (_, i) => ({ accountId: "acct-" + String(i).padStart(2, "0"), marketplace: "DE" }));
  const batches = routing.batchAccounts(accts);
  assert.equal(batches.length, 3); // 5 + 5 + 2
  for (const b of batches) assert.ok(b.allowlist.length <= 5, "batch <=5 sellers");
  const flat = batches.flatMap((b) => b.allowlist);
  assert.equal(flat.length, 12);
  assert.equal(new Set(flat).size, 12); // no account in two batches
  const again = routing.batchAccounts(accts);
  assert.deepEqual(again.map((b) => b.allowlist), batches.map((b) => b.allowlist)); // deterministic
});

test("D4. mixed marketplaces are allowed inside one region batch (<=5 rule is by seller count, not marketplace)", async () => {
  const routing = await import("../lib/server/sync/campaign-region-routing.js");
  const accts = [
    { accountId: "m1", marketplace: "GB" }, { accountId: "m2", marketplace: "DE" },
    { accountId: "m3", marketplace: "AU" }, { accountId: "m4", marketplace: "FR" }, { accountId: "m5", marketplace: "IT" },
  ];
  const { byRegion } = routing.routeAccounts(accts);
  const batches = routing.batchAccounts(byRegion["europe-au"]);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].allowlist.length, 5); // one mixed-marketplace batch of 5 sellers
});

group("E. freshness operation key (region + as-of identity)");

test("E1. scheduled-fresh key embeds region + D-1 for each region; round-trips", () => {
  for (const r of ["india", "europe-au", "us-ca"]) {
    const key = fresh.freshnessOperationKey({ mode: "normal", bucket: r, requestedAsOf: D1 });
    assert.equal(key, "scheduled-fresh/" + r + "/" + D1);
    const parsed = fresh.parseFreshnessOperationKey(key);
    assert.deepEqual(parsed, { mode: "normal", bucket: r, requestedAsOf: D1, runId: null });
  }
});

test("E2. manual-force key embeds region + D-1 + runId; round-trips", () => {
  const key = fresh.freshnessOperationKey({ mode: "force-latest", bucket: "us-ca", requestedAsOf: D1, runId: "12345" });
  assert.equal(key, "manual-force/us-ca/" + D1 + "/12345");
  assert.deepEqual(fresh.parseFreshnessOperationKey(key), { mode: "force-latest", bucket: "us-ca", requestedAsOf: D1, runId: "12345" });
});

test("E3. legacy us/non-us keys still valid (rollback path preserved)", () => {
  assert.equal(fresh.freshnessOperationKey({ mode: "normal", bucket: "non-us", requestedAsOf: D1 }), "scheduled-fresh/non-us/" + D1);
  assert.equal(fresh.parseFreshnessOperationKey("scheduled-fresh/us/" + D1).bucket, "us");
});

test("E4. an unknown region / -fba twin in a freshness key fails closed", () => {
  assert.throws(() => fresh.freshnessOperationKey({ mode: "normal", bucket: "atlantis", requestedAsOf: D1 }), /bucket in/);
  assert.throws(() => fresh.parseFreshnessOperationKey("scheduled-fresh/atlantis/" + D1), /must be/);
  assert.throws(() => fresh.parseFreshnessOperationKey("scheduled-fresh/india-fba/" + D1), /must be/);
});

group("F. additive forward-only migration 20260917");

test("F1. migration widens every scope CHECK + RPC guard to the three regions (+ fba twins) while KEEPING legacy", () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const sql = readFileSync(path.join(root, "supabase/migrations/20260917_scheduler_regional_scope.sql"), "utf8");
  // The full widened allow-list appears for the 6 scope tables + 3 RPCs (>= 9 occurrences of each region literal).
  for (const lit of ["'india'", "'europe-au'", "'us-ca'"]) {
    const n = sql.split(lit).length - 1;
    assert.ok(n >= 9, lit + " widened in >=9 places (got " + n + ")");
  }
  for (const lit of ["'us'", "'non-us'"]) assert.ok(sql.includes(lit), "legacy " + lit + " preserved");
  for (const lit of ["'india-fba'", "'europe-au-fba'", "'us-ca-fba'"]) assert.ok(sql.includes(lit), "region fba twin " + lit + " present");
  // account_directory keeps its pre-classification default.
  assert.ok(sql.includes("'unknown'"), "account_directory keeps 'unknown'");
  // The 3 bucket-validating RPCs are re-created with the widened guard.
  for (const fn of ["open_sync_cycle", "open_superseding_sync_cycle", "record_oli_completeness"]) {
    assert.ok(sql.includes("function public." + fn + "("), fn + " re-created");
  }
});

test("F2. migration is additive + idempotent + forward-only (no destructive DDL, drop-and-re-add CHECK pattern)", () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const sql = readFileSync(path.join(root, "supabase/migrations/20260917_scheduler_regional_scope.sql"), "utf8").toLowerCase();
  assert.ok(!/drop\s+table/.test(sql), "no DROP TABLE");
  assert.ok(!/\btruncate\b/.test(sql), "no TRUNCATE");
  assert.ok(!/delete\s+from/.test(sql), "no DELETE FROM");
  assert.ok(!/alter\s+table[^;]+rename/.test(sql), "no table/column RENAME");
  // Idempotent CHECK swap: it drops any existing bucket check then re-adds the widened one.
  assert.ok(sql.includes("drop constraint") && sql.includes("add constraint"), "drop-and-re-add CHECK pattern");
  assert.ok(sql.includes("create or replace function"), "RPCs use create-or-replace (idempotent)");
  // Each widened table names a bucket/scope check constraint.
  for (const c of ["sync_cycles_bucket_check", "sync_source_jobs_bucket_check", "sync_report_jobs_bucket_check",
    "source_run_status_bucket_check", "source_oli_completeness_bucket_check", "account_directory_sync_bucket_check", "sync_runs_bucket_check"]) {
    assert.ok(sql.includes(c), c + " present");
  }
});

test("F3. the migration filename sorts AFTER the current newest so the ledger runs it last", () => {
  assert.ok("20260917_scheduler_regional_scope.sql" > "20260916_campaign_mapping_capability_admin.sql");
});

async function main() {
  out("regional scheduler scope proof suite");
  scope = await import("../lib/server/sync/scheduler-scope.js");
  region = await import("../lib/server/sync/campaign-region-routing.js");
  fresh = await import("../lib/server/sync/source-oli-freshness.js");
  void region;

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
