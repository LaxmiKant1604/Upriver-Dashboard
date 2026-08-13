import { SYNC_REGISTRY } from "./registry.js";

// User-facing reports that an administrator may schedule independently. Ads
// source exports are dependencies of PPC/Daily reports, not standalone reports
// in this control plane. Derived-only views have no DataDoe work to enable.
export const CONTROLLED_REPORT_KEYS = Object.freeze([
  "brand-sales",
  "daily-reporting",
  "reconciliation",
  "fba-plan",
  "sku-pl",
  "keyword-rank",
  "content-changes",
  "sales-movers",
  "listing-health",
  "buy-box-loss",
  "returns-leakage",
  "ppc-performance",
  "listing-optimizer",
]);

const ENTRY_BY_KEY = new Map(SYNC_REGISTRY.map((entry) => [entry.reportKey, entry]));

// Scheduler v1 is the only production runner today. A report is manual/schedule
// ready only when that runner has an enabled adapter. Scheduler v2 adapters stay
// locked until their live cutover is reviewed; this prevents a control from
// spending DataDoe tokens without producing a readable production snapshot.
export function reportControlCatalog(settings = []) {
  const settingByKey = new Map(settings.map((row) => [row.report_key ?? row.reportKey, row]));
  return CONTROLLED_REPORT_KEYS.map((reportKey) => {
    const entry = ENTRY_BY_KEY.get(reportKey);
    const setting = settingByKey.get(reportKey) || {};
    const ready = !!entry?.enabled;
    return {
      reportKey,
      label: entry?.label || reportKey,
      domain: entry?.domain || "report",
      scheduleEnabled: ready && setting.schedule_enabled === true,
      ready,
      readinessReason: ready ? null : "Scheduler v2 adapter is still awaiting verification.",
      updatedAt: setting.updated_at || null,
    };
  });
}

// Scheduler v2 has its OWN readiness, DISTINCT from Scheduler v1's production `enabled` wiring above.
// `reportControlCatalog.ready` (v1) is true whenever Scheduler v1 runs the report -- e.g. brand-sales, the
// live Dashboard -- which says NOTHING about whether the Scheduler-v2 dispatch path has passed live-cutover
// review. A Scheduler-v2 report is v2-ready ONLY when it is on this EXPLICIT, fail-closed allowlist. The
// allowlist is EMPTY today, so EVERY v2 report (including brand-sales) is locked: a v2 manual OR scheduled
// request selects it into neither `ready` nor `scheduleEnabled`, and the dispatcher's readiness gate spends
// zero exports. Flipping a report on here is the deliberate, reviewed v2 cutover -- never a side effect of
// Scheduler v1's `enabled` flag.
export const SCHEDULER_V2_READY_REPORT_KEYS = Object.freeze([]);

// The Scheduler-v2 control catalog: SAME row shape as reportControlCatalog, but `ready` is the explicit
// fail-closed v2 readiness (NOT v1 `enabled`). Consumed by the Scheduler-v2 dispatcher as its default control
// plane so a v1-live report can never be v2-dispatched until its own v2 cutover is reviewed. Scheduler v1's
// reportControlCatalog is left completely unchanged (v1 Brand Sales behavior is untouched).
export function schedulerV2ReportControlCatalog(settings = []) {
  const settingByKey = new Map(settings.map((row) => [row.report_key ?? row.reportKey, row]));
  const v2Ready = new Set(SCHEDULER_V2_READY_REPORT_KEYS);
  return CONTROLLED_REPORT_KEYS.map((reportKey) => {
    const entry = ENTRY_BY_KEY.get(reportKey);
    const setting = settingByKey.get(reportKey) || {};
    const ready = v2Ready.has(reportKey); // fail closed: v2 readiness, NEVER v1 `enabled`
    return {
      reportKey,
      label: entry?.label || reportKey,
      domain: entry?.domain || "report",
      scheduleEnabled: ready && setting.schedule_enabled === true,
      ready,
      readinessReason: ready ? null : "Scheduler v2 dispatch is locked pending live-cutover review.",
      updatedAt: setting.updated_at || null,
    };
  });
}

export function controlledReport(reportKey) {
  const key = String(reportKey || "");
  if (!CONTROLLED_REPORT_KEYS.includes(key)) return null;
  return ENTRY_BY_KEY.get(key) || null;
}

export function enabledReportKeys(settings = []) {
  return new Set(reportControlCatalog(settings)
    .filter((report) => report.ready && report.scheduleEnabled)
    .map((report) => report.reportKey));
}
