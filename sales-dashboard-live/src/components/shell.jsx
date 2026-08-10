/* =====================================================================
   UPRIVER app shell — navigation rail, top command bar, global scope controls
   =====================================================================

   These are presentation components only. Every piece of state (which view is
   open, which account and brand are selected, whether a refresh is running)
   stays in DashboardApp, so routing, permissions, caching and the
   "only Refresh calls DataDoe" rule are untouched by this layer.

   The navigation groups below are visual grouping only. The `view` key of each
   item is the same key the app has always used, so no route behaviour changes
   when items are regrouped or reordered.                                    */

import React, { useEffect } from "react";
import {
  BellRing,
  Boxes,
  CalendarRange,
  DatabaseZap,
  ChevronDown,
  ChevronRight,
  FileSearch,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Megaphone,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  ReceiptText,
  RefreshCw,
  ShieldAlert,
  Store,
  Tag,
  Tags,
  TrendingUp,
  Trophy,
  Undo2,
  UsersRound,
  Wallet,
  X,
} from "lucide-react";

/**
 * The navigation model. `view` values are the existing route keys — do not
 * rename them. `adminOnly` items are filtered out for non-admins exactly as
 * before; the server remains the authority on access either way.
 */
export const NAV_GROUPS = [
  {
    label: "Overview",
    items: [
      { view: "dashboard", label: "Dashboard", title: "Portfolio sales dashboard", icon: LayoutDashboard },
      // The account-scoped Brand View: one account, one brand. The header's
      // `Brand view` switcher opens the cross-account version of the same three
      // reports; both render from src/views/BrandReports.jsx.
      { view: "brandview", label: "Brand View", title: "Brand View — one account, one brand, every marketplace", icon: Tags },
      { view: "priority", label: "Priority Feed", title: "Priority Feed — every evidenced signal from the six reports, ranked", icon: ListChecks },
    ],
  },
  {
    label: "Finance",
    items: [
      { view: "daily", label: "Daily Reporting", title: "Daily sales and advertising matrix", icon: CalendarRange },
      { view: "reconciliation", label: "Reconciliation", title: "Orders versus Amazon settlements", icon: ReceiptText },
      { view: "skupl", label: "SKU P&L Analyzer", title: "Net profit by SKU", icon: Wallet },
      { view: "returns", label: "Returns & Refunds", title: "Returns & Refund Leakage — refund money and fixable causes", icon: Undo2 },
    ],
  },
  {
    label: "Operations",
    items: [
      { view: "fbaplan", label: "FBA Shipment Plan", title: "Per-ASIN restock recommendation", icon: Boxes },
      { view: "listinghealth", label: "Listing Health", title: "Listing Health — suppressed, inactive and stranded listings", icon: ShieldAlert },
      { view: "buybox", label: "Buy Box Loss", title: "Buy Box Loss — featured-offer share and its causes", icon: Trophy },
    ],
  },
  {
    label: "Growth",
    items: [
      { view: "salesmovers", label: "Sales Movers", title: "Sales Movers — weekly ASIN gains and declines", icon: TrendingUp },
      { view: "ppc", label: "PPC Performance", title: "PPC Performance & Wasted Spend", icon: Megaphone },
      { view: "keywordrank", label: "Keyword Rank", title: "Keyword rank and share of query", icon: Tag },
      { view: "optimizer", label: "Listing Optimizer", title: "Listing & Search Optimizer — search-funnel and content gaps", icon: FileSearch },
    ],
  },
  {
    label: "Monitoring",
    items: [
      { view: "contentchanges", label: "Content Alerts", title: "Amazon A+ and branded-item content changes", icon: BellRing },
    ],
  },
  {
    label: "Admin",
    items: [
      { view: "sync-center", label: "Data Sync Center", title: "Control report schedules and manual sync", icon: DatabaseZap, adminOnly: true },
      { view: "access", label: "User Access", title: "Invite users and assign account access", icon: UsersRound, adminOnly: true },
    ],
  },
];

/** view key -> the name shown as the current breadcrumb. */
export const VIEW_TITLES = NAV_GROUPS.reduce((titles, group) => {
  group.items.forEach((item) => { titles[item.view] = item.label; });
  return titles;
}, {});

/* =============================== SIDEBAR =============================== */

