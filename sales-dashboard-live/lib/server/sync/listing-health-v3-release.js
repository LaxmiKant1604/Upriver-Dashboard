// DEDICATED listing-health-v3-ONLY release composition. The listing-health-v3 saved-data reconciler's per-account
// executor uses THIS to RE-DERIVE + promote EXACTLY listing-health-v3 for ONE account over ONE dedicated cycle. It
// NEVER derives, saves, publishes, or mutates any OTHER report (Daily / Brand Sales / Brand Inventory / FBA Plan / OLI /
// Listings-source / Raw-source).
//
// WORK C/D correction (blockers 1-3): loading + FULL pointer/payload integrity + the COMPLETE dependency fingerprint
// are the SHARED resolveListingHealthV3DependencyBundle (dependency-bundle.js) -- the SAME resolver the scope scan uses,
// so the release recompute is byte-identical to the scan's revision. TOCTOU-safe:
//   1. resolve the bundle at entry (require its fingerprint === the supplied revisionId, else DEFER -- zero writes);
//   2. DERIVE listing-health-v3 from THAT exact resolved bundle via the CANONICAL deriveReportSnapshot (source gate +
//      derive + STRICT validatePayload);
//   3. re-resolve the bundle IMMEDIATELY before the first write and require the fingerprint STILL === revisionId (a
//      same-as_of correction to ANY dependency -- Listings/Raw/OLI/coverage/completeness/Catalog/FBA -- during the slow
//      derive DEFERS with zero cycle/job/shadow/live writes; the next cycle re-derives under the new revision bucket);
//   4. open the dedicated priority-partial cycle; save ONE validated shadow with EXACT lineage (depends_on = owned
//      durable request hashes; durable_content_deps = the SINGLE manifest token the revision emits, so an unchanged
//      manifest converges to a zero-write no-op via revisionCoveredByJob);
//   5. finalize ONLY this dedicated cycle; preflight + publish + canonical read-back ONLY listing-health-v3 through the
//      reviewed FENCED publisher + CAS + buildLiveReadback.
//
// TERMINATION BOUNDARY: the caller's AbortSignal is threaded into EVERY supported read/write (the bundle resolver
// forwards it through pointer reads, storage hydration, AND the durable OLI/catalog loader), abort is rechecked AFTER
// every awaited phase AND immediately BEFORE every write, and the fenced live CAS is the final defense. Once abort is
// observed, NO additional write is started; an already-issued remote write is NEVER claimed undone.
//
// Every side effect is an INJECTED collaborator (offline-testable); the production entrypoint wires the real resolver +
// publisher + control fence. It imports NO provider export transport. The returned per-account result is the SAME typed
// shape the release runner returns. 7-bit ASCII, LF.

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LIVE_REPORT_KEY = "listing-health-v3";
const LISTINGS_REQUEST_KEY = "listing-health-v3:listings";
const LISTINGS_RAW_REQUEST_KEY = "listing-health-v3:listings-raw";
const INVENTORY_REQUEST_KEY = "listing-health-v3:inventory";
const SHADOW_KEY = "scheduler-v2/" + LIVE_REPORT_KEY; // "scheduler-v2/listing-health-v3"

const ok = () => ({ code: 0, ok: true, stage: "complete", status: null, leaseLost: false, reason: null, blockerCodes: [], problems: [] });
// A retryable DEFERRAL (source/evidence not yet available, or the manifest advanced; LKG preserved). stage:'reconcile'
// is a RETRYABLE_STAGE in the shared statusFromRelease, so it classifies as DEFERRED_DEPENDENCY.
const defer = (reason, status = "SOURCE_UNAVAILABLE") => ({ code: 1, ok: false, stage: "reconcile", status, leaseLost: false, reason, blockerCodes: [], problems: [reason] });
const DEADLINE = () => defer("deadline-aborted", "DEADLINE_ABORTED");
const contention = (reason) => ({ code: 1, ok: false, stage: "contention", status: "CONTROL_LEASE_LOST", leaseLost: true, reason, blockerCodes: [], problems: [reason] });
// A HARD, non-retryable failure (integrity / publish / readback). stage NOT in RETRYABLE_STAGES -> FAILED_* + non-green.
const hardFail = (stage, reason) => ({ code: 1, ok: false, stage, status: null, leaseLost: false, reason, blockerCodes: stage.startsWith("derive") ? ["derive:" + reason] : [], problems: [reason] });

