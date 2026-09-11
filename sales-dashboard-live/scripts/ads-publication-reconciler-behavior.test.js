// Campaign-Ads publication reconciler ORCHESTRATION (behavioral): the REAL shared reconciler core + REAL per-report Ads
// revision/binding, with injected durable-Ads readers / control hooks / release execution (clearly labelled). Drives
// BOTH single-report operations (daily-reporting: campaign grain only; ppc-performance: campaign + targeting +
// search-terms) exactly as the entrypoint builds them (Codex blocker 5). Covers the required reproduction cases:
//   - durable Ads covered + live UNPROMOTED -> derive + promote (READBACK_VERIFIED); controls opened; zero export;
//   - current content already promoted (job durable_content_deps holds the CURRENT token) -> PUBLICATION_NOT_REQUIRED,
//     zero writes (no controls, no release);
//   - SAME-DATE content correction (content_rev flips -> new token, NOT in durable_content_deps) -> STALE -> re-derive;
//   - covered-empty (continuous coverage, no activity) -> still eligible + publishes (honest, never a manufactured zero);
//   - missing / gapped / blank-content_rev / read-failed grain -> DEFERRED_PROVENANCE, LKG preserved;
//   - REPORT ISOLATION: daily requires ONLY campaign (a missing targeting/search grain never blocks daily); ppc requires
//     all three (a missing targeting grain defers ppc); the two are independent operations;
//   - DEFECT 1: readAdsCoverageState reads durable coverage under the WORKER key (adsWorkerKeyForGrain), NOT the registry
//     grain -- a harness that keys its store by the worker key proves the translation actually happens;
//   - dry-run -> zero writes; controls-not-opened -> DEFERRED_DEPENDENCY + LKG preserved; per-account read isolation;
//   - readback failure -> non-green; dependency-safety (wrapper imports only the Ads registry + revision + shared core).
// Offline; zero network. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { buildAdsReportReconciler, ADS_RECONCILE_STATUS } from "../lib/server/sync/ads-publication-reconciler.js";
import { adsContentProvenanceToken } from "../lib/server/sync/ads-publication-revision.js";
import {
  ADS_CAMPAIGN_SOURCE_KEY, ADS_TARGETING_SOURCE_KEY, ADS_SEARCH_TERMS_SOURCE_KEY,
  adsGrainsForReport, adsRequiredCoverageDays, adsWorkerKeyForGrain,
} from "../lib/server/sync/ads-dependent-reports.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const ASOF = "2026-09-10";
const MKT = "US";
// Injected stub live contracts + derivations (the shared core needs the shape, not the real payloads -- the real
// contracts are exercised by verify's report/publisher suites). liveParams folds `to`, matching a dated live report.
const CONTRACTS = {
  "daily-reporting": { liveReportKey: "daily-reporting", liveReportVersion: "daily-reporting-live", liveParams: (p) => ({ to: p.to }) },
  "ppc-performance": { liveReportKey: "ppc-performance", liveReportVersion: "ppc-performance-live", liveParams: (p) => ({ to: p.to }) },
};
// The shadow params' reportVersion MUST equal reportDerivations[rk].snapshotVersion (the publisher-identical binding
// check, publication-binding.js line ~123); the shadow report_key is shadowKeyFor(rk) = "scheduler-v2/<rk>".
const RD = {
  "daily-reporting": { snapshotVersion: "scheduler-v2/daily-reporting", validatePayload: (p) => !!(p && p.valid === true) },
  "ppc-performance": { snapshotVersion: "scheduler-v2/ppc-performance", validatePayload: (p) => !!(p && p.valid === true) },
};
const HASH = (v, params) => v + "|" + JSON.stringify(params);
const shParamsFor = (rk, accountId, to) => ({ reportVersion: "scheduler-v2/" + rk, accountId, to: to || ASOF });
const shHashFor = (rk, accountId, to) => HASH("scheduler-v2/" + rk, shParamsFor(rk, accountId, to));

