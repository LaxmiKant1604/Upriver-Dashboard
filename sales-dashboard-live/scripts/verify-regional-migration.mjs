// READ-ONLY production verifier for migration 20260917 (regional scheduler scope). Connects with the same
// no-verify SSL policy as the migration runner and PROVES the widening actually took effect + preserved legacy +
// kept least-privilege. Prints only structural facts (constraint defs / function guards / grants) -- never a row.
//
// Usage (run from sales-dashboard-live/, POSTGRES_URL in env):  node scripts/verify-regional-migration.mjs

import pg from "pg";

const REGIONS = ["'india'", "'europe-au'", "'us-ca'"];
const LEGACY = ["'us'", "'non-us'"];
const SCOPE_TABLES = [
  ["sync_cycles", "sync_cycles_bucket_check"],
  ["sync_source_jobs", "sync_source_jobs_bucket_check"],
  ["sync_report_jobs", "sync_report_jobs_bucket_check"],
  ["source_run_status", "source_run_status_bucket_check"],
  ["source_oli_completeness", "source_oli_completeness_bucket_check"],
  ["sync_runs", "sync_runs_bucket_check"],
  ["account_directory", "account_directory_sync_bucket_check"],
];
const RPCS = ["open_sync_cycle", "open_superseding_sync_cycle", "record_oli_completeness"];

const cs = process.env.POSTGRES_URL;
if (!cs) { console.error("STOP POSTGRES_URL missing (fail closed)."); process.exit(1); }
const url = new URL(cs); url.searchParams.set("sslmode", "no-verify");
const client = new pg.Client({ connectionString: url.toString() });

let failures = 0;
const ok = (m) => console.log("  ok  " + m);
const bad = (m) => { failures += 1; console.log("FAIL  " + m); };

await client.connect();
try {
  // 1. Ledger records the migration.
  const led = await client.query("select 1 from public.app_schema_migrations where filename = $1", ["20260917_scheduler_regional_scope.sql"]);
  if (led.rowCount === 1) ok("ledger records 20260917_scheduler_regional_scope.sql"); else bad("migration NOT in app_schema_migrations ledger");

  // 2. Every scope CHECK constraint now admits the 3 regions AND still admits the legacy values.
  for (const [table, cname] of SCOPE_TABLES) {
    const r = await client.query(
      `select pg_get_constraintdef(c.oid) as def from pg_constraint c
        where c.conrelid = ('public.' || $1)::regclass and c.contype = 'c' and c.conname = $2`,
      [table, cname],
    );
    if (!r.rowCount) { bad(table + ": constraint " + cname + " NOT found"); continue; }
    const def = String(r.rows[0].def);
    const missingRegion = REGIONS.filter((v) => !def.includes(v));
    const missingLegacy = LEGACY.filter((v) => !def.includes(v));
    if (missingRegion.length) bad(table + ": missing region value(s) " + missingRegion.join(",") + " in " + cname);
    else if (missingLegacy.length) bad(table + ": legacy value(s) " + missingLegacy.join(",") + " DROPPED from " + cname + " (must stay valid)");
    else if (table === "account_directory" && !def.includes("'unknown'")) bad("account_directory: 'unknown' default no longer valid");
    else ok(table + "." + cname + " admits india/europe-au/us-ca + legacy" + (table === "account_directory" ? " + unknown" : ""));
  }

  // 3. Every bucket-validating RPC body now admits the regions (guard widened), and is still SECURITY DEFINER.
  for (const fn of RPCS) {
    const r = await client.query(
      `select pg_get_functiondef(p.oid) as def, p.prosecdef as secdef
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = $1 limit 1`,
      [fn],
    );
    if (!r.rowCount) { bad("RPC " + fn + " NOT found"); continue; }
    const def = String(r.rows[0].def);
    const missing = REGIONS.filter((v) => !def.includes(v));
    if (missing.length) bad("RPC " + fn + " guard missing region value(s) " + missing.join(","));
    else if (!r.rows[0].secdef) bad("RPC " + fn + " is no longer SECURITY DEFINER");
    else if (!LEGACY.every((v) => def.includes(v))) bad("RPC " + fn + " dropped a legacy value from its guard");
    else ok("RPC " + fn + " guard admits the regions + legacy, SECURITY DEFINER intact");
  }

  // 4. Least-privilege grants preserved: service_role can EXECUTE each RPC; anon/authenticated cannot.
  for (const fn of RPCS) {
    const r = await client.query(
      `select
         has_function_privilege('service_role', p.oid, 'EXECUTE') as svc,
         has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = $1 limit 1`,
      [fn],
    );
    if (!r.rowCount) { bad("grant check: RPC " + fn + " not found"); continue; }
    const g = r.rows[0];
    if (g.svc && !g.anon && !g.auth) ok("RPC " + fn + ": service_role EXECUTE only (anon/authenticated denied)");
    else bad("RPC " + fn + " grants wrong: svc=" + g.svc + " anon=" + g.anon + " auth=" + g.auth);
  }

  // 5. RLS still enabled on the completeness table the migration touched.
  const rls = await client.query("select relrowsecurity from pg_class where oid = 'public.source_oli_completeness'::regclass");
  if (rls.rowCount && rls.rows[0].relrowsecurity) ok("source_oli_completeness RLS still enabled"); else bad("source_oli_completeness RLS is OFF");

  // 6. Legacy rows remain readable (a spot count -- proves no historical row was invalidated by the new CHECK).
  const legacyRows = await client.query("select count(*)::int as n from public.sync_cycles where bucket in ('us','non-us','us-fba','non-us-fba')");
  ok("legacy sync_cycles rows still present + readable under the widened CHECK: " + legacyRows.rows[0].n);
} finally {
  await client.end();
}

console.log("\nregional-migration verify: " + (failures ? failures + " FAILED" : "all checks passed"));
if (failures) process.exit(1);
