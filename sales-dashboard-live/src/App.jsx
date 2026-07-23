import React, { useState, useMemo, useEffect, useCallback } from "react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { TrendingUp, TrendingDown, ChevronDown, Info, RefreshCw, AlertTriangle, LayoutDashboard, CalendarRange, Menu, X, PanelLeftClose, PanelLeftOpen } from "lucide-react";

/* ============================== CONFIG ============================== */
// Approximate FX rates for combining accounts that use different currencies.
// These are static and will drift over time — update periodically, or
// replace with a live FX API call for better accuracy.
const FX = { INR: 1, USD: 94.6, AUD: 65.2, CAD: 66.6, GBP: 118, EUR: 101 };
const FX_AS_OF = "2026-07-01";

const FLAGS = { IN: "🇮🇳", US: "🇺🇸", AU: "🇦🇺", CA: "🇨🇦", UK: "🇬🇧", GB: "🇬🇧", DE: "🇩🇪", FR: "🇫🇷", JP: "🇯🇵", MX: "🇲🇽" };
const SYMBOL = { INR: "₹", USD: "$", AUD: "A$", CAD: "C$", GBP: "£", EUR: "€" };
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Tokens stripped from the end of an account name to infer its brand.
// e.g. "Indya Store IN" / "INDYA STORE US AU" / "Indya Store CA CA" -> "Indya Store"
const MARKET_TOKENS = new Set(["IN", "US", "USA", "UK", "GB", "CA", "AU", "EU", "MX", "JP", "DE", "FR", "IT", "ES", "AE", "SG", "NL", "SE", "PL", "BR"]);

function inferBrand(name) {
  const tokens = name.trim().split(/\s+/);
  while (tokens.length > 1 && MARKET_TOKENS.has(tokens[tokens.length - 1].toUpperCase())) {
    tokens.pop();
  }
  return tokens.join(" ").trim() || name;
}

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

// Ad columns aren't wired into the DataDoe export yet (source/column names are
// being confirmed via ?action=fields). Read them optimistically under a few
// likely names so the table auto-fills once the export includes them.
const AD_SALES_KEYS = ["ad_sales", "advertising_sales", "ppc_sales", "sponsored_products_sales", "attributed_sales"];
const AD_SPEND_KEYS = ["ad_spend", "ad_spends", "advertising_spend", "ppc_spend", "spend", "cost"];
const CLICKS_KEYS = ["clicks", "total_clicks", "ad_clicks"];
function pickNum(row, keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && row[k] !== "") return Number(row[k]) || 0;
  }
  return null;
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

