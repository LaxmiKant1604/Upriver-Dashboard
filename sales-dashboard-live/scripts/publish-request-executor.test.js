// "Publish from saved data" -- the Brand View SINGLE-UNIT executor (lib/server/publish-request/brand-view-executor.js)
// driven END TO END over the SAME faithful in-memory world the reviewed brand-view route tests use
// (scripts/brand-view-routes.test.js makeWorld / seed / routeHarness -- EXTRACTED from that file's source, so both suites
// always exercise the identical fixture): the REAL brand-view route runtime, the REAL generic route release, the REAL
// saved-data reconciler two-phase core and the REAL four-gate publisher over the world's fenced live CAS.
// Offline: the global fetch is a refusing stub and its call count is asserted 0 (no DataDoe, no Supabase, no network).
//   X1 one stale (account, brand) publishes EXACTLY that unit (no fan-out to the account's other brands); the served
//      currency check (the serve's own rule) turns current only after the publish.
//   X2 a repeat is PUBLICATION_NOT_REQUIRED with ZERO writes and no control window.
//   X3 missing evidence (unknown brand / unsold brand / empty directory / account not in the directory) -> missing_evidence.
//   X4 the global control lease held by another publisher -> 'release' (contention), zero live writes.
//   X5 a request whose date rolled -> failed 'as-of-rolled' before any read.
//   X6 an aborted run (timeout / lost claim) never publishes; the next run publishes once (resume).
//   X7 the control window: short TTL (90 s), zero lease-wait, owners = the ONE account, publisher key brand-view.
//   X8 the read-only measurement makes zero writes.
// 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

process.env.SUPABASE_URL = "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = ["test", "svc", "role", "key"].join("-");
const net = { calls: [] };
globalThis.fetch = async (url, opts = {}) => { net.calls.push(String(opts.method || "GET") + " " + String(url)); throw new Error("network refused in an offline test"); };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REL = await import("../lib/server/sync/route-publication-release.js");
const { buildSchedulerV2Publisher } = await import("../lib/server/sync/publisher-composition.js");
const { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } = await import("../lib/server/sync/report-publisher.js");
const { REPORT_DERIVATIONS } = await import("../lib/server/sync/report-derivation.js");
const { paramsHashFor } = await import("../lib/server/report-store.js");
const B = await import("../lib/server/sync/publication-binding.js");
const SDR = await import("../lib/server/sync/saved-data-reconciler.js");
const RC = await import("../lib/server/recovery/route-contract.js");
const SEL = await import("../lib/server/recovery/serve-selectors.js");
const TGT = await import("../lib/server/sync/reconcile-targets-output.js");
const SB = await import("../lib/server/supabase.js");
const BV = await import("../lib/server/reports/brand-view.js");
const { campaignMappingRevision } = await import("../lib/server/reports/campaign-ads-aggregation.js");
const { ACTIVE_ADS_SOURCE_KEY } = await import("../lib/server/active-ads-source.js");
const { marketplaceToday } = await import("../lib/marketplaces.js");
const { normalizeMarketplace } = await import("../lib/server/sync/oli-sales-estimate.js");
const RD = await import("../lib/server/sync/brand-view-dependency-readers.js");
const BVB_W = await import("../lib/server/recovery/routes/brand-view-brands.route.js");
const BVB_C = await import("../lib/server/sync/routes/brand-view-brands.release.js");
const BV_W = await import("../lib/server/recovery/routes/brand-view.route.js");
const BV_C = await import("../lib/server/sync/routes/brand-view.release.js");
const EX = await import("../lib/server/publish-request/brand-view-executor.js");
const { brandViewServedCurrency } = await import("../lib/server/publish-request/brand-view-currency.js");

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; out("  ok  " + name); };
const S = (v) => (v == null ? "" : String(v));
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const L = SCHEDULER_LIVE_SNAPSHOT_CONTRACTS;
const D = REPORT_DERIVATIONS;
const ORG = "org-fp-test";
const EPOCH = "2026-09-23";
const REGION = "india";
const BVB = "brand-view-brands";
const BVK = "brand-view";
const IN_TODAY = "2026-09-24";
out("publish-request executor (single Brand View unit over the real route release)");

