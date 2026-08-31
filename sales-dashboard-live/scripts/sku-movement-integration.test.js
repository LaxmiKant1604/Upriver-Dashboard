// SKU Movement -- END-TO-END integration regressions over the ACTUAL durable modules (rederive + backfill + registry),
// with in-memory durable readers/store (no DB, no network). Proves the mission's non-negotiables:
//   * ZERO DataDoe: no adapter is ever present -> creates=0/tokens=0 structurally;
//   * honest per-account effectiveAsOf (own latest proven OLI date, capped at D-1; never padded, never fabricated);
//   * covered date with no sale = 0, month before coverage = null (unavailable), NEVER a fabricated zero;
//   * no double-count across currency; account isolation (only the queried account's rows reach a payload);
//   * brand isolation: a named brand yields ONLY its Catalog-proven ASINs (Unmapped excluded), punctuation is
//     significant, and an unmatched brand is a VALID empty report (never an All-Brands fallback);
//   * idempotent replay (ZERO writes), units-correction republish, freshness CAS (never overwrite a newer live row);
//   * scheduler/manual/self-heal PARITY (backfill payload byte-identical to a direct re-derive -- one derive path);
//   * params_hash provenance is enforced; unrelated reports are byte-identical (additive registry entry only).
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { REPORT_DERIVATIONS } from "../lib/server/sync/report-derivation.js";
import { paramsHashFor } from "../lib/server/report-store.js";
import { rederiveSkuMovement } from "../lib/server/reports/sku-movement-durable-rederive.js";
import {
  backfillSkuMovement, makeSkuMovementProvenanceGuardedSave, skuMovementUnitsProvenanceOf,
  SKU_MOVEMENT_REPORT_KEY, SKU_MOVEMENT_VERSION,
} from "../lib/server/reports/sku-movement-backfill.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const testAsync = async (name, fn) => { try { await fn(); passed += 1; out("  ok  " + name); } catch (e) { out("FAIL  " + name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; } };

const CEIL = "2026-08-27"; // reviewed D-1 ceiling for the whole suite
const CATALOG = [
  { child_asin: "A1", sku: "S1", product_name: "Espresso Cups", product_brand: "Caruso Italy" },
  { child_asin: "A2", sku: "S2", product_name: "Moka Pot", product_brand: "Caruso-Italy" }, // hyphen -> a DISTINCT brand
  { child_asin: "A3", sku: "S3", product_name: "Mystery Item", product_brand: "" },           // blank -> Unmapped
];
const CATALOG_SNAP = { validated_at: "2026-08-27T02:00:00.000Z", object_path: "cat/obj", row_count: 3 };

// Account "A": full history from 2025-01-01 through the ceiling.
const HISTORY_A = [
  { sale_date: "2026-08-27", child_asin: "A1", sku: "S1", units: 5, currency: "EUR" }, // last5 (Aug27)
  { sale_date: "2026-08-27", child_asin: "A1", sku: "S1", units: 3, currency: "USD" }, // SAME date/asin/sku, other currency -> must sum, not double a date
  { sale_date: "2026-08-20", child_asin: "A1", sku: "S1", units: 2, currency: "EUR" }, // prev5 (Aug20)
  { sale_date: "2026-07-15", child_asin: "A1", sku: "S1", units: 10, currency: "EUR" }, // Jul completed month
  { sale_date: "2026-08-10", child_asin: "A1", sku: "S1", units: 4, currency: "EUR" }, // MTD, not in either 5-day window
  { sale_date: "2026-08-25", child_asin: "A2", sku: "S2", units: 7, currency: "EUR" }, // last5, brand Caruso-Italy
  { sale_date: "2026-08-24", child_asin: "A3", sku: "S3", units: 1, currency: "EUR" }, // last5, Unmapped
];
// Account "Z": a DIFFERENT account with its OWN, disjoint ASIN -- used to prove isolation.
const HISTORY_Z = [{ sale_date: "2026-08-26", child_asin: "A1", sku: "Z9", units: 99, currency: "EUR" }];
// Account "RECENT": coverage only from 2026-08-01, so the three completed months are all BEFORE coverage (null).
const HISTORY_RECENT = [{ sale_date: "2026-08-10", child_asin: "A1", sku: "S1", units: 3, currency: "EUR" }];

