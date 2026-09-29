// OFFLINE PGlite self-test (in-process WASM Postgres; NEVER a real database): the Ads table CHANGE PROBE that gates the
// worker's cross-pass reuse of the shared Ads digest partials (store-pg.js ADS_CHANGE_PROBE_SQL + routes.js
// adsChangeProbeSignature) on real Postgres semantics. Every kind of write that can change the digest's input must move
// the signature (insert, update incl. a no-op upsert, delete, TRUNCATE / rewrite, a counter reset); an interval with no
// write must NOT (or the reuse would never hit). A DO NOTHING conflict (no row changed) may leave it unchanged.
//   PRW_PGLITE_DIR=<repo>/sales-dashboard-live/scratchpad/pglite node scripts/worker/ads-change-probe-selftest.mjs
// Exit 0 = all assertions pass; 1 = a failure; 3 = PGlite not available (SKIPPED -- not a pass). 7-bit ASCII, LF.
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = process.env.PRW_PGLITE_DIR;
const entry = dir ? path.join(dir, "node_modules", "@electric-sql", "pglite", "dist", "index.js") : null;
let PGlite;
try { ({ PGlite } = await import(entry && existsSync(entry) ? pathToFileURL(entry).href : "@electric-sql/pglite")); }
catch { console.log("SKIPPED: PGlite not available (set PRW_PGLITE_DIR; see header). This is NOT a pass."); process.exit(3); }

const P = await import("../../lib/server/recovery/store-pg.js");

let passed = 0, failed = 0;
const ok = (name, cond) => { if (cond) { passed += 1; console.log("  ok " + name); } else { failed += 1; console.log("  FAIL " + name); } };

const db = new PGlite();
await db.exec(`create table public.ads_daily_source_rows (
  source_key text not null, account_id text not null, marketplace_country_code text not null, metric_date date not null,
  dimension_key text not null, metrics jsonb not null default '{}', updated_at timestamptz not null default now(),
  primary key (source_key, account_id, marketplace_country_code, metric_date, dimension_key))`);
// Pending per-backend counters reach the shared cumulative stats at the next report; force it, then end a transaction.
const flush = async () => { await db.query("select pg_stat_force_next_flush()"); await db.query("select 1"); };
const probe = async () => (await db.query(P.ADS_CHANGE_PROBE_SQL)).rows[0];
const sig = async () => { await flush(); return P.adsChangeProbeSignature(await probe()); };
const ins = (acct, day, spend) => db.query(
  "insert into public.ads_daily_source_rows (source_key, account_id, marketplace_country_code, metric_date, dimension_key, metrics) values ('campaign-performance-v1', $1, 'IN', $2::date, 'c1', jsonb_build_object('ad_spend', $3::numeric)) "
  + "on conflict (source_key, account_id, marketplace_country_code, metric_date, dimension_key) do update set metrics = excluded.metrics", [acct, day, spend]);

const row0 = await probe();
ok("P1 the probe returns ONE row with every signature field as text (in_recovery 'false', track_counts 'on')",
  !!row0 && P.ADS_CHANGE_PROBE_FIELDS.every((f) => typeof row0[f] === "string" && row0[f] !== "") && row0.in_recovery === "false" && row0.track_counts === "on");
const s0 = await sig();
ok("P2 a valid signature: every field joined in order", typeof s0 === "string" && s0.split("|").length === P.ADS_CHANGE_PROBE_FIELDS.length);
await db.query("select count(*) from public.ads_daily_source_rows");
ok("P3 NO write (a read-only scan in between): the signature is UNCHANGED (reuse can hit)", (await sig()) === s0);

await ins("A1", "2026-09-27", 5);
const s1 = await sig();
ok("P4 an INSERT moves the signature", s1 !== null && s1 !== s0);
await ins("A1", "2026-09-27", 5);
const s2 = await sig();
ok("P5 a NO-OP upsert (same values, DO UPDATE) still moves it (n_upd counts the rewritten tuple)", s2 !== null && s2 !== s1);
await db.query("insert into public.ads_daily_source_rows (source_key, account_id, marketplace_country_code, metric_date, dimension_key) values ('campaign-performance-v1', 'A1', 'IN', '2026-09-27', 'c1') on conflict do nothing");
const s3 = await sig();
ok("P6 a DO NOTHING conflict (no row changed) may leave it unchanged -- the digest input is unchanged too", s3 !== null);
await db.query("update public.ads_daily_source_rows set metrics = jsonb_build_object('ad_spend', 7) where account_id = 'A1'");
const s4 = await sig();
ok("P7 an UPDATE moves the signature", s4 !== null && s4 !== s3);
await ins("A2", "2026-09-26", 3);
await db.query("delete from public.ads_daily_source_rows where account_id = 'A2'");
const s5 = await sig();
ok("P8 a DELETE moves the signature (a deleted day is caught, unlike max(updated_at))", s5 !== null && s5 !== s4);
await db.exec("begin; insert into public.ads_daily_source_rows (source_key, account_id, marketplace_country_code, metric_date, dimension_key) values ('campaign-performance-v1', 'A3', 'IN', '2026-09-25', 'c9'); rollback;");
const s6 = await sig();
ok("P9 an ABORTED insert (no visible change) is still counted -- a spurious rescan at worst, never a missed change", s6 !== null && s6 !== s5);
const fileBefore = (await probe()).rel_filenode;
await db.exec("truncate public.ads_daily_source_rows");
const s7 = await sig();
ok("P10 TRUNCATE (no per-row counter) moves the signature through relfilenode", s7 !== null && s7 !== s6 && (await probe()).rel_filenode !== fileBefore);
await ins("A1", "2026-09-27", 5);
const s8 = await sig();
await db.query("select pg_stat_reset_single_table_counters('public.ads_daily_source_rows'::regclass)");
const s9 = await sig();
ok("P11 a counter RESET moves the signature (counters back to 0 and / or the reset stamp)", s8 !== null && s9 !== null && s9 !== s8);
ok("P12 a standby / counting-off / blank row never vouches (null signature)",
  P.adsChangeProbeSignature({ ...row0, in_recovery: "true" }) === null && P.adsChangeProbeSignature({ ...row0, track_counts: "off" }) === null
  && P.adsChangeProbeSignature({ ...row0, n_upd: "" }) === null && P.adsChangeProbeSignature(null) === null);

console.log(`ads-change-probe-selftest: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
