// Publication recovery WP7 -- the fba-plan ZERO-EXPORT recovery route:
//   lib/server/recovery/routes/fba-plan.route.js   (worker side + the SHARED evidence SQL / L1 token compose)
//   lib/server/sync/fba-plan-dependency-bundle.js  (the durable dependency bundle)
//   lib/server/sync/routes/fba-plan.release.js     (CLI side: runtime hooks, content-equivalence verdict, guards)
// driven through the REAL generic route release (route-publication-release.js), the REAL saved-data reconciler two-phase
// core + route adapter, the REAL four-gate publisher composition (build-time overrides only) with a faithful fenced CAS,
// the REAL serve selector and the REAL fba-plan derive. Durable evidence is produced by the REAL writers from one batched
// source-cache fixture: fba-durable-source-persist.js (FBA inventory pointers) + listing-health-v3-materialize.js (the
// canonical Listings pointers, the SAME export fba-plan:awd resolves to) -- so the PARITY fixture compares the paid
// cache-fragment derive against the durable-bundle derive of the very same rows. Evidence SQL runs through a fake
// read-only pg that refuses anything but the route's declared read-only statements (+ the release's newest-foreign-job
// statement, answered from the lineage world). ZERO DataDoe / Supabase / network:
// the global fetch is a refusing stub and its call count is asserted 0. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

process.env.SUPABASE_URL = "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = ["test", "svc", "role", "key"].join("-");

// The network is NEVER reached: every fetch is recorded and refused.
const net = { calls: [] };
globalThis.fetch = async (url, opts = {}) => { net.calls.push(String(opts.method || "GET") + " " + String(url)); throw new Error("network refused in an offline test"); };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(path.join(ROOT, p), "utf8");

const W = await import("../lib/server/recovery/routes/fba-plan.route.js");
const FB = await import("../lib/server/sync/fba-plan-dependency-bundle.js");
const RELMOD = await import("../lib/server/sync/routes/fba-plan.release.js");
const REL = await import("../lib/server/sync/route-publication-release.js");
const RC = await import("../lib/server/recovery/route-contract.js");
const SEL = await import("../lib/server/recovery/serve-selectors.js");
const SDR = await import("../lib/server/sync/saved-data-reconciler.js");
const B = await import("../lib/server/sync/publication-binding.js");
const CP = await import("../lib/server/sync/source-priority-control-package.js");
const CLS = await import("../lib/server/recovery/classify.js");
const { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS: LC } = await import("../lib/server/sync/report-publisher.js");
const { REPORT_DERIVATIONS, deriveReportSnapshot } = await import("../lib/server/sync/report-derivation.js");
const { paramsHashFor } = await import("../lib/server/report-store.js");
const { buildSchedulerV2Publisher } = await import("../lib/server/sync/publisher-composition.js");
const { CONTROLLED_REPORT_KEYS } = await import("../lib/server/sync/report-controls.js");
const { resolvedFbaSnapshot, validateFbaSnapshotRows } = await import("../lib/server/sync/source-bucket-sync.js");
const { buildShadowReportPlan, planListingHealthV3BucketBatched } = await import("../lib/server/sync/report-planner.js");
const { assembleSources, buildDeriveContext } = await import("../lib/server/sync/report-worker.js");
const { makeFbaPlanDurableContextLoader } = await import("../lib/server/sync/fba-plan-durable-loader.js");
const { persistDurableFbaSnapshotsFromPlan } = await import("../lib/server/sync/fba-durable-source-persist.js");
const { materializeListingHealthV3PerAccount } = await import("../lib/server/sync/listing-health-v3-materialize.js");
const { resolveFbaPlanScope, fbaInventoryAsOf } = await import("../lib/server/sync/fba-plan-operation.js");
const { resolveDataDoeAccountIds } = await import("../lib/server/datadoe-connections.js");
const { accountInScope } = await import("../lib/server/sync/scheduler-scope.js");
const { normalizeMarketplace } = await import("../lib/server/sync/oli-sales-estimate.js");
const { organizationFingerprint } = await import("../lib/server/source-identity.js");
const { marketplaceToday } = await import("../lib/marketplaces.js");
const { sourceSnapshotObjectPath, sourceSnapshotPayloadSha } = await import("../lib/server/supabase.js");

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; out("  ok  " + name); };
const S = (v) => (v == null ? "" : String(v));
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

const ROUTE = RELMOD.default;
const RK = "fba-plan";
const RS = { NR: "PUBLICATION_NOT_REQUIRED", ST: "STALE", DP: "DEFERRED_PROVENANCE", DD: "DEFERRED_DEPENDENCY", RV: "READBACK_VERIFIED", FP: "FAILED_PUBLISH", FD: "FAILED_DERIVE" };
const API_KEY = "fixture-key";
const CONNS = Object.freeze([Object.freeze({ id: "primary", apiKey: API_KEY, label: "Primary", accountPrefix: "" })]);
const ORG = organizationFingerprint(API_KEY);
const NOW = Date.UTC(2026, 8, 25, 6, 0, 0); // 2026-09-25T06:00Z -> UTC D-1 = 2026-09-24
const INV = "2026-09-24"; // the epoch = inventoryAsOf (UTC D-1)
const SALES = "2026-09-24";
const PREV = "2026-09-23";
const TODAY = "2026-09-25"; // marketplaceToday(US|CA|GB|DE|IN) at NOW
const FBA_VALIDATED = "2026-09-24T09:00:00.000Z"; // the durable persist's validated_at (== the evidence instant)
const INV_FETCHED = "2026-09-24T08:30:00.000Z";   // the paid inventory batch cache fetched_at
const LST_FETCHED = "2026-09-24T08:40:00.000Z";   // the canonical Listings batch fetched_at (== the durable Listings validated_at)
const COV_REFRESHED = "2026-09-24T07:00:00.000Z";
const CAT_VALIDATED = "2026-09-23T12:00:00.000Z";

const ACCOUNTS = Object.freeze([
  { accountId: "USA1", country: "US", currency: "USD", name: "US One" },
  { accountId: "CAA1", country: "CA", currency: "CAD", name: "CA One" },
  { accountId: "UKA1", country: "UK", currency: "GBP", name: "UK One" },
  { accountId: "DEA1", country: "DE", currency: "EUR", name: "DE One" },
  { accountId: "INA1", country: "IN", currency: "INR", name: "IN One" },
]);
const directoryOf = (accounts) => new Map(accounts.map((a) => [a.accountId, { accountId: a.accountId, country: a.country, marketplace: normalizeMarketplace(a.country), rawSellerId: a.rawSellerId || a.accountId, name: a.name, currency: a.currency }]));

// ---- fixture rows (deterministic per seller) --------------------------------------------------------------------------
const invRow = (seller, mkt, i, date = INV) => ({ date, marketplace_country_code: mkt, seller_or_vendor_id: seller, child_asin: "B0" + seller + i, sku: "SKU-" + seller + "-" + i, fnsku: "FN" + seller + i, product_name: "Prod " + seller + i, available: 10 + i, reserved_customer_order: 1, reserved_fc_transfer: 2, reserved_fc_processing: 0, inbound_working: 0, inbound_shipped: 3, inbound_received: 1 });
const lstRow = (seller, mkt, i) => ({ seller_or_vendor_id: seller, marketplace_country_code: mkt, sku: "SKU-" + seller + "-" + i, child_asin: "B0" + seller + i, listing_name: "L" + i, listing_status: "ACTIVE", listing_price_value: 9.99, listing_price_currency: "X", listing_current_quantity: 5, fba_quantity_available: 10, listing_fulfillment_channel: "AMAZON", listing_open_date: "2025-01-01", fnsku: "FN" + seller + i, awd_available_distributable_quantity: 7 + i, awd_total_inbound_quantity: 2 });
const histRows = (acct) => ["2026-06-10", "2026-07-11", "2026-08-12", "2026-09-20", "2026-09-23"].flatMap((d, k) => [0, 1].map((i) => ({ account_id: acct, seller_or_vendor_id: acct, sale_date: d, sku: "SKU-" + acct + "-" + i, child_asin: "B0" + acct + i, currency: "USD", sales_amount: 10 + k, units: 1 + i + k, source_request_hash: "oli-" + acct })));
// The RICH parity shapes (opt-in, seedDurable({ rich })): an available:0 inventory row, a TWO-SKU ASIN (a second SKU of
// B0<seller>0), an AWD-ONLY ASIN (Listings/AWD only), an ASIN only in SALES, and a SAME-SELLER CROSS-MARKETPLACE
// Listings row (the seller's row for ANOTHER marketplace inside the shared canonical Listings batch).
const CROSS_MKT = { US: "CA", CA: "US", GB: "DE", DE: "FR", IN: "AE" };
const richInvRows = (seller, mkt, date) => [
  { ...invRow(seller, mkt, 2, date), available: 0 },
  { ...invRow(seller, mkt, 0, date), sku: "SKU-" + seller + "-0B", fnsku: "FN" + seller + "0B", available: 4, inbound_shipped: 1 },
];
const richLstRows = (seller, mkt) => [
  { ...lstRow(seller, mkt, 7), child_asin: "B0" + seller + "AWD", sku: "SKU-" + seller + "-AWD", fnsku: "FN" + seller + "AWD", fba_quantity_available: 0, awd_available_distributable_quantity: 40, awd_total_inbound_quantity: 5 },
  { ...lstRow(seller, CROSS_MKT[mkt] || "MX", 1), sku: "SKU-" + seller + "-X", awd_available_distributable_quantity: 99, awd_total_inbound_quantity: 9 },
];
const richHistRows = (acct) => ["2026-08-12", "2026-09-20"].map((d, k) => ({ account_id: acct, seller_or_vendor_id: acct, sale_date: d, sku: "SKU-" + acct + "-SO", child_asin: "B0" + acct + "SO", currency: "USD", sales_amount: 30 + k, units: 3 + k, source_request_hash: "oli-" + acct }));

// ---- the DURABLE world (source_snapshots / source_listings_snapshot / source_coverage / history / storage) -------------
function makeDurable() {
  return { fba: new Map(), listings: new Map(), coverage: [], catalog: null, storage: new Map(), history: [], n: { sql: 0, payload: 0, history: 0 }, failSql: false };
}
function storeRows(dw, { sourceKey, scopeKey, rows }) {
  const payloadSha = sourceSnapshotPayloadSha(rows);
  const objectPath = sourceSnapshotObjectPath({ organizationFingerprint: ORG, connectionId: "primary", sourceKey, scopeKey, payloadSha });
  dw.storage.set(objectPath, { rows: clone(rows) });
  return { objectPath, payloadSha, payloadBytes: JSON.stringify({ rows }).length };
}
// Replace one pointer's payload (content-addressed: new sha + path + row_count) -- a corrected / tampered durable save.
function rewritePointer(dw, kind, acct, rows, over = {}) {
  const sourceKey = kind === "fba" ? "fba-inventory-health" : "listings";
  const saved = storeRows(dw, { sourceKey, scopeKey: acct, rows });
  const map = kind === "fba" ? dw.fba : dw.listings;
  map.set(acct, { ...map.get(acct), object_path: saved.objectPath, payload_sha: saved.payloadSha, row_count: rows.length, ...over });
}

// Seed durable evidence for `accounts` through the REAL writers from ONE batched source-cache fixture.
async function seedDurable(dw, accounts, { fbaValidatedAt = FBA_VALIDATED, inventoryAsOf = INV, coveredTo = {}, rich = [] } = {}) {
  const fbaPlan = buildShadowReportPlan({ accounts, connections: CONNS, reportKeys: [RK], asOfFor: () => SALES, inventoryAsOf });
  const richSet = new Set(rich);
  const cache = new Map();
  for (const r of fbaPlan.reportRequests) for (const s of r.sources) {
    if (cache.has(s.requestHash)) continue;
    const inv = s.sourceKey === "fba-inventory-health";
    const rows = s.marketplacePairs.flatMap((p) => [
      ...[0, 1].map((i) => (inv ? invRow(p.sellerId, p.marketplace, i, inventoryAsOf) : lstRow(p.sellerId, p.marketplace, i))),
      ...(richSet.has(p.sellerId) ? (inv ? richInvRows(p.sellerId, p.marketplace, inventoryAsOf) : richLstRows(p.sellerId, p.marketplace)) : []),
    ]);
    cache.set(s.requestHash, { rows, fetched_at: inv ? INV_FETCHED : LST_FETCHED });
  }
  const save = async ({ sourceKey, scopeKey, rows }) => storeRows(dw, { sourceKey, scopeKey, rows });
  const persisted = await persistDurableFbaSnapshotsFromPlan({
    reportRequests: fbaPlan.reportRequests, includedIds: accounts.map((a) => a.accountId), inventoryAsOf, bucket: "fixture", apiKey: API_KEY,
    accountsById: new Map(accounts.map((a) => [a.accountId, { country: a.country }])),
    loadSourceExportCache: async (h) => cache.get(h) || null, saveSnapshotPayload: save,
    recordSnapshot: async (r) => { dw.fba.set(r.scopeKey, { organization_fingerprint: r.organizationFingerprint, connection_id: r.connectionId, source_key: r.sourceKey, scope_key: r.scopeKey, object_path: r.objectPath, payload_sha: r.payloadSha, row_count: r.rowCount, source_request_hash: r.sourceRequestHash, validated_at: new Date(r.validatedAt) }); return { write: "ok", ack: "replaced" }; },
    now: () => fbaValidatedAt,
  });
  const v3Plans = planListingHealthV3BucketBatched({ accounts, connections: CONNS, asOfFor: () => inventoryAsOf, inventoryAsOf });
  const mat = await materializeListingHealthV3PerAccount({
    plans: v3Plans, connections: CONNS, readSourceCache: async (h) => cache.get(h) || null, writeSourceCache: async () => {}, saveDurablePayload: save,
    recordDurableByKey: {
      "listing-health-v3:listings": async (r) => { dw.listings.set(r.accountId, { organization_fingerprint: r.organizationFingerprint, connection_id: r.connectionId, account_id: r.accountId, marketplace: r.marketplace, source_key: "listings", as_of: r.asOf, object_path: r.objectPath, payload_sha: r.payloadSha, row_count: r.rowCount, source_request_hash: r.sourceRequestHash, validated_at: new Date(r.validatedAt) }); return { ack: "replaced" }; },
      "listing-health-v3:listings-raw": async () => ({ ack: "replaced" }),
    },
  });
  for (const a of accounts) {
    dw.coverage.push({ organization_fingerprint: ORG, account_id: a.accountId, covered_from: "2025-01-01", covered_to: coveredTo[a.accountId] || SALES, source_refreshed_at: new Date(COV_REFRESHED) });
    dw.history.push(...histRows(a.accountId), ...(richSet.has(a.accountId) ? richHistRows(a.accountId) : []));
  }
  const catRows = accounts.flatMap((a) => [0, 1].map((i) => ({ child_asin: "B0" + a.accountId + i, parent_asin: "P" + a.accountId, product_name: "Cat " + a.accountId + i, product_brand: "Brand" + a.accountId })));
  const saved = storeRows(dw, { sourceKey: "product-catalog", scopeKey: "__organization", rows: catRows });
  dw.catalog = { organization_fingerprint: ORG, connection_id: "primary", source_key: "product-catalog", scope_key: "__organization", object_path: saved.objectPath, payload_sha: saved.payloadSha, row_count: catRows.length, source_request_hash: "cat-req", validated_at: new Date(CAT_VALIDATED) };
  return { fbaPlan, v3Plans, cache, persisted, mat };
}

// The READ-ONLY pg fake: it answers ONLY the route's declared evidence statements + the release's newest-foreign-job
// statement (by exact text) -- node-postgres shapes: timestamptz -> Date, ::text dates -> strings, integer row_count ->
// number. The foreign-job statement is answered from the lineage WORLD (w.jobs / w.cycles) with the SQL's semantics:
// the newest (created desc) non-route-lineage ('fba-plan', $1) job + its cycle status / cycle_date + the newest job id;
// the open-paid-cycle statement likewise (dedicated / bootstrap-fba buckets always, natural ones only with an fba-plan
// owner; last activity = the cycle's updated_at + its jobs' created / updated stamps).
const SQL_NAME = new Map(W.FBA_PLAN_EVIDENCE_SQL.map((q) => [q.text, q.name]));
function makePg(dw, w = null) {
  return async (text, values = []) => {
    dw.n.sql += 1;
    assert.ok(RC.isReadOnlyEvidenceSql(text), "pgReadOnly got a non-read-only statement");
    if (text === RELMOD.FBA_PLAN_FOREIGN_JOB_SQL.text) {
      dw.n.jobSql = (dw.n.jobSql || 0) + 1;
      if (!w || dw.failJobSql) throw new Error("pg unavailable");
      const [acct, tokLike, manLike] = values;
      const pre = (p) => String(p).replace(/%$/, "");
      const all = w.jobs.filter((j) => j.report_key === RK && j.account_id === acct).sort((x, y) => y.created_at - x.created_at);
      const isRoute = (j) => j.durable_content_deps.some((d) => d.startsWith(pre(tokLike))) && j.durable_content_deps.some((d) => d.startsWith(pre(manLike)));
      const j = all.find((x) => !isRoute(x));
      if (!j) return [];
      const c = [...w.cycles.values()].find((x) => x.id === j.cycle_id);
      return [{ id: j.id, cycle_id: j.cycle_id, derive_status: j.derive_status, save_status: j.save_status, validated: j.validated === true, snapshot_params_hash: j.snapshot_params_hash, created_at: new Date(j.created_iso), cycle_status: c.status, cycle_date: c.cycle_date, latest_id: all[0].id }];
    }
    if (text === RELMOD.FBA_PLAN_PAID_CYCLE_SQL.text) {
      dw.n.cycleSql = (dw.n.cycleSql || 0) + 1;
      if (!w || dw.failCycleSql) throw new Error("pg unavailable");
      const [dedicated, bootLike, natural, natLike] = values;
      const like = (p, b) => b.startsWith(String(p).replace(/%$/, ""));
      const owns = (c) => !!(w.cycleOwners.get(c.id) && w.cycleOwners.get(c.id).has(RK));
      return [...w.cycles.values()]
        .filter((c) => (c.status === "pending" || c.status === "running") && (dedicated.includes(c.bucket) || like(bootLike, c.bucket) || ((natural.includes(c.bucket) || like(natLike, c.bucket)) && owns(c))))
        .sort((x, y) => (x.bucket + x.cycle_date + x.id < y.bucket + y.cycle_date + y.id ? -1 : 1))
        .map((c) => {
          const acts = [c.updated_at, ...w.jobs.filter((j) => j.cycle_id === c.id).flatMap((j) => [j.created_iso, j.updated_iso])].filter(Boolean).sort();
          return { id: c.id, bucket: c.bucket, status: c.status, cycle_date: c.cycle_date, last_activity_at: new Date(acts[acts.length - 1]) };
        });
    }
    const name = SQL_NAME.get(text);
    if (!name) throw new Error("unknown evidence statement");
    if (dw.failSql) throw new Error("pg unavailable");
    const [org, ids] = values;
    const inIds = (a) => Array.isArray(ids) && ids.includes(a);
    if (name === "fba_pointers") return [...dw.fba.values()].filter((r) => r.organization_fingerprint === org && r.connection_id === "primary" && r.source_key === "fba-inventory-health" && inIds(r.scope_key)).map((r) => ({ account_id: r.scope_key, ...r }));
    if (name === "awd_pointers") return [...dw.listings.values()].filter((r) => r.organization_fingerprint === org && r.connection_id === "primary" && inIds(r.account_id)).map((r) => ({ ...r }));
    if (name === "oli_coverage") return dw.coverage.filter((r) => r.organization_fingerprint === org && inIds(r.account_id)).map((r) => ({ account_id: r.account_id, covered_from: r.covered_from, covered_to: r.covered_to, source_refreshed_at: r.source_refreshed_at }));
    if (name === "catalog_pointer") return dw.catalog && dw.catalog.organization_fingerprint === org ? [{ ...dw.catalog }] : [];
    return [];
  };
}

// =====================================================================================================================
// The report_snapshots + lineage world (the faithful fenced world of route-publication-release.test.js, fba-plan shaped).
// =====================================================================================================================
function makeWorld({ accounts = ACCOUNTS, promoted = [RK] } = {}) {
  const cycles = new Map(); const jobs = []; const snaps = new Map();
  const n = { cycleCreate: 0, jobInsert: 0, shadowWrite: 0, reconcile: 0, finalize: 0, liveCas: 0, liveWrite: 0, preflight: 0, publish: 0 };
  let seq = 0; let clock = NOW;
  const iso = (ms) => new Date(ms).toISOString();
  const countryOf = new Map(accounts.map((a) => [a.accountId, a.country]));
  const w = { cycles, jobs, snaps, n, promoted: [...promoted], rollout: accounts.map((a) => a.accountId), discovered: accounts.map((a) => a.accountId), settingsReads: 0 };
  w.now = () => clock;
  w.tick = (ms = 1000) => { clock += ms; return clock; };
  w.fence = { ownerToken: "op-owner", generation: 7 };
  const cycleById = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  const jobOf = (cycleId, rk, a) => jobs.find((j) => j.cycle_id === cycleId && j.report_key === rk && j.account_id === a) || null;
  const snapKey = (rk, a, h) => rk + "|" + a + "|" + h;
  // updated_at mirrors the production touch_updated_at trigger: set on create, touched by a re-open (open_sync_cycle),
  // claim and finalize. owners: cycleId -> Set(report_key) (sync_source_job_owners, recorded at planning).
  w.cycleOwners = new Map();
  w.addOwner = (cycleId, rk) => { if (!w.cycleOwners.has(cycleId)) w.cycleOwners.set(cycleId, new Set()); w.cycleOwners.get(cycleId).add(rk); };
  w.openCycle = async ({ bucket, cycleDate }) => { const k = bucket + "|" + cycleDate; if (!cycles.has(k)) { n.cycleCreate += 1; const at = iso(w.tick()); cycles.set(k, { id: "cyc-" + (++seq), bucket, cycle_date: cycleDate, status: "pending", created_at: at, updated_at: at }); } else cycles.get(k).updated_at = iso(clock); };
  w.getCycleByBucketDate = async (bucket, cycleDate) => { const c = cycles.get(bucket + "|" + cycleDate); return c ? { ...c } : null; };
  w.claimCycle = async (id) => { const c = cycleById(id); if (c && c.status === "pending") { c.status = "running"; c.updated_at = iso(clock); return true; } return false; };
  w.readCycle = async (id) => { const c = cycleById(id); return c ? { ...c } : null; };
  w.upsertReportJob = async (job) => {
    if (jobOf(job.cycleId, job.reportKey, job.accountId)) return;
    n.jobInsert += 1;
    jobs.push({ id: "job-" + (++seq), cycle_id: job.cycleId, report_key: job.reportKey, account_id: job.accountId, bucket: job.bucket, connection_id: job.connectionId, report_version: job.reportVersion, depends_on: [...(job.dependsOn || [])], durable_content_deps: [...(job.durableContentDeps || [])], derive_status: "pending", save_status: "pending", validated: false, snapshot_params_hash: null, lease_token: null, lease_expires: 0, created_at: ++seq, created_iso: iso(clock) });
  };
  w.claimLease = async (cycleId, rk, a, { leaseSeconds = 300 } = {}) => {
    const j = jobOf(cycleId, rk, a);
    if (!j) return { disposition: "not-found", leaseToken: null, snapshotParamsHash: null };
    if (j.validated === true) return { disposition: "already-complete", leaseToken: null, snapshotParamsHash: j.snapshot_params_hash };
    if (j.derive_status === "running" && j.lease_expires > clock) return { disposition: "held", leaseToken: null, snapshotParamsHash: null };
    const disposition = j.derive_status === "running" ? "reclaimed" : "claimed";
    j.derive_status = "running"; j.lease_token = "lt-" + (++seq); j.lease_expires = clock + leaseSeconds * 1000; j.updated_iso = iso(clock);
    return { disposition, leaseToken: j.lease_token, snapshotParamsHash: null };
  };
  const cas = (counter, writeCounter) => async ({ reportKey, accountId, paramsHash, params, payload, sourceRefreshedAt }) => {
    n[counter] += 1;
    const k = snapKey(reportKey, accountId, paramsHash); const cur = snaps.get(k);
    const cand = Date.parse(sourceRefreshedAt);
    if (cur) {
      const have = Date.parse(cur.source_refreshed_at);
      if (have > cand) return { outcome: "newer-live" };
      if (have === cand) return B.stableJson(cur.params) === B.stableJson(params) && B.stableJson(cur.payload) === B.stableJson(payload) ? { outcome: "already-current" } : { outcome: "conflict" };
    }
    n[writeCounter] += 1;
    snaps.set(k, { id: "row-" + (++seq), report_key: reportKey, account_id: accountId, params_hash: paramsHash, params: clone(params), payload: clone(payload), payload_storage_path: null, source_refreshed_at: sourceRefreshedAt, updated_at: iso(w.tick()) });
    return { outcome: cur ? "replaced" : "inserted" };
  };
  n.shadowCas = 0;
  w.saveShadow = cas("shadowCas", "shadowWrite");
  const liveCasInner = cas("liveCas", "liveWrite");
  w.liveCas = async (args) => (args.ownerToken !== w.fence.ownerToken || Number(args.generation) !== Number(w.fence.generation) ? { outcome: "lease-lost" } : liveCasInner(args));
  w.reconcileSuccess = async ({ cycleId, reportKey, accountId, snapshotParamsHash, leaseToken }) => {
    n.reconcile += 1;
    const j = jobOf(cycleId, reportKey, accountId); if (!j) return { disposition: "not-found" };
    if (j.validated === true) return { disposition: "already-complete" };
    if (j.lease_token !== leaseToken) return { disposition: "lease-lost" };
    Object.assign(j, { validated: true, derive_status: "succeeded", save_status: "succeeded", snapshot_params_hash: snapshotParamsHash, updated_iso: iso(clock) });
    return { disposition: "reconciled" };
  };
  w.finalizeCycle = async ({ cycleId }) => {
    n.finalize += 1;
    const c = cycleById(cycleId); if (!c) return { disposition: "not-found" };
    if (c.status === "succeeded" || c.status === "partial") return { disposition: "already-terminal" };
    c.status = jobs.some((j) => j.cycle_id === cycleId && j.validated === true) ? "succeeded" : "partial";
    c.updated_at = iso(clock);
    return { disposition: "finalized" };
  };
  const latestJobRow = (rk, a) => jobs.filter((x) => x.report_key === rk && x.account_id === a).sort((x, y) => y.created_at - x.created_at)[0] || null;
  w.readLatestJob = async (rk, a) => {
    const j = latestJobRow(rk, a); if (!j) return null;
    const c = cycleById(j.cycle_id);
    return { reportKey: j.report_key, accountId: j.account_id, deriveStatus: j.derive_status, saveStatus: j.save_status, validated: j.validated === true, dependsOn: j.depends_on.map(String), durableContentDeps: j.durable_content_deps.map(String), snapshotParamsHash: j.snapshot_params_hash, latestDataDate: null, cycleStatus: c ? c.status : null, id: j.id, cycleId: j.cycle_id, createdAt: j.created_iso };
  };
  w.readSnapshot = async ({ reportKey, accountId, paramsHash }) => { const r = snaps.get(snapKey(reportKey, accountId, paramsHash)); return r ? clone(r) : null; };
  w.loadStoragePayload = async () => null;
  const newest = (rows) => rows.sort((x, y) => (x.updated_at < y.updated_at ? 1 : x.updated_at > y.updated_at ? -1 : 0))[0] || null;
  w.readers = { getLatestReportSnapshot: async ({ reportKey, accountId }) => clone(newest([...snaps.values()].filter((r) => r.report_key === reportKey && r.account_id === accountId))) };
  // A foreign live row (the PAID job's publish or a dashboard refresh=1 row): { reportVersion, to } params, no tokens.
  w.putLive = (acct, to, payload, stamp) => {
    const h = paramsHashFor("fba-plan-shared-v1", { to });
    snaps.set(snapKey(RK, acct, h), { id: "paid-" + (++seq), report_key: RK, account_id: acct, params_hash: h, params: { reportVersion: "fba-plan-shared-v1", to }, payload: clone(payload), payload_storage_path: null, source_refreshed_at: stamp, updated_at: iso(w.tick()) });
    return h;
  };
  w.live = (acct, to) => snaps.get(snapKey(RK, acct, paramsHashFor("fba-plan-shared-v1", { to }))) || null;
  let publisher = null;
  w.publisherFor = (signal) => {
    w.activeSignal = signal || null;
    if (!publisher) {
      const real = buildSchedulerV2Publisher({
        connections: [...CONNS],
        fetchAccounts: async () => w.discovered.map((id) => ({ id, name: id, country: countryOf.get(id) || "US" })),
        getAccountRollout: async () => ({ read: "ok", allPrimary: false, enabledAccountIds: w.rollout }),
        // The PAID dispatch control for fba-plan is CLOSED throughout (the route never opens it).
        getSettings: async () => { w.settingsReads += 1; return [{ report_key: RK, schedule_enabled: false }]; },
        getPromotedSettings: async () => w.promoted.map((rk) => ({ report_key: rk, publish_enabled: true })),
        getApproval: async () => ({ read: "ok", approved: true }),
        getJob: async (rk, a) => { const j = latestJobRow(rk, a); if (!j) return null; const c = cycleById(j.cycle_id); return { cycle_id: j.cycle_id, report_key: rk, account_id: a, derive_status: j.derive_status, save_status: j.save_status, validated: j.validated === true, snapshot_params_hash: j.snapshot_params_hash, cycle_status: c ? c.status : null }; },
        getSnapshot: w.readSnapshot,
        loadStoragePayload: w.loadStoragePayload,
        publishLiveFenced: (args) => w.liveCas(args),
        getControlFence: () => (w.activeSignal && w.activeSignal.aborted ? null : w.fence),
      });
      publisher = { preflight: async (rk, a) => { n.preflight += 1; return real.preflight(rk, a); }, publish: async (rk, a) => { n.publish += 1; return real.publish(rk, a); } };
    }
    return publisher;
  };
  w.verifyLease = async () => ({ ok: true });
  w.readbackLive = REL.buildRouteLiveReadback({ getReportSnapshot: w.readSnapshot, loadStoragePayload: w.loadStoragePayload, liveContracts: LC, reportDerivations: REPORT_DERIVATIONS, computeHash: paramsHashFor });
  w.writes = () => n.cycleCreate + n.jobInsert + n.shadowWrite + n.reconcile + n.finalize + n.liveWrite;
  return w;
}