// PRODUCTION shape: getSourceCoverageWindows returns windows as { from, to }. (Account "A" also carries a raw
// covered_from/covered_to window to prove skuMovementProvenDates accepts both column spellings.)
const WINDOWS = {
  A: [{ from: "2025-01-01", to: "2026-08-27" }, { covered_from: "2025-01-01", covered_to: "2026-08-27" }],
  Z: [{ from: "2025-01-01", to: "2026-08-27" }],
  LAG: [{ from: "2025-01-01", to: "2026-08-20" }], // proven only through Aug20 -> honest earlier as-of
  BEYOND: [{ from: "2025-01-01", to: "2026-09-30" }], // proven beyond ceiling -> must cap at CEIL
  RECENT: [{ from: "2026-08-01", to: "2026-08-27" }],
  NONE: [],
};
const HISTORY = { A: HISTORY_A, Z: HISTORY_Z, LAG: HISTORY_A, BEYOND: HISTORY_A, RECENT: HISTORY_RECENT, NONE: [] };

function makeReaders(calls = { oliHistory: 0, oliCov: 0, cat: 0 }) {
  return {
    calls,
    readOliHistory: async ({ accountIds }) => { calls.oliHistory += 1; return HISTORY[accountIds[0]] || []; },
    readOliCoverage: async ({ accountId }) => { calls.oliCov += 1; return { read: "ok", status: "succeeded", windows: WINDOWS[accountId] || [] }; },
    readCatalogSnapshot: async () => { calls.cat += 1; return { snapshot: CATALOG_SNAP, read: "ok", error: null }; },
    loadCatalogPayload: async () => ({ rows: CATALOG }),
  };
}

function makeStore({ saveCalls = [], seed = new Map() } = {}) {
  const snaps = seed; const locks = new Set();
  const guardedSave = makeSkuMovementProvenanceGuardedSave({
    paramsHashFor,
    saveSnapshot: async ({ accountId, paramsHash, params, payload, sourceRefreshedAt }) => {
      saveCalls.push({ accountId, paramsHash, params });
      const row = { id: "s-" + accountId, updated_at: "u", source_refreshed_at: sourceRefreshedAt || "r", payload, params, payload_bytes: 42 };
      snaps.set([SKU_MOVEMENT_REPORT_KEY, accountId, paramsHash].join("|"), row);
      return row;
    },
  });
  return {
    snaps, saveCalls, paramsHashFor,
    claimLock: async ({ accountId, paramsHash }) => { const k = accountId + "|" + paramsHash; if (locks.has(k)) return false; locks.add(k); return true; },
    releaseLock: async ({ accountId }) => { for (const k of [...locks]) if (k.startsWith(accountId + "|")) locks.delete(k); },
    getExisting: async ({ accountId, paramsHash }) => snaps.get([SKU_MOVEMENT_REPORT_KEY, accountId, paramsHash].join("|")) || null,
    save: guardedSave,
    validatePayload: (p) => REPORT_DERIVATIONS[SKU_MOVEMENT_REPORT_KEY].validatePayload(p),
  };
}

const rowByAsin = (payload, asin) => (payload.rows || []).find((r) => r.asin === asin) || null;

await testAsync("backfill publishes an account AS-OF the ceiling with rows; creates=0/tokens=0 (no adapter)", async () => {
  const readers = makeReaders(); const store = makeStore();
  const { results, summary } = await backfillSkuMovement({ accounts: [{ accountId: "A" }], asOfCeiling: CEIL, organizationFingerprint: "fp", readers, store });
  assert.equal(summary.published, 1);
  assert.equal(summary.creates, 0); assert.equal(summary.tokens, 0);
  assert.equal(results[0].asOf, "2026-08-27");
  assert.ok(results[0].rows >= 3);
});

