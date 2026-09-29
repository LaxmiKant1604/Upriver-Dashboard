// WP16 P2-B -- the listing-health-v3 reconciler FOREIGN-JOB STRAND (pre-existing) and its salted-cycle ("nonce") fix.
//
// THE STRAND: the reconciler's dedicated cycle bucket is deterministic over {accountId, revisionId}; the publisher
// promotes ONLY the LATEST sync_report_jobs row for (listing-health-v3, account). When the reconciler published revision
// R and a natural listing-health-v3 base-cycle job then became the latest (a FAILED shadow save -> job-not-promotable,
// india 2026-09-25; or a SUCCESSFUL natural job without R's manifest -> 'listings-manifest-changed'), an unchanged R
// re-derives into its OWN already-terminal bucket, resumableAtTerminalCycle is false, and every pass deferred
// 'cycle-not-running:succeeded' until the revision / as-of changed. An A -> B -> A manifest revert strands the same way.
// THE FIX: the OPTIONAL readNewestForeignJob collaborator (newest job for the account whose durable_content_deps do NOT
// carry this revision's manifest) turns that deferral into the SAME typed deferral + retryBucketSalt = foreignJob.id,
// and runListingHealthV3ReleaseWithForeignRetry (the CLI wiring) retries ONCE in the salted bucket. Proves:
//   N1 the strand is reproduced WITHOUT the collaborator (byte-identical 'cycle-not-running:succeeded');
//   N2 the india 09-25 shape (latest = FAILED natural job) and N3 the SUCCESSFUL-natural-job shape converge to a publish
//      + read-back in ONE pass via ONE salted cycle;
//   N4 a crash after the salted cycle's finalize -> the next pass resumes there (WP2) -- no third cycle;
//   N5 an A -> B -> A manifest revert converges (A's content is live again) in one pass;
//   N6 no foreign job / a foreign read failure / an unreadable latest job / a manifest-carrying "foreign" row / a non-
//      success terminal status -> the result is BYTE-IDENTICAL to today (one attempt, the legacy deferral); the fresh,
//      running and own-crash-resume paths never consult the foreign reader; the second attempt's salt is never followed;
//   N7 the bucket helper: unsalted == the pre-WP16 CLI expression byte-for-byte; salted buckets satisfy the
//      migration-20260924 CHECK (^priority-partial-(india|europe-au|us-ca)-[0-9a-f]{16}$);
//   N8 the production reader: ONE read-only select (jsonb NOT-containment, newest by created_at, limit 1), exact params;
//   N9 the CLI wiring (static): the reconcile CLI hands the reader to the release and runs the retry helper;
//   N10 ZERO DataDoe / network calls anywhere.
// Offline: in-memory lineage world (sync_cycles / sync_report_jobs / report_snapshots) + a GATE-7 model publisher; the
// REAL buildListingHealthV3Release, REAL paramsHashFor + contracts. 7-bit ASCII, LF.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test-service-role";

import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ZERO network: every fetch is recorded and refused (a DataDoe / PostgREST call would show up here).
const netCalls = [];
globalThis.fetch = async (url) => { netCalls.push(String(url)); return { ok: false, status: 400, json: async () => ({ message: "offline test" }) }; };

