// Scheduler v2 Phase 1d -- PURE report-calculation cores (no network, no DB).
//
// This is a transport-free leaf: its ONLY import is the dependency-free lib/server/currency.js
// (no DataDoe transport, no Supabase) -- so the shared canonical-currency helpers keep the TACoS
// fold byte-identical to buildPpcPerformance() without pulling any forbidden module into this graph.
// Report calculations are extracted here VERBATIM from api/datadoe.js so that:
//   1. the existing browser/API route keeps ONE implementation (it now imports these),
//      guaranteeing byte-identical output -- proven by scripts/report-source-contracts and
//      the Phase 1d parity tests; and
//   2. the Scheduler v2 report-derivation layer can reuse the exact same folds while it is
//      structurally impossible for a derivation adapter to reach a DataDoe export function.
//
// Every function is pure: given the same rows it returns the same result, mutating only
// its own local accumulators. Currency is NEVER converted (each fold keys by currency or
// records a conflict); FX lives only in the display layer.

import { canonicalCurrency, adsCurrencyEvidence } from "../currency.js";
// The ONE canonical brand-key (trim + collapse interior whitespace + lowercase; punctuation preserved) --
// brand-membership.js is a zero-import pure leaf, so this stays a transport-free graph. Every brand MATCH in the
// daily folds goes through it so a case/whitespace variant selects the same brand while punctuation-distinct
// brands stay separate.
import { brandKey } from "./brand-membership.js";

// Numeric coercion identical to lib/server/datadoe.js `num` (Number(v) || 0), kept local so
// this leaf pulls in no transport module.
export const num = (v) => Number(v) || 0;

// Dashboard / brand-sales: join catalog brand onto the compact date/ASIN Order-Line-Items export and fold to
// date/brand totals under the AUTHORITATIVE OLI order-value policy (oli-order-rules.js). The ambiguous legacy
// inference `sales === 0 && units > 0 => unpriced_units` is REMOVED -- it conflated three distinct cases. Instead:
//   - order value PRESENT and > 0            -> contributes Total Sales AND Units Sold;
//   - order value PRESENT and == 0 (a real   -> contributes ZERO sales AND ZERO units (present-zero: a shipped
//     zero-priced promotional/replacement/       promotional/replacement/free unit), never a warning;
//     free unit)
//   - order value genuinely MISSING (null/    -> is NEVER coerced to 0; its units NEVER enter Units Sold; it is
//     blank)                                     surfaced ONLY as the typed `missing_order_value_units` evidence.
// Cancelled rows never reach this fold (the durable rollup excludes them). total_orders stays null (a compact ASIN
// export cannot dedupe order ids across ASINs).
export function orderSalesByBrand(rows, catalogRows) {
  const brandByAsin = new Map();
  for (const catalogRow of catalogRows) {
    const asin = String(catalogRow.child_asin || "").trim();
    const brand = String(catalogRow.product_brand || "").trim();
    if (asin && brand) brandByAsin.set(asin, brand);
  }

  const totals = new Map();
  for (const row of rows) {
    const productBrand = brandByAsin.get(String(row.child_asin || "").trim()) || "Unassigned";
    const currency = row.item_price_currency || row.currency || null;
    const key = [
      row.date,
      row.seller_or_vendor_id,
      row.seller_or_vendor_name,
      row.marketplace_country_code,
      currency,
      productBrand,
    ].join("|");
    const current = totals.get(key) || {
      date: row.date,
      seller_or_vendor_id: row.seller_or_vendor_id,
      seller_or_vendor_name: row.seller_or_vendor_name,
      marketplace_country_code: row.marketplace_country_code,
      currency,
      product_brand: productBrand,
      total_sales: 0,
      total_units_sold: 0,
      missing_order_value_units: 0,
      total_orders: null,
    };
    // A value is PRESENT only when it is neither null/undefined nor a blank string -- a MISSING value is NEVER
    // silently coerced to 0 first (mirrors oli-order-rules.orderValuePresent).
    const rawValue = row.total_sales_sum ?? row.item_price_value;
    const valuePresent = rawValue != null && String(rawValue).trim() !== "";
    const units = num(row.total_units_sold_sum ?? row.quantity);
    if (!valuePresent) {
      // Genuinely missing order value: typed evidence ONLY; never fabricate sales, never count units.
      current.missing_order_value_units += units;
    } else {
      const sales = num(rawValue);
      current.total_sales += sales;
      // Only a strictly-positive value's units are business Units Sold; a present-zero unit contributes zero.
      if (sales > 0) current.total_units_sold += units;
    }
    totals.set(key, current);
  }
  return [...totals.values()];
}

// Distinct product-brand names from catalog rows, locale-sorted.
export function catalogBrandNames(rows) {
  return [...new Set(
    rows
      .map((row) => String(row.product_brand || "").trim())
      .filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));
}

// ---- Content Changes cores (verbatim from api/datadoe.js; pure) ----

export function parseJsonValue(value) {
  if (!value || typeof value !== "string") return value;
  try { return JSON.parse(value); } catch (e) { return value; }
}

