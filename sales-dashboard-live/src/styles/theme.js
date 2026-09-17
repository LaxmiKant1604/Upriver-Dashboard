/* =====================================================================
   UPRIVER design system — the single stylesheet for the whole workspace.
   =====================================================================

   WHY THIS FILE EXISTS
   Every screen in this app (the dashboard, all thirteen reports, the login
   and access screens) renders `<style>{STYLE}</style>` from here. There is no
   per-view CSS and no CSS-in-JS runtime. That is deliberate: it means one
   token change restyles every current and future report at once, and it is
   why `src/views/shared.jsx` reuses these class names instead of inventing
   its own.

   THE RULE FOR FUTURE REPORTS
   Build new reports out of the tokens and the shared patterns below
   (`panel`, `chart-card`, `metric-card`, `data-table`, `alert`, `state-*`,
   `skeleton-*`, `status-badge`, `plan-field`, `pagination`). Do not add
   hard-coded colours, spacing or radii in a view. If a report needs
   something the system lacks, add it here as a token or a shared pattern so
   the next report inherits it.

   THEME: light only. There is no dark mode and no theme toggle.

   DEPTH: three surface levels only.
     Level 0  --bg-app        the application canvas
     Level 1  --bg-surface    panels, chart containers, report sections
     Level 2  --bg-elevated   KPI cards, dropdowns, popovers, active controls
   Depth comes from 1px borders plus a soft ambient shadow, never from
   dramatic drop shadows, glass blur or rotation.                          */

