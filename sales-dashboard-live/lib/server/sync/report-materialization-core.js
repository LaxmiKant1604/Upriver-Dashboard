// Shared, injectable materialization primitives used by BOTH scheduler materializers -- the per-account
// report-materialization-operation.js (brand-view-brands, sku-movement, returns-leakage) and the FBA-aware
// report-materialization-brandview-operation.js (brand-view + brand-view-portfolio). ONE definition of the idempotent,
// LKG-preserving, isolated, zero-write-on-dry-run snapshot upsert so the two operators can never drift.
//
// materializeSnapshot writes ZERO on a not-ready derive (preserving LKG), ZERO on a dry-run, and ZERO on an unchanged
// identity (same source provenance already stored -- a replay/watchdog no-op); otherwise it upserts under the EXACT
// (reportKey, accountId, paramsHash) identity the serve reads. It performs NO DataDoe/token work (only the injected
// durable readers/writer). `accountId` is the snapshot key -- a raw account id for the per-account reports, or a
// brand-view scope id (brandViewScopeId / brandViewPortfolioScopeId) for the Brand View reports.

import { paramsHashFor } from "../report-store.js";

export async function materializeSnapshot({
  reportKey, reportVersion, accountId, params, scopeLabel, derived,
  dryRun = false, now = () => new Date(),
  readSnapshot, persistSnapshot, claimLock = async () => true, releaseLock = async () => {},
}) {
  if (!derived || derived.notReady || !derived.payload) {
    return {
      report: reportKey, account: accountId, scope: scopeLabel, status: "unavailable", preservedLkg: true, tokens: 0,
      blockedBy: (derived && derived.blockedBy) || (derived && derived.notReady ? [{ reason: String(derived.notReady) }] : []),
    };
  }
  const paramsHash = paramsHashFor(reportVersion, params);
  const sourceRefreshedAt = derived.sourceRefreshedAt || null;
  if (dryRun) {
    return { report: reportKey, account: accountId, scope: scopeLabel, status: "planned", paramsHash, sourceRefreshedAt, tokens: 0 };
  }
  // Cheap idempotency probe: the exact identity is already stored with the same source provenance -> nothing to do.
  if (typeof readSnapshot === "function") {
    const existing = await readSnapshot({ reportKey, accountId, paramsHash });
    if (existing && existing.payload && sourceRefreshedAt
        && String(existing.source_refreshed_at || "") === String(sourceRefreshedAt)) {
      return { report: reportKey, account: accountId, scope: scopeLabel, status: "unchanged", paramsHash, sourceRefreshedAt, tokens: 0 };
    }
  }
  const locked = await claimLock({ reportKey, accountId, paramsHash });
  if (!locked) {
    return { report: reportKey, account: accountId, scope: scopeLabel, status: "locked-skip", paramsHash, tokens: 0 };
  }
  try {
    if (typeof readSnapshot === "function") {
      const fresh = await readSnapshot({ reportKey, accountId, paramsHash });
      if (fresh && fresh.payload && sourceRefreshedAt
          && String(fresh.source_refreshed_at || "") === String(sourceRefreshedAt)) {
        return { report: reportKey, account: accountId, scope: scopeLabel, status: "unchanged", paramsHash, sourceRefreshedAt, tokens: 0 };
      }
    }
    const saved = await persistSnapshot({
      reportKey, reportVersion, accountId, paramsHash,
      params: { reportVersion, ...params },
      payload: derived.payload,
      sourceRefreshedAt: sourceRefreshedAt || undefined,
    });
    return {
      report: reportKey, account: accountId, scope: scopeLabel, status: "materialized",
      paramsHash, sourceRefreshedAt: (saved && saved.savedAt) || sourceRefreshedAt, tokens: 0,
    };
  } finally {
    await releaseLock({ reportKey, accountId, paramsHash }).catch(() => {});
  }
}

// Isolate one unit of work so a single throw becomes an "error" event and never aborts the run. Pushes onto `events`.
export async function runUnit(events, fn, ctx) {
  try { const ev = await fn(); events.push(ev); return ev; }
  catch (e) { const ev = { ...ctx, status: "error", tokens: 0, error: (e && e.message) || String(e) }; events.push(ev); return ev; }
}

export function summarize(events) {
  const s = { accounts: 0, units: 0, materialized: 0, unchanged: 0, unavailable: 0, planned: 0, locked: 0, error: 0, skipped: 0, tokens: 0 };
  const accounts = new Set();
  for (const e of events || []) {
    s.units += 1;
    if (e.account && e.account !== "*") accounts.add(e.account);
    s.tokens += Number(e.tokens || 0);
    if (e.status === "materialized") s.materialized += 1;
    else if (e.status === "unchanged") s.unchanged += 1;
    else if (e.status === "unavailable") s.unavailable += 1;
    else if (e.status === "planned") s.planned += 1;
    else if (e.status === "locked-skip") s.locked += 1;
    else if (e.status === "error") s.error += 1;
    else if (e.status === "skipped") s.skipped += 1;
  }
  s.accounts = accounts.size;
  return s;
}
