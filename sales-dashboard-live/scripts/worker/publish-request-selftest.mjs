// "Publish from saved data" -- OFFLINE SQL self-test of supabase/migrations/20260936_publish_requests.sql in an
// in-process Postgres (PGlite, WASM), plus the REAL executor core (lib/server/publish-request/worker-core.js) driven
// through those RPCs. NEVER touches a real database. Same harness convention as report-writer-fence-selftest.mjs:
//   npm install --prefix <dir> @electric-sql/pglite@0.5.8     # once, outside the repo (no package.json change)
//   PRW_PGLITE_DIR=<dir> node scripts/worker/publish-request-selftest.mjs
// Exit 0 = every assertion passed; 1 = a failure; 3 = PGlite not available (SKIPPED -- not a pass). 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dir = process.env.PRW_PGLITE_DIR || "";
const entry = dir ? path.join(dir, "node_modules", "@electric-sql", "pglite", "dist", "index.js") : null;
let PGlite;
try { ({ PGlite } = await import(entry && existsSync(entry) ? pathToFileURL(entry).href : "@electric-sql/pglite")); }
catch { console.log("SKIPPED: PGlite not available (set PRW_PGLITE_DIR; see header). This is NOT a pass."); process.exit(3); }

const { createPublishRequestWorker } = await import("../../lib/server/publish-request/worker-core.js");

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; console.log("  ok  " + name); };
const db = new PGlite();
await db.exec("create role anon nologin; create role authenticated nologin; create role service_role nologin;");
await db.exec(readFileSync(path.join(ROOT, "supabase", "migrations", "20260936_publish_requests.sql"), "utf8"));
// Idempotent re-apply (the migration is expand-only / create-if-not-exists / create-or-replace).
await db.exec(readFileSync(path.join(ROOT, "supabase", "migrations", "20260936_publish_requests.sql"), "utf8"));
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];
const enqueue = async (scope, user, asOf = "2026-09-30", report = "brand-view") => (await one("select public.enqueue_publish_request($1,$2,$3,$4,$5::date,$6) as r", [report, scope, "acct-1", "Acme", asOf, user])).r;
const claim = async (worker = "w1", token = randomUUID(), lease = 60) => ({ token, row: (await one("select public.claim_publish_request($1,$2::uuid,$3) as r", [worker, token, lease])).r });
const renew = async (id, token, lease = 60) => (await one("select public.renew_publish_request($1::uuid,$2::uuid,$3) as r", [id, token, lease])).r;
const finish = async (id, token, status, reason = null, result = null, retry = null) => (await one("select public.finish_publish_request($1::uuid,$2::uuid,$3,$4,$5::jsonb,$6) as r", [id, token, status, reason, result == null ? null : JSON.stringify(result), retry])).r;
const row = (id) => one("select * from public.publish_requests where id = $1::uuid", [id]);
const expire = (id) => db.query("update public.publish_requests set lease_expires_at = now() - interval '1 second' where id = $1::uuid", [id]);
const due = (id) => db.query("update public.publish_requests set next_attempt_at = now() - interval '1 second' where id = $1::uuid", [id]);
console.log("publish-request selftest (PGlite)");

// ---- S1 disabled at apply: nothing can be enqueued or claimed -------------------------------------------------------------
ok("S1 control row applied DISABLED with no report enabled", (await one("select enabled, cardinality(report_keys) n from public.publish_request_control")).enabled === false);
ok("S1 enqueue while disabled -> 'disabled' (no row)", (await enqueue("brand-view|acct-1|Acme", "u1")).outcome === "disabled" && (await one("select count(*)::int n from public.publish_requests")).n === 0);
ok("S1 claim while disabled -> null", (await claim()).row === null);

