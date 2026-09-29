// WP3 -- the shared saved-data reconciler core's OPT-IN route hooks (units, per-target as-of, two-phase prepare/publish
// with chunked control windows, the served-row verdict, the per-route current predicate) and the TARGETS v2 line.
//
// G0 pins BYTE-IDENTITY with every hook absent: a deterministic scenario matrix (publish / current / ineligible / every
// failure class / controls not opened / commit-unknown / deadline reserve / in-flight deadline confirmed+unconfirmed /
// safe-close failures / immediate scope / post-promotion hook / every fail-closed entry / build-time refusals) is run
// through the REAL core with injected fakes, and the canonical JSON of {summary, logs, every injected call + args} must
// hash to the value recorded from the PRE-WP3 module (git HEAD). The scenario function sits between the GOLDEN markers
// so the same code can be re-run against the pristine module. F4 (the WP3 verifier follow-ups): a prepare succeeds only
// with ok + prepared + a zero/absent code; an openControls THROW in a later window keeps the earlier windows' results
// (remaining units DEFERRED 'controls-open-threw', summary returned, non-green); an empty unit expansion stays valid but
// is marked 'units-empty' on the record + the TARGETS v2 line; the core's owner grammar IS the TARGETS v2 owner grammar.
// Offline; zero network; zero DataDoe. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { buildSavedDataReconciler, RECONCILE_STATUS, normalizeRouteUnits, DEFAULT_CHUNK_MAX_TARGETS, DEFAULT_CHUNK_MAX_SECONDS, ROUTE_OWNER_ID_RE, UNITS_EMPTY_REASON, MAX_TARGET_ID_BYTES, targetIdByteLength } from "../lib/server/sync/saved-data-reconciler.js";
import {
  formatTargetsLine, parseTargetsLine, normalizeTargets, buildTargetsPayload, buildTargetsPayloadV2,
  TARGETS_MAX_LINE_BYTES, TARGETS_LINE_PREFIX, TARGETS_OWNER_ID_RE, TARGETS_UNITS_EMPTY,
} from "../lib/server/sync/reconcile-targets-output.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// GOLDEN-BEGIN
async function runGoldenScenarios(build) {
  const ASOF = "2026-09-24";
  const SRA = "2026-09-24T05:00:00.000Z";
  const RKS = ["rk-a", "rk-b"];
  const HASH = (v, p) => v + "|" + JSON.stringify(p);
  const CONTRACTS = {
    "rk-a": { liveReportKey: "live-a", liveReportVersion: "live-a/v1", liveParams: (p) => ({ to: p.to }) },
    "rk-b": { liveReportKey: "rk-b", liveReportVersion: "rk-b/v1", liveParams: (p) => ({ from: "2026-09-01", to: p.to }) },
  };
  const RD = {
    "rk-a": { snapshotVersion: "rk-a/shadow", validatePayload: (x) => !!(x && x.valid === true) },
    "rk-b": { snapshotVersion: "rk-b/shadow", validatePayload: (x) => !!(x && x.valid === true) },
  };
  const BOUND = { "rk-a": "bound", "rk-b": "bound" };
  const FIX = {
    A01: { elig: true, live: { "rk-a": null, "rk-b": "bound" } },
    A02: { elig: true, live: BOUND },
    A03: { elig: false, reason: "no-durable-source" },
    A04: { elig: true, live: { "rk-a": "older-sra", "rk-b": "bound" } },
    A05: { elig: true, live: { "rk-a": "bound", "rk-b": "payload-differs" } },
    A06: { elig: true, live: { "rk-a": "bound", "rk-b": "readback-bad" } },
    A07: { elig: true, job: "not-promotable", live: BOUND },
    A08: { elig: true, deps: ["dep-NEW"], live: BOUND },
    A09: { elig: true, storage: true, live: BOUND },
    A10: { elig: true, storageFail: true, live: BOUND },
    A11: { elig: null },
    A12: { elig: true, live: { "rk-a": "readback-throws", "rk-b": "bound" } },
    A13: { elig: true, job: "throws", live: BOUND },
  };
  const RELEASE = {
    A01: () => ({ ok: true, code: 0 }),
    A04: () => ({ ok: false, code: 1, stage: "publish", reason: "publish-refused: disposition=conflict (409) duplicate key", problems: ["p1"] }),
    A05: () => ({ ok: false, code: 1, stage: "publish", status: "CONTROL_LEASE_LOST", leaseLost: true, reason: "lease-lost" }),
    A06: () => { throw new Error("boom"); },
    A07: () => ({ ok: false, code: 1, stage: "derive", reason: "SOURCE_UNAVAILABLE" }),
    A08: () => ({ ok: false, code: 1, stage: "derive", reason: "derive-blocked", blockerCodes: ["derive:coverage-incomplete"] }),
    A10: () => ({ ok: false, code: 1, stage: "readback", reason: "live-readback: mismatch" }),
    A12: () => ({ ok: false, code: 1, stage: "derive", reason: "derive:count-mismatch", blockerCodes: ["derive:count-mismatch"] }),
    A13: () => ({ ok: false, code: 1, stage: "publish", status: "NEWER_LIVE", reason: "publish-newer-live" }),
  };
  const shParams = (rk, a) => ({ reportVersion: RD[rk].snapshotVersion, accountId: a, to: ASOF });
  const shHash = (rk, a) => HASH(RD[rk].snapshotVersion, shParams(rk, a));
  const rkOfLive = (k) => (k === "live-a" ? "rk-a" : "rk-b");
  function mk(opts = {}) {
    const calls = []; const logs = [];
    const rec = (name, args) => calls.push(args === undefined ? [name] : [name, args]);
    const accounts = opts.accounts || Object.keys(FIX);
    let releases = 0;
    const cfg = {
      resolveOrg: async () => { rec("resolveOrg"); return "org" in opts ? opts.org : { organizationFingerprint: "org-1", connectionId: "" }; },
      bucketAccounts: async (b) => { rec("bucketAccounts", b); return "dir" in opts ? opts.dir : accounts.map((a, i) => (i % 2 ? a : { accountId: a })); },
      adapter: opts.adapter || {
        readScopeEvidence: async (args) => {
          rec("readScopeEvidence", { organizationFingerprint: args.organizationFingerprint, connectionId: args.connectionId, scope: args.scope, requestedAsOf: args.requestedAsOf, withTimeout: typeof args.withTimeout });
          if (opts.evidence === "throws") throw new Error("ev-down");
          if (opts.evidence === "not-ok") return { ok: false, failCode: "DURABLE_X" };
          if (opts.evidence === "not-map") return { ok: true, perAccount: {} };
          const m = new Map(); for (const a of args.scope) if (FIX[a]) m.set(a, { ev: a }); return { ok: true, perAccount: m };
        },
        computeAccountRevision: (args) => {
          rec("computeAccountRevision", args);
          const f = FIX[args.accountId];
          if (!f || f.elig === null) return null;
          if (f.elig === false) return { eligible: false, reason: f.reason, status: "ineligible" };
          return { eligible: true, revisionId: "rev-" + args.accountId, deps: f.deps || ["dep-1"], status: "ok" };
        },
      },
      readLatestReportJob: async (args) => {
        rec("job", args);
        const f = FIX[args.accountId];
        if (f.job === "throws") throw new Error("job-down");
        if (f.job === "not-promotable") return { deriveStatus: "succeeded", saveStatus: "succeeded", validated: false, cycleStatus: "succeeded", snapshotParamsHash: "x", dependsOn: ["dep-1"] };
        return { deriveStatus: "succeeded", saveStatus: "succeeded", validated: true, cycleStatus: "succeeded", snapshotParamsHash: shHash(args.reportKey, args.accountId), dependsOn: ["dep-1"], durableContentDeps: [] };
      },
      readShadowSnapshot: async (args) => {
        rec("shadow", args);
        const rk = args.reportKey.replace("scheduler-v2/", "");
        const f = FIX[args.accountId];
        return { report_key: args.reportKey, account_id: args.accountId, params_hash: args.paramsHash, params: shParams(rk, args.accountId), payload: f.storage || f.storageFail ? null : { valid: true, n: 1 }, payload_storage_path: f.storage ? "store/" + args.accountId + "/" + rk : (f.storageFail ? "fail/" + args.accountId + "/" + rk : null), source_refreshed_at: SRA };
      },
      readLiveSnapshot: async (args) => {
        rec("live", args);
        const f = FIX[args.accountId];
        const mode = f.live && f.live[rkOfLive(args.reportKey)];
        if (!mode) return null;
        return { report_key: args.reportKey, account_id: args.accountId, params_hash: args.paramsHash, params: {}, payload: mode === "payload-differs" ? { valid: true, n: 2 } : (f.storage ? null : { valid: true, n: 1 }), payload_storage_path: f.storage ? "store/live/" + args.accountId : null, source_refreshed_at: mode === "older-sra" ? "2026-09-20T00:00:00.000Z" : SRA };
      },
      loadStoragePayload: async (path) => { rec("storage", path); if (String(path).startsWith("fail/")) throw new Error("gone"); return { valid: true, n: 1 }; },
      verifyLiveReadback: async (args) => {
        rec("readback", args);
        const f = FIX[args.accountId];
        const mode = f.live && f.live[args.reportKey];
        if (mode === "readback-bad") return { ok: false, reason: "params-provenance" };
        if (mode === "readback-throws") throw new Error("rb-down");
        return { ok: !!mode };
      },
      liveContracts: CONTRACTS, computeHash: HASH, reportDerivations: RD,
      runReleaseForAccount: opts.noRelease ? undefined : ((args) => {
        releases += 1;
        rec("release", { bucket: args.bucket, accountId: args.accountId, requestedAsOf: args.requestedAsOf, revisionId: args.revisionId, signal: args.signal ? "signal" : null });
        const fn = RELEASE[args.accountId];
        return fn ? fn(releases) : { ok: true, code: 0 };
      }),
      openControls: async (ids) => { rec("openControls", ids); return opts.open ? opts.open(ids) : { ok: true, reason: "opened" }; },
      closeControls: async (...a) => { rec("closeControls", a.length); if (opts.close) return opts.close(); return { ok: true }; },
      outOfTime: opts.outOfTime ? () => opts.outOfTime(releases) : undefined,
      deadlineRace: opts.deadlineRace ? (p, s) => opts.deadlineRace(p, s, releases) : undefined,
      makeAbortController: opts.abortable ? () => { const ac = { signal: { aborted: false }, abort: () => { ac.signal.aborted = true; rec("abort"); } }; return ac; } : undefined,
      awaitSettled: opts.awaitSettled || undefined,
      withTimeout: (p) => p,
      clock: () => new Date("2026-09-24T01:02:03.000Z"),
      log: (m) => logs.push(m),
      family: "golden",
      reportKeys: RKS,
      ...(opts.extra || {}),
    };
    for (const k of Object.keys(cfg)) if (cfg[k] === undefined) delete cfg[k];
    return { reconciler: build(cfg), calls, logs };
  }
  const records = [];
  const runS = async (name, opts, runArgs) => {
    const h = mk(opts);
    let summary;
    try { summary = runArgs === "none" ? await h.reconciler.run() : await h.reconciler.run(runArgs || { bucket: "india", requestedAsOf: ASOF, mode: "periodic" }); }
    catch (e) { summary = { threw: String(e && e.message) }; }
    records.push({ name, summary, logs: h.logs, calls: h.calls });
  };
  const buildS = (name, opts) => { try { mk(opts); records.push({ name, built: true }); } catch (e) { records.push({ name, error: String(e && e.message) }); } };
  await runS("S1-full", { extra: { postPromotionHook: async (a) => ({ rebuilt: true, readbackVerified: true, a }), membershipSourceReport: "rk-a", postPromotionSummaryKey: "brandView" } });
  await runS("S2-dry", {}, { bucket: "india", requestedAsOf: ASOF, mode: "periodic", dryRun: true });
  await runS("S3-not-opened", { open: () => ({ ok: false, reason: "CONTROL_LEASE_HELD" }) });
  await runS("S4-commit-unknown", { open: () => ({ ok: false, commitUnknown: true, reason: "apply-unknown" }) });
  await runS("S5-out-of-time", { outOfTime: (n) => n >= 2 });
  // (n = releases STARTED before this race; the settle fakes always observe the op so a rejection is never unhandled)
  const observe = async (p) => { try { await p; } catch { /* observed */ } };
  await runS("S6-deadline-confirmed", { abortable: true, deadlineRace: (p, s, n) => (n === 2 ? Promise.resolve({ __deadline: true }) : p), awaitSettled: async (p) => { await observe(p); return { settled: true }; } });
  await runS("S7-deadline-unconfirmed", { abortable: true, deadlineRace: (p, s, n) => (n === 3 ? Promise.resolve({ __deadline: true }) : p), awaitSettled: async (p) => { await observe(p); return { settled: false }; } });
  await runS("S7b-settle-throws", { abortable: true, deadlineRace: (p, s, n) => (n === 1 ? Promise.resolve({ __deadline: true }) : p), awaitSettled: async (p) => { await observe(p); throw new Error("x"); } });
  await runS("S8-close-failed", { close: () => ({ ok: false, reason: "not-closed" }) });
  await runS("S8b-close-unknown", { close: () => ({ ok: false, commitUnknown: true }) });
  await runS("S8c-close-throws", { close: () => { throw new Error("close-down"); } });
  await runS("S9-immediate", { extra: { postPromotionHook: async () => ({ rebuilt: false, mode: "self_heal_pending_x" }), membershipSourceReport: "rk-a" } }, { bucket: "us-ca", requestedAsOf: ASOF, accountIds: ["A02", "A01", "A01", "", null, "A04"], mode: "immediate" });
  await runS("S9b-hook-throws", { extra: { postPromotionHook: async () => { throw new Error("hook-down"); }, membershipSourceReport: "rk-a" } }, { bucket: "us-ca", requestedAsOf: ASOF, accountIds: ["A01"] });
  await runS("S9c-membership-no-hook", { extra: { membershipSourceReport: "rk-a", revisionChangedReason: "custom-rev-changed" } });
  await runS("S10a-no-bucket", {}, { bucket: "", requestedAsOf: ASOF });
  await runS("S10b-bad-asof", {}, { bucket: "india", requestedAsOf: "2026-9-1" });
  await runS("S10c-org-null", { org: null });
  await runS("S10d-org-no-fp", { org: { connectionId: "x" } });
  await runS("S10e-evidence-throws", { evidence: "throws" });
  await runS("S10f-evidence-not-ok", { evidence: "not-ok" });
  await runS("S10g-evidence-not-map", { evidence: "not-map" });
  await runS("S10h-empty-dir", { dir: null });
  await runS("S10i-no-args", {}, "none");
  buildS("C1-no-release", { noRelease: true });
  buildS("C2-adapter-incomplete", { adapter: { readScopeEvidence: async () => ({}) } });
  buildS("C3-hook-not-fn", { extra: { postPromotionHook: "x" } });
  buildS("C4-no-contracts", { extra: { liveContracts: null } });
  buildS("C5-ok", {});
  return records;
}
// GOLDEN-END