export function compactJsonPreview(value, maxLength = 420) {
  const parsed = parseJsonValue(value);
  const text = typeof parsed === "string" ? parsed : JSON.stringify(parsed || {});
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

// DataDoe passes through Amazon notification payloads whose nesting changes over time.
// Find ASIN values by semantic key names as well as any exact ASIN pattern in strings.
export function notificationAsins(value) {
  const found = new Set();
  const visit = (node, key = "") => {
    if (node === null || node === undefined) return;
    if (typeof node === "string") {
      const text = node.trim();
      if (/asin/i.test(key) && /^[A-Z0-9]{10}$/i.test(text)) found.add(text.toUpperCase());
      const matches = text.match(/\b[A-Z0-9]{10}\b/gi) || [];
      matches.forEach((match) => found.add(match.toUpperCase()));
      return;
    }
    if (Array.isArray(node)) { node.forEach((item) => visit(item, key)); return; }
    if (typeof node === "object") Object.entries(node).forEach(([childKey, child]) => visit(child, childKey));
  };
  visit(parseJsonValue(value));
  return [...found].sort();
}

// Assemble the COMPLETE Content Changes payload exactly as the api/datadoe.js route does
// ({ accountId, events, catalogBrands, retrievedAt, unassignedEvents }). `retrievedAt` is a
// caller-supplied value (the route passes a request timestamp; the scheduler passes the saved
// source fetch time) so this stays PURE -- no Date.now() here. `unassignedEvents` is the COUNT
// of events whose ASINs did not map to a catalog brand (the frontend reads this number).
export function contentChangesPayload({ accountId, notificationRows, catalogRows, retrievedAt }) {
  const events = compactContentChangeEvents(notificationRows, catalogRows);
  return {
    accountId,
    events,
    catalogBrands: catalogBrandNames(catalogRows),
    retrievedAt,
    unassignedEvents: events.filter((event) => !event.brands.length).length,
  };
}

export function compactContentChangeEvents(rows, catalogRows) {
  const brandByAsin = new Map();
  for (const catalogRow of catalogRows) {
    const asin = String(catalogRow.child_asin || "").trim().toUpperCase();
    const brand = String(catalogRow.product_brand || "").trim();
    if (asin && brand && !brandByAsin.has(asin)) brandByAsin.set(asin, brand);
  }
  return rows.map((row) => {
    const asins = notificationAsins(row.payload);
    const brands = [...new Set(asins.map((asin) => brandByAsin.get(asin)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    return {
      eventTime: row.event_time || null,
      notificationId: String(row.sp_api_notification_id || "").trim() || null,
      notificationType: String(row.sp_api_notification_type || "BRANDED_ITEM_CONTENT_CHANGE").trim(),
      asins,
      brands,
      metadataPreview: compactJsonPreview(row.notification_metadata),
      payloadPreview: compactJsonPreview(row.payload),
    };
  }).sort((a, b) => String(b.eventTime || "").localeCompare(String(a.eventTime || "")));
}

// ---- Daily Reporting cores (verbatim copies of the api/datadoe.js folds + the scheduler's
//      superset roll-up; pure). The route keeps and exports its own copies, and the Phase 1d
//      parity harness runs BOTH implementations side by side (see the derivation test). ----

// Verbatim copy of api/datadoe.js normalizeDailySalesRows.
export function normalizeDailySalesRows(rows) {
  return rows.map((row) => ({
    ...row,
    // Carry the Order Line Items currency so downstream keeps each currency isolated.
    currency: row.currency ?? row.item_price_currency ?? null,
    total_sales: num(row.total_sales_sum ?? row.item_price_value),
    total_units: num(row.total_units_sum ?? row.quantity),
  }));
}

// Verbatim copy of api/datadoe.js normalizeAdRows. Blocker 4: the Ads currency is normalized from
// ad_campaign_budget_currency into `currency` (canonical UPPERCASE, or null when blank/unprovable) so
// the currency-keyed mergeSalesAndAds only merges an Ads row into the OLI sales row of the SAME currency.
// A currency-less Ads row (currency === null) never merges into a currency'd sales row (fail-closed). An
// already-normalized `currency` (the Supabase-saved / planner-loaded ad rows) is preserved.
export function normalizeAdRows(rows) {
  return rows.map((row) => ({
    ...row,
    currency: (row.currency != null && String(row.currency).trim() !== "")
      ? String(row.currency).trim().toUpperCase()
      : (String(row.ad_campaign_budget_currency || "").trim().toUpperCase() || null),
    ad_sales: num(row.ad_sales_sum ?? row.ad_sales),
    ad_spend: num(row.ad_spend_sum ?? row.ad_spend),
    ad_clicks: num(row.ad_clicks_sum ?? row.ad_clicks),
  }));
}

// The catalog ASIN -> CANONICAL brand-key map (first catalog brand per ASIN wins, matching the historical route
// behavior). Keys are UPPERCASED ASINs; values are brandKey() forms so matching is canonical (case/whitespace
// variants same brand, punctuation distinct). An ASIN with no catalog brand is ABSENT (never attributed).
function catalogBrandKeyByAsin(catalogRows) {
  const brandByAsin = new Map();
  for (const catalogRow of catalogRows) {
    const asin = String(catalogRow.child_asin || "").trim().toUpperCase();
    const key = brandKey(catalogRow.product_brand);
    if (asin && key && !brandByAsin.has(asin)) brandByAsin.set(asin, key);
  }
  return brandByAsin;
}

// api/datadoe.js dailyRowsForBrand, with CANONICAL brand matching (brandKey: case/whitespace variants of the
// selected brand match; punctuation-distinct brands never merge). An OLI row is attributed ONLY through a proven
// catalog child_asin -> product_brand mapping -- an unmapped ASIN never contributes to a named brand.
export function dailyRowsForBrand(rows, catalogRows, brand) {
  const brandByAsin = catalogBrandKeyByAsin(catalogRows);
  const wantKey = brandKey(brand);
  const totals = new Map();
  for (const row of rows) {
    if (!wantKey || brandByAsin.get(String(row.child_asin || "").trim().toUpperCase()) !== wantKey) continue;
    // Currency isolation: a (seller, date) pair is folded per currency, never across.
    const currency = row.currency ?? row.item_price_currency ?? null;
    const key = `${row.seller_or_vendor_id}|${row.date}|${currency ?? ""}`;
    const current = totals.get(key) || {
      date: row.date,
      seller_or_vendor_id: row.seller_or_vendor_id,
      currency,
      total_sales: 0,
      total_units: 0,
      total_units_sold: 0,
    };
    current.total_sales += num(row.total_sales_sum ?? row.item_price_value);
    current.total_units += num(row.total_units_sum ?? row.quantity);
    current.total_units_sold = current.total_units;
    totals.set(key, current);
  }
  return [...totals.values()];
}

// BRAND-scoped ASIN Ads: keep ONLY the raw ASIN ad rows whose child_asin maps -- through the PROVEN catalog
// child_asin -> product_brand join (canonical brandKey matching, first catalog brand per ASIN wins, the SAME map
// the sales fold uses) -- to the selected brand. An ad row with an unmapped ASIN, a blank ASIN, or a
// different-brand ASIN is EXCLUDED (never attributed to the brand, exactly like the sales side). Pure.
export function filterAdRowsToBrand(adRows, catalogRows, brand) {
  const brandByAsin = catalogBrandKeyByAsin(catalogRows);
  const wantKey = brandKey(brand);
  if (!wantKey) return [];
  return (Array.isArray(adRows) ? adRows : []).filter((row) => {
    const asin = String((row && row.child_asin) || "").trim().toUpperCase();
    return !!asin && brandByAsin.get(asin) === wantKey;
  });
}

// Verbatim copy of api/datadoe.js mergeSalesAndAds. Operates on a FRESH array (never mutates the
// caller's rows) but produces byte-identical output to the route (which mutates + returns).
export function mergeSalesAndAds(salesRows, adRows) {
  const out = salesRows.slice();
  const firstByKey = new Map();
  for (const r of out) {
    // Currency isolation: ad rows only merge into the sales row of the SAME currency.
    const key = `${r.seller_or_vendor_id}|${r.date}|${r.currency ?? ""}`;
    if (!firstByKey.has(key)) firstByKey.set(key, r);
  }
  for (const a of adRows) {
    const key = `${a.seller_or_vendor_id}|${a.date}|${a.currency ?? ""}`;
    const target = firstByKey.get(key);
    if (target) {
      target.ad_sales = num(target.ad_sales) + num(a.ad_sales);
      target.ad_spend = num(target.ad_spend) + num(a.ad_spend);
      target.ad_clicks = num(target.ad_clicks) + num(a.ad_clicks);
    } else {
      const row = {
        date: a.date,
        seller_or_vendor_id: a.seller_or_vendor_id,
        currency: a.currency,
        total_sales: 0,
        total_units: 0,
        total_units_sold: 0,
        ad_sales: num(a.ad_sales),
        ad_spend: num(a.ad_spend),
        ad_clicks: num(a.ad_clicks),
      };
      out.push(row);
      firstByKey.set(key, row);
    }
  }
  return out;
}

// Scheduler-only roll-up: the browser's compact all-brand export groups the SAME Order Line Items
// source by [date, seller_or_vendor_id] with the SAME aggregations, so it is a strict roll-up of the
// canonical ASIN/day superset (grouped by [date, seller_or_vendor_id, sku, child_asin, item_price_currency]).
// Summing the superset over sku + child_asin per (date, seller, currency) reproduces the exact compact
// export rows ({date, seller_or_vendor_id, total_sales_sum, total_units_sum}) in first-seen order. This is
// the ONLY new fold (there is no standalone production function for it: the route uses the server-side
// grouped export). It is proven equal to the production compact calculation in the parity harness.
export function rollupSupersetToDaily(supersetRows) {
  const byKey = new Map();
  for (const row of supersetRows) {
    // Currency isolation: sum the superset per (date, seller, currency) -- never across currencies.
    const currency = row.currency ?? row.item_price_currency ?? null;
    const key = `${row.date}|${row.seller_or_vendor_id}|${currency ?? ""}`;
    const current = byKey.get(key) || {
      date: row.date,
      seller_or_vendor_id: row.seller_or_vendor_id,
      currency,
      total_sales_sum: 0,
      total_units_sum: 0,
    };
    current.total_sales_sum += num(row.total_sales_sum ?? row.item_price_value);
    current.total_units_sum += num(row.total_units_sum ?? row.quantity);
    byKey.set(key, current);
  }
  return [...byKey.values()];
}

// Full Daily Reporting payload for ONE brand, derived PURELY from the saved ASIN/day superset,
// the saved catalog, and the injected saved Ads rows. Reproduces the api/datadoe.js `daily`
// handler exactly for BOTH modes:
//   brand === "ALL": sum the superset per (date, seller), normalize, set total_units_sold, then
//                    merge the (normalized) Ads rows -> { rows, brandFiltered:false }.
//   named brand:     join ASIN->brand via the catalog and fold to one row/day (NO ads, exactly
//                    like the route) -> { rows, brandFiltered:true }.
// Ads are REQUIRED for the ALL payload and injected by the caller (planner-loaded from the
// scheduled Ads rows); a missing/non-array adRows throws rather than silently understating.
export function dailyReportingPayload({ supersetRows, catalogRows, adRows, brand = "ALL", adsAvailability = null }) {
  if (brand && brand !== "ALL") {
    // Named brand: catalog ASIN->brand joined sales, folded to one row/day. When the caller supplies
    // BRAND-SCOPED ad rows (already filtered through the catalog mapping -- see filterAdRowsToBrand) they merge
    // exactly like the ALL path, with the explicit adsAvailability state attached. When NO adRows are supplied
    // (legacy callers, the scheduler's named-brand shadow derive) the payload keeps the historic no-ads shape
    // byte-for-byte, so existing parity is untouched.
    const brandRows = dailyRowsForBrand(supersetRows, catalogRows, brand);
    if (!Array.isArray(adRows)) return { rows: brandRows, brandFiltered: true };
    const payload = { rows: mergeSalesAndAds(brandRows, normalizeAdRows(adRows)), brandFiltered: true };
    if (adsAvailability) payload.adsAvailability = adsAvailability;
    return payload;
  }
  if (!Array.isArray(adRows)) {
    throw new Error("daily-reporting ALL derivation requires injected adRows (an array; [] when there is no ad activity).");
  }
  // SALES are computed identically regardless of Ads (parity preserved). `adRows` are ONLY the
  // proven-covered Ads rows; the merge adds ad fields to their (seller, day) sales rows, so an
  // uncovered date's sales row simply carries no ad fields. `adsAvailability` (when provided) is the
  // explicit coverage state the future frontend consumer reads to distinguish covered-genuine-zero
  // from uncovered-unavailable. It is payload metadata only -- never part of the snapshot identity.
  const rows = normalizeDailySalesRows(rollupSupersetToDaily(supersetRows));
  for (const r of rows) r.total_units_sold = r.total_units;
  const payload = { rows: mergeSalesAndAds(rows, normalizeAdRows(adRows)), brandFiltered: false };
  if (adsAvailability) payload.adsAvailability = adsAvailability;
  return payload;
}

// ---- SKU P&L cores. `skuPlFold` is the verbatim copy of api/datadoe.js foldSkuPlMonthlyRows;
//      `computeSkuPlRow`/`skuPlScopedTotals`/`cogsOverrideKey`/`latestCogsOverridePerUnit` are the
//      verbatim COGS-applier from src/App.jsx (a React module that cannot be imported offline, so
//      they are transcribed here and unit-tested against hand-computed expectations). ----

// Verbatim copy of api/datadoe.js foldSkuPlMonthlyRows (one row per currency|sku|child_asin with
// per-month sums under byMonth). `monthlyBatches`: [{ monthKey, rows }] in canonical window order.
export function skuPlFold(monthlyBatches) {
  const combined = new Map();
  for (const { monthKey, rows } of monthlyBatches) {
    for (const row of rows) {
      const sku = String(row.sku || "").trim();
      const childAsin = String(row.child_asin || "").trim();
      const currency = String(row.currency || "").trim() || null;
      const key = `${currency || "?"}|${sku}|${childAsin}`;
      let entry = combined.get(key);
      if (!entry) {
        entry = {
          sku: sku || null,
          asin: childAsin || null,
          productName: String(row.product_name || "").trim() || null,
          brand: String(row.product_brand || "").trim() || null,
          currency,
          byMonth: {},
        };
        combined.set(key, entry);
      }
      if (!entry.productName) entry.productName = String(row.product_name || "").trim() || null;
      if (!entry.brand) entry.brand = String(row.product_brand || "").trim() || null;
      const bucket = entry.byMonth[monthKey] || { sales: 0, profit: 0, cost: 0, adSpend: 0, fees: 0, cogs: 0, units: 0 };
      bucket.sales += num(row.total_sales_sum ?? row.total_sales);
      bucket.profit += num(row.profit_sum ?? row.profit);
      bucket.cost += num(row.total_cost_sum ?? row.total_cost);
      bucket.adSpend += num(row.ad_spend_sum ?? row.ad_spend);
      bucket.fees += num(row.total_fees_sum ?? row.total_fees);
      bucket.cogs += num(row.cogs_total_sum ?? row.cogs_total);
      bucket.units += num(row.units_sum ?? row.total_units_sold);
      entry.byMonth[monthKey] = bucket;
    }
  }
  return [...combined.values()];
}

// Full SKU P&L payload exactly as the api/datadoe.js `sku-pl` handler assembles it (RAW fold; the
// browser localises currency, applies COGS overrides and recomputes ratios at display time). No
// COGS override is baked in here, so the snapshot equals the route payload byte-for-byte.
export function skuPlPayload({ accountId, from, to, monthlyBatches }) {
  const rows = skuPlFold(monthlyBatches);
  const months = [...new Set(monthlyBatches.map((b) => b.monthKey))];
  const currencies = [...new Set(rows.map((r) => r.currency).filter(Boolean))].sort();
  const catalogBrands = [...new Set(rows.map((r) => r.brand).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return { accountId, from, to, months, currencies, catalogBrands, rows };
}

// Verbatim copy of src/App.jsx skuPlScopedTotals: sum a SKU's per-month buckets for the selected
// month ("ALL" = every month present).
export function skuPlScopedTotals(byMonth, month) {
  const zero = { sales: 0, profit: 0, cost: 0, adSpend: 0, fees: 0, cogs: 0, units: 0 };
  if (!byMonth) return zero;
  const keys = month && month !== "ALL" ? [month] : Object.keys(byMonth);
  return keys.reduce((acc, key) => {
    const b = byMonth[key];
    if (!b) return acc;
    acc.sales += Number(b.sales || 0);
    acc.profit += Number(b.profit || 0);
    acc.cost += Number(b.cost || 0);
    acc.adSpend += Number(b.adSpend || 0);
    acc.fees += Number(b.fees || 0);
    acc.cogs += Number(b.cogs || 0);
    acc.units += Number(b.units || 0);
    return acc;
  }, { ...zero });
}

// Verbatim copy of src/App.jsx cogsOverrideKey: the (account|currency|sku|asin) identity a COGS
// override is stored under.
export function cogsOverrideKey(accountId, row) {
  return [accountId || "", row.currency || "", row.sku || "", row.asin || ""].join("|");
}

// Pick the LATEST per-unit COGS override for a row from injected override records
// ({ currency, sku, asin, per_unit_cost, updated_at }, e.g. supabase getCogsOverrides). Latest =
// max updated_at. Returns a finite >=0 per-unit number, or null when there is no usable override
// (missing COGS stays explicitly unavailable -- NEVER coerced to zero). This is the injected COGS
// dependency: the pure applier receives the resolved per-unit value, never a Supabase client.
export function latestCogsOverridePerUnit(overrideRows, accountId, row) {
  if (!Array.isArray(overrideRows)) return null;
  const wantKey = cogsOverrideKey(accountId, row);
  let best = null;
  for (const o of overrideRows) {
    const key = cogsOverrideKey(accountId, { currency: o.currency, sku: o.sku, asin: o.asin });
    if (key !== wantKey) continue;
    const perUnit = Number(o.per_unit_cost);
    if (!Number.isFinite(perUnit) || perUnit < 0) continue;
    const ts = String(o.updated_at || "");
    if (best === null || ts > best.ts) best = { perUnit, ts };
  }
  return best ? best.perUnit : null;
}

// Verbatim copy of src/App.jsx computeSkuPlRow: turn one raw SKU row + selected month + an
// injected COGS-per-unit override into displayable, recomputed metrics. A manual override replaces
// ONLY the COGS component; cost and profit move by the same delta; every ratio is recomputed from
// the summed amounts (ratios are never summed). Missing COGS stays flagged, never assumed zero.
export function computeSkuPlRow(row, month, cogsPerUnitOverride) {
  const t = skuPlScopedTotals(row.byMonth, month);
  const rawCogs = t.cogs;
  const hasCogsOverride = Number.isFinite(cogsPerUnitOverride) && cogsPerUnitOverride >= 0;
  const cogs = hasCogsOverride ? t.units * cogsPerUnitOverride : rawCogs;
  const cogsDelta = cogs - rawCogs;
  const cost = t.cost + cogsDelta;
  const profit = t.profit - cogsDelta;
  const margin = t.sales > 0 ? (profit / t.sales) * 100 : null;
  const adSalesRatio = t.sales > 0 ? (t.adSpend / t.sales) * 100 : null;
  const cogsMissing = t.sales > 0 && cogs <= 0;
  return {
    sku: row.sku, asin: row.asin, productName: row.productName, brand: row.brand, currency: row.currency,
    ...t, cogs, cost, profit, rawCogs, cogsPerUnitOverride: hasCogsOverride ? cogsPerUnitOverride : null,
    hasCogsOverride, margin, adSalesRatio, cogsMissing,
    hasActivity: t.sales !== 0 || profit !== 0 || t.units !== 0 || t.adSpend !== 0,
  };
}

// ---- Reconciliation cores. Verbatim copies of api/datadoe.js reconciliationOrders /
//      reconciliationSettlements (single formula, kept dependency-free here so both the route and
//      the Scheduler v2 reconciliation derivation compute IDENTICAL orders/settlements). Proven
//      equal to the route formula by the reconciliation parity harness. ----

// Verbatim copy of api/datadoe.js reconciliationOrders: fold order-line rows to one entry per
// amazon_order_id (purchase-side), keeping the distinct brand list per order. Currency is taken
// from the order's first row and NEVER merged across currencies (each order keeps its own).
export function reconciliationOrders(rows, catalogRows) {
  const brandByAsin = new Map();
  for (const row of catalogRows) {
    const asin = String(row.child_asin || "").trim();
    const brand = String(row.product_brand || "").trim() || "Unassigned";
    if (asin && !brandByAsin.has(asin)) brandByAsin.set(asin, brand);
  }
  const byOrder = new Map();
  for (const row of rows) {
    const orderId = String(row.amazon_order_id || "").trim();
    if (!orderId) continue;
    const brand = brandByAsin.get(String(row.child_asin || "").trim()) || "Unassigned";
    const current = byOrder.get(orderId) || {
      orderId,
      orderDate: row.order_date || row.date || null,
      status: row.amazon_order_status || "Unknown",
      fulfillmentChannel: row.fulfillment_channel || "Unknown",
      isBusiness: row.order_is_business === true || String(row.order_is_business).toLowerCase() === "true",
      currency: row.item_price_currency || null,
      quantity: 0,
      orderRevenue: 0,
      orderTax: 0,
      brandBreakdown: {},
    };
    const quantity = num(row.quantity_sum ?? row.quantity);
    const revenue = num(row.item_price_sum ?? row.item_price_value);
    const tax = num(row.item_tax_sum ?? row.item_tax_value);
    current.quantity += quantity;
    current.orderRevenue += revenue;
    current.orderTax += tax;
    const brandTotal = current.brandBreakdown[brand] || { quantity: 0, orderRevenue: 0, orderTax: 0 };
    brandTotal.quantity += quantity;
    brandTotal.orderRevenue += revenue;
    brandTotal.orderTax += tax;
    current.brandBreakdown[brand] = brandTotal;
    byOrder.set(orderId, current);
  }
  return [...byOrder.values()].map(({ brandBreakdown, ...order }) => ({
    ...order,
    brands: Object.keys(brandBreakdown),
  }));
}

// Verbatim copy of api/datadoe.js reconciliationSettlements: one canonical settlement row per source
// row (posting-side), currency preserved per row (never converted).
export function reconciliationSettlements(rows) {
  return rows.map((row) => ({
    settlementDate: row.date || null,
    orderId: String(row.amazon_order_id || "").trim() || null,
    settlementType: String(row.settlement_type || "OTHER").trim().toUpperCase(),
    currency: row.currency || null,
    settledRevenue: num(row.item_price_sum ?? row.item_price),
    settledTax: num(row.item_tax_sum ?? row.item_tax),
    referralFee: num(row.referral_fee_sum ?? row.referral_fee),
    fbaFee: num(row.fba_fee_sum ?? row.fba_per_unit_fulfillment_fee),
    refundedAmount: num(row.refunded_amount_sum ?? row.refunded_amount),
    netPayout: num(row.total_sum ?? row.total),
  }));
}

// Assemble the COMPLETE Reconciliation payload exactly as the api/datadoe.js `reconciliation` handler
// does: { from, to, months, orders, settlements }. `months` is the six "YYYY-MM" keys the caller
// derives from the validated six-month window; `orderRows`/`settlementRows` are the concatenated
// per-month saved fragments (identical to the route's reconciliationRowsByMonth concatenation), and
// `catalogRows` is the single full-range catalog fragment. Pure.
export function reconciliationPayload({ from, to, months, orderRows, settlementRows, catalogRows }) {
  return {
    from,
    to,
    months,
    orders: reconciliationOrders(orderRows, catalogRows),
    settlements: reconciliationSettlements(settlementRows),
  };
}

// ---- FBA Shipment Plan cores. A verbatim transcription of the PURE assembly in the api/datadoe.js
//      `fba-plan` handler (the DataDoe fetches are replaced by injected saved source rows). Kept
//      dependency-free here; proven equal to the route formula by the FBA parity harness. ----

// Sum per-ASIN ordered units for one grouped Order Line Items window (verbatim of planAsinUnits's
// fold). Returns a Map(asin -> units) in first-seen row order (child_asin ASC as saved), so
// downstream ASIN ordering matches the route exactly.
export function foldPlanAsinUnits(rows) {
  const byAsin = new Map();
  for (const r of rows || []) {
    const asin = String(r.child_asin || "").trim();
    if (!asin) continue;
    byAsin.set(asin, (byAsin.get(asin) || 0) + num(r.units_sum ?? r.quantity));
  }
  return byAsin;
}

// Fold the ONE canonical Order Line Items sales fragment (Blocker 1) into the per-month FBA inputs
// fbaPlanPayload expects. The canonical rows carry {date, seller_or_vendor_id, sku, child_asin,
// item_price_currency, total_units_sum}; units are a currency-agnostic COUNT so this sums
// total_units_sum ACROSS currencies. Returns synthetic grouped rows shaped like the former per-month
// exports so fbaPlanPayload + the live route are unchanged downstream:
//   completedUnitRows -- [ [{child_asin, units_sum}], ... ] aligned to `completed`, ASIN in first-seen
//                        (date-ordered) row order (byte-identical between live route + scheduler).
//   mtdUnitRows       -- [{child_asin, units_sum}] for the current MTD month.
//   dailyDateRows     -- [{date, units_sum}] summed per current-month date (the latest-date probe).
// A row whose month is outside the completed+current set is ignored (the fragment window is exactly
// those four months, so this only guards malformed input). Pure.
export function foldOliSalesToFbaInputs(rows, completed, current) {
  const completedKeys = (completed || []).map((m) => String(m.key));
  const currentKey = current ? String(current.key) : "";
  const known = new Set([...completedKeys, currentKey]);
  const byMonthAsin = new Map(); // monthKey -> Map(asin -> units), asin insertion order = first-seen
  const byDate = new Map();       // current-month date -> summed units
  for (const r of Array.isArray(rows) ? rows : []) {
    const date = String((r && r.date) || "");
    const mk = date.slice(0, 7);
    const asin = String((r && r.child_asin) || "").trim();
    const units = num(r && (r.total_units_sum ?? r.quantity));
    if (asin && known.has(mk)) {
      let m = byMonthAsin.get(mk);
      if (!m) { m = new Map(); byMonthAsin.set(mk, m); }
      m.set(asin, (m.get(asin) || 0) + units);
    }
    if (mk === currentKey && date) byDate.set(date, (byDate.get(date) || 0) + units);
  }
  const rowsForMonth = (mk) => [...(byMonthAsin.get(mk) || new Map())].map(([child_asin, units_sum]) => ({ child_asin, units_sum }));
  return {
    completedUnitRows: completedKeys.map(rowsForMonth),
    mtdUnitRows: rowsForMonth(currentKey),
    dailyDateRows: [...byDate].sort((a, b) => a[0].localeCompare(b[0])).map(([date, units_sum]) => ({ date, units_sum })),
  };
}

/**
 * Full FBA Shipment Plan payload, byte-identical to the api/datadoe.js `fba-plan` handler, derived
 * PURELY from saved source rows. Inputs (all already validated + scoped by the caller):
 *   asOf, accountName, marketCountry, isUS  -- authoritative account metadata (String(to)/name/country).
 *   completed  -- [{key,from,to}] x3 completed months (from planMonthWindows).
 *   current    -- {key,from,to,daysInMonth} current MTD month (from planMonthWindows).
 *   completedUnitRows -- [rows,rows,rows] grouped child_asin units, aligned to `completed`.
 *   mtdUnitRows       -- grouped child_asin units for the current MTD window.
 *   dailyDateRows     -- grouped date units for the current month (salesLatestDate + elapsedDays).
 *   catalogRows       -- product catalog rows (brand + product name).
 *   invRows           -- FBA inventory-health rows (DESC by date; latest snapshot folded).
 *   awdRows           -- US-only AWD listing rows (ignored when !isUS; [] = validated empty).
 * ASIN row order follows the route: completed-month ASINs, then MTD ASINs, then inventory ASINs.
 */
export function fbaPlanPayload({
  asOf, accountName, marketCountry, isUS,
  completed, current,
  completedUnitRows = [], mtdUnitRows = [], dailyDateRows = [],
  catalogRows = [], invRows = [], awdRows = [],
}) {
  // 1) Per-ASIN units for each completed month.
  const asinSet = new Set();
  const unitsByAsinByMonth = {};
  completed.forEach((mo, i) => {
    const byAsin = foldPlanAsinUnits(completedUnitRows[i] || []);
    for (const [asin, units] of byAsin) {
      asinSet.add(asin);
      (unitsByAsinByMonth[asin] || (unitsByAsinByMonth[asin] = {}))[mo.key] = units;
    }
  });

  // 2a) Current-month MTD units per ASIN.
  const mtdByAsin = foldPlanAsinUnits(mtdUnitRows);
  for (const asin of mtdByAsin.keys()) asinSet.add(asin);
  // 2b) Latest completed sales date in the current month + elapsed days (day-of-month of that date).
  let salesLatestDate = null;
  for (const r of dailyDateRows || []) {
    if (num(r.units_sum) > 0 && r.date && (!salesLatestDate || r.date > salesLatestDate)) salesLatestDate = r.date;
  }
  const elapsedDays = (salesLatestDate && salesLatestDate >= current.from && salesLatestDate <= current.to)
    ? Number(String(salesLatestDate).slice(8, 10))
    : 0;

  // 3) Catalog brand + product name (first non-empty per ASIN).
  const brandByAsin = new Map();
  const nameByAsin = new Map();
  for (const c of catalogRows || []) {
    const asin = String(c.child_asin || "").trim();
    if (!asin) continue;
    const brand = String(c.product_brand || "").trim();
    if (brand && !brandByAsin.has(asin)) brandByAsin.set(asin, brand);
    const name = String(c.product_name || "").trim();
    if (name && !nameByAsin.has(asin)) nameByAsin.set(asin, name);
  }

  // 4) Latest FBA inventory-health snapshot, folded SKU->ASIN + a (marketplace, brand) roll-up.
  let inventoryDate = null;
  for (const r of invRows || []) {
    if (r.date && (!inventoryDate || r.date > inventoryDate)) inventoryDate = r.date;
  }
  const invByAsin = {};
  const skusByAsin = {};
  const invProductName = new Map();
  const invByCountryBrand = new Map();
  for (const r of invRows || []) {
    if (inventoryDate && r.date !== inventoryDate) continue; // latest snapshot only
    const asin = String(r.child_asin || "").trim();
    if (!asin) continue;
    asinSet.add(asin);
    const cur = invByAsin[asin] || (invByAsin[asin] = {
      available: 0, customerOrderReserved: 0, fcTransfer: 0, fcProcessing: 0,
      inboundShipped: 0, inboundReceived: 0, inboundWorking: 0,
    });
    cur.available += num(r.available);
    cur.customerOrderReserved += num(r.reserved_customer_order); // display-only; never usable stock
    cur.fcTransfer += num(r.reserved_fc_transfer);
    cur.fcProcessing += num(r.reserved_fc_processing);
    cur.inboundShipped += num(r.inbound_shipped);
    cur.inboundReceived += num(r.inbound_received);
    cur.inboundWorking += num(r.inbound_working);
    const sku = String(r.sku || "").trim();
    if (sku) (skusByAsin[asin] || (skusByAsin[asin] = new Set())).add(sku);
    const nm = String(r.product_name || "").trim();
    if (nm && !invProductName.has(asin)) invProductName.set(asin, nm);
    const invCountry = String(r.marketplace_country_code || marketCountry || "").trim().toUpperCase();
    const invBrand = brandByAsin.get(asin) || null;
    const countryBrandKey = `${invCountry}|${invBrand || ""}`;
    const bucket = invByCountryBrand.get(countryBrandKey)
      || { country: invCountry || null, brand: invBrand, fbaAvailable: 0, skus: new Set() };
    bucket.fbaAvailable += num(r.available);
    if (sku) bucket.skus.add(sku);
    invByCountryBrand.set(countryBrandKey, bucket);
  }
  const inventoryAvailable = (invRows || []).length > 0;

  // 5) AWD available + inbound (US only), folded SKU->ASIN. AWD rows are pinned to US at the source (marketplaceCountries
  //    ["US"]); a defensive marketplace check drops any non-US row so US AWD can never attach to another marketplace.
  const awdByAsin = {};
  const awdInboundByAsin = {};
  let awdAvailable = false;
  if (isUS) {
    const rows = awdRows || [];
    awdAvailable = rows.length > 0;
    for (const r of rows) {
      const mkt = String(r.marketplace_country_code || "").trim().toUpperCase();
      if (mkt && mkt !== "US") continue; // US-only: never let a non-US AWD row leak in
      const asin = String(r.child_asin || "").trim();
      if (!asin) continue;
      awdByAsin[asin] = (awdByAsin[asin] || 0) + num(r.awd_available_distributable_quantity);
      awdInboundByAsin[asin] = (awdInboundByAsin[asin] || 0) + num(r.awd_total_inbound_quantity);
      const sku = String(r.sku || "").trim();
      if (sku) (skusByAsin[asin] || (skusByAsin[asin] = new Set())).add(sku);
    }
  }

  // 5b) The durable ACCOUNT SKU UNIVERSE -- every SKU seen in ANY source (inventory, AWD, sales). This is a SUPERSET of
  //     the representative SKUs shown in the per-ASIN rows, so seller-warehouse management + bulk-import validation can
  //     cover SKUs the plan drops (a non-representative SKU on a multi-SKU ASIN, or a SKU whose ASIN has zero sales AND
  //     zero Amazon inventory). Used only as an authorization allowlist; never fabricates a plan number.
  const accountSkuSet = new Set();
  for (const set of Object.values(skusByAsin)) for (const s of set) accountSkuSet.add(s);
  for (const arr of completedUnitRows || []) for (const r of arr || []) { const s = String(r?.sku || "").trim(); if (s) accountSkuSet.add(s); }
  for (const r of mtdUnitRows || []) { const s = String(r?.sku || "").trim(); if (s) accountSkuSet.add(s); }

  // 6) Assemble one row per ASIN (representative SKU = first localeCompare SKU; drop zero-activity).
  const rows = [];
  for (const asin of asinSet) {
    const inv = invByAsin[asin] || null;
    const skus = skusByAsin[asin] ? [...skusByAsin[asin]].sort((a, b) => a.localeCompare(b)) : [];
    const unitsByMonth = {};
    let salesTotal = 0;
    for (const mo of completed) {
      const u = num(unitsByAsinByMonth[asin]?.[mo.key]);
      unitsByMonth[mo.key] = u;
      salesTotal += u;
    }
    const mtdUnits = num(mtdByAsin.get(asin));
    salesTotal += mtdUnits;
    // Activity total for the drop check (customer-order-reserved counts as activity so a customer-reserved-only SKU
    // is kept). These are DISTINCT states per the source metadata; the inbound_quantity aggregate proves the 3 inbound
    // states sum to it, and reserved_fc_transfer is a separate reserved state -- so there is NO transfer/shipped overlap
    // to subtract. Each state is counted exactly once (no double count).
    const invTotal = inv
      ? inv.available + inv.customerOrderReserved + inv.fcTransfer + inv.fcProcessing + inv.inboundShipped + inv.inboundReceived + inv.inboundWorking
      : 0;
    const awdUnits = isUS ? num(awdByAsin[asin]) : 0;
    const awdInboundUnits = isUS ? num(awdInboundByAsin[asin]) : 0;
    if (salesTotal <= 0 && invTotal <= 0 && awdUnits <= 0 && awdInboundUnits <= 0) continue;
    rows.push({
      asin,
      productName: nameByAsin.get(asin) || invProductName.get(asin) || null,
      brand: brandByAsin.get(asin) || null,
      sku: skus[0] || null,
      unitsByMonth,
      mtdUnits,
      // FBA fields are null ONLY when the whole snapshot is unavailable; when the snapshot exists
      // but this ASIN is absent, it genuinely holds no FBA stock (0). reserved_fc_transfer is stored RAW (no
      // inbound-shipped subtraction -- that overlap was never proven by the source metadata).
      fbaAvailable: inventoryAvailable ? num(inv?.available) : null,
      customerOrderReserved: inventoryAvailable ? num(inv?.customerOrderReserved) : null,
      reservedFcTransfer: inventoryAvailable ? num(inv?.fcTransfer) : null,
      reservedFcProcessing: inventoryAvailable ? num(inv?.fcProcessing) : null,
      inboundShipped: inventoryAvailable ? num(inv?.inboundShipped) : null,
      inboundReceived: inventoryAvailable ? num(inv?.inboundReceived) : null,
      inboundWorking: inventoryAvailable ? num(inv?.inboundWorking) : null,
      awdAvailable: isUS ? awdUnits : null,
      awdInbound: isUS ? awdInboundUnits : null,
    });
  }

  return {
    asOf: String(asOf),
    accountName: accountName || null,
    marketCountry: marketCountry || null,
    isUS,
    months: completed,
    currentMonth: current,
    salesLatestDate,
    elapsedDays,
    inventoryDate,
    inventoryAvailable,
    awdAvailable,
    rows,
    accountSkus: [...accountSkuSet].sort((a, b) => a.localeCompare(b)),
    inventoryByBrandCountry: [...invByCountryBrand.values()].map(({ skus, ...entry }) => ({
      ...entry,
      skuCount: skus.size,
    })),
  };
}

// ---- Keyword Rank cores. Verbatim copies of the api/datadoe.js `keyword-rank` handler's PURE
//      helpers (the DataDoe fetches + the non-deterministic retrievedAt are supplied by the caller).
//      Kept dependency-free here; proven equal to the route formula by the Keyword Rank parity
//      harness. ----

// Verbatim copy of api/datadoe.js sqpDistinctPeriods: the sorted set of distinct non-empty `date`
// values in a SQP row set. Drives the weekly-vs-monthly-vs-baseline cadence decision.
export function sqpDistinctPeriods(rows) {
  return [...new Set((rows || []).map((row) => String(row.date || "")).filter(Boolean))].sort();
}

/**
 * Full Keyword Rank payload, byte-identical to the api/datadoe.js `keyword-rank` handler (except
 * `retrievedAt`, which the route stamps with Date.now() but the scheduler supplies DETERMINISTICALLY
 * from validated saved source metadata). The caller has already resolved `cadence`/`periods`/`rows`
 * (weekly / monthly / baseline) and `weeklyPeriodCount` per the route's cadence logic; this assembler
 * builds `products` (unique child_asin in catalog source order; blank name -> null, blank brand ->
 * "Unassigned") and `catalogBrands`, exactly like the route. Pure.
 */
export function keywordRankPayload({ accountId, cadence, periods, weeklyPeriodCount, rows, catalogRows, retrievedAt }) {
  const products = [];
  const seenAsins = new Set();
  for (const row of catalogRows || []) {
    const asin = String(row.child_asin || "").trim();
    if (!asin || seenAsins.has(asin)) continue;
    seenAsins.add(asin);
    products.push({
      asin,
      name: String(row.product_name || "").trim() || null,
      brand: String(row.product_brand || "").trim() || "Unassigned",
    });
  }
  return {
    accountId,
    cadence,
    periods,
    weeklyPeriodCount,
    rows,
    products,
    catalogBrands: catalogBrandNames(catalogRows || []),
    retrievedAt,
  };
}

// ---- Sales Movers cores -------------------------------------------------------------------
//
// Verbatim PURE transcription of the post-fetch folds in lib/server/reports/sales-movers.js and
// lib/server/reports/common.js -- operating on ALREADY-SAVED source rows instead of DataDoe exports, so
// this module keeps its ZERO DataDoe/Supabase/network import boundary. The assembled payload is
// byte-identical to buildSalesMovers() for the same rows. Only the fields the Sales Movers payload
// actually consumes are folded (prices are per-SKU and unused here).

// numOrNull: preserve "no value" so a missing days-of-supply is null, never a fabricated 0. Byte-identical
// to lib/server/datadoe.js numOrNull.
const numOrNull = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const value = Number(v);
  return Number.isFinite(value) ? value : null;
};
// Grouped-export sum helper (alias or raw column). Byte-identical to common.js sumField.
const smSumField = (row, alias, column) => num(row[alias] ?? row[column]);
// Brand label: trimmed value or "Unassigned". Byte-identical to common.js brandLabel.
export function salesMoversBrandLabel(value) {
  return String(value || "").trim() || "Unassigned";
}
function smEmptyWindowTotals() {
  return { sales: 0, units: 0, orders: 0, sessions: 0, pageViews: 0, unitsShipped: 0, unitsRefunded: 0 };
}

// Latest reported sales date from probe rows: the max `date` whose units are > 0 (a newer zero-units
// placeholder must NOT anchor a window). Byte-identical to source-signals latestReportedDateFromProbeRows.
export function salesMoversLatestReportedDate(rows) {
  let latest = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    const date = row && (row.date ?? row.metric_date);
    if (date && num(row.units_sum ?? row.total_units) > 0 && (!latest || date > latest)) latest = date;
  }
  return latest;
}

// Traffic window fold -> { byAsin, nameByAsin }. Verbatim from sales-movers.js fetchTrafficWindow.
export function salesMoversTrafficFold(rows) {
  const byAsin = new Map();
  const nameByAsin = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const asin = String(row.child_asin || "").trim();
    if (!asin) continue;
    const name = String(row.product_name || "").trim();
    if (name && !nameByAsin.has(asin)) nameByAsin.set(asin, name);
    const current = byAsin.get(asin) || smEmptyWindowTotals();
    current.sales += smSumField(row, "sales_sum", "total_sales");
    current.units += smSumField(row, "units_sum", "total_units");
    current.orders += smSumField(row, "orders_sum", "total_orders");
    current.sessions += smSumField(row, "sessions_sum", "session");
    current.pageViews += smSumField(row, "page_views_sum", "page_views");
    current.unitsShipped += smSumField(row, "units_shipped_sum", "units_shipped");
    current.unitsRefunded += smSumField(row, "units_refunded_sum", "units_refunded");
    byAsin.set(asin, current);
  }
  return { byAsin, nameByAsin };
}

// Ads window fold -> { byAsin (per-ASIN spend/sales/clicks + mixedCurrency/currency), currencies sorted }.
// Verbatim from sales-movers.js fetchAdsWindow: advertising is NEVER combined across currencies.
export function salesMoversAdsFold(rows) {
  const byAsin = new Map();
  const currencies = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const asin = String(row.child_asin || "").trim();
    if (!asin) continue;
    const currency = String(row.currency || "").trim();
    if (currency) currencies.add(currency);
    const current = byAsin.get(asin) || { spend: 0, sales: 0, clicks: 0, currencies: new Set() };
    current.spend += smSumField(row, "ad_spend_sum", "ad_spend");
    current.sales += smSumField(row, "ad_sales_sum", "ad_sales");
    current.clicks += smSumField(row, "ad_clicks_sum", "ad_clicks");
    if (currency) current.currencies.add(currency);
    byAsin.set(asin, current);
  }
  for (const entry of byAsin.values()) {
    entry.mixedCurrency = entry.currencies.size > 1;
    entry.currency = entry.currencies.size === 1 ? [...entry.currencies][0] : null;
  }
  return { byAsin, currencies: [...currencies].sort() };
}

// Advertising figures for one ASIN across both windows; withheld (null) when EITHER window is
// mixed-currency. Verbatim from sales-movers.js adsFor.
export function salesMoversAdsFor(recent, prior) {
  const mixed = Boolean(recent?.mixedCurrency || prior?.mixedCurrency);
  if (mixed) {
    return {
      recentSpend: null, recentSales: null, recentClicks: null,
      priorSpend: null, priorSales: null, priorClicks: null,
      currency: null, mixedCurrency: true,
    };
  }
  return {
    recentSpend: num(recent?.spend),
    recentSales: num(recent?.sales),
    recentClicks: num(recent?.clicks),
    priorSpend: num(prior?.spend),
    priorSales: num(prior?.sales),
    priorClicks: num(prior?.clicks),
    currency: recent?.currency || prior?.currency || null,
    mixedCurrency: false,
  };
}

// Inventory fold: pick the LATEST snapshot date present, then fold that snapshot to ASIN. `available` is
// false when the whole snapshot is missing (=> the payload renders null stock, never zero). Verbatim from
// common.js fetchInventorySnapshot (only the byAsin fields the Sales Movers payload reads).
export function salesMoversInventoryFold(rows) {
  const all = Array.isArray(rows) ? rows : [];
  let snapshotDate = null;
  for (const row of all) {
    if (row && row.date && (!snapshotDate || row.date > snapshotDate)) snapshotDate = row.date;
  }
  const current = snapshotDate ? all.filter((row) => row.date === snapshotDate) : [];
  const byAsin = new Map();
  for (const row of current) {
    const asin = String(row.child_asin || "").trim();
    if (!asin) continue;
    const entry = {
      available: num(row.available),
      unfulfillable: num(row.unfulfillable_quantity),
      inbound: num(row.inbound_shipped) + num(row.inbound_received),
      daysOfSupply: numOrNull(row.days_of_supply),
      unitsShippedT30: num(row.units_shipped_t30),
    };
    const folded = byAsin.get(asin) || { asin, available: 0, unfulfillable: 0, inbound: 0, unitsShippedT30: 0, daysOfSupply: null, skuCount: 0 };
    folded.available += entry.available;
    folded.unfulfillable += entry.unfulfillable;
    folded.inbound += entry.inbound;
    folded.unitsShippedT30 += entry.unitsShippedT30;
    if (entry.daysOfSupply !== null) {
      folded.daysOfSupply = folded.daysOfSupply === null ? entry.daysOfSupply : Math.min(folded.daysOfSupply, entry.daysOfSupply);
    }
    folded.skuCount += 1;
    byAsin.set(asin, folded);
  }
  return { snapshotDate, available: current.length > 0, byAsin };
}

// Catalog fold -> { byAsin {name, brand, parentAsin}, catalogBrands locale-sorted }. Verbatim from
// common.js fetchCatalog.
export function salesMoversCatalogFold(rows) {
  const byAsin = new Map();
  const brands = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const asin = String(row.child_asin || "").trim();
    if (!asin) continue;
    const brand = String(row.product_brand || "").trim();
    if (brand) brands.add(brand);
    if (!byAsin.has(asin)) {
      byAsin.set(asin, {
        name: String(row.product_name || "").trim() || null,
        brand: brand || null,
        parentAsin: String(row.parent_asin || "").trim() || null,
      });
    }
  }
  return { byAsin, catalogBrands: [...brands].sort((a, b) => a.localeCompare(b)) };
}

/**
 * Full Sales Movers payload, byte-identical to buildSalesMovers() for the same saved rows. Zero-tail
 * ASINs (both windows fully zero) are dropped; product-name precedence is catalog -> recent traffic ->
 * prior traffic; inventory is null unless the snapshot is available; buy box is never evaluated. Pure.
 */
export function salesMoversPayload({
  accountId, asOf, latestReportedDate, recent, prior, lagDays, sourceLabel, windowDays,
  recentTrafficRows, priorTrafficRows, recentAdsRows, priorAdsRows, inventoryRows, catalogRows,
}) {
  const recentTraffic = salesMoversTrafficFold(recentTrafficRows);
  const priorTraffic = salesMoversTrafficFold(priorTrafficRows);
  const recentAds = salesMoversAdsFold(recentAdsRows);
  const priorAds = salesMoversAdsFold(priorAdsRows);
  const inventory = salesMoversInventoryFold(inventoryRows);
  const catalog = salesMoversCatalogFold(catalogRows);

  const asins = new Set([...recentTraffic.byAsin.keys(), ...priorTraffic.byAsin.keys()]);
  const rows = [];
  for (const asin of asins) {
    const recentTotals = recentTraffic.byAsin.get(asin) || smEmptyWindowTotals();
    const priorTotals = priorTraffic.byAsin.get(asin) || smEmptyWindowTotals();
    // Drop the permanent zero tail this source emits for every catalog ASIN.
    if (
      recentTotals.sales === 0 && priorTotals.sales === 0
      && recentTotals.units === 0 && priorTotals.units === 0
      && recentTotals.sessions === 0 && priorTotals.sessions === 0
    ) continue;
    const meta = catalog.byAsin.get(asin) || {};
    const stock = inventory.byAsin.get(asin) || null;
    rows.push({
      asin,
      productName: meta.name || recentTraffic.nameByAsin.get(asin) || priorTraffic.nameByAsin.get(asin) || null,
      brand: salesMoversBrandLabel(meta.brand),
      recent: recentTotals,
      prior: priorTotals,
      ads: salesMoversAdsFor(recentAds.byAsin.get(asin), priorAds.byAsin.get(asin)),
      inventory: inventory.available
        ? {
          available: num(stock?.available),
          inbound: num(stock?.inbound),
          daysOfSupply: stock?.daysOfSupply ?? null,
          unitsShippedT30: num(stock?.unitsShippedT30),
        }
        : null,
    });
  }
  const currencies = [...new Set([...recentAds.currencies, ...priorAds.currencies])];
  return {
    accountId,
    asOf,
    salesLatestDate: latestReportedDate,
    lagDays,
    sourceLabel,
    dataUnavailable: false,
    windows: { recent, prior, days: windowDays },
    currencies,
    buyBoxEvaluated: false,
    inventoryAvailable: inventory.available,
    inventorySnapshotDate: inventory.snapshotDate,
    rows,
    catalogBrands: catalog.catalogBrands,
  };
}

// The honest "no completed week to compare" payload -- a VALID completed snapshot when the probe reported
// no latest sales date. Byte-identical to buildSalesMovers()'s early return. NEVER converts missing sales
// into zero, and requests no downstream sources.
export function salesMoversUnavailablePayload({ accountId, asOf, lagDays, sourceLabel, probeFrom }) {
  return {
    accountId,
    asOf,
    salesLatestDate: null,
    lagDays,
    sourceLabel,
    dataUnavailable: true,
    unavailableReason: `${sourceLabel} reported no units for this account between ${probeFrom} and ${asOf}, so there is no completed week to compare. This is upstream source availability, not a zero-sales week.`,
    windows: null,
    rows: [],
    catalogBrands: [],
  };
}

/* ================================ Buy Box Loss ================================ */
// PURE cores for Buy Box Loss, transcribed VERBATIM from lib/server/reports/buy-box.js +
// common.js fetchInventorySnapshot. buybox_percentage is a RATIO on Profit by SKU & Date, so it is
// NEVER summed: the share is page-view weighted, falling back to an unweighted mean over OBSERVED days
// only when no observed day had page views. Null buy-box observations are EXCLUDED (a sole seller with
// no competition is not a 0% loss). Currency+SKU is the aggregation identity; two currencies for one SKU
// never merge. Missing inventory snapshot stays unavailable/null, never a fabricated zero.

/**
 * Latest FBA Inventory Health snapshot folded by SKU, byte-identical to common.js fetchInventorySnapshot's
 * `bySku`. Keeps only the newest date present; first row wins per SKU. Competitive prices are nullable and
 * kept null (a missing price is never read as "priced at zero"). `available` is snapshot-level presence.
 */
export function buyBoxInventoryFold(rows) {
  const all = Array.isArray(rows) ? rows : [];
  let snapshotDate = null;
  for (const row of all) {
    if (row && row.date && (!snapshotDate || row.date > snapshotDate)) snapshotDate = row.date;
  }
  const current = snapshotDate ? all.filter((row) => row.date === snapshotDate) : [];
  const bySku = new Map();
  for (const row of current) {
    const sku = String(row.sku || "").trim();
    const asin = String(row.child_asin || "").trim();
    const entry = {
      sku: sku || null,
      asin: asin || null,
      productName: String(row.product_name || "").trim() || null,
      currency: String(row.currency || "").trim() || null,
      available: num(row.available),
      unfulfillable: num(row.unfulfillable_quantity),
      inbound: num(row.inbound_shipped) + num(row.inbound_received),
      daysOfSupply: numOrNull(row.days_of_supply),
      unitsShippedT30: num(row.units_shipped_t30),
      yourPrice: numOrNull(row.your_price),
      salesPrice: numOrNull(row.sales_price),
      featuredOfferPrice: numOrNull(row.featuredoffer_price),
      lowestPriceNewPlusShipping: numOrNull(row.lowest_price_new_plus_shipping),
      alert: String(row.alert || "").trim() || null,
    };
    if (sku && !bySku.has(sku)) bySku.set(sku, entry);
  }
  return { snapshotDate, available: current.length > 0, bySku };
}

/**
 * Fold the ordered raw daily slices (an array of row-arrays, oldest slice first, each ordered by date
 * ASC) into the per (currency|sku) accumulator, byte-identical to buildBuyBoxLoss()'s slice loop. asin /
 * productName / brand take the FIRST non-empty value seen (slice + date order), so the caller MUST pass
 * the slices in window order. Tracks the observed min/max date across every row.
 */
export function buyBoxDailyFold(sliceRowArrays) {
  const bySku = new Map();
  let observedFrom = null;
  let observedTo = null;
  for (const rows of Array.isArray(sliceRowArrays) ? sliceRowArrays : []) {
    for (const row of Array.isArray(rows) ? rows : []) {
      const sku = String(row.sku || "").trim();
      if (!sku) continue;
      const currency = String(row.currency || "").trim() || null;
      const key = `${currency || "?"}|${sku}`;
      let entry = bySku.get(key);
      if (!entry) {
        entry = {
          sku,
          asin: String(row.child_asin || "").trim() || null,
          productName: String(row.product_name || "").trim() || null,
          brand: String(row.product_brand || "").trim() || null,
          currency,
          pageViews: 0,
          buyBoxWeighted: 0, buyBoxWeight: 0, buyBoxSum: 0, buyBoxDays: 0,
        };
        bySku.set(key, entry);
      }
      if (!entry.productName) entry.productName = String(row.product_name || "").trim() || null;
      if (!entry.brand) entry.brand = String(row.product_brand || "").trim() || null;

      const date = String(row.date || "");
      if (date) {
        if (!observedFrom || date < observedFrom) observedFrom = date;
        if (!observedTo || date > observedTo) observedTo = date;
      }

      const pageViews = num(row.page_views);
      entry.pageViews += pageViews;

      // Null buy-box => no featured-offer competition observed; excluded from the share, not counted 0%.
      const buyBox = numOrNull(row.buybox_percentage);
      if (buyBox !== null) {
        entry.buyBoxDays += 1;
        entry.buyBoxSum += buyBox;
        if (pageViews > 0) {
          entry.buyBoxWeighted += buyBox * pageViews;
          entry.buyBoxWeight += pageViews;
        }
      }
    }
  }
  return { bySku, observedFrom, observedTo };
}

/**
 * Fold the ordered slices of the ONE CANONICAL Order Line Items sales fragment (grouped by
 * [date, seller_or_vendor_id, sku, child_asin, item_price_currency], aggregations item_price_value->
 * total_sales_sum / quantity->total_units_sum) into a per (currency|sku) map of { sales, units },
 * byte-identical to buildBuyBoxLoss()'s ordered slice loop. Currency is NEVER merged (it is part of the
 * key); the canonical date/seller columns are summed away into the currency|sku join key.
 */
export function buyBoxOrderedFold(sliceRowArrays) {
  const bySku = new Map();
  for (const rows of Array.isArray(sliceRowArrays) ? sliceRowArrays : []) {
    for (const row of Array.isArray(rows) ? rows : []) {
      const sku = String(row.sku || "").trim();
      if (!sku) continue;
      const currency = String(row.item_price_currency || "").trim() || null;
      const key = `${currency || "?"}|${sku}`;
      let entry = bySku.get(key);
      if (!entry) { entry = { sales: 0, units: 0 }; bySku.set(key, entry); }
      entry.sales += smSumField(row, "total_sales_sum", "item_price_value");
      entry.units += smSumField(row, "total_units_sum", "quantity");
    }
  }
  return bySku;
}

/**
 * Full Buy Box Loss payload, byte-identical to buildBuyBoxLoss() for the same saved rows. Ordered sales/units
 * come from the Order Line Items slices (joined on currency|sku); buybox_percentage + page_views + the
 * page-view-weighted share come from the Profit by SKU daily slices. Excludes SKUs with no ordered sales/units
 * and SKUs with no observed buy-box data; page-view-weighted share with an unweighted-mean fallback;
 * price/stock evidence null when the snapshot did not carry the SKU. Currency never merges. Pure.
 */
export function buyBoxLossPayload({
  accountId, asOf, from, windowDays, sliceDays, sourceLabel, priceSourceLabel,
  dailySliceRows, orderedSliceRows, inventoryRows, catalogRows,
}) {
  const daily = buyBoxDailyFold(dailySliceRows);
  const ordered = buyBoxOrderedFold(orderedSliceRows);
  const inventory = buyBoxInventoryFold(inventoryRows);
  // The shared common-insight catalog fold (child_asin -> { name, brand, parentAsin }); identical to
  // common.js fetchCatalog, so Buy Box + Sales Movers + other insight reports share one catalog identity.
  const catalog = salesMoversCatalogFold(catalogRows);

  const rows = [];
  const currencies = new Set();
  for (const entry of daily.bySku.values()) {
    // Ordered sales/units join on the SAME currency|sku identity used by the buy-box fold.
    const sold = ordered.get(`${entry.currency || "?"}|${entry.sku}`) || { sales: 0, units: 0 };
    // Only SKUs that actually sold in the window can have revenue at risk.
    if (sold.units <= 0 && sold.sales <= 0) continue;
    if (entry.buyBoxDays === 0) continue; // no observed buy-box data at all

    const weighted = entry.buyBoxWeight > 0;
    const buyBoxPct = weighted
      ? entry.buyBoxWeighted / entry.buyBoxWeight
      : entry.buyBoxSum / entry.buyBoxDays;

    const stock = inventory.bySku.get(entry.sku) || null;
    const meta = entry.asin ? catalog.byAsin.get(entry.asin) || {} : {};
    if (entry.currency) currencies.add(entry.currency);

    rows.push({
      sku: entry.sku,
      asin: entry.asin,
      productName: entry.productName || meta.name || null,
      brand: salesMoversBrandLabel(entry.brand || meta.brand),
      currency: entry.currency,
      buyBoxPct,
      buyBoxBasis: weighted ? "page-view weighted" : "unweighted mean of observed days",
      buyBoxDays: entry.buyBoxDays,
      windowDays,
      sales: sold.sales,
      units: sold.units,
      pageViews: entry.pageViews,
      // Price and stock evidence. null means the snapshot did not carry it, and the client must then
      // refuse to name a cause.
      price: stock
        ? {
          yourPrice: stock.yourPrice,
          salesPrice: stock.salesPrice,
          featuredOfferPrice: stock.featuredOfferPrice,
          lowestPriceNewPlusShipping: stock.lowestPriceNewPlusShipping,
          currency: stock.currency,
        }
        : null,
      available: stock ? stock.available : null,
      unitsShippedT30: stock ? stock.unitsShippedT30 : null,
      inventoryKnown: Boolean(stock),
    });
  }

  return {
    accountId,
    asOf,
    window: { from, to: asOf, days: windowDays, sliceDays },
    observedWindow: daily.observedFrom && daily.observedTo ? { from: daily.observedFrom, to: daily.observedTo } : null,
    sourceLabel,
    priceSourceLabel,
    inventoryAvailable: inventory.available,
    inventorySnapshotDate: inventory.snapshotDate,
    currencies: [...currencies].sort(),
    rows,
    catalogBrands: catalog.catalogBrands,
  };
}

/* ============================ Returns & Refund Leakage ============================ */
// PURE cores for Returns & Refund Leakage, transcribed VERBATIM from lib/server/reports/returns.js.
// Three sources prove different things: Returns (reason mix + counts; NO quantity/currency column, one row
// = one returned item -- also the return-rate NUMERATOR), Settlements (the money per currency|ASIN, ORDER
// vs REFUND), and Order Line Items (ordered units per ASIN -- the return-rate DENOMINATOR). Currency is
// NEVER merged; refund money uses absolute values
// (Amazon posts money-out negative); the return-fee component is clamped at zero so a restocking recovery
// can never understate leakage. Reuses the shared sumField (smSumField), brand (salesMoversBrandLabel) and
// catalog (salesMoversCatalogFold) folds. Zero transport imports.

// Amazon's return-reason enum grouped into the four fixable levers + an explicit low-actionability bucket;
// anything unmatched stays "other". Byte-identical to returns.js RETURN_REASON_BUCKETS.
export const RETURNS_REASON_BUCKETS = [
  { key: "product_quality", label: "Product / quality", lever: "Supplier and QC", test: /DEFECT|QUALITY|DAMAGED_BY|MISSING_PART|NOT_WORK|BROKEN|EXPIRED/ },
  { key: "listing_accuracy", label: "Listing accuracy", lever: "Listing content", test: /NOT_AS_DESCRIB|NOT_COMPATIB|WRONG_ITEM|SWITCHEROO|MISSED_DESCRIPTION|INACCURATE/ },
  { key: "sizing", label: "Sizing / fit", lever: "Size chart and images", test: /TOO_SMALL|TOO_LARGE|TOO_BIG|APPAREL_STYLE|SIZE|FIT/ },
  { key: "delivery", label: "Delivery / fulfilment", lever: "Packaging and carrier", test: /UNDELIVERABLE|REFUSED|LATE|NEVER_ARRIVED|IN_TRANSIT|SHIPPING/ },
  { key: "low_actionability", label: "Low actionability", lever: "Usually not fixable", test: /UNWANTED|NO_REASON|MISORDER|NO_LONGER_NEED|FOUND_CHEAPER|ACCIDENTAL/ },
];

// Byte-identical to returns.js classifyReturnReason: first matching bucket, else "other".
export function classifyReturnReason(reason) {
  const text = String(reason || "").toUpperCase();
  if (!text) return "other";
  for (const bucket of RETURNS_REASON_BUCKETS) {
    if (bucket.test.test(text)) return bucket.key;
  }
  return "other";
}

// Fold return records to ASIN, keeping the reason + channel mix. Byte-identical to returns.js's returns
// loop. Returns per-ASIN entries plus the account-wide reasonTotals, pending count, and the FBM-only
// refunded amount / seller-borne label cost (kept separate so they are never shown as an account-wide total).
export function returnsLeakageReturnsFold(rows) {
  const returnsByAsin = new Map();
  const reasonTotals = new Map();
  let pendingReturnRequests = 0;
  let fbmRefundedAmount = 0;
  let fbmLabelCostBorneBySeller = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const asin = String(row.child_asin || "").trim();
    if (!asin) continue;
    const reason = String(row.amazon_return_reason || "").trim() || "NO_REASON_GIVEN";
    const bucket = classifyReturnReason(reason);
    const channel = String(row.amazon_fulfillment_channel || "").trim().toUpperCase() || "UNKNOWN";
    const status = String(row.amazon_return_request_status || "").trim();
    const entry = returnsByAsin.get(asin) || { returnCount: 0, fba: 0, fbm: 0, pending: 0, byBucket: {}, byReason: {}, skus: new Set() };
    entry.returnCount += 1;
    if (channel === "FBA") entry.fba += 1;
    else if (channel === "FBM") entry.fbm += 1;
    if (/pending/i.test(status)) { entry.pending += 1; pendingReturnRequests += 1; }
    entry.byBucket[bucket] = (entry.byBucket[bucket] || 0) + 1;
    entry.byReason[reason] = (entry.byReason[reason] || 0) + 1;
    const sku = String(row.sku || "").trim();
    if (sku) entry.skus.add(sku);
    returnsByAsin.set(asin, entry);
    reasonTotals.set(reason, (reasonTotals.get(reason) || 0) + 1);
    fbmRefundedAmount += Math.abs(num(row.amazon_return_refunded_amount));
    if (/seller/i.test(String(row.amazon_return_label_to_be_paid_by || ""))) {
      fbmLabelCostBorneBySeller += Math.abs(num(row.amazon_return_label_cost));
    }
  }
  return { returnsByAsin, reasonTotals, pendingReturnRequests, fbmRefundedAmount, fbmLabelCostBorneBySeller };
}

