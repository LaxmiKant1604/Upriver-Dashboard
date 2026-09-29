// Publication recovery WP5 -- the returns-v3 recovery ROUTE (lib/server/recovery/routes/returns-v3.route.js worker side
// + lib/server/sync/routes/returns-v3.release.js CLI side), the STRICT returns evidence mode of
// lib/server/reports/returns-publish.js, and the golive step-7 switch (scripts/release/returns-leakage-golive.mjs).
//
// Proves, fully offline (the REAL route modules, the REAL generic release + reconciler adapter, the REAL saved-data
// reconciler two-phase core, the REAL four-gate publisher composition with build-time overrides, the REAL shared live
// read-back and serve selector, the REAL gatherReturnsEvidence / buildReturnsAdvancedPayload; an in-memory lineage world
// + an in-memory durable store answering both the route's METADATA SQL (fake read-only pg) and the REST readers; the
// global fetch is a refusing stub and its call count is asserted 0 -- ZERO DataDoe / Supabase / network):
//   R0 the module contracts: worker + CLI modules + their pair validate against the REAL live contracts / derivations;
//      the declared route fields; the runtime validates; build fails closed on missing deps.
//   R1 normal publish, then a verify-exact PUBLICATION_NOT_REQUIRED with the served-row check (+ the worker compose
//      token == the CLI's evaluated token == the TARGETS v2 tok == the stored live evidence token).
//   R2 OLI-only advance: the token changes and it re-publishes.
//   R3 catalog read failure: deferred with zero writes, never an empty-catalog payload.
//   R4 the v3 validator rejects a v2 payload (directly and through the release).
//   R5 saved evidence older than 168 h: verified plus a 'source-stale-manual' alert, zero exports.
//   R6 never-regress on `to` (scan, prepare and the publish-time re-check).
//   R7 missing evidence gives a typed deferral (scan level + every strict read).
//   R8 non-strict gatherReturnsEvidence is BYTE-IDENTICAL to the pre-WP5 function (verbatim copy below) for the serve.
//   R9 golive static: step 7 calls the route; no TLS-verification override; pg via verifiedPgConfig; the acquisition
//      step sequence is byte-identical (golden digests of the pre-WP5 file); the step-7 planner + RESULT parser.
//   R10 static DDL: every column the evidence SQL names exists in the migration DDL (source_oli_operational_units uses
//      updated_at, which the 20260901 DDL declares); returns-advanced.js never imports datadoe.js (isDateStr parity).
//   Verifier findings (WP5 review):
//   R11 P2-1 a same-count paged read with one duplicate + one missing row is refused (strict gather + resolveBundle:
//       'evidence-inconsistent:<returns|settlement>-duplicate'); the reader order itself is proven total by
//       scripts/returns-history-reader-order.test.js.
//   R12 P3-1 an in-place UPDATE (touch trigger -> updated_at) moves the L1 token (worker == CLI) and re-publishes.
//   R13 P3-2 the proven OLI covered_to is window-scoped (a later window never churns the manifest) + cross-checked.
//   R14 P3-3 a validated catalog with ZERO rows -> strict 'catalog-missing'.
//   R15 P3-5 an array directory applies buildDurableDirectory's duplicate / prefixed-id exclusions (worker == CLI).
//   R16 P3-4 / P3-6 golive: the pg client is closed before the route spawn (+ 'error' listener); out-of-scope accounts
//       raise a typed RETURNS_ALERT line + GITHUB_OUTPUT returns_out_of_scope=<n>.
// 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync, readFileSync, readdirSync } from "node:fs";
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
const { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } = await import("../lib/server/sync/report-publisher.js");
const { REPORT_DERIVATIONS } = await import("../lib/server/sync/report-derivation.js");
const { paramsHashFor } = await import("../lib/server/report-store.js");
const B = await import("../lib/server/sync/publication-binding.js");
const SDR = await import("../lib/server/sync/saved-data-reconciler.js");
const RC = await import("../lib/server/recovery/route-contract.js");
const SEL = await import("../lib/server/recovery/serve-selectors.js");
const TGT = await import("../lib/server/sync/reconcile-targets-output.js");
const OSE = await import("../lib/server/sync/oli-sales-estimate.js");
const RSR = await import("../lib/server/sync/returns-source-refresh.js");
const RA = await import("../lib/server/reports/returns-advanced.js");
const RP = await import("../lib/server/reports/returns-publish.js");
const SOURCES = await import("../lib/server/reports/sources.js");
const { accountInScope } = await import("../lib/server/sync/scheduler-scope.js");
const WORKER_MOD = await import("../lib/server/recovery/routes/returns-v3.route.js");
const CLI_MOD = await import("../lib/server/sync/routes/returns-v3.release.js");

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; out("  ok  " + name); };
const S = (v) => (v == null ? "" : String(v));
const sha = (v) => createHash("sha256").update(String(v)).digest("hex");

const RL = "returns-leakage-v3";
const ACC = "IN1";
const ACC2 = "IN2";
const ORG = "org-fp-1";
const EPOCH = "2026-09-24";
const LD = "2026-09-23"; // the fixtures' latestDataDate = max(return date, nonblank-ASIN settlement date)
const REGION = "india";
const RS = { NR: "PUBLICATION_NOT_REQUIRED", ST: "STALE", RV: "READBACK_VERIFIED", DD: "DEFERRED_DEPENDENCY", DP: "DEFERRED_PROVENANCE", FD: "FAILED_DERIVE" };
const WORKER = WORKER_MOD.default;
const CLI = CLI_MOD.default;
const liveContracts = SCHEDULER_LIVE_SNAPSHOT_CONTRACTS;
const liveHash = (to = LD) => paramsHashFor("returns-leakage-v3", { to });

// =====================================================================================================================
// The faithful in-memory lineage world (the SAME semantics as scripts/route-publication-release.test.js): sync_cycles
// open=pending -> claim=running -> finalize, an insert-if-absent sync_report_jobs with the derive lease + reconcile, the
// report_snapshots shadow CAS and the FENCED live CAS, driven by the REAL four-gate publisher composition.
// =====================================================================================================================
function makeWorld({ key = RL, promoted = [key], rollout = [ACC, ACC2], discovered = [ACC, ACC2] } = {}) {
  const cycles = new Map(); const jobs = []; const snaps = new Map(); const storage = new Map();
  const n = { cycleCreate: 0, jobInsert: 0, claimLease: 0, shadowCas: 0, shadowWrite: 0, reconcile: 0, finalize: 0, liveCas: 0, liveWrite: 0, preflight: 0, publish: 0, snapshotUpdate: 0 };
  let seq = 0; let clock = Date.UTC(2026, 8, 24, 6, 0, 0);
  const iso = (ms) => new Date(ms).toISOString();
  const w = { cycles, jobs, snaps, storage, n, promoted: [...promoted], rollout: [...rollout], discovered: [...discovered] };
  w.now = () => clock;
  w.tick = (ms = 60000) => { clock += ms; return clock; };
  w.fence = { ownerToken: "op-owner", generation: 7 };
  w.lease = { ownerToken: "op-owner", generation: 7 };
  w.leaseOk = true;
  const cycleById = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  const jobOf = (cycleId, rk, a) => jobs.find((j) => j.cycle_id === cycleId && j.report_key === rk && j.account_id === a) || null;
  const snapKey = (rk, a, h) => rk + "|" + a + "|" + h;
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
    snaps.set(k, { id: "snap-" + (++seq), report_key: reportKey, account_id: accountId, params_hash: paramsHash, params: JSON.parse(JSON.stringify(params)), payload: JSON.parse(JSON.stringify(payload)), payload_storage_path: null, source_refreshed_at: sourceRefreshedAt, updated_at: iso(w.tick(1000)) });
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
  w.readSnapshot = async ({ reportKey, accountId, paramsHash }) => { const r = snaps.get(snapKey(reportKey, accountId, paramsHash)); return r ? JSON.parse(JSON.stringify(r)) : null; };
  w.loadStoragePayload = async (p) => (storage.has(p) ? JSON.parse(JSON.stringify(storage.get(p))) : null);
  const byAcct = (rk, a) => [...snaps.values()].filter((r) => r.report_key === rk && r.account_id === a);
  const newest = (rows) => rows.sort((x, y) => (x.updated_at < y.updated_at ? 1 : x.updated_at > y.updated_at ? -1 : 0))[0] || null;
  w.readers = {
    getReportSnapshot: w.readSnapshot,
    getLatestReportSnapshotForScope: async ({ reportKey, accountId, reportVersion = null, scope = {} }) => { const r = newest(byAcct(reportKey, accountId).filter((x) => (reportVersion == null || S(x.params && x.params.reportVersion) === S(reportVersion)) && Object.entries(scope || {}).every(([k, v]) => v == null || S(x.params && x.params[k]) === S(v)))); return r ? JSON.parse(JSON.stringify(r)) : null; },
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
    snaps.set(k, { id: "live-" + (++seq), report_key: reportKey, account_id: accountId, params_hash: paramsHash, params: JSON.parse(JSON.stringify(params)), payload: JSON.parse(JSON.stringify(payload)), payload_storage_path: null, source_refreshed_at: sourceRefreshedAt, updated_at: iso(w.tick(1000)) });
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
      publisher = {
        preflight: async (rk, a) => { n.preflight += 1; return real.preflight(rk, a); },
        publish: async (rk, a) => { n.publish += 1; return real.publish(rk, a); },
      };
    }
    return publisher;
  };
  w.verifyLease = async () => (w.leaseOk ? { ok: true } : { ok: false, reason: "lease-expired" });
  w.readbackLive = REL.buildRouteLiveReadback({ getReportSnapshot: w.readSnapshot, loadStoragePayload: w.loadStoragePayload, liveContracts, reportDerivations: REPORT_DERIVATIONS, computeHash: paramsHashFor });
  w.writes = () => n.cycleCreate + n.jobInsert + n.shadowWrite + n.reconcile + n.finalize + n.liveWrite;
  w.liveRow = (acct = ACC, to = LD) => snaps.get("returns-leakage|" + acct + "|" + liveHash(to)) || null;
  return w;
}

// =====================================================================================================================
// The in-memory DURABLE store: the route's METADATA SQL (a fake read-only pg that evaluates each declared query over the
// rows) and the REST readers gatherReturnsEvidence uses (projected exactly like the supabase.js select lists).
// =====================================================================================================================
const utc = (t) => (t == null ? null : new Date(t).toISOString().replace(/\.(\d{3})Z$/, ".$1000Z")); // to_char .US"Z"
const maxS = (xs) => xs.filter((x) => x != null && x !== "").sort().slice(-1)[0] ?? null;
const RET_COLS = "account_id,seller_or_vendor_id,marketplace_country_code,return_date,sku,child_asin,amazon_return_reason,fulfillment_channel,request_status,label_payer,detailed_disposition,return_count,fbm_refunded_amount,fbm_seller_label_cost,cogs_total_value,source_request_hash,refreshed_at".split(",");
const SET_COLS = "account_id,seller_or_vendor_id,marketplace_country_code,settlement_date,sku,child_asin,currency,settlement_type,quantity,item_price,refunded_amount,refund_tax,refunded_referral_fee,refund_commission,refund_restocking_fee,fba_customer_return_per_unit_fee,fba_customer_return_fee,customer_return_hrr_unit_fee,cogs_total_value,refund_event_count,source_request_hash,refreshed_at".split(",");
const OLI_COLS = "account_id,seller_or_vendor_id,sale_date,sku,child_asin,currency,sales_amount,units,source_request_hash".split(",");
const OPU_COLS = "account_id,seller_or_vendor_id,sale_date,sku,child_asin,currency,priced_units,priced_sales,explicit_zero_units,pending_units,cancelled_units,source_request_hash".split(",");
const pick = (r, cols) => Object.fromEntries(cols.map((c) => [c, r[c] === undefined ? null : r[c]]));
const own = { organization_fingerprint: ORG, connection_id: "primary" };

