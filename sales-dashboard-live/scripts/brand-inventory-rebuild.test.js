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
// cycle's D-1. acctUnauth has NO row; acctOldCycle's ONLY row is from a PREVIOUS cycle (params.to = an earlier D-1).
const liveCompacts = {
  acctFresh: { params: { to: CYCLE }, payload: { inventoryAvailable: false }, source_refreshed_at: "2026-09-08T03:15:00Z" },
  acctNoInv: { params: { to: CYCLE }, payload: { inventoryAvailable: false }, source_refreshed_at: "2026-09-08T03:15:00Z" },
  acctOld: { params: { to: CYCLE }, payload: { inventoryAvailable: false }, source_refreshed_at: "2026-09-08T03:15:00Z" },
  acctOldCycle: { params: { to: "2026-09-05" }, payload: { inventoryAvailable: true, inventoryByBrandCountry: [] }, source_refreshed_at: "2026-09-05T03:15:00Z" },
};
// Round-4 Defect 1: authorization is the EXACT current-cycle publication -- the operator reads the brand-inventory
// row whose params.to === cycleAsOf. This harness models that exact read: it returns the account's live row ONLY
// when it was published for the requested cycle (so an old-cycle-only row is invisible to authorization -> null).
const exactLive = async ({ accountId, cycleAsOf }) => {
  const row = liveCompacts[accountId];
  return (row && String((row.params && row.params.to) || "") === String(cycleAsOf || "")) ? row : null;
};
const runRebuild = async ({ liveReader, existingReader, inventoryAsOf = CYCLE } = {}) => {
  const writes = [];
  const r = await runBrandInventoryRebuild({ region: "india", accounts, inventoryAsOf, dryRun: false }, {
    readFbaPlan: async ({ accountId }) => plans[accountId] || null,
    readLiveBrandInventory: liveReader || exactLive,
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
  ok("B (item 2): a live compact from a PREVIOUS cycle (params.to != inventory_asof) is NOT authorized via the exact-read -> skip, 0 writes",
    r.events.find((e) => e.account === "acctOldCycle").reason === "unauthorized-no-current-cycle-publication" && !writes.find((w) => w.accountId === "acctOldCycle"));
  ok("B: the no-row account is skipped 'unauthorized-no-current-cycle-publication'", r.events.find((e) => e.account === "acctUnauth").reason === "unauthorized-no-current-cycle-publication");
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
  ok("B (item 2): a missing inventory_asof fails closed -> every account skipped 'unauthorized-no-cycle', 0 writes",
    writes.length === 0 && r.events.filter((e) => e.status === "materialized").length === 0
    && r.events.every((e) => e.reason === "unauthorized-no-cycle" || e.reason === "non-primary-or-blank"));
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
  // at an EQUAL timestamp -> a same-content replay is a ZERO-WRITE no-op (pure content idempotency; no marker/backfill).
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
  // ROUND-4 Defect 2 -- LAGGING inventory idempotency is PURE CONTENT (the Round-3 cycle-fold rewrite is REMOVED).
  // acctOld's fba-plan date (Sep 2) LAGS the cycle D-1 (Sep 8), so its compact lives at paramsHash {to: Sep 2} -- a
  // DIFFERENT row than the priority's Sep-8 placeholder. The placeholder-shadowing problem is now solved in SERVE
  // SELECTION (selectAuthoritativeInventorySnapshot, see brand-view-inventory-selection.test.js), so here the write
  // must be a PURE content fingerprint at the REAL date, and an unchanged lagging compact must NEVER be rewritten --
  // in the same cycle OR a later cycle (no unconditional per-cycle rewrite / no fabricated freshness).
  const onlyOld = [{ accountId: "acctOld", country: "IN" }];
  const laggingCompact = compactInventoryFromFbaPlanPayload(plans.acctOld.payload, "acctOld");
  const laggingContentFp = compactInventoryContentFingerprint(laggingCompact);
  const runOld = async ({ inventoryAsOf, existingReader }) => {
    const writes = [];
    const r = await runBrandInventoryRebuild({ region: "india", accounts: onlyOld, inventoryAsOf, dryRun: false }, {
      readFbaPlan: async ({ accountId }) => plans[accountId] || null,
      // Exact-read authorization: the priority republishes acctOld's placeholder at params.to = the requested cycle.
      readLiveBrandInventory: async ({ accountId, cycleAsOf }) => (accountId === "acctOld"
        ? { params: { to: cycleAsOf }, payload: { inventoryAvailable: false }, source_refreshed_at: "2026-09-08T03:15:00Z" } : null),
      readSnapshot: existingReader || (async () => null),
      persistSnapshot: async (u) => { writes.push(u); return { savedAt: u.sourceRefreshedAt }; },
    });
    return { r, writes };
  };

  // (a) a lagging compact writes at its REAL date (Sep 2) with the PURE content fingerprint -- no cycle fold.
  const first = await runOld({ inventoryAsOf: CYCLE });
  const w = first.writes.find((x) => x.accountId === "acctOld");
  ok("E (item 2): a lagging compact writes at its REAL date with the PURE content fingerprint (no cycle fold / rewrite hack)",
    !!w && w.params.to === "2026-09-02" && w.payload.inventoryAvailable === true && w.params.depFingerprint === laggingContentFp);

  // (b) an unchanged lagging compact is a ZERO-WRITE no-op in the SAME cycle AND the next cycle (pure content idempotency).
  const alreadyWritten = async ({ accountId }) => (accountId === "acctOld"
    ? { params: { reportVersion: BRAND_INVENTORY_REPORT_VERSION, to: "2026-09-02", depFingerprint: laggingContentFp }, payload: laggingCompact, source_refreshed_at: "2026-09-02T16:40:00Z" } : null);
  const replaySame = await runOld({ inventoryAsOf: CYCLE, existingReader: alreadyWritten });
  const replayNext = await runOld({ inventoryAsOf: "2026-09-09", existingReader: alreadyWritten });
  ok("E (item 2): an unchanged lagging compact is a zero-write no-op in the SAME cycle AND the next cycle (no rewrite)",
    !replaySame.writes.length && replaySame.r.events.find((e) => e.account === "acctOld").status === "unchanged"
    && !replayNext.writes.length && replayNext.r.events.find((e) => e.account === "acctOld").status === "unchanged");
}

{
  // ROUND-4 Defect 1 -- authorization is DECOUPLED from the latest displayed snapshot. The operator passes cycleAsOf
  // to readLiveBrandInventory and authorizes SOLELY on the exact current-cycle publication. A reader that returns the
  // {to: cycleAsOf} placeholder authorizes; a reader that returns null (the priority did not publish this account for
  // THIS cycle -- revoked, or only earlier-cycle rows exist) fails closed. Publishing lagging inventory (a different
  // identity) never changes this reader's answer for the fresh cycle.
  const onlyFresh = [{ accountId: "acctFresh", country: "IN" }];
  const run = async (reader) => {
    const writes = [];
    const r = await runBrandInventoryRebuild({ region: "india", accounts: onlyFresh, inventoryAsOf: CYCLE, dryRun: false }, {
      readFbaPlan: async ({ accountId }) => plans[accountId] || null,
      readLiveBrandInventory: reader,
      readSnapshot: async () => null,
      persistSnapshot: async (u) => { writes.push(u); return { savedAt: u.sourceRefreshedAt }; },
    });
    return { r, writes };
  };
  // The operator MUST pass cycleAsOf to the reader (so the composition can do the exact paramsHash read).
  let sawCycle = null;
  const authorized = await run(async ({ accountId, cycleAsOf }) => { sawCycle = cycleAsOf; return accountId === "acctFresh" ? { params: { to: cycleAsOf }, payload: { inventoryAvailable: false }, source_refreshed_at: "2026-09-08T03:15:00Z" } : null; });
  ok("E (item 1): the operator passes cycleAsOf to readLiveBrandInventory and materializes when the exact-cycle publication exists",
    sawCycle === CYCLE && authorized.r.events.find((e) => e.account === "acctFresh").status === "materialized" && authorized.writes.some((x) => x.payload.inventoryAvailable === true));
  const denied = await run(async () => null); // no current-cycle publication (revoked / only older-cycle rows)
  ok("E (item 1): no current-cycle publication (exact-read null) fails closed -> skip, 0 writes",
    !denied.writes.length && denied.r.events.find((e) => e.account === "acctFresh").reason === "unauthorized-no-current-cycle-publication");
}

writeSync(1, `\nbrand-inventory-rebuild: ${passed} assertions passed\n`);
