// PRIMARY DataDoe automatic account onboarding -- the ONE server-side authority for
//   (a) classifying every PRIMARY directory account against its durable onboarding state,
//   (b) the EXPORT-ELIGIBILITY gate every scheduled/paid discovery path must pass through, and
//   (c) the additive account-directory snapshot merge that makes accounts visible ("Setting up")
//       without waiting for a manual admin refresh.
//
// WHY (proven 2026-09-06, read-only audit): the DataDoe directory returns per-account readiness
// (sellerCentralConnection.initialLoadComplete) and progress (rowCount) evidence, but discovery
// dropped it, so (1) still-loading accounts were routed into scheduled runs, whose create-export
// POSTs DataDoe rejects with HTTP 400 -- 8 wasted OLI creates on europe-au and poisoned shared
// FBA/Listings batches on us-ca in ONE day -- and (2) fully-ready accounts stayed invisible because
// the account-directory snapshot is only written by a manual admin refresh.
//
// DESIGN:
//   - Scheduler-v2 remains the ONE owner of every paid export. The 15-minute discovery worker
//     (scripts/release/account-onboarding-discovery.mjs) NEVER creates an export: it performs the
//     zero-token directory GET, maintains durable state (account_onboarding), atomically CLAIMS the
//     bootstrap operation for a newly-ready account, and merges visibility into the directory
//     snapshot. The next regional scheduler run then backfills the claimed account through the
//     existing per-source machinery (OLI fixed-start 2025-01-01 splitting, Campaign initial window,
//     Catalog/Listings/FBA current snapshots) under the existing regional ceilings.
//   - EXPORT ELIGIBILITY (the gate): an account may be included in ANY scheduled/paid path only when
//     (1) DataDoe says its Seller Central initial load is COMPLETE (never "the ID exists"), AND
//     (2) its onboarding status is bootstrapping | partially_ready | ready (claimed or graduated).
//     When the onboarding table is unreadable/absent (pre-migration deploy, transient read failure)
//     the gate FAILS SOFT to the readiness-only rule: every DataDoe-ready account stays included
//     (existing regions keep publishing) while every in-progress account stays excluded (the zero-
//     export guarantee for loading accounts NEVER degrades).
//
// This module is PURE except the two explicitly-composed helpers at the bottom (which take
// injectable readers). No DataDoe export adapter is imported anywhere here -- the worker path is
// structurally incapable of creating an export or spending a token.

import { createHash } from "node:crypto";
import { regionForMarketplace, REGIONS } from "./campaign-region-routing.js";

const S = (v) => (v == null ? "" : String(v).trim());
const isoNow = (now) => new Date(now == null ? Date.now() : now).toISOString();
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

export const ONBOARDING_STATUS = Object.freeze({
  DISCOVERED: "discovered",
  WAITING_FOR_DATADOE: "waiting_for_datadoe",
  READY_FOR_BOOTSTRAP: "ready_for_bootstrap",
  BOOTSTRAPPING: "bootstrapping",
  PARTIALLY_READY: "partially_ready",
  READY: "ready",
  BLOCKED: "blocked",
});
export const ONBOARDING_STATUSES = Object.freeze(Object.values(ONBOARDING_STATUS));

// Statuses whose accounts may appear in a scheduled/paid export path. ready_for_bootstrap is
// deliberately EXCLUDED: readiness is proven but the atomic bootstrap claim has not been made yet;
// the discovery worker claims it (<= ~15 min) and only then does the regional scheduler pick it up,
// so every bootstrap runs under exactly one durable operation identity.
export const EXPORT_ELIGIBLE_STATUSES = Object.freeze([
  ONBOARDING_STATUS.BOOTSTRAPPING,
  ONBOARDING_STATUS.PARTIALLY_READY,
  ONBOARDING_STATUS.READY,
]);

