import { addDays, monthStart } from "./format.js";

export const BRAND_SALES_REPORT_VERSION = "brand-sales-shared-v1";
export const BRAND_INVENTORY_REPORT_VERSION = "brand-inventory-shared-v1";
const SECONDARY_PREFIX = "dd-secondary:";

export function brandSalesRefreshParams(account, today) {
  const accountId = String(account?.id || "").trim();
  if (!accountId) throw new Error("A mapped account id is required.");
  if (!today) throw new Error("The marketplace business date is required.");
  return {
    action: "brand-sales",
    reportVersion: BRAND_SALES_REPORT_VERSION,
    ids: accountId,
    from: addDays(monthStart(today), -420),
    to: today,
  };
}

// Compact FBA inventory refresh for one account. It fetches at most one FBA
// Inventory Health export (reusing the preceding brand-sales catalog identity) and
// saves the { accountId, inventoryDate, inventoryAvailable, inventoryByBrandCountry }
// snapshot Brand View consumes before the legacy fba-plan / listing-health fallback.
export function brandInventoryRefreshParams(account, today) {
  const accountId = String(account?.id || "").trim();
  if (!accountId) throw new Error("A mapped account id is required.");
  if (!today) throw new Error("The marketplace business date is required.");
  return {
    action: "brand-inventory",
    reportVersion: BRAND_INVENTORY_REPORT_VERSION,
    ids: accountId,
    to: today,
  };
}

export function partitionBrandSourceAccounts(accounts) {
  const unique = new Map();
  for (const account of accounts || []) {
    const id = String(account?.id || "").trim();
    if (id && !unique.has(id)) unique.set(id, account);
  }
  const eligible = [];
  const skipped = [];
  for (const account of unique.values()) {
    if (String(account.id).startsWith(SECONDARY_PREFIX)) skipped.push(account);
    else eligible.push(account);
  }
  return { eligible, skipped };
}

/**
 * Temporary admin Brand View source refresh.
 *
 * For each mapped PRIMARY account, sequentially: (1) refresh brand-sales once, then
 * (2) refresh the compact brand-inventory once. The two steps are independent — one
 * failing does not stop the other or later accounts, and nothing is ever retried.
 * Legacy `dd-secondary:` mappings are skipped, never stripped and sent through the
 * primary DataDoe key. Returns per-source outcomes so the caller can report exactly
 * which accounts refreshed sales, refreshed inventory, or failed either.
 */
export async function refreshBrandSourceAccounts({
  accounts,
  refreshReport,
  todayForCountry,
  onProgress,
}) {
  if (typeof refreshReport !== "function") throw new Error("A report refresh function is required.");
  if (typeof todayForCountry !== "function") throw new Error("A marketplace date function is required.");

  const { eligible, skipped } = partitionBrandSourceAccounts(accounts);
  const results = [];

  for (let index = 0; index < eligible.length; index += 1) {
    const account = eligible[index];
    onProgress?.({ account, completed: index, total: eligible.length });
    const today = todayForCountry(account.country);
    const result = { account, sales: "failed", inventory: "failed", salesError: null, inventoryError: null };

    // 1) Brand Sales (Order Line Items + Product Catalog). Preserves the previous
    //    good snapshot on failure; never retried.
    try {
      await refreshReport(brandSalesRefreshParams(account, today));
      result.sales = "ok";
    } catch (error) {
      result.salesError = error;
    }

    // 2) Compact FBA inventory (one FBA Inventory Health export). Attempted
    //    independently of the sales step; preserves the previous good snapshot on
    //    failure; never retried.
    try {
      await refreshReport(brandInventoryRefreshParams(account, today));
      result.inventory = "ok";
    } catch (error) {
      result.inventoryError = error;
    }

    results.push(result);
  }
  onProgress?.({ account: null, completed: eligible.length, total: eligible.length });

  const salesSucceeded = results.filter((r) => r.sales === "ok").map((r) => r.account);
  const salesFailed = results.filter((r) => r.sales === "failed").map((r) => ({ account: r.account, error: r.salesError }));
  const inventorySucceeded = results.filter((r) => r.inventory === "ok").map((r) => r.account);
  const inventoryFailed = results.filter((r) => r.inventory === "failed").map((r) => ({ account: r.account, error: r.inventoryError }));

  return {
    attempted: eligible.length,
    results,
    salesSucceeded,
    salesFailed,
    inventorySucceeded,
    inventoryFailed,
    // An account "succeeded" when EITHER source refreshed, so the portfolio is
    // rebuilt whenever any new data was saved. "failed" means both sources failed.
    succeeded: results.filter((r) => r.sales === "ok" || r.inventory === "ok").map((r) => r.account),
    failed: results.filter((r) => r.sales === "failed" && r.inventory === "failed").map((r) => ({ account: r.account, error: r.salesError || r.inventoryError })),
    skipped,
  };
}
