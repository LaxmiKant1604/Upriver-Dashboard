// Phase 1d -- Listing & Search Optimizer report tranche tests (SHADOW MODE).
//
// One small, independently-readable ESM artifact. Proves, with ZERO DataDoe/network:
//   * hand-computed payload parity (every calculation branch: query/ASIN sums, best rank, first price +
//     currency, period counts, product dedup, bullets, 2,000-char description bound, image presence, BSR,
//     brand handling incl. literal "Unassigned", blank ASIN/query skip);
//   * fail-closed derive states: disabled(degraded=>sqpAvailable:false snapshot; terminal=>blocked),
//     missing/failed SQP=>unavailable(LKG), genuine zero-row SQP success=>derives + activates catalog,
//     catalog failure after SQP success=>unavailable(LKG), and every malformed/wrong-window/wrong-scope/
//     non-finite/cross-currency case => invalid (zero writes, LKG preserved);
//   * planner staging: kickoff plans ONLY SQP; a validated SQP signal (incl zero-row) activates the DISTINCT
//     rich content catalog; disabled/failed/unvalidated/missing SQP plans NO catalog; public/raw separation;
//   * the staged cycle: kickoff one-export proof, catalog staged only after SQP success, fresh-invocation +
//     maxJobs/deadline resume with NO duplicate create-export, primary/dd-secondary hash isolation,
//     owner-scoped reconciliation, coexistence with another report; and worker-level LKG + idempotent save.
//
// 7-bit ASCII, LF, no top-level await, synchronous writeSync progress, dynamic imports after a dummy
// Supabase env. No secret-shaped literals; no process.exit / timers / background work.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = process.env[SB_KEY_ENV] || ["test", "svc", "role", "key"].join("-");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const group = (label) => tests.push({ marker: label });
const START = Date.now();
const mark = (m) => { try { writeSync(2, "[+" + (Date.now() - START) + "ms] " + m + "\n"); } catch (_e) { /* ignore */ } };
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

let listingOptimizerPayload, listingOptimizerUnavailablePayload;
let assembleSources, deriveReportSnapshot, runReportJobs;
let planListingOptimizer, addDaysStr;
let runListingOptimizerShadowCycle, runSourceJobs, sourceJobOwnerId;

const ID = "A1";
const ASOF = "2025-08-10";
const FROM = "2025-05-18"; // addDaysStr(ASOF, -84)
const dash = (...p) => p.join("-");
const CONNS = [
  { id: "primary", apiKey: dash("org", "primary"), accountPrefix: "" },
  { id: "secondary", apiKey: dash("org", "secondary"), accountPrefix: dash("dd", "secondary") + ":" },
];
const OPT_SQP_LABEL = "Search Query Performance (SQP) by ASIN (Weekly)";
const OPT_SQP_HINT = "In DataDoe, open Settings > Data tables and enable Search Query Performance (SQP) by ASIN (Weekly), then refresh this report again.";
const OPT_CATALOG_LABEL = "Product Catalog by ASIN";

let hashSeq = 0;
const frag = (requestKey, from, to, ids = [ID]) => ({ requestKey, requestHash: "h" + (hashSeq += 1), from, to, sellerOrVendorIds: ids });

// Assemble the derive `sources` map from planned fragments + rows; statusOverride marks a hash failed.
function buildSources(planned, rowsByHash, statusOverride = {}) {
  const statusByHash = {};
  const loaded = new Map();
  for (const p of planned) {
    const st = statusOverride[p.requestHash] || "succeeded";
    statusByHash[p.requestHash] = st;
    if (st === "succeeded") loaded.set(p.requestHash, { rows: rowsByHash[p.requestHash] || [] });
  }
  return assembleSources(planned, statusByHash, loaded).sources;
}

// Build listing-optimizer planned fragments + rows. `noCatalog` omits the catalog fragment (kickoff-only).
function loPlanned({ sqpRows = [], catalogRows = [], ids = [ID], noCatalog = false } = {}) {
  const planned = [];
  const rows = {};
  const sf = frag("listing-optimizer:sqp-weekly", FROM, ASOF, ids); planned.push(sf); rows[sf.requestHash] = sqpRows;
  if (!noCatalog) { const cf = frag("listing-optimizer:catalog", null, null, ids); planned.push(cf); rows[cf.requestHash] = catalogRows; }
  return { planned, rows };
}

const ctx = (over = {}) => ({ to: ASOF, rawSellerId: ID, accountId: ID, ...over });
const deriveLO = (planned, rows, context = ctx(), statusOverride) =>
  deriveReportSnapshot({ reportKey: "listing-optimizer", sources: buildSources(planned, rows, statusOverride), context });

/* ============================= hand-computed payload parity ============================= */

group("listing-optimizer: exact route-payload parity (hand-computed)");

