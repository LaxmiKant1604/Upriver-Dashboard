// Scheduler-owned report materialization operator (Phase 3, Increment 1) -- behavior proof.
//
// Proves the pure operator core (report-materialization-operation.js) against an in-memory fake store + fake derives:
//   - ZERO export/token on every path (no DataDoe collaborator exists; every event + the summary report tokens 0);
//   - materializes every eligible (account x report) unit under the EXACT identity the serve reads (paramsHashFor +
//     the real report versions), so a later page GET finds the snapshot;
//   - HONEST + LKG-preserving: a not-ready derive writes NOTHING and never clobbers an existing snapshot;
//   - INDEPENDENT: one derive throwing does not abort the other units/accounts;
//   - IDEMPOTENT / replay-safe: a second run on unchanged evidence writes nothing (all "unchanged");
//   - ISOLATED by identity: per-brand SKU Movement snapshots never collide or cross-contaminate;
//   - dry-run writes nothing; prefixed (dd-secondary) ids are skipped; a held lock yields locked-skip (no write).
// Pure/offline; ZERO real I/O. 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { runReportMaterialization, summarize } from "../lib/server/sync/report-materialization-operation.js";
import { paramsHashFor } from "../lib/server/report-store.js";
import { RETURNS_ADVANCED_VERSION } from "../lib/server/reports/returns-advanced.js";
import { SKU_MOVEMENT_VERSION } from "../lib/server/reports/sku-movement-backfill.js";
import { BRAND_VIEW_BRANDS_VERSION } from "../lib/server/reports/brand-view.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "report-materialization-operation\n");

const skuHash = (asOf, brand) => paramsHashFor(SKU_MOVEMENT_VERSION, { asOf, brand });
const bvbHash = (accountId) => paramsHashFor(BRAND_VIEW_BRANDS_VERSION, { accountId });
const key = (reportKey, accountId, paramsHash) => `${reportKey}|${accountId}|${paramsHash}`;

// Build a fresh set of fake collaborators + an in-memory snapshot store. `plans[accountId]` describes the derives.
function makeHarness(plans, { lockAlwaysFails = false } = {}) {
  const store = new Map();
  const calls = { persist: [], claim: [], derive: [] };
  const now = () => new Date("2026-09-06T00:00:00.000Z");

  const collaborators = {
    deriveBrandViewBrands: async ({ accountId }) => {
      calls.derive.push({ report: "brand-view-brands", accountId });
      const p = plans[accountId] || {};
      if (p.brandsThrows) throw new Error("brand-view-brands boom");
      // sources[].savedAt gives a STABLE provenance (evidence-based, not the clock).
      return { accountId, brands: p.brands || [], sources: [{ reportKey: "brand-sales", brandCount: (p.brands || []).length, savedAt: p.bvbProvenance || "2026-09-05T10:00:00.000Z" }], message: "" };
    },
    deriveSkuMovement: async ({ accountId, brand }) => {
      calls.derive.push({ report: "sku-movement", accountId, brand });
      const p = plans[accountId] || {};
      if (p.skuThrows) throw new Error("sku boom");
      if (p.skuNotReady) return { notReady: "not-ready", blockedBy: [{ sourceKey: "order-line-items", reason: "coverage-incomplete" }] };
      const asOf = p.skuAsOf || "2026-09-05";
      return { payload: { rows: [{ asin: `${accountId}-${brand}-A1` }], effectiveAsOf: asOf, brand }, effectiveParams: { asOf, brand }, sourceRefreshedAt: `${asOf}T12:00:00.000Z` };
    },
    deriveReturns: async ({ accountId, asOf }) => {
      calls.derive.push({ report: "returns-leakage", accountId, asOf });
      const p = plans[accountId] || {};
      if (p.returnsThrows) throw new Error("returns boom");
      // Faithful to gatherReturnsEvidence: a blank/invalid asOf is rejected as not-ready. This guards the operator
      // against ever calling the returns derive without a valid YYYY-MM-DD ceiling (else returns never materializes).
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(asOf || ""))) return { notReady: "invalid-asof" };
      if (p.returnsNotReady) return { notReady: "invalid-asof" };
      const to = p.returnsTo || "2026-09-04";
      return { payload: { latestDataDate: to, leakage: [] }, latestDataDate: to, sourceRefreshedAt: `${to}T09:00:00.000Z` };
    },
    readSnapshot: async ({ reportKey, accountId, paramsHash }) => store.get(key(reportKey, accountId, paramsHash)) || null,
    persistSnapshot: async ({ reportKey, accountId, paramsHash, params, payload, sourceRefreshedAt }) => {
      calls.persist.push({ reportKey, accountId, paramsHash, params, sourceRefreshedAt });
      store.set(key(reportKey, accountId, paramsHash), { payload, params, source_refreshed_at: sourceRefreshedAt });
      return { savedAt: sourceRefreshedAt, bytes: JSON.stringify(payload).length };
    },
    claimLock: async ({ reportKey, accountId, paramsHash }) => { calls.claim.push({ reportKey, accountId, paramsHash }); return !lockAlwaysFails; },
    releaseLock: async () => {},
    log: () => {},
  };
  return { store, calls, collaborators, now };
}

