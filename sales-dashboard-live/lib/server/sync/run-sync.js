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
import { fetchAccounts } from "../datadoe.js";
import { paramsHashFor } from "../report-store.js";
import { marketplaceToday } from "../../marketplaces.js";
import {
  claimRefreshLock, releaseRefreshLock, isSupabaseConfigured,
  upsertAccountDirectory, insertSyncRun, updateSyncRun, upsertSyncTarget,
  insertSyncError, insertAuditLog, deleteReportSnapshotsOlderThan,
} from "../supabase.js";
import { bucketForCountry, entriesForBucket, orderedWork } from "./registry.js";
import { getReportBuild } from "./adapters/index.js";
import { runReportAdapter } from "./adapters/report-adapter.js";
import { runAdsAdapter } from "./adapters/ads.js";

const WORK_BUDGET_MS = 50_000;       // leave ~10s headroom under the 60s function cap
const ADS_ITEM_RESERVE_MS = 46_000;  // never START an ads item with < 46s left (runAdsSync self-budgets 45s)
const REPORT_RESERVE_MS = 8_000;     // heuristic floor to START a report adapter
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

export async function runScheduledSync({ bucket, trigger = "cron", createdBy = null, budgetMs = WORK_BUDGET_MS }) {
  if (bucket !== "us" && bucket !== "non-us") throw new Error("bucket must be 'us' or 'non-us'.");
  const counts = { accounts: 0, targets: 0, succeeded: 0, failed: 0, deferred: 0, skipped: 0 };

  if (!isSupabaseConfigured()) {
    return { bucket, drained: false, skipped: "supabase-not-configured", counts };
  }

  const deadline = Date.now() + budgetMs;
  const bucketLock = { reportKey: "scheduled-sync", accountId: `bucket:${bucket}`, paramsHash: "v1" };
  const gotBucketLock = await claimRefreshLock({ ...bucketLock, lockSeconds: BUCKET_LOCK_SECONDS });
  if (!gotBucketLock) return { bucket, drained: false, skipped: "locked", counts };

  let run = null;
  try {
    run = await insertSyncRun({ bucket, trigger, createdBy });

    // --- Discover accounts across both orgs, persist the directory, classify. ---
    const connections = getDataDoeConnections();
    const directoryRows = [];
    const bucketAccounts = [];
    for (const conn of connections) {
      let accounts = [];
      try {
        accounts = await fetchAccounts(conn.apiKey);
      } catch (err) {
        await insertSyncError({ runId: run.id, phase: "discover", message: `discovery failed for connection ${conn.id}: ${err.message}` });
        continue;
      }
      for (const a of accounts) {
        const accountId = publicAccountId(conn, a.id);
        const accBucket = bucketForCountry(a.country);
        directoryRows.push({ accountId, connectionId: conn.id, country: a.country, currency: a.currency, name: a.name, bucket: accBucket });
        if (accBucket === "unknown") {
          await insertSyncError({ runId: run.id, phase: "bucket", accountId, message: `unknown/empty marketplace country '${a.country}'; skipped, not bucketed` });
          continue;
        }
        if (accBucket === bucket) {
          bucketAccounts.push({ account_id: accountId, marketplace_country_code: a.country, country: a.country });
        }
      }
    }
    await upsertAccountDirectory(directoryRows).catch(() => {});
    counts.accounts = bucketAccounts.length;

    // --- Build the ordered work list from the registry. ---
    const entries = orderedWork(entriesForBucket(bucket));
    const work = [];
    for (const entry of entries) {
      if (entry.partition === "per-bucket") work.push({ entry, scope: { bucket } });
      else for (const account of bucketAccounts) work.push({ entry, scope: { account } });
    }
    counts.targets = work.length;

    // --- Process under the time budget; checkpoint each; isolate failures. ---
    let drained = true;
    for (const item of work) {
      const remaining = deadline - Date.now();
      const reserve = item.entry.domain === "ads" ? ADS_ITEM_RESERVE_MS : REPORT_RESERVE_MS;
      if (remaining < reserve) { drained = false; break; }

      if (item.entry.domain === "ads") {
        const targetAccountId = `__bucket:${bucket}`;
        await upsertSyncTarget({ reportKey: item.entry.reportKey, accountId: targetAccountId, lastRunId: run.id, lastStatus: "running", lastAttemptAt: nowIso() });
        try {
          const r = await runAdsAdapter({ entry: item.entry, bucket });
          if (r.deferred) {
            drained = false; counts.deferred += 1;
            await upsertSyncTarget({ reportKey: item.entry.reportKey, accountId: targetAccountId, lastRunId: run.id, lastStatus: "deferred", lastAttemptAt: nowIso() });
          } else {
            counts.succeeded += 1;
            await upsertSyncTarget({ reportKey: item.entry.reportKey, accountId: targetAccountId, lastRunId: run.id, lastStatus: "succeeded", lastAttemptAt: nowIso(), sourceRefreshedAt: nowIso() });
          }
        } catch (err) {
          counts.failed += 1;
          await insertSyncError({ runId: run.id, reportKey: item.entry.reportKey, accountId: targetAccountId, phase: "adapter", message: err.message });
          await upsertSyncTarget({ reportKey: item.entry.reportKey, accountId: targetAccountId, lastRunId: run.id, lastStatus: "failed", lastAttemptAt: nowIso(), lastError: err.message });
        }
        continue;
      }

      // Per-account report/insight.
      const account = item.scope.account;
      const asOf = marketplaceToday(account.country);
      const build = getReportBuild(item.entry.adapter);
      if (!build) { counts.skipped += 1; continue; } // entriesForBucket only returns enabled entries; guard anyway

      const params = item.entry.windowFor({ asOf, country: account.country }) || {};
      const paramsHash = paramsHashFor(item.entry.reportVersion, params);
      const targetLock = { reportKey: item.entry.reportKey, accountId: account.account_id, paramsHash };
      const gotTargetLock = await claimRefreshLock({ ...targetLock, lockSeconds: REPORT_TARGET_LOCK_SECONDS });
      if (!gotTargetLock) {
        counts.skipped += 1;
        await upsertSyncTarget({ reportKey: item.entry.reportKey, accountId: account.account_id, lastRunId: run.id, lastStatus: "skipped", lastAttemptAt: nowIso() });
        continue;
      }
      await upsertSyncTarget({ reportKey: item.entry.reportKey, accountId: account.account_id, lastRunId: run.id, lastStatus: "running", lastAttemptAt: nowIso() });
      try {
        const res = await runReportAdapter({ entry: item.entry, account, asOf, connections, build });
        counts.succeeded += 1;
        await upsertSyncTarget({ reportKey: item.entry.reportKey, accountId: account.account_id, lastRunId: run.id, lastStatus: "succeeded", lastAttemptAt: nowIso(), sourceRefreshedAt: res.sourceRefreshedAt, latestDataDate: res.latestDataDate });
      } catch (err) {
        counts.failed += 1;
        await insertSyncError({ runId: run.id, reportKey: item.entry.reportKey, accountId: account.account_id, phase: "adapter", message: err.message });
        await upsertSyncTarget({ reportKey: item.entry.reportKey, accountId: account.account_id, lastRunId: run.id, lastStatus: "failed", lastAttemptAt: nowIso(), lastError: err.message });
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

    const remaining = Math.max(0, counts.targets - counts.succeeded - counts.deferred - counts.failed - counts.skipped);
    return { bucket, drained, remaining, counts, runId: run.id };
  } finally {
    await releaseRefreshLock(bucketLock).catch(() => {});
  }
}
