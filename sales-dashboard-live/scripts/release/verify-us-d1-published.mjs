// READ-ONLY, per-SCOPE whole-workflow duplicate guard (a region india|europe-au|us-ca or a legacy bucket us|non-us).
// A delayed/repeated trigger -- e.g. the Cloudflare watchdog re-dispatching a region whose primary already
// succeeded -- becomes a green no-op only after exact D-1 live identities for every current primary account in that
// scope x the frozen three priority reports pass the real storage-first frontend payload read-back. The underlying
// classifier (selectPublishedUsD1Identities) is scope-generic; only the discovered account SET differs by scope.

import { appendFileSync } from "node:fs";
import pg from "pg";
import { loadReleaseEnv } from "./env-bootstrap.mjs";
import { accountInScope, isRoutingScope } from "../../lib/server/sync/scheduler-scope.js";

loadReleaseEnv();

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const bucket = argOf("bucket");
const requestedAsOf = argOf("requested-as-of");
const accountScope = argOf("account-scope") || "full";
if (!isRoutingScope(bucket)) { console.error("STOP --bucket must be a routing scope (india|europe-au|us-ca|us|non-us; got=" + bucket + ")."); process.exit(2); }
if (!/^\d{4}-\d{2}-\d{2}$/.test(String(requestedAsOf || ""))) { console.error("STOP --requested-as-of must be YYYY-MM-DD."); process.exit(2); }

const ghOut = (key, value) => { const f = process.env.GITHUB_OUTPUT; if (f) appendFileSync(f, key + "=" + value + "\n"); };
const ghSum = (value) => { const f = process.env.GITHUB_STEP_SUMMARY; if (f) appendFileSync(f, value + "\n"); };
const short = (s) => String(s || "").slice(0, 8);

// BOOTSTRAP scope: a bootstrap dispatch exists precisely because its claimed accounts have NO published
// D-1 yet -- the full-region "already published" read-back does not apply. Emit run_required=true so the
// bootstrap-scoped source steps proceed (their own scope + wave budget bound everything downstream).
if (accountScope === "bootstrap") {
  ghOut("run_required", "true");
  ghOut("already_published", "false");
  ghSum("### duplicate guard: BOOTSTRAP scope -- run required (claimed onboarding accounts have no published D-1)");
  console.log("BOOTSTRAP scope: duplicate guard bypassed (run_required=true); downstream steps are bootstrap-scoped + budget-gated.");
  process.exit(0);
}

const { getDataDoeConnections, classifyDirectoryAccounts } = await import("../../lib/server/datadoe-connections.js");
const { fetchAccountsDetailed } = await import("../../lib/server/datadoe.js");
const { fetchExportEligibleAccounts } = await import("../../lib/server/sync/account-onboarding.js");
const { getAccountOnboardingRows: readOnboardingRows } = await import("../../lib/server/supabase.js");
// EXPORT-ELIGIBILITY GATE: the duplicate guard proves the SAME export-eligible account set the
// publish pipeline uses, so a still-loading/unclaimed account can never keep a region "unpublished".
const fetchAccounts = (apiKey) => fetchExportEligibleAccounts(apiKey, { fetchDetailed: fetchAccountsDetailed, readOnboardingRows });
const { selectPublishedUsD1Identities, US_PRIORITY_REPORT_KEYS } = await import("../../lib/server/sync/source-us-publication-guard.js");
const { buildLiveReadback } = await import("../../lib/server/sync/source-priority-release-runner.js");
const { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } = await import("../../lib/server/sync/report-publisher.js");
const { REPORT_DERIVATIONS } = await import("../../lib/server/sync/report-derivation.js");
const { paramsHashFor } = await import("../../lib/server/report-store.js");
const sb = await import("../../lib/server/supabase.js");

const connections = getDataDoeConnections();
const primary = connections.find((c) => c && c.id === "primary" && String(c.apiKey || "").trim());
if (!primary) { console.error("STOP primary DataDoe connection unavailable."); process.exit(1); }
const directory = (await fetchAccounts(primary.apiKey)) || [];
const { active } = classifyDirectoryAccounts(directory, connections);
const accountIds = [];
const seen = new Set();
for (const account of active) {
  const accountId = String((account && (account.accountId ?? account.id)) || "").trim();
  const country = String((account && account.country) || "").toUpperCase();
  if (!accountId || accountId.includes(":") || seen.has(accountId) || !accountInScope(bucket, country)) continue;
  seen.add(accountId); accountIds.push(accountId);
}
if (!accountIds.length) { console.error("STOP no primary " + bucket + " accounts discovered."); process.exit(1); }

const client = new pg.Client({ connectionString: String(process.env.POSTGRES_URL).split("?")[0], ssl: { rejectUnauthorized: false } });
let rows;
try {
  await client.connect();
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  rows = (await client.query(
    "select report_key,account_id,params_hash,params,updated_at from public.report_snapshots where report_key=any($1::text[]) and account_id=any($2::text[]) and params->>'to'=$3",
    [US_PRIORITY_REPORT_KEYS, accountIds, requestedAsOf],
  )).rows;
  await client.query("ROLLBACK");
} catch (error) {
  try { await client.query("ROLLBACK"); } catch { /* ignore */ }
  console.error("STOP US duplicate-guard read failed: " + (error && error.message ? error.message : error));
  process.exitCode = 1;
} finally {
  try { await client.end(); } catch { /* ignore */ }
}
if (process.exitCode) process.exit(process.exitCode);

const selected = selectPublishedUsD1Identities({
  accountIds, requestedAsOf, rows,
  liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS,
  computeHash: paramsHashFor,
});
const readback = buildLiveReadback({
  getReportSnapshot: sb.getReportSnapshot,
  loadStoragePayload: sb.getReportSnapshotStoragePayload,
  liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS,
  reportDerivations: REPORT_DERIVATIONS,
  computeHash: paramsHashFor,
});
const problems = [...selected.problems];
if (selected.complete) {
  for (const identity of selected.identities) {
    let result;
    try { result = await readback(identity); } catch { result = { ok: false, reason: "read-error" }; }
    if (!result || result.ok !== true) problems.push(identity.reportKey + "/" + short(identity.accountId) + ":" + String(result && result.reason || "readback-failed"));
  }
}
const complete = selected.complete && problems.length === 0;
ghOut("already_published", complete ? "true" : "false");
ghOut("run_required", complete ? "false" : "true");
ghOut("account_count", String(selected.accountCount));
ghOut("expected_count", String(selected.expectedCount));
if (complete) {
  console.log("ALREADY_PUBLISHED_D1[" + bucket + "]: exact " + selected.expectedCount + " live read-backs passed for " + selected.accountCount + " " + bucket + " accounts at " + requestedAsOf + "; zero writes.");
  ghSum("### " + bucket + " D-1 duplicate guard\n- **ALREADY_PUBLISHED_D1** -- exact " + selected.expectedCount + " live read-backs passed (" + selected.accountCount + " accounts x 3 reports)\n- The delayed/repeated trigger (e.g. the watchdog) is a green no-op: zero creates, zero controls, zero tokens.");
} else {
  console.log("D1_RUN_REQUIRED[" + bucket + "]: " + problems.length + " exact live proof(s) missing/invalid; continuing through the normal " + bucket + " refresh and publish path.");
  for (const problem of problems.slice(0, 12)) console.log("note: " + problem);
  ghSum("### " + bucket + " D-1 duplicate guard\n- **RUN_REQUIRED** -- " + problems.length + " exact live proof(s) missing/invalid for requested D-1 " + requestedAsOf + "\n- Continue through the normal fail-closed " + bucket + " refresh and publish path.");
}