// Statuses whose accounts are actually SERVING report data. DISTINCT from export eligibility: a
// claimed (bootstrapping) account may already receive scheduled exports, but until durable evidence
// exists it still displays as "Setting up" and stays OUT of snapshot-seeded operator scopes
// (getAccountDirectorySnapshotAccounts) -- including it there would only inflate blocked-account
// counts before any evidence can exist.
export const SERVING_STATUSES = Object.freeze([
  ONBOARDING_STATUS.PARTIALLY_READY,
  ONBOARDING_STATUS.READY,
]);

// SAFE typed failure/exclusion codes (never a raw upstream body).
export const UNSUPPORTED_MARKETPLACE = "UNSUPPORTED_MARKETPLACE";
export const EXCLUDE_DATADOE_NOT_READY = "DATADOE_NOT_READY";
export const EXCLUDE_NOT_ONBOARDED = "NOT_ONBOARDED";
export const EXCLUDE_STATUS_PREFIX = "ONBOARDING_";

// The durable bootstrap operation identity: one per (account, first-discovered date). Repeated polls,
// concurrent workers, restarts and watchdogs all derive the SAME id, so the claim RPC converges them
// onto one operation (idempotent 'already-claimed').
export function bootstrapOperationId(accountId, discoveredDate) {
  const id = S(accountId);
  const date = S(discoveredDate);
  if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("bootstrapOperationId requires a non-blank accountId and a YYYY-MM-DD discovered date (fail closed).");
  }
  return `account-bootstrap/${id}/${date}`;
}

// STRICT DataDoe readiness: the Seller Central initial load must be POSITIVELY complete. A missing
// readiness object (legacy caller, malformed row) is NOT ready -- never "the ID exists, so ready".
export function accountDataDoeReady(detailedAccount) {
  return detailedAccount?.readiness?.sellerCentralReady === true;
}

// Strip the readiness evidence back to the LEGACY normalized account shape (id/name/country/
// countryName/currency/locale/timeZone) so gated discovery emits byte-identical payload objects.
export function toLegacyAccountShape(detailedAccount) {
  const { readiness: _readiness, ...account } = detailedAccount || {};
  return account;
}

/**
 * PURE per-account durable-evidence summary -> serving grade.
 * evidence: { oliCoveredFrom, oliCoveredTo, hasDaily, hasBrandSales, hasFbaPlan, hasListingHealthV3,
 *             campaignCoveredTo } (all optional; null/undefined = not proven).
 * FULLY serving  = durable OLI coverage exists AND the two primary sales surfaces (daily + brand-sales)
 *                  have published snapshots.
 * PARTIALLY      = any single piece of durable evidence exists.
 */
export function gradeBootstrapEvidence(evidence) {
  const e = evidence || {};
  const hasOli = S(e.oliCoveredTo) !== "";
  const fully = hasOli && e.hasDaily === true && e.hasBrandSales === true;
  const partially = hasOli || e.hasDaily === true || e.hasBrandSales === true
    || e.hasFbaPlan === true || e.hasListingHealthV3 === true || S(e.campaignCoveredTo) !== "";
  return { fully, partially };
}

// The per-source status snapshot persisted into account_onboarding.sources (typed data only).
export function sourcesSummaryOf(evidence, now = null) {
  const e = evidence || {};
  const checkedAt = isoNow(now);
  const present = (flag) => ({ status: flag === true ? "present" : "pending", checkedAt });
  return {
    oli: S(e.oliCoveredTo) !== ""
      ? { status: "covered", coveredFrom: S(e.oliCoveredFrom) || null, coveredTo: S(e.oliCoveredTo), checkedAt }
      : { status: "pending", checkedAt },
    campaignAds: S(e.campaignCoveredTo) !== ""
      ? { status: "covered", coveredTo: S(e.campaignCoveredTo), checkedAt }
      : { status: "pending", checkedAt },
    daily: present(e.hasDaily),
    brandSales: present(e.hasBrandSales),
    fbaPlan: present(e.hasFbaPlan),
    listingHealthV3: present(e.hasListingHealthV3),
  };
}

