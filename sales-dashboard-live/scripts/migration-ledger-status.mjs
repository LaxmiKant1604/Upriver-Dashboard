// READ-ONLY migration ledger status. Prints which supabase/migrations/*.sql files are recorded in
// public.app_schema_migrations and which are NOT, so a supervised apply can see the exact state before acting.
// Never applies anything. Usage (from sales-dashboard-live/, POSTGRES_URL in env):
//   node scripts/migration-ledger-status.mjs

import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationDir = path.join(path.resolve(here, ".."), "supabase", "migrations");

const cs = process.env.POSTGRES_URL;
if (!cs) { console.error("STOP POSTGRES_URL missing (fail closed)."); process.exit(1); }
const url = new URL(cs); url.searchParams.set("sslmode", "no-verify");
const client = new pg.Client({ connectionString: url.toString() });

await client.connect();
try {
  await client.query("create table if not exists public.app_schema_migrations (filename text primary key, applied_at timestamptz not null default now())");
  const files = (await readdir(migrationDir)).filter((n) => n.endsWith(".sql")).sort();
  const ledger = new Set((await client.query("select filename from public.app_schema_migrations")).rows.map((r) => r.filename));
  const unledgered = files.filter((f) => !ledger.has(f));
  console.log("repo migrations: " + files.length + " | ledgered: " + files.filter((f) => ledger.has(f)).length + " | UNLEDGERED: " + unledgered.length);
  for (const f of files) console.log((ledger.has(f) ? "  applied   " : "  UNLEDGERED") + "  " + f);
  if (unledgered.length) console.log("\nUNLEDGERED (a full db:migrate would apply these in order): " + unledgered.join(", "));
} finally {
  await client.end();
}
