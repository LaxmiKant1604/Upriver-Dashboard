// WP16 -- Listing Health v3 natural ingestion: TERMINAL-CYCLE REPLAY + REFUSED-SHADOW semantics (no acquisition change).
//
// Reproduces the two proven production failures of the natural scheduler `listing-health-v3` job and proves the fix:
//   (a) us-ca 2026-09-24: the dedicated base cycle was ALREADY terminal (finalized by an earlier owner-authorized
//       Listings-only ingestion); the old path ran runSources/materialize/runReports BEFORE finalize and runReports hit
//       "sync cycle ... is terminal (succeeded); refusing to append/alter child work". Now a terminal base cycle is
//       decided read-only up front: ZERO appends, ZERO exports, each account PROVEN already-current or a typed failure.
//   (b) india 2026-09-25: one account's natural shadow save failed (SNAPSHOT_SAVE_FAILED) after the zero-export
//       reconciler had published -> reportFailed=1 -> partial -> exit 1. Now that account counts as already-current
//       ONLY with content identity + lineage + live/served read-back, else a real 'shadow-refused:<check>' failure.
// The proof runs over the REAL shared primitives: the REAL listing-health-v3 derivation (a genuinely derived payload),
// the REAL live contract + paramsHashFor, the REAL publisher read-back (buildLiveReadback), the REAL served selector
// (selectLhv3) and the REAL evaluatePublicationBinding -- only the durable readers are in-memory fakes. Offline; ZERO
// network / DB / DataDoe. 7-bit ASCII, LF.
// WP16 fixer sections: E the serve-gate ATTESTATION (LHV3_SERVE_GATE_ATTESTED; literal Vercel flag names never read);
// F the GITHUB_OUTPUT lhv3_phase + lhv3_durable_persisted lines; G the long-lived pg client ('error' listened +
// memoized, timeouts); H the documented terminal-path limitation (materialize never runs there); I the CLI's
// resolveBundle parity with the reconciler + the wall-clock UTC D-1 served check.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test-service-role";

import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import {
  runListingHealthV3Ingestion, buildListingHealthV3Plan, buildListingHealthV3AlreadyCurrentProof, LHV3_ALREADY_CURRENT_CHECKS,
  lhv3ServeEnvFromAttestation, LHV3_SERVE_GATE_ATTESTATION_VAR, lhv3IngestionGithubOutputs, buildLhv3ReadOnlyPgReader,
} from "../lib/server/sync/listing-health-v3-operation.js";
import { readListingHealthV3Authorization } from "../lib/server/sync/listing-health-v3-authorization.js";
import { materializeListingHealthV3PerAccount } from "../lib/server/sync/listing-health-v3-materialize.js";
import { planListingHealthV3BucketBatched } from "../lib/server/sync/report-planner.js";
import { deriveReportSnapshot, REPORT_DERIVATIONS } from "../lib/server/sync/report-derivation.js";
import { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } from "../lib/server/sync/report-publisher.js";
import { buildLiveReadback } from "../lib/server/sync/source-priority-release-runner.js";
import { selectLhv3 } from "../lib/server/recovery/serve-selectors.js";
import { paramsHashFor } from "../lib/server/report-store.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "listing-health-v3-replay-and-refusal\n");

const REGION = "us-ca";
const CYCLE = "2026-09-24";
const connections = [{ id: "primary", apiKey: "fixture-key", accountPrefix: "" }];
const ACCTS = ["acct-00", "acct-01"];
const usAccounts = ACCTS.map((id, i) => ({ accountId: id, country: "US", currency: "USD", name: `A${i}` }));
const BASE_CYCLE_ID = "11111111-1111-4111-8111-111111111111";
const PP_CYCLE_ID = "22222222-2222-4222-8222-222222222222";
const STAMP = "2026-09-24T07:14:00+00:00";
const LIVE = SCHEDULER_LIVE_SNAPSHOT_CONTRACTS["listing-health-v3"];
const SHADOW_VERSION = REPORT_DERIVATIONS["listing-health-v3"].snapshotVersion;
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---- a GENUINE derived listing-health-v3 payload per account (same fixture shape as the fingerprint-invariant test) ----
const listingRow = (seller, sku, price) => ({ seller_or_vendor_id: seller, marketplace_country_code: "US", sku, child_asin: `ASIN-${sku}`, listing_name: `L ${sku}`, listing_status: "Active", listing_price_value: price, listing_price_currency: "USD", listing_current_quantity: 0, fba_quantity_available: 0, listing_fulfillment_channel: "AMAZON_NA", listing_open_date: "2024-01-01" });
const rawRow = (seller, sku, price) => ({ seller_or_vendor_id: seller, marketplace_country_code: "US", sku, child_asin: `ASIN-${sku}`, summaries: J({ status: ["BUYABLE"] }), issues: J([]), offers: J([{ price: { amount: price } }]) });
const noDate = (rk, rows, seller) => ({ available: true, rows, fragments: [{ requestKey: rk, from: null, to: null, sellerOrVendorIds: [seller], rows }], disabled: false, disabledPolicy: null, reason: null });
function derivePayload(acct, price = 25) {
  const sources = {
    "listing-health-v3:listings": noDate("listing-health-v3:listings", [listingRow(acct, "A", price)], acct),
    "listing-health-v3:listings-raw": noDate("listing-health-v3:listings-raw", [rawRow(acct, "A", price)], acct),
    "listing-health-v3:inventory": { available: false },
  };
  const context = {
    to: CYCLE, inventoryAsOf: CYCLE, accountId: acct, rawSellerId: acct, marketCountry: "US",
    listingHealthV3DurableOli: { available: true, rows: [{ account_id: acct, sale_date: "2026-09-20", sku: "A", child_asin: "ASIN-A", currency: "USD", sales_amount: 10, ordered_units: 1, unpriced_units: 0 }], coverageWindows: [{ from: "2024-01-01", to: CYCLE }], completenessRows: [] },
    listingHealthV3DurableCatalog: { available: true, rows: [{ child_asin: "ASIN-A", product_name: "P A", product_brand: "BrandX" }] },
  };
  const r = deriveReportSnapshot({ reportKey: "listing-health-v3", sources, context });
  assert.equal(r.status, "derived", "fixture must derive (got " + r.status + " / " + (r.reason || "") + ")");
  return r.payload;
}

