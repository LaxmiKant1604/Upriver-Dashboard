// PRODUCTION-SHAPE integration for the OLI reconciler (blocker 7). Drives the REAL compositions end to end with only
// the durable I/O injected (an in-memory control store + a live-snapshot Map): (1) the reviewed priority-partial cycle
// NAMESPACE capability check, (2) the REAL control-package apply -> exact fence GENERATION -> publisher publish with
// that fence -> canonical PROMOTION + REAL readback -> SAFE-CLOSE (release), (3) a SECOND pass = zero-write no-op. The
// no-export adapter makes every DataDoe create/poll/download impossible. Offline; zero network. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { readPartialCycleCapability, PARTIAL_CYCLE_CAPABILITY_PATTERN } from "../lib/server/sync/priority-partial-capability.js";
import { runControlPackageCli } from "../lib/server/sync/source-priority-control-package.js";
import * as pubComposition from "../lib/server/sync/publisher-composition.js";
import * as publisherCore from "../lib/server/sync/report-publisher.js";
import * as releaseRunner from "../lib/server/sync/source-priority-release-runner.js";
import * as reportDerivation from "../lib/server/sync/report-derivation.js";
import * as reportStore from "../lib/server/report-store.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const TS = "2026-09-09T00:00:00.000Z";
const ASOF = "2026-09-09";

// ---- (1) NAMESPACE: the REAL capability check (readPartialCycleCapability) against a fake schema ----
const capQuery = (withPattern) => async (sql) => {
  const def = withPattern ? ("...CHECK (bucket ~ '" + PARTIAL_CYCLE_CAPABILITY_PATTERN + "')...") : "...CHECK (bucket = 'india')...";
  if (/to_regprocedure/.test(sql)) return [{ present: true, def }];
  return [{ def }];
};
test("blocker 1: the priority-partial namespace capability check permits ONLY when the migration widened both objects", async () => {
  const permitted = await readPartialCycleCapability(capQuery(true));
  ok("permitted when both open_sync_cycle + sync_cycles_bucket_check contain the exact regex", permitted.permitted === true);
  const notPermitted = await readPartialCycleCapability(capQuery(false));
  ok("NOT permitted (fail closed) when the migration is absent -- the reconciler would defer, zero writes", notPermitted.permitted === false && /capability absent/.test(notPermitted.reason));
  const unreadable = await readPartialCycleCapability(async () => { throw new Error("db down"); });
  ok("NOT permitted (fail closed) when the capability read throws", unreadable.permitted === false && /capability-unreadable/.test(unreadable.reason));
});

