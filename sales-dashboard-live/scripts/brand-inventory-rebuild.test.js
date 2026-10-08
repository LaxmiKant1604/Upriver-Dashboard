// Defect A regression: the compact brand-inventory is REBUILT from each account's FRESH fba-plan snapshot (the DI-only
// rebuild core; the production path is the fenced FBA / OLI reconcilers). Since the Listings inventory cutover PHASE 2
// the fba-plan and the compact record their per-account INVENTORY SOURCE (inventorySource: "listings" -- validated
// Listings, no inventory date, listingsRefreshedAt = the Listings fetch time; "health-fallback" -- the last FBA
// Inventory Health snapshot, labelled with its date; "unavailable"). Proves the pure adapter (phase-2 shape ONLY -- a
// pre-phase-2 Health plan never becomes a v2 compact), the compact gate + serve selection, Brand View's fold (null ->
// Unavailable, never a partial sum), the source-promoted publish gate, per-account zero-vs-missing (never a fabricated
// zero), and newer-only LKG protection. Offline, ZERO export. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import {
  compactInventoryFromFbaPlanPayload, isCompactInventorySnapshot, brandInventory, selectAuthoritativeInventorySnapshot,
  BRAND_INVENTORY_REPORT_VERSION,
} from "../lib/server/reports/brand-view.js";
import { runBrandInventoryRebuild, compactInventoryContentFingerprint } from "../lib/server/sync/report-materialization-brandview-operation.js";

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); };
writeSync(1, "brand-inventory-rebuild (Defect A)\n");

// ---- pure adapter ------------------------------------------------------------------------------------------------
const FRESH_AT = "2026-09-08T16:30:00.000Z";
const listingsPlan = (over = {}) => ({
  inventoryModel: "listings-v1", inventorySource: "listings", inventoryListingsReasons: [], inventoryHealthDate: null,
  inventoryAvailable: true, inventoryUnavailableReason: null, inventoryDate: null, listingsRefreshedAt: FRESH_AT,
  inventoryConflicts: [], ...over,
});
const freshPlan = listingsPlan({ inventoryByBrandCountry: [
  { country: "IN", brand: "Acme", fbaAvailable: 120, skuCount: 3 }, { country: "IN", brand: "Beta", fbaAvailable: 0, skuCount: 1 },
] });
const compact = compactInventoryFromFbaPlanPayload(freshPlan, "acctFresh");
ok("A: adapter builds a phase-2 Listings compact from a Listings fba-plan (no inventory date; listingsRefreshedAt + source preserved; rows preserved)",
  compact && compact.inventoryModel === "listings-v1" && compact.inventorySource === "listings" && compact.inventoryAvailable === true
  && compact.inventoryDate === null && compact.inventoryHealthDate === null && compact.listingsRefreshedAt === FRESH_AT
  && compact.inventoryUnavailableReason === null && compact.inventoryConflicts === 0 && compact.accountId === "acctFresh" && compact.inventoryByBrandCountry.length === 2);
ok("A: a genuine 0 (validated) is preserved, not dropped", compact.inventoryByBrandCountry.find((e) => e.brand === "Beta").fbaAvailable === 0);
ok("A: fba-plan with no available inventory => null (never a fabricated zero; leave existing compact)",
  compactInventoryFromFbaPlanPayload(listingsPlan({ inventoryAvailable: false, inventoryByBrandCountry: [] }), "x") === null
  && compactInventoryFromFbaPlanPayload(listingsPlan({ inventorySource: "unavailable", inventoryAvailable: false, inventoryByBrandCountry: [] }), "x") === null);
ok("A: a Listings plan without a parseable Listings fetch time => null (never a fabricated freshness)",
  compactInventoryFromFbaPlanPayload(listingsPlan({ listingsRefreshedAt: null, inventoryByBrandCountry: [] }), "x") === null
  && compactInventoryFromFbaPlanPayload(listingsPlan({ listingsRefreshedAt: "bad", inventoryByBrandCountry: [] }), "x") === null);
ok("A: a malformed (negative/non-finite) fold quantity => null (preserve previous compact)",
  compactInventoryFromFbaPlanPayload(listingsPlan({ inventoryByBrandCountry: [{ country: "IN", brand: "Z", fbaAvailable: -5 }] }), "x") === null
  && compactInventoryFromFbaPlanPayload(listingsPlan({ inventoryByBrandCountry: [{ country: "IN", brand: "Z", fbaAvailable: "abc" }] }), "x") === null);