// ONE route context: the REAL runtime (built exactly as the CLI builds it) + the REAL release + the REAL reconciler.
// env: the build's attestation env (default: the owner attested the fence -- FBA_PLAN_ROUTE_FENCE_ATTESTED 'true');
// env: null builds WITHOUT deps.env (the CLI shape: process.env is read).
const ATTESTED_ENV = Object.freeze({ FBA_PLAN_ROUTE_FENCE_ATTESTED: "true" });
function makeCtx({ w, dw, accounts = ACCOUNTS, bucket, directory = directoryOf(accounts), ownershipBackfill = null, wrapRuntime = null, onOpenControls = null, env = ATTESTED_ENV }) {
  const logs = [];
  const backfillCalls = [];
  const signalsSeen = [];
  const sb = {
    getReportSnapshot: (a, opt) => { signalsSeen.push(opt && opt.signal ? opt.signal : null); return w.readSnapshot(a, opt); },
    getLatestReportSnapshot: (a) => w.readers.getLatestReportSnapshot(a),
    getLatestReportJobLineage: (rk, a, opt) => { signalsSeen.push(opt && opt.signal ? opt.signal : null); return w.readLatestJob(rk, a); },
    getSourceSnapshotPayload: async (p) => { dw.n.payload += 1; if (!dw.storage.has(p)) { const e = new Error("missing"); e.code = "SOURCE_SNAPSHOT_PAYLOAD_MISSING"; throw e; } return clone(dw.storage.get(p)); },
    getSourceOliHistoryRows: async ({ organizationFingerprint: o, connectionId, accountIds, from, to }) => { dw.n.history += 1; return clone(dw.history.filter((r) => o === ORG && connectionId === "primary" && (!accountIds || accountIds.includes(r.account_id)) && r.sale_date >= from && r.sale_date <= to)); },
    sourceSnapshotObjectPath,
  };
  const deps = Object.freeze({
    bucket, epoch: INV, directory, orgFp: ORG, connectionId: "primary", primaryConnection: CONNS[0], connections: CONNS,
    sb, pgReadOnly: makePg(dw, w), selectors: SEL, computeHash: paramsHashFor, liveContracts: LC, reportDerivations: REPORT_DERIVATIONS,
    marketplaceToday, normalizeMarketplace, now: () => w.now(), strict: true, log: (m) => logs.push(m),
    ownershipBackfill: ownershipBackfill || (async ({ accountId }) => { backfillCalls.push(accountId); return { applied: 1, totalRows: 2 }; }),
    ...(env === null ? {} : { env }),
  });
  const built = ROUTE.build(deps);
  const runtime = typeof wrapRuntime === "function" ? wrapRuntime(built) : built;
  const release = REL.buildRoutePublicationRelease({
    route: ROUTE, runtime,
    deps: {
      openCycle: w.openCycle, getCycleByBucketDate: w.getCycleByBucketDate, claimCycle: w.claimCycle, readCycle: w.readCycle,
      upsertReportJob: w.upsertReportJob, claimLease: w.claimLease, saveShadow: w.saveShadow, reconcileSuccess: w.reconcileSuccess, finalizeCycle: w.finalizeCycle,
      readLatestJob: w.readLatestJob, readSnapshot: w.readSnapshot, loadStoragePayload: w.loadStoragePayload,
      publisherFor: w.publisherFor, verifyLease: w.verifyLease, readbackLive: w.readbackLive,
      liveContracts: LC, reportDerivations: REPORT_DERIVATIONS, computeHash: paramsHashFor,
      evidenceContext: { directory, organizationFingerprint: ORG, connectionId: "primary" },
      now: () => w.now(), log: (m) => logs.push(m),
    },
  });
  const controls = [];
  const run = async ({ dryRun = false, accountIds = null, verifyExact = false } = {}) => SDR.buildSavedDataReconciler({
    resolveOrg: async () => ({ organizationFingerprint: ORG, connectionId: "primary" }),
    bucketAccounts: async () => REL.regionAccountIds(directory, bucket, accountInScope).map((accountId) => ({ accountId })),
    adapter: REL.buildRouteReconcileAdapter({ route: ROUTE, runtime, bucket, directory, liveContracts: LC, readLatestJob: (rk, a) => w.readLatestJob(rk, a), verifyExact }),
    readLatestReportJob: ({ reportKey, accountId }) => w.readLatestJob(reportKey, accountId),
    readShadowSnapshot: (a) => w.readSnapshot(a), readLiveSnapshot: (a) => w.readSnapshot(a), loadStoragePayload: w.loadStoragePayload,
    verifyLiveReadback: w.readbackLive, liveContracts: LC, computeHash: paramsHashFor, reportDerivations: REPORT_DERIVATIONS,
    runPrepareForUnit: (a) => release.prepareForUnit(a), runPublishForUnit: (a) => release.publishForUnit(a),
    openControls: async (x) => { controls.push(x); if (typeof onOpenControls === "function") await onOpenControls(x); return { ok: true }; }, closeControls: async () => ({ ok: true }),
    reportKeys: [RK], family: "fba-plan",
  }).run({ bucket, requestedAsOf: INV, accountIds, mode: "periodic", dryRun });
  return { runtime, built, release, run, controls, backfillCalls, logs, directory, bucket, deps, signalsSeen };
}
const unitOf = (acct, asOf = SALES) => ({ unitKey: "-", targetId: acct, liveAccountId: acct, ownerAccountIds: [acct], targetAsOf: asOf, reportKeys: [RK] });
const stateOf = (summary, acct) => { const r = (summary.perAccount || []).find((x) => x.accountId === acct); return r ? r.reports[RK] : null; };

// The PAID cache-fragment derive of one account: the REAL assembleSources (owner isolation of the batched cache) + the
// REAL durable loader + buildDeriveContext + deriveReportSnapshot -- exactly the report worker's path.
async function paidDerive(seed, dw, acct) {
  const req = seed.fbaPlan.reportRequests.find((r) => r.accountId === acct);
  const statuses = {}; const loaded = {};
  for (const s of req.sources) { statuses[s.requestHash] = "succeeded"; loaded[s.requestHash] = seed.cache.get(s.requestHash); }
  const { sources, latestFetchedAt } = assembleSources(req.sources, statuses, loaded, {}, req.owner);
  const loader = makeFbaPlanDurableContextLoader({
    connections: CONNS,
    getOliCoverage: async ({ accountId }) => ({ read: "ok", windows: dw.coverage.filter((r) => r.account_id === accountId).map((r) => ({ from: r.covered_from, to: r.covered_to })) }),
    getOliHistory: async ({ accountIds, from, to }) => clone(dw.history.filter((r) => accountIds.includes(r.account_id) && r.sale_date >= from && r.sale_date <= to)),
    getCatalogSnapshot: async () => ({ read: "ok", snapshot: dw.catalog }),
    loadCatalogPayload: async (p) => clone(dw.storage.get(p)),
  });
  const derivedContext = await loader({ reportKey: RK, accountId: acct, planned: req });
  const context = buildDeriveContext({ entry: REPORT_DERIVATIONS[RK], plannedContext: req.context, derivedContext, accountId: acct, latestFetchedAt });
  return { result: deriveReportSnapshot({ reportKey: RK, sources, context }), sources, req };
}
const omitStamps = (p) => { const c = clone(p); delete c.inventoryFetchedAt; delete c.awdFetchedAt; return B.stableJson(c); };

// =====================================================================================================================
// A. module contract (worker + CLI modules, runtime, pair; evidence SQL read-only + DDL-verified)
// =====================================================================================================================
{
  const worker = RC.validateRouteModule(W, { side: "worker" });
  const cli = RC.validateRouteModule(RELMOD, { side: "cli", liveContracts: LC, reportDerivations: REPORT_DERIVATIONS });
  ok("A1 the worker module validates (route-contract.js) and declares id fba-plan / publisher + live key fba-plan / awaits [] / priority 2 / deadline 600 / hard 720 / heap 448", worker.id === "fba-plan" && JSON.stringify(worker.publisherKeys) === '["fba-plan"]' && JSON.stringify(worker.liveReportKeys) === '["fba-plan"]' && worker.awaits.length === 0 && worker.priority === 2 && worker.deadlineSeconds === 600 && worker.hardTimeoutSeconds === 720 && worker.childHeapMb === 448 && worker.kind === "route-cli" && worker.cli.script === RC.ROUTE_CLI_SCRIPT && worker.grain === "account");
  ok("A1 the CLI module validates against the REAL SCHEDULER_LIVE_SNAPSHOT_CONTRACTS + REPORT_DERIVATIONS (stampPolicy 'evidence') and the pair agrees", cli.id === "fba-plan" && cli.publisherKey === "fba-plan" && cli.stampPolicy === "evidence" && RC.validateRoutePair(worker, cli, { liveContracts: LC }) === true);
  const w = makeWorld(); const dw = makeDurable();
  const ctx = makeCtx({ w, dw, bucket: "us-ca" });
  ok("A1 the runtime build(deps) validates (every required hook + the optional expandUnits / identityAsOf / currentPredicate / postPublish; no unknown hook)", RC.validateRouteRuntime(ctx.runtime, "fba-plan") === ctx.runtime && ["expandUnits", "identityAsOf", "currentPredicate", "postPublish"].every((h) => typeof ctx.runtime[h] === "function"));
  let threw = null;
  try { ROUTE.build({ ...ctx.deps, pgReadOnly: null }); } catch (e) { threw = e; }
  ok("A1 build fails CLOSED without a required collaborator (the verified read-only pg)", threw && /fail closed/.test(threw.message));
  ok("A2 every evidence statement is ONE read-only SELECT (isReadOnlyEvidenceSql), names unique, params(ctx) = [org, region ids]", W.FBA_PLAN_EVIDENCE_SQL.every((q) => RC.isReadOnlyEvidenceSql(q.text)) && new Set(W.FBA_PLAN_EVIDENCE_SQL.map((q) => q.name)).size === 4
    && JSON.stringify(W.FBA_PLAN_EVIDENCE_SQL[0].params({ organizationFingerprint: "o", accountIds: ["B", "A"] })) === '["o",["A","B"]]'
    && JSON.stringify(W.FBA_PLAN_EVIDENCE_SQL[0].params({ organizationFingerprint: "o", directory: directoryOf(ACCOUNTS), region: "us-ca" })) === '["o",["CAA1","USA1"]]');
  // DDL: every column the SQL reads is declared by the migration that creates its table; dates are read as ::text.
  const tableCols = (file, table) => { const m = src("supabase/migrations/" + file).match(new RegExp("create table if not exists public\\." + table + " \\(([\\s\\S]*?)\\n\\);")); return m ? m[1] : ""; };
  const DDL = { s: tableCols("20260820_source_durable_model.sql", "source_snapshots"), l: tableCols("20260926_source_listings_snapshot.sql", "source_listings_snapshot"), c: tableCols("20260820_source_durable_model.sql", "source_coverage") };
  const refs = W.FBA_PLAN_EVIDENCE_SQL.flatMap((q) => [...q.text.matchAll(/\b([slc])\.([a-z_]+)/g)].map((m) => [m[1], m[2]]));
  ok("A2 every column the evidence SQL reads exists in its table's migration DDL (source_snapshots / source_listings_snapshot / source_coverage)", refs.length > 20 && refs.every(([t, col]) => new RegExp("^\\s*" + col + "\\s", "m").test(DDL[t])));
  ok("A2 Postgres dates are read as text (as_of / covered_from / covered_to ::text) -- never a JS Date on an IST host", /l\.as_of::text/.test(W.FBA_PLAN_EVIDENCE_SQL[1].text) && /c\.covered_from::text/.test(W.FBA_PLAN_EVIDENCE_SQL[2].text) && /c\.covered_to::text/.test(W.FBA_PLAN_EVIDENCE_SQL[2].text));
  ok("A3 tier-1 live-row scope = the account's fba-plan rows; identityAsOf is resolved by the evidence (null here)", JSON.stringify(worker.tier1.liveRowScope("USA1")) === '{"reportKey":"fba-plan","accountIdEq":"USA1"}' && worker.identityAsOf === null);
}

// =====================================================================================================================
// B. the source-bucket-sync MIRRORS + the ONE shared token (worker compose == CLI revision)
// =====================================================================================================================
{
  const cases = [["USA1", "US", INV], ["UKA1", "UK", INV], ["INA1", "IN", PREV], ["seller-x", "DE", "2024-02-29"]];
  ok("B1 fbaSnapshotRequestHash === resolvedFbaSnapshot(...).requestHash for every (seller, marketplace, day) -- and a different day is a different identity", cases.every(([raw, country, asOf]) => FB.fbaSnapshotRequestHash({ apiKey: API_KEY, rawSellerId: raw, asOf }) === resolvedFbaSnapshot({ apiKey: API_KEY, account: { rawSellerId: raw, country }, asOf, bucket: "x" }).requestHash)
    && FB.fbaSnapshotRequestHash({ apiKey: API_KEY, rawSellerId: "USA1", asOf: INV }) !== FB.fbaSnapshotRequestHash({ apiKey: API_KEY, rawSellerId: "USA1", asOf: PREV }));
  const rowSets = [[], [{ marketplace_country_code: "GB" }], [{ marketplace_country_code: "UK" }], [{ a: "" }], [{ x: 1 }], [null], [["GB"]], [{ marketplace_country_code: " GB " }, { marketplace_country_code: "DE" }], "no"];
  ok("B2 validateFbaDurableRows === validateFbaSnapshotRows over every row shape (malformed / blank / cross-marketplace / empty)", rowSets.every((rows) => ["GB", "DE", ""].every((m) => JSON.stringify(FB.validateFbaDurableRows(rows, m)) === JSON.stringify(validateFbaSnapshotRows(rows, m)))));

  const dw = makeDurable(); await seedDurable(dw, ACCOUNTS);
  const w = makeWorld();
  for (const bucket of ["us-ca", "europe-au", "india"]) {
    const ctx = makeCtx({ w, dw, bucket });
    const ids = REL.regionAccountIds(ctx.directory, bucket, accountInScope);
    const ev = await ctx.runtime.readScopeEvidence({ scope: ids, epoch: INV, bucket, directory: ctx.directory, organizationFingerprint: ORG, connectionId: "primary" });
    const pg = makePg(dw);
    const rowsByName = {};
    for (const q of W.FBA_PLAN_EVIDENCE_SQL) rowsByName[q.name] = await pg(q.text, q.params({ organizationFingerprint: ORG, directory: ctx.directory, region: bucket }));
    const workerTokens = W.default.evidence.compose(rowsByName, { epoch: INV, directory: ctx.directory, region: bucket, organizationFingerprint: ORG });
    const cliRevs = ids.map((a) => REL.normalizeRouteRevision(ctx.runtime.computeRevision({ accountId: a, evidence: ev.perAccount.get(a) })));
    ok(`B3 ${bucket}: the WORKER compose token == the CLI revision (revisionId == evidenceToken) for every region account; owners [acct]; region`, cliRevs.every((r, i) => r.eligible === true && r.revisionId === workerTokens.get(ids[i]).token && r.evidenceToken === r.revisionId && /^fp2:[0-9a-f]{64}$/.test(r.revisionId) && JSON.stringify(workerTokens.get(ids[i]).owners) === JSON.stringify([ids[i]]) && workerTokens.get(ids[i]).region === bucket));
    // The paid job's resolveFbaPlanScope over the same coverage == the token's resolveGoLiveAsOf salesAsOf.
    const scope = await resolveFbaPlanScope({ accounts: ids.map((a) => ({ accountId: a })), connections: CONNS, maxBlocked: 2, ceiling: INV, readers: { resolveDataDoeAccountIds, getSourceCoverageWindows: async ({ accountId }) => ({ read: "ok", windows: dw.coverage.filter((r) => r.account_id === accountId).map((r) => ({ from: r.covered_from, to: r.covered_to })) }) } });
    ok(`B3 ${bucket}: salesAsOf = resolveFbaPlanScope (the paid job's pure function) = ${SALES}`, scope.asOf === SALES && ids.every((a) => ev.perAccount.get(a).salesAsOf === SALES && ev.perAccount.get(a).salesAsOfAgrees === true));
  }
  // Token sensitivity: a same-window OLI re-acknowledgement (coverage source_refreshed_at) and a directory rename move it.
  const ctx = makeCtx({ w, dw, bucket: "us-ca" });
  const tokOf = async (c, a) => ctx.runtime.computeRevision({ accountId: a, evidence: (await c.runtime.readScopeEvidence({ scope: [a], epoch: INV, bucket: "us-ca", organizationFingerprint: ORG })).perAccount.get(a) }).evidenceToken;
  const t0 = await tokOf(ctx, "USA1");
  const cov = dw.coverage.find((r) => r.account_id === "USA1"); const keep = cov.source_refreshed_at;
  cov.source_refreshed_at = new Date("2026-09-24T07:30:00.000Z");
  const t1 = await tokOf(ctx, "USA1");
  cov.source_refreshed_at = keep;
  const renamed = makeCtx({ w, dw, bucket: "us-ca", directory: directoryOf(ACCOUNTS.map((a) => (a.accountId === "USA1" ? { ...a, name: "US Renamed" } : a))) });
  const t2 = ROUTE && (await renamed.runtime.readScopeEvidence({ scope: ["USA1"], epoch: INV, bucket: "us-ca", organizationFingerprint: ORG })).perAccount.get("USA1").token;
  ok("B4 the L1 token moves on an OLI coverage re-acknowledgement AND on a directory rename (both reach the payload); unchanged evidence -> the same token", t0 !== t1 && t0 !== t2 && (await tokOf(ctx, "USA1")) === t0);
}

// =====================================================================================================================
// C. THE PARITY FIXTURE (mandatory): paid cache-fragment derive == durable-bundle derive modulo {inventoryFetchedAt,
//    awdFetchedAt}, for US (AWD required), UK (EU5 AWD, directory "UK" vs durable "GB"), CA / DE and IN (no AWD).
// =====================================================================================================================
{
  // US (USA1) + EU5 (UKA1, directory "UK" / durable "GB") carry the RICH shapes (see richInvRows / richLstRows /
  // richHistRows); CA / DE / IN keep the plain fixture.
  const RICH = ["USA1", "UKA1"];
  const dw = makeDurable(); const seed = await seedDurable(dw, ACCOUNTS, { rich: RICH });
  const w = makeWorld();
  ok("C0 the durable evidence came from the REAL writers: one FBA pointer + one canonical Listings pointer per account", seed.persisted.persisted.length === 5 && dw.fba.size === 5 && dw.listings.size === 5 && seed.mat.durableWritten === 5);
  for (const acct of ["USA1", "UKA1", "INA1"]) {
    const req = seed.fbaPlan.reportRequests.find((r) => r.accountId === acct);
    const v3 = seed.v3Plans.find((p) => p.owner.accountId === acct);
    ok(`C0 ${acct}: fba-plan:awd and listing-health-v3:listings resolve to ONE canonical Listings request hash (the durable Listings pointer IS the export the paid AWD fragment read)`, req.sources.find((s) => s.requestKey === "fba-plan:awd").requestHash === v3.sources.find((s) => s.requestKey === "listing-health-v3:listings").requestHash && dw.listings.get(acct).source_request_hash === v3.sources.find((s) => s.requestKey === "listing-health-v3:listings").requestHash);
  }
  for (const [acct, bucket] of [["USA1", "us-ca"], ["CAA1", "us-ca"], ["UKA1", "europe-au"], ["DEA1", "europe-au"], ["INA1", "india"]]) {
    const ctx = makeCtx({ w, dw, bucket });
    const paid = await paidDerive(seed, dw, acct);
    const b = await ctx.runtime.resolveBundle(unitOf(acct), { strict: true, epoch: INV, bucket });
    const d = b.eligible ? await ctx.runtime.derive(b.bundle) : null;
    const awdCapable = ["USA1", "UKA1", "DEA1"].includes(acct);
    ok(`C1 ${acct}: the paid derive and the durable-bundle derive are BOTH real payloads`, paid.result.status === "derived" && b.eligible === true && d && d.payload && REPORT_DERIVATIONS[RK].validatePayload(d.payload) === true);
    ok(`C1 ${acct}: PARITY -- stableJson(omit(paid, stamps)) === stableJson(omit(durable, stamps)) (and the bundle's own content-equivalence agrees)`, omitStamps(paid.result.payload) === omitStamps(d.payload) && FB.fbaPlanContentEqual(paid.result.payload, d.payload));
    ok(`C1 ${acct}: the durable bundle sources ARE the paid isolated rows (inventory${awdCapable ? " + AWD" : ""})`, B.stableJson(b.bundle.sources["fba-plan:inventory-health"].rows) === B.stableJson(paid.sources["fba-plan:inventory-health"].rows)
      && (!awdCapable || B.stableJson(b.bundle.sources["fba-plan:awd"].rows) === B.stableJson(paid.sources["fba-plan:awd"].rows)));
    ok(`C1 ${acct}: the ONLY difference is the fetch stamps (inventory: cache ${INV_FETCHED.slice(11, 16)} vs durable validated_at ${FBA_VALIDATED.slice(11, 16)}; AWD ${awdCapable ? "== the shared Listings fetch" : "null"})`, B.stableJson(paid.result.payload) !== B.stableJson(d.payload) && paid.result.payload.inventoryFetchedAt === INV_FETCHED && d.payload.inventoryFetchedAt === FBA_VALIDATED
      && (awdCapable ? d.payload.awdFetchedAt === LST_FETCHED && paid.result.payload.awdFetchedAt === LST_FETCHED : d.payload.awdFetchedAt === null && paid.result.payload.awdFetchedAt === null));
    ok(`C1 ${acct}: awdAvailable ${awdCapable} / inventoryAvailable true / the directory marketCountry verbatim`, d.payload.awdAvailable === awdCapable && d.payload.awdEligible === awdCapable && d.payload.inventoryAvailable === true && d.payload.marketCountry === ACCOUNTS.find((a) => a.accountId === acct).country);
    if (RICH.includes(acct)) {
      const row = (asin) => d.payload.rows.find((r) => r.asin === asin || r.childAsin === asin) || null;
      const mkt = normalizeMarketplace(ACCOUNTS.find((a) => a.accountId === acct).country);
      const isoInv = b.bundle.sources["fba-plan:inventory-health"].rows;
      const isoAwd = b.bundle.sources["fba-plan:awd"].rows;
      ok(`C2 ${acct}: the RICH shapes reach BOTH derives -- an available:0 row (ASIN ${"B0" + acct}2 -> fbaAvailable 0, never dropped / null), a TWO-SKU ASIN (B0${acct}0 folds both SKUs: 10 + 4, both in the SKU directory), an AWD-ONLY ASIN (in the account SKU directory with provenance awd; no plan row), an ASIN only in SALES (a sales-only plan row)`, row("B0" + acct + "2") && row("B0" + acct + "2").fbaAvailable === 0
        && row("B0" + acct + "0") && row("B0" + acct + "0").fbaAvailable === 14 && isoInv.filter((r) => r.child_asin === "B0" + acct + "0").length === 2
        && d.payload.accountSkuDirectory.filter((x) => x.childAsin === "B0" + acct + "0").length === 2
        && row("B0" + acct + "AWD") === null && d.payload.accountSkuDirectory.some((x) => x.sku === "SKU-" + acct + "-AWD" && x.childAsin === "B0" + acct + "AWD" && x.provenance === "awd")
        && row("B0" + acct + "SO") !== null && row("B0" + acct + "SO").fbaAvailable === 0 && row("B0" + acct + "SO").mtdUnits > 0);
      ok(`C2 ${acct}: the SAME-SELLER CROSS-MARKETPLACE Listings row (${CROSS_MKT[mkt]}) is isolated OUT of both paths identically (the durable pointer holds only ${mkt}; the paid fragment likewise) -- parity holds`, isoAwd.length === 3 && isoAwd.every((r) => normalizeMarketplace(r.marketplace_country_code) === mkt)
        && B.stableJson(isoAwd) === B.stableJson(paid.sources["fba-plan:awd"].rows) && !d.payload.rows.some((r) => r.awdAvailable === 99));
    }
  }
}

// =====================================================================================================================
// D. UK -> GB, cross-account refusal
// =====================================================================================================================
{
  const dw = makeDurable(); await seedDurable(dw, ACCOUNTS);
  const w = makeWorld();
  const ctx = makeCtx({ w, dw, bucket: "europe-au" });
  const b = await ctx.runtime.resolveBundle(unitOf("UKA1"), { strict: true, epoch: INV, bucket: "europe-au" });
  ok("D1 a UK directory account resolves against its GB durable pointers (rows marketplace GB, Listings marketplace GB) through normalizeMarketplace", b.eligible === true && dw.listings.get("UKA1").marketplace === "GB" && b.bundle.sources["fba-plan:inventory-health"].rows.every((r) => r.marketplace_country_code === "GB") && b.bundle.context.marketCountry === "UK" && b.bundle.sources["fba-plan:awd"].available === true);
  // A cross-account FRAGMENT: GB rows of ANOTHER seller in UKA1's durable FBA payload.
  const own = dw.storage.get(dw.fba.get("UKA1").object_path).rows;
  rewritePointer(dw, "fba", "UKA1", [...own, { ...own[0], seller_or_vendor_id: "DEA1" }]);
  const x = await ctx.runtime.resolveBundle(unitOf("UKA1"), { strict: true, epoch: INV, bucket: "europe-au" });
  ok("D2 a cross-account fragment (another seller's rows in the account's durable payload) is REFUSED 'fba-rows-cross-account' -- never derived", x.eligible === false && x.reason === "fba-rows-cross-account");
  // A pointer that names ANOTHER account's object (the namespace proof) is an integrity refusal at the metadata level.
  const dwB = makeDurable(); await seedDurable(dwB, ACCOUNTS);
  dwB.fba.set("UKA1", { ...dwB.fba.get("UKA1"), object_path: dwB.fba.get("DEA1").object_path, payload_sha: dwB.fba.get("DEA1").payload_sha, row_count: dwB.fba.get("DEA1").row_count });
  const ctxB = makeCtx({ w, dw: dwB, bucket: "europe-au" });
  const evB = await ctxB.runtime.readScopeEvidence({ scope: ["UKA1"], epoch: INV, bucket: "europe-au", organizationFingerprint: ORG });
  const revB = ctxB.runtime.computeRevision({ accountId: "UKA1", evidence: evB.perAccount.get("UKA1") });
  ok("D2 a pointer to ANOTHER account's durable object is 'fba-pointer-integrity:path-namespace-mismatch' (typed integrity, zero reads of its payload)", revB.eligible === false && revB.reason === "fba-pointer-integrity:path-namespace-mismatch");
  const dwC = makeDurable(); await seedDurable(dwC, ACCOUNTS);
  dwC.fba.get("UKA1").row_count = String(dwC.fba.get("UKA1").row_count); // an int8-as-string masquerade
  const ctxC = makeCtx({ w, dw: dwC, bucket: "europe-au" });
  const revC = ctxC.runtime.computeRevision({ accountId: "UKA1", evidence: (await ctxC.runtime.readScopeEvidence({ scope: ["UKA1"], epoch: INV, bucket: "europe-au", organizationFingerprint: ORG })).perAccount.get("UKA1") });
  ok("D2 a string row_count is refused 'fba-pointer-integrity:row-count-invalid' (the listing-health-v3 pointer-integrity strictness; never a Number() coercion)", revC.eligible === false && revC.reason === "fba-pointer-integrity:row-count-invalid");
}

