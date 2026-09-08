// Scheduler v2 -- TRUSTED assessment core for the AUTOMATIC scheduled OLI (order-line-items) refresh.
//
// The scheduled OLI operator (scripts/release/scheduled-oli-refresh.mjs) runs ONLY the order-line-items family
// for one bucket through runSourceCardAction, resuming until the family is drained, then calls
// assessScheduledOliCycle to PROVE the outcome stayed inside scope + the per-bucket create/token ceiling. This
// module is the pure, offline-testable core (no I/O): the plan (how many <=5-seller batches a bucket needs) and
// the strict post-drain proof. It NEVER runs Ads/FBA/Catalog or any other family.

import { assignAccountBatches, MAX_ACCOUNTS_PER_BATCH } from "./source-batching.js";
import { OLI_SOURCE_KEY, ORGANIZATION_SCOPE_KEY, windowsProve } from "./source-durable-model.js";
import { isRoutingScope } from "./scheduler-scope.js";

export const OLI_TOKENS_PER_CREATE = 2; // one STANDARD DataDoe export

// The ONLY source families the automatic scheduler runs: canonical OLI, the org-wide Catalog, and (post
// ASIN->Campaign cutover) CAMPAIGN Ads (ads-campaign-date). These show schedule_enabled=true + paused=false in
// source_controls; every other family -- INCLUDING the now-retired ASIN Ads (ads-asin-date) and FBA -- stays
// schedule-disabled (ASIN exports are additionally hard-blocked in ads-sync.js; its durable history is retained).
export const SCHEDULED_ENABLED_SOURCE_KEYS = Object.freeze(["order-line-items", "product-catalog", "ads-campaign-date"]);

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";

/**
 * The durable source_controls target for the automatic scheduler: OLI + product-catalog are schedule-enabled and
 * NOT paused; every other known source key is schedule-DISABLED (its paused state is left untouched). Pure so the
 * config operator's intent is offline-testable. Returns one { sourceKey, scheduleEnabled, paused? } per key.
 */
export function scheduledSourceControlPlan(sourceKeys) {
  const keys = [...new Set((sourceKeys || []).map(S).filter(nb))];
  return keys.map((sourceKey) => SCHEDULED_ENABLED_SOURCE_KEYS.includes(sourceKey)
    ? { sourceKey, scheduleEnabled: true, paused: false }
    : { sourceKey, scheduleEnabled: false });
}

/**
 * The daily OLI plan for a bucket: batch the discovered PRIMARY accounts into <=5-seller groups (the stable
 * packing the durable engine mirrors). Returns { batches, expectedBatches, maxCreates, maxTokens }.
 * maxCreates = the batch count (each batch is at most one create); maxTokens = maxCreates * 2. For the verified
 * production split this is US 8 -> 2 batches / 4 tokens and Non-US 22 -> 5 batches / 10 tokens.
 */
export function oliBucketPlan(accounts, existingMembership = new Map()) {
  const primary = (accounts || []).filter((a) => a && nb(a.accountId) && !S(a.accountId).includes(":"));
  const { batches } = assignAccountBatches(primary, existingMembership, MAX_ACCOUNTS_PER_BATCH);
  const expectedBatches = batches.length;
  return { batches, expectedBatches, maxCreates: expectedBatches, maxTokens: expectedBatches * OLI_TOKENS_PER_CREATE };
}

/**
 * P0-C: resolve the EFFECTIVE OLI create/token ceiling for one refresh attempt. PURE + offline-testable.
 *   - A FRESH cycle (no active head, or a freshly-opened superseding cycle) uses the newly-computed + authorized
 *     `recomputedCreates` (the steady batch count + one create per account behind D-1).
 *   - A CONTINUATION of an existing frozen cycle uses the DURABLE frozen source_tranche_budget VERBATIM
 *     (max_creates/max_tokens) -- NEVER a recomputed live ceiling. Comparing the frozen cycle's historical durable
 *     spend against a smaller recomputed ceiling is the exact defect that falsely tripped TOKEN_CEILING_EXCEEDED
 *     (16 spent > 14 recomputed) once coverage advanced.
 *   - A continuation whose frozen budget is UNREADABLE (`frozenBudgetReadError`) or MALFORMED (non-positive /
 *     non-integer max_creates/max_tokens) DEFERS -- the caller must make ZERO mutations (no create).
 *   - A continuation with NO frozen OLI budget yet (`frozenBudget == null`; the family had not frozen before an
 *     interrupt) keeps the recomputed ceiling; the runtime freezes it on the first create this run.
 * Returns { ok:true, source, creates, tokens } OR { ok:false, defer:true, reason, detail }.
 */