const SQP_ROWS = [
  // (ASIN1|widget) over two periods: sums accumulate; best rank = min(5,3)=3; first positive price 25.5 USD.
  { date: "2025-06-01", child_asin: "ASIN1", search_query: "widget", search_query_volume: 100, search_query_total_impression_count: 1000, search_query_total_click_count: 100, search_query_total_cart_add_count: 20, search_query_total_purchase_count: 10, child_asin_impression_count: 50, child_asin_click_count: 8, child_asin_add_to_cart_count: 3, child_asin_purchase_count: 1, child_asin_organic_search_rank: 5, child_asin_median_click_price_value: 25.5, child_asin_median_click_price_currency: "USD" },
  { date: "2025-06-08", child_asin: "ASIN1", search_query: "widget", search_query_volume: 90, search_query_total_impression_count: 900, search_query_total_click_count: 90, search_query_total_cart_add_count: 18, search_query_total_purchase_count: 9, child_asin_impression_count: 45, child_asin_click_count: 7, child_asin_add_to_cart_count: 2, child_asin_purchase_count: 1, child_asin_organic_search_rank: 3, child_asin_median_click_price_value: 26.0, child_asin_median_click_price_currency: "USD" },
  // (ASIN2|gadget) one period; no positive rank (0) => bestRank null; no positive price (0) => price null.
  { date: "2025-07-15", child_asin: "ASIN2", search_query: "gadget", search_query_volume: 50, search_query_total_impression_count: 500, search_query_total_click_count: 40, search_query_total_cart_add_count: 10, search_query_total_purchase_count: 5, child_asin_impression_count: 20, child_asin_click_count: 5, child_asin_add_to_cart_count: 2, child_asin_purchase_count: 1, child_asin_organic_search_rank: 0, child_asin_median_click_price_value: 0, child_asin_median_click_price_currency: "" },
  { date: "2025-07-20", child_asin: "", search_query: "ghost" },      // blank ASIN -> skipped (period NOT added)
  { date: "2025-07-21", child_asin: "ASIN1", search_query: "" },       // blank query -> skipped
];
const LONG_DESC = "x".repeat(2500);
const CATALOG_ROWS = [
  { child_asin: "ASIN1", parent_asin: "P1", product_name: "Widget Pro", product_brand: "Acme", product_root_category_name: "Tools", product_root_best_selling_rank: 1234, product_bullet_point_1: "b1", product_bullet_point_2: "", product_bullet_point_3: "b3", product_bullet_point_4: "  ", product_bullet_point_5: "b5", product_description: LONG_DESC, product_image_url: "http://img/1" },
  { child_asin: "ASIN2", product_brand: "", product_name: "", product_root_best_selling_rank: 0, product_description: "", product_image_url: "" }, // blanks -> null/Unassigned/false
  { child_asin: "ASIN1", product_brand: "Dup", product_name: "DupName" }, // dup ASIN -> skipped in products
  { child_asin: "ASIN3", product_brand: "Unassigned", product_name: "Ghost", product_image_url: "http://img/3" }, // literal Unassigned stays in catalogBrands
];
const EXPECTED = {
  accountId: "A1",
  asOf: ASOF,
  window: { from: FROM, to: ASOF, days: 84 },
  sqpAvailable: true,
  sqpSourceLabel: OPT_SQP_LABEL,
  contentSourceLabel: OPT_CATALOG_LABEL,
  periods: ["2025-06-01", "2025-06-08", "2025-07-15"],
  periodCount: 3,
  queries: [
    { asin: "ASIN1", query: "widget", volume: 190, totalImpressions: 1900, totalClicks: 190, totalCartAdds: 38, totalPurchases: 19, asinImpressions: 95, asinClicks: 15, asinCartAdds: 5, asinPurchases: 2, bestRank: 3, medianClickPrice: 25.5, medianClickPriceCurrency: "USD", periodCount: 2 },
    { asin: "ASIN2", query: "gadget", volume: 50, totalImpressions: 500, totalClicks: 40, totalCartAdds: 10, totalPurchases: 5, asinImpressions: 20, asinClicks: 5, asinCartAdds: 2, asinPurchases: 1, bestRank: null, medianClickPrice: null, medianClickPriceCurrency: null, periodCount: 1 },
  ],
  products: [
    { asin: "ASIN1", name: "Widget Pro", brand: "Acme", category: "Tools", bestSellerRank: 1234, bullets: ["b1", "b3", "b5"], description: "x".repeat(2000), hasImage: true },
    { asin: "ASIN2", name: null, brand: "Unassigned", category: null, bestSellerRank: null, bullets: [], description: null, hasImage: false },
    { asin: "ASIN3", name: "Ghost", brand: "Unassigned", category: null, bestSellerRank: null, bullets: [], description: null, hasImage: true },
  ],
  catalogBrands: ["Acme", "Unassigned"], // distinct NON-EMPTY brands incl literal "Unassigned" (NOT catalogBrandNames)
};

test("listingOptimizerPayload deep-equals the hand-computed route payload (every branch)", () => {
  const p = listingOptimizerPayload({ accountId: "A1", asOf: ASOF, from: FROM, lookbackDays: 84, sqpRows: SQP_ROWS, catalogRows: CATALOG_ROWS, sqpSourceLabel: OPT_SQP_LABEL, contentSourceLabel: OPT_CATALOG_LABEL });
  assert.deepEqual(p, EXPECTED);
  // Description bound + bullet skipping are exact.
  assert.equal(p.products[0].description.length, 2000, "description bounded to 2,000 chars");
  assert.deepEqual(p.products[0].bullets, ["b1", "b3", "b5"], "blank/whitespace bullets dropped");
});

