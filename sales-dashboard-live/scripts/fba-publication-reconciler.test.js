// FBA-inventory publication reconciler orchestration: the REAL shared reconciler core + REAL FBA revision/binding, with
// injected durable-FBA readers / control hooks / release execution (clearly labelled). Covers the required reproduction
// cases: saved-but-unpromoted -> publish+readback; same revision -> zero writes; date-advanced revision -> republish;
// valid-empty -> eligible (unavailable, never zero); one bad/absent account does not block healthy accounts;
// per-account read isolation; missing snapshot preserves LKG; readback failure -> non-green; manual dry-run -> zero
// writes; zero provider export. Offline; zero network. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { buildFbaPublicationReconciler, FBA_RECONCILE_STATUS } from "../lib/server/sync/fba-publication-reconciler.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const REPORTS = ["brand-inventory"];
const ASOF = "2026-09-10";
const CONTRACTS = { "brand-inventory": { liveReportKey: "brand-inventory", liveReportVersion: "brand-inventory-live", liveParams: (p) => ({ to: p.to }) } };
const RD = { "brand-inventory": { snapshotVersion: "brand-inventory/shadow", validatePayload: (p) => !!(p && p.valid === true) } };
const HASH = (v, params) => v + "|" + JSON.stringify(params);
const shParamsFor = (accountId, to) => ({ reportVersion: "brand-inventory/shadow", accountId, to: to || ASOF });
const shHashFor = (accountId, to) => HASH("brand-inventory/shadow", shParamsFor(accountId, to));

// Harness: REAL FBA reconciler + REAL revision/binding + injected readers/control/release. Per-account durable FBA
// snapshot modelled by snapshotByAccount; the expected D-1 request hash by expectedHashByAccount (default = the
// snapshot's own request hash, i.e. a proven-D-1 snapshot). Staleness is modelled by liveRefresh (set on a successful
// promote) + jobDependsOn (default = the account's current FBA request hash -> covered).
function makeHarness(over = {}) {
  const calls = { release: [], openControls: [], closeControls: [], releaseRevisions: [], snapshotReads: [] };
  const snapshotByAccount = over.snapshotByAccount || new Map([
    ["A01", { source_request_hash: "rh-A01", payload_sha: "ps-A01", row_count: 12 }],
    ["A02", { source_request_hash: "rh-A02", payload_sha: "ps-A02", row_count: 0 }], // valid EMPTY (unavailable, not zero)
  ]); // A03 (in accounts, not here) -> no snapshot -> DEFERRED_PROVENANCE
  const expectedHashByAccount = over.expectedHashByAccount || null; // null -> derive from the snapshot (proven-D-1)
  const jobDependsOn = over.jobDependsOn || null; // null -> [snapshot.request_hash] (covered)
  const shadowRefresh = over.shadowRefresh || new Map();
  const liveRefresh = over.liveRefresh || new Map();
  const jobPromotable = over.jobPromotable || new Map();
  const shadowPayload = over.shadowPayload || { valid: true, rows: [] };
  const livePayload = over.livePayload || shadowPayload;
  const candTo = over.candTo || ASOF;
  const attempts = new Map();
  const releaseFor = over.releaseFor || (() => ({ ok: true, code: 0 }));
  const shRef = (a) => shadowRefresh.get(a) || "2026-09-10T05:00:00Z";
  const expectedHashOf = (a) => (expectedHashByAccount ? (expectedHashByAccount.get(a) || "") : (snapshotByAccount.get(a) ? snapshotByAccount.get(a).source_request_hash : ""));
  const depsOf = (a) => (jobDependsOn ? (jobDependsOn.get(a) || []) : (snapshotByAccount.get(a) ? [snapshotByAccount.get(a).source_request_hash] : []));
  const reconciler = buildFbaPublicationReconciler({
    resolveOrg: async () => over.org || ({ organizationFingerprint: "org-1", connectionId: "primary" }),
    bucketAccounts: async () => over.accounts || [{ accountId: "A01" }, { accountId: "A02" }, { accountId: "A03" }],
    readFbaSnapshot: over.readFbaSnapshot || (async ({ accountId }) => { calls.snapshotReads.push(accountId); const s = snapshotByAccount.get(accountId); return s ? { read: "ok", snapshot: s } : { read: "ok", snapshot: null }; }),
    resolveExpectedRequestHash: over.resolveExpectedRequestHash || (async ({ accountId }) => expectedHashOf(accountId)),
    readLatestReportJob: async ({ accountId }) => {
      if (!snapshotByAccount.has(accountId)) return null;
      const promo = jobPromotable.has(accountId) ? jobPromotable.get(accountId) : true;
      if (!promo) return { deriveStatus: "failed", saveStatus: "succeeded", validated: false, cycleStatus: "running", snapshotParamsHash: "", dependsOn: [] };
      return { deriveStatus: "succeeded", saveStatus: "succeeded", validated: true, cycleStatus: "succeeded", snapshotParamsHash: shHashFor(accountId, candTo), dependsOn: [...depsOf(accountId), "catalog"] };
    },
    readShadowSnapshot: async ({ reportKey, accountId, paramsHash }) => { if (!snapshotByAccount.has(accountId)) return null; return { report_key: reportKey, account_id: accountId, params_hash: paramsHash, params: shParamsFor(accountId, candTo), payload: shadowPayload, payload_storage_path: null, source_refreshed_at: shRef(accountId) }; },
    readLiveSnapshot: async ({ reportKey, accountId, paramsHash }) => { if (!liveRefresh.has(accountId)) return null; return { report_key: reportKey, account_id: accountId, params_hash: paramsHash, params: { reportVersion: CONTRACTS[reportKey].liveReportVersion, to: candTo }, payload: livePayload, payload_storage_path: null, source_refreshed_at: liveRefresh.get(accountId) }; },
    loadStoragePayload: async () => null,
    verifyLiveReadback: over.verifyLiveReadback || (async ({ accountId }) => ({ ok: liveRefresh.has(accountId) })),
    liveContracts: CONTRACTS, computeHash: HASH, reportDerivations: RD,
    runReleaseForAccount: ({ accountId, revisionId }) => {
      calls.release.push(accountId); calls.releaseRevisions.push({ accountId, revisionId });
      const n = (attempts.get(accountId) || 0) + 1; attempts.set(accountId, n);
      const r = releaseFor(accountId, n, revisionId);
      if (r.ok) liveRefresh.set(accountId, shRef(accountId));
      return Promise.resolve(r);
    },
    openControls: over.openControls || (async (ids) => { calls.openControls.push([...ids]); return { ok: true }; }),
    closeControls: over.closeControls || (async () => { calls.closeControls.push(1); return { ok: true }; }),
    reportKeys: REPORTS,
    log: () => {},
  });
  return { reconciler, calls, snapshotByAccount, liveRefresh, shadowRefresh };
}
const rep = (out, acct) => out.perAccount.find((a) => a.accountId === acct).reports;
const stateOf = (out, acct, rk) => rep(out, acct)[rk].state;

