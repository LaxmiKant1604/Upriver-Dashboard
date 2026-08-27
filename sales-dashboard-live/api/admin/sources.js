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

import { assertAdmin, getDashboardAccess, insertAuditLog, getSourceControls, getSourceRunStatuses, setSourceControl, getAccountDirectoryRows, getAccountOliQualityCounts } from "../../lib/server/supabase.js";
import { primaryOrganizationFingerprint } from "../../lib/server/datadoe-connections.js";
import { shapeSourceCards, dashboardReadinessSummary, CARD_BUCKETS } from "../../lib/server/sync/source-status.js";
import { sourceRegistryEntry } from "../../lib/server/sync/source-registry.js";
import { buildBucketSourceSyncRuntime } from "../../lib/server/sync/source-bucket-sync-runtime.js";
import { validateSourceSyncRequest, runReleaseSlice, ORCHESTRATED_SOURCE_KEYS } from "../../lib/server/sync/source-sync-operation.js";

export const config = { maxDuration: 60 };

const RATE = new Map();
// A completed manual sync is a POLLED CONTINUATION flow (the UI re-POSTs the same operation until terminal), so
// the per-user window must admit a full multi-slice run; 30/10min still bounds abuse hard (each slice is itself
// deadline-bounded and audited).
function allowManualRun(userId, now = Date.now()) {
  const hits = (RATE.get(userId) || []).filter((time) => now - time < 10 * 60_000);
  if (hits.length >= 30) return false;
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
  // Org fingerprint for the read-only OLI data-quality summary (never a data change, ZERO DataDoe). Best-effort:
  // absence never breaks the source cards.
  let qualityOrgFp = null;
  try { qualityOrgFp = primaryOrganizationFingerprint(); } catch { qualityOrgFp = null; }
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
    // Per-account OLI DATA-QUALITY summary (read-only, ZERO DataDoe): explicit-zero non-cancelled units, cancelled
    // audit units, and the latest dimensional coverage date. Computed in PARALLEL and best-effort -- a per-account
    // failure yields an unavailable marker and never breaks or blocks the source cards.
    let oliQuality = [];
    if (qualityOrgFp && accounts.length) {
      oliQuality = await Promise.all(accounts.map(async (a) => {
        try {
          const counts = await getAccountOliQualityCounts({ organizationFingerprint: qualityOrgFp, accountId: a.accountId });
          return { accountId: a.accountId, ...counts };
        } catch (e) {
          return { accountId: a.accountId, unavailable: e?.code || "QUALITY_READ_FAILED" };
        }
      }));
    }
    cards[bucket] = { cards: bucketCards, cardSummary: dashboardReadinessSummary(bucketCards), readiness, oliQuality };
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
      // Finding 8: `paused` must be an ACTUAL boolean. A missing/malformed value must never coerce into a
      // silent resume (false) -- it is a 400 with ZERO writes (no control write, no audit row).
      if (typeof body.paused !== "boolean") {
        res.status(400).json({ error: "body.paused must be a boolean." });
        return;
      }
      const paused = body.paused;
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
      // Finding 8 + round-5 blocker 3: the FAIL-CLOSED EVIDENCE PREFLIGHT runs BEFORE the endpoint's FIRST
      // write -- including the audit row -- and now sweeps EVERY read execution needs (controls, discovery,
      // coverage, snapshot hydration/integrity, Ads coverage, Ads metrics, OLI history, membership,
      // settings, rollout). Any failure refuses typed with ZERO writes; only a passing preflight is audited
      // and executed, and execution consumes the ONE memoized bundle (no repeated discovery/reads).
      // Round-5 blocker 4: the ONE route-owned deadline is created BEFORE preflight, so preflight time
      // counts against the same route budget that bounds execution.
      const runtime = buildBucketSourceSyncRuntime();
      const deadline = runtime.makeDeadline();
      const preflight = await runtime.preflightEvidence({ bucket, sourceKey: onlySourceKey, deadline });
      // Round-6 fix 4: the AUDIT WRITE is bounded by the SAME route budget and carries the route's
      // AbortSignal into the real HTTP wrapper. A before-request expiry proves zero audit rows; an
      // IN-FLIGHT expiry means the audit row MAY have committed (commitUnknown) -- in both cases the
      // action is refused typed BEFORE any execution write (a duplicate audit row on retry is harmless;
      // an unaudited execution is not).
      await deadline.bound("audit-write", (signal) => insertAuditLog({
        actorUserId: access.userId,
        action: "source.sync.missing",
        target: { bucket, sourceKey: onlySourceKey },
      }, { signal }), { write: true });
      // Finding 4: every registered source card action routes to its REAL architecture (bucket sync /
      // single-family tranche composition / the durable-Ads runner) or refuses TYPED; finding 3: the runtime
      // enforces a real serverless deadline with reserve headroom and returns a typed-resumable rollup.
      //
      // ORCHESTRATED sources (OLI / ads-asin-date / product-catalog) get the FULL trusted flow: sync the ONE
      // selected source, then derive + publish every affected dashboard from the SAME persisted evidence via the
      // shared release engine (open controls -> publish via freshness CAS -> ALWAYS safe-close per slice -> exact
      // live read-back). One request runs ONE bounded slice; `operation.continuationRequired` tells the UI to
      // re-POST the SAME body until `operation.phase === "complete"` -- no duplicate creates on continuation
      // (one-create-per-hash + coverage skip + CAS make every replay idempotent).
      // Round-6 fix 4: the response-status reads share the SAME route budget. An expired budget degrades
      // the refresh to a TYPED unavailable marker -- the action result itself is still reported honestly.
      const boundedStatusFn = async (dl) => {
        try {
          return await dl.bound("status-reads", () => statusPayload());
        } catch (error) {
          if (error && error.code === "ROUTE_DEADLINE_EXCEEDED") return { unavailable: "ROUTE_DEADLINE_EXCEEDED" };
          throw error;
        }
      };
      let operation = null;
      let result = null;
      if (onlySourceKey && ORCHESTRATED_SOURCE_KEYS.includes(onlySourceKey)) {
        const remainingMs = () => Math.max(1000, deadline.deadlineMs - deadline.reserveMs - Date.now());
        const requestedPhase = body.phase == null ? "sync" : String(body.phase);
        if (requestedPhase !== "sync" && requestedPhase !== "release") {
          res.status(400).json({ error: "body.phase must be sync or release." });
          return;
        }
        const asOf = new Date(Date.now() - 86400000).toISOString().slice(0, 10); // server-resolved; never from the body
        // Admin-only "Force latest D-1": force-latest makes the OLI fetch bypass the stale cache (the SAME reviewed
        // runSourceCardAction forceFreshOli path the GitHub force-latest job uses). The route is assertAdmin-gated.
        const request = validateSourceSyncRequest({ bucket, sourceKey: onlySourceKey, origin: "admin-manual", asOf, refreshMode: body.refreshMode == null ? "normal" : String(body.refreshMode) });
        let syncDone = requestedPhase === "release";
        if (!syncDone) {
          if (onlySourceKey === "ads-asin-date") {
            const { runAsinAdsBucketSlice } = await import("../../lib/server/sync/scheduled-asin-ads-runner.js");
            const ads = await runAsinAdsBucketSlice({
              bucket, asOf,
              deps: { workerDeps: { workBudgetMs: Math.min(remainingMs() - 4000, 35_000) } },
            });
            if (ads.phase !== "complete") {
              operation = ads.continuationRequired === true
                ? { phase: "sync", continuationRequired: true, creates: ads.creates || 0, tokens: ads.tokens || 0 }
                : { phase: "sync", ok: false, problems: ads.problems || [] };
            } else { syncDone = true; result = { adsSync: ads }; }
          } else {
            const rollup = await runtime.runSourceCardAction({ bucket, sourceKey: onlySourceKey, deadline, preflight, forceFreshOli: request.forceFreshOli === true });
            if (rollup && rollup.refused === true) { res.status(409).json({ refusal: rollup, status: await boundedStatusFn(deadline) }); return; }
            if (rollup && rollup.stopped === true) {
              operation = { phase: "sync", ok: false, problems: ["source sync stopped: " + String(rollup.stopReason && rollup.stopReason.code)] };
            } else if (rollup && rollup.continuationRequired === true) {
              operation = { phase: "sync", continuationRequired: true };
            } else { syncDone = true; result = { sourceSync: { cycleId: rollup && rollup.cycleId ? String(rollup.cycleId).slice(0, 8) : null, globalDrained: rollup ? rollup.globalDrained : null } }; }
          }
        }
        if (syncDone && !operation) {
          // RELEASE slice: derive + finalize + preflight-all + open/publish/ALWAYS-safe-close + read-back. The
          // controls store and release surface are the SAME reviewed implementations the operators use.
          const { buildPriorityDashboardsRelease } = await import("../../lib/server/sync/source-priority-dashboards.js");
          const { buildLiveReadback } = await import("../../lib/server/sync/source-priority-release-runner.js");
          const { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } = await import("../../lib/server/sync/report-publisher.js");
          const { REPORT_DERIVATIONS } = await import("../../lib/server/sync/report-derivation.js");
          const { paramsHashFor } = await import("../../lib/server/report-store.js");
          const { runControlPackageCli } = await import("../../lib/server/sync/source-priority-control-package.js");
          const { CONTROLLED_REPORT_KEYS } = await import("../../lib/server/sync/report-controls.js");
          const { connectPriorityControlStore, discoverPrimaryAccountIds } = await import("../../lib/server/sync/priority-control-pg-store.js");
          const sbMod = await import("../../lib/server/supabase.js");
          const release = buildPriorityDashboardsRelease({ budgetMs: remainingMs(), asOfOverride: request.asOf, operationKey: request.operationKey });
          const readbackLive = buildLiveReadback({
            getReportSnapshot: sbMod.getReportSnapshot,
            loadStoragePayload: sbMod.getReportSnapshotStoragePayload,
            liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS,
            reportDerivations: REPORT_DERIVATIONS,
            computeHash: paramsHashFor,
          });
          const operator = access.userId ? "admin:" + String(access.userId) : "admin:data-sync-center";
          const controls = {
            apply: async () => {
              const r = await runControlPackageCli({ mode: "apply", operator, discoverAccounts: discoverPrimaryAccountIds, connectStore: connectPriorityControlStore, controlledReportKeys: CONTROLLED_REPORT_KEYS });
              if (!r || r.committed !== true) throw new Error("controls apply did not commit");
            },
            close: async () => {
              const r = await runControlPackageCli({ mode: "rollback", operator, connectStore: connectPriorityControlStore, controlledReportKeys: CONTROLLED_REPORT_KEYS });
              if (!r || r.committed !== true) throw new Error("SAFE-CLOSE did not commit -- verify controls");
            },
          };
          const rel = await runReleaseSlice({ bucket, release, controls, readbackLive, outOfTime: deadline.outOfTime });
          operation = rel.phase === "complete" && rel.ok === true
            ? { phase: "complete", ok: true, published: rel.published, readback: rel.readback }
            : rel.continuationRequired === true
              ? { phase: "release", continuationRequired: true, detail: rel.phase, published: rel.published ?? null }
              : { phase: rel.phase, ok: false, problems: rel.problems || [] };
        }
        const status = await boundedStatusFn(deadline);
        res.status(200).json({ operation, result, status });
        return;
      }
      result = onlySourceKey
        ? await runtime.runSourceCardAction({ bucket, sourceKey: onlySourceKey, deadline, preflight })
        : await runtime.run({ bucket, deadline, preflight });
      if (result && result.refused === true) {
        res.status(409).json({ refusal: result, status: await boundedStatusFn(deadline) });
        return;
      }
      res.status(200).json({ result, status: await boundedStatusFn(deadline) });
      return;
    }

    res.status(405).json({ error: "Method not allowed." });
  } catch (error) {
    res.status(error?.status || 500).json({ error: error?.message || "Source-control request failed." });
  }
}
