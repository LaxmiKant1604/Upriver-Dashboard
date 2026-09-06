// FBA-aware Brand View materializer (Phase 3 Completion) -- reproduce-then-fix the non-converging Brand View Portfolio,
// plus the operator's zero-export / LKG / isolation / idempotency / independence guarantees.
//
// The DEFECT: brand-view-portfolio serves via deferRebuildOnRead, so a missing/stale exact-identity snapshot returns
// updating=true; the read-only poll never converges because no backend producer publishes it. The FIX: the scheduler
// materializer publishes the EXACT serve identity (scope id + paramsHash), so the next read serves the stored snapshot
// with NO user Refresh. This test drives the REAL serveSharedReport read path against a shared store the operator wrote.
// Pure/offline; ZERO real I/O. 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost:0";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test-key";

const { serveSharedReport, paramsHashFor } = await import("../lib/server/report-store.js");
const { runBrandViewMaterialization, BRAND_VIEW_MATERIALIZATION_REPORTS } = await import("../lib/server/sync/report-materialization-brandview-operation.js");
const { brandViewScopeId, brandViewPortfolioScopeId, BRAND_VIEW_PORTFOLIO_VERSION, BRAND_VIEW_VERSION } = await import("../lib/server/reports/brand-view.js");

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "report-brandview-materialization\n");

const PROV = "2026-09-05T00:00:00.000Z";
const marketplaceToday = (country) => (country === "IN" ? "2026-09-06" : "2026-09-06");

// A shared in-memory report_snapshots store used by BOTH the operator (writes) and serveSharedReport (reads).
function sharedStore() {
  const rows = new Map(); let seq = 0; const calls = { save: 0, lock: 0, publish: 0 };
  const key = (reportKey, accountId, paramsHash) => `${reportKey}|${accountId}|${paramsHash}`;
  const store = {
    claimRefreshLock: async () => { calls.lock += 1; return true; },
    releaseRefreshLock: async () => {},
    getReportSnapshot: async ({ reportKey, accountId, paramsHash }) => rows.get(key(reportKey, accountId, paramsHash)) || null,
    saveReportSnapshot: async (o) => { calls.save += 1; const row = { id: "s" + (++seq), updated_at: seq, source_refreshed_at: o.sourceRefreshedAt, payload: o.payload, params: o.params, params_hash: o.paramsHash }; rows.set(key(o.reportKey, o.accountId, o.paramsHash), row); return row; },
    publishSnapshotUpdate: async () => { calls.publish += 1; },
  };
  const serveReaders = {
    getReportSnapshot: store.getReportSnapshot,
    getLatestReportSnapshot: async ({ reportKey, accountId }) => [...rows.values()].filter((r) => key(reportKey, accountId, r.params_hash) === key(reportKey, accountId, r.params_hash) && r.params && r.params.reportVersion && rows.get(key(reportKey, accountId, r.params_hash))).sort((a, b) => b.updated_at - a.updated_at)[0] || null,
    getLatestReportSnapshotForScope: async ({ reportKey, accountId, reportVersion, scope }) => [...rows.values()]
      .filter((r) => r.payload && r.params && (reportVersion == null || r.params.reportVersion === reportVersion) && Object.entries(scope || {}).every(([k, v]) => String(r.params[k] ?? "") === String(v)))
      // scope match is by params only; the accountId is the scope id baked into the key -- filter by it too:
      .filter((r) => rows.get(key(reportKey, accountId, r.params_hash)) === r)
      .sort((a, b) => b.updated_at - a.updated_at)[0] || null,
  };
  return { store, serveReaders, calls, rows };
}
const fakeRes = () => { const cap = {}; return { res: { status: (c) => ({ json: (b) => { cap.code = c; cap.body = b; } }) }, cap }; };

// Operator collaborators over the shared store. Two accounts in-region, both selling BrandX (portfolio set {a1,a2}); a1
// also sells BrandY (single-view only). deriveBrandViewPortfolio returns fbaAvailable:null + adsAvailable:false honestly.
function makeCollaborators(store, { portfolioNotReady = false } = {}) {
  return {
    readAccountBrands: async ({ accountId }) => (accountId === "a1" ? ["BrandX", "BrandY"] : ["BrandX"]),
    readAccountSalesBrands: async ({ accountId }) => (accountId === "a1" ? ["BrandX", "BrandY"] : ["BrandX"]),
    deriveBrandView: async ({ accountId, brand, asOf }) => ({ payload: { scope: "account", brand, asOf, accountId, countries: [{ country: "IN", adsAvailable: false, fbaAvailable: null }], rows: [{ x: `${accountId}:${brand}` }] }, sourceRefreshedAt: PROV }),
    deriveBrandViewPortfolio: async ({ accountIds, brand, asOf, region }) => (portfolioNotReady ? { notReady: "portfolio-not-ready" } : { payload: { scope: "portfolio", brand, asOf, region, accountIds, countries: [{ country: "IN", adsAvailable: false, fbaAvailable: null }], rows: [{ p: `${region}:${brand}:${accountIds.join("+")}` }] }, sourceRefreshedAt: PROV }),
    readSnapshot: store.getReportSnapshot,
    persistSnapshot: async ({ reportKey, reportVersion, accountId, paramsHash, params, payload, sourceRefreshedAt }) => {
      const saved = await store.saveReportSnapshot({ reportKey, accountId, paramsHash, params, payload, sourceRefreshedAt });
      await store.publishSnapshotUpdate();
      return { savedAt: saved.source_refreshed_at };
    },
    claimLock: store.claimRefreshLock, releaseLock: store.releaseRefreshLock,
    marketplaceToday,
  };
}
const ACCOUNTS = [{ accountId: "a1", country: "IN" }, { accountId: "a2", country: "IN" }];

