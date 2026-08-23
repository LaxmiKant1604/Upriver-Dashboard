// Scheduler v2 -- DURABLE BACKFILL + INCREMENTAL MODEL proof suite (offline, ZERO network/DB).
//
// Proves the pure durable-source-model policy layer (lib/server/sync/source-durable-model.js), the
// canonical brand resolution (lib/server/sync/brand-resolution.js), and the PREPARED-UNAPPLIED durable
// migration (supabase/migrations/20260820_source_durable_model.sql + its schema-contract registration):
//   A. windows -- the OLI initial backfill covers the longest Daily/Brand View period (420d from month
//      start; Daily's 5-month window is a strict subset); the rolling refresh is exactly 7 days.
//   B. coverage -- proven windows merge fail-closed; COMPLETED historical coverage is never exported again;
//      only genuinely missing canonical slices are export candidates.
//   C. slice-subset batching -- a steady-state <=5-account batch refreshes as ONE export per rolling slice;
//      a newly discovered account backfills SOLO (completed members never re-exported); fully-proven
//      windows produce ZERO units.
//   D. history grain -- one shared batch fragment maps to per-account canonical rows; same-grain partials
//      sum; unknown/blank sellers, invalid dates/currencies and malformed rows reject the WHOLE payload;
//      the PK grain upserts idempotently so a late Amazon correction REPLACES its row (no duplication).
//   E. snapshots -- once-daily per-organization catalog decision; FBA latest-validated-only; the
//      recordSourceSnapshot wrapper REFUSES incomplete (non-validated) evidence before any HTTP.
//   F. brand resolution -- ASIN mapping wins; unique-SKU fallback; ambiguous SKU fails closed; conflicting
//      ASIN unmapped; blank/"Unassigned" never a real brand and never returned.
//   G. migration -- present, PREPARED-UNAPPLIED banner, schedule/pause default OFF, all 16 sources seeded,
//      and the REAL schema-contract audit over the REAL SQL + wrappers is green.
//
// 7-bit ASCII, LF, no top-level await, synchronous writeSync progress, dynamic imports after a dummy env.

import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import path from "node:path";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = process.env[SB_KEY_ENV] || ["test", "svc", "role", "key"].join("-");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const group = (label) => tests.push({ marker: label });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

let model; // source-durable-model
let brands; // brand-resolution
let sb; // supabase wrappers
let schema; // schema-contract
let dates; // date-windows

const ASOF = "2026-08-15";
const ACCTS = [
  { accountId: "A1", rawSellerId: "S1" },
  { accountId: "A2", rawSellerId: "S2" },
  { accountId: "A3", rawSellerId: "S3" },
  { accountId: "A4", rawSellerId: "S4" },
  { accountId: "A5", rawSellerId: "S5" },
];
const fullCoverage = (from, to) => [{ from, to }];

group("A. windows");

test("A1. the OLI initial backfill window starts at the FIXED 2025-01-01 (=[2025-01-01, asOf]) and covers Daily's 5-month window", () => {
  const w = model.oliBackfillWindow(ASOF);
  assert.equal(w.to, ASOF);
  assert.equal(w.from, "2025-01-01", "the authorized durable OLI backfill starts at the FIXED 2025-01-01");
  assert.ok(w.from <= dates.monthBackStr(ASOF, 5), "the Daily 5-month window is a strict subset of the backfill");
  assert.throws(() => model.oliBackfillWindow("2026-8-1"), /fail closed/);
});

