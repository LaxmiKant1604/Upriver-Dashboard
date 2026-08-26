// Trusted ZERO-EXPORT Brand Sales backfill operator: republishes brand-sales-shared-v1 for a set of primary
// accounts from the CORRECTED durable rollup ONLY. Proves: each account ends at its OWN latest proven OLI date; the
// derivation is the REAL brand-sales contract fed from the non-cancelled rollup (cancelled/zero already excluded);
// it is structurally incapable of a DataDoe export (no adapter); a replay with an unchanged sales fingerprint
// performs ZERO writes (idempotent); a strictly-newer live snapshot is never overwritten (newer-live); params_hash
// provenance is enforced; seller name + marketplace come from the directory (fail closed if missing).
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { REPORT_DERIVATIONS } from "../lib/server/sync/report-derivation.js";
import { paramsHashFor } from "../lib/server/report-store.js";
import { readFileSync } from "node:fs";
import { backfillBrandSalesV1, brandSalesProvenanceOf, deriveBrandSalesFromDurable, BRAND_SALES_REPORT_KEY, BRAND_SALES_LIVE_VERSION } from "../lib/server/reports/brand-sales-backfill.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const testAsync = async (name, fn) => { try { await fn(); passed += 1; out("  ok  " + name); } catch (e) { out("FAIL  " + name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; } };

const V1 = BRAND_SALES_LIVE_VERSION;
const FROM = "2025-01-01", CEIL = "2026-08-25";
const CATALOG = [
  { child_asin: "B0A", sku: "SKU-A", parent_asin: "P", product_name: "A", product_brand: "Acme" },
  { child_asin: "B0B", sku: "SKU-B", parent_asin: "P", product_name: "B", product_brand: "Bolt" },
];
const CATALOG_SNAP = { validated_at: "2026-08-26T11:06:48.000Z", object_path: "cat/obj", row_count: 2 };
const salesOf = (p) => (p.rows || []).reduce((a, r) => a + (Number(r.total_sales_sum) || 0), 0);

// The rollup rows source_oli_daily_history feeds -- ALREADY non-cancelled (the RPC/classify layer excludes
// cancelled + zero-value upstream; that is proven by oli-dimensional.test.js). Here we feed rollup rows and prove
// the backfill derives brand-sales faithfully from them.
const rollupRow = (id, date, amt, units = 2, asin = "B0A", sku = "SKU-A") => ({ account_id: id, sale_date: date, seller_or_vendor_id: id, sku, child_asin: asin, currency: "USD", sales_amount: amt, units });

function makeReaders({ historyByAcct, windowsByAcct, calls }) {
  return {
    readOliHistory: async ({ accountIds }) => { calls.oliHistory += 1; return historyByAcct[accountIds[0]] || []; },
    readOliCoverage: async ({ accountId }) => { calls.oliCov += 1; return { windows: windowsByAcct[accountId] || [], read: "ok", status: "succeeded" }; },
    readAsinAds: async () => [],
    readAdsCoverage: async () => ({ windows: [], read: "ok", status: "missing", latestMetricDate: null }),
    readCatalogSnapshot: async () => ({ snapshot: CATALOG_SNAP, read: "ok", error: null }),
    loadCatalogPayload: async () => ({ rows: CATALOG }),
  };
}

function makeStore({ saveCalls, seed = new Map() }) {
  const snaps = seed; const locks = new Set();
  return {
    snaps, paramsHashFor,
    claimLock: async ({ accountId, paramsHash }) => { const k = accountId + "|" + paramsHash; if (locks.has(k)) return false; locks.add(k); return true; },
    releaseLock: async ({ accountId }) => { for (const k of [...locks]) if (k.startsWith(accountId + "|")) locks.delete(k); },
    getExisting: async ({ accountId, paramsHash }) => snaps.get([BRAND_SALES_REPORT_KEY, accountId, paramsHash].join("|")) || null,
    save: async ({ reportKey, reportVersion, accountId, paramsHash, params, payload, sourceRefreshedAt }) => {
      // provenance: params_hash must equal paramsHashFor(version, {from,to})
      const expected = paramsHashFor(reportVersion, { from: params.from, to: params.to });
      if (paramsHash !== expected) throw new Error("wrong-hash refused");
      saveCalls.push({ accountId, paramsHash, params });
      const row = { id: "s-" + accountId, updated_at: "u", source_refreshed_at: sourceRefreshedAt, payload, params, payload_bytes: 10 };
      snaps.set([reportKey, accountId, paramsHash].join("|"), row);
      return row;
    },
    validatePayload: (p) => REPORT_DERIVATIONS["brand-sales"].validatePayload(p),
  };
}
const ACCTS = [{ accountId: "acctFull", name: "Full Co", country: "US" }, { accountId: "acctBehind", name: "Behind Co", country: "IN" }];

