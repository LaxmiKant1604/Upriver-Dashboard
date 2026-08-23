// Scheduler v2 -- TRUSTED, build-time-fixed OLI download-recovery operation (Phase 2 operator wiring).
//
// The ONLY composition that enables recoverFailedDownloads for a source job. Every parameter is a FROZEN module
// constant (the exact cycle, source, error shape, window, owner count) -- NEVER accepted from an HTTP body, a
// card action, the scheduler, or ordinary runtime arguments. The ordinary buildBucketSourceSyncRuntime paths keep
// recoverFailedDownloads=false, so no public recovery toggle exists.
//
// run() VERIFIES the exact single target before recovering it:
//   - exactly ONE eligible failed job in the fixed cycle, and it is order-line-items;
//   - error_stage=download, error_code=EXPORT_ERROR, terminal=false, create_export_count=1, canonical export_id;
//   - the durable request_meta window equals 2025-08-10..2026-03-17;
//   - the RE-PLANNED canonical OLI job of the same request_hash carries that exact window, exactly five sellers,
//     a seller sourceScope, marketplaceScoped=true and a nonblank marketplace constraint (so the download is
//     validated by the real five-account seller/marketplace tuple validator);
//   - exactly FIVE owner memberships for that hash, ALL primary (zero dd-secondary);
// then recovers ONLY that request_hash download-only through a create-GUARDED adapter (any create-export throws),
// so it can NEVER issue a create POST. One poll/download per invocation => no repeated-download loop (a second
// run finds zero eligible and refuses).

import { recoveryEligibility, recoverFailedDownloadJob } from "./source-worker.js";

// FROZEN target identity -- the exact Non-US OLI download failure Codex authorized to recover. Never overridable.
export const NONUS_OLI_DOWNLOAD_RECOVERY = Object.freeze({
  cycleId: "15d1f749-3d81-4994-b52a-2fb47d1d4bf4",
  bucket: "non-us",
  sourceKey: "order-line-items",
  errorStage: "download",
  errorCode: "EXPORT_ERROR",
  terminal: false,
  createExportCount: 1,
  windowFrom: "2025-08-10",
  windowTo: "2026-03-17",
  ownerCount: 5,
  connectionId: "primary",
  sellerCount: 5,
});

const str = (v) => (v == null ? "" : String(v));

/**
 * Build the trusted OLI download-recovery operation. `store` + `dataDoe` are the real (or injected) collaborators;
 * `plannedOliJobs` is the RE-PLANNED canonical OLI job set for the fixed cycle (the ONLY source of the batch
 * fetchParams / scope / marketplace metadata the download validation needs). Returns { run } -- run() verifies the
 * fixed target and recovers ONLY it, or refuses (typed) without touching anything.
 */
export function buildNonUsOliDownloadRecovery({ store, dataDoe, plannedOliJobs, clock = () => Date.now() } = {}) {
  const C = NONUS_OLI_DOWNLOAD_RECOVERY;
  if (!store || typeof store.listSourceJobsWithMeta !== "function" || typeof store.listCycleOwners !== "function") {
    throw new Error("buildNonUsOliDownloadRecovery requires a store exposing listSourceJobsWithMeta + listCycleOwners (fail closed).");
  }
  if (!dataDoe || typeof dataDoe.poll !== "function" || typeof dataDoe.download !== "function") {
    throw new Error("buildNonUsOliDownloadRecovery requires a dataDoe with poll + download (fail closed).");
  }
  const planned = Array.isArray(plannedOliJobs) ? plannedOliJobs : [];

  return {
    target: C,
    async run() {
      const refuse = (reason, extra = {}) => ({ status: "refused", reason, ...extra });

      // 1) EXACTLY ONE eligible failed OLI job in the fixed cycle.
      const jobs = await store.listSourceJobsWithMeta(C.cycleId);
      const eligible = (Array.isArray(jobs) ? jobs : []).filter(
        (j) => str(j.source_key ?? j.sourceKey) === C.sourceKey && recoveryEligibility(j).eligible,
      );
      if (eligible.length !== 1) return refuse("expected-exactly-one-eligible", { eligibleCount: eligible.length });
      const row = eligible[0];
      const hash = str(row.request_hash ?? row.requestHash);

      // 2) The target row must match the FROZEN failure shape exactly.
      const meta = row.request_meta ?? row.requestMeta ?? {};
      const rowChecks = [
        [str(row.source_key ?? row.sourceKey) === C.sourceKey, "source_key"],
        [str(row.error_stage ?? row.errorStage) === C.errorStage, "error_stage"],
        [str(row.error_code ?? row.errorCode) === C.errorCode, "error_code"],
        [(row.terminal ?? false) === C.terminal, "terminal"],
        [Number(row.create_export_count ?? row.createExportCount) === C.createExportCount, "create_export_count"],
        [str(meta.from) === C.windowFrom && str(meta.to) === C.windowTo, "window"],
      ];
      for (const [ok, field] of rowChecks) if (!ok) return refuse("row-field-mismatch:" + field);

      // 3) The RE-PLANNED canonical OLI job (the fetchParams/scope/marketplace source) of the same hash.
      const plan = planned.find((p) => str(p.requestHash ?? p.request_hash) === hash);
      if (!plan) return refuse("no-planned-match");
      const fp = plan.fetchParams || {};
      const ids = Array.isArray(fp.sellerOrVendorIds) ? fp.sellerOrVendorIds : [];
      const planChecks = [
        [str(plan.sourceKey ?? plan.source_key) === C.sourceKey, "planned-source_key"],
        [str(fp.from) === C.windowFrom && str(fp.to) === C.windowTo, "planned-window"],
        [ids.length === C.sellerCount, "planned-seller-count"],
        [plan.sourceScope === "seller", "planned-source-scope"],
        [plan.marketplaceScoped === true, "planned-marketplace-scoped"],
        [str(plan.marketplaceConstraint).trim() !== "", "planned-marketplace-constraint"],
      ];
      for (const [ok, field] of planChecks) if (!ok) return refuse(field);

      // 4) EXACTLY five owner memberships for that hash, ALL primary (zero dd-secondary).
      const allOwners = await store.listCycleOwners(C.cycleId);
      const owners = (Array.isArray(allOwners) ? allOwners : []).filter(
        (o) => str(o.request_hash ?? o.requestHash) === hash && (o.owner_status ?? o.ownerStatus) !== "stale",
      );
      if (owners.length !== C.ownerCount) return refuse("owner-count", { ownerCount: owners.length });
      if (!owners.every((o) => str(o.connection_id ?? o.connectionId) === C.connectionId)) return refuse("owner-not-primary");

      // 5) Recover ONLY that hash, download-only. The adapter is create-GUARDED: any create-export THROWS, so
      //    this operation can never issue a create POST (belt-and-suspenders atop the create-free resume path).
      const guardedDataDoe = {
        create: async () => { throw new Error("OLI download-recovery operator NEVER creates an export (fail closed)."); },
        poll: (...a) => dataDoe.poll(...a),
        download: (...a) => dataDoe.download(...a),
      };
      const outcome = await recoverFailedDownloadJob({
        store, dataDoe: guardedDataDoe, clock, cycleId: C.cycleId,
        meta: plan, jobRow: row, runWithDeadline: (fn) => fn(),
      });
      return { status: "ran", requestHash: hash, outcome };
    },
  };
}