/**
 * PURE classification of ONE discovered PRIMARY account against its existing onboarding row +
 * durable evidence. Returns { row, transition } where `row` is the desired upsert (snake_case column
 * fields; only the fields this worker owns) and `transition` is a typed human-readable summary
 * ("new:waiting_for_datadoe", "waiting_for_datadoe->ready_for_bootstrap", "unchanged", ...).
 *
 * INVARIANTS:
 *   - an unassigned marketplace is BLOCKED (stored, admin-visible, never silently routed);
 *   - readiness comes ONLY from initialLoadComplete (never mere directory presence);
 *   - a post-claim status (bootstrapping/partially_ready/ready) is NEVER regressed by a DataDoe
 *     readiness flap -- datadoe_ready records the live bit and the export gate excludes on it, but
 *     the durable LKG status (and every published snapshot) is preserved;
 *   - grading forward (bootstrapping -> partially_ready -> ready) requires positive durable evidence.
 */
export function classifyOnboardingAccount({ discovered, existing = null, evidence = null, now = null } = {}) {
  const accountId = S(discovered && discovered.id);
  if (!accountId || accountId.includes(":")) {
    throw new Error("classifyOnboardingAccount requires a PRIMARY (unprefixed) discovered account id (fail closed).");
  }
  const nowIso = isoNow(now);
  const country = S(discovered.country).toUpperCase();
  const region = regionForMarketplace(country);
  const ready = accountDataDoeReady(discovered);
  const r = discovered.readiness || {};
  const grade = gradeBootstrapEvidence(evidence);

  const base = {
    account_id: accountId,
    connection_id: "primary",
    name: S(discovered.name),
    marketplace_country_code: country,
    marketplace_id: S(r.marketplaceId),
    region,
    datadoe_ready: ready,
    datadoe_row_count: r.rowCount ?? null,
    seller_central_row_count: r.sellerCentralRowCount ?? null,
    ads_connected: r.adsConnected === true,
    ads_ready: r.adsReady === true,
    ads_row_count: r.adsRowCount ?? null,
    last_seen_at: nowIso,
  };

  const prior = existing || null;
  const priorStatus = S(prior && prior.status);
  const decide = () => {
    // Unsupported/unassigned marketplace: stored as blocked, never routed -- regardless of readiness.
    if (region === REGIONS.UNASSIGNED) return { status: ONBOARDING_STATUS.BLOCKED, failure_code: UNSUPPORTED_MARKETPLACE };
    // Post-claim statuses grade FORWARD on evidence and are never regressed by a readiness flap.
    if (priorStatus === ONBOARDING_STATUS.READY) return { status: ONBOARDING_STATUS.READY };
    if (priorStatus === ONBOARDING_STATUS.PARTIALLY_READY || priorStatus === ONBOARDING_STATUS.BOOTSTRAPPING) {
      if (grade.fully) return { status: ONBOARDING_STATUS.READY, bootstrap_completed_at: nowIso };
      if (grade.partially) return { status: ONBOARDING_STATUS.PARTIALLY_READY };
      return { status: priorStatus };
    }
    // Pre-claim: readiness decides. Losing readiness before the claim returns to waiting (zero exports).
    if (!ready) return { status: ONBOARDING_STATUS.WAITING_FOR_DATADOE };
    // Readiness proven. GRANDFATHER: an account that is ALREADY fully serving from durable evidence
    // (the pre-onboarding scheduler population) is ready outright -- no second bootstrap.
    if (grade.fully) return { status: ONBOARDING_STATUS.READY, ready_at: S(prior && prior.ready_at) || nowIso, bootstrap_completed_at: nowIso };
    if (grade.partially) return { status: ONBOARDING_STATUS.PARTIALLY_READY, ready_at: S(prior && prior.ready_at) || nowIso };
    return { status: ONBOARDING_STATUS.READY_FOR_BOOTSTRAP, ready_at: S(prior && prior.ready_at) || nowIso };
  };

  const decision = decide();
  const row = {
    ...base,
    status: decision.status,
    failure_code: decision.failure_code ?? (prior && priorStatus === decision.status ? prior.failure_code ?? null : null),
    sources: sourcesSummaryOf(evidence, now),
    ...(decision.ready_at ? { ready_at: decision.ready_at } : {}),
    ...(decision.bootstrap_completed_at && !S(prior && prior.bootstrap_completed_at)
      ? { bootstrap_completed_at: decision.bootstrap_completed_at } : {}),
  };
  const transition = prior
    ? (priorStatus === decision.status ? "unchanged" : `${priorStatus}->${decision.status}`)
    : `new:${decision.status}`;
  return { row, transition };
}

