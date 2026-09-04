// The ONE trusted FBA Shipment Plan operation core -- SHARED, with no drift, by:
//   - the CLI operator            (scripts/release/fba-plan-golive.mjs): loops the bounded pass to completion;
//   - the AUTOMATIC GitHub scheduler (.github/workflows/fba-plan-golive.yml): runs the CLI operator per bucket;
//   - the Data Sync Center route  (api/admin/sources.js): runs ONE bounded slice per POST, resumed by polling.
//
// It runs the SAME reviewed Scheduler-v2 machinery every path uses: the shadow dispatcher (batched
// marketplace-safe FBA Inventory Health + AWD-capable Listings fetch, durable OLI + Catalog derive -- NEVER a new
// OLI/Catalog/Ads export), the four-gate CAS publisher, the guarded fba-plan control package, an
// ALWAYS-safe-close fetch + publication envelopes, a hard token ceiling, and the durable operation identity (the
// DEDICATED `${bucket}-fba` cycle at as-of = D-1). There is NO parallel implementation: the route and the
// operator call THIS module.
//
// Deadline-aware + bounded-resumable: `advanceFbaPlanBucket` runs ONE pass bounded by the caller's slice budget
// (`outOfTime` / `deadlineMs`). A route passes a ~50s budget and re-enters on the next poll; the CLI passes an
// effectively-unbounded budget and loops until `phase === "complete"`. Every phase re-proves from DURABLE state
// (the dedicated cycle's status + freshness-CAS publish), so a replay -- concurrent poll, retry, fallback cron --
// is a zero-create idempotent no-op, never a duplicate export or double-spent token.

import { organizationFingerprint } from "../source-identity.js";
import { buildShadowReportPlan } from "./report-planner.js";
import { resolveGoLiveAsOf, fbaGoLiveTokenCost } from "./fba-plan-golive-plan.js";
import { accountInScope } from "./scheduler-scope.js";

const OLI_SOURCE_KEY = "order-line-items";
const S = (v) => (v == null ? "" : String(v));
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(S(v));
const TERMINAL = new Set(["succeeded", "partial", "failed"]);
const OK_FINALIZE = new Set(["finalized", "already-terminal"]);
const OK_PUBLISH = new Set(["published", "already-current", "newer-live"]);

// The FBA source cards the Data Sync Center + scheduler drive through THIS operation. Both map to the ONE
// fba-plan pipeline: the pipeline fetches FBA Inventory Health for the bucket and, for the AWD-CAPABLE marketplaces
// (US + the EU5 -- GB/UK, DE, FR, IT, ES; see lib/server/reports/awd-capability.js), Listings/AWD. Syncing either card
// runs the same bucket pipeline (the pipeline decides AWD eligibility per-account by marketplace capability); Listings
// on a non-AWD marketplace is therefore a no-op source for that account.
export const FBA_OPERATION_SOURCE_KEYS = Object.freeze(["fba-inventory-health", "listings"]);
export function isFbaOperationSource(sourceKey) { return FBA_OPERATION_SOURCE_KEYS.includes(S(sourceKey).trim()); }

// The dedicated fba-plan cycle bucket namespace (us-fba / non-us-fba) -- NEVER collides with the scheduler-v2
// daily (us|non-us) cycle, so an FBA failure can never touch Daily Reporting / Brand View.
export function fbaCycleBucket(bucket) { return S(bucket).trim() + "-fba"; }

// The server D-1 ceiling (never publish past yesterday). Server-resolved -- never taken from a request body.
export function fbaServerCeiling(now = Date.now()) { return new Date(now - 86400000).toISOString().slice(0, 10); }
// Inventory is a current snapshot, never capped by the sales coverage cutoff.
export function fbaInventoryAsOf(now = Date.now()) { return new Date(now).toISOString().slice(0, 10); }