/* ===================== A. full materialize -- every eligible unit, zero token, exact identities ============= */
await (async () => {
  const plans = {
    acctA: { brands: ["BrandX", "BrandY"], skuAsOf: "2026-09-05", returnsTo: "2026-09-04" },
    acctB: { brands: [], skuAsOf: "2026-09-05", returnsTo: "2026-09-03" },
  };
  const h = makeHarness(plans);
  const accounts = [{ accountId: "acctA", country: "IN" }, { accountId: "acctB", country: "IN" }];
  const res = await runReportMaterialization({ region: "india", accounts, ceiling: "2026-09-06", now: h.now }, h.collaborators);

  ok("A: ZERO tokens across every event and the summary", res.summary.tokens === 0 && res.events.every((e) => (e.tokens || 0) === 0));
  ok("A: brand-view-brands materialized for both accounts under the exact identity", h.store.has(key("brand-view-brands", "acctA", bvbHash("acctA"))) && h.store.has(key("brand-view-brands", "acctB", bvbHash("acctB"))));
  ok("A: sku-movement materialized ALL + each named brand for acctA (3 snapshots)",
    h.store.has(key("sku-movement", "acctA", skuHash("2026-09-05", "ALL"))) &&
    h.store.has(key("sku-movement", "acctA", skuHash("2026-09-05", "BrandX"))) &&
    h.store.has(key("sku-movement", "acctA", skuHash("2026-09-05", "BrandY"))));
  ok("A: sku-movement materialized ONLY ALL for the brand-less acctB", h.store.has(key("sku-movement", "acctB", skuHash("2026-09-05", "ALL"))) && !h.store.has(key("sku-movement", "acctB", skuHash("2026-09-05", "BrandX"))));
  ok("A: returns-leakage materialized for both under identity { to }", h.store.has(key("returns-leakage", "acctA", paramsHashFor(RETURNS_ADVANCED_VERSION, { to: "2026-09-04" }))) && h.store.has(key("returns-leakage", "acctB", paramsHashFor(RETURNS_ADVANCED_VERSION, { to: "2026-09-03" }))));
  ok("A: every write carries the reportVersion in params (serve-readable identity)", h.calls.persist.every((c) => c.params && c.params.reportVersion));
  // acctA: 1 bvb + 3 sku (ALL,X,Y) + 1 returns = 5; acctB: 1 bvb + 1 sku (ALL) + 1 returns = 3 -> 8 materialized.
  ok("A: summary counts 2 accounts, 8 materialized, 0 unavailable, 0 error", res.summary.accounts === 2 && res.summary.materialized === 8 && res.summary.unavailable === 0 && res.summary.error === 0);
})();

/* ===================== B. LKG-preserving: a not-ready derive writes nothing, never clobbers ================= */
await (async () => {
  const h = makeHarness({ acctC: { brands: ["BrandZ"], skuNotReady: true, returnsNotReady: true } });
  // Seed an existing LKG for acctC's ALL sku snapshot -- it must survive untouched.
  const lkgKey = key("sku-movement", "acctC", skuHash("2026-09-01", "ALL"));
  h.store.set(lkgKey, { payload: { rows: [{ asin: "OLD" }] }, params: { reportVersion: SKU_MOVEMENT_VERSION, asOf: "2026-09-01", brand: "ALL" }, source_refreshed_at: "2026-09-01T00:00:00.000Z" });
  const res = await runReportMaterialization({ region: "india", accounts: [{ accountId: "acctC", country: "IN" }], ceiling: "2026-09-06", now: h.now }, h.collaborators);

  ok("B: a not-ready sku derive is reported unavailable (LKG preserved), not fabricated", res.events.some((e) => e.report === "sku-movement" && e.status === "unavailable" && e.preservedLkg === true));
  ok("B: a not-ready returns derive is reported unavailable", res.events.some((e) => e.report === "returns-leakage" && e.status === "unavailable"));
  ok("B: NO sku/returns snapshot was written on the not-ready path", !h.calls.persist.some((c) => c.reportKey === "sku-movement" || c.reportKey === "returns-leakage"));
  ok("B: the pre-existing LKG snapshot is untouched (still the OLD payload)", h.store.get(lkgKey).payload.rows[0].asin === "OLD");
  ok("B: brand-view-brands still materialized (membership is always derivable)", h.store.has(key("brand-view-brands", "acctC", bvbHash("acctC"))));
})();

/* ===================== C. independence: one throw does not abort the rest ==================================== */
await (async () => {
  const h = makeHarness({ acctD: { brands: ["BrandQ"], returnsThrows: true } });
  const res = await runReportMaterialization({ region: "india", accounts: [{ accountId: "acctD", country: "IN" }], ceiling: "2026-09-06", now: h.now }, h.collaborators);
  ok("C: the throwing returns unit is isolated as an error event", res.events.some((e) => e.report === "returns-leakage" && e.status === "error" && /returns boom/.test(String(e.error))));
  ok("C: sku-movement (ALL + BrandQ) still materialized despite the returns throw", h.store.has(key("sku-movement", "acctD", skuHash("2026-09-05", "ALL"))) && h.store.has(key("sku-movement", "acctD", skuHash("2026-09-05", "BrandQ"))));
  ok("C: brand-view-brands still materialized despite the returns throw", h.store.has(key("brand-view-brands", "acctD", bvbHash("acctD"))));
})();