function makeStore() {
  const catalogRows = [{ child_asin: "B0A", product_name: "Widget A", product_brand: "Acme" }, { child_asin: "B0B", product_name: "Widget B", product_brand: "Acme" }];
  const csha = sha(JSON.stringify(catalogRows));
  return {
    returns: [], settlement: [], oli: [], coverage: [], opunits: [],
    catalog: { pointer: { ...own, source_key: "product-catalog", scope_key: "__organization", object_path: "source-snapshots/org/product-catalog/" + csha + ".json", payload_sha: csha, row_count: 2, validated_at: "2026-09-24T00:30:00.000Z" }, payload: { rows: catalogRows } },
    catalogRead: "ok", catalogThrows: false, loaderThrows: false, returnsThrows: false, opunitsThrows: false, coverageRead: "ok", pgThrows: false,
    pg: 0, rest: 0,
  };
}
function seedAccount(st, acct, { refreshed = "2026-09-24T02:00:00.000Z", covTo = EPOCH, covAt = "2026-09-24T01:00:00.000Z" } = {}) {
  const created = new Date(Date.parse(refreshed) + 5000).toISOString();
  const ret = (d, asin, sku, reason, count) => ({ ...own, account_id: acct, seller_or_vendor_id: "raw-" + acct, marketplace_country_code: "IN", return_date: d, sku, child_asin: asin, amazon_return_reason: reason, fulfillment_channel: "AFN", request_status: "Approved", label_payer: "Amazon", detailed_disposition: "SELLABLE", return_count: count, fbm_refunded_amount: 0, fbm_seller_label_cost: 0, cogs_total_value: 0, source_request_hash: "h-ret", refreshed_at: refreshed, created_at: created, updated_at: created });
  const set = (d, asin, sku, type, amt) => ({ ...own, account_id: acct, seller_or_vendor_id: "raw-" + acct, marketplace_country_code: "IN", settlement_date: d, sku, child_asin: asin, currency: "INR", settlement_type: type, quantity: 1, item_price: type === "ORDER" ? amt : 0, refunded_amount: type === "REFUND" ? -amt : 0, refund_tax: 0, refunded_referral_fee: 0, refund_commission: 0, refund_restocking_fee: 0, fba_customer_return_per_unit_fee: 0, fba_customer_return_fee: 0, customer_return_hrr_unit_fee: 0, cogs_total_value: 0, refund_event_count: type === "REFUND" ? 1 : 0, source_request_hash: "h-set", refreshed_at: refreshed, created_at: created, updated_at: created });
  st.returns.push(ret("2026-09-20", "B0A", "SKU-A", "DEFECTIVE", 1), ret(LD, "B0B", "SKU-B", "NOT_AS_DESCRIBED", 2), ret(LD, "B0B", "SKU-B", "UNWANTED_ITEM", 1));
  st.settlement.push(set("2026-09-18", "B0A", "SKU-A", "ORDER", 500), set("2026-09-21", "B0A", "SKU-A", "REFUND", 500), set("2026-09-22", "B0B", "SKU-B", "REFUND", 300), set(LD, "", "SKU-X", "OTHER", 10));
  st.oli.push({ ...own, account_id: acct, seller_or_vendor_id: "raw-" + acct, sale_date: "2026-09-10", sku: "SKU-A", child_asin: "B0A", currency: "INR", sales_amount: 2500, units: 5, source_request_hash: "h-oli" },
    { ...own, account_id: acct, seller_or_vendor_id: "raw-" + acct, sale_date: "2026-09-15", sku: "SKU-B", child_asin: "B0B", currency: "INR", sales_amount: 900, units: 3, source_request_hash: "h-oli" });
  st.coverage.push({ ...own, account_id: acct, source_key: "order-line-items", status: "succeeded", covered_from: "2025-01-01", covered_to: covTo, source_refreshed_at: covAt, updated_at: covAt });
  st.opunits.push({ ...own, account_id: acct, seller_or_vendor_id: "raw-" + acct, sale_date: "2026-09-12", sku: "SKU-A", child_asin: "B0A", currency: "INR", priced_units: 0, priced_sales: null, explicit_zero_units: 1, pending_units: 0, cancelled_units: 0, source_request_hash: "h-op", created_at: covAt, updated_at: covAt });
}
function makeSb(st, w) {
  const inWin = (r, field, { organizationFingerprint, connectionId = "primary", accountIds, from, to }) => r.organization_fingerprint === organizationFingerprint && r.connection_id === connectionId && (!Array.isArray(accountIds) || accountIds.includes(r.account_id)) && r[field] >= from && r[field] <= to;
  const rest = () => { st.rest += 1; };
  return {
    getReturnsHistoryRows: async (a) => { rest(); if (st.returnsThrows) throw new Error("returns read failed"); return st.returns.filter((r) => inWin(r, "return_date", a)).map((r) => pick(r, RET_COLS)); },
    getSettlementHistoryRows: async (a) => { rest(); return st.settlement.filter((r) => inWin(r, "settlement_date", a)).map((r) => pick(r, SET_COLS)); },
    getSourceOliHistoryRows: async (a) => { rest(); return st.oli.filter((r) => inWin(r, "sale_date", a) && r.sales_amount > 0).map((r) => pick(r, OLI_COLS)); },
    getSourceCoverageWindows: async ({ organizationFingerprint, connectionId = "primary", accountId, sourceKey }) => {
      rest();
      if (st.coverageRead !== "ok") return { windows: [], read: st.coverageRead, error: "X" };
      return { windows: st.coverage.filter((c) => c.organization_fingerprint === organizationFingerprint && c.connection_id === connectionId && c.account_id === accountId && c.source_key === sourceKey && c.status === "succeeded").sort((x, y) => (x.covered_from < y.covered_from ? -1 : 1)).map((c) => ({ from: c.covered_from, to: c.covered_to })), read: "ok", error: null };
    },
    getSourceOliOperationalUnitRows: async (a) => { rest(); if (st.opunitsThrows) throw new Error("opunits read failed"); return st.opunits.filter((r) => inWin(r, "sale_date", a) && (!a.additiveOnly || r.explicit_zero_units > 0 || r.pending_units > 0)).map((r) => pick(r, OPU_COLS)); },
    getSourceSnapshot: async ({ organizationFingerprint, connectionId = "primary" }) => {
      rest();
      if (st.catalogThrows) throw new Error("catalog read threw");
      if (st.catalogRead !== "ok") return { snapshot: null, read: st.catalogRead, error: "SOURCE_SNAPSHOT_READ_FAILED" };
      const p = st.catalog.pointer;
      return { snapshot: p && p.organization_fingerprint === organizationFingerprint && p.connection_id === connectionId ? { ...p } : null, read: "ok", error: null };
    },
    getSourceSnapshotPayload: async () => { rest(); if (st.loaderThrows) throw new Error("SOURCE_SNAPSHOT_PAYLOAD_MISMATCH"); return JSON.parse(JSON.stringify(st.catalog.payload)); },
    getOliSkuAsinResolutionRows: async () => { rest(); return []; },
    getLatestReportSnapshotForScope: (a) => w.readers.getLatestReportSnapshotForScope(a),
  };
}
// The fake READ-ONLY pg: every statement must be one of the route's declared read-only SELECTs; it evaluates that query's
// semantics over the store (the SAME aggregates the SQL text states).
function makePg(st) {
  const byText = new Map(WORKER_MOD.RETURNS_V3_EVIDENCE_SQL.map((q) => [q.text, q.name]));
  const calls = [];
  const fn = async (text, values) => {
    if (!RC.isReadOnlyEvidenceSql(text)) throw new Error("pgReadOnly refuses a non-read-only statement");
    const name = byText.get(text);
    if (!name) throw new Error("unexpected SQL");
    calls.push(name); st.pg += 1;
    if (st.pgThrows) throw new Error("pg unavailable");
    if (name === "catalog") { const [org, conn] = values; const p = st.catalog.pointer; return p && p.organization_fingerprint === org && p.connection_id === conn ? [{ payload_sha: p.payload_sha, validated: utc(p.validated_at) }] : []; }
    const [org, conn, ids, from, to] = values;
    const mine = (r) => r.organization_fingerprint === org && r.connection_id === conn && ids.includes(r.account_id);
    const group = (rows) => { const m = new Map(); for (const r of rows) { if (!m.has(r.account_id)) m.set(r.account_id, []); m.get(r.account_id).push(r); } return [...m]; };
    if (name === "returns") return group(st.returns.filter((r) => mine(r) && r.return_date >= from && r.return_date <= to)).map(([a, rs]) => ({ account_id: a, n: rs.length, refreshed: utc(maxS(rs.map((r) => r.refreshed_at))), created: utc(maxS(rs.map((r) => r.created_at))), updated: utc(maxS(rs.map((r) => r.updated_at))), max_date: maxS(rs.map((r) => r.return_date)) }));
    if (name === "settlement") return group(st.settlement.filter((r) => mine(r) && r.settlement_date >= from && r.settlement_date <= to)).map(([a, rs]) => ({ account_id: a, n: rs.length, refreshed: utc(maxS(rs.map((r) => r.refreshed_at))), created: utc(maxS(rs.map((r) => r.created_at))), updated: utc(maxS(rs.map((r) => r.updated_at))), max_date: maxS(rs.map((r) => r.settlement_date)), max_asin_date: maxS(rs.filter((r) => r.child_asin.trim() !== "").map((r) => r.settlement_date)) }));
    if (name === "oli") return group(st.coverage.filter((c) => mine(c) && c.source_key === "order-line-items" && c.status === "succeeded" && c.covered_to >= from && c.covered_from <= to)).map(([a, cs]) => ({ account_id: a, n: cs.length, covered_to: maxS(cs.map((c) => c.covered_to)), digest: createHash("md5").update(cs.slice().sort((x, y) => (x.covered_from + x.covered_to < y.covered_from + y.covered_to ? -1 : 1)).map((c) => c.covered_from + ".." + c.covered_to + "@" + (utc(c.source_refreshed_at) ?? "-") + "@" + utc(c.updated_at)).join(",")).digest("hex") }));
    if (name === "opunits") return group(st.opunits.filter((r) => mine(r) && r.sale_date >= from && r.sale_date <= to)).map(([a, rs]) => ({ account_id: a, n: rs.length, updated: utc(maxS(rs.map((r) => r.updated_at))) }));
    throw new Error("unhandled query " + name);
  };
  fn.calls = calls;
  return fn;
}
const directoryOf = (ids) => REL.buildDurableDirectory({ rows: ids.map((accountId) => ({ accountId, country: "IN" })), resolveRawSellerId: (id) => "raw-" + id, normalizeMarketplace: OSE.normalizeMarketplace }).directory;