// ---- S2 enable brand-view; dedupe repeated clicks / other users -----------------------------------------------------------
await db.exec("update public.publish_request_control set enabled = true, report_keys = '{brand-view}'");
ok("S2 an unsupported report is refused 'report-not-enabled'", (await enqueue("brand-view-portfolio|x|Acme", "u1", "2026-09-30", "brand-view-portfolio")).outcome === "report-not-enabled");
const e1 = await enqueue("brand-view|acct-1|Acme", "u1");
const e2 = await enqueue("brand-view|acct-1|Acme", "u1");
const e3 = await enqueue("brand-view|acct-1|Acme", "u2");
const r1 = await row(e1.id);
ok("S2 first click enqueues; repeated clicks (same + another user) JOIN the SAME request", e1.outcome === "enqueued" && e2.outcome === "deduplicated" && e3.outcome === "deduplicated" && e2.id === e1.id && e3.id === e1.id);
ok("S2 ... request_count counts every click, last_requested_by = the latest user, requested_by = the first", r1.request_count === 3 && r1.last_requested_by === "u2" && r1.requested_by === "u1");
ok("S2 ... exactly ONE active row for the scope + date", (await one("select count(*)::int n from public.publish_requests where status in ('queued','publishing')")).n === 1);

// ---- S3 canary scope list ---------------------------------------------------------------------------------------------------
await db.exec("update public.publish_request_control set canary_scope_keys = '{brand-view|acct-1|Acme}'");
ok("S3 canary list set: another scope is refused 'scope-not-enabled'", (await enqueue("brand-view|acct-1|Zeta", "u1")).outcome === "scope-not-enabled");
ok("S3 ... the canary scope still dedupes", (await enqueue("brand-view|acct-1|Acme", "u3")).outcome === "deduplicated");

// ---- S4 claim ONE; claim token fences finish --------------------------------------------------------------------------------
const c1 = await claim("w1");
ok("S4 claim returns the ONE due request: publishing, attempt 1, run token, lease", c1.row && c1.row.id === e1.id && c1.row.status === "publishing" && c1.row.attempts === 1 && /^psr-[0-9a-f]{32}-1$/.test(c1.row.run_token) && !!c1.row.lease_expires_at);
ok("S4 a second executor claims NOTHING while the lease is live (one request at a time per scope)", (await claim("w2")).row === null);
ok("S4 renew by the owner -> true; by a stranger token -> false", (await renew(e1.id, c1.token)) === true && (await renew(e1.id, randomUUID())) === false);
ok("S4 finish with a foreign claim token -> 'not-owner' (no change)", (await finish(e1.id, randomUUID(), "published")).outcome === "not-owner" && (await row(e1.id)).status === "publishing");

// ---- S5 crash: the lease expires -> re-claimed (attempt 2) -> the dead claimant can no longer finish ---------------------------
await expire(e1.id);
const c2 = await claim("w2");
ok("S5 an EXPIRED lease is re-claimed (crash resume): attempt 2, prior_run_token = attempt 1's run token", c2.row && c2.row.id === e1.id && c2.row.attempts === 2 && c2.row.prior_run_token === c1.row.run_token && /-2$/.test(c2.row.run_token));
ok("S5 ... the crashed claimant's late finish is refused 'not-owner'", (await finish(e1.id, c1.token, "published")).outcome === "not-owner");
ok("S5 ... the new owner finishes 'published' with its result", (await finish(e1.id, c2.token, "published", "served-row-verified", { served: { id: "x" } })).status === "published" && (await row(e1.id)).finished_at !== null && (await row(e1.id)).claim_token === null);
ok("S5 after a terminal state a NEW click opens a NEW request (never reopens the finished one)", (await enqueue("brand-view|acct-1|Acme", "u1")).outcome === "enqueued");

// ---- S6 release keeps the attempt; retry consumes it; max_attempts -> failed -------------------------------------------------
const cur = await one("select id from public.publish_requests where status = 'queued' limit 1");
await db.query("update public.publish_requests set max_attempts = 2 where id = $1::uuid", [cur.id]);
let c = await claim("w1");
ok("S6 'release' (load gate) puts it back queued WITHOUT consuming the attempt and records the waiting reason", (await finish(cur.id, c.token, "release", "waiting:scheduler-running", null, 30)).outcome === "requeued" && (await row(cur.id)).attempts === 0 && (await row(cur.id)).reason === "waiting:scheduler-running");
ok("S6 ... it is not due until next_attempt_at", (await claim("w1")).row === null);
await due(cur.id); c = await claim("w1");
ok("S6 'retry' consumes the attempt (attempt 1 -> queued)", (await finish(cur.id, c.token, "retry", "evidence-advanced", null, 30)).status === "queued" && (await row(cur.id)).attempts === 1);
await due(cur.id); c = await claim("w1");
ok("S6 at max_attempts a retry closes it 'failed' (attempts-exhausted:<reason>)", (await finish(cur.id, c.token, "retry", "transport")).status === "failed" && (await row(cur.id)).reason === "attempts-exhausted:transport");
// an expired lease on an exhausted request is closed by the claim sweep, never re-claimed
const e4 = await enqueue("brand-view|acct-1|Acme", "u1");
await db.query("update public.publish_requests set max_attempts = 1 where id = $1::uuid", [e4.id]);
c = await claim("w1"); await expire(e4.id);
ok("S6 an EXPIRED lease on the last attempt is closed 'failed' by the next claim (crash-loop guard)", (await claim("w2")).row === null && (await row(e4.id)).status === "failed" && (await row(e4.id)).reason.startsWith("attempts-exhausted:"));