await testAsync("replay is idempotent: a second run performs ZERO writes (existing)", async () => {
  const readers = makeReaders(); const store = makeStore();
  await backfillSkuMovement({ accounts: [{ accountId: "A" }], asOfCeiling: CEIL, organizationFingerprint: "fp", readers, store });
  const before = store.saveCalls.length;
  const { summary } = await backfillSkuMovement({ accounts: [{ accountId: "A" }], asOfCeiling: CEIL, organizationFingerprint: "fp", readers, store });
  assert.equal(summary.existing, 1);
  assert.equal(store.saveCalls.length, before, "replay must write nothing");
});

await testAsync("a units correction (interior date re-stated) republishes", async () => {
  const readers = makeReaders(); const store = makeStore();
  await backfillSkuMovement({ accounts: [{ accountId: "A" }], asOfCeiling: CEIL, organizationFingerprint: "fp", readers, store });
  // Mutate the fixture so A1's Jul units change, then run again -> the units fingerprint flips.
  const original = HISTORY_A[3].units; HISTORY_A[3].units = 999;
  try {
    const { summary } = await backfillSkuMovement({ accounts: [{ accountId: "A" }], asOfCeiling: CEIL, organizationFingerprint: "fp", readers, store });
    assert.equal(summary.republished, 1);
  } finally { HISTORY_A[3].units = original; }
});

await testAsync("honest per-account as-of: a lagging account publishes its OWN proven date, not the ceiling", async () => {
  const readers = makeReaders(); const store = makeStore();
  const { results } = await backfillSkuMovement({ accounts: [{ accountId: "LAG" }], asOfCeiling: CEIL, organizationFingerprint: "fp", readers, store });
  assert.equal(results[0].status, "published");
  assert.equal(results[0].asOf, "2026-08-20", "must not pad to the ceiling");
});

await testAsync("effectiveAsOf is CAPPED at the ceiling when coverage runs past it", async () => {
  const readers = makeReaders();
  const derived = await rederiveSkuMovement({ accountId: "BEYOND", brand: "ALL", organizationFingerprint: "fp", ceiling: CEIL }, readers);
  assert.equal(derived.effectiveParams.asOf, CEIL);
  assert.equal(derived.payload.effectiveAsOf, CEIL);
});

await testAsync("no coverage -> failed (typed), NO write, last-known-good untouched", async () => {
  const readers = makeReaders();
  const seed = new Map();
  // Seed an LKG under a DIFFERENT (older) identity to prove it is never touched.
  seed.set([SKU_MOVEMENT_REPORT_KEY, "NONE", "old"].join("|"), { payload: { rows: [], effectiveAsOf: "2026-08-01", brandFiltered: false }, params: { reportVersion: SKU_MOVEMENT_VERSION, asOf: "2026-08-01", brand: "ALL" }, source_refreshed_at: "z" });
  const store = makeStore({ seed });
  const { results, summary } = await backfillSkuMovement({ accounts: [{ accountId: "NONE" }], asOfCeiling: CEIL, organizationFingerprint: "fp", readers, store });
  assert.equal(summary.failed, 1);
  assert.equal(results[0].reason, "oli-coverage-incomplete");
  assert.equal(store.saveCalls.length, 0);
  assert.ok(store.snaps.has([SKU_MOVEMENT_REPORT_KEY, "NONE", "old"].join("|")), "LKG must remain");
});

await testAsync("v2 currency ISOLATION: EUR + USD for the same ASIN are separate rows (never summed); covered no-sale = 0", async () => {
  const readers = makeReaders();
  const derived = await rederiveSkuMovement({ accountId: "A", brand: "ALL", organizationFingerprint: "fp", ceiling: CEIL }, readers);
  const a1Rows = (derived.payload.rows || []).filter((r) => r.asin === "A1");
  assert.equal(a1Rows.length, 2, "EUR and USD A1 are currency-isolated rows (Phase 4: never combine across currency)");
  const eur = a1Rows.find((r) => r.currency === "EUR"); const usd = a1Rows.find((r) => r.currency === "USD");
  assert.equal(eur.dailyUnits["2026-08-27"], 5, "EUR Aug27 units, summed once (no double count within the currency)");
  assert.equal(usd.dailyUnits["2026-08-27"], 3, "USD Aug27 units stay in the USD row");
  assert.equal(eur.dailyUnits["2026-08-23"] || 0, 0, "a covered date with no sale is an honest 0 (absent from the sparse daily map)");
});

