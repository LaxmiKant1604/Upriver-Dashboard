// Scheduler v2 Phase 1d -- PURE report-calculation cores (no network, no DB).
//
// This is a dependency-free leaf: it imports NOTHING (no DataDoe transport, no Supabase).
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

// Numeric coercion identical to lib/server/datadoe.js `num` (Number(v) || 0), kept local so
// this leaf pulls in no transport module.
export const num = (v) => Number(v) || 0;

// Dashboard / brand-sales: join catalog brand onto the compact date/ASIN Order-Line-Items
// export and fold to date/brand totals. A zero-priced group with units is preserved as
// `unpriced_units` (an upstream completeness signal), never silently dropped. total_orders
// stays null because a compact ASIN export cannot dedupe order ids across ASINs.
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
      unpriced_units: 0,
      total_orders: null,
    };
    const sales = num(row.total_sales_sum ?? row.item_price_value);
    const units = num(row.total_units_sold_sum ?? row.quantity);
    current.total_sales += sales;
    current.total_units_sold += units;
    if (sales === 0 && units > 0) current.unpriced_units += units;
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
    total_sales: num(row.total_sales_sum ?? row.total_sales),
    total_units: num(row.total_units_sum ?? row.total_units),
  }));
}

// Verbatim copy of api/datadoe.js normalizeAdRows.
export function normalizeAdRows(rows) {
  return rows.map((row) => ({
    ...row,
    ad_sales: num(row.ad_sales_sum ?? row.ad_sales),
    ad_spend: num(row.ad_spend_sum ?? row.ad_spend),
    ad_clicks: num(row.ad_clicks_sum ?? row.ad_clicks),
  }));
}

// Verbatim copy of api/datadoe.js dailyRowsForBrand (first catalog brand per ASIN wins).
export function dailyRowsForBrand(rows, catalogRows, brand) {
  const brandByAsin = new Map();
  for (const catalogRow of catalogRows) {
    const asin = String(catalogRow.child_asin || "").trim();
    const productBrand = String(catalogRow.product_brand || "").trim();
    if (asin && productBrand && !brandByAsin.has(asin)) brandByAsin.set(asin, productBrand);
  }
  const totals = new Map();
  for (const row of rows) {
    if (brandByAsin.get(String(row.child_asin || "").trim()) !== brand) continue;
    const key = `${row.seller_or_vendor_id}|${row.date}`;
    const current = totals.get(key) || {
      date: row.date,
      seller_or_vendor_id: row.seller_or_vendor_id,
      total_sales: 0,
      total_units: 0,
      total_units_sold: 0,
    };
    current.total_sales += num(row.total_sales_sum ?? row.total_sales);
    current.total_units += num(row.total_units_sum ?? row.total_units);
    current.total_units_sold = current.total_units;
    totals.set(key, current);
  }
  return [...totals.values()];
}