// ---- an in-memory durable world: what the zero-export reconciler published for each account ----
// Each account: the durable evidence identity (manifest token + Listings/Raw content shas), ONE promotable publication job
// in a priority-partial cycle carrying that manifest, its scheduler-v2 shadow, and the promoted live row (equal payload +
// equal stamp). Every dimension is overridable per account to model the failure shapes.
function makeWorld(over = {}) {
  const snapshots = new Map(); // reportKey|accountId|paramsHash -> row
  const put = (row) => snapshots.set(`${row.report_key}|${row.account_id}|${row.params_hash}`, row);
  const bundles = new Map();
  const jobs = new Map();
  const reads = { bundle: 0, job: 0, snapshot: 0, jobArgs: [] };
  for (const acct of ACCTS) {
    const o = over[acct] || {};
    const payload = derivePayload(acct);
    const shadowParams = { reportVersion: SHADOW_VERSION, accountId: acct, to: o.shadowTo || CYCLE };
    const shadowHash = paramsHashFor(SHADOW_VERSION, shadowParams);
    put({ id: "s-" + acct, report_key: "scheduler-v2/listing-health-v3", account_id: acct, params_hash: shadowHash, params: shadowParams, payload: clone(payload), payload_storage_path: null, source_refreshed_at: STAMP, updated_at: STAMP });
    const liveParams = LIVE.liveParams({ to: o.shadowTo || CYCLE });
    const liveHash = paramsHashFor(LIVE.liveReportVersion, liveParams);
    if (!o.noLive) {
      put({ id: "l-" + acct, report_key: LIVE.liveReportKey, account_id: acct, params_hash: liveHash, params: { reportVersion: LIVE.liveReportVersion, ...liveParams }, payload: o.livePayload ? o.livePayload(clone(payload)) : clone(payload), payload_storage_path: null, source_refreshed_at: o.liveStamp || STAMP, updated_at: o.liveStamp || STAMP });
    }
    bundles.set(acct, o.bundle || { eligible: true, status: "available", revisionId: "rev-" + acct, deps: [], contentDeps: ["manifest-" + acct], bundle: { listingsSnapshot: { payload_sha: "sha-l-" + acct }, rawSnapshot: { payload_sha: "sha-r-" + acct } } });
    jobs.set(acct, o.job === null ? null : {
      id: "job-" + acct, cycleId: PP_CYCLE_ID, reportKey: "listing-health-v3", accountId: acct,
      deriveStatus: "succeeded", saveStatus: "succeeded", validated: true, cycleStatus: "succeeded",
      snapshotParamsHash: shadowHash, dependsOn: ["req-l-" + acct, "req-r-" + acct], durableContentDeps: ["manifest-" + acct],
      ...(o.job || {}),
    });
  }
  const getReportSnapshot = async ({ reportKey, accountId, paramsHash }) => { reads.snapshot += 1; return snapshots.get(`${reportKey}|${accountId}|${paramsHash}`) || null; };
  const loadStoragePayload = async () => null;
  const readback = buildLiveReadback({ getReportSnapshot, loadStoragePayload, liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, reportDerivations: REPORT_DERIVATIONS, computeHash: paramsHashFor });
  // The dashboard's served selection for the UTC D-1 the page resolves (now = the day after the cycle date).
  const serveEnv = over.serveEnv || { LHV3_PUBLISH_LIVE: "true", LISTING_HEALTH_V3: "true" };
  const nowMs = over.nowMs != null ? over.nowMs : Date.parse(CYCLE + "T12:00:00.000Z") + 86400000;
  const prove = buildListingHealthV3AlreadyCurrentProof({
    resolveBundle: async ({ accountId }) => { reads.bundle += 1; if (over.bundleThrows) throw new Error("durable read failed"); return bundles.get(accountId) || { eligible: false, reason: "no-durable-snapshot" }; },
    readPublicationJob: over.readPublicationJob || (async ({ accountId, excludeCycleId }) => {
      reads.job += 1; reads.jobArgs.push({ accountId, excludeCycleId });
      if (over.jobThrows) throw new Error("pg down");
      const j = jobs.get(accountId);
      return j && j.cycleId !== excludeCycleId ? j : null;
    }),
    readSnapshot: getReportSnapshot,
    loadStoragePayload,
    verifyLiveReadback: readback,
    selectServed: ({ accountId }) => selectLhv3({ accountId, env: serveEnv, now: () => nowMs, readers: { getReportSnapshot }, computeHash: paramsHashFor, contract: LIVE, prove: (row) => readback({ reportKey: "listing-health-v3", liveReportKey: LIVE.liveReportKey, accountId, paramsHash: row.params_hash }) }),
    liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, computeHash: paramsHashFor, reportDerivations: REPORT_DERIVATIONS,
  });
  return { prove, reads, snapshots, jobs, bundles };
}

// ---- LIVE operator collaborators (a clean us-ca run by default) with call counters for every append / export path ----
function live({
  base = { id: BASE_CYCLE_ID, status: "running" },
  sourceOut = { drained: true, creates: 0, tokens: 0, inventoryCreated: false },
  matOut = null,
  reportOut = { succeeded: 2, blocked: 0, failed: 0, drained: true },
  finalize = { disposition: "finalized", status: "succeeded", cycleId: BASE_CYCLE_ID },
  cycleJobs = null,
  world = makeWorld(),
  wp16 = true,
} = {}) {
  const calls = { runSources: 0, materialize: 0, runReports: 0, finalizeCycle: 0, checkBalance: 0, freezeBudget: 0, readFrozenBudget: 0, readAuthorization: 0, readBaseCycle: 0, readCycleJobs: 0 };
  const events = [];
  const collab = {
    calls, events, world,
    discoverAccounts: async () => usAccounts,
    buildPlan: (args) => buildListingHealthV3Plan(args),
    resolveCost: async () => ({ newExports: 2, reusedExports: 1, creates: 0, estimatedTokens: 0, inventoryAdoptable: true, anyInventoryAdoptable: true, inventoryAdoptableCount: 1, inventoryAdoptableByHash: {} }),
    checkBalance: async () => { calls.checkBalance += 1; return { usable: 1000 }; },
    readAuthorization: async (a) => { calls.readAuthorization += 1; return readListingHealthV3Authorization(a); },
    freezeBudget: async () => { calls.freezeBudget += 1; return { planFingerprint: "fp-test", maxCreates: 2, maxTokens: 4, hashes: [{ requestHash: "h1", tokenCost: 2 }, { requestHash: "h2", tokenCost: 2 }] }; },
    readFrozenBudget: async () => { calls.readFrozenBudget += 1; return null; },
    runSources: async () => { calls.runSources += 1; return sourceOut; },
    materialize: async () => { calls.materialize += 1; return matOut || durableMat(); },
    runReports: async () => { calls.runReports += 1; return reportOut; },
    finalizeCycle: async () => { calls.finalizeCycle += 1; return finalize; },
    log: (m) => events.push(String(m)),
  };
  if (wp16) {
    collab.readBaseCycle = async () => { calls.readBaseCycle += 1; if (base instanceof Error) throw base; return base; };
    collab.readCycleJobs = async () => { calls.readCycleJobs += 1; if (cycleJobs instanceof Error) throw cycleJobs; return cycleJobs; };
    collab.proveAlreadyCurrent = world.prove;
  }
  return collab;
}
const run = (c, extra = {}) => runListingHealthV3Ingestion({ region: REGION, cycleDate: CYCLE, connections, authorized: true, mode: "live", gate: { enabled: true }, ...c, ...extra });
// Zero appends + zero exports = none of the cycle-writing / paid collaborators ran.
const zeroAppendsZeroExports = (c) => c.calls.runSources === 0 && c.calls.materialize === 0 && c.calls.runReports === 0 && c.calls.finalizeCycle === 0 && c.calls.checkBalance === 0;

