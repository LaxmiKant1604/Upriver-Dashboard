// Report Delivery Status -- behavioral tests for the pure shaping/classifier layer + the loader (with injected
// mock readers) + source guards over the endpoint (api/admin/sync.js) and the view (DataSyncCenter.jsx). Proves:
// admin gate + 403, GET performs NO writes/DataDoe/dispatch, default GET + POST/PATCH unchanged, canonical region
// routing (one region per account), dated-D-1 vs date-free freshness semantics, cycle-date mismatch never marks a
// date-free payload stale, missing/malformed never Yes, shadow != published, exact live readback = published,
// partial aggregate K/N, LKG honest, failures-only + dropdowns, api/*.js stays 12, and no
// scheduler/workflow/reconciler/migration modules are imported by the read-only path.
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
process.env.POSTGRES_URL = "postgres://user:pass@localhost:5432/db";
process.env.DATADOE_API_KEY = "test-primary-key";
// Enable the listing-health-v3 live gate so the base loader fixtures include it (a dedicated test toggles it off).
process.env.LHV3_PUBLISH_LIVE = "true";
process.env.LISTING_HEALTH_V3 = "true";

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyExport, classifyReportPublish, aggregatePublish, accountRemark,
  dependentLiveReportsForSource, shapeDeliveryPayload, loadDeliveryStatus,
  normalizeDeliveryRegion, addDaysStr, DELIVERY_SOURCES, DELIVERY_REGIONS, LIVE_PUBLISHABLE_REPORT_KEYS,
  reportHasActiveLivePublisher, NO_LIVE_PUBLISHER_REPORT_KEYS,
} from "../lib/server/delivery-status.js";
import { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } from "../lib/server/sync/report-publisher.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "delivery-status\n");

// ============================ (A) registry-derived source -> dashboard mapping (drift-proof) ============================
{
  const oli = dependentLiveReportsForSource("order-line-items");
  const ads = dependentLiveReportsForSource("ads-campaign-date");
  const fba = dependentLiveReportsForSource("fba-inventory-health");
  const listings = dependentLiveReportsForSource("listings");
  const raw = dependentLiveReportsForSource("listings-raw");
  const cat = dependentLiveReportsForSource("product-catalog");
  // The mapping is the reconciler LINEAGE inverse ∪ fba-plan (for exactly the FBA-inventory / Listings exports fba-plan
  // OWNS) -- which matches the operator's expected families EXACTLY, and excludes derived-only readers (e.g. lhv3 reads
  // OLI/Catalog from durable history, so it is NOT an OLI/Catalog dependent and never drags their aggregate).
  ok("OLI dependents === [brand-inventory, brand-sales, daily-reporting]", oli.join(",") === "brand-inventory,brand-sales,daily-reporting");
  ok("OLI dependents EXCLUDE listing-health-v3 (OLI is derived, not owned, there)", !oli.includes("listing-health-v3"));
  ok("Catalog dependents === [brand-inventory, brand-sales, daily-reporting] (rides OLI lineage)", cat.join(",") === "brand-inventory,brand-sales,daily-reporting");
  ok("Ads dependents === [daily-reporting, ppc-performance]", ads.join(",") === "daily-reporting,ppc-performance");
  ok("FBA Inventory dependents === [brand-inventory, fba-plan] (Brand Inventory + FBA Plan)", fba.join(",") === "brand-inventory,fba-plan");
  ok("Listings dependents === [fba-plan, listing-health-v3] (FBA Plan AWD + LHv3)", listings.join(",") === "fba-plan,listing-health-v3");
  ok("Listings Raw dependents === [listing-health-v3]", raw.join(",") === "listing-health-v3");
  ok("every dependent is a live-publishable report key (no drift outside the contract set)",
    [...oli, ...ads, ...fba, ...listings, ...raw, ...cat].every((k) => LIVE_PUBLISHABLE_REPORT_KEYS.includes(k)));
  ok("dependents are sorted + de-duplicated", JSON.stringify(oli) === JSON.stringify([...new Set(oli)].sort()));
  ok("there are exactly 15 live-publishable report keys", LIVE_PUBLISHABLE_REPORT_KEYS.length === 15);
  ok("the six matrix source columns are OLI/Catalog/Ads/FBA/Listings/Listings-Raw", DELIVERY_SOURCES.map((s) => s.sourceKey).join(",") === "order-line-items,product-catalog,ads-campaign-date,fba-inventory-health,listings,listings-raw");
}