/**
 * Resolve the coverage-maximizing go-live as-of + the included/blocked account split. Pure orchestration over
 * injected readers (ZERO DataDoe): reads each account's durable OLI coverage and picks the as-of that maximizes
 * publishable accounts within `maxBlocked` genuinely-stale accounts, clamped to the D-1 ceiling. An explicit
 * `asOfArg` (operator override) is honored (clamped) with the same stale-account split.
 *
 * readers: { resolveDataDoeAccountIds, getSourceCoverageWindows }
 * Returns { asOf, included: string[], blocked: [{accountId, provenTo}], proven: [{accountId, provenTo}] }.
 */
export async function resolveFbaPlanScope({ accounts, connections, asOfArg = null, maxBlocked = 2, ceiling = fbaServerCeiling(), readers } = {}) {
  const { resolveDataDoeAccountIds, getSourceCoverageWindows } = readers || {};
  if (typeof resolveDataDoeAccountIds !== "function" || typeof getSourceCoverageWindows !== "function") {
    throw new Error("resolveFbaPlanScope requires readers.resolveDataDoeAccountIds + readers.getSourceCoverageWindows (fail closed).");
  }
  const provenTo = async (account) => {
    let resolved;
    try { resolved = resolveDataDoeAccountIds([account.accountId], connections); } catch { return null; }
    if (!resolved || resolved.rawAccountIds.length !== 1) return null;
    const org = resolved.connection.organizationFingerprint || organizationFingerprint(resolved.connection.apiKey);
    const connectionId = resolved.connection.id === "secondary" ? "dd-secondary" : "primary";
    let cov;
    try { cov = await getSourceCoverageWindows({ organizationFingerprint: org, connectionId, accountId: account.accountId, sourceKey: OLI_SOURCE_KEY }); }
    catch { return null; }
    const wins = cov && cov.read === "ok" ? (cov.windows || []) : [];
    const tos = wins.map((w) => S(w.to ?? w.covered_to ?? "")).filter((d) => isDate(d));
    return tos.length ? tos.reduce((m, t) => (t > m ? t : m)) : null;
  };
  // Resolve every account's proven coverage in PARALLEL (a bounded route re-resolves this each poll; sequential
  // reads were the dominant per-slice cost and starved the publish phase). Each read is independent + fail-soft.
  const proven = await Promise.all(accounts.map(async (a) => ({ accountId: a.accountId, provenTo: await provenTo(a) })));
  const clamped = asOfArg && isDate(asOfArg) ? (asOfArg > ceiling ? ceiling : asOfArg) : null;
  const resolved = clamped
    ? {
        asOf: clamped,
        included: proven.filter((p) => p.provenTo && p.provenTo >= clamped).map((p) => p.accountId),
        blocked: proven.filter((p) => !(p.provenTo && p.provenTo >= clamped)),
      }
    : resolveGoLiveAsOf(proven, { ceiling, maxBlocked });
  return { ...resolved, proven };
}

// Partition accounts into the two independent buckets by their marketplace country (US vs everything else).
// Only correctly-bound PRIMARY accounts survive: a connection-prefixed id (any id containing ":") or an account
// without a marketplace country can never be batched or bucketed safely and is dropped (defense-in-depth -- the
// release loader already excludes them, and the batcher's owner-metadata gate would reject them downstream).
export function partitionFbaBucketAccounts(accounts) {
  const us = [];
  const nonUs = [];
  for (const a of accounts || []) {
    if (!a || !a.accountId || String(a.accountId).includes(":") || !S(a.country).trim()) continue;
    (S(a.country).trim().toUpperCase() === "US" ? us : nonUs).push(a);
  }
  return { us, nonUs };
}
// Accounts belonging to a routing scope (region india|europe-au|us-ca or legacy us|non-us). Drops non-primary
// (":" in id) + missing-marketplace accounts (defense-in-depth). Region scopes route by marketplace; legacy buckets
// by the us/non-us rule -- so a us-ca run includes US + CA accounts, and AWD (US-only) is still decided per-account
// (country === "US") inside the pipeline, orthogonal to the region.
export function fbaBucketAccounts(accounts, bucket) {
  return (accounts || []).filter(
    (a) => a && a.accountId && !String(a.accountId).includes(":") && S(a.country).trim() && accountInScope(bucket, a.country),
  );
}