// sha256 of JSON.stringify(runGoldenScenarios(<module>)) recorded from the PRE-WP3 core (git HEAD
// lib/server/sync/saved-data-reconciler.js, with the working-tree publication-binding.js). Any change to a pre-hook read,
// call argument, log line, summary field, count, outcome or build-time refusal changes this hash.
const GOLDEN_SHA256 = "334e5e174fe7a4865ff4bda7e3ba808679cd6fc7a55611b144487e4fc57e651c";

test("G0 golden: with EVERY route hook absent the core is BYTE-IDENTICAL to the pre-WP3 module (summaries, logs, calls, refusals)", async () => {
  const records = await runGoldenScenarios(buildSavedDataReconciler);
  const json = JSON.stringify(records);
  const got = sha256(json);
  if (got !== GOLDEN_SHA256) writeSync(2, "G0 golden mismatch: " + got + "\n" + json + "\n");
  ok("G0: the golden scenario matrix hashes to the pre-WP3 value", got === GOLDEN_SHA256);
  const full = records.find((r) => r.name === "S1-full").summary;
  ok("G0: summary shape unchanged (no units / h / sra / served anywhere without hooks)", Object.keys(full).join(",") === "ok,outcome,code,bucket,requestedAsOf,mode,dryRun,startedAt,accountsExamined,dataDoeCreates,dataDoeTokens,brandView,controlCleanupUnresolved,controlReason,counts,perAccount"
    && full.perAccount.every((r) => Object.keys(r).join(",") === "accountId,eligible,revisionId,status,reports")
    && !/"units"|"h":|"sra":|"served"/.test(json));
  ok("G0: the matrix really exercises every class (published, current, deferred, failed, dry-run, fail-closed)", full.counts.targetsPublished > 0 && full.counts.targetsAlreadyCurrent > 0 && full.counts.targetsDeferred > 0 && full.counts.targetsFailed > 0 && records.length === 28);
});

// ---------------------------------------------------------------------------------------------------------------------
// ROUTE harness: an in-memory job/shadow/live store + the REAL core + the REAL binding. Contracts model the WP1 hooks:
//   sm   -- sku-movement-like: target 'sm:<acct>::<brand>', live row at the OWNER account, asOfField 'asOf'.
//   bb   -- brand-view-brands-like: asOfField null (no as-of identity).
//   acct -- a plain account contract ('to').
const ASOF = "2026-09-24";
const SRA = "2026-09-24T06:00:00.000Z";
const HASH = (v, p) => sha256(v + "|" + JSON.stringify(p)); // hex, like the real paramsHashFor
const CONTRACTS = {
  sm: { liveReportKey: "sm-live", liveReportVersion: "sm-live/v2", liveParams: (p) => (p.asOf && p.brand ? { asOf: p.asOf, brand: p.brand } : null), asOfField: "asOf", liveAccountId: (p) => p.ownerAccountId, gateAccountIds: (p) => [p.ownerAccountId] },
  bb: { liveReportKey: "bb-live", liveReportVersion: "bb/v1", liveParams: (p) => ({ accountId: p.accountId }), asOfField: null },
  acct: { liveReportKey: "acct-live", liveReportVersion: "acct/v1", liveParams: (p) => ({ to: p.to }) },
  fp: { liveReportKey: "fp-live", liveReportVersion: "fp/v1", liveParams: (p) => ({ to: p.to }) },
};
const RD = {
  sm: { snapshotVersion: "sm/route-1", validatePayload: (x) => !!(x && x.ok === true) },
  bb: { snapshotVersion: "bb/route-1", validatePayload: (x) => !!(x && x.ok === true) },
  acct: { snapshotVersion: "acct/route-1", validatePayload: (x) => !!(x && x.ok === true) },
  fp: { snapshotVersion: "fp/route-1", validatePayload: (x) => !!(x && x.ok === true) },
};

function makeStore() {
  const jobs = new Map(), shadows = new Map(), lives = new Map(), reads = [];
  const store = {
    jobs, shadows, lives, reads,
    seed({ rk, targetId, params, payload = { ok: true }, sra = SRA, deps = ["dep-1"] }) {
      const version = RD[rk].snapshotVersion;
      const sp = { reportVersion: version, accountId: targetId, ...params };
      const h = HASH(version, sp);
      jobs.set(rk + "|" + targetId, { deriveStatus: "succeeded", saveStatus: "succeeded", validated: true, cycleStatus: "partial", snapshotParamsHash: h, dependsOn: deps, durableContentDeps: [] });
      shadows.set("scheduler-v2/" + rk + "|" + targetId + "|" + h, { report_key: "scheduler-v2/" + rk, account_id: targetId, params_hash: h, params: sp, payload, payload_storage_path: null, source_refreshed_at: sra });
      return h;
    },
    // Promote the latest job's shadow to the live row at the CONTRACT identity (what the fenced publisher writes).
    promote({ rk, targetId }) {
      const job = jobs.get(rk + "|" + targetId);
      const sh = shadows.get("scheduler-v2/" + rk + "|" + targetId + "|" + job.snapshotParamsHash);
      const c = CONTRACTS[rk];
      const lp = c.liveParams(sh.params);
      const h = HASH(c.liveReportVersion, lp);
      const acct = typeof c.liveAccountId === "function" ? c.liveAccountId(sh.params, targetId) : targetId;
      lives.set(c.liveReportKey + "|" + acct + "|" + h, { report_key: c.liveReportKey, account_id: acct, params_hash: h, params: { reportVersion: c.liveReportVersion, ...lp }, payload: sh.payload, payload_storage_path: null, source_refreshed_at: sh.source_refreshed_at });
      return { acct, h };
    },
    readers: {
      readLatestReportJob: async ({ reportKey, accountId }) => { reads.push(["job", reportKey, accountId]); return jobs.get(reportKey + "|" + accountId) || null; },
      readShadowSnapshot: async ({ reportKey, accountId, paramsHash }) => { reads.push(["shadow", reportKey, accountId]); return shadows.get(reportKey + "|" + accountId + "|" + paramsHash) || null; },
      readLiveSnapshot: async ({ reportKey, accountId, paramsHash }) => { reads.push(["live", reportKey, accountId]); return lives.get(reportKey + "|" + accountId + "|" + paramsHash) || null; },
      loadStoragePayload: async () => null,
      verifyLiveReadback: async ({ liveReportKey, accountId, paramsHash }) => { reads.push(["readback", liveReportKey, accountId]); return lives.has(liveReportKey + "|" + accountId + "|" + paramsHash) ? { ok: true } : { ok: false, reason: "absent" }; },
    },
  };
  return store;
}