// ============================ (B) classifyExport: fail-closed + dated vs date-free ============================
const RUN_CYCLE = { asOf: "2026-09-14", terminal: true, startedAt: "2026-09-15T16:00:00Z" };
const OPEN_CYCLE = { asOf: "2026-09-14", terminal: false, startedAt: "2026-09-15T16:00:00Z" };
{
  // read failures + schema-missing NEVER become Yes/No.
  ok("read-failed export -> Unavailable (never Yes)", classifyExport({ evidence: { read: "read-failed", present: false, error: "X" }, cycle: RUN_CYCLE, dated: false }).status === "Unavailable");
  ok("schema-missing export (Listings pre-migration) -> Unavailable (never No)", classifyExport({ evidence: { read: "schema-missing", present: false, error: "SCHEMA_MISSING" }, cycle: RUN_CYCLE, dated: false }).status === "Unavailable");
  ok("no evidence object -> Unavailable", classifyExport({ evidence: null, cycle: RUN_CYCLE, dated: false }).status === "Unavailable");

  // DATE-FREE (Listings/Catalog/FBA): present + real validated_at => Yes.
  const freeYes = classifyExport({ evidence: { read: "ok", present: true, validatedAt: "2026-09-15T17:25:00Z", sourceAsOf: null }, cycle: RUN_CYCLE, dated: false });
  ok("date-free present + validated_at -> Yes", freeYes.status === "Yes");
  ok("date-free freshly-validated this cycle -> mode 'validated'", freeYes.mode === "validated");
  ok("date-free present but malformed validated_at -> Unavailable (never a fabricated Yes)", classifyExport({ evidence: { read: "ok", present: true, validatedAt: "not-a-ts", sourceAsOf: null }, cycle: RUN_CYCLE, dated: false }).status === "Unavailable");
  ok("date-free absent + terminal cycle -> No (proven miss)", classifyExport({ evidence: { read: "ok", present: false }, cycle: RUN_CYCLE, dated: false }).status === "No");
  ok("date-free absent + open cycle -> Waiting", classifyExport({ evidence: { read: "ok", present: false }, cycle: OPEN_CYCLE, dated: false }).status === "Waiting");

  // #12: a cycle-date mismatch ALONE does not mark a date-free Listings payload stale.
  const staleLabel = classifyExport({ evidence: { read: "ok", present: true, validatedAt: "2026-09-15T17:25:00Z", sourceAsOf: "2026-09-10" }, cycle: { asOf: "2026-09-14", terminal: true, startedAt: "2026-09-15T16:00:00Z" }, dated: false });
  ok("[#12] date-free payload with an OLDER as_of label but valid validated_at is STILL Yes (label != data date)", staleLabel.status === "Yes");

  // validated-reuse detail (adopted, not newly purchased this cycle).
  const reuse = classifyExport({ evidence: { read: "ok", present: true, validatedAt: "2026-09-15T15:00:00Z", sourceAsOf: null }, cycle: { asOf: "2026-09-14", terminal: true, startedAt: "2026-09-15T16:00:00Z" }, dated: false });
  ok("date-free validated BEFORE the cycle start -> mode 'validated-reuse'", reuse.status === "Yes" && reuse.mode === "validated-reuse");

  // DATED (OLI/Ads): coverage of the cycle D-1 is the proof (#10 dated D-1 evaluated correctly).
  ok("[#10] dated present + coversCycle -> Yes", classifyExport({ evidence: { read: "ok", present: true, coversCycle: true, sourceAsOf: "2026-09-14" }, cycle: RUN_CYCLE, dated: true }).status === "Yes");
  ok("[#10] dated present + does NOT cover D-1 + terminal -> No", classifyExport({ evidence: { read: "ok", present: true, coversCycle: false, sourceAsOf: "2026-09-12" }, cycle: RUN_CYCLE, dated: true }).status === "No");
  ok("[#10] dated present + does NOT cover D-1 + open -> Waiting", classifyExport({ evidence: { read: "ok", present: true, coversCycle: false }, cycle: OPEN_CYCLE, dated: true }).status === "Waiting");
  ok("dated absent + terminal -> No", classifyExport({ evidence: { read: "ok", present: false, coversCycle: false }, cycle: RUN_CYCLE, dated: true }).status === "No");
}

