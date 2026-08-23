// Scheduler v2 -- TRUSTED, build-time-fixed OLI download-recovery operation (Phase 2 operator wiring).
//
// The ONLY composition that runs recovery. Every parameter is a FROZEN module constant (the exact cycle, source,
// error shape, window, owner/seller count) -- NEVER accepted from an HTTP body, card action, scheduler or runtime
// argument. The ordinary buildBucketSourceSyncRuntime paths keep recoverFailedDownloads=false, so no public
// recovery toggle exists.
//
// run() VERIFIES the exact single target against the REAL planBucketSourceSync output before recovering it:
//   - exactly ONE eligible failed job in the fixed cycle, and it is order-line-items;
//   - error_stage=download, error_code=EXPORT_ERROR, terminal=false, create_export_count=1, canonical export_id;
//   - the durable request_meta window equals 2025-08-10..2026-03-17;
//   - the REAL canonical OLI plan for that request_hash carries the EXACT scope/evidence the planner emits --
//     seller sourceScope, marketplaceScoped=FALSE (OLI has no marketplace column; no marketplace is invented),
//     that exact window, and five seller ids; the FIVE owner-specific planned entries share one canonical
//     request/fetch identity and carry five unique canonical (accountId, rawSellerId);
//   - the durable owner memberships are exactly five, active, primary, unique, canonical, and their account set
//     EXACTLY equals the planned owner-account set (reject missing/extra/duplicate/stale/blank/mismatched);
// then recovers ONLY that request_hash download-only through a create-GUARDED adapter (any create-export throws)
// under a REAL bounded DataDoe deadline (poll/download honour the 550s budget; a hung op is bounded + resumable,
// never a ghost write). One canonical export, five owner memberships, one poll/download per invocation => no
// repeated-download loop (a second run finds zero eligible and refuses).

import { recoveryEligibility, recoverFailedDownloadJob } from "./source-worker.js";
import { withDataDoeDeadline } from "../datadoe.js";

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
  sellerCount: 5,
  connectionId: "primary",
  // OLI is seller-scoped but carries NO marketplace column, so the canonical planner emits marketplaceScoped=false
  // (validateBatchSourcePayload then validates the five SELLER ids only). We assert this EXACT emitted value.
  sourceScope: "seller",
  marketplaceScoped: false,
  budgetMs: 550_000, // the reviewed 550-second route/DataDoe budget
  reserveMs: 1_000,
});

const str = (v) => (v == null ? "" : String(v));
const nonblank = (v) => str(v).trim() !== "";
const setEq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

