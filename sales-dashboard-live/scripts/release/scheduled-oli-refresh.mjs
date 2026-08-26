// TRUSTED, DEFERRED scheduled OLI (order-line-items) refresh operator for ONE bucket.
// Usage (run from sales-dashboard-live/, in the reviewed GitHub Actions scheduler):
//   node scripts/release/scheduled-oli-refresh.mjs --bucket=us|non-us [--as-of=YYYY-MM-DD]
//
// It refreshes the durable canonical OLI history for exactly ONE bucket and NOTHING else:
//   - builds the REAL production source runtime with a LONG operator deadline (this is a 90-min CI job, not a
//     60s Vercel route), runs its preflight ONCE and reuses the memoized evidence;
//   - executes ONLY the order-line-items family through runSourceCardAction (one family at a time), resuming
//     bounded on the SAME cycle until the family is drained (open === 0);
//   - then PROVES (assessScheduledOliCycle) the outcome: every job is OLI + succeeded, owner-scoped to the exact
//     discovered primary accounts, create_export_count <= 1, batch <= 5 sellers, and creates/tokens within the
//     per-bucket ceiling (US 2 batches/4 tokens, Non-US 5 batches/10 tokens);
//   - exits NONZERO on any failed / open / ambiguous / deadline-exhausted outcome.
// It NEVER runs Catalog/Ads/FBA/any other family, NEVER derives or publishes a report, NEVER touches controls,
// and NEVER prints a seller/account/export id (only counts + an 8-char cycle prefix).

import { loadReleaseEnv } from "./env-bootstrap.mjs";

loadReleaseEnv(); // portable: loads <repoRoot>/.env.local when present, maps SUPABASE_URL, never overrides CI env

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const bucket = argOf("bucket");
const asOf = argOf("as-of");
if (bucket !== "us" && bucket !== "non-us") { console.error("STOP --bucket must be us|non-us (got: " + bucket + ")"); process.exit(2); }
if (asOf != null && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) { console.error("STOP --as-of must be YYYY-MM-DD (got: " + asOf + ")"); process.exit(2); }

const { buildBucketSourceSyncRuntime } = await import("../../lib/server/sync/source-bucket-sync-runtime.js");
const { getSyncSourceJobs, getSyncSourceJobOwnersForCycle, getSyncCycleByBucketDate, getSourceCoverageWindows } = await import("../../lib/server/supabase.js");
const { OLI_SOURCE_KEY } = await import("../../lib/server/sync/source-durable-model.js");
const { assessScheduledOliCycle, classifyScheduledOliCycle, assessDurableOliCoverageComplete } = await import("../../lib/server/sync/source-scheduled-oli.js");
const { sourceRegistryEntry } = await import("../../lib/server/sync/source-registry.js");
const { getDataDoeConnections } = await import("../../lib/server/datadoe-connections.js");
const { organizationFingerprint } = await import("../../lib/server/source-identity.js");
const { runCycleCreateReconcile } = await import("../../lib/server/sync/source-create-reconcile-driver.js");

const OLI = OLI_SOURCE_KEY;
// A LONG operator deadline for the CI job (the workflow allots >=90 min); overridable for tests/ops. MAX_ITERS is
// a hard backstop so a stuck family can never loop forever -- the assessment still fails closed on open>0.
const BUDGET_MS = Number(process.env.SCHEDULED_OLI_BUDGET_MS || 80 * 60 * 1000);
const MAX_ITERS = Number(process.env.SCHEDULED_OLI_MAX_ITERS || 200);
const log = (m) => console.log("scheduled-oli[" + bucket + (asOf ? "@" + asOf : "") + "]: " + m);
const isOpen = (j) => { const st = j.fetch_status ?? j.fetchStatus; return st === "pending" || st === "attempted"; };
const oliOpenCount = (jobs) => jobs.filter((j) => (j.source_key ?? j.sourceKey) === OLI && isOpen(j)).length;