// ============================ (C) publish classifier + aggregate (shadow != live; exact identity; LKG) ============================
const DR_CONTRACT = { liveReportKey: "daily-reporting", liveReportVersion: "daily-reporting-shared-v2" };
{
  ok("meta read failed -> Unavailable (never Yes)", classifyReportPublish({ liveRow: null, contract: DR_CONTRACT, cycleAsOf: "2026-09-14", metaOk: false }).status === "Unavailable");
  ok("no live row + terminal -> No", classifyReportPublish({ liveRow: null, contract: DR_CONTRACT, cycleAsOf: "2026-09-14", metaOk: true, exportPresent: true, cycleTerminal: true }).status === "No");
  ok("no live row + open cycle -> Waiting", classifyReportPublish({ liveRow: null, contract: DR_CONTRACT, cycleAsOf: "2026-09-14", metaOk: true, exportPresent: true, cycleTerminal: false }).status === "Waiting");
  // #14: a row whose reportVersion is not the live contract version (e.g. a shadow snapshotVersion) is NOT published.
  ok("[#14] wrong reportVersion (shadow/other) -> NOT Yes", classifyReportPublish({ liveRow: { reportVersion: "daily-reporting/v2f-campaign", asOf: "2026-09-14" }, contract: DR_CONTRACT, cycleAsOf: "2026-09-14", metaOk: true, cycleTerminal: true }).status !== "Yes");
  // #15: exact live identity (correct version) + fresh as_of => published.
  ok("[#15] correct liveReportVersion + as_of >= cycle -> Yes", classifyReportPublish({ liveRow: { reportVersion: "daily-reporting-shared-v2", asOf: "2026-09-14" }, contract: DR_CONTRACT, cycleAsOf: "2026-09-14", metaOk: true }).status === "Yes");
  // #18: a valid live row with an OLDER as_of is last-known-good retained (honest), NOT Yes for this cycle.
  const lkg = classifyReportPublish({ liveRow: { reportVersion: "daily-reporting-shared-v2", asOf: "2026-09-10" }, contract: DR_CONTRACT, cycleAsOf: "2026-09-14", metaOk: true });
  ok("[#18] valid live row older than the cycle -> Waiting + lkg flag (last-known-good retained)", lkg.status === "Waiting" && lkg.lkg === true);

  // aggregate K/N
  const per3yes = { a: { status: "Yes" }, b: { status: "Yes" }, c: { status: "Yes" } };
  ok("aggregate all-Yes -> Yes N/N", JSON.stringify(aggregatePublish({ dependentReports: ["a", "b", "c"], perReport: per3yes, metaOk: true })) === JSON.stringify({ status: "Yes", count: 3, expected: 3, lkg: false }));
  const perPartial = { a: { status: "Yes" }, b: { status: "Yes" }, c: { status: "No" } };
  const agg = aggregatePublish({ dependentReports: ["a", "b", "c"], perReport: perPartial, metaOk: true });
  ok("[#16] partial publication -> No with 2/3 (never a false aggregate Yes)", agg.status === "No" && agg.count === 2 && agg.expected === 3);
  ok("no dependent reports -> Not applicable", aggregatePublish({ dependentReports: [], perReport: {}, metaOk: true }).status === "Not applicable");
  ok("meta failed -> aggregate Unavailable", aggregatePublish({ dependentReports: ["a"], perReport: {}, metaOk: false }).status === "Unavailable");
}

// ============================ (D) region normalization + date helper ============================
{
  ok("region dropdown offers exactly india/europe-au/us-ca", DELIVERY_REGIONS.map((r) => r.value).join(",") === "india,europe-au,us-ca");
  ok("normalizeDeliveryRegion accepts a valid region", normalizeDeliveryRegion("us-ca") === "us-ca");
  ok("normalizeDeliveryRegion defaults a bad param (never throws)", normalizeDeliveryRegion("mars") === "india");
  ok("addDaysStr computes D-1 in UTC (no timezone drift)", addDaysStr("2026-09-15", -1) === "2026-09-14");
  ok("addDaysStr rejects a malformed date", addDaysStr("nope", -1) === null);
}

// ============================ (E) loader with injected mocks: region isolation, no writes, failures-only, partial ============================
function baseDeps(over = {}) {
  const calls = { reportMetaReportKeys: null };
  const deps = {
    primaryOrganizationFingerprint: () => "org-abc",
    getAccountDirectoryRows: async () => [
      { account_id: "US1", name: "US One", marketplace_country_code: "US", connection_id: "primary" },
      { account_id: "CA1", name: "CA One", marketplace_country_code: "CA", connection_id: "primary" },
      { account_id: "IN1", name: "India One", marketplace_country_code: "IN", connection_id: "primary" },
      { account_id: "GB1", name: "UK One", marketplace_country_code: "GB", connection_id: "primary" },
    ],
    getAccountOnboardingRows: async () => [],
    getRecentSyncCycleIds: async () => ["c1"],
    getSyncCycle: async () => ({ id: "c1", bucket: "us-ca", cycle_date: "2026-09-15", status: "succeeded", started_at: "2026-09-15T16:00:00Z", finished_at: "2026-09-15T17:00:00Z" }),
    getSourceCoverageWindows: async () => ({ windows: [{ from: "2026-08-01", to: "2026-09-14" }], read: "ok", error: null }),
    getSourceSnapshot: async () => ({ snapshot: { validated_at: "2026-09-15T17:00:00Z", row_count: 5 }, read: "ok", error: null }),
    getSourceListingsSnapshot: async () => ({ snapshot: { validated_at: "2026-09-15T17:25:00Z", row_count: 3, as_of: "2026-09-14" }, read: "ok", error: null }),
    getSourceListingsRawSnapshot: async () => ({ snapshot: { validated_at: "2026-09-15T17:25:00Z", row_count: 3, as_of: "2026-09-14" }, read: "ok", error: null }),
    getAdsSyncStates: async () => ["US1", "CA1"].map((acct) => ({ account_id: acct, source_key: "campaign-performance-v1", last_status: "succeeded", latest_metric_date: "2026-09-14", last_daily_sync_at: "2026-09-15T17:00:00Z" })),
    getLatestReportJobLineage: async (reportKey, accountId) => ({ reportKey, accountId, validated: true, latestDataDate: "2026-09-14", cycleStatus: "succeeded" }),
    // Called PER KEY (reportKeys:[oneKey]). Return an EXACT-version live row for the requested key(s) x the queried
    // accounts, at the cycle's as-of -> a healthy publish baseline the failure tests then perturb.
    getReportSnapshotsMeta: async ({ reportKeys, accountIds }) => { calls.metaKeys = (calls.metaKeys || []).concat(reportKeys); return reportKeys.flatMap((rk) => (accountIds || ["US1", "CA1"]).map((acct) => ({ report_key: rk, account_id: acct, params: { reportVersion: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS[rk].liveReportVersion, to: "2026-09-14" }, source_refreshed_at: "2026-09-15T17:00:00Z", updated_at: "2026-09-15T17:05:00Z" }))); },
    now: () => new Date("2026-09-16T00:00:00Z"),
    ...over,
  };
  return { deps, calls };
}