// ---- the world, EXTRACTED from the reviewed route test (identical fixture; never a second copy) ----
const worldSrc = readFileSync(path.join(ROOT, "scripts", "brand-view-routes.test.js"), "utf8");
const start = worldSrc.indexOf("// PostgREST renders a timestamptz");
const end = worldSrc.indexOf("// The worker's own tier-1 token");
assert.ok(start > 0 && end > start, "world fixture markers present in brand-view-routes.test.js");
const deps = { S, clone, L, D, REL, SEL, RD, RC, BV, BVB, BVK, BVB_W, BV_W, BVB_C, BV_C, SB, SDR, TGT, B, ORG, EPOCH, REGION, paramsHashFor, buildSchedulerV2Publisher, ACTIVE_ADS_SOURCE_KEY, createHash, campaignMappingRevision, marketplaceToday, normalizeMarketplace, Buffer };
// eslint-disable-next-line no-new-func
const W = new Function(...Object.keys(deps), worldSrc.slice(start, end) + "\nreturn { makeWorld, seed, routeHarness, routeDeps, bvLive, bvState };")(...Object.values(deps));

const cliRoute = RC.validateRouteModule(BV_C, { side: "cli", liveContracts: L, reportDerivations: D });

// The executor env over a world (the collaborators the worker entry wires for production).
function envFor(w, { controls = {} } = {}) {
  const log = { made: [], opened: [], closed: 0, renews: 0 };
  const env = {
    cliRoute, directory: w.directory, orgFp: ORG, sb: w.sb, pgReadOnly: w.pgReadOnly, selectors: SEL, computeHash: paramsHashFor,
    liveContracts: L, reportDerivations: D, marketplaceToday, normalizeMarketplace, now: () => w.now(),
    leaseTtlSeconds: 90, deadlineSeconds: 300,
    makeControls: (args) => {
      log.made.push(args);
      let fence = null;
      return {
        openControls: async (x) => { log.opened.push(x); if (controls.open) return controls.open(x); fence = { ownerToken: args.operator, generation: 7 }; return { ok: true }; },
        closeControls: async () => { log.closed += 1; fence = null; return { ok: true }; },
        fence: () => fence,
      };
    },
    renewControlLease: async () => { log.renews += 1; return { disposition: "renewed" }; },
    makePublisher: () => w.publisherFor(null),
    readbackLive: w.readbackLive,
    lineage: {
      openCycle: w.openCycle, getCycleByBucketDate: w.getCycleByBucketDate, claimCycle: w.claimCycle, readCycle: w.readCycle,
      upsertReportJob: w.upsertReportJob, claimLease: w.claimLease, saveShadow: w.saveShadow, reconcileSuccess: w.reconcileSuccess,
      finalizeCycle: w.finalizeCycle, readLatestJob: w.readLatestJob, readSnapshot: w.readSnapshot, loadStoragePayload: w.loadStoragePayload,
      publishSnapshotUpdate: async () => {},
    },
    log: () => {},
  };
  return { env, log };
}
// The serve's own freshness rule over the world (the executor's final read-back).
const currency = (w, accountId, brand, asOf = IN_TODAY) => brandViewServedCurrency({
  accountId, brand, asOf,
  readSnapshotIdentity: async (a) => { const r = await w.readSnapshot(a); return r ? { ...r, coverage: r.payload && r.payload.coverage ? r.payload.coverage : null } : null; },
  fingerprintReaders: RD.makeBrandViewDepReaders({ orgFp: ORG, readers: { getSnapshotMeta: w.sbNs.getLatestReportSnapshotMeta, getAdsCoverageState: w.sbNs.getDailyAdsCoverage, getInventoryCandidates: w.sbNs.getInventorySnapshotCandidates, getMappings: w.sbNs.getCampaignBrandMappings, getSourceSnap: w.sbNs.getSourceSnapshot } }),
});
const job = (accountId, brand, asOf = IN_TODAY, n = 1) => ({ id: "00000000-0000-4000-8000-00000000000" + n, account_id: accountId, brand, as_of: asOf, run_token: "psr-" + "a".repeat(32) + "-" + n });
async function freshWorld() {
  const w = W.makeWorld(); W.seed(w);
  await W.routeHarness(w, BVB_C.default).run({ accounts: ["IN1", "IN2", "IN3"] }); // the saved brand directory (route-published)
  return w;
}

