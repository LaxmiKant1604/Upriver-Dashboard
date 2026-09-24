// Publication recovery worker -- REAL SQL self-test of supabase/migrations/20260934 in an in-process Postgres (PGlite,
// WASM). Proves the migration applies (idempotently) and that its RPCs implement the semantics the worker + the in-memory
// test store rely on. NEVER touches a real database.
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

let passed = 0, failed = 0;
const ok = (name, cond) => { if (cond) { passed += 1; console.log("  ok " + name); } else { failed += 1; console.log("  FAIL " + name); } };
const db = new PGlite();
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];
const sql = readFileSync(path.join(appRoot, "supabase", "migrations", "20260934_publication_recovery_worker.sql"), "utf8");

// Supabase roles the grants reference.
await db.exec("create role anon nologin; create role authenticated nologin; create role service_role nologin;");
await db.exec(sql);
await db.exec(sql); // idempotent re-apply
ok("M1: migration applies and re-applies cleanly (idempotent)", true);
const ctl = await one("select enabled, live_families from public.publication_recovery_control");
ok("M2: control defaults disabled with no live families", ctl.enabled === false && Array.isArray(ctl.live_families) && ctl.live_families.length === 0);

const enq = async (f, r, a, d, tok, origin = "scan", pr = 5) => (await one("select public.enqueue_publication_recovery_job($1,$2,$3,$4::date,$5,$6,$7::smallint) d", [f, r, a, d, tok, origin, pr])).d;
const claim = async (w, tok, lim = 5, lease = 1500, maxc = 8) => q("select * from public.claim_publication_recovery_jobs($1,$2::uuid,$3,$4,$5)", [w, tok, lim, lease, maxc]);
const fin = async (id, tok, outcome, cls = null, reason = null, backoff = 60, maxA = 6, run = null, vtok = null) => (await one("select public.finish_publication_recovery_job($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9) d", [id, tok, outcome, cls, reason, backoff, maxA, run, vtok])).d;
const T1 = "00000000-0000-4000-8000-000000000001", T2 = "00000000-0000-4000-8000-000000000002", T3 = "00000000-0000-4000-8000-000000000003";
const D = "2026-09-23";

// enqueue coalescing
// Family priorities exactly as the worker enqueues them (registry.js): oli 1, ads 3, fba 4, listings 5.
ok("E1: enqueue -> enqueued; same token -> exists; new token -> refreshed", (await enq("oli", "india", "A", D, "t1", "scan", 1)) === "enqueued" && (await enq("oli", "india", "A", D, "t1", "scan", 1)) === "exists" && (await enq("oli", "india", "A", D, "t2", "scan", 1)) === "refreshed" && (await one("select evidence_token from public.publication_recovery_jobs where account_id='A'")).evidence_token === "t2");
ok("E2: exactly one live job per key (partial unique index)", Number((await one("select count(*)::int n from public.publication_recovery_jobs where account_id='A'")).n) === 1);
await enq("oli", "india", "B", D, "t1", "scan", 1); await enq("fba", "india", "C", D, "t1", "scan", 4); await enq("oli", "us-ca", "Z", D, "t1", "scan", 1);

// coherent claims + no overlap
const c1 = await claim("w1", T1, 5);
ok("C1: a claim returns ONE coherent (family, region, as-of) batch", c1.length === 2 && c1.every((j) => j.family === "oli" && j.region === "india"));
const c2 = await claim("w2", T2, 5);
ok("C2: a concurrent claim never overlaps (next group)", c2.length === 1 && !c1.some((x) => x.id === c2[0].id));
ok("C3: finish by a non-owner token is refused", (await fin(c1[0].id, T2, "verified")) === "not-owner");

// verified + already-verified + re-arm
const a = c1.find((j) => j.account_id === "A"), b = c1.find((j) => j.account_id === "B");
ok("V1: verified with the job's own token -> verified + state records it", (await fin(a.id, T1, "verified", "verified-live-readback", null, 0, 6, "run-1", "t2")) === "verified" && (await one("select verified_token from public.publication_recovery_state where account_id='A'")).verified_token === "t2");
ok("V2: a watermark with the proven token -> already-verified; a scan detection still enqueues", (await enq("oli", "india", "A", D, "t2", "watermark")) === "already-verified" && (await enq("oli", "india", "A", D, "t2", "scan")) === "enqueued");
ok("V3: verification for an older token RE-ARMS instead of verifying", (await fin(b.id, T1, "verified", null, null, 0, 6, null, "stale-token")) === "re-armed" && (await one("select status from public.publication_recovery_jobs where id=$1::uuid", [b.id])).status === "pending");

