// The onboarding DISCOVERY worker -- orchestration, atomic claims, REGION-LOCAL immutable waves, the
// APPEND-ONLY dispatch ledger (one active execution per region; a new wave never overwrites a
// queued/running/failed/completed wave), the WAVE-BOUND awaiting-budget hold, the lease + ACK lifecycle,
// idempotent replay, structural zero-export. Fully offline (the lease/ack RPCs are modelled with the
// migration's exact append-only semantics). 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  runAccountOnboardingDiscovery, onboardingRowMateriallyChanged,
  ONBOARDING_EVIDENCE_REPORT_KEYS, ACCOUNT_DIRECTORY_REPORT_KEY, ACCOUNT_DIRECTORY_ACCOUNT_ID,
} from "../lib/server/sync/account-onboarding-discovery.js";
import { ONBOARDING_STATUS, computeOnboardingWaveIdentity } from "../lib/server/sync/account-onboarding.js";
import { OLI_SOURCE_KEY } from "../lib/server/sync/source-durable-model.js";
import { CAMPAIGN_ADS_GRAIN } from "../lib/server/sync/scheduled-campaign-ads-runner.js";

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); };
writeSync(1, "account-onboarding-worker\n");

const NOW = Date.parse("2026-09-06T12:00:00Z");
const MIN = 60_000;
const detailed = (id, country, ready) => ({
  id, name: `A ${id}`, country, countryName: country, currency: "USD", locale: "en-US", timeZone: "UTC",
  readiness: { sellerCentralReady: ready, rowCount: 10, sellerCentralRowCount: 5, adsConnected: true, adsReady: ready, adsRowCount: 3, accountType: "SELLER", marketplaceId: "M1" },
});
const expectId = (rows, region) => computeOnboardingWaveIdentity(rows, region).dispatchId;
const expectKey = (rows, region) => computeOnboardingWaveIdentity(rows, region).waveKey;

