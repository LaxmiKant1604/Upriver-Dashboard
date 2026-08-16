// Scheduler v2 -- durable many-to-many source-job OWNERSHIP: schema + production PostgREST wrappers +
// multi-owner canonical dedup + owner-scoped stale behaviour (SHADOW MODE, fully offline).
//
// This suite does NOT rely only on in-memory stores: Part B stubs globalThis.fetch and inspects the
// ACTUAL PostgREST URL / select columns / insert body / conflict keys / Prefer headers the production
// lib/server/supabase.js wrappers emit, and Part A parses the real migration SQL. Part C drives the real
// runSourceJobs + reconcileStaleOwnerMemberships against a lean in-memory store to prove the multi-owner
// canonical-dedup and stale-membership semantics.
//
// 7-bit ASCII, LF, no top-level await, synchronous writeSync progress, dynamic imports after a dummy
// Supabase env. No secret-shaped literals; no process.exit / timers / background work.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = process.env[SB_KEY_ENV] || ["test", "svc", "role", "key"].join("-");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const group = (label) => tests.push({ marker: label });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const HERE = dirname(fileURLToPath(import.meta.url));

let upsertSyncSourceJobOwners, getSyncSourceJobOwners, getSyncSourceJobsForOwners, recordSyncSourceJobOwnerStale, getSyncSourceJobs;
let runSourceJobs, reconcileStaleOwnerMemberships, sourceJobOwnerId;

// ---- fetch capture harness (Part B): record every PostgREST request; scripted JSON replies by URL. ----
function captureFetch(reply = () => []) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const call = { url: String(url), method: opts.method || "GET", headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : undefined };
    calls.push(call);
    const data = reply(call);
    return { ok: true, status: 200, async json() { return data; } };
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}
const selectOf = (url) => new URLSearchParams(url.split("?")[1] || "").get("select") || "";
const paramOf = (url, k) => new URLSearchParams(url.split("?")[1] || "").get(k) || "";

/* ============================= Part A: migration schema ============================= */

group("ownership migration: convergent fresh/upgrade schema, backfill, fail-closed, idempotent, no secrets");

const OWNERS_SQL = () => readFileSync(join(HERE, "..", "supabase", "migrations", "20260811_sync_source_job_owners.sql"), "utf8");

test("base table, unique, composite FK, admin-only RLS, and no destructive statement on existing tables", () => {
  const sql = OWNERS_SQL(); const flat = sql.replace(/\s+/g, " ");
  assert.match(sql, /create table if not exists public\.sync_source_job_owners/, "creates the ownership table (idempotent)");
  assert.match(flat, /unique \(cycle_id, request_hash, owner_id\)/, "unique(cycle_id, request_hash, owner_id)");
  assert.match(flat, /foreign key \(cycle_id, request_hash\) references public\.sync_source_jobs \(cycle_id, request_hash\) on delete cascade/, "composite FK");
  for (const col of ["cycle_id", "request_hash", "owner_id", "request_key", "report_key", "account_id", "connection_id", "organization_fingerprint", "account_scope_hash", "owner_status", "created_at", "updated_at"]) {
    assert.match(sql, new RegExp("\\b" + col + "\\b"), "declares " + col);
  }
  assert.match(flat, /owner_status text not null default 'active' check \(owner_status in \('active', 'stale'\)\)/, "typed owner_status");
  assert.match(sql, /alter table public\.sync_source_job_owners enable row level security/, "RLS enabled");
  assert.match(sql, /create policy "admins read sync source job owners" on public\.sync_source_job_owners\s+for select to authenticated using \(public\.is_dashboard_admin\(\)\)/, "admin-only read policy");
  assert.ok(!/for (insert|update|delete)\s+to/i.test(sql), "no non-select policy (service-role writes bypass RLS)");
  assert.ok(!/\bdrop table\b|\balter table public\.sync_source_jobs\b/i.test(sql), "does not drop/alter any existing table");
  // request_hash / owner_id are never rewritten by the migration.
  assert.ok(!/alter column request_hash|alter column owner_id|update[^;]*set[^;]*request_hash|update[^;]*set[^;]*owner_id/i.test(sql), "never alters request_hash or owner_id");
});

