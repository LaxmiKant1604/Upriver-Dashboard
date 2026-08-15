import { countriesForBucket } from "./registry.js";

export const MAX_TARGET_ATTEMPTS = 3;

function adsScopeKey(countries) {
  return countries === "OTHER" ? "other" : countries.map((country) => String(country).toLowerCase()).sort().join("-");
}

export function expandSyncWork(entries, bucketAccounts, bucket) {
  const work = [];
  for (const entry of entries) {
    if (entry.partition === "per-bucket") {
      for (const countries of countriesForBucket(bucket).groups) {
        work.push({
          entry,
          scope: { bucket, countries },
          targetAccountId: `__bucket:${bucket}:${adsScopeKey(countries)}`,
        });
      }
      continue;
    }
    for (const account of bucketAccounts) {
      work.push({ entry, scope: { account }, targetAccountId: account.account_id });
    }
  }
  return work;
}

export function targetDisposition(target, cycleDate) {
  if (!target || target.cycle_date !== cycleDate) return { status: "due", attempts: 0 };
  const attempts = Number(target.attempts || 0);
  if (target.last_status === "succeeded") return { status: "complete", attempts };
  if (target.last_status === "failed" && attempts >= MAX_TARGET_ATTEMPTS) {
    return { status: "terminal-failure", attempts };
  }
  return { status: "due", attempts };
}

/* ===================================================================
   Scheduler v2 — source-first dependency planning (pure, no I/O)
   ===================================================================

   A single sync cycle can contain many DataDoe source exports because DataDoe
   cannot combine unrelated sources into one export. Token saving comes from
   fetching each canonical source (identified by request_hash, computed by
   lib/server/datadoe.js sourceRequestIdentity) exactly once and reusing it across
   every report that needs it.

   buildDependencyPlan() takes report requests — each already carrying the
   canonical source requests it needs — and collapses identical source requests
   (same request_hash) into ONE source job, while every report job keeps the list
   of request_hashes it depends on. N reports needing the same source => 1 source
   job => 1 create-export.                                                        */

export function buildDependencyPlan(reportRequests) {
  const sourceJobs = new Map(); // request_hash -> source job
  const reportJobs = [];

  for (const req of reportRequests || []) {
    if (!req || !req.reportKey) continue;
    const dependsOn = [];
    for (const src of req.sources || []) {
      if (!src || !src.requestHash) continue;
      dependsOn.push(src.requestHash);
      if (!sourceJobs.has(src.requestHash)) {
        sourceJobs.set(src.requestHash, {
          requestHash: src.requestHash,
          sourceId: src.sourceId || "",
          sourceKey: src.sourceKey || "",
          // No 'primary' default: the connection id is carried through as declared so a
          // missing/invalid one fails closed downstream instead of routing to primary.
          connectionId: src.connectionId,
          organizationFingerprint: src.organizationFingerprint || "",
          accountScopeHash: src.accountScopeHash || "",
          requestMeta: src.requestMeta || {},
          bucket: src.bucket || req.bucket || "",
          neededBy: [],
        });
      }
      sourceJobs.get(src.requestHash).neededBy.push({
        reportKey: req.reportKey,
        accountId: req.accountId,
      });
    }
    reportJobs.push({
      reportKey: req.reportKey,
      reportVersion: req.reportVersion || "",
      accountId: req.accountId,
      connectionId: req.connectionId,
      bucket: req.bucket || "",
      dependsOn: [...new Set(dependsOn)],
    });
  }

  return { sourceJobs: [...sourceJobs.values()], reportJobs };
}

/**
 * Whether the worker may make a DataDoe create-export POST for this source job.
 * Mirrors the durable claim_source_export_attempt() DB guard for the in-memory
 * pre-check: allowed ONLY if the job has never been attempted this cycle. A
 * failed/terminal/succeeded source is never re-attempted in the same cycle — it
 * waits for the next scheduled cycle, and its last-known-good data is preserved.
 * The DB RPC remains the authority across separate worker invocations.
 */
export function sourceExportAttemptAllowed(sourceJob) {
  if (!sourceJob) return false;
  if (sourceJob.attempted_at || sourceJob.attemptedAt) return false;
  const status = sourceJob.fetch_status || sourceJob.fetchStatus || "pending";
  return status === "pending";
}

/**
 * A report may derive only when every canonical source it depends on has
 * succeeded this cycle. If any dependency terminally failed or was skipped, the
 * report is 'blocked' and must NOT overwrite its last-known-good snapshot with
 * empty/partial data. Otherwise it stays 'pending' until its sources resolve.
 */
export function reportFetchGate(reportJob, sourceStatusByHash) {
  const deps = (reportJob && reportJob.dependsOn) || [];
  if (!deps.length) return "ready";
  let anyPending = false;
  for (const hash of deps) {
    const status = (sourceStatusByHash && sourceStatusByHash[hash]) || "pending";
    if (status === "failed" || status === "skipped") return "blocked";
    if (status !== "succeeded") anyPending = true;
  }
  return anyPending ? "pending" : "ready";
}