// A brand unit of account `acct` for the sm contract (its shadow params carry the owner + brand + as-of).
const smUnit = (acct, brand, extra = {}) => ({ unitKey: "u-" + brand.toLowerCase().replace(/[^a-z0-9]/g, ""), targetId: "sm:" + acct + "::" + brand, liveAccountId: acct, ownerAccountIds: [acct], targetAsOf: ASOF, reportKeys: ["sm"], ...extra });
const seedSm = (store, acct, brand, asOf = ASOF) => store.seed({ rk: "sm", targetId: "sm:" + acct + "::" + brand, params: { ownerAccountId: acct, brand, asOf } });

function makeRoute(o = {}) {
  const store = o.store || makeStore();
  const events = [];
  let windowOpen = false;
  const adapter = {
    readScopeEvidence: async ({ scope }) => ({ ok: true, perAccount: new Map(scope.map((a) => [a, { a }])) }),
    computeAccountRevision: ({ accountId }) => (o.revisionFor ? o.revisionFor(accountId) : { eligible: true, revisionId: "rev-" + accountId, evidenceToken: "tok1:" + accountId, deps: ["dep-1"], status: "ok" }),
  };
  for (const k of ["expandUnits", "currentPredicate", "servedCheck"]) if (o[k] !== undefined) adapter[k] = o[k];
  const cfg = {
    resolveOrg: async () => ({ organizationFingerprint: "org-1", connectionId: "primary" }),
    bucketAccounts: async () => (o.accounts || ["ACC1"]).map((a) => ({ accountId: a })),
    adapter,
    ...store.readers,
    liveContracts: CONTRACTS, computeHash: HASH, reportDerivations: RD,
    reportKeys: o.reportKeys || ["sm"],
    openControls: async (arg) => { events.push(["open", arg]); const r = o.openControls ? await o.openControls(arg) : { ok: true }; if (r && r.ok === true) windowOpen = true; return r; },
    closeControls: async (arg) => { events.push(["close", arg]); windowOpen = false; return o.closeControls ? o.closeControls(arg) : { ok: true }; },
    log: (m) => events.push(["log", m]),
    family: "route-test",
  };
  for (const k of ["outOfTime", "deadlineRace", "awaitSettled", "makeAbortController", "clock", "chunkMaxTargets", "chunkMaxSeconds", "membershipSourceReport", "postPromotionHook"]) if (o[k] !== undefined) cfg[k] = o[k];
  if (o.single) {
    cfg.runReleaseForAccount = async (args) => { events.push(["release", args.accountId, windowOpen]); for (const rk of cfg.reportKeys) if (store.jobs.has(rk + "|" + args.accountId)) store.promote({ rk, targetId: args.accountId }); return { ok: true, code: 0 }; };
  } else {
    cfg.runPrepareForUnit = async (args) => { events.push(["prepare", args.unit.unitKey, windowOpen, args.accountId]); return o.prepare ? o.prepare(args) : { ok: true, code: 0, prepared: true }; };
    cfg.runPublishForUnit = async (args) => {
      events.push(["publish", args.unit.unitKey, windowOpen, args.accountId]);
      if (o.publish) return o.publish(args, store);
      for (const rk of args.reportKeys) store.promote({ rk, targetId: args.unit.targetId });
      return { ok: true, code: 0 };
    };
  }
  return { reconciler: buildSavedDataReconciler(cfg), store, events };
}
const unitsOf = (out, acct) => out.perAccount.find((r) => r.accountId === acct).units;
const unitEntry = (out, acct, unitKey, rk) => unitsOf(out, acct).find((u) => u.unitKey === unitKey).reports[rk];
const run = (r, extra = {}) => r.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic", ...extra });

test("U1 units: one brand unit's prepare (derive) fails while the other brands publish -- per-unit isolation; reads keyed by targetId / liveAccountId", async () => {
  const store = makeStore();
  for (const b of ["Brand A", "Brand B", "Brand C"]) seedSm(store, "ACC1", b);
  const r = makeRoute({
    store,
    expandUnits: ({ accountId }) => ["Brand A", "Brand B", "Brand C"].map((b) => smUnit(accountId, b)),
    prepare: (args) => (args.unit.unitKey === "u-brandb" ? { ok: false, code: 1, stage: "derive", reason: "payload-invalid" } : { ok: true, code: 0, prepared: true }),
  });
  const out = await run(r);
  ok("U1: Brand A + Brand C READBACK_VERIFIED; Brand B FAILED_DERIVE (LKG preserved)", unitEntry(out, "ACC1", "u-branda", "sm").state === RECONCILE_STATUS.READBACK_VERIFIED && unitEntry(out, "ACC1", "u-brandc", "sm").state === RECONCILE_STATUS.READBACK_VERIFIED && unitEntry(out, "ACC1", "u-brandb", "sm").state === RECONCILE_STATUS.FAILED_DERIVE && unitEntry(out, "ACC1", "u-brandb", "sm").lkgPreserved === true);
  ok("U1: B was never published; A and C were (inside a control window)", r.events.filter((e) => e[0] === "publish").map((e) => e[1]).join(",") === "u-branda,u-brandc" && r.events.filter((e) => e[0] === "publish").every((e) => e[2] === true));
  ok("U1: counts are per (unit, report) with unchanged semantics (3 examined, 2 published, 1 failed -> outcome failed)", out.counts.targetsExamined === 3 && out.counts.targetsPublished === 2 && out.counts.targetsFailed === 1 && out.outcome === "failed" && out.ok === false);
  ok("U1: the job + shadow are read at the unit targetId; the live row + readback at the unit liveAccountId (the owner)", store.reads.some((x) => x[0] === "job" && x[2] === "sm:ACC1::Brand A") && store.reads.some((x) => x[0] === "shadow" && x[2] === "sm:ACC1::Brand A") && store.reads.filter((x) => x[0] === "live" || x[0] === "readback").every((x) => x[2] === "ACC1"));
  ok("U1: the record carries units[] + owners + the evaluated evidence token; reports is {} for a multi-unit target", unitsOf(out, "ACC1").length === 3 && out.perAccount[0].ownerAccountIds.join(",") === "ACC1" && out.perAccount[0].evidenceToken === "tok1:ACC1" && Object.keys(out.perAccount[0].reports).length === 0);
  const verify = await run(r, { dryRun: true });
  ok("U1: a separate verify pass proves A + C PUBLICATION_NOT_REQUIRED (with the canonical h/sra) and B still STALE", unitEntry(verify, "ACC1", "u-branda", "sm").state === "PUBLICATION_NOT_REQUIRED" && unitEntry(verify, "ACC1", "u-branda", "sm").h === HASH("sm-live/v2", { asOf: ASOF, brand: "Brand A" }) && unitEntry(verify, "ACC1", "u-branda", "sm").sra === SRA && unitEntry(verify, "ACC1", "u-brandb", "sm").state === "STALE" && unitEntry(verify, "ACC1", "u-brandb", "sm").h === null);
});

test("U2 units: a DEFERRED prepare for one brand leaves the others published and the run honest (partial, ok:true)", async () => {
  const store = makeStore();
  for (const b of ["Brand A", "Brand B"]) seedSm(store, "ACC1", b);
  const r = makeRoute({ store, expandUnits: ({ accountId }) => ["Brand A", "Brand B"].map((b) => smUnit(accountId, b)), prepare: (args) => (args.unit.unitKey === "u-branda" ? { ok: false, code: 1, stage: "reconcile", reason: "revision-advanced-at-entry" } : { ok: true, code: 0, prepared: true }) });
  const out = await run(r);
  ok("U2: A DEFERRED_DEPENDENCY (typed reason kept), B published, outcome partial, ok:true", unitEntry(out, "ACC1", "u-branda", "sm").state === RECONCILE_STATUS.DEFERRED_DEPENDENCY && unitEntry(out, "ACC1", "u-branda", "sm").reason === "revision-advanced-at-entry" && unitEntry(out, "ACC1", "u-brandb", "sm").state === RECONCILE_STATUS.READBACK_VERIFIED && out.outcome === "partial" && out.ok === true);
});

test("A1 per-target as-of: the binding is evaluated at unit.targetAsOf on the contract's asOfField ('asOf' and null); the live account is re-derived", async () => {
  const store = makeStore();
  seedSm(store, "ACC1", "Old", "2026-09-20"); store.promote({ rk: "sm", targetId: "sm:ACC1::Old" });
  seedSm(store, "ACC1", "Lag", "2026-09-20"); store.promote({ rk: "sm", targetId: "sm:ACC1::Lag" });
  seedSm(store, "ACC1", "Nul");
  seedSm(store, "ACC1", "Moved"); store.promote({ rk: "sm", targetId: "sm:ACC1::Moved" });
  store.seed({ rk: "bb", targetId: "ACC1", params: {} }); store.promote({ rk: "bb", targetId: "ACC1" });
  const r = makeRoute({
    store, reportKeys: ["sm", "bb"],
    expandUnits: ({ accountId }) => [
      smUnit(accountId, "Old", { targetAsOf: "2026-09-20" }),   // target as-of != epoch, equal to the live asOf -> current
      smUnit(accountId, "Lag"),                                 // target as-of = epoch, live asOf older -> STALE
      smUnit(accountId, "Nul", { targetAsOf: null }),           // no as-of on a dated contract -> typed deferral
      smUnit(accountId, "Moved", { liveAccountId: "ACC9" }),    // caller re-points the live account -> STALE
      { unitKey: "-", targetId: accountId, targetAsOf: null, reportKeys: ["bb"] }, // asOfField null -> no as-of gate
    ],
  });
  const out = await run(r, { dryRun: true });
  ok("A1: asOfField 'asOf' + targetAsOf 2026-09-20 (epoch 2026-09-24) -> PUBLICATION_NOT_REQUIRED", unitEntry(out, "ACC1", "u-old", "sm").state === "PUBLICATION_NOT_REQUIRED");
  ok("A1: targetAsOf = epoch while the candidate asOf is older -> STALE candidate-asof-not-exact", unitEntry(out, "ACC1", "u-lag", "sm").state === "STALE" && unitEntry(out, "ACC1", "u-lag", "sm").reason === "candidate-asof-not-exact");
  ok("A1: targetAsOf null on an 'asOf' contract -> DEFERRED_PROVENANCE target-asof-unresolved with ZERO reads for it", unitEntry(out, "ACC1", "u-nul", "sm").state === RECONCILE_STATUS.DEFERRED_PROVENANCE && unitEntry(out, "ACC1", "u-nul", "sm").reason === "target-asof-unresolved" && !store.reads.some((x) => x[2] === "sm:ACC1::Nul"));
  ok("A1: asOfField null + targetAsOf null -> PUBLICATION_NOT_REQUIRED (only the as-of gate is skipped)", unitEntry(out, "ACC1", "-", "bb").state === "PUBLICATION_NOT_REQUIRED");
  ok("A1: a unit liveAccountId that disagrees with the contract-derived owner -> STALE live-account-mismatch (never re-pointed)", unitEntry(out, "ACC1", "u-moved", "sm").state === "STALE" && unitEntry(out, "ACC1", "u-moved", "sm").reason === "live-account-mismatch");
  ok("A1: the TARGETS asOf per unit is its targetAsOf (null for the undated unit)", (() => { const t = parseTargetsLine(formatTargetsLine({ family: "x", summary: out, v: 2 })); const us = t.targets[0].units; return us.find((x) => x.u === "u-old").asOf === "2026-09-20" && us.find((x) => x.u === "-").asOf === null; })());
});

