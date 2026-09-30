// "Publish from saved data" -- the Brand View SINGLE-UNIT executor: publishes EXACTLY ONE (account, brand) Brand View
// from durable saved evidence through the EXISTING reviewed path -- the brand-view recovery route runtime
// (lib/server/sync/routes/brand-view.release.js), the generic route release (route-publication-release.js ->
// the fenced four-gate publisher -> the shared live read-back -> the served-row check) and the saved-data reconciler's
// two-phase core -- wired EXACTLY as scripts/release/publication-route-reconcile.mjs wires them, with three differences:
//   1. the unit set is filtered to the ONE requested brand (never a fan-out over the account's brands);
//   2. the control window's global lease TTL is SHORT (leaseTtlSeconds, default 90 s) with ZERO lease-wait: a crash /
//      kill can hold the control plane for at most that TTL, and a held lease is contention (the request is released
//      back to the queue WITHOUT consuming an attempt), never a wait;
//   3. one control window only (interWindowPauseMs 0 -- there is exactly one unit).
// No second publisher, no direct upsert, no DataDoe call: the runtime only receives the read-only supabase facade + a
// read-only pg reader; every write goes through the release's injected lineage writers and the fenced publisher.
// measureBrandViewUnit is the READ-ONLY canary probe (evidence + bundle + derive + served currency; zero writes).
// Every collaborator is INJECTED (offline-testable over the brand-view routes test world). 7-bit ASCII, LF.

import {
  buildRoutePublicationRelease, buildRouteReconcileAdapter, routeCliOperator,
} from "../sync/route-publication-release.js";
import { buildSavedDataReconciler } from "../sync/saved-data-reconciler.js";
import { validateRouteRuntime } from "../recovery/route-contract.js";
import { brandUnitKey } from "../sync/routes/brand-view.release.js";
import { regionOfCountry, directoryEntry } from "../recovery/routes/brand-view-brands.route.js";
import { outcomeForUnit, outcomeForMissingUnit, boundedReason, REQUEST_STATUS } from "./contract.js";

const S = (v) => (v == null ? "" : String(v));
const errMsg = (e) => S(e && e.message ? e.message : e).replace(/[^\x20-\x7e]/g, "").slice(0, 160);
export const BRAND_VIEW_PUBLISHER_KEY = "brand-view";
export const DEFAULT_LEASE_TTL_SECONDS = 90;
export const DEFAULT_DEADLINE_SECONDS = 300;
const START_RESERVE_SECONDS = 120;
const SETTLE_GRACE_MS = 8000;

/** UTC D-1 of `nowMs` (the scheduler's epoch convention; the release keys its dedicated cycle by it). */
export function epochFor(nowMs) {
  return new Date(Number(nowMs) - 86400000).toISOString().slice(0, 10);
}

/** Resolve the job's account in the durable directory -> { ok, country, region, identityAsOf } | { ok:false, reason } (PURE). */
export function resolveJobScope(job, { directory, marketplaceToday, nowMs }) {
  const entry = directoryEntry(directory, S(job && job.account_id));
  const country = S(entry && entry.country).trim();
  if (!country) return { ok: false, finish: REQUEST_STATUS.MISSING_EVIDENCE, reason: "account-not-in-durable-directory" };
  const region = regionOfCountry(country);
  if (!region) return { ok: false, finish: REQUEST_STATUS.FAILED, reason: "account-region-unassigned" };
  const identityAsOf = marketplaceToday(country, new Date(Number(nowMs)));
  return { ok: true, country, region, identityAsOf };
}

// The route runtime restricted to ONE brand unit AT THE REQUESTED DATE (the wrapper keeps every other hook
// byte-identical). A marketplace midnight between the start check and the evidence read yields a unit for the NEXT
// date: it is dropped, so a request can never publish a different day than the one it was made for.
function singleBrandRuntime(base, brand, asOf = null) {
  const want = brandUnitKey(brand);
  return Object.freeze({
    ...base,
    expandUnits: async (args) => {
      const units = await base.expandUnits(args);
      return (Array.isArray(units) ? units : []).filter((u) => u && u.unitKey === want && (asOf == null || S(u.targetAsOf) === asOf));
    },
  });
}