{
  const { deps } = baseDeps();
  const p = await loadDeliveryStatus({ region: "us-ca" }, deps);
  const ids = p.accounts.map((a) => a.accountId).sort();
  ok("[#8/#9] region us-ca contains exactly its canonical accounts (US1, CA1); IN1 + GB1 excluded", ids.join(",") === "CA1,US1");
  const inRegion = await loadDeliveryStatus({ region: "europe-au" }, baseDeps().deps);
  ok("[#9] GB (UK canonicalization) routes to europe-au, not us-ca (one region per account)", inRegion.accounts.map((a) => a.accountId).join(",") === "GB1");
  ok("cycleAsOf = selected cycle_date - 1 (D-1)", p.cycleAsOf === "2026-09-14" && p.cycleDate === "2026-09-15");
  ok("availableCycleDates surfaced for the dropdown", Array.isArray(p.availableCycleDates) && p.availableCycleDates.includes("2026-09-15"));
}

// [#14] the publish read queries ONLY bare live keys (never a scheduler-v2/* shadow key), covering all 15.
{
  const { deps, calls } = baseDeps();
  await loadDeliveryStatus({ region: "us-ca" }, deps);
  const keys = calls.metaKeys || [];
  ok("[#14] getReportSnapshotsMeta queried only BARE live keys (no scheduler-v2/*), covering all 15", keys.length > 0 && keys.every((k) => !String(k).startsWith("scheduler-v2/")) && [...new Set(keys)].length === 15);
}

// [BLOCKER] a per-key publish read that approaches the PostgREST row cap is treated as UNTRUSTWORTHY: that report's
// cells are Unavailable (fail-closed), never a fabricated No from a silently-truncated result.
{
  const truncDeps = baseDeps({
    getReportSnapshotsMeta: async ({ reportKeys, accountIds }) => reportKeys.flatMap((rk) => rk === "daily-reporting"
      ? Array.from({ length: 1000 }, (_, i) => ({ report_key: rk, account_id: (accountIds || ["US1"])[0], params: { reportVersion: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS[rk].liveReportVersion, to: "2026-09-14" }, updated_at: `2026-09-15T00:00:${String(i % 60).padStart(2, "0")}Z` }))
      : (accountIds || []).map((acct) => ({ report_key: rk, account_id: acct, params: { reportVersion: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS[rk].liveReportVersion, to: "2026-09-14" }, updated_at: "2026-09-15T17:05:00Z" }))),
  }).deps;
  const p = await loadDeliveryStatus({ region: "us-ca" }, truncDeps);
  const us1 = p.accounts.find((a) => a.accountId === "US1");
  // daily-reporting is a dependent of OLI; its truncated read -> that report Unavailable -> OLI aggregate is NOT a
  // fabricated all-Yes and the daily-reporting contribution is Unavailable, not a false No.
  ok("[BLOCKER] a near-cap per-key read marks that report Unavailable (fail-closed, not a fabricated No)", p.notes.some((n) => /too large to read safely|could not be completed/i.test(n)) && us1.reports.find((r) => r.sourceKey === "order-line-items").publishStatus !== "Yes");
}

// [#6] a NEWER wrong-version row must NOT mask the correct-live-version row for a (report_key, account).
{
  const dupDeps = baseDeps({
    getReportSnapshotsMeta: async ({ reportKeys, accountIds }) => reportKeys.flatMap((rk) => (accountIds || []).flatMap((acct) => [
      // a NEWER row with a WRONG (shadow) version...
      { report_key: rk, account_id: acct, params: { reportVersion: "SHADOW/" + rk, to: "2026-09-14" }, updated_at: "2026-09-16T00:00:00Z" },
      // ...and an OLDER row with the CORRECT live version.
      { report_key: rk, account_id: acct, params: { reportVersion: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS[rk].liveReportVersion, to: "2026-09-14" }, updated_at: "2026-09-15T00:00:00Z" },
    ])),
  }).deps;
  const p = await loadDeliveryStatus({ region: "us-ca" }, dupDeps);
  const us1 = p.accounts.find((a) => a.accountId === "US1");
  ok("[#6] version-preferred dedup keeps the correct-live-version row over a newer wrong-version row (Publish detected)", us1.reports.find((r) => r.sourceKey === "fba-inventory-health").publicationCount >= 1);
}