test("BOTH paths converge: the final constraints are established by idempotent statements that run regardless of prior table state", () => {
  const sql = OWNERS_SQL(); const flat = sql.replace(/\s+/g, " ");
  // The CREATE must NOT inline the typed-connection or identity-nonempty checks, so an EARLIER table that
  // already exists (create table if not exists = no-op) still gains them from the idempotent blocks below.
  const createBlock = sql.slice(0, sql.indexOf(");", sql.indexOf("create table")) );
  assert.ok(!/check \(connection_id in/i.test(createBlock), "connection check is NOT inlined in CREATE (added convergently instead)");
  assert.ok(!/identity_nonempty/i.test(createBlock), "identity-nonempty check is NOT inlined in CREATE");
  // connection_id is added nullable-first, then finalized NOT NULL + default AFTER the backfill.
  assert.match(flat, /alter table public\.sync_source_job_owners add column if not exists connection_id text;/, "connection_id added (nullable) before backfill");
  assert.match(flat, /alter column connection_id set not null, alter column connection_id set default 'primary'/, "connection_id finalized NOT NULL + default AFTER backfill");
  // Unsafe blank defaults removed and NOT NULL asserted for every identity column.
  for (const c of ["report_key", "account_id", "organization_fingerprint", "account_scope_hash"]) {
    assert.match(flat, new RegExp("alter column " + c + " drop default"), c + " blank default removed");
    assert.match(flat, new RegExp("alter column " + c + " set not null"), c + " set NOT NULL");
  }
  // NAMED constraints added idempotently (pg_constraint existence guard) so both paths end equivalent.
  assert.match(flat, /if not exists \(select 1 from pg_constraint\s+where conname = 'sync_source_job_owners_connection_id_check'/, "named connection check added idempotently");
  assert.match(flat, /add constraint sync_source_job_owners_connection_id_check check \(connection_id in \('primary', 'dd-secondary'\)\)/, "typed connection check");
  assert.match(flat, /if not exists \(select 1 from pg_constraint\s+where conname = 'sync_source_job_owners_identity_nonempty'/, "named identity check added idempotently");
  assert.match(flat, /add constraint sync_source_job_owners_identity_nonempty check \(/, "identity-nonempty check");
});

// The DETERMINISTIC backfill rule the migration applies (dd-secondary: prefix => dd-secondary; else primary),
// re-implemented here and checked against the SQL's own UPDATE statements + sample accounts.
const connFor = (accountId) => (String(accountId).startsWith("dd-secondary:") ? "dd-secondary" : "primary");

test("deterministic connection_id backfill: dd-secondary: accounts => dd-secondary, others => primary; a secondary is never rewritten to primary", () => {
  const flat = OWNERS_SQL().replace(/\s+/g, " ");
  // Upgrade dd-secondary accounts (fill NULL or correct a mislabeled 'primary'); never touch an existing dd-secondary.
  assert.match(flat, /update public\.sync_source_job_owners set connection_id = 'dd-secondary' where account_id like 'dd-secondary:%' and coalesce\(connection_id, 'primary'\) = 'primary'/, "dd-secondary backfill/correction");
  // Fill NULL primary accounts only -- never downgrade a dd-secondary row to primary.
  assert.match(flat, /update public\.sync_source_job_owners set connection_id = 'primary' where account_id not like 'dd-secondary:%' and connection_id is null/, "primary NULL-only backfill");
  assert.ok(!/set connection_id = 'primary' where account_id like 'dd-secondary'/i.test(flat), "never rewrites a dd-secondary account to primary");
  // Sample mapping matches the rule.
  assert.equal(connFor("dd-secondary:B1"), "dd-secondary");
  assert.equal(connFor("A1"), "primary");
  assert.equal(connFor("dd-secondary:xyz"), "dd-secondary");
});

test("malformed existing identity rows fail the migration closed (raise), never silently accepted", () => {
  const flat = OWNERS_SQL().replace(/\s+/g, " ");
  assert.match(flat, /raise exception 'sync_source_job_owners contains rows with a blank\/invalid owner identity/, "fail-closed raise on malformed identity");
  // The guard checks every identity field + connection_id validity.
  for (const c of ["report_key", "account_id", "request_key", "organization_fingerprint", "account_scope_hash"]) {
    assert.match(flat, new RegExp("coalesce\\(" + c + ", ''\\) = ''"), "checks blank " + c);
  }
  assert.match(flat, /connection_id is null or connection_id not in \('primary', 'dd-secondary'\)/, "checks connection_id validity");
});

test("the migration is idempotent (safe to re-run) and stores NO secret", () => {
  const sql = OWNERS_SQL();
  assert.match(sql, /create table if not exists/, "table create idempotent");
  assert.match(sql, /add column if not exists connection_id/, "column add idempotent");
  assert.match(sql, /create index if not exists sync_source_job_owners_owner_idx/, "index idempotent");
  assert.match(sql, /create index if not exists sync_source_job_owners_hash_idx/, "index idempotent");
  assert.match(sql, /drop trigger if exists sync_source_job_owners_touch/, "trigger drop-create idempotent");
  assert.match(sql, /drop policy if exists "admins read sync source job owners"/, "policy drop-create idempotent");
  // Constraint adds are guarded by pg_constraint existence checks (re-run adds nothing).
  assert.equal((sql.match(/if not exists \(select 1 from pg_constraint/g) || []).length, 2, "both named constraints guarded");
  // No secret-shaped value.
  assert.ok(!/(api[-_ ]?key|secret|service_role_key|bearer|password|token)\s*['"=:]/i.test(sql.replace(/-- .*/g, "")), "no secret-shaped assignment outside comments");
  assert.ok(!/eyJ[A-Za-z0-9_-]{20,}/.test(sql), "no JWT-shaped literal");
});


/* ============================= Part B: production PostgREST wrappers ============================= */

group("production wrappers: real SELECT columns, owner membership body/conflict/filters");

test("getSyncSourceJobs SELECTs ONLY real canonical columns (no request_key)", async () => {
  const cap = captureFetch(() => []);
  try { await getSyncSourceJobs("cyc-1"); } finally { cap.restore(); }
  const select = selectOf(cap.calls[0].url);
  assert.ok(select.includes("request_hash") && select.includes("organization_fingerprint") && select.includes("account_scope_hash"), "keeps real canonical columns");
  assert.ok(!select.split(",").includes("request_key"), "request_key is NOT selected (not a canonical column / not ownership authority)");
});

test("upsertSyncSourceJobOwners POSTs a valid membership (conflict key + connection_id + reactivating body); fails closed before fetch on incomplete/mismatched identity", async () => {
  const ownerId = sourceJobOwnerId({ reportKey: "daily-reporting", connectionId: "primary", organizationFingerprint: "org-fp", accountScopeHash: "scope-A1" });
  const valid = { cycleId: "cyc-1", requestHash: "H1", ownerId, requestKey: "daily-reporting:catalog", reportKey: "daily-reporting", accountId: "A1", connectionId: "primary", organizationFingerprint: "org-fp", accountScopeHash: "scope-A1" };
  const cap = captureFetch(() => null);
  try { await upsertSyncSourceJobOwners([valid]); } finally { cap.restore(); }
  const c = cap.calls[0];
  assert.match(c.url, /\/rest\/v1\/sync_source_job_owners\?on_conflict=cycle_id,request_hash,owner_id/, "conflict key = (cycle_id, request_hash, owner_id)");
  assert.equal(c.method, "POST");
  assert.match(String(c.headers.Prefer || ""), /resolution=merge-duplicates/, "merge-duplicates reactivation");
  const row = c.body[0];
  assert.equal(row.owner_id, ownerId);
  assert.equal(row.connection_id, "primary", "connection_id (part of owner identity) is persisted");
  assert.equal(row.request_key, "daily-reporting:catalog");
  assert.equal(row.owner_status, "active", "re-declared membership is (re)activated");
  assert.equal(row.error_code, null);
  assert.ok(!("api_key" in row) && !("apikey" in row) && !("secret" in row), "no secret-shaped field in the owner row");

  // Fail-closed-before-fetch cases (each issues ZERO PostgREST requests):
  const reject = async (m, re) => { const cp = captureFetch(() => null); try { await assert.rejects(upsertSyncSourceJobOwners([m]), re); assert.equal(cp.calls.length, 0, "no request for " + re); } finally { cp.restore(); } };
  await reject({ ...valid, ownerId: "" }, /requires a non-empty owner_id/);                     // blank owner_id
  await reject({ ...valid, reportKey: "" }, /requires a non-empty owner_id/);                    // blank report_key
  await reject({ ...valid, accountId: "" }, /requires a non-empty owner_id/);                    // blank account_id
  await reject({ ...valid, connectionId: "tertiary" }, /connection_id in \{primary, dd-secondary\}/); // bad connection
  await reject({ ...valid, connectionId: "" }, /connection_id in \{primary, dd-secondary\}/);    // blank connection
  await reject({ ...valid, ownerId: ownerId + "x" }, /owner_id does not match sourceJobOwnerId/); // tampered owner_id
  await reject({ ...valid, organizationFingerprint: "other-org" }, /owner_id does not match sourceJobOwnerId/); // wrong org -> id mismatch
  await reject({ ...valid, accountScopeHash: "other-scope" }, /owner_id does not match sourceJobOwnerId/); // wrong scope -> id mismatch
  await reject({ ...valid, reportKey: "reconciliation" }, /owner_id does not match sourceJobOwnerId/); // wrong report -> id mismatch
});

test("getSyncSourceJobOwners filters by cycle + owner_id in(...) and selects owner columns", async () => {
  const cap = captureFetch(() => []);
  try { await getSyncSourceJobOwners("cyc-1", ["owner-A", "owner-B", "owner-A"]); } finally { cap.restore(); }
  const url = cap.calls[0].url;
  assert.match(url, /\/rest\/v1\/sync_source_job_owners\?/);
  assert.equal(paramOf(url, "cycle_id"), "eq.cyc-1");
  assert.equal(paramOf(url, "owner_id"), "in.(owner-A,owner-B)", "deduped owner id IN filter");
  assert.ok(selectOf(url).includes("owner_status"), "selects the owner_status lifecycle column");
});

test("getSyncSourceJobsForOwners resolves ACTIVE membership hashes then reads the canonical rows", async () => {
  const cap = captureFetch((call) => {
    if (call.url.includes("sync_source_job_owners")) {
      return [
        { request_hash: "H1", owner_status: "active" },
        { request_hash: "H2", owner_status: "stale" },
        { request_hash: "H1", owner_status: "active" },
      ];
    }
    return [];
  });
  try { await getSyncSourceJobsForOwners("cyc-1", ["owner-A"]); } finally { cap.restore(); }
  assert.equal(cap.calls.length, 2, "two requests: memberships then canonical jobs");
  const jobsUrl = cap.calls[1].url;
  assert.match(jobsUrl, /\/rest\/v1\/sync_source_jobs\?/);
  assert.equal(paramOf(jobsUrl, "request_hash"), "in.(H1)", "only ACTIVE, deduped hashes are fetched (stale H2 excluded)");
});

test("recordSyncSourceJobOwnerStale PATCHes only the one owner membership to stale (never the canonical row)", async () => {
  const cap = captureFetch(() => null);
  try { await recordSyncSourceJobOwnerStale({ cycleId: "cyc-1", requestHash: "H1", ownerId: "owner-A", code: "STALE_PLAN", message: "retired" }); } finally { cap.restore(); }
  const c = cap.calls[0];
  assert.match(c.url, /\/rest\/v1\/sync_source_job_owners\?/, "targets the owners table, not sync_source_jobs");
  assert.equal(c.method, "PATCH");
  assert.equal(paramOf(c.url, "cycle_id"), "eq.cyc-1");
  assert.equal(paramOf(c.url, "request_hash"), "eq.H1");
  assert.equal(paramOf(c.url, "owner_id"), "eq.owner-A", "scoped to exactly ONE owner membership");
  assert.equal(c.body.owner_status, "stale");
});

/* ============================= Part C: multi-owner canonical dedup + stale ============================= */

group("multi-owner: one canonical row + one export shared by two report owners");

// Lean in-memory store (canonical jobs + owner memberships + source cache).
function makeStore() {
  const cycles = new Map(); const jobs = new Map(); const owners = new Map(); const cache = new Map(); let seq = 0;
  const find = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  const orow = (cid) => [...((owners.get(cid) && owners.get(cid).values()) || [])];
  return {
    _job: (cid, h) => jobs.get(cid) && jobs.get(cid).get(h),
    _owners: (cid) => orow(cid).map((m) => ({ ...m })),
    openCycle({ bucket, cycleDate }) { const k = bucket + "|" + cycleDate; if (!cycles.has(k)) { const id = "cyc_" + (seq += 1); cycles.set(k, { id, bucket, status: "pending" }); jobs.set(id, new Map()); } return cycles.get(k).id; },
    claimCycle(id) { const c = find(id); if (c && c.status === "pending") { c.status = "running"; return true; } return false; },
    getCycle(id) { return find(id); },
    upsertSourceJob(j) { const m = jobs.get(j.cycleId); if (m.has(j.requestHash)) return; m.set(j.requestHash, { request_hash: j.requestHash, request_key: j.requestKey, source_id: j.sourceId, source_key: j.sourceKey, connection_id: j.connectionId, organization_fingerprint: j.organizationFingerprint, account_scope_hash: j.accountScopeHash, fetch_status: "pending", attempted_at: null, create_export_count: 0, export_id: null, terminal: false, row_count: null }); },
    listSourceJobs(id) { return [...((jobs.get(id) && jobs.get(id).values()) || [])].map((j) => ({ ...j })); },
    upsertSourceJobOwners(ms) { for (const m of ms || []) { if (!owners.has(m.cycleId)) owners.set(m.cycleId, new Map()); owners.get(m.cycleId).set(m.ownerId + "|" + m.requestHash, { cycle_id: m.cycleId, request_hash: m.requestHash, owner_id: m.ownerId, request_key: m.requestKey, report_key: m.reportKey, account_id: m.accountId, connection_id: m.connectionId, organization_fingerprint: m.organizationFingerprint, account_scope_hash: m.accountScopeHash, owner_status: "active", error_code: null, error_message: null }); } },
    listSourceJobOwners(cid, ids) { const s = new Set(ids || []); return orow(cid).filter((m) => s.has(m.owner_id)).map((m) => ({ ...m })); },
    recordSourceOwnerStale({ cycleId, requestHash, ownerId, code, message }) { const m = owners.get(cycleId) && owners.get(cycleId).get(ownerId + "|" + requestHash); if (m) { m.owner_status = "stale"; m.error_code = code || "STALE_PLAN"; m.error_message = message || null; } },
    claimExportAttempt(id, h) { const j = jobs.get(id) && jobs.get(id).get(h); if (j && j.attempted_at === null) { j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted"; return true; } return false; },
    recordExportCreated({ cycleId, requestHash, exportId }) { jobs.get(cycleId).get(requestHash).export_id = exportId; },
    loadSourceRows(h) { const e = cache.get(h); return e ? { rows: e.rows } : null; },
    saveSourceRows({ job, rows }) { const h = job.request_hash != null ? job.request_hash : job.requestHash; cache.set(h, { rows: [...rows] }); return "p/" + h; },
    recordSourceSuccess({ cycleId, requestHash, exportId, rowCount, cacheObjectPath }) { Object.assign(jobs.get(cycleId).get(requestHash), { fetch_status: "succeeded", export_id: exportId, row_count: rowCount, cache_object_path: cacheObjectPath }); },
    recordSourceFailure({ cycleId, requestHash, stage, code, terminal }) { Object.assign(jobs.get(cycleId).get(requestHash), { fetch_status: "failed", error_stage: stage, error_code: code, terminal: !!terminal }); },
    updateCycleCounts() {},
  };
}
function makeDataDoe() { const create = {}; return { createCount: (h) => create[h] || 0, totalCreates: () => Object.values(create).reduce((a, b) => a + b, 0), async create(job) { create[job.requestHash] = (create[job.requestHash] || 0) + 1; return { exportId: "e_" + job.requestHash }; }, async poll() {}, async download() { return [{ a: 1 }]; } }; }

// The SAME canonical request_hash "H" owned by two different reports (different request_key aliases +
// different owner_id). Each report contributes its own membership job.
const org = "org-fp", scope = "scope-A1";
const jobFor = (reportKey, requestKey) => ({
  requestHash: "H", requestKey, sourceId: "s", sourceKey: "product-catalog", connectionId: "primary",
  organizationFingerprint: org, accountScopeHash: scope, requestMeta: {}, bucket: "us", strict: false, limit: 10,
  owner: { ownerId: null, requestKey, reportKey, accountId: "A1" },
  fetchParams: { columns: ["c"], sellerOrVendorIds: ["A1"], from: null, to: null, options: {} },
});
function ownerJob(reportKey, requestKey) {
  const j = jobFor(reportKey, requestKey);
  j.owner.ownerId = sourceJobOwnerId({ reportKey, connectionId: "primary", organizationFingerprint: org, accountScopeHash: scope });
  return j;
}
const runOwner = (store, dd, job) => runSourceJobs({ store, dataDoe: dd, plannedJobs: [job], ownerIds: [job.owner.ownerId], bucket: "us", cycleDate: "2026-08-11" });

async function twoOwnersSharedHash(order) {
  const store = makeStore(); const dd = makeDataDoe();
  const x = ownerJob("daily-reporting", "daily-reporting:catalog");
  const y = ownerJob("reconciliation", "reconciliation:catalog");
  assert.notEqual(x.owner.ownerId, y.owner.ownerId, "different reports => different owner_id");
  const first = order === "xy" ? x : y;
  const second = order === "xy" ? y : x;
  const r1 = await runOwner(store, dd, first);
  const r2 = await runOwner(store, dd, second);
  const cid = r1.cycleId;
  assert.equal(store.listSourceJobs(cid).length, 1, "exactly ONE canonical sync_source_jobs row for the shared hash");
  assert.equal(store._owners(cid).length, 2, "exactly TWO owner memberships for that one canonical row");
  assert.equal(dd.createCount("H"), 1, "exactly ONE DataDoe create-export for the shared hash");
  assert.equal(store._job(cid, "H").fetch_status, "succeeded");
  assert.equal(r2.succeeded + r2.processed >= 0, true);
  assert.equal(dd.totalCreates(), 1, "the second owner resumes/reads the shared result with ZERO additional create-export");
  return { store, cid };
}

test("two reports, different request_key, SAME request_hash => one canonical row, two memberships, one create-export (owner X then Y)", async () => {
  await twoOwnersSharedHash("xy");
});

test("reverse owner order gives the same result (owner Y then X)", async () => {
  await twoOwnersSharedHash("yx");
});

group("owner-scoped stale: never fails the shared canonical row another owner still needs");

test("a stale membership for owner A does NOT fail the shared canonical job or owner B's membership", async () => {
  const { store, cid } = await twoOwnersSharedHash("xy");
  const x = ownerJob("daily-reporting", "daily-reporting:catalog");
  const y = ownerJob("reconciliation", "reconciliation:catalog");
  // Owner A (daily-reporting) goes stale on the shared hash; owner B (reconciliation) still depends on it.
  await store.recordSourceOwnerStale({ cycleId: cid, requestHash: "H", ownerId: x.owner.ownerId, code: "STALE_PLAN", message: "retired" });
  const owners = store._owners(cid);
  assert.equal(owners.find((m) => m.owner_id === x.owner.ownerId).owner_status, "stale", "A's membership is stale");
  assert.equal(owners.find((m) => m.owner_id === y.owner.ownerId).owner_status, "active", "B's membership is untouched (active)");
  assert.equal(store._job(cid, "H").fetch_status, "succeeded", "the shared canonical row is NOT failed/corrupted");
  assert.equal(store._job(cid, "H").error_code, undefined, "no error recorded on the canonical row");
  // Owner B re-runs: reads the shared canonical result, still ZERO new create-export.
  const dd = makeDataDoe();
  const r = await runSourceJobs({ store, dataDoe: dd, plannedJobs: [y], ownerIds: [y.owner.ownerId], bucket: "us", cycleDate: "2026-08-11" });
  assert.equal(dd.totalCreates(), 0, "owner B makes no new create-export for the already-fetched shared hash");
  assert.equal(store.listSourceJobs(r.cycleId).length, 1, "still one canonical row");
});

test("a genuine same-owner stale membership is retired at OWNER scope by reconcileStaleOwnerMemberships (canonical row preserved)", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  // Owner A stages TWO sources this cycle: H (kept) and H2 (dropped next plan).
  const a1 = ownerJob("daily-reporting", "daily-reporting:catalog");
  const a2 = { ...ownerJob("daily-reporting", "daily-reporting:oli-sales"), requestHash: "H2" };
  a2.owner = { ...a2.owner };
  await runSourceJobs({ store, dataDoe: dd, plannedJobs: [a1, a2], ownerIds: [a1.owner.ownerId], bucket: "us", cycleDate: "2026-08-11" });
  const cid = store.openCycle({ bucket: "us", cycleDate: "2026-08-11" });
  assert.equal(store._owners(cid).length, 2, "two owner memberships staged");
  assert.equal(store._job(cid, "H2").fetch_status, "succeeded");
  // A new invocation's plan keeps ONLY H (drops H2). reconcile marks the H2 membership stale for owner A.
  const plannedKeys = new Set([`${a1.owner.ownerId}|H`]);
  await reconcileStaleOwnerMemberships(store, cid, [a1.owner.ownerId], plannedKeys);
  const owners = store._owners(cid);
  assert.equal(owners.find((m) => m.request_hash === "H2").owner_status, "stale", "the dropped H2 membership is stale (fails closed at owner scope)");
  assert.equal(owners.find((m) => m.request_hash === "H").owner_status, "active", "the kept H membership stays active");
  assert.equal(store._job(cid, "H2").fetch_status, "succeeded", "the canonical H2 row is preserved (never failed by a stale owner)");
  assert.equal(dd.totalCreates(), 2, "reconciliation makes NO DataDoe call for the stale membership");
});

test("sourceJobOwnerId is deterministic, account/org-safe, and does not depend on request_key/hash", () => {
  const base = { reportKey: "keyword-rank", connectionId: "primary", organizationFingerprint: "orgP", accountScopeHash: "scopeA" };
  assert.equal(sourceJobOwnerId(base), sourceJobOwnerId({ ...base }), "deterministic");
  assert.notEqual(sourceJobOwnerId(base), sourceJobOwnerId({ ...base, accountScopeHash: "scopeB" }), "different account => different owner");
  assert.notEqual(sourceJobOwnerId(base), sourceJobOwnerId({ ...base, organizationFingerprint: "orgS" }), "different org => different owner");
  assert.notEqual(sourceJobOwnerId(base), sourceJobOwnerId({ ...base, connectionId: "dd-secondary" }), "different connection => different owner");
  assert.notEqual(sourceJobOwnerId(base), sourceJobOwnerId({ ...base, reportKey: "brand-sales" }), "different report family => different owner");
  assert.equal(sourceJobOwnerId({ ...base, organizationFingerprint: "" }), null, "incomplete => null (caller fails closed)");
});

group("owner-identity validation: wrong identity fails before any Supabase write or DataDoe call");

test("runSourceJobs recomputes owner_id and rejects wrong report/request/connection/org/scope/blank BEFORE any write or DataDoe call", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const cid = store.openCycle({ bucket: "us", cycleDate: "2026-08-11" });
  const base = ownerJob("daily-reporting", "daily-reporting:catalog");
  const run = (job) => runSourceJobs({ store, dataDoe: dd, plannedJobs: [job], ownerIds: [job.owner.ownerId], bucket: "us", cycleDate: "2026-08-11" });
  const noSideEffects = () => { assert.equal(store.listSourceJobs(cid).length, 0, "no canonical job written"); assert.equal(store._owners(cid).length, 0, "no owner membership written"); assert.equal(dd.totalCreates(), 0, "no DataDoe create-export"); };
  await assert.rejects(run({ ...base, owner: { ...base.owner, reportKey: "reconciliation" } }), /owner_id does not match sourceJobOwnerId/); noSideEffects();     // wrong report key
  await assert.rejects(run({ ...base, owner: { ...base.owner, requestKey: "reconciliation:catalog" } }), /does not match the canonical job request_key/); noSideEffects(); // wrong request key
  await assert.rejects(run({ ...base, connectionId: "dd-secondary" }), /owner_id does not match sourceJobOwnerId/); noSideEffects();                                 // wrong connection
  await assert.rejects(run({ ...base, organizationFingerprint: "other-org" }), /owner_id does not match sourceJobOwnerId/); noSideEffects();                          // wrong org fingerprint
  await assert.rejects(run({ ...base, accountScopeHash: "other-scope" }), /owner_id does not match sourceJobOwnerId/); noSideEffects();                               // wrong account scope
  await assert.rejects(run({ ...base, owner: { ...base.owner, reportKey: "" } }), /missing owner membership metadata/); noSideEffects();                              // blank report metadata
  await assert.rejects(run({ ...base, owner: { ...base.owner, accountId: "" } }), /missing owner membership metadata/); noSideEffects();                              // blank account metadata
});

group("positive concurrency: interrupted cross-owner resume of a shared canonical export");

// A DataDoe double that creates the export, then DEFERS during poll (resumable) -- never a second create.
function makeDeferOnPoll() {
  const create = {};
  return {
    createCount: (h) => create[h] || 0,
    totalCreates: () => Object.values(create).reduce((a, b) => a + b, 0),
    async create(job) { create[job.requestHash] = (create[job.requestHash] || 0) + 1; return { exportId: "e_" + job.requestHash }; },
    async poll() { throw Object.assign(new Error("deferred at the execution deadline"), { code: "DATADOE_DEADLINE" }); },
    async download() { return [{ a: 1 }]; },
  };
}

test("owner A creates the export and defers during poll; owner B (different report/request_key, same canonical hash) resumes the SAME export id with ZERO second create-export", async () => {
  const store = makeStore();
  const x = ownerJob("daily-reporting", "daily-reporting:catalog");  // owner A
  const y = ownerJob("reconciliation", "reconciliation:catalog");    // owner B -- same request_hash "H", different owner/key
  assert.notEqual(x.owner.ownerId, y.owner.ownerId);
  // 1-3) Owner A wins create-export for H, persists export_id, then is interrupted during poll (deferred).
  const ddA = makeDeferOnPoll();
  const rA = await runSourceJobs({ store, dataDoe: ddA, plannedJobs: [x], ownerIds: [x.owner.ownerId], bucket: "us", cycleDate: "2026-08-11" });
  const cid = rA.cycleId;
  assert.equal(rA.deferred, 1, "owner A deferred during poll (resumable)");
  assert.equal(ddA.totalCreates(), 1, "owner A made exactly one create-export");
  assert.equal(store._job(cid, "H").fetch_status, "attempted", "canonical H is attempted (resumable), not failed");
  assert.equal(store._job(cid, "H").export_id, "e_H", "export_id persisted before poll");
  // 4-6) Owner B resumes the SAME canonical export: no second create-export; H succeeds once; both memberships valid.
  const ddB = makeDataDoe();
  await runSourceJobs({ store, dataDoe: ddB, plannedJobs: [y], ownerIds: [y.owner.ownerId], bucket: "us", cycleDate: "2026-08-11" });
  assert.equal(ddB.createCount("H"), 0, "owner B performed ZERO additional create-export (resumed A's saved export)");
  assert.equal(store._job(cid, "H").fetch_status, "succeeded", "the canonical job succeeds exactly once");
  assert.equal(store.listSourceJobs(cid).length, 1, "still ONE canonical row for the shared hash");
  const owners = store._owners(cid);
  assert.equal(owners.length, 2, "both owner memberships persist");
  assert.ok(owners.every((m) => m.owner_status === "active"), "both memberships remain active");
});

async function main() {
  ({ upsertSyncSourceJobOwners, getSyncSourceJobOwners, getSyncSourceJobsForOwners, recordSyncSourceJobOwnerStale, getSyncSourceJobs } = await import("../lib/server/supabase.js"));
  ({ runSourceJobs } = await import("../lib/server/sync/source-worker.js"));
  ({ reconcileStaleOwnerMemberships } = await import("../lib/server/sync/source-sync-driver.js"));
  ({ sourceJobOwnerId } = await import("../lib/server/source-identity.js"));

  let failures = 0;
  for (const t of tests) {
    if (t.marker) { out("\n# " + t.marker); continue; }
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (err) { failures += 1; out("FAIL  " + t.name); out(String(err && err.stack ? err.stack : err)); }
  }
  out("\n" + passed + " assertions passed");
  return failures;
}

main().then((failures) => { if (failures) process.exitCode = 1; }).catch((err) => { out("FATAL " + String(err && err.stack ? err.stack : err)); process.exitCode = 1; });