function buildRuntime(env, region, epoch) {
  const base = env.cliRoute.build(Object.freeze({
    bucket: region, epoch, directory: env.directory, orgFp: env.orgFp, connectionId: "primary",
    primaryConnection: env.primaryConnection || null, connections: env.connections || [],
    sb: env.sb, pgReadOnly: env.pgReadOnly, selectors: env.selectors, computeHash: env.computeHash,
    liveContracts: env.liveContracts, reportDerivations: env.reportDerivations,
    marketplaceToday: env.marketplaceToday, normalizeMarketplace: env.normalizeMarketplace,
    now: () => env.now(), strict: true, log: env.log || (() => {}),
  }));
  return base;
}

/**
 * Publish ONE Brand View unit for a claimed request. job: { id, account_id, brand, as_of, run_token }.
 * -> { finish, reason, retrySeconds, unitState, unitReason, cls, counts, controlCleanupUnresolved, zeroExport, ms }
 * finish: 'verify' | 'verify-or-fail' | 'retry' | 'release' | 'missing_evidence' | 'failed' (the worker core performs
 * the served read-back for 'verify*' before it may record published / already_current).
 */
export async function runBrandViewUnitPublish({ job, env, signal = null }) {
  const t0 = Date.now();
  const nowMs = env.now();
  const done = (o) => ({ controlCleanupUnresolved: false, counts: null, unitState: null, unitReason: null, cls: null, retrySeconds: 0, ...o, ms: Date.now() - t0 });
  const scope = resolveJobScope(job, { directory: env.directory, marketplaceToday: env.marketplaceToday, nowMs });
  if (!scope.ok) return done({ finish: scope.finish, reason: scope.reason });
  // The request names the dashboard date it was made for; after the marketplace day rolls, that date is no longer
  // the one the dashboard serves -- publishing it would help nobody. The user re-requests for the new date.
  if (S(job.as_of).slice(0, 10) !== scope.identityAsOf) return done({ finish: REQUEST_STATUS.FAILED, reason: "as-of-rolled:" + scope.identityAsOf });
  const region = scope.region;
  const epoch = epochFor(nowMs);
  const accountId = S(job.account_id);
  const brand = S(job.brand);
  if (!/^[A-Za-z0-9._:-]{8,150}$/.test(S(job.run_token))) return done({ finish: REQUEST_STATUS.FAILED, reason: "run-token-invalid" });

  let runtime;
  try { runtime = singleBrandRuntime(buildRuntime(env, region, epoch), brand, scope.identityAsOf); validateRouteRuntime(runtime, env.cliRoute.id); }
  catch (e) { return done({ finish: REQUEST_STATUS.FAILED, reason: boundedReason("route-build-failed:" + errMsg(e)) }); }

  const operator = routeCliOperator({ bucket: region, runToken: S(job.run_token) });
  const operationKey = "publish-request/brand-view/" + region + "/" + epoch;
  const controls = env.makeControls({ operator, operationKey, leaseTtlSeconds: env.leaseTtlSeconds || DEFAULT_LEASE_TTL_SECONDS });
  const verifyLease = async ({ signal: s = null } = {}) => {
    if (s && s.aborted) return { ok: false, reason: "deadline-aborted" };
    const fence = controls.fence();
    if (!fence) return { ok: false, reason: "no-fence" };
    try { const r = await env.renewControlLease({ ownerToken: fence.ownerToken, generation: fence.generation, ttlSeconds: env.leaseTtlSeconds || DEFAULT_LEASE_TTL_SECONDS }); return { ok: !!(r && r.disposition === "renewed"), reason: r && (r.reason || r.disposition) }; }
    catch (e) { return { ok: false, reason: "renew-error:" + errMsg(e) }; }
  };
  let activeOpSignal = null;
  let publisher = null;
  const publisherFor = (s) => {
    activeOpSignal = s || null;
    if (!publisher) publisher = env.makePublisher({ getControlFence: () => (activeOpSignal && activeOpSignal.aborted) || (signal && signal.aborted) ? null : controls.fence() });
    return publisher;
  };
  const evidenceContext = { directory: env.directory, organizationFingerprint: env.orgFp, connectionId: "primary" };
  const w = env.lineage;
  let release, adapter;
  try {
    release = buildRoutePublicationRelease({
      route: env.cliRoute, runtime,
      deps: {
        openCycle: w.openCycle, getCycleByBucketDate: w.getCycleByBucketDate, claimCycle: w.claimCycle, readCycle: w.readCycle,
        upsertReportJob: w.upsertReportJob, claimLease: w.claimLease, saveShadow: w.saveShadow, reconcileSuccess: w.reconcileSuccess,
        finalizeCycle: w.finalizeCycle, readLatestJob: w.readLatestJob, readSnapshot: w.readSnapshot, loadStoragePayload: w.loadStoragePayload,
        publisherFor, verifyLease, readbackLive: env.readbackLive,
        liveContracts: env.liveContracts, reportDerivations: env.reportDerivations, computeHash: env.computeHash,
        evidenceContext, publishSnapshotUpdate: w.publishSnapshotUpdate || (async () => {}),
        ...(typeof env.now === "function" ? { now: () => env.now() } : {}),
        log: env.log || (() => {}),
      },
    });
    adapter = buildRouteReconcileAdapter({ route: env.cliRoute, runtime, bucket: region, directory: env.directory, liveContracts: env.liveContracts, readLatestJob: w.readLatestJob, verifyExact: false });
  } catch (e) { return done({ finish: REQUEST_STATUS.FAILED, reason: boundedReason("release-build-failed:" + errMsg(e)) }); }

  const deadlineSec = Number(env.deadlineSeconds) || DEFAULT_DEADLINE_SECONDS;
  const runStartMs = Date.now();
  const startCutoffSec = Math.max(Math.floor(deadlineSec / 2), deadlineSec - START_RESERVE_SECONDS);
  const outOfTime = () => (signal && signal.aborted) || (Date.now() - runStartMs) / 1000 > startCutoffSec;
  const deadlineRace = (p) => {
    const remainingMs = Math.max(0, deadlineSec * 1000 - (Date.now() - runStartMs));
    let t; const timer = new Promise((resolve) => { t = setTimeout(() => resolve({ __deadline: true }), remainingMs); });
    return Promise.race([Promise.resolve(p).then((v) => { clearTimeout(t); return v; }), timer]);
  };
  const awaitSettled = (p) => {
    let t; const grace = new Promise((resolve) => { t = setTimeout(() => resolve({ settled: false }), SETTLE_GRACE_MS); });
    return Promise.race([Promise.resolve(p).then(() => { clearTimeout(t); return { settled: true }; }, () => { clearTimeout(t); return { settled: true }; }), grace]);
  };
  const withTimeout = (p, label) => { let t; return Promise.race([Promise.resolve(p).finally(() => clearTimeout(t)), new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label + " timed out after 120000ms")), 120000); })]); };

  const reconciler = buildSavedDataReconciler({
    resolveOrg: async () => ({ organizationFingerprint: env.orgFp, connectionId: "primary" }),
    bucketAccounts: async () => [{ accountId }],
    adapter,
    readLatestReportJob: ({ reportKey, accountId: a }) => w.readLatestJob(reportKey, a),
    readShadowSnapshot: (args) => w.readSnapshot(args),
    readLiveSnapshot: (args) => w.readSnapshot(args),
    loadStoragePayload: (p) => w.loadStoragePayload(p),
    verifyLiveReadback: env.readbackLive,
    liveContracts: env.liveContracts, computeHash: env.computeHash, reportDerivations: env.reportDerivations,
    runPrepareForUnit: (args) => release.prepareForUnit(args),
    runPublishForUnit: (args) => release.publishForUnit(args),
    openControls: controls.openControls, closeControls: controls.closeControls,
    outOfTime, deadlineRace, makeAbortController: () => new AbortController(), awaitSettled,
    reportKeys: [BRAND_VIEW_PUBLISHER_KEY], withTimeout, log: env.log || (() => {}), family: "brand-view",
    interWindowPauseMs: 0,
  });
  let out;
  try { out = await reconciler.run({ bucket: region, requestedAsOf: epoch, accountIds: [accountId], mode: "periodic", dryRun: false }); }
  catch (e) { return done({ finish: "retry", retrySeconds: 300, reason: boundedReason("reconciler-threw:" + errMsg(e)) }); }
  const rec = (out && Array.isArray(out.perAccount) ? out.perAccount : []).find((r) => r && r.accountId === accountId) || null;
  const unit = rec && Array.isArray(rec.units) ? rec.units.find((u) => u && u.unitKey === brandUnitKey(brand)) || null : null;
  const cleanup = !!(out && out.controlCleanupUnresolved === true);
  const counts = out && out.counts ? out.counts : null;
  const report = unit && unit.reports ? unit.reports[BRAND_VIEW_PUBLISHER_KEY] : null;
  if (!report || !report.state) {
    // The day rolled during the run (the unit was filtered out as another date): say so, never "missing evidence".
    const rolledTo = env.marketplaceToday(scope.country, new Date(Number(env.now())));
    if (rolledTo !== scope.identityAsOf) return done({ finish: REQUEST_STATUS.FAILED, reason: "as-of-rolled:" + rolledTo, controlCleanupUnresolved: cleanup, counts });
    const unitsEmpty = !!(rec && (rec.unitsReason === "units-empty" || (Array.isArray(rec.units) && rec.units.length === 0 && rec.eligible)));
    const o = outcomeForMissingUnit({ runOk: out ? out.ok : false, runCode: out && out.code, accountRecord: rec, unitsEmpty });
    return done({ ...o, controlCleanupUnresolved: cleanup, counts });
  }
  const o = outcomeForUnit(report.state, report.reason);
  return done({ ...o, unitState: S(report.state), unitReason: report.reason == null ? null : S(report.reason), controlCleanupUnresolved: cleanup, counts });
}