/**
 * PURE export-eligibility gate over the PRIMARY detailed directory.
 *   detailedAccounts : fetchAccountsDetailed() rows (primary connection).
 *   onboardingRows   : account_onboarding rows, or null when the table is unreadable/absent.
 * Returns { eligible (DETAILED rows, order preserved), excluded: [{accountId, name, reason}],
 *           gateMode: 'onboarding' | 'readiness-only' }.
 */
export function filterExportEligibleAccounts({ detailedAccounts, onboardingRows = null } = {}) {
  const rows = Array.isArray(onboardingRows) ? onboardingRows : null;
  const byAccount = rows ? new Map(rows.map((r) => [S(r.account_id), r])) : null;
  const eligible = [];
  const excluded = [];
  for (const account of detailedAccounts || []) {
    const accountId = S(account && account.id);
    if (!accountId || accountId.includes(":")) continue; // primary-only; prefixed ids never reach a paid path here
    const name = S(account.name);
    // Rule 1 (NEVER degraded): a DataDoe in-progress account gets ZERO paid exports.
    if (!accountDataDoeReady(account)) {
      excluded.push({ accountId, name, reason: EXCLUDE_DATADOE_NOT_READY });
      continue;
    }
    if (!byAccount) { eligible.push(account); continue; } // fail-soft: readiness-only mode
    const row = byAccount.get(accountId);
    if (!row) { excluded.push({ accountId, name, reason: EXCLUDE_NOT_ONBOARDED }); continue; }
    if (EXPORT_ELIGIBLE_STATUSES.includes(S(row.status))) eligible.push(account);
    else excluded.push({ accountId, name, reason: EXCLUDE_STATUS_PREFIX + S(row.status).toUpperCase() });
  }
  return { eligible, excluded, gateMode: byAccount ? "onboarding" : "readiness-only" };
}

/**
 * PURE bootstrap-scope filter: the TRUSTED account set a scheduler-v2 bootstrap run may spend tokens on.
 * An account is bootstrap-pending ONLY when its durable onboarding row proves an atomic claim
 * (status === 'bootstrapping' with a non-blank operation_id) AND DataDoe readiness is POSITIVELY complete
 * AND (when a region is given) its durable region matches. NOTHING here comes from user input, and there
 * is NO fail-soft: a bootstrap scope without readable onboarding rows is an EMPTY authorization -- the
 * caller must fail closed (zero accounts => zero exports), never fall back to a wider set.
 * Returns { accounts (DETAILED rows), operationIds }. The wave/dispatch IDENTITY is NOT derived here:
 * computeOnboardingWaveIdentity (account-onboarding-bootstrap.js) is the single source -- it hashes the
 * sorted claimed membership so a membership change mints a NEW wave key + dispatch id.
 */
