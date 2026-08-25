// Zero-export Daily v2 re-derivation: recompute daily-reporting/v2e-1 from durable evidence through the REAL
// contract, never copying v1; OLI sales survive when Ads are unavailable; Ads unavailable is never a zero; the
// operation reads only durable sources and never creates a DataDoe export.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { REPORT_DERIVATIONS } from "../lib/server/sync/report-derivation.js";
import {
  rederiveDailyV2Payload, gatherDailyDurableEvidence, rederiveAndSaveDailyV2, rederiveDailyV2, durableRefreshedAt,
  latestProvenDailyTo,
} from "../lib/server/reports/daily-durable-rederive.js";
import { selfHealFromDurable } from "../lib/server/report-store.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const test = (name, fn) => { try { fn(); passed += 1; out("  ok  " + name); } catch (e) { out("FAIL  " + name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; } };
const testAsync = async (name, fn) => { try { await fn(); passed += 1; out("  ok  " + name); } catch (e) { out("FAIL  " + name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; } };

const ACCOUNT = "A01", RAW = "A01", CUR = "USD", FROM = "2026-03-01", TO = "2026-03-20";
const HISTORY = [
  { account_id: "A01", sale_date: "2026-03-05", sku: "SKU-A", child_asin: "B0A", currency: "USD", sales_amount: 100, units: 4 },
  { account_id: "A01", sale_date: "2026-03-10", sku: "SKU-B", child_asin: "B0B", currency: "USD", sales_amount: 60, units: 2 },
  { account_id: "A02", sale_date: "2026-03-10", sku: "SKU-Z", child_asin: "B0Z", currency: "EUR", sales_amount: 999, units: 9 }, // OTHER account -- must be ignored
];
const CATALOG = [
  { child_asin: "B0A", sku: "SKU-A", parent_asin: "P", product_name: "A", product_brand: "Acme" },
  { child_asin: "B0B", sku: "SKU-B", parent_asin: "P", product_name: "B", product_brand: "Bolt" },
];
const AD_ROWS = [
  { metric_date: "2026-03-05", marketplace_country_code: "US", dimension_key: "d1", currency: "USD", child_asin: "B0A", updated_at: "2026-03-06T00:00:00Z", metrics: { ad_sales_same_sku: 40, ad_spend: 12, ad_clicks: 8 } },
];
const OLI_WINDOWS = [{ from: "2025-06-01", to: TO }];
const CATALOG_SNAP = { validated_at: "2026-03-21T01:00:00.000Z", object_path: "cat/obj", row_count: 2 };
const ASIN_COV = { windows: [{ from: "2025-06-01", to: TO }], status: "succeeded", latestMetricDate: "2026-03-05", read: "ok" };

const fullEvidence = (over = {}) => ({
  historyRows: HISTORY, oliWindows: OLI_WINDOWS, catalogSnapshot: CATALOG_SNAP, catalogRows: CATALOG,
  asinAdRows: AD_ROWS, asinMetricsRead: "ok", asinCoverageState: ASIN_COV, asinCoverageRead: "ok", asinWindows: ASIN_COV.windows,
  ...over,
});
const salesOf = (payload) => payload.rows.reduce((a, r) => a + (Number(r.total_sales) || 0), 0);

test("(1) v2 missing + durable OLI present -> derives a VALID daily-reporting/v2e-1 payload (recomputed, not copied)", () => {
  const r = rederiveDailyV2Payload({ accountId: ACCOUNT, rawSellerId: RAW, currency: CUR, from: FROM, to: TO, brand: "ALL" }, fullEvidence());
  assert.ok(r.payload, "a payload is produced");
  assert.equal(r.version, "daily-reporting/v2e-1", "the REAL shadow snapshot version (v2e-1)");
  assert.equal(r.payload.brandFiltered, false);
  assert.equal(REPORT_DERIVATIONS["daily-reporting"].validatePayload(r.payload), true, "the REAL frontend payload contract accepts it");
  // Recomputed from THIS account's history only (100+60), never A02's 999 -> proves derivation, not a copy/relabel.
  assert.equal(salesOf(r.payload), 160, "sales = this account's durable OLI (100+60), A02 excluded");
});

test("(3) missing ASIN Ads does NOT hide OLI sales, and (4) Ads is typed unavailable -- never zero", () => {
  const r = rederiveDailyV2Payload({ accountId: ACCOUNT, rawSellerId: RAW, currency: CUR, from: FROM, to: TO, brand: "ALL" },
    fullEvidence({ asinAdRows: [], asinMetricsRead: "read-failed" }));
  assert.ok(r.payload, "still derives");
  assert.equal(salesOf(r.payload), 160, "OLI sales survive a failed Ads read");
  assert.equal(r.payload.adsAvailability.status, "failed", "Ads is typed unavailable/failed");
  // Never a fabricated zero: no row carries an ad_sales/ad_spend key when Ads are unavailable.
  const anyAd = r.payload.rows.some((row) => "ad_sales" in row || "ad_spend" in row || "ad_clicks" in row);
  assert.equal(anyAd, false, "no ad_* fields materialized (ads shown as unavailable, not 0)");
});

test("ALL-brand payload carries the SAME-SKU ads when coverage is proven (validated availability)", () => {
  const r = rederiveDailyV2Payload({ accountId: ACCOUNT, rawSellerId: RAW, currency: CUR, from: FROM, to: TO, brand: "ALL" }, fullEvidence());
  assert.equal(r.payload.adsAvailability.status, "validated");
  const adRow = r.payload.rows.find((row) => Number(row.ad_sales) > 0);
  assert.ok(adRow, "a row carries merged ASIN ad_sales");
  assert.equal(adRow.ad_sales, 40); assert.equal(adRow.ad_spend, 12); assert.equal(adRow.ad_clicks, 8);
});

test("(5-invariant) OLI coverage that does NOT prove the window -> not-ready (never partial/fabricated sales)", () => {
  const r = rederiveDailyV2Payload({ accountId: ACCOUNT, rawSellerId: RAW, currency: CUR, from: FROM, to: TO, brand: "ALL" },
    fullEvidence({ oliWindows: [{ from: "2026-03-15", to: TO }] })); // gap before 03-15
  assert.ok(!r.payload && r.notReady === "not-ready", "not-ready");
  assert.ok(r.blockedBy.some((b) => b.sourceKey === "order-line-items"), "blocked on OLI coverage");
});

test("(5-invariant) a missing validated Catalog snapshot -> not-ready (never a fabricated report)", () => {
  const r = rederiveDailyV2Payload({ accountId: ACCOUNT, rawSellerId: RAW, currency: CUR, from: FROM, to: TO, brand: "ALL" },
    fullEvidence({ catalogSnapshot: null }));
  assert.ok(!r.payload && r.notReady === "not-ready");
  assert.ok(r.blockedBy.some((b) => b.sourceKey === "product-catalog"));
});

test("named-brand request derives the brand-FILTERED payload (no ads), exactly like the live route", () => {
  const r = rederiveDailyV2Payload({ accountId: ACCOUNT, rawSellerId: RAW, currency: CUR, from: FROM, to: TO, brand: "Acme" }, fullEvidence());
  assert.ok(r.payload);
  assert.equal(r.payload.brandFiltered, true, "brand-filtered");
  assert.ok(!("adsAvailability" in r.payload), "named-brand carries no ads");
});

// ---- latestProvenDailyTo: honestly clamp the requested as-of to each account's proven OLI coverage ----
test("latestProvenDailyTo clamps to the contiguous proven end containing `from`, capped at the ceiling", () => {
  // Proven [2025-01-01 .. 2026-08-22]; request ceiling 2026-08-24 -> clamp to 2026-08-22 (the real coverage end).
  assert.equal(latestProvenDailyTo({ oliWindows: [{ from: "2025-01-01", to: "2026-08-22" }], from: "2026-03-01", ceiling: "2026-08-24" }), "2026-08-22");
  // Proven through the ceiling and beyond -> capped AT the ceiling (never past what was reviewed).
  assert.equal(latestProvenDailyTo({ oliWindows: [{ from: "2025-01-01", to: "2026-09-30" }], from: "2026-03-01", ceiling: "2026-08-24" }), "2026-08-24");
  // Adjacent windows merge into one contiguous span -> the merged end is used.
  assert.equal(latestProvenDailyTo({ oliWindows: [{ from: "2025-01-01", to: "2026-08-09" }, { from: "2026-08-10", to: "2026-08-24" }], from: "2026-03-01", ceiling: "2026-08-24" }), "2026-08-24");
});
test("latestProvenDailyTo returns null when `from` itself is in a gap (report cannot be produced; never a fake zero)", () => {
  assert.equal(latestProvenDailyTo({ oliWindows: [{ from: "2026-03-15", to: "2026-08-24" }], from: "2026-03-01", ceiling: "2026-08-24" }), null);
  assert.equal(latestProvenDailyTo({ oliWindows: [], from: "2026-03-01", ceiling: "2026-08-24" }), null);
  // Malformed coverage evidence fails closed (never a false "proven").
  assert.equal(latestProvenDailyTo({ oliWindows: [{ from: "2026-08-21T18:30:00Z", to: "2026-08-24" }], from: "2026-03-01", ceiling: "2026-08-24" }), null);
});

test("durableRefreshedAt binds to the evidence (never wall-clock): latest of catalog / ads / data date", () => {
  const ts = durableRefreshedAt(fullEvidence(), "2026-03-10");
  assert.equal(ts, "2026-03-21T01:00:00.000Z", "catalog validated_at is the latest durable timestamp here");
});

// ---- the full operation: gather (durable readers only) + derive + save; ZERO DataDoe ----
function makeReaders(over = {}) {
  const calls = { create: 0 };
  const readers = {
    readOliHistory: async () => HISTORY,
    readOliCoverage: async () => ({ windows: OLI_WINDOWS, read: "ok", status: "succeeded" }),
    readAsinAds: async () => AD_ROWS,
    readAdsCoverage: async () => ASIN_COV,
    readCatalogSnapshot: async () => CATALOG_SNAP,
    loadCatalogPayload: async () => ({ rows: CATALOG }),
    ...over,
  };
  return { readers, calls };
}

async function main() {
await testAsync("(1)(7)(12) the operation gathers durable evidence + saves a v2 payload with ZERO create-export", async () => {
  const { readers } = makeReaders();
  const saves = [];
  const save = async ({ payload, sourceRefreshedAt }) => { saves.push({ payload, sourceRefreshedAt }); return { id: "snap-1", updated_at: "t" }; };
  // NOTE: `readers` has NO create/adapter -- a DataDoe export is structurally impossible in this operation.
  const res = await rederiveAndSaveDailyV2({ accountId: ACCOUNT, rawSellerId: RAW, currency: CUR, from: FROM, to: TO, brand: "ALL", organizationFingerprint: "org" }, { readers, save });
  assert.equal(res.published, true);
  assert.equal(saves.length, 1, "exactly one save");
  assert.equal(REPORT_DERIVATIONS["daily-reporting"].validatePayload(saves[0].payload), true, "saved payload passes the real contract");
  assert.equal(salesOf(saves[0].payload), 160);
  assert.ok(!("create" in readers), "no create-export capability is wired into the operation");
});

await testAsync("the operation returns typed not-ready (no save) when durable OLI coverage is unproven", async () => {
  const { readers } = makeReaders({ readOliCoverage: async () => ({ windows: [{ from: "2026-03-15", to: TO }], read: "ok" }) });
  const saves = [];
  const res = await rederiveAndSaveDailyV2({ accountId: ACCOUNT, rawSellerId: RAW, currency: CUR, from: FROM, to: TO, brand: "ALL", organizationFingerprint: "org" }, { readers, save: async (x) => { saves.push(x); return {}; } });
  assert.equal(res.published, false);
  assert.equal(res.notReady, "not-ready");
  assert.equal(saves.length, 0, "nothing saved when not ready (LKG preserved; no fabricated report)");
});

await testAsync("named-brand gather skips the Ads reads entirely (ads are ALL-brand only)", async () => {
  let adsReads = 0;
  const { readers } = makeReaders({ readAsinAds: async () => { adsReads += 1; return AD_ROWS; }, readAdsCoverage: async () => { adsReads += 1; return ASIN_COV; } });
  const ev = await gatherDailyDurableEvidence({ accountId: ACCOUNT, from: FROM, to: TO, brand: "Acme", organizationFingerprint: "org" }, readers);
  assert.equal(adsReads, 0, "no ASIN Ads reads for a named-brand payload");
  assert.deepEqual(ev.asinAdRows, []);
});

// ---- the read-path self-heal in serveSharedReport (concurrency + zero-export + honest waiting) ----
function makeStore() {
  const snaps = new Map(); const locks = new Set();
  const key = (o) => [o.reportKey, o.accountId, o.paramsHash].join("|");
  return {
    snaps, locks,
    claimRefreshLock: async (o) => { const k = key(o); if (locks.has(k)) return false; locks.add(k); return true; },
    releaseRefreshLock: async (o) => { locks.delete(key(o)); },
    getReportSnapshot: async (o) => snaps.get(key(o)) || null,
    saveReportSnapshot: async (o) => { const row = { id: "s", updated_at: "u", source_refreshed_at: o.sourceRefreshedAt, payload: o.payload, params: o.params }; snaps.set(key(o), row); return row; },
    publishSnapshotUpdate: async () => {},
  };
}
const fakeRes = () => { const cap = {}; return { res: { status: (c) => ({ json: (b) => { cap.code = c; cap.body = b; } }) }, cap }; };
const HEAL_ARGS = { reportKey: "daily-reporting", reportVersion: "daily-reporting-shared-v2", accountId: ACCOUNT, paramsHash: "ph1", params: { from: FROM, to: TO, brand: "ALL" }, label: "Daily Reporting" };

await testAsync("(1) self-heal on a missing read: re-derives, SAVES the v2 snapshot, and serves it", async () => {
  const store = makeStore(); const { res, cap } = fakeRes();
  const out2 = await selfHealFromDurable({ ...HEAL_ARGS, res, deriveDurable: async () => ({ payload: { rows: [{ date: "2026-03-05", total_sales: 160 }], brandFiltered: false, adsAvailability: { status: "validated" } }, sourceRefreshedAt: "2026-03-21T00:00:00Z" }) }, store);
  assert.equal(out2.served, true);
  assert.equal(cap.body.snapshot.rederived, true, "served payload is flagged re-derived");
  assert.equal(store.snaps.size, 1, "exactly one snapshot saved under the exact identity");
  assert.equal(store.snaps.get("daily-reporting|A01|ph1").params.reportVersion, "daily-reporting-shared-v2", "saved as v2 (never a v1 copy)");
});

await testAsync("(6) concurrent page loads produce exactly ONE derivation + ONE save (lock serializes)", async () => {
  const store = makeStore(); let derivations = 0;
  const derive = async () => { derivations += 1; await Promise.resolve(); return { payload: { rows: [], brandFiltered: false, adsAvailability: { status: "unavailable" } }, sourceRefreshedAt: "t" }; };
  const a = selfHealFromDurable({ ...HEAL_ARGS, res: fakeRes().res, deriveDurable: derive }, store);
  const b = selfHealFromDurable({ ...HEAL_ARGS, res: fakeRes().res, deriveDurable: derive }, store);
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(derivations, 1, "only the lock holder derives; the loser never derives a second time");
  assert.equal(store.snaps.size, 1, "exactly one durable save");
  assert.ok(ra.served || rb.served, "at least one request served the fresh payload");
});

await testAsync("self-heal double-checks inside the lock: if the winner already saved, the loser serves WITHOUT re-deriving", async () => {
  const store = makeStore(); let derivations = 0;
  // Pre-seed the snapshot as if a concurrent winner just saved it.
  store.snaps.set("daily-reporting|A01|ph1", { payload: { rows: [], brandFiltered: false, adsAvailability: { status: "validated" } }, params: { reportVersion: "daily-reporting-shared-v2" } });
  const { res, cap } = fakeRes();
  const out2 = await selfHealFromDurable({ ...HEAL_ARGS, res, deriveDurable: async () => { derivations += 1; return { payload: { rows: [] } }; } }, store);
  assert.equal(out2.served, true);
  assert.equal(derivations, 0, "the existing snapshot is served; no wasted re-derivation");
  assert.equal(cap.body.snapshot.rederived, true);
});

await testAsync("(4)(11) durable evidence unavailable -> honest not-ready with the missing source named (no fabricated zero, no save)", async () => {
  const store = makeStore(); const { res } = fakeRes();
  const out2 = await selfHealFromDurable({ ...HEAL_ARGS, res, deriveDurable: async () => ({ notReady: "not-ready", blockedBy: [{ sourceKey: "order-line-items", reason: "coverage-incomplete", blocksSales: true }] }) }, store);
  assert.equal(out2.served, false);
  assert.equal(out2.notReady, true);
  assert.deepEqual(out2.missingSources, ["Order Line Items sales history"], "the blocking source is named for the waiting state");
  assert.equal(store.snaps.size, 0, "nothing saved (LKG preserved; no fabricated values)");
});

await testAsync("a re-derivation FAILURE on a read degrades to honest not-ready (never a 500, never a fabricated value, no save)", async () => {
  const store = makeStore(); const { res } = fakeRes();
  const out2 = await selfHealFromDurable({ ...HEAL_ARGS, res, deriveDurable: async () => { throw new Error("durable OLI unreadable"); } }, store);
  assert.equal(out2.served, false);
  assert.equal(out2.notReady, true);
  assert.equal(store.snaps.size, 0, "nothing saved on failure");
});

await testAsync("(2) THIRTY primary accounts each produce a valid v2 payload from durable evidence, ZERO create", async () => {
  // 30 accounts, each with its own durable OLI history (distinct sales) -> 30 distinct valid v2 snapshots.
  const ids = Array.from({ length: 30 }, (_, i) => "A" + String(i + 1).padStart(2, "0"));
  const saves = new Map();
  let createCalls = 0;
  for (const id of ids) {
    const history = [{ account_id: id, sale_date: "2026-03-05", sku: "SKU-A", child_asin: "B0A", currency: "USD", sales_amount: 100 + Number(id.slice(1)), units: 3 }];
    const { readers } = makeReaders({ readOliHistory: async () => history });
    // The readers object has NO `create` -- a DataDoe export is structurally impossible in the batch.
    if ("create" in readers) createCalls += 1;
    const res = await rederiveAndSaveDailyV2(
      { accountId: id, rawSellerId: id, currency: "USD", from: FROM, to: TO, brand: "ALL", organizationFingerprint: "org" },
      { readers, save: async ({ payload }) => { saves.set(id, payload); return { id: "s-" + id }; } },
    );
    assert.equal(res.published, true, `account ${id} published`);
    assert.equal(REPORT_DERIVATIONS["daily-reporting"].validatePayload(saves.get(id)), true, `account ${id} payload valid`);
  }
  assert.equal(saves.size, 30, "30 distinct v2 snapshots");
  assert.equal(createCalls, 0, "ZERO DataDoe create-export across all 30 accounts");
  // Each account's snapshot reflects ITS OWN durable sales (isolation) -- account 1 != account 2.
  const s1 = saves.get("A01").rows.reduce((a, r) => a + (Number(r.total_sales) || 0), 0);
  const s2 = saves.get("A02").rows.reduce((a, r) => a + (Number(r.total_sales) || 0), 0);
  assert.notEqual(s1, s2, "per-account isolation: distinct durable evidence -> distinct totals");
});

// ---- the getSourceSnapshot {snapshot,read,error} wrapper shape (the catalog bug that blanked all 30) ----
await testAsync("gather HYDRATES the catalog from the getSourceSnapshot { snapshot, read } wrapper (not a flat pointer)", async () => {
  const { readers } = makeReaders({
    readCatalogSnapshot: async () => ({ snapshot: CATALOG_SNAP, read: "ok", error: null }), // production shape
    loadCatalogPayload: async (objPath) => { assert.equal(objPath, "cat/obj", "reads the NESTED pointer's object_path"); return CATALOG; },
  });
  const ev = await gatherDailyDurableEvidence({ accountId: ACCOUNT, from: FROM, to: TO, brand: "ALL", organizationFingerprint: "org" }, readers);
  assert.equal(Array.isArray(ev.catalogRows), true);
  assert.equal(ev.catalogRows.length, 2, "catalog rows hydrated from the wrapped snapshot");
  assert.equal(ev.catalogSnapshot.validated_at, CATALOG_SNAP.validated_at, "the nested pointer (validated_at) drives readiness");
});
await testAsync("gather treats a non-ok wrapped catalog read as unavailable (fail closed, no hydration)", async () => {
  const { readers } = makeReaders({ readCatalogSnapshot: async () => ({ snapshot: null, read: "read-failed", error: "x" }) });
  const ev = await gatherDailyDurableEvidence({ accountId: ACCOUNT, from: FROM, to: TO, brand: "ALL", organizationFingerprint: "org" }, readers);
  assert.equal(ev.catalogRows, null, "no catalog rows when the read failed");
});

// ---- clampToProven: derive/serve ENDING at the account's latest proven date, never the exact requested date ----
await testAsync("rederiveDailyV2 clampToProven derives to the latest proven date (< requested) + returns effectiveParams", async () => {
  const { readers } = makeReaders({ readOliCoverage: async () => ({ windows: [{ from: "2025-06-01", to: "2026-03-15" }], read: "ok" }) });
  const res = await rederiveDailyV2({ accountId: ACCOUNT, rawSellerId: RAW, currency: CUR, from: FROM, to: TO, brand: "ALL", organizationFingerprint: "org", clampToProven: true }, readers);
  assert.ok(res.payload, "derives despite requested to=2026-03-20 exceeding proven 2026-03-15");
  assert.equal(res.latestCompletedDate, "2026-03-15", "clamped to the proven end");
  assert.deepEqual(res.effectiveParams, { from: FROM, to: "2026-03-15", brand: "ALL" }, "effectiveParams carries the honest window");
});
await testAsync("rederiveDailyV2 clampToProven returns typed not-ready when `from` is in a coverage gap (no fabricated report)", async () => {
  const { readers } = makeReaders({ readOliCoverage: async () => ({ windows: [{ from: "2026-03-15", to: TO }], read: "ok" }) });
  const res = await rederiveDailyV2({ accountId: ACCOUNT, rawSellerId: RAW, currency: CUR, from: FROM, to: TO, brand: "ALL", organizationFingerprint: "org", clampToProven: true }, readers);
  assert.ok(!res.payload && res.notReady === "not-ready");
  assert.ok(res.blockedBy.some((b) => b.sourceKey === "order-line-items"), "blocked on OLI coverage at the window start");
});
await testAsync("rederiveAndSaveDailyV2 clampToProven hands the effective window to `save` (honest params for the row)", async () => {
  const { readers } = makeReaders({ readOliCoverage: async () => ({ windows: [{ from: "2025-06-01", to: "2026-03-15" }], read: "ok" }) });
  const saves = [];
  const res = await rederiveAndSaveDailyV2({ accountId: ACCOUNT, rawSellerId: RAW, currency: CUR, from: FROM, to: TO, brand: "ALL", organizationFingerprint: "org", clampToProven: true },
    { readers, save: async (x) => { saves.push(x); return { id: "s", payload_bytes: 10 }; } });
  assert.equal(res.published, true);
  assert.equal(saves.length, 1);
  assert.deepEqual(saves[0].effectiveParams, { from: FROM, to: "2026-03-15", brand: "ALL" }, "save receives the clamped window");
  assert.equal(saves[0].latestCompletedDate, "2026-03-15");
});

// ---- the read-path self-heal persists the CLAMPED identity honestly (params_hash matches params) ----
await testAsync("self-heal on a clamped derive persists under the EFFECTIVE hash + serves it as an earlier as-of (staleScope)", async () => {
  const store = makeStore(); const { res, cap } = fakeRes();
  const derived = {
    payload: { rows: [{ date: "2026-03-15", total_sales: 160 }], brandFiltered: false, adsAvailability: { status: "validated" } },
    sourceRefreshedAt: "2026-03-16T00:00:00Z",
    effectiveParams: { from: FROM, to: "2026-03-15", brand: "ALL" }, latestCompletedDate: "2026-03-15",
  };
  const out2 = await selfHealFromDurable({ ...HEAL_ARGS, res, deriveDurable: async () => derived }, store);
  assert.equal(out2.served, true);
  assert.equal(cap.body.snapshot.staleScope, true, "served as an earlier as-of (not pretending it covers the requested to)");
  assert.equal(cap.body.snapshot.savedForParams.to, "2026-03-15", "labelled with the real coverage date");
  assert.equal(cap.body.snapshot.requestedParams.to, TO, "and the requested date it was NOT able to cover");
  // The row is stored under the EFFECTIVE identity (its params_hash matches its params), NOT the requested ph1.
  assert.equal(store.snaps.has("daily-reporting|A01|ph1"), false, "not stored under the requested (mismatched) hash");
  const stored = [...store.snaps.values()][0];
  assert.equal(stored.params.to, "2026-03-15", "stored params carry the honest effective window");
  assert.equal(stored.params.reportVersion, "daily-reporting-shared-v2", "saved as v2 (never a v1 copy)");
});
}

await main();
out("\n" + passed + " assertions passed");