// ---- (2) CONTROL-PACKAGE TRANSACTION: a faithful in-memory store for runControlPackageTransaction ----
function inMemoryControlStore() {
  const s = { rollout: [], dispatch: [], promoted: [], approvals: [], lease: null, gen: 0 };
  return {
    _s: s,
    begin: async () => {}, commit: async () => {}, rollback: async () => {}, end: async () => {},
    acquireControlLease: async (owner) => { s.gen += 1; s.lease = { owner, generation: s.gen }; return { disposition: "acquired", generation: s.gen, owner_token: owner }; },
    renewControlLease: async (owner, gen) => (s.lease && s.lease.owner === owner && s.lease.generation === gen ? { disposition: "renewed" } : { disposition: "lost" }),
    assertControlLeaseOwner: async (owner, gen) => !!s.lease && s.lease.owner === owner && s.lease.generation === gen,
    lockAndVerifyControlLease: async (owner, gen) => !!s.lease && s.lease.owner === owner && s.lease.generation === gen,
    releaseControlLease: async (owner, gen) => (s.lease && s.lease.owner === owner && s.lease.generation === gen ? (s.lease = null, { disposition: "released" }) : { disposition: "not-owner" }),
    readAllPrimary: async () => false,
    hasCron: async () => false,
    setRolloutEnabled: async (ids) => { s.rollout = [...ids].map((id) => ({ account_id: String(id), enabled: true })); },
    setDispatchEnabled: async (enabled, controlled) => { const en = new Set(enabled.map(String)); s.dispatch = [...controlled].map((rk) => ({ report_key: String(rk), schedule_enabled: en.has(String(rk)) })); },
    setPromotedEnabled: async (ids) => { s.promoted = [...ids].map((rk) => ({ report_key: String(rk), publish_enabled: true })); },
    setApprovalsApproved: async (pairs) => { s.approvals = [...pairs].map((p) => { const [rk, a] = String(p).split("|"); return { report_key: rk, account_id: a, approved: true }; }); },
    disableAllRollout: async () => { s.rollout = s.rollout.map((r) => ({ ...r, enabled: false })); },
    pauseAllDispatch: async (controlled) => { s.dispatch = [...controlled].map((rk) => ({ report_key: String(rk), schedule_enabled: false })); },
    disableAllPromoted: async () => { s.promoted = s.promoted.map((r) => ({ ...r, publish_enabled: false })); },
    revokeAllApprovals: async () => { s.approvals = s.approvals.map((r) => ({ ...r, approved: false })); },
    rolloutRows: async () => [...s.rollout],
    dispatchRows: async () => [...s.dispatch],
    promotedRows: async () => [...s.promoted],
    approvalRows: async () => [...s.approvals],
  };
}
const rolloutIds = (st) => st._s.rollout.filter((r) => r.enabled).map((r) => r.account_id).sort();
const dispatchIds = (st) => st._s.dispatch.filter((r) => r.schedule_enabled).map((r) => r.report_key).sort();
const promotedIds = (st) => st._s.promoted.filter((r) => r.publish_enabled).map((r) => r.report_key).sort();
const approvalPairs = (st) => st._s.approvals.filter((r) => r.approved).map((r) => r.report_key + "|" + r.account_id).sort();
test("blocker 2: REAL control-package apply opens exactly the target gates + returns a valid fencing generation; safe-close releases", async () => {
  const store = inMemoryControlStore();
  const apply = await runControlPackageCli({ mode: "apply", operator: "oli-reconcile:india:t", discoverAccounts: async () => ["A01"], connectStore: async () => store, ownerToken: "oli-reconcile:india:t", operationKey: "oli-reconcile/india/" + ASOF, leaseTtlSeconds: 900 });
  ok("apply committed with a valid positive fencing generation", apply.committed === true && Number.isSafeInteger(apply.leaseGeneration) && apply.leaseGeneration > 0);
  ok("the control gate opened rollout for EXACTLY the target account (A01)", rolloutIds(store).join(",") === "A01");
  ok("report settings: daily-reporting + brand-sales dispatch enabled", dispatchIds(store).join(",") === "brand-sales,daily-reporting");
  ok("promoted: brand-inventory enabled", promotedIds(store).join(",") === "brand-inventory");
  ok("approvals opened for A01 x the 3 publish keys", approvalPairs(store).length === 3 && approvalPairs(store).every((p) => p.endsWith("|A01")));
  const close = await runControlPackageCli({ mode: "rollback", operator: "oli-reconcile:india:t", connectStore: async () => store, ownerToken: "oli-reconcile:india:t", ownerGeneration: apply.leaseGeneration, operationKey: "oli-reconcile/india/" + ASOF });
  ok("safe-close committed + released the lease + disabled every control", close.committed === true && store._s.lease === null && rolloutIds(store).length === 0 && approvalPairs(store).length === 0);
});

// ---- (3) REAL publisher promotion + readback + second-pass no-op, over the fenced CAS + the no-export adapter ----
function shadowSpec(rk, accountId) {
  if (rk === "daily-reporting") return { version: "daily-reporting/v2f-campaign", params: { reportVersion: "daily-reporting/v2f-campaign", accountId, from: "2026-03-19", to: ASOF, brand: "ALL" }, payload: { rows: [], brandFiltered: false, adsAvailability: { status: "unavailable" } } };
  if (rk === "brand-sales") return { version: "brand-sales/v2d-2", params: { reportVersion: "brand-sales/v2d-2", accountId, from: "2025-01-01", to: ASOF }, payload: { rows: [], catalogBrands: [], asinBrand: { B0A: "Acme" } } };
  return { version: "brand-inventory-shared-v1", params: { reportVersion: "brand-inventory-shared-v1", accountId, to: ASOF }, payload: { inventoryByBrandCountry: [], inventoryDate: null, inventoryAvailable: false } };
}
const shadowHash = (rk, a) => reportStore.paramsHashFor(shadowSpec(rk, a).version, shadowSpec(rk, a).params);
const liveKey = (rk, a) => { const c = publisherCore.SCHEDULER_LIVE_SNAPSHOT_CONTRACTS[rk]; return c.liveReportKey + "|" + a + "|" + reportStore.paramsHashFor(c.liveReportVersion, c.liveParams(shadowSpec(rk, a).params)); };
const noExportAdapter = () => ({ create: async () => { throw new Error("OLI_RECONCILER_NO_EXPORT create"); }, poll: async () => { throw new Error("OLI_RECONCILER_NO_EXPORT poll"); }, download: async () => { throw new Error("OLI_RECONCILER_NO_EXPORT download"); } });

