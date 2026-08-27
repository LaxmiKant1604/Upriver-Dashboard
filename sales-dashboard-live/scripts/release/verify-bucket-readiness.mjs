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

loadReleaseEnv();

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const bucket = argOf("bucket");
if (bucket !== "us" && bucket !== "non-us") { console.error("STOP --bucket must be us|non-us (got: " + bucket + ")"); process.exit(2); }
const requestedAsOf = argOf("requested-as-of") || argOf("as-of") || (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedAsOf)) { console.error("STOP --requested-as-of must be YYYY-MM-DD (got: " + requestedAsOf + ")"); process.exit(2); }
const addDays = (ymd, n) => { const d = new Date(`${ymd}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const cycleDate = addDays(requestedAsOf, 1);
const adsFrom = addDays(requestedAsOf, -20); const adsTo = requestedAsOf;

const { getDataDoeConnections, classifyDirectoryAccounts } = await import("../../lib/server/datadoe-connections.js");
const { fetchAccounts, fetchCompatibleSourceNames } = await import("../../lib/server/datadoe.js");
const { ASIN_ADS_SOURCE_NAME } = await import("../../lib/server/sync/scheduled-asin-ads-runner.js");
const { bucketForCountry } = await import("../../lib/server/sync/registry.js");
const { getSyncCycleByBucketDate, getSyncSourceJobs, getSyncSourceJobOwnersForCycle, getSourceCoverageWindows } = await import("../../lib/server/supabase.js");
const { assessScheduledOliCycle } = await import("../../lib/server/sync/source-scheduled-oli.js");
const { assessBucketPublishReadiness } = await import("../../lib/server/sync/source-scheduled-prerequisites.js");
const { sourceRegistryEntry } = await import("../../lib/server/sync/source-registry.js");
const { organizationFingerprint } = await import("../../lib/server/source-identity.js");

const log = (m) => console.log("verify-readiness[" + bucket + "@" + requestedAsOf + "]: " + m);
const ghOut = (k, v) => { const f = process.env.GITHUB_OUTPUT; if (f) { try { appendFileSync(f, k + "=" + v + "\n"); } catch { /* ignore */ } } };

// discover EXACTLY this bucket's primary accounts (zero tokens)
const connections = getDataDoeConnections();
const primaryConn = connections.find((c) => c.id === "primary");
const rows = (await fetchAccounts(primaryConn.apiKey)) || [];
const { active } = classifyDirectoryAccounts(rows, connections);
const seen = new Set();
const discovered = [];
for (const a of active) { const id = String((a && (a.accountId ?? a.id)) || "").trim(); const country = String((a && a.country) || "").toUpperCase(); if (!id || id.includes(":") || seen.has(id)) continue; if (bucketForCountry(country) !== bucket) continue; seen.add(id); discovered.push({ accountId: id }); }
if (!discovered.length) { console.error("STOP no discovered " + bucket + " primary accounts"); process.exit(1); }
const ids = discovered.map((a) => a.accountId);
log(discovered.length + " primary accounts; ASIN-Ads window [" + adsFrom + ".." + adsTo + "]; cycle date " + cycleDate);

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

const result = assessBucketPublishReadiness({
  bucket, requestedAsOf, from: oliStart, discoveredAccounts: discovered,
  coverageByAccountId, provenanceBlankByAccountId,
  adsCoveredByAccountId, adsFailedByAccountId, adsUnavailableByAccountId,
  cyclePresent, cycleOliAssessment,
});
for (const n of result.notes || []) log("note: " + n);
log("OLI honest effectivePublishAsOf=" + (result.effectiveAsOf || "(none)") + " status=" + result.status + " tailLag=" + result.tailLagDays + "d | cycle present=" + cyclePresent + (cycleOliAssessment ? " oli-ok=" + cycleOliAssessment.ok : ""));

ghOut("requested_asof", requestedAsOf);
if (!result.ok) {
  ghOut("proceed", "false");
  console.error("STOP BUCKET_NOT_PUBLISHABLE (" + bucket + "): " + result.problems.join(", "));
  process.exit(1);
}
ghOut("effective_asof", result.effectiveAsOf);
ghOut("status", result.status);
ghOut("proceed", "true");
log("READY: " + result.accounts + " " + bucket + " accounts publishable through effectivePublishAsOf " + result.effectiveAsOf + " (" + result.status + ").");
process.exit(0);