// ---- S7 per-user rate limit + queue cap --------------------------------------------------------------------------------------
await db.exec("update public.publish_request_control set canary_scope_keys = '{}', per_user_hourly = 2, max_active = 2");
await db.exec("delete from public.publish_requests");
ok("S7 per-user hourly limit", (await enqueue("brand-view|acct-1|A", "u9")).outcome === "enqueued" && (await enqueue("brand-view|acct-1|B", "u9")).outcome === "enqueued" && (await enqueue("brand-view|acct-1|C", "u9")).outcome === "rate-limited");
ok("S7 global active cap", (await enqueue("brand-view|acct-1|D", "u8")).outcome === "queue-full");
ok("S7 ... a click on an ACTIVE scope still joins it at the cap (dedupe precedes the limits)", (await enqueue("brand-view|acct-1|A", "u8")).outcome === "deduplicated");

// ---- S8 constraints + grants ---------------------------------------------------------------------------------------------------
let threw = false;
try { await db.query("insert into public.publish_requests (report_key, scope_key, account_id, as_of, requested_by, status) values ('brand-view','brand-view|a|b','a','2026-09-30','u','publishing')"); } catch { threw = true; }
ok("S8 a 'publishing' row without a claim token + lease violates pr_claim_consistent", threw);
threw = false;
try { await db.query("insert into public.publish_requests (report_key, scope_key, account_id, as_of, requested_by, status) values ('brand-view','brand-view|a|b','a','2026-09-30','u','done')"); } catch { threw = true; }
ok("S8 an unknown status is refused by pr_status_check", threw);
const priv = await one(`select
  has_table_privilege('anon','public.publish_requests','select') a1, has_table_privilege('authenticated','public.publish_requests','select') a2,
  has_table_privilege('service_role','public.publish_requests','select') s1, has_table_privilege('service_role','public.publish_requests','insert') s2,
  has_function_privilege('authenticated','public.enqueue_publish_request(text,text,text,text,date,text)','execute') f1,
  has_function_privilege('anon','public.claim_publish_request(text,uuid,integer)','execute') f2,
  has_function_privilege('service_role','public.finish_publish_request(uuid,uuid,text,text,jsonb,integer)','execute') f3,
  (select relrowsecurity from pg_class where oid = 'public.publish_requests'::regclass) rls`);
ok("S8 browser roles have NO table / RPC access; service_role may SELECT + EXECUTE but never INSERT directly; RLS on", !priv.a1 && !priv.a2 && priv.s1 && !priv.s2 && !priv.f1 && !priv.f2 && priv.f3 && priv.rls);
threw = false;
try { await claim("w1", randomUUID(), 5); } catch { threw = true; }
ok("S8 a claim lease outside 30..900 s is refused", threw);

