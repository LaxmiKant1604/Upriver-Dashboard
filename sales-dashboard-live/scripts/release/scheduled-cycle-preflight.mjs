// TRUSTED, READ-ONLY cycle-identity preflight. Usage (run from sales-dashboard-live/, before the token gate):
//   node scripts/release/scheduled-cycle-preflight.mjs --bucket=us|non-us
//
// Classifies the (scope, today) cycle BEFORE any token read or create, so a same-date terminal collision fails
// EARLY and clearly. Discovers the scope's primary accounts via the DataDoe directory (zero tokens) -- NOT the
// heavy source runtime. `--bucket` accepts a region (india|europe-au|us-ca) or a legacy bucket (us|non-us).
// Exit 0 = runnable (absent/running/already-complete); 1 = terminal-non-OLI collision or ambiguous cycle identity
// (the run must not proceed). Prints counts/dates/prefixes only.

import { loadReleaseEnv } from "./env-bootstrap.mjs";
import { accountInScope, isRoutingScope } from "../../lib/server/sync/scheduler-scope.js";

loadReleaseEnv();

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const bucket = argOf("bucket");
const accountScope = argOf("account-scope") || "full";
if (!isRoutingScope(bucket)) { console.error("STOP --bucket must be a routing scope (india|europe-au|us-ca|us|non-us; got: " + bucket + ")"); process.exit(2); }

// BOOTSTRAP scope: a same-date TERMINAL daily cycle is EXPECTED (the natural run already finished) and
// is handled by the OLI operator's durable SUPERSEDING-attempt model -- a collision refusal here would
// wrongly block every bootstrap dispatch. The preflight is therefore a typed no-op for bootstrap scope.
if (accountScope === "bootstrap") {
  console.log("cycle-preflight[" + bucket + "]: BOOTSTRAP scope -- preflight no-op (the superseding-attempt model owns same-date terminal heads).");
  process.exit(0);
}

const { getDataDoeConnections, classifyDirectoryAccounts } = await import("../../lib/server/datadoe-connections.js");
const { organizationFingerprint } = await import("../../lib/server/source-identity.js");
const { fetchAccountsDetailed } = await import("../../lib/server/datadoe.js");
const { fetchExportEligibleAccounts, classifyDiscoveryOutcome } = await import("../../lib/server/sync/account-onboarding.js");
const { getAccountOnboardingRows: readOnboardingRows } = await import("../../lib/server/supabase.js");
// EXPORT-ELIGIBILITY GATE: the cycle preflight scopes to the SAME export-eligible set the run will use.
const fetchAccounts = (apiKey) => fetchExportEligibleAccounts(apiKey, { fetchDetailed: fetchAccountsDetailed, readOnboardingRows });
const { getSyncCycleByBucketDate, getSyncSourceJobs, getSyncSourceJobOwnersForCycle, getSourceCoverageWindows } = await import("../../lib/server/supabase.js");
const { classifyScheduledOliCycle, assessDurableOliCoverageComplete } = await import("../../lib/server/sync/source-scheduled-oli.js");
const { sourceRegistryEntry } = await import("../../lib/server/sync/source-registry.js");

const today = new Date().toISOString().slice(0, 10);
const log = (m) => console.log("cycle-preflight[" + bucket + "@" + today + "]: " + m);

const connections = getDataDoeConnections();
const primaryConn = connections.find((c) => c.id === "primary");
const rows = (await fetchAccounts(primaryConn.apiKey)) || [];
const { active } = classifyDirectoryAccounts(rows, connections);
const seen = new Set();
const discovered = [];
for (const a of active) { const id = String((a && (a.accountId ?? a.id)) || "").trim(); const country = String((a && a.country) || "").toUpperCase(); if (!id || id.includes(":") || seen.has(id)) continue; if (!accountInScope(bucket, country)) continue; seen.add(id); discovered.push({ accountId: id }); }
if (!discovered.length) {
  // P1-4: typed discovery disposition instead of a generic "no accounts".
  const disp = classifyDiscoveryOutcome(rows);
  console.error("STOP " + (disp.deferred ? disp.message + " [bucket=" + bucket + "]" : "no export-eligible " + bucket + " primary accounts (discovery had eligible accounts in other regions)")); process.exit(1);
}

let cycle = null;
try { cycle = await getSyncCycleByBucketDate(bucket, today); }
catch (e) { console.error("STOP SCHEDULED_CYCLE_AMBIGUOUS: more than one " + bucket + " cycle for " + today + " (refusing before the run): " + (e && e.message ? e.message : e)); process.exit(1); }

if (!cycle || !cycle.id) { log("no cycle for today -> runnable (a fresh cycle will be created)."); process.exit(0); }
const jobs = await getSyncSourceJobs(cycle.id);
const owners = await getSyncSourceJobOwnersForCycle(cycle.id);
// DURABLE-COVERAGE evidence for the terminal-collision branch: when a same-date manual operation already made the
// cycle terminal, the day's OLI may nonetheless be durably complete -- prove it from source_coverage so the
// collision becomes a zero-create idempotent success instead of a false failure. Read-only, zero tokens.
let durableCoverage = null;
try {
  const oliStart = sourceRegistryEntry("order-line-items").initialBackfill.start;
  const asOf = new Date(Date.parse(today + "T00:00:00.000Z") - 86400000).toISOString().slice(0, 10);
  const orgFp = primaryConn.organizationFingerprint || organizationFingerprint(primaryConn.apiKey);
  const coverageByAccountId = {};
  for (const a of discovered) {
    const cov = await getSourceCoverageWindows({ organizationFingerprint: orgFp, connectionId: "primary", accountId: a.accountId, sourceKey: "order-line-items" });
    coverageByAccountId[a.accountId] = cov && cov.read === "ok" ? (cov.windows || []) : [];
  }
  durableCoverage = assessDurableOliCoverageComplete({ discoveredAccounts: discovered, coverageByAccountId, start: oliStart, asOf });
} catch (_e) { durableCoverage = null; } // unreadable coverage NEVER authorizes idempotence (fail closed to the strict path)
const cls = classifyScheduledOliCycle({ bucket, cycle, discoveredAccounts: discovered, sourceJobs: jobs, owners, durableCoverage });
const cid8 = String(cycle.id).slice(0, 8);
if (cls.disposition === "terminal-refuse" || cls.disposition === "refuse") {
  const why = cls.assessment ? [...new Set(cls.assessment.problems.map((p) => String(p).split(":")[0]))].join(",") : cls.reason;
  console.error("STOP SCHEDULED_CYCLE_UNREADABLE_COVERAGE: today's " + bucket + " cycle " + cid8 + " is terminal (" + String(cycle.status) + ") and its durable OLI coverage is UNREADABLE (" + why + "); refusing to classify freshness without evidence.");
  process.exit(1);
}
if (cls.disposition === "idempotent-complete") { log("cycle " + cid8 + " -> idempotent-complete (" + (cls.reason || "durable-coverage-complete") + "): runnable, zero creates."); process.exit(0); }
if (cls.disposition === "supersede") { log("cycle " + cid8 + " is terminal but durable coverage is BELOW D-1 (missing " + ((cls.missingAccounts || []).length) + " accounts) -> RUNNABLE via a durable superseding attempt (the terminal cycle stays immutable; never blocked)."); process.exit(0); }
log("cycle " + cid8 + " is " + String(cycle.status) + " -> runnable (OLI continues on it)."); process.exit(0);