// =====================================================================================================================
// E. D-1 identity + missing evidence (typed missing-evidence + alert class; never a zero-inventory payload)
// =====================================================================================================================
{
  const dw = makeDurable(); await seedDurable(dw, ACCOUNTS);
  dw.fba.get("USA1").source_request_hash = FB.fbaSnapshotRequestHash({ apiKey: API_KEY, rawSellerId: "USA1", asOf: PREV });
  dw.fba.delete("CAA1");
  const w = makeWorld();
  const ctx = makeCtx({ w, dw, bucket: "us-ca" });
  const s = await ctx.run({ dryRun: false });
  ok("E1 a durable FBA pointer bound to ANOTHER day's request identity defers DEFERRED_PROVENANCE 'fba-snapshot-not-d1'", stateOf(s, "USA1").state === RS.DP && stateOf(s, "USA1").reason === "fba-snapshot-not-d1");
  ok("E2 a MISSING FBA pointer is DEFERRED_PROVENANCE 'fba-durable-missing' -- the worker classes it missing-evidence (alerted), zero writes, zero controls", stateOf(s, "CAA1").state === RS.DP && stateOf(s, "CAA1").reason === "fba-durable-missing"
    && CLS.accountVerdict({ id: "CAA1", reports: { [RK]: { s: RS.DP, r: "fba-durable-missing" } } }, [RK]).cls === CLS.CLASSES.MISSING_EVIDENCE && w.writes() === 0 && ctx.controls.length === 0);
  const b = await ctx.runtime.resolveBundle(unitOf("CAA1"), { strict: true, epoch: INV, bucket: "us-ca" });
  ok("E2 the bundle itself refuses (never a zero-inventory source for a missing pointer)", b.eligible === false && b.reason === "fba-durable-missing" && !("bundle" in b));
  ok("E zero network / zero DataDoe so far", net.calls.length === 0);
}

// =====================================================================================================================
// F. AWD: US hard requirement, EU5 regression guard, EU5 honest unavailable
// =====================================================================================================================
{
  // F1 / F2: US missing durable AWD, or a Listings label older than the inventory day.
  const dw = makeDurable(); await seedDurable(dw, ACCOUNTS);
  dw.listings.delete("USA1");
  const w = makeWorld();
  const ctx = makeCtx({ w, dw, bucket: "us-ca" });
  const s1 = await ctx.run({ dryRun: false, accountIds: ["USA1"] });
  ok("F1 a US account WITHOUT durable AWD defers DEFERRED_PROVENANCE 'awd-durable-missing' (zero writes)", stateOf(s1, "USA1").state === RS.DP && stateOf(s1, "USA1").reason === "awd-durable-missing" && w.writes() === 0);
  const dw2 = makeDurable(); await seedDurable(dw2, ACCOUNTS);
  dw2.listings.get("USA1").as_of = PREV;
  const ctx2 = makeCtx({ w, dw: dw2, bucket: "us-ca" });
  const s2 = await ctx2.run({ dryRun: false, accountIds: ["USA1"] });
  ok("F2 a US account whose durable Listings as_of < inventoryAsOf defers 'awd-durable-stale' (zero writes)", stateOf(s2, "USA1").state === RS.DP && stateOf(s2, "USA1").reason === "awd-durable-stale" && w.writes() === 0);
  // F3: a Listings pointer WITHOUT the awd_* columns (a non-canonical Listings export) never folds to a fabricated 0.
  const dw3 = makeDurable(); await seedDurable(dw3, ACCOUNTS);
  const lrows = dw3.storage.get(dw3.listings.get("USA1").object_path).rows.map((r) => { const c = { ...r }; delete c.awd_available_distributable_quantity; delete c.awd_total_inbound_quantity; return c; });
  rewritePointer(dw3, "listings", "USA1", lrows);
  const ctx3 = makeCtx({ w, dw: dw3, bucket: "us-ca" });
  const s3 = await ctx3.run({ dryRun: false, accountIds: ["USA1"] });
  ok("F3 a US Listings pointer missing the awd_* columns defers 'bundle-awd-rows-invalid:awd-columns-missing' at prepare (zero writes)", stateOf(s3, "USA1").state === RS.DD && stateOf(s3, "USA1").reason === "bundle-awd-rows-invalid:awd-columns-missing" && w.writes() === 0);

  // F4: EU5 durable AWD missing while the SERVED row shows awdAvailable:true -> the regression guard defers.
  const dw4 = makeDurable(); const seed4 = await seedDurable(dw4, ACCOUNTS);
  const w4 = makeWorld();
  const paidUk = await paidDerive(seed4, dw4, "UKA1");
  w4.putLive("UKA1", SALES, paidUk.result.payload, LST_FETCHED);
  dw4.listings.delete("UKA1");
  const ctx4 = makeCtx({ w: w4, dw: dw4, bucket: "europe-au" });
  const before4 = w4.writes();
  const s4 = await ctx4.run({ dryRun: false, accountIds: ["UKA1"] });
  ok("F4 EU5 (UK) missing durable AWD with a SERVED awdAvailable:true defers 'bundle-awd-regression-guard' -- paid AWD is never regressed to 'no AWD' (zero writes)", paidUk.result.payload.awdAvailable === true && stateOf(s4, "UKA1").state === RS.DD && stateOf(s4, "UKA1").reason === "bundle-awd-regression-guard" && w4.writes() === before4 && w4.n.liveCas === 0);
  // F5: EU5 missing AWD with NO served AWD -> publishes honestly awdAvailable:false (AWD-capable, no fabricated zero).
  const dw5 = makeDurable(); await seedDurable(dw5, ACCOUNTS);
  dw5.listings.delete("UKA1");
  const w5 = makeWorld();
  const ctx5 = makeCtx({ w: w5, dw: dw5, bucket: "europe-au" });
  const s5 = await ctx5.run({ dryRun: false, accountIds: ["UKA1"] });
  const live5 = w5.live("UKA1", SALES);
  ok("F5 EU5 missing AWD with no served AWD publishes awdAvailable:false (awdEligible true, awdFetchedAt null; the stamp excludes the absent AWD evidence)", s5.counts.targetsPublished === 1 && stateOf(s5, "UKA1").state === RS.RV && live5 && live5.payload.awdAvailable === false && live5.payload.awdEligible === true && live5.payload.awdFetchedAt === null && live5.source_refreshed_at === FBA_VALIDATED);
}

// =====================================================================================================================
// F'. the EU5 AWD regression guard reads BOTH the served row and the exact live row at {to: salesAsOf}, and fails closed
//     on any served slot but a readable row or a TRUE 'missing'; the inventory guard's own read failures are typed.
// =====================================================================================================================
{
  // A legacy-version row updated LATER than everything else hides the v1 rows from the serve (selector 'version-hidden').
  const putLegacy = (world, acct) => {
    const h0 = paramsHashFor("fba-plan-shared-v0", { to: "2026-09-20" });
    world.snaps.set(RK + "|" + acct + "|" + h0, { id: "legacy-" + acct, report_key: RK, account_id: acct, params_hash: h0, params: { reportVersion: "fba-plan-shared-v0", to: "2026-09-20" }, payload: { rows: [] }, payload_storage_path: null, source_refreshed_at: "2026-09-20T00:00:00.000Z", updated_at: new Date(world.tick(5000)).toISOString() });
  };
  // F6 (probeB): served 'version-hidden' + the PAID exact live row at {to: salesAsOf} with awdAvailable:true.
  const dw = makeDurable(); const seed = await seedDurable(dw, ACCOUNTS);
  const paidUk = await paidDerive(seed, dw, "UKA1");
  const w = makeWorld();
  w.putLive("UKA1", SALES, paidUk.result.payload, LST_FETCHED);
  putLegacy(w, "UKA1");
  dw.listings.delete("UKA1"); // EU5 durable AWD missing
  const ctx = makeCtx({ w, dw, bucket: "europe-au" });
  const served6 = await ctx.runtime.servedSelector(unitOf("UKA1"), {});
  const s6 = await ctx.run({ dryRun: false, accountIds: ["UKA1"] });
  ok("F6 (probeB) served slot 'version-hidden' while the exact live row at {to: salesAsOf} holds the PAID awdAvailable:true -> FILL-ONLY: the exact row is PAID-OWNED -> 'bundle-superseded-newer-live:paid-owned' (ownership precedes the AWD regression guard), ZERO writes, the paid AWD row untouched", served6.row === null && served6.reason === "version-hidden" && stateOf(s6, "UKA1").state === RS.DD && stateOf(s6, "UKA1").reason === "bundle-superseded-newer-live:paid-owned" && w.writes() === 0 && w.n.liveCas === 0 && w.live("UKA1", SALES).payload.awdAvailable === true);
  // F7: served 'version-hidden' and NO exact live row: absence of served AWD is unprovable -> fail closed.
  const w7 = makeWorld();
  putLegacy(w7, "UKA1");
  const ctx7 = makeCtx({ w: w7, dw, bucket: "europe-au" });
  const s7 = await ctx7.run({ dryRun: false, accountIds: ["UKA1"] });
  ok("F7 EU5 missing AWD with an EMPTY served slot (version-hidden: not a true 'missing') and no exact live row -> 'bundle-awd-regression-guard:served-unreadable', ZERO writes (never 'awdAvailable:false' on an unprovable served state)", stateOf(s7, "UKA1").state === RS.DD && stateOf(s7, "UKA1").reason === "bundle-awd-regression-guard:served-unreadable" && w7.writes() === 0);
  // F8: the SAME empty served slot for a non-AWD account (CA): the inventory order has no served row to compare and the
  // exact live row (the CAS target) is readable-missing -> it publishes (the tolerance is inventory-only by design).
  const w8 = makeWorld();
  putLegacy(w8, "CAA1");
  const ctx8 = makeCtx({ w: w8, dw, bucket: "us-ca" });
  const s8 = await ctx8.run({ dryRun: false, accountIds: ["CAA1"] });
  ok("F8 contrast: a non-AWD account (CA) with an EMPTY served slot and no exact live row publishes (READBACK_VERIFIED: the new row becomes the served one)", stateOf(s8, "CAA1").state === RS.RV && !!w8.live("CAA1", SALES));
  // F9: the guard's own reads, typed (the bundle itself; the release maps them from the selector + the exact read).
  const dwG = makeDurable(); await seedDurable(dwG, ACCOUNTS);
  const ctxG = makeCtx({ w: makeWorld(), dw: dwG, bucket: "us-ca" });
  const evG = (await ctxG.runtime.readScopeEvidence({ scope: ["USA1"], epoch: INV, bucket: "us-ca", organizationFingerprint: ORG })).perAccount.get("USA1");
  const readersFor = (readLiveRows, readPaidPending = async () => ({ state: "none" }), readPaidCycles = async () => ({ state: "none" })) => ({ loadSnapshotPayload: (p) => ctxG.deps.sb.getSourceSnapshotPayload(p), readOliHistory: (q) => ctxG.deps.sb.getSourceOliHistoryRows(q), readLiveRows, readPaidPending, readPaidCycles, connections: CONNS, buildObjectPath: sourceSnapshotObjectPath });
  const guard = async (readLiveRows) => { const r = await FB.resolveFbaPlanDependencyBundle(readersFor(readLiveRows), { evidence: evG, organizationFingerprint: ORG, connectionId: "primary", apiKey: API_KEY }); return r.eligible ? "eligible" : r.reason; };
  const M_ = { state: "missing" };
  const got = [
    await guard(async () => ({ served: { state: "unreadable" }, exact: M_ })),
    await guard(async () => ({ served: { state: "row", payload: null }, exact: M_ })),
    await guard(async () => { throw new Error("rest down"); }),
    await guard(async () => ({ served: M_, exact: { state: "unreadable" } })),
    await guard(async () => ({ served: M_, exact: { state: "empty" } })),
    await guard(async () => ({ served: { state: "empty" }, exact: M_ })),
    await guard(async () => ({ served: M_, exact: M_ })),
  ];
  let threw = null;
  try { await FB.resolveFbaPlanDependencyBundle(readersFor(undefined), { evidence: evG, organizationFingerprint: ORG, connectionId: "primary", apiKey: API_KEY }); } catch (e) { threw = e; }
  let threwPaid = null;
  try { await FB.resolveFbaPlanDependencyBundle(readersFor(async () => ({ served: M_, exact: M_ }), null), { evidence: evG, organizationFingerprint: ORG, connectionId: "primary", apiKey: API_KEY }); } catch (e) { threwPaid = e; }
  got.push(await guard(async () => ({ served: M_, exact: M_ }))); // (the default readPaidPending / readPaidCycles: 'none')
  let threwCycles = null;
  try { await FB.resolveFbaPlanDependencyBundle(readersFor(async () => ({ served: M_, exact: M_ }), async () => ({ state: "none" }), null), { evidence: evG, organizationFingerprint: ORG, connectionId: "primary", apiKey: API_KEY }); } catch (e) { threwCycles = e; }
  const cyc = async (readPaidCycles) => { const r = await FB.resolveFbaPlanDependencyBundle(readersFor(async () => ({ served: M_, exact: M_ }), async () => ({ state: "none" }), readPaidCycles), { evidence: evG, organizationFingerprint: ORG, connectionId: "primary", apiKey: API_KEY }); return r.eligible ? "eligible" : r.reason; };
  const gotCycles = [await cyc(async () => { throw new Error("pg down"); }), await cyc(async () => ({ state: "open" })), await cyc(async () => ({ state: "bogus" })), await cyc(async () => ({ state: "open", bucket: "us-ca-fba" })), await cyc(async () => ({ state: "stale-open", bucket: "us-ca-fba" }))];
  ok("F9 the never-go-backwards reads are typed + fail closed: served unreadable / payload-less / a throwing reader -> 'inventory-guard:served-unreadable'; exact live unreadable -> 'inventory-guard:live-unreadable'; US with an EMPTY served slot or both missing resolves; no live-row reader or no latest-job reader (readPaidPending) THROWS", JSON.stringify(got) === JSON.stringify(["inventory-guard:served-unreadable", "inventory-guard:served-unreadable", "inventory-guard:served-unreadable", "inventory-guard:live-unreadable", "inventory-guard:live-unreadable", "eligible", "eligible", "eligible"]) && threw && /readLiveRows/.test(threw.message)
    && threwPaid && /readPaidPending/.test(threwPaid.message));
  ok("F9 the open-paid-cycle read is typed + fail closed too: a throwing / bucket-less / malformed slot -> 'inventory-guard:paid-cycle-unreadable'; an open / stale-open cycle -> 'paid-cycle-open:<bucket>' / 'paid-cycle-stale-open:<bucket>'; no readPaidCycles reader THROWS",
    JSON.stringify(gotCycles) === JSON.stringify(["inventory-guard:paid-cycle-unreadable", "inventory-guard:paid-cycle-unreadable", "inventory-guard:paid-cycle-unreadable", "paid-cycle-open:us-ca-fba", "paid-cycle-stale-open:us-ca-fba"]) && threwCycles && /readPaidCycles/.test(threwCycles.message));
}

// =====================================================================================================================
// G. the CURRENT PREDICATE (content equivalence over the SERVED row)
// =====================================================================================================================
{
  const dw = makeDurable(); const seed = await seedDurable(dw, ACCOUNTS);
  // G1: the PAID job published the same content (its own cache stamps) -> current, ZERO writes, zero controls.
  const w = makeWorld();
  const paidUs = await paidDerive(seed, dw, "USA1");
  const paidCa = await paidDerive(seed, dw, "CAA1");
  w.putLive("USA1", SALES, paidUs.result.payload, LST_FETCHED);
  w.putLive("CAA1", SALES, paidCa.result.payload, "2026-09-24T11:00:00.000Z"); // a LATER paid stamp: still just current
  const ctx = makeCtx({ w, dw, bucket: "us-ca" });
  const s = await ctx.run({ dryRun: false });
  ok("G1 a PAID-published row with equal content is PUBLICATION_NOT_REQUIRED 'content-equivalent' (served-row check passed) -- ZERO writes, ZERO CAS, zero controls", ["USA1", "CAA1"].every((a) => stateOf(s, a).state === RS.NR && stateOf(s, a).reason === "content-equivalent" && stateOf(s, a).served && stateOf(s, a).served.h === paramsHashFor("fba-plan-shared-v1", { to: SALES }))
    && s.counts.targetsAlreadyCurrent === 2 && s.counts.targetsPublished === 0 && w.writes() === 0 && w.n.liveCas === 0 && ctx.controls.length === 0 && ctx.backfillCalls.length === 0);

  // G2: an exact-today (browser identity) refresh row holds the served slot -> preempted (foreign, never fought).
  const wT = makeWorld();
  wT.putLive("USA1", TODAY, paidUs.result.payload, "2026-09-25T05:00:00.000Z");
  const ctxT = makeCtx({ w: wT, dw, bucket: "us-ca" });
  const sT = await ctxT.run({ dryRun: false, accountIds: ["USA1"] });
  ok("G2 a served exact-today refresh row -> DEFERRED_DEPENDENCY 'served-row-preempted:exact-today-row', zero writes", marketplaceToday("US", new Date(NOW)) === TODAY && stateOf(sT, "USA1").state === RS.DD && stateOf(sT, "USA1").reason === "served-row-preempted:exact-today-row" && wT.writes() === 0);

  // G3: a served `to` NEWER than salesAsOf (durable OLI lags the paid job) -> superseded, never regressed.
  const dwL = makeDurable(); await seedDurable(dwL, ACCOUNTS, { coveredTo: { USA1: PREV, CAA1: PREV } });
  const wL = makeWorld();
  wL.putLive("USA1", SALES, paidUs.result.payload, LST_FETCHED);
  const ctxL = makeCtx({ w: wL, dw: dwL, bucket: "us-ca" });
  const sL = await ctxL.run({ dryRun: false, accountIds: ["USA1"] });
  ok("G3 a served newer `to` (" + SALES + " > salesAsOf " + PREV + ") -> superseded 'superseded-newer-live:served-newer-to' with NO write (the worker classes it superseded-newer-live)", stateOf(sL, "USA1").state === RS.DD && stateOf(sL, "USA1").reason === "superseded-newer-live:served-newer-to" && wL.writes() === 0
    && CLS.classifyDeferral(stateOf(sL, "USA1").reason).cls === CLS.CLASSES.SUPERSEDED_NEWER_LIVE);

  // G4: provenTo < salesAsOf -> DEFERRED_PROVENANCE 'oli-coverage-short' (the other account still publishes).
  const dwS = makeDurable(); await seedDurable(dwS, ACCOUNTS, { coveredTo: { CAA1: "2026-09-20" } });
  const wS = makeWorld();
  const ctxS = makeCtx({ w: wS, dw: dwS, bucket: "us-ca" });
  const sS = await ctxS.run({ dryRun: false });
  ok("G4 an account whose proven OLI (2026-09-20) < the region salesAsOf (" + SALES + ") is DEFERRED_PROVENANCE 'oli-coverage-short'; USA1 still publishes", stateOf(sS, "CAA1").state === RS.DP && stateOf(sS, "CAA1").reason === "oli-coverage-short" && stateOf(sS, "USA1").state === RS.RV && !wS.live("CAA1", SALES) && !!wS.live("USA1", SALES));
}

// =====================================================================================================================
// H. FILL-ONLY ownership: a PAID-OWNED row at the exact identity {to: salesAsOf} is NEVER replaced (never a CAS) --
//    whatever its stamp; the route fills only an identity the paid path has not published.
// =====================================================================================================================
{
  const dw = makeDurable(); const seed = await seedDurable(dw, ACCOUNTS);
  const paidUs = await paidDerive(seed, dw, "USA1");
  const different = clone(paidUs.result.payload); different.rows[0].fbaAvailable = 999; // differs in content
  for (const [label, stamp] of [["newer stamp (10:00 >= the evidence instant 09:00)", "2026-09-24T10:00:00.000Z"], ["OLDER stamp (08:00 < the evidence instant 09:00)", "2026-09-24T08:00:00.000Z"]]) {
    const w = makeWorld();
    w.putLive("USA1", SALES, different, stamp);
    const ctx = makeCtx({ w, dw, bucket: "us-ca" });
    const scan = await ctx.run({ dryRun: true, accountIds: ["USA1"] });
    const s = await ctx.run({ dryRun: false, accountIds: ["USA1"] });
    const b = await ctx.runtime.resolveBundle(unitOf("USA1"), { strict: true, epoch: INV, bucket: "us-ca" });
    ok("H1 a PAID-OWNED exact row with DIFFERENT content, " + label + " -> 'superseded-newer-live:paid-owned' in the scan AND the live pass (the prepare's resolve refuses it too): ZERO writes, ZERO CAS, zero controls; the worker classes it superseded-newer-live",
      [scan, s].every((x) => stateOf(x, "USA1").state === RS.DD && stateOf(x, "USA1").reason === "superseded-newer-live:paid-owned") && b.eligible === false && b.reason === "superseded-newer-live:paid-owned"
      && w.writes() === 0 && w.n.liveCas === 0 && ctx.controls.length === 0 && w.live("USA1", SALES).payload.rows[0].fbaAvailable === 999 && w.live("USA1", SALES).source_refreshed_at === stamp
      && CLS.classifyDeferral("superseded-newer-live:paid-owned").cls === CLS.CLASSES.SUPERSEDED_NEWER_LIVE);
  }
  // H2: ownership is the STORED route tokens (the contract's liveParamsExtra) -- never the shadow's route / rev.
  const tok = (p, n) => p + String(n).repeat(64);
  ok("H2 fbaPlanRowOwner: 'route' ONLY for this route's evidence token version (" + W.FBA_PLAN_TOKEN_PREFIX + ") + manifest token over 64-hex; paid / legacy / refresh=1 params, an older token version (fp1:), a lone token, route / rev params alone -> 'paid'",
    FB.fbaPlanRowOwner({ reportVersion: "fba-plan-shared-v1", to: SALES, evidenceToken: tok(W.FBA_PLAN_TOKEN_PREFIX, "a"), manifestToken: tok(FB.FBA_PLAN_MANIFEST_PREFIX, "b") }) === "route"
    && [{ reportVersion: "fba-plan-shared-v1", to: SALES }, { evidenceToken: tok("fp1:", "a"), manifestToken: tok(FB.FBA_PLAN_MANIFEST_PREFIX, "b") }, { evidenceToken: tok(W.FBA_PLAN_TOKEN_PREFIX, "a") },
      { route: "fba-plan", rev: tok(W.FBA_PLAN_TOKEN_PREFIX, "a") }, { evidenceToken: tok(W.FBA_PLAN_TOKEN_PREFIX, "A"), manifestToken: tok(FB.FBA_PLAN_MANIFEST_PREFIX, "b") }, null, "x"].every((p) => FB.fbaPlanRowOwner(p) === "paid")
    && LC[RK].liveParamsExtra({ route: "fba-plan", rev: "r", evidenceToken: "e", manifestToken: "m" }).route === undefined);
}

// =====================================================================================================================
// I. normal publish end to end + the scoped ownership backfill (once per published account; non-fatal)
// =====================================================================================================================
{
  const dw = makeDurable(); await seedDurable(dw, ACCOUNTS);
  const w = makeWorld();
  const ctx = makeCtx({ w, dw, bucket: "us-ca" });
  const s1 = await ctx.run({ dryRun: false });
  const live = w.live("USA1", SALES);
  const job = w.jobs.find((j) => j.account_id === "USA1");
  const shadow = w.snaps.get("scheduler-v2/fba-plan|USA1|" + job.snapshot_params_hash);
  const ev = (await ctx.runtime.readScopeEvidence({ scope: ["USA1"], epoch: INV, bucket: "us-ca", organizationFingerprint: ORG })).perAccount.get("USA1");
  ok("I1 both us-ca accounts publish through the REAL four-gate publisher (READBACK_VERIFIED), one control window with the promoted gate", s1.counts.targetsPublished === 2 && ["USA1", "CAA1"].every((a) => stateOf(s1, a).state === RS.RV) && ctx.controls.length === 1 && JSON.stringify(ctx.controls[0]) === JSON.stringify({ owners: ["CAA1", "USA1"], publisherKeys: [RK] }));
  ok("I1 the live row: identity {to: salesAsOf}, the route tokens STORED (never hashed), stamp = the EVIDENCE INSTANT (max FBA / AWD / OLI / catalog stamps)", live && live.params_hash === paramsHashFor("fba-plan-shared-v1", { to: SALES }) && live.params.evidenceToken === ev.token && /^fpm1:[0-9a-f]{64}$/.test(live.params.manifestToken) && live.source_refreshed_at === FBA_VALIDATED && live.payload.inventoryFetchedAt === FBA_VALIDATED);
  ok("I1 the shadow carries the report-planner fba-plan params + route / rev / tokens (content-addressed)", shadow && shadow.params.reportVersion === "fba-plan/v2d-5" && shadow.params.accountId === "USA1" && shadow.params.to === SALES && shadow.params.inventoryAsOf === INV && shadow.params.rawSellerId === "USA1" && shadow.params.accountName === "US One" && shadow.params.marketCountry === "US" && shadow.params.isUS === true && shadow.params.route === "fba-plan" && shadow.params.rev === ev.token
    && JSON.stringify(job.durable_content_deps) === JSON.stringify([ev.token, live.params.manifestToken]) && job.depends_on.includes(dw.fba.get("USA1").source_request_hash) && job.depends_on.includes(dw.listings.get("USA1").source_request_hash));
  ok("I1 the ownership backfill ran ONCE per published account (scoped: CAA1, USA1)", JSON.stringify(ctx.backfillCalls) === '["CAA1","USA1"]');
  const scan = await ctx.run({ dryRun: true });
  const verify = await ctx.run({ dryRun: true, verifyExact: true });
  ok("I1 re-scan: PUBLICATION_NOT_REQUIRED 'content-equivalent' + the served-row check; --verify-exact also passes (the job carries the manifest)", ["USA1", "CAA1"].every((a) => stateOf(scan, a).state === RS.NR && stateOf(scan, a).reason === "content-equivalent" && stateOf(verify, a).state === RS.NR));
  const writes = w.writes(); const cas = w.n.liveCas;
  const s2 = await ctx.run({ dryRun: false });
  ok("I1 a second live pass: ZERO writes, zero CAS, zero new controls, no new backfill", s2.counts.targetsAlreadyCurrent === 2 && w.writes() === writes && w.n.liveCas === cas && ctx.controls.length === 1 && ctx.backfillCalls.length === 2);
  ok("I1 the paid dispatch control stayed CLOSED (GATE 2 opened on the PROMOTED 'fba-plan' row only)", w.settingsReads > 0 && w.promoted.includes(RK));

  // I2: a throwing ownership backfill is non-fatal.
  const dw2 = makeDurable(); await seedDurable(dw2, ACCOUNTS);
  const w2 = makeWorld();
  let calls = 0;
  const ctx2 = makeCtx({ w: w2, dw: dw2, bucket: "india", ownershipBackfill: async () => { calls += 1; throw new Error("ownership table unavailable"); } });
  const s3 = await ctx2.run({ dryRun: false });
  ok("I2 a throwing ownership backfill is NON-FATAL: the account is still READBACK_VERIFIED + live, the failure is logged", calls === 1 && stateOf(s3, "INA1").state === RS.RV && !!w2.live("INA1", SALES) && ctx2.logs.some((m) => /postPublish failed \(non-fatal\)/.test(m)));
}

// =====================================================================================================================
// J. duplicate raw seller (pan-EU ambiguity) defers BOTH accounts
// =====================================================================================================================
{
  const dw = makeDurable(); await seedDurable(dw, ACCOUNTS);
  const accounts = [...ACCOUNTS, { accountId: "DUPA", country: "IN", currency: "INR", name: "Dup A", rawSellerId: "RAWX" }, { accountId: "DUPB", country: "IN", currency: "INR", name: "Dup B", rawSellerId: "RAWX" }];
  const w = makeWorld({ accounts });
  const ctx = makeCtx({ w, dw, accounts, bucket: "india" });
  const s = await ctx.run({ dryRun: true });
  ok("J1 two directory accounts sharing ONE raw seller are BOTH DEFERRED_PROVENANCE 'pan-eu-ambiguous'; the unrelated account is unaffected", stateOf(s, "DUPA").state === RS.DP && stateOf(s, "DUPA").reason === "pan-eu-ambiguous" && stateOf(s, "DUPB").state === RS.DP && stateOf(s, "DUPB").reason === "pan-eu-ambiguous" && stateOf(s, "INA1").state === RS.ST && w.writes() === 0);
  ok("J1 the guard is the shared assertNoDuplicatePerAccountReadIdentities (+ grouping): exactly the colliding accounts", JSON.stringify([...FB.ambiguousRawSellerAccounts({ accounts: [{ accountId: "A", rawSellerId: "R" }, { accountId: "B", rawSellerId: "R" }, { accountId: "C", rawSellerId: "Q" }], connections: CONNS })].sort()) === '["A","B"]'
    && FB.ambiguousRawSellerAccounts({ accounts: [{ accountId: "A", rawSellerId: "R" }, { accountId: "C", rawSellerId: "Q" }], connections: CONNS }).size === 0);
}