/**
 * Build the trusted OLI download-recovery operation. `store` + `dataDoe` are the real (or injected) collaborators;
 * `plannedOliJobs` is the RE-PLANNED canonical OLI job set for the fixed cycle (the ONLY source of the batch
 * fetch identity + owner records). Returns { run } -- run() verifies the fixed target and recovers ONLY it (under
 * a real bounded DataDoe deadline), or refuses (typed) without touching anything.
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

      // 3) The REAL canonical OLI plan for this hash: FIVE owner-specific entries sharing ONE request/fetch
      //    identity (plannedBatchSourceJobs). Require exactly five.
      const plannedForHash = planned.filter((p) => str(p.requestHash ?? p.request_hash) === hash);
      if (plannedForHash.length !== C.ownerCount) return refuse("planned-owner-count", { plannedCount: plannedForHash.length });

      // Identical canonical source/fetch identity across all five entries (exactly what the planner emits).
      const p0 = plannedForHash[0];
      const fp0 = p0.fetchParams || {};
      const ids0 = Array.isArray(fp0.sellerOrVendorIds) ? fp0.sellerOrVendorIds.map(String) : [];
      const identity = (p) => {
        const fp = p.fetchParams || {};
        return JSON.stringify([
          str(p.sourceKey ?? p.source_key), str(p.sourceScope), p.marketplaceScoped === true,
          str(p.marketplaceConstraint), p.strict === true, Number(p.limit),
          str(fp.from), str(fp.to), (Array.isArray(fp.columns) ? fp.columns.map(String) : []),
          (Array.isArray(fp.sellerOrVendorIds) ? fp.sellerOrVendorIds.map(String) : []),
        ]);
      };
      const id0 = identity(p0);
      if (!plannedForHash.every((p) => identity(p) === id0)) return refuse("planned-identity-divergent");

      const planChecks = [
        [str(p0.sourceKey ?? p0.source_key) === C.sourceKey, "planned-source_key"],
        [p0.sourceScope === C.sourceScope, "planned-source-scope"],
        [p0.marketplaceScoped === C.marketplaceScoped, "planned-marketplace-scoped"],
        [str(fp0.from) === C.windowFrom && str(fp0.to) === C.windowTo, "planned-window"],
        [ids0.length === C.sellerCount && new Set(ids0).size === C.sellerCount && ids0.every(nonblank), "planned-seller-count"],
      ];
      for (const [ok, field] of planChecks) if (!ok) return refuse(field);

      // Five unique canonical planned (accountId, rawSellerId); the rawSellerId set equals the batch seller ids.
      const owners = plannedForHash.map((p) => p.owner || {});
      const plannedAccountIds = owners.map((o) => str(o.accountId));
      const plannedRawIds = owners.map((o) => str(o.rawSellerId));
      if (!plannedAccountIds.every(nonblank) || !plannedRawIds.every(nonblank)) return refuse("planned-owner-blank");
      if (new Set(plannedAccountIds).size !== C.ownerCount) return refuse("planned-owner-account-not-unique");
      if (new Set(plannedRawIds).size !== C.ownerCount) return refuse("planned-owner-seller-not-unique");
      if (!setEq(new Set(plannedRawIds), new Set(ids0))) return refuse("planned-owner-seller-mismatch");
      const plannedAccountSet = new Set(plannedAccountIds);

      // 4) DURABLE owner memberships for this hash: exactly five, active, primary, unique owner_id, canonical
      //    account_id; and their account set EXACTLY equals the planned owner-account set.
      const allOwners = await store.listCycleOwners(C.cycleId);
      const durable = (Array.isArray(allOwners) ? allOwners : []).filter((o) => str(o.request_hash ?? o.requestHash) === hash);
      if (durable.length !== C.ownerCount) return refuse("owner-count", { ownerCount: durable.length });
      if (!durable.every((o) => (o.owner_status ?? o.ownerStatus ?? "active") === "active")) return refuse("owner-not-active");
      if (!durable.every((o) => str(o.connection_id ?? o.connectionId) === C.connectionId)) return refuse("owner-not-primary");
      const durableOwnerIds = durable.map((o) => str(o.owner_id ?? o.ownerId));
      if (!durableOwnerIds.every(nonblank) || new Set(durableOwnerIds).size !== C.ownerCount) return refuse("owner-id-not-unique");
      const durableAccountIds = durable.map((o) => str(o.account_id ?? o.accountId));
      if (!durableAccountIds.every(nonblank)) return refuse("owner-account-blank");
      if (new Set(durableAccountIds).size !== C.ownerCount) return refuse("owner-account-not-unique");
      if (!setEq(new Set(durableAccountIds), plannedAccountSet)) return refuse("owner-account-mismatch");

      // 5) Recover ONLY that hash, download-only, under a REAL bounded DataDoe deadline. The adapter is
      //    create-GUARDED (any create-export THROWS) so this operation can never issue a create POST.
      const deadlineAt = clock() + C.budgetMs - C.reserveMs;
      const runWithDeadline = (fn) => withDataDoeDeadline(deadlineAt, fn);
      const guardedDataDoe = {
        create: async () => { throw new Error("OLI download-recovery operator NEVER creates an export (fail closed)."); },
        poll: (...a) => dataDoe.poll(...a),
        download: (...a) => dataDoe.download(...a),
      };
      const outcome = await recoverFailedDownloadJob({
        store, dataDoe: guardedDataDoe, clock, cycleId: C.cycleId,
        meta: p0, jobRow: row, runWithDeadline,
      });
      return { status: "ran", requestHash: hash, outcome };
    },
  };
}

/**
 * Honest release-automation exit decision. Exit 0 ONLY for a genuine recovered success
 * (status="ran", outcome.status="success", outcome.validated=true). EVERY other class -- refused, skipped,
 * deferred, failed, terminal, malformed or missing outcome -- exits NONZERO with typed/redacted evidence
 * (never a payload, seller id, export id or secret), so automation cannot continue past a non-success.
 */
export function recoveryExitDecision(res) {
  const o = res && res.outcome;
  const success = !!(res && res.status === "ran" && o && o.status === "success" && o.validated === true);
  const evidence = {
    status: (res && res.status) || "missing",
    reason: (res && res.reason) || null,
    outcomeStatus: o ? o.status : null,
    outcomeValidated: o ? o.validated === true : null,
    outcomeCode: o ? (o.code || null) : null,
    rowCount: o ? (o.rowCount ?? null) : null,
    requestHashPresent: Boolean(res && res.requestHash),
    eligibleCount: res ? res.eligibleCount : undefined,
    ownerCount: res ? res.ownerCount : undefined,
  };
  return { code: success ? 0 : 1, ok: success, evidence };
}