const runtime = buildBucketSourceSyncRuntime({ budgetMs: BUDGET_MS, asOfOverride: asOf });
const deadline = runtime.makeDeadline();
const outOfTime = () => (deadline && typeof deadline.outOfTime === "function" ? deadline.outOfTime() : false);
const preflight = await runtime.preflightEvidence({ bucket, sourceKey: OLI, deadline });
const discovered = (preflight.accounts || [])
  .map((a) => ({ accountId: String(a.accountId) }))
  .filter((a) => a.accountId && !a.accountId.includes(":"));
if (!discovered.length) { console.error("STOP no discovered primary accounts for bucket " + bucket); process.exit(1); }
log("preflight ok: " + discovered.length + " primary accounts; running order-line-items only");

// CYCLE-IDENTITY PRE-CHECK (before any create): the scheduled OLI run uses the (bucket, today) cycle. If a cycle
// already exists for today, classify it -- a running/absent cycle runs OLI; an ALREADY-COMPLETE scheduled OLI
// cycle is an idempotent same-day replay (zero re-fetch); a TERMINAL cycle that is NOT a completed OLI run (e.g.
// a same-date catalog / priority-release cycle) is a typed refusal, so the run never appends OLI to a terminal
// cycle nor assesses an unrelated cycle as its own. getSyncCycleByBucketDate fails closed on >1 cycle for the
// (bucket, date) -- a typed ambiguous-cycle refusal.
const today = String(preflight.today || "");
if (!today) { console.error("STOP SCHEDULED_OLI_NO_CYCLE_DATE: preflight returned no cycle date"); process.exit(1); }
let existingCycle = null;
try {
  existingCycle = await getSyncCycleByBucketDate(bucket, today);
} catch (e) {
  console.error("STOP SCHEDULED_OLI_AMBIGUOUS_CYCLE: more than one " + bucket + " cycle for " + today + " (cycle identity is ambiguous; refusing before any create): " + (e && e.message ? e.message : e));
  process.exit(1);
}
if (existingCycle && existingCycle.id) {
  const existingJobs = await getSyncSourceJobs(existingCycle.id);
  const existingOwners = await getSyncSourceJobOwnersForCycle(existingCycle.id);
  // DURABLE-COVERAGE evidence for a terminal collision: a same-date MANUAL operation (catalog / priority release /
  // a manual OLI run) may have made the cycle terminal while the day's OLI is durably complete. Prove it from
  // source_coverage (read-only, zero tokens) so the collision is a zero-create idempotent success -- never an
  // append to the terminal cycle, and never a false failure. Unreadable coverage stays null (strict path).
  let durableCoverage = null;
  try {
    const oliStart = sourceRegistryEntry(OLI).initialBackfill.start;
    const covAsOf = asOf || new Date(Date.parse(today + "T00:00:00.000Z") - 86400000).toISOString().slice(0, 10);
    const covPrimary = getDataDoeConnections().find((c) => c && c.id === "primary" && String(c.apiKey || "").trim());
    const orgFp = covPrimary.organizationFingerprint || organizationFingerprint(covPrimary.apiKey);
    const coverageByAccountId = {};
    for (const acct of discovered) {
      const cov = await getSourceCoverageWindows({ organizationFingerprint: orgFp, connectionId: "primary", accountId: acct.accountId, sourceKey: OLI });
      coverageByAccountId[acct.accountId] = cov && cov.read === "ok" ? (cov.windows || []) : [];
    }
    durableCoverage = assessDurableOliCoverageComplete({ discoveredAccounts: discovered, coverageByAccountId, start: oliStart, asOf: covAsOf });
  } catch (_e) { durableCoverage = null; }
  const cls = classifyScheduledOliCycle({ bucket, cycle: existingCycle, discoveredAccounts: discovered, sourceJobs: existingJobs, owners: existingOwners, durableCoverage });
  const cid8 = String(existingCycle.id).slice(0, 8);
  if (cls.disposition === "terminal-refuse" || cls.disposition === "refuse") {
    const why = cls.assessment ? [...new Set(cls.assessment.problems.map((p) => String(p).split(":")[0]))].join(",") : cls.reason;
    console.error("STOP SCHEDULED_OLI_TERMINAL_CYCLE: the " + today + " " + bucket + " cycle " + cid8 + " is terminal (" + String(existingCycle.status) + ") and is NOT a completed scheduled OLI run (" + why + "), and durable OLI coverage is INCOMPLETE" + (durableCoverage ? " (missing " + durableCoverage.missingAccounts.length + " accounts)" : " (coverage unreadable)") + ". Refusing to append OLI to a terminal cycle -- ZERO creates.");
    process.exit(1);
  }
  if (cls.disposition === "idempotent-complete") {
    log("idempotent (" + (cls.reason || "scheduled-oli-run-complete") + "): the " + today + " " + bucket + " cycle " + cid8 + " -> the day's OLI evidence is already complete; no re-fetch, ZERO new creates.");
    process.exit(0);
  }
  // disposition "run": a RUNNING cycle -> continue OLI below.
  log("cycle " + cid8 + " is running; continuing OLI on it.");
}

