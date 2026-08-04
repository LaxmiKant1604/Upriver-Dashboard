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

import { buildBrandSalesPayload } from "../../../../api/datadoe.js";
import { buildSalesMovers } from "../../reports/sales-movers.js";

const REPORT_BUILDS = {
  "brand-sales": ({ apiKey, ids, from, to }) => buildBrandSalesPayload({ apiKey, ids, from, to }),
  "sales-movers": ({ apiKey, ids, to }) => buildSalesMovers({ apiKey, ids, to }),
  // "fba-plan": ({ apiKey, ids, to, account }) => buildFbaPlanPayload({ apiKey, ids, to }),  // follow-up
};

export function getReportBuild(adapterId) {
  return REPORT_BUILDS[adapterId] || null;
}
