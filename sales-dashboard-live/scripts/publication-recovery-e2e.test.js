// Publication recovery WP14 -- the END-TO-END suite. It drives the REAL recovery worker (lib/server/recovery/worker.js)
// over the REAL route registry (routes.js: declarations, awaits, priorities, tier-1 live-row scopes, identity as-of), the
// REAL classify, the REAL config loader, the REAL runner (runner.js runRoute: the buildRouteArgs argv, the NODE_OPTIONS
// zero-export guard preload, the hard-timeout kill path and the RESULT / TARGETS / ZEROEXPORT / STOP line parsers) and the
// in-memory store (memory-store.js) whose evidence read is wired EXACTLY like store-pg.js readRouteEvidence: the REAL
// evaluateRouteEvidence(route, query, ctx) over a FAKE read-only SQL world (every statement text of the route modules is
// answered by an emulation of its SQL over one shared fake database).
//
// NO process is ever spawned: the runner's spawnImpl is a FAKE child that runs, in-process, an emulation of the route CLI
// (scripts/release/publication-route-reconcile.mjs is NEVER executed -- its main flow is mirrored step for step over the
// REAL parseRouteCliArgs, validateRouteModule / validateRoutePair / routeTopoOrder, buildDurableDirectory,
// buildRouteCliControls + runControlPackageCli over a lease-capable fake control store, buildRoutePublicationRelease, the
// route adapter, the saved-data reconciler two-phase core, buildSchedulerV2Publisher (the four gates, build-time
// overrides only), buildRouteLiveReadback, formatTargetsLine and routeCliOutcome) or of one of the four LEGACY reconciler
// CLIs (a TARGETS v1 fixture). ONE fake DB world is shared by the releases (sync_cycles, sync_report_jobs + derive lease,
// the shadow CAS, the FENCED live CAS with the control_plane_lease owner/generation/expiry fence), the control plane
// (rollout / dispatch / promoted gates / approvals, transactional), the WP15 writer fence (a trigger model raising the
// exact supabase.js RWF01 error shape for an unmarked write of a fenced key) and the worker queue (memory-store.js).
//
// ROUTE RUNTIMES: REAL for returns-v3 (its strict Returns/Settlement gather through the module's own gatherEvidence test
// seam is a fixture over the world rows), sku-movement and brand-view-brands; FIXTURES (the CLI runtime contract over
// the world, payloads validated by the REAL REPORT_DERIVATIONS) for fba-plan (whose L1 token is the REAL
// composeFbaPlanEvidence over the same fake SQL), brand-view and brand-view-portfolio (worker compose + CLI runtime
// fixtures sharing one token function). The four legacy CLIs are TARGETS v1 fixtures over the REAL legacy compose.
//
// SCENARIOS: S1 normal save per route (all 10); S2 missed GitHub run; S3 dependency chain; S4 concurrency (two workers +
// a scheduler-mode route run); S5 child timeouts (prepare / publish); S6 crash before / after publication; S7 stale
// claim + control leases; S8 TOCTOU (entry / before first write / before publish); S9 invalid / missing source per route;
// S10 zero-export tripwire; S11 exact live read-back; P1-P3 the owner proofs (writer fence overlap, LHv3 refused-shadow
// proof, refresh=1 read-only + paid sync). ZERO network / DB / DataDoe (the global fetch is a recording, refusing stub;
// P3 installs a SCOPED in-process Supabase emulator and asserts zero DataDoe + zero writes). 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import path from "node:path";

process.env.SUPABASE_URL = "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = ["test", "svc", "role", "key"].join("-");
process.env.DATADOE_API_KEY = ["test", "datadoe", "key"].join("-");
for (const k of ["DATADOE_API_KEY_SECONDARY", "LHV3_PUBLISH_LIVE", "LISTING_HEALTH_V3", "PAID_SYNC_CONFIRM_SECRET", "SKU_MOVEMENT_SERVE_TOKEN_ATTESTED", "FBA_PLAN_ROUTE_FENCE_ATTESTED", "LHV3_SERVE_GATE_ATTESTED"]) delete process.env[k];

// The network is NEVER reached: every fetch is recorded and refused (P3 alone installs a scoped emulator).
const net = { calls: [], p3: null };
globalThis.fetch = async (url, opts = {}) => {
  if (net.p3) return net.p3(String(url), opts);
  net.calls.push(String((opts && opts.method) || "GET") + " " + String(url));
  throw new Error("network refused in an offline test");
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WK = await import("../lib/server/recovery/worker.js");
const MS = await import("../lib/server/recovery/memory-store.js");
const ROUTES = await import("../lib/server/recovery/routes.js");
const RUN = await import("../lib/server/recovery/runner.js");
const CLS = await import("../lib/server/recovery/classify.js");
const CFG = await import("../lib/server/recovery/config.js");
const RC = await import("../lib/server/recovery/route-contract.js");
const SEL = await import("../lib/server/recovery/serve-selectors.js");
const REL = await import("../lib/server/sync/route-publication-release.js");
const SDR = await import("../lib/server/sync/saved-data-reconciler.js");
const TGT = await import("../lib/server/sync/reconcile-targets-output.js");
const CP = await import("../lib/server/sync/source-priority-control-package.js");
const { CONTROLLED_REPORT_KEYS } = await import("../lib/server/sync/report-controls.js");
const { buildSchedulerV2Publisher } = await import("../lib/server/sync/publisher-composition.js");
const { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } = await import("../lib/server/sync/report-publisher.js");
const { REPORT_DERIVATIONS } = await import("../lib/server/sync/report-derivation.js");
const { paramsHashFor } = await import("../lib/server/report-store.js");
const B = await import("../lib/server/sync/publication-binding.js");
const FENCE = await import("../lib/server/sync/report-writer-fence.js");
const SB = await import("../lib/server/supabase.js");
const { accountInScope } = await import("../lib/server/sync/scheduler-scope.js");
const { normalizeMarketplace } = await import("../lib/server/sync/oli-sales-estimate.js");
const { marketplaceToday } = await import("../lib/marketplaces.js");
const { returnsWindow } = await import("../lib/server/sync/returns-source-refresh.js");
const { monthBackStr } = await import("../lib/server/date-windows.js");
const { brandViewScopeId, brandViewPortfolioScopeId } = await import("../lib/server/reports/brand-view.js");
const OLI_W = await import("../lib/server/recovery/routes/oli.route.js");
const FP_W = await import("../lib/server/recovery/routes/fba-plan.route.js");
const RT_W = await import("../lib/server/recovery/routes/returns-v3.route.js");
const SKU_W = await import("../lib/server/recovery/routes/sku-movement.route.js");
const BVB_W = await import("../lib/server/recovery/routes/brand-view-brands.route.js");
const PF_W = await import("../lib/server/recovery/routes/brand-view-portfolio.route.js");
const RT_C = await import("../lib/server/sync/routes/returns-v3.release.js");
const SKU_C = await import("../lib/server/sync/routes/sku-movement.release.js");
const BVB_C = await import("../lib/server/sync/routes/brand-view-brands.release.js");

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; out("  ok  " + name); };
const observations = [];
const observe = (s) => { observations.push(s); out("  note " + s); };
// Diagnostic aid: E2E_DEBUG=1 node scripts/publication-recovery-e2e.test.js prints run / job detail at key points.
const dbg = (label, v) => { if (process.env.E2E_DEBUG) out("DEBUG " + label + " " + JSON.stringify(v).slice(0, 4000)); };
out("publication-recovery-e2e");
const S = (v) => (v == null ? "" : String(v));
const J = (v) => JSON.stringify(v);
const clone = (v) => (v === undefined || v === null ? v ?? null : JSON.parse(JSON.stringify(v)));
const sha256 = (v) => createHash("sha256").update(String(v)).digest("hex");
const sha12 = (v) => sha256(v).slice(0, 12);
// Postgres to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') of a millisecond ISO instant.
const toUs = (iso) => (iso == null ? null : S(iso).replace(/\.(\d{3})Z$/, ".$1000Z"));
const maxStr = (xs) => xs.filter((x) => x != null && x !== "").map(String).sort().pop() || null;
const newestOf = (rows) => [...rows].sort((x, y) => (x.updated_at < y.updated_at ? 1 : x.updated_at > y.updated_at ? -1 : 0))[0] || null;

// ---- constants -------------------------------------------------------------------------------------------------------
const ORG = "org-fp-e2e";
const T0 = Date.UTC(2026, 8, 24, 10, 0, 0); // 2026-09-24T10:00Z: UTC D-1 (the epoch) 2026-09-23, IN today 2026-09-24
const EPOCH = "2026-09-23";
const IN_TODAY = "2026-09-24";
const REGION = "india";
const ACCTS = Object.freeze(["IN1", "IN2"]);
const BRANDS = Object.freeze(["Acme", "Caruso Italy"]);
const CAT_PATH = "source-snapshots/product-catalog/catsha1.json";
const PRIMARY_CONN = Object.freeze({ id: "primary", apiKey: "fixture-key", accountPrefix: "", label: "Primary", organizationFingerprint: ORG });
const LIVE = SCHEDULER_LIVE_SNAPSHOT_CONTRACTS;
const PROMOTED_ROWS = ["brand-inventory", "listing-health-v3", "sku-movement", "returns-leakage-v3", "brand-view-brands", "brand-view", "brand-view-portfolio", "fba-plan"];
// The child env the worker hands every route child (the owner attestations exactly 'true').
const CHILD_ENV = Object.freeze({ SKU_MOVEMENT_SERVE_TOKEN_ATTESTED: "true", FBA_PLAN_ROUTE_FENCE_ATTESTED: "true", LHV3_SERVE_GATE_ATTESTED: "true" });
const ROUTE_ORDER = Object.freeze(["oli", "listings", "fba-plan", "returns-v3", "ads", "fba", "brand-view-brands", "sku-movement", "brand-view", "brand-view-portfolio"]);
const CATALOG_ROWS = [
  { child_asin: "B0ACME1", product_brand: "Acme", product_name: "Acme Widget", sku: "A-1" },
  { child_asin: "B0CARU1", product_brand: "Caruso Italy", product_name: "Caruso Pan", sku: "C-1" },
  { child_asin: "B0ZETA1", product_brand: "Zeta", product_name: "Zeta Cup", sku: "Z-1" },
];
const LEGACY_FAMILY_BY_SCRIPT = Object.freeze({
  "scripts/release/oli-publication-reconcile.mjs": "oli", "scripts/release/ads-publication-reconcile.mjs": "ads",
  "scripts/release/fba-publication-reconcile.mjs": "fba", "scripts/release/listing-health-v3-reconcile.mjs": "listings",
});
// The legacy families' live identities (the executable serve contracts).
const LEGACY_LIVE = Object.freeze({
  "brand-sales": (asOf) => ({ version: "brand-sales-shared-v1", params: { from: "2025-08-01", to: asOf } }),
  "daily-reporting": (asOf) => ({ version: "daily-reporting-shared-v2", params: { from: "2026-04-01", to: asOf, brand: "ALL" } }),
  "brand-inventory": (asOf) => ({ version: "brand-inventory-shared-v1", params: { to: asOf } }),
  "listing-health-v3": (asOf) => ({ version: "listing-health-v3-shared-v1", params: { to: asOf } }),
});
const legacyIdentity = (rk, asOf) => { const d = LEGACY_LIVE[rk](asOf); return { hash: paramsHashFor(d.version, d.params), params: { reportVersion: d.version, ...d.params } }; };
function legacyPayload(rk, acct, asOf, tokens) {
  if (rk === "brand-sales") return { rows: BRANDS.map((b, i) => ({ date: asOf, child_asin: i ? "B0CARU1" : "B0ACME1", product_brand: b, total_sales: 10 + i, total_units: 1 })), catalogBrands: [...BRANDS], tokens };
  if (rk === "brand-inventory") return { accountId: acct, inventoryDate: asOf, inventoryAvailable: true, inventoryByBrandCountry: [], tokens };
  if (rk === "daily-reporting") return { rows: [{ date: asOf, total_sales: 10 }], brandFiltered: false, tokens };
  return { accountId: acct, asOf, rows: [], tokens };
}

// ---- durable evidence fixtures ---------------------------------------------------------------------------------------
const returnsRow = (a, date, i, stamp = "2026-09-23T05:00:00.000Z") => ({ organization_fingerprint: ORG, connection_id: "primary", account_id: a, return_date: date, sku: "SKU-" + i, child_asin: "B0R" + i, amazon_return_reason: "DEFECTIVE", fulfillment_channel: "AFN", request_status: "Approved", label_payer: "Amazon", refreshed_at: stamp, created_at: stamp, updated_at: stamp });
const settlementRow = (a) => ({ organization_fingerprint: ORG, connection_id: "primary", account_id: a, settlement_date: "2026-09-21", sku: "SKU-0", child_asin: "B0R0", currency: "INR", settlement_type: "Refund", refreshed_at: "2026-09-23T05:10:00.000Z", created_at: "2026-09-23T05:10:00.000Z", updated_at: "2026-09-23T05:10:00.000Z" });
function historyRowsFor(accounts) {
  const out2 = [];
  for (const a of accounts) {
    const r = (sale_date, sku, child_asin, sales_amount, units, h = "h1") => ({ account_id: a, seller_or_vendor_id: a, sale_date, sku, child_asin, currency: "INR", sales_amount, units, source_request_hash: h });
    out2.push(r("2026-09-22", "A-1", "B0ACME1", 100, 2), r(EPOCH, "A-1", "B0ACME1", 50, 1), r(EPOCH, "C-1", "B0CARU1", 70, 3), r("2026-07-10", "C-1", "B0CARU1", 20, 1, "h0"));
  }
  return out2;
}
const opunitRowsFor = (accounts) => accounts.map((a) => ({ organization_fingerprint: ORG, connection_id: "primary", account_id: a, seller_or_vendor_id: a, sale_date: EPOCH, sku: "A-1", child_asin: "", currency: "INR", priced_units: 0, priced_sales: null, explicit_zero_units: 0, pending_units: 2, cancelled_units: 0, source_request_hash: "h1", updated_at: "2026-09-24T01:00:00.000Z" }));
// A VALID returns-leakage-v3 payload (REPORT_DERIVATIONS['returns-leakage-v3'].validatePayload).
const returnsPayload = (acct, asOf, latest, total) => ({ version: "returns-leakage-v3", accountId: acct, asOf, rows: [{ asin: "B0R0", refunds: total }], currencies: ["INR"], window: { from: returnsWindow(asOf).from, to: asOf }, dayAxis: [asOf], series: { refunds: [total] }, freshness: { latestDataDate: latest }, latestDataDate: latest });
// A VALID fba-plan payload (REPORT_DERIVATIONS['fba-plan'].validatePayload) whose content follows the FBA pointer.
const fbaPlanPayload = (b) => ({ accountId: b.accountId, asOf: b.salesAsOf, rows: [{ asin: "B0ACME1", sku: "A-1", brand: "Acme", available: 5 }, { asin: "B0CARU1", sku: "C-1", brand: "Caruso Italy", available: 2 }], months: [], inventoryByBrandCountry: [{ brand: "Acme", country: b.country || "IN", units: 5 }], isUS: false, inventoryAvailable: true, awdAvailable: false, inventoryDate: b.inventoryAsOf, fbaSha: b.fbaSha });
// A VALID Brand View payload (isBrandViewPayload) for a scope.
const brandViewPayload = (scope, brand, asOf, accounts, accountId = null) => ({ brandViewVersion: "brand-view-account-scoped-v2", scope, brand, asOf, ...(accountId ? { accountId } : {}), accounts: accounts.map((a) => ({ accountId: a })), countries: [{ country: "IN" }], series: [], coverage: {}, notes: [] });
const rwf01 = (key) => { const e = new Error(`Supabase request failed (400): REPORT_WRITER_FENCED:${key}`); e.status = 400; e.code = "RWF01"; return e; };