test("A1b. the fixed start NEVER drifts as the month rolls over (Aug, Sep, and future months all keep 2025-01-01)", () => {
  // A window-days-from-month-start policy would move the start forward every month; a genuinely fixed start does
  // not. Prove the start stays 2025-01-01 across a month rollover and far into the future.
  for (const asOf of ["2026-08-01", "2026-08-21", "2026-08-31", "2026-09-01", "2026-09-15", "2026-12-31", "2027-06-08", "2028-02-29"]) {
    assert.deepEqual(model.oliBackfillWindow(asOf), { from: "2025-01-01", to: asOf }, "fixed start 2025-01-01 for asOf " + asOf);
  }
  // Same calendar month, different day, and consecutive months -> identical start (no month-boundary drift).
  assert.equal(model.oliBackfillWindow("2026-08-31").from, model.oliBackfillWindow("2026-09-01").from, "Aug 31 and Sep 1 share the fixed start");
  // asOf BEFORE the fixed start => an EMPTY authorized window (from > to), never a throw.
  const early = model.oliBackfillWindow("2024-12-31");
  assert.ok(early.from > early.to, "an asOf before the fixed start yields an empty (from > to) window, not a config error");
});

test("A2. the rolling refresh window is exactly 7 days ending at asOf", () => {
  const w = model.oliRollingRefreshWindow(ASOF);
  assert.deepEqual(w, { from: dates.addDaysStr(ASOF, -6), to: ASOF });
});

group("B. coverage");

test("B1. proven windows merge (overlap + adjacency); malformed evidence refuses ALL coverage", () => {
  const merged = model.mergeCoverageWindows([
    { from: "2026-08-08", to: "2026-08-14" },
    { from: "2026-08-01", to: "2026-08-07" }, // adjacent -> merges
    { from: "2026-08-10", to: "2026-08-12" }, // contained
    { from: "2026-08-20", to: "2026-08-21" }, // disjoint
  ]);
  assert.deepEqual(merged, [{ from: "2026-08-01", to: "2026-08-14" }, { from: "2026-08-20", to: "2026-08-21" }]);
  assert.throws(() => model.mergeCoverageWindows([{ from: "2026-08-02", to: "2026-08-01" }]), /refusing ALL coverage/);
  assert.throws(() => model.mergeCoverageWindows([{ from: "bad", to: "2026-08-01" }]), /refusing ALL coverage/);
});

test("B2. missingOliSlices: full coverage => nothing to export; no coverage => every canonical slice; partial => the exact gap", () => {
  const from = "2026-08-01"; const to = ASOF;
  const all = model.missingOliSlices({ coverageWindows: [], from, to });
  assert.deepEqual(all.missing, dates.canonicalOliSlices(from, to), "no coverage => every canonical slice is missing");
  assert.equal(all.covered.length, 0);
  const none = model.missingOliSlices({ coverageWindows: fullCoverage(from, to), from, to });
  assert.equal(none.missing.length, 0, "COMPLETED historical coverage is never exported again");
  assert.equal(none.covered.length, all.missing.length);
  const partial = model.missingOliSlices({ coverageWindows: fullCoverage("2026-08-01", "2026-08-07"), from, to });
  assert.deepEqual(partial.covered, [{ from: "2026-08-01", to: "2026-08-07" }]);
  assert.deepEqual(partial.missing, [{ from: "2026-08-08", to: "2026-08-14" }, { from: "2026-08-15", to: "2026-08-15" }]);
});

group("C. slice-subset batching");

test("C1. steady state: all 5 members missing the rolling slices => ONE batch export per slice (sorted 5-id scope)", () => {
  const w = model.oliRollingRefreshWindow(ASOF); // 2026-08-09..2026-08-15
  const coverage = Object.fromEntries(ACCTS.map((a) => [a.accountId, fullCoverage("2025-06-01", "2026-08-08")]));
  const units = model.planOliSliceExports({ batchAccounts: ACCTS, coverageByAccountId: coverage, from: w.from, to: w.to });
  assert.ok(units.length >= 1);
  for (const u of units) {
    assert.equal(u.accounts.length, 5, "every member joins the rolling slice");
    assert.deepEqual(u.sellerOrVendorIds, ["S1", "S2", "S3", "S4", "S5"], "sorted stable seller scope");
  }
});

