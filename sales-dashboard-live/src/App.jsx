import React, { useState, useMemo, useEffect, useCallback } from "react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { TrendingUp, TrendingDown, ChevronDown, Info, RefreshCw, AlertTriangle, LayoutDashboard, CalendarRange, Menu, X, PanelLeftClose, PanelLeftOpen, Boxes, Search, ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";

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

  const coverage = invKnown ? fba + reserved + inTransit + awd : null;
  const recommended = invKnown ? Math.max(0, Math.ceil(targetUnits - fba - reserved - inTransit - awd)) : null;
  const remark = recommended === null ? null : recommended > 0 ? "Restock" : "OK";

  return {
    asin: r.asin,
    productName: r.productName,
    brand: r.brand,
    sku: r.sku,
    m1, m2, m3, mtdUnits,
    threeMoAvg, mtdProjected, planningAvg,
    fbaAvailable: invKnown ? fba : null,
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
  fbaAvailable: (r) => r.fbaAvailable,
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
const n1 = (v) => (v === null || v === undefined || !isFinite(v) ? "—" : Number(v).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }));

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

// Brand names are catalog metadata and remain valid across sales-report cache
// versions. Reuse them only from cached responses for the selected account so
// the header selector is usable before that account's next manual refresh.
function readCachedCatalogBrands(accountId) {
  if (!accountId) return [];
  try {
    const brands = new Set();
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(API_CACHE_PREFIX)) continue;
      const params = new URLSearchParams(key.slice(API_CACHE_PREFIX.length));
      if (params.get("action") !== "brand-sales" || params.get("ids") !== accountId) continue;
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

  // Daily Reporting: single-account view, defaults to Aakriti Art Creations.
  const [dailyAccountId, setDailyAccountId] = useState(null);
  const [dailyRows, setDailyRows] = useState([]);
  const [dailyLoading, setDailyLoading] = useState(false);
  const [dailyError, setDailyError] = useState(null);

  // FBA Shipment Plan: single selected account, cache-first like the others.
  const [planAccountId, setPlanAccountId] = useState(null);
  const [planData, setPlanData] = useState(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState(null);
  const [planCachedAt, setPlanCachedAt] = useState(null);
  const [targetDays, setTargetDays] = useState(30);
  const [planSearch, setPlanSearch] = useState("");
  const [planSort, setPlanSort] = useState({ key: "recommended", dir: "desc" });

  const TODAY = todayStr();

  const applyAccounts = useCallback((body) => {
    const nextAccounts = body.accounts || [];
    setAccounts(nextAccounts);
    if (nextAccounts.length > 0) {
      setSelectedAccountId((prev) => prev || nextAccounts[0].id);
      const aakriti = nextAccounts.find((a) => /aakriti/i.test(a.name));
      setDailyAccountId((prev) => prev || (aakriti || nextAccounts[0]).id);
      setPlanAccountId((prev) => prev || nextAccounts[0].id);
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
    return { action: "brand-sales", reportVersion: "order-items-v1", ids: selectedAccountId, from: addDays(monthStart(TODAY), -420), to: TODAY };
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
      setLastFetchedAt(new Date(cached.cachedAt));
      setRowsError(null);
    } else {
      setRows([]);
      setCatalogBrands([]);
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
    if (!planAccountId) return null;
    // Bump reportVersion if the backend metric definition changes so a stale
    // cached report can never be presented as the current one. `to` (the as-of
    // date) is part of the cache key; the target-coverage input is NOT, because
    // it is applied locally and must never trigger a refetch.
    return { action: "fba-plan", reportVersion: "fba-plan-v1", ids: planAccountId, to: TODAY };
  }, [planAccountId, TODAY]);

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

  const dailyCurrency = accountById[dailyAccountId]?.currency || "INR";
  const refreshScopeAccount = view === "daily"
    ? accountById[dailyAccountId]
    : view === "fbaplan"
    ? accountById[planAccountId]
    : accountById[selectedAccountId];
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
    const filtered = planComputed.filter((r) => planSearchMatch(r, planSearch));
    return [...filtered].sort((a, b) => comparePlanRows(a, b, planSort.key, planSort.dir));
  }, [planComputed, planSearch, planSort]);

  const planTotals = useMemo(() => {
    const t = { m1: 0, m2: 0, m3: 0, mtdUnits: 0, planningAvg: 0, fbaAvailable: 0, reserved: 0, inTransit: 0, awd: 0, coverage: 0, recommended: 0, restockCount: 0 };
    let anyInv = false, anyAwd = false;
    planRows.forEach((r) => {
      t.m1 += r.m1; t.m2 += r.m2; t.m3 += r.m3; t.mtdUnits += r.mtdUnits;
      t.planningAvg += r.planningAvg;
      if (r.fbaAvailable !== null) { anyInv = true; t.fbaAvailable += r.fbaAvailable; t.reserved += r.reserved; t.inTransit += r.inTransit; t.coverage += r.coverage; }
      if (r.awd !== null) { anyAwd = true; t.awd += r.awd; }
      if (r.recommended !== null) t.recommended += r.recommended;
      if (r.remark === "Restock") t.restockCount += 1;
    });
    t.anyInv = anyInv; t.anyAwd = anyAwd;
    return t;
  }, [planRows]);

  const setPlanSortKey = useCallback((key) => {
    setPlanSort((prev) => {
      if (prev.key === key) return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
      // Text columns default to ascending; numeric columns to descending.
      const textCols = ["asin", "productName", "brand", "sku", "remark"];
      return { key, dir: textCols.includes(key) ? "asc" : "desc" };
    });
  }, []);

  const displayCurrency = accountById[selectedAccountId]?.currency || "INR";

  function rowCurrency(r) {
    return r.currency || accountById[r.seller_or_vendor_id]?.currency || "INR";
  }
  function salesInDisplay(r) {
    return r.total_sales;
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
    [selectedAccountId, catalogBrands]
  );
  const brandList = useMemo(() => {
    const names = new Set([...cachedAccountBrands, ...catalogBrands]);
    rows
      .filter((row) => row.seller_or_vendor_id === selectedAccountId)
      .forEach((row) => names.add(productBrand(row)));
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [cachedAccountBrands, catalogBrands, rows, selectedAccountId]);
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
            <button className={"sb-nav-item" + (view === "fbaplan" ? " active" : "")} title="FBA Shipment Plan" onClick={() => { setView("fbaplan"); setMobileOpen(false); }}>
              <Boxes size={18} />
              <span className="sb-nav-label">FBA Shipment Plan</span>
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
        )}
        <div className="live-wrap">
          <span className="live-dot" />
          {(() => {
            const stamp = view === "fbaplan" ? planCachedAt : lastFetchedAt;
            return stamp ? `Refreshed ${stamp.toLocaleTimeString()} · ${refreshScopeAccount?.name || "selected account"}` : "Select an account to refresh";
          })()}
          <button className="refresh-btn" onClick={view === "daily" ? fetchDaily : view === "fbaplan" ? fetchPlan : fetchRows} title="Refresh selected account">
            <RefreshCw size={13} className={(view === "daily" ? dailyLoading : view === "fbaplan" ? planLoading : rowsLoading) ? "spin" : ""} />
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
          Brand filtering uses DataDoe's Product Catalog by ASIN (`product_brand`) for the selected account. Change an account or brand to use cached data; use refresh only when you want a new export.
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
              {accounts.map((account) => (
                <option value={account.id} key={account.id}>{FLAGS[account.country] || ""} {account.name} ({account.currency || "—"})</option>
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
          Sales and units are sourced from DataDoe Sales & Traffic by ASIN & Date. Ad Sales, Ad Spend, and Clicks are sourced from the connected DataDoe advertising export. The report ends on the latest completed sales date so a delayed source row is not shown as a real zero-sales day.
        </div>
      </div>
      )}

      {view === "fbaplan" && (
      <div className="container">
        <div className="controls-bar">
          <div>
            <div className="page-title">FBA Shipment Plan</div>
            <div className="page-sub">Per-ASIN restock recommendation from sales velocity and live FBA{planData?.isUS ? " + AWD" : ""} inventory</div>
          </div>
          <div className="select">
            <select aria-label="FBA plan account" value={planAccountId || ""} onChange={(e) => setPlanAccountId(e.target.value)}>
              {accounts.map((account) => (
                <option value={account.id} key={account.id}>{FLAGS[account.country] || ""} {account.name} ({account.country || "—"})</option>
              ))}
            </select>
            <ChevronDown size={16} />
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
              <div className="plan-stat"><div className="plan-stat-label">Coverage Inv.</div><div className="plan-stat-value mono">{planTotals.anyInv ? nInt(planTotals.coverage) : "—"}</div></div>
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
                    <PlanTh label="Plan Avg" col="planningAvg" sort={planSort} onSort={setPlanSortKey} />
                    <PlanTh label="FBA Avail" col="fbaAvailable" sort={planSort} onSort={setPlanSortKey} />
                    <PlanTh label="Reserved" col="reserved" sort={planSort} onSort={setPlanSortKey} />
                    <PlanTh label="In Transit" col="inTransit" sort={planSort} onSort={setPlanSortKey} />
                    {planData.isUS && <PlanTh label="AWD Avail" col="awd" sort={planSort} onSort={setPlanSortKey} />}
                    <PlanTh label="Coverage" col="coverage" sort={planSort} onSort={setPlanSortKey} />
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
                      <td className="mono">{n1(r.threeMoAvg)}</td>
                      <td className="mono">{n1(r.mtdProjected)}</td>
                      <td className="mono pt-strong">{n1(r.planningAvg)}</td>
                      <td className="mono">{nInt(r.fbaAvailable)}</td>
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
                    <td className="mono pt-strong">{n1(planTotals.planningAvg)}</td>
                    <td className="mono">{planTotals.anyInv ? nInt(planTotals.fbaAvailable) : "—"}</td>
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
            <div className="empty-note">{planSearch ? "No ASINs match your search." : "No ASINs found for this account in the reporting window."}</div>
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
          {" "}Planning Avg = max(3-month avg, MTD projected). Recommended Shipment = ceil(Planning daily rate × target days − coverage inventory), floored at 0. Live inventory freshness is independent of sales-report freshness; both dates are shown above. Filters, sorting, and the target-days input recompute locally without new DataDoe requests.
        </div>
      </div>
      )}
        </div>
      </div>
    </div>
  );
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
@media (max-width:900px){
  .kpi-grid,.compare-row{ grid-template-columns:repeat(2,1fr);} .breakdown-grid{ grid-template-columns:1fr;}
  .plan-stat-row{ grid-template-columns:repeat(3,1fr); }
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
@media (max-width:560px){ .kpi-grid,.compare-row{ grid-template-columns:1fr;} .bar-row{ grid-template-columns:104px 1fr 80px;} .topbar{ padding:14px 16px;} .topbar-filters{ grid-template-columns:1fr; } .container{ padding:16px 14px 0;} .plan-stat-row{ grid-template-columns:repeat(2,1fr);} .plan-table th.pt-id, .plan-table td.pt-id{ min-width:160px; max-width:190px; } .pt-name,.pt-meta{ max-width:180px; } }
@media (prefers-reduced-motion: reduce){ .live-dot{ animation:none;} .spin{ animation:none;} }
button:focus-visible, select:focus-visible, input:focus-visible{ outline:2px solid var(--accent-deep); outline-offset:2px; }
`;
