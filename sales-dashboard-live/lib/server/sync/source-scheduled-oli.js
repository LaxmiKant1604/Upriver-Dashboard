// Scheduler v2 -- TRUSTED assessment core for the AUTOMATIC scheduled OLI (order-line-items) refresh.
//
// The scheduled OLI operator (scripts/release/scheduled-oli-refresh.mjs) runs ONLY the order-line-items family
// for one bucket through runSourceCardAction, resuming until the family is drained, then calls
// assessScheduledOliCycle to PROVE the outcome stayed inside scope + the per-bucket create/token ceiling. This
// module is the pure, offline-testable core (no I/O): the plan (how many <=5-seller batches a bucket needs) and
// the strict post-drain proof. It NEVER runs Ads/FBA/Catalog or any other family.

import { assignAccountBatches, MAX_ACCOUNTS_PER_BATCH } from "./source-batching.js";
import { OLI_SOURCE_KEY, ORGANIZATION_SCOPE_KEY } from "./source-durable-model.js";

export const OLI_TOKENS_PER_CREATE = 2; // one STANDARD DataDoe export

// The ONLY source families the automatic scheduler runs: canonical OLI, the org-wide Catalog, and ASIN Ads
// (ads-asin-date). These show schedule_enabled=true + paused=false in source_controls; every other family --
// INCLUDING Campaign Ads (ads-campaign-date) and FBA -- stays schedule-disabled.
export const SCHEDULED_ENABLED_SOURCE_KEYS = Object.freeze(["order-line-items", "product-catalog", "ads-asin-date"]);

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
export function assessScheduledOliCycle({ bucket, discoveredAccounts, sourceJobs, owners, open } = {}) {
  const problems = [];
  const push = (p) => problems.push(p);
  if (bucket !== "us" && bucket !== "non-us") return { ok: false, problems: ["bad-bucket"], creates: 0, tokens: 0, batches: 0, ceilingCreates: 0, ceilingTokens: 0 };
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

  const tokens = creates * OLI_TOKENS_PER_CREATE;
  if (creates > plan.maxCreates) push("creates-over-ceiling:" + creates + ">" + plan.maxCreates);
  if (tokens > plan.maxTokens) push("tokens-over-ceiling:" + tokens + ">" + plan.maxTokens);

  return {
    ok: problems.length === 0,
    problems,
    creates,
    tokens,
    batches: seenHashes.size,
    ceilingCreates: plan.maxCreates,
    ceilingTokens: plan.maxTokens,
  };
}