test("P1 two-phase: a prepare error NEVER calls openControls; no publish runs", async () => {
  const store = makeStore();
  seedSm(store, "ACC1", "Brand A"); seedSm(store, "ACC1", "Brand B");
  const r = makeRoute({ store, expandUnits: ({ accountId }) => ["Brand A", "Brand B"].map((b) => smUnit(accountId, b)), prepare: () => { throw new Error("prepare exploded password=x"); } });
  const out = await run(r);
  ok("P1: zero openControls / closeControls / publish; every unit FAILED_DERIVE prepare-threw", !r.events.some((e) => e[0] === "open" || e[0] === "close" || e[0] === "publish") && unitsOf(out, "ACC1").every((u) => u.reports.sm.state === RECONCILE_STATUS.FAILED_DERIVE && u.reports.sm.reason === "prepare-threw"));
  ok("P1: every prepare ran with NO control window open", r.events.filter((e) => e[0] === "prepare").every((e) => e[2] === false));
  const r2 = makeRoute({ store, expandUnits: ({ accountId }) => [smUnit(accountId, "Brand A")], prepare: () => ({ ok: true, code: 0 }) });
  const out2 = await run(r2);
  ok("P1: an ok prepare WITHOUT prepared:true is refused (FAILED_DERIVE prepare-unconfirmed), never published, no controls", unitEntry(out2, "ACC1", "u-branda", "sm").state === RECONCILE_STATUS.FAILED_DERIVE && unitEntry(out2, "ACC1", "u-branda", "sm").reason === "prepare-unconfirmed" && !r2.events.some((e) => e[0] === "open" || e[0] === "publish"));
  const diag = r.events.filter((e) => e[0] === "log" && e[1].startsWith("SAVED_DATA_RECONCILE_DIAG ")).map((e) => JSON.parse(e[1].slice("SAVED_DATA_RECONCILE_DIAG ".length)));
  ok("P1: the DIAG line is sanitized (safe unit key + phase, never the targetId brand text or the error message)", diag.length === 2 && diag.every((d) => Object.keys(d).join(",") === "family,region,accountId,unit,phase,requestedAsOf,stage,reasonCode,errClass" && d.phase === "prepare") && !JSON.stringify(diag).includes("Brand") && !JSON.stringify(diag).includes("password"));
});

test("P2 two-phase: chunking by count closes and re-opens controls; each window's owners/publisherKeys are its units' union", async () => {
  const store = makeStore();
  const brands = Array.from({ length: 45 }, (_, i) => "B" + String(i).padStart(2, "0"));
  for (const b of brands) store.seed({ rk: "sm", targetId: "sm:ACC1::" + b, params: { ownerAccountId: "ACC1", brand: b, asOf: ASOF } });
  const r = makeRoute({ store, expandUnits: () => brands.map((b, i) => ({ unitKey: "u" + i, targetId: "sm:ACC1::" + b, liveAccountId: "ACC1", ownerAccountIds: ["ACC1", "OWN" + (i % 3)] })) });
  const out = await run(r);
  const oc = r.events.filter((e) => e[0] === "open" || e[0] === "close");
  ok("P2: 45 units / chunkMaxTargets 20 -> 3 windows, strictly alternating open/close", oc.length === 6 && oc.every((e, i) => e[0] === (i % 2 ? "close" : "open")) && DEFAULT_CHUNK_MAX_TARGETS === 20 && DEFAULT_CHUNK_MAX_SECONDS === 90);
  ok("P2: openControls receives { owners: sorted union, publisherKeys }", oc[0][1].owners.join(",") === "ACC1,OWN0,OWN1,OWN2" && oc[0][1].publisherKeys.join(",") === "sm");
  ok("P2: every publish ran INSIDE a window, every prepare OUTSIDE; all 45 verified", r.events.filter((e) => e[0] === "publish").length === 45 && r.events.filter((e) => e[0] === "publish").every((e) => e[2] === true) && r.events.filter((e) => e[0] === "prepare").every((e) => e[2] === false) && out.counts.targetsPublished === 45 && out.outcome === "complete");
  ok("P2: ALL prepares complete before the FIRST window opens (phase 1 then phase 2)", r.events.findIndex((e) => e[0] === "open") > r.events.map((e) => e[0]).lastIndexOf("prepare"));
});

test("P3 two-phase: chunking by time (chunkMaxSeconds) closes a spent window and re-opens for the rest", async () => {
  const store = makeStore();
  const brands = ["b1", "b2", "b3", "b4", "b5", "b6", "b7"];
  for (const b of brands) seedSm(store, "ACC1", b);
  let t = 0;
  const r = makeRoute({
    store, chunkMaxSeconds: 90, clock: () => new Date(Date.UTC(2026, 8, 24) + t * 1000),
    expandUnits: ({ accountId }) => brands.map((b) => smUnit(accountId, b)),
    publish: (args, st) => { t += 40; st.promote({ rk: "sm", targetId: args.unit.targetId }); return { ok: true, code: 0 }; },
  });
  const out = await run(r);
  const seq = r.events.filter((e) => ["open", "close", "publish"].includes(e[0])).map((e) => (e[0] === "publish" ? "p" : e[0][0])).join("");
  ok("P3: publishes of 40 s each -> windows of 3,3,1 (no publish STARTS once a window is >= 90 s old)", seq === "opppcopppcopc" && out.counts.targetsPublished === 7);
});

test("P4 two-phase: the deadline reserve still safe-closes (phase 2), and phase 1 never opens controls", async () => {
  const store = makeStore();
  const brands = ["b1", "b2", "b3", "b4"];
  for (const b of brands) seedSm(store, "ACC1", b);
  let publishes = 0;
  const r = makeRoute({ store, expandUnits: ({ accountId }) => brands.map((b) => smUnit(accountId, b)), outOfTime: () => publishes >= 2, publish: (args, st) => { publishes += 1; st.promote({ rk: "sm", targetId: args.unit.targetId }); return { ok: true, code: 0 }; } });
  const out = await run(r);
  ok("P4: 2 published, the rest deadline-cleanup-reserved, the window was CLOSED (open == close == 1), run partial + clean", out.counts.targetsPublished === 2 && unitsOf(out, "ACC1").filter((u) => u.reports.sm.reason === "deadline-cleanup-reserved").length === 2 && r.events.filter((e) => e[0] === "open").length === 1 && r.events.filter((e) => e[0] === "close").length === 1 && out.outcome === "partial" && out.controlCleanupUnresolved === false);
  let prepares = 0;
  const r2 = makeRoute({ store: makeStore(), expandUnits: ({ accountId }) => brands.map((b) => smUnit(accountId, b)), outOfTime: () => prepares >= 1, prepare: () => { prepares += 1; return { ok: true, code: 0, prepared: true }; } });
  for (const b of brands) seedSm(r2.store, "ACC1", b);
  const out2 = await run(r2);
  ok("P4: out of time during phase 1 -> the prepared unit is NOT published, ZERO controls opened, everything deferred", r2.events.filter((e) => e[0] === "open").length === 0 && out2.counts.targetsDeferred === 4 && out2.counts.targetsPublished === 0 && out2.controlCleanupUnresolved === false);
});

test("P5 two-phase: an in-flight publish deadline -- confirmed stop closes the window; unconfirmed leaves it intact (non-green)", async () => {
  const mkDeadline = (settled) => {
    const store = makeStore();
    for (const b of ["b1", "b2", "b3"]) seedSm(store, "ACC1", b);
    let publishes = 0;
    return makeRoute({
      store, expandUnits: ({ accountId }) => ["b1", "b2", "b3"].map((b) => smUnit(accountId, b)),
      publish: (args, st) => { publishes += 1; st.promote({ rk: "sm", targetId: args.unit.targetId }); return { ok: true, code: 0 }; },
      deadlineRace: (p) => p.then((v) => (publishes === 2 && v && v.ok === true ? { __deadline: true } : v)),
      awaitSettled: async () => ({ settled }),
    });
  };
  const rc = mkDeadline(true);
  const outC = await run(rc);
  ok("P5: confirmed -> deadline-in-flight (terminationConfirmed), rest reserved, window CLOSED, run clean (partial)", unitEntry(outC, "ACC1", "u-b2", "sm").reason === "deadline-in-flight" && unitEntry(outC, "ACC1", "u-b2", "sm").terminationConfirmed === true && unitEntry(outC, "ACC1", "u-b3", "sm").reason === "deadline-cleanup-reserved" && rc.events.filter((e) => e[0] === "close").length === 1 && outC.controlCleanupUnresolved === false && outC.outcome === "partial");
  const ru = mkDeadline(false);
  const outU = await run(ru);
  ok("P5: unconfirmed -> the window is NOT closed (lease left for cleanup), CONTROL_CLEANUP_UNRESOLVED, ok:false", ru.events.filter((e) => e[0] === "close").length === 0 && outU.controlCleanupUnresolved === true && outU.code === "CONTROL_CLEANUP_UNRESOLVED" && outU.ok === false && outU.controlReason === "termination-unconfirmed-lease-held-for-cleanup");
});

