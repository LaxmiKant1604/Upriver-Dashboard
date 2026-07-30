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
  --bg-app:#F3F5F9;
  --bg-surface:#FFFFFF;
  --bg-elevated:#FFFFFF;
  --bg-subtle:#F7F9FC;
  --bg-sunken:#EEF1F7;

  /* ---- borders ---- */
  --border-default:#E4E8F0;
  --border-strong:#D5DBE7;
  --border-hover:#C2CADB;

  /* ---- text ---- */
  --text-primary:#111A2E;
  --text-secondary:#4E5769;
  --text-muted:#6B7488;
  --text-inverse:#FFFFFF;

  /* ---- accent: the interactive colour. Active nav, selected controls,
         primary actions and the primary chart series. ---- */
  --accent:#2C5FD6;
  --accent-strong:#2450BB;
  --accent-soft:#ECF1FE;
  --accent-border:#C4D5F9;

  /* ---- UPRIVER brand gold. Controlled use only: the logo mark, the
         workspace crumb and the MTD emphasis column. Never a whole UI. ---- */
  --brand:#E0982A;
  --brand-deep:#A9700F;
  --brand-soft:#FDF3E3;

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
  --chart-1:#2C5FD6;
  --chart-2:#0E9384;
  --chart-3:#E0982A;
  --chart-4:#C43241;
  --chart-5:#7A5AF8;
  --chart-neutral:#C9D1E0;
  --grid-line:#EDF0F6;

  /* ---- radii ---- */
  --radius-sm:8px;
  --radius-md:12px;
  --radius-lg:16px;
  --radius-pill:999px;

  /* ---- elevation. Small differences, soft and ambient. ---- */
  --shadow-xs:0 1px 2px rgba(17,26,46,.04);
  --shadow-sm:0 1px 2px rgba(17,26,46,.05), 0 1px 3px rgba(17,26,46,.04);
  --shadow-md:0 4px 14px -4px rgba(17,26,46,.10), 0 2px 4px -2px rgba(17,26,46,.05);
  --shadow-lg:0 18px 44px -12px rgba(17,26,46,.20), 0 4px 10px -4px rgba(17,26,46,.08);

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

  --sidebar-w:236px;
  --sidebar-w-collapsed:68px;

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
  font-family:'Manrope',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  background:var(--bg-app); color:var(--text-primary); min-height:100vh;
  -webkit-font-smoothing:antialiased; font-feature-settings:'cv11','ss01';
}
.mono{ font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,monospace; font-variant-numeric:tabular-nums; font-feature-settings:'tnum'; }
.num{ font-variant-numeric:tabular-nums; }
.sr-only{ position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
.spin{ animation:spin 1s linear infinite; }
@keyframes spin{ from{transform:rotate(0deg);} to{transform:rotate(360deg);} }

/* =========================== APP SHELL =========================== */
.app-shell{ display:flex; align-items:stretch; min-height:100vh; }
.main-area{ flex:1; min-width:0; display:flex; flex-direction:column; padding-bottom:var(--space-6); }

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
  color:var(--text-inverse); font-family:'JetBrains Mono',monospace; font-weight:700;
  font-size:12.5px; letter-spacing:.02em; display:grid; place-items:center;
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.08), var(--shadow-xs);
}
.sb-logo::after{ content:''; position:absolute; }
.sb-brand-text{ display:flex; flex-direction:column; min-width:0; }
.sb-ws-name{ font-size:13px; font-weight:800; letter-spacing:-.01em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
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
  font-family:'JetBrains Mono',monospace; font-size:10.5px; font-weight:700; letter-spacing:.07em;
  color:var(--brand-deep); background:var(--brand-soft); border:1px solid var(--warning-border);
  padding:3px 7px; border-radius:var(--radius-sm);
}
.crumb-sep{ color:var(--border-strong); flex-shrink:0; }
.crumb-current{ font-size:14px; font-weight:800; letter-spacing:-.01em; color:var(--text-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
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
.page-title{ font-size:19px; font-weight:800; letter-spacing:-.02em; color:var(--text-primary); }
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
.panel-title{ font-size:14px; font-weight:800; letter-spacing:-.01em; color:var(--text-primary); display:flex; align-items:center; gap:7px; }
.panel-flush{ padding:0; overflow:hidden; }
.footer-note{ margin-top:var(--space-5); font-size:11px; color:var(--text-secondary); line-height:1.65; padding:var(--space-4) 2px var(--space-2); border-top:1px solid var(--border-default); }
.footer-note code{ font-family:'JetBrains Mono',monospace; font-size:10.5px; background:var(--bg-sunken); padding:1px 5px; border-radius:5px; color:var(--text-secondary); }
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
  font-family:'JetBrains Mono',monospace; font-variant-numeric:tabular-nums;
  font-size:26px; font-weight:700; letter-spacing:-.02em; color:var(--text-primary);
  margin-top:9px; line-height:1.1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.metric-foot{ display:flex; align-items:center; gap:8px; margin-top:9px; flex-wrap:wrap; min-height:18px; }
.metric-period{ font-size:11px; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.metric-spark{ margin-top:10px; height:26px; }
.metric-spark svg{ display:block; width:100%; height:100%; overflow:visible; }

/* Trend indicator: icon + sign + value, never colour alone. */
.trend{
  display:inline-flex; align-items:center; gap:4px; font-family:'JetBrains Mono',monospace;
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
.cmp-value{ display:flex; align-items:center; gap:7px; margin-top:7px; font-family:'JetBrains Mono',monospace; font-variant-numeric:tabular-nums; font-size:17px; font-weight:700; letter-spacing:-.01em; }
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
.plan-stat-value{ font-size:19px; font-weight:700; margin-top:6px; letter-spacing:-.02em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.recon-kpis{ display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:var(--space-3); margin-top:var(--space-4); }
.recon-kpi{
  border:1px solid var(--border-default); border-radius:var(--radius-md); padding:12px 14px;
  background:var(--bg-elevated); min-height:88px; box-shadow:var(--shadow-xs); min-width:0;
  transition:transform var(--t) var(--ease), box-shadow var(--t) var(--ease), border-color var(--t) var(--ease);
}
.recon-kpi:hover{ transform:translateY(-2px); box-shadow:var(--shadow-md); border-color:var(--border-hover); }
.recon-kpi-label{ color:var(--text-muted); font-size:9.5px; font-weight:800; text-transform:uppercase; letter-spacing:.08em; }
.recon-kpi-value{ color:var(--text-primary); font-size:17px; font-weight:700; margin-top:7px; letter-spacing:-.02em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.recon-kpi-note{ color:var(--text-muted); font-size:10.5px; margin-top:5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.skupl-kpis{ display:grid; grid-template-columns:repeat(7,minmax(0,1fr)); gap:10px; margin-top:var(--space-4); }
.skupl-kpi{
  background:var(--bg-elevated); border:1px solid var(--border-default); border-radius:var(--radius-md);
  padding:11px 12px; box-shadow:var(--shadow-xs); min-width:0;
  transition:transform var(--t) var(--ease), box-shadow var(--t) var(--ease), border-color var(--t) var(--ease);
}
.skupl-kpi:hover{ transform:translateY(-2px); box-shadow:var(--shadow-md); border-color:var(--border-hover); }
.skupl-kpi-label{ font-size:9.5px; font-weight:800; text-transform:uppercase; letter-spacing:.07em; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.skupl-kpi-value{ font-size:16px; font-weight:700; margin-top:6px; letter-spacing:-.02em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
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
.chart-card-title{ font-size:14px; font-weight:800; letter-spacing:-.01em; }
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
.chart-tip-label{ font-size:11px; font-weight:800; color:var(--text-primary); letter-spacing:-.01em; }
.chart-tip-rows{ margin-top:6px; display:flex; flex-direction:column; gap:4px; }
.chart-tip-row{ display:flex; align-items:center; justify-content:space-between; gap:14px; font-size:11.5px; color:var(--text-secondary); }
.chart-tip-row b{ font-family:'JetBrains Mono',monospace; font-variant-numeric:tabular-nums; color:var(--text-primary); font-weight:700; }
.chart-tip-key{ display:inline-flex; align-items:center; gap:6px; }
.chart-tip-swatch{ width:7px; height:7px; border-radius:2px; flex-shrink:0; }
.recon-chart-grid{ display:grid; grid-template-columns:1fr 1fr; gap:var(--space-3); margin-top:var(--space-4); }
.recon-chart-panel{ min-height:264px; }
.recon-chart-wrap{ height:200px; }
.recon-donut-wrap{ height:200px; display:flex; align-items:center; }
.recon-donut-legend{ display:flex; flex-direction:column; gap:8px; width:42%; font-size:11.5px; color:var(--text-secondary); }
.recon-donut-legend div{ display:grid; grid-template-columns:9px 1fr auto; align-items:center; gap:7px; }
.recon-donut-legend span{ width:8px; height:8px; border-radius:2px; }
.recon-donut-legend strong{ color:var(--text-primary); font-family:'JetBrains Mono',monospace; font-variant-numeric:tabular-nums; }
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
.bd-value{ font-family:'JetBrains Mono',monospace; font-variant-numeric:tabular-nums; font-size:12.5px; font-weight:700; color:var(--text-primary); white-space:nowrap; }
.bd-share{ font-family:'JetBrains Mono',monospace; font-variant-numeric:tabular-nums; font-size:10.5px; color:var(--text-muted); margin-top:3px; white-space:nowrap; }

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
  font-family:'Manrope',sans-serif; color:var(--text-secondary); text-align:center; padding:24px; gap:4px;
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
.recon-order-id button{ display:inline-flex; align-items:center; gap:5px; border:0; padding:0; background:transparent; color:var(--accent); cursor:pointer; font:600 11px 'JetBrains Mono',monospace; }
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
.recon-waterfall-row > strong{ font-family:'JetBrains Mono',monospace; font-variant-numeric:tabular-nums; text-align:right; font-size:11.5px; }
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
.auth-root{ min-height:100vh; display:grid; place-items:center; padding:24px; background:var(--bg-app); font-family:'Manrope',-apple-system,'Segoe UI',sans-serif; color:var(--text-primary); }
.auth-panel{ width:min(100%,410px); border:1px solid var(--border-default); border-radius:var(--radius-lg); background:var(--bg-surface); padding:30px; box-shadow:var(--shadow-lg); }
.auth-logo{ display:grid; place-items:center; width:40px; height:40px; border-radius:11px; background:linear-gradient(160deg,#1B2540,#111A2E); color:var(--text-inverse); font-weight:800; font-size:12px; font-family:'JetBrains Mono',monospace; }
.auth-title{ margin-top:18px; font-size:21px; font-weight:800; letter-spacing:-.02em; }
.auth-sub{ margin-top:7px; color:var(--text-secondary); font-size:12.5px; line-height:1.6; }
.auth-field{ display:flex; flex-direction:column; gap:6px; margin-top:16px; color:var(--text-muted); font-size:10px; font-weight:800; text-transform:uppercase; letter-spacing:.07em; }
.auth-field input,.auth-field select{ min-height:39px; width:100%; border:1px solid var(--border-default); border-radius:var(--radius-sm); padding:8px 11px; color:var(--text-primary); background:var(--bg-elevated); font:600 14px 'Manrope',sans-serif; text-transform:none; letter-spacing:0; }
.auth-field input:focus,.auth-field select:focus{ outline:none; border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-soft); }
.auth-submit{ width:100%; min-height:41px; margin-top:20px; border:1px solid var(--text-primary); border-radius:var(--radius-sm); background:var(--text-primary); color:var(--text-inverse); cursor:pointer; font:750 13px 'Manrope',sans-serif; transition:opacity var(--t-fast) var(--ease); }
.auth-submit:hover:not(:disabled){ opacity:.9; }
.auth-submit:disabled{ opacity:.6; cursor:not-allowed; }
.auth-error,.auth-success{ display:flex; align-items:center; gap:7px; margin-top:14px; padding:9px 11px; border-radius:var(--radius-sm); font-size:12px; font-weight:700; border:1px solid transparent; }
.auth-error{ color:var(--negative); background:var(--negative-soft); border-color:var(--negative-border); }
.auth-success{ color:var(--positive); background:var(--positive-soft); border-color:var(--positive-border); }
.auth-note{ margin-top:13px; color:var(--text-muted); font-size:11px; line-height:1.55; text-align:center; }
.auth-link{ display:block; width:100%; margin-top:10px; border:0; background:transparent; color:var(--accent-strong); cursor:pointer; font:700 11.5px 'Manrope',sans-serif; }
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
.skupl-rank-num{ font:700 11px 'JetBrains Mono',monospace; color:var(--text-muted); }
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

/* ======================= RESPONSIVE ======================= */
@media (max-width:1180px){
  .metric-grid{ grid-template-columns:repeat(2,minmax(0,1fr)); }
  .cmp-grid{ grid-template-columns:repeat(2,minmax(0,1fr)); }
  .skupl-kpis{ grid-template-columns:repeat(4,minmax(0,1fr)); }
  .tb-select.account select{ min-width:150px; max-width:210px; }
  .tb-select.brand select{ min-width:110px; max-width:160px; }
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
  .tb-select.account select,.tb-select.brand select{ min-width:0; max-width:none; width:100%; }
  .refresh-cluster{ flex:1 1 160px; }
  .refresh-status-value{ max-width:none; }
}
@media (max-width:640px){
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
`;

/* Chart colours, exported so recharts series stay in step with the CSS tokens
   above. Recharts needs literal colour values, not CSS variables. */
export const CHART = {
  primary: "#2C5FD6",
  primaryFillTop: "rgba(44,95,214,0.20)",
  primaryFillBottom: "rgba(44,95,214,0.01)",
  teal: "#0E9384",
  gold: "#E0982A",
  red: "#C43241",
  violet: "#7A5AF8",
  neutral: "#CBD3E1",
  grid: "#EDF0F6",
  axis: "#6B7488",
  axisLine: "#E4E8F0",
  positive: "#0B8A5C",
  negative: "#C43241",
  info: "#1B6E9C",
};

export default STYLE;