// A single-owner no-date fragment source (Listings / Listings-Raw): the derive's noDateFragmentRows requires EXACTLY one
// fragment with from===null, to===null, sellerOrVendorIds===[rawSellerId]. `available:true` + Array.isArray(rows) gates
// the derive; the derive returns source.rows (the top-level array), so BOTH source.rows and fragments[0].rows are set.
function noDateSource(requestKey, rows, rawSellerId) {
  return {
    available: true, rows,
    fragments: [{ requestKey, from: null, to: null, sellerOrVendorIds: [rawSellerId], rows }],
    disabled: false, disabledPolicy: null, reason: null,
  };
}

/**
 * Build the dedicated listing-health-v3 release. Injected collaborators (production wired by the entrypoint):
 *   resolveBundle({ accountId, requestedAsOf, signal }) -> { eligible, reason?, revisionId, deps, contentDeps, status,
 *       bundle:{ listingsRows, rawRows, inventorySource, context, listingsSnapshot, rawSnapshot, inventorySnapshot } }
 *       -- the SHARED resolveListingHealthV3DependencyBundle closure (full integrity + the complete-manifest fingerprint)
 *   openCycle({ bucket, cycleDate, trigger }, { signal }) ; getCycleByBucketDate(bucket, cycleDate, { signal }) -> cycleRow
 *   deriveSnapshot({ reportKey, sources, context }) -> { status, validated, payload, latestDataDate } (deriveReportSnapshot)
 *   reportDerivations ; computeHash(reportVersion, params) ; liveContracts
 *   upsertReportJob(job, { signal }) / claimLease(cycleId, reportKey, accountId, { leaseSeconds, signal })
 *   saveShadow(args, { signal }) / reconcileSuccess(args, { signal }) / finalizeCycle({ cycleId }, { signal })
 *   publisher { preflight(reportKey, accountId), publish(reportKey, accountId) }  (buildSchedulerV2Publisher, fenced)
 *   readbackLive({ reportKey, liveReportKey, accountId, paramsHash, signal }) -> { ok, reason? }
 *   verifyLease() -> { ok, reason? } ; snapshotBytes(payload) ; leaseSeconds ; log
 */
