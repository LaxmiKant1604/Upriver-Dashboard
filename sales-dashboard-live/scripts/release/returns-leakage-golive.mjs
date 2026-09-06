// Returns & Refund Leakage -- DEDICATED bucket operator CLI. Wires real DataDoe + Supabase into the tested,
// dependency-injected runReturnsBucketCycle. Fully decoupled from scheduler-v2 / Daily / Brand / FBA.
//
// Usage:
//   node scripts/release/returns-leakage-golive.mjs --bucket=us|non-us [--as-of=YYYY-MM-DD] --mode=dry-run|go-live
//
//   dry-run  -> discovery + batching + token plan ONLY; ZERO creates, ZERO writes (proves the plan).
//   go-live  -> fetch Returns(60d)+Settlements(21d/initial) per <=5-seller batch (2 tokens each), atomically replace
//               the durable window, then publish every bucket account's returns-leakage-v3 snapshot from durable
//               evidence (ZERO extra tokens). Token-gated: US<=8, Non-US<=20; an insufficient balance is a safe skip.
//
// Idempotent: a batch already covering asOf is skipped with zero tokens (primary/fallback share this marker).

import { readFileSync, existsSync } from "node:fs";
import pg from "pg";

// ---- env bootstrap (CI sets these; locally load the repo-root .env.local) ----
for (const p of ["C:/Users/laxmi/Documents/Codex/2026-07-01/can/Upriver-Dashboard/.env.local", "../.env.local", ".env.local"]) {
  try {
    if (!existsSync(p)) continue;
    for (const l of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(l);
      if (m) { let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); if (!process.env[m[1]]) process.env[m[1]] = v; }
    }
    break;
  } catch { /* ignore */ }
}
if (!process.env.SUPABASE_URL && process.env.VITE_SUPABASE_URL) process.env.SUPABASE_URL = process.env.VITE_SUPABASE_URL;
if (process.env.PGSSL_NO_VERIFY !== "0") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const arg = (name, def = null) => { const p = process.argv.find((a) => a.startsWith(`--${name}=`)); return p ? p.slice(name.length + 3) : def; };
const bucket = arg("bucket");
const mode = arg("mode", "dry-run");
const maxBatches = arg("max-batches") ? Number(arg("max-batches")) : null; // bounded canary (fetch at most N batches)
let asOf = arg("as-of");
if (!asOf) { const d = new Date(Date.now() - 86400000); asOf = d.toISOString().slice(0, 10); } // default D-1 (UTC)
if (bucket !== "us" && bucket !== "non-us") { console.error(`FATAL: --bucket must be us|non-us (got ${bucket})`); process.exit(1); }
if (mode !== "dry-run" && mode !== "go-live") { console.error(`FATAL: --mode must be dry-run|go-live`); process.exit(1); }

const log = (...a) => console.log(...a);

// ---- imports (after env is set so supabase.js reads the right vars) ----
const { runReturnsBucketCycle } = await import("../../lib/server/sync/returns-operation.js");
const { fetchAccountsDetailed, fetchExportRows } = await import("../../lib/server/datadoe.js");
const { fetchExportEligibleAccounts } = await import("../../lib/server/sync/account-onboarding.js");
// EXPORT-ELIGIBILITY GATE: returns/settlement exports run only for export-eligible primary accounts.
const fetchAccounts = async (key) => {
  const { getAccountOnboardingRows } = await import("../../lib/server/supabase.js");
  return fetchExportEligibleAccounts(key, { fetchDetailed: fetchAccountsDetailed, readOnboardingRows: getAccountOnboardingRows });
};
const { sourceRequestIdentity, organizationFingerprint } = await import("../../lib/server/source-identity.js");
const { bucketForCountry } = await import("../../lib/server/sync/registry.js");
const { getDataDoeTokenBalance, tokenGateDecision } = await import("../../lib/server/datadoe-usage.js");
const { buildReturnsPublishAccount } = await import("../../lib/server/reports/returns-publish.js");
const { RETURNS_ADVANCED_VERSION } = await import("../../lib/server/reports/returns-advanced.js");
const { paramsHashFor } = await import("../../lib/server/report-store.js");
const sb = await import("../../lib/server/supabase.js");

const apiKey = process.env.DATADOE_API_KEY;
if (!apiKey) { console.error("FATAL: DATADOE_API_KEY missing"); process.exit(1); }
const orgFp = organizationFingerprint(apiKey);