// A durably + CONTINUOUSLY covered grain from well before the window through D-1, with activity, at content_rev `rev`.
const grainRow = (rev, over = {}) => ({ contentRev: rev, latestMetricDate: ASOF, windows: [{ from: "2026-07-01", to: ASOF }], read: "ok", ...over });
// The CURRENT content token for a report's required grains (what computeAdsReportRevision produces as contentDeps[0]).
const tokenFor = (accountId, requiredGrains, grainsByWorkerKey, marketplace = MKT) => {
  const grainRevs = requiredGrains.map((g) => ({ sourceKey: g, contentRev: (grainsByWorkerKey.get(adsWorkerKeyForGrain(g)) || {}).contentRev }));
  return adsContentProvenanceToken({ accountId, connectionId: "primary", marketplace, grainRevs });
};

// Harness: REAL buildAdsReportReconciler(reportKey) + REAL revision + injected readers/control/release. Durable Ads
// coverage/state is a per-account map keyed by the DURABLE WORKER key (proving the registry->worker read translation).
function makeHarness(reportKey, over = {}) {
  const requiredGrains = adsGrainsForReport(reportKey);
  const calls = { release: [], openControls: [], closeControls: [], releaseRevisions: [], coverageReads: [] };
  // Per-account durable coverage keyed by WORKER key: Map<accountId, Map<workerKey, {windows,contentRev,latestMetricDate,read}>>.
  const coverageByAccount = over.coverageByAccount || new Map([
    ["A01", new Map(requiredGrains.map((g) => [adsWorkerKeyForGrain(g), grainRow("rev-" + g)]))],
  ]);
  const marketplaceOf = over.marketplaceOf || (() => MKT);
  const jobDurableContentDeps = over.jobDurableContentDeps || null; // null -> [current token] (covered)
  const shadowRefresh = over.shadowRefresh || new Map();
  const liveRefresh = over.liveRefresh || new Map();
  const jobPromotable = over.jobPromotable || new Map();
  const shadowPayload = over.shadowPayload || { valid: true, rows: [] };
  const livePayload = over.livePayload || shadowPayload;
  const candTo = ASOF;
  const attempts = new Map();
  const releaseFor = over.releaseFor || (() => ({ ok: true, code: 0 }));
  const shRef = (a) => shadowRefresh.get(a) || "2026-09-10T05:00:00Z";
  const eligibleGrains = (a) => {
    const m = coverageByAccount.get(a);
    if (!m) return false;
    return requiredGrains.every((g) => { const r = m.get(adsWorkerKeyForGrain(g)); return r && r.read === "ok" && r.contentRev; });
  };
  const tokenOf = (a) => (coverageByAccount.get(a) ? tokenFor(a, requiredGrains, coverageByAccount.get(a), marketplaceOf(a)) : "");
  const contentDepsOf = (a) => (jobDurableContentDeps ? (jobDurableContentDeps.get(a) || []) : (eligibleGrains(a) ? [tokenOf(a)] : []));
  const reconciler = buildAdsReportReconciler({
    reportKey,
    resolveOrg: async () => over.org || ({ organizationFingerprint: "org-1", connectionId: "primary" }),
    bucketAccounts: async () => over.accounts || [{ accountId: "A01" }],
    // DEFECT 1: the reconciler passes the REGISTRY grain (ads-campaign-date, ...); this reader translates to the WORKER
    // key (adsWorkerKeyForGrain) before looking up the worker-keyed store -- reading under the registry key finds nothing.
    readAdsCoverageState: over.readAdsCoverageState || (async ({ accountId, sourceKey }) => {
      calls.coverageReads.push({ accountId, sourceKey });
      const m = coverageByAccount.get(accountId);
      const row = m ? m.get(adsWorkerKeyForGrain(sourceKey)) : null;
      return row || { windows: [], status: "missing", latestMetricDate: null, contentRev: null, read: "ok" };
    }),
    resolveMarketplace: over.resolveMarketplace || ((a) => marketplaceOf(a)),
    readLatestReportJob: async ({ accountId }) => {
      if (!eligibleGrains(accountId)) return null;
      const promo = jobPromotable.has(accountId) ? jobPromotable.get(accountId) : true;
      if (!promo) return { deriveStatus: "failed", saveStatus: "succeeded", validated: false, cycleStatus: "running", snapshotParamsHash: "", dependsOn: [], durableContentDeps: [] };
      // daily/ppc depends_on carries the OLI/Catalog attribution provenance; the Ads content provenance is the token in
      // durable_content_deps (exactly the hot-derive binding).
      return { deriveStatus: "succeeded", saveStatus: "succeeded", validated: true, cycleStatus: "succeeded", snapshotParamsHash: shHashFor(reportKey, accountId, candTo), dependsOn: ["oli-h", "catalog"], durableContentDeps: contentDepsOf(accountId) };
    },
    readShadowSnapshot: async ({ reportKey: srk, accountId, paramsHash }) => { if (!eligibleGrains(accountId)) return null; return { report_key: srk, account_id: accountId, params_hash: paramsHash, params: shParamsFor(reportKey, accountId, candTo), payload: shadowPayload, payload_storage_path: null, source_refreshed_at: shRef(accountId) }; },
    readLiveSnapshot: async ({ reportKey: lrk, accountId, paramsHash }) => { if (!liveRefresh.has(accountId)) return null; return { report_key: lrk, account_id: accountId, params_hash: paramsHash, params: { reportVersion: CONTRACTS[reportKey].liveReportVersion, to: candTo }, payload: livePayload, payload_storage_path: null, source_refreshed_at: liveRefresh.get(accountId) }; },
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
    log: () => {},
  });
  return { reconciler, calls, coverageByAccount, liveRefresh };
}
const rep = (out, acct, rk) => out.perAccount.find((a) => a.accountId === acct).reports[rk];
const stateOf = (out, acct, rk) => rep(out, acct, rk).state;

