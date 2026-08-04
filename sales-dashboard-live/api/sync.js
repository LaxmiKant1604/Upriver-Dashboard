// Sync control + read-only status API (user-facing, Supabase-auth gated).
//
//   GET  /api/sync   -> read-only sync status for the caller's accounts only.
//                       Any authenticated user. Never exposes another account.
//   POST /api/sync   -> ADMIN ONLY. Runs the SAME scheduled-sync path (a bounded
//                       slice); never the old per-page DataDoe export. Rate limited
//                       + audited. Body: { bucket: "us" | "non-us" }.
//
// Browser users can never trigger a full DataDoe sync: only admins may POST, and
// even then the work goes through runScheduledSync (registry + locks + budget).

import {
  getDashboardAccess, assertAdmin,
  getSyncTargets, getReportSnapshotsMeta, getAccountDirectoryRows, insertAuditLog,
} from "../lib/server/supabase.js";
import { runScheduledSync } from "../lib/server/sync/run-sync.js";
import { SYNC_REGISTRY } from "../lib/server/sync/registry.js";
import { shapeSyncStatus } from "../lib/server/sync/status.js";

export const config = { maxDuration: 60 };

// Per-instance fixed-window limiter. The per-bucket DB lock already serialises the
// actual sync; this just blunts accidental double-clicks / abuse.
const RATE = new Map();
function rateLimit(userId, max = 3, windowMs = 60_000) {
  const now = Date.now();
  const hits = (RATE.get(userId) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) { RATE.set(userId, hits); return false; }
  hits.push(now);
  RATE.set(userId, hits);
  return true;
}

const REPORT_LABEL = new Map(SYNC_REGISTRY.map((e) => [e.reportKey, e.label]));
const STATUS_REPORT_KEYS = SYNC_REGISTRY
  .filter((e) => e.enabled && e.partition === "per-account")
  .map((e) => e.reportKey);

async function syncStatusFor(access) {
  const isAdmin = access.role === "admin";
  const accountIds = isAdmin ? undefined : (access.accountIds || []);
  // A non-admin with no assigned accounts sees nothing (and no cross-account leak).
  if (!isAdmin && accountIds.length === 0) return { accounts: [], reportKeys: STATUS_REPORT_KEYS };

  const [directory, targets, snaps] = await Promise.all([
    getAccountDirectoryRows(accountIds || []),
    getSyncTargets({ reportKeys: STATUS_REPORT_KEYS, accountIds }),
    getReportSnapshotsMeta({ reportKeys: STATUS_REPORT_KEYS, accountIds }),
  ]);

  return shapeSyncStatus({
    isAdmin,
    scopeAccountIds: accountIds || [],
    reportKeys: STATUS_REPORT_KEYS,
    labels: Object.fromEntries(REPORT_LABEL),
    directory,
    targets,
    snaps,
  });
}

export default async function handler(req, res) {
  let access;
  try {
    access = await getDashboardAccess(req);
  } catch (err) {
    res.status(err?.status || 401).json({ error: err.message });
    return;
  }

  try {
    if (req.method === "GET") {
      res.status(200).json(await syncStatusFor(access));
      return;
    }
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed." });
      return;
    }
    assertAdmin(access); // throws DashboardAccessError(403) for non-admins
    if (!rateLimit(access.userId)) {
      res.status(429).json({ error: "Too many sync requests. Wait a minute and try again." });
      return;
    }
    const bucket = req.body?.bucket === "us" ? "us" : "non-us";
    await insertAuditLog({ actorUserId: access.userId, action: "sync.now", target: { bucket } });
    const result = await runScheduledSync({ bucket, trigger: "manual-admin", createdBy: access.userId });
    res.status(200).json(result);
  } catch (err) {
    res.status(err?.status || 500).json({ error: err.message });
  }
}