// =====================================================================================================================
// M. NEVER GO BACKWARDS (owner rule: paid data is never overwritten by OLDER evidence -- the verifier's probeA). The
//    evidence stamp is a MAX over independent components, so an unrelated newer OLI stamp alone must never let OLDER
//    inventory / AWD past the newer-live check: (a) the epoch must be the CURRENT inventory D-1; (b) the served row and
//    the exact live row at {to: salesAsOf} are ordered per component inside resolveBundle.
// =====================================================================================================================
{
  const INV_NEXT = "2026-09-25";
  const dwN = makeDurable(); const seedN = await seedDurable(dwN, ACCOUNTS, { inventoryAsOf: INV_NEXT });
  const paidNewer = await paidDerive(seedN, dwN, "USA1");
  const newer = clone(paidNewer.result.payload); newer.rows[0].fbaAvailable = 555; // the paid job's FRESHER inventory (day 09-25)
  const bumpOli = (dw, iso) => { dw.coverage.find((r) => r.account_id === "USA1").source_refreshed_at = new Date(iso); };

  // M1 (probeA): the route runs with epoch INV = 09-24 while the CURRENT inventory D-1 is 09-25 -- with and without an
  // OLI re-ack AFTER the paid fetch (which used to lift the evidence instant past the paid stamp).
  for (const bump of [false, true]) {
    const w = makeWorld();
    w.tick(86400000); // now = 2026-09-26T06:00Z -> fbaInventoryAsOf(now) = 2026-09-25
    w.putLive("USA1", SALES, newer, "2026-09-26T05:00:00.000Z");
    const dw = makeDurable(); await seedDurable(dw, ACCOUNTS);
    if (bump) bumpOli(dw, "2026-09-26T05:30:00.000Z");
    const ctx = makeCtx({ w, dw, bucket: "us-ca" });
    const s = await ctx.run({ dryRun: false, accountIds: ["USA1"] });
    const live = w.live("USA1", SALES);
    ok(`M1 (probeA${bump ? " + an OLI re-ack after the paid fetch" : ""}) epoch ${INV} != the current inventory D-1 (fbaInventoryAsOf(now) = ${INV_NEXT}, the paid job's helper) -> DEFERRED_PROVENANCE 'epoch-not-current-d1', ZERO writes; the paid ${INV_NEXT} inventory row is untouched`, fbaInventoryAsOf(w.now()) === INV_NEXT && stateOf(s, "USA1").state === RS.DP && stateOf(s, "USA1").reason === "epoch-not-current-d1"
      && w.writes() === 0 && w.n.liveCas === 0 && live.payload.inventoryRequestedThrough === INV_NEXT && live.payload.rows[0].fbaAvailable === 555 && live.source_refreshed_at === "2026-09-26T05:00:00.000Z");
  }
  // M1b: an arbitrary (older) --as-of at the right wall clock never derives either (revision AND the prepare's resolve).
  {
    const dw = makeDurable(); await seedDurable(dw, ACCOUNTS);
    const ctx = makeCtx({ w: makeWorld(), dw, bucket: "us-ca" });
    const ev = await ctx.runtime.readScopeEvidence({ scope: ["USA1"], epoch: PREV, bucket: "us-ca", organizationFingerprint: ORG });
    const rev = ctx.runtime.computeRevision({ accountId: "USA1", evidence: ev.perAccount.get("USA1") });
    const b = await ctx.runtime.resolveBundle(unitOf("USA1"), { strict: true, epoch: PREV, bucket: "us-ca" });
    const bOk = await ctx.runtime.resolveBundle(unitOf("USA1"), { strict: true, epoch: INV, bucket: "us-ca" });
    ok("M1b an older --as-of (" + PREV + ") at the right clock is ineligible 'epoch-not-current-d1' (computeRevision + resolveBundle); the current D-1 (" + INV + ") resolves", rev.eligible === false && rev.reason === "epoch-not-current-d1" && b.eligible === false && b.reason === "epoch-not-current-d1" && bOk.eligible === true);
  }

  // M2: epoch == the current D-1; the SERVED row is an older-`to` ({to: PREV}) row that nevertheless carries a LATER
  // inventory day, an older stamp than the evidence instant and an unrelated newer OLI re-ack; no exact row. The
  // component order (FILL-ONLY (c)) refuses the fill. M2b: the SAME newer-inventory row AT {to: salesAsOf} is PAID-OWNED
  // (ownership precedes the component order).
  {
    const w = makeWorld();
    const olderTo = clone(newer); olderTo.asOf = PREV;
    w.putLive("USA1", PREV, olderTo, "2026-09-24T08:00:00.000Z");
    const dw = makeDurable(); await seedDurable(dw, ACCOUNTS);
    bumpOli(dw, "2026-09-24T12:00:00.000Z");
    const ctx = makeCtx({ w, dw, bucket: "us-ca" });
    const scan = await ctx.run({ dryRun: true, accountIds: ["USA1"] });
    const s = await ctx.run({ dryRun: false, accountIds: ["USA1"] });
    const b = await ctx.runtime.resolveBundle(unitOf("USA1"), { strict: true, epoch: INV, bucket: "us-ca" });
    ok("M2 a served OLDER-`to` row holding a LATER inventory day (" + INV_NEXT + " > " + INV + ", older stamp, a newer unrelated OLI stamp) -> scan STALE 'served-older-to', the prepare defers 'bundle-superseded-newer-live:served-newer-inventory' (the resolve refuses it too), ZERO writes; the worker classes it superseded-newer-live",
      stateOf(scan, "USA1").state === RS.ST && stateOf(scan, "USA1").reason === "served-older-to" && stateOf(s, "USA1").state === RS.DD && stateOf(s, "USA1").reason === "bundle-superseded-newer-live:served-newer-inventory"
      && b.eligible === false && b.reason === "superseded-newer-live:served-newer-inventory" && w.writes() === 0 && w.n.liveCas === 0 && !w.live("USA1", SALES)
      && CLS.classifyDeferral("bundle-superseded-newer-live:served-newer-inventory").cls === CLS.CLASSES.SUPERSEDED_NEWER_LIVE);
    const w2 = makeWorld();
    w2.putLive("USA1", SALES, newer, "2026-09-24T08:00:00.000Z");
    const s2 = await makeCtx({ w: w2, dw, bucket: "us-ca" }).run({ dryRun: false, accountIds: ["USA1"] });
    ok("M2b the SAME newer-inventory row AT {to: salesAsOf} is PAID-OWNED -> 'superseded-newer-live:paid-owned' (ownership precedes the component order), ZERO writes", stateOf(s2, "USA1").state === RS.DD && stateOf(s2, "USA1").reason === "superseded-newer-live:paid-owned" && w2.writes() === 0 && w2.live("USA1", SALES).payload.rows[0].fbaAvailable === 555);
  }

  // M3: the SERVED row is an older-`to` row (so the predicate says STALE), but the exact live row at {to: salesAsOf} --
  // the CAS target -- is a PAID row: the prepare's resolve reads it and refuses (paid-owned).
  {
    const dw = makeDurable(); const seed = await seedDurable(dw, ACCOUNTS);
    const paidUs = await paidDerive(seed, dw, "USA1");
    const w = makeWorld();
    w.putLive("USA1", SALES, newer, "2026-09-24T08:00:00.000Z");
    const prev = clone(paidUs.result.payload); prev.asOf = PREV;
    w.putLive("USA1", PREV, prev, "2026-09-24T08:30:00.000Z"); // updated LATER -> the served (latest) row
    const ctx = makeCtx({ w, dw, bucket: "us-ca" });
    const scan = await ctx.run({ dryRun: true, accountIds: ["USA1"] });
    const s = await ctx.run({ dryRun: false, accountIds: ["USA1"] });
    ok("M3 served = an older-`to` row (scan STALE 'served-older-to'); the EXACT live row at {to: salesAsOf} is PAID-OWNED -> the prepare defers 'bundle-superseded-newer-live:paid-owned', ZERO writes (no cycle / job / shadow / CAS)", stateOf(scan, "USA1").state === RS.ST && stateOf(scan, "USA1").reason === "served-older-to"
      && stateOf(s, "USA1").state === RS.DD && stateOf(s, "USA1").reason === "bundle-superseded-newer-live:paid-owned" && w.writes() === 0 && w.n.liveCas === 0 && w.live("USA1", SALES).payload.rows[0].fbaAvailable === 555);
  }

  // M4: EQUAL inventory day on a served OLDER-`to` row (yesterday's sales as-of, today's inventory D-1 -- a realistic
  // paid row when OLI lags): fetched AFTER the durable pointer was validated (10:00 > 09:00), an OLI re-ack at 11:00.
  {
    const dw = makeDurable(); const seed = await seedDurable(dw, ACCOUNTS);
    const paidUs = await paidDerive(seed, dw, "USA1");
    const refetched = clone(paidUs.result.payload); refetched.rows[0].fbaAvailable = 777; refetched.inventoryFetchedAt = "2026-09-24T10:00:00.000Z"; refetched.asOf = PREV;
    const w = makeWorld();
    w.putLive("USA1", PREV, refetched, "2026-09-24T10:00:00.000Z");
    bumpOli(dw, "2026-09-24T11:00:00.000Z");
    const ctx = makeCtx({ w, dw, bucket: "us-ca" });
    const s = await ctx.run({ dryRun: false, accountIds: ["USA1"] });
    ok("M4 a served older-`to` row of the EQUAL inventory day fetched AFTER the durable pointer was validated (10:00 > 09:00) -> 'bundle-superseded-newer-live:served-newer-inventory', ZERO writes (the fill never hides newer inventory)", stateOf(s, "USA1").state === RS.DD && stateOf(s, "USA1").reason === "bundle-superseded-newer-live:served-newer-inventory" && w.writes() === 0 && !w.live("USA1", SALES));
    // M4b: the paid row AT {to: salesAsOf} with EQUAL content and a later fetch -> simply current (proof marker).
    const same = clone(paidUs.result.payload); same.inventoryFetchedAt = "2026-09-24T10:00:00.000Z";
    const wB = makeWorld();
    wB.putLive("USA1", SALES, same, "2026-09-24T10:00:00.000Z");
    const sB = await makeCtx({ w: wB, dw, bucket: "us-ca" }).run({ dryRun: false, accountIds: ["USA1"] });
    // M4c: the paid row AT {to: salesAsOf}, the SAME fetch, DIFFERENT content, a stamp >= the evidence -> paid-owned.
    const dwC = makeDurable(); const seedC = await seedDurable(dwC, ACCOUNTS);
    const diffC = clone((await paidDerive(seedC, dwC, "USA1")).result.payload); diffC.rows[0].fbaAvailable = 999;
    const wC = makeWorld();
    wC.putLive("USA1", SALES, diffC, "2026-09-24T10:00:00.000Z");
    const sC = await makeCtx({ w: wC, dw: dwC, bucket: "us-ca" }).run({ dryRun: false, accountIds: ["USA1"] });
    ok("M4b/c a PAID row at {to: salesAsOf} is never overwritten: equal content -> PUBLICATION_NOT_REQUIRED 'content-equivalent' (zero writes); different content -> 'superseded-newer-live:paid-owned' (zero writes)", stateOf(sB, "USA1").state === RS.NR && stateOf(sB, "USA1").reason === "content-equivalent" && wB.writes() === 0
      && stateOf(sC, "USA1").state === RS.DD && stateOf(sC, "USA1").reason === "superseded-newer-live:paid-owned" && wC.writes() === 0 && wC.live("USA1", SALES).payload.rows[0].fbaAvailable === 999);
  }

  // M5: AWD -- a served older-`to` row whose AWD came from a NEWER canonical Listings export than the durable Listings
  // pointer holds (awdFetchedAt 12:00 > validated_at 08:40), an OLI re-ack beats its stamp.
  {
    const dw = makeDurable(); const seed = await seedDurable(dw, ACCOUNTS);
    const paidUs = await paidDerive(seed, dw, "USA1");
    const awdNewer = clone(paidUs.result.payload); awdNewer.rows[0].awdAvailable = 123; awdNewer.awdFetchedAt = "2026-09-24T12:00:00.000Z"; awdNewer.asOf = PREV;
    const w = makeWorld();
    w.putLive("USA1", PREV, awdNewer, "2026-09-24T12:00:00.000Z");
    bumpOli(dw, "2026-09-24T13:00:00.000Z");
    const ctx = makeCtx({ w, dw, bucket: "us-ca" });
    const s = await ctx.run({ dryRun: false, accountIds: ["USA1"] });
    ok("M5 a served older-`to` row whose AWD came from a NEWER Listings fetch (12:00 > the durable Listings validated_at " + LST_FETCHED.slice(11, 16) + ") -> 'bundle-superseded-newer-live:served-newer-awd', ZERO writes", stateOf(s, "USA1").state === RS.DD && stateOf(s, "USA1").reason === "bundle-superseded-newer-live:served-newer-awd" && w.writes() === 0 && !w.live("USA1", SALES));
  }

  // M6: the PURE per-component order.
  {
    const r = (payloads, awd = LST_FETCHED) => FB.fbaPlanNewerLiveReason({ payloads, inventoryAsOf: INV, inventoryValidatedAt: FBA_VALIDATED, awdValidatedAt: awd });
    const p = (o) => ({ inventoryRequestedThrough: INV, inventoryDate: INV, inventoryFetchedAt: INV_FETCHED, awdFetchedAt: LST_FETCHED, ...o });
    ok("M6 fbaPlanNewerLiveReason: an older / equal day with an earlier-or-equal fetch is not newer; a later day (requested OR row date), a later same-day fetch, or a later AWD fetch is; an older day fetched LATER is not (the newer day wins); AWD is ignored when durable AWD is not used", r([]) === null && r([p({})]) === null && r([p({ inventoryFetchedAt: FBA_VALIDATED })]) === null
      && r([p({ inventoryRequestedThrough: INV_NEXT })]) === "served-newer-inventory" && r([p({ inventoryRequestedThrough: undefined, inventoryDate: INV_NEXT })]) === "served-newer-inventory"
      && r([p({ inventoryFetchedAt: "2026-09-24T09:00:00.001Z" })]) === "served-newer-inventory" && r([p({ inventoryRequestedThrough: PREV, inventoryDate: PREV, inventoryFetchedAt: "2026-09-25T01:00:00.000Z" })]) === null
      && r([p({ awdFetchedAt: "2026-09-24T08:40:00.001Z" })]) === "served-newer-awd" && r([p({ awdFetchedAt: "2026-09-24T08:40:00.001Z" })], null) === null && r([null, "x", p({})]) === null
      && FB.fbaPlanPayloadInventoryDay({ inventoryRequestedThrough: INV, inventoryDate: PREV }) === INV && FB.fbaPlanPayloadInventoryDay({ inventoryDate: "2026-02-30" }) === "");
  }
}

// =====================================================================================================================
// N. WP4-A: the content-equivalence PROOF marker -- verify-exact honours a paid-published equivalent row (no lineage)
// =====================================================================================================================
{
  const dw = makeDurable(); const seed = await seedDurable(dw, ACCOUNTS);
  const paidUs = await paidDerive(seed, dw, "USA1");
  const w = makeWorld();
  w.putLive("USA1", SALES, paidUs.result.payload, LST_FETCHED);
  const ctx = makeCtx({ w, dw, bucket: "us-ca" });
  const verdict = await ctx.runtime.currentPredicate(RK, unitOf("USA1"), { epoch: INV, bucket: "us-ca" });
  const live = w.live("USA1", SALES);
  ok("N1 the content-equivalent verdict carries { state: PUBLICATION_NOT_REQUIRED, proof: ROUTE_PROOF_CONTENT_EQUIVALENT, h, sra } of the SERVED row it read + compared", verdict.state === RS.NR && verdict.reason === "content-equivalent" && verdict.proof === REL.ROUTE_PROOF_CONTENT_EQUIVALENT && verdict.h === live.params_hash && verdict.sra === live.source_refreshed_at);
  const sN = await ctx.run({ dryRun: true, accountIds: ["USA1"] });
  const sV = await ctx.run({ dryRun: true, accountIds: ["USA1"], verifyExact: true });
  const sL = await ctx.run({ dryRun: false, accountIds: ["USA1"], verifyExact: true });
  ok("N1 buildRouteReconcileAdapter verifyExact:true: the PAID row (no route job / lineage) is PUBLICATION_NOT_REQUIRED in the normal scan, the verify-exact scan AND a LIVE verify-exact pass -- ZERO writes, zero CAS, zero controls", [sN, sV, sL].every((x) => stateOf(x, "USA1").state === RS.NR && stateOf(x, "USA1").reason === "content-equivalent" && stateOf(x, "USA1").served && stateOf(x, "USA1").served.h === live.params_hash)
    && w.jobs.length === 0 && w.writes() === 0 && w.n.liveCas === 0 && ctx.controls.length === 0);
  // N2: a content-DIFFERENT paid row: no proof -> FILL-ONLY 'superseded-newer-live:paid-owned' in both scans + a live pass.
  const diff = clone(paidUs.result.payload); diff.rows[0].fbaAvailable = 999;
  const w2 = makeWorld();
  w2.putLive("USA1", SALES, diff, "2026-09-24T08:00:00.000Z");
  const ctx2 = makeCtx({ w: w2, dw, bucket: "us-ca" });
  const v2 = await ctx2.runtime.currentPredicate(RK, unitOf("USA1"), { epoch: INV, bucket: "us-ca" });
  const d1 = await ctx2.run({ dryRun: true, accountIds: ["USA1"] });
  const d2 = await ctx2.run({ dryRun: true, accountIds: ["USA1"], verifyExact: true });
  const d3 = await ctx2.run({ dryRun: false, accountIds: ["USA1"], verifyExact: true });
  ok("N2 a content-DIFFERENT paid row carries NO proof and is DEFERRED 'superseded-newer-live:paid-owned' (never STALE -> never a CAS over paid data) in the normal scan, the verify-exact scan AND a LIVE verify-exact pass -- ZERO writes, zero CAS, zero controls", v2.state === RS.DD && v2.reason === "superseded-newer-live:paid-owned" && !("proof" in v2)
    && [d1, d2, d3].every((x) => stateOf(x, "USA1").state === RS.DD && stateOf(x, "USA1").reason === "superseded-newer-live:paid-owned") && w2.writes() === 0 && w2.n.liveCas === 0 && ctx2.controls.length === 0 && w2.live("USA1", SALES).payload.rows[0].fbaAvailable === 999);
}

// =====================================================================================================================
// O. WP4-B + the accountName drift decision: directory display labels are MASKED in the route's content verdict (no
//    timestamp exists to stamp them; a directory write instant is not data freshness) -- a label-only drift is current.
// =====================================================================================================================
{
  const dw = makeDurable(); const seed = await seedDurable(dw, ACCOUNTS);
  const paidUs = await paidDerive(seed, dw, "USA1");
  // O1: the PAID row's accountName (its DataDoe accounts GET label) differs from the durable directory's.
  const labeled = clone(paidUs.result.payload); labeled.accountName = "US One (DataDoe label)";
  const w = makeWorld();
  w.putLive("USA1", SALES, labeled, LST_FETCHED);
  const ctx = makeCtx({ w, dw, bucket: "us-ca" });
  const s1 = await ctx.run({ dryRun: false, accountIds: ["USA1"] });
  const s1v = await ctx.run({ dryRun: true, accountIds: ["USA1"], verifyExact: true });
  ok("O1 a paid row differing from the durable directory ONLY in accountName is current (normal + verify-exact), ZERO writes -- the drift is logged by label NAME only (never the value)", [s1, s1v].every((x) => stateOf(x, "USA1").state === RS.NR && stateOf(x, "USA1").reason === "content-equivalent") && w.writes() === 0 && w.n.liveCas === 0
    && ctx.logs.some((m) => /display label\(s\) \[accountName\]/.test(m)) && !ctx.logs.some((m) => m.includes("DataDoe label")));
  // O2: a directory RENAME after a ROUTE publish: the L1 token moves (B4), yet no republish and no NEWER_LIVE loop.
  const w2 = makeWorld();
  const ctxA = makeCtx({ w: w2, dw, bucket: "us-ca" });
  const p1 = await ctxA.run({ dryRun: false, accountIds: ["USA1"] });
  const writes = w2.writes(); const cas = w2.n.liveCas;
  const renamed = directoryOf(ACCOUNTS.map((a) => (a.accountId === "USA1" ? { ...a, name: "US Renamed" } : a)));
  const ctxB = makeCtx({ w: w2, dw, bucket: "us-ca", directory: renamed });
  const tokA = (await ctxA.runtime.readScopeEvidence({ scope: ["USA1"], epoch: INV, bucket: "us-ca", organizationFingerprint: ORG })).perAccount.get("USA1").token;
  const tokB = (await ctxB.runtime.readScopeEvidence({ scope: ["USA1"], epoch: INV, bucket: "us-ca", organizationFingerprint: ORG })).perAccount.get("USA1").token;
  const p2 = await ctxB.run({ dryRun: false, accountIds: ["USA1"] });
  const p2v = await ctxB.run({ dryRun: true, accountIds: ["USA1"], verifyExact: true });
  ok("O2 a directory rename after a route publish moves the token but is PUBLICATION_NOT_REQUIRED (normal + verify-exact) -- never a NEWER_LIVE 'evidence-not-newer-than-live' loop, never a flip-flop republish (zero writes, zero CAS)", stateOf(p1, "USA1").state === RS.RV && tokA !== tokB
    && [p2, p2v].every((x) => stateOf(x, "USA1").state === RS.NR && stateOf(x, "USA1").reason === "content-equivalent") && w2.writes() === writes && w2.n.liveCas === cas && ctxB.logs.some((m) => /display label\(s\) \[accountName\]/.test(m)));
  // O3: the pure verdict: stamps + labels masked; every derived field (isUS, rows, awd*) still compared; strict parity unchanged.
  const base = paidUs.result.payload;
  const mk = (f) => { const c = clone(base); f(c); return c; };
  const v = (x) => FB.fbaPlanRouteContentVerdict(x, base);
  ok("O3 fbaPlanRouteContentVerdict masks EXACTLY the two fetch stamps + the two directory labels (labelDrift names them); isUS / rows / awdEligible still differ; the strict parity check (fbaPlanContentEqual) still sees a label change", JSON.stringify(FB.FBA_PLAN_DIRECTORY_LABEL_KEYS) === '["accountName","marketCountry"]'
    && v(mk((c) => { c.inventoryFetchedAt = "x"; c.awdFetchedAt = "y"; })).equal === true && v(mk((c) => { c.inventoryFetchedAt = "x"; })).labelDrift.length === 0
    && JSON.stringify(v(mk((c) => { c.accountName = "Other"; c.marketCountry = "GB"; }))) === '{"equal":true,"labelDrift":["accountName","marketCountry"]}'
    && v(mk((c) => { c.isUS = false; })).equal === false && v(mk((c) => { c.rows[0].fbaAvailable += 1; })).equal === false && v(mk((c) => { c.awdEligible = false; })).equal === false
    && FB.fbaPlanContentEqual(mk((c) => { c.accountName = "Other"; }), base) === false && v(null).equal === false);
}

// =====================================================================================================================
// P. the scan-level evidence MEMO + AbortSignal threading (P3-3): one region read per scan; the TOCTOU re-reads stay fresh
// =====================================================================================================================
{
  const dw = makeDurable(); await seedDurable(dw, ACCOUNTS);
  const w = makeWorld();
  const ctx = makeCtx({ w, dw, bucket: "us-ca" });
  await ctx.run({ dryRun: false }); // publish both us-ca accounts
  const zero = () => { dw.n.sql = 0; dw.n.jobSql = 0; dw.n.cycleSql = 0; };
  zero();
  const scan = await ctx.run({ dryRun: true });
  const sqlScan = dw.n.sql - dw.n.jobSql - dw.n.cycleSql; const jobScan = dw.n.jobSql; const cycleScan = dw.n.cycleSql;
  zero();
  const verify = await ctx.run({ dryRun: true, verifyExact: true });
  ok("P1 a scan of the region reads the region evidence ONCE (4 statements, was 4 + 4 per account): the per-account current predicates use the scan-level memo; verify-exact likewise (the per-account newest-foreign-job + open-paid-cycle reads are ONE statement each per predicate, always fresh)", ["USA1", "CAA1"].every((a) => stateOf(scan, a).state === RS.NR && stateOf(verify, a).state === RS.NR) && sqlScan === W.FBA_PLAN_EVIDENCE_SQL.length && dw.n.sql - dw.n.jobSql - dw.n.cycleSql === W.FBA_PLAN_EVIDENCE_SQL.length
    && jobScan === 2 && dw.n.jobSql === 2 && cycleScan === 2 && dw.n.cycleSql === 2);

  const bumpCov = (d, iso) => { d.coverage.find((r) => r.account_id === "USA1").source_refreshed_at = new Date(iso); };
  const staleWorld = async () => {
    const d = makeDurable(); const seed = await seedDurable(d, ACCOUNTS);
    const diff = clone((await paidDerive(seed, d, "USA1")).result.payload); diff.rows[0].fbaAvailable = 999; diff.asOf = PREV;
    diff.inventoryRequestedThrough = PREV; diff.inventoryDate = PREV;
    const ww = makeWorld();
    // FILL-ONLY candidate: yesterday's PAID row is served ({to: PREV}); the paid path has not published {to: salesAsOf}.
    ww.putLive("USA1", PREV, diff, "2026-09-23T08:00:00.000Z");
    return { d, ww };
  };
  // P2: the evidence changes BETWEEN the prepare's two reads (after its derive) -> b2 is fresh -> deferral, zero writes.
  {
    const { d, ww } = await staleWorld();
    let fired = false;
    const c = makeCtx({ w: ww, dw: d, bucket: "us-ca", wrapRuntime: (rt) => ({ ...rt, derive: async (b, o) => { const r = await rt.derive(b, o); if (!fired) { fired = true; bumpCov(d, "2026-09-24T09:30:00.000Z"); } return r; } }) });
    const s = await c.run({ dryRun: false, accountIds: ["USA1"] });
    ok("P2 an evidence change between the prepare's b1 and b2 (after the derive) still defers 'revision-advanced-before-write' -- the memo never serves the prepare re-read; ZERO writes", fired && stateOf(s, "USA1").state === RS.DD && stateOf(s, "USA1").reason === "revision-advanced-before-write" && ww.writes() === 0 && ww.n.liveCas === 0);
  }
  // P3: the evidence changes AFTER the (memoized) predicate classified the unit STALE, BEFORE the prepare -> b1 is fresh.
  {
    const { d, ww } = await staleWorld();
    let fired = false;
    const c = makeCtx({ w: ww, dw: d, bucket: "us-ca", wrapRuntime: (rt) => ({ ...rt, currentPredicate: async (rk, u, x) => { const r = await rt.currentPredicate(rk, u, x); if (!fired) { fired = true; bumpCov(d, "2026-09-24T09:30:00.000Z"); } return r; } }) });
    const s = await c.run({ dryRun: false, accountIds: ["USA1"] });
    ok("P3 an evidence change after the memoized predicate (STALE 'served-older-to') and before the prepare defers 'revision-advanced-at-entry' (b1 re-reads fresh); ZERO writes", fired && stateOf(s, "USA1").state === RS.DD && stateOf(s, "USA1").reason === "revision-advanced-at-entry" && ww.writes() === 0);
  }
  // P4: the evidence changes between the prepare and the publish (inside the control window) -> the publish-time token
  // re-read (readScopeEvidence, always fresh) defers 'evidence-advanced' with ZERO live CAS.
  {
    const { d, ww } = await staleWorld();
    const c = makeCtx({ w: ww, dw: d, bucket: "us-ca", onOpenControls: async () => bumpCov(d, "2026-09-24T09:30:00.000Z") });
    const s = await c.run({ dryRun: false, accountIds: ["USA1"] });
    ok("P4 an evidence change between the prepare and the publish defers 'evidence-advanced' (the publish-time token re-read is fresh): zero live CAS, the served paid row untouched", stateOf(s, "USA1").state === RS.DD && stateOf(s, "USA1").reason === "evidence-advanced" && ww.n.liveCas === 0 && ww.n.liveWrite === 0 && !ww.live("USA1", SALES) && ww.live("USA1", PREV).payload.rows[0].fbaAvailable === 999);
  }
  // P5: ctx.signal threads through the predicate's served read + the bundle's served / exact-live reads; an aborted
  // signal stops the resolve (typed) and the evidence read.
  {
    const ac = new AbortController();
    ctx.signalsSeen.length = 0;
    const v1 = await ctx.runtime.currentPredicate(RK, unitOf("USA1"), { epoch: INV, bucket: "us-ca", signal: ac.signal });
    const seen = [...ctx.signalsSeen];
    ac.abort();
    const v2 = await ctx.runtime.currentPredicate(RK, unitOf("USA1"), { epoch: INV, bucket: "us-ca", signal: ac.signal });
    const b2 = await ctx.runtime.resolveBundle(unitOf("USA1"), { strict: true, epoch: INV, bucket: "us-ca", signal: ac.signal });
    const e2 = await ctx.runtime.readScopeEvidence({ scope: ["USA1"], epoch: INV, bucket: "us-ca", organizationFingerprint: ORG, signal: ac.signal });
    ok("P5 ctx.signal reaches every report_snapshots read of the predicate (served x2 + the exact live row); aborted -> the predicate defers 'bundle-aborted', resolveBundle 'aborted', readScopeEvidence FBA_PLAN_EVIDENCE_ABORTED", v1.state === RS.NR && seen.length >= 3 && seen.every((x) => x === ac.signal)
      && v2.state === RS.DD && v2.reason === "bundle-aborted" && b2.eligible === false && b2.reason === "aborted" && e2.ok === false && e2.failCode === "FBA_PLAN_EVIDENCE_ABORTED");
  }
}

