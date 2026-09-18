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

import React, { useEffect, useMemo, useRef, useState } from "react";
import { CAMPAIGN_ADS_TAB } from "../lib/feature-flags.js";
import {
  BellRing,
  Boxes,
  CalendarRange,
  DatabaseZap,
  ChevronDown,
  ChevronRight,
  FileSearch,
  Globe,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Megaphone,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  ReceiptText,
  RefreshCw,
  Search,
  ShieldAlert,
  Store,
  Tag,
  Tags,
  Activity,
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
      // Listing Health is CONSOLIDATED to the single v3 read-only page. The legacy v1 item is retired (its backend
      // stays intact only for rollback and is never invoked from the UI); the old "listinghealth" view key redirects
      // here (App.jsx onNavigate + render). This is now the production default, no longer gated by LISTING_HEALTH_V3.
      { view: "listinghealth-v3", label: "Listing Health — v3 preview (read-only)", title: "Listing Health — read-only OLI-window preview (creates no exports)", icon: ShieldAlert },
      { view: "buybox", label: "Buy Box Loss", title: "Buy Box Loss — featured-offer share and its causes", icon: Trophy },
    ],
  },
  {
    label: "Growth",
    items: [
      { view: "salesmovers", label: "Sales Movers", title: "Sales Movers — weekly ASIN gains and declines", icon: TrendingUp },
      { view: "skumovement", label: "SKU Movement", title: "SKU Movement — per-ASIN/SKU units, trend and month projection", icon: Activity },
      // ONE consolidated advertising destination. With CAMPAIGN_ADS_TAB on, "Ad Performance by Campaign" is the single
      // workspace (Performance / Wasted Spend / Brand Mapping tabs) and the legacy standalone "PPC Performance" item is
      // retired (its old view redirects here). With the flag OFF (rollback), the legacy PPC item returns.
      ...(CAMPAIGN_ADS_TAB
        ? [{ view: "campaign-ads", label: "Ad Performance by Campaign", title: "Ad Performance by Campaign — Performance, Wasted Spend & Brand Mapping", icon: Megaphone }]
        : [{ view: "ppc", label: "PPC Performance", title: "PPC Performance & Wasted Spend", icon: Megaphone }]),
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
 * SearchableSelect — an accessible combobox used for the header account/brand
 * pickers. It keeps the exact `.tb-select` look and change semantics but adds a
 * type-to-filter search over an already-authorized option list, so it never
 * exposes a hidden match or a global result count. Keyboard-complete: the closed
 * trigger opens on Enter/Space/ArrowDown; the search input drives ArrowUp/Down,
 * Home/End, Enter (select), Escape (close, focus returns to the trigger) and Tab
 * (close). Selecting preserves the value; closing or clearing the search never
 * changes it. Options: [{ value, label, searchText?, meta? }].
 */
export function SearchableSelect({
  id, ariaLabel, icon, label, value, options, onChange,
  placeholder = "Select…", disabled = false, emptyText = "No options available", noMatchText = "No matches",
  variant = "brand", trailing = null,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const triggerRef = useRef(null);
  const listRef = useRef(null);
  const listboxId = `${id}-listbox`;

  const selected = useMemo(
    () => options.find((option) => String(option.value) === String(value)) || null,
    [options, value]
  );
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((option) => String(option.searchText || option.label).toLowerCase().includes(q));
  }, [options, query]);

  // Keep the active row in range whenever the filtered set changes.
  useEffect(() => {
    setActiveIndex((index) => (filtered.length ? Math.min(Math.max(index, 0), filtered.length - 1) : 0));
  }, [filtered]);

  // Focus the search input on open so typing filters immediately.
  useEffect(() => { if (open && inputRef.current) inputRef.current.focus(); }, [open]);

  // Close on an outside pointer press (the value is preserved).
  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event) => { if (rootRef.current && !rootRef.current.contains(event.target)) closeMenu(false); };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [open]);

  // Keep the active option scrolled into view during keyboard navigation.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-index="${activeIndex}"]`);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  function openMenu() {
    if (disabled) return;
    setQuery("");
    const idx = options.findIndex((option) => String(option.value) === String(value));
    setActiveIndex(idx >= 0 ? idx : 0);
    setOpen(true);
  }
  function closeMenu(returnFocus = true) {
    setOpen(false);
    setQuery("");
    if (returnFocus && triggerRef.current) triggerRef.current.focus();
  }
  function choose(option) {
    if (!option) return;
    onChange(option.value);
    closeMenu(true);
  }
  function onInputKeyDown(event) {
    if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((i) => Math.min(i + 1, filtered.length - 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((i) => Math.max(i - 1, 0)); }
    else if (event.key === "Home") { event.preventDefault(); setActiveIndex(0); }
    else if (event.key === "End") { event.preventDefault(); setActiveIndex(Math.max(0, filtered.length - 1)); }
    else if (event.key === "Enter") { event.preventDefault(); choose(filtered[activeIndex]); }
    else if (event.key === "Escape") { event.preventDefault(); closeMenu(true); }
    else if (event.key === "Tab") { closeMenu(false); }
  }
  function onTriggerKeyDown(event) {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") { event.preventDefault(); openMenu(); }
  }

  const activeDescendant = open && filtered[activeIndex] ? `${id}-opt-${activeIndex}` : undefined;
  return (
    <div
      className={`tb-select tb-combo ${variant}` + (disabled ? " disabled" : "") + (open ? " open" : "")}
      ref={rootRef}
    >
      {icon}
      <div className="tb-select-body">
        {label && <div className="tb-select-label">{label}</div>}
        <div className="tb-select-value">
          <button
            type="button"
            className="tb-combo-trigger"
            ref={triggerRef}
            aria-label={ariaLabel}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={open ? listboxId : undefined}
            disabled={disabled}
            onClick={() => (open ? closeMenu(true) : openMenu())}
            onKeyDown={onTriggerKeyDown}
            title={selected ? selected.label : placeholder}
          >
            <span className={"tb-combo-text" + (selected ? "" : " placeholder")}>{selected ? selected.label : placeholder}</span>
          </button>
          <ChevronDown size={14} aria-hidden="true" />
        </div>
      </div>
      {trailing}
      {open && (
        <div className="tb-combo-pop">
          <div className="tb-combo-search">
            <Search size={13} aria-hidden="true" />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-autocomplete="list"
              aria-controls={listboxId}
              aria-expanded="true"
              aria-activedescendant={activeDescendant}
              aria-label={`Search ${ariaLabel || label || "options"}`}
              placeholder="Type to search…"
              value={query}
              onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
              onKeyDown={onInputKeyDown}
            />
          </div>
          <ul className="tb-combo-list" role="listbox" id={listboxId} ref={listRef} aria-label={ariaLabel || label}>
            {options.length === 0 ? (
              <li className="tb-combo-empty">{emptyText}</li>
            ) : filtered.length === 0 ? (
              <li className="tb-combo-empty">{noMatchText}</li>
            ) : filtered.map((option, idx) => (
              <li
                key={option.value}
                id={`${id}-opt-${idx}`}
                data-index={idx}
                role="option"
                aria-selected={String(option.value) === String(value)}
                className={"tb-combo-opt" + (idx === activeIndex ? " active" : "") + (String(option.value) === String(value) ? " selected" : "")}
                onMouseEnter={() => setActiveIndex(idx)}
                onMouseDown={(event) => { event.preventDefault(); choose(option); }}
              >
                <span className="tb-combo-opt-label">{option.label}</span>
                {option.meta ? <span className="tb-combo-meta">{option.meta}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * AccountSelector / BrandSelector / RegionSelector are the header scope pickers.
 * Account and Brand are searchable comboboxes (SearchableSelect); Region is a
 * short native <select> (three fixed regions, no search needed). All keep the
 * exact change semantics the app relies on.
 */
export function AccountSelector({ accounts, value, onChange, flags, onRefresh, refreshing = false }) {
  const options = useMemo(() => accounts.map((account) => ({
    value: account.id,
    // The visible label keeps the flag + name + currency; search also matches marketplace + currency.
    // An onboarding account (DataDoe still loading, or bootstrap pending) is labelled "Setting up" so
    // admins see it immediately without mistaking it for a fully-serving account.
    label: `${(flags[account.country] || "")} ${account.name} (${account.currency || "—"})${account.settingUp === true ? " — Setting up" : ""}`.trim(),
    searchText: `${account.name || ""} ${account.country || ""} ${account.currency || ""}${account.settingUp === true ? " setting up" : ""}`,
  })), [accounts, flags]);
  const refreshButton = onRefresh ? (
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
  ) : null;
  return (
    <SearchableSelect
      id="tb-account"
      ariaLabel="Account selection"
      icon={<Store size={15} aria-hidden="true" />}
      label="Account"
      variant="account"
      value={value || ""}
      options={options}
      onChange={onChange}
      placeholder={accounts.length ? "Select account" : "No accounts available"}
      disabled={!accounts.length}
      emptyText="No accounts available"
      trailing={refreshButton}
    />
  );
}

export function BrandSelector({ brands, value, onChange, includeAll = true, label = "Brand", allLabel = "All brands" }) {
  const options = useMemo(() => {
    const list = includeAll ? [{ value: "ALL", label: allLabel, searchText: allLabel }] : [];
    (brands || []).forEach((brand) => list.push({ value: brand, label: brand, searchText: brand }));
    return list;
  }, [brands, includeAll, allLabel]);
  return (
    <SearchableSelect
      id={`tb-brand-${label.replace(/\s+/g, "-").toLowerCase()}`}
      ariaLabel="Brand selection"
      icon={<Tag size={15} aria-hidden="true" />}
      label={label}
      variant="brand"
      value={value || (includeAll ? "ALL" : "")}
      options={options}
      onChange={onChange}
      placeholder={includeAll ? allLabel : "Select a brand"}
      emptyText={includeAll ? allLabel : "No brands in this region yet"}
      noMatchText="No matching brands"
    />
  );
}

export function RegionSelector({ regions, value, onChange }) {
  return (
    <div className="tb-select region">
      <Globe size={15} aria-hidden="true" />
      <div className="tb-select-body">
        <div className="tb-select-label">Region</div>
        <div className="tb-select-value">
          <select
            aria-label="Region selection"
            value={value || ""}
            onChange={(event) => onChange(event.target.value)}
            disabled={!regions.length}
          >
            {!regions.length && <option value="">No regions available</option>}
            {regions.map((region) => (
              <option value={region.value} key={region.value}>{region.label}</option>
            ))}
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
  brands, selectedBrand, onBrandChange, flags, brandAllLabel = "All brands",
  dashboardMode = "account", onDashboardModeChange, portfolioBrands = [], selectedPortfolioBrand = "", onPortfolioBrandChange,
  regions = [], selectedRegion = "", onRegionChange,
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
          {/* The Account/Brand view switch is available on every scoped report page. Both modes carry TWO scope
              controls (Account+Brand, or Region+Brand) so the header keeps the same shape and never shifts when the
              mode changes. */}
          {onDashboardModeChange && <DashboardModeSelector value={dashboardMode} onChange={onDashboardModeChange} />}
          {dashboardMode === "brand" ? (
            <>
              <RegionSelector regions={regions} value={selectedRegion} onChange={onRegionChange} />
              <BrandSelector brands={portfolioBrands} value={selectedPortfolioBrand} onChange={onPortfolioBrandChange} includeAll={false} label="Portfolio brand" />
            </>
          ) : <>
            <AccountSelector
              accounts={accounts}
              value={selectedAccountId}
              onChange={onAccountChange}
              flags={flags}
              onRefresh={onRefreshAccounts}
              refreshing={accountsRefreshing}
            />
            <BrandSelector brands={brands} value={selectedBrand} onChange={onBrandChange} allLabel={brandAllLabel} />
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