const withUnknown = compactInventoryFromFbaPlanPayload(listingsPlan({ inventoryConflicts: [{ sku: "S9", asins: ["B09"], reasons: ["duplicate-different-quantities"] }], inventoryByBrandCountry: [
  { country: "IN", brand: "Acme", fbaAvailable: null, skuCount: 2 }, { country: "IN", brand: "Beta", fbaAvailable: 7, skuCount: 1 },
] }), "acctU");
ok("A: an UNKNOWN (null) bucket is carried as null -- never coerced to 0; the conflict list is counted",
  withUnknown && withUnknown.inventoryByBrandCountry.find((e) => e.brand === "Acme").fbaAvailable === null && withUnknown.inventoryByBrandCountry.find((e) => e.brand === "Beta").fbaAvailable === 7 && withUnknown.inventoryConflicts === 1);
// A phase-2 HEALTH-FALLBACK plan becomes a Health-fallback compact labelled with its Health date (never as Listings).
const fallbackPlan = listingsPlan({ inventorySource: "health-fallback", inventoryListingsReasons: ["listings-not-expanded"], inventoryHealthDate: "2026-09-07", inventoryDate: "2026-09-07", listingsRefreshedAt: null,
  inventoryByBrandCountry: [{ country: "IN", brand: "Acme", fbaAvailable: 90, skuCount: 2 }] });
const fbCompact = compactInventoryFromFbaPlanPayload(fallbackPlan, "acctFb");
ok("A: a Health-fallback plan -> a Health-fallback compact (its Health date; no Listings freshness; reasons kept)",
  fbCompact && fbCompact.inventorySource === "health-fallback" && fbCompact.inventoryHealthDate === "2026-09-07" && fbCompact.inventoryDate === "2026-09-07"
  && fbCompact.listingsRefreshedAt === null && fbCompact.inventoryListingsReasons[0] === "listings-not-expanded");
ok("A: a Health-fallback plan without its Health date => null", compactInventoryFromFbaPlanPayload({ ...fallbackPlan, inventoryHealthDate: null, inventoryDate: null }, "x") === null);
// A PRE-PHASE-2 (FBA Inventory Health) fba-plan: no inventorySource -- NEVER rebuilt into a v2 compact.
const healthPlan = { inventoryAvailable: true, inventorySnapshotDate: "2026-09-08", inventoryByBrandCountry: [{ country: "IN", brand: "Acme", fbaAvailable: 120, skuCount: 3 }] };
ok("A: a pre-phase-2 Health-based fba-plan (no inventorySource) => null (the source decision was never made for it)", compactInventoryFromFbaPlanPayload(healthPlan, "x") === null);
ok("A: a plan of ANOTHER model => null", compactInventoryFromFbaPlanPayload({ ...freshPlan, inventoryModel: "health-v0" }, "x") === null);

// The rebuilt compact is a VALID compact snapshot the Brand View consumer reads through its gate.
const asSnapshot = { params: { reportVersion: BRAND_INVENTORY_REPORT_VERSION, to: "2026-09-08" }, payload: compact };
ok("A: the compact version is v2 and the rebuilt compact passes isCompactInventorySnapshot", BRAND_INVENTORY_REPORT_VERSION === "brand-inventory-shared-v2" && isCompactInventorySnapshot(asSnapshot) === true);
ok("A: a v1-LABELLED row carrying the phase-2 shape is NOT a compact (the v1 gate accepts only the legacy Health shape)", isCompactInventorySnapshot({ params: { reportVersion: "brand-inventory-shared-v1", to: "2026-09-08" }, payload: compact }) === false);
const inv = brandInventory(compact, "Acme", "IN");
ok("A: Brand View folds the compact to per-country FBA available (120 for Acme/IN), country scope, complete total", inv.byCountry.get("IN") === 120 && inv.scope === "country" && inv.accountTotal === 120 && inv.unknown === false && inv.source === "brand-inventory" && inv.inventorySource === "listings");
const invUnknown = brandInventory(withUnknown, "Acme", "IN");
ok("A: an unknown bucket folds to null for the country AND the account total (never a partial sum)", invUnknown.byCountry.get("IN") === null && invUnknown.accountTotal === null && invUnknown.unknown === true && invUnknown.scope === "country");
const invHealth = brandInventory(healthPlan, "Acme", "IN", "fba-plan");
ok("A: a pre-phase-2 Health payload is served as LEGACY Health, labelled with its snapshot date (never as Listings)", invHealth.scope === "country" && invHealth.inventorySource === "health-legacy" && invHealth.healthDate === "2026-09-08" && invHealth.listingsRefreshedAt === null && invHealth.byCountry.get("IN") === 120);
ok("A: a phase-2 payload with inventoryAvailable:false is 'unavailable'", brandInventory(listingsPlan({ inventoryAvailable: false, inventoryByBrandCountry: [] }), "Acme", "IN").scope === "unavailable");
const absent = brandInventory(compact, "NoSuchBrand", "IN");
ok("A: a brand absent from the buckets has NO FBA figure (empty map, no total), never a 0", absent.byCountry.size === 0 && absent.accountTotal === null && absent.scope === "country");