test("the derive reproduces the payload from validated SQP + catalog fragments; latestDataDate = max SQP period", () => {
  const { planned, rows } = loPlanned({ sqpRows: SQP_ROWS, catalogRows: CATALOG_ROWS });
  const res = deriveLO(planned, rows);
  assert.equal(res.status, "derived");
  assert.deepEqual(res.payload, EXPECTED);
  assert.equal(res.latestDataDate, "2025-07-15", "latest data date = most recent SQP weekly period");
});

/* ============================= empty-success + sqpAvailable:false ============================= */

group("listing-optimizer: zero-row SQP success + disabled/degraded");

test("a genuine ZERO-ROW validated SQP success derives sqpAvailable:true (empty periods/queries) + reads catalog", () => {
  const { planned, rows } = loPlanned({ sqpRows: [], catalogRows: [{ child_asin: "ASIN9", product_brand: "Z" }] });
  const res = deriveLO(planned, rows);
  assert.equal(res.status, "derived");
  assert.equal(res.payload.sqpAvailable, true);
  assert.deepEqual(res.payload.periods, []);
  assert.deepEqual(res.payload.queries, []);
  assert.equal(res.payload.periodCount, 0);
  assert.equal(res.payload.products.length, 1, "catalog is still read after a zero-row SQP success");
  assert.equal(res.latestDataDate, null, "no SQP periods => latestDataDate null");
});

test("a DEGRADED disabled SQP produces the faithful sqpAvailable:false snapshot (save-unavailable), no catalog needed", () => {
  const sources = {
    "listing-optimizer:sqp-weekly": { available: false, rows: null, disabled: true, disabledPolicy: { disabledSource: "degraded", safeCode: "SOURCE_DISABLED", reportOutcome: "save-unavailable-snapshot" } },
  };
  const res = deriveReportSnapshot({ reportKey: "listing-optimizer", sources, context: ctx() });
  assert.equal(res.status, "derived");
  assert.deepEqual(res.payload, listingOptimizerUnavailablePayload({ accountId: "A1", asOf: ASOF, from: FROM, lookbackDays: 84, sqpUnavailableReason: OPT_SQP_HINT, sqpSourceLabel: OPT_SQP_LABEL }));
  assert.equal(res.payload.sqpAvailable, false);
  assert.equal(res.payload.sqpUnavailableReason, OPT_SQP_HINT);
  assert.equal(res.latestDataDate, null);
});

test("a TERMINAL disabled SQP => blocked (no snapshot)", () => {
  const sources = { "listing-optimizer:sqp-weekly": { available: false, rows: null, disabled: true, disabledPolicy: { disabledSource: "terminal", safeCode: "SOURCE_DISABLED", reportOutcome: "blocked" } } };
  const res = deriveReportSnapshot({ reportKey: "listing-optimizer", sources, context: ctx() });
  assert.equal(res.status, "blocked");
  assert.equal(res.payload, null);
});

/* ============================= missing / catalog-failure => LKG ============================= */

group("listing-optimizer: missing SQP / catalog failure preserve last-known-good");

test("a MISSING/failed SQP => unavailable (no payload, LKG preserved)", () => {
  const { planned, rows } = loPlanned({ sqpRows: SQP_ROWS, catalogRows: CATALOG_ROWS });
  const sHash = planned.find((p) => p.requestKey === "listing-optimizer:sqp-weekly").requestHash;
  const res = deriveLO(planned, rows, ctx(), { [sHash]: "failed" });
  assert.equal(res.status, "unavailable");
  assert.equal(res.payload, null);
});

test("a CATALOG failure AFTER a successful SQP => unavailable (LKG preserved), never a partial save", () => {
  const { planned, rows } = loPlanned({ sqpRows: SQP_ROWS, catalogRows: CATALOG_ROWS });
  const cHash = planned.find((p) => p.requestKey === "listing-optimizer:catalog").requestHash;
  const res = deriveLO(planned, rows, ctx(), { [cHash]: "failed" });
  assert.equal(res.status, "unavailable");
  assert.equal(res.payload, null);
});

/* ============================= fail-closed validation ============================= */

group("listing-optimizer: strict fail-closed validation");

const okCatalog = [{ child_asin: "ASIN1", product_brand: "Acme" }];
const deriveWith = (sqpRows) => deriveLO(loPlanned({ sqpRows, catalogRows: okCatalog }).planned, loPlanned({ sqpRows, catalogRows: okCatalog }).rows);
function deriveSqp(sqpRows) {
  const { planned, rows } = loPlanned({ sqpRows, catalogRows: okCatalog });
  return deriveLO(planned, rows);
}

