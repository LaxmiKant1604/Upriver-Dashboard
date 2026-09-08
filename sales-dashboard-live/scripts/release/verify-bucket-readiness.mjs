// TRUSTED, READ-ONLY per-bucket publish-readiness proof + effectivePublishAsOf calculator (Scheduler v2 INDEPENDENT
// buckets). Usage (run from sales-dashboard-live/, AFTER this bucket's OLI + ASIN-Ads refresh, BEFORE opening any
// control):
//   node scripts/release/verify-bucket-readiness.mjs --bucket=us|non-us [--requested-as-of=YYYY-MM-DD]
//
// It discovers EXACTLY this bucket's primary accounts and PROVES (READ ONLY) they can publish honestly:
//   - requestedAsOf     -- the date the scheduler tried to refresh (default: previous UTC day).
//   - effectivePublishAsOf = the latest COMMON gapless durable-OLI date across ONLY this bucket, clamped back over
//     at most 2 days of trailing DataDoe settlement lag (assessBucketPublishReadiness). A normal trailing tail
//     publishes honestly through that date (UPSTREAM_TAIL_LAG); an INTERIOR/LEADING historical hole, UNREADABLE
//     coverage, BLANK provenance, or a tail lag BEYOND two days FAILS CLOSED. ASIN-Ads gaps + ads-disconnected
//     accounts are typed UNAVAILABLE / informational NOTES -- never a blocker (the OLI sales half still publishes).
// It emits `effective_asof`, `status`, `requested_asof`, `proceed` to GITHUB_OUTPUT for the release step to pin the
// derive window. Exit 0 = publishable; nonzero = fail closed. Prints counts / dates / 8-char prefixes only -- never
// a full account/seller/export id or raw payload.

import { appendFileSync } from "node:fs";
import pg from "pg";
import { loadReleaseEnv } from "./env-bootstrap.mjs";
import { accountInScope, isRoutingScope } from "../../lib/server/sync/scheduler-scope.js";

