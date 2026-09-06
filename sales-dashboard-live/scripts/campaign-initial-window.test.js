// Campaign Ads bootstrap window -- a NEVER-covered (new) account gets the INITIAL 56-inclusive-day
// window; every account with prior coverage stays on the rolling 21-day window; after the initial
// window completes the SAME account rolls at 21 days. Fully offline. 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import {
  planCampaignAdsRegionRun, runCampaignAdsRegionSlice, campaignAdsWindow, CAMPAIGN_ADS_GRAIN,
} from "../lib/server/sync/scheduled-campaign-ads-runner.js";
import { CAMPAIGN_WINDOWS } from "../lib/server/sync/campaign-region-routing.js";

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); };
writeSync(1, "campaign-initial-window\n");

const ASOF = "2026-09-05"; // the scheduler's D-1
const DAILY = campaignAdsWindow(ASOF, "daily");     // 21 inclusive days
const INITIAL = campaignAdsWindow(ASOF, "initial"); // 56 inclusive days

ok("window math: daily = 21 inclusive days ending at asOf", DAILY.from === "2026-08-16" && DAILY.to === ASOF && DAILY.days === CAMPAIGN_WINDOWS.dailyDays);
ok("window math: initial = 56 inclusive days ending at asOf", INITIAL.from === "2026-07-12" && INITIAL.to === ASOF && INITIAL.days === CAMPAIGN_WINDOWS.initialDays);

// Offline deps: three india accounts -- A fully covered (daily window proven), B partially covered
// (has history, misses the window), C NEVER covered (a NEW account).
const routed = {
  primaryConn: { id: "primary", apiKey: "fixture-key" },
  accounts: [], unassigned: [],
  byRegion: {
    india: [
      { accountId: "acct-covered", marketplace: "IN" },
      { accountId: "acct-partial", marketplace: "IN" },
      { accountId: "acct-new", marketplace: "IN" },
    ],
    "europe-au": [], "us-ca": [],
  },
};
const coverage = {
  "acct-covered": { read: "ok", status: "succeeded", windows: [{ from: "2026-01-01", to: ASOF }] },
  "acct-partial": { read: "ok", status: "succeeded", windows: [{ from: "2026-01-01", to: "2026-08-20" }] },
  "acct-new": { read: "ok", status: "missing", windows: [] },
};
const deps = {
  fetchCompatibleSourceNames: async () => new Set(["ad performance by campaign & date"]),
  getCoverage: async (accountId) => coverage[accountId],
};

const plan = await planCampaignAdsRegionRun({ region: "india", asOf: ASOF, runKind: "daily", routed, deps });
ok("plan: the covered account needs zero creates", plan.covered.map((a) => a.accountId).join(",") === "acct-covered");
ok("plan: the partially-covered account stays on the ROLLING window (pending)", plan.pending.map((a) => a.accountId).join(",") === "acct-partial");
ok("plan: the NEVER-covered account is initialPending (bootstrap history)", plan.initialPending.map((a) => a.accountId).join(",") === "acct-new");
ok("plan: initialWindow is the 56-day window ending at the same asOf", plan.initialWindow.from === INITIAL.from && plan.initialWindow.to === ASOF);

// Run the slice with an instrumented worker: capture each batch's requiredCoverage window.
const calls = [];
const sliceDeps = {
  ...deps,
  createExport: async () => { throw new Error("never reached: the stub worker performs no create"); },
  runAdsSyncWithDeps: async (_wd, _countries, grains, opts) => {
    calls.push({ ids: [...opts.accountIds], from: opts.requiredCoverage.from, to: opts.requiredCoverage.to, grains });
    return { status: "completed", coverageComplete: true, successfulCoveragePairs: 1, expectedCoveragePairs: 1, sources: { [CAMPAIGN_ADS_GRAIN]: { failedAccounts: [], coverageFailedAccounts: [] } } };
  },
};
const result = await runCampaignAdsRegionSlice({ region: "india", asOf: ASOF, runKind: "daily", plan, deps: sliceDeps });
ok("slice: two batches ran (one rolling, one initial) and completed", result.phase === "complete" && calls.length === 2);
const rollingCall = calls.find((c) => c.ids.includes("acct-partial"));
const initialCall = calls.find((c) => c.ids.includes("acct-new"));
ok("slice: the rolling batch requires the 21-day window", rollingCall && rollingCall.from === DAILY.from && rollingCall.to === ASOF);
ok("slice: the NEW account's batch requires the INITIAL 56-day window", initialCall && initialCall.from === INITIAL.from && initialCall.to === ASOF);
ok("slice: the two window kinds never share a batch", !calls.some((c) => c.ids.includes("acct-partial") && c.ids.includes("acct-new")));

// AFTER the initial window completes, coverage exists -> the SAME account rolls at 21 days.
coverage["acct-new"] = { read: "ok", status: "succeeded", windows: [{ from: INITIAL.from, to: ASOF }] };
const nextAsOf = "2026-09-06";
const plan2 = await planCampaignAdsRegionRun({ region: "india", asOf: nextAsOf, runKind: "daily", routed, deps });
ok("follow-up: after the initial completes, the account is NO LONGER initialPending (rolling from now on)",
  plan2.initialPending.length === 0 && plan2.pending.some((a) => a.accountId === "acct-new"));
const calls2 = [];
const result2 = await runCampaignAdsRegionSlice({ region: "india", asOf: nextAsOf, runKind: "daily", plan: plan2, deps: {
  ...deps,
  runAdsSyncWithDeps: async (_wd, _c, _g, opts) => {
    calls2.push({ ids: [...opts.accountIds], from: opts.requiredCoverage.from, to: opts.requiredCoverage.to });
    return { status: "completed", coverageComplete: true, successfulCoveragePairs: 1, expectedCoveragePairs: 1, sources: { [CAMPAIGN_ADS_GRAIN]: { failedAccounts: [], coverageFailedAccounts: [] } } };
  },
} });
const rollNew = calls2.find((c) => c.ids.includes("acct-new"));
ok("follow-up: the graduated account now refreshes with the ROLLING 21-day window",
  result2.phase === "complete" && rollNew && rollNew.from === campaignAdsWindow(nextAsOf, "daily").from && rollNew.to === nextAsOf);

// An UNREADABLE coverage row is never treated as never-covered (no accidental 56-day fetch).
coverage["acct-partial"] = { read: "read-failed", windows: [] };
const plan3 = await planCampaignAdsRegionRun({ region: "india", asOf: nextAsOf, runKind: "daily", routed, deps });
ok("guard: an UNREADABLE coverage read lands in the rolling pending set (never the 56-day initial set)",
  plan3.pending.some((a) => a.accountId === "acct-partial") && !plan3.initialPending.some((a) => a.accountId === "acct-partial"));

writeSync(1, `\ncampaign-initial-window: ${passed} assertions passed\n`);