export const STYLE = `
:root{
  /* ---- surfaces (three levels, light cool-neutral) ---- */
  --bg-app:#F0EFFE;
  --bg-surface:#FFFFFF;
  --bg-elevated:#FFFFFF;
  --bg-subtle:#F8F7FF;
  --bg-sunken:#E9E6FA;

  /* ---- borders ---- */
  --border-default:#E3DDFC;
  --border-strong:#D5CCFA;
  --border-hover:#C2B5F6;

  /* ---- text ---- */
  --text-primary:#17152C;
  --text-secondary:#5F5A79;
  --text-muted:#8E87AA;
  --text-inverse:#FFFFFF;

  /* ---- accent: the interactive colour. Active nav, selected controls,
         primary actions and the primary chart series. ---- */
  --accent:#8B5CF6;
  --accent-strong:#6D42E8;
  --accent-soft:#F1EDFF;
  --accent-border:#D8CEFF;
  --coral:#FF6B6B;
  --coral-strong:#F05063;
  --coral-soft:#FFF0F1;

  /* ---- UPRIVER brand gold. Controlled use only: the logo mark, the
         workspace crumb and the MTD emphasis column. Never a whole UI. ---- */
  --brand:#FF7B62;
  --brand-deep:#E85357;
  --brand-soft:#FFF0ED;

  /* ---- semantic performance colours ---- */
  --positive:#0B8A5C;
  --positive-soft:#E7F5EE;
  --positive-border:#B9E2CE;
  --negative:#C43241;
  --negative-soft:#FCEBEC;
  --negative-border:#F2C9CD;
  --warning:#A96F09;
  --warning-soft:#FDF4E4;
  --warning-border:#EFDCB2;
  --info:#1B6E9C;
  --info-soft:#EAF3F9;
  --info-border:#C3DDEE;

  /* ---- chart palette (mirrors CHART in this module) ---- */
  --chart-1:#8B5CF6;
  --chart-2:#10B981;
  --chart-3:#FF9F43;
  --chart-4:#FF5D6C;
  --chart-5:#A78BFA;
  --chart-neutral:#D9D3EE;
  --grid-line:#EEEAFB;

  /* ---- radii ---- */
  --radius-sm:8px;
  --radius-md:12px;
  --radius-lg:16px;
  --radius-pill:999px;

  /* ---- elevation. Small differences, soft and ambient. ---- */
  --shadow-xs:0 1px 3px rgba(45,26,94,.05);
  --shadow-sm:0 2px 8px rgba(63,42,121,.07);
  --shadow-md:0 8px 22px -8px rgba(65,38,133,.18);
  --shadow-lg:0 20px 50px -15px rgba(29,10,76,.36);

  /* ---- spacing ---- */
  --space-1:4px;
  --space-2:8px;
  --space-3:12px;
  --space-4:16px;
  --space-5:24px;
  --space-6:32px;

  /* ---- motion: 150-250ms, no bounce, no looping decoration ---- */
  --t-fast:150ms;
  --t:200ms;
  --t-slow:250ms;
  --ease:cubic-bezier(.4,0,.2,1);

  --sidebar-w:220px;
  --sidebar-w-collapsed:60px;

  /* ---- compatibility aliases. Existing views and a few inline styles read
         these names; they now resolve to the tokens above so nothing has to
         be rewritten to inherit the new palette. ---- */
  --bg:var(--bg-app);
  --surface:var(--bg-surface);
  --ink:var(--text-primary);
  --ink-soft:var(--text-secondary);
  --border:var(--border-default);
  --accent-deep:var(--accent-strong);
  --pos:var(--positive);
  --neg:var(--negative);
}

*{ box-sizing:border-box; }
html,body,#root{ margin:0; padding:0; height:100%; }
body{ overflow-x:hidden; }
.dash-root{
  font-family:'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  background:var(--bg-app); color:var(--text-primary); min-height:100vh;
  -webkit-font-smoothing:antialiased; font-feature-settings:'cv11','ss01';
}
.mono{ font-family:'Outfit','Plus Jakarta Sans',sans-serif; font-variant-numeric:tabular-nums; font-feature-settings:'tnum'; }
.num{ font-variant-numeric:tabular-nums; }
.sr-only{ position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
.spin{ animation:spin 1s linear infinite; }
@keyframes spin{ from{transform:rotate(0deg);} to{transform:rotate(360deg);} }

/* =========================== APP SHELL =========================== */
.app-shell{ display:flex; align-items:stretch; min-height:100vh; }
.main-area{ flex:1; min-width:0; display:flex; flex-direction:column; padding-bottom:var(--space-6); background:var(--bg-app); }

/* ---- Sidebar: a premium navigation rail ---- */
.sidebar{
  width:var(--sidebar-w); flex-shrink:0; background:var(--bg-surface);
  border-right:1px solid var(--border-default); display:flex; flex-direction:column;
  position:sticky; top:0; height:100vh; z-index:40;
  transition:width var(--t-slow) var(--ease);
}
.sidebar.collapsed{ width:var(--sidebar-w-collapsed); }
.sb-brand{
  display:flex; align-items:center; gap:10px; padding:0 14px; min-height:60px;
  border-bottom:1px solid var(--border-default); flex-shrink:0;
}
.sb-logo{
  width:32px; height:32px; flex-shrink:0; border-radius:9px;
  background:linear-gradient(160deg,#1B2540 0%,#111A2E 100%);
  color:var(--text-inverse); font-family:'Outfit',sans-serif; font-weight:700;
  font-size:12.5px; letter-spacing:.02em; display:grid; place-items:center;
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.08), var(--shadow-xs);
}
.sb-logo::after{ content:''; position:absolute; }
.sb-brand-text{ display:flex; flex-direction:column; min-width:0; }
.sb-ws-name{ font-size:13px; font-weight:800; letter-spacing:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.sb-ws-sub{ font-size:10.5px; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:1px; }
.sidebar.collapsed .sb-brand{ justify-content:center; padding:0; }
.sidebar.collapsed .sb-brand-text{ display:none; }
.sb-close{ display:none; margin-left:auto; border:none; background:transparent; color:var(--text-secondary); cursor:pointer; padding:6px; border-radius:var(--radius-sm); }
.sb-close:hover{ background:var(--bg-sunken); color:var(--text-primary); }

.sb-nav{ display:flex; flex-direction:column; padding:10px 8px 14px; flex:1; overflow-y:auto; overflow-x:hidden; gap:2px; }
.sb-nav::-webkit-scrollbar{ width:8px; }
.sb-nav::-webkit-scrollbar-thumb{ background:var(--border-strong); border-radius:var(--radius-pill); border:2px solid var(--bg-surface); }
.sb-group{ display:flex; flex-direction:column; gap:2px; }
.sb-group + .sb-group{ margin-top:12px; }
.sb-group-label{
  font-size:9.5px; font-weight:800; letter-spacing:.09em; text-transform:uppercase;
  color:var(--text-muted); padding:0 10px 5px; white-space:nowrap; overflow:hidden;
}
.sidebar.collapsed .sb-group-label{ visibility:hidden; height:9px; padding-bottom:2px; }
.sidebar.collapsed .sb-group + .sb-group{ margin-top:8px; border-top:1px solid var(--border-default); padding-top:8px; }

.sb-nav-item{
  position:relative; display:flex; align-items:center; gap:10px; width:100%;
  padding:8px 10px; border:none; background:transparent; border-radius:var(--radius-sm);
  font-size:13px; font-weight:650; color:var(--text-secondary); cursor:pointer;
  font-family:inherit; text-align:left; line-height:1.2;
  transition:background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.sb-nav-item svg{ flex-shrink:0; opacity:.85; }
.sb-nav-label{ min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sb-nav-item:hover{ background:var(--bg-sunken); color:var(--text-primary); }
.sb-nav-item:hover svg{ opacity:1; }
.sb-nav-item.active{ background:var(--accent-soft); color:var(--accent-strong); font-weight:750; }
.sb-nav-item.active svg{ opacity:1; }
/* Slim accent indicator rather than an oversized pill. */
.sb-nav-item.active::before{
  content:''; position:absolute; left:-8px; top:50%; transform:translateY(-50%);
  width:3px; height:18px; border-radius:0 3px 3px 0; background:var(--accent);
}
.sidebar.collapsed .sb-nav-item{ justify-content:center; padding:9px 0; }
.sidebar.collapsed .sb-nav-label{ display:none; }
.sidebar.collapsed .sb-nav-item.active::before{ left:0; }

.sb-footer{ padding:8px; border-top:1px solid var(--border-default); display:flex; flex-direction:column; gap:2px; flex-shrink:0; }
.sb-collapse{
  display:flex; align-items:center; gap:10px; width:100%; padding:8px 10px; border:none;
  background:transparent; border-radius:var(--radius-sm); font-size:12px; font-weight:700;
  color:var(--text-secondary); cursor:pointer; font-family:inherit; text-align:left;
  transition:background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.sb-collapse:hover{ background:var(--bg-sunken); color:var(--text-primary); }
.sb-collapse.signout:hover{ background:var(--negative-soft); color:var(--negative); }
.sidebar.collapsed .sb-collapse{ justify-content:center; padding:9px 0; }
.sb-backdrop{ display:none; }
.menu-btn{
  display:none; border:1px solid var(--border-default); background:var(--bg-surface);
  border-radius:var(--radius-sm); padding:7px; cursor:pointer; color:var(--text-primary);
  align-items:center; box-shadow:var(--shadow-xs);
}
.menu-btn:hover{ border-color:var(--border-hover); }

/* ======================= TOP COMMAND BAR ======================= */
.topbar{
  display:flex; align-items:center; gap:var(--space-4); padding:11px 22px;
  background:var(--bg-surface); border-bottom:1px solid var(--border-default);
  position:sticky; top:0; z-index:30; min-height:60px; flex-wrap:wrap;
}
.tb-left{ display:flex; align-items:center; gap:10px; min-width:0; }
.crumbs{ display:flex; align-items:center; gap:7px; min-width:0; font-size:12.5px; }
.crumb-root{
  display:inline-flex; align-items:center; gap:6px; color:var(--text-secondary);
  font-weight:700; white-space:nowrap;
}
.crumb-root .crumb-mark{
  font-family:'Outfit',sans-serif; font-size:10.5px; font-weight:700; letter-spacing:.07em;
  color:var(--brand-deep); background:var(--brand-soft); border:1px solid var(--warning-border);
  padding:3px 7px; border-radius:var(--radius-sm);
}
.crumb-sep{ color:var(--border-strong); flex-shrink:0; }
.crumb-current{ font-size:14px; font-weight:800; letter-spacing:0; color:var(--text-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.tb-right{ display:flex; align-items:center; gap:var(--space-2); margin-left:auto; min-width:0; flex-wrap:wrap; justify-content:flex-end; }

/* ---- Account / Brand selectors: icon + label + value + chevron ---- */
.tb-select{ position:relative; display:flex; align-items:center; gap:8px; min-width:0;
  border:1px solid var(--border-default); background:var(--bg-elevated); border-radius:var(--radius-sm);
  padding:5px 9px; box-shadow:var(--shadow-xs);
  transition:border-color var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease);
}
.tb-select:hover{ border-color:var(--border-hover); box-shadow:var(--shadow-sm); }
.tb-select:focus-within{ border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-soft); }
.tb-select > svg:first-child{ color:var(--text-muted); flex-shrink:0; }
.tb-select-body{ display:flex; flex-direction:column; min-width:0; flex:1; }
.tb-select-label{ font-size:9px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; color:var(--text-muted); line-height:1.2; }
.tb-select-value{ position:relative; display:flex; align-items:center; min-width:0; }
.tb-select select{
  appearance:none; border:0; background:transparent; padding:0 16px 0 0; margin:0;
  font:750 12.5px inherit; color:var(--text-primary); cursor:pointer; outline:none;
  width:100%; text-overflow:ellipsis; line-height:1.35;
}
.tb-select-value > svg{ position:absolute; right:0; pointer-events:none; color:var(--text-muted); }
.tb-select.account select{ min-width:190px; max-width:290px; }
.tb-select.brand select{ min-width:130px; max-width:210px; }
.tb-select select:disabled{ color:var(--text-muted); cursor:not-allowed; }
.account-sync-btn{
  width:28px; height:28px; flex:0 0 28px; border:1px solid var(--border-default);
  border-radius:6px; background:var(--bg-surface); color:var(--text-secondary);
  display:inline-flex; align-items:center; justify-content:center; cursor:pointer;
  transition:border-color var(--t-fast) var(--ease), color var(--t-fast) var(--ease), background var(--t-fast) var(--ease);
}
.account-sync-btn:hover:not(:disabled){ border-color:var(--accent); color:var(--accent); background:var(--accent-soft); }
.account-sync-btn:disabled{ opacity:.5; cursor:not-allowed; }

/* ---- Region selector (native <select>, three fixed scheduler regions) ---- */
.tb-select.region select{ min-width:150px; max-width:230px; }

/* ---- Searchable combobox (Account / Brand): the same .tb-select shell, but the
   value is a button that opens a search + listbox popover. Stable trigger widths
   match the native selects so switching Account<->Brand view never shifts the header. */
.tb-combo-trigger{
  appearance:none; border:0; background:transparent; padding:0 16px 0 0; margin:0;
  font:750 12.5px inherit; color:var(--text-primary); cursor:pointer; outline:none;
  width:100%; text-align:left; display:block; line-height:1.35;
}
.tb-combo-trigger:disabled{ color:var(--text-muted); cursor:not-allowed; }
.tb-combo-text{ display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.tb-combo-text.placeholder{ color:var(--text-muted); font-weight:650; }
.tb-combo.account .tb-combo-trigger{ min-width:190px; max-width:290px; }
.tb-combo.brand .tb-combo-trigger{ min-width:150px; max-width:230px; }
.tb-combo-pop{
  position:absolute; top:calc(100% + 6px); left:0; z-index:60;
  min-width:240px; max-width:360px; width:max-content;
  background:var(--bg-surface); border:1px solid var(--border-default); border-radius:var(--radius-md);
  box-shadow:var(--shadow-lg); padding:6px; display:flex; flex-direction:column; gap:6px;
}
.tb-combo-search{ display:flex; align-items:center; gap:6px; padding:5px 8px; border:1px solid var(--border-default);
  border-radius:var(--radius-sm); background:var(--bg-elevated); }
.tb-combo-search > svg{ color:var(--text-muted); flex-shrink:0; }
.tb-combo-search input{ border:0; background:transparent; outline:none; width:100%; font:600 12.5px inherit; color:var(--text-primary); }
.tb-combo-list{ list-style:none; margin:0; padding:0; max-height:290px; overflow-y:auto; overscroll-behavior:contain; }
.tb-combo-opt{ display:flex; align-items:center; justify-content:space-between; gap:10px; padding:7px 9px;
  border-radius:6px; cursor:pointer; font-size:12.5px; color:var(--text-primary); }
.tb-combo-opt-label{ overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.tb-combo-opt.active{ background:var(--accent-soft); }
.tb-combo-opt.selected{ font-weight:800; }
.tb-combo-meta{ color:var(--text-muted); font-size:11px; flex-shrink:0; }
.tb-combo-empty{ padding:12px 9px; color:var(--text-muted); font-size:12px; text-align:center; }

/* ---- Refresh status cluster ---- */
.refresh-cluster{
  display:flex; align-items:center; gap:9px; border:1px solid var(--border-default);
  background:var(--bg-elevated); border-radius:var(--radius-sm); padding:5px 6px 5px 10px;
  box-shadow:var(--shadow-xs); min-width:0;
}
.refresh-status{ display:flex; flex-direction:column; min-width:0; }
.refresh-status-label{ font-size:9px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; color:var(--text-muted); line-height:1.2; }
.refresh-status-value{ display:flex; align-items:center; gap:6px; font-size:11.5px; font-weight:700; color:var(--text-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:230px; }
.live-dot{ width:7px; height:7px; border-radius:50%; background:var(--positive); flex-shrink:0; box-shadow:0 0 0 3px var(--positive-soft); }
.live-dot.idle{ background:var(--text-muted); box-shadow:0 0 0 3px var(--bg-sunken); }
.refresh-btn{
  border:1px solid var(--border-default); background:var(--bg-surface); border-radius:var(--radius-sm);
  min-width:30px; min-height:30px; padding:0 7px; cursor:pointer; display:inline-flex; align-items:center;
  justify-content:center; color:var(--text-secondary); flex-shrink:0;
  transition:border-color var(--t-fast) var(--ease), color var(--t-fast) var(--ease), background var(--t-fast) var(--ease);
}
.refresh-btn:hover:not(:disabled){ border-color:var(--accent); color:var(--accent); background:var(--accent-soft); }
.refresh-btn:disabled{ opacity:.5; cursor:not-allowed; }

/* ======================= PAGE STRUCTURE ======================= */
.container{ width:100%; max-width:1360px; margin:0 auto; padding:var(--space-5) var(--space-5) 0; min-width:0; }
.page-head{ display:flex; align-items:flex-end; justify-content:space-between; gap:var(--space-4); flex-wrap:wrap; }
.page-title{ font-size:19px; font-weight:800; letter-spacing:0; color:var(--text-primary); }
.page-sub{ font-size:12px; color:var(--text-secondary); margin-top:3px; line-height:1.5; }
.controls-bar{ display:flex; align-items:center; justify-content:space-between; gap:var(--space-4); margin-top:var(--space-4); flex-wrap:wrap; min-width:0; }
.dashboard-controls{ justify-content:space-between; }
.section-label{ font-size:10.5px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; color:var(--text-muted); margin:var(--space-5) 0 calc(var(--space-2) * -0.5); }

/* ======================= CONTROLS ======================= */
/* Segmented control — the global date range filter. */
.segmented{
  display:inline-flex; align-items:center; background:var(--bg-sunken);
  border:1px solid var(--border-default); border-radius:10px; padding:3px; gap:2px;
  box-shadow:inset 0 1px 2px rgba(17,26,46,.03); min-width:0; max-width:100%;
}
.segmented button{ flex:0 0 auto; }
.segmented button{
  border:none; background:transparent; padding:6px 12px; font:750 12px inherit;
  color:var(--text-secondary); border-radius:7px; cursor:pointer; white-space:nowrap;
  transition:background var(--t-fast) var(--ease), color var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease);
}
.segmented button:hover:not(.active){ color:var(--text-primary); background:rgba(255,255,255,.7); }
.segmented button.active{ background:var(--bg-surface); color:var(--accent-strong); box-shadow:var(--shadow-sm); }
.segmented.sm button{ padding:5px 10px; font-size:11.5px; }

/* Legacy chip row / seg / tabs kept so existing views keep working. */
.chip-row{ display:flex; gap:6px; flex-wrap:wrap; align-items:center; min-width:0; max-width:100%; }
.chip{
  border:1px solid var(--border-default); background:var(--bg-surface); padding:6px 12px;
  font:700 12.5px inherit; border-radius:var(--radius-sm); cursor:pointer; color:var(--text-secondary);
  transition:all var(--t-fast) var(--ease);
}
.chip:hover{ border-color:var(--border-hover); color:var(--text-primary); }
.chip.active{ border-color:var(--accent-border); background:var(--accent-soft); color:var(--accent-strong); }
.seg{ display:inline-flex; background:var(--bg-sunken); border:1px solid var(--border-default); border-radius:9px; padding:3px; gap:2px; }
.seg button{ border:none; background:transparent; padding:5px 12px; font:700 12px inherit; border-radius:6px; cursor:pointer; color:var(--text-secondary); transition:all var(--t-fast) var(--ease); }
.seg button:hover:not(.active){ color:var(--text-primary); }
.seg button.active{ background:var(--bg-surface); color:var(--accent-strong); box-shadow:var(--shadow-sm); }
.report-tabs{ display:inline-flex; background:var(--bg-sunken); border:1px solid var(--border-default); border-radius:10px; padding:3px; flex-wrap:wrap; gap:2px; }
.report-tabs button{ border:none; background:transparent; padding:6px 12px; font:700 12px inherit; border-radius:7px; cursor:pointer; color:var(--text-secondary); transition:all var(--t-fast) var(--ease); }
.report-tabs button:hover:not(.active){ color:var(--text-primary); }
.report-tabs button.active{ background:var(--bg-surface); color:var(--accent-strong); box-shadow:var(--shadow-sm); }
.tabs{ display:inline-flex; background:var(--bg-surface); border:1px solid var(--border-default); border-radius:12px; padding:4px; gap:2px; }
.tab{ border:none; background:transparent; padding:8px 16px; font:700 13.5px inherit; color:var(--text-secondary); border-radius:9px; cursor:pointer; }
.tab.active{ background:var(--text-primary); color:var(--text-inverse); }

.select{ position:relative; display:inline-flex; align-items:center; }
.select select{
  appearance:none; border:1px solid var(--border-default); background:var(--bg-elevated);
  padding:8px 32px 8px 12px; border-radius:var(--radius-sm); font:700 13px inherit;
  color:var(--text-primary); cursor:pointer; min-width:200px; box-shadow:var(--shadow-xs);
  transition:border-color var(--t-fast) var(--ease);
}
.select select:hover{ border-color:var(--border-hover); }
.select svg{ position:absolute; right:10px; pointer-events:none; color:var(--text-muted); }

.custom-range{ display:inline-flex; gap:6px; align-items:center; }
.custom-range input[type=date],
.recon-filters input[type=date]{
  border:1px solid var(--border-default); border-radius:var(--radius-sm); padding:6px 9px;
  font:650 12px inherit; color:var(--text-primary); background:var(--bg-elevated); box-shadow:var(--shadow-xs);
}
.range-readout{
  display:inline-flex; align-items:center; gap:6px; font-size:11.5px; font-weight:700;
  color:var(--text-secondary); background:var(--bg-surface); border:1px solid var(--border-default);
  border-radius:var(--radius-sm); padding:6px 10px; white-space:nowrap;
}
.range-readout svg{ color:var(--text-muted); }

.plan-field{ display:flex; flex-direction:column; gap:5px; min-width:0; }
.plan-field-label{ font-size:9.5px; font-weight:800; text-transform:uppercase; letter-spacing:.08em; color:var(--text-muted); }
.plan-field input[type=number],
.plan-field select,
.skupl-toolbar .plan-field select,
.recon-select select{
  min-height:34px; border:1px solid var(--border-default); border-radius:var(--radius-sm);
  padding:7px 10px; font:700 12.5px inherit; color:var(--text-primary); background:var(--bg-elevated);
  box-shadow:var(--shadow-xs); transition:border-color var(--t-fast) var(--ease);
}
.plan-field input[type=number]{ width:120px; }
.plan-field select:hover, .plan-field input:hover{ border-color:var(--border-hover); }
.plan-search{ flex:1; min-width:190px; }
.plan-search-wrap{
  display:flex; align-items:center; gap:8px; border:1px solid var(--border-default);
  border-radius:var(--radius-sm); padding:0 11px; background:var(--bg-elevated);
  box-shadow:var(--shadow-xs); transition:border-color var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease);
}
.plan-search-wrap:focus-within{ border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-soft); }
.plan-search-wrap svg{ color:var(--text-muted); flex-shrink:0; }
.plan-search-wrap input{ border:none; outline:none; padding:8px 0; font:600 12.5px inherit; color:var(--text-primary); width:100%; min-width:0; background:transparent; }

.plan-export-btn{
  display:inline-flex; align-items:center; justify-content:center; gap:7px; min-height:34px;
  padding:7px 12px; border:1px solid var(--border-strong); border-radius:var(--radius-sm);
  background:var(--bg-elevated); color:var(--text-primary); font:700 12.5px inherit; cursor:pointer;
  white-space:nowrap; box-shadow:var(--shadow-xs);
  transition:all var(--t-fast) var(--ease);
}
.plan-export-btn:hover:not(:disabled){ border-color:var(--accent); color:var(--accent-strong); background:var(--accent-soft); }
.plan-export-btn:disabled{ opacity:.5; cursor:not-allowed; }
.plan-export-btn svg{ opacity:.8; }

/* FBA Shipment Plan -- durable planning settings bar + seller-warehouse cell + priority badges */
.plan-settings{ display:flex; flex-wrap:wrap; gap:18px; align-items:flex-end; margin-top:12px; padding:12px 14px; border:1px solid var(--border-default); border-radius:var(--radius-md); background:var(--bg-surface); }
.plan-set-group{ display:flex; flex-direction:column; gap:6px; min-width:0; }
.plan-seg{ display:inline-flex; align-items:center; gap:6px; }
.plan-seg-btn{ min-width:38px; height:32px; padding:0 10px; border:1px solid var(--border-default); border-radius:var(--radius-sm); background:var(--bg-elevated); color:var(--text-secondary); font:800 12px inherit; cursor:pointer; }
.plan-seg-btn.active{ background:linear-gradient(135deg,#FF6B6B,#FF8E53); border-color:transparent; color:#fff; }
.plan-seg-btn:disabled{ opacity:.55; cursor:default; }
.plan-seg-custom{ display:inline-flex; align-items:center; gap:5px; padding:0 8px; height:32px; border:1px solid var(--border-default); border-radius:var(--radius-sm); background:var(--bg-elevated); font-size:11px; color:var(--text-muted); }
.plan-seg-custom.active{ border-color:var(--accent); box-shadow:inset 0 0 0 1px var(--accent-soft); }
.plan-seg-custom input{ width:52px; border:0; background:transparent; font:700 12px inherit; color:var(--text-primary); text-align:right; }
.plan-set-group select, .plan-set-group input[type=number]{ height:32px; border:1px solid var(--border-default); border-radius:var(--radius-sm); background:var(--bg-elevated); color:var(--text-primary); font:600 12px inherit; padding:0 8px; }
.plan-set-group input[type=number]{ width:90px; }
.plan-weights{ display:inline-flex; align-items:center; gap:6px; flex-wrap:wrap; }
.plan-weights input{ width:52px; height:30px; border:1px solid var(--border-default); border-radius:var(--radius-sm); background:var(--bg-elevated); text-align:right; font:600 12px inherit; padding:0 6px; }
.plan-weight-sum{ font-size:11px; font-weight:800; padding:2px 8px; border-radius:var(--radius-pill); }
.plan-weight-sum.ok{ background:var(--positive-soft); color:var(--positive); }
.plan-weight-sum.bad{ background:var(--negative-soft); color:var(--negative); }
.plan-mini-btn{ height:30px; padding:0 10px; border:1px solid var(--border-default); border-radius:var(--radius-sm); background:var(--bg-elevated); color:var(--text-secondary); font:800 11px inherit; cursor:pointer; }
.plan-mini-btn:disabled{ opacity:.5; cursor:default; }
.plan-wh-cell{ padding:4px 8px; }
.plan-wh-btn{ min-width:44px; padding:3px 8px; border:1px dashed var(--border-default); border-radius:var(--radius-sm); background:transparent; color:var(--text-primary); font:700 12px inherit; font-variant-numeric:tabular-nums; cursor:pointer; }
.plan-wh-btn:hover{ border-color:var(--accent); color:var(--accent-strong); background:var(--accent-soft); }
.plan-wh-empty{ color:var(--text-muted); font-weight:600; }
.plan-wh-cell input{ width:64px; height:28px; border:1px solid var(--accent); border-radius:var(--radius-sm); background:var(--bg-elevated); text-align:right; font:700 12px inherit; padding:0 6px; }
/* ADDITIVE: WDD weight settings + Inbound-ETA countdown cell (sit beside the existing plan controls). */
.plan-wdd-settings{ margin-top:10px; }
.plan-wdd-w{ display:inline-flex; align-items:center; gap:5px; }
.plan-wdd-tag{ font:800 10px inherit; color:var(--text-muted); letter-spacing:.02em; }
.plan-wdd-msg{ font-size:11px; font-weight:700; color:var(--negative); margin-top:4px; }
.plan-eta-cell{ padding:4px 8px; white-space:nowrap; }
.plan-eta-cell .plan-eta-val{ margin-right:8px; font-variant-numeric:tabular-nums; }
.plan-eta-cell .plan-mini-btn{ height:24px; padding:0 8px; }
.pt-badge.plan-prio-critical{ background:var(--negative-soft); color:var(--negative); }
.pt-badge.plan-prio-high{ background:var(--warning-soft); color:var(--warning); }
.pt-badge.plan-prio-medium{ background:var(--accent-soft); color:var(--accent-strong); }
.pt-badge.plan-prio-low{ background:var(--bg-subtle); color:var(--text-secondary); }
.pt-badge.plan-prio-ok{ background:var(--positive-soft); color:var(--positive); }
/* FBA plan toolbar (import + columns) */
.plan-tool-btn{ display:inline-flex; align-items:center; gap:7px; height:38px; padding:0 14px; border:1px solid var(--border-default); border-radius:var(--radius-sm); background:var(--bg-elevated); color:var(--text-secondary); font:800 12px inherit; cursor:pointer; }
.plan-tool-btn:hover:not(:disabled){ border-color:var(--accent); color:var(--accent-strong); background:var(--accent-soft); }
.plan-tool-btn:disabled{ opacity:.5; cursor:not-allowed; }
.plan-cols-wrap{ position:relative; }
.plan-cols-pop{ position:absolute; z-index:40; top:calc(100% + 6px); right:0; width:300px; max-height:70vh; overflow:auto; border:1px solid var(--border-default); border-radius:var(--radius-md); background:var(--bg-surface); box-shadow:0 12px 40px rgba(0,0,0,.28); padding:10px; }
.plan-cols-head{ display:flex; align-items:center; justify-content:space-between; gap:8px; font:800 13px inherit; color:var(--text-primary); padding:2px 2px 8px; border-bottom:1px solid var(--border-default); }
.plan-cols-actions{ display:inline-flex; align-items:center; gap:6px; }
.plan-cols-group{ padding:8px 2px 2px; }
.plan-cols-group-title{ font:800 10px inherit; letter-spacing:.06em; text-transform:uppercase; color:var(--text-muted); margin-bottom:4px; }
.plan-cols-item{ display:flex; align-items:center; gap:8px; padding:4px 4px; font:600 12px inherit; color:var(--text-primary); cursor:pointer; border-radius:var(--radius-sm); }
.plan-cols-item:hover{ background:var(--bg-subtle); }
.plan-cols-item.locked{ color:var(--text-muted); cursor:default; }
.plan-cols-lock{ color:var(--text-muted); font-weight:600; }
.plan-horizon-btn{ display:inline-flex; align-items:center; gap:4px; min-width:36px; padding:2px 7px; border:1px solid transparent; border-radius:var(--radius-sm); background:var(--bg-subtle); color:var(--text-secondary); font:700 12px inherit; cursor:pointer; }
.plan-horizon-btn:hover{ border-color:var(--accent); color:var(--accent-strong); background:var(--accent-soft); }
.plan-horizon-btn.has-override{ color:var(--accent-strong); font-weight:800; }
.plan-horizon-dot{ width:6px; height:6px; border-radius:50%; background:var(--accent); display:inline-block; }
/* FBA plan modals (SKU horizon + warehouse import) */
.plan-modal-backdrop{ position:fixed; inset:0; z-index:60; background:rgba(15,18,28,.55); display:flex; align-items:flex-start; justify-content:center; padding:6vh 16px; overflow:auto; }
.plan-modal{ width:100%; max-width:560px; border:1px solid var(--border-default); border-radius:var(--radius-lg); background:var(--bg-surface); box-shadow:0 24px 70px rgba(0,0,0,.4); display:flex; flex-direction:column; }
.plan-modal-sm{ max-width:420px; }
.plan-modal-lg{ max-width:760px; }
.plan-modal-head{ display:flex; align-items:flex-start; justify-content:space-between; gap:12px; padding:16px 18px; border-bottom:1px solid var(--border-default); }
.plan-modal-title{ font:800 15px inherit; color:var(--text-primary); }
.plan-modal-sub{ font-size:12px; color:var(--text-muted); margin-top:3px; }
.plan-modal-body{ padding:16px 18px; display:flex; flex-direction:column; gap:12px; }
.plan-modal-note, .plan-modal-foot-note{ font-size:12px; color:var(--text-secondary); margin:0; }
.plan-modal-foot{ display:flex; align-items:center; justify-content:space-between; gap:12px; padding:14px 18px; border-top:1px solid var(--border-default); }
.plan-tool-btn-primary{ background:var(--accent, #b45309); border-color:var(--accent, #b45309); color:#fff; }
.plan-tool-btn-primary:disabled{ opacity:.6; cursor:not-allowed; }
.plan-icon-btn{ display:inline-flex; align-items:center; justify-content:center; width:30px; height:30px; border:1px solid var(--border-default); border-radius:var(--radius-sm); background:var(--bg-elevated); color:var(--text-secondary); cursor:pointer; }
.plan-icon-btn:hover{ border-color:var(--accent); color:var(--accent-strong); }
.plan-reset-link{ display:inline-flex; align-items:center; gap:6px; background:none; border:0; padding:2px 0; color:var(--accent-strong); font:700 12px inherit; cursor:pointer; }
.plan-reset-link:disabled{ opacity:.4; cursor:default; }
.plan-import-controls{ display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.plan-import-file{ display:inline-flex; align-items:center; gap:8px; padding:8px 12px; border:1px dashed var(--border-default); border-radius:var(--radius-sm); background:var(--bg-elevated); color:var(--text-secondary); font:700 12px inherit; cursor:pointer; }
.plan-import-file:hover{ border-color:var(--accent); color:var(--accent-strong); }
.plan-import-file input{ display:none; }
.plan-import-paste summary{ font-size:12px; color:var(--text-muted); cursor:pointer; }
.plan-import-paste textarea{ width:100%; margin-top:6px; border:1px solid var(--border-default); border-radius:var(--radius-sm); background:var(--bg-elevated); color:var(--text-primary); font:500 12px ui-monospace,monospace; padding:8px; }
.plan-import-summary{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.plan-import-pill{ display:inline-flex; align-items:center; gap:5px; padding:3px 9px; border-radius:var(--radius-pill); font:800 11px inherit; background:var(--bg-subtle); color:var(--text-secondary); }
.plan-import-pill.ok{ background:var(--positive-soft); color:var(--positive); }
.plan-import-pill.bad{ background:var(--negative-soft); color:var(--negative); }
.plan-import-table-wrap{ max-height:220px; overflow:auto; border:1px solid var(--border-default); border-radius:var(--radius-sm); }
.plan-import-table{ width:100%; border-collapse:collapse; font-size:12px; }
.plan-import-table th{ position:sticky; top:0; background:var(--bg-subtle); text-align:left; padding:6px 8px; font-weight:800; color:var(--text-secondary); }
.plan-import-table td{ padding:5px 8px; border-top:1px solid var(--border-default); color:var(--text-primary); }
.plan-import-table tr.bad td{ color:var(--negative); }
.plan-import-more{ padding:6px 8px; font-size:11px; color:var(--text-muted); }
.secondary-action{
  display:inline-flex; align-items:center; gap:6px; min-height:34px; border:1px solid var(--border-default);
  border-radius:var(--radius-sm); padding:7px 11px; color:var(--text-secondary); background:var(--bg-elevated);
  font:700 12px inherit; cursor:pointer; transition:all var(--t-fast) var(--ease);
}
.secondary-action:hover{ border-color:var(--accent); color:var(--accent-strong); }
.icon-action{
  display:inline-grid; place-items:center; width:26px; height:26px; padding:0;
  border:1px solid var(--border-default); border-radius:var(--radius-sm); color:var(--text-muted);
  background:var(--bg-elevated); cursor:pointer; transition:all var(--t-fast) var(--ease);
}
.icon-action:hover{ border-color:var(--accent); color:var(--accent); }
.cache-refresh-btn{
  margin-top:var(--space-4); border:1px solid var(--border-strong); background:var(--bg-surface);
  border-radius:var(--radius-sm); padding:9px 14px; cursor:pointer; display:inline-flex; align-items:center;
  gap:8px; color:var(--text-primary); font:700 13px inherit; box-shadow:var(--shadow-xs);
  transition:all var(--t-fast) var(--ease);
}
.cache-refresh-btn:hover:not(:disabled){ border-color:var(--accent); color:var(--accent-strong); background:var(--accent-soft); }
.cache-refresh-btn:disabled{ cursor:not-allowed; opacity:.6; }
.reset-link{ font:700 12px inherit; color:var(--accent-strong); background:none; border:none; cursor:pointer; }

/* ======================= ALERTS ======================= */
.alert{
  display:flex; align-items:flex-start; gap:10px; margin-top:var(--space-4);
  border:1px solid var(--border-default); border-radius:var(--radius-md);
  padding:10px 13px; font-size:12.5px; line-height:1.5; background:var(--bg-surface);
}
.alert-icon{ flex:none; margin-top:1px; }
.alert-body{ min-width:0; }
.alert-title{ font-weight:750; }
.alert-detail{ margin-top:3px; font-size:11.5px; opacity:.9; }
.alert.warning{ background:var(--warning-soft); border-color:var(--warning-border); color:var(--warning); }
.alert.error{ background:var(--negative-soft); border-color:var(--negative-border); color:#8E2530; }
.alert.info{ background:var(--info-soft); border-color:var(--info-border); color:var(--info); }
.alert.success{ background:var(--positive-soft); border-color:var(--positive-border); color:var(--positive); }
/* Legacy alert class names used across the reports. */
.error-banner{
  display:flex; align-items:flex-start; gap:9px; margin-top:var(--space-4);
  background:var(--negative-soft); border:1px solid var(--negative-border); color:#8E2530;
  border-radius:var(--radius-md); padding:10px 13px; font-size:12.5px; line-height:1.5;
}
.error-banner svg{ flex:none; margin-top:1px; }
.recon-notice{
  display:flex; align-items:flex-start; gap:9px; margin-top:var(--space-3); padding:10px 13px;
  border:1px solid var(--info-border); border-radius:var(--radius-md); background:var(--info-soft);
  color:var(--info); font-size:12px; line-height:1.5;
}
.recon-notice svg{ flex:none; margin-top:1px; }
.access-notice{
  margin-top:var(--space-4); padding:10px 13px; border:1px solid var(--positive-border);
  border-radius:var(--radius-md); background:var(--positive-soft); color:var(--positive);
  font-size:12px; font-weight:700;
}

/* ======================= PANELS ======================= */
.panel{
  background:var(--bg-surface); border:1px solid var(--border-default); border-radius:var(--radius-lg);
  padding:16px 18px; margin-top:var(--space-4); box-shadow:var(--shadow-sm);
}
.panel-head{ display:flex; justify-content:space-between; align-items:flex-start; gap:var(--space-3); margin-bottom:var(--space-2); flex-wrap:wrap; }
.panel-title{ font-size:14px; font-weight:800; letter-spacing:0; color:var(--text-primary); display:flex; align-items:center; gap:7px; }
.panel-flush{ padding:0; overflow:hidden; }
.footer-note{ margin-top:var(--space-5); font-size:11px; color:var(--text-secondary); line-height:1.65; padding:var(--space-4) 2px var(--space-2); border-top:1px solid var(--border-default); }
.footer-note code{ font-family:'Outfit',sans-serif; font-size:10.5px; background:var(--bg-sunken); padding:1px 5px; border-radius:5px; color:var(--text-secondary); }
.footer-note strong{ color:var(--text-secondary); }
.empty-note{ font-size:12.5px; color:var(--text-secondary); padding:var(--space-3) 0; }
.disclosure{ margin-top:var(--space-4); font-size:12px; color:var(--text-secondary); background:var(--bg-surface); border:1px solid var(--border-default); border-radius:var(--radius-md); padding:12px 16px; }
.disclosure summary{ cursor:pointer; font-weight:700; color:var(--text-primary); }
.native-row{ display:flex; justify-content:space-between; padding:5px 0; border-bottom:1px dashed var(--border-default); font-size:12.5px; }
.native-row:last-child{ border-bottom:none; }
.badge-count{ font-size:11px; font-weight:700; color:var(--accent-strong); background:var(--accent-soft); padding:3px 9px; border-radius:var(--radius-pill); }

/* ======================= METRIC CARDS (level 2) ======================= */
.metric-grid{ display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:var(--space-3); margin-top:var(--space-4); }
.metric-card{
  position:relative; background:var(--bg-elevated); border:1px solid var(--border-default);
  border-radius:var(--radius-md); padding:14px 16px 13px; box-shadow:var(--shadow-sm);
  transition:transform var(--t) var(--ease), box-shadow var(--t) var(--ease), border-color var(--t) var(--ease);
  min-width:0;
}
.metric-card:hover{ transform:translateY(-2px); box-shadow:var(--shadow-md); border-color:var(--border-hover); }
.metric-top{ display:flex; align-items:center; justify-content:space-between; gap:8px; }
.metric-label{ font-size:10px; font-weight:800; text-transform:uppercase; letter-spacing:.08em; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.metric-hint{ display:inline-grid; place-items:center; color:var(--text-muted); opacity:.55; cursor:help; flex-shrink:0; }
.metric-hint:hover,.metric-hint:focus-visible{ opacity:1; }
.metric-value{
  font-family:'Outfit',sans-serif; font-variant-numeric:tabular-nums;
  font-size:26px; font-weight:700; letter-spacing:0; color:var(--text-primary);
  margin-top:9px; line-height:1.1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.metric-foot{ display:flex; align-items:center; gap:8px; margin-top:9px; flex-wrap:wrap; min-height:18px; }
.metric-period{ font-size:11px; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.metric-spark{ margin-top:10px; height:26px; }
.metric-spark svg{ display:block; width:100%; height:100%; overflow:visible; }

/* Trend indicator: icon + sign + value, never colour alone. */
.trend{
  display:inline-flex; align-items:center; gap:4px; font-family:'Outfit',sans-serif;
  font-variant-numeric:tabular-nums; font-size:11.5px; font-weight:700; padding:2px 7px 2px 5px;
  border-radius:var(--radius-pill); border:1px solid transparent; white-space:nowrap;
}
.trend.up{ color:var(--positive); background:var(--positive-soft); border-color:var(--positive-border); }
.trend.down{ color:var(--negative); background:var(--negative-soft); border-color:var(--negative-border); }
.trend.flat{ color:var(--text-secondary); background:var(--bg-sunken); border-color:var(--border-default); }
.up{ color:var(--positive); } .down{ color:var(--negative); } .flat{ color:var(--text-secondary); }

/* ---- Performance comparison row ---- */
.cmp-grid{ display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:var(--space-3); margin-top:var(--space-3); }
.cmp-card{
  background:var(--bg-surface); border:1px solid var(--border-default); border-radius:var(--radius-md);
  padding:12px 14px; box-shadow:var(--shadow-xs); min-width:0;
  transition:border-color var(--t) var(--ease), box-shadow var(--t) var(--ease);
}
.cmp-card:hover{ border-color:var(--border-hover); box-shadow:var(--shadow-sm); }
.cmp-label{ font-size:10px; font-weight:800; text-transform:uppercase; letter-spacing:.07em; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.cmp-value{ display:flex; align-items:center; gap:7px; margin-top:7px; font-family:'Outfit',sans-serif; font-variant-numeric:tabular-nums; font-size:17px; font-weight:700; letter-spacing:0; }
.cmp-value svg{ flex-shrink:0; }
.cmp-basis{ font-size:10.5px; color:var(--text-muted); margin-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

/* auto-fit so a report with four stats does not leave a hole in a five-up grid */
.plan-stat-row{ display:grid; grid-template-columns:repeat(auto-fit,minmax(152px,1fr)); gap:var(--space-3); margin-top:var(--space-4); }
.plan-stat{
  background:var(--bg-elevated); border:1px solid var(--border-default); border-radius:var(--radius-md);
  padding:12px 14px; box-shadow:var(--shadow-xs); min-width:0;
  transition:transform var(--t) var(--ease), box-shadow var(--t) var(--ease), border-color var(--t) var(--ease);
}
.plan-stat:hover{ transform:translateY(-2px); box-shadow:var(--shadow-md); border-color:var(--border-hover); }
.plan-stat-label{ font-size:9.5px; font-weight:800; text-transform:uppercase; letter-spacing:.08em; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.plan-stat-value{ font-size:19px; font-weight:700; margin-top:6px; letter-spacing:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.recon-kpis{ display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:var(--space-3); margin-top:var(--space-4); }
.recon-kpi{
  border:1px solid var(--border-default); border-radius:var(--radius-md); padding:12px 14px;
  background:var(--bg-elevated); min-height:88px; box-shadow:var(--shadow-xs); min-width:0;
  transition:transform var(--t) var(--ease), box-shadow var(--t) var(--ease), border-color var(--t) var(--ease);
}
.recon-kpi:hover{ transform:translateY(-2px); box-shadow:var(--shadow-md); border-color:var(--border-hover); }
.recon-kpi-label{ color:var(--text-muted); font-size:9.5px; font-weight:800; text-transform:uppercase; letter-spacing:.08em; }
.recon-kpi-value{ color:var(--text-primary); font-size:17px; font-weight:700; margin-top:7px; letter-spacing:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.recon-kpi-note{ color:var(--text-muted); font-size:10.5px; margin-top:5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.skupl-kpis{ display:grid; grid-template-columns:repeat(7,minmax(0,1fr)); gap:10px; margin-top:var(--space-4); }
.skupl-kpi{
  background:var(--bg-elevated); border:1px solid var(--border-default); border-radius:var(--radius-md);
  padding:11px 12px; box-shadow:var(--shadow-xs); min-width:0;
  transition:transform var(--t) var(--ease), box-shadow var(--t) var(--ease), border-color var(--t) var(--ease);
}
.skupl-kpi:hover{ transform:translateY(-2px); box-shadow:var(--shadow-md); border-color:var(--border-hover); }
.skupl-kpi-label{ font-size:9.5px; font-weight:800; text-transform:uppercase; letter-spacing:.07em; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.skupl-kpi-value{ font-size:16px; font-weight:700; margin-top:6px; letter-spacing:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.sku-neg{ color:var(--negative); } .sku-pos{ color:var(--positive); } .sku-warn{ color:var(--warning); }

/* ======================= CHART CARD ======================= */
.chart-card{
  background:var(--bg-surface); border:1px solid var(--border-default); border-radius:var(--radius-lg);
  box-shadow:var(--shadow-sm); margin-top:var(--space-4); overflow:hidden;
}
.chart-card-head{
  display:flex; align-items:flex-start; justify-content:space-between; gap:var(--space-3);
  padding:15px 18px 12px; flex-wrap:wrap; border-bottom:1px solid var(--border-default);
}
.chart-card-title{ font-size:14px; font-weight:800; letter-spacing:0; }
.chart-card-sub{ font-size:11.5px; color:var(--text-muted); margin-top:3px; }
.chart-card-body{ padding:14px 12px 8px 4px; }
.chart-wrap{ height:320px; }
.chart-wrap.short{ height:250px; }
.recharts-cartesian-axis-tick-value{ font-size:10.5px; }
.recharts-surface{ overflow:visible; }
.chart-tip{
  background:var(--bg-elevated); border:1px solid var(--border-strong); border-radius:10px;
  box-shadow:var(--shadow-lg); padding:9px 11px; min-width:132px;
}
.chart-tip-label{ font-size:11px; font-weight:800; color:var(--text-primary); letter-spacing:0; }
.chart-tip-rows{ margin-top:6px; display:flex; flex-direction:column; gap:4px; }
.chart-tip-row{ display:flex; align-items:center; justify-content:space-between; gap:14px; font-size:11.5px; color:var(--text-secondary); }
.chart-tip-row b{ font-family:'Outfit',sans-serif; font-variant-numeric:tabular-nums; color:var(--text-primary); font-weight:700; }
.chart-tip-key{ display:inline-flex; align-items:center; gap:6px; }
.chart-tip-swatch{ width:7px; height:7px; border-radius:2px; flex-shrink:0; }
.recon-chart-grid{ display:grid; grid-template-columns:1fr 1fr; gap:var(--space-3); margin-top:var(--space-4); }
.recon-chart-panel{ min-height:264px; }
.recon-chart-wrap{ height:200px; }
.recon-donut-wrap{ height:200px; display:flex; align-items:center; }
.recon-donut-legend{ display:flex; flex-direction:column; gap:8px; width:42%; font-size:11.5px; color:var(--text-secondary); }
.recon-donut-legend div{ display:grid; grid-template-columns:9px 1fr auto; align-items:center; gap:7px; }
.recon-donut-legend span{ width:8px; height:8px; border-radius:2px; }
.recon-donut-legend strong{ color:var(--text-primary); font-family:'Outfit',sans-serif; font-variant-numeric:tabular-nums; }
.recon-overlay-wrap{ height:280px; }

/* ======================= BREAKDOWN CARDS ======================= */
.breakdown-grid{ display:grid; grid-template-columns:1fr 1fr; gap:var(--space-3); margin-top:var(--space-3); }
.bd-list{ display:flex; flex-direction:column; margin-top:var(--space-2); max-height:352px; overflow-y:auto; }
.bd-row{
  display:grid; grid-template-columns:minmax(0,1fr) 92px; align-items:center;
  gap:var(--space-3) var(--space-3); padding:9px 8px; border-radius:var(--radius-sm);
  transition:background var(--t-fast) var(--ease);
}
.bd-row:hover{ background:var(--bg-subtle); }
.bd-main{ min-width:0; }
.bd-name{ display:flex; align-items:center; gap:6px; font-size:12.5px; font-weight:700; color:var(--text-primary); min-width:0; }
.bd-name span{ overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.bd-row.muted .bd-name{ color:var(--text-muted); font-weight:650; }
.bd-row.active .bd-name{ color:var(--accent-strong); }
.bd-bar{ height:6px; background:var(--bg-sunken); border-radius:var(--radius-pill); overflow:hidden; margin-top:7px; }
.bd-fill{ height:100%; border-radius:var(--radius-pill); background:var(--chart-neutral); transition:width var(--t-slow) var(--ease); }
.bd-row.active .bd-fill{ background:var(--accent); }
.bd-row.muted .bd-fill{ background:var(--border-strong); }
.bd-figures{ text-align:right; min-width:0; }
.bd-value{ font-family:'Outfit',sans-serif; font-variant-numeric:tabular-nums; font-size:12.5px; font-weight:700; color:var(--text-primary); white-space:nowrap; }
.bd-share{ font-family:'Outfit',sans-serif; font-variant-numeric:tabular-nums; font-size:10.5px; color:var(--text-muted); margin-top:3px; white-space:nowrap; }

/* ======================= STATUS BADGES ======================= */
.status-badge, .pt-badge{
  display:inline-flex; align-items:center; gap:5px; font-size:10.5px; font-weight:750;
  padding:3px 9px; border-radius:var(--radius-pill); border:1px solid transparent;
  white-space:nowrap; line-height:1.35;
}
.status-badge.neutral, .pt-badge.neutral{ background:var(--bg-sunken); color:var(--text-secondary); border-color:var(--border-default); }
.status-badge.good, .pt-badge-ok, .pt-badge.sku-badge-ok{ background:var(--positive-soft); color:var(--positive); border-color:var(--positive-border); }
.status-badge.warn, .pt-badge-restock, .pt-badge.sku-badge-warn{ background:var(--warning-soft); color:var(--warning); border-color:var(--warning-border); }
.status-badge.bad, .pt-badge.sku-badge-bad{ background:var(--negative-soft); color:var(--negative); border-color:var(--negative-border); }
.status-badge.info{ background:var(--info-soft); color:var(--info); border-color:var(--info-border); }
.status-badge.accent{ background:var(--accent-soft); color:var(--accent-strong); border-color:var(--accent-border); }
.pt-badge.sku-badge-neutral{ background:var(--bg-sunken); color:var(--text-secondary); border-color:var(--border-default); }
.pt-badge.driver-traffic{ background:var(--info-soft); color:var(--info); border-color:var(--info-border); }
.pt-badge.driver-conversion{ background:#F1EDFE; color:#5B3E9B; border-color:#DCD3FB; }
.pt-badge.driver-price{ background:var(--warning-soft); color:var(--warning); border-color:var(--warning-border); }

/* ======================= SKELETON / EMPTY / ERROR ======================= */
.skeleton{
  background:linear-gradient(90deg,var(--bg-sunken) 0%,#E6EAF2 50%,var(--bg-sunken) 100%);
  background-size:200% 100%; border-radius:6px; animation:sk 1.6s var(--ease) infinite;
}
@keyframes sk{ 0%{background-position:120% 0;} 100%{background-position:-20% 0;} }
.sk-line{ height:11px; }
.sk-card{
  background:var(--bg-elevated); border:1px solid var(--border-default); border-radius:var(--radius-md);
  padding:14px 16px; box-shadow:var(--shadow-xs);
}
.sk-chart{ padding:14px 18px 18px; }
.sk-bars{ display:flex; align-items:flex-end; gap:8px; height:220px; margin-top:14px; }
.sk-bars > i{ flex:1; display:block; border-radius:5px 5px 0 0; }
.sk-rows{ display:flex; flex-direction:column; gap:10px; }
.sk-row{ display:grid; grid-template-columns:minmax(0,1.6fr) repeat(4,minmax(0,1fr)); gap:14px; align-items:center; }

.state-block{
  display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px;
  text-align:center; padding:34px 22px; min-height:170px; color:var(--text-secondary);
}
.state-icon{
  display:grid; place-items:center; width:40px; height:40px; border-radius:11px;
  background:var(--bg-sunken); color:var(--text-muted); border:1px solid var(--border-default);
}
.state-block.error .state-icon{ background:var(--negative-soft); color:var(--negative); border-color:var(--negative-border); }
.state-block.warn .state-icon{ background:var(--warning-soft); color:var(--warning); border-color:var(--warning-border); }
.state-title{ font-size:13.5px; font-weight:800; color:var(--text-primary); }
.state-body{ font-size:12px; line-height:1.6; max-width:520px; color:var(--text-secondary); }
.state-actions{ display:flex; gap:8px; flex-wrap:wrap; justify-content:center; margin-top:2px; }
.recon-empty{ min-height:190px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; color:var(--text-secondary); margin-top:var(--space-4); text-align:center; }
.loading-screen{
  display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:100vh;
  font-family:'Plus Jakarta Sans',sans-serif; color:var(--text-secondary); text-align:center; padding:24px; gap:4px;
}
.loading-screen strong{ color:var(--text-primary); font-size:15px; }

/* ======================= FRESHNESS STRIP ======================= */
.recon-freshness, .plan-freshness{
  display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-top:var(--space-4);
  font-size:11.5px; color:var(--text-muted); background:var(--bg-surface);
  border:1px solid var(--border-default); border-radius:var(--radius-sm); padding:8px 12px;
}
.recon-freshness strong, .plan-freshness strong{ color:var(--text-primary); font-weight:750; }
.plan-fresh-sep{ color:var(--border-strong); }

/* ======================= DATA TABLES ======================= */
.plan-controls{ display:flex; gap:var(--space-3); align-items:flex-end; flex-wrap:wrap; margin-top:var(--space-4); }
.plan-scroll, .recon-table-scroll, .daily-scroll{
  overflow-x:auto; overflow-y:visible; -webkit-overflow-scrolling:touch; max-width:100%;
}
.plan-scroll::-webkit-scrollbar, .recon-table-scroll::-webkit-scrollbar, .daily-scroll::-webkit-scrollbar{ height:10px; }
.plan-scroll::-webkit-scrollbar-thumb, .recon-table-scroll::-webkit-scrollbar-thumb, .daily-scroll::-webkit-scrollbar-thumb{ background:var(--border-strong); border-radius:var(--radius-pill); border:3px solid var(--bg-surface); }

.plan-table, .recon-table, .recon-daily-table, .daily-table{
  border-collapse:separate; border-spacing:0; width:100%; font-size:12px;
}
.plan-table{ min-width:1080px; }
.plan-table th, .plan-table td,
.recon-table th, .recon-table td,
.recon-daily-table th, .recon-daily-table td{
  padding:8px 11px; text-align:right; white-space:nowrap; border-bottom:1px solid var(--border-default);
}
.plan-table td, .recon-table td, .recon-daily-table td{ font-variant-numeric:tabular-nums; }
.plan-table thead th, .recon-table thead th, .recon-daily-table thead th{
  font-size:10px; font-weight:800; color:var(--text-muted); text-transform:uppercase;
  letter-spacing:.07em; background:var(--bg-subtle); position:sticky; top:0; z-index:2;
  border-bottom:1px solid var(--border-strong);
}
.plan-table th.pt-left, .plan-table td.pt-left,
.recon-table th.recon-left, .recon-table td:first-child,
.recon-daily-table th:first-child, .recon-daily-table td:first-child{ text-align:left; }
.plan-table .pt-sortable, .recon-table th{ cursor:pointer; user-select:none; transition:color var(--t-fast) var(--ease); }
.plan-table .pt-sortable:hover, .recon-table th:hover{ color:var(--text-primary); }
.plan-table th.pt-sorted{ color:var(--accent-strong); }
.pt-th-inner, .recon-table th span{ display:inline-flex; align-items:center; gap:4px; }
.pt-th-inner .pt-th-idle{ opacity:.35; }
/* Sticky identity column. */
.plan-table th.pt-id, .plan-table td.pt-id{
  text-align:left; position:sticky; left:0; background:var(--bg-surface); z-index:1;
  min-width:230px; max-width:300px; border-right:1px solid var(--border-default);
}
.plan-table thead th.pt-id{ z-index:3; background:var(--bg-subtle); }
.pt-name{ font-weight:750; color:var(--text-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:280px; }
.pt-meta{ font-size:10.5px; color:var(--text-muted); margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:280px; }
.pt-brand{ font-size:10.5px; color:var(--accent-strong); font-weight:700; margin-top:2px; overflow:hidden; text-overflow:ellipsis; max-width:280px; }
.plan-table td.pt-strong{ font-weight:750; color:var(--text-primary); }
.plan-table tbody tr{ transition:background var(--t-fast) var(--ease); }
.plan-table tbody tr:hover td{ background:var(--bg-subtle); }
.plan-table tbody tr:hover td.pt-id{ background:#F1F4FA; }
.plan-table tr.plan-restock td{ background:var(--warning-soft); }
.plan-table tr.plan-restock td.pt-id{ background:#FCEFD8; box-shadow:inset 3px 0 0 var(--brand); }
.plan-table tr.plan-restock:hover td{ background:#FBEBCC; }
.plan-table tfoot td{ position:sticky; bottom:0; background:var(--bg-sunken); font-weight:750; border-top:1px solid var(--border-strong); border-bottom:none; z-index:1; }
.plan-table tfoot td.pt-id{ background:var(--bg-sunken); z-index:2; }
.skupl-table tr.skupl-row-loss td{ background:var(--negative-soft); }
.skupl-table tr.skupl-row-loss td.pt-id{ background:#FBE1E3; box-shadow:inset 3px 0 0 var(--negative); }
.skupl-table tr.skupl-row-loss:hover td{ background:#FBE1E3; }
.skupl-cogs-cell{ white-space:nowrap; }
.skupl-cogs-cell .icon-action{ margin-left:5px; vertical-align:middle; }
.skupl-toolbar{ display:flex; align-items:flex-end; gap:var(--space-3); flex-wrap:wrap; padding:13px 16px; border-bottom:1px solid var(--border-default); background:var(--bg-surface); }
.skupl-search{ flex:1; min-width:190px; }
.skupl-toolbar-spacer{ flex:1; }
.recon-filters{ display:flex; flex-wrap:wrap; align-items:flex-end; gap:10px; margin:0 0 var(--space-4); }
.recon-search{ flex:1; min-width:220px; }
.recon-select{ min-width:118px; }
.recon-month-picker{
  display:flex; align-items:center; gap:8px; border:1px solid var(--border-default);
  background:var(--bg-elevated); border-radius:var(--radius-sm); padding:6px 10px; box-shadow:var(--shadow-xs); flex-wrap:wrap;
}
.recon-month-picker label{ font-size:9.5px; font-weight:800; color:var(--text-muted); text-transform:uppercase; letter-spacing:.08em; }
.recon-month-picker select{ border:0; outline:0; background:transparent; color:var(--text-primary); font:750 12.5px inherit; cursor:pointer; }
.recon-daily-table, .recon-table{ min-width:760px; }
.recon-table{ min-width:1720px; }
.recon-table tbody tr:hover td{ background:var(--bg-subtle); }
.recon-row-pending td:first-child{ box-shadow:inset 3px 0 var(--brand); }
.recon-row-cancelled td:first-child{ box-shadow:inset 3px 0 var(--negative); }
.recon-row-refunded td:first-child,.recon-row-settled-refunded td:first-child{ box-shadow:inset 3px 0 var(--info); }
.recon-row-settled td:first-child{ box-shadow:inset 3px 0 var(--positive); }
.recon-order-id button{ display:inline-flex; align-items:center; gap:5px; border:0; padding:0; background:transparent; color:var(--accent); cursor:pointer; font:600 11px 'Outfit',sans-serif; }
.recon-order-id button:hover{ text-decoration:underline; }
.recon-badge, .recon-cross-badge{ display:inline-block; border-radius:var(--radius-pill); padding:3px 8px; font-size:10px; font-weight:750; border:1px solid transparent; }
.recon-badge.settled{ background:var(--positive-soft); color:var(--positive); border-color:var(--positive-border); }
.recon-badge.pending{ background:var(--warning-soft); color:var(--warning); border-color:var(--warning-border); }
.recon-badge.cancelled{ background:var(--negative-soft); color:var(--negative); border-color:var(--negative-border); }
.recon-badge.refunded,.recon-badge.settled-refunded{ background:var(--info-soft); color:var(--info); border-color:var(--info-border); }
.recon-cross-badge{ border-color:var(--warning-border); color:var(--warning); background:var(--warning-soft); }
.recon-waterfall{ display:flex; flex-direction:column; gap:8px; }
.recon-waterfall-row{ display:grid; grid-template-columns:130px minmax(90px,1fr) 130px; gap:10px; align-items:center; font-size:11.5px; }
.recon-waterfall-row > span{ color:var(--text-secondary); }
.recon-waterfall-row > strong{ font-family:'Outfit',sans-serif; font-variant-numeric:tabular-nums; text-align:right; font-size:11.5px; }
.recon-waterfall-track{ height:8px; border-radius:var(--radius-pill); overflow:hidden; background:var(--bg-sunken); }
.recon-waterfall-fill{ height:100%; min-width:2px; border-radius:var(--radius-pill); }
.recon-waterfall-fill.positive{ background:var(--positive); }
.recon-waterfall-fill.negative{ background:var(--negative); }
.recon-waterfall-fill.net{ background:var(--accent); }
.recon-overlay-panel,.recon-waterfall-panel,.recon-daily-panel,.recon-explorer-panel{ margin-top:var(--space-4); }
.reconciliation-page{ padding-bottom:var(--space-6); }
.content-alerts-table{ min-width:1180px; }
.content-alerts-table th:first-child,.content-alerts-table td:first-child{ text-align:left; }
.content-preview{ display:block; max-width:360px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text-muted); }

/* Pagination */
.recon-pagination{ display:flex; justify-content:flex-end; align-items:center; gap:5px; flex-wrap:wrap; padding:var(--space-3) var(--space-4); border-top:1px solid var(--border-default); }
.recon-pagination button{
  min-width:30px; border:1px solid var(--border-default); border-radius:var(--radius-sm); padding:5px 9px;
  color:var(--text-secondary); background:var(--bg-elevated); font:700 11.5px inherit; cursor:pointer;
  transition:all var(--t-fast) var(--ease);
}
.recon-pagination button:hover:not(:disabled):not(.active){ border-color:var(--border-hover); color:var(--text-primary); }
.recon-pagination button.active{ border-color:var(--accent-border); background:var(--accent-soft); color:var(--accent-strong); }
.recon-pagination button:disabled{ opacity:.45; cursor:not-allowed; }

/* Daily Reporting matrix */
.daily-table{ min-width:760px; font-size:12px; }
.daily-table th, .daily-table td{ padding:8px 12px; text-align:right; white-space:nowrap; border-bottom:1px solid var(--border-default); font-variant-numeric:tabular-nums; }
.daily-table thead th{ font-size:10px; font-weight:800; color:var(--text-muted); text-transform:uppercase; letter-spacing:.07em; background:var(--bg-subtle); border-bottom:1px solid var(--border-strong); position:sticky; top:0; z-index:2; }
.daily-table th.dt-metric, .daily-table td.dt-metric{ text-align:left; font-weight:750; position:sticky; left:0; background:var(--bg-surface); z-index:1; border-right:1px solid var(--border-default); }
.daily-table thead th.dt-metric{ z-index:3; background:var(--bg-subtle); }
.daily-table td.dt-metric{ color:var(--text-primary); }
.daily-table th.dt-month, .daily-table td.dt-month{ background:var(--bg-subtle); }
.daily-table th.dt-mtd, .daily-table td.dt-mtd{ background:var(--brand-soft); color:var(--brand-deep); font-weight:750; border-left:1px solid var(--warning-border); border-right:1px solid var(--warning-border); }
.daily-table tbody tr:hover td:not(.dt-mtd){ background:var(--bg-subtle); }
.daily-table tr.dt-row-highlight td{ background:var(--accent-soft); font-weight:750; }
.daily-table tr.dt-row-highlight td.dt-mtd{ background:#F7E9D2; }
.daily-table tr.dt-row-highlight td.dt-metric{ background:var(--accent-soft); }

/* ===================== DAILY REPORTING (.dr-page) =====================
   Flat Amazon operational system (approved Stitch redesign). White cards on a neutral
   workspace, #D5D9D9 hairlines, <=6px radii, semantic accents (blue #146EB4, orange
   #FF9900, green #067D62, red #B12704), tabular numerals -- no gradients, no violet
   theme. Every selector is DR-exclusive under .dr-page; the SHARED .obs-units / .dr-dash
   rules further down are deliberately left untouched for the other reports. */
.dr-page{ padding-bottom:var(--space-5); color:#0F1111; }

/* Consolidated data-status panel (provisional=amber / final=green / source issue=red /
   advertising coverage=info). The error tone stays the most prominent. */
.dr-page .dr-status{ margin-top:var(--space-4); background:#FFFFFF; border:1px solid #D5D9D9; border-radius:6px; overflow:hidden; }
.dr-page .dr-status-row{ display:flex; align-items:flex-start; gap:10px; padding:12px 14px; border-left:4px solid transparent; }
.dr-page .dr-status--warning .dr-status-row{ background:#FFF8E7; border-left-color:#B75D00; }
.dr-page .dr-status--final .dr-status-row{ background:#F3F9F6; border-left-color:#067D62; }
.dr-page .dr-status--error .dr-status-row{ background:#FDF4F4; border-left-color:#B12704; }
.dr-page .dr-status--info .dr-status-row{ background:#EFF6FB; border-left-color:#146EB4; }
.dr-page .dr-status-icon{ flex-shrink:0; margin-top:1px; display:inline-flex; }
.dr-page .dr-status--warning .dr-status-icon{ color:#B75D00; }
.dr-page .dr-status--final .dr-status-icon{ color:#067D62; }
.dr-page .dr-status--error .dr-status-icon{ color:#B12704; }
.dr-page .dr-status--info .dr-status-icon{ color:#146EB4; }
.dr-page .dr-status-main{ min-width:0; flex:1; }
.dr-page .dr-status-line{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.dr-page .dr-status-badge{ font-size:10.5px; font-weight:750; letter-spacing:.04em; text-transform:uppercase; padding:2px 7px; border-radius:3px; }
.dr-page .dr-status-badge--provisional{ background:#FFEBB7; color:#944D00; }
.dr-page .dr-status-badge--final{ background:#DBF0E8; color:#067D62; }
.dr-page .dr-status-badge--defect{ background:#F8D7DA; color:#B12704; }
.dr-page .dr-status-title{ font-size:12.5px; font-weight:700; color:#0F1111; }
.dr-page .dr-status-detail{ font-size:12px; color:#565959; line-height:1.55; margin-top:3px; }
.dr-page .dr-status-toggle{ flex-shrink:0; display:inline-flex; align-items:center; gap:5px; background:none; border:none; padding:2px 0; cursor:pointer; color:#146EB4; font-size:12px; font-weight:600; white-space:nowrap; }
.dr-page .dr-status-toggle:hover{ color:#0C4A7A; }
.dr-page .dr-status-toggle:focus-visible{ outline:2px solid #146EB4; outline-offset:2px; border-radius:3px; }
.dr-page .dr-status-chevron{ transition:transform .15s ease; }
.dr-page .dr-status-chevron.is-open{ transform:rotate(180deg); }

/* Observed Units Breakdown -- five compact cells (DR-scoped; distinct from the shared .obs-units below). */
.dr-page .dr-obs{ padding:12px 14px; border-top:1px solid #F2C265; background:#FFFFFF; }
.dr-page .dr-status--final .dr-obs{ border-top-color:#CDE5D8; }
.dr-page .dr-status--info .dr-obs{ border-top-color:#D2E4F2; }
.dr-page .dr-obs-head{ display:flex; align-items:baseline; justify-content:space-between; gap:10px; flex-wrap:wrap; padding-bottom:10px; border-bottom:1px solid #E7E9EC; }
.dr-page .dr-obs-title{ font-size:12.5px; font-weight:750; color:#0F1111; }
.dr-page .dr-obs-total{ font-size:11.5px; color:#565959; }
.dr-page .dr-obs-total strong{ color:#0F1111; font-weight:700; font-variant-numeric:tabular-nums; }
.dr-page .dr-obs-grid{ display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:10px; margin-top:12px; }
.dr-page .dr-obs-cell{ padding:9px 10px; border:1px solid #D5D9D9; border-radius:4px; background:#F8F9FA; min-width:0; }
.dr-page .dr-obs-cell--pos{ background:#F3F9F6; border-color:#CDE5D8; }
.dr-page .dr-obs-cell--warn{ background:#FFF8E7; border-color:#F2C265; }
.dr-page .dr-obs-cell--neg{ background:#FDF4F4; border-color:#F5C2C7; }
.dr-page .dr-obs-cell-label{ font-size:11px; font-weight:600; color:#565959; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dr-page .dr-obs-cell--pos .dr-obs-cell-label{ color:#067D62; }
.dr-page .dr-obs-cell--warn .dr-obs-cell-label{ color:#944D00; }
.dr-page .dr-obs-cell--neg .dr-obs-cell-label{ color:#B12704; }
.dr-page .dr-obs-cell-value{ font-size:15px; font-weight:800; color:#0F1111; font-variant-numeric:tabular-nums; margin-top:2px; }
.dr-page .dr-obs-cell--pos .dr-obs-cell-value{ color:#067D62; }
.dr-page .dr-obs-cell--warn .dr-obs-cell-value{ color:#B75D00; }
.dr-page .dr-obs-cell--neg .dr-obs-cell-value{ color:#B12704; }
.dr-page .dr-obs-cell-sub{ font-size:10.5px; color:#565959; margin-top:2px; }
.dr-page .dr-obs-cell--pos .dr-obs-cell-sub{ color:#067D62; }
.dr-page .dr-obs-cell--warn .dr-obs-cell-sub{ color:#944D00; }
.dr-page .dr-obs-cell--neg .dr-obs-cell-sub{ color:#B12704; }
.dr-page .dr-obs-note{ font-size:11.5px; line-height:1.55; color:#565959; margin-top:12px; }

/* Six MTD KPI cards -- white, hairline border, 2px semantic top accent (no gradients). */
.dr-page .dr-kpis{ display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:12px; margin-top:var(--space-4); }
.dr-page .dr-kpi{ background:#FFFFFF; border:1px solid #D5D9D9; border-top:2px solid #D5D9D9; border-radius:6px; padding:12px 14px; min-width:0; display:flex; flex-direction:column; justify-content:space-between; }
.dr-page .dr-kpi--blue{ border-top-color:#146EB4; }
.dr-page .dr-kpi--orange{ border-top-color:#FF9900; }
.dr-page .dr-kpi--green{ border-top-color:#067D62; }
.dr-page .dr-kpi-label{ font-size:10.5px; font-weight:800; letter-spacing:.06em; text-transform:uppercase; color:#565959; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dr-page .dr-kpi-value{ font-size:21px; font-weight:800; line-height:1.15; color:#0F1111; font-variant-numeric:tabular-nums; margin-top:5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dr-page .dr-kpi-value--roi{ color:#067D62; }
.dr-page .dr-kpi-foot{ display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:10px; padding-top:8px; border-top:1px solid #F0F2F2; font-size:11px; }
.dr-page .dr-kpi-cap{ color:#565959; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dr-page .dr-kpi-subval{ color:#565959; font-weight:600; font-variant-numeric:tabular-nums; white-space:nowrap; }

/* Main reporting matrix card + head (flat, no gradient). */
.dr-page .dr-card{ margin-top:var(--space-5); background:#FFFFFF; border:1px solid #D5D9D9; border-radius:6px; overflow:hidden; }
.dr-page .dr-card-head{ display:flex; align-items:flex-start; justify-content:space-between; gap:12px; padding:14px 16px; border-bottom:1px solid #D5D9D9; background:#FFFFFF; }
.dr-page .dr-card-head-main{ min-width:0; }
.dr-page .dr-card-titlerow{ display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.dr-page .dr-card-title{ font-size:16px; font-weight:800; color:#0F1111; letter-spacing:0; margin:0; }
.dr-page .dr-card-badge{ font-size:11px; font-weight:600; padding:2px 8px; border-radius:4px; }
.dr-page .dr-card-badge--provisional{ background:#FFF8E7; border:1px solid #F2C265; color:#944D00; }
.dr-page .dr-card-badge--final{ background:#F3F9F6; border:1px solid #CDE5D8; color:#067D62; }
.dr-page .dr-card-badge--defect{ background:#FDF4F4; border:1px solid #F5C2C7; color:#B12704; }
.dr-page .dr-card-meta{ display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-top:5px; font-size:11px; color:#565959; }
.dr-page .dr-card-meta strong{ color:#0F1111; font-weight:600; }
/* Observed-unit breakdown (transparent per-class units beside the completeness line). Responsive: chips wrap, never overflow. */
.obs-units{ margin:8px 0 4px; padding:10px 12px; border:1px solid var(--border-default); border-radius:var(--radius-md,10px); background:var(--bg-elevated); max-width:100%; }
.obs-units-head{ display:flex; align-items:baseline; justify-content:space-between; gap:10px; flex-wrap:wrap; }
.obs-units-title{ font-size:12px; font-weight:800; color:var(--text-primary); letter-spacing:.2px; }
.obs-units-total{ font-size:11px; color:var(--text-muted); }
.obs-units-chips{ display:flex; flex-wrap:wrap; gap:6px; margin:8px 0; }
.obs-chip{ display:inline-flex; align-items:center; gap:5px; padding:3px 9px; border-radius:var(--radius-pill); font-size:10.5px; font-weight:600; white-space:nowrap; }
.obs-chip-v{ font-weight:800; }
.obs-chip-priced{ background:var(--positive-soft); color:var(--positive); }
.obs-chip-zero{ background:var(--bg-subtle,rgba(120,120,140,0.12)); color:var(--text-primary); }
.obs-chip-pending{ background:var(--warning-soft); color:var(--warning); }
.obs-chip-cancelled{ background:var(--negative-soft); color:var(--negative); }
.obs-units-note{ font-size:10.5px; line-height:1.5; color:var(--text-muted); }
.dr-page .dr-refresh{ flex-shrink:0; display:inline-flex; align-items:center; gap:7px; padding:7px 12px; border:1px solid #D5D9D9; border-radius:4px; background:#FFFFFF; color:#0F1111; font-size:12px; font-weight:600; cursor:pointer; }
.dr-page .dr-refresh:hover:not(:disabled){ background:#F7FAFA; border-color:#146EB4; color:#146EB4; }
.dr-page .dr-refresh:focus-visible{ outline:2px solid #146EB4; outline-offset:1px; }
.dr-page .dr-refresh:disabled{ opacity:.6; cursor:default; }
.dr-page .dr-card-body{ padding:8px 12px 12px; }

/* Reporting matrix table -- light neutral sticky header, sticky first column, blue MTD
   emphasis, amber latest-day emphasis, per-metric row bullets, neutral ratio section. */
.dr-page .dr-scroll{ overflow-x:auto; overflow-y:visible; }
.dr-page .dr-scroll::-webkit-scrollbar{ height:8px; }
.dr-page .dr-scroll::-webkit-scrollbar-track{ background:#F3F4F5; }
.dr-page .dr-scroll::-webkit-scrollbar-thumb{ background:#D5D9D9; border-radius:4px; }
.dr-page .dr-table{ width:100%; min-width:1000px; border-collapse:collapse; font-size:12.5px; }
.dr-page .dr-table .dr-th{ padding:11px 14px; text-align:right; white-space:nowrap; font-size:11px; font-weight:800; letter-spacing:.05em; text-transform:uppercase; color:#565959; background:#F8F9FA; border-bottom:1px solid #D5D9D9; position:sticky; top:0; z-index:2; }
.dr-page .dr-table .dr-th-metric{ text-align:left; color:#0F1111; position:sticky; left:0; z-index:3; min-width:180px; border-right:1px solid #E7E9EC; }
.dr-page .dr-table .dr-th-mtd{ color:#146EB4; background:#EFF6FB; border-left:1px solid #D2E4F2; border-right:1px solid #D2E4F2; box-shadow:inset 0 2px 0 #146EB4; }
.dr-page .dr-table .dr-th-latest{ color:#944D00; background:#FFF8E7; border-left:1px solid #F2C265; box-shadow:inset 0 2px 0 #FF9900; }
.dr-page .dr-th-tag{ display:block; font-size:10px; font-weight:600; letter-spacing:.02em; text-transform:uppercase; color:#B75D00; margin-top:1px; }
.dr-page .dr-table tbody tr{ background:#FFFFFF; }
.dr-page .dr-table tbody tr:hover{ background:#F9FAFA; }
.dr-page .dr-table tbody tr.dr-tr-ratio{ background:#FAFAFA; }
.dr-page .dr-table tbody tr.dr-tr-ratio:hover{ background:#F5F6F7; }
.dr-page .dr-table .dr-td{ padding:10px 14px; text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; font-weight:600; color:#0F1111; border-bottom:1px solid #E7E9EC; }
.dr-page .dr-table .dr-td-metric{ text-align:left; font-weight:750; color:#0F1111; position:sticky; left:0; z-index:1; background:#FFFFFF; border-right:1px solid #E7E9EC; }
.dr-page .dr-table tbody tr:hover .dr-td-metric{ background:#F9FAFA; }
.dr-page .dr-table tbody tr.dr-tr-ratio .dr-td-metric{ background:#FAFAFA; }
.dr-page .dr-table tbody tr.dr-tr-ratio:hover .dr-td-metric{ background:#F5F6F7; }
.dr-page .dr-table .dr-td-mtd{ background:#EFF6FB; color:#146EB4; font-weight:700; border-left:1px solid #D2E4F2; border-right:1px solid #D2E4F2; }
.dr-page .dr-table .dr-td-latest{ background:#FFF8E7; color:#0F1111; font-weight:700; border-left:1px solid #F2C265; }
.dr-page .dr-table tbody tr:hover .dr-td-mtd{ background:#E6F0F9; }
.dr-page .dr-table tbody tr:hover .dr-td-latest{ background:#FBF1D9; }
.dr-page .dr-section-row td{ padding:6px 14px; font-size:11px; font-weight:800; letter-spacing:.05em; text-transform:uppercase; color:#565959; background:#F8F9FA; border-top:1px solid #D5D9D9; border-bottom:1px solid #D5D9D9; }
.dr-page .dr-bullet{ display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:9px; vertical-align:middle; flex-shrink:0; }
.dr-page .dr-metric-label{ font-weight:750; color:#0F1111; vertical-align:middle; }
.dr-dash{ color:var(--text-muted); opacity:.55; }

/* Four 5-day trend cards -- white, hairline, restrained per-metric colour. */
.dr-page .dr-trends{ display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; margin-top:var(--space-4); }
.dr-page .dr-trend{ background:#FFFFFF; border:1px solid #D5D9D9; border-radius:6px; padding:13px 15px; min-width:0; }
.dr-page .dr-trend-head{ display:flex; align-items:center; justify-content:space-between; gap:8px; }
.dr-page .dr-trend-label{ font-size:11.5px; font-weight:750; letter-spacing:.03em; text-transform:uppercase; color:#0F1111; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dr-page .dr-trend-range{ font-size:11px; color:#565959; font-variant-numeric:tabular-nums; white-space:nowrap; flex-shrink:0; }
.dr-page .dr-trend-body{ display:flex; align-items:flex-end; justify-content:space-between; gap:10px; margin-top:10px; }
.dr-page .dr-trend-figs{ min-width:0; }
.dr-page .dr-trend-value{ font-size:18px; font-weight:800; font-variant-numeric:tabular-nums; line-height:1.1; white-space:nowrap; }
.dr-page .dr-trend-sub{ font-size:11px; color:#565959; margin-top:3px; }
.dr-page .dr-trend-spark{ width:120px; max-width:52%; flex-shrink:0; }

/* Methodology & metric definitions -- accessible disclosure with a 3-column grid. */
.dr-page .dr-methodology{ margin-top:var(--space-4); }
.dr-page .dr-methodology summary{ font-weight:750; color:#0F1111; }
.dr-page .dr-method-grid{ display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:16px; margin-top:10px; }
.dr-page .dr-method-col{ min-width:0; }
.dr-page .dr-method-h{ font-size:11.5px; font-weight:750; color:#0F1111; margin-bottom:5px; }
.dr-page .dr-method-col p{ font-size:11.5px; line-height:1.6; color:#565959; margin:0; }
.dr-page .dr-method-col ul{ list-style:disc; margin:0; padding-left:16px; }
.dr-page .dr-method-col li{ font-size:11.5px; line-height:1.7; color:#565959; }
.dr-page .dr-method-col strong{ color:#0F1111; font-weight:700; }
.dr-page .dr-method-col code{ font-size:11px; background:#F3F4F5; color:#0F1111; padding:1px 5px; border-radius:4px; }

/* Responsive: KPIs 6->3->2, trends 4->2->1, observed cells wrap; the matrix always scrolls horizontally. */
@media (max-width:1180px){
  .dr-page .dr-kpis{ grid-template-columns:repeat(3,minmax(0,1fr)); }
  .dr-page .dr-trends{ grid-template-columns:repeat(2,minmax(0,1fr)); }
  .dr-page .dr-method-grid{ grid-template-columns:1fr; }
}
@media (max-width:760px){
  .dr-page .dr-obs-grid{ grid-template-columns:repeat(2,minmax(0,1fr)); }
  .dr-page .dr-kpis{ grid-template-columns:repeat(2,minmax(0,1fr)); }
  .dr-page .dr-trends{ grid-template-columns:1fr; }
  .dr-page .dr-trend-spark{ width:96px; }
  .dr-page .dr-kpi-value{ font-size:19px; }
}
@media (prefers-reduced-motion: reduce){
  .dr-page .dr-status-chevron{ transition:none; }
}

/* Report-specific table widths (unchanged behaviour, new palette) */
.keyword-rank-table{ min-width:1280px; }
.keyword-rank-table .keyword-query{ text-align:left; white-space:normal; min-width:190px; max-width:280px; line-height:1.4; }
.keyword-rank-table .keyword-lever{ text-align:left; white-space:normal; min-width:210px; max-width:270px; color:var(--text-secondary); line-height:1.4; }
.keyword-bad{ color:var(--negative); font-weight:700; }
.keyword-good{ color:var(--positive); font-weight:700; }
.movers-table{ min-width:1500px; }
.movers-driver{ text-align:left; }
.movers-unattributed{ color:var(--text-muted); font-size:11px; }
.listing-health-table{ min-width:1320px; }
.listing-health-table .listing-issue{ text-align:left; white-space:normal; min-width:220px; max-width:340px; line-height:1.45; color:var(--text-secondary); font-size:11px; }
.buybox-table{ min-width:1340px; }
.buybox-table .buybox-cause{ white-space:normal; min-width:230px; max-width:320px; }
.buybox-cause-detail{ margin-top:4px; font-size:10.5px; color:var(--text-muted); line-height:1.45; }
.returns-table{ min-width:1460px; }
.returns-reason{ text-align:left; white-space:normal; min-width:200px; max-width:300px; line-height:1.45; }
.ppc-table{ min-width:1420px; }
.ppc-term{ text-align:left; white-space:normal; min-width:200px; max-width:300px; line-height:1.4; }
.optimizer-table{ min-width:1480px; }
.optimizer-note{ text-align:left; white-space:normal; min-width:230px; max-width:330px; line-height:1.45; color:var(--text-secondary); font-size:11px; }

/* ===== Returns & Refund Leakage (v3): advanced window/trend view. Scoped under .rl-* so no other report is touched. ===== */
.rvkpi-grid-6{ grid-template-columns:repeat(6,minmax(0,1fr)); }
.rl-controls{ display:flex; align-items:flex-end; gap:var(--space-3); flex-wrap:wrap; margin-top:var(--space-4); }
.rl-controls .skupl-toolbar-spacer{ flex:1; min-width:12px; }
.rl-prov{ display:flex; align-items:center; gap:9px; flex-wrap:wrap; margin-top:10px; font-size:12px; color:var(--text-secondary); line-height:1.5; }
.rl-charts{ display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; margin-top:var(--space-4); }
.rl-charts .chart-card{ margin-top:0; }
.rl-chart-wrap{ height:230px; min-height:0; }
.rl-breakdowns{ display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; margin-top:var(--space-4); }
.rl-breakdowns .panel{ padding:15px 16px; }
.rl-seg-title{ font-size:13px; font-weight:800; color:var(--text-primary); }
.rl-seg-sub{ font-size:11px; color:var(--text-muted); margin-top:2px; }
.rl-seg-bar{ display:flex; height:14px; border-radius:7px; overflow:hidden; margin:12px 0 11px; background:var(--bg-sunken); }
.rl-seg-bar i{ display:block; height:100%; }
.rl-seg-legend{ display:flex; flex-direction:column; gap:7px; }
.rl-seg-row{ display:flex; align-items:center; justify-content:space-between; gap:10px; font-size:12px; }
.rl-seg-key{ display:inline-flex; align-items:center; gap:7px; color:var(--text-secondary); }
.rl-seg-dot{ width:9px; height:9px; border-radius:3px; flex-shrink:0; }
.rl-seg-val{ font-variant-numeric:tabular-nums; color:var(--text-primary); font-weight:700; }
.rl-seg-share{ color:var(--text-muted); font-weight:600; margin-left:6px; }
.rl-table{ min-width:1180px; }
.rl-table thead th{ background:linear-gradient(90deg,#1E1245,#2d1b69); color:rgba(196,181,253,.72); border-bottom:0; }
.rl-table thead th.pt-id{ background:#1E1245; }
.rl-table .pt-sortable:hover{ color:#fff; }
.rl-table th.pt-sorted{ color:#C4B5FD; }
.rl-id-wrap{ display:flex; align-items:flex-start; gap:6px; }
.rl-expand-btn{ border:none; background:none; cursor:pointer; color:var(--text-muted); padding:2px 2px 0 0; display:inline-flex; align-items:center; flex-shrink:0; }
.rl-expand-btn:hover{ color:var(--accent-strong); }
.rl-drill-cell{ background:var(--bg-subtle); padding:0; }
.rl-drill{ display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:16px; padding:14px 16px; }
.rl-drill h4{ margin:0 0 8px; font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--text-muted); }
.rl-dl{ display:flex; flex-direction:column; gap:5px; }
.rl-dl-row{ display:flex; justify-content:space-between; gap:12px; font-size:12px; }
.rl-dl-row span{ color:var(--text-secondary); }
.rl-dl-row b{ font-variant-numeric:tabular-nums; color:var(--text-primary); font-weight:700; text-align:right; }
.rl-fresh-grid{ display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:2px 22px; margin-top:12px; }
.rl-fresh-row{ display:flex; justify-content:space-between; gap:12px; font-size:12px; border-bottom:1px solid var(--border-default); padding:6px 0; }
.rl-fresh-row span{ color:var(--text-muted); }
.rl-fresh-row b{ font-weight:700; color:var(--text-primary); text-align:right; }
@media (max-width:1180px){
  .rvkpi-grid-6{ grid-template-columns:repeat(3,minmax(0,1fr)); }
  .rl-charts, .rl-breakdowns{ grid-template-columns:1fr; }
  .rl-drill{ grid-template-columns:1fr; }
}
@media (max-width:640px){
  .rvkpi-grid-6{ grid-template-columns:repeat(2,minmax(0,1fr)); }
}

/* ======================= INSIGHT ENGINE ======================= */
.priority-panel{ margin-top:var(--space-4); }
.insight-list{ display:flex; flex-direction:column; gap:9px; margin-top:10px; }
.insight-row{
  border:1px solid var(--border-default); border-left:3px solid var(--border-strong);
  border-radius:var(--radius-md); padding:11px 13px; background:var(--bg-subtle);
  transition:box-shadow var(--t) var(--ease), border-color var(--t) var(--ease);
}
.insight-row:hover{ box-shadow:var(--shadow-sm); }
.insight-row.insight-high{ border-left-color:var(--negative); background:#FEF8F8; }
.insight-row.insight-medium{ border-left-color:var(--brand); background:#FEFBF5; }
.insight-row.insight-low{ border-left-color:var(--border-strong); }
.insight-head{ display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:9px; }
.insight-title{ font-size:12.5px; font-weight:750; color:var(--text-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.insight-money{ font-size:12.5px; font-weight:750; white-space:nowrap; color:var(--text-primary); }
.insight-why{ margin-top:6px; font-size:11.5px; color:var(--text-secondary); line-height:1.55; }
.insight-evidence{ display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
.insight-chip{ display:inline-flex; align-items:baseline; gap:5px; border:1px solid var(--border-default); border-radius:var(--radius-pill); padding:2px 9px; background:var(--bg-surface); font-size:10.5px; }
.insight-chip em{ font-style:normal; color:var(--text-muted); }
.insight-chip b{ font-weight:700; color:var(--text-primary); font-size:10.5px; }
.insight-action{ margin-top:8px; font-size:11.5px; color:var(--text-primary); line-height:1.55; }
.insight-action strong{ color:var(--accent-strong); }
.insight-foot{ margin-top:7px; font-size:10px; color:var(--text-muted); line-height:1.5; }
.feed-source{ display:inline-block; font-size:10px; font-weight:750; color:var(--text-secondary); background:var(--bg-sunken); border-radius:var(--radius-pill); padding:2px 8px; }

/* ======================= MODAL ======================= */
.cogs-modal-backdrop{ position:fixed; inset:0; z-index:60; display:grid; place-items:center; padding:18px; background:rgba(17,26,46,.38); }
.cogs-modal{ width:min(100%,420px); border:1px solid var(--border-default); border-radius:var(--radius-lg); background:var(--bg-elevated); box-shadow:var(--shadow-lg); padding:18px; }
.cogs-modal-head{ display:flex; justify-content:space-between; align-items:flex-start; gap:12px; }
.cogs-modal-meta{ margin-top:8px; font-size:11px; color:var(--text-muted); }
.cogs-modal-input{ display:flex; flex-direction:column; gap:6px; margin-top:18px; }
.cogs-modal-input input{ width:100%; min-height:38px; border:1px solid var(--border-default); border-radius:var(--radius-sm); padding:8px 10px; font:650 14px inherit; color:var(--text-primary); background:var(--bg-surface); }
.cogs-modal-error{ margin-top:8px; color:var(--negative); font-size:12px; font-weight:650; }
.cogs-modal-actions{ display:flex; justify-content:flex-end; gap:8px; flex-wrap:wrap; margin-top:18px; }

/* ======================= AUTH + ACCESS ======================= */
.auth-root{ min-height:100vh; display:grid; place-items:center; padding:24px; background:var(--bg-app); font-family:'Plus Jakarta Sans',-apple-system,'Segoe UI',sans-serif; color:var(--text-primary); }
.auth-panel{ width:min(100%,410px); border:1px solid var(--border-default); border-radius:var(--radius-lg); background:var(--bg-surface); padding:30px; box-shadow:var(--shadow-lg); }
.auth-logo{ display:grid; place-items:center; width:40px; height:40px; border-radius:11px; background:linear-gradient(145deg,#FF6B6B,#FFAD5A); color:var(--text-inverse); font-weight:800; font-size:12px; font-family:'Outfit',sans-serif; box-shadow:0 8px 20px rgba(255,107,107,.26); }
.auth-title{ margin-top:18px; font-size:21px; font-weight:800; letter-spacing:0; }
.auth-sub{ margin-top:7px; color:var(--text-secondary); font-size:12.5px; line-height:1.6; }
.auth-field{ display:flex; flex-direction:column; gap:6px; margin-top:16px; color:var(--text-muted); font-size:10px; font-weight:800; text-transform:uppercase; letter-spacing:.07em; }
.auth-field input,.auth-field select{ min-height:39px; width:100%; border:1px solid var(--border-default); border-radius:var(--radius-sm); padding:8px 11px; color:var(--text-primary); background:var(--bg-elevated); font:600 14px 'Plus Jakarta Sans',sans-serif; text-transform:none; letter-spacing:0; }
.auth-field input:focus,.auth-field select:focus{ outline:none; border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-soft); }
.auth-submit{ width:100%; min-height:41px; margin-top:20px; border:0; border-radius:var(--radius-sm); background:linear-gradient(135deg,#8B5CF6,#6D42E8); color:var(--text-inverse); cursor:pointer; font:750 13px 'Plus Jakarta Sans',sans-serif; transition:opacity var(--t-fast) var(--ease); box-shadow:0 8px 20px rgba(109,66,232,.22); }
.auth-submit:hover:not(:disabled){ opacity:.9; }
.auth-submit:disabled{ opacity:.6; cursor:not-allowed; }
.auth-error,.auth-success{ display:flex; align-items:center; gap:7px; margin-top:14px; padding:9px 11px; border-radius:var(--radius-sm); font-size:12px; font-weight:700; border:1px solid transparent; }
.auth-error{ color:var(--negative); background:var(--negative-soft); border-color:var(--negative-border); }
.auth-success{ color:var(--positive); background:var(--positive-soft); border-color:var(--positive-border); }
.auth-note{ margin-top:13px; color:var(--text-muted); font-size:11px; line-height:1.55; text-align:center; }
.auth-link{ display:block; width:100%; margin-top:10px; border:0; background:transparent; color:var(--accent-strong); cursor:pointer; font:700 11.5px 'Plus Jakarta Sans',sans-serif; }
.access-page{ padding-bottom:var(--space-6); }
.access-heading{ align-items:center; }
.access-grid{ display:grid; grid-template-columns:minmax(280px,.85fr) minmax(360px,1.5fr); gap:var(--space-3); margin-top:var(--space-4); }
.access-invite,.access-users,.access-editor{ padding:16px; }
.access-invite .panel-title,.access-users .panel-title{ display:flex; align-items:center; gap:8px; }
.access-field-label{ margin-top:16px; color:var(--text-muted); font-size:10px; font-weight:800; text-transform:uppercase; letter-spacing:.07em; }
.access-account-list{ max-height:240px; overflow:auto; margin-top:8px; border:1px solid var(--border-default); border-radius:var(--radius-sm); }
.access-account-check{ display:flex; align-items:flex-start; gap:8px; padding:9px 11px; border-bottom:1px solid var(--border-default); color:var(--text-primary); font-size:12.5px; font-weight:600; cursor:pointer; }
.access-account-check:last-child{ border-bottom:0; }
.access-account-check:hover{ background:var(--bg-subtle); }
.access-account-check input{ margin-top:2px; accent-color:var(--accent); }
.access-user-list{ margin-top:12px; border-top:1px solid var(--border-default); }
.access-user-row{ width:100%; display:grid; grid-template-columns:minmax(160px,1fr) auto auto; align-items:center; gap:12px; padding:11px 4px; border:0; border-bottom:1px solid var(--border-default); background:transparent; color:var(--text-primary); font:inherit; text-align:left; cursor:pointer; transition:background var(--t-fast) var(--ease); }
.access-user-row:hover,.access-user-row.selected{ background:var(--accent-soft); }
.access-user-row strong,.access-user-row small{ display:block; }
.access-user-row strong{ font-size:12.5px; }
.access-user-row small{ margin-top:3px; color:var(--text-muted); font-size:11px; }
.access-role{ display:inline-flex; justify-content:center; min-width:58px; padding:4px 8px; border-radius:var(--radius-pill); background:var(--bg-sunken); color:var(--text-secondary); font-size:9.5px; font-weight:800; text-transform:uppercase; letter-spacing:.05em; }
.access-role.role-admin{ background:var(--accent-soft); color:var(--accent-strong); }
.access-role.role-editor{ background:var(--warning-soft); color:var(--warning); }
.access-editor{ margin-top:var(--space-4); max-width:720px; }
.access-empty{ margin-top:var(--space-4); color:var(--text-secondary); font-size:13px; }
.check-grid{ display:flex; flex-wrap:wrap; gap:10px; }
.check-item{ display:flex; align-items:center; gap:7px; font-size:12.5px; font-weight:600; border:1px solid var(--border-default); padding:6px 10px; border-radius:var(--radius-sm); cursor:pointer; background:var(--bg-subtle); }
.check-item input{ accent-color:var(--accent); }
.brand-panel{ margin-top:var(--space-4); background:var(--bg-surface); border:1px solid var(--border-default); border-radius:var(--radius-md); padding:14px 16px; }
.brand-panel-head{ display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-wrap:wrap; gap:8px; }

/* SKU P&L insight columns */
.skupl-insights{ display:grid; grid-template-columns:1fr 1fr; gap:var(--space-3); margin-top:var(--space-4); }
.skupl-rank{ display:flex; flex-direction:column; margin-top:4px; }
.skupl-rank-row{ display:grid; grid-template-columns:22px 1fr auto; align-items:center; gap:10px; padding:7px 0; border-bottom:1px solid var(--grid-line); }
.skupl-rank-row:last-child{ border-bottom:none; }
.skupl-rank-num{ font:700 11px 'Outfit',sans-serif; color:var(--text-muted); }
.skupl-rank-name{ min-width:0; font-size:12px; font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; display:flex; flex-direction:column; }
.skupl-rank-sub{ font-size:10px; color:var(--text-muted); font-weight:500; overflow:hidden; text-overflow:ellipsis; }
.skupl-rank-val{ text-align:right; font-weight:700; font-size:12px; white-space:nowrap; display:flex; flex-direction:column; }
.skupl-rank-margin{ font-size:10px; color:var(--text-muted); font-weight:600; }
.skupl-leaks{ display:flex; flex-direction:column; gap:8px; margin-top:6px; max-height:340px; overflow-y:auto; }
.skupl-leak-row{ border:1px solid var(--border-default); border-radius:var(--radius-sm); padding:9px 11px; background:var(--bg-subtle); }
.skupl-leak-head{ display:grid; grid-template-columns:auto 1fr auto; align-items:center; gap:8px; }
.skupl-leak-name{ min-width:0; font-size:12px; font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.skupl-leak-profit{ font-weight:700; font-size:11.5px; white-space:nowrap; }
.skupl-leak-action{ font-size:11px; color:var(--text-secondary); margin-top:5px; line-height:1.5; }

/* ======================= BRAND PORTFOLIO ======================= */
.dashboard-mode{ flex:0 0 auto; white-space:nowrap; }
.dashboard-mode button{ min-width:82px; }
/* The .brand-portfolio-* rules were removed with the component that used them.
   The cross-account report now uses the shared .bv-* patterns below. */

/* ============ ACCOUNT-SCOPED BRAND VIEW (view key: brandview) ============
   A separate module from the portfolio brand mode above. It reuses the same
   tokens, panel, alert, state and button patterns; only the control bar and the
   wide country grid are new. Light theme only, like the rest of the system. */
.bv-page{ padding-bottom:var(--space-6); }

.bv-controls{
  display:flex; flex-wrap:wrap; align-items:flex-end; gap:var(--space-3);
  margin-top:var(--space-4); padding:12px 14px;
  border:1px solid var(--border-default); border-radius:var(--radius-md);
  background:var(--bg-surface); box-shadow:var(--shadow-xs);
}
.bv-field{ display:flex; flex-direction:column; gap:5px; min-width:0; flex:1 1 190px; }
.bv-field.disabled{ opacity:.6; }
.bv-field-label{
  display:flex; align-items:center; gap:6px; color:var(--text-muted);
  font-size:10px; font-weight:800; letter-spacing:.07em; text-transform:uppercase;
}
.bv-field-label svg{ opacity:.75; flex:0 0 auto; }
.bv-select{
  width:100%; min-width:0; padding:8px 10px; appearance:auto;
  border:1px solid var(--border-strong); border-radius:var(--radius-sm);
  background:var(--bg-elevated); color:var(--text-primary);
  font:inherit; font-size:12.5px; font-weight:650; cursor:pointer;
  transition:border-color var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease);
}
.bv-select:hover:not(:disabled){ border-color:var(--border-hover); }
.bv-select:disabled{ cursor:not-allowed; background:var(--bg-sunken); color:var(--text-muted); }
.bv-custom{ flex:1 1 260px; }
.bv-custom-inputs{ display:flex; gap:6px; }
.bv-custom-inputs input[type=date]{
  flex:1; min-width:0; padding:7px 9px; border:1px solid var(--border-strong);
  border-radius:var(--radius-sm); background:var(--bg-elevated); color:var(--text-primary);
  font:inherit; font-size:12px;
}
.bv-actions{ display:flex; align-items:center; gap:var(--space-2); margin-left:auto; padding-bottom:1px; }

.bv-export{ position:relative; }
.bv-menu{
  position:absolute; right:0; top:calc(100% + 6px); z-index:20; min-width:236px;
  display:flex; flex-direction:column; padding:5px;
  border:1px solid var(--border-strong); border-radius:var(--radius-md);
  background:var(--bg-elevated); box-shadow:var(--shadow-lg);
}
.bv-menu button{
  display:flex; align-items:flex-start; gap:9px; padding:8px 9px; border:0;
  border-radius:var(--radius-sm); background:transparent; color:var(--text-primary);
  font:inherit; font-size:12.5px; text-align:left; cursor:pointer;
}
.bv-menu button:hover{ background:var(--accent-soft); color:var(--accent-strong); }
.bv-menu button svg{ margin-top:2px; flex:0 0 auto; opacity:.8; }
.bv-menu button b{ display:block; font-weight:750; }
.bv-menu button small{ display:block; margin-top:1px; color:var(--text-muted); font-size:10.5px; font-weight:600; }
.bv-export-error{ position:absolute; right:0; top:calc(100% + 6px); z-index:20; width:250px; padding:8px 10px; border:1px solid var(--negative-border); border-radius:var(--radius-sm); background:var(--negative-soft); color:var(--negative); font-size:11px; font-weight:650; }

.bv-freshness{ margin-top:var(--space-3); }
.bv-kpis{ margin-top:var(--space-4); }
.bv-panel{ margin-top:var(--space-4); overflow:hidden; }

/* The table scrolls inside its own container so the page never scrolls
   sideways on a tablet or a phone, and the country column stays pinned. */
/* The negative margin bleeds the grid to the panel edges, so it must match
   .panel's own 16px 18px padding exactly. */
.bv-scroll{ overflow-x:auto; overflow-y:visible; overscroll-behavior-inline:contain; -webkit-overflow-scrolling:touch; max-width:100%; margin:0 -18px -16px; padding:0 0 2px; }
.bv-table{ width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; }

/* Headers are sentence case and generously sized. An all-caps micro-header is
   fine for a dense operational grid; this is a report people read across, and
   "Total Sales" is easier to scan than "TOTAL SALES" at 9px. */
/* Deep-violet header (matches the Dashboard / Daily Reporting Royal Violet system). */
.bv-table th{
  padding:11px 14px; background:linear-gradient(90deg,#1E1245,#2d1b69); border-bottom:0;
  color:rgba(196,181,253,.72); font-size:10px; font-weight:800; letter-spacing:.07em; text-transform:uppercase;
  text-align:right; white-space:nowrap; position:sticky; top:0; z-index:2;
}
.bv-table th.bv-first, .bv-table td.bv-first{
  text-align:left; position:sticky; left:0; z-index:3;
  background:var(--bg-surface); min-width:190px;
}
.bv-table th.bv-first{ color:#C4B5FD; background:#1E1245; }
.bv-table td.bv-first{ z-index:1; font-weight:700; color:var(--text-primary); font-size:13px; }
.bv-table td{
  padding:13px 14px; border-bottom:1px solid var(--grid-line); color:var(--text-primary);
  font-size:13px; font-weight:650; text-align:right; vertical-align:middle; white-space:nowrap;
}
.bv-table td.bv-num{ font-variant-numeric:tabular-nums; }
.bv-table td small{ display:block; margin-top:2px; color:var(--text-muted); font-size:10.5px; font-weight:600; }
.bv-table tbody tr:last-child td{ border-bottom:0; }
.bv-table tbody tr:hover td{ background:var(--bg-subtle); }
.bv-table tbody tr:hover td.bv-first{ background:var(--bg-subtle); }

/* Toned columns. Inventory reads green because it is a stock position rather
   than a money figure; the current-month projection and the advertising pair
   get their own tints so the eye can find them in a wide month grid. */
.bv-table .bv-col-positive{ color:var(--positive); }
.bv-table th.bv-col-positive{ color:#6EE7B7; font-weight:800; }
.bv-table .bv-col-accent{ color:var(--accent-strong); }
.bv-table th.bv-col-accent{ color:#C4B5FD; font-weight:800; }
.bv-table .bv-col-latest, .bv-table .bv-col-total{ background:var(--brand-soft); color:var(--text-primary); font-weight:750; }
/* The current-month / latest column gets a coral accent in the deep-violet header, like the Daily Reporting MTD. */
.bv-table th.bv-col-latest, .bv-table th.bv-col-total{ color:#FF9482; box-shadow:inset 0 -2px 0 #FF6B6B; }
.bv-table tbody tr:hover td.bv-col-latest, .bv-table tbody tr:hover td.bv-col-total{ background:#FFE1DC; }

/* The All Markets row. One per currency group — and with a single currency,
   which is every converted view, there is exactly one, at the top. */
.bv-table .bv-total td{
  background:var(--accent-soft); border-bottom:1px solid var(--accent-border);
  color:var(--accent-strong); font-weight:800;
}
.bv-table .bv-total td.bv-first{ background:var(--accent-soft); color:var(--accent-strong); font-weight:800; }
.bv-table .bv-total td small{ color:var(--accent-strong); opacity:.8; }
.bv-table tbody tr.bv-total:hover td{ background:var(--accent-soft); }

/* The currency divider, rendered only when a report spans more than one
   currency. It makes the stacked groups read as separate tables instead of as
   one table with several confusing All Markets rows. */
.bv-table .bv-band td{
  padding:9px 14px; background:var(--bg-sunken); border-top:1px solid var(--border-strong);
  border-bottom:1px solid var(--border-strong); color:var(--text-secondary);
  font-size:10.5px; font-weight:800; letter-spacing:.07em; text-align:left; text-transform:uppercase;
}
.bv-table tbody tr:first-child.bv-band td{ border-top:0; }
.bv-table .bv-section td{
  padding:10px 14px; background:var(--bg-subtle); border-top:1px solid var(--border-strong);
  border-bottom:1px solid var(--border-strong); color:var(--text-muted);
  font-size:10.5px; font-weight:800; letter-spacing:.08em; text-align:left; text-transform:uppercase;
}

/* ===================================================================
   Brand View + SKU Movement redesign (Royal Violet; additive & scoped)
   =================================================================== */
/* Gradient KPI tiles shared by the two redesigned views. */
.rvkpi-grid{ display:grid; gap:12px; margin-top:var(--space-4); }
.rvkpi-grid-4{ grid-template-columns:repeat(4,minmax(0,1fr)); }
.rvkpi-grid-5{ grid-template-columns:repeat(5,minmax(0,1fr)); }
.rvkpi{ border-radius:var(--radius-md); padding:15px 17px; color:#fff; box-shadow:var(--shadow-sm); min-width:0; }
.rvkpi-light{ background:var(--bg-surface); border:1px solid var(--border-default); color:var(--text-primary); }
.rvkpi-top{ display:flex; align-items:flex-start; justify-content:space-between; gap:8px; }
.rvkpi-label{ font-size:9.5px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; color:rgba(255,255,255,.82); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.rvkpi-light .rvkpi-label{ color:var(--text-muted); }
.rvkpi-value{ font-family:'Outfit',sans-serif; font-variant-numeric:tabular-nums; font-size:23px; font-weight:800; line-height:1.12; margin-top:9px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.rvkpi-sub{ font-size:10.5px; margin-top:6px; color:rgba(255,255,255,.8); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.rvkpi-light .rvkpi-sub{ color:var(--text-muted); }
.rvkpi-pos{ color:var(--positive); }
.rvkpi-neg{ color:var(--negative); }
.rvkpi-hint{ flex-shrink:0; display:inline-flex; }
.rvkpi-hint button, .rvkpi-hint svg{ color:rgba(255,255,255,.72); }
.rvkpi-light .rvkpi-hint button, .rvkpi-light .rvkpi-hint svg{ color:var(--text-muted); }

/* Amount + contribution-share presenter -- two SEPARATE block elements, NEVER a concatenated string. */
.cell-amt{ display:block; }
.cell-share{ display:block; margin-top:2px; font-size:10.5px; font-weight:600; color:var(--text-muted); }
.bv-table .bv-total .cell-share{ color:var(--accent-strong); opacity:.85; }

/* SKU Movement table: REUSES plan-table layout; recolours ONLY under .sku-mv, so no other plan table is touched. */
.sku-mv thead th{ background:linear-gradient(90deg,#1E1245,#2d1b69); color:rgba(196,181,253,.72); border-bottom:0; }
.sku-mv .pt-sortable:hover{ color:#fff; }
.sku-mv th.pt-sorted{ color:#C4B5FD; }
.sku-mv thead th.sku-mv-mtd{ color:#FF9482; box-shadow:inset 0 -2px 0 #FF6B6B; }
.sku-mv thead th.sku-mv-last5{ color:#C9B8FF; box-shadow:inset 0 -2px 0 #7B4EF3; }
.sku-mv td.sku-mv-mtd{ background:var(--brand-soft); font-weight:800; color:var(--text-primary); border-left:1px solid rgba(255,107,107,.20); border-right:1px solid rgba(255,107,107,.20); }
.sku-mv td.sku-mv-last5{ background:rgba(123,78,243,.08); font-weight:800; color:var(--text-primary); border-left:1px solid rgba(123,78,243,.18); border-right:1px solid rgba(123,78,243,.18); }
.sku-mv tbody tr:hover td.sku-mv-mtd{ background:#FFE1DC; }
.sku-mv tbody tr:hover td.sku-mv-last5{ background:#EBE3FF; }
.sku-mv tfoot td.sku-mv-mtd, .sku-mv tfoot td.sku-mv-last5{ background:var(--bg-sunken); }
/* Movement % badge (red/green pill) -- direction is never colour alone: the sign + word remain in the text/status. */
.sku-mv-move{ display:inline-block; padding:2px 8px; border-radius:var(--radius-pill); font-size:11px; font-weight:800; font-variant-numeric:tabular-nums; }
.sku-mv-move-pos{ background:var(--positive-soft); color:var(--positive); }
.sku-mv-move-neg{ background:var(--negative-soft); color:var(--negative); }
.sku-mv-move-flat{ color:var(--text-muted); }

@media (max-width:1180px){
  .rvkpi-grid-4{ grid-template-columns:repeat(2,minmax(0,1fr)); }
  .rvkpi-grid-5{ grid-template-columns:repeat(3,minmax(0,1fr)); }
}
@media (max-width:640px){
  .rvkpi-grid-4, .rvkpi-grid-5{ grid-template-columns:repeat(2,minmax(0,1fr)); }
  .rvkpi-value{ font-size:20px; }
}

/* ======================= RESPONSIVE ======================= */
@media (max-width:1180px){
  .metric-grid{ grid-template-columns:repeat(2,minmax(0,1fr)); }
  .cmp-grid{ grid-template-columns:repeat(2,minmax(0,1fr)); }
  .skupl-kpis{ grid-template-columns:repeat(4,minmax(0,1fr)); }
  .tb-select.account select{ min-width:150px; max-width:210px; }
  .tb-select.brand select{ min-width:110px; max-width:160px; }
  .tb-select.region select{ min-width:120px; max-width:180px; }
  .tb-combo.account .tb-combo-trigger{ min-width:150px; max-width:210px; }
  .tb-combo.brand .tb-combo-trigger{ min-width:120px; max-width:180px; }
  .dashboard-mode button{ min-width:74px; }
  .refresh-status-value{ max-width:150px; }
}
@media (max-width:900px){
  .breakdown-grid{ grid-template-columns:1fr; }
  .insight-head{ grid-template-columns:1fr; gap:5px; }
  .insight-title{ white-space:normal; }
  .insight-money{ text-align:left; }
  .plan-stat-row{ grid-template-columns:repeat(3,minmax(0,1fr)); }
  .recon-kpis{ grid-template-columns:repeat(2,minmax(0,1fr)); }
  .recon-chart-grid{ grid-template-columns:1fr; }
  .skupl-kpis{ grid-template-columns:repeat(3,minmax(0,1fr)); }
  .skupl-insights{ grid-template-columns:1fr; }
  .access-grid{ grid-template-columns:1fr; }
  .access-user-row{ grid-template-columns:minmax(130px,1fr) auto; }
  .access-user-row > :last-child{ grid-column:2; }
  .chart-wrap{ height:260px; }
  .container{ max-width:none; padding:var(--space-4) var(--space-4) 0; }

  /* Sidebar becomes an accessible off-canvas drawer. Collapse mode is ignored. */
  .sidebar{ position:fixed; left:0; top:0; height:100vh; width:272px; transform:translateX(-100%); transition:transform var(--t-slow) var(--ease); box-shadow:var(--shadow-lg); }
  .sidebar.collapsed{ width:272px; }
  .sidebar.collapsed .sb-brand{ justify-content:flex-start; padding:0 14px; }
  .sidebar.collapsed .sb-brand-text{ display:flex; }
  .sidebar.collapsed .sb-group-label{ visibility:visible; height:auto; padding:0 10px 5px; }
  .sidebar.collapsed .sb-group + .sb-group{ margin-top:12px; border-top:0; padding-top:0; }
  .sidebar.collapsed .sb-nav-item{ justify-content:flex-start; padding:8px 10px; }
  .sidebar.collapsed .sb-nav-label{ display:inline; }
  .sidebar.collapsed .sb-nav-item.active::before{ left:-8px; }
  .sidebar.mobile-open{ transform:translateX(0); }
  .sb-close{ display:inline-flex; }
  .sb-collapse.collapse-toggle{ display:none; }
  .menu-btn{ display:inline-flex; }
  .sb-backdrop{ display:block; position:fixed; inset:0; background:rgba(17,26,46,.45); z-index:35; }
  .topbar{ padding:10px 16px; gap:10px; }
  .tb-right{ width:100%; margin-left:0; justify-content:flex-start; }
  .tb-select{ flex:1 1 190px; min-width:0; }
  .dashboard-mode{ flex:1 1 100%; }
  .tb-select.account select,.tb-select.brand select,.tb-select.region select{ min-width:0; max-width:none; width:100%; }
  .tb-combo.account .tb-combo-trigger,.tb-combo.brand .tb-combo-trigger{ min-width:0; max-width:none; width:100%; }
  .tb-combo-pop{ left:0; right:0; width:auto; max-width:none; }
  .refresh-cluster{ flex:1 1 160px; }
  .refresh-status-value{ max-width:none; }

  .bv-controls{ gap:var(--space-2); }
  .bv-field{ flex:1 1 46%; }
  .bv-actions{ flex:1 1 100%; margin-left:0; }
  .bv-actions > *{ flex:1 1 auto; }
  .bv-actions .plan-export-btn{ width:100%; justify-content:center; }
  .bv-menu{ right:auto; left:0; }
}
@media (max-width:640px){
  .bv-field{ flex:1 1 100%; }
  .bv-custom-inputs{ flex-direction:column; }
  .bv-table th.bv-first, .bv-table td.bv-first{ min-width:140px; }
  .bv-table th, .bv-table td{ padding:8px 9px; }
  .bv-menu{ min-width:0; width:calc(100vw - 48px); max-width:280px; }
  .bv-export-error{ width:calc(100vw - 48px); max-width:280px; }
  .metric-grid,.cmp-grid{ grid-template-columns:1fr; }
  .container{ padding:var(--space-4) var(--space-3) 0; }
  .plan-stat-row{ grid-template-columns:repeat(2,minmax(0,1fr)); }
  .plan-table th.pt-id, .plan-table td.pt-id{ min-width:158px; max-width:190px; }
  .pt-name,.pt-meta,.pt-brand{ max-width:178px; }
  .recon-kpis{ grid-template-columns:1fr; }
  .recon-month-picker{ width:100%; justify-content:space-between; }
  .recon-waterfall-row{ grid-template-columns:96px minmax(70px,1fr) 96px; gap:7px; }
  .recon-waterfall-row > strong{ font-size:10.5px; }
  .recon-filters{ display:grid; grid-template-columns:1fr 1fr; }
  .recon-search{ grid-column:1/-1; min-width:0; }
  .skupl-kpis{ grid-template-columns:repeat(2,minmax(0,1fr)); }
  .bd-row{ grid-template-columns:minmax(0,1fr) 84px; }
  .chart-wrap{ height:230px; }
  .chart-card-body{ padding:10px 6px 4px 0; }
  .metric-value{ font-size:23px; }
  .chip-row{ width:100%; }
  .segmented{ width:100%; overflow-x:auto; overscroll-behavior-x:contain; justify-content:flex-start; scrollbar-width:none; }
  .segmented::-webkit-scrollbar{ display:none; }
  .custom-range{ width:100%; }
  .custom-range input[type=date]{ flex:1; min-width:0; }
  .tb-select{ flex:1 1 100%; }
  .dashboard-mode{ width:100%; }
  .refresh-cluster{ flex:1 1 100%; }
  .sk-row{ grid-template-columns:minmax(0,1.4fr) minmax(0,1fr); }
}

/* ======================= MOTION + FOCUS ======================= */
@media (prefers-reduced-motion: reduce){
  *,*::before,*::after{ animation-duration:0.01ms !important; animation-iteration-count:1 !important; transition-duration:0.01ms !important; scroll-behavior:auto !important; }
  .metric-card:hover,.plan-stat:hover,.recon-kpi:hover,.skupl-kpi:hover{ transform:none; }
}
:focus-visible{ outline:2px solid var(--accent); outline-offset:2px; border-radius:4px; }
button:focus-visible, select:focus-visible, input:focus-visible, a:focus-visible, [tabindex]:focus-visible{ outline:2px solid var(--accent); outline-offset:2px; }
::selection{ background:var(--accent-soft); color:var(--accent-strong); }

/* ======================= ADMIN DATA SYNC CENTER ======================= */
.sync-center{ padding-bottom:40px; }
.sync-center-head{ align-items:center; }
.sync-center-note{ margin:14px 0; display:flex; gap:10px; align-items:flex-start; }
.sync-center-note div div{ margin-top:3px; color:var(--ink-soft); }
.sync-scope-panel{ display:grid; grid-template-columns:minmax(190px,.7fr) minmax(260px,1fr) minmax(280px,1.4fr); gap:14px; align-items:end; padding:16px; margin-bottom:16px; }
.sync-scope-panel label{ display:grid; gap:6px; }
.sync-scope-panel label span{ color:var(--ink-muted); font-size:11px; font-weight:700; text-transform:uppercase; }
.sync-scope-panel select{ width:100%; min-height:38px; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--ink); padding:0 10px; }
.sync-token-note{ color:var(--ink-soft); font-size:12px; line-height:1.45; }
.sync-report-grid{ display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
.sync-report-card{ padding:16px; min-width:0; }
.sync-report-card.locked{ background:var(--bg-subtle); }
.sync-report-title{ display:flex; align-items:center; justify-content:space-between; gap:12px; }
.sync-report-title>div{ display:grid; gap:3px; min-width:0; }
.sync-report-title strong{ font-size:14px; }
.sync-report-title span{ color:var(--ink-muted); font-size:11px; text-transform:capitalize; }
.sync-report-meta{ display:grid; grid-template-columns:auto minmax(0,1fr); gap:6px 12px; margin:14px 0; font-size:12px; }
.sync-report-meta span{ color:var(--ink-muted); }
.sync-report-meta strong{ overflow-wrap:anywhere; }
.sync-report-actions{ display:flex; gap:8px; justify-content:flex-end; }
.sync-readiness,.sync-last-error{ min-height:34px; margin-bottom:12px; color:var(--ink-soft); font-size:12px; line-height:1.4; }
.sync-last-error{ color:var(--negative); }
.sync-loading{ padding:32px; text-align:center; color:var(--ink-soft); }
@media(max-width:900px){ .sync-scope-panel{ grid-template-columns:1fr 1fr; }.sync-token-note{ grid-column:1/-1; } }
@media(max-width:640px){ .sync-report-grid,.sync-scope-panel{ grid-template-columns:1fr; }.sync-token-note{ grid-column:auto; }.sync-report-actions{ justify-content:stretch; }.sync-report-actions button{ flex:1; } }

/* Report Delivery Status (read-only, per account). Icon+text status; horizontal scroll on small screens. */
.sync-scope-panel.delivery-panel{ display:block; }
.delivery-controls{ display:flex; flex-wrap:wrap; gap:14px; align-items:end; margin:14px 0; }
.delivery-controls label{ display:grid; gap:6px; }
.delivery-controls label>span{ color:var(--text-muted); font-size:11px; font-weight:700; text-transform:uppercase; }
.delivery-controls select{ min-height:38px; border:1px solid var(--border-default); border-radius:6px; background:var(--bg-surface); color:var(--text-primary); padding:0 10px; }
.delivery-controls .delivery-toggle{ grid-auto-flow:column; align-items:center; gap:8px; }
.delivery-controls .delivery-toggle input{ width:16px; height:16px; }
.delivery-controls .delivery-toggle>span{ text-transform:none; font-weight:600; font-size:13px; color:var(--text-secondary); }
.delivery-summary{ display:flex; flex-wrap:wrap; gap:8px; margin:12px 0; }
.delivery-table-wrap{ overflow-x:auto; margin-top:8px; border:1px solid var(--border-default); border-radius:10px; }
.delivery-table{ width:100%; border-collapse:collapse; font-size:12px; min-width:840px; }
.delivery-table th{ text-align:left; padding:8px 10px; background:var(--bg-subtle); color:var(--text-secondary); font-size:11px; text-transform:uppercase; letter-spacing:.02em; white-space:nowrap; border-bottom:1px solid var(--border-default); }
.delivery-table td{ padding:8px 10px; border-top:1px solid var(--border-default); vertical-align:top; }
.delivery-table tr.delivery-ineligible{ opacity:.62; }
.delivery-acct{ display:flex; flex-direction:column; gap:2px; min-width:150px; }
.delivery-cell{ display:flex; flex-direction:column; gap:4px; align-items:flex-start; }
.delivery-chip{ font-size:11px; white-space:nowrap; }
.delivery-ts{ color:var(--text-muted); font-size:10.5px; line-height:1.3; overflow-wrap:anywhere; }
.delivery-remark{ font-weight:600; white-space:nowrap; }
@media(max-width:640px){ .delivery-controls>label,.delivery-controls>button{ flex:1 1 auto; } }

/* ======================= ROYAL VIOLET THEME =======================
   Presentation-only overrides for the shared shell and report primitives.
   Data contracts, routes, report controls and interaction semantics stay in
   their existing components; every screen inherits this layer. */
.sidebar{
  background:linear-gradient(180deg,#16054E 0%,#19133D 56%,#0F172A 100%);
  border-right:1px solid rgba(167,139,250,.2);
  box-shadow:8px 0 28px rgba(22,5,78,.16);
  color:#FFFFFF;
}
.sb-brand{ min-height:64px; border-bottom-color:rgba(255,255,255,.09); }
.sb-logo{
  position:relative; border-radius:10px;
  background:linear-gradient(145deg,#FF6B6B 0%,#FF9F61 100%);
  font-family:'Outfit',sans-serif; font-size:13px;
  box-shadow:0 6px 16px rgba(255,107,107,.36), inset 0 0 0 1px rgba(255,255,255,.22);
}
.sb-ws-name{ color:#FFFFFF; font-family:'Outfit',sans-serif; font-size:14px; }
.sb-ws-sub{ color:#B8AEDF; }
.sb-group-label{ color:#776AA8; }
.sb-group + .sb-group{ border-color:rgba(255,255,255,.08); }
.sb-nav::-webkit-scrollbar-thumb{ background:rgba(167,139,250,.32); border-color:transparent; }
.sb-nav-item{ color:#C9C1EA; }
.sb-nav-item svg{ color:#A78BFA; opacity:1; }
.sb-nav-item:hover{ color:#FFFFFF; background:rgba(139,92,246,.15); }
.sb-nav-item.active{
  color:#FFFFFF; background:linear-gradient(90deg,rgba(255,107,107,.28),rgba(255,107,107,.12));
  box-shadow:inset 3px 0 0 #FF6B6B, 0 0 18px rgba(255,107,107,.13);
}
.sb-nav-item.active svg{ color:#FF7B78; }
.sb-nav-item.active::before{ left:-8px; width:3px; height:100%; border-radius:0; background:#FF6B6B; box-shadow:0 0 10px #FF6B6B; }
.sb-nav-item.active::after{
  content:''; position:absolute; right:10px; width:6px; height:6px; border-radius:50%;
  background:#FF7B78; box-shadow:0 0 8px #FF6B6B;
}
.sidebar.collapsed .sb-nav-item.active::after{ display:none; }
.sb-footer{ border-top-color:rgba(255,255,255,.09); background:rgba(7,8,34,.2); }
.sb-collapse,.sb-close{ color:#C9C1EA; }
.sb-collapse:hover,.sb-close:hover{ color:#FFFFFF; background:rgba(139,92,246,.16); }
.sb-collapse.signout:hover{ background:rgba(255,107,107,.16); color:#FF9B9B; }

.topbar{
  min-height:60px; background:rgba(255,255,255,.88); border-bottom-color:#E1DAFA;
  box-shadow:0 3px 16px rgba(54,31,112,.06); backdrop-filter:blur(16px); -webkit-backdrop-filter:blur(16px);
}
.crumb-root .crumb-mark{
  font-family:'Outfit',sans-serif; color:#FFFFFF; border:0; border-radius:7px;
  background:linear-gradient(135deg,#FF6B6B,#FF9F61); box-shadow:0 3px 10px rgba(255,107,107,.22);
}
.crumb-current{ font-family:'Outfit',sans-serif; }
.tb-select,.refresh-cluster{ border-color:#DED6FB; background:rgba(250,249,255,.95); box-shadow:0 2px 8px rgba(69,43,128,.04); }
.tb-select:hover,.refresh-cluster:hover{ border-color:#C9BBFA; }
.tb-select-label,.refresh-status-label{ color:#A68DE8; }
.account-sync-btn,.refresh-btn{ border-color:#DED6FB; }
.live-dot{ background:#28D7A1; box-shadow:0 0 0 3px rgba(40,215,161,.13); }

.container{ max-width:1680px; }
.page-title,.panel-title,.chart-card-title,.metric-value,.cmp-value{ font-family:'Outfit',sans-serif; }
.page-title{ font-size:21px; letter-spacing:0; }
.page-sub{ color:#8C86A6; }
.segmented,.seg,.report-tabs{ background:#F6F3FF; border-color:#DDD5FA; }
.segmented button.active,.seg button.active,.report-tabs button.active{
  color:#FFFFFF; background:linear-gradient(135deg,#9B7BFF,#7B4EF3); box-shadow:0 4px 12px rgba(123,78,243,.22);
}
.panel,.chart-card,.metric-card,.cmp-card{ border-color:#E6E0FA; box-shadow:0 3px 14px rgba(57,37,111,.05); }
.panel,.chart-card{ border-radius:12px; }
.metric-card,.cmp-card{ border-radius:12px; }
.metric-card:hover{ border-color:#CFC1FA; box-shadow:0 8px 22px rgba(72,43,139,.1); }
.metric-top{ align-items:center; }
.metric-label,.cmp-label{ color:#958DAC; }
.metric-actions{ display:inline-flex; align-items:center; gap:6px; }
.metric-icon{
  width:30px; height:30px; border-radius:10px; display:inline-flex; align-items:center; justify-content:center;
  color:#8B5CF6; background:#F1EDFF;
}
.metric-card:nth-child(3) .metric-icon{ color:#F59E0B; background:#FFF5DB; }
.metric-card:nth-child(4) .metric-icon{ color:#0FAD85; background:#E5F9F3; }
.metric-card.hero{
  color:#FFFFFF; border:0; overflow:hidden; position:relative;
  background:linear-gradient(130deg,#FF646C 0%,#FF8B60 58%,#FFAD5A 100%);
  box-shadow:0 14px 28px rgba(255,107,107,.25);
}
.metric-card.hero::after{
  content:''; position:absolute; width:130px; height:130px; right:-50px; top:-65px; border-radius:50%;
  background:rgba(255,255,255,.12); pointer-events:none;
}
.metric-card.hero .metric-label,.metric-card.hero .metric-period,.metric-card.hero .metric-hint{ color:rgba(255,255,255,.82); }
.metric-card.hero .metric-value{ color:#FFFFFF; }
.metric-card.hero .trend{ color:#FFFFFF; background:rgba(255,255,255,.18); border-color:rgba(255,255,255,.24); }
.metric-card.hero .metric-spark path:first-child{ fill:#FFFFFF; fill-opacity:.14; stroke:none; }
.metric-card.hero .metric-spark path:nth-child(2){ fill:none; stroke:#FFFFFF; }
.metric-card.hero .metric-spark circle{ fill:#FFFFFF; }
.cmp-value.up{ color:#08A778; }
.cmp-value.down{ color:#F34F5D; }
.chart-card{ margin-top:20px; overflow:hidden; }
.chart-card-head{ border-bottom-color:#F0ECFC; }
.chart-card-title{ font-size:15px; }
.chart-wrap{ min-height:270px; }
.chart-tip{ border-color:#D9CEFB; box-shadow:0 14px 34px rgba(44,25,92,.18); }
.breakdown-grid{ gap:16px; }
.bd-fill{ background:#B39BFF; }
.bd-row.active .bd-fill{ background:#8B5CF6; box-shadow:0 0 10px rgba(139,92,246,.32); }
.bd-bar{ background:#F1EEFB; }
.alert.info{ border-color:#CEC5FF; background:rgba(225,221,255,.54); color:#6750DA; }
.alert.warning{ border-color:#F4D998; background:rgba(255,247,226,.78); }
.status-badge,.trend{ border-radius:999px; }
.data-table thead th{ background:#FAF9FF; }

@media (max-width:900px){
  .sidebar{ width:272px; }
  .sb-backdrop{ background:rgba(15,7,43,.58); backdrop-filter:blur(2px); }
}

/* ========================================================================
   UPRIVER OPERATIONAL THEME — Amazon-inspired shell + Dashboard redesign.
   ------------------------------------------------------------------------
   Loaded LAST so it overrides the Royal Violet layer above. Two scopes only:
     1. SHARED CHROME (.sidebar / .topbar and their parts) is restyled
        GLOBALLY so the navigation rail and command bar look identical on
        every route — navy rail, white command bar, orange accent.
     2. DASHBOARD content is restyled ONLY under .dashboard-page /
        .dash-workspace, so the violet styling of every other report
        (Daily, Brand View, SKU Movement, Returns, FBA, ...) is untouched.
   No data, formula, route, permission or request is affected here.
   ======================================================================== */
:root{
  /* Deep graphite/navy with tonal layers for a premium rail. */
  /* --op-rail: the sidebar rail (Stitch #131A22). --op-navy: the top command bar (#232F3E). */
  --op-rail:#131A22; --op-rail-2:#1B242E;
  --op-navy:#232F3E; --op-navy-2:#1C2530; --op-navy-3:#2E3B49; --op-navy-hover:#37475A;
  --op-orange:#FF9900; --op-orange-dark:#E47911; --op-orange-strong:#C45500; --op-orange-soft:#FFF3E0;
  --op-amber:#F5A623;
  /* --op-blue: the exact interactive blue (Stitch #146EB4). Used ONLY by the shell chrome and the .dashboard-page
     scope -- the .op-report pages keep --op-steel, so they are untouched. */
  --op-blue:#146EB4; --op-blue-link:#146EB4; --op-blue-soft:#E7F1F9; --op-blue-border:#B7D5EC;
  --op-steel:#2F6FB0; --op-steel-2:#5B8DB8;
  /* Cool-neutral surfaces + pearl-white cards. */
  --op-bg:#EEF1F4; --op-bg-2:#F4F6F8; --op-card:#FFFFFF;
  --op-border:#D6DBDE; --op-border-2:#E4E8EB; --op-hair:#EDF0F2;
  --op-ink:#0F1111; --op-ink-2:#47535A; --op-ink-3:#6B767C; --op-ink-4:#8D9AA0;
  --op-green:#0B7D5A; --op-green-soft:#E9F6EF; --op-green-border:#BFE3D0;
  --op-red:#C0341A; --op-red-soft:#FBEDE9; --op-red-border:#EDBDB0;
  --op-warn-soft:#FBF3E2; --op-warn-border:#E7CD8E; --op-warn-ink:#7A5600;
  /* Dashboard chart palette (mirrors DASH_CHART in this module). */
  --dash-primary:#2F6FB0; --dash-teal:#0E9F6E; --dash-orders:#5B8DB8; --dash-gold:#E08600;
  --dash-steel:#3E6DA3;
}

/* ---------------- SHARED CHROME · SIDEBAR (deep graphite rail) ---------------- */
.sidebar{
  background:var(--op-rail);
  border-right:1px solid rgba(0,0,0,.5);
  box-shadow:inset -1px 0 0 rgba(255,255,255,.04);
  color:#F4F6F8;
}
.sb-brand{ min-height:64px; border-bottom:1px solid rgba(255,255,255,.07); box-shadow:none; }
.sb-logo{
  border-radius:6px; color:#1A1000; font-weight:800; letter-spacing:.03em;
  background:var(--op-orange);
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.25);
}
.sb-ws-name{ color:#FFFFFF; font-weight:800; letter-spacing:.01em; }
.sb-ws-sub{ color:rgba(226,233,240,.52); }
.sb-nav{ padding:12px 10px 14px; gap:3px; }
.sb-group + .sb-group{ margin-top:14px; }
.sidebar.collapsed .sb-group + .sb-group{ border-top-color:rgba(255,255,255,.08); }
.sb-group-label{ color:rgba(213,224,234,.40); font-size:9.5px; letter-spacing:.12em; padding:0 12px 6px; }
.sb-nav::-webkit-scrollbar-thumb{ background:rgba(255,255,255,.16); border-color:transparent; }
.sb-nav-item{
  color:rgba(224,231,238,.78); font-weight:600; border-radius:6px; padding:8px 11px;
  transition:background var(--t-fast) var(--ease), color var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease);
}
.sb-nav-item svg{ color:rgba(210,220,230,.72); opacity:1; }
.sb-nav-item:hover{ color:#FFFFFF; background:rgba(255,255,255,.06); box-shadow:inset 0 0 0 1px rgba(255,255,255,.05); }
.sb-nav-item:hover svg{ color:#FFFFFF; }
/* Refined selected surface: a clean lighter graphite (never a muddy amber wash),
   with a crisp amber route indicator + amber icon carrying the accent. */
.sb-nav-item.active{
  color:#FFFFFF; font-weight:750;
  background:rgba(255,255,255,.09);
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.06);
}
.sb-nav-item.active svg{ color:var(--op-amber); }
.sb-nav-item.active::before{
  left:-10px; width:3px; height:22px; border-radius:0 3px 3px 0;
  background:linear-gradient(180deg,#FFC24D,var(--op-orange)); box-shadow:0 0 8px rgba(255,153,0,.45);
}
.sb-nav-item.active::after{ display:none; }
.sidebar.collapsed .sb-nav-item.active::before{ left:0; }
.sb-footer{ border-top-color:rgba(255,255,255,.09); background:linear-gradient(180deg, transparent, rgba(0,0,0,.10)); }
.sb-collapse,.sb-close{ color:rgba(220,228,236,.66); border-radius:6px; }
.sb-collapse:hover,.sb-close:hover{ color:#FFFFFF; background:rgba(255,255,255,.07); }
.sb-collapse.signout:hover{ background:rgba(255,86,74,.16); color:#FFB9AE; }
/* Keyboard focus is always visible on the graphite rail (amber ring). */
.sb-nav-item:focus-visible,.sb-collapse:focus-visible,.sb-close:focus-visible{
  outline:2px solid var(--op-amber); outline-offset:-2px; border-radius:6px;
}

/* ---------------- SHARED CHROME · TOP COMMAND BAR (deep navy #232F3E) ---------------- */
.topbar{
  background:var(--op-navy); border-bottom:1px solid rgba(0,0,0,.4);
  box-shadow:0 1px 0 rgba(0,0,0,.18);
  backdrop-filter:none; -webkit-backdrop-filter:none;
  padding:11px 24px; gap:16px; min-height:60px;
}
.tb-right{ gap:10px; }
.crumb-root{ color:rgba(240,243,245,.72); }
.crumb-root .crumb-mark{
  color:#1A1000; background:var(--op-orange);
  border:1px solid var(--op-orange-dark); box-shadow:none; border-radius:5px;
  font-weight:800; letter-spacing:.09em;
}
.crumb-root-text{ color:rgba(240,243,245,.58); }
.crumb-current{ color:#FFFFFF; font-weight:800; }
.crumb-sep{ color:rgba(240,243,245,.42); }
/* Command-bar scope controls: dark chips on the navy bar, light text, orange focus ring. */
.tb-select,.refresh-cluster{ border-color:rgba(255,255,255,.16); background:var(--op-navy-3); box-shadow:none; border-radius:6px; }
.tb-select{ padding:5px 11px; }
.tb-select:hover,.refresh-cluster:hover{ border-color:rgba(255,255,255,.30); background:#354453; box-shadow:none; }
.tb-select:focus-within{ border-color:var(--op-orange); box-shadow:0 0 0 3px rgba(255,153,0,.30); }
.tb-select-label,.refresh-status-label{ color:rgba(226,233,240,.62); font-weight:800; }
.tb-select select,.tb-select .tb-combo-trigger,.tb-select .tb-combo-text{ color:#F3F4F5; }
.tb-select .tb-combo-text.placeholder{ color:rgba(226,233,240,.6); }
.tb-select-value > svg,.tb-select > svg:first-child{ color:rgba(226,233,240,.6); }
.tb-select-value select:focus-visible{ outline:none; }
.refresh-cluster{ padding:5px 7px 5px 11px; }
.refresh-status-value{ color:#F3F4F5; }
.account-sync-btn,.refresh-btn,.menu-btn{ border-color:rgba(255,255,255,.18); background:var(--op-navy-3); color:rgba(226,233,240,.82); border-radius:6px; }
.account-sync-btn:hover:not(:disabled),.refresh-btn:hover:not(:disabled){
  border-color:var(--op-orange); color:var(--op-orange); background:rgba(255,153,0,.14);
}
.menu-btn:hover{ border-color:rgba(255,255,255,.32); }
.account-sync-btn:focus-visible,.refresh-btn:focus-visible,.menu-btn:focus-visible{ outline:2px solid var(--op-orange); outline-offset:1px; }
.live-dot{ background:var(--op-green); box-shadow:0 0 0 3px rgba(11,125,90,.4); }
.live-dot.idle{ background:rgba(226,233,240,.5); box-shadow:0 0 0 3px rgba(255,255,255,.08); }
/* Account view / Brand view segmented control on the navy bar: white active button, light idle. */
.topbar .segmented{ background:rgba(0,0,0,.28); border:1px solid rgba(255,255,255,.14); box-shadow:none; border-radius:6px; }
.topbar .segmented button{ color:rgba(226,233,240,.74); font-weight:750; }
.topbar .segmented button:hover:not(.active){ color:#FFFFFF; background:rgba(255,255,255,.08); }
.topbar .segmented button.active{ color:var(--op-navy); background:#FFFFFF; box-shadow:none; }
.topbar .segmented button:focus-visible{ outline:2px solid var(--op-orange); outline-offset:1px; }

/* ---------------- DASHBOARD WORKSPACE (scoped, premium neutral ground) ------- */
/* Flat cool-neutral workspace (Stitch #F3F4F5); the decorative water layer is
   not rendered on the Sales Dashboard, per the approved flat design. */
.main-area.dash-workspace{ position:relative; background:#F3F4F5; }
.container.dashboard-page{
  position:relative; z-index:1; max-width:1760px;
  padding:24px clamp(24px, 3.2vw, 56px) 0;
}
.dashboard-page .page-head{ align-items:flex-end; }
.dashboard-page .page-title{ color:var(--op-ink); font-size:23px; font-weight:800; letter-spacing:0; }
.dashboard-page .page-sub{ color:var(--op-ink-2); font-size:12.5px; }

/* Water/ripple background layer — DISABLED for the approved flat redesign. The
   Sales Dashboard workspace is genuinely flat #F3F4F5 (set on .main-area.dash-workspace);
   this hides the decorative layer AND its WebGL canvas so no ripple, radial gradient,
   blue haze or atmospheric wash is painted. The WaterBackground component stays mounted
   (transition-stability regressions hold) but, being display:none, its intersection
   observer keeps the render loop paused, so no GL frame is ever drawn. .water-bg is only
   rendered on the account Sales Dashboard, so this is scoped to that page. */
.water-bg{ display:none; }
.water-bg-canvas{ position:absolute; inset:0; width:100%; height:100%; display:block; }

/* Date range bar + segmented (dashboard scope only). */
.dashboard-page .segmented{ background:#EDEEF0; border:1px solid var(--op-border); box-shadow:none; border-radius:6px; padding:3px; }
.dashboard-page .segmented button{ color:var(--op-ink-2); font-weight:750; border-radius:4px; }
.dashboard-page .segmented button:hover:not(.active){ color:var(--op-ink); background:rgba(255,255,255,.8); }
.dashboard-page .segmented button.active{ color:#FFFFFF; background:var(--op-navy); box-shadow:none; }
.dashboard-page .segmented button:focus-visible{ outline:2px solid var(--op-orange); outline-offset:1px; }
.dashboard-page .range-readout{ color:var(--op-ink-2); font-weight:700; border:1px solid var(--op-border); border-radius:6px; background:#FFFFFF; }
.dashboard-page .range-readout svg{ color:var(--op-ink-4); }
.dashboard-page .custom-range input[type=date]{ border:1px solid var(--op-border); border-radius:6px; color:var(--op-ink); background:#FFFFFF; }

/* Data-quality alerts — quiet, compact, strong-then-soft (nothing dominates). */
.dashboard-page .alert{ margin-top:12px; padding:9px 13px; gap:10px; border-radius:6px; align-items:flex-start; font-size:12px; }
.dashboard-page .alert-icon{ margin-top:1px; opacity:.85; }
.dashboard-page .alert-title{ font-size:12.5px; font-weight:750; letter-spacing:0; }
.dashboard-page .alert-detail{ margin-top:2px; font-size:11.5px; line-height:1.55; opacity:.82; }
.dashboard-page .alert.info{ background:#EFF5FA; border-color:#CFE0EE; color:#1B4E76; }
.dashboard-page .alert.warning{ background:#FBF5E7; border-color:#E7D19A; color:var(--op-warn-ink); }
.dashboard-page .alert.error{ background:var(--op-red-soft); border-color:var(--op-red-border); color:#8A2D17; }
.dashboard-page .alert a,.dashboard-page .alert button{ font-weight:700; }

/* Observed-unit breakdown — quiet premium surface. */
.dashboard-page .obs-units{ border:1px solid var(--op-border-2); border-radius:6px; background:#FBFCFD; box-shadow:none; margin-top:0; }
.dashboard-page .obs-units-title{ color:var(--op-ink); }
.dashboard-page .obs-units-total,.dashboard-page .obs-units-note{ color:var(--op-ink-3); }

/* KPI + comparison cards — pearl white, thin border, 8px radius, controlled depth. */
.dashboard-page .metric-grid{ gap:16px; margin-top:18px; }
.dashboard-page .cmp-grid{ gap:14px; margin-top:14px; }
/* Flat white cards, 1px #D5D9D9-family border, 6px radius, NO atmospheric shadow.
   Elevation is functional only: a hairline lift on hover, never a drop shadow. */
.dashboard-page .metric-card,
.dashboard-page .cmp-card{
  background:var(--op-card); border:1px solid var(--op-border); border-radius:6px;
  box-shadow:none;
  transition:box-shadow var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
}
.dashboard-page .metric-card{ padding:15px 16px 14px; }
.dashboard-page .metric-card:hover{ border-color:#C3CACE; box-shadow:0 1px 3px rgba(0,0,0,.08); }
.dashboard-page .cmp-card{ padding:12px 14px; }
.dashboard-page .cmp-card:hover{ border-color:#C3CACE; box-shadow:0 1px 3px rgba(0,0,0,.08); }
.dashboard-page .metric-label,.dashboard-page .cmp-label{ color:var(--op-ink-2); font-size:10.5px; font-weight:800; letter-spacing:.05em; }
.dashboard-page .metric-value{ color:var(--op-ink); font-size:25px; letter-spacing:0; margin-top:11px; }
.dashboard-page .metric-period,.dashboard-page .cmp-basis{ color:var(--op-ink-4); }
.dashboard-page .metric-icon{ width:30px; height:30px; border-radius:6px; color:var(--op-ink-2); background:#EEF1F3; }
.dashboard-page .metric-card:nth-child(2) .metric-icon{ color:var(--op-green); background:#E9F6EF; }
.dashboard-page .metric-card:nth-child(3) .metric-icon{ color:var(--op-blue); background:var(--op-blue-soft); }
.dashboard-page .metric-card:nth-child(4) .metric-icon{ color:var(--op-orange-dark); background:#FDF1DE; }
/* Total Sales HERO — the primary KPI: flat white card, larger figure, a fine blue top keyline. */
.dashboard-page .metric-card.hero{
  background:var(--op-card); border:1px solid var(--op-border);
  color:var(--op-ink); box-shadow:inset 0 2px 0 0 var(--op-blue);
}
.dashboard-page .metric-card.hero:hover{ border-color:#C3CACE; box-shadow:0 1px 3px rgba(0,0,0,.08), inset 0 2px 0 0 var(--op-blue); }
.dashboard-page .metric-card.hero::after{ display:none; }
.dashboard-page .metric-card.hero .metric-label{ color:var(--op-blue); }
.dashboard-page .metric-card.hero .metric-period,
.dashboard-page .metric-card.hero .metric-hint{ color:var(--op-ink-4); }
.dashboard-page .metric-card.hero .metric-value{ color:var(--op-ink); font-size:31px; }
.dashboard-page .metric-card.hero .metric-spark path:first-child{ fill:var(--op-blue); fill-opacity:.14; stroke:none; }
.dashboard-page .metric-card.hero .metric-spark path:nth-child(2){ fill:none; stroke:var(--op-blue); }
.dashboard-page .metric-card.hero .metric-spark circle{ fill:var(--op-blue); }
/* Trend pills + comparison values: emerald up / coral down (icon always present). */
.dashboard-page .trend{ font-weight:750; }
.dashboard-page .trend.up,.dashboard-page .metric-card.hero .trend.up{ color:var(--op-green); background:var(--op-green-soft); border-color:var(--op-green-border); }
.dashboard-page .trend.down,.dashboard-page .metric-card.hero .trend.down{ color:var(--op-red); background:var(--op-red-soft); border-color:var(--op-red-border); }
.dashboard-page .cmp-value.up{ color:var(--op-green); }
.dashboard-page .cmp-value.down{ color:var(--op-red); }

/* Chart + breakdown surfaces — controlled depth. */
.dashboard-page .chart-card,
.dashboard-page .panel{ background:var(--op-card); border:1px solid var(--op-border); border-radius:6px; box-shadow:none; }
.dashboard-page .chart-card{ margin-top:18px; }
.dashboard-page .chart-card-head{ border-bottom-color:var(--op-hair); padding:15px 18px 12px; }
.dashboard-page .chart-card-title,.dashboard-page .panel-title{ color:var(--op-ink); font-size:14.5px; font-weight:800; }
.dashboard-page .chart-card-sub{ color:var(--op-ink-3); }
.dashboard-page .chart-tip{ border:1px solid var(--op-border); border-radius:6px; box-shadow:0 2px 5px rgba(15,23,32,.15); }
.dashboard-page .chart-tip-label{ color:var(--op-ink); }
.dashboard-page .chart-tip-row{ color:var(--op-ink-2); }
.dashboard-page .bd-bar{ background:#EDF0F2; }
.dashboard-page .bd-fill{ background:#C7D6E4; }
.dashboard-page .bd-row.active .bd-fill{ background:var(--op-blue); box-shadow:none; }
.dashboard-page .bd-row.active .bd-name{ color:var(--op-blue-link); }
.dashboard-page .bd-value{ color:var(--op-ink); }
.dashboard-page .bd-share{ color:var(--op-ink-4); }
.dashboard-page .breakdown-grid{ gap:16px; margin-top:16px; }

/* Formula / source note — readable, present, not shouting. */
.dashboard-page .footer-note{ margin-top:28px; padding:16px 2px 8px; font-size:11.5px; line-height:1.7; color:var(--op-ink-2); border-top:1px solid var(--op-border-2); }
.dashboard-page .footer-note code{ color:var(--op-ink); background:#EEF1F3; border-radius:5px; }
.dashboard-page .footer-note strong{ color:var(--op-ink); }

/* ---- Consolidated data-status banner: ONE compact banner with a 4px left accent.
   Facts wrap (never truncate); a View details toggle reveals the unit breakdown. ---- */
.dashboard-page .data-status{
  display:flex; align-items:flex-start; gap:10px; margin-top:12px;
  border:1px solid var(--op-border); border-left-width:4px; border-radius:6px;
  padding:9px 13px; background:var(--op-card); font-size:12px; line-height:1.5;
}
.dashboard-page .data-status.warning{ background:#FBF5E7; border-color:#E7D19A; border-left-color:var(--op-orange-dark); color:var(--op-warn-ink); }
.dashboard-page .data-status.error{ background:var(--op-red-soft); border-color:var(--op-red-border); border-left-color:var(--op-red); color:#8A2D17; }
.dashboard-page .data-status.final{ background:#F1F7F4; border-color:var(--op-green-border); border-left-color:var(--op-green); color:var(--op-green); }
.dashboard-page .ds-icon{ flex:none; margin-top:1px; opacity:.9; }
.dashboard-page .ds-body{ min-width:0; flex:1; }
.dashboard-page .ds-head{ display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.dashboard-page .ds-title{ font-weight:750; color:var(--op-ink); }
.dashboard-page .ds-badge{ font-size:10px; font-weight:800; letter-spacing:.02em; padding:2px 7px; border-radius:3px; border:1px solid currentColor; background:rgba(255,255,255,.55); }
.dashboard-page .ds-toggle{ margin-left:auto; border:none; background:none; padding:0; font:700 12px inherit; color:var(--op-blue-link); cursor:pointer; }
.dashboard-page .ds-toggle:hover{ text-decoration:underline; }
.dashboard-page .ds-toggle:focus-visible{ outline:2px solid var(--op-blue); outline-offset:2px; border-radius:3px; }
.dashboard-page .ds-facts{ display:flex; flex-wrap:wrap; gap:3px 16px; margin-top:5px; color:var(--op-ink-2); }
.dashboard-page .ds-fact{ min-width:0; }
.dashboard-page .ds-fact-label{ font-weight:700; color:var(--op-ink); }
.dashboard-page .ds-details{ margin-top:8px; }
.dashboard-page .ds-notice{ font-size:11.5px; color:var(--op-ink-3); line-height:1.55; margin-bottom:6px; }

/* ---- Small "Provisional" indicator on KPI + comparison cards (amber, functional). ---- */
.dashboard-page .prov-badge{
  display:inline-flex; align-items:center; font-size:9.5px; font-weight:800; letter-spacing:.02em;
  padding:2px 6px; border-radius:3px; white-space:nowrap;
  color:var(--op-warn-ink); background:#FBF3E2; border:1px solid var(--op-warn-border);
}
.dashboard-page .metric-label-row{ display:flex; align-items:center; gap:7px; min-width:0; }
.dashboard-page .cmp-label-row{ display:flex; align-items:center; gap:7px; min-width:0; }
.dashboard-page .cmp-label-row .cmp-label{ min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

/* ---- Data methodology & currency policy — compact expandable disclosure. ---- */
.dashboard-page .methodology-disclosure{ margin-top:24px; border-top:1px solid var(--op-border-2); padding-top:12px; }
.dashboard-page .methodology-disclosure > summary{
  cursor:pointer; list-style:none; font-size:12px; font-weight:750; color:var(--op-ink-2);
  display:inline-flex; align-items:center; gap:7px; padding:2px 0;
}
.dashboard-page .methodology-disclosure > summary::-webkit-details-marker{ display:none; }
.dashboard-page .methodology-disclosure > summary::before{ content:'\\25B8'; color:var(--op-ink-4); font-size:11px; transition:transform var(--t-fast) var(--ease); }
.dashboard-page .methodology-disclosure[open] > summary::before{ transform:rotate(90deg); }
.dashboard-page .methodology-disclosure > summary:hover{ color:var(--op-ink); }
.dashboard-page .methodology-disclosure > summary:focus-visible{ outline:2px solid var(--op-blue); outline-offset:2px; border-radius:3px; }
.dashboard-page .methodology-disclosure .footer-note{ margin-top:0; padding-top:8px; border-top:none; }

/* Ultra-wide: keep the workspace generous, never a narrow island; single-account
   "Sales by Account" yields width to "Sales by Brand" instead of an empty card. */
@media (min-width:901px){
  /* One account -> the "Sales by Account" card yields width to "Sales by Brand"
     and shrinks to its own content (align-items:start) rather than stretching
     into a large empty card. */
  .dashboard-page .breakdown-grid.single-account{ grid-template-columns:minmax(0,0.82fr) minmax(0,1.18fr); align-items:start; }
}
@media (min-width:1600px){
  .container.dashboard-page{ padding-left:clamp(40px,3.4vw,72px); padding-right:clamp(40px,3.4vw,72px); }
  .dashboard-page .metric-grid{ gap:18px; }
}
@media (max-width:640px){
  .container.dashboard-page{ padding:18px 16px 0; }
  .dashboard-page .metric-value{ font-size:23px; }
  .dashboard-page .metric-card.hero .metric-value{ font-size:26px; }
}

/* ---------------- MOTION — premium, subtle, reduced-motion aware --------- */
@media (prefers-reduced-motion: no-preference){
  .dashboard-page .page-head,
  .dashboard-page .controls-bar,
  .dashboard-page .metric-grid > *,
  .dashboard-page .cmp-grid > *,
  .dashboard-page .chart-card,
  .dashboard-page .breakdown-grid > *{ animation:dashRise .42s var(--ease) both; }
  .dashboard-page .metric-grid > *:nth-child(2){ animation-delay:.05s; }
  .dashboard-page .metric-grid > *:nth-child(3){ animation-delay:.10s; }
  .dashboard-page .metric-grid > *:nth-child(4){ animation-delay:.15s; }
  .dashboard-page .cmp-grid > *{ animation-delay:.08s; }
  .dashboard-page .cmp-grid > *:nth-child(2){ animation-delay:.12s; }
  .dashboard-page .cmp-grid > *:nth-child(3){ animation-delay:.16s; }
  .dashboard-page .cmp-grid > *:nth-child(4){ animation-delay:.20s; }
  .dashboard-page .chart-card{ animation-delay:.14s; }
  .dashboard-page .breakdown-grid > *{ animation-delay:.18s; }
  .dashboard-page .metric-value{ animation:kpiReveal .5s var(--ease) both; }
}
@keyframes dashRise{ from{ opacity:0; transform:translateY(9px); } to{ opacity:1; transform:none; } }
@keyframes kpiReveal{ from{ opacity:0; transform:translateY(4px); } to{ opacity:1; transform:none; } }
@media (prefers-reduced-motion: reduce){
  .water-bg{ background:#F3F4F5; }
}

/* ========================================================================
   PREMIUM REPORT LAYER (.op-report) — the five redesigned reports
   ------------------------------------------------------------------------
   Scoped ENTIRELY under \`.op-report\`, a class added ONLY to Brand View, Daily
   Reporting, Returns & Refund Leakage, FBA Shipment Plan and SKU Movement, so
   these rules can NEVER leak into any other report (several of which share
   .panel / .data-table / .skupl-page). Re-skins the SHARED primitives to the
   Amazon-inspired operational system used by the Sales Dashboard (pearl
   surfaces, cool-neutral workspace, deep-navy table headers, steel-blue accents,
   emerald/coral semantics, 8px radius, tabular numerals). Presentation only.
   ======================================================================== */

/* Cool-neutral workspace + a subtle, STATIC atmosphere painted as a background
   gradient DIRECTLY on .main-area (no pseudo-element, no positioning) so it can
   never affect layout width or a flex scroll container's shrink -- and never
   sits above the content (the pearl cards are opaque and cover it; it only shows
   in the open gutters, never behind a table). Added to .main-area for these
   views only, so no other report's workspace is affected. */
.main-area.op-workspace{
  background:
    radial-gradient(1200px 620px at 84% -6%, rgba(94,156,214,.14), transparent 60%),
    radial-gradient(900px 520px at 0% 106%, rgba(28,84,146,.08), transparent 58%),
    var(--op-bg);
  background-attachment:fixed, fixed, scroll;
}

/* Titles / sub / footer. */
.op-report .page-title{ color:var(--op-ink); letter-spacing:-.01em; }
.op-report .page-sub{ color:var(--op-ink-2); }
.op-report .section-label{ color:var(--op-ink-3); }
.op-report .footer-note{ color:var(--op-ink-2); border-top-color:var(--op-border-2); font-size:11.5px; line-height:1.7; }
.op-report .footer-note code{ color:var(--op-ink); background:#EEF1F3; }
.op-report .footer-note strong{ color:var(--op-ink); }

/* Surfaces: pearl white, thin op border, 8px, controlled shadow. */
.op-report .panel,
.op-report .chart-card{
  background:var(--op-card); border:1px solid var(--op-border); border-radius:8px;
  box-shadow:0 1px 2px rgba(15,17,17,.05), 0 12px 30px -22px rgba(15,23,32,.30);
}
.op-report .panel-title,.op-report .chart-card-title{ color:var(--op-ink); font-weight:800; }
.op-report .chart-card-head{ border-bottom-color:var(--op-hair); background:none; }
.op-report .chart-card-sub{ color:var(--op-ink-3); }

/* Controls: op borders, steel-blue active, amber focus. */
.op-report .segmented,.op-report .seg,.op-report .report-tabs{ background:#EEF1F3; border:1px solid var(--op-border); box-shadow:inset 0 1px 2px rgba(15,17,17,.03); border-radius:9px; }
.op-report .segmented button,.op-report .seg button,.op-report .report-tabs button{ color:var(--op-ink-2); font-weight:750; }
.op-report .segmented button:hover:not(.active),.op-report .seg button:hover:not(.active),.op-report .report-tabs button:hover:not(.active){ color:var(--op-ink); background:rgba(255,255,255,.75); }
.op-report .segmented button.active,.op-report .seg button.active,.op-report .report-tabs button.active{ color:var(--op-steel); background:#FFFFFF; box-shadow:0 1px 3px rgba(15,17,17,.12); }
.op-report .segmented button:focus-visible,.op-report .seg button:focus-visible,.op-report .report-tabs button:focus-visible{ outline:2px solid var(--op-orange); outline-offset:1px; }
.op-report .chip{ border:1px solid var(--op-border); background:#fff; color:var(--op-ink-2); }
.op-report .chip:hover{ border-color:#B9C0C5; color:var(--op-ink); }
.op-report .chip.active{ border-color:var(--op-steel); background:#E9F1F8; color:var(--op-steel); }
.op-report .plan-export-btn,.op-report .plan-tool-btn{ border-radius:8px; }

/* Notices / freshness / observed-units: quiet premium. */
.op-report .alert{ border-radius:9px; }
.op-report .alert.info{ background:#EFF5FA; border-color:#CFE0EE; color:#1B4E76; }
.op-report .alert.warning{ background:#FBF5E7; border-color:#E7D19A; color:var(--op-warn-ink); }
.op-report .alert.error{ background:var(--op-red-soft); border-color:var(--op-red-border); color:#8A2D17; }
.op-report .recon-freshness,.op-report .plan-freshness{ background:#FBFCFD; border:1px solid var(--op-border-2); color:var(--op-ink-3); border-radius:9px; }
.op-report .recon-freshness strong,.op-report .plan-freshness strong{ color:var(--op-ink); }
.op-report .obs-units{ border:1px solid var(--op-border-2); border-radius:10px; background:#FBFCFD; }
.op-report .obs-units-title{ color:var(--op-ink); }
.op-report .obs-units-total,.op-report .obs-units-note{ color:var(--op-ink-3); }

/* Generic KPI surfaces (metric/plan/recon/skupl) -> pearl premium. */
.op-report .metric-card,.op-report .cmp-card,.op-report .plan-stat,.op-report .recon-kpi,.op-report .skupl-kpi{ background:var(--op-card); border:1px solid var(--op-border); border-radius:8px; box-shadow:0 1px 2px rgba(15,17,17,.05); }
.op-report .metric-card:hover,.op-report .plan-stat:hover,.op-report .recon-kpi:hover,.op-report .skupl-kpi:hover{ border-color:#C3CACE; box-shadow:0 10px 26px -12px rgba(15,23,32,.28); }
.op-report .plan-stat-label,.op-report .recon-kpi-label,.op-report .skupl-kpi-label,.op-report .metric-label,.op-report .cmp-label{ color:var(--op-ink-2); }
.op-report .plan-stat-value,.op-report .recon-kpi-value,.op-report .skupl-kpi-value,.op-report .metric-value{ color:var(--op-ink); }

/* Tables: deep-navy sticky header, op borders, tabular, calm hover, sticky id. */
.op-report .data-table thead th,
.op-report .plan-table thead th,
.op-report .daily-table thead th,
.op-report .bv-table th{
  background:var(--op-navy); color:rgba(233,238,242,.82);
  border-bottom:1px solid rgba(0,0,0,.20); text-transform:uppercase; letter-spacing:.06em;
}
.op-report .bv-table th.bv-first{ color:#FFFFFF; }
.op-report .plan-table thead th.pt-id,.op-report .daily-table thead th.dt-metric{ color:#FFFFFF; }
.op-report .data-table td,.op-report .plan-table td,.op-report .daily-table td,.op-report .bv-table td{ border-color:var(--op-hair); color:var(--op-ink); }
.op-report .bv-table td.bv-first{ color:var(--op-ink); }
.op-report .plan-table td.pt-id{ background:var(--op-card); }
.op-report .data-table tbody tr:hover td,.op-report .plan-table tbody tr:hover td,.op-report .bv-table tbody tr:hover td{ background:#F3F6F8; }
.op-report .plan-table tbody tr:hover td.pt-id{ background:#EEF2F5; }

/* Badges + trend -> op semantics (emerald / coral / amber / steel). */
.op-report .status-badge.good,.op-report .pt-badge.plan-prio-ok{ background:var(--op-green-soft); color:var(--op-green); border-color:var(--op-green-border); }
.op-report .status-badge.bad,.op-report .pt-badge.plan-prio-critical{ background:var(--op-red-soft); color:var(--op-red); border-color:var(--op-red-border); }
.op-report .status-badge.warn,.op-report .pt-badge.plan-prio-high{ background:var(--op-warn-soft); color:var(--op-warn-ink); border-color:var(--op-warn-border); }
.op-report .pt-badge.plan-prio-medium{ background:#E9F1F8; color:var(--op-steel); border-color:#CFE0EE; }
.op-report .trend.up,.op-report .cmp-value.up,.op-report .sku-pos{ color:var(--op-green); }
.op-report .trend.down,.op-report .cmp-value.down,.op-report .sku-neg{ color:var(--op-red); }
.op-report .cell-share{ color:var(--op-ink-3); }

/* ---- BRAND VIEW (.bv-page) ---------------------------------------------- */
.op-report .bv-select{ border-color:var(--op-border); border-radius:8px; color:var(--op-ink); }
.op-report .bv-select:hover:not(:disabled){ border-color:#B9C0C5; }
.op-report .bv-field-label{ color:var(--op-ink-3); }
.op-report .bv-menu{ border-color:var(--op-border); border-radius:9px; }
.op-report .bv-menu button:hover{ background:#E9F1F8; color:var(--op-steel); }
/* KPI tiles: neutralise the inline gradient (rvkpi) -> pearl + restrained key. */
.op-report .rvkpi{ background:var(--op-card)!important; color:var(--op-ink)!important; border:1px solid var(--op-border); border-radius:8px; box-shadow:0 1px 2px rgba(15,17,17,.05); }
.op-report .rvkpi-label,.op-report .rvkpi-sub{ color:var(--op-ink-3)!important; }
.op-report .rvkpi-value{ color:var(--op-ink)!important; }
.op-report .rvkpi-hint button,.op-report .rvkpi-hint svg{ color:var(--op-ink-3)!important; }
.op-report .rvkpi-pos{ color:var(--op-green)!important; } .op-report .rvkpi-neg{ color:var(--op-red)!important; }
.op-report .bv-kpis .rvkpi:nth-child(1){ box-shadow:0 1px 2px rgba(15,17,17,.05), inset 0 2px 0 0 var(--dash-primary); }
.op-report .bv-kpis .rvkpi:nth-child(2){ box-shadow:0 1px 2px rgba(15,17,17,.05), inset 0 2px 0 0 var(--op-steel-2); }
.op-report .bv-kpis .rvkpi:nth-child(3){ box-shadow:0 1px 2px rgba(15,17,17,.05), inset 0 2px 0 0 var(--op-green); }
.op-report .bv-kpis .rvkpi:nth-child(4){ box-shadow:0 1px 2px rgba(15,17,17,.05), inset 0 2px 0 0 var(--op-orange-dark); }
/* bv-table column accents -> op palette; totals/bands/sections premium. */
.op-report .bv-table .bv-col-positive{ color:var(--op-green); }
.op-report .bv-table th.bv-col-positive{ color:#9FE3C4; }
.op-report .bv-table .bv-col-accent{ color:var(--op-steel); }
.op-report .bv-table th.bv-col-accent{ color:#BBD6EE; }
.op-report .bv-table .bv-col-latest,.op-report .bv-table .bv-col-total{ background:#EAF1F8; color:var(--op-ink); }
.op-report .bv-table th.bv-col-latest,.op-report .bv-table th.bv-col-total{ color:#FFD9A6; box-shadow:inset 0 -2px 0 var(--op-orange); }
.op-report .bv-table tbody tr:hover td.bv-col-latest,.op-report .bv-table tbody tr:hover td.bv-col-total{ background:#DEEAF5; }
.op-report .bv-table .bv-total td{ background:#F1F4F6; }
.op-report .bv-table .bv-total td.bv-first{ background:#EAF1F8; color:var(--op-steel); }
.op-report .bv-table .bv-total .cell-share{ color:var(--op-steel); }
.op-report .bv-table .bv-band td{ background:#F6F8FA; color:var(--op-ink-2); }
.op-report .bv-table .bv-section td{ color:var(--op-ink-3); }

/* ---- DAILY REPORTING (.dr-page) ---------------------------------------- */
/* Daily Reporting is fully styled by the flat Amazon .dr-page block above. The former
   .op-report .dr-* overrides (deep-navy table header, pearl KPI keylines, gradient card
   head) are intentionally removed. Only the SHARED .dr-dash em-dash colour is kept here
   -- it is reused by the FBA Plan and SKU Movement tables. */
.op-report .dr-dash{ color:var(--op-ink-4); }

/* ---- RETURNS & REFUND LEAKAGE (.rl-page) ------------------------------- */
.op-report .recon-notice{ background:#EFF5FA; border:1px solid #CFE0EE; color:#1B4E76; border-radius:9px; padding:10px 13px; }
/* 6-KPI risk hierarchy: recoverable leakage (4th) + net impact carry the risk amber/coral keys. */
.op-report .rvkpi-grid-6 .rvkpi:nth-child(1){ box-shadow:0 1px 2px rgba(15,17,17,.05), inset 0 2px 0 0 var(--dash-primary); }
.op-report .rvkpi-grid-6 .rvkpi:nth-child(2){ box-shadow:0 1px 2px rgba(15,17,17,.05), inset 0 2px 0 0 var(--op-steel-2); }
.op-report .rvkpi-grid-6 .rvkpi:nth-child(3){ box-shadow:0 1px 2px rgba(15,17,17,.05), inset 0 2px 0 0 var(--op-red); }
.op-report .rvkpi-grid-6 .rvkpi:nth-child(4){ box-shadow:0 1px 2px rgba(15,17,17,.05), inset 0 2px 0 0 var(--op-orange); }
.op-report .rvkpi-grid-6 .rvkpi:nth-child(5){ box-shadow:0 1px 2px rgba(15,17,17,.05), inset 0 2px 0 0 var(--op-orange-dark); }
.op-report .rvkpi-grid-6 .rvkpi:nth-child(6){ box-shadow:0 1px 2px rgba(15,17,17,.05), inset 0 2px 0 0 var(--op-red); }
.op-report .rl-prov{ color:var(--op-ink-2); }
.op-report .pt-badge.sku-badge-ok{ background:var(--op-green-soft); color:var(--op-green); border-color:var(--op-green-border); }
.op-report .pt-badge.sku-badge-warn{ background:var(--op-warn-soft); color:var(--op-warn-ink); border-color:var(--op-warn-border); }
.op-report .pt-badge.sku-badge-bad{ background:var(--op-red-soft); color:var(--op-red); border-color:var(--op-red-border); }
.op-report .rl-table th.pt-sorted{ color:#BBD6EE; }
.op-report .rl-seg-title{ color:var(--op-ink); }
.op-report .rl-seg-sub,.op-report .rl-seg-share{ color:var(--op-ink-3); }
.op-report .rl-seg-val{ color:var(--op-ink); }
.op-report .rl-seg-key{ color:var(--op-ink-2); }
.op-report .rl-seg-bar{ background:#EDF0F2; }
.op-report .rl-drill-cell{ background:#F6F8FA; }
.op-report .rl-drill h4{ color:var(--op-ink-3); }
.op-report .rl-dl-row span{ color:var(--op-ink-2); }
.op-report .rl-dl-row b{ color:var(--op-ink); }
.op-report .rl-fresh-row{ border-bottom-color:var(--op-hair); }
.op-report .rl-fresh-row span{ color:var(--op-ink-3); }
.op-report .rl-fresh-row b{ color:var(--op-ink); }
.op-report .rl-expand-btn:hover{ color:var(--op-steel); }

/* ---- FBA SHIPMENT PLAN (.plan-page) ------------------------------------ */
/* Grouped header band (Identity / Sales / Forecast / Inventory / ...). Not sticky
   vertically (the sortable row below stays pinned); its identity cell is sticky
   left so it tracks the sticky identity column on horizontal scroll. */
.op-report .plan-table .plan-group-row th{ background:var(--op-navy-2); color:rgba(233,238,242,.62); font-size:9px; font-weight:800; letter-spacing:.1em; text-transform:uppercase; text-align:center; padding:6px 10px; border-bottom:1px solid rgba(0,0,0,.28); }
.op-report .plan-table .plan-group-th + .plan-group-th{ box-shadow:inset 1px 0 0 rgba(255,255,255,.07); }
.op-report .plan-table .plan-group-th.plan-group-id{ position:sticky; left:0; z-index:2; background:var(--op-navy-2); text-align:left; }
/* Planning settings + controls -> op surfaces, steel active, amber-hover tools. */
.op-report .plan-settings{ background:#FBFCFD; border-color:var(--op-border-2); border-radius:10px; }
.op-report .plan-field-label{ color:var(--op-ink-3); }
.op-report .plan-set-group select,.op-report .plan-set-group input[type=number],.op-report .plan-field select,.op-report .plan-field input[type=number]{ border-color:var(--op-border); border-radius:8px; color:var(--op-ink); }
.op-report .plan-seg-btn{ border-color:var(--op-border); background:#fff; color:var(--op-ink-2); border-radius:8px; }
.op-report .plan-seg-btn.active{ background:var(--op-steel); border-color:transparent; color:#fff; }
.op-report .plan-seg-custom.active{ border-color:var(--op-steel); box-shadow:inset 0 0 0 1px #CFE0EE; }
.op-report .plan-search-wrap{ border-color:var(--op-border); border-radius:8px; }
.op-report .plan-search-wrap:focus-within{ border-color:var(--op-orange); box-shadow:0 0 0 3px rgba(255,153,0,.16); }
.op-report .plan-export-btn:hover:not(:disabled),.op-report .plan-tool-btn:hover:not(:disabled){ border-color:var(--op-orange); color:var(--op-orange-dark); background:var(--op-orange-soft); }
.op-report .plan-wh-btn:hover{ border-color:var(--op-steel); color:var(--op-steel); background:#E9F1F8; }
.op-report .plan-cols-pop{ border-color:var(--op-border); border-radius:10px; }
.op-report .plan-cols-group-title{ color:var(--op-ink-3); }
/* Restock highlight -> amber (was coral brand); totals + identity metadata op. */
.op-report .plan-table tr.plan-restock td{ background:var(--op-warn-soft); }
.op-report .plan-table tr.plan-restock td.pt-id{ background:#FBF0DA; box-shadow:inset 3px 0 0 var(--op-orange); }
.op-report .plan-table tr.plan-restock:hover td{ background:#F8EDD6; }
.op-report .plan-table tfoot td{ background:#EEF1F3; border-top-color:var(--op-border); }
.op-report .plan-table tfoot td.pt-id{ background:#EEF1F3; }
.op-report .plan-table tr.plan-wh-only td{ background:#FBFCFD; }
.op-report .pt-name{ color:var(--op-ink); }
.op-report .pt-meta{ color:var(--op-ink-3); }
.op-report .pt-brand{ color:var(--op-steel); }
.op-report .plan-table td.pt-strong{ color:var(--op-ink); }

/* ===== FBA SHIPMENT PLAN -- flat Amazon operational workspace (.plan-page) =====
   Approved Stitch redesign. White panels on the neutral workspace, #D5D9D9 hairlines, <=6px radii, semantic
   accents (blue #146EB4, orange #FF9900, green #067D62), tabular numerals -- no gradients, no violet, no glass.
   Every selector is scoped under .plan-page so the SHARED plan and pt class families (SKU P&L, SKU Movement,
   Reconciliation) stay untouched; these rules follow the .op-report layer above and win at equal specificity
   by source order. */
/* Header + right-side scope metadata panel (real account / marketplace / sales-date / inventory-state only). */
.plan-page .plan-head{ display:flex; align-items:flex-start; justify-content:space-between; gap:16px; flex-wrap:wrap; }
.plan-page .plan-head-main{ min-width:0; }
.plan-page .plan-meta{ display:flex; flex-wrap:wrap; align-items:stretch; background:#FFFFFF; border:1px solid #D5D9D9; border-radius:6px; overflow:hidden; }
.plan-page .plan-meta-item{ display:flex; flex-direction:column; gap:2px; padding:8px 14px; border-left:1px solid #E7E9EC; min-width:0; }
.plan-page .plan-meta-item:first-child{ border-left:0; }
.plan-page .plan-meta-k{ font-size:10px; font-weight:750; letter-spacing:.04em; text-transform:uppercase; color:#565959; }
.plan-page .plan-meta-v{ font-size:12.5px; font-weight:700; color:#0F1111; white-space:nowrap; font-variant-numeric:tabular-nums; }
.plan-page .plan-meta-badge{ align-self:flex-start; font-size:11px; font-weight:700; padding:1px 8px; border-radius:3px; }
.plan-page .plan-meta-badge.is-ok{ background:#F3F9F6; border:1px solid #CDE5D8; color:#067D62; }
.plan-page .plan-meta-badge.is-warn{ background:#FFF8E7; border:1px solid #F2C265; color:#B75D00; }

/* Planning parameters panel (wraps the existing settings bar + collapsible demand weighting). */
.plan-page .plan-params{ margin-top:var(--space-4); background:#FFFFFF; border:1px solid #D5D9D9; border-radius:6px; padding:12px 14px; }
.plan-page .plan-params-head{ margin-bottom:10px; }
.plan-page .plan-params-title{ font-size:11px; font-weight:800; letter-spacing:.06em; text-transform:uppercase; color:#565959; }
.plan-page .plan-params .plan-settings{ margin-top:0; padding:0; border:0; background:none; border-radius:0; }
.plan-page .plan-wdd-disclosure{ margin-top:10px; border-top:1px solid #E7E9EC; padding-top:10px; }
.plan-page .plan-wdd-disclosure > summary{ cursor:pointer; font-size:12px; font-weight:700; color:#0F1111; list-style:none; display:inline-flex; align-items:center; gap:6px; }
.plan-page .plan-wdd-disclosure > summary::-webkit-details-marker{ display:none; }
.plan-page .plan-wdd-disclosure > summary::before{ content:"\\25B8"; color:#565959; font-size:10px; transition:transform .15s ease; }
.plan-page .plan-wdd-disclosure[open] > summary::before{ transform:rotate(90deg); }
.plan-page .plan-wdd-disclosure .plan-settings{ margin-top:10px; }
.plan-page .plan-field-label{ color:#565959; }
.plan-page .plan-seg-btn{ border:1px solid #D5D9D9; background:#FFFFFF; color:#565959; border-radius:4px; font-weight:700; }
.plan-page .plan-seg-btn.active{ background:#146EB4; border-color:#146EB4; color:#FFFFFF; }
.plan-page .plan-seg-custom.active{ border-color:#146EB4; box-shadow:inset 0 0 0 1px #D2E4F2; }
.plan-page .plan-set-group select, .plan-page .plan-set-group input[type=number]{ border:1px solid #D5D9D9; border-radius:4px; color:#0F1111; }

/* Freshness row. */
.plan-page .plan-freshness{ background:#FFFFFF; border:1px solid #D5D9D9; border-radius:6px; color:#565959; }
.plan-page .plan-freshness strong{ color:#0F1111; }
/* Inventory-unavailable warning (amber, left accent) -- scoped so the shared .alert is untouched elsewhere. */
.plan-page .alert.warning{ background:#FFF8E7; border:1px solid #F2C265; border-left:4px solid #B75D00; color:#5F4300; border-radius:6px; }
.plan-page .alert.warning svg{ color:#B75D00; }

/* Six KPI cells -> flat white cards, 2px semantic top accent, supporting sub-text. */
.plan-page .plan-stat-row{ grid-template-columns:repeat(6,minmax(0,1fr)); }
.plan-page .plan-stat{ background:#FFFFFF; border:1px solid #D5D9D9; border-top:2px solid #C3CACE; border-radius:6px; box-shadow:none; padding:11px 13px; }
.plan-page .plan-stat:hover{ transform:none; box-shadow:0 1px 3px rgba(0,0,0,.08); border-color:#D5D9D9; }
.plan-page .plan-stat--blue{ border-top-color:#146EB4; }
.plan-page .plan-stat--amber{ border-top-color:#FF9900; }
.plan-page .plan-stat--neutral{ border-top-color:#C3CACE; }
.plan-page .plan-stat-label{ font-size:10.5px; font-weight:800; letter-spacing:.05em; text-transform:uppercase; color:#565959; }
.plan-page .plan-stat-value{ font-size:20px; font-weight:800; color:#0F1111; margin-top:4px; }
.plan-page .plan-stat-value.plan-stat-accent{ color:#146EB4; }
.plan-page .plan-stat-sub{ font-size:11px; color:#565959; margin-top:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

/* Toolbar -> flat; search grows, actions wrap to the right. */
.plan-page .plan-controls{ align-items:center; }
.plan-page .plan-search{ flex:1 1 240px; min-width:200px; }
.plan-page .plan-tool-btn{ height:36px; border:1px solid #D5D9D9; background:#FFFFFF; color:#0F1111; border-radius:4px; font-weight:600; }
.plan-page .plan-tool-btn:hover:not(:disabled){ border-color:#146EB4; color:#146EB4; background:#F7FAFD; }
.plan-page .plan-export-btn{ height:36px; }

/* The matrix: light neutral headers, semantic group bands, sticky headers + first column. */
.plan-page .panel{ box-shadow:none; }
.plan-page .plan-table{ min-width:1720px; }
.plan-page .plan-table .plan-group-row th{ background:#F3F4F5; color:#565959; font-size:10px; font-weight:800; letter-spacing:.04em; text-transform:uppercase; text-align:center; padding:6px 10px; border-bottom:1px solid #D5D9D9; border-right:1px solid #E7E9EC; position:sticky; top:0; z-index:4; box-shadow:none; }
.plan-page .plan-table .plan-group-th.plan-group-id{ position:sticky; left:0; z-index:6; background:#F3F4F5; text-align:left; color:#0F1111; }
/* Semantic group bands -- specificity raised (.plan-group-th.plan-group-*) so they win over .plan-group-row th. */
.plan-page .plan-table .plan-group-th.plan-group-sales{ background:#EAF2FB; color:#146EB4; box-shadow:inset 0 2px 0 #146EB4; }
.plan-page .plan-table .plan-group-th.plan-group-planning{ background:#FEF6E7; color:#B75D00; box-shadow:inset 0 2px 0 #FF9900; }
.plan-page .plan-table thead tr:last-child th{ background:#FAFAFA; color:#565959; font-size:11px; font-weight:800; letter-spacing:.03em; border-bottom:1px solid #D5D9D9; top:27px; z-index:3; }
.plan-page .plan-table thead tr:last-child th.pt-id{ background:#FAFAFA; color:#0F1111; z-index:5; }
.plan-page .plan-table thead tr:last-child th.pt-sorted{ color:#146EB4; }
.plan-page .plan-table th.pt-id, .plan-page .plan-table td.pt-id{ min-width:280px; max-width:300px; background:#FFFFFF; border-right:1px solid #D5D9D9; }
.plan-page .pt-name{ color:#0F1111; max-width:264px; }
.plan-page .pt-meta{ color:#565959; max-width:264px; }
.plan-page .pt-brand{ color:#146EB4; max-width:264px; }
.plan-page .plan-table td{ color:#0F1111; border-bottom:1px solid #E7E9EC; font-weight:500; }
.plan-page .plan-table tbody tr:hover td{ background:#F5F9FD; }
.plan-page .plan-table tbody tr:hover td.pt-id{ background:#F5F9FD; }
.plan-page .plan-table td.pt-strong{ color:#0F1111; font-weight:700; }
/* Current MTD + Target Units -> restrained blue; Recommended -> amber ONLY when a recommendation exists. */
.plan-page .plan-table td.pt-mtd{ background:#EFF6FB; font-weight:700; border-left:1px solid #D2E4F2; border-right:1px solid #D2E4F2; }
.plan-page .plan-table thead tr:last-child th.pt-mtd{ background:#EFF6FB; color:#0F1111; box-shadow:inset 0 2px 0 #146EB4; }
.plan-page .plan-table td.pt-target{ color:#146EB4; background:#EFF6FB; border-left:1px solid #D2E4F2; border-right:1px solid #D2E4F2; }
.plan-page .plan-table thead tr:last-child th.pt-target{ background:#EFF6FB; color:#146EB4; box-shadow:inset 0 2px 0 #146EB4; }
.plan-page .plan-table td.pt-reco{ color:#B75D00; }
.plan-page .plan-table tbody tr:hover td.pt-mtd,.plan-page .plan-table tbody tr:hover td.pt-target{ background:#E6F0F9; }
.plan-page .plan-table tr.plan-restock td{ background:#FFF8E7; }
.plan-page .plan-table tr.plan-restock td.pt-id{ background:#FDF3DE; box-shadow:inset 3px 0 0 #FF9900; }
.plan-page .plan-table tr.plan-restock:hover td{ background:#FBF1D9; }
/* Totals -> bold with a light blue-gray fill; MTD/Target totals blue. */
.plan-page .plan-table tfoot td{ background:#EEF1F3; color:#0F1111; font-weight:800; border-top:2px solid #D5D9D9; }
.plan-page .plan-table tfoot td.pt-id{ background:#EEF1F3; }
.plan-page .plan-table tfoot td.pt-mtd,.plan-page .plan-table tfoot td.pt-target{ background:#DEEAF5; color:#146EB4; font-weight:800; }

/* Methodology disclosure. */
.plan-page .plan-methodology{ margin-top:var(--space-4); background:#FFFFFF; border:1px solid #D5D9D9; border-radius:6px; padding:12px 14px; }
.plan-page .plan-methodology > summary{ cursor:pointer; font-size:12.5px; font-weight:750; color:#0F1111; list-style:none; display:inline-flex; align-items:center; gap:8px; }
.plan-page .plan-methodology > summary::-webkit-details-marker{ display:none; }
.plan-page .plan-methodology > summary::before{ content:"\\25B8"; color:#565959; font-size:10px; transition:transform .15s ease; }
.plan-page .plan-methodology[open] > summary::before{ transform:rotate(90deg); }
.plan-page .plan-methodology .footer-note{ margin-top:10px; border-top:1px solid #E7E9EC; padding-top:10px; border-radius:0; background:none; }

/* FBA modals (warehouse import / lead-time preview / SKU horizon) -> flat Amazon: <=6px radius, a functional
   Level-3 shadow (not the atmospheric 24px/70px blur), square 3px status badges (never pill), neutral chrome. */
.plan-page .plan-modal-backdrop{ background:rgba(19,26,34,.60); }
.plan-page .plan-modal{ border:1px solid #D5D9D9; border-radius:6px; box-shadow:0 4px 16px rgba(19,26,34,.20); }
.plan-page .plan-modal-head{ border-bottom:1px solid #D5D9D9; }
.plan-page .plan-modal-title{ color:#0F1111; }
.plan-page .plan-modal-sub, .plan-page .plan-modal-note, .plan-page .plan-modal-foot-note{ color:#565959; }
.plan-page .plan-modal-foot{ border-top:1px solid #D5D9D9; }
.plan-page .plan-icon-btn{ border:1px solid #D5D9D9; border-radius:4px; color:#565959; }
.plan-page .plan-icon-btn:hover{ border-color:#146EB4; color:#146EB4; background:#F7FAFD; }
.plan-page .plan-import-file{ border:1px dashed #D5D9D9; border-radius:4px; color:#565959; }
.plan-page .plan-import-file:hover{ border-color:#146EB4; color:#146EB4; }
.plan-page .plan-modal .plan-mini-btn{ border:1px solid #D5D9D9; border-radius:4px; color:#0F1111; }
.plan-page .plan-modal .plan-mini-btn:hover:not(:disabled){ border-color:#146EB4; color:#146EB4; }
.plan-page .plan-import-pill{ border-radius:3px; border:1px solid #D5D9D9; background:#F3F4F5; color:#565959; }
.plan-page .plan-import-pill.ok{ background:#F3F9F6; border-color:#CDE5D8; color:#067D62; }
.plan-page .plan-import-pill.bad{ background:#FDF4F4; border-color:#F5C2C7; color:#B12704; }
.plan-page .plan-import-table-wrap{ border:1px solid #D5D9D9; border-radius:6px; }
.plan-page .plan-import-table th{ background:#F8F9FA; color:#565959; border-bottom:1px solid #D5D9D9; }
.plan-page .plan-import-table td{ border-top:1px solid #E7E9EC; color:#0F1111; }
.plan-page .plan-import-table tr.bad td{ color:#B12704; }
.plan-page .plan-import-paste textarea{ border:1px solid #D5D9D9; border-radius:4px; }

/* Responsive: KPIs 6 -> 3 -> 2; the matrix always scrolls; the meta panel wraps full-width. */
@media (max-width:1280px){ .plan-page .plan-stat-row{ grid-template-columns:repeat(3,minmax(0,1fr)); } }
@media (max-width:820px){ .plan-page .plan-stat-row{ grid-template-columns:repeat(2,minmax(0,1fr)); } .plan-page .plan-meta{ width:100%; } }
@media (prefers-reduced-motion: reduce){ .plan-page .plan-methodology > summary::before,.plan-page .plan-wdd-disclosure > summary::before{ transition:none; } }

/* ---- SKU MOVEMENT (.sku-mv-page) --------------------------------------- */
/* Explicit deep-navy header for the sku-mv table (its own .sku-mv thead th
   gradient otherwise fights the shared plan-table rule at this grain). */
.op-report .sku-mv thead th{ background:var(--op-navy); color:rgba(233,238,242,.82); border-bottom:1px solid rgba(0,0,0,.20); }
.op-report .rvkpi-grid-5 .rvkpi:nth-child(1){ box-shadow:0 1px 2px rgba(15,17,17,.05), inset 0 2px 0 0 var(--dash-primary); }
.op-report .rvkpi-grid-5 .rvkpi:nth-child(2){ box-shadow:0 1px 2px rgba(15,17,17,.05), inset 0 2px 0 0 var(--op-orange-dark); }
.op-report .rvkpi-grid-5 .rvkpi:nth-child(3){ box-shadow:0 1px 2px rgba(15,17,17,.05), inset 0 2px 0 0 var(--op-steel-2); }
.op-report .rvkpi-grid-5 .rvkpi:nth-child(4){ box-shadow:0 1px 2px rgba(15,17,17,.05), inset 0 2px 0 0 var(--op-ink-4); }
.op-report .rvkpi-grid-5 .rvkpi:nth-child(5){ box-shadow:0 1px 2px rgba(15,17,17,.05), inset 0 2px 0 0 var(--op-green); }
/* MTD -> amber accent, Last-N -> steel accent (were coral / violet). */
.op-report .sku-mv thead th.sku-mv-mtd{ color:#FFD9A6; box-shadow:inset 0 -2px 0 var(--op-orange); }
.op-report .sku-mv thead th.sku-mv-last5{ color:#BBD6EE; box-shadow:inset 0 -2px 0 var(--op-steel); }
.op-report .sku-mv td.sku-mv-mtd{ background:#FBF3E2; border-left-color:#E7D19A; border-right-color:#E7D19A; color:var(--op-ink); }
.op-report .sku-mv td.sku-mv-last5{ background:#EAF1F8; border-left-color:#CFE0EE; border-right-color:#CFE0EE; color:var(--op-ink); }
.op-report .sku-mv tbody tr:hover td.sku-mv-mtd{ background:#F6E8CC; }
.op-report .sku-mv tbody tr:hover td.sku-mv-last5{ background:#DEEAF5; }
.op-report .sku-mv tfoot td.sku-mv-mtd,.op-report .sku-mv tfoot td.sku-mv-last5{ background:#EEF1F3; }
.op-report .sku-mv th.pt-sorted{ color:#BBD6EE; }
.op-report .sku-mv-move-pos{ background:var(--op-green-soft); color:var(--op-green); }
.op-report .sku-mv-move-neg{ background:var(--op-red-soft); color:var(--op-red); }
.op-report .sku-mv-move-flat{ color:var(--op-ink-4); }
.op-report .sku-mv-ident-view{ color:var(--op-ink); }
.op-report .sku-mv-ident-view:hover{ color:var(--op-steel); }

/* ===== SKU MOVEMENT -- flat Amazon operational workspace (.sku-mv-page) =====
   Approved Stitch redesign. Light grouped table headers, restrained blue MTD/Last-N column emphasis, green/red
   movement, flat KPI + observed-unit cells -- all scoped under .sku-mv-page so the SHARED plan and pt class families
   and the .rvkpi / .skupl primitives (SKU P&L, Reconciliation, Brand View) stay untouched. Follows the .op-report
   layer above and wins at equal specificity by source order. */
/* Header scope metadata + completeness status badge. */
.sku-mv-page .sku-mv-meta{ display:flex; flex-wrap:wrap; align-items:center; gap:10px; }
.sku-mv-page .sku-mv-meta-item{ display:flex; flex-direction:column; gap:1px; padding:6px 12px; background:#FFFFFF; border:1px solid #D5D9D9; border-radius:6px; min-width:0; }
.sku-mv-page .sku-mv-meta-k{ font-size:10px; font-weight:750; letter-spacing:.04em; text-transform:uppercase; color:#565959; }
.sku-mv-page .sku-mv-meta-v{ font-size:12.5px; font-weight:700; color:#0F1111; white-space:nowrap; }
.sku-mv-page .sku-mv-status{ font-size:11.5px; font-weight:700; padding:3px 9px; border-radius:3px; display:inline-flex; align-items:center; gap:6px; }
.sku-mv-page .sku-mv-status::before{ content:""; width:7px; height:7px; border-radius:50%; background:currentColor; flex:none; }
.sku-mv-page .sku-mv-status--good{ background:#F3F9F6; border:1px solid #CDE5D8; color:#067D62; }
.sku-mv-page .sku-mv-status--warn{ background:#FFF8E7; border:1px solid #F2C265; color:#B75D00; }
.sku-mv-page .sku-mv-status--bad{ background:#FDF4F4; border:1px solid #F5C2C7; color:#B12704; }

/* Observed Units -- five flat cells (SKU scope; distinct from the shared .obs-units). */
.sku-mv-page .sku-mv-obs{ margin-top:var(--space-4); background:#FFFFFF; border:1px solid #D5D9D9; border-radius:6px; padding:12px 14px; }
.sku-mv-page .sku-mv-obs-head{ display:flex; align-items:baseline; justify-content:space-between; gap:10px; flex-wrap:wrap; padding-bottom:10px; border-bottom:1px solid #E7E9EC; }
.sku-mv-page .sku-mv-obs-title{ font-size:11px; font-weight:800; letter-spacing:.05em; text-transform:uppercase; color:#565959; }
.sku-mv-page .sku-mv-obs-total{ font-size:11.5px; color:#565959; }
.sku-mv-page .sku-mv-obs-grid{ display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:10px; margin-top:12px; }
.sku-mv-page .sku-mv-obs-cell{ padding:9px 11px; border:1px solid #D5D9D9; border-radius:4px; background:#F8F9FA; min-width:0; }
.sku-mv-page .sku-mv-obs-cell--pos{ background:#F3F9F6; border-color:#CDE5D8; }
.sku-mv-page .sku-mv-obs-cell--warn{ background:#FFF8E7; border-color:#F2C265; }
.sku-mv-page .sku-mv-obs-cell--neg{ background:#FDF4F4; border-color:#F5C2C7; }
.sku-mv-page .sku-mv-obs-cell-value{ font-size:16px; font-weight:800; color:#0F1111; font-variant-numeric:tabular-nums; }
.sku-mv-page .sku-mv-obs-cell--pos .sku-mv-obs-cell-value{ color:#067D62; }
.sku-mv-page .sku-mv-obs-cell--warn .sku-mv-obs-cell-value{ color:#B75D00; }
.sku-mv-page .sku-mv-obs-cell--neg .sku-mv-obs-cell-value{ color:#B12704; }
.sku-mv-page .sku-mv-obs-cell-label{ font-size:11px; font-weight:600; color:#565959; margin-top:2px; }
.sku-mv-page .sku-mv-obs-cell--pos .sku-mv-obs-cell-label{ color:#067D62; }
.sku-mv-page .sku-mv-obs-cell--warn .sku-mv-obs-cell-label{ color:#944D00; }
.sku-mv-page .sku-mv-obs-cell--neg .sku-mv-obs-cell-label{ color:#B12704; }
.sku-mv-page .sku-mv-obs-note{ font-size:11.5px; line-height:1.55; color:#565959; margin-top:12px; }

/* Five KPI accents -> neutral ASINs, blue MTD + Last-N, neutral Prev, green Movement (its value uses rvkpi-pos/neg). */
.sku-mv-page .rvkpi-grid-5 .rvkpi:nth-child(1){ box-shadow:0 1px 2px rgba(15,17,17,.05), inset 0 2px 0 0 #C3CACE; }
.sku-mv-page .rvkpi-grid-5 .rvkpi:nth-child(2){ box-shadow:0 1px 2px rgba(15,17,17,.05), inset 0 2px 0 0 #146EB4; }
.sku-mv-page .rvkpi-grid-5 .rvkpi:nth-child(3){ box-shadow:0 1px 2px rgba(15,17,17,.05), inset 0 2px 0 0 #146EB4; }
.sku-mv-page .rvkpi-grid-5 .rvkpi:nth-child(4){ box-shadow:0 1px 2px rgba(15,17,17,.05), inset 0 2px 0 0 #C3CACE; }
.sku-mv-page .rvkpi-grid-5 .rvkpi:nth-child(5){ box-shadow:0 1px 2px rgba(15,17,17,.05), inset 0 2px 0 0 #067D62; }

/* Toolbar + table panel. */
.sku-mv-page .skupl-toolbar{ border-bottom:1px solid #D5D9D9; }
.sku-mv-page .panel.skupl-table-panel{ box-shadow:none; border:1px solid #D5D9D9; }

/* Matrix -- light grouped headers (neutral bands), sticky group band + normal header + identity columns. The
   group-band selectors carry .sku-mv so they out-specify the op-report navy sku-mv thead rule. */
.sku-mv-page .sku-mv .sku-mv-group-row th{ position:sticky; top:0; z-index:4; background:#F3F4F5; color:#565959; font-size:10px; font-weight:800; letter-spacing:.04em; text-transform:uppercase; text-align:center; padding:6px 10px; border-bottom:1px solid #D5D9D9; border-right:1px solid #E7E9EC; white-space:nowrap; }
/* Normal (column-name) header row -> light, sticky just beneath the group band. */
.sku-mv-page .sku-mv thead tr:last-child th{ background:#FAFAFA; color:#565959; font-size:11px; font-weight:800; letter-spacing:.03em; border-bottom:1px solid #D5D9D9; top:27px; z-index:2; }
.sku-mv-page .sku-mv thead tr:last-child th.pt-sorted{ color:#146EB4; }
/* Current MTD + Last-N -> restrained blue (header out-specifies the neutral header rule; body out-specifies td). */
.sku-mv-page .sku-mv thead tr:last-child th.sku-mv-mtd, .sku-mv-page .sku-mv thead tr:last-child th.sku-mv-last5{ background:#EFF6FB; color:#146EB4; box-shadow:inset 0 2px 0 #146EB4; }
.sku-mv-page .sku-mv td.sku-mv-mtd, .sku-mv-page .sku-mv td.sku-mv-last5{ background:#EFF6FB; color:#146EB4; font-weight:700; border-left:1px solid #D2E4F2; border-right:1px solid #D2E4F2; }
.sku-mv-page .sku-mv tbody tr:hover td.sku-mv-mtd, .sku-mv-page .sku-mv tbody tr:hover td.sku-mv-last5{ background:#E6F0F9; }
/* Body -> medium weight, hairline rows. */
.sku-mv-page .sku-mv tbody td{ color:#0F1111; border-bottom:1px solid #E7E9EC; font-weight:500; }
.sku-mv-page .sku-mv tbody tr:hover td{ background:#F5F9FD; }
/* Movement badge -> 3px (never pill), green positive / red negative / neutral em dash. */
.sku-mv-page .sku-mv-move{ border-radius:3px; }
.sku-mv-page .sku-mv-move-pos{ background:#EAF6F1; color:#067D62; }
.sku-mv-page .sku-mv-move-neg{ background:#FBEDEC; color:#B12704; }
.sku-mv-page .sku-mv-move-flat{ color:#8D9096; }

/* Methodology disclosure. */
.sku-mv-page .sku-mv-methodology{ margin-top:var(--space-4); background:#FFFFFF; border:1px solid #D5D9D9; border-radius:6px; padding:12px 14px; }
.sku-mv-page .sku-mv-methodology > summary{ cursor:pointer; font-size:12.5px; font-weight:750; color:#0F1111; list-style:none; display:inline-flex; align-items:center; gap:8px; }
.sku-mv-page .sku-mv-methodology > summary::-webkit-details-marker{ display:none; }
.sku-mv-page .sku-mv-methodology > summary::before{ content:"\\25B8"; color:#565959; font-size:10px; transition:transform .15s ease; }
.sku-mv-page .sku-mv-methodology[open] > summary::before{ transform:rotate(90deg); }
.sku-mv-page .sku-mv-methodology .footer-note{ margin-top:10px; border-top:1px solid #E7E9EC; padding-top:10px; background:none; }

@media (max-width:1180px){ .sku-mv-page .sku-mv-obs-grid{ grid-template-columns:repeat(3,minmax(0,1fr)); } }
@media (max-width:760px){ .sku-mv-page .sku-mv-obs-grid{ grid-template-columns:repeat(2,minmax(0,1fr)); } .sku-mv-page .sku-mv-meta{ width:100%; } }
@media (prefers-reduced-motion: reduce){ .sku-mv-page .sku-mv-methodology > summary::before{ transition:none; } }

/* ---- AD PERFORMANCE BY CAMPAIGN (.campaign-ads-page) ------------------- */
.op-report .ca-kpis{ grid-template-columns:repeat(auto-fit, minmax(128px, 1fr)); }
.op-report .ca-kpis .metric-value{ font-size:20px; margin-top:8px; }
.op-report .ca-search{ display:inline-flex; align-items:center; gap:7px; border:1px solid var(--op-border); border-radius:8px; background:#fff; padding:6px 10px; min-width:200px; }
.op-report .ca-search:focus-within{ border-color:var(--op-orange); box-shadow:0 0 0 3px rgba(255,153,0,.16); }
.op-report .ca-search svg{ color:var(--op-ink-4); flex:0 0 auto; }
.op-report .ca-search input{ border:none; outline:none; background:transparent; font:600 12.5px inherit; color:var(--op-ink); width:100%; min-width:0; }
.op-report .ca-map-select{ border:1px solid var(--op-border); border-radius:7px; background:#fff; color:var(--op-ink); font:600 12px inherit; padding:4px 6px; max-width:170px; }
.op-report .ca-map-select:hover{ border-color:#B9C0C5; }
.op-report .campaign-ads-table td{ font-variant-numeric:tabular-nums; }
/* One-workspace tab bar (Performance / Wasted Spend / Brand Mapping). */
.op-report .ca-tabs{ display:flex; gap:4px; margin:2px 0 14px; border-bottom:1px solid var(--op-border-2); flex-wrap:wrap; }
.op-report .ca-tab{ display:inline-flex; align-items:center; gap:7px; border:none; background:transparent; color:var(--op-ink-3); font:750 13px inherit; padding:9px 14px; border-radius:8px 8px 0 0; cursor:pointer; border-bottom:2px solid transparent; margin-bottom:-1px; }
.op-report .ca-tab:hover{ color:var(--op-ink); background:var(--op-hair); }
.op-report .ca-tab.active{ color:var(--op-navy); border-bottom-color:var(--op-orange); background:#fff; }
.op-report .ca-tab.active svg{ color:var(--op-orange); }
.op-report .ca-tab:focus-visible{ outline:2px solid var(--op-orange); outline-offset:1px; }
.op-report .ca-controls{ flex-wrap:wrap; gap:10px; }
.op-report .ca-daterange{ display:inline-flex; align-items:center; gap:6px; }
.op-report .ca-daterange input{ border:1px solid var(--op-border); border-radius:8px; background:#fff; color:var(--op-ink); font:600 12px inherit; padding:5px 8px; }
.op-report .ca-daterange input:focus-visible{ outline:none; border-color:var(--op-orange); box-shadow:0 0 0 3px rgba(255,153,0,.16); }
.op-report .ca-daterange-sep{ color:var(--op-ink-4); font-weight:800; }
.op-report .ca-coverage{ display:flex; flex-wrap:wrap; align-items:center; gap:8px 14px; font-size:11.5px; color:var(--op-ink-3); margin:0 0 12px; }
.op-report .ca-coverage strong{ color:var(--op-ink); font-weight:800; }
.op-report .ca-coverage-warn{ color:var(--op-warn-ink); background:var(--op-warn-soft); border:1px solid var(--op-warn-border); border-radius:6px; padding:2px 8px; font-weight:700; }
.op-report .ca-waste-kpis{ grid-template-columns:repeat(auto-fit, minmax(190px, 1fr)); }
.op-report .ca-waste-card .metric-value{ font-size:22px; }
.op-report .ca-neg{ color:var(--op-red); }
.op-report .ca-warn-ink{ color:var(--op-warn-ink); }
.op-report .ca-reasons{ display:flex; flex-wrap:wrap; gap:4px; }
.op-report .ca-reason{ display:inline-block; font:700 10.5px inherit; color:var(--op-ink-2); background:var(--op-hair); border:1px solid var(--op-border-2); border-radius:5px; padding:1px 7px; white-space:nowrap; }

/* ============================================================================
   BRAND PORTFOLIO (.bv-portfolio) — the approved cross-account redesign, scoped
   ENTIRELY under .bv-portfolio so the account-scoped Brand View and every other
   .op-report page are byte-identical. Presentation only; no data/formula change.
   ============================================================================ */
/* Flat workspace ONLY while the portfolio is shown (never the other op-report pages). */
.main-area.op-workspace:has(.bv-portfolio){ background:#F3F4F5; }

/* Brand context header — metadata, not KPI cards. */
.bv-portfolio.bv-page{ max-width:1760px; }
.bv-portfolio .bv-head{ display:flex; align-items:flex-start; justify-content:space-between; gap:16px 24px; flex-wrap:wrap; border:1px solid var(--op-border); background:var(--op-card); border-radius:6px; padding:12px 16px; margin-bottom:0; }
.bv-portfolio .bv-head-main{ min-width:0; }
.bv-portfolio .bv-head-titlerow{ display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.bv-portfolio .bv-head .page-title{ font-size:18px; letter-spacing:0; }
.bv-portfolio .bv-brand-chip{ display:inline-flex; align-items:center; gap:5px; font-size:12.5px; font-weight:800; color:var(--op-blue); background:var(--op-blue-soft); border:1px solid var(--op-blue-border); border-radius:5px; padding:2px 9px; }
.bv-portfolio .bv-head-counts{ display:inline-flex; align-items:center; gap:6px; font-size:12px; font-weight:600; color:var(--op-ink-3); }
.bv-portfolio .bv-head-counts svg{ color:var(--op-ink-4); }
.bv-portfolio .bv-head-desc{ margin-top:4px; }
.bv-portfolio .bv-head-meta{ display:flex; gap:24px; flex-wrap:wrap; }
.bv-portfolio .bv-meta-item{ display:flex; flex-direction:column; gap:2px; }
.bv-portfolio .bv-meta-label{ font-size:9.5px; font-weight:800; letter-spacing:.06em; text-transform:uppercase; color:var(--op-ink-4); }
.bv-portfolio .bv-meta-value{ font-size:13px; font-weight:700; color:var(--op-ink); }

/* Control bar container. */
.bv-portfolio .bv-controls{ border:1px solid var(--op-border); background:var(--op-card); border-radius:6px; padding:10px 14px; margin-top:12px; align-items:flex-end; gap:12px 14px; }
.bv-portfolio .bv-field-label{ color:var(--op-ink-4); }
.bv-portfolio .bv-select,.bv-portfolio .bv-custom-inputs input{ border-color:var(--op-border); border-radius:6px; color:var(--op-ink); background:#fff; }
.bv-portfolio .bv-select:hover{ border-color:#B9C0C5; }
.bv-portfolio .plan-export-btn{ border-radius:6px; }
/* Admin source action: distinct amber accent + an ADMIN tag; never the default/primary. */
.bv-portfolio .bv-admin-btn{ border-color:var(--op-warn-border); color:var(--op-orange-strong); background:var(--op-orange-soft); }
.bv-portfolio .bv-admin-btn:hover:not(:disabled){ border-color:var(--op-orange-dark); background:#FDECCE; }
.bv-portfolio .bv-admin-tag{ font-size:8.5px; font-weight:800; letter-spacing:.06em; text-transform:uppercase; color:#fff; background:var(--op-orange-dark); border-radius:3px; padding:1px 5px; margin-left:2px; }

/* Freshness row — wraps; never truncates. */
.bv-portfolio .bv-freshness{ display:flex; flex-wrap:wrap; align-items:center; gap:5px 16px; margin-top:10px; font-size:11.5px; color:var(--op-ink-3); }
.bv-portfolio .bv-fresh-item{ display:inline-flex; align-items:center; gap:6px; white-space:normal; }
.bv-portfolio .bv-fresh-item .live-dot{ position:static; }

/* Consolidated status panel: one compact panel, a 4px left accent, View details for the rest. */
.bv-portfolio .bv-status{ display:flex; align-items:flex-start; gap:10px; margin-top:12px; border:1px solid var(--op-border); border-left-width:4px; border-radius:6px; padding:9px 13px; background:var(--op-card); font-size:12px; line-height:1.5; }
.bv-portfolio .bv-status-warning{ background:var(--op-warn-soft); border-color:var(--op-warn-border); border-left-color:var(--op-orange-dark); color:var(--op-warn-ink); }
.bv-portfolio .bv-status-error{ background:var(--op-red-soft); border-color:var(--op-red-border); border-left-color:var(--op-red); color:#8A2D17; }
.bv-portfolio .bv-status-info{ background:#EFF5FA; border-color:#CFE0EE; border-left-color:var(--op-blue); color:#1B4E76; }
.bv-portfolio .bv-status-success{ background:#F1F7F4; border-color:var(--op-green-border); border-left-color:var(--op-green); color:var(--op-green); }
.bv-portfolio .bv-status-icon{ flex:none; margin-top:1px; opacity:.9; }
.bv-portfolio .bv-status-body{ min-width:0; flex:1; }
.bv-portfolio .bv-status-head{ display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.bv-portfolio .bv-status-title{ font-weight:750; color:var(--op-ink); }
.bv-portfolio .bv-status-badge{ font-size:9.5px; font-weight:800; text-transform:uppercase; letter-spacing:.03em; padding:2px 7px; border-radius:3px; border:1px solid currentColor; background:rgba(255,255,255,.55); }
.bv-portfolio .bv-status-toggle{ margin-left:auto; border:none; background:none; padding:0; font:700 12px inherit; color:var(--op-blue); cursor:pointer; }
.bv-portfolio .bv-status-toggle:hover{ text-decoration:underline; }
.bv-portfolio .bv-status-toggle:focus-visible{ outline:2px solid var(--op-blue); outline-offset:2px; border-radius:3px; }
.bv-portfolio .bv-status-detail{ margin-top:3px; color:var(--op-ink-2); }
.bv-portfolio .bv-status-list{ margin:8px 0 0; padding:0; list-style:none; display:flex; flex-direction:column; gap:5px; }
.bv-portfolio .bv-status-item{ font-size:11.5px; color:var(--op-ink-2); padding-left:10px; border-left:3px solid var(--op-border); }
.bv-portfolio .bv-status-item-warning{ border-left-color:var(--op-orange-dark); }
.bv-portfolio .bv-status-item-error{ border-left-color:var(--op-red); }
.bv-portfolio .bv-status-item-info{ border-left-color:var(--op-blue); }
.bv-portfolio .bv-status-item-success{ border-left-color:var(--op-green); }
.bv-portfolio .bv-status-item-title{ font-weight:750; color:var(--op-ink); }

/* Six-cell KPI strip. Tabular figures; unavailable is an em dash, never zero. */
.bv-portfolio .bv-kpi-strip{ display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:10px; margin-top:14px; }
.bv-portfolio .bv-kpi{ background:var(--op-card); border:1px solid var(--op-border); border-radius:6px; padding:11px 13px; min-width:0; }
.bv-portfolio .bv-kpi-top{ display:flex; align-items:center; gap:6px; }
.bv-portfolio .bv-kpi-label{ display:inline-flex; align-items:center; gap:5px; font-size:9.5px; font-weight:800; letter-spacing:.05em; text-transform:uppercase; color:var(--op-ink-3); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.bv-portfolio .bv-kpi-label svg{ color:var(--op-ink-4); flex:none; }
.bv-portfolio .bv-kpi-badge{ font-size:9px; font-weight:800; text-transform:uppercase; letter-spacing:.03em; color:var(--op-ink-3); background:var(--op-hair); border:1px solid var(--op-border-2); border-radius:3px; padding:1px 5px; white-space:nowrap; }
.bv-portfolio .bv-kpi-hint{ margin-left:auto; display:inline-grid; place-items:center; color:var(--op-ink-4); cursor:help; }
.bv-portfolio .bv-kpi-value{ font-family:'Outfit',sans-serif; font-variant-numeric:tabular-nums; font-size:22px; font-weight:700; color:var(--op-ink); margin-top:8px; line-height:1.15; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.bv-portfolio .bv-kpi-sub{ font-size:10.5px; color:var(--op-ink-4); margin-top:5px; line-height:1.45; }
.bv-portfolio .bv-delta{ font-weight:800; }
.bv-portfolio .bv-pos{ color:var(--op-green); }
.bv-portfolio .bv-neg{ color:var(--op-red); }

/* Performance summary overview. */
.bv-portfolio .bv-overview{ margin-top:14px; }
.bv-portfolio .bv-overview-head{ display:flex; align-items:baseline; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:4px; }
.bv-portfolio .bv-overview-note{ font-size:11px; color:var(--op-ink-4); }
.bv-portfolio .bv-overview-grid{ display:grid; grid-template-columns:1fr 1fr; gap:24px; margin-top:6px; }
.bv-portfolio .bv-overview-subtitle{ font-size:12px; font-weight:750; color:var(--op-ink-2); margin-bottom:9px; }
.bv-portfolio .bv-overview-dim{ color:var(--op-ink-4); font-weight:600; }
.bv-portfolio .bv-cadence,.bv-portfolio .bv-contrib{ display:flex; flex-direction:column; gap:7px; }
.bv-portfolio .bv-cadence-row{ display:grid; grid-template-columns:66px 1fr auto; align-items:center; gap:10px; font-size:11.5px; }
.bv-portfolio .bv-cadence-label{ color:var(--op-ink-3); font-weight:700; white-space:nowrap; }
.bv-portfolio .bv-cadence-track,.bv-portfolio .bv-contrib-track{ position:relative; height:12px; background:#EDF0F2; border-radius:3px; overflow:hidden; }
.bv-portfolio .bv-cadence-fill{ position:absolute; left:0; top:0; height:100%; background:#9CC3E6; border-radius:3px; }
.bv-portfolio .bv-cadence-fill-rr{ background:#CADEF0; }
.bv-portfolio .bv-cadence-fill-actual{ background:var(--op-blue); }
.bv-portfolio .bv-cadence-current .bv-cadence-label{ color:var(--op-blue); font-weight:800; }
.bv-portfolio .bv-cadence-val{ color:var(--op-ink); font-weight:700; white-space:nowrap; text-align:right; }
.bv-portfolio .bv-cadence-rr{ color:var(--op-ink-4); font-weight:600; }
.bv-portfolio .bv-contrib-row{ display:grid; grid-template-columns:104px 1fr auto 46px; align-items:center; gap:10px; font-size:11.5px; }
.bv-portfolio .bv-contrib-label{ color:var(--op-ink-2); font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.bv-portfolio .bv-contrib-fill{ position:absolute; left:0; top:0; height:100%; background:var(--op-blue); border-radius:3px; }
.bv-portfolio .bv-contrib-val{ color:var(--op-ink); font-weight:700; white-space:nowrap; text-align:right; }
.bv-portfolio .bv-contrib-share{ color:var(--op-ink-4); white-space:nowrap; text-align:right; }
.bv-portfolio .bv-contrib-total{ border-top:1px solid var(--op-border-2); margin-top:2px; padding-top:7px; }
.bv-portfolio .bv-contrib-total .bv-contrib-label,.bv-portfolio .bv-contrib-total .bv-contrib-val,.bv-portfolio .bv-contrib-total .bv-contrib-share{ font-weight:800; color:var(--op-ink); }

/* Page jump navigation — sticky within the workspace, below the global 60px bar. */
.bv-portfolio .bv-jump{ position:sticky; top:60px; z-index:6; display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-top:16px; padding:7px 14px; background:rgba(243,244,245,.94); border:1px solid var(--op-border); border-radius:6px; }
.bv-portfolio .bv-jump-label{ font-size:10px; font-weight:800; text-transform:uppercase; letter-spacing:.06em; color:var(--op-ink-4); }
.bv-portfolio .bv-jump-links{ display:flex; flex-wrap:wrap; gap:4px; }
.bv-portfolio .bv-jump-link{ font-size:12px; font-weight:700; color:var(--op-blue); text-decoration:none; padding:3px 9px; border-radius:5px; }
.bv-portfolio .bv-jump-link:hover{ background:var(--op-blue-soft); }
.bv-portfolio .bv-jump-link:focus-visible{ outline:2px solid var(--op-blue); outline-offset:1px; }
.bv-portfolio .bv-jump-note{ margin-left:auto; font-size:11px; color:var(--op-ink-4); }
.bv-portfolio [id^="bv-"]:focus{ outline:none; }
.bv-portfolio [id^="bv-"]{ scroll-margin-top:112px; }

/* Tables: LIGHT neutral headers (Stitch) -- no dark navy band; #D5D9D9-family borders;
   sticky header + sticky first column within a bounded scroll box. */
.bv-portfolio .bv-panel{ border-radius:6px; }
.bv-portfolio .bv-scroll{ max-height:78vh; overflow:auto; }
.bv-portfolio .bv-table th{
  background:#F3F4F5; color:var(--op-ink-3); border-bottom:1px solid var(--op-border);
  box-shadow:inset 0 -1px 0 var(--op-border);
}
.bv-portfolio .bv-table thead th{ position:sticky; top:0; z-index:2; }
.bv-portfolio .bv-table td.bv-first{ position:sticky; left:0; z-index:1; background:var(--op-card); }
.bv-portfolio .bv-table th.bv-first{ position:sticky; left:0; background:#F3F4F5; color:var(--op-ink); }
.bv-portfolio .bv-table thead th.bv-first{ z-index:3; }
.bv-portfolio .bv-table tbody tr.bv-total td.bv-first{ background:#EAF1F8; }
/* Restrained column tones on the LIGHT header (design): no green columns; current month
   in blue, latest 7-day date in amber. No conditional row/value colouring is introduced. */
.bv-portfolio .bv-table .bv-col-positive,.bv-portfolio .bv-table .bv-col-accent{ color:var(--op-ink); }
.bv-portfolio .bv-table th.bv-col-positive,.bv-portfolio .bv-table th.bv-col-accent,.bv-portfolio .bv-table th.bv-col-total{ color:var(--op-ink-3); }
.bv-portfolio .bv-table th.bv-col-total{ box-shadow:inset 0 -1px 0 var(--op-border); }
.bv-portfolio .bv-table .bv-col-key-actual{ color:var(--op-blue); font-weight:750; background:rgba(20,110,180,.05); }
.bv-portfolio .bv-table th.bv-col-key-actual{ color:var(--op-blue); background:rgba(20,110,180,.08); box-shadow:inset 0 -2px 0 var(--op-blue); }
.bv-portfolio .bv-table .bv-col-latest{ background:rgba(255,153,0,.09); color:var(--op-ink); }
.bv-portfolio .bv-table th.bv-col-latest{ color:var(--op-orange-strong); background:rgba(255,153,0,.12); box-shadow:inset 0 -2px 0 var(--op-orange); }
.bv-portfolio .bv-table tbody tr:hover td.bv-col-latest{ background:rgba(255,153,0,.15); }
/* Typography hierarchy: genuine headings stay bold (table headers 750-800, All Markets and
   the "Units by country" section 800 -- all unchanged). Plain DATA-row labels + values are
   medium (600) instead of semibold, so the heading hierarchy is clearly scannable and the
   table is not "all bold". Scoped to .bv-portfolio data rows only; the current-month column
   keeps a restrained emphasis. No heading, header, total, section or supporting weight is reduced. */
.bv-portfolio .bv-table tbody tr:not(.bv-total):not(.bv-section) td{ font-weight:600; }
.bv-portfolio .bv-table tbody tr:not(.bv-total):not(.bv-section) td.bv-col-key-actual{ font-weight:700; }

/* Methodology disclosure (portfolio scope). */
.bv-portfolio .methodology-disclosure{ margin-top:18px; border-top:1px solid var(--op-border-2); padding-top:12px; }
.bv-portfolio .methodology-disclosure > summary{ cursor:pointer; list-style:none; font-size:12px; font-weight:750; color:var(--op-ink-2); display:inline-flex; align-items:center; gap:7px; }
.bv-portfolio .methodology-disclosure > summary::-webkit-details-marker{ display:none; }
.bv-portfolio .methodology-disclosure > summary::before{ content:'\\25B8'; color:var(--op-ink-4); font-size:11px; transition:transform var(--t-fast) var(--ease); }
.bv-portfolio .methodology-disclosure[open] > summary::before{ transform:rotate(90deg); }
.bv-portfolio .methodology-disclosure > summary:hover{ color:var(--op-ink); }
.bv-portfolio .methodology-disclosure > summary:focus-visible{ outline:2px solid var(--op-blue); outline-offset:2px; border-radius:3px; }
.bv-portfolio .methodology-disclosure .footer-note{ margin-top:0; padding-top:8px; border-top:none; }

/* Responsive reflow. */
@media (max-width:1280px){ .bv-portfolio .bv-kpi-strip{ grid-template-columns:repeat(3,minmax(0,1fr)); } }
@media (max-width:900px){
  .bv-portfolio .bv-kpi-strip{ grid-template-columns:repeat(2,minmax(0,1fr)); }
  .bv-portfolio .bv-overview-grid{ grid-template-columns:1fr; gap:16px; }
  .bv-portfolio .bv-head-meta{ gap:16px; }
}
@media (max-width:560px){ .bv-portfolio .bv-kpi-strip{ grid-template-columns:1fr 1fr; } }
`;