async function main() {
await testAsync("publishes each account ENDING at its OWN latest proven date; ZERO exports", async () => {
  const historyByAcct = {
    acctFull: [rollupRow("acctFull", "2026-03-05", 100), rollupRow("acctFull", "2026-08-25", 25)],
    acctBehind: [rollupRow("acctBehind", "2026-03-05", 50), rollupRow("acctBehind", "2026-08-22", 22)],
  };
  const windowsByAcct = { acctFull: [{ from: FROM, to: "2026-08-25" }], acctBehind: [{ from: FROM, to: "2026-08-22" }] };
  const saveCalls = []; const calls = { oliHistory: 0, oliCov: 0 };
  const store = makeStore({ saveCalls });
  const { results, summary } = await backfillBrandSalesV1({
    accounts: ACCTS, from: FROM, asOfCeiling: CEIL, organizationFingerprint: "org",
    readers: makeReaders({ historyByAcct, windowsByAcct, calls }), store,
  });
  assert.equal(summary.failed, 0);
  assert.equal(summary.creates, 0, "structurally zero exports");
  const byId = Object.fromEntries(results.map((r) => [r.accountId, r]));
  assert.equal(byId.acctFull.to, "2026-08-25", "full account ends at the ceiling it proves");
  assert.equal(byId.acctBehind.to, "2026-08-22", "behind account ends at its OWN latest proven date (never padded)");
  assert.equal(saveCalls.length, 2, "two fresh publishes");
});

await testAsync("IDEMPOTENT replay: an unchanged sales fingerprint performs ZERO writes", async () => {
  const historyByAcct = { acctFull: [rollupRow("acctFull", "2026-08-25", 25)] };
  const windowsByAcct = { acctFull: [{ from: FROM, to: "2026-08-25" }] };
  const seed = new Map(); const saveCalls = []; const calls = { oliHistory: 0, oliCov: 0 };
  const store = makeStore({ saveCalls, seed });
  const acct = [{ accountId: "acctFull", name: "Full Co", country: "US" }];
  const args = { accounts: acct, from: FROM, asOfCeiling: CEIL, organizationFingerprint: "org", readers: makeReaders({ historyByAcct, windowsByAcct, calls }), store };
  await backfillBrandSalesV1(args);           // first publish
  assert.equal(saveCalls.length, 1);
  const r2 = await backfillBrandSalesV1(args); // replay
  assert.equal(saveCalls.length, 1, "replay wrote NOTHING");
  assert.equal(r2.results[0].status, "existing", "same sales fingerprint -> existing");
});

await testAsync("a strictly-NEWER live snapshot is never overwritten (newer-live, LKG preserved)", async () => {
  const historyByAcct = { acctFull: [rollupRow("acctFull", "2026-08-25", 25)] };
  const windowsByAcct = { acctFull: [{ from: FROM, to: "2026-08-25" }] };
  const seed = new Map(); const saveCalls = [];
  const store = makeStore({ saveCalls, seed });
  const acct = [{ accountId: "acctFull", name: "Full Co", country: "US" }];
  // Seed an existing snapshot with DIFFERENT sales (so fingerprint differs) but a FUTURE source_refreshed_at.
  const params = { from: FROM, to: "2026-08-25" };
  const hash = paramsHashFor(V1, params);
  seed.set([BRAND_SALES_REPORT_KEY, "acctFull", hash].join("|"), {
    id: "old", source_refreshed_at: "2099-01-01T00:00:00.000Z",
    params: { reportVersion: V1, ...params },
    payload: { rows: [{ total_sales_sum: 999999, total_units_sold_sum: 9 }], asinBrand: { B0A: "Acme" }, catalogBrands: ["Acme"] },
  });
  const r = await backfillBrandSalesV1({ accounts: acct, from: FROM, asOfCeiling: CEIL, organizationFingerprint: "org", readers: makeReaders({ historyByAcct, windowsByAcct, calls: { oliHistory: 0, oliCov: 0 } }), store });
  assert.equal(r.results[0].status, "newer-live", "the newer live snapshot wins");
  assert.equal(saveCalls.length, 0, "ZERO writes -- LKG preserved");
});

await testAsync("fails closed when the directory account lacks name/country (seller/marketplace never invented)", async () => {
  const historyByAcct = { x: [rollupRow("x", "2026-08-25", 25)] };
  const windowsByAcct = { x: [{ from: FROM, to: "2026-08-25" }] };
  const store = makeStore({ saveCalls: [] });
  const r = await backfillBrandSalesV1({ accounts: [{ accountId: "x", name: "", country: "" }], from: FROM, asOfCeiling: CEIL, organizationFingerprint: "org", readers: makeReaders({ historyByAcct, windowsByAcct, calls: { oliHistory: 0, oliCov: 0 } }), store });
  assert.equal(r.results[0].status, "failed", "no name/country -> failed (never a fabricated seller/marketplace)");
});

await testAsync("brandSalesProvenanceOf flips when totals change (a cancelled/zero correction republishes)", () => {
  const a = brandSalesProvenanceOf({ rows: [{ total_sales_sum: 100, total_units_sold_sum: 2 }] });
  const b = brandSalesProvenanceOf({ rows: [{ total_sales_sum: 129.18, total_units_sold_sum: 3 }] }); // cancelled included
  assert.notEqual(a, b, "including cancelled shifts the fingerprint -> republish");
  const c = brandSalesProvenanceOf({ rows: [{ total_sales_sum: 100, total_units_sold_sum: 2 }] });
  assert.equal(a, c, "identical totals -> identical fingerprint (idempotent)");
});

await testAsync("deriveBrandSalesFromDurable derives ONLY from the corrected rollup (cancelled/zero already excluded); ZERO export", async () => {
  // The rollup rows are the NON-cancelled evidence -> the derived business totals equal the rollup sum, with no
  // cancelled inflation (a raw ORDER_SALES fold would be higher). No DataDoe adapter is present -> zero export.
  const id = "acctFull";
  const historyByAcct = { [id]: [rollupRow(id, "2026-03-05", 100, 2), rollupRow(id, "2026-08-25", 40, 1, "B0B", "SKU-B")] };
  const windowsByAcct = { [id]: [{ from: FROM, to: "2026-08-25" }] };
  const derived = await deriveBrandSalesFromDurable({
    account: { accountId: id, name: "Full Co", country: "US" },
    from: FROM, to: CEIL, organizationFingerprint: "org",
    readers: makeReaders({ historyByAcct, windowsByAcct, calls: { oliHistory: 0, oliCov: 0 } }),
  });
  assert.equal(derived.notReady, undefined, "ready");
  assert.equal(derived.to, "2026-08-25");
  const total = (derived.payload.rows || []).reduce((s, r) => s + Number((r.total_sales != null ? r.total_sales : r.total_sales_sum) || 0), 0);
  assert.equal(total, 140, "business total equals the non-cancelled rollup sum (100 + 40), never a cancelled-inflated raw total");
});

await testAsync("deriveBrandSalesFromDurable fails typed (never invents) when name/country or coverage is missing", async () => {
  const id = "acctFull";
  const readers = makeReaders({ historyByAcct: { [id]: [rollupRow(id, "2026-08-25", 10)] }, windowsByAcct: { [id]: [{ from: FROM, to: "2026-08-25" }] }, calls: { oliHistory: 0, oliCov: 0 } });
  const noName = await deriveBrandSalesFromDurable({ account: { accountId: id, name: "", country: "US" }, from: FROM, to: CEIL, organizationFingerprint: "org", readers });
  assert.ok(noName.notReady, "missing seller name -> notReady (orderRowsFromHistory refuses to invent)");
  const noCov = await deriveBrandSalesFromDurable({ account: { accountId: id, name: "Full Co", country: "US" }, from: FROM, to: CEIL, organizationFingerprint: "org", readers: makeReaders({ historyByAcct: {}, windowsByAcct: {}, calls: { oliHistory: 0, oliCov: 0 } }) });
  assert.equal(noCov.notReady, "oli-coverage-incomplete");
});

await testAsync("STRUCTURAL: no brand-sales PUBLISHER is wired to the raw ORDER_SALES buildBrandSalesPayload", () => {
  const adapters = readFileSync(new URL("../lib/server/sync/adapters/index.js", import.meta.url), "utf8");
  assert.ok(!/import\s+\{[^}]*buildBrandSalesPayload/.test(adapters), "the scheduler adapter must NOT import the raw buildBrandSalesPayload");
  assert.ok(!/buildBrandSalesPayload\s*\(/.test(adapters), "the scheduler adapter must NOT call the raw buildBrandSalesPayload");
  assert.ok(/deriveCorrectedBrandSalesForAccount/.test(adapters), "the scheduler adapter derives brand-sales from durable evidence");
  const datadoe = readFileSync(new URL("../api/datadoe.js", import.meta.url), "utf8");
  // buildBrandSalesPayload may still be DEFINED (an export used only by legacy tests), but NO caller may INVOKE it,
  // and the action=brand-sales route must publish via the durable refresher.
  assert.ok(!/await buildBrandSalesPayload\(/.test(datadoe), "no route may call (await) the raw buildBrandSalesPayload");
  assert.ok(/refreshCorrectedBrandSalesForAccount/.test(datadoe), "the route publishes via the corrected durable refresher");
});

out("\n" + passed + " assertions passed");
}
main();