// ---- W: the REAL executor core over these RPCs ---------------------------------------------------------------------------------
await db.exec("delete from public.publish_requests; update public.publish_request_control set per_user_hourly = 50, max_active = 20");
const store = {
  claim: async ({ worker, claimToken, leaseSeconds }) => (await one("select public.claim_publish_request($1,$2::uuid,$3) as r", [worker, claimToken, Math.max(30, leaseSeconds)])).r,
  renew: async ({ id, claimToken, leaseSeconds }) => renew(id, claimToken, Math.max(30, leaseSeconds)),
  finish: async ({ id, claimToken, status, reason, result, retrySeconds }) => finish(id, claimToken, status, reason, result, retrySeconds),
};
const mk = ({ gates = async () => ({ ok: true }), execute, readBack = async () => ({ current: true, served: { id: "live-1" }, fingerprint: "f".repeat(40) }), zero = () => 0, preGates = null, beat = null, onTrip = null } = {}) => createPublishRequestWorker({
  workerId: "selftest-w", store, gates, execute, readBack, newClaimToken: () => randomUUID(), zeroExportBlocked: zero, config: { leaseSeconds: 60 }, preGates, beat, onTrip,
});
const w1 = await enqueue("brand-view|acct-1|W1", "u1");
let r = await mk({ execute: async () => ({ finish: "verify", unitState: "READBACK_VERIFIED", ms: 5 }) }).runOnce();
ok("W1 a published unit is recorded 'published' ONLY after the served read-back is current", r.status === "published" && (await row(w1.id)).status === "published" && (await row(w1.id)).result.served.id === "live-1");
const w2 = await enqueue("brand-view|acct-1|W2", "u1");
r = await mk({ execute: async () => ({ finish: "verify", unitState: "READBACK_VERIFIED" }), readBack: async () => ({ current: false, reason: "fingerprint-differs" }) }).runOnce();
ok("W2 a publish the served row does NOT confirm is NOT recorded published (retry, reason readback-not-current)", (await row(w2.id)).status === "queued" && (await row(w2.id)).reason === "readback-not-current:fingerprint-differs");
await db.exec("delete from public.publish_requests");
const w3 = await enqueue("brand-view|acct-1|W3", "u1");
r = await mk({ gates: async () => ({ ok: false, reason: "scheduler-running:europe-au", waitSeconds: 300 }), execute: async () => { throw new Error("must not run"); } }).runOnce();
ok("W3 a scheduler run in progress RELEASES the request (no attempt used, reason shown, executor never ran)", r.did === "released" && (await row(w3.id)).status === "queued" && (await row(w3.id)).attempts === 0 && (await row(w3.id)).reason === "waiting:scheduler-running:europe-au");
await db.exec("delete from public.publish_requests");
const w4 = await enqueue("brand-view|acct-1|W4", "u1");
r = await mk({ execute: async () => ({ finish: "missing_evidence", reason: "brand-not-sold" }) }).runOnce();
ok("W4 missing saved evidence -> 'missing_evidence' with the typed reason (never a zero, never a fetch)", (await row(w4.id)).status === "missing_evidence" && (await row(w4.id)).reason === "brand-not-sold");
const w5 = await enqueue("brand-view|acct-1|W5", "u1");
r = await mk({ execute: async () => ({ finish: "verify", unitState: "READBACK_VERIFIED" }), zero: (() => { let n = 0; return () => n++; })() }).runOnce();
ok("W5 a blocked DataDoe request during the job fails it 'zero-export-violation' and STOPS the executor", r.did === "stopped" && (await row(w5.id)).status === "failed" && (await row(w5.id)).reason === "zero-export-violation");
// crash: claim, never finish (the process died) -> the lease expires -> the next executor resumes it
const w6 = await enqueue("brand-view|acct-1|W6", "u1");
const crashed = await store.claim({ worker: "dead", claimToken: randomUUID(), leaseSeconds: 60 });
await expire(w6.id);
let seenPrior = null;
r = await mk({ execute: async ({ job }) => { seenPrior = job.prior_run_token; return { finish: "verify", unitState: "PUBLICATION_NOT_REQUIRED" }; } }).runOnce();
ok("W6 a crashed executor's request is resumed after its lease expires (attempt 2, the prior run token is handed over) and closes 'already_current'", crashed.id === w6.id && seenPrior === crashed.run_token && (await row(w6.id)).status === "already_current" && (await row(w6.id)).attempts === 2);
const w7 = await enqueue("brand-view|acct-1|W7", "u1");
r = await mk({ execute: async () => ({ finish: "release", reason: "controls-not-opened:held", retrySeconds: 120 }) }).runOnce();
ok("W7 contention on the global control lease releases WITHOUT consuming the attempt", (await row(w7.id)).status === "queued" && (await row(w7.id)).attempts === 0 && (await row(w7.id)).reason === "waiting:controls-not-opened:held");
ok("W8 idle when nothing is due (the claim is the only query)", (await mk({ execute: async () => ({}) }).runOnce()).did === "idle");
ok("W9 control.worker_seen_at is stamped by claims (executor liveness for the dashboard)", !!(await one("select worker_seen_at from public.publish_request_control")).worker_seen_at);