// ---- serve selection: v2 preferred; the legacy v1 serves only when no available v2 exists -------------------------
{
  const row = (version, payload, refreshed) => ({ params: { reportVersion: version, to: "2026-09-08" }, payload, source_refreshed_at: refreshed, updated_at: refreshed });
  const v2Listings = row(BRAND_INVENTORY_REPORT_VERSION, compact, "2026-09-08T17:00:00Z");
  const v1Newer = row("brand-inventory-shared-v1", { inventoryAvailable: true, inventoryDate: "2026-09-09", inventoryByBrandCountry: [{ country: "IN", brand: "Acme", fbaAvailable: 999, skuCount: 1 }] }, "2026-09-09T23:00:00Z");
  ok("S: a NEWER, AVAILABLE v1 (Health) compact never beats an available v2 compact", selectAuthoritativeInventorySnapshot([v1Newer, v2Listings]) === v2Listings);
  ok("S: a set holding ONLY v1 compacts selects the v1 (the transition window: production stock is never hidden)", selectAuthoritativeInventorySnapshot([v1Newer]) === v1Newer);
  ok("S: ... and Brand View labels it as FBA Inventory Health with its date", brandInventory(v1Newer.payload, "Acme", "IN").inventorySource === "health-legacy" && brandInventory(v1Newer.payload, "Acme", "IN").healthDate === "2026-09-09");
  const v2NoSource = row(BRAND_INVENTORY_REPORT_VERSION, { inventoryAvailable: true, inventoryDate: "2026-09-09", inventoryByBrandCountry: [{ country: "IN", brand: "Acme", fbaAvailable: 999, skuCount: 1 }] }, "2026-09-09T23:00:00Z");
  ok("S: a v2-labelled payload without the phase-2 source is never a compact", selectAuthoritativeInventorySnapshot([v2NoSource]) === null && selectAuthoritativeInventorySnapshot([v2NoSource, v2Listings]) === v2Listings);
  const older = row(BRAND_INVENTORY_REPORT_VERSION, { ...compact, listingsRefreshedAt: "2026-09-07T16:30:00.000Z" }, "2026-09-10T03:00:00Z");
  ok("S: among Listings compacts the NEWEST Listings fetch time wins (not the newest updated_at)", selectAuthoritativeInventorySnapshot([older, v2Listings]) === v2Listings);
  const placeholder = row(BRAND_INVENTORY_REPORT_VERSION, { ...compact, inventorySource: "unavailable", inventoryAvailable: false, listingsRefreshedAt: null, inventoryUnavailableReason: "no-validated-listings;no-fba-inventory-health-snapshot", inventoryByBrandCountry: [] }, "2026-09-10T03:15:00Z");
  ok("S: an available Listings compact is preferred over a newer unavailable placeholder", selectAuthoritativeInventorySnapshot([placeholder, v2Listings]) === v2Listings);
}