export function Sidebar({
  view, onNavigate, isAdmin, email,
  collapsed, onToggleCollapse,
  mobileOpen, onCloseMobile, onSignOut, brandMode = false,
}) {
  // Escape closes the mobile drawer. Bound only while it is open.
  useEffect(() => {
    if (!mobileOpen) return undefined;
    const onKeyDown = (event) => { if (event.key === "Escape") onCloseMobile(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen, onCloseMobile]);

  return (
    <aside
      className={"sidebar" + (collapsed ? " collapsed" : "") + (mobileOpen ? " mobile-open" : "")}
      aria-label="Report navigation"
    >
      <div className="sb-brand">
        <div className="sb-logo" aria-hidden="true">UR</div>
        <div className="sb-brand-text">
          <div className="sb-ws-name">Upriver Dashboard</div>
          <div className="sb-ws-sub" title={email}>{email}</div>
        </div>
        <button className="sb-close" type="button" onClick={onCloseMobile} aria-label="Close navigation">
          <X size={18} />
        </button>
      </div>

      <nav className="sb-nav">
        {(brandMode ? [{
          label: "Brand View",
          items: [{ view: "dashboard", label: "Brand Dashboard", title: "Daily, monthly and seven-day country performance", icon: LayoutDashboard }],
        }] : NAV_GROUPS).map((group) => {
          const items = group.items.filter((item) => item.view !== "brandview" && (!item.adminOnly || isAdmin));
          if (!items.length) return null;
          return (
            <div className="sb-group" key={group.label}>
              <div className="sb-group-label" aria-hidden={collapsed ? "true" : undefined}>{group.label}</div>
              {items.map((item) => {
                const Icon = item.icon;
                const active = view === item.view;
                return (
                  <button
                    key={item.view}
                    type="button"
                    className={"sb-nav-item" + (active ? " active" : "")}
                    // The native tooltip is what makes the collapsed rail
                    // legible: a CSS popover would be clipped by the rail's
                    // own vertical scroll container.
                    title={collapsed ? item.label : item.title}
                    aria-current={active ? "page" : undefined}
                    onClick={() => onNavigate(item.view)}
                  >
                    <Icon size={17} aria-hidden="true" />
                    <span className="sb-nav-label">{item.label}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </nav>

      <div className="sb-footer">
        <button
          className="sb-collapse collapse-toggle"
          type="button"
          onClick={onToggleCollapse}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-pressed={collapsed}
        >
          {collapsed ? <PanelLeftOpen size={17} aria-hidden="true" /> : <PanelLeftClose size={17} aria-hidden="true" />}
          <span className="sb-nav-label">Collapse</span>
        </button>
        <button className="sb-collapse signout" type="button" onClick={onSignOut} title="Sign out" aria-label="Sign out">
          <LogOut size={17} aria-hidden="true" />
          <span className="sb-nav-label">Sign out</span>
        </button>
      </div>
    </aside>
  );
}

/* ======================== GLOBAL SCOPE SELECTORS ======================== */

/**
 * AccountSelector / BrandSelector wrap the existing native <select> elements.
 * A native select is intentional: it stays keyboard accessible, works on
 * mobile, and keeps the exact change semantics the app already relies on.
 */
export function AccountSelector({ accounts, value, onChange, flags, onRefresh, refreshing = false }) {
  return (
    <div className="tb-select account">
      <Store size={15} aria-hidden="true" />
      <div className="tb-select-body">
        <div className="tb-select-label">Account</div>
        <div className="tb-select-value">
          <select
            aria-label="Account selection"
            value={value || ""}
            onChange={(event) => onChange(event.target.value)}
            disabled={!accounts.length}
          >
            {!accounts.length && <option value="">No accounts available</option>}
            {accounts.map((account) => (
              <option value={account.id} key={account.id}>
                {(flags[account.country] || "")} {account.name} ({account.currency || "—"})
              </option>
            ))}
          </select>
          <ChevronDown size={14} aria-hidden="true" />
        </div>
      </div>
      {onRefresh && (
        <button
          className="account-sync-btn"
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          title="Refresh account list from DataDoe"
          aria-label="Refresh account list from DataDoe"
        >
          <RefreshCw size={14} className={refreshing ? "spin" : ""} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export function BrandSelector({ brands, value, onChange, includeAll = true, label = "Brand" }) {
  return (
    <div className="tb-select brand">
      <Tag size={15} aria-hidden="true" />
      <div className="tb-select-body">
        <div className="tb-select-label">{label}</div>
        <div className="tb-select-value">
          <select aria-label="Brand selection" value={value} onChange={(event) => onChange(event.target.value)}>
            {includeAll ? <option value="ALL">All brands</option> : <option value="">Select a brand</option>}
            {brands.map((brand) => <option value={brand} key={brand}>{brand}</option>)}
          </select>
          <ChevronDown size={14} aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}

function DashboardModeSelector({ value, onChange }) {
  return (
    <div className="segmented dashboard-mode" role="group" aria-label="Dashboard workspace">
      <button type="button" className={value === "account" ? "active" : ""} aria-pressed={value === "account"} onClick={() => onChange("account")}>Account view</button>
      <button type="button" className={value === "brand" ? "active" : ""} aria-pressed={value === "brand"} onClick={() => onChange("brand")}>Brand view</button>
    </div>
  );
}

/* ============================ TOP COMMAND BAR ============================ */

export function TopBar({
  viewTitle, onOpenMenu, mobileOpen, showScope,
  accounts, selectedAccountId, onAccountChange, onRefreshAccounts, accountsRefreshing,
  brands, selectedBrand, onBrandChange, flags,
  dashboardMode = "account", onDashboardModeChange, portfolioBrands = [], selectedPortfolioBrand = "", onPortfolioBrandChange,
  refresh,
}) {
  return (
    <header className="topbar">
      <div className="tb-left">
        <button className="menu-btn" type="button" onClick={onOpenMenu} aria-label="Open navigation" aria-expanded={mobileOpen}>
          <Menu size={18} aria-hidden="true" />
        </button>
        <div className="crumbs">
          <span className="crumb-root">
            <span className="crumb-mark">UPRIVER</span>
            <span className="crumb-root-text">Amazon Seller Portfolio</span>
          </span>
          <ChevronRight size={13} className="crumb-sep" aria-hidden="true" />
          <h1 className="crumb-current">{viewTitle}</h1>
        </div>
      </div>

      {showScope && (
        <div className="tb-right">
          {onDashboardModeChange && <DashboardModeSelector value={dashboardMode} onChange={onDashboardModeChange} />}
          {dashboardMode === "brand" ? (
            <BrandSelector brands={portfolioBrands} value={selectedPortfolioBrand} onChange={onPortfolioBrandChange} includeAll={false} label="Portfolio brand" />
          ) : <>
            <AccountSelector
              accounts={accounts}
              value={selectedAccountId}
              onChange={onAccountChange}
              flags={flags}
              onRefresh={onRefreshAccounts}
              refreshing={accountsRefreshing}
            />
            <BrandSelector brands={brands} value={selectedBrand} onChange={onBrandChange} />
          </>}
          <div className="refresh-cluster">
            <div className="refresh-status">
              <div className="refresh-status-label">{refresh.label}</div>
              <div className="refresh-status-value">
                <span className={"live-dot" + (refresh.live ? "" : " idle")} aria-hidden="true" />
                <span title={refresh.value}>{refresh.value}</span>
              </div>
            </div>
            <button
              className="refresh-btn"
              type="button"
              onClick={refresh.onRefresh}
              disabled={refresh.disabled}
              title={refresh.hint}
              aria-label={refresh.hint}
            >
              <RefreshCw size={14} className={refresh.busy ? "spin" : ""} aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
    </header>
  );
}

/* ========================= GLOBAL DATE RANGE BAR ========================= */

export const RANGE_PRESETS = [
  { value: "YESTERDAY", label: "Yesterday" },
  { value: "7D", label: "7D" },
  { value: "30D", label: "30D" },
  { value: "90D", label: "90D" },
  { value: "MTD", label: "MTD" },
  { value: "YTD", label: "YTD" },
  { value: "CUSTOM", label: "Custom" },
];

/**
 * DateRangeSelector — the global range filter.
 *
 * Preset values, the custom-range inputs and their min/max clamping are the
 * app's existing ones; only the presentation changed. The resolved range is
 * shown beside the control so the selected preset is never ambiguous.
 */
export function DateRangeSelector({
  preset, onPresetChange,
  customFrom, customTo, onCustomFrom, onCustomTo,
  minDate, maxDate, rangeLabel, icon,
}) {
  return (
    <div className="controls-bar dashboard-controls">
      <div className="chip-row">
        <div className="segmented" role="group" aria-label="Date range">
          {RANGE_PRESETS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={preset === option.value}
              className={preset === option.value ? "active" : ""}
              onClick={() => onPresetChange(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        {preset === "CUSTOM" && (
          <span className="custom-range">
            <input
              type="date" aria-label="Custom range start" value={customFrom}
              min={minDate || undefined} max={maxDate}
              onChange={(event) => onCustomFrom(event.target.value)}
            />
            <input
              type="date" aria-label="Custom range end" value={customTo}
              min={minDate || undefined} max={maxDate}
              onChange={(event) => onCustomTo(event.target.value)}
            />
          </span>
        )}
      </div>
      {rangeLabel && (
        <span className="range-readout">
          {icon}
          {rangeLabel}
        </span>
      )}
    </div>
  );
}