// ---- X1 / X2 / X7 ----------------------------------------------------------------------------------------------------------
{
  const w = await freshWorld();
  const before = await currency(w, "IN1", "Acme");
  ok("X1 before: the dashboard has NO exact row for (IN1, Acme, today) -> not current", before.current === false && before.reason === "no-exact-row" && /^[0-9a-f]{40}$/.test(S(before.fingerprint)));
  const { env, log } = envFor(w);
  const r1 = await EX.runBrandViewUnitPublish({ job: job("IN1", "Acme"), env });
  const acme = W.bvLive(w, "IN1", "Acme", IN_TODAY);
  ok("X1 the ONE requested unit is published through the fenced release (READBACK_VERIFIED -> 'verify')", r1.finish === "verify" && r1.unitState === "READBACK_VERIFIED" && !!acme && acme.params.brand === "Acme");
  ok("X1 ... and ONLY that unit: the account's other brand (Zeta) is NOT published (never a fan-out)", W.bvLive(w, "IN1", "Zeta", IN_TODAY) === null);
  const after = await currency(w, "IN1", "Acme");
  ok("X1 the served-row read-back (the serve's own rule) is now CURRENT, bound to the published row", after.current === true && after.served.id === S(acme.id) && after.served.storedFingerprint === after.fingerprint && !!after.served.salesLatestDate);
  ok("X7 one control window: TTL 90 s, owners = the ONE account, publisher key brand-view, closed after", log.made.length === 1 && log.made[0].leaseTtlSeconds === 90 && /^publication-route-reconcile:india:psr-a{32}-1$/.test(log.made[0].operator)
    && log.opened.length === 1 && JSON.stringify(log.opened[0].owners || log.opened[0]) .includes("IN1") && log.closed >= 1);
  const writes = w.writes();
  const { env: env2, log: log2 } = envFor(w);
  const r2 = await EX.runBrandViewUnitPublish({ job: job("IN1", "Acme", IN_TODAY, 2), env: env2 });
  ok("X2 a repeat is PUBLICATION_NOT_REQUIRED ('verify' -> already_current) with ZERO writes and NO control window", r2.finish === "verify" && r2.unitState === "PUBLICATION_NOT_REQUIRED" && w.writes() === writes && log2.opened.length === 0);
}

// ---- X3 missing evidence ---------------------------------------------------------------------------------------------------
{
  const w = await freshWorld();
  const run = async (acct, brand) => EX.runBrandViewUnitPublish({ job: job(acct, brand), env: envFor(w).env });
  const unknown = await run("IN1", "Nope");
  ok("X3 a brand not in the account's saved directory -> missing_evidence (never a build, never a fetch)", unknown.finish === "missing_evidence" && unknown.reason === "brand-not-in-saved-directory");
  const unsold = await run("IN1", "Beta");
  ok("X3 a directory brand the saved sales do not sell -> missing_evidence (typed brand-not-sold)", unsold.finish === "missing_evidence" && /brand-not-sold/.test(S(unsold.reason)));
  const empty = await run("IN3", "Acme");
  ok("X3 an account whose saved directory is empty -> missing_evidence", empty.finish === "missing_evidence");
  const nodir = await run("ZZ9", "Acme");
  ok("X3 an account absent from the durable directory -> missing_evidence 'account-not-in-durable-directory'", nodir.finish === "missing_evidence" && nodir.reason === "account-not-in-durable-directory");
  ok("X3 ... none of them wrote a live Brand View row", W.bvLive(w, "IN1", "Beta", IN_TODAY) === null && W.bvLive(w, "IN3", "Acme", IN_TODAY) === null);
}

