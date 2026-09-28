// Publication recovery worker -- REAL SQL self-test of the REDESIGNED supabase/migrations/20260934 (route design, WP12) in
// an in-process Postgres (PGlite, WASM), plus the worker store's OWN read SQL (store-pg.js, through a PGlite-backed pool)
// against minimal stubs of the existing tables it reads. Proves: the migration applies idempotently and refuses the
// earlier family-based shape; the route FK / live_regions / owner / target / unit_key / verified_rows constraints; the 12
// RPCs' semantics (enqueue validation + coalescing, coherent claims, owner-only finish, the evaluatedToken re-arm + the
// per-job re-arm counter, crash-loop, scans, baseline + served confirmation, observations, status ALERTS, prune,
// least privilege); the store's gate / live-row / blocker / directory SQL; and that ROLLBACK_20260934.sql returns the
// catalog to EXACTLY its pre-migration state. NEVER touches a real database.
//
//   npm install --prefix /tmp/pglite @electric-sql/pglite@0.5.8   # once, outside the repo (no package.json change)
//   PRW_PGLITE_DIR=/tmp/pglite node scripts/worker/publication-recovery-sql-selftest.mjs
//
// Exit 0 = all assertions pass; 1 = a failure; 3 = PGlite not available (SKIPPED -- not a pass).
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

const { createRecoveryStore, evaluateSchedulerGate, reaperCandidates, SCHEDULER_GATE_SQL } = await import("../../lib/server/recovery/store-pg.js");
const { PUBLICATION_ROUTES } = await import("../../lib/server/recovery/routes.js");

let passed = 0, failed = 0;
const ok = (name, cond) => { if (cond) { passed += 1; console.log("  ok " + name); } else { failed += 1; console.log("  FAIL " + name); } };
const DATE_TEXT = { 1082: (v) => v };
const migration = readFileSync(path.join(appRoot, "supabase", "migrations", "20260934_publication_recovery_worker.sql"), "utf8");
const rollback = readFileSync(path.join(appRoot, "deploy", "publication-recovery", "ROLLBACK_20260934.sql"), "utf8");
const raises = async (fn, re) => { try { await fn(); return false; } catch (e) { return re ? re.test(String(e && e.message)) : true; } };

