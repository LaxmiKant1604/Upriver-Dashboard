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
import { isFbaOperationSource, resolveFbaPlanScope, planFbaBucketCost, fbaBucketAccounts, advanceFbaPlanBucket, fbaServerCeiling, fbaCycleBucket, fbaInventoryAsOf } from "../../lib/server/sync/fba-plan-operation.js";
// The ONE ASIN->Campaign cutover authority: reject a forged action on the retired ads grain at the API BOUNDARY,
// after auth + source-key parse, BEFORE any runtime / preflight / coverage / discovery / control-or-audit write.
import { isAdsRegistryKeyRetired } from "../../lib/server/active-ads-source.js";

export const config = { maxDuration: 60 };

// Production collaborators, injectable for narrowly-scoped API-boundary tests (the established handler(req,res,deps)
// pattern). The default export wires exactly these; authorization + production imports are never weakened.
const DEFAULT_DEPS = Object.freeze({
  getDashboardAccess, assertAdmin, insertAuditLog, getSourceControls, getSourceRunStatuses, setSourceControl,
  getAccountDirectoryRows, getAccountOliQualityCounts, primaryOrganizationFingerprint, buildBucketSourceSyncRuntime,
  isAdsRegistryKeyRetired,
});

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

async function statusPayload(deps = DEFAULT_DEPS) {
  const { getSourceControls, getSourceRunStatuses, getAccountDirectoryRows, getAccountOliQualityCounts, primaryOrganizationFingerprint, buildBucketSourceSyncRuntime } = deps;
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

export async function handler(req, res, deps = DEFAULT_DEPS) {
  try {
    const access = await deps.getDashboardAccess(req);
    deps.assertAdmin(access);

    if (req.method === "GET") {
      res.status(200).json(await statusPayload(deps));
      return;
    }

    const body = bodyFor(req);

    if (req.method === "PATCH") {
      const sourceKey = String(body.sourceKey || "");
      try { sourceRegistryEntry(sourceKey); } catch {
        res.status(400).json({ error: "Unknown source." });
        return;
      }
      // ATOMIC ADS CUTOVER -- retired-source refusal at the API BOUNDARY, immediately after the source key is
      // parsed + validated and BEFORE setSourceControl / insertAuditLog / statusPayload (or any other write). A
      // forged PATCH on the retired ASIN grain can never mutate its hidden control. Runtime-level guards remain
      // (SOURCE_ACTION_ADS_ARCHITECTURE + the ads-sync export guard) as defense in depth.
      if (deps.isAdsRegistryKeyRetired(sourceKey)) {
        res.status(409).json({ error: "SOURCE_RETIRED", sourceKey, message: "This source is retained only for rollback and cannot be operated while Campaign Ads is active." });
        return;
      }
      // Finding 8: `paused` must be an ACTUAL boolean. A missing/malformed value must never coerce into a
      // silent resume (false) -- it is a 400 with ZERO writes (no control write, no audit row).
      if (typeof body.paused !== "boolean") {
        res.status(400).json({ error: "body.paused must be a boolean." });
        return;
      }
      const paused = body.paused;
      await deps.setSourceControl({ sourceKey, paused, updatedBy: access.userId });
      await deps.insertAuditLog({
        actorUserId: access.userId,
        action: paused ? "source.paused" : "source.resumed",
        target: { sourceKey },
      });
      res.status(200).json(await statusPayload(deps));
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
      // ATOMIC ADS CUTOVER -- retired-source refusal at the API BOUNDARY, immediately after the source key is
      // parsed + validated and BEFORE runtime construction / preflightEvidence / coverage reads / discovery /
      // audit writes / any DataDoe / token-or-create activity. A forged POST on the retired ASIN grain can never
      // reach the sync path. Runtime-level guards remain (SOURCE_ACTION_ADS_ARCHITECTURE + the ads-sync export
      // guard) as defense in depth.
      if (onlySourceKey && deps.isAdsRegistryKeyRetired(onlySourceKey)) {
        res.status(409).json({ error: "SOURCE_RETIRED", sourceKey: onlySourceKey, message: "This source is retained only for rollback and cannot be operated while Campaign Ads is active." });
        return;
      }

      // ---------------- FBA Shipment Plan sync (fba-inventory-health / US Listings-AWD) ----------------
      // The FBA source cards run the SHARED, decoupled fba-plan operation core -- the SAME deadline-aware,
      // bounded-resumable pipeline the CLI operator + the automatic GitHub scheduler use (batched marketplace-safe
      // FBA Health/AWD fetch -> durable OLI + Catalog derive -> four-gate CAS publish -> exact live read-back ->
      // ownership backfill -> ALWAYS safe-close). There is NO parallel implementation. ONE bounded slice per POST;
      // the UI re-POSTs the SAME body until phase==="complete". The durable operation identity (the DEDICATED
      // `${bucket}-fba` cycle at server-resolved as-of=D-1) makes every replay -- concurrent poll, retry, or the
      // scheduled fallback -- a zero-create idempotent no-op (never a duplicate export or double-spent token), and
      // an FBA failure NEVER touches Daily Reporting / Brand View (separate cycle namespace + control envelope).
      if (onlySourceKey && isFbaOperationSource(onlySourceKey)) {
        const fbaDeadline = deps.buildBucketSourceSyncRuntime().makeDeadline();
        // Audit BEFORE any execution write, bounded by the same route budget (a duplicate audit row on a retry is
        // harmless; an unaudited execution is not).
        await fbaDeadline.bound("audit-write", (signal) => deps.insertAuditLog({
          actorUserId: access.userId, action: "source.sync.missing", target: { bucket, sourceKey: onlySourceKey, family: "fba-plan" },
        }, { signal }), { write: true });
        const boundedStatusFn = async (dl) => {
          try { return await dl.bound("status-reads", () => statusPayload(deps)); }
          catch (error) { if (error && error.code === "ROUTE_DEADLINE_EXCEEDED") return { unavailable: "ROUTE_DEADLINE_EXCEEDED" }; throw error; }
        };
        const operator = access.userId ? "admin:" + String(access.userId) : "admin:data-sync-center";
        // The reviewed fba-plan RELEASE SEAM wires runtime/publisher/controls/read-back/ownership (the route
        // never touches the publisher composition, the CAS primitive, or the control internals itself).
        const { buildFbaPlanRelease } = await import("../../lib/server/sync/fba-plan-release-composition.js");
        // Round-8 blocker 2: a CRYPTOGRAPHICALLY-UNIQUE token PER HTTP EXECUTION (never derived from
        // operator/bucket). Each bounded slice fully applies -> publishes -> safe-closes -> RELEASES the lease,
        // so successive polls each re-acquire cleanly; two concurrent same-admin+bucket requests get DIFFERENT
        // tokens and contend -- one wins, the other defers WITHOUT altering the winner's controls.
        const { randomUUID } = await import("node:crypto");
        const controlOwnerToken = "route-fba:" + bucket + ":" + randomUUID();
        const release = buildFbaPlanRelease({ operator, ownerToken: controlOwnerToken, controlOperationKey: "route-fba/" + bucket });
        try {
          // Respect an explicit source pause (parity with the OLI path): an admin who paused this FBA source must
          // not have it synced. Fail closed on an unreadable control table (never a silent create).
          const controlsRead = await fbaDeadline.bound("controls-read", () => deps.getSourceControls());
          if (controlsRead && controlsRead.read !== "ok") throw Object.assign(new Error("source controls unavailable (migration/read)"), { status: 503 });
          const pausedSet = new Set((controlsRead.rows || []).filter((r) => r.paused === true).map((r) => r.source_key));
          if (pausedSet.has(onlySourceKey)) {
            res.status(409).json({ operation: { phase: "sync", ok: false, problems: ["source \"" + onlySourceKey + "\" is paused; resume it before syncing"] }, status: await boundedStatusFn(fbaDeadline) });
            return;
          }
          const accounts = await release.loadAccounts();
          if (!accounts.length) { res.status(200).json({ operation: { phase: "sync", ok: false, problems: ["no primary accounts with directory metadata"] }, status: await boundedStatusFn(fbaDeadline) }); return; }

          // The go-live as-of is resolved GLOBALLY (across all accounts), identical to the CLI/scheduler, so the
          // dedicated operation identity is the SAME regardless of which path or bucket triggers it.
          const bucketAccounts = fbaBucketAccounts(accounts, bucket);
          const inventoryAsOf = fbaInventoryAsOf();
          const scope = await resolveFbaPlanScope({ accounts: bucketAccounts, connections: release.connections, asOfArg: null, maxBlocked: 2, ceiling: fbaServerCeiling(), readers: release.scopeReaders });
          if (!scope.asOf) { res.status(200).json({ operation: { phase: "sync", ok: false, problems: ["no account has durable OLI coverage; cannot resolve an as-of"] }, status: await boundedStatusFn(fbaDeadline) }); return; }
          if (!bucketAccounts.length) { res.status(200).json({ operation: { phase: "complete", ok: true, published: 0, note: "no-bucket-accounts" }, status: await boundedStatusFn(fbaDeadline) }); return; }
          // Skip the FETCH-only cost plan when the dedicated cycle is already terminal: a publish-only pass has
          // nothing to fetch (no token gate needed), and the plan/adopt reads would only slow the bounded slice.
          const existingCycle = await release.runtime.store.getCycleByBucketDate(fbaCycleBucket(bucket), inventoryAsOf).catch(() => null);
          const terminal = existingCycle && ["succeeded", "partial", "failed"].includes(String(existingCycle.status));
          const cost = terminal ? null : (await planFbaBucketCost({ bucketAccounts, connections: release.connections, asOf: scope.asOf, inventoryAsOf, getSourceExportCache: release.getSourceExportCache })).cost;
          const includedIds = scope.included.filter((id) => bucketAccounts.some((a) => a.accountId === id));
          const maxTokens = bucket === "us" ? 30 : 70; // per-bucket share of the 80-token daily ceiling (scheduler parity)

          const result = await advanceFbaPlanBucket({
            bucket, asOf: scope.asOf, inventoryAsOf, includedIds, bucketAccounts, cost, maxTokens,
            runtime: release.runtime, publisher: release.publisher, controls: release.controls,
            readbackLive: release.readbackLive, ownershipBackfill: release.ownershipBackfill,
            verifyLease: release.verifyLease,
            // ZERO-EXPORT durable FBA source persist (backstop enabler): lands source_snapshots(fba-inventory-health)
            // from the just-fetched cache when a manual sync drains in one slice (the scheduled go-live is authoritative).
            persistDurableFbaSnapshots: release.persistDurableFbaSnapshots,
            trigger: "vercel", deadlineMs: fbaDeadline.deadlineMs, reserveMs: fbaDeadline.reserveMs, outOfTime: fbaDeadline.outOfTime,
          });
          // P1-D: a lost control-lease fence (write-boundary or heartbeat) is a TYPED RETRYABLE 409, never a
          // generic 500 or a silent continuation.
          if (result.leaseLost === true || result.phase === "contention") {
            res.status(409).json({ operation: { phase: "contention", ok: false, retryable: true, status: "CONTROL_LEASE_LOST", problems: result.problems || [] }, result: { fbaPlan: { operationId: result.operationId } }, status: await boundedStatusFn(fbaDeadline) });
            return;
          }
          const operation = result.phase === "complete" && result.ok === true
            ? { phase: "complete", ok: true, published: result.published, readback: result.readback, accounts: result.accounts, batches: result.batches, creates: result.creates, tokens: result.tokens, blocked: result.blocked }
            : result.continuationRequired === true
              ? { phase: result.phase, continuationRequired: true, published: result.published, accounts: result.accounts, batches: result.batches, creates: result.creates, tokens: result.tokens }
              : { phase: result.phase, ok: false, problems: result.problems || ["typed failure"], published: result.published };
          res.status(200).json({ operation, result: { fbaPlan: { operationId: result.operationId, asOf: scope.asOf, includedAccounts: includedIds.length, blockedAccounts: result.blocked } }, status: await boundedStatusFn(fbaDeadline) });
          return;
        } catch (error) {
          // Safety net: the core ALWAYS safe-closes in its own finally, but a throw before/around a pass could
          // leave gates open -- close them explicitly (idempotent) through the same release seam before surfacing.
          try { await release.controls.close(); } catch { /* the original error is surfaced below */ }
          // P1-D: a control-lease HELD/LOST is a TYPED RETRYABLE contention (423 Locked -- another operation owns
          // the global control plane), never a generic 500. The client retries; nothing was overwritten.
          const msg = String(error?.message || "fba sync failed");
          if (/CONTROL_LEASE_HELD|CONTROL_LEASE_LOST/.test(msg)) {
            res.status(423).json({ operation: { phase: "contention", ok: false, retryable: true, status: "CONTROL_LEASE_HELD", problems: [msg] } });
            return;
          }
          res.status(error?.status || 500).json({ operation: { phase: "sync", ok: false, problems: [msg] } });
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
      const runtime = deps.buildBucketSourceSyncRuntime();
      const deadline = runtime.makeDeadline();
      const preflight = await runtime.preflightEvidence({ bucket, sourceKey: onlySourceKey, deadline });
      // Round-6 fix 4: the AUDIT WRITE is bounded by the SAME route budget and carries the route's
      // AbortSignal into the real HTTP wrapper. A before-request expiry proves zero audit rows; an
      // IN-FLIGHT expiry means the audit row MAY have committed (commitUnknown) -- in both cases the
      // action is refused typed BEFORE any execution write (a duplicate audit row on retry is harmless;
      // an unaudited execution is not).
      await deadline.bound("audit-write", (signal) => deps.insertAuditLog({
        actorUserId: access.userId,
        action: "source.sync.missing",
        target: { bucket, sourceKey: onlySourceKey },
      }, { signal }), { write: true });
      // Finding 4: every registered source card action routes to its REAL architecture (bucket sync /
      // single-family tranche composition / the durable-Ads runner) or refuses TYPED; finding 3: the runtime
      // enforces a real serverless deadline with reserve headroom and returns a typed-resumable rollup.
      //
      // ORCHESTRATED sources (OLI / ads-campaign-date / product-catalog) get the FULL trusted flow: sync the ONE
      // selected source, then derive + publish every affected dashboard from the SAME persisted evidence via the
      // shared release engine (open controls -> publish via freshness CAS -> ALWAYS safe-close per slice -> exact
      // live read-back). One request runs ONE bounded slice; `operation.continuationRequired` tells the UI to
      // re-POST the SAME body until `operation.phase === "complete"` -- no duplicate creates on continuation
      // (one-create-per-hash + coverage skip + CAS make every replay idempotent).
      // Round-6 fix 4: the response-status reads share the SAME route budget. An expired budget degrades
      // the refresh to a TYPED unavailable marker -- the action result itself is still reported honestly.
      const boundedStatusFn = async (dl) => {
        try {
          return await dl.bound("status-reads", () => statusPayload(deps));
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
          if (onlySourceKey === "ads-campaign-date") {
            const { runCampaignAdsBucketSlice } = await import("../../lib/server/sync/scheduled-campaign-ads-runner.js");
            const ads = await runCampaignAdsBucketSlice({
              bucket, asOf, runKind: "daily",
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
          const operator = access.userId ? "admin:" + String(access.userId) : "admin:data-sync-center";
          // Round-8 blocker 2: a CRYPTOGRAPHICALLY-UNIQUE token per HTTP execution (never derived from
          // operator/bucket). Each release slice applies -> publishes -> safe-closes -> releases, so two
          // concurrent same-admin+bucket requests get different tokens and one defers without altering the other.
          const { randomUUID: randomPriorityToken } = await import("node:crypto");
          const priorityOwnerToken = "route-priority:" + bucket + ":" + randomPriorityToken();
          // Round-9 P0-A/P0-B: the fence captured at controls.apply. getControlFence makes the release's publisher
          // control-enabled, so EVERY priority report write fences this exact fence inside the report_snapshots CAS.
          let priorityFence = null;
          const release = buildPriorityDashboardsRelease({ budgetMs: remainingMs(), asOfOverride: request.asOf, operationKey: request.operationKey, getControlFence: () => priorityFence });
          const readbackLive = buildLiveReadback({
            getReportSnapshot: sbMod.getReportSnapshot,
            loadStoragePayload: sbMod.getReportSnapshotStoragePayload,
            liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS,
            reportDerivations: REPORT_DERIVATIONS,
            computeHash: paramsHashFor,
          });
          const controls = {
            apply: async () => {
              const r = await runControlPackageCli({ mode: "apply", operator, discoverAccounts: discoverPrimaryAccountIds, connectStore: connectPriorityControlStore, controlledReportKeys: CONTROLLED_REPORT_KEYS, ownerToken: priorityOwnerToken, operationKey: "route-priority/" + bucket });
              if (!r || r.committed !== true) throw new Error("controls apply did not commit" + (r && r.problem ? ": " + r.problem : ""));
              // Round-10 (blocker 6): require a VALID fencing generation IMMEDIATELY -- never continue with a null fence.
              const g = Number(r.leaseGeneration);
              if (!(Number.isSafeInteger(g) && g > 0)) throw new Error("CONTROL_LEASE_NO_GENERATION: controls apply returned no valid fencing generation -- refusing to publish (fail closed).");
              priorityFence = { ownerToken: priorityOwnerToken, generation: g };
            },
            close: async () => {
              const r = await runControlPackageCli({ mode: "rollback", operator, connectStore: connectPriorityControlStore, controlledReportKeys: CONTROLLED_REPORT_KEYS, ownerToken: priorityOwnerToken, ownerGeneration: priorityFence ? priorityFence.generation : null, operationKey: "route-priority/" + bucket });
              if (r && r.skipped === "lease-not-owner") { priorityFence = null; return; } // lost the lease: closes nothing (correct no-op)
              if (!r || r.committed !== true) throw new Error("SAFE-CLOSE did not commit -- verify controls");
              priorityFence = null;
            },
          };
          let rel;
          try {
            rel = await runReleaseSlice({ bucket, release, controls, readbackLive, outOfTime: deadline.outOfTime });
          } catch (relErr) {
            // P1-D: apply could not acquire the global lease (another operation owns it) -> TYPED RETRYABLE 423.
            const rm = String(relErr?.message || "release slice failed");
            if (/CONTROL_LEASE_HELD|CONTROL_LEASE_LOST/.test(rm)) {
              res.status(423).json({ operation: { phase: "contention", ok: false, retryable: true, status: "CONTROL_LEASE_HELD", problems: [rm] }, result, status: await boundedStatusFn(deadline) });
              return;
            }
            throw relErr;
          }
          // P1-D: control-lease contention (fence lost mid-publish) is a TYPED RETRYABLE 409, never a generic 500.
          if (rel.leaseLost === true || rel.status === "CONTROL_LEASE_LOST") {
            res.status(409).json({ operation: { phase: "contention", ok: false, retryable: true, status: "CONTROL_LEASE_LOST", problems: rel.problems || [] }, result, status: await boundedStatusFn(deadline) });
            return;
          }
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

// Vercel serverless entry: the production handler wired to the real collaborators (DEFAULT_DEPS). This adds NO new
// api/*.js function -- it is the same single endpoint, now with the established handler(req, res, deps) test seam.
export default function (req, res) { return handler(req, res); }