test("P6 two-phase: controls not opened / commit-unknown / close failure -- zero further publishes, typed states", async () => {
  const setup = (o) => { const store = makeStore(); for (const b of ["b1", "b2", "b3"]) seedSm(store, "ACC1", b); return makeRoute({ store, expandUnits: ({ accountId }) => ["b1", "b2", "b3"].map((b) => smUnit(accountId, b)), ...o }); };
  const rn = setup({ openControls: () => ({ ok: false, reason: "CONTROL_LEASE_HELD" }) });
  const outN = await run(rn);
  ok("P6: controls not opened -> every prepared unit DEFERRED controls-not-opened:CONTROL_LEASE_HELD, zero publish, ok:true", unitsOf(outN, "ACC1").every((u) => u.reports.sm.reason === "controls-not-opened:CONTROL_LEASE_HELD" && u.reports.sm.state === RECONCILE_STATUS.DEFERRED_DEPENDENCY) && !rn.events.some((e) => e[0] === "publish" || e[0] === "close") && outN.ok === true);
  const rk = setup({ openControls: () => ({ ok: false, commitUnknown: true, reason: "x" }) });
  const outK = await run(rk);
  ok("P6: commit-unknown -> FAILED_PUBLISH reconcileRequired, zero publish, CONTROL_CLEANUP_UNRESOLVED", unitsOf(outK, "ACC1").every((u) => u.reports.sm.state === RECONCILE_STATUS.FAILED_PUBLISH && u.reports.sm.reconcileRequired === true) && !rk.events.some((e) => e[0] === "publish") && outK.code === "CONTROL_CLEANUP_UNRESOLVED");
  const rc = setup({ chunkMaxTargets: 1, closeControls: () => ({ ok: false, reason: "not-closed" }) });
  const outX = await run(rc);
  ok("P6: a window that fails to close is NEVER followed by another open; the rest defers controls-close-unresolved", rc.events.filter((e) => e[0] === "open").length === 1 && unitEntry(outX, "ACC1", "u-b1", "sm").state === RECONCILE_STATUS.READBACK_VERIFIED && unitEntry(outX, "ACC1", "u-b2", "sm").reason === "controls-close-unresolved" && outX.controlCleanupUnresolved === true && outX.ok === false);
});

test("P7 two-phase without expandUnits: the default unit '-' (owners [account]); membership promotion + result mapping reuse statusFromRelease", async () => {
  const store = makeStore();
  store.seed({ rk: "acct", targetId: "ACC1", params: { to: ASOF } });
  store.seed({ rk: "acct", targetId: "ACC2", params: { to: ASOF } });
  let hookArgs = null;
  const r = makeRoute({
    store, accounts: ["ACC1", "ACC2"], reportKeys: ["acct"], membershipSourceReport: "acct",
    postPromotionHook: async (a) => { hookArgs = a; return { rebuilt: true, readbackVerified: true }; },
    publish: (args, st) => (args.accountId === "ACC2" ? { ok: false, code: 1, stage: "publish", status: "NEWER_LIVE", reason: "publish-newer-live" } : (st.promote({ rk: "acct", targetId: args.unit.targetId }), { ok: true, code: 0 })),
  });
  const out = await run(r);
  ok("P7: ACC1 published (unit '-'), ACC2 NEWER_LIVE -> DEFERRED_DEPENDENCY; rec.reports aliases the default unit", out.perAccount[0].reports.acct.state === RECONCILE_STATUS.READBACK_VERIFIED && out.perAccount[0].units[0].reports === out.perAccount[0].reports && out.perAccount[1].reports.acct.state === RECONCILE_STATUS.DEFERRED_DEPENDENCY && out.counts.targetsExamined === 2);
  ok("P7: the window owners are the accounts themselves", r.events.find((e) => e[0] === "open")[1].owners.join(",") === "ACC1,ACC2");
  ok("P7: the post-promotion hook sees ONLY the published membership-source account", hookArgs && hookArgs.accountIds.join(",") === "ACC1" && out.postPromotion.status === "rebuilt-verified");
  const bad = makeRoute({ store: makeStore(), accounts: ["region:india"], reportKeys: ["acct"] });
  const outB = await run(bad);
  ok("P7: a ':' scope id can never own controls -> DEFERRED_PROVENANCE units-invalid:unit-owners-invalid, zero reads of it", outB.perAccount[0].reports.acct.state === RECONCILE_STATUS.DEFERRED_PROVENANCE && outB.perAccount[0].reports.acct.reason === "units-invalid:unit-owners-invalid" && !bad.events.some((e) => e[0] === "open" || e[0] === "prepare") && bad.store.reads.length === 0);
});

test("S1 servedCheck: current + served ok stays current; fixable -> STALE served-row-differs (re-published); not fixable -> preempted", async () => {
  const store = makeStore();
  for (const b of ["Ok", "Fix", "Pre", "Thr"]) { seedSm(store, "ACC1", b); store.promote({ rk: "sm", targetId: "sm:ACC1::" + b }); }
  seedSm(store, "ACC1", "Stale");
  const checked = [];
  const r = makeRoute({
    store, expandUnits: ({ accountId }) => ["Ok", "Fix", "Pre", "Thr", "Stale"].map((b) => smUnit(accountId, b)),
    servedCheck: ({ unit, rk, h, sra }) => {
      checked.push(unit.unitKey);
      if (unit.unitKey === "u-ok") return { ok: true, served: { id: "101", h, sra } };
      if (unit.unitKey === "u-fix") return { ok: false, fixable: true, reason: "older-version-row", served: { id: "102", h: "other-h", sra } };
      if (unit.unitKey === "u-pre") return { ok: false, fixable: false, reason: "exact-today-row (refresh=1)", served: { id: "103", h: "foreign", sra: "2026-09-25T00:00:00.000Z" } };
      throw new Error("selector down");
    },
  });
  const out = await run(r, { dryRun: true });
  ok("S1: served ok -> PUBLICATION_NOT_REQUIRED with the served row recorded", unitEntry(out, "ACC1", "u-ok", "sm").state === "PUBLICATION_NOT_REQUIRED" && unitEntry(out, "ACC1", "u-ok", "sm").served.id === "101");
  ok("S1: fixable -> STALE served-row-differs", unitEntry(out, "ACC1", "u-fix", "sm").state === "STALE" && unitEntry(out, "ACC1", "u-fix", "sm").reason === "served-row-differs" && unitEntry(out, "ACC1", "u-fix", "sm").h === null);
  ok("S1: not fixable -> DEFERRED_DEPENDENCY served-row-preempted:<code> (reason reduced to its code)", unitEntry(out, "ACC1", "u-pre", "sm").state === RECONCILE_STATUS.DEFERRED_DEPENDENCY && unitEntry(out, "ACC1", "u-pre", "sm").reason === "served-row-preempted:exact-today-row");
  ok("S1: a throwing served check DEFERS (served-check-threw), never current", unitEntry(out, "ACC1", "u-thr", "sm").state === RECONCILE_STATUS.DEFERRED_DEPENDENCY && unitEntry(out, "ACC1", "u-thr", "sm").reason === "served-check-threw");
  ok("S1: the served check is consulted ONLY for a current verdict (never for the STALE unit)", !checked.includes("u-stale") && checked.length === 4);
  const live = await run(r);
  ok("S1: the fixable unit is prepared + published (with the STALE one); the preempted one is not", r.events.filter((e) => e[0] === "publish").map((e) => e[1]).sort().join(",") === "u-fix,u-stale" && unitEntry(live, "ACC1", "u-fix", "sm").state === RECONCILE_STATUS.READBACK_VERIFIED);
});

test("S2 servedCheck in single-phase (no units): the original runReleaseForAccount path still executes; rec.units[0] aliases rec.reports", async () => {
  const store = makeStore();
  store.seed({ rk: "acct", targetId: "ACC1", params: { to: ASOF } }); store.promote({ rk: "acct", targetId: "ACC1" });
  const r = makeRoute({ store, single: true, reportKeys: ["acct"], servedCheck: () => ({ ok: false, fixable: true, reason: "x" }) });
  const out = await run(r);
  ok("S2: STALE served-row-differs -> openControls(staleAccounts) (unchanged single-phase signature) -> release -> verified", r.events.find((e) => e[0] === "open")[1].join(",") === "ACC1" && out.perAccount[0].reports.acct.state === RECONCILE_STATUS.READBACK_VERIFIED && out.perAccount[0].units[0].reports === out.perAccount[0].reports && out.counts.targetsExamined === 1);
});

test("C1 currentPredicate: replaces the binding ONLY for its own route; null falls back to the binding; throw/invalid defers", async () => {
  const store = makeStore();
  store.seed({ rk: "fp", targetId: "ACC1", params: { to: ASOF } }); // shadow exists but was never promoted -> binding STALE
  store.seed({ rk: "acct", targetId: "ACC1", params: { to: ASOF } }); store.promote({ rk: "acct", targetId: "ACC1" });
  const seen = [];
  const predicate = async (rk, unit, ctx) => {
    seen.push(rk);
    if (rk !== "fp") return null; // scope itself to fp: the exact binding decides for every other report
    const b = ctx.binding();
    return { state: "PUBLICATION_NOT_REQUIRED", reason: "content-equivalent:" + b.reason, h: "served-h", sra: "2026-09-24T01:00:00.000Z" };
  };
  const withP = makeRoute({ store, reportKeys: ["fp", "acct"], currentPredicate: predicate });
  const outP = await run(withP, { dryRun: true });
  const withoutP = makeRoute({ store, reportKeys: ["fp", "acct"] });
  const outN = await run(withoutP, { dryRun: true });
  ok("C1: with the predicate, fp is current (ITS identity h/sra) while the binding alone would say STALE live-unpromoted", unitEntry(outP, "ACC1", "-", "fp").state === "PUBLICATION_NOT_REQUIRED" && unitEntry(outP, "ACC1", "-", "fp").h === "served-h" && unitEntry(outP, "ACC1", "-", "fp").reason === "content-equivalent:live-unpromoted");
  ok("C1: the predicate returned null for acct -> the exact binding decided it (current with the canonical h)", unitEntry(outP, "ACC1", "-", "acct").state === "PUBLICATION_NOT_REQUIRED" && unitEntry(outP, "ACC1", "-", "acct").h === HASH("acct/v1", { to: ASOF }) && seen.join(",") === "fp,acct");
  ok("C1: a reconciler WITHOUT the predicate (another route) is untouched: fp STALE by the binding", unitEntry(outN, "ACC1", "-", "fp").state === "STALE" && unitEntry(outN, "ACC1", "-", "fp").reason === "live-unpromoted");
  const thr = await run(makeRoute({ store, reportKeys: ["fp"], currentPredicate: () => { throw new Error("x"); } }), { dryRun: true });
  const inv = await run(makeRoute({ store, reportKeys: ["fp"], currentPredicate: () => ({ state: "READBACK_VERIFIED" }) }), { dryRun: true });
  ok("C1: a throwing predicate DEFERS current-predicate-threw; a foreign state DEFERS current-predicate-invalid (never a publish)", unitEntry(thr, "ACC1", "-", "fp").state === RECONCILE_STATUS.DEFERRED_DEPENDENCY && unitEntry(thr, "ACC1", "-", "fp").reason === "current-predicate-threw" && unitEntry(inv, "ACC1", "-", "fp").reason === "current-predicate-invalid");
});

