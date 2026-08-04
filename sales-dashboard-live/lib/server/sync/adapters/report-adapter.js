// Generic per-account report adapter.
//
// Wraps an EXISTING builder headlessly: resolve the account to one connection +
// its raw seller/vendor ids, call the builder, validate, and only on success save
// the snapshot. Build-then-save ordering is the last-known-good guarantee — a
// failed build throws before saveReportSnapshot, so the previous good snapshot is
// never overwritten. Persistence deps are injectable so this is unit-testable
// without network (see scripts/test-sync.mjs).

import { resolveDataDoeAccountIds } from "../../datadoe-connections.js";
import { paramsHashFor } from "../../report-store.js";
import {
  saveReportSnapshot as defaultSave,
  publishSnapshotUpdate as defaultPublish,
  pruneScheduledReportSnapshots as defaultPrune,
} from "../../supabase.js";

const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

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