const {
  buildListingHealthV3Release, listingHealthV3ReleaseCycleBucket, runListingHealthV3ReleaseWithForeignRetry,
  buildListingHealthV3ForeignJobReader, LISTING_HEALTH_V3_FOREIGN_JOB_SQL,
} = await import("../lib/server/sync/listing-health-v3-release.js");
const { statusFromRelease, RECONCILE_STATUS } = await import("../lib/server/sync/saved-data-reconciler.js");
const { REPORT_DERIVATIONS } = await import("../lib/server/sync/report-derivation.js");
const { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } = await import("../lib/server/sync/report-publisher.js");
const { paramsHashFor } = await import("../lib/server/report-store.js");
const { sha256 } = await import("../lib/server/source-identity.js");
const { PARTIAL_CYCLE_CAPABILITY_PATTERN } = await import("../lib/server/sync/priority-partial-capability.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "listing-health-v3-reconcile-nonce\n");

const S = (v) => (v == null ? "" : String(v));
const RK = "listing-health-v3";
const A = "12f3a683-0000-4000-8000-000000000000";
const ASOF = "2026-09-24";
const REGION = "india";
const REV_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REV_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TOKEN = (rev) => "listing-health-v3-manifest|org-1|primary|" + A + "|" + ASOF + "|" + rev;
const LEGACY_TERMINAL = (status) => ({ code: 1, ok: false, stage: "reconcile", status: "SOURCE_UNAVAILABLE", leaseLost: false, reason: "cycle-not-running:" + status, blockerCodes: [], problems: ["cycle-not-running:" + status] });
const BUCKET_RE = new RegExp(PARTIAL_CYCLE_CAPABILITY_PATTERN);

// ---------------------------------------------------------------------------------------------------------------------
// The in-memory LINEAGE world (same model as release-resume-terminal-cycle.test.js): sync_cycles (open=pending ->
// claim=running -> finalize=terminal), sync_report_jobs (insert-if-absent, lease, reconcile), report_snapshots (shadow
// CAS + live CAS), the lineage read in the getLatestReportJobLineage shape, the PRODUCTION foreign-job reader over a SQL
// model of LISTING_HEALTH_V3_FOREIGN_JOB_SQL, and a GATE-7 model publisher (the LATEST job must be validated + succeeded
// in a TERMINAL cycle with a hash -> the EXACT shadow at that hash -> the freshness CAS on the live identity).
// ---------------------------------------------------------------------------------------------------------------------
function makeWorld() {
  const cycles = new Map(); const jobs = []; const snaps = new Map();
  const n = { open: 0, upsert: 0, claimLease: 0, shadow: 0, reconcile: 0, finalize: 0, preflight: 0, publish: 0, liveWrites: 0, readLatest: 0, readForeign: 0, foreignSql: [], attempts: [] };
  let seq = 0; let clock = Date.UTC(2026, 8, 25, 0, 0, 0);
  const tick = () => new Date(clock += 60000).toISOString();
  const cycleById = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  const jobOf = (cycleId, a) => jobs.find((j) => j.cycle_id === cycleId && j.report_key === RK && j.account_id === a) || null;
  const w = { cycles, jobs, snaps, n, tick, nextSeq: () => ++seq }; // nextSeq: the SAME monotonic job clock (created_at order)
  w.openCycle = async ({ bucket, cycleDate }) => { n.open += 1; const k = bucket + "|" + cycleDate; if (!cycles.has(k)) cycles.set(k, { id: "cyc-" + (++seq), bucket, cycle_date: cycleDate, status: "pending", created_at: tick() }); };
  w.getCycleByBucketDate = async (bucket, cycleDate) => { const c = cycles.get(bucket + "|" + cycleDate); return c ? { ...c } : null; };
  w.claimCycle = async (cycleId) => { const c = cycleById(cycleId); if (c && c.status === "pending") { c.status = "running"; return true; } return false; };
  w.upsertReportJob = async (job) => {
    n.upsert += 1;
    if (jobOf(job.cycleId, job.accountId)) return;
    jobs.push({ id: "job-" + (++seq), cycle_id: job.cycleId, report_key: job.reportKey, account_id: job.accountId, depends_on: [...(job.dependsOn || [])], durable_content_deps: [...(job.durableContentDeps || [])], derive_status: "pending", save_status: "pending", validated: false, snapshot_params_hash: null, created_at: ++seq });
  };
  w.claimLease = async (cycleId, rk, a) => {
    n.claimLease += 1;
    const j = jobOf(cycleId, a);
    if (!j) return { disposition: "not-found", leaseToken: null, snapshotParamsHash: null };
    if (j.validated === true) return { disposition: "already-complete", leaseToken: null, snapshotParamsHash: j.snapshot_params_hash };
    j.derive_status = "running";
    return { disposition: "claimed", leaseToken: "lt-" + (++seq), snapshotParamsHash: null };
  };
  w.saveShadow = async ({ reportKey, accountId, paramsHash, params, payload, sourceRefreshedAt }) => {
    n.shadow += 1;
    const k = reportKey + "|" + accountId + "|" + paramsHash; const cur = snaps.get(k);
    if (cur && S(cur.source_refreshed_at) > S(sourceRefreshedAt)) return { outcome: "newer-live" };
    if (cur && S(cur.source_refreshed_at) === S(sourceRefreshedAt) && JSON.stringify(cur.payload) === JSON.stringify(payload)) return { outcome: "already-current" };
    snaps.set(k, { report_key: reportKey, account_id: accountId, params_hash: paramsHash, params, payload, source_refreshed_at: sourceRefreshedAt });
    return { outcome: cur ? "replaced" : "inserted" };
  };
  w.reconcileSuccess = async ({ cycleId, accountId, snapshotParamsHash }) => {
    n.reconcile += 1;
    const j = jobOf(cycleId, accountId); if (!j) return { disposition: "not-found" };
    Object.assign(j, { validated: true, derive_status: "succeeded", save_status: "succeeded", snapshot_params_hash: snapshotParamsHash });
    return { disposition: "reconciled" };
  };
  w.finalizeCycle = async ({ cycleId }) => {
    n.finalize += 1;
    const c = cycleById(cycleId); if (!c) return { disposition: "not-found" };
    if (c.status !== "running") return { disposition: "invalid-status" };
    c.status = jobs.some((j) => j.cycle_id === cycleId && j.validated === true) ? "succeeded" : "partial";
    return { disposition: "finalized" };
  };
  const newest = (xs) => xs.sort((x, y) => (y.created_at - x.created_at) || (S(y.id) < S(x.id) ? -1 : S(y.id) > S(x.id) ? 1 : 0))[0] || null;
  w.lineage = (a) => {
    const j = newest(jobs.filter((x) => x.report_key === RK && x.account_id === a));
    if (!j) return null;
    const c = cycleById(j.cycle_id);
    return { reportKey: j.report_key, accountId: j.account_id, deriveStatus: j.derive_status, saveStatus: j.save_status, validated: j.validated === true, dependsOn: j.depends_on.map(String), durableContentDeps: j.durable_content_deps.map(String), snapshotParamsHash: j.snapshot_params_hash, latestDataDate: null, cycleStatus: c ? c.status : null, id: j.id, cycleId: j.cycle_id, createdAt: j.created_at };
  };
  w.readLatestJob = async (rk, a) => { n.readLatest += 1; return w.lineage(a); };
  // A faithful model of LISTING_HEALTH_V3_FOREIGN_JOB_SQL: report_key = $1, account_id = $2, NOT (durable_content_deps
  // @> $3::jsonb) (jsonb array containment = every element present), ORDER BY created_at DESC, id DESC, LIMIT 1.
  w.query = async (sql, params) => {
    n.foreignSql.push({ sql, params });
    const [rk, a, tokensJson] = params;
    const want = JSON.parse(tokensJson);
    const j = newest(jobs.filter((x) => x.report_key === rk && x.account_id === a && !want.every((t) => (x.durable_content_deps || []).includes(t))));
    return j ? [{ id: j.id, cycle_id: j.cycle_id, durable_content_deps: [...j.durable_content_deps] }] : [];
  };
  const prodReader = buildListingHealthV3ForeignJobReader({ query: (sql, params) => w.query(sql, params) });
  w.readNewestForeignJob = async (...args) => { n.readForeign += 1; return prodReader(...args); };
  const gate = (a) => {
    const L = w.lineage(a);
    if (!L || L.validated !== true || L.deriveStatus !== "succeeded" || L.saveStatus !== "succeeded" || !(L.cycleStatus === "succeeded" || L.cycleStatus === "partial") || !S(L.snapshotParamsHash)) return { disposition: "not-successful" };
    const shadow = snaps.get("scheduler-v2/" + RK + "|" + a + "|" + L.snapshotParamsHash);
    if (!shadow || S(shadow.params && shadow.params.accountId) !== a) return { disposition: "invalid-snapshot" };
    return { ok: true, shadow, liveHash: "live-" + L.snapshotParamsHash };
  };
  w.publisher = {
    preflight: async (rk, a) => { n.preflight += 1; const g = gate(a); return g.ok ? { disposition: "ready" } : { disposition: g.disposition }; },
    publish: async (rk, a) => {
      n.publish += 1;
      const g = gate(a); if (!g.ok) return { disposition: g.disposition };
      const k = rk + "|" + a + "|" + g.liveHash;
      const out = { reportKey: rk, accountId: a, liveReportKey: rk, paramsHash: g.liveHash };
      const cur = snaps.get(k); const stamp = S(g.shadow.source_refreshed_at);
      if (cur && S(cur.source_refreshed_at) > stamp) return { disposition: "newer-live", ...out };
      if (cur && S(cur.source_refreshed_at) === stamp) return { disposition: JSON.stringify(cur.payload) === JSON.stringify(g.shadow.payload) ? "already-current" : "publish-conflict", ...out };
      snaps.set(k, { report_key: rk, account_id: a, params_hash: g.liveHash, payload: g.shadow.payload, source_refreshed_at: stamp });
      n.liveWrites += 1;
      return { disposition: "published", ...out };
    },
  };
  w.readbackLive = async ({ liveReportKey, accountId, paramsHash }) => (snaps.has(liveReportKey + "|" + accountId + "|" + paramsHash) ? { ok: true } : { ok: false, reason: "live-missing" });
  w.live = () => [...snaps.values()].filter((r) => r.report_key === RK && r.account_id === A);
  w.cycleOf = (bucket) => cycles.get(bucket + "|" + ASOF) || null;
  return w;
}

// The durable evidence of one revision (the shared resolveListingHealthV3DependencyBundle shape) + a derived payload that
// is a function of the revision (so an A -> B -> A revert is observable in the live payload).
let currentRev = REV_A;
const bundleOf = (rev) => ({
  eligible: true, status: "available", revisionId: rev, deps: [], contentDeps: [TOKEN(rev)],
  bundle: { listingsRows: [], rawRows: [], inventorySource: { available: false }, context: { rawSellerId: "SELLER-1" }, listingsSnapshot: { source_request_hash: "rh-l" }, rawSnapshot: { source_request_hash: "rh-r" }, inventorySnapshot: null },
});
const payloadOf = (rev) => ({ rows: [{ sku: "A", status: "Active", rev: rev.slice(0, 4) }] });

// The release exactly as the reconcile CLI builds it; `withForeign` (default true) wires the production foreign reader.
function wire(w, { withForeign = true, readLatestJob = null, readNewestForeignJob = null, finalizeCycle = null, signal = null } = {}) {
  const release = buildListingHealthV3Release({
    resolveBundle: async () => bundleOf(currentRev),
    openCycle: w.openCycle, getCycleByBucketDate: w.getCycleByBucketDate, claimCycle: w.claimCycle,
    deriveSnapshot: async () => ({ status: "derived", validated: true, payload: payloadOf(currentRev), latestDataDate: ASOF }),
    reportDerivations: REPORT_DERIVATIONS, computeHash: paramsHashFor, liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS,
    upsertReportJob: w.upsertReportJob, claimLease: w.claimLease, saveShadow: w.saveShadow, reconcileSuccess: w.reconcileSuccess,
    finalizeCycle: finalizeCycle || w.finalizeCycle,
    publisher: w.publisher, readbackLive: w.readbackLive, verifyLease: async () => ({ ok: true }),
    readLatestJob: readLatestJob || w.readLatestJob,
    ...(withForeign ? { readNewestForeignJob: readNewestForeignJob || w.readNewestForeignJob } : {}),
    log: () => {},
  });
  // Count every runForAccount attempt (and the bucket it ran in) without changing the release.
  const counted = { runForAccount: async (args) => { w.n.attempts.push(args.cycleBucket); return release.runForAccount(args); } };
  return {
    release: counted,
    pass: () => runListingHealthV3ReleaseWithForeignRetry({ release: counted, region: REGION, accountId: A, requestedAsOf: ASOF, revisionId: currentRev, signal }),
    direct: (cycleBucket) => release.runForAccount({ accountId: A, requestedAsOf: ASOF, cycleBucket, revisionId: currentRev, signal }),
  };
}
const bucketOf = (rev, salt = null) => listingHealthV3ReleaseCycleBucket({ region: REGION, accountId: A, revisionId: rev, salt });
const SHADOW_HASH = paramsHashFor(REPORT_DERIVATIONS[RK].snapshotVersion, { reportVersion: REPORT_DERIVATIONS[RK].snapshotVersion, accountId: A, to: ASOF });

// Seed: the reconciler published revision R (a fresh pass in bucket(R)), THEN a natural listing-health-v3 base-cycle job
// became the latest -- failed save (india 09-25) or a plain success (no durable_content_deps, same shadow identity).
async function publishedThenNatural(shape, rev = REV_A) {
  const w = makeWorld();
  currentRev = rev;
  const r0 = await wire(w).pass();
  assert.equal(r0.ok, true, "seed publish");
  const natural = { id: "cyc-natural", bucket: "listing-health-v3-" + REGION, cycle_date: ASOF, status: shape === "failed" ? "partial" : "succeeded", created_at: w.tick() };
  w.cycles.set(natural.bucket + "|" + ASOF, natural);
  const base = { id: "job-natural", cycle_id: natural.id, report_key: RK, account_id: A, depends_on: ["batch-l", "batch-r", "inv"], durable_content_deps: [], created_at: w.nextSeq() };
  if (shape === "failed") w.jobs.push({ ...base, derive_status: "succeeded", save_status: "failed", validated: false, snapshot_params_hash: null });
  else {
    w.jobs.push({ ...base, derive_status: "succeeded", save_status: "succeeded", validated: true, snapshot_params_hash: SHADOW_HASH });
    // The natural run saved the SAME shadow identity at its own (newer) cycle stamp.
    w.snaps.set("scheduler-v2/" + RK + "|" + A + "|" + SHADOW_HASH, { ...w.snaps.get("scheduler-v2/" + RK + "|" + A + "|" + SHADOW_HASH), source_refreshed_at: natural.created_at });
  }
  w.n.attempts.length = 0;
  return w;
}
const counts = (w) => JSON.parse(JSON.stringify({ ...w.n, foreignSql: w.n.foreignSql.length, attempts: w.n.attempts.length }));

/* ===================== N1. the strand, reproduced WITHOUT the collaborator (today) ===================== */
await (async () => {
  for (const shape of ["failed", "ok"]) {
    const w = await publishedThenNatural(shape);
    const before = counts(w);
    const r = await wire(w, { withForeign: false }).pass();
    assert.deepEqual(r, LEGACY_TERMINAL("succeeded"));
    ok(`N1[${shape}]: WITHOUT readNewestForeignJob the unchanged revision defers 'cycle-not-running:succeeded' byte-identically (the strand); ONE attempt, zero job/shadow/finalize/publish writes`,
      w.n.attempts.length === 1 && w.n.upsert === before.upsert && w.n.shadow === before.shadow && w.n.finalize === before.finalize && w.n.publish === before.publish && !("retryBucketSalt" in r));
  }
})();

/* ===================== N2 / N3. india 09-25 (failed natural) + successful natural job -> ONE pass via ONE salted cycle ===================== */
await (async () => {
  for (const [label, shape] of [["N2 india 09-25 (latest = FAILED natural job)", "failed"], ["N3 latest = SUCCESSFUL natural job (no manifest)", "ok"]]) {
    const w = await publishedThenNatural(shape);
    const cyclesBefore = w.cycles.size;
    const liveBefore = w.live()[0];
    const r = await wire(w).pass();
    const salted = bucketOf(REV_A, "job-natural");
    const c2 = w.cycleOf(salted);
    ok(`${label}: converges in ONE pass -> published + read back (READBACK_VERIFIED)`, r.ok === true && r.code === 0 && statusFromRelease(r) === RECONCILE_STATUS.READBACK_VERIFIED);
    ok(`${label}: exactly TWO attempts -- the own terminal bucket (salt returned), then the salted bucket keyed on the natural job id`,
      w.n.attempts.length === 2 && w.n.attempts[0] === bucketOf(REV_A) && w.n.attempts[1] === salted && salted !== bucketOf(REV_A) && BUCKET_RE.test(salted));
    ok(`${label}: exactly ONE new cycle (the salted one), terminal succeeded, holding the new validated job with this revision's manifest`,
      w.cycles.size === cyclesBefore + 1 && !!c2 && c2.status === "succeeded" && (() => { const L = w.lineage(A); return L.cycleId === c2.id && L.validated === true && L.durableContentDeps.includes(TOKEN(REV_A)); })());
    ok(`${label}: the live row is the salted cycle's promotion (stamp = its created_at; payload = this revision's derive)`,
      w.live().length === 1 && w.live()[0].source_refreshed_at === c2.created_at && JSON.stringify(w.live()[0].payload) === JSON.stringify(payloadOf(REV_A)) && w.live()[0].source_refreshed_at > liveBefore.source_refreshed_at);
    ok(`${label}: the foreign reader ran ONCE through the production SQL (and only in the stranded attempt)`, w.n.readForeign === 1 && w.n.foreignSql.length === 1 && w.n.foreignSql[0].sql === LISTING_HEALTH_V3_FOREIGN_JOB_SQL);
    const again = await wire(w).pass();
    ok(`${label}: a further pass is idempotent (the salted bucket is terminal + its job is the latest -> WP2 resume -> already-current; no new cycle)`, again.ok === true && w.cycles.size === cyclesBefore + 1 && w.n.liveWrites === 2);
  }
})();

/* ===================== N4. crash after the salted cycle's finalize -> the next pass resumes there (no third cycle) ===================== */
await (async () => {
  const w = await publishedThenNatural("failed");
  const killAfterFinalize = async (args) => { await w.finalizeCycle(args); throw new Error("process killed after finalize"); };
  const r1 = await wire(w, { finalizeCycle: killAfterFinalize }).pass();
  const salted = bucketOf(REV_A, "job-natural");
  const c2 = w.cycleOf(salted);
  ok("N4: pass 1 died after the SALTED cycle's finalize -> that cycle terminal + its validated job latest, ZERO new live writes", r1.ok === false && r1.stage === "finalize" && !!c2 && c2.status === "succeeded" && w.lineage(A).cycleId === c2.id && w.n.liveWrites === 1);
  const cyclesAfterCrash = w.cycles.size;
  const before = counts(w);
  const r2 = await wire(w).pass();
  ok("N4: pass 2 converges (READBACK_VERIFIED) and opens NO third cycle", r2.ok === true && statusFromRelease(r2) === RECONCILE_STATUS.READBACK_VERIFIED && w.cycles.size === cyclesAfterCrash);
  ok("N4: pass 2 re-reached the SAME salted bucket (the foreign job is still the natural one -- crash-stable salt)", w.n.attempts.slice(-2)[0] === bucketOf(REV_A) && w.n.attempts.slice(-1)[0] === salted);
  ok("N4: the salted attempt RESUMED (WP2): zero job/lease/shadow/reconcile/finalize writes, one publish", w.n.upsert === before.upsert && w.n.claimLease === before.claimLease && w.n.shadow === before.shadow && w.n.reconcile === before.reconcile && w.n.finalize === before.finalize && w.n.liveWrites === before.liveWrites + 1);
  ok("N4: the live row is the salted cycle's promotion", w.live()[0].source_refreshed_at === c2.created_at);
})();

/* ===================== N5. A -> B -> A manifest revert converges ===================== */
await (async () => {
  const w = makeWorld();
  currentRev = REV_A; const rA = await wire(w).pass();
  currentRev = REV_B; const rB = await wire(w).pass();
  ok("N5: A then B publish in their own deterministic buckets (fresh cycles)", rA.ok === true && rB.ok === true && !!w.cycleOf(bucketOf(REV_A)) && !!w.cycleOf(bucketOf(REV_B)) && JSON.stringify(w.live()[0].payload) === JSON.stringify(payloadOf(REV_B)));
  const jobB = w.lineage(A).id;
  currentRev = REV_A;
  const wNo = JSON.parse(JSON.stringify({ size: w.cycles.size }));
  const stranded = await wire(w, { withForeign: false }).direct(bucketOf(REV_A));
  assert.deepEqual(stranded, LEGACY_TERMINAL("succeeded"));
  ok("N5: WITHOUT the fix the revert to A strands in A's terminal bucket ('cycle-not-running:succeeded')", w.cycles.size === wNo.size);
  const r = await wire(w).pass();
  const salted = bucketOf(REV_A, jobB);
  ok("N5: WITH the fix the revert converges in ONE pass via the bucket salted by B's job (the newest job without A's manifest)",
    r.ok === true && statusFromRelease(r) === RECONCILE_STATUS.READBACK_VERIFIED && w.n.attempts.slice(-1)[0] === salted && !!w.cycleOf(salted));
  ok("N5: A's content is live again (payload + the salted cycle's stamp)", JSON.stringify(w.live()[0].payload) === JSON.stringify(payloadOf(REV_A)) && w.live()[0].source_refreshed_at === w.cycleOf(salted).created_at);
})();

/* ===================== N6. no foreign job / failures / non-success -> BYTE-IDENTICAL to today ===================== */
await (async () => {
  // A terminal own bucket whose latest job is NOT resumable and NO job lacks this manifest: a later twin job in another
  // cycle carrying the SAME manifest (e.g. a concurrent pass) but a different shadow hash.
  const setup = async () => {
    const w = makeWorld(); currentRev = REV_A;
    await wire(w).pass();
    w.cycles.set("twin|" + ASOF, { id: "cyc-twin", bucket: "twin", cycle_date: ASOF, status: "succeeded", created_at: w.tick() });
    w.jobs.push({ id: "job-twin", cycle_id: "cyc-twin", report_key: RK, account_id: A, depends_on: ["rh-l", "rh-r"], durable_content_deps: [TOKEN(REV_A)], derive_status: "succeeded", save_status: "succeeded", validated: true, snapshot_params_hash: "f".repeat(40), created_at: w.nextSeq() });
    w.n.attempts.length = 0;
    return w;
  };
  {
    const w = await setup(); const before = counts(w);
    const r = await wire(w).pass();
    assert.deepEqual(r, LEGACY_TERMINAL("succeeded"));
    ok("N6: no foreign job (every job carries this manifest) -> the legacy deferral byte-identically, ONE attempt, no salt, zero writes",
      w.n.attempts.length === 1 && w.n.readForeign === before.readForeign + 1 && w.n.upsert === before.upsert && w.n.shadow === before.shadow && w.n.publish === before.publish && w.cycles.size === 2 /* own + twin: no new cycle */);
  }
  const variants = [
    ["the foreign reader throws", { readNewestForeignJob: async () => { throw new Error("pg down"); } }],
    ["the foreign reader returns null", { readNewestForeignJob: async () => null }],
    ["the foreign reader returns a row with a blank id", { readNewestForeignJob: async () => ({ id: "  ", durableContentDeps: [] }) }],
    ["the 'foreign' row actually carries this manifest (reader contract violation)", { readNewestForeignJob: async () => ({ id: "job-x", durableContentDeps: [TOKEN(REV_A)] }) }],
  ];
  for (const [label, over] of variants) {
    const w = await publishedThenNatural("failed"); const before = counts(w);
    const r = await wire(w, over).pass();
    assert.deepEqual(r, LEGACY_TERMINAL("succeeded"), label);
    ok(`N6: ${label} -> the legacy deferral byte-identically; ONE attempt; zero writes`, w.n.attempts.length === 1 && w.n.upsert === before.upsert && w.n.publish === before.publish);
  }
  {
    const w = await publishedThenNatural("failed"); const before = counts(w);
    const r = await wire(w, { readLatestJob: async () => { throw new Error("read failed (503)"); } }).pass();
    assert.deepEqual(r, LEGACY_TERMINAL("succeeded"));
    ok("N6: an UNREADABLE latest job never salts (fail closed): legacy deferral, the foreign reader is NOT consulted", w.n.readForeign === before.readForeign && w.n.attempts.length === 1);
  }
  {
    const w = await publishedThenNatural("failed");
    w.cycleOf(bucketOf(REV_A)).status = "failed";
    const before = counts(w);
    const r = await wire(w).pass();
    assert.deepEqual(r, LEGACY_TERMINAL("failed"));
    ok("N6: a non-success terminal status ('failed') defers exactly as today WITHOUT reading the latest or the foreign job", w.n.readLatest === before.readLatest && w.n.readForeign === before.readForeign && w.n.attempts.length === 1);
  }
  {
    const w = makeWorld(); currentRev = REV_A;
    const r = await wire(w).pass();
    ok("N6: a FRESH pass publishes in the deterministic bucket and never consults the latest or foreign job", r.ok === true && w.n.readLatest === 0 && w.n.readForeign === 0 && w.n.attempts.length === 1 && w.n.attempts[0] === bucketOf(REV_A));
    const w2 = makeWorld();
    await w2.openCycle({ bucket: bucketOf(REV_A), cycleDate: ASOF }); w2.cycleOf(bucketOf(REV_A)).status = "running";
    const r2 = await wire(w2).pass();
    ok("N6: an already-RUNNING own cycle proceeds exactly as today, foreign reader untouched", r2.ok === true && w2.n.readForeign === 0 && w2.n.upsert === 1);
    const w3 = makeWorld();
    const killAfterFinalize = async (args) => { await w3.finalizeCycle(args); throw new Error("killed"); };
    await wire(w3, { finalizeCycle: killAfterFinalize }).pass();
    const r3 = await wire(w3).pass();
    ok("N6: the WP2 own-bucket crash resume still resumes (latest job IS this cycle's) -- the foreign reader is never consulted", r3.ok === true && w3.n.readForeign === 0 && w3.cycles.size === 1);
  }
  {
    // The SECOND attempt's salt is never followed: the salted bucket is ALSO terminal with a not-resumable latest job and
    // a NEWER foreign job exists -> exactly two attempts, the second's legacy deferral (+ its salt) is returned as-is.
    const w = await publishedThenNatural("failed");
    const salted = bucketOf(REV_A, "job-natural");
    w.cycles.set(salted + "|" + ASOF, { id: "cyc-salted-closed", bucket: salted, cycle_date: ASOF, status: "succeeded", created_at: w.tick() });
    const r = await wire(w).pass();
    ok("N6: a stranded SALTED bucket is not followed further (bounded: two attempts; the next pass converges)", w.n.attempts.length === 2 && r.ok === false && r.reason === "cycle-not-running:succeeded" && r.retryBucketSalt === "job-natural");
  }
  {
    // Abort observed during the foreign read -> DEADLINE_ABORTED, no retry started.
    const w = await publishedThenNatural("failed");
    const controller = new AbortController(); const publishesBefore = w.n.publish;
    const aborting = async (...args) => { const out = await w.readNewestForeignJob(...args); controller.abort(); return out; };
    const r = await wire(w, { readNewestForeignJob: aborting, signal: controller.signal }).pass();
    ok("N6: an abort during the foreign read -> DEADLINE_ABORTED; the salted retry is never started", r.status === "DEADLINE_ABORTED" && w.n.attempts.length === 1 && w.n.publish === publishesBefore);
  }
  let threw = false;
  try { buildListingHealthV3Release({ ...Object.fromEntries(["resolveBundle", "openCycle", "getCycleByBucketDate", "claimCycle", "deriveSnapshot", "computeHash", "upsertReportJob", "claimLease", "saveShadow", "reconcileSuccess", "finalizeCycle", "readbackLive", "readLatestJob"].map((k) => [k, async () => null])), reportDerivations: REPORT_DERIVATIONS, liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, publisher: { preflight: async () => null, publish: async () => null }, readNewestForeignJob: "not-a-function" }); } catch { threw = true; }
  ok("N6: a non-function readNewestForeignJob is refused at build time (fail closed)", threw);
})();

/* ===================== N7. the bucket helper ===================== */
await (async () => {
  const legacy = (b, accountId, revisionId) => "priority-partial-" + b + "-" + sha256(JSON.stringify([accountId, revisionId || ""])).slice(0, 16);
  const cases = [["india", A, REV_A], ["europe-au", "acct-x", "rev-1"], ["us-ca", "acct-y", null], ["india", "acct-z", ""], ["us-ca", A, REV_B]];
  ok("N7: the UNSALTED bucket is byte-identical to the pre-WP16 CLI expression (incl. a null / blank revision)", cases.every(([b, a, r]) => listingHealthV3ReleaseCycleBucket({ region: b, accountId: a, revisionId: r }) === legacy(b, a, r) && listingHealthV3ReleaseCycleBucket({ region: b, accountId: a, revisionId: r, salt: "" }) === legacy(b, a, r)));
  const salted = cases.map(([b, a, r]) => listingHealthV3ReleaseCycleBucket({ region: b, accountId: a, revisionId: r, salt: "job-natural" }));
  ok("N7: a SALTED bucket = sha256(JSON.stringify([accountId, revisionId || '', salt])).slice(0,16), differs from the unsalted one, and is deterministic",
    cases.every(([b, a, r], i) => salted[i] === "priority-partial-" + b + "-" + sha256(JSON.stringify([a, r || "", "job-natural"])).slice(0, 16) && salted[i] !== legacy(b, a, r) && salted[i] === listingHealthV3ReleaseCycleBucket({ region: b, accountId: a, revisionId: r, salt: "job-natural" })));
  ok("N7: every salted + unsalted bucket satisfies the migration-20260924 CHECK / open_sync_cycle guard (^priority-partial-(india|europe-au|us-ca)-[0-9a-f]{16}$)",
    [...salted, ...cases.map(([b, a, r]) => legacy(b, a, r))].every((x) => BUCKET_RE.test(x)) && PARTIAL_CYCLE_CAPABILITY_PATTERN === "^priority-partial-(india|europe-au|us-ca)-[0-9a-f]{16}$");
  const mig = readFileSync(path.join(ROOT, "supabase/migrations/20260924_priority_partial_cycle_bucket.sql"), "utf8");
  ok("N7: the migration's CHECK (bucket ~) and RPC guard (p_bucket ~) both carry exactly that quoted pattern",
    /or bucket ~ '\^priority-partial-\(india\|europe-au\|us-ca\)-\[0-9a-f\]\{16\}\$'/.test(mig) && /or p_bucket ~ '\^priority-partial-\(india\|europe-au\|us-ca\)-\[0-9a-f\]\{16\}\$'/.test(mig)
    && (mig.match(/'\^priority-partial-\(india\|europe-au\|us-ca\)-\[0-9a-f\]\{16\}\$'/g) || []).length === 2);
  ok("N7: different salts -> different buckets (one cycle per DISTINCT foreign job)", listingHealthV3ReleaseCycleBucket({ region: "india", accountId: A, revisionId: REV_A, salt: "job-1" }) !== listingHealthV3ReleaseCycleBucket({ region: "india", accountId: A, revisionId: REV_A, salt: "job-2" }));
})();

/* ===================== N8. the production foreign-job reader ===================== */
await (async () => {
  const sql = LISTING_HEALTH_V3_FOREIGN_JOB_SQL;
  ok("N8: the reader SQL is ONE read-only select (no ; / DML / DDL / function call beyond coalesce)", /^select\s/i.test(sql.trim()) && !sql.includes(";") && !/\b(insert|update|delete|truncate|alter|drop|create|grant|call|perform)\b/i.test(sql));
  ok("N8: it filters (report_key, account_id), NOT-contains the manifest (jsonb @>), orders newest first (created_at, id) and takes ONE row",
    /where j\.report_key = \$1 and j\.account_id = \$2/.test(sql) && /not \(coalesce\(j\.durable_content_deps, '\[\]'::jsonb\) @> \$3::jsonb\)/.test(sql) && /order by j\.created_at desc, j\.id desc/.test(sql) && /limit 1\s*$/.test(sql));
  const seen = [];
  const reader = buildListingHealthV3ForeignJobReader({ query: async (q, p, o) => { seen.push({ q, p, o }); return [{ id: "job-9", cycle_id: "cyc-9", durable_content_deps: ["x"] }]; } });
  const ctl = new AbortController();
  const got = await reader(RK, A, [TOKEN(REV_A), " "], { signal: ctl.signal });
  ok("N8: params are [reportKey, accountId, JSON(non-blank tokens)] and the signal is threaded", seen.length === 1 && seen[0].q === sql && JSON.stringify(seen[0].p) === JSON.stringify([RK, A, JSON.stringify([TOKEN(REV_A)])]) && seen[0].o.signal === ctl.signal);
  ok("N8: a row maps to { id, cycleId, durableContentDeps }", JSON.stringify(got) === JSON.stringify({ id: "job-9", cycleId: "cyc-9", durableContentDeps: ["x"] }));
  ok("N8: an empty identity / blank account never queries (null)", (await reader(RK, A, [])) === null && (await reader(RK, "", [TOKEN(REV_A)])) === null && seen.length === 1);
  const none = buildListingHealthV3ForeignJobReader({ query: async () => [] });
  ok("N8: no row -> null", (await none(RK, A, [TOKEN(REV_A)])) === null);
  let threw = false; try { buildListingHealthV3ForeignJobReader({}); } catch { threw = true; }
  ok("N8: the reader refuses to build without a query function", threw);
})();

/* ===================== N9. the reconcile CLI wiring (static) ===================== */
{
  const cli = readFileSync(path.join(ROOT, "scripts/release/listing-health-v3-reconcile.mjs"), "utf8");
  const code = cli.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  ok("N9: the CLI hands readNewestForeignJob (the production reader over its read-only pg query) to the release", /const readNewestForeignJob = buildListingHealthV3ForeignJobReader\(\{ query: pgReadOnlyQuery \}\)/.test(code) && /\n\s*readNewestForeignJob,\n/.test(code));
  ok("N9: the CLI runs the account through runListingHealthV3ReleaseWithForeignRetry with the region bucket (no own cycleBucket expression left)",
    /runListingHealthV3ReleaseWithForeignRetry\(\{ release, region: b, accountId, requestedAsOf, revisionId, signal \}\)/.test(code) && !/sha256\(JSON\.stringify\(\[accountId/.test(code) && !/release\.runForAccount\(/.test(code));
  ok("N9: the pg query client is constructed INSIDE try (never `const client = new pg.Client(`), verified TLS, error-listened, client query timeout (NO statement_timeout startup parameter), ended on deadline abort, always ended",
    /try \{\n\s*client = new pg\.Client\(verifiedPgConfig\(process\.env\.POSTGRES_URL, \{ connectionTimeoutMillis: 20000, query_timeout: 30000 \}\)\);\n\s*client\.on\("error"/.test(code)
    && !/statement_timeout/.test(code)
    && /signal\.addEventListener\("abort", onAbort, \{ once: true \}\)/.test(code) && /onAbort = \(\) => \{ c\.end\(\)\.catch\(\(\) => \{\}\); \}/.test(code)
    && /if \(onAbort\) signal\.removeEventListener\("abort", onAbort\);/.test(code)
    && !/const (client|probe) = (makePgReadOnly\(\)|new pg\.Client\()/.test(code) && /if \(client\) \{ try \{ await client\.end\(\); \}/.test(code));
}

/* ===================== N10. zero DataDoe / network ===================== */
ok("N10: ZERO network calls (no DataDoe, no PostgREST) across every scenario", netCalls.length === 0);

writeSync(1, `\nlisting-health-v3-reconcile-nonce: ${passed} checks passed\n`);