test("E1 expandUnits fail-closed: malformed / duplicate / owner-with-colon / unknown report / throw / declared deferral / empty", async () => {
  const store = makeStore();
  seedSm(store, "ACC1", "A");
  const out = async (expandUnits) => run(makeRoute({ store, expandUnits }), { dryRun: true });
  const dup = await out(({ accountId }) => [smUnit(accountId, "A"), smUnit(accountId, "A")]);
  ok("E1: duplicate unit -> the WHOLE target DEFERRED_PROVENANCE units-invalid:unit-duplicate (never a partial set)", dup.perAccount[0].units.length === 1 && dup.perAccount[0].units[0].unitKey === "-" && dup.perAccount[0].reports.sm.state === RECONCILE_STATUS.DEFERRED_PROVENANCE && dup.perAccount[0].reports.sm.reason === "units-invalid:unit-duplicate");
  const colon = await out(({ accountId }) => [smUnit(accountId, "A", { ownerAccountIds: ["dd:ACC1"] })]);
  ok("E1: a ':' owner -> units-invalid:unit-owners-invalid", colon.perAccount[0].reports.sm.reason === "units-invalid:unit-owners-invalid");
  const unk = await out(({ accountId }) => [smUnit(accountId, "A", { reportKeys: ["nope"] })]);
  ok("E1: an unknown report key -> units-invalid:unit-report-keys-invalid", unk.perAccount[0].reports.sm.reason === "units-invalid:unit-report-keys-invalid");
  const thr = await out(() => { throw new Error("brand list read failed"); });
  ok("E1: a throwing expansion -> DEFERRED_DEPENDENCY expand-units-threw (retryable, no message)", thr.perAccount[0].reports.sm.state === RECONCILE_STATUS.DEFERRED_DEPENDENCY && thr.perAccount[0].reports.sm.reason === "expand-units-threw");
  const before = store.reads.length;
  const dfr = await out(({ accountId }) => [smUnit(accountId, "A", { deferred: { state: "DEFERRED_PROVENANCE", reason: "brand-list-unavailable (row missing)" } })]);
  ok("E1: a declared unit deferral is typed, with ZERO reads", unitEntry(dfr, "ACC1", "u-a", "sm").state === RECONCILE_STATUS.DEFERRED_PROVENANCE && unitEntry(dfr, "ACC1", "u-a", "sm").reason === "brand-list-unavailable" && store.reads.length === before);
  const empty = await out(() => []);
  ok("E1: an empty expansion (no brands) -> zero units, zero counts, outcome complete", empty.perAccount[0].units.length === 0 && empty.counts.targetsExamined === 0 && empty.outcome === "complete");
  const inel = await run(makeRoute({ store, expandUnits: () => { throw new Error("never called"); }, revisionFor: () => ({ eligible: false, reason: "returns-evidence-missing" }) }), { dryRun: true });
  ok("E1: an ineligible revision never expands units -> the default unit, DEFERRED_PROVENANCE with the revision's reason", inel.perAccount[0].units.length === 1 && inel.perAccount[0].reports.sm.reason === "returns-evidence-missing");
  ok("E1: normalizeRouteUnits defaults + canonical owners", (() => { const n = normalizeRouteUnits([{ unitKey: "ALL", ownerAccountIds: ["B", "A", "B"] }], { accountId: "ACC1", requestedAsOf: ASOF, reportKeys: ["sm"] }); const u = n.units[0]; return n.ok && u.targetId === "ACC1" && u.liveAccountId === "ACC1" && u.ownerAccountIds.join(",") === "A,B" && u.targetAsOf === ASOF && u.reportKeys.join(",") === "sm"; })()
    && normalizeRouteUnits([{ unitKey: "a b" }], { accountId: "X", requestedAsOf: ASOF, reportKeys: ["sm"] }).reason === "unit-key-invalid"
    && normalizeRouteUnits([{ unitKey: "a", targetId: " X" }], { accountId: "X", requestedAsOf: ASOF, reportKeys: ["sm"] }).reason === "unit-target-invalid"
    && normalizeRouteUnits([{ unitKey: "a", targetAsOf: "2026-02-30" }], { accountId: "X", requestedAsOf: ASOF, reportKeys: ["sm"] }).reason === "unit-asof-invalid"
    && normalizeRouteUnits("x", { accountId: "X", requestedAsOf: ASOF, reportKeys: ["sm"] }).reason === "units-not-array");
});

test("B1 build-time fail-closed: the two-phase contract, the hook shapes and the chunk bounds", () => {
  const store = makeStore();
  const base = () => ({ resolveOrg: async () => ({}), bucketAccounts: async () => [], adapter: { readScopeEvidence: async () => ({}), computeAccountRevision: () => null }, ...store.readers, liveContracts: CONTRACTS, computeHash: HASH, reportDerivations: RD });
  const throws = (cfg, re) => { try { buildSavedDataReconciler(cfg); return false; } catch (e) { return re.test(String(e && e.message)); } };
  const fn = async () => ({});
  ok("B1: only one of the two unit runners -> refused", throws({ ...base(), runPrepareForUnit: fn }, /BOTH runPrepareForUnit \+ runPublishForUnit/));
  ok("B1: two-phase AND runReleaseForAccount -> refused (never an ambiguous release shape)", throws({ ...base(), runPrepareForUnit: fn, runPublishForUnit: fn, runReleaseForAccount: fn }, /EITHER runReleaseForAccount/));
  ok("B1: expandUnits without the two-phase runners -> refused", throws({ ...base(), runReleaseForAccount: fn, adapter: { ...base().adapter, expandUnits: fn } }, /expandUnits requires the two-phase/));
  ok("B1: a non-function hook -> refused", throws({ ...base(), runReleaseForAccount: fn, adapter: { ...base().adapter, servedCheck: 1 } }, /adapter\.servedCheck must be a function/));
  ok("B1: chunk bounds validated", throws({ ...base(), runPrepareForUnit: fn, runPublishForUnit: fn, chunkMaxTargets: 0 }, /chunkMaxTargets/) && throws({ ...base(), runPrepareForUnit: fn, runPublishForUnit: fn, chunkMaxSeconds: -1 }, /chunkMaxSeconds/));
  ok("B1: the two-phase shape without runReleaseForAccount builds", !throws({ ...base(), runPrepareForUnit: fn, runPublishForUnit: fn }, /./));
  ok("B1: the pre-hook shape still requires runReleaseForAccount (same message)", throws(base(), /^buildSavedDataReconciler requires runReleaseForAccount \(fail closed\)\.$/));
});

test("Z1 zero export: the core names no provider export/token transport; dataDoeCreates/Tokens stay 0 in two-phase", async () => {
  const { readFileSync } = await import("node:fs");
  const core = readFileSync(new URL("../lib/server/sync/saved-data-reconciler.js", import.meta.url), "utf8");
  const tgt = readFileSync(new URL("../lib/server/sync/reconcile-targets-output.js", import.meta.url), "utf8");
  ok("Z1: no createExport / exportsCreate / makeDataDoeAdapter / reserveTokens / /exports in the core or the TARGETS module", ["createExport", "exportsCreate", "makeDataDoeAdapter", "reserveTokens", "/exports"].every((s) => !core.includes(s) && !tgt.includes(s)));
  ok("Z1: the core imports ONLY the pure publication-binding leaf; the TARGETS module imports nothing", (core.match(/^import .*$/gm) || []).length === 1 && /from "\.\/publication-binding\.js";$/m.test(core) && !(/^import /m.test(tgt)));
  ok("Z1: both modules are 7-bit ASCII", /^[\x00-\x7f]*$/.test(core) && /^[\x00-\x7f]*$/.test(tgt));
  const store = makeStore(); seedSm(store, "ACC1", "A");
  const out = await run(makeRoute({ store, expandUnits: ({ accountId }) => [smUnit(accountId, "A")] }));
  ok("Z1: a two-phase publish reports dataDoeCreates 0 / dataDoeTokens 0", out.dataDoeCreates === 0 && out.dataDoeTokens === 0);
});

// ---------------------------------------------------------------------------------------------------------------------
test("T1 TARGETS v1: the default line is byte-identical to the pre-WP3 formatter (pinned literal) and still parses", () => {
  const summary = { bucket: "us-ca", requestedAsOf: "2026-09-23", dryRun: true, outcome: "partial", code: "OK", controlCleanupUnresolved: false, perAccount: [{ accountId: "A", eligible: true, revisionId: "r".repeat(70), status: "nonempty", reports: { "brand-inventory": { state: "STALE", reason: "live-refresh-differs: extra words", lkgPreserved: true } } }, { accountId: "B", eligible: false, revisionId: null, status: null, reports: {} }] };
  const line = formatTargetsLine({ family: "fba", summary });
  const expected = 'TARGETS {"v":1,"family":"fba","bucket":"us-ca","requestedAsOf":"2026-09-23","dryRun":true,"outcome":"partial","code":"OK","dataDoeCreates":0,"dataDoeTokens":0,"controlCleanupUnresolved":false,"accounts":[{"id":"A","eligible":true,"rev":"' + "r".repeat(64) + '","status":"nonempty","reports":{"brand-inventory":{"s":"STALE","r":"live-refresh-differs:"}}},{"id":"B","eligible":false,"rev":null,"status":null,"reports":{}}]}';
  ok("T1: v1 bytes pinned", line === expected && formatTargetsLine({ family: "fba", summary, v: 1 }) === expected);
  ok("T1: v1 parses as before; a v2-shaped line without targets never parses", parseTargetsLine(line).accounts.length === 2 && parseTargetsLine('TARGETS {"v":2,"accounts":[]}') === null && parseTargetsLine('TARGETS {"v":3,"targets":[]}') === null);
});

test("T2 TARGETS v2 round trip from a units summary: ids, owners, tok, unit rows; brand text never emitted; reasons sanitized", async () => {
  const store = makeStore();
  for (const b of ["Acme Co", "Zeta"]) seedSm(store, "ACC1", b);
  store.promote({ rk: "sm", targetId: "sm:ACC1::Zeta" });
  const r = makeRoute({ store, expandUnits: ({ accountId }) => [smUnit(accountId, "Acme Co"), smUnit(accountId, "Zeta")], prepare: () => ({ ok: false, code: 1, stage: "derive", reason: "release-threw: connect ECONNREFUSED 10.0.0.1 password=x" }) });
  const out = await run(r);
  const line = formatTargetsLine({ family: "sku-movement", summary: { ...out, bucket: "india", requestedAsOf: ASOF, dryRun: false }, v: 2 });
  const t = parseTargetsLine(line);
  ok("T2: v2 top level", t && t.v === 2 && t.route === "sku-movement" && t.bucket === "india" && t.epoch === ASOF && t.dryRun === false && t.dataDoeCreates === 0 && t.dataDoeTokens === 0 && t.controlCleanupUnresolved === false && Array.isArray(t.targets) && !("truncated" in t));
  const tg = t.targets[0];
  ok("T2: target { id, owners, tok } from the record", tg.id === "ACC1" && tg.owners.join(",") === "ACC1" && tg.tok === "tok1:ACC1" && Object.keys(tg).join(",") === "id,owners,tok,units");
  const acme = tg.units.find((u) => u.u === "u-acmeco"), zeta = tg.units.find((u) => u.u === "u-zeta");
  ok("T2: unit rows { u, rk, s, r, asOf, h, sra, served }", Object.keys(acme).join(",") === "u,rk,s,r,asOf,h,sra,served" && acme.rk === "sm" && acme.s === "FAILED_DERIVE" && acme.asOf === ASOF && acme.h === null && zeta.s === "PUBLICATION_NOT_REQUIRED" && zeta.h === HASH("sm-live/v2", { asOf: ASOF, brand: "Zeta" }) && zeta.sra === SRA && zeta.served === null);
  ok("T2: the reason is reduced to its machine code (no message / host / secret)", acme.r === "release-threw:" && !line.includes("ECONNREFUSED") && !line.includes("password"));
  ok("T2: the unit targetId (brand text) never appears in the line", !line.includes("Acme Co") && !line.includes("sm:ACC1::"));
  ok("T2: normalizeTargets(v2) is the identity", normalizeTargets(t) === t);
});