// The materialize summary THIS run produced: both durable families persisted per account ('replaced' + the content sha
// the durable pointer now carries). Overridable per account.
function durableMat(over = {}) {
  const durableByAccount = Object.create(null);
  for (const acct of ACCTS) {
    const o = over[acct] || {};
    durableByAccount[acct] = {
      "listing-health-v3:listings": { ack: o.lAck || "replaced", payloadSha: o.lSha || "sha-l-" + acct },
      "listing-health-v3:listings-raw": { ack: o.rAck || "replaced", payloadSha: o.rSha || "sha-r-" + acct },
    };
  }
  return { accounts: 2, aliasesWritten: 4, emptyAliases: 0, rejected: 0, skippedStale: 0, durableByAccount };
}
// The durable job rows of the (now terminal) base cycle for a refused-save run: acct-00 saved, acct-01's save failed.
function refusedCycleJobs({ other = null, sourceFailed = false } = {}) {
  const reportJobs = [
    { report_key: "listing-health-v3", account_id: "acct-00", fetch_status: "ready", derive_status: "succeeded", save_status: "succeeded", error_stage: null, error_code: null },
    { report_key: "listing-health-v3", account_id: "acct-01", fetch_status: "ready", derive_status: "succeeded", save_status: "failed", error_stage: "save", error_code: "SNAPSHOT_SAVE_FAILED" },
  ];
  if (other) reportJobs[0] = { ...reportJobs[0], ...other };
  const sourceJobs = [{ request_hash: "h1", fetch_status: "succeeded" }, { request_hash: "h2", fetch_status: sourceFailed ? "failed" : "succeeded" }];
  return { cycleId: BASE_CYCLE_ID, status: "partial", reportJobs, sourceJobs };
}
const refusedRun = (opts = {}) => live({
  reportOut: { succeeded: 1, blocked: 0, failed: 1, drained: true },
  finalize: { disposition: "finalized", status: "partial", cycleId: BASE_CYCLE_ID },
  cycleJobs: refusedCycleJobs(opts.jobs || {}),
  ...opts,
});

/* ===================== A. TERMINAL BASE CYCLE (us-ca 2026-09-24 reproduction) ===================== */
await (async () => {
  // A0: the OLD shape -- no WP16 collaborators -> the operator still walks runSources/materialize/runReports (the path
  // that hit the terminal-cycle 400 in production). Pinned to prove the fix is what changes it (and that a run without
  // the collaborators is byte-identical to pre-WP16).
  const cOld = live({ wp16: false });
  await run(cOld);
  ok("A0: WITHOUT the WP16 collaborators the operator is unchanged (runSources/materialize/runReports/finalize all run)", cOld.calls.runSources === 1 && cOld.calls.materialize === 1 && cOld.calls.runReports === 1 && cOld.calls.finalizeCycle === 1);

  // A1: terminal base cycle + every account provably current -> success, zero appends, zero exports.
  const c = live({ base: { id: BASE_CYCLE_ID, status: "succeeded" } });
  const r = await run(c);
  ok("A1: terminal base cycle + all accounts provably current -> ok:true, phase complete", r.ok === true && r.phase === "complete" && r.baseCycleTerminal === true && r.baseCycleStatus === "succeeded");
  ok("A1: every account counted already-current (2), refusedReal 0 -- never 'published' (snapshots 0)", r.alreadyCurrent === 2 && r.refusedReal === 0 && r.snapshots === 0 && Array.isArray(r.refusals) && r.refusals.length === 0);
  ok("A1: ZERO appends + ZERO exports: no runSources/materialize/runReports/finalize/balance read; creates 0, tokens 0", zeroAppendsZeroExports(c) && r.creates === 0 && r.tokens === 0);
  ok("A1: the paid-work gates are never consulted on the read-only terminal path (authorization/freeze/frozen-budget reads 0)", c.calls.readAuthorization === 0 && c.calls.freezeBudget === 0 && c.calls.readFrozenBudget === 0 && c.calls.readBaseCycle === 1);
  ok("A1: the lineage read EXCLUDES the base cycle (its natural-shape jobs are never the publication lineage)", c.world.reads.jobArgs.length === 2 && c.world.reads.jobArgs.every((a) => a.excludeCycleId === BASE_CYCLE_ID));
  ok("A1: a structured LHV3_ALREADY_CURRENT event is emitted (path base-cycle-terminal, counts)", c.events.some((e) => e.startsWith("LHV3_ALREADY_CURRENT ") && /"path":"base-cycle-terminal"/.test(e) && /"alreadyCurrent":2/.test(e) && /"refusedReal":0/.test(e)));

  // A2: terminal base cycle + ONE account's content differs -> a real failure for THAT account only.
  const w2 = makeWorld({ "acct-01": { bundle: { eligible: true, status: "available", revisionId: "rev-new", deps: [], contentDeps: ["manifest-acct-01-NEWER"], bundle: {} } } });
  const c2 = live({ base: { id: BASE_CYCLE_ID, status: "succeeded" }, world: w2 });
  const r2 = await run(c2);
  ok("A2: terminal base cycle + one account content differs -> ok:false, phase base-cycle-terminal", r2.ok === false && r2.phase === "base-cycle-terminal");
  ok("A2: ONLY that account is a real failure (alreadyCurrent 1, refusedReal 1, typed base-cycle-terminal:not-current:content)",
    r2.alreadyCurrent === 1 && r2.refusedReal === 1 && r2.refusals.length === 1 && r2.refusals[0].accountId === "acct-01"
    && r2.refusals[0].reason === "base-cycle-terminal:not-current:content" && r2.refusals[0].detail === "published-identity-differs");
  ok("A2: still ZERO appends + ZERO exports (the natural job never re-acquires; the reconciler repairs)", zeroAppendsZeroExports(c2) && r2.creates === 0 && r2.tokens === 0);

  // A3: terminal 'partial' base cycle whose accounts are all proven current is ALSO a success (per-account truth).
  const c3 = live({ base: { id: BASE_CYCLE_ID, status: "partial" } });
  const r3 = await run(c3);
  ok("A3: a terminal PARTIAL base cycle with every account proven current -> ok:true (per-account proof, zero appends)", r3.ok === true && r3.cycleStatus === "partial" && r3.alreadyCurrent === 2 && zeroAppendsZeroExports(c3));

  // A4: a base-cycle read error fails CLOSED before any append/export.
  const c4 = live({ base: new Error("db down") });
  const r4 = await run(c4);
  ok("A4: an unreadable base cycle fails closed (phase base-cycle, ok:false) with zero appends / exports", r4.ok === false && r4.phase === "base-cycle" && zeroAppendsZeroExports(c4));

  // A5: a missing proof collaborator on a terminal base cycle can never be 'current'.
  const c5 = live({ base: { id: BASE_CYCLE_ID, status: "succeeded" } });
  c5.proveAlreadyCurrent = null;
  const r5 = await run(c5);
  ok("A5: terminal base cycle without the proof -> every account a real failure (proof-unavailable), zero appends", r5.ok === false && r5.refusedReal === 2 && r5.alreadyCurrent === 0 && r5.refusals.every((x) => x.detail === "proof-unavailable") && zeroAppendsZeroExports(c5));

  // A6: a RUNNING / absent base cycle takes the UNCHANGED path.
  const c6 = live({ base: null });
  const r6 = await run(c6);
  ok("A6: an absent base cycle proceeds on the unchanged path (runSources/materialize/runReports/finalize once, succeeded)", r6.ok === true && r6.cycleStatus === "succeeded" && c6.calls.runSources === 1 && c6.calls.runReports === 1 && r6.alreadyCurrent === undefined);

  // A7: dry-run never consults the base cycle (the terminal check is live-only; dry-run stays byte-identical).
  const c7 = live({ base: { id: BASE_CYCLE_ID, status: "succeeded" } });
  const r7 = await runListingHealthV3Ingestion({ region: REGION, cycleDate: CYCLE, connections, authorized: true, mode: "dry-run", gate: { enabled: true }, ...c7 });
  ok("A7: dry-run is unchanged (phase planned, base cycle not read)", r7.ok === true && r7.phase === "planned" && c7.calls.readBaseCycle === 0);
})();