// The harness: the REAL CLI runtime (build) + the REAL generic release + the REAL adapter/reconciler over the world.
function harness({ scope = [ACC], seed = [ACC], gatherEvidence = null, runtimeNow = null } = {}) {
  const w = makeWorld();
  const st = makeStore();
  for (const a of seed) seedAccount(st, a);
  const sb = makeSb(st, w);
  const pgReadOnly = makePg(st);
  const directory = directoryOf([ACC, ACC2]);
  const h = { w, st, sb, pgReadOnly, directory, scope: [...scope], controls: { opened: [], closed: 0 }, nowMs: runtimeNow == null ? w.now() : runtimeNow, logs: [] };
  const deps = {
    bucket: REGION, epoch: EPOCH, directory, orgFp: ORG, connectionId: "primary", sb, pgReadOnly, selectors: SEL,
    computeHash: paramsHashFor, liveContracts, reportDerivations: REPORT_DERIVATIONS, normalizeMarketplace: OSE.normalizeMarketplace,
    now: () => h.nowMs, strict: true, log: (m) => h.logs.push(m), ...(gatherEvidence ? { gatherEvidence } : {}),
  };
  h.runtime = CLI.build(Object.freeze(deps));
  h.release = REL.buildRoutePublicationRelease({
    route: CLI, runtime: h.runtime,
    deps: {
      openCycle: w.openCycle, getCycleByBucketDate: w.getCycleByBucketDate, claimCycle: w.claimCycle, readCycle: w.readCycle,
      upsertReportJob: w.upsertReportJob, claimLease: w.claimLease, saveShadow: w.saveShadow, reconcileSuccess: w.reconcileSuccess, finalizeCycle: w.finalizeCycle,
      readLatestJob: w.readLatestJob, readSnapshot: w.readSnapshot, loadStoragePayload: w.loadStoragePayload,
      publisherFor: w.publisherFor, verifyLease: w.verifyLease, readbackLive: w.readbackLive,
      liveContracts, reportDerivations: REPORT_DERIVATIONS, computeHash: paramsHashFor,
      evidenceContext: { directory, organizationFingerprint: ORG, connectionId: "primary" },
      publishSnapshotUpdate: async () => { w.n.snapshotUpdate += 1; }, now: () => w.now(),
    },
  });
  h.reconciler = ({ verifyExact = false } = {}) => SDR.buildSavedDataReconciler({
    resolveOrg: async () => ({ organizationFingerprint: ORG, connectionId: "primary" }),
    bucketAccounts: async () => h.scope.map((accountId) => ({ accountId })),
    adapter: REL.buildRouteReconcileAdapter({ route: CLI, runtime: h.runtime, bucket: REGION, directory, liveContracts, readLatestJob: w.readLatestJob, verifyExact }),
    readLatestReportJob: ({ reportKey, accountId }) => w.readLatestJob(reportKey, accountId),
    readShadowSnapshot: (a) => w.readSnapshot(a), readLiveSnapshot: (a) => w.readSnapshot(a), loadStoragePayload: w.loadStoragePayload,
    verifyLiveReadback: w.readbackLive, liveContracts, computeHash: paramsHashFor, reportDerivations: REPORT_DERIVATIONS,
    runPrepareForUnit: (a) => h.release.prepareForUnit(a), runPublishForUnit: (a) => h.release.publishForUnit(a),
    openControls: async (x) => { h.controls.opened.push(x); return { ok: true }; }, closeControls: async () => { h.controls.closed += 1; return { ok: true }; },
    reportKeys: [RL], family: "returns-v3",
  });
  h.run = (opts = {}) => h.reconciler(opts).run({ bucket: REGION, requestedAsOf: EPOCH, mode: "periodic", dryRun: opts.dryRun === true });
  h.unit = (summary, acct = ACC) => summary.perAccount.find((r) => r.accountId === acct).units[0].reports[RL];
  // The worker's tier-1 compose over the SAME store (the metadata SQL through the same fake pg).
  h.workerCompose = async (ids = h.scope, now = () => h.nowMs) => {
    const ctx = { epoch: EPOCH, accountIds: ids, organizationFingerprint: ORG, connectionId: "primary" };
    const rowsByName = {};
    for (const q of WORKER.evidence.sql) rowsByName[q.name] = await pgReadOnly(q.text, q.params(ctx));
    return WORKER.evidence.compose(rowsByName, { epoch: EPOCH, now, directory, accountIds: ids });
  };
  h.unitOf = (acct = ACC) => ({ unitKey: "-", targetId: acct, liveAccountId: acct, ownerAccountIds: [acct], targetAsOf: LD, reportKeys: [RL] });
  return h;
}
// The REST readers gatherReturnsEvidence takes, over a store (for the direct strict / parity tests).
const readersOf = (sb, directory) => ({
  readReturnsHistory: sb.getReturnsHistoryRows, readSettlementHistory: sb.getSettlementHistoryRows,
  readOliHistory: sb.getSourceOliHistoryRows, readOliCoverage: sb.getSourceCoverageWindows,
  readOliOperationalUnits: sb.getSourceOliOperationalUnitRows, readCatalogSnapshot: sb.getSourceSnapshot,
  loadCatalogPayload: sb.getSourceSnapshotPayload, readOliSkuAsinResolution: sb.getOliSkuAsinResolutionRows,
  readDirectory: async () => [...directory.values()].map((e) => ({ accountId: e.accountId, country: e.country })),
});
const gatherArgs = (acct = ACC) => ({ accountId: acct, organizationFingerprint: ORG, connectionId: "primary", asOf: EPOCH });

// =====================================================================================================================
// R0. module contracts.
// =====================================================================================================================
{
  const worker = RC.validateRouteModule(WORKER_MOD, { side: "worker" });
  const cli = RC.validateRouteModule(CLI_MOD, { side: "cli", liveContracts, reportDerivations: REPORT_DERIVATIONS });
  ok("R0 the worker module validates side:'worker', the CLI module side:'cli' against the REAL live contracts + derivations, and the pair validates", worker.id === "returns-v3" && cli.id === "returns-v3" && RC.validateRoutePair(worker, cli, { liveContracts }) === true);
  ok("R0 the worker declaration: route-cli via the generic CLI, publisher key returns-leakage-v3, live key returns-leakage, grain account, awaits [], deps sources [returns, settlement, oli, catalog, directory], priority 3, deadline 330 / hard 420, heap 256",
    worker.kind === "route-cli" && worker.cli.script === RC.ROUTE_CLI_SCRIPT && worker.cli.fixedArgs.length === 0
    && JSON.stringify(worker.publisherKeys) === JSON.stringify([RL]) && JSON.stringify(worker.liveReportKeys) === JSON.stringify(["returns-leakage"])
    && worker.grain === "account" && worker.unit === "none" && worker.awaits.length === 0
    && JSON.stringify(worker.deps.sources) === JSON.stringify(["returns", "settlement", "oli", "catalog", "directory"]) && worker.deps.reports.length === 0
    && worker.priority === 3 && worker.deadlineSeconds === 330 && worker.hardTimeoutSeconds === 420 && worker.childHeapMb === 256 && worker.minChildHeapMb <= 256);
  ok("R0 the CLI declaration: publisher key returns-leakage-v3 (live 'returns-leakage' @ 'returns-leakage-v3', the serve's RETURNS_ADVANCED_VERSION), stampPolicy 'cycle'",
    cli.publisherKey === RL && cli.stampPolicy === "cycle" && liveContracts[RL].liveReportKey === "returns-leakage" && liveContracts[RL].liveReportVersion === RA.RETURNS_ADVANCED_VERSION);
  ok("R0 every evidence statement is a single read-only SELECT (route-contract isReadOnlyEvidenceSql) and names its window by $4/$5 = returnsWindow(epoch)",
    WORKER.evidence.sql.length === 5 && WORKER.evidence.sql.every((q) => RC.isReadOnlyEvidenceSql(q.text))
    && JSON.stringify(WORKER.evidence.sql[0].params({ epoch: EPOCH, accountIds: [ACC], organizationFingerprint: ORG })) === JSON.stringify([ORG, "primary", [ACC], RSR.returnsWindow(EPOCH).from, EPOCH]));
  let threw = 0;
  for (const bad of [{}, { epoch: EPOCH, accountIds: [ACC] }, { epoch: "2026-02-30", accountIds: [ACC], organizationFingerprint: ORG }, { epoch: EPOCH, accountIds: [" pad"], organizationFingerprint: ORG }]) { try { WORKER.evidence.sql[0].params(bad); } catch { threw += 1; } }
  ok("R0 evidence params FAIL CLOSED on a missing org / accountIds / impossible epoch / padded id (never a silent empty read)", threw === 4);
  const h = harness();
  ok("R0 build(deps) returns a runtime the generic release validates (required + optional hooks only)", RC.validateRouteRuntime(h.runtime, "returns-v3") === h.runtime && typeof h.runtime.currentPredicate === "function" && typeof h.runtime.readEvidenceToken === "function");
  const base = { directory: h.directory, orgFp: ORG, sb: h.sb, pgReadOnly: h.pgReadOnly, selectors: SEL };
  const failures = [{ ...base, directory: null }, { ...base, orgFp: "" }, { ...base, pgReadOnly: null }, { ...base, selectors: {} }, { ...base, sb: { ...h.sb, getSourceSnapshot: undefined } }, { ...base, liveContracts: { [RL]: { liveReportKey: "returns-leakage", liveReportVersion: "returns-leakage-v2" } } }];
  let refused = 0;
  for (const d of failures) { try { CLI.build(d); } catch { refused += 1; } }
  ok("R0 build FAILS CLOSED without the durable directory / org / read-only pg / selectors / a reader, or when the live contract no longer targets the v3 page", refused === failures.length);
  // The REAL CLI wiring: the route CLI hands build() readOnlySupabase(supabase.js) -- every reader the route needs is a
  // get* export on that facade, and no writer is (built offline: build performs no I/O).
  const SB = await import("../lib/server/supabase.js");
  const facade = REL.readOnlySupabase(SB);
  let built = null;
  try { built = CLI.build(Object.freeze({ bucket: REGION, epoch: EPOCH, directory: h.directory, orgFp: ORG, connectionId: "primary", sb: facade, pgReadOnly: async () => [], selectors: SEL, computeHash: paramsHashFor, liveContracts, reportDerivations: REPORT_DERIVATIONS, now: () => Date.now(), strict: true, log: () => {} })); } catch { built = null; }
  ok("R0 build over the REAL read-only supabase facade the route CLI passes succeeds (every reader present) and the facade carries no writer", !!built && RC.routeRuntimeProblems(built).length === 0 && typeof facade.publishLiveSnapshotIfNewer === "undefined" && typeof facade.saveReportSnapshot === "undefined" && typeof facade.getLatestReportSnapshotForScope === "function" && net.calls.length === 0);
}

// =====================================================================================================================
// R1. normal publish, then a verify-exact PUBLICATION_NOT_REQUIRED with the served-row check.
// =====================================================================================================================
let R1 = null;
{
  const h = harness();
  const s1 = await h.run();
  const live = h.w.liveRow();
  ok("R1 a live pass publishes the stale unit through the two-phase release (prepare with no controls, ONE control window for the owner + publisher key) -> READBACK_VERIFIED",
    s1.ok === true && s1.counts.targetsPublished === 1 && h.controls.opened.length === 1 && JSON.stringify(h.controls.opened[0]) === JSON.stringify({ owners: [ACC], publisherKeys: [RL] }) && h.controls.closed === 1);
  ok("R1 the live row is the SERVED v3 identity: report_key 'returns-leakage', version 'returns-leakage-v3', params { to: latestDataDate } (hash over { to } ONLY), the rl1/rm1 tokens stored, never hashed",
    !!live && live.params_hash === liveHash(LD) && live.params.reportVersion === "returns-leakage-v3" && live.params.to === LD && /^rl1:[0-9a-f]{64}$/.test(live.params.evidenceToken) && /^rm1:[0-9a-f]{64}$/.test(live.params.manifestToken) && Object.keys(live.params).length === 4);
  ok("R1 the published payload is the REAL v3 builder output for THIS account at asOf = the epoch (identity { to } = its own latestDataDate)", live.payload.version === "returns-leakage-v3" && live.payload.accountId === ACC && live.payload.asOf === EPOCH && live.payload.latestDataDate === LD && REPORT_DERIVATIONS[RL].validatePayload(live.payload) === true);
  const job = h.w.jobs[0];
  const cyc = [...h.w.cycles.values()][0];
  ok("R1 lineage: ONE priority-partial cycle on the epoch, one job (region bucket, depends_on = the per-source digests, durable_content_deps = [evidence, manifest]), the live stamp = the cycle's created_at ('cycle' policy)",
    h.w.cycles.size === 1 && /^priority-partial-india-[0-9a-f]{16}$/.test(cyc.bucket) && cyc.cycle_date === EPOCH && job.bucket === REGION && job.report_version === "returns-leakage/v3-route"
    && job.depends_on.length === 6 && job.depends_on.some((d) => d.startsWith("catalog:")) && JSON.stringify(job.durable_content_deps) === JSON.stringify([live.params.evidenceToken, live.params.manifestToken]) && live.source_refreshed_at === cyc.created_at);
  const writes = h.w.writes();
  const s2 = await h.run({ dryRun: true, verifyExact: true });
  const u2 = h.unit(s2);
  ok("R1 --verify-exact re-scan: PUBLICATION_NOT_REQUIRED via the exact binding AND the served-row check (the serve's latest v3 row IS the canonical live row) AND the latest job carries the re-resolved manifest token -- zero writes",
    u2.state === RS.NR && u2.reason === null && u2.served && u2.served.h === liveHash(LD) && u2.served.id === live.id && u2.h === liveHash(LD) && h.w.writes() === writes);
  const served = await h.runtime.servedSelector(h.unitOf());
  ok("R1 the route's served selector is selectLatestForScope('returns-leakage', acct, 'returns-leakage-v3', {}) and returns exactly the live row", served.row && served.row.id === live.id && served.via === "scope-latest");
  const tline = TGT.parseTargetsLine(TGT.formatTargetsLine({ v: 2, route: "returns-v3", summary: { ...s2, bucket: REGION, requestedAsOf: EPOCH, dryRun: true } }));
  const worker = await h.workerCompose();
  const wt = worker.get(ACC);
  ok("R1 ONE token everywhere: the worker's tier-1 compose token == the CLI's evaluated token (TARGETS v2 tok) == the stored live evidence token; the worker target is region india, as-of the latestDataDate, no alert",
    tline.targets[0].tok === live.params.evidenceToken && wt.token === live.params.evidenceToken && wt.region === "india" && wt.targetAsOf === LD && JSON.stringify(wt.owners) === JSON.stringify([ACC]) && wt.alerts.length === 0);
  ok("R1 ZERO network (zero DataDoe / Supabase HTTP) across scan + prepare + publish + verify; the evidence was read ONLY through the read-only pg (5 declared SELECTs per read) + the injected REST readers", net.calls.length === 0 && h.st.pg > 0 && h.st.pg % 5 === 0 && h.pgReadOnly.calls.every((c) => ["returns", "settlement", "oli", "opunits", "catalog"].includes(c)));
  R1 = h;
}

