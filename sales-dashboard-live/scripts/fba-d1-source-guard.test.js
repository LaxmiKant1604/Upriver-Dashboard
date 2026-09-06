// FBA D-1 SOURCE GUARD -- proves NO FBA-inventory 10-day lookback request remains anywhere in the
// production source, and that every planned fba-inventory-health window is EXACTLY one day (from ===
// to). A regression reintroducing the asOf-10d..asOf shape fails here before it can ship. 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { planFbaPlanBucketBatched, planListingHealthV3BucketBatched, planFbaPlan } from "../lib/server/sync/report-planner.js";
import { fbaInventoryAsOf, fbaServerCeiling } from "../lib/server/sync/fba-plan-operation.js";
import { resolvedFbaSnapshot } from "../lib/server/sync/source-bucket-sync.js";

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

writeSync(1, `\nfba-d1-source-guard: ${passed} assertions passed\n`);