// ---- durable coverage read (min/max dates per account) via direct pg (aggregates) ----
const pgClient = new pg.Client({ connectionString: process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL });
await pgClient.connect();
async function readCoverage(accountIds) {
  const map = new Map(accountIds.map((id) => [id, { returnsMax: null, returnsRefreshedAt: null, settlementMax: null, settlementMin: null, settlementRefreshedAt: null }]));
  if (!accountIds.length) return map;
  // Fail-soft: pre-migration (durable tables absent) -> no coverage (every batch needs a fetch). Never fabricates.
  try {
    const r = await pgClient.query(
      `select account_id, max(return_date)::text rmax, max(refreshed_at)::text rref from source_returns_history where organization_fingerprint=$1 and connection_id='primary' group by account_id`, [orgFp]);
    for (const row of r.rows) { const e = map.get(row.account_id); if (e) { e.returnsMax = row.rmax; e.returnsRefreshedAt = row.rref; } }
    const s = await pgClient.query(
      `select account_id, max(settlement_date)::text smax, min(settlement_date)::text smin, max(refreshed_at)::text sref from source_settlement_history where organization_fingerprint=$1 and connection_id='primary' group by account_id`, [orgFp]);
    for (const row of s.rows) { const e = map.get(row.account_id); if (e) { e.settlementMax = row.smax; e.settlementMin = row.smin; e.settlementRefreshedAt = row.sref; } }
  } catch (e) {
    if (!/does not exist/i.test(String(e && e.message))) throw e;
    log("coverage: durable tables not yet applied -> treating as no coverage (all batches fetch)");
  }
  return map;
}

// ---- roster ----
async function listAccounts() {
  const rows = await fetchAccounts(apiKey);
  return (Array.isArray(rows) ? rows : []).map((a) => ({
    accountId: String(a.id ?? a.accountId), sellerOrVendorId: String(a.id ?? a.accountId),
    country: a.marketplaceCountryCode ?? a.country ?? "", marketplaceCountryCode: a.marketplaceCountryCode ?? a.country ?? "",
    currency: a.currency ?? null, connectionId: "primary", organizationFingerprint: orgFp, name: a.name ?? "",
  }));
}

// ---- one DataDoe export per batch: rows + provenance hash ----
async function fetchExport({ sourceId, columns, ids, from, to, options, label }) {
  const rows = await fetchExportRows(apiKey, sourceId, columns, ids, from, to, options.limit ?? 50000, options);
  const { requestHash } = sourceRequestIdentity({ apiKey, sourceId, columns, ids, from, to, limit: options.limit ?? 50000, options });
  return { rows: Array.isArray(rows) ? rows : [], exportId: null, requestHash, refreshedAt: new Date().toISOString(), label };
}

// ---- durable readers for the publish step ----
const readers = {
  readReturnsHistory: sb.getReturnsHistoryRows, readSettlementHistory: sb.getSettlementHistoryRows,
  readOliHistory: sb.getSourceOliHistoryRows, readOliCoverage: sb.getSourceCoverageWindows,
  readOliOperationalUnits: sb.getSourceOliOperationalUnitRows, readCatalogSnapshot: sb.getSourceSnapshot,
  loadCatalogPayload: sb.getSourceSnapshotPayload, readOliSkuAsinResolution: sb.getOliSkuAsinResolutionRows,
  readDirectory: sb.getAccountDirectorySnapshotAccounts,
};
async function saveSnapshot({ reportKey, accountId, payload, sourceRefreshedAt, asOf: at }) {
  const paramsHash = paramsHashFor(RETURNS_ADVANCED_VERSION, { to: at });
  const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  const r = await sb.publishLiveSnapshotIfNewer({
    reportKey, accountId, paramsHash, params: { reportVersion: RETURNS_ADVANCED_VERSION, to: at },
    payload, payloadBytes, sourceRefreshedAt: sourceRefreshedAt || new Date().toISOString(),
  }).catch((e) => ({ outcome: "error", error: String(e && e.message) }));
  const published = ["inserted", "replaced", "already-current", "newer-live"].includes(r && r.outcome);
  return { published, outcome: r && r.outcome };
}
const publishAccount = buildReturnsPublishAccount({ readers, saveSnapshot });

// ---- run ----
const deps = {
  listAccounts, bucketForCountry, readCoverage,
  getTokenBalance: () => getDataDoeTokenBalance({ apiKey }), tokenGate: tokenGateDecision,
  fetchExport,
  replaceReturns: (a) => sb.replaceReturnsHistoryWindow({ organizationFingerprint: a.organizationFingerprint, connectionId: a.connectionId, accountId: a.accountId, coveredFrom: a.from, coveredTo: a.to, returnRows: a.rows }),
  replaceSettlements: (a) => sb.replaceSettlementHistoryWindow({ organizationFingerprint: a.organizationFingerprint, connectionId: a.connectionId, accountId: a.accountId, coveredFrom: a.from, coveredTo: a.to, settlementRows: a.rows }),
  publishAccount, log,
};

try {
  const summary = await runReturnsBucketCycle({ bucket, asOf, mode, maxBatches, deps });
  log("\n=== RETURNS CYCLE SUMMARY ===");
  log(JSON.stringify({ ...summary, batchPlan: undefined }, null, 2));
  await pgClient.end().catch(() => {});
  // Exit code: a hard STOP (ceiling/unreadable balance) is nonzero so the workflow surfaces it; a safe skip is 0.
  const hardStop = summary.outcome === "TOKEN_CEILING_EXCEEDED" || summary.outcome === "TOKEN_BALANCE_UNREADABLE";
  process.exit(hardStop ? 2 : 0);
} catch (e) {
  console.error("FATAL:", e && e.stack ? e.stack : e);
  await pgClient.end().catch(() => {});
  process.exit(1);
}
