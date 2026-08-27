// Scheduler v2 -- PURE assessment that the US scheduled run's prerequisite (complete same-asOf Non-US EVIDENCE)
// is satisfied, BEFORE any US DataDoe create or control write. The US derive reads durable Non-US OLI + ASIN Ads
// evidence, so this gate proves that evidence is complete for ALL Non-US primary accounts. Fail-closed on any
// missing/short/gapped/unprovenanced/uncovered/failed account. The cycle-shape check is SECONDARY provenance:
// with fully green durable evidence, a missing/non-scheduled-shape cycle (manual run, adopted export) is a note.

import { resolveEffectivePublishAsOf, MAX_PUBLISH_TAIL_LAG_DAYS } from "./source-durable-model.js";

const S = (v) => (v == null ? "" : String(v));

/**
 * Assess Non-US prerequisites for a US run at `asOf`. Inputs:
 *   asOf                 -- YYYY-MM-DD (the derive window end).
 *   adsWindowFrom/adsWindowTo -- the exact required rolling ASIN-Ads window.
 *   discoveredAccounts   -- freshly discovered Non-US primary accounts [{accountId}] (the ONLY allowed owner set).
 *   perAccount           -- per-account durable evidence [{ accountId, oliCoveredTo, oliGapless, oliProvenanceOk,
 *                            oliFailedOrOpen, adsWindowCovered, adsFailed, adsUnavailable }]. adsUnavailable=true
 *                            means the account's DataDoe connection has NO ASIN-Ads source (Amazon Ads not
 *                            connected) -- a TYPED UNAVAILABLE state: its ads checks become a note, never a
 *                            blocker (the account joins automatically once connected; OLI checks still apply).
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
  const adsUnavailableNotes = [];

  for (const id of discovered) {
    const p = byId.get(id);
    if (!p) { problems.push("account-missing-evidence:" + id.slice(0, 8)); continue; }
    // 1. gapless durable OLI coverage THROUGH asOf.
    if (!(S(p.oliCoveredTo) && S(p.oliCoveredTo) >= at)) problems.push("oli-coverage-short:" + id.slice(0, 8) + ":" + S(p.oliCoveredTo));
    if (p.oliGapless !== true) problems.push("oli-coverage-gap:" + id.slice(0, 8));
    // 2. nonblank OLI provenance hashes -> succeeded canonical jobs.
    if (p.oliProvenanceOk !== true) problems.push("oli-provenance-blank:" + id.slice(0, 8));
    // 3. complete ASIN-Ads coverage for the exact required rolling window. An ads-DISCONNECTED account (no
    // ASIN-Ads source on its DataDoe connection) is TYPED UNAVAILABLE -- noted, never a blocker: the US derive
    // represents it as ads-unavailable downstream, and it joins automatically once Amazon Ads is connected.
    if (p.adsUnavailable === true) adsUnavailableNotes.push(id.slice(0, 8));
    else {
      if (p.adsWindowCovered !== true) problems.push("ads-coverage-incomplete:" + id.slice(0, 8));
      if (p.adsFailed === true) problems.push("ads-failed:" + id.slice(0, 8));
    }
    // 4. no failed/open scheduled source work for the required identities.
    if (p.oliFailedOrOpen === true) problems.push("oli-failed-or-open:" + id.slice(0, 8));
  }

  // 5. exact account/owner isolation: no evidence account outside the freshly discovered primary set.
  for (const p of perAccount || []) if (!discoveredSet.has(S(p && p.accountId))) problems.push("evidence-account-outside-discovery");

  // 6. Non-US run/cycle evidence for the SAME asOf -- EVIDENCE-FIRST: the per-account durable checks above (OLI
  // gapless-through-asOf with provenance, exact ads-window coverage, nothing failed/open, no out-of-discovery
  // evidence) are the AUTHORITATIVE prerequisite, because the US derive reads exactly that durable evidence. The
  // cycle-shape check is secondary provenance: when every durable check is green, a missing or non-scheduled-shape
  // cycle (e.g. the day's Non-US work arrived via a MANUAL Data Sync Center run or an adopted export) is a NOTE,
  // not a blocker -- otherwise legitimate complete evidence would strand the US run. When any durable check
  // FAILED, the cycle problems are reported too (they help locate the gap).
  const durableComplete = problems.length === 0;
  const cycleProblems = [];
  if (cyclePresent !== true) cycleProblems.push("nonus-cycle-missing");
  else if (!cycleOliAssessment || cycleOliAssessment.ok !== true) cycleProblems.push("nonus-cycle-oli-incomplete:" + (cycleOliAssessment ? [...new Set((cycleOliAssessment.problems || []).map((x) => String(x).split(":")[0]))].join(",") : "na"));
  const notes = [];
  if (adsUnavailableNotes.length) notes.push("ads-unavailable-note:" + adsUnavailableNotes.join(",") + " (Amazon Ads not connected in DataDoe; typed unavailable, not blocking)");
  if (durableComplete && cycleProblems.length) notes.push("cycle-shape-note:" + cycleProblems.join("|") + " (durable evidence complete; not blocking)");
  if (!durableComplete) problems.push(...cycleProblems);

  return { ok: problems.length === 0, problems: [...new Set(problems)], notes, accounts: discovered.length };
}

/**
 * HONEST per-bucket publish readiness (Scheduler v2 independent buckets). Unlike assessNonUsPrerequisites (the
 * legacy strict US-depends-on-Non-US gate that demanded coverage THROUGH the exact requested asOf), this proves a
 * SINGLE bucket can publish honestly at its OWN effectivePublishAsOf:
 *   - requestedAsOf   -- the date the scheduler tried to refresh (calendar "yesterday").
 *   - effectivePublishAsOf = the latest COMMON gapless durable-OLI date across ONLY this bucket's discovered
 *     accounts (resolveEffectivePublishAsOf), clamped back over at most `maxTailLagDays` (default 2) days of
 *     trailing DataDoe settlement lag. A normal trailing tail publishes honestly through that date and reports
 *     UPSTREAM_TAIL_LAG; an INTERIOR/LEADING historical hole, UNREADABLE coverage, BLANK provenance, or a tail lag
 *     BEYOND the cap FAILS CLOSED (never a fabricated or silently very-old publish).
 * Ads coverage is NEVER a blocker here (the derive publishes the OLI sales half regardless -- ads is blocksSales
 * false; an ads-disconnected account is typed unavailable). Ads/cycle facts are surfaced as NOTES only.
 *
 * Inputs: { bucket, requestedAsOf, from (OLI fixed start), maxTailLagDays, discoveredAccounts:[{accountId}],
 *   coverageByAccountId:{id: windows[]|null}, provenanceBlankByAccountId:{id:bool}, adsCoveredByAccountId,
 *   adsFailedByAccountId, adsUnavailableByAccountId, cyclePresent, cycleOliAssessment }.
 * Returns { ok, bucket, requestedAsOf, effectiveAsOf, tailLagDays, status, accounts, problems, notes }.
 */
