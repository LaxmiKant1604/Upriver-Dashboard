// Migration 20260918 (Listing Health v3 dedicated cycle bucket) -- LEAST-PRIVILEGE proof.
//
// Static analysis of the frozen migration SQL (the same offline style as scheduler-scope.test.js): it proves the
// migration touches ONLY sync_cycles_bucket_check + open_sync_cycle, preserves all ten existing buckets and appends
// exactly the three v3 cycle namespaces, rejects any unknown bucket, drops the constraint by EXACT name (never a
// dynamic drop), enforces least-privilege grants on the RPC, is idempotent, and ships an exact rollback that refuses
// while v3 rows remain. 7-bit ASCII, LF. ZERO DB/network.

import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "listing-health-v3-cycle-bucket-migration\n");

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const FILE = "supabase/migrations/20260918_listing_health_v3_cycle_bucket.sql";
const full = readFileSync(path.join(root, FILE), "utf8");

const LEGACY = ["us", "non-us", "us-fba", "non-us-fba", "india", "europe-au", "us-ca", "india-fba", "europe-au-fba", "us-ca-fba"];
const V3 = ["listing-health-v3-india", "listing-health-v3-europe-au", "listing-health-v3-us-ca"];
const EXPECTED = [...LEGACY, ...V3];
const OTHER_TABLES = ["sync_source_jobs", "sync_report_jobs", "source_run_status", "source_oli_completeness", "sync_runs", "account_directory"];

// Split the file at the ROLLBACK marker; strip ALL comments from the forward section to get pure executable SQL.
const rollbackIdx = full.indexOf("ROLLBACK (MANUAL");
assert.ok(rollbackIdx > 0, "the file has a ROLLBACK (MANUAL ...) section");
const forwardRaw = full.slice(0, rollbackIdx);
const rollbackRaw = full.slice(rollbackIdx);
const stripComments = (sql) => sql.split(/\r?\n/).map((l) => { const i = l.indexOf("--"); return i >= 0 ? l.slice(0, i) : l; }).join("\n");
const exec = stripComments(forwardRaw).toLowerCase();
// Uncomment the rollback block (strip a leading "-- " / "--") so its statements can be analysed.
const rollback = rollbackRaw.split(/\r?\n/).map((l) => l.replace(/^\s*--\s?/, "")).join("\n").toLowerCase();

// Extract every quoted-value list from an `in ( ... )` clause.
const allowlistsIn = (sql) => [...sql.matchAll(/\bin\s*\(([^)]*)\)/g)].map((m) => [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]));

/* ===================== A. allowlist: existing preserved + three v3 appended, nothing else ===================== */
(() => {
  const lists = allowlistsIn(exec);
  ok("A: the forward SQL has exactly two allow-lists (the CHECK + the RPC guard)", lists.length === 2);
  for (const [i, list] of lists.entries()) {
    const set = new Set(list);
    ok(`A[${i}]: all ten existing buckets remain accepted`, LEGACY.every((b) => set.has(b)));
    ok(`A[${i}]: all three v3 cycle buckets are accepted`, V3.every((b) => set.has(b)));
    ok(`A[${i}]: an unknown bucket is rejected (not present) and the list is exactly the 13 expected`, !set.has("bogus-bucket") && set.size === 13 && [...set].sort().join() === [...EXPECTED].sort().join());
  }
  ok("A: the CHECK allow-list and the RPC guard allow-list are IDENTICAL", JSON.stringify(lists[0].slice().sort()) === JSON.stringify(lists[1].slice().sort()));
})();

