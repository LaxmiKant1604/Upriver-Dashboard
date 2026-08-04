// Pure shaping of the read-only sync-status payload. No I/O, so it is unit-testable
// and carries the account-isolation guarantee: for a non-admin, the returned
// account set is EXACTLY scopeAccountIds, so even if a query somehow returned a
// row for another account it can never appear in the response.

export function shapeSyncStatus({ isAdmin, scopeAccountIds = [], reportKeys, labels = {}, directory = [], targets = [], snaps = [] }) {
  const dirById = new Map(directory.map((d) => [d.account_id, d]));
  const targetByKey = new Map(targets.map((t) => [`${t.account_id}|${t.report_key}`, t]));
  const snapLatest = new Map(); // snaps are ordered updated_at.desc -> first seen is newest
  for (const s of snaps) {
    const key = `${s.account_id}|${s.report_key}`;
    if (!snapLatest.has(key)) snapLatest.set(key, s);
  }

  const idSet = isAdmin
    ? new Set([...directory.map((d) => d.account_id), ...targets.map((t) => t.account_id)])
    : new Set(scopeAccountIds); // non-admin: strictly the caller's accounts

  const accounts = [...idSet].map((id) => ({
    accountId: id,
    name: dirById.get(id)?.name || id,
    bucket: dirById.get(id)?.sync_bucket || "unknown",
    reports: reportKeys.map((rk) => {
      const t = targetByKey.get(`${id}|${rk}`);
      const s = snapLatest.get(`${id}|${rk}`);
      return {
        reportKey: rk,
        label: labels[rk] || rk,
        lastStatus: t?.last_status || "pending",
        lastAttemptAt: t?.last_attempt_at || null,
        lastSuccessAt: t?.last_success_at || null,
        sourceRefreshedAt: t?.source_refreshed_at || s?.source_refreshed_at || null,
        latestDataDate: t?.latest_data_date || null,
        updatedAt: s?.updated_at || null,
        lastError: t?.last_error || null,
      };
    }),
  }));

  return { accounts, reportKeys };
}