export function filterBootstrapPendingAccounts({ detailedAccounts, onboardingRows, region = null } = {}) {
  if (!Array.isArray(onboardingRows)) {
    throw new Error("BOOTSTRAP_SCOPE_UNAVAILABLE: account_onboarding rows are required for a bootstrap scope (fail closed; zero accounts, zero exports).");
  }
  const byAccount = new Map(onboardingRows.map((r) => [S(r.account_id), r]));
  const accounts = [];
  const operationIds = [];
  for (const account of detailedAccounts || []) {
    const accountId = S(account && account.id);
    if (!accountId || accountId.includes(":")) continue;
    const row = byAccount.get(accountId);
    if (!row) continue;
    if (S(row.status) !== ONBOARDING_STATUS.BOOTSTRAPPING) continue;
    if (!S(row.operation_id)) continue;                       // the atomic claim IS the authorization
    if (!accountDataDoeReady(account)) continue;              // an in-progress account spends nothing
    if (region != null && S(row.region) !== S(region)) continue;
    accounts.push(account);
    operationIds.push(S(row.operation_id));
  }
  return { accounts, operationIds: operationIds.sort() };
}

// The three onboarding routing regions (pinned by tests to campaign-region-routing REGIONS).
export const ONBOARDING_REGIONS = Object.freeze(["india", "europe-au", "us-ca"]);

// The WAVE-BOUND bootstrap-publication cycle bucket -- bootstrap-<region>-<membership-hash-16> -- so a
// scoped bootstrap publication's sync_cycles row (a) never collides with the natural (region, cycle_date)
// daily cycle AND (b) never collides with a DIFFERENT wave in the same region on the same day, while a
// RETRY of the SAME dispatch (same membership hash) reuses ITS OWN cycle. The value is NOT arbitrary: it
// matches the reviewed CHECK/open_sync_cycle pattern ^bootstrap-(india|europe-au|us-ca)-[0-9a-f]{16}$.
// The membership hash is the dispatch identity's own hash (the 16 hex after the last "/").
export function bootstrapCycleBucket(region, membershipHash) {
  const r = S(region);
  if (!ONBOARDING_REGIONS.includes(r)) throw new Error(`bootstrapCycleBucket requires a routing region (india|europe-au|us-ca; got "${r}") (fail closed).`);
  const h = S(membershipHash).toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(h)) throw new Error(`bootstrapCycleBucket requires a 16-hex membership hash (got "${membershipHash}") (fail closed).`);
  return `bootstrap-${r}-${h}`;
}

// The WAVE-BOUND bootstrap-FBA-inventory cycle bucket -- bootstrap-fba-<region>-<membership-hash-16> --
// so a scoped bootstrap FBA go-live's dedicated inventory cycle never collides with (or is blocked by) the
// natural <region>-fba cycle, and two different same-region/day waves get distinct FBA cycles while a
// retry of the SAME dispatch reuses its own. Matches the reviewed CHECK/open_sync_cycle -fba pattern.
export function bootstrapFbaCycleBucket(region, membershipHash) {
  const r = S(region);
  if (!ONBOARDING_REGIONS.includes(r)) throw new Error(`bootstrapFbaCycleBucket requires a routing region (india|europe-au|us-ca; got "${r}") (fail closed).`);
  const h = S(membershipHash).toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(h)) throw new Error(`bootstrapFbaCycleBucket requires a 16-hex membership hash (got "${membershipHash}") (fail closed).`);
  return `bootstrap-fba-${r}-${h}`;
}

// The 16-hex membership hash embedded in a wave dispatch id (onboarding-bootstrap/<region>/<hash16>).
// Returns "" when the id is not a canonical wave dispatch id (fail closed at the caller).
export function dispatchMembershipHash(dispatchId) {
  const m = /^onboarding-bootstrap\/(?:india|europe-au|us-ca)\/([0-9a-f]{16})$/.exec(S(dispatchId));
  return m ? m[1] : "";
}

