// Publication recovery WP6 -- the ZERO-EXPORT 'sku-movement' recovery route: the worker-side declaration
// (lib/server/recovery/routes/sku-movement.route.js), the CLI-side release (lib/server/sync/routes/sku-movement.release.js),
// the shared pure evidence / serve-token module (lib/server/reports/sku-movement-evidence.js), the STRICT durable
// re-derive (lib/server/reports/sku-movement-durable-rederive.js) and the retired manual backfill.
//
// Fully offline: a faithful in-memory lineage world (sync_cycles / sync_report_jobs with the derive lease / the
// report_snapshots shadow CAS + FENCED live CAS) driven by the REAL four-gate publisher (publisher-composition.js
// buildSchedulerV2Publisher with build-time overrides), the REAL generic route release + adapter, the REAL saved-data
// reconciler two-phase core and the REAL serve selector; the durable evidence lives in a fake store read through a fake
// READ-ONLY pg client (it answers ONLY the route's own evidence statements, emulating their SQL semantics) and a fake
// read-only supabase facade. The global fetch is a refusing stub (zero DataDoe / Supabase / network, asserted).
//   R. module + runtime contracts; the evidence SQL is read-only and every column it names exists in the migration DDL.
//   E. end to end: ALL + the verified brand units publish; a re-scan is PUBLICATION_NOT_REQUIRED (served-row check) and
//      --verify-exact proves the manifest lineage.
//   T. the owner requirement: a SAME-effectiveAsOf OLI correction and an operational-units backfill (count OR
//      updated_at) change the token and re-publish; unrelated changes do not.
//   C. C8: a catalog read failure / payload-load failure / missing pointer DEFERS with zero writes -- never a brandless
//      ALL or an empty named payload (the non-strict serve path would have rendered one).
//   U. named units come ONLY from the VERIFIED live brand-view-brands row; the brand string is exact; typed markers.
//   M. OLI (and the org catalog) load ONCE per account across units (memo); the L1 metadata is re-read per resolve.
//   S. skuMovementStoredIsCurrent (new-token + legacy rows), stripStoredExtras, serve-token parity with the WP10 serve.
//   D. strict re-derive typed failures; the NON-strict output is byte-identical to the pre-WP6 implementation.
//   B. the retired backfill refuses (exit 2) and names the route CLI.
// 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync, readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";
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

const REL = await import("../lib/server/sync/route-publication-release.js");
const { buildSchedulerV2Publisher } = await import("../lib/server/sync/publisher-composition.js");
const { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, skuMovementTargetId, skuMovementCanonicalBrand } = await import("../lib/server/sync/report-publisher.js");
const { REPORT_DERIVATIONS } = await import("../lib/server/sync/report-derivation.js");
const { paramsHashFor } = await import("../lib/server/report-store.js");
const B = await import("../lib/server/sync/publication-binding.js");
const SDR = await import("../lib/server/sync/saved-data-reconciler.js");
const RC = await import("../lib/server/recovery/route-contract.js");
const SEL = await import("../lib/server/recovery/serve-selectors.js");
const TGT = await import("../lib/server/sync/reconcile-targets-output.js");
const W = await import("../lib/server/recovery/routes/sku-movement.route.js");
const C = await import("../lib/server/sync/routes/sku-movement.release.js");
const EVI = await import("../lib/server/reports/sku-movement-evidence.js");
const RD = await import("../lib/server/reports/sku-movement-durable-rederive.js");
const { monthBackStr } = await import("../lib/server/date-windows.js");
const { skuMovementPayload } = await import("../lib/server/reports/sku-movement-core.js");
const OSE = await import("../lib/server/sync/oli-sales-estimate.js");

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; out("  ok  " + name); };
const S = (v) => (v == null ? "" : String(v));
const sha12 = (v) => createHash("sha256").update(String(v)).digest("hex").slice(0, 12);
const clone = (v) => JSON.parse(JSON.stringify(v));

const KEY = "sku-movement";
const VERSION = "sku-movement/v2";
const ORG = "org-fp-test";
const A = "acct-a-0001";
const BB = "acct-b-0002";
const REGION = "india";
const EPOCH = "2026-09-24";
const RS = { NR: "PUBLICATION_NOT_REQUIRED", RV: "READBACK_VERIFIED", DD: "DEFERRED_DEPENDENCY", DP: "DEFERRED_PROVENANCE", ST: "STALE" };
const CAT_PATH = "source-snapshots/product-catalog/catsha1.json";
const liveHash = (asOf, brand) => paramsHashFor(VERSION, { asOf, brand });

// =====================================================================================================================
// The durable evidence store (source_coverage / source_oli_daily_history / source_oli_operational_units / the org
// catalog pointer + payload / resolution rows) -- read by the fake pg client + the fake read-only supabase facade.
// =====================================================================================================================
function makeStore() {
  return {
    coverage: [
      { organization_fingerprint: ORG, connection_id: "primary", account_id: A, source_key: "order-line-items", covered_from: "2026-01-01", covered_to: "2026-09-23", status: "succeeded", source_refreshed_at: "2026-09-24T01:00:00.000Z", updated_at: "2026-09-24T01:00:00.000Z" },
      { organization_fingerprint: ORG, connection_id: "primary", account_id: BB, source_key: "order-line-items", covered_from: "2026-03-01", covered_to: "2026-09-22", status: "succeeded", source_refreshed_at: "2026-09-23T01:00:00.000Z", updated_at: "2026-09-23T01:00:00.000Z" },
    ],
    history: [
      { account_id: A, seller_or_vendor_id: "raw-a", sale_date: "2026-09-22", sku: "A-1", child_asin: "B0ACME1", currency: "INR", sales_amount: 100, units: 2, source_request_hash: "h1" },
      { account_id: A, seller_or_vendor_id: "raw-a", sale_date: "2026-09-23", sku: "A-1", child_asin: "B0ACME1", currency: "INR", sales_amount: 50, units: 1, source_request_hash: "h1" },
      { account_id: A, seller_or_vendor_id: "raw-a", sale_date: "2026-09-23", sku: "C-1", child_asin: "B0CARU1", currency: "INR", sales_amount: 70, units: 3, source_request_hash: "h1" },
      { account_id: A, seller_or_vendor_id: "raw-a", sale_date: "2026-07-10", sku: "C-1", child_asin: "B0CARU1", currency: "INR", sales_amount: 20, units: 1, source_request_hash: "h0" },
      { account_id: A, seller_or_vendor_id: "raw-a", sale_date: "2026-09-23", sku: "Z-1", child_asin: "B0ZETA1", currency: "INR", sales_amount: 10, units: 1, source_request_hash: "h1" },
      { account_id: BB, seller_or_vendor_id: "raw-b", sale_date: "2026-09-21", sku: "A-9", child_asin: "B0ACME1", currency: "INR", sales_amount: 30, units: 1, source_request_hash: "hb" },
    ],
    opunits: [
      { organization_fingerprint: ORG, connection_id: "primary", account_id: A, seller_or_vendor_id: "raw-a", sale_date: "2026-09-23", sku: "A-1", child_asin: "", currency: "INR", priced_units: 0, priced_sales: null, explicit_zero_units: 0, pending_units: 2, cancelled_units: 0, source_request_hash: "h1", updated_at: "2026-09-24T01:00:00.000Z" },
    ],
    catalogPointer: { organization_fingerprint: ORG, connection_id: "primary", source_key: "product-catalog", scope_key: "__organization", object_path: CAT_PATH, payload_sha: "catsha1", row_count: 3, payload_bytes: 10, source_request_hash: "catreq1", validated_at: "2026-09-20T00:00:00.000Z" },
    catalogPayloads: new Map([[CAT_PATH, { rows: [
      { child_asin: "B0ACME1", product_brand: "Acme", product_name: "Acme Widget", sku: "A-1" },
      { child_asin: "B0CARU1", product_brand: "Caruso Italy", product_name: "Caruso Pan" },
      { child_asin: "B0ZETA1", product_brand: "Zeta", product_name: "Zeta Cup" },
    ] }]]),
    resolution: new Map([[A, [{ seller_or_vendor_id: "raw-a", currency: "INR", sku: "A-1", asin_count: 1, child_asin: "B0ACME1" }]], [BB, []]]),
    fail: { coverage: null, catalog: null, catalogPayload: false, pg: false, brandList: false },
    calls: { history: new Map(), catalogPayload: 0, pg: 0, pgByName: new Map(), coverage: 0 },
    // When set, the facade's getSourceCoverageWindows ALSO returns each window's updatedAt = covStampFn(row) (the
    // WP10-extended reader); null = today's reader ({ from, to } only).
    covStampFn: null,
  };
}
const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
// Postgres to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') of an ISO instant (ms precision in the fixtures).
const toUs = (iso) => (iso == null ? null : S(iso).replace(/\.(\d{3})Z$/, ".$1000Z"));
// PostgREST's JSON rendering of the SAME timestamptz (fraction trimmed, '+00:00' offset) -- what the WP10 serve reads.
const pgrest = (iso) => (iso == null ? null : S(iso).replace(/\.000Z$/, "+00:00").replace(/(\.\d*?)0+Z$/, "$1+00:00").replace(/Z$/, "+00:00"));

// The fake READ-ONLY pg client: it answers ONLY the route's own statements (exact text), emulating their SQL.
function makePg(store, world) {
  const byText = new Map(W.SKU_MOVEMENT_EVIDENCE_SQL.map((q) => [q.text, q.name]));
  byText.set(C.SKU_BRAND_LIST_SQL, "brand_list");
  return async (text, values = []) => {
    if (!RC.isReadOnlyEvidenceSql(text)) throw new Error("fake pg: non-read-only statement");
    const name = byText.get(text);
    if (!name) throw new Error("fake pg: unknown statement");
    store.calls.pg += 1; bump(store.calls.pgByName, name);
    if (store.fail.pg) throw new Error("fake pg: connection refused");
    if (name === "brand_list" && store.fail.brandList) throw new Error("fake pg: brand list read refused");
    const snapRows = () => [...world.snaps.values()];
    if (name === "sku_coverage") {
      const [org, conn, ids] = values;
      return store.coverage.filter((r) => r.organization_fingerprint === org && r.connection_id === conn && r.source_key === "order-line-items" && r.status === "succeeded" && ids.includes(r.account_id))
        .map((r) => ({ account_id: r.account_id, covered_from: r.covered_from, covered_to: r.covered_to, source_refreshed_at: toUs(r.source_refreshed_at), updated_at: toUs(r.updated_at) }))
        .sort((x, y) => (x.account_id + x.covered_from + x.covered_to < y.account_id + y.covered_from + y.covered_to ? -1 : 1));
    }
    if (name === "sku_opunits") {
      const [org, conn, ids, ceiling] = values;
      const out2 = [];
      for (const id of [...ids].sort()) {
        const tos = store.coverage.filter((r) => r.organization_fingerprint === org && r.connection_id === conn && r.source_key === "order-line-items" && r.status === "succeeded" && r.account_id === id).map((r) => r.covered_to);
        if (!tos.length) continue;
        const maxTo = tos.sort().pop();
        // least(max(covered_to), $4::date): Postgres LEAST ignores a NULL $4 (params bound without `now`).
        const eff = ceiling == null || maxTo < ceiling ? maxTo : ceiling;
        const from = monthBackStr(eff, 3);
        const rows = store.opunits.filter((u) => u.organization_fingerprint === org && u.connection_id === conn && u.account_id === id && u.sale_date >= from && u.sale_date <= eff);
        const maxUpd = rows.map((u) => u.updated_at).sort().pop();
        out2.push({ account_id: id, eff_as_of: eff, window_from: from, unit_rows: rows.length, max_updated_at: maxUpd ? toUs(maxUpd) : null });
      }
      return out2;
    }
    if (name === "sku_catalog") {
      const [org, conn] = values;
      const p = store.catalogPointer;
      return p && p.organization_fingerprint === org && p.connection_id === conn ? [{ payload_sha: p.payload_sha, source_request_hash: p.source_request_hash, validated_at: toUs(p.validated_at) }] : [];
    }
    if (name === "sku_brands") {
      const [ids, hashes] = values;
      const pairs = new Set(ids.map((id, i) => id + "|" + hashes[i]));
      return snapRows().filter((r) => r.report_key === "brand-view-brands" && pairs.has(r.account_id + "|" + r.params_hash))
        .map((r) => ({ account_id: r.account_id, params_hash: r.params_hash, source_refreshed_at: toUs(r.source_refreshed_at), updated_at: toUs(r.updated_at) }));
    }
    // brand_list
    const [acct, hash] = values;
    return snapRows().filter((r) => r.report_key === "brand-view-brands" && r.account_id === acct && r.params_hash === hash)
      .map((r) => ({ account_id: r.account_id, params_hash: r.params_hash, source_refreshed_at: toUs(r.source_refreshed_at), updated_at: toUs(r.updated_at), payload_account_id: r.payload ? (r.payload.accountId == null ? null : S(r.payload.accountId)) : null, brands: r.payload && r.payload.brands !== undefined ? clone(r.payload.brands) : null, payload_storage_path: r.payload_storage_path || null }));
  };
}

// The fake READ-ONLY supabase facade (readers only) over the store + the world's report_snapshots.
function makeSb(store, world) {
  return {
    getSourceOliHistoryRows: async ({ organizationFingerprint, connectionId, accountIds, from, to }) => {
      for (const a of accountIds || []) bump(store.calls.history, a);
      if (organizationFingerprint !== ORG || connectionId !== "primary") return [];
      return clone(store.history.filter((r) => (accountIds || []).includes(r.account_id) && r.sale_date >= from && r.sale_date <= to && r.sales_amount > 0));
    },
    getSourceCoverageWindows: async ({ organizationFingerprint, connectionId, accountId, sourceKey }) => {
      store.calls.coverage += 1;
      if (store.fail.coverage === "throw") throw new Error("coverage read threw");
      if (store.fail.coverage) return { windows: [], read: store.fail.coverage, error: "X" };
      return { windows: store.coverage.filter((r) => r.organization_fingerprint === organizationFingerprint && r.connection_id === connectionId && r.account_id === accountId && r.source_key === sourceKey && r.status === "succeeded").sort((x, y) => (x.covered_from < y.covered_from ? -1 : 1)).map((r) => ({ from: r.covered_from, to: r.covered_to, ...(store.covStampFn ? { updatedAt: store.covStampFn(r) } : {}) })), read: "ok", error: null };
    },
    getSourceSnapshot: async ({ organizationFingerprint, connectionId, sourceKey, scopeKey }) => {
      if (store.fail.catalog === "throw") throw new Error("catalog read threw");
      if (store.fail.catalog) return { snapshot: null, read: store.fail.catalog, error: "X" };
      const p = store.catalogPointer;
      return { snapshot: p && p.organization_fingerprint === organizationFingerprint && p.connection_id === connectionId && p.source_key === sourceKey && p.scope_key === scopeKey ? clone(p) : null, read: "ok", error: null };
    },
    getSourceSnapshotPayload: async (p) => {
      store.calls.catalogPayload += 1;
      if (store.fail.catalogPayload) throw new Error("SOURCE_SNAPSHOT_PAYLOAD_MISMATCH");
      if (!store.catalogPayloads.has(p)) throw new Error("missing object");
      return clone(store.catalogPayloads.get(p));
    },
    getSourceOliOperationalUnitRows: async ({ organizationFingerprint, connectionId, accountIds, from, to, additiveOnly }) => clone(store.opunits.filter((u) => u.organization_fingerprint === organizationFingerprint && u.connection_id === connectionId && (accountIds || []).includes(u.account_id) && u.sale_date >= from && u.sale_date <= to && (!additiveOnly || u.explicit_zero_units > 0 || u.pending_units > 0))),
    getOliSkuAsinResolutionRows: async ({ accountId }) => clone(store.resolution.get(accountId) || []),
    getLatestReportSnapshotForScope: (args) => world.readers.getLatestReportSnapshotForScope(args),
    getReportSnapshotStoragePayload: async (p) => (world.storage.has(p) ? clone(world.storage.get(p)) : null),
  };
}

