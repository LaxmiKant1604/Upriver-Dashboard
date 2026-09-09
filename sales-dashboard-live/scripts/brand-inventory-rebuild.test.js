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
import { runBrandInventoryRebuild, compactInventoryContentFingerprint } from "../lib/server/sync/report-materialization-brandview-operation.js";
import { brandViewDependencyFingerprint } from "../lib/server/reports/brand-view-dependency-fingerprint.js";
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

// ---- operator: CYCLE-BOUND authorization + content-aware idempotency + zero-vs-missing + newer-only -----------
const CYCLE = "2026-09-08"; // inventory_asof (D-1) threaded from the run job
const accounts = [
  { accountId: "acctFresh", country: "IN" },     // authorized THIS cycle + fresh fba-plan -> materialize available
  { accountId: "acctNoInv", country: "IN" },     // authorized + fba-plan no inventory -> leave existing (unavailable)
  { accountId: "acctOld", country: "IN" },       // authorized + older fba-plan (LKG) -> rebuild with its REAL date
  { accountId: "acctUnauth", country: "IN" },    // NO live compact at all -> skip (legacy fallback)
  { accountId: "acctOldCycle", country: "IN" },  // live compact from a PREVIOUS cycle (params.to != CYCLE) -> skip
];
const plans = {
  acctFresh: { payload: freshPlan, source_refreshed_at: "2026-09-08T16:40:00Z" },
  acctNoInv: { payload: { inventoryAvailable: false }, source_refreshed_at: "2026-09-08T16:40:00Z" },
  acctOld: { payload: { inventoryAvailable: true, inventorySnapshotDate: "2026-09-02", inventoryByBrandCountry: [{ country: "IN", brand: "Acme", fbaAvailable: 40, skuCount: 1 }] }, source_refreshed_at: "2026-09-02T16:40:00Z" },
  acctUnauth: { payload: freshPlan, source_refreshed_at: "2026-09-08T16:40:00Z" },
  acctOldCycle: { payload: freshPlan, source_refreshed_at: "2026-09-08T16:40:00Z" },
};
// The priority run published a live compact (placeholder) THIS cycle for the authorized accounts -- params.to = the
// cycle's D-1. acctUnauth has NO row; acctOldCycle's row is from a PREVIOUS cycle (params.to = an earlier D-1).
const liveCompacts = {
  acctFresh: { params: { to: CYCLE }, payload: { inventoryAvailable: false }, source_refreshed_at: "2026-09-08T03:15:00Z" },
  acctNoInv: { params: { to: CYCLE }, payload: { inventoryAvailable: false }, source_refreshed_at: "2026-09-08T03:15:00Z" },
  acctOld: { params: { to: CYCLE }, payload: { inventoryAvailable: false }, source_refreshed_at: "2026-09-08T03:15:00Z" },
  acctOldCycle: { params: { to: "2026-09-05" }, payload: { inventoryAvailable: true, inventoryByBrandCountry: [] }, source_refreshed_at: "2026-09-05T03:15:00Z" },
};
const runRebuild = async ({ liveReader, existingReader, inventoryAsOf = CYCLE } = {}) => {
  const writes = [];
  const r = await runBrandInventoryRebuild({ region: "india", accounts, inventoryAsOf, dryRun: false }, {
    readFbaPlan: async ({ accountId }) => plans[accountId] || null,
    readLiveBrandInventory: liveReader || (async ({ accountId }) => liveCompacts[accountId] || null),
    readSnapshot: existingReader || (async () => null),
    persistSnapshot: async (u) => { writes.push(u); return { savedAt: u.sourceRefreshedAt }; },
  });
  return { r, writes };
};

{
  const { r, writes } = await runRebuild();
  const byAcct = (s) => r.events.filter((e) => e.status === s).map((e) => e.account).sort();
  ok("B: authorized fresh + old-fba accounts materialize; no-inventory unavailable; no-row + old-cycle skipped",
    JSON.stringify(byAcct("materialized")) === JSON.stringify(["acctFresh", "acctOld"])
    && JSON.stringify(byAcct("unavailable")) === JSON.stringify(["acctNoInv"])
    && JSON.stringify(byAcct("skipped")) === JSON.stringify(["acctOldCycle", "acctUnauth"]));
  ok("B (item 2): a live compact from a PREVIOUS cycle (params.to != inventory_asof) is NOT authorized -> skip, 0 writes",
    r.events.find((e) => e.account === "acctOldCycle").reason === "unauthorized-stale-cycle" && !writes.find((w) => w.accountId === "acctOldCycle"));
  ok("B: the no-row account is skipped 'unauthorized-no-live-compact'", r.events.find((e) => e.account === "acctUnauth").reason === "unauthorized-no-live-compact");
  ok("B: exactly two live compact writes; none for missing-inventory, no-row, or old-cycle", writes.length === 2);
  const fresh = writes.find((w) => w.accountId === "acctFresh");
  ok("B: the fresh compact carries the fba-plan provenance + the compact report version + a content depFingerprint",
    fresh.sourceRefreshedAt === "2026-09-08T16:40:00Z" && fresh.params.reportVersion === BRAND_INVENTORY_REPORT_VERSION && fresh.params.to === "2026-09-08" && typeof fresh.params.depFingerprint === "string");
  const old = writes.find((w) => w.accountId === "acctOld");
  ok("B: the LKG account rebuilds with its REAL older date (Sep 2), never relabeled D-1", old.payload.inventoryDate === "2026-09-02" && old.payload.inventoryAvailable === true);
  ok("B: zero tokens (structurally impossible to export on this path)", r.summary.tokens === 0);
}

