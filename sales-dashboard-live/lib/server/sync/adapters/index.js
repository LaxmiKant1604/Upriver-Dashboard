// Adapter build-function map for enabled report adapters.
//
// Only the orchestrator imports this (it pulls in api/datadoe.js for the
// co-located builder). scripts/test-sync.mjs deliberately does NOT import this, so
// the test suite stays free of the DataDoe/Supabase module graph.
//
// To ENABLE a follow-up report: extract its builder as a co-located named export
// in api/datadoe.js (as buildBrandSalesPayload already is), add it here, and flip
// enabled:true on its registry entry. fba-plan is next: extract buildFbaPlanPayload
// ({ apiKey, ids, to }) from the action=fba-plan handler (~api/datadoe.js:1919).

import { deriveCorrectedBrandSalesForAccount } from "../../reports/brand-sales-live.js";
import { buildSalesMovers } from "../../reports/sales-movers.js";

const REPORT_BUILDS = {
  // Brand Sales is derived from the CORRECTED durable rollup (source_oli_daily_history; cancelled + zero-value
  // excluded), NEVER the raw ORDER_SALES projection -> ZERO DataDoe export. build-then-save preserves the
  // last-known-good: an unready durable derive THROWS before the save, so a stale/absent state never overwrites a
  // corrected snapshot.
  "brand-sales": async ({ from, to, account }) => {
    const derived = await deriveCorrectedBrandSalesForAccount({ accountId: account && account.account_id, from, to });
    if (derived.notReady) throw new Error(`brand-sales durable derive not ready (${derived.notReady}); LKG preserved.`);
    return derived.payload;
  },
  "sales-movers": ({ apiKey, ids, to }) => buildSalesMovers({ apiKey, ids, to }),
  // "fba-plan": ({ apiKey, ids, to, account }) => buildFbaPlanPayload({ apiKey, ids, to }),  // follow-up
};

export function getReportBuild(adapterId) {
  return REPORT_BUILDS[adapterId] || null;
}
