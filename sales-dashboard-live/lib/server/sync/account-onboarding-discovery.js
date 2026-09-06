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
  mergeOnboardingIntoDirectorySnapshot,
} from "./account-onboarding.js";
import { regionForMarketplace } from "./campaign-region-routing.js";

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
    "upsertDirectoryTable", "paramsHashFor"]) {
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
  const postRow = (accountId) => upserts.find((u) => u.account_id === accountId) || rowById.get(accountId) || null;
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
      claims.push({ accountId, operationId, disposition: S(result && result.disposition) || "unknown" });
    } else {
      claims.push({ accountId, operationId, disposition: "dry-run" });
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
    upserts: upserts.length, transitions, claims,
    snapshotChanged: merge.changed, snapshotAccounts: merge.accounts.length,
    tableRows: tableRows.length,
  };
  log(`onboarding[${mode}]: discovered=${summary.discovered} ready=${summary.ready} loading=${summary.loading} upserts=${summary.upserts} claims=${claims.length} snapshotChanged=${merge.changed}`);
  for (const t of transitions) log(`  transition ${t.accountId.slice(0, 8)} ${t.name}: ${t.transition} (region=${t.region})`);
  for (const c of claims) log(`  claim ${c.accountId.slice(0, 8)}: ${c.operationId} -> ${c.disposition}`);
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
  };
}
