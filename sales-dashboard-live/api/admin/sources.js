// Data Sync Center -- SOURCE-level controls (Scheduler v2 durable model).
//
// GET   : the source cards for both buckets + the read-only dashboard-readiness summary.
// PATCH : pause/resume ONE source (source_controls). Pause stops NEW source exports only; durable history,
//         coverage, snapshots and every LKG report snapshot are preserved (nothing here can delete them).
// POST  : "Sync missing data" for one bucket -- ONE bounded coverage-driven orchestration run (<=5-account
//         stable batches; already-proven historical coverage is NEVER re-exported; paused sources plan zero
//         exports). Rate-limited and audited. NOTE: the durable-model migration is PREPARED-UNAPPLIED; until
//         it is applied the GET reads report schema-missing markers and POST fails closed on the first
//         durable write -- this endpoint enables nothing by itself and creates no schedule.

import { assertAdmin, getDashboardAccess, insertAuditLog, getSourceControls, getSourceRunStatuses, setSourceControl } from "../../lib/server/supabase.js";
import { shapeSourceCards, dashboardReadinessSummary, CARD_BUCKETS } from "../../lib/server/sync/source-status.js";
import { sourceRegistryEntry } from "../../lib/server/sync/source-registry.js";
import { buildBucketSourceSyncRuntime } from "../../lib/server/sync/source-bucket-sync-runtime.js";

export const config = { maxDuration: 60 };

const RATE = new Map();
function allowManualRun(userId, now = Date.now()) {
  const hits = (RATE.get(userId) || []).filter((time) => now - time < 10 * 60_000);
  if (hits.length >= 4) return false;
  hits.push(now);
  RATE.set(userId, hits);
  return true;
}

function bodyFor(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

async function statusPayload() {
  const [controls, statuses] = await Promise.all([getSourceControls(), getSourceRunStatuses()]);
  const cards = Object.fromEntries(CARD_BUCKETS.map((bucket) => {
    const bucketCards = shapeSourceCards({ bucket, controls: controls.rows, runStatuses: statuses.rows });
    return [bucket, { cards: bucketCards, readiness: dashboardReadinessSummary(bucketCards) }];
  }));
  return {
    buckets: cards,
    reads: { controls: controls.read, runStatuses: statuses.read },
    note: controls.read === "schema-missing"
      ? "The durable source model migration is prepared but not applied; source controls become live after the reviewed migration gate."
      : "Pause stops new source exports only; durable data and last-known-good snapshots are always preserved.",
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

    if (req.method === "PATCH") {
      const sourceKey = String(body.sourceKey || "");
      try { sourceRegistryEntry(sourceKey); } catch {
        res.status(400).json({ error: "Unknown source." });
        return;
      }
      const paused = body.paused === true;
      await setSourceControl({ sourceKey, paused, updatedBy: access.userId });
      await insertAuditLog({
        actorUserId: access.userId,
        action: paused ? "source.paused" : "source.resumed",
        target: { sourceKey },
      });
      res.status(200).json(await statusPayload());
      return;
    }

    if (req.method === "POST") {
      if (!allowManualRun(access.userId)) {
        res.status(429).json({ error: "Source sync limit reached. Wait before trying again." });
        return;
      }
      const bucket = String(body.bucket || "");
      if (bucket !== "us" && bucket !== "non-us") {
        res.status(400).json({ error: "Select the US or non-US marketplace bucket." });
        return;
      }
      const onlySourceKey = body.sourceKey ? String(body.sourceKey) : null;
      if (onlySourceKey) {
        try { sourceRegistryEntry(onlySourceKey); } catch {
          res.status(400).json({ error: "Unknown source." });
          return;
        }
      }
      await insertAuditLog({
        actorUserId: access.userId,
        action: "source.sync.missing",
        target: { bucket, sourceKey: onlySourceKey },
      });
      const runtime = buildBucketSourceSyncRuntime();
      const result = await runtime.run({ bucket, onlySourceKey });
      res.status(200).json({ result, status: await statusPayload() });
      return;
    }

    res.status(405).json({ error: "Method not allowed." });
  } catch (error) {
    res.status(error?.status || 500).json({ error: error?.message || "Source-control request failed." });
  }
}
