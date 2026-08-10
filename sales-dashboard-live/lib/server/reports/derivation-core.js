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