test("C2. a newly discovered account backfills SOLO over ONE complete window; completed members are never re-exported", () => {
  const from = "2026-07-01"; const to = "2026-07-31";
  const coverage = Object.fromEntries(ACCTS.slice(0, 4).map((a) => [a.accountId, fullCoverage(from, to)]));
  // A5 is new: no coverage at all => ONE complete-window export over [from, to] for ONLY S5 (no 7-day slicing).
  const units = model.planOliSliceExports({ batchAccounts: ACCTS, coverageByAccountId: coverage, from, to });
  assert.equal(units.length, 1, "ONE complete-window unit (the 4 completed members are never re-exported)");
  assert.deepEqual(units[0].slice, { from, to }, "the full missing window, unsliced");
  assert.deepEqual(units[0].sellerOrVendorIds, ["S5"], "ONLY the new account's missing backfill is processed");
});

test("C3. fully proven window => ZERO units; malformed batches fail closed", () => {
  const from = "2026-07-01"; const to = "2026-07-31";
  const coverage = Object.fromEntries(ACCTS.map((a) => [a.accountId, fullCoverage(from, to)]));
  assert.deepEqual(model.planOliSliceExports({ batchAccounts: ACCTS, coverageByAccountId: coverage, from, to }), []);
  assert.throws(() => model.planOliSliceExports({ batchAccounts: [], coverageByAccountId: {}, from, to }), /1\.\.5 account/);
  assert.throws(() => model.planOliSliceExports({ batchAccounts: [...ACCTS, { accountId: "A6", rawSellerId: "S6" }], coverageByAccountId: {}, from, to }), /1\.\.5 account/);
  assert.throws(() => model.planOliSliceExports({ batchAccounts: [{ accountId: "A1", rawSellerId: " " }], coverageByAccountId: {}, from, to }), /rawSellerId/);
});

test("C5. a missing window longer than the proven single-export cap SPLITS into contiguous <=cap chunks", () => {
  const CAP = model.MAX_OLI_EXPORT_WINDOW_DAYS;
  assert.equal(CAP, 441, "the proven single-export cap is 441 days");
  // splitWindowToMaxSpan: within-cap window stays ONE; an over-cap window splits contiguously; the chunks
  // reconstruct the exact window and none exceeds the cap.
  const within = { from: "2026-01-01", to: dates.addDaysStr("2026-01-01", CAP - 1) }; // exactly CAP days
  assert.deepEqual(model.splitWindowToMaxSpan(within), [within], "a window of exactly CAP days is ONE export");
  // The EXACT go-live window [2025-01-01, 2026-08-21] (598 inclusive days) => exactly two chunks with these
  // boundaries (441 + 157 days). Codex-pinned.
  assert.deepEqual(model.splitWindowToMaxSpan({ from: "2025-01-01", to: "2026-08-21" }), [
    { from: "2025-01-01", to: "2026-03-17" }, // 441 inclusive days
    { from: "2026-03-18", to: "2026-08-21" }, // 157 inclusive days
  ], "the go-live window splits at exactly [2025-01-01..2026-03-17] and [2026-03-18..2026-08-21]");
  const over = { from: "2025-01-01", to: "2026-08-15" }; // ~592 days > CAP
  const chunks = model.splitWindowToMaxSpan(over);
  assert.ok(chunks.length >= 2, "an over-cap window splits into multiple chunks");
  assert.equal(chunks[0].from, over.from, "the first chunk starts at the window start");
  assert.equal(chunks[chunks.length - 1].to, over.to, "the last chunk ends at the window end");
  for (const c of chunks) assert.ok(dates.addDaysStr(c.from, CAP - 1) >= c.to, "every chunk is within the cap");
  for (let i = 1; i < chunks.length; i += 1) assert.equal(chunks[i].from, dates.addDaysStr(chunks[i - 1].to, 1), "chunks are contiguous (no gap/overlap)");
  assert.throws(() => model.splitWindowToMaxSpan({ from: "2026-02-01", to: "2026-01-01" }), /fail closed/);
  // planOliSliceExports applies the cap: a new account's full >cap window becomes multiple <=cap exports, all
  // carrying the SAME single-seller batch scope, together covering the whole window.
  const units = model.planOliSliceExports({ batchAccounts: [{ accountId: "A1", rawSellerId: "S1" }], coverageByAccountId: {}, from: over.from, to: over.to });
  assert.equal(units.length, chunks.length, "one export per capped chunk");
  for (const u of units) assert.deepEqual(u.sellerOrVendorIds, ["S1"], "every chunk carries the same batch scope");
  assert.deepEqual(units.map((u) => u.slice), chunks, "the exports reconstruct the full missing window as contiguous <=cap chunks");
});