{
  // ITEM 2 fail-closed: a MISSING inventory_asof authorizes NO account (never a stale-row write).
  const { r, writes } = await runRebuild({ inventoryAsOf: null });
  ok("B (item 2): a missing inventory_asof fails closed -> every account skipped 'unauthorized-stale-cycle', 0 writes",
    writes.length === 0 && r.events.filter((e) => e.status === "materialized").length === 0 && r.events.some((e) => e.reason === "unauthorized-stale-cycle"));
}

{
  // ITEM 1 (the exact bug): the existing same-{to} row is the priority placeholder (inventoryAvailable:false) whose
  // source_refreshed_at EQUALS the fresh fba-plan's, with NO stored fingerprint. A content-BLIND (timestamp-equality)
  // idempotency would skip; the content fingerprint must WRITE the false -> true change.
  const eqPlaceholder = async ({ reportKey, accountId }) => (reportKey === "brand-inventory" && accountId === "acctFresh"
    ? { params: { reportVersion: BRAND_INVENTORY_REPORT_VERSION, to: "2026-09-08" }, payload: { inventoryAvailable: false, inventoryByBrandCountry: [] }, source_refreshed_at: "2026-09-08T16:40:00Z" } // EQUAL timestamp to plans.acctFresh
    : null);
  const { writes } = await runRebuild({ existingReader: eqPlaceholder });
  const fresh = writes.find((w) => w.accountId === "acctFresh");
  ok("C (item 1): an EQUAL-timestamp inventoryAvailable:false -> true is WRITTEN (content-aware, not timestamp-blind)",
    !!fresh && fresh.payload.inventoryAvailable === true);
}

{
  // ITEM 1 replay: the existing row is the ALREADY-WRITTEN fresh compact (same content + stored content fingerprint)
  // at an EQUAL timestamp -> a same-content replay is a ZERO-WRITE no-op.
  const freshCompact = compactInventoryFromFbaPlanPayload(freshPlan, "acctFresh");
  const freshFp = compactInventoryContentFingerprint(freshCompact);
  const alreadyWritten = async ({ reportKey, accountId }) => (reportKey === "brand-inventory" && accountId === "acctFresh"
    ? { params: { reportVersion: BRAND_INVENTORY_REPORT_VERSION, to: "2026-09-08", depFingerprint: freshFp }, payload: freshCompact, source_refreshed_at: "2026-09-08T16:40:00Z" }
    : null);
  const { r, writes } = await runRebuild({ existingReader: alreadyWritten });
  ok("C (item 1): a same-content replay is a zero-write 'unchanged' (content fingerprint matches)",
    !writes.find((w) => w.accountId === "acctFresh") && r.events.find((e) => e.account === "acctFresh").status === "unchanged");
}

{
  // PLACEHOLDER COLLISION: the existing same-{to} placeholder carries a NEWER source_refreshed_at. It must NOT
  // suppress the fresh inventoryAvailable:true fold (newer-only preserves only a genuinely newer AVAILABLE compact).
  const placeholderNewer = async ({ reportKey, accountId }) => (reportKey === "brand-inventory" && accountId === "acctFresh"
    ? { params: { reportVersion: BRAND_INVENTORY_REPORT_VERSION, to: "2026-09-08" }, payload: { inventoryAvailable: false, inventoryByBrandCountry: [] }, source_refreshed_at: "2026-09-09T03:15:00Z" } : null);
  const { writes } = await runRebuild({ existingReader: placeholderNewer });
  const fresh = writes.find((w) => w.accountId === "acctFresh");
  ok("C: an inventoryAvailable:false placeholder with a newer timestamp does NOT suppress the fresh available fold",
    !!fresh && fresh.payload.inventoryAvailable === true);
}

{
  // NEWER-ONLY (genuine): an existing AVAILABLE compact newer than this fba-plan is preserved (LKG), not overwritten.
  const newerAvailable = async ({ reportKey, accountId }) => (reportKey === "brand-inventory" && accountId === "acctFresh"
    ? { params: { reportVersion: BRAND_INVENTORY_REPORT_VERSION, to: "2026-09-08" }, payload: { inventoryAvailable: true, inventoryByBrandCountry: [{ country: "IN", brand: "Acme", fbaAvailable: 999 }] }, source_refreshed_at: "2026-09-09T00:00:00Z" } : null);
  const { r, writes } = await runRebuild({ existingReader: newerAvailable });
  ok("D: a genuinely newer AVAILABLE compact is preserved (no overwrite of newer LKG)",
    !writes.find((w) => w.accountId === "acctFresh") && r.events.find((e) => e.account === "acctFresh").reason === "existing-newer-available");
}

