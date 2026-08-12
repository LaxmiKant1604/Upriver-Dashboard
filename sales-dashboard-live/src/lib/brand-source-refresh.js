import { addDays, monthStart } from "./format.js";

export const BRAND_SALES_REPORT_VERSION = "brand-sales-shared-v1";
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

export async function refreshBrandSourceAccounts({
  accounts,
  refreshReport,
  todayForCountry,
  onProgress,
}) {
  if (typeof refreshReport !== "function") throw new Error("A report refresh function is required.");
  if (typeof todayForCountry !== "function") throw new Error("A marketplace date function is required.");

  const { eligible, skipped } = partitionBrandSourceAccounts(accounts);
  const succeeded = [];
  const failed = [];

  for (let index = 0; index < eligible.length; index += 1) {
    const account = eligible[index];
    onProgress?.({ account, completed: index, total: eligible.length });
    try {
      const today = todayForCountry(account.country);
      await refreshReport(brandSalesRefreshParams(account, today));
      succeeded.push(account);
    } catch (error) {
      failed.push({ account, error });
    }
  }
  onProgress?.({ account: null, completed: eligible.length, total: eligible.length });

  return {
    attempted: eligible.length,
    succeeded,
    failed,
    skipped,
  };
}