/**
 * The CANONICAL, REGION-LOCAL, IMMUTABLE wave identity: derived ONLY from ONE region's durable claim
 * state (that region's 'bootstrapping' rows' immutable operation ids + trusted account ids, sorted,
 * plus the region itself). Waves are PER REGION: a newly claimed account in ANOTHER region can never
 * change, restart, or re-key this region's wave, dispatch identity, budget, or attempt counters.
 * Within a region, a newly claimed account changes that region's membership -> a DIFFERENT wave key +
 * dispatch id -> the old authorization can never cover it (BUDGET_NOT_AUTHORIZED until the new wave is
 * approved) and the old queued/running dispatch row is never overwritten (append-only by
 * (region, dispatch_id)). The approved plan fingerprint is bound to the wave by the budget ROW
 * (mandatory, non-blank, validated on every reservation) rather than folded into the key -- the
 * discovery worker must be able to LOCATE the wave's budget row before any plan exists in order to hold
 * dispatches in awaiting-budget. PURE (no transport): lives here so the structurally zero-export
 * discovery worker can import it.
 * Returns { region, waveKey, membershipHash, accounts, operations, dispatchId };
 * waveKey/dispatchId are null when the region has nothing claimed.
 */
export function computeOnboardingWaveIdentity(onboardingRows, region) {
  if (!Array.isArray(onboardingRows)) {
    throw new Error("computeOnboardingWaveIdentity requires readable account_onboarding rows (fail closed).");
  }
  const r = S(region);
  if (!ONBOARDING_REGIONS.includes(r)) {
    throw new Error(`computeOnboardingWaveIdentity requires a routing region (india|europe-au|us-ca; got "${r}") (fail closed).`);
  }
  const entries = onboardingRows
    .filter((row) => S(row.status) === ONBOARDING_STATUS.BOOTSTRAPPING && S(row.operation_id) !== "" && S(row.account_id) !== "" && S(row.region) === r)
    .map((row) => ({ accountId: S(row.account_id), operationId: S(row.operation_id) }))
    .sort((a, b) => a.accountId.localeCompare(b.accountId));
  if (!entries.length) return { region: r, waveKey: null, membershipHash: null, accounts: [], operations: [], dispatchId: null };
  const accounts = entries.map((e) => e.accountId);
  const operations = entries.map((e) => e.operationId).sort();
  const membershipHash = sha256(JSON.stringify({ accounts, operations, region: r }));
  return {
    region: r,
    waveKey: `onboarding-wave/${r}/${membershipHash.slice(0, 32)}`,
    membershipHash,
    accounts,
    operations,
    // The dispatch identity carries the region-local membership, so an acknowledged/queued run is
    // bound to exactly this wave: an in-region membership change mints a NEW dispatch identity.
    dispatchId: `onboarding-bootstrap/${r}/${membershipHash.slice(0, 16)}`,
  };
}

// Every region's current wave identity (region -> identity; only regions with claims appear).
export function computeAllRegionOnboardingWaves(onboardingRows) {
  const waves = new Map();
  for (const region of ONBOARDING_REGIONS) {
    const wave = computeOnboardingWaveIdentity(onboardingRows, region);
    if (wave.waveKey) waves.set(region, wave);
  }
  return waves;
}

// The canonical per-step account-set hash (sorted account ids) every reservation carries + validates.
export function bootstrapAccountSetHash(accountIds) {
  const ids = [...new Set((accountIds || []).map(S).filter(Boolean))].sort();
  return sha256(JSON.stringify(ids));
}

