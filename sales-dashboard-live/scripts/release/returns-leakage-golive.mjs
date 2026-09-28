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
//
// STEP 7 (publish) -- publication recovery WP5: the per-account publish no longer writes the live row itself (the old
// unfenced publishLiveSnapshotIfNewer({ to: asOf })). runReturnsBucketCycle still calls publishAccount once per bucket
// account after the acquisition; the account is only COLLECTED there, and after the cycle returns this operator runs
// the FENCED zero-export returns-v3 recovery route for exactly those accounts:
//   node scripts/release/publication-route-reconcile.mjs --route=returns-v3 --bucket=<region> --as-of=<asOf> --live
//     --targets=<the region's acquired accounts, <= 25 per call> --mode=scheduler --lease-wait-seconds=600
//     --run-token=<unique> --deadline-seconds=1500
// (spawnSync, one call per (region, <= 25 accounts); an abnormal exit runs the SAME CLI with --cleanup and the same run
// token). The route re-derives from the durable evidence this run just saved and publishes through the reviewed four-gate
// publisher + fenced CAS with lineage + live read-back + the served-row check -- ONE fenced writer for returns-leakage.
// An acquired account outside the durable directory scope is NOT published (LKG kept) and is surfaced as a typed
// 'RETURNS_ALERT {"outOfScope":n,"accounts":[...]}' line + the workflow output returns_out_of_scope=<n>. The
// acquisition pg client is closed right after the cycle, BEFORE the blocking route spawn.
// The ACQUISITION steps (discovery, coverage marker, token gate, exports, atomic durable replace) are BYTE-IDENTICAL
// (pinned by scripts/returns-v3-route.test.js). Postgres is reached only through lib/server/pg-tls.js verifiedPgConfig,
// and the former process-wide TLS-verification override is REMOVED -- every TLS connection (pg, Supabase REST, DataDoe)
// is verified.

import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { verifiedPgConfig } from "../../lib/server/pg-tls.js";

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
// TLS is VERIFIED: no process-wide certificate-verification override; pg below uses verifiedPgConfig.

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
  const { getAccountOnboardingRows, getAccountDirectorySnapshotAccounts } = await import("../../lib/server/supabase.js");
  return fetchExportEligibleAccounts(key, { fetchDetailed: fetchAccountsDetailed, readOnboardingRows: getAccountOnboardingRows, readEstablishedAccountIds: getAccountDirectorySnapshotAccounts });
};
const { sourceRequestIdentity, organizationFingerprint } = await import("../../lib/server/source-identity.js");
const { bucketForCountry } = await import("../../lib/server/sync/registry.js");
const { getDataDoeTokenBalance, tokenGateDecision } = await import("../../lib/server/datadoe-usage.js");
// Step 7 (the fenced route): the durable-directory scope + the pure invocation planner / RESULT parser.
const { buildDurableDirectory } = await import("../../lib/server/sync/route-publication-release.js");
const { planReturnsRouteInvocations, parseRouteResultLine, returnsOutOfScopeAlert } = await import("../../lib/server/sync/routes/returns-v3.release.js");
const { getDataDoeConnections, resolveDataDoeAccountIds } = await import("../../lib/server/datadoe-connections.js");
const { normalizeMarketplace } = await import("../../lib/server/sync/oli-sales-estimate.js");
const sb = await import("../../lib/server/supabase.js");

const apiKey = process.env.DATADOE_API_KEY;
if (!apiKey) { console.error("FATAL: DATADOE_API_KEY missing"); process.exit(1); }
const orgFp = organizationFingerprint(apiKey);