export function resolveOliCeiling({ isContinuation = false, frozenBudget = null, frozenBudgetReadError = false, recomputedCreates = 0, tokensPerCreate = OLI_TOKENS_PER_CREATE } = {}) {
  const recomputed = { creates: recomputedCreates, tokens: recomputedCreates * tokensPerCreate };
  if (!isContinuation) return { ok: true, source: "fresh", ...recomputed };
  if (frozenBudgetReadError) return { ok: false, defer: true, reason: "FROZEN_BUDGET_UNREADABLE", detail: "continuation frozen OLI budget could not be read" };
  if (frozenBudget == null) return { ok: true, source: "continuation-unfrozen", ...recomputed };
  const fc = Number(frozenBudget.max_creates);
  const ft = Number(frozenBudget.max_tokens);
  if (!Number.isSafeInteger(fc) || fc <= 0 || !Number.isSafeInteger(ft) || ft <= 0) {
    return { ok: false, defer: true, reason: "FROZEN_BUDGET_MALFORMED", detail: `max_creates=${frozenBudget.max_creates} max_tokens=${frozenBudget.max_tokens}` };
  }
  return { ok: true, source: "continuation-frozen", creates: fc, tokens: ft };
}

/**
 * STRICT post-drain assessment of a scheduled OLI cycle. Given the discovered primary accounts, the cycle's OLI
 * source jobs + owners, and the OLI family's remaining open-job count, prove EVERY invariant and return
 * { ok, problems, creates, tokens, batches, ceilingCreates, ceilingTokens }:
 *   - the family is DRAINED (open === 0);
 *   - EVERY source job is order-line-items AND succeeded (this step runs the OLI family ALONE -- any
 *     catalog/Ads/FBA/unrelated key here is a violation);
 *   - each job create_export_count is 0 or 1 (never a multi-create);
 *   - each job's owners are per-ACCOUNT (never the org scope key), at most 5 (the batch cap), and inside the
 *     discovered set;
 *   - the OLI owner union EXACTLY covers the discovered accounts (no missing / extra);
 *   - total creates <= the plan ceiling AND tokens (creates * 2) <= the token ceiling.
 * ok === true ONLY when problems is empty. The caller exits nonzero on any problem.
 */
export function assessScheduledOliCycle({ bucket, discoveredAccounts, sourceJobs, owners, open, extraCreatesHeadroom = 0 } = {}) {
  const problems = [];
  const push = (p) => problems.push(p);
  if (!isRoutingScope(bucket)) return { ok: false, problems: ["bad-bucket"], creates: 0, tokens: 0, batches: 0, ceilingCreates: 0, ceilingTokens: 0 };
  const discovered = [...new Set((discoveredAccounts || []).map((a) => S(a && (a.accountId ?? a)).trim()).filter(Boolean))].sort();
  if (!discovered.length) return { ok: false, problems: ["no-discovered-accounts"], creates: 0, tokens: 0, batches: 0, ceilingCreates: 0, ceilingTokens: 0 };
  const discoveredSet = new Set(discovered);
  const plan = oliBucketPlan(discovered.map((accountId) => ({ accountId })));

  const jobs = Array.isArray(sourceJobs) ? sourceJobs : [];
  if (Number(open) !== 0) push("family-not-drained:" + S(open));
  if (!jobs.length) push("no-oli-jobs");

  const ownersByHash = new Map();
  for (const o of Array.isArray(owners) ? owners : []) {
    const h = S(o.request_hash ?? o.requestHash);
    if (!ownersByHash.has(h)) ownersByHash.set(h, []);
    ownersByHash.get(h).push(S(o.account_id ?? o.accountId));
  }

  let creates = 0;
  const ownerUnion = new Set();
  const seenHashes = new Set();
  for (const j of jobs) {
    const sk = S(j.source_key ?? j.sourceKey);
    if (sk !== OLI_SOURCE_KEY) { push("non-oli-source:" + sk); continue; }
    if (S(j.fetch_status ?? j.fetchStatus) !== "succeeded") { push("job-not-succeeded"); continue; }
    const cec = Number(j.create_export_count ?? j.createExportCount);
    if (!(cec === 0 || cec === 1)) { push("bad-create-count:" + S(cec)); continue; }
    creates += cec === 1 ? 1 : 0;
    const h = S(j.request_hash ?? j.requestHash);
    if (!nb(h)) { push("blank-hash"); continue; }
    seenHashes.add(h);
    const jobOwners = ownersByHash.get(h) || [];
    if (!jobOwners.length) { push("owners-missing"); continue; }
    if (jobOwners.length > MAX_ACCOUNTS_PER_BATCH) push("batch-oversized:" + jobOwners.length);
    for (const a of jobOwners) {
      if (a === ORGANIZATION_SCOPE_KEY) { push("owner-org-scope"); continue; }
      if (!discoveredSet.has(a)) push("owner-unexpected");
      ownerUnion.add(a);
    }
  }
  for (const a of discovered) if (!ownerUnion.has(a)) push("owner-coverage-missing");

  // Ceiling = the steady <=5-seller batch count PLUS a bounded headroom of one create per account behind D-1 at
  // the run's start: planOliSliceExports splits a batch that holds a behind account into an extra forced-fresh
  // window slice, so a lagged day / a fresh cycle's first run legitimately exceeds expectedBatches. Default 0 keeps
  // steady state (and every existing caller/test) byte-identical.
  const headroom = Math.max(0, Number(extraCreatesHeadroom) || 0);
  const ceilingCreates = plan.maxCreates + headroom;
  const ceilingTokens = ceilingCreates * OLI_TOKENS_PER_CREATE;
  const tokens = creates * OLI_TOKENS_PER_CREATE;
  if (creates > ceilingCreates) push("creates-over-ceiling:" + creates + ">" + ceilingCreates);
  if (tokens > ceilingTokens) push("tokens-over-ceiling:" + tokens + ">" + ceilingTokens);

  return {
    ok: problems.length === 0,
    problems,
    creates,
    tokens,
    batches: seenHashes.size,
    ceilingCreates,
    ceilingTokens,
  };
}