// ---- operator: CYCLE-BOUND authorization + content-aware idempotency + zero-vs-missing + newer-only -----------
const CYCLE = "2026-09-08"; // inventory_asof (D-1) threaded from the run job
const OLD_AT = "2026-09-02T16:30:00.000Z"; // a LAGGING Listings fetch time
const accounts = [
  { accountId: "acctFresh", country: "IN" },     // authorized THIS cycle + fresh Listings fba-plan -> materialize available
  { accountId: "acctNoInv", country: "IN" },     // authorized + fba-plan no inventory -> leave existing (unavailable)
  { accountId: "acctOld", country: "IN" },       // authorized + lagging Listings fba-plan (LKG) -> rebuild with its REAL fetch time
  { accountId: "acctHealth", country: "IN" },    // authorized + a PRE-PHASE-2 Health fba-plan -> never rebuilt (unavailable)
  { accountId: "acctUnauth", country: "IN" },    // NO live compact at all -> skip
  { accountId: "acctOldCycle", country: "IN" },  // live compact from a PREVIOUS cycle (params.to != CYCLE) -> skip
];
const plans = {
  acctFresh: { payload: freshPlan, source_refreshed_at: "2026-09-08T16:40:00Z" },
  acctNoInv: { payload: listingsPlan({ inventorySource: "unavailable", inventoryAvailable: false, listingsRefreshedAt: null, inventoryUnavailableReason: "listings-not-validated-and-no-health-snapshot", inventoryByBrandCountry: [] }), source_refreshed_at: "2026-09-08T16:40:00Z" },
  acctOld: { payload: listingsPlan({ listingsRefreshedAt: OLD_AT, inventoryByBrandCountry: [{ country: "IN", brand: "Acme", fbaAvailable: 40, skuCount: 1 }] }), source_refreshed_at: "2026-09-02T16:40:00Z" },
  acctHealth: { payload: healthPlan, source_refreshed_at: "2026-09-08T16:40:00Z" },
  acctUnauth: { payload: freshPlan, source_refreshed_at: "2026-09-08T16:40:00Z" },
  acctOldCycle: { payload: freshPlan, source_refreshed_at: "2026-09-08T16:40:00Z" },
};
// The priority run published a live compact (placeholder) THIS cycle for the authorized accounts -- params.to = the
// cycle's D-1. acctUnauth has NO row; acctOldCycle's ONLY row is from a PREVIOUS cycle (params.to = an earlier D-1).
const liveCompacts = {
  acctFresh: { params: { to: CYCLE }, payload: { inventoryAvailable: false }, source_refreshed_at: "2026-09-08T03:15:00Z" },
  acctNoInv: { params: { to: CYCLE }, payload: { inventoryAvailable: false }, source_refreshed_at: "2026-09-08T03:15:00Z" },
  acctOld: { params: { to: CYCLE }, payload: { inventoryAvailable: false }, source_refreshed_at: "2026-09-08T03:15:00Z" },
  acctHealth: { params: { to: CYCLE }, payload: { inventoryAvailable: false }, source_refreshed_at: "2026-09-08T03:15:00Z" },
  acctOldCycle: { params: { to: "2026-09-05" }, payload: { inventoryAvailable: true, inventoryByBrandCountry: [] }, source_refreshed_at: "2026-09-05T03:15:00Z" },
};
// Authorization is the EXACT current-cycle publication -- the operator reads the brand-inventory row whose
// params.to === cycleAsOf. This harness returns the account's live row ONLY when it was published for the requested cycle.
const exactLive = async ({ accountId, cycleAsOf }) => {
  const r = liveCompacts[accountId];
  return (r && String((r.params && r.params.to) || "") === String(cycleAsOf || "")) ? r : null;
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
  ok("B: authorized fresh + lagging accounts materialize; no-inventory AND pre-phase-2 Health plan unavailable; no-row + old-cycle skipped",
    JSON.stringify(byAcct("materialized")) === JSON.stringify(["acctFresh", "acctOld"])
    && JSON.stringify(byAcct("unavailable")) === JSON.stringify(["acctHealth", "acctNoInv"])
    && JSON.stringify(byAcct("skipped")) === JSON.stringify(["acctOldCycle", "acctUnauth"]));
  ok("B: a pre-phase-2 Health fba-plan writes NOTHING (LKG kept)", !writes.find((w) => w.accountId === "acctHealth") && r.events.find((e) => e.account === "acctHealth").preservedLkg === true);
  ok("B (item 2): a live compact from a PREVIOUS cycle (params.to != inventory_asof) is NOT authorized via the exact-read -> skip, 0 writes",
    r.events.find((e) => e.account === "acctOldCycle").reason === "unauthorized-no-current-cycle-publication" && !writes.find((w) => w.accountId === "acctOldCycle"));
  ok("B: the no-row account is skipped 'unauthorized-no-current-cycle-publication'", r.events.find((e) => e.account === "acctUnauth").reason === "unauthorized-no-current-cycle-publication");
  ok("B: exactly two live compact writes; none for missing-inventory, Health, no-row, or old-cycle", writes.length === 2);
  const fresh = writes.find((w) => w.accountId === "acctFresh");
  ok("B: the fresh compact carries the fba-plan provenance + the v2 compact report version + the cycle identity + a content depFingerprint",
    fresh.sourceRefreshedAt === "2026-09-08T16:40:00Z" && fresh.params.reportVersion === BRAND_INVENTORY_REPORT_VERSION && fresh.params.to === CYCLE && typeof fresh.params.depFingerprint === "string");
  ok("B: the fresh compact is phase-2 Listings with NO inventory date and the plan's Listings fetch time",
    fresh.payload.inventoryModel === "listings-v1" && fresh.payload.inventorySource === "listings" && fresh.payload.inventoryDate === null && fresh.payload.listingsRefreshedAt === FRESH_AT);
  const old = writes.find((w) => w.accountId === "acctOld");
  ok("B: the LKG account rebuilds with its REAL older Listings fetch time (Sep 2), never relabeled fresh", old.payload.listingsRefreshedAt === OLD_AT && old.payload.inventoryAvailable === true && old.payload.inventoryDate === null);
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
  // ITEM 1: the existing row is the priority placeholder (inventoryAvailable:false) whose source_refreshed_at EQUALS the
  // fresh fba-plan's, with NO stored fingerprint. The content fingerprint must WRITE the false -> true change.
  const eqPlaceholder = async ({ reportKey, accountId }) => (reportKey === "brand-inventory" && accountId === "acctFresh"
    ? { params: { reportVersion: BRAND_INVENTORY_REPORT_VERSION, to: CYCLE }, payload: { inventoryAvailable: false, inventoryByBrandCountry: [] }, source_refreshed_at: "2026-09-08T16:40:00Z" } // EQUAL timestamp to plans.acctFresh
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
    ? { params: { reportVersion: BRAND_INVENTORY_REPORT_VERSION, to: CYCLE, depFingerprint: freshFp }, payload: freshCompact, source_refreshed_at: "2026-09-08T16:40:00Z" }
    : null);
  const { r, writes } = await runRebuild({ existingReader: alreadyWritten });
  ok("C (item 1): a same-content replay is a zero-write 'unchanged' (content fingerprint matches)",
    !writes.find((w) => w.accountId === "acctFresh") && r.events.find((e) => e.account === "acctFresh").status === "unchanged");
  ok("C: a content change (120 -> 121) changes the fingerprint", compactInventoryContentFingerprint({ ...freshCompact, inventoryByBrandCountry: [{ country: "IN", brand: "Acme", fbaAvailable: 121, skuCount: 3 }, freshCompact.inventoryByBrandCountry[1]] }) !== freshFp);
  ok("C: an unknown -> 0 change and a SOURCE change change the fingerprint (null is never hashed as 0)",
    compactInventoryContentFingerprint({ ...freshCompact, inventoryByBrandCountry: [{ country: "IN", brand: "Acme", fbaAvailable: null, skuCount: 3 }] })
      !== compactInventoryContentFingerprint({ ...freshCompact, inventoryByBrandCountry: [{ country: "IN", brand: "Acme", fbaAvailable: 0, skuCount: 3 }] })
    && compactInventoryContentFingerprint({ ...freshCompact, inventorySource: "health-fallback" }) !== freshFp);
}

