// FBA D-1 SOURCE GUARD -- proves NO FBA-inventory 10-day lookback request remains anywhere in the
// production source, and that every planned fba-inventory-health window is EXACTLY one day (from ===
// to). A regression reintroducing the asOf-10d..asOf shape fails here before it can ship. 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { planFbaPlanBucketBatched, planListingHealthV3BucketBatched, planFbaPlan, planSalesMovers, buildShadowReportPlan } from "../lib/server/sync/report-planner.js";
import { fbaInventoryAsOf, fbaServerCeiling } from "../lib/server/sync/fba-plan-operation.js";
import { resolvedFbaSnapshot } from "../lib/server/sync/source-bucket-sync.js";
import { sourceRequestIdentity } from "../lib/server/source-identity.js";
import { fetchInventorySnapshot } from "../lib/server/reports/common.js";

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); };
writeSync(1, "fba-d1-source-guard\n");

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(path.join(root, p), "utf8");

/* ===================== A. static guard: the 10-day lookback is GONE from production source ===================== */
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
})();

/* ===================== B. runtime guard: every planned inventory window is EXACTLY one day ===================== */
(() => {
  const connections = [{ id: "primary", apiKey: "fixture-key", accountPrefix: "" }];
  const accounts = [
    { accountId: "acct-in", country: "IN", currency: "INR", name: "A" },
    { accountId: "acct-de", country: "DE", currency: "EUR", name: "B" },
    { accountId: "acct-us", country: "US", currency: "USD", name: "C" },
  ];
  const inv = "2026-09-05";
  const windowsOf = (requests, key) => requests.flatMap((r) => r.sources.filter((s) => s.requestKey === key).map((s) => ({ from: s.from, to: s.to })));
  for (const [label, requests, key] of [
    ["fba batched", planFbaPlanBucketBatched({ accounts: [accounts[0]], connections, asOfFor: () => "2026-09-05", inventoryAsOf: inv }), "fba-plan:inventory-health"],
    ["v3 batched", planListingHealthV3BucketBatched({ accounts: [accounts[1]], connections, asOfFor: () => "2026-09-05", inventoryAsOf: inv }), "listing-health-v3:inventory"],
  ]) {
    const wins = windowsOf(requests, key);
    ok(`B: ${label} inventory window is EXACTLY [${inv} .. ${inv}] (single day)`,
      wins.length > 0 && wins.every((w) => w.from === inv && w.to === inv));
  }
  const single = planFbaPlan({ accountId: "acct-us", name: "C", country: "US", currency: "USD", connections, asOf: inv });
  const sInv = single.sources.find((s) => s.requestKey === "fba-plan:inventory-health");
  ok("B: single-account planFbaPlan inventory window is the exact single day", sInv.from === inv && sInv.to === inv);
  const snap = resolvedFbaSnapshot({ apiKey: "fixture-key", account: { rawSellerId: "acct-us", country: "US" }, asOf: inv, bucket: "us-ca" });
  ok("B: the priority-path resolvedFbaSnapshot request is the exact single day (shared hash with fba-plan)",
    snap.from === inv && snap.to === inv);
})();

/* ===================== C. the ONE canonical D-1 date ===================== */
(() => {
  const at = Date.parse("2026-09-06T03:00:00Z");
  ok("C: fbaInventoryAsOf is the PREVIOUS UTC date (D-1), matching the workflow's shared inventory_asof",
    fbaInventoryAsOf(at) === "2026-09-05" && fbaInventoryAsOf(at) === fbaServerCeiling(at));
  const yml = read("../.github/workflows/scheduler-v2.yml");
  ok("C: the workflow binds inventory_asof to the D-1 asof exactly once (never a second date computation)",
    /inventory_asof="\$asof"/.test(yml) && (yml.match(/date -u \+%Y-%m-%d/g) || []).length === 0);
})();