// =====================================================================================================================
// The faithful in-memory lineage world (the route-publication-release suite's world, keyed for sku-movement).
// =====================================================================================================================
function makeWorld({ rollout = [A, BB], discovered = [A, BB] } = {}) {
  const cycles = new Map(); const jobs = []; const snaps = new Map(); const storage = new Map();
  const n = { cycleCreate: 0, jobInsert: 0, claimLease: 0, shadowCas: 0, shadowWrite: 0, reconcile: 0, finalize: 0, liveCas: 0, liveWrite: 0, preflight: 0, publish: 0, snapshotUpdate: 0 };
  let seq = 0; let clock = Date.UTC(2026, 8, 24, 6, 0, 0);
  const iso = (ms) => new Date(ms).toISOString();
  const w = { cycles, jobs, snaps, storage, n, promoted: [KEY], rollout: [...rollout], discovered: [...discovered] };
  w.now = () => clock;
  w.tick = (ms = 60000) => { clock += ms; return clock; };
  w.fence = { ownerToken: "op-owner", generation: 7 };
  w.lease = { ownerToken: "op-owner", generation: 7 };
  const cycleById = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  const jobOf = (cycleId, rk, a) => jobs.find((j) => j.cycle_id === cycleId && j.report_key === rk && j.account_id === a) || null;
  const snapKey = (rk, a, h) => rk + "|" + a + "|" + h;
  w.snapKey = snapKey;
  w.openCycle = async ({ bucket, cycleDate }) => { const k = bucket + "|" + cycleDate; if (!cycles.has(k)) { n.cycleCreate += 1; cycles.set(k, { id: "cyc-" + (++seq), bucket, cycle_date: cycleDate, status: "pending", created_at: iso(w.tick()) }); } };
  w.getCycleByBucketDate = async (bucket, cycleDate) => { const c = cycles.get(bucket + "|" + cycleDate); return c ? { ...c } : null; };
  w.claimCycle = async (id) => { const c = cycleById(id); if (c && c.status === "pending") { c.status = "running"; return true; } return false; };
  w.readCycle = async (id) => { const c = cycleById(id); return c ? { ...c } : null; };
  w.upsertReportJob = async (job) => {
    if (jobOf(job.cycleId, job.reportKey, job.accountId)) return;
    n.jobInsert += 1;
    jobs.push({ id: "job-" + (++seq), cycle_id: job.cycleId, report_key: job.reportKey, account_id: job.accountId, bucket: job.bucket, connection_id: job.connectionId, report_version: job.reportVersion, depends_on: [...(job.dependsOn || [])], durable_content_deps: [...(job.durableContentDeps || [])], derive_status: "pending", save_status: "pending", validated: false, snapshot_params_hash: null, lease_token: null, lease_expires: 0, created_at: ++seq });
  };
  w.claimLease = async (cycleId, rk, a, { leaseSeconds = 300 } = {}) => {
    n.claimLease += 1;
    const j = jobOf(cycleId, rk, a);
    if (!j) return { disposition: "not-found", leaseToken: null, snapshotParamsHash: null };
    if (j.validated === true) return { disposition: "already-complete", leaseToken: null, snapshotParamsHash: j.snapshot_params_hash };
    if (j.derive_status === "running" && j.lease_expires > clock) return { disposition: "held", leaseToken: null, snapshotParamsHash: null };
    const disposition = j.derive_status === "running" ? "reclaimed" : "claimed";
    j.derive_status = "running"; j.lease_token = "lt-" + (++seq); j.lease_expires = clock + leaseSeconds * 1000;
    return { disposition, leaseToken: j.lease_token, snapshotParamsHash: null };
  };
  w.saveShadow = async ({ reportKey, accountId, paramsHash, params, payload, sourceRefreshedAt }) => {
    n.shadowCas += 1;
    const k = snapKey(reportKey, accountId, paramsHash); const cur = snaps.get(k);
    const cand = Date.parse(sourceRefreshedAt);
    if (cur) {
      const have = Date.parse(cur.source_refreshed_at);
      if (have > cand) return { outcome: "newer-live" };
      if (have === cand) return B.stableJson(cur.params) === B.stableJson(params) && B.stableJson(cur.payload) === B.stableJson(payload) ? { outcome: "already-current" } : { outcome: "conflict" };
    }
    n.shadowWrite += 1;
    snaps.set(k, { id: "snap-" + (++seq), report_key: reportKey, account_id: accountId, params_hash: paramsHash, params: clone(params), payload: clone(payload), payload_storage_path: null, source_refreshed_at: sourceRefreshedAt, updated_at: iso(w.tick(1000)) });
    return { outcome: cur ? "replaced" : "inserted" };
  };
  w.reconcileSuccess = async ({ cycleId, reportKey, accountId, snapshotParamsHash, leaseToken }) => {
    n.reconcile += 1;
    const j = jobOf(cycleId, reportKey, accountId); if (!j) return { disposition: "not-found" };
    if (j.validated === true) return { disposition: "already-complete" };
    if (j.lease_token !== leaseToken) return { disposition: "lease-lost" };
    Object.assign(j, { validated: true, derive_status: "succeeded", save_status: "succeeded", snapshot_params_hash: snapshotParamsHash });
    return { disposition: "reconciled" };
  };
  w.finalizeCycle = async ({ cycleId }) => {
    n.finalize += 1;
    const c = cycleById(cycleId); if (!c) return { disposition: "not-found" };
    if (c.status === "succeeded" || c.status === "partial") return { disposition: "already-terminal" };
    if (c.status !== "running") return { disposition: "invalid-status" };
    c.status = jobs.some((j) => j.cycle_id === cycleId && j.validated === true) ? "succeeded" : "partial";
    return { disposition: "finalized" };
  };
  const latestJobRow = (rk, a) => jobs.filter((x) => x.report_key === rk && x.account_id === a).sort((x, y) => y.created_at - x.created_at)[0] || null;
  w.lineage = (rk, a) => {
    const j = latestJobRow(rk, a); if (!j) return null;
    const c = cycleById(j.cycle_id);
    return { reportKey: j.report_key, accountId: j.account_id, deriveStatus: j.derive_status, saveStatus: j.save_status, validated: j.validated === true, dependsOn: j.depends_on.map(String), durableContentDeps: j.durable_content_deps.map(String), snapshotParamsHash: j.snapshot_params_hash, latestDataDate: null, cycleStatus: c ? c.status : null, id: j.id, cycleId: j.cycle_id, createdAt: j.created_at };
  };
  w.readLatestJob = async (rk, a) => w.lineage(rk, a);
  w.readSnapshot = async ({ reportKey, accountId, paramsHash }) => { const r = snaps.get(snapKey(reportKey, accountId, paramsHash)); return r ? clone(r) : null; };
  w.loadStoragePayload = async (p) => (storage.has(p) ? clone(storage.get(p)) : null);
  const byAcct = (rk, a) => [...snaps.values()].filter((r) => r.report_key === rk && r.account_id === a);
  const newest = (rows) => rows.sort((x, y) => (x.updated_at < y.updated_at ? 1 : x.updated_at > y.updated_at ? -1 : 0))[0] || null;
  w.readers = {
    getReportSnapshot: w.readSnapshot,
    getLatestReportSnapshot: async ({ reportKey, accountId }) => { const r = newest(byAcct(reportKey, accountId)); return r ? clone(r) : null; },
    getLatestReportSnapshotForScope: async ({ reportKey, accountId, reportVersion = null, scope = {} }) => { const r = newest(byAcct(reportKey, accountId).filter((x) => (reportVersion == null || S(x.params && x.params.reportVersion) === S(reportVersion)) && Object.entries(scope || {}).every(([k, v]) => v == null || S(x.params && x.params[k]) === S(v)))); return r ? clone(r) : null; },
  };
  w.liveCas = async ({ reportKey, accountId, paramsHash, params, payload, sourceRefreshedAt, ownerToken, generation }) => {
    n.liveCas += 1;
    if (ownerToken !== w.lease.ownerToken || Number(generation) !== Number(w.lease.generation)) return { outcome: "lease-lost", reason: "fence-mismatch" };
    const k = snapKey(reportKey, accountId, paramsHash); const cur = snaps.get(k);
    const cand = Date.parse(sourceRefreshedAt);
    if (cur) {
      const have = Date.parse(cur.source_refreshed_at);
      if (have > cand) return { outcome: "newer-live" };
      if (have === cand) return B.stableJson(cur.params) === B.stableJson(params) && B.stableJson(cur.payload) === B.stableJson(payload) ? { outcome: "already-current" } : { outcome: "conflict" };
    }
    n.liveWrite += 1;
    snaps.set(k, { id: "live-" + (++seq), report_key: reportKey, account_id: accountId, params_hash: paramsHash, params: clone(params), payload: clone(payload), payload_storage_path: null, source_refreshed_at: sourceRefreshedAt, updated_at: iso(w.tick(1000)) });
    return { outcome: cur ? "replaced" : "inserted" };
  };
  let publisher = null;
  w.publisherFor = (signal) => {
    w.activeSignal = signal || null;
    if (!publisher) {
      const real = buildSchedulerV2Publisher({
        connections: [{ id: "primary", apiKey: "test-key", label: "Primary" }],
        fetchAccounts: async () => w.discovered.map((id) => ({ id, name: id, country: "IN" })),
        getAccountRollout: async () => ({ read: "ok", allPrimary: false, enabledAccountIds: w.rollout }),
        getSettings: async () => [],
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
  w.readbackLive = REL.buildRouteLiveReadback({ getReportSnapshot: w.readSnapshot, loadStoragePayload: w.loadStoragePayload, liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, reportDerivations: REPORT_DERIVATIONS, computeHash: paramsHashFor });
  w.writes = () => n.cycleCreate + n.jobInsert + n.shadowWrite + n.reconcile + n.finalize + n.liveWrite;
  return w;
}

// The account's live brand-view-brands row (exact identity { accountId }).
function putBrandsRow(w, acct, brands, { sra = "2026-09-24T02:00:00.000Z", upd = "2026-09-24T02:00:01.000Z", payloadAccount = acct } = {}) {
  const h = W.brandViewBrandsLiveHash(acct);
  w.snaps.set(w.snapKey("brand-view-brands", acct, h), { id: "bvb-" + acct, report_key: "brand-view-brands", account_id: acct, params_hash: h, params: { reportVersion: "brand-view-brands-v1", accountId: acct }, payload: { accountId: payloadAccount, brands, sources: [], message: null }, payload_storage_path: null, source_refreshed_at: sra, updated_at: upd });
}

const DIRECTORY = new Map([
  [A, { accountId: A, country: "IN", marketplace: "IN", rawSellerId: "raw-a", name: "A", currency: "INR" }],
  [BB, { accountId: BB, country: "IN", marketplace: "IN", rawSellerId: "raw-b", name: "B", currency: "INR" }],
]);

// A whole route stack over one world + store: the REAL release, adapter and two-phase reconciler. `attested` models
// the owner's SKU_MOVEMENT_SERVE_TOKEN_ATTESTED (default: the WP10 token serve is deployed + attested).
const ATTESTED_ENV = Object.freeze({ SKU_MOVEMENT_SERVE_TOKEN_ATTESTED: "true" });
function makeStack({ brandsA = ["Acme", "Caruso Italy"], withBrandsA = true, attested = true } = {}) {
  const w = makeWorld();
  const store = makeStore();
  if (withBrandsA) putBrandsRow(w, A, brandsA);
  const pg = makePg(store, w);
  const sb = makeSb(store, w);
  const cliRoute = RC.validateRouteModule(C, { side: "cli", liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, reportDerivations: REPORT_DERIVATIONS });
  // The attestation is SWITCHABLE mid-test (cfg.attested; stack.setAttested) so a resumed prepare can be proven.
  const cfg = { attested };
  const buildRuntime = ({ env = cfg.attested ? ATTESTED_ENV : {} } = {}) => cliRoute.build(Object.freeze({
    bucket: REGION, epoch: EPOCH, directory: DIRECTORY, orgFp: ORG, connectionId: "primary", sb, pgReadOnly: pg, selectors: SEL, computeHash: paramsHashFor,
    liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, reportDerivations: REPORT_DERIVATIONS, now: () => w.now(), strict: true, log: () => {}, env,
  }));
  const controls = { opened: [], closed: 0 };
  const stack = { w, store, pg, sb, cliRoute, controls, buildRuntime, setAttested: (v) => { cfg.attested = v === true; } };
  stack.pass = async ({ dryRun = false, verifyExact = false, accountIds = null } = {}) => {
    const runtime = RC.validateRouteRuntime(buildRuntime(), "sku-movement");
    stack.runtime = runtime;
    const release = REL.buildRoutePublicationRelease({
      route: cliRoute, runtime,
      deps: {
        openCycle: w.openCycle, getCycleByBucketDate: w.getCycleByBucketDate, claimCycle: w.claimCycle, readCycle: w.readCycle,
        upsertReportJob: w.upsertReportJob, claimLease: w.claimLease, saveShadow: w.saveShadow, reconcileSuccess: w.reconcileSuccess, finalizeCycle: w.finalizeCycle,
        readLatestJob: w.readLatestJob, readSnapshot: w.readSnapshot, loadStoragePayload: w.loadStoragePayload,
        publisherFor: w.publisherFor, verifyLease: w.verifyLease, readbackLive: w.readbackLive,
        liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, reportDerivations: REPORT_DERIVATIONS, computeHash: paramsHashFor,
        evidenceContext: { directory: DIRECTORY, organizationFingerprint: ORG, connectionId: "primary" },
        publishSnapshotUpdate: async () => { w.n.snapshotUpdate += 1; },
        now: () => w.now(),
      },
    });
    const adapter = REL.buildRouteReconcileAdapter({ route: cliRoute, runtime, bucket: REGION, directory: DIRECTORY, liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, readLatestJob: w.readLatestJob, verifyExact });
    const reconciler = SDR.buildSavedDataReconciler({
      resolveOrg: async () => ({ organizationFingerprint: ORG, connectionId: "primary" }),
      bucketAccounts: async () => [{ accountId: A }, { accountId: BB }],
      adapter,
      readLatestReportJob: ({ reportKey, accountId }) => w.readLatestJob(reportKey, accountId),
      readShadowSnapshot: (a) => w.readSnapshot(a), readLiveSnapshot: (a) => w.readSnapshot(a), loadStoragePayload: w.loadStoragePayload,
      verifyLiveReadback: w.readbackLive, liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, computeHash: paramsHashFor, reportDerivations: REPORT_DERIVATIONS,
      runPrepareForUnit: (a) => release.prepareForUnit(a), runPublishForUnit: (a) => release.publishForUnit(a),
      openControls: async (x) => { controls.opened.push(x); return { ok: true }; }, closeControls: async () => { controls.closed += 1; return { ok: true }; },
      reportKeys: [KEY], family: "sku-movement",
    });
    return reconciler.run({ bucket: REGION, requestedAsOf: EPOCH, accountIds, mode: "periodic", dryRun });
  };
  stack.live = (asOf, brand, acct = A) => w.snaps.get(w.snapKey(KEY, acct, liveHash(asOf, brand))) || null;
  stack.unitsOf = (summary, acct) => (summary.perAccount.find((r) => r.accountId === acct) || {}).units || [];
  stack.unitState = (summary, acct, unitKey) => { const u = stack.unitsOf(summary, acct).find((x) => x.unitKey === unitKey); return u ? u.reports[KEY] : null; };
  stack.token = async (acct = A) => { const rt = buildRuntime(); const ev = await rt.readScopeEvidence({ scope: [A, BB] }); return ev.perAccount.get(acct).token; };
  return stack;
}

// THE WP10 SERVE, modelled from THE SERVE-SIDE CONTRACT (sku-movement-evidence.js): its OWN REST-shaped reads
// (PostgREST '+00:00' timestamps) -- the extended getSourceCoverageWindows (+ updatedAt), the catalog pointer, and the
// cheap operational-units stats over skuServeOpunitsWindow(effectiveAsOf) (ALL rows) -- then computeSkuServeToken +
// skuMovementStoredIsCurrent, the response paramsHash from stripStoredExtras.
function restCoverage(store, acct) {
  return store.coverage.filter((r) => r.organization_fingerprint === ORG && r.connection_id === "primary" && r.account_id === acct && r.source_key === "order-line-items" && r.status === "succeeded")
    .map((r) => ({ from: r.covered_from, to: r.covered_to, updatedAt: pgrest(r.updated_at) }));
}
function restOpunitsStats(store, acct, from, to) {
  const rows = store.opunits.filter((u) => u.organization_fingerprint === ORG && u.connection_id === "primary" && u.account_id === acct && u.sale_date >= from && u.sale_date <= to);
  const max = rows.map((u) => u.updated_at).sort().pop();
  return { windowFrom: from, windowTo: to, rows: rows.length, maxUpdatedAt: rows.length ? pgrest(max) : null };
}
async function wp10Serve(st, acct, brandParam) {
  const brandScope = { brand: String(brandParam).trim() === "" ? "ALL" : String(brandParam).trim() };
  const ceiling = new Date(st.w.now()).toISOString().slice(0, 10);
  let effectiveAsOf = null; let freshRefreshedAt = null; let serveToken = null;
  try {
    const oliWindows = restCoverage(st.store, acct);
    ({ effectiveAsOf } = RD.skuMovementProvenDates(oliWindows, ceiling));
    const catRead = await st.sb.getSourceSnapshot({ organizationFingerprint: ORG, connectionId: "primary", sourceKey: "product-catalog", scopeKey: "__organization" });
    const catalogSnapshot = catRead && typeof catRead === "object" && "snapshot" in catRead ? catRead.snapshot : catRead;
    freshRefreshedAt = RD.skuMovementRefreshedAt({ catalogSnapshot, effectiveAsOf });
    const win = EVI.skuServeOpunitsWindow(effectiveAsOf);
    const opunits = win ? restOpunitsStats(st.store, acct, win.from, win.to) : null;
    serveToken = EVI.computeSkuServeToken({ effectiveAsOf, coverageWindows: oliWindows, catalogPayloadSha: catalogSnapshot && catalogSnapshot.payload_sha, opunits, brand: brandScope.brand });
  } catch (_e) { /* the serve falls through to a read-only re-derive */ }
  const stored = await st.w.readers.getLatestReportSnapshotForScope({ reportKey: KEY, accountId: acct, reportVersion: VERSION, scope: brandScope });
  const current = EVI.skuMovementStoredIsCurrent({ stored, effectiveAsOf, serveToken, legacyProvenance: freshRefreshedAt });
  return { current, serveToken, effectiveAsOf, stored, paramsHash: current ? paramsHashFor(VERSION, EVI.stripStoredExtras(stored.params)) : null };
}
// The serve token inputs as the WP10 serve reads them (for skuServeFreshnessProbe's readServeTokenInputs).
const restTokenInputs = (store) => async ({ accountId, effectiveAsOf }) => {
  const win = EVI.skuServeOpunitsWindow(effectiveAsOf);
  return { read: "ok", coverageWindows: restCoverage(store, accountId), opunits: restOpunitsStats(store, accountId, win.from, win.to) };
};
const unitOf = (acct, brand) => ({ unitKey: brand === "ALL" ? "ALL" : sha12(brand), targetId: skuMovementTargetId(acct, brand), liveAccountId: acct });

// =====================================================================================================================
// R. module + runtime contracts; read-only SQL; DDL-verified columns
// =====================================================================================================================
{
  const worker = RC.validateRouteModule(W, { side: "worker" });
  const cli = RC.validateRouteModule(C, { side: "cli", liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, reportDerivations: REPORT_DERIVATIONS });
  ok("R1 the worker module validates (side:'worker'), the CLI module validates against the REAL live contracts + derivations, and the pair validates", worker === W.default && cli === C.default && RC.validateRoutePair(worker, cli, { liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS }) === true);
  ok("R1 worker declaration: id sku-movement, route-cli via the generic CLI, publisher + live key sku-movement, grain account, unit brand, awaits [brand-view-brands], priority 6, deadline 330, hard 420, no identity as-of clock",
    worker.id === "sku-movement" && worker.kind === "route-cli" && worker.cli.script === RC.ROUTE_CLI_SCRIPT && worker.cli.fixedArgs.length === 0
    && JSON.stringify(worker.publisherKeys) === '["sku-movement"]' && JSON.stringify(worker.liveReportKeys) === '["sku-movement"]' && worker.grain === "account" && worker.unit === "brand"
    && JSON.stringify(worker.awaits) === '["brand-view-brands"]' && worker.priority === 6 && worker.deadlineSeconds === 330 && worker.hardTimeoutSeconds === 420 && worker.identityAsOf === null
    && JSON.stringify(worker.tier1.liveRowScope(A)) === JSON.stringify({ reportKey: "sku-movement", accountIdEq: A })
    && JSON.stringify(worker.tier1.liveRowScope({ targetKey: A })) === JSON.stringify({ reportKey: "sku-movement", accountIdEq: A }));
  ok("R1 CLI declaration: publisher key sku-movement, stamp policy 'cycle'", cli.id === "sku-movement" && cli.publisherKey === KEY && cli.stampPolicy === "cycle");
  const st = makeStack();
  const rt = st.buildRuntime();
  ok("R2 build(deps) returns a runtime that passes validateRouteRuntime (every required hook; only known optional hooks)", RC.validateRouteRuntime(rt, "sku-movement") === rt && RC.routeRuntimeProblems(rt).length === 0 && typeof rt.expandUnits === "function" && typeof rt.readEvidenceToken === "function");
  let threw = 0;
  for (const bad of [{ pgReadOnly: null }, { sb: { getSourceOliHistoryRows: () => [] } }, { directory: [] }, { orgFp: "" }]) {
    try { cli.build({ bucket: REGION, directory: DIRECTORY, orgFp: ORG, connectionId: "primary", sb: st.sb, pgReadOnly: st.pg, now: () => st.w.now(), ...bad }); } catch { threw += 1; }
  }
  ok("R2 build FAILS CLOSED without the read-only pg query, the read-only readers, the durable directory Map or the org fingerprint", threw === 4);
  const facade = REL.readOnlySupabase(await import("../lib/server/supabase.js"));
  const RELSRC = src("lib/server/sync/routes/sku-movement.release.js");
  const used = [...new Set([...RELSRC.matchAll(/\bsb\.([A-Za-z]+)\b/g)].map((m) => m[1]))];
  ok("R2 every supabase reader the runtime calls is present in the CLI's READ-ONLY facade (no writer can be reached)", used.length >= 8 && used.every((nm) => typeof facade[nm] === "function" && /^(get|list)[A-Z]/.test(nm)));
  ok("R3 every evidence statement (and the brand-list read) is a single read-only SELECT/WITH", W.SKU_MOVEMENT_EVIDENCE_SQL.every((q) => RC.isReadOnlyEvidenceSql(q.text)) && RC.isReadOnlyEvidenceSql(C.SKU_BRAND_LIST_SQL) && W.SKU_MOVEMENT_EVIDENCE_SQL.map((q) => q.name).join(",") === "sku_coverage,sku_opunits,sku_catalog,sku_brands");

  // DDL: every qualified column the statements name exists in its table's migration DDL.
  const MIG = path.join(ROOT, "supabase", "migrations");
  const ddl = readdirSync(MIG).filter((f) => f.endsWith(".sql")).map((f) => readFileSync(path.join(MIG, f), "utf8")).join("\n");
  const tableCols = (table) => {
    const cols = new Set();
    const re = new RegExp("create table (?:if not exists )?public\\." + table + " \\(([\\s\\S]*?)\\n\\);", "g");
    for (const m of ddl.matchAll(re)) for (const line of m[1].split("\n")) { const c = line.match(/^\s{2}([a-z_][a-z0-9_]*)\s+(text|date|timestamptz|numeric|integer|bigint|uuid|jsonb|boolean|smallint)\b/); if (c) cols.add(c[1]); }
    for (const m of ddl.matchAll(new RegExp("alter table (?:only )?public\\." + table + "\\s+add column (?:if not exists )?([a-z_][a-z0-9_]*)", "g"))) cols.add(m[1]);
    return cols;
  };
  const T = { c: tableCols("source_coverage"), u: tableCols("source_oli_operational_units"), s: tableCols("source_snapshots"), r: tableCols("report_snapshots"), e: new Set(["account_id", "eff_as_of"]), t: new Set(["account_id", "params_hash"]) };
  const stripLit = (sql) => sql.replace(/'[^']*'/g, "''");
  const refs = [...W.SKU_MOVEMENT_EVIDENCE_SQL.map((q) => q.text), C.SKU_BRAND_LIST_SQL].flatMap((sql) => [...stripLit(sql).matchAll(/\b([a-z])\.([a-z_][a-z0-9_]*)\b/g)].map((m) => [m[1], m[2]]));
  const unknown = refs.filter(([al, col]) => !T[al] || !T[al].has(col));
  ok(`R3 all ${refs.length} qualified column references exist in the migration DDL (source_coverage / source_oli_operational_units / source_snapshots / report_snapshots)`, refs.length >= 30 && unknown.length === 0 && T.c.has("source_refreshed_at") && T.u.has("updated_at") && T.s.has("payload_sha") && T.r.has("payload_storage_path"));
  const tsRe = /to_char\(r\.(source_refreshed_at|updated_at) at time zone [^)]*\)/g;
  ok("R3 the brand-list read formats the row's (source_refreshed_at, updated_at) EXACTLY like the L1 sku_brands statement (so its verification is an exact text comparison)", JSON.stringify(C.SKU_BRAND_LIST_SQL.match(tsRe)) === JSON.stringify(W.SKU_MOVEMENT_EVIDENCE_SQL[3].text.match(tsRe)) && (C.SKU_BRAND_LIST_SQL.match(tsRe) || []).length === 2);
  ok("R3 source_coverage has NO source_request_hash column (the plan's window tuple uses updated_at instead) and the statements never name one on coverage", !T.c.has("source_request_hash") && !refs.some(([al, col]) => al === "c" && col === "source_request_hash"));
  ok("R3 timestamps are read as UTC ISO TEXT and dates as ::text (never a JS Date of a local-timezone driver value)", W.SKU_MOVEMENT_EVIDENCE_SQL.every((q) => !/\b(source_refreshed_at|updated_at|validated_at)\b(?!\))\s+as/.test(q.text.replace(/to_char\([^)]*\)[^,\n]*/g, ""))) && /covered_from::text/.test(W.SKU_MOVEMENT_EVIDENCE_SQL[0].text) && /at time zone 'UTC'/.test(W.SKU_MOVEMENT_EVIDENCE_SQL[1].text));
  ok("R4 the worker module names no DataDoe / lease-acquire / snapshot-CAS / publisher / child_process code (the worker's structural zero-export scan, publication-recovery-units C1)", !/datadoe\.js|createExport|fetchExportRows|makeDataDoeAdapter|datadoe-usage|acquire_control_plane_lease|cas_report_snapshot|publishSchedulerV2Snapshot|saveReportSnapshot|child_process/.test(src("lib/server/recovery/routes/sku-movement.route.js")));
  let pthrew = 0;
  for (const bad of [{}, { organizationFingerprint: ORG, accountIds: ["bad:id"] }, { organizationFingerprint: ORG, accountIds: [" pad"] }, { organizationFingerprint: ORG, accountIds: [A], connectionId: "x" }]) { try { W.SKU_MOVEMENT_EVIDENCE_SQL[0].params(bad); } catch { pthrew += 1; } }
  ok("R3 the statement params fail closed without an org fingerprint or on a prefixed / padded account id / unknown connection; without accountIds they cover the durable directory's ids", pthrew === 4 && JSON.stringify(W.SKU_MOVEMENT_EVIDENCE_SQL[1].params({ organizationFingerprint: ORG, accountIds: [BB, A, A], now: Date.UTC(2026, 8, 24, 23, 59) })) === JSON.stringify([ORG, "primary", [A, BB], "2026-09-24"])
    && JSON.stringify(W.SKU_MOVEMENT_EVIDENCE_SQL[3].params({ organizationFingerprint: ORG, directory: DIRECTORY })) === JSON.stringify([[A, BB], [W.brandViewBrandsLiveHash(A), W.brandViewBrandsLiveHash(BB)]]));
  let nowThrew = 0;
  for (const badNow of ["not-a-date", NaN, {}]) { try { W.SKU_MOVEMENT_EVIDENCE_SQL[1].params({ organizationFingerprint: ORG, accountIds: [A], now: badNow }); } catch { nowThrew += 1; } }
  ok("R3 (P3-4) a worker ctx WITHOUT `now` binds the sku_opunits ceiling $4 = NULL (LEAST ignores it; compose cross-checks); a PRESENT but invalid `now` still throws (fail closed); the SQL caps with least(..., $4::date)",
    JSON.stringify(W.SKU_MOVEMENT_EVIDENCE_SQL[1].params({ organizationFingerprint: ORG, accountIds: [A] })) === JSON.stringify([ORG, "primary", [A], null]) && nowThrew === 3
    && /least\(max\(c\.covered_to\), \$4::date\)/.test(W.SKU_MOVEMENT_EVIDENCE_SQL[1].text));
}

// =====================================================================================================================
// E. end to end
// =====================================================================================================================
const EFF = "2026-09-23";
const EFF_B = "2026-09-22";
{
  const st = makeStack();
  const dry = await st.pass({ dryRun: true });
  const aUnits = st.unitsOf(dry, A);
  ok("E1 dry-run: A expands to ALL + one unit per VERIFIED brand (unit keys ALL / sha12(brand)), each STALE at targetAsOf = effectiveAsOf; zero writes",
    JSON.stringify(aUnits.map((u) => u.unitKey)) === JSON.stringify(["ALL", sha12("Acme"), sha12("Caruso Italy")])
    && aUnits.every((u) => u.targetAsOf === EFF && u.liveAccountId === A && u.reports[KEY].state === RS.ST) && JSON.stringify(aUnits.map((u) => u.targetId)) === JSON.stringify([skuMovementTargetId(A, "ALL"), skuMovementTargetId(A, "Acme"), skuMovementTargetId(A, "Caruso Italy")]) && st.w.writes() === 0);
  const bUnits = st.unitsOf(dry, BB);
  ok("E1 B has NO live brand-view-brands row: only ALL is built; the named units are marked DEFERRED_DEPENDENCY 'brand-list-unavailable' (a marker, never read or written)",
    bUnits.length === 2 && bUnits[0].unitKey === "ALL" && bUnits[0].targetAsOf === EFF_B && bUnits[1].unitKey === "brands" && bUnits[1].reports[KEY].state === RS.DD && bUnits[1].reports[KEY].reason === "brand-list-unavailable");
  const s1 = await st.pass();
  ok("E2 live pass: 4 units prepared + published (A: ALL, Acme, Caruso Italy; B: ALL) through the REAL four-gate publisher; one control window over the owners", s1.counts.targetsPublished === 4 && st.w.n.liveWrite === 4 && st.controls.opened.length === 1 && JSON.stringify(st.controls.opened[0]) === JSON.stringify({ owners: [A, BB], publisherKeys: [KEY] }));
  const all = st.live(EFF, "ALL"); const acme = st.live(EFF, "Acme"); const caruso = st.live(EFF, "Caruso Italy");
  const tokA = await st.token(A);
  ok("E2 the live rows sit at the OWNER with identity { asOf: effectiveAsOf, brand }; the stored params carry evidenceToken / serveToken / manifestToken (never hashed)",
    [all, acme, caruso].every((r) => r && r.account_id === A && r.params.reportVersion === VERSION && r.params.asOf === EFF && r.params.evidenceToken === tokA && /^sms2:[0-9a-f]{64}$/.test(r.params.serveToken) && /^smm1:[0-9a-f]{64}$/.test(r.params.manifestToken))
    && acme.params.brand === "Acme" && caruso.params.brand === "Caruso Italy" && acme.params_hash === liveHash(EFF, "Acme") && new Set([all.params.serveToken, acme.params.serveToken, caruso.params.serveToken]).size === 3 && all.params.manifestToken === acme.params.manifestToken);
  ok("E2 payloads: ALL is unfiltered with Catalog brands; each named unit is filtered to EXACTLY its catalog brand (Zeta, which is not in the brand list, never gets a unit)",
    all.payload.brandFiltered === false && all.payload.brand === "ALL" && all.payload.rows.length >= 3 && acme.payload.brandFiltered === true && acme.payload.rows.every((r) => r.brand === "Acme") && acme.payload.rows.length >= 1
    && caruso.payload.rows.every((r) => r.brand === "Caruso Italy") && !st.live(EFF, "Zeta") && all.payload.effectiveAsOf === EFF && all.payload.accountId === A);
  const pendingUnits = acme.payload.rows.reduce((s, r) => s + Object.values(r.dailyUnits || {}).reduce((x, y) => x + y, 0), 0);
  ok("E2 the ordered units include the pending operational units resolved to their unique ASIN (2 priced + 1 priced + 2 pending = 5 Acme units)", pendingUnits === 5);
  const jobA = st.w.jobs.find((j) => j.account_id === skuMovementTargetId(A, "Acme"));
  ok("E2 the job + shadow are keyed by the (account, brand) TARGET; depends_on = the catalog request hash; durable_content_deps = [evidence, manifest]",
    !!jobA && jobA.bucket === REGION && JSON.stringify(jobA.depends_on) === '["catreq1"]' && JSON.stringify(jobA.durable_content_deps) === JSON.stringify([tokA, acme.params.manifestToken]) && jobA.report_version === VERSION);
  const s2 = await st.pass({ dryRun: true });
  ok("E3 re-scan: every published unit is PUBLICATION_NOT_REQUIRED via the exact binding AND the served-row check (the serve's freshness probe serves the stored row)",
    [["ALL", A], [sha12("Acme"), A], [sha12("Caruso Italy"), A], ["ALL", BB]].every(([u, a]) => { const e = st.unitState(s2, a, u); return e && e.state === RS.NR && e.served && e.served.h === e.h; }));
  const tline = TGT.parseTargetsLine(TGT.formatTargetsLine({ v: 2, route: "sku-movement", summary: { ...s2, bucket: REGION, requestedAsOf: EPOCH, dryRun: true } }));
  const tA = tline && tline.targets.find((t) => t.id === A);
  ok("E3 TARGETS v2: the account target echoes the L1 token; units carry only unit keys (never a brand string)", tA && tA.tok === tokA && tA.units.map((x) => x.u).join(",") === ["ALL", sha12("Acme"), sha12("Caruso Italy")].join(",") && !JSON.stringify(tline).includes("Caruso"));
  const s3 = await st.pass({ dryRun: true, verifyExact: true });
  ok("E4 --verify-exact: the strict bundle re-resolves and the latest job's durable_content_deps carry its manifest token -> still PUBLICATION_NOT_REQUIRED", [["ALL", A], [sha12("Acme"), A], ["ALL", BB]].every(([u, a]) => st.unitState(s3, a, u).state === RS.NR));
  const writes = st.w.writes();
  const s4 = await st.pass();
  ok("E5 a live pass over current units performs ZERO writes and opens ZERO new controls", s4.counts.targetsPublished === 0 && s4.counts.targetsAlreadyCurrent === 4 && st.w.writes() === writes && st.controls.opened.length === 1);
  // A manifest drift (the job lineage no longer carries the hydrated-content digest) is caught ONLY by --verify-exact.
  const job = st.w.jobs.filter((j) => j.account_id === skuMovementTargetId(A, "ALL")).pop();
  job.durable_content_deps = [tokA, "smm1:" + "0".repeat(64)];
  const s5 = await st.pass({ dryRun: true, verifyExact: true });
  ok("E4 --verify-exact flags a job whose lineage lacks the CURRENT manifest token (fixable -> STALE with the typed content-drift reason 'manifest-differs', kept verbatim by the core); the plain scan does not", st.unitState(s5, A, "ALL").state === RS.ST && st.unitState(s5, A, "ALL").reason === "manifest-differs" && st.unitState(await st.pass({ dryRun: true }), A, "ALL").state === RS.NR);
  ok("E6 zero network across the end-to-end passes", net.calls.length === 0);
}

// =====================================================================================================================
// T. the owner requirement: invalidate on OLI CONTENT changes
// =====================================================================================================================
{
  const st = makeStack();
  await st.pass();
  const t0 = await st.token(A);
  const before = st.live(EFF, "ALL");
  // A SAME-effectiveAsOf OLI correction: replace_oli_dimensional_window rewrites the history rows of the window and
  // re-acknowledges the SAME coverage window in the same transaction (source_refreshed_at + updated_at move).
  st.store.history.find((r) => r.sku === "C-1" && r.sale_date === "2026-09-23").units = 9;
  Object.assign(st.store.coverage[0], { source_refreshed_at: "2026-09-24T07:00:00.000Z", updated_at: "2026-09-24T07:00:00.000Z" });
  const t1 = await st.token(A);
  ok("T1 a same-effectiveAsOf OLI correction (coverage source_refreshed_at bump, effectiveAsOf unchanged) CHANGES the L1 token; B's token is untouched", t1 !== t0 && (await st.token(BB)) === (await (async () => { const s = makeStack(); return s.token(BB); })()));
  const scan = await st.pass({ dryRun: true });
  ok("T1 the scan classifies every A unit STALE (source revision changed) -- never PUBLICATION_NOT_REQUIRED on a date match", [["ALL"], [sha12("Acme")], [sha12("Caruso Italy")]].every(([u]) => st.unitState(scan, A, u).state === RS.ST) && st.unitState(scan, BB, "ALL").state === RS.NR);
  const s = await st.pass();
  const after = st.live(EFF, "ALL");
  const carusoUnits = (p) => p.rows.filter((r) => r.brand === "Caruso Italy").reduce((x, r) => x + Object.values(r.dailyUnits || {}).reduce((a, b) => a + b, 0), 0);
  ok("T1 ... and RE-PUBLISHES A at the SAME asOf: the live payload carries the corrected units and the new token (B untouched)", s.counts.targetsPublished === 3 && after.params.asOf === EFF && after.params.evidenceToken === t1 && carusoUnits(after.payload) === carusoUnits(before.payload) + 6 && after.source_refreshed_at > before.source_refreshed_at);
  // The coverage updated_at alone (every coverage upsert sets it) also moves the token.
  const t2a = await st.token(A);
  st.store.coverage[0].updated_at = "2026-09-24T08:00:00.000Z";
  ok("T1 a coverage re-acknowledgement that moves only updated_at also changes the token", (await st.token(A)) !== t2a);

  // Operational-units backfill (replace_oli_operational_units_window: no coverage change).
  const st2 = makeStack();
  await st2.pass();
  const dailySum = (row) => row.payload.rows.reduce((x, r) => x + Object.values(r.dailyUnits || {}).reduce((a, b) => a + b, 0), 0);
  const carusoBefore = dailySum(st2.live(EFF, "Caruso Italy"));
  const u0 = await st2.token(A);
  st2.store.opunits[0].updated_at = "2026-09-24T09:00:00.000Z";
  const u1 = await st2.token(A);
  st2.store.opunits.push({ ...st2.store.opunits[0], sku: "C-1", child_asin: "B0CARU1", pending_units: 4, updated_at: "2026-09-24T09:00:00.000Z" });
  const u2 = await st2.token(A);
  ok("T2 an operational-units backfill changes the token: a same-count rewrite (max(updated_at) moves) AND an added row (count moves)", u1 !== u0 && u2 !== u1);
  const sOp = await st2.pass();
  const carusoLive = st2.live(EFF, "Caruso Italy");
  ok("T2 ... and re-publishes: the Caruso Italy unit now counts the backfilled pending units", sOp.counts.targetsPublished === 3 && carusoLive.params.evidenceToken === u2 && carusoBefore === 3 && dailySum(carusoLive) === carusoBefore + 4);
  const u3 = await st2.token(A);
  st2.store.opunits.push({ ...st2.store.opunits[0], sale_date: "2026-05-30", updated_at: "2026-09-24T10:00:00.000Z" });
  st2.store.opunits.push({ ...st2.store.opunits[0], account_id: BB, updated_at: "2026-09-24T10:00:00.000Z" });
  ok("T2 an operational-units row OUTSIDE [monthBack(effAsOf,3), effAsOf] or of ANOTHER account does not change A's token", (await st2.token(A)) === u3 && monthBackStr(EFF, 3) === "2026-06-01");
  // The brand list itself moving (a new brand) moves the token (named units must be re-verified).
  const st3 = makeStack();
  const b0 = await st3.token(A);
  putBrandsRow(st3.w, A, ["Acme", "Caruso Italy", "Zeta"], { upd: "2026-09-24T05:00:00.000Z" });
  ok("T3 a re-published brand-view-brands row changes the token; the catalog payload_sha / directory marketplace are in it too", (await st3.token(A)) !== b0);

  // P2-2: the owner requirement holds for what users SEE -- the (WP10) SERVE token moves on OLI CONTENT changes too,
  // so the serve stops serving the older stored row BEFORE the route republishes (forever-stale if the VM were down).
  const st4 = makeStack();
  await st4.pass();
  const v0 = await wp10Serve(st4, A, "ALL");
  st4.store.history.find((r) => r.sku === "C-1" && r.sale_date === "2026-09-23").units = 9;
  Object.assign(st4.store.coverage[0], { source_refreshed_at: "2026-09-24T07:00:00.000Z", updated_at: "2026-09-24T07:00:00.000Z" });
  const v1 = await wp10Serve(st4, A, "ALL");
  const sel1 = await st4.buildRuntime().servedSelector(unitOf(A, "ALL"), {});
  ok("T4 a same-effectiveAsOf OLI correction (coverage updated_at bump, same effectiveAsOf) moves the SERVE token: the serve no longer serves the stored row (read-only re-derive) and the route's selector says 'serve-rederives'",
    v0.current === true && v1.current === false && v1.effectiveAsOf === EFF && v1.serveToken !== v0.serveToken && sel1.row === null && sel1.reason === "serve-rederives");
  await st4.pass();
  const v2 = await wp10Serve(st4, A, "ALL");
  ok("T4 ... the route republishes with the new serve token and the serve serves the stored row again", v2.current === true && v2.stored.params.serveToken === v2.serveToken && v2.serveToken === v1.serveToken);
  const o0 = await wp10Serve(st4, A, "Caruso Italy");
  st4.store.opunits.push({ ...st4.store.opunits[0], sku: "C-1", child_asin: "B0CARU1", pending_units: 4, updated_at: "2026-09-24T09:00:00.000Z" });
  const o1 = await wp10Serve(st4, A, "Caruso Italy");
  ok("T5 a standalone operational-units backfill (no coverage change) moves the SERVE token (count + max(updated_at)): the stored row is no longer current for the serve", o0.current === true && o1.current === false && o1.effectiveAsOf === EFF);
  await st4.pass();
  const o2 = await wp10Serve(st4, A, "Caruso Italy");
  st4.store.opunits[st4.store.opunits.length - 1].updated_at = "2026-09-24T09:30:00.000Z";
  const o3 = await wp10Serve(st4, A, "Caruso Italy");
  ok("T5 ... republished -> current again; a same-count rewrite (only max(updated_at) moves) also invalidates it", o2.current === true && o3.current === false);
}

// =====================================================================================================================
// C. C8: catalog failures defer -- never a brandless ALL or an empty named payload
// =====================================================================================================================
{
  const st = makeStack();
  await st.pass();
  const lkg = { all: clone(st.live(EFF, "ALL")), acme: clone(st.live(EFF, "Acme")) };
  // Make A stale (an OLI correction), then break the catalog READ the derive depends on (the L1 pointer is still there).
  st.store.history[0].units = 5;
  st.store.coverage[0].source_refreshed_at = "2026-09-24T07:30:00.000Z";
  st.store.fail.catalog = "read-failed";
  const w0 = st.w.writes();
  const s = await st.pass();
  const eAll = st.unitState(s, A, "ALL"); const eAcme = st.unitState(s, A, sha12("Acme"));
  ok("C1 catalog read != 'ok': every stale A unit DEFERS typed 'bundle-evidence-read-failed:catalog' with ZERO writes (LKG preserved)",
    eAll.state === RS.DD && /^bundle-evidence-read-failed:catalog/.test(eAll.reason) && eAcme.state === RS.DD && /^bundle-evidence-read-failed:catalog/.test(eAcme.reason) && st.w.writes() === w0 && s.counts.targetsPublished === 0);
  ok("C1 ... the live rows are UNCHANGED: never a brandless ALL, never an empty named payload", B.stableJson(st.live(EFF, "ALL")) === B.stableJson(lkg.all) && B.stableJson(st.live(EFF, "Acme")) === B.stableJson(lkg.acme) && lkg.acme.payload.rows.length > 0);
  st.store.fail.catalog = null; st.store.fail.catalogPayload = true;
  const s2 = await st.pass();
  ok("C2 a catalog PAYLOAD-load failure also defers typed with zero writes", /^bundle-evidence-read-failed:catalog/.test(st.unitState(s2, A, "ALL").reason) && st.w.writes() === w0);
  st.store.fail.catalogPayload = false;
  const saved = st.store.catalogPointer; st.store.catalogPointer = null;
  const s3 = await st.pass();
  ok("C3 NO org catalog pointer: the whole account target is DEFERRED_PROVENANCE 'catalog-missing' at the L1 scan (zero reads of history, zero writes)",
    s3.perAccount.find((r) => r.accountId === A).reports[KEY].state === RS.DP && s3.perAccount.find((r) => r.accountId === A).reports[KEY].reason === "catalog-missing" && st.w.writes() === w0);
  st.store.catalogPointer = saved;
  // Contrast: the NON-strict serve path, over the SAME failing read, renders a brandless ALL + an empty named brand.
  st.store.fail.catalog = "read-failed";
  const readers = { readOliHistory: st.sb.getSourceOliHistoryRows, readOliCoverage: st.sb.getSourceCoverageWindows, readCatalogSnapshot: st.sb.getSourceSnapshot, loadCatalogPayload: st.sb.getSourceSnapshotPayload, readOliOperationalUnits: st.sb.getSourceOliOperationalUnitRows, readOliSkuAsinResolution: st.sb.getOliSkuAsinResolutionRows, readDirectory: async () => [...DIRECTORY.values()] };
  const soft = await RD.rederiveSkuMovement({ accountId: A, brand: "ALL", organizationFingerprint: ORG, ceiling: EPOCH }, readers);
  const softNamed = await RD.rederiveSkuMovement({ accountId: A, brand: "Acme", organizationFingerprint: ORG, ceiling: EPOCH }, readers);
  const strict = await RD.rederiveSkuMovement({ accountId: A, brand: "ALL", organizationFingerprint: ORG, ceiling: EPOCH }, readers, { strict: true });
  ok("C4 (contrast) the non-strict serve derive over the same failure is brandless / empty -- exactly what strict mode refuses to publish", soft.payload.rows.every((r) => r.brand === "Unmapped") && softNamed.payload.rows.length === 0 && strict.notReady === "evidence-read-failed:catalog");
  st.store.fail.catalog = null;
  const s4 = await st.pass();
  ok("C5 once the catalog reads again the stale units publish (retry converges)", s4.counts.targetsPublished === 3 && st.live(EFF, "ALL").payload.rows.some((r) => r.brand === "Acme"));
  // P3-1: a catalog payload that hydrates to ZERO rows (the pointer + read are fine) defers typed 'catalog-empty'.
  const lkg2 = { all: clone(st.live(EFF, "ALL")), acme: clone(st.live(EFF, "Acme")) };
  st.store.history[0].units = 6;
  st.store.coverage[0].source_refreshed_at = "2026-09-24T08:30:00.000Z";
  const savedPayload = st.store.catalogPayloads.get(CAT_PATH);
  st.store.catalogPayloads.set(CAT_PATH, { rows: [] });
  const w1 = st.w.writes();
  const s5 = await st.pass();
  ok("C6 (P3-1) an EMPTY hydrated catalog defers every stale A unit typed 'catalog-empty' with ZERO writes -- never an all-'Unmapped' ALL or 0-row named payloads over the LKG",
    [["ALL"], [sha12("Acme")], [sha12("Caruso Italy")]].every(([u]) => { const e = st.unitState(s5, A, u); return e.state === RS.DD && /catalog-empty/.test(e.reason); })
    && st.w.writes() === w1 && B.stableJson(st.live(EFF, "ALL")) === B.stableJson(lkg2.all) && B.stableJson(st.live(EFF, "Acme")) === B.stableJson(lkg2.acme));
  st.store.catalogPayloads.set(CAT_PATH, savedPayload);
}

// =====================================================================================================================
// U. named units come ONLY from the verified brand-view-brands row; exact brand strings; typed markers
// =====================================================================================================================
{
  const st = makeStack({ brandsA: ["ALL", "Acme", "caruso italy"] });
  const rt = st.buildRuntime();
  const ev = (await rt.readScopeEvidence({ scope: [A, BB] })).perAccount;
  const units = await rt.expandUnits({ accountId: A, evidence: ev.get(A) });
  ok("U1 the brand string is used EXACTLY as the verified row lists it (case preserved: 'caruso italy' is its own target, never folded to the catalog's 'Caruso Italy'); a listed 'ALL' is the All-Brands unit itself (no duplicate)",
    JSON.stringify(units.map((u) => u.targetId)) === JSON.stringify([skuMovementTargetId(A, "ALL"), skuMovementTargetId(A, "Acme"), skuMovementTargetId(A, "caruso italy")]) && units[2].unitKey === sha12("caruso italy"));
  ok("U1 every unit binds the owner as live account + rollout owner, the evidence's effectiveAsOf and the sku-movement key only", units.every((u) => u.liveAccountId === A && JSON.stringify(u.ownerAccountIds) === JSON.stringify([A]) && u.targetAsOf === EFF && JSON.stringify(u.reportKeys) === '["sku-movement"]'));
  // The brands row moved AFTER the token was composed -> the named units are not trusted.
  putBrandsRow(st.w, A, ["Acme", "Zeta"], { upd: "2026-09-24T05:30:00.000Z" });
  const moved = await rt.expandUnits({ accountId: A, evidence: ev.get(A) });
  ok("U2 a brands row that no longer matches the token's (params_hash, source_refreshed_at, updated_at) -> ALL + marker 'brand-list-advanced' (never the newer list under the older token)", moved.length === 2 && moved[1].deferred.reason === "brand-list-advanced" && moved[1].deferred.state === RS.DD);
  for (const [label, brands, over, reason] of [
    ["a padded brand", [" Acme"], {}, "brand-list-invalid"], ["a blank brand", [""], {}, "brand-list-invalid"], ["a duplicate", ["Acme", "Acme"], {}, "brand-list-invalid"],
    ["a non-array list", "Acme", {}, "brand-list-invalid"], ["another account's list", ["Acme"], { payloadAccount: BB }, "brand-list-invalid"],
  ]) {
    putBrandsRow(st.w, A, brands, { upd: "2026-09-24T05:40:00.000Z", ...over });
    const ev2 = (await rt.readScopeEvidence({ scope: [A] })).perAccount;
    const us = await rt.expandUnits({ accountId: A, evidence: ev2.get(A) });
    ok(`U3 ${label} in the brands row -> ALL + marker '${reason}' in state DEFERRED_PROVENANCE (a content problem: missing-evidence + alert; fail closed; no named unit from an unverified list)`, us.length === 2 && us[0].unitKey === "ALL" && us[1].unitKey === "brands" && us[1].deferred.reason === reason && us[1].deferred.state === RS.DP);
  }
  putBrandsRow(st.w, A, ["Acme", "L".repeat(600)], { upd: "2026-09-24T05:50:00.000Z" });
  const evLong = (await rt.readScopeEvidence({ scope: [A] })).perAccount;
  const usLong = await rt.expandUnits({ accountId: A, evidence: evLong.get(A) });
  ok("U3 a brand whose target id exceeds the reconciler bound is never silently dropped: the other brands stay units and the account keeps the marker 'brand-target-unrepresentable' (DEFERRED_PROVENANCE)", usLong.length === 3 && usLong[1].unitKey === sha12("Acme") && usLong[2].deferred.reason === "brand-target-unrepresentable" && usLong[2].deferred.state === RS.DP && SDR.normalizeRouteUnits(usLong, { accountId: A, requestedAsOf: EPOCH, reportKeys: [KEY] }).ok === true);
  st.store.fail.brandList = true;
  const usRf = await rt.expandUnits({ accountId: A, evidence: evLong.get(A) });
  st.store.fail.brandList = false;
  ok("U3 (P3-2) an unreadable brands row -> marker 'brand-list-read-failed' stays DEFERRED_DEPENDENCY (wait-and-retry), like 'brand-list-unavailable' / 'brand-list-advanced'", usRf.length === 2 && usRf[1].deferred.reason === "brand-list-read-failed" && usRf[1].deferred.state === RS.DD);
  const st2 = makeStack({ brandsA: [] });
  const s = await st2.pass();
  ok("U4 an EMPTY verified brand list builds ONLY the ALL unit (no marker: the list is proven empty)", st2.unitsOf(s, A).length === 1 && st2.unitState(s, A, "ALL").state === RS.RV);
  const pubs = st2.unitsOf(s, BB);
  ok("U4 the marker unit (B has no brands row) performs zero reads / zero writes and never publishes; B's ALL still publishes", pubs[1].reports[KEY].state === RS.DD && pubs[0].reports[KEY].state === RS.RV && !st2.w.jobs.some((j) => j.account_id.startsWith("sku-movement-brand-list:")));
  const bad = await rt.resolveBundle({ unitKey: "x", targetId: "sku-movement:" + A + ":: Acme", liveAccountId: A }, {});
  const bad2 = await rt.resolveBundle({ unitKey: "x", targetId: skuMovementTargetId(BB, "Acme"), liveAccountId: A }, {});
  ok("U5 resolveBundle refuses a non-canonical target (padded brand) or a target of another owner ('unit-target-invalid')", bad.eligible === false && bad.reason === "unit-target-invalid" && bad2.eligible === false && bad2.reason === "unit-target-invalid");
  ok("U5 unit keys are 'ALL' or sha12(brand) (the TARGETS grammar); the parser round-trips the canonical target", C.skuMovementUnitKey("ALL") === "ALL" && C.skuMovementUnitKey("Acme") === sha12("Acme") && JSON.stringify(C.parseSkuMovementUnit({ targetId: skuMovementTargetId(A, "Caruso Italy"), liveAccountId: A })) === JSON.stringify({ owner: A, brand: "Caruso Italy" }));
}

// =====================================================================================================================
// M. OLI loads ONCE per account across units (memo); the L1 metadata is re-read on every resolve
// =====================================================================================================================
{
  const st = makeStack();
  await st.pass();
  ok("M1 across ALL + 2 brand units of A (2 strict resolves each = 6) the OLI history is read ONCE for A and ONCE for B", st.store.calls.history.get(A) === 1 && st.store.calls.history.get(BB) === 1);
  ok("M1 the org catalog payload is hydrated ONCE for the whole run (both accounts share it)", st.store.calls.catalogPayload === 1);
  ok("M2 the L1 metadata is RE-READ on every resolve (the release's TOCTOU checks see real re-reads, never the memo)", (st.store.calls.pgByName.get("sku_coverage") || 0) >= 1 + 8 && (st.store.calls.pgByName.get("brand_list") || 0) >= 1);
  const rt = st.buildRuntime();
  const unit = { unitKey: "ALL", targetId: skuMovementTargetId(A, "ALL"), liveAccountId: A };
  const h0 = st.store.calls.history.get(A);
  const b1 = await rt.resolveBundle(unit, {});
  const b2 = await rt.resolveBundle({ ...unit, unitKey: sha12("Acme"), targetId: skuMovementTargetId(A, "Acme") }, {});
  ok("M3 a fresh runtime (a new CLI run) loads once more; its units share that load and the same manifest token", st.store.calls.history.get(A) === h0 + 1 && b1.eligible && b2.eligible && b1.manifestToken === b2.manifestToken && b1.serveToken !== b2.serveToken && b1.evidenceToken === b2.evidenceToken);
  st.store.coverage[0].source_refreshed_at = "2026-09-24T11:00:00.000Z";
  const b3 = await rt.resolveBundle(unit, {});
  ok("M3 an evidence change moves the L1 token -> the memo key changes -> the history is reloaded (never stale content under a new token)", b3.eligible && b3.evidenceToken !== b1.evidenceToken && st.store.calls.history.get(A) === h0 + 2);
  st.store.coverage[0].source_refreshed_at = "2026-09-24T12:00:00.000Z";
  st.store.fail.coverage = "read-failed";
  const b4 = await rt.resolveBundle(unit, {});
  st.store.fail.coverage = null;
  const b5 = await rt.resolveBundle(unit, {});
  ok("M4 a failed strict load is NOT memoised (typed 'evidence-read-failed:coverage'); the next resolve of the SAME token retries it", b4.eligible === false && b4.reason === "evidence-read-failed:coverage" && b5.eligible === true && b5.evidenceToken !== b3.evidenceToken && st.store.calls.history.get(A) === h0 + 3);
  st.store.coverage.push({ ...st.store.coverage[0], covered_from: "2026-09-10", covered_to: "2026-09-23" });
  const l1 = (await rt.readScopeEvidence({ scope: [A] })).perAccount.get(A);
  ok("M5 the composed L1 evidence carries every coverage window + its stamps, the opunits window and the verified-row metadata", l1.windows.length === 2 && l1.windows.every((w) => /Z$/.test(w.sourceRefreshedAt) && /Z$/.test(w.updatedAt)) && l1.opunits.windowFrom === "2026-06-01" && l1.opunits.windowTo === EFF && l1.brands && l1.brands.paramsHash === W.brandViewBrandsLiveHash(A) && l1.catalog.payloadSha === "catsha1" && l1.marketplace === "IN" && l1.region === "india");
  st.store.fail.pg = true;
  const ev = await rt.readScopeEvidence({ scope: [A] });
  const b6 = await rt.resolveBundle(unit, {});
  st.store.fail.pg = false;
  ok("M6 an unreadable L1 read fails the scope typed (DURABLE_SOURCE_UNREADABLE) and a resolve defers 'evidence-read-failed:l1' -- never a guessed token", ev.ok === false && /^DURABLE_SOURCE_UNREADABLE/.test(ev.failCode) && b6.eligible === false && b6.reason === "evidence-read-failed:l1");
  const wk = W.composeSkuMovementEvidence({ sku_coverage: [], sku_opunits: [], sku_catalog: [], sku_brands: [] }, { now: Date.UTC(2026, 8, 24), directory: DIRECTORY, accountIds: [A] });
  ok("M7 (P3-4) the worker compose gives a scope account with no rows an entry in the returns-v3 shape { token: null, owners, region, alerts: [], reason: 'coverage-incomplete' } (no targetAsOf); a missing statement result throws",
    wk.get(A) && wk.get(A).token === null && wk.get(A).reason === "coverage-incomplete" && JSON.stringify(wk.get(A).owners) === JSON.stringify([A]) && wk.get(A).region === "india" && JSON.stringify(wk.get(A).alerts) === "[]" && !("targetAsOf" in wk.get(A))
    && (() => { try { W.composeSkuMovementEvidence({ sku_coverage: [] }, { now: 1 }); return false; } catch { return true; } })());

  // P3-4: the worker compose over the REAL statements (through the fake pg) -- eligible vs every typed ineligibility,
  // and the `now`-less params contract.
  const NOW = Date.UTC(2026, 8, 24, 6, 0, 0);
  const rowsFor = async (ctx) => { const r = {}; for (const q of W.SKU_MOVEMENT_EVIDENCE_SQL) r[q.name] = await st.pg(q.text, q.params(ctx)); return r; };
  const base = { organizationFingerprint: ORG, accountIds: [A, BB] };
  const eligible = W.composeSkuMovementEvidence(await rowsFor({ ...base, now: NOW }), { now: NOW, directory: DIRECTORY, accountIds: [A, BB] });
  const cliTok = (await st.buildRuntime().readScopeEvidence({ scope: [A, BB] })).perAccount;
  ok("M8 (P3-4) an eligible account composes { token, owners, region, targetAsOf: effectiveAsOf, alerts: [] } with the SAME token the CLI evaluates",
    JSON.stringify(eligible.get(A)) === JSON.stringify({ token: cliTok.get(A).token, owners: [A], region: "india", targetAsOf: cliTok.get(A).effectiveAsOf, alerts: [] }) && eligible.get(BB).targetAsOf === EFF_B && eligible.get(BB).token === cliTok.get(BB).token);
  const noNow = W.composeSkuMovementEvidence(await rowsFor(base), { now: NOW, directory: DIRECTORY, accountIds: [A, BB] });
  ok("M8 params WITHOUT `now` (ceiling not binding) compose the SAME tokens as params with the same `now`", noNow.get(A).token === eligible.get(A).token && noNow.get(BB).token === eligible.get(BB).token);
  const inel = async (mutate, dir = DIRECTORY, ctxOver = {}) => {
    const s2 = makeStack(); mutate(s2.store);
    const r = {}; for (const q of W.SKU_MOVEMENT_EVIDENCE_SQL) r[q.name] = await s2.pg(q.text, q.params({ ...base, now: NOW, ...ctxOver }));
    return W.composeSkuMovementEvidence(r, { now: NOW, directory: dir, accountIds: [A, BB] }).get(A);
  };
  const noMkt = await inel(() => {}, new Map([[BB, DIRECTORY.get(BB)]]));
  const noCat = await inel((s) => { s.catalogPointer = null; });
  // The ceiling BINDS (coverage reaches past the UTC date of `now`) and the params ran WITHOUT `now`: the opunits window
  // the SQL computed (uncapped) disagrees with compose's capped effectiveAsOf -> typed, never a token over the wrong window.
  const past = (s) => { s.coverage.push({ ...s.coverage[0], covered_from: "2026-09-24", covered_to: "2026-09-25" }); };
  const binds = await inel(past, DIRECTORY, { now: undefined });
  const bindsWithNow = await inel(past);
  ok("M8 ineligible accounts carry token null + the typed reason: 'no-marketplace', 'catalog-missing', and 'evidence-inconsistent' when `now`-less params meet a binding ceiling (with the SAME `now` it is eligible at the capped as-of)",
    noMkt.token === null && noMkt.reason === "no-marketplace" && noCat.token === null && noCat.reason === "catalog-missing" && binds.token === null && binds.reason === "evidence-inconsistent"
    && /^sm1:/.test(bindsWithNow.token) && bindsWithNow.targetAsOf === "2026-09-24" && !bindsWithNow.reason);

  // P2-2 cross-check: when the hydrated coverage read carries window stamps (the WP10-extended reader), they must be
  // the L1's (canonical instants: the REST '+00:00' rendering of the same timestamptz agrees).
  const st5 = makeStack();
  st5.store.covStampFn = (r) => pgrest(r.updated_at);
  const okB = await st5.buildRuntime().resolveBundle(unitOf(A, "ALL"), {});
  st5.store.covStampFn = () => "2026-01-01T00:00:00+00:00";
  const badB = await st5.buildRuntime().resolveBundle(unitOf(A, "ALL"), {});
  st5.store.covStampFn = null;
  const plainB = await st5.buildRuntime().resolveBundle(unitOf(A, "ALL"), {});
  ok("M9 (P2-2) resolveBundle computes the stored serve token from the L1 metadata; hydrated window stamps that disagree with the L1's -> typed 'evidence-inconsistent' (the same stamps in PostgREST form agree)",
    okB.eligible === true && badB.eligible === false && badB.reason === "evidence-inconsistent" && plainB.eligible === true && okB.serveToken === plainB.serveToken && /^sms2:/.test(okB.serveToken));
}

// =====================================================================================================================
// S. skuMovementStoredIsCurrent / stripStoredExtras / serve-token parity with the WP10 serve
// =====================================================================================================================
{
  // The LEGACY predicate, transcribed VERBATIM from api/datadoe.js serveSelfHealingSkuMovement (pre-WP10).
  const legacy = (stored, effectiveAsOf, freshRefreshedAt) => !!(stored && stored.payload && effectiveAsOf && freshRefreshedAt
      && String(stored.source_refreshed_at || "") === String(freshRefreshedAt)
      && stored.payload.effectiveAsOf === effectiveAsOf);
  const API = src("api/datadoe.js");
  const legacyText = [
    "if (stored && stored.payload && effectiveAsOf && freshRefreshedAt",
    "      && String(stored.source_refreshed_at || \"\") === String(freshRefreshedAt)",
    "      && stored.payload.effectiveAsOf === effectiveAsOf) {",
  ].join("\n");
  ok("S0 api/datadoe.js still carries the legacy predicate this module transcribes VERBATIM -- or already delegates to skuMovementStoredIsCurrent (WP10)", API.includes(legacyText) || /skuMovementStoredIsCurrent\(/.test(API));
  const PROV = "2026-09-20T00:00:00.000Z";
  const rows = [
    null, {}, { payload: null }, { payload: { effectiveAsOf: EFF }, source_refreshed_at: PROV },
    { payload: { effectiveAsOf: EFF }, source_refreshed_at: "2026-09-21T00:00:00.000Z" }, { payload: { effectiveAsOf: "2026-09-22" }, source_refreshed_at: PROV },
    { payload: { effectiveAsOf: EFF }, source_refreshed_at: null }, { params: { reportVersion: VERSION, asOf: EFF, brand: "ALL" }, payload: { effectiveAsOf: EFF }, source_refreshed_at: PROV },
  ];
  const inputs = [[EFF, PROV], [EFF, null], [null, PROV], ["2026-09-22", PROV], [EFF, "2026-09-21T00:00:00.000Z"]];
  const matrix = rows.flatMap((r) => inputs.map(([e, p]) => [r, e, p]));
  ok(`S1 LEGACY rows (no serveToken): skuMovementStoredIsCurrent AND skuMovementLegacyStoredIsCurrent == the api/datadoe.js predicate over all ${matrix.length} fixture combinations`,
    matrix.every(([r, e, p]) => EVI.skuMovementStoredIsCurrent({ stored: r, effectiveAsOf: e, serveToken: "sms2:zz", legacyProvenance: p }) === legacy(r, e, p) && EVI.skuMovementLegacyStoredIsCurrent({ stored: r, effectiveAsOf: e, legacyProvenance: p }) === legacy(r, e, p)) && matrix.some(([r, e, p]) => legacy(r, e, p)));
  const tokRow = (tok, eff = EFF) => ({ params: { reportVersion: VERSION, asOf: eff, brand: "ALL", serveToken: tok }, payload: { effectiveAsOf: eff }, source_refreshed_at: "2026-09-24T06:05:00.000Z" });
  ok("S2 NEW-token rows: current ONLY on 'sms2:' token equality AND the same effectiveAsOf -- the stamp is irrelevant; a stale token or another as-of re-derives; a blank / non-string token never falls back to the legacy predicate",
    EVI.skuMovementStoredIsCurrent({ stored: tokRow("sms2:a"), effectiveAsOf: EFF, serveToken: "sms2:a", legacyProvenance: PROV }) === true
    && EVI.skuMovementStoredIsCurrent({ stored: tokRow("sms2:a"), effectiveAsOf: EFF, serveToken: "sms2:b", legacyProvenance: "2026-09-24T06:05:00.000Z" }) === false
    && EVI.skuMovementStoredIsCurrent({ stored: tokRow("sms2:a"), effectiveAsOf: "2026-09-22", serveToken: "sms2:a" }) === false
    && EVI.skuMovementStoredIsCurrent({ stored: tokRow("sms2:a"), effectiveAsOf: EFF, serveToken: null }) === false
    && EVI.skuMovementStoredIsCurrent({ stored: tokRow(""), effectiveAsOf: EFF, serveToken: "", legacyProvenance: "2026-09-24T06:05:00.000Z" }) === false
    && EVI.skuMovementStoredIsCurrent({ stored: tokRow(5), effectiveAsOf: EFF, serveToken: "5", legacyProvenance: "2026-09-24T06:05:00.000Z" }) === false
    && EVI.skuMovementStoredIsCurrent({ stored: { ...tokRow("sms2:a"), payload: null }, effectiveAsOf: EFF, serveToken: "sms2:a" }) === false);
  ok("S2 (P2-2) a row carrying the RETIRED 'sms1:' token is NEVER current (even against an equal 'sms1:' token or a matching legacy stamp): the serve re-derives it and the route republishes it",
    EVI.SKU_SERVE_TOKEN_PREFIX === "sms2:" && EVI.skuMovementStoredIsCurrent({ stored: tokRow("sms1:a"), effectiveAsOf: EFF, serveToken: "sms1:a", legacyProvenance: "2026-09-24T06:05:00.000Z" }) === false);
  const stored = { reportVersion: VERSION, asOf: EFF, brand: "Acme", evidenceToken: "sm1:x", serveToken: "sms2:y", manifestToken: "smm1:z", depFingerprint: "d" };
  ok("S3 stripStoredExtras restores the CANONICAL response paramsHash for a route row, and is byte-identical to the legacy strip (reportVersion only) for a legacy row",
    paramsHashFor(VERSION, EVI.stripStoredExtras(stored)) === liveHash(EFF, "Acme") && paramsHashFor(VERSION, Object.fromEntries(Object.entries(stored).filter(([k]) => k !== "reportVersion"))) !== liveHash(EFF, "Acme")
    && JSON.stringify(EVI.stripStoredExtras({ reportVersion: VERSION, asOf: EFF, brand: "ALL" })) === JSON.stringify({ asOf: EFF, brand: "ALL" }) && EVI.stripStoredExtras(null) === null && EVI.stripStoredExtras([1]) === null
    && JSON.stringify(EVI.SKU_STORED_EXTRA_KEYS) === JSON.stringify(["reportVersion", ...B.LIVE_PARAMS_EXTRA_KEYS]));
  ok("S4 the serve's canonical brand is IDENTICAL to skuMovementCanonicalBrand (report-publisher.js) over a fixture matrix", ["", " ", "ALL", "all", " Acme ", "Caruso Italy", null, undefined, 0, "x  y"].every((b) => EVI.skuServeCanonicalBrand(b) === skuMovementCanonicalBrand(b)));

  // The canonical instant: the SQL to_char 'Z' rendering and PostgREST's offset rendering of one timestamptz agree.
  const CI = EVI.canonicalSkuInstant;
  ok("S5 canonicalSkuInstant: every ISO offset form of one instant -> ONE microsecond UTC text (microseconds kept textually); a Date object / no offset / impossible date or time / >6 fraction digits -> null",
    CI("2026-09-24T01:00:00Z") === "2026-09-24T01:00:00.000000Z" && CI("2026-09-24T01:00:00+00:00") === "2026-09-24T01:00:00.000000Z" && CI("2026-09-24T01:00:00.000000Z") === "2026-09-24T01:00:00.000000Z"
    && CI("2026-09-24T06:30:00.25+05:30") === "2026-09-24T01:00:00.250000Z" && CI("2026-09-24 01:00:00.123456+00") === "2026-09-24T01:00:00.123456Z" && CI("2026-09-24T00:00:00-0100") === "2026-09-24T01:00:00.000000Z"
    && CI("2026-09-24T01:00:00.123456789Z") === null && CI("2026-02-30T00:00:00Z") === null && CI("2026-09-24T24:00:00Z") === null && CI("2026-09-24T01:00:00") === null && CI(new Date()) === null && CI("") === null && CI(null) === null);
  const WIN = [{ from: "2026-01-01", to: "2026-05-01", updatedAt: "2026-09-24T01:00:00.000000Z" }, { from: "2026-05-02", to: EFF, updatedAt: "2026-09-24T02:00:00.500000Z" }];
  const OPU = { windowFrom: "2026-06-01", windowTo: EFF, rows: 2, maxUpdatedAt: "2026-09-24T03:00:00.123456Z" };
  const tk = (o = {}) => EVI.computeSkuServeToken({ effectiveAsOf: EFF, coverageWindows: WIN, catalogPayloadSha: "c", opunits: OPU, brand: "Acme", ...o });
  const t0 = tk();
  ok("S5 (P2-2) the 'sms2:' serve token is null (fail closed) without a date, a catalog sha, a window updated_at, a canonical window stamp, or valid operational-units stats over EXACTLY [monthBack(effAsOf,3), effAsOf]",
    /^sms2:[0-9a-f]{64}$/.test(t0) && tk({ effectiveAsOf: null }) === null && tk({ catalogPayloadSha: " " }) === null
    && tk({ coverageWindows: [{ from: "2026-01-01", to: EFF }] }) === null && tk({ coverageWindows: [{ from: "2026-01-01", to: EFF, updatedAt: "yesterday" }] }) === null
    && tk({ opunits: null }) === null && tk({ opunits: { ...OPU, windowFrom: "2026-07-01" } }) === null && tk({ opunits: { ...OPU, windowTo: "2026-09-22" } }) === null
    && tk({ opunits: { ...OPU, rows: 1.5 } }) === null && tk({ opunits: { ...OPU, rows: "2" } }) === null && tk({ opunits: { ...OPU, maxUpdatedAt: null } }) === null && tk({ opunits: { ...OPU, rows: 0 } }) === null
    && /^sms2:/.test(tk({ opunits: { ...OPU, rows: 0, maxUpdatedAt: null } })) && JSON.stringify(EVI.skuServeOpunitsWindow(EFF)) === JSON.stringify({ from: "2026-06-01", to: EFF }));
  ok("S5 window order / spelling / timestamp rendering never change the token (PostgREST '+00:00' == to_char 'Z'); the brand, a 1-microsecond window stamp move, the opunits count / max(updated_at) and the catalog sha each DO",
    tk({ coverageWindows: [{ covered_from: "2026-05-02", covered_to: EFF, updated_at: "2026-09-24T02:00:00.5+00:00" }, { covered_from: "2026-01-01", covered_to: "2026-05-01", updated_at: "2026-09-24T01:00:00+00:00" }], opunits: { ...OPU, maxUpdatedAt: "2026-09-24T03:00:00.123456+00:00" }, brand: " Acme " }) === t0
    && new Set([t0, tk({ brand: "acme" }), tk({ coverageWindows: [WIN[0], { ...WIN[1], updatedAt: "2026-09-24T02:00:00.500001Z" }] }), tk({ opunits: { ...OPU, rows: 3 } }), tk({ opunits: { ...OPU, maxUpdatedAt: "2026-09-24T03:00:00.123457Z" } }), tk({ catalogPayloadSha: "d" })]).size === 6);

  // PARITY with the WP10 serve (THE SERVE-SIDE CONTRACT): the serve computes its token from ITS OWN REST reads
  // (PostgREST-rendered stamps), the route stored the token it computed from its L1 SQL (to_char-rendered stamps).
  const st = makeStack();
  await st.pass();
  const cases = [[A, "ALL", EFF], [A, "Acme", EFF], [A, "Caruso Italy", EFF], [BB, "ALL", EFF_B], [A, "", EFF]];
  const results = [];
  for (const [acct, brand, eff] of cases) results.push([await wp10Serve(st, acct, brand), acct, brand, eff]);
  ok("S6 serve-token PARITY: for every published unit the WP10 serve's token (from ITS PostgREST-shaped reads) equals the route's stored params.serveToken (from its SQL reads) -> the stored row is served, with the CANONICAL response paramsHash",
    results.every(([r, acct, brand, eff]) => r.current === true && /^sms2:/.test(r.serveToken) && r.serveToken === r.stored.params.serveToken && r.paramsHash === liveHash(eff, brand === "" ? "ALL" : brand) && r.stored.account_id === acct));
  const probe = await C.skuServeFreshnessProbe({ sb: st.sb, readServeTokenInputs: restTokenInputs(st.store), organizationFingerprint: ORG, accountId: A, brand: "Acme", ceiling: EPOCH });
  const probeLegacy = await C.skuServeFreshnessProbe({ sb: st.sb, organizationFingerprint: ORG, accountId: A, brand: "Acme", ceiling: EPOCH });
  ok("S6 the route's served selector uses the SAME probe (skuServeFreshnessProbe with the serve's token inputs == the WP10 serve's token + provenance; without them it is the legacy probe: no token)",
    probe.read === "ok" && probe.serveToken === results[1][0].serveToken && probe.effectiveAsOf === EFF && probe.legacyProvenance === "2026-09-23T00:00:00.000Z" && probeLegacy.read === "ok" && probeLegacy.serveToken === null && probeLegacy.legacyProvenance === probe.legacyProvenance);
  const probeBad = await C.skuServeFreshnessProbe({ sb: st.sb, readServeTokenInputs: async () => ({ read: "ok", coverageWindows: [], opunits: null }), organizationFingerprint: ORG, accountId: A, brand: "Acme", ceiling: EPOCH });
  ok("S6 token inputs that do not cover EXACTLY the windows the serve read are never used (read != 'ok', no token)", probeBad.read !== "ok" && probeBad.serveToken === null);
  // A NEW coverage window (the evidence moved) -> the serve's token moves -> the serve re-derives; the route's served
  // selector reports 'serve-rederives' + heldBy (it models what the page is actually served).
  st.store.coverage.push({ ...st.store.coverage[0], covered_from: "2026-09-24", covered_to: "2026-09-24", source_refreshed_at: "2026-09-24T13:00:00.000Z", updated_at: "2026-09-24T13:00:00.000Z" });
  const moved = await wp10Serve(st, A, "ALL");
  const rt = st.buildRuntime();
  const liveAll = st.live(EFF, "ALL");
  const served = await rt.servedSelector(unitOf(A, "ALL"), {});
  ok("S7 (P3-3) once the serve's evidence moves (a new coverage window), the stored row is NOT current for the serve and the route's selector reports null 'serve-rederives' with heldBy = the identity of the row holding the serve's latest slot (never a false served-row proof)",
    moved.current === false && served.row === null && served.reason === "serve-rederives" && served.via === "scope-latest" && served.heldBy && served.heldBy.id === liveAll.id && served.heldBy.params_hash === liveHash(EFF, "ALL") && !("payload" in served.heldBy) && served.storedTokenStale !== true);
  st.store.coverage.pop();
  const served2 = await rt.servedSelector(unitOf(A, "ALL"), {});
  ok("S7 ... and with the serve's evidence unchanged the selector returns the stored live row (identity only, never a payload)", served2.row && served2.row.account_id === A && served2.row.params_hash === liveHash(EFF, "ALL") && !("payload" in served2.row));
  // P3-3: a probe read that is not 'ok' is 'read-failed' (never 'serve-rederives').
  const rf = {};
  st.store.fail.coverage = "read-failed"; rf.cov = await rt.servedSelector(unitOf(A, "ALL"), {}); st.store.fail.coverage = null;
  st.store.fail.catalog = "read-failed"; rf.cat = await rt.servedSelector(unitOf(A, "ALL"), {}); st.store.fail.catalog = null;
  st.store.fail.coverage = "throw"; rf.thr = await rt.servedSelector(unitOf(A, "ALL"), {}); st.store.fail.coverage = null;
  st.store.fail.pg = true; rf.pg = await rt.servedSelector(unitOf(A, "ALL"), {}); st.store.fail.pg = false;
  ok("S7 (P3-3) a coverage read != 'ok', a catalog read != 'ok', a probe throw or an unreadable token-input read -> null 'read-failed' (not 'serve-rederives')",
    [rf.cov, rf.cat, rf.thr, rf.pg].every((x) => x.row === null && x.reason === "read-failed" && x.via === "scope-latest"));
  // A legacy materializer row (no serveToken) is judged by the legacy predicate in the selector too.
  const legacyRow = { id: "legacy-1", report_key: KEY, account_id: A, params_hash: liveHash(EFF, "Zeta"), params: { reportVersion: VERSION, asOf: EFF, brand: "Zeta" }, payload: { effectiveAsOf: EFF, rows: [], brandFiltered: true }, payload_storage_path: null, source_refreshed_at: "2026-09-23T00:00:00.000Z", updated_at: "2026-09-24T00:00:00.000Z" };
  st.w.snaps.set(st.w.snapKey(KEY, A, legacyRow.params_hash), legacyRow);
  const servedLegacy = await rt.servedSelector(unitOf(A, "Zeta"), {});
  ok("S8 a LEGACY row whose stamp equals the serve's provenance (max(catalog validated_at, effAsOf)) is served by the selector exactly as the legacy serve would", servedLegacy.row && servedLegacy.row.id === "legacy-1");

  // P2-1: the serve-token ATTESTATION interlock. Not attested -> the selector models the DEPLOYED legacy serve.
  ok("S9 skuServeTokenAttested: ONLY env.SKU_MOVEMENT_SERVE_TOKEN_ATTESTED === 'true' attests (unset / 'TRUE' / '1' / ' true' / non-object -> legacy, fail closed)",
    C.skuServeTokenAttested({ SKU_MOVEMENT_SERVE_TOKEN_ATTESTED: "true" }) === true && [{}, { SKU_MOVEMENT_SERVE_TOKEN_ATTESTED: "TRUE" }, { SKU_MOVEMENT_SERVE_TOKEN_ATTESTED: "1" }, { SKU_MOVEMENT_SERVE_TOKEN_ATTESTED: " true" }, { SKU_MOVEMENT_SERVE_TOKEN_ATTESTED: true }, null, "true"].every((e) => C.skuServeTokenAttested(e) === false)
    && C.SKU_MOVEMENT_SERVE_TOKEN_ATTESTED_ENV === "SKU_MOVEMENT_SERVE_TOKEN_ATTESTED");
  const rtLegacy = st.buildRuntime({ env: {} });
  const routeLegacy = await rtLegacy.servedSelector(unitOf(A, "ALL"), {});
  const routeAtt = await rt.servedSelector(unitOf(A, "ALL"), {});
  ok("S9 a ROUTE row (stamped cycle.created_at): attested -> served; NOT attested -> the legacy predicate (stamp != max(catalog validated_at, effAsOf T00Z)) -> null 'serve-rederives' + heldBy, never fixable",
    routeAtt.row && routeAtt.row.id === liveAll.id && routeLegacy.row === null && routeLegacy.reason === "serve-rederives" && routeLegacy.heldBy.id === liveAll.id && routeLegacy.storedTokenStale !== true
    && liveAll.source_refreshed_at !== "2026-09-23T00:00:00.000Z" && rtLegacy.servedVerdict(routeLegacy, { report_key: KEY, account_id: A, params_hash: liveAll.params_hash, source_refreshed_at: liveAll.source_refreshed_at }).fixable === false);
  const legacyL = await rtLegacy.servedSelector(unitOf(A, "Zeta"), {});
  const legacyOther = { ...legacyRow, id: "legacy-2", params_hash: liveHash(EFF, "Other"), params: { ...legacyRow.params, brand: "Other" }, source_refreshed_at: "2026-09-22T00:00:00.000Z" };
  st.w.snaps.set(st.w.snapKey(KEY, A, legacyOther.params_hash), legacyOther);
  const otherAtt = await rt.servedSelector(unitOf(A, "Other"), {});
  const otherLeg = await rtLegacy.servedSelector(unitOf(A, "Other"), {});
  ok("S9 a LEGACY row is judged by the SAME legacy predicate in both modes: stamp == provenance -> served (attested + not attested); another stamp -> 'serve-rederives' in both",
    legacyL.row && legacyL.row.id === "legacy-1" && servedLegacy.row.id === "legacy-1" && otherAtt.row === null && otherAtt.reason === "serve-rederives" && otherLeg.row === null && otherLeg.reason === "serve-rederives");
  const saved = process.env.SKU_MOVEMENT_SERVE_TOKEN_ATTESTED;
  process.env.SKU_MOVEMENT_SERVE_TOKEN_ATTESTED = "true";
  const rtEnvT = C.default.build({ bucket: REGION, directory: DIRECTORY, orgFp: ORG, connectionId: "primary", sb: st.sb, pgReadOnly: st.pg, now: () => st.w.now(), liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS });
  delete process.env.SKU_MOVEMENT_SERVE_TOKEN_ATTESTED;
  const rtEnvF = C.default.build({ bucket: REGION, directory: DIRECTORY, orgFp: ORG, connectionId: "primary", sb: st.sb, pgReadOnly: st.pg, now: () => st.w.now(), liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS });
  if (saved !== undefined) process.env.SKU_MOVEMENT_SERVE_TOKEN_ATTESTED = saved;
  const eT = await rtEnvT.servedSelector(unitOf(A, "ALL"), {});
  const eF = await rtEnvF.servedSelector(unitOf(A, "ALL"), {});
  ok("S9 without deps.env the flag is read from process.env (the route CLI's env) ONCE at build: 'true' -> attested, unset -> legacy", eT.row && eT.row.id === liveAll.id && eF.row === null && eF.reason === "serve-rederives");
}

// =====================================================================================================================
// A. P2-1 end to end: NOT attested (the deployed legacy serve) -> the ACTIVATION GATE (WP13 verifier P2-2) DEFERS every
//    LIVE write with ZERO writes (derive refuses before any cycle / job / shadow; publishGuard refuses a resumed prepare
//    before the CAS); nothing is ever read back as served / counted published / current. P2-2 (WP6): a consistent route
//    row carrying the RETIRED 'sms1:' serve token (shadow + live agree, so the exact binding alone says current) is
//    REPUBLISHED (attested).
// =====================================================================================================================
{
  const GATE = "sku-movement-serve-not-attested:route-not-activated";
  // The REAL publishable units (A: ALL + its two brands; B: ALL). B has no brands row in this fixture, so it also carries
  // the typed brand-list MARKER unit (never read, never written) -- not a publishable unit.
  const REAL_UNITS = [["ALL", A], [sha12("Acme"), A], [sha12("Caruso Italy"), A], ["ALL", BB]];
  const st = makeStack({ attested: false });
  const s1 = await st.pass();
  ok("A1 NOT attested: a LIVE pass writes NOTHING (zero cycle / job / shadow / live writes, zero CAS, zero controls): every unit is the typed DEFERRED 'derive-not-ready:" + GATE + "', never published",
    s1.counts.targetsPublished === 0 && st.w.writes() === 0 && st.w.n.liveCas === 0 && st.w.n.shadowCas === 0 && st.controls.opened.length === 0
    && REAL_UNITS.every(([u, a]) => { const e = st.unitState(s1, a, u); return e.state === RS.DD && e.reason === "derive-not-ready:" + GATE; })
    && C.SKU_MOVEMENT_ROUTE_NOT_ACTIVATED === GATE);
  const s2 = await st.pass({ dryRun: true });
  ok("A1 ... and a re-scan (dry-run is unaffected by the gate) never calls those units current or published", [["ALL", A], [sha12("Acme"), A], ["ALL", BB]].every(([u, a]) => { const e = st.unitState(s2, a, u); return e.state !== RS.NR && e.state !== RS.RV; }) && st.w.writes() === 0);
  // The RESUME path: an attested run prepared the shadows but its publish never landed (lease lost); the attestation is
  // then withdrawn -> the resumed prepare skips derive, and publishGuard refuses before the CAS (zero CAS, zero writes).
  const sr = makeStack();
  const okLease = sr.w.verifyLease;
  sr.w.verifyLease = async () => ({ ok: false, reason: "lease-expired" });
  await sr.pass();
  const preparedShadows = sr.w.n.shadowWrite;
  ok("A1 (setup) an attested pass whose lease is lost prepares shadows but publishes NOTHING", preparedShadows > 0 && sr.w.n.liveWrite === 0);
  sr.w.verifyLease = okLease;
  sr.setAttested(false);
  const cas0 = sr.w.n.liveCas, writes0 = sr.w.writes();
  const s3 = await sr.pass();
  ok("A1 NOT attested + a RESUMED prepare: publishGuard defers each unit '" + GATE + "' with ZERO CAS and zero writes (never published)",
    s3.counts.targetsPublished === 0 && sr.w.n.liveCas === cas0 && sr.w.writes() === writes0 && sr.w.n.liveWrite === 0
    && REAL_UNITS.every(([u, a]) => { const e = sr.unitState(s3, a, u); return e.state === RS.DD && e.reason === GATE; }));
  sr.setAttested(true);
  const s4 = await sr.pass();
  ok("A1 ... and once the owner attests, the SAME prepared evidence publishes (the gate converges; nothing was lost)", s4.counts.targetsPublished > 0 && sr.w.n.liveWrite > 0);

  const sa = makeStack();
  await sa.pass();
  const tid = skuMovementTargetId(A, "ALL");
  const job = sa.w.jobs.filter((j) => j.account_id === tid).pop();
  const shKey = sa.w.snapKey("scheduler-v2/" + KEY, tid, job.snapshot_params_hash);
  const sh = sa.w.snaps.get(shKey);
  const SMS1 = "sms1:" + "a".repeat(64);
  const shParams = { ...sh.params, serveToken: SMS1 };
  const shHash = paramsHashFor(shParams.reportVersion, shParams);
  sa.w.snaps.delete(shKey);
  sa.w.snaps.set(sa.w.snapKey("scheduler-v2/" + KEY, tid, shHash), { ...sh, params: shParams, params_hash: shHash });
  job.snapshot_params_hash = shHash;
  sa.live(EFF, "ALL").params.serveToken = SMS1;
  const sel = await sa.buildRuntime().servedSelector(unitOf(A, "ALL"), {});
  const scan = await sa.pass({ dryRun: true });
  ok("A2 (P2-2) an 'sms1:' route row whose shadow + live agree: the serve would re-derive it (storedTokenStale) and the route's servedVerdict makes it FIXABLE -> STALE 'served-row-differs' (never silently current, never a non-fixable dead end)",
    sel.row === null && sel.reason === "serve-rederives" && sel.storedTokenStale === true && sa.unitState(scan, A, "ALL").state === RS.ST && sa.unitState(scan, A, "ALL").reason === "served-row-differs" && sa.unitState(scan, A, sha12("Acme")).state === RS.NR);
  const sLive = await sa.pass();
  const after = sa.live(EFF, "ALL");
  const v = await wp10Serve(sa, A, "ALL");
  const scan2 = await sa.pass({ dryRun: true });
  ok("A2 ... a live pass REPUBLISHES it with the current 'sms2:' token; the WP10 serve serves it and a re-scan is PUBLICATION_NOT_REQUIRED (no loop)",
    sLive.counts.targetsPublished === 1 && /^sms2:/.test(after.params.serveToken) && v.current === true && sa.unitState(scan2, A, "ALL").state === RS.NR);
}

// =====================================================================================================================
// D. strict re-derive typed failures; NON-strict output byte-identical to the pre-WP6 implementation
// =====================================================================================================================
{
  // The PRE-WP6 implementation, transcribed VERBATIM (gatherSkuMovementEvidence + rederiveSkuMovement + helpers).
  const S2 = (v) => (v == null ? "" : String(v));
  async function oldReadOperationalUnits(readOliOperationalUnits, { organizationFingerprint, connectionId, accountId, from, to }) {
    if (typeof readOliOperationalUnits !== "function") return [];
    try { const rows = await readOliOperationalUnits({ organizationFingerprint, connectionId, accountIds: [S2(accountId)], from, to, additiveOnly: true }); return Array.isArray(rows) ? rows : []; } catch (_e) { return []; }
  }
  async function oldBuildAccountResolver({ readDirectory, readOliSkuAsinResolution }, { organizationFingerprint, connectionId, accountId }) {
    if (typeof readDirectory !== "function" || typeof readOliSkuAsinResolution !== "function") return null;
    try {
      const accounts = await readDirectory();
      const resolution = OSE.resolveUniqueMarketplaceByAccount(Array.isArray(accounts) ? accounts : []);
      const mkt = OSE.authoritativeMarketplace(resolution, accountId);
      if (!mkt) return null;
      const resRows = await readOliSkuAsinResolution({ organizationFingerprint, connectionId, accountId });
      return OSE.buildSkuAsinResolver({ accountMarketplace: mkt, historyRows: Array.isArray(resRows) ? resRows : [], catalogRows: [] });
    } catch (_e) { return null; }
  }
  async function oldGather({ accountId, organizationFingerprint, connectionId = "primary", ceiling }, readers) {
    const { readOliHistory, readOliCoverage, readCatalogSnapshot, loadCatalogPayload, readOliOperationalUnits, readOliSkuAsinResolution, readDirectory } = readers;
    const cov = await readOliCoverage({ organizationFingerprint, connectionId, accountId, sourceKey: "order-line-items" });
    const oliWindows = cov && cov.read === "ok" ? (cov.windows || []) : [];
    const { effectiveAsOf, coverageFrom } = RD.skuMovementProvenDates(oliWindows, ceiling);
    if (!effectiveAsOf) return { notReady: "not-ready", blockedBy: [{ sourceKey: "order-line-items", reason: "coverage-incomplete", accountId: S2(accountId), blocksSales: true }] };
    const from = monthBackStr(effectiveAsOf, 3);
    const pricedRows = await readOliHistory({ organizationFingerprint, connectionId, accountIds: [S2(accountId)], from, to: effectiveAsOf });
    const operationalRows = await oldReadOperationalUnits(readOliOperationalUnits, { organizationFingerprint, connectionId, accountId, from, to: effectiveAsOf });
    const resolver = await oldBuildAccountResolver({ readDirectory, readOliSkuAsinResolution }, { organizationFingerprint, connectionId, accountId });
    const historyRows = OSE.mergeOrderedOliHistory({ historyRows: Array.isArray(pricedRows) ? pricedRows : [], operationalRows, estimateRows: [], skuAsinResolver: resolver });
    const catRead = await readCatalogSnapshot({ organizationFingerprint, connectionId, sourceKey: "product-catalog", scopeKey: "__organization" });
    const catalogSnapshot = catRead && typeof catRead === "object" && "snapshot" in catRead ? catRead.snapshot : catRead;
    const catalogReadOk = !catRead || typeof catRead !== "object" || !("read" in catRead) || catRead.read === "ok";
    let catalogRows = [];
    if (catalogReadOk && catalogSnapshot && catalogSnapshot.object_path) {
      const payload = await loadCatalogPayload(catalogSnapshot.object_path);
      catalogRows = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.rows) ? payload.rows : []);
    }
    return { effectiveAsOf, coverageFrom, from, historyRows: Array.isArray(historyRows) ? historyRows : [], catalogRows, catalogSnapshot };
  }
  async function oldRederive({ accountId, brand = "ALL", organizationFingerprint, connectionId = "primary", ceiling }, readers) {
    const ev = await oldGather({ accountId, organizationFingerprint, connectionId, ceiling }, readers);
    if (ev.notReady) return ev;
    const payload = skuMovementPayload({ oliRows: ev.historyRows, catalogRows: ev.catalogRows, effectiveAsOf: ev.effectiveAsOf, brand, coverageFrom: ev.coverageFrom, accountId });
    return { payload, latestDataDate: ev.effectiveAsOf, latestCompletedDate: ev.effectiveAsOf, effectiveParams: { asOf: ev.effectiveAsOf, brand: S2(brand).trim() || "ALL" }, sourceRefreshedAt: RD.skuMovementRefreshedAt(ev) };
  }
  const w = makeWorld(); const store = makeStore(); const sb = makeSb(store, w);
  const base = () => ({ readOliHistory: sb.getSourceOliHistoryRows, readOliCoverage: sb.getSourceCoverageWindows, readCatalogSnapshot: sb.getSourceSnapshot, loadCatalogPayload: sb.getSourceSnapshotPayload, readOliOperationalUnits: sb.getSourceOliOperationalUnitRows, readOliSkuAsinResolution: sb.getOliSkuAsinResolutionRows, readDirectory: async () => [...DIRECTORY.values()] });
  const variants = [
    ["normal", {}], ["catalog read-failed", { readCatalogSnapshot: async () => ({ snapshot: null, read: "read-failed" }) }], ["catalog raw snapshot shape", { readCatalogSnapshot: async () => clone(store.catalogPointer) }],
    ["catalog pointer absent", { readCatalogSnapshot: async () => ({ snapshot: null, read: "ok" }) }], ["catalog null", { readCatalogSnapshot: async () => null }],
    ["opunits throws", { readOliOperationalUnits: async () => { throw new Error("x"); } }], ["opunits reader absent", { readOliOperationalUnits: undefined }], ["opunits non-array", { readOliOperationalUnits: async () => ({}) }],
    ["directory throws", { readDirectory: async () => { throw new Error("x"); } }], ["marketplace unknown", { readDirectory: async () => [] }], ["resolution throws", { readOliSkuAsinResolution: async () => { throw new Error("x"); } }],
    ["no coverage", { readOliCoverage: async () => ({ windows: [], read: "ok" }) }], ["coverage read-failed", { readOliCoverage: async () => ({ windows: [], read: "read-failed" }) }],
    ["catalog payload empty", { loadCatalogPayload: async () => ({ rows: [] }) }], ["catalog payload empty array", { loadCatalogPayload: async () => [] }],
  ];
  let same = 0; const differ = [];
  for (const [label, over] of variants) {
    for (const brand of ["ALL", "Acme", "Zeta", " Caruso Italy "]) {
      const readers = { ...base(), ...over };
      const a = await RD.rederiveSkuMovement({ accountId: A, brand, organizationFingerprint: ORG, ceiling: EPOCH }, readers);
      const b = await oldRederive({ accountId: A, brand, organizationFingerprint: ORG, ceiling: EPOCH }, readers);
      const ga = await RD.gatherSkuMovementEvidence({ accountId: A, organizationFingerprint: ORG, ceiling: EPOCH }, readers);
      const gb = await oldGather({ accountId: A, organizationFingerprint: ORG, ceiling: EPOCH }, readers);
      if (JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(ga) === JSON.stringify(gb)) same += 1; else differ.push(label + "/" + brand);
    }
  }
  ok(`D1 NON-strict rederiveSkuMovement + gatherSkuMovementEvidence are BYTE-IDENTICAL to the pre-WP6 implementation over ${variants.length * 4} fixture variants (incl. every fail-soft branch)`, same === variants.length * 4 && differ.length === 0);
  const throwsBoth = async (over) => {
    const readers = { ...base(), ...over };
    let e1 = null; let e2 = null;
    try { await RD.rederiveSkuMovement({ accountId: A, organizationFingerprint: ORG, ceiling: EPOCH }, readers); } catch (e) { e1 = e.message; }
    try { await oldRederive({ accountId: A, organizationFingerprint: ORG, ceiling: EPOCH }, readers); } catch (e) { e2 = e.message; }
    return e1 !== null && e1 === e2;
  };
  ok("D1 ... and a throwing history / coverage / catalog read still PROPAGATES exactly as before in non-strict mode", await throwsBoth({ readOliHistory: async () => { throw new Error("OLI_HISTORY_ROW_LIMIT_EXCEEDED"); } }) && await throwsBoth({ readOliCoverage: async () => { throw new Error("cov"); } }) && await throwsBoth({ loadCatalogPayload: async () => { throw new Error("SOURCE_SNAPSHOT_PAYLOAD_MISMATCH"); } }));
  const strictCase = async (over) => (await RD.rederiveSkuMovement({ accountId: A, brand: "ALL", organizationFingerprint: ORG, ceiling: EPOCH }, { ...base(), ...over }, { strict: true })).notReady;
  const expect = [
    [{ readOliCoverage: async () => ({ windows: [], read: "read-failed" }) }, "evidence-read-failed:coverage"], [{ readOliCoverage: async () => { throw new Error("x"); } }, "evidence-read-failed:coverage"],
    [{ readOliHistory: async () => { throw new Error("x"); } }, "evidence-read-failed:oli"], [{ readOliHistory: async () => null }, "evidence-read-failed:oli"],
    [{ readOliOperationalUnits: async () => { throw new Error("x"); } }, "evidence-read-failed:opunits"], [{ readOliOperationalUnits: undefined }, "evidence-read-failed:opunits"], [{ readOliOperationalUnits: async () => ({}) }, "evidence-read-failed:opunits"],
    [{ readDirectory: async () => { throw new Error("x"); } }, "evidence-read-failed:resolver"], [{ readDirectory: async () => [] }, "evidence-read-failed:resolver"], [{ readOliSkuAsinResolution: async () => { throw new Error("x"); } }, "evidence-read-failed:resolver"], [{ readOliSkuAsinResolution: undefined }, "evidence-read-failed:resolver"],
    [{ readCatalogSnapshot: async () => ({ snapshot: null, read: "read-failed" }) }, "evidence-read-failed:catalog"], [{ readCatalogSnapshot: async () => { throw new Error("x"); } }, "evidence-read-failed:catalog"], [{ readCatalogSnapshot: async () => null }, "evidence-read-failed:catalog"],
    [{ loadCatalogPayload: async () => { throw new Error("x"); } }, "evidence-read-failed:catalog"], [{ loadCatalogPayload: async () => ({ nope: 1 }) }, "evidence-read-failed:catalog"],
    [{ readCatalogSnapshot: async () => ({ snapshot: null, read: "ok" }) }, "catalog-missing"], [{ readOliCoverage: async () => ({ windows: [], read: "ok" }) }, "not-ready"],
    [{ loadCatalogPayload: async () => ({ rows: [] }) }, "catalog-empty"], [{ loadCatalogPayload: async () => [] }, "catalog-empty"],
  ];
  const got = [];
  for (const [over, want] of expect) got.push([await strictCase(over), want]);
  ok(`D2 STRICT: every one of ${expect.length} failed-read cases returns its TYPED notReady (coverage / oli / opunits / resolver / catalog / catalog-missing / catalog-empty) -- never a degraded payload`, got.every(([g, want]) => g === want));
  const strictOk = await RD.rederiveSkuMovement({ accountId: A, brand: "Acme", organizationFingerprint: ORG, ceiling: EPOCH }, base(), { strict: true });
  const softOk = await RD.rederiveSkuMovement({ accountId: A, brand: "Acme", organizationFingerprint: ORG, ceiling: EPOCH }, base());
  ok("D3 with every read healthy the STRICT output equals the non-strict output (strictness only refuses; it never changes content)", JSON.stringify(strictOk) === JSON.stringify(softOk));
  const ev = await RD.loadSkuMovementAccountEvidence({ accountId: A, organizationFingerprint: ORG, ceiling: EPOCH }, base(), { strict: true });
  const g = await RD.gatherSkuMovementEvidence({ accountId: A, organizationFingerprint: ORG, ceiling: EPOCH }, base(), { strict: true });
  ok("D4 loadSkuMovementAccountEvidence = the gathered evidence + accountId + ceiling + the coverage windows it read; buildSkuMovementUnit(evidence, brand) == rederiveSkuMovement", JSON.stringify({ ...ev, accountId: undefined, ceiling: undefined, coverageWindows: undefined }) === JSON.stringify({ ...g, accountId: undefined, ceiling: undefined, coverageWindows: undefined })
    && ev.accountId === A && ev.ceiling === EPOCH && JSON.stringify(ev.coverageWindows) === JSON.stringify([{ from: "2026-01-01", to: EFF }])
    && JSON.stringify(RD.buildSkuMovementUnit(ev, "Acme")) === JSON.stringify(softOk) && JSON.stringify(RD.buildSkuMovementUnit(ev, "ALL", { accountId: A })) === JSON.stringify(await RD.rederiveSkuMovement({ accountId: A, organizationFingerprint: ORG, ceiling: EPOCH }, base())));
}