/**
 * Classify the EXISTING (bucket, today) cycle BEFORE a scheduled OLI run touches it, so the run never assesses an
 * unrelated cycle as its own, never appends work to a terminal cycle, and never fabricates owner coverage. Given
 * the cycle row (or null) plus its source jobs + owners, returns one of:
 *   - { disposition: "run" }               -- no cycle OR a running cycle: run OLI normally (create/continue).
 *   - { disposition: "idempotent-complete", assessment }
 *                                          -- a TERMINAL cycle that is ALREADY a COMPLETE scheduled OLI run for the
 *                                             discovered accounts (a genuine same-day replay): accept, ZERO creates.
 *   - { disposition: "terminal-refuse", assessment }
 *                                          -- a TERMINAL cycle that is NOT a completed OLI run (e.g. a same-date
 *                                             catalog/priority-release cycle): a typed refusal BEFORE any create.
 *   - { disposition: "refuse", reason }    -- an unexpected cycle status: fail closed.
 * It NEVER weakens assessScheduledOliCycle -- the terminal cycle is adopted ONLY when that strict assessment
 * (over the cycle's OLI jobs, open=0) passes, OR when the caller PROVES (durableCoverage.complete) that the
 * DURABLE per-account OLI coverage already spans the full authorized window for EVERY discovered account. The
 * durable-coverage branch is what stops a same-day MANUAL operation (e.g. a catalog/priority-release cycle, or a
 * manual Data Sync Center OLI run that already recorded the coverage) from colliding with the scheduled run: the
 * evidence is complete, so the scheduled replay is a zero-create idempotent success -- never an append to the
 * terminal cycle, and never a false failure. An INCOMPLETE-coverage terminal collision still refuses (fail closed).
 */
/**
 * PURE: is the DURABLE per-account OLI coverage already complete for the authorized window? For every discovered
 * account, its proven coverage windows must contiguously span [start .. asOf] (windowsProve; malformed evidence
 * fails closed to incomplete). This is the evidence a terminal-cycle collision consults: complete coverage means
 * the day's OLI work is already durably done (whoever did it), so a scheduled replay needs ZERO creates. The
 * daily rolling-correction re-export is a REFRESH of already-covered dates, so skipping it on a collision day
 * loses no coverage -- the next scheduled day corrects normally. Returns { complete, missingAccounts }.
 */
export function assessDurableOliCoverageComplete({ discoveredAccounts, coverageByAccountId, start, asOf } = {}) {
  const accounts = [...new Set((discoveredAccounts || []).map((a) => S(a && (a.accountId ?? a))).filter(nb))];
  if (!accounts.length || !nb(start) || !nb(asOf)) return { complete: false, missingAccounts: accounts };
  const missingAccounts = [];
  for (const accountId of accounts) {
    let proven = false;
    try { proven = windowsProve((coverageByAccountId || {})[accountId] || [], S(start), S(asOf)); } catch (_e) { proven = false; }
    if (!proven) missingAccounts.push(accountId);
  }
  return { complete: missingAccounts.length === 0, missingAccounts };
}