/* ===================== B. REFUSED / FAILED SHADOW SAVE (india 2026-09-25 reproduction) ===================== */
await (async () => {
  // B0: the OLD shape -- a save-failed account makes the run ok:false (partial) even though it is current.
  const cOld = refusedRun({ wp16: false });
  const rOld = await run(cOld);
  ok("B0: WITHOUT the WP16 collaborators a failed shadow save stays ok:false / partial (unchanged)", rOld.ok === false && rOld.phase === "partial" && rOld.alreadyCurrent === undefined);

  // B1: refused shadow with identical content + lineage + read-back -> already-current; the run succeeds.
  const c1 = refusedRun();
  const r1 = await run(c1);
  ok("B1: refused shadow with identical content+lineage+readback -> already-current (ok:true, complete, honest cycleStatus partial)", r1.ok === true && r1.phase === "complete" && r1.cycleStatus === "partial");
  ok("B1: counts: alreadyCurrent 1 (the refused account), refusedReal 0; audit read ok with 1 refused save, 0 other failures", r1.alreadyCurrent === 1 && r1.refusedReal === 0 && r1.refusalAudit && r1.refusalAudit.read === "ok" && r1.refusalAudit.refusedSaves === 1 && r1.refusalAudit.otherReportFailures === 0 && r1.refusalAudit.sourceFailed === 0);
  ok("B1: only the refused account is proven, and its lineage read excludes this run's own base cycle", c1.world.reads.jobArgs.length === 1 && c1.world.reads.jobArgs[0].accountId === "acct-01" && c1.world.reads.jobArgs[0].excludeCycleId === BASE_CYCLE_ID);

  // B2: refused shadow with DIFFERENT content -> real failure (typed shadow-refused:content).
  const w2 = makeWorld({ "acct-01": { job: { durableContentDeps: ["manifest-acct-01-OLDER"] } } });
  const r2 = await run(refusedRun({ world: w2 }));
  ok("B2: refused shadow with different content -> real failure (ok:false, refusedReal 1, shadow-refused:content)", r2.ok === false && r2.refusedReal === 1 && r2.alreadyCurrent === 0 && r2.refusals[0].reason === "shadow-refused:content" && r2.refusals[0].detail === "published-identity-differs");
  // B2b: the durable evidence is NOT this run's evidence (the run's persist lost to a newer pointer) -> content failure.
  const r2b = await run(refusedRun({ matOut: durableMat({ "acct-01": { lAck: "stale-save" } }) }));
  ok("B2b: the run's own durable evidence not persisted (stale-save) -> real failure shadow-refused:content (run-evidence-not-durable)", r2b.ok === false && r2b.refusals[0].reason === "shadow-refused:content" && /^run-evidence-not-durable/.test(r2b.refusals[0].detail));
  // B2c: the durable pointer's content sha is not the one this run persisted -> content failure.
  const r2c = await run(refusedRun({ matOut: durableMat({ "acct-01": { rSha: "sha-someone-else" } }) }));
  ok("B2c: durable Listings-Raw content sha != what this run persisted -> real failure (run-evidence-not-durable:listings-raw)", r2c.ok === false && r2c.refusals[0].detail === "run-evidence-not-durable:listings-raw");

  // B3: refused shadow with matching content but NO promotable lineage -> real failure (shadow-refused:lineage).
  const w3 = makeWorld({ "acct-01": { job: { cycleStatus: "running" } } });
  const r3 = await run(refusedRun({ world: w3 }));
  ok("B3: refused shadow with matching content but no promotable lineage -> real failure (shadow-refused:lineage)", r3.ok === false && r3.refusedReal === 1 && r3.refusals[0].reason === "shadow-refused:lineage" && r3.refusals[0].detail === "latest-job-not-promotable");
  const w3b = makeWorld({ "acct-01": { job: { validated: false } } });
  const r3b = await run(refusedRun({ world: w3b }));
  ok("B3b: an unvalidated job with matching tokens is never lineage -> shadow-refused:lineage", r3b.ok === false && r3b.refusals[0].reason === "shadow-refused:lineage");
  const w3c = makeWorld({ "acct-01": { shadowTo: "2026-09-23" } });
  const r3c = await run(refusedRun({ world: w3c }));
  ok("B3c: a promotable job whose shadow is for ANOTHER as-of (same tokens) -> shadow-refused:lineage (candidate-asof-not-exact)", r3c.ok === false && r3c.refusals[0].reason === "shadow-refused:lineage" && r3c.refusals[0].detail === "candidate-asof-not-exact");

  // B4: refused shadow with matching content + lineage but live read-back mismatch -> real failure (shadow-refused:readback).
  const w4 = makeWorld({ "acct-01": { livePayload: (p) => ({ ...p, rows: [] }) } });
  const r4 = await run(refusedRun({ world: w4 }));
  ok("B4: matching content+lineage but the live payload differs from the shadow -> real failure (shadow-refused:readback)", r4.ok === false && r4.refusedReal === 1 && r4.refusals[0].reason === "shadow-refused:readback");
  const w4b = makeWorld({ "acct-01": { noLive: true } });
  const r4b = await run(refusedRun({ world: w4b }));
  ok("B4b: matching content+lineage but NO promoted live row -> shadow-refused:readback (live-unpromoted)", r4b.ok === false && r4b.refusals[0].reason === "shadow-refused:readback" && r4b.refusals[0].detail === "live-unpromoted");
  const w4c = makeWorld({ serveEnv: { LHV3_PUBLISH_LIVE: "true" } });
  const r4c = await run(refusedRun({ world: w4c }));
  ok("B4c: live proven but the dashboard's served selector does not return it (serve flag off) -> shadow-refused:readback (served-serve-flag-off)", r4c.ok === false && r4c.refusals[0].reason === "shadow-refused:readback" && r4c.refusals[0].detail === "served-serve-flag-off");

  // B5: the refused account is proven current but another report job failed / a source failed -> never a success.
  const r5 = await run(refusedRun({ jobs: { other: { derive_status: "failed", save_status: "pending", error_stage: "derive", error_code: "DERIVE_INVALID" } } }));
  ok("B5: a proven-current refused save + ANOTHER report failure -> still ok:false (partial), counted honestly", r5.ok === false && r5.phase === "partial" && r5.alreadyCurrent === 1 && r5.refusalAudit.otherReportFailures === 1);
  const r5b = await run(refusedRun({ jobs: { sourceFailed: true } }));
  ok("B5b: a proven-current refused save + a SOURCE failure -> still ok:false", r5b.ok === false && r5b.refusalAudit.sourceFailed === 1);
  // B6: unreadable cycle jobs -> fail closed (no success, typed audit).
  const r6 = await run(refusedRun({ cycleJobs: new Error("db down") }));
  ok("B6: unreadable cycle job rows -> ok:false, refusalAudit.read failed, refusedReal = reportFailed", r6.ok === false && r6.refusalAudit.read === "failed" && r6.refusedReal === 1 && r6.alreadyCurrent === 0);
  // B7: lineage / evidence read failures fail closed (typed), never current.
  const r7 = await run(refusedRun({ world: makeWorld({ jobThrows: true }) }));
  ok("B7: an unreadable publication job fails closed (shadow-refused:content, published-identity-unreadable)", r7.ok === false && r7.refusals[0].detail === "published-identity-unreadable");
  const r7b = await run(refusedRun({ world: makeWorld({ bundleThrows: true }) }));
  ok("B7b: unreadable durable evidence fails closed (shadow-refused:content, evidence-unreadable)", r7b.ok === false && r7b.refusals[0].detail === "evidence-unreadable");
})();