// [#5] while the listing-health-v3 live gate is OFF, it is excluded from the Publish universe (its Listings-Raw
// dependent becomes Not applicable, never a fabricated publication failure).
{
  const saved = [process.env.LHV3_PUBLISH_LIVE, process.env.LISTING_HEALTH_V3];
  process.env.LHV3_PUBLISH_LIVE = ""; process.env.LISTING_HEALTH_V3 = "";
  const p = await loadDeliveryStatus({ region: "us-ca" }, baseDeps().deps);
  process.env.LHV3_PUBLISH_LIVE = saved[0]; process.env.LISTING_HEALTH_V3 = saved[1];
  const us1 = p.accounts.find((a) => a.accountId === "US1");
  const raw = us1.reports.find((r) => r.sourceKey === "listings-raw");
  ok("[#5] gated-off listing-health-v3 -> Listings Raw publish is Not applicable (not a false No)", raw.publishStatus === "Not applicable" && !raw.dependentReports.includes("listing-health-v3"));
}

// [#3] a missing/unresolvable cycle as-of never yields a fabricated publish Yes.
{
  const noCycle = classifyReportPublish({ liveRow: { reportVersion: "daily-reporting-shared-v2", asOf: "2026-09-14" }, contract: DR_CONTRACT, cycleAsOf: null, metaOk: true });
  ok("[#3] valid live row but NULL cycleAsOf -> Unavailable (cannot verify currency; never Yes)", noCycle.status === "Unavailable");
}

// [#2] a dated source with no resolvable cycle as-of is never a fabricated export Yes.
{
  ok("[#2] dated present + coversCycle true but caller passed no cycle -> classifier still needs coversCycle", classifyExport({ evidence: { read: "ok", present: true, coversCycle: false }, cycle: { asOf: null, terminal: false }, dated: true }).status !== "Yes");
}

// [#3/#4/#5] the loader deps are READ-ONLY: it is structurally impossible to write/export/dispatch because no writer
// is injected. Assert the deps surface contains only getters and never a writer/dispatcher.
{
  const { deps } = baseDeps();
  const injected = Object.keys(deps);
  ok("[#3] loader receives ONLY read helpers (every dep name starts with get/primary/now)", injected.every((k) => /^(get|primary|now)/.test(k)));
  ok("[#4/#5] no writer/dispatcher is injectable (no set/record/upsert/insert/run/publish/dispatch dep)", injected.every((k) => !/(set|record|upsert|insert|delete|run|publish|dispatch|claim|open|finalize)/i.test(k)));
}

// [#19] failures-only filter.
{
  const badDeps = baseDeps({
    getSourceCoverageWindows: async ({ accountId }) => (accountId === "US1" ? { windows: [{ from: "2026-08-01", to: "2026-09-14" }], read: "ok", error: null } : { windows: [], read: "ok", error: null }),
  }).deps;
  const all = await loadDeliveryStatus({ region: "us-ca", failuresOnly: false }, badDeps);
  const failing = await loadDeliveryStatus({ region: "us-ca", failuresOnly: true }, badDeps);
  ok("[#19] failures-only returns a strict subset (only non-healthy accounts)", failing.accounts.length < all.accounts.length && failing.accounts.every((a) => a.remark !== "Healthy"));
}

// [#21] one account's bad evidence does not crash the page; it degrades to Unavailable while others stay classified.
{
  const partialDeps = baseDeps({
    getLatestReportJobLineage: async (rk, accountId) => { if (accountId === "US1") throw new Error("boom"); return { reportKey: rk, accountId, validated: true, latestDataDate: "2026-09-14" }; },
  }).deps;
  const p = await loadDeliveryStatus({ region: "us-ca" }, partialDeps);
  const us1 = p.accounts.find((a) => a.accountId === "US1");
  const ca1 = p.accounts.find((a) => a.accountId === "CA1");
  ok("[#21] a thrown per-account FBA job read degrades that cell to Unavailable, page still renders", us1.reports.find((r) => r.sourceKey === "fba-inventory-health").exportStatus === "Unavailable" && ca1.reports.find((r) => r.sourceKey === "fba-inventory-health").exportStatus === "Yes");
}

// [#13] org fingerprint unconfigured -> every per-account source Unavailable (never a fabricated Yes/zero).
{
  const noOrg = baseDeps({ primaryOrganizationFingerprint: () => null }).deps;
  const p = await loadDeliveryStatus({ region: "us-ca" }, noOrg);
  ok("[#13] no org identity -> all per-account source evidence Unavailable (never Yes)", p.accounts.every((a) => a.reports.every((r) => r.exportStatus === "Unavailable")) && p.notes.some((n) => /organization identity/i.test(n)));
}