// Fold settlement money per (currency, ASIN). ORDER rows contribute settled sales/units; REFUND rows carry
// the refunded amount/tax/referral credit, the ZERO-CLAMPED return-fee component, COGS on refunded units,
// and settled refunded units. Absolute values throughout. Byte-identical to returns.js's settlement loop.
export function returnsLeakageSettlementFold(rows) {
  const moneyByKey = new Map();
  const currencies = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const asin = String(row.child_asin || "").trim();
    if (!asin) continue;
    const currency = String(row.currency || "").trim() || null;
    if (currency) currencies.add(currency);
    const type = String(row.settlement_type || "").trim().toUpperCase();
    const key = `${currency || "?"}|${asin}`;
    const entry = moneyByKey.get(key) || {
      asin, currency, skus: new Set(),
      settledSales: 0, settledUnits: 0, refundedAmount: 0, refundTax: 0, refundedReferralFeeCredit: 0,
      returnFees: 0, cogsOnRefundedUnits: 0, refundedUnitsSettled: 0, refundEvents: 0,
    };
    const sku = String(row.sku || "").trim();
    if (sku) entry.skus.add(sku);
    if (type === "ORDER") {
      entry.settledSales += smSumField(row, "item_price_sum", "item_price");
      entry.settledUnits += smSumField(row, "quantity_sum", "quantity");
    } else if (type === "REFUND") {
      entry.refundEvents += 1;
      entry.refundedAmount += Math.abs(smSumField(row, "refunded_amount_sum", "refunded_amount"));
      entry.refundTax += Math.abs(smSumField(row, "refund_tax_sum", "refund_tax"));
      entry.refundedReferralFeeCredit += Math.abs(smSumField(row, "refunded_referral_fee_sum", "refunded_referral_fee"));
      entry.returnFees += Math.max(0,
        Math.abs(smSumField(row, "refund_commission_sum", "refund_commission"))
        + Math.abs(smSumField(row, "return_unit_fee_sum", "fba_customer_return_per_unit_fee"))
        - Math.abs(smSumField(row, "refund_restocking_fee_sum", "refund_restocking_fee"))
      );
      entry.cogsOnRefundedUnits += Math.abs(smSumField(row, "cogs_sum", "cogs_total_value"));
      entry.refundedUnitsSettled += Math.abs(smSumField(row, "quantity_sum", "quantity"));
    }
    moneyByKey.set(key, entry);
  }
  return { moneyByKey, currencies };
}