// =====================================================================================================================
// R2. OLI-only advance: the token changes and it re-publishes.
// =====================================================================================================================
{
  const h = harness();
  await h.run();
  const before = h.w.liveRow();
  const tok1 = before.params.evidenceToken;
  // An OLI re-fetch: the ordered units of one day change and its coverage window is re-recorded (source_refreshed_at +
  // updated_at bump). Returns / Settlement / catalog are untouched.
  h.st.oli[1].units = 4; h.st.oli[1].sales_amount = 1200;
  h.st.coverage[0].source_refreshed_at = "2026-09-24T05:30:00.000Z"; h.st.coverage[0].updated_at = "2026-09-24T05:30:00.000Z";
  const ret0 = JSON.stringify(h.st.returns) + JSON.stringify(h.st.settlement);
  const scan = await h.run({ dryRun: true });
  const us = h.unit(scan);
  ok("R2 an OLI-only advance changes the L1 token -> the unit is STALE (the job no longer covers the new evidence token)", us.state === RS.ST && scan.perAccount[0].evidenceToken !== tok1);
  const s = await h.run();
  const after = h.w.liveRow();
  ok("R2 ... and it RE-PUBLISHES from the saved evidence: a new live promotion at the SAME { to } identity with the new evidence + manifest tokens and the re-derived ordered denominator",
    s.counts.targetsPublished === 1 && after.params_hash === before.params_hash && after.params.evidenceToken !== tok1 && after.params.evidenceToken === scan.perAccount[0].evidenceToken && after.params.manifestToken !== before.params.manifestToken && after.source_refreshed_at > before.source_refreshed_at && JSON.stringify(h.st.returns) + JSON.stringify(h.st.settlement) === ret0);
  const v = await h.run({ dryRun: true, verifyExact: true });
  ok("R2 ... then verifies PUBLICATION_NOT_REQUIRED with the served-row check; zero network", h.unit(v).state === RS.NR && net.calls.length === 0);
}

// =====================================================================================================================
// R3. catalog read failure: deferred with zero writes, never an empty-catalog payload.
// =====================================================================================================================
{
  const h = harness();
  h.st.catalogRead = "read-failed";
  const s = await h.run();
  const u = h.unit(s);
  ok("R3 a catalog pointer read that is not 'ok' -> the strict gather is not ready ('catalog-missing'): typed DEFERRED_DEPENDENCY 'bundle-catalog-missing', ZERO writes, NO live row, no control window",
    s.counts.targetsDeferred === 1 && s.counts.targetsPublished === 0 && u.state === RS.DD && u.reason === "bundle-catalog-missing" && h.w.writes() === 0 && !h.w.liveRow() && h.controls.opened.length === 0);
  const h2 = harness();
  h2.st.loaderThrows = true;
  const s2 = await h2.run();
  ok("R3 a catalog payload hydration that THROWS -> 'bundle-evidence-read-failed:catalog', ZERO writes (never catalogRows [] published)", h2.unit(s2).reason === "bundle-evidence-read-failed:catalog" && h2.w.writes() === 0 && !h2.w.liveRow());
  const h3 = harness();
  h3.st.catalog.pointer = null;
  const s3 = await h3.run();
  ok("R3 NO catalog pointer at all -> scan-level typed DEFERRED_PROVENANCE 'catalog-missing' (zero reads of the payload, zero writes)", h3.unit(s3).state === RS.DP && h3.unit(s3).reason === "catalog-missing" && h3.w.writes() === 0);
  const strict = await RP.gatherReturnsEvidence(gatherArgs(), readersOf(h.sb, h.directory), { strict: true });
  const soft = await RP.gatherReturnsEvidence(gatherArgs(), readersOf(h.sb, h.directory));
  ok("R3 the SAME failed catalog read: strict -> notReady 'catalog-missing'; non-strict (the serve) still fail-softs to a catalog-less payload exactly as before",
    strict.notReady === "catalog-missing" && !strict.payload && !!soft.payload && Array.isArray(soft.payload.catalogBrands) && soft.payload.catalogBrands.length === 0);
  h.st.catalogRead = "ok"; h.st.catalogThrows = true;
  ok("R3 a catalog reader that THROWS in strict mode -> 'evidence-read-failed:catalog'", (await RP.gatherReturnsEvidence(gatherArgs(), readersOf(h.sb, h.directory), { strict: true })).notReady === "evidence-read-failed:catalog");
}

// =====================================================================================================================
// R4. the v3 validator rejects a v2 payload.
// =====================================================================================================================
{
  const h0 = harness();
  const g = await RP.gatherReturnsEvidence(gatherArgs(), readersOf(h0.sb, h0.directory), { strict: true });
  const v3 = g.payload;
  const DV = REPORT_DERIVATIONS[RL].validatePayload;
  ok("R4 the returns-leakage-v3 validator accepts the real v3 payload and REJECTS a v2-versioned one / one missing dayAxis / series / freshness",
    DV(v3) === true && DV({ ...v3, version: "returns-leakage-v2" }) === false && DV({ ...v3, dayAxis: undefined }) === false && DV({ ...v3, series: [] }) === false && DV({ ...v3, freshness: null }) === false);
  const toV2 = async (args, readers, opts) => { const r = await RP.gatherReturnsEvidence(args, readers, opts); return r.payload ? { ...r, payload: { ...r.payload, version: "returns-leakage-v2" } } : r; };
  const h = harness({ gatherEvidence: toV2 });
  const s = await h.run();
  const u = h.unit(s);
  ok("R4 through the release a v2-shaped derivation is a HARD 'payload-invalid' (FAILED_DERIVE) with ZERO cycle / job / shadow / live writes", u.state === RS.FD && u.reason === "payload-invalid" && h.w.writes() === 0 && !h.w.liveRow());
}

// =====================================================================================================================
// R5. saved evidence older than 168 h: verified plus a source-stale-manual alert, zero exports.
// =====================================================================================================================
{
  const h = harness();
  await h.run();
  const writes = h.w.writes();
  const refreshed = Date.parse("2026-09-24T02:00:00.000Z");
  h.nowMs = refreshed + 167 * 3600 * 1000;
  const fresh = await h.run({ dryRun: true });
  ok("R5 evidence 167 h old: PUBLICATION_NOT_REQUIRED with NO alert", h.unit(fresh).state === RS.NR && h.unit(fresh).reason === null);
  h.nowMs = refreshed + 169 * 3600 * 1000;
  const stale = await h.run({ dryRun: true, verifyExact: true });
  const u = h.unit(stale);
  ok("R5 evidence 169 h old: STILL verified (PUBLICATION_NOT_REQUIRED, served = the canonical live row) but the unit reason carries 'source-stale-manual'", u.state === RS.NR && u.reason === "source-stale-manual" && u.served && u.served.h === liveHash(LD) && u.h === liveHash(LD));
  const wt = (await h.workerCompose()).get(ACC);
  ok("R5 the worker's compose raises the SAME alert on the (unchanged) token", JSON.stringify(wt.alerts) === JSON.stringify(["source-stale-manual"]) && wt.token === h.w.liveRow().params.evidenceToken);
  h.st.coverage[0].source_refreshed_at = "2026-10-01T09:00:00.000Z"; h.st.coverage[0].updated_at = "2026-10-01T09:00:00.000Z";
  const staleScan = await h.run({ dryRun: true });
  ok("R5 a STALE verdict on old Returns evidence keeps its reason and gains the ':source-stale-manual' suffix", h.unit(staleScan).state === RS.ST && /:source-stale-manual$/.test(S(h.unit(staleScan).reason)));
  ok("R5 the alert is informational: ZERO writes across the stale scans and ZERO network (nothing on this route can start an export)", h.w.writes() === writes && net.calls.length === 0);
  ok("R5 returnsSourceAlert: an unknown refreshed_at alerts; no evidence rows -> no alert", WORKER_MOD.returnsSourceAlert({ returns: { n: 1, refreshed: null }, settlement: { n: 0, refreshed: null } }, Date.now()) === "source-stale-manual" && WORKER_MOD.returnsSourceAlert({ returns: { n: 0 }, settlement: { n: 0 } }, Date.now()) === null);
}

// =====================================================================================================================
// R6. never-regress on `to`.
// =====================================================================================================================
{
  const NEWER = "2026-09-24";
  const plantNewer = (w) => { const hNew = liveHash(NEWER); w.snaps.set("returns-leakage|" + ACC + "|" + hNew, { id: "legacy-newer", report_key: "returns-leakage", account_id: ACC, params_hash: hNew, params: { reportVersion: "returns-leakage-v3", to: NEWER }, payload: { version: "returns-leakage-v3", accountId: ACC, asOf: NEWER, rows: [] }, payload_storage_path: null, source_refreshed_at: "2026-09-24T07:00:00.000Z", updated_at: "2099-01-01T00:00:00.000Z" }); };
  const h = harness();
  plantNewer(h.w);
  const s = await h.run();
  const u = h.unit(s);
  ok("R6 a SERVED v3 row with a NEWER { to } than this evidence's latestDataDate -> DEFERRED_DEPENDENCY 'served-newer-to' at scan time, ZERO writes (the page is never regressed to an older to)", u.state === RS.DD && u.reason === "served-newer-to" && h.w.writes() === 0 && h.w.snaps.get("returns-leakage|" + ACC + "|" + liveHash(NEWER)).id === "legacy-newer");
  const b = await h.runtime.resolveBundle(h.unitOf(), { strict: true, epoch: EPOCH, bucket: REGION });
  ok("R6 resolveBundle refuses the same unit ('served-newer-to') -- a prepare can never write it either", b.eligible === false && b.reason === "served-newer-to");
  // The publish-time re-check: prepared BEFORE the newer row appeared, published after -> 'evidence-advanced', zero CAS.
  const h2 = harness();
  const scan = await h2.run({ dryRun: true });
  const rev = REL.normalizeRouteRevision(h2.runtime.computeRevision({ accountId: ACC, evidence: (await h2.runtime.readScopeEvidence({ scope: [ACC], epoch: EPOCH, directory: h2.directory, organizationFingerprint: ORG, connectionId: "primary" })).perAccount.get(ACC), epoch: EPOCH }));
  const p = await h2.release.prepareForUnit({ unit: h2.unitOf(), revision: rev, epoch: EPOCH, region: REGION, bucket: REGION });
  plantNewer(h2.w);
  const cas = h2.w.n.liveCas;
  const r = await h2.release.publishForUnit({ unit: h2.unitOf(), prepared: p, epoch: EPOCH, region: REGION, bucket: REGION, accountId: ACC });
  ok("R6 a newer { to } served between prepare and publish -> the publish-time token re-check defers 'evidence-advanced' with ZERO preflight / CAS", h2.unit(scan).state === RS.ST && p.ok === true && r.ok === false && r.reason === "evidence-advanced" && h2.w.n.liveCas === cas && h2.w.n.preflight === 0);
  // An OLDER served to never blocks (it is superseded normally).
  const h3 = harness();
  const hOld = liveHash("2026-09-20");
  h3.w.snaps.set("returns-leakage|" + ACC + "|" + hOld, { id: "older", report_key: "returns-leakage", account_id: ACC, params_hash: hOld, params: { reportVersion: "returns-leakage-v3", to: "2026-09-20" }, payload: { version: "returns-leakage-v3", rows: [] }, payload_storage_path: null, source_refreshed_at: "2026-09-21T00:00:00.000Z", updated_at: "2026-09-21T00:00:00.000Z" });
  const s3 = await h3.run();
  ok("R6 an OLDER served { to } never blocks: the route publishes the newer identity and it becomes the served row", s3.counts.targetsPublished === 1 && (await h3.runtime.servedSelector(h3.unitOf())).row.params_hash === liveHash(LD));
}