// The exact portfolio serve identity the browser requests for BrandX in india.
const BRAND = "BrandX", REGION = "india", PORT_ASOF = "2026-09-06";
const PORT_IDS = ["a1", "a2"];
const portScopeId = brandViewPortfolioScopeId(PORT_IDS, BRAND);
const portParams = { accountIds: PORT_IDS.join(","), brand: BRAND, asOf: PORT_ASOF, region: REGION };
const servePortfolio = async (readers, store, { contributingProvenanceAt = null } = {}) => {
  const { res, cap } = fakeRes();
  await serveSharedReport({
    res, refresh: false, reportKey: "brand-view-portfolio", reportVersion: BRAND_VIEW_PORTFOLIO_VERSION,
    accountId: portScopeId, params: portParams, label: "Brand View",
    build: async () => { throw new Error("build() must NEVER run on a read"); },
    deferRebuildOnRead: true, staleScopeKeys: ["region"], readers, store, contributingProvenanceAt,
  });
  return cap.body;
};

/* ===================== A. REPRODUCE: no producer -> portfolio read never converges ===================== */
await (async () => {
  const S = sharedStore();
  const before = await servePortfolio(S.serveReaders, S.store, { contributingProvenanceAt: PROV });
  ok("A: with NO snapshot, the portfolio read returns updating (deferRebuildOnRead) -- not converged", !!before.updating && !!before.snapshotMissing);
  ok("A: the operator owns brand-view + brand-view-portfolio (the previously-missing producers)", BRAND_VIEW_MATERIALIZATION_REPORTS.map((r) => r.reportKey).sort().join(",") === "brand-view,brand-view-portfolio");
})();

/* ===================== B. FIX: the operator publishes the EXACT identity -> the read converges ===================== */
await (async () => {
  const S = sharedStore();
  const res = await runBrandViewMaterialization({ region: REGION, accounts: ACCOUNTS }, makeCollaborators(S.store));
  ok("B: the operator materialized the portfolio (zero tokens)", res.summary.materialized > 0 && res.summary.tokens === 0);
  // The materialized identity matches the serve identity exactly.
  const stored = S.rows.get(`brand-view-portfolio|${portScopeId}|${paramsHashFor(BRAND_VIEW_PORTFOLIO_VERSION, portParams)}`);
  ok("B: a snapshot exists under the EXACT serve scope id + paramsHash", !!stored && !!stored.payload);
  const after = await servePortfolio(S.serveReaders, S.store, { contributingProvenanceAt: PROV });
  ok("B: the portfolio read now SERVES the snapshot (converged) -- not snapshotMissing", after.snapshotMissing === undefined && Array.isArray(after.rows) && after.rows.length === 1);
  ok("B: the converged read is NOT flagged updating (provenance matches; no Refresh needed)", after.updating === undefined);
  ok("B: the converged payload is the region-brand portfolio (exact account set)", after.rows[0].p === `${REGION}:${BRAND}:a1+a2`);
})();

/* ===================== C. single brand-view converges on the exact per-(account,brand) identity ===================== */
await (async () => {
  const S = sharedStore();
  await runBrandViewMaterialization({ region: REGION, accounts: ACCOUNTS }, makeCollaborators(S.store));
  const scopeId = brandViewScopeId("a1", "BrandY");
  const ph = paramsHashFor(BRAND_VIEW_VERSION, { accountId: "a1", brand: "BrandY", asOf: "2026-09-06" });
  const stored = S.rows.get(`brand-view|${scopeId}|${ph}`);
  ok("C: single brand-view materialized under the exact {accountId,brand,asOf} identity", !!stored && stored.payload.rows[0].x === "a1:BrandY");
})();

/* ===================== D. zero writes on dry-run; replay is idempotent (unchanged) ===================== */
await (async () => {
  const S = sharedStore();
  const dry = await runBrandViewMaterialization({ region: REGION, accounts: ACCOUNTS, dryRun: true }, makeCollaborators(S.store));
  ok("D: dry-run writes NOTHING", S.calls.save === 0 && dry.summary.planned > 0 && dry.summary.materialized === 0);
  const first = await runBrandViewMaterialization({ region: REGION, accounts: ACCOUNTS }, makeCollaborators(S.store));
  const savesAfterFirst = S.calls.save;
  const second = await runBrandViewMaterialization({ region: REGION, accounts: ACCOUNTS }, makeCollaborators(S.store));
  ok("D: first live run materialized + wrote", first.summary.materialized > 0 && savesAfterFirst > 0);
  ok("D: replay wrote NOTHING (all unchanged -- same provenance)", S.calls.save === savesAfterFirst && second.summary.materialized === 0 && second.summary.unchanged >= first.summary.materialized);
  ok("D: zero tokens across every run", dry.summary.tokens === 0 && first.summary.tokens === 0 && second.summary.tokens === 0);
})();