/* ===================== D. FIXED-CLOCK integration: browser and scheduler resolve ONE D-1 identity ===================== */
await (async () => {
  // Fixed clock: the run happens on 2026-09-07 (UTC). The scheduler resolves report/sales asOf = D-1 =
  // 2026-09-06 (fbaInventoryAsOf / `date -u -d yesterday`); the browser sends TODAY = 2026-09-07.
  const CLOCK = Date.parse("2026-09-07T09:00:00Z");
  const TODAY = "2026-09-07";
  const D1 = "2026-09-06";
  const D2 = "2026-09-05";
  ok("D: the scheduler's resolved asOf/inventory_asof at the fixed clock is D-1", fbaInventoryAsOf(CLOCK) === D1);

  const connections = [{ id: "primary", apiKey: "fixture-key", accountPrefix: "" }];
  const accounts = [
    { accountId: "acct-us", country: "US", currency: "USD", name: "US" },
    { accountId: "acct-in", country: "IN", currency: "INR", name: "IN" },
  ];
  // The COMPLETE scheduled surface that can request fba-inventory-health: the generic shadow plan
  // (buy-box-loss + listing-health + the default keys), the batched FBA + v3 planners, and the staged
  // Sales Movers plan with a validated dated probe.
  const generic = buildShadowReportPlan({ accounts, connections, asOfFor: () => D1 });
  const fbaBatched = planFbaPlanBucketBatched({ accounts, connections, asOfFor: () => D1, inventoryAsOf: D1 });
  const v3Batched = planListingHealthV3BucketBatched({ accounts, connections, asOfFor: () => D1, inventoryAsOf: D1 });
  const smStaged = planSalesMovers({ ...accounts[0], connections, asOf: D1, probeSignal: { status: "success", validated: true, latestReportedDate: "2026-09-04" } });
  const allInventoryJobs = [
    ...generic.reportRequests.flatMap((r) => r.sources),
    ...fbaBatched.flatMap((r) => r.sources),
    ...v3Batched.flatMap((r) => r.sources),
    ...smStaged.sources,
  ].filter((s) => s.sourceKey === "fba-inventory-health");
  ok("D: the scheduled surface actually plans inventory jobs (buy-box + listing-health + sales-movers + fba + v3)",
    allInventoryJobs.length >= 5);
  ok(`D: EVERY scheduled fba-inventory-health request is EXACTLY [${D1} .. ${D1}]`,
    allInventoryJobs.every((s) => s.from === D1 && s.to === D1));
  ok(`D: NO scheduled path produces D-2 (${D2}) anywhere in its planned windows`,
    ![...generic.sourceJobs, ...allInventoryJobs].some((s) => s.from === D2 || s.to === D2));

  // BROWSER path: run the REAL live builder (fetchInventorySnapshot) with TODAY, intercepting the
  // actual DataDoe create POST to capture the requested window (zero network, zero exports).
  const captured = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith("/exports") && options.method === "POST") {
      captured.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ exportId: "fx-1", status: "COMPLETED" }) };
    }
    if (String(url).includes("/exports/fx-1/raw")) {
      return { ok: true, status: 200, json: async () => ({ rawContent: "[]" }) };
    }
    throw new Error("unexpected fetch in fixed-clock test: " + url);
  };
  try {
    await fetchInventorySnapshot("fixture-key", ["acct-us"], TODAY);
  } finally {
    globalThis.fetch = realFetch;
  }
  ok("D: the browser builder issued exactly one inventory create request", captured.length === 1);
  const req = captured[0];
  ok(`D: the browser request window is EXACTLY [${D1} .. ${D1}] (TODAY resolves to D-1, never D-2/D-0)`,
    req.from === D1 && req.to === D1);

  // CANONICAL IDENTITY: the browser request's identity equals the scheduled buy-box/listing-health
  // inventory job's request hash -- ONE shared export identity across both paths.
  const browserIdentity = sourceRequestIdentity({
    apiKey: "fixture-key", sourceId: req.sourceId, columns: req.columns, ids: req.sellerOrVendorIds,
    from: req.from, to: req.to, limit: req.limit,
    options: { orderByColumn: req.orderByColumn, orderByDirection: req.orderByDirection },
  });
  const scheduledInsightInv = generic.reportRequests
    .filter((r) => r.accountId === "acct-us")
    .flatMap((r) => r.sources)
    .find((s) => s.sourceKey === "fba-inventory-health" && (s.requestKey === "buy-box-loss:inventory" || s.requestKey === "listing-health:inventory"));
  ok("D: browser and scheduler resolve the SAME canonical request hash for the same account (one shared export)",
    !!scheduledInsightInv && browserIdentity.requestHash === scheduledInsightInv.requestHash);
})();

writeSync(1, `\nfba-d1-source-guard: ${passed} assertions passed\n`);
