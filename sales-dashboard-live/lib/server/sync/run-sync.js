// Scheduled-sync orchestrator.
//
// One invocation of runScheduledSync({ bucket }) does a BOUNDED slice of work for
// one marketplace bucket and returns { drained }. A driver (GitHub Actions loop,
// or a best-effort Vercel cron) calls it repeatedly until drained. Safety model:
//   - Per-bucket lock (reuses claim_report_refresh_lock) so two invocations of the
//     same bucket never overlap. 90s > the 60s function cap, so a crashed run frees
//     it ~30s later rather than 600s.
//   - Cross-call durability + idempotency live in sync_targets and the builders'
//     upserts, NOT in the lock. A run killed at 60s wrote nothing partial (report
//     snapshots save only on success), so a re-call is always safe.
//   - One account/report failure is isolated (logged to sync_errors, target marked
//     failed) and never stops the rest.
//   - Unknown marketplace country is logged and skipped, never mis-bucketed.

import { getDataDoeConnections, publicAccountId } from "../datadoe-connections.js";
import { fetchAccounts, isDataDoeDeadlineError, withDataDoeDeadline } from "../datadoe.js";
import { paramsHashFor } from "../report-store.js";
import { marketplaceToday } from "../../marketplaces.js";
import {
  claimRefreshLock, releaseRefreshLock, isSupabaseConfigured,
  upsertAccountDirectory, insertSyncRun, updateSyncRun, upsertSyncTarget,
  insertSyncError, insertAuditLog, deleteReportSnapshotsOlderThan,
  getAccountDirectoryRows, getSyncTargets,
  getReportSyncSettings,
} from "../supabase.js";
import { bucketForCountry, entriesForBucket, orderedWork } from "./registry.js";
import { enabledReportKeys } from "./report-controls.js";
import { expandSyncWork, targetDisposition } from "./planner.js";
import { getReportBuild } from "./adapters/index.js";
import { runReportAdapter } from "./adapters/report-adapter.js";
import { runAdsAdapter } from "./adapters/ads.js";

const WORK_BUDGET_MS = 50_000;       // leave ~10s headroom under the 60s function cap
const ADS_ITEM_RESERVE_MS = 46_000;  // never START an ads item with < 46s left (runAdsSync self-budgets 45s)
const REPORT_RESERVE_MS = 8_000;     // heuristic floor to START a report adapter
const DEADLINE_CHECKPOINT_MS = 2_500; // reserve time to persist status + release locks
const BUCKET_LOCK_SECONDS = 90;      // > function cap; per-invocation, not held across the drain
const REPORT_TARGET_LOCK_SECONDS = 240;

const nowIso = () => new Date().toISOString();

async function runRetention(entries) {
  const now = Date.now();
  for (const entry of entries) {
    if (entry.domain === "ads" || !entry.retentionDays) continue; // ads history is preserved
    const cutoffIso = new Date(now - entry.retentionDays * 86_400_000).toISOString();
    await deleteReportSnapshotsOlderThan({ reportKey: entry.reportKey, cutoffIso });
  }
}