/**
 * Build the exact batched plan + prove the token cost for ONE bucket (ZERO creates). `getSourceExportCache`
 * proves what is already adoptable from the durable cache (adoptable => 0 tokens). Returns { plan, cost }.
 */
export async function planFbaBucketCost({ bucketAccounts, connections, asOf, inventoryAsOf = null, getSourceExportCache }) {
  const asOfFor = () => asOf;
  const plan = bucketAccounts.length
    ? buildShadowReportPlan({ accounts: bucketAccounts, reportKeys: ["fba-plan"], connections, asOfFor, inventoryAsOf })
    : { sourceJobs: [], reportRequests: [] };
  const adoptable = new Set();
  const plannedSources = new Map(plan.reportRequests.flatMap((r) => r.sources.map((s) => [s.requestHash, s])));
  for (const j of plan.sourceJobs) {
    const h = j.requestHash ?? j.request_hash;
    try {
      const entry = await getSourceExportCache(h);
      const since = plannedSources.get(h)?.freshnessNotBefore;
      if (entry && (!since || Date.parse(entry.fetched_at ?? entry.fetchedAt ?? "") >= Date.parse(since))) adoptable.add(h);
    } catch { /* treat as not-adoptable */ }
  }
  const cost = fbaGoLiveTokenCost(plan.sourceJobs, (h) => adoptable.has(h));
  return { plan, cost };
}

/**
 * ONE bounded, resumable pass of the FBA Shipment Plan operation for a single bucket. Deadline-aware and
 * stateless-resumable -- it derives its phase from the DURABLE dedicated cycle, so the caller re-enters with the
 * SAME arguments until `phase === "complete"`:
 *
 *   FETCH   (cycle not terminal): run the shadow dispatch (batched FBA/AWD fetch + durable OLI/Catalog derive),
 *           bounded by the slice budget. Drained -> finalize the dedicated cycle. Not drained -> continuation.
 *   PUBLISH (cycle terminal): open ONLY the fba-plan gates -> preflight EVERY included account (capture the
 *           exact live identity) -> publish until the budget runs out -> ALWAYS safe-close -> exact live
 *           read-back of every published pair -> ownership backfill (non-fatal). Partial -> continuation.
 *
 * The HARD token ceiling is gated BEFORE any fetch (a plan over budget refuses with zero creates). Blocked
 * (genuinely-stale-OLI) accounts are simply absent from `includedIds` -> their last-known-good is untouched.
 *
 * deps: {
 *   bucket, asOf, includedIds (string[]), bucketAccounts, cost ({tokens}), maxTokens,
 *   runtime  -- buildSchedulerV2Runtime() (needs .run + .store.getCycleByBucketDate + .store.finalizeCycle);
 *   publisher -- buildSchedulerV2Publisher() (.preflight + .publish);
 *   controls  -- { apply(): Promise, close(): Promise } (the guarded fba-plan control package; close in finally);
 *   readbackLive -- ({reportKey, liveReportKey, accountId, paramsHash}) => {ok, reason?} exact-identity read-back;
 *   ownershipBackfill -- optional async () => {applied, totalRows} (non-fatal completion step);
 *   trigger   -- sync_cycles trigger enum ('github'|'manual'|'vercel'|'pg_cron'); default 'github';
 *   deadlineMs, reserveMs -- the shadow dispatch slice budget (Infinity for the CLI);
 *   outOfTime -- () => boolean publish-loop budget (() => false for the CLI);
 *   maxSlices -- fetch-slice safety cap (default 40); log -- narration sink (safe strings only).
 * }
 * Returns a typed status:
 *   { operationId, phase, ok?, continuationRequired?, problems?, accounts, batches, creates, tokens,
 *     published, readback, blocked }
 */
