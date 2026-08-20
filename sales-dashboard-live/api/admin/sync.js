import {
  assertAdmin,
  getAccountDirectoryRows,
  getDashboardAccess,
  getReportSyncSettings,
  getSourcePromotedPublishSettings,
  getSyncTargets,
  insertAuditLog,
  setReportSyncSetting,
  setSourcePromotedPublishControl,
} from "../../lib/server/supabase.js";
import { controlledReport, reportControlCatalog, SOURCE_PROMOTED_REPORT_KEYS } from "../../lib/server/sync/report-controls.js";
import { runScheduledSync } from "../../lib/server/sync/run-sync.js";

export const config = { maxDuration: 60 };

const RATE = new Map();
function allowManualRun(userId, now = Date.now()) {
  const hits = (RATE.get(userId) || []).filter((time) => now - time < 10 * 60_000);
  if (hits.length >= 6) return false;
  hits.push(now);
  RATE.set(userId, hits);
  return true;
}

function bodyFor(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); }
    catch { return {}; }
  }
  return req.body;
}

async function statusPayload() {
  const [settings, promoted, targets, accounts] = await Promise.all([
    getReportSyncSettings(),
    getSourcePromotedPublishSettings(),
    getSyncTargets(),
    getAccountDirectoryRows(),
  ]);
  // Round-6 blocker 2: the source-promoted publication controls are a SEPARATE surface, default OFF, and
  // are NOT dispatchable (no bucket/manual-run action) -- a dispatch would need a controlled report.
  const promotedByKey = new Map((promoted || []).map((row) => [String(row.report_key ?? row.reportKey), row]));
  const promotedControls = SOURCE_PROMOTED_REPORT_KEYS.map((reportKey) => {
    const row = promotedByKey.get(reportKey) || {};
    return {
      reportKey,
      publishEnabled: row.publish_enabled === true,
      dispatchable: false,
      surface: "source-promoted-publication",
      updatedAt: row.updated_at || null,
    };
  });
  return {
    reports: reportControlCatalog(settings),
    promotedPublish: promotedControls,
    targets,
    accounts,
    schedule: {
      nonUs: "07:30 IST",
      us: "16:00 IST",
      note: "Automatic kickoff remains paused until Scheduler v2 production rollout is approved.",
    },
  };
}

export default async function handler(req, res) {
  try {
    const access = await getDashboardAccess(req);
    assertAdmin(access);

    if (req.method === "GET") {
      res.status(200).json(await statusPayload());
      return;
    }

    const body = bodyFor(req);
    const requestedKey = String(body.reportKey || "");

    // Round-6 blocker 2: SOURCE-PROMOTED publication control (brand-inventory) is a SEPARATE, reviewed
    // operator surface. It writes ONLY source_promoted_publish_settings (never report_sync_settings), and it
    // can NEVER be dispatched: a manual-run (POST) for a promoted key is refused, so this surface cannot
    // accidentally spend a DataDoe export. The dispatchable-report path below is left completely unchanged.
    if (SOURCE_PROMOTED_REPORT_KEYS.includes(requestedKey)) {
      if (req.method === "PATCH") {
        const publishEnabled = body.publishEnabled === true;
        await setSourcePromotedPublishControl({ reportKey: requestedKey, publishEnabled, updatedBy: access.userId });
        await insertAuditLog({
          actorUserId: access.userId,
          action: publishEnabled ? "report.promoted-publish.enabled" : "report.promoted-publish.revoked",
          target: { reportKey: requestedKey },
        });
        res.status(200).json(await statusPayload());
        return;
      }
      if (req.method === "POST") {
        res.status(409).json({ error: "This report is produced by the source-first runtime and promoted through the reviewed publisher; it is not dispatchable from the report sync surface." });
        return;
      }
      res.status(405).json({ error: "Method not allowed." });
      return;
    }

    const entry = controlledReport(requestedKey);
    if (!entry) {
      res.status(400).json({ error: "Unknown report." });
      return;
    }
    if (!entry.enabled) {
      res.status(409).json({ error: "This report is locked until its Scheduler v2 adapter passes verification." });
      return;
    }

    if (req.method === "PATCH") {
      const scheduleEnabled = body.scheduleEnabled === true;
      await setReportSyncSetting({ reportKey: entry.reportKey, scheduleEnabled, updatedBy: access.userId });
      await insertAuditLog({
        actorUserId: access.userId,
        action: scheduleEnabled ? "report.schedule.enabled" : "report.schedule.paused",
        target: { reportKey: entry.reportKey },
      });
      res.status(200).json(await statusPayload());
      return;
    }

    if (req.method === "POST") {
      if (!allowManualRun(access.userId)) {
        res.status(429).json({ error: "Manual sync limit reached. Wait before trying again." });
        return;
      }
      const bucket = String(body.bucket || "");
      if (bucket !== "us" && bucket !== "non-us") {
        res.status(400).json({ error: "Select the US or non-US marketplace bucket." });
        return;
      }
      const accountId = body.accountId ? String(body.accountId) : null;
      await insertAuditLog({
        actorUserId: access.userId,
        action: "report.sync.manual",
        target: { reportKey: entry.reportKey, bucket, accountId },
      });
      const result = await runScheduledSync({
        bucket,
        trigger: "manual-report",
        createdBy: access.userId,
        reportKeys: [entry.reportKey],
        accountIds: accountId ? [accountId] : null,
      });
      res.status(200).json({ result, status: await statusPayload() });
      return;
    }

    res.status(405).json({ error: "Method not allowed." });
  } catch (error) {
    res.status(error?.status || 500).json({ error: error?.message || "Sync-control request failed." });
  }
}