export async function runScheduledSync({
  bucket, trigger = "cron", createdBy = null, budgetMs = WORK_BUDGET_MS,
  reportKeys = null, accountIds = null,
}) {
  if (bucket !== "us" && bucket !== "non-us") throw new Error("bucket must be 'us' or 'non-us'.");
  const requestedReportKeys = reportKeys ? new Set(reportKeys.map(String)) : null;
  const requestedAccountIds = accountIds ? new Set(accountIds.map(String)) : null;
  const counts = { accounts: 0, targets: 0, succeeded: 0, failed: 0, terminalFailed: 0, deferred: 0, skipped: 0, discoveryFailed: 0 };

  if (!isSupabaseConfigured()) {
    return { bucket, drained: false, skipped: "supabase-not-configured", counts };
  }

  // Gate the cycle before account discovery. When all reports are paused, the
  // scheduler performs zero DataDoe calls (including no account-directory call).
  // A report-scoped manual action supplies its explicit key and bypasses only
  // the schedule setting, never the registry's runtime-readiness flag.
  const selectedKeys = requestedReportKeys || enabledReportKeys(await getReportSyncSettings());
  const selectedEntries = entriesForBucket(bucket).filter((entry) => selectedKeys.has(entry.reportKey));
  if (!selectedEntries.length) {
    return { bucket, drained: true, skipped: "all-reports-paused", counts };
  }

  const deadline = Date.now() + budgetMs;
  const bucketLock = { reportKey: "scheduled-sync", accountId: `bucket:${bucket}`, paramsHash: "v1" };
  const gotBucketLock = await claimRefreshLock({ ...bucketLock, lockSeconds: BUCKET_LOCK_SECONDS });
  if (!gotBucketLock) return { bucket, drained: false, skipped: "locked", counts };

  let run = null;
  try {
    run = await insertSyncRun({ bucket, trigger, createdBy });
    const syncDate = new Date().toISOString().slice(0, 10);
    const knownTargets = await getSyncTargets();
    const targetByKey = new Map(knownTargets.map((target) => [`${target.report_key}|${target.account_id}`, target]));

    // Discover both DataDoe organisations once per UTC day. Repeated driver
    // calls read the durable directory, so draining a large bucket does not
    // keep spending account-list requests.
    const connections = getDataDoeConnections();
    const directoryTarget = { reportKey: "account-directory-sync", accountId: "__all__" };
    const directoryKey = `${directoryTarget.reportKey}|${directoryTarget.accountId}`;
    const directoryDisposition = targetDisposition(targetByKey.get(directoryKey), syncDate);
    let directoryRows = [];
    let discoveryIncomplete = false;
    if (directoryDisposition.status === "complete") {
      directoryRows = await getAccountDirectoryRows();
    } else {
      const discoveredRows = [];
      for (const conn of connections) {
        let accounts = [];
        try {
          accounts = await fetchAccounts(conn.apiKey);
        } catch (err) {
          discoveryIncomplete = true;
          counts.discoveryFailed += 1;
          await insertSyncError({ runId: run.id, phase: "discover", message: `discovery failed for connection ${conn.id}: ${err.message}` });
          continue;
        }
        for (const a of accounts) {
          const accountId = publicAccountId(conn, a.id);
          const accBucket = bucketForCountry(a.country);
          discoveredRows.push({ accountId, connectionId: conn.id, country: a.country, currency: a.currency, name: a.name, bucket: accBucket });
          if (accBucket === "unknown") {
            await insertSyncError({ runId: run.id, phase: "bucket", accountId, message: `unknown/empty marketplace country '${a.country}'; skipped, not bucketed` });
          }
        }
      }
      await upsertAccountDirectory(discoveredRows);
      directoryRows = discoveredRows;
      if (!discoveryIncomplete) {
        await upsertSyncTarget({
          ...directoryTarget, lastRunId: run.id, lastStatus: "succeeded",
          lastAttemptAt: nowIso(), sourceRefreshedAt: nowIso(), cycleDate: syncDate,
        });
      }
    }

    const bucketAccounts = [];
    for (const row of directoryRows) {
      const accountId = row.accountId || row.account_id;
      const country = row.country || row.marketplace_country_code;
      const accBucket = row.bucket || row.sync_bucket || bucketForCountry(country);
      if (accBucket === bucket && (!requestedAccountIds || requestedAccountIds.has(String(accountId)))) {
        bucketAccounts.push({ account_id: accountId, marketplace_country_code: country, country });
      }
    }
    counts.accounts = bucketAccounts.length;

    // --- Build the ordered work list from the registry. ---
    // Explicit reportKeys are used only by the admin report-scoped manual action.
    // Ordinary scheduled/watchdog runs read the database settings and do no work
    // when every report is paused. This check happens before any report export.
    const entries = orderedWork(selectedEntries);
    const work = expandSyncWork(entries, bucketAccounts, bucket);
    counts.targets = work.length;

    // --- Process under the time budget; checkpoint each; isolate failures. ---
    let drained = !discoveryIncomplete;
    for (const item of work) {
      const account = item.scope.account;
      const cycleDate = item.entry.domain === "ads" ? syncDate : marketplaceToday(account.country);
      const targetKey = `${item.entry.reportKey}|${item.targetAccountId}`;
      const disposition = targetDisposition(targetByKey.get(targetKey), cycleDate);
      if (disposition.status === "complete") { counts.skipped += 1; continue; }
      if (disposition.status === "terminal-failure") {
        counts.failed += 1;
        counts.terminalFailed += 1;
        continue;
      }

      const remaining = deadline - Date.now();
      const reserve = item.entry.domain === "ads" ? ADS_ITEM_RESERVE_MS : REPORT_RESERVE_MS;
      if (remaining < reserve) { drained = false; break; }
      const attempts = disposition.attempts + 1;

      if (item.entry.domain === "ads") {
        const targetAccountId = item.targetAccountId;
        await upsertSyncTarget({ reportKey: item.entry.reportKey, accountId: targetAccountId, lastRunId: run.id, lastStatus: "running", lastAttemptAt: nowIso(), attempts, cycleDate });
        try {
          const r = await runAdsAdapter({ entry: item.entry, countries: item.scope.countries });
          if (r.deferred || r.skipped) {
            drained = false; counts.deferred += 1;
            await upsertSyncTarget({ reportKey: item.entry.reportKey, accountId: targetAccountId, lastRunId: run.id, lastStatus: "deferred", lastAttemptAt: nowIso(), attempts, cycleDate });
          } else {
            counts.succeeded += 1;
            await upsertSyncTarget({ reportKey: item.entry.reportKey, accountId: targetAccountId, lastRunId: run.id, lastStatus: "succeeded", lastAttemptAt: nowIso(), sourceRefreshedAt: nowIso(), attempts, cycleDate });
          }
        } catch (err) {
          drained = false;
          counts.failed += 1;
          await insertSyncError({ runId: run.id, reportKey: item.entry.reportKey, accountId: targetAccountId, phase: "adapter", message: err.message });
          await upsertSyncTarget({ reportKey: item.entry.reportKey, accountId: targetAccountId, lastRunId: run.id, lastStatus: "failed", lastAttemptAt: nowIso(), lastError: err.message, attempts, cycleDate });
        }
        continue;
      }

      // Per-account report/insight.
      const asOf = marketplaceToday(account.country);
      const build = getReportBuild(item.entry.adapter);
      if (!build) { counts.skipped += 1; continue; } // entriesForBucket only returns enabled entries; guard anyway

      const params = item.entry.windowFor({ asOf, country: account.country }) || {};
      const paramsHash = paramsHashFor(item.entry.reportVersion, params);
      const targetLock = { reportKey: item.entry.reportKey, accountId: account.account_id, paramsHash };
      const gotTargetLock = await claimRefreshLock({ ...targetLock, lockSeconds: REPORT_TARGET_LOCK_SECONDS });
      if (!gotTargetLock) {
        drained = false;
        counts.deferred += 1;
        await upsertSyncTarget({ reportKey: item.entry.reportKey, accountId: account.account_id, lastRunId: run.id, lastStatus: "deferred", lastAttemptAt: nowIso(), attempts: disposition.attempts, cycleDate });
        continue;
      }
      await upsertSyncTarget({ reportKey: item.entry.reportKey, accountId: account.account_id, lastRunId: run.id, lastStatus: "running", lastAttemptAt: nowIso(), attempts, cycleDate });
      try {
        const res = await withDataDoeDeadline(
          deadline - DEADLINE_CHECKPOINT_MS,
          () => runReportAdapter({ entry: item.entry, account, asOf, connections, build }),
        );
        counts.succeeded += 1;
        await upsertSyncTarget({ reportKey: item.entry.reportKey, accountId: account.account_id, lastRunId: run.id, lastStatus: "succeeded", lastAttemptAt: nowIso(), sourceRefreshedAt: res.sourceRefreshedAt, latestDataDate: res.latestDataDate, attempts, cycleDate });
      } catch (err) {
        if (isDataDoeDeadlineError(err)) {
          drained = false;
          counts.deferred += 1;
          await upsertSyncTarget({
            reportKey: item.entry.reportKey,
            accountId: account.account_id,
            lastRunId: run.id,
            lastStatus: "deferred",
            lastAttemptAt: nowIso(),
            lastError: err.message,
            attempts: disposition.attempts,
            cycleDate,
          });
          continue;
        }
        drained = false;
        counts.failed += 1;
        await insertSyncError({ runId: run.id, reportKey: item.entry.reportKey, accountId: account.account_id, phase: "adapter", message: err.message });
        await upsertSyncTarget({ reportKey: item.entry.reportKey, accountId: account.account_id, lastRunId: run.id, lastStatus: "failed", lastAttemptAt: nowIso(), lastError: err.message, attempts, cycleDate });
      } finally {
        await releaseRefreshLock(targetLock).catch(() => {});
      }
    }

    if (drained) {
      try { await runRetention(entries); } catch (err) { await insertSyncError({ runId: run.id, phase: "retention", message: err.message }); }
    }

    const status = counts.failed > 0 ? "partial" : (drained ? "succeeded" : "partial");
    await updateSyncRun(run.id, { status, finishedAt: nowIso(), counts });
    await insertAuditLog({ actorUserId: createdBy, action: `sync.${trigger}`, target: { bucket, runId: run.id, counts } });

    const remaining = drained ? 0 : Math.max(1, counts.targets - counts.succeeded - counts.skipped - counts.terminalFailed);
    return { bucket, drained, remaining, counts, runId: run.id };
  } finally {
    await releaseRefreshLock(bucketLock).catch(() => {});
  }
}