// ---- R: review fixes (single executor, liveness, durable trip, pre-claim pause) -------------------------------------------------
await db.exec("delete from public.publish_requests; update public.publish_request_control set enabled = true, worker_seen_at = now() - interval '10 minutes', worker_state = null");
const ra = await enqueue("brand-view|acct-1|R1", "u1"); const rb2 = await enqueue("brand-view|acct-1|R2", "u1");
const cA = await claim("w1");
ok("R1 ONE executor at a time: with one request PUBLISHING under a live lease, a second due request is NOT claimed (deploy overlap / --once)", cA.row && (await claim("w2")).row === null && (await row(rb2.id)).status === "queued");
await db.exec("update public.publish_request_control set worker_seen_at = now() - interval '10 minutes'");
await renew(cA.row.id, cA.token);
ok("R2 renew (the job heartbeat) stamps executor liveness (a long job never reads as offline)", (await one("select worker_seen_at > now() - interval '5 seconds' as fresh from public.publish_request_control")).fresh === true);
await finish(cA.row.id, cA.token, "published", "served-row-verified");
await db.query("select public.publish_request_worker_beat($1,$2)", ["w1", "paused:scheduler-running:india"]);
ok("R3 the beat records the executor state for the dashboard", (await one("select worker_state from public.publish_request_control")).worker_state === "paused:scheduler-running:india");
const rc = await claim("w1"); await finish(rc.row.id, rc.token, "release", "waiting:database-slow", null, 10);
await db.query("update public.publish_requests set max_attempts = 1, next_attempt_at = now() - interval '1 second' where id = $1::uuid", [rc.row.id]);
const rd = await claim("w1"); await expire(rd.row.id); await claim("w2");
ok("R4 a crash-loop close never carries a stale 'waiting:' reason (attempts-exhausted:lease-expired)", (await row(rd.row.id)).status === "failed" && (await row(rd.row.id)).reason === "attempts-exhausted:lease-expired");
await db.query("select public.trip_publish_request_control($1)", ["zero-export-violation"]);
const ctl = await one("select enabled, note, worker_state from public.publish_request_control");
ok("R5 the durable TRIP disables the feature (a restarted executor claims nothing; only the owner re-enables)", ctl.enabled === false && ctl.note === "TRIPPED: zero-export-violation" && ctl.worker_state === "tripped" && (await enqueue("brand-view|acct-1|R9", "u1")).outcome === "disabled");
const privR = await one("select has_function_privilege('authenticated','public.trip_publish_request_control(text)','execute') t, has_function_privilege('anon','public.publish_request_worker_beat(text,text)','execute') b");
ok("R5 ... the beat / trip RPCs are service_role only", !privR.t && !privR.b);
await db.exec("delete from public.publish_requests; update public.publish_request_control set enabled = true, note = null, worker_state = null");
const rp = await enqueue("brand-view|acct-1|P1", "u1");
const beats = [];
let pr = await mk({ preGates: async () => ({ ok: false, reason: "database-slow", load: true }), beat: async (b) => { beats.push(b.state); }, execute: async () => { throw new Error("must not run"); } }).runOnce();
ok("R6 a slow database pauses BEFORE claiming: no claim, no attempt used, the paused state is beaten", pr.did === "paused" && (await row(rp.id)).status === "queued" && (await row(rp.id)).attempts === 0 && beats[0] === "paused:database-slow");
let trippedWith = null;
pr = await mk({ execute: async ({ signal }) => { await store.renew({ id: rp.id, claimToken: randomUUID(), leaseSeconds: 60 }); return { finish: "verify", unitState: "READBACK_VERIFIED" }; }, zero: (() => { let n = 0; return () => n++; })(), onTrip: async ({ reason }) => { trippedWith = reason; } }).runOnce();
ok("R7 a blocked DataDoe request TRIPS durably (onTrip) and stops the executor", pr.did === "stopped" && trippedWith === "zero-export-violation" && (await row(rp.id)).status === "failed");

console.log(`publish-request selftest: ${passed} passed`);
await db.close();
process.exit(0);
