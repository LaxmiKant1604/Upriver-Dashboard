// Secure scheduled-sync cron endpoint.
//
//   GET /api/cron/sync?bucket=non-us   (02:00 UTC / 07:30 IST)
//   GET /api/cron/sync?bucket=us       (10:30 UTC / 16:00 IST)
//
// Auth is Vercel-Cron / driver style: Authorization: Bearer <CRON_SECRET>, checked
// by verifyCronRequest (401 without it). A browser user can never reach this.
// One invocation does a bounded (<=~50s) slice and returns { drained }. A driver
// (GitHub Actions loop, see .github/workflows/scheduled-sync.yml) calls it until
// drained:true; the per-bucket lock makes repeated/overlapping calls safe.

import { verifyCronRequest } from "../../lib/server/ads-sync.js";
import { runScheduledSync } from "../../lib/server/sync/run-sync.js";
// Publication recovery WP10b: Scheduler v1 never dispatches a ROUTE-OWNED live report (typed refusal).
import { getReportSyncSettings, isSupabaseConfigured } from "../../lib/server/supabase.js";
import { enabledReportKeys } from "../../lib/server/sync/report-controls.js";
import { splitSchedulerV1ReportKeys, schedulerV1RouteOwnedRefusal } from "../../lib/server/report-store.js";

export const config = { maxDuration: 60 };

// Production collaborators, injectable for narrowly-scoped API-boundary tests (handler(req,res,deps) seam).
const DEFAULT_DEPS = Object.freeze({ verifyCronRequest, runScheduledSync, getReportSyncSettings, isSupabaseConfigured });

export async function handler(req, res, deps = DEFAULT_DEPS) {
  const { verifyCronRequest, runScheduledSync } = { ...DEFAULT_DEPS, ...deps };
  if (!verifyCronRequest(req, res)) return; // sends 401/500 itself
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }
  const bucket = String(req.query?.bucket || "");
  if (bucket !== "us" && bucket !== "non-us") {
    res.status(400).json({ error: "Query param 'bucket' must be 'us' or 'non-us'." });
    return;
  }
  const trigger = String(req.query?.trigger || "cron-vercel");
  try {
    // WP10b: route-owned live keys are REFUSED (typed 409 when nothing else would run -- zero lock / DataDoe); any
    // non-route-owned scheduled key still runs exactly as before (the refused keys are reported alongside).
    // The SAME selection run-sync.js makes for reportKeys = null (enabledReportKeys over report_sync_settings), computed
    // up front minus every route-owned key and passed EXPLICITLY (never null -> never a later re-read that could select
    // a route-owned key). Without Supabase run-sync returns 'supabase-not-configured' before reading anything.
    const d = { ...DEFAULT_DEPS, ...deps };
    const plan = splitSchedulerV1ReportKeys(d.isSupabaseConfigured() ? [...enabledReportKeys(await d.getReportSyncSettings())] : []);
    if (plan.refused.length && !plan.allowed.length) {
      res.status(409).json(schedulerV1RouteOwnedRefusal(plan.refused, { isAdmin: false }));
      return;
    }
    const result = await runScheduledSync({ bucket, trigger, reportKeys: plan.allowed });
    res.status(200).json(plan.refused.length ? { ...result, refusedReportKeys: plan.refused, refusal: "ROUTE_OWNED_REPORT_V1_REFUSED" } : result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "scheduled sync failed" });
  }
}

// Vercel serverless entry: the production handler wired to the real collaborators (DEFAULT_DEPS). No new api/*.js.
export default function (req, res) { return handler(req, res); }