test("T3 TARGETS v2: current units carry h/sra; an invalid target id is omitted (counted); a pre-hook summary emits unit '-'", async () => {
  const store = makeStore();
  seedSm(store, "ACC1", "Zeta"); store.promote({ rk: "sm", targetId: "sm:ACC1::Zeta" });
  const out = await run(makeRoute({ store, expandUnits: ({ accountId }) => [smUnit(accountId, "Zeta")] }), { dryRun: true });
  const p = buildTargetsPayloadV2({ route: "sku-movement", summary: out });
  const z = p.targets[0].units[0];
  ok("T3: a PUBLICATION_NOT_REQUIRED unit carries the canonical h (params hash) + sra", z.s === "PUBLICATION_NOT_REQUIRED" && z.sra === SRA && z.h === HASH("sm-live/v2", { asOf: ASOF, brand: "Zeta" }));
  const pre = buildTargetsPayloadV2({ family: "oli", summary: { requestedAsOf: ASOF, perAccount: [{ accountId: "A 1", reports: {} }, { accountId: "B1", revisionId: "rv", reports: { "brand-sales": { state: "STALE", reason: "live-refresh-differs" } } }] } });
  ok("T3: 'A 1' omitted (omittedTargets 1); B1 becomes unit '-' at the run as-of, owners [B1], tok = revisionId", pre.omittedTargets === 1 && pre.targets.length === 1 && pre.targets[0].owners.join(",") === "B1" && pre.targets[0].tok === "rv" && pre.targets[0].units[0].u === "-" && pre.targets[0].units[0].asOf === ASOF && pre.route === "oli");
  const rg = buildTargetsPayloadV2({ route: "brand-view-portfolio", summary: { requestedAsOf: ASOF, perAccount: [{ accountId: "region:india", ownerAccountIds: ["ACC2", "ACC1", "region:india"], units: [{ unitKey: "u1", targetAsOf: ASOF, reports: { "brand-view-portfolio": { state: "STALE", reason: null } } }] }] } });
  ok("T3: a region target keeps its id; owners are only canonical rollout ids (sorted)", rg.targets[0].id === "region:india" && rg.targets[0].owners.join(",") === "ACC1,ACC2");
});

test("T4 TARGETS v2: the 256 KB line bound drops WHOLE targets from the end; the parser refuses an oversized v2 line", () => {
  const perAccount = Array.from({ length: 3000 }, (_, i) => ({ accountId: "ACC" + i, ownerAccountIds: ["ACC" + i], evidenceToken: "tok1:" + "f".repeat(64), units: Array.from({ length: 4 }, (_, j) => ({ unitKey: "u" + j, targetAsOf: ASOF, reports: { sm: { state: "PUBLICATION_NOT_REQUIRED", reason: null, h: "h".repeat(64), sra: SRA } } })) }));
  const line = formatTargetsLine({ family: "sku-movement", summary: { requestedAsOf: ASOF, perAccount }, v: 2 });
  const bytes = new TextEncoder().encode(line).length;
  const t = parseTargetsLine(line);
  ok("T4: the line fits within 256 KB and still parses", bytes <= TARGETS_MAX_LINE_BYTES && TARGETS_MAX_LINE_BYTES === 262144 && t !== null);
  ok("T4: truncated:true + omittedTargets = total - kept; the kept targets are a PREFIX with ALL their units", t.truncated === true && t.omittedTargets === 3000 - t.targets.length && t.targets.length > 0 && t.targets.every((x, i) => x.id === "ACC" + i && x.units.length === 4));
  ok("T4: the bound is tight (one more target would not fit)", bytes + new TextEncoder().encode(JSON.stringify(buildTargetsPayloadV2({ route: "x", summary: { requestedAsOf: ASOF, perAccount: perAccount.slice(t.targets.length, t.targets.length + 1) } }).targets[0])).length + 1 > TARGETS_MAX_LINE_BYTES);
  const big = TARGETS_LINE_PREFIX + JSON.stringify({ v: 2, targets: [{ id: "A", units: [{ u: "-", rk: "x", s: "STALE", pad: "p".repeat(TARGETS_MAX_LINE_BYTES) }] }] });
  ok("T4: parseTargetsLine refuses a v2 line over the bound, and a malformed v2 unit", parseTargetsLine(big) === null && parseTargetsLine('TARGETS {"v":2,"targets":[{"id":"A","units":[{"u":"-"}]}]}') === null && parseTargetsLine('TARGETS {"v":2,"targets":[{"units":[]}]}') === null);
  const small = buildTargetsPayloadV2({ route: "x", summary: { requestedAsOf: ASOF, perAccount: perAccount.slice(0, 2) } });
  ok("T4: an in-bound payload carries no truncated/omittedTargets fields", !("truncated" in small) && !("omittedTargets" in small));
});