// [#15] full happy path: a correct-version live row with a fresh as_of yields Publish Yes for that report's source.
{
  const p = await loadDeliveryStatus({ region: "us-ca" }, baseDeps().deps);
  const us1 = p.accounts.find((a) => a.accountId === "US1");
  const ads = us1.reports.find((r) => r.sourceKey === "ads-campaign-date");
  // Campaign Ads' live universe is daily-reporting ONLY: ppc-performance is SUPERSEDED (no live publisher) and is
  // excluded from the denominator, so a published daily-reporting yields Publish Yes 1/1 -- never a permanent 1/2.
  ok("[#19] Campaign Ads excludes superseded ppc-performance -> denominator is 1 (daily-reporting only)", ads.publicationExpected === 1 && !ads.dependentReports.includes("ppc-performance") && ads.dependentReports.join(",") === "daily-reporting");
  ok("[#15] a published daily-reporting -> Campaign Ads Publish Yes 1/1 (not a false partial)", ads.publishStatus === "Yes" && ads.publicationCount === 1);
  ok("[#11] Listings uses date-free freshness (present pointer + validated_at) -> Export Yes", us1.reports.find((r) => r.sourceKey === "listings").exportStatus === "Yes");
}

// ============================ (E2) canonical active-connection filter: decommissioned dd-secondary excluded ============================
// The secondary DataDoe connection is decommissioned iff DATADOE_API_KEY_SECONDARY is unset (getDataDoeConnections then
// returns only the primary connection). Its historical `dd-secondary:`-prefixed directory rows must be excluded from
// EVERY region's response + totals, without deleting anything and without a hardcoded id/name/marketplace. The mock
// directory carries one active primary AND one stale dd-secondary account per region.
function secondaryDeps() {
  return baseDeps({
    getAccountDirectoryRows: async () => [
      // Active PRIMARY accounts (one per region).
      { account_id: "US1", name: "US One", marketplace_country_code: "US", connection_id: "primary" },
      { account_id: "IN1", name: "India One", marketplace_country_code: "IN", connection_id: "primary" },
      { account_id: "DE1", name: "DE One", marketplace_country_code: "DE", connection_id: "primary" },
      // Stale dd-secondary accounts (one per region) from the decommissioned connection -- prefix intact, connection "secondary".
      { account_id: "dd-secondary:US9", name: "US Nine (Secondary DataDoe)", marketplace_country_code: "US", connection_id: "secondary" },
      { account_id: "dd-secondary:IN9", name: "India Nine (Secondary DataDoe)", marketplace_country_code: "IN", connection_id: "secondary" },
      { account_id: "dd-secondary:DE9", name: "DE Nine (Secondary DataDoe)", marketplace_country_code: "DE", connection_id: "secondary" },
    ],
  }).deps;
}
{
  const savedSecondary = process.env.DATADOE_API_KEY_SECONDARY;
  delete process.env.DATADOE_API_KEY_SECONDARY; // connection decommissioned
  const us = await loadDeliveryStatus({ region: "us-ca" }, secondaryDeps());
  const inR = await loadDeliveryStatus({ region: "india" }, secondaryDeps());
  const eu = await loadDeliveryStatus({ region: "europe-au" }, secondaryDeps());
  const idsOf = (p) => p.accounts.map((a) => a.accountId).sort();
  const noSecondary = (p) => p.accounts.every((a) => !String(a.accountId).startsWith("dd-secondary:"));
  ok("[#1] US/Canada: decommissioned dd-secondary excluded (only the primary account remains)", idsOf(us).join(",") === "US1" && noSecondary(us));
  ok("[#1] India: decommissioned dd-secondary excluded", idsOf(inR).join(",") === "IN1" && noSecondary(inR));
  ok("[#2] Europe/Australia: decommissioned dd-secondary excluded", idsOf(eu).join(",") === "DE1" && noSecondary(eu));
  ok("[#4] secondary accounts do not affect regional totals (accountCount counts only the active primary)", us.summary.accountCount === 1 && inR.summary.accountCount === 1 && eu.summary.accountCount === 1);
  ok("[#4] a safe note reports the count excluded (no id/name/marketplace leaked)", us.notes.some((n) => /decommissioned DataDoe connection are excluded/.test(n) && !/dd-secondary|US9|Secondary DataDoe/.test(n)));
  ok("[#8] no hardcoded account id/name/marketplace anywhere in the exclusion path (module source)", (() => { const mod = readFileSync(path.join(root, "lib", "server", "delivery-status.js"), "utf8"); return !/US9|IN9|DE9|dd-secondary:US|Secondary DataDoe/.test(mod); })());

  // [#7] Re-enabling the canonical connection (a DIFFERENT secondary key) makes its valid accounts eligible again.
  process.env.DATADOE_API_KEY_SECONDARY = "test-secondary-key-distinct";
  const usReenabled = await loadDeliveryStatus({ region: "us-ca" }, secondaryDeps());
  ok("[#7] re-enabling DATADOE_API_KEY_SECONDARY makes the dd-secondary account eligible again (registry-driven)", idsOf(usReenabled).join(",") === "US1,dd-secondary:US9");
  if (savedSecondary === undefined) delete process.env.DATADOE_API_KEY_SECONDARY; else process.env.DATADOE_API_KEY_SECONDARY = savedSecondary;
}

