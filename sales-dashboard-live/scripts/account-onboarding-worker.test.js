// The 15-minute onboarding DISCOVERY worker -- orchestration, atomic claims, idempotent replay,
// structural zero-export. Fully offline (every collaborator injected). 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  runAccountOnboardingDiscovery, onboardingRowMateriallyChanged,
  ONBOARDING_EVIDENCE_REPORT_KEYS, ACCOUNT_DIRECTORY_REPORT_KEY, ACCOUNT_DIRECTORY_ACCOUNT_ID,
} from "../lib/server/sync/account-onboarding-discovery.js";
import { ONBOARDING_STATUS } from "../lib/server/sync/account-onboarding.js";
import { OLI_SOURCE_KEY } from "../lib/server/sync/source-durable-model.js";
import { CAMPAIGN_ADS_GRAIN } from "../lib/server/sync/scheduled-campaign-ads-runner.js";

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); };
writeSync(1, "account-onboarding-worker\n");

const NOW = Date.parse("2026-09-06T12:00:00Z");
const detailed = (id, country, ready) => ({
  id, name: `A ${id}`, country, countryName: country, currency: "USD", locale: "en-US", timeZone: "UTC",
  readiness: { sellerCentralReady: ready, rowCount: 10, sellerCentralRowCount: 5, adsConnected: true, adsReady: ready, adsRowCount: 3, accountType: "SELLER", marketplaceId: "M1" },
});

// A tiny in-memory durable store modelling account_onboarding + the claim RPC + the directory snapshot.
function makeWorld({ accounts, rows = [], priorSnapshotAccounts = [], evidence = {} } = {}) {
  const world = {
    accounts, rows: rows.map((r) => ({ ...r })),
    snapshotAccounts: priorSnapshotAccounts.map((a) => ({ ...a })),
    upsertCalls: [], claimCalls: [], snapshotSaves: [], tableUpserts: [],
    dataDoeGets: 0,
  };
  world.deps = {
    getConnections: () => [{ id: "primary", apiKey: "fixture-key", accountPrefix: "" }],
    fetchDetailed: async () => { world.dataDoeGets += 1; return world.accounts; },
    readOnboardingRows: async () => world.rows.map((r) => ({ ...r })),
    upsertRows: async (rows) => {
      world.upsertCalls.push(rows);
      for (const row of rows) {
        const i = world.rows.findIndex((r) => r.account_id === row.account_id);
        if (i >= 0) world.rows[i] = { ...world.rows[i], ...row };
        else world.rows.push({ ...row, first_discovered_at: new Date(NOW).toISOString() });
      }
    },
    claimBootstrap: async ({ accountId, operationId }) => {
      world.claimCalls.push({ accountId, operationId });
      const row = world.rows.find((r) => r.account_id === accountId);
      if (!row) return { disposition: "not-found", account_id: accountId };
      if (row.operation_id === operationId) return { disposition: "already-claimed", operation_id: operationId, status: row.status };
      if (row.operation_id) return { disposition: "held", operation_id: row.operation_id, status: row.status };
      if (row.status !== ONBOARDING_STATUS.READY_FOR_BOOTSTRAP) return { disposition: "not-claimable", status: row.status };
      row.operation_id = operationId; row.status = ONBOARDING_STATUS.BOOTSTRAPPING;
      return { disposition: "claimed", operation_id: operationId, status: "bootstrapping" };
    },
    readOliCoverage: async (accountId) => ({ read: "ok", windows: evidence[accountId]?.oli || [] }),
    readSnapshotPresence: async ({ accountIds }) => accountIds.flatMap((id) => (evidence[id]?.presence || []).map((reportKey) => ({ accountId: id, reportKey }))),
    readCampaignCoverage: async (accountId) => ({ read: "ok", windows: evidence[accountId]?.campaign || [] }),
    readDirectorySnapshot: async () => ({ payload: { accounts: world.snapshotAccounts.map((a) => ({ ...a })) } }),
    saveDirectorySnapshot: async (snapshot) => { world.snapshotSaves.push(snapshot); world.snapshotAccounts = snapshot.payload.accounts.map((a) => ({ ...a })); },
    upsertDirectoryTable: async (rows) => { world.tableUpserts.push(rows); },
    paramsHashFor: (version, params) => `hash:${version}:${JSON.stringify(params)}`,
  };
  return world;
}

