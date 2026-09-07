// Scheduler v2 -- Gate-7 TRUSTED PUBLISHER COMPOSITION (production wiring for the pure publisher core).
//
// The pure core (report-publisher.js) is DI-only and imports no I/O module; THIS file is the one place the
// production collaborators are bound to it, mirroring runtime-composition.js: injection happens ONLY at
// BUILD time (tests pass doubles to buildSchedulerV2Publisher), and the composed `publish(reportKey,
// accountId)` accepts EXACTLY two identifier strings -- a caller can never supply, replace, or widen the
// code-readiness set, the discovery, the rollout/approval readers, the job/snapshot readers, the storage
// hydration, or the CAS persistence. Discovery is FRESH per composition and MEMOIZED across publishes within
// it (one directory read even when several (report, account) pairs are published in a batch).
//
// NOTHING wires this composition into a route, cron, schedule, or the dispatcher in this tranche: publishing
// stays a deliberate, operator-driven act behind the four durable gates the core enforces.

import { publishSchedulerV2Snapshot } from "./report-publisher.js";
import { SCHEDULER_V2_PUBLISHABLE_REPORT_KEYS } from "./report-publisher.js";
import { makeProductionDiscoverAccounts } from "./runtime-composition.js";
import { getDataDoeConnections, classifyDirectoryAccounts } from "../datadoe-connections.js";
import { fetchAccounts as fetchDataDoeAccounts } from "../datadoe.js";
import {
  getReportSyncSettings, getSourcePromotedPublishSettings, getSchedulerAccountRollout, getSchedulerPublishApproval,
  getLatestSyncReportJob, getReportSnapshot, getReportSnapshotStoragePayload, publishLiveSnapshotIfNewer,
  publishLiveSnapshotFencedIfNewer,
} from "../supabase.js";

/**
 * Build the trusted production publisher. `overrides` is a BUILD-TIME test seam only (identical pattern to
 * buildSchedulerV2Runtime): production callers call it with no arguments and get the fixed collaborators
 * below. Returns a frozen `{ publish(reportKey, accountId) }` -- no other surface.
 */
export function buildSchedulerV2Publisher(overrides = {}) {
  const {
    connections: connectionsOverride,
    getConnections = getDataDoeConnections,
    fetchAccounts = fetchDataDoeAccounts,
    getAccountRollout = getSchedulerAccountRollout,
    getSettings = getReportSyncSettings,
    // Round-6 blocker 2: the SEPARATE durable control for source-promoted publication (brand-inventory),
    // fail-closed default-OFF -- distinct from the dispatch report_sync_settings.
    getPromotedSettings = getSourcePromotedPublishSettings,
    getApproval = getSchedulerPublishApproval,
    getJob = getLatestSyncReportJob,
    getSnapshot = getReportSnapshot,
    loadStoragePayload = getReportSnapshotStoragePayload,
    publishLive = publishLiveSnapshotIfNewer,
    // Round-9/10 P0-A: buildSchedulerV2Publisher IS a Gate-7 publisher, so EVERY live write goes through the
    // WRITE-BOUNDARY-FENCED CAS -- which enforces the exact {ownerToken, positive-integer generation, unexpired
    // lease} inside the SAME DB transaction as the report_snapshots mutation and returns 'lease-lost' (zero rows)
    // on mismatch. getControlFence is REQUIRED: with NO valid fence (missing provider, blank token, or an
    // invalid/missing generation) EVERY publish returns 'lease-lost' and writes zero rows. The UNFENCED CAS is
    // NEVER used here -- direct unfenced helpers exist only for genuinely unrelated writers (e.g. returns-leakage)
    // that do NOT pass through this composition.
    publishLiveFenced = publishLiveSnapshotFencedIfNewer,
    getControlFence = null,
    // BUILD-TIME test seam only (like every override above): production callers pass nothing and get the
    // frozen production readiness set (post-Gate-7b: the 13 approved keys) -- the composed publish() surface
    // has no way to supply or widen this, and gates 2-4 (durable enable + approval) still gate every publish.
    codeReadyKeys = SCHEDULER_V2_PUBLISHABLE_REPORT_KEYS,
  } = overrides;

  const connections = connectionsOverride != null ? connectionsOverride : getConnections();
  const discoverAccounts = makeProductionDiscoverAccounts({ connections, fetchAccounts });

  // ONE memoized FRESH discovery per composition: the classified ACTIVE (connection-configured) directory
  // rows. The resolver drops dd-secondary ids itself, so passing active rows (primary + any configured
  // secondary) keeps a single normalization implementation -- a secondary or undiscovered id can never
  // resolve as publishable.
  let discovery = null;
  const discoverPrimaryAccounts = () => {
    if (!discovery) {
      discovery = (async () => {
        const rows = (await discoverAccounts()) || [];
        const { active } = classifyDirectoryAccounts(rows, connections);
        return active.map((a) => ({ accountId: String((a && (a.accountId ?? a.id)) || "").trim(), country: a && a.country }));
      })();
    }
    return discovery;
  };

  // ALWAYS-FENCED write path (Round-10, property 5): EVERY live write fences the exact captured fence at the DB
  // write boundary and FAILS CLOSED (lease-lost, zero rows) when there is no VALID live fence -- no getControlFence
  // provider, a blank owner token, or a generation that is not a positive safe integer. The composition NEVER
  // falls back to the unfenced CAS.
  const validGen = (g) => Number.isSafeInteger(g) && g > 0;
  const fencedPublishLive = async (args, opts) => {
    const fence = typeof getControlFence === "function" ? getControlFence() : null;
    if (!fence || !fence.ownerToken || !validGen(fence.generation)) return { outcome: "lease-lost", reason: "no-fence" };
    return publishLiveFenced({ ...args, ownerToken: fence.ownerToken, generation: fence.generation }, opts);
  };
  const deps = Object.freeze({
    codeReadyKeys,
    getReportSyncSettings: getSettings,
    getPromotedPublishSettings: async () => getPromotedSettings(),
    loadAccountRollout: async () => getAccountRollout(),
    discoverPrimaryAccounts,
    getPublishApproval: (reportKey, accountId) => getApproval(reportKey, accountId),
    getLatestReportJob: (reportKey, accountId) => getJob(reportKey, accountId),
    getShadowSnapshot: (shadowKey, accountId, paramsHash) => getSnapshot({ reportKey: shadowKey, accountId, paramsHash }),
    loadStoragePayload,
    publishLive: fencedPublishLive,
  });

  return Object.freeze({
    // EXACTLY two identifier strings; anything else a caller passes is coerced/ignored -- there is no
    // per-call collaborator, readiness, or scope input of any kind.
    publish: async (reportKey, accountId) => publishSchedulerV2Snapshot(deps, {
      reportKey: typeof reportKey === "string" ? reportKey : "",
      accountId: typeof accountId === "string" ? accountId : "",
    }),
    // READ-ONLY PREFLIGHT: runs the SAME collaborators + gates + validations as publish() up to (not including)
    // the CAS write, and returns disposition 'ready' with the exact live identity when the pair IS publishable.
    // The operator proves every (account, report) pair before ANY live write, with zero duplicated gate logic.
    preflight: async (reportKey, accountId) => publishSchedulerV2Snapshot(deps, {
      reportKey: typeof reportKey === "string" ? reportKey : "",
      accountId: typeof accountId === "string" ? accountId : "",
      preflight: true,
    }),
  });
}