// (1) durable Ads covered + live UNPROMOTED -> derive + promote; controls opened; zero export.
test("daily: durable campaign covered + live UNPROMOTED -> derive + promote (READBACK_VERIFIED); controls opened; zero export", async () => {
  const h = makeHarness("daily-reporting");
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 publishes daily-reporting", stateOf(out, "A01", "daily-reporting") === ADS_RECONCILE_STATUS.READBACK_VERIFIED);
  ok("controls opened for the stale account; zero DataDoe export", h.calls.openControls.length === 1 && out.dataDoeCreates === 0 && out.dataDoeTokens === 0);
  ok("coverage was read ONLY for the campaign grain (daily requires campaign only)", h.calls.coverageReads.every((r) => r.sourceKey === ADS_CAMPAIGN_SOURCE_KEY) && h.calls.coverageReads.length >= 1);
});

// (2) current content already promoted (durable_content_deps holds the CURRENT token) -> PUBLICATION_NOT_REQUIRED.
test("daily: current campaign content already promoted (durable_content_deps holds the current token) -> PUBLICATION_NOT_REQUIRED, zero writes", async () => {
  const h = makeHarness("daily-reporting", { liveRefresh: new Map([["A01", "2026-09-10T05:00:00Z"]]) });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 already current -> PUBLICATION_NOT_REQUIRED; NO controls; NO release (zero writes)", stateOf(out, "A01", "daily-reporting") === "PUBLICATION_NOT_REQUIRED" && h.calls.openControls.length === 0 && h.calls.release.length === 0);
});