/* ===================== C. TIMESTAMP-ONLY EQUALITY NEVER COUNTS AS CURRENT ===================== */
await (async () => {
  // C1: the live + shadow stamps are IDENTICAL (and the live sits at the exact identity), but the evidence manifest
  // differs -> content failure (a matching timestamp / date / job row alone never proves currency).
  const w1 = makeWorld({ "acct-00": { bundle: { eligible: true, status: "available", revisionId: "rev-x", deps: [], contentDeps: ["manifest-DIFFERENT"], bundle: {} } } });
  const p1 = await w1.prove({ accountId: "acct-00", country: "US", requestedAsOf: CYCLE, excludeCycleId: BASE_CYCLE_ID });
  ok("C1: identical live/shadow stamps + a different manifest -> NOT current (check content)", p1.ok === false && p1.check === "content");
  // C2: equal stamps, equal tokens, but the live payload differs -> NOT current (check readback).
  const w2 = makeWorld({ "acct-00": { livePayload: (p) => ({ ...p, accountName: "tampered" }) } });
  const p2 = await w2.prove({ accountId: "acct-00", country: "US", requestedAsOf: CYCLE, excludeCycleId: BASE_CYCLE_ID });
  ok("C2: identical stamps + matching tokens but a different live payload -> NOT current (check readback)", p2.ok === false && p2.check === "readback");
  // C3: a NEWER live stamp alone (payload + tokens equal) is not the shadow's promotion -> NOT current.
  const w3 = makeWorld({ "acct-00": { liveStamp: "2026-09-25T00:16:00+00:00" } });
  const p3 = await w3.prove({ accountId: "acct-00", country: "US", requestedAsOf: CYCLE, excludeCycleId: BASE_CYCLE_ID });
  ok("C3: a newer live timestamp alone never proves currency (live-refresh-differs -> readback)", p3.ok === false && p3.check === "readback" && p3.reason === "live-refresh-differs");
  // C4: the proof passes ONLY when all three hold (the positive control over the same world shape).
  const w4 = makeWorld();
  const p4 = await w4.prove({ accountId: "acct-00", country: "US", requestedAsOf: CYCLE, excludeCycleId: BASE_CYCLE_ID });
  ok("C4: positive control -- content + lineage + live/served read-back all match -> current", p4.ok === true && p4.check === null);
  ok("C4: the check vocabulary is exactly content | lineage | readback", J(LHV3_ALREADY_CURRENT_CHECKS) === J(["content", "lineage", "readback"]));
  // C5: the proof builder refuses to build without its collaborators (fail closed at composition).
  let threw = false;
  try { buildListingHealthV3AlreadyCurrentProof({}); } catch { threw = true; }
  ok("C5: building the proof without collaborators throws (fail closed)", threw);
})();

/* ===================== D. materialize records THIS run's per-account durable outcome (additive) ===================== */
await (async () => {
  const plans = planListingHealthV3BucketBatched({ accounts: usAccounts, connections, asOfFor: () => CYCLE, inventoryAsOf: CYCLE });
  const cache = new Map();
  const rowsByKey = {
    "listing-health-v3:listings": ACCTS.map((a) => listingRow(a, "A", 9)),
    "listing-health-v3:listings-raw": ACCTS.map((a) => rawRow(a, "A", 9)),
  };
  for (const src of plans[0].sources) {
    if (!rowsByKey[src.requestKey] || cache.has(src.requestHash)) continue;
    cache.set(src.requestHash, { rows: rowsByKey[src.requestKey], fetched_at: "2026-09-24T07:14:00.000Z", expires_at: "2999-01-01T00:00:00.000Z" });
  }
  const acks = { "listing-health-v3:listings": "replaced", "listing-health-v3:listings-raw": "stale-save" };
  const summary = await materializeListingHealthV3PerAccount({
    plans, connections,
    readSourceCache: async (h) => (cache.has(h) ? { ...cache.get(h) } : null),
    writeSourceCache: async () => {},
    saveDurablePayload: async ({ sourceKey, scopeKey }) => ({ objectPath: `p/${sourceKey}/${scopeKey}/sha.json`, payloadSha: `sha-${sourceKey}-${scopeKey}`, payloadBytes: 1 }),
    recordDurableByKey: {
      "listing-health-v3:listings": async () => ({ ack: acks["listing-health-v3:listings"] }),
      "listing-health-v3:listings-raw": async () => ({ ack: acks["listing-health-v3:listings-raw"] }),
    },
  });
  const d = summary.durableByAccount;
  ok("D1: the summary records each account's durable ack + content sha for BOTH durable families",
    ACCTS.every((a) => d[a] && d[a]["listing-health-v3:listings"].ack === "replaced" && d[a]["listing-health-v3:listings-raw"].ack === "stale-save" && /^sha-/.test(d[a]["listing-health-v3:listings"].payloadSha)));
  ok("D1: inventory (reuse-only) is never recorded; the pre-existing counters are unchanged", ACCTS.every((a) => !("listing-health-v3:inventory" in d[a])) && summary.durableWritten === 2 && summary.durableStale === 2);
  const bare = await materializeListingHealthV3PerAccount({ plans, connections, readSourceCache: async (h) => (cache.has(h) ? { ...cache.get(h) } : null), writeSourceCache: async () => {} });
  ok("D2: without durable persistence injected the per-account map stays EMPTY (the operator then fails closed)", Object.keys(bare.durableByAccount).length === 0);
})();

// ---- the two CLIs' sources (static wiring pins; comment lines stripped where code is asserted) ----
const readSrc = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const codeOnly = (src) => src.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
const INGEST_CLI = readSrc("./release/listing-health-v3-ingestion.mjs");
const RECONCILE_CLI = readSrc("./release/listing-health-v3-reconcile.mjs");
const OPERATION_SRC = readSrc("../lib/server/sync/listing-health-v3-operation.js");

