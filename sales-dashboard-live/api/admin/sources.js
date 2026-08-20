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

import { assertAdmin, getDashboardAccess, insertAuditLog, getSourceControls, getSourceRunStatuses, setSourceControl, getAccountDirectoryRows } from "../../lib/server/supabase.js";
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
  // Finding 8: dashboard readiness comes from AUTHORITATIVE per-account durable evidence (coverage /
  // snapshot freshness / per-account Ads windows), gathered per bucket from the account directory --
  // last_status cards remain the quick health summary but never decide readiness. A gathering failure is a
  // TYPED unavailable readiness, never a fabricated "ready" and never a 500 for the whole surface.
  let directoryRows = [];
  try { directoryRows = (await getAccountDirectoryRows()) || []; } catch { directoryRows = []; }
  const runtime = buildBucketSourceSyncRuntime();
  const cards = {};
  for (const bucket of CARD_BUCKETS) {
    const bucketCards = shapeSourceCards({ bucket, controls: controls.rows, runStatuses: statuses.rows });
    const accounts = directoryRows
      .filter((r) => (r.sync_bucket || "") === bucket && r.account_id && !String(r.account_id).includes(":"))
      .map((r) => ({ accountId: String(r.account_id) }));
    let readiness;
    try {
      readiness = accounts.length
        ? await runtime.gatherDurableReadiness({ bucket, accounts })
        : { unavailable: "no-bucket-accounts" };
    } catch (error) {
      readiness = { unavailable: error?.code || "READINESS_GATHER_FAILED" };
    }
    cards[bucket] = { cards: bucketCards, cardSummary: dashboardReadinessSummary(bucketCards), readiness };
  }
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
      // Finding 4: every registered source card action routes to its REAL architecture (bucket sync /
      // fixpoint composition) or refuses TYPED (durable-ads); finding 3: the runtime enforces a real
      // serverless deadline with reserve headroom and returns a typed-resumable rollup.
      const runtime = buildBucketSourceSyncRuntime();
      const result = onlySourceKey
        ? await runtime.runSourceCardAction({ bucket, sourceKey: onlySourceKey })
        : await runtime.run({ bucket });
      if (result && result.refused === true) {
        res.status(409).json({ refusal: result, status: await statusPayload() });
        return;
      }
      res.status(200).json({ result, status: await statusPayload() });
      return;
    }

    res.status(405).json({ error: "Method not allowed." });
  } catch (error) {
    res.status(error?.status || 500).json({ error: error?.message || "Source-control request failed." });
  }
}