// =====================================================================================================================
// R7. missing evidence gives a typed deferral.
// =====================================================================================================================
{
  const h = harness({ scope: [ACC, ACC2], seed: [ACC] });
  const s = await h.run();
  const u2 = h.unit(s, ACC2);
  ok("R7 an account with NO Returns and NO Settlement rows in the window -> typed DEFERRED_PROVENANCE 'returns-evidence-missing' (never a zero payload); the other account still publishes",
    u2.state === RS.DP && u2.reason === "returns-evidence-missing" && !h.w.liveRow(ACC2) && h.unit(s, ACC).state === RS.RV && s.counts.targetsPublished === 1 && s.counts.targetsDeferred === 1);
  const wt = (await h.workerCompose()).get(ACC2);
  ok("R7 the worker compose marks it ineligible: token null + the typed reason", wt.token === null && wt.reason === "returns-evidence-missing" && wt.region === "india");
  const h2 = harness({ scope: [ACC2], seed: [] });
  seedAccount(h2.st, ACC2, { covTo: "2026-09-20" });
  const s2 = await h2.run();
  ok("R7 OLI coverage ending BEFORE the identity date -> 'oli-coverage-short' (the ordered denominator would be truncated), zero writes", h2.unit(s2, ACC2).state === RS.DP && h2.unit(s2, ACC2).reason === "oli-coverage-short" && h2.w.writes() === 0);
  const h3 = harness({ scope: [ACC] });
  h3.st.pgThrows = true;
  const s3 = await h3.run();
  ok("R7 an unreadable evidence metadata read fails the WHOLE pass closed (DURABLE_SOURCE_UNREADABLE), zero writes", s3.ok === false && /^DURABLE_SOURCE_UNREADABLE/.test(s3.code) && h3.w.writes() === 0);
  // Every STRICT read is typed.
  const g = async (mut) => { const x = harness(); mut(x); return (await RP.gatherReturnsEvidence(gatherArgs(), readersOf(x.sb, x.directory), { strict: true })).notReady; };
  ok("R7 strict: a throwing Returns read -> 'evidence-read-failed:returns'", (await g((x) => { x.st.returnsThrows = true; })) === "evidence-read-failed:returns");
  ok("R7 strict: a throwing operational-units read -> 'evidence-read-failed:opunits' (the serve would silently drop the units)", (await g((x) => { x.st.opunitsThrows = true; })) === "evidence-read-failed:opunits");
  const x4 = harness();
  const noDir = { ...readersOf(x4.sb, x4.directory), readDirectory: async () => [] };
  ok("R7 strict: an unproven account marketplace (no SKU->ASIN resolver) -> 'evidence-read-failed:resolver'", (await RP.gatherReturnsEvidence(gatherArgs(), noDir, { strict: true })).notReady === "evidence-read-failed:resolver");
  ok("R7 strict: an OLI coverage read that is not 'ok' -> 'evidence-read-failed:oli'", (await g((x) => { x.st.coverageRead = "read-failed"; })) === "evidence-read-failed:oli");
  ok("R7 strict: coverage ending before the latestDataDate -> 'oli-coverage-short'", (await g((x) => { x.st.coverage[0].covered_to = "2026-09-22"; })) === "oli-coverage-short");
  ok("R7 strict: no Returns and no Settlement rows -> 'returns-evidence-missing'", (await g((x) => { x.st.returns.length = 0; x.st.settlement.length = 0; })) === "returns-evidence-missing");
  const okStrict = await RP.gatherReturnsEvidence(gatherArgs(), readersOf(harness().sb, directoryOf([ACC, ACC2])), { strict: true });
  ok("R7 a strict success returns the SAME three fields + the hydrated evidence (rows, catalog sha, proven covered_to) for the manifest", !!okStrict.payload && okStrict.latestDataDate === LD && Array.isArray(okStrict.evidence.durableReturnRows) && okStrict.evidence.durableReturnRows.length === 3 && okStrict.evidence.oliCoveredTo === EPOCH && /^[0-9a-f]{64}$/.test(okStrict.evidence.catalogPayloadSha));
}

// =====================================================================================================================
// R8. non-strict gatherReturnsEvidence is BYTE-IDENTICAL to the pre-WP5 function (verbatim copy, same imports).
// =====================================================================================================================
{
  const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const maxDate = (rows, field) => (Array.isArray(rows) ? rows : []).reduce((m, r) => { const d = S(r && r[field]); return isDate(d) && (!m || d > m) ? d : m; }, null);
  const minDate = (rows, field) => (Array.isArray(rows) ? rows : []).reduce((m, r) => { const d = S(r && r[field]); return isDate(d) && (!m || d < m) ? d : m; }, null);
  const maxTs = (rows, field) => (Array.isArray(rows) ? rows : []).reduce((m, r) => { const t = r && r[field]; return t && (!m || String(t) > String(m)) ? t : m; }, null);
  async function readOperationalUnits(readOliOperationalUnits, args) {
    if (typeof readOliOperationalUnits !== "function") return [];
    try { const rows = await readOliOperationalUnits({ ...args, additiveOnly: true }); return Array.isArray(rows) ? rows : []; }
    catch (_e) { return []; }
  }
  async function buildAccountResolver({ readDirectory, readOliSkuAsinResolution }, { organizationFingerprint, connectionId, accountId }) {
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
  // VERBATIM pre-WP5 lib/server/reports/returns-publish.js gatherReturnsEvidence (module-qualified imports only).
  async function legacyGather({ accountId, organizationFingerprint, connectionId = "primary", asOf, graceDays = RA.RETURNS_GRACE_DAYS }, readers) {
    const {
      readReturnsHistory, readSettlementHistory, readOliHistory, readOliCoverage, readOliOperationalUnits,
      readCatalogSnapshot, loadCatalogPayload, readOliSkuAsinResolution, readDirectory,
    } = readers;
    void readOliCoverage;
    if (!isDate(asOf)) return { notReady: "invalid-asof" };
    const win = RSR.returnsWindow(asOf);
    const from = win.from;
    const acctIds = [S(accountId)];
    const durableReturnRows = await readReturnsHistory({ organizationFingerprint, connectionId, accountIds: acctIds, from, to: asOf });
    const durableSettlementRows = await readSettlementHistory({ organizationFingerprint, connectionId, accountIds: acctIds, from, to: asOf });
    let orderedRows = [];
    try {
      const pricedRows = await readOliHistory({ organizationFingerprint, connectionId, accountIds: acctIds, from, to: asOf });
      const operationalRows = await readOperationalUnits(readOliOperationalUnits, { organizationFingerprint, connectionId, accountIds: acctIds, from, to: asOf });
      const resolver = await buildAccountResolver({ readDirectory, readOliSkuAsinResolution }, { organizationFingerprint, connectionId, accountId });
      const merged = OSE.mergeOrderedOliHistory({ historyRows: Array.isArray(pricedRows) ? pricedRows : [], operationalRows, estimateRows: [], skuAsinResolver: resolver });
      orderedRows = RSR.reshapeOrderedRows(merged);
    } catch (_e) { orderedRows = []; }
    let catalogRows = [];
    let catalogSnapshot = null;
    try {
      const catRead = await readCatalogSnapshot({ organizationFingerprint, connectionId, sourceKey: "product-catalog", scopeKey: "__organization" });
      catalogSnapshot = catRead && typeof catRead === "object" && "snapshot" in catRead ? catRead.snapshot : catRead;
      const okRead = !catRead || typeof catRead !== "object" || !("read" in catRead) || catRead.read === "ok";
      if (okRead && catalogSnapshot && catalogSnapshot.object_path && typeof loadCatalogPayload === "function") {
        const payload = await loadCatalogPayload(catalogSnapshot.object_path);
        catalogRows = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.rows) ? payload.rows : []);
      }
    } catch (_e) { catalogRows = []; }
    const returnsRefreshedAt = maxTs(durableReturnRows, "refreshed_at");
    const settlementsRefreshedAt = maxTs(durableSettlementRows, "refreshed_at");
    const payload = RA.buildReturnsAdvancedPayload({
      accountId: S(accountId), asOf, from, windowDays: 60, graceDays,
      returnsSourceLabel: SOURCES.RETURNS.label, moneySourceLabel: SOURCES.SETTLEMENTS.label, rateSourceLabel: SOURCES.ORDER_LINE_ITEMS.label,
      rateSourceLagDays: SOURCES.ORDER_LINE_ITEMS.lagDays ?? 0, returnHistoryDays: SOURCES.RETURNS.historyDays ?? 60,
      durableReturnRows, durableSettlementRows, orderedRows, catalogRows,
      returnsRefreshedAt, settlementsRefreshedAt,
      returnsCoveredFrom: minDate(durableReturnRows, "return_date"), returnsCoveredTo: maxDate(durableReturnRows, "return_date"),
      settlementsCoveredFrom: minDate(durableSettlementRows, "settlement_date"), settlementsCoveredTo: maxDate(durableSettlementRows, "settlement_date"),
    });
    const cands = [returnsRefreshedAt, settlementsRefreshedAt, catalogSnapshot && catalogSnapshot.validated_at,
      isDate(payload.latestDataDate) ? payload.latestDataDate + "T00:00:00.000Z" : null].filter(Boolean).map(String).sort();
    const sourceRefreshedAt = cands.length ? cands[cands.length - 1] : null;
    return { payload, latestDataDate: payload.latestDataDate, sourceRefreshedAt };
  }
  const fixtures = [
    ["normal", () => {}], ["catalog read-failed", (x) => { x.st.catalogRead = "read-failed"; }], ["catalog throws", (x) => { x.st.catalogThrows = true; }],
    ["loader throws", (x) => { x.st.loaderThrows = true; }], ["opunits throws", (x) => { x.st.opunitsThrows = true; }], ["no catalog pointer", (x) => { x.st.catalog.pointer = null; }],
    ["no evidence", (x) => { x.st.returns.length = 0; x.st.settlement.length = 0; }], ["coverage short", (x) => { x.st.coverage[0].covered_to = "2026-09-01"; }],
  ];
  let same = 0;
  for (const [, mut] of fixtures) {
    const x = harness(); mut(x);
    const r = readersOf(x.sb, x.directory);
    const a = await RP.gatherReturnsEvidence(gatherArgs(), r);
    const b = await legacyGather(gatherArgs(), r);
    if (B.stableJson(a) === B.stableJson(b) && JSON.stringify(Object.keys(a)) === JSON.stringify(Object.keys(b))) same += 1;
  }
  ok(`R8 non-strict gatherReturnsEvidence (the serve / materializer / buildReturnsPublishAccount) is BYTE-IDENTICAL to the pre-WP5 function across ${fixtures.length} fixtures (normal, every fail-soft read, no evidence, short coverage)`, same === fixtures.length);
  const x = harness(); x.st.returnsThrows = true;
  let aThrew = false, bThrew = false;
  try { await RP.gatherReturnsEvidence(gatherArgs(), readersOf(x.sb, x.directory)); } catch { aThrew = true; }
  try { await legacyGather(gatherArgs(), readersOf(x.sb, x.directory)); } catch { bThrew = true; }
  ok("R8 ... including a THROWING Returns read (still propagated, exactly as before) and an invalid as-of", aThrew && bThrew && (await RP.gatherReturnsEvidence({ ...gatherArgs(), asOf: "x" }, readersOf(x.sb, x.directory))).notReady === "invalid-asof");
}

