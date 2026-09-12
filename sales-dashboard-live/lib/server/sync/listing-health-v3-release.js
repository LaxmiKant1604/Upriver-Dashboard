// DEDICATED listing-health-v3-ONLY release composition. The listing-health-v3 saved-data reconciler's per-account
// executor uses THIS to RE-DERIVE + promote EXACTLY listing-health-v3 for ONE account over ONE dedicated cycle. It
// NEVER derives, saves, publishes, or mutates any OTHER report (Daily / Brand Sales / Brand Inventory / FBA Plan / OLI /
// Listings-source / Raw-source). It mirrors buildFbaBrandInventoryRelease step-for-step; the one substantive divergence
// is step (4) DERIVE, which invokes the CANONICAL registry derivation (deriveReportSnapshot) so listing-health-v3's own
// validatePayload runs, assembling the exact input the report worker builds:
//   1. open the dedicated priority-partial cycle (permitted by migration 20260924);
//   2. read the EXACT durable Listings + Listings-Raw snapshots the revision selected (getSourceListings[Raw]Snapshot +
//      hydrate the content-addressed rows) and independently re-prove D-1 (both pointers' as_of === requestedAsOf) --
//      zero export;
//   3. reuse the durable FBA inventory snapshot (fba-inventory-health) ONLY when its recomputed D-1 request hash proves
//      the requested day and it carries rows (OPTIONAL: absent/older/empty -> inventory unavailable, FBA on-hand falls
//      back to the Listings quantity -- NEVER a fabricated zero, NEVER a blocking defer);
//   4. build the derived durable context (enriched OLI + coverage + completeness + org Product Catalog) via the SAME
//      makeListingHealthV3DurableContextLoader the shadow worker uses (a durable read failure -> {} -> derive defers,
//      LKG preserved), then deriveReportSnapshot({reportKey:'listing-health-v3', sources, context}) (source gate +
//      derive + STRICT validatePayload). Publish ONLY a status:'derived' && validated result;
//   5. save ONE validated listing-health-v3 shadow with EXACT lineage -- depends_on = the owned durable source request
//      hashes (Listings + Listings-Raw + inventory-when-included) + durable_content_deps = the two Listings content
//      tokens (so a same-day correction OR a date advance is provable via revisionCoveredByJob);
//   6. finalize ONLY this dedicated cycle via finalize_sync_cycle DIRECTLY;
//   7. preflight + publish + canonical read-back ONLY listing-health-v3 through the reviewed FENCED publisher + CAS +
//      buildLiveReadback.
//
// TERMINATION BOUNDARY: the caller's AbortSignal is threaded into EVERY supported Supabase read/write, abort is
// rechecked AFTER every awaited phase AND immediately BEFORE every write, and the fenced live CAS is the final defense
// (an aborted op's getControlFence returns null -> the CAS writes zero rows). Once abort is observed, NO additional
// write is started; an already-issued remote write is NEVER claimed undone (the reconciler core owns settlement).
//
// Every side effect is an INJECTED collaborator (offline-testable); the production entrypoint wires the real durable
// readers + publisher + control fence. It imports NO provider export transport -- listing-health-v3 reads only durable
// data. The returned per-account result is the SAME typed shape the release runner returns, so the shared reconciler's
// statusFromRelease classifies it unchanged. 7-bit ASCII, LF.

import { listingsContentProvenanceToken, listingsRawContentProvenanceToken } from "./listings-revision.js";
import { LISTINGS_SOURCE_KEY, LISTINGS_RAW_SOURCE_KEY } from "./source-durable-model.js";

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LIVE_REPORT_KEY = "listing-health-v3";
const LISTINGS_REQUEST_KEY = "listing-health-v3:listings";
const LISTINGS_RAW_REQUEST_KEY = "listing-health-v3:listings-raw";
const INVENTORY_REQUEST_KEY = "listing-health-v3:inventory";
const SHADOW_KEY = "scheduler-v2/" + LIVE_REPORT_KEY; // "scheduler-v2/listing-health-v3"