// Fold ordered sales/units per (currency, ASIN) from the canonical Order Line Items fragment (the
// return-rate denominator, bound per currency -- Blocker 2). Byte-identical to returns.js's ordered loop.
export function returnsLeakageOrderedFold(rows) {
  const orderedByKey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const asin = String(row.child_asin || "").trim();
    if (!asin) continue;
    const currency = String(row.item_price_currency || "").trim() || null;
    const key = `${currency || "?"}|${asin}`;
    const entry = orderedByKey.get(key) || { asin, currency, sales: 0, orderedUnits: 0, productName: null };
    entry.sales += smSumField(row, "total_sales_sum", "item_price_value");
    entry.orderedUnits += smSumField(row, "total_units_sum", "quantity");
    if (!entry.productName) entry.productName = String(row.product_name || "").trim() || null;
    orderedByKey.set(key, entry);
  }
  return { orderedByKey };
}

/**
 * Full Returns & Refund Leakage payload, byte-identical to buildReturnsLeakage() for the same saved rows.
 * One row per (currency, ASIN); an ASIN with no returns AND no refund events is excluded. Money never
 * crosses currencies; product-name precedence is catalog -> ordered; brand comes from the catalog only.
 * `returnRecordCount` is the RAW return-row count (incl. rows the fold skips). Pure.
 */
