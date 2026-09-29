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
//
// WP16 (live only; acquisition UNCHANGED -- same exports, batching, 50,000-row limit, canonical shared Listings reuse,
// token ceilings): the operator is also handed three READ-ONLY collaborators so that (a) a dedicated base cycle that was
// ALREADY terminal before this run is never appended to / re-acquired -- each account must PROVE already-current -- and
// (b) a failed natural shadow save counts as already-current ONLY with the same proof. The proof (content identity +
// lineage + live/served read-back) reads ONLY durable state: the durable Listings / Listings-Raw / FBA / OLI / Catalog
// evidence through the SAME resolveListingHealthV3DependencyBundle wiring the zero-export listing-health-v3 reconciler
// uses (scripts/release/listing-health-v3-reconcile.mjs), the newest publication job via ONE read-only SQL select over
// the verified-TLS pg connection, the report_snapshots shadow/live rows, the shared publisher read-back, and the
// dashboard's own served selector (selectLhv3). The Vercel serve flags (LHV3_PUBLISH_LIVE + LISTING_HEALTH_V3) are NOT
// visible here and the workflow must never set LISTING_HEALTH_V3, so the selector env comes ONLY from the owner
// attestation variable LHV3_SERVE_GATE_ATTESTED (exactly 'true' = both Vercel prod flags are 'true'; anything else /
// unset -> the served check fails CLOSED 'served-serve-flag-off', never silently current); any literal
// LHV3_PUBLISH_LIVE / LISTING_HEALTH_V3 in this process's env is IGNORED (lhv3ServeEnvFromAttestation). It makes ZERO
// DataDoe calls and ZERO writes. The EVIDENCE line always carries alreadyCurrent + refusedReal; the process exits 0
// only when every account is published or proven already-current. GITHUB_OUTPUT (when set) receives lhv3_phase=<phase>
// and lhv3_durable_persisted=<true|false> (lhv3IngestionGithubOutputs) -- the scheduler gates its immediate
// listing-health-v3 reconcile on them.

import { appendFileSync } from "node:fs";
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
const {
  runListingHealthV3Ingestion, listingHealthV3OperationId,
  buildLhv3ReadOnlyPgReader, lhv3ServeEnvFromAttestation, lhv3IngestionGithubOutputs,
} = await import("../../lib/server/sync/listing-health-v3-operation.js");

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

// ---- WP16 read-only collaborators (live only). Construction performs NO I/O; every read is lazy. ----
// The ONE pg client for the publication-job read: opened lazily on first use through the verified-TLS config (pinned
// Supabase root CA + hostname check; never rejectUnauthorized:false), constructed INSIDE the reader's try. A connect
// failure AND a client 'error' event (idle drop / pooler restart -- otherwise an uncaught exception that would kill the
// CLI before its EVIDENCE line) are memoized, so every later read fails FAST and closed (each account then fails its
// content check typed -- never silently current). The CLIENT-side query_timeout bounds every read; no `statement_timeout`
// startup parameter is sent (the production Supavisor pooler has not been proven to accept one, and a rejected startup
// would fail every proof closed, silently making this fix inert).
const PG_READ_TIMEOUT_MS = 30000;
const pgReader = buildLhv3ReadOnlyPgReader({
  makeClient: async () => {
    const { default: pg } = await import("pg");
    const { verifiedPgConfig } = await import("../../lib/server/pg-tls.js");
    return new pg.Client(verifiedPgConfig(process.env.POSTGRES_URL, { connectionTimeoutMillis: 20000, query_timeout: PG_READ_TIMEOUT_MS }));
  },
});
const pgRows = (sql, params) => pgReader.rows(sql, params);
const closePg = () => pgReader.close();