// retry -> dead, dead-same-evidence
await q("update public.publication_recovery_jobs set status='dead' where account_id='A' and status in ('pending','claimed','deferred')"); // clear the scan re-enqueue for this test
const r1 = (await claim("w1", T3, 5)).find((j) => j.account_id === "B");
ok("R1: retry -> attempts+1, pending, next attempt in the future", (await fin(r1.id, T3, "retry", "timeout", "x", 300, 2, null, r1.evidence_token)) === "retry" && (await one("select attempts, status, next_attempt_at > now() fut from public.publication_recovery_jobs where id=$1::uuid", [r1.id])).fut === true);
await q("update public.publication_recovery_jobs set next_attempt_at = now() - interval '1 second' where id=$1::uuid", [r1.id]);
const r2 = (await claim("w1", T1, 5)).find((j) => j.id === r1.id);
ok("R2: the attempt cap dead-letters (never loops)", r2 && (await fin(r1.id, T1, "retry", "timeout", "x", 300, 2, null, r2.evidence_token)) === "dead" && (await one("select status, last_class from public.publication_recovery_jobs where id=$1::uuid", [r1.id])).last_class === "max-attempts:timeout");
ok("R3: the same evidence is never re-enqueued after dead-lettering", (await enq("oli", "india", "B", D, "t1")) === "dead-same-evidence" && (await enq("oli", "india", "B", D, "t9")) === "enqueued");

// deferred + released + superseded
const d1 = (await claim("w1", T2, 5))[0];
ok("D1: deferred keeps attempts unchanged and resets the consecutive-claim count", (await fin(d1.id, T2, "deferred", "contention", null, 120, 6, null, d1.evidence_token)) === "deferred" && Number((await one("select attempts from public.publication_recovery_jobs where id=$1::uuid", [d1.id])).attempts) === 0 && Number((await one("select claims from public.publication_recovery_jobs where id=$1::uuid", [d1.id])).claims) === 0);
ok("D2: a refreshed token re-arms a deferred job to pending", (await enq(d1.family, d1.region, d1.account_id, D, "brand-new")) === "refreshed" && (await one("select status from public.publication_recovery_jobs where id=$1::uuid", [d1.id])).status === "pending");
const rl = (await claim("w1", T3, 5))[0];
ok("D3: released hands the job back with claims restored", (await fin(rl.id, T3, "released")) === "released" && Number((await one("select claims from public.publication_recovery_jobs where id=$1::uuid", [rl.id])).claims) === Number(rl.claims) - 1);

// lease expiry reclaim + crash loop
const lk = (await claim("wA", T1, 5))[0];
await q("update public.publication_recovery_jobs set lease_expires_at = now() - interval '1 second' where id=$1::uuid", [lk.id]);
const rc = (await claim("wB", T2, 5)).find((j) => j.id === lk.id);
ok("L1: an expired lease is reclaimed by another worker (claims incremented)", rc && Number(rc.claims) === Number(lk.claims) + 1 && rc.claimed_by === "wB");
ok("L2: the crashed worker's token can no longer finish it", (await fin(lk.id, T1, "verified")) === "not-owner");
await q("update public.publication_recovery_jobs set claims = 8, lease_expires_at = now() - interval '1 second' where id=$1::uuid", [lk.id]);
await claim("wC", T3, 5, 1500, 8);
ok("L3: a job reclaimed max times without finishing is dead-lettered as crash-loop", (await one("select status, last_class from public.publication_recovery_jobs where id=$1::uuid", [lk.id])).last_class === "crash-loop");
ok("L4: renew extends only the holder's claims", Number((await one("select public.renew_publication_recovery_claim(array[$1::uuid], $2::uuid, 1500) n", [rc.id, T1])).n) === 0);

// scan lease
const tb = async (h) => (await one("select public.try_begin_publication_recovery_scan($1, 3600, 600) ok", [h])).ok;
ok("S1: the full scan is single-flight", (await tb("w1")) === true && (await tb("w2")) === false);
ok("S2: finish by the holder; a new scan is refused within the interval", (await one("select public.finish_publication_recovery_scan('w1','complete','{\"steps\":1}'::jsonb) ok")).ok === true && (await tb("w2")) === false);
await q("update public.publication_recovery_scan set last_finished_at = now() - interval '11 minutes'");
ok("S3: after the interval a scan may begin again", (await tb("w2")) === true);
await q("update public.publication_recovery_scan set lease_expires_at = now() - interval '1 second', last_finished_at = now()");
ok("S4: a crashed scan holder (expired lease) is taken over even inside the interval", (await tb("w3")) === true);

// baseline / observations / heartbeat / status / prune / privileges
await q("select public.record_publication_recovery_baseline($1::jsonb)", [JSON.stringify([{ family: "fba", region: "india", account_id: "C", requested_as_of: D, token: "ft", class: "current", reason: null }, { family: "ads", region: "india", account_id: "C", requested_as_of: D, token: "at", class: "stale", reason: "live-refresh-differs" }])]);
ok("B1: baseline records a verified token only for 'current'", (await one("select verified_token from public.publication_recovery_state where family='fba' and account_id='C'")).verified_token === "ft" && (await one("select verified_token from public.publication_recovery_state where family='ads' and account_id='C'")).verified_token === null);
ok("B2: baseline records the OBSERVED token for every class (the watermark reacts only to changed evidence)", (await one("select observed_token from public.publication_recovery_state where family='ads' and account_id='C'")).observed_token === "at" && (await one("select observed_token from public.publication_recovery_state where family='fba' and account_id='C'")).observed_token === "ft");