export function returnsLeakagePayload({
  accountId, asOf, from, windowDays, returnsSourceLabel, moneySourceLabel, rateSourceLabel,
  rateSourceLagDays, returnHistoryDays, returnRows, settlementRows, orderedRows, catalogRows,
}) {
  const { returnsByAsin, reasonTotals, pendingReturnRequests, fbmRefundedAmount, fbmLabelCostBorneBySeller } = returnsLeakageReturnsFold(returnRows);
  // Blocker 3: settlement-fold currencies are no longer the payload's `currencies`; that field is now the
  // union of the currencies EMITTED on the rows (computed at the return below). Only moneyByKey is needed here.
  const { moneyByKey } = returnsLeakageSettlementFold(settlementRows);
  const { orderedByKey } = returnsLeakageOrderedFold(orderedRows);
  const catalog = salesMoversCatalogFold(catalogRows);

  const asins = new Set([
    ...returnsByAsin.keys(),
    ...[...orderedByKey.values()].map((entry) => entry.asin),
    ...[...moneyByKey.values()].map((entry) => entry.asin),
  ]);
  const rows = [];
  for (const asin of asins) {
    const returns = returnsByAsin.get(asin) || null;
    const meta = catalog.byAsin.get(asin) || {};
    // The ASIN's currency universe = union of settlement-money currencies + ordered currencies. Each row's
    // orderedUnits/sales/refund money come from THAT currency ONLY (never a combined total copied across).
    const byCurrency = new Map();
    for (const m of [...moneyByKey.values()].filter((e) => e.asin === asin)) {
      const c = m.currency ?? null;
      const slot = byCurrency.get(c) || { currency: c, money: null, ordered: null };
      slot.money = m; byCurrency.set(c, slot);
    }
    for (const o of [...orderedByKey.values()].filter((e) => e.asin === asin)) {
      const c = o.currency ?? null;
      const slot = byCurrency.get(c) || { currency: c, money: null, ordered: null };
      slot.ordered = o; byCurrency.set(c, slot);
    }
    // An ASIN with returns but NO money and NO ordered evidence has a single null-currency row.
    if (byCurrency.size === 0 && returns) byCurrency.set(null, { currency: null, money: null, ordered: null });
    const slots = [...byCurrency.values()];
    const multiCurrency = slots.length > 1;
    // Returns carry no currency. SINGLE currency: the sole row holds the returnCount + returnedUnits (rate
    // known). MULTIPLE currencies: the returnCount goes on exactly ONE deterministic PRIMARY row (greatest
    // ordered units; tie-break lexicographically smallest currency), 0 on the others, and returnedUnits is
    // WITHHELD (null) on ALL of the ASIN's rows so the rate is never computed from a currency-ambiguous count.
    let primary = null;
    if (returns && multiCurrency) {
      primary = slots.slice().sort((a, b) => {
        const ua = a.ordered ? a.ordered.orderedUnits : 0;
        const ub = b.ordered ? b.ordered.orderedUnits : 0;
        if (ub !== ua) return ub - ua;
        return String(a.currency ?? "").localeCompare(String(b.currency ?? ""));
      })[0];
    }
    for (const slot of slots) {
      const money = slot.money;
      const ordered = slot.ordered;
      const isReturnHolder = Boolean(returns) && (!multiCurrency || slot === primary);
      // A return-leakage candidate row holds the ASIN's returns OR has its OWN currency's refund events.
      const hasReturnActivity = isReturnHolder || (money && money.refundEvents > 0);
      if (!hasReturnActivity) continue;
      const skus = new Set([...(isReturnHolder ? returns.skus : []), ...(money?.skus || [])]);
      rows.push({
        asin,
        sku: [...skus].sort((a, b) => a.localeCompare(b))[0] || null,
        skuCount: skus.size,
        productName: meta.name || ordered?.productName || null,
        brand: salesMoversBrandLabel(meta.brand),
        currency: slot.currency,
        returnCount: isReturnHolder ? returns.returnCount : 0,
        fbaReturns: isReturnHolder ? returns.fba : 0,
        fbmReturns: isReturnHolder ? returns.fbm : 0,
        pendingReturnRequests: isReturnHolder ? returns.pending : 0,
        reasonBuckets: isReturnHolder ? returns.byBucket : {},
        topReasons: isReturnHolder
          ? Object.entries(returns.byReason).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([reason, count]) => ({ reason, count }))
          : [],
        refundedAmount: money ? money.refundedAmount : 0,
        refundTax: money ? money.refundTax : 0,
        returnFees: money ? money.returnFees : 0,
        refundedReferralFeeCredit: money ? money.refundedReferralFeeCredit : 0,
        cogsOnRefundedUnits: money ? money.cogsOnRefundedUnits : 0,
        refundedUnitsSettled: money ? money.refundedUnitsSettled : 0,
        refundEvents: money ? money.refundEvents : 0,
        settledSales: money ? money.settledSales : 0,
        settledUnits: money ? money.settledUnits : 0,
        hasMoney: Boolean(money),
        // Return rate = returned units (Returns record count) / ordered units (Order Line Items), per THIS
        // currency. returnedUnits is WITHHELD (null) whenever the ASIN spans multiple currencies.
        orderedUnits: ordered ? ordered.orderedUnits : null,
        returnedUnits: (!multiCurrency && isReturnHolder) ? returns.returnCount : null,
        sales: ordered ? ordered.sales : null,
        hasOrdered: Boolean(ordered),
      });
    }
  }
  return {
    accountId,
    asOf,
    window: { from, to: asOf, days: windowDays },
    returnsSourceLabel,
    moneySourceLabel,
    rateSourceLabel,
    rateSourceLagDays,
    returnHistoryDays,
    returnRecordCount: (Array.isArray(returnRows) ? returnRows : []).length,
    pendingReturnRequests,
    fbmOnly: { refundedAmount: fbmRefundedAmount, sellerBorneLabelCost: fbmLabelCostBorneBySeller },
    reasonTotals: [...reasonTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => ({ reason, count, bucket: classifyReturnReason(reason) })),
    // Blocker 3: the CANONICAL union of the nonblank `currency` values actually EMITTED on the payload rows
    // (deduped, sorted) -- NOT the settlement-fold currencies. An ASIN with returns + ordered units in a
    // currency that has NO settlement money still emits that currency on a row, so it must appear here.
    currencies: [...new Set(rows.map((r) => r.currency).filter(Boolean))].sort(),
    rows,
    catalogBrands: catalog.catalogBrands,
  };
}

