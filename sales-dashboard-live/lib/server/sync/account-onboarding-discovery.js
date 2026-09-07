// The 15-minute PRIMARY account-onboarding DISCOVERY worker core (composition + orchestration).
//
// ZERO DataDoe exports STRUCTURALLY: this module (and everything it imports) contains no export
// adapter and no create-export path -- its only DataDoe call is the zero-token directory GET
// (fetchAccountsDetailed). Its writes are Supabase-only: account_onboarding upserts, the atomic
// bootstrap-claim RPC, the additive account-directory snapshot merge, and the account_directory
// table refresh (Data Sync Center visibility). Scheduler-v2 remains the ONE owner of every paid
// export: this worker only ARMS a newly-ready account (readiness proven -> claim recorded) so the
// next regional run bootstraps it through the existing per-source machinery under existing ceilings.
//
// Every collaborator is injectable for deterministic offline tests; buildProductionOnboardingDeps()
// wires the real ones.

import {
  ONBOARDING_STATUS, classifyOnboardingAccount, bootstrapOperationId, accountDataDoeReady,
  mergeOnboardingIntoDirectorySnapshot, computeOnboardingWaveIdentity,
} from "./account-onboarding.js";
import { regionForMarketplace, REGIONS } from "./campaign-region-routing.js";

// Literal source keys (kept dependency-light: importing their home modules would pull the DataDoe/ads
// transport graphs into this zero-export worker). Pinned by tests against the canonical exports.
const OLI_SOURCE_KEY = "order-line-items";          // == source-durable-model.js OLI_SOURCE_KEY
const CAMPAIGN_ADS_GRAIN = "campaign-performance-v1"; // == scheduled-campaign-ads-runner.js CAMPAIGN_ADS_GRAIN

const S = (v) => (v == null ? "" : String(v).trim());

// The durable report keys whose presence grades a bootstrapping account (daily + brand-sales are the
// primary sales surfaces; fba-plan + the v3 shadow are per-source detail).
export const ONBOARDING_EVIDENCE_REPORT_KEYS = Object.freeze([
  "daily-reporting", "brand-sales", "fba-plan", "scheduler-v2/listing-health-v3",
]);

// Directory-snapshot identity -- MUST stay byte-identical to api/datadoe.js persistAccountDirectory
// (reportKey/account/paramsHash), so the worker's merge lands on the SAME row the selector serves.
export const ACCOUNT_DIRECTORY_REPORT_KEY = "account-directory";
export const ACCOUNT_DIRECTORY_REPORT_VERSION = "account-directory-shared-v1";
export const ACCOUNT_DIRECTORY_ACCOUNT_ID = "__account-directory__";

// Statuses that need durable-evidence grading on a worker pass (everything else classifies from the
// directory row alone) -- keeps the steady-state worker to a handful of Supabase reads.
const EVIDENCE_STATUSES = Object.freeze([
  ONBOARDING_STATUS.READY_FOR_BOOTSTRAP, ONBOARDING_STATUS.BOOTSTRAPPING, ONBOARDING_STATUS.PARTIALLY_READY,
]);

// Material-field comparison for idempotent upserts: a pass that observes nothing new writes nothing.
// sources.*.checkedAt is excluded (it always advances); last_seen_at rides along on material changes only.
function stripVolatile(sources) {
  const out = {};
  for (const [key, value] of Object.entries(sources || {})) {
    if (value && typeof value === "object") { const { checkedAt: _c, ...rest } = value; out[key] = rest; }
    else out[key] = value;
  }
  return out;
}
export function onboardingRowMateriallyChanged(existing, desired) {
  if (!existing) return true;
  const fields = ["name", "marketplace_country_code", "marketplace_id", "region", "status", "failure_code",
    "datadoe_ready", "datadoe_row_count", "seller_central_row_count", "ads_connected", "ads_ready", "ads_row_count"];
  for (const f of fields) {
    if ((existing[f] ?? null) !== (desired[f] ?? null)) return true;
  }
  if (JSON.stringify(stripVolatile(existing.sources)) !== JSON.stringify(stripVolatile(desired.sources))) return true;
  if (desired.ready_at && !existing.ready_at) return true;
  if (desired.bootstrap_completed_at && !existing.bootstrap_completed_at) return true;
  return false;
}

/**
 * ONE bounded discovery pass. `mode`: "dry-run" (ZERO writes; reports every planned action) or
 * "live" (performs the Supabase writes). Returns typed evidence -- never a secret, never a raw body.
 */