// The NEWEST listing-health-v3 publication-lineage job for one account OUTSIDE this run's own base cycle (whose natural-
// shape jobs are never a listing-health-v3 publication lineage): the getLatestReportJobLineage shape + the owning cycle's
// status, from ONE read-only select. Timestamps / dates are selected as TEXT (never parsed through a local-timezone JS
// Date); ordering happens in SQL.
const PUBLICATION_JOB_SQL = `select j.id::text as id, j.cycle_id::text as cycle_id, j.report_key, j.account_id,
       j.derive_status, j.save_status, j.validated, j.depends_on, j.durable_content_deps, j.snapshot_params_hash,
       j.latest_data_date::text as latest_data_date, j.created_at::text as created_at, c.status as cycle_status
  from public.sync_report_jobs j
  join public.sync_cycles c on c.id = j.cycle_id
 where j.report_key = $1 and j.account_id = $2 and ($3::uuid is null or j.cycle_id <> $3::uuid)
 order by j.created_at desc, j.id desc
 limit 1`;

async function buildWp16Collaborators() {
  const { listingHealthV3CycleBucket } = await import("../../lib/server/sync/listing-health-v3-ingestion-composition.js");
  const { buildListingHealthV3AlreadyCurrentProof } = await import("../../lib/server/sync/listing-health-v3-operation.js");
  const sb = await import("../../lib/server/supabase.js");
  const { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } = await import("../../lib/server/sync/report-publisher.js");
  const { REPORT_DERIVATIONS } = await import("../../lib/server/sync/report-derivation.js");
  const { paramsHashFor } = await import("../../lib/server/report-store.js");
  const { buildLiveReadback } = await import("../../lib/server/sync/source-priority-release-runner.js");
  const { resolveListingHealthV3DependencyBundle } = await import("../../lib/server/sync/listing-health-v3-dependency-bundle.js");
  const { makeListingHealthV3DurableContextLoader } = await import("../../lib/server/sync/listing-health-v3-durable-loader.js");
  const { FBA_INVENTORY_SOURCE_KEY } = await import("../../lib/server/sync/source-durable-model.js");
  const { resolvedFbaSnapshot } = await import("../../lib/server/sync/source-bucket-sync.js");
  const { organizationFingerprint } = await import("../../lib/server/source-identity.js");
  const { resolveDataDoeAccountIds } = await import("../../lib/server/datadoe-connections.js");
  const { normalizeMarketplace } = await import("../../lib/server/sync/oli-sales-estimate.js");
  const { selectLhv3 } = await import("../../lib/server/recovery/serve-selectors.js");

  const store = release.runtime.store;
  const cycleBucket = listingHealthV3CycleBucket(region);
  // (a) the dedicated base cycle head (read-only; the SAME reader the composition's finalize/readFrozenBudget use).
  const readBaseCycle = async ({ cycleDate: d }) => {
    const cyc = await store.getCycleByBucketDate(cycleBucket, d);
    return cyc && cyc.id ? { id: String(cyc.id), status: String(cyc.status || "") } : null;
  };
  // (b) the base cycle's durable report + source job rows (read-only; after finalize the terminal cycle is immutable).
  const readCycleJobs = async ({ cycleDate: d }) => {
    const cyc = await store.getCycleByBucketDate(cycleBucket, d);
    if (!cyc || !cyc.id) throw new Error("listing-health-v3 base cycle not found");
    const [reportJobs, sourceJobs] = await Promise.all([store.listReportJobs(cyc.id), store.listSourceJobs(cyc.id)]);
    return { cycleId: String(cyc.id), status: String(cyc.status || ""), reportJobs, sourceJobs };
  };

  // (c) the already-current proof. The dependency-bundle wiring MIRRORS scripts/release/listing-health-v3-reconcile.mjs
  // (same readers, STRICT durable loader, marketplace = the directory country normalized to the Amazon code, the
  // recomputed D-1 FBA inventory identity, org = the primary connection) so the manifest token is byte-identical to the
  // one the reconciler publishes under. Any drift can only make the proof FAIL (a different token), never pass.
  // Pinned by scripts/listing-health-v3-replay-and-refusal.test.js (P3-C static parity). The ONE intended difference is
  // the COUNTRY SOURCE: here the per-account country comes from the operator's export-eligible discovery (the
  // composition's discoverAccounts: primary directory rows intersected with discovered primary ids); the reconciler's
  // comes from classifyDirectoryAccounts(fetchDirectory(...)).active. Both read the SAME primary directory; a
  // disagreement changes the normalized marketplace / FBA request hash -> a different (or ineligible) manifest token ->
  // the proof fails closed (typed content), never a false already-current.
  const connections = release.connections || [];
  const primary = connections.find((c) => c && c.id === "primary") || null;
  const orgFp = primary ? (primary.organizationFingerprint || organizationFingerprint(primary.apiKey)) : "";
  const loadDurableContext = makeListingHealthV3DurableContextLoader({
    connections,
    getCatalogSnapshot: (args) => sb.getSourceSnapshot(args),
    loadCatalogPayload: (path, opt) => sb.getSourceSnapshotPayload(path, opt),
    strict: true,
    buildObjectPath: sb.sourceSnapshotObjectPath,
  });
  const rawSellerOf = (accountId) => {
    try { const r = resolveDataDoeAccountIds([accountId], connections); return r && r.rawAccountIds && r.rawAccountIds.length === 1 ? String(r.rawAccountIds[0]) : ""; }
    catch { return ""; }
  };
  const resolveBundle = async ({ accountId, country, requestedAsOf }) => {
    if (!primary || !orgFp) return { eligible: false, status: "missing", revisionId: null, deps: [], contentDeps: [], reason: "no-primary-connection" };
    const rawSellerId = rawSellerOf(accountId);
    const directoryCountry = String(country || "").trim();
    return resolveListingHealthV3DependencyBundle({
      readListingsSnapshot: ({ organizationFingerprint: org, connectionId, accountId: a, signal = null }) => sb.getSourceListingsSnapshot({ organizationFingerprint: org, connectionId, accountId: a, signal }),
      readListingsRawSnapshot: ({ organizationFingerprint: org, connectionId, accountId: a, signal = null }) => sb.getSourceListingsRawSnapshot({ organizationFingerprint: org, connectionId, accountId: a, signal }),
      readInventorySnapshot: ({ organizationFingerprint: org, connectionId, accountId: a, signal = null }) => sb.getSourceSnapshot({ organizationFingerprint: org, connectionId, sourceKey: FBA_INVENTORY_SOURCE_KEY, scopeKey: a, signal }),
      loadSnapshotPayload: (path, opt) => sb.getSourceSnapshotPayload(path, opt),
      resolveExpectedInventoryRequestHash: async ({ requestedAsOf: d }) => {
        if (!rawSellerId || !directoryCountry) return "";
        try {
          const identity = resolvedFbaSnapshot({ apiKey: primary.apiKey, account: { rawSellerId, country: directoryCountry }, asOf: d, bucket: region });
          return String((identity && (identity.requestHash ?? identity.request_hash)) || "");
        } catch { return ""; }
      },
      loadDurableContext,
      buildObjectPath: sb.sourceSnapshotObjectPath,
    }, {
      organizationFingerprint: orgFp, connectionId: "primary", accountId,
      marketplace: normalizeMarketplace(directoryCountry), rawSellerId, requestedAsOf,
    });
  };
  const readPublicationJob = async ({ reportKey, accountId, excludeCycleId }) => {
    const rows = await pgRows(PUBLICATION_JOB_SQL, [String(reportKey), String(accountId), excludeCycleId == null ? null : String(excludeCycleId)]);
    const row = rows[0];
    if (!row) return null;
    return {
      reportKey: row.report_key, accountId: row.account_id,
      deriveStatus: row.derive_status ?? null, saveStatus: row.save_status ?? null, validated: row.validated === true,
      dependsOn: Array.isArray(row.depends_on) ? row.depends_on.map((h) => String(h)) : [],
      durableContentDeps: Array.isArray(row.durable_content_deps) ? row.durable_content_deps.map((h) => String(h)) : [],
      snapshotParamsHash: row.snapshot_params_hash ?? null, latestDataDate: row.latest_data_date ?? null,
      cycleStatus: row.cycle_status ?? null, id: row.id ?? null, cycleId: row.cycle_id ?? null, createdAt: row.created_at ?? null,
    };
  };
  const readbackLive = buildLiveReadback({
    getReportSnapshot: sb.getReportSnapshot,
    loadStoragePayload: sb.getReportSnapshotStoragePayload,
    liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS,
    reportDerivations: REPORT_DERIVATIONS,
    computeHash: paramsHashFor,
  });
  const lhv3Contract = SCHEDULER_LIVE_SNAPSHOT_CONTRACTS["listing-health-v3"];
  // The dashboard's OWN served selection (api/datadoe.js listing-health-v3 default window): the exact row at {to: UTC
  // D-1} behind the SERVER double flag, proven by the SAME strict body (the shared live read-back) the serve resolver runs.
  // The flag env is ONLY the owner attestation (P2-A): LHV3_SERVE_GATE_ATTESTED === 'true' -> both flags 'true'; else an
  // empty env -> 'served-serve-flag-off' (fail closed). A literal LHV3_PUBLISH_LIVE / LISTING_HEALTH_V3 here is ignored.
  // DATE NOTE (P3-C): the served check resolves the WALL-CLOCK UTC D-1 (lhv3ExpectedLiveAsOf(now)) exactly as the page
  // does, while the content/lineage binding uses this run's cycleDate (requestedAsOf). The scheduler passes cycleDate =
  // inventory_asof = UTC D-1, so they agree; a run whose cycleDate is NOT the wall-clock UTC D-1 (a manual backdated rerun,
  // or one straddling UTC midnight) fails 'served-*' TRUTHFULLY -- the page would not serve that as-of either.
  const selectServed = ({ accountId }) => selectLhv3({
    accountId,
    env: lhv3ServeEnvFromAttestation(process.env),
    now: () => Date.now(),
    readers: { getReportSnapshot: (args) => sb.getReportSnapshot(args) },
    computeHash: paramsHashFor,
    contract: lhv3Contract,
    prove: (row) => readbackLive({ reportKey: "listing-health-v3", liveReportKey: lhv3Contract.liveReportKey, accountId, paramsHash: row.params_hash }),
  });
  const proveAlreadyCurrent = buildListingHealthV3AlreadyCurrentProof({
    resolveBundle,
    readPublicationJob,
    readSnapshot: (args) => sb.getReportSnapshot(args),
    loadStoragePayload: (path) => sb.getReportSnapshotStoragePayload(path),
    verifyLiveReadback: readbackLive,
    selectServed,
    liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS,
    computeHash: paramsHashFor,
    reportDerivations: REPORT_DERIVATIONS,
  });
  return { readBaseCycle, readCycleJobs, proveAlreadyCurrent };
}
const wp16 = mode === "live" ? await buildWp16Collaborators() : {};

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
  // WP16 read-only collaborators (live only; {} in dry-run => the pre-WP16 operator path).
  readBaseCycle: wp16.readBaseCycle || null,
  readCycleJobs: wp16.readCycleJobs || null,
  proveAlreadyCurrent: wp16.proveAlreadyCurrent || null,
  log,
});
await closePg();