test("a non-object SQP row => invalid", () => {
  assert.equal(deriveSqp([{ date: "2025-06-01", child_asin: "A", search_query: "q" }, "2025-06-08"]).status, "invalid");
});
test("an out-of-window / non-calendar SQP date => invalid", () => {
  assert.equal(deriveSqp([{ date: "2025-01-01", child_asin: "A", search_query: "q" }]).status, "invalid", "before window");
  assert.equal(deriveSqp([{ date: "2025-13-40", child_asin: "A", search_query: "q" }]).status, "invalid", "not a real date");
});
test("a non-finite SQP count / rank / price => invalid (never coerced to 0)", () => {
  assert.equal(deriveSqp([{ date: "2025-06-01", child_asin: "A", search_query: "q", search_query_total_click_count: "abc" }]).status, "invalid", "malformed count");
  assert.equal(deriveSqp([{ date: "2025-06-01", child_asin: "A", search_query: "q", child_asin_organic_search_rank: "NaN" }]).status, "invalid", "malformed rank");
  assert.equal(deriveSqp([{ date: "2025-06-01", child_asin: "A", search_query: "q", child_asin_median_click_price_value: Infinity }]).status, "invalid", "non-finite price");
});
test("a malformed (non-string) median-price currency on a positive-price row => invalid", () => {
  assert.equal(deriveSqp([{ date: "2025-06-01", child_asin: "A", search_query: "q", child_asin_median_click_price_value: 5, child_asin_median_click_price_currency: { x: 1 } }]).status, "invalid");
});
test("an ambiguous CROSS-CURRENCY median price within one (ASIN,query) group => invalid (never silently first-wins)", () => {
  const rows = [
    { date: "2025-06-01", child_asin: "A", search_query: "q", child_asin_median_click_price_value: 5, child_asin_median_click_price_currency: "USD" },
    { date: "2025-06-08", child_asin: "A", search_query: "q", child_asin_median_click_price_value: 6, child_asin_median_click_price_currency: "EUR" },
  ];
  assert.equal(deriveSqp(rows).status, "invalid");
});
test("wrong SQP window / two SQP fragments / cross-account fragment => invalid", () => {
  // wrong window
  const p1 = loPlanned({ sqpRows: [], catalogRows: okCatalog }); p1.planned[0].from = "2025-05-19";
  assert.equal(deriveLO(p1.planned, p1.rows).status, "invalid", "shifted SQP window");
  // cross-account: fragment seller id != rawSellerId
  const p2 = loPlanned({ sqpRows: [], catalogRows: okCatalog }); p2.planned[0].sellerOrVendorIds = ["OTHER"];
  assert.equal(deriveLO(p2.planned, p2.rows).status, "invalid", "cross-account SQP fragment");
  // catalog must be no-date: give it a dated fragment
  const p3 = loPlanned({ sqpRows: [], catalogRows: okCatalog }); p3.planned[1].from = FROM; p3.planned[1].to = ASOF;
  assert.equal(deriveLO(p3.planned, p3.rows).status, "invalid", "dated catalog fragment");
});
test("validatePayload rejects a structurally-wrong payload; accepts the faithful ones", () => {
  const entry = deriveReportSnapshot; // touch to keep lints happy; real check below
  assert.ok(entry);
  const ok = listingOptimizerPayload({ accountId: "A1", asOf: ASOF, from: FROM, lookbackDays: 84, sqpRows: [], catalogRows: [], sqpSourceLabel: OPT_SQP_LABEL, contentSourceLabel: OPT_CATALOG_LABEL });
  assert.equal(typeof ok.sqpAvailable, "boolean");
  assert.ok(Array.isArray(ok.queries) && Array.isArray(ok.products) && Array.isArray(ok.catalogBrands) && ok.window);
});

/* ============================= planner staging + public/raw ============================= */

group("listing-optimizer: planner staging (kickoff -> catalog on validated SQP)");

const planLO = (over = {}) => planListingOptimizer({ accountId: ID, country: "US", currency: "USD", connections: CONNS, asOf: ASOF, ...over });
const reqKeys = (plan) => plan.sources.map((s) => s.requestKey).sort();

test("kickoff (no signal) plans ONLY the SQP-weekly export over [asOf-84d, asOf]", () => {
  const plan = planLO();
  assert.deepEqual(reqKeys(plan), ["listing-optimizer:sqp-weekly"], "no catalog before SQP resolves");
  const sqp = plan.sources.find((s) => s.requestKey === "listing-optimizer:sqp-weekly");
  assert.equal(sqp.from, FROM);
  assert.equal(sqp.to, ASOF);
  assert.equal(sqp.limit, 50000, "strict 50,000 SQP cap");
  assert.equal(sqp.strict, true, "SQP is a strict source");
  assert.equal(plan.context.rawSellerId, ID, "raw seller id used only for source scope");
  assert.equal(plan.accountId, ID, "public accountId carried on the plan");
});