// =====================================================================================================================
// B. the retired manual backfill
// =====================================================================================================================
{
  const file = path.join(ROOT, "scripts", "release", "backfill-sku-movement.mjs");
  const raw = readFileSync(file, "utf8");
  const body = raw.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n"); // the CODE (the header comment explains the retirement)
  // NEVER spawned (WP14): a CLI entrypoint must not be executed by a test -- were this stub ever reverted to the real
  // backfill, a spawn would load .env.local and write PRODUCTION. It is evaluated instead in a vm sandbox with NO module
  // loader (an import declaration is a SyntaxError, import() throws), NO env (process.env is the BACKFILL_APPLY=1 attack
  // env only) and NO I/O; its process.exit is captured.
  const stderr = []; let exitCode = null, threw = null;
  const sandbox = vm.createContext({ console: { error: (...a) => stderr.push(a.join(" ")), log: () => {} }, process: { env: { BACKFILL_APPLY: "1" }, exit: (c) => { exitCode = c; throw Object.assign(new Error("__exit__"), { __exit: true }); } } });
  try { new vm.Script(raw, { filename: file }).runInContext(sandbox, { timeout: 2000 }); } catch (e) { threw = e; }
  const r = { status: threw && threw.__exit === true ? exitCode : null, stderr: stderr.join("\n") };
  ok("B1 backfill-sku-movement.mjs REFUSES to run (exit 2) even with BACKFILL_APPLY=1, naming the fenced route CLI (sandboxed, never spawned)", r.status === 2 && /STOP SKU_MOVEMENT_BACKFILL_RETIRED/.test(r.stderr) && r.stderr.includes("publication-route-reconcile.mjs --route=sku-movement"));
  ok("B1 ... it imports NOTHING (no env file, no Supabase, no TLS override) -- structurally zero writes", !/^\s*import\s/m.test(body) && !/await import\(/.test(body) && !/NODE_TLS_REJECT_UNAUTHORIZED\s*=/.test(body) && !/saveReportSnapshot|readFileSync|process\.env/.test(body) && /^[\x00-\x7f]*$/.test(raw) && !raw.includes("\r"));
}

// =====================================================================================================================
// C. the derivation-code identity (WP14 cross-cutting)
// =====================================================================================================================
{
  const WSRC = src("lib/server/recovery/routes/sku-movement.route.js");
  ok("C1 the sm1 evidence token binds the DERIVATION-CODE identity (the live version + SKU_MOVEMENT_DERIVE_REV) as its first part after 'sm1', so a derivation change re-arms every account (a dormant one included); the serve-side sms2 token does not include it",
    Object.isFrozen(W.SKU_MOVEMENT_CODE_IDENTITY) && W.SKU_MOVEMENT_CODE_IDENTITY.v === C.SKU_MOVEMENT_LIVE_VERSION && Number.isInteger(W.SKU_MOVEMENT_DERIVE_REV) && W.SKU_MOVEMENT_DERIVE_REV >= 1
    && W.SKU_MOVEMENT_CODE_IDENTITY.rev === String(W.SKU_MOVEMENT_DERIVE_REV)
    && /computeSkuEvidenceToken\(\[\s*"sm1", SKU_MOVEMENT_CODE_IDENTITY, effectiveAsOf, coverageFrom,/.test(WSRC)
    && !/DERIVE_REV|CODE_IDENTITY/.test(src("lib/server/reports/sku-movement-evidence.js")));
}

ok("Z zero network across the whole suite (zero DataDoe, zero Supabase)", net.calls.length === 0);
out(`sku-movement-route: ${passed} passed`);