// ============================ (E3) source-specific safe remarks + honest FBA Export-No / Publish-Yes ============================
{
  // OLI coverage fails to reach D-1 for US1 (terminal cycle) -> a SPECIFIC "Order Line Items export failed (code)"
  // remark, never the generic "Source export failed".
  const oliMissDeps = baseDeps({
    getSourceCoverageWindows: async ({ accountId }) => (accountId === "US1"
      ? { windows: [{ from: "2026-08-01", to: "2026-09-12" }], read: "ok", error: null }   // stops at D-3, misses D-1
      : { windows: [{ from: "2026-08-01", to: "2026-09-14" }], read: "ok", error: null }),
  }).deps;
  const p = await loadDeliveryStatus({ region: "us-ca" }, oliMissDeps);
  const us1 = p.accounts.find((a) => a.accountId === "US1");
  const oli = us1.reports.find((r) => r.sourceKey === "order-line-items");
  ok("[#7-fail] OLI D-1 miss -> Export No with a specific safe code (D1_COVERAGE_MISSING)", oli.exportStatus === "No" && oli.safeCode === "D1_COVERAGE_MISSING");
  ok("[#7-fail] remark names the SPECIFIC source + code, never the generic 'Source export failed'", us1.remark === "Order Line Items export failed (D1_COVERAGE_MISSING)" && us1.remark !== "Source export failed");

  // [#20] FBA contradictory Export No / Publish Yes: this cycle's fba-plan job did not validate (Export No), yet the
  // brand-inventory/fba-plan live snapshots are current (Publish Yes -- retained/current from an earlier attempt). Both
  // are classified honestly and independently, and the account remark surfaces the actionable FBA export failure.
  const fbaContradictionDeps = baseDeps({
    getLatestReportJobLineage: async (rk, accountId) => (accountId === "US1"
      ? { reportKey: rk, accountId, validated: false, latestDataDate: null }   // FBA export did NOT validate this cycle
      : { reportKey: rk, accountId, validated: true, latestDataDate: "2026-09-14" }),
    // brand-inventory + fba-plan live snapshots are still CURRENT (as_of == cycle as-of) for US1 -> Publish Yes.
  }).deps;
  const q = await loadDeliveryStatus({ region: "us-ca" }, fbaContradictionDeps);
  const us1b = q.accounts.find((a) => a.accountId === "US1");
  const fba = us1b.reports.find((r) => r.sourceKey === "fba-inventory-health");
  ok("[#20] FBA Export No is classified (job not validated) with a safe code, never a fabricated Yes", fba.exportStatus === "No" && fba.safeCode === "SOURCE_EVIDENCE_MISSING");
  ok("[#20] FBA Publish stays Yes independently (retained/current live snapshot) -- the contradiction is shown, not hidden", fba.publishStatus === "Yes" && fba.publicationExpected === 2);
  ok("[#20] the account remark honestly surfaces the FBA export failure (specific, not generic)", us1b.remark === "FBA Inventory export failed (SOURCE_EVIDENCE_MISSING)");
}

// ============================ (E4) reportHasActiveLivePublisher: registry-derived, superseded ppc excluded ============================
{
  ok("[#19] reportHasActiveLivePublisher(daily-reporting) === true (per-region-daily live publisher)", reportHasActiveLivePublisher("daily-reporting") === true);
  ok("[#19] reportHasActiveLivePublisher(brand-inventory/brand-sales/fba-plan) === true", ["brand-inventory", "brand-sales", "fba-plan"].every((k) => reportHasActiveLivePublisher(k) === true));
  ok("[#19] reportHasActiveLivePublisher(ppc-performance) === false (superseded; no live publisher)", reportHasActiveLivePublisher("ppc-performance") === false);
  ok("[#19] NO_LIVE_PUBLISHER_REPORT_KEYS includes ppc-performance + listing-health-v3, excludes the live 4", NO_LIVE_PUBLISHER_REPORT_KEYS.includes("ppc-performance") && NO_LIVE_PUBLISHER_REPORT_KEYS.includes("listing-health-v3") && ["brand-inventory", "brand-sales", "daily-reporting", "fba-plan"].every((k) => !NO_LIVE_PUBLISHER_REPORT_KEYS.includes(k)));
}