/* ===================== A. first pass: loading stays waiting; ready-but-new gets claimed ===================== */
await (async () => {
  const world = makeWorld({
    accounts: [detailed("acct-load", "IT", false), detailed("acct-ready", "IN", true)],
    priorSnapshotAccounts: [{ id: "acct-old", name: "Old", country: "US", active: true }],
  });
  const summary = await runAccountOnboardingDiscovery({ mode: "live", now: NOW, deps: world.deps });
  ok("A: exactly ONE zero-token DataDoe GET per pass (never an export)", world.dataDoeGets === 1);
  ok("A: the loading account lands waiting_for_datadoe; the ready one is claimed into bootstrapping",
    world.rows.find((r) => r.account_id === "acct-load").status === ONBOARDING_STATUS.WAITING_FOR_DATADOE
    && world.rows.find((r) => r.account_id === "acct-ready").status === ONBOARDING_STATUS.BOOTSTRAPPING);
  ok("A: the claim used the deterministic operation id (account-bootstrap/<id>/<discoveredDate>)",
    world.claimCalls.length === 1 && world.claimCalls[0].operationId === "account-bootstrap/acct-ready/2026-09-06"
    && summary.claims[0].disposition === "claimed");
  ok("A: the directory snapshot gained BOTH accounts additively (loading AND claimed-but-not-yet-serving both show 'Setting up')",
    world.snapshotSaves.length === 1
    && world.snapshotSaves[0].reportKey === ACCOUNT_DIRECTORY_REPORT_KEY
    && world.snapshotSaves[0].accountId === ACCOUNT_DIRECTORY_ACCOUNT_ID
    && world.snapshotSaves[0].payload.accounts.length === 3
    && world.snapshotSaves[0].payload.accounts.find((a) => a.id === "acct-load").settingUp === true
    && world.snapshotSaves[0].payload.accounts.find((a) => a.id === "acct-ready").settingUp === true
    && world.snapshotSaves[0].payload.accounts.find((a) => a.id === "acct-ready").onboardingStatus === "bootstrapping");
  ok("A: the account_directory table rows carry the REGION as sync bucket",
    world.tableUpserts[0].find((r) => r.accountId === "acct-load").bucket === "europe-au"
    && world.tableUpserts[0].find((r) => r.accountId === "acct-ready").bucket === "india");

  /* ============== B. REPLAY: a second identical pass writes nothing and claims nothing ============== */
  const before = JSON.stringify(world.rows);
  const replay = await runAccountOnboardingDiscovery({ mode: "live", now: NOW + 900000, deps: world.deps });
  ok("B: replay makes ZERO upserts, ZERO claims, ZERO snapshot saves (idempotent; no duplicate operation)",
    replay.upserts === 0 && replay.claims.length === 0 && world.snapshotSaves.length === 1 && world.upsertCalls.length === 1);
  ok("B: durable rows unchanged byte-for-byte on replay", JSON.stringify(world.rows) === before);

  /* ============== C. in-progress -> ready AUTOMATICALLY starts the bootstrap ============== */
  world.accounts = [detailed("acct-load", "IT", true), detailed("acct-ready", "IN", true)];
  const flipped = await runAccountOnboardingDiscovery({ mode: "live", now: NOW + 1800000, deps: world.deps });
  ok("C: the account that finished loading was claimed automatically (waiting -> ready_for_bootstrap -> bootstrapping)",
    flipped.claims.length === 1 && flipped.claims[0].accountId === "acct-load"
    && world.rows.find((r) => r.account_id === "acct-load").status === ONBOARDING_STATUS.BOOTSTRAPPING);

  /* ============== D. evidence grading promotes bootstrapping -> partially_ready -> ready ============== */
  const world2 = makeWorld({
    accounts: [detailed("acct-load", "IT", true)],
    rows: world.rows.filter((r) => r.account_id === "acct-load"),
    evidence: { "acct-load": { oli: [{ from: "2025-01-01", to: "2026-09-05" }], presence: [] } },
  });
  await runAccountOnboardingDiscovery({ mode: "live", now: NOW + 3600000, deps: world2.deps });
  ok("D: OLI coverage alone grades bootstrapping -> partially_ready",
    world2.rows.find((r) => r.account_id === "acct-load").status === ONBOARDING_STATUS.PARTIALLY_READY);
  const world3 = makeWorld({
    accounts: [detailed("acct-load", "IT", true)],
    rows: world2.rows,
    evidence: { "acct-load": { oli: [{ from: "2025-01-01", to: "2026-09-05" }], presence: ["daily-reporting", "brand-sales"] } },
  });
  await runAccountOnboardingDiscovery({ mode: "live", now: NOW + 7200000, deps: world3.deps });
  const graduated = world3.rows.find((r) => r.account_id === "acct-load");
  ok("D: OLI + daily + brand-sales evidence graduates to READY with bootstrap_completed_at",
    graduated.status === ONBOARDING_STATUS.READY && !!graduated.bootstrap_completed_at);
})();