// In-memory durable store with the APPEND-ONLY dispatch ledger keyed by `${region}|${dispatch_id}` and a
// partial "one active execution per region" invariant, modelling the migration RPCs exactly.
function makeWorld({ accounts, rows = [], priorSnapshotAccounts = [], evidence = {}, budgetMode = "authorize-all" } = {}) {
  const world = {
    accounts, rows: rows.map((r) => ({ ...r })),
    snapshotAccounts: priorSnapshotAccounts.map((a) => ({ ...a })),
    dispatchTable: new Map(), // `${region}|${dispatch_id}` -> { region, dispatch_id, wave_key, status, attempts, next_retry_at(ms), last_error, account_ids, operation_ids }
    budgets: new Map(),
    budgetMode,
    now: NOW,
    upsertCalls: [], claimCalls: [], snapshotSaves: [], tableUpserts: [], dispatches: [],
    budgetReads: [], awaitingBudgetCalls: [],
    dataDoeGets: 0,
  };
  const backoffMs = (attempts) => Math.min(30 * MIN * 2 ** attempts, 360 * MIN);
  const key = (region, dispatchId) => `${region}|${dispatchId}`;
  const regionRows = (region) => [...world.dispatchTable.values()].filter((r) => r.region === region);
  const activeIn = (region, exceptDispatchId) => regionRows(region).find((r) => r.dispatch_id !== exceptDispatchId && ["queued", "running"].includes(r.status));
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
      row.bootstrap_started_at = new Date(world.now).toISOString();
      return { disposition: "claimed", operation_id: operationId, status: "bootstrapping" };
    },
    readBudget: async (waveKey) => {
      world.budgetReads.push(waveKey);
      if (world.budgetMode === "authorize-all") return { budget_key: waveKey, status: "authorized", plan_fingerprint: "fp-test" };
      return world.budgets.get(waveKey) || null;
    },
    // mark_onboarding_dispatch_awaiting_budget: append-only per (region, dispatch_id); never regresses a
    // later state; never touches another wave's row.
    markAwaitingBudget: async ({ region, dispatchId, waveKey, accountIds, operationIds }) => {
      world.awaitingBudgetCalls.push({ region, dispatchId });
      const existing = world.dispatchTable.get(key(region, dispatchId));
      if (existing) { if (existing.status !== "awaiting-budget") return { disposition: "unchanged", status: existing.status }; return { disposition: "awaiting-budget", dispatch_id: dispatchId }; }
      world.dispatchTable.set(key(region, dispatchId), { region, dispatch_id: dispatchId, wave_key: waveKey, status: "awaiting-budget", attempts: 0, next_retry_at: null, last_error: null, account_ids: accountIds, operation_ids: operationIds });
      return { disposition: "awaiting-budget", dispatch_id: dispatchId };
    },
    // lease_onboarding_dispatch: append-only; one active per region; this wave's own not-due window; a NEW
    // wave APPENDS a row (never overwrites another).
    leaseDispatch: async ({ region, dispatchId, waveKey, accountIds, operationIds }) => {
      const row = world.dispatchTable.get(key(region, dispatchId));
      if (row && row.status === "completed") return { disposition: "completed", dispatch_id: dispatchId };
      if (row && ["queued", "running", "failed"].includes(row.status) && row.next_retry_at != null && row.next_retry_at > world.now) {
        return { disposition: "not-due", dispatch_id: dispatchId, status: row.status, attempts: row.attempts, next_retry_at: row.next_retry_at };
      }
      const other = activeIn(region, dispatchId);
      if (other) {
        if (other.next_retry_at != null && other.next_retry_at > world.now) return { disposition: "region-busy", dispatch_id: dispatchId, active_dispatch_id: other.dispatch_id, active_status: other.status };
        other.status = "failed"; other.last_error = "LEASE_EXPIRED_SUPERSEDED";
      }
      if (row) {
        if (row.wave_key !== waveKey) return { disposition: "refused", reason: "WAVE_IDENTITY_MISMATCH", dispatch_id: dispatchId };
        row.attempts += 1; row.status = "queued"; row.next_retry_at = world.now + backoffMs(row.attempts - 1);
        return { disposition: "leased", dispatch_id: dispatchId, attempts: row.attempts };
      }
      world.dispatchTable.set(key(region, dispatchId), { region, dispatch_id: dispatchId, wave_key: waveKey, status: "queued", attempts: 1, next_retry_at: world.now + 30 * MIN, last_error: null, account_ids: accountIds, operation_ids: operationIds });
      return { disposition: "leased", dispatch_id: dispatchId, attempts: 1 };
    },
    recordDispatchError: async ({ region, dispatchId, error }) => {
      const row = world.dispatchTable.get(key(region, dispatchId));
      if (row) row.last_error = error;
      return { disposition: "recorded" };
    },
    completeDispatch: async ({ region, dispatchId }) => {
      const row = world.dispatchTable.get(key(region, dispatchId));
      if (row) row.status = "completed";
      return { disposition: "completed" };
    },
    readDispatchRows: async () => [...world.dispatchTable.values()].map((r) => ({ ...r })),
    dispatchBootstrapRun: async ({ region, dispatchId }) => { world.dispatches.push({ region, dispatchId }); },
    readOliCoverage: async (accountId) => ({ read: "ok", windows: evidence[accountId]?.oli || [] }),
    readSnapshotPresence: async ({ accountIds }) => accountIds.flatMap((id) => (evidence[id]?.presence || []).map((reportKey) => ({ accountId: id, reportKey }))),
    readCampaignCoverage: async (accountId) => ({ read: "ok", windows: evidence[accountId]?.campaign || [] }),
    readDirectorySnapshot: async () => ({ payload: { accounts: world.snapshotAccounts.map((a) => ({ ...a })) } }),
    saveDirectorySnapshot: async (snapshot) => { world.snapshotSaves.push(snapshot); world.snapshotAccounts = snapshot.payload.accounts.map((a) => ({ ...a })); },
    upsertDirectoryTable: async (rows) => { world.tableUpserts.push(rows); },
    paramsHashFor: (version, params) => `hash:${version}:${JSON.stringify(params)}`,
  };
  world.ack = (region, dispatchId, phase) => {
    const row = world.dispatchTable.get(key(region, dispatchId));
    if (!row) return { disposition: "not-found" };
    if (row.status === "completed") return { disposition: "already-completed" };
    if (phase === "running") { row.status = "running"; row.next_retry_at = world.now + 180 * MIN; return { disposition: "acked", status: "running" }; }
    if (phase === "completed") { row.status = "completed"; row.last_error = null; return { disposition: "acked", status: "completed" }; }
    row.status = "failed"; row.next_retry_at = world.now + backoffMs(Math.max(row.attempts, 1) - 1);
    return { disposition: "acked", status: "failed" };
  };
  world.rowFor = (region, dispatchId) => world.dispatchTable.get(key(region, dispatchId));
  world.run = (mode, now) => { world.now = now; return runAccountOnboardingDiscovery({ mode, now, deps: world.deps }); };
  return world;
}