/* ===================== D. idempotent replay: a second run on unchanged evidence writes nothing =============== */
await (async () => {
  const h = makeHarness({ acctA: { brands: ["BrandX"], skuAsOf: "2026-09-05", returnsTo: "2026-09-04" } });
  const accounts = [{ accountId: "acctA", country: "IN" }];
  const first = await runReportMaterialization({ region: "india", accounts, ceiling: "2026-09-06", now: h.now }, h.collaborators);
  const firstWrites = h.calls.persist.length;
  const second = await runReportMaterialization({ region: "india", accounts, ceiling: "2026-09-06", now: h.now }, h.collaborators);
  const secondWrites = h.calls.persist.length - firstWrites;

  ok("D: the first run materialized (wrote) snapshots", first.summary.materialized > 0 && firstWrites > 0);
  ok("D: the second run wrote NOTHING (all unchanged)", secondWrites === 0 && second.summary.materialized === 0);
  ok("D: the second run reports every unit unchanged", second.summary.unchanged >= 3 && second.events.every((e) => e.status === "unchanged" || e.status === "skipped"));
  ok("D: the second run never even claimed a lock (short-circuited by the cheap probe)", h.calls.claim.length === firstWrites);
})();

/* ===================== E. isolation by identity: per-brand snapshots never collide or cross-contaminate ====== */
await (async () => {
  const h = makeHarness({ acctA: { brands: ["BrandX", "BrandY"], skuAsOf: "2026-09-05" } });
  await runReportMaterialization({ region: "india", accounts: [{ accountId: "acctA", country: "IN" }], ceiling: "2026-09-06", now: h.now }, h.collaborators);
  const x = h.store.get(key("sku-movement", "acctA", skuHash("2026-09-05", "BrandX")));
  const y = h.store.get(key("sku-movement", "acctA", skuHash("2026-09-05", "BrandY")));
  ok("E: distinct params_hash per brand (no collision)", skuHash("2026-09-05", "BrandX") !== skuHash("2026-09-05", "BrandY"));
  ok("E: each brand snapshot carries ONLY its own brand's rows (no cross-contamination)", x.payload.rows[0].asin === "acctA-BrandX-A1" && y.payload.rows[0].asin === "acctA-BrandY-A1");
  ok("E: each stored snapshot's params.brand matches its identity", x.params.brand === "BrandX" && y.params.brand === "BrandY");
})();

/* ===================== F. dry-run writes nothing; prefixed ids skipped; a held lock -> locked-skip =========== */
await (async () => {
  const h = makeHarness({ acctA: { brands: ["BrandX"] } });
  const res = await runReportMaterialization({ region: "india", accounts: [{ accountId: "acctA", country: "IN" }], ceiling: "2026-09-06", dryRun: true, now: h.now }, h.collaborators);
  ok("F: dry-run writes NOTHING", h.calls.persist.length === 0 && h.store.size === 0);
  ok("F: dry-run reports every unit planned", res.summary.planned > 0 && res.events.every((e) => e.status === "planned" || e.status === "skipped"));

  const h2 = makeHarness({ "dd-secondary:zzz": { brands: ["X"] } });
  const res2 = await runReportMaterialization({ region: "india", accounts: [{ accountId: "dd-secondary:zzz", country: "IN" }], ceiling: "2026-09-06", now: h2.now }, h2.collaborators);
  ok("F: a prefixed (dd-secondary) id is skipped -- never derived or written", h2.calls.derive.length === 0 && h2.calls.persist.length === 0 && res2.events.every((e) => e.status === "skipped"));

  const h3 = makeHarness({ acctA: { brands: [] } }, { lockAlwaysFails: true });
  const res3 = await runReportMaterialization({ region: "india", accounts: [{ accountId: "acctA", country: "IN" }], ceiling: "2026-09-06", now: h3.now }, h3.collaborators);
  ok("F: a held lock yields locked-skip with NO write", h3.calls.persist.length === 0 && res3.events.some((e) => e.status === "locked-skip"));
})();

/* ===================== G. summarize() is a faithful tally ==================================================== */
(() => {
  const s = summarize([{ account: "a", status: "materialized", tokens: 0 }, { account: "a", status: "unchanged" }, { account: "b", status: "unavailable" }, { account: "b", status: "error" }, { account: "*", status: "skipped" }]);
  ok("G: summarize tallies statuses + distinct accounts + tokens", s.materialized === 1 && s.unchanged === 1 && s.unavailable === 1 && s.error === 1 && s.accounts === 2 && s.tokens === 0);
})();

writeSync(1, `\nreport-materialization-operation: ${passed} assertions passed\n`);