export async function runAccountOnboardingDiscovery({ mode = "dry-run", now = null, deps, log = () => {} } = {}) {
  if (mode !== "dry-run" && mode !== "live") throw new Error("runAccountOnboardingDiscovery mode must be dry-run | live (fail closed).");
  const d = deps || {};
  for (const required of ["getConnections", "fetchDetailed", "readOnboardingRows", "upsertRows", "claimBootstrap",
    "readOliCoverage", "readSnapshotPresence", "readCampaignCoverage", "readDirectorySnapshot", "saveDirectorySnapshot",
    "upsertDirectoryTable", "paramsHashFor", "leaseDispatch", "recordDispatchError", "completeDispatch",
    "readBudget", "markAwaitingBudget"]) {
    if (typeof d[required] !== "function") throw new Error(`runAccountOnboardingDiscovery requires deps.${required} (fail closed).`);
  }
  const nowMs = now == null ? Date.now() : Number(now);
  const nowIso = new Date(nowMs).toISOString();
  const today = nowIso.slice(0, 10);

  const connections = d.getConnections();
  const primary = (connections || []).find((c) => c && c.id === "primary");
  if (!primary || !primary.apiKey) throw new Error("ONBOARDING_NO_PRIMARY_CONNECTION: primary DataDoe connection is not configured (fail closed).");

  // 1. ZERO-TOKEN directory GET (the only DataDoe call in this whole worker).
  const detailedAll = (await d.fetchDetailed(primary.apiKey)) || [];
  const detailed = detailedAll.filter((a) => S(a && a.id) && !S(a.id).includes(":"));

  // 2. Durable onboarding rows. A LIVE pass REQUIRES the table (unlike the fail-soft export gate);
  // a DRY-RUN degrades to planning against EMPTY state (the pre-migration rehearsal: it reports the
  // exact rows/claims a first live pass would make, with zero writes either way).
  const rowsRead = await d.readOnboardingRows();
  let tableAvailable = Array.isArray(rowsRead);
  if (!tableAvailable && mode === "live") {
    throw new Error("ONBOARDING_TABLE_UNAVAILABLE: account_onboarding is unreadable/absent -- apply migration 20260919 first (fail closed; no writes attempted).");
  }
  const rows = tableAvailable ? rowsRead : [];
  const rowById = new Map(rows.map((r) => [S(r.account_id), r]));

  // 3. Durable evidence for the accounts that need grading (new, or in an evidence-graded status).
  const needsEvidence = detailed.filter((a) => {
    const row = rowById.get(S(a.id));
    if (!row) return accountDataDoeReady(a); // a NEW ready account may be a grandfathered fully-serving one
    return EVIDENCE_STATUSES.includes(S(row.status));
  });
  const presencePairs = needsEvidence.length
    ? await d.readSnapshotPresence({ accountIds: needsEvidence.map((a) => S(a.id)), reportKeys: [...ONBOARDING_EVIDENCE_REPORT_KEYS] })
    : [];
  const presence = new Set(presencePairs.map((p) => `${p.accountId}|${p.reportKey}`));
  const evidenceByAccount = new Map();
  for (const a of needsEvidence) {
    const accountId = S(a.id);
    let oliFrom = null; let oliTo = null;
    try {
      const cov = await d.readOliCoverage(accountId);
      const windows = cov && cov.read === "ok" ? (cov.windows || []) : [];
      for (const w of windows) {
        const from = S(w.from); const to = S(w.to);
        if (from && (!oliFrom || from < oliFrom)) oliFrom = from;
        if (to && (!oliTo || to > oliTo)) oliTo = to;
      }
    } catch { /* unreadable coverage = no OLI evidence (never fabricated) */ }
    let campaignTo = null;
    try {
      const cov = await d.readCampaignCoverage(accountId);
      const windows = cov && cov.read === "ok" ? (cov.windows || []) : [];
      for (const w of windows) { const to = S(w.to); if (to && (!campaignTo || to > campaignTo)) campaignTo = to; }
    } catch { /* no campaign evidence */ }
    evidenceByAccount.set(accountId, {
      oliCoveredFrom: oliFrom, oliCoveredTo: oliTo, campaignCoveredTo: campaignTo,
      hasDaily: presence.has(`${accountId}|daily-reporting`),
      hasBrandSales: presence.has(`${accountId}|brand-sales`),
      hasFbaPlan: presence.has(`${accountId}|fba-plan`),
      hasListingHealthV3: presence.has(`${accountId}|scheduler-v2/listing-health-v3`),
    });
  }

  // 4. Classify every account; collect material upserts.
  const transitions = [];
  const upserts = [];
  for (const a of detailed) {
    const accountId = S(a.id);
    const existing = rowById.get(accountId) || null;
    const { row, transition } = classifyOnboardingAccount({
      discovered: a, existing, evidence: evidenceByAccount.get(accountId) || null, now: nowMs,
    });
    if (onboardingRowMateriallyChanged(existing, row)) {
      upserts.push(row);
      transitions.push({ accountId, name: S(a.name), transition, status: row.status, region: row.region });
    }
  }
  if (mode === "live" && upserts.length) await d.upsertRows(upserts);

  // 5. ATOMIC bootstrap claims for readiness-proven, unclaimed accounts. The operation id derives from
  // the FIRST discovery date, so every poll/worker/restart converges on ONE operation per account.
  // postRow is the MERGED post-upsert view: the durable row's claim-owned fields (operation_id,
  // bootstrap_started_at, first_discovered_at -- which an upsert never writes) survive under the
  // freshly-classified fields, so the dispatch scope below always sees the real claim evidence.
  const postRow = (accountId) => {
    const durable = rowById.get(accountId) || null;
    const upsert = upserts.find((u) => u.account_id === accountId) || null;
    if (!durable && !upsert) return null;
    return { ...(durable || {}), ...(upsert || {}) };
  };
  const claims = [];
  for (const a of detailed) {
    const accountId = S(a.id);
    const row = postRow(accountId);
    if (!row || S(row.status) !== ONBOARDING_STATUS.READY_FOR_BOOTSTRAP) continue;
    const existing = rowById.get(accountId);
    if (existing && S(existing.operation_id)) continue; // already claimed (RPC owns the transition)
    const discoveredDate = S(existing && existing.first_discovered_at).slice(0, 10) || today;
    const operationId = bootstrapOperationId(accountId, discoveredDate);
    if (mode === "live") {
      const result = await d.claimBootstrap({ accountId, operationId });
      claims.push({ accountId, operationId, region: S(row.region), disposition: S(result && result.disposition) || "unknown" });
    } else {
      claims.push({ accountId, operationId, region: S(row.region), disposition: "dry-run" });
    }
  }

  // 5b. RESUMABLE, BUDGET-GATED, REGION-LOCAL bootstrap dispatch (append-only wave ledger + ack
  // lifecycle). Every pass derives EACH REGION'S pending bootstrap set from the CURRENT durable state
  // (claimed = status bootstrapping with an operation_id). The wave identity is REGION-LOCAL:
  // computeOnboardingWaveIdentity(rows, region) hashes ONLY that region's sorted claimed membership, so
  // a newly claimed account in ANOTHER region can never change, restart, or re-key this region's wave,
  // dispatch identity, budget, or attempt counters. Within a region a membership change mints a NEW
  // (region, dispatch_id) row -- APPEND-ONLY: it never overwrites a queued/running/failed/completed wave.
  //
  // BUDGET GATE BEFORE ANY DISPATCH: the worker may discover, claim, and show "Setting up", but it
  // NEVER dispatches a paid bootstrap run until an AUTHORIZED budget row exists for that region's exact
  // wave key. An unauthorized wave is held durably in 'awaiting-budget' (zero workflow dispatches, zero
  // DataDoe exports, zero repeated Actions waste); once authorized, the next */30 pass leases + dispatches.
  //
  // The wave carries its IMMUTABLE scope (account_ids + operation_ids + wave_key) into the row, and the
  // dispatched run resolves its account set FROM THAT ROW (resolveBootstrapScopeByDispatch) -- never by
  // recomputing membership. A dispatch API 204 is only QUEUED; the run acks running/completed/failed.
  const bootstrapDispatches = [];
  const currentRow = (accountId) => {
    const base = postRow(accountId);
    if (!base) return null;
    const claim = claims.find((c) => c.accountId === accountId && (c.disposition === "claimed" || (mode !== "live" && c.disposition === "dry-run")));
    if (!claim) return base;
    const existing = rowById.get(accountId);
    return {
      ...base,
      status: ONBOARDING_STATUS.BOOTSTRAPPING,
      operation_id: claim.operationId,
      bootstrap_started_at: S(existing && existing.bootstrap_started_at) || nowIso,
    };
  };
  const dispatchRows = typeof d.readDispatchRows === "function"
    ? await d.readDispatchRows().catch(() => null)
    : null;
  // The POST-claim durable view of EVERY onboarding row (all regions), so each region's wave hashes the
  // SAME membership the dispatched run resolves. Region-local waves are computed independently below.
  const allAccountIds = new Set([...rowById.keys(), ...detailed.map((a) => S(a.id))]);
  const postClaimRows = [...allAccountIds].map((id) => currentRow(id)).filter(Boolean);
  for (const region of [REGIONS.INDIA, REGIONS.EUROPE_AU, REGIONS.US_CA]) {
    // The REGION-LOCAL wave identity (independent of every other region).
    const wave = computeOnboardingWaveIdentity(postClaimRows, region);
    const pending = detailed
      .map((a) => ({ account: a, row: currentRow(S(a.id)) }))
      .filter(({ account, row }) => row
        && S(row.region) === region
        && S(row.status) === ONBOARDING_STATUS.BOOTSTRAPPING
        && S(row.operation_id) !== ""
        && accountDataDoeReady(account));
    // The region's non-terminal dispatch rows (append-only ledger). GRADUATION completion is matched by
    // the ROW itself (its stored account_ids), NOT by the current wave identity -- once every account
    // GRADUATES the region has no bootstrapping rows left, so the current wave identity is null; the row
    // still names the exact accounts it covered.
    const regionRows = Array.isArray(dispatchRows) ? dispatchRows.filter((r) => S(r.region) === region) : [];

    if (!pending.length) {
      // GRADUATION COMPLETION (secondary; the run's own 'completed' ack is primary): close EACH of this
      // region's non-terminal waves ONLY when every account it covered GRADUATED to partially_ready/ready
      // (durable snapshot evidence). Never on mere absence of bootstrapping rows (a blocked account leaves
      // its wave open for review).
      for (const waveRow of regionRows) {
        if (!["awaiting-budget", "queued", "running", "failed"].includes(S(waveRow.status))) continue;
        const waveAccountIds = (Array.isArray(waveRow.account_ids) ? waveRow.account_ids : []).map(S).filter(Boolean);
        const graduated = waveAccountIds.length > 0 && waveAccountIds.every((id) => {
          const row = currentRow(id) || rowById.get(id) || null;
          const status = S(row && row.status);
          return status === ONBOARDING_STATUS.PARTIALLY_READY || status === ONBOARDING_STATUS.READY;
        });
        if (graduated) {
          if (mode === "live") await d.completeDispatch({ region, dispatchId: S(waveRow.dispatch_id) }).catch(() => {});
          bootstrapDispatches.push({ region, dispatchId: S(waveRow.dispatch_id), outcome: mode === "live" ? "completed" : "dry-run-complete" });
        }
      }
      continue;
    }

    const dispatchId = wave.dispatchId;
    const waveKey = wave.waveKey;
    const accountIds = pending.map(({ account }) => S(account.id)).sort();
    const operationIds = pending.map(({ row }) => S(row.operation_id)).filter(Boolean).sort();
    if (!dispatchId || !waveKey) { bootstrapDispatches.push({ region, accountIds, outcome: "no-wave-identity" }); continue; }

    // BUDGET GATE: read THIS region's wave budget only.
    let waveBudget = null;
    try { waveBudget = await d.readBudget(waveKey); } catch { waveBudget = null; }
    const waveAuthorized = !!(waveBudget && S(waveBudget.status) === "authorized" && S(waveBudget.plan_fingerprint));
    if (!waveAuthorized) {
      // NO AUTHORIZED BUDGET: hold this wave durably (append-only); never lease, never dispatch.
      if (mode === "live") await d.markAwaitingBudget({ region, dispatchId, waveKey, accountIds, operationIds }).catch(() => {});
      bootstrapDispatches.push({ region, dispatchId, accountIds, waveKey, outcome: mode === "live" ? "awaiting-budget" : "dry-run-awaiting-budget" });
      continue;
    }
    if (mode !== "live") { bootstrapDispatches.push({ region, dispatchId, accountIds, waveKey, outcome: "dry-run" }); continue; }
    const lease = await d.leaseDispatch({ region, dispatchId, waveKey, accountIds, operationIds });
    const disposition = S(lease && lease.disposition);
    if (disposition === "not-due" || disposition === "completed" || disposition === "region-busy" || disposition === "refused") {
      bootstrapDispatches.push({ region, dispatchId, accountIds, outcome: disposition, detail: S(lease && (lease.reason || lease.active_dispatch_id)) || null });
      continue;
    }
    if (disposition !== "leased") {
      bootstrapDispatches.push({ region, dispatchId, accountIds, outcome: "lease-unreadable" });
      continue;
    }
    if (typeof d.dispatchBootstrapRun !== "function") {
      await d.recordDispatchError({ region, dispatchId, error: "BOOTSTRAP_DISPATCH_UNAVAILABLE" }).catch(() => {});
      bootstrapDispatches.push({ region, dispatchId, accountIds, outcome: "dispatch-unavailable" });
      continue;
    }
    try {
      await d.dispatchBootstrapRun({ region, dispatchId });
      bootstrapDispatches.push({ region, dispatchId, accountIds, outcome: "dispatched", attempts: lease.attempts ?? null });
    } catch (error) {
      const safe = String(error && error.message ? error.message : error).slice(0, 200);
      await d.recordDispatchError({ region, dispatchId, error: safe }).catch(() => {});
      bootstrapDispatches.push({ region, dispatchId, accountIds, outcome: "dispatch-failed", attempts: lease.attempts ?? null });
      log(`bootstrap dispatch FAILED for ${region} (lease retries after backoff; claim + LKG stand): ${safe}`);
    }
  }

  // 6. Additive directory-snapshot merge (visibility: admins see "Setting up" immediately). Claimed
  // accounts are reflected as bootstrapping locally so the snapshot matches the post-claim state.
  const mergedRows = detailed.map((a) => {
    const accountId = S(a.id);
    const row = postRow(accountId);
    const claimed = claims.find((c) => c.accountId === accountId && (c.disposition === "claimed" || c.disposition === "already-claimed"));
    return row ? { ...row, status: claimed ? ONBOARDING_STATUS.BOOTSTRAPPING : row.status } : null;
  }).filter(Boolean);
  const priorSnapshot = await d.readDirectorySnapshot();
  const priorAccounts = Array.isArray(priorSnapshot?.payload?.accounts) ? priorSnapshot.payload.accounts : [];
  const merge = mergeOnboardingIntoDirectorySnapshot({ priorAccounts, detailedAccounts: detailed, onboardingRows: mergedRows });
  if (mode === "live" && merge.changed) {
    await d.saveDirectorySnapshot({
      reportKey: ACCOUNT_DIRECTORY_REPORT_KEY,
      accountId: ACCOUNT_DIRECTORY_ACCOUNT_ID,
      paramsHash: d.paramsHashFor(ACCOUNT_DIRECTORY_REPORT_VERSION, {}),
      params: { reportVersion: ACCOUNT_DIRECTORY_REPORT_VERSION },
      payload: { accounts: merge.accounts },
    });
  }

  // 7. account_directory TABLE refresh (Data Sync Center visibility; region as the sync bucket).
  const tableRows = detailed.map((a) => ({
    accountId: S(a.id), connectionId: "primary", country: S(a.country).toUpperCase(),
    currency: a.currency || "", name: S(a.name), bucket: regionForMarketplace(S(a.country)),
  }));
  if (mode === "live" && tableRows.length) await d.upsertDirectoryTable(tableRows);

  const summary = {
    mode, at: nowIso, tableAvailable,
    discovered: detailed.length,
    ready: detailed.filter((a) => accountDataDoeReady(a)).length,
    loading: detailed.filter((a) => !accountDataDoeReady(a)).length,
    upserts: upserts.length, transitions, claims, bootstrapDispatches,
    snapshotChanged: merge.changed, snapshotAccounts: merge.accounts.length,
    tableRows: tableRows.length,
  };
  log(`onboarding[${mode}]: discovered=${summary.discovered} ready=${summary.ready} loading=${summary.loading} upserts=${summary.upserts} claims=${claims.length} dispatches=${bootstrapDispatches.length} snapshotChanged=${merge.changed}`);
  for (const t of transitions) log(`  transition ${t.accountId.slice(0, 8)} ${t.name}: ${t.transition} (region=${t.region})`);
  for (const c of claims) log(`  claim ${c.accountId.slice(0, 8)}: ${c.operationId} -> ${c.disposition}`);
  for (const b of bootstrapDispatches) log(`  bootstrap dispatch ${b.region}: ${b.dispatchId} -> ${b.outcome}`);
  return summary;
}

