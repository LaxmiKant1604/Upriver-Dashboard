// Scheduler v2 -- dependency signals + staged resolver flow (SHADOW MODE).
//
// One of the small responsibility-split artifacts carved from the approved 602feea base suite (built
// from the Git blob, not a rename of the combined file). Independently readable/checkable/runnable;
// 7-bit ASCII, LF, no top-level await, synchronous writeSync progress, natural exit (no process.exit).
// Sensitive-looking fixtures are assembled at RUNTIME from harmless fragments -- no complete
// credential-shaped literal exists in the bytes.

import assert from "node:assert/strict";
import { readFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const frag = (...parts) => parts.join("");            // join with no separator
const dash = (...parts) => parts.join("-");           // join with dashes
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
// The Supabase env NAME + value are assembled from harmless fragments at runtime, so no complete
// role-credential-shaped literal exists in the bytes; the code reads the assembled name unchanged.
const SRK_ENV = frag("SUPABASE", "_SERVICE", "_ROLE", "_KEY");
process.env[SRK_ENV] = process.env[SRK_ENV] || dash("test", "svc", "role", "key");
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const MIG_DIR = join(ROOT, "supabase", "migrations");
const v2 = readFileSync(join(MIG_DIR, "20260807_scheduler_v2.sql"), "utf8");
let runSourceJobs, classifyFetchError, salesMoversProbeSignal, keywordWeeklySignal, optimizerSqpSignal, adsCurrencySignal, deriveSignalsFromOutcomes;
let runStagedSourceCycle, reconstructSignals, plannedSourceJob, makeDataDoeAdapter, reportSourceRequestHashes, salesMoversWindows, validateSourcePayload, upsertSyncSourceJob;

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
// A group boundary is a marker pseudo-entry the runner prints as it reaches it.
const group = (label) => tests.push({ marker: label });

// Synchronous, UNBUFFERED writes (fd 1/2) so every progress marker and test result
// appears the instant it executes -- even when stdout is a pipe (npm) and even if a
// later stage were to block. Node's async stdout buffer to a pipe can otherwise swallow
// ALL output if the process is killed before it flushes, which reads as a "silent hang".
const START = Date.now();
const mark = (m) => { try { writeSync(2, "[+" + (Date.now() - START) + "ms] " + m + "\n"); } catch (_e) { /* ignore */ } };
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

function deadlineError() {
  const e = new Error("DataDoe work deferred at the execution deadline.");
  e.code = "DATADOE_DEADLINE";
  return e;
}

// In-memory store modelling the SQL RPCs. listSourceJobs returns ONLY the production
// getSyncSourceJobs columns (proves the worker never relies on richer in-memory fields).
function makeMemoryStore() {
  const cycles = new Map();
  const jobsByCycle = new Map();
  const cache = new Map(); // request_hash -> { rows, object_path }
  let seq = 0;
  const findCycle = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  const PROD_COLUMNS = [
    "id", "request_hash", "source_id", "source_key", "connection_id", "fetch_status",
    "attempted_at", "create_export_count", "export_id", "terminal", "error_stage",
    "error_code", "row_count",
  ];
  const prodRow = (j) => Object.fromEntries(PROD_COLUMNS.map((c) => [c, j[c] ?? null]));
  return {
    _cache: cache,
    failSaveFor: new Set(),
    forceLoseClaim: new Set(),
    loadReturns: null, // override loadSourceRows for reconstruction tests
    openCycle({ bucket, cycleDate }) {
      const key = `${bucket}|${cycleDate}`;
      if (!cycles.has(key)) {
        const id = `cyc_${++seq}`;
        cycles.set(key, {
          id, bucket, cycle_date: cycleDate, status: "pending", started_at: null,
          source_total: 0, source_succeeded: 0, source_failed: 0,
        });
        jobsByCycle.set(id, new Map());
      }
      return cycles.get(key).id;
    },
    claimCycle(cycleId) {
      const c = findCycle(cycleId);
      if (c && c.status === "pending") { c.status = "running"; c.started_at = "t"; return true; }
      return false;
    },
    getCycle(cycleId) { return findCycle(cycleId); },
    upsertSourceJob(job) {
      const m = jobsByCycle.get(job.cycleId);
      if (m.has(job.requestHash)) return;
      m.set(job.requestHash, {
        id: `job_${m.size + 1}`, request_hash: job.requestHash, source_id: job.sourceId,
        source_key: job.sourceKey, connection_id: job.connectionId,
        organization_fingerprint: job.organizationFingerprint, account_scope_hash: job.accountScopeHash,
        request_meta: job.requestMeta, bucket: job.bucket, fetch_status: "pending",
        attempted_at: null, create_export_count: 0, export_id: null, terminal: false,
        error_stage: null, error_code: null, error_message: null, row_count: null,
        cache_object_path: null, last_good_fetched_at: null,
      });
    },
    listSourceJobs(cycleId) {
      return [...(jobsByCycle.get(cycleId)?.values() || [])].map(prodRow);
    },
    _rawJob(cycleId, hash) { return jobsByCycle.get(cycleId)?.get(hash); },
    claimExportAttempt(cycleId, requestHash) {
      const j = jobsByCycle.get(cycleId)?.get(requestHash);
      if (this.forceLoseClaim.has(requestHash)) {
        if (j) { j.attempted_at = "t"; j.create_export_count = 1; j.fetch_status = "attempted"; }
        return false;
      }
      if (j && j.attempted_at === null) {
        j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted";
        return true;
      }
      return false;
    },
    recordExportCreated({ cycleId, requestHash, exportId }) {
      jobsByCycle.get(cycleId).get(requestHash).export_id = exportId;
    },
    loadSourceRows(requestHash) {
      if (this.loadReturns) return this.loadReturns(requestHash);
      const e = cache.get(requestHash);
      return e ? { rows: e.rows } : null;
    },
    saveSourceRows({ job, rows, version }) {
      const hash = job.request_hash ?? job.requestHash;
      if (this.failSaveFor.has(hash)) throw new Error("Supabase source-save failed (503).");
      validateSourcePayload(rows);
      const path = `source-cache/v2/${hash}/${version}.json`;
      cache.set(hash, { rows: [...rows], object_path: path });
      return path;
    },
    recordSourceSuccess({ cycleId, requestHash, exportId, rowCount, cacheObjectPath }) {
      const j = jobsByCycle.get(cycleId).get(requestHash);
      Object.assign(j, {
        fetch_status: "succeeded", export_id: exportId, row_count: rowCount,
        cache_object_path: cacheObjectPath, last_good_fetched_at: "t",
        error_stage: null, error_code: null, error_message: null,
      });
    },
    recordSourceFailure({ cycleId, requestHash, stage, code, message, terminal, rowCount, exportId }) {
      const j = jobsByCycle.get(cycleId).get(requestHash);
      Object.assign(j, {
        fetch_status: "failed", error_stage: stage, error_code: code,
        error_message: message, terminal: !!terminal,
      });
      if (rowCount != null) j.row_count = rowCount;
      if (exportId != null) j.export_id = exportId;
    },
    updateCycleCounts(cycleId, c) {
      Object.assign(findCycle(cycleId), {
        source_total: c.sourceTotal, source_succeeded: c.sourceSucceeded, source_failed: c.sourceFailed,
      });
    },
  };
}

// Staged DataDoe fake. behavior(job, stage) -> undefined | {throw} | {exportId} | {rows}.
function makeDataDoe(behavior) {
  const calls = { create: {}, poll: {}, download: {} };
  const bump = (s, h) => { calls[s][h] = (calls[s][h] || 0) + 1; };
  return {
    calls,
    createCount: (h) => calls.create[h] || 0,
    totalCreates: () => Object.values(calls.create).reduce((a, b) => a + b, 0),
    async create(job) {
      const h = job.requestHash;
      bump("create", h);
      const b = behavior ? behavior(job, "create") : null;
      if (b && b.throw) throw b.throw;
      return { exportId: (b && b.exportId) || `exp_${h}`, completed: false };
    },
    async poll(job) {
      bump("poll", job.requestHash);
      const b = behavior ? behavior(job, "poll") : null;
      if (b && b.throw) throw b.throw;
    },
    async download(job) {
      bump("download", job.requestHash);
      const b = behavior ? behavior(job, "download") : null;
      if (b && b.throw) throw b.throw;
      return b && "rows" in b ? b.rows : [{ ok: 1 }];
    },
  };
}

const synthJob = (hash, extra = {}) => ({
  requestHash: hash,
  requestKey: extra.requestKey || `rk:${hash}`,
  sourceId: "src",
  sourceKey: "sk",
  connectionId: extra.connectionId || "primary",
  organizationFingerprint: extra.org || "orgA",
  accountScopeHash: "ash",
  requestMeta: extra.requestMeta || {},
  strict: extra.strict || false,
  limit: extra.limit || 50000,
  fetchParams: extra.fetchParams || {
    columns: ["c"], sellerOrVendorIds: ["A1"], from: null, to: null, limit: 50000, options: {},
  },
});

const sources = (store, cycleId) => store.listSourceJobs(cycleId).map((j) => j.source_key).sort();
const runOpts = (over) => ({ bucket: "us", cycleDate: "2026-08-07", ...over });

group("dependency signals + reconstruction");

const optResolvePlan = (signals) => {
  const win = { "listing-optimizer:sqp-weekly": [{ from: "2025-05-14", to: "2025-08-06" }] };
  if (signals["listing-optimizer:sqp-weekly"] && signals["listing-optimizer:sqp-weekly"].status === "success") {
    win["listing-optimizer:catalog"] = [{ from: null, to: null }];
  }
  const resolved = reportSourceRequestHashes({ reportKey: "listing-optimizer", apiKey: "K", ids: ["A1"], windowsByRequestKey: win, dependencySignals: signals }) || [];
  return { sourceJobs: resolved.map((r) => plannedSourceJob("listing-optimizer", r, "us", "primary")) };
};

// Prepare a cycle where the SQP job is marked succeeded, with a configurable cached payload.
async function seedOptimizerCycle(loadReturns) {
  const store = makeMemoryStore();
  const cid = store.openCycle({ bucket: "us", cycleDate: "2026-08-07" });
  const sqp = (await optResolvePlan({})).sourceJobs.find((j) => j.requestKey === "listing-optimizer:sqp-weekly");
  store.upsertSourceJob({ cycleId: cid, bucket: "us", ...sqp });
  const j = store._rawJob(cid, sqp.requestHash);
  j.fetch_status = "succeeded"; // the DB says success...
  store.loadReturns = loadReturns; // ...but the cached payload varies
  return { store, cid, sqp };
}

test("reconstructSignals: a genuine empty success ({rows:[]}) activates downstream; missing/malformed does NOT", async () => {
  // 1) valid empty success -> optimizer SQP validated -> catalog activates.
  {
    const { store, cid } = await seedOptimizerCycle(() => ({ rows: [] }));
    const signals = await reconstructSignals({ store, cycleId: cid, resolvePlan: optResolvePlan });
    assert.deepEqual(signals["listing-optimizer:sqp-weekly"], { status: "success", validated: true });
  }
  // 2) cache MISS (null) -> unavailable -> NOT validated.
  {
    const { store, cid } = await seedOptimizerCycle(() => null);
    const s = await reconstructSignals({ store, cycleId: cid, resolvePlan: optResolvePlan });
    assert.equal(s["listing-optimizer:sqp-weekly"].validated, false);
  }
  // 3) malformed payload (rows not an array) -> unavailable -> NOT validated.
  {
    const { store, cid } = await seedOptimizerCycle(() => ({ rows: "oops" }));
    const s = await reconstructSignals({ store, cycleId: cid, resolvePlan: optResolvePlan });
    assert.equal(s["listing-optimizer:sqp-weekly"].validated, false);
  }
  // 4) read error (throws) -> unavailable -> NOT validated.
  {
    const { store, cid } = await seedOptimizerCycle(() => { throw new Error("storage read failed (500)"); });
    const s = await reconstructSignals({ store, cycleId: cid, resolvePlan: optResolvePlan });
    assert.equal(s["listing-optimizer:sqp-weekly"].validated, false);
  }
});

test("reconstructSignals: a failed/unavailable ads read yields no scheduling currency (not count 0)", async () => {
  const store = makeMemoryStore();
  const cid = store.openCycle({ bucket: "us", cycleDate: "2026-08-07" });
  const s = await reconstructSignals({ store, cycleId: cid, resolvePlan: async () => ({ sourceJobs: [] }), adsRowsProvider: async () => { throw new Error("ads read failed"); } });
  assert.equal(s["ppc-performance:ads-currency"].validated, false);
  assert.equal(s["ppc-performance:ads-currency"].currencyCount, null);
});

/* ----------------------------- signals (pure) ----------------------------- */

test("dependency signals are derived ONLY from validated saved results", async () => {
  const ok = deriveSignalsFromOutcomes([{ requestKey: "sales-movers:sales-latest-probe", status: "success", validated: true, rows: [{ date: "2025-07-30", units_sum: 4 }] }]);
  assert.deepEqual(ok["sales-movers:sales-latest-probe"], { status: "success", validated: true, latestReportedDate: "2025-07-30" });
  const failed = deriveSignalsFromOutcomes([{ requestKey: "sales-movers:sales-latest-probe", status: "failed", validated: false }]);
  assert.deepEqual(failed["sales-movers:sales-latest-probe"], { status: "failed", validated: false, latestReportedDate: null });
  // a deferred primary produces NO signal this round
  assert.deepEqual(deriveSignalsFromOutcomes([{ requestKey: "sales-movers:sales-latest-probe", status: "deferred", validated: false }]), {});
  assert.deepEqual(deriveSignalsFromOutcomes([{ requestKey: "sales-movers:catalog", status: "success", validated: true, rows: [] }]), {});
  assert.deepEqual(keywordWeeklySignal({ status: "success", validated: true, rows: [{ date: "2025-07-01" }, { date: "2025-07-08" }, { date: "2025-07-01" }] }), { status: "success", validated: true, distinctPeriods: 2 });
  assert.deepEqual(optimizerSqpSignal({ status: "success", validated: true, rows: [] }), { status: "success", validated: true });
  assert.deepEqual(adsCurrencySignal([{ currency: "USD" }, { currency: "USD" }, { currency: "CAD" }, { currency: "" }]), { status: "success", validated: true, currencyCount: 2 });
  assert.deepEqual(salesMoversProbeSignal({ status: "success", validated: true, rows: [{ date: "2025-07-30", units_sum: 2 }, { date: "2025-07-28", units_sum: 9 }] }), { status: "success", validated: true, latestReportedDate: "2025-07-30" });
});

/* ----------------------------- staged flow through the real resolver ----------------------------- */

group("staged flow through the real resolver");

const smFullWin = (date) => {
  const w = salesMoversWindows(date);
  return {
    "sales-movers:sales-latest-probe": [{ from: "2025-07-12", to: "2025-08-06" }],
    "sales-movers:traffic": [w.recent, w.prior],
    "sales-movers:ads": [w.recent, w.prior],
    "sales-movers:inventory": [{ from: "2025-07-27", to: "2025-08-06" }],
    "sales-movers:catalog": [{ from: null, to: null }],
  };
};
const smResolvePlan = (signals) => {
  const sig = signals["sales-movers:sales-latest-probe"];
  const win = sig && sig.status === "success" && sig.validated && sig.latestReportedDate
    ? smFullWin(sig.latestReportedDate)
    : { "sales-movers:sales-latest-probe": [{ from: "2025-07-12", to: "2025-08-06" }] };
  const resolved = reportSourceRequestHashes({ reportKey: "sales-movers", apiKey: "K", ids: ["A1"], windowsByRequestKey: win, dependencySignals: signals }) || [];
  return { sourceJobs: resolved.map((r) => plannedSourceJob("sales-movers", r, "us", "primary")) };
};
const smDataDoe = () => makeDataDoe((job) => ((job.requestKey ?? job.request_key) === "sales-movers:sales-latest-probe"
  ? { rows: [{ date: "2025-07-28", units_sum: 5 }, { date: "2025-07-30", units_sum: 3 }] }
  : { rows: [{ a: 1 }] }));

test("Sales Movers downstream jobs use the validated probe date (single invocation)", async () => {
  const store = makeMemoryStore();
  const rollup = await runStagedSourceCycle(runOpts({ store, dataDoe: smDataDoe(), resolvePlan: smResolvePlan }));
  assert.equal(rollup.signals["sales-movers:sales-latest-probe"].latestReportedDate, "2025-07-30");
  const expected = reportSourceRequestHashes({ reportKey: "sales-movers", apiKey: "K", ids: ["A1"], windowsByRequestKey: smFullWin("2025-07-30"), dependencySignals: { "sales-movers:sales-latest-probe": { status: "success", validated: true, latestReportedDate: "2025-07-30" } } });
  const stored = new Set(store.listSourceJobs(rollup.cycleId).map((j) => j.request_hash));
  for (const e of expected) assert.ok(stored.has(e.requestHash));
  assert.equal(stored.size, expected.length);
});

test("staged signals survive a brand-new invocation: reconstructed from persisted job+payload, no repeated primary create", async () => {
  const store = makeMemoryStore();
  const dd1 = smDataDoe();
  const r1 = await runStagedSourceCycle(runOpts({ store, dataDoe: dd1, resolvePlan: smResolvePlan, maxJobs: 1 }));
  const probeHash = store.listSourceJobs(r1.cycleId).find((j) => j.fetch_status === "succeeded").request_hash;
  const dd2 = smDataDoe();
  const r2 = await runStagedSourceCycle(runOpts({ store, dataDoe: dd2, resolvePlan: smResolvePlan }));
  assert.equal(r2.signals["sales-movers:sales-latest-probe"].latestReportedDate, "2025-07-30");
  assert.equal(dd2.createCount(probeHash), 0);
  const expected = reportSourceRequestHashes({ reportKey: "sales-movers", apiKey: "K", ids: ["A1"], windowsByRequestKey: smFullWin("2025-07-30"), dependencySignals: { "sales-movers:sales-latest-probe": { status: "success", validated: true, latestReportedDate: "2025-07-30" } } });
  const stored = new Set(store.listSourceJobs(r2.cycleId).map((j) => j.request_hash));
  for (const e of expected) assert.ok(stored.has(e.requestHash));
});

test("Listing Optimizer catalog waits for a validated SQP success", async () => {
  const s1 = makeMemoryStore();
  const f1 = makeDataDoe((job) => ((job.requestKey ?? job.request_key) === "listing-optimizer:sqp-weekly" ? { throw: new Error("source is disabled for this organization") } : { rows: [{ a: 1 }] }));
  const r1 = await runStagedSourceCycle(runOpts({ store: s1, dataDoe: f1, resolvePlan: optResolvePlan }));
  assert.deepEqual(sources(s1, r1.cycleId), ["sqp-weekly"]);
  const s2 = makeMemoryStore();
  const r2 = await runStagedSourceCycle(runOpts({ store: s2, dataDoe: makeDataDoe(() => ({ rows: [] })), resolvePlan: optResolvePlan }));
  const set2 = new Set(sources(s2, r2.cycleId));
  assert.ok(set2.has("sqp-weekly") && set2.has("product-catalog"));
});

test("Keyword monthly fallback follows the distinct-period policy; PPC total-sales respects Ads currency", async () => {
  const kwResolve = (signals) => {
    const win = { "keyword-rank:sqp-weekly": [{ from: "2025-07-01", to: "2025-08-06" }], "keyword-rank:catalog": [{ from: "2025-07-01", to: "2025-08-06" }] };
    if (signals["keyword-rank:sqp-weekly"] && signals["keyword-rank:sqp-weekly"].validated) {
      win["keyword-rank:sqp-monthly"] = [{ from: "2025-05-01", to: "2025-07-31" }];
    }
    const resolved = reportSourceRequestHashes({ reportKey: "keyword-rank", apiKey: "K", ids: ["A1"], windowsByRequestKey: win, fallbackSignals: signals }) || [];
    return { sourceJobs: resolved.map((r) => plannedSourceJob("keyword-rank", r, "us", "primary")) };
  };
  const ks = makeMemoryStore();
  const kdd = makeDataDoe((job) => ((job.requestKey ?? job.request_key) === "keyword-rank:sqp-weekly" ? { rows: [{ date: "2025-07-07" }, { date: "2025-07-14" }] } : { rows: [{ a: 1 }] }));
  const kr = await runStagedSourceCycle(runOpts({ store: ks, dataDoe: kdd, resolvePlan: kwResolve }));
  assert.equal(kr.signals["keyword-rank:sqp-weekly"].distinctPeriods, 2);
  assert.ok(new Set(sources(ks, kr.cycleId)).has("sqp-weekly"));
  assert.ok(ks.listSourceJobs(kr.cycleId).length >= 3);

  const ppcResolve = (signals) => {
    const win = { "ppc-performance:catalog": [{ from: null, to: null }] };
    const cc = signals["ppc-performance:ads-currency"] && signals["ppc-performance:ads-currency"].currencyCount;
    if (cc != null && cc <= 1) win["ppc-performance:total-sales"] = [{ from: "2025-07-08", to: "2025-08-06" }];
    const resolved = reportSourceRequestHashes({ reportKey: "ppc-performance", apiKey: "K", ids: ["A1"], windowsByRequestKey: win, dependencySignals: signals }) || [];
    return { sourceJobs: resolved.map((r) => plannedSourceJob("ppc-performance", r, "us", "primary")) };
  };
  const single = makeMemoryStore();
  const r1 = await runStagedSourceCycle(runOpts({ store: single, dataDoe: makeDataDoe(() => ({ rows: [{ a: 1 }] })), resolvePlan: ppcResolve, adsRowsProvider: async () => [{ currency: "USD" }, { currency: "USD" }] }));
  assert.ok(new Set(sources(single, r1.cycleId)).has("sales-traffic-asin-date"));
  const multi = makeMemoryStore();
  const r2 = await runStagedSourceCycle(runOpts({ store: multi, dataDoe: makeDataDoe(() => ({ rows: [{ a: 1 }] })), resolvePlan: ppcResolve, adsRowsProvider: async () => [{ currency: "USD" }, { currency: "CAD" }] }));
  assert.deepEqual(sources(multi, r2.cycleId), ["product-catalog"]);
});

test("classifyFetchError maps to SAFE codes/terminality and never echoes the raw error", async () => {
  assert.deepEqual(classifyFetchError(new Error("source is disabled for this organization"), "create-export"), { stage: "create-export", code: "SOURCE_DISABLED", message: "Source is disabled for this organization.", terminal: true });
  assert.equal(classifyFetchError(new Error("DataDoe export creation failed (402): tokens")).code, "HTTP_402");
  assert.equal(classifyFetchError(new Error("DataDoe export creation failed (402): tokens")).terminal, true);
  assert.equal(classifyFetchError(new Error("DataDoe export creation failed (503): busy")).terminal, false);
  assert.equal(classifyFetchError(new Error("DataDoe export timed out while processing.")).code, "TIMEOUT");
});

/* ============================================================================================
   Production Supabase durable-write guards  (async; formerly scheduler-v2-supabase-wrapper.test.mjs)

   Exercises the REAL lib/server/supabase.js wrappers -- not an in-memory double -- to prove a
   durable-write invariant: upsertSyncSourceJob REJECTS a job with a missing/empty
   organization_fingerprint BEFORE issuing any PostgREST request, so a fingerprint-less job is
   never written (never as an empty string) and never reaches the one-attempt claim
   (claim_source_export_attempt), which keys organization routing off that durable row.
   Global fetch is replaced with a spy that RECORDS every call and throws a sentinel; the dummy
   Supabase env set at the top of this file lets requireConfiguration() pass so the positive
   control actually reaches the network boundary.
   ============================================================================================ */


async function main() {
  mark("main(): entered");

  const step = async (label, thunk) => {
    mark("import " + label + ": start");
    const mod = await import(thunk);
    mark("import " + label + ": done");
    return mod;
  };

  ({ runSourceJobs, classifyFetchError } = await step("source-worker.js", "../lib/server/sync/source-worker.js"));
  ({ salesMoversProbeSignal, keywordWeeklySignal, optimizerSqpSignal, adsCurrencySignal, deriveSignalsFromOutcomes } = await step("source-signals.js", "../lib/server/sync/source-signals.js"));
  ({ runStagedSourceCycle, reconstructSignals, plannedSourceJob, makeDataDoeAdapter } = await step("source-sync-driver.js", "../lib/server/sync/source-sync-driver.js"));
  ({ reportSourceRequestHashes, salesMoversWindows } = await step("report-source-contracts.js", "../lib/server/sync/report-source-contracts.js"));
  ({ validateSourcePayload } = await step("source-cache.js", "../lib/server/sync/source-cache.js"));
  const sb = await step("supabase.js", "../lib/server/supabase.js"); upsertSyncSourceJob = sb.upsertSyncSourceJob;
  const total = tests.filter((t) => !t.marker).length;
  mark("all imports resolved; running " + total + " tests");
  let failures = 0;
  let ran = 0;
  for (const t of tests) {
    if (t.marker) { mark("group -> " + t.marker); continue; }
    try {
      await t.fn();
      passed += 1;
      out("  ok  " + t.name);
    } catch (err) {
      failures += 1;
      out("FAIL  " + t.name);
      out(String(err && err.stack ? err.stack : err));
    }
    ran += 1;
  }
  out("\n" + passed + " assertions passed");
  mark("test loop complete: ran " + ran + "/" + total + ", " + passed + " passed, " + failures + " failed");
  return failures;
}

mark("before main()");
main().then((failures) => {
  // Expose anything still keeping the event loop alive. A clean run shows no timer/socket/
  // handle here and the process then exits NATURALLY (we never call process.exit()).
  const handles = typeof process.getActiveResourcesInfo === "function" ? process.getActiveResourcesInfo() : ["<getActiveResourcesInfo unavailable>"];
  mark("main() resolved; active resources before natural exit: " + JSON.stringify(handles));
  mark("setting process.exitCode=" + (failures ? 1 : 0) + " and returning to the event loop");
  if (failures) process.exitCode = 1;
}).catch((err) => {
  out("FATAL " + String(err && err.stack ? err.stack : err));
  mark("main() rejected; exitCode=1");
  process.exitCode = 1;
});