/* ============================== MAIN APP ============================== */
export default function App() {
  const [accounts, setAccounts] = useState([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountsError, setAccountsError] = useState(null);

  const [rows, setRows] = useState([]);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [rowsError, setRowsError] = useState(null);
  const [lastFetchedAt, setLastFetchedAt] = useState(null);

  const [mode, setMode] = useState("all");
  const [marketFilter, setMarketFilter] = useState("ALL");
  const [singleId, setSingleId] = useState(null);
  const [brand, setBrand] = useState(null);
  const [excluded, setExcluded] = useState(new Set());
  const [rangePreset, setRangePreset] = useState("30D");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [granularity, setGranularity] = useState("D");

  // Sidebar shell state: `collapsed` = desktop icon-only mode; `mobileOpen` = drawer open on small screens.
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  // Which section is showing: the main dashboard or the Daily Reporting view.
  const [view, setView] = useState("dashboard");

  // Daily Reporting: single-account view, defaults to Aakriti Art Creations.
  const [dailyAccountId, setDailyAccountId] = useState(null);
  const [dailyRows, setDailyRows] = useState([]);
  const [dailyLoading, setDailyLoading] = useState(false);
  const [dailyError, setDailyError] = useState(null);

  const TODAY = todayStr();

  const applyAccounts = useCallback((body) => {
    // brand = a lowercase grouping key (case-insensitive matching, so
    // "Indya Store" and "INDYA STORE" land in the same group).
    // brandLabel = the nicely-cased label actually shown in the UI.
    const withBrand = (body.accounts || []).map((a) => {
      const rawBrand = inferBrand(a.name);
      return { ...a, brand: rawBrand.toLowerCase(), brandLabel: rawBrand };
    });
    setAccounts(withBrand);
    if (withBrand.length > 0) {
      setSingleId((prev) => prev || withBrand[0].id);
      setBrand((prev) => prev || withBrand[0].brand);
      const aakriti = withBrand.find((a) => /aakriti/i.test(a.name));
      setDailyAccountId((prev) => prev || (aakriti || withBrand[0]).id);
    }
    setAccountsError(null);
    return withBrand;
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

  const BRAND_MAP = useMemo(() => {
    const map = {};
    accounts.forEach((a) => {
      (map[a.brand] = map[a.brand] || []).push(a.id);
    });
    return map;
  }, [accounts]);
  const BRAND_LIST = useMemo(() => Object.keys(BRAND_MAP).sort(), [BRAND_MAP]);
  const BRAND_LABELS = useMemo(() => {
    const map = {};
    accounts.forEach((a) => { if (!map[a.brand]) map[a.brand] = a.brandLabel || a.brand; });
    return map;
  }, [accounts]);
  const accountById = useMemo(() => {
    const m = {};
    accounts.forEach((a) => (m[a.id] = a));
    return m;
  }, [accounts]);

  const activeIds = useMemo(() => {
    if (mode === "single") return singleId ? [singleId] : [];
    if (mode === "brand") return (BRAND_MAP[brand] || []).filter((id) => !excluded.has(id));
    if (marketFilter === "ALL") return accounts.map((a) => a.id);
    return accounts.filter((a) => a.country === marketFilter).map((a) => a.id);
  }, [mode, singleId, brand, excluded, marketFilter, accounts, BRAND_MAP]);

  const dashboardParams = useMemo(() => {
    if (activeIds.length === 0) {
      return null;
    }
    return { action: "sales", ids: activeIds.join(","), from: addDays(monthStart(TODAY), -420), to: TODAY };
  }, [activeIds, TODAY]);

  const loadCachedRows = useCallback(() => {
    if (!dashboardParams) {
      setRows([]);
      return;
    }
    const cached = readApiCache(dashboardParams);
    if (cached) {
      setRows(cached.body.rows || []);
      setLastFetchedAt(new Date(cached.cachedAt));
      setRowsError(null);
    } else {
      setRows([]);
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
        setLastFetchedAt(new Date(cachedAt));
      })
      .catch((err) => setRowsError(err.message))
      .finally(() => setRowsLoading(false));
  }, [accounts.length, dashboardParams]);

  useEffect(() => {
    loadCachedRows();
  }, [loadCachedRows]);

  useEffect(() => { setExcluded(new Set()); }, [brand]);

  // Daily Reporting fetch: pull ~5 months of single-account history so the
  // report can show 3 completed months + current-month MTD + the last 5 days.
  const dailyParams = useMemo(() => {
    if (!dailyAccountId) return null;
    const mb = monthBack(TODAY, 5);
    return { action: "daily", ids: dailyAccountId, from: mb.from, to: TODAY };
  }, [dailyAccountId, TODAY]);

  const loadCachedDaily = useCallback(() => {
    if (!dailyParams) {
      setDailyRows([]);
      return;
    }
    const cached = readApiCache(dailyParams);
    if (cached) {
      setDailyRows(cached.body.rows || []);
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
      .then(({ body }) => setDailyRows(body.rows || []))
      .catch((err) => setDailyError(err.message))
      .finally(() => setDailyLoading(false));
  }, [dailyParams]);

  useEffect(() => {
    if (view === "daily") loadCachedDaily();
  }, [view, loadCachedDaily]);

  const dailyCurrency = accountById[dailyAccountId]?.currency || "INR";
  const dailyReport = useMemo(() => {
    // Anchor to yesterday at the latest — today is always excluded, since
    // today's sales/ad numbers are still accumulating and not a full day.
    const yesterday = addDays(TODAY, -1);
    let latest = dailyRows.reduce((mx, r) => (!mx || r.date > mx ? r.date : mx), null) || yesterday;
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

  const scopeCurrency = useMemo(() => {
    const set = new Set(activeIds.map((id) => accountById[id]?.currency).filter(Boolean));
    return set.size === 1 ? [...set][0] : set.size === 0 ? null : "MIXED";
  }, [activeIds, accountById]);
  const mixedScope = scopeCurrency === "MIXED";
  const displayCurrency = mixedScope ? "INR" : scopeCurrency || "INR";

  function rowCurrency(r) {
    return r.currency || accountById[r.seller_or_vendor_id]?.currency || "INR";
  }
  function salesInDisplay(r) {
    return mixedScope ? r.total_sales * (FX[rowCurrency(r)] || 1) : r.total_sales;
  }

  function aggregate(rowSet) {
    let sales = 0, units = 0, orders = 0;
    rowSet.forEach((r) => {
      units += r.total_units_sold || 0;
      orders += r.total_orders || 0;
      sales += salesInDisplay(r);
    });
    return { sales, units, orders };
  }

  const [scopeMin, scopeMax] = useMemo(() => {
    let mn = null, mx = null;
    rows.forEach((r) => {
      if (!mn || r.date < mn) mn = r.date;
      if (!mx || r.date > mx) mx = r.date;
    });
    return [mn, mx];
  }, [rows]);
  const latest = scopeMax || TODAY;

  function filterRows(from, to) {
    return rows.filter((r) => r.date >= from && r.date <= to);
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
  }, [rows, latest, scopeMin]);

  const [rangeFrom, rangeTo] = useMemo(() => {
    let f, t;
    switch (rangePreset) {
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

  const scopedRows = useMemo(() => filterRows(rangeFrom, rangeTo), [rows, rangeFrom, rangeTo]);
  const kpi = useMemo(() => aggregate(scopedRows), [scopedRows, mixedScope]);
  const aov = kpi.orders > 0 ? kpi.sales / kpi.orders : 0;
  // The sales source (401ffcd7e5) has no order-count column, so Orders / AOV
  // show "—" unless an orders figure is actually present on the rows.
  const hasOrders = useMemo(() => rows.some((r) => r.total_orders !== undefined && r.total_orders !== null), [rows]);

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
  }, [scopedRows, granularity, mixedScope]);

  const byAccountBreakdown = useMemo(() => {
    const sums = {};
    scopedRows.forEach((r) => {
      const v = r.total_sales * (FX[rowCurrency(r)] || 1);
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
      const a = accountById[r.seller_or_vendor_id];
      const b = a?.brand || "Other";
      const v = r.total_sales * (FX[rowCurrency(r)] || 1);
      sums[b] = (sums[b] || 0) + v;
    });
    const total = Object.values(sums).reduce((a, b) => a + b, 0);
    return Object.keys(sums).map((b) => ({ key: b, label: BRAND_LABELS[b] || b, flag: null, value: sums[b], share: total ? (sums[b] / total) * 100 : 0 })).sort((a, b) => b.value - a.value);
  }, [scopedRows, accountById]);

  const activeAccountKeys = useMemo(() => new Set(activeIds), [activeIds]);
  const activeBrandKeys = useMemo(() => {
    if (mode === "brand") return new Set([brand]);
    if (mode === "single") return new Set([accountById[singleId]?.brand]);
    return new Set();
  }, [mode, brand, singleId, accountById]);

  const nativeBreakdown = useMemo(() => {
    if (!mixedScope) return [];
    const sums = {};
    scopedRows.forEach((r) => {
      const a = accountById[r.seller_or_vendor_id];
      const key = r.seller_or_vendor_id;
      sums[key] = sums[key] || { name: a?.name || key, currency: rowCurrency(r), total: 0 };
      sums[key].total += r.total_sales;
    });
    return Object.values(sums).sort((a, b) => b.total - a.total);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedRows, mixedScope, accountById]);

  const brandAccounts = BRAND_MAP[brand] || [];
  const includedCount = brandAccounts.length - excluded.size;
  const multiAccountBrands = useMemo(() => new Set(BRAND_LIST.filter((b) => (BRAND_MAP[b] || []).length > 1)), [BRAND_LIST, BRAND_MAP]);

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
        {view === "dashboard" && (
          <div className="tabs topbar-tabs">
            <button className={"tab" + (mode === "all" ? " active" : "")} onClick={() => setMode("all")}>All Accounts</button>
            <button className={"tab" + (mode === "single" ? " active" : "")} onClick={() => setMode("single")}>Single Account</button>
            <button className={"tab" + (mode === "brand" ? " active" : "")} onClick={() => setMode("brand")}>Brand View</button>
          </div>
        )}
        <div className="live-wrap">
          <span className="live-dot" />
          {lastFetchedAt ? `Refreshed ${lastFetchedAt.toLocaleTimeString()}` : "Loading…"} · {accounts.length} accounts
          <button className="refresh-btn" onClick={fetchRows} title="Refresh data">
            <RefreshCw size={13} className={rowsLoading ? "spin" : ""} />
          </button>
        </div>
      </div>

      {view === "dashboard" && (
      <div className="container">
        <div className="controls-bar">
          {mode === "all" && (
            <div className="chip-row">
              {["ALL", ...Array.from(new Set(accounts.map((a) => a.country)))].map((c) => (
                <button key={c} className={"chip" + (marketFilter === c ? " active" : "")} onClick={() => setMarketFilter(c)}>
                  {c === "ALL" ? "All marketplaces" : `${FLAGS[c] || ""} ${c}`}
                </button>
              ))}
            </div>
          )}

          {mode === "single" && (
            <div className="select">
              <select value={singleId || ""} onChange={(e) => setSingleId(e.target.value)}>
                {BRAND_LIST.map((b) => (
                  <optgroup label={BRAND_LABELS[b] || b} key={b}>
                    {BRAND_MAP[b].map((id) => (
                      <option value={id} key={id}>{FLAGS[accountById[id].country] || ""} {accountById[id].name} ({accountById[id].currency || "—"})</option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <ChevronDown size={16} />
            </div>
          )}

          {mode === "brand" && (
            <div className="select">
              <select value={brand || ""} onChange={(e) => setBrand(e.target.value)}>
                {BRAND_LIST.map((b) => (
                  <option value={b} key={b}>{BRAND_LABELS[b] || b}{multiAccountBrands.has(b) ? ` (${BRAND_MAP[b].length} accounts)` : ""}</option>
                ))}
              </select>
              <ChevronDown size={16} />
            </div>
          )}

          <div className="chip-row">
            {["7D", "30D", "90D", "MTD", "YTD", "CUSTOM"].map((p) => (
              <button key={p} className={"chip" + (rangePreset === p ? " active" : "")} onClick={() => setRangePreset(p)}>
                {p === "CUSTOM" ? "Custom" : p}
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

        {mode === "brand" && brand && (
          <div className="brand-panel">
            <div className="brand-panel-head">
              <strong>{BRAND_LABELS[brand] || brand}</strong>
              <span className="badge-count">{includedCount} of {brandAccounts.length} accounts combined</span>
              {excluded.size > 0 && <button className="reset-link" onClick={() => setExcluded(new Set())}>Reset to all</button>}
            </div>
            <div className="check-grid">
              {brandAccounts.map((id) => {
                const a = accountById[id];
                const checked = !excluded.has(id);
                return (
                  <label className="check-item" key={id}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        setExcluded((prev) => {
                          const next = new Set(prev);
                          if (next.has(id)) next.delete(id);
                          else if (brandAccounts.length - next.size > 1) next.add(id);
                          return next;
                        });
                      }}
                    />
                    {FLAGS[a.country] || ""} {a.name} <span style={{ color: "var(--ink-soft)" }}>({a.currency || "—"})</span>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {rowsError && (
          <div className="error-banner"><AlertTriangle size={15} /> {rowsError}</div>
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

        {mixedScope && nativeBreakdown.length > 0 && (
          <details className="disclosure">
            <summary>View native-currency figures for this selection (not combined)</summary>
            <div style={{ marginTop: 10 }}>
              {nativeBreakdown.map((n, i) => (
                <div className="native-row" key={i}>
                  <span>{n.name}</span>
                  <span className="mono">{fmtMoney(n.total, n.currency)}</span>
                </div>
              ))}
            </div>
          </details>
        )}

        <div className="footer-note">
          Combined totals across currencies are converted to INR using approximate rates as of {fmtDateHuman(FX_AS_OF)}: $1 = ₹{FX.USD}, A$1 = ₹{FX.AUD}, C$1 = ₹{FX.CAD}. These rates are static in this build — update the FX constant periodically for accuracy.
          Brand grouping is inferred automatically from account names and may need manual correction for accounts with very similar names.
        </div>
      </div>
      )}

      {view === "daily" && (
      <div className="container">
        <div className="controls-bar">
          <div>
            <div className="page-title">Daily Reporting</div>
            <div className="page-sub">Sales & advertising snapshot by month and by day</div>
          </div>
          <div className="select">
            <select value={dailyAccountId || ""} onChange={(e) => setDailyAccountId(e.target.value)}>
              {BRAND_LIST.map((b) => (
                <optgroup label={BRAND_LABELS[b] || b} key={b}>
                  {BRAND_MAP[b].map((id) => (
                    <option value={id} key={id}>{FLAGS[accountById[id].country] || ""} {accountById[id].name} ({accountById[id].currency || "—"})</option>
                  ))}
                </optgroup>
              ))}
            </select>
            <ChevronDown size={16} />
          </div>
        </div>

        {dailyError && (
          <div className="error-banner"><AlertTriangle size={15} /> {dailyError}</div>
        )}

        <div className="panel" style={{ marginTop: 14 }}>
          <div className="panel-head">
            <div>
              <div className="panel-title">{accountById[dailyAccountId]?.name || "Account"}</div>
              <div className="page-sub">Latest data: {fmtDateHuman(dailyReport.latest)} · shown in {dailyCurrency}</div>
            </div>
            <button className="refresh-btn" onClick={fetchDaily} title="Refresh data">
              <RefreshCw size={13} className={dailyLoading ? "spin" : ""} />
            </button>
          </div>

          <div className="daily-scroll">
            <table className="daily-table">
              <thead>
                <tr>
                  <th className="dt-metric">{accountById[dailyAccountId]?.name?.split(" ")[0] || "Metric"}</th>
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
          Ad Sales, Ad Spend, and Clicks show "—" until the DataDoe advertising source is wired in — use <code>/api/datadoe?action=fields</code> on the live site to find its source id and column names, then add those columns to the export.
        </div>
      </div>
      )}
        </div>
      </div>
    </div>
  );
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
.topbar-tabs{ margin-left:auto; flex-shrink:0; }
.live-wrap{ display:flex; align-items:center; gap:8px; font-size:12px; color:var(--ink-soft); }
.live-dot{ width:8px; height:8px; border-radius:50%; background:var(--pos); animation:pulse 2s infinite; }
.refresh-btn{ border:1px solid var(--border); background:var(--surface); border-radius:7px; padding:5px 7px; cursor:pointer; display:flex; align-items:center; color:var(--ink-soft); }
.spin{ animation:spin 1s linear infinite; }
@keyframes spin{ from{transform:rotate(0deg);} to{transform:rotate(360deg);} }
@keyframes pulse{ 0%{box-shadow:0 0 0 0 rgba(30,142,90,.45);} 70%{box-shadow:0 0 0 6px rgba(30,142,90,0);} 100%{box-shadow:0 0 0 0 rgba(30,142,90,0);} }
.container{ max-width:1240px; margin:0 auto; padding:22px 24px 0; }
.tabs{ display:inline-flex; background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:4px; gap:2px; }
.tab{ border:none; background:transparent; padding:8px 16px; font-size:13.5px; font-weight:700; color:var(--ink-soft); border-radius:9px; cursor:pointer; font-family:inherit; }
.tab.active{ background:var(--ink); color:#fff; }
.controls-bar{ display:flex; align-items:center; justify-content:space-between; gap:16px; margin-top:16px; flex-wrap:wrap; }
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
@media (max-width:900px){
  .kpi-grid,.compare-row{ grid-template-columns:repeat(2,1fr);} .breakdown-grid{ grid-template-columns:1fr;}
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
  .topbar-tabs{ order:3; width:100%; margin-left:0; justify-content:center; }
  .live-wrap{ margin-left:auto; }
}
@media (max-width:560px){ .kpi-grid,.compare-row{ grid-template-columns:1fr;} .bar-row{ grid-template-columns:104px 1fr 80px;} .topbar{ padding:14px 16px;} .topbar-tabs{ overflow-x:auto; justify-content:flex-start; } .tab{ white-space:nowrap; } .container{ padding:16px 14px 0;} }
@media (prefers-reduced-motion: reduce){ .live-dot{ animation:none;} .spin{ animation:none;} }
button:focus-visible, select:focus-visible, input:focus-visible{ outline:2px solid var(--accent-deep); outline-offset:2px; }
`;
