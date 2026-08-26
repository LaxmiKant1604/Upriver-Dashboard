// TRUSTED, READ-ONLY US prerequisite verifier. Usage (run from sales-dashboard-live/, FIRST in the US job):
//   node scripts/release/verify-scheduled-prerequisites.mjs [--as-of=YYYY-MM-DD]
//
// Proves (READ ONLY) that a SUCCESSFUL same-asOf Non-US scheduled run left ALL 22 Non-US primary accounts ready
// for the US derive, BEFORE any US token gate / OLI / ASIN Ads / control write:
//   1. gapless durable OLI coverage through asOf;  2. nonblank OLI provenance;  3. complete ASIN-Ads coverage for
//   the exact 21-day window;  4. no failed/open scheduled source work;  5. exact account/owner isolation;
//   6. the (non-us, asOf+1) scheduled OLI cycle is a COMPLETE run (assessScheduledOliCycle over its OLI jobs).
// Exit 0 = ready; nonzero = US must STOP before creates + controls. Prints counts/dates/prefixes only.

import pg from "pg";
import { loadReleaseEnv } from "./env-bootstrap.mjs";

loadReleaseEnv();

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const asOf = argOf("as-of") || (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) { console.error("STOP --as-of must be YYYY-MM-DD (got: " + asOf + ")"); process.exit(2); }
const addDays = (ymd, n) => { const d = new Date(`${ymd}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const cycleDate = addDays(asOf, 1);
const adsFrom = addDays(asOf, -20); const adsTo = asOf;

const { getDataDoeConnections, classifyDirectoryAccounts } = await import("../../lib/server/datadoe-connections.js");
const { fetchAccounts, fetchCompatibleSourceNames } = await import("../../lib/server/datadoe.js");
const { ASIN_ADS_SOURCE_NAME } = await import("../../lib/server/sync/scheduled-asin-ads-runner.js");
const { bucketForCountry } = await import("../../lib/server/sync/registry.js");
const { getSyncCycleByBucketDate, getSyncSourceJobs, getSyncSourceJobOwnersForCycle, getSourceCoverageWindows } = await import("../../lib/server/supabase.js");
const { assessScheduledOliCycle } = await import("../../lib/server/sync/source-scheduled-oli.js");
const { assessNonUsPrerequisites } = await import("../../lib/server/sync/source-scheduled-prerequisites.js");
const { windowsProve, mergeCoverageWindows } = await import("../../lib/server/sync/source-durable-model.js");
const { sourceRegistryEntry } = await import("../../lib/server/sync/source-registry.js");
const { organizationFingerprint } = await import("../../lib/server/source-identity.js");

const log = (m) => console.log("verify-prereq[asOf=" + asOf + "]: " + m);

// discover the 22 Non-US primary accounts
const connections = getDataDoeConnections();
const primaryConn = connections.find((c) => c.id === "primary");
const rows = (await fetchAccounts(primaryConn.apiKey)) || [];
const { active } = classifyDirectoryAccounts(rows, connections);
const seen = new Set();
const nonus = [];
for (const a of active) { const id = String((a && (a.accountId ?? a.id)) || "").trim(); const country = String((a && a.country) || "").toUpperCase(); if (!id || id.includes(":") || seen.has(id)) continue; if (bucketForCountry(country) !== "non-us") continue; seen.add(id); nonus.push({ accountId: id }); }
if (!nonus.length) { console.error("STOP no discovered Non-US primary accounts"); process.exit(1); }
const ids = nonus.map((a) => a.accountId);
log(nonus.length + " Non-US primary accounts; ASIN-Ads window [" + adsFrom + ".." + adsTo + "]; Non-US cycle date " + cycleDate);

const base = String(process.env.POSTGRES_URL).split("?")[0];
const c = new pg.Client({ connectionString: base, ssl: { rejectUnauthorized: false } });
const q = (t, p) => c.query(t, p);
await c.connect();
let perAccount = []; let cyclePresent = false; let cycleOliAssessment = null;
try {
  await q("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  // OLI history provenance per account. History ROWS are sales facts only -- a fetched window with zero rows is
  // PROOF OF ZERO SALES, so coverage/gaplessness comes from source_coverage windows (below), NEVER max(sale_date)
  // (a sparse-sales account would read "short" forever). Rows that DO exist must carry provenance hashes; an
  // account with no rows passes provenance vacuously (its windows are the durable proof).
  const oli = (await q("select account_id, count(*) filter(where source_request_hash is null or btrim(source_request_hash)='')::int blank_prov from public.source_oli_daily_history where account_id = any($1::text[]) group by 1", [ids])).rows;
  const oliMap = new Map(oli.map((r) => [String(r.account_id), r]));
  // ASIN-Ads coverage per account (does a succeeded window prove [adsFrom, adsTo]?)
  const ads = (await q("select account_id, min(covered_from)::text cf, max(covered_to)::text ct from public.ads_sync_coverage where source_key='asin-performance-v1' and status='succeeded' and account_id = any($1::text[]) group by 1", [ids])).rows;
  const adsMap = new Map(ads.map((r) => [String(r.account_id), r]));
  // failed ASIN-Ads state per account
  const adsState = (await q("select account_id, last_status from public.ads_sync_state where source_key='asin-performance-v1' and account_id = any($1::text[])", [ids])).rows;
  const adsFailedSet = new Set(adsState.filter((r) => String(r.last_status) === "failed").map((r) => String(r.account_id)));

  // Durable OLI coverage per account: the source_coverage WINDOWS proven by the same merge/containment model the
  // scheduler classifier uses (windowsProve over [initialBackfill.start .. asOf]). Overlapping/adjacent windows
  // merge; the CONTIGUOUS-from-start prefix end is the honest covered_to when the proof fails.
  const oliStart = sourceRegistryEntry("order-line-items").initialBackfill.start;
  const orgFp = primaryConn.organizationFingerprint || organizationFingerprint(primaryConn.apiKey);
  const coverageById = new Map();
  for (const id of ids) {
    const cov = await getSourceCoverageWindows({ organizationFingerprint: orgFp, connectionId: "primary", accountId: id, sourceKey: "order-line-items" });
    coverageById.set(id, cov && cov.read === "ok" ? (cov.windows || []) : null); // null = unreadable (fail closed)
  }

  // ASIN-Ads connection compatibility (the SAME zero-token pre-flight the ads runner uses: 3 attempts; a
  // consistent miss = Amazon Ads not connected -> TYPED UNAVAILABLE, noted downstream, never a blocker;
  // unreadable stays false so the ads checks fail closed).
  const adsUnavailableById = new Map();
  for (const id of ids) {
    let outcome = null;
    for (let attempt = 0; attempt < 3 && outcome === null; attempt += 1) {
      try {
        const names = await fetchCompatibleSourceNames(primaryConn.apiKey, id);
        outcome = names.has(ASIN_ADS_SOURCE_NAME) ? "compatible" : "incompatible";
      } catch (_e) { if (attempt < 2) await new Promise((r) => setTimeout(r, 2000)); }
    }
    adsUnavailableById.set(id, outcome === "incompatible");
  }

  perAccount = ids.map((id) => {
    const o = oliMap.get(id);
    const ad = adsMap.get(id);
    const windows = coverageById.get(id);
    let oliCoveredTo = null; let oliGapless = false;
    if (Array.isArray(windows)) {
      try {
        const merged = mergeCoverageWindows(windows);
        const fromStart = merged.find((w) => w.from <= oliStart);
        oliCoveredTo = fromStart ? fromStart.to : null;
        oliGapless = windowsProve(windows, oliStart, asOf) === true;
      } catch { oliCoveredTo = null; oliGapless = false; } // malformed windows fail closed
    }
    return {
      accountId: id,
      oliCoveredTo,
      oliGapless,
      oliProvenanceOk: !o || Number(o.blank_prov) === 0, // rows that exist must carry hashes; zero rows = vacuous
      oliFailedOrOpen: false, // set below from the cycle
      adsWindowCovered: Boolean(ad && ad.cf && ad.ct && ad.cf <= adsFrom && ad.ct >= adsTo),
      adsFailed: adsFailedSet.has(id),
      adsUnavailable: adsUnavailableById.get(id) === true,
    };
  });

  // the (non-us, cycleDate) scheduled OLI cycle evidence
  const cyc = await getSyncCycleByBucketDate("non-us", cycleDate).catch(() => null);
  if (cyc && cyc.id) {
    cyclePresent = true;
    const jobs = await getSyncSourceJobs(cyc.id);
    const owners = await getSyncSourceJobOwnersForCycle(cyc.id);
    const oliJobs = jobs.filter((j) => (j.source_key ?? j.sourceKey) === "order-line-items");
    // any failed/open OLI job -> mark accounts (coarse: block if the cycle has any failed/open OLI)
    const anyFailedOrOpen = oliJobs.some((j) => { const st = j.fetch_status ?? j.fetchStatus; return st === "failed" || st === "pending" || st === "attempted"; });
    if (anyFailedOrOpen) for (const p of perAccount) p.oliFailedOrOpen = true;
    cycleOliAssessment = assessScheduledOliCycle({ bucket: "non-us", discoveredAccounts: nonus, sourceJobs: oliJobs, owners, open: oliJobs.filter((j) => { const st = j.fetch_status ?? j.fetchStatus; return st === "pending" || st === "attempted"; }).length });
  }
  await q("ROLLBACK");
} catch (e) { console.error("STOP prerequisite read failed: " + (e && e.message ? e.message : e)); try { await q("ROLLBACK"); } catch { /* ignore */ } await c.end(); process.exit(1); }
finally { try { await c.end(); } catch { /* ignore */ } }

const covOli = perAccount.filter((p) => p.oliGapless && p.oliProvenanceOk).length;
const covAds = perAccount.filter((p) => p.adsWindowCovered).length;
log("OLI ready (covered_to>=asOf + provenance): " + covOli + "/" + ids.length + " | ASIN-Ads window covered: " + covAds + "/" + ids.length + " | Non-US cycle present=" + cyclePresent + (cycleOliAssessment ? " oli-ok=" + cycleOliAssessment.ok : ""));

const result = assessNonUsPrerequisites({ asOf, discoveredAccounts: nonus, perAccount, cyclePresent, cycleOliAssessment });
for (const n of result.notes || []) log("note: " + n);
if (!result.ok) {
  console.error("STOP NON_US_PREREQUISITES_INCOMPLETE (US must not create or open controls): " + result.problems.join(", "));
  process.exit(1);
}
log("READY: all " + result.accounts + " Non-US accounts have complete OLI + ASIN-Ads coverage and a completed Non-US OLI cycle for asOf " + asOf + ". US may proceed.");
process.exit(0);