// =====================================================================================================================
// Q. WP7 ROUNDS 2-3 under FILL-ONLY (the round-2 verifier's probeRace V1 / V2, probeEdge E4, probeTs):
//    P1 the publish-window race -> resolveBundle `guard` + publishGuard (inside the control lease, before the CAS);
//    P2 a pending / in-flight PAID job is protecting evidence (the publisher promotes ONLY the latest job);
//    P3-1 a same-day row's missing / naive fetch stamp fails CLOSED (row stamp upper bound, else fetch-unordered).
//    The base world is a FILL candidate (yesterday's PAID row served at {to: PREV}, nothing at {to: salesAsOf}): a paid
//    row AT {to: salesAsOf} is now paid-owned and never even prepared against (H / M / N).
// =====================================================================================================================
// A PAID scheduler fba-plan job for `acct` (its own cycle, NO route lineage), exactly as the probe seeds it: created,
// then (optionally) validated with its shadow + reconciled + its cycle finalized. Returns the job's shadow hash + cycle.
// `to` overrides the shadow's sales as-of (the paid job's own go-live as-of); `cycleDate` its cycle_date (= its
// inventoryAsOf in production).
async function createPaidJob(w, paid, acct, { cycleBucket = "us-ca-fba", bucket = "us-ca", to = null, cycleDate = INV } = {}) {
  const params = { reportVersion: REPORT_DERIVATIONS[RK].snapshotVersion, accountId: acct, ...paid.req.context, ...(to ? { to } : {}) };
  const h = paramsHashFor(params.reportVersion, params);
  await w.openCycle({ bucket: cycleBucket, cycleDate });
  const cyc = await w.getCycleByBucketDate(cycleBucket, cycleDate);
  await w.claimCycle(cyc.id);
  await w.upsertReportJob({ cycleId: cyc.id, reportKey: RK, reportVersion: params.reportVersion, accountId: acct, connectionId: "primary", bucket, dependsOn: ["paid-inv-hash"], durableContentDeps: [] });
  return { h, params, cycleId: cyc.id, acct };
}
async function completePaidJob(w, pj, payload, stamp, { finalize = true } = {}) {
  const lease = await w.claimLease(pj.cycleId, RK, pj.acct, {});
  const cas = await w.saveShadow({ reportKey: "scheduler-v2/" + RK, accountId: pj.acct, paramsHash: pj.h, params: pj.params, payload, sourceRefreshedAt: stamp });
  const rec = await w.reconcileSuccess({ cycleId: pj.cycleId, reportKey: RK, accountId: pj.acct, snapshotParamsHash: pj.h, leaseToken: lease.leaseToken });
  const fin = finalize ? await w.finalizeCycle({ cycleId: pj.cycleId }) : null;
  return { cas: cas.outcome, rec: rec.disposition, fin: fin && fin.disposition };
}
const seedPaidJob = async (w, paid, acct, payload, stamp, opts = {}) => { const pj = await createPaidJob(w, paid, acct, opts); return { ...pj, ...(await completePaidJob(w, pj, payload, stamp)) }; };
const routeWrites = (w, before) => w.writes() - before;
const T10 = "2026-09-24T10:00:00.000Z";
const bumpOliQ = (dw, iso) => { dw.coverage.find((r) => r.account_id === "USA1").source_refreshed_at = new Date(iso); };
// THE FILL WORLD: yesterday's PAID row served at {to: PREV} (older sales day AND older inventory day), nothing at
// {to: salesAsOf}; c2 = a paid NEWER same-day re-fetch of the current D-1 (fetch 10:00 > the durable pointer's 09:00).
const fillWorld = async () => {
  const dw = makeDurable(); const seed = await seedDurable(dw, ACCOUNTS);
  const paid = await paidDerive(seed, dw, "USA1");
  const prev = clone(paid.result.payload); prev.rows[0].fbaAvailable = 1; prev.asOf = PREV; prev.inventoryRequestedThrough = PREV; prev.inventoryDate = PREV;
  prev.inventoryFetchedAt = "2026-09-23T08:30:00.000Z"; prev.awdFetchedAt = "2026-09-23T08:40:00.000Z";
  const c2 = clone(paid.result.payload); c2.rows[0].fbaAvailable = 777; c2.inventoryFetchedAt = T10;
  const w = makeWorld();
  w.putLive("USA1", PREV, prev, "2026-09-23T08:40:00.000Z");
  return { dw, seed, paid, prev, c2, w };
};
{
  const bumpOli = bumpOliQ;

  // ---- Q1 (P1): the resolve's guard components + prepared.guard + the b1 / b2 equality -------------------------------
  {
    const dw = makeDurable(); await seedDurable(dw, ACCOUNTS);
    dw.listings.delete("UKA1");
    const us = await makeCtx({ w: makeWorld(), dw, bucket: "us-ca" }).runtime.resolveBundle(unitOf("USA1"), { strict: true, epoch: INV, bucket: "us-ca" });
    const ca = await makeCtx({ w: makeWorld(), dw, bucket: "us-ca" }).runtime.resolveBundle(unitOf("CAA1"), { strict: true, epoch: INV, bucket: "us-ca" });
    const uk = await makeCtx({ w: makeWorld(), dw, bucket: "europe-au" }).runtime.resolveBundle(unitOf("UKA1"), { strict: true, epoch: INV, bucket: "europe-au" });
    ok("Q1 resolveBundle returns `guard` = EXACTLY the fill-only components as canonical instants: US { salesAsOf, inventoryAsOf, fbaValidatedAt, awdValidatedAt (durable Listings), awdApplicable:true, foreignJobId:null, refusedPaidDigest:null }; CA awd null / not applicable; UK without durable AWD awd null / applicable (the EU5 regression guard applies at publish)",
      JSON.stringify(us.guard) === JSON.stringify({ salesAsOf: SALES, inventoryAsOf: INV, fbaValidatedAt: FBA_VALIDATED, awdValidatedAt: LST_FETCHED, awdApplicable: true, foreignJobId: null, refusedPaidDigest: null })
      && JSON.stringify(ca.guard) === JSON.stringify({ salesAsOf: SALES, inventoryAsOf: INV, fbaValidatedAt: FBA_VALIDATED, awdValidatedAt: null, awdApplicable: false, foreignJobId: null, refusedPaidDigest: null })
      && JSON.stringify(uk.guard) === JSON.stringify({ salesAsOf: SALES, inventoryAsOf: INV, fbaValidatedAt: FBA_VALIDATED, awdValidatedAt: null, awdApplicable: true, foreignJobId: null, refusedPaidDigest: null }));
    // prepared.guard reaches publishGuard (JSON round-trip of b1.guard) on a normal fresh publish.
    const w = makeWorld();
    const seen = [];
    let leaseChecks = 0;
    const verify = w.verifyLease; w.verifyLease = async (a) => { leaseChecks += 1; return verify(a); };
    const ctx = makeCtx({ w, dw, bucket: "us-ca", wrapRuntime: (rt) => ({ ...rt, publishGuard: async (u, p, x) => { seen.push({ guard: clone(p.guard), preflight: w.n.preflight, leaseChecks, publish: w.n.publish, casBefore: w.n.liveCas }); return rt.publishGuard(u, p, x); } }) });
    const s = await ctx.run({ dryRun: false, accountIds: ["USA1"] });
    ok("Q1 the prepared result carries prepared.guard === the resolve's guard into publishGuard, which runs AFTER preflight 'ready' + verifyLease and BEFORE the one publish / CAS; a normal fill proceeds (null) -> READBACK_VERIFIED (no regression)", stateOf(s, "USA1").state === RS.RV && seen.length === 1
      && JSON.stringify(seen[0].guard) === JSON.stringify(us.guard) && seen[0].preflight === 1 && seen[0].leaseChecks === 1 && seen[0].publish === 0 && seen[0].casBefore === 0 && w.n.publish === 1 && w.n.liveCas === 1);
    // A guard component that moves between b1 and b2 WITHOUT moving the token (a same-content FBA re-persist: same sha, a
    // new validated_at -- validated_at is not in the L1 token) -> the release's b1 / b2 guard equality defers.
    const f = await fillWorld();
    let fired = false;
    const ctx2 = makeCtx({ w: f.w, dw: f.dw, bucket: "us-ca", wrapRuntime: (rt) => ({ ...rt, derive: async (b, o) => { const r = await rt.derive(b, o); if (!fired) { fired = true; f.dw.fba.get("USA1").validated_at = new Date("2026-09-24T09:05:00.000Z"); } return r; } }) });
    const tokBefore = (await ctx2.runtime.readScopeEvidence({ scope: ["USA1"], epoch: INV, bucket: "us-ca", organizationFingerprint: ORG })).perAccount.get("USA1").token;
    const s2 = await ctx2.run({ dryRun: false, accountIds: ["USA1"] });
    const tokAfter = (await ctx2.runtime.readScopeEvidence({ scope: ["USA1"], epoch: INV, bucket: "us-ca", organizationFingerprint: ORG })).perAccount.get("USA1").token;
    ok("Q1 a guard component moving between b1 and b2 with an UNCHANGED token (FBA validated_at re-stamped, same sha) defers 'revision-advanced-before-write' -- ZERO writes", fired && tokBefore === tokAfter && stateOf(s2, "USA1").state === RS.DD && stateOf(s2, "USA1").reason === "revision-advanced-before-write" && f.w.writes() === 0 && f.w.n.liveCas === 0);
  }

  // ---- Q2 (P1): the publish-window race -- a PAID row lands AFTER the prepare, BEFORE the CAS -------------------------
  {
    const landAtOpen = async ({ drop = false, land }) => {
      const f = await fillWorld();
      bumpOli(f.dw, "2026-09-24T11:00:00.000Z");
      const ctx = makeCtx({ w: f.w, dw: f.dw, bucket: "us-ca", onOpenControls: async () => land(f.w, f.c2), wrapRuntime: drop ? (rt) => { const { publishGuard, ...rest } = rt; return rest; } : null });
      const s = await ctx.run({ dryRun: false, accountIds: ["USA1"] });
      return { s, w: f.w, ctx };
    };
    // (a) the probe V1 shape: the paid NEWER same-day C2 (fetch 10:00, stamp 10:00) becomes the exact row at {to: salesAsOf}.
    const exactLand = (w, c2) => { w.putLive("USA1", SALES, c2, T10); };
    const g = await landAtOpen({ land: exactLand });
    const live = g.w.live("USA1", SALES);
    ok("Q2 (probeRace V1) a PAID row (fetch 10:00, stamp 10:00) lands on the exact identity {to: salesAsOf} between the prepare and the CAS -> publishGuard NEWER_LIVE 'superseded-newer-live:paid-owned' with ZERO live CAS; the paid row is intact",
      stateOf(g.s, "USA1").state === RS.DD && stateOf(g.s, "USA1").reason === "superseded-newer-live:paid-owned" && g.w.n.liveCas === 0 && g.w.n.liveWrite === 0 && g.w.n.publish === 0
      && live.payload.rows[0].fbaAvailable === 777 && live.payload.inventoryFetchedAt === T10 && live.source_refreshed_at === T10
      && CLS.classifyDeferral(stateOf(g.s, "USA1").reason).cls === CLS.CLASSES.SUPERSEDED_NEWER_LIVE);
    // The contrast: an OLDER-stamped paid row (08:50 < the route's evidence instant 09:00) lands; WITHOUT publishGuard
    // the fenced IfNewer CAS would REPLACE it -- the guard (ownership, never a stamp race) is what stops it.
    const olderLand = (w, c2) => { w.putLive("USA1", SALES, c2, "2026-09-24T08:50:00.000Z"); };
    const og = await landAtOpen({ land: olderLand });
    const nog = await landAtOpen({ land: olderLand, drop: true });
    ok("Q2 contrast: an OLDER-stamped paid row (08:50) landing at the exact identity -> WITH publishGuard 'superseded-newer-live:paid-owned', zero CAS; WITHOUT it the fenced CAS (route stamp 09:00 > 08:50) OVERWRITES the paid row -- ownership, not the stamp, protects paid data",
      stateOf(og.s, "USA1").reason === "superseded-newer-live:paid-owned" && og.w.n.liveCas === 0 && og.w.live("USA1", SALES).payload.rows[0].fbaAvailable === 777
      && nog.w.n.liveCas === 1 && nog.w.live("USA1", SALES).payload.rows[0].fbaAvailable !== 777 && nog.w.live("USA1", SALES).source_refreshed_at === FBA_VALIDATED);
    // (b) the paid job publishes a NEWER sales as-of (the exact-today identity) before the CAS -> served-newer-to.
    const toG = await landAtOpen({ land: (w, c2) => { const p = clone(c2); p.asOf = TODAY; w.putLive("USA1", TODAY, p, T10); } });
    ok("Q2 (T1b at publish) a paid row at a NEWER sales as-of (" + TODAY + " > " + SALES + ") becomes the served row before the CAS -> NEWER_LIVE 'superseded-newer-live:served-newer-to', ZERO CAS, nothing written at {to: salesAsOf}", stateOf(toG.s, "USA1").state === RS.DD && stateOf(toG.s, "USA1").reason === "superseded-newer-live:served-newer-to" && toG.w.n.liveCas === 0 && !toG.w.live("USA1", SALES));
    // (c) the SERVED row (not the CAS target): a later-updated {to: PREV} row carrying a NEWER inventory day.
    const servedG = await landAtOpen({ land: (w, c2) => { const p = clone(c2); p.asOf = PREV; p.inventoryRequestedThrough = "2026-09-25"; p.inventoryDate = "2026-09-25"; w.putLive("USA1", PREV, p, "2026-09-24T09:30:00.000Z"); } });
    ok("Q2 a newer inventory DAY landing on the SERVED row (a later {to: " + PREV + "} row) -> publishGuard NEWER_LIVE 'superseded-newer-live:served-newer-inventory', ZERO CAS", stateOf(servedG.s, "USA1").state === RS.DD && stateOf(servedG.s, "USA1").reason === "superseded-newer-live:served-newer-inventory" && servedG.w.n.liveCas === 0 && !servedG.w.live("USA1", SALES));
    // (d) EU5 without durable AWD: a paid awdAvailable:true row lands at the exact identity -> paid-owned (never "no AWD").
    {
      const dw = makeDurable(); const seed = await seedDurable(dw, ACCOUNTS);
      const paidUk = await paidDerive(seed, dw, "UKA1");
      dw.listings.delete("UKA1");
      const w = makeWorld();
      const ctx = makeCtx({ w, dw, bucket: "europe-au", onOpenControls: async () => { w.putLive("UKA1", SALES, paidUk.result.payload, "2026-09-24T08:45:00.000Z"); } });
      const s = await ctx.run({ dryRun: false, accountIds: ["UKA1"] });
      ok("Q2 EU5 (UK) with NO durable AWD: a paid awdAvailable:true row landing on the exact identity before the CAS -> publishGuard 'superseded-newer-live:paid-owned', ZERO CAS; the paid AWD row is intact", paidUk.result.payload.awdAvailable === true && stateOf(s, "UKA1").state === RS.DD && stateOf(s, "UKA1").reason === "superseded-newer-live:paid-owned" && w.n.liveCas === 0 && w.live("UKA1", SALES).payload.awdAvailable === true);
    }
    // (e) ROUTE-OVER-ROUTE race: the route's own row is live; its evidence moves; the paid publish lands on the exact
    // identity (replacing the route row) before the route's replacement CAS -> the fresh exact row is now paid-owned.
    {
      const f = await fillWorld();
      const ctx = makeCtx({ w: f.w, dw: f.dw, bucket: "us-ca" });
      const s1 = await ctx.run({ dryRun: false, accountIds: ["USA1"] });
      const rows = clone(f.dw.storage.get(f.dw.fba.get("USA1").object_path).rows); rows[0].available = 42;
      rewritePointer(f.dw, "fba", "USA1", rows, { validated_at: new Date("2026-09-24T10:30:00.000Z") });
      f.w.tick(60000);
      const casBefore = f.w.n.liveCas;
      const ctxB = makeCtx({ w: f.w, dw: f.dw, bucket: "us-ca", onOpenControls: async () => { f.w.putLive("USA1", SALES, f.c2, "2026-09-24T10:45:00.000Z"); } });
      const s2 = await ctxB.run({ dryRun: false, accountIds: ["USA1"] });
      ok("Q2 route-over-route race: the route's own row is live (READBACK_VERIFIED), its FBA evidence moves, a PAID publish replaces the exact row before the route's replacement CAS -> publishGuard 'superseded-newer-live:paid-owned', ZERO CAS; the paid row stays", stateOf(s1, "USA1").state === RS.RV && stateOf(s2, "USA1").state === RS.DD && stateOf(s2, "USA1").reason === "superseded-newer-live:paid-owned" && f.w.n.liveCas === casBefore && f.w.live("USA1", SALES).payload.rows[0].fbaAvailable === 777);
    }
  }

  // ---- Q3 (P1): publishGuard is typed + fail closed (direct calls against a published world) ----------------------------
  {
    const dw = makeDurable(); await seedDurable(dw, ACCOUNTS);
    const w = makeWorld();
    const ctx = makeCtx({ w, dw, bucket: "us-ca" });
    await ctx.run({ dryRun: false, accountIds: ["USA1"] });
    const job = w.jobs.find((j) => j.account_id === "USA1");
    const b = await ctx.runtime.resolveBundle(unitOf("USA1"), { strict: true, epoch: INV, bucket: "us-ca" });
    const prep = (over = {}) => ({ guard: clone(b.guard), shadowParamsHash: job.snapshot_params_hash, ...over });
    const pg = (p, u = unitOf("USA1"), rt = ctx.runtime) => rt.publishGuard(u, p, { epoch: INV, bucket: "us-ca" });
    const sb = ctx.deps.sb;
    const swap = async (name, fn, body) => { const keep = sb[name]; sb[name] = fn; try { return await body(); } finally { sb[name] = keep; } };
    const unattested = makeCtx({ w, dw, bucket: "us-ca", env: {} });
    const got = {
      current: await pg(prep()),
      noGuard: await pg(prep({ guard: undefined })),
      badGuard: await pg(prep({ guard: { ...clone(b.guard), fbaValidatedAt: "" } })),
      badForeign: await pg(prep({ guard: { ...clone(b.guard), foreignJobId: "" } })),
      asOf: await pg(prep(), unitOf("USA1", PREV)),
      notOurs: await pg(prep({ shadowParamsHash: "someone-else" })),
      raced: await pg(prep({ guard: { ...clone(b.guard), foreignJobId: "job-seen-by-resolve" } })),
      jobThrows: await swap("getLatestReportJobLineage", async () => { throw new Error("rest down"); }, () => pg(prep())),
      snapThrows: await swap("getReportSnapshot", async (a) => { if (a.reportKey === RK) throw new Error("rest down"); return w.readSnapshot(a); }, () => pg(prep())),
      notAttested: await pg(prep(), unitOf("USA1"), unattested.runtime),
    };
    dw.failJobSql = true;
    got.foreignThrows = await pg(prep());
    dw.failJobSql = false;
    // The exact live row's payload is unreadable (a storage path with no hydration reader).
    const liveRow = w.live("USA1", SALES); const keepPath = liveRow.payload_storage_path; liveRow.payload_storage_path = "reports/x.json";
    got.exactUnreadable = await pg(prep());
    liveRow.payload_storage_path = keepPath;
    const n = (v) => (v == null ? null : v.state + ":" + v.reason);
    ok("Q3 publishGuard is typed + FAIL CLOSED: the published state proceeds (null); a missing / malformed guard (incl. a blank foreignJobId) -> 'publish-guard:guard-missing'; a unit bound at another as-of -> 'publish-guard:guard-mismatch'; a latest job that is not this prepared derivation -> 'publish-guard:lineage-advanced'; a newest foreign job the resolve did not see -> 'paid-job-raced-insert'; an unreadable latest / foreign job -> 'inventory-guard:paid-lineage-unreadable'; an unreadable served / exact row -> 'inventory-guard:served-unreadable' / ':live-unreadable'; an UNATTESTED build -> 'fba-plan-route-fence-not-attested' (all DEFERRED_DEPENDENCY)",
      JSON.stringify(Object.fromEntries(Object.entries(got).map(([k, v]) => [k, n(v)]))) === JSON.stringify({
        current: null, noGuard: RS.DD + ":publish-guard:guard-missing", badGuard: RS.DD + ":publish-guard:guard-missing", badForeign: RS.DD + ":publish-guard:guard-missing", asOf: RS.DD + ":publish-guard:guard-mismatch",
        notOurs: RS.DD + ":publish-guard:lineage-advanced", raced: RS.DD + ":paid-job-raced-insert", jobThrows: RS.DD + ":inventory-guard:paid-lineage-unreadable", snapThrows: RS.DD + ":inventory-guard:served-unreadable",
        notAttested: RS.DD + ":fba-plan-route-fence-not-attested", foreignThrows: RS.DD + ":inventory-guard:paid-lineage-unreadable", exactUnreadable: RS.DD + ":inventory-guard:live-unreadable",
      }));
    const mapped = REL.publishGuardResult({ state: "NEWER_LIVE", reason: "superseded-newer-live:paid-owned" });
    ok("Q3 the release maps a NEWER_LIVE verdict EXACTLY (stage publish, status NEWER_LIVE, the route's /newer-live/ reason kept) and the worker classes it superseded-newer-live; a deferral stays DEFERRED_DEPENDENCY", REL.PUBLISH_GUARD_STATES.includes("NEWER_LIVE") && mapped.status === "NEWER_LIVE" && mapped.stage === "publish" && mapped.reason === "superseded-newer-live:paid-owned"
      && CLS.classifyDeferral(mapped.reason).cls === CLS.CLASSES.SUPERSEDED_NEWER_LIVE && REL.publishGuardResult({ state: RS.DD, reason: "paid-job-raced-insert" }).stage === "reconcile");
  }

  // ---- Q4 (P2): probeRace V1 + V2 -- a PENDING paid publish (validated job, shadow not live) at >= salesAsOf ------------
  for (const variant of ["V1-paid-publish-after-b2", "V2-paid-publish-at-openControls"]) {
    const { dw, paid, c2, w } = await fillWorld();
    const pj = await seedPaidJob(w, paid, "USA1", c2, T10);
    bumpOli(dw, "2026-09-24T11:00:00.000Z");
    const before = w.writes();
    let resolves = 0; let fired = false;
    const paidPublish = async () => { fired = true; await w.publisherFor(null).publish(RK, "USA1"); };
    const ctx = makeCtx({
      w, dw, bucket: "us-ca",
      wrapRuntime: (rt) => ({ ...rt, resolveBundle: async (u, o) => { const r = await rt.resolveBundle(u, o); resolves += 1; if (variant.startsWith("V1") && resolves === 2) await paidPublish(); return r; } }),
      onOpenControls: async () => { if (variant.startsWith("V2")) await paidPublish(); },
    });
    const s = await ctx.run({ dryRun: false, accountIds: ["USA1"] });
    const st1 = stateOf(s, "USA1");
    ok(`Q4 (probeRace ${variant}) a validated PAID job whose shadow is at {to: salesAsOf} and not yet live -> the prepare defers 'bundle-superseded-newer-live:paid-publish-pending:to' (the paid path is publishing this D-1): ZERO route writes (no cycle / job / shadow / CAS); the paid job stays the LATEST job`,
      pj.fin === "finalized" && st1.state === RS.DD && st1.reason === "bundle-superseded-newer-live:paid-publish-pending:to" && routeWrites(w, before) === 0 && w.n.liveCas === 0 && !fired
      && w.jobs.length === 1 && w.jobs[0].snapshot_params_hash === pj.h && !w.live("USA1", SALES) && CLS.classifyDeferral(st1.reason).cls === CLS.CLASSES.SUPERSEDED_NEWER_LIVE);
    const r = await w.publisherFor(null).publish(RK, "USA1");
    const live = w.live("USA1", SALES);
    ok(`Q4 (${variant}) ... and the paid run's publish then publishes its OWN shadow C2 (fbaAvailable 777, fetch 10:00, stamp 10:00, no route tokens)`, r.disposition === "published" && live.payload.rows[0].fbaAvailable === 777 && live.payload.inventoryFetchedAt === T10 && live.source_refreshed_at === T10 && !("evidenceToken" in live.params));
    const s2 = await ctx.run({ dryRun: false, accountIds: ["USA1"] });
    ok(`Q4 (${variant}) ... after which the route sees the PAID-OWNED exact row: 'superseded-newer-live:paid-owned', still ZERO route writes (the ONE write since the seed is the paid publish)`, stateOf(s2, "USA1").reason === "superseded-newer-live:paid-owned" && routeWrites(w, before) === 1 && w.n.liveWrite === 1 && w.jobs.length === 1 && w.n.cycleCreate === 1);
  }
  // Q4b: the SAME pending paid job with NO live row at all -> the prepare's resolve refuses it before any write.
  {
    const { dw, paid, c2 } = await fillWorld();
    const w = makeWorld();
    await seedPaidJob(w, paid, "USA1", c2, T10);
    const before = w.writes();
    const s = await makeCtx({ w, dw, bucket: "us-ca" }).run({ dryRun: false, accountIds: ["USA1"] });
    ok("Q4b a pending paid shadow at {to: salesAsOf} with NO live row (predicate STALE) -> the prepare defers 'bundle-superseded-newer-live:paid-publish-pending:to', ZERO writes", stateOf(s, "USA1").state === RS.DD && stateOf(s, "USA1").reason === "bundle-superseded-newer-live:paid-publish-pending:to" && routeWrites(w, before) === 0 && w.jobs.length === 1);
  }

  // ---- Q5 (P2): a pending paid shadow at >= salesAsOf ALWAYS blocks; an OLDER-to, not-newer one never does ------------
  {
    const { dw, paid, w } = await fillWorld();
    const stalePaid = clone(paid.result.payload); stalePaid.rows[0].fbaAvailable = 3; // fetch 08:30 < the pointer's 09:00
    await seedPaidJob(w, paid, "USA1", stalePaid, "2026-09-24T08:45:00.000Z");
    const s = await makeCtx({ w, dw, bucket: "us-ca" }).run({ dryRun: false, accountIds: ["USA1"] });
    ok("Q5 FILL-ONLY: a pending paid shadow AT {to: salesAsOf} blocks even when its inventory fetch (08:30) is OLDER than the durable pointer (09:00) -- the paid path owns this D-1: 'bundle-superseded-newer-live:paid-publish-pending:to', ZERO route writes", stateOf(s, "USA1").state === RS.DD && stateOf(s, "USA1").reason === "bundle-superseded-newer-live:paid-publish-pending:to" && w.jobs.length === 1 && !w.live("USA1", SALES));
  }
  {
    const { dw, paid, c2, w } = await fillWorld();
    // A pending paid shadow at an OLDER sales as-of (PREV) whose inventory day / AWD fetch are older (a paid run of
    // yesterday that never published) does not block the fill.
    const olderPaid = clone(paid.result.payload); olderPaid.rows[0].fbaAvailable = 3; olderPaid.asOf = PREV; olderPaid.inventoryRequestedThrough = PREV; olderPaid.inventoryDate = PREV; olderPaid.inventoryFetchedAt = "2026-09-23T08:50:00.000Z"; olderPaid.awdFetchedAt = "2026-09-23T08:50:00.000Z";
    const pj = await seedPaidJob(w, paid, "USA1", olderPaid, "2026-09-23T09:00:00.000Z", { to: PREV, cycleDate: PREV });
    const s = await makeCtx({ w, dw, bucket: "us-ca" }).run({ dryRun: false, accountIds: ["USA1"] });
    const live = w.live("USA1", SALES);
    const r = await w.publisherFor(null).publish(RK, "USA1");
    ok("Q5 a pending paid shadow at an OLDER sales as-of (" + PREV + ") with older components does not block: the route FILLS {to: salesAsOf} (READBACK_VERIFIED) and its job becomes the latest; a later paid publish then promotes the latest = the ROUTE shadow ('already-current') -- the older paid shadow never reaches live",
      stateOf(s, "USA1").state === RS.RV && live.params.evidenceToken && live.payload.inventoryFetchedAt === FBA_VALIDATED && w.jobs.length === 2 && w.jobs[1].snapshot_params_hash !== pj.h
      && r.disposition === "already-current" && w.live("USA1", PREV).payload.rows[0].fbaAvailable === 1);
    // ... and a paid job created AFTER the route's job is the latest: the paid run promotes its OWN newer shadow over the
    // route row (its fresh fetch stamp 10:00 out-ranks the route's FBA-only stamp 09:00), after which the route defers.
    const later = await createPaidJob(w, paid, "USA1", { cycleBucket: "us-ca-fba-2" });
    await completePaidJob(w, later, c2, T10);
    const r2 = await w.publisherFor(null).publish(RK, "USA1");
    const s2 = await makeCtx({ w, dw, bucket: "us-ca" }).run({ dryRun: false, accountIds: ["USA1"] });
    ok("Q5 a paid job created AFTER the route's job is the latest -> the paid run publishes its OWN newer shadow over the route row (published, fbaAvailable 777, no route tokens); the route then defers 'superseded-newer-live:paid-owned'", r2.disposition === "published" && w.live("USA1", SALES).payload.rows[0].fbaAvailable === 777 && !("evidenceToken" in w.live("USA1", SALES).params)
      && stateOf(s2, "USA1").reason === "superseded-newer-live:paid-owned");
  }

  // ---- Q6 (P2): a paid job IN FLIGHT defers (retryable, never superseded); a failed one / the route's own does not -------
  {
    const { dw, paid, c2, w } = await fillWorld();
    const pj = await createPaidJob(w, paid, "USA1");
    const before = w.writes();
    const ctx = makeCtx({ w, dw, bucket: "us-ca" });
    const s = await ctx.run({ dryRun: false, accountIds: ["USA1"] });
    ok("Q6 a PAID job still in flight on the current epoch (created, not validated, its cycle running, cycle_date = the epoch) -> 'bundle-paid-job-in-flight' (DEFERRED_DEPENDENCY, never superseded -- a paid run that later fails must not strand the repair); ZERO route writes",
      stateOf(s, "USA1").state === RS.DD && stateOf(s, "USA1").reason === "bundle-paid-job-in-flight" && routeWrites(w, before) === 0 && w.n.liveCas === 0
      && CLS.classifyDeferral("paid-job-in-flight").cls !== CLS.CLASSES.SUPERSEDED_NEWER_LIVE && CLS.classifyDeferral("bundle-paid-job-in-flight").cls !== CLS.CLASSES.SUPERSEDED_NEWER_LIVE);
    await completePaidJob(w, pj, c2, T10);
    const r = await w.publisherFor(null).publish(RK, "USA1");
    ok("Q6 ... the paid job then completes and its own publish promotes ITS newer shadow (the route never inserted a job over it)", r.disposition === "published" && w.live("USA1", SALES).payload.rows[0].fbaAvailable === 777);
    // A FAILED paid job (derive failed; its cycle terminal 'partial') is not pending: the route fills.
    const x = await fillWorld();
    const pf = await createPaidJob(x.w, x.paid, "USA1");
    x.w.jobs.find((j) => j.cycle_id === pf.cycleId).derive_status = "failed";
    await x.w.finalizeCycle({ cycleId: pf.cycleId });
    const sf = await makeCtx({ w: x.w, dw: x.dw, bucket: "us-ca" }).run({ dryRun: false, accountIds: ["USA1"] });
    // The route's OWN not-yet-promotable lineage (current-version token + manifest content deps, e.g. a crashed prepare
    // of an older revision) is never 'foreign in flight': the generic release re-nonces over it and publishes.
    const lineageWorld = async (tokPrefix) => {
      const y = await fillWorld();
      await y.w.openCycle({ bucket: "priority-partial-us-ca-0123456789abcdef", cycleDate: INV });
      const yc = await y.w.getCycleByBucketDate("priority-partial-us-ca-0123456789abcdef", INV);
      await y.w.claimCycle(yc.id);
      await y.w.upsertReportJob({ cycleId: yc.id, reportKey: RK, reportVersion: "fba-plan/v2d-5", accountId: "USA1", connectionId: "primary", bucket: "us-ca", dependsOn: ["x"], durableContentDeps: [tokPrefix + "0".repeat(64), FB.FBA_PLAN_MANIFEST_PREFIX + "0".repeat(64)] });
      return makeCtx({ w: y.w, dw: y.dw, bucket: "us-ca" }).run({ dryRun: false, accountIds: ["USA1"] });
    };
    const sy = await lineageWorld(W.FBA_PLAN_TOKEN_PREFIX);
    const sOld = await lineageWorld("fp1:");
    ok("Q6 contrast: a FAILED paid job (terminal cycle) and the route's OWN in-flight lineage (" + W.FBA_PLAN_TOKEN_PREFIX + " tokens) never block -- both fill (READBACK_VERIFIED); an OLDER token version's in-flight job (fp1:) is FOREIGN (fail closed: 'bundle-paid-job-in-flight')", stateOf(sf, "USA1").state === RS.RV && stateOf(sy, "USA1").state === RS.RV
      && stateOf(sOld, "USA1").state === RS.DD && stateOf(sOld, "USA1").reason === "bundle-paid-job-in-flight");
  }

  // ---- Q7 (P2): a pending paid AWD shadow at >= salesAsOf blocks the EU5 fill; an unreadable foreign-job read fails closed
  {
    const dw = makeDurable(); const seed = await seedDurable(dw, ACCOUNTS);
    const paidUk = await paidDerive(seed, dw, "UKA1");
    dw.listings.delete("UKA1");
    const w = makeWorld();
    await seedPaidJob(w, paidUk, "UKA1", paidUk.result.payload, "2026-09-24T08:45:00.000Z", { bucket: "europe-au", cycleBucket: "europe-au-fba" });
    const before = w.writes();
    const s = await makeCtx({ w, dw, bucket: "europe-au" }).run({ dryRun: false, accountIds: ["UKA1"] });
    const rw = routeWrites(w, before);
    const r = await w.publisherFor(null).publish(RK, "UKA1");
    ok("Q7 EU5 (UK) without durable AWD + a PENDING paid shadow with awdAvailable:true at {to: salesAsOf} (nothing live yet) -> 'bundle-superseded-newer-live:paid-publish-pending:to', ZERO route writes; the paid publish then lands its AWD row", stateOf(s, "UKA1").state === RS.DD && stateOf(s, "UKA1").reason === "bundle-superseded-newer-live:paid-publish-pending:to" && rw === 0 && w.jobs.length === 1 && r.disposition === "published" && w.live("UKA1", SALES).payload.awdAvailable === true);
    const dw2 = makeDurable(); await seedDurable(dw2, ACCOUNTS);
    dw2.failJobSql = true;
    const w2 = makeWorld();
    const s2 = await makeCtx({ w: w2, dw: dw2, bucket: "us-ca" }).run({ dryRun: false, accountIds: ["USA1"] });
    ok("Q7 an unreadable newest-foreign-job read fails CLOSED: 'bundle-inventory-guard:paid-lineage-unreadable', ZERO writes", stateOf(s2, "USA1").state === RS.DD && stateOf(s2, "USA1").reason === "bundle-inventory-guard:paid-lineage-unreadable" && w2.writes() === 0);
  }

  // ---- Q8 (P3-1): a same-day served row with a missing / null / unparseable / NAIVE fetch stamp fails CLOSED ------------
  {
    const variants = [["null", null], ["missing", undefined], ["unparseable", "garbage"], ["naive (IST would read 04:30Z)", "2026-09-24T10:00:00"], ["postgres text", "2026-09-24 10:00:00+00"]];
    const outs = [];
    // A served OLDER-`to` row (yesterday's sales as-of) holding TODAY's inventory D-1 (a realistic paid row when OLI lags).
    const lagRow = (p, stamp) => { const c = clone(p); c.rows[0].fbaAvailable = 555; c.asOf = PREV; if (stamp === undefined) delete c.inventoryFetchedAt; else c.inventoryFetchedAt = stamp; return c; };
    for (const [label, stamp] of variants) {
      const dw = makeDurable(); const seed = await seedDurable(dw, ACCOUNTS);
      const p = lagRow((await paidDerive(seed, dw, "USA1")).result.payload, stamp);
      const w = makeWorld();
      w.putLive("USA1", PREV, p, T10);
      bumpOli(dw, "2026-09-24T11:00:00.000Z");
      const s = await makeCtx({ w, dw, bucket: "us-ca" }).run({ dryRun: false, accountIds: ["USA1"] });
      outs.push({ label, st: stateOf(s, "USA1").state, reason: stateOf(s, "USA1").reason, writes: w.writes(), cas: w.n.liveCas });
    }
    ok("Q8 (probeEdge E4) a served row of the SAME inventory day stamped 10:00 (after the 09:00 pointer) whose inventoryFetchedAt is null / missing / unparseable / NAIVE (offset-less) is bounded by its ROW stamp -> 'bundle-superseded-newer-live:served-newer-inventory', ZERO writes (and a Postgres-text offset stamp is parsed, not refused)", outs.every((o) => o.st === RS.DD && o.reason === "bundle-superseded-newer-live:served-newer-inventory" && o.writes === 0 && o.cas === 0));
    // The row-stamp bound is an UPPER bound, not a blanket refusal: an OLDER row stamp (08:00 < 09:00) still fills.
    const dw = makeDurable(); const seed = await seedDurable(dw, ACCOUNTS);
    const p = lagRow((await paidDerive(seed, dw, "USA1")).result.payload, null);
    const w = makeWorld();
    w.putLive("USA1", PREV, p, "2026-09-24T08:00:00.000Z");
    const s = await makeCtx({ w, dw, bucket: "us-ca" }).run({ dryRun: false, accountIds: ["USA1"] });
    ok("Q8 contrast: the same null fetch stamp on a row stamped 08:00 (before the pointer's 09:00) is provably older -> the route fills (READBACK_VERIFIED)", stateOf(s, "USA1").state === RS.RV && !!w.live("USA1", SALES) && w.live("USA1", PREV).payload.rows[0].fbaAvailable === 555);
    // PURE: the ordering + the guard mapping + the offset-only parser.
    const V = FBA_VALIDATED;
    const base = { inventoryRequestedThrough: INV, inventoryDate: INV };
    const ord = (rows, awd = null) => FB.fbaPlanNewerLiveReason({ rows, inventoryAsOf: INV, inventoryValidatedAt: V, awdValidatedAt: awd });
    ok("Q8 fbaPlanNewerLiveReason rows: a same-day unusable fetch stamp uses the row stamp (later -> newer, earlier -> not); NEITHER usable -> 'fetch-unordered' (never 'older'); a newer day wins over an unordered row; bare payloads without a row stamp are unordered",
      ord([{ payload: { ...base, inventoryFetchedAt: "2026-09-24T10:00:00" }, refreshedAt: T10 }]) === "served-newer-inventory"
      && ord([{ payload: { ...base, inventoryFetchedAt: null }, refreshedAt: "2026-09-24T08:00:00.000Z" }]) === null
      && ord([{ payload: { ...base, inventoryFetchedAt: "garbage" }, refreshedAt: "2026-09-24T08:00:00" }]) === "fetch-unordered"
      && ord([{ payload: { ...base, inventoryFetchedAt: null }, refreshedAt: null }, { payload: { inventoryRequestedThrough: "2026-09-25" }, refreshedAt: null }]) === "served-newer-inventory"
      && FB.fbaPlanNewerLiveReason({ payloads: [{ ...base }], inventoryAsOf: INV, inventoryValidatedAt: V }) === "fetch-unordered"
      && FB.fbaPlanNewerLiveReason({ payloads: [{ ...base, inventoryFetchedAt: "2026-09-24T15:30:00+05:30" }], inventoryAsOf: INV, inventoryValidatedAt: V }) === "served-newer-inventory"
      && FB.fbaPlanNewerLiveReason({ payloads: [{ ...base, inventoryFetchedAt: "2026-09-24T14:00:00+05:30" }], inventoryAsOf: INV, inventoryValidatedAt: V }) === null);
    ok("Q8 AWD is ordered ONLY for rows that HOLD AWD: awdAvailable:true with a null awdFetchedAt uses the row stamp (later -> 'served-newer-awd'); a row published WITHOUT AWD (awdAvailable false, awdFetchedAt null) has nothing to protect; neither stamp usable -> 'awd-fetch-unordered'",
      ord([{ payload: { ...base, inventoryFetchedAt: INV_FETCHED, awdAvailable: true, awdFetchedAt: null }, refreshedAt: T10 }], LST_FETCHED) === "served-newer-awd"
      && ord([{ payload: { ...base, inventoryFetchedAt: INV_FETCHED, awdAvailable: false, awdFetchedAt: null }, refreshedAt: T10 }], LST_FETCHED) === null
      && ord([{ payload: { ...base, inventoryFetchedAt: INV_FETCHED, awdAvailable: true, awdFetchedAt: "2026-09-24T12:00:00" }, refreshedAt: "x" }], LST_FETCHED) === "awd-fetch-unordered");
    const G = (o) => { const v = FB.fbaPlanLiveGuard({ salesAsOf: SALES, inventoryAsOf: INV, inventoryValidatedAt: V, awdValidatedAt: null, cycles: { state: "none" }, ...o }); return v.hard || v.newerLive; };
    const M_ = { state: "missing" };
    const NONE = { state: "none", jobId: null };
    const tokP = { evidenceToken: W.FBA_PLAN_TOKEN_PREFIX + "a".repeat(64), manifestToken: FB.FBA_PLAN_MANIFEST_PREFIX + "b".repeat(64) };
    const row = (payload, refreshedAt = T10, params = { reportVersion: "fba-plan-shared-v1", to: PREV }) => ({ state: "row", payload: { asOf: params.to, ...payload }, refreshedAt, params });
    const routeRow = (payload, refreshedAt = T10) => row(payload, refreshedAt, { reportVersion: "fba-plan-shared-v1", to: SALES, ...tokP });
    const paidRow = (payload, refreshedAt = T10) => row(payload, refreshedAt, { reportVersion: "fba-plan-shared-v1", to: SALES });
    const pend = (to, payload, refreshedAt = T10) => ({ state: "pending", jobId: "job-p", payload: { asOf: to, ...payload }, refreshedAt, params: { to } });
    ok("Q8 fbaPlanLiveGuard (the ONE fill-only verdict of resolve + publishGuard): unordered fetch -> 'inventory-guard:fetch-unordered'; a served / exact row at a LATER sales as-of -> 'superseded-newer-live:served-newer-to'; an unknowable sales day -> 'inventory-guard:sales-asof-unordered'; a PAID exact row -> 'superseded-newer-live:paid-owned' (even when provably OLDER per component); a ROUTE exact row is ordered per component (newer -> served-newer-inventory, older -> null); a pending paid shadow at >= salesAsOf -> ':paid-publish-pending:to', older-to newer -> ':paid-publish-pending:inventory', older-to not newer -> null; in flight / stale -> 'paid-job-in-flight' / 'paid-job-stale-in-flight'; unreadable / id-less paid slot -> 'inventory-guard:paid-lineage-unreadable'; a missing salesAsOf fails closed",
      G({ live: { served: row({ ...base, inventoryFetchedAt: null }, "nope"), exact: M_ }, paid: NONE }) === "inventory-guard:fetch-unordered"
      && G({ live: { served: row({ ...base }, T10, { to: "2026-09-25" }), exact: M_ }, paid: NONE }) === "superseded-newer-live:served-newer-to"
      && G({ live: { served: { state: "row", payload: { ...base, asOf: "2026-09-25" }, refreshedAt: T10, params: { to: PREV } }, exact: M_ }, paid: NONE }) === "superseded-newer-live:served-newer-to"
      && G({ live: { served: { state: "row", payload: { ...base }, refreshedAt: T10, params: {} }, exact: M_ }, paid: NONE }) === "inventory-guard:sales-asof-unordered"
      && G({ live: { served: M_, exact: paidRow({ ...base, inventoryFetchedAt: "2026-09-24T01:00:00.000Z" }, "2026-09-24T01:00:00.000Z") }, paid: NONE }) === "superseded-newer-live:paid-owned"
      && G({ live: { served: M_, exact: routeRow({ ...base, inventoryFetchedAt: T10 }) }, paid: NONE }) === "superseded-newer-live:served-newer-inventory"
      && G({ live: { served: M_, exact: routeRow({ ...base, inventoryFetchedAt: V }, V) }, paid: NONE }) === null
      && G({ live: { served: M_, exact: M_ }, paid: pend(SALES, { ...base, inventoryFetchedAt: INV_FETCHED }) }) === "superseded-newer-live:paid-publish-pending:to"
      && G({ live: { served: M_, exact: M_ }, paid: pend("2026-09-25", { ...base, inventoryFetchedAt: INV_FETCHED }) }) === "superseded-newer-live:paid-publish-pending:to"
      && G({ live: { served: M_, exact: M_ }, paid: pend(PREV, { ...base, inventoryFetchedAt: T10 }) }) === "superseded-newer-live:paid-publish-pending:inventory"
      && G({ live: { served: M_, exact: M_ }, paid: pend(PREV, { inventoryRequestedThrough: PREV, inventoryDate: PREV, inventoryFetchedAt: INV_FETCHED }, "2026-09-23T09:00:00.000Z") }) === null
      && G({ live: { served: M_, exact: M_ }, paid: { state: "in-flight", jobId: "job-x" } }) === "paid-job-in-flight"
      && G({ live: { served: M_, exact: M_ }, paid: { state: "stale-in-flight", jobId: "job-x" } }) === "paid-job-stale-in-flight"
      && G({ live: { served: row({ ...base, inventoryFetchedAt: T10 }), exact: M_ }, paid: { state: "in-flight", jobId: "job-x" } }) === "superseded-newer-live:served-newer-inventory"
      && G({ live: { served: M_, exact: M_ }, paid: { state: "bogus" } }) === "inventory-guard:paid-lineage-unreadable"
      && G({ live: { served: M_, exact: M_ }, paid: { state: "in-flight" } }) === "inventory-guard:paid-lineage-unreadable"
      && G({ live: { served: M_, exact: M_ }, paid: NONE }) === null
      && FB.fbaPlanLiveGuard({ live: { served: M_, exact: M_ }, paid: NONE, cycles: { state: "none" }, inventoryAsOf: INV, inventoryValidatedAt: V }).hard === "inventory-guard:sales-asof-missing"
      && FB.fbaPlanLiveGuard({ live: { served: M_, exact: M_ }, paid: NONE, salesAsOf: SALES, inventoryAsOf: INV, inventoryValidatedAt: V }).hard === "inventory-guard:paid-cycle-unreadable"
      && G({ live: { served: M_, exact: M_ }, paid: NONE, cycles: { state: "open", bucket: "us-ca-fba" } }) === "paid-cycle-open:us-ca-fba"
      && G({ live: { served: M_, exact: M_ }, paid: NONE, cycles: { state: "stale-open", bucket: "us-ca-fba" } }) === "paid-cycle-stale-open:us-ca-fba"
      && G({ live: { served: M_, exact: M_ }, paid: { state: "in-flight", jobId: "job-x" }, cycles: { state: "open", bucket: "us-ca-fba" } }) === "paid-job-in-flight"
      && G({ live: { served: M_, exact: paidRow({ ...base }) }, paid: NONE, cycles: { state: "open", bucket: "us-ca-fba" } }) === "superseded-newer-live:paid-owned"
      && CLS.classifyDeferral("inventory-guard:fetch-unordered").cls !== CLS.CLASSES.SUPERSEDED_NEWER_LIVE && CLS.classifyDeferral("inventory-guard:sales-asof-unordered").cls !== CLS.CLASSES.SUPERSEDED_NEWER_LIVE);
    ok("Q8 offsetInstantMs / isoMs parse ONLY offset-bearing instants (RFC3339 or the Postgres text form, fraction truncated to ms as V8 does): a NAIVE string, a date-only string, an impossible date, a number are refused (never a local-time parse on an IST host); Date objects pass",
      Number.isNaN(W.offsetInstantMs("2026-09-24T10:00:00")) && Number.isNaN(W.offsetInstantMs(null)) && W.isoMs("2026-09-24T10:00:00") === "" && W.isoMs("2026-09-24") === "" && W.isoMs("2026-02-30T00:00:00Z") === "" && W.isoMs(1790244000000) === ""
      && W.isoMs("2026-09-24 10:00:00.123456+00") === "2026-09-24T10:00:00.123Z" && W.isoMs("2026-09-24T15:30:00+05:30") === "2026-09-24T10:00:00.000Z" && W.isoMs("2026-09-24T15:30:00+0530") === "2026-09-24T10:00:00.000Z"
      && W.isoMs(new Date(FBA_VALIDATED)) === FBA_VALIDATED && ["2026-09-24T10:00:00.123456+00:00", "2026-09-24 10:00:00+00", "2026-09-24T10:00:00Z"].every((x) => W.offsetInstantMs(x) === Date.parse(x)));
  }

  // ---- Q9 (P3-2): 'epoch-not-current-d1' arrives bare AND 'bundle-' prefixed -- both zero writes; the classification note
  {
    const f = await fillWorld();
    const w = f.w;
    w.tick(Date.UTC(2026, 8, 25, 23, 59, 50) - w.now());
    let fired = false;
    const ctx = makeCtx({ w, dw: f.dw, bucket: "us-ca", wrapRuntime: (rt) => ({ ...rt, currentPredicate: async (rk, u, x) => { const r = await rt.currentPredicate(rk, u, x); if (!fired) { fired = true; w.tick(20000); } return r; } }) });
    const s = await ctx.run({ dryRun: false, accountIds: ["USA1"] });
    const relSrcQ = src("lib/server/sync/routes/fba-plan.release.js");
    ok("Q9 (probeEdge E1) a UTC-midnight roll between the scan and the prepare defers 'bundle-epoch-not-current-d1' with ZERO writes (the bare shape is M1); the release documents the classification: a mid-run roll is a RETRY, an operator alert only when --as-of != fbaInventoryAsOf(run start)", fired && stateOf(s, "USA1").state === RS.DD && stateOf(s, "USA1").reason === "bundle-epoch-not-current-d1" && w.writes() === 0
      && /'bundle-epoch-not-current-d1'/.test(relSrcQ) && /plain RETRY/.test(relSrcQ) && /--as-of != fbaInventoryAsOf\(run START\)/.test(relSrcQ));
  }
}

