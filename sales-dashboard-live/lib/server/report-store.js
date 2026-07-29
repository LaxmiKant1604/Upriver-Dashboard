// Shared report snapshot layer.
//
// Every report built on this helper obeys one contract:
//
//   GET  ?action=<report>&ids=<one account>&...            -> read the SHARED
//        saved snapshot from Supabase. This NEVER calls DataDoe, so opening a
//        report, changing brand, filtering, sorting or paging costs nothing and
//        shows exactly what the last refresher fetched.
//   GET  ?action=<report>&ids=...&refresh=1                -> the one explicit
//        operation allowed to call DataDoe. It claims a database lock first, so
//        two people clicking Refresh cannot spend DataDoe tokens twice, then
//        saves the validated result for every permitted user and publishes a
//        compact Realtime event.
//
// The account is always authorised by api/datadoe.js before this runs.

import { createHash } from "node:crypto";

import {
  claimRefreshLock,
  getReportSnapshot,
  isSupabaseConfigured,
  publishSnapshotUpdate,
  releaseRefreshLock,
  saveReportSnapshot,
} from "./supabase.js";

// A refresh that produces more than this is a design problem, not something to
// silently truncate or silently keep out of the shared store. Every new report
// aggregates server-side specifically to stay far below it.
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

const DEFAULT_LOCK_SECONDS = 240;

export function paramsHashFor(reportVersion, params) {
  const ordered = {};
  Object.keys(params || {}).sort().forEach((key) => {
    const value = params[key];
    if (value !== undefined && value !== null && value !== "") ordered[key] = String(value);
  });
  return createHash("sha256")
    .update(JSON.stringify({ reportVersion, ...ordered }))
    .digest("hex")
    .slice(0, 40);
}

export function wantsRefresh(req) {
  const value = String(req.query?.refresh ?? "").toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function snapshotMeta(snapshot) {
  return {
    savedAt: snapshot.source_refreshed_at || snapshot.updated_at || null,
    updatedAt: snapshot.updated_at || null,
    bytes: Number(snapshot.payload_bytes || 0),
    shared: true,
  };
}

/**
 * Serve one report through the shared snapshot layer.
 *
 * @param {object} options
 * @param {object} options.res            Vercel response
 * @param {boolean} options.refresh       true only for an explicit Refresh
 * @param {string} options.reportKey      stable report identifier
 * @param {string} options.reportVersion  bump when the metric definition changes
 * @param {string} options.accountId      single selected account
 * @param {object} options.params         scope that identifies the snapshot
 * @param {string} options.userId         requesting user (audit only)
 * @param {string} options.label          human report name for messages
 * @param {() => Promise<object>} options.build  performs the DataDoe work
 */
export async function serveSharedReport({
  res, refresh, reportKey, reportVersion, accountId, params, userId, label, build,
  lockSeconds = DEFAULT_LOCK_SECONDS,
}) {
  const paramsHash = paramsHashFor(reportVersion, params);

  // Without Supabase there is no shared store. Refresh still works so the app
  // remains usable in a local environment, but it is reported as unshared
  // rather than pretending the result was saved for everyone.
  if (!isSupabaseConfigured()) {
    if (!refresh) {
      res.status(200).json({
        snapshotMissing: true,
        reportKey, reportVersion, accountId, paramsHash,
        message: `${label} has no shared saved data because Supabase is not configured in this deployment.`,
      });
      return;
    }
    const payload = await build();
    res.status(200).json({ ...payload, reportKey, reportVersion, paramsHash, shared: false });
    return;
  }

  if (!refresh) {
    const snapshot = await getReportSnapshot({ reportKey, accountId, paramsHash });
    if (snapshot && snapshot.payload) {
      res.status(200).json({
        ...snapshot.payload,
        reportKey, reportVersion, paramsHash,
        snapshot: snapshotMeta(snapshot),
      });
      return;
    }
    res.status(200).json({
      snapshotMissing: true,
      reportKey, reportVersion, accountId, paramsHash,
      message: `No saved ${label} for this account yet. Click Refresh once to fetch it from DataDoe — everyone with access to this account will then read the same saved data.`,
    });
    return;
  }

  const locked = await claimRefreshLock({ reportKey, accountId, paramsHash, lockSeconds });
  if (!locked) {
    res.status(409).json({
      error: `${label} is already being refreshed for this account. Wait for that refresh to finish, then read the saved data — it does not need a second DataDoe export.`,
    });
    return;
  }

  try {
    const payload = await build();
    const serialised = JSON.stringify(payload);
    const payloadBytes = Buffer.byteLength(serialised, "utf8");
    if (payloadBytes > MAX_SNAPSHOT_BYTES) {
      throw new Error(`${label} produced ${(payloadBytes / (1024 * 1024)).toFixed(1)} MB, above the ${MAX_SNAPSHOT_BYTES / (1024 * 1024)} MB shared-snapshot limit. It was not saved. Narrow the scope (fewer days or a single brand) or aggregate this report further before relying on it.`);
    }
    const saved = await saveReportSnapshot({
      reportKey,
      accountId,
      paramsHash,
      params: { reportVersion, ...params },
      payload,
      payloadBytes,
      sourceRefreshedAt: new Date().toISOString(),
    });
    if (saved?.id) {
      // Only a tiny row is broadcast; report payloads never travel on Realtime.
      await publishSnapshotUpdate({ reportKey, accountId, paramsHash, snapshotId: saved.id }).catch(() => {});
    }
    res.status(200).json({
      ...payload,
      reportKey, reportVersion, paramsHash,
      snapshot: {
        savedAt: saved?.source_refreshed_at || new Date().toISOString(),
        updatedAt: saved?.updated_at || null,
        bytes: payloadBytes,
        shared: true,
        refreshedBy: userId || null,
      },
    });
  } finally {
    await releaseRefreshLock({ reportKey, accountId, paramsHash }).catch(() => {});
  }
}