// =====================================================================================================================
// R9. golive static: step 7 calls the route; no TLS override; pg via verifiedPgConfig; acquisition byte-identical.
// =====================================================================================================================
{
  const golive = src("scripts/release/returns-leakage-golive.mjs");
  // The CODE only (comment-only lines + trailing " // ..." comments removed; the header documents the old writer).
  const code = golive.split("\n").filter((l) => !/^\s*\/\//.test(l)).map((l) => l.replace(/\s\/\/\s.*$/, "")).join("\n");
  ok("R9 golive: NO process-wide TLS-verification override anywhere in the file (no NODE_TLS_REJECT_UNAUTHORIZED / rejectUnauthorized:false / sslmode=no-verify / PGSSL_NO_VERIFY, not even in a comment)", !/NODE_TLS_REJECT_UNAUTHORIZED|rejectUnauthorized\s*:\s*false|sslmode=no-verify|PGSSL_NO_VERIFY/.test(golive));
  const clients = code.match(/new\s+pg\.(Client|Pool)\(/g) || [];
  ok("R9 golive: every pg client is built from lib/server/pg-tls.js verifiedPgConfig", clients.length === 1 && /new pg\.Client\(verifiedPgConfig\(process\.env\.POSTGRES_URL\)\)/.test(code) && /import \{ verifiedPgConfig \} from "\.\.\/\.\.\/lib\/server\/pg-tls\.js";/.test(code));
  ok("R9 golive: the unfenced step-7 writer is GONE from the code (no publishLiveSnapshotIfNewer / saveReportSnapshot / direct live CAS / buildReturnsPublishAccount / live identity hashing)", !/publishLiveSnapshotIfNewer|publishLiveSnapshotFencedIfNewer|saveReportSnapshot|buildReturnsPublishAccount|paramsHashFor|RETURNS_ADVANCED_VERSION|report_snapshots/.test(code));
  const pa = (golive.match(/async function publishAccount\(\{ account \}\) \{[\s\S]*?\n\}/) || [""])[0];
  ok("R9 golive: publishAccount only COLLECTS the account (no write, no network) -- 'route-pending'", /routeTargets\.add\(id\)/.test(pa) && /outcome: "route-pending"/.test(pa) && !/sb\.|fetch|publish[A-Z]/.test(pa.replace("async function publishAccount", "")));
  ok("R9 golive: step 7 spawns the ROUTE CLI (spawnSync of publication-route-reconcile.mjs) with --route=returns-v3 --live --targets=<acquired> --mode=scheduler --lease-wait-seconds=600 (+ region bucket, as-of, run token, deadline)",
    /spawnSync\(process\.execPath, \[ROUTE_CLI, \.\.\.argv\]/.test(golive) && /new URL\("\.\/publication-route-reconcile\.mjs", import\.meta\.url\)/.test(golive)
    && ['"--route=returns-v3"', "`--bucket=${region}`", "`--as-of=${asOf}`", '"--live"', '`--targets=${targets.join(",")}`', '"--mode=scheduler"', '"--lease-wait-seconds=600"', "`--run-token=${runToken}`"].every((t) => golive.includes(t)));
  ok("R9 golive: an abnormal route exit runs the SAME CLI --cleanup with the same run token; the route result (not the collector) is reported; a failed invocation exits 1", /"--cleanup", `--run-token=\$\{runToken\}`/.test(golive) && /summary\.published = route\.published;/.test(golive) && /routeFailed \? 1 : 0/.test(golive) && /if \(routeTargets\.size > 0\)/.test(golive));
  ok("R9 golive (final review P3-1): a route child that EXITS reporting RESULT code CONTROL_CLEANUP_UNRESOLVED (its own safe-close did not complete) also gets the same-token --cleanup, not only a crash / kill / signal",
    /const abnormal = !!res\.error \|\| res\.status === null \|\| !!res\.signal \|\| !!\(result && result\.code === "CONTROL_CLEANUP_UNRESOLVED"\);/.test(code)
    && code.indexOf("const result = parseRouteResultLine(res.stdout);") < code.indexOf("const abnormal = "));
  // The ACQUISITION step sequence, pinned against golden digests of the PRE-WP5 file (git HEAD 6a59a1f).
  const SEGMENTS = [
    ["env-bootstrap", 'for (const p of ["C:/Users/laxmi/', "if (!process.env.SUPABASE_URL && process.env.VITE_SUPABASE_URL)", "f93eec1e424c81344c96dc78fbe4ebabcf164c58beb8efd80686f9003789f5cb"],
    ["argv", "const arg = (name, def = null) =>", 'if (mode !== "dry-run" && mode !== "go-live")', "54be72161b31deaf5e324287915983f283f9f974fe48eaac4595650f2c90b146"],
    ["acquisition-imports", "const { runReturnsBucketCycle } = await import(", "const { getDataDoeTokenBalance, tokenGateDecision } = await import(", "27d76cb120cc217170888309f737a41e8119d4cd3623e286d197b2c3c0b87d2e"],
    ["org", "const apiKey = process.env.DATADOE_API_KEY;", "const orgFp = organizationFingerprint(apiKey);", "d3d581b0892fa29879cd8809f68246a4753fb3dd58568499105c0d0279a0c8b5"],
    ["read-coverage", "async function readCoverage(accountIds) {", "}", "8bd6baf40ccbc1f93cf5769c3f6ed1e1efa318d6849a8bc7621ec4c3b77703af"],
    ["list-accounts", "async function listAccounts() {", "}", "053d4c38cbd0093972b77fae9f4bc409cc41f83e2e436bd04d39fe4303b3cdf6"],
    ["fetch-export", "async function fetchExport(", "}", "7e380a060109882b5d85c0bf86fb1f304a31ec30bf06f6dd70ce92504f4bdf90"],
    ["deps", "const deps = {", "};", "4806c3b1cf509cdc4cf0d42da4284a7e077d4da295a0f2a3a6f26b7574496876"],
    ["cycle-call", "  const summary = await runReturnsBucketCycle({ bucket, asOf, mode, maxBatches, deps });", "  const summary = await runReturnsBucketCycle({ bucket, asOf, mode, maxBatches, deps });", "5a310496af84a6dd2f7b3978fcc8a577ab14af97ba3722fbd345dc7293b196ee"],
  ];
  const lines = golive.split("\n");
  const found = SEGMENTS.map(([name, start, end, golden]) => {
    const s = lines.findIndex((l) => l.startsWith(start));
    let e = -1;
    for (let i = s; s >= 0 && i < lines.length; i++) { if (i === s && start !== end && end === "}") continue; if (end === "}" || end === "};" ? lines[i] === end : lines[i].startsWith(end)) { e = i; break; } }
    return { name, s, ok: s >= 0 && e >= s && sha(lines.slice(s, e + 1).join("\n")) === golden };
  });
  ok("R9 golive: EVERY acquisition segment (env bootstrap, argv, acquisition imports, org, readCoverage, listAccounts, fetchExport, the cycle deps, the runReturnsBucketCycle call) is BYTE-IDENTICAL to the pre-WP5 file", found.every((f) => f.ok));
  ok("R9 golive: ... and the acquisition segments keep their ORIGINAL sequence", found.every((f, i) => i === 0 || f.s > found[i - 1].s));
  ok("R9 golive: no LF-breaking CR and 7-bit ASCII", !golive.includes("\r") && /^[\x00-\x7f]*$/.test(golive));
  // The pure step-7 helpers.
  const dir = REL.buildDurableDirectory({ rows: [...Array.from({ length: 27 }, (_, i) => ({ accountId: "IN" + String(i).padStart(2, "0"), country: "IN" })), { accountId: "UK1", country: "UK" }, { accountId: "US1", country: "US" }, { accountId: "NOCOUNTRY", country: "" }], resolveRawSellerId: (id) => "raw-" + id, normalizeMarketplace: OSE.normalizeMarketplace }).directory;
  const ids = [...dir.keys(), "UNKNOWN", "NOCOUNTRY", "US1"];
  const plan = CLI_MOD.planReturnsRouteInvocations({ accountIds: ids, directory: dir });
  const inScope = (region) => REL.regionAccountIds(dir, region, accountInScope);
  ok("R9 step-7 planner: routes EXACTLY like the route CLI's scope (regionAccountIds over the durable directory), <= 25 targets per call, deterministic",
    JSON.stringify(plan.chunks.map((c) => [c.region, c.targets.length])) === JSON.stringify([["india", 25], ["india", 2], ["europe-au", 1], ["us-ca", 1]])
    && plan.chunks.filter((c) => c.region === "india").flatMap((c) => c.targets).join(",") === inScope("india").join(",") && plan.chunks.every((c) => c.targets.every((t) => inScope(c.region).includes(t))));
  ok("R9 step-7 planner: an account absent from the durable directory (or without a routable country) is reported out-of-scope, never guessed into a region", JSON.stringify(plan.outOfScope) === JSON.stringify(["NOCOUNTRY", "UNKNOWN"]));
  ok("R9 parseRouteResultLine: the LAST RESULT line of the route CLI's stdout; null when absent / malformed", CLI_MOD.parseRouteResultLine("x\nRESULT {\"ok\":false}\nRESULT {\"ok\":true,\"counts\":{\"targetsPublished\":2}}\n").counts.targetsPublished === 2 && CLI_MOD.parseRouteResultLine("RESULT {bad") === null && CLI_MOD.parseRouteResultLine("") === null);
}

// =====================================================================================================================
// R10. static DDL + closure hygiene.
// =====================================================================================================================
{
  const MIG = path.join(ROOT, "supabase", "migrations");
  const ddl = readdirSync(MIG).filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(path.join(MIG, f), "utf8")).join("\n");
  // Columns of `create table [if not exists] public.<t> ( ... );` + any later `alter table public.<t> add column`.
  function columnsOf(table) {
    const cols = new Set();
    const re = new RegExp("create table (?:if not exists )?public\\." + table + " \\(([\\s\\S]*?)\\n\\);", "g");
    for (const m of ddl.matchAll(re)) {
      for (const line of m[1].split("\n")) { const c = line.match(/^\s{2}([a-z_][a-z0-9_]*)\s+(text|integer|numeric|date|timestamptz|bigint|boolean|jsonb|uuid)\b/); if (c) cols.add(c[1]); }
    }
    for (const m of ddl.matchAll(new RegExp("alter table (?:if exists )?public\\." + table + "\\s+add column (?:if not exists )?([a-z_][a-z0-9_]*)", "g"))) cols.add(m[1]);
    return cols;
  }
  const TABLE_OF = { returns: "source_returns_history", settlement: "source_settlement_history", oli: "source_coverage", opunits: "source_oli_operational_units", catalog: "source_snapshots" };
  const FUNCS = new Set(["to_char", "string_agg", "count", "max", "md5", "coalesce", "btrim", "any"]);
  const problems = [];
  for (const q of WORKER.evidence.sql) {
    const table = TABLE_OF[q.name];
    const cols = columnsOf(table);
    if (cols.size < 5) { problems.push(q.name + ":ddl-not-found"); continue; }
    const text = q.text.replace(/'[^']*'/g, "''");
    const aliases = new Set([...text.matchAll(/\bas ([a-z_][a-z0-9_]*)/g)].map((m) => m[1]));
    const idents = [...new Set([...text.matchAll(/\b([a-z_][a-z0-9_]*)\b/g)].map((m) => m[1]))].filter((t) => t.includes("_") && !FUNCS.has(t) && !aliases.has(t) && t !== table);
    for (const c of [...idents, ...(/\bstatus\b/.test(text) ? ["status"] : [])]) if (!cols.has(c)) problems.push(q.name + ":" + c);
  }
  ok("R10 every column the five evidence SELECTs name EXISTS in the migration DDL of its table (static; source_returns_history / source_settlement_history / source_coverage / source_oli_operational_units / source_snapshots)", problems.length === 0);
  const opu = columnsOf("source_oli_operational_units");
  const opuSql = WORKER.evidence.sql.find((q) => q.name === "opunits").text;
  ok("R10 source_oli_operational_units: the 20260901 DDL declares updated_at (and created_at) -> the evidence reads max(updated_at), per the spec rule (created_at only if updated_at were absent)", opu.has("updated_at") && opu.has("created_at") && /max\(updated_at\)/.test(opuSql) && !/created_at/.test(opuSql));
  ok("R10 the returns / settlement tables declare refreshed_at + created_at + their date column; source_coverage declares source_refreshed_at + updated_at; source_snapshots declares payload_sha + validated_at",
    ["refreshed_at", "created_at", "return_date"].every((c) => columnsOf("source_returns_history").has(c)) && ["refreshed_at", "created_at", "settlement_date", "child_asin"].every((c) => columnsOf("source_settlement_history").has(c))
    && ["source_refreshed_at", "updated_at", "covered_from", "covered_to"].every((c) => columnsOf("source_coverage").has(c)) && ["payload_sha", "validated_at", "scope_key"].every((c) => columnsOf("source_snapshots").has(c)));
  ok("R10 every timestamp is rendered as UTC text IN SQL and every date as ::text (never a JS Date on a local-timezone host)", WORKER.evidence.sql.every((q) => !/max\((refreshed_at|created_at|updated_at)\)(?! at time zone)/.test(q.text.replace(/to_char\(max\((refreshed_at|created_at|updated_at)\) at time zone 'UTC'/g, "")) && !/max\((return_date|settlement_date|covered_to)\)(?!::text|\) filter| filter)/.test(q.text)));
  const ra = src("lib/server/reports/returns-advanced.js");
  const dd = src("lib/server/datadoe.js");
  const raIs = (ra.match(/const isDateStr = \(value\) => (.*);/) || [])[1];
  const ddIs = (dd.match(/export function isDateStr\(value\) \{\n\s+return (.*);\n\}/) || [])[1];
  ok("R10 returns-advanced.js no longer imports the transport module datadoe.js; its inlined isDateStr is BYTE-IDENTICAL to datadoe.js isDateStr; addDaysStr is the leaf date-windows.js function datadoe.js re-exports",
    !/from "\.\.\/datadoe\.js"/.test(ra) && /import \{ addDaysStr \} from "\.\.\/date-windows\.js";/.test(ra) && !!raIs && raIs === ddIs && /export \{[^}]*addDaysStr[^}]*\};/.test(dd) && /import \{[^}]*addDaysStr[^}]*\} from "\.\/date-windows\.js";/.test(dd));
  const routeSrc = src("lib/server/recovery/routes/returns-v3.route.js") + src("lib/server/sync/routes/returns-v3.release.js");
  const specs = [...routeSrc.matchAll(/^import [\s\S]*? from "([^"]+)";$/gm)].map((m) => m[1]);
  ok("R10 the route modules import only node:crypto + pure repo modules -- no DataDoe / supabase / pg / connection / sync-runtime module, no dynamic import (7-bit ASCII, LF)",
    specs.length >= 8 && specs.every((s) => s === "node:crypto" || s.startsWith(".")) && !specs.some((s) => /datadoe|supabase|pg-tls|source-sync|runtime-composition|publisher-composition/.test(s)) && !/\bimport\(/.test(routeSrc) && /^[\x00-\x7f]*$/.test(routeSrc) && !routeSrc.includes("\r"));
}