// =====================================================================================================================
// R. WP7 ROUND 4 -- FILL-ONLY regressions for the round-3 verifier's probes (probeTo T1a / T1a2 / T1b / T1c, probeResid
//    R1 / R2, probeBound B1 / B2, probeStale S1 / S2) + the OPEN PAID CYCLE check (R6b) + fill / route-over-route /
//    OLI-only / the paid-fetch-only stamp / the activation gate / the foreign-job statement.
// =====================================================================================================================
{
  const X = SALES; // the paid job's sales as-of (its own discovery)
  const S_ROUTE = "2026-09-20"; // the route's region go-live as-of (3 short-coverage accounts in the durable directory)
  const OLD = "2026-09-19";
  // The probeTo world: the durable directory holds 3 more US accounts whose proven OLI stops at S_ROUTE (the paid job's
  // live DataDoe discovery does not -- divergent region membership), so the route's region salesAsOf is S_ROUTE < the
  // paid job's X; the served row is OLD.
  const EXTRAS = [1, 2, 3].map((i) => ({ accountId: "USX" + i, country: "US", currency: "USD", name: "US short " + i }));
  const TO_DIR = directoryOf([...ACCOUNTS, ...EXTRAS]);
  const toWorld = async () => {
    const dw = makeDurable(); const seed = await seedDurable(dw, ACCOUNTS);
    for (const e of EXTRAS) dw.coverage.push({ organization_fingerprint: ORG, account_id: e.accountId, covered_from: "2025-01-01", covered_to: S_ROUTE, source_refreshed_at: new Date(COV_REFRESHED) });
    const paid = await paidDerive(seed, dw, "USA1"); // the paid job's plan: asOf X
    const w = makeWorld();
    const old = clone(paid.result.payload); old.asOf = OLD; old.rows[0].fbaAvailable = 1; old.inventoryRequestedThrough = OLD; old.inventoryDate = OLD;
    old.inventoryFetchedAt = "2026-09-20T05:00:00.000Z"; old.awdFetchedAt = "2026-09-20T05:00:00.000Z";
    w.putLive("USA1", OLD, old, "2026-09-20T05:00:00.000Z");
    return { dw, seed, paid, w };
  };
  const servedOf = async (w) => { const r = await w.readers.getLatestReportSnapshot({ reportKey: RK, accountId: "USA1" }); return r ? { to: r.params.to, owner: FB.fbaPlanRowOwner(r.params) } : null; };
  // R0 (T0): the route's own region as-of really is S_ROUTE < X.
  {
    const { dw, w } = await toWorld();
    const ctx = makeCtx({ w, dw, bucket: "us-ca", directory: TO_DIR });
    const e = (await ctx.runtime.readScopeEvidence({ scope: ["USA1"], epoch: INV, bucket: "us-ca", organizationFingerprint: ORG })).perAccount.get("USA1");
    ok("R0 (probeTo T0) the route's region salesAsOf is " + S_ROUTE + " (durable OLI lags) while the paid job's asOf is " + X, e.salesAsOf === S_ROUTE && ctx.runtime.computeRevision({ accountId: "USA1", evidence: e }).eligible === true);
  }
  // R1 (T1a): a PENDING paid shadow at the NEWER to X (fetch/AWD not newer than the durable evidence).
  {
    const { dw, paid, w } = await toWorld();
    const pj = await seedPaidJob(w, paid, "USA1", paid.result.payload, LST_FETCHED);
    const before = w.writes();
    const ctx = makeCtx({ w, dw, bucket: "us-ca", directory: TO_DIR });
    const s = await ctx.run({ dryRun: false, accountIds: ["USA1"] });
    const rw0 = routeWrites(w, before);
    const replay = await w.publisherFor(null).publish(RK, "USA1");
    const s2 = await ctx.run({ dryRun: false, accountIds: ["USA1"] });
    ok("R1 (probeTo T1a) a pending paid shadow at a NEWER sales as-of (" + X + " > " + S_ROUTE + ") -> 'bundle-superseded-newer-live:paid-publish-pending:to', ZERO route writes (no job over the paid job); the paid replay then publishes ITS OWN " + X + " row (served, paid-owned); the route next defers 'superseded-newer-live:served-newer-to'",
      stateOf(s, "USA1").state === RS.DD && stateOf(s, "USA1").reason === "bundle-superseded-newer-live:paid-publish-pending:to" && rw0 === 0 && w.jobs.length === 1 && w.jobs[0].snapshot_params_hash === pj.h
      && replay.disposition === "published" && !!w.live("USA1", X) && !w.live("USA1", S_ROUTE) && JSON.stringify(await servedOf(w)) === JSON.stringify({ to: X, owner: "paid" })
      && stateOf(s2, "USA1").reason === "superseded-newer-live:served-newer-to" && routeWrites(w, before) === 1);
  }
  // R2 (T1a2): the SAME, with the route's control window never opening (lease busy).
  {
    const { dw, paid, w } = await toWorld();
    await seedPaidJob(w, paid, "USA1", paid.result.payload, LST_FETCHED);
    const before = w.writes();
    const ctx = makeCtx({ w, dw, bucket: "us-ca", directory: TO_DIR, onOpenControls: async () => { throw new Error("control lease busy"); } });
    let s = null; try { s = await ctx.run({ dryRun: false, accountIds: ["USA1"] }); } catch (_e) { s = null; }
    const rw0 = routeWrites(w, before);
    const replay = await w.publisherFor(null).publish(RK, "USA1");
    ok("R2 (probeTo T1a2) the route prepares NOTHING (the pending paid job at " + X + " refuses the fill before any write), so a busy control window leaves no route job / shadow behind: the paid replay publishes ITS OWN " + X + " shadow -- never a route older-to shadow",
      (!s || stateOf(s, "USA1").reason === "bundle-superseded-newer-live:paid-publish-pending:to") && rw0 === 0 && w.jobs.length === 1 && ctx.controls.length === 0
      && replay.disposition === "published" && !!w.live("USA1", X) && !w.live("USA1", S_ROUTE) && (await servedOf(w)).owner === "paid");
  }
  // R3 (T1b): the paid job publishes X AFTER the route's scan and BEFORE its prepare.
  {
    const { dw, paid, w } = await toWorld();
    await seedPaidJob(w, paid, "USA1", paid.result.payload, LST_FETCHED);
    const before = w.writes();
    let fired = false; let paidRes = null;
    const ctx = makeCtx({ w, dw, bucket: "us-ca", directory: TO_DIR, wrapRuntime: (rt) => ({ ...rt, resolveBundle: async (u, o) => { if (!fired) { fired = true; paidRes = await w.publisherFor(null).publish(RK, "USA1"); } return rt.resolveBundle(u, o); } }) });
    const s = await ctx.run({ dryRun: false, accountIds: ["USA1"] });
    const again = await ctx.run({ dryRun: true, accountIds: ["USA1"] });
    ok("R3 (probeTo T1b) the paid job publishes " + X + " between the route's scan and its prepare -> the prepare defers 'bundle-superseded-newer-live:served-newer-to' with ZERO route writes (nothing at " + S_ROUTE + "); the served row stays the paid " + X + " row; the next scan 'superseded-newer-live:served-newer-to'",
      fired && paidRes.disposition === "published" && stateOf(s, "USA1").state === RS.DD && stateOf(s, "USA1").reason === "bundle-superseded-newer-live:served-newer-to" && routeWrites(w, before) === 1 && !w.live("USA1", S_ROUTE)
      && JSON.stringify(await servedOf(w)) === JSON.stringify({ to: X, owner: "paid" }) && stateOf(again, "USA1").reason === "superseded-newer-live:served-newer-to");
  }
  // R4 (T1c): the SAME paid row already served at scan time.
  {
    const { dw, paid, w } = await toWorld();
    await seedPaidJob(w, paid, "USA1", paid.result.payload, LST_FETCHED);
    await w.publisherFor(null).publish(RK, "USA1");
    const liveWrites = w.n.liveWrite;
    const s = await makeCtx({ w, dw, bucket: "us-ca", directory: TO_DIR }).run({ dryRun: false, accountIds: ["USA1"] });
    ok("R4 (probeTo T1c) the paid " + X + " row served at scan time -> 'superseded-newer-live:served-newer-to', zero route writes", stateOf(s, "USA1").state === RS.DD && stateOf(s, "USA1").reason === "superseded-newer-live:served-newer-to" && w.n.liveWrite === liveWrites);
  }
  // R5 (probeResid R1): a PAID job inserted in the residual window between the release's last latest-job re-read and
  // the route's own job insert -- with and without the paid durable persist. Its cycle bucket ('us-ca-fba-2') is
  // deliberately OUTSIDE the paid bucket set so this case isolates the publishGuard post-insert check (the second line
  // of defence); a real paid cycle is open for minutes before its job and is refused at resolve (R6b (b)).
  for (const persist of [false, true]) {
    const f = await fillWorld();
    const { dw, paid, c2, w } = f;
    let pj = null;
    const orig = w.upsertReportJob;
    w.upsertReportJob = async (job) => {
      if (!pj && job.reportKey === RK && job.accountId === "USA1" && (job.durableContentDeps || []).some((d) => String(d).startsWith(W.FBA_PLAN_TOKEN_PREFIX))) {
        pj = await createPaidJob(w, paid, "USA1", { cycleBucket: "us-ca-fba-2" }); // the paid run's job lands in the window
      }
      return orig(job);
    };
    const ctx = makeCtx({ w, dw, bucket: "us-ca" });
    const s = await ctx.run({ dryRun: false, accountIds: ["USA1"] });
    w.upsertReportJob = orig;
    const casAfterRoute = w.n.liveCas;
    // The paid job derives its NEWER same-day fetch (10:00), validates, finalizes, then its publish phase runs: the
    // publisher promotes the LATEST job -- the ROUTE's (the documented residual).
    await completePaidJob(w, pj, c2, T10);
    const pub = await w.publisherFor(null).publish(RK, "USA1");
    const liveAfterPaid = w.live("USA1", SALES);
    ok(`R5 (probeResid R1, persist=${persist}) a paid job inserted between the release's last latest-job re-read and the route's job insert -> publishGuard's post-insert check defers 'paid-job-raced-insert' with ZERO live CAS; RESIDUAL (documented): the route's validated job is the latest, so the paid publish phase promotes the ROUTE shadow ('published', route tokens, not the paid 777)`,
      stateOf(s, "USA1").state === RS.DD && stateOf(s, "USA1").reason === "paid-job-raced-insert" && casAfterRoute === 0
      && pub.disposition === "published" && liveAfterPaid && FB.fbaPlanRowOwner(liveAfterPaid.params) === "route" && liveAfterPaid.payload.rows[0].fbaAvailable !== 777 && liveAfterPaid.source_refreshed_at === FBA_VALIDATED);
    if (persist) {
      // The paid durable persist lands the NEWER rows (validated 10:30): the token moves -> ROUTE-OVER-ROUTE converges.
      const rows = clone(dw.storage.get(dw.fba.get("USA1").object_path).rows); rows[0].available = 777;
      rewritePointer(dw, "fba", "USA1", rows, { validated_at: new Date("2026-09-24T10:30:00.000Z") });
      w.tick(60000);
      const s2 = await ctx.run({ dryRun: false, accountIds: ["USA1"] });
      const l = w.live("USA1", SALES);
      ok("R5 (persist=true) ... the paid durable persist moves the token and the route replaces its OWN row (route-over-route: READBACK_VERIFIED, stamp = the new FBA validated_at 10:30, the persisted content); the orphaned validated paid job (no longer the latest) never blocks", stateOf(s2, "USA1").state === RS.RV && l.source_refreshed_at === "2026-09-24T10:30:00.000Z" && l.payload.inventoryFetchedAt === "2026-09-24T10:30:00.000Z" && FB.fbaPlanRowOwner(l.params) === "route");
    } else {
      const s2 = await ctx.run({ dryRun: false, accountIds: ["USA1"] });
      ok("R5 (persist=false) ... without the persist the route's own promoted row is content-equivalent to its evidence -> PUBLICATION_NOT_REQUIRED (zero writes) until the next paid fetch / D-1 (bounded residual)", stateOf(s2, "USA1").state === RS.NR && stateOf(s2, "USA1").reason === "content-equivalent");
    }
  }
  // R6 (probeResid R2 + P3 liveness): the in-flight paid job's cycle_date vs the epoch; a stale one alerts; the OPEN
  // PAID CYCLE check blocks an old-epoch cycle only while it is ACTIVE (never forever).
  {
    const run = async (cycleDate, ageMs = 0) => {
      const f = await fillWorld();
      await createPaidJob(f.w, f.paid, "USA1", { cycleDate });
      if (ageMs) f.w.tick(ageMs);
      const before = f.w.writes();
      const ctx = makeCtx({ w: f.w, dw: f.dw, bucket: "us-ca" });
      const s = await ctx.run({ dryRun: false, accountIds: ["USA1"] });
      return { st: stateOf(s, "USA1"), writes: f.w.writes() - before, logs: ctx.logs };
    };
    const oldActive = await run("2026-09-22");
    const oldIdle = await run("2026-09-22", 7 * 3600 * 1000);
    const fresh = await run(INV);
    const stale = await run(INV, 7 * 3600 * 1000);
    const future = await run("2026-09-25");
    ok("R6 (probeResid R2) a paid cycle STUCK 'running' from an OLD epoch (cycle_date 2026-09-22 < " + INV + ") blocks ONLY while ACTIVE ('bundle-paid-cycle-open:us-ca-fba', zero writes) and, idle beyond the 6 h window, never blocks -> the route fills (READBACK_VERIFIED) + a logged 'paid-cycle-stale-open' ALERT; a same-epoch in-flight job -> 'bundle-paid-job-in-flight'; one created > 6 h ago -> 'bundle-paid-job-stale-in-flight' (retryable + alert, never superseded); a cycle_date AFTER the epoch fails closed (in flight)",
      oldActive.st.state === RS.DD && oldActive.st.reason === "bundle-paid-cycle-open:us-ca-fba" && oldActive.writes === 0
      && oldIdle.st.state === RS.RV && oldIdle.logs.some((m) => /ALERT paid-cycle-stale-open:us-ca-fba .*NOT blocking/.test(m))
      && fresh.st.state === RS.DD && fresh.st.reason === "bundle-paid-job-in-flight" && fresh.writes === 0
      && stale.st.state === RS.DD && stale.st.reason === "bundle-paid-job-stale-in-flight" && stale.writes === 0 && future.st.reason === "bundle-paid-job-in-flight" && future.writes === 0
      && CLS.classifyDeferral("bundle-paid-job-stale-in-flight").cls !== CLS.CLASSES.SUPERSEDED_NEWER_LIVE && FB.FBA_PLAN_STALE_IN_FLIGHT_MS === 6 * 3600 * 1000);
  }
  // R6b THE OPEN PAID CYCLE CHECK (the orchestrator's follow-up: closes the paid-job-not-yet-created window and the R1
  // raced-insert residual). A paid fba-plan operation opens + claims its cycle, plans (owners), fetches, and only THEN
  // inserts its fba-plan job (sync-dispatch.js:430) -- an open paid cycle with NO job yet must block the fill.
  {
    const HEX = "0123456789abcdef";
    const openPaid = async (w, bucket, { cycleDate = INV, claim = true, owner = false } = {}) => {
      await w.openCycle({ bucket, cycleDate });
      const c = await w.getCycleByBucketDate(bucket, cycleDate);
      if (claim) await w.claimCycle(c.id);
      if (owner) w.addOwner(c.id, RK);
      return c;
    };
    const runFill = async (setup, { acct = "USA1", bucket = "us-ca", ctxOpts = {} } = {}) => {
      const f = await fillWorld();
      if (setup) await setup(f.w, f);
      const before = f.w.writes();
      const ctx = makeCtx({ w: f.w, dw: f.dw, bucket, ...ctxOpts });
      const s = await ctx.run({ dryRun: false, accountIds: [acct] });
      return { st: stateOf(s, acct), writes: f.w.writes() - before, cas: f.w.n.liveCas, w: f.w, f, ctx, logs: ctx.logs };
    };
    // (a) the not-yet-created window: an OPEN paid cycle on the epoch, no fba-plan job yet -- every paid bucket shape.
    const buckets = [["us-ca-fba", {}], ["us-fba", {}], ["bootstrap-fba-us-ca-" + HEX, {}], ["us-ca-fba", { claim: false }]];
    const outs = [];
    for (const [bk, o] of buckets) outs.push({ bk, ...(await runFill((w) => openPaid(w, bk, o))) });
    ok("R6b (a) the paid-job-NOT-YET-CREATED window: an OPEN (running or pending) paid cycle with no fba-plan job yet -- the scheduled / DSC '<region>-fba' and legacy 'us-fba' buckets, a 'bootstrap-fba-<region>-<hex16>' wave -- defers the fill 'bundle-paid-cycle-open:<bucket>' at the prepare's resolve: ZERO writes (no cycle / job / shadow / CAS)",
      outs.every((o) => o.st.state === RS.DD && o.st.reason === "bundle-paid-cycle-open:" + o.bk && o.writes === 0 && o.cas === 0 && o.w.jobs.length === 0)
      && CLS.classifyDeferral("bundle-paid-cycle-open:us-ca-fba").cls !== CLS.CLASSES.SUPERSEDED_NEWER_LIVE);
    // (b) R1 as it really happens: the paid cycle opened minutes BEFORE the route's resolve; its job is inserted inside
    // the route's residual window -- the route never reaches its job insert, so the paid publish promotes ITS OWN shadow.
    {
      const f = await fillWorld();
      const { w, dw, paid, c2 } = f;
      const pj = await createPaidJob(w, paid, "USA1", { cycleBucket: "us-ca-fba" });
      const cyc = [...w.cycles.values()].find((c) => c.id === pj.cycleId);
      w.jobs.splice(w.jobs.findIndex((j) => j.cycle_id === pj.cycleId), 1); // the job is not inserted yet: only the cycle is open
      let inserted = false;
      const orig = w.upsertReportJob;
      w.upsertReportJob = async (job) => {
        if (!inserted && (job.durableContentDeps || []).some((d) => String(d).startsWith(W.FBA_PLAN_TOKEN_PREFIX))) { inserted = true; await orig({ cycleId: cyc.id, reportKey: RK, reportVersion: pj.params.reportVersion, accountId: "USA1", connectionId: "primary", bucket: "us-ca", dependsOn: ["paid-inv-hash"], durableContentDeps: [] }); }
        return orig(job);
      };
      const before = w.writes();
      const s = await makeCtx({ w, dw, bucket: "us-ca" }).run({ dryRun: false, accountIds: ["USA1"] });
      w.upsertReportJob = orig;
      const routeWrites0 = w.writes() - before;
      await orig({ cycleId: cyc.id, reportKey: RK, reportVersion: pj.params.reportVersion, accountId: "USA1", connectionId: "primary", bucket: "us-ca", dependsOn: ["paid-inv-hash"], durableContentDeps: [] });
      await completePaidJob(w, pj, c2, T10);
      const pub = await w.publisherFor(null).publish(RK, "USA1");
      ok("R6b (b) R1 closed: the paid cycle opened BEFORE the route's resolve (its job lands only after its source loop) -> 'bundle-paid-cycle-open:us-ca-fba' at b1 -- the route NEVER reaches its job insert (zero writes), so the paid publish phase promotes ITS OWN shadow (published 777 @10:00, paid-owned) -- never the route's",
        stateOf(s, "USA1").state === RS.DD && stateOf(s, "USA1").reason === "bundle-paid-cycle-open:us-ca-fba" && routeWrites0 === 0 && !inserted
        && pub.disposition === "published" && w.live("USA1", SALES).payload.rows[0].fbaAvailable === 777 && FB.fbaPlanRowOwner(w.live("USA1", SALES).params) === "paid");
    }
    // (c) a paid cycle that opens AFTER the route's prepare (at the control window) -> publishGuard refuses, zero CAS.
    {
      const f = await fillWorld();
      const ctx = makeCtx({ w: f.w, dw: f.dw, bucket: "us-ca", onOpenControls: async () => { await openPaid(f.w, "us-ca-fba"); } });
      const s = await ctx.run({ dryRun: false, accountIds: ["USA1"] });
      ok("R6b (c) a paid cycle opening between the route's prepare and its CAS -> publishGuard 'paid-cycle-open:us-ca-fba' (DEFERRED_DEPENDENCY), ZERO CAS; nothing at {to: salesAsOf}", stateOf(s, "USA1").state === RS.DD && stateOf(s, "USA1").reason === "paid-cycle-open:us-ca-fba" && f.w.n.liveCas === 0 && !f.w.live("USA1", SALES));
    }
    // (d) TERMINAL paid cycles never block; a stale OPEN one on the epoch alerts (bounded); an old idle one never blocks.
    const term = await runFill(async (w) => { const c = await openPaid(w, "us-ca-fba"); await w.finalizeCycle({ cycleId: c.id }); });
    const staleEpoch = await runFill(async (w) => { await openPaid(w, "us-ca-fba"); w.tick(7 * 3600 * 1000); });
    const oldIdle = await runFill(async (w) => { await openPaid(w, "us-ca-fba", { cycleDate: "2026-09-22" }); w.tick(7 * 3600 * 1000); });
    const oldActive = await runFill(async (w) => { await openPaid(w, "us-ca-fba", { cycleDate: "2026-09-22" }); });
    ok("R6b (d) a TERMINAL paid cycle does not block (READBACK_VERIFIED); an OPEN one on the epoch idle beyond the 6 h window -> 'bundle-paid-cycle-stale-open:us-ca-fba' (retryable + ALERT, zero writes; it stops blocking when the epoch rolls past it or it is closed -- never forever); an idle OLDER-epoch one never blocks (fills + a logged ALERT); an ACTIVE older-epoch one blocks ('paid-cycle-open')",
      term.st.state === RS.RV && staleEpoch.st.state === RS.DD && staleEpoch.st.reason === "bundle-paid-cycle-stale-open:us-ca-fba" && staleEpoch.writes === 0
      && oldIdle.st.state === RS.RV && oldIdle.logs.some((m) => /ALERT paid-cycle-stale-open:us-ca-fba/.test(m)) && oldActive.st.reason === "bundle-paid-cycle-open:us-ca-fba"
      && CLS.classifyDeferral("bundle-paid-cycle-stale-open:us-ca-fba").cls !== CLS.CLASSES.SUPERSEDED_NEWER_LIVE && FB.FBA_PLAN_PAID_CYCLE_ACTIVE_MS === 6 * 3600 * 1000);
    // (e) NATURAL buckets block ONLY when the open cycle planned fba-plan (an fba-plan source-job owner); route /
    // priority-partial, listing-health-v3 and another region's buckets never block; the legacy non-us-fba blocks CA only.
    const natNo = await runFill((w) => openPaid(w, "us-ca"));
    const natYes = await runFill((w) => openPaid(w, "us-ca", { owner: true }));
    const natBootYes = await runFill((w) => openPaid(w, "bootstrap-us-ca-" + HEX, { owner: true }));
    const natBootNo = await runFill((w) => openPaid(w, "bootstrap-us-ca-" + HEX));
    const excluded = await runFill(async (w) => { for (const bk of ["priority-partial-us-ca-" + HEX, "listing-health-v3-us-ca", "india-fba", "europe-au-fba", "bootstrap-fba-india-" + HEX]) await openPaid(w, bk, { owner: true }); });
    const nonUsForUs = await runFill((w) => openPaid(w, "non-us-fba"));
    const nonUsForCa = await runFill((w) => openPaid(w, "non-us-fba"), { acct: "CAA1" });
    ok("R6b (e) a NATURAL cycle ('us-ca', 'bootstrap-us-ca-<hex16>') blocks ONLY with an fba-plan source-job owner ('bundle-paid-cycle-open:<bucket>'); priority-partial (route / priority release), listing-health-v3 and other regions' buckets never block; the legacy 'non-us-fba' blocks CA (non-us) but not US",
      natNo.st.state === RS.RV && natYes.st.reason === "bundle-paid-cycle-open:us-ca" && natBootYes.st.reason === "bundle-paid-cycle-open:bootstrap-us-ca-" + HEX && natBootNo.st.state === RS.RV
      && excluded.st.state === RS.RV && nonUsForUs.st.state === RS.RV && nonUsForCa.st.reason === "bundle-paid-cycle-open:non-us-fba");
    // (f) the read fails closed: at resolve (zero writes) and in publishGuard (zero CAS).
    const readFail = await runFill((w, f) => { f.dw.failCycleSql = true; });
    const f2 = await fillWorld();
    const c2 = makeCtx({ w: f2.w, dw: f2.dw, bucket: "us-ca", onOpenControls: async () => { f2.dw.failCycleSql = true; } });
    const s2 = await c2.run({ dryRun: false, accountIds: ["USA1"] });
    ok("R6b (f) an unreadable open-paid-cycle read fails CLOSED: 'bundle-inventory-guard:paid-cycle-unreadable' at the prepare (ZERO writes) and 'inventory-guard:paid-cycle-unreadable' in publishGuard (ZERO CAS)", readFail.st.state === RS.DD && readFail.st.reason === "bundle-inventory-guard:paid-cycle-unreadable" && readFail.writes === 0
      && stateOf(s2, "USA1").state === RS.DD && stateOf(s2, "USA1").reason === "inventory-guard:paid-cycle-unreadable" && f2.w.n.liveCas === 0);
    // (g) a content-equal served row is still current under an open paid cycle (report mode: zero writes either way).
    {
      const f = await fillWorld();
      await makeCtx({ w: f.w, dw: f.dw, bucket: "us-ca" }).run({ dryRun: false, accountIds: ["USA1"] });
      await openPaid(f.w, "us-ca-fba");
      const writes = f.w.writes();
      const s = await makeCtx({ w: f.w, dw: f.dw, bucket: "us-ca" }).run({ dryRun: false, accountIds: ["USA1"] });
      ok("R6b (g) the route's own content-equal row stays PUBLICATION_NOT_REQUIRED while a paid cycle is open (the predicate's report mode), zero writes", stateOf(s, "USA1").state === RS.NR && f.w.writes() === writes);
    }
    // (h) the bucket set + the statement are pinned.
    const q = RELMOD.FBA_PLAN_PAID_CYCLE_SQL;
    const bk = RELMOD.fbaPlanPaidCycleBuckets;
    ok("R6b (h) fbaPlanPaidCycleBuckets: US -> dedicated [us-ca-fba, us-fba] + bootstrap-fba-us-ca-% + natural [us, us-ca] (+ bootstrap-us-ca-% with an owner); CA -> [non-us-fba, us-ca-fba]; UK -> [europe-au-fba, non-us-fba]; IN -> [india-fba, non-us-fba]; no country -> null. FBA_PLAN_PAID_CYCLE_SQL is ONE read-only SELECT over pending / running cycles, cycle_date ::text, last activity = greatest(cycle, source jobs, report jobs updated_at), natural buckets only with an 'fba-plan' owner",
      JSON.stringify(bk("US")) === JSON.stringify({ dedicated: ["us-ca-fba", "us-fba"], bootstrapLike: "bootstrap-fba-us-ca-%", natural: ["us", "us-ca"], naturalLike: "bootstrap-us-ca-%", region: "us-ca" })
      && JSON.stringify(bk("CA").dedicated) === '["non-us-fba","us-ca-fba"]' && JSON.stringify(bk("UK").dedicated) === '["europe-au-fba","non-us-fba"]' && JSON.stringify(bk("IN").dedicated) === '["india-fba","non-us-fba"]' && bk("") === null
      && RC.isReadOnlyEvidenceSql(q.text) && /c\.status in \('pending', 'running'\)/.test(q.text) && /c\.cycle_date::text as cycle_date/.test(q.text)
      && /greatest\(c\.updated_at, coalesce\(\(select max\(s\.updated_at\) from public\.sync_source_jobs s where s\.cycle_id = c\.id\), c\.updated_at\), coalesce\(\(select max\(r\.updated_at\) from public\.sync_report_jobs r where r\.cycle_id = c\.id\), c\.updated_at\)\) as last_activity_at/.test(q.text)
      && /o\.report_key = 'fba-plan'/.test(q.text) && !/priority-partial|listing-health-v3/.test(q.text)
      && JSON.stringify(q.params(bk("US"))) === JSON.stringify([["us-ca-fba", "us-fba"], "bootstrap-fba-us-ca-%", ["us", "us-ca"], "bootstrap-us-ca-%"]));
  }
  // R7 (probeBound B1): validated_at is only an UPPER bound of the pointer's fetch -- an older op's late persist makes
  // OLDER rows look newer; under fill-only a PAID row is never replaced, whatever the stamps say.
  {
    const dw = makeDurable(); const seed = await seedDurable(dw, ACCOUNTS); // pointer rows = op A (older), validated 09:00
    const paid = await paidDerive(seed, dw, "USA1");
    const w = makeWorld();
    const b = clone(paid.result.payload); b.rows[0].fbaAvailable = 777; b.inventoryFetchedAt = "2026-09-24T08:45:00.000Z";
    w.putLive("USA1", SALES, b, "2026-09-24T08:45:00.000Z");
    const s = await makeCtx({ w, dw, bucket: "us-ca" }).run({ dryRun: false, accountIds: ["USA1"] });
    ok("R7 (probeBound B1) op B's NEWER paid row (fetch 08:45) at {to: salesAsOf} vs a durable pointer holding op A's OLDER rows re-persisted at 09:00 -> 'superseded-newer-live:paid-owned': ZERO writes, ZERO CAS, op B's 777 kept", stateOf(s, "USA1").state === RS.DD && stateOf(s, "USA1").reason === "superseded-newer-live:paid-owned" && w.writes() === 0 && w.n.liveCas === 0 && w.live("USA1", SALES).payload.rows[0].fbaAvailable === 777);
  }
  // R7b STAMP INVERSION (round-4 verifier P2, probeA / probeB): the route row is stamped with the durable PERSIST instant
  // (09:00, after the paid fetch it holds), so a later PAID publish of the SAME D-1 from CACHED fetches (a DSC re-sync on
  // 'us-fba', shadow stamped 08:40) is refused 'newer-live' by the fenced CAS. The route must never re-derive over that
  // refused shadow (never orphan it) and must surface a typed ALERT -- unless it provably SERVES exactly its content.
  {
    const REFUSED = "superseded-newer-live:paid-publish-refused-by-route-stamp";
    const masked = (p) => { const c = clone(p); for (const k of ["inventoryFetchedAt", "awdFetchedAt", "accountName", "marketCountry"]) delete c[k]; return B.stableJson(c); };
    const refusedWorld = async ({ oliMove = true, mutate = null } = {}) => {
      const f = await fillWorld();
      const { dw, w } = f;
      const s1 = await makeCtx({ w, dw, bucket: "us-ca" }).run({ dryRun: false, accountIds: ["USA1"] });
      const r1 = clone(w.live("USA1", SALES));
      w.tick(3600 * 1000);
      if (oliMove) {
        for (const r of dw.history) if (r.account_id === "USA1" && r.sale_date === "2026-09-23") r.units += 5;
        bumpOliQ(dw, "2026-09-24T10:00:00.000Z");
      }
      const paid1 = await paidDerive(f.seed, dw, "USA1");
      const shadow = clone(paid1.result.payload);
      if (mutate) mutate(shadow);
      const pj = await seedPaidJob(w, paid1, "USA1", shadow, LST_FETCHED, { cycleBucket: "us-fba" });
      const pub = await w.publisherFor(null).publish(RK, "USA1");
      return { ...f, s1, r1, paid1, shadow, pj, pub };
    };
    // (A, persist=false) probeA: the paid publish is refused; the next route pass must NOT re-derive over it.
    {
      const x = await refusedWorld();
      const writes = x.w.writes(); const cas = x.w.n.liveCas;
      const s2 = await makeCtx({ w: x.w, dw: x.dw, bucket: "us-ca" }).run({ dryRun: false, accountIds: ["USA1"] });
      const scan = await makeCtx({ w: x.w, dw: x.dw, bucket: "us-ca" }).run({ dryRun: true, accountIds: ["USA1"] });
      const latest = await x.w.readLatestJob(RK, "USA1");
      ok("R7b (probeA persist=false) a cached-fetch PAID publish of the same D-1 (shadow 08:40 < the route row's persist stamp 09:00) is CAS-refused 'newer-live'; the next route pass defers '" + REFUSED + "' (never the benign 'evidence-instant-not-advanced'), the scan too (never current): ZERO route writes, the paid job stays the LATEST (still promotable, never orphaned), the route row untouched",
        x.s1 && stateOf(x.s1, "USA1").state === RS.RV && x.pub.disposition === "newer-live" && masked(x.w.live("USA1", SALES).payload) === masked(x.r1.payload)
        && stateOf(s2, "USA1").state === RS.DD && stateOf(s2, "USA1").reason === REFUSED
        && stateOf(scan, "USA1").state === RS.DD && stateOf(scan, "USA1").reason === REFUSED
        && x.w.writes() === writes && x.w.n.liveCas === cas && latest.snapshotParamsHash === x.pj.h
        && CLS.classifyDeferral(REFUSED).cls !== CLS.CLASSES.CURRENT && FB.FBA_PLAN_PAID_REFUSED_BY_ROUTE_STAMP === REFUSED);
    }
    // (A, persist=true) probeA: the paid op's durable persist re-records the SAME fetch at 10:30 -> the route CONVERGES.
    {
      const x = await refusedWorld();
      x.w.tick(1800 * 1000);
      x.dw.fba.set("USA1", { ...x.dw.fba.get("USA1"), validated_at: new Date("2026-09-24T10:30:00.000Z") });
      const s2 = await makeCtx({ w: x.w, dw: x.dw, bucket: "us-ca" }).run({ dryRun: false, accountIds: ["USA1"] });
      const l = x.w.live("USA1", SALES);
      const scan = await makeCtx({ w: x.w, dw: x.dw, bucket: "us-ca" }).run({ dryRun: true, accountIds: ["USA1"] });
      ok("R7b (probeA persist=true) the paid durable persist re-records the same fetch (validated 10:30 > the route row 09:00) and the route's derive EQUALS the refused paid shadow -> CONVERGENCE: READBACK_VERIFIED, the live row now carries the PAID content (stamp 10:30); the next scan is current",
        stateOf(s2, "USA1").state === RS.RV && masked(l.payload) === masked(x.shadow) && l.source_refreshed_at === "2026-09-24T10:30:00.000Z" && stateOf(scan, "USA1").state === RS.NR);
    }
    // (B) probeB: the refused paid shadow holds NEWER AWD (fetched 08:50 > the durable Listings 08:40); a persist
    // re-records FBA (10:30) and OLI moves -> the route's derive differs (older AWD) -> still refused: never overwritten.
    {
      const x = await refusedWorld({ mutate: (p) => { for (const r of p.rows) if (typeof r.awdAvailable === "number") r.awdAvailable += 100; p.awdFetchedAt = "2026-09-24T08:50:00.000Z"; } });
      x.dw.fba.set("USA1", { ...x.dw.fba.get("USA1"), validated_at: new Date("2026-09-24T10:30:00.000Z") });
      const writes = x.w.writes();
      const s2 = await makeCtx({ w: x.w, dw: x.dw, bucket: "us-ca" }).run({ dryRun: false, accountIds: ["USA1"] });
      const latest = await x.w.readLatestJob(RK, "USA1");
      ok("R7b (probeB) a refused paid shadow with NEWER AWD (08:50 > the durable Listings 08:40): even with the route's evidence instant advanced (10:30) its derive differs -> '" + REFUSED + "' (the predicate), ZERO writes; the paid job stays the latest; the live AWD is not superseded by a route-over-route",
        x.pub.disposition === "newer-live" && stateOf(s2, "USA1").reason === REFUSED && x.w.writes() === writes && latest.snapshotParamsHash === x.pj.h
        && !latest.durableContentDeps.some((d) => d.startsWith(W.FBA_PLAN_TOKEN_PREFIX)));
    }
    // (C) the refused alert outranks content equality: the route's evidence did NOT move (no OLI change) -- the served
    // route row equals the route's own derive -- yet the refused paid shadow (different rows) is not shown -> ALERT.
    {
      const x = await refusedWorld({ oliMove: false, mutate: (p) => { p.rows[0].fbaAvailable = 555; } });
      const scan = await makeCtx({ w: x.w, dw: x.dw, bucket: "us-ca" }).run({ dryRun: true, accountIds: ["USA1"] });
      ok("R7b (C) route evidence unchanged (the served route row equals its own derive) but a refused paid shadow with different rows exists -> '" + REFUSED + "' (an ALERT, never PUBLICATION_NOT_REQUIRED)", x.pub.disposition === "newer-live" && stateOf(scan, "USA1").state === RS.DD && stateOf(scan, "USA1").reason === REFUSED);
    }
    // (D) NOT refused: a refused shadow with EQUAL masked content (the refusal lost nothing), and a PAID-owned live row
    // stamped at / after the shadow (a paid writer superseded it) -> 'none'.
    {
      const x = await refusedWorld({ oliMove: false });
      const scan = await makeCtx({ w: x.w, dw: x.dw, bucket: "us-ca" }).run({ dryRun: true, accountIds: ["USA1"] });
      const f = await fillWorld();
      const later = clone(f.c2); later.inventoryFetchedAt = T10;
      f.w.putLive("USA1", SALES, later, "2026-09-24T11:00:00.000Z"); // a PAID row stamped after the paid shadow below
      await seedPaidJob(f.w, f.paid, "USA1", f.paid.result.payload, LST_FETCHED, { cycleBucket: "us-fba" });
      const s = await makeCtx({ w: f.w, dw: f.dw, bucket: "us-ca" }).run({ dryRun: true, accountIds: ["USA1"] });
      ok("R7b (D) a refused paid shadow with EQUAL masked content is harmless ('none': the scan is current); a PAID-owned live row stamped after the shadow is 'none' too (the served paid row decides: paid-owned)", x.pub.disposition === "newer-live" && stateOf(scan, "USA1").state === RS.NR
        && stateOf(s, "USA1").reason === "superseded-newer-live:paid-owned");
    }
    // (E) publishGuard re-verifies: only the SAME refused shadow the prepare proved it serves (guard.refusedPaidDigest)
    // passes the verdict; any other refused shadow is the ALERT, zero CAS.
    {
      const x = await refusedWorld({ mutate: (p) => { p.rows[0].fbaAvailable = 555; } });
      const ctx = makeCtx({ w: x.w, dw: x.dw, bucket: "us-ca" });
      const b = await ctx.runtime.resolveBundle(unitOf("USA1"), { strict: true, epoch: INV, bucket: "us-ca" });
      const routeJob = x.w.jobs.find((j) => j.durable_content_deps.some((d) => d.startsWith(W.FBA_PLAN_TOKEN_PREFIX)));
      const base = { salesAsOf: SALES, inventoryAsOf: INV, fbaValidatedAt: FBA_VALIDATED, awdValidatedAt: LST_FETCHED, awdApplicable: true, foreignJobId: (await x.w.readLatestJob(RK, "USA1")).id };
      const pg = (guard) => ctx.runtime.publishGuard(unitOf("USA1"), { guard, shadowParamsHash: routeJob.snapshot_params_hash }, { epoch: INV, bucket: "us-ca" });
      const cas0 = x.w.n.liveCas;
      const vNo = await pg({ ...base, refusedPaidDigest: null });
      const vOther = await pg({ ...base, refusedPaidDigest: "0".repeat(64) });
      const vSame = await pg({ ...base, refusedPaidDigest: FB.fbaPlanRefusedPaidDigest(x.shadow) });
      ok("R7b (E) publishGuard: a refused paid shadow -> NEWER_LIVE '" + REFUSED + "' (zero CAS) unless guard.refusedPaidDigest is ITS masked content digest (then the remaining checks decide -- here 'publish-guard:lineage-advanced': the latest job is the paid one); resolveBundle refuses it outright ('" + REFUSED + "')",
        b.eligible === false && b.reason === REFUSED && vNo.state === "NEWER_LIVE" && vNo.reason === REFUSED && vOther.state === "NEWER_LIVE" && vOther.reason === REFUSED
        && vSame.state === RS.DD && vSame.reason === "publish-guard:lineage-advanced" && x.w.n.liveCas === cas0);
    }
    // (F) PURE: the refused slot in the verdict + the resolve's convergence proof (fail closed without deriveContent).
    {
      const V = FBA_VALIDATED;
      const M_ = { state: "missing" };
      const shadow = { inventoryRequestedThrough: INV, inventoryDate: INV, inventoryFetchedAt: INV_FETCHED, asOf: SALES, rows: [{ asin: "A", fbaAvailable: 1 }] };
      const refused = { state: "refused", jobId: "job-p", payload: shadow, refreshedAt: LST_FETCHED, params: { to: SALES }, liveRefreshedAt: V };
      const G = (o) => { const v = FB.fbaPlanLiveGuard({ live: { served: M_, exact: M_ }, paid: refused, cycles: { state: "none" }, salesAsOf: SALES, inventoryAsOf: INV, inventoryValidatedAt: V, awdValidatedAt: null, ...o }); return v.hard || v.newerLive; };
      ok("R7b (F) fbaPlanLiveGuard: a refused paid slot -> '" + REFUSED + "'; with acceptRefusedDigest = its masked digest -> null (convergence proven), any other digest -> refused; an open paid cycle is reported first (refused is the LAST check); a refused slot without liveRefreshedAt is 'inventory-guard:paid-lineage-unreadable'; the EU5 AWD regression guard sees a refused shadow's awdAvailable:true",
        G({}) === REFUSED && G({ acceptRefusedDigest: FB.fbaPlanRefusedPaidDigest(shadow) }) === null && G({ acceptRefusedDigest: "x" }) === REFUSED
        && G({ cycles: { state: "open", bucket: "us-fba" } }) === "paid-cycle-open:us-fba" && G({ paid: { ...refused, liveRefreshedAt: "" } }) === "inventory-guard:paid-lineage-unreadable"
        && FB.fbaPlanAwdRegressionReason(FB.fbaPlanLiveGuard({ live: { served: M_, exact: M_ }, paid: { ...refused, payload: { ...shadow, awdAvailable: true } }, cycles: { state: "none" }, salesAsOf: SALES, inventoryAsOf: INV, inventoryValidatedAt: V })) === "awd-regression-guard"
        && FB.fbaPlanRefusedPaidDigest({ ...shadow, inventoryFetchedAt: "x", accountName: "y" }) === FB.fbaPlanRefusedPaidDigest(shadow) && FB.fbaPlanRefusedPaidDigest(null) === "");
      const dw = makeDurable(); await seedDurable(dw, ACCOUNTS);
      const ctxG = makeCtx({ w: makeWorld(), dw, bucket: "us-ca" });
      const evG = (await ctxG.runtime.readScopeEvidence({ scope: ["USA1"], epoch: INV, bucket: "us-ca", organizationFingerprint: ORG })).perAccount.get("USA1");
      const d0 = await ctxG.runtime.resolveBundle(unitOf("USA1"), { strict: true, epoch: INV, bucket: "us-ca" });
      const derived = (await ctxG.runtime.derive(d0.bundle)).payload;
      const readers = (deriveContent, liveRefreshedAt = "2026-09-24T08:00:00.000Z") => ({
        loadSnapshotPayload: (p) => ctxG.deps.sb.getSourceSnapshotPayload(p), readOliHistory: (q) => ctxG.deps.sb.getSourceOliHistoryRows(q),
        readLiveRows: async () => ({ served: M_, exact: M_ }), readPaidCycles: async () => ({ state: "none" }), connections: CONNS, buildObjectPath: sourceSnapshotObjectPath,
        readPaidPending: async () => ({ state: "refused", jobId: "job-p", payload: derived, refreshedAt: LST_FETCHED, params: { to: SALES }, liveRefreshedAt }),
        ...(deriveContent ? { deriveContent } : {}),
      });
      const res = (r) => FB.resolveFbaPlanDependencyBundle(r, { evidence: evG, organizationFingerprint: ORG, connectionId: "primary", apiKey: API_KEY });
      const noDerive = await res(readers(null));
      const conv = await res(readers(async (b) => (await ctxG.runtime.derive(b)).payload));
      const notNewer = await res(readers(async (b) => (await ctxG.runtime.derive(b)).payload, FBA_VALIDATED));
      const differs = await res(readers(async () => ({ ...derived, rows: [] })));
      ok("R7b (F) resolveFbaPlanDependencyBundle: a refused paid shadow is released ONLY by a proven convergence -- evidence instant strictly after the refusing route row AND the derive content-equivalent -> eligible with guard.refusedPaidDigest; no deriveContent reader, an evidence instant NOT after the route row (the benign stamp case) or a different derive -> '" + REFUSED + "'",
        conv.eligible === true && conv.guard.refusedPaidDigest === FB.fbaPlanRefusedPaidDigest(derived) && conv.newerLive === null
        && [noDerive, notNewer, differs].every((r) => r.eligible === false && r.reason === REFUSED));
    }
  }
  // R8 (probeBound B2): the route's stamp is the PAID-FETCH-DERIVED instant only -- an OLI re-ack at 11:00 no longer
  // inflates it, so a later genuinely newer paid fetch (10:00) out-ranks the route row in the fenced CAS.
  {
    const f = await fillWorld();
    const { dw, paid, c2, w } = f;
    bumpOliQ(dw, "2026-09-24T11:00:00.000Z");
    w.tick(6 * 3600 * 1000); // now 12:00
    const ctx = makeCtx({ w, dw, bucket: "us-ca" });
    const s = await ctx.run({ dryRun: false, accountIds: ["USA1"] });
    const routeRow = clone(w.live("USA1", SALES));
    const pj = await createPaidJob(w, paid, "USA1", { cycleBucket: "bootstrap-fba-us-ca-x" });
    await completePaidJob(w, pj, c2, T10);
    const pub = await w.publisherFor(null).publish(RK, "USA1");
    const l = w.live("USA1", SALES);
    ok("R8 (probeBound B2) the route fills with source_refreshed_at = the FBA validated_at (09:00) -- NOT the 11:00 OLI re-ack; a LATER paid job of the same D-1 with a genuinely newer fetch (10:00) then PUBLISHES over it (never CAS-refused 'newer-live'); the route then defers 'superseded-newer-live:paid-owned'",
      stateOf(s, "USA1").state === RS.RV && routeRow.source_refreshed_at === FBA_VALIDATED && pub.disposition === "published" && l.payload.rows[0].fbaAvailable === 777 && l.source_refreshed_at === T10
      && stateOf(await ctx.run({ dryRun: false, accountIds: ["USA1"] }), "USA1").reason === "superseded-newer-live:paid-owned");
  }
  // R9 (probeStale S1 / S2): a STALE pending paid shadow at {to: salesAsOf} + a NEWER non-job live row (555) at the exact
  // identity -- served, or hidden behind a later-updated older-`to` served row.
  for (const where of ["served", "exact-behind-older-served"]) {
    const dw = makeDurable(); const seed = await seedDurable(dw, ACCOUNTS);
    const paid = await paidDerive(seed, dw, "USA1");
    const w = makeWorld();
    await seedPaidJob(w, paid, "USA1", paid.result.payload, "2026-09-24T08:40:00.000Z");
    const nw = clone(paid.result.payload); nw.rows[0].fbaAvailable = 555; nw.inventoryFetchedAt = T10;
    w.putLive("USA1", SALES, nw, "2026-09-24T08:50:00.000Z");
    if (where !== "served") { const old = clone(paid.result.payload); old.asOf = "2026-09-19"; w.putLive("USA1", "2026-09-19", old, "2026-09-19T08:00:00.000Z"); }
    const before = w.writes();
    const s = await makeCtx({ w, dw, bucket: "us-ca" }).run({ dryRun: false, accountIds: ["USA1"] });
    const want = where === "served" ? "superseded-newer-live:paid-owned" : "bundle-superseded-newer-live:paid-owned";
    ok(`R9 (probeStale ${where}) a stale pending paid shadow + a NEWER paid row (555) at {to: salesAsOf} -> '${want}': ZERO route writes, no route job, 555 kept`, stateOf(s, "USA1").state === RS.DD && stateOf(s, "USA1").reason === want && routeWrites(w, before) === 0 && w.jobs.filter((j) => j.durable_content_deps.length).length === 0 && w.live("USA1", SALES).payload.rows[0].fbaAvailable === 555);
  }
  // R10 FILL: the paid path has not published the D-1 (yesterday's paid row served) -> the route publishes {to: salesAsOf}.
  {
    const f = await fillWorld();
    const ctx = makeCtx({ w: f.w, dw: f.dw, bucket: "us-ca" });
    const scan = await ctx.run({ dryRun: true, accountIds: ["USA1"] });
    const s = await ctx.run({ dryRun: false, accountIds: ["USA1"] });
    const l = f.w.live("USA1", SALES);
    const again = await ctx.run({ dryRun: false, accountIds: ["USA1"] });
    ok("R10 FILL: yesterday's PAID row served ({to: " + PREV + "}), nothing at {to: " + SALES + "}, no paid job -> scan STALE 'served-older-to' -> the route PUBLISHES {to: salesAsOf} (READBACK_VERIFIED; route-written tokens, stamp = FBA validated_at); it is now the served row; the next pass is current (zero writes); the paid {to: " + PREV + "} row is untouched",
      stateOf(scan, "USA1").reason === "served-older-to" && stateOf(s, "USA1").state === RS.RV && FB.fbaPlanRowOwner(l.params) === "route" && l.source_refreshed_at === FBA_VALIDATED
      && JSON.stringify(await servedOf(f.w)) === JSON.stringify({ to: SALES, owner: "route" }) && stateOf(again, "USA1").state === RS.NR && f.w.live("USA1", PREV).payload.rows[0].fbaAvailable === 1);
  }
  // R11 ROUTE-OVER-ROUTE: the route's own row is replaced when its durable evidence moves (a new FBA persist).
  {
    const f = await fillWorld();
    const ctx = makeCtx({ w: f.w, dw: f.dw, bucket: "us-ca" });
    await ctx.run({ dryRun: false, accountIds: ["USA1"] });
    const rows = clone(f.dw.storage.get(f.dw.fba.get("USA1").object_path).rows); rows[0].available = 42;
    rewritePointer(f.dw, "fba", "USA1", rows, { validated_at: new Date("2026-09-24T10:30:00.000Z") });
    f.w.tick(60000);
    const scan = await ctx.run({ dryRun: true, accountIds: ["USA1"] });
    const s = await ctx.run({ dryRun: false, accountIds: ["USA1"] });
    const l = f.w.live("USA1", SALES);
    ok("R11 ROUTE-OVER-ROUTE: the durable FBA evidence moves (new rows, validated 10:30) under the route's OWN live row -> scan STALE 'content-differs' -> READBACK_VERIFIED; the replacement carries the new content, stamp 10:30, route tokens", stateOf(scan, "USA1").state === RS.ST && stateOf(scan, "USA1").reason === "content-differs"
      && stateOf(s, "USA1").state === RS.RV && l.source_refreshed_at === "2026-09-24T10:30:00.000Z" && l.payload.inventoryFetchedAt === "2026-09-24T10:30:00.000Z" && FB.fbaPlanRowOwner(l.params) === "route" && f.w.jobs.length === 2);
  }
  // R12 an OLI-ONLY change of a ROUTE row: the token + manifest move, the paid-fetch-only stamp does not ->
  // 'evidence-instant-not-advanced' (typed, zero writes), NEVER reported current.
  {
    const f = await fillWorld();
    const ctx = makeCtx({ w: f.w, dw: f.dw, bucket: "us-ca" });
    await ctx.run({ dryRun: false, accountIds: ["USA1"] });
    const writes = f.w.writes(); const cas = f.w.n.liveCas;
    f.dw.history.push({ account_id: "USA1", seller_or_vendor_id: "USA1", sale_date: "2026-09-22", sku: "SKU-USA1-0", child_asin: "B0USA10", currency: "USD", sales_amount: 99, units: 9, source_request_hash: "oli-USA1" });
    bumpOliQ(f.dw, "2026-09-24T11:00:00.000Z");
    f.w.tick(60000);
    const scan = await ctx.run({ dryRun: true, accountIds: ["USA1"] });
    const verify = await ctx.run({ dryRun: true, accountIds: ["USA1"], verifyExact: true });
    const s = await ctx.run({ dryRun: false, accountIds: ["USA1"] });
    ok("R12 an OLI-ONLY change (a new history row + its coverage re-ack) of a ROUTE-written row: scan / verify-exact STALE 'content-differs' (NEVER current), the live pass defers 'evidence-instant-not-advanced' (the stamp is FBA / AWD only) with ZERO writes / CAS -- the accepted fill-only cost (WP11: 'awaiting-next-fba-fetch', no alert)",
      [scan, verify].every((x) => stateOf(x, "USA1").state === RS.ST) && stateOf(scan, "USA1").reason === "content-differs" && stateOf(s, "USA1").state === RS.DD && stateOf(s, "USA1").reason === REL.EVIDENCE_INSTANT_NOT_ADVANCED
      && f.w.writes() === writes && f.w.n.liveCas === cas && f.w.live("USA1", SALES).source_refreshed_at === FBA_VALIDATED);
  }
  // R13 THE STAMP: max(FBA validated_at, AWD validated_at when used) -- OLI coverage / catalog instants excluded.
  {
    const dw = makeDurable(); await seedDurable(dw, ACCOUNTS);
    bumpOliQ(dw, "2026-09-24T11:00:00.000Z");
    dw.catalog.validated_at = new Date("2026-09-24T12:00:00.000Z");
    const us = await makeCtx({ w: makeWorld(), dw, bucket: "us-ca" }).runtime.resolveBundle(unitOf("USA1"), { strict: true, epoch: INV, bucket: "us-ca" });
    dw.listings.get("USA1").validated_at = new Date("2026-09-24T09:30:00.000Z");
    const usAwd = await makeCtx({ w: makeWorld(), dw, bucket: "us-ca" }).runtime.resolveBundle(unitOf("USA1"), { strict: true, epoch: INV, bucket: "us-ca" });
    const ca = await makeCtx({ w: makeWorld(), dw, bucket: "us-ca" }).runtime.resolveBundle(unitOf("CAA1"), { strict: true, epoch: INV, bucket: "us-ca" });
    ok("R13 evidenceInstant = max(FBA validated_at, durable AWD validated_at) ONLY: an 11:00 OLI re-ack and a 12:00 catalog validation do not move it (US 09:00; US with a 09:30 Listings pointer 09:30; CA (no AWD) 09:00)", us.evidenceInstant === FBA_VALIDATED && usAwd.evidenceInstant === "2026-09-24T09:30:00.000Z" && ca.evidenceInstant === FBA_VALIDATED);
  }
  // R14 THE ACTIVATION GATE: FBA_PLAN_ROUTE_FENCE_ATTESTED must be exactly 'true' for any LIVE write.
  {
    ok("R14 fbaPlanRouteFenceAttested: ONLY env.FBA_PLAN_ROUTE_FENCE_ATTESTED === 'true' attests (unset / 'TRUE' / '1' / ' true' / a boolean / non-object -> refused)", RELMOD.FBA_PLAN_ROUTE_FENCE_ATTESTED_ENV === "FBA_PLAN_ROUTE_FENCE_ATTESTED" && RELMOD.fbaPlanRouteFenceAttested({ FBA_PLAN_ROUTE_FENCE_ATTESTED: "true" }) === true
      && [{}, { FBA_PLAN_ROUTE_FENCE_ATTESTED: "TRUE" }, { FBA_PLAN_ROUTE_FENCE_ATTESTED: "1" }, { FBA_PLAN_ROUTE_FENCE_ATTESTED: " true" }, { FBA_PLAN_ROUTE_FENCE_ATTESTED: true }, null, "true"].every((e) => RELMOD.fbaPlanRouteFenceAttested(e) === false));
    for (const env of [{}, { FBA_PLAN_ROUTE_FENCE_ATTESTED: "TRUE" }]) {
      const f = await fillWorld();
      const ctx = makeCtx({ w: f.w, dw: f.dw, bucket: "us-ca", env });
      const scan = await ctx.run({ dryRun: true, accountIds: ["USA1"] });
      const verify = await ctx.run({ dryRun: true, accountIds: ["USA1"], verifyExact: true });
      const s = await ctx.run({ dryRun: false, accountIds: ["USA1"] });
      const st1 = stateOf(s, "USA1");
      ok("R14 an UNATTESTED build (" + JSON.stringify(env) + ") logs the refusal; dry-run + verify-exact are UNAFFECTED (STALE 'served-older-to'); the LIVE run STOPS the unit at the release's derive hook -- FAILED_DERIVE 'derive-threw:fba-plan-route-fence-not-attested...' -- with ZERO writes (no cycle / job / shadow / CAS)",
        ctx.logs.some((m) => /FBA_PLAN_ROUTE_FENCE_ATTESTED is not exactly 'true'/.test(m)) && [scan, verify].every((x) => stateOf(x, "USA1").state === RS.ST && stateOf(x, "USA1").reason === "served-older-to")
        && st1.state === RS.FD && /^derive-threw:fba-plan-route-fence-not-attested/.test(S(st1.reason)) && f.w.writes() === 0 && f.w.n.liveCas === 0);
    }
    // The RESUME path (a derivation an attested run prepared but never published) is refused at publishGuard (zero CAS).
    {
      const f = await fillWorld();
      const a = makeCtx({ w: f.w, dw: f.dw, bucket: "us-ca", onOpenControls: async () => { throw new Error("control lease busy"); } });
      try { await a.run({ dryRun: false, accountIds: ["USA1"] }); } catch (_e) { /* the busy window */ }
      const prepared = f.w.jobs.length === 1 && f.w.jobs[0].validated === true;
      const writes = f.w.writes();
      const s = await makeCtx({ w: f.w, dw: f.dw, bucket: "us-ca", env: {} }).run({ dryRun: false, accountIds: ["USA1"] });
      ok("R14 the RESUME path: an attested run prepared (validated route job, controls busy) but never published; an UNATTESTED live run resumes it without a derive and publishGuard refuses 'fba-plan-route-fence-not-attested' -- ZERO writes, ZERO CAS", prepared && stateOf(s, "USA1").state === RS.DD && stateOf(s, "USA1").reason === "fba-plan-route-fence-not-attested" && f.w.writes() === writes && f.w.n.liveCas === 0 && !f.w.live("USA1", SALES));
    }
    // The CLI shape (no deps.env): process.env is read ONCE at build.
    {
      const keep = process.env.FBA_PLAN_ROUTE_FENCE_ATTESTED;
      delete process.env.FBA_PLAN_ROUTE_FENCE_ATTESTED;
      const f1 = await fillWorld();
      const s1 = await makeCtx({ w: f1.w, dw: f1.dw, bucket: "us-ca", env: null }).run({ dryRun: false, accountIds: ["USA1"] });
      process.env.FBA_PLAN_ROUTE_FENCE_ATTESTED = "true";
      const f2 = await fillWorld();
      const c2 = makeCtx({ w: f2.w, dw: f2.dw, bucket: "us-ca", env: null });
      delete process.env.FBA_PLAN_ROUTE_FENCE_ATTESTED; // read ONCE at build: a later change does not un-attest this run
      const s2 = await c2.run({ dryRun: false, accountIds: ["USA1"] });
      if (keep === undefined) delete process.env.FBA_PLAN_ROUTE_FENCE_ATTESTED; else process.env.FBA_PLAN_ROUTE_FENCE_ATTESTED = keep;
      ok("R14 without deps.env the build reads process.env ONCE: unset -> the live fill is refused (FAILED_DERIVE, zero writes); 'true' at build -> the fill publishes (READBACK_VERIFIED)", stateOf(s1, "USA1").state === RS.FD && f1.w.writes() === 0 && stateOf(s2, "USA1").state === RS.RV);
    }
  }
  // R15 the newest-foreign-job statement: ONE read-only SELECT, dates as text, route lineage = BOTH current prefixes.
  {
    const q = RELMOD.FBA_PLAN_FOREIGN_JOB_SQL;
    ok("R15 FBA_PLAN_FOREIGN_JOB_SQL is ONE read-only SELECT (isReadOnlyEvidenceSql), reads cycle_date ::text, excludes route lineage by BOTH the current evidence-token and manifest prefixes, orders created_at desc + id desc (= the publisher's latest-job order) and returns the newest job id; params = [account, token%, manifest%]",
      RC.isReadOnlyEvidenceSql(q.text) && /c\.cycle_date::text as cycle_date/.test(q.text) && /order by j\.created_at desc, j\.id desc limit 1/.test(q.text) && /as latest_id/.test(q.text) && /d\.dep like \$2\) and exists/.test(q.text)
      && JSON.stringify(q.params("USA1")) === JSON.stringify(["USA1", W.FBA_PLAN_TOKEN_PREFIX + "%", FB.FBA_PLAN_MANIFEST_PREFIX + "%"]) && W.FBA_PLAN_TOKEN_PREFIX === "fp2:");
  }
}

