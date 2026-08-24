// Scheduler v2 -- PURE assessment that the US scheduled run's prerequisite (a SUCCESSFUL same-asOf Non-US run)
// is satisfied, BEFORE any US DataDoe create or control write. The US derive reads durable Non-US OLI + ASIN Ads
// evidence, so this gate proves that evidence is complete for ALL 22 Non-US primary accounts. Fail-closed: any
// missing/short/gapped/unprovenanced/uncovered/failed account, or a missing/incomplete Non-US OLI cycle, blocks US.

const S = (v) => (v == null ? "" : String(v));

/**
 * Assess Non-US prerequisites for a US run at `asOf`. Inputs:
 *   asOf                 -- YYYY-MM-DD (the derive window end).
 *   adsWindowFrom/adsWindowTo -- the exact required rolling ASIN-Ads window.
 *   discoveredAccounts   -- freshly discovered Non-US primary accounts [{accountId}] (the ONLY allowed owner set).
 *   perAccount           -- per-account durable evidence [{ accountId, oliCoveredTo, oliGapless, oliProvenanceOk,
 *                            oliFailedOrOpen, adsWindowCovered, adsFailed }].
 *   cyclePresent         -- a (non-us, cycleDate) scheduled OLI cycle exists for this asOf.
 *   cycleOliAssessment   -- assessScheduledOliCycle over that cycle's OLI jobs (open=0): its owner union proves
 *                            exact account/owner isolation + a completed scheduled run.
 * Returns { ok, problems, accounts }.
 */
export function assessNonUsPrerequisites({ asOf, discoveredAccounts, perAccount, cyclePresent, cycleOliAssessment } = {}) {
  const problems = [];
  const at = S(asOf);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(at)) return { ok: false, problems: ["bad-asof:" + at], accounts: 0 };
  const discovered = [...new Set((discoveredAccounts || []).map((a) => S(a && (a.accountId ?? a)).trim()).filter(Boolean))].sort();
  if (!discovered.length) return { ok: false, problems: ["no-discovered-accounts"], accounts: 0 };
  const discoveredSet = new Set(discovered);
  const byId = new Map((perAccount || []).map((p) => [S(p && p.accountId), p]));

  for (const id of discovered) {
    const p = byId.get(id);
    if (!p) { problems.push("account-missing-evidence:" + id.slice(0, 8)); continue; }
    // 1. gapless durable OLI coverage THROUGH asOf.
    if (!(S(p.oliCoveredTo) && S(p.oliCoveredTo) >= at)) problems.push("oli-coverage-short:" + id.slice(0, 8) + ":" + S(p.oliCoveredTo));
    if (p.oliGapless !== true) problems.push("oli-coverage-gap:" + id.slice(0, 8));
    // 2. nonblank OLI provenance hashes -> succeeded canonical jobs.
    if (p.oliProvenanceOk !== true) problems.push("oli-provenance-blank:" + id.slice(0, 8));
    // 3. complete ASIN-Ads coverage for the exact required rolling window.
    if (p.adsWindowCovered !== true) problems.push("ads-coverage-incomplete:" + id.slice(0, 8));
    // 4. no failed/open scheduled source work for the required identities.
    if (p.oliFailedOrOpen === true) problems.push("oli-failed-or-open:" + id.slice(0, 8));
    if (p.adsFailed === true) problems.push("ads-failed:" + id.slice(0, 8));
  }

  // 6. successful Non-US scheduled run/cycle evidence for the SAME asOf.
  if (cyclePresent !== true) problems.push("nonus-cycle-missing");
  else if (!cycleOliAssessment || cycleOliAssessment.ok !== true) problems.push("nonus-cycle-oli-incomplete:" + (cycleOliAssessment ? [...new Set((cycleOliAssessment.problems || []).map((x) => String(x).split(":")[0]))].join(",") : "na"));

  // 5. exact account/owner isolation: no evidence account outside the freshly discovered primary set.
  for (const p of perAccount || []) if (!discoveredSet.has(S(p && p.accountId))) problems.push("evidence-account-outside-discovery");

  return { ok: problems.length === 0, problems: [...new Set(problems)], accounts: discovered.length };
}
