// Publication recovery WP15 -- REAL SQL self-test of the DB-enforced report writer fence (supabase/migrations/20260935)
// in an in-process Postgres (PGlite, WASM). NEVER touches a real database.
//
// It builds a minimal report_snapshots world from the REAL migration text (the 20260728 table VERBATIM -- including its
// created_by FK to auth.users ON DELETE SET NULL, over a minimal auth.users -- + touch trigger, the 20260919
// control_plane_lease table + the fenced CAS, the 20260822 unfenced CAS, the 20260805 scheduler-v1 prune RPC), applies
// 20260935 (twice: idempotent), and proves:
//   fence OFF -> a legacy upsert / update / delete / unfenced CAS behave exactly as today;
//   fence ON  -> every legacy path (merge-upsert, ignore-duplicates insert, PATCH, key-moving UPDATE, DELETE, the
//                unfenced CAS even when it would not write, the v1 prune RPC, TRUNCATE) fails with SQLSTATE RWF01 and
//                'REPORT_WRITER_FENCED:<key>' and the live row stays byte-identical (last-known-good);
//   the ONE exemption: deleting a dashboard user (the ON DELETE SET NULL referential UPDATE of created_by) succeeds on
//                a fenced key with every other column byte-identical (updated_at restored); any other change is refused;
//   the fenced CAS (valid lease) still inserts / replaces; a lease-lost fenced call never marks its transaction;
//   the mark does NOT leak into a NEW transaction; shadow (scheduler-v2/*) and unfenced keys are unaffected; the table
//   refuses a shadow key; a re-apply never resets a flipped key; grants are least-privilege; writes as service_role are
//   fenced; the ROLLBACK restores the 20260919 function body EXACTLY (and re-opens unfenced writes, as documented).
//
//   npm install --prefix /tmp/pglite @electric-sql/pglite@0.5.8   # once, outside the repo (no package.json change)
//   PRW_PGLITE_DIR=/tmp/pglite node scripts/worker/report-writer-fence-selftest.mjs
//
// Exit 0 = all assertions pass; 1 = a failure; 3 = PGlite not available (SKIPPED -- not a pass). 7-bit ASCII, LF.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..", "..");
const dir = process.env.PRW_PGLITE_DIR;
const entry = dir ? path.join(dir, "node_modules", "@electric-sql", "pglite", "dist", "index.js") : null;
let PGlite;
try { ({ PGlite } = await import(entry && existsSync(entry) ? pathToFileURL(entry).href : "@electric-sql/pglite")); }
catch { console.log("SKIPPED: PGlite not available (set PRW_PGLITE_DIR; see header). This is NOT a pass."); process.exit(3); }

let passed = 0, failed = 0;
const ok = (name, cond) => { if (cond) { passed += 1; console.log("  ok " + name); } else { failed += 1; console.log("  FAIL " + name); } };
const mig = (f) => readFileSync(path.join(appRoot, "supabase", "migrations", f), "utf8").replace(/\r\n/g, "\n");
const FENCE_SQL = mig("20260935_report_publication_writer_fence.sql");
const ROLLBACK_SQL = readFileSync(path.join(appRoot, "deploy", "publication-recovery", "ROLLBACK_20260935.sql"), "utf8").replace(/\r\n/g, "\n");
// The operator SQL of README section 9 ("Writer fence cutover"), each block marked `<!-- wp15-sql:<name> -->`: executed
// here VERBATIM (placeholders substituted) so the documented checks are proven on real Postgres.
const README = readFileSync(path.join(appRoot, "deploy", "publication-recovery", "README.md"), "utf8").replace(/\r\n/g, "\n");
const readmeSql = (name) => {
  const m = README.match(new RegExp("<!-- wp15-sql:" + name + " -->\\n[ ]*```sql\\n([\\s\\S]*?)\\n[ ]*```"));
  if (!m) throw new Error("self-test: README block wp15-sql:" + name + " not found");
  return m[1].split("\n").map((l) => l.replace(/^ {0,5}/, "")).join("\n");
};