// ---- durable coverage read (min/max dates per account) via direct pg (aggregates) ----
// VERIFIED TLS: chain pinned to the Supabase root CA + hostname checked (lib/server/pg-tls.js) -- the SAME pooler URL
// every verified zero-export operator uses (POSTGRES_URL).
const pgClient = new pg.Client(verifiedPgConfig(process.env.POSTGRES_URL));
// readCoverage (the cycle's FIRST step) is this client's ONLY user; it then sits idle through the exports. An idle
// server-side drop must never crash the operator with an unhandled 'error' event: it is logged (by code only), and the
// dropped client is never reused -- any later query on it rejects, so the cycle fails CLOSED (exit 1).
pgClient.on("error", (e) => { log(`pg: the acquisition client dropped (${String((e && e.code) || "connection-error").replace(/[^\x20-\x7e]/g, "").slice(0, 40)}); it is not reused`); });
// Close it exactly once, bounded (a dropped socket can never hang the operator on its 'end' event).
let pgClientEnded = null;
function endPgClient() {
  if (!pgClientEnded) {
    let timer = null;
    pgClientEnded = Promise.race([pgClient.end().catch(() => {}), new Promise((resolve) => { timer = setTimeout(resolve, 10000); })])
      .finally(() => clearTimeout(timer));
  }
  return pgClientEnded;
}
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

// ---- step 7: COLLECT the accounts to publish (the fenced returns-v3 route publishes them after the cycle) ----
// No live write here: an account is recorded and reported 'route-pending'; publishViaRoute() below is the ONLY writer.
const routeTargets = new Set();
async function publishAccount({ account }) {
  const id = String((account && account.accountId) || "").trim();
  if (id) routeTargets.add(id);
  return { published: false, outcome: "route-pending" };
}

