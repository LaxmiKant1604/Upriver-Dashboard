// The ONE enriched durable-OLI read seam: the priced rollup (source_oli_daily_history) MERGED with the internal
// sales estimates (source_oli_sales_estimates) at the (account, date, sku, ASIN, currency) grain, so every OLI-
// derived SALES surface (Daily Reporting, Brand View / Brand Sales, Sales Dashboard) inherits the enriched Total
// Sales through ONE calculation. Drop-in for getSourceOliHistoryRows: identical signature, identical row shape
// (adds only estimated sales into sales_amount + synthetic rows for fully-unpriced grains; units are NEVER changed).
//
// Fail-soft + additive: if the estimate layer is unreadable/absent (pre-migration), it returns the priced rows
// unchanged -- it can never break or regress the priced read. RAW DataDoe evidence is never modified (read-only merge).

import { getSourceOliHistoryRows, getSourceOliSalesEstimateRows } from "../supabase.js";
import { enrichOliHistoryRowsWithEstimates } from "./oli-sales-estimate.js";

export function makeEnrichedOliHistoryReader({ readHistory = getSourceOliHistoryRows, readEstimates = getSourceOliSalesEstimateRows } = {}) {
  return async function getEnrichedOliHistoryRows(args = {}) {
    const historyRows = await readHistory(args);
    let estimateRows = [];
    try {
      estimateRows = await readEstimates({
        organizationFingerprint: args.organizationFingerprint,
        connectionId: args.connectionId,
        accountIds: args.accountIds,
        from: args.from,
        to: args.to,
        signal: args.signal,
      });
    } catch {
      estimateRows = []; // additive layer: an estimate-read failure never regresses the priced Total Sales
    }
    if (!Array.isArray(estimateRows) || !estimateRows.length) return historyRows;
    return enrichOliHistoryRowsWithEstimates(historyRows, estimateRows);
  };
}

// The default production enriched reader (drop-in replacement for getSourceOliHistoryRows in the DERIVE paths).
export const getEnrichedOliHistoryRows = makeEnrichedOliHistoryReader();