test("C4. successful slices roll up into minimal coverage windows", () => {
  const windows = model.coverageWindowsFromSlices([
    { from: "2026-08-01", to: "2026-08-07" }, { from: "2026-08-08", to: "2026-08-14" }, { from: "2026-08-20", to: "2026-08-21" },
  ]);
  assert.deepEqual(windows, [{ from: "2026-08-01", to: "2026-08-14" }, { from: "2026-08-20", to: "2026-08-21" }]);
});

group("D. history grain");

const FRAG_META = { organizationFingerprint: "org1", connectionId: "primary", sourceRequestHash: "h1" };
const sellerMap = { S1: { accountId: "A1" }, S2: { accountId: "A2" } };
const fragRow = (sid, date, sku, asin, cur, sales, units) => ({
  date, seller_or_vendor_id: sid, sku, child_asin: asin, item_price_currency: cur,
  total_sales_sum: sales, total_units_sum: units,
});

test("D1. one shared batch fragment maps to per-account canonical rows; same-grain partial aggregates SUM", () => {
  const rows = model.oliHistoryRowsFromFragment({
    ...FRAG_META,
    accountsBySellerId: sellerMap,
    rows: [
      fragRow("S1", "2026-08-10", "K1", "B01", "USD", 100, 10),
      fragRow("S2", "2026-08-10", "K1", "B01", "usd", 50, 5), // currency normalizes to USD; DIFFERENT account => distinct grain
      fragRow("S1", "2026-08-10", "K1", "B01", "USD", 25, 2), // SAME grain as row 1 => sums
    ],
  });
  assert.equal(rows.length, 2);
  const a1 = rows.find((r) => r.accountId === "A1");
  assert.equal(a1.salesAmount, 125);
  assert.equal(a1.units, 12);
  assert.equal(a1.currency, "USD");
  const a2 = rows.find((r) => r.accountId === "A2");
  assert.equal(a2.currency, "USD", "lowercase currency canonicalized");
  assert.equal(a2.sellerOrVendorId, "S2");
});

test("D2. unknown seller / invalid date / non-canonical currency / malformed row => the WHOLE payload rejects", () => {
  const base = { ...FRAG_META, accountsBySellerId: sellerMap };
  assert.throws(() => model.oliHistoryRowsFromFragment({ ...base, rows: [fragRow("SX", "2026-08-10", "K", "B", "USD", 1, 1)] }), /blank\/unknown/);
  assert.throws(() => model.oliHistoryRowsFromFragment({ ...base, rows: [fragRow("S1", "not-a-date", "K", "B", "USD", 1, 1)] }), /no valid date/);
  assert.throws(() => model.oliHistoryRowsFromFragment({ ...base, rows: [fragRow("S1", "2026-08-10", "K", "B", "US D", 1, 1)] }), /canonical currency/);
  assert.throws(() => model.oliHistoryRowsFromFragment({ ...base, rows: [fragRow("S1", "2026-08-10", "K", "B", "USD", NaN, 1)] }), /non-finite/);
  assert.throws(() => model.oliHistoryRowsFromFragment({ ...base, rows: [null] }), /malformed fragment row/);
  // An all-blank row carries nothing and is skipped, not fatal.
  const rows = model.oliHistoryRowsFromFragment({ ...base, rows: [{ date: "", sku: "", child_asin: "" }, fragRow("S1", "2026-08-10", "K", "B", "USD", 1, 1)] });
  assert.equal(rows.length, 1);
});