/* ===================== A. first pass: loading stays waiting; ready-but-new is claimed + leased + dispatched ===================== */
await (async () => {
  const world = makeWorld({
    accounts: [detailed("acct-load", "IT", false), detailed("acct-ready", "IN", true)],
    priorSnapshotAccounts: [{ id: "acct-old", name: "Old", country: "US", active: true }],
  });
  const summary = await world.run("live", NOW);
  const indiaId = expectId(world.rows, "india");
  ok("A: exactly ONE zero-token DataDoe GET per pass (never an export)", world.dataDoeGets === 1);
  ok("A: the loading account lands waiting_for_datadoe; the ready one is claimed into bootstrapping",
    world.rows.find((r) => r.account_id === "acct-load").status === ONBOARDING_STATUS.WAITING_FOR_DATADOE
    && world.rows.find((r) => r.account_id === "acct-ready").status === ONBOARDING_STATUS.BOOTSTRAPPING);
  ok("A: the fresh claim LEASED + dispatched ONE bootstrap run under the REGION-LOCAL wave identity",
    world.dispatches.length === 1 && world.dispatches[0].region === "india"
    && indiaId != null && world.dispatches[0].dispatchId === indiaId
    && summary.bootstrapDispatches.find((b) => b.region === "india").outcome === "dispatched");
  ok("A: the dispatch row stores the IMMUTABLE wave scope (wave_key + account_ids + operation_ids)",
    world.rowFor("india", indiaId).wave_key === expectKey(world.rows, "india")
    && JSON.stringify(world.rowFor("india", indiaId).account_ids) === JSON.stringify(["acct-ready"])
    && world.rowFor("india", indiaId).operation_ids.length === 1);
  ok("A: the budget was read for EXACTLY the region-local wave key",
    world.budgetReads.includes(expectKey(world.rows, "india")));
  ok("A: the LOADING account's region got NO dispatch (in-progress accounts spend nothing)",
    !world.dispatches.some((x) => x.region === "europe-au"));
  ok("A: the accepted dispatch is durably QUEUED (a 204 is not an acknowledgement)",
    world.rowFor("india", indiaId).status === "queued");
  ok("A: the directory snapshot gained BOTH accounts additively (both show 'Setting up')",
    world.snapshotSaves.length === 1 && world.snapshotSaves[0].payload.accounts.length === 3
    && world.snapshotSaves[0].payload.accounts.find((a) => a.id === "acct-load").settingUp === true
    && world.snapshotSaves[0].payload.accounts.find((a) => a.id === "acct-ready").onboardingStatus === "bootstrapping");

  /* ============== B. replay + running-ack + failed-retry all under the SAME region-local wave ============== */
  const replay = await world.run("live", NOW + 15 * MIN);
  ok("B: replay makes ZERO extra dispatches (not-due; no 15-minute spam)",
    world.dispatches.length === 1 && replay.bootstrapDispatches.find((b) => b.region === "india").outcome === "not-due");
  world.now = NOW + 20 * MIN; world.ack("india", indiaId, "running");
  const whileRunning = await world.run("live", NOW + 45 * MIN);
  ok("B: an acknowledged RUNNING run extends the lease horizon -- no duplicate dispatch while it lives",
    world.dispatches.length === 1 && whileRunning.bootstrapDispatches.find((b) => b.region === "india").outcome === "not-due"
    && world.rowFor("india", indiaId).status === "running");
  world.now = NOW + 50 * MIN; world.ack("india", indiaId, "failed");
  const retried = await world.run("live", NOW + 90 * MIN);
  ok("B: after the bounded backoff the SAME wave id is re-leased + redispatched (attempts=2)",
    retried.bootstrapDispatches.find((b) => b.region === "india").outcome === "dispatched"
    && world.rowFor("india", indiaId).attempts === 2 && world.dispatches[1].dispatchId === indiaId);
})();