{
  // ITEM 1 CROSS-CYCLE (LAGGING inventory -- the review-confirmed HIGH): acctOld's fba-plan date (Sep 2) LAGS the
  // cycle D-1 (Sep 8). Its compact lives at paramsHash {to: Sep 2} -- a DIFFERENT row than the priority's Sep-8
  // placeholder, which the priority REPUBLISHES fresh (inventoryAvailable:false, newest updated_at) EVERY cycle. The
  // serve reads latest-by-updated_at ACROSS paramsHash, so a content-ONLY fingerprint would skip the re-persist on
  // unchanged stock and let the fresh unavailable placeholder SHADOW this available compact (Brand View regresses to
  // unavailable). The fix folds the CYCLE into the stored fingerprint of a lagging compact so it is re-persisted
  // (newest) each cycle, while a SAME-cycle replay stays a zero-write no-op.
  const onlyOld = [{ accountId: "acctOld", country: "IN" }];
  const runOld = async ({ inventoryAsOf, existingReader }) => {
    const writes = [];
    const r = await runBrandInventoryRebuild({ region: "india", accounts: onlyOld, inventoryAsOf, dryRun: false }, {
      readFbaPlan: async ({ accountId }) => plans[accountId] || null,
      // The priority run republishes acctOld's LIVE placeholder for THIS cycle (params.to = inventoryAsOf) -> authorized.
      readLiveBrandInventory: async ({ accountId }) => (accountId === "acctOld"
        ? { params: { to: inventoryAsOf }, payload: { inventoryAvailable: false }, source_refreshed_at: "2026-09-08T03:15:00Z" } : null),
      readSnapshot: existingReader || (async () => null),
      persistSnapshot: async (u) => { writes.push(u); return { savedAt: u.sourceRefreshedAt }; },
    });
    return { r, writes };
  };
  const laggingCompact = compactInventoryFromFbaPlanPayload(plans.acctOld.payload, "acctOld");
  const laggingContentFp = compactInventoryContentFingerprint(laggingCompact);
  const thisCycleFp = brandViewDependencyFingerprint({ fp: laggingContentFp, cycle: CYCLE });

  // (a) the WRITTEN fingerprint for a lagging compact FOLDS the cycle (it is NOT the pure content fp), so a fresh
  //     unavailable Sep-8 placeholder cannot shadow it -- it is re-persisted newest each cycle.
  const first = await runOld({ inventoryAsOf: CYCLE });
  const w = first.writes.find((x) => x.accountId === "acctOld");
  ok("E (item 1 lagging): a lagging (date != cycle) compact stores a CYCLE-FOLDED fingerprint (not the pure content fp)",
    !!w && w.params.depFingerprint === thisCycleFp && thisCycleFp !== laggingContentFp);

  // (b) a SAME-cycle replay (existing row already carries this cycle's folded fp) is a zero-write no-op.
  const sameCycleExisting = async ({ accountId }) => (accountId === "acctOld"
    ? { params: { reportVersion: BRAND_INVENTORY_REPORT_VERSION, to: "2026-09-02", depFingerprint: thisCycleFp }, payload: laggingCompact, source_refreshed_at: "2026-09-02T16:40:00Z" } : null);
  const replay = await runOld({ inventoryAsOf: CYCLE, existingReader: sameCycleExisting });
  ok("E (item 1 lagging): a SAME-cycle replay of the unchanged lagging compact is a zero-write no-op",
    !replay.writes.find((x) => x.accountId === "acctOld") && replay.r.events.find((e) => e.account === "acctOld").status === "unchanged");

  // (c) the NEXT cycle, with UNCHANGED lagging stock, RE-PERSISTS (the fingerprint folds the new cycle) so the
  //     compact stays the newest live row and the fresh Sep-9 unavailable placeholder never shadows it. A content-
  //     ONLY fingerprint would have been a no-op here -> the exact regression the fix closes.
  const nextCycle = "2026-09-09";
  const next = await runOld({ inventoryAsOf: nextCycle, existingReader: sameCycleExisting });
  const nw = next.writes.find((x) => x.accountId === "acctOld");
  ok("E (item 1 lagging): the NEXT cycle re-persists the unchanged lagging compact (new cycle fold) -> stays newest",
    !!nw && nw.payload.inventoryAvailable === true
    && nw.params.depFingerprint === brandViewDependencyFingerprint({ fp: laggingContentFp, cycle: nextCycle })
    && nw.params.depFingerprint !== thisCycleFp);
}

writeSync(1, `\nbrand-inventory-rebuild: ${passed} assertions passed\n`);