// =====================================================================================================================
// R11. (verifier P2-1) EXACT row set: a paged read that duplicates one row and skips another keeps the COUNT the token
//      bound -- the strict gather AND resolveBundle refuse any repeated primary-key tuple (typed, zero writes).
// =====================================================================================================================
// A paged reader over the FORMER non-total order: page 2 re-returns page 1's last row of a tie group and never returns
// the other tied row -- same count, one duplicate, one missing (exactly the offset-boundary hazard).
const LEGACY_ORDER = { returns: ["return_date", "account_id", "child_asin", "sku"], settlement: ["settlement_date", "account_id", "child_asin", "sku"] };
const dupSkipTied = (read, cols) => async (a) => {
  const rows = await read(a);
  const k = (r) => JSON.stringify(cols.map((c) => S(r[c])));
  for (let i = 0; i < rows.length; i += 1) for (let j = i + 1; j < rows.length; j += 1) if (k(rows[i]) === k(rows[j])) { rows[j] = { ...rows[i] }; return rows; }
  throw new Error("fixture has no tied rows under the legacy order");
};
{
  const h0 = harness();
  const good = await RP.gatherReturnsEvidence(gatherArgs(), readersOf(h0.sb, h0.directory), { strict: true });
  ok("R11 the true read has NO repeated primary-key tuple (Returns + Settlement) and passes strict", !good.notReady && RP.duplicateKeyCount(good.evidence.durableReturnRows, RP.RETURNS_HISTORY_KEY_COLUMNS) === 0 && RP.duplicateKeyCount(good.evidence.durableSettlementRows, RP.SETTLEMENT_HISTORY_KEY_COLUMNS) === 0);
  const h = harness();
  h.sb.getReturnsHistoryRows = dupSkipTied(h.sb.getReturnsHistoryRows, LEGACY_ORDER.returns);
  const bad = await RP.gatherReturnsEvidence(gatherArgs(), readersOf(h.sb, h.directory), { strict: true });
  const badRows = await h.sb.getReturnsHistoryRows({ organizationFingerprint: ORG, connectionId: "primary", accountIds: [ACC], from: RSR.returnsWindow(EPOCH).from, to: EPOCH });
  ok("R11 a same-COUNT Returns read with one duplicate + one missing row -> strict notReady 'evidence-inconsistent:returns-duplicate' (the verifier's probe P3 was accepted before)",
    badRows.length === good.evidence.durableReturnRows.length && bad.notReady === "evidence-inconsistent:returns-duplicate" && !bad.payload);
  const s = await h.run();
  const u = h.unit(s);
  ok("R11 ... through the route: typed DEFERRED_DEPENDENCY 'bundle-evidence-inconsistent:returns-duplicate', ZERO writes, NO live row (never READBACK_VERIFIED with a wrong payload)",
    u.state === RS.DD && u.reason === "bundle-evidence-inconsistent:returns-duplicate" && s.counts.targetsPublished === 0 && h.w.writes() === 0 && !h.w.liveRow());
  const hs = harness();
  // an ORDER and a REFUND row of one SKU-day: tied under the legacy settlement order (currency + settlement_type omitted)
  hs.st.settlement.push({ ...hs.st.settlement[1], settlement_type: "ORDER", item_price: 500, refunded_amount: 0, refund_event_count: 0 });
  hs.sb.getSettlementHistoryRows = dupSkipTied(hs.sb.getSettlementHistoryRows, LEGACY_ORDER.settlement);
  const badS = await RP.gatherReturnsEvidence(gatherArgs(), readersOf(hs.sb, hs.directory), { strict: true });
  const sS = await hs.run();
  ok("R11 the same hazard on Settlement (an ORDER + REFUND row of one SKU-day) -> 'evidence-inconsistent:settlement-duplicate', ZERO writes",
    badS.notReady === "evidence-inconsistent:settlement-duplicate" && hs.unit(sS).reason === "bundle-evidence-inconsistent:settlement-duplicate" && hs.w.writes() === 0);
  // Defense in depth for ANY gatherer: resolveBundle itself refuses a duplicated hydrated row set.
  const dupGather = (which) => async (args, readers, opts) => {
    const r = await RP.gatherReturnsEvidence(args, readers, opts);
    const rows = r.evidence[which].slice(); rows[rows.length - 1] = { ...rows[0] };
    return { ...r, evidence: { ...r.evidence, [which]: rows } };
  };
  const hr = harness({ gatherEvidence: dupGather("durableReturnRows") });
  const br = await hr.runtime.resolveBundle(hr.unitOf(), { epoch: EPOCH });
  const hs2 = harness({ gatherEvidence: dupGather("durableSettlementRows") });
  const bs = await hs2.runtime.resolveBundle(hs2.unitOf(), { epoch: EPOCH });
  ok("R11 resolveBundle (count == SQL count(*) already) ALSO refuses a repeated key tuple from any gatherer: 'evidence-inconsistent:returns-duplicate' / 'evidence-inconsistent:settlement-duplicate'",
    br.eligible === false && br.reason === "evidence-inconsistent:returns-duplicate" && bs.eligible === false && bs.reason === "evidence-inconsistent:settlement-duplicate");
  const soft = await RP.gatherReturnsEvidence(gatherArgs(), readersOf(h.sb, h.directory));
  ok("R11 the NON-strict serve path is unchanged (no new refusal: it still builds from whatever the reader returned; the fix for the serve is the readers' total order, scripts/returns-history-reader-order.test.js)", !soft.notReady && !!soft.payload && soft.payload.version === "returns-leakage-v3");
  ok("R11 duplicateKeyCount: counts each repeat of an earlier key tuple; key columns = the 20260914 PKs minus the eq-pinned org + connection",
    RP.duplicateKeyCount([{ a: 1, b: 2 }, { a: 1, b: 2 }, { a: 1, b: 3 }, { a: 1, b: 2 }], ["a", "b"]) === 2 && RP.duplicateKeyCount([], ["a"]) === 0
    && JSON.stringify(RP.RETURNS_HISTORY_KEY_COLUMNS) === JSON.stringify(["account_id", "return_date", "sku", "child_asin", "amazon_return_reason", "fulfillment_channel", "request_status", "label_payer"])
    && JSON.stringify(RP.SETTLEMENT_HISTORY_KEY_COLUMNS) === JSON.stringify(["account_id", "settlement_date", "sku", "child_asin", "currency", "settlement_type"]));
}

// =====================================================================================================================
// R12. (verifier P3-1) an in-place UPDATE (the touch trigger bumps updated_at; count / refreshed_at / created_at / dates
//      unchanged) MOVES the L1 token -> STALE -> re-publish; worker token == CLI token.
// =====================================================================================================================
{
  const h = harness();
  await h.run();
  const before = h.w.liveRow();
  h.st.settlement[1].refunded_amount = -999; h.st.settlement[1].updated_at = "2026-09-24T09:00:00.000Z";
  const scan = await h.run({ dryRun: true });
  const wt = (await h.workerCompose()).get(ACC);
  ok("R12 an in-place Settlement UPDATE (only updated_at + the amount move) changes the L1 token -> STALE on a plain scan (was PUBLICATION_NOT_REQUIRED before), and the worker's compose token == the CLI's",
    h.unit(scan).state === RS.ST && scan.perAccount[0].evidenceToken !== before.params.evidenceToken && wt.token === scan.perAccount[0].evidenceToken);
  const s = await h.run();
  const after = h.w.liveRow();
  ok("R12 ... it RE-PUBLISHES the corrected money (new evidence + manifest tokens, a different payload) and then verifies", s.counts.targetsPublished === 1 && after.params.evidenceToken === wt.token && after.params.manifestToken !== before.params.manifestToken && B.stableJson(after.payload) !== B.stableJson(before.payload) && h.unit(await h.run({ dryRun: true, verifyExact: true })).state === RS.NR);
  const tok2 = after.params.evidenceToken;
  h.st.returns[0].fbm_refunded_amount = 7; h.st.returns[0].updated_at = "2026-09-24T10:00:00.000Z";
  const scan2 = await h.run({ dryRun: true });
  ok("R12 the same for an in-place Returns UPDATE", h.unit(scan2).state === RS.ST && scan2.perAccount[0].evidenceToken !== tok2 && (await h.workerCompose()).get(ACC).token === scan2.perAccount[0].evidenceToken);
  const MIG = path.join(ROOT, "supabase", "migrations");
  const ddl = readFileSync(path.join(MIG, "20260914_returns_leakage_durable.sql"), "utf8");
  const base = readFileSync(path.join(MIG, "20260728_shared_dashboard.sql"), "utf8");
  const bodyOf = (t) => (ddl.match(new RegExp("create table if not exists public\\." + t + " \\(([\\s\\S]*?)\\n\\);")) || [])[1] || "";
  const trig = (t, name) => new RegExp("create trigger " + name + "\\s+before update on public\\." + t + "\\s+for each row execute function public\\.touch_updated_at\\(\\);").test(ddl)
    && /\n {2}updated_at timestamptz not null default now\(\),/.test(bodyOf(t));
  const sqlOf = (n) => WORKER.evidence.sql.find((q) => q.name === n).text;
  ok("R12 static: both tables declare updated_at + a BEFORE UPDATE touch trigger (20260914), touch_updated_at sets new.updated_at = now() (20260728), and BOTH evidence SELECTs read max(updated_at) as UTC text",
    trig("source_returns_history", "source_returns_hist_touch") && trig("source_settlement_history", "source_settle_hist_touch") && /create or replace function public\.touch_updated_at\(\)[\s\S]*?new\.updated_at = now\(\);/.test(base)
    && ["returns", "settlement"].every((n) => sqlOf(n).includes("to_char(max(updated_at) at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as updated")));
}