/* ===================== E. P2-A SERVE-GATE ATTESTATION (one dedicated var; the Vercel flag names are never read) ===================== */
await (async () => {
  const BOTH = J({ LHV3_PUBLISH_LIVE: "true", LISTING_HEALTH_V3: "true" });
  ok("E1: the attestation variable is exactly LHV3_SERVE_GATE_ATTESTED", LHV3_SERVE_GATE_ATTESTATION_VAR === "LHV3_SERVE_GATE_ATTESTED");
  ok("E1: LHV3_SERVE_GATE_ATTESTED exactly 'true' -> the selector env carries BOTH serve flags 'true'", J(lhv3ServeEnvFromAttestation({ LHV3_SERVE_GATE_ATTESTED: "true" })) === BOTH);
  const refused = [["unset", {}], ["'TRUE'", { LHV3_SERVE_GATE_ATTESTED: "TRUE" }], ["'1'", { LHV3_SERVE_GATE_ATTESTED: "1" }], ["' true'", { LHV3_SERVE_GATE_ATTESTED: " true" }],
    ["'true '", { LHV3_SERVE_GATE_ATTESTED: "true " }], ["'yes'", { LHV3_SERVE_GATE_ATTESTED: "yes" }], ["''", { LHV3_SERVE_GATE_ATTESTED: "" }], ["'false'", { LHV3_SERVE_GATE_ATTESTED: "false" }],
    ["boolean true", { LHV3_SERVE_GATE_ATTESTED: true }], ["null env", null], ["undefined env", undefined]];
  for (const [label, env] of refused) ok(`E2: attestation ${label} -> an EMPTY selector env (fail closed)`, J(lhv3ServeEnvFromAttestation(env)) === "{}");
  ok("E3: STRAY literal flags are IGNORED (LHV3_PUBLISH_LIVE + LISTING_HEALTH_V3 'true' without the attestation -> empty env)",
    J(lhv3ServeEnvFromAttestation({ LHV3_PUBLISH_LIVE: "true", LISTING_HEALTH_V3: "true" })) === "{}"
    && J(lhv3ServeEnvFromAttestation({ LHV3_PUBLISH_LIVE: "true", LISTING_HEALTH_V3: "true", LHV3_SERVE_GATE_ATTESTED: "false" })) === "{}");
  ok("E3: stray literal flags set to 'false' never DOWNGRADE a real attestation either (they are simply not read)",
    J(lhv3ServeEnvFromAttestation({ LHV3_PUBLISH_LIVE: "false", LISTING_HEALTH_V3: "false", LHV3_SERVE_GATE_ATTESTED: "true" })) === BOTH);
  // End-to-end through the REAL selectLhv3 + the REAL proof: attested -> current; stray literal flags -> served-serve-flag-off.
  const attested = await makeWorld({ serveEnv: lhv3ServeEnvFromAttestation({ LHV3_SERVE_GATE_ATTESTED: "true" }) }).prove({ accountId: "acct-00", country: "US", requestedAsOf: CYCLE, excludeCycleId: BASE_CYCLE_ID });
  ok("E4: the proof over the attested env passes (content + lineage + live + served all match)", attested.ok === true);
  const stray = await makeWorld({ serveEnv: lhv3ServeEnvFromAttestation({ LHV3_PUBLISH_LIVE: "true", LISTING_HEALTH_V3: "true" }) }).prove({ accountId: "acct-00", country: "US", requestedAsOf: CYCLE, excludeCycleId: BASE_CYCLE_ID });
  ok("E4: the proof over STRAY literal flags fails closed EXACTLY as before (readback, served-serve-flag-off)", stray.ok === false && stray.check === "readback" && stray.reason === "served-serve-flag-off");
  const rStray = await run(refusedRun({ world: makeWorld({ serveEnv: lhv3ServeEnvFromAttestation({ LHV3_PUBLISH_LIVE: "true", LISTING_HEALTH_V3: "true" }) }) }));
  ok("E4: through the operator the stray-flag run is a REAL failure (shadow-refused:readback / served-serve-flag-off)", rStray.ok === false && rStray.refusals[0].reason === "shadow-refused:readback" && rStray.refusals[0].detail === "served-serve-flag-off");
  const code = codeOnly(INGEST_CLI);
  ok("E5: the CLI's served selector env is ONLY lhv3ServeEnvFromAttestation(process.env)", /env: lhv3ServeEnvFromAttestation\(process\.env\),/.test(code));
  ok("E5: the CLI code never reads the literal Vercel flag names (LHV3_PUBLISH_LIVE / LISTING_HEALTH_V3; the _INGESTION_ENABLED gate is distinct)",
    !/\bLHV3_PUBLISH_LIVE\b/.test(code) && !/\bLISTING_HEALTH_V3\b(?!_)/.test(code));
})();

