// Recompute the durable OLI sales estimates for ONE account's window from durable truth (operational units +
// dimensional references) and atomically replace the estimate window. ZERO DataDoe -- it reads only already-fetched
// evidence, so a create-export is structurally impossible (no adapter in this path). Idempotent: the same durable
// evidence yields byte-identical estimate rows, and the window replace (delete + insert) removes any grain that has
// resolved (actual data arrived => no missing units => no estimate) so actual always supersedes with no double-count.
//
// Run AFTER every OLI persist (scheduler / manual sync / force-latest / self-heal) and by the standalone backfill,
// BEFORE the dependent dashboards are derived, so the enriched Total Sales reflects the latest estimates.

import { computeOliSalesEstimates, OLI_ESTIMATE_LOOKBACK_DAYS } from "./oli-sales-estimate.js";
import { addDaysStr } from "../date-windows.js";

const isDateStr = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ""));

/**
 * @param {object} args
 * @param {string} args.organizationFingerprint
 * @param {string} [args.connectionId='primary']
 * @param {string} args.accountId
 * @param {string} args.from  - persisted window start (YYYY-MM-DD)
 * @param {string} args.to    - persisted window end (YYYY-MM-DD)
 * @param {function} args.readOperationalUnits - ({organizationFingerprint,connectionId,accountIds,from,to,additiveOnly,signal}) => rows[]
 * @param {function} args.readDimensionalRows  - ({organizationFingerprint,connectionId,accountId,from,to,signal}) => rows[]
 * @param {function} args.writeEstimates        - ({organizationFingerprint,connectionId,accountId,coveredFrom,coveredTo,estimateRows,signal}) => {write,...}
 * @param {number} [args.lookbackDays=7]
 * @param {number} [args.precision=2]
 * @param {string} [args.calculatedAt]
 * @returns {Promise<{estimates:object[], unresolved:object[], write:object}>}
 */
export async function recomputeOliSalesEstimatesWindow({
  organizationFingerprint, connectionId = "primary", accountId, from, to,
  readOperationalUnits, readDimensionalRows, writeEstimates,
  lookbackDays = OLI_ESTIMATE_LOOKBACK_DAYS, precision = 2, calculatedAt = null, signal = null,
} = {}) {
  if (!organizationFingerprint || !accountId || !isDateStr(from) || !isDateStr(to) || from > to) {
    throw new Error("recomputeOliSalesEstimatesWindow requires organizationFingerprint/accountId and a valid from<=to window (fail closed).");
  }
  if (typeof readOperationalUnits !== "function" || typeof readDimensionalRows !== "function" || typeof writeEstimates !== "function") {
    throw new Error("recomputeOliSalesEstimatesWindow requires readOperationalUnits + readDimensionalRows + writeEstimates (fail closed).");
  }

  // 1. TARGETS: only grains that carry missing/zero-price units (additiveOnly keeps the read small; fully-priced
  //    grains can never produce an estimate). An empty result CLEARS the estimate window (idempotent resolve).
  const operationalRows = await readOperationalUnits({ organizationFingerprint, connectionId, accountIds: [accountId], from, to, additiveOnly: true, signal });
  if (!Array.isArray(operationalRows) || !operationalRows.length) {
    const write = await writeEstimates({ organizationFingerprint, connectionId, accountId, coveredFrom: from, coveredTo: to, estimateRows: [], signal });
    return { estimates: [], unresolved: [], write };
  }

  // 2. REFERENCES: the finest durable priced grain (dimensional history) for [minTargetDate - lookback, maxTargetDate].
  //    Bounded by the actual target dates so the reference read stays proportional to the missing-unit grains.
  const dates = operationalRows.map((r) => String(r.sale_date ?? r.saleDate ?? "")).filter(isDateStr);
  const minTarget = dates.reduce((m, d) => (d < m ? d : m), dates[0]);
  const maxTarget = dates.reduce((m, d) => (d > m ? d : m), dates[0]);
  const referenceRows = await readDimensionalRows({ organizationFingerprint, connectionId, accountId, from: addDaysStr(minTarget, -lookbackDays), to: maxTarget, signal });

  // 3. COMPUTE (pure) + 4. REPLACE the window (delete + insert; [] clears a fully-resolved window).
  const { estimates, unresolved } = computeOliSalesEstimates({ accountId, operationalRows, referenceRows: Array.isArray(referenceRows) ? referenceRows : [], maxLookbackDays: lookbackDays, precision, calculatedAt });
  const write = await writeEstimates({ organizationFingerprint, connectionId, accountId, coveredFrom: from, coveredTo: to, estimateRows: estimates, signal });
  return { estimates, unresolved, write };
}