// ---- X4 contention / X5 as-of rolled / X6 abort + resume ---------------------------------------------------------------------
{
  const w = await freshWorld();
  // The REAL control-package wording of a held lease (buildRouteCliControls: "controls apply did not commit (code 1/<problem>)").
  const held = "controls apply did not commit (code 1/CONTROL_LEASE_HELD: the global control plane is owned by another operation (publication-rou) -- refusing apply (zero writes).)";
  const { env } = envFor(w, { controls: { open: async () => ({ ok: false, reason: held }) } });
  const r = await EX.runBrandViewUnitPublish({ job: job("IN1", "Acme"), env });
  ok("X4 the global control lease held by another publisher -> 'release' (no attempt used), NO live row written", r.finish === "release" && W.bvLive(w, "IN1", "Acme", IN_TODAY) === null);
  const { env: envB } = envFor(w, { controls: { open: async () => ({ ok: false, reason: "controls apply did not commit (code 1/POST all_primary mismatch)" }) } });
  const rb = await EX.runBrandViewUnitPublish({ job: job("IN1", "Acme", IN_TODAY, 5), env: envB });
  ok("X4 a control apply that fails for any OTHER reason -> bounded 'retry' (consumes an attempt; never a free loop), NO live row written", rb.finish === "retry" && W.bvLive(w, "IN1", "Acme", IN_TODAY) === null);
  const rolled = await EX.runBrandViewUnitPublish({ job: job("IN1", "Acme", "2026-09-23"), env: envFor(w).env });
  ok("X5 a request for a date the dashboard no longer serves -> failed 'as-of-rolled:<today>'", rolled.finish === "failed" && rolled.reason === "as-of-rolled:" + IN_TODAY);
  const ac = new AbortController(); ac.abort();
  const aborted = await EX.runBrandViewUnitPublish({ job: job("IN1", "Acme", IN_TODAY, 3), env: envFor(w).env, signal: ac.signal });
  ok("X6 an aborted run (timeout / lost claim) publishes NOTHING and is not recorded as done", W.bvLive(w, "IN1", "Acme", IN_TODAY) === null && aborted.finish !== "verify" && aborted.finish !== "failed");
  const resumed = await EX.runBrandViewUnitPublish({ job: job("IN1", "Acme", IN_TODAY, 4), env: envFor(w).env });
  ok("X6 ... the next attempt publishes the unit once", resumed.finish === "verify" && resumed.unitState === "READBACK_VERIFIED" && !!W.bvLive(w, "IN1", "Acme", IN_TODAY));
}

// ---- X9 the marketplace day rolls AFTER the request's date check but BEFORE the evidence read --------------------------------
{
  const w = await freshWorld();
  const { env } = envFor(w);
  let calls = 0;
  env.now = () => (calls++ === 0 ? w.now() : w.now() + 86400000); // the first read is the request's day, later reads the next
  const r = await EX.runBrandViewUnitPublish({ job: job("IN1", "Acme"), env });
  ok("X9 a mid-run midnight never publishes the NEXT day's row for a request made for today: failed 'as-of-rolled:<tomorrow>', no live row for either day",
    r.finish === "failed" && r.reason === "as-of-rolled:2026-09-25" && W.bvLive(w, "IN1", "Acme", IN_TODAY) === null && W.bvLive(w, "IN1", "Acme", "2026-09-25") === null);
}

// ---- X8 measurement is read-only -------------------------------------------------------------------------------------------
{
  const w = await freshWorld();
  const writes = w.writes();
  const m = await EX.measureBrandViewUnit({ job: job("IN1", "Acme"), env: envFor(w).env, currency: () => currency(w, "IN1", "Acme") });
  ok("X8 the canary measurement runs evidence + bundle + derive + currency with ZERO writes", m.unitFound === true && m.unitEligible === true && m.payloadBytes > 0 && m.steps.every((s) => s.ok) && w.writes() === writes && W.bvLive(w, "IN1", "Acme", IN_TODAY) === null);
}

ok("Z zero network: no DataDoe / Supabase / any fetch in the whole suite", net.calls.length === 0);
out(`publish-request executor: ${passed} passed`);