// =====================================================================================================================
// THE ONE FAKE DB WORLD
// =====================================================================================================================
function makeWorld({ accounts = ACCTS } = {}) {
  const w = { clock: T0, seq: 0, accounts: [...accounts] };
  w.now = () => w.clock;
  w.tick = (ms = 60000) => { w.clock += ms; return w.clock; };
  w.sleep = async (ms) => { w.clock += Math.max(0, Number(ms) || 0); };
  const iso = (ms) => new Date(ms).toISOString();
  w.iso = iso;
  const nextId = (p) => p + "-" + (++w.seq);
  w.directoryRows = accounts.map((id) => ({ accountId: id, country: "IN", name: "Acct " + id, currency: "INR" }));
  w.snaps = new Map(); w.storage = new Map();
  w.cycles = new Map(); w.jobs = []; w.naturalCycles = [];
  w.n = { cycleCreate: 0, jobInsert: 0, claimLease: 0, shadowCas: 0, shadowWrite: 0, reconcile: 0, finalize: 0, liveCas: 0, liveWrite: 0, legacyWrite: 0, legacyRefused: 0, preflight: 0, publish: 0, snapshotUpdate: 0, pg: 0, leaseHeld: 0, fencedMarks: 0 };
  w.writes = () => w.n.cycleCreate + w.n.jobInsert + w.n.shadowWrite + w.n.reconcile + w.n.finalize + w.n.liveWrite + w.n.legacyWrite;
  // control plane: the global lease + the four control tables
  w.lease = { owner: "", op: "", gen: 0, exp: 0 };
  w.ctl = { rollout: new Map(accounts.map((a) => [a, false])), dispatch: new Map(CONTROLLED_REPORT_KEYS.map((k) => [k, false])), promoted: new Map(PROMOTED_ROWS.map((k) => [k, false])), approvals: new Map() };
  // WP15 writer fence rows (20260935 seed: every route-owned key fenced_only=false)
  w.fence = new Map(FENCE.FENCED_WRITER_REPORT_KEYS.map((k) => [k, false]));
  // durable saved evidence (metadata + hydrated rows)
  w.coverage = accounts.map((a) => ({ organization_fingerprint: ORG, connection_id: "primary", account_id: a, source_key: "order-line-items", covered_from: "2026-01-01", covered_to: EPOCH, status: "succeeded", source_refreshed_at: "2026-09-24T01:00:00.000Z", updated_at: "2026-09-24T01:00:00.000Z" }));
  w.completeness = accounts.map((a) => ({ account_id: a, refreshed: "2026-09-24T01:05:00.000Z" }));
  w.fbaPointers = new Map(accounts.map((a) => [a, { object_path: "fba/" + a + "/1.json", payload_sha: "fsha-" + a + "-1", row_count: 3, source_request_hash: "freq-" + a + "-1", validated_at: "2026-09-24T02:00:00.000Z" }]));
  w.awdPointers = new Map();
  w.catalog = { object_path: CAT_PATH, payload_sha: "catsha1", row_count: 3, payload_bytes: 10, source_request_hash: "catreq1", validated_at: "2026-09-20T00:00:00.000Z" };
  w.catalogPayloads = new Map([[CAT_PATH, { rows: clone(CATALOG_ROWS) }]]);
  w.adsRevs = new Map(accounts.map((a) => [a, "campaign-performance-v1=rev1@" + EPOCH]));
  w.listings = new Map(accounts.map((a) => [a, { l_sha: "lsha-" + a, l_at: "2026-09-24T03:00:00.000Z", r_sha: "rsha-" + a, r_at: "2026-09-24T03:00:00.000Z" }]));
  w.returns = new Map(accounts.map((a) => [a, { returns: [returnsRow(a, "2026-09-20", 0), returnsRow(a, "2026-09-22", 1)], settlement: [settlementRow(a)] }]));
  w.history = historyRowsFor(accounts);
  w.opunits = opunitRowsFor(accounts);
  w.resolution = new Map(accounts.map((a) => [a, [{ seller_or_vendor_id: a, currency: "INR", sku: "A-1", asin_count: 1, child_asin: "B0ACME1" }]]));
  // fault / hook injection
  w.faults = []; w.spawns = []; w.runs = []; w.cliRuns = []; w.hooks = {};
  w.routeFaults = new Map(); w.legacyFaults = new Map(); w.gatherFaults = new Map();
  w.zeroExportTrap = null; w.legacyUnfencedWriter = false; w.serveLag = null; w.onLeaseHeld = null; w.pgFail = false;

  // ---- report_snapshots + the writer-fence trigger model ----
  const snapKey = (rk, a, h) => rk + "|" + a + "|" + h;
  w.snapKey = snapKey;
  w.row = (rk, a, h) => w.snaps.get(snapKey(rk, a, h)) || null;
  w.rowsOf = (rk, a) => [...w.snaps.values()].filter((r) => r.report_key === rk && r.account_id === a);
  w.newest = (rk, a) => newestOf(w.rowsOf(rk, a));
  w.liveRows = (rk) => [...w.snaps.values()].filter((r) => r.report_key === rk);
  w.put = (row) => { w.snaps.set(snapKey(row.report_key, row.account_id, row.params_hash), row); return row; };
  // BEFORE INSERT/UPDATE trigger report_snapshots_zz_writer_fence: a fenced key needs the transaction-local mark that
  // ONLY the fenced CAS sets (after its lease/generation fence passed); anything else raises SQLSTATE RWF01.
  w.fenceTrigger = (reportKey, marked) => { if (w.fence.get(reportKey) === true && !marked) { w.n.legacyRefused += 1; throw rwf01(reportKey); } };
  w.casWrite = (a, marked, idPrefix) => {
    const k = snapKey(a.reportKey, a.accountId, a.paramsHash); const cur = w.snaps.get(k);
    const cand = Date.parse(a.sourceRefreshedAt);
    if (cur) {
      const have = Date.parse(cur.source_refreshed_at);
      if (have > cand) return { outcome: "newer-live" };
      if (have === cand) return B.stableJson(cur.params) === B.stableJson(a.params) && B.stableJson(cur.payload) === B.stableJson(a.payload) ? { outcome: "already-current" } : { outcome: "conflict" };
    }
    w.fenceTrigger(a.reportKey, marked);
    w.put({ id: nextId(idPrefix), report_key: a.reportKey, account_id: a.accountId, params_hash: a.paramsHash, params: clone(a.params), payload: clone(a.payload), payload_storage_path: null, source_refreshed_at: a.sourceRefreshedAt, updated_at: iso(w.tick(1000)) });
    return { outcome: cur ? "replaced" : "inserted" };
  };
  // saveShadowSnapshotIfNewer (scheduler-v2/* keys are never fenceable: the trigger always passes them).
  w.saveShadow = async (a, _opt, io, info) => {
    w.n.shadowCas += 1;
    await w.fault("prepare:shadow", io, info);
    const r = w.casWrite(a, false, "snap");
    if (r.outcome === "inserted" || r.outcome === "replaced") w.n.shadowWrite += 1;
    return r;
  };
  // publishLiveSnapshotFencedIfNewer -> cas_report_snapshot_if_newer_fenced: the lease fence (token, generation,
  // unexpired) FIRST (zero rows on any mismatch), then the transaction-local mark, then the CAS through the trigger.
  w.liveCasFenced = async (a, io, info) => {
    w.n.liveCas += 1;
    const L = w.lease;
    if (!S(a.ownerToken)) return { outcome: "lease-lost", reason: "no-fence" };
    if (!(Number.isSafeInteger(Number(a.generation)) && Number(a.generation) > 0)) return { outcome: "lease-lost", reason: "invalid-generation" };
    if (!L.owner) return { outcome: "lease-lost", reason: "no-lease" };
    if (L.owner !== a.ownerToken) return { outcome: "lease-lost", reason: "owner-changed" };
    if (L.gen !== Number(a.generation)) return { outcome: "lease-lost", reason: "generation-superseded" };
    if (!(L.exp > w.now())) return { outcome: "lease-lost", reason: "expired" };
    w.n.fencedMarks += 1;
    const r = w.casWrite(a, true, "live");
    if (r.outcome === "inserted" || r.outcome === "replaced") { w.n.liveWrite += 1; await w.fault("publish:after-cas", io, info); }
    return r;
  };
  // A LEGACY unfenced writer (saveReportSnapshot semantics: an unconditional upsert, NO mark).
  w.legacyUpsert = (a) => {
    w.fenceTrigger(a.reportKey, false);
    const k = snapKey(a.reportKey, a.accountId, a.paramsHash); const cur = w.snaps.get(k);
    w.put({ id: cur ? cur.id : nextId("legacy"), report_key: a.reportKey, account_id: a.accountId, params_hash: a.paramsHash, params: clone(a.params), payload: clone(a.payload), payload_storage_path: null, source_refreshed_at: a.sourceRefreshedAt, updated_at: iso(w.tick(1000)) });
    w.n.legacyWrite += 1;
    return { outcome: cur ? "replaced" : "inserted" };
  };
  // readers (report-store / supabase.js selector semantics)
  w.readSnapshot = async ({ reportKey, accountId, paramsHash }) => clone(w.row(reportKey, accountId, paramsHash));
  w.getLatest = async ({ reportKey, accountId }) => clone(w.newest(reportKey, accountId));
  w.getLatestForScope = async ({ reportKey, accountId, reportVersion = null, scope = {} }) => {
    if (w.serveLag && w.serveLag.reportKey === reportKey) return null; // a lagging serve read (S11a)
    return clone(newestOf(w.rowsOf(reportKey, accountId).filter((x) => (reportVersion == null || S(x.params && x.params.reportVersion) === S(reportVersion)) && Object.entries(scope || {}).every(([k, v]) => v == null || S(x.params && x.params[k]) === S(v)))));
  };
  w.loadStoragePayload = async (p) => (w.storage.has(p) ? clone(w.storage.get(p)) : null);
  w.liveRowMeta = () => [...w.snaps.values()].filter((r) => !S(r.report_key).startsWith("scheduler-v2/")).map((r) => ({ report_key: r.report_key, account_id: r.account_id, params: r.params, updated_ms: Date.parse(r.updated_at) }));

  // ---- sync_cycles / sync_report_jobs (the lineage) ----
  const cycleById = (id) => [...w.cycles.values()].find((c) => c.id === id) || null;
  const jobOf = (cycleId, rk, a) => w.jobs.find((j) => j.cycle_id === cycleId && j.report_key === rk && j.account_id === a) || null;
  w.openCycle = async ({ bucket, cycleDate }) => { const k = bucket + "|" + cycleDate; if (!w.cycles.has(k)) { w.n.cycleCreate += 1; const t = iso(w.tick(2000)); w.cycles.set(k, { id: nextId("cyc"), bucket, cycle_date: cycleDate, status: "pending", created_at: t, updated_at: t }); } };
  w.getCycleByBucketDate = async (bucket, d) => clone(w.cycles.get(bucket + "|" + d) || null);
  w.claimCycle = async (id) => { const c = cycleById(id); if (c && c.status === "pending") { c.status = "running"; c.updated_at = iso(w.now()); return true; } return false; };
  w.readCycle = async (id) => clone(cycleById(id));
  w.upsertReportJob = async (job) => {
    if (jobOf(job.cycleId, job.reportKey, job.accountId)) return;
    w.n.jobInsert += 1;
    w.jobs.push({ id: nextId("job"), cycle_id: job.cycleId, report_key: job.reportKey, account_id: job.accountId, bucket: job.bucket, connection_id: job.connectionId, report_version: job.reportVersion, depends_on: [...(job.dependsOn || [])], durable_content_deps: [...(job.durableContentDeps || [])], derive_status: "pending", save_status: "pending", validated: false, snapshot_params_hash: null, lease_token: null, lease_expires: 0, created_at: ++w.seq });
  };
  w.claimDeriveLease = async (cycleId, rk, a, { leaseSeconds = 300 } = {}) => {
    w.n.claimLease += 1;
    const j = jobOf(cycleId, rk, a);
    if (!j) return { disposition: "not-found", leaseToken: null, snapshotParamsHash: null };
    if (j.validated === true) return { disposition: "already-complete", leaseToken: null, snapshotParamsHash: j.snapshot_params_hash };
    if (j.derive_status === "running" && j.lease_expires > w.now()) return { disposition: "held", leaseToken: null, snapshotParamsHash: null };
    const disposition = j.derive_status === "running" ? "reclaimed" : "claimed";
    j.derive_status = "running"; j.lease_token = nextId("lt"); j.lease_expires = w.now() + leaseSeconds * 1000;
    return { disposition, leaseToken: j.lease_token, snapshotParamsHash: null };
  };
  w.reconcileSuccess = async ({ cycleId, reportKey, accountId, snapshotParamsHash, leaseToken }) => {
    w.n.reconcile += 1;
    const j = jobOf(cycleId, reportKey, accountId); if (!j) return { disposition: "not-found" };
    if (j.validated === true) return { disposition: "already-complete" };
    if (j.lease_token !== leaseToken) return { disposition: "lease-lost" };
    Object.assign(j, { validated: true, derive_status: "succeeded", save_status: "succeeded", snapshot_params_hash: snapshotParamsHash });
    return { disposition: "reconciled" };
  };
  w.finalizeCycle = async ({ cycleId }, _opt, io, info) => {
    w.n.finalize += 1;
    const c = cycleById(cycleId); if (!c) return { disposition: "not-found" };
    if (c.status === "succeeded" || c.status === "partial") return { disposition: "already-terminal" };
    if (c.status !== "running") return { disposition: "invalid-status" };
    const own = w.jobs.filter((j) => j.cycle_id === cycleId);
    c.status = !own.length || own.some((j) => j.validated === true) ? "succeeded" : "partial"; c.updated_at = iso(w.now());
    await w.fault("prepare:after-finalize", io, info);
    return { disposition: "finalized" };
  };
  const latestJobRow = (rk, a) => w.jobs.filter((x) => x.report_key === rk && x.account_id === a).sort((x, y) => y.created_at - x.created_at)[0] || null;
  w.readLatestJob = async (rk, a) => {
    const j = latestJobRow(rk, a); if (!j) return null;
    const c = cycleById(j.cycle_id);
    return { reportKey: j.report_key, accountId: j.account_id, deriveStatus: j.derive_status, saveStatus: j.save_status, validated: j.validated === true, dependsOn: j.depends_on.map(String), durableContentDeps: j.durable_content_deps.map(String), snapshotParamsHash: j.snapshot_params_hash, latestDataDate: null, cycleStatus: c ? c.status : null, id: j.id, cycleId: j.cycle_id, createdAt: j.created_at };
  };
  w.publisherJob = async (rk, a) => { const j = latestJobRow(rk, a); if (!j) return null; const c = cycleById(j.cycle_id); return { cycle_id: j.cycle_id, report_key: rk, account_id: a, derive_status: j.derive_status, save_status: j.save_status, validated: j.validated === true, snapshot_params_hash: j.snapshot_params_hash, cycle_status: c ? c.status : null }; };
  w.gateCycles = () => [...w.naturalCycles, ...[...w.cycles.values()].map((c) => ({ id: c.id, bucket: c.bucket, status: c.status, cycle_date: c.cycle_date, started_ms: Date.parse(c.created_at), updated_ms: Date.parse(c.updated_at || c.created_at), report_jobs: w.jobs.filter((j) => j.cycle_id === c.id).length, open_report_jobs: w.jobs.filter((j) => j.cycle_id === c.id && !j.validated).length }))];

  // ---- the control-plane lease (acquire_control_plane_lease / renew / release SQL semantics) ----
  w.acquireLease = (owner, op, ttl) => {
    const t = Math.min(Math.max(Number(ttl) || 900, 30), 3600) * 1000; const now = w.now(); const L = w.lease;
    const free = !L.owner || !(L.exp > now);
    if (free || L.owner === owner) {
      const sameLive = L.owner === owner && !free;
      const gen = sameLive ? L.gen : L.gen + 1;
      w.lease = { owner, op, gen, exp: now + t };
      return { disposition: "acquired", owner_token: owner, generation: gen, ttl_seconds: t / 1000, renewed: sameLive };
    }
    w.n.leaseHeld += 1;
    if (typeof w.onLeaseHeld === "function") w.onLeaseHeld(owner);
    return { disposition: "held", owner_token: L.owner, generation: L.gen, expires_at: L.exp };
  };
  w.renewLease = (owner, gen, ttl) => { const L = w.lease; if (L.owner !== owner || L.gen !== Number(gen)) return { disposition: "lost" }; if (!(L.exp > w.now())) return { disposition: "expired" }; L.exp = w.now() + (Number(ttl) || 900) * 1000; return { disposition: "renewed" }; };
  w.releaseLease = (owner, gen) => { const L = w.lease; if (L.owner !== owner) return { disposition: "not-owner" }; if (L.gen !== Number(gen)) return { disposition: "generation-superseded" }; w.lease = { owner: "", op: "", gen: L.gen, exp: 0 }; return { disposition: "released" }; };
  // Transactions are SERIALIZED (the SQL advisory lock); a rollback restores the control rows + the lease row.
  let txChain = Promise.resolve();
  const txMutex = () => { let rel; const p = new Promise((r) => { rel = r; }); const prev = txChain; txChain = txChain.then(() => p); return prev.then(() => rel); };
  const snapCtl = () => ({ rollout: new Map(w.ctl.rollout), dispatch: new Map(w.ctl.dispatch), promoted: new Map(w.ctl.promoted), approvals: new Map(w.ctl.approvals), lease: { ...w.lease } });
  w.connectControlStore = () => {
    let release = null; let snap = null;
    const done = () => { const r = release; release = null; snap = null; if (r) r(); };
    const s = {
      begin: async () => { release = await txMutex(); snap = snapCtl(); },
      commit: async () => { done(); },
      rollback: async () => { if (snap) { w.ctl.rollout = snap.rollout; w.ctl.dispatch = snap.dispatch; w.ctl.promoted = snap.promoted; w.ctl.approvals = snap.approvals; w.lease = snap.lease; } done(); },
      end: async () => { if (release) await s.rollback(); },
      readAllPrimary: async () => false,
      hasCron: async () => false,
      setRolloutEnabled: async (ids) => { for (const k of w.ctl.rollout.keys()) w.ctl.rollout.set(k, false); for (const id of ids) w.ctl.rollout.set(String(id), true); },
      disableAllRollout: async () => { for (const k of w.ctl.rollout.keys()) w.ctl.rollout.set(k, false); },
      setDispatchEnabled: async (enabled, controlled) => { for (const k of controlled) w.ctl.dispatch.set(k, enabled.includes(k)); },
      pauseAllDispatch: async (controlled) => { for (const k of controlled) w.ctl.dispatch.set(k, false); },
      setPromotedEnabled: async (keys) => { for (const k of w.ctl.promoted.keys()) w.ctl.promoted.set(k, false); for (const k of keys) w.ctl.promoted.set(String(k), true); },
      disableAllPromoted: async () => { for (const k of w.ctl.promoted.keys()) w.ctl.promoted.set(k, false); },
      setApprovalsApproved: async (pairs) => { for (const k of w.ctl.approvals.keys()) w.ctl.approvals.set(k, false); for (const p of pairs) w.ctl.approvals.set(String(p), true); },
      revokeAllApprovals: async () => { for (const k of w.ctl.approvals.keys()) w.ctl.approvals.set(k, false); },
      rolloutRows: async () => [...w.ctl.rollout].map(([account_id, enabled]) => ({ account_id, enabled })),
      dispatchRows: async () => [...w.ctl.dispatch].map(([report_key, schedule_enabled]) => ({ report_key, schedule_enabled })),
      promotedRows: async () => [...w.ctl.promoted].map(([report_key, publish_enabled]) => ({ report_key, publish_enabled })),
      approvalRows: async () => [...w.ctl.approvals].map(([k, approved]) => ({ report_key: k.split("|")[0], account_id: k.split("|")[1], approved })),
      acquireControlLease: async (owner, op, ttl) => w.acquireLease(owner, op, ttl),
      renewControlLease: async (owner, gen, ttl) => w.renewLease(owner, gen, ttl),
      releaseControlLease: async (owner, gen) => w.releaseLease(owner, gen),
      assertControlLeaseOwner: async (owner, gen) => w.lease.owner === owner && w.lease.gen === Number(gen),
      lockAndVerifyControlLease: async (owner, gen) => w.lease.owner === owner && w.lease.gen === Number(gen) && w.lease.exp > w.now(),
    };
    return s;
  };
  w.fenceQuery = async (sql) => {
    if (sql !== FENCE.REPORT_WRITER_FENCE_READ_SQL) throw new Error("fence reader: unexpected statement");
    return [...w.fence].map(([report_key, fenced_only]) => ({ report_key, fenced_only, updated_at: "2026-09-24 00:00:00+00", updated_by: "owner" }));
  };

  // ---- the REAL four-gate publisher (production composition, BUILD-TIME overrides only) ----
  w.makePublisher = ({ getControlFence, io, info }) => {
    const real = buildSchedulerV2Publisher({
      connections: [PRIMARY_CONN],
      fetchAccounts: async () => w.directoryRows.map((r) => ({ id: r.accountId, name: r.name, country: r.country })),
      getAccountRollout: async () => ({ read: "ok", allPrimary: false, enabledAccountIds: [...w.ctl.rollout].filter(([, v]) => v === true).map(([k]) => k) }),
      getSettings: async () => [...w.ctl.dispatch].map(([report_key, schedule_enabled]) => ({ report_key, schedule_enabled })),
      getPromotedSettings: async () => [...w.ctl.promoted].map(([report_key, publish_enabled]) => ({ report_key, publish_enabled })),
      getApproval: async (rk, a) => ({ read: "ok", approved: w.ctl.approvals.get(rk + "|" + a) === true }),
      getJob: w.publisherJob,
      getSnapshot: w.readSnapshot,
      loadStoragePayload: w.loadStoragePayload,
      publishLiveFenced: (args) => w.liveCasFenced(args, io, info),
      getControlFence,
    });
    return {
      preflight: async (rk, a) => { w.n.preflight += 1; return real.preflight(rk, a); },
      publish: async (rk, a) => { w.n.publish += 1; await w.fault("publish:cas", io, info); return real.publish(rk, a); },
    };
  };

  // ---- faults ----
  // { point, when?(info), action: 'hang' (the child never proceeds; the REAL runner timer kills it) | 'crash' (exit 1
  // at that instant, nothing after it runs) | 'call' (await fn(info, io) then continue), kind? (hang: the runner kind) }
  w.fault = async (point, io, info) => {
    for (const f of w.faults) {
      if (f.used && f.once !== false) continue;
      if (f.point !== point) continue;
      if (f.when && !f.when(info || {})) continue;
      f.used = true; f.hits = (f.hits || 0) + 1;
      if (f.action === "call") { await f.fn(info || {}, io); continue; }
      if (f.action === "crash") { if (io) io.exit(1, null); return new Promise(() => {}); }
      if (f.action === "hang") return new Promise(() => {});
    }
    return undefined;
  };
  w.armedHang = (kind) => w.faults.some((f) => !f.used && f.action === "hang" && f.kind === kind);

  // ---- the read-only supabase namespace a route runtime is built with (through REL.readOnlySupabase) ----
  w.sbNamespace = () => ({
    getReportSnapshot: w.readSnapshot,
    getLatestReportSnapshot: w.getLatest,
    getLatestReportSnapshotForScope: w.getLatestForScope,
    // The REAL supabase.js storage-first hydrated reader, its row read injected (it accepts readLatest / readStorage).
    getLatestReportSnapshotHydrated: (args, opts = {}) => SB.getLatestReportSnapshotHydrated(args, { readStorage: w.loadStoragePayload, ...opts, readLatest: w.getLatest }),
    getReportSnapshotStoragePayload: w.loadStoragePayload,
    getReturnsHistoryRows: async () => { throw new Error("returns history is read through the returns-v3 gather seam in this suite"); },
    getSettlementHistoryRows: async () => { throw new Error("settlement history is read through the returns-v3 gather seam in this suite"); },
    getSourceOliHistoryRows: async ({ organizationFingerprint, connectionId, accountIds, from, to }) => (organizationFingerprint !== ORG || connectionId !== "primary" ? [] : clone(w.history.filter((r) => (accountIds || []).includes(r.account_id) && r.sale_date >= from && r.sale_date <= to && r.sales_amount > 0))),
    getSourceCoverageWindows: async ({ organizationFingerprint, connectionId, accountId, sourceKey }) => ({ windows: w.coverage.filter((r) => r.organization_fingerprint === organizationFingerprint && r.connection_id === connectionId && r.account_id === accountId && r.source_key === sourceKey && r.status === "succeeded").sort((x, y) => (x.covered_from < y.covered_from ? -1 : 1)).map((r) => ({ from: r.covered_from, to: r.covered_to })), read: "ok", error: null }),
    getSourceSnapshot: async ({ organizationFingerprint, connectionId, sourceKey, scopeKey }) => ({ snapshot: w.catalog && organizationFingerprint === ORG && connectionId === "primary" && sourceKey === "product-catalog" && scopeKey === "__organization" ? { organization_fingerprint: ORG, connection_id: "primary", source_key: sourceKey, scope_key: scopeKey, ...clone(w.catalog) } : null, read: "ok", error: null }),
    getSourceSnapshotPayload: async (p) => { if (!w.catalogPayloads.has(p)) throw new Error("missing object"); return clone(w.catalogPayloads.get(p)); },
    getSourceOliOperationalUnitRows: async ({ organizationFingerprint, connectionId, accountIds, from, to, additiveOnly }) => clone(w.opunits.filter((u) => u.organization_fingerprint === organizationFingerprint && u.connection_id === connectionId && (accountIds || []).includes(u.account_id) && u.sale_date >= from && u.sale_date <= to && (!additiveOnly || u.explicit_zero_units > 0 || u.pending_units > 0))),
    getOliSkuAsinResolutionRows: async ({ accountId }) => clone(w.resolution.get(accountId) || []),
    // WRITERS on the raw namespace: the read-only facade must strip them (a route runtime can never reach one).
    saveReportSnapshot: async () => { throw new Error("an unfenced writer reached a route runtime (must be impossible)"); },
    publishLiveSnapshotIfNewer: async () => { throw new Error("an unfenced CAS reached a route runtime (must be impossible)"); },
  });

  // ---- the returns-v3 strict gather (the release module's own gatherEvidence test seam; a fixture over the rows) ----
  w.returnsGather = async ({ accountId, asOf }) => {
    const gf = w.gatherFaults.get(accountId); if (gf) return { notReady: gf };
    const rec = w.returns.get(accountId) || { returns: [], settlement: [] };
    const { from } = returnsWindow(asOf);
    const ret = rec.returns.filter((r) => r.return_date >= from && r.return_date <= asOf);
    const set = rec.settlement.filter((r) => r.settlement_date >= from && r.settlement_date <= asOf);
    const latest = maxStr([ret.length ? maxStr(ret.map((r) => r.return_date)) : null, maxStr(set.filter((r) => S(r.child_asin).trim() !== "").map((r) => r.settlement_date))]);
    const covTo = maxStr(w.coverage.filter((c) => c.account_id === accountId && c.status === "succeeded" && c.covered_to >= from && c.covered_from <= asOf).map((c) => c.covered_to));
    const result = { payload: returnsPayload(accountId, asOf, latest, ret.length + set.length), latestDataDate: latest, evidence: { durableReturnRows: clone(ret), durableSettlementRows: clone(set), orderedRows: [], catalogRows: clone(CATALOG_ROWS), catalogPayloadSha: w.catalog ? w.catalog.payload_sha : null, oliCoveredTo: covTo } };
    if (typeof w.hooks.afterGather === "function") await w.hooks.afterGather({ accountId });
    return result;
  };

  // ---- evidence mutations ----
  w.bumpCoverage = (acct, stamp) => { for (const c of w.coverage) if (c.account_id === acct) { c.source_refreshed_at = stamp; c.updated_at = stamp; } };
  w.bumpFbaPointer = (acct, n, validatedAt) => w.fbaPointers.set(acct, { object_path: "fba/" + acct + "/" + n + ".json", payload_sha: "fsha-" + acct + "-" + n, row_count: 3, source_request_hash: "freq-" + acct + "-" + n, validated_at: validatedAt });
  w.addReturn = (acct, date, stamp) => { const r = w.returns.get(acct); r.returns.push(returnsRow(acct, date, r.returns.length, stamp)); };

  w.pgQuery = makePgQuery(w);
  return w;
}