// =====================================================================================================================
// R13. (verifier P3-2) the proven OLI covered_to is computed ONLY over windows overlapping [from, asOf] (as L1): a later
//      window does not churn the manifest; the release cross-checks it against the token.
// =====================================================================================================================
{
  const h = harness();
  await h.run();
  const before = h.w.liveRow();
  h.st.coverage.push({ ...own, account_id: ACC, source_key: "order-line-items", status: "succeeded", covered_from: "2026-09-25", covered_to: "2026-09-30", source_refreshed_at: "2026-09-30T01:00:00.000Z", updated_at: "2026-09-30T01:00:00.000Z" });
  const g = await RP.gatherReturnsEvidence(gatherArgs(), readersOf(h.sb, h.directory), { strict: true });
  ok("R13 a LATER succeeded OLI window (2026-09-25..30, outside [from, epoch]) is ignored by the strict gather: covered_to stays the window-scoped " + EPOCH, g.evidence.oliCoveredTo === EPOCH);
  const v = await h.run({ dryRun: true, verifyExact: true });
  ok("R13 ... so neither the L1 token nor the manifest moves: --verify-exact stays PUBLICATION_NOT_REQUIRED (was STALE 'manifest-differs'), zero writes",
    h.unit(v).state === RS.NR && h.unit(v).reason === null && v.perAccount[0].evidenceToken === before.params.evidenceToken);
  // The overlap bounds are INCLUSIVE on both sides (covered_from <= epoch, covered_to >= from), exactly like the SQL: a
  // window STARTING on the epoch overlaps, so both the token and the gather take its end.
  const h2 = harness();
  h2.st.coverage[0].covered_to = "2026-09-23";
  h2.st.coverage.push({ ...own, account_id: ACC, source_key: "order-line-items", status: "succeeded", covered_from: EPOCH, covered_to: "2026-09-30", source_refreshed_at: "2026-09-30T01:00:00.000Z", updated_at: "2026-09-30T01:00:00.000Z" });
  const g2 = await RP.gatherReturnsEvidence(gatherArgs(), readersOf(h2.sb, h2.directory), { strict: true });
  const s2 = await h2.run();
  ok("R13 a window starting ON the epoch overlaps (inclusive, as the SQL): gather covered_to = its end = the token's, so the route publishes (no 'evidence-inconsistent:oli')",
    g2.evidence.oliCoveredTo === "2026-09-30" && (await h2.workerCompose()).get(ACC).token !== null && s2.counts.targetsPublished === 1 && h2.unit(s2).state === RS.RV);
  ok("R13 a window ending BEFORE `from` or starting AFTER the epoch never counts; the end of an overlapping one does", RSR.returnsWindow(EPOCH).from === "2026-07-27"
    && (await RP.gatherReturnsEvidence(gatherArgs(), { ...readersOf(h2.sb, h2.directory), readOliCoverage: async () => ({ read: "ok", windows: [{ from: "2025-01-01", to: "2026-07-26" }, { from: "2026-07-27", to: "2026-09-24" }, { from: "2026-09-25", to: "2026-12-31" }] }) }, { strict: true })).evidence.oliCoveredTo === "2026-09-24"
    && (await RP.gatherReturnsEvidence(gatherArgs(), { ...readersOf(h2.sb, h2.directory), readOliCoverage: async () => ({ read: "ok", windows: [{ from: "2025-01-01", to: "2026-07-26" }, { from: "2026-09-25", to: "2026-12-31" }] }) }, { strict: true })).notReady === "oli-coverage-short");
  const skew = async (args, readers, opts) => { const r = await RP.gatherReturnsEvidence(args, readers, opts); return { ...r, evidence: { ...r.evidence, oliCoveredTo: "2026-09-30" } }; };
  const h3 = harness({ gatherEvidence: skew });
  const b3 = await h3.runtime.resolveBundle(h3.unitOf(), { epoch: EPOCH });
  const s3 = await h3.run();
  ok("R13 resolveBundle cross-checks the gathered covered_to against the token's: a mismatch (a coverage write between the reads) defers 'evidence-inconsistent:oli', zero writes",
    b3.eligible === false && b3.reason === "evidence-inconsistent:oli" && h3.unit(s3).reason === "bundle-evidence-inconsistent:oli" && h3.w.writes() === 0);
}

// =====================================================================================================================
// R14. (verifier P3-3) a validated catalog snapshot with ZERO rows is no catalog proof in strict mode.
// =====================================================================================================================
{
  const h = harness();
  h.st.catalog.payload = { rows: [] };
  const strict = await RP.gatherReturnsEvidence(gatherArgs(), readersOf(h.sb, h.directory), { strict: true });
  const soft = await RP.gatherReturnsEvidence(gatherArgs(), readersOf(h.sb, h.directory));
  ok("R14 an EMPTY validated catalog ({ rows: [] }) -> strict notReady 'catalog-missing' (never a brandless payload); non-strict unchanged (still builds, catalogBrands [])",
    strict.notReady === "catalog-missing" && !strict.payload && !!soft.payload && soft.payload.catalogBrands.length === 0);
  const s = await h.run();
  ok("R14 ... through the route: 'bundle-catalog-missing', ZERO writes, no live row", h.unit(s).state === RS.DD && h.unit(s).reason === "bundle-catalog-missing" && h.w.writes() === 0 && !h.w.liveRow());
  const h2 = harness();
  h2.st.catalog.payload = [];
  ok("R14 the bare-array form [] is refused the same way", (await RP.gatherReturnsEvidence(gatherArgs(), readersOf(h2.sb, h2.directory), { strict: true })).notReady === "catalog-missing");
}

// =====================================================================================================================
// R15. (verifier P3-5) the worker compose over an ARRAY directory applies buildDurableDirectory's exclusions, so the worker
//      and the CLI (always a buildDurableDirectory Map) can never disagree on eligibility.
// =====================================================================================================================
{
  const h = harness();
  const ctx = { epoch: EPOCH, accountIds: [ACC], organizationFingerprint: ORG, connectionId: "primary" };
  const rowsByName = {};
  for (const q of WORKER.evidence.sql) rowsByName[q.name] = await h.pgReadOnly(q.text, q.params(ctx));
  const compose = (directory) => WORKER.evidence.compose(rowsByName, { epoch: EPOCH, now: () => h.nowMs, directory, accountIds: [ACC] }).get(ACC);
  const viaMap = compose(h.directory);
  const dupRows = [{ accountId: ACC, country: "IN" }, { accountId: ACC, country: "AE" }];
  const dupMap = REL.buildDurableDirectory({ rows: dupRows, resolveRawSellerId: (id) => "raw-" + id, normalizeMarketplace: OSE.normalizeMarketplace }).directory;
  const arrDup = compose(dupRows);
  const mapDup = compose(dupMap);
  ok("R15 a DUPLICATED account row in an array directory -> no country -> token null 'directory-country-missing', EXACTLY what the CLI's buildDurableDirectory Map gives (the verifier's Q5 was eligible)",
    arrDup.token === null && arrDup.reason === "directory-country-missing" && mapDup.token === null && mapDup.reason === arrDup.reason && !dupMap.has(ACC));
  ok("R15 ... a duplicate with the SAME country is excluded too (buildDurableDirectory excludes ANY repeated id)", compose([{ accountId: ACC, country: "IN" }, { accountId: ACC, country: "IN" }]).token === null);
  ok("R15 a single array row (ids compared trimmed, like buildDurableDirectory) gives the SAME token as the Map; a prefixed ':' id never has a country",
    compose([{ accountId: ACC, country: "IN" }]).token === viaMap.token && compose([{ accountId: " " + ACC + " ", country: "in" }]).token === viaMap.token && !!viaMap.token
    && WORKER_MOD.returnsEvidenceByAccount(rowsByName, { epoch: EPOCH, accountIds: ["p:" + ACC], directory: [{ accountId: "p:" + ACC, country: "IN" }] }).get("p:" + ACC).country === "");
}

// =====================================================================================================================
// R16. (verifier P3-4 / P3-6) golive: the acquisition pg client is closed right after the cycle and BEFORE the blocking
//      route spawn (+ an 'error' listener); out-of-scope accounts raise a typed RETURNS_ALERT + a workflow output.
// =====================================================================================================================
{
  const golive = src("scripts/release/returns-leakage-golive.mjs");
  const code = golive.split("\n").filter((l) => !/^\s*\/\//.test(l)).map((l) => l.replace(/\s\/\/\s.*$/, "")).join("\n");
  const at = (needle, from = 0) => code.indexOf(needle, from);
  const iNew = at("const pgClient = new pg.Client(");
  const iListener = at('pgClient.on("error", ');
  const iConnect = at("await pgClient.connect();");
  const iCycle = at("const summary = await runReturnsBucketCycle(");
  const iEnd = at("await endPgClient();", iCycle);
  const iRoute = at("await publishViaRoute(");
  ok("R16 golive: an 'error' listener is attached to the acquisition pg client BEFORE connect (an idle drop never crashes the operator)", iNew >= 0 && iNew < iListener && iListener < iConnect);
  ok("R16 golive: the client is ended right after runReturnsBucketCycle returns and BEFORE the blocking route spawn (publishViaRoute)", iCycle > 0 && iEnd > iCycle && iEnd < iRoute && !code.slice(code.indexOf("\n", iCycle), iEnd).includes("await "));
  const endFn = (code.match(/function endPgClient\(\) \{[\s\S]*?\n\}/) || [""])[0];
  ok("R16 golive: endPgClient ends the client ONCE (memoized), bounded by a timer (a dropped socket can never hang on 'end'); no other pgClient.end() call remains",
    /if \(!pgClientEnded\)/.test(endFn) && /Promise\.race\(\[pgClient\.end\(\)\.catch\(\(\) => \{\}\), new Promise\(\(resolve\) => \{ timer = setTimeout\(resolve, \d+\); \}\)\]\)/.test(endFn) && /clearTimeout\(timer\)/.test(endFn)
    && (code.match(/pgClient\.end\(/g) || []).length === 1 && (code.match(/await endPgClient\(\);/g) || []).length === 3);
  const none = CLI_MOD.returnsOutOfScopeAlert([]);
  const a = CLI_MOD.returnsOutOfScopeAlert(["UNKNOWN", "NOCOUNTRY", "UNKNOWN", " "]);
  ok("R16 returnsOutOfScopeAlert: null when none; else the typed line 'RETURNS_ALERT {\"outOfScope\":n,\"accounts\":[...]}' (distinct, sorted) + 'returns_out_of_scope=<n>'",
    none === null && a.line === 'RETURNS_ALERT {"outOfScope":2,"accounts":["NOCOUNTRY","UNKNOWN"]}' && a.githubOutput === "returns_out_of_scope=2" && JSON.parse(a.line.slice(CLI_MOD.RETURNS_ALERT_PREFIX.length)).outOfScope === 2);
  const pv = (code.match(/async function publishViaRoute\(accountIds\) \{[\s\S]*?\n\}/) || [""])[0];
  ok("R16 golive: step 7 emits the alert line and appends the GITHUB_OUTPUT value when outOfScope > 0; the exit-code rule is unchanged (hard stop 2, failed route invocation 1, else 0)",
    /const alert = returnsOutOfScopeAlert\(plan\.outOfScope\);/.test(pv) && /log\(alert\.line\)/.test(pv) && /appendFileSync\(process\.env\.GITHUB_OUTPUT, alert\.githubOutput \+ "\\n"\)/.test(pv)
    && /import \{ readFileSync, existsSync, appendFileSync \} from "node:fs";/.test(code) && /process\.exit\(hardStop \? 2 : \(routeFailed \? 1 : 0\)\);/.test(code));
}

ok("ZERO network calls across the whole suite (zero DataDoe exports / tokens)", net.calls.length === 0);
void R1;
out(`returns-v3-route: ${passed} passed`);