{
  // PLACEHOLDER COLLISION: the existing same-identity placeholder carries a NEWER source_refreshed_at. It must NOT
  // suppress the fresh inventoryAvailable:true fold (newer-only preserves only a genuinely newer AVAILABLE compact).
  const placeholderNewer = async ({ reportKey, accountId }) => (reportKey === "brand-inventory" && accountId === "acctFresh"
    ? { params: { reportVersion: BRAND_INVENTORY_REPORT_VERSION, to: CYCLE }, payload: { inventoryAvailable: false, inventoryByBrandCountry: [] }, source_refreshed_at: "2026-09-09T03:15:00Z" } : null);
  const { writes } = await runRebuild({ existingReader: placeholderNewer });
  const fresh = writes.find((w) => w.accountId === "acctFresh");
  ok("C: an inventoryAvailable:false placeholder with a newer timestamp does NOT suppress the fresh available fold",
    !!fresh && fresh.payload.inventoryAvailable === true);
}

{
  // NEWER-ONLY (genuine): an existing AVAILABLE compact newer than this fba-plan is preserved (LKG), not overwritten.
  const newerAvailable = async ({ reportKey, accountId }) => (reportKey === "brand-inventory" && accountId === "acctFresh"
    ? { params: { reportVersion: BRAND_INVENTORY_REPORT_VERSION, to: CYCLE }, payload: { inventoryAvailable: true, inventoryByBrandCountry: [{ country: "IN", brand: "Acme", fbaAvailable: 999 }] }, source_refreshed_at: "2026-09-09T00:00:00Z" } : null);
  const { r, writes } = await runRebuild({ existingReader: newerAvailable });
  ok("D: a genuinely newer AVAILABLE compact is preserved (no overwrite of newer LKG)",
    !writes.find((w) => w.accountId === "acctFresh") && r.events.find((e) => e.account === "acctFresh").reason === "existing-newer-available");
}

