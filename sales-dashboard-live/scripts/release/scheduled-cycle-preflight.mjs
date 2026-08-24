// TRUSTED, READ-ONLY cycle-identity preflight. Usage (run from sales-dashboard-live/, before the token gate):
//   node scripts/release/scheduled-cycle-preflight.mjs --bucket=us|non-us
//
// Classifies the (bucket, today) cycle BEFORE any token read or create, so a same-date terminal collision fails
// EARLY and clearly. Discovers the bucket's primary accounts via the DataDoe directory (zero tokens) -- NOT the
// heavy source runtime. Exit 0 = runnable (absent/running/already-complete); 1 = terminal-non-OLI collision or
// ambiguous cycle identity (the run must not proceed). Prints counts/dates/prefixes only.

import { loadReleaseEnv } from "./env-bootstrap.mjs";

loadReleaseEnv();

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const bucket = argOf("bucket");
if (bucket !== "us" && bucket !== "non-us") { console.error("STOP --bucket must be us|non-us (got: " + bucket + ")"); process.exit(2); }

const { getDataDoeConnections, classifyDirectoryAccounts } = await import("../../lib/server/datadoe-connections.js");
const { fetchAccounts } = await import("../../lib/server/datadoe.js");
const { bucketForCountry } = await import("../../lib/server/sync/registry.js");
const { getSyncCycleByBucketDate, getSyncSourceJobs, getSyncSourceJobOwnersForCycle } = await import("../../lib/server/supabase.js");
const { classifyScheduledOliCycle } = await import("../../lib/server/sync/source-scheduled-oli.js");

const today = new Date().toISOString().slice(0, 10);
const log = (m) => console.log("cycle-preflight[" + bucket + "@" + today + "]: " + m);

const connections = getDataDoeConnections();
const primaryConn = connections.find((c) => c.id === "primary");
const rows = (await fetchAccounts(primaryConn.apiKey)) || [];
const { active } = classifyDirectoryAccounts(rows, connections);
const seen = new Set();
const discovered = [];
for (const a of active) { const id = String((a && (a.accountId ?? a.id)) || "").trim(); const country = String((a && a.country) || "").toUpperCase(); if (!id || id.includes(":") || seen.has(id)) continue; if (bucketForCountry(country) !== bucket) continue; seen.add(id); discovered.push({ accountId: id }); }
if (!discovered.length) { console.error("STOP no discovered " + bucket + " primary accounts"); process.exit(1); }

let cycle = null;
try { cycle = await getSyncCycleByBucketDate(bucket, today); }
catch (e) { console.error("STOP SCHEDULED_CYCLE_AMBIGUOUS: more than one " + bucket + " cycle for " + today + " (refusing before the run): " + (e && e.message ? e.message : e)); process.exit(1); }

if (!cycle || !cycle.id) { log("no cycle for today -> runnable (a fresh cycle will be created)."); process.exit(0); }
const jobs = await getSyncSourceJobs(cycle.id);
const owners = await getSyncSourceJobOwnersForCycle(cycle.id);
const cls = classifyScheduledOliCycle({ bucket, cycle, discoveredAccounts: discovered, sourceJobs: jobs, owners });
const cid8 = String(cycle.id).slice(0, 8);
if (cls.disposition === "terminal-refuse" || cls.disposition === "refuse") {
  const why = cls.assessment ? [...new Set(cls.assessment.problems.map((p) => String(p).split(":")[0]))].join(",") : cls.reason;
  console.error("STOP SCHEDULED_CYCLE_TERMINAL_COLLISION: today's " + bucket + " cycle " + cid8 + " is terminal (" + String(cycle.status) + ") and is NOT a completed scheduled OLI run (" + why + "). The run must not proceed on this occupied slot; a fresh cycle date is required.");
  process.exit(1);
}
if (cls.disposition === "idempotent-complete") { log("cycle " + cid8 + " already holds a complete scheduled OLI run -> runnable (the operator will replay idempotently)."); process.exit(0); }
log("cycle " + cid8 + " is running -> runnable (OLI will continue on it)."); process.exit(0);
