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
  getReportSyncSettings, isSupabaseConfigured,
} from "../lib/server/supabase.js";
import { runScheduledSync } from "../lib/server/sync/run-sync.js";
import { SYNC_REGISTRY } from "../lib/server/sync/registry.js";
import { shapeSyncStatus } from "../lib/server/sync/status.js";
// Publication recovery WP10b: Scheduler v1 never dispatches a ROUTE-OWNED live report (typed refusal).
import { enabledReportKeys } from "../lib/server/sync/report-controls.js";
import { splitSchedulerV1ReportKeys, schedulerV1RouteOwnedRefusal } from "../lib/server/report-store.js";

export const config = { maxDuration: 60 };

// Production collaborators, injectable for narrowly-scoped API-boundary tests (handler(req,res,deps) seam).
const DEFAULT_DEPS = Object.freeze({ getDashboardAccess, assertAdmin, insertAuditLog, getReportSyncSettings, isSupabaseConfigured, runScheduledSync });

/**
 * WP10b: the EXPLICIT report keys a bucket-wide Scheduler-v1 run may dispatch. Today's run (reportKeys = null) selects
 * enabledReportKeys(report_sync_settings) inside run-sync.js; this computes the SAME selection up front and removes every
 * ROUTE-OWNED live key (run-sync.js / report-adapter.js are an UNFENCED writer: save + prune + retention DELETE), so the
 * run is always called with an explicit allow-list (never null -> never a later re-read that could select brand-sales).
 * Without Supabase run-sync returns 'supabase-not-configured' before reading anything, so [] is passed unchanged.
 */
export async function schedulerV1BucketPlan(deps = DEFAULT_DEPS) {
  const scheduled = deps.isSupabaseConfigured() ? [...enabledReportKeys(await deps.getReportSyncSettings())] : [];
  return splitSchedulerV1ReportKeys(scheduled);
}

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

export async function handler(req, res, deps = DEFAULT_DEPS) {
  const { getDashboardAccess, assertAdmin, insertAuditLog, runScheduledSync } = { ...DEFAULT_DEPS, ...deps };
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
    const bucket = String(req.body?.bucket || "");
    if (bucket !== "us" && bucket !== "non-us") {
      res.status(400).json({ error: "Body field 'bucket' must be 'us' or 'non-us'." });
      return;
    }
    // WP10b: route-owned live keys are REFUSED (typed 409 when nothing else would run -- zero audit / lock / DataDoe);
    // any non-route-owned scheduled key still runs exactly as before (the refused keys are reported alongside).
    const plan = await schedulerV1BucketPlan({ ...DEFAULT_DEPS, ...deps });
    if (plan.refused.length && !plan.allowed.length) {
      res.status(409).json(schedulerV1RouteOwnedRefusal(plan.refused, { isAdmin: true }));
      return;
    }
    await insertAuditLog({ actorUserId: access.userId, action: "sync.now", target: { bucket } });
    const result = await runScheduledSync({ bucket, trigger: "manual-admin", createdBy: access.userId, reportKeys: plan.allowed });
    res.status(200).json(plan.refused.length ? { ...result, refusedReportKeys: plan.refused, refusal: "ROUTE_OWNED_REPORT_V1_REFUSED" } : result);
  } catch (err) {
    res.status(err?.status || 500).json({ error: err.message });
  }
}

// Vercel serverless entry: the production handler wired to the real collaborators (DEFAULT_DEPS). No new api/*.js.
export default function (req, res) { return handler(req, res); }