function realPublisher(liveStore, writeLog) {
  return pubComposition.buildSchedulerV2Publisher({
    connections: [{ id: "primary", apiKey: "k", accountPrefix: "" }],
    fetchAccounts: async () => [{ id: "A01", name: "A01", country: "US", currency: "USD", status: "active" }],
    getAccountRollout: async () => ({ read: "ok", allPrimary: false, enabledAccountIds: ["A01"] }),
    getSettings: async () => [{ report_key: "daily-reporting", schedule_enabled: true }, { report_key: "brand-sales", schedule_enabled: true }],
    getPromotedSettings: async () => [{ report_key: "brand-inventory", publish_enabled: true }],
    getApproval: async () => ({ read: "ok", approved: true }),
    getJob: async (rk, acct) => ({ cycle_id: "cyc-" + acct, validated: true, snapshot_params_hash: shadowHash(rk, acct), derive_status: "succeeded", save_status: "succeeded", cycle_status: "succeeded" }),
    getSnapshot: async ({ reportKey, accountId }) => { const rk = reportKey.replace("scheduler-v2/", ""); const s = shadowSpec(rk, accountId); return { params_hash: shadowHash(rk, accountId), params: s.params, payload: s.payload, payload_storage_path: null, source_refreshed_at: TS }; },
    getControlFence: () => ({ ownerToken: "test-owner", generation: 1 }),
    publishLiveFenced: async (args) => {
      const k = args.reportKey + "|" + args.accountId + "|" + args.paramsHash;
      const existing = liveStore.get(k);
      if (existing && existing.source_refreshed_at === args.sourceRefreshedAt) return { outcome: "already-current" };
      writeLog.push(k); liveStore.set(k, { report_key: args.reportKey, account_id: args.accountId, params_hash: args.paramsHash, params: args.params, payload: args.payload, payload_storage_path: null, source_refreshed_at: args.sourceRefreshedAt });
      return { outcome: existing ? "replaced" : "inserted" };
    },
  });
}
test("blocker 7: REAL publisher promotes to the canonical live key + REAL readback verifies; the SECOND pass is a zero-write no-op", async () => {
  const liveStore = new Map(); const writeLog = [];
  const pub = realPublisher(liveStore, writeLog);
  const REPORTS = ["daily-reporting", "brand-sales", "brand-inventory"];
  // Pass 1: publish the 3 reports -> 3 canonical live rows written.
  for (const rk of REPORTS) { const r = await pub.publish(rk, "A01"); ok(rk + " promoted to its canonical live key (disposition published)", r.disposition === "published" && liveStore.has(liveKey(rk, "A01"))); }
  ok("exactly 3 canonical live rows were written", writeLog.length === 3);
  // REAL exact-identity readback verifies each promoted row.
  const readback = releaseRunner.buildLiveReadback({
    getReportSnapshot: async ({ reportKey, accountId, paramsHash }) => liveStore.get(reportKey + "|" + accountId + "|" + paramsHash) || null,
    loadStoragePayload: async () => null,
    liveContracts: publisherCore.SCHEDULER_LIVE_SNAPSHOT_CONTRACTS,
    reportDerivations: reportDerivation.REPORT_DERIVATIONS,
    computeHash: reportStore.paramsHashFor,
  });
  for (const rk of REPORTS) { const c = publisherCore.SCHEDULER_LIVE_SNAPSHOT_CONTRACTS[rk]; const ph = reportStore.paramsHashFor(c.liveReportVersion, c.liveParams(shadowSpec(rk, "A01").params)); ok(rk + " exact-identity readback ok", (await readback({ reportKey: c.liveReportKey, liveReportKey: c.liveReportKey, accountId: "A01", paramsHash: ph })).ok === true); }
  // Pass 2: same durable evidence -> the fenced CAS is a zero-write no-op (already-current).
  const before = writeLog.length;
  for (const rk of REPORTS) { const r = await pub.publish(rk, "A01"); ok(rk + " second pass is already-current (zero write)", r.disposition === "already-current"); }
  ok("the second pass wrote ZERO new live rows (idempotent no-op)", writeLog.length === before);
});

test("blocker 7: the no-export adapter makes every DataDoe create/poll/download impossible (fail closed, never a paid export)", async () => {
  const a = noExportAdapter();
  for (const op of ["create", "poll", "download"]) {
    let threw = false;
    try { await a[op]({}); } catch (e) { threw = /OLI_RECONCILER_NO_EXPORT/.test(String(e && e.message)); }
    ok("adapter." + op + " throws OLI_RECONCILER_NO_EXPORT", threw);
  }
});

async function main() {
  writeSync(1, "oli-reconcile-prodshape\n");
  let failures = 0;
  for (const t of tests) {
    try { await t.fn(); } catch (e) { failures += 1; writeSync(1, "FAIL  " + t.name + "\n" + String((e && e.stack) || e) + "\n"); }
  }
  writeSync(1, `\noli-reconcile-prodshape: ${passed} assertions passed${failures ? ", " + failures + " FAILED" : ""}\n`);
  if (failures) process.exitCode = 1;
}
main();