loadReleaseEnv();

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const bucket = argOf("bucket");
const accountScope = argOf("account-scope") || "full";
if (!isRoutingScope(bucket)) { console.error("STOP --bucket must be a routing scope (india|europe-au|us-ca|us|non-us; got: " + bucket + ")"); process.exit(2); }
const requestedAsOf = argOf("requested-as-of") || argOf("as-of") || (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedAsOf)) { console.error("STOP --requested-as-of must be YYYY-MM-DD (got: " + requestedAsOf + ")"); process.exit(2); }
if (accountScope !== "full" && accountScope !== "bootstrap") { console.error("STOP --account-scope must be full | bootstrap (got: " + accountScope + ")"); process.exit(2); }
const addDays = (ymd, n) => { const d = new Date(`${ymd}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const cycleDate = addDays(requestedAsOf, 1);
const adsFrom = addDays(requestedAsOf, -20); const adsTo = requestedAsOf;

const { getDataDoeConnections, classifyDirectoryAccounts } = await import("../../lib/server/datadoe-connections.js");
const { fetchAccountsDetailed, fetchCompatibleSourceNames } = await import("../../lib/server/datadoe.js");
const { fetchExportEligibleAccounts } = await import("../../lib/server/sync/account-onboarding.js");
const { getAccountOnboardingRows: readOnboardingRows, getAccountDirectorySnapshotAccounts: readEstablishedAccountIds } = await import("../../lib/server/supabase.js");
const { resolveBootstrapScope } = await import("../../lib/server/sync/account-onboarding-bootstrap.js");
// ACCOUNT SCOPE:
//   full      -> EXPORT-ELIGIBILITY GATE: the readiness proof covers EXACTLY the export-eligible
//                account set the publish steps will use (same gate), so a still-loading/unclaimed
//                account can never fail-close a region's honest D-1 publication.
//   bootstrap -> the REAL readiness assessment over ONLY the region's atomically-claimed onboarding
//                accounts (durable account_onboarding evidence, fail-closed): the SAME D-1 coverage/
//                provenance/completeness gates apply to the trusted set, so a bootstrap run publishes
//                its accounts' dashboards automatically the moment their sources prove D-1 -- and
//                fails closed (typed, LKG untouched) while they do not.
const fetchAccounts = accountScope === "bootstrap"
  ? async (apiKey) => (await resolveBootstrapScope(apiKey, { region: bucket })).accounts
  : (apiKey) => fetchExportEligibleAccounts(apiKey, { fetchDetailed: fetchAccountsDetailed, readOnboardingRows, readEstablishedAccountIds });
const { ASIN_ADS_SOURCE_NAME } = await import("../../lib/server/sync/scheduled-asin-ads-runner.js");
const { getSyncCycleByBucketDate, getSyncSourceJobs, getSyncSourceJobOwnersForCycle, getSourceCoverageWindows, getOliCompleteness } = await import("../../lib/server/supabase.js");
const { assessScheduledOliCycle } = await import("../../lib/server/sync/source-scheduled-oli.js");
const { assessBucketPublishReadiness } = await import("../../lib/server/sync/source-scheduled-prerequisites.js");
const { sourceRegistryEntry } = await import("../../lib/server/sync/source-registry.js");
const { organizationFingerprint } = await import("../../lib/server/source-identity.js");

const log = (m) => console.log("verify-readiness[" + bucket + "@" + requestedAsOf + "]: " + m);
const ghOut = (k, v) => { const f = process.env.GITHUB_OUTPUT; if (f) { try { appendFileSync(f, k + "=" + v + "\n"); } catch { /* ignore */ } } };
const ghSum = (s) => { const f = process.env.GITHUB_STEP_SUMMARY; if (f) { try { appendFileSync(f, s + "\n"); } catch { /* ignore */ } } };

// discover EXACTLY this bucket's primary accounts (zero tokens)
const connections = getDataDoeConnections();
const primaryConn = connections.find((c) => c.id === "primary");
const rows = (await fetchAccounts(primaryConn.apiKey)) || [];
const { active } = classifyDirectoryAccounts(rows, connections);
const seen = new Set();
const discovered = [];
for (const a of active) { const id = String((a && (a.accountId ?? a.id)) || "").trim(); const country = String((a && a.country) || "").toUpperCase(); if (!id || id.includes(":") || seen.has(id)) continue; if (!accountInScope(bucket, country)) continue; seen.add(id); discovered.push({ accountId: id }); }
if (!discovered.length && accountScope === "bootstrap") {
  // NOTHING claimed in this region: a valid green no-op -- no publish steps run, LKG untouched.
  ghOut("proceed", "false"); ghOut("status", "BOOTSTRAP_SCOPE_EMPTY"); ghOut("effective_asof", ""); ghOut("requested_asof", requestedAsOf);
  log("BOOTSTRAP_SCOPE_EMPTY: no claimed bootstrap accounts in " + bucket + " -- nothing to assess or publish.");
  process.exit(0);
}
if (!discovered.length) { console.error("STOP no discovered " + bucket + " primary accounts"); process.exit(1); }
const ids = discovered.map((a) => a.accountId);
log(discovered.length + " primary accounts (" + accountScope + " scope); ASIN-Ads window [" + adsFrom + ".." + adsTo + "]; cycle date " + cycleDate);

const oliStart = sourceRegistryEntry("order-line-items").initialBackfill.start;
const orgFp = primaryConn.organizationFingerprint || organizationFingerprint(primaryConn.apiKey);

const base = String(process.env.POSTGRES_URL).split("?")[0];
const c = new pg.Client({ connectionString: base, ssl: { rejectUnauthorized: false } });
await c.connect();
const coverageByAccountId = {}; const provenanceBlankByAccountId = {};
const adsCoveredByAccountId = {}; const adsFailedByAccountId = {};
let cyclePresent = false; let cycleOliAssessment = null;
try {
  await c.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  // OLI provenance: existing history rows must carry a nonblank source_request_hash; zero rows is vacuously ok.
  const oli = (await c.query("select account_id, count(*) filter(where source_request_hash is null or btrim(source_request_hash)='')::int blank_prov from public.source_oli_daily_history where account_id = any($1::text[]) group by 1", [ids])).rows;
  const oliMap = new Map(oli.map((r) => [String(r.account_id), r]));
  // ASIN-Ads coverage + failed state (informational only).
  const ads = (await c.query("select account_id, min(covered_from)::text cf, max(covered_to)::text ct from public.ads_sync_coverage where source_key='asin-performance-v1' and status='succeeded' and account_id = any($1::text[]) group by 1", [ids])).rows;
  const adsMap = new Map(ads.map((r) => [String(r.account_id), r]));
  const adsState = (await c.query("select account_id, last_status from public.ads_sync_state where source_key='asin-performance-v1' and account_id = any($1::text[])", [ids])).rows;
  const adsFailedSet = new Set(adsState.filter((r) => String(r.last_status) === "failed").map((r) => String(r.account_id)));
  // Durable OLI coverage windows per account (null = unreadable -> fail closed downstream).
  for (const id of ids) {
    let windows = null;
    try { const cov = await getSourceCoverageWindows({ organizationFingerprint: orgFp, connectionId: "primary", accountId: id, sourceKey: "order-line-items" }); windows = cov && cov.read === "ok" ? (cov.windows || []) : null; } catch { windows = null; }
    coverageByAccountId[id] = windows;
    provenanceBlankByAccountId[id] = oliMap.has(id) ? Number(oliMap.get(id).blank_prov) > 0 : false;
    const ad = adsMap.get(id);
    adsCoveredByAccountId[id] = Boolean(ad && ad.cf && ad.ct && ad.cf <= adsFrom && ad.ct >= adsTo);
    adsFailedByAccountId[id] = adsFailedSet.has(id);
  }
  // The bucket's OWN scheduled OLI cycle (secondary provenance).
  const cyc = await getSyncCycleByBucketDate(bucket, cycleDate).catch(() => null);
  if (cyc && cyc.id) {
    cyclePresent = true;
    const jobs = await getSyncSourceJobs(cyc.id);
    const owners = await getSyncSourceJobOwnersForCycle(cyc.id);
    const oliJobs = jobs.filter((j) => (j.source_key ?? j.sourceKey) === "order-line-items");
    cycleOliAssessment = assessScheduledOliCycle({ bucket, discoveredAccounts: discovered, sourceJobs: oliJobs, owners, open: oliJobs.filter((j) => { const st = j.fetch_status ?? j.fetchStatus; return st === "pending" || st === "attempted"; }).length });
  }
  await c.query("ROLLBACK");
} catch (e) { console.error("STOP readiness read failed: " + (e && e.message ? e.message : e)); try { await c.query("ROLLBACK"); } catch { /* ignore */ } await c.end(); process.exit(1); }
finally { try { await c.end(); } catch { /* ignore */ } }

// ASIN-Ads unavailability: the SAME zero-token 3-attempt connection compatibility probe the ads runner uses (a
// consistent miss = Amazon Ads not connected -> typed unavailable, non-blocking; unreadable stays false).
const adsUnavailableByAccountId = {};
for (const id of ids) {
  let outcome = null;
  for (let attempt = 0; attempt < 3 && outcome === null; attempt += 1) {
    try { const names = await fetchCompatibleSourceNames(primaryConn.apiKey, id); outcome = names.has(ASIN_ADS_SOURCE_NAME) ? "compatible" : "incompatible"; }
    catch (_e) { if (attempt < 2) await new Promise((r) => setTimeout(r, 2000)); }
  }
  adsUnavailableByAccountId[id] = outcome === "incompatible";
}

// TWO-LAYER COMPLETENESS: read the provisional/final state the sync recorded for D-1. Under the business override,
// expected pending itemization PUBLISHES provisional (its coverage advanced to D-1) -- it is NOT a not-ready. A
// GENUINE source-defect (an itemized recognized-sale row with a null value) is a HARD STOP: it FAILS CLOSED with a
// typed SOURCE_DEFECT (LKG retained, escalate) -- never masked as provisional, never published.
let provisionalCount = 0, finalCount = 0; const defectIds = new Set();
try {
  const crows = await getOliCompleteness({ organizationFingerprint: orgFp, connectionId: "primary", accountIds: ids, from: requestedAsOf, to: requestedAsOf });
  for (const r of (Array.isArray(crows) ? crows : [])) {
    if (r.completeness_status === "provisional") provisionalCount += 1;
    else if (r.completeness_status === "final") finalCount += 1;
    else if (r.completeness_status === "source-defect") defectIds.add(String(r.account_id));
  }
} catch (e) { log("completeness read failed (non-fatal): " + (e && e.message ? e.message : e)); }
if (defectIds.size > 0) {
  ghOut("status", "SOURCE_DEFECT"); ghOut("run_class", "SOURCE_DEFECT"); ghOut("proceed", "false"); ghOut("effective_asof", ""); ghOut("requested_asof", requestedAsOf);
  ghSum("### D-1 readiness (" + bucket + ")\n- **SOURCE_DEFECT** -- " + defectIds.size + " account(s) have an itemized recognized-sale row with a NULL value at " + requestedAsOf + " (a genuine DataDoe source-data defect)\n- FAIL CLOSED: no publish, LKG retained. Run: node scripts/release/oli-escalation-report.mjs --bucket=" + bucket + " --requested-as-of=" + requestedAsOf);
  console.error("STOP SOURCE_DEFECT (" + bucket + "): " + defectIds.size + " account(s) have a genuine itemized-value defect at " + requestedAsOf + " -- LKG retained, escalate to DataDoe.");
  process.exit(1);
}
const runClass = provisionalCount > 0 ? "D1_PROVISIONAL" : "D1_FINAL";

// PREVIOUS-DAY (D-1) publish gate over ALL accounts: each must have a successfully extracted D-1 window (provisional
// or final -- both advanced coverage to requestedAsOf). An interior gap, blank provenance, or unreadable coverage is
// still a typed DATADOE_D1_NOT_READY (LKG retained). Expected pending itemization is NOT a stop.
const result = assessBucketPublishReadiness({
  bucket, requestedAsOf, from: oliStart, discoveredAccounts: discovered,
  coverageByAccountId, provenanceBlankByAccountId,
  adsCoveredByAccountId, adsFailedByAccountId, adsUnavailableByAccountId,
  cyclePresent, cycleOliAssessment,
  requireD1: true,
});
for (const n of result.notes || []) log("note: " + n);
log("OLI D-1 status=" + result.status + " requested=" + requestedAsOf + " provenThrough=" + (result.provenThrough || "(none)") + " tailLag=" + result.tailLagDays + "d | cycle present=" + cyclePresent + (cycleOliAssessment ? " oli-ok=" + cycleOliAssessment.ok : ""));

ghOut("requested_asof", requestedAsOf);
ghOut("proven_through", result.provenThrough || "");
ghOut("status", result.status);
if (!result.ok) {
  ghOut("proceed", "false");
  ghOut("effective_asof", "");
  const d = result.d1 || {};
  ghSum("### D-1 readiness (" + bucket + ")\n- **DATADOE_D1_NOT_READY** -- requested " + requestedAsOf + ", proven through " + (result.provenThrough || "(none)") + "\n- " + (d.missingCount == null ? "" : d.missingCount + "/" + result.accounts + " account(s) behind D-1") + " -- LKG retained (no publish)\n- reason: " + (d.reason || result.problems.join(", ")));
  console.error("STOP DATADOE_D1_NOT_READY (" + bucket + "): requested " + requestedAsOf + ", proven through " + (result.provenThrough || "(none)") + "; " + (result.d1 && result.d1.missingCount != null ? result.d1.missingCount + " account(s) behind D-1" : result.problems.join(", ")) + " -- LKG retained.");
  process.exit(1);
}
ghOut("effective_asof", result.effectiveAsOf); // === requestedAsOf (D-1 proven)
ghOut("proceed", "true");
ghOut("run_class", runClass);
const classLine = runClass === "D1_FINAL"
  ? "**D1_FINAL** -- all " + result.accounts + " account(s) fully itemized through " + requestedAsOf
  : "**D1_PROVISIONAL** -- " + finalCount + " final + " + provisionalCount + " provisional of " + result.accounts + " account(s) through " + requestedAsOf + " (the real itemized D-1 data publishes now; sales/ratios increase automatically as Amazon itemizes)";
ghSum("### D-1 readiness (" + bucket + ")\n- " + classLine + (defectIds.size ? "\n- **" + defectIds.size + " source-defect account(s)** keep LKG and are excluded from the gate (escalate to DataDoe)" : ""));
log("D-1 READY (" + runClass + "): " + result.accounts + " " + bucket + " accounts publishable through D-1 " + result.effectiveAsOf + "; provisional=" + provisionalCount + " final=" + finalCount + " defect=" + defectIds.size + ".");
process.exit(0);