/* ===================== R2. a Europe claim while India is running leaves India UNCHANGED (region-local) ===================== */
await (async () => {
  const world = makeWorld({
    accounts: [detailed("in-1", "IN", true), detailed("eu-1", "DE", true)],
    rows: [{ account_id: "in-1", status: ONBOARDING_STATUS.BOOTSTRAPPING, operation_id: "account-bootstrap/in-1/2026-09-05", bootstrap_started_at: "2026-09-05T10:00:00.000Z", region: "india", first_discovered_at: "2026-09-05T10:00:00.000Z" }],
  });
  // India already dispatched + running.
  const indiaId = expectId(world.rows, "india");
  const s1 = await world.run("live", NOW);
  world.ack("india", indiaId, "running");
  const indiaBefore = JSON.stringify(world.rowFor("india", indiaId));
  // Now Europe's account is discovered-ready (already has an onboarding row via upsert path) -> claimed.
  world.rows.push({ account_id: "eu-1", status: ONBOARDING_STATUS.READY_FOR_BOOTSTRAP, region: "europe-au", first_discovered_at: "2026-09-06T00:00:00.000Z", operation_id: null });
  const s2 = await world.run("live", NOW + 10 * MIN);
  ok("R2: the Europe account is claimed + dispatched under ITS OWN region-local wave",
    s2.claims.some((c) => c.accountId === "eu-1") && world.dispatches.some((x) => x.region === "europe-au"));
  ok("R2: India's dispatch row (identity, budget key, attempts, status) is BYTE-IDENTICAL -- a Europe claim never touched it",
    JSON.stringify(world.rowFor("india", indiaId)) === indiaBefore
    && world.rowFor("india", indiaId).status === "running");
  ok("R2: India's wave id did NOT change when Europe joined (region-local membership)",
    expectId(world.rows, "india") === indiaId);
})();

/* ===================== R3. a NEW wave does not overwrite an active dispatch row (append-only) ===================== */
await (async () => {
  const world = makeWorld({
    accounts: [detailed("us-1", "US", true)],
    rows: [{ account_id: "us-1", status: ONBOARDING_STATUS.BOOTSTRAPPING, operation_id: "account-bootstrap/us-1/2026-09-05", bootstrap_started_at: "2026-09-05T10:00:00.000Z", region: "us-ca", first_discovered_at: "2026-09-05T10:00:00.000Z" }],
  });
  const firstId = expectId(world.rows, "us-ca");
  await world.run("live", NOW);
  world.ack("us-ca", firstId, "running");
  // A second us-ca account is claimed -> the region's wave membership changes -> a NEW dispatch id.
  world.accounts = [detailed("us-1", "US", true), detailed("us-2", "US", true)];
  world.rows.push({ account_id: "us-2", status: ONBOARDING_STATUS.READY_FOR_BOOTSTRAP, region: "us-ca", first_discovered_at: "2026-09-06T00:00:00.000Z", operation_id: null });
  const s2 = await world.run("live", NOW + 10 * MIN);
  const secondId = expectId(world.rows, "us-ca");
  ok("R3: the grown membership mints a DIFFERENT us-ca dispatch id", secondId !== firstId);
  ok("R3: the ORIGINAL running wave row still exists (append-only; never overwritten)",
    world.rowFor("us-ca", firstId) != null && world.rowFor("us-ca", firstId).status === "running"
    && JSON.stringify(world.rowFor("us-ca", firstId).account_ids) === JSON.stringify(["us-1"]));
  ok("R3: the NEW wave is HELD (region-busy) while the first is still running (one active execution per region)",
    s2.bootstrapDispatches.find((b) => b.region === "us-ca").outcome === "region-busy"
    && !world.dispatchTable.has(`us-ca|${secondId}`) || (world.rowFor("us-ca", secondId) && world.rowFor("us-ca", secondId).status !== "queued"));
  ok("R3: NO second dispatch was issued while the region is busy", world.dispatches.length === 1);
})();