await testAsync("month entirely before coverage is UNAVAILABLE (null), never a fabricated 0", async () => {
  const readers = makeReaders();
  const derived = await rederiveSkuMovement({ accountId: "RECENT", brand: "ALL", organizationFingerprint: "fp", ceiling: CEIL }, readers);
  const a1 = rowByAsin(derived.payload, "A1");
  assert.deepEqual(a1.months.map((m) => m.units), [null, null, null], "May/Jun/Jul precede 2026-08-01 coverage");
  assert.equal(a1.mtdUnits, 3);
  assert.equal(a1.avgMonthlyUnits, null, "no available month -> avg is null, not 0");
});

await testAsync("account isolation: only the queried account's rows reach its payload", async () => {
  const readers = makeReaders();
  const dA = await rederiveSkuMovement({ accountId: "A", brand: "ALL", organizationFingerprint: "fp", ceiling: CEIL }, readers);
  const dZ = await rederiveSkuMovement({ accountId: "Z", brand: "ALL", organizationFingerprint: "fp", ceiling: CEIL }, readers);
  assert.ok(rowByAsin(dA.payload, "A2"), "A has A2");
  assert.equal(dZ.payload.rows.length, 1, "Z has exactly its own one grain");
  assert.equal(dZ.payload.rows[0].sku, "Z9");
  assert.ok(!dZ.payload.rows.some((r) => r.sku === "S1" || r.sku === "S2"), "Z must contain NONE of A's SKUs");
});

await testAsync("brand isolation: a named brand yields ONLY its Catalog-proven ASINs; Unmapped excluded", async () => {
  const readers = makeReaders();
  const d = await rederiveSkuMovement({ accountId: "A", brand: "Caruso Italy", organizationFingerprint: "fp", ceiling: CEIL }, readers);
  assert.equal(d.payload.brandFiltered, true);
  assert.deepEqual([...new Set(d.payload.rows.map((r) => r.asin))], ["A1"], "only A1 (its currency rows); A2 (hyphen) + A3 (Unmapped) excluded");
});

await testAsync("brand punctuation is significant: 'Caruso-Italy' is a different brand from 'Caruso Italy'", async () => {
  const readers = makeReaders();
  const d = await rederiveSkuMovement({ accountId: "A", brand: "Caruso-Italy", organizationFingerprint: "fp", ceiling: CEIL }, readers);
  assert.deepEqual(d.payload.rows.map((r) => r.asin), ["A2"]);
});

await testAsync("unmatched brand is a VALID empty report, never an All-Brands fallback", async () => {
  const readers = makeReaders();
  const d = await rederiveSkuMovement({ accountId: "A", brand: "Totally Unknown Brand", organizationFingerprint: "fp", ceiling: CEIL }, readers);
  assert.equal(d.payload.brandFiltered, true);
  assert.deepEqual(d.payload.rows, [], "empty, NOT the ALL rows");
  assert.ok(REPORT_DERIVATIONS[SKU_MOVEMENT_REPORT_KEY].validatePayload(d.payload), "an empty branded payload is still valid");
});

await testAsync("scheduler/manual/self-heal PARITY: backfill payload is byte-identical to a direct re-derive", async () => {
  const readers = makeReaders(); const store = makeStore();
  await backfillSkuMovement({ accounts: [{ accountId: "A" }], asOfCeiling: CEIL, organizationFingerprint: "fp", readers, store });
  const savedRow = [...store.snaps.values()].find((r) => r.params.brand === "ALL");
  const direct = await rederiveSkuMovement({ accountId: "A", brand: "ALL", organizationFingerprint: "fp", ceiling: CEIL }, makeReaders());
  assert.equal(JSON.stringify(savedRow.payload), JSON.stringify(direct.payload), "one derive path -> identical output everywhere");
});

