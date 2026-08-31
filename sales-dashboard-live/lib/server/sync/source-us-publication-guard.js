// US-only scheduler duplicate guard. This leaf selects the exact D-1 live identities that must already exist
// before a delayed/repeated US trigger may become a zero-write no-op. It performs no I/O and is kept separate so
// the production CLI and offline tests share one classifier.

export const US_PRIORITY_REPORT_KEYS = Object.freeze([
  "daily-reporting",
  "brand-sales",
  "brand-inventory",
]);

const S = (v) => String(v ?? "").trim();
const newestFirst = (a, b) => S(b && b.updated_at).localeCompare(S(a && a.updated_at));

export function selectPublishedUsD1Identities({ accountIds, requestedAsOf, rows, liveContracts, computeHash } = {}) {
  if (!Array.isArray(accountIds) || accountIds.length === 0) throw new Error("US publication guard requires accounts (fail closed).");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(S(requestedAsOf))) throw new Error("US publication guard requires requestedAsOf (fail closed).");
  if (!Array.isArray(rows) || !liveContracts || typeof computeHash !== "function") throw new Error("US publication guard collaborators missing (fail closed).");

  const ids = [...new Set(accountIds.map(S).filter(Boolean))].sort();
  if (ids.length !== accountIds.length) throw new Error("US publication guard account scope is blank/duplicate (fail closed).");

  const identities = [];
  const problems = [];
  for (const accountId of ids) {
    for (const reportKey of US_PRIORITY_REPORT_KEYS) {
      const contract = liveContracts[reportKey];
      if (!contract) throw new Error("US publication guard live contract missing for " + reportKey + " (fail closed).");
      const candidates = rows.filter((row) => {
        if (S(row && row.report_key) !== contract.liveReportKey || S(row && row.account_id) !== accountId) return false;
        const params = row && row.params && typeof row.params === "object" && !Array.isArray(row.params) ? row.params : null;
        if (!params || params.reportVersion !== contract.liveReportVersion) return false;
        const liveParams = contract.liveParams(params);
        if (!liveParams || S(liveParams.to) !== requestedAsOf) return false;
        if (reportKey === "daily-reporting" && S(liveParams.brand) !== "ALL") return false;
        return S(row.params_hash) !== "" && computeHash(contract.liveReportVersion, liveParams) === S(row.params_hash);
      }).sort(newestFirst);
      if (!candidates.length) {
        problems.push(reportKey + "/" + accountId.slice(0, 8) + ":missing-exact-d1");
        continue;
      }
      identities.push({
        reportKey,
        liveReportKey: contract.liveReportKey,
        accountId,
        paramsHash: S(candidates[0].params_hash),
      });
    }
  }
  return {
    complete: problems.length === 0 && identities.length === ids.length * US_PRIORITY_REPORT_KEYS.length,
    accountCount: ids.length,
    expectedCount: ids.length * US_PRIORITY_REPORT_KEYS.length,
    identities,
    problems,
  };
}