// (1) saved FBA exists but the live brand-inventory was never promoted -> reconciler publishes + readback verifies.
test("test 1: durable FBA saved + live brand-inventory UNPROMOTED (missing) -> derive + promote (READBACK_VERIFIED); controls opened; zero export", async () => {
  const h = makeHarness();
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 (eligible, live missing) publishes brand-inventory", stateOf(out, "A01", "brand-inventory") === FBA_RECONCILE_STATUS.READBACK_VERIFIED);
  ok("A02 (valid EMPTY, live missing) ALSO publishes (unavailable inventory is a publishable snapshot, never zero)", stateOf(out, "A02", "brand-inventory") === FBA_RECONCILE_STATUS.READBACK_VERIFIED);
  ok("A03 (no durable snapshot) DEFERRED_PROVENANCE (never published; LKG preserved)", stateOf(out, "A03", "brand-inventory") === FBA_RECONCILE_STATUS.DEFERRED_PROVENANCE);
  ok("controls opened for exactly the stale accounts; zero DataDoe export", h.calls.openControls.length === 1 && out.dataDoeCreates === 0 && out.dataDoeTokens === 0);
});

// (2) same source revision + a promoted+verified live snapshot -> zero writes.
test("test 2: current durable FBA already promoted (live bound + verified) -> PUBLICATION_NOT_REQUIRED, ZERO writes", async () => {
  const h = makeHarness({ liveRefresh: new Map([["A01", "2026-09-10T05:00:00Z"], ["A02", "2026-09-10T05:00:00Z"]]) });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01/A02 already current -> PUBLICATION_NOT_REQUIRED", stateOf(out, "A01", "brand-inventory") === "PUBLICATION_NOT_REQUIRED" && stateOf(out, "A02", "brand-inventory") === "PUBLICATION_NOT_REQUIRED");
  ok("no controls opened, no release ran (zero writes)", h.calls.openControls.length === 0 && h.calls.release.length === 0 && out.outcome !== "failed");
});