/* ===================== B. least privilege: only sync_cycles + open_sync_cycle are modified ===================== */
(() => {
  const alters = [...exec.matchAll(/alter\s+table\s+([a-z0-9_.]+)/g)].map((m) => m[1]);
  ok("B: exactly two ALTER TABLE statements, both on public.sync_cycles (drop + re-add)", alters.length === 2 && alters.every((t) => t === "public.sync_cycles"));
  const fns = [...exec.matchAll(/create\s+or\s+replace\s+function\s+([a-z0-9_.]+)/g)].map((m) => m[1]);
  ok("B: exactly ONE create-or-replace function, and it is public.open_sync_cycle", fns.length === 1 && fns[0] === "public.open_sync_cycle");
  ok("B: NONE of the other scheduler tables are referenced in the forward SQL", OTHER_TABLES.every((t) => !exec.includes(t)));
})();

/* ===================== C. exact-name drop (never a dynamic drop of every bucket CHECK) ===================== */
(() => {
  ok("C: the constraint is dropped by EXACT name with IF EXISTS", /drop\s+constraint\s+if\s+exists\s+sync_cycles_bucket_check/.test(exec));
  ok("C: it re-adds the named constraint sync_cycles_bucket_check", /add\s+constraint\s+sync_cycles_bucket_check/.test(exec));
  ok("C: NO dynamic constraint discovery (no pg_constraint / execute format / DO-block loop)", !exec.includes("pg_constraint") && !exec.includes("execute format") && !/do\s*\$\$[\s\S]*for\s+cname/.test(exec));
})();

/* ===================== D. least-privilege grants explicitly enforced on the RPC ===================== */
(() => {
  ok("D: public / anon / authenticated are REVOKEd from open_sync_cycle", /revoke\s+all\s+on\s+function\s+public\.open_sync_cycle\([^)]*\)\s+from\s+public,\s*anon,\s*authenticated/.test(exec));
  ok("D: EXECUTE is granted ONLY to service_role", /grant\s+execute\s+on\s+function\s+public\.open_sync_cycle\([^)]*\)\s+to\s+service_role/.test(exec));
  ok("D: no grant to public / anon / authenticated exists", !/grant\s+execute[^;]*to\s+(public|anon|authenticated)/.test(exec));
})();

/* ===================== E. idempotency + safety (no destructive statements) ===================== */
(() => {
  ok("E: idempotent CHECK swap (drop-if-exists + add) and create-or-replace RPC", /drop\s+constraint\s+if\s+exists/.test(exec) && /create\s+or\s+replace\s+function/.test(exec));
  ok("E: no destructive DDL/DML in the forward SQL (no drop table/delete/truncate/rename)", !/drop\s+table/.test(exec) && !/delete\s+from/.test(exec) && !/truncate/.test(exec) && !/rename/.test(exec));
  // The RPC body must stay byte-identical to 20260917 except the guard: same insert + same conflict target + same coalesce.
  ok("E: the RPC body is preserved (same insert + conflict target + trigger default)", /insert\s+into\s+public\.sync_cycles/.test(exec) && exec.includes("on conflict (bucket, cycle_date) where supersedes_cycle_id is null") && exec.includes("coalesce(p_trigger, 'pg_cron')"));
})();

/* ===================== F. rollback: refuses while v3 rows remain, then narrows back to the ten ===================== */
(() => {
  ok("F: the rollback REFUSES if any sync_cycles row still uses a listing-health-v3-* bucket", rollback.includes("rollback refused") && /where\s+bucket\s+like\s+'listing-health-v3-%'/.test(rollback));
  const rlists = allowlistsIn(rollback);
  ok("F: the rollback narrows BOTH allow-lists back to exactly the ten legacy buckets", rlists.length >= 2 && rlists.every((l) => new Set(l).size === 10 && LEGACY.every((b) => l.includes(b)) && !V3.some((b) => l.includes(b))));
  ok("F: the rollback re-enforces the same least-privilege grants", /revoke\s+all\s+on\s+function\s+public\.open_sync_cycle/.test(rollback) && /grant\s+execute\s+on\s+function\s+public\.open_sync_cycle[^;]*to\s+service_role/.test(rollback));
})();

writeSync(1, `\nlisting-health-v3-cycle-bucket-migration: ${passed} assertions passed\n`);