// =====================================================================================================================
// K. promoted gate: the route package never enables the fba-plan dispatch control
// =====================================================================================================================
{
  const pkg = CP.buildRouteControlPackage({ accounts: ["USA1", "CAA1"], operator: "publication-route-reconcile:us-ca:run-token-1", publisherKeys: [RK], controlledReportKeys: CONTROLLED_REPORT_KEYS });
  const fbaSetting = pkg.apply.reportSyncSettings.find((r) => r.report_key === RK);
  ok("K1 the route control package pauses the fba-plan DISPATCH control (schedule_enabled false), opens ONLY the promoted 'fba-plan' gate, and asserts zero dispatch enabled", CONTROLLED_REPORT_KEYS.includes(RK) && fbaSetting && fbaSetting.schedule_enabled === false && pkg.apply.reportSyncSettings.every((r) => r.schedule_enabled === false)
    && JSON.stringify(pkg.apply.promoted) === JSON.stringify([{ report_key: RK, publish_enabled: true }]) && pkg.post.dispatchEnabled.length === 0 && pkg.post.allDispatchPaused === true && JSON.stringify(pkg.post.promotedEnabled) === '["fba-plan"]');
  ok("K1 the fba-plan contract's WP1 promotedGateKey is 'fba-plan' (GATE 2 opens on the promoted row, never the paid dispatch control)", LC[RK].promotedGateKey === "fba-plan");
  // With the promoted gate CLOSED the route cannot publish (it never falls back to opening the dispatch control).
  const dw = makeDurable(); await seedDurable(dw, ACCOUNTS);
  const w = makeWorld({ promoted: [] });
  const ctx = makeCtx({ w, dw, bucket: "india" });
  const s = await ctx.run({ dryRun: false });
  ok("K2 promoted gate closed + dispatch closed -> the publish is refused at preflight 'report-disabled' (FAILED_PUBLISH), zero live writes", stateOf(s, "INA1").state === RS.FP && /report-disabled/.test(S(stateOf(s, "INA1").reason)) && w.n.liveWrite === 0);
}