// Extract ONE statement verbatim from a migration: from `startMarker` to the first `endMarker` after it (inclusive).
function extract(sql, startMarker, endMarker) {
  const a = sql.indexOf(startMarker);
  if (a < 0) throw new Error("self-test: marker not found: " + startMarker);
  const b = sql.indexOf(endMarker, a);
  if (b < 0) throw new Error("self-test: end marker not found after: " + startMarker);
  return sql.slice(a, b + endMarker.length);
}
const M0728 = mig("20260728_shared_dashboard.sql");
const M0805 = mig("20260805_scheduled_sync.sql");
const M0822 = mig("20260822_report_derive_lease.sql");
const M0919 = mig("20260919_account_onboarding.sql");
const TOUCH = extract(M0728, "create or replace function public.touch_updated_at()", "\n$$;");
// The REAL 20260728 table definition VERBATIM, including created_by uuid references auth.users (id) ON DELETE SET NULL
// (PGlite has no auth schema, so a minimal auth.users(id) is created first): deleting a dashboard user fires that
// referential UPDATE through the fence trigger, exactly as in production.
const SNAP_TABLE = extract(M0728, "create table public.report_snapshots (", "\n);");
if (!SNAP_TABLE.includes("created_by uuid references auth.users (id) on delete set null,")) throw new Error("self-test: the 20260728 created_by FK changed; re-review the created_by exemption");
const SNAP_TOUCH = extract(M0728, "create trigger report_snapshots_touch_updated_at", "execute function public.touch_updated_at();");
const PRUNE = extract(M0805, "create or replace function public.prune_scheduled_report_snapshots(", "\n$$;");
const CAS = extract(M0822, "create or replace function public.cas_report_snapshot_if_newer(", "\n$$;");
const LEASE_TABLE = extract(M0919, "create table if not exists public.control_plane_lease (", "\n);");
const FENCED_CAS_0919 = extract(M0919, "create or replace function public.cas_report_snapshot_if_newer_fenced(", "\n$$;");
const ADDED_LINE = "  perform set_config('app.report_publication_fenced', 'on', true);";

const db = new PGlite();
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];
// Run `sql` expecting a failure; returns { code, message } of the error (null when it did NOT fail).
const fails = async (sql, params = []) => { try { await db.query(sql, params); return null; } catch (e) { return { code: e.code, message: String(e.message || "") }; } };
const fencedErr = (e, key) => !!e && e.code === "RWF01" && e.message === "REPORT_WRITER_FENCED:" + key;
const prosrc = async (name) => (await one("select prosrc from pg_proc where proname = $1", [name])).prosrc;

await db.exec("create role anon nologin; create role authenticated nologin; create role service_role nologin;");
await db.exec("create extension if not exists pgcrypto;").catch(() => {});
await db.exec("create table public.app_schema_migrations (filename text primary key, applied_at timestamptz not null default now());");
await db.exec("create schema auth; create table auth.users (id uuid primary key);");
await db.exec(TOUCH + "\n" + SNAP_TABLE + ";\n" + SNAP_TOUCH + "\n" + PRUNE + "\n" + CAS + "\n" + LEASE_TABLE + ";\n" + FENCED_CAS_0919);
// Supabase grants service_role full DML on public tables; mirror that for report_snapshots (the writer surface).
await db.exec("grant all on table public.report_snapshots to service_role; grant execute on function public.cas_report_snapshot_if_newer(text, text, text, jsonb, jsonb, text, bigint, timestamptz) to service_role; grant execute on function public.prune_scheduled_report_snapshots(text, text, text) to service_role;");
const ORIGINAL_FENCED_SRC = await prosrc("cas_report_snapshot_if_newer_fenced");

// ---- legacy writers exactly as the application issues them -----------------------------------------------------------
// saveReportSnapshot = PostgREST merge-duplicates upsert (INSERT ... ON CONFLICT DO UPDATE).
const legacyUpsert = (key, acct, hash, payload, at) => db.query(
  "insert into public.report_snapshots (report_key, account_id, params_hash, params, payload, payload_bytes, source_refreshed_at) values ($1,$2,$3,'{}'::jsonb,$4::jsonb,0,$5::timestamptz) "
  + "on conflict (report_key, account_id, params_hash) do update set params = excluded.params, payload = excluded.payload, source_refreshed_at = excluded.source_refreshed_at",
  [key, acct, hash, JSON.stringify(payload), at]);
// insertReportSnapshotIfAbsent / publishLiveSnapshotIfNewer step 1 = ignore-duplicates (ON CONFLICT DO NOTHING).
const legacyInsertIgnore = (key, acct, hash, payload, at) => db.query(
  "insert into public.report_snapshots (report_key, account_id, params_hash, params, payload, payload_bytes, source_refreshed_at) values ($1,$2,$3,'{}'::jsonb,$4::jsonb,0,$5::timestamptz) on conflict (report_key, account_id, params_hash) do nothing",
  [key, acct, hash, JSON.stringify(payload), at]);
// publishLiveSnapshotIfNewer step 2 / casUpdateReportSnapshotByRev = PATCH (UPDATE ... WHERE natural key).
const legacyPatch = (key, acct, hash, payload, at) => db.query(
  "update public.report_snapshots set payload = $4::jsonb, source_refreshed_at = $5::timestamptz where report_key = $1 and account_id = $2 and params_hash = $3",
  [key, acct, hash, JSON.stringify(payload), at]);
const unfencedCas = (key, acct, hash, payload, at) => db.query(
  "select public.cas_report_snapshot_if_newer($1,$2,$3,'{}'::jsonb,$4::jsonb,null,0,$5::timestamptz) d", [key, acct, hash, JSON.stringify(payload), at]);
