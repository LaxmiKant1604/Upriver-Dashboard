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