const ok = () => ({ code: 0, ok: true, stage: "complete", status: null, leaseLost: false, reason: null, blockerCodes: [], problems: [] });
// A retryable DEFERRAL (source/evidence not yet available; LKG preserved). stage:'reconcile' is a RETRYABLE_STAGE in the
// shared statusFromRelease, so it classifies as DEFERRED_DEPENDENCY regardless of the (diagnostic) reason.
const defer = (reason, status = "SOURCE_UNAVAILABLE") => ({ code: 1, ok: false, stage: "reconcile", status, leaseLost: false, reason, blockerCodes: [], problems: [reason] });
const DEADLINE = () => defer("deadline-aborted", "DEADLINE_ABORTED");
const contention = (reason) => ({ code: 1, ok: false, stage: "contention", status: "CONTROL_LEASE_LOST", leaseLost: true, reason, blockerCodes: [], problems: [reason] });
// A HARD, non-retryable failure (integrity / publish / readback). stage NOT in RETRYABLE_STAGES -> FAILED_* + non-green.
const hardFail = (stage, reason) => ({ code: 1, ok: false, stage, status: null, leaseLost: false, reason, blockerCodes: stage.startsWith("derive") ? ["derive:" + reason] : [], problems: [reason] });

// Hydrate a durable snapshot payload into a plain rows array (accepts {rows} or a bare array). Null on a dangling shape.
function rowsOf(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.rows)) return payload.rows;
  return null;
}

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
 * Build the dedicated listing-health-v3 release. Injected collaborators (production wired by the entrypoint). Every
 * read/write that supports it receives { signal }; the publisher's live write is protected by the control fence.
 *   resolveOrg() -> { organizationFingerprint, connectionId }
 *   openCycle({ bucket, cycleDate, trigger }, { signal }) ; getCycleByBucketDate(bucket, cycleDate, { signal }) -> cycleRow
 *   readListingsSnapshot({ organizationFingerprint, connectionId, accountId, signal }) -> { read, snapshot }
 *   readListingsRawSnapshot({ organizationFingerprint, connectionId, accountId, signal }) -> { read, snapshot }
 *   readInventorySnapshot({ organizationFingerprint, connectionId, accountId, signal }) -> { read, snapshot }  (FBA reuse)
 *   loadSnapshotPayload(objectPath, { signal }) -> { rows } | rows                       (content-addressed hydration)
 *   resolveExpectedInventoryRequestHash({ accountId, requestedAsOf }) -> "<request hash>" | ""   (FBA D-1 proof; pure)
 *   resolveAccountRawSellerId(accountId) -> "<raw seller id>" | ""                        (fragment owner id)
 *   loadDurableContext({ reportKey, accountId, planned }) -> { listingHealthV3DurableOli?, listingHealthV3DurableCatalog? }
 *   deriveSnapshot({ reportKey, sources, context }) -> { status, validated, payload, ... } (default deriveReportSnapshot)
 *   reportDerivations ; computeHash(reportVersion, params) ; liveContracts ; shadowKeyFor
 *   upsertReportJob(job, { signal }) / claimLease(cycleId, reportKey, accountId, { leaseSeconds, signal })
 *   saveShadow(args, { signal }) / reconcileSuccess(args, { signal }) / finalizeCycle({ cycleId }, { signal })
 *   publisher { preflight(reportKey, accountId), publish(reportKey, accountId) }  (buildSchedulerV2Publisher, fenced)
 *   readbackLive({ reportKey, liveReportKey, accountId, paramsHash, signal }) -> { ok, reason? }
 *   verifyLease() -> { ok, reason? } ; snapshotBytes(payload) ; leaseSeconds ; log
 */
