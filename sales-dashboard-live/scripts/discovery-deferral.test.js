// P1-4 reproduce-then-fix: the PRODUCTION discovery composition must PROPAGATE a typed deferral instead of
// collapsing every empty outcome into a generic "no accounts discovered". Drives the REAL fetchExportEligibleAccounts
// (over injected zero-token readers) + the REAL classifyDiscoveryOutcome. No network, no DataDoe, no tokens.
// 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
const SECRET = ["SUPABASE", "SECRET", "KEY"].join("_");
process.env[SECRET] = process.env[SECRET] || "test-secret";

const { fetchExportEligibleAccounts, classifyDiscoveryOutcome } = await import("../lib/server/sync/account-onboarding.js");

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); };
writeSync(1, "discovery-deferral\n");

const detAcct = (id, ready = true) => ({ id, name: id, readiness: { sellerCentralReady: ready } });
// Run the REAL gate with injected readers (zero-token). requireAuthoritativeScope defaults TRUE (paid path).
const discover = ({ detailed = [], onboardingRows = null, established = null } = {}) =>
  fetchExportEligibleAccounts("k", {
    fetchDetailed: async () => detailed,
    readOnboardingRows: async () => onboardingRows,
    readEstablishedAccountIds: established == null ? undefined : async () => established,
  });

/* ===== A. the four typed discovery states are DISTINGUISHED (not collapsed into one "empty") ===== */
{
  const eligible = await discover({ detailed: [detAcct("A1")], onboardingRows: [{ account_id: "A1", status: "ready" }] });
  ok("A1: an export-ready account => discoveryState 'eligible', not deferred", eligible.discoveryState === "eligible" && eligible.deferred === false && eligible.length === 1);

  const noScope = await discover({ detailed: [detAcct("A1"), detAcct("A2")], onboardingRows: [], established: [] });
  const unreadable = await discover({ detailed: [detAcct("A1"), detAcct("A2")], onboardingRows: null, established: null });
  ok("A2b: a FAILED/null scope read is a DISTINCT typed state (scope-unreadable), never mistaken for no-authoritative-scope", unreadable.discoveryState === "scope-unreadable" && unreadable.deferred === true && unreadable.length === 0 && classifyDiscoveryOutcome(unreadable).code === "scope-unreadable");
  ok("A2: accounts EXIST but NO authoritative scope => 'no-authoritative-scope', deferred, ZERO eligible",
    noScope.discoveryState === "no-authoritative-scope" && noScope.deferred === true && noScope.length === 0 && noScope.discoveredCount === 2);

  const awaiting = await discover({ detailed: [detAcct("A1")], onboardingRows: [{ account_id: "A1", status: "waiting_for_datadoe" }] });
  ok("A3: authoritative scope EXISTS but no account ready => 'all-awaiting-onboarding', deferred, ZERO eligible",
    awaiting.discoveryState === "all-awaiting-onboarding" && awaiting.deferred === true && awaiting.length === 0 && awaiting.hasAuthoritativeScope === true);

  const empty = await discover({ detailed: [], onboardingRows: [{ account_id: "Z", status: "ready" }] });
  ok("A4: an EMPTY directory => 'no-accounts-discovered', deferred", empty.discoveryState === "no-accounts-discovered" && empty.deferred === true && empty.discoveredCount === 0);
}

/* ===== B. the return value is still a byte-identical Array drop-in (metadata is NON-ENUMERABLE) ===== */
{
  const rows = await discover({ detailed: [detAcct("A1"), detAcct("A2")], onboardingRows: [{ account_id: "A1", status: "ready" }, { account_id: "A2", status: "ready" }] });
  ok("B1: the result IS a real Array", Array.isArray(rows) && rows.length === 2);
  ok("B2: JSON.stringify ignores the metadata (no leaked keys downstream)", JSON.stringify(rows) === JSON.stringify([...rows].map((r) => ({ ...r }))) || JSON.stringify(rows).startsWith("[{"));
  ok("B3: Object.keys of the array is only the numeric indices (metadata is non-enumerable)", Object.keys(rows).every((k) => /^\d+$/.test(k)));
  let iterated = 0; for (const _ of rows) iterated += 1;
  ok("B4: for-of iterates exactly the eligible accounts", iterated === 2);
  ok("B5: .map() works and returns a plain array of the eligible accounts", rows.map((r) => r.id).join(",") === "A1,A2");
}