const fencedCas = async (key, acct, hash, payload, at, token, gen) => (await one(
  "select public.cas_report_snapshot_if_newer_fenced($1,$2,$3,'{}'::jsonb,$4::jsonb,null,0,$5::timestamptz,$6,$7::bigint) d",
  [key, acct, hash, JSON.stringify(payload), at, token, gen])).d;
const rowOf = async (key, acct, hash) => one("select payload::text p, source_refreshed_at::text s, updated_at::text u, params::text pr from public.report_snapshots where report_key=$1 and account_id=$2 and params_hash=$3", [key, acct, hash]);
const sameRow = (a, b) => !!a && !!b && a.p === b.p && a.s === b.s && a.u === b.u && a.pr === b.pr;
const T0 = "2026-09-20T00:00:00Z", T1 = "2026-09-21T00:00:00Z", T2 = "2026-09-22T00:00:00Z", T3 = "2026-09-23T00:00:00Z";

// ---- baseline BEFORE the migration: the legacy world works ----------------------------------------------------------
await legacyUpsert("brand-sales", "A1", "h1", { v: 0 }, T0);
await legacyUpsert("scheduler-v2/brand-sales", "A1", "h1", { v: 0 }, T0);
await legacyUpsert("sales-movers", "A1", "h1", { v: 0 }, T0);

// ---- apply 20260935 (twice) ------------------------------------------------------------------------------------------
await db.exec(FENCE_SQL);
await db.exec(FENCE_SQL);
ok("M1: 20260935 applies and re-applies cleanly (idempotent) on the real 20260728/0805/0822/0919 objects", true);
const seeded = await q("select report_key, fenced_only, updated_by from public.report_publication_writer_fence order by report_key");
ok("M2: the 10 route-owned live keys are seeded, EVERY one fenced_only=false (applying enables nothing)",
  seeded.length === 10 && seeded.every((r) => r.fenced_only === false && r.updated_by === "migration:20260935")
  && JSON.stringify(seeded.map((r) => r.report_key)) === JSON.stringify(["brand-inventory", "brand-sales", "brand-view", "brand-view-brands", "brand-view-portfolio", "daily-reporting", "fba-plan", "listing-health-v3", "returns-leakage", "sku-movement"]));
const trg = await q("select tgname from pg_trigger where tgrelid = 'public.report_snapshots'::regclass and not tgisinternal order by tgname");
ok("M3: both fence triggers exist on report_snapshots and the row trigger sorts LAST among its triggers",
  JSON.stringify(trg.map((t) => t.tgname)) === JSON.stringify(["report_snapshots_touch_updated_at", "report_snapshots_zz_writer_fence", "report_snapshots_zz_writer_fence_truncate"]));