// Machine-readable outcome for the scheduler workflow (a no-op locally; GITHUB_OUTPUT unset). Single-line bounded values.
const ghOut = (k, v) => { const f = process.env.GITHUB_OUTPUT; if (f) { try { appendFileSync(f, k + "=" + v + "\n"); } catch { /* never affects the exit code */ } } };
for (const [k, v] of lhv3IngestionGithubOutputs(evidence)) ghOut(k, v);

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
  // WP16: always present (0 on the ordinary path). alreadyCurrent = accounts PROVEN already-current (content + lineage +
  // live/served read-back; never 'published'); refusedReal = accounts whose write was refused (terminal base cycle /
  // failed shadow save) and that did NOT prove current -- each listed with its typed reason in `refusals`.
  alreadyCurrent: Number(evidence.alreadyCurrent || 0), refusedReal: Number(evidence.refusedReal || 0),
  baseCycleTerminal: evidence.baseCycleTerminal === true ? true : undefined, baseCycleStatus: evidence.baseCycleStatus,
  refusals: Array.isArray(evidence.refusals) && evidence.refusals.length ? evidence.refusals : undefined,
  refusalAudit: evidence.refusalAudit,
  problems: evidence.problems && evidence.problems.length ? evidence.problems : undefined, note: evidence.note,
}));

if (evidence.ok === true) { log("DONE ok phase=" + evidence.phase); process.exit(0); }
console.error("STOP phase=" + evidence.phase + " problems=" + JSON.stringify(evidence.problems || []));
process.exit(1);