await testAsync("freshness CAS: a strictly-newer live snapshot is NEVER overwritten", async () => {
  const readers = makeReaders();
  const seed = new Map();
  const asOf = CEIL; const ph = paramsHashFor(SKU_MOVEMENT_VERSION, { asOf, brand: "ALL" });
  seed.set([SKU_MOVEMENT_REPORT_KEY, "A", ph].join("|"), {
    payload: { rows: [], accountId: "A", catalogBrands: [], effectiveAsOf: asOf, brand: "ALL", brandFiltered: false, monthLabels: ["", "", ""], mtdLabel: "x", last5Dates: [], thresholds: {} },
    params: { reportVersion: SKU_MOVEMENT_VERSION, asOf, brand: "ALL" },
    source_refreshed_at: "2999-01-01T00:00:00.000Z", // far in the future -> newer than any fresh derive
  });
  const store = makeStore({ seed });
  const { results } = await backfillSkuMovement({ accounts: [{ accountId: "A" }], asOfCeiling: CEIL, organizationFingerprint: "fp", readers, store });
  assert.equal(results[0].status, "newer-live");
  assert.equal(store.saveCalls.length, 0, "must not overwrite the newer live row");
});

await testAsync("params_hash provenance is enforced (a forged hash is refused)", async () => {
  const guarded = makeSkuMovementProvenanceGuardedSave({ paramsHashFor, saveSnapshot: async () => ({ id: "x" }) });
  await assert.rejects(() => guarded({
    reportKey: SKU_MOVEMENT_REPORT_KEY, reportVersion: SKU_MOVEMENT_VERSION, accountId: "A",
    paramsHash: "forged-hash", params: { asOf: CEIL, brand: "ALL" }, payload: {}, sourceRefreshedAt: "r",
  }), /wrong-hash refused/);
});

await testAsync("unrelated reports are byte-identical; sku-movement is an ADDITIVE registry entry", async () => {
  assert.equal(REPORT_DERIVATIONS["daily-reporting"].snapshotVersion, "daily-reporting/v2e-1");
  assert.equal(REPORT_DERIVATIONS["brand-inventory"].snapshotVersion, "brand-inventory-shared-v1");
  assert.ok(REPORT_DERIVATIONS["brand-sales"], "brand-sales still present");
  assert.ok(REPORT_DERIVATIONS["sales-movers"], "sales-movers still present");
  assert.equal(REPORT_DERIVATIONS[SKU_MOVEMENT_REPORT_KEY].snapshotVersion, SKU_MOVEMENT_VERSION);
});

await testAsync("catalogBrands is ACCOUNT-scoped (this account's sold+proven brands only, no org leakage, Unmapped excluded)", async () => {
  const readers = makeReaders();
  const d = await rederiveSkuMovement({ accountId: "A", brand: "ALL", organizationFingerprint: "fp", ceiling: CEIL }, readers);
  assert.deepEqual(d.payload.catalogBrands, ["Caruso Italy", "Caruso-Italy"], "A3 (blank brand) contributes no selector entry");
  assert.equal(d.payload.accountId, "A");
});

await testAsync("units-provenance fingerprint flips on any unit change (correction detector)", async () => {
  const readers = makeReaders();
  const d1 = await rederiveSkuMovement({ accountId: "A", brand: "ALL", organizationFingerprint: "fp", ceiling: CEIL }, readers);
  const p1 = skuMovementUnitsProvenanceOf(d1.payload);
  const cloned = JSON.parse(JSON.stringify(d1.payload)); cloned.rows[0].mtdUnits += 1;
  assert.notEqual(skuMovementUnitsProvenanceOf(cloned), p1);
});

out(`\n${passed} assertions passed`);