let cycleId = null;
let iter = 0;
let prevOpen = Infinity;
let stall = 0;
while (iter < MAX_ITERS) {
  iter += 1;
  const res = await runtime.runSourceCardAction({ bucket, sourceKey: OLI, deadline, preflight });
  if (res && res.refused === true) { console.error("STOP runSourceCardAction refused: " + (res.code || "unknown")); process.exit(1); }
  cycleId = (res && res.cycleId) || cycleId;
  if (!cycleId) { console.error("STOP no cycle id after runSourceCardAction (nothing planned)"); process.exit(1); }
  const jobs = await getSyncSourceJobs(cycleId);
  const open = oliOpenCount(jobs);
  log("iter " + iter + ": cycle=" + String(cycleId).slice(0, 8) + " oli_open=" + open);
  if (open === 0) break;
  if (outOfTime()) { log("operator deadline reached with open=" + open); break; }
  stall = open >= prevOpen ? stall + 1 : 0;
  prevOpen = open;
  if (stall >= 2) { log("no progress for 2 consecutive resumptions; stopping"); break; }
}

// Network failure class 4 (ambiguous create): a typed create-stage failure whose create may have LANDED at
// DataDoe is NEVER blindly re-created by the engine -- reconcile ONCE against the real exports list and adopt
// only an exactly-one exact-identity COMPLETED export (download-only recovery, ZERO new creates). A recovered
// job becomes a plain succeeded job; anything unrecovered still fails the assessment honestly below.
try {
  const rr = await runCycleCreateReconcile({ preflight, bucket, deadline, log });
  if (rr.ran === true && rr.recovered > 0) {
    // The recovery may have been the LAST outstanding work -- resume the family once more (bounded) so any
    // remaining open jobs drain before the final proof.
    if (oliOpenCount(await getSyncSourceJobs(cycleId)) > 0 && !outOfTime()) {
      await runtime.runSourceCardAction({ bucket, sourceKey: OLI, deadline, preflight });
    }
  }
} catch (e) {
  log("create-reconcile skipped on error (the assessment below stays authoritative): " + (e && e.message ? e.message : e));
}

const jobs = await getSyncSourceJobs(cycleId);
const oliJobs = jobs.filter((j) => (j.source_key ?? j.sourceKey) === OLI);
const owners = await getSyncSourceJobOwnersForCycle(cycleId);
const open = oliOpenCount(jobs);
const a = assessScheduledOliCycle({ bucket, discoveredAccounts: discovered, sourceJobs: oliJobs, owners, open });
log("assessment: drained_open=" + open + " batches=" + a.batches + " creates=" + a.creates + "/" + a.ceilingCreates + " tokens=" + a.tokens + "/" + a.ceilingTokens + " ok=" + a.ok);
if (!a.ok) { console.error("STOP scheduled OLI assessment FAILED: " + a.problems.join(", ")); process.exit(1); }
log("DRAINED + PROVEN: " + discovered.length + " accounts across " + a.batches + " OLI batches; " + a.creates + " creates / " + a.tokens + " tokens (ceiling " + a.ceilingCreates + "/" + a.ceilingTokens + ").");
process.exit(0);