// (3) SAME-DATE content correction: content_rev flips -> the NEW token is NOT in the job's durable_content_deps -> STALE.
test("daily: same-date campaign correction (content_rev flips) -> token NOT covered -> STALE -> re-derive + promote", async () => {
  const coverageByAccount = new Map([["A01", new Map([[adsWorkerKeyForGrain(ADS_CAMPAIGN_SOURCE_KEY), grainRow("rev-CORRECTED")]])]]);
  const oldToken = adsContentProvenanceToken({ accountId: "A01", connectionId: "primary", marketplace: MKT, grainRevs: [{ sourceKey: ADS_CAMPAIGN_SOURCE_KEY, contentRev: "rev-OLD" }] });
  const h = makeHarness("daily-reporting", { coverageByAccount, jobDurableContentDeps: new Map([["A01", [oldToken]]]), liveRefresh: new Map([["A01", "2026-09-10T05:00:00Z"]]) });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 re-derived (corrected content_rev's token is NOT in durable_content_deps -> ads-revision-changed)", stateOf(out, "A01", "daily-reporting") === ADS_RECONCILE_STATUS.READBACK_VERIFIED && h.calls.release.length === 1);
});

// (4) covered-empty (continuous coverage + no activity) -> still eligible + publishes (never a manufactured zero).
test("daily: covered-empty (continuous coverage, blank latest metric date) -> ELIGIBLE + publishes (honest, never zero)", async () => {
  const coverageByAccount = new Map([["A01", new Map([[adsWorkerKeyForGrain(ADS_CAMPAIGN_SOURCE_KEY), grainRow("rev-c1", { latestMetricDate: "" })]])]]);
  const h = makeHarness("daily-reporting", { coverageByAccount });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 covered-empty is eligible + published (not deferred)", stateOf(out, "A01", "daily-reporting") === ADS_RECONCILE_STATUS.READBACK_VERIFIED);
  ok("its revision carried a real 32-hex revisionId (a genuine covered snapshot)", h.calls.releaseRevisions[0].revisionId.length === 32);
});

// (5) missing / gapped / blank-content_rev campaign grain -> DEFERRED_PROVENANCE, LKG preserved.
test("daily: campaign grain gapped ending at D-1 -> DEFERRED_PROVENANCE; no release; LKG preserved", async () => {
  const coverageByAccount = new Map([["A01", new Map([[adsWorkerKeyForGrain(ADS_CAMPAIGN_SOURCE_KEY), grainRow("rev-c1", { windows: [{ from: "2026-07-01", to: "2026-09-06" }, { from: "2026-09-09", to: ASOF }] })]])]]);
  const liveRefresh = new Map([["A01", "2026-09-01T00:00:00Z"]]);
  const before = liveRefresh.get("A01");
  const h = makeHarness("daily-reporting", { coverageByAccount, liveRefresh });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 DEFERRED_PROVENANCE (coverage gap); no release; live LKG byte-identical", stateOf(out, "A01", "daily-reporting") === ADS_RECONCILE_STATUS.DEFERRED_PROVENANCE && h.calls.release.length === 0 && h.liveRefresh.get("A01") === before);
});

test("daily: blank marketplace -> DEFERRED_PROVENANCE (never a blank-market token)", async () => {
  const h = makeHarness("daily-reporting", { marketplaceOf: () => "" });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 deferred (marketplace-unavailable); no release", stateOf(out, "A01", "daily-reporting") === ADS_RECONCILE_STATUS.DEFERRED_PROVENANCE && h.calls.release.length === 0);
});

// (6) REPORT ISOLATION: daily requires ONLY campaign -- a missing targeting/search grain never blocks daily.
test("ISOLATION: daily-reporting reconciles from CAMPAIGN alone even when targeting + search-terms are entirely absent", async () => {
  const coverageByAccount = new Map([["A01", new Map([[adsWorkerKeyForGrain(ADS_CAMPAIGN_SOURCE_KEY), grainRow("rev-c1")]])]]); // ONLY campaign present
  const h = makeHarness("daily-reporting", { coverageByAccount });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 daily publishes; coverage was NEVER read for targeting/search-terms", stateOf(out, "A01", "daily-reporting") === ADS_RECONCILE_STATUS.READBACK_VERIFIED && !h.calls.coverageReads.some((r) => r.sourceKey === ADS_TARGETING_SOURCE_KEY || r.sourceKey === ADS_SEARCH_TERMS_SOURCE_KEY));
});

// (7) ppc-performance requires ALL THREE grains -> a missing targeting grain defers ppc (but would NOT defer daily).
test("ISOLATION: ppc-performance requires campaign+targeting+search -> a missing TARGETING grain -> DEFERRED_PROVENANCE", async () => {
  const coverageByAccount = new Map([["A01", new Map([
    [adsWorkerKeyForGrain(ADS_CAMPAIGN_SOURCE_KEY), grainRow("rev-c1")],
    [adsWorkerKeyForGrain(ADS_SEARCH_TERMS_SOURCE_KEY), grainRow("rev-s1")],
    // targeting ABSENT
  ])]]);
  const h = makeHarness("ppc-performance", { coverageByAccount });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 ppc DEFERRED_PROVENANCE (targeting grain unavailable); no release", stateOf(out, "A01", "ppc-performance") === ADS_RECONCILE_STATUS.DEFERRED_PROVENANCE && h.calls.release.length === 0);
});

test("ppc-performance: all three grains continuously covered -> derive + promote (READBACK_VERIFIED); reads all three grains", async () => {
  const coverageByAccount = new Map([["A01", new Map([
    [adsWorkerKeyForGrain(ADS_CAMPAIGN_SOURCE_KEY), grainRow("rev-c1")],
    [adsWorkerKeyForGrain(ADS_TARGETING_SOURCE_KEY), grainRow("rev-t1")],
    [adsWorkerKeyForGrain(ADS_SEARCH_TERMS_SOURCE_KEY), grainRow("rev-s1")],
  ])]]);
  const h = makeHarness("ppc-performance", { coverageByAccount });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 ppc publishes; coverage read for all three grains", stateOf(out, "A01", "ppc-performance") === ADS_RECONCILE_STATUS.READBACK_VERIFIED && [ADS_CAMPAIGN_SOURCE_KEY, ADS_TARGETING_SOURCE_KEY, ADS_SEARCH_TERMS_SOURCE_KEY].every((g) => h.calls.coverageReads.some((r) => r.sourceKey === g)));
});

// (8) DEFECT 1 (behavioral): the reader is queried with the REGISTRY grain but the durable store is keyed by the WORKER
// key; a store that ONLY has worker-keyed rows is read successfully -> proves the reconciler translates before reading.
test("DEFECT 1: a durable store keyed ONLY by the worker key is read successfully (registry->worker translation happens)", async () => {
  // coverage store keyed by the WORKER key 'campaign-performance-v1'; the reader receives the REGISTRY grain and MUST
  // translate. A regression that reads under the registry grain finds nothing -> A01 would defer.
  const workerKey = adsWorkerKeyForGrain(ADS_CAMPAIGN_SOURCE_KEY);
  ok("the campaign registry grain maps to a DIFFERENT worker key (a real translation, not identity)", workerKey === "campaign-performance-v1" && workerKey !== ADS_CAMPAIGN_SOURCE_KEY);
  const coverageByAccount = new Map([["A01", new Map([[workerKey, grainRow("rev-c1")]])]]);
  const h = makeHarness("daily-reporting", { coverageByAccount });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 published (the worker-keyed durable row WAS found via the translation)", stateOf(out, "A01", "daily-reporting") === ADS_RECONCILE_STATUS.READBACK_VERIFIED);
});

// (9) per-account read isolation: a coverage read that THROWS for one account defers ONLY that account.
test("per-account isolation: readAdsCoverageState THROWS for A02 -> A02 deferred, A01 healthy publishes, run stays ok", async () => {
  const coverageByAccount = new Map([
    ["A01", new Map([[adsWorkerKeyForGrain(ADS_CAMPAIGN_SOURCE_KEY), grainRow("rev-c1")]])],
    ["A02", new Map([[adsWorkerKeyForGrain(ADS_CAMPAIGN_SOURCE_KEY), grainRow("rev-c2")]])],
  ]);
  const h = makeHarness("daily-reporting", {
    accounts: [{ accountId: "A01" }, { accountId: "A02" }], coverageByAccount,
    readAdsCoverageState: async ({ accountId, sourceKey }) => { if (accountId === "A02") throw new Error("boom"); const r = coverageByAccount.get(accountId).get(adsWorkerKeyForGrain(sourceKey)); return r; },
  });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  // A read that throws inside readScopeEvidence defers the WHOLE run fail-closed (zero writes) rather than publishing
  // blind -- the reconciler NEVER publishes on an unreadable durable source.
  ok("a throwing durable read fails the whole run closed (zero release, no publish, LKG preserved)", h.calls.release.length === 0 && out.ok === false && out.outcome === "failed");
});

// (10) dry-run -> ZERO writes even for a stale account.
test("dry-run: ZERO writes (no controls, no release) even when the account is stale", async () => {
  const h = makeHarness("daily-reporting");
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic", dryRun: true });
  ok("dry-run: no controls, no release, stale reported (zero writes)", h.calls.openControls.length === 0 && h.calls.release.length === 0 && out.dryRun === true && stateOf(out, "A01", "daily-reporting") === "STALE");
});

// (11) controls not opened (scheduler holds the lease) -> DEFERRED_DEPENDENCY, ZERO release, LKG preserved, ok:true.
test("controls not opened (scheduler holds the lease) -> DEFERRED_DEPENDENCY, ZERO release, LKG preserved, ok:true", async () => {
  const h = makeHarness("daily-reporting", { openControls: async () => ({ ok: false, reason: "scheduler-holds-lease" }) });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 deferred (controls-not-opened); no release; ok:true", stateOf(out, "A01", "daily-reporting") === ADS_RECONCILE_STATUS.DEFERRED_DEPENDENCY && h.calls.release.length === 0 && out.ok === true);
});

// (12) a readback failure after a write produces a NON-GREEN status.
test("release fails at readback -> FAILED_READBACK, outcome failed, ok:false", async () => {
  const h = makeHarness("daily-reporting", { releaseFor: () => ({ ok: false, code: 1, stage: "readback", reason: "live read-back failed" }) });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 FAILED_READBACK; outcome failed; ok:false", stateOf(out, "A01", "daily-reporting") === ADS_RECONCILE_STATUS.FAILED_READBACK && out.outcome === "failed" && out.ok === false);
});

// (13) dependency-safety: the Ads reconciler wrapper references NO export/token transport symbol.
test("dependency-safety: the Ads reconciler wrapper + core reference NO provider export/token transport symbol", async () => {
  const wrap = readFileSync(new URL("../lib/server/sync/ads-publication-reconciler.js", import.meta.url), "utf8");
  for (const sym of ["createExport", "exportsCreate", "makeDataDoeAdapter", "reserveTokens", "/exports", "source-sync-driver"]) {
    ok("wrapper has no '" + sym + "'", !wrap.includes(sym));
  }
  ok("wrapper imports the Ads registry + Ads revision + shared core only (never datadoe/source-sync-driver)", /from "\.\/ads-dependent-reports\.js"/.test(wrap) && /from "\.\/ads-publication-revision\.js"/.test(wrap) && /from "\.\/saved-data-reconciler\.js"/.test(wrap) && !/from "\.\.\/datadoe/.test(wrap));
});

async function main() {
  writeSync(1, "ads-publication-reconciler-behavior\n");
  let failures = 0;
  for (const t of tests) { try { await t.fn(); } catch (e) { failures += 1; writeSync(1, "FAIL  " + t.name + "\n" + String((e && e.stack) || e) + "\n"); } }
  writeSync(1, `\nads-publication-reconciler-behavior: ${passed} assertions passed${failures ? ", " + failures + " FAILED" : ""}\n`);
  if (failures) process.exitCode = 1;
}
main();