/* ===================== E2. BUDGET HOLD: no authorized budget => durable awaiting-budget, ZERO dispatches ===================== */
await (async () => {
  const world = makeWorld({ accounts: [detailed("acct-new", "US", true)], budgetMode: "table" });
  const held = await world.run("live", NOW);
  const waveKey = expectKey(world.rows, "us-ca");
  const usId = expectId(world.rows, "us-ca");
  ok("E2: the claim proceeds but the wave is HELD awaiting-budget (zero dispatches/leases)",
    held.claims[0].disposition === "claimed"
    && held.bootstrapDispatches[0].outcome === "awaiting-budget"
    && world.dispatches.length === 0 && world.rowFor("us-ca", usId).status === "awaiting-budget");
  ok("E2: the held row records the IMMUTABLE wave scope + key",
    world.rowFor("us-ca", usId).wave_key === waveKey && JSON.stringify(world.rowFor("us-ca", usId).account_ids) === JSON.stringify(["acct-new"]));
  world.budgets.set(waveKey, { budget_key: waveKey, status: "authorized", plan_fingerprint: "fp-approved" });
  const released = await world.run("live", NOW + 60 * MIN);
  ok("E2: once the EXACT wave is authorized, the next pass leases + dispatches it (attempt 1)",
    released.bootstrapDispatches[0].outcome === "dispatched" && world.dispatches.length === 1
    && world.rowFor("us-ca", usId).status === "queued" && world.rowFor("us-ca", usId).attempts === 1);
})();

/* ===================== D. graduation completion; terminal thereafter ===================== */
await (async () => {
  const evidenceFull = { "acct-ready": { oli: [{ from: "2025-01-01", to: "2026-09-05" }], presence: ["daily-reporting", "brand-sales"] } };
  const rows = [{ account_id: "acct-ready", status: ONBOARDING_STATUS.BOOTSTRAPPING, operation_id: "account-bootstrap/acct-ready/2026-09-05", bootstrap_started_at: "2026-09-05T10:00:00.000Z", region: "india", first_discovered_at: "2026-09-05T10:00:00.000Z" }];
  const world = makeWorld({ accounts: [detailed("acct-ready", "IN", true)], rows, evidence: evidenceFull });
  const soloId = expectId(world.rows, "india");
  world.dispatchTable.set(`india|${soloId}`, { region: "india", dispatch_id: soloId, wave_key: expectKey(world.rows, "india"), status: "running", attempts: 2, next_retry_at: NOW + 500 * MIN, last_error: null, account_ids: ["acct-ready"], operation_ids: ["account-bootstrap/acct-ready/2026-09-05"] });
  const graduated = await world.run("live", NOW + 120 * MIN);
  ok("D: full evidence graduates the account to READY", world.rows[0].status === ONBOARDING_STATUS.READY);
  ok("D: the wave is COMPLETED only because EVERY wave account GRADUATED (durable evidence -- never mere absence)",
    world.rowFor("india", soloId).status === "completed"
    && graduated.bootstrapDispatches.find((b) => b.region === "india").outcome === "completed");
  const after = await world.run("live", NOW + 180 * MIN);
  ok("D: completion is TERMINAL -- later passes never dispatch the completed wave again",
    world.dispatches.length === 0 && !after.bootstrapDispatches.some((b) => b.region === "india"));

  // A BLOCKED account is NOT graduation-completed.
  const world2 = makeWorld({ accounts: [detailed("acct-b", "IN", true)], rows: [{ account_id: "acct-b", status: ONBOARDING_STATUS.BLOCKED, region: "india", operation_id: "account-bootstrap/acct-b/2026-09-05", failure_code: "X", first_discovered_at: "2026-09-05T10:00:00.000Z" }] });
  world2.dispatchTable.set("india|onboarding-bootstrap/india/deadbeefdeadbeef", { region: "india", dispatch_id: "onboarding-bootstrap/india/deadbeefdeadbeef", wave_key: "onboarding-wave/india/x", status: "failed", attempts: 1, next_retry_at: NOW + 500 * MIN, last_error: "x", account_ids: ["acct-b"], operation_ids: [] });
  await world2.run("live", NOW + 120 * MIN);
  ok("D: a wave whose account is BLOCKED (not graduated) is NOT completed (stays open for review)",
    world2.rowFor("india", "onboarding-bootstrap/india/deadbeefdeadbeef").status !== "completed");
})();

