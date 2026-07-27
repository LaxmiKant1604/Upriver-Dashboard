import React, { useState, useMemo, useEffect, useCallback } from "react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, ComposedChart, Line, PieChart, Pie, Cell, Legend } from "recharts";
import { TrendingUp, TrendingDown, ChevronDown, Info, RefreshCw, AlertTriangle, LayoutDashboard, CalendarRange, Menu, X, PanelLeftClose, PanelLeftOpen, Boxes, Search, ArrowUpDown, ArrowUp, ArrowDown, Download, ReceiptText, Copy, Check, Wallet, BellRing } from "lucide-react";

/* ============================== CONFIG ============================== */
// Approximate FX rates for combining accounts that use different currencies.
// These are static and will drift over time — update periodically, or
// replace with a live FX API call for better accuracy.
const FX = { INR: 1, USD: 94.6, AUD: 65.2, CAD: 66.6, GBP: 118, EUR: 101 };
const FX_AS_OF = "2026-07-01";

const FLAGS = { IN: "🇮🇳", US: "🇺🇸", AU: "🇦🇺", CA: "🇨🇦", UK: "🇬🇧", GB: "🇬🇧", DE: "🇩🇪", FR: "🇫🇷", JP: "🇯🇵", MX: "🇲🇽" };
const SYMBOL = { INR: "₹", USD: "$", AUD: "A$", CAD: "C$", GBP: "£", EUR: "€" };
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* ============================== DATE HELPERS ============================== */
function pad2(n) { return String(n).padStart(2, "0"); }
function todayStr() { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function parts(s) { const [y, m, d] = s.split("-").map(Number); return { y, m, d }; }
function toUTC(s) { const p = parts(s); return Date.UTC(p.y, p.m - 1, p.d); }
function fromUTC(t) { const d = new Date(t); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; }
function addDays(s, n) { return fromUTC(toUTC(s) + n * 86400000); }
function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function monthStart(s) { const p = parts(s); return `${p.y}-${pad2(p.m)}-01`; }
function yearStart(s) { const p = parts(s); return `${p.y}-01-01`; }
function weekStart(s) { const t = toUTC(s); const dow = new Date(t).getUTCDay(); const diff = dow === 0 ? 6 : dow - 1; return fromUTC(t - diff * 86400000); }
function fmtDateHuman(s) { const p = parts(s); return `${MONTH_ABBR[p.m - 1]} ${p.d}, ${p.y}`; }
function fmtRangeLabel(from, to) { return from === to ? fmtDateHuman(from) : `${fmtDateHuman(from)} – ${fmtDateHuman(to)}`; }

function shiftMonthRange(s, deltaYears, deltaMonths) {
  const p = parts(s);
  const total = p.y * 12 + (p.m - 1) + deltaMonths + deltaYears * 12;
  const y = Math.floor(total / 12), m = (((total % 12) + 12) % 12) + 1;
  const day = Math.min(p.d, daysInMonth(y, m));
  return { start: `${y}-${pad2(m)}-01`, end: `${y}-${pad2(m)}-${pad2(day)}` };
}

/* ============================== DAILY REPORT HELPERS ============================== */
// Full calendar month `n` months before the month containing `s` (n=0 -> that month).
function monthBack(s, n) {
  const p = parts(s);
  const total = p.y * 12 + (p.m - 1) - n;
  const y = Math.floor(total / 12), m = (((total % 12) + 12) % 12) + 1;
  return { y, m, from: `${y}-${pad2(m)}-01`, to: `${y}-${pad2(m)}-${pad2(daysInMonth(y, m))}` };
}
// Column set for the daily report: `monthsBack` completed months, the current
// month (MTD, up to `latest`), then the last `days` days ending at `latest`.
function dailyReportColumns(latest, monthsBack, days) {
  const cols = [];
  for (let i = monthsBack; i >= 1; i--) {
    const mb = monthBack(latest, i);
    cols.push({ key: `m${mb.y}-${mb.m}`, group: "month", label: `${MONTH_ABBR[mb.m - 1]} '${String(mb.y).slice(2)}`, from: mb.from, to: mb.to });
  }
  const cur = parts(latest);
  cols.push({ key: "mtd", group: "mtd", label: `${MONTH_ABBR[cur.m - 1]} '${String(cur.y).slice(2)} MTD`, from: monthStart(latest), to: latest });
  for (let d = days - 1; d >= 0; d--) {
    const day = addDays(latest, -d);
    const p = parts(day);
    cols.push({ key: `d${day}`, group: "day", label: `${p.d}-${MONTH_ABBR[p.m - 1]}`, from: day, to: day });
  }
  return cols;
}

// The daily API returns these advertising fields. Keep a few aliases so the
// table stays resilient if DataDoe changes an export field name later.
const AD_SALES_KEYS = ["ad_sales", "advertising_sales", "ppc_sales", "sponsored_products_sales", "attributed_sales"];
const AD_SPEND_KEYS = ["ad_spend", "ad_spends", "advertising_spend", "ppc_spend", "spend", "cost"];
const CLICKS_KEYS = ["clicks", "total_clicks", "ad_clicks"];
function pickNum(row, keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && row[k] !== "") return Number(row[k]) || 0;
  }
  return null;
}

/* ============================== FBA SHIPMENT PLAN HELPERS ============================== */
// Turn one raw per-ASIN plan row + report metadata + the target-coverage input
// into all derived planning metrics. Pure and local, so changing the target or
// filters recomputes instantly without any DataDoe request.
function computePlanRow(r, meta, targetDays) {
  const keys = (meta.months || []).map((m) => m.key);
  const m1 = Number(r.unitsByMonth?.[keys[0]] || 0);
  const m2 = Number(r.unitsByMonth?.[keys[1]] || 0);
  const m3 = Number(r.unitsByMonth?.[keys[2]] || 0);
  const mtdUnits = Number(r.mtdUnits || 0);

  const threeMoAvg = (m1 + m2 + m3) / 3;
  const daysInMonth = Number(meta.currentMonth?.daysInMonth || 0);
  const elapsed = Number(meta.elapsedDays || 0);
  const mtdProjected = elapsed > 0 ? (mtdUnits / elapsed) * daysInMonth : 0;
  const planningAvg = Math.max(threeMoAvg, mtdProjected);
  const dailyRate = daysInMonth > 0 ? planningAvg / daysInMonth : 0;
  const targetUnits = dailyRate * Number(targetDays || 0);

  // Inventory may be unavailable (null) for the whole snapshot; keep planning
  // fields null in that case rather than treating unknown stock as zero.
  const invKnown = r.fbaAvailable !== null && r.fbaAvailable !== undefined;
  const fba = Number(r.fbaAvailable || 0);
  const reserved = Number(r.reservedFcTransfer || 0) + Number(r.reservedFcProcessing || 0);
  const inTransit = Number(r.inboundShipped || 0) + Number(r.inboundReceived || 0);
  const isUS = !!meta.isUS;
  const awd = isUS ? Number(r.awdAvailable || 0) : 0;
  // FBA days cover intentionally uses only physically available FBA units.
  // Reserved, inbound, and AWD stock remain part of the shipment-plan total.
  const mtdDrr = elapsed > 0 ? mtdUnits / elapsed : null;
  const fbaDaysCover = invKnown && mtdDrr && mtdDrr > 0 ? fba / mtdDrr : null;

  const coverage = invKnown ? fba + reserved + inTransit + awd : null;
  const recommended = invKnown ? Math.max(0, Math.ceil(targetUnits - fba - reserved - inTransit - awd)) : null;
  const remark = recommended === null ? null : recommended > 0 ? "Restock" : "OK";

  return {
    asin: r.asin,
    productName: r.productName,
    brand: r.brand,
    sku: r.sku,
    m1, m2, m3, mtdUnits,
    threeMoAvg, mtdProjected, planningAvg, targetUnits,
    fbaAvailable: invKnown ? fba : null,
    mtdDrr,
    fbaDaysCover,
    reserved: invKnown ? reserved : null,
    inTransit: invKnown ? inTransit : null,
    awd: isUS ? (invKnown || r.awdAvailable != null ? awd : null) : null,
    coverage, recommended, remark, invKnown, isUS,
  };
}

function planSearchMatch(row, q) {
  if (!q) return true;
  const hay = `${row.asin || ""} ${row.sku || ""} ${row.productName || ""} ${row.brand || ""}`.toLowerCase();
  return hay.includes(q.toLowerCase());
}

// Sortable columns for the plan table. `get` returns a comparable value; null
// values always sort last regardless of direction.
const PLAN_SORT_ACCESSORS = {
  asin: (r) => r.asin || "",
  productName: (r) => (r.productName || "").toLowerCase(),
  brand: (r) => (r.brand || "").toLowerCase(),
  m1: (r) => r.m1, m2: (r) => r.m2, m3: (r) => r.m3,
  mtdUnits: (r) => r.mtdUnits,
  threeMoAvg: (r) => r.threeMoAvg,
  mtdProjected: (r) => r.mtdProjected,
  planningAvg: (r) => r.planningAvg,
  targetUnits: (r) => r.targetUnits,
  fbaAvailable: (r) => r.fbaAvailable,
  fbaDaysCover: (r) => r.fbaDaysCover,
  reserved: (r) => r.reserved,
  inTransit: (r) => r.inTransit,
  awd: (r) => r.awd,
  coverage: (r) => r.coverage,
  recommended: (r) => r.recommended,
  remark: (r) => r.remark || "",
};

function comparePlanRows(a, b, key, dir) {
  const acc = PLAN_SORT_ACCESSORS[key] || PLAN_SORT_ACCESSORS.recommended;
  const av = acc(a), bv = acc(b);
  const aNull = av === null || av === undefined;
  const bNull = bv === null || bv === undefined;
  if (aNull && bNull) return 0;
  if (aNull) return 1;   // nulls always last
  if (bNull) return -1;
  let cmp;
  if (typeof av === "string" || typeof bv === "string") cmp = String(av).localeCompare(String(bv));
  else cmp = av - bv;
  return dir === "asc" ? cmp : -cmp;
}