export function buildListingHealthV3Release({
  resolveBundle,
  openCycle, getCycleByBucketDate,
  deriveSnapshot,
  reportDerivations, computeHash, liveContracts,
  upsertReportJob, claimLease, saveShadow, reconcileSuccess,
  finalizeCycle,
  publisher, readbackLive,
  verifyLease = async () => ({ ok: true }),
  snapshotBytes = (p) => Buffer.byteLength(JSON.stringify(p == null ? null : p), "utf8"),
  leaseSeconds = 300,
  log = () => {},
} = {}) {
  for (const [name, fn] of [["resolveBundle", resolveBundle], ["openCycle", openCycle], ["getCycleByBucketDate", getCycleByBucketDate], ["deriveSnapshot", deriveSnapshot], ["computeHash", computeHash], ["upsertReportJob", upsertReportJob], ["claimLease", claimLease], ["saveShadow", saveShadow], ["reconcileSuccess", reconcileSuccess], ["finalizeCycle", finalizeCycle], ["readbackLive", readbackLive]]) {
    if (typeof fn !== "function") throw new Error(`buildListingHealthV3Release requires ${name} (fail closed).`);
  }
  if (!liveContracts || !reportDerivations) throw new Error("buildListingHealthV3Release requires liveContracts + reportDerivations (fail closed).");
  if (!publisher || typeof publisher.preflight !== "function" || typeof publisher.publish !== "function") throw new Error("buildListingHealthV3Release requires a publisher with preflight + publish (fail closed).");
  const derivation = reportDerivations[LIVE_REPORT_KEY];
  if (!derivation || !nb(derivation.snapshotVersion)) throw new Error("buildListingHealthV3Release requires the listing-health-v3 derivation entry (fail closed).");
  const SHADOW_REPORT_VERSION = S(derivation.snapshotVersion); // "listing-health/v3-oli-window"

  async function runForAccount({ accountId, requestedAsOf, cycleBucket, revisionId, signal }) {
    const aborted = () => !!(signal && signal.aborted);
    const opt = { signal };
    if (aborted()) return DEADLINE();
    if (!nb(accountId) || !DATE_RE.test(S(requestedAsOf)) || !nb(cycleBucket) || !nb(revisionId)) return hardFail("derive", "bad-args");

    // (1) Resolve the COMPLETE dependency bundle (full pointer/payload integrity + the complete-manifest fingerprint)
    // and require its fingerprint EXACTLY equals the revisionId the scan classified. A mismatch = the manifest advanced
    // between scan and execute (a same-as_of correction to ANY dependency): DEFER with ZERO writes -- the next cycle
    // re-derives under the new revision's bucket, never publishing new content inside this older revision's namespace.
    let b1;
    try { b1 = await resolveBundle({ accountId, requestedAsOf, signal }); }
    catch (e) { return defer("bundle-resolve-threw:" + S(e && e.message)); }
    if (aborted()) return DEADLINE();
    if (!b1 || b1.eligible !== true) return defer("bundle-" + S(b1 && b1.reason));
    if (S(b1.revisionId) !== S(revisionId)) return defer("revision-advanced-at-entry");
    const bundle = b1.bundle || {};
    const context = bundle.context || {};
    const rawSellerId = S(context.rawSellerId);
    if (!nb(rawSellerId)) return defer("raw-seller-unresolved");

    // (2) DERIVE listing-health-v3 ONLY, from THAT exact resolved bundle, via the CANONICAL registry derivation.
    if (aborted()) return DEADLINE();
    const sources = {
      [LISTINGS_REQUEST_KEY]: noDateSource(LISTINGS_REQUEST_KEY, bundle.listingsRows, rawSellerId),
      [LISTINGS_RAW_REQUEST_KEY]: noDateSource(LISTINGS_RAW_REQUEST_KEY, bundle.rawRows, rawSellerId),
      [INVENTORY_REQUEST_KEY]: bundle.inventorySource || { available: false },
    };
    let derived;
    try { derived = await deriveSnapshot({ reportKey: LIVE_REPORT_KEY, sources, context }); }
    catch (e) { return hardFail("derive", "derive-threw:" + S(e && e.message)); }
    if (aborted()) return DEADLINE();
    if (!derived || derived.status !== "derived" || derived.validated !== true) {
      const st = S(derived && derived.status);
      // 'unavailable'/'blocked' = a source/config state: defer (LKG). Anything else (invalid/unmapped/...) is HARD.
      if (st === "unavailable" || st === "blocked") return defer("derive-" + st + ":" + S(derived && derived.reason));
      return hardFail("derive", "derive-" + (st || "malformed"));
    }
    const payload = derived.payload;
    if (!payload || typeof payload !== "object") return hardFail("derive", "payload-malformed");

    const params = { reportVersion: SHADOW_REPORT_VERSION, accountId, to: requestedAsOf };
    const paramsHash = computeHash(SHADOW_REPORT_VERSION, params);
    // Lineage. depends_on = the OWNED durable source request hashes the derive consumed (Listings + Listings-Raw +
    // inventory-when-included). durable_content_deps = the SINGLE manifest token the revision emits (the complete
    // dependency fingerprint), so revisionCoveredByJob's subset check converges an unchanged manifest to a no-op.
    const lSnap = bundle.listingsSnapshot || {};
    const rSnap = bundle.rawSnapshot || {};
    const invSnap = bundle.inventorySnapshot || null;
    const dependsOn = [...new Set([
      S(lSnap.source_request_hash), S(rSnap.source_request_hash), ...(invSnap ? [S(invSnap.source_request_hash)] : []),
    ].filter(nb))].sort();
    const durableContentDeps = Array.isArray(b1.contentDeps) ? [...b1.contentDeps] : [];
    if (durableContentDeps.length === 0) return hardFail("derive", "empty-content-deps");

    // (3) TOCTOU RECHECK immediately before the first write: re-resolve the FULL bundle and require the fingerprint
    // STILL equals revisionId. Catches a dependency advance during the (potentially slow) derive. Mismatch -> DEFER,
    // zero cycle/job/shadow/live writes.
    if (aborted()) return DEADLINE();
    let b2;
    try { b2 = await resolveBundle({ accountId, requestedAsOf, signal }); }
    catch (e) { return defer("bundle-recheck-threw:" + S(e && e.message)); }
    if (aborted()) return DEADLINE();
    if (!b2 || b2.eligible !== true || S(b2.revisionId) !== S(revisionId)) return defer("revision-advanced-before-write");

    // (4) open the dedicated cycle (FIRST WRITE) -- abort-check immediately before every write from here on.
    if (aborted()) return DEADLINE();
    try { await openCycle({ bucket: cycleBucket, cycleDate: requestedAsOf, trigger: "manual" }, opt); }
    catch (e) { return defer("cycle-open-threw:" + S(e && e.message)); }
    if (aborted()) return DEADLINE();
    let cycle;
    try { cycle = await getCycleByBucketDate(cycleBucket, requestedAsOf, opt); }
    catch (e) { return defer("cycle-read-threw:" + S(e && e.message)); }
    if (aborted()) return DEADLINE();
    if (!cycle || !nb(S(cycle.id))) return defer("cycle-unresolved");
    const cycleId = S(cycle.id);
    const sourceRefreshedAt = nb(S(cycle.created_at ?? cycle.createdAt)) ? S(cycle.created_at ?? cycle.createdAt) : null;
    if (!nb(sourceRefreshedAt)) return defer("cycle-refresh-blank");

    if (aborted()) return DEADLINE();
    // The report JOB carries the REAL REGION bucket, NOT the priority-partial CYCLE bucket -- sync_report_jobs_bucket_check
    // permits only the region buckets (migration 20260924 widened only sync_cycles.bucket for the priority-partial CYCLE
    // namespace, keeping the report-job bucket the real region, like the scheduler's priority release). cycleBucket here
    // would violate sync_report_jobs_bucket_check (400 constraint -> lineage-upsert-threw).
    const jobBucket = (S(cycleBucket).match(/^priority-partial-(india|europe-au|us-ca)-/) || [])[1] || "";
    if (!nb(jobBucket)) return hardFail("derive", "job-bucket-unresolved");
    try {
      await upsertReportJob({
        cycleId, reportKey: LIVE_REPORT_KEY, reportVersion: SHADOW_REPORT_VERSION,
        accountId, connectionId: "primary", bucket: jobBucket,
        dependsOn, durableContentDeps,
      }, opt);
    } catch (e) { return hardFail("derive", "lineage-upsert-threw:" + S(e && e.message)); }

    if (aborted()) return DEADLINE();
    let lease;
    try { lease = await claimLease(cycleId, LIVE_REPORT_KEY, accountId, { leaseSeconds, signal }); }
    catch (e) { return defer("claim-threw:" + S(e && e.message)); }
    if (aborted()) return DEADLINE();
    const disp = lease && lease.disposition;
    if (disp === "already-complete") {
      if (S(lease.snapshotParamsHash) !== S(paramsHash)) return hardFail("derive", "already-complete-hash-mismatch");
    } else if (disp === "held") {
      return defer("claim-held", "SOURCE_READINESS_PENDING");
    } else if ((disp !== "claimed" && disp !== "reclaimed") || !nb(lease.leaseToken)) {
      return hardFail("derive", "claim-" + S(disp || "malformed"));
    }
    if (disp === "claimed" || disp === "reclaimed") {
      if (aborted()) return DEADLINE();
      let cas;
      try { cas = await saveShadow({ reportKey: SHADOW_KEY, accountId, paramsHash, params, payload, payloadBytes: snapshotBytes(payload), sourceRefreshedAt }, opt); }
      catch (e) { return hardFail("derive", "shadow-cas-threw:" + S(e && e.message)); }
      if (aborted()) return DEADLINE();
      const outcome = cas && cas.outcome;
      if (outcome === "newer-live") return defer("shadow-newer-live"); // a newer durable exists -> resumable, LKG kept
      if (outcome !== "inserted" && outcome !== "replaced" && outcome !== "already-current") return hardFail("derive", "shadow-conflict:" + S(outcome));
      if (aborted()) return DEADLINE();
      let rec;
      try { rec = await reconcileSuccess({ cycleId, reportKey: LIVE_REPORT_KEY, accountId, snapshotParamsHash: paramsHash, leaseToken: lease.leaseToken, latestDataDate: derived.latestDataDate || null }, opt); }
      catch (e) { return hardFail("derive", "reconcile-threw:" + S(e && e.message)); }
      if (aborted()) return DEADLINE();
      const rdisp = rec && rec.disposition;
      if (rdisp !== "reconciled" && rdisp !== "already-complete") return hardFail("derive", "reconcile-" + S(rdisp || "malformed"));
    }

    // (5) finalize ONLY this dedicated cycle (directly).
    if (aborted()) return DEADLINE();
    let fin;
    try { fin = await finalizeCycle({ cycleId }, opt); }
    catch (e) { return hardFail("finalize", "finalize-threw:" + S(e && e.message)); }
    if (aborted()) return DEADLINE();
    const fdisp = fin && fin.disposition;
    if (fdisp !== "finalized" && fdisp !== "already-terminal") return hardFail("finalize", "finalize-" + S(fdisp || "malformed"));

    // preflight + publish + read back ONLY listing-health-v3 (reviewed fenced publisher + CAS + buildLiveReadback).
    if (aborted()) return DEADLINE();
    let pf;
    try { pf = await publisher.preflight(LIVE_REPORT_KEY, accountId); }
    catch (e) { return hardFail("publish-gates", "preflight-threw:" + S(e && e.message)); }
    if (aborted()) return DEADLINE();
    if (!pf || S(pf.disposition) !== "ready") {
      if (pf && S(pf.disposition) === "lease-lost") return contention("preflight-lease-lost");
      return hardFail("publish-gates", "preflight-" + S(pf && pf.disposition));
    }
    let fence;
    try { fence = await verifyLease(); } catch (e) { fence = { ok: false, reason: "renew-threw:" + S(e && e.message) }; }
    if (!fence || fence.ok !== true) return contention("lease-lost-before-publish:" + S(fence && fence.reason));
    // Immediately BEFORE the live write: if aborted, do NOT start the publish. The fenced CAS is the final defense.
    if (aborted()) return DEADLINE();
    let res;
    try { res = await publisher.publish(LIVE_REPORT_KEY, accountId); }
    catch (e) { return hardFail("publish", "publish-threw:" + S(e && e.message)); }
    const pdisp = res && S(res.disposition);
    if (pdisp === "lease-lost") return contention("publish-lease-lost");
    if (pdisp !== "published" && pdisp !== "already-current") return hardFail("publish", "publish-" + S(pdisp));
    if (!nb(res.liveReportKey) || !nb(res.paramsHash)) return hardFail("publish", "publish-missing-live-identity");

    // The publish already LANDED. The read-back is a READ-ONLY confirmation, threaded with the signal.
    if (aborted()) return DEADLINE();
    let rb;
    try { rb = await readbackLive({ reportKey: LIVE_REPORT_KEY, liveReportKey: res.liveReportKey, accountId, paramsHash: res.paramsHash, signal }); }
    catch (e) { rb = { ok: false, reason: "readback-threw:" + S(e && e.message) }; }
    if (aborted()) return DEADLINE();
    if (!rb || rb.ok !== true) return hardFail("readback", "live-readback-failed:" + S(rb && rb.reason));

    log("listing-health-v3: published + read back listing-health-v3 for " + accountId + " (" + pdisp + ")");
    return ok();
  }

  return Object.freeze({ runForAccount, reportKeys: [LIVE_REPORT_KEY] });
}