{
  // LAGGING inventory idempotency is PURE CONTENT. Listings has no inventory date, so the rebuild writes the authorized
  // current-cycle identity {to: cycleAsOf} with the plan's REAL (older) fetch time in the payload; an unchanged lagging
  // compact must NEVER be rewritten -- in the same cycle OR a later cycle (no fabricated freshness).
  const onlyOld = [{ accountId: "acctOld", country: "IN" }];
  const laggingCompact = compactInventoryFromFbaPlanPayload(plans.acctOld.payload, "acctOld");
  const laggingContentFp = compactInventoryContentFingerprint(laggingCompact);
  const runOld = async ({ inventoryAsOf, existingReader }) => {
    const writes = [];
    const r = await runBrandInventoryRebuild({ region: "india", accounts: onlyOld, inventoryAsOf, dryRun: false }, {
      readFbaPlan: async ({ accountId }) => plans[accountId] || null,
      readLiveBrandInventory: async ({ accountId, cycleAsOf }) => (accountId === "acctOld"
        ? { params: { to: cycleAsOf }, payload: { inventoryAvailable: false }, source_refreshed_at: "2026-09-08T03:15:00Z" } : null),
      readSnapshot: existingReader || (async () => null),
      persistSnapshot: async (u) => { writes.push(u); return { savedAt: u.sourceRefreshedAt }; },
    });
    return { r, writes };
  };
  const first = await runOld({ inventoryAsOf: CYCLE });
  const w = first.writes.find((x) => x.accountId === "acctOld");
  ok("E (item 2): a lagging compact writes the cycle identity with its REAL fetch time and the PURE content fingerprint",
    !!w && w.params.to === CYCLE && w.payload.listingsRefreshedAt === OLD_AT && w.payload.inventoryAvailable === true && w.params.depFingerprint === laggingContentFp);
  const alreadyWritten = async ({ accountId }) => (accountId === "acctOld"
    ? { params: { reportVersion: BRAND_INVENTORY_REPORT_VERSION, to: CYCLE, depFingerprint: laggingContentFp }, payload: laggingCompact, source_refreshed_at: "2026-09-02T16:40:00Z" } : null);
  const replaySame = await runOld({ inventoryAsOf: CYCLE, existingReader: alreadyWritten });
  const replayNext = await runOld({ inventoryAsOf: "2026-09-09", existingReader: alreadyWritten });
  ok("E (item 2): an unchanged lagging compact is a zero-write no-op in the SAME cycle AND the next cycle (no rewrite)",
    !replaySame.writes.length && replaySame.r.events.find((e) => e.account === "acctOld").status === "unchanged"
    && !replayNext.writes.length && replayNext.r.events.find((e) => e.account === "acctOld").status === "unchanged");
}

{
  // Authorization is DECOUPLED from the latest displayed snapshot: the operator passes cycleAsOf to readLiveBrandInventory
  // and authorizes SOLELY on the exact current-cycle publication.
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
  let sawCycle = null;
  const authorized = await run(async ({ accountId, cycleAsOf }) => { sawCycle = cycleAsOf; return accountId === "acctFresh" ? { params: { to: cycleAsOf }, payload: { inventoryAvailable: false }, source_refreshed_at: "2026-09-08T03:15:00Z" } : null; });
  ok("E (item 1): the operator passes cycleAsOf to readLiveBrandInventory and materializes when the exact-cycle publication exists",
    sawCycle === CYCLE && authorized.r.events.find((e) => e.account === "acctFresh").status === "materialized" && authorized.writes.some((x) => x.payload.inventoryAvailable === true));
  const denied = await run(async () => null);
  ok("E (item 1): no current-cycle publication (exact-read null) fails closed -> skip, 0 writes",
    !denied.writes.length && denied.r.events.find((e) => e.account === "acctFresh").reason === "unauthorized-no-current-cycle-publication");
}

writeSync(1, `\nbrand-inventory-rebuild: ${passed} assertions passed\n`);