test("T5 normalizeTargets(v1): one unit per report (u '-'), owners [id], tok null, asOf = requestedAsOf, states/reasons preserved", () => {
  const summary = { bucket: "india", requestedAsOf: "2026-09-23", dryRun: true, outcome: "partial", code: "OK", perAccount: [
    { accountId: "A", eligible: true, revisionId: "r1", status: "ok", reports: { "brand-sales": { state: "PUBLICATION_NOT_REQUIRED", reason: null }, "daily-reporting": { state: "DEFERRED_DEPENDENCY", reason: "controls-not-opened:CONTROL_LEASE_HELD" } } },
    { accountId: "B", eligible: false, revisionId: null, status: null, reports: { "brand-sales": { state: "DEFERRED_PROVENANCE", reason: "oli-coverage-short" } } },
  ] };
  const v1 = parseTargetsLine(formatTargetsLine({ family: "oli", summary }));
  const n = normalizeTargets(v1);
  ok("T5: top level mapped (family -> route, requestedAsOf -> epoch)", n.v === 2 && n.route === "oli" && n.epoch === "2026-09-23" && n.bucket === "india" && n.dryRun === true && n.outcome === "partial" && n.code === "OK" && n.dataDoeCreates === 0);
  ok("T5: accounts -> targets with one '-' unit per report in report order", n.targets.length === 2 && n.targets[0].id === "A" && n.targets[0].owners.join(",") === "A" && n.targets[0].tok === null && n.targets[0].units.map((u) => u.u + "/" + u.rk + "/" + u.s + "/" + u.r).join(",") === "-/brand-sales/PUBLICATION_NOT_REQUIRED/null,-/daily-reporting/DEFERRED_DEPENDENCY/controls-not-opened:CONTROL_LEASE_HELD" && n.targets[0].units.every((u) => u.asOf === "2026-09-23" && u.h === null && u.sra === null && u.served === null));
  ok("T5: an ineligible account keeps its typed provenance reason", n.targets[1].units[0].s === "DEFERRED_PROVENANCE" && n.targets[1].units[0].r === "oli-coverage-short");
  ok("T5: a normalized v1 re-validates as a well-formed v2 payload (round trip through the v2 parser)", parseTargetsLine(TARGETS_LINE_PREFIX + JSON.stringify(n)) !== null);
  ok("T5: garbage normalizes to null; the v1 builder is unchanged for a null summary", normalizeTargets(null) === null && normalizeTargets({ v: 1 }) === null && normalizeTargets({ v: 9, targets: [] }) === null && buildTargetsPayload({ family: "oli", summary: null }).accounts.length === 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// F4 -- the WP3 verifier follow-ups.
test("F4a two-phase: a prepare succeeds ONLY with ok===true AND prepared===true AND a code that is absent or exactly 0", async () => {
  const cases = [
    ["code 1", { ok: true, code: 1, prepared: true }, false],
    ["code '0' (string)", { ok: true, code: "0", prepared: true }, false],
    ["code null", { ok: true, code: null, prepared: true }, false],
    ["code 0", { ok: true, code: 0, prepared: true }, true],
    ["code absent", { ok: true, prepared: true }, true],
  ];
  for (const [label, res, publishes] of cases) {
    const store = makeStore(); seedSm(store, "ACC1", "A");
    const r = makeRoute({ store, expandUnits: ({ accountId }) => [smUnit(accountId, "A")], prepare: () => res });
    const out = await run(r);
    const e = unitEntry(out, "ACC1", "u-a", "sm");
    if (publishes) ok("F4a: " + label + " -> prepared, published, READBACK_VERIFIED", e.state === RECONCILE_STATUS.READBACK_VERIFIED && r.events.some((x) => x[0] === "publish"));
    else ok("F4a: " + label + " -> FAILED_DERIVE prepare-unconfirmed, NEVER published, ZERO controls opened", e.state === RECONCILE_STATUS.FAILED_DERIVE && e.reason === "prepare-unconfirmed" && e.lkgPreserved === true && !r.events.some((x) => x[0] === "open" || x[0] === "publish") && out.ok === false);
  }
});

test("F4b two-phase: an openControls THROW in window >= 2 keeps earlier windows' results; the rest DEFER 'controls-open-threw'; the summary is returned (non-green)", async () => {
  const setup = (throwAt) => {
    const store = makeStore(); for (const b of ["b1", "b2", "b3"]) seedSm(store, "ACC1", b);
    let opens = 0;
    return makeRoute({ store, chunkMaxTargets: 1, expandUnits: ({ accountId }) => ["b1", "b2", "b3"].map((b) => smUnit(accountId, b)), openControls: () => { opens += 1; if (opens === throwAt) throw new Error("open-boom password=secret"); return { ok: true, reason: "opened" }; } });
  };
  const r2 = setup(2);
  let out2 = null, rejected = null;
  try { out2 = await run(r2); } catch (e) { rejected = e; }
  ok("F4b: the run RESOLVES with a summary (never rejects, never loses window 1)", rejected === null && out2 && Array.isArray(out2.perAccount));
  ok("F4b: window 1's unit stays READBACK_VERIFIED; b2 + b3 DEFERRED_DEPENDENCY controls-open-threw (LKG preserved)", unitEntry(out2, "ACC1", "u-b1", "sm").state === RECONCILE_STATUS.READBACK_VERIFIED
    && ["u-b2", "u-b3"].every((u) => unitEntry(out2, "ACC1", u, "sm").state === RECONCILE_STATUS.DEFERRED_DEPENDENCY && unitEntry(out2, "ACC1", u, "sm").reason === "controls-open-threw" && unitEntry(out2, "ACC1", u, "sm").lkgPreserved === true));
  ok("F4b: safe-close semantics unchanged -- window 1 opened + closed once; the thrown window is never 'closed'; no publish after the throw", r2.events.filter((e) => e[0] === "open").length === 2 && r2.events.filter((e) => e[0] === "close").length === 1 && r2.events.filter((e) => e[0] === "publish").length === 1);
  ok("F4b: counts keep window 1 (1 published, 2 deferred); the run is NON-GREEN (commit state unknown -> CONTROL_CLEANUP_UNRESOLVED, controlReason controls-open-threw)", out2.counts.targetsPublished === 1 && out2.counts.targetsDeferred === 2 && out2.controlCleanupUnresolved === true && out2.code === "CONTROL_CLEANUP_UNRESOLVED" && out2.ok === false && out2.controlReason === "controls-open-threw");
  ok("F4b: the thrown message never reaches a log line", !r2.events.some((e) => e[0] === "log" && /open-boom|secret/.test(e[1])) && r2.events.some((e) => e[0] === "log" && e[1].startsWith("SAVED_DATA_RECONCILE controls-open THREW")));
  const r1 = setup(1);
  const out1 = await run(r1);
  ok("F4b: a throw in window 1 -> every prepared unit DEFERRED controls-open-threw, ZERO publish, ZERO close, summary returned", unitsOf(out1, "ACC1").every((u) => u.reports.sm.reason === "controls-open-threw") && !r1.events.some((e) => e[0] === "publish" || e[0] === "close") && out1.controlCleanupUnresolved === true);
});

test("F4c normalizeRouteUnits: [] stays VALID at the core level but the target is marked 'units-empty' (record + TARGETS v2)", async () => {
  const n = normalizeRouteUnits([], { accountId: "ACC1", requestedAsOf: ASOF, reportKeys: ["sm"] });
  ok("F4c: normalizeRouteUnits([]) -> ok:true, zero units, reason 'units-empty' (a non-empty set keeps reason null)", n.ok === true && n.units.length === 0 && n.reason === "units-empty" && UNITS_EMPTY_REASON === "units-empty" && TARGETS_UNITS_EMPTY === UNITS_EMPTY_REASON
    && normalizeRouteUnits([{ unitKey: "ALL" }], { accountId: "ACC1", requestedAsOf: ASOF, reportKeys: ["sm"] }).reason === null);
  const store = makeStore(); seedSm(store, "ACC2", "A");
  const r = makeRoute({ store, accounts: ["ACC1", "ACC2"], expandUnits: ({ accountId }) => (accountId === "ACC1" ? [] : [smUnit(accountId, "A")]) });
  const out = await run(r);
  const rec1 = out.perAccount.find((x) => x.accountId === "ACC1");
  const rec2 = out.perAccount.find((x) => x.accountId === "ACC2");
  ok("F4c: the empty target is marked rec.unitsReason 'units-empty' (zero units, zero counts); a non-empty target carries no mark", rec1.units.length === 0 && rec1.unitsReason === "units-empty" && !("unitsReason" in rec2) && out.counts.targetsExamined === 1 && out.counts.targetsPublished === 1);
  const t = parseTargetsLine(formatTargetsLine({ family: "sku-movement", summary: out, v: 2 }));
  const t1 = t.targets.find((x) => x.id === "ACC1"), t2 = t.targets.find((x) => x.id === "ACC2");
  ok("F4c: TARGETS v2 carries the empty target EXPLICITLY (r 'units-empty', units []); a non-empty target's shape is unchanged", t1.r === "units-empty" && t1.units.length === 0 && !("r" in t2) && Object.keys(t2).join(",") === "id,owners,tok,units");
  const bare = buildTargetsPayloadV2({ route: "x", summary: { requestedAsOf: ASOF, perAccount: [{ accountId: "B1", units: [] }] } });
  ok("F4c: ANY target with no unit rows is flagged (never an implicit 'every unit current')", bare.targets[0].r === "units-empty");
});

test("F4d owner grammar: the core refuses (typed) every owner the TARGETS v2 grammar would drop -- the two grammars are IDENTICAL", async () => {
  ok("F4d: ROUTE_OWNER_ID_RE is exactly TARGETS_OWNER_ID_RE (source + flags)", ROUTE_OWNER_ID_RE.source === TARGETS_OWNER_ID_RE.source && ROUTE_OWNER_ID_RE.flags === TARGETS_OWNER_ID_RE.flags && ROUTE_OWNER_ID_RE.source === "^[A-Za-z0-9._-]{1,120}$");
  const probe = ["ACC1", "a1b2-c3d4.e_f", "x".repeat(120), "x".repeat(121), "owner with space", "dd:ACC1", "region:india", "ACC1/x", "caf" + String.fromCharCode(233), "ACC1\n", "A\tB", "+acc", ""];
  const coreOk = (o) => normalizeRouteUnits([{ unitKey: "u", ownerAccountIds: [o] }], { accountId: "ACC1", requestedAsOf: ASOF, reportKeys: ["sm"] }).ok === true;
  const lineKeeps = (o) => buildTargetsPayloadV2({ route: "x", summary: { requestedAsOf: ASOF, perAccount: [{ accountId: "T1", ownerAccountIds: [o], units: [] }] } }).targets[0].owners.includes(o);
  ok("F4d: for every probe id, the core accepts it IFF the TARGETS v2 line keeps it", probe.every((o) => coreOk(o) === lineKeeps(o)));
  ok("F4d: the probes exercise both sides (accepted + refused)", probe.filter(coreOk).length === 3 && probe.filter((o) => !coreOk(o)).length === probe.length - 3);
  const bad = normalizeRouteUnits([{ unitKey: "u", ownerAccountIds: ["ACC1", "owner with space"] }], { accountId: "ACC1", requestedAsOf: ASOF, reportKeys: ["sm"] });
  ok("F4d: one bad owner refuses the WHOLE set, typed unit-owners-invalid", bad.ok === false && bad.reason === "unit-owners-invalid" && bad.units.length === 0);
  const store = makeStore(); seedSm(store, "ACC1", "A");
  const r = makeRoute({ store, expandUnits: ({ accountId }) => [smUnit(accountId, "A", { ownerAccountIds: ["owner with space"] })] });
  const out = await run(r);
  ok("F4d: end-to-end, such a unit NEVER opens controls (DEFERRED_PROVENANCE units-invalid:unit-owners-invalid, zero prepare/open/publish)", out.perAccount[0].reports.sm.state === RECONCILE_STATUS.DEFERRED_PROVENANCE && out.perAccount[0].reports.sm.reason === "units-invalid:unit-owners-invalid" && !r.events.some((e) => ["prepare", "open", "publish"].includes(e[0])));
});

test("F5 unit target bound: UTF-8 BYTES (MAX_TARGET_ID_BYTES 2048, under Postgres's 2704-byte btree tuple cap), never UTF-16 length", async () => {
  const norm = (u) => normalizeRouteUnits([{ unitKey: "u", ownerAccountIds: ["ACC1"], ...u }], { accountId: "ACC1", requestedAsOf: ASOF, reportKeys: ["sm"] });
  const EURO = String.fromCharCode(0x20ac); // 3 UTF-8 bytes, 1 UTF-16 unit
  const GRIN = String.fromCodePoint(0x1f600); // 4 UTF-8 bytes, 2 UTF-16 units
  ok("F5: the exported bound is 2048 BYTES and targetIdByteLength is the UTF-8 byte length", MAX_TARGET_ID_BYTES === 2048 && targetIdByteLength("abc") === 3 && targetIdByteLength(EURO) === 3 && targetIdByteLength(GRIN) === 4);
  ok("F5: ASCII -- exactly 2048 bytes accepted, 2049 refused (unit-target-invalid)", norm({ targetId: "x".repeat(2048) }).ok === true && norm({ targetId: "x".repeat(2049) }).reason === "unit-target-invalid");
  const over = EURO.repeat(683); // 2049 bytes, UTF-16 length 683
  const exact = EURO.repeat(682) + "ab"; // 2048 bytes
  ok("F5: a non-ASCII id of 2049 BYTES but only 683 UTF-16 units is REFUSED (a .length check would pass it); 2048 bytes is accepted",
    over.length < 2049 && targetIdByteLength(over) === 2049 && norm({ targetId: over }).ok === false && norm({ targetId: over }).reason === "unit-target-invalid" && norm({ targetId: exact }).ok === true);
  ok("F5: astral characters count 4 bytes (512 accepted, 513 refused)", norm({ targetId: GRIN.repeat(512) }).ok === true && norm({ targetId: GRIN.repeat(513) }).reason === "unit-target-invalid");
  ok("F5: the SAME byte bound applies to liveAccountId (unit-live-account-invalid)", norm({ targetId: "T1", liveAccountId: over }).reason === "unit-live-account-invalid" && norm({ targetId: "T1", liveAccountId: exact }).ok === true);
  const store = makeStore(); seedSm(store, "ACC1", "A");
  const r = makeRoute({ store, expandUnits: ({ accountId }) => [smUnit(accountId, "A", { targetId: "sm:" + accountId + "::" + EURO.repeat(700) })] });
  const out = await run(r);
  ok("F5: end-to-end, an over-bound unit id is typed BEFORE any write (DEFERRED_PROVENANCE units-invalid:unit-target-invalid; zero prepare / open / publish)",
    out.perAccount[0].reports.sm.state === RECONCILE_STATUS.DEFERRED_PROVENANCE && out.perAccount[0].reports.sm.reason === "units-invalid:unit-target-invalid" && !r.events.some((e) => ["prepare", "open", "publish"].includes(e[0])));
});

async function main() {
  writeSync(1, "saved-data-reconciler-routes\n");
  let failures = 0;
  for (const t of tests) { try { await t.fn(); } catch (e) { failures += 1; writeSync(1, "FAIL  " + t.name + "\n" + String((e && e.stack) || e) + "\n"); } }
  writeSync(1, `\nsaved-data-reconciler-routes: ${passed} assertions passed${failures ? ", " + failures + " FAILED" : ""}\n`);
  if (failures) process.exitCode = 1;
}
main();