/* ============================ Listing Health / Suppressed Listings ============================ */
// PURE cores for Listing Health, transcribed VERBATIM from lib/server/reports/listing-health.js.
// Primary source Listings (no-date) gives status / price / channel / quantities; optional Listings (Raw
// JSON) adds Amazon's own issues + buyable/discoverable summaries + live-offer detection; Profit by SKU &
// Date over a trailing 30d window gives sales/units/profit per SKU|currency (currencies NEVER merged);
// the shared FBA inventory snapshot gives the latest available quantity; the shared catalog gives name/
// brand. Reuses the shared sumField/brand/catalog/inventory folds. Zero transport imports.

// JSON helpers -- byte-identical to listing-health.js.
export function listingHealthParseJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(String(value)); } catch (e) { return null; }
}

// Amazon's issues array -> the first six { severity, code, message } the report shows; a row with no
// usable field is dropped. Byte-identical to normaliseIssues.
export function listingHealthNormaliseIssues(value) {
  const parsed = listingHealthParseJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, 6).map((issue) => ({
    severity: String(issue?.severity || "").toUpperCase() || null,
    code: issue?.code === undefined || issue?.code === null ? null : String(issue.code),
    message: String(issue?.message || "").slice(0, 260) || null,
  })).filter((issue) => issue.severity || issue.code || issue.message);
}

// `summaries` is an object OR a one-element array; only a genuinely-present buyable/discoverable flag is
// reported. Byte-identical to normaliseSummary.
export function listingHealthNormaliseSummary(value) {
  const parsed = listingHealthParseJson(value);
  const summary = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!summary || typeof summary !== "object") return { buyable: null, discoverable: null, status: null };
  const statuses = Array.isArray(summary.status)
    ? summary.status.map((entry) => String(entry).toUpperCase())
    : Array.isArray(summary.statuses)
      ? summary.statuses.map((entry) => String(entry).toUpperCase())
      : null;
  return {
    buyable: statuses ? statuses.includes("BUYABLE") : null,
    discoverable: statuses ? statuses.includes("DISCOVERABLE") : null,
    status: statuses ? statuses.join(",") : null,
  };
}

// A live offer is any parsed offer whose price amount is finite and > 0; null when there are no offers.
// Byte-identical to hasLiveOffer.
export function listingHealthHasLiveOffer(value) {
  const parsed = listingHealthParseJson(value);
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  return parsed.some((offer) => {
    const price = offer?.price?.amount ?? offer?.price ?? null;
    const amount = Number(price);
    return Number.isFinite(amount) && amount > 0;
  });
}

// Fold Profit by SKU & Date to per-SKU sales/units/profit + the account currency set. First non-null
// currency wins per SKU; currencies never merge. Byte-identical to listing-health.js's sales loop.
export function listingHealthSalesFold(rows) {
  const salesBySku = new Map();
  const currencies = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const sku = String(row.sku || "").trim();
    if (!sku) continue;
    const currency = String(row.currency || "").trim() || null;
    if (currency) currencies.add(currency);
    const current = salesBySku.get(sku) || { sales: 0, units: 0, profit: 0, currency };
    current.sales += smSumField(row, "sales_sum", "total_sales");
    current.units += smSumField(row, "units_sum", "total_units_sold");
    current.profit += smSumField(row, "profit_sum", "profit");
    if (!current.currency && currency) current.currency = currency;
    salesBySku.set(sku, current);
  }
  return { salesBySku, currencies };
}

// Fold the optional Listings (Raw JSON) rows to per-SKU { issues, summary, hasLiveOffer }. Blank-SKU rows
// are skipped. Byte-identical to listing-health.js's rawBySku loop.
export function listingHealthRawFold(rows) {
  const rawBySku = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const sku = String(row.sku || "").trim();
    if (!sku) continue;
    rawBySku.set(sku, {
      issues: listingHealthNormaliseIssues(row.issues),
      summary: listingHealthNormaliseSummary(row.summaries),
      hasLiveOffer: listingHealthHasLiveOffer(row.offers),
    });
  }
  return rawBySku;
}

/**
 * Full Listing Health payload, byte-identical to buildListingHealth() for the same saved rows. `issuesAvailable`
 * + `issuesUnavailableReason` are resolved by the CALLER (the adapter distinguishes a validated Raw success
 * from the approved degraded/disabled state); when issues are unavailable `rawRows` is [] so every row reports
 * empty issues / null summary / null live-offer. Currencies never merge; inventory stock is null unless the
 * snapshot carries the SKU; product-name precedence is catalog -> listing name; brand from catalog. Pure.
 */
export function listingHealthPayload({
  accountId, asOf, salesFrom, windowDays, sourceLabel, salesSourceLabel, issuesSourceLabel,
  issuesAvailable, issuesUnavailableReason, listingRows, salesRows, inventoryRows, catalogRows, rawRows,
}) {
  const { salesBySku, currencies } = listingHealthSalesFold(salesRows);
  const inventory = buyBoxInventoryFold(inventoryRows);
  const catalog = salesMoversCatalogFold(catalogRows);
  const rawBySku = issuesAvailable ? listingHealthRawFold(rawRows) : new Map();

  const rows = [];
  for (const listing of Array.isArray(listingRows) ? listingRows : []) {
    const sku = String(listing.sku || "").trim();
    const asin = String(listing.child_asin || "").trim();
    if (!sku && !asin) continue;
    const meta = catalog.byAsin.get(asin) || {};
    const sales = salesBySku.get(sku) || null;
    const stock = sku ? inventory.bySku.get(sku) || null : null;
    const raw = rawBySku.get(sku) || null;
    const channelRaw = String(listing.listing_fulfillment_channel || "").trim().toUpperCase();

    const fbaAvailable = num(listing.fba_quantity_available);
    const listingQuantity = num(listing.listing_current_quantity);
    const snapshotAvailable = stock ? num(stock.available) : null;

    rows.push({
      sku: sku || null,
      asin: asin || null,
      productName: meta.name || String(listing.listing_name || "").trim() || null,
      brand: salesMoversBrandLabel(meta.brand),
      listingStatus: String(listing.listing_status || "").trim() || null,
      fulfillmentChannel: channelRaw ? (channelRaw === "DEFAULT" ? "FBM" : "FBA") : null,
      fulfillmentChannelRaw: channelRaw || null,
      price: listing.listing_price_value === null || listing.listing_price_value === undefined
        ? null
        : num(listing.listing_price_value),
      currency: String(listing.listing_price_currency || "").trim() || sales?.currency || null,
      listingQuantity,
      fbaAvailable,
      fbaInbound: num(listing.fba_quantity_inbound),
      fbaReserved: num(listing.fba_quantity_reserved),
      snapshotAvailable,
      openDate: listing.listing_open_date || null,
      sales30d: sales ? sales.sales : 0,
      units30d: sales ? sales.units : 0,
      profit30d: sales ? sales.profit : 0,
      hasSalesData: Boolean(sales),
      issues: raw ? raw.issues : [],
      summary: raw ? raw.summary : null,
      hasLiveOffer: raw ? raw.hasLiveOffer : null,
    });
  }

  return {
    accountId,
    asOf,
    salesWindow: { from: salesFrom, to: asOf, days: windowDays },
    sourceLabel,
    salesSourceLabel,
    issuesAvailable,
    issuesUnavailableReason,
    issuesSourceLabel,
    inventoryAvailable: inventory.available,
    inventorySnapshotDate: inventory.snapshotDate,
    currencies: [...currencies].sort(),
    listingCount: (Array.isArray(listingRows) ? listingRows : []).length,
    rows,
    catalogBrands: catalog.catalogBrands,
  };
}