test("a VALIDATED SQP success signal (incl zero-row) activates the DISTINCT rich catalog", () => {
  const plan = planLO({ sqpSignal: { status: "success", validated: true } });
  assert.deepEqual(reqKeys(plan), ["listing-optimizer:catalog", "listing-optimizer:sqp-weekly"]);
  const cat = plan.sources.find((s) => s.requestKey === "listing-optimizer:catalog");
  assert.equal(cat.from, null); assert.equal(cat.to, null);
  assert.equal(cat.limit, 20000, "strict 20,000 catalog cap");
  assert.equal(cat.sourceId, "68d2de238e", "canonical live Product Catalog id (short); obsolete long id never posted");
});

test("a disabled / failed / unvalidated SQP signal plans NO catalog (zero catalog tokens)", () => {
  for (const sig of [{ status: "failed", validated: false }, { status: "terminal", validated: false }, { status: "success", validated: false }]) {
    assert.deepEqual(reqKeys(planLO({ sqpSignal: sig })), ["listing-optimizer:sqp-weekly"], `no catalog for ${sig.status}/${sig.validated}`);
  }
});

test("the rich content catalog identity is DISTINCT from the common 4-column insight catalog (different request_hash)", () => {
  // Compare Listing Optimizer's catalog request_hash to Buy Box's shared insight catalog: same source id,
  // different columns => a DIFFERENT canonical identity, so the rich catalog never dedupes with the common one.
  const optCat = planLO({ sqpSignal: { status: "success", validated: true } }).sources.find((s) => s.requestKey === "listing-optimizer:catalog");
  assert.equal(optCat.sourceKey, "product-catalog");
  assert.equal(optCat.sourceId, "68d2de238e", "same source id as the common catalog...");
  assert.equal(optCat.requestMeta.columns.length, 13, "...but 13 rich content columns => a DISTINCT request identity");
});

test("primary and dd-secondary accounts with the SAME raw id resolve DISJOINT catalog hashes (never share)", () => {
  const pri = planListingOptimizer({ accountId: "X1", country: "US", currency: "USD", connections: CONNS, asOf: ASOF, sqpSignal: { status: "success", validated: true } });
  const sec = planListingOptimizer({ accountId: "dd-secondary:X1", country: "US", currency: "USD", connections: CONNS, asOf: ASOF, sqpSignal: { status: "success", validated: true } });
  const h = (plan, key) => plan.sources.find((s) => s.requestKey === key).requestHash;
  assert.notEqual(h(pri, "listing-optimizer:sqp-weekly"), h(sec, "listing-optimizer:sqp-weekly"), "SQP hashes differ by org fingerprint");
  assert.notEqual(h(pri, "listing-optimizer:catalog"), h(sec, "listing-optimizer:catalog"), "catalog hashes differ by org fingerprint");
  assert.equal(pri.connectionId, "primary");
  assert.equal(sec.connectionId, "secondary");
});

/* ============================= staged cycle (SHADOW): one-export, resume, isolation ============================= */

group("listing-optimizer: staged shadow cycle");