/* ===== C. classifyDiscoveryOutcome turns each state into an HONEST typed disposition ===== */
{
  const outEligible = classifyDiscoveryOutcome(await discover({ detailed: [detAcct("A1")], onboardingRows: [{ account_id: "A1", status: "ready" }] }));
  ok("C1: eligible => not deferred, ok=true, code 'eligible'", outEligible.deferred === false && outEligible.ok === true && outEligible.code === "eligible");

  const outNoScope = classifyDiscoveryOutcome(await discover({ detailed: [detAcct("A1")], onboardingRows: [], established: [] }));
  ok("C2: no-authoritative-scope => deferred, ok=false, typed message names the reason + LKG + fail-closed",
    outNoScope.deferred === true && outNoScope.ok === false && outNoScope.code === "no-authoritative-scope"
    && /no-authoritative-scope/.test(outNoScope.message) && /fail closed/.test(outNoScope.message) && !/^no accounts discovered$/.test(outNoScope.message));

  const outAwaiting = classifyDiscoveryOutcome(await discover({ detailed: [detAcct("A1")], onboardingRows: [{ account_id: "A1", status: "bootstrapping" }] }));
  // 'bootstrapping' IS export-eligible -> this one is actually eligible, proving the classifier tracks real eligibility.
  ok("C3: a bootstrapping account is export-eligible (not falsely deferred)", outAwaiting.deferred === false && outAwaiting.code === "eligible");

  const outEmpty = classifyDiscoveryOutcome(await discover({ detailed: [], onboardingRows: [] }));
  ok("C4: empty directory => deferred, code 'no-accounts-discovered', never a false success", outEmpty.deferred === true && outEmpty.ok === false && outEmpty.code === "no-accounts-discovered");
}

/* ===== D. classifyDiscoveryOutcome degrades safely on a PLAIN array (no metadata) ===== */
{
  const plainFull = classifyDiscoveryOutcome([{ id: "A1" }]);
  ok("D1: a plain non-empty array => eligible (backward compatible)", plainFull.deferred === false && plainFull.code === "eligible");
  const plainEmpty = classifyDiscoveryOutcome([]);
  ok("D2: a plain empty array => deferred no-accounts-discovered (never false success)", plainEmpty.deferred === true && plainEmpty.code === "no-accounts-discovered");
}

/* ===== E. a brand-new id can NEVER bypass onboarding via the deferral path ===== */
{
  // populated onboarding table, but the discovered account has NO row => brand-new => excluded (not eligible).
  const brandNew = await discover({ detailed: [detAcct("NEW1")], onboardingRows: [{ account_id: "OTHER", status: "ready" }] });
  ok("E1: a brand-new id with no onboarding row is NEVER eligible (routed through onboarding, deferred here)",
    brandNew.length === 0 && brandNew.discoveryState === "all-awaiting-onboarding" && brandNew.deferred === true);
  // established directory evidence reconciles an EXISTING account without a row (never a brand-new one).
  const reconciled = await discover({ detailed: [detAcct("EST1"), detAcct("NEW2")], onboardingRows: null, established: ["EST1"] });
  ok("E2: an ESTABLISHED account reconciles (eligible) while a brand-new id stays excluded",
    reconciled.length === 1 && reconciled[0].id === "EST1" && reconciled.discoveryState === "eligible");
}

writeSync(1, `\ndiscovery-deferral: ${passed} checks passed\n`);