// "2026-04" -> "Apr '26"
function monthKeyLabel(key) {
  if (!key) return "";
  const [y, m] = key.split("-").map(Number);
  return `${MONTH_ABBR[m - 1]} '${String(y).slice(2)}`;
}
// Integer / 1-decimal unit formatters; unknown values render as an em dash.
const nInt = (v) => (v === null || v === undefined || !isFinite(v) ? "—" : Math.round(Number(v)).toLocaleString("en-US"));
function csvCell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  // Prevent spreadsheet programs from evaluating a product value as a formula.
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function downloadPlanSpreadsheet(rows, meta, targetDays) {
  const monthLabels = (meta.months || []).map((m) => monthKeyLabel(m.key));
  const targetLabel = `Target Units (${targetDays} Days)`;
  const exportRows = rows.map((row) => ({
    "Product Name": row.productName || "",
    ASIN: row.asin || "",
    SKU: row.sku || "",
    Brand: row.brand || "",
    [monthLabels[0] || "Month 1"]: Math.round(row.m1),
    [monthLabels[1] || "Month 2"]: Math.round(row.m2),
    [monthLabels[2] || "Month 3"]: Math.round(row.m3),
    "MTD Units": Math.round(row.mtdUnits),
    "3M Avg": Math.round(row.threeMoAvg),
    "MTD Projected": Math.round(row.mtdProjected),
    [targetLabel]: Math.round(row.targetUnits),
    "FBA Available": row.fbaAvailable === null ? "" : Math.round(row.fbaAvailable),
    "FBA Days Cover (MTD DRR)": row.fbaDaysCover === null ? "" : Math.round(row.fbaDaysCover),
    Reserved: row.reserved === null ? "" : Math.round(row.reserved),
    "In Transit": row.inTransit === null ? "" : Math.round(row.inTransit),
    ...(meta.isUS ? { "AWD Available": row.awd === null ? "" : Math.round(row.awd) } : {}),
    "Total FBA Inv.": row.coverage === null ? "" : Math.round(row.coverage),
    "Recommended Shipment": row.recommended === null ? "" : Math.round(row.recommended),
    "Stock Remark": row.remark || "",
  }));
  if (exportRows.length === 0) return;
  const headers = Object.keys(exportRows[0]);
  const csv = "\uFEFF" + [headers, ...exportRows.map((row) => headers.map((header) => row[header]))]
    .map((line) => line.map(csvCell).join(","))
    .join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  const account = String(meta.accountName || "account").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
  link.href = url;
  link.download = `fba-shipment-plan-${account || "account"}-${meta.asOf || "report"}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

/* ============================== RECONCILIATION HELPERS ============================== */
function sixFullCalendarMonths(today) {
  const p = parts(today);
  const months = [];
  for (let i = 6; i >= 1; i--) {
    const total = p.y * 12 + (p.m - 1) - i;
    const y = Math.floor(total / 12);
    const m = ((total % 12) + 12) % 12 + 1;
    months.push(`${y}-${pad2(m)}`);
  }
  const first = months[0].split("-").map(Number);
  const last = months[months.length - 1].split("-").map(Number);
  return {
    months,
    from: `${first[0]}-${pad2(first[1])}-01`,
    to: `${last[0]}-${pad2(last[1])}-${pad2(daysInMonth(last[0], last[1]))}`,
  };
}

function reconMonthLabel(key) {
  if (!key) return "";
  const [y, m] = key.split("-").map(Number);
  return `${MONTH_ABBR[m - 1]} ${y}`;
}

function reconMonthOf(date) {
  return String(date || "").slice(0, 7);
}

function isCancelledOrder(status) {
  return /cancel/i.test(String(status || ""));
}

function buildReconciliation(raw, selectedBrand) {
  if (!raw) return { orders: [], settlements: [], allSettlementRows: [], brandScopeIsConservative: false };
  const scopeOrders = (raw.orders || []).flatMap((order) => {
    // `brands` is the compact response shape. Keep the breakdown fallback so
    // a pre-existing cached response from the previous schema stays usable.
    const brands = order.brands || Object.keys(order.brandBreakdown || {});
    if (selectedBrand !== "ALL") {
      // Settlement entries are order-level. Only single-brand orders can be
      // attributed faithfully to a product brand, so omit mixed-brand orders.
      if (brands.length !== 1 || brands[0] !== selectedBrand) return [];
      return [order];
    }
    return [order];
  });
  const scopedIds = new Set(scopeOrders.map((order) => order.orderId));
  const allSettlementRows = selectedBrand === "ALL"
    ? (raw.settlements || [])
    : (raw.settlements || []).filter((settlement) => settlement.orderId && scopedIds.has(settlement.orderId));
  const settlementsByOrder = new Map();
  allSettlementRows.forEach((settlement) => {
    if (!settlement.orderId || !scopedIds.has(settlement.orderId)) return;
    const list = settlementsByOrder.get(settlement.orderId) || [];
    list.push(settlement);
    settlementsByOrder.set(settlement.orderId, list);
  });
  const orders = scopeOrders.map((order) => {
    const settlements = settlementsByOrder.get(order.orderId) || [];
    const orderSettlements = settlements.filter((s) => s.settlementType === "ORDER");
    const refundSettlements = settlements.filter((s) => s.settlementType === "REFUND");
    const hasOrderSettlement = orderSettlements.length > 0;
    const hasRefund = refundSettlements.length > 0;
    const reconciliationStatus = isCancelledOrder(order.status) ? "Cancelled"
      : hasOrderSettlement && hasRefund ? "Settled + Refunded"
      : hasRefund ? "Refunded"
      : hasOrderSettlement ? "Settled" : "Pending";
    const settledRevenue = orderSettlements.reduce((sum, s) => sum + Number(s.settledRevenue || 0), 0);
    const settledTax = orderSettlements.reduce((sum, s) => sum + Number(s.settledTax || 0), 0);
    const fees = settlements.reduce((sum, s) => sum + Number(s.referralFee || 0) + Number(s.fbaFee || 0), 0);
    const refundAmount = refundSettlements.reduce((sum, s) => sum + Math.abs(Number(s.refundedAmount || 0)), 0);
    const netPayout = settlements.reduce((sum, s) => sum + Number(s.netPayout || 0), 0);
    const settlementDate = settlements.reduce((latest, s) => !latest || s.settlementDate > latest ? s.settlementDate : latest, null);
    const crossMonth = Boolean(settlementDate && reconMonthOf(settlementDate) !== reconMonthOf(order.orderDate));
    return {
      ...order, settlements, reconciliationStatus, settledRevenue, settledTax, fees,
      refundAmount, netPayout, settlementDate, crossMonth,
      delta: Number(order.orderRevenue || 0) - settledRevenue,
    };
  });
  return { orders, settlements: allSettlementRows.filter((s) => s.orderId && scopedIds.has(s.orderId)), allSettlementRows, brandScopeIsConservative: selectedBrand !== "ALL" };
}

function reconciliationStatusClass(status) {
  return String(status || "").toLowerCase().replace(/[^a-z]+/g, "-");
}

function downloadReconciliationCsv(rows, currency, scopeLabel) {
  const exportRows = rows.map((row) => ({
    "Order ID": row.orderId,
    "Order Date": row.orderDate,
    "Order Month": reconMonthLabel(reconMonthOf(row.orderDate)),
    Status: row.status,
    Channel: row.fulfillmentChannel,
    B2B: row.isBusiness ? "Yes" : "No",
    Quantity: Math.round(row.quantity || 0),
    "Order Revenue": Number(row.orderRevenue || 0).toFixed(2),
    Tax: Number(row.orderTax || 0).toFixed(2),
    "Recon Status": row.reconciliationStatus,
    "Settlement Date": row.settlementDate || "",
    "Settlement Month": row.settlementDate ? reconMonthLabel(reconMonthOf(row.settlementDate)) : "",
    "Settled Revenue": Number(row.settledRevenue || 0).toFixed(2),
    Fees: Number(row.fees || 0).toFixed(2),
    "Refund Amount": Number(row.refundAmount || 0).toFixed(2),
    "Net Payout": Number(row.netPayout || 0).toFixed(2),
    Delta: Number(row.delta || 0).toFixed(2),
    "Cross Month": row.crossMonth ? `Settled in ${reconMonthLabel(reconMonthOf(row.settlementDate))}` : "No",
    Currency: currency || "",
  }));
  if (!exportRows.length) return;
  const headers = Object.keys(exportRows[0]);
  const csv = "\uFEFF" + [headers, ...exportRows.map((row) => headers.map((header) => row[header]))]
    .map((line) => line.map(csvCell).join(","))
    .join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `amazon-reconciliation-${String(scopeLabel || "account").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

/* ============================== SKU P&L ANALYZER HELPERS ============================== */
// Sum a SKU's per-month buckets for the selected month ("ALL" = all six).
function skuPlScopedTotals(byMonth, month) {
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

// Turn one raw SKU row + the selected month into displayable, recomputed metrics.
// Every ratio is derived here from the summed amounts — ratios are never summed.
function computeSkuPlRow(row, month) {
  const t = skuPlScopedTotals(row.byMonth, month);
  // Margin and the ad ratio are recomputed from sums; null when sales is 0 so an
  // undefined ratio is shown as "—" rather than a misleading number.
  const margin = t.sales > 0 ? (t.profit / t.sales) * 100 : null;
  const adSalesRatio = t.sales > 0 ? (t.adSpend / t.sales) * 100 : null;
  const cogsMissing = t.sales > 0 && t.cogs <= 0;
  return {
    sku: row.sku, asin: row.asin, productName: row.productName, brand: row.brand, currency: row.currency,
    ...t, margin, adSalesRatio, cogsMissing,
    hasActivity: t.sales !== 0 || t.profit !== 0 || t.units !== 0 || t.adSpend !== 0,
  };
}

// Primary status/flag for a computed row, given the scope's blended margin.
// Priority: real loss, then a data-quality COGS warning, then ad-heavy, then
// thin margin, else OK. Each returns one concrete next action.
function skuPlStatus(row, blendedMarginPct) {
  if (row.profit < 0) return { key: "loss", label: "Loss", tone: "bad", action: "Raise price or reduce ad bids; review or discontinue." };
  if (row.cogsMissing) return { key: "cogs", label: "Check COGS", tone: "warn", action: "Verify/fix COGS — profit and margin are overstated until COGS is uploaded." };
  if (row.adSpend > row.profit && row.adSpend > 0) return { key: "ad", label: "Ad-heavy", tone: "warn", action: "Reduce ad bids — ad spend is eating the whole profit." };
  if (row.margin !== null && blendedMarginPct !== null && row.margin < 0.5 * blendedMarginPct) return { key: "thin", label: "Thin margin", tone: "warn", action: "Raise price or cut cost — margin is under half the account average." };
  return { key: "ok", label: "OK", tone: "ok", action: null };
}

function skuPlStatusOptionLabel(key) {
  return { ALL: "All statuses", loss: "Loss", cogs: "Check COGS", ad: "Ad-heavy", thin: "Thin margin", ok: "OK" }[key] || key;
}

function downloadSkuPlCsv(rows, currency, monthLabel, accountName) {
  const exportRows = rows.map((r) => ({
    "Product Name": r.productName || "",
    ASIN: r.asin || "",
    SKU: r.sku || "",
    Brand: r.brand || "",
    Currency: r.currency || "",
    Sales: Number(r.sales || 0).toFixed(2),
    Profit: Number(r.profit || 0).toFixed(2),
    "Margin %": r.margin === null ? "" : r.margin.toFixed(1),
    Units: Math.round(r.units || 0),
    "Total Cost": Number(r.cost || 0).toFixed(2),
    "Amazon Fees": Number(r.fees || 0).toFixed(2),
    "Ad Spend": Number(r.adSpend || 0).toFixed(2),
    COGS: Number(r.cogs || 0).toFixed(2),
    "Ad/Sales %": r.adSalesRatio === null ? "" : r.adSalesRatio.toFixed(1),
    Status: r.status?.label || "",
    "Suggested Action": r.status?.action || "",
  }));
  if (!exportRows.length) return;
  const headers = Object.keys(exportRows[0]);
  const csv = "﻿" + [headers, ...exportRows.map((row) => headers.map((h) => row[h]))]
    .map((line) => line.map(csvCell).join(","))
    .join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  const account = String(accountName || "account").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
  link.href = url;
  link.download = `sku-pl-${account || "account"}-${(monthLabel || "6-months").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${currency || "cur"}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function downloadContentChangesCsv(events, accountName) {
  const exportRows = events.map((event) => ({
    "Event Time": event.eventTime || "",
    "Notification Type": event.notificationType || "",
    ASINs: (event.asins || []).join(" | "),
    Brands: (event.brands || []).join(" | "),
    "Notification ID": event.notificationId || "",
    Metadata: event.metadataPreview || "",
    "Payload Preview": event.payloadPreview || "",
  }));
  if (!exportRows.length) return;
  const headers = Object.keys(exportRows[0]);
  const csv = "\uFEFF" + [headers, ...exportRows.map((row) => headers.map((header) => row[header]))]
    .map((line) => line.map(csvCell).join(","))
    .join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  const account = String(accountName || "account").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
  link.href = url;
  link.download = `content-change-alerts-${account || "account"}-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

/* ============================== NUMBER / MONEY HELPERS ============================== */
function pct(curr, prev) {
  if (prev === 0) return curr === 0 ? 0 : null;
  return ((curr - prev) / prev) * 100;
}
function fmtPct(v) {
  if (v === null || v === undefined || !isFinite(v)) return "—";
  const s = v >= 0 ? "+" : "";
  return `${s}${v.toFixed(1)}%`;
}
function fmtMoney(value, currency, decimals) {
  const d = decimals === undefined ? 0 : decimals;
  const symbol = SYMBOL[currency] || (currency ? currency + " " : "");
  const locale = currency === "INR" ? "en-IN" : "en-US";
  const n = Number(value || 0);
  return symbol + n.toLocaleString(locale, { minimumFractionDigits: d, maximumFractionDigits: d });
}
function compactNumber(v, currency) {
  const sign = v < 0 ? "-" : "";
  v = Math.abs(v);
  if (currency === "INR") {
    if (v >= 1e7) return sign + (v / 1e7).toFixed(1) + "Cr";
    if (v >= 1e5) return sign + (v / 1e5).toFixed(1) + "L";
    if (v >= 1e3) return sign + (v / 1e3).toFixed(1) + "k";
    return sign + v.toFixed(0);
  }
  if (v >= 1e6) return sign + (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return sign + (v / 1e3).toFixed(1) + "k";
  return sign + v.toFixed(0);
}
function fmtMoneyCompact(value, currency) {
  const symbol = SYMBOL[currency] || (currency ? currency + " " : "");
  return symbol + compactNumber(value, currency);
}

/* ============================== SMALL COMPONENTS ============================== */
function DeltaIcon({ value }) {
  if (value === null || value === undefined) return <span>—</span>;
  if (value > 0) return <TrendingUp size={15} />;
  if (value < 0) return <TrendingDown size={15} />;
  return <span>•</span>;
}
function deltaClass(value) {
  if (value === null || value === undefined) return "flat";
  if (value > 0) return "up";
  if (value < 0) return "down";
  return "flat";
}

function CompareChip({ label, note, data }) {
  if (!data) return null;
  if (data.insufficient) {
    return (
      <div className="compare-chip">
        <div className="clabel">{label}</div>
        <div className="cval flat"><Info size={14} /> —</div>
        <div className="cnote">Not enough history yet</div>
      </div>
    );
  }
  const v = data.value;
  const label2 = v === null ? (data.curr > 0 ? "New" : "—") : fmtPct(v);
  return (
    <div className="compare-chip">
      <div className="clabel">{label}</div>
      <div className={"cval " + deltaClass(v)}>
        <DeltaIcon value={v} /> {label2}
      </div>
      <div className="cnote">{note}</div>
    </div>
  );
}

function BreakdownPanel({ title, items, activeKeys, currency }) {
  const max = items.length ? items[0].value : 0;
  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-title">{title}</div>
      </div>
      <div className="bar-list">
        {items.length === 0 && <div className="empty-note">No data for this period.</div>}
        {items.map((it) => (
          <div className={"bar-row" + (activeKeys.has(it.key) ? " active" : "")} key={it.key}>
            <div className="rlabel" title={it.label}>{it.flag ? it.flag + " " : ""}{it.label}</div>
            <div className="bar-track">
              <div className={"bar-fill" + (activeKeys.has(it.key) ? " active" : "")} style={{ width: (max ? (it.value / max) * 100 : 0) + "%" }} />
            </div>
            <div className="rvalue mono">{fmtMoneyCompact(it.value, currency)} <span style={{ color: "var(--ink-soft)", fontWeight: 500 }}>· {it.share.toFixed(1)}%</span></div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============================== DATA LAYER ============================== */
async function apiGet(params) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`/api/datadoe?${qs}`);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `Request failed (${r.status})`);
  return body;
}

const API_CACHE_PREFIX = "upriver:datadoe:v1:";
const LARGE_CACHE_DB = "upriver-report-cache";
const LARGE_CACHE_STORE = "responses";

function apiCacheKey(params) {
  const qs = new URLSearchParams();
  Object.keys(params).sort().forEach((key) => qs.set(key, params[key]));
  return API_CACHE_PREFIX + qs.toString();
}

function readApiCache(params) {
  try {
    const raw = window.localStorage.getItem(apiCacheKey(params));
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

// Brand names are catalog metadata and remain valid across report-cache
// versions. Reuse cached catalog-bearing responses for the selected account so
// the header selector is usable before that account's next manual refresh.
function readCachedCatalogBrands(accountId) {
  if (!accountId) return [];
  try {
    const brands = new Set();
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(API_CACHE_PREFIX)) continue;
      const params = new URLSearchParams(key.slice(API_CACHE_PREFIX.length));
      if (params.get("ids") !== accountId) continue;
      const cached = JSON.parse(window.localStorage.getItem(key) || "{}");
      (cached.body?.catalogBrands || []).forEach((brand) => brands.add(brand));
    }
    return [...brands].sort((a, b) => a.localeCompare(b));
  } catch (e) {
    return [];
  }
}

function writeApiCache(params, body) {
  const cachedAt = Date.now();
  try {
    window.localStorage.setItem(apiCacheKey(params), JSON.stringify({ body, cachedAt }));
  } catch (e) {
    // Storage can be full or blocked; keep the dashboard usable even then.
  }
  return cachedAt;
}

async function cachedApiGet(params, { force = false } = {}) {
  if (!force) {
    const cached = readApiCache(params);
    if (cached) return { ...cached, fromCache: true };
  }
  const body = await apiGet(params);
  return { body, cachedAt: writeApiCache(params, body), fromCache: false };
}

// Order-level reconciliation data can be much larger than a browser's
// localStorage quota. Store that report in IndexedDB so cache-first remains
// reliable for large accounts; localStorage remains a fallback for browsers
// where IndexedDB is unavailable or blocked.
function openLargeCache() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error("IndexedDB is unavailable")); return; }
    const request = window.indexedDB.open(LARGE_CACHE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(LARGE_CACHE_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function readLargeApiCache(params) {
  const key = apiCacheKey(params);
  try {
    const db = await openLargeCache();
    const cached = await new Promise((resolve, reject) => {
      const request = db.transaction(LARGE_CACHE_STORE, "readonly").objectStore(LARGE_CACHE_STORE).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return cached || readApiCache(params);
  } catch (e) {
    return readApiCache(params);
  }
}
async function writeLargeApiCache(params, body) {
  const cachedAt = Date.now();
  const key = apiCacheKey(params);
  try {
    const db = await openLargeCache();
    await new Promise((resolve, reject) => {
      const request = db.transaction(LARGE_CACHE_STORE, "readwrite").objectStore(LARGE_CACHE_STORE).put({ body, cachedAt }, key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    db.close();
    return cachedAt;
  } catch (e) {
    return writeApiCache(params, body);
  }
}
async function cachedLargeApiGet(params, { force = false } = {}) {
  if (!force) {
    const cached = await readLargeApiCache(params);
    if (cached) return { ...cached, fromCache: true };
  }
  const body = await apiGet(params);
  return { body, cachedAt: await writeLargeApiCache(params, body), fromCache: false };
}

/* ============================== MAIN APP ============================== */
export default function App() {
  const [accounts, setAccounts] = useState([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountsError, setAccountsError] = useState(null);

  const [rows, setRows] = useState([]);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [rowsError, setRowsError] = useState(null);
  const [lastFetchedAt, setLastFetchedAt] = useState(null);
  const [catalogBrands, setCatalogBrands] = useState([]);
  const [catalogBrandsAccountId, setCatalogBrandsAccountId] = useState(null);

  const [selectedAccountId, setSelectedAccountId] = useState(null);
  const [selectedBrand, setSelectedBrand] = useState("ALL");
  const [rangePreset, setRangePreset] = useState("30D");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [granularity, setGranularity] = useState("D");

  // Sidebar shell state: `collapsed` = desktop icon-only mode; `mobileOpen` = drawer open on small screens.
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  // Which section is showing: the main dashboard or the Daily Reporting view.
  const [view, setView] = useState("dashboard");

  // Every report reads this single account/brand scope from the header.
  const [dailyRows, setDailyRows] = useState([]);
  const [dailyLoading, setDailyLoading] = useState(false);
  const [dailyError, setDailyError] = useState(null);

  // FBA Shipment Plan is cache-first and uses the shared header scope.
  const [planData, setPlanData] = useState(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState(null);
  const [planCachedAt, setPlanCachedAt] = useState(null);
  const [targetDays, setTargetDays] = useState(30);
  const [planSearch, setPlanSearch] = useState("");
  const [planSort, setPlanSort] = useState({ key: "recommended", dir: "desc" });

  // Reconciliation is a six-full-month, cache-first report. Once refreshed,
  // its month selector and Order Explorer operate entirely in the browser.
  const [reconciliationData, setReconciliationData] = useState(null);
  const [reconciliationLoading, setReconciliationLoading] = useState(false);
  const [reconciliationError, setReconciliationError] = useState(null);
  const [reconciliationCachedAt, setReconciliationCachedAt] = useState(null);
  const [reconciliationMonth, setReconciliationMonth] = useState("");
  const [reconciliationMode, setReconciliationMode] = useState("counts");
  const [reconciliationSearch, setReconciliationSearch] = useState("");
  const [reconciliationStatusFilter, setReconciliationStatusFilter] = useState("ALL");
  const [reconciliationReconFilter, setReconciliationReconFilter] = useState("ALL");
  const [reconciliationB2BFilter, setReconciliationB2BFilter] = useState("ALL");
  const [reconciliationCrossMonthFilter, setReconciliationCrossMonthFilter] = useState("ALL");
  const [reconciliationFrom, setReconciliationFrom] = useState("");
  const [reconciliationTo, setReconciliationTo] = useState("");
  const [reconciliationSort, setReconciliationSort] = useState({ key: "orderDate", dir: "desc" });
  const [reconciliationPage, setReconciliationPage] = useState(1);
  const [copiedOrderId, setCopiedOrderId] = useState(null);

  // SKU P&L Analyzer: six-full-month, cache-first report on the shared header
  // scope. Month/currency/search/sort/filter/pagination all run locally.
  const [skuPlData, setSkuPlData] = useState(null);
  const [skuPlLoading, setSkuPlLoading] = useState(false);
  const [skuPlError, setSkuPlError] = useState(null);
  const [skuPlCachedAt, setSkuPlCachedAt] = useState(null);
  const [skuPlMonth, setSkuPlMonth] = useState("");
  const [skuPlCurrency, setSkuPlCurrency] = useState("");
  const [skuPlSearch, setSkuPlSearch] = useState("");
  const [skuPlStatusFilter, setSkuPlStatusFilter] = useState("ALL");
  const [skuPlSort, setSkuPlSort] = useState({ key: "profit", dir: "desc" });
  const [skuPlPage, setSkuPlPage] = useState(1);

  // Content Change Alerts: cache-first, selected-account-only monitoring of
  // Amazon A+ / branded-item content change notifications.
  const [contentChangesData, setContentChangesData] = useState(null);
  const [contentChangesLoading, setContentChangesLoading] = useState(false);
  const [contentChangesError, setContentChangesError] = useState(null);
  const [contentChangesCachedAt, setContentChangesCachedAt] = useState(null);
  const [contentChangesSearch, setContentChangesSearch] = useState("");
  const [contentChangesType, setContentChangesType] = useState("ALL");

  const TODAY = todayStr();

  const applyAccounts = useCallback((body) => {
    const nextAccounts = body.accounts || [];
    setAccounts(nextAccounts);
    if (nextAccounts.length > 0) {
      setSelectedAccountId((prev) => prev || nextAccounts[0].id);
    }
    setAccountsError(null);
    return nextAccounts;
  }, []);

  const fetchAccounts = useCallback(() => {
    setAccountsLoading(true);
    setAccountsError(null);
    return cachedApiGet({ action: "accounts" }, { force: true })
      .then(({ body }) => applyAccounts(body))
      .catch((err) => {
        setAccountsError(err.message);
        return [];
      })
      .finally(() => setAccountsLoading(false));
  }, [applyAccounts]);

  useEffect(() => {
    const cached = readApiCache({ action: "accounts" });
    if (cached) applyAccounts(cached.body);
    else setAccountsError("No cached account list yet. Click refresh to fetch accounts from DataDoe.");
    setAccountsLoading(false);
  }, [applyAccounts]);

  const accountById = useMemo(() => {
    const m = {};
    accounts.forEach((a) => (m[a.id] = a));
    return m;
  }, [accounts]);

  const dashboardParams = useMemo(() => {
    if (!selectedAccountId) {
      return null;
    }
    // Bump this whenever the backend changes the metric definition so a
    // previously cached report can never be presented as the new one.
    return { action: "brand-sales", reportVersion: "order-items-v2-quality", ids: selectedAccountId, from: addDays(monthStart(TODAY), -420), to: TODAY };
  }, [selectedAccountId, TODAY]);

  const loadCachedRows = useCallback(() => {
    if (!dashboardParams) {
      setRows([]);
      return;
    }
    const cached = readApiCache(dashboardParams);
    if (cached) {
      setRows(cached.body.rows || []);
      setCatalogBrands(cached.body.catalogBrands || []);
      setCatalogBrandsAccountId(selectedAccountId);
      setLastFetchedAt(new Date(cached.cachedAt));
      setRowsError(null);
    } else {
      setRows([]);
      setCatalogBrands([]);
      setCatalogBrandsAccountId(null);
      setLastFetchedAt(null);
      setRowsError("No cached dashboard data for this selection. Click refresh to fetch from DataDoe.");
    }
  }, [dashboardParams]);

  const fetchRows = useCallback(() => {
    if (!dashboardParams) {
      setRows([]);
      setRowsError(accounts.length === 0 ? "No cached accounts yet. Click refresh to fetch accounts first." : null);
      return;
    }
    setRowsLoading(true);
    setRowsError(null);
    cachedApiGet(dashboardParams, { force: true })
      .then(({ body, cachedAt }) => {
        setRows(body.rows || []);
        setCatalogBrands(body.catalogBrands || []);
        setCatalogBrandsAccountId(selectedAccountId);
        setLastFetchedAt(new Date(cachedAt));
      })
      .catch((err) => setRowsError(err.message))
      .finally(() => setRowsLoading(false));
  }, [accounts.length, dashboardParams]);

  useEffect(() => {
    loadCachedRows();
  }, [loadCachedRows]);

  useEffect(() => { setSelectedBrand("ALL"); }, [selectedAccountId]);

  // Daily Reporting fetch: pull ~5 months of single-account history so the
  // report can show 3 completed months + current-month MTD + the last 5 days.
  const dailyParams = useMemo(() => {
    if (!selectedAccountId) return null;
    const mb = monthBack(TODAY, 5);
    return { action: "daily", reportVersion: "daily-brand-v1", ids: selectedAccountId, brand: selectedBrand, from: mb.from, to: TODAY };
  }, [selectedAccountId, selectedBrand, TODAY]);

  const loadCachedDaily = useCallback(() => {
    if (!dailyParams) {
      setDailyRows([]);
      return;
    }
    const cached = readApiCache(dailyParams);
    if (cached) {
      setDailyRows(cached.body.rows || []);
      setLastFetchedAt(new Date(cached.cachedAt));
      setDailyError(null);
    } else {
      setDailyRows([]);
      setDailyError("No cached Daily Reporting data for this account. Click refresh to fetch from DataDoe.");
    }
  }, [dailyParams]);

  const fetchDaily = useCallback(() => {
    if (!dailyParams) return;
    setDailyLoading(true);
    setDailyError(null);
    cachedApiGet(dailyParams, { force: true })
      .then(({ body, cachedAt }) => {
        setDailyRows(body.rows || []);
        setLastFetchedAt(new Date(cachedAt));
      })
      .catch((err) => setDailyError(err.message))
      .finally(() => setDailyLoading(false));
  }, [dailyParams]);

  useEffect(() => {
    if (view === "daily") loadCachedDaily();
  }, [view, loadCachedDaily]);

  // FBA Shipment Plan: cache-first, single selected account, manual refresh only.
  const planParams = useMemo(() => {
    if (!selectedAccountId) return null;
    // Bump reportVersion if the backend metric definition changes so a stale
    // cached report can never be presented as the current one. `to` (the as-of
    // date) is part of the cache key; the target-coverage input is NOT, because
    // it is applied locally and must never trigger a refetch.
    return { action: "fba-plan", reportVersion: "fba-plan-v1", ids: selectedAccountId, to: TODAY };
  }, [selectedAccountId, TODAY]);

  const loadCachedPlan = useCallback(() => {
    if (!planParams) {
      setPlanData(null);
      return;
    }
    const cached = readApiCache(planParams);
    if (cached) {
      setPlanData(cached.body);
      setPlanCachedAt(new Date(cached.cachedAt));
      setPlanError(null);
    } else {
      setPlanData(null);
      setPlanCachedAt(null);
      setPlanError("No cached FBA Shipment Plan for this account. Click refresh to fetch from DataDoe.");
    }
  }, [planParams]);

  const fetchPlan = useCallback(() => {
    if (!planParams) return;
    setPlanLoading(true);
    setPlanError(null);
    cachedApiGet(planParams, { force: true })
      .then(({ body, cachedAt }) => {
        setPlanData(body);
        setPlanCachedAt(new Date(cachedAt));
      })
      .catch((err) => setPlanError(err.message))
      .finally(() => setPlanLoading(false));
  }, [planParams]);

  useEffect(() => {
    if (view === "fbaplan") loadCachedPlan();
  }, [view, loadCachedPlan]);

  const reconciliationWindow = useMemo(() => sixFullCalendarMonths(TODAY), [TODAY]);
  const reconciliationParams = useMemo(() => {
    if (!selectedAccountId) return null;
    return {
      action: "reconciliation", reportVersion: "reconciliation-v2", ids: selectedAccountId,
      from: reconciliationWindow.from, to: reconciliationWindow.to,
    };
  }, [selectedAccountId, reconciliationWindow]);

  const applyReconciliationData = useCallback((body, cachedAt) => {
    setReconciliationData(body);
    setReconciliationCachedAt(new Date(cachedAt));
    setReconciliationMonth((previous) => body.months?.includes(previous) ? previous : body.months?.[body.months.length - 1] || "");
    setReconciliationError(null);
  }, []);

  const loadCachedReconciliation = useCallback(async () => {
    if (!reconciliationParams) {
      setReconciliationData(null);
      return;
    }
    const cached = await readLargeApiCache(reconciliationParams);
    if (cached) applyReconciliationData(cached.body, cached.cachedAt);
    else {
      setReconciliationData(null);
      setReconciliationCachedAt(null);
      setReconciliationError("No cached reconciliation data for this account. Click refresh to fetch six completed months from DataDoe.");
    }
  }, [applyReconciliationData, reconciliationParams]);

  const fetchReconciliation = useCallback(() => {
    if (!reconciliationParams || reconciliationLoading) return;
    setReconciliationLoading(true);
    setReconciliationError(null);
    cachedLargeApiGet(reconciliationParams, { force: true })
      .then(({ body, cachedAt }) => applyReconciliationData(body, cachedAt))
      .catch((err) => setReconciliationError(err.message))
      .finally(() => setReconciliationLoading(false));
  }, [applyReconciliationData, reconciliationLoading, reconciliationParams]);

  useEffect(() => {
    if (view === "reconciliation") loadCachedReconciliation();
  }, [view, loadCachedReconciliation]);

  // SKU P&L Analyzer: six full calendar months, cache-first, shared header scope.
  const skuPlWindow = useMemo(() => sixFullCalendarMonths(TODAY), [TODAY]);
  const skuPlParams = useMemo(() => {
    if (!selectedAccountId) return null;
    return {
      action: "sku-pl", reportVersion: "sku-pl-v1", ids: selectedAccountId,
      from: skuPlWindow.from, to: skuPlWindow.to,
    };
  }, [selectedAccountId, skuPlWindow]);

  const applySkuPlData = useCallback((body, cachedAt, accountCurrency) => {
    setSkuPlData(body);
    setSkuPlCachedAt(new Date(cachedAt));
    // Populate the shared header selector even when this account has not had a
    // dashboard refresh yet. These are only brands present in the P&L scope;
    // any fuller catalog cache remains merged by `brandList`.
    if (body.accountId && Array.isArray(body.catalogBrands)) {
      setCatalogBrands(body.catalogBrands);
      setCatalogBrandsAccountId(body.accountId);
    }
    // Default to the latest completed month; keep the prior choice if still valid.
    setSkuPlMonth((prev) => (body.months?.includes(prev) || prev === "ALL") ? prev : body.months?.[body.months.length - 1] || "ALL");
    // Default currency: the account's own currency if present, else the first.
    const currencies = body.currencies || [];
    setSkuPlCurrency((prev) => currencies.includes(prev) ? prev : (currencies.includes(accountCurrency) ? accountCurrency : currencies[0] || ""));
    setSkuPlPage(1);
    setSkuPlError(null);
  }, []);

  const loadCachedSkuPl = useCallback(async () => {
    if (!skuPlParams) { setSkuPlData(null); return; }
    const cached = await readLargeApiCache(skuPlParams);
    if (cached) applySkuPlData(cached.body, cached.cachedAt, accountById[selectedAccountId]?.currency);
    else {
      setSkuPlData(null);
      setSkuPlCachedAt(null);
      setSkuPlError("No cached SKU P&L for this account. Click refresh to fetch six completed months from DataDoe.");
    }
  }, [applySkuPlData, skuPlParams, accountById, selectedAccountId]);

  const fetchSkuPl = useCallback(() => {
    if (!skuPlParams || skuPlLoading) return;
    setSkuPlLoading(true);
    setSkuPlError(null);
    cachedLargeApiGet(skuPlParams, { force: true })
      .then(({ body, cachedAt }) => applySkuPlData(body, cachedAt, accountById[selectedAccountId]?.currency))
      .catch((err) => setSkuPlError(err.message))
      .finally(() => setSkuPlLoading(false));
  }, [applySkuPlData, skuPlLoading, skuPlParams, accountById, selectedAccountId]);

  useEffect(() => {
    if (view === "skupl") loadCachedSkuPl();
  }, [view, loadCachedSkuPl]);

  // Reset paging when any SKU P&L filter/scope changes (all local, no refetch).
  useEffect(() => { setSkuPlPage(1); }, [skuPlMonth, skuPlCurrency, skuPlSearch, skuPlStatusFilter, selectedBrand]);

  const contentChangesParams = useMemo(() => {
    if (!selectedAccountId) return null;
    return {
      action: "content-changes", reportVersion: "content-changes-v1", ids: selectedAccountId, asOf: TODAY,
    };
  }, [selectedAccountId, TODAY]);

  const applyContentChangesData = useCallback((body, cachedAt) => {
    setContentChangesData(body);
    setContentChangesCachedAt(new Date(cachedAt));
    if (body.accountId && Array.isArray(body.catalogBrands)) {
      setCatalogBrands(body.catalogBrands);
      setCatalogBrandsAccountId(body.accountId);
    }
    setContentChangesError(null);
  }, []);

  const loadCachedContentChanges = useCallback(async () => {
    if (!contentChangesParams) { setContentChangesData(null); return; }
    const cached = await readLargeApiCache(contentChangesParams);
    if (cached) applyContentChangesData(cached.body, cached.cachedAt);
    else {
      setContentChangesData(null);
      setContentChangesCachedAt(null);
      setContentChangesError("No cached Content Change Alerts for this account. Click refresh to fetch notifications from DataDoe.");
    }
  }, [applyContentChangesData, contentChangesParams]);

  const fetchContentChanges = useCallback(() => {
    if (!contentChangesParams || contentChangesLoading) return;
    setContentChangesLoading(true);
    setContentChangesError(null);
    cachedLargeApiGet(contentChangesParams, { force: true })
      .then(({ body, cachedAt }) => applyContentChangesData(body, cachedAt))
      .catch((err) => setContentChangesError(err.message))
      .finally(() => setContentChangesLoading(false));
  }, [applyContentChangesData, contentChangesLoading, contentChangesParams]);

  useEffect(() => {
    if (view === "contentchanges") loadCachedContentChanges();
  }, [view, loadCachedContentChanges]);

  const dailyCurrency = accountById[selectedAccountId]?.currency || "INR";
  const refreshScopeAccount = accountById[selectedAccountId];
  const dailyReport = useMemo(() => {
    // The sales source can emit a newer zero-sales row before its daily data
    // arrives. Anchor to the latest completed sales date, not that placeholder.
    const yesterday = addDays(TODAY, -1);
    const rowsWithSales = dailyRows.filter((r) => Number(r.total_sales) > 0 || Number(r.total_units_sold) > 0);
    let latest = rowsWithSales.reduce((mx, r) => (!mx || r.date > mx ? r.date : mx), null)
      || dailyRows.reduce((mx, r) => (!mx || r.date > mx ? r.date : mx), null)
      || yesterday;
    if (latest > yesterday) latest = yesterday;
    const columns = dailyReportColumns(latest, 3, 5);
    const cells = columns.map((col) => {
      let sales = 0, units = 0, adSales = 0, adSpend = 0, clicks = 0, hasAd = false;
      dailyRows.forEach((r) => {
        if (r.date < col.from || r.date > col.to) return;
        sales += r.total_sales || 0;
        units += r.total_units_sold || 0;
        const as = pickNum(r, AD_SALES_KEYS), sp = pickNum(r, AD_SPEND_KEYS), ck = pickNum(r, CLICKS_KEYS);
        if (as !== null || sp !== null || ck !== null) hasAd = true;
        adSales += as || 0; adSpend += sp || 0; clicks += ck || 0;
      });
      return { sales, units, adSales, adSpend, clicks, hasAd };
    });
    return { latest, columns, cells };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dailyRows]);

  // Derived FBA Shipment Plan: raw rows -> computed metrics -> filter -> sort.
  // Everything here is local, so search/sort/target changes never refetch.
  const planComputed = useMemo(() => {
    if (!planData || !Array.isArray(planData.rows)) return [];
    return planData.rows.map((r) => computePlanRow(r, planData, targetDays));
  }, [planData, targetDays]);

  const planRows = useMemo(() => {
    const filtered = planComputed.filter((r) =>
      (selectedBrand === "ALL" || r.brand === selectedBrand) && planSearchMatch(r, planSearch)
    );
    return [...filtered].sort((a, b) => comparePlanRows(a, b, planSort.key, planSort.dir));
  }, [planComputed, planSearch, planSort, selectedBrand]);

  const planTotals = useMemo(() => {
    const t = { m1: 0, m2: 0, m3: 0, mtdUnits: 0, targetUnits: 0, fbaAvailable: 0, mtdDrr: 0, fbaDaysCover: null, reserved: 0, inTransit: 0, awd: 0, coverage: 0, recommended: 0, restockCount: 0 };
    let anyInv = false, anyAwd = false;
    planRows.forEach((r) => {
      t.m1 += r.m1; t.m2 += r.m2; t.m3 += r.m3; t.mtdUnits += r.mtdUnits;
      t.targetUnits += r.targetUnits;
      if (r.fbaAvailable !== null) {
        anyInv = true;
        t.fbaAvailable += r.fbaAvailable;
        if (r.mtdDrr !== null) t.mtdDrr += r.mtdDrr;
        t.reserved += r.reserved; t.inTransit += r.inTransit; t.coverage += r.coverage;
      }
      if (r.awd !== null) { anyAwd = true; t.awd += r.awd; }
      if (r.recommended !== null) t.recommended += r.recommended;
      if (r.remark === "Restock") t.restockCount += 1;
    });
    t.fbaDaysCover = t.mtdDrr > 0 ? t.fbaAvailable / t.mtdDrr : null;
    t.anyInv = anyInv; t.anyAwd = anyAwd;
    return t;
  }, [planRows]);

  const reconciliationScope = useMemo(
    () => buildReconciliation(reconciliationData, selectedBrand),
    [reconciliationData, selectedBrand]
  );
  const reconInSelectedMonth = useCallback((date) => (
    reconciliationMonth === "ALL" || reconMonthOf(date) === reconciliationMonth
  ), [reconciliationMonth]);
  const reconciliationOrdersForMonth = useMemo(
    () => reconciliationScope.orders.filter((order) => reconInSelectedMonth(order.orderDate)),
    [reconciliationScope.orders, reconInSelectedMonth]
  );
  const reconciliationSettlementsForMonth = useMemo(
    () => reconciliationScope.allSettlementRows.filter((settlement) => reconInSelectedMonth(settlement.settlementDate)),
    [reconciliationScope.allSettlementRows, reconInSelectedMonth]
  );
  const reconciliationMetrics = useMemo(() => {
    const shipped = reconciliationOrdersForMonth.filter((order) => /shipped/i.test(String(order.status)));
    const settledOrders = reconciliationOrdersForMonth.filter((order) => /settled/i.test(order.reconciliationStatus));
    const orderRevenue = reconciliationOrdersForMonth.reduce((sum, order) => sum + Number(order.orderRevenue || 0), 0);
    const settledRevenue = reconciliationOrdersForMonth.reduce((sum, order) => sum + Number(order.settledRevenue || 0), 0);
    const refunded = reconciliationOrdersForMonth.filter((order) => /refunded/i.test(order.reconciliationStatus));
    const refundAmount = reconciliationOrdersForMonth.reduce((sum, order) => sum + Number(order.refundAmount || 0), 0);
    const cancelled = reconciliationOrdersForMonth.filter((order) => isCancelledOrder(order.status));
    const reconciliationRate = shipped.length ? (settledOrders.length / shipped.length) * 100 : null;
    const netPayout = reconciliationSettlementsForMonth.reduce((sum, settlement) => sum + Number(settlement.netPayout || 0), 0);
    return {
      shippedOrders: shipped.length, settledOrders: settledOrders.length, orderGap: shipped.length - settledOrders.length,
      orderRevenue, settledRevenue, revenueGap: orderRevenue - settledRevenue,
      refunds: refunded.length, refundAmount, cancelled: cancelled.length, reconciliationRate, netPayout,
    };
  }, [reconciliationOrdersForMonth, reconciliationSettlementsForMonth]);
  const reconciliationTrend = useMemo(() => (reconciliationData?.months || []).map((month) => {
    const orders = reconciliationScope.orders.filter((order) => reconMonthOf(order.orderDate) === month);
    const shipped = orders.filter((order) => /shipped/i.test(String(order.status))).length;
    const settled = orders.filter((order) => /settled/i.test(order.reconciliationStatus)).length;
    return { month, label: reconMonthLabel(month), shipped, settled };
  }), [reconciliationData, reconciliationScope.orders]);
  const reconciliationDonut = useMemo(() => {
    const groups = [
      ["Settled", "#149B67"], ["Pending", "#E69B28"], ["Cancelled", "#DF5960"], ["Refunded", "#3F84C5"],
    ];
    return groups.map(([label, fill]) => ({ label, fill, value: reconciliationOrdersForMonth.filter((order) => {
      if (label === "Settled") return order.reconciliationStatus === "Settled";
      if (label === "Refunded") return /Refunded/.test(order.reconciliationStatus);
      return order.reconciliationStatus === label;
    }).length }));
  }, [reconciliationOrdersForMonth]);
  const reconciliationWaterfall = useMemo(() => {
    const settlements = reconciliationSettlementsForMonth;
    const gross = settlements.reduce((sum, s) => sum + Number(s.settledRevenue || 0), 0);
    const tax = settlements.reduce((sum, s) => sum + Number(s.settledTax || 0), 0);
    const referral = settlements.reduce((sum, s) => sum + Number(s.referralFee || 0), 0);
    const fba = settlements.reduce((sum, s) => sum + Number(s.fbaFee || 0), 0);
    const refunds = settlements.reduce((sum, s) => sum + Number(s.refundedAmount || 0), 0);
    const net = settlements.reduce((sum, s) => sum + Number(s.netPayout || 0), 0);
    return [
      { label: "Gross revenue", value: gross, kind: "positive" }, { label: "Tax", value: tax, kind: "positive" },
      { label: "Referral fees", value: referral, kind: "negative" }, { label: "FBA fees", value: fba, kind: "negative" },
      { label: "Refunds", value: refunds, kind: "negative" },
      { label: "Other", value: net - gross - tax - referral - fba - refunds, kind: "negative" },
      { label: "Net payout", value: net, kind: "net" },
    ];
  }, [reconciliationSettlementsForMonth]);
  const reconciliationDaily = useMemo(() => {
    const groups = new Map();
    const keyFor = (date) => reconciliationMonth === "ALL" ? reconMonthOf(date) : date;
    reconciliationScope.orders.forEach((order) => {
      if (!reconInSelectedMonth(order.orderDate)) return;
      const key = keyFor(order.orderDate);
      const current = groups.get(key) || { key, label: reconciliationMonth === "ALL" ? reconMonthLabel(key) : key.slice(8), shipped: 0, settled: 0, refunds: 0, orderRevenue: 0, settledRevenue: 0 };
      if (/shipped/i.test(String(order.status))) current.shipped += 1;
      current.orderRevenue += Number(order.orderRevenue || 0);
      groups.set(key, current);
    });
    reconciliationScope.allSettlementRows.forEach((settlement) => {
      if (!reconInSelectedMonth(settlement.settlementDate)) return;
      const key = keyFor(settlement.settlementDate);
      const current = groups.get(key) || { key, label: reconciliationMonth === "ALL" ? reconMonthLabel(key) : key.slice(8), shipped: 0, settled: 0, refunds: 0, orderRevenue: 0, settledRevenue: 0 };
      if (settlement.settlementType === "ORDER") { current.settled += 1; current.settledRevenue += Number(settlement.settledRevenue || 0); }
      if (settlement.settlementType === "REFUND") current.refunds += 1;
      groups.set(key, current);
    });
    return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
  }, [reconciliationMonth, reconciliationScope, reconInSelectedMonth]);
  const reconciliationExplorerRows = useMemo(() => {
    const search = reconciliationSearch.trim().toLowerCase();
    return reconciliationOrdersForMonth.filter((order) => {
      if (reconciliationStatusFilter !== "ALL" && String(order.status) !== reconciliationStatusFilter) return false;
      if (reconciliationReconFilter !== "ALL" && order.reconciliationStatus !== reconciliationReconFilter) return false;
      if (reconciliationB2BFilter !== "ALL" && (order.isBusiness ? "YES" : "NO") !== reconciliationB2BFilter) return false;
      if (reconciliationCrossMonthFilter === "CROSS" && !order.crossMonth) return false;
      if (reconciliationCrossMonthFilter === "SAME" && order.crossMonth) return false;
      if (reconciliationFrom && order.orderDate < reconciliationFrom) return false;
      if (reconciliationTo && order.orderDate > reconciliationTo) return false;
      if (!search) return true;
      return `${order.orderId} ${order.orderDate} ${order.status} ${order.fulfillmentChannel} ${order.reconciliationStatus} ${order.settlementDate || ""}`.toLowerCase().includes(search);
    });
  }, [reconciliationOrdersForMonth, reconciliationSearch, reconciliationStatusFilter, reconciliationReconFilter, reconciliationB2BFilter, reconciliationCrossMonthFilter, reconciliationFrom, reconciliationTo]);
  const reconciliationSortedRows = useMemo(() => [...reconciliationExplorerRows].sort((a, b) => {
    const av = a[reconciliationSort.key], bv = b[reconciliationSort.key];
    const aEmpty = av === null || av === undefined || av === "";
    const bEmpty = bv === null || bv === undefined || bv === "";
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1;
    if (bEmpty) return -1;
    const compare = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
    return reconciliationSort.dir === "asc" ? compare : -compare;
  }), [reconciliationExplorerRows, reconciliationSort]);
  const reconciliationPageCount = Math.max(1, Math.ceil(reconciliationSortedRows.length / 50));
  const reconciliationPageRows = reconciliationSortedRows.slice((reconciliationPage - 1) * 50, reconciliationPage * 50);
  const reconciliationPages = useMemo(() => {
    const pages = new Set([1, reconciliationPageCount, reconciliationPage - 1, reconciliationPage, reconciliationPage + 1]);
    return [...pages].filter((page) => page >= 1 && page <= reconciliationPageCount).sort((a, b) => a - b);
  }, [reconciliationPage, reconciliationPageCount]);

  useEffect(() => { setReconciliationPage(1); }, [reconciliationMonth, reconciliationSearch, reconciliationStatusFilter, reconciliationReconFilter, reconciliationB2BFilter, reconciliationCrossMonthFilter, reconciliationFrom, reconciliationTo, selectedBrand]);

  const setPlanSortKey = useCallback((key) => {
    setPlanSort((prev) => {
      if (prev.key === key) return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
      // Text columns default to ascending; numeric columns to descending.
      const textCols = ["asin", "productName", "brand", "sku", "remark"];
      return { key, dir: textCols.includes(key) ? "asc" : "desc" };
    });
  }, []);

  const displayCurrency = accountById[selectedAccountId]?.currency || "INR";

  /* ===== SKU P&L Analyzer derived data (all local, no refetch) ===== */
  // The effective currency is always a single currency; currencies are never mixed.
  const skuPlCurrencies = skuPlData?.currencies || [];
  const effectiveSkuCurrency = skuPlCurrencies.includes(skuPlCurrency)
    ? skuPlCurrency
    : (skuPlCurrencies.includes(displayCurrency) ? displayCurrency : skuPlCurrencies[0] || displayCurrency);

  // Rows scoped to one currency + the header brand, computed for the selected
  // month, keeping only rows with activity in scope.
  const skuPlComputed = useMemo(() => {
    if (!skuPlData?.rows) return [];
    return skuPlData.rows
      .filter((r) => r.currency === effectiveSkuCurrency)
      .filter((r) => selectedBrand === "ALL" || (r.brand || "Unassigned") === selectedBrand)
      .map((r) => computeSkuPlRow(r, skuPlMonth))
      .filter((r) => r.hasActivity);
  }, [skuPlData, effectiveSkuCurrency, selectedBrand, skuPlMonth]);

  // Blended margin over the whole in-scope set drives the thin-margin leak test.
  const skuPlBlendedMargin = useMemo(() => {
    const sales = skuPlComputed.reduce((s, r) => s + r.sales, 0);
    const profit = skuPlComputed.reduce((s, r) => s + r.profit, 0);
    return sales > 0 ? (profit / sales) * 100 : null;
  }, [skuPlComputed]);

  const skuPlKpis = useMemo(() => {
    const t = skuPlComputed.reduce((acc, r) => {
      acc.sales += r.sales; acc.profit += r.profit; acc.units += r.units;
      acc.cost += r.cost; acc.adSpend += r.adSpend; acc.fees += r.fees; acc.cogs += r.cogs;
      return acc;
    }, { sales: 0, profit: 0, units: 0, cost: 0, adSpend: 0, fees: 0, cogs: 0 });
    t.margin = t.sales > 0 ? (t.profit / t.sales) * 100 : null;
    return t;
  }, [skuPlComputed]);

  // Attach a single status/flag to each row from the blended-margin scope.
  const skuPlRows = useMemo(
    () => skuPlComputed.map((r) => ({ ...r, status: skuPlStatus(r, skuPlBlendedMargin) })),
    [skuPlComputed, skuPlBlendedMargin]
  );

  const skuPlTopProfit = useMemo(
    () => [...skuPlRows].sort((a, b) => b.profit - a.profit).slice(0, 8),
    [skuPlRows]
  );
  const skuPlLeaks = useMemo(
    () => skuPlRows.filter((r) => r.status.key !== "ok")
      .sort((a, b) => a.profit - b.profit)
      .slice(0, 12),
    [skuPlRows]
  );
  const skuPlStatusCounts = useMemo(() => {
    const counts = { loss: 0, cogs: 0, ad: 0, thin: 0, ok: 0 };
    skuPlRows.forEach((r) => { counts[r.status.key] = (counts[r.status.key] || 0) + 1; });
    return counts;
  }, [skuPlRows]);

  const skuPlFiltered = useMemo(() => {
    const q = skuPlSearch.trim().toLowerCase();
    return skuPlRows.filter((r) => {
      if (skuPlStatusFilter !== "ALL" && r.status.key !== skuPlStatusFilter) return false;
      if (!q) return true;
      return `${r.asin || ""} ${r.sku || ""} ${r.productName || ""} ${r.brand || ""}`.toLowerCase().includes(q);
    });
  }, [skuPlRows, skuPlSearch, skuPlStatusFilter]);

  const skuPlSorted = useMemo(() => {
    const acc = {
      productName: (r) => (r.productName || "").toLowerCase(),
      sku: (r) => (r.sku || "").toLowerCase(),
      sales: (r) => r.sales, profit: (r) => r.profit, margin: (r) => (r.margin === null ? -Infinity : r.margin),
      units: (r) => r.units, cost: (r) => r.cost, fees: (r) => r.fees, adSpend: (r) => r.adSpend,
      cogs: (r) => r.cogs, adSalesRatio: (r) => (r.adSalesRatio === null ? Infinity : r.adSalesRatio),
      status: (r) => r.status.label,
    }[skuPlSort.key] || ((r) => r.profit);
    return [...skuPlFiltered].sort((a, b) => {
      const av = acc(a), bv = acc(b);
      const cmp = typeof av === "string" || typeof bv === "string" ? String(av).localeCompare(String(bv)) : av - bv;
      return skuPlSort.dir === "asc" ? cmp : -cmp;
    });
  }, [skuPlFiltered, skuPlSort]);

  const skuPlPageCount = Math.max(1, Math.ceil(skuPlSorted.length / 50));
  const skuPlSafePage = Math.min(skuPlPage, skuPlPageCount);
  const skuPlPageRows = skuPlSorted.slice((skuPlSafePage - 1) * 50, skuPlSafePage * 50);
  const skuPlPages = useMemo(() => {
    const pages = new Set([1, skuPlPageCount, skuPlSafePage - 1, skuPlSafePage, skuPlSafePage + 1]);
    return [...pages].filter((p) => p >= 1 && p <= skuPlPageCount).sort((a, b) => a - b);
  }, [skuPlSafePage, skuPlPageCount]);
  const skuPlMonthLabel = skuPlMonth === "ALL" ? "All 6 Months" : reconMonthLabel(skuPlMonth);
  const setSkuPlSortKey = useCallback((key) => {
    setSkuPlSort((prev) => prev.key === key
      ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
      : { key, dir: ["productName", "sku", "status"].includes(key) ? "asc" : "desc" });
  }, []);

  const contentChangeEvents = useMemo(() => {
    const search = contentChangesSearch.trim().toLowerCase();
    return (contentChangesData?.events || []).filter((event) => {
      if (selectedBrand !== "ALL" && !(event.brands || []).includes(selectedBrand)) return false;
      if (contentChangesType !== "ALL" && event.notificationType !== contentChangesType) return false;
      if (!search) return true;
      return [event.eventTime, event.notificationType, event.notificationId, ...(event.asins || []), ...(event.brands || []), event.metadataPreview, event.payloadPreview]
        .join(" ").toLowerCase().includes(search);
    });
  }, [contentChangesData, contentChangesSearch, contentChangesType, selectedBrand]);

  const contentChangeTypes = useMemo(
    () => [...new Set((contentChangesData?.events || []).map((event) => event.notificationType).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [contentChangesData]
  );
  const contentChangeStats = useMemo(() => {
    const events = contentChangesData?.events || [];
    return {
      total: events.length,
      asinLinked: events.filter((event) => event.asins?.length).length,
      brandLinked: events.filter((event) => event.brands?.length).length,
      latest: events[0]?.eventTime || null,
    };
  }, [contentChangesData]);

  function rowCurrency(r) {
    return r.currency || accountById[r.seller_or_vendor_id]?.currency || "INR";
  }
  function salesInDisplay(r) {
    return r.total_sales;
  }

  function aggregate(rowSet) {
    let sales = 0, units = 0, orders = 0, unpricedUnits = 0;
    rowSet.forEach((r) => {
      units += r.total_units_sold || 0;
      orders += r.total_orders || 0;
      sales += salesInDisplay(r);
      unpricedUnits += r.unpriced_units || 0;
    });
    return { sales, units, orders, unpricedUnits };
  }

  const brandRows = useMemo(
    () => rows.filter((r) => selectedBrand === "ALL" || productBrand(r) === selectedBrand),
    [rows, selectedBrand]
  );
  const [scopeMin, scopeMax] = useMemo(() => {
    let mn = null, mx = null;
    brandRows.forEach((r) => {
      if (!mn || r.date < mn) mn = r.date;
      if (!mx || r.date > mx) mx = r.date;
    });
    return [mn, mx];
  }, [brandRows]);
  const latest = scopeMax || TODAY;

  function productBrand(r) {
    return String(r.product_brand || "Unassigned").trim() || "Unassigned";
  }
  const cachedAccountBrands = useMemo(
    () => readCachedCatalogBrands(selectedAccountId),
    [selectedAccountId, catalogBrands, catalogBrandsAccountId]
  );
  const brandList = useMemo(() => {
    // Never carry a prior account's in-memory catalog into the newly selected
    // account. Cached catalog keys are already account-scoped.
    const currentCatalogBrands = catalogBrandsAccountId === selectedAccountId ? catalogBrands : [];
    const names = new Set([...cachedAccountBrands, ...currentCatalogBrands]);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [cachedAccountBrands, catalogBrands, catalogBrandsAccountId, selectedAccountId]);
  function filterRows(from, to) {
    return brandRows.filter((r) => r.date >= from && r.date <= to);
  }
  function compareValue(curFrom, curTo, prevFrom, prevTo, minDate) {
    if (!minDate || prevFrom < minDate) return { value: null, insufficient: true, curr: null };
    const curAgg = aggregate(filterRows(curFrom, curTo));
    const prevAgg = aggregate(filterRows(prevFrom, prevTo));
    return { value: pct(curAgg.sales, prevAgg.sales), insufficient: false, curr: curAgg.sales };
  }

  const comparisons = useMemo(() => {
    if (!scopeMax) return null;
    const prevDay = addDays(latest, -1);
    const dod = compareValue(latest, latest, prevDay, prevDay, scopeMin);
    const wow = compareValue(addDays(latest, -6), latest, addDays(latest, -13), addDays(latest, -7), scopeMin);
    const pm = shiftMonthRange(latest, 0, -1);
    const mtd = compareValue(monthStart(latest), latest, pm.start, pm.end, scopeMin);
    const py = shiftMonthRange(latest, -1, 0);
    const yoy = compareValue(monthStart(latest), latest, py.start, py.end, scopeMin);
    return { dod, wow, mtd, yoy };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandRows, latest, scopeMin]);

  const [rangeFrom, rangeTo] = useMemo(() => {
    let f, t;
    switch (rangePreset) {
      case "YESTERDAY": {
        // Use the prior calendar day when it is available; a delayed source
        // falls back to its latest completed date instead of creating an
        // inverted range.
        const yesterday = addDays(TODAY, -1);
        f = yesterday <= latest ? yesterday : latest;
        t = f;
        break;
      }
      case "7D": f = addDays(latest, -6); t = latest; break;
      case "90D": f = addDays(latest, -89); t = latest; break;
      case "MTD": f = monthStart(latest); t = latest; break;
      case "YTD": f = yearStart(latest); t = latest; break;
      case "CUSTOM": f = customFrom || scopeMin || latest; t = customTo || latest; break;
      default: f = addDays(latest, -29); t = latest;
    }
    if (scopeMin && f < scopeMin) f = scopeMin;
    if (t > latest) t = latest;
    return [f, t];
  }, [rangePreset, latest, scopeMin, customFrom, customTo]);

  const scopedRows = useMemo(() => filterRows(rangeFrom, rangeTo), [brandRows, rangeFrom, rangeTo]);
  const kpi = useMemo(() => aggregate(scopedRows), [scopedRows]);
  const aov = kpi.orders > 0 ? kpi.sales / kpi.orders : 0;
  // The sales source (401ffcd7e5) has no order-count column, so Orders / AOV
  // show "—" unless an orders figure is actually present on the rows.
  const hasOrders = useMemo(() => brandRows.some((r) => r.total_orders !== undefined && r.total_orders !== null), [brandRows]);

  const trend = useMemo(() => {
    const buckets = {};
    scopedRows.forEach((r) => {
      const v = salesInDisplay(r);
      let key;
      if (granularity === "M") key = r.date.slice(0, 7);
      else if (granularity === "W") key = weekStart(r.date);
      else key = r.date;
      buckets[key] = (buckets[key] || 0) + v;
    });
    return Object.keys(buckets).sort().map((k) => {
      let label;
      if (granularity === "M") { const [y, m] = k.split("-"); label = `${MONTH_ABBR[+m - 1]} ${y}`; }
      else { const p = parts(k); label = `${MONTH_ABBR[p.m - 1]} ${p.d}`; }
      return { key: k, label, value: buckets[k] };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedRows, granularity]);

  const byAccountBreakdown = useMemo(() => {
    const sums = {};
    scopedRows.forEach((r) => {
      const v = salesInDisplay(r);
      sums[r.seller_or_vendor_id] = (sums[r.seller_or_vendor_id] || 0) + v;
    });
    const total = Object.values(sums).reduce((a, b) => a + b, 0);
    return Object.keys(sums).map((id) => {
      const a = accountById[id];
      return { key: id, label: a?.name || id, flag: a ? FLAGS[a.country] : null, value: sums[id], share: total ? (sums[id] / total) * 100 : 0 };
    }).sort((a, b) => b.value - a.value);
  }, [scopedRows, accountById]);

  const byBrandBreakdown = useMemo(() => {
    const sums = {};
    scopedRows.forEach((r) => {
      const b = productBrand(r);
      const v = salesInDisplay(r);
      sums[b] = (sums[b] || 0) + v;
    });
    const total = Object.values(sums).reduce((a, b) => a + b, 0);
    return Object.keys(sums).map((b) => ({ key: b, label: b, flag: null, value: sums[b], share: total ? (sums[b] / total) * 100 : 0 })).sort((a, b) => b.value - a.value);
  }, [scopedRows]);

  const activeAccountKeys = useMemo(() => new Set(selectedAccountId ? [selectedAccountId] : []), [selectedAccountId]);
  const activeBrandKeys = useMemo(() => {
    return selectedBrand === "ALL" ? new Set() : new Set([selectedBrand]);
  }, [selectedBrand]);

  if (accountsLoading) {
    return <div className="dash-root"><style>{STYLE}</style><div className="loading-screen">Loading your Amazon accounts…</div></div>;
  }
  if (accountsError) {
    return (
      <div className="dash-root">
        <style>{STYLE}</style>
        <div className="loading-screen">
          <AlertTriangle size={20} style={{ marginBottom: 8 }} />
          <div>{accountsError}</div>
          <div style={{ fontSize: 12.5, color: "var(--ink-soft)", marginTop: 8 }}>
            The dashboard now uses cached data on open. Use refresh only when you want to call DataDoe.
          </div>
          <button className="cache-refresh-btn" onClick={fetchAccounts} disabled={accountsLoading}>
            <RefreshCw size={14} className={accountsLoading ? "spin" : ""} />
            Refresh accounts
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="dash-root">
      <style>{STYLE}</style>

      <div className="app-shell">
        <aside className={"sidebar" + (collapsed ? " collapsed" : "") + (mobileOpen ? " mobile-open" : "")}>
          <div className="sb-brand">
            <div className="sb-logo">UR</div>
            <div className="sb-brand-text">
              <div className="sb-ws-name">Upriver Dashboard</div>
              <div className="sb-ws-sub">laxmikant@upriver.in</div>
            </div>
            <button className="sb-close" onClick={() => setMobileOpen(false)} aria-label="Close menu">
              <X size={18} />
            </button>
          </div>

          <nav className="sb-nav">
            <button className={"sb-nav-item" + (view === "dashboard" ? " active" : "")} title="Dashboard" onClick={() => { setView("dashboard"); setMobileOpen(false); }}>
              <LayoutDashboard size={18} />
              <span className="sb-nav-label">Dashboard</span>
            </button>
            <button className={"sb-nav-item" + (view === "daily" ? " active" : "")} title="Daily Reporting" onClick={() => { setView("daily"); setMobileOpen(false); }}>
              <CalendarRange size={18} />
              <span className="sb-nav-label">Daily Reporting</span>
            </button>
            <button className={"sb-nav-item" + (view === "reconciliation" ? " active" : "")} title="Reconciliation Dashboard" onClick={() => { setView("reconciliation"); setMobileOpen(false); }}>
              <ReceiptText size={18} />
              <span className="sb-nav-label">Reconciliation</span>
            </button>
            <button className={"sb-nav-item" + (view === "fbaplan" ? " active" : "")} title="FBA Shipment Plan" onClick={() => { setView("fbaplan"); setMobileOpen(false); }}>
              <Boxes size={18} />
              <span className="sb-nav-label">FBA Shipment Plan</span>
            </button>
            <button className={"sb-nav-item" + (view === "skupl" ? " active" : "")} title="SKU P&L Analyzer" onClick={() => { setView("skupl"); setMobileOpen(false); }}>
              <Wallet size={18} />
              <span className="sb-nav-label">SKU P&amp;L Analyzer</span>
            </button>
            <button className={"sb-nav-item" + (view === "contentchanges" ? " active" : "")} title="Content Change Alerts" onClick={() => { setView("contentchanges"); setMobileOpen(false); }}>
              <BellRing size={18} />
              <span className="sb-nav-label">Content Alerts</span>
            </button>
          </nav>

          <div className="sb-footer">
            <button className="sb-collapse" onClick={() => setCollapsed((c) => !c)} title={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-label="Toggle sidebar">
              {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
              <span className="sb-nav-label">Collapse</span>
            </button>
          </div>
        </aside>

        {mobileOpen && <div className="sb-backdrop" onClick={() => setMobileOpen(false)} />}

        <div className="main-area">
      <div className="topbar">
        <button className="menu-btn" onClick={() => setMobileOpen(true)} aria-label="Open menu">
          <Menu size={18} />
        </button>
        <div className="brandmark">
          <span className="mark">UPRIVER</span>
          <span className="sub">Amazon Seller Portfolio — Sales</span>
        </div>
        <div className="topbar-filters">
          <div className="select topbar-account-select">
            <select
              aria-label="Account selection"
              value={selectedAccountId || ""}
              onChange={(e) => {
                setSelectedAccountId(e.target.value);
                setSelectedBrand("ALL");
              }}
            >
              {accounts.map((account) => (
                <option value={account.id} key={account.id}>
                  {FLAGS[account.country] || ""} {account.name} ({account.currency || "—"})
                </option>
              ))}
            </select>
            <ChevronDown size={16} />
          </div>
          <div className="select topbar-brand-select">
            <select
              aria-label="Brand selection"
              value={selectedBrand}
              onChange={(e) => setSelectedBrand(e.target.value)}
            >
              <option value="ALL">Select All Brands</option>
              {brandList.map((brandName) => (
                <option value={brandName} key={brandName}>{brandName}</option>
              ))}
            </select>
            <ChevronDown size={16} />
          </div>
        </div>
        <div className="live-wrap">
          <span className="live-dot" />
          {(() => {
            const stamp = view === "fbaplan" ? planCachedAt : view === "reconciliation" ? reconciliationCachedAt : view === "skupl" ? skuPlCachedAt : view === "contentchanges" ? contentChangesCachedAt : lastFetchedAt;
            return stamp ? `Refreshed ${stamp.toLocaleTimeString()} · ${refreshScopeAccount?.name || "selected account"}` : "Select an account to refresh";
          })()}
          <button className="refresh-btn" onClick={view === "daily" ? fetchDaily : view === "fbaplan" ? fetchPlan : view === "reconciliation" ? fetchReconciliation : view === "skupl" ? fetchSkuPl : view === "contentchanges" ? fetchContentChanges : fetchRows} disabled={(view === "reconciliation" && reconciliationLoading) || (view === "skupl" && skuPlLoading) || (view === "contentchanges" && contentChangesLoading)} title="Refresh selected account">
            <RefreshCw size={13} className={(view === "daily" ? dailyLoading : view === "fbaplan" ? planLoading : view === "reconciliation" ? reconciliationLoading : view === "skupl" ? skuPlLoading : view === "contentchanges" ? contentChangesLoading : rowsLoading) ? "spin" : ""} />
          </button>
        </div>
      </div>

      {view === "dashboard" && (
      <div className="container">
        <div className="controls-bar dashboard-controls">
          <div className="chip-row">
            {["YESTERDAY", "7D", "30D", "90D", "MTD", "YTD", "CUSTOM"].map((p) => (
              <button key={p} className={"chip" + (rangePreset === p ? " active" : "")} onClick={() => setRangePreset(p)}>
                {p === "YESTERDAY" ? "Yesterday" : p === "CUSTOM" ? "Custom" : p}
              </button>
            ))}
            {rangePreset === "CUSTOM" && (
              <span className="custom-range">
                <input type="date" value={customFrom} min={scopeMin || undefined} max={latest} onChange={(e) => setCustomFrom(e.target.value)} />
                <input type="date" value={customTo} min={scopeMin || undefined} max={latest} onChange={(e) => setCustomTo(e.target.value)} />
              </span>
            )}
          </div>
        </div>

        {rowsError && (
          <div className="error-banner"><AlertTriangle size={15} /> {rowsError}</div>
        )}
        {!rowsLoading && selectedBrand === "ALL" && kpi.unpricedUnits > 0 && (
          <div className="error-banner" style={{ background: "#FEF3E2", borderColor: "#F3D9A8", color: "#8A5A12" }}>
            <AlertTriangle size={15} /> DataDoe returned {kpi.unpricedUnits.toLocaleString("en-US")} unit{kpi.unpricedUnits === 1 ? "" : "s"} with zero order value in this range. Total Sales may be understated until the upstream order data is completed.
          </div>
        )}

        <div className="kpi-grid">
          <div className="kpi-card">
            <div className="kpi-label">Total Sales</div>
            <div className="kpi-value mono">{rowsLoading ? "…" : fmtMoney(kpi.sales, displayCurrency)}</div>
            <div className="kpi-period">{fmtRangeLabel(rangeFrom, rangeTo)}</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Units Sold</div>
            <div className="kpi-value mono">{rowsLoading ? "…" : kpi.units.toLocaleString("en-US")}</div>
            <div className="kpi-period">{fmtRangeLabel(rangeFrom, rangeTo)}</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Orders</div>
            <div className="kpi-value mono">{rowsLoading ? "…" : hasOrders ? kpi.orders.toLocaleString("en-US") : "—"}</div>
            <div className="kpi-period">{fmtRangeLabel(rangeFrom, rangeTo)}</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Avg. Order Value</div>
            <div className="kpi-value mono">{rowsLoading ? "…" : hasOrders ? fmtMoney(aov, displayCurrency, 2) : "—"}</div>
            <div className="kpi-period">{fmtRangeLabel(rangeFrom, rangeTo)}</div>
          </div>
        </div>

        <div className="compare-row">
          <CompareChip label="Day over Day" note="vs previous day" data={comparisons?.dod} />
          <CompareChip label="Week over Week" note="vs prior 7 days" data={comparisons?.wow} />
          <CompareChip label="Month to Date" note="vs last month, same days" data={comparisons?.mtd} />
          <CompareChip label="Year over Year" note="vs same period last year" data={comparisons?.yoy} />
        </div>

        <div className="panel">
          <div className="panel-head">
            <div className="panel-title">Sales Trend</div>
            <div className="seg">
              {["D", "W", "M"].map((g) => (
                <button key={g} className={granularity === g ? "active" : ""} onClick={() => setGranularity(g)}>
                  {g === "D" ? "Daily" : g === "W" ? "Weekly" : "Monthly"}
                </button>
              ))}
            </div>
          </div>
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trend} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="fillAccent" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#F2A93B" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#F2A93B" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#EBEDF3" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#5B6178" }} axisLine={{ stroke: "#E3E6EE" }} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: "#5B6178" }} axisLine={false} tickLine={false} tickFormatter={(v) => compactNumber(v, displayCurrency)} width={54} />
                <Tooltip formatter={(v) => [fmtMoney(v, displayCurrency), "Sales"]} labelStyle={{ fontWeight: 700, color: "#12172B" }} contentStyle={{ borderRadius: 10, border: "1px solid #E3E6EE", fontSize: 12.5 }} />
                <Area type="monotone" dataKey="value" stroke="#C97F1D" strokeWidth={2} fill="url(#fillAccent)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="breakdown-grid">
          <BreakdownPanel title="Sales by Account" items={byAccountBreakdown} activeKeys={activeAccountKeys} currency="INR" />
          <BreakdownPanel title="Sales by Brand" items={byBrandBreakdown} activeKeys={activeBrandKeys} currency="INR" />
        </div>

        <div className="footer-note">
          Total Sales is DataDoe Order Line Items `item_price_value`, the documented order-value field. Brand filtering uses DataDoe's Product Catalog by ASIN (`product_brand`) for the selected account. Change an account or brand to use cached data; use refresh only when you want a new export. If the warning above appears, DataDoe has returned units without an order value, so refresh again after its upstream order data is completed.
        </div>
      </div>
      )}

      {view === "daily" && (
      <div className="container">
        <div className="controls-bar">
          <div>
            <div className="page-title">Daily Reporting</div>
            <div className="page-sub">Sales & advertising snapshot for {refreshScopeAccount?.name || "the selected account"}{selectedBrand === "ALL" ? "" : ` · ${selectedBrand}`}</div>
          </div>
        </div>

        {dailyError && (
          <div className="error-banner"><AlertTriangle size={15} /> {dailyError}</div>
        )}

        <div className="panel" style={{ marginTop: 14 }}>
          <div className="panel-head">
            <div>
              <div className="panel-title">{refreshScopeAccount?.name || "Account"}{selectedBrand === "ALL" ? "" : ` · ${selectedBrand}`}</div>
              <div className="page-sub">Latest completed sales: {fmtDateHuman(dailyReport.latest)} · shown in {dailyCurrency}</div>
            </div>
            <button className="refresh-btn" onClick={fetchDaily} title="Refresh data">
              <RefreshCw size={13} className={dailyLoading ? "spin" : ""} />
            </button>
          </div>

          <div className="daily-scroll">
            <table className="daily-table">
              <thead>
                <tr>
                  <th className="dt-metric">{refreshScopeAccount?.name?.split(" ")[0] || "Metric"}</th>
                  {dailyReport.columns.map((c) => (
                    <th key={c.key} className={"dt-col dt-" + c.group}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {DAILY_METRICS.map((metric) => (
                  <tr key={metric.key} className={metric.highlight ? "dt-row-highlight" : ""}>
                    <td className="dt-metric">{metric.label}</td>
                    {dailyReport.cells.map((cell, i) => (
                      <td key={dailyReport.columns[i].key} className={"mono dt-" + dailyReport.columns[i].group}>
                        {dailyLoading ? "…" : metric.fmt(cell, dailyCurrency)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="footer-note">
          ROI = Ad Sales ÷ Ad Spend · ACoS % = Ad Spend ÷ Ad Sales · TACoS % = Ad Spend ÷ Total Sales.
          Sales and units are sourced from DataDoe Sales & Traffic by ASIN & Date. {selectedBrand === "ALL" ? "Ad Sales, Ad Spend, and Clicks are sourced from the connected DataDoe advertising export." : "Advertising metrics show — for a named brand because the connected advertising export is account-level and cannot be assigned accurately to a product brand."} The report ends on the latest completed sales date so a delayed source row is not shown as a real zero-sales day.
        </div>
      </div>
      )}

      {view === "reconciliation" && (
      <div className="container reconciliation-page">
        <div className="controls-bar">
          <div>
            <div className="page-title">Amazon Reconciliation</div>
            <div className="page-sub">Orders versus settlements for {refreshScopeAccount?.name || "the selected account"}{selectedBrand === "ALL" ? "" : ` · ${selectedBrand}`}</div>
          </div>
          {reconciliationData && (
            <div className="recon-month-picker">
              <label htmlFor="reconciliation-month">Report month</label>
              <select id="reconciliation-month" value={reconciliationMonth || "ALL"} onChange={(e) => setReconciliationMonth(e.target.value)}>
                <option value="ALL">All 6 Months</option>
                {(reconciliationData.months || []).map((month) => <option key={month} value={month}>{reconMonthLabel(month)}</option>)}
              </select>
            </div>
          )}
        </div>

        {reconciliationError && <div className="error-banner"><AlertTriangle size={15} /> {reconciliationError}</div>}

        {!reconciliationData && !reconciliationError && (
          <div className="panel recon-empty"><ReceiptText size={22} /><div>Reconciliation data is loading from cache...</div></div>
        )}

        {reconciliationData && <>
          <div className="recon-freshness">
            <span className="live-dot" style={{ position: "relative", top: 1 }} />
            <span>Orders and settlement events from <strong>{fmtDateHuman(reconciliationData.from)}</strong> to <strong>{fmtDateHuman(reconciliationData.to)}</strong></span>
            <span className="plan-fresh-sep">·</span>
            <span>cached {reconciliationCachedAt?.toLocaleString()}</span>
          </div>
          {reconciliationScope.brandScopeIsConservative && (
            <div className="recon-notice"><Info size={15} /> Brand scope includes only orders containing this one brand. Mixed-brand orders are excluded because settlement events are order-level and cannot be allocated accurately by product brand.</div>
          )}

          <div className="recon-kpis">
            <ReconKpi label="Shipped Orders" value={reconciliationMetrics.shippedOrders.toLocaleString("en-US")} note="orders in selected order month" />
            <ReconKpi label="Settled Orders" value={reconciliationMetrics.settledOrders.toLocaleString("en-US")} note={`gap ${reconciliationMetrics.orderGap.toLocaleString("en-US")}`} />
            <ReconKpi label="Order Revenue" value={fmtMoney(reconciliationMetrics.orderRevenue, displayCurrency)} note="purchase-date basis" />
            <ReconKpi label="Settled Revenue" value={fmtMoney(reconciliationMetrics.settledRevenue, displayCurrency)} note={`gap ${fmtMoney(reconciliationMetrics.revenueGap, displayCurrency)}`} />
            <ReconKpi label="Refunds" value={`${reconciliationMetrics.refunds.toLocaleString("en-US")} · ${fmtMoney(reconciliationMetrics.refundAmount, displayCurrency)}`} note="orders with a refund event" />
            <ReconKpi label="Cancelled" value={reconciliationMetrics.cancelled.toLocaleString("en-US")} note="not expected to settle" />
            <ReconKpi label="Reconciliation Rate" value={reconciliationMetrics.reconciliationRate === null ? "-" : `${reconciliationMetrics.reconciliationRate.toFixed(1)}%`} note="shipped orders with ORDER settlement" />
            <ReconKpi label="Net Payout" value={fmtMoney(reconciliationMetrics.netPayout, displayCurrency)} note="settlement posted-date basis" />
          </div>

          <div className="recon-chart-grid">
            <div className="panel recon-chart-panel">
              <div className="panel-head"><div><div className="panel-title">Monthly Settlement Trend</div><div className="page-sub">Selected month is highlighted in amber</div></div></div>
              <div className="recon-chart-wrap">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={reconciliationTrend} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                    <CartesianGrid stroke="#EBEDF3" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#5B6178" }} axisLine={false} tickLine={false} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "#5B6178" }} axisLine={false} tickLine={false} />
                    <Tooltip />
                    <Bar dataKey="shipped" name="Shipped orders" radius={[4, 4, 0, 0]}>
                      {reconciliationTrend.map((entry) => <Cell key={entry.month} fill={entry.month === reconciliationMonth ? "#E69B28" : "#D6DFEA"} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="panel recon-chart-panel">
              <div className="panel-head"><div><div className="panel-title">Reconciliation Status</div><div className="page-sub">Order status after matching settlement events</div></div></div>
              <div className="recon-donut-wrap">
                <ResponsiveContainer width="58%" height="100%">
                  <PieChart><Pie data={reconciliationDonut.filter((item) => item.value > 0)} dataKey="value" nameKey="label" innerRadius="56%" outerRadius="78%" paddingAngle={2}>{reconciliationDonut.filter((item) => item.value > 0).map((item) => <Cell key={item.label} fill={item.fill} />)}</Pie><Tooltip /></PieChart>
                </ResponsiveContainer>
                <div className="recon-donut-legend">{reconciliationDonut.map((item) => <div key={item.label}><span style={{ background: item.fill }} />{item.label}<strong>{item.value}</strong></div>)}</div>
              </div>
            </div>
          </div>

          <div className="panel recon-overlay-panel">
            <div className="panel-head">
              <div><div className="panel-title">Order and Settlement Overlay</div><div className="page-sub">Orders use purchase date; settlements use Amazon posting date.</div></div>
              <div className="seg"><button className={reconciliationMode === "counts" ? "active" : ""} onClick={() => setReconciliationMode("counts")}>Order Counts</button><button className={reconciliationMode === "revenue" ? "active" : ""} onClick={() => setReconciliationMode("revenue")}>Revenue</button></div>
            </div>
            <div className="recon-overlay-wrap">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={reconciliationDaily} margin={{ top: 10, right: 15, left: -16, bottom: 0 }}>
                  <CartesianGrid stroke="#EBEDF3" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#5B6178" }} axisLine={false} tickLine={false} />
                  <YAxis yAxisId="left" tick={{ fontSize: 11, fill: "#5B6178" }} axisLine={false} tickLine={false} tickFormatter={(v) => reconciliationMode === "revenue" ? compactNumber(v, displayCurrency) : v} />
                  <YAxis yAxisId="right" orientation="right" allowDecimals={false} tick={{ fontSize: 11, fill: "#5B6178" }} axisLine={false} tickLine={false} />
                  <Tooltip formatter={(value, name) => [reconciliationMode === "revenue" && name !== "Refund events" ? fmtMoney(value, displayCurrency) : value, name]} />
                  <Legend />
                  <Bar yAxisId="left" dataKey={reconciliationMode === "revenue" ? "orderRevenue" : "shipped"} name={reconciliationMode === "revenue" ? "Order revenue" : "Shipped orders"} fill="#E6A12A" radius={[3, 3, 0, 0]} />
                  <Bar yAxisId="left" dataKey={reconciliationMode === "revenue" ? "settledRevenue" : "settled"} name={reconciliationMode === "revenue" ? "Settled revenue" : "ORDER settlements"} fill="#D76168" radius={[3, 3, 0, 0]} />
                  <Line yAxisId="right" type="monotone" dataKey="refunds" name="Refund events" stroke="#3F84C5" strokeWidth={2} dot={{ r: 3 }} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="panel recon-waterfall-panel">
            <div className="panel-head"><div><div className="panel-title">Settlement Revenue Waterfall</div><div className="page-sub">All values preserve the signs supplied by Amazon settlement data.</div></div></div>
            <div className="recon-waterfall">{reconciliationWaterfall.map((item) => <div className="recon-waterfall-row" key={item.label}><span>{item.label}</span><div className="recon-waterfall-track"><div className={`recon-waterfall-fill ${item.kind}`} style={{ width: `${Math.min(100, (Math.abs(item.value) / Math.max(1, ...reconciliationWaterfall.map((bar) => Math.abs(bar.value)))) * 100)}%` }} /></div><strong>{fmtMoney(item.value, displayCurrency, 2)}</strong></div>)}</div>
          </div>

          <div className="panel recon-daily-panel">
            <div className="panel-head"><div><div className="panel-title">Daily Summary</div><div className="page-sub">Click a month above to switch this table together with every dashboard section.</div></div></div>
            <div className="recon-table-scroll"><table className="recon-daily-table"><thead><tr><th>{reconciliationMonth === "ALL" ? "Month" : "Day"}</th><th>Shipped</th><th>ORDER settlements</th><th>Refund events</th><th>Order revenue</th><th>Settled revenue</th></tr></thead><tbody>{reconciliationDaily.map((row) => <tr key={row.key}><td>{row.label}</td><td>{row.shipped}</td><td>{row.settled}</td><td>{row.refunds}</td><td>{fmtMoney(row.orderRevenue, displayCurrency)}</td><td>{fmtMoney(row.settledRevenue, displayCurrency)}</td></tr>)}</tbody></table></div>
          </div>

          <div className="panel recon-explorer-panel">
            <div className="panel-head"><div><div className="panel-title">Order Explorer</div><div className="page-sub">{reconciliationSortedRows.length.toLocaleString("en-US")} matching orders. Copy an order ID, inspect timing, or export the filtered result.</div></div><button className="plan-export-btn" onClick={() => downloadReconciliationCsv(reconciliationSortedRows, displayCurrency, refreshScopeAccount?.name)} disabled={!reconciliationSortedRows.length}><Download size={15} />Download Excel</button></div>
            <div className="recon-filters">
              <label className="plan-field recon-search"><span className="plan-field-label">Search</span><span className="plan-search-wrap"><Search size={14} /><input value={reconciliationSearch} onChange={(e) => setReconciliationSearch(e.target.value)} placeholder="Order ID, status, channel..." /></span></label>
              <ReconSelect label="Order status" value={reconciliationStatusFilter} onChange={setReconciliationStatusFilter} options={["ALL", ...new Set(reconciliationScope.orders.map((order) => String(order.status)))]} />
              <ReconSelect label="Recon status" value={reconciliationReconFilter} onChange={setReconciliationReconFilter} options={["ALL", "Settled", "Settled + Refunded", "Refunded", "Pending", "Cancelled"]} />
              <ReconSelect label="B2B" value={reconciliationB2BFilter} onChange={setReconciliationB2BFilter} options={["ALL", "YES", "NO"]} />
              <ReconSelect label="Cross-month" value={reconciliationCrossMonthFilter} onChange={setReconciliationCrossMonthFilter} options={["ALL", "SAME", "CROSS"]} />
              <label className="plan-field"><span className="plan-field-label">From</span><input type="date" value={reconciliationFrom} min={reconciliationData.from} max={reconciliationData.to} onChange={(e) => setReconciliationFrom(e.target.value)} /></label>
              <label className="plan-field"><span className="plan-field-label">To</span><input type="date" value={reconciliationTo} min={reconciliationData.from} max={reconciliationData.to} onChange={(e) => setReconciliationTo(e.target.value)} /></label>
            </div>
            <div className="recon-table-scroll"><table className="recon-table"><thead><tr><ReconTh label="Order ID" col="orderId" sort={reconciliationSort} setSort={setReconciliationSort} align="left" /><ReconTh label="Order Date" col="orderDate" sort={reconciliationSort} setSort={setReconciliationSort} /><ReconTh label="Status" col="status" sort={reconciliationSort} setSort={setReconciliationSort} /><ReconTh label="Channel" col="fulfillmentChannel" sort={reconciliationSort} setSort={setReconciliationSort} /><ReconTh label="B2B" col="isBusiness" sort={reconciliationSort} setSort={setReconciliationSort} /><ReconTh label="Revenue" col="orderRevenue" sort={reconciliationSort} setSort={setReconciliationSort} /><ReconTh label="Tax" col="orderTax" sort={reconciliationSort} setSort={setReconciliationSort} /><ReconTh label="Recon Status" col="reconciliationStatus" sort={reconciliationSort} setSort={setReconciliationSort} /><ReconTh label="Sett. Date" col="settlementDate" sort={reconciliationSort} setSort={setReconciliationSort} /><ReconTh label="Settled" col="settledRevenue" sort={reconciliationSort} setSort={setReconciliationSort} /><ReconTh label="Fees" col="fees" sort={reconciliationSort} setSort={setReconciliationSort} /><ReconTh label="Refund" col="refundAmount" sort={reconciliationSort} setSort={setReconciliationSort} /><ReconTh label="Net Payout" col="netPayout" sort={reconciliationSort} setSort={setReconciliationSort} /><ReconTh label="Delta" col="delta" sort={reconciliationSort} setSort={setReconciliationSort} /><ReconTh label="Cross-Month" col="crossMonth" sort={reconciliationSort} setSort={setReconciliationSort} /></tr></thead><tbody>{reconciliationPageRows.map((row) => <tr key={row.orderId} className={`recon-row-${reconciliationStatusClass(row.reconciliationStatus)}`}><td className="recon-order-id"><button title="Copy order ID" onClick={async () => { try { await navigator.clipboard.writeText(row.orderId); setCopiedOrderId(row.orderId); window.setTimeout(() => setCopiedOrderId(null), 1200); } catch (e) {} }}>{row.orderId} {copiedOrderId === row.orderId ? <Check size={13} /> : <Copy size={13} />}</button></td><td>{row.orderDate}</td><td>{row.status}</td><td>{row.fulfillmentChannel}</td><td>{row.isBusiness ? "Yes" : "No"}</td><td>{fmtMoney(row.orderRevenue, displayCurrency, 2)}</td><td>{fmtMoney(row.orderTax, displayCurrency, 2)}</td><td><span className={`recon-badge ${reconciliationStatusClass(row.reconciliationStatus)}`}>{row.reconciliationStatus}</span></td><td>{row.settlementDate || "-"}</td><td>{fmtMoney(row.settledRevenue, displayCurrency, 2)}</td><td>{fmtMoney(row.fees, displayCurrency, 2)}</td><td>{fmtMoney(row.refundAmount, displayCurrency, 2)}</td><td>{fmtMoney(row.netPayout, displayCurrency, 2)}</td><td>{fmtMoney(row.delta, displayCurrency, 2)}</td><td>{row.crossMonth ? <span className="recon-cross-badge">Settled in {reconMonthLabel(reconMonthOf(row.settlementDate))}</span> : "-"}</td></tr>)}</tbody></table></div>
            {!reconciliationPageRows.length && <div className="empty-note">No orders match these filters.</div>}
            <div className="recon-pagination"><button disabled={reconciliationPage === 1} onClick={() => setReconciliationPage((page) => Math.max(1, page - 1))}>Prev</button>{reconciliationPages.map((page, index) => <React.Fragment key={page}>{index > 0 && page - reconciliationPages[index - 1] > 1 && <span>...</span>}<button className={page === reconciliationPage ? "active" : ""} onClick={() => setReconciliationPage(page)}>{page}</button></React.Fragment>)}<button disabled={reconciliationPage === reconciliationPageCount} onClick={() => setReconciliationPage((page) => Math.min(reconciliationPageCount, page + 1))}>Next</button></div>
          </div>

          <div className="footer-note">Data powered by DataDoe. Settlement dates are when Amazon posted a financial event, while order dates are purchase dates. A cross-month settlement, a pending recent order, a cancelled order, an MCF order, or a B2B deferral can all create an expected difference; this report makes that timing inspectable instead of hiding it.</div>
        </>}
      </div>
      )}

      {view === "fbaplan" && (
      <div className="container">
        <div className="controls-bar">
          <div>
            <div className="page-title">FBA Shipment Plan</div>
            <div className="page-sub">Per-ASIN restock recommendation for {refreshScopeAccount?.name || "the selected account"}{selectedBrand === "ALL" ? "" : ` · ${selectedBrand}`} from sales velocity and live FBA{planData?.isUS ? " + AWD" : ""} inventory</div>
          </div>
        </div>

        <div className="plan-controls">
          <label className="plan-field">
            <span className="plan-field-label">Target Coverage Days</span>
            <input
              type="number" min="1" step="1" value={targetDays}
              onChange={(e) => { const v = e.target.value; setTargetDays(v === "" ? "" : Math.max(1, Number(v))); }}
              onBlur={(e) => { if (e.target.value === "" || Number(e.target.value) < 1) setTargetDays(30); }}
            />
          </label>
          <label className="plan-field plan-search">
            <span className="plan-field-label">Search</span>
            <span className="plan-search-wrap">
              <Search size={14} />
              <input type="text" placeholder="ASIN, SKU, product, or brand" value={planSearch} onChange={(e) => setPlanSearch(e.target.value)} />
            </span>
          </label>
          <button
            className="plan-export-btn"
            type="button"
            disabled={!planData || planRows.length === 0}
            onClick={() => downloadPlanSpreadsheet(planRows, planData, targetDays || 30)}
          >
            <Download size={15} />
            Download Excel
          </button>
        </div>

        {planError && (
          <div className="error-banner"><AlertTriangle size={15} /> {planError}</div>
        )}

        {planData && (
          <>
            <div className="plan-freshness">
              <span className="live-dot" style={{ position: "relative", top: 1 }} />
              <span>Sales through <strong>{planData.salesLatestDate ? fmtDateHuman(planData.salesLatestDate) : "—"}</strong></span>
              <span className="plan-fresh-sep">·</span>
              <span>FBA inventory snapshot <strong>{planData.inventoryDate ? fmtDateHuman(planData.inventoryDate) : "unavailable"}</strong></span>
              {planData.isUS && <><span className="plan-fresh-sep">·</span><span>AWD {planData.awdAvailable ? "included" : "no live units"}</span></>}
              <span className="plan-fresh-sep">·</span>
              <span>{planCachedAt ? `cached ${planCachedAt.toLocaleString()}` : ""}</span>
            </div>

            {!planData.inventoryAvailable && (
              <div className="error-banner" style={{ background: "#FEF3E2", borderColor: "#F3D9A8", color: "#8A5A12" }}>
                <AlertTriangle size={15} /> Live FBA inventory is unavailable for this account right now, so coverage and recommendations show “—”. Sales velocity is still shown.
              </div>
            )}

            <div className="plan-stat-row">
              <div className="plan-stat"><div className="plan-stat-label">ASINs</div><div className="plan-stat-value mono">{planRows.length.toLocaleString("en-US")}</div></div>
              <div className="plan-stat"><div className="plan-stat-label">Needs Restock</div><div className="plan-stat-value mono">{planTotals.restockCount.toLocaleString("en-US")}</div></div>
              <div className="plan-stat"><div className="plan-stat-label">Recommended Units</div><div className="plan-stat-value mono">{planTotals.anyInv ? nInt(planTotals.recommended) : "—"}</div></div>
              <div className="plan-stat"><div className="plan-stat-label">FBA Available</div><div className="plan-stat-value mono">{planTotals.anyInv ? nInt(planTotals.fbaAvailable) : "—"}</div></div>
              <div className="plan-stat"><div className="plan-stat-label">Total FBA Inv.</div><div className="plan-stat-value mono">{planTotals.anyInv ? nInt(planTotals.coverage) : "—"}</div></div>
            </div>
          </>
        )}

        {planData && planRows.length > 0 ? (
          <div className="panel" style={{ marginTop: 14, padding: 0, overflow: "hidden" }}>
            <div className="plan-scroll">
              <table className="plan-table">
                <thead>
                  <tr>
                    <PlanTh className="pt-id" label="Product / ASIN" col="asin" sort={planSort} onSort={setPlanSortKey} align="left" />
                    <PlanTh label={monthKeyLabel(planData.months?.[0]?.key)} col="m1" sort={planSort} onSort={setPlanSortKey} />
                    <PlanTh label={monthKeyLabel(planData.months?.[1]?.key)} col="m2" sort={planSort} onSort={setPlanSortKey} />
                    <PlanTh label={monthKeyLabel(planData.months?.[2]?.key)} col="m3" sort={planSort} onSort={setPlanSortKey} />
                    <PlanTh label="MTD" col="mtdUnits" sort={planSort} onSort={setPlanSortKey} />
                    <PlanTh label="3M Avg" col="threeMoAvg" sort={planSort} onSort={setPlanSortKey} />
                    <PlanTh label="MTD Proj." col="mtdProjected" sort={planSort} onSort={setPlanSortKey} />
                    <PlanTh label={`Target Units (${targetDays || 0}d)`} col="targetUnits" sort={planSort} onSort={setPlanSortKey} />
                    <PlanTh label="FBA Avail" col="fbaAvailable" sort={planSort} onSort={setPlanSortKey} />
                    <PlanTh label="FBA Days (MTD DRR)" col="fbaDaysCover" sort={planSort} onSort={setPlanSortKey} />
                    <PlanTh label="Reserved" col="reserved" sort={planSort} onSort={setPlanSortKey} />
                    <PlanTh label="In Transit" col="inTransit" sort={planSort} onSort={setPlanSortKey} />
                    {planData.isUS && <PlanTh label="AWD Avail" col="awd" sort={planSort} onSort={setPlanSortKey} />}
                    <PlanTh label="Total FBA Inv." col="coverage" sort={planSort} onSort={setPlanSortKey} />
                    <PlanTh label="Recommend" col="recommended" sort={planSort} onSort={setPlanSortKey} />
                    <PlanTh label="Remark" col="remark" sort={planSort} onSort={setPlanSortKey} align="left" />
                  </tr>
                </thead>
                <tbody>
                  {planRows.map((r) => (
                    <tr key={r.asin} className={r.remark === "Restock" ? "plan-restock" : ""}>
                      <td className="pt-id">
                        <div className="pt-name" title={r.productName || r.asin}>{r.productName || "(no product name)"}</div>
                        <div className="pt-meta mono">{r.asin}{r.sku ? ` · ${r.sku}` : ""}</div>
                        {r.brand && <div className="pt-brand">{r.brand}</div>}
                      </td>
                      <td className="mono">{nInt(r.m1)}</td>
                      <td className="mono">{nInt(r.m2)}</td>
                      <td className="mono">{nInt(r.m3)}</td>
                      <td className="mono">{nInt(r.mtdUnits)}</td>
                      <td className="mono">{nInt(r.threeMoAvg)}</td>
                      <td className="mono">{nInt(r.mtdProjected)}</td>
                      <td className="mono pt-strong">{nInt(r.targetUnits)}</td>
                      <td className="mono">{nInt(r.fbaAvailable)}</td>
                      <td className="mono">{nInt(r.fbaDaysCover)}</td>
                      <td className="mono">{nInt(r.reserved)}</td>
                      <td className="mono">{nInt(r.inTransit)}</td>
                      {planData.isUS && <td className="mono">{nInt(r.awd)}</td>}
                      <td className="mono">{nInt(r.coverage)}</td>
                      <td className="mono pt-strong">{nInt(r.recommended)}</td>
                      <td>{r.remark ? <span className={"pt-badge " + (r.remark === "Restock" ? "pt-badge-restock" : "pt-badge-ok")}>{r.remark}</span> : "—"}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="plan-totals-row">
                    <td className="pt-id">Totals · {planRows.length} ASIN{planRows.length === 1 ? "" : "s"}</td>
                    <td className="mono">{nInt(planTotals.m1)}</td>
                    <td className="mono">{nInt(planTotals.m2)}</td>
                    <td className="mono">{nInt(planTotals.m3)}</td>
                    <td className="mono">{nInt(planTotals.mtdUnits)}</td>
                    <td className="mono">—</td>
                    <td className="mono">—</td>
                    <td className="mono pt-strong">{nInt(planTotals.targetUnits)}</td>
                    <td className="mono">{planTotals.anyInv ? nInt(planTotals.fbaAvailable) : "—"}</td>
                    <td className="mono">{planTotals.anyInv ? nInt(planTotals.fbaDaysCover) : "—"}</td>
                    <td className="mono">{planTotals.anyInv ? nInt(planTotals.reserved) : "—"}</td>
                    <td className="mono">{planTotals.anyInv ? nInt(planTotals.inTransit) : "—"}</td>
                    {planData.isUS && <td className="mono">{planTotals.anyAwd ? nInt(planTotals.awd) : "—"}</td>}
                    <td className="mono">{planTotals.anyInv ? nInt(planTotals.coverage) : "—"}</td>
                    <td className="mono pt-strong">{planTotals.anyInv ? nInt(planTotals.recommended) : "—"}</td>
                    <td>{planTotals.restockCount > 0 ? `${planTotals.restockCount} restock` : "OK"}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        ) : planData && planRows.length === 0 ? (
          <div className="panel" style={{ marginTop: 14 }}>
            <div className="empty-note">{planSearch ? "No ASINs match your search." : selectedBrand === "ALL" ? "No ASINs found for this account in the reporting window." : "No ASINs match the selected brand."}</div>
          </div>
        ) : !planError ? (
          <div className="panel" style={{ marginTop: 14 }}>
            <div className="empty-note">{planLoading ? "Loading FBA Shipment Plan from DataDoe…" : "No cached data yet. Click refresh to fetch this account's plan from DataDoe."}</div>
          </div>
        ) : null}

        <div className="footer-note">
          Unit sales come from DataDoe <code>Sales &amp; Traffic by ASIN &amp; Date</code> (total_units), summed per ASIN for the 3 completed months and the current month to date.
          Live FBA stock comes from <code>FBA Inventory Health</code>: FBA Available = <code>available</code>; Reserved = <code>reserved_fc_transfer</code> + <code>reserved_fc_processing</code> (customer-order reserve excluded); In Transit = <code>inbound_shipped</code> + <code>inbound_received</code> (working excluded).
          {planData?.isUS ? <> AWD Available = <code>awd_available_distributable_quantity</code> from <code>Listings</code> and is added to coverage for this US account.</> : <> AWD does not apply to non-US accounts and is hidden.</>}
          {" "}Planning Avg = max(3-month avg, MTD projected). Target Units is the number of units needed for the entered coverage days. Total FBA Inv. = FBA Available + Reserved + In Transit{planData?.isUS ? " + AWD Available" : ""}. FBA Days (MTD DRR) = FBA Available divided by MTD daily run rate; it excludes reserved, inbound, and AWD stock. Recommended Shipment = ceil(Target Units − Total FBA Inv.), floored at 0. Live inventory freshness is independent of sales-report freshness; both dates are shown above. Filters, sorting, and the target-days input recompute locally without new DataDoe requests.
        </div>
      </div>
      )}

      {view === "skupl" && (
      <div className="container skupl-page">
        <div className="controls-bar">
          <div>
            <div className="page-title">SKU P&amp;L Analyzer</div>
            <div className="page-sub">Net profit by SKU for {refreshScopeAccount?.name || "the selected account"}{selectedBrand === "ALL" ? "" : ` · ${selectedBrand}`} · {skuPlMonthLabel}{effectiveSkuCurrency ? ` · ${effectiveSkuCurrency}` : ""}</div>
          </div>
          {skuPlData && (
            <div className="recon-month-picker">
              <label htmlFor="skupl-month">Report month</label>
              <select id="skupl-month" value={skuPlMonth || "ALL"} onChange={(e) => setSkuPlMonth(e.target.value)}>
                <option value="ALL">All 6 Months</option>
                {(skuPlData.months || []).map((month) => <option key={month} value={month}>{reconMonthLabel(month)}</option>)}
              </select>
              {skuPlCurrencies.length > 1 && (
                <>
                  <label htmlFor="skupl-currency">Currency</label>
                  <select id="skupl-currency" value={effectiveSkuCurrency} onChange={(e) => setSkuPlCurrency(e.target.value)}>
                    {skuPlCurrencies.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </>
              )}
            </div>
          )}
        </div>

        {skuPlError && <div className="error-banner"><AlertTriangle size={15} /> {skuPlError}</div>}

        {!skuPlData && !skuPlError && (
          <div className="panel recon-empty"><Wallet size={22} /><div>{skuPlLoading ? "Loading SKU P&L from DataDoe…" : "SKU P&L data is loading from cache…"}</div></div>
        )}

        {skuPlData && <>
          <div className="recon-freshness">
            <span className="live-dot" style={{ position: "relative", top: 1 }} />
            <span>Profit by SKU &amp; Date from <strong>{fmtDateHuman(skuPlData.from)}</strong> to <strong>{fmtDateHuman(skuPlData.to)}</strong></span>
            <span className="plan-fresh-sep">·</span>
            <span>cached {skuPlCachedAt?.toLocaleString()}</span>
            {skuPlCurrencies.length > 1 && <><span className="plan-fresh-sep">·</span><span>{skuPlCurrencies.length} currencies — showing {effectiveSkuCurrency}</span></>}
          </div>

          {skuPlComputed.length === 0 ? (
            <div className="panel"><div className="empty-note">{selectedBrand === "ALL" ? "No SKU profit rows for this account in the selected month and currency." : "No SKUs match the selected brand in this month and currency."}</div></div>
          ) : <>
            <div className="skupl-kpis">
              <SkuKpi label="Total Sales" value={fmtMoney(skuPlKpis.sales, effectiveSkuCurrency)} />
              <SkuKpi label="Net Profit" value={fmtMoney(skuPlKpis.profit, effectiveSkuCurrency)} tone={skuPlKpis.profit < 0 ? "bad" : "good"} />
              <SkuKpi label="Blended Margin" value={skuPlKpis.margin === null ? "—" : `${skuPlKpis.margin.toFixed(1)}%`} />
              <SkuKpi label="Units" value={nInt(skuPlKpis.units)} />
              <SkuKpi label="Total Cost" value={fmtMoney(skuPlKpis.cost, effectiveSkuCurrency)} />
              <SkuKpi label="Ad Spend" value={fmtMoney(skuPlKpis.adSpend, effectiveSkuCurrency)} />
              <SkuKpi label="Amazon Fees" value={fmtMoney(skuPlKpis.fees, effectiveSkuCurrency)} />
            </div>

            <div className="skupl-insights">
              <div className="panel">
                <div className="panel-head"><div><div className="panel-title">Top Profit SKUs</div><div className="page-sub">Ranked by net profit, not sales</div></div></div>
                <div className="skupl-rank">
                  {skuPlTopProfit.map((r, i) => (
                    <div className="skupl-rank-row" key={(r.sku || r.asin || "") + i}>
                      <span className="skupl-rank-num">{i + 1}</span>
                      <span className="skupl-rank-name" title={r.productName || r.sku}>
                        {r.productName || r.sku || r.asin}
                        <span className="skupl-rank-sub mono">{r.sku || r.asin}</span>
                      </span>
                      <span className="skupl-rank-val mono">
                        {fmtMoney(r.profit, effectiveSkuCurrency)}
                        <span className="skupl-rank-margin">{r.margin === null ? "" : `${r.margin.toFixed(0)}%`}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="panel">
                <div className="panel-head"><div><div className="panel-title">Profit Leaks</div><div className="page-sub">Fix first · {skuPlStatusCounts.loss + skuPlStatusCounts.cogs + skuPlStatusCounts.ad + skuPlStatusCounts.thin} flagged</div></div></div>
                <div className="skupl-leaks">
                  {skuPlLeaks.length === 0 ? <div className="empty-note">No profit leaks flagged in this scope.</div> :
                    skuPlLeaks.map((r, i) => (
                      <div className="skupl-leak-row" key={(r.sku || r.asin || "") + i}>
                        <div className="skupl-leak-head">
                          <span className={"pt-badge sku-badge-" + r.status.tone}>{r.status.label}</span>
                          <span className="skupl-leak-name" title={r.productName || r.sku}>{r.productName || r.sku || r.asin}</span>
                          <span className={"mono skupl-leak-profit" + (r.profit < 0 ? " sku-neg" : "")}>{fmtMoney(r.profit, effectiveSkuCurrency)}</span>
                        </div>
                        <div className="skupl-leak-action">{r.status.action}</div>
                      </div>
                    ))}
                </div>
              </div>
            </div>

            <div className="panel skupl-table-panel" style={{ padding: 0, overflow: "hidden" }}>
              <div className="skupl-toolbar">
                <label className="plan-field skupl-search">
                  <span className="plan-field-label">Search</span>
                  <span className="plan-search-wrap"><Search size={14} /><input value={skuPlSearch} onChange={(e) => setSkuPlSearch(e.target.value)} placeholder="SKU, ASIN, product, or brand" /></span>
                </label>
                <label className="plan-field">
                  <span className="plan-field-label">Status</span>
                  <select value={skuPlStatusFilter} onChange={(e) => setSkuPlStatusFilter(e.target.value)}>
                    {["ALL", "loss", "cogs", "ad", "thin", "ok"].map((k) => <option key={k} value={k}>{skuPlStatusOptionLabel(k)}{k !== "ALL" ? ` (${skuPlStatusCounts[k] || 0})` : ""}</option>)}
                  </select>
                </label>
                <div className="skupl-toolbar-spacer" />
                <button className="plan-export-btn" onClick={() => downloadSkuPlCsv(skuPlSorted, effectiveSkuCurrency, skuPlMonthLabel, refreshScopeAccount?.name)} disabled={!skuPlSorted.length}><Download size={15} />Download CSV</button>
              </div>
              <div className="plan-scroll">
                <table className="plan-table skupl-table">
                  <thead>
                    <tr>
                      <PlanTh className="pt-id" label="Product / SKU" col="productName" sort={skuPlSort} onSort={setSkuPlSortKey} align="left" />
                      <PlanTh label="Sales" col="sales" sort={skuPlSort} onSort={setSkuPlSortKey} />
                      <PlanTh label="Profit" col="profit" sort={skuPlSort} onSort={setSkuPlSortKey} />
                      <PlanTh label="Margin %" col="margin" sort={skuPlSort} onSort={setSkuPlSortKey} />
                      <PlanTh label="Units" col="units" sort={skuPlSort} onSort={setSkuPlSortKey} />
                      <PlanTh label="Total Cost" col="cost" sort={skuPlSort} onSort={setSkuPlSortKey} />
                      <PlanTh label="Amazon Fees" col="fees" sort={skuPlSort} onSort={setSkuPlSortKey} />
                      <PlanTh label="Ad Spend" col="adSpend" sort={skuPlSort} onSort={setSkuPlSortKey} />
                      <PlanTh label="COGS" col="cogs" sort={skuPlSort} onSort={setSkuPlSortKey} />
                      <PlanTh label="Ad/Sales %" col="adSalesRatio" sort={skuPlSort} onSort={setSkuPlSortKey} />
                      <PlanTh label="Status" col="status" sort={skuPlSort} onSort={setSkuPlSortKey} align="left" />
                    </tr>
                  </thead>
                  <tbody>
                    {skuPlPageRows.map((r, i) => (
                      <tr key={(r.sku || r.asin || "") + i} className={r.status.key === "loss" ? "skupl-row-loss" : ""}>
                        <td className="pt-id">
                          <div className="pt-name" title={r.productName || r.sku}>{r.productName || "(no product name)"}</div>
                          <div className="pt-meta mono">{r.sku || "—"}{r.asin ? ` · ${r.asin}` : ""}</div>
                          {r.brand && <div className="pt-brand">{r.brand}</div>}
                        </td>
                        <td className="mono">{fmtMoney(r.sales, effectiveSkuCurrency)}</td>
                        <td className={"mono pt-strong" + (r.profit < 0 ? " sku-neg" : "")}>{fmtMoney(r.profit, effectiveSkuCurrency)}</td>
                        <td className="mono">{r.margin === null ? "—" : `${r.margin.toFixed(1)}%`}</td>
                        <td className="mono">{nInt(r.units)}</td>
                        <td className="mono">{fmtMoney(r.cost, effectiveSkuCurrency)}</td>
                        <td className="mono">{fmtMoney(r.fees, effectiveSkuCurrency)}</td>
                        <td className="mono">{fmtMoney(r.adSpend, effectiveSkuCurrency)}</td>
                        <td className={"mono" + (r.cogsMissing ? " sku-warn" : "")}>{r.cogsMissing ? "missing" : fmtMoney(r.cogs, effectiveSkuCurrency)}</td>
                        <td className="mono">{r.adSalesRatio === null ? "—" : `${r.adSalesRatio.toFixed(1)}%`}</td>
                        <td><span className={"pt-badge sku-badge-" + r.status.tone} title={r.status.action || ""}>{r.status.label}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!skuPlPageRows.length && <div className="empty-note" style={{ padding: "14px 16px" }}>No SKUs match these filters.</div>}
              <div className="recon-pagination">
                <button disabled={skuPlSafePage === 1} onClick={() => setSkuPlPage((page) => Math.max(1, page - 1))}>Prev</button>
                {skuPlPages.map((page, index) => <React.Fragment key={page}>{index > 0 && page - skuPlPages[index - 1] > 1 && <span>…</span>}<button className={page === skuPlSafePage ? "active" : ""} onClick={() => setSkuPlPage(page)}>{page}</button></React.Fragment>)}
                <button disabled={skuPlSafePage === skuPlPageCount} onClick={() => setSkuPlPage((page) => Math.min(skuPlPageCount, page + 1))}>Next</button>
              </div>
            </div>
          </>}

          <div className="footer-note">
            Profit comes straight from DataDoe <code>Profit by SKU &amp; Date</code> (the <code>profit</code> column), which already blends settlements, COGS, and ad spend — it is not rebuilt from raw orders. Sales, Profit, Total Cost, Ad Spend, Amazon Fees, COGS, and Units are summed per SKU; every ratio (Margin %, Ad/Sales %, Blended Margin) is recomputed from those sums, never averaged. <strong>Ad/Sales %</strong> = ad spend ÷ total sales (this report does not aggregate ad sales, so it is not classic ACoS). Currencies are never combined; when an account reports more than one, use the currency selector. This report always uses six <strong>full</strong> calendar months because Amazon fees settle in batches by settlement date, so a partial month can badly misstate profit. A “Check COGS” flag means COGS is zero/missing, so that SKU’s margin is overstated — verify COGS before trusting it. Month, currency, brand, search, sort, filter, and CSV export all run locally; only Refresh calls DataDoe.
          </div>
        </>}
      </div>
      )}

      {view === "contentchanges" && (
      <div className="container content-changes-page">
        <div className="controls-bar">
          <div>
            <div className="page-title">Content Change Alerts</div>
            <div className="page-sub">Amazon A+ and branded-item content changes for {refreshScopeAccount?.name || "the selected account"}{selectedBrand === "ALL" ? "" : ` / ${selectedBrand}`}</div>
          </div>
          {contentChangesData && <button className="plan-export-btn" onClick={() => downloadContentChangesCsv(contentChangeEvents, refreshScopeAccount?.name)} disabled={!contentChangeEvents.length}><Download size={15} />Download CSV</button>}
        </div>

        {contentChangesError && <div className="error-banner"><AlertTriangle size={15} /> {contentChangesError}</div>}

        {!contentChangesData && !contentChangesError && (
          <div className="panel recon-empty"><BellRing size={22} /><div>{contentChangesLoading ? "Loading content alerts from DataDoe..." : "Content alerts are loading from cache..."}</div></div>
        )}

        {contentChangesData && <>
          <div className="recon-freshness">
            <span className="live-dot" style={{ position: "relative", top: 1 }} />
            <span>Latest events delivered by DataDoe</span>
            <span className="plan-fresh-sep">/</span>
            <span>cached {contentChangesCachedAt?.toLocaleString()}</span>
            <span className="plan-fresh-sep">/</span>
            <span>Amazon may publish these notifications within about 2 hours of the content change</span>
          </div>

          <div className="recon-kpis">
            <ReconKpi label="Events" value={contentChangeStats.total.toLocaleString("en-US")} note="Cached account total" />
            <ReconKpi label="ASIN-linked" value={contentChangeStats.asinLinked.toLocaleString("en-US")} note="ASIN extracted from payload" />
            <ReconKpi label="Brand-attributed" value={contentChangeStats.brandLinked.toLocaleString("en-US")} note="Matched to product catalog" />
            <ReconKpi label="Latest event" value={contentChangeStats.latest ? new Date(contentChangeStats.latest).toLocaleDateString() : "-"} note={contentChangeStats.latest ? new Date(contentChangeStats.latest).toLocaleTimeString() : "No events returned"} />
          </div>

          {selectedBrand !== "ALL" && contentChangesData.unassignedEvents > 0 && (
            <div className="recon-notice"><Info size={15} /> Events without an ASIN-to-brand catalog match are excluded while a specific brand is selected. Select All Brands to review those unassigned events.</div>
          )}

          <div className="panel content-alerts-panel">
            <div className="panel-head"><div><div className="panel-title">Notification Feed</div><div className="page-sub">{contentChangeEvents.length.toLocaleString("en-US")} matching events. Search and filters work locally.</div></div></div>
            <div className="recon-filters">
              <label className="plan-field recon-search"><span className="plan-field-label">Search</span><span className="plan-search-wrap"><Search size={14} /><input value={contentChangesSearch} onChange={(e) => setContentChangesSearch(e.target.value)} placeholder="ASIN, brand, notification ID, or payload..." /></span></label>
              <label className="plan-field recon-select"><span className="plan-field-label">Event type</span><select value={contentChangesType} onChange={(e) => setContentChangesType(e.target.value)}><option value="ALL">All types</option>{contentChangeTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
            </div>
            <div className="recon-table-scroll"><table className="recon-table content-alerts-table"><thead><tr><th>Event time</th><th>Type</th><th>ASINs</th><th>Brands</th><th>Notification ID</th><th>Details</th></tr></thead><tbody>{contentChangeEvents.map((event, index) => <tr key={event.notificationId || `${event.eventTime}-${index}`}><td>{event.eventTime ? new Date(event.eventTime).toLocaleString() : "-"}</td><td>{event.notificationType || "-"}</td><td className="mono">{event.asins?.length ? event.asins.join(", ") : "-"}</td><td>{event.brands?.length ? event.brands.join(", ") : "Unassigned"}</td><td className="mono">{event.notificationId || "-"}</td><td><span className="content-preview" title={event.payloadPreview || event.metadataPreview || ""}>{event.metadataPreview || event.payloadPreview || "-"}</span></td></tr>)}</tbody></table></div>
            {!contentChangeEvents.length && <div className="empty-note">{selectedBrand === "ALL" ? "No content change events were returned for this account." : "No content change events match the selected brand."}</div>}
          </div>

          <div className="footer-note">Data powered by DataDoe <code>Branded Item Content Change Notifications</code>. This is a monitoring feed for Amazon A+ / branded-item content changes, not a sales or catalog history report. Amazon's payload schema can vary; the dashboard extracts ASINs from the payload and joins them to the Product Catalog before applying the shared brand filter. Events without an identifiable or catalog-mapped ASIN remain visible only under Select All Brands. Opening this report reads the browser cache; only Refresh calls DataDoe.</div>
        </>}
      </div>
      )}
        </div>
      </div>
    </div>
  );
}

// KPI card for the SKU P&L Analyzer.
function SkuKpi({ label, value, tone }) {
  return <div className="skupl-kpi"><div className="skupl-kpi-label">{label}</div><div className={"skupl-kpi-value mono" + (tone === "bad" ? " sku-neg" : tone === "good" ? " sku-pos" : "")}>{value}</div></div>;
}

// Sortable header cell for the plan table.
function PlanTh({ label, col, sort, onSort, align = "right", className = "" }) {
  const active = sort.key === col;
  return (
    <th
      className={`${className} ${align === "left" ? "pt-left" : ""} pt-sortable ${active ? "pt-sorted" : ""}`}
      onClick={() => onSort(col)}
      title="Click to sort"
    >
      <span className="pt-th-inner">
        {label}
        {active ? (sort.dir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : <ArrowUpDown size={12} className="pt-th-idle" />}
      </span>
    </th>
  );
}

function ReconKpi({ label, value, note }) {
  return <div className="recon-kpi"><div className="recon-kpi-label">{label}</div><div className="recon-kpi-value mono">{value}</div><div className="recon-kpi-note">{note}</div></div>;
}

function ReconSelect({ label, value, onChange, options }) {
  return <label className="plan-field recon-select"><span className="plan-field-label">{label}</span><select value={value} onChange={(e) => onChange(e.target.value)}>{options.map((option) => <option key={option} value={option}>{option === "ALL" ? "All" : option === "YES" ? "Yes" : option === "NO" ? "No" : option === "SAME" ? "Same month" : option === "CROSS" ? "Cross-month only" : option}</option>)}</select></label>;
}

function ReconTh({ label, col, sort, setSort, align = "right" }) {
  const active = sort.key === col;
  return <th className={align === "left" ? "recon-left" : ""} onClick={() => setSort((previous) => ({ key: col, dir: previous.key === col && previous.dir === "asc" ? "desc" : "asc" }))} title="Click to sort"><span>{label}{active ? (sort.dir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : <ArrowUpDown size={12} />}</span></th>;
}

// Rows of the Daily Reporting table, in display order. Ad-derived rows fall
// back to "—" until advertising data is present on the fetched rows.
const DAILY_METRICS = [
  { key: "sales", label: "Total Sales", fmt: (c, cur) => fmtMoney(c.sales, cur) },
  { key: "adSales", label: "Ad Sales", fmt: (c, cur) => (c.hasAd ? fmtMoney(c.adSales, cur) : "—") },
  { key: "adSpend", label: "Ad Spends", fmt: (c, cur) => (c.hasAd ? fmtMoney(c.adSpend, cur) : "—") },
  { key: "clicks", label: "Clicks", fmt: (c) => (c.hasAd ? c.clicks.toLocaleString("en-US") : "—") },
  { key: "units", label: "Units", fmt: (c) => c.units.toLocaleString("en-US") },
  { key: "roi", label: "ROI", highlight: true, fmt: (c) => (c.hasAd && c.adSpend > 0 ? (c.adSales / c.adSpend).toFixed(1) : "—") },
  { key: "acos", label: "ACoS %", fmt: (c) => (c.hasAd && c.adSales > 0 ? (c.adSpend / c.adSales * 100).toFixed(1) + "%" : "—") },
  { key: "tacos", label: "TACoS %", fmt: (c) => (c.hasAd && c.sales > 0 ? (c.adSpend / c.sales * 100).toFixed(1) + "%" : "—") },
];

const STYLE = `
@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
:root{ --bg:#F6F7FB; --surface:#FFFFFF; --ink:#12172B; --ink-soft:#5B6178; --border:#E3E6EE; --accent:#F2A93B; --accent-deep:#C97F1D; --pos:#1E8E5A; --neg:#D64545; --grid-line:#EBEDF3; }
*{ box-sizing:border-box; }
html,body,#root{ margin:0; padding:0; height:100%; }
.dash-root{ font-family:'Manrope',-apple-system,'Segoe UI',sans-serif; background:var(--bg); color:var(--ink); min-height:100vh; padding-bottom:20px; }
.mono{ font-family:'JetBrains Mono', ui-monospace, monospace; font-variant-numeric: tabular-nums; }
.loading-screen{ display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; font-family:'Manrope',sans-serif; color:var(--ink-soft); text-align:center; padding:24px; }
.cache-refresh-btn{ margin-top:14px; border:1px solid var(--border); background:var(--surface); border-radius:8px; padding:8px 12px; cursor:pointer; display:inline-flex; align-items:center; gap:8px; color:var(--ink); font-family:inherit; font-size:13px; font-weight:700; }
.cache-refresh-btn:hover{ border-color:var(--accent-deep); color:var(--accent-deep); }
.cache-refresh-btn:disabled{ cursor:not-allowed; opacity:.65; }

/* ---- Sidebar shell ---- */
.app-shell{ display:flex; align-items:stretch; min-height:100vh; }
.sidebar{ width:250px; flex-shrink:0; background:var(--surface); border-right:1px solid var(--border); display:flex; flex-direction:column; position:sticky; top:0; height:100vh; z-index:40; transition:width .18s ease; }
.sidebar.collapsed{ width:74px; }
.sb-brand{ display:flex; align-items:center; gap:11px; padding:0 16px; min-height:65px; border-bottom:1px solid var(--border); }
.sb-logo{ width:36px; height:36px; flex-shrink:0; border-radius:9px; background:var(--ink); color:#fff; font-family:'JetBrains Mono',monospace; font-weight:700; font-size:14px; letter-spacing:.02em; display:flex; align-items:center; justify-content:center; }
.sb-brand-text{ display:flex; flex-direction:column; min-width:0; }
.sb-ws-name{ font-size:13.5px; font-weight:800; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.sb-ws-sub{ font-size:11px; color:var(--ink-soft); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.sidebar.collapsed .sb-brand{ justify-content:center; padding:0; }
.sidebar.collapsed .sb-brand-text{ display:none; }
.sb-close{ display:none; margin-left:auto; border:none; background:transparent; color:var(--ink-soft); cursor:pointer; padding:5px; border-radius:6px; }
.sb-close:hover{ background:#F1F2F6; color:var(--ink); }
.sb-nav{ display:flex; flex-direction:column; gap:3px; padding:12px 10px; flex:1; overflow-y:auto; }
.sb-nav-item{ display:flex; align-items:center; gap:11px; width:100%; padding:9px 11px; border:none; background:transparent; border-radius:9px; font-size:13.5px; font-weight:700; color:var(--ink-soft); cursor:pointer; font-family:inherit; text-align:left; }
.sb-nav-item svg{ flex-shrink:0; }
.sb-nav-item:hover{ background:#F1F2F6; color:var(--ink); }
.sb-nav-item.active{ background:#FEF3E2; color:var(--accent-deep); }
.sidebar.collapsed .sb-nav-item{ justify-content:center; padding:9px; }
.sidebar.collapsed .sb-nav-label{ display:none; }
.sb-footer{ padding:10px; border-top:1px solid var(--border); }
.sb-collapse{ display:flex; align-items:center; gap:11px; width:100%; padding:9px 11px; border:none; background:transparent; border-radius:9px; font-size:12.5px; font-weight:700; color:var(--ink-soft); cursor:pointer; font-family:inherit; }
.sb-collapse:hover{ background:#F1F2F6; color:var(--ink); }
.sidebar.collapsed .sb-collapse{ justify-content:center; padding:9px; }
.main-area{ flex:1; min-width:0; display:flex; flex-direction:column; }
.menu-btn{ display:none; border:1px solid var(--border); background:var(--surface); border-radius:8px; padding:6px 8px; cursor:pointer; color:var(--ink); align-items:center; }
.sb-backdrop{ display:none; }

.topbar{ display:flex; align-items:center; justify-content:space-between; gap:16px; padding:16px 28px; background:var(--surface); border-bottom:1px solid var(--border); flex-wrap:wrap; }
.brandmark{ display:flex; align-items:center; gap:10px; }
.brandmark .mark{ font-family:'JetBrains Mono',monospace; font-weight:700; letter-spacing:.06em; background:var(--ink); color:#fff; padding:5px 9px; border-radius:6px; font-size:13px; }
.brandmark .sub{ font-size:12.5px; color:var(--ink-soft); }
.topbar-filters{ display:flex; align-items:center; gap:8px; margin-left:auto; min-width:0; }
.topbar-account-select{ flex-shrink:1; min-width:0; }
.topbar-account-select select{ min-width:280px; max-width:390px; }
.topbar-brand-select{ flex-shrink:1; min-width:0; }
.topbar-brand-select select{ min-width:210px; max-width:280px; }
.live-wrap{ display:flex; align-items:center; gap:8px; font-size:12px; color:var(--ink-soft); }
.live-dot{ width:8px; height:8px; border-radius:50%; background:var(--pos); animation:pulse 2s infinite; }
.refresh-btn{ border:1px solid var(--border); background:var(--surface); border-radius:7px; padding:5px 7px; cursor:pointer; display:flex; align-items:center; color:var(--ink-soft); }
.spin{ animation:spin 1s linear infinite; }
@keyframes spin{ from{transform:rotate(0deg);} to{transform:rotate(360deg);} }
@keyframes pulse{ 0%{box-shadow:0 0 0 0 rgba(30,142,90,.45);} 70%{box-shadow:0 0 0 6px rgba(30,142,90,0);} 100%{box-shadow:0 0 0 0 rgba(30,142,90,0);} }
.container{ width:100%; max-width:1240px; margin:0 auto; padding:22px 24px 0; min-width:0; }
.tabs{ display:inline-flex; background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:4px; gap:2px; }
.tab{ border:none; background:transparent; padding:8px 16px; font-size:13.5px; font-weight:700; color:var(--ink-soft); border-radius:9px; cursor:pointer; font-family:inherit; }
.tab.active{ background:var(--ink); color:#fff; }
.controls-bar{ display:flex; align-items:center; justify-content:space-between; gap:16px; margin-top:16px; flex-wrap:wrap; }
.dashboard-controls{ justify-content:flex-end; }
.chip-row{ display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
.chip{ border:1px solid var(--border); background:var(--surface); padding:6px 12px; font-size:12.5px; font-weight:700; border-radius:8px; cursor:pointer; color:var(--ink-soft); font-family:inherit; }
.chip.active{ border-color:var(--accent-deep); background:#FEF3E2; color:var(--accent-deep); }
.select{ position:relative; display:inline-flex; align-items:center; }
.select select{ appearance:none; border:1px solid var(--border); background:var(--surface); padding:8px 34px 8px 12px; border-radius:9px; font-size:13px; font-weight:700; color:var(--ink); font-family:inherit; cursor:pointer; min-width:230px; }
.select svg{ position:absolute; right:10px; pointer-events:none; color:var(--ink-soft); }
.brand-panel{ margin-top:14px; background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:14px 16px; }
.brand-panel-head{ display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-wrap:wrap; gap:8px; }
.badge-count{ font-size:11.5px; font-weight:700; color:var(--accent-deep); background:#FEF3E2; padding:3px 9px; border-radius:999px; }
.check-grid{ display:flex; flex-wrap:wrap; gap:10px; }
.check-item{ display:flex; align-items:center; gap:7px; font-size:13px; font-weight:600; border:1px solid var(--border); padding:6px 10px; border-radius:9px; cursor:pointer; background:#FBFBFD; }
.check-item input{ accent-color:var(--accent-deep); }
.reset-link{ font-size:12px; color:var(--accent-deep); background:none; border:none; cursor:pointer; font-weight:700; font-family:inherit; }
.custom-range{ display:flex; gap:8px; align-items:center; }
.custom-range input[type=date]{ border:1px solid var(--border); border-radius:8px; padding:6px 8px; font-size:12.5px; font-family:inherit; }
.error-banner{ margin-top:14px; background:#FDECEC; border:1px solid #F3C4C4; color:#9A2E2E; border-radius:10px; padding:10px 14px; font-size:13px; display:flex; align-items:center; gap:8px; }
.kpi-grid{ display:grid; grid-template-columns:repeat(4,1fr); gap:14px; margin-top:18px; }
.kpi-card{ background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:16px 18px; }
.kpi-label{ font-size:11.5px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; color:var(--ink-soft); }
.kpi-value{ font-size:25px; font-weight:700; margin-top:8px; letter-spacing:-0.01em; }
.kpi-period{ font-size:11.5px; color:var(--ink-soft); margin-top:4px; }
.compare-row{ display:grid; grid-template-columns:repeat(4,1fr); gap:14px; margin-top:14px; }
.compare-chip{ background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:13px 16px; }
.compare-chip .clabel{ font-size:11.5px; color:var(--ink-soft); font-weight:700; text-transform:uppercase; letter-spacing:.04em; }
.compare-chip .cval{ display:flex; align-items:center; gap:6px; font-size:18px; font-weight:700; margin-top:6px; font-family:'JetBrains Mono',monospace; }
.compare-chip .cnote{ font-size:11px; color:var(--ink-soft); margin-top:3px; }
.up{ color:var(--pos); } .down{ color:var(--neg); } .flat{ color:var(--ink-soft); }
.panel{ background:var(--surface); border:1px solid var(--border); border-radius:16px; padding:18px 20px; margin-top:18px; }
.panel-head{ display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; flex-wrap:wrap; gap:8px; }
.panel-title{ font-size:15px; font-weight:700; }
.seg{ display:inline-flex; background:#F1F2F6; border-radius:8px; padding:3px; }
.seg button{ border:none; background:transparent; padding:5px 12px; font-size:12px; font-weight:700; border-radius:6px; cursor:pointer; color:var(--ink-soft); font-family:inherit; }
.seg button.active{ background:#fff; color:var(--ink); box-shadow:0 1px 2px rgba(0,0,0,.08); }
.chart-wrap{ height:280px; margin-top:10px; }
.breakdown-grid{ display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:16px; }
.bar-list{ display:flex; flex-direction:column; gap:9px; margin-top:10px; max-height:360px; overflow-y:auto; padding-right:4px; }
.bar-row{ display:grid; grid-template-columns:148px 1fr 118px; align-items:center; gap:10px; font-size:12.5px; }
.bar-row .rlabel{ overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:700; }
.bar-row.active .rlabel{ color:var(--accent-deep); }
.bar-track{ height:8px; background:var(--grid-line); border-radius:5px; overflow:hidden; }
.bar-fill{ height:100%; background:#C9CEDC; border-radius:5px; }
.bar-fill.active{ background:var(--accent); }
.rvalue{ text-align:right; font-weight:700; white-space:nowrap; }
.empty-note{ font-size:12.5px; color:var(--ink-soft); padding:12px 0; }
.disclosure{ margin-top:14px; font-size:12px; color:var(--ink-soft); background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:12px 16px; }
.disclosure summary{ cursor:pointer; font-weight:700; color:var(--ink); }
.native-row{ display:flex; justify-content:space-between; padding:5px 0; border-bottom:1px dashed var(--border); font-size:12.5px; }
.native-row:last-child{ border-bottom:none; }
.footer-note{ margin-top:18px; font-size:11.5px; color:var(--ink-soft); line-height:1.6; padding:14px 4px 6px; }
.footer-note code{ font-family:'JetBrains Mono',monospace; font-size:11px; background:#F1F2F6; padding:1px 5px; border-radius:5px; }

/* ---- Daily Reporting table ---- */
.page-title{ font-size:19px; font-weight:800; letter-spacing:-0.01em; }
.page-sub{ font-size:12px; color:var(--ink-soft); margin-top:2px; }
.daily-scroll{ margin-top:12px; overflow-x:auto; -webkit-overflow-scrolling:touch; }
.daily-table{ border-collapse:separate; border-spacing:0; width:100%; font-size:12.5px; min-width:760px; }
.daily-table th, .daily-table td{ padding:9px 12px; text-align:right; white-space:nowrap; border-bottom:1px solid var(--border); }
.daily-table thead th{ font-size:11px; font-weight:700; color:var(--ink-soft); text-transform:uppercase; letter-spacing:.03em; border-bottom:1px solid var(--border); background:var(--surface); }
.daily-table th.dt-metric, .daily-table td.dt-metric{ text-align:left; font-weight:700; position:sticky; left:0; background:var(--surface); z-index:1; }
.daily-table td.dt-metric{ color:var(--ink); }
.daily-table th.dt-month, .daily-table td.dt-month{ background:#F3F6FC; }
.daily-table th.dt-mtd, .daily-table td.dt-mtd{ background:#FEF3E2; color:var(--accent-deep); font-weight:700; border-left:1px solid var(--border); border-right:2px solid var(--border); }
.daily-table tbody tr:hover td:not(.dt-mtd){ background:#FAFBFD; }
.daily-table tr.dt-row-highlight td{ background:#FBEFD8; font-weight:700; }
.daily-table tr.dt-row-highlight td.dt-mtd{ background:#F7E2BE; }
.daily-table tr.dt-row-highlight td.dt-metric{ background:#FBEFD8; }

/* ---- FBA Shipment Plan ---- */
.plan-controls{ display:flex; gap:14px; align-items:flex-end; flex-wrap:wrap; margin-top:14px; }
.plan-field{ display:flex; flex-direction:column; gap:5px; }
.plan-field-label{ font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; color:var(--ink-soft); }
.plan-field input[type=number]{ border:1px solid var(--border); border-radius:9px; padding:8px 12px; font-size:13px; font-weight:700; font-family:inherit; color:var(--ink); width:130px; }
.plan-search{ flex:1; min-width:200px; }
.plan-search-wrap{ display:flex; align-items:center; gap:8px; border:1px solid var(--border); border-radius:9px; padding:0 12px; background:var(--surface); }
.plan-search-wrap svg{ color:var(--ink-soft); flex-shrink:0; }
.plan-search-wrap input{ border:none; outline:none; padding:9px 0; font-size:13px; font-family:inherit; color:var(--ink); width:100%; background:transparent; }
.plan-export-btn{ display:inline-flex; align-items:center; justify-content:center; gap:7px; min-height:36px; padding:8px 12px; border:1px solid var(--accent-deep); border-radius:8px; background:var(--surface); color:var(--accent-deep); font:700 13px inherit; cursor:pointer; white-space:nowrap; }
.plan-export-btn:hover:not(:disabled){ background:#FEF3E2; }
.plan-export-btn:disabled{ opacity:.5; cursor:not-allowed; }
.plan-freshness{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-top:14px; font-size:12px; color:var(--ink-soft); }
.plan-freshness strong{ color:var(--ink); font-weight:700; }
.plan-fresh-sep{ color:var(--border); }
.plan-stat-row{ display:grid; grid-template-columns:repeat(5,1fr); gap:12px; margin-top:14px; }
.plan-stat{ background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:12px 14px; }
.plan-stat-label{ font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; color:var(--ink-soft); }
.plan-stat-value{ font-size:20px; font-weight:700; margin-top:5px; }
.plan-scroll{ overflow-x:auto; -webkit-overflow-scrolling:touch; }
.plan-table{ border-collapse:separate; border-spacing:0; width:100%; font-size:12.5px; min-width:1080px; }
.plan-table th, .plan-table td{ padding:9px 11px; text-align:right; white-space:nowrap; border-bottom:1px solid var(--border); }
.plan-table thead th{ font-size:10.5px; font-weight:700; color:var(--ink-soft); text-transform:uppercase; letter-spacing:.03em; background:#FAFBFD; position:sticky; top:0; z-index:2; }
.plan-table th.pt-left, .plan-table td.pt-left{ text-align:left; }
.plan-table .pt-sortable{ cursor:pointer; user-select:none; }
.plan-table .pt-sortable:hover{ color:var(--ink); }
.plan-table th.pt-sorted{ color:var(--accent-deep); }
.pt-th-inner{ display:inline-flex; align-items:center; gap:4px; }
.pt-th-inner .pt-th-idle{ opacity:.4; }
.plan-table th.pt-id, .plan-table td.pt-id{ text-align:left; position:sticky; left:0; background:var(--surface); z-index:1; min-width:230px; max-width:300px; border-right:1px solid var(--border); }
.plan-table thead th.pt-id{ z-index:3; background:#FAFBFD; }
.pt-name{ font-weight:700; color:var(--ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:280px; }
.pt-meta{ font-size:11px; color:var(--ink-soft); margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:280px; }
.pt-brand{ font-size:11px; color:var(--accent-deep); font-weight:700; margin-top:2px; }
.plan-table td.pt-strong{ font-weight:700; color:var(--ink); }
.plan-table tbody tr:hover td{ background:#FAFBFD; }
.plan-table tbody tr:hover td.pt-id{ background:#F4F6FA; }
.plan-table tr.plan-restock td{ background:#FEF3E2; }
.plan-table tr.plan-restock td.pt-id{ background:#FDEBCB; box-shadow:inset 3px 0 0 var(--accent); }
.plan-table tr.plan-restock:hover td{ background:#FCEBCF; }
.pt-badge{ display:inline-block; font-size:11px; font-weight:700; padding:3px 9px; border-radius:999px; }
.pt-badge-restock{ background:#FCE4C4; color:#8A5A12; }
.pt-badge-ok{ background:#E6F2EB; color:var(--pos); }
.plan-table tfoot td{ position:sticky; bottom:0; background:#F1F2F6; font-weight:700; border-top:1px solid var(--border); border-bottom:none; z-index:1; }
.plan-table tfoot td.pt-id{ background:#F1F2F6; z-index:2; }

/* ---- Amazon Reconciliation ---- */
.reconciliation-page{ padding-bottom:30px; }
.recon-month-picker{ display:flex; align-items:center; gap:8px; border:1px solid var(--border); background:var(--surface); border-radius:8px; padding:7px 10px; }
.recon-month-picker label{ font-size:11px; font-weight:700; color:var(--ink-soft); text-transform:uppercase; letter-spacing:.04em; }
.recon-month-picker select,.recon-select select{ border:0; outline:0; background:transparent; color:var(--ink); font:700 13px inherit; }
.recon-freshness{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-top:14px; font-size:12px; color:var(--ink-soft); }
.recon-freshness strong{ color:var(--ink); }
.recon-notice{ display:flex; align-items:flex-start; gap:8px; margin-top:12px; padding:10px 12px; border:1px solid #F3D9A8; border-radius:8px; background:#FEF3E2; color:#7B5413; font-size:12px; line-height:1.45; }
.recon-notice svg{ flex:none; margin-top:1px; }
.recon-empty{ min-height:200px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; color:var(--ink-soft); margin-top:14px; }
.recon-kpis{ display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; margin-top:14px; }
.recon-kpi{ border:1px solid var(--border); border-radius:8px; padding:12px 14px; background:var(--surface); min-height:92px; }
.recon-kpi-label{ color:var(--ink-soft); font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; }
.recon-kpi-value{ color:var(--ink); font-size:18px; font-weight:700; margin-top:7px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.recon-kpi-note{ color:var(--ink-soft); font-size:11px; margin-top:5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.recon-chart-grid{ display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-top:14px; }
.recon-chart-panel{ min-height:270px; }
.recon-chart-wrap{ height:205px; }
.recon-donut-wrap{ height:205px; display:flex; align-items:center; }
.recon-donut-legend{ display:flex; flex-direction:column; gap:9px; width:42%; font-size:12px; color:var(--ink-soft); }
.recon-donut-legend div{ display:grid; grid-template-columns:9px 1fr auto; align-items:center; gap:7px; }
.recon-donut-legend span{ width:8px; height:8px; border-radius:999px; }
.recon-donut-legend strong{ color:var(--ink); font-family:'JetBrains Mono',monospace; }
.recon-overlay-panel,.recon-waterfall-panel,.recon-daily-panel,.recon-explorer-panel{ margin-top:14px; }
.recon-overlay-wrap{ height:290px; }
.recon-waterfall{ display:flex; flex-direction:column; gap:9px; }
.recon-waterfall-row{ display:grid; grid-template-columns:130px minmax(90px,1fr) 130px; gap:10px; align-items:center; font-size:12px; }
.recon-waterfall-row > span{ color:var(--ink-soft); }
.recon-waterfall-row > strong{ font-family:'JetBrains Mono',monospace; text-align:right; font-size:11.5px; }
.recon-waterfall-track{ height:10px; border-radius:3px; overflow:hidden; background:#EEF1F6; }
.recon-waterfall-fill{ height:100%; min-width:2px; border-radius:3px; }
.recon-waterfall-fill.positive{ background:#149B67; }.recon-waterfall-fill.negative{ background:#DF5960; }.recon-waterfall-fill.net{ background:#3F84C5; }
.recon-table-scroll{ overflow-x:auto; -webkit-overflow-scrolling:touch; }
.recon-daily-table,.recon-table{ border-collapse:separate; border-spacing:0; width:100%; font-size:12px; min-width:760px; }
.recon-daily-table th,.recon-daily-table td,.recon-table th,.recon-table td{ padding:9px 10px; text-align:right; white-space:nowrap; border-bottom:1px solid var(--border); }
.recon-daily-table th,.recon-table th{ color:var(--ink-soft); font-size:10.5px; font-weight:700; letter-spacing:.03em; text-transform:uppercase; background:#FAFBFD; }
.recon-daily-table th:first-child,.recon-daily-table td:first-child,.recon-table th.recon-left,.recon-table td:first-child{ text-align:left; }
.recon-table{ min-width:1720px; }
.recon-table th{ cursor:pointer; user-select:none; position:sticky; top:0; z-index:1; }
.recon-table th span{ display:inline-flex; align-items:center; gap:4px; }
.recon-table th:hover{ color:var(--ink); }
.recon-table tbody tr:hover td{ background:#FAFBFD; }
.recon-row-pending td:first-child{ box-shadow:inset 3px 0 #E69B28; }.recon-row-cancelled td:first-child{ box-shadow:inset 3px 0 #DF5960; }.recon-row-refunded td:first-child,.recon-row-settled-refunded td:first-child{ box-shadow:inset 3px 0 #3F84C5; }.recon-row-settled td:first-child{ box-shadow:inset 3px 0 #149B67; }
.content-alerts-table{ min-width:1180px; }.content-alerts-table th:first-child,.content-alerts-table td:first-child{ text-align:left; }.content-preview{ display:block; max-width:360px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--ink-soft); }
.recon-order-id button{ display:inline-flex; align-items:center; gap:5px; border:0; padding:0; background:transparent; color:#244E8A; cursor:pointer; font:600 11px 'JetBrains Mono',monospace; }
.recon-order-id button:hover{ text-decoration:underline; }
.recon-badge,.recon-cross-badge{ display:inline-block; border-radius:999px; padding:3px 7px; font-size:10.5px; font-weight:700; }
.recon-badge.settled{ background:#E6F2EB; color:#087D50; }.recon-badge.pending{ background:#FEF0D9; color:#95600B; }.recon-badge.cancelled{ background:#FCE6E7; color:#B43D44; }.recon-badge.refunded,.recon-badge.settled-refunded{ background:#E6F0FA; color:#2A639B; }.recon-cross-badge{ border:1px solid #EDA73C; color:#965A07; background:#FFF8E9; }
.recon-filters{ display:flex; flex-wrap:wrap; align-items:flex-end; gap:10px; margin:0 0 14px; }
.recon-search{ flex:1; min-width:230px; }.recon-select{ min-width:118px; }.recon-select select{ border:1px solid var(--border); border-radius:8px; padding:8px 10px; background:var(--surface); }
.recon-filters input[type=date]{ border:1px solid var(--border); border-radius:8px; padding:8px 9px; font:600 12px inherit; color:var(--ink); background:var(--surface); }
.recon-pagination{ display:flex; justify-content:flex-end; align-items:center; gap:5px; flex-wrap:wrap; padding-top:12px; }
.recon-pagination button{ min-width:31px; border:1px solid var(--border); border-radius:6px; padding:5px 8px; color:var(--ink-soft); background:var(--surface); font:600 12px inherit; cursor:pointer; }.recon-pagination button.active{ border-color:var(--accent-deep); background:#FEF3E2; color:var(--accent-deep); }.recon-pagination button:disabled{ opacity:.45; cursor:not-allowed; }

/* ---- SKU P&L Analyzer ---- */
.skupl-kpis{ display:grid; grid-template-columns:repeat(7,minmax(0,1fr)); gap:12px; margin-top:14px; }
.skupl-kpi{ background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:12px 13px; }
.skupl-kpi-label{ font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; color:var(--ink-soft); }
.skupl-kpi-value{ font-size:17px; font-weight:700; margin-top:5px; white-space:nowrap; }
.sku-neg{ color:var(--neg); } .sku-pos{ color:var(--pos); } .sku-warn{ color:var(--accent-deep); }
.skupl-insights{ display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:16px; }
.skupl-rank{ display:flex; flex-direction:column; margin-top:6px; }
.skupl-rank-row{ display:grid; grid-template-columns:24px 1fr auto; align-items:center; gap:10px; padding:7px 0; border-bottom:1px solid var(--grid-line); }
.skupl-rank-row:last-child{ border-bottom:none; }
.skupl-rank-num{ font:700 12px 'JetBrains Mono',monospace; color:var(--ink-soft); }
.skupl-rank-name{ min-width:0; font-size:12.5px; font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; display:flex; flex-direction:column; }
.skupl-rank-sub{ font-size:10.5px; color:var(--ink-soft); font-weight:500; overflow:hidden; text-overflow:ellipsis; }
.skupl-rank-val{ text-align:right; font-weight:700; font-size:12.5px; white-space:nowrap; display:flex; flex-direction:column; }
.skupl-rank-margin{ font-size:10.5px; color:var(--ink-soft); font-weight:600; }
.skupl-leaks{ display:flex; flex-direction:column; gap:9px; margin-top:8px; max-height:340px; overflow-y:auto; }
.skupl-leak-row{ border:1px solid var(--border); border-radius:9px; padding:8px 10px; background:#FBFBFD; }
.skupl-leak-head{ display:grid; grid-template-columns:auto 1fr auto; align-items:center; gap:8px; }
.skupl-leak-name{ min-width:0; font-size:12.5px; font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.skupl-leak-profit{ font-weight:700; font-size:12px; white-space:nowrap; }
.skupl-leak-action{ font-size:11.5px; color:var(--ink-soft); margin-top:4px; line-height:1.45; }
.skupl-toolbar{ display:flex; align-items:flex-end; gap:12px; flex-wrap:wrap; padding:14px 16px; border-bottom:1px solid var(--border); }
.skupl-toolbar .plan-field select{ min-height:36px; border:1px solid var(--border); border-radius:8px; padding:7px 10px; font:600 13px inherit; color:var(--ink); background:var(--surface); }
.skupl-search{ flex:1; min-width:200px; }
.skupl-toolbar-spacer{ flex:1; }
.pt-badge.sku-badge-bad{ background:#FCE4E4; color:var(--neg); }
.pt-badge.sku-badge-warn{ background:#FCE4C4; color:#8A5A12; }
.pt-badge.sku-badge-ok{ background:#E6F2EB; color:var(--pos); }
.skupl-table tr.skupl-row-loss td{ background:#FDECEC; }
.skupl-table tr.skupl-row-loss td.pt-id{ background:#FBE0E0; box-shadow:inset 3px 0 0 var(--neg); }
.skupl-table tr.skupl-row-loss:hover td{ background:#FBE0E0; }
@media (max-width:900px){
  .kpi-grid,.compare-row{ grid-template-columns:repeat(2,1fr);} .breakdown-grid{ grid-template-columns:1fr;}
  .plan-stat-row{ grid-template-columns:repeat(3,1fr); }
  .recon-kpis{ grid-template-columns:repeat(2,minmax(0,1fr)); }.recon-chart-grid{ grid-template-columns:1fr; }
  .skupl-kpis{ grid-template-columns:repeat(3,minmax(0,1fr)); }.skupl-insights{ grid-template-columns:1fr; }
  /* Sidebar becomes an off-canvas drawer; collapse mode is ignored here. */
  .sidebar{ position:fixed; left:0; top:0; height:100vh; width:270px; transform:translateX(-100%); transition:transform .2s ease; box-shadow:0 0 44px rgba(10,12,20,.22); }
  .sidebar.collapsed{ width:270px; }
  .sidebar.collapsed .sb-brand{ justify-content:flex-start; padding:0 16px; }
  .sidebar.collapsed .sb-brand-text{ display:flex; }
  .sidebar.collapsed .sb-nav-item{ justify-content:flex-start; padding:9px 11px; }
  .sidebar.collapsed .sb-nav-label{ display:inline; }
  .sidebar.mobile-open{ transform:translateX(0); }
  .sb-close{ display:inline-flex; }
  .sb-footer{ display:none; }
  .menu-btn{ display:inline-flex; }
  .sb-backdrop{ display:block; position:fixed; inset:0; background:rgba(10,12,20,.42); z-index:35; }
  .topbar{ align-items:flex-start; }
  .topbar-filters{ order:3; width:100%; margin-left:0; display:grid; grid-template-columns:minmax(0,1.5fr) minmax(160px,1fr); }
  .topbar-account-select,.topbar-brand-select{ width:100%; }
  .topbar-account-select select,.topbar-brand-select select{ width:100%; max-width:none; }
  .live-wrap{ margin-left:auto; }
}
@media (max-width:560px){ .kpi-grid,.compare-row{ grid-template-columns:1fr;} .bar-row{ grid-template-columns:104px 1fr 80px;} .topbar{ padding:14px 16px;} .topbar-filters{ grid-template-columns:1fr; } .container{ padding:16px 14px 0;} .plan-stat-row{ grid-template-columns:repeat(2,1fr);} .plan-table th.pt-id, .plan-table td.pt-id{ min-width:160px; max-width:190px; } .pt-name,.pt-meta{ max-width:180px; } .recon-kpis{ grid-template-columns:1fr; }.recon-month-picker{ width:100%; justify-content:space-between; }.recon-waterfall-row{ grid-template-columns:100px minmax(70px,1fr) 100px; gap:7px; }.recon-waterfall-row > strong{ font-size:10.5px; }.recon-filters{ display:grid; grid-template-columns:1fr 1fr; }.recon-search{ grid-column:1/-1; min-width:0; } .skupl-kpis{ grid-template-columns:repeat(2,minmax(0,1fr)); } }
@media (prefers-reduced-motion: reduce){ .live-dot{ animation:none;} .spin{ animation:none;} }
button:focus-visible, select:focus-visible, input:focus-visible{ outline:2px solid var(--accent-deep); outline-offset:2px; }
`;