/* ===================== E. dry-run performs ZERO writes ===================== */
await (async () => {
  const world = makeWorld({ accounts: [detailed("acct-new", "US", true)] });
  const summary = await runAccountOnboardingDiscovery({ mode: "dry-run", now: NOW, deps: world.deps });
  ok("E: dry-run reports the planned transition + claim but writes NOTHING",
    summary.upserts === 1 && summary.claims.length === 1 && summary.claims[0].disposition === "dry-run"
    && world.upsertCalls.length === 0 && world.claimCalls.length === 0 && world.snapshotSaves.length === 0 && world.tableUpserts.length === 0);
})();

/* ===================== F. concurrency: a HELD claim is never overwritten ===================== */
await (async () => {
  const world = makeWorld({
    accounts: [detailed("acct-race", "IN", true)],
    rows: [{ account_id: "acct-race", status: ONBOARDING_STATUS.READY_FOR_BOOTSTRAP, operation_id: null, first_discovered_at: "2026-09-05T10:00:00.000Z" }],
  });
  // A concurrent worker claims between our read and our claim: the RPC model answers with the held op.
  const realClaim = world.deps.claimBootstrap;
  world.deps.claimBootstrap = async (args) => {
    const row = world.rows.find((r) => r.account_id === args.accountId);
    if (!row.operation_id) { row.operation_id = "account-bootstrap/acct-race/2026-09-05"; row.status = ONBOARDING_STATUS.BOOTSTRAPPING; return { disposition: "held", operation_id: row.operation_id, status: row.status }; }
    return realClaim(args);
  };
  const summary = await runAccountOnboardingDiscovery({ mode: "live", now: NOW, deps: world.deps });
  ok("F: a concurrent claim is respected -- ONE operation stands, ours reports 'held', nothing is overwritten",
    summary.claims.length === 1 && summary.claims[0].disposition === "held"
    && world.rows[0].operation_id === "account-bootstrap/acct-race/2026-09-05");
})();

/* ===================== G. table unavailable => typed fail-closed BEFORE any write ===================== */
await (async () => {
  const world = makeWorld({ accounts: [detailed("a", "IN", true)] });
  world.deps.readOnboardingRows = async () => null;
  let message = "";
  try { await runAccountOnboardingDiscovery({ mode: "live", now: NOW, deps: world.deps }); }
  catch (e) { message = String(e.message); }
  ok("G: an unreadable onboarding table fails closed with the typed code and ZERO writes",
    message.includes("ONBOARDING_TABLE_UNAVAILABLE") && world.upsertCalls.length === 0 && world.snapshotSaves.length === 0);
})();

/* ===================== H. structural zero-export + canonical-key pins ===================== */
(() => {
  ok("H: the literal source keys pin to their canonical exports",
    OLI_SOURCE_KEY === "order-line-items" && CAMPAIGN_ADS_GRAIN === "campaign-performance-v1");
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const src = readFileSync(path.join(root, "lib/server/sync/account-onboarding-discovery.js"), "utf8");
  for (const banned of ["createExport", "fetchExportRows", "source-worker", "source-sync-driver", "runSourceJobs"]) {
    ok(`H: the worker module never references ${banned} (structurally zero-export)`, !src.includes(banned));
  }
  ok("H: evidence report keys include the two primary sales surfaces",
    ONBOARDING_EVIDENCE_REPORT_KEYS.includes("daily-reporting") && ONBOARDING_EVIDENCE_REPORT_KEYS.includes("brand-sales"));
  ok("H: material-change detector ignores checkedAt-only drift (idempotent passes write nothing)",
    onboardingRowMateriallyChanged(
      { status: "ready", sources: { oli: { status: "covered", coveredTo: "2026-09-05", checkedAt: "T1" } } },
      { status: "ready", sources: { oli: { status: "covered", coveredTo: "2026-09-05", checkedAt: "T2" } } },
    ) === false);
})();

writeSync(1, `\naccount-onboarding-worker: ${passed} assertions passed\n`);