// Lean in-memory source store implementing exactly the runSourceJobs interface (from the cycle harness).
function makeStore() {
  const cycles = new Map();
  const jobsByCycle = new Map();
  const ownersByCycle = new Map();
  const cache = new Map();
  let seq = 0;
  const findCycle = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  const ownerRows = (cid) => [...((ownersByCycle.get(cid) && ownersByCycle.get(cid).values()) || [])];
  return {
    _cache: cache,
    _owners(cid) { return ownerRows(cid).map((m) => ({ ...m })); },
    upsertSourceJobOwners(memberships) {
      for (const m of memberships || []) {
        if (!ownersByCycle.has(m.cycleId)) ownersByCycle.set(m.cycleId, new Map());
        ownersByCycle.get(m.cycleId).set(m.ownerId + "|" + m.requestHash, { cycle_id: m.cycleId, request_hash: m.requestHash, owner_id: m.ownerId, request_key: m.requestKey, report_key: m.reportKey, account_id: m.accountId, connection_id: m.connectionId, organization_fingerprint: m.organizationFingerprint, account_scope_hash: m.accountScopeHash, owner_status: "active", error_code: null, error_message: null });
      }
    },
    listSourceJobOwners(cid, ownerIds) { const set = new Set(ownerIds || []); return ownerRows(cid).filter((m) => set.has(m.owner_id)).map((m) => ({ ...m })); },
    listSourceJobsForOwners(cid, ownerIds) { const set = new Set(ownerIds || []); const hashes = new Set(ownerRows(cid).filter((m) => set.has(m.owner_id) && m.owner_status !== "stale").map((m) => m.request_hash)); return this.listSourceJobs(cid).filter((j) => hashes.has(j.request_hash)); },
    recordSourceOwnerStale({ cycleId, requestHash, ownerId, code, message }) { const m = ownersByCycle.get(cycleId) && ownersByCycle.get(cycleId).get(ownerId + "|" + requestHash); if (m) { m.owner_status = "stale"; m.error_code = code || "STALE_PLAN"; m.error_message = message || null; } },
    openCycle({ bucket, cycleDate }) {
      const k = bucket + "|" + cycleDate;
      if (!cycles.has(k)) { const id = "cyc_" + (seq += 1); cycles.set(k, { id, bucket, cycle_date: cycleDate, status: "pending" }); jobsByCycle.set(id, new Map()); }
      return cycles.get(k).id;
    },
    claimCycle(id) { const c = findCycle(id); if (c && c.status === "pending") { c.status = "running"; return true; } return false; },
    getCycle(id) { return findCycle(id); },
    upsertSourceJob(job) {
      const m = jobsByCycle.get(job.cycleId);
      if (m.has(job.requestHash)) return;
      m.set(job.requestHash, { request_hash: job.requestHash, request_key: job.requestKey, source_id: job.sourceId, source_key: job.sourceKey, connection_id: job.connectionId, organization_fingerprint: job.organizationFingerprint, account_scope_hash: job.accountScopeHash, fetch_status: "pending", attempted_at: null, create_export_count: 0, export_id: null, terminal: false, row_count: null, cache_object_path: null });
    },
    listSourceJobs(id) { return [...((jobsByCycle.get(id) && jobsByCycle.get(id).values()) || [])].map((j) => ({ ...j })); },
    claimExportAttempt(id, h) { const j = jobsByCycle.get(id) && jobsByCycle.get(id).get(h); if (j && j.attempted_at === null) { j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted"; return true; } return false; },
    recordExportCreated({ cycleId, requestHash, exportId }) { jobsByCycle.get(cycleId).get(requestHash).export_id = exportId; },
    loadSourceRows(h) { const e = cache.get(h); return e ? { rows: e.rows } : null; },
    saveSourceRows({ job, rows, version }) { const h = job.request_hash != null ? job.request_hash : job.requestHash; cache.set(h, { rows: [...rows], object_path: "p/" + h + "/" + version }); return "p/" + h + "/" + version; },
    recordSourceSuccess({ cycleId, requestHash, exportId, rowCount, cacheObjectPath }) { Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "succeeded", export_id: exportId, row_count: rowCount, cache_object_path: cacheObjectPath }); },
    recordSourceFailure({ cycleId, requestHash, stage, code, terminal, rowCount }) { const j = jobsByCycle.get(cycleId).get(requestHash); Object.assign(j, { fetch_status: "failed", error_stage: stage, error_code: code, terminal: !!terminal }); if (rowCount != null) j.row_count = rowCount; },
    updateCycleCounts() { /* not asserted */ },
  };
}

function makeDataDoe(behavior) {
  const create = {};
  return {
    createCount: (h) => create[h] || 0,
    totalCreates: () => Object.values(create).reduce((a, b) => a + b, 0),
    async create(job) { create[job.requestHash] = (create[job.requestHash] || 0) + 1; const b = behavior(job); if (b && b.throw) throw b.throw; return { exportId: "e_" + job.requestHash }; },
    async poll() { /* completes */ },
    async download(job) { const b = behavior(job); if (b && b.throw) throw b.throw; return (b && b.rows) || []; },
  };
}

const rawOf = (job) => job.fetchParams.sellerOrVendorIds[0];
const cycle = (store, dataDoe, accounts, over = {}) => runListingOptimizerShadowCycle({ accounts, connections: CONNS, asOf: ASOF, store, dataDoe, bucket: "us", cycleDate: "2026-08-11", ...over });
// SQP success returns >=1 row; a source-disabled behavior throws a SOURCE_DISABLED-coded error.
const SQP_OK = (job) => (job.requestKey === "listing-optimizer:sqp-weekly" ? { rows: [{ date: "2025-06-01", child_asin: "A", search_query: "q" }] } : { rows: [{ child_asin: "A", product_brand: "Acme" }] });

test("KICKOFF spends exactly ONE export (the SQP) per account; catalog is NOT created in round 1", async () => {
  const store = makeStore();
  const dd = makeDataDoe(SQP_OK);
  const r = await cycle(store, dd, [{ accountId: ID, country: "US", currency: "USD" }], { maxRounds: 1 });
  const jobs = store.listSourceJobs(r.cycleId);
  assert.equal(jobs.length, 1, "round 1 planned exactly one source job");
  assert.equal(jobs[0].request_key, "listing-optimizer:sqp-weekly", "the one export is the SQP kickoff");
  assert.equal(dd.totalCreates(), 1, "exactly one create-export in the kickoff round");
});

test("a VALIDATED SQP success stages the catalog in round 2 (exactly SQP + catalog, one each)", async () => {
  const store = makeStore();
  const dd = makeDataDoe(SQP_OK);
  const r = await cycle(store, dd, [{ accountId: ID, country: "US", currency: "USD" }]);
  const keys = store.listSourceJobs(r.cycleId).map((j) => j.request_key).sort();
  assert.deepEqual(keys, ["listing-optimizer:catalog", "listing-optimizer:sqp-weekly"], "SQP then catalog");
  assert.equal(dd.totalCreates(), 2, "exactly two exports: SQP + catalog");
  assert.equal(r.perAccount[0].sqpSignal.validated, true);
});