// PRODUCTION wiring (dynamic imports so tests never pull transports).
export async function buildProductionOnboardingDeps() {
  const { getDataDoeConnections } = await import("../datadoe-connections.js");
  const { fetchAccountsDetailed } = await import("../datadoe.js");
  const sb = await import("../supabase.js");
  const { organizationFingerprint } = await import("../source-identity.js");
  const { paramsHashFor } = await import("../report-store.js");
  const orgFingerprintOf = () => {
    const primary = getDataDoeConnections().find((c) => c.id === "primary");
    return organizationFingerprint(primary.apiKey);
  };
  return {
    getConnections: getDataDoeConnections,
    fetchDetailed: fetchAccountsDetailed,
    readOnboardingRows: sb.getAccountOnboardingRows,
    upsertRows: sb.upsertAccountOnboardingRows,
    claimBootstrap: sb.claimAccountBootstrap,
    readOliCoverage: (accountId) => sb.getSourceCoverageWindows({
      organizationFingerprint: orgFingerprintOf(), connectionId: "primary", accountId, sourceKey: OLI_SOURCE_KEY,
    }),
    readSnapshotPresence: sb.getReportSnapshotPresence,
    readCampaignCoverage: (accountId) => sb.getDailyAdsCoverage(accountId, CAMPAIGN_ADS_GRAIN),
    readDirectorySnapshot: () => sb.getLatestReportSnapshot({
      reportKey: ACCOUNT_DIRECTORY_REPORT_KEY, accountId: ACCOUNT_DIRECTORY_ACCOUNT_ID,
    }).catch(() => null),
    saveDirectorySnapshot: (snapshot) => sb.saveReportSnapshot(snapshot),
    upsertDirectoryTable: (rows) => sb.upsertAccountDirectory(rows),
    paramsHashFor,
    // The DURABLE, APPEND-ONLY dispatch-lease + ack lifecycle (SECURITY DEFINER RPCs; migration 20260919).
    // The wave's IMMUTABLE scope (wave_key + account_ids + operation_ids) is stamped into the row here.
    leaseDispatch: ({ region, dispatchId, waveKey, accountIds, operationIds }) => sb.leaseOnboardingDispatch({ region, dispatchId, waveKey, accountIds, operationIds }),
    recordDispatchError: ({ region, dispatchId, error }) => sb.recordOnboardingDispatchError({ region, dispatchId, error }),
    completeDispatch: ({ region, dispatchId }) => sb.completeOnboardingDispatch({ region, dispatchId }),
    readDispatchRows: sb.getOnboardingDispatchRows,
    // The WAVE-BOUND budget gate: the worker only READS the budget (dispatch/no-dispatch decision) and
    // records the durable awaiting-budget hold; reservations belong to the bootstrap run's operators.
    readBudget: (waveKey) => sb.getOnboardingBudget(waveKey),
    markAwaitingBudget: ({ region, dispatchId, waveKey, accountIds, operationIds }) => sb.markOnboardingDispatchAwaitingBudget({ region, dispatchId, waveKey, accountIds, operationIds }),
    // IMMEDIATE bootstrap dispatch: trigger ONE scheduler-v2 workflow_dispatch for the claimed
    // account's region via the GitHub REST API (the SAME entry the Cloudflare watchdog uses), with
    // run_scope=bootstrap so the run spends ONLY on the backend-resolved bootstrap account set.
    // Requires GITHUB_TOKEN (provided by the Actions runtime with `actions: write`) + GITHUB_REPOSITORY;
    // absent either (e.g. a local CLI run), the lease records the typed error and retries after backoff
    // (the natural regional run remains the daily backstop). Never prints the token.
    dispatchBootstrapRun: async ({ region, dispatchId }) => {
      const token = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();
      const repo = String(process.env.GITHUB_REPOSITORY || "").trim();
      if (!token || !repo) throw new Error("BOOTSTRAP_DISPATCH_UNAVAILABLE: GITHUB_TOKEN/GITHUB_REPOSITORY not configured.");
      const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/scheduler-v2.yml/dispatches`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "upriver-account-onboarding",
        },
        body: JSON.stringify({ ref: "main", inputs: { region, refresh_mode: "normal", dispatch_id: dispatchId, run_scope: "bootstrap" } }),
      });
      if (!res || (res.status !== 204 && !res.ok)) {
        throw new Error(`BOOTSTRAP_DISPATCH_FAILED: workflow dispatch returned HTTP ${res ? res.status : "no-response"}.`);
      }
    },
  };
}