// evidence refreshed while claimed -> a 'dead' (or retry/deferred) verdict on the OLD evidence re-arms instead
await q("update public.publication_recovery_jobs set status='superseded' where status in ('pending','claimed','deferred')");
await enq("fba", "us-ca", "EA", D, "old-ev", "scan", 4);
const ea = (await claim("w1", T1, 5)).find((j) => j.account_id === "EA");
await enq("fba", "us-ca", "EA", D, "new-ev", "watermark", 4);
const eaOut = await fin(ea.id, T1, "dead", "permanent-integrity", "payload-malformed", 0, 6, null, ea.evidence_token);
const eaRow = await one("select status, attempts, claims, evidence_token, last_class from public.publication_recovery_jobs where id=$1::uuid", [ea.id]);
ok("EA1: a dead verdict on evidence refreshed mid-run RE-ARMS (attempts+claims reset), never dead-letters untried evidence", eaOut === "re-armed" && eaRow.status === "pending" && Number(eaRow.attempts) === 0 && Number(eaRow.claims) === 0 && eaRow.evidence_token === "new-ev" && eaRow.last_class === "evidence-advanced" && (await enq("fba", "us-ca", "EA", D, "new-ev", "scan", 4)) === "exists");
// many normal claim->finish cycles never accumulate toward the crash-loop guard
for (let i = 0; i < 10; i += 1) {
  const c = (await claim("w1", T2, 5, 1500, 5)).find((j) => j.id === ea.id);
  await fin(ea.id, T2, "deferred", "contention", null, 0, 6, null, c.evidence_token);
  await q("update public.publication_recovery_jobs set next_attempt_at = now() - interval '1 second' where id=$1::uuid", [ea.id]);
}
const crashClaim = (await claim("wX", T3, 5, 120, 5)).find((j) => j.id === ea.id); // worker dies holding it
await q("update public.publication_recovery_jobs set lease_expires_at = now() - interval '1 second' where id=$1::uuid", [ea.id]);
const after = (await claim("wY", T1, 5, 1500, 5)).find((j) => j.id === ea.id);
ok("CL1: 10 finished claims + 1 crash are NOT a crash loop (claims counts consecutive unfinished claims only)", crashClaim && Number(crashClaim.claims) === 1 && after && Number(after.claims) === 2 && after.status === "claimed");
await q("select public.record_publication_recovery_observations($1::jsonb)", [JSON.stringify([{ region: "india", account_id: "C", report_key: "brand-inventory", requested_as_of: D, family: "fba", state: "STALE", reason_code: "live-refresh-differs" }])]);
await q("select public.beat_publication_recovery_worker('w1','host',1,'v','running',now(),null,'{\"polls\":1}'::jsonb)");
const st = (await one("select public.publication_recovery_status(50) s")).s;
ok("ST1: status is redacted JSON with heartbeat, scan, jobs, problems, last_verified", st && Array.isArray(st.workers) && st.workers[0].worker_id === "w1" && st.jobs && typeof st.jobs.dead_letter === "number" && Array.isArray(st.problems) && st.problems[0].reason_code === "live-refresh-differs" && Array.isArray(st.last_verified));
ok("P1: prune runs and keeps recent rows", Number((await one("select public.prune_publication_recovery(14) n")).n) === 0);
ok("G1: service_role may execute the RPCs; anon/authenticated may not", (await one("select has_function_privilege('service_role','public.claim_publication_recovery_jobs(text,uuid,integer,integer,integer)','execute') s, has_function_privilege('anon','public.claim_publication_recovery_jobs(text,uuid,integer,integer,integer)','execute') a, has_function_privilege('authenticated','public.publication_recovery_status(integer)','execute') u")).s === true);
const priv = await one("select has_function_privilege('anon','public.claim_publication_recovery_jobs(text,uuid,integer,integer,integer)','execute') a, has_function_privilege('authenticated','public.publication_recovery_status(integer)','execute') u, has_table_privilege('anon','public.publication_recovery_jobs','select') t");
ok("G2: anon/authenticated have no execute or table access", priv.a === false && priv.u === false && priv.t === false);
const sr = await one("select has_table_privilege('service_role','public.publication_recovery_jobs','select') s, has_table_privilege('service_role','public.publication_recovery_jobs','insert') i, has_table_privilege('service_role','public.publication_recovery_jobs','update') u, has_table_privilege('service_role','public.publication_recovery_control','update') c");
ok("G3: service_role is SELECT-only on the tables (writes only through the RPC invariants)", sr.s === true && sr.i === false && sr.u === false && sr.c === false);

await db.close();
console.log(`publication-recovery-sql-selftest: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