// ---- the fake READ-ONLY SQL world: every route evidence statement (exact text) emulated over the world tables -------
function makePgQuery(w) {
  const byText = new Map();
  const add = (owner, list) => { for (const q of list) if (!byText.has(q.text)) byText.set(q.text, owner + ":" + q.name); };
  add("legacy", Object.values(OLI_W.LEGACY_EVIDENCE_SQL));
  add("fba-plan", FP_W.FBA_PLAN_EVIDENCE_SQL);
  add("returns", RT_W.RETURNS_V3_EVIDENCE_SQL);
  add("sku", SKU_W.SKU_MOVEMENT_EVIDENCE_SQL);
  byText.set(SKU_C.SKU_BRAND_LIST_SQL, "sku:brand_list");
  byText.set(BVB_W.LATEST_ROWS_SQL, "bvb:latest_rows");
  const cov = () => w.coverage.filter((c) => c.status === "succeeded" && c.connection_id === "primary" && c.source_key === "order-line-items");
  const groupBy = (rows, key) => { const m = new Map(); for (const r of rows) { const k = S(r[key]); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return [...m]; };
  const inIds = (ids, a) => Array.isArray(ids) && ids.includes(a);
  const retAgg = (kind, dateCol, org, conn, ids, from, to) => {
    const outR = [];
    for (const a of ids || []) {
      const rows = ((w.returns.get(a) || {})[kind] || []).filter((r) => r.organization_fingerprint === org && r.connection_id === conn && r[dateCol] >= from && r[dateCol] <= to);
      if (!rows.length) continue;
      outR.push({ account_id: a, n: rows.length, refreshed: toUs(maxStr(rows.map((r) => r.refreshed_at))), created: toUs(maxStr(rows.map((r) => r.created_at))), updated: toUs(maxStr(rows.map((r) => r.updated_at))), max_date: maxStr(rows.map((r) => r[dateCol])), ...(kind === "settlement" ? { max_asin_date: maxStr(rows.filter((r) => S(r.child_asin).trim() !== "").map((r) => r[dateCol])) } : {}) });
    }
    return outR;
  };
  const snapRows = () => [...w.snaps.values()];
  const H = {
    "legacy:oli_coverage": () => groupBy(cov(), "account_id").map(([a, rows]) => ({ account_id: a, covered_to: maxStr(rows.map((r) => r.covered_to)), refreshed: maxStr(rows.map((r) => r.source_refreshed_at)) })),
    "legacy:oli_completeness": () => w.completeness.map((r) => ({ ...r })),
    "legacy:fba_pointers": () => [...w.fbaPointers].map(([a, p]) => ({ account_id: a, source_request_hash: p.source_request_hash, payload_sha: p.payload_sha })),
    "legacy:ads_revs": () => [...w.adsRevs].map(([a, revs]) => ({ account_id: a, revs })),
    "legacy:listings_pointers": () => [...w.listings].map(([a, l]) => ({ account_id: a, ...l })),
    "legacy:catalog_pointer": () => (w.catalog ? [{ payload_sha: w.catalog.payload_sha }] : []),
    "fba-plan:fba_pointers": ([org, ids]) => (org !== ORG ? [] : [...w.fbaPointers].filter(([a]) => inIds(ids, a)).map(([a, p]) => ({ account_id: a, organization_fingerprint: ORG, connection_id: "primary", source_key: "fba-inventory-health", scope_key: a, ...p }))),
    "fba-plan:awd_pointers": ([org, ids]) => (org !== ORG ? [] : [...w.awdPointers].filter(([a]) => inIds(ids, a)).map(([a, p]) => ({ account_id: a, organization_fingerprint: ORG, connection_id: "primary", ...p }))),
    "fba-plan:oli_coverage": ([org, ids]) => (org !== ORG ? [] : cov().filter((c) => inIds(ids, c.account_id)).map((c) => ({ account_id: c.account_id, covered_from: c.covered_from, covered_to: c.covered_to, source_refreshed_at: c.source_refreshed_at }))),
    "fba-plan:catalog_pointer": ([org]) => (org === ORG && w.catalog ? [{ organization_fingerprint: ORG, connection_id: "primary", source_key: "product-catalog", scope_key: "__organization", ...w.catalog }] : []),
    "returns:returns": ([org, conn, ids, from, to]) => retAgg("returns", "return_date", org, conn, ids, from, to),
    "returns:settlement": ([org, conn, ids, from, to]) => retAgg("settlement", "settlement_date", org, conn, ids, from, to),
    "returns:oli": ([org, conn, ids, from, to]) => groupBy(cov().filter((c) => c.organization_fingerprint === org && c.connection_id === conn && inIds(ids, c.account_id) && c.covered_to >= from && c.covered_from <= to), "account_id").map(([a, rows]) => ({ account_id: a, n: rows.length, covered_to: maxStr(rows.map((r) => r.covered_to)), digest: sha256(rows.map((r) => r.covered_from + ".." + r.covered_to + "@" + toUs(r.source_refreshed_at) + "@" + toUs(r.updated_at)).sort().join(",")).slice(0, 32) })),
    "returns:opunits": ([org, conn, ids, from, to]) => groupBy(w.opunits.filter((u) => u.organization_fingerprint === org && u.connection_id === conn && inIds(ids, u.account_id) && u.sale_date >= from && u.sale_date <= to), "account_id").map(([a, rows]) => ({ account_id: a, n: rows.length, updated: toUs(maxStr(rows.map((r) => r.updated_at))) })),
    "returns:catalog": ([org, conn]) => (org === ORG && conn === "primary" && w.catalog ? [{ payload_sha: w.catalog.payload_sha, validated: toUs(w.catalog.validated_at) }] : []),
    "sku:sku_coverage": ([org, conn, ids]) => cov().filter((r) => r.organization_fingerprint === org && r.connection_id === conn && inIds(ids, r.account_id)).map((r) => ({ account_id: r.account_id, covered_from: r.covered_from, covered_to: r.covered_to, source_refreshed_at: toUs(r.source_refreshed_at), updated_at: toUs(r.updated_at) })).sort((x, y) => (x.account_id + x.covered_from + x.covered_to < y.account_id + y.covered_from + y.covered_to ? -1 : 1)),
    "sku:sku_opunits": ([org, conn, ids, ceiling]) => {
      const outR = [];
      for (const id of [...(ids || [])].sort()) {
        const tos = cov().filter((r) => r.organization_fingerprint === org && r.connection_id === conn && r.account_id === id).map((r) => r.covered_to);
        if (!tos.length) continue;
        const maxTo = tos.sort().pop();
        const eff = ceiling == null || maxTo < ceiling ? maxTo : ceiling;
        const from = monthBackStr(eff, 3);
        const rows = w.opunits.filter((u) => u.organization_fingerprint === org && u.connection_id === conn && u.account_id === id && u.sale_date >= from && u.sale_date <= eff);
        const maxUpd = maxStr(rows.map((u) => u.updated_at));
        outR.push({ account_id: id, eff_as_of: eff, window_from: from, unit_rows: rows.length, max_updated_at: maxUpd ? toUs(maxUpd) : null });
      }
      return outR;
    },
    "sku:sku_catalog": ([org, conn]) => (w.catalog && org === ORG && conn === "primary" ? [{ payload_sha: w.catalog.payload_sha, source_request_hash: w.catalog.source_request_hash, validated_at: toUs(w.catalog.validated_at) }] : []),
    "sku:sku_brands": ([ids, hashes]) => { const pairs = new Set((ids || []).map((id, i) => id + "|" + hashes[i])); return snapRows().filter((r) => r.report_key === "brand-view-brands" && pairs.has(r.account_id + "|" + r.params_hash)).map((r) => ({ account_id: r.account_id, params_hash: r.params_hash, source_refreshed_at: toUs(r.source_refreshed_at), updated_at: toUs(r.updated_at) })); },
    "sku:brand_list": ([acct, hash]) => snapRows().filter((r) => r.report_key === "brand-view-brands" && r.account_id === acct && r.params_hash === hash).map((r) => ({ account_id: r.account_id, params_hash: r.params_hash, source_refreshed_at: toUs(r.source_refreshed_at), updated_at: toUs(r.updated_at), payload_account_id: r.payload ? (r.payload.accountId == null ? null : S(r.payload.accountId)) : null, brands: r.payload && r.payload.brands !== undefined ? clone(r.payload.brands) : null, payload_storage_path: r.payload_storage_path || null })),
    "bvb:latest_rows": ([rks, ids]) => {
      const outR = [];
      for (const rk of rks || []) for (const a of ids || []) {
        const rows = snapRows().filter((r) => r.report_key === rk && r.account_id === a);
        if (!rows.length) continue;
        const top = maxStr(rows.map((r) => r.updated_at));
        for (const r of rows.filter((x) => x.updated_at === top)) {
          const inv = rk === "brand-inventory" && r.payload ? r.payload : null;
          outR.push({ report_key: rk, account_id: a, id: String(r.id), params_hash: r.params_hash, source_refreshed_at: toUs(r.source_refreshed_at), updated_at: toUs(r.updated_at), report_version: r.params && r.params.reportVersion != null ? String(r.params.reportVersion) : null, inv_available: inv ? inv.inventoryAvailable : null, inv_date: inv ? inv.inventoryDate : null, inv_snapshot_date: inv ? (inv.inventorySnapshotDate ?? null) : null, inv_ibbc_type: inv ? (Array.isArray(inv.inventoryByBrandCountry) ? "array" : null) : null });
        }
      }
      return outR;
    },
  };
  return async (text, values = []) => {
    if (!RC.isReadOnlyEvidenceSql(text)) throw new Error("fake pg: a non-read-only statement was refused (fail closed)");
    const key = byText.get(text);
    if (!key || !H[key]) throw new Error("fake pg: unknown statement");
    w.n.pg += 1;
    if (w.pgFail) throw new Error("fake pg: connection refused");
    return clone(H[key](values || []));
  };
}

// =====================================================================================================================
// FIXTURE route runtimes (CLI side) + fixture worker composes
// =====================================================================================================================
const bvbLiveRow = (w, acct) => w.row("brand-view-brands", acct, SKU_W.brandViewBrandsLiveHash(acct));
const rowIdent = (r) => (r ? [r.id, r.params_hash, r.source_refreshed_at, r.updated_at] : null);
// brand-view: ONE token function shared by the worker compose and the CLI runtime (the real route's shared-compose rule).
function bvEvidence(w, acct, nowMs, directory) {
  const dir = directory instanceof Map ? directory.get(acct) : null;
  const country = S(dir && dir.country);
  const asOf = country ? marketplaceToday(country, new Date(Number(nowMs))) : null;
  const bvb = bvbLiveRow(w, acct);
  if (!bvb || !bvb.payload || !Array.isArray(bvb.payload.brands)) return { token: null, reason: "brand-directory-unpublished", asOf, brands: [] };
  const ids = ["brand-sales", "fba-plan", "brand-inventory", "returns-leakage"].map((rk) => [rk, rowIdent(w.newest(rk, acct))]);
  const brands = [...bvb.payload.brands];
  return { token: "fxbv1:" + sha256(J([acct, asOf, rowIdent(bvb), ids, brands])), reason: null, asOf, brands };
}
function pfEvidence(w, region, nowMs, directory) {
  const members = REL.regionAccountIds(directory, region, accountInScope);
  const asOf = PF_W.portfolioAsOf(Number(nowMs));
  const brandMembers = new Map();
  for (const a of members) { const b = bvbLiveRow(w, a); for (const brand of (b && b.payload && Array.isArray(b.payload.brands) ? b.payload.brands : [])) { if (!brandMembers.has(brand)) brandMembers.set(brand, []); brandMembers.get(brand).push(a); } }
  const brands = [...brandMembers].map(([brand, ms]) => ({ brand, unitKey: sha12(brand), members: [...ms].sort() })).sort((x, y) => (x.brand < y.brand ? -1 : 1));
  if (!brands.length) return { token: null, reason: "region-directory-empty", asOf, members, brands };
  const latest = members.map((a) => [a, rowIdent(bvbLiveRow(w, a)), ["brand-sales", "fba-plan", "brand-inventory"].map((rk) => rowIdent(w.newest(rk, a)))]);
  return { token: "fxpf1:" + sha256(J([region, asOf, members, latest, brands])), reason: null, asOf, members, brands };
}
const FIXTURE_COMPOSE = {
  "brand-view": (w, ctx) => new Map(ctx.accountIds.map((a) => { const e = bvEvidence(w, a, ctx.now, ctx.directory); return [a, e.token ? { token: e.token, owners: [a], region: ctx.region, targetAsOf: e.asOf, alerts: [] } : { token: null, owners: [a], region: ctx.region, alerts: [], reason: e.reason }]; })),
  "brand-view-portfolio": (w, ctx) => { const e = pfEvidence(w, ctx.region, ctx.now, ctx.directory); const owners = e.members.length ? e.members : ["none"]; return new Map([["region:" + ctx.region, e.token ? { token: e.token, owners, region: ctx.region, targetAsOf: e.asOf, alerts: [] } : { token: null, owners, region: ctx.region, alerts: [], reason: e.reason }]]); },
};
const noRev = (reason) => ({ eligible: false, reason, status: "ineligible" });
function buildFbaPlanFixture(deps) {
  const { world: w, directory, bucket, pgReadOnly, now } = deps;
  const regionIds = REL.regionAccountIds(directory, bucket, accountInScope);
  const read = async (epoch) => {
    // The REAL fba-plan evidence SQL + compose (the worker's token function) over the WHOLE region (salesAsOf rule).
    const ctx = { epoch, organizationFingerprint: ORG, accountIds: regionIds, directory, region: bucket };
    const rowsByName = {};
    for (const q of FP_W.FBA_PLAN_EVIDENCE_SQL) rowsByName[q.name] = await pgReadOnly(q.text, q.params(ctx));
    return FP_W.composeFbaPlanEvidence(rowsByName, ctx).perAccount;
  };
  const revisionOf = (ev) => {
    if (!ev) return noRev("evidence-missing");
    if (!ev.fbaPointer) return noRev("fba-durable-missing");
    if (!ev.catalogPointer) return noRev("catalog-durable-missing");
    if (!ev.salesAsOf) return noRev("sales-asof-unresolved");
    return { eligible: true, revisionId: ev.token, evidenceToken: ev.token, deps: ["fba:" + ev.fbaPointer.source_request_hash, "catalog:" + ev.catalogPointer.payload_sha, "oli:" + ev.coverageDigest].sort(), status: "available" };
  };
  const countryOf = (a) => S(directory.get(a) && directory.get(a).country) || "IN";
  return {
    async readScopeEvidence({ scope, epoch }) { try { const all = await read(epoch); return { ok: true, perAccount: new Map((scope || []).map((a) => [a, all.get(a) || null])) }; } catch (_e) { return { ok: false, failCode: "DURABLE_SOURCE_UNREADABLE: fba-plan-fixture" }; } },
    computeRevision({ evidence }) { return revisionOf(evidence); },
    expandUnits({ accountId, evidence }) { return [{ unitKey: "-", targetId: accountId, liveAccountId: accountId, ownerAccountIds: [accountId], targetAsOf: evidence.salesAsOf, reportKeys: ["fba-plan"] }]; },
    async resolveBundle(unit, { epoch }) {
      let all; try { all = await read(epoch); } catch (_e) { return noRev("evidence-unreadable"); }
      const ev = all.get(unit.targetId); const rev = revisionOf(ev); if (!rev.eligible) return rev;
      const f = w.routeFaults.get("fba-plan|" + unit.targetId); if (f) return noRev(f);
      return { eligible: true, revisionId: rev.revisionId, evidenceToken: rev.evidenceToken, manifestToken: "fpm1:" + sha256(J([ev.token, ev.fbaPointer.payload_sha, ev.catalogPointer.payload_sha])), deps: rev.deps, evidenceInstant: ev.fbaPointer.validated_at, bundle: { accountId: unit.targetId, salesAsOf: ev.salesAsOf, inventoryAsOf: ev.inventoryAsOf, fbaSha: ev.fbaPointer.payload_sha, country: ev.country } };
    },
    async derive(bundle) { return { payload: fbaPlanPayload(bundle), latestDataDate: bundle.salesAsOf }; },
    identityParams(_unit, { bundle }) { return { to: bundle.salesAsOf }; },
    identityAsOf(_unit, { bundle }) { return bundle.salesAsOf; },
    // The fba-plan serve (report-store serveSharedReport): the EXACT browser-today row, else the ONE latest row (C3).
    servedSelector(unit) { return SEL.selectExactThenLatest({ reportKey: "fba-plan", accountId: unit.liveAccountId, reportVersion: LIVE["fba-plan"].liveReportVersion, params: { to: marketplaceToday(countryOf(unit.liveAccountId), new Date(now())) }, readers: { getReportSnapshot: w.readSnapshot, getLatestReportSnapshot: w.getLatest }, computeHash: paramsHashFor }); },
  };
}
function buildBrandViewFixture(deps) {
  const { world: w, directory, now } = deps;
  const ownerOf = (unit) => S(unit && unit.ownerAccountIds && unit.ownerAccountIds[0]);
  const brandOf = (unit) => S(unit.targetId).slice(("brand-view:" + ownerOf(unit) + "::").length);
  return {
    async readScopeEvidence({ scope }) { return { ok: true, perAccount: new Map((scope || []).map((a) => [a, { accountId: a, ...bvEvidence(w, a, now(), directory) }])) }; },
    computeRevision({ evidence }) { if (!evidence || !evidence.token) return noRev(S(evidence && evidence.reason) || "brand-view-evidence-missing"); return { eligible: true, revisionId: evidence.token, evidenceToken: evidence.token, deps: ["bv:" + sha12(evidence.token)], status: "available" }; },
    expandUnits({ accountId, evidence }) { return evidence.brands.map((brand) => ({ unitKey: sha12(brand), targetId: brandViewScopeId(accountId, brand), liveAccountId: brandViewScopeId(accountId, brand), ownerAccountIds: [accountId], targetAsOf: evidence.asOf, reportKeys: ["brand-view"] })); },
    async resolveBundle(unit) {
      const owner = ownerOf(unit); const brand = brandOf(unit);
      const ev = bvEvidence(w, owner, now(), directory);
      if (!ev.token) return noRev(ev.reason);
      const f = w.routeFaults.get("brand-view|" + owner); if (f) return noRev(f);
      if (!ev.brands.includes(brand)) return noRev("brand-not-in-directory");
      return { eligible: true, revisionId: ev.token, evidenceToken: ev.token, manifestToken: "bvm1:" + sha256(J([ev.token, brand])), depFingerprint: "bvdf1:" + sha256(J([owner, brand, ev.token])), deps: ["bv:" + sha12(ev.token)], bundle: { owner, brand, asOf: ev.asOf } };
    },
    async derive(bundle) { return { payload: brandViewPayload("account", bundle.brand, bundle.asOf, [bundle.owner], bundle.owner) }; },
    identityParams(_unit, { bundle }) { return { ownerAccountId: bundle.owner, brand: bundle.brand, asOf: bundle.asOf }; },
    identityAsOf(_unit, { bundle }) { return bundle.asOf; },
    servedSelector(unit) { return SEL.selectExactThenLatest({ reportKey: "brand-view", accountId: unit.liveAccountId, reportVersion: LIVE["brand-view"].liveReportVersion, params: { accountId: ownerOf(unit), brand: brandOf(unit), asOf: unit.targetAsOf }, readers: { getReportSnapshot: w.readSnapshot, getLatestReportSnapshot: w.getLatest }, computeHash: paramsHashFor }); },
  };
}
function buildPortfolioFixture(deps) {
  const { world: w, directory, bucket, now } = deps;
  const target = "region:" + bucket;
  const unitBrand = (ev, unit) => ev.brands.find((b) => b.unitKey === unit.unitKey) || null;
  return {
    scopeTargets() { return [target]; },
    async readScopeEvidence({ scope }) { return { ok: true, perAccount: new Map((scope || []).map((t) => [t, { targetId: t, ...pfEvidence(w, bucket, now(), directory) }])) }; },
    computeRevision({ evidence }) { if (!evidence || !evidence.token) return noRev(S(evidence && evidence.reason) || "brand-view-evidence-missing"); return { eligible: true, revisionId: evidence.token, evidenceToken: evidence.token, deps: ["pf:" + sha12(evidence.token)], status: "available" }; },
    expandUnits({ evidence }) { return evidence.brands.map((b) => ({ unitKey: b.unitKey, targetId: brandViewPortfolioScopeId(b.members, b.brand), liveAccountId: brandViewPortfolioScopeId(b.members, b.brand), ownerAccountIds: b.members, targetAsOf: evidence.asOf, reportKeys: ["brand-view-portfolio"] })); },
    async resolveBundle(unit) {
      const ev = pfEvidence(w, bucket, now(), directory);
      if (!ev.token) return noRev(ev.reason);
      const f = w.routeFaults.get("brand-view-portfolio|" + target); if (f) return noRev(f);
      const b = unitBrand(ev, unit); if (!b) return noRev("unit-identity-changed");
      return { eligible: true, revisionId: ev.token, evidenceToken: ev.token, manifestToken: "pfm2:" + sha256(J([b.brand, b.members, ev.asOf])), depFingerprint: "pfdf1:" + sha256(J([b.brand, ev.token])), deps: ["pf:" + sha12(ev.token)], bundle: { brand: b.brand, members: b.members, asOf: ev.asOf } };
    },
    async derive(bundle) { return { payload: brandViewPayload("portfolio", bundle.brand, bundle.asOf, bundle.members) }; },
    identityParams(_unit, { bundle }) { return { members: [...bundle.members], brand: bundle.brand, asOf: bundle.asOf, region: bucket }; },
    identityAsOf(_unit, { bundle }) { return bundle.asOf; },
    servedSelector(unit) { const ev = pfEvidence(w, bucket, now(), directory); const b = unitBrand(ev, unit) || { brand: "", members: [] }; return SEL.selectExactThenScopeLatest({ reportKey: "brand-view-portfolio", accountId: unit.liveAccountId, reportVersion: LIVE["brand-view-portfolio"].liveReportVersion, params: { accountIds: b.members.join(","), brand: b.brand, asOf: unit.targetAsOf, region: bucket }, staleScopeKeys: ["region"], readers: { getReportSnapshot: w.readSnapshot, getLatestReportSnapshotForScope: w.getLatestForScope }, computeHash: paramsHashFor }); },
  };
}
const FIXTURE_CLI = {
  "fba-plan": Object.freeze({ id: "fba-plan", publisherKey: "fba-plan", stampPolicy: "evidence", build: buildFbaPlanFixture }),
  "brand-view": Object.freeze({ id: "brand-view", publisherKey: "brand-view", stampPolicy: "cycle", build: buildBrandViewFixture }),
  "brand-view-portfolio": Object.freeze({ id: "brand-view-portfolio", publisherKey: "brand-view-portfolio", stampPolicy: "cycle", build: buildPortfolioFixture }),
};
const CLI_MODULES = { "returns-v3": RT_C, "sku-movement": SKU_C, "brand-view-brands": BVB_C, ...FIXTURE_CLI };
const REAL_RUNTIME_ROUTES = Object.freeze(["returns-v3", "sku-movement", "brand-view-brands"]);

// =====================================================================================================================
// THE CHILD EMULATIONS (the route CLI main flow mirrored; the legacy CLIs as TARGETS v1 fixtures)
// =====================================================================================================================
function guardBlock(guard, io, method, p) {
  guard.blocked += 1;
  io.err(RUN.ZERO_EXPORT_LINE_PREFIX + J({ blocked: guard.blocked, allowedAccountsGets: guard.allowedAccountsGets }));
  const e = new Error(`ZERO_EXPORT_BLOCKED: a DataDoe ${method} ${p} was refused by the publication-recovery zero-export guard`);
  e.code = "ZERO_EXPORT_BLOCKED";
  return e;
}
async function routeCliMain(w, argv, env, io) {
  const parsed = REL.parseRouteCliArgs(argv);
  if (!parsed.ok) { io.err("STOP " + parsed.code + ": " + parsed.message); return 2; }
  const A = parsed.args;
  const { bucket, asOf } = A;
  const dryRun = A.dryRun;
  const info = { cli: "route", route: A.routes.join("+"), routes: A.routes, live: !dryRun, verifyExact: A.verifyExact, cleanup: A.cleanup, mode: A.mode, runToken: A.runToken, targets: A.targets };
  w.cliRuns.push(info);
  const guard = { blocked: 0, allowedAccountsGets: 0 };
  const finalZero = () => io.err(RUN.ZERO_EXPORT_LINE_PREFIX + J({ blocked: guard.blocked, allowedAccountsGets: guard.allowedAccountsGets, final: true }));
  const OPERATOR = REL.routeCliOperator({ bucket, runToken: A.runToken, asOf });
  const CONTROL_OP_KEY = "publication-route-reconcile/" + A.routes.join("+") + "/" + bucket + "/" + asOf;
  const connectStore = async () => w.connectControlStore();
  const readControlPlaneClosed = () => REL.readRouteControlPlaneClosed({ connectStore, controlledReportKeys: CONTROLLED_REPORT_KEYS });
  if (A.cleanup) {
    await w.fault("cleanup:start", io, info);
    const before = await readControlPlaneClosed();
    if (before.read === "ok" && before.closed === true) { io.out("RESULT " + J({ mode: "cleanup", routes: A.routes, bucket, epoch: asOf, cleaned: true, disposition: "already-closed", dataDoeCreates: 0, dataDoeTokens: 0 })); finalZero(); return 0; }
    let reclaim = null;
    try { reclaim = await CP.runControlPackageCli({ mode: "reclaim", operator: OPERATOR, connectStore, ownerToken: OPERATOR, operationKey: CONTROL_OP_KEY, log: () => {} }); }
    catch (e) { reclaim = { committed: false, code: 1, error: S(e && e.message) }; }
    if (reclaim && Number(reclaim.code) === 3) { io.err("STOP ROUTE_CLEANUP_COMMIT_UNKNOWN -- read-only reconciliation required; controls NOT proven closed."); finalZero(); return 1; }
    const after = await readControlPlaneClosed();
    const cleaned = after.read === "ok" && after.closed === true;
    io.out("RESULT " + J({ mode: "cleanup", routes: A.routes, bucket, epoch: asOf, cleaned, reclaim: reclaim && (reclaim.skipped || (reclaim.committed ? "committed" : "refused-or-held")), before: before.detail || before.read, after: after.detail || after.read, dataDoeCreates: 0, dataDoeTokens: 0 }));
    if (!cleaned) io.err("STOP ROUTE_CLEANUP_UNVERIFIED: controls NOT proven closed (a live owner is left untouched; retry after the lease expires).");
    finalZero();
    return cleaned ? 0 : 1;
  }
  if (typeof w.zeroExportTrap === "function" && w.zeroExportTrap(info)) guardBlock(guard, io, "POST", "/api/v1/exports");
  const loaded = [];
  for (const id of A.routes) {
    const mod = CLI_MODULES[id];
    let workerRoute = null; try { workerRoute = ROUTES.routeById(id); } catch (_e) { workerRoute = null; }
    if (!mod || !workerRoute) { io.err(`STOP ROUTE_MODULE_MISSING: route '${id}' -- fail closed.`); return 2; }
    try {
      const cliRoute = RC.validateRouteModule(mod, { side: "cli", liveContracts: LIVE, reportDerivations: REPORT_DERIVATIONS });
      RC.validateRoutePair(RC.validateRouteModule(workerRoute, { side: "worker" }), cliRoute, { liveContracts: LIVE });
      loaded.push({ id, cliRoute, workerRoute });
    } catch (e) { io.err(`STOP ROUTE_MODULE_INVALID: route '${id}': ${S(e && e.message).slice(0, 160)}`); return 2; }
  }
  let order;
  try { order = RC.routeTopoOrder(loaded.map((r) => r.workerRoute)); } catch (_e) { io.err("STOP ROUTE_AWAITS_CYCLE"); return 2; }
  const directory = REL.buildDurableDirectory({ rows: w.directoryRows.map((r) => ({ ...r })), resolveRawSellerId: (id) => (id.includes(":") ? "" : id), normalizeMarketplace }).directory;
  if (!directory.size) { io.err("STOP ROUTE_DIRECTORY_EMPTY: the durable account directory is empty -- fail closed, zero writes."); return 1; }
  const runStartMs = w.now();
  const deadlineSec = A.deadlineSeconds;
  const startCutoffSec = deadlineSec > 0 ? Math.max(Math.floor(deadlineSec / 2), deadlineSec - REL.ROUTE_CLI_START_RESERVE_SECONDS) : 0;
  const outOfTime = () => deadlineSec > 0 && (w.now() - runStartMs) / 1000 > startCutoffSec;
  const controls = REL.buildRouteCliControls({
    runControlPackageCli: CP.runControlPackageCli, connectStore, buildRouteControlPackage: CP.buildRouteControlPackage,
    partialNamespacePermitted: async () => ({ permitted: true }), readControlPlaneClosed,
    operator: OPERATOR, operationKey: CONTROL_OP_KEY, leaseTtlSeconds: 900,
    leaseWaitSeconds: A.mode === "scheduler" ? A.leaseWaitSeconds : 0,
    deadlineSeconds: deadlineSec, runStartMs, startReserveSeconds: REL.ROUTE_CLI_START_RESERVE_SECONDS, now: w.now, sleep: w.sleep,
    log: () => {}, closeLog: () => {},
  });
  const openControls = async (x) => { const r = await controls.openControls(x); await w.fault("controls:open", io, { ...info, opened: r }); return r; };
  const verifyLease = async ({ signal = null } = {}) => {
    if (signal && signal.aborted) return { ok: false, reason: "deadline-aborted" };
    const f = controls.fence(); if (!f) return { ok: false, reason: "no-fence" };
    const r = w.renewLease(f.ownerToken, f.generation, 900);
    return { ok: !!(r && r.disposition === "renewed"), reason: r && (r.reason || r.disposition) };
  };
  let activeOpSignal = null; let runPublisher = null;
  const publisherFor = (signal) => { activeOpSignal = signal || null; if (!runPublisher) runPublisher = w.makePublisher({ getControlFence: () => (activeOpSignal && activeOpSignal.aborted ? null : controls.fence()), io, info }); return runPublisher; };
  const readbackLive = REL.buildRouteLiveReadback({ getReportSnapshot: w.readSnapshot, loadStoragePayload: w.loadStoragePayload, liveContracts: LIVE, reportDerivations: REPORT_DERIVATIONS, computeHash: paramsHashFor });
  const byId = new Map(loaded.map((r) => [r.id, r]));
  const routeResults = [];
  const totals = { targetsExamined: 0, targetsStale: 0, targetsPublished: 0, targetsAlreadyCurrent: 0, targetsDeferred: 0, targetsFailed: 0, targetsUnitsEmpty: 0 };
  let anyControlUnresolved = false;
  const runOneRoute = async (id) => {
    const { cliRoute } = byId.get(id);
    const runtime = cliRoute.build(Object.freeze({
      bucket, epoch: asOf, directory, orgFp: ORG, connectionId: "primary", primaryConnection: PRIMARY_CONN, connections: [PRIMARY_CONN],
      sb: REL.readOnlySupabase(w.sbNamespace()), pgReadOnly: w.pgQuery, selectors: SEL, computeHash: paramsHashFor, liveContracts: LIVE, reportDerivations: REPORT_DERIVATIONS,
      marketplaceToday, normalizeMarketplace, now: w.now, strict: true, log: () => {},
      env, // the child's process.env (the runtime reads its attestation from it)
      ...(id === "returns-v3" ? { gatherEvidence: w.returnsGather } : {}),
      ...(FIXTURE_CLI[id] ? { world: w } : {}),
    }));
    const release = REL.buildRoutePublicationRelease({
      route: cliRoute, runtime,
      deps: {
        openCycle: w.openCycle, getCycleByBucketDate: w.getCycleByBucketDate, claimCycle: w.claimCycle, readCycle: w.readCycle,
        upsertReportJob: w.upsertReportJob, claimLease: w.claimDeriveLease,
        saveShadow: (a, o) => w.saveShadow(a, o, io, info), reconcileSuccess: w.reconcileSuccess, finalizeCycle: (a, o) => w.finalizeCycle(a, o, io, info),
        readLatestJob: w.readLatestJob, readSnapshot: w.readSnapshot, loadStoragePayload: w.loadStoragePayload,
        publisherFor, verifyLease, readbackLive, liveContracts: LIVE, reportDerivations: REPORT_DERIVATIONS, computeHash: paramsHashFor,
        evidenceContext: { directory, organizationFingerprint: ORG, connectionId: "primary" },
        publishSnapshotUpdate: async () => { w.n.snapshotUpdate += 1; },
        pruneShadows: async () => ({ deleted: 0 }), prune: A.pruneShadows === true,
        now: w.now, log: () => {},
      },
    });
    const adapter = REL.buildRouteReconcileAdapter({ route: cliRoute, runtime, bucket, directory, liveContracts: LIVE, readLatestJob: (rk, a) => w.readLatestJob(rk, a), verifyExact: A.verifyExact });
    let scope = typeof runtime.scopeTargets === "function" ? await runtime.scopeTargets({ directory, bucket, epoch: asOf }) : REL.regionAccountIds(directory, bucket, accountInScope);
    scope = [...new Set((Array.isArray(scope) ? scope : []).map(S).filter(Boolean))].sort();
    if (A.targets && A.targets.some((t) => !scope.includes(t))) { io.err(`STOP ROUTE_TARGET_OUT_OF_SCOPE: route '${id}' -- fail closed.`); throw Object.assign(new Error("out-of-scope"), { stopCode: 2 }); }
    const reconciler = SDR.buildSavedDataReconciler({
      resolveOrg: async () => ({ organizationFingerprint: ORG, connectionId: "primary" }),
      bucketAccounts: async () => scope.map((accountId) => ({ accountId })),
      adapter,
      readLatestReportJob: ({ reportKey, accountId }) => w.readLatestJob(reportKey, accountId),
      readShadowSnapshot: (a) => w.readSnapshot(a), readLiveSnapshot: (a) => w.readSnapshot(a), loadStoragePayload: (p) => w.loadStoragePayload(p),
      verifyLiveReadback: readbackLive, liveContracts: LIVE, computeHash: paramsHashFor, reportDerivations: REPORT_DERIVATIONS,
      runPrepareForUnit: (a) => release.prepareForUnit(a), runPublishForUnit: (a) => release.publishForUnit(a),
      openControls: dryRun ? (async () => ({ ok: true })) : openControls,
      closeControls: dryRun ? (async () => ({ ok: true })) : controls.closeControls,
      outOfTime, deadlineRace: (p) => p, makeAbortController: () => new AbortController(),
      reportKeys: [cliRoute.publisherKey], withTimeout: (p) => p, log: () => {}, family: id, clock: () => new Date(w.now()),
      interWindowPauseMs: dryRun ? 0 : REL.ROUTE_CLI_INTER_WINDOW_PAUSE_MS, sleep: w.sleep,
    });
    const o = await reconciler.run({ bucket, requestedAsOf: asOf, accountIds: A.targets, mode: A.mode, dryRun });
    const unitsEmpty = (o.perAccount || []).filter((r) => r && r.unitsReason === TGT.TARGETS_UNITS_EMPTY).length;
    const outcome = o.outcome === "complete" && unitsEmpty > 0 ? "partial" : o.outcome;
    if (o.controlCleanupUnresolved === true) anyControlUnresolved = true;
    const counts = { ...(o.counts || {}), targetsUnitsEmpty: unitsEmpty };
    for (const k of Object.keys(totals)) totals[k] += Number(counts[k] || 0);
    routeResults.push({ id, ok: o.ok === true, outcome, code: o.code || "OK", counts });
    if (A.emitTargets) io.out(TGT.formatTargetsLine({ v: 2, route: id, summary: { ...o, bucket, requestedAsOf: asOf, dryRun } }));
    return o;
  };
  let seq;
  try { seq = await REL.runRouteCliSequence({ order, runRoute: runOneRoute }); }
  catch (e) { if (e && e.stopCode) return e.stopCode; throw e; }
  for (const run of seq.runs.filter((r) => r.skipped)) {
    routeResults.push(REL.routeCliSkippedRoute(run.id));
    if (A.emitTargets) io.out(TGT.formatTargetsLine({ v: 2, route: run.id, summary: REL.routeCliSkippedTargetsSummary({ bucket, asOf, dryRun }) }));
  }
  if (seq.stoppedBy) anyControlUnresolved = true;
  const verdict = REL.routeCliOutcome({ routeResults, zeroExportViolation: guard.blocked > 0, anyControlUnresolved });
  io.out("RESULT " + J({ ok: verdict.ok, outcome: verdict.outcome, code: verdict.code, routes: routeResults, bucket, epoch: asOf, mode: A.mode, dryRun, verifyExact: A.verifyExact, ...(seq.stoppedBy ? { stoppedBy: seq.stoppedBy } : {}), dataDoeCreates: 0, dataDoeTokens: 0, zeroExport: { blocked: guard.blocked }, counts: totals }));
  finalZero();
  return verdict.exitCode;
}

// The four LEGACY reconciler CLIs (pre-existing, unchanged by this project): a TARGETS v1 fixture. Tokens = the REAL
// legacy compose over the SAME fake SQL; current = the live row carries this family's token; a live pass writes through
// the FENCED CAS under the control lease (or, with w.legacyUnfencedWriter, through the unfenced legacy upsert -- the
// in-flight old writer of P1).
async function legacyCliMain(w, family, argv, env, io) {
  const a = { bucket: null, asOf: null, mode: "periodic", accounts: null, runToken: null, live: false, cleanup: false, emit: false };
  for (const s of argv) {
    const eq = s.indexOf("=");
    const k = eq < 0 ? s.slice(2) : s.slice(2, eq); const v = eq < 0 ? null : s.slice(eq + 1);
    if (k === "bucket") a.bucket = v; else if (k === "as-of") a.asOf = v; else if (k === "mode") a.mode = v; else if (k === "accounts") a.accounts = v.split(",");
    else if (k === "run-token") a.runToken = v; else if (k === "deadline-seconds") a.deadline = Number(v); else if (k === "emit-targets") a.emit = true;
    else if (k === "live") a.live = true; else if (k === "cleanup") a.cleanup = true; else { io.err("STOP LEGACY_ARG: unknown " + k); return 2; }
  }
  const guard = { blocked: 0, allowedAccountsGets: 0 };
  const finalZero = () => io.err(RUN.ZERO_EXPORT_LINE_PREFIX + J({ blocked: guard.blocked, allowedAccountsGets: guard.allowedAccountsGets, final: true }));
  const info = { cli: "legacy", family, route: family, live: a.live, cleanup: a.cleanup, runToken: a.runToken };
  w.cliRuns.push(info);
  const owner = "legacy-" + family + ":" + a.bucket + ":" + (a.runToken || a.asOf);
  if (a.cleanup) { if (w.lease.owner === owner) w.lease = { ...w.lease, owner: "", op: "", exp: 0 }; io.out("RESULT " + J({ mode: "cleanup", cleaned: true, dataDoeCreates: 0, dataDoeTokens: 0 })); finalZero(); return 0; }
  if (typeof w.zeroExportTrap === "function" && w.zeroExportTrap(info)) guardBlock(guard, io, "POST", "/api/v1/exports");
  const route = ROUTES.routeById(family);
  const directory = (await import("../lib/server/recovery/store-pg.js")).buildWorkerDirectory(w.directoryRows).directory;
  const ctx = ROUTES.buildEvidenceContext({ epoch: a.asOf, now: w.now(), directory, region: a.bucket, organizationFingerprint: ORG });
  const tokens = await ROUTES.evaluateRouteEvidence(route, w.pgQuery, ctx);
  const scope = a.accounts || ctx.accountIds;
  const perAccount = [];
  for (const acct of scope) {
    const e = tokens.get(acct);
    const rec = { accountId: acct, eligible: !!(e && e.token), revisionId: e && e.token ? "rev-" + sha12(e.token) : null, status: e && e.token ? "available" : "missing", reports: {} };
    const fault = w.legacyFaults.get(family + "|" + acct);
    for (const rk of route.publisherKeys) {
      if (!e || !e.token) rec.reports[rk] = { state: "DEFERRED_PROVENANCE", reason: family + "-evidence-missing" };
      else if (fault) rec.reports[rk] = { state: "DEFERRED_PROVENANCE", reason: fault };
      else { const live = w.row(rk, acct, legacyIdentity(rk, a.asOf).hash); rec.reports[rk] = live && live.payload && live.payload.tokens && live.payload.tokens[family] === e.token ? { state: "PUBLICATION_NOT_REQUIRED", reason: null } : { state: "STALE", reason: "source-revision-changed" }; }
    }
    perAccount.push(rec);
  }
  if (a.live && guard.blocked > 0) {
    // the guard refused the DataDoe call: the op fails closed BEFORE any write (never a publish after a blocked request)
    for (const rec of perAccount) for (const rk of Object.keys(rec.reports)) if (rec.reports[rk].state === "STALE") rec.reports[rk] = { state: "FAILED_DERIVE", reason: "zero-export-blocked" };
  } else if (a.live) {
    const stale = perAccount.filter((r) => Object.values(r.reports).some((x) => x.state === "STALE"));
    if (stale.length) {
      const acq = w.acquireLease(owner, "legacy/" + family + "/" + a.bucket, 900);
      if (acq.disposition !== "acquired") {
        for (const rec of stale) for (const rk of Object.keys(rec.reports)) if (rec.reports[rk].state === "STALE") rec.reports[rk] = { state: "DEFERRED_DEPENDENCY", reason: "controls-not-opened:CONTROL_LEASE_HELD" };
      } else {
        for (const rec of stale) for (const rk of route.publisherKeys) {
          if (rec.reports[rk].state !== "STALE") continue;
          const id = legacyIdentity(rk, a.asOf);
          const prev = w.row(rk, rec.accountId, id.hash);
          const tokensMap = { ...(prev && prev.payload && prev.payload.tokens ? prev.payload.tokens : {}), [family]: tokens.get(rec.accountId).token };
          const args = { reportKey: rk, accountId: rec.accountId, paramsHash: id.hash, params: id.params, payload: legacyPayload(rk, rec.accountId, a.asOf, tokensMap), sourceRefreshedAt: new Date(w.tick(1000)).toISOString() };
          try {
            const r = w.legacyUnfencedWriter ? w.legacyUpsert(args) : await w.liveCasFenced({ ...args, ownerToken: owner, generation: acq.generation }, io, info);
            rec.reports[rk] = r.outcome === "inserted" || r.outcome === "replaced" || r.outcome === "already-current" ? { state: "READBACK_VERIFIED", reason: null } : { state: "DEFERRED_DEPENDENCY", reason: "publish-" + r.outcome };
          } catch (e) {
            const c = FENCE.classifyReportWriterError(e);
            if (c.fenced) { io.err(FENCE.REPORT_WRITER_FENCED_PREFIX + rk + " writer-fenced (LKG preserved)"); rec.reports[rk] = { state: "FAILED_PUBLISH", reason: FENCE.REPORT_WRITER_FENCED_PREFIX + rk }; }
            else rec.reports[rk] = { state: "FAILED_PUBLISH", reason: "publish-threw" };
          }
        }
        w.releaseLease(owner, acq.generation);
      }
    }
  }
  const states = perAccount.flatMap((r) => Object.values(r.reports).map((x) => x.state));
  const failed = states.some((s) => s.startsWith("FAILED_")) || guard.blocked > 0;
  const partial = states.some((s) => s === "STALE" || s.startsWith("DEFERRED_"));
  const outcome = failed ? "failed" : partial ? "partial" : "complete";
  const code = guard.blocked > 0 ? "ZERO_EXPORT_VIOLATION" : failed ? "HARD_FAILURES" : "OK";
  if (a.emit) io.out(TGT.formatTargetsLine({ family, summary: { bucket: a.bucket, requestedAsOf: a.asOf, dryRun: !a.live, outcome, code, dataDoeCreates: 0, dataDoeTokens: 0, controlCleanupUnresolved: false, perAccount } }));
  io.out("RESULT " + J({ ok: !failed, outcome, code, family, bucket: a.bucket, requestedAsOf: a.asOf, dataDoeCreates: 0, dataDoeTokens: 0 }));
  finalZero();
  return failed ? 1 : 0;
}

// ---- the FAKE child process + the worker's `run` (the REAL runner.runRoute with an injected spawnImpl) --------------
function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.pid = 424242; child.killed = false;
  let closed = false;
  const finish = (code, signal) => {
    if (closed) return; closed = true;
    let pending = 2;
    const done = () => { pending -= 1; if (pending === 0) child.emit("close", code, signal); };
    child.stdout.once("end", done); child.stderr.once("end", done);
    child.stdout.end(); child.stderr.end();
  };
  child.kill = (sig = "SIGTERM") => { child.killed = true; finish(null, sig); return true; };
  child.io = {
    out: (line) => { if (!closed) { child.stdout.write(line + "\n"); if (child.onLine) child.onLine("stdout", line); } },
    err: (line) => { if (!closed) { child.stderr.write(line + "\n"); if (child.onLine) child.onLine("stderr", line); } },
    raw: (stream, s) => { if (!closed) child[stream].write(s); },
    exit: (code, signal = null) => finish(code, signal),
    get closed() { return closed; },
  };
  return child;
}
function installChildRunner(w) {
  w.spawnImpl = (execPath, args, opts = {}) => {
    const child = makeFakeChild();
    const rec = { spec: w.pendingSpec, execPath, args: [...args], env: { ...(opts.env || {}) }, cwd: opts.cwd, stdout: [], stderr: [] };
    w.spawns.push(rec);
    child.onLine = (stream, line) => rec[stream].push(line);
    Promise.resolve().then(async () => {
      if (typeof w.hooks.beforeChild === "function") await w.hooks.beforeChild(rec);
      let code;
      try {
        const script = args[0];
        if (script === RC.ROUTE_CLI_SCRIPT) code = await routeCliMain(w, args.slice(1), rec.env, child.io);
        else if (LEGACY_FAMILY_BY_SCRIPT[script]) code = await legacyCliMain(w, LEGACY_FAMILY_BY_SCRIPT[script], args.slice(1), rec.env, child.io);
        else { child.io.err("STOP UNKNOWN_SCRIPT"); code = 2; }
      } catch (e) { child.io.err("FATAL " + S(e && e.message).replace(/[^\x20-\x7e]/g, "").slice(0, 180)); code = 1; }
      child.io.exit(code, null);
    });
    return child;
  };
  w.runChild = (a) => {
    const spec = { route: a.route, region: a.region, asOf: a.asOf, targets: a.targets ? [...a.targets].sort() : null, kind: a.kind, runToken: a.runToken || null, at: w.now() };
    w.pendingSpec = spec;
    // A 'hang' fault arms the REAL runner's hard-timeout path: its timer (the route's hardTimeoutSeconds) is shortened to
    // 1 ms for THIS spawn only (restored immediately after the synchronous runRoute call) -- no real sleep, same code path.
    const saved = globalThis.setTimeout;
    // (The runner unref()s its timer; the shortened one stays ref'd so the loop lives until it fires.)
    if (w.armedHang(a.kind)) globalThis.setTimeout = (fn, ms, ...rest) => { if (!(Number(ms) >= 60000)) return saved(fn, ms, ...rest); const t = saved(fn, 1, ...rest); t.unref = () => t; return t; };
    let p;
    try { p = RUN.runRoute({ appRoot: ROOT, route: a.route, region: a.region, asOf: a.asOf, targets: a.targets, kind: a.kind, runToken: a.runToken, env: { ...CHILD_ENV }, childMaxOldSpaceMb: 448, spawnImpl: w.spawnImpl, killGraceMs: 5, onChild: a.onChild, now: a.now }); }
    finally { globalThis.setTimeout = saved; w.pendingSpec = null; }
    return p.then((res) => { w.runs.push({ ...spec, res }); return res; });
  };
  // A direct route-CLI invocation outside the worker (the scheduler's WP13 job, an operator cleanup).
  w.execCli = async (argv, env = CHILD_ENV) => {
    const res = { stdout: [], stderr: [], code: null };
    let done; const exited = new Promise((r) => { done = r; });
    const io = { out: (l) => res.stdout.push(l), err: (l) => res.stderr.push(l), raw: () => {}, exit: (c) => { if (res.code == null) { res.code = c; done(); } }, closed: false };
    routeCliMain(w, argv, { ...env }, io).then((c) => io.exit(c), (e) => { io.err("FATAL " + S(e && e.message)); io.exit(1); });
    await exited;
    const rl = res.stdout.filter((l) => l.startsWith("RESULT ")).pop();
    res.result = rl ? JSON.parse(rl.slice(7)) : null;
    res.targets = res.stdout.filter((l) => l.startsWith("TARGETS ")).map((l) => TGT.parseTargetsLine(l));
    return res;
  };
  return w;
}