// SCHEDULER-V2 FAIL-CLOSED currency-isolation guard for Listing Health (NOT part of the route-parity core;
// api/datadoe.js + listing-health.js + listingHealthSalesFold/Payload stay byte-unchanged). The route payload
// emits ONE row per listing and folds sales by SKU only, so saved sales rows that split a single SKU across
// currencies would silently MERGE money into one row. This runs BEFORE the fold and throws (=> the adapter's
// typed `invalid`, zero writes, LKG preserved) when any normalized nonblank SKU carries more than one sales
// currency IDENTITY -- blank/unknown ("?") is its OWN identity, so unknown money can never be absorbed into a
// named currency. It also rejects a nonblank listing_price_currency that conflicts with the SKU's single sales
// currency identity (a named listing currency vs an unknown sales identity is also a conflict). Pure; canonical
// one-currency-per-SKU input passes unchanged (byte-for-byte payload compatible).
export function assertListingHealthCurrencyIsolation(listingRows, salesRows) {
  const salesIdentitiesBySku = new Map(); // sku -> Set<identity>  ("?" == blank/unknown, a distinct identity)
  for (const row of Array.isArray(salesRows) ? salesRows : []) {
    const sku = String(row.sku || "").trim();
    if (!sku) continue;
    const identity = String(row.currency || "").trim() || "?";
    if (!salesIdentitiesBySku.has(sku)) salesIdentitiesBySku.set(sku, new Set());
    salesIdentitiesBySku.get(sku).add(identity);
  }
  for (const [sku, identities] of salesIdentitiesBySku) {
    if (identities.size > 1) {
      throw new Error(`listing-health sales for SKU "${sku}" carry more than one currency identity (${[...identities].sort().join(", ")}); money must never merge across currencies. Snapshot blocked (invalid).`);
    }
  }
  for (const listing of Array.isArray(listingRows) ? listingRows : []) {
    const sku = String(listing.sku || "").trim();
    if (!sku) continue;
    const listingCurrency = String(listing.listing_price_currency || "").trim() || null;
    if (!listingCurrency) continue; // a blank listing currency falls back to the sales currency; no conflict
    const identities = salesIdentitiesBySku.get(sku);
    if (!identities) continue; // the SKU has no sales rows; nothing to reconcile
    const salesIdentity = [...identities][0]; // exactly one (multi-identity already threw above)
    if (salesIdentity === "?" || salesIdentity !== listingCurrency) {
      throw new Error(`listing-health listing currency "${listingCurrency}" for SKU "${sku}" conflicts with its sales currency identity "${salesIdentity}"; snapshot blocked (invalid).`);
    }
  }
}

/* ============================ PPC Performance & Wasted Spend ============================ */
// PURE cores for PPC Performance, transcribed VERBATIM from lib/server/reports/ppc.js. ALL advertising
// figures come from the persisted Supabase Ads history (four source_keys), passed in as already-validated
// rows -- this leaf makes NO network/Supabase/DataDoe call. Money is NEVER combined across currencies
// (currency is part of every rollup key). The only DataDoe-sourced input is the optional total-sales rows
// (the TACoS denominator) + the shared catalog; both are passed in. Reuses num/smSumField/brand/catalog.

const PPC_MIN_CLICKS_FOR_WASTE = 10;
const PPC_ADS_SOURCE_ORIGIN = "Persisted Supabase Amazon Ads history maintained by the scheduled worker";

// CLOSED allowlist of admin-safe PPC coverage reason codes. This is the ONLY vocabulary that may ever reach
// the SAVED `sourceAvailability[].coverageUnavailableReason` field. It is the exact set of typed codes the
// persisted-Ads loader produces (evaluateSourceCoverage + proveSourceCoverage), plus the generic fallback.
// Any other value -- a raw database message, HTTP body, URL, authorization text, token/API key, arbitrary
// caller string, or exception message -- normalizes to the fixed fallback and is NEVER persisted verbatim.
// This constant lives in this import-FREE pure leaf (no transport/storage) and is imported by the loader's
// coverage-contract validator so both the derive/payload boundary AND the loader share ONE source of truth.
export const PPC_COVERAGE_REASON_FALLBACK = "coverage-unavailable";
export const PPC_COVERAGE_REASON_CODES = Object.freeze([
  "coverage-reader-missing",
  "coverage-state-malformed",
  "coverage-schema-missing",
  "coverage-read-failed",
  "coverage-read-not-ok",
  "coverage-windows-not-array",
  "coverage-window-malformed",
  "coverage-incomplete",
  "coverage-unavailable",
]);
const PPC_COVERAGE_REASON_SET = new Set(PPC_COVERAGE_REASON_CODES);
// Return `reason` iff it is an allowlisted safe code; otherwise the fixed safe fallback. Never returns an
// arbitrary caller string. Pure.
export function normalizePpcCoverageReason(reason) {
  return typeof reason === "string" && PPC_COVERAGE_REASON_SET.has(reason) ? reason : PPC_COVERAGE_REASON_FALLBACK;
}

const ppcMetric = (row, key) => num(row && row.metrics ? row.metrics[key] : 0);
function ppcEmptyTotals() { return { spend: 0, sales: 0, clicks: 0, impressions: 0, orders: 0, units: 0 }; }
function ppcAccumulate(target, row, salesKey, ordersKey, unitsKey) {
  target.spend += ppcMetric(row, "ad_spend");
  target.sales += ppcMetric(row, salesKey);
  target.clicks += ppcMetric(row, "ad_clicks");
  target.impressions += ppcMetric(row, "ad_impressions");
  target.orders += ppcMetric(row, ordersKey);
  target.units += ppcMetric(row, unitsKey);
  return target;
}

/**
 * Fold one Ads source into currency-keyed buckets, byte-identical to ppc.js rollupPpcRows. Currency is
 * part of the storage key so a multi-marketplace account never displays two currencies as one amount; each
 * bucket keeps campaignTypes (ad-product coverage) + activeDays. Pure.
 */
export function rollupPpcRows(rows, keyFn, labelFn, { salesKey, ordersKey, unitsKey }) {
  const byKey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const entityKey = keyFn(row);
    if (entityKey === null || entityKey === undefined || entityKey === "") continue;
    const currency = canonicalCurrency(row.currency);
    const key = `${currency || "?"}|${entityKey}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { key, ...labelFn(row), ...ppcEmptyTotals(), currencies: new Set(), campaignTypes: new Set(), days: new Set() };
      byKey.set(key, entry);
    }
    ppcAccumulate(entry, row, salesKey, ordersKey, unitsKey);
    if (currency) entry.currencies.add(currency);
    if (row.campaign_type) entry.campaignTypes.add(row.campaign_type);
    if (row.metric_date) entry.days.add(row.metric_date);
  }
  return [...byKey.values()].map(({ currencies, campaignTypes, days, ...entry }) => ({
    ...entry,
    currencies: [...currencies].sort(),
    campaignTypes: [...campaignTypes].sort(),
    activeDays: days.size,
  }));
}

// The four Ads rollups + the daily campaign series, byte-identical to buildPpcPerformance's keyFn/labelFn.
export function ppcCampaigns(rows) {
  return rollupPpcRows(rows,
    (row) => `${row.campaign_id}|${row.campaign_type}`,
    (row) => ({
      campaignId: row.campaign_id || null,
      campaignName: row.dimensions?.ad_campaign_name || null,
      campaignType: row.campaign_type || null,
      campaignStatus: row.dimensions?.ad_campaign_status || null,
      portfolioName: row.dimensions?.ad_portfolio_name || null,
      budgetAmount: row.dimensions?.ad_campaign_budget_amount ?? null,
      budgetType: row.dimensions?.ad_campaign_budget_type || null,
    }),
    { salesKey: "ad_sales", ordersKey: "ad_orders", unitsKey: "ad_units_sold" });
}
export function ppcAsins(rows) {
  return rollupPpcRows(rows,
    (row) => row.child_asin,
    (row) => ({ asin: row.child_asin || null, sku: row.dimensions?.sku || null, productName: row.dimensions?.product_name || null }),
    { salesKey: "ad_sales_same_sku", ordersKey: "ad_orders_same_sku", unitsKey: "ad_units_sold_same_sku" });
}
export function ppcTargets(rows) {
  return rollupPpcRows(rows,
    (row) => `${row.targeting_id || row.dimensions?.ad_keyword_id || ""}|${row.campaign_id}|${row.dimensions?.ad_group_id || ""}`,
    (row) => ({
      targetText: row.dimensions?.ad_targeting_text || row.dimensions?.ad_keyword || null,
      matchType: row.dimensions?.ad_match_type || null,
      keywordStatus: row.dimensions?.ad_keyword_status || null,
      campaignId: row.campaign_id || null,
      campaignName: row.dimensions?.ad_campaign_name || null,
      campaignType: row.campaign_type || null,
      adGroupName: row.dimensions?.ad_group_name || null,
    }),
    { salesKey: "ad_sales", ordersKey: "ad_orders", unitsKey: "ad_units_sold_click" });
}
export function ppcSearchTerms(rows) {
  return rollupPpcRows(rows,
    (row) => `${row.dimensions?.ad_search_term || ""}|${row.campaign_id}|${row.dimensions?.ad_group_id || ""}`,
    (row) => ({
      searchTerm: row.dimensions?.ad_search_term || null,
      matchedKeyword: row.dimensions?.ad_keyword || row.dimensions?.ad_targeting_text || null,
      matchType: row.dimensions?.ad_match_type || null,
      campaignId: row.campaign_id || null,
      campaignName: row.dimensions?.ad_campaign_name || null,
      campaignType: row.campaign_type || null,
      adGroupName: row.dimensions?.ad_group_name || null,
    }),
    { salesKey: "ad_sales", ordersKey: "ad_orders", unitsKey: "ad_units_sold_click" });
}
export function ppcDailySeries(campaignRows) {
  const dailyMap = new Map();
  for (const row of Array.isArray(campaignRows) ? campaignRows : []) {
    const date = row.metric_date;
    if (!date) continue;
    const currency = canonicalCurrency(row.currency);
    const key = `${date}|${currency || "?"}`;
    const entry = dailyMap.get(key) || { date, currency, ...ppcEmptyTotals() };
    ppcAccumulate(entry, row, "ad_sales", "ad_orders", "ad_units_sold");
    dailyMap.set(key, entry);
  }
  return [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// The account total-sales denominator must be in the SAME currency as the Ads spend. The
// ads-currency gate upstream guarantees <=1 Ads currency; when the Order Line Items rows carry a
// different currency (or mix), TACoS degrades rather than summing across them. Byte-identical to
// ppc.js TOTAL_SALES_CURRENCY_MISMATCH_REASON.
const PPC_TOTAL_SALES_CURRENCY_MISMATCH_REASON =
  "TACoS is unavailable because the account total-sales are in a different currency than the Ads spend; a combined total-sales denominator would be meaningless.";

/**
 * Full PPC Performance payload. The CALCULATIONS (campaigns/ASINs/targets/searchTerms/daily/currencies/TACoS/
 * catalog) are byte-identical to buildPpcPerformance() for the same inputs. `adsRows` are the four persisted
 * Ads sources' validated rows (the scheduler loader has ALREADY dropped any unproven optional source's rows);
 * `syncStates` the ads_sync_state rows; `catalogRows` the shared catalog; the TACoS denominator is EITHER
 * `totalSalesRows` (summed) OR a `totalSalesUnavailable` reason string. `adsSourceDescriptors` are the four
 * source metadata rows (syncKey/label/coverage/defaultDataset/enableHint) in campaign,asin,targeting,
 * search-terms order.
 *
 * `sourceCoverage` (scheduler-only; the live route passes none) is the typed durable-coverage outcome per
 * source. When present it enriches EACH sourceAvailability row with ADMIN-SAFE typed fields --
 * coverageProven / coverageFolded / coverageStatus ("validated" | "unavailable") / coverageUnavailableReason
 * (a typed code, never a raw DB error) -- so a stale/unproven OPTIONAL source is explicitly unavailable even
 * when its ads_sync_state last succeeded, and its dropped rows read as 0. This is additive metadata: it does
 * NOT alter any calculation and the live-route parity fixture only gains these fields. Currencies never merge.
 * Pure.
 */
export function ppcPerformancePayload({
  accountId, asOf, from, windowDays, minClicksForWaste = PPC_MIN_CLICKS_FOR_WASTE,
  adsSourceDescriptors, totalSalesSourceLabel, totalSalesLagDays,
  adsRows, syncStates, sourceCoverage = [], catalogRows, totalSalesRows = null, totalSalesUnavailable = null,
}) {
  const rows = Array.isArray(adsRows) ? adsRows : [];
  const descriptors = Array.isArray(adsSourceDescriptors) ? adsSourceDescriptors : [];
  const coverageByKey = new Map((Array.isArray(sourceCoverage) ? sourceCoverage : []).map((c) => [c && c.sourceKey, c]));
  const [campaignDesc, asinDesc, targetingDesc, searchTermsDesc] = descriptors;
  const syncByKey = new Map((Array.isArray(syncStates) ? syncStates : []).map((s) => [s.source_key, s]));
  const bySource = new Map(descriptors.map((d) => [d.syncKey, []]));
  for (const row of rows) { const b = bySource.get(row.source_key); if (b) b.push(row); }
  const campaignRows = bySource.get(campaignDesc.syncKey) || [];
  const asinRows = bySource.get(asinDesc.syncKey) || [];
  const targetingRows = bySource.get(targetingDesc.syncKey) || [];
  const searchTermRows = bySource.get(searchTermsDesc.syncKey) || [];

  const campaigns = ppcCampaigns(campaignRows);
  const asins = ppcAsins(asinRows);
  const targets = ppcTargets(targetingRows);
  const searchTerms = ppcSearchTerms(searchTermRows);
  const daily = ppcDailySeries(campaignRows);

  // Canonicalized currency identities: "usd" + "USD" collapse to ["USD"] (never ["USD","usd"]), byte-equivalent
  // to buildPpcPerformance()'s payload `currencies`, so the UI's multi-currency KPI suppression never
  // false-positives on mere casing and the two builders stay parity-equal.
  const currencies = [...new Set(rows.map((row) => canonicalCurrency(row.currency)).filter(Boolean))].sort();

  let totalSales = null;
  let totalSalesReason = totalSalesUnavailable != null ? totalSalesUnavailable : null;
  if (totalSalesReason == null && Array.isArray(totalSalesRows)) {
    // Blocker 1: TACoS is available ONLY when the Ads rows carry a SINGLE VALID canonical currency
    // (adsCurrencyEvidence state "single-valid") AND every OLI total-sales row's
    // canonicalCurrency(item_price_currency) is non-null AND EQUAL to it. Any empty/blank/malformed/mixed
    // Ads currency, or any missing/blank/malformed/mismatched OLI currency, leaves TACoS unavailable and
    // NO row is summed (never sum a currencyless/ambiguous row into a currency denominator).
    // Byte-equivalent to buildPpcPerformance()'s TACoS block.
    const adsEvidence = adsCurrencyEvidence(rows);
    const adsCurrency = adsEvidence.state === "single-valid" ? adsEvidence.currency : null;
    if (!adsCurrency) {
      totalSalesReason = PPC_TOTAL_SALES_CURRENCY_MISMATCH_REASON;
    } else if (!totalSalesRows.every((row) => canonicalCurrency(row.item_price_currency) === adsCurrency)) {
      totalSalesReason = PPC_TOTAL_SALES_CURRENCY_MISMATCH_REASON;
    } else {
      totalSales = totalSalesRows.reduce((sum, row) => sum + smSumField(row, "total_sales_sum", "item_price_value"), 0);
    }
  }

  const catalog = salesMoversCatalogFold(catalogRows);
  for (const row of asins) {
    const meta = row.asin ? catalog.byAsin.get(row.asin) || {} : {};
    row.productName = row.productName || meta.name || null;
    row.brand = salesMoversBrandLabel(meta.brand);
  }

  const latestMetricDate = rows.reduce((latest, row) => (!latest || row.metric_date > latest ? row.metric_date : latest), null);

  const descRows = [campaignRows.length, asinRows.length, targetingRows.length, searchTermRows.length];
  const sourceAvailability = descriptors.map((d, i) => {
    const entry = { key: d.syncKey, label: d.label, coverage: d.coverage, rows: descRows[i], sync: syncByKey.get(d.syncKey) || null, defaultDataset: !!d.defaultDataset };
    if (d.enableHint) entry.enableHint = d.enableHint;
    // Scheduler-only: surface the DURABLE-coverage outcome so an unproven optional source reads as explicitly
    // unavailable (with 0 folded rows) even when its ads_sync_state last succeeded. Admin-safe typed fields
    // only -- coverageUnavailableReason is a typed code, never a raw DB error/secret. Absent for the live
    // route (no sourceCoverage), so its parity payload is unchanged.
    const cov = coverageByKey.get(d.syncKey);
    if (cov) {
      entry.coverageProven = cov.proven === true;
      entry.coverageFolded = cov.folded === true;
      entry.coverageStatus = cov.proven === true ? "validated" : "unavailable";
      // A proven source has no reason; an unproven one is normalized to an ALLOWLISTED safe code (or the fixed
      // fallback) so a raw DB/HTTP/credential string from a miswired/injected loader can never be persisted.
      entry.coverageUnavailableReason = cov.proven === true ? null : normalizePpcCoverageReason(cov.reason);
    }
    return entry;
  });

  return {
    accountId,
    asOf,
    window: { from, to: asOf, days: windowDays },
    adsSourceOrigin: PPC_ADS_SOURCE_ORIGIN,
    minClicksForWaste,
    adsRowCount: rows.length,
    latestMetricDate,
    sourceAvailability,
    totalSales,
    totalSalesUnavailable: totalSalesReason,
    totalSalesSourceLabel,
    totalSalesLagDays,
    currencies,
    daily,
    campaigns,
    asins,
    targets,
    searchTerms,
    catalogBrands: catalog.catalogBrands,
  };
}

// ---- Listing & Search Optimizer cores -----------------------------------------------------
//
// Verbatim PURE transcription of the post-fetch folds in lib/server/reports/listing-optimizer.js
// (buildListingOptimizer), operating on ALREADY-SAVED source rows instead of DataDoe exports, so this
// leaf keeps its ZERO DataDoe/Supabase/network import boundary. For VALID inputs the payload is
// byte-identical to buildListingOptimizer for the same rows. It ADDS fail-closed strictness the live
// route never needs (it never sees a malformed export): a present-but-non-finite SQP count/rank/price, a
// malformed (non-string) median-price currency, or a (ASIN, query) group whose positive-price rows span
// more than one currency THROWS (=> derive-invalid => zero snapshot writes => last-known-good preserved),
// instead of coercing to 0 / silently keeping the first currency.

// A plain finite DECIMAL numeric string (optional sign, integer/fraction, optional exponent). Deliberately
// NARROWER than Number(): it rejects hex/octal/binary ("0x10"), "Infinity"/"NaN", grouped digits ("1,000")
// and other junk that Number() would silently coerce. Whitespace is trimmed by the caller before testing.
const FINITE_DECIMAL_STRING = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

// Strict finite extractor for SQP evidence. Absent (null/undefined/"") folds to 0 exactly like the live
// `num`, so every VALID row stays byte-identical. Every PRESENT value must be a finite number OR a
// syntactically valid finite numeric string; anything else is REJECTED (the live `num` would coerce it):
//   - a boolean (Number(true) === 1), an array (Number([]) === 0, Number([5]) === 5), an object, a symbol,
//     a bigint, a function -> rejected by type;
//   - NaN / Infinity / -Infinity -> rejected as non-finite;
//   - a whitespace-only string (Number("  ") === 0) or any non-decimal string -> rejected.
function optFiniteNum(value, label) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} is not a finite number; snapshot blocked (invalid).`);
    }
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") {
      throw new Error(`${label} is a whitespace-only string, not a number; snapshot blocked (invalid).`);
    }
    if (!FINITE_DECIMAL_STRING.test(trimmed)) {
      throw new Error(`${label} is not a valid finite numeric string; snapshot blocked (invalid).`);
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) {
      throw new Error(`${label} is not a finite number; snapshot blocked (invalid).`);
    }
    return n;
  }
  // boolean / object / array / symbol / bigint / function: never a valid numeric evidence value.
  throw new Error(`${label} is not a finite number or numeric string (got ${typeof value}); snapshot blocked (invalid).`);
}

