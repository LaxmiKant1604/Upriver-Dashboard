// FBA D-1 SOURCE GUARD (Listings inventory cutover) -- proves NO FBA-inventory 10-day lookback and NO FBA Inventory
// Health request remains anywhere in the production planners: every scheduled FBA-inventory input is the shared,
// no-date Listings request (from === to === null -- Listings has no inventory date, so no D-1/D-2 inventory day can be
// claimed); resolvedFbaSnapshot survives ONLY as a READ-ONLY, retired identity of a SAVED Health snapshot (the dated
// read-only bridge readers verify a saved pointer with it) and is never planned; the browser fetch path refuses the
// Health source with ZERO network. A regression re-planning Health fails here before it can ship. 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { planFbaPlanBucketBatched, planListingHealthV3BucketBatched, planFbaPlan, planSalesMovers, buildShadowReportPlan } from "../lib/server/sync/report-planner.js";
import { REPORT_SOURCE_CONTRACTS, RETIRED_FBA_HEALTH_REQUEST } from "../lib/server/sync/report-source-contracts.js";
import { fbaInventoryAsOf, fbaServerCeiling } from "../lib/server/sync/fba-plan-operation.js";
import { resolvedFbaSnapshot, HEALTH_SOURCE_RETIRED_CODE } from "../lib/server/sync/source-bucket-sync.js";
import { RETIRED_DATADOE_SOURCE_IDS, RETIRED_SOURCE_ERROR_CODE, fetchExportRowsStrict } from "../lib/server/datadoe.js";

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); };
writeSync(1, "fba-d1-source-guard\n");

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(path.join(root, p), "utf8");
const RETIRED = new Set(RETIRED_DATADOE_SOURCE_IDS);
// A planned FBA Inventory Health job, by ANY of its identities (source key, retired source id, or a *:inventory /
// *:inventory-health request key).
const isHealthJob = (s) => s.sourceKey === "fba-inventory-health" || RETIRED.has(s.sourceId)
  || /:inventory(-health)?$/.test(String(s.requestKey || ""));