export function assessBucketPublishReadiness({
  bucket, requestedAsOf, from, maxTailLagDays = MAX_PUBLISH_TAIL_LAG_DAYS,
  discoveredAccounts, coverageByAccountId = {}, provenanceBlankByAccountId = {},
  adsCoveredByAccountId = {}, adsFailedByAccountId = {}, adsUnavailableByAccountId = {},
  cyclePresent, cycleOliAssessment,
} = {}) {
  const problems = [];
  const notes = [];
  const fail = (p) => ({ ok: false, bucket, requestedAsOf, effectiveAsOf: null, tailLagDays: null, status: "blocked", accounts: 0, problems: [p], notes });
  if (bucket !== "us" && bucket !== "non-us") return fail("bad-bucket:" + S(bucket));
  const at = S(requestedAsOf);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(at)) return fail("bad-requested-asof:" + at);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(S(from))) return fail("bad-from:" + S(from));
  const discovered = [...new Set((discoveredAccounts || []).map((a) => S(a && (a.accountId ?? a)).trim()).filter((s) => s && !s.includes(":")))].sort();
  if (!discovered.length) return fail("no-discovered-accounts");

  // Coverage windows per account: an UNREADABLE read (null) is a fail-closed problem AND is passed to the resolver
  // as an empty window (so it also drives effectiveAsOf to null); blank provenance on existing rows fails closed.
  const coverageForResolver = {};
  for (const id of discovered) {
    const cov = (coverageByAccountId || {})[id];
    if (cov == null) { problems.push("oli-coverage-unreadable:" + id.slice(0, 8)); coverageForResolver[id] = []; }
    else coverageForResolver[id] = cov;
    if ((provenanceBlankByAccountId || {})[id] === true) problems.push("oli-provenance-blank:" + id.slice(0, 8));
  }

  // The HONEST effective publish as-of over ONLY this bucket's accounts (bounded 2-day settlement tail).
  const eff = resolveEffectivePublishAsOf({ coverageByAccountId: coverageForResolver, accountIds: discovered, from: S(from), refreshAsOf: at, maxTailLagDays });
  for (const b of eff.blockers || []) problems.push("oli-" + S(b.reason) + (b.accountId ? ":" + S(b.accountId).slice(0, 8) : ""));

  // Ads is INFORMATIONAL only (never blocks the OLI sales publish). Surface unavailable / incomplete / failed as
  // notes so the run summary is honest, but they never set ok=false.
  const adsUnavailable = discovered.filter((id) => (adsUnavailableByAccountId || {})[id] === true);
  const adsIncomplete = discovered.filter((id) => !(adsUnavailableByAccountId || {})[id] && (adsCoveredByAccountId || {})[id] !== true);
  const adsFailed = discovered.filter((id) => !(adsUnavailableByAccountId || {})[id] && (adsFailedByAccountId || {})[id] === true);
  if (adsUnavailable.length) notes.push("ads-unavailable-note:" + adsUnavailable.length + " (Amazon Ads not connected; typed unavailable, non-blocking; OLI sales still publish)");
  if (adsIncomplete.length) notes.push("ads-incomplete-note:" + adsIncomplete.length + " (ASIN-Ads window not fully covered; non-blocking -- ads never blocks the sales half)");
  if (adsFailed.length) notes.push("ads-failed-note:" + adsFailed.length + " (non-blocking)");

  // The bucket's OWN scheduled OLI cycle is SECONDARY provenance: when the durable OLI evidence is complete, a
  // missing / non-scheduled-shape cycle (a manual Data Sync Center OLI run, an adopted export) is a NOTE. When the
  // durable evidence FAILED, the cycle problems are reported alongside (they help locate the gap).
  const oliDurableComplete = problems.length === 0;
  const cycleProblems = [];
  if (cyclePresent !== true) cycleProblems.push("cycle-missing");
  else if (!cycleOliAssessment || cycleOliAssessment.ok !== true) cycleProblems.push("cycle-oli-incomplete:" + (cycleOliAssessment ? [...new Set((cycleOliAssessment.problems || []).map((x) => String(x).split(":")[0]))].join(",") : "na"));
  if (oliDurableComplete && cycleProblems.length) notes.push("cycle-shape-note:" + cycleProblems.join("|") + " (durable evidence complete; not blocking)");
  if (!oliDurableComplete) problems.push(...cycleProblems);

  const ok = problems.length === 0;
  if (ok && eff.status === "UPSTREAM_TAIL_LAG") notes.push("UPSTREAM_TAIL_LAG: requested " + at + " but published through " + eff.effectiveAsOf + " (" + eff.tailLagDays + "d settlement tail; the next rolling refresh advances it once DataDoe settles).");
  return {
    ok,
    bucket,
    requestedAsOf: at,
    effectiveAsOf: ok ? eff.effectiveAsOf : null,
    tailLagDays: eff.tailLagDays,
    status: ok ? eff.status : (eff.status === "TAIL_LAG_EXCEEDED" ? "TAIL_LAG_EXCEEDED" : "blocked"),
    accounts: discovered.length,
    problems: [...new Set(problems)],
    notes,
  };
}