// The faithful sqpAvailable:false snapshot -- byte-identical to buildListingOptimizer's SOURCE_DISABLED
// return: window + the enable hint + the SQP source label, and empty periods/queries/products/brands.
export function listingOptimizerUnavailablePayload({ accountId, asOf, from, lookbackDays, sqpUnavailableReason, sqpSourceLabel }) {
  return {
    accountId: accountId ?? null,
    asOf,
    window: { from, to: asOf, days: lookbackDays },
    sqpAvailable: false,
    sqpUnavailableReason,
    sqpSourceLabel,
    periods: [],
    queries: [],
    products: [],
    catalogBrands: [],
  };
}

// The full faithful payload from validated SQP + catalog rows -- byte-identical to buildListingOptimizer
// for valid inputs, fail-closed on malformed evidence.
export function listingOptimizerPayload({ accountId, asOf, from, lookbackDays, sqpRows, catalogRows, sqpSourceLabel, contentSourceLabel }) {
  // 1) SQP fold: one bucket per (ASIN, query) across the window. Query- + ASIN-level counts are summed; the
  //    best (lowest positive) organic rank is kept; the FIRST positive median click price + its currency is
  //    kept. Blank ASIN/query rows are skipped exactly like the live builder.
  const byKey = new Map();
  const periods = new Set();
  const priceCurrenciesByKey = new Map(); // key -> Set of non-empty currencies among positive-price rows
  const priceUnknownByKey = new Set();    // keys with >=1 positive-price row whose currency is blank/missing
  for (const row of Array.isArray(sqpRows) ? sqpRows : []) {
    const asin = String(row.child_asin || "").trim();
    const query = String(row.search_query || "").trim();
    if (!asin || !query) continue;
    const period = String(row.date || "");
    if (period) periods.add(period);

    const key = `${asin}|${query}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        asin,
        query,
        volume: 0,
        totalImpressions: 0,
        totalClicks: 0,
        totalCartAdds: 0,
        totalPurchases: 0,
        asinImpressions: 0,
        asinClicks: 0,
        asinCartAdds: 0,
        asinPurchases: 0,
        bestRank: null,
        medianClickPrice: null,
        medianClickPriceCurrency: null,
        periodCount: 0,
      };
      byKey.set(key, entry);
    }
    entry.periodCount += 1;
    entry.volume += optFiniteNum(row.search_query_volume, "listing-optimizer search_query_volume");
    entry.totalImpressions += optFiniteNum(row.search_query_total_impression_count, "listing-optimizer search_query_total_impression_count");
    entry.totalClicks += optFiniteNum(row.search_query_total_click_count, "listing-optimizer search_query_total_click_count");
    entry.totalCartAdds += optFiniteNum(row.search_query_total_cart_add_count, "listing-optimizer search_query_total_cart_add_count");
    entry.totalPurchases += optFiniteNum(row.search_query_total_purchase_count, "listing-optimizer search_query_total_purchase_count");
    entry.asinImpressions += optFiniteNum(row.child_asin_impression_count, "listing-optimizer child_asin_impression_count");
    entry.asinClicks += optFiniteNum(row.child_asin_click_count, "listing-optimizer child_asin_click_count");
    entry.asinCartAdds += optFiniteNum(row.child_asin_add_to_cart_count, "listing-optimizer child_asin_add_to_cart_count");
    entry.asinPurchases += optFiniteNum(row.child_asin_purchase_count, "listing-optimizer child_asin_purchase_count");

    const rank = optFiniteNum(row.child_asin_organic_search_rank, "listing-optimizer child_asin_organic_search_rank");
    if (rank > 0) entry.bestRank = entry.bestRank === null ? rank : Math.min(entry.bestRank, rank);

    const price = optFiniteNum(row.child_asin_median_click_price_value, "listing-optimizer child_asin_median_click_price_value");
    if (price > 0) {
      const rawCurrency = row.child_asin_median_click_price_currency;
      if (rawCurrency !== null && rawCurrency !== undefined && typeof rawCurrency !== "string") {
        throw new Error("listing-optimizer child_asin_median_click_price_currency is malformed (not a string); snapshot blocked (invalid).");
      }
      const currency = String(rawCurrency || "").trim();
      if (currency) {
        if (!priceCurrenciesByKey.has(key)) priceCurrenciesByKey.set(key, new Set());
        priceCurrenciesByKey.get(key).add(currency);
      } else {
        // A positive median price with a blank/missing currency is an EXPLICIT UNKNOWN identity, NOT a
        // wildcard that silently adopts a sibling row's currency. Tracking it lets a blank/unknown mixed
        // with any real currency in the same group fail closed below.
        priceUnknownByKey.add(key);
      }
      if (entry.medianClickPrice === null) {
        entry.medianClickPrice = price;
        entry.medianClickPriceCurrency = currency || null;
      }
    }
  }
  // Fail closed on an ambiguous median-price identity within a (ASIN, query) group (the live builder
  // silently keeps the first currency; a scheduled derive must never merge/discard currencies silently). The
  // identity set is the distinct non-empty currencies PLUS an "unknown" identity when any positive-price row
  // had a blank/missing currency, so USD+EUR, blank+USD and blank+EUR all fail, while USD-only, blank-only
  // and blank+blank stay a single identity.
  const ambiguousKeys = new Set([...priceCurrenciesByKey.keys(), ...priceUnknownByKey]);
  for (const key of ambiguousKeys) {
    const currencies = priceCurrenciesByKey.get(key) || new Set();
    const identities = currencies.size + (priceUnknownByKey.has(key) ? 1 : 0);
    if (identities > 1) {
      const entry = byKey.get(key);
      const shown = [...currencies].sort();
      if (priceUnknownByKey.has(key)) shown.push("(unknown)");
      throw new Error(`listing-optimizer (ASIN "${entry.asin}", query "${entry.query}") median click prices span more than one currency identity (${shown.join(", ")}); a single median price must not merge currencies. Snapshot blocked (invalid).`);
    }
  }

  // 2) Catalog products: dedup by ASIN (first wins); bullets (blank dropped), bounded 2,000-char
  //    description, image presence, BSR (num||null, byte-identical to the builder), brand ("Unassigned"
  //    when blank). catalogBrands = distinct NON-EMPTY trimmed product_brand (INCLUDING a literal
  //    "Unassigned"), byte-identical to the builder's `brands` set (NOT catalogBrandNames).
  const products = [];
  const brands = new Set();
  const seen = new Set();
  for (const row of Array.isArray(catalogRows) ? catalogRows : []) {
    const asin = String(row.child_asin || "").trim();
    if (!asin || seen.has(asin)) continue;
    seen.add(asin);
    const brand = String(row.product_brand || "").trim();
    if (brand) brands.add(brand);
    const bullets = [1, 2, 3, 4, 5]
      .map((index) => String(row[`product_bullet_point_${index}`] || "").trim())
      .filter(Boolean);
    products.push({
      asin,
      name: String(row.product_name || "").trim() || null,
      brand: brand || "Unassigned",
      category: String(row.product_root_category_name || "").trim() || null,
      bestSellerRank: num(row.product_root_best_selling_rank) || null,
      bullets,
      description: String(row.product_description || "").trim().slice(0, 2000) || null,
      hasImage: Boolean(String(row.product_image_url || "").trim()),
    });
  }

  const sortedPeriods = [...periods].sort();
  return {
    accountId: accountId ?? null,
    asOf,
    window: { from, to: asOf, days: lookbackDays },
    sqpAvailable: true,
    sqpSourceLabel,
    contentSourceLabel,
    periods: sortedPeriods,
    periodCount: sortedPeriods.length,
    queries: [...byKey.values()],
    products,
    catalogBrands: [...brands].sort((a, b) => a.localeCompare(b)),
  };
}