// Verbatim copy of api/datadoe.js mergeSalesAndAds. Operates on a FRESH array (never mutates the
// caller's rows) but produces byte-identical output to the route (which mutates + returns).
export function mergeSalesAndAds(salesRows, adRows) {
  const out = salesRows.slice();
  const firstByKey = new Map();
  for (const r of out) {
    const key = `${r.seller_or_vendor_id}|${r.date}`;
    if (!firstByKey.has(key)) firstByKey.set(key, r);
  }
  for (const a of adRows) {
    const key = `${a.seller_or_vendor_id}|${a.date}`;
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

// Scheduler-only roll-up: the browser's compact all-brand export groups the SAME Sales & Traffic
// source by [date, seller_or_vendor_id] with the SAME aggregations, so it is a strict roll-up of
// the ASIN/day superset (grouped by [date, seller_or_vendor_id, child_asin]). Summing the superset
// over child_asin per (date, seller) reproduces the exact compact export rows
// ({date, seller_or_vendor_id, total_sales_sum, total_units_sum}) in first-seen order. This is the
// ONLY new fold (there is no standalone production function for it: the route uses the server-side
// grouped export). It is proven equal to the production compact calculation in the parity harness.
export function rollupSupersetToDaily(supersetRows) {
  const byKey = new Map();
  for (const row of supersetRows) {
    const key = `${row.date}|${row.seller_or_vendor_id}`;
    const current = byKey.get(key) || {
      date: row.date,
      seller_or_vendor_id: row.seller_or_vendor_id,
      total_sales_sum: 0,
      total_units_sum: 0,
    };
    current.total_sales_sum += num(row.total_sales_sum ?? row.total_sales);
    current.total_units_sum += num(row.total_units_sum ?? row.total_units);
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
    return { rows: dailyRowsForBrand(supersetRows, catalogRows, brand), brandFiltered: true };
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

// Sum per-ASIN units for one grouped Sales & Traffic window (verbatim of planAsinUnits's fold).
// Returns a Map(asin -> units) in first-seen row order (child_asin ASC as saved), so downstream
// ASIN ordering matches the route exactly.
export function foldPlanAsinUnits(rows) {
  const byAsin = new Map();
  for (const r of rows || []) {
    const asin = String(r.child_asin || "").trim();
    if (!asin) continue;
    byAsin.set(asin, (byAsin.get(asin) || 0) + num(r.units_sum ?? r.total_units));
  }
  return byAsin;
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
      available: 0, fcTransfer: 0, fcProcessing: 0,
      inboundShipped: 0, inboundReceived: 0, inboundWorking: 0,
    });
    cur.available += num(r.available);
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

  // 5) AWD available (US only), folded SKU->ASIN.
  const awdByAsin = {};
  let awdAvailable = false;
  if (isUS) {
    const rows = awdRows || [];
    awdAvailable = rows.length > 0;
    for (const r of rows) {
      const asin = String(r.child_asin || "").trim();
      if (!asin) continue;
      awdByAsin[asin] = (awdByAsin[asin] || 0) + num(r.awd_available_distributable_quantity);
      const sku = String(r.sku || "").trim();
      if (sku) (skusByAsin[asin] || (skusByAsin[asin] = new Set())).add(sku);
    }
  }

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
    const invTotal = inv
      ? inv.available + inv.fcTransfer + inv.fcProcessing + inv.inboundShipped + inv.inboundReceived + inv.inboundWorking
      : 0;
    const awdUnits = isUS ? num(awdByAsin[asin]) : 0;
    if (salesTotal <= 0 && invTotal <= 0 && awdUnits <= 0) continue;
    // Subtract the FC-transfer/inbound-shipped overlap Amazon exposes only as Inbound.
    const adjustedFcTransfer = inv ? Math.max(0, inv.fcTransfer - inv.inboundShipped) : 0;
    rows.push({
      asin,
      productName: nameByAsin.get(asin) || invProductName.get(asin) || null,
      brand: brandByAsin.get(asin) || null,
      sku: skus[0] || null,
      unitsByMonth,
      mtdUnits,
      // FBA fields are null ONLY when the whole snapshot is unavailable; when the snapshot exists
      // but this ASIN is absent, it genuinely holds no FBA stock (0).
      fbaAvailable: inventoryAvailable ? num(inv?.available) : null,
      reservedFcTransfer: inventoryAvailable ? adjustedFcTransfer : null,
      reservedFcProcessing: inventoryAvailable ? num(inv?.fcProcessing) : null,
      inboundShipped: inventoryAvailable ? num(inv?.inboundShipped) : null,
      inboundReceived: inventoryAvailable ? num(inv?.inboundReceived) : null,
      inboundWorking: inventoryAvailable ? num(inv?.inboundWorking) : null,
      awdAvailable: isUS ? awdUnits : null,
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
          sales: 0, units: 0, pageViews: 0,
          buyBoxWeighted: 0, buyBoxWeight: 0, buyBoxSum: 0, buyBoxDays: 0, daysWithSales: 0,
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

      const sales = num(row.total_sales);
      const units = num(row.total_units_sold);
      const pageViews = num(row.page_views);
      entry.sales += sales;
      entry.units += units;
      entry.pageViews += pageViews;
      if (sales !== 0 || units !== 0) entry.daysWithSales += 1;

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
 * Full Buy Box Loss payload, byte-identical to buildBuyBoxLoss() for the same saved rows. Excludes SKUs
 * with no sales/units and SKUs with no observed buy-box data; page-view-weighted share with an
 * unweighted-mean fallback; price/stock evidence null when the snapshot did not carry the SKU. Pure.
 */
export function buyBoxLossPayload({
  accountId, asOf, from, windowDays, sliceDays, sourceLabel, priceSourceLabel,
  dailySliceRows, inventoryRows, catalogRows,
}) {
  const daily = buyBoxDailyFold(dailySliceRows);
  const inventory = buyBoxInventoryFold(inventoryRows);
  // The shared common-insight catalog fold (child_asin -> { name, brand, parentAsin }); identical to
  // common.js fetchCatalog, so Buy Box + Sales Movers + other insight reports share one catalog identity.
  const catalog = salesMoversCatalogFold(catalogRows);

  const rows = [];
  const currencies = new Set();
  for (const entry of daily.bySku.values()) {
    // Only SKUs that actually sold in the window can have revenue at risk.
    if (entry.units <= 0 && entry.sales <= 0) continue;
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
      sales: entry.sales,
      units: entry.units,
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