export async function advanceFbaPlanBucket({
  bucket, asOf, inventoryAsOf = null, includedIds = [], bucketAccounts = [], cost = null, maxTokens = 80,
  runtime, publisher, controls, readbackLive, ownershipBackfill = null,
  trigger = "github", deadlineMs = Infinity, reserveMs = 3000, outOfTime = () => false,
  maxSlices = 40, log = () => {},
} = {}) {
  const cycleBucket = fbaCycleBucket(bucket);
  const cycleDate = inventoryAsOf || asOf;
  const included = [...new Set((includedIds || []).map(S).filter((x) => x))];
  const batches = cost && cost.sourceJobs != null ? cost.sourceJobs : null;
  const base = {
    operationId: cycleBucket + "@" + S(cycleDate),
    accounts: bucketAccounts.length,
    batches: (cost && cost.plan && Array.isArray(cost.plan.sourceJobs)) ? cost.plan.sourceJobs.length : (batches || 0),
    creates: cost ? Number(cost.creates || 0) : 0,
    tokens: cost ? Number(cost.tokens || 0) : 0,
    published: 0,
    readback: 0,
    blocked: 0,
  };
  if (!bucketAccounts.length) return { ...base, phase: "complete", ok: true, published: 0, note: "no-bucket-accounts" };
  if (typeof runtime?.run !== "function" || !runtime.store || typeof runtime.store.getCycleByBucketDate !== "function" || typeof runtime.store.finalizeCycle !== "function") {
    return { ...base, phase: "sync", ok: false, problems: ["fba runtime missing run/store.getCycleByBucketDate/finalizeCycle"] };
  }
  if (typeof publisher?.preflight !== "function" || typeof publisher.publish !== "function") {
    return { ...base, phase: "publish", ok: false, problems: ["fba publisher missing preflight/publish"] };
  }
  if (!controls || typeof controls.apply !== "function" || typeof controls.close !== "function") {
    return { ...base, phase: "publish", ok: false, problems: ["fba controls missing apply/close"] };
  }

  // HARD token ceiling BEFORE any fetch/create (idempotent: the same plan costs the same on every pass, so a
  // replay re-proves the same budget; creates already claimed are one-per-hash and never re-charged).
  if (cost && Number(cost.tokens || 0) > Number(maxTokens)) {
    return { ...base, phase: "sync", ok: false, problems: ["plan costs " + cost.tokens + " tokens > the " + maxTokens + "-token ceiling; refusing (zero creates)"] };
  }

  const cycleOf = async () => runtime.store.getCycleByBucketDate(cycleBucket, cycleDate).catch(() => null);
  let cycle = await cycleOf();
  let cycleId = cycle && cycle.id ? cycle.id : null;

  // ---------------- FETCH phase: shadow dispatch until drained (or the slice budget runs out) ----------------
  if (!(cycle && cycleId && TERMINAL.has(S(cycle.status)))) {
    // The shared runtime enforces the durable account-rollout gate even for manual report dispatches. The global
    // rollout is deliberately safe-closed between operations, so the FBA control package MUST be active while
    // fetching as well as while publishing. Otherwise the runtime returns a drained no-op with cycleId=null,
    // creates no DataDoe export, and a later publish can accidentally observe an older snapshot. Keep this a
    // separate bounded envelope so every continuation/error safe-closes before returning to its caller.
    await controls.apply();
    try {
      let drained = false;
      for (let slice = 1; slice <= maxSlices; slice += 1) {
        // cycleBucket namespaces the fba-plan cycle; the account scope is still the REAL routing region/bucket.
        const res = await runtime.run({
          bucket, cycleBucket, cycleDate, asOf, asOfFor: () => asOf, ...(inventoryAsOf ? { inventoryAsOf } : {}),
          manualReportKeys: ["fba-plan"], trigger, deadlineMs, reserveMs,
        });
        cycleId = res.cycleId || cycleId;
        log(bucket + " fetch slice " + slice + ": cycle=" + S(cycleId).slice(0, 8) + " drained=" + res.drained + (res.deadlineReached ? " (deadline)" : ""));
        // A non-empty FBA operation can never drain without opening/resuming its dedicated cycle. This is a hard
        // false-success guard: do not finalize or publish older snapshots when rollout/readiness prevented fetch.
        if (!cycleId) {
          return { ...base, phase: "sync", ok: false, problems: [bucket + " dispatch returned without a dedicated " + cycleBucket + " cycle; zero FBA exports were executed"] };
        }
        if (res.drained === true) { drained = true; break; }
        if (res.continuationRequired !== true && res.stoppedForBudget !== true && res.deadlineReached !== true) {
          return { ...base, phase: "sync", ok: false, problems: [bucket + " dispatch stopped un-drained without requesting continuation"] };
        }
        if (outOfTime()) return { ...base, phase: "sync", continuationRequired: true, cycleId };
        if (slice === maxSlices) return { ...base, phase: "sync", ok: false, problems: [bucket + " dispatch did not drain within the slice budget"] };
      }
      if (!drained) return { ...base, phase: "sync", continuationRequired: true, cycleId };

      // FINALIZE the DEDICATED fba-plan cycle (a manualReportKeys dispatch never auto-finalizes a shared cycle;
      // this cycle is dedicated, and the four-gate publisher requires a validated job in a terminal cycle).
      // Idempotent: an already-terminal cycle returns "already-terminal".
      const disp = await runtime.store.finalizeCycle({ cycleId });
      const status = disp && disp.cycle && disp.cycle.status;
      log(bucket + " cycle finalized: disposition=" + (disp && disp.disposition) + " status=" + status);
      if (!disp || !OK_FINALIZE.has(S(disp.disposition)) || !TERMINAL.has(S(status))) {
        return { ...base, phase: "sync", ok: false, problems: [bucket + " fba-plan cycle did not reach a terminal status: " + JSON.stringify(disp)] };
      }
    } finally {
      await controls.close();
    }
    cycle = await cycleOf();
    // Let the caller re-enter for the publish phase on a fresh budget if the fetch consumed the slice.
    if (outOfTime()) return { ...base, phase: "publish", continuationRequired: true, cycleId };
  }

  // Re-read and prove the exact regional FBA cycle before opening publication controls. A missing, mismatched, or
  // non-terminal row is never allowed to fall through to publisher.publish(), which may otherwise find an older
  // successful report job and make a stale snapshot appear like a fresh scheduled result.
  if (!cycle || !cycleId || S(cycle.id) !== S(cycleId) || !TERMINAL.has(S(cycle.status))) {
    return { ...base, phase: "sync", ok: false, problems: [bucket + " dedicated " + cycleBucket + " cycle is missing, mismatched, or non-terminal; refusing stale publication"] };
  }

  // ---------------- PUBLISH phase: open gates -> preflight+publish -> ALWAYS safe-close -> read-back ----------
  const published = [];
  const liveIdentity = new Map(); // accountId -> { liveReportKey, paramsHash }
  const problems = [];
  const processed = new Set(); // published (OK/already-current) OR conclusively failed this operation
  await controls.apply();
  try {
    // ONE publish pass per account (publish() runs the SAME four gates internally and returns the exact live
    // identity even for already-current), bounded by the slice budget. A separate preflight pass would DOUBLE the
    // gate reads and, under the route budget, starved the publish so it never converged -- publish() alone gates
    // before its CAS write, so the all-or-nothing per-account guarantee holds without it. Already-published
    // accounts return "already-current" (fast, no re-write); genuinely-unfetched accounts (stale-OLI, or a failed
    // source batch) return not-successful and are skipped (their LKG is untouched), never a hard bucket failure.
    // Publish in bounded-CONCURRENCY chunks: each publish() runs an independent per-account gate + CAS write (a
    // storage hydration dominates its ~seconds), so N-at-a-time collapses the wall-clock (8 sequential publishes
    // overran a single route slice and never reached read-back). outOfTime is checked BETWEEN chunks so a paused
    // slice always stops on a whole-account boundary and resumes cleanly.
    const PUBLISH_CONCURRENCY = 6;
    for (let i = 0; i < included.length; i += PUBLISH_CONCURRENCY) {
      if (outOfTime()) break; // unprocessed accounts publish on the next poll
      const chunk = included.slice(i, i + PUBLISH_CONCURRENCY);
      const results = await Promise.all(chunk.map((accountId) => publisher.publish("fba-plan", accountId).then((r) => ({ accountId, r }))));
      for (const { accountId, r } of results) {
        if (OK_PUBLISH.has(S(r.disposition)) && S(r.liveReportKey) && S(r.paramsHash)) {
          published.push(accountId);
          liveIdentity.set(accountId, { liveReportKey: S(r.liveReportKey), paramsHash: S(r.paramsHash) });
        } else {
          problems.push(accountId.slice(0, 6) + ":" + S(r.disposition));
        }
        processed.add(accountId);
      }
    }
  } finally {
    // ALWAYS safe-close -- success, failure, or slice-budget pause. The gates never survive past this pass.
    try { await controls.close(); } catch (e) { problems.push("SAFE-CLOSE:" + S(e && e.message ? e.message : e)); }
  }

  base.published = published.length;
  base.blocked = bucketAccounts.length - included.length;

  // Continuation: some included accounts were not reached this slice (budget ran out). A replay re-publishes the
  // already-live ones as "already-current" (fast, no regression) and reaches the rest.
  const remaining = included.filter((id) => !processed.has(id));
  if (remaining.length) {
    log(bucket + " publish slice: " + published.length + " live; " + remaining.length + " remaining -> continuation");
    return { ...base, phase: "publish", continuationRequired: true, problems: problems.length ? problems : undefined };
  }

  // EXACT live read-back for every published account (post-safe-close, against the captured identity), in
  // PARALLEL (independent reads; keeps the completing slice under the route budget).
  let readback = 0;
  if (typeof readbackLive === "function") {
    const rbs = await Promise.all(published.map(async (accountId) => {
      const id = liveIdentity.get(accountId);
      if (!id) return { accountId, ok: false, reason: "no-live-identity" };
      const rb = await readbackLive({ reportKey: "fba-plan", liveReportKey: id.liveReportKey, accountId, paramsHash: id.paramsHash });
      return { accountId, ok: !!(rb && rb.ok === true), reason: rb && (rb.reason || "failed") };
    }));
    for (const r of rbs) { if (r.ok) readback += 1; else problems.push(r.accountId.slice(0, 6) + ":readback-" + S(r.reason)); }
  } else {
    readback = published.length; // no read-back injected (the CLI proves publish disposition instead)
  }
  base.readback = readback;

  // OWNERSHIP backfill -- part of the completion path (never a forgotten manual step). Non-fatal + idempotent +
  // budget-aware: a route slice that has spent its budget skips it (the scheduler's authoritative backfill + the
  // next read still cover it) rather than overrunning the serverless deadline.
  if (published.length && typeof ownershipBackfill === "function" && !outOfTime()) {
    try {
      const bf = await ownershipBackfill();
      log(bucket + " ownership: " + (bf && bf.applied) + " accounts, " + (bf && bf.totalRows) + " rows");
    } catch (e) { log(bucket + " WARN ownership backfill failed (re-runnable, non-fatal): " + S(e && e.message ? e.message : e)); }
  }

  const okReadback = typeof readbackLive === "function" ? readback === published.length : true;
  if (!published.length) {
    return { ...base, phase: "publish", ok: false, problems: problems.length ? problems : ["zero accounts published live"] };
  }
  if (!okReadback) {
    return { ...base, phase: "readback", ok: false, problems: problems.length ? problems : ["live read-back mismatch"] };
  }
  return { ...base, phase: "complete", ok: true, problems: problems.length ? problems : undefined };
}