// ============================ (F) endpoint source guards: admin gate, GET-only, no writes on the delivery path ============================
{
  const sync = readFileSync(path.join(root, "api", "admin", "sync.js"), "utf8");
  ok("[#2] endpoint asserts admin before any branch (getDashboardAccess + assertAdmin)", /const access = await getDashboardAccess\(req\)/.test(sync) && /assertAdmin\(access\)/.test(sync));
  ok("delivery branch is GET-only + gated on view=delivery", /req\.method === "GET"[\s\S]*req\.query\?\.view[\s\S]*=== "delivery"[\s\S]*loadDeliveryStatus/.test(sync));
  ok("[#1] delivery branch calls loadDeliveryStatus with read helpers", /loadDeliveryStatus\(/.test(sync));
  // The delivery GET path must not write: the audit/dispatch/set writers appear only in the POST/PATCH branches.
  ok("[#3] the GET/delivery path performs no audit write (insertAuditLog only in PATCH/POST)", (() => { const getIdx = sync.indexOf('if (String(req.query?.view'); const postIdx = sync.indexOf("const body = bodyFor(req)"); return getIdx > 0 && postIdx > getIdx && sync.slice(getIdx, postIdx).indexOf("insertAuditLog") === -1; })());
  ok("[#5] the GET/delivery path never dispatches (runScheduledSync only in POST manual-run)", (() => { const getIdx = sync.indexOf('if (String(req.query?.view'); const postIdx = sync.indexOf("const body = bodyFor(req)"); return sync.slice(getIdx, postIdx).indexOf("runScheduledSync") === -1; })());
  ok("[#6] the default GET response (statusPayload) is preserved", /res\.status\(200\)\.json\(await statusPayload\(\)\);/.test(sync));
  ok("[#7] POST manual-run + PATCH settings branches are unchanged (setReportSyncSetting/runScheduledSync/setSourcePromotedPublishControl still present)", /setReportSyncSetting\(/.test(sync) && /runScheduledSync\(/.test(sync) && /setSourcePromotedPublishControl\(/.test(sync));
}

// [#23] api/*.js stays exactly 12 (Vercel Hobby cap).
{
  const countApi = (dir) => readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? countApi(path.join(dir, e.name)) : (e.name.endsWith(".js") ? 1 : 0)), 0);
  ok("[#23] api/*.js remains exactly 12 (no new serverless function added)", countApi(path.join(root, "api")) === 12);
}

// [#24] the read-only delivery module imports NO scheduler/reconciler/run-sync/migration transport module.
{
  const mod = readFileSync(path.join(root, "lib", "server", "delivery-status.js"), "utf8");
  const imports = [...mod.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  ok("[#24] delivery-status.js imports no reconciler/run-sync/publisher-writer/scheduler-runtime module", imports.every((s) => !/reconcile|run-sync|source-bucket-sync-runtime|priority-dashboards-release|-release\.js|migrat/i.test(s)));
  ok("[#24] delivery-status.js imports no supabase transport (readers are injected)", imports.every((s) => !/\/supabase\.js$/.test(s)));
}

// ============================ (G) UI source guards: icon+text status, read-only, dropdowns, mobile scroll, hooks ============================
{
  const view = readFileSync(path.join(root, "src", "views", "DataSyncCenter.jsx"), "utf8");
  ok("[#20] region + cycle dropdowns + failures-only toggle + reload button present", /DELIVERY_REGION_OPTIONS/.test(view) && /Latest completed/.test(view) && /Failures only/.test(view) && /Reload status/.test(view));
  ok("status is icon + TEXT (never colour alone): DeliveryChip renders an icon and the status text", /function DeliveryChip/.test(view) && /<Icon size=\{13\} aria-hidden/.test(view) && /\{prefix\}: \{status\}/.test(view));
  ok("status icons imported (CheckCircle2/XCircle/Clock/AlertTriangle/MinusCircle)", /CheckCircle2/.test(view) && /XCircle/.test(view) && /Clock/.test(view) && /AlertTriangle/.test(view) && /MinusCircle/.test(view));
  ok("[#22] the matrix table is wrapped for horizontal scroll (delivery-table-wrap)", /delivery-table-wrap/.test(view));
  ok("[#21] loading / empty / error states render", /Loading delivery status/.test(view) && /No accounts to show/.test(view) && /Delivery status unavailable/.test(view));
  ok("delivery section is READ-ONLY: it fetches view=delivery via GET and never POST/PATCH", /adminFetch\(`\/api\/admin\/sync\?\$\{qs\.toString\(\)\}`, accessToken\)/.test(view) && !/method:\s*"POST"[\s\S]{0,120}view=delivery/.test(view));
  // hooks-before-return guard: all delivery hooks are declared in the top hook block (before the JSX return).
  // DataSyncCenter is the LAST component in the file, so its main JSX return is the last "return (".
  const retIdx = view.lastIndexOf("return (");
  ok("[#20] all delivery useState/useCallback/useEffect hooks precede the single return (Rules of Hooks)", ["const [showDelivery", "const [delivery", "const loadDelivery = useCallback", "useEffect(() => { if (showDelivery)"].every((s) => { const i = view.indexOf(s); return i > 0 && i < retIdx; }));
}

writeSync(1, `\ndelivery-status: ${passed} assertions passed\n`);
