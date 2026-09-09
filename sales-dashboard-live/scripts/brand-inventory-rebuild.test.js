// Defect A regression: the compact brand-inventory is REBUILT from each account's FRESH fba-plan snapshot in the
// FBA-aware materialize-inventory job (AFTER the fba job), so Brand View's exclusive-compact consumer serves REAL
// D-1 inventory the same day (the priority run publishes it BEFORE FBA as inventoryAvailable:false). Proves the pure
// adapter, the source-promoted publish gate, per-account zero-vs-missing (never a fabricated zero), newer-only LKG
// protection, and that the rebuilt compact is a VALID compact snapshot Brand View accepts. Offline, ZERO export.
// 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import {
  compactInventoryFromFbaPlanPayload, isCompactInventorySnapshot, brandInventory, BRAND_INVENTORY_REPORT_VERSION,
} from "../lib/server/reports/brand-view.js";
import { runBrandInventoryRebuild } from "../lib/server/sync/report-materialization-brandview-operation.js";
import { paramsHashFor } from "../lib/server/report-store.js";

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); };
writeSync(1, "brand-inventory-rebuild (Defect A)\n");

// ---- pure adapter ------------------------------------------------------------------------------------------------
const freshPlan = { inventoryAvailable: true, inventorySnapshotDate: "2026-09-08", inventoryByBrandCountry: [
  { country: "IN", brand: "Acme", fbaAvailable: 120, skuCount: 3 }, { country: "IN", brand: "Beta", fbaAvailable: 0, skuCount: 1 },
] };
const compact = compactInventoryFromFbaPlanPayload(freshPlan, "acctFresh");
ok("A: adapter builds a compact payload from fba-plan (date + rows preserved)", compact && compact.inventoryAvailable === true && compact.inventoryDate === "2026-09-08" && compact.inventoryByBrandCountry.length === 2);
ok("A: a genuine 0 (validated) is preserved, not dropped", compact.inventoryByBrandCountry.find((e) => e.brand === "Beta").fbaAvailable === 0);
ok("A: fba-plan with no available inventory => null (never a fabricated zero; leave existing compact)", compactInventoryFromFbaPlanPayload({ inventoryAvailable: false }, "x") === null);
ok("A: fba-plan without a strict snapshot date => null (never a fabricated D-1)", compactInventoryFromFbaPlanPayload({ inventoryAvailable: true, inventorySnapshotDate: "bad", inventoryByBrandCountry: [] }, "x") === null);
ok("A: a malformed (negative/non-finite) fold quantity => null (preserve previous compact)", compactInventoryFromFbaPlanPayload({ inventoryAvailable: true, inventorySnapshotDate: "2026-09-08", inventoryByBrandCountry: [{ country: "IN", brand: "Z", fbaAvailable: -5 }] }, "x") === null);

// The rebuilt compact is a VALID compact snapshot the Brand View consumer reads through its unchanged gate.
const asSnapshot = { params: { reportVersion: BRAND_INVENTORY_REPORT_VERSION, to: compact.inventoryDate }, payload: compact };
ok("A: the rebuilt compact passes isCompactInventorySnapshot (Brand View reads it as authoritative)", isCompactInventorySnapshot(asSnapshot) === true);
const inv = brandInventory(compact, "Acme", "IN", null);
ok("A: Brand View folds the compact to per-country FBA available (120 for Acme/IN)", inv.byCountry.get("IN") === 120 && inv.scope === "country");

// ---- operator: per-account rebuild, control gate, zero-vs-missing, newer-only -----------------------------------
const accounts = [
  { accountId: "acctFresh", country: "IN" },  // fresh fba-plan -> materialize compact available
  { accountId: "acctNoInv", country: "IN" },  // fba-plan present but no available inventory -> leave existing (unavailable)
  { accountId: "acctOld", country: "IN" },    // fba-plan on an OLDER date -> rebuild with its REAL date (labeled, not D-1)
];
const plans = {
  acctFresh: { payload: freshPlan, source_refreshed_at: "2026-09-08T16:40:00Z" },
  acctNoInv: { payload: { inventoryAvailable: false }, source_refreshed_at: "2026-09-08T16:40:00Z" },
  acctOld: { payload: { inventoryAvailable: true, inventorySnapshotDate: "2026-09-02", inventoryByBrandCountry: [{ country: "IN", brand: "Acme", fbaAvailable: 40, skuCount: 1 }] }, source_refreshed_at: "2026-09-02T16:40:00Z" },
};
const runRebuild = async ({ promoted, existingReader } = {}) => {
  const writes = [];
  const r = await runBrandInventoryRebuild({ region: "india", accounts, dryRun: false }, {
    readFbaPlan: async ({ accountId }) => plans[accountId] || null,
    promotedPublishEnabled: async () => promoted !== false,
    readSnapshot: existingReader || (async () => null),
    persistSnapshot: async (u) => { writes.push(u); return { savedAt: u.sourceRefreshedAt }; },
  });
  return { r, writes };
};

{
  const { r, writes } = await runRebuild();
  const byAcct = (s) => r.events.filter((e) => e.status === s).map((e) => e.account).sort();
  ok("B: fresh + old accounts materialize; no-inventory account stays unavailable (no write)",
    JSON.stringify(byAcct("materialized")) === JSON.stringify(["acctFresh", "acctOld"]) && JSON.stringify(byAcct("unavailable")) === JSON.stringify(["acctNoInv"]));
  ok("B: exactly two live compact writes (fresh + old); zero for the missing-inventory account", writes.length === 2);
  const fresh = writes.find((w) => w.accountId === "acctFresh");
  ok("B: the fresh compact carries the fba-plan provenance + the compact report version (params.to = the date)",
    fresh.sourceRefreshedAt === "2026-09-08T16:40:00Z" && fresh.params.reportVersion === BRAND_INVENTORY_REPORT_VERSION && fresh.params.to === "2026-09-08");
  const old = writes.find((w) => w.accountId === "acctOld");
  ok("B: the LKG account rebuilds with its REAL older date (Sep 2), never relabeled D-1", old.payload.inventoryDate === "2026-09-02" && old.payload.inventoryAvailable === true);
  ok("B: zero tokens (structurally impossible to export on this path)", r.summary.tokens === 0);
}

{
  // Control gate: when the source-promoted publish control is disabled, write NOTHING (legacy fba-plan fallback serves).
  const { r, writes } = await runRebuild({ promoted: false });
  ok("C: source-promoted publish disabled => skip, zero writes", r.skipped === "promoted-publish-disabled" && writes.length === 0);
}

{
  // Newer-only: an EXISTING compact newer than this fba-plan evidence is preserved (LKG), not overwritten.
  const newerExisting = async ({ reportKey, accountId }) => (reportKey === "brand-inventory" && accountId === "acctFresh"
    ? { payload: { inventoryAvailable: true }, source_refreshed_at: "2026-09-09T00:00:00Z" } : null); // newer than fba-plan 09-08
  const { writes } = await runRebuild({ existingReader: newerExisting });
  ok("D: an existing compact NEWER than the fba-plan is preserved (no overwrite of newer LKG)", !writes.find((w) => w.accountId === "acctFresh"));
}

writeSync(1, `\nbrand-inventory-rebuild: ${passed} assertions passed\n`);