const fn = await one("select prosecdef, proconfig from pg_proc where proname = 'enforce_report_publication_writer_fence'");
ok("M4: the trigger function is SECURITY DEFINER with a pinned search_path", fn.prosecdef === true && Array.isArray(fn.proconfig) && fn.proconfig.some((c) => /^search_path=public, ?pg_temp$/.test(c)));
const newSrc = await prosrc("cas_report_snapshot_if_newer_fenced");
const newLines = newSrc.split("\n"); const oldLines = ORIGINAL_FENCED_SRC.split("\n");
const addedAt = newLines.indexOf(ADDED_LINE);
ok("M5: the live fenced CAS body = the 20260919 body + EXACTLY ONE line (the transaction-local set_config), inserted just before the delegation",
  addedAt > 0 && newLines.length === oldLines.length + 1 && [...newLines.slice(0, addedAt), ...newLines.slice(addedAt + 1)].join("\n") === ORIGINAL_FENCED_SRC
  && /^\s*return public\.cas_report_snapshot_if_newer\($/.test(newLines[addedAt + 1]) && /expired/.test(newLines.slice(0, addedAt).join("\n")));
ok("M6: the unfenced CAS and the v1 prune RPC were NOT given the mark", !/app\.report_publication_fenced/.test(await prosrc("cas_report_snapshot_if_newer")) && !/app\.report_publication_fenced/.test(await prosrc("prune_scheduled_report_snapshots")));
const exactTriggers = async () => (await one(readmeSql("triggers"))).exact_triggers;
const trigOk = await exactTriggers();
await db.exec("alter table public.report_snapshots disable trigger report_snapshots_zz_writer_fence");
const trigDisabled = await exactTriggers();
await db.exec("alter table public.report_snapshots enable replica trigger report_snapshots_zz_writer_fence");
const trigReplica = await exactTriggers();
await db.exec("alter table public.report_snapshots enable trigger report_snapshots_zz_writer_fence");
await db.exec("create trigger report_snapshots_zzz_extra before insert on public.report_snapshots for each row execute function public.touch_updated_at()");
const trigExtra = await exactTriggers();
await db.exec("drop trigger report_snapshots_zzz_extra on public.report_snapshots");
ok("D1: the README EXACT-trigger check (wp15-sql:triggers) is true on the applied schema and FALSE when the fence trigger is disabled, replica-only, or another BEFORE trigger sorts after it",
  trigOk === true && trigDisabled === false && trigReplica === false && trigExtra === false && (await exactTriggers()) === true);
ok("D2: the README mark check (wp15-sql:mark) reads '' on a normal connection", (await one(readmeSql("mark"))).mark === "");

// ---- FENCE OFF: today's behaviour --------------------------------------------------------------------------------------
await legacyUpsert("brand-sales", "A1", "h1", { v: 1 }, T1);
await legacyInsertIgnore("brand-sales", "A1", "h2", { v: 1 }, T1);
await legacyPatch("brand-sales", "A1", "h2", { v: 2 }, T1);
const offCas = (await unfencedCas("brand-sales", "A1", "h3", { v: 1 }, T1)).rows[0].d;
ok("F1: fence OFF -> the legacy merge-upsert, ignore-duplicates insert, PATCH and the unfenced CAS all still write a (seeded) key",
  (await rowOf("brand-sales", "A1", "h1")).p === '{"v": 1}' && (await rowOf("brand-sales", "A1", "h2")).p === '{"v": 2}' && offCas.disposition === "inserted");
await db.query("delete from public.report_snapshots where report_key = 'brand-sales' and params_hash = 'h3'");
ok("F2: fence OFF -> a legacy DELETE still works", !(await rowOf("brand-sales", "A1", "h3")));
// Rows attributed to dashboard users (created_by -> auth.users), written while the key is still open.
const U1 = "11111111-1111-4111-8111-111111111111", U2 = "22222222-2222-4222-8222-222222222222", U3 = "33333333-3333-4333-8333-333333333333";
await db.query("insert into auth.users (id) values ($1), ($2), ($3)", [U1, U2, U3]);
for (const [hash, user] of [["u1", U1], ["u2", U2], ["u3", U2]]) {
  await db.query("insert into public.report_snapshots (report_key, account_id, params_hash, params, payload, payload_bytes, source_refreshed_at, created_by) values ('brand-sales','U',$1,'{\"to\":\"2026-09-20\"}'::jsonb,'{\"v\":1}'::jsonb,7,$2::timestamptz,$3::uuid)", [hash, T1, user]);
}
await db.query("insert into public.report_snapshots (report_key, account_id, params_hash, payload, created_by) values ('sales-movers','U','u1','{\"v\":1}'::jsonb,$1::uuid)", [U1]);

// ---- FLIP brand-sales ON (the one approved UPDATE) ----------------------------------------------------------------------
await db.query("update public.report_publication_writer_fence set fenced_only = true, updated_by = 'selftest-approver' where report_key = 'brand-sales'");
const flipped = await one("select fenced_only, updated_by, updated_at > '2000-01-01'::timestamptz t from public.report_publication_writer_fence where report_key = 'brand-sales'");
ok("F3: the flip is one UPDATE (updated_by recorded, updated_at touched)", flipped.fenced_only === true && flipped.updated_by === "selftest-approver" && flipped.t === true);
const flipAt = (await one(readmeSql("barrier-time"))).flip_committed_by;
const barrier = await one(readmeSql("barrier").split("<flip_committed_by>").join(flipAt));
ok("D3: the README flip barrier (wp15-sql:barrier-time + wp15-sql:barrier) runs on real Postgres and reports 0 pre-flip transactions / 0 invisible backends when none are open",
  typeof flipAt === "string" && flipAt.length > 10 && Number(barrier.pre_flip_transactions) === 0 && Number(barrier.invisible_backends) === 0);
// The README per-key NEGATIVE PROBE (wp15-sql:probe) inside begin/rollback: RWF01 on a fenced key, the explicit
// WRITER_FENCE_NOT_ENFORCED on an open key -- and in BOTH cases no probe row survives.
const runProbe = async (key) => {
  let err = null;
  try { await db.exec(readmeSql("probe").split("<key>").join(key)); } catch (e) { err = { code: e.code, message: String(e.message || "") }; }
  await db.exec("rollback").catch(() => {});
  return err;
};
const pFenced = await runProbe("brand-sales");
const pOpen = await runProbe("fba-plan");
const probeRows = Number((await one("select count(*)::int n from public.report_snapshots where account_id = '__writer_fence_probe__'")).n);
ok("D4: the README per-key negative probe raises RWF01 'REPORT_WRITER_FENCED:<key>' on a fenced key, 'WRITER_FENCE_NOT_ENFORCED:<key>' on an open one, and never leaves a probe row",
  fencedErr(pFenced, "brand-sales") && !!pOpen && pOpen.code === "P0001" && pOpen.message === "WRITER_FENCE_NOT_ENFORCED:fba-plan" && probeRows === 0);

const lkg = await rowOf("brand-sales", "A1", "h1");
const e1 = await fails("insert into public.report_snapshots (report_key, account_id, params_hash, payload, source_refreshed_at) values ('brand-sales','A1','h1','{\"v\":9}'::jsonb,'" + T3 + "'::timestamptz) on conflict (report_key, account_id, params_hash) do update set payload = excluded.payload, source_refreshed_at = excluded.source_refreshed_at");
ok("F4: fence ON -> the legacy merge-upsert (saveReportSnapshot) fails RWF01 'REPORT_WRITER_FENCED:brand-sales' and the live row is byte-identical (LKG)", fencedErr(e1, "brand-sales") && sameRow(lkg, await rowOf("brand-sales", "A1", "h1")));
const e2 = await fails("insert into public.report_snapshots (report_key, account_id, params_hash, payload, source_refreshed_at) values ('brand-sales','A1','h9','{\"v\":9}'::jsonb,now()) on conflict (report_key, account_id, params_hash) do nothing");
ok("F5: fence ON -> an ignore-duplicates insert of a NEW row (insertReportSnapshotIfAbsent / publishLiveSnapshotIfNewer step 1) is refused; no row created", fencedErr(e2, "brand-sales") && !(await rowOf("brand-sales", "A1", "h9")));
let e3 = null; try { await legacyPatch("brand-sales", "A1", "h1", { v: 9 }, T3); } catch (e) { e3 = { code: e.code, message: String(e.message) }; }
ok("F6: fence ON -> a PATCH/UPDATE (publishLiveSnapshotIfNewer step 2 / casUpdateReportSnapshotByRev) is refused; row unchanged", fencedErr(e3, "brand-sales") && sameRow(lkg, await rowOf("brand-sales", "A1", "h1")));
const smBefore = await rowOf("sales-movers", "A1", "h1");
const e4 = await fails("update public.report_snapshots set report_key = 'brand-sales', params_hash = 'moved' where report_key = 'sales-movers' and account_id = 'A1' and params_hash = 'h1'");
const e5 = await fails("update public.report_snapshots set report_key = 'brand-sales-old' where report_key = 'brand-sales' and account_id = 'A1' and params_hash = 'h1'");
ok("F7: an UPDATE that moves a row INTO a fenced key (NEW) or OUT of it (OLD) is refused; both rows unchanged", fencedErr(e4, "brand-sales") && fencedErr(e5, "brand-sales") && sameRow(smBefore, await rowOf("sales-movers", "A1", "h1")) && sameRow(lkg, await rowOf("brand-sales", "A1", "h1")));
const e6 = await fails("delete from public.report_snapshots where report_key = 'brand-sales' and account_id = 'A1' and params_hash = 'h1'");
ok("F8: a legacy DELETE of a fenced key (retention / deleteReportSnapshotByKey) is refused; the LKG row survives", fencedErr(e6, "brand-sales") && sameRow(lkg, await rowOf("brand-sales", "A1", "h1")));
let e7 = null; try { await unfencedCas("brand-sales", "A1", "h1", { v: 9 }, T3); } catch (e) { e7 = { code: e.code, message: String(e.message) }; }
let e7b = null; try { await unfencedCas("brand-sales", "A1", "h1", { v: 0 }, T0); } catch (e) { e7b = { code: e.code, message: String(e.message) }; }
ok("F9: the UNFENCED CAS on a fenced key is refused (newer AND older candidates: its insert-if-absent step fires the trigger); row unchanged", fencedErr(e7, "brand-sales") && fencedErr(e7b, "brand-sales") && sameRow(lkg, await rowOf("brand-sales", "A1", "h1")));
await db.query("update public.report_snapshots set params = '{\"syncManaged\":\"true\"}'::jsonb where report_key = 'brand-sales' and params_hash = 'h2'").catch(() => {});
await db.query("update public.report_publication_writer_fence set fenced_only = false where report_key = 'brand-sales'");
await db.query("update public.report_snapshots set params = '{\"syncManaged\":\"true\"}'::jsonb where report_key = 'brand-sales' and params_hash = 'h2'");
await db.query("update public.report_publication_writer_fence set fenced_only = true where report_key = 'brand-sales'");
const e8 = await fails("select public.prune_scheduled_report_snapshots('brand-sales', 'A1', 'h1')");
ok("F10: the scheduler-v1 prune RPC (prune_scheduled_report_snapshots, SECURITY DEFINER) cannot delete a fenced key's rows", fencedErr(e8, "brand-sales") && !!(await rowOf("brand-sales", "A1", "h2")));
const e9 = await fails("truncate public.report_snapshots cascade");
ok("F11: TRUNCATE is refused while any key is fenced ('REPORT_WRITER_FENCED:*'); nothing removed", fencedErr(e9, "*") && Number((await one("select count(*)::int n from public.report_snapshots")).n) >= 4);

// ---- the ONE exemption: deleting a dashboard user (auth.users ON DELETE SET NULL on created_by; FK KEPT) ----------------
// whole(): every column except created_by as one jsonb text (so j equality = byte-identical content AND updated_at).
const whole = async (key, acct, hash) => one("select (to_jsonb(r) - 'created_by')::text j, created_by::text cb, updated_at::text u from public.report_snapshots r where report_key = $1 and account_id = $2 and params_hash = $3", [key, acct, hash]);
const u1Before = await whole("brand-sales", "U", "u1");
const smBeforeDel = await whole("sales-movers", "U", "u1");
const eDelUser = await fails("delete from auth.users where id = $1", [U1]);
const u1After = await whole("brand-sales", "U", "u1");
const smAfterDel = await whole("sales-movers", "U", "u1");
ok("U1: deleting a dashboard user SUCCEEDS while its rows' key is fenced (the ON DELETE SET NULL referential UPDATE is the one exemption): the fenced row changes ONLY created_by -> NULL, every other column byte-identical incl. updated_at (restored); an unfenced key's row behaves exactly as today (updated_at touched)",
  eDelUser === null && u1Before.cb === U1 && u1After.cb === null && u1After.j === u1Before.j && u1After.u === u1Before.u
  && smAfterDel.cb === null && smAfterDel.u !== smBeforeDel.u && !(await one("select 1 x from public.report_snapshots where created_by = $1", [U1])) && !(await one("select 1 x from auth.users where id = $1", [U1])));
const u2Before = await whole("brand-sales", "U", "u2");
const U2W = "where report_key = 'brand-sales' and account_id = 'U' and params_hash = 'u2'";
const mixed = [
  await fails("update public.report_snapshots set created_by = null, payload = '{\"v\":99}'::jsonb " + U2W),
  await fails("update public.report_snapshots set created_by = null, params = '{\"to\":\"2026-09-21\"}'::jsonb " + U2W),
  await fails("update public.report_snapshots set created_by = null, source_refreshed_at = now() " + U2W),
  await fails("update public.report_snapshots set created_by = null, params_hash = 'u9' " + U2W),
  await fails("update public.report_snapshots set created_by = null, account_id = 'V' " + U2W),
  await fails("update public.report_snapshots set created_by = null, payload_bytes = 8 " + U2W),
  await fails("update public.report_snapshots set created_by = null, payload_storage_path = 'x/y.json' " + U2W),
  await fails("update public.report_snapshots set created_by = null, report_key = 'brand-sales-x' " + U2W),
  await fails("update public.report_snapshots set created_by = $1::uuid " + U2W, [U3]),
  await fails("update public.report_snapshots set payload = payload where report_key = 'brand-sales' and account_id = 'U' and params_hash = 'u1'"),
];
ok("U2: the exemption is EXACT: created_by -> NULL together with ANY other change (payload, params, source_refreshed_at, params_hash, account_id, payload_bytes, payload_storage_path, report_key), a non-NULL re-attribution, and a no-op/touch UPDATE of an already-NULL row are ALL refused RWF01; the rows are unchanged",
  mixed.every((e) => fencedErr(e, "brand-sales")) && (await whole("brand-sales", "U", "u2")).j === u2Before.j && (await whole("brand-sales", "U", "u2")).cb === U2 && (await whole("brand-sales", "U", "u1")).j === u1After.j);
const u3Before = await whole("brand-sales", "U", "u3");
const eDirectNull = await fails("update public.report_snapshots set created_by = null where report_key = 'brand-sales' and account_id = 'U' and params_hash = 'u3'");
const u3After = await whole("brand-sales", "U", "u3");
const eDelUser2 = await fails("delete from auth.users where id = $1", [U2]);
const u2After = await whole("brand-sales", "U", "u2");
ok("U3: the exemption is shape-based, not caller-based: a direct created_by-only nulling is allowed too and still changes NO other column (updated_at restored), so it can never change content or which row is served latest; deleting the second user nulls its fenced row the same way",
  eDirectNull === null && u3Before.cb === U2 && u3After.cb === null && u3After.j === u3Before.j && u3After.u === u3Before.u
  && eDelUser2 === null && u2After.cb === null && u2After.j === u2Before.j);

// ---- the FENCED CAS still publishes ---------------------------------------------------------------------------------------
await db.query("insert into public.control_plane_lease (id, owner_token, operation_key, generation, acquired_at, expires_at) values (1, 'owner-A', 'selftest', 7, now(), now() + interval '10 minutes') on conflict (id) do update set owner_token = excluded.owner_token, generation = excluded.generation, expires_at = excluded.expires_at");
const d1 = await fencedCas("brand-sales", "A1", "h1", { v: 5 }, T2, "owner-A", 7);
ok("F12: fence ON -> the fenced CAS (valid owner/generation/unexpired lease) REPLACES the fenced live row", d1.disposition === "replaced" && (await rowOf("brand-sales", "A1", "h1")).p === '{"v": 5}');
const d2 = await fencedCas("brand-sales", "A2", "n1", { v: 1 }, T2, "owner-A", 7);
ok("F13: ... and INSERTS a new fenced row", d2.disposition === "inserted" && !!(await rowOf("brand-sales", "A2", "n1")));
const d3 = await fencedCas("brand-sales", "A1", "h1", { v: 4 }, T1, "owner-A", 7);
ok("F14: ... and keeps its CAS semantics (an older candidate is 'newer-live', zero write)", d3.disposition === "newer-live" && (await rowOf("brand-sales", "A1", "h1")).p === '{"v": 5}');

// ---- the mark: set only after the fence passes; transaction-local; never leaks ---------------------------------------------
await db.exec("begin");
const lost = await fencedCas("brand-sales", "A1", "h1", { v: 6 }, T3, "owner-A", 6);
const inTxAfterLost = await fails("update public.report_snapshots set payload = '{\"v\":66}'::jsonb where report_key = 'brand-sales' and account_id = 'A1' and params_hash = 'h1'");
await db.exec("rollback");
ok("L1: a LEASE-LOST fenced call (superseded generation) writes zero rows AND never marks its transaction (a later legacy write in the SAME transaction is still refused)", lost.disposition === "lease-lost" && fencedErr(inTxAfterLost, "brand-sales") && (await rowOf("brand-sales", "A1", "h1")).p === '{"v": 5}');
await db.exec("begin");
await fencedCas("brand-sales", "A3", "x1", { v: 1 }, T2, "owner-A", 7);
const inTx = (await one("select current_setting('app.report_publication_fenced', true) s")).s;
await db.exec("commit");
const nextTx = (await one("select current_setting('app.report_publication_fenced', true) s")).s;
const eLeak = await fails("update public.report_snapshots set payload = '{\"v\":77}'::jsonb where report_key = 'brand-sales' and account_id = 'A3' and params_hash = 'x1'");
ok("L2: the mark is TRANSACTION-LOCAL: 'on' inside the fenced CAS's own transaction, gone in the NEXT transaction on the same session, whose legacy write is refused again",
  inTx === "on" && nextTx !== "on" && fencedErr(eLeak, "brand-sales") && (await rowOf("brand-sales", "A3", "x1")).p === '{"v": 1}');
await db.exec("begin");
await fencedCas("brand-sales", "A3", "x1", { v: 2 }, T3, "owner-A", 7);
await db.exec("rollback");
const eAfterRollback = await fails("delete from public.report_snapshots where report_key = 'brand-sales' and account_id = 'A3'");
ok("L3: a ROLLED-BACK fenced transaction leaves no mark either (the next statement is fenced) and its write is undone", fencedErr(eAfterRollback, "brand-sales") && (await rowOf("brand-sales", "A3", "x1")).p === '{"v": 1}');

// ---- shadow + unfenced keys unaffected ---------------------------------------------------------------------------------------
await legacyUpsert("scheduler-v2/brand-sales", "A1", "h1", { v: 3 }, T3);
const shCas = (await unfencedCas("scheduler-v2/brand-sales", "A1", "s2", { v: 1 }, T3)).rows[0].d;
await db.query("delete from public.report_snapshots where report_key = 'scheduler-v2/brand-sales' and params_hash = 's2'");
ok("S1: shadow keys (scheduler-v2/*) are unaffected while the live key is fenced: merge-upsert, unfenced CAS and the guarded shadow prune all work", (await rowOf("scheduler-v2/brand-sales", "A1", "h1")).p === '{"v": 3}' && shCas.disposition === "inserted" && !(await rowOf("scheduler-v2/brand-sales", "A1", "s2")));
const eShadowSeed = await fails("insert into public.report_publication_writer_fence (report_key, fenced_only) values ('scheduler-v2/brand-sales', true)");
ok("S2: the fence table REFUSES a scheduler-v2/* key (check constraint) -- the shadow namespace can never be fenced", !!eShadowSeed && eShadowSeed.code === "23514");
await legacyUpsert("sales-movers", "A1", "h1", { v: 3 }, T3);
await legacyUpsert("fba-plan", "A1", "h1", { v: 3 }, T3);
ok("S3: an unseeded key (sales-movers) and a seeded-but-open key (fba-plan) are written exactly as before", (await rowOf("sales-movers", "A1", "h1")).p === '{"v": 3}' && (await rowOf("fba-plan", "A1", "h1")).p === '{"v": 3}');

// ---- idempotency never resets a flip; least privilege; role-independent enforcement ---------------------------------------
await db.exec(FENCE_SQL);
ok("I1: re-applying 20260935 after a flip keeps brand-sales fenced (ON CONFLICT DO NOTHING) and keeps the body at exactly one added line", (await one("select fenced_only from public.report_publication_writer_fence where report_key = 'brand-sales'")).fenced_only === true && (await prosrc("cas_report_snapshot_if_newer_fenced")) === newSrc);
const g = await one("select has_table_privilege('service_role','public.report_publication_writer_fence','select') s, has_table_privilege('service_role','public.report_publication_writer_fence','update') su, has_table_privilege('service_role','public.report_publication_writer_fence','insert') si, has_table_privilege('service_role','public.report_publication_writer_fence','delete') sd, has_table_privilege('anon','public.report_publication_writer_fence','select') a, has_table_privilege('authenticated','public.report_publication_writer_fence','select') u, has_function_privilege('anon','public.enforce_report_publication_writer_fence()','execute') fa, has_function_privilege('service_role','public.enforce_report_publication_writer_fence()','execute') fs, has_function_privilege('service_role','public.cas_report_snapshot_if_newer_fenced(text, text, text, jsonb, jsonb, text, bigint, timestamptz, text, bigint)','execute') cs, has_function_privilege('anon','public.cas_report_snapshot_if_newer_fenced(text, text, text, jsonb, jsonb, text, bigint, timestamptz, text, bigint)','execute') ca");
ok("G1: least privilege: service_role may only SELECT the fence table (it can never flip it); anon/authenticated see nothing; nobody may EXECUTE the trigger function; the fenced CAS stays service_role-only",
  g.s === true && g.su === false && g.si === false && g.sd === false && g.a === false && g.u === false && g.fa === false && g.fs === false && g.cs === true && g.ca === false);
const rlsOn = (await one("select relrowsecurity r from pg_class where oid = 'public.report_publication_writer_fence'::regclass")).r;
ok("G2: RLS is enabled on the fence table", rlsOn === true);
await db.exec("set role service_role");
const eRole = await fails("insert into public.report_snapshots (report_key, account_id, params_hash, payload) values ('brand-sales','A9','r1','{}'::jsonb)");
const eRoleFlip = await fails("update public.report_publication_writer_fence set fenced_only = false where report_key = 'brand-sales'");
let roleShadowOk = true; try { await legacyUpsert("scheduler-v2/brand-sales", "A9", "r1", { v: 1 }, T3); } catch { roleShadowOk = false; }
await db.exec("reset role");
ok("G3: as service_role (the app's role; no EXECUTE on the trigger function) a fenced write is still refused, the role cannot open the fence, and its shadow writes work",
  fencedErr(eRole, "brand-sales") && !!eRoleFlip && eRoleFlip.code === "42501" && roleShadowOk);

// ---- ROLLBACK restores the 20260919 body exactly ---------------------------------------------------------------------------
await db.exec(ROLLBACK_SQL);
const rbSrc = await prosrc("cas_report_snapshot_if_newer_fenced");
const rbTrg = await q("select tgname from pg_trigger where tgrelid = 'public.report_snapshots'::regclass and not tgisinternal order by tgname");
const rbTable = await one("select to_regclass('public.report_publication_writer_fence') t");
const rbFn = await one("select count(*)::int n from pg_proc where proname = 'enforce_report_publication_writer_fence'");
ok("R1: ROLLBACK_20260935 restores the fenced CAS body BYTE-IDENTICAL to 20260919 and drops only the fence objects", rbSrc === ORIGINAL_FENCED_SRC && JSON.stringify(rbTrg.map((t) => t.tgname)) === JSON.stringify(["report_snapshots_touch_updated_at"]) && rbTable.t === null && rbFn.n === 0);
await legacyUpsert("brand-sales", "A1", "h1", { v: 8 }, T3);
const rbCas = await fencedCas("brand-sales", "A4", "z1", { v: 1 }, T3, "owner-A", 7);
ok("R2: after the rollback unfenced writers are RE-ENABLED (documented: a separate approved DB change) and the fenced CAS works as in 20260919", (await rowOf("brand-sales", "A1", "h1")).p === '{"v": 8}' && rbCas.disposition === "inserted");
ok("R3: the rollback leaves the survivors intact (LKG rows, shadow rows, the lease)", !!(await rowOf("brand-sales", "A2", "n1")) && !!(await rowOf("scheduler-v2/brand-sales", "A1", "h1")) && (await one("select generation from public.control_plane_lease where id = 1")).generation == 7);

await db.close();
console.log(`report-writer-fence-selftest: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