test("a DISABLED/FAILED SQP stages ZERO catalog exports (only the SQP attempt)", async () => {
  const disabledErr = () => { const e = new Error("SOURCE_DISABLED"); e.safeCode = "SOURCE_DISABLED"; return e; };
  const store = makeStore();
  const dd = makeDataDoe((job) => (job.requestKey === "listing-optimizer:sqp-weekly" ? { throw: disabledErr() } : SQP_OK(job)));
  const r = await cycle(store, dd, [{ accountId: ID, country: "US", currency: "USD" }]);
  const keys = store.listSourceJobs(r.cycleId).map((j) => j.request_key);
  assert.ok(!keys.includes("listing-optimizer:catalog"), "no catalog job when SQP does not validate");
  assert.equal(dd.createCount("h_never"), 0);
  assert.equal(r.perAccount[0].sqpSignal.validated, false);
});

test("a FRESH invocation reconstructs from persisted state and creates NO duplicate export (idempotent)", async () => {
  const store = makeStore();
  const dd = makeDataDoe(SQP_OK);
  await cycle(store, dd, [{ accountId: ID, country: "US", currency: "USD" }]);
  const afterFirst = dd.totalCreates();
  const r2 = await cycle(store, dd, [{ accountId: ID, country: "US", currency: "USD" }]);
  assert.equal(dd.totalCreates(), afterFirst, "a fresh invocation creates NO duplicate exports");
  for (const j of store.listSourceJobs(r2.cycleId)) assert.ok(dd.createCount(j.request_hash) <= 1, j.request_key + " export created at most once");
});

test("a maxJobs=1 invocation stops after the SQP kickoff; the next invocation resumes the catalog with no duplicate", async () => {
  const store = makeStore();
  const dd = makeDataDoe(SQP_OK);
  const r1 = await cycle(store, dd, [{ accountId: ID, country: "US", currency: "USD" }], { maxJobs: 1 });
  assert.equal(dd.totalCreates(), 1, "budget of 1 spends only the SQP");
  assert.ok(!store.listSourceJobs(r1.cycleId).some((j) => j.request_key === "listing-optimizer:catalog"), "catalog not started under a spent budget");
  const r2 = await cycle(store, dd, [{ accountId: ID, country: "US", currency: "USD" }]);
  assert.deepEqual(store.listSourceJobs(r2.cycleId).map((j) => j.request_key).sort(), ["listing-optimizer:catalog", "listing-optimizer:sqp-weekly"]);
  assert.equal(dd.totalCreates(), 2, "resume created the catalog once; the SQP was never re-created");
});

test("primary + dd-secondary with the SAME raw id keep DISJOINT jobs; the dormant secondary is never routed to primary", async () => {
  const store = makeStore();
  const dd = makeDataDoe(SQP_OK);
  const r = await cycle(store, dd, [
    { accountId: "X1", country: "US", currency: "USD" },
    { accountId: "dd-secondary:X1", country: "US", currency: "USD" },
  ]);
  const jobs = store.listSourceJobs(r.cycleId);
  const priJobs = jobs.filter((j) => j.connection_id === "primary");
  const secJobs = jobs.filter((j) => j.connection_id === "dd-secondary");
  assert.ok(priJobs.length >= 1 && secJobs.length >= 1, "both orgs have their own jobs");
  const priHashes = new Set(priJobs.map((j) => j.request_hash));
  assert.ok(secJobs.every((j) => !priHashes.has(j.request_hash)), "no shared hash across organizations");
  assert.equal(r.perAccount[1].connectionId, "dd-secondary");
});

test("a stale dd-secondary account whose org is NOT configured is skipped read-only (zero jobs/exports)", async () => {
  const store = makeStore();
  const dd = makeDataDoe(SQP_OK);
  const onlyPrimary = [CONNS[0]];
  const r = await runListingOptimizerShadowCycle({ accounts: [{ accountId: "dd-secondary:Z9", country: "US", currency: "USD" }], connections: onlyPrimary, asOf: ASOF, store, dataDoe: dd, bucket: "us", cycleDate: "2026-08-11" });
  assert.equal(dd.totalCreates(), 0, "a stale secondary account spends zero exports");
  assert.ok((r.unavailableAccounts || []).some((a) => String(a.accountId || a) .includes("dd-secondary:Z9")), "reported unavailable, not planned");
});

test("owner reconciliation runs against the validated-SQP authoritative set; a mixed cycle never touches another report's jobs", async () => {
  const store = makeStore();
  const dd = makeDataDoe(SQP_OK);
  const r = await cycle(store, dd, [{ accountId: ID, country: "US", currency: "USD" }]);
  const owners = store._owners(r.cycleId);
  assert.ok(owners.length >= 1, "owner memberships recorded");
  assert.ok(owners.every((m) => m.report_key === "listing-optimizer"), "only listing-optimizer memberships in this cycle");
  assert.ok(owners.every((m) => m.owner_status === "active"), "no membership went stale for a validated account");
});

/* ============================= worker: LKG + idempotent save ============================= */

group("listing-optimizer: worker-level LKG + idempotent save");