/**
 * The CANONICAL PER-STEP PLAN HASH: sha256 over the STRUCTURAL binding of one step's approved work --
 *   step (oli|campaign|fba|catalog|publish), region,
 *   wave accounts (sorted) + operation ids (sorted) + accountSetHash,
 *   planAsOf + inventoryAsOf (the exact approved reference dates),
 *   sourceKeys (sorted; the report family/source identity),
 *   windows (the exact approved from/to per source, or the no-date snapshot identity string),
 *   requestHashes (sorted; the deterministic planned export request identities) +
 *   batchMembership (the sorted planned <=5-seller account batches),
 *   limits (sorted; per-source row/seller caps that shape the request identity).
 * DELIBERATELY EXCLUDES the coverage-dependent planned creates/tokens (the reservation CEILING) -- those
 * shrink on a legitimate retry as durable coverage advances, so folding them in would make a retry drift.
 * The ceiling is bound instead by the reservation (attempt + cumulative <= ceiling) and by the plan
 * FINGERPRINT (which includes plannedCreates/plannedTokens per entry). The run-time operator RECOMPUTES
 * this STRUCTURAL hash from its ACTUAL planned work (frozen accounts, pinned dates/windows, live seller
 * batches, request identities, limits) and requires it to equal the approved entry's stepPlanHash BEFORE
 * any reservation/POST -- so a modified runtime account, batch, date, window, source, or request identity
 * is PLAN_DRIFT even when the token counts happen to match.
 */
export function onboardingStepPlanHash(step) {
  const s = step || {};
  const sortedStr = (xs) => [...new Set((Array.isArray(xs) ? xs : []).map(S).filter(Boolean))].sort();
  const canonical = {
    step: S(s.step), region: S(s.region),
    accounts: sortedStr(s.accounts), operationIds: sortedStr(s.operationIds),
    accountSetHash: S(s.accountSetHash),
    planAsOf: S(s.planAsOf), inventoryAsOf: S(s.inventoryAsOf),
    sourceKeys: sortedStr(s.sourceKeys),
    windows: (Array.isArray(s.windows) ? s.windows : [])
      .map((w) => ({ sourceKey: S(w && w.sourceKey), from: S(w && w.from), to: S(w && w.to), snapshotIdentity: S(w && w.snapshotIdentity) }))
      .sort((a, b) => (a.sourceKey + "|" + a.from + "|" + a.to).localeCompare(b.sourceKey + "|" + b.from + "|" + b.to)),
    requestHashes: sortedStr(s.requestHashes),
    batchMembership: (Array.isArray(s.batchMembership) ? s.batchMembership : [])
      .map((batch) => sortedStr(batch).join(","))
      .sort(),
    limits: (Array.isArray(s.limits) ? s.limits : []).map((l) => Number(l) || 0).sort((a, b) => a - b),
    // OPTIONAL canonical STRUCTURE object (the FBA plan structure: sellers, marketplace pairs, default
    // batches, request hashes, source keys, row limits, inventoryAsOf, adaptiveSplitAllowed). It is
    // canonicalized here (deterministic key order + sorted arrays) so a modified seller/pair/batch/request/
    // limit is bound; absent for non-FBA steps.
    structure: canonicalizeStructure(s.structure),
  };
  return sha256(JSON.stringify(canonical));
}

// Deterministic canonicalization of an arbitrary plain structure object (sorted keys; arrays of strings
// sorted; arrays of arrays joined+sorted; primitives passed through). null/undefined => null.
function canonicalizeStructure(v) {
  if (v == null) return null;
  if (Array.isArray(v)) {
    const items = v.map((x) => (Array.isArray(x) ? [...x].map(S).sort().join(",") : (x && typeof x === "object" ? JSON.stringify(canonicalizeStructure(x)) : S(x))));
    return items.sort();
  }
  if (typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonicalizeStructure(v[k]);
    return out;
  }
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v;
  return S(v);
}

/**
 * The canonical APPROVED-PLAN fingerprint: sha256 over the sorted per-step plan entries
 * [{ step, region, accountSetHash, stepPlanHash, plannedCreates, plannedTokens }] -- stepPlanHash folds
 * the FULL approved work (dates, windows, sources, request hashes, batches, membership) into the
 * fingerprint, so ANY parameter change changes the fingerprint even at identical token counts. The
 * dry-run planner emits it; the authorization operator records it (mandatory, non-blank); every
 * reservation is validated against the stored approved plan entry for its (step, region).
 */