// ---- the store (memory-store.js, its reads wired like store-pg.js over the world) + the rig -------------------------
function makeStore(w) {
  const st = MS.createMemoryStore({ clock: w.now });
  st.env.directoryAccounts = w.directoryRows;
  const origLive = st.readLiveRowWritesSince.bind(st);
  const origGate = st.readSchedulerGate.bind(st);
  // store-pg readRouteEvidence: the REAL evaluateRouteEvidence over the read-only query (fixture composes: validated
  // through the SAME validateComposeResult the real path applies).
  st.readRouteEvidence = async (route, ctx) => {
    st.calls.evidence += 1;
    const fx = FIXTURE_COMPOSE[route.id];
    if (fx) return RC.validateComposeResult(fx(w, ctx), { ctx, grain: route.grain, routeId: route.id });
    return ROUTES.evaluateRouteEvidence(route, w.pgQuery, ctx);
  };
  st.readLiveRowWritesSince = async (scopes) => { st.env.liveRows = w.liveRowMeta(); return origLive(scopes); };
  st.readSchedulerGate = async (opts) => { st.env.cycles = w.gateCycles(); return origGate(opts); };
  st.readControlLease = async () => ({ held: !!w.lease.owner && w.lease.exp > w.now(), operationKey: w.lease.op, expiresAt: w.lease.exp || null });
  st.readFence = async () => FENCE.readReportWriterFence(w.fenceQuery);
  return st;
}
const CFG_ENV_BASE = Object.freeze({ POSTGRES_URL: "postgres://fixture@localhost/none", SUPABASE_URL: "http://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "fixture-key", DATADOE_API_KEY: "fixture-key", PRW_REGIONS: "india", SKU_MOVEMENT_SERVE_TOKEN_ATTESTED: "true", FBA_PLAN_ROUTE_FENCE_ATTESTED: "true", LHV3_SERVE_GATE_ATTESTED: "true" });
function makeRig(w, { liveRoutes = ROUTES.ROUTE_IDS, workerId = "w1", store = null, env = {} } = {}) {
  if (!w.spawnImpl) installChildRunner(w);
  const cfg = CFG.loadRecoveryConfig({ ...CFG_ENV_BASE, PRW_WORKER_ID: workerId, PRW_LIVE_ROUTES: [...liveRoutes].join(","), ...env });
  if (!cfg.ok) throw new Error("config: " + cfg.errors.join("; "));
  const st = store || makeStore(w);
  const tag = String(workerId.replace(/\D/g, "") || "1").padStart(4, "0");
  let n = 0;
  const logs = [];
  const worker = WK.createRecoveryWorker({ store: st, run: w.runChild, config: cfg.config, clock: w.now, sleep: w.sleep, randomUUID: () => `00000000-0000-4000-8000-${tag}${String(++n).padStart(8, "0")}`, version: "e2e", pid: 4242, organizationFingerprint: ORG, log: (m) => logs.push(m) });
  return { w, store: st, worker, config: cfg.config, logs };
}
const jobsOf = (st, route) => st.jobs.filter((j) => !route || j.route_id === route);
const stateOf = (st, route, tk, epoch = EPOCH) => st.state.get(`${route}|${REGION}|${tk}|${epoch}`) || null;
const targetsFor = (id) => (ROUTES.routeById(id).grain === "region" ? ["region:" + REGION] : [...ACCTS]);
const preKind = (id) => (ROUTES.routeById(id).kind === "route-cli" ? "verify" : "dry-run");
const runsOf = (w, id, from = 0) => w.runs.slice(from).filter((r) => r.route === id);
const lastRun = (w, id, kind) => [...w.runs].reverse().find((r) => r.route === id && r.kind === kind) || null;
const targetOf = (run, tk) => { const n = run && run.res && run.res.targets ? TGT.normalizeTargets(run.res.targets) : null; return n ? n.targets.find((t) => t.id === tk) || null : null; };
async function drain(rig, { horizonMs = 3600 * 1000, maxBatches = 120 } = {}) {
  const start = rig.w.clock; let batches = 0;
  while (batches < maxBatches) {
    if (await rig.worker.processOneBatch()) { batches += 1; continue; }
    const open = rig.store.jobs.filter((j) => j.status === "pending" || j.status === "deferred" || j.status === "claimed");
    if (!open.length) break;
    const next = Math.min(...open.map((j) => (j.status === "claimed" ? Number(j.lease_expires_at) : Number(j.next_attempt_at))));
    if (!Number.isFinite(next) || next > start + horizonMs) break;
    rig.w.clock = Math.max(rig.w.clock, next) + 1;
  }
  return batches;
}
// Every recorded spawn argv of a route is EXACTLY the runner's buildRouteArgs of its spec, preloads the guard, runs the
// node binary in the app root, and (route CLI) parses under the REAL parseRouteCliArgs.
function argvIsReal(w, id) {
  const spawns = w.spawns.filter((s) => s.spec && s.spec.route === id);
  return spawns.length > 0 && spawns.every((s) => J(s.args) === J(RUN.buildRouteArgs({ route: id, region: s.spec.region, asOf: s.spec.asOf, targets: s.spec.targets, kind: s.spec.kind, runToken: s.spec.runToken, now: s.spec.at }))
    && s.execPath === process.execPath && s.cwd === ROOT && /^--max-old-space-size=\d+ --import=file:\/\/\S+zero-export-guard\.mjs$/.test(S(s.env.NODE_OPTIONS))
    && (s.args[0] !== RC.ROUTE_CLI_SCRIPT || REL.parseRouteCliArgs(s.args.slice(1)).ok === true));
}
// Seeds: pre-existing (LKG) rows a route reads from OTHER reports.
function seedRow(w, rk, acct, hash, params, payload, stamp) { const t = stamp || w.iso(w.tick(1000)); return w.put({ id: "seed-" + rk + "-" + acct + "-" + (++w.seq), report_key: rk, account_id: acct, params_hash: hash, params, payload, payload_storage_path: null, source_refreshed_at: t, updated_at: w.iso(w.tick(1000)) }); }
const seedBrandsRow = (w, acct, brands = BRANDS) => seedRow(w, "brand-view-brands", acct, SKU_W.brandViewBrandsLiveHash(acct), { reportVersion: "brand-view-brands-v1", accountId: acct }, { accountId: acct, brands: [...brands], sources: [], message: null });
const seedLegacyRow = (w, rk, acct, tokens = {}) => { const id = legacyIdentity(rk, EPOCH); return seedRow(w, rk, acct, id.hash, id.params, legacyPayload(rk, acct, EPOCH, tokens)); };
const seedFbaPlanRow = (w, acct) => seedRow(w, "fba-plan", acct, paramsHashFor("fba-plan-shared-v1", { to: EPOCH }), { reportVersion: "fba-plan-shared-v1", to: EPOCH }, fbaPlanPayload({ accountId: acct, salesAsOf: EPOCH, inventoryAsOf: EPOCH, fbaSha: "paid", country: "IN" }), "2026-09-24T01:30:00.000Z");
function seedFor(id, w) {
  if (id === "brand-view-brands") for (const a of ACCTS) { seedLegacyRow(w, "brand-sales", a); seedFbaPlanRow(w, a); }
  if (id === "sku-movement" || id === "brand-view" || id === "brand-view-portfolio") for (const a of ACCTS) seedBrandsRow(w, a);
}
const handoffRows = async (st) => WK.buildHandoffMatrix({ stateRows: (await st.status()).state, directory: await st.readDirectory(), regions: [REGION] });

// =====================================================================================================================
// S1. NORMAL SAVE for EACH of the 10 routes: watermark -> pre-check STALE -> live -> verify -> verified (token echo),
//     hand-off 'repaired'; a second tick is already-current (hand-off 'already-current' ONLY with served proof).
// =====================================================================================================================
for (const id of ROUTE_ORDER) {
  const w = makeWorld(); seedFor(id, w);
  const rig = makeRig(w, { liveRoutes: [id] });
  const route = ROUTES.routeById(id);
  const targets = targetsFor(id);
  const pre = preKind(id);
  const n0 = await rig.worker.watermarkPass();
  const jobs0 = jobsOf(rig.store, id);
  ok(`S1a ${id}: the watermark enqueues every target (origin watermark, route priority ${route.priority}) with the token of the REAL ${FIXTURE_COMPOSE[id] ? "fixture" : "route"} compose over the saved evidence`,
    n0 === targets.length && jobs0.length === targets.length && jobs0.every((j) => j.origin === "watermark" && j.priority === route.priority && typeof j.evidence_token === "string" && j.evidence_token.length > 8) && J(jobs0.map((j) => j.target_key).sort()) === J(targets));
  await drain(rig);
  const runs = runsOf(w, id);
  const liveRun = runs.find((r) => r.kind === "live");
  dbg("S1 " + id + " runs", runs.map((r) => ({ kind: r.kind, targets: r.targets, exit: r.res.exitCode, timedOut: r.res.timedOut, result: r.res.result, targets2: r.res.targets && TGT.normalizeTargets(r.res.targets) && TGT.normalizeTargets(r.res.targets).targets.map((t) => ({ id: t.id, tok: S(t.tok).slice(0, 12), units: t.units.map((u) => u.u + ":" + u.s + ":" + u.r) })), stderr: r.res.stderrTail })));
  dbg("S1 " + id + " jobs", jobsOf(rig.store, id).map((j) => ({ t: j.target_key, s: j.status, c: j.last_class, r: j.last_reason, a: j.last_alert })));
  ok(`S1b ${id}: ONE claimed batch: pre-check (${pre}) STALE -> live (unique run token, explicit targets) -> ${pre}; every child argv is EXACTLY runner.buildRouteArgs and preloads the zero-export guard (no process spawned)`,
    J(runs.map((r) => r.kind)) === J([pre, "live", pre]) && liveRun && new RegExp("^prw-w1-" + id + "-india-").test(S(liveRun.runToken)) && J(liveRun.targets) === J(targets) && argvIsReal(w, id)
    && TGT.normalizeTargets(runs[0].res.targets).targets.every((t) => t.units.some((u) => u.s === "STALE")));
  const jobs1 = jobsOf(rig.store, id);
  const states = targets.map((t) => stateOf(rig.store, id, t));
  const verRun = lastRun(w, id, pre);
  const tokEcho = route.kind !== "route-cli" || targets.every((t) => { const x = targetOf(verRun, t); const j = jobs1.find((y) => y.target_key === t); return x && x.tok === j.evidence_token; });
  ok(`S1c ${id}: every job VERIFIED + published; state.verified_token == the claimed token${route.kind === "route-cli" ? " (the verify child's TARGETS v2 tok ECHOES it)" : " (v1: the worker re-read its own token)"}`,
    jobs1.length === targets.length && jobs1.every((j) => j.status === "verified" && j.published === true && j.last_reason === "verified-live-readback") && states.every((s, i) => s && s.verified_token === jobs1.find((j) => j.target_key === targets[i]).evidence_token) && tokEcho);
  if (route.kind === "route-cli") {
    const liveKey = route.liveReportKeys[0];
    const unitsOk = targets.every((t) => { const x = targetOf(verRun, t); return x && x.units.length > 0 && x.units.every((u) => u.s === "PUBLICATION_NOT_REQUIRED" && u.served && u.served.h === u.h && u.served.sra === u.sra && w.liveRows(liveKey).some((r) => r.params_hash === u.h && r.source_refreshed_at === u.sra && S(r.params.evidenceToken) === x.tok)); });
    ok(`S1d ${id}: EXACT live read-back -- every unit's live row (report ${liveKey}) carries the route's evidence token, its served row IS that row (h + sra), and the state hand-off is 'repaired' with served_confirmed`,
      unitsOk && states.every((s) => s.handoff === "repaired" && s.served_confirmed === true && s.verified_rows.length > 0));
  } else {
    const liveOk = targets.every((t) => route.publisherKeys.every((rk) => { const r = w.row(rk, t, legacyIdentity(rk, EPOCH).hash); return r && r.payload.tokens[id] === jobs1.find((j) => j.target_key === t).evidence_token; }));
    const deferredFirst = states.every((s) => s.handoff === "deferred" && s.served_confirmed == null);
    await rig.worker.tier1Scan();
    const s2 = targets.map((t) => stateOf(rig.store, id, t));
    ok(`S1d ${id}: the legacy live rows carry the family token; the hand-off is 'deferred' (no served proof yet) until the tier-1 served-row check confirms it -> 'repaired'`,
      liveOk && deferredFirst && s2.every((s) => s.served_confirmed === true && WK.handoffFor(CLS.CLASSES.CURRENT, { published: true, servedConfirmed: s.served_confirmed }) === "repaired"));
  }
  // second tick
  w.tick(700 * 1000);
  const writes0 = w.writes(); const runs0 = w.runs.length;
  const n1 = await rig.worker.watermarkPass();
  for (const t of targets) await rig.store.enqueue({ route: id, region: REGION, targetKey: t, owners: route.grain === "region" ? [...ACCTS] : [t], asOf: EPOCH, token: stateOf(rig.store, id, t).verified_token, origin: "manual", priority: route.priority });
  await drain(rig);
  const manual = jobsOf(rig.store, id).filter((j) => j.origin === "manual");
  const s3 = targets.map((t) => stateOf(rig.store, id, t));
  let handoffOk;
  if (route.kind === "route-cli") handoffOk = s3.every((s) => s.handoff === "already-current" && s.served_confirmed === true);
  else {
    const before = s3.every((s) => s.handoff === "deferred");
    w.tick(601 * 1000); await rig.worker.tier1Scan();
    handoffOk = before && targets.every((t) => { const s = stateOf(rig.store, id, t); return s.served_confirmed === true && WK.handoffFor(CLS.CLASSES.CURRENT, { published: s.handoff === "repaired" || s.last_reason === "verified-live-readback", servedConfirmed: true }) === "already-current"; });
  }
  ok(`S1e ${id}: a second tick is ALREADY-CURRENT -- the watermark re-enqueues nothing; a re-check job runs ONLY the pre-check and verifies (published:false, 'already-current') with ZERO writes; the hand-off is 'already-current' only with the served proof`,
    n1 === 0 && J(runsOf(w, id, runs0).map((r) => r.kind)) === J([pre]) && manual.length === targets.length && manual.every((j) => j.status === "verified" && j.published === false && j.last_reason === "already-current") && w.writes() === writes0 && handoffOk);
}
ok("S1f the fixture boundary: returns-v3, sku-movement and brand-view-brands ran their REAL CLI runtimes; every other route CLI module is validated by the REAL route contract + pair checks against the REAL worker declaration", REAL_RUNTIME_ROUTES.every((id) => CLI_MODULES[id].default && typeof CLI_MODULES[id].default.build === "function") && Object.keys(FIXTURE_CLI).every((id) => RC.validateRoutePair(ROUTES.routeById(id), RC.validateRouteModule(FIXTURE_CLI[id], { side: "cli", liveContracts: LIVE, reportDerivations: REPORT_DERIVATIONS }), { liveContracts: LIVE })));

// =====================================================================================================================
// S2. MISSED GITHUB RUN: all 10 routes converge from scratch; then saved evidence lands while the scheduler never runs --
//     tier-1 alone (no watermark) enqueues the advanced tokens and the worker publishes; an IN-midnight identity rollover
//     republishes Brand View at the new as-of.
// =====================================================================================================================
{
  const w = makeWorld();
  const rig = makeRig(w);
  await rig.worker.watermarkPass();
  await drain(rig, { horizonMs: 8 * 3600 * 1000, maxBatches: 300 });
  const allJobs = jobsOf(rig.store);
  const verifiedTargets = ROUTE_ORDER.every((id) => targetsFor(id).every((t) => { const s = stateOf(rig.store, id, t); return s && s.verified_token != null; }));
  ok("S2a from an empty dashboard, the worker ALONE publishes all 10 routes (dependency cascade included); no job dead-lettered, every route target has a verification", verifiedTargets && !allJobs.some((j) => j.status === "dead") && !allJobs.some((j) => j.status === "pending" || j.status === "claimed"));
  ok("S2a zero DataDoe / network across the whole convergence; no natural scheduler cycle exists (the gate stayed open)", net.calls.length === 0 && w.naturalCycles.length === 0);
  // the missed run: saved evidence advances; NO watermark pass runs (the scheduler's materialize job never ran).
  const jobCount = allJobs.length;
  w.tick(15 * 60 * 1000);
  w.bumpCoverage("IN1", w.iso(w.now() - 60 * 1000));
  w.addReturn("IN2", EPOCH, w.iso(w.now() - 60 * 1000));
  w.bumpFbaPointer("IN2", 2, w.iso(w.now() - 60 * 1000));
  w.tick(11 * 60 * 1000);
  await rig.worker.tier1Scan();
  const fresh = jobsOf(rig.store).slice(jobCount);
  const has = (r, t) => fresh.some((j) => j.route_id === r && j.target_key === t && j.origin === "scan");
  ok("S2b tier-1 (no watermark, no scheduler) enqueues EVERY advanced token with origin 'scan': OLI coverage (oli, fba-plan, returns-v3, sku-movement for IN1), a new Returns row (returns-v3 IN2), a re-persisted FBA pointer (fba-plan + fba IN2)",
    fresh.length > 0 && fresh.every((j) => j.origin === "scan") && has("oli", "IN1") && has("fba-plan", "IN1") && has("returns-v3", "IN1") && has("sku-movement", "IN1") && has("returns-v3", "IN2") && has("fba-plan", "IN2") && has("fba", "IN2"));
  const drainStart = w.clock;
  await drain(rig, { horizonMs: 3 * 3600 * 1000, maxBatches: 400 });
  const fp2 = stateOf(rig.store, "fba-plan", "IN2");
  const fpLive = w.row("fba-plan", "IN2", paramsHashFor("fba-plan-shared-v1", { to: EPOCH }));
  dbg("S2c scan jobs", fresh.map((j) => { const x = rig.store.jobs.find((y) => y.id === j.id); return [x.route_id, x.target_key, x.status, x.last_class, x.last_reason, x.last_alert]; }));
  dbg("S2c fba-plan IN2", { state: fp2 && fp2.verified_token, live: fpLive && fpLive.params, fbaSha: fpLive && fpLive.payload.fbaSha });
  const cur = (r, t) => rig.store.jobs.find((x) => fresh.some((f) => f.id === x.id) && x.route_id === r && x.target_key === t);
  const fp1 = cur("fba-plan", "IN1");
  ok("S2c ... and the worker republishes them: every scan job is verified (fba-plan IN2's live row carries the NEW evidence token + the re-persisted FBA content) -- EXCEPT fba-plan IN1, whose OLI-only change under an unchanged FBA evidence instant is the typed, accepted fill-only deferral 'evidence-instant-not-advanced' (dependency, NO alert; plan-addendum recordedDeviations WP11), never published",
    fresh.filter((j) => !(j.route_id === "fba-plan" && j.target_key === "IN1")).every((j) => rig.store.jobs.find((x) => x.id === j.id).status === "verified")
    && fpLive && S(fpLive.params.evidenceToken) === fp2.verified_token && fpLive.payload.fbaSha === "fsha-IN2-2"
    && fp1.status === "deferred" && fp1.last_class === CLS.CLASSES.DEPENDENCY && fp1.last_reason === "evidence-instant-not-advanced" && fp1.last_alert == null);
  // That fba-plan deferral is an ACCEPTED STEADY STATE (store-pg.js NON_BLOCKING_UPSTREAM_REASONS; formerly the e2e
  // FINDING S2c'): it no longer blocks its dependents, which read the paid-authoritative live fba-plan row at once --
  // no PRW_AWAIT_MAX_MINUTES wait and no 'await-timeout' alert noise on an expected state.
  const bvbIn1 = jobsOf(rig.store, "brand-view-brands").filter((j) => j.target_key === "IN1" && j.created_ms >= drainStart - 30 * 60 * 1000);
  ok("S2c' the accepted fba-plan fill-only deferral does NOT block its dependents: the IN1 dependents (brand-view-brands -> sku-movement) verify WITHOUT an 'await-timeout' alert",
    !bvbIn1.some((j) => /await-timeout/.test(S(j.last_alert))) && jobsOf(rig.store, "sku-movement").some((j) => j.target_key === "IN1" && j.origin === "scan" && j.status === "verified"));
  // the next paid FBA fetch for IN1 lands (the fill-only deferral's documented way out) -> fba-plan IN1 converges.
  w.tick(5 * 60 * 1000); w.bumpFbaPointer("IN1", 5, w.iso(w.now() - 60 * 1000)); w.tick(11 * 60 * 1000);
  await rig.worker.tier1Scan();
  await drain(rig, { horizonMs: 2 * 3600 * 1000, maxBatches: 300 });
  const fpLive1 = w.row("fba-plan", "IN1", paramsHashFor("fba-plan-shared-v1", { to: EPOCH }));
  ok("S2c'' the next paid FBA fetch (a re-persisted pointer with a newer instant) releases the fill-only deferral: fba-plan IN1 republishes the new content and every open job drains", fpLive1 && fpLive1.payload.fbaSha === "fsha-IN1-5" && !jobsOf(rig.store).some((j) => j.status === "pending" || j.status === "deferred" || j.status === "claimed"));
  // identity rollover at IN midnight (18:30Z); the epoch (UTC D-1) is unchanged.
  const bvBefore =stateOf(rig.store, "brand-view", "IN1").verified_rows.map((v) => v.asOf);
  const clockBeforeRoll = w.clock;
  w.clock = Math.max(w.clock, Date.parse("2026-09-24T19:00:00Z"));
  const utcAtRoll = ROUTES.utcDMinus1(w.now());
  await rig.worker.tier1Scan();
  const roll = jobsOf(rig.store, "brand-view").filter((j) => j.status === "pending" && j.origin === "scan");
  await drain(rig, { horizonMs: 90 * 60 * 1000, maxBatches: 300 });
  const bvAfter = stateOf(rig.store, "brand-view", "IN1").verified_rows.map((v) => v.asOf);
  dbg("S2d-clock", { clockBeforeRoll: new Date(clockBeforeRoll).toISOString(), utcAtRoll, now: new Date(w.now()).toISOString() });
  dbg("S2d", { utc:ROUTES.utcDMinus1(w.now()), roll: roll.map((j) => [j.target_key, j.status, j.origin]), bvBefore, bvAfter, bvJobs: jobsOf(rig.store, "brand-view").map((j) => [j.target_key, j.status, j.origin, j.last_class, j.last_reason]), pf: stateOf(rig.store, "brand-view-portfolio", "region:india").verified_rows.map((v) => v.asOf), t1: rig.store.scanRow.tier1Summary.findings });
  ok("S2d an IN-midnight rollover (epoch unchanged) is caught by tier-1 alone: Brand View + the portfolio re-enqueue (origin scan) and republish at the NEW identity as-of 2026-09-25", clockBeforeRoll < Date.parse("2026-09-24T19:00:00Z") && utcAtRoll === EPOCH && roll.length === ACCTS.length && bvBefore.every((a) => a === IN_TODAY) && bvAfter.length > 0 && bvAfter.every((a) => a === "2026-09-25") && stateOf(rig.store, "brand-view-portfolio", "region:india").verified_rows.every((v) => v.asOf === "2026-09-25") && w.liveRows("brand-view").some((r) => r.params.asOf === "2026-09-25"));
}

// =====================================================================================================================
// S3. DEPENDENCY CHAIN fba-plan -> brand-view-brands -> sku-movement -> brand-view -> brand-view-portfolio: dependents are
//     enqueued ONLY after a verified publish; awaits block on an OPEN upstream only.
// =====================================================================================================================
{
  const CHAIN = ["fba-plan", "brand-view-brands", "sku-movement", "brand-view", "brand-view-portfolio"];
  const w = makeWorld();
  for (const a of ACCTS) seedLegacyRow(w, "brand-sales", a); // the OLI route's brand-sales (not live here)
  const rig = makeRig(w, { liveRoutes: CHAIN });
  await rig.worker.watermarkPass();
  await drain(rig, { horizonMs: 6 * 3600 * 1000, maxBatches: 200 });
  ok("S3a setup: the five chain routes converge from scratch (every target verified)", CHAIN.every((id) => targetsFor(id).every((t) => { const s = stateOf(rig.store, id, t); return s && s.verified_token != null; })));
  const jobs0 = jobsOf(rig.store).length; const runs0 = w.runs.length;
  // a re-persisted FBA pointer for IN1 -> only fba-plan's token moves.
  w.tick(20 * 60 * 1000);
  w.bumpFbaPointer("IN1", 3, w.iso(w.now() - 60 * 1000));
  w.tick(10 * 60 * 1000);
  const enq = await rig.worker.watermarkPass();
  const first = jobsOf(rig.store).slice(jobs0);
  ok("S3b the evidence change enqueues ONLY fba-plan IN1 (every dependent's token is unchanged until fba-plan publishes)", enq === 1 && first.length === 1 && first[0].route_id === "fba-plan" && first[0].target_key === "IN1");
  // the first attempt CRASHES after its prepare -> nothing is published -> NO dependent is enqueued.
  w.faults.push({ point: "prepare:after-finalize", action: "crash", when: (i) => i.live && i.route === "fba-plan" });
  await rig.worker.processOneBatch();
  ok("S3c an fba-plan live child that dies before publishing (exit 1, no RESULT) is retried (transport) and enqueues NO dependent", first[0].status === "pending" && first[0].attempts === 1 && jobsOf(rig.store).length === jobs0 + 1);
  await drain(rig, { horizonMs: 6 * 3600 * 1000, maxBatches: 200 });
  const liveOrder = w.runs.slice(runs0).filter((r) => r.kind === "live" && CHAIN.includes(r.route)).map((r) => r.route);
  const dedup = liveOrder.filter((r, i) => r !== liveOrder[i - 1]);
  const deps = jobsOf(rig.store).slice(jobs0 + 1);
  const fpVerifiedAt = rig.store.jobs.find((j) => j.id === first[0].id).verified_at;
  ok("S3d after the verified fba-plan PUBLISH the chain republishes IN ORDER fba-plan -> brand-view-brands -> sku-movement -> brand-view -> brand-view-portfolio", J(dedup) === J(CHAIN));
  ok("S3e every dependent job has origin 'dependency', was created only AFTER the upstream's verification, and ends verified (portfolio at its REGION target)", deps.length >= 4 && deps.every((j) => j.origin === "dependency" && j.created_ms >= fpVerifiedAt && j.status === "verified") && deps.some((j) => j.route_id === "brand-view-portfolio" && j.target_key === "region:india"));
  // awaits: an OPEN upstream job blocks the owner (no attempt, no child); a DEAD upstream does not.
  const w2 = makeWorld(); for (const a of ACCTS) { seedLegacyRow(w2, "brand-sales", a); seedFbaPlanRow(w2, a); }
  const r2 = makeRig(w2, { liveRoutes: ["fba-plan", "brand-view-brands"] });
  await r2.store.enqueue({ route: "fba-plan", region: REGION, targetKey: "IN1", owners: ["IN1"], asOf: EPOCH, token: "fp-open", origin: "manual", priority: 2 });
  r2.store.jobs[0].next_attempt_at = w2.now() + 99 * 3600 * 1000; // open, not claimable now
  const ev = await r2.store.readRouteEvidence(ROUTES.routeById("brand-view-brands"), ROUTES.buildEvidenceContext({ epoch: EPOCH, now: w2.now(), directory: await r2.store.readDirectory(), region: REGION, organizationFingerprint: ORG }));
  await r2.store.enqueue({ route: "brand-view-brands", region: REGION, targetKey: "IN1", owners: ["IN1"], asOf: EPOCH, token: ev.get("IN1").token, origin: "manual", priority: 5 });
  await r2.worker.processOneBatch();
  const bj = jobsOf(r2.store, "brand-view-brands")[0];
  ok("S3f an OPEN upstream (fba-plan) job blocks brand-view-brands for that owner: deferred 'awaiting-upstream:fba-plan', NO attempt, NO child, state untouched", bj.status === "deferred" && /awaiting-upstream:fba-plan/.test(bj.last_reason) && bj.attempts === 0 && w2.runs.length === 0 && !stateOf(r2.store, "brand-view-brands", "IN1"));
  r2.store.jobs[0].status = "dead"; r2.store.jobs[0].last_class = "permanent-integrity";
  w2.tick(200 * 1000);
  await r2.worker.processOneBatch();
  ok("S3g ... a DEAD upstream does not block: the dependent proceeds and verifies", jobsOf(r2.store, "brand-view-brands")[0].status === "verified" && w2.runs.some((r) => r.route === "brand-view-brands" && r.kind === "live"));
  // a 'stale' upstream STATE blocks; an upstream job deferred missing-evidence (will not converge soon) does not.
  const w3 = makeWorld(); for (const a of ACCTS) { seedLegacyRow(w3, "brand-sales", a); seedFbaPlanRow(w3, a); }
  const r3 = makeRig(w3, { liveRoutes: ["fba-plan", "brand-view-brands"] });
  const ctx3 = ROUTES.buildEvidenceContext({ epoch: EPOCH, now: w3.now(), directory: await r3.store.readDirectory(), region: REGION, organizationFingerprint: ORG });
  const bvbEv = await r3.store.readRouteEvidence(ROUTES.routeById("brand-view-brands"), ctx3);
  await r3.store.recordBaseline([{ route_id: "fba-plan", region: REGION, target_key: "IN1", requested_as_of: EPOCH, owners: ["IN1"], token: "fp-stale", class: "stale", reason: "live-refresh-differs" }]);
  await r3.store.enqueue({ route: "fba-plan", region: REGION, targetKey: "IN2", owners: ["IN2"], asOf: EPOCH, token: "fp-missing", origin: "manual", priority: 2 });
  Object.assign(r3.store.jobs[0], { status: "deferred", last_class: CLS.CLASSES.MISSING_EVIDENCE, next_attempt_at: w3.now() + 99 * 3600 * 1000 });
  for (const a of ACCTS) await r3.store.enqueue({ route: "brand-view-brands", region: REGION, targetKey: a, owners: [a], asOf: EPOCH, token: bvbEv.get(a).token, origin: "manual", priority: 5 });
  await r3.worker.processOneBatch();
  const s3in1 = jobsOf(r3.store, "brand-view-brands").find((j) => j.target_key === "IN1"); const s3in2 = jobsOf(r3.store, "brand-view-brands").find((j) => j.target_key === "IN2");
  ok("S3h a 'stale' upstream STATE (fba-plan IN1) blocks its owner's dependent (awaiting-upstream, no attempt), while an upstream job deferred MISSING-EVIDENCE (fba-plan IN2: will not converge soon) does NOT block -- IN2 publishes in the same batch", s3in1.status === "deferred" && /awaiting-upstream:fba-plan/.test(s3in1.last_reason) && s3in1.attempts === 0 && s3in2.status === "verified" && J(w3.runs.find((r) => r.kind === "live").targets) === J(["IN2"]));
}

// =====================================================================================================================
// S4. CONCURRENCY: two workers + one scheduler-mode route run (the WP13 job: --mode=scheduler --live --lease-wait-seconds
//     =600, no targets) on the SAME targets -> exactly ONE published live row per target.
// =====================================================================================================================
{
  const liveOf = (w, a) => [...w.snaps.values()].filter((r) => r.report_key === "returns-leakage" && r.account_id === a);
  const shadowsOf = (w, a) => [...w.snaps.values()].filter((r) => r.report_key === "scheduler-v2/returns-leakage-v3" && r.account_id === a);
  const schedArgv = (tok) => ["--route=returns-v3", "--bucket=india", "--as-of=" + EPOCH, "--mode=scheduler", "--live", "--run-token=" + tok, "--deadline-seconds=3000", "--lease-wait-seconds=600", "--emit-targets"];
  const pa = REL.parseRouteCliArgs(schedArgv("gh-9001-1-materialize"));
  ok("S4a the scheduler argv is the WP13 shape (REAL parser: scheduler mode, live, whole region, bounded lease wait)", pa.ok && pa.args.mode === "scheduler" && pa.args.live && pa.args.targets === null && pa.args.leaseWaitSeconds === 600);
  // 4A: a NATURAL race -- two workers + the scheduler run started together on the same targets.
  const w = makeWorld();
  const rig1 = makeRig(w, { liveRoutes: ["returns-v3"], workerId: "w1" });
  const rig2 = makeRig(w, { liveRoutes: ["returns-v3"], workerId: "w2", store: rig1.store });
  await rig1.worker.watermarkPass();
  const [b1, b2, sched] = await Promise.all([rig1.worker.processOneBatch(), rig2.worker.processOneBatch(), w.execCli(schedArgv("gh-9001-1-materialize"))]);
  const jobs = jobsOf(rig1.store, "returns-v3");
  dbg("S4A", { b1, b2, runs: w.runs.map((r) => [r.kind, r.res.exitCode]), jobs: jobs.map((j) => [j.target_key, j.status, j.last_class, j.last_reason]), sched: sched.result && sched.result.counts, n: w.n });
  ok("S4b skip-locked claims: worker 1 claimed the batch, worker 2 claimed NOTHING -- at most ONE worker live child for these targets", b1 === true && b2 === false && w.runs.filter((r) => r.kind === "live").length <= 1);
  // HOW the loser was serialized (whichever interleaving microtask order produced): the worker's control-lease pre-check,
  // a CONTROL_LEASE_HELD refusal, a claim-held derive lease, or the content-addressed CAS answering 'already-current'
  // (the SAME shadow hash + stamp -> the second fenced publish writes nothing).
  const liveUnits = (() => { const lr = lastRun(w, "returns-v3", "live"); const n = lr && lr.res.targets ? TGT.normalizeTargets(lr.res.targets) : null; return n ? n.targets.flatMap((t) => t.units) : []; })();
  const schedUnits = sched.targets[0] ? sched.targets[0].targets.flatMap((t) => t.units) : [];
  const mechanism = jobs.some((j) => j.last_class === CLS.CLASSES.CONTENTION) ? "worker-lease-precheck" : w.n.leaseHeld >= 1 ? "control-lease-held" : [...liveUnits, ...schedUnits].some((u) => /claim-held/.test(S(u.r))) ? "derive-lease-held" : [...liveUnits, ...schedUnits].some((u) => u.s === "PUBLICATION_NOT_REQUIRED" && u.r === "already-current") ? "cas-already-current" : (liveUnits.length && liveUnits.every((u) => u.s === "PUBLICATION_NOT_REQUIRED")) ? "live-child-rescan-found-it-current" : "none";
  dbg("S4A-units", { live: liveUnits.map((u) => u.s + ":" + u.r), sched: schedUnits.map((u) => u.s + ":" + u.r), schedStdout: sched.stdout.filter((l) => !l.startsWith("TARGETS")).slice(0, 3), pre: (lastRun(w, "returns-v3", "verify") || { res: {} }).res.targets && TGT.normalizeTargets(lastRun(w, "returns-v3", "verify").res.targets).targets.map((t) => t.units.map((u) => u.s + ":" + u.r)) });
  ok(`S4c the race is serialized (here: ${mechanism}) and yields EXACTLY ONE live row + ONE content-addressed shadow + ONE lineage job + ONE cycle per target (2 live writes in total), zero DataDoe, no failure`, mechanism !== "none" && ACCTS.every((a) => liveOf(w, a).length === 1 && shadowsOf(w, a).length === 1) && w.n.liveWrite === 2 && w.n.jobInsert === 2 && w.n.cycleCreate === 2 && sched.result && sched.result.dataDoeCreates === 0 && sched.result.counts.targetsFailed === 0);
  // Formerly OBSERVATION S4c (fixed in worker.js step 7): a live child that published NOTHING (every unit
  // PUBLICATION_NOT_REQUIRED -- the concurrent scheduler run wrote the rows) is recorded NOT published (hand-off
  // already-current, never 'repaired').
  const liveAllCurrent = liveUnits.length > 0 && liveUnits.every((u) => u.s === "PUBLICATION_NOT_REQUIRED");
  ok("S4c' a worker job whose live child found every unit already current is verified with published:false (never 'repaired' for another run's write)",
    !liveAllCurrent || jobs.filter((j) => j.status === "verified").every((j) => j.published !== true));
  await drain(rig1);
  ok("S4d the worker then VERIFIES both targets against that one row (served proof) with ZERO further live writes", jobsOf(rig1.store, "returns-v3").every((j) => j.status === "verified") && ACCTS.every((a) => stateOf(rig1.store, "returns-v3", a).served_confirmed === true) && w.n.liveWrite === 2);
  const wr = w.writes();
  const again = await w.execCli(schedArgv("gh-9002-1-materialize"));
  ok("S4e a later scheduler run over the same evidence is a ZERO-write no-op (every target already current); the lease is free", again.result && again.result.ok === true && again.result.counts.targetsAlreadyCurrent === 2 && w.writes() === wr && w.lease.owner === "");
  // 4B: a FORCED overlap -- the scheduler run starts while the worker's live child HOLDS the control lease inside its
  // window (immediately before its fenced CAS).
  const wb = makeWorld();
  const rb = makeRig(wb, { liveRoutes: ["returns-v3"], workerId: "w1" });
  await rb.worker.watermarkPass();
  let inWindow = null;
  wb.faults.push({ point: "publish:cas", action: "call", once: true, when: (i) => i.cli === "route" && S(i.runToken).startsWith("prw-"), fn: async () => {
    const before = { ...wb.n }; const heldBy = wb.lease.owner;
    const res = await wb.execCli(schedArgv("gh-9003-1-materialize"));
    inWindow = { res, before, heldBy, after: { ...wb.n } };
  } });
  await rb.worker.processOneBatch();
  const sT = inWindow && inWindow.res.targets[0] ? inWindow.res.targets[0].targets : [];
  dbg("S4B", { inWindow: inWindow && { counts: inWindow.res.result && inWindow.res.result.counts, units: sT.map((t) => t.units.map((u) => u.s + ":" + u.r)), before: inWindow.before, after: inWindow.after, heldBy: inWindow.heldBy }, jobs: jobsOf(rb.store).map((j) => [j.target_key, j.status, j.last_class, j.last_reason]) });
  ok("S4f in-window overlap: the scheduler's prepare RESUMES the worker's content-addressed shadows (ZERO new cycle / job / shadow writes) and its publish is refused CONTROL_LEASE_HELD for the whole bounded lease wait (typed 'controls-not-opened', ZERO live writes)",
    !!inWindow && S(inWindow.heldBy).startsWith("publication-route-reconcile:india:prw-") && inWindow.after.cycleCreate === inWindow.before.cycleCreate && inWindow.after.jobInsert === inWindow.before.jobInsert && inWindow.after.shadowWrite === inWindow.before.shadowWrite && inWindow.after.liveWrite === inWindow.before.liveWrite && inWindow.after.leaseHeld > inWindow.before.leaseHeld
    && sT.length === 2 && sT.every((t) => t.units.every((u) => u.s === "DEFERRED_DEPENDENCY" && /^controls-not-opened:/.test(S(u.r)))));
  const jB = (a) => jobsOf(rb.store).find((j) => j.target_key === a);
  ok("S4g ... then the worker's fenced CAS lands for the unit it held the window for (verified, published); the scheduler's 600 s lease wait consumed the worker child's run deadline, so its next unit is the typed 'deadline-cleanup-reserved' (not-attempted, no write) -- never a race write", jB("IN1").status === "verified" && jB("IN1").published === true && jB("IN2").last_class === CLS.CLASSES.NOT_ATTEMPTED && jB("IN2").last_reason === "deadline-cleanup-reserved" && wb.n.liveWrite === 1 && liveOf(wb, "IN2").length === 0);
  await drain(rb);
  ok("S4g ... and after the retry EXACTLY ONE live row + ONE shadow per target, both jobs verified (2 live writes in total)", ACCTS.every((a) => liveOf(wb, a).length === 1 && shadowsOf(wb, a).length === 1) && wb.n.liveWrite === 2 && jobsOf(rb.store).every((j) => j.status === "verified"));
  // the global scheduler gate: a RUNNING natural cycle defers the worker (no attempt, no child) -- the first line of defense.
  const w3 = makeWorld(); const r3 = makeRig(w3, { liveRoutes: ["returns-v3"] });
  w3.naturalCycles.push({ bucket: "india", status: "running", started_ms: w3.now() - 60000, updated_ms: w3.now() - 1000 });
  await r3.worker.watermarkPass(); await r3.worker.processOneBatch();
  ok("S4h a running natural scheduler cycle defers every worker job globally (scheduler-window-global, no attempt, no child)", jobsOf(r3.store).every((j) => j.status === "deferred" && j.last_class === "scheduler-window-global" && j.attempts === 0) && w3.runs.length === 0);
}

// =====================================================================================================================
// S5. CHILD TIMEOUTS through the REAL runner kill path.
// =====================================================================================================================
{
  // 5a PREPARE: the live child hangs before its shadow write -> killed -> cleanup (same token) -> no live write.
  const w = makeWorld(); const rig = makeRig(w, { liveRoutes: ["returns-v3"] });
  await rig.store.enqueue({ route: "returns-v3", region: REGION, targetKey: "IN1", owners: ["IN1"], asOf: EPOCH, token: (await rig.store.readRouteEvidence(ROUTES.routeById("returns-v3"), ROUTES.buildEvidenceContext({ epoch: EPOCH, now: w.now(), directory: await rig.store.readDirectory(), region: REGION, organizationFingerprint: ORG }))).get("IN1").token, origin: "manual", priority: 3 });
  w.faults.push({ point: "prepare:shadow", action: "hang", kind: "live", when: (i) => i.live });
  await rig.worker.processOneBatch();
  const live = lastRun(w, "returns-v3", "live"); const clean = lastRun(w, "returns-v3", "cleanup");
  const j = jobsOf(rig.store)[0];
  ok("S5a a live child hung in PREPARE is killed by the REAL runner hard timeout (timedOut, SIGTERM, no RESULT)", live && live.res.timedOut === true && live.res.signal === "SIGTERM" && live.res.result === null);
  ok("S5a ... the worker runs the CLEANUP child with the SAME run token (controls were never opened: 'already-closed'); the job retries typed 'timeout' (attempt 1); ZERO live writes (the cycle + job exist, no shadow)", clean && clean.runToken === live.runToken && clean.res.result && clean.res.result.cleaned === true && clean.res.result.disposition === "already-closed" && j.status === "pending" && j.last_class === CLS.CLASSES.TIMEOUT && j.attempts === 1 && w.n.liveWrite === 0 && w.n.cycleCreate === 1 && w.n.jobInsert === 1 && w.n.shadowWrite === 0);
  await drain(rig);
  ok("S5a the retry resumes the SAME running cycle + job (the killed derive lease is reclaimed after it expires) and publishes exactly once: 1 cycle, 1 job, 1 shadow, 1 live write", jobsOf(rig.store)[0].status === "verified" && w.n.cycleCreate === 1 && w.n.jobInsert === 1 && w.n.shadowWrite === 1 && w.n.liveWrite === 1);
  // 5b PUBLISH: an LKG row exists; new evidence; the live child hangs INSIDE the control window (lease held, before the CAS).
  const wb = makeWorld(); const rb = makeRig(wb, { liveRoutes: ["returns-v3"] });
  await rb.worker.watermarkPass(); await drain(rb);
  const lkgKey = "returns-leakage|IN1|" + paramsHashFor("returns-leakage-v3", { to: "2026-09-22" });
  const lkg = J(wb.snaps.get(lkgKey));
  wb.tick(20 * 60 * 1000); wb.addReturn("IN1", "2026-09-22", wb.iso(wb.now() - 60000)); wb.tick(15 * 60 * 1000);
  await rb.worker.watermarkPass();
  wb.faults.push({ point: "publish:cas", action: "hang", kind: "live", when: (i) => i.live });
  let foreign = null; let heldAtForeign = null;
  wb.faults.push({ point: "cleanup:start", action: "call", when: (i) => i.runToken && i.runToken.startsWith("prw-"), fn: async () => {
    heldAtForeign = { ...wb.lease };
    foreign = await wb.execCli(["--route=returns-v3", "--bucket=india", "--as-of=" + EPOCH, "--cleanup", "--run-token=operator-other-run-0001"]);
  } });
  const runs0 = wb.runs.length;
  await rb.worker.processOneBatch();
  const bLive = wb.runs.slice(runs0).find((r) => r.kind === "live"); const bClean = wb.runs.slice(runs0).find((r) => r.kind === "cleanup");
  ok("S5b a live child hung in PUBLISH (inside its control window, before the CAS) is killed; the global lease is still HELD by its run token at that moment", bLive && bLive.res.timedOut === true && heldAtForeign && heldAtForeign.owner === REL.routeCliOperator({ bucket: REGION, runToken: bLive.runToken, asOf: EPOCH }) && heldAtForeign.exp > wb.now());
  ok("S5b a cleanup with ANOTHER run token finds a LIVE foreign owner: refused (reclaim held, not cleaned, STOP ROUTE_CLEANUP_UNVERIFIED), the lease untouched", foreign && foreign.code === 1 && foreign.result && foreign.result.cleaned === false && foreign.result.reclaim === "refused-or-held" && foreign.stderr.some((l) => l.startsWith("STOP ROUTE_CLEANUP_UNVERIFIED")));
  ok("S5b the worker's cleanup child with the SAME run token reclaims its own (same-owner) lease immediately, safe-closes and PROVES the control plane closed; the lease is free", bClean && bClean.runToken === bLive.runToken && bClean.res.result && bClean.res.result.cleaned === true && bClean.res.result.reclaim === "committed" && wb.lease.owner === "" && [...wb.ctl.promoted.values()].every((v) => v === false));
  ok("S5b the live row is BYTE-IDENTICAL LKG (the killed publish never reached the CAS); the job retries typed 'timeout'", J(wb.snaps.get(lkgKey)) === lkg && jobsOf(rb.store).find((x) => x.origin === "watermark" && x.status === "pending").last_class === CLS.CLASSES.TIMEOUT);
  await drain(rb);
  ok("S5b the retry publishes the NEW evidence (the prepared shadow resumed) and verifies", jobsOf(rb.store).every((x) => x.status === "verified") && wb.snaps.get(lkgKey).payload.rows[0].refunds === 4);
}

// =====================================================================================================================
// S6. CRASH before / after publication.
// =====================================================================================================================
{
  const w = makeWorld(); const rig = makeRig(w, { liveRoutes: ["returns-v3"] });
  await rig.worker.watermarkPass();
  w.faults.push({ point: "prepare:after-finalize", action: "crash", when: (i) => i.live && i.targets && i.targets.includes("IN1") });
  await rig.worker.processOneBatch();
  const c1 = { ...w.n };
  const kinds1 = w.runs.map((r) => r.kind);
  ok("S6a a live child that dies right AFTER its prepare (cycle + job + shadow + finalize written, exit 1, no RESULT): cleanup (same token) then verify; the jobs retry typed transport, ZERO live writes", J(kinds1) === J(["verify", "live", "cleanup", "verify"]) && c1.liveWrite === 0 && c1.shadowWrite >= 1 && jobsOf(rig.store).every((j) => j.status === "pending" && j.last_class === CLS.CLASSES.TRANSPORT && j.attempts === 1));
  await drain(rig);
  ok("S6a the retry RESUMES IN1's finished prepare with ZERO new cycle / job / shadow / finalize writes (only IN2, never reached before the crash, prepares once) and publishes exactly once per target: 2 cycles / jobs / shadows / finalizes / live writes in total", c1.cycleCreate === 1 && c1.jobInsert === 1 && c1.shadowWrite === 1 && c1.finalize === 1 && jobsOf(rig.store).every((j) => j.status === "verified") && w.n.cycleCreate === 2 && w.n.jobInsert === 2 && w.n.shadowWrite === 2 && w.n.finalize === 2 && w.n.liveWrite === 2 && ACCTS.every((a) => w.jobs.filter((j) => j.account_id === a).length === 1));
  // 6b crash AFTER the CAS landed (inside the window): verify proves it -> verified WITHOUT a second live child.
  const w2 = makeWorld(); const r2 = makeRig(w2, { liveRoutes: ["returns-v3"] });
  await r2.worker.watermarkPass();
  w2.faults.push({ point: "publish:after-cas", action: "crash", when: (i) => i.live });
  await r2.worker.processOneBatch();
  const kinds2 = w2.runs.map((r) => r.kind);
  const liveRun2 = w2.runs.find((r) => r.kind === "live");
  ok("S6b a live child that dies right AFTER its first fenced CAS landed: exit 1 + no RESULT -> the SAME-token cleanup reclaims the dead child's lease (proven closed) -> the verify pass PROVES the landed row -> that job is VERIFIED (published) with NO second live child", J(kinds2) === J(["verify", "live", "cleanup", "verify"]) && liveRun2.res.exitCode === 1 && w2.runs.find((r) => r.kind === "cleanup").res.result.cleaned === true && w2.lease.owner === "" && jobsOf(r2.store).some((j) => j.status === "verified" && j.published === true) && w2.n.liveWrite === 1);
  await drain(r2);
  ok("S6b the target the crash never reached publishes on the retry; in total exactly ONE live write per target", jobsOf(r2.store).every((j) => j.status === "verified") && w2.n.liveWrite === 2);
}

// =====================================================================================================================
// S7. STALE claim lease + STALE control lease.
// =====================================================================================================================
{
  const w = makeWorld(); const rigA = makeRig(w, { liveRoutes: ["returns-v3"], workerId: "w1" });
  const rigB = makeRig(w, { liveRoutes: ["returns-v3"], workerId: "w2", store: rigA.store });
  await rigA.worker.watermarkPass();
  const claimedByDead = await rigA.store.claim({ workerId: "w1", claimToken: "dead-claim-0001", limit: 5, leaseSeconds: 2700 });
  ok("S7a setup: worker A claimed the batch and died (no finish)", claimedByDead.length === 2 && rigA.store.jobs.every((j) => j.status === "claimed"));
  const early = await rigB.worker.processOneBatch();
  w.tick(2701 * 1000);
  await rigB.worker.processOneBatch();
  ok("S7a worker B cannot touch the jobs while A's claim lease lives; after it expires B RECLAIMS (claims 2) and publishes each target ONCE", early === false && rigA.store.jobs.every((j) => j.status === "verified") && w.n.liveWrite === 2 && w.runs.filter((r) => r.kind === "live").length === 1);
  ok("S7a the dead claim can never finish afterwards (not-owner)", (await rigA.store.finish({ id: claimedByDead[0].id, claimToken: "dead-claim-0001", outcome: "verified", evaluatedToken: claimedByDead[0].evidence_token })) === "not-owner");
  // stale CONTROL lease: a dead operation left the global lease held.
  const w2 = makeWorld(); const r2 = makeRig(w2, { liveRoutes: ["returns-v3"] });
  await r2.worker.watermarkPass();
  const deadOwner = "publication-route-reconcile:india:dead-run-0001";
  w2.lease = { owner: deadOwner, op: "publication-route-reconcile/returns-v3/india/" + EPOCH, gen: 5, exp: w2.now() + 900 * 1000 };
  // ... and it died INSIDE its window: its controls are still open.
  w2.ctl.rollout.set("IN1", true); w2.ctl.promoted.set("returns-leakage-v3", true); w2.ctl.approvals.set("returns-leakage-v3|IN1", true);
  await r2.worker.processOneBatch();
  ok("S7b a HELD control lease (a dead operation) defers the batch typed contention BEFORE any child (no attempt)", jobsOf(r2.store).every((j) => j.status === "deferred" && j.last_class === CLS.CLASSES.CONTENTION && j.attempts === 0) && w2.runs.length === 0);
  w2.tick(901 * 1000);
  const reclaim = await w2.execCli(["--route=returns-v3", "--bucket=india", "--as-of=" + EPOCH, "--cleanup", "--run-token=operator-reclaim-0001"]);
  ok("S7b after the TTL a cleanup with another run token RECLAIMS the EXPIRED lease (generation bumped 5 -> 6), safe-closes and proves the plane closed", reclaim.code === 0 && reclaim.result.cleaned === true && reclaim.result.reclaim === "committed" && w2.lease.owner === "" && w2.lease.gen === 6);
  const late = await w2.liveCasFenced({ reportKey: "returns-leakage", accountId: "IN1", paramsHash: "h", params: {}, payload: {}, sourceRefreshedAt: w2.iso(w2.now()), ownerToken: deadOwner, generation: 5 });
  ok("S7b a late write from the dead operation's fence is refused lease-lost with ZERO rows", late.outcome === "lease-lost" && w2.n.liveWrite === 0);
  await drain(r2);
  ok("S7b the worker then publishes normally (fresh generation) exactly once per target", jobsOf(r2.store).every((j) => j.status === "verified") && w2.n.liveWrite === 2 && w2.lease.gen === 7);
}

// =====================================================================================================================
// S8. NEWER EVIDENCE MID-RUN at each TOCTOU point -> typed deferral / re-arm, zero writes, the older evidence never published.
// =====================================================================================================================
{
  const tokenNow = async (rig, route, tk) => (await rig.store.readRouteEvidence(ROUTES.routeById(route), ROUTES.buildEvidenceContext({ epoch: EPOCH, now: rig.w.now(), directory: await rig.store.readDirectory(), region: REGION, organizationFingerprint: ORG }))).get(tk).token;
  // (a) entry: between the claim and the pre-check scan.
  const wa = makeWorld(); const ra = makeRig(wa, { liveRoutes: ["returns-v3"] });
  const t1 = await tokenNow(ra, "returns-v3", "IN1");
  await ra.store.enqueue({ route: "returns-v3", region: REGION, targetKey: "IN1", owners: ["IN1"], asOf: EPOCH, token: t1, origin: "manual", priority: 3 });
  wa.hooks.beforeChild = async (rec) => { if (rec.spec && rec.spec.kind === "verify") { wa.addReturn("IN1", "2026-09-22", wa.iso(wa.now() - 1000)); wa.hooks.beforeChild = null; } };
  await ra.worker.processOneBatch();
  const ja = jobsOf(ra.store)[0]; const t2 = await tokenNow(ra, "returns-v3", "IN1");
  ok("S8a TOCTOU at ENTRY: the pre-check evaluated a NEWER token than the claim -> RE-ARMED onto the worker's current token (evidence-advanced), no live child, ZERO writes", ja.status === "pending" && ja.evidence_token === t2 && t2 !== t1 && ja.rearms === 1 && !wa.runs.some((r) => r.kind === "live") && wa.writes() === 0);
  await drain(ra);
  ok("S8a ... the re-armed job then publishes the NEW evidence only", jobsOf(ra.store)[0].status === "verified" && S(wa.liveRows("returns-leakage")[0].params.evidenceToken) === t2);
  // (b) before the first write: the evidence moves between the prepare's two bundle resolves.
  const wb = makeWorld(); const rb = makeRig(wb, { liveRoutes: ["returns-v3"] });
  const tb1 = await tokenNow(rb, "returns-v3", "IN1");
  await rb.store.enqueue({ route: "returns-v3", region: REGION, targetKey: "IN1", owners: ["IN1"], asOf: EPOCH, token: tb1, origin: "manual", priority: 3 });
  let armed = false;
  wb.hooks.beforeChild = async (rec) => { armed = !!(rec.spec && rec.spec.kind === "live"); };
  wb.hooks.afterGather = async () => { if (armed) { armed = false; wb.addReturn("IN1", "2026-09-22", wb.iso(wb.now() - 1000)); } };
  await rb.worker.processOneBatch();
  const liveB = lastRun(wb, "returns-v3", "live");
  const ub = targetOf(liveB, "IN1").units[0];
  const jb = jobsOf(rb.store)[0];
  dbg("S8b", { job: [jb.status, jb.evidence_token === tb1, jb.rearms, jb.last_class, jb.last_reason], state: stateOf(rb.store, "returns-v3", "IN1"), kinds: wb.runs.map((r) => r.kind), ver: (targetOf(lastRun(wb, "returns-v3", "verify"), "IN1") || {}).units });
  ok("S8b TOCTOU BEFORE THE FIRST WRITE: the prepare's re-resolve sees the new revision -> typed 'revision-advanced-before-write' (classified evidence-advanced), ZERO cycle / job / shadow / live writes", ub.s === "DEFERRED_DEPENDENCY" && ub.r === "revision-advanced-before-write" && CLS.classifyReason(ub.s, ub.r, { routeKind: "route-cli", routeId: "returns-v3" }).cls === CLS.CLASSES.EVIDENCE_ADVANCED && wb.writes() === 0);
  ok("S8b ... the verify child evaluated the NEW token -> the job is RE-ARMED (never verified, never published for the old evidence)", jb.status === "pending" && jb.evidence_token !== tb1 && jb.rearms >= 1 && (stateOf(rb.store, "returns-v3", "IN1") || {}).verified_token == null);
  wb.hooks.beforeChild = null; wb.hooks.afterGather = null;
  await drain(rb);
  ok("S8b ... and the next pass publishes the new evidence", jobsOf(rb.store)[0].status === "verified" && S(wb.liveRows("returns-leakage")[0].params.evidenceToken) === jobsOf(rb.store)[0].evidence_token);
  // (c) before publish: the evidence moves after the control window opened, before the fenced CAS.
  const wc = makeWorld(); const rc = makeRig(wc, { liveRoutes: ["returns-v3"] });
  const tc1 = await tokenNow(rc, "returns-v3", "IN1");
  await rc.store.enqueue({ route: "returns-v3", region: REGION, targetKey: "IN1", owners: ["IN1"], asOf: EPOCH, token: tc1, origin: "manual", priority: 3 });
  wc.faults.push({ point: "controls:open", action: "call", when: (i) => i.live, fn: async () => { wc.addReturn("IN1", "2026-09-22", wc.iso(wc.now() - 1000)); } });
  await rc.worker.processOneBatch();
  const uc = targetOf(lastRun(wc, "returns-v3", "live"), "IN1").units[0];
  ok("S8c TOCTOU BEFORE PUBLISH: the in-window evidence re-read defers 'evidence-advanced' with ZERO preflight / CAS / live writes (the prepared shadow is never promoted); the job re-arms", uc.s === "DEFERRED_DEPENDENCY" && uc.r === "evidence-advanced" && wc.n.liveCas === 0 && wc.n.publish === 0 && wc.n.liveWrite === 0 && jobsOf(rc.store)[0].status === "pending" && jobsOf(rc.store)[0].evidence_token !== tc1);
  await drain(rc);
  const liveC = wc.liveRows("returns-leakage");
  ok("S8c ... the next pass publishes the NEW revision (a new nonce cycle); the old token was NEVER published", jobsOf(rc.store)[0].status === "verified" && liveC.length === 1 && S(liveC[0].params.evidenceToken) === jobsOf(rc.store)[0].evidence_token && S(liveC[0].params.evidenceToken) !== tc1 && wc.n.liveWrite === 1 && wc.n.cycleCreate === 2);
  // (d) a GATE closes between the pre-check and the live child (the natural scheduler cycle starts while the pre-check
  // child runs): the worker's re-check immediately before the live child holds it -- no live child, no attempt.
  const wd = makeWorld(); const rd = makeRig(wd, { liveRoutes: ["returns-v3"] });
  await rd.worker.watermarkPass();
  wd.hooks.beforeChild = async (rec) => { if (rec.spec && rec.spec.kind === "verify") { wd.naturalCycles.push({ bucket: "india", status: "running", started_ms: wd.now(), updated_ms: wd.now() }); wd.hooks.beforeChild = null; } };
  await rd.worker.processOneBatch();
  ok("S8d a scheduler cycle that starts DURING the pre-check child closes the gate before the live child: the worker's re-check defers every job (scheduler-window-global, NO attempt), NO live child, ZERO writes", J(wd.runs.map((r) => r.kind)) === J(["verify"]) && jobsOf(rd.store).every((j) => j.status === "deferred" && j.last_class === "scheduler-window-global" && j.attempts === 0) && wd.writes() === 0);
}

// =====================================================================================================================
// S9. INVALID / MISSING SOURCE per route -> typed class (+ the classifier's alert), ZERO writes, never a zero / empty
//     payload published.
// =====================================================================================================================
{
  const CASES = {
    oli: { setup: (w) => w.legacyFaults.set("oli|IN1", "oli-coverage-incomplete"), code: "oli-coverage-incomplete", alert: null },
    listings: { setup: (w) => w.legacyFaults.set("listings|IN1", "listings-raw:no-validated-snapshot"), code: "listings-raw:no-validated-snapshot", alert: null },
    "fba-plan": { setup: (w) => w.fbaPointers.delete("IN1"), code: "fba-durable-missing", alert: null },
    "returns-v3": { setup: (w) => w.gatherFaults.set("IN1", "catalog-missing"), code: "catalog-missing", alert: null },
    ads: { setup: (w) => w.legacyFaults.set("ads|IN1", "ads:ads-coverage-incomplete"), code: "ads:ads-coverage-incomplete", alert: null },
    fba: { setup: (w) => w.legacyFaults.set("fba|IN1", "fba-snapshot-incomplete"), code: "fba-snapshot-incomplete", alert: null },
    "brand-view-brands": { setup: (w) => { const id = legacyIdentity("brand-sales", EPOCH); w.put({ id: "bs-out-of-line", report_key: "brand-sales", account_id: "IN1", params_hash: id.hash, params: id.params, payload: { rows: [], catalogBrands: [] }, payload_storage_path: "report-snapshots/brand-sales/IN1/gone.json", source_refreshed_at: w.iso(w.tick(1000)), updated_at: w.iso(w.tick(1000)) }); seedFbaPlanRow(w, "IN1"); }, code: "storage-missing:brand-sales", alert: "storage-missing" },
    "sku-movement": { setup: (w) => { seedBrandsRow(w, "IN1"); w.catalogPayloads.set(CAT_PATH, { rows: [] }); }, code: "catalog-empty", alert: null },
    "brand-view": { setup: (w) => { seedBrandsRow(w, "IN1"); w.routeFaults.set("brand-view|IN1", "evidence-read-failed:storage-missing:brand-sales"); }, code: "storage-missing", alert: "storage-missing" },
    "brand-view-portfolio": { setup: (w) => { for (const a of ACCTS) seedBrandsRow(w, a); w.routeFaults.set("brand-view-portfolio|region:india", "member-directory-ambiguous"); }, code: "member-directory-ambiguous", alert: "evidence-ambiguous-or-invalid" },
  };
  for (const id of ROUTE_ORDER) {
    const c = CASES[id];
    const w = makeWorld(); c.setup(w);
    const rig = makeRig(w, { liveRoutes: [id] });
    const route = ROUTES.routeById(id);
    const tk = route.grain === "region" ? "region:india" : "IN1";
    const liveBefore = J([...w.snaps.values()].filter((r) => route.liveReportKeys.includes(r.report_key)));
    const ev = await rig.store.readRouteEvidence(route, ROUTES.buildEvidenceContext({ epoch: EPOCH, now: w.now(), directory: await rig.store.readDirectory(), region: REGION, organizationFingerprint: ORG }));
    await rig.store.enqueue({ route: id, region: REGION, targetKey: tk, owners: route.grain === "region" ? [...ACCTS] : [tk], asOf: EPOCH, token: ev.get(tk).token, origin: "manual", priority: route.priority });
    const w0 = w.writes();
    await rig.worker.processOneBatch();
    const j = jobsOf(rig.store, id)[0];
    const st = stateOf(rig.store, id, tk);
    // the typed unit reason the child reported (pre-check for scan-time ineligibility, else the live pass)
    const runLive = lastRun(w, id, "live");
    const src = runLive || lastRun(w, id, preKind(id));
    const unit = (targetOf(src, tk) || { units: [] }).units.find((u) => S(u.r).includes(c.code)) || null;
    const verdict = unit ? CLS.classifyReason(unit.s, unit.r, { routeKind: route.kind, routeId: id }) : null;
    ok(`S9 ${id}: an invalid / missing source ('${c.code}') is the typed class missing-evidence (classifier alert: ${c.alert || "none"}), deferred with NO attempt, hand-off missing-source; ZERO writes and the live report untouched (no zero / empty payload)`,
      j.status === "deferred" && j.last_class === CLS.CLASSES.MISSING_EVIDENCE && j.attempts === 0 && st && st.handoff === "missing-source" && verdict && verdict.cls === CLS.CLASSES.MISSING_EVIDENCE && S(verdict.alert) === S(c.alert) && S(j.last_reason).includes(c.code)
      && w.writes() === w0 && J([...w.snaps.values()].filter((r) => route.liveReportKeys.includes(r.report_key))) === liveBefore && w.n.liveCas === 0);
    // Formerly a DEFECT-REPRO note: worker.js step (7) took the alert from the VERIFY verdict while the class came from the
    // LIVE verdict, dropping a live-pass typed alert. Fixed (the alert is the union over every verdict consulted) -> pinned.
    ok(`S9b ${id}: the classifier's alert for the typed reason ('${c.alert || "none"}') reaches the job's last_alert (a live-pass alert is never dropped)`,
      !c.alert || S(j.last_alert).split(",").includes(c.alert));
  }
}

// =====================================================================================================================
// S10. ZERO-EXPORT TRIPWIRE: a guard-blocked DataDoe call (the ZEROEXPORT line, parsed by the REAL runner) trips the route,
//      dead-letters its jobs, and no live write happens.
// =====================================================================================================================
{
  const w = makeWorld(); const rig = makeRig(w, { liveRoutes: ["returns-v3", "oli"] });
  await rig.worker.watermarkPass();
  w.zeroExportTrap = (i) => i.cli === "route" && !i.live;
  await rig.worker.processOneBatch(); // oli (priority 1) first
  await rig.worker.processOneBatch(); // returns-v3: the pre-check child hits the tripwire
  const rt = jobsOf(rig.store, "returns-v3");
  const pre = lastRun(w, "returns-v3", "verify");
  ok("S10a a route child whose runtime attempts a DataDoe call is refused by the guard; the REAL runner folds its ZEROEXPORT line (blocked 1) and the RESULT is ZERO_EXPORT_VIOLATION", pre && pre.res.zeroExport.blocked >= 1 && pre.res.result && pre.res.result.code === "ZERO_EXPORT_VIOLATION");
  ok("S10a ... every job of the batch is DEAD zero-export-violation (alert, hand-off failed), the route is TRIPPED, NO live child ran and ZERO returns live writes", rt.every((j) => j.status === "dead" && j.last_class === CLS.CLASSES.ZERO_EXPORT_VIOLATION && j.last_alert === "zero-export-violation") && rig.worker.tripped.has("returns-v3") && !w.runs.some((r) => r.route === "returns-v3" && r.kind === "live") && w.liveRows("returns-leakage").length === 0 && stateOf(rig.store, "returns-v3", "IN1").handoff === "failed");
  w.zeroExportTrap = null; w.tick(700 * 1000);
  w.addReturn("IN1", "2026-09-22", w.iso(w.now() - 1000));
  const runs0 = w.runs.length;
  await rig.worker.watermarkPass(); await drain(rig);
  // (Final review: the former S10b was vacuous -- a tripped route never gets a new job, so "every new job is dead" held
  // over an empty list.) Now: nothing is enqueued/run for the tripped route, AND a job forced in directly is dead-lettered
  // by the tripped branch with no child.
  const newWm = jobsOf(rig.store, "returns-v3").filter((j) => j.evidence_token !== rt[0].evidence_token);
  const r3 = ROUTES.routeById("returns-v3");
  await rig.store.enqueue({ route: "returns-v3", region: REGION, targetKey: "IN1", owners: ["IN1"], asOf: EPOCH, token: "rl1:forced-after-trip", origin: "manual", priority: r3.priority });
  await rig.worker.processOneBatch();
  const forced = jobsOf(rig.store, "returns-v3").find((j) => j.evidence_token === "rl1:forced-after-trip");
  ok("S10b the tripped route runs NO child for the life of the process: no new job is admitted for it, and a job forced into the queue is DEAD 'route-tripped-this-process' (zero-export-violation) without any child; the other route (oli) kept publishing",
    newWm.length === 0 && !!forced && forced.status === "dead" && forced.last_class === CLS.CLASSES.ZERO_EXPORT_VIOLATION && /route-tripped/.test(S(forced.last_reason))
    && !w.runs.slice(runs0).some((r) => r.route === "returns-v3") && jobsOf(rig.store, "oli").every((j) => j.status === "verified"));
  // a LEGACY live child hitting the guard: dead + tripped, no write.
  const w2 = makeWorld(); const r2 = makeRig(w2, { liveRoutes: ["oli"] });
  await r2.worker.watermarkPass();
  w2.zeroExportTrap = (i) => i.cli === "legacy" && i.live;
  await r2.worker.processOneBatch();
  ok("S10c a LEGACY live child whose DataDoe call was blocked fails closed before any write: the batch dead-letters zero-export-violation, 'oli' trips, ZERO live writes", jobsOf(r2.store).every((j) => j.status === "dead" && j.last_class === CLS.CLASSES.ZERO_EXPORT_VIOLATION) && r2.worker.tripped.has("oli") && w2.n.liveWrite === 0 && w2.n.legacyWrite === 0);
  // the runner's ZEROEXPORT parsing robustness (the HANDOFF WP11 note): a guard line written right after a partial
  // (newline-less) stderr write. The guard (zero-export-guard.mjs, never imported here -- importing it installs it)
  // writes every line as "\n" + line + "\n" (fixed during this session); the probe emulates that exact byte shape.
  const probe = async (writeFn) => new Promise((resolve) => {
    const res = RUN.runRoute({ appRoot: ROOT, route: "oli", region: REGION, asOf: EPOCH, targets: ["IN1"], kind: "dry-run", env: {}, childMaxOldSpaceMb: 448, now: () => T0,
      spawnImpl: () => { const ch = makeFakeChild(); Promise.resolve().then(() => { writeFn(ch.io); ch.io.out("RESULT " + J({ ok: true, outcome: "complete", code: "OK", dataDoeCreates: 0, dataDoeTokens: 0 })); ch.io.exit(0); }); return ch; } });
    res.then(resolve);
  });
  const zline = RUN.ZERO_EXPORT_LINE_PREFIX + J({ blocked: 1, allowedAccountsGets: 0 });
  const clean = await probe((io) => { io.err(zline); });
  const guardShape = await probe((io) => { io.raw("stderr", "progress 42% "); io.raw("stderr", "\n" + zline + "\n"); });
  const oldShape = await probe((io) => { io.raw("stderr", "progress 42% "); io.raw("stderr", zline + "\n"); });
  const guardSrc = (await import("node:fs")).readFileSync(path.join(ROOT, "lib/server/recovery/zero-export-guard.mjs"), "utf8");
  ok("S10d the REAL runner folds a ZEROEXPORT line on its own line -> zero-export-violation", clean.zeroExport.blocked === 1 && CLS.classifyRun(clean).cls === CLS.CLASSES.ZERO_EXPORT_VIOLATION);
  ok("S10d' ... AND one the guard writes right after a partial stderr write (the guard's current byte shape: a LEADING newline, pinned in zero-export-guard.mjs onBlock + exit) -- the violation can no longer be glued away", guardShape.zeroExport.blocked === 1 && CLS.classifyRun(guardShape).cls === CLS.CLASSES.ZERO_EXPORT_VIOLATION
    && /const onBlock = \(\) => write\("\\n" \+ formatZeroExportLine\(counters\) \+ "\\n"\);/.test(guardSrc) && /write\("\\n" \+ formatZeroExportLine\(counters, \{ final: true \}\) \+ "\\n"\)/.test(guardSrc));
  if (oldShape.zeroExport.blocked === 0) observe("NOTE S10d (the HANDOFF WP11 note, now FIXED in zero-export-guard.mjs): without the leading newline a guard line glued to a partial stderr write is NOT parsed by the runner (blocked=0) -- the guard's leading \\n is load-bearing; keep it.");
}

// =====================================================================================================================
// S11. EXACT LIVE READ-BACK: served-row-differs (fixable) vs served-row-preempted; the C3 version-hidden case; an fba-plan
//      exact-today row.
// =====================================================================================================================
{
  // (a) served-row-differs: the serve read lags (returns-v3 selectLatestForScope sees no row) -> fixable -> readback mismatch.
  const w = makeWorld(); const rig = makeRig(w, { liveRoutes: ["returns-v3"] });
  await rig.worker.watermarkPass();
  w.serveLag = { reportKey: "returns-leakage" };
  await rig.worker.processOneBatch();
  const u = targetOf(lastRun(w, "returns-v3", "live"), "IN1").units[0];
  const v = targetOf(lastRun(w, "returns-v3", "verify"), "IN1").units[0];
  const j = jobsOf(rig.store).find((x) => x.target_key === "IN1");
  ok("S11a served-row-differs: the publish landed but the SERVED selection is not the canonical row (fixable 'missing') -> FAILED_READBACK 'served-row-differs'; the verify scan reports STALE 'served-row-differs'; the job is NEVER verified (readback-mismatch retry, hand-off failed)", u.s === "FAILED_READBACK" && u.r === "served-row-differs" && v.s === "STALE" && v.r === "served-row-differs" && j.status === "pending" && j.last_class === CLS.CLASSES.READBACK_MISMATCH && stateOf(rig.store, "returns-v3", "IN1").handoff === "failed" && w.n.liveWrite === 2);
  w.serveLag = null;
  await drain(rig);
  ok("S11a once the served selection returns the canonical row the retry verifies (served proof) without a second write", jobsOf(rig.store).every((x) => x.status === "verified") && w.n.liveWrite === 2 && stateOf(rig.store, "returns-v3", "IN1").served_confirmed === true);
  // (b) served-row-preempted: right after the route's CAS a foreign v3 row (an older { to }) becomes the latest served row.
  const wb = makeWorld(); const rb = makeRig(wb, { liveRoutes: ["returns-v3"] });
  await rb.worker.watermarkPass();
  wb.faults.push({ point: "publish:after-cas", action: "call", once: true, when: (i) => i.live, fn: async () => { wb.legacyUpsert({ reportKey: "returns-leakage", accountId: "IN1", paramsHash: paramsHashFor("returns-leakage-v3", { to: "2026-09-21" }), params: { reportVersion: "returns-leakage-v3", to: "2026-09-21" }, payload: returnsPayload("IN1", "2026-09-21", "2026-09-21", 9), sourceRefreshedAt: wb.iso(wb.now()) }); } });
  await rb.worker.processOneBatch();
  const ub = targetOf(lastRun(wb, "returns-v3", "live"), "IN1").units[0];
  const jb = jobsOf(rb.store).find((x) => x.target_key === "IN1");
  ok("S11b served-row-preempted: another identity holds the served slot (not fixable 'other-identity') -> typed served-row-preempted (deferred 3600 s + alert, hand-off deferred), never verified, never re-published in a loop", ub.s === "DEFERRED_DEPENDENCY" && ub.r === "served-row-preempted:other-identity" && jb.status === "deferred" && jb.last_class === CLS.CLASSES.SERVED_ROW_PREEMPTED && /served-row-preempted/.test(S(jb.last_alert)) && jb.next_attempt_at - wb.now() >= 3500 * 1000 && stateOf(rb.store, "returns-v3", "IN1").handoff === "deferred");
  // (c) C3 version-hidden (fba-plan): a newer row of ANOTHER version is the ONE latest row -> it hides the route's row.
  const wc = makeWorld(); const rc = makeRig(wc, { liveRoutes: ["fba-plan"] });
  await rc.worker.watermarkPass();
  wc.faults.push({ point: "publish:after-cas", action: "call", once: true, when: (i) => i.live, fn: async () => { wc.legacyUpsert({ reportKey: "fba-plan", accountId: "IN1", paramsHash: paramsHashFor("fba-plan-shared-v0", { to: EPOCH }), params: { reportVersion: "fba-plan-shared-v0", to: EPOCH }, payload: { rows: [{ legacy: true }] }, sourceRefreshedAt: wc.iso(wc.now()) }); } });
  await rc.worker.processOneBatch();
  const uc = targetOf(lastRun(wc, "fba-plan", "live"), "IN1").units[0];
  const vc = targetOf(lastRun(wc, "fba-plan", "verify"), "IN1").units[0];
  ok("S11c C3 VERSION-HIDDEN: the canonical fba-plan row is live but a newer row of another version is the single latest row -> the page shows nothing -> 'served-row-preempted:version-hidden' (live + verify), typed deferral + alert, never verified", uc.r === "served-row-preempted:version-hidden" && vc.r === "served-row-preempted:version-hidden" && jobsOf(rc.store).find((x) => x.target_key === "IN1").last_class === CLS.CLASSES.SERVED_ROW_PREEMPTED && wc.row("fba-plan", "IN1", paramsHashFor("fba-plan-shared-v1", { to: EPOCH })) !== null);
  // (d) an fba-plan EXACT-TODAY row (a paid refresh at the browser's { to: today }) holds the served slot. The fixture
  // runtime has no fba-plan currentPredicate, so the generic contract applies (the real route defers earlier, before any
  // write, 'served-row-preempted:exact-today-row').
  const exactToday = (w, stamp, sha) => seedRow(w, "fba-plan", "IN1", paramsHashFor("fba-plan-shared-v1", { to: IN_TODAY }), { reportVersion: "fba-plan-shared-v1", to: IN_TODAY }, fbaPlanPayload({ accountId: "IN1", salesAsOf: IN_TODAY, inventoryAsOf: EPOCH, fbaSha: sha, country: "IN" }), stamp);
  // d1: the exact-today paid row is NEWER than the route's evidence instant -> the 'evidence' stamp policy refuses it.
  const wd = makeWorld(); const rd = makeRig(wd, { liveRoutes: ["fba-plan"] });
  exactToday(wd, "2026-09-24T09:00:00.000Z", "paid-refresh");
  await rd.worker.watermarkPass(); await rd.worker.processOneBatch();
  const ud = targetOf(lastRun(wd, "fba-plan", "live"), "IN1").units[0];
  const jd = jobsOf(rd.store).find((x) => x.target_key === "IN1");
  ok("S11d an fba-plan EXACT-TODAY paid row fresher than the route's evidence instant is what the page serves: the prepare refuses 'evidence-not-newer-than-served' (superseded-newer-live) with ZERO writes for that account -- the paid row is never overwritten; the other account verifies", ud.s === "DEFERRED_DEPENDENCY" && ud.r === "evidence-not-newer-than-served" && jd.last_class === CLS.CLASSES.SUPERSEDED_NEWER_LIVE && wd.row("fba-plan", "IN1", paramsHashFor("fba-plan-shared-v1", { to: EPOCH })) === null && jobsOf(rd.store).find((x) => x.target_key === "IN2").status === "verified");
  // d2: an OLDER exact-today row (stamped before the evidence instant) -> the route writes its D-1 row, but the page still
  // serves the EXACT browser-today identity -> not fixable 'exact-identity-row'.
  const wd2 = makeWorld(); const rd2 = makeRig(wd2, { liveRoutes: ["fba-plan"] });
  exactToday(wd2, "2026-09-24T01:00:00.000Z", "paid-refresh-early");
  await rd2.worker.watermarkPass(); await rd2.worker.processOneBatch();
  const ud2 = targetOf(lastRun(wd2, "fba-plan", "live"), "IN1").units[0];
  const jd2 = jobsOf(rd2.store).find((x) => x.target_key === "IN1");
  ok("S11d' an OLDER exact-today row still holds the served slot (the serve reads the browser's EXACT { to: today } first): the route's D-1 row is written but 'served-row-preempted:exact-identity-row' -> typed deferral + alert (served-row-preempted), never verified", ud2.r === "served-row-preempted:exact-identity-row" && jd2.last_class === CLS.CLASSES.SERVED_ROW_PREEMPTED && /served-row-preempted/.test(S(jd2.last_alert)) && wd2.row("fba-plan", "IN1", paramsHashFor("fba-plan-shared-v1", { to: EPOCH })) !== null && (stateOf(rd2.store, "fba-plan", "IN1") || {}).verified_token == null);
  // (e) stampPolicy 'evidence' (fba-plan): a strictly NEWER paid row at the same identity -> superseded, zero writes.
  const we = makeWorld(); const re = makeRig(we, { liveRoutes: ["fba-plan"] });
  seedRow(we, "fba-plan", "IN1", paramsHashFor("fba-plan-shared-v1", { to: EPOCH }), { reportVersion: "fba-plan-shared-v1", to: EPOCH }, fbaPlanPayload({ accountId: "IN1", salesAsOf: EPOCH, inventoryAsOf: EPOCH, fbaSha: "paid-newer", country: "IN" }), "2026-09-24T03:00:00.000Z");
  await re.worker.watermarkPass(); await re.worker.processOneBatch();
  const je = jobsOf(re.store).find((x) => x.target_key === "IN1");
  const ue = targetOf(lastRun(we, "fba-plan", "live"), "IN1").units[0];
  ok("S11e a paid fba-plan row NEWER than the route's evidence instant is never overwritten: 'evidence-not-newer-than-live' -> superseded-newer-live, the paid row byte-identical", ue.r === "evidence-not-newer-than-live" && je.last_class === CLS.CLASSES.SUPERSEDED_NEWER_LIVE && we.row("fba-plan", "IN1", paramsHashFor("fba-plan-shared-v1", { to: EPOCH })).payload.fbaSha === "paid-newer");
}

// =====================================================================================================================
// P1. OLD / NEW WRITER OVERLAP IS IMPOSSIBLE UNDER THE FENCE (WP15): before the flip an in-flight legacy writer lands (and
//     beats the route's newer-stamp CAS -- why the flip is required); after the ONE fence UPDATE the same legacy write is
//     refused with the exact RWF01 shape, classified 'writer-fenced', the live row LKG; the route's fenced CAS still works.
// =====================================================================================================================
{
  const w = makeWorld(); const rig = makeRig(w, { liveRoutes: ["returns-v3", "oli"] });
  await rig.worker.watermarkPass(); await drain(rig);
  const liveHash = paramsHashFor("returns-leakage-v3", { to: "2026-09-22" });
  const routeRow = J(w.row("returns-leakage", "IN1", liveHash));
  const legacyWrite = () => { try { return { ok: w.legacyUpsert({ reportKey: "returns-leakage", accountId: "IN1", paramsHash: liveHash, params: { reportVersion: "returns-leakage-v3", to: "2026-09-22" }, payload: returnsPayload("IN1", EPOCH, "2026-09-22", 0), sourceRefreshedAt: w.iso(w.now()) }) }; } catch (error) { return { error }; } };
  // BEFORE the flip: the old job's unfenced write lands over the route's row.
  w.tick(10 * 60 * 1000);
  const b = legacyWrite();
  ok("P1a BEFORE the flip (fenced_only=false) an in-flight LEGACY writer's unfenced upsert LANDS over the route-owned live row (overlap)", b.ok && b.ok.outcome === "replaced" && J(w.row("returns-leakage", "IN1", liveHash)) !== routeRow && w.row("returns-leakage", "IN1", liveHash).payload.rows[0].refunds === 0);
  w.tick(11 * 60 * 1000);
  await rig.worker.tier1Scan();
  const recheck = jobsOf(rig.store, "returns-v3").find((j) => j.origin === "scan" && j.target_key === "IN1");
  await drain(rig);
  const rj = rig.store.jobs.find((j) => j.id === (recheck && recheck.id));
  ok("P1b ... the worker detects the foreign served-row write (tier-1) and re-checks, but its republish is refused by the legacy row's NEWER stamp and cannot be proven current -> superseded: the legacy content keeps the page (why the flip is REQUIRED)", recheck && rj.last_class === CLS.CLASSES.SUPERSEDED_NEWER_LIVE && w.row("returns-leakage", "IN1", liveHash).payload.rows[0].refunds === 0);
  // THE FLIP (one approved UPDATE; instant for every connection).
  w.fence.set("returns-leakage", true); w.fence.set("brand-sales", true);
  const lkg = J(w.row("returns-leakage", "IN1", liveHash));
  w.tick(60 * 1000);
  const a = legacyWrite();
  const c = FENCE.classifyReportWriterError(a.error);
  const ev = FENCE.writerFencedEvent({ error: a.error, writer: "report-materialization", accountId: "IN1" });
  ok("P1c AFTER the flip the SAME in-flight legacy write is REFUSED with the exact supabase.js RWF01 shape (status 400, code RWF01, 'Supabase request failed (400): REPORT_WRITER_FENCED:returns-leakage') and the live row is BYTE-IDENTICAL (LKG)", a.error && a.error.status === 400 && a.error.code === "RWF01" && a.error.message === "Supabase request failed (400): REPORT_WRITER_FENCED:returns-leakage" && J(w.row("returns-leakage", "IN1", liveHash)) === lkg);
  ok("P1d the REAL classifier types it 'writer-fenced' (key returns-leakage, RWF01, LKG preserved, never retryable) and writerFencedEvent emits the redacted event", c.fenced === true && c.event === "writer-fenced" && c.reportKey === "returns-leakage" && c.sqlstate === "RWF01" && c.lkgPreserved === true && c.retryable === false && ev && ev.event === "writer-fenced" && ev.reportKey === "returns-leakage" && ev.writer === "report-materialization" && ev.sqlstate === "RWF01");
  const w0 = w.n.fencedMarks;
  w.tick(10 * 60 * 1000); w.addReturn("IN1", "2026-09-22", w.iso(w.now() - 1000)); w.tick(10 * 60 * 1000);
  await rig.worker.watermarkPass(); await drain(rig);
  const now1 = w.row("returns-leakage", "IN1", liveHash);
  ok("P1e the ROUTE's fenced CAS succeeds under the flip (its transaction-local mark passes the trigger): new evidence publishes and verifies", now1.payload.rows[0].refunds === 4 && w.n.fencedMarks > w0 && jobsOf(rig.store, "returns-v3").filter((j) => j.origin === "watermark").every((j) => j.status === "verified"));
  // a legacy CHILD still carrying an unfenced writer (a reverted old job) -> refused; the worker surfaces 'writer-fenced'.
  w.legacyUnfencedWriter = true;
  const bsHash = legacyIdentity("brand-sales", EPOCH).hash;
  const bsBefore = J(w.row("brand-sales", "IN1", bsHash));
  w.tick(10 * 60 * 1000); w.bumpCoverage("IN1", w.iso(w.now() - 1000)); w.tick(2 * 60 * 1000);
  await rig.worker.watermarkPass();
  const oliJob = jobsOf(rig.store, "oli").find((j) => j.status === "pending" && j.target_key === "IN1");
  await rig.worker.processOneBatch();
  const oj = rig.store.jobs.find((j) => j.id === oliJob.id);
  const obs = [...rig.store.observations.values()].filter((o) => o.alert === "writer-fenced");
  ok("P1f a legacy CHILD still writing unfenced after the flip is refused (FAILED_PUBLISH REPORT_WRITER_FENCED:brand-sales): the brand-sales live row is LKG, the worker records the typed 'writer-fenced' observation + job alert, never verified", J(w.row("brand-sales", "IN1", bsHash)) === bsBefore && oj.status !== "verified" && /writer-fenced/.test(S(oj.last_alert)) && obs.some((o) => o.route_id === "oli" && /REPORT_WRITER_FENCED:brand-sales/.test(S(o.reason_code))) && rig.worker.stats.writerFenced > 0);
  w.tick(11 * 60 * 1000);
  await rig.worker.tier1Scan();
  const t1 = rig.store.scanRow.tier1Summary;
  ok("P1g the worker's tier-1 surfaces the fence PER KEY through the REAL readReportWriterFence (returns-leakage + brand-sales fenced, the rest open) and the 'writer-fenced' alert", t1.fence.state === "ok" && t1.fence.perKey["returns-leakage"] === "fenced" && t1.fence.perKey["brand-sales"] === "fenced" && t1.fence.perKey["fba-plan"] === "open" && t1.fence.allSeededFenced === false && t1.alerts.some((x) => x.code === "writer-fenced"));
}

// =====================================================================================================================
// P2. A Listing Health v3 REFUSED shadow counts already-current ONLY with content identity + lineage + live read-back all
//     matching (the REAL WP16 proof: buildListingHealthV3AlreadyCurrentProof + runListingHealthV3Ingestion).
// =====================================================================================================================
{
  const LHV = await import("../lib/server/sync/listing-health-v3-operation.js");
  const { readListingHealthV3Authorization } = await import("../lib/server/sync/listing-health-v3-authorization.js");
  const { buildLiveReadback } = await import("../lib/server/sync/source-priority-release-runner.js");
  const { deriveReportSnapshot } = await import("../lib/server/sync/report-derivation.js");
  const LREGION = "us-ca"; const CYCLE = "2026-09-24";
  const lconns = [{ id: "primary", apiKey: "fixture-key", accountPrefix: "" }];
  const LACCTS = ["acct-00", "acct-01"];
  const usAccounts = LACCTS.map((id, i) => ({ accountId: id, country: "US", currency: "USD", name: `A${i}` }));
  const BASE = "11111111-1111-4111-8111-111111111111"; const PP = "22222222-2222-4222-8222-222222222222";
  const STAMP = "2026-09-24T07:14:00+00:00";
  const LC = LIVE["listing-health-v3"]; const SHV = REPORT_DERIVATIONS["listing-health-v3"].snapshotVersion;
  const listingRow = (seller, sku, price) => ({ seller_or_vendor_id: seller, marketplace_country_code: "US", sku, child_asin: `ASIN-${sku}`, listing_name: `L ${sku}`, listing_status: "Active", listing_price_value: price, listing_price_currency: "USD", listing_current_quantity: 0, fba_quantity_available: 0, listing_fulfillment_channel: "AMAZON_NA", listing_open_date: "2024-01-01" });
  const rawRow = (seller, sku, price) => ({ seller_or_vendor_id: seller, marketplace_country_code: "US", sku, child_asin: `ASIN-${sku}`, summaries: J({ status: ["BUYABLE"] }), issues: J([]), offers: J([{ price: { amount: price } }]) });
  const noDate = (rk, rows, seller) => ({ available: true, rows, fragments: [{ requestKey: rk, from: null, to: null, sellerOrVendorIds: [seller], rows }], disabled: false, disabledPolicy: null, reason: null });
  const derivePayload = (acct) => { const r = deriveReportSnapshot({ reportKey: "listing-health-v3", sources: { "listing-health-v3:listings": noDate("listing-health-v3:listings", [listingRow(acct, "A", 25)], acct), "listing-health-v3:listings-raw": noDate("listing-health-v3:listings-raw", [rawRow(acct, "A", 25)], acct), "listing-health-v3:inventory": { available: false } }, context: { to: CYCLE, inventoryAsOf: CYCLE, accountId: acct, rawSellerId: acct, marketCountry: "US", listingHealthV3DurableOli: { available: true, rows: [{ account_id: acct, sale_date: "2026-09-20", sku: "A", child_asin: "ASIN-A", currency: "USD", sales_amount: 10, ordered_units: 1, unpriced_units: 0 }], coverageWindows: [{ from: "2024-01-01", to: CYCLE }], completenessRows: [] }, listingHealthV3DurableCatalog: { available: true, rows: [{ child_asin: "ASIN-A", product_name: "P A", product_brand: "BrandX" }] } } }); assert.equal(r.status, "derived"); return r.payload; };
  function lhWorld(over = {}) {
    const snapshots = new Map(); const put = (row) => snapshots.set(`${row.report_key}|${row.account_id}|${row.params_hash}`, row);
    const bundles = new Map(); const jobs = new Map();
    for (const acct of LACCTS) {
      const o = over[acct] || {};
      const payload = derivePayload(acct);
      const sp = { reportVersion: SHV, accountId: acct, to: CYCLE }; const sh = paramsHashFor(SHV, sp);
      put({ id: "s-" + acct, report_key: "scheduler-v2/listing-health-v3", account_id: acct, params_hash: sh, params: sp, payload: clone(payload), payload_storage_path: null, source_refreshed_at: STAMP, updated_at: STAMP });
      const lp = LC.liveParams({ to: CYCLE }); const lh = paramsHashFor(LC.liveReportVersion, lp);
      put({ id: "l-" + acct, report_key: LC.liveReportKey, account_id: acct, params_hash: lh, params: { reportVersion: LC.liveReportVersion, ...lp }, payload: o.livePayload ? o.livePayload(clone(payload)) : clone(payload), payload_storage_path: null, source_refreshed_at: o.liveStamp || STAMP, updated_at: o.liveStamp || STAMP });
      bundles.set(acct, o.bundle || { eligible: true, status: "available", revisionId: "rev-" + acct, deps: [], contentDeps: ["manifest-" + acct], bundle: { listingsSnapshot: { payload_sha: "sha-l-" + acct }, rawSnapshot: { payload_sha: "sha-r-" + acct } } });
      jobs.set(acct, { id: "job-" + acct, cycleId: PP, reportKey: "listing-health-v3", accountId: acct, deriveStatus: "succeeded", saveStatus: "succeeded", validated: true, cycleStatus: "succeeded", snapshotParamsHash: sh, dependsOn: ["req-l-" + acct, "req-r-" + acct], durableContentDeps: ["manifest-" + acct], ...(o.job || {}) });
    }
    const getReportSnapshot = async ({ reportKey, accountId, paramsHash }) => snapshots.get(`${reportKey}|${accountId}|${paramsHash}`) || null;
    const loadStoragePayload = async () => null;
    const readback = buildLiveReadback({ getReportSnapshot, loadStoragePayload, liveContracts: LIVE, reportDerivations: REPORT_DERIVATIONS, computeHash: paramsHashFor });
    const serveEnv = over.serveEnv || { LHV3_PUBLISH_LIVE: "true", LISTING_HEALTH_V3: "true" };
    const nowMs = Date.parse(CYCLE + "T12:00:00.000Z") + 86400000;
    const prove = LHV.buildListingHealthV3AlreadyCurrentProof({
      resolveBundle: async ({ accountId }) => bundles.get(accountId),
      readPublicationJob: async ({ accountId, excludeCycleId }) => { const j = jobs.get(accountId); return j && j.cycleId !== excludeCycleId ? j : null; },
      readSnapshot: getReportSnapshot, loadStoragePayload, verifyLiveReadback: readback,
      selectServed: ({ accountId }) => SEL.selectLhv3({ accountId, env: serveEnv, now: () => nowMs, readers: { getReportSnapshot }, computeHash: paramsHashFor, contract: LC, prove: (row) => readback({ reportKey: "listing-health-v3", liveReportKey: LC.liveReportKey, accountId, paramsHash: row.params_hash }) }),
      liveContracts: LIVE, computeHash: paramsHashFor, reportDerivations: REPORT_DERIVATIONS,
    });
    return { prove };
  }
  const durableMat = () => ({ accounts: 2, aliasesWritten: 4, emptyAliases: 0, rejected: 0, skippedStale: 0, durableByAccount: Object.fromEntries(LACCTS.map((a) => [a, { "listing-health-v3:listings": { ack: "replaced", payloadSha: "sha-l-" + a }, "listing-health-v3:listings-raw": { ack: "replaced", payloadSha: "sha-r-" + a } }])) });
  const refusedRun = (world) => {
    const calls = { runSources: 0, materialize: 0, runReports: 0, finalizeCycle: 0 };
    return { calls, collab: {
      discoverAccounts: async () => usAccounts, buildPlan: (args) => LHV.buildListingHealthV3Plan(args),
      resolveCost: async () => ({ newExports: 2, reusedExports: 1, creates: 0, estimatedTokens: 0, inventoryAdoptable: true, anyInventoryAdoptable: true, inventoryAdoptableCount: 1, inventoryAdoptableByHash: {} }),
      checkBalance: async () => ({ usable: 1000 }), readAuthorization: async (x) => readListingHealthV3Authorization(x),
      freezeBudget: async () => ({ planFingerprint: "fp-test", maxCreates: 2, maxTokens: 4, hashes: [{ requestHash: "h1", tokenCost: 2 }, { requestHash: "h2", tokenCost: 2 }] }), readFrozenBudget: async () => null,
      runSources: async () => { calls.runSources += 1; return { drained: true, creates: 0, tokens: 0, inventoryCreated: false }; },
      materialize: async () => { calls.materialize += 1; return durableMat(); },
      runReports: async () => { calls.runReports += 1; return { succeeded: 1, blocked: 0, failed: 1, drained: true }; },
      finalizeCycle: async () => { calls.finalizeCycle += 1; return { disposition: "finalized", status: "partial", cycleId: BASE }; },
      log: () => {},
      readBaseCycle: async () => ({ id: BASE, status: "running" }),
      readCycleJobs: async () => ({ cycleId: BASE, status: "partial", reportJobs: [{ report_key: "listing-health-v3", account_id: "acct-00", fetch_status: "ready", derive_status: "succeeded", save_status: "succeeded", error_stage: null, error_code: null }, { report_key: "listing-health-v3", account_id: "acct-01", fetch_status: "ready", derive_status: "succeeded", save_status: "failed", error_stage: "save", error_code: "SNAPSHOT_SAVE_FAILED" }], sourceJobs: [{ request_hash: "h1", fetch_status: "succeeded" }, { request_hash: "h2", fetch_status: "succeeded" }] }),
      proveAlreadyCurrent: world.prove,
    } };
  };
  const ingest = (c) => LHV.runListingHealthV3Ingestion({ region: LREGION, cycleDate: CYCLE, connections: lconns, authorized: true, mode: "live", gate: { enabled: true }, ...c.collab });
  const proofArgs = { accountId: "acct-01", country: "US", requestedAsOf: CYCLE, excludeCycleId: BASE };
  const good = await lhWorld().prove(proofArgs);
  const content = await lhWorld({ "acct-01": { bundle: { eligible: true, status: "available", revisionId: "rev-x", deps: [], contentDeps: ["manifest-DIFFERENT"], bundle: {} } } }).prove(proofArgs);
  const lineage = await lhWorld({ "acct-01": { job: { cycleStatus: "running" } } }).prove(proofArgs);
  const readback = await lhWorld({ "acct-01": { livePayload: (p) => ({ ...p, rows: [] }) } }).prove(proofArgs);
  const served = await lhWorld({ serveEnv: { LHV3_PUBLISH_LIVE: "true" } }).prove(proofArgs);
  const stampOnly = await lhWorld({ "acct-01": { liveStamp: "2026-09-25T00:16:00+00:00" } }).prove(proofArgs);
  ok("P2a the REAL WP16 proof: content identity + lineage + live/served read-back ALL matching -> already-current (check null)", good.ok === true && good.check === null && J(LHV.LHV3_ALREADY_CURRENT_CHECKS) === J(["content", "lineage", "readback"]));
  ok("P2b each SINGLE mismatch is a real failure: content (a different manifest), lineage (the job's cycle not terminal), readback (live payload differs; the served selector returns nothing with a serve flag off); a newer live STAMP alone never proves currency", content.ok === false && content.check === "content" && lineage.ok === false && lineage.check === "lineage" && readback.ok === false && readback.check === "readback" && served.ok === false && served.check === "readback" && stampOnly.ok === false && stampOnly.check === "readback");
  const r1 = await ingest(refusedRun(lhWorld()));
  ok("P2c the natural ingestion's REFUSED shadow (SNAPSHOT_SAVE_FAILED) counts already-current with all three matching -> the run succeeds (alreadyCurrent 1, refusedReal 0)", r1.ok === true && r1.alreadyCurrent === 1 && r1.refusedReal === 0);
  const r2 = await ingest(refusedRun(lhWorld({ "acct-01": { job: { durableContentDeps: ["manifest-acct-01-OLDER"] } } })));
  const r3 = await ingest(refusedRun(lhWorld({ "acct-01": { job: { validated: false } } })));
  const r4 = await ingest(refusedRun(lhWorld({ "acct-01": { livePayload: (p) => ({ ...p, rows: [] }) } })));
  ok("P2d ... and each single mismatch makes the refused shadow a REAL failure typed by the check: shadow-refused:content | :lineage | :readback (ok:false, refusedReal 1, never counted published)", r2.ok === false && r2.refusals[0].reason === "shadow-refused:content" && r3.ok === false && r3.refusals[0].reason === "shadow-refused:lineage" && r4.ok === false && r4.refusals[0].reason === "shadow-refused:readback" && [r2, r3, r4].every((r) => r.refusedReal === 1 && r.alreadyCurrent === 0));
}

// =====================================================================================================================
// P3. refresh=1 is READ-ONLY for all 10 route-owned keys (zero DataDoe, zero report_snapshots write) while the explicit
//     PAID sync stays available (admin Data Sync Center preview -> estimate + signed confirmation token; a member cannot).
// =====================================================================================================================
{
  const PACC = "ACCTIN0001"; const PAS = "2026-09-25";
  const p3 = { gets: [], writes: [], datadoe: [] };
  const row = (reportKey, payload, params = {}) => ({ id: "row-" + reportKey, report_key: reportKey, account_id: PACC, params_hash: "seeded", params: { ...params }, payload, payload_bytes: 100, payload_storage_path: null, source_refreshed_at: "2026-09-25T01:00:00.000Z", updated_at: "2026-09-25T01:00:01.000Z", created_at: "2026-09-25T01:00:01.000Z" });
  const SEED = {
    "account-directory": row("account-directory", { accounts: [{ id: PACC, name: "Acct IN", country: "IN", currency: "INR", active: true }] }, { reportVersion: "account-directory-shared-v1" }),
    "brand-sales": row("brand-sales", { rows: [{ date: "2026-09-24", child_asin: "B0A", brand: "Acme", product_brand: "Acme", marketplace_country_code: "IN", total_sales: 10, total_units: 1, total_units_sold: 1, currency: "INR" }], catalogBrands: ["Acme"], asinBrand: { B0A: "Acme" } }, { reportVersion: "brand-sales-shared-v1", from: "2025-08-01", to: PAS }),
    "daily-reporting": row("daily-reporting", { rows: [{ date: "2026-09-24", total_sales: 10 }], brandFiltered: false }, { reportVersion: "daily-reporting-shared-v2", from: "2026-04-01", to: PAS, brand: "ALL" }),
    "brand-inventory": row("brand-inventory", { accountId: PACC, inventoryDate: "2026-09-24", inventoryAvailable: true, inventoryByBrandCountry: [] }, { reportVersion: "brand-inventory-shared-v1", to: PAS }),
    "fba-plan": row("fba-plan", { asOf: PAS, rows: [], inventoryAvailable: true }, { reportVersion: "fba-plan-shared-v1", to: PAS }),
    "sku-movement": row("sku-movement", { rows: [], effectiveAsOf: "2026-09-24" }, { reportVersion: "sku-movement/v2", asOf: "2026-09-24", brand: "ALL" }),
    "returns-leakage": row("returns-leakage", { rows: [], window: { days: 90 } }, { reportVersion: "returns-leakage-v3", to: PAS }),
    "brand-view-brands": row("brand-view-brands", { accountId: PACC, brands: ["Acme"], sources: [], message: null }, { reportVersion: "brand-view-brands-v1", accountId: PACC }),
    "brand-view": row("brand-view", { rows: [], countries: [], coverage: {} }, { reportVersion: "x", brand: "Acme", asOf: PAS }),
    "brand-view-portfolio": row("brand-view-portfolio", { rows: [], countries: [], coverage: {} }, { reportVersion: "x", brand: "Acme", asOf: PAS }),
    "listing-health-v3": row("listing-health-v3", { rows: [] }, { reportVersion: "x", to: "2026-09-24" }),
  };
  const READ_ONLY_RPCS = new Set(["/rest/v1/rpc/resolve_oli_sku_asin"]);
  const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
  // The serve logs structured JSON events to the console; they are captured (not printed) while P3 runs.
  const consoleSaved = { log: console.log, info: console.info, warn: console.warn };
  const captured = [];
  console.log = (...x) => captured.push(x.join(" ")); console.info = console.log; console.warn = console.log;
  net.p3 = async (u, opts = {}) => {
    const method = String(opts.method || "GET").toUpperCase();
    if (!u.startsWith("http://supabase.test")) { p3.datadoe.push(method + " " + u); throw new Error("DATADOE_CALL_REFUSED_BY_TEST"); }
    const p = u.slice("http://supabase.test".length);
    if (p.startsWith("/auth/v1/user")) { const tok = String((opts.headers && (opts.headers.Authorization || opts.headers.authorization)) || "").replace(/^Bearer /, ""); return tok === "tok-admin" ? jsonRes(200, { id: "u-admin", email: "a@x" }) : tok === "tok-member" ? jsonRes(200, { id: "u-member", email: "m@x" }) : jsonRes(401, { msg: "no" }); }
    if (method === "POST" && READ_ONLY_RPCS.has(p.split("?")[0])) { p3.gets.push(p); return jsonRes(200, []); }
    if (method !== "GET") { p3.writes.push(method + " " + p.split("?")[0]); return jsonRes(200, []); }
    p3.gets.push(p.split("?")[0]);
    const q = new URLSearchParams(p.split("?")[1] || "");
    if (p.startsWith("/rest/v1/user_profiles")) return jsonRes(200, [{ role: /u-admin/.test(q.get("user_id")) ? "admin" : "member", display_name: "t" }]);
    if (p.startsWith("/rest/v1/account_permissions")) return jsonRes(200, /u-member/.test(q.get("user_id")) ? [{ account_id: PACC, brand_scope_mode: "ALL_BRANDS" }] : []);
    if (p.startsWith("/rest/v1/report_snapshots")) { const k = (q.get("report_key") || "").replace(/^eq\./, ""); return jsonRes(200, SEED[k] ? [SEED[k]] : []); }
    return jsonRes(200, []);
  };
  try {
    const RS = await import("../lib/server/report-store.js");
    const DD = await import("../api/datadoe.js");
    const SRC = await import("../api/admin/sources.js");
    const fakeRes = () => ({ statusCode: null, body: null, status(cd) { this.statusCode = cd; return this; }, json(bd) { this.body = bd; return this; }, setHeader() {} });
    const REQS = {
      "brand-sales": { action: "brand-sales", ids: PACC, from: "2025-08-01", to: PAS }, "daily-reporting": { action: "daily", ids: PACC, from: "2026-04-01", to: PAS, brand: "ALL" },
      "brand-inventory": { action: "brand-inventory", ids: PACC, to: PAS }, "listing-health-v3": { action: "listing-health-v3", ids: PACC, to: PAS },
      "fba-plan": { action: "fba-plan", ids: PACC, to: PAS }, "sku-movement": { action: "sku-movement", ids: PACC, to: PAS, brand: "ALL" },
      "returns-leakage": { action: "returns-leakage", ids: PACC, to: PAS }, "brand-view": { action: "brand-view", ids: PACC, brand: "Acme", asOf: PAS },
      "brand-view-portfolio": { action: "brand-view-portfolio", ids: PACC, brand: "Acme", asOf: PAS }, "brand-view-brands": { action: "brand-view-brands", ids: PACC },
    };
    ok("P3a the refresh contract covers EXACTLY the 10 route-owned keys == the report-store set == the DB writer-fence seed", J(Object.keys(REQS).sort()) === J([...RS.ROUTE_OWNED_LIVE_REPORT_KEYS].sort()) && J([...RS.ROUTE_OWNED_LIVE_REPORT_KEYS].sort()) === J([...FENCE.FENCED_WRITER_REPORT_KEYS].sort()));
    let allReadOnly = true; const failures = [];
    for (const [key, q] of Object.entries(REQS)) for (const who of ["admin", "member"]) {
      const res = fakeRes(); const d0 = p3.datadoe.length; const w0 = p3.writes.length;
      await DD.default({ method: "GET", query: { ...q, refresh: "1" }, headers: { authorization: "Bearer tok-" + who } }, res);
      const b = res.body || {};
      const good = res.statusCode === 200 && p3.datadoe.length === d0 && p3.writes.length === w0 && b.refreshReadOnly === true && b.paidSync && b.paidSync.available === (who === "admin") && typeof b.paidSync.how === "string";
      if (!good) { allReadOnly = false; failures.push(key + "/" + who + ":" + res.statusCode); }
    }
    ok("P3b refresh=1 through the REAL api/datadoe.js handler, for ALL 10 route-owned keys x admin/member: HTTP 200, ZERO DataDoe requests, ZERO report_snapshots / lock / RPC writes, refreshReadOnly:true + paidSync { available only for an admin, how }" + (failures.length ? " FAILURES " + failures.join(",") : ""), allReadOnly);
    let refused = true, noBuild = true;
    for (const key of RS.ROUTE_OWNED_LIVE_REPORT_KEYS) {
      let err = null; try { await RS.beginSharedRefresh({ res: fakeRes(), reportKey: key, reportVersion: "v", accountId: PACC, params: { to: PAS }, userId: "u", label: key }); } catch (e) { err = e; }
      if (!(err && err.code === RS.ROUTE_OWNED_REPORT_READ_ONLY && err.status === 409)) refused = false;
      let builds = 0; const w0 = p3.writes.length;
      await RS.serveSharedReport({ res: fakeRes(), refresh: true, reportKey: key, reportVersion: "v", accountId: PACC, params: { to: PAS }, label: key, build: async () => { builds += 1; return { rows: [] }; } });
      if (builds !== 0 || p3.writes.length !== w0) noBuild = false;
    }
    ok("P3c the REAL report-store backstop: beginSharedRefresh refuses every route-owned key typed (409 ROUTE_OWNED_REPORT_READ_ONLY) and serveSharedReport({ refresh:true }) never builds or writes", refused && noBuild);
    // the paid sync (api/admin/sources.js, injected deps -- zero network)
    const NOWP = Date.UTC(2026, 8, 26, 3, 0); const TODAYP = "2026-09-26"; const ASOFP = "2026-09-25";
    const CONN = { id: "primary", apiKey: ["fx", "key"].join("-"), accountPrefix: "", organizationFingerprint: "org-fp" };
    const six = ["A1", "A2", "A3", "A4", "A5", "A6"];
    const paidDeps = (access) => {
      const calls = { runtimeBuilt: 0, audit: 0, preflight: 0 };
      const runtime = { makeDeadline: () => ({ deadlineMs: NOWP + 60000, reserveMs: 3000, outOfTime: () => false, isDeadlineError: () => false, ensureTime: async () => {}, bound: async (_l, fn) => fn(() => {}) }), preflightEvidence: async () => { calls.preflight += 1; throw Object.assign(new Error("REACHED_PREFLIGHT"), { code: "REACHED_PREFLIGHT" }); }, runSourceCardAction: async () => ({ refused: false, continuationRequired: true }), run: async () => ({ globalDrained: false, continuationRequired: true }), gatherDurableReadiness: async () => ({ unavailable: "test" }) };
      return { calls, deps: {
        getDashboardAccess: async () => access, assertAdmin: SB.assertAdmin,
        isAdsRegistryKeyRetired: () => false,
        insertAuditLog: async () => { calls.audit += 1; }, setSourceControl: async () => ({ ok: true }), getSourceControls: async () => ({ rows: [], read: "ok" }),
        getSourceRunStatuses: async () => ({ rows: [], read: "ok" }),
        getAccountDirectoryRows: async () => six.map((id) => ({ account_id: id, marketplace_country_code: "IN", sync_bucket: "non-us", name: id, currency: "INR" })),
        getAccountOliQualityCounts: async () => ({}), primaryOrganizationFingerprint: () => "org-fp",
        buildBucketSourceSyncRuntime: () => { calls.runtimeBuilt += 1; return runtime; },
        now: () => NOWP, getDataDoeConnections: () => [CONN], resolveDataDoeAccountIds: (ids) => ({ connection: CONN, accountIds: ids, rawAccountIds: ids }),
        getSourceCoverageWindows: async () => ({ read: "ok", windows: [{ from: "2025-01-01", to: ASOFP }] }),
        getSourceSnapshot: async ({ sourceKey }) => ({ read: "ok", snapshot: sourceKey === "product-catalog" ? { validated_at: TODAYP + "T01:00:00.000Z", object_path: "p", row_count: 1 } : null }),
        listSourceBatchMembership: async () => [], getSourceTrancheBudget: async () => null, getSourceExportCacheMeta: async () => null, getSourceExportCache: async () => null,
        getRecentSyncCycleIds: async () => [], getSyncSourceJobsWithMeta: async () => [], getSyncSourceJobOwnersForCycle: async () => [],
        getSyncCycleByBucketDate: async () => null, getSyncSourceJobs: async () => [], getPriorityCatalogReservation: async () => null,
        getDailyAdsCoverage: async () => ({ read: "ok", windows: [], status: "missing" }),
        runCampaignAdsBucketSlice: async () => ({ phase: "sync", continuationRequired: true, creates: 0, tokens: 0 }),
        claimPaidSyncReceipt: async () => ({ claimed: true }),
      } };
    };
    const post = async (env, body) => { const r = fakeRes(); await SRC.handler({ method: "POST", body }, r, env.deps); return r; };
    const member = paidDeps({ userId: "u-member-p3", role: "member" });
    const rm = await post(member, { bucket: "non-us", sourceKey: "order-line-items", preview: true });
    ok("P3d a MEMBER can neither preview nor run the paid sync: the REAL assertAdmin refuses 403 before any read / runtime / audit", rm.statusCode === 403 && member.calls.runtimeBuilt === 0 && member.calls.audit === 0);
    const admin = paidDeps({ userId: "u-admin-p3", role: "admin" });
    const rp = await post(admin, { bucket: "non-us", sourceKey: "order-line-items", preview: true });
    const pv = rp.body && rp.body.preview;
    const claims = pv ? RS.verifyPaidSyncConfirmation(pv.confirmationToken, { userId: "u-admin-p3", bucket: "non-us", sourceKey: "order-line-items", refreshMode: "normal", now: NOWP }) : null;
    ok("P3e the ADMIN preview returns the token ESTIMATE (expected / worst case / approved ceiling, > 0) and a SIGNED confirmation token bound to this admin + card + as-of (REAL verifyPaidSyncConfirmation), with ZERO runtime / audit / DataDoe", rp.statusCode === 200 && pv && pv.estimate && pv.estimate.worstCaseTokens > 0 && pv.approvedMaxTokens >= pv.estimate.expectedTokens && typeof pv.confirmationToken === "string" && claims && claims.ok === true && claims.asOf === ASOFP && claims.approvedMaxTokens === pv.approvedMaxTokens && admin.calls.runtimeBuilt === 0 && admin.calls.audit === 0);
    const r428 = await post(admin, { bucket: "non-us", sourceKey: "order-line-items" });
    const rgo = await post(admin, { bucket: "non-us", sourceKey: "order-line-items", confirmationToken: pv.confirmationToken });
    ok("P3f the explicit PAID sync stays AVAILABLE: without the confirmation it fails closed 428 (estimate, NO token, nothing spent); WITH the preview's token the existing execute path runs (runtime built, evidence preflight reached)", r428.statusCode === 428 && r428.body.error === "PAID_SYNC_CONFIRMATION_REQUIRED" && r428.body.preview && r428.body.preview.confirmationToken === null && admin.calls.runtimeBuilt >= 1 && admin.calls.preflight === 1 && rgo.body && rgo.body.error === "REACHED_PREFLIGHT");
    ok("P3g the scoped Supabase emulator saw ZERO DataDoe requests and ZERO writes across P3", p3.datadoe.length === 0 && p3.writes.length === 0);
  } finally { net.p3 = null; Object.assign(console, consoleSaved); }
}

// =====================================================================================================================
ok("Z zero network: no fetch outside the scoped P3 emulator was ever attempted (zero DataDoe / Supabase / network)", net.calls.length === 0);
if (observations.length) out("  (" + observations.length + " observation(s) recorded above -- see the DEFECT-REPRO notes)");
out(`publication-recovery-e2e: ${passed} passed`);
