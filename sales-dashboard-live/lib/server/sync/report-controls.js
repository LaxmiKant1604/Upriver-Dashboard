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
