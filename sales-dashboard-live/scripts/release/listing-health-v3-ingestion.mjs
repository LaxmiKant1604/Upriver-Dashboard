// TRUSTED operator for the Listing Health v3 dedicated SHADOW ingestion (Phase 4B2 India canary).
//
// Runs the SHARED pure operator core (lib/server/sync/listing-health-v3-operation.js) wired by the reviewed release
// seam (lib/server/sync/listing-health-v3-ingestion-composition.js) -- the same store/adapter/source-worker/report-
// worker/materializer/frozen-budget machinery the scheduler uses, with no drift and no duplication. It is a SEPARATE
// path from the live 13-report control plane (v3 is absent from CONTROLLED/SCHEDULER_V2_READY), so it can only run
// through THIS operator, and only when ALL THREE live-run gates pass:
//   (1) an exact explicit CLI execute confirmation: --confirm=<operationId> equal to listing-health-v3/{region}/{cycle};
//   (2) an authorized operator identity: PRIORITY_OPERATOR (or --operator) == the reviewed operator;
//   (3) the environment gate LISTING_HEALTH_V3_INGESTION_ENABLED=true (defaults false -> live refuses).
//
//   node scripts/release/listing-health-v3-ingestion.mjs --region=india --mode=dry-run   [--cycle-date=YYYY-MM-DD]
//   LISTING_HEALTH_V3_INGESTION_ENABLED=true \
//     node scripts/release/listing-health-v3-ingestion.mjs --region=india --mode=live --cycle-date=YYYY-MM-DD \
//       --confirm=listing-health-v3/india/YYYY-MM-DD
//
// dry-run: ZERO creates/writes/tokens -- discovers accounts, builds+freezes the plan, proves the freshness-aware
//   create/token cost + inventory adoptability, and prints the counts vs the region ceiling. It NEVER runs sources.
// live: refuses unless all three gates pass + the plan is within budget + the balance (minus reserve) covers the
//   estimate; then runs one operation and safe-closes. NEVER prints an API key, token, secret URL, or auth header.

import { loadReleaseEnv } from "./env-bootstrap.mjs";
loadReleaseEnv();

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const region = (argOf("region") || "").toLowerCase();
const mode = argOf("mode") || "dry-run";
const confirm = argOf("confirm");
const AUTHORIZED_OPERATOR = "laxmikant@superboring.in";
const operator = process.env.PRIORITY_OPERATOR || argOf("operator") || AUTHORIZED_OPERATOR;
const emergencyReserveTokens = Number(argOf("reserve") || 200); // meaningful emergency reserve (>> the ~8-token canary)

// Default cycle date = the previous UTC date (D-1): the canonical shared inventory snapshot day
// (fbaInventoryAsOf parity), so an omitted --cycle-date still matches the FBA inventory cache identity.
const serverD1 = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const cycleDate = argOf("cycle-date") || serverD1();

if (!["india", "europe-au", "us-ca"].includes(region)) { console.error("STOP --region must be india | europe-au | us-ca"); process.exit(2); }
if (mode !== "dry-run" && mode !== "live") { console.error("STOP --mode must be dry-run | live"); process.exit(2); }
const log = (m) => console.log(`lhv3-ingest[${mode}/${region}]: ${m}`);

const { buildListingHealthV3IngestionRelease } = await import("../../lib/server/sync/listing-health-v3-ingestion-composition.js");
const { runListingHealthV3Ingestion, listingHealthV3OperationId } = await import("../../lib/server/sync/listing-health-v3-operation.js");

const operationId = listingHealthV3OperationId(region, cycleDate);
const gateEnabled = process.env.LISTING_HEALTH_V3_INGESTION_ENABLED === "true";
const authorized = operator === AUTHORIZED_OPERATOR;

// CLI-level gate 1 (live only): an EXACT execute confirmation. Refuse before building anything.
if (mode === "live") {
  if (confirm !== operationId) { console.error(`STOP live requires --confirm=${operationId} (exact); got ${confirm ? "a mismatched value" : "none"}.`); process.exit(2); }
  if (!authorized) { console.error("STOP operator identity is not authorized for a live run."); process.exit(2); }
  if (!gateEnabled) { console.error("STOP LISTING_HEALTH_V3_INGESTION_ENABLED is not 'true' (default disabled); refusing live run."); process.exit(2); }
}

log(`operation ${operationId}; operator ${authorized ? "AUTHORIZED" : "unauthorized"}; env-gate ${gateEnabled ? "ENABLED" : "disabled"}`);

const release = buildListingHealthV3IngestionRelease({ operator });

const evidence = await runListingHealthV3Ingestion({
  region, cycleDate, mode,
  authorized, gate: { enabled: gateEnabled }, connections: release.connections,
  discoverAccounts: release.discoverAccounts,
  buildPlan: release.buildPlan,
  resolveCost: release.resolveCost,
  checkBalance: release.checkBalance,
  runSources: release.runSources,
  freezeBudget: release.freezeBudget,
  readFrozenBudget: release.readFrozenBudget,
  materialize: release.materialize,
  runReports: release.runReports,
  finalizeCycle: release.finalizeCycle,
  reservationSupported: release.reservationSupported,
  pricingKnown: release.pricingKnown,
  emergencyReserveTokens,
  log,
});

// Structured, secret-free evidence. Only ACTUAL secret keys are redacted (an exact key match) -- a benign field
// like estimatedTokens / usableBalance is NOT a secret and prints normally.
const SECRET_KEY = /^(apikey|api_key|authorization|auth|secret|password|bearer|datadoe-api-key)$/i;
const safe = (o) => JSON.stringify(o, (k, v) => (SECRET_KEY.test(k) ? "[redacted]" : v));
log("EVIDENCE " + safe({
  operationId: evidence.operationId, phase: evidence.phase, ok: evidence.ok, dryRun: !!evidence.dryRun,
  accounts: evidence.accounts, newExports: evidence.newExports, ceiling: evidence.ceiling,
  plannedCreates: evidence.plannedCreates, creates: evidence.creates, estimatedTokens: evidence.estimatedTokens,
  inventoryAdoptable: evidence.inventoryAdoptable, deferred: evidence.deferred || false, inventoryCreated: evidence.inventoryCreated,
  finalizeDisposition: evidence.finalizeDisposition, cycleStatus: evidence.cycleStatus,
  reportBlocked: evidence.reportBlocked, reportFailed: evidence.reportFailed,
  snapshots: evidence.snapshots, aliases: evidence.aliases ? { written: evidence.aliases.aliasesWritten, empty: evidence.aliases.emptyAliases, rejected: evidence.aliases.rejected, skippedStale: evidence.aliases.skippedStale } : null,
  usableBalance: evidence.usableBalance, emergencyReserve: evidence.emergencyReserve,
  problems: evidence.problems && evidence.problems.length ? evidence.problems : undefined, note: evidence.note,
}));

if (evidence.ok === true) { log("DONE ok phase=" + evidence.phase); process.exit(0); }
console.error("STOP phase=" + evidence.phase + " problems=" + JSON.stringify(evidence.problems || []));
process.exit(1);
