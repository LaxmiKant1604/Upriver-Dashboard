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
// review. A Scheduler-v2 report is v2-ready ONLY when it is on this EXPLICIT allowlist.
//
// GATE 7b CUTOVER (2026-08-15): the allowlist is now EXACTLY the 13 CONTROLLED_REPORT_KEYS -- every
// Scheduler-v2 report has passed live-cutover review (the IN account cleared all 13 in Gate-6 Cycle 2). This
// is the CODE gate only. Readiness being on does NOT dispatch or publish anything by itself: the DURABLE
// account rollout (scheduler_account_rollout / scheduler_rollout_mode -- default ZERO accounts) still gates
// WHICH accounts run, and the DURABLE report controls (report_sync_settings.schedule_enabled -- all 13 paused)
// still gate WHICH reports a SCHEDULED run dispatches; the publisher additionally needs an explicit
// per-(report, account) approval. So with the durable data closed (as it is at cutover), a scheduled OR manual
// run is a zero-I/O no-op and nothing publishes -- proven by the Gate-7b regressions. Turning a report OFF
// again is a reviewed CODE rollback (remove its key here); the operational per-report/-account gating is the
// durable data, one step at a time.
export const SCHEDULER_V2_READY_REPORT_KEYS = Object.freeze([...CONTROLLED_REPORT_KEYS]);

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