// =====================================================================================================================
// L. zero export + evidence read failure
// =====================================================================================================================
{
  const dw = makeDurable(); await seedDurable(dw, ACCOUNTS);
  dw.failSql = true;
  const w = makeWorld();
  const ctx = makeCtx({ w, dw, bucket: "us-ca" });
  const s = await ctx.run({ dryRun: false });
  ok("L1 an unreadable durable evidence read defers the WHOLE run (typed DURABLE_SOURCE_UNREADABLE), zero writes", s.ok === false && /DURABLE_SOURCE_UNREADABLE/.test(S(s.code)) && w.writes() === 0);
  const relSrc = src("lib/server/sync/routes/fba-plan.release.js") + src("lib/server/sync/fba-plan-dependency-bundle.js") + src("lib/server/recovery/routes/fba-plan.route.js");
  ok("L2 the route modules name NO acquisition path: no source-bucket-sync / fba-durable-source-persist / source-export-cache / DataDoe client import", !/from "[^"]*(source-bucket-sync|fba-durable-source-persist|source-worker|source-sync-driver|datadoe\.js|runtime-composition|publisher-composition)[^"]*"/.test(relSrc) && !/getSourceExportCache|createExport|fetchExportRows/.test(relSrc));
  ok("L3 7-bit ASCII + LF across the three route modules and this test", [relSrc, src("scripts/fba-plan-zero-export-route.test.js")].every((t) => /^[\x00-\x7f]*$/.test(t) && !t.includes("\r")));
  ok("L4 ZERO network / ZERO DataDoe across the whole suite", net.calls.length === 0);
}

out(`fba-plan-zero-export-route: ${passed} passed`);