export function classifyScheduledOliCycle({ bucket, cycle, discoveredAccounts, sourceJobs, owners, durableCoverage = null } = {}) {
  if (!cycle || !nb(cycle.id)) return { disposition: "run", reason: "no-cycle" };
  const status = S(cycle.status ?? cycle.cycleStatus);
  if (status === "running" || status === "pending") return { disposition: "run", reason: status + "-cycle" };
  if (status !== "succeeded" && status !== "partial" && status !== "failed") return { disposition: "refuse", reason: "unexpected-cycle-status:" + status };
  // TERMINAL cycle. Completion is decided by DURABLE OLI COVERAGE THROUGH the requested day (D-1), NOT by the
  // OLI-job shape: a cycle whose OLI jobs all succeeded (a "complete scheduled OLI run") can STILL have durable
  // coverage only through D-2, because its exports were fetched BEFORE DataDoe settled D-1 and then adopted from
  // the cache on every re-run. Cycle-completion and source-freshness are decoupled here:
  //   coverage complete through D-1 -> idempotent-complete (zero creates; the day is genuinely done).
  //   coverage present but < D-1     -> SUPERSEDE: this terminal cycle is STALE evidence; the caller opens a fresh
  //                                     RUNNING superseding attempt (new operation identity + its own child jobs)
  //                                     and re-fetches -- the terminal cycle is NEVER treated as complete, and NEVER
  //                                     reopened/reset/mutated.
  //   coverage unreadable            -> fail closed (refuse) -- never silently classify freshness without evidence.
  const oliJobs = (Array.isArray(sourceJobs) ? sourceJobs : []).filter((j) => S(j.source_key ?? j.sourceKey) === OLI_SOURCE_KEY);
  const assessment = assessScheduledOliCycle({ bucket, discoveredAccounts, sourceJobs: oliJobs, owners, open: 0 });
  if (durableCoverage == null) return { disposition: "terminal-refuse", reason: "terminal-cycle-coverage-unreadable", assessment, cycleStatus: status };
  if (durableCoverage.complete === true) return { disposition: "idempotent-complete", assessment, cycleStatus: status, reason: "durable-coverage-complete" };
  return { disposition: "supersede", reason: "stale-terminal-below-d1", assessment, cycleStatus: status, missingAccounts: durableCoverage.missingAccounts || [] };
}

/**
 * P0-B: classify a RUNNING (bucket, today) head, distinguishing a COMPLETE-DAILY-PLAN cycle (OLI + a frozen Product
 * Catalog budget/job) from a LEGACY OLI-only cycle (OLI frozen budget/jobs but NO Catalog budget AND NO Catalog job
 * -- created before the complete-daily-plan fix). A frozen continuation can NEVER inject the newly-required Catalog
 * family (case-c newly-enabled-deferred), so the priority step would fail not-drained FOREVER on a legacy cycle.
 * Recovery (caller): finalize the legacy cycle HONESTLY from its own source work, then open a SUPERSEDING full-plan
 * cycle; runtime.run(priority) drains a fresh Catalog on the superseding cycle (FRESH-ON-ACTIVE) and derives off the
 * DURABLE OLI evidence -- no OLI re-fetch. Returns:
 *   - { disposition: "run" }             -- a complete-daily-plan cycle (Catalog budget or job present), or no OLI
 *                                           evidence: derive normally (the priority step drains the frozen Catalog).
 *   - { disposition: "recover-legacy" }  -- a legacy OLI-only cycle: finalize + supersede (the caller stops typed if
 *                                           finalize reports the OLI is still open, and a later retry recovers it).
 * hasCatalogBudget MUST come from a SUCCESSFUL budget read (a read failure defers upstream, never "false").
 */
export function classifyLegacyOliOnlyCycle({ status, hasCatalogBudget, hasCatalogJob, hasOliJob } = {}) {
  if (S(status) !== "running") return { disposition: "run", reason: "not-running" };
  if (hasCatalogBudget === true || hasCatalogJob === true) return { disposition: "run", reason: "complete-daily-plan" };
  if (hasOliJob !== true) return { disposition: "run", reason: "no-oli-evidence" };
  return { disposition: "recover-legacy", reason: "legacy-oli-only" };
}