// (3) durable FBA advanced to a NEW day (request hash advanced past the live job's depends_on) -> STALE -> republish.
test("test 3: durable FBA DATE-ADVANCED (new request hash not in the live job's depends_on) -> STALE -> re-derive + promote", async () => {
  const liveRefresh = new Map([["A01", "2026-09-10T05:00:00Z"]]); // a live exists
  const jobDependsOn = new Map([["A01", ["rh-A01-OLDER-DAY"]]]); // job bound to the OLDER day's FBA hash
  const snapshotByAccount = new Map([["A01", { source_request_hash: "rh-A01-D1", payload_sha: "ps-new", row_count: 9 }]]);
  const h = makeHarness({ accounts: [{ accountId: "A01" }], snapshotByAccount, jobDependsOn, liveRefresh });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 re-derived (current FBA request hash is not in the live job's depends_on -> fba-revision-changed)", stateOf(out, "A01", "brand-inventory") === FBA_RECONCILE_STATUS.READBACK_VERIFIED && h.calls.release.length === 1);
});

// (4) one bad account (ineligible) does not block healthy accounts.
test("test 4: one account with NO durable snapshot does not block a healthy account (per-account isolation)", async () => {
  const snapshotByAccount = new Map([["A01", { source_request_hash: "rh-A01", payload_sha: "ps-A01", row_count: 3 }]]); // A02 absent
  const h = makeHarness({ accounts: [{ accountId: "A01" }, { accountId: "A02" }], snapshotByAccount });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 published; A02 deferred; the healthy account was NOT suppressed", stateOf(out, "A01", "brand-inventory") === FBA_RECONCILE_STATUS.READBACK_VERIFIED && stateOf(out, "A02", "brand-inventory") === FBA_RECONCILE_STATUS.DEFERRED_PROVENANCE);
});

// (per-account read isolation) a snapshot read that THROWS for one account defers ONLY that account.
test("per-account read isolation: readFbaSnapshot THROWS for A02 -> A02 deferred, A01 healthy publishes", async () => {
  const snapshotByAccount = new Map([["A01", { source_request_hash: "rh-A01", payload_sha: "ps-A01", row_count: 3 }], ["A02", { source_request_hash: "rh-A02", payload_sha: "ps-A02", row_count: 3 }]]);
  const h = makeHarness({
    accounts: [{ accountId: "A01" }, { accountId: "A02" }], snapshotByAccount,
    readFbaSnapshot: async ({ accountId }) => { if (accountId === "A02") throw new Error("boom"); const s = snapshotByAccount.get(accountId); return { read: "ok", snapshot: s }; },
  });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A02 read threw -> DEFERRED_PROVENANCE (isolated); A01 READBACK_VERIFIED", stateOf(out, "A02", "brand-inventory") === FBA_RECONCILE_STATUS.DEFERRED_PROVENANCE && stateOf(out, "A01", "brand-inventory") === FBA_RECONCILE_STATUS.READBACK_VERIFIED && out.ok === true);
});

// a read!='ok' (schema-missing / read-failed) for one account defers ONLY that account.
test("read!='ok' for A02 -> A02 deferred (LKG preserved); A01 publishes; whole run stays ok", async () => {
  const h = makeHarness({
    accounts: [{ accountId: "A01" }, { accountId: "A02" }],
    snapshotByAccount: new Map([["A01", { source_request_hash: "rh-A01", payload_sha: "ps", row_count: 4 }], ["A02", { source_request_hash: "rh-A02", payload_sha: "ps", row_count: 4 }]]),
    readFbaSnapshot: async ({ accountId }) => (accountId === "A02" ? { read: "read-failed" } : { read: "ok", snapshot: { source_request_hash: "rh-A01", payload_sha: "ps", row_count: 4 } }),
  });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A02 read-failed -> DEFERRED_PROVENANCE; A01 published; ok:true", stateOf(out, "A02", "brand-inventory") === FBA_RECONCILE_STATUS.DEFERRED_PROVENANCE && stateOf(out, "A01", "brand-inventory") === FBA_RECONCILE_STATUS.READBACK_VERIFIED && out.ok === true);
});

// (6) a missing durable snapshot preserves the live LKG byte-identical (no release, no control open for that account).
test("test 6: a missing durable FBA snapshot preserves the existing live LKG (no release; live untouched)", async () => {
  const liveRefresh = new Map([["A03", "2026-09-01T00:00:00Z"]]); // A03 has an existing (older) live LKG
  const before = liveRefresh.get("A03");
  const h = makeHarness({ accounts: [{ accountId: "A03" }], snapshotByAccount: new Map(), liveRefresh });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A03 (no durable snapshot) DEFERRED_PROVENANCE; no release ran; the live LKG is byte-identical", stateOf(out, "A03", "brand-inventory") === FBA_RECONCILE_STATUS.DEFERRED_PROVENANCE && h.calls.release.length === 0 && h.liveRefresh.get("A03") === before);
});

// (7) valid FBA empty becomes an eligible (unavailable) publication, never zero -- proven at the reconciler level.
test("test 7: a VALID EMPTY durable FBA snapshot is ELIGIBLE and publishes (inventory unavailable), never deferred-as-missing, never zero", async () => {
  const snapshotByAccount = new Map([["A02", { source_request_hash: "rh-A02", payload_sha: "ps-empty", row_count: 0 }]]);
  const h = makeHarness({ accounts: [{ accountId: "A02" }], snapshotByAccount });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A02 valid-empty is eligible + published (not DEFERRED_PROVENANCE)", stateOf(out, "A02", "brand-inventory") === FBA_RECONCILE_STATUS.READBACK_VERIFIED);
  ok("its revision folded a real content hash (a genuine snapshot, not a manufactured zero)", h.calls.releaseRevisions.find((r) => r.accountId === "A02").revisionId.length === 32);
});

// (8) an OLDER/other-day durable snapshot (cannot prove D-1) is DEFERRED, never published as fresh.
test("test 8: a durable snapshot that cannot prove the requested D-1 (request hash != recomputed) -> DEFERRED_PROVENANCE (never published as fresh)", async () => {
  const snapshotByAccount = new Map([["A01", { source_request_hash: "rh-STALE", payload_sha: "ps", row_count: 5 }]]);
  const expectedHashByAccount = new Map([["A01", "rh-D1-EXPECTED"]]); // recomputed D-1 hash differs from the snapshot's
  const h = makeHarness({ accounts: [{ accountId: "A01" }], snapshotByAccount, expectedHashByAccount });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 DEFERRED_PROVENANCE (snapshot-not-d1); no release; LKG preserved", stateOf(out, "A01", "brand-inventory") === FBA_RECONCILE_STATUS.DEFERRED_PROVENANCE && h.calls.release.length === 0);
});

// (14) a readback failure after a write produces a NON-GREEN status.
test("test 14: a release that fails at readback -> FAILED_READBACK, outcome failed, ok:false", async () => {
  const h = makeHarness({ accounts: [{ accountId: "A01" }], snapshotByAccount: new Map([["A01", { source_request_hash: "rh-A01", payload_sha: "ps", row_count: 5 }]]), releaseFor: () => ({ ok: false, code: 1, stage: "readback", reason: "live read-back failed" }) });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 FAILED_READBACK; outcome failed; ok:false", stateOf(out, "A01", "brand-inventory") === FBA_RECONCILE_STATUS.FAILED_READBACK && out.outcome === "failed" && out.ok === false);
});

// (16) manual dry-run performs ZERO writes even for a stale account.
test("test 16: dry-run performs ZERO writes (no controls, no release) even when accounts are stale", async () => {
  const h = makeHarness();
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic", dryRun: true });
  ok("dry-run: no controls opened, no release, stale reported (zero writes)", h.calls.openControls.length === 0 && h.calls.release.length === 0 && out.dryRun === true && stateOf(out, "A01", "brand-inventory") === "STALE");
});

// a deferred source (controls not opened) preserves LKG and is honest (partial, ok:true).
test("controls not opened (scheduler holds the lease) -> every stale account DEFERRED_DEPENDENCY, ZERO release, LKG preserved, ok:true", async () => {
  const h = makeHarness({ openControls: async () => ({ ok: false, reason: "scheduler-holds-lease" }) });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 deferred (controls-not-opened); no release; ok:true", stateOf(out, "A01", "brand-inventory") === FBA_RECONCILE_STATUS.DEFERRED_DEPENDENCY && h.calls.release.length === 0 && out.ok === true);
});

// dependency-safety: the reconciler wrapper references NO export/token transport symbol.
test("dependency-safety: the FBA reconciler wrapper + core reference NO provider export/token transport symbol", async () => {
  const { readFileSync } = await import("node:fs");
  const wrap = readFileSync(new URL("../lib/server/sync/fba-publication-reconciler.js", import.meta.url), "utf8");
  const core = readFileSync(new URL("../lib/server/sync/saved-data-reconciler.js", import.meta.url), "utf8");
  for (const sym of ["createExport", "exportsCreate", "makeDataDoeAdapter", "reserveTokens", "/exports"]) {
    ok("wrapper has no '" + sym + "'", !wrap.includes(sym));
    ok("core has no '" + sym + "'", !core.includes(sym));
  }
  ok("wrapper imports the FBA registry + FBA revision + shared core only (never datadoe/source-sync-driver)", /from "\.\/fba-dependent-reports\.js"/.test(wrap) && /from "\.\/fba-inventory-revision\.js"/.test(wrap) && /from "\.\/saved-data-reconciler\.js"/.test(wrap) && !/from "\.\.\/datadoe/.test(wrap) && !/source-sync-driver/.test(wrap));
});

async function main() {
  writeSync(1, "fba-publication-reconciler\n");
  let failures = 0;
  for (const t of tests) { try { await t.fn(); } catch (e) { failures += 1; writeSync(1, "FAIL  " + t.name + "\n" + String((e && e.stack) || e) + "\n"); } }
  writeSync(1, `\nfba-publication-reconciler: ${passed} assertions passed${failures ? ", " + failures + " FAILED" : ""}\n`);
  if (failures) process.exitCode = 1;
}
main();