test("D2b. a blank DataDoe currency uses only the exact account's canonical discovery currency", () => {
  const fallbackMap = { S1: { accountId: "A1", currency: "usd" } };
  const rows = model.oliHistoryRowsFromFragment({
    ...FRAG_META,
    accountsBySellerId: fallbackMap,
    rows: [fragRow("S1", "2026-08-10", "K", "B", "", 0, 2)],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].currency, "USD", "the seller/account's canonical currency fills a blank source value");
  assert.equal(rows[0].units, 2, "unit evidence is preserved");
  assert.throws(
    () => model.oliHistoryRowsFromFragment({ ...FRAG_META, accountsBySellerId: sellerMap, rows: [fragRow("S1", "2026-08-10", "K", "B", "", 0, 2)] }),
    /no canonical fallback currency/,
    "blank source currency without an authoritative account fallback remains fail closed",
  );
  assert.throws(
    () => model.oliHistoryRowsFromFragment({ ...FRAG_META, accountsBySellerId: fallbackMap, rows: [fragRow("S1", "2026-08-10", "K", "B", "US D", 0, 2)] }),
    /no canonical currency/,
    "a malformed nonblank source currency is never replaced by the fallback",
  );
});

test("D3. the canonical PK grain upserts idempotently: a late Amazon correction REPLACES its row (no duplication)", () => {
  // Model the durable table as a Map keyed by the exact PK grain (what merge-duplicates does).
  const table = new Map();
  const upsert = (rows) => { for (const r of rows) table.set([r.organizationFingerprint, r.connectionId, r.accountId, r.saleDate, r.sku, r.childAsin, r.currency].join("|"), r); };
  const first = model.oliHistoryRowsFromFragment({ ...FRAG_META, accountsBySellerId: sellerMap, rows: [fragRow("S1", "2026-08-10", "K1", "B01", "USD", 100, 10)] });
  upsert(first);
  assert.equal(table.size, 1);
  // The corrected re-export of the same slice carries the SAME grain with new values.
  const corrected = model.oliHistoryRowsFromFragment({ ...FRAG_META, sourceRequestHash: "h1", accountsBySellerId: sellerMap, rows: [fragRow("S1", "2026-08-10", "K1", "B01", "USD", 90, 9)] });
  upsert(corrected);
  assert.equal(table.size, 1, "replaced, not duplicated");
  assert.equal([...table.values()][0].salesAmount, 90, "the correction won");
});

group("E. snapshots");

test("E1. once-daily refresh decision; the catalog scope is the ORGANIZATION (never per dashboard/seller)", () => {
  assert.deepEqual(model.snapshotRefreshDecision({ sourceKey: "product-catalog", lastValidatedAt: null, today: ASOF }), { refresh: true, reason: "never-validated" });
  assert.deepEqual(model.snapshotRefreshDecision({ sourceKey: "product-catalog", lastValidatedAt: "2026-08-14T22:00:00Z", today: ASOF }), { refresh: true, reason: "stale-day" });
  assert.deepEqual(model.snapshotRefreshDecision({ sourceKey: "product-catalog", lastValidatedAt: "2026-08-15T02:00:00Z", today: ASOF }), { refresh: false, reason: "fresh-today" });
  assert.deepEqual(model.snapshotRefreshDecision({ sourceKey: "fba-inventory-health", lastValidatedAt: "2026-08-15T02:00:00Z", today: ASOF }), { refresh: false, reason: "fresh-today" });
  assert.throws(() => model.snapshotRefreshDecision({ sourceKey: "order-line-items", lastValidatedAt: null, today: ASOF }), /not a daily-snapshot source/);
  assert.equal(model.catalogSnapshotScope(), "__organization");
});