/* ===================== A. static guard: the 10-day lookback AND every planned Health request key are GONE ===================== */
(() => {
  const files = [
    "lib/server/sync/report-planner.js",
    "lib/server/sync/report-derivation.js",
    "lib/server/sync/source-bucket-sync.js",
    "lib/server/sync/source-bucket-sync-runtime.js",
    "lib/server/sync/report-source-contracts.js",
    "lib/server/reports/common.js",
    "lib/server/reports/sources.js",
    "api/datadoe.js",
  ];
  for (const f of files) {
    const src = read(f);
    ok(`A: ${f} carries NO *_INVENTORY_LOOKBACK_DAYS constant`, !/INVENTORY_LOOKBACK_DAYS/.test(src));
    ok(`A: ${f} carries NO snapshotLookbackDays field/read`, !/snapshotLookbackDays/.test(src));
    ok(`A: ${f} carries NO asOf-10d windowKind`, !/asOf-10d/.test(src));
  }
  // The planner (the ONLY place request keys are emitted) names no Health request key at all.
  ok("A: report-planner.js emits NO quoted \"*:inventory\" / \"*:inventory-health\" request key",
    !/["'`][a-z0-9-]+:inventory(-health)?["'`]/.test(read("lib/server/sync/report-planner.js")));
  ok("A: no REPORT_SOURCE_CONTRACTS entry requests FBA Inventory Health (the recipe survives only as RETIRED_FBA_HEALTH_REQUEST)",
    Object.values(REPORT_SOURCE_CONTRACTS).every((cs) => cs.every((c) => c.sourceKey !== "fba-inventory-health" && !/:inventory(-health)?$/.test(c.requestKey)))
      && RETIRED_FBA_HEALTH_REQUEST.retired === true && Object.isFrozen(RETIRED_FBA_HEALTH_REQUEST));
  ok("A: the planner, contracts and insight readers never reference the FBA_INVENTORY_HEALTH source definition",
    ["lib/server/sync/report-planner.js", "lib/server/sync/report-source-contracts.js", "lib/server/reports/common.js"]
      .every((f) => !/FBA_INVENTORY_HEALTH\b/.test(read(f))));
  ok("A: the retired Health source id is refused by createExport (one RETIRED_DATADOE_SOURCE_IDS entry, typed code)",
    RETIRED_DATADOE_SOURCE_IDS.length === 1 && /^44fc5ba0ce/.test(RETIRED_DATADOE_SOURCE_IDS[0])
      && RETIRED_SOURCE_ERROR_CODE === "HEALTH_SOURCE_RETIRED" && HEALTH_SOURCE_RETIRED_CODE === RETIRED_SOURCE_ERROR_CODE);
})();

/* ===================== B. runtime guard: the FBA inventory input is the shared no-date Listings request ===================== */
(() => {
  const connections = [{ id: "primary", apiKey: "fixture-key", accountPrefix: "" }];
  const accounts = [
    { accountId: "acct-in", country: "IN", currency: "INR", name: "A" },
    { accountId: "acct-de", country: "DE", currency: "EUR", name: "B" },
    { accountId: "acct-us", country: "US", currency: "USD", name: "C" },
  ];
  const inv = "2026-09-05";
  const fba = planFbaPlanBucketBatched({ accounts: [accounts[0]], connections, asOfFor: () => inv, inventoryAsOf: inv }).flatMap((r) => r.sources);
  const v3 = planListingHealthV3BucketBatched({ accounts: [accounts[1]], connections, asOfFor: () => inv, inventoryAsOf: inv }).flatMap((r) => r.sources);
  ok("B: fba batched plans ZERO Health jobs; its only inventory input is the canonical no-date Listings request 'fba-plan:awd'",
    fba.length > 0 && !fba.some(isHealthJob)
      && fba.every((s) => s.requestKey === "fba-plan:awd" && s.sourceKey === "listings" && s.from === null && s.to === null));
  ok("B: v3 batched plans ZERO Health jobs; its Listings request carries no date window",
    v3.length > 0 && !v3.some(isHealthJob)
      && v3.filter((s) => s.sourceKey === "listings").every((s) => s.from === null && s.to === null));
  ok("B: the fba-plan and v3 Listings requests share ONE source id (the canonical Listings export, never the retired Health id)",
    new Set([...fba, ...v3].filter((s) => s.sourceKey === "listings").map((s) => s.sourceId)).size === 1
      && [...fba, ...v3].every((s) => !RETIRED.has(s.sourceId)));
  const single = planFbaPlan({ accountId: "acct-us", name: "C", country: "US", currency: "USD", connections, asOf: inv });
  ok("B: single-account planFbaPlan plans ZERO Health jobs (Listings only, no inventory date)",
    !single.sources.some(isHealthJob) && single.sources.some((s) => s.requestKey === "fba-plan:awd" && s.from === null && s.to === null));
  // The priority-path resolver is a READ-ONLY identity of a SAVED Health snapshot: flagged retired, bound to the exact
  // day it is asked for (the bridge readers verify a saved pointer with it) -- and its source id is the refused one.
  const snap = resolvedFbaSnapshot({ apiKey: "fixture-key", account: { rawSellerId: "acct-us", country: "US" }, asOf: inv, bucket: "us-ca" });
  ok("B: resolvedFbaSnapshot is a READ-ONLY retired identity (never a planned job): retired + readOnly + the refused source id",
    snap.retired === true && snap.readOnly === true && RETIRED.has(snap.sourceId) && snap.from === inv && snap.to === inv);
})();

/* ===================== C. the ONE canonical D-1 date (sales / cycle as-of; never an inventory date) ===================== */
(() => {
  const at = Date.parse("2026-09-06T03:00:00Z");
  ok("C: fbaInventoryAsOf is the PREVIOUS UTC date (D-1), matching the workflow's shared inventory_asof",
    fbaInventoryAsOf(at) === "2026-09-05" && fbaInventoryAsOf(at) === fbaServerCeiling(at));
  const yml = read("../.github/workflows/scheduler-v2.yml");
  ok("C: the workflow binds inventory_asof to the D-1 asof exactly once (never a second date computation)",
    /inventory_asof="\$asof"/.test(yml) && (yml.match(/date -u \+%Y-%m-%d/g) || []).length === 0);
})();

/* ===================== D. FIXED-CLOCK integration: the whole scheduled surface + the browser fetch path, zero Health ===================== */
await (async () => {
  const CLOCK = Date.parse("2026-09-07T09:00:00Z");
  const TODAY = "2026-09-07";
  const D1 = "2026-09-06";
  ok("D: the scheduler's resolved asOf/inventory_asof at the fixed clock is D-1", fbaInventoryAsOf(CLOCK) === D1);

  const connections = [{ id: "primary", apiKey: "fixture-key", accountPrefix: "" }];
  const accounts = [
    { accountId: "acct-us", country: "US", currency: "USD", name: "US" },
    { accountId: "acct-in", country: "IN", currency: "INR", name: "IN" },
  ];
  // The COMPLETE scheduled surface that used to request fba-inventory-health: the generic shadow plan (buy-box-loss +
  // listing-health + the default keys), the batched FBA + v3 planners, and the staged Sales Movers plan with a
  // validated dated probe.
  const generic = buildShadowReportPlan({ accounts, connections, asOfFor: () => D1 });
  const fbaBatched = planFbaPlanBucketBatched({ accounts, connections, asOfFor: () => D1, inventoryAsOf: D1 });
  const v3Batched = planListingHealthV3BucketBatched({ accounts, connections, asOfFor: () => D1, inventoryAsOf: D1 });
  const smStaged = planSalesMovers({ ...accounts[0], connections, asOf: D1, probeSignal: { status: "success", validated: true, latestReportedDate: "2026-09-04" } });
  const all = [
    ...generic.reportRequests.flatMap((r) => r.sources),
    ...generic.sourceJobs,
    ...fbaBatched.flatMap((r) => r.sources),
    ...v3Batched.flatMap((r) => r.sources),
    ...smStaged.sources,
  ];
  ok("D: the scheduled surface is non-trivial (the planners actually ran)", all.length > 20);
  ok("D: NO scheduled path plans an FBA Inventory Health job (source key, retired source id, or inventory request key)",
    !all.some(isHealthJob));
  ok("D: every planned Listings request is date-less (no D-1/D-2 inventory day is ever claimed)",
    all.filter((s) => s.sourceKey === "listings" && s.requestKey).every((s) => s.from === null && s.to === null));

  // BROWSER fetch path: a builder that still asked for the Health source through the shared transport is REFUSED typed
  // BEFORE the export cache, the manual continuation marker or any network call (zero DataDoe, never a create).
  const realFetch = globalThis.fetch;
  let network = 0;
  globalThis.fetch = async (url) => { network += 1; throw new Error("unexpected fetch in fixed-clock test: " + url); };
  let refused = null;
  try {
    await fetchExportRowsStrict("fixture-key", RETIRED_DATADOE_SOURCE_IDS[0], [...RETIRED_FBA_HEALTH_REQUEST.columns], ["acct-us"], D1, D1, 15000, { orderByColumn: "date", orderByDirection: "DESC" }, "FBA inventory snapshot export");
  } catch (e) { refused = e; } finally { globalThis.fetch = realFetch; }
  ok("D: the browser Health fetch is refused typed (HEALTH_SOURCE_RETIRED) with ZERO network calls (TODAY " + TODAY + ")",
    !!refused && refused.code === RETIRED_SOURCE_ERROR_CODE && network === 0);
})();

writeSync(1, `\nfba-d1-source-guard: ${passed} assertions passed\n`);