/* ===================== F. GITHUB_OUTPUT lhv3_phase + lhv3_durable_persisted ===================== */
await (async () => {
  const out = (ev) => J(lhv3IngestionGithubOutputs(ev));
  const pair = (phase, persisted) => J([["lhv3_phase", phase], ["lhv3_durable_persisted", persisted]]);
  const cA1 = live({ base: { id: BASE_CYCLE_ID, status: "succeeded" } });
  ok("F1: terminal base cycle, all current -> lhv3_phase=complete, lhv3_durable_persisted=false (the read-only path persists nothing)", out(await run(cA1)) === pair("complete", "false"));
  const wA2 = makeWorld({ "acct-01": { bundle: { eligible: true, status: "available", revisionId: "rev-new", deps: [], contentDeps: ["manifest-acct-01-NEWER"], bundle: {} } } });
  ok("F1: terminal base cycle, one not current -> lhv3_phase=base-cycle-terminal, durable false", out(await run(live({ base: { id: BASE_CYCLE_ID, status: "succeeded" }, world: wA2 }))) === pair("base-cycle-terminal", "false"));
  ok("F2: a normal succeeded run whose materialize acked durable pointers -> complete / true", out(await run(live({ base: null }))) === pair("complete", "true"));
  ok("F2: a refused-shadow run proven current -> complete / true", out(await run(refusedRun())) === pair("complete", "true"));
  ok("F2: a refused-shadow run NOT proven (different content) -> partial / true (the reconcile still has this run's durable evidence)",
    out(await run(refusedRun({ world: makeWorld({ "acct-01": { job: { durableContentDeps: ["manifest-acct-01-OLDER"] } } }) }))) === pair("partial", "true"));
  const allStale = durableMat({ "acct-00": { lAck: "stale-save", rAck: "stale-save" }, "acct-01": { lAck: "stale-save", rAck: "write-failed" } });
  ok("F3: materialize ran but NO durable pointer acked replaced|unchanged -> durable false", out(await run(live({ base: null, matOut: allStale }))) === pair("complete", "false"));
  ok("F3: counters-only summaries (no per-account record) fall back to durableWritten + durableUnchanged",
    out({ phase: "partial", aliases: { durableWritten: 0, durableUnchanged: 2 } }) === pair("partial", "true") && out({ phase: "partial", aliases: { durableWritten: 0, durableUnchanged: 0 } }) === pair("partial", "false"));
  const dry = await runListingHealthV3Ingestion({ region: REGION, cycleDate: CYCLE, connections, authorized: true, mode: "dry-run", gate: { enabled: true }, ...live({ base: null }) });
  ok("F4: a dry-run -> planned / false", out(dry) === pair("planned", "false"));
  ok("F4: a malformed / multi-line phase is never emitted verbatim (unknown); null evidence -> unknown / false",
    out({ phase: "partial\nlhv3_phase=complete" }) === pair("unknown", "false") && out({ phase: "Complete" }) === pair("unknown", "false") && out(null) === pair("unknown", "false"));
  const code = codeOnly(INGEST_CLI);
  ok("F5: the CLI appends every pair to $GITHUB_OUTPUT (k=v, one line each; a write failure never affects the exit code)",
    /const ghOut = \(k, v\) => \{ const f = process\.env\.GITHUB_OUTPUT; if \(f\) \{ try \{ appendFileSync\(f, k \+ "=" \+ v \+ "\\n"\); \} catch/.test(code)
    && /for \(const \[k, v\] of lhv3IngestionGithubOutputs\(evidence\)\) ghOut\(k, v\);/.test(code));
  const iOut = code.indexOf("lhv3IngestionGithubOutputs(evidence)"); const iRun = code.indexOf("await runListingHealthV3Ingestion("); const iExit0 = code.indexOf("process.exit(0)", iRun);
  ok("F5: the outputs are written AFTER the operation and BEFORE either exit (so a failing run still exposes its phase)", iRun > 0 && iOut > iRun && iExit0 > iOut && code.indexOf("process.exit(1)", iRun) > iOut);
})();

/* ===================== G. P3-B the long-lived pg client: 'error' listened + memoized; timeouts ===================== */
await (async () => {
  class FakePgClient extends EventEmitter {
    constructor(opts = {}) { super(); this.opts = opts; this.connects = 0; this.queries = 0; this.ended = 0; }
    async connect() { this.connects += 1; if (this.opts.connectFails) throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:6543 password=S3cret"), { code: "ECONNREFUSED" }); }
    async query(sql, params) { this.queries += 1; return { rows: this.opts.rows ? this.opts.rows(sql, params) : [] }; }
    async end() { this.ended += 1; }
  }
  // G1: happy path -- ONE lazy connect serves every read; close() ends it.
  let made = 0; const c1 = new FakePgClient({ rows: () => [{ n: 1 }] });
  const r1 = buildLhv3ReadOnlyPgReader({ makeClient: async () => { made += 1; return c1; } });
  ok("G1: construction performs NO I/O (no client made before the first read)", made === 0);
  const a = await r1.rows("select 1", []); const b = await r1.rows("select 1", []);
  await r1.close();
  ok("G1: one lazy connect serves every read; close() ends the client", made === 1 && c1.connects === 1 && c1.queries === 2 && J(a) === J([{ n: 1 }]) && J(b) === J([{ n: 1 }]) && c1.ended === 1 && r1.failure() === null);
  // G2: an idle-connection 'error' event is LISTENED (EventEmitter would THROW without a listener) and MEMOIZED.
  const c2 = new FakePgClient({ rows: () => [] });
  const r2 = buildLhv3ReadOnlyPgReader({ makeClient: () => c2 });
  await r2.rows("select 1", []);
  let emitThrew = false;
  try { c2.emit("error", Object.assign(new Error("Connection terminated unexpectedly password=S3cret"), { code: "ECONNRESET" })); } catch { emitThrew = true; }
  ok("G2: a client 'error' event never escapes as an uncaught exception (the reader listens on the client)", emitThrew === false && c2.listenerCount("error") === 1);
  let e2 = null; try { await r2.rows("select 1", []); } catch (e) { e2 = e; }
  ok("G2: every later read fails FAST with the memoized typed reason (no further query on the dead client), and the secret-bearing message is never carried",
    !!e2 && e2.message === "pg-client-error:ECONNRESET" && c2.queries === 1 && !/S3cret|terminated/.test(e2.message) && r2.failure() === "pg-client-error:ECONNRESET");
  let closeThrew = false; try { await r2.close(); } catch { closeThrew = true; }
  ok("G2: close() after a client error never throws", closeThrew === false);
  // G3: a connect failure is memoized (one attempt; later reads fail fast); a throwing constructor (bad URL) is typed.
  const c3 = new FakePgClient({ connectFails: true });
  const r3 = buildLhv3ReadOnlyPgReader({ makeClient: () => c3 });
  const fails = [];
  for (let i = 0; i < 3; i += 1) { try { await r3.rows("select 1", []); fails.push(null); } catch (e) { fails.push(e.message); } }
  ok("G3: a connect failure is memoized (ONE connect attempt; every read fails 'pg-connect-failed:ECONNREFUSED', no password)", c3.connects === 1 && fails.every((m) => m === "pg-connect-failed:ECONNREFUSED"));
  const r3b = buildLhv3ReadOnlyPgReader({ makeClient: () => { throw Object.assign(new TypeError("Invalid URL postgres://u:S3cret@h"), { code: "ERR_INVALID_URL" }); } });
  let e3b = null; try { await r3b.rows("select 1", []); } catch (e) { e3b = e; }
  ok("G3: a throwing client constructor (malformed POSTGRES_URL) becomes a typed failure, never the URL", !!e3b && e3b.message === "pg-connect-failed:ERR_INVALID_URL");
  let threw = false; try { buildLhv3ReadOnlyPgReader({}); } catch { threw = true; }
  ok("G3: the reader refuses to build without makeClient", threw);
  // G4: end-to-end -- the publication-job read goes through the pg reader; the client dies mid-run -> every account fails
  // CLOSED typed (content, published-identity-unreadable) and the operator still RETURNS its evidence (the CLI prints it).
  const c4 = new FakePgClient({ rows: () => [] });
  const r4 = buildLhv3ReadOnlyPgReader({ makeClient: () => c4 });
  await r4.rows("select 1", []); // the connection was opened earlier in the run
  c4.emit("error", Object.assign(new Error("server closed the connection"), { code: "57P01" }));
  const w4 = makeWorld({ readPublicationJob: async () => { await r4.rows("select ...", []); return null; } });
  const res4 = await run(live({ base: { id: BASE_CYCLE_ID, status: "succeeded" }, world: w4 }));
  ok("G4: a dead pg client -> the terminal-path proof fails CLOSED for every account (content / published-identity-unreadable), evidence returned",
    res4.ok === false && res4.phase === "base-cycle-terminal" && res4.refusedReal === 2 && res4.alreadyCurrent === 0 && res4.refusals.every((x) => x.reason === "base-cycle-terminal:not-current:content" && x.detail === "published-identity-unreadable"));
  const code = codeOnly(INGEST_CLI);
  ok("G5: the CLI builds its ONE pg client through buildLhv3ReadOnlyPgReader + verifiedPgConfig with a client query_timeout (30 s) and NO statement_timeout startup parameter",
    /const PG_READ_TIMEOUT_MS = 30000;/.test(code) && /buildLhv3ReadOnlyPgReader\(\{\n\s*makeClient: async \(\) => \{/.test(code)
    && /new pg\.Client\(verifiedPgConfig\(process\.env\.POSTGRES_URL, \{ connectionTimeoutMillis: 20000, query_timeout: PG_READ_TIMEOUT_MS \}\)\)/.test(code)
    && !/statement_timeout/.test(code)
    && !/pgClientPromise/.test(code) && !/const client = new pg\.Client\(/.test(code));
})();

/* ===================== H. P3-A: the terminal path never runs materialize (documented limitation) ===================== */
await (async () => {
  // The finalizing run's durable write failed soft -> acct-01 has NO durable Listings pointer. A same-date rerun hits the
  // terminal base cycle: it does NOT materialize (not provably safe -- see the operation's KNOWN LIMITATION comment); the
  // account is reported truthfully against the durable evidence as it stands.
  const w = makeWorld({ "acct-01": { bundle: { eligible: false, status: "missing", reason: "listings-no-durable-snapshot", revisionId: null, deps: [], contentDeps: [] } } });
  const c = live({ base: { id: BASE_CYCLE_ID, status: "succeeded" }, world: w });
  const r = await run(c);
  ok("H1: a missing durable pointer on a TERMINAL base cycle is NOT repaired by the same-date rerun: materialize / runSources never run",
    c.calls.materialize === 0 && c.calls.runSources === 0 && c.calls.runReports === 0 && c.calls.finalizeCycle === 0);
  ok("H1: that account fails TRUTHFULLY typed (base-cycle-terminal:not-current:content / evidence-listings-no-durable-snapshot); the other is current",
    r.ok === false && r.alreadyCurrent === 1 && r.refusedReal === 1 && r.refusals[0].accountId === "acct-01" && r.refusals[0].reason === "base-cycle-terminal:not-current:content" && r.refusals[0].detail === "evidence-listings-no-durable-snapshot");
  ok("H2: the limitation + its evidence (date-free batch hash; as_of-dominant durable CAS) is documented at the terminal branch",
    /KNOWN LIMITATION \(WP16 P3-A/.test(OPERATION_SRC) && /DATE-FREE/.test(OPERATION_SRC) && /as_of-DOMINANT/.test(OPERATION_SRC) && /is NOT repaired by a same-date rerun/.test(OPERATION_SRC));
})();

/* ===================== I. P3-C: resolveBundle parity with the reconciler; wall-clock D-1 served check ===================== */
await (async () => {
  // Canonical code text: comments stripped, whitespace collapsed, the CLI's local alias `a` normalized to `accountId`.
  const canon = (src) => codeOnly(src).replace(/\s+/g, " ").replace(/accountId: a\b/g, "accountId").replace(/scopeKey: a\b/g, "scopeKey: accountId");
  const I = canon(INGEST_CLI); const R = canon(RECONCILE_CLI);
  const both = (s) => I.includes(s) && R.includes(s);
  ok("I1: both CLIs resolve the bundle through the SAME resolveListingHealthV3DependencyBundle import", both("resolveListingHealthV3DependencyBundle({") && both('await import("../../lib/server/sync/listing-health-v3-dependency-bundle.js")'));
  ok("I1: the SAME durable Listings / Listings-Raw / FBA-inventory pointer readers",
    both("sb.getSourceListingsSnapshot({ organizationFingerprint: org, connectionId, accountId, signal })")
    && both("sb.getSourceListingsRawSnapshot({ organizationFingerprint: org, connectionId, accountId, signal })")
    && both("sb.getSourceSnapshot({ organizationFingerprint: org, connectionId, sourceKey: FBA_INVENTORY_SOURCE_KEY, scopeKey: accountId, signal })"));
  ok("I1: the SAME payload loader + object-path namespace", both("loadSnapshotPayload: (path, opt) => sb.getSourceSnapshotPayload(path, opt)") && both("buildObjectPath: sb.sourceSnapshotObjectPath"));
  ok("I1: the SAME STRICT durable OLI/Catalog context loader",
    both("makeListingHealthV3DurableContextLoader({ connections, getCatalogSnapshot: (args) => sb.getSourceSnapshot(args), loadCatalogPayload: (path, opt) => sb.getSourceSnapshotPayload(path, opt), strict: true, buildObjectPath: sb.sourceSnapshotObjectPath, })"));
  ok("I2: the SAME identity inputs: org = the primary connection's fingerprint, connection 'primary', the account id",
    /(\w+)\.organizationFingerprint \|\| organizationFingerprint\(\1\.apiKey\)/.test(I) && /(\w+)\.organizationFingerprint \|\| organizationFingerprint\(\1\.apiKey\)/.test(R)
    && both('organizationFingerprint: orgFp, connectionId: "primary", accountId,'));
  ok("I2: the SAME marketplace normalization (directory country -> Amazon code) and raw-seller resolution",
    /marketplace: normalizeMarketplace\(directoryCountry\)/.test(I) && /marketplace: normalizeMarketplace\(m\.country\)/.test(R)
    && both("resolveDataDoeAccountIds([") && both("rawAccountIds.length === 1"));
  const fbaRe = /resolvedFbaSnapshot\(\{ apiKey: \w+\.apiKey, account: \{ rawSellerId(: m\.rawSellerId)?, country: (directoryCountry|m\.country) \}, asOf: (d|requestedAsOf), bucket(: region)? \}\)/;
  ok("I2: the SAME recomputed D-1 FBA inventory request hash (resolvedFbaSnapshot over the primary apiKey + raw seller + directory country + as-of + region)",
    fbaRe.test(I) && fbaRe.test(R) && both("identity.requestHash ?? identity.request_hash"));
  ok("I3: the ONE intended difference -- the COUNTRY SOURCE: the ingestion proof takes the export-eligible discovery country; the reconciler classifyDirectoryAccounts",
    /const resolveBundle = async \(\{ accountId, country, requestedAsOf \}\)/.test(I) && !/classifyDirectoryAccounts/.test(I) && /classifyDirectoryAccounts\(rows, connections\)/.test(R)
    && /country: a && a\.country != null \? a\.country : null/.test(OPERATION_SRC) && /COUNTRY SOURCE/.test(INGEST_CLI));
  // Drift can only FAIL CLOSED: a country disagreement yields an ineligible bundle or a different manifest -> content.
  const wDrift = makeWorld({ "acct-00": { bundle: { eligible: false, status: "missing", reason: "listings-marketplace-mismatch", revisionId: null, deps: [], contentDeps: [] } } });
  const pDrift = await wDrift.prove({ accountId: "acct-00", country: "GB", requestedAsOf: CYCLE, excludeCycleId: BASE_CYCLE_ID });
  ok("I3: a country drift can only fail CLOSED (content, evidence-listings-marketplace-mismatch) -- never a false already-current", pDrift.ok === false && pDrift.check === "content" && pDrift.reason === "evidence-listings-marketplace-mismatch");
  // The served check resolves the WALL-CLOCK UTC D-1; the binding uses cycleDate. A run whose cycleDate is not that D-1
  // (e.g. 'now' two days after the cycle) fails 'served-*' truthfully even though content + lineage + live all match.
  const wLate = makeWorld({ nowMs: Date.parse(CYCLE + "T12:00:00.000Z") + 2 * 86400000 });
  const pLate = await wLate.prove({ accountId: "acct-00", country: "US", requestedAsOf: CYCLE, excludeCycleId: BASE_CYCLE_ID });
  ok("I4: cycleDate != wall-clock UTC D-1 -> the served check fails truthfully (readback, served-missing)", pLate.ok === false && pLate.check === "readback" && pLate.reason === "served-missing");
  ok("I4: the CLI documents the wall-clock UTC D-1 vs cycleDate difference at the served selector", /WALL-CLOCK UTC D-1/.test(INGEST_CLI) && /now: \(\) => Date\.now\(\),/.test(codeOnly(INGEST_CLI)));
})();

writeSync(1, `\nlisting-health-v3-replay-and-refusal: ${passed} checks passed\n`);
