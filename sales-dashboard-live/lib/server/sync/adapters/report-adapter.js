// Generic per-account report adapter.
//
// Wraps an EXISTING builder headlessly: resolve the account to one connection +
// its raw seller/vendor ids, call the builder, validate, and only on success save
// the snapshot. Build-then-save ordering is the last-known-good guarantee — a
// failed build throws before saveReportSnapshot, so the previous good snapshot is
// never overwritten. Persistence deps are injectable so this is unit-testable
// without network (see scripts/test-sync.mjs).
//
// PUBLICATION RECOVERY WP13 -- the scheduler-v1 LIBRARY refuses every ROUTE-OWNED live report key itself (not only its
// callers: api/admin/sync.js, api/sync.js and api/cron/sync.js already refuse them since WP10b). A route-owned key
// (report-store.js isRouteOwnedLiveReportKey == the DB writer-fence seed: brand-sales, daily-reporting, brand-inventory,
// listing-health-v3, fba-plan, sku-movement, returns-leakage, brand-view, brand-view-portfolio, brand-view-brands) is
// published ONLY through the fenced publisher, so runReportAdapter throws the typed ROUTE_OWNED_REPORT_V1_REFUSED
// BEFORE the account resolution, the (paid) build, the save, the prune and the publish -- no v1 run can spend a DataDoe
// export and then fail at the fence, and no v1 save / syncManaged prune can ever touch a route-owned row.

import { resolveDataDoeAccountIds } from "../../datadoe-connections.js";
import { paramsHashFor, isRouteOwnedLiveReportKey, ROUTE_OWNED_REPORT_V1_REFUSED } from "../../report-store.js";
import {
  saveReportSnapshot as defaultSave,
  publishSnapshotUpdate as defaultPublish,
  pruneScheduledReportSnapshots as defaultPrune,
} from "../../supabase.js";

const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

/** The typed scheduler-v1 refusal of route-owned live report keys (HTTP-shaped: status 409; never a generic failure). */
export class SchedulerV1RouteOwnedRefusedError extends Error {
  constructor(refusedReportKeys, where) {
    const keys = [...new Set((refusedReportKeys || []).map(String))].sort();
    super(`${ROUTE_OWNED_REPORT_V1_REFUSED}: ${where} refuses the route-owned live report key(s) ${keys.join(", ")} -- they are published ONLY through the fenced publisher (paid refresh: the admin Data Sync Center source cards).`);
    this.name = "SchedulerV1RouteOwnedRefusedError";
    this.code = ROUTE_OWNED_REPORT_V1_REFUSED;
    this.status = 409;
    this.refusedReportKeys = keys;
  }
}
/** May scheduler v1 write this report key at all? false for every route-owned live key (and a non-string key). */
export function isSchedulerV1WritableReportKey(reportKey) {
  return typeof reportKey === "string" && reportKey !== "" && !isRouteOwnedLiveReportKey(reportKey);
}
/** Throw the typed refusal when ANY of `reportKeys` is route-owned (fail closed: no partial run of a mixed list). */
export function assertSchedulerV1ReportKeys(reportKeys, where = "scheduler v1") {
  const refused = [...new Set((reportKeys || []).map((k) => String(k)))].filter((k) => isRouteOwnedLiveReportKey(k));
  if (refused.length) throw new SchedulerV1RouteOwnedRefusedError(refused, where);
}

function latestPayloadDate(payload) {
  const direct = [payload?.latestDataDate, payload?.salesLatestDate]
    .map((value) => String(value || ""))
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));
  const rowDates = (payload?.rows || [])
    .map((row) => String(row?.date || row?.metric_date || ""))
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));
  return [...direct, ...rowDates].sort().at(-1) || null;
}

export async function runReportAdapter({
  entry, account, asOf, connections, build,
  save = defaultSave, publish = defaultPublish, prune = defaultPrune,
}) {
  // WP13: FIRST -- before the account resolution, the (paid) build and any save / prune / publish.
  if (!entry || !isSchedulerV1WritableReportKey(entry.reportKey)) {
    throw (entry && typeof entry.reportKey === "string" && isRouteOwnedLiveReportKey(entry.reportKey))
      ? new SchedulerV1RouteOwnedRefusedError([entry.reportKey], "the scheduler-v1 report adapter")
      : new Error("scheduler-v1 report adapter: an entry with a report key is required (fail closed).");
  }
  if (typeof build !== "function") {
    throw new Error(`no adapter build wired for ${entry.reportKey}`);
  }
  // One connection, cross-org safe. resolveDataDoeAccountIds rejects a mix.
  const resolved = resolveDataDoeAccountIds([account.account_id], connections);
  const apiKey = resolved.connection.apiKey;
  const ids = resolved.rawAccountIds;

  const params = entry.windowFor({ asOf, country: account.marketplace_country_code || account.country }) || {};
  const payload = await build({ apiKey, ids, ...params, account });

  const ok = entry.validate ? entry.validate(payload) : true;
  if (ok !== true) throw new Error(`validation failed for ${entry.reportKey}: ${ok}`);

  const serialised = JSON.stringify(payload);
  const payloadBytes = Buffer.byteLength(serialised, "utf8");
  if (payloadBytes > MAX_SNAPSHOT_BYTES) {
    throw new Error(`${entry.reportKey} produced ${(payloadBytes / (1024 * 1024)).toFixed(1)} MB, above the shared-snapshot limit; not saved.`);
  }

  const paramsHash = paramsHashFor(entry.reportVersion, params);
  const saved = await save({
    reportKey: entry.reportKey,
    accountId: account.account_id,
    paramsHash,
    params: { reportVersion: entry.reportVersion, syncManaged: true, ...params },
    payload,
    payloadBytes,
    sourceRefreshedAt: new Date().toISOString(),
  });
  if (saved?.id) {
    await prune({ reportKey: entry.reportKey, accountId: account.account_id, keepParamsHash: paramsHash });
    await publish({ reportKey: entry.reportKey, accountId: account.account_id, paramsHash, snapshotId: saved.id }).catch(() => {});
  }
  return {
    sourceRefreshedAt: saved?.source_refreshed_at || new Date().toISOString(),
    latestDataDate: latestPayloadDate(payload),
  };
}
