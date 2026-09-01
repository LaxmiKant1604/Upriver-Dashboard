// Returns & Refund Leakage -- source-refresh transforms + batching + token plan (PURE; offline-testable).
//
// The dedicated Returns cycle fetches exactly TWO DataDoe exports per <=5-seller batch:
//   1. Returns (FBA & FBM)        -- RAW grain (one row = one returned item; there is no trustworthy quantity column,
//                                    so we COUNT rows, never multiply). 60-day window.
//   2. Settlements & P&L          -- GROUPED by (seller, date, sku, child_asin, currency, settlement_type) so the
//                                    money export stays compact over its window. 21-day daily / from 2026-07-01 initial.
// Order Line Items + Product Catalog are REUSED from their existing durable homes (ZERO returns-owned exports).
//
// This module turns those raw/grouped export rows into the durable per-account window payloads the atomic-replace RPCs
// consume, and owns the batching + token math. Currency is required on settlement money (no money without a currency);
// nulls stay null; nothing is fabricated. No transport, no DB -- pure.

import { addDaysStr } from "../datadoe.js";

// The earliest settlement history we build (task floor). Returns has only ~60 days upstream, so its floor is the
// 60-day window start, never earlier than this.
export const SETTLEMENT_HISTORY_FLOOR = "2026-07-01";
export const RETURNS_WINDOW_DAYS = 60;
export const SETTLEMENT_DAILY_WINDOW_DAYS = 21;

// Per-source token cost (standard/defaultDataset export) and the per-bucket run ceilings (task contract).
export const RETURNS_TOKENS_PER_EXPORT = 2;
export const RETURNS_SOURCES_PER_BATCH = 2; // Returns + Settlements
export const RETURNS_BUCKET_TOKEN_CEILING = { us: 8, "non-us": 20 };
export const MAX_SELLERS_PER_BATCH = 5;

// Raw Returns columns (one row per returned item).
export const RETURNS_SOURCE_COLUMNS = [
  "seller_or_vendor_id", "marketplace_country_code", "date", "sku", "child_asin",
  "amazon_return_reason", "amazon_fulfillment_channel", "amazon_return_request_status",
  "amazon_return_label_to_be_paid_by", "amazon_return_refunded_amount", "amazon_return_label_cost",
  "amazon_return_detailed_disposition", "cogs_total_value",
];

// Settlements: grouped money export. seller_or_vendor_id is in the group so a multi-seller batch splits by account.
export const SETTLEMENT_GROUP_BY = ["seller_or_vendor_id", "date", "sku", "child_asin", "currency", "settlement_type"];
export const SETTLEMENT_AGGREGATIONS = [
  { column: "quantity", aggregation: "sum", alias: "quantity_sum" },
  { column: "item_price", aggregation: "sum", alias: "item_price_sum" },
  { column: "refunded_amount", aggregation: "sum", alias: "refunded_amount_sum" },
  { column: "refund_tax", aggregation: "sum", alias: "refund_tax_sum" },
  { column: "refunded_referral_fee", aggregation: "sum", alias: "refunded_referral_fee_sum" },
  { column: "refund_commission", aggregation: "sum", alias: "refund_commission_sum" },
  { column: "refund_restocking_fee", aggregation: "sum", alias: "refund_restocking_fee_sum" },
  { column: "fba_customer_return_per_unit_fee", aggregation: "sum", alias: "fba_return_unit_fee_sum" },
  { column: "fba_customer_return_fee", aggregation: "sum", alias: "fba_return_fee_sum" },
  { column: "customer_return_hrr_unit_fee", aggregation: "sum", alias: "hrr_unit_fee_sum" },
  { column: "cogs_total_value", aggregation: "sum", alias: "cogs_sum" },
];

const S = (v) => (v == null ? "" : String(v));
const N = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const isCode = (v) => /^[A-Z]{3}$/.test(S(v).trim());

// The Returns window: [asOf-59, asOf], floored at the settlement floor (returns never proves earlier).
export function returnsWindow(asOf) {
  const from = addDaysStr(asOf, -(RETURNS_WINDOW_DAYS - 1));
  return { from: from < SETTLEMENT_HISTORY_FLOOR ? SETTLEMENT_HISTORY_FLOOR : from, to: asOf };
}

// The Settlement window: DAILY [asOf-20, asOf] once history already reaches the daily start; otherwise the INITIAL
// backfill [2026-07-01, asOf] (one export, not sliced). `earliestCovered` is the min settlement_date already durable
// for the account (null = none yet).
export function settlementWindow(asOf, earliestCovered = null) {
  const dailyFrom = addDaysStr(asOf, -(SETTLEMENT_DAILY_WINDOW_DAYS - 1));
  const haveDailyStart = typeof earliestCovered === "string" && earliestCovered <= dailyFrom;
  const from = haveDailyStart ? dailyFrom : SETTLEMENT_HISTORY_FLOOR;
  return { from, to: asOf, mode: haveDailyStart ? "daily" : "initial" };
}

// Stable <=5-seller batches for ONE bucket's accounts (accounts MUST already be a single bucket -- never mixed).
// Deterministic order (by accountId) so the same roster always yields the same batches (cache/idempotency stability).
export function planReturnsBatches(accounts) {
  const ids = [...new Set((Array.isArray(accounts) ? accounts : []).map((a) => S(a && (a.accountId ?? a.id)).trim()).filter(Boolean))].sort();
  const batches = [];
  for (let i = 0; i < ids.length; i += MAX_SELLERS_PER_BATCH) batches.push(ids.slice(i, i + MAX_SELLERS_PER_BATCH));
  return batches;
}