/**
 * READ-ONLY canary measurement of ONE Brand View unit (ZERO writes): the route's own evidence read, the strict bundle
 * resolve (evidence + legacy fingerprint), the full derive over saved evidence, and the served-currency check.
 * -> { ok, steps: [{ step, ms, ok, detail }], payloadBytes, unitEligible, currency }
 */
export async function measureBrandViewUnit({ job, env, currency }) {
  const steps = [];
  const time = async (step, fn) => {
    const t = Date.now();
    try { const v = await fn(); steps.push({ step, ms: Date.now() - t, ok: true }); return v; }
    catch (e) { steps.push({ step, ms: Date.now() - t, ok: false, detail: errMsg(e) }); return undefined; }
  };
  const nowMs = env.now();
  const scope = resolveJobScope(job, { directory: env.directory, marketplaceToday: env.marketplaceToday, nowMs });
  if (!scope.ok) return { ok: false, reason: scope.reason, steps };
  const epoch = epochFor(nowMs);
  const runtime = singleBrandRuntime(buildRuntime(env, scope.region, epoch), S(job.brand));
  const ev = await time("evidence-read (7 read-only SQL, one account)", () => runtime.readScopeEvidence({ scope: [S(job.account_id)], directory: env.directory, organizationFingerprint: env.orgFp }));
  const evidence = ev && ev.ok && ev.perAccount instanceof Map ? ev.perAccount.get(S(job.account_id)) : null;
  const units = evidence ? await time("expand-units (filtered to the requested brand)", () => runtime.expandUnits({ accountId: S(job.account_id), evidence })) : [];
  const unit = Array.isArray(units) && units[0] ? { ...units[0], targetAsOf: scope.identityAsOf } : null;
  const bundle = unit ? await time("resolve-bundle (evidence re-read + dependency fingerprint)", () => runtime.resolveBundle(unit, { strict: true })) : null;
  let payloadBytes = null;
  if (bundle && bundle.eligible) {
    const d = await time("derive (hydrate saved reports + Ads rows + build)", () => runtime.derive(bundle.bundle, { unit, strict: true }));
    if (d && d.payload) payloadBytes = Buffer.byteLength(JSON.stringify(d.payload), "utf8");
    else if (d && d.notReady) steps.push({ step: "derive-result", ms: 0, ok: false, detail: S(d.reason) });
  } else if (bundle) steps.push({ step: "bundle-result", ms: 0, ok: false, detail: S(bundle.reason) });
  const cur = typeof currency === "function" ? await time("served-currency (exact row identity + fingerprint)", () => currency()) : null;
  return {
    ok: steps.every((s) => s.ok), region: scope.region, identityAsOf: scope.identityAsOf, unitFound: !!unit,
    unitEligible: !!(bundle && bundle.eligible), bundleReason: bundle && !bundle.eligible ? S(bundle.reason) : null,
    payloadBytes, currency: cur ? { current: cur.current, reason: cur.reason } : null, steps,
  };
}