/* Chart colours, exported so recharts series stay in step with the CSS tokens
   above. Recharts needs literal colour values, not CSS variables. */
export const CHART = {
  primary: "#8B5CF6",
  primaryFillTop: "rgba(139,92,246,0.25)",
  primaryFillBottom: "rgba(139,92,246,0.02)",
  teal: "#10B981",
  gold: "#FF9F43",
  red: "#FF5D6C",
  violet: "#A78BFA",
  neutral: "#D9D3EE",
  grid: "#EEEAFB",
  axis: "#8E87AA",
  axisLine: "#E3DDFC",
  positive: "#0B9F76",
  negative: "#F34F5D",
  info: "#6D5CE7",
};

/* DASHBOARD-SCOPED chart palette (Amazon-inspired blue/green/orange). Kept
   SEPARATE from CHART so the Sales Dashboard's recharts series and sparklines
   can adopt the operational palette WITHOUT changing any other report's chart
   colours (CHART is still used by Reconciliation and Returns & Refund Leakage).
   Mirrors the --dash-* CSS tokens in STYLE. */
export const DASH_CHART = {
  primary: "#2F6FB0",                        // Total Sales — steel blue
  primaryFillTop: "rgba(47,111,176,0.16)",
  primaryFillBottom: "rgba(47,111,176,0.01)",
  teal: "#0E9F6E",                           // Units — emerald
  orders: "#5B8DB8",                         // Orders — light steel
  gold: "#E08600",                           // Avg. Order Value — amber
  positive: "#0E9F6E",
  negative: "#D6492E",                       // coral
  grid: "#E7EAEE",
  axis: "#586067",
  axisLine: "#D3D8DD",
  // Balanced categorical palette for brand contribution bars — harmonised with
  // the navy / steel / amber system (steel, amber, emerald, coral, slate, bronze).
  brandPalette: ["#2F6FB0", "#E08600", "#0E9F6E", "#D6492E", "#5B7A99", "#B07A2E"],
};

export default STYLE;
