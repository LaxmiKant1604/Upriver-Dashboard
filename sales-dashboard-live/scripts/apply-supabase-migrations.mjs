import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
const migrationDir = path.join(appRoot, "supabase", "migrations");
const localEnvPath = path.resolve(appRoot, "..", ".env.local");

function parseEnv(text) {
  const values = {};
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

async function databaseUrl() {
  if (process.env.POSTGRES_URL) return process.env.POSTGRES_URL;
  const localValues = parseEnv(await readFile(localEnvPath, "utf8"));
  return localValues.POSTGRES_URL;
}

const connectionString = await databaseUrl();
if (!connectionString) {
  throw new Error("POSTGRES_URL is missing. Connect the Supabase Vercel integration, then run `vercel env pull` from the repository root.");
}

// The Vercel Marketplace pooler presents a certificate chain that Windows'
// bundled Node trust store does not recognise. `no-verify` keeps this direct
// migration connection encrypted; the deployed app itself uses HTTPS REST via
// api/supabase.js and does not use this Postgres connection.
const migrationUrl = new URL(connectionString);
migrationUrl.searchParams.set("sslmode", "no-verify");
const client = new pg.Client({ connectionString: migrationUrl.toString() });
await client.connect();

try {
  await client.query(`
    create table if not exists public.app_schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  // Optional MIGRATE_ONLY=<exact filename>: apply ONLY that migration (still ledger-guarded + idempotent), so a
  // supervised production run can widen exactly the intended migration without touching any already-applied one.
  const onlyFilter = process.env.MIGRATE_ONLY ? process.env.MIGRATE_ONLY.trim() : null;
  let files = (await readdir(migrationDir)).filter((name) => name.endsWith(".sql")).sort();
  if (onlyFilter) {
    if (!files.includes(onlyFilter)) throw new Error(`MIGRATE_ONLY="${onlyFilter}" is not a migration file under supabase/migrations (fail closed).`);
    console.log(`MIGRATE_ONLY set -> applying ONLY ${onlyFilter} (every other migration is left untouched).`);
    files = [onlyFilter];
  }
  for (const filename of files) {
    const alreadyApplied = await client.query(
      "select 1 from public.app_schema_migrations where filename = $1",
      [filename]
    );
    if (alreadyApplied.rowCount) {
      console.log(`Skipped ${filename} (already applied)`);
      continue;
    }

    const sql = await readFile(path.join(migrationDir, filename), "utf8");
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("insert into public.app_schema_migrations (filename) values ($1)", [filename]);
      await client.query("commit");
      console.log(`Applied ${filename}`);
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }

  const tables = await client.query(`
    select tablename
    from pg_tables
    where schemaname = 'public'
    order by tablename
  `);
  console.log(`Verified public tables: ${tables.rows.map((row) => row.tablename).join(", ")}`);
} finally {
  await client.end();
}
