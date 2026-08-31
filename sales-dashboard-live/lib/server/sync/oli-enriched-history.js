// The ONE enriched durable-OLI read seam: the priced rollup (source_oli_daily_history) MERGED with the operational
// unit classes (source_oli_operational_units: explicit-zero + pending) AND the internal sales estimates
// (source_oli_sales_estimates) at the (account, date, sku, ASIN, currency) grain -- so EVERY OLI-derived UNIT + SALES
// surface (Daily Reporting, Brand View / Brand Sales, SKU Movement, Sales Dashboard) inherits BOTH the ordered units
// (priced + explicit-zero + pending) AND the actual-plus-estimated Total Sales through ONE calculation. Drop-in for
// getSourceOliHistoryRows: identical signature; every row gains `ordered_units` / `unpriced_units` (a priced-only
// caller keeps `units` = ordered = priced when there is no operational overlay).
//
// A blank child_asin on a pending/zero grain is RESOLVED to its unique ASIN (the SAME server-side resolver the
// estimator uses) so the overlay units co-locate with the estimate sales and attribute by ASIN; an unresolved grain
// keeps its blank ASIN and its units stay honestly unpriced. Cancelled units are never added; estimates never add
// units. NO DOUBLE-COUNT (the overlay adds only the classes the rollup excludes). Fail-soft + additive: if the
// operational / estimate / resolution / directory reads are unavailable, it degrades to the priced (or priced+
// estimate) rows -- it can never break or regress the priced read. RAW DataDoe evidence is never modified.

import {
  getSourceOliHistoryRows, getSourceOliSalesEstimateRows, getSourceOliOperationalUnitRows,
  getOliSkuAsinResolutionRows, getAccountDirectorySnapshotAccounts,
} from "../supabase.js";
import {
  mergeOrderedOliHistory, buildSkuAsinResolver,
  resolveUniqueMarketplaceByAccount, authoritativeMarketplace,
} from "./oli-sales-estimate.js";

const S = (v) => (v == null ? "" : String(v));

function groupByAccount(rows) {
  const m = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const a = S(r.account_id ?? r.accountId);
    let list = m.get(a);
    if (!list) { list = []; m.set(a, list); }
    list.push(r);
  }
  return m;
}

/**
 * The canonical ordered merge for a set of accounts, from injected readers. `marketplaceByAccount` is a Map
 * accountId -> AUTHORITATIVE canonical marketplace ("" when unknown/ambiguous => that account's blank-ASIN overlay
 * grains are NOT ASIN-resolved, so they stay honestly unpriced rather than guessed). Per account, it reads the
 * operational units (additive: explicit-zero + pending), the estimates, and the SKU->ASIN resolution, then merges.
 * Any per-source failure degrades that source to empty (never throws) so the priced Total Sales is never regressed.
 */
export async function enrichOrderedOliHistory({
  organizationFingerprint, connectionId = "primary", accountIds = null, from, to, historyRows,
  marketplaceByAccount = null, signal = null,
  readOperationalUnits = getSourceOliOperationalUnitRows,
  readEstimates = getSourceOliSalesEstimateRows,
  readSkuAsinResolution = getOliSkuAsinResolutionRows,
} = {}) {
  const accts = Array.isArray(accountIds) && accountIds.length
    ? [...new Set(accountIds.map(String))]
    : [...groupByAccount(historyRows).keys()].filter(Boolean);
  let operationalRows = [];
  let estimateRows = [];
  try { operationalRows = await readOperationalUnits({ organizationFingerprint, connectionId, accountIds: accts, from, to, additiveOnly: true, signal }); } catch { operationalRows = []; }
  try { estimateRows = await readEstimates({ organizationFingerprint, connectionId, accountIds: accts, from, to, signal }); } catch { estimateRows = []; }

  const hByA = groupByAccount(historyRows);
  const oByA = groupByAccount(operationalRows);
  const eByA = groupByAccount(estimateRows);
  const allAccounts = new Set([...hByA.keys(), ...oByA.keys(), ...eByA.keys()].filter(Boolean));

  let out = [];
  for (const accountId of allAccounts) {
    const oRows = oByA.get(accountId) || [];
    let resolver = null;
    // Only build a resolver when the account has a proven authoritative marketplace AND has blank-ASIN overlay
    // grains that need resolving (avoids a resolution read for accounts with nothing to resolve).
    const mkt = marketplaceByAccount instanceof Map ? S(marketplaceByAccount.get(accountId)) : "";
    const needsResolution = mkt && oRows.some((r) => S(r.child_asin ?? r.childAsin) === "" && S(r.sku) !== "" && ((Number(r.explicit_zero_units ?? r.explicitZeroUnits) || 0) + (Number(r.pending_units ?? r.pendingUnits) || 0)) > 0);
    if (needsResolution && typeof readSkuAsinResolution === "function") {
      try {
        const resRows = await readSkuAsinResolution({ organizationFingerprint, connectionId, accountId, signal });
        resolver = buildSkuAsinResolver({ accountMarketplace: mkt, historyRows: Array.isArray(resRows) ? resRows : [], catalogRows: [] });
      } catch { resolver = null; }
    }
    out = out.concat(mergeOrderedOliHistory({
      historyRows: hByA.get(accountId) || [], operationalRows: oRows, estimateRows: eByA.get(accountId) || [], skuAsinResolver: resolver,
    }));
  }
  return out;
}

// Resolve the authoritative marketplace per account from the account-directory snapshot (the ONE shared resolver;
// fail-closed missing/ambiguous). Fail-soft: any read failure yields an empty map (no ASIN resolution -> honest
// unpriced). Cached per (reader) invocation is unnecessary here -- the derive/serve call it once per read.
async function marketplaceMapFromDirectory(readDirectory) {
  try {
    const accounts = await readDirectory();
    const resolution = resolveUniqueMarketplaceByAccount(Array.isArray(accounts) ? accounts : []);
    const m = new Map();
    for (const a of (Array.isArray(accounts) ? accounts : [])) {
      const id = S(a && (a.accountId ?? a.account_id ?? a.id)).trim();
      if (id) m.set(id, authoritativeMarketplace(resolution, id));
    }
    return m;
  } catch { return new Map(); }
}

export function makeEnrichedOliHistoryReader({
  readHistory = getSourceOliHistoryRows,
  readEstimates = getSourceOliSalesEstimateRows,
  readOperationalUnits = getSourceOliOperationalUnitRows,
  readSkuAsinResolution = getOliSkuAsinResolutionRows,
  readDirectory = getAccountDirectorySnapshotAccounts,
} = {}) {
  return async function getEnrichedOliHistoryRows(args = {}) {
    const historyRows = await readHistory(args);
    if (!Array.isArray(historyRows)) return historyRows;
    // The authoritative marketplace per account (for blank-ASIN overlay resolution). Fail-soft -> empty map.
    const marketplaceByAccount = await marketplaceMapFromDirectory(readDirectory);
    try {
      return await enrichOrderedOliHistory({
        organizationFingerprint: args.organizationFingerprint, connectionId: args.connectionId,
        accountIds: args.accountIds, from: args.from, to: args.to, historyRows, marketplaceByAccount, signal: args.signal,
        readOperationalUnits, readEstimates, readSkuAsinResolution,
      });
    } catch {
      return historyRows; // additive layer: any merge failure never regresses the priced read
    }
  };
}

// The default production enriched reader (drop-in replacement for getSourceOliHistoryRows in the DERIVE paths).
export const getEnrichedOliHistoryRows = makeEnrichedOliHistoryReader();
