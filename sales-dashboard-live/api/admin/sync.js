import {
  assertAdmin,
  getAccountDirectoryRows,
  getDashboardAccess,
  getReportSyncSettings,
  getSyncTargets,
  insertAuditLog,
  setReportSyncSetting,
} from "../../lib/server/supabase.js";
import { controlledReport, reportControlCatalog } from "../../lib/server/sync/report-controls.js";
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
  const [settings, targets, accounts] = await Promise.all([
    getReportSyncSettings(),
    getSyncTargets(),
    getAccountDirectoryRows(),
  ]);
  return {
    reports: reportControlCatalog(settings),
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
    const entry = controlledReport(body.reportKey);
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