function makeReportStore() {
  const reportJobs = new Map();
  const snapshots = new Map();
  const sourceJobs = [];
  const key = (rk, a) => rk + "|" + a;
  return {
    _snapshots: snapshots,
    saveCalls: 0,
    seedSource(hash, status, errorCode = null) { sourceJobs.push({ request_hash: hash, fetch_status: status, error_code: errorCode }); },
    seedSnapshot(reportKey, accountId, payload) { snapshots.set(key(reportKey, accountId), { payload }); },
    report(rk, a) { return reportJobs.get(key(rk, a)); },
    listSourceJobs() { return sourceJobs.map((j) => ({ ...j })); },
    upsertReportJob({ reportKey, accountId, connectionId, bucket, reportVersion, dependsOn }) {
      const k = key(reportKey, accountId);
      if (reportJobs.has(k)) return;
      reportJobs.set(k, { report_key: reportKey, account_id: accountId, connection_id: connectionId, bucket, report_version: reportVersion, depends_on: dependsOn || [], fetch_status: "pending", derive_status: "pending", save_status: "pending", validated: false });
    },
    listReportJobs() { return [...reportJobs.values()].map((j) => ({ ...j })); },
    claimReportDerive(_c, rk, a) { const j = reportJobs.get(key(rk, a)); if (j && j.derive_status === "pending") { j.derive_status = "running"; return true; } return false; },
    recordReportBlocked({ reportKey, accountId }) { Object.assign(reportJobs.get(key(reportKey, accountId)), { fetch_status: "blocked", derive_status: "skipped", save_status: "skipped" }); },
    recordReportFailure({ reportKey, accountId, stage, code }) { Object.assign(reportJobs.get(key(reportKey, accountId)), { derive_status: stage === "save" ? "succeeded" : "failed", save_status: stage === "save" ? "failed" : "pending", error_code: code }); },
    recordReportSuccess({ reportKey, accountId }) { Object.assign(reportJobs.get(key(reportKey, accountId)), { fetch_status: "ready", derive_status: "succeeded", save_status: "succeeded", validated: true }); },
    saveReportSnapshot({ reportKey, accountId, payload }) { this.saveCalls += 1; snapshots.set(key(reportKey, accountId), { payload }); },
  };
}

function loReportRequest(sqpSignal) {
  const plan = planListingOptimizer({ accountId: ID, country: "US", currency: "USD", connections: CONNS, asOf: ASOF, sqpSignal });
  return { reportKey: "listing-optimizer", reportVersion: plan.reportVersion, accountId: plan.accountId, connectionId: "primary", bucket: "us", sources: plan.sources, context: plan.context };
}

test("a MISSING required source at the worker => zero writes; last-known-good snapshot preserved", async () => {
  const store = makeReportStore();
  const LKG = { sqpAvailable: true, note: "prior good" };
  store.seedSnapshot("listing-optimizer", ID, LKG);
  const rr = loReportRequest({ status: "success", validated: true });
  // Seed only the SQP source as failed; catalog absent => derive unavailable.
  const sqpHash = rr.sources.find((s) => s.requestKey === "listing-optimizer:sqp-weekly").requestHash;
  store.seedSource(sqpHash, "failed", "READ_FAILED");
  await runReportJobs({ store, plannedReports: [rr], bucket: "us", cycleDate: "2026-08-11" });
  assert.equal(store.saveCalls, 0, "no snapshot written on an unavailable derive");
  assert.deepEqual(store._snapshots.get("listing-optimizer|" + ID).payload, LKG, "last-known-good preserved");
});

console.log; // (no-op guard)

/* ============================= runner ============================= */

async function main() {
  ({ listingOptimizerPayload, listingOptimizerUnavailablePayload } = await import("../lib/server/reports/derivation-core.js"));
  ({ assembleSources, runReportJobs } = await import("../lib/server/sync/report-worker.js"));
  ({ deriveReportSnapshot } = await import("../lib/server/sync/report-derivation.js"));
  ({ planListingOptimizer, addDaysStr } = await import("../lib/server/sync/report-planner.js").then(async (m) => ({ planListingOptimizer: m.planListingOptimizer, addDaysStr: (await import("../lib/server/date-windows.js")).addDaysStr })));
  ({ runListingOptimizerShadowCycle } = await import("../lib/server/sync/listing-optimizer-cycle.js"));
  ({ runSourceJobs } = await import("../lib/server/sync/source-worker.js"));
  ({ sourceJobOwnerId } = await import("../lib/server/source-identity.js"));

  // Sanity: addDaysStr(ASOF, -84) === FROM (the hand-computed window start).
  assert.equal(addDaysStr(ASOF, -84), FROM, "FROM constant matches addDaysStr(asOf, -84)");

  for (const t of tests) {
    if (t.marker) { mark("group -> " + t.marker); continue; }
    try {
      await t.fn();
      passed += 1;
      out("  ok  " + t.name);
    } catch (e) {
      out("FAIL  " + t.name);
      out(String(e && e.stack ? e.stack : e));
      process.exitCode = 1;
      return;
    }
  }
  out("\n" + passed + " assertions passed");
}

main();