// ---- step 7: publish through the FENCED zero-export returns-v3 route (ZERO DataDoe; spawnSync per region chunk) ----
const ROUTE_CLI = fileURLToPath(new URL("./publication-route-reconcile.mjs", import.meta.url));
const APP_DIR = fileURLToPath(new URL("../../", import.meta.url));
const ROUTE_DEADLINE_SECONDS = 1500;
const ROUTE_CHILD_TIMEOUT_MS = (ROUTE_DEADLINE_SECONDS + 300) * 1000;
function runRouteCli(argv, timeoutMs) {
  const res = spawnSync(process.execPath, [ROUTE_CLI, ...argv], { cwd: APP_DIR, env: process.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  return res;
}
async function publishViaRoute(accountIds) {
  const out = { invocations: [], outOfScope: [], published: 0, alreadyCurrent: 0, deferred: 0, failed: 0, failedInvocations: 0 };
  // The route CLI's OWN scope: the DURABLE account directory + the local raw-seller map (no DataDoe discovery).
  const connections = getDataDoeConnections() || [];
  const resolveRawSellerId = (id) => { const r = resolveDataDoeAccountIds([id], connections); return r && Array.isArray(r.rawAccountIds) && r.rawAccountIds.length === 1 ? String(r.rawAccountIds[0]) : ""; };
  const { directory } = buildDurableDirectory({ rows: await sb.getAccountDirectorySnapshotAccounts(), resolveRawSellerId, normalizeMarketplace });
  const plan = planReturnsRouteInvocations({ accountIds, directory });
  out.outOfScope = plan.outOfScope;
  if (plan.outOfScope.length) log(`step 7: ${plan.outOfScope.length} account(s) are not in the durable directory scope -> NOT published (typed route-out-of-scope; LKG kept)`);
  // ... and a TYPED alert (+ a workflow output) so the unpublished accounts are visible. The exit code is unchanged: an
  // out-of-scope account is a directory state (no route invocation failed; its LKG stays served), not a route failure.
  const alert = returnsOutOfScopeAlert(plan.outOfScope);
  if (alert) {
    log(alert.line);
    if (process.env.GITHUB_OUTPUT) { try { appendFileSync(process.env.GITHUB_OUTPUT, alert.githubOutput + "\n"); } catch { log("step 7: GITHUB_OUTPUT not writable; the RETURNS_ALERT line above carries the count"); } }
  }
  for (const { region, targets } of plan.chunks) {
    const runToken = `returns-golive-${bucket}-${asOf}-${region}-${randomBytes(6).toString("hex")}`;
    const argv = [
      "--route=returns-v3", `--bucket=${region}`, `--as-of=${asOf}`, "--live", `--targets=${targets.join(",")}`,
      "--mode=scheduler", "--lease-wait-seconds=600", `--run-token=${runToken}`, `--deadline-seconds=${ROUTE_DEADLINE_SECONDS}`,
    ];
    log(`step 7: returns-v3 route ${region}: ${targets.length} account(s) (run token ${runToken})`);
    const res = runRouteCli(argv, ROUTE_CHILD_TIMEOUT_MS);
    const result = parseRouteResultLine(res.stdout);
    // Abnormal = the child did not finish on its own terms, OR it finished reporting that its OWN control cleanup did not
    // complete (RESULT code CONTROL_CLEANUP_UNRESOLVED: an unconfirmed deadline termination / a failed safe-close left the
    // lease + route controls open) -- both get the evidence-based same-token cleanup, like the worker and the scheduler.
    const abnormal = !!res.error || res.status === null || !!res.signal || !!(result && result.code === "CONTROL_CLEANUP_UNRESOLVED");
    let cleanup = null;
    if (abnormal) {
      // An abnormal exit may have left the control window open: evidence-based safe-close with the SAME run token.
      const c = runRouteCli(["--route=returns-v3", `--bucket=${region}`, `--as-of=${asOf}`, "--cleanup", `--run-token=${runToken}`], 300000);
      const cr = parseRouteResultLine(c.stdout);
      cleanup = { status: c.status, cleaned: !!(cr && cr.cleaned === true) };
    }
    const counts = (result && result.counts) || {};
    out.published += Number(counts.targetsPublished) || 0;
    out.alreadyCurrent += Number(counts.targetsAlreadyCurrent) || 0;
    out.deferred += Number(counts.targetsDeferred) || 0;
    // No RESULT line (a STOP before any unit ran, or an abnormal exit): every target of the call is unproven -> failed.
    out.failed += result ? (Number(counts.targetsFailed) || 0) : targets.length;
    const ok = !abnormal && res.status === 0 && !!result && result.ok === true;
    if (!ok) out.failedInvocations += 1;
    out.invocations.push({ region, targets: targets.length, exit: res.status, abnormal, outcome: result ? result.outcome : "no-result", code: result ? result.code : "NO_RESULT", counts, cleanup });
  }
  return out;
}

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
  // The acquisition is over (the pg client's only user ran first): close it BEFORE the blocking (up to ~30 min per
  // chunk) route spawn, so an idle drop during the spawn can neither crash nor hang this operator.
  await endPgClient();
  let routeFailed = false;
  if (routeTargets.size > 0) {
    // runReturnsBucketCycle reached step 7 (go-live, past the token gate): publish through the fenced route and report
    // the ROUTE's per-account truth (published / already-current / deferred / failed) -- never the collector's.
    const route = await publishViaRoute([...routeTargets]);
    summary.published = route.published;
    summary.alreadyCurrent = route.alreadyCurrent;
    summary.publishDeferred = route.deferred + route.outOfScope.length;
    summary.publishFailed = route.failed;
    summary.publishRoute = { invocations: route.invocations, outOfScope: route.outOfScope };
    routeFailed = route.failedInvocations > 0;
    log(`step 7 (returns-v3 route): published ${route.published}, already-current ${route.alreadyCurrent}, deferred ${summary.publishDeferred}, failed ${route.failed} of ${routeTargets.size} account(s); ${route.failedInvocations} failed route invocation(s)`);
  }
  log("\n=== RETURNS CYCLE SUMMARY ===");
  log(JSON.stringify({ ...summary, batchPlan: undefined }, null, 2));
  await endPgClient();
  // Exit code: a hard STOP (ceiling/unreadable balance) is nonzero so the workflow surfaces it; a safe skip is 0. A
  // route invocation that did not finish ok (hard failure / STOP / abnormal exit) is surfaced as 1 (LKG preserved).
  const hardStop = summary.outcome === "TOKEN_CEILING_EXCEEDED" || summary.outcome === "TOKEN_BALANCE_UNREADABLE";
  process.exit(hardStop ? 2 : (routeFailed ? 1 : 0));
} catch (e) {
  console.error("FATAL:", e && e.stack ? e.stack : e);
  await endPgClient();
  process.exit(1);
}