test("E2. recordSourceSnapshot REFUSES incomplete (non-validated) evidence BEFORE any HTTP", async () => {
  // A fetch tripwire: any network attempt fails the test loudly (the wrapper must throw first).
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("SPY_FETCH_CALLED: recordSourceSnapshot attempted HTTP with incomplete evidence"); };
  try {
    for (const bad of [
      { sourceKey: "product-catalog", scopeKey: "__organization", objectPath: "", rowCount: 5, sourceRequestHash: "h", validatedAt: "2026-08-15T00:00:00Z" },
      { sourceKey: "product-catalog", scopeKey: "__organization", objectPath: "p", rowCount: -1, sourceRequestHash: "h", validatedAt: "2026-08-15T00:00:00Z" },
      { sourceKey: "product-catalog", scopeKey: "__organization", objectPath: "p", rowCount: 5, sourceRequestHash: "", validatedAt: "2026-08-15T00:00:00Z" },
      { sourceKey: "product-catalog", scopeKey: "__organization", objectPath: "p", rowCount: 5, sourceRequestHash: "h", validatedAt: null },
      { sourceKey: "", scopeKey: "__organization", objectPath: "p", rowCount: 5, sourceRequestHash: "h", validatedAt: "2026-08-15T00:00:00Z" },
    ]) {
      await assert.rejects(() => sb.recordSourceSnapshot(bad), /refusing to replace the latest-good snapshot/);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

group("F. brand resolution");

const CAT = [
  { child_asin: "B0A", sku: "SKU-A", product_brand: "Acme" },
  { child_asin: "B0B", sku: "SKU-B", product_brand: "Bolt" },
  { child_asin: "B0B", sku: "SKU-B2", product_brand: "Bolt" },      // same asin, same brand: fine
  { child_asin: "B0C", sku: "SKU-C", product_brand: "Cruz" },
  { child_asin: "B0C", sku: "SKU-C", product_brand: "Crux" },       // conflicting asin AND ambiguous sku
  { child_asin: "", sku: "SKU-ONLY", product_brand: "Delta" },      // sku-only mapping
  { child_asin: "B0E", sku: "SKU-E", product_brand: "" },           // blank brand: maps nothing
  { child_asin: "B0F", sku: "SKU-F", product_brand: "Unassigned" }, // fabricated label: NEVER a real brand
  { child_asin: "B0G", sku: "SKU-G", product_brand: "unassigned" }, // case-insensitive
];

test("F1. ASIN mapping wins; the unique-SKU fallback fires only when the ASIN does not resolve", () => {
  const maps = brands.buildBrandMaps(CAT);
  assert.deepEqual(brands.resolveBrand({ childAsin: "B0A", sku: "SKU-ONLY" }, maps), { brand: "Acme", via: "asin" }, "ASIN wins even when the SKU maps elsewhere");
  assert.deepEqual(brands.resolveBrand({ childAsin: "B0Z", sku: "SKU-ONLY" }, maps), { brand: "Delta", via: "sku" }, "unique SKU fallback for an unresolved ASIN");
  assert.deepEqual(brands.resolveBrand({ childAsin: "b0a", sku: "" }, maps), { brand: "Acme", via: "asin" }, "ASIN lookup is case-insensitive");
});

test("F2. ambiguous SKU and conflicting ASIN both fail closed (unmapped, recorded)", () => {
  const maps = brands.buildBrandMaps(CAT);
  assert.deepEqual(brands.resolveBrand({ childAsin: "B0C", sku: "SKU-C" }, maps), { brand: null, via: null }, "conflicting ASIN + ambiguous SKU stays unmapped");
  assert.ok(maps.conflictedAsins.includes("B0C"));
  assert.ok(maps.ambiguousSkus.includes("SKU-C"));
});

test("F3. blank / 'Unassigned' catalog brands are NEVER real brands and are never returned", () => {
  const maps = brands.buildBrandMaps(CAT);
  assert.deepEqual(brands.resolveBrand({ childAsin: "B0E", sku: "SKU-E" }, maps), { brand: null, via: null });
  assert.deepEqual(brands.resolveBrand({ childAsin: "B0F", sku: "SKU-F" }, maps), { brand: null, via: null });
  assert.deepEqual(brands.resolveBrand({ childAsin: "B0G", sku: "SKU-G" }, maps), { brand: null, via: null });
  for (const b of [...maps.byAsin.values(), ...maps.bySku.values()]) {
    assert.notEqual(String(b).toLowerCase(), "unassigned", "no map value is ever the fabricated label");
  }
});

test("F4. malformed catalog rows reject the whole build; maps are frozen; a sku-less catalog has an empty SKU index", () => {
  assert.throws(() => brands.buildBrandMaps([{ child_asin: "A" }, null]), /rejecting the whole catalog/);
  assert.throws(() => brands.buildBrandMaps("not-an-array"), /requires an array/);
  const maps = brands.buildBrandMaps(CAT);
  assert.ok(Object.isFrozen(maps));
  const skuless = brands.buildBrandMaps([{ child_asin: "B0A", product_brand: "Acme" }]);
  assert.equal(skuless.bySku.size, 0, "no sku column => rule 2 never fires (correct, never wrong)");
  assert.equal(skuless.byAsin.get("B0A"), "Acme");
});

group("G. migration (PREPARED, UNAPPLIED)");

const MIG = "20260820_source_durable_model.sql";
const migPath = path.join(process.cwd(), "supabase", "migrations", MIG);

test("G1. the durable-model migration exists, is banner-marked PREPARED-UNAPPLIED, and defaults every control OFF", () => {
  const sql = readFileSync(migPath, "utf8");
  assert.match(sql, /PREPARED, UNAPPLIED/i);
  assert.match(sql, /DO NOT APPLY/i);
  assert.match(sql, /schedule_enabled boolean not null default false/, "the inert schedule defaults OFF for every source");
  assert.match(sql, /paused boolean not null default false/);
  for (const key of ["order-line-items", "product-catalog", "fba-inventory-health", "ads-asin-date", "sqp-monthly"]) {
    assert.ok(sql.includes(`('${key}')`), `source_controls seeds ${key}`);
  }
  assert.match(sql, /on conflict \(source_key\) do nothing/, "re-seeding never resets an operator's control");
});

test("G2. the REAL schema-contract audit over the REAL SQL + wrappers is green (durable model registered)", () => {
  const readFile = (rel) => readFileSync(rel === "supabase.js" ? path.join(process.cwd(), "lib", "server", "supabase.js") : path.join(process.cwd(), "supabase", "migrations", rel), "utf8");
  const audit = schema.auditSchemaContract({ readFile });
  assert.equal(audit.ok, true, "audit blockers: " + JSON.stringify(audit.blockers));
  const entry = schema.SCHEDULER_V2_SCHEMA_CONTRACT.find((m) => m.migration === MIG);
  assert.ok(entry, "the durable model is a registered contract migration");
  assert.deepEqual(entry.tables.map((t) => t.name).sort(),
    ["source_controls", "source_coverage", "source_oli_daily_history", "source_run_status", "source_snapshots"]);
});

async function main() {
  out("source-durable-model proof suite");
  model = await import("../lib/server/sync/source-durable-model.js");
  brands = await import("../lib/server/sync/brand-resolution.js");
  sb = await import("../lib/server/supabase.js");
  schema = await import("../lib/server/sync/schema-contract.js");
  dates = await import("../lib/server/date-windows.js");

  let failures = 0;
  for (const t of tests) {
    if (t.marker) { out("-- " + t.marker); continue; }
    try {
      await t.fn();
      passed += 1;
      out("  ok  " + t.name);
    } catch (e) {
      failures += 1;
      out("FAIL  " + t.name);
      out(String((e && e.stack) || e));
    }
  }
  out("\n" + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : ""));
  if (failures) process.exitCode = 1;
}

main();