export function onboardingPlanFingerprint(steps) {
  const canonical = (Array.isArray(steps) ? steps : [])
    .map((s) => ({
      step: S(s.step), region: S(s.region), accountSetHash: S(s.accountSetHash),
      stepPlanHash: S(s.stepPlanHash),
      plannedCreates: Number(s.plannedCreates) || 0, plannedTokens: Number(s.plannedTokens) || 0,
    }))
    .sort((a, b) => (a.step + "|" + a.region).localeCompare(b.step + "|" + b.region));
  return sha256(JSON.stringify(canonical));
}

/**
 * PURE additive merge of the discovered PRIMARY accounts into the shared account-directory snapshot
 * payload. NEVER removes or deactivates an existing entry (the manual admin refresh path owns
 * retirement); NEVER rewrites an existing entry's identity fields. Adds every discovered account that
 * is absent, and maintains two additive fields on discovered entries:
 *   settingUp        : true until the account is export-eligible (admins see "Setting up");
 *   onboardingStatus : the typed onboarding status (or a readiness-derived fallback).
 * Returns { accounts, changed }.
 */
export function mergeOnboardingIntoDirectorySnapshot({ priorAccounts, detailedAccounts, onboardingRows = null } = {}) {
  const accounts = (Array.isArray(priorAccounts) ? priorAccounts : []).map((a) => ({ ...a }));
  const byId = new Map(accounts.map((a) => [S(a && a.id), a]));
  const rows = Array.isArray(onboardingRows) ? new Map(onboardingRows.map((r) => [S(r.account_id), r])) : null;
  let changed = false;
  for (const detailed of detailedAccounts || []) {
    const accountId = S(detailed && detailed.id);
    if (!accountId || accountId.includes(":")) continue;
    const row = rows ? rows.get(accountId) : null;
    const status = S(row && row.status)
      || (accountDataDoeReady(detailed) ? ONBOARDING_STATUS.READY_FOR_BOOTSTRAP : ONBOARDING_STATUS.WAITING_FOR_DATADOE);
    const settingUp = !SERVING_STATUSES.includes(status);
    const existing = byId.get(accountId);
    if (!existing) {
      const entry = { ...toLegacyAccountShape(detailed), active: true, settingUp, onboardingStatus: status };
      accounts.push(entry);
      byId.set(accountId, entry);
      changed = true;
      continue;
    }
    if (existing.settingUp !== settingUp || existing.onboardingStatus !== status) {
      existing.settingUp = settingUp;
      existing.onboardingStatus = status;
      changed = true;
    }
  }
  return { accounts, changed };
}

/**
 * COMPOSED gate: the drop-in replacement for `fetchAccounts` on every scheduled/paid discovery path.
 * Fetches the PRIMARY detailed directory (zero-token GET), reads the onboarding rows (fail-soft), and
 * returns ONLY export-eligible accounts in the LEGACY normalized shape -- byte-identical objects to
 * fetchAccounts for every included account, so downstream payloads/hashes are unchanged.
 * `onExcluded(excluded, gateMode)` lets operators surface the typed exclusions.
 */
export async function fetchExportEligibleAccounts(apiKey, { fetchDetailed, readOnboardingRows, onExcluded = null } = {}) {
  if (typeof fetchDetailed !== "function" || typeof readOnboardingRows !== "function") {
    throw new Error("fetchExportEligibleAccounts requires injected fetchDetailed + readOnboardingRows (fail closed).");
  }
  const detailed = (await fetchDetailed(apiKey)) || [];
  let onboardingRows = null;
  try { onboardingRows = await readOnboardingRows(); } catch { onboardingRows = null; } // fail-soft -> readiness-only
  const { eligible, excluded, gateMode } = filterExportEligibleAccounts({ detailedAccounts: detailed, onboardingRows });
  if (excluded.length && typeof onExcluded === "function") {
    try { onExcluded(excluded, gateMode); } catch { /* reporting must never fail discovery */ }
  }
  return eligible.map(toLegacyAccountShape);
}