export function buildListingHealthV3Release({
  resolveOrg,
  openCycle, getCycleByBucketDate,
  readListingsSnapshot, readListingsRawSnapshot, readInventorySnapshot, loadSnapshotPayload,
  resolveExpectedInventoryRequestHash, resolveAccountRawSellerId,
  loadDurableContext, deriveSnapshot,
  reportDerivations, computeHash, liveContracts, shadowKeyFor = (rk) => "scheduler-v2/" + rk,
  upsertReportJob, claimLease, saveShadow, reconcileSuccess,
  finalizeCycle,
  publisher, readbackLive,
  verifyLease = async () => ({ ok: true }),
  snapshotBytes = (p) => Buffer.byteLength(JSON.stringify(p == null ? null : p), "utf8"),
  leaseSeconds = 300,
  log = () => {},
} = {}) {
  for (const [name, fn] of [["resolveOrg", resolveOrg], ["openCycle", openCycle], ["getCycleByBucketDate", getCycleByBucketDate], ["readListingsSnapshot", readListingsSnapshot], ["readListingsRawSnapshot", readListingsRawSnapshot], ["readInventorySnapshot", readInventorySnapshot], ["loadSnapshotPayload", loadSnapshotPayload], ["resolveExpectedInventoryRequestHash", resolveExpectedInventoryRequestHash], ["resolveAccountRawSellerId", resolveAccountRawSellerId], ["loadDurableContext", loadDurableContext], ["deriveSnapshot", deriveSnapshot], ["computeHash", computeHash], ["upsertReportJob", upsertReportJob], ["claimLease", claimLease], ["saveShadow", saveShadow], ["reconcileSuccess", reconcileSuccess], ["finalizeCycle", finalizeCycle], ["readbackLive", readbackLive]]) {
    if (typeof fn !== "function") throw new Error(`buildListingHealthV3Release requires ${name} (fail closed).`);
  }
  if (!liveContracts || !reportDerivations) throw new Error("buildListingHealthV3Release requires liveContracts + reportDerivations (fail closed).");
  if (!publisher || typeof publisher.preflight !== "function" || typeof publisher.publish !== "function") throw new Error("buildListingHealthV3Release requires a publisher with preflight + publish (fail closed).");
  const derivation = reportDerivations[LIVE_REPORT_KEY];
  if (!derivation || !nb(derivation.snapshotVersion)) throw new Error("buildListingHealthV3Release requires the listing-health-v3 derivation entry (fail closed).");
  const SHADOW_REPORT_VERSION = S(derivation.snapshotVersion); // "listing-health/v3-oli-window"

  // Read + independently re-prove ONE durable pointer at exactly the requested as-of, then hydrate its rows. Returns
  // { snapshot, rows } on success; a defer() result object on any failure (the caller returns it). PER-ACCOUNT safe.
  async function proveAndHydrate(reader, requestKey, accountId, requestedAsOf, org, conn, signal) {
    let res;
    try { res = await reader({ organizationFingerprint: org, connectionId: conn, accountId, signal }); }
    catch (e) { return { defer: defer(requestKey + "-read-threw:" + S(e && e.message)) }; }
    if (signal && signal.aborted) return { defer: DEADLINE() };
    const snapshot = res && res.read === "ok" ? (res.snapshot || null) : null;
    if (!snapshot) return { defer: defer("no-durable-" + requestKey) };
    if (S(snapshot.as_of ?? snapshot.asOf) !== S(requestedAsOf)) return { defer: defer(requestKey + "-not-d1") };
    if (!nb(S(snapshot.payload_sha ?? snapshot.payloadSha)) || !nb(S(snapshot.source_request_hash ?? snapshot.sourceRequestHash))) return { defer: defer(requestKey + "-incomplete") };
    let rows;
    try { rows = rowsOf(await loadSnapshotPayload(S(snapshot.object_path ?? snapshot.objectPath), { signal })); }
    catch (e) { return { defer: defer(requestKey + "-payload-unreadable:" + S(e && e.message)) }; }
    if (signal && signal.aborted) return { defer: DEADLINE() };
    if (!Array.isArray(rows)) return { defer: defer(requestKey + "-payload-dangling") };
    return { snapshot, rows };
  }

  async function runForAccount({ accountId, requestedAsOf, cycleBucket, signal }) {
    const aborted = () => !!(signal && signal.aborted);
    const opt = { signal };
    if (aborted()) return DEADLINE();
    if (!nb(accountId) || !DATE_RE.test(S(requestedAsOf)) || !nb(cycleBucket)) return hardFail("derive", "bad-args");

    const org = await resolveOrg();
    if (aborted()) return DEADLINE();
    const organizationFingerprint = S(org && org.organizationFingerprint);
    const connectionId = S(org && org.connectionId) || "primary";
    if (!organizationFingerprint) return defer("org-unreadable");

    let rawSellerId = "";
    try { rawSellerId = S(await resolveAccountRawSellerId(accountId)); } catch { rawSellerId = ""; }
    if (aborted()) return DEADLINE();
    if (!nb(rawSellerId)) return defer("raw-seller-unresolved");

    // (2) durable Listings + Listings-Raw -- BOTH required, both independently re-proven D-1 (fresh read; the reconciler
    // already gated, we re-prove). Hydrate the content-addressed rows (zero export).
    const l = await proveAndHydrate(readListingsSnapshot, LISTINGS_REQUEST_KEY, accountId, requestedAsOf, organizationFingerprint, connectionId, signal);
    if (l.defer) return l.defer;
    const r = await proveAndHydrate(readListingsRawSnapshot, LISTINGS_RAW_REQUEST_KEY, accountId, requestedAsOf, organizationFingerprint, connectionId, signal);
    if (r.defer) return r.defer;

    // (3) OPTIONAL durable FBA inventory reuse -- included ONLY when its recomputed D-1 request hash proves the requested
    // day AND it carries rows for that day. Absent / older / other-day / empty / unreadable -> inventory unavailable
    // (available:false); the derive then yields inventory.available:false (FBA on-hand falls back), NEVER a defer/throw.
    let inventorySource = { available: false };
    let inventorySnapshot = null;
    {
      let expected = "";
      try { expected = S(await resolveExpectedInventoryRequestHash({ accountId, requestedAsOf })); } catch { expected = ""; }
      if (aborted()) return DEADLINE();
      if (nb(expected)) {
        let invRes = null;
        try { invRes = await readInventorySnapshot({ organizationFingerprint, connectionId, accountId, signal }); } catch { invRes = null; }
        if (aborted()) return DEADLINE();
        const snap = invRes && invRes.read === "ok" ? (invRes.snapshot || null) : null;
        const invHash = S(snap && (snap.source_request_hash ?? snap.sourceRequestHash));
        if (snap && invHash === expected) {
          let invRows = null;
          try { invRows = rowsOf(await loadSnapshotPayload(S(snap.object_path ?? snap.objectPath), opt)); } catch { invRows = null; }
          if (aborted()) return DEADLINE();
          // Keep ONLY the D-1 slice (defensive: a proven-D-1 single-day snapshot already carries only that day).
          const d1Rows = Array.isArray(invRows) ? invRows.filter((row) => row && S(row.date) === S(requestedAsOf)) : [];
          if (d1Rows.length > 0) {
            inventorySource = {
              available: true, rows: d1Rows,
              fragments: [{ requestKey: INVENTORY_REQUEST_KEY, from: requestedAsOf, to: requestedAsOf, sellerOrVendorIds: [rawSellerId], rows: d1Rows }],
              disabled: false, disabledPolicy: null, reason: null,
            };
            inventorySnapshot = snap;
          }
        }
      }
    }

    // (4) DERIVE listing-health-v3 ONLY via the CANONICAL registry derivation. Build the derived durable context (OLI +
    // catalog) with the SAME loader the shadow worker uses; a durable read failure returns {} -> the derive throws
    // 'unavailable' -> defer (LKG preserved). Window controls are OMITTED (30D default, matching the canonical shadow).
    if (aborted()) return DEADLINE();
    const baseContext = {
      to: requestedAsOf,
      inventoryAsOf: requestedAsOf,
      accountId,
      rawSellerId,
      listingsFetchedAt: S(l.snapshot.validated_at ?? l.snapshot.validatedAt) || null,
      rawFetchedAt: S(r.snapshot.validated_at ?? r.snapshot.validatedAt) || null,
      inventoryFetchedAt: inventorySnapshot ? (S(inventorySnapshot.validated_at ?? inventorySnapshot.validatedAt) || null) : null,
    };
    let durableCtx;
    try { durableCtx = await loadDurableContext({ reportKey: LIVE_REPORT_KEY, accountId, planned: { context: baseContext } }); }
    catch (e) { return defer("durable-context-threw:" + S(e && e.message)); }
    if (aborted()) return DEADLINE();
    if (!durableCtx || typeof durableCtx !== "object") return defer("durable-context-unavailable");
    const context = { ...baseContext, ...durableCtx };

    const sources = {
      [LISTINGS_REQUEST_KEY]: noDateSource(LISTINGS_REQUEST_KEY, l.rows, rawSellerId),
      [LISTINGS_RAW_REQUEST_KEY]: noDateSource(LISTINGS_RAW_REQUEST_KEY, r.rows, rawSellerId),
      [INVENTORY_REQUEST_KEY]: inventorySource,
    };

    let derived;
    try { derived = await deriveSnapshot({ reportKey: LIVE_REPORT_KEY, sources, context }); }
    catch (e) { return hardFail("derive", "derive-threw:" + S(e && e.message)); }
    if (aborted()) return DEADLINE();
    if (!derived || derived.status !== "derived" || derived.validated !== true) {
      const st = S(derived && derived.status);
      // 'unavailable'/'blocked' = a source/config state (durable OLI/catalog not yet ready, terminally-disabled source):
      // defer, LKG preserved. Anything else (invalid/unmapped/not-implemented/malformed) is a HARD derive failure.
      if (st === "unavailable" || st === "blocked") return defer("derive-" + st + ":" + S(derived && derived.reason));
      return hardFail("derive", "derive-" + (st || "malformed"));
    }
    const payload = derived.payload;
    if (!payload || typeof payload !== "object") return hardFail("derive", "payload-malformed");

    const params = { reportVersion: SHADOW_REPORT_VERSION, accountId, to: requestedAsOf };
    const paramsHash = computeHash(SHADOW_REPORT_VERSION, params);
    // Lineage. depends_on = the OWNED durable source request hashes the derive consumed (Listings + Listings-Raw +
    // inventory-when-included), sorted + deduped -- honest owned-source provenance. durable_content_deps = the two
    // Listings content tokens (recomputed IDENTICALLY to the revision, so revisionCoveredByJob's subset check holds).
    const dependsOn = [...new Set([
      S(l.snapshot.source_request_hash ?? l.snapshot.sourceRequestHash),
      S(r.snapshot.source_request_hash ?? r.snapshot.sourceRequestHash),
      ...(inventorySnapshot ? [S(inventorySnapshot.source_request_hash ?? inventorySnapshot.sourceRequestHash)] : []),
    ].filter(nb))].sort();
    const contentToken = listingsContentProvenanceToken({ accountId, connectionId, asOf: requestedAsOf, requestHash: S(l.snapshot.source_request_hash ?? l.snapshot.sourceRequestHash), contentSha: S(l.snapshot.payload_sha ?? l.snapshot.payloadSha) });
    const rawContentToken = listingsRawContentProvenanceToken({ accountId, connectionId, asOf: requestedAsOf, requestHash: S(r.snapshot.source_request_hash ?? r.snapshot.sourceRequestHash), contentSha: S(r.snapshot.payload_sha ?? r.snapshot.payloadSha) });
    const durableContentDeps = [contentToken, rawContentToken];

    // (5) open the dedicated cycle (WRITE) -- abort-check immediately before every write from here on.
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
    try {
      await upsertReportJob({
        cycleId, reportKey: LIVE_REPORT_KEY, reportVersion: SHADOW_REPORT_VERSION,
        accountId, connectionId: "primary", bucket: cycleBucket,
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

    // (6) finalize ONLY this dedicated cycle (directly).
    if (aborted()) return DEADLINE();
    let fin;
    try { fin = await finalizeCycle({ cycleId }, opt); }
    catch (e) { return hardFail("finalize", "finalize-threw:" + S(e && e.message)); }
    if (aborted()) return DEADLINE();
    const fdisp = fin && fin.disposition;
    if (fdisp !== "finalized" && fdisp !== "already-terminal") return hardFail("finalize", "finalize-" + S(fdisp || "malformed"));

    // (7) preflight + publish + read back ONLY listing-health-v3 (reviewed fenced publisher + CAS + buildLiveReadback).
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

    // The publish already LANDED. The read-back is a READ-ONLY confirmation, threaded with the signal. If aborted BEFORE
    // it, do NOT start it and NEVER claim the published write was undone -- return the bounded deadline result.
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