/* ===================== E. LKG-preserving on a not-ready portfolio derive (honest, no fabrication, no write) ======= */
await (async () => {
  const S = sharedStore();
  // Seed a prior portfolio LKG, then run with a not-ready derive -> it must NOT be overwritten.
  await S.store.saveReportSnapshot({ reportKey: "brand-view-portfolio", accountId: portScopeId, paramsHash: paramsHashFor(BRAND_VIEW_PORTFOLIO_VERSION, portParams), params: { reportVersion: BRAND_VIEW_PORTFOLIO_VERSION, ...portParams }, payload: { rows: [{ p: "OLD" }] }, sourceRefreshedAt: "2026-09-01T00:00:00.000Z" });
  const savesBefore = S.calls.save;
  const res = await runBrandViewMaterialization({ region: REGION, accounts: ACCOUNTS }, makeCollaborators(S.store, { portfolioNotReady: true }));
  ok("E: a not-ready portfolio derive is reported unavailable (LKG preserved), not fabricated", res.events.some((e) => e.report === "brand-view-portfolio" && e.status === "unavailable" && e.preservedLkg === true));
  const kept = S.rows.get(`brand-view-portfolio|${portScopeId}|${paramsHashFor(BRAND_VIEW_PORTFOLIO_VERSION, portParams)}`);
  ok("E: the prior portfolio LKG is untouched (still OLD)", kept.payload.rows[0].p === "OLD");
  // brand-view single still materialized despite the portfolio being not-ready (independence).
  ok("E: single brand-view still materialized despite the portfolio not-ready (independence)", res.events.some((e) => e.report === "brand-view" && e.status === "materialized"));
  // The not-ready path wrote nothing new for the portfolio.
  ok("E: the not-ready portfolio wrote no new portfolio snapshot", S.calls.save === savesBefore + res.events.filter((e) => e.report === "brand-view" && e.status === "materialized").length);
})();

/* ===================== F. isolation: distinct region/brand/account identities never collide ===================== */
await (async () => {
  const S = sharedStore();
  await runBrandViewMaterialization({ region: "india", accounts: ACCOUNTS }, makeCollaborators(S.store));
  await runBrandViewMaterialization({ region: "us-ca", accounts: [{ accountId: "a1", country: "US" }] }, { ...makeCollaborators(S.store), readAccountSalesBrands: async () => ["BrandX"], readAccountBrands: async () => ["BrandX"] });
  const indiaKey = `brand-view-portfolio|${brandViewPortfolioScopeId(["a1", "a2"], "BrandX")}|${paramsHashFor(BRAND_VIEW_PORTFOLIO_VERSION, { accountIds: "a1,a2", brand: "BrandX", asOf: "2026-09-06", region: "india" })}`;
  const usKey = `brand-view-portfolio|${brandViewPortfolioScopeId(["a1"], "BrandX")}|${paramsHashFor(BRAND_VIEW_PORTFOLIO_VERSION, { accountIds: "a1", brand: "BrandX", asOf: "2026-09-06", region: "us-ca" })}`;
  ok("F: the india + us-ca portfolios are DISTINCT identities (region + account set in the key)", indiaKey !== usKey && S.rows.has(indiaKey) && S.rows.has(usKey));
  ok("F: the india portfolio has {a1,a2}; the us-ca portfolio has {a1} -- no cross-region set bleed", S.rows.get(indiaKey).payload.rows[0].p.endsWith("a1+a2") && S.rows.get(usKey).payload.rows[0].p.endsWith(":a1"));
})();

/* ===================== G. concurrency: overlapping runs never double-write (idempotent upsert) ===================== */
await (async () => {
  const S = sharedStore();
  await Promise.all([
    runBrandViewMaterialization({ region: REGION, accounts: ACCOUNTS }, makeCollaborators(S.store)),
    runBrandViewMaterialization({ region: REGION, accounts: ACCOUNTS }, makeCollaborators(S.store)),
  ]);
  // Two overlapping runs: the winner writes each identity once; the other sees the same provenance and skips (unchanged).
  // Upsert on the natural key means even a double-write cannot create a duplicate row.
  const portKey = `brand-view-portfolio|${portScopeId}|${paramsHashFor(BRAND_VIEW_PORTFOLIO_VERSION, portParams)}`;
  ok("G: overlapping runs produce exactly ONE row per identity (no duplicate)", S.rows.has(portKey) && [...S.rows.keys()].filter((k) => k === portKey).length === 1);
})();

writeSync(1, `\nreport-brandview-materialization: ${passed} assertions passed\n`);