/* ===================== E. dry-run performs ZERO writes ===================== */
await (async () => {
  const world = makeWorld({ accounts: [detailed("acct-new", "US", true)] });
  const summary = await world.run("dry-run", NOW);
  ok("E: dry-run reports the planned claim + dispatch but writes/calls NOTHING",
    summary.claims[0].disposition === "dry-run" && summary.bootstrapDispatches[0].outcome === "dry-run"
    && world.upsertCalls.length === 0 && world.claimCalls.length === 0 && world.dispatches.length === 0 && world.dispatchTable.size === 0);
})();

/* ===================== F. dispatch API failure -> lease holds -> retry after backoff ===================== */
await (async () => {
  const world = makeWorld({ accounts: [detailed("acct-new", "US", true)] });
  world.deps.dispatchBootstrapRun = async () => { throw new Error("api down"); };
  const s1 = await world.run("live", NOW);
  const usId = expectId(world.rows, "us-ca");
  ok("F: dispatch API failure is typed + fail-soft; the claim stands; the lease records the error",
    s1.claims[0].disposition === "claimed" && s1.bootstrapDispatches[0].outcome === "dispatch-failed"
    && world.rowFor("us-ca", usId).last_error === "api down");
  world.deps.dispatchBootstrapRun = async ({ region, dispatchId }) => { world.dispatches.push({ region, dispatchId }); };
  const s3 = await world.run("live", NOW + 31 * MIN);
  ok("F: the pass AFTER the backoff RETRIES and succeeds (attempts=2; same wave id)",
    s3.bootstrapDispatches[0].outcome === "dispatched" && world.rowFor("us-ca", usId).attempts === 2);
})();

/* ===================== H. table unavailable => typed fail-closed BEFORE any write ===================== */
await (async () => {
  const world = makeWorld({ accounts: [detailed("a", "IN", true)] });
  world.deps.readOnboardingRows = async () => null;
  let message = "";
  try { await world.run("live", NOW); } catch (e) { message = String(e.message); }
  ok("H: an unreadable onboarding table fails closed with the typed code and ZERO writes",
    message.includes("ONBOARDING_TABLE_UNAVAILABLE") && world.upsertCalls.length === 0 && world.dispatches.length === 0);
})();

/* ===================== I. structural zero-export + canonical-key pins ===================== */
(() => {
  ok("I: the literal source keys pin to their canonical exports",
    OLI_SOURCE_KEY === "order-line-items" && CAMPAIGN_ADS_GRAIN === "campaign-performance-v1");
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const src = readFileSync(path.join(root, "lib/server/sync/account-onboarding-discovery.js"), "utf8");
  for (const banned of ["createExport", "fetchExportRows", "source-worker", "source-sync-driver", "runSourceJobs"]) {
    ok(`I: the worker module never references ${banned} (structurally zero-export)`, !src.includes(banned));
  }
  ok("I: the worker never imports the bootstrap transport module (stays structurally zero-export)",
    !src.includes("account-onboarding-bootstrap"));
  ok("I: evidence report keys include the two primary sales surfaces",
    ONBOARDING_EVIDENCE_REPORT_KEYS.includes("daily-reporting") && ONBOARDING_EVIDENCE_REPORT_KEYS.includes("brand-sales"));
  ok("I: material-change detector ignores checkedAt-only drift (idempotent passes write nothing)",
    onboardingRowMateriallyChanged(
      { status: "ready", sources: { oli: { status: "covered", coveredTo: "2026-09-05", checkedAt: "T1" } } },
      { status: "ready", sources: { oli: { status: "covered", coveredTo: "2026-09-05", checkedAt: "T2" } } },
    ) === false);
  const yml = readFileSync(path.join(root, "../.github/workflows/account-onboarding.yml"), "utf8");
  ok("I: the worker cadence is */30", yml.includes('- cron: "*/30 * * * *"'));
  ok("I: the dispatched run carries run_scope=bootstrap", /run_scope["']?\s*:\s*["']bootstrap["']/.test(src));
})();

writeSync(1, `\naccount-onboarding-worker: ${passed} assertions passed\n`);