// Token plan for a set of batches that WILL be fetched (batches already covered are excluded upstream).
export function returnsTokenPlan(batchesToFetch) {
  const n = Math.max(0, Number(batchesToFetch) || 0);
  const creates = n * RETURNS_SOURCES_PER_BATCH;
  return { batches: n, creates, tokens: creates * RETURNS_TOKENS_PER_EXPORT };
}

// Aggregate one account's RAW Returns rows into durable window payloads. One returned item = one row (count), grouped
// by the durable grain. FBM-only refunded amount is summed (abs) for all rows; the seller-borne label cost is summed
// (abs) ONLY when the label payer is the seller. Rows outside [from,to] or for another seller are dropped fail-closed.
export function aggregateReturnsForAccount({ rows, accountId, sellerOrVendorId, marketplaceCountryCode = "", from, to, sourceRequestHash, refreshedAt = null }) {
  const seller = S(sellerOrVendorId || accountId).trim();
  const byKey = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (S(r.seller_or_vendor_id).trim() !== seller) continue;
    const date = S(r.date).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < from || date > to) continue;
    const sku = S(r.sku).trim();
    const asin = S(r.child_asin).trim();
    const reason = S(r.amazon_return_reason).trim();
    const channel = S(r.amazon_fulfillment_channel).trim();
    const status = S(r.amazon_return_request_status).trim();
    const payer = S(r.amazon_return_label_to_be_paid_by).trim();
    const key = [date, sku, asin, reason, channel, status, payer].join("");
    const entry = byKey.get(key) || {
      return_date: date, sku, child_asin: asin, amazon_return_reason: reason, fulfillment_channel: channel,
      request_status: status, label_payer: payer, detailed_disposition: "",
      return_count: 0, fbm_refunded_amount: 0, fbm_seller_label_cost: 0, cogs_total_value: 0,
    };
    entry.return_count += 1;
    entry.fbm_refunded_amount += Math.abs(N(r.amazon_return_refunded_amount));
    if (/seller/i.test(payer)) entry.fbm_seller_label_cost += Math.abs(N(r.amazon_return_label_cost));
    entry.cogs_total_value += Math.abs(N(r.cogs_total_value));
    const disp = S(r.amazon_return_detailed_disposition).trim();
    if (disp && !entry.detailed_disposition) entry.detailed_disposition = disp;
    byKey.set(key, entry);
  }
  const stamp = { seller_or_vendor_id: seller, marketplace_country_code: S(marketplaceCountryCode), source_request_hash: S(sourceRequestHash), refreshed_at: refreshedAt };
  return [...byKey.values()].map((e) => ({ ...e, ...stamp }));
}

// Reshape one account's GROUPED Settlement rows into durable window payloads. Keeps only ORDER + REFUND with a valid
// 3-letter currency (no money without a currency). refund_event_count = 1 per grouped REFUND (date,sku,asin,currency).
export function aggregateSettlementsForAccount({ rows, accountId, sellerOrVendorId, marketplaceCountryCode = "", from, to, sourceRequestHash, refreshedAt = null }) {
  const seller = S(sellerOrVendorId || accountId).trim();
  const out = [];
  const g = (row, alias, col) => N(row[alias] ?? row[col]);
  for (const r of Array.isArray(rows) ? rows : []) {
    if (S(r.seller_or_vendor_id).trim() !== seller) continue;
    const date = S(r.date).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < from || date > to) continue;
    const currency = S(r.currency).trim().toUpperCase();
    if (!isCode(currency)) continue; // no monetary identity without a currency -> drop (never fabricate)
    const type = S(r.settlement_type).trim().toUpperCase();
    if (type !== "ORDER" && type !== "REFUND") continue;
    out.push({
      seller_or_vendor_id: seller, marketplace_country_code: S(marketplaceCountryCode),
      settlement_date: date, sku: S(r.sku).trim(), child_asin: S(r.child_asin).trim(), currency, settlement_type: type,
      quantity: g(r, "quantity_sum", "quantity"),
      item_price: g(r, "item_price_sum", "item_price"),
      refunded_amount: g(r, "refunded_amount_sum", "refunded_amount"),
      refund_tax: g(r, "refund_tax_sum", "refund_tax"),
      refunded_referral_fee: g(r, "refunded_referral_fee_sum", "refunded_referral_fee"),
      refund_commission: g(r, "refund_commission_sum", "refund_commission"),
      refund_restocking_fee: g(r, "refund_restocking_fee_sum", "refund_restocking_fee"),
      fba_customer_return_per_unit_fee: g(r, "fba_return_unit_fee_sum", "fba_customer_return_per_unit_fee"),
      fba_customer_return_fee: g(r, "fba_return_fee_sum", "fba_customer_return_fee"),
      customer_return_hrr_unit_fee: g(r, "hrr_unit_fee_sum", "customer_return_hrr_unit_fee"),
      cogs_total_value: g(r, "cogs_sum", "cogs_total_value"),
      refund_event_count: type === "REFUND" ? 1 : 0,
      source_request_hash: S(sourceRequestHash), refreshed_at: refreshedAt,
    });
  }
  return out;
}

// Reshape merged durable OLI rows (mergeOrderedOliHistory output) into the returns ordered-fold shape (the return-rate
// denominator, per currency, following the canonical priced + explicit-zero + pending ordered-unit rule).
export function reshapeOrderedRows(mergedOliRows) {
  return (Array.isArray(mergedOliRows) ? mergedOliRows : []).map((r) => ({
    date: S(r.sale_date ?? r.saleDate),
    child_asin: S(r.child_asin ?? r.childAsin),
    item_price_currency: S(r.currency),
    total_units_sum: N(r.ordered_units ?? r.units),
    total_sales_sum: N(r.sales_amount ?? r.sales),
    product_name: null,
  }));
}