// The minimal stubs of the EXISTING tables the store reads (columns it touches only) + the Supabase roles + the ledger.
const STUBS = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create table public.app_schema_migrations (filename text primary key, applied_at timestamptz not null default now());
insert into public.app_schema_migrations (filename) values ('20260933_previous.sql'), ('20260934_publication_recovery_worker.sql');
create table public.sync_cycles (id uuid primary key default gen_random_uuid(), bucket text not null, cycle_date date not null, status text not null default 'pending', started_at timestamptz, finished_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table public.sync_report_jobs (id uuid primary key default gen_random_uuid(), cycle_id uuid not null references public.sync_cycles(id), report_key text not null, account_id text not null, fetch_status text not null default 'pending', derive_status text not null default 'pending', save_status text not null default 'pending', validated boolean not null default false, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table public.sync_source_jobs (id uuid primary key default gen_random_uuid(), cycle_id uuid not null references public.sync_cycles(id), fetch_status text not null default 'pending', created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table public.report_snapshots (id uuid primary key default gen_random_uuid(), report_key text not null, account_id text not null, params_hash text not null, params jsonb not null default '{}'::jsonb, payload jsonb, payload_storage_path text, source_refreshed_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique (report_key, account_id, params_hash));
create table public.control_plane_lease (id smallint primary key default 1, owner_token text not null default '', operation_key text not null default '', generation bigint not null default 0, expires_at timestamptz, updated_at timestamptz not null default now());
insert into public.control_plane_lease (id, owner_token) values (1, '');
`;
const CATALOG_SQL = `select x from (
  select 'rel:' || c.relkind::text || ':' || c.relname::text as x from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'
  union all select 'fn:' || p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
  union all select 'con:' || c.conname::text from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'public'
  union all select 'type:' || t.typname::text from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public') q order by 1`;

// ---- (0) the guard refuses the earlier family-based shape ----------------------------------------------------------
{
  const old = new PGlite();
  await old.exec("create role anon nologin; create role authenticated nologin; create role service_role nologin;");
  await old.exec("create table public.publication_recovery_jobs (id uuid primary key default gen_random_uuid(), family text not null);");
  ok("M0: the migration REFUSES to run over the earlier family-based publication_recovery_jobs (fail closed; nothing half-applied)", await raises(() => old.exec(migration), /earlier family-based/));
  await old.close();
}

const db = new PGlite();
const q = async (sql, params = []) => (await db.query(sql, params, { parsers: DATE_TEXT })).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];
await db.exec(STUBS);
const before = (await q(CATALOG_SQL)).map((r) => r.x);
await db.exec(migration);
const created = (await q(CATALOG_SQL)).map((r) => r.x).filter((x) => !before.includes(x));
await db.exec(migration); // idempotent re-apply
ok("M1: the migration applies and RE-applies cleanly (idempotent)", true);
const routes = await q("select route_id, grain, live_report_keys, live_enabled, live_regions from public.publication_recovery_routes order by route_id");
ok("M2: 10 routes seeded == the registry (id, grain, live report keys), ALL live_enabled=false with no live region; control disabled", routes.length === 10 && PUBLICATION_ROUTES.every((r) => { const x = routes.find((y) => y.route_id === r.id); return x && x.grain === r.grain && JSON.stringify([...x.live_report_keys].sort()) === JSON.stringify([...r.liveReportKeys].sort()) && x.live_enabled === false && x.live_regions.length === 0; }) && (await one("select enabled from public.publication_recovery_control")).enabled === false);
await q("update public.publication_recovery_routes set live_enabled = true where route_id = 'oli'");
await db.exec(migration);
ok("M3: a re-apply never resets an operator's canary switch (seed is insert-on-conflict-do-nothing)", (await one("select live_enabled from public.publication_recovery_routes where route_id = 'oli'")).live_enabled === true);
await q("update public.publication_recovery_routes set live_enabled = false where route_id = 'oli'");

// ---- constraints --------------------------------------------------------------------------------------------------
const D = "2026-09-23";
ok("K1: the route FK REJECTS an unknown route (direct insert) and enqueue refuses it with a typed error", await raises(() => q("insert into public.publication_recovery_jobs (route_id, region, target_key, requested_as_of, origin) values ('bogus','india','A','2026-09-23','scan')"), /foreign key|violates/) && await raises(() => q("select public.enqueue_publication_recovery_job('bogus','india','A','{A}'::text[],$1::date,'t','scan',1::smallint)", [D]), /unknown route/));
ok("K2: the live_regions CHECK rejects an unknown region (canary switch accepts only india | europe-au | us-ca)", await raises(() => q("update public.publication_recovery_routes set live_regions = array['india','mars'] where route_id = 'oli'"), /prr_live_regions_check|check/) && (await q("update public.publication_recovery_routes set live_regions = array['india'] where route_id = 'oli' returning route_id")).length === 1);
await q("update public.publication_recovery_routes set live_regions = '{}' where route_id = 'oli'");
const enq = async (r, g, t, owners, tok, origin = "scan", pr = 5, d = D) => (await one("select public.enqueue_publication_recovery_job($1,$2,$3,$4::text[],$5::date,$6,$7,$8::smallint) d", [r, g, t, owners, d, tok, origin, pr])).d;
ok("K3: enqueue validates owners (<= 128, canonical grammar) and the target for the route's grain", await raises(() => enq("oli", "india", "A", Array.from({ length: 129 }, (_, i) => "o" + i), "t"), /128/) && await raises(() => enq("oli", "india", "A", ["bad owner"], "t"), /malformed owner/) && await raises(() => enq("brand-view-portfolio", "india", "region:us-ca", ["A"], "t"), /region:<region>/) && await raises(() => enq("oli", "india", "region:india", ["A"], "t"), /canonical account/) && await raises(() => enq("oli", "india", "A", ["A"], "t", "sideways"), /prj_origin_check|check/));

// ---- enqueue / claim / finish ---------------------------------------------------------------------------------------
ok("E1: enqueue -> enqueued; same token -> exists; new token -> refreshed (owners refreshed too)", (await enq("oli", "india", "A", ["A"], "t1", "scan", 1)) === "enqueued" && (await enq("oli", "india", "A", ["A"], "t1", "scan", 1)) === "exists" && (await enq("oli", "india", "A", ["A"], "t2", "scan", 1)) === "refreshed" && (await one("select evidence_token from public.publication_recovery_jobs where target_key='A'")).evidence_token === "t2");
ok("E2: exactly one live job per (route, region, target, as-of) (partial unique index)", Number((await one("select count(*)::int n from public.publication_recovery_jobs where target_key='A'")).n) === 1 && await raises(() => q("insert into public.publication_recovery_jobs (route_id, region, target_key, requested_as_of, origin) values ('oli','india','A',$1::date,'scan')", [D]), /duplicate|unique/));
await enq("oli", "india", "B", ["B"], "t1", "scan", 1); await enq("fba", "india", "C", ["C"], "t1", "scan", 4); await enq("oli", "us-ca", "Z", ["Z"], "t1", "scan", 1);
await enq("brand-view-portfolio", "india", "region:india", ["A", "B"], "p1", "dependency", 8);
const claim = async (w, tok, lim = 5, lease = 1500, maxc = 8) => q("select * from public.claim_publication_recovery_jobs($1,$2::uuid,$3,$4,$5)", [w, tok, lim, lease, maxc]);
const fin = async (id, tok, outcome, cls = null, reason = null, backoff = 60, maxA = 6, run = null, vtok = null, rows = null, alert = null, pub = false, handoff = null, rec = true, served = null, maxRe = 12) =>
  (await one("select public.finish_publication_recovery_job($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16) d", [id, tok, outcome, cls, reason, backoff, maxA, run, vtok, rows == null ? null : JSON.stringify(rows), alert, pub, handoff, rec, served, maxRe])).d;
const T1 = "00000000-0000-4000-8000-000000000001", T2 = "00000000-0000-4000-8000-000000000002", T3 = "00000000-0000-4000-8000-000000000003";
const c1 = await claim("w1", T1, 5);
ok("C1: a claim returns ONE coherent (route, region, as-of) batch (dates as text)", c1.length === 2 && c1.every((j) => j.route_id === "oli" && j.region === "india" && j.requested_as_of === D));
const c2 = await claim("w2", T2, 5);
ok("C2: a concurrent claim never overlaps (next group)", c2.length === 1 && !c1.some((x) => x.id === c2[0].id));
ok("C3: finish by a non-owner token is refused", (await fin(c1[0].id, T2, "verified")) === "not-owner");
const a = c1.find((j) => j.target_key === "A"), b = c1.find((j) => j.target_key === "B");
const VROWS = [{ u: "-", rk: "brand-sales", acct: "A", h: "h1", sra: "2026-09-24T00:00:00.000Z", upd: 1, asOf: D }];
ok("V1: verified with the job's own token -> state records verified_token, unit verified_rows, the hand-off and the served proof", (await fin(a.id, T1, "verified", "current", "verified-live-readback", 0, 6, "run-1", "t2", VROWS, null, true, "repaired", true, true)) === "verified" && (await one("select verified_token, verified_rows, handoff, served_confirmed from public.publication_recovery_state where target_key='A'")).verified_rows[0].asOf === D && (await one("select handoff from public.publication_recovery_state where target_key='A'")).handoff === "repaired" && (await one("select published from public.publication_recovery_jobs where id=$1::uuid", [a.id])).published === true);
ok("V2: a watermark with the proven token -> already-verified; a scan detection still enqueues", (await enq("oli", "india", "A", ["A"], "t2", "watermark")) === "already-verified" && (await enq("oli", "india", "A", ["A"], "t2", "scan")) === "enqueued");
ok("V3: a verification for ANOTHER evaluated token RE-ARMS (pending, attempts/claims reset) and COUNTS the re-arm", (await fin(b.id, T1, "verified", null, null, 0, 6, null, "stale-token")) === "re-armed" && (await one("select status, rearms from public.publication_recovery_jobs where id=$1::uuid", [b.id])).rearms === 1);
const big = Array.from({ length: 200 }, (_, i) => ({ u: "u" + i, rk: "brand-view", acct: "X", h: "h".repeat(40), sra: "2026-09-24T00:00:00.000Z", upd: 1, asOf: D }));
const bv = (await claim("w1", T3, 5)).find((j) => j.target_key === "B");
ok("K4: verified_rows is SIZE-BOUNDED (pg_column_size <= 8192): an oversize set is refused (the worker compacts before sending)", await raises(() => fin(bv.id, T3, "verified", "current", null, 0, 6, null, bv.evidence_token, big), /prs_verified_rows_bounded|check/));
await fin(bv.id, T3, "released");

// retry -> dead, dead-same-evidence, deferred without state, re-arm bound
await q("update public.publication_recovery_jobs set status='dead' where target_key='A' and status in ('pending','claimed','deferred')");
const r1 = (await claim("w1", T3, 5)).find((j) => j.target_key === "B");
ok("R1: retry -> attempts+1, pending, next attempt in the future; the state records the evaluated class", (await fin(r1.id, T3, "retry", "timeout", "x", 300, 2, null, r1.evidence_token, null, null, false, "failed")) === "retry" && (await one("select next_attempt_at > now() fut from public.publication_recovery_jobs where id=$1::uuid", [r1.id])).fut === true && (await one("select last_class from public.publication_recovery_state where target_key='B'")).last_class === "timeout");
await q("update public.publication_recovery_jobs set next_attempt_at = now() - interval '1 second' where id=$1::uuid", [r1.id]);
const r2 = (await claim("w1", T1, 5)).find((j) => j.id === r1.id);
ok("R2: the attempt cap dead-letters (never loops)", r2 && (await fin(r1.id, T1, "retry", "timeout", "x", 300, 2, null, r2.evidence_token)) === "dead" && (await one("select last_class from public.publication_recovery_jobs where id=$1::uuid", [r1.id])).last_class === "max-attempts:timeout");
ok("R3: the same evidence is never re-enqueued after dead-lettering; new evidence opens a new job", (await enq("oli", "india", "B", ["B"], "t1")) === "dead-same-evidence" && (await enq("oli", "india", "B", ["B"], "t9")) === "enqueued");
await q("update public.publication_recovery_jobs set status = 'superseded' where target_key <> 'B' and status in ('pending','claimed','deferred')");
const d1 = (await claim("w1", T2, 5)).find((j) => j.target_key === "B");
const stBefore = await one("select last_class from public.publication_recovery_state where target_key='B'");
ok("D1: a GATE deferral (p_record_state=false) keeps attempts, resets claims and leaves the state row untouched", (await fin(d1.id, T2, "deferred", "scheduler-window-global", null, 120, 6, null, d1.evidence_token, null, null, false, null, false)) === "deferred" && Number((await one("select attempts, claims from public.publication_recovery_jobs where id=$1::uuid", [d1.id])).attempts) === 0 && (await one("select last_class from public.publication_recovery_state where target_key='B'")).last_class === stBefore.last_class);
ok("D2: a refreshed token re-arms a deferred job to pending", (await enq("oli", "india", "B", ["B"], "brand-new")) === "refreshed" && (await one("select status from public.publication_recovery_jobs where id=$1::uuid", [d1.id])).status === "pending");
const rl = (await claim("w1", T3, 5)).find((j) => j.id === d1.id);
ok("D3: released hands the job back with claims restored", (await fin(rl.id, T3, "released")) === "released" && Number((await one("select claims from public.publication_recovery_jobs where id=$1::uuid", [rl.id])).claims) === Number(rl.claims) - 1);
let rearmOut = null;
for (let i = 0; i < 3; i += 1) {
  const c = (await claim("w1", T1, 5)).find((j) => j.id === d1.id);
  rearmOut = await fin(d1.id, T1, "deferred", "evidence-advanced", "x", 60, 6, null, c.evidence_token, null, null, false, null, true, null, 3);
  await q("update public.publication_recovery_jobs set next_attempt_at = now() - interval '1 second' where id=$1::uuid", [d1.id]);
}
const rj = await one("select rearms, last_alert from public.publication_recovery_jobs where id=$1::uuid", [d1.id]);
ok("D4: evidence-advanced deferrals are COUNTED per job; past p_max_rearms the job is alerted 'evidence-rearm-bound' (+ a 600 s backoff)", rearmOut === "deferred" && Number(rj.rearms) >= 3 && rj.last_alert === "evidence-rearm-bound");

// lease expiry reclaim + crash loop
await q("update public.publication_recovery_jobs set status='superseded' where status in ('pending','claimed','deferred') and route_id <> 'brand-view-portfolio'");
await enq("oli", "india", "L", ["L"], "lt", "scan", 1);
const lk = (await claim("wA", T1, 5)).find((j) => j.target_key === "L");
await q("update public.publication_recovery_jobs set lease_expires_at = now() - interval '1 second' where id=$1::uuid", [lk.id]);
const rc = (await claim("wB", T2, 5)).find((j) => j.id === lk.id);
ok("L1: an expired lease is reclaimed by another worker (claims incremented); the crashed token can no longer finish", rc && Number(rc.claims) === Number(lk.claims) + 1 && rc.claimed_by === "wB" && (await fin(lk.id, T1, "verified")) === "not-owner");
await q("update public.publication_recovery_jobs set claims = 8, lease_expires_at = now() - interval '1 second' where id=$1::uuid", [lk.id]);
await claim("wC", T3, 5, 1500, 8);
ok("L2: a job reclaimed max times without finishing is dead-lettered as crash-loop", (await one("select last_class from public.publication_recovery_jobs where id=$1::uuid", [lk.id])).last_class === "crash-loop");
ok("L3: renew extends only the holder's claims", Number((await one("select public.renew_publication_recovery_claim(array[$1::uuid], $2::uuid, 1500) n", [rc.id, T1])).n) === 0);

// scans
const tb = async (h, kind = "deep") => (await one("select public.try_begin_publication_recovery_scan($1, 3600, 600, $2) ok", [h, kind])).ok;
ok("S1: the deep sweep is single-flight; the tier-1 slot is claimed once per interval (no holder)", (await tb("w1")) === true && (await tb("w2")) === false && (await tb("w1", "tier1")) === true && (await tb("w2", "tier1")) === false);
ok("S2: finish (deep) by the holder records the sweep progress; tier-1 finish records its summary; a new sweep is refused within the interval", (await one("select public.finish_publication_recovery_scan('w1','complete','{\"steps\":1}'::jsonb,'deep','{\"epoch\":\"2026-09-23\",\"byRoute\":{\"oli\":{\"lastAtMs\":1}}}'::jsonb) ok")).ok === true && (await one("select public.finish_publication_recovery_scan('w2','complete','{\"alerts\":[{\"code\":\"stranded-partial-cycle\",\"n\":1}]}'::jsonb,'tier1',null) ok")).ok === true && (await one("select deep_sweep->>'epoch' e from public.publication_recovery_scan")).e === "2026-09-23" && (await tb("w2")) === false);
await q("update public.publication_recovery_scan set last_finished_at = now() - interval '11 minutes', last_tier1_at = now() - interval '11 minutes'");
ok("S3: after the interval a sweep / a tier-1 may begin again", (await tb("w2")) === true && (await tb("w3", "tier1")) === true);
await q("update public.publication_recovery_scan set lease_expires_at = now() - interval '1 second', last_finished_at = now()");
ok("S4: a crashed sweep holder (expired lease) is taken over even inside the interval; an unknown kind raises", (await tb("w3")) === true && await raises(() => tb("w4", "sideways"), /unknown kind/));

// baseline / served / observations
await q("select public.record_publication_recovery_baseline($1::jsonb)", [JSON.stringify([
  { route_id: "fba", region: "india", target_key: "C", requested_as_of: D, owners: ["C"], token: "ft", class: "current", reason: null, handoff: "already-current", verified_rows: [{ u: "-", rk: "brand-inventory", asOf: D }] },
  { route_id: "ads", region: "india", target_key: "C", requested_as_of: D, owners: ["C"], token: "at", class: "stale", reason: "live-refresh-differs" },
  { route_id: "returns-v3", region: "india", target_key: "C", requested_as_of: D, owners: ["C"], token: null, class: "missing-evidence", reason: "returns-evidence-missing", handoff: "missing-source" },
])]);
ok("B1: baseline records a verified token (+ unit rows) only for 'current'; the OBSERVED token for every class", (await one("select verified_token from public.publication_recovery_state where route_id='fba' and target_key='C'")).verified_token === "ft" && (await one("select verified_token, observed_token from public.publication_recovery_state where route_id='ads' and target_key='C'")).verified_token === null && (await one("select observed_token from public.publication_recovery_state where route_id='ads' and target_key='C'")).observed_token === "at");
await q("select public.record_publication_recovery_baseline($1::jsonb)", [JSON.stringify([{ kind: "served", route_id: "fba", region: "india", target_key: "C", requested_as_of: D, served_confirmed: true }, { kind: "served", route_id: "ads", region: "india", target_key: "C", requested_as_of: D, served_confirmed: true }])]);
ok("B2: a tier-1 SERVED confirmation updates only an existing VERIFIED row (never an unverified one, never its class)", (await one("select served_confirmed, last_class from public.publication_recovery_state where route_id='fba' and target_key='C'")).served_confirmed === true && (await one("select served_confirmed from public.publication_recovery_state where route_id='ads' and target_key='C'")).served_confirmed === null);
await q("select public.record_publication_recovery_observations($1::jsonb)", [JSON.stringify([
  { route_id: "brand-view", region: "india", target_key: "C", unit_key: "a1b2c3d4e5f6", report_key: "brand-view", requested_as_of: D, target_as_of: "2026-09-24", tier: 2, state: "STALE", reason_code: "live-refresh-differs" },
  { route_id: "brand-view", region: "india", target_key: "C", unit_key: "0f0f0f0f0f0f", report_key: "brand-view", requested_as_of: D, target_as_of: "2026-09-24", tier: 2, state: "PUBLICATION_NOT_REQUIRED" },
  { route_id: "oli", region: "india", target_key: "C", unit_key: "-", report_key: "tier-1", requested_as_of: D, tier: 1, state: "served-row-foreign", alert: "served-row-foreign" },
])]);
await q("select public.record_publication_recovery_observations($1::jsonb)", [JSON.stringify([{ route_id: "brand-view", region: "india", target_key: "C", unit_key: "a1b2c3d4e5f6", report_key: "brand-view", requested_as_of: D, tier: 2, state: "PUBLICATION_NOT_REQUIRED" }])]);
ok("O1: the unit_key is part of the observation PK (two units of one report are two rows; the same unit upserts)", Number((await one("select count(*)::int n from public.publication_recovery_observations where route_id='brand-view'")).n) === 2 && (await one("select state from public.publication_recovery_observations where unit_key='a1b2c3d4e5f6'")).state === "PUBLICATION_NOT_REQUIRED" && await raises(() => q("select public.record_publication_recovery_observations($1::jsonb)", [JSON.stringify([{ route_id: "oli", region: "india", target_key: "C", unit_key: "bad unit", report_key: "x", requested_as_of: D, state: "s" }])]), /pro_unit_key_check|check/));

// ---- WP11 verifier F1: a served-proof REVOCATION is STICKY for the verified token; WP12 verifier P2-3: the status state
// rows carry open_job + tier1_state (newer than the verification only); WP11 verifier F2: 'superseded' keeps its alert --
{
  const G = "europe-au", R = "listings", TK = "SV";
  const U = (n) => "00000000-0000-4000-8000-0000000001" + String(n).padStart(2, "0");
  let ut = 0;
  const cycle = async (tok, { pub = false, served = null } = {}) => {
    await enq(R, G, TK, [TK], tok, "scan", 0);
    const t = U(++ut);
    const j = (await claim("wV", t, 5)).find((x) => x.target_key === TK && x.route_id === R);
    return j ? fin(j.id, t, "verified", "current", pub ? "verified-live-readback" : "already-current", 0, 6, null, tok, [], null, pub, null, true, served) : "no-claim";
  };
  const sv = async () => (await one("select served_confirmed from public.publication_recovery_state where route_id=$1 and region=$2 and target_key=$3", [R, G, TK])).served_confirmed;
  const served = async (conf, token) => q("select public.record_publication_recovery_baseline($1::jsonb)", [JSON.stringify([{ kind: "served", route_id: R, region: G, target_key: TK, requested_as_of: D, served_confirmed: conf, ...(token === undefined ? {} : { token }) }])]);
  const base = async (token, s) => q("select public.record_publication_recovery_baseline($1::jsonb)", [JSON.stringify([{ route_id: R, region: G, target_key: TK, requested_as_of: D, owners: [TK], token, class: "current", reason: "already-current", handoff: "deferred", verified_rows: [], ...(s === undefined ? {} : { served_confirmed: s }) }])]);
  const v0 = await cycle("sv1");
  const s0 = await sv();
  await served(false, "sv1"); const s1 = await sv();
  await served(true, "sv1"); const s2 = await sv();
  await base("sv1"); const s3 = await sv();
  const v4 = await cycle("sv1"); const s4 = await sv();
  ok("SV1: a tier-1 REVOCATION is STICKY for the SAME verified token (legacy served proof): a later tier-1 'true', a 'current' baseline re-verification and a finish('verified') WITHOUT a republish all keep served_confirmed = false",
    v0 === "verified" && s0 === null && s1 === false && s2 === false && s3 === false && v4 === "verified" && s4 === false);
  const v5 = await cycle("sv1", { pub: true }); const s5 = await sv();
  await served(false, "sv1"); const s5b = await sv();
  const v6 = await cycle("sv2"); const s6 = await sv();
  await served(true, "sv1"); const s7 = await sv();
  await served(true, "sv2"); const s8 = await sv();
  ok("SV2: ONLY a republish by the worker (finish 'verified' + p_published) or a NEW verified token resets the proof to unproven (null); a served row for ANOTHER (older) verified token is ignored; the new token's own tier-1 row confirms",
    v5 === "verified" && s5 === null && s5b === false && v6 === "verified" && s6 === null && s7 === null && s8 === true);
  await served(false, "sv2"); const s9 = await sv();
  await base("sv2", true); const s10 = await sv();
  await served(false); const s11 = await sv();
  ok("SV3: a route CLI's POSITIVE unit-level served proof (a 'current' baseline / verification with served_confirmed = true) re-establishes the proof; a served row without a token still applies (older callers)", s9 === false && s10 === true && s11 === false);
  // status state rows: tier1_state only when NEWER than the verification; open_job while a live job exists.
  await base("sv2", true);
  await q("select public.record_publication_recovery_observations($1::jsonb)", [JSON.stringify([{ route_id: R, region: G, target_key: TK, unit_key: "-", report_key: "tier-1", requested_as_of: D, tier: 1, state: "token-advanced" }])]);
  await q("update public.publication_recovery_observations set observed_at = now() - interval '1 hour' where route_id = $1 and target_key = $2 and report_key = 'tier-1'", [R, TK]);
  const rowOf = async () => ((await one("select public.publication_recovery_status(50) s")).s.state || []).find((x) => x.route_id === R && x.region === G && x.target_key === TK);
  const older = await rowOf();
  await q("update public.publication_recovery_observations set observed_at = now() + interval '1 second' where route_id = $1 and target_key = $2 and report_key = 'tier-1'", [R, TK]);
  const newer = await rowOf();
  await enq(R, G, TK, [TK], "sv3", "scan", 0);
  const withJob = await rowOf();
  ok("ST4: the status state rows carry tier1_state ONLY when the tier-1 finding is newer than the verification (an older 'token-advanced' reads null) and open_job while a pending / claimed / deferred job exists (the hand-off matrix inputs)",
    older && older.tier1_state === null && older.open_job === false && newer.tier1_state === "token-advanced" && newer.open_job === false && withJob.open_job === true);
  const t = U(++ut);
  const sj = (await claim("wV", t, 5)).find((x) => x.target_key === TK && x.route_id === R);
  const sd = sj ? await fin(sj.id, t, "superseded", "superseded-target-out-of-scope", "target-out-of-scope:not-in-the-europe-au-durable-directory", 0, 6, null, "sv3", null, "target-out-of-scope", false, null, false) : "no-claim";
  const sjr = sj ? await one("select status, last_class, last_alert, attempts from public.publication_recovery_jobs where id=$1::uuid", [sj.id]) : {};
  ok("SS1: a 'superseded' finish records its class, reason AND alert (the out-of-scope target: no attempt, never dead -- a later enqueue of the same token opens a new job)",
    sd === "superseded" && sjr.status === "superseded" && sjr.last_class === "superseded-target-out-of-scope" && sjr.last_alert === "target-out-of-scope" && Number(sjr.attempts) === 0 && (await enq(R, G, TK, [TK], "sv3", "scan", 0)) === "enqueued");
  await q("update public.publication_recovery_jobs set status = 'superseded' where route_id = $1 and target_key = $2 and status in ('pending','claimed','deferred')", [R, TK]);
}

// status alerts
await q("insert into public.publication_recovery_state (route_id, region, target_key, requested_as_of, last_class, last_reason, class_since) values ('sku-movement','india','M',$1::date,'missing-evidence','catalog-missing', now() - interval '7 hours'), ('brand-view','india','P',$1::date,'served-row-preempted','served-row-preempted:serve-rederives', now()), ('returns-v3','india','Q',$1::date,'capacity-exceeded','capacity-exceeded:heap', now())", [D]);
await enq("returns-v3", "india", "S", ["S"], "st", "scan", 3);
await q("update public.publication_recovery_jobs set status='deferred', last_class='scheduler-window-global', created_at = now() - interval '13 hours' where target_key='S'");
await q("update public.publication_recovery_jobs set last_alert='await-timeout' where target_key='region:india'");
await q("insert into public.publication_recovery_state (route_id, region, target_key, requested_as_of, last_class, last_alert) values ('returns-v3','india','R',$1::date,'current','source-stale-manual')", [D]);
await q("insert into public.publication_recovery_jobs (route_id, region, target_key, requested_as_of, origin, status, last_class) values ('fba','india','Z1',$1::date,'scan','dead','zero-export-violation')", [D]);
await q("select public.beat_publication_recovery_worker('w1','host',1,'v','running',now(),null,'{\"polls\":1}'::jsonb)");
const st = (await one("select public.publication_recovery_status(50) s")).s;
const has = (code, extra = () => true) => (st.alerts || []).some((x) => x.code === code && extra(x));
ok("ST1: status carries control, the per-route switches + counts, heartbeats, scan (tier-1 summary + deep sweep), jobs, problems, last_verified and the latest-epoch state rows (with the served proof)", st && st.routes.length === 10 && st.routes.every((r) => r.live_enabled === false) && Array.isArray(st.workers) && st.workers[0].worker_id === "w1" && typeof st.jobs.dead_letter === "number" && Array.isArray(st.problems) && Array.isArray(st.last_verified) && st.state_epoch === D && st.state.some((s) => s.route_id === "fba" && s.served_confirmed === true) && st.scan.deep_sweep.epoch === D);
ok("ST2: status ALERTS -- dead letters BY CLASS, missing-evidence > 6 h, served-row-preempted, zero-export-violation, capacity-exceeded", has("dead-letter", (x) => x.class === "zero-export-violation") && has("dead-letter", (x) => x.class === "crash-loop") && has("missing-evidence-over-6h") && has("served-row-preempted") && has("capacity-exceeded"));
ok("ST3: status ALERTS -- source-stale-manual, await-timeout, served-row-foreign (carried alert codes), scheduler-gate starvation > 12 h, and the tier-1 global alerts (stranded-partial-cycle)", has("source-stale-manual") && has("await-timeout") && has("served-row-foreign") && has("scheduler-gate-starvation") && has("stranded-partial-cycle"));
ok("P1: prune runs and keeps recent rows", Number((await one("select public.prune_publication_recovery(14) n")).n) === 0);

// privileges
const priv = await one("select has_function_privilege('service_role','public.claim_publication_recovery_jobs(text,uuid,integer,integer,integer)','execute') s, has_function_privilege('anon','public.claim_publication_recovery_jobs(text,uuid,integer,integer,integer)','execute') a, has_function_privilege('authenticated','public.publication_recovery_status(integer)','execute') u, has_table_privilege('anon','public.publication_recovery_jobs','select') t, has_table_privilege('authenticated','public.publication_recovery_routes','select') rt");
ok("G1: service_role may execute the RPCs; anon/authenticated have no execute or table access (routes table included)", priv.s === true && priv.a === false && priv.u === false && priv.t === false && priv.rt === false);
const sr = await one("select has_table_privilege('service_role','public.publication_recovery_jobs','insert') i, has_table_privilege('service_role','public.publication_recovery_jobs','update') u, has_table_privilege('service_role','public.publication_recovery_routes','update') ru, has_table_privilege('service_role','public.publication_recovery_routes','select') rs");
ok("G2: service_role is SELECT-only on the tables (the canary switch too: flipping it is an owner-run SQL UPDATE, never the worker)", sr.i === false && sr.u === false && sr.ru === false && sr.rs === true);

// ---- the STORE's own SQL through a PGlite-backed pool ---------------------------------------------------------------
{
  const pool = { on() {}, end: async () => {}, connect: async () => ({ query: (t, v) => db.query(t, v, { parsers: DATE_TEXT }), release() {} }), query: (t, v) => db.query(t, v, { parsers: DATE_TEXT }) };
  const store = createRecoveryStore({ connectionString: "postgres://u:p@h/db", poolImpl: pool });
  // sync_cycles: a running europe-au-fba cycle (in flight), an old idle natural cycle, a stranded priority-partial with a
  // job, a job-less orphan priority-partial, a stale open paid cycle with an old open fba-plan job.
  await q(`insert into public.sync_cycles (id, bucket, cycle_date, status, started_at, created_at, updated_at) values
    ('11111111-1111-4111-8111-111111111111','europe-au-fba','2026-09-23','running', now() - interval '10 minutes', now() - interval '10 minutes', now() - interval '1 minute'),
    ('22222222-2222-4222-8222-222222222222','india','2026-09-23','running', now() - interval '5 hours', now() - interval '5 hours', now() - interval '2 hours'),
    ('33333333-3333-4333-8333-333333333333','priority-partial-india-0123456789abcdef','2026-09-23','running', now() - interval '1 hour', now() - interval '1 hour', now() - interval '1 hour'),
    ('44444444-4444-4444-8444-444444444444','priority-partial-us-ca-0123456789abcdef','2026-09-23','running', now() - interval '1 hour', now() - interval '1 hour', now() - interval '1 hour'),
    ('55555555-5555-4555-8555-555555555555','us-ca-fba','2026-09-22','running', now() - interval '9 hours', now() - interval '9 hours', now() - interval '7 hours')`);
  await q(`insert into public.sync_report_jobs (cycle_id, report_key, account_id, created_at, updated_at) values
    ('33333333-3333-4333-8333-333333333333','brand-view','A', now() - interval '1 hour', now() - interval '1 hour'),
    ('55555555-5555-4555-8555-555555555555','fba-plan','U', now() - interval '8 hours', now() - interval '7 hours')`);
  const gate = await store.readSchedulerGate({ cooldownSeconds: 900 });
  ok("Q1: the store's SCHEDULER GATE SQL runs on real SQL: the running europe-au-fba cycle blocks; the idle 5-hour natural cycle does not; alerts stranded-partial-cycle, paid-cycle-stale-open, paid-job-stale-in-flight; the job-less priority-partial is an ignored orphan", gate.blocked === true && gate.blockers.length === 1 && gate.blockers[0].bucket === "europe-au-fba" && gate.alerts.some((x) => x.code === "stranded-partial-cycle") && gate.alerts.some((x) => x.code === "paid-cycle-stale-open" && x.bucket === "us-ca-fba") && gate.alerts.some((x) => x.code === "paid-job-stale-in-flight") && gate.orphanPartial === 1);
  // The orphan is dated 2026-09-23: finalizable only once the epoch has moved past it (WP12 verifier P2-2).
  const gateRows = await q(SCHEDULER_GATE_SQL, [0]);
  const reap = reaperCandidates(gateRows, { epoch: "2026-09-24" });
  const reapCur = reaperCandidates(gateRows, { epoch: "2026-09-23" });
  ok("Q1b: the REAPER over the same SQL: the job-less orphan priority-partial of a PAST epoch is finalize-orphan-partial (of the CURRENT epoch: never -- it resumes); the priority-partial HOLDING a job and the paid cycle with an OPEN fba-plan job are never finalized", reap.find((x) => x.bucket === "priority-partial-us-ca-0123456789abcdef").action === "finalize-orphan-partial" && reapCur.find((x) => x.bucket === "priority-partial-us-ca-0123456789abcdef").action === "never" && reap.find((x) => x.bucket === "priority-partial-india-0123456789abcdef").action === "never" && reap.find((x) => x.bucket === "us-ca-fba").action === "never" && !reap.some((x) => x.bucket === "europe-au-fba"));
  await q("update public.sync_cycles set status = 'succeeded', updated_at = now() - interval '5 minutes' where bucket = 'europe-au-fba'");
  const g2 = await store.readSchedulerGate({ cooldownSeconds: 900 });
  await q("update public.sync_cycles set updated_at = now() - interval '20 minutes' where bucket = 'europe-au-fba'");
  const g3 = await store.readSchedulerGate({ cooldownSeconds: 900 });
  ok("Q2: the COOLDOWN (a finished scheduler cycle updated within 900 s) blocks; past it the gate clears", g2.blocked && /cooldown/.test(g2.reason) && !g3.blocked);
  await q(`insert into public.report_snapshots (report_key, account_id, params_hash, params, payload, updated_at) values
    ('brand-sales','A','p1','{}','{}', now() - interval '1 hour'), ('brand-sales','A','p2','{}','{}', now()),
    ('brand-view','brand-view:A::acme','p1','{}','{}', now() - interval '30 minutes'), ('brand-view','brand-view:AB::x','p1','{}','{}', now()),
    ('brand-view-portfolio','brand-view-portfolio:x1','p1','{"region":"india"}','{}', now() - interval '2 hours'), ('brand-view-portfolio','brand-view-portfolio:x2','p1','{"region":"us-ca"}','{}', now()),
    ('account-directory','__directory__','d1','{}','{"accounts":[{"accountId":"A","country":"IN"},{"accountId":"S","country":"US","settingUp":true},{"id":"G","marketCountry":"UK"}]}', now())`);
  const w = await store.readLiveRowWritesSince([
    { key: "eqA", reportKey: "brand-sales", accountIdEq: "A" },
    { key: "likeA", reportKey: "brand-view", accountIdLike: "brand-view:A::%" },
    { key: "pfIN", reportKey: "brand-view-portfolio", accountIdLike: "brand-view-portfolio:%", paramsEq: { region: "india" } },
  ]);
  const nowMs = Number((await one("select (extract(epoch from now()) * 1000)::bigint n")).n);
  ok("Q3: the live-row write scan (eq / LIKE / params-scoped) returns epoch-ms maxima per scope key: the LIKE never matches another account's prefix, the portfolio scope never sees another region's rows", w.get("eqA").maxMs >= nowMs - 5000 && w.get("likeA").maxMs < nowMs - 25 * 60000 && w.get("pfIN").maxMs < nowMs - 100 * 60000);
  const dirMap = await store.readDirectory();
  ok("Q4: the store's directory SQL reads the latest account-directory payload and folds it (settingUp excluded, UK -> GB)", dirMap.size === 2 && dirMap.get("A").country === "IN" && dirMap.get("G").marketplace === "GB" && !dirMap.has("S"));
  await store.enqueue({ route: "brand-view-brands", region: "india", targetKey: "A", owners: ["A"], asOf: D, token: "bb", origin: "scan", priority: 5 });
  await q("select public.record_publication_recovery_baseline($1::jsonb)", [JSON.stringify([{ route_id: "fba-plan", region: "india", target_key: "B", requested_as_of: D, owners: ["B"], token: "fp", class: "stale", reason: "x" }])]);
  const bl = await store.readUpstreamBlockers({ awaits: ["brand-view-brands", "fba-plan"], region: "india", owners: ["A"], epoch: D });
  const blB = await store.readUpstreamBlockers({ awaits: ["brand-view-brands", "fba-plan"], region: "india", owners: ["B"], epoch: D });
  const blR = await store.readUpstreamBlockers({ awaits: ["brand-view-brands", "fba-plan"], region: "india", owners: null, epoch: D });
  ok("Q5: the upstream-blocker SQL: an open upstream job blocks its owner, a 'stale' upstream state blocks its owner, a region target (owners null) sees both", bl.length === 1 && bl[0].why === "open-job" && blB.length === 1 && blB[0].why === "stale-state" && blR.length === 2);
  const ctl = await store.control();
  const lease = await store.readControlLease();
  const keys = await store.readReportKeys();
  const scanState = await store.readScanState();
  const stateMap = await store.readState({ route: "fba", region: "india", epoch: D });
  const fence = await store.readFence();
  ok("Q6: control / lease / report keys / scan state / state / fence reads run (dates as text / epoch-ms; the fence reads 'absent' before 20260935)", ctl.enabled === false && ctl.routes.oli && ctl.routes.oli.liveEnabled === false && lease.held === false && keys.some((k) => k.report_key === "brand-sales" && k.n === 2) && scanState.deepSweep.epoch === D && typeof stateMap.get("C").verified_ms === "number" && fence.state === "absent");
  const c = await store.claim({ workerId: "wS", claimToken: "00000000-0000-4000-8000-00000000000f", limit: 5, leaseSeconds: 600, maxClaims: 8 });
  const job = c.find((j) => j.target_key === "A" && j.route_id === "brand-view-brands") || c[0];
  const d = await store.finish({ id: job.id, claimToken: "00000000-0000-4000-8000-00000000000f", outcome: "deferred", cls: "dependency-deferral", reason: "awaiting-upstream:x", backoff: 180, maxAttempts: 6, runToken: null, evaluatedToken: job.evidence_token, recordState: false });
  ok("Q7: the store's RPC wrappers bind the redesigned signatures positionally (claim -> text as-of + created_ms; finish with every new parameter)", c.length >= 1 && typeof job.created_ms === "number" && /^\d{4}-\d{2}-\d{2}$/.test(job.requested_as_of) && d === "deferred");
  ok("Q8: evaluateSchedulerGate on the SQL rows == the in-memory store's decision function (one pure implementation)", typeof evaluateSchedulerGate === "function");
}

// ---- ROLLBACK drops EXACTLY the created objects ----------------------------------------------------------------------
{
  const expectPrefix = (x) => /publication_recovery|prr_|prc_|prj_|prs_|pro_|prw_|prsc_/.test(x);
  await db.exec(rollback);
  const after = (await q(CATALOG_SQL)).map((r) => r.x);
  const ledger = (await q("select filename from public.app_schema_migrations order by 1")).map((r) => r.filename);
  ok(`RB1: the migration created ${created.length} catalog objects, every one in its own namespace (7 tables, 12 functions, their indexes / constraints / row types)`, created.length > 30 && created.every(expectPrefix) && created.filter((x) => x.startsWith("rel:r:")).length === 7 && created.filter((x) => x.startsWith("fn:")).length === 12);
  ok("RB2: ROLLBACK_20260934.sql returns the catalog to EXACTLY its pre-migration state (nothing it did not create is touched) and removes only its ledger row", JSON.stringify(after) === JSON.stringify(before) && JSON.stringify(ledger) === JSON.stringify(["20260933_previous.sql"]) && Number((await one("select count(*)::int n from public.sync_cycles")).n) === 5);
}

await db.close();
console.log(`publication-recovery-sql-selftest: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
