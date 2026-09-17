// Pure presentation-derivation helpers for the Portfolio Brand View page.
//
// No business logic and NO new formula: the KPI values are read from the tables
// the page already built and reuse the existing inventoryCoverDays() / tacos()
// helpers; the status ordering is a deterministic severity sort. Dependency-light
// so Node can unit-test it without a browser.

import { inventoryCoverDays, tacos } from "./brand-view.js";

/**
 * The six headline KPI values, derived from the built tables.
 *
 * MONEY (Total Sales, LY, Ad Spend, TACoS) is a single combined number ONLY when
 * there is exactly one currency group (converted mode, or a single-currency brand);
 * across several currency groups it stays null (an em dash), because money is never
 * summed across currencies.
 *
 * UNITS and FBA INVENTORY are unit counts and are never currency-specific, so a
 * single overall total is valid even across currency groups. Country-dimension
 * inventory sums each group's available units; an account-level (no-marketplace)
 * inventory uses the model's overall `daily.inventoryAccountTotal`. FBA is null (an
 * em dash) only when no overall total can be proven -- it is never invented or zero.
 * FBA COVER uses that overall inventory and the combined selected-range unit count
 * through the existing inventoryCoverDays() helper.
 */
export function portfolioKpis(tables) {
  const groups = tables?.dailyGroups || [];
  const single = groups.length === 1 ? groups[0] : null;
  const daily = tables?.daily || null;
  const fba = daily && daily.inventoryScope === "country"
    ? groups.reduce((acc, group) => (group.fbaAvailable === null || group.fbaAvailable === undefined)
      ? acc
      : (acc === null ? 0 : acc) + Number(group.fbaAvailable), null)
    : (daily && daily.inventoryAccountTotal !== null && daily.inventoryAccountTotal !== undefined
      ? Number(daily.inventoryAccountTotal)
      : null);
  const rangeUnits = groups.reduce((sum, group) => sum + group.rows.reduce((inner, row) => inner + (Number(row.coverUnits) || 0), 0), 0);
  const cover = daily?.selectedRangeDays ? inventoryCoverDays(fba, rangeUnits, daily.selectedRangeDays) : null;
  const sales = single ? single.totals.sales : null;
  const ly = single ? single.totals.lySales : null;
  const adSpend = single ? single.totals.adSpend : null;
  const lyDelta = sales != null && Number.isFinite(ly) && ly > 0 ? (sales - ly) / ly : null;
  return {
    single: Boolean(single), currency: single?.currency || null,
    sales, ly, lyDelta, units: tables?.totalUnits ?? null, fba, cover, adSpend, tacos: tacos(adSpend, sales),
  };
}

// Deterministic status severity: error > warning > success/final > informational/busy.
// The sort is explicitly stable (an index tiebreak) so nothing is dropped and the
// order within a severity tier is exactly the order the page appended it -- the
// highest-severity current condition is always first (the panel's compact head).
const STATUS_RANK = { error: 0, warning: 1, success: 2, info: 3 };
export function orderStatusItems(items) {
  return (Array.isArray(items) ? items : [])
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const ra = STATUS_RANK[a.item.tone] ?? 3;
      const rb = STATUS_RANK[b.item.tone] ?? 3;
      return ra !== rb ? ra - rb : a.index - b.index;
    })
    .map((entry) => entry.item);
}
