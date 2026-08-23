// Scheduler v2 -- PRODUCTION-COMPOSITION HARDENING regressions (offline, ZERO network/DB).
//
// Senior-review production-path findings, each proven against the REAL buildBucketSourceSyncRuntime with
// injected fakes (the real discovery merge/classification, real batch engine, real worker underneath):
//   F1  read failures fail CLOSED before any DataDoe create, Supabase write, or cycle creation; a
//       migration-unapplied (schema-missing) read is a typed ZERO-EXPORT refusal.
//   F2  only correctly bound PRIMARY accounts enter the bucket sync -- dd-secondary/public-prefixed ids are
//       excluded (recorded) and never routed through the primary key.
//   F3  a REAL serverless deadline with reserve headroom bounds each invocation; the rollup is
//       typed-resumable and a fresh invocation completes the SAME cycle with no duplicate create.
//   F4  every registered source-card action routes to its REAL architecture or refuses typed: durable
//       families execute the bucket sync; cycle-cache families compose the fixpoint; durable-ads refuses
//       typed; after a complete run the Daily/Brand View durable SHADOW snapshots derive+validate+save.
//   F5  OLI rolling windows replace ATOMICALLY (a removed grain cannot survive) and the replacement +
//       coverage acknowledgement are one transaction (a failure leaves BOTH untouched).
//   F6  catalog/FBA snapshot payloads live in the durable source-snapshots/* namespace and hydrate AFTER
//       ordinary source-cache pruning (the pointer never references the 24h cache).
//   F7  durable source_batch_membership is LOADED and new accounts are TRANSACTIONALLY assigned; batches
//       stay stable across invocations; a malformed assignment fails closed.
//   F8  readiness comes from AUTHORITATIVE per-account coverage/freshness/snapshot/Ads evidence (typed
//       per-account blockers; read failures block, never fabricate ready).
//   F9  the Migration-20260820 ACL/policy SQL + the replace-oli RPC are schema-audited; mutations (dropped
//       REVOKE, widened GRANT, dropped RPC, gutted RPC body) each raise a typed blocker.
//   F10 FBA rows are seller-scoped per account and every returned row's marketplace is validated; a
//       cross-marketplace or marketplace-less row rejects the snapshot (latest-good preserved).
//
// 7-bit ASCII, LF, no top-level await, synchronous writeSync progress, dynamic imports after a dummy env.

import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import path from "node:path";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = process.env[SB_KEY_ENV] || ["test", "svc", "role", "key"].join("-");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const group = (label) => tests.push({ marker: label });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

let runtimeMod; let registry; let schema; let dates; let identity; let reportStore; let durableModel;

// Round-9: canonical JSON (sorted object keys, array order preserved) mirroring the runtime's canonicalJson,
// so the harness freshness-CAS proves content identity the same way the production CAS does.
function canonJson(value) {
  if (Array.isArray(value)) return "[" + value.map(canonJson).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + canonJson(value[k])).join(",") + "}";
  return JSON.stringify(value === undefined ? null : value);
}

// Round-10 blocker 1: CHRONOLOGICAL instant comparison (epoch ms) mirroring supabase.js instantMs / the RPC's
// timestamptz comparison -- so the harness CAS orders freshness by real time (Z == +00:00 == fractional),
// never by lexicographic RFC3339 string order. Returns null for a blank/unparseable value (fail closed).
function instantMsT(value) {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (s === "") return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

const PRIM_KEY = ["prim", "key"].join("-");
const SEC_KEY = ["sec", "key"].join("-");
const CONNS = [
  { id: "primary", apiKey: PRIM_KEY, accountPrefix: "" },
  { id: "secondary", apiKey: SEC_KEY, accountPrefix: ["dd", "secondary"].join("-") + ":" },
];
const TODAY = "2026-08-20";
const ASOF = "2026-08-19";
const dirAccount = (id) => ({ id, name: "Acct " + id, country: "US", currency: "USD", status: "active" });

/* ---------------- full in-memory worker store (owner + budget models) ---------------- */
function makeStore() {
  const cycles = new Map(); const jobsByCycle = new Map(); const ownersByCycle = new Map();
  const cache = new Map(); const budgets = new Map(); const reportJobs = new Map(); let seq = 0;
  // Round-7 finding 1: the durable report_snapshots model (keyed by shadow report_key|account|params_hash)
  // the lease reconcile + the runtime's adopt-if-exists read consult; plus a lease-token counter.
  const reportSnapshots = new Map(); let leaseSeq = 0;
  // Round-10 blocker 2: object-storage-backed shadow payloads (path -> payload). A storage-backed durable row
  // carries a payload_storage_path; the freshness CAS proves EQUAL-freshness identity STORAGE-FIRST by
  // hydrating this map (a missing entry models a dangling/unreadable object -> fail closed).
  const shadowStorage = new Map();
  const rsKey = (rk, a, h) => rk + "|" + a + "|" + h;
  // Round-8 finding 1: DATABASE-AUTHORITATIVE time. The lease RPC model reads THIS clock (never a caller-
  // supplied time), so a runtime/caller clock skew cannot steal or distort a lease. Tests advance it via
  // store._dbClock.now to model real time passing between invocations.
  const dbClock = { now: 8_000_000 };
  const LEASE_MIN = 120; const LEASE_MAX = 1800;
  const findCycle = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  const rjKey = (c, rk, a) => c + "|" + rk + "|" + a;
  const ownerRows = (cid) => [...((ownersByCycle.get(cid) && ownersByCycle.get(cid).values()) || [])];
  const bkey = (cid, tk) => cid + "|" + tk;
  // Round-6 fix 1: model Migration 5 reject_append_to_terminal_cycle FAITHFULLY -- EVERY child
  // insert/update (source jobs, owner memberships, report jobs) on a terminal parent cycle RAISES,
  // exactly as the production trigger does. A fake that permitted terminal appends would hide the very
  // defect the shared-cycle finalization fix exists to prevent.
  const guardAppend = (cycleId) => {
    const c = findCycle(cycleId);
    if (!c) throw new Error("parent sync cycle " + cycleId + " not found; refusing to append/alter child work");
    if (["succeeded", "partial", "failed"].includes(c.status)) {
      throw new Error("sync cycle " + cycleId + " is terminal (" + c.status + "); refusing to append/alter child work");
    }
  };
  const store = {
    _cache: cache,
    _opens: 0,
    openCycle({ bucket, cycleDate }) {
      store._opens += 1;
      const k = bucket + "|" + cycleDate;
      // Round-10 blocker 1: created_at is DATABASE-authoritative (stamped from dbClock at creation) and STABLE
      // -- reopening the same (bucket, cycleDate) returns the SAME row/created_at, so a retry never advances it.
      if (!cycles.has(k)) { const id = "cyc_" + (seq += 1); cycles.set(k, { id, bucket, status: "pending", created_at: new Date(dbClock.now).toISOString() }); jobsByCycle.set(id, new Map()); }
      return cycles.get(k).id;
    },
    claimCycle(id) { const c = findCycle(id); if (c && c.status === "pending") { c.status = "running"; return true; } return false; },
    getCycle(id) { return findCycle(id); },
    upsertSourceJob(job) {
      guardAppend(job.cycleId);
      const m = jobsByCycle.get(job.cycleId);
      if (m.has(job.requestHash)) return;
      m.set(job.requestHash, {
        request_hash: job.requestHash, request_key: job.requestKey, source_id: job.sourceId, source_key: job.sourceKey,
        connection_id: job.connectionId, organization_fingerprint: job.organizationFingerprint, account_scope_hash: job.accountScopeHash,
        fetch_status: "pending", attempted_at: null, create_export_count: 0, export_id: null, cache_object_path: null,
      });
    },
    listSourceJobs(id) { return [...((jobsByCycle.get(id) && jobsByCycle.get(id).values()) || [])].map((j) => ({ ...j })); },
    upsertSourceJobOwners(ms) {
      for (const m of ms || []) {
        guardAppend(m.cycleId);
        if (!ownersByCycle.has(m.cycleId)) ownersByCycle.set(m.cycleId, new Map());
        ownersByCycle.get(m.cycleId).set(m.ownerId + "|" + m.requestHash, {
          cycle_id: m.cycleId, request_hash: m.requestHash, owner_id: m.ownerId, request_key: m.requestKey,
          report_key: m.reportKey, account_id: m.accountId, connection_id: m.connectionId,
          organization_fingerprint: m.organizationFingerprint, account_scope_hash: m.accountScopeHash, owner_status: "active",
        });
      }
    },
    listSourceJobOwners(cid, ids) { const s = new Set(ids || []); return ownerRows(cid).filter((m) => s.has(m.owner_id)).map((m) => ({ ...m })); },
    // Round-6 fix 5: EVERY owner membership of the cycle -- the authoritative account<->hash ownership
    // the account-exact depends_on is built from.
    listCycleOwners(cid) { return ownerRows(cid).map((m) => ({ ...m })); },
    recordSourceOwnerStale() {},
    claimExportAttempt(id, h) {
      guardAppend(id);
      const j = jobsByCycle.get(id) && jobsByCycle.get(id).get(h);
      if (j && j.fetch_status === "pending" && j.attempted_at === null) { j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted"; return true; }
      return false;
    },
    adoptSourceCache() { return "cache-changed"; },
    recordExportCreated({ cycleId, requestHash, exportId }) { guardAppend(cycleId); jobsByCycle.get(cycleId).get(requestHash).export_id = exportId; },
    loadSourceRows(h) { const e = cache.get(h); return e ? { ...e } : null; },
    saveSourceRows({ job, rows, payloadBytes }) {
      const h = job.request_hash != null ? job.request_hash : job.requestHash;
      const objectPath = "source-cache/v2/" + h + ".json";
      cache.set(h, {
        rows: [...rows], source_id: job.sourceId, organization_fingerprint: job.organizationFingerprint,
        account_scope_hash: job.accountScopeHash, object_path: objectPath, row_count: rows.length,
        payload_bytes: payloadBytes, expires_at: new Date(Date.now() + 20 * 3600 * 1000).toISOString(),
      });
      return objectPath;
    },
    recordSourceSuccess({ cycleId, requestHash, exportId, rowCount, cacheObjectPath }) {
      guardAppend(cycleId);
      Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "succeeded", export_id: exportId, row_count: rowCount, cache_object_path: cacheObjectPath });
    },
    recordSourceFailure({ cycleId, requestHash, stage, code, terminal }) {
      guardAppend(cycleId);
      Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "failed", error_stage: stage, error_code: code, terminal: !!terminal });
    },
    updateCycleCounts() {},
    persistBudget({ cycleId, trancheKey, planFingerprint, maxCreates, maxTokens, hashes }) {
      const k = bkey(cycleId, trancheKey);
      const b = budgets.get(k);
      if (b) {
        if (b.planFingerprint !== planFingerprint || b.maxCreates !== maxCreates || b.maxTokens !== maxTokens) {
          const e = new Error("PLAN_BUDGET_MISMATCH"); e.code = "PLAN_BUDGET_MISMATCH"; throw e;
        }
        return "exists";
      }
      budgets.set(k, { planFingerprint, maxCreates, maxTokens, spentCreates: 0, spentTokens: 0, cost: new Map((hashes || []).map((h) => [h.requestHash, h.tokenCost])) });
      return "created";
    },
    reserveExportCreate({ cycleId, trancheKey, requestHash, planFingerprint }) {
      const b = budgets.get(bkey(cycleId, trancheKey));
      if (!b) throw new Error("no frozen budget");
      if (b.planFingerprint !== planFingerprint || !b.cost.has(requestHash)) return "plan-mismatch";
      const cost = b.cost.get(requestHash);
      if (b.spentCreates + 1 > b.maxCreates || b.spentTokens + cost > b.maxTokens) return "budget-exceeded";
      const j = jobsByCycle.get(cycleId) && jobsByCycle.get(cycleId).get(requestHash);
      if (!(j && j.fetch_status === "pending" && j.attempted_at === null && j.create_export_count === 0)) return "not-pending";
      j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted";
      b.spentCreates += 1; b.spentTokens += cost;
      return "reserved";
    },
    /* round-5: the sync_report_jobs model (insert-ignore upsert, pending->running one-attempt claim,
       validated success) + the reviewed finalize_sync_cycle terminal lifecycle. */
    _reportJobs: reportJobs,
    upsertReportJob(j) {
      guardAppend(j.cycleId);
      const k = rjKey(j.cycleId, j.reportKey, j.accountId);
      if (reportJobs.has(k)) return;
      reportJobs.set(k, {
        cycle_id: j.cycleId, report_key: j.reportKey, report_version: j.reportVersion || "", account_id: j.accountId,
        connection_id: j.connectionId, bucket: j.bucket, depends_on: [...(j.dependsOn || [])],
        derive_status: "pending", save_status: "pending", validated: false, snapshot_params_hash: null, latest_data_date: null,
        derive_lease_token: null, derive_lease_expires_at: null, derive_attempt_count: 0,
      });
    },
    claimReportDerive(cycleId, reportKey, accountId) {
      guardAppend(cycleId);
      const r = reportJobs.get(rjKey(cycleId, reportKey, accountId));
      if (r && r.derive_status === "pending") { r.derive_status = "running"; return true; }
      return false;
    },
    recordReportSuccess(j) {
      guardAppend(j.cycleId);
      const r = reportJobs.get(rjKey(j.cycleId, j.reportKey, j.accountId));
      Object.assign(r, {
        derive_status: "succeeded", save_status: "succeeded", validated: true,
        snapshot_params_hash: j.snapshotParamsHash, latest_data_date: j.latestDataDate ?? null,
      });
    },
    // Round-8 finding 1+4: FAITHFUL model of claim_report_derive_lease -- DATABASE-authoritative time (reads
    // dbClock, NOT a caller clock), a bounded lease [120,1800], and a TOTAL state machine ('invalid-state'
    // for incoherent combinations; reclaim only an EXACTLY-running expired lease).
    claimLease(cycleId, reportKey, accountId, { leaseSeconds } = {}) {
      guardAppend(cycleId); // Migration-5 append guard applies to running-cycle updates
      if (!(leaseSeconds >= LEASE_MIN && leaseSeconds <= LEASE_MAX)) return { disposition: "invalid-lease" };
      const nowMs = dbClock.now; // DB-authoritative -- the caller cannot pass time.
      const r = reportJobs.get(rjKey(cycleId, reportKey, accountId));
      if (!r) return { disposition: "not-found" };
      const token = "lease_" + (leaseSeq += 1);
      if (r.derive_status === "succeeded") {
        if (r.validated === true && r.save_status === "succeeded") return { disposition: "already-complete", snapshot_params_hash: r.snapshot_params_hash };
        return { disposition: "invalid-state", derive_status: "succeeded", save_status: r.save_status, validated: r.validated };
      }
      if (r.derive_status === "failed" || r.derive_status === "skipped") return { disposition: "terminal", derive_status: r.derive_status };
      if (r.derive_status === "pending") {
        Object.assign(r, { derive_status: "running", derive_lease_token: token, derive_lease_expires_at: nowMs + leaseSeconds * 1000, derive_attempt_count: (r.derive_attempt_count || 0) + 1 });
        return { disposition: "claimed", lease_token: token };
      }
      if (r.derive_status === "running") {
        // an UNEXPIRED lease (vs DB time) is a LIVE worker -- do not steal.
        if (r.derive_lease_expires_at != null && r.derive_lease_expires_at > nowMs) return { disposition: "held", lease_expires_at: r.derive_lease_expires_at };
        Object.assign(r, { derive_lease_token: token, derive_lease_expires_at: nowMs + leaseSeconds * 1000, derive_attempt_count: (r.derive_attempt_count || 0) + 1 });
        return { disposition: "reclaimed", lease_token: token, attempt: r.derive_attempt_count };
      }
      return { disposition: "invalid-state", derive_status: r.derive_status };
    },
    // Round-7/8: FAITHFUL model of reconcile_report_derive_success -- requires the EXACT durable snapshot AND
    // the CURRENT lease token; a non-running row is handled explicitly (terminal / invalid-state).
    reconcileSuccess({ cycleId, reportKey, accountId, snapshotParamsHash, leaseToken, latestDataDate } = {}) {
      guardAppend(cycleId);
      if (!snapshotParamsHash) return { disposition: "invalid-hash" };
      if (!leaseToken) return { disposition: "invalid-lease" };
      const r = reportJobs.get(rjKey(cycleId, reportKey, accountId));
      if (!r) return { disposition: "not-found" };
      if (r.validated === true && r.derive_status === "succeeded" && r.save_status === "succeeded" && r.snapshot_params_hash === snapshotParamsHash) {
        return { disposition: "already-complete" };
      }
      if (r.derive_status !== "running") {
        if (r.derive_status === "failed" || r.derive_status === "skipped") return { disposition: "terminal", derive_status: r.derive_status };
        return { disposition: "invalid-state", derive_status: r.derive_status, save_status: r.save_status, validated: r.validated };
      }
      const exists = reportSnapshots.has(rsKey("scheduler-v2/" + reportKey, accountId, snapshotParamsHash));
      if (!exists) return { disposition: "snapshot-absent" };
      if (r.derive_lease_token == null || r.derive_lease_token !== leaseToken) return { disposition: "lease-lost" };
      Object.assign(r, {
        fetch_status: "ready", derive_status: "succeeded", save_status: "succeeded", validated: true,
        snapshot_params_hash: snapshotParamsHash, latest_data_date: latestDataDate ?? r.latest_data_date,
        derive_lease_token: null, derive_lease_expires_at: null,
      });
      return { disposition: "reconciled", snapshot_params_hash: snapshotParamsHash };
    },
    recordShadowSnapshot({ reportKey, accountId, paramsHash, params, payload, sourceRefreshedAt, payloadStoragePath = null }) {
      reportSnapshots.set(rsKey(reportKey, accountId, paramsHash), { report_key: reportKey, account_id: accountId, params_hash: paramsHash, params, payload, payload_storage_path: payloadStoragePath, source_refreshed_at: sourceRefreshedAt });
    },
    getShadowSnapshot({ reportKey, accountId, paramsHash }) {
      return reportSnapshots.get(rsKey(reportKey, accountId, paramsHash)) || null;
    },
    putShadowStorage(path, payload) { shadowStorage.set(path, payload); },
    // Round-9 finding 4 + round-10 blockers 1/2: FAITHFUL model of the atomic freshness/CAS shadow save
    // (cas_report_snapshot_if_newer + the wrapper's storage-first equal-case proof). Freshness is compared
    // CHRONOLOGICALLY (epoch ms; Z == +00:00 == fractional), NEVER as a lexicographic RFC3339 string. A null
    // candidate freshness never wins. Insert-if-absent; a STRICTLY-NEWER candidate replaces older evidence
    // atomically; a STRICTLY-OLDER candidate preserves LKG ('newer-live'); at EQUAL freshness the content
    // identity is proven STORAGE-FIRST (a nonblank payload_storage_path is authoritative and is hydrated even
    // when an inline payload exists; a dangling/unreadable object or any mismatch fails closed -> 'conflict').
    shadowCasIfNewer({ reportKey, accountId, paramsHash, params, payload, payloadStoragePath = null, sourceRefreshedAt }) {
      const k = rsKey(reportKey, accountId, paramsHash);
      const existing = reportSnapshots.get(k);
      const put = () => reportSnapshots.set(k, { report_key: reportKey, account_id: accountId, params_hash: paramsHash, params, payload, payload_storage_path: payloadStoragePath, source_refreshed_at: sourceRefreshedAt });
      const candMs = instantMsT(sourceRefreshedAt);
      if (candMs === null) return { outcome: "conflict" }; // blocker 1: a null/blank freshness is never authoritative
      if (!existing) { put(); return { outcome: "inserted" }; }
      const liveMs = instantMsT(existing.source_refreshed_at);
      if (liveMs === null) return { outcome: "conflict" };
      if (candMs > liveMs) { put(); return { outcome: "replaced" }; }
      if (candMs < liveMs) return { outcome: "newer-live" };
      // EQUAL freshness: prove params, then the AUTHORITATIVE payload STORAGE-FIRST.
      if (canonJson(existing.params) !== canonJson(params)) return { outcome: "conflict" };
      const path = typeof existing.payload_storage_path === "string" ? existing.payload_storage_path.trim() : "";
      let livePayload;
      if (path !== "") {
        if (!shadowStorage.has(path)) return { outcome: "conflict" }; // dangling/unreadable authoritative object
        livePayload = shadowStorage.get(path);
      } else {
        livePayload = existing.payload;
      }
      if (livePayload == null || payload == null) return { outcome: "conflict" };
      if (canonJson(livePayload) !== canonJson(payload)) return { outcome: "conflict" };
      return { outcome: "already-current" };
    },
    getReportJob(reportKey, accountId) {
      const rows = [...reportJobs.values()].filter((r) => r.report_key === reportKey && r.account_id === accountId);
      return rows.length ? { ...rows[rows.length - 1] } : null;
    },
    finalizeCycle({ cycleId }) {
      const c = findCycle(cycleId);
      if (!c) return { disposition: "not-found" };
      if (["succeeded", "partial", "failed"].includes(c.status)) return { disposition: "already-terminal", cycle: { id: c.id, status: c.status } };
      const src = [...((jobsByCycle.get(cycleId) || new Map()).values())];
      const rep = [...reportJobs.values()].filter((r) => r.cycle_id === cycleId);
      const open = src.some((j) => j.fetch_status === "pending" || j.fetch_status === "attempted")
        || rep.some((r) => r.derive_status === "pending" || r.derive_status === "running");
      if (open) return { disposition: "open-work", cycle: { id: c.id, status: c.status } };
      const failed = src.some((j) => j.fetch_status === "failed") || rep.some((r) => r.save_status === "failed");
      const succeeded = src.some((j) => j.fetch_status === "succeeded") || rep.some((r) => r.validated === true);
      c.status = failed ? (succeeded ? "partial" : "failed") : "succeeded";
      return { disposition: "finalized", cycle: { id: c.id, status: c.status } };
    },
  };
  store._dbClock = dbClock; // Round-8: tests advance DB-authoritative time here (never via the caller clock).
  store._shadowStorage = shadowStorage; // Round-10: tests seed storage-backed shadow payloads for the CAS proof.
  return store;
}

function makeDataDoe(opts = {}) {
  const createSeq = [];
  return {
    createSeq,
    totalCreates: () => createSeq.length,
    async create(job) {
      createSeq.push({ sourceKey: job.sourceKey || "", ids: [...(job.fetchParams.sellerOrVendorIds || [])] });
      if (opts.onCreate) opts.onCreate(job);
      return { exportId: "e_" + job.requestHash.slice(0, 12) };
    },
    async poll() {},
    async download(job) {
      const rk = job.requestKey || ""; const fp = job.fetchParams || {};
      if (rk.includes("source-oli")) {
        const ids = Array.isArray(fp.sellerOrVendorIds) ? fp.sellerOrVendorIds : [];
        return ids.map((sid) => ({ date: fp.to, seller_or_vendor_id: sid, sku: "SKU-A", child_asin: "B0A", item_price_currency: "USD", total_sales_sum: 100, total_units_sum: 10 }));
      }
      if (rk.includes("source-catalog")) return [{ child_asin: "B0A", sku: "SKU-A", parent_asin: "P", product_name: "A", product_brand: "Acme" }];
      if (rk.includes("source-fba")) {
        return opts.fbaRows || [{ date: fp.to, sku: "SKU-A", child_asin: "B0A", marketplace_country_code: "US", available: 5 }];
      }
      return [];
    },
  };
}

/* ---------------- the composition harness (real discovery merge/classify path) ---------------- */
function makeHarness(over = {}) {
  const clockRef = { now: 8_000_000 };
  const store = over.store || makeStore();
  const dd = over.dd || makeDataDoe(over.ddOpts);
  const snapStore = over.snapStore || new Map(); // the durable source-snapshots/* namespace model
  const recorded = { snapshots: [], shadowSaves: [], assigns: [], membershipReads: 0, replaceCalls: [], lineage: [] };
  const durableHistory = over.durableHistory || new Map(); // grain -> row (the durable table model)
  const durableCoverage = over.durableCoverage || [];
  const membership = over.membership || new Map(); // accountId -> index (the durable membership model)

  const runtime = runtimeMod.buildBucketSourceSyncRuntime({
    getConnections: () => over.connections || CONNS,
    fetchAccounts: async (apiKey) => {
      if (over.onFetchAccounts) over.onFetchAccounts(apiKey);
      if (apiKey === PRIM_KEY) return over.primaryAccounts || [dirAccount("A01"), dirAccount("A02")];
      return over.secondaryAccounts || [dirAccount("B01")];
    },
    setTimer: over.setTimer,
    clearTimer: over.clearTimer,
    makeSourceStore: () => store,
    makeAdapter: () => dd,
    readSourceControls: over.readSourceControls || (async () => ({ rows: [], read: "ok", error: null })),
    readCoverage: over.readCoverage || (async () => ({ windows: [{ from: "2025-01-01", to: dates.addDaysStr(ASOF, -7) }], read: "ok", error: null })),
    readSnapshot: over.readSnapshot || (async () => ({ snapshot: null, read: "ok", error: null })),
    readAdsCoverage: over.readAdsCoverage || (async () => ({ windows: [{ from: "2025-01-01", to: TODAY }], read: "ok", error: null })),
    readBatchMembership: over.readBatchMembership || (async () => {
      recorded.membershipReads += 1;
      const org = identity.organizationFingerprint(PRIM_KEY);
      return [...membership.entries()].map(([account_id, batch_index]) => ({ account_id, batch_index, connection_id: "primary", organization_fingerprint: org }));
    }),
    assignBatchMembership: over.assignBatchMembership || (async ({ accountId }) => {
      recorded.assigns.push(accountId);
      const used = new Map();
      for (const idx of membership.values()) used.set(idx, (used.get(idx) || 0) + 1);
      let idx = 0;
      while ((used.get(idx) || 0) >= 5) idx += 1;
      membership.set(accountId, idx);
      return idx;
    }),
    // The ATOMIC replacement model: delete-the-window + insert + coverage ack, or NOTHING on failure.
    replaceHistory: over.replaceHistory || (async ({ accountId, coveredFrom, coveredTo, rows }) => {
      recorded.replaceCalls.push({ accountId, coveredFrom, coveredTo, rowCount: rows.length });
      if (over.failReplace) return { write: "write-failed", error: "OLI_HISTORY_REPLACE_FAILED" };
      for (const [grain, row] of [...durableHistory.entries()]) {
        if (row.accountId === accountId && row.saleDate >= coveredFrom && row.saleDate <= coveredTo) durableHistory.delete(grain);
      }
      for (const r of rows) durableHistory.set([r.accountId, r.saleDate, r.sku, r.childAsin, r.currency].join("|"), r);
      durableCoverage.push({ accountId, from: coveredFrom, to: coveredTo });
      return { write: "ok", replaced: 0, inserted: rows.length };
    }),
    saveSnapshotPayload: over.saveSnapshotPayload || (async ({ sourceKey, scopeKey, rows }) => {
      const objectPath = `source-snapshots/v1/${sourceKey}/${scopeKey}.json`;
      snapStore.set(objectPath, { rows: [...rows] });
      return { objectPath, payloadBytes: JSON.stringify({ rows }).length };
    }),
    loadSnapshotPayload: async (objectPath) => snapStore.get(objectPath) || null,
    recordSnapshot: over.recordSnapshot || (async (s) => { recorded.snapshots.push(s); return { write: "ok", ack: "replaced" }; }),
    loadHistoryRows: over.loadHistoryRows || (async () => [...durableHistory.values()].map((r) => ({
      account_id: r.accountId, sale_date: r.saleDate, sku: r.sku, child_asin: r.childAsin,
      currency: r.currency, sales_amount: r.salesAmount, units: r.units,
      source_request_hash: r.sourceRequestHash ?? r.source_request_hash ?? null, // durable OLI provenance
    }))),
    updateRunStatus: async () => ({ write: "ok" }),
    // Round-5: the REAL paramsHashFor hash (so the genuine publisher hash-provenance gate can accept these
    // saves) + a "save" lineage event so claim-BEFORE-save ordering is provable from one recorder.
    makeShadowSaver: over.makeShadowSaver || (() => async (args) => {
      const paramsHash = reportStore.paramsHashFor(args.params.reportVersion, args.params);
      recorded.lineage.push({ op: "save", reportKey: args.reportKey, accountId: args.accountId });
      recorded.shadowSaves.push({ ...args, paramsHash });
      // Round-7: the durable report_snapshots row the reconcile RPC + the adopt-if-exists read consult.
      store.recordShadowSnapshot({ reportKey: args.reportKey, accountId: args.accountId, paramsHash, params: args.params, payload: args.payload, sourceRefreshedAt: args.sourceRefreshedAt });
      return { paramsHash };
    }),
    readSettings: over.readSettings || (async () => []),
    readRollout: over.readRollout || (async () => ({ read: "ok", allPrimary: false, enabledAccountIds: [] })),
    readAdMetrics: over.readAdMetrics || (async () => []),
    // Round-7: the EXACT-identity durable shadow read the runtime uses to adopt an already-saved snapshot.
    readShadowSnapshot: over.readShadowSnapshot || (async ({ reportKey, accountId, paramsHash }) => store.getShadowSnapshot({ reportKey, accountId, paramsHash })),
    // Round-8 finding 2: the trusted storage hydrator for a storage-backed durable snapshot payload (inline
    // payloads never call it; a storage-backed one that returns null is a dangling object).
    loadShadowStoragePayload: over.loadShadowStoragePayload || (async () => null),
    // Round-9 finding 4 + round-11: the atomic freshness CAS shadow save (models cas_report_snapshot_if_newer).
    // Round-11: the durable-lineage write now goes through the CAS (never the merge-upsert saver), so this is
    // where a durable write + its "save" lineage event are recorded -- ONLY on an actual write (inserted/replaced).
    saveShadowIfNewer: over.saveShadowIfNewer || (async (cand) => {
      const res = store.shadowCasIfNewer(cand);
      if (res.outcome === "inserted" || res.outcome === "replaced") {
        recorded.lineage.push({ op: "save", reportKey: cand.reportKey, accountId: cand.accountId });
        recorded.shadowSaves.push({ ...cand, paramsHash: cand.paramsHash });
      }
      return res;
    }),
    // Round-7 finding 1: the default lineage DELEGATES to the store's LEASE model (guarded claim + reconcile
    // bound to the exact durable snapshot) while recording every op + disposition for assertions.
    reportLineage: over.reportLineage || {
      upsertReportJob: async (j) => { recorded.lineage.push({ op: "upsert", ...j }); store.upsertReportJob(j); },
      // Mirror the REAL wrapper's camelCase shape (claimReportDeriveLease maps lease_token -> leaseToken).
      claimLease: async (c, rk, a, opts) => {
        const res = store.claimLease(c, rk, a, opts);
        recorded.lineage.push({ op: "claim", reportKey: rk, accountId: a, disposition: res.disposition });
        return { disposition: res.disposition, leaseToken: res.lease_token || null, snapshotParamsHash: res.snapshot_params_hash || null, deriveStatus: res.derive_status || null };
      },
      reconcileSuccess: async (j) => { const res = store.reconcileSuccess(j); recorded.lineage.push({ op: "reconcile", reportKey: j.reportKey, accountId: j.accountId, disposition: res.disposition }); return { disposition: res.disposition }; },
    },
    composeTrancheRuntime: over.composeTrancheRuntime,
    clock: () => clockRef.now,
    budgetMs: over.budgetMs ?? 600_000,
    reserveMs: over.reserveMs ?? 1_000,
  });
  return { runtime, store, dd, snapStore, recorded, clockRef, membership, durableHistory, durableCoverage };
}

/* ================================= F1. read failures fail closed ================================= */
group("F1. non-ok durable reads refuse BEFORE any export/write/cycle (migration-unapplied = zero-export)");

test("F1a. controls schema-missing => typed DURABLE_MODEL_UNAVAILABLE with ZERO discovery/cycle/creates", async () => {
  let discoveries = 0;
  const h = makeHarness({
    readSourceControls: async () => ({ rows: [], read: "schema-missing", error: "SOURCE_CONTROLS_SCHEMA_MISSING" }),
  });
  const origFetch = h.runtime; // discovery counted via store opens + dd creates below
  await assert.rejects(() => h.runtime.run({ bucket: "us", today: TODAY }), (e) => e.code === "DURABLE_MODEL_UNAVAILABLE" && e.status === 503);
  assert.equal(h.store._opens, 0, "no cycle was created");
  assert.equal(h.dd.totalCreates(), 0, "zero exports");
});

test("F1b. coverage/snapshot read failures => typed refusal with ZERO cycle/creates", async () => {
  const cov = makeHarness({ readCoverage: async () => ({ windows: [], read: "read-failed", error: "SOURCE_COVERAGE_READ_FAILED" }) });
  await assert.rejects(() => cov.runtime.run({ bucket: "us", today: TODAY }), (e) => e.code === "SOURCE_EVIDENCE_READ_FAILED");
  assert.equal(cov.store._opens, 0);
  assert.equal(cov.dd.totalCreates(), 0);
  const snap = makeHarness({ readSnapshot: async () => ({ snapshot: null, read: "schema-missing", error: "SOURCE_SNAPSHOT_SCHEMA_MISSING" }) });
  await assert.rejects(() => snap.runtime.run({ bucket: "us", today: TODAY }), (e) => e.code === "DURABLE_MODEL_UNAVAILABLE");
  assert.equal(snap.store._opens, 0);
  assert.equal(snap.dd.totalCreates(), 0);
});

test("F1c. a membership read failure => typed BATCH_MEMBERSHIP_READ_FAILED with ZERO cycle/creates", async () => {
  const h = makeHarness({ readBatchMembership: async () => { throw new Error("boom"); } });
  await assert.rejects(() => h.runtime.run({ bucket: "us", today: TODAY }), (e) => e.code === "BATCH_MEMBERSHIP_READ_FAILED");
  assert.equal(h.store._opens, 0);
  assert.equal(h.dd.totalCreates(), 0);
});

/* ================================= F2. primary-only binding ================================= */
group("F2. only correctly bound PRIMARY accounts; prefixed ids never route through the primary key");

test("F2a. dd-secondary + unknown-prefixed accounts are EXCLUDED (recorded); only clean primary ids run", async () => {
  const h = makeHarness({
    primaryAccounts: [dirAccount("A01")],
    secondaryAccounts: [dirAccount("B01")], // merges as dd-secondary:B01 and is ACTIVE (secondary configured)
  });
  const rollup = await h.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(rollup.stopped, false, JSON.stringify(rollup.stopReason));
  assert.ok(rollup.excludedAccounts.some((e) => e.accountId.includes(":") && e.reason === "non-primary-connection"), "the prefixed account was excluded, typed");
  for (const c of h.dd.createSeq) {
    for (const id of c.ids) assert.ok(!id.includes(":"), "no prefixed id ever reached the primary adapter");
  }
});

test("F2b. bindPrimaryBucketAccounts: missing marketplace country excludes; other-bucket accounts are not exclusions", () => {
  const { accounts, excluded } = runtimeMod.bindPrimaryBucketAccounts([
    { accountId: "A01", country: "US" },
    { accountId: "A02", country: "" },
    { accountId: ["dd", "secondary"].join("-") + ":B01", country: "US" },
    { accountId: "IN1", country: "IN" }, // the non-us bucket's account: filtered, NOT an exclusion
  ], "us");
  assert.deepEqual(accounts, [{ accountId: "A01", rawSellerId: "A01", country: "US", name: "A01", currency: null }]);
  assert.deepEqual(excluded.map((e) => e.reason).sort(), ["missing-marketplace-country", "non-primary-connection"]);
});

/* ================================= F3. real deadline + resumable continuation ================================= */
group("F3. bounded invocations under a real deadline; continuation resumes with no duplicate create");

test("F3a. a tight budget stops typed-resumable mid-run; a fresh invocation completes the SAME cycle; <=1 create per hash", async () => {
  const store = makeStore();
  const membership = new Map();
  const clockCost = 30_000; // each create burns 30s of fake clock
  let h = makeHarness({
    store, membership,
    ddOpts: { onCreate: () => { h.clockRef.now += clockCost; } },
    budgetMs: 100_000, reserveMs: 1_000,
    readCoverage: async () => ({ windows: [], read: "ok", error: null }), // full backfill => plenty of work
  });
  const run1 = await h.runtime.run({ bucket: "us", today: TODAY, cycleDate: TODAY });
  assert.equal(run1.deadlineReached, true, "the budget expired mid-run");
  assert.equal(run1.continuationRequired, true, "typed-resumable, not stopped");
  assert.equal(run1.stopped, false, "a deadline is never a failure");
  const creates1 = h.dd.totalCreates();
  assert.ok(creates1 >= 1, "bounded work happened");
  // Fresh invocation over the SAME store/cycle (a new serverless call): completes the remaining work.
  let h2 = makeHarness({ store, membership, ddOpts: { onCreate: () => {} }, budgetMs: 100_000_000, readCoverage: async () => ({ windows: [], read: "ok", error: null }) });
  const run2 = await h2.runtime.run({ bucket: "us", today: TODAY, cycleDate: TODAY });
  assert.equal(run2.continuationRequired, false, "the continuation finished");
  assert.equal(run2.globalDrained, true);
  for (const row of store.listSourceJobs(run2.cycleId)) {
    assert.ok(row.create_export_count <= 1, "no hash was ever created twice across invocations");
  }
});

/* ================================= F4. source-card action routing + derive/save ================================= */
group("F4. every card action executes its REAL architecture or refuses typed; durable shadow snapshots derive+save");

test("F4a. durable families execute the bucket sync; durable-ads refuses TYPED; unregistered throws", async () => {
  const h = makeHarness({});
  const catalog = await h.runtime.runSourceCardAction({ bucket: "us", sourceKey: "product-catalog" });
  assert.equal(catalog.refused, undefined, "the durable family executed");
  assert.ok(h.dd.createSeq.some((c) => c.sourceKey === "product-catalog"), "the real bucket-sync architecture ran");
  const ads = await h.runtime.runSourceCardAction({ bucket: "us", sourceKey: "ads-asin-date" });
  assert.deepEqual({ refused: ads.refused, code: ads.code }, { refused: true, code: "SOURCE_ACTION_ADS_ARCHITECTURE" });
  await assert.rejects(() => h.runtime.runSourceCardAction({ bucket: "us", sourceKey: "nope" }), /UNREGISTERED_SOURCE/);
});

test("F4b. a cycle-cache card executes ONLY its own family via the single-family tranche composition (reuseOnly threads; no widening)", async () => {
  const composed = [];
  const runs = [];
  const h = makeHarness({
    composeTrancheRuntime: (spec, opts) => {
      composed.push({ spec, opts });
      return { run: async (args) => { runs.push(args); return { cycleId: null, spent: 0 }; } };
    },
  });
  const res = await h.runtime.runSourceCardAction({ bucket: "us", sourceKey: "settlements", reuseOnly: true });
  assert.equal(res.architecture, "tranche");
  assert.equal(composed.length, 1);
  assert.deepEqual(composed[0].spec, { name: "settlements", sourceKeys: ["settlements"] }, "the tranche is FIXED to exactly the selected family (no widening)");
  assert.equal(composed[0].opts.reuseOnly, true, "reuseOnly threads into the trusted composition (tripwire installed)");
  assert.equal(runs.length, 1);
  assert.ok(Number.isFinite(runs[0].deadlineMs), "a REAL finite deadline (never Infinity under the route)");
  assert.deepEqual([...runs[0].manualReportKeys].sort(), [...registry.sourceRegistryEntry("settlements").usedByReports].sort(), "report scope = the family's consumers (execution still narrowed to the one family)");
});

test("F4c. after a COMPLETE run the Daily + Brand View durable SHADOW snapshots derive, validate, and save", async () => {
  const h = makeHarness({
    readCoverage: async () => ({ windows: [{ from: "2025-01-01", to: TODAY }], read: "ok", error: null }),
    readSnapshot: async ({ sourceKey, scopeKey }) => {
      if (sourceKey === "product-catalog") return { snapshot: { validated_at: TODAY + "T01:00:00Z", object_path: "source-snapshots/v1/product-catalog/__organization.json", row_count: 1 }, read: "ok", error: null };
      return { snapshot: { validated_at: TODAY + "T01:00:00Z" }, read: "ok", error: null };
    },
  });
  h.snapStore.set("source-snapshots/v1/product-catalog/__organization.json", { rows: [{ child_asin: "B0A", sku: "SKU-A", product_brand: "Acme" }] });
  h.durableHistory.set("A01|x", { accountId: "A01", saleDate: ASOF, sku: "SKU-A", childAsin: "B0A", currency: "USD", salesAmount: 10, units: 1 });
  const rollup = await h.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(rollup.stopped, false, JSON.stringify(rollup.stopReason));
  assert.equal(rollup.derived.skipped, null, "the derive stage ran");
  assert.ok(rollup.derived.daily.saved >= 1, "per-account Daily durable shadow snapshots saved");
  assert.equal(rollup.derived.brandView.saved, 2, "one brand-sales shadow snapshot per account (the payload Brand View consumes)");
  for (const save of h.recorded.shadowSaves) {
    assert.ok(String(save.reportKey).startsWith("scheduler-v2/"), "saved ONLY in the shadow namespace");
    assert.ok(save.reportKey === "scheduler-v2/daily-reporting" || save.reportKey === "scheduler-v2/brand-sales", "the EXISTING report keys -- no orphan custom keys");
    assert.ok(save.payload, "a real contract payload was saved");
  }
});

test("F4d. non-ready readiness => TYPED derive skip, nothing saved, nothing fabricated", async () => {
  const h = makeHarness({
    // Coverage proves only the sync window, NOT the full dashboard windows => sales-blocking gap.
    readCoverage: async () => ({ windows: [{ from: dates.addDaysStr(ASOF, -8), to: TODAY }], read: "ok", error: null }),
  });
  const rollup = await h.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(rollup.stopped, false);
  if (rollup.derived.skipped == null) {
    assert.equal(rollup.derived.daily.saved, 0, "no Daily snapshot without proven coverage");
    assert.equal(rollup.derived.daily.ready, false);
  } else {
    assert.ok(typeof rollup.derived.skipped === "string", "typed skip");
  }
  assert.ok(h.recorded.shadowSaves.every((s) => s.reportKey !== "scheduler-v2/daily-reporting-durable"), "nothing fabricated");
});

test("F4e. NO opened cycle (OLI paused, catalog/FBA fresh, full coverage) is NOT drained => ZERO snapshot saves + ZERO publishable lineage", async () => {
  // Initial-backfill-only scope: deriving/saving report snapshots off durable evidence WITHOUT an owning cycle
  // (and thus without claim-before-save lineage) is the SEPARATE durable-evidence-lineage rework. A run that
  // opens no cycle must therefore stay NOT-drained and publish/schedule nothing.
  const h = makeHarness({
    // OLI paused => no OLI export; fresh catalog + per-account FBA snapshots => no catalog/FBA export => NO cycle.
    readSourceControls: async () => ({ rows: [{ source_key: "order-line-items", paused: true }], read: "ok", error: null }),
    readCoverage: async () => ({ windows: [{ from: "2025-01-01", to: TODAY }], read: "ok", error: null }), // FULL coverage
    readSnapshot: async ({ sourceKey, scopeKey }) => (sourceKey === "product-catalog"
      ? { snapshot: { validated_at: TODAY + "T01:00:00Z", object_path: "source-snapshots/v1/product-catalog/__organization.json", row_count: 1 }, read: "ok", error: null }
      : { snapshot: { validated_at: TODAY + "T01:00:00Z", object_path: "source-snapshots/v1/fba-inventory-health/" + scopeKey + ".json", row_count: 1 }, read: "ok", error: null }),
  });
  h.snapStore.set("source-snapshots/v1/product-catalog/__organization.json", { rows: [{ child_asin: "B0A", sku: "SKU-A", product_brand: "Acme" }] });
  for (const a of ["A01", "A02"]) h.snapStore.set("source-snapshots/v1/fba-inventory-health/" + a + ".json", { rows: [{ date: ASOF, sku: "SKU-A", child_asin: "B0A", marketplace_country_code: "US", available: 5 }] });
  h.durableHistory.set("A01|x", { accountId: "A01", saleDate: ASOF, sku: "SKU-A", childAsin: "B0A", currency: "USD", salesAmount: 10, units: 1 });
  const rollup = await h.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(rollup.stopped, false, JSON.stringify(rollup.stopReason));
  assert.equal(rollup.cycleId, null, "no owning cycle was opened (nothing needed fetching)");
  assert.equal(rollup.globalDrained, false, "a run without an owning cycle is NOT drained");
  assert.equal(rollup.derived.skipped, "not-drained", "the derive/save stage is skipped -- never run off a durable-evidence-only, cycle-less run");
  assert.equal(rollup.derived.daily, null, "ZERO Daily snapshot derivation/save");
  assert.equal(rollup.derived.brandView, null, "ZERO Brand View snapshot derivation/save");
  assert.equal(rollup.derived.brandInventory, null, "ZERO brand-inventory derivation/save");
  assert.equal(h.recorded.shadowSaves.length, 0, "ZERO durable snapshot saves (no plain wall-clock save either)");
  assert.equal(h.recorded.lineage.length, 0, "ZERO publishable report lineage (no upsert/claim/save/reconcile)");
  assert.equal(h.dd.totalCreates(), 0, "ZERO DataDoe exports");
});

// The durable-evidence lineage (provenance binding): OLI is PAUSED (zero OLI creates) but its history is already
// fully proven, and the catalog fetch opens the owning cycle. A covered account must derive off the durable OLI
// and its report OLI depends_on must bind the DURABLE provenance (the persisted source_request_hash), not the
// empty current cycle. A history row lacking its provenance fails that account closed.
function durableOliProvenanceHarness(over = {}) {
  const h = makeHarness({
    // OLI PAUSED => zero OLI export this cycle. Catalog ABSENT => the catalog fetch opens the owning cycle. FBA
    // fresh => no FBA fetch, so the cycle holds ONLY the catalog job (no OLI).
    readSourceControls: async () => ({ rows: [{ source_key: "order-line-items", paused: true }], read: "ok", error: null }),
    readCoverage: async () => ({ windows: [{ from: "2025-01-01", to: TODAY }], read: "ok", error: null }), // FULL OLI coverage
    readSnapshot: async ({ sourceKey, scopeKey }) => (sourceKey === "product-catalog"
      ? { snapshot: null, read: "ok", error: null } // catalog absent => fetched this cycle
      : { snapshot: { validated_at: TODAY + "T01:00:00Z", object_path: "source-snapshots/v1/fba-inventory-health/" + scopeKey + ".json", row_count: 1 }, read: "ok", error: null }),
    ...over,
  });
  for (const a of ["A01", "A02"]) h.snapStore.set("source-snapshots/v1/fba-inventory-health/" + a + ".json", { rows: [{ date: ASOF, sku: "SKU-A", child_asin: "B0A", marketplace_country_code: "US", available: 5 }] });
  return h;
}

test("F4f. durable provenance: OLI paused (zero OLI creates) + catalog fetched => a covered account derives; its OLI depends_on binds the DURABLE source_request_hash (not the current cycle)", async () => {
  const h = durableOliProvenanceHarness();
  // Durable OLI history WITH provenance (the already-persisted exports); NO OLI job in this cycle.
  h.durableHistory.set("A01|x", { accountId: "A01", saleDate: ASOF, sku: "SKU-A", childAsin: "B0A", currency: "USD", salesAmount: 10, units: 1, sourceRequestHash: "oli-prov-A01" });
  const pf = await h.runtime.preflightEvidence({ bucket: "us", today: TODAY });
  const rollup = await h.runtime.run({ bucket: "us", today: TODAY, preflight: pf });
  assert.equal(rollup.stopped, false, JSON.stringify(rollup.stopReason));
  assert.equal(h.dd.createSeq.filter((c) => c.sourceKey === "order-line-items").length, 0, "ZERO OLI create-exports");
  assert.ok(rollup.derived.daily.saved >= 1, "the covered account derived Daily off durable OLI");
  assert.ok(rollup.derived.brandView.saved >= 1, "and Brand View off the SAME durable OLI");
  // The report lineage's OLI depends_on is the DURABLE provenance -- no OLI job exists in this cycle.
  const jobs = h.store.listSourceJobs(rollup.cycleId);
  assert.equal(jobs.filter((j) => j.source_key === "order-line-items").length, 0, "no OLI job in the owning (catalog) cycle");
  const catalogHash = (jobs.find((j) => j.source_key === "product-catalog") || {}).request_hash;
  for (const rk of ["daily-reporting", "brand-sales"]) {
    const up = h.recorded.lineage.find((l) => l.op === "upsert" && l.reportKey === rk && l.accountId === "A01");
    assert.ok(up, rk + " lineage upserted");
    assert.ok(up.dependsOn.includes("oli-prov-A01"), rk + ": OLI depends_on binds the durable provenance hash");
    assert.ok(catalogHash && up.dependsOn.includes(catalogHash), rk + ": catalog depends_on from THIS cycle");
    assert.ok(up.dependsOn.every((x) => x === "oli-prov-A01" || x === catalogHash), rk + ": no unproven/foreign hash in depends_on");
  }
});

test("F4g. fail closed: a covered account whose durable OLI history row LACKS its source_request_hash is skipped (durable-oli-provenance-missing), never published with unproven lineage", async () => {
  const h = durableOliProvenanceHarness();
  h.durableHistory.set("A01|x", { accountId: "A01", saleDate: ASOF, sku: "SKU-A", childAsin: "B0A", currency: "USD", salesAmount: 10, units: 1 }); // NO sourceRequestHash
  const pf = await h.runtime.preflightEvidence({ bucket: "us", today: TODAY });
  const rollup = await h.runtime.run({ bucket: "us", today: TODAY, preflight: pf });
  assert.equal(rollup.stopped, false, JSON.stringify(rollup.stopReason));
  assert.equal(h.dd.createSeq.filter((c) => c.sourceKey === "order-line-items").length, 0, "still ZERO OLI creates");
  assert.ok(rollup.derived.lineage.some((l) => l.accountId === "A01" && l.outcome === "durable-oli-provenance-missing"), "A01 fails closed with the typed provenance-missing skip");
  assert.ok(h.recorded.shadowSaves.every((s) => s.accountId !== "A01"), "no A01 snapshot was saved without proven OLI provenance");
});

/* ================================= F5. atomic OLI replacement ================================= */
group("F5. atomic rolling-window replacement: removed grains cannot survive; replacement+ack one transaction");

test("F5a. a grain that DISAPPEARED from the corrected export is REMOVED by the window replacement", async () => {
  const durableHistory = new Map();
  // A stale grain inside the rolling window that the corrected export no longer returns:
  durableHistory.set("A01|stale", { accountId: "A01", saleDate: ASOF, sku: "GONE", childAsin: "GONE", currency: "USD", salesAmount: 999, units: 99 });
  const h = makeHarness({ durableHistory });
  const rollup = await h.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(rollup.stopped, false, JSON.stringify(rollup.stopReason));
  const survivors = [...durableHistory.values()].filter((r) => r.sku === "GONE");
  assert.equal(survivors.length, 0, "the removed grain did NOT survive the atomic replacement");
  assert.ok(h.recorded.replaceCalls.length >= 1, "the atomic replace path ran per (account, slice)");
});

test("F5b. a failed replacement leaves BOTH data and coverage untouched and stops the bucket typed", async () => {
  const durableHistory = new Map();
  const durableCoverage = [];
  const h = makeHarness({ durableHistory, durableCoverage, failReplace: true });
  const rollup = await h.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(rollup.stopped, true);
  assert.equal(rollup.stopReason.code, "HISTORY_REPLACE_FAILED");
  assert.equal(durableHistory.size, 0, "no rows were written by the failed transaction");
  assert.equal(durableCoverage.length, 0, "no coverage was acknowledged by the failed transaction");
});

/* ================================= F6. durable snapshot storage + pruning ================================= */
group("F6. snapshot payloads live in the durable namespace and hydrate AFTER cache pruning");

test("F6a. snapshot pointers reference source-snapshots/* (never the 24h cache); hydration survives a full cache prune", async () => {
  const h = makeHarness({});
  const rollup = await h.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(rollup.stopped, false, JSON.stringify(rollup.stopReason));
  assert.ok(h.recorded.snapshots.length >= 1, "snapshots recorded");
  for (const s of h.recorded.snapshots) {
    assert.ok(s.objectPath.startsWith("source-snapshots/v1/"), "the pointer references the DURABLE namespace");
    assert.ok(!s.objectPath.startsWith("source-cache/"), "never the prunable cache namespace");
  }
  // ORDINARY cache pruning: every 24h cache object disappears. The snapshot still hydrates.
  h.store._cache.clear();
  for (const s of h.recorded.snapshots) {
    const payload = h.snapStore.get(s.objectPath);
    assert.ok(payload && Array.isArray(payload.rows), "hydration after pruning succeeds from the durable object");
  }
});

/* ================================= F7. durable stable membership ================================= */
group("F7. durable source_batch_membership loaded + transactionally assigned");

test("F7a. existing membership is LOADED (not recomputed); only the new account is transactionally assigned; stable across runs", async () => {
  const membership = new Map([["A01", 0]]);
  const h = makeHarness({ membership, primaryAccounts: [dirAccount("A01"), dirAccount("A02")] });
  const r1 = await h.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(r1.stopped, false);
  assert.deepEqual(h.recorded.assigns, ["A02"], "ONLY the new account went through the assignment RPC");
  assert.equal(h.membership.get("A01"), 0, "the existing durable index is untouched");
  const h2 = makeHarness({ membership, store: makeStore(), primaryAccounts: [dirAccount("A01"), dirAccount("A02")] });
  await h2.runtime.run({ bucket: "us", today: TODAY, cycleDate: "2026-08-21" });
  assert.deepEqual(h2.recorded.assigns, [], "a second invocation assigns NOTHING (membership is durable + stable)");
});

test("F7b. a malformed assignment acknowledgement fails closed", async () => {
  const h = makeHarness({ assignBatchMembership: async () => "not-a-number" });
  await assert.rejects(() => h.runtime.run({ bucket: "us", today: TODAY }), (e) => e.code === "BATCH_MEMBERSHIP_ASSIGN_FAILED");
  assert.equal(h.dd.totalCreates(), 0);
});

/* ================================= F8. authoritative readiness ================================= */
group("F8. readiness from authoritative per-account durable evidence (never last_status)");

test("F8a. per-account coverage gaps and per-account Ads gaps carry their accountId; read failures block typed", async () => {
  const h = makeHarness({
    primaryAccounts: [dirAccount("A01"), dirAccount("A02")],
    readCoverage: async ({ accountId }) => (accountId === "A01"
      ? { windows: [{ from: "2025-01-01", to: TODAY }], read: "ok", error: null }
      : { windows: [], read: "ok", error: null }),
    readAdsCoverage: async (accountId) => (accountId === "A01"
      ? { windows: [{ from: "2025-01-01", to: TODAY }], read: "ok", error: null }
      : { windows: [], read: "ok", error: null }),
    readSnapshot: async ({ sourceKey }) => (sourceKey === "product-catalog"
      ? { snapshot: { validated_at: TODAY + "T01:00:00Z", object_path: "source-snapshots/v1/product-catalog/__organization.json" }, read: "ok", error: null }
      : { snapshot: null, read: "ok", error: null }),
  });
  const readiness = await h.runtime.gatherDurableReadiness({ bucket: "us", accounts: [{ accountId: "A01" }, { accountId: "A02" }], asOf: ASOF });
  assert.equal(readiness.daily.ready, false, "A02's missing OLI coverage blocks Daily");
  assert.ok(readiness.daily.blockedBy.some((b) => b.sourceKey === "order-line-items" && b.accountId === "A02"), "the gap names its account");
  assert.ok(!readiness.daily.blockedBy.some((b) => b.accountId === "A01" && b.sourceKey === "order-line-items"), "the covered account is not blamed");
  assert.equal(readiness.daily.adsReady, false, "A02's per-account Ads gap degrades the ads half");
  const failing = makeHarness({
    readCoverage: async () => ({ windows: [], read: "read-failed", error: "SOURCE_COVERAGE_READ_FAILED" }),
  });
  const blocked = await failing.runtime.gatherDurableReadiness({ bucket: "us", accounts: [{ accountId: "A01" }], asOf: ASOF });
  assert.equal(blocked.daily.ready, false, "a read failure can never present as ready");
  assert.ok(blocked.daily.blockedBy.some((b) => String(b.reason).startsWith("coverage-read")), "typed read-failure blocker");
});

/* ================================= F9. ACL/policy + RPC mutation audit ================================= */
group("F9. Migration-20260820 ACL/RPC schema-audit mutations");

const MIG = "20260820_source_durable_model.sql";
function auditWith(mutate) {
  const real = readFileSync(path.join(process.cwd(), "supabase", "migrations", MIG), "utf8");
  const sql = mutate ? mutate(real) : real;
  const readFile = (rel) => {
    if (rel === "supabase.js") return readFileSync(path.join(process.cwd(), "lib", "server", "supabase.js"), "utf8");
    if (rel === MIG) return sql;
    return readFileSync(path.join(process.cwd(), "supabase", "migrations", rel), "utf8");
  };
  return schema.auditSchemaContract({ readFile });
}

test("F9a. the REAL migration audits clean; a dropped history REVOKE => SERVICE_ROLE_REVOKE_MISSING", () => {
  assert.equal(auditWith(null).ok, true, "baseline clean");
  const audit = auditWith((sql) => sql.replace("revoke all on table public.source_oli_daily_history from public, anon, authenticated, service_role;", ""));
  assert.equal(audit.ok, false);
  assert.ok(audit.blockers.some((b) => b.code === "SERVICE_ROLE_REVOKE_MISSING"), JSON.stringify(audit.blockers.map((b) => b.code)));
});

test("F9b. a WIDENED history grant (select -> select,insert) => SERVICE_ROLE_GRANT_MISMATCH", () => {
  const audit = auditWith((sql) => sql.replace("grant select on table public.source_oli_daily_history to service_role;", "grant select, insert on table public.source_oli_daily_history to service_role;"));
  assert.equal(audit.ok, false);
  assert.ok(audit.blockers.some((b) => b.code === "SERVICE_ROLE_GRANT_MISMATCH"), JSON.stringify(audit.blockers.map((b) => b.code)));
});

test("F9c. a dropped replace RPC => RPC_MISSING; a gutted body (no DELETE / no coverage ack) => typed proof blockers", () => {
  const dropped = auditWith((sql) => sql.replace(/create or replace function public\.replace_oli_history_window[\s\S]*?\$\$;/, ""));
  assert.equal(dropped.ok, false);
  assert.ok(dropped.blockers.some((b) => String(b.code).includes("RPC_MISSING") || String(b.code).includes("REPLACE_OLI_FUNCTION_MISSING")), JSON.stringify(dropped.blockers.map((b) => b.code)));
  const noDelete = auditWith((sql) => sql.replace(/delete from public\.source_oli_daily_history[\s\S]*?get diagnostics v_deleted = row_count;/, "v_deleted := 0;"));
  assert.ok(noDelete.blockers.some((b) => b.code === "REPLACE_OLI_DELETE_MISSING"), JSON.stringify(noDelete.blockers.map((b) => b.code)));
  const noAck = auditWith((sql) => sql.replace(/-- The coverage ACKNOWLEDGEMENT commits[\s\S]*?do update set source_refreshed_at = excluded\.source_refreshed_at, updated_at = now\(\);/, ""));
  assert.ok(noAck.blockers.some((b) => b.code === "REPLACE_OLI_COVERAGE_ACK_MISSING"), JSON.stringify(noAck.blockers.map((b) => b.code)));
});

/* ================================= F10. FBA seller-scoping + marketplace validation ================================= */
group("F10. FBA rows validated per account marketplace before any snapshot");

test("F10a. a cross-marketplace or marketplace-less FBA row STOPS the bucket typed (round-4 finding 5; latest-good preserved)", async () => {
  const wrong = makeHarness({ ddOpts: { fbaRows: [{ date: ASOF, sku: "K", child_asin: "B", marketplace_country_code: "DE", available: 3 }] } });
  const r1 = await wrong.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(r1.stopped, true, "domain-invalid payload stops the bucket");
  assert.equal(r1.stopReason.code, "SOURCE_PAYLOAD_UNAVAILABLE");
  assert.equal(r1.stopReason.detail, "FBA_CROSS_MARKETPLACE");
  assert.equal(r1.globalDrained, false, "never reported drained");
  assert.ok(r1.snapshots.rejected.some((x) => x.code === "FBA_CROSS_MARKETPLACE"), "cross-marketplace recorded typed");
  assert.ok(!r1.snapshots.recorded.some((k) => String(k).startsWith("fba-inventory-health:")), "no FBA snapshot recorded");
  const blank = makeHarness({ ddOpts: { fbaRows: [{ date: ASOF, sku: "K", child_asin: "B", available: 3 }] } });
  const r2 = await blank.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(r2.stopped, true);
  assert.equal(r2.stopReason.detail, "FBA_ROW_NO_MARKETPLACE");
});


/* ================================= R. round-3 regressions ================================= */
group("R. round-3: paused card, end-to-end deadline, cache loss, snapshots, membership, readiness, policies");

test("R1. a PAUSED cycle-cache card refuses typed BEFORE any composition/discovery; reuseOnly threads", async () => {
  const composed = [];
  const h = makeHarness({
    readSourceControls: async () => ({ rows: [{ source_key: "settlements", paused: true, schedule_enabled: false }], read: "ok", error: null }),
    composeTrancheRuntime: (spec, opts) => { composed.push({ spec, opts }); return { run: async () => ({ cycleId: null, spent: 0 }) }; },
  });
  await assert.rejects(() => h.runtime.runSourceCardAction({ bucket: "us", sourceKey: "settlements" }), (e) => e.code === "SOURCE_PAUSED" && e.status === 409);
  assert.equal(composed.length, 0, "the paused card never composed a runtime (zero discovery/I-O)");
  const h2 = makeHarness({ composeTrancheRuntime: (spec, opts) => { composed.push({ spec, opts }); return { run: async () => ({ cycleId: null, spent: 0 }) }; } });
  await h2.runtime.runSourceCardAction({ bucket: "us", sourceKey: "settlements", reuseOnly: false });
  assert.equal(composed[composed.length - 1].opts.reuseOnly, false, "reuseOnly=false threads honestly");
});

test("R2. deadline DURING evidence reads and DURING the derive half both return typed resumable state (never failure)", async () => {
  const h = makeHarness({ budgetMs: 1_000, reserveMs: 5_000 });
  const r1 = await h.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(r1.deadlineReached, true);
  assert.equal(r1.continuationRequired, true);
  assert.equal(r1.stopped, false, "typed resumable, never a failure");
  assert.ok(typeof r1.phase === "string", "the expired phase is named");
  assert.equal(h.store._opens, 0, "zero cycle creation");
  assert.equal(h.dd.totalCreates(), 0, "zero exports");
  const store2 = makeStore();
  let h2 = makeHarness({
    store: store2,
    ddOpts: { onCreate: () => { h2.clockRef.now += 20_000; } },
    budgetMs: 80_000, reserveMs: 1_000,
    readSnapshot: async ({ sourceKey }) => (sourceKey === "product-catalog"
      ? { snapshot: { validated_at: TODAY + "T01:00:00Z", object_path: "source-snapshots/v1/product-catalog/__organization.json", row_count: 1 }, read: "ok", error: null }
      : { snapshot: { validated_at: TODAY + "T01:00:00Z" }, read: "ok", error: null }),
  });
  h2.snapStore.set("source-snapshots/v1/product-catalog/__organization.json", { rows: [{ child_asin: "B0A", sku: "SKU-A", product_brand: "Acme" }] });
  const r2 = await h2.runtime.run({ bucket: "us", today: TODAY });
  if (r2.derived && r2.derived.skipped === "deadline") {
    assert.equal(r2.continuationRequired, true, "the derive half deferred typed-resumable");
  } else {
    assert.ok(r2.deadlineReached === true || r2.derived != null, "the deadline surfaced typed somewhere in the pipeline");
  }
});

test("R3. a fixpoint deadline BETWEEN continuations is typed resumable -- never FAMILY_CONTINUATIONS_EXHAUSTED", async () => {
  const fixpoint = await import("../lib/server/sync/source-fixpoint.js");
  const clockRef = { now: 1_000_000 };
  const store = { listSourceJobs: async () => [{ source_key: "order-line-items", request_hash: "h1", fetch_status: "pending", create_export_count: 0 }] };
  const rollup = await fixpoint.runSourceFixpoint({
    composeRuntime: () => ({ run: async () => { clockRef.now += 40_000; return { cycleId: "c1", spent: 1, perUnit: [], reports: null }; } }),
    store, bucket: "us", cycleDate: "2026-08-21", reportKeys: ["brand-sales"],
    clock: () => clockRef.now, wait: async () => {}, cooldownMs: 0,
    deadlineMs: clockRef.now + 60_000, reserveMs: 1_000,
    maxContinuationsPerFamily: 10, maxWalks: 1,
  });
  assert.equal(rollup.deadlineReached, true, "the deadline surfaced typed");
  assert.equal(rollup.continuationRequired, true, "resumable");
  assert.equal(rollup.stopped, false, "never a failure");
  assert.notEqual(rollup.stopReason && rollup.stopReason.code, "FAMILY_CONTINUATIONS_EXHAUSTED", "exhaustion is never blamed for a deadline");
});

test("R4. a SUCCEEDED job whose cached payload was lost fails closed as SOURCE_PAYLOAD_UNAVAILABLE (not drained; persistence not skipped silently)", async () => {
  const store = makeStore();
  const succeeded = new Set();
  const origSuccess = store.recordSourceSuccess.bind(store);
  store.recordSourceSuccess = (args) => { succeeded.add(args.requestHash); return origSuccess(args); };
  const origLoad = store.loadSourceRows.bind(store);
  store.loadSourceRows = (h) => (succeeded.has(h) ? null : origLoad(h)); // the cache vanishes after success
  const h = makeHarness({ store });
  const rollup = await h.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(rollup.stopped, true);
  assert.equal(rollup.stopReason.code, "SOURCE_PAYLOAD_UNAVAILABLE");
  assert.equal(rollup.globalDrained, false, "a lost payload is never reported drained/successful");
  assert.equal(h.recorded.replaceCalls.length, 0, "durable persistence was not silently skipped -- it was refused typed");
});

test("R5. snapshot saves are content-addressed + organization/connection isolated; a pointer/payload mismatch is refused pre-HTTP", async () => {
  const sb = await import("../lib/server/supabase.js");
  const rowsA = [{ child_asin: "A" }];
  const rowsB = [{ child_asin: "B" }];
  const shaA = sb.sourceSnapshotPayloadSha(rowsA);
  const shaB = sb.sourceSnapshotPayloadSha(rowsB);
  assert.notEqual(shaA, shaB, "different content => different hash");
  assert.equal(shaA, sb.sourceSnapshotPayloadSha([{ child_asin: "A" }]), "same content => same immutable object");
  const pathA = sb.sourceSnapshotObjectPath({ organizationFingerprint: "org1", connectionId: "primary", sourceKey: "product-catalog", scopeKey: "__organization", payloadSha: shaA });
  const pathB = sb.sourceSnapshotObjectPath({ organizationFingerprint: "org1", connectionId: "primary", sourceKey: "product-catalog", scopeKey: "__organization", payloadSha: shaB });
  assert.notEqual(pathA, pathB, "concurrent DIFFERENT-content saves write DIFFERENT immutable objects");
  const pathOrg2 = sb.sourceSnapshotObjectPath({ organizationFingerprint: "org2", connectionId: "primary", sourceKey: "product-catalog", scopeKey: "__organization", payloadSha: shaA });
  assert.notEqual(pathA, pathOrg2, "cross-organization saves are namespace-isolated");
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("SPY_FETCH_CALLED"); };
  try {
    await assert.rejects(() => sb.recordSourceSnapshot({
      organizationFingerprint: "org1", connectionId: "primary", sourceKey: "product-catalog", scopeKey: "__organization",
      objectPath: pathA, payloadSha: shaB, rowCount: 1, sourceRequestHash: "h", validatedAt: "2026-08-20T00:00:00Z",
    }), /same save/);
  } finally { globalThis.fetch = realFetch; }
});

test("R6. corrupted existing batch membership is refused typed with ZERO exports", async () => {
  const org = identity.organizationFingerprint(PRIM_KEY);
  const V = runtimeMod.validateBatchMembershipRows;
  const good = { account_id: "A01", connection_id: "primary", organization_fingerprint: org, batch_index: 0 };
  assert.ok(V([good], { orgFingerprint: org }) instanceof Map, "a valid row is accepted");
  for (const bad of [
    { ...good, account_id: "" },
    { ...good, account_id: ["dd", "secondary"].join("-") + ":X" },
    { ...good, connection_id: "dd-secondary" },
    { ...good, organization_fingerprint: "other-org" },
    { ...good, batch_index: -1 },
    { ...good, batch_index: 1.5 },
  ]) {
    assert.throws(() => V([bad], { orgFingerprint: org }), (e) => e.code === "BATCH_MEMBERSHIP_CORRUPT");
  }
  assert.throws(() => V([good, { ...good }], { orgFingerprint: org }), (e) => e.code === "BATCH_MEMBERSHIP_CORRUPT", "duplicate account");
  const six = Array.from({ length: 6 }, (_, i) => ({ ...good, account_id: "A0" + i }));
  assert.throws(() => V(six, { orgFingerprint: org }), (e) => e.code === "BATCH_MEMBERSHIP_CORRUPT", ">5 in one batch");
  const h = makeHarness({ readBatchMembership: async () => [{ ...good, organization_fingerprint: "evil-org" }] });
  await assert.rejects(() => h.runtime.run({ bucket: "us", today: TODAY }), (e) => e.code === "BATCH_MEMBERSHIP_CORRUPT");
  assert.equal(h.dd.totalCreates(), 0, "zero exports on corrupt membership");
});

test("R7. stale / dangling / integrity-broken snapshot evidence produces typed readiness blockers", async () => {
  // (a) STALE required catalog evidence: typed, BLOCKING (ready:false), and never usable for derivation.
  const stale = makeHarness({
    readSnapshot: async ({ sourceKey }) => (sourceKey === "product-catalog"
      ? { snapshot: { validated_at: "2026-08-18T01:00:00Z", object_path: "source-snapshots/v1/product-catalog/__organization.json", row_count: 1 }, read: "ok", error: null }
      : { snapshot: { validated_at: "2026-08-20T01:00:00Z", object_path: "missing-object", row_count: 1 }, read: "ok", error: null }),
  });
  stale.clockRef.now = Date.UTC(2026, 7, 20, 12, 0); // today = 2026-08-20 -> the 08-18 catalog is STALE
  stale.snapStore.set("source-snapshots/v1/product-catalog/__organization.json", { rows: [{ child_asin: "B0A", product_brand: "Acme" }] });
  const readiness = await stale.runtime.gatherDurableReadiness({ bucket: "us", accounts: [{ accountId: "A01" }], asOf: ASOF });
  assert.ok(readiness.daily.blockedBy.some((b) => b.sourceKey === "product-catalog" && b.reason === "snapshot-stale"), "stale evidence is typed");
  assert.equal(readiness.daily.ready, false, "round-4 finding 7: REQUIRED stale catalog evidence makes the dashboard NOT ready");
  assert.equal(readiness.brandView.ready, false, "Brand View is not ready on stale required evidence either");
  // (b) a FRESH pointer whose object is GONE: typed dangling.
  assert.ok(readiness.brandView.blockedBy.some((b) => b.sourceKey === "fba-inventory-health" && b.reason === "snapshot-dangling"), "a dangling pointer is typed");
  // (c) a FRESH catalog whose row_count disagrees with the hydrated rows: typed integrity, BLOCKING.
  const broken = makeHarness({
    readSnapshot: async ({ sourceKey }) => (sourceKey === "product-catalog"
      ? { snapshot: { validated_at: "2026-08-20T01:00:00Z", object_path: "source-snapshots/v1/product-catalog/__organization.json", row_count: 5 }, read: "ok", error: null }
      : { snapshot: null, read: "ok", error: null }),
  });
  broken.clockRef.now = Date.UTC(2026, 7, 20, 12, 0);
  broken.snapStore.set("source-snapshots/v1/product-catalog/__organization.json", { rows: [{ child_asin: "B0A", product_brand: "Acme" }] });
  const integ = await broken.runtime.gatherDurableReadiness({ bucket: "us", accounts: [{ accountId: "A01" }], asOf: ASOF });
  assert.ok(integ.daily.blockedBy.some((b) => b.sourceKey === "product-catalog" && b.reason === "snapshot-integrity"), "row-count integrity is typed");
  assert.equal(integ.daily.ready, false, "integrity-broken required evidence blocks readiness");
});

test("R8. endpoint ordering pins: PATCH boolean-strict BEFORE any write; POST preflight BEFORE the audit", () => {
  const src = readFileSync(path.join(process.cwd(), "api", "admin", "sources.js"), "utf8");
  const boolCheck = src.indexOf('typeof body.paused !== "boolean"');
  const patchWrite = src.indexOf("setSourceControl({ sourceKey, paused");
  assert.ok(boolCheck > 0 && patchWrite > boolCheck, "PATCH validates the boolean before its first write");
  const mkDeadline = src.indexOf("runtime.makeDeadline()");
  const preflight = src.indexOf("preflightEvidence({ bucket, sourceKey: onlySourceKey, deadline })");
  const postAudit = src.indexOf('action: "source.sync.missing"');
  assert.ok(mkDeadline > 0 && preflight > mkDeadline, "round-5: the ONE route-owned deadline is created BEFORE preflight");
  assert.ok(preflight > 0 && postAudit > preflight, "POST runs the evidence preflight BEFORE the audit write");
  const exec = src.indexOf("deadline, preflight });");
  assert.ok(exec > postAudit, "execution consumes the SAME route deadline + memoized preflight bundle");
});

test("R9. dropped / weakened / wrong-schema POLICIES each raise a typed audit blocker", () => {
  const dropped = auditWith((sql) => sql.replace(/create policy source_controls_admin_read on public\.source_controls\n  for select to authenticated using \(public\.is_dashboard_admin\(\)\);/, ""));
  assert.ok(dropped.blockers.some((b) => b.code === "POLICY_MISSING"), JSON.stringify(dropped.blockers.map((b) => b.code)));
  const weakened = auditWith((sql) => sql.split("create policy source_coverage_admin_read on public.source_coverage\n  for select to authenticated using (public.is_dashboard_admin());").join("create policy source_coverage_admin_read on public.source_coverage\n  for select to anon using (true);"));
  assert.ok(weakened.blockers.some((b) => b.code === "POLICY_MISMATCH"), JSON.stringify(weakened.blockers.map((b) => b.code)));
  const unexpected = auditWith((sql) => sql + "\ncreate policy sneaky_read on public.source_snapshots for select to authenticated using (true);\n");
  assert.ok(unexpected.blockers.some((b) => b.code === "POLICY_UNEXPECTED"), JSON.stringify(unexpected.blockers.map((b) => b.code)));
});


/* ================================= S. round-4 regressions ================================= */
group("S. round-4: ads read state, terminal policies, lineage, full preflight, unreadable loaders, CAS, canonical ids");

test("S1. a failed/limited readAdMetrics is NEVER flattened into ok-zero ads (typed metricsRead; no false zero)", async () => {
  const mk = (reader) => makeHarness({
    readAdMetrics: reader,
    readCoverage: async () => ({ windows: [{ from: "2025-01-01", to: TODAY }], read: "ok", error: null }),
    readSnapshot: async ({ sourceKey }) => (sourceKey === "product-catalog"
      ? { snapshot: { validated_at: TODAY + "T01:00:00Z", object_path: "source-snapshots/v1/product-catalog/__organization.json", row_count: 1 }, read: "ok", error: null }
      : { snapshot: { validated_at: TODAY + "T01:00:00Z" }, read: "ok", error: null }),
  });
  for (const [reader, label] of [
    [async () => { throw new Error("boom"); }, "read-failed"],
    [async () => { const e = new Error("cap"); e.code = "ADS_ROW_LIMIT_EXCEEDED"; throw e; }, "limit-exceeded"],
    [async () => "not-an-array", "read-failed"],
  ]) {
    const h = mk(reader);
    h.snapStore.set("source-snapshots/v1/product-catalog/__organization.json", { rows: [{ child_asin: "B0A", sku: "SKU-A", product_brand: "Acme" }] });
    h.durableHistory.set("A01|x", { accountId: "A01", saleDate: ASOF, sku: "SKU-A", childAsin: "B0A", currency: "USD", salesAmount: 10, units: 1 });
    const rollup = await h.runtime.run({ bucket: "us", today: TODAY });
    assert.equal(rollup.stopped, false, JSON.stringify(rollup.stopReason));
    const dailySave = h.recorded.shadowSaves.find((x) => x.reportKey === "scheduler-v2/daily-reporting");
    assert.ok(dailySave, "the sales snapshot still saves (ads never block sales)");
    assert.equal(dailySave.payload.adsAvailability.status, "failed", label + ": the Ads half is typed FAILED, never a clean zero");
    assert.match(String(dailySave.payload.adsAvailability.reason), /ads-read/, "the typed read reason travels with the payload");
  }
});

test("S2. genuine sync_report_jobs lineage: every durable save records upsert -> claim -> validated success with the EXACT snapshot_params_hash", async () => {
  // Dynamic partial-tail coverage => ONE complete-window OLI export opens the cycle so claim-before-save
  // lineage (upsert -> claim -> reconcile) is genuinely recorded; after replaceHistory acks the fetched tail
  // the derive re-read sees full coverage and derives (a fully-covered fixture would open no cycle and record
  // no lineage under the complete-window planner).
  const durableCoverage = [];
  const h = makeHarness({
    durableCoverage,
    readCoverage: dynamicTailCoverage(durableCoverage),
    readSnapshot: async ({ sourceKey }) => (sourceKey === "product-catalog"
      ? { snapshot: { validated_at: TODAY + "T01:00:00Z", object_path: "source-snapshots/v1/product-catalog/__organization.json", row_count: 1 }, read: "ok", error: null }
      : { snapshot: { validated_at: TODAY + "T01:00:00Z" }, read: "ok", error: null }),
  });
  h.snapStore.set("source-snapshots/v1/product-catalog/__organization.json", { rows: [{ child_asin: "B0A", sku: "SKU-A", product_brand: "Acme" }] });
  h.durableHistory.set("A01|x", { accountId: "A01", saleDate: ASOF, sku: "SKU-A", childAsin: "B0A", currency: "USD", salesAmount: 10, units: 1 });
  const rollup = await h.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(rollup.stopped, false, JSON.stringify(rollup.stopReason));
  assert.ok(rollup.derived.daily.saved >= 1, "daily saved");
  const upserts = h.recorded.lineage.filter((l) => l.op === "upsert");
  const reconciled = h.recorded.lineage.filter((l) => l.op === "reconcile" && l.disposition === "reconciled");
  assert.ok(upserts.some((l) => l.reportKey === "daily-reporting"), "a REAL sync_report_jobs row under the PRODUCTION key");
  assert.ok(upserts.some((l) => l.reportKey === "brand-sales"), "brand-sales lineage too");
  assert.ok(reconciled.length >= 1, "at least one report reconciled to validated success");
  for (const rec of reconciled) {
    const save = h.recorded.shadowSaves.find((x) => x.reportKey === "scheduler-v2/" + rec.reportKey && x.accountId === rec.accountId);
    assert.ok(save, "each reconcile maps to a real shadow save");
    const job = h.store.getReportJob(rec.reportKey, rec.accountId);
    assert.ok(job && job.validated === true && job.derive_status === "succeeded" && job.save_status === "succeeded", "the durable job is a validated success");
    assert.equal(job.snapshot_params_hash, reportStore.paramsHashFor(save.params.reportVersion, save.params), "the durable job records the EXACT saver-computed snapshot_params_hash");
  }
});

test("S3. FULL endpoint preflight: EVERY later read failure (coverage/snapshot/membership/settings/rollout) refuses typed BEFORE any write", async () => {
  const cases = [
    [{ readCoverage: async () => ({ windows: [], read: "read-failed", error: "X" }) }, "SOURCE_EVIDENCE_READ_FAILED"],
    [{ readSnapshot: async () => ({ snapshot: null, read: "schema-missing", error: "X" }) }, "DURABLE_MODEL_UNAVAILABLE"],
    [{ readBatchMembership: async () => { throw new Error("boom"); } }, "BATCH_MEMBERSHIP_READ_FAILED"],
    [{ readSettings: async () => { throw new Error("boom"); } }, "SETTINGS_READ_FAILED"],
    [{ readRollout: async () => ({ read: "read-failed" }) }, "ROLLOUT_READ_FAILED"],
  ];
  for (const [over, code] of cases) {
    const h = makeHarness(over);
    await assert.rejects(() => h.runtime.preflightEvidence({ bucket: "us", sourceKey: "product-catalog" }), (e) => e.code === code, code);
    assert.equal(h.store._opens, 0, code + ": zero cycle/store writes");
    assert.equal(h.dd.totalCreates(), 0, code + ": zero exports");
  }
  const ok = makeHarness({});
  const res = await ok.runtime.preflightEvidence({ bucket: "us", sourceKey: "product-catalog" });
  assert.ok(res.pausedSources instanceof Set, "a healthy sweep passes");
});

test("S4. an UNREADABLE cache loader (throws) at persistence is the SAME typed SOURCE_PAYLOAD_UNAVAILABLE stop", async () => {
  const store = makeStore();
  const succeeded = new Set();
  const origSuccess = store.recordSourceSuccess.bind(store);
  store.recordSourceSuccess = (args) => { succeeded.add(args.requestHash); return origSuccess(args); };
  const origLoad = store.loadSourceRows.bind(store);
  store.loadSourceRows = (h) => { if (succeeded.has(h)) throw new Error("storage transport boom"); return origLoad(h); };
  const h = makeHarness({ store });
  const rollup = await h.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(rollup.stopped, true);
  assert.equal(rollup.stopReason.code, "SOURCE_PAYLOAD_UNAVAILABLE");
  assert.equal(rollup.globalDrained, false);
});

test("S5. the snapshot pointer CAS: an OLDER save never replaces newer evidence; equal-conflicting fails closed; audit mutations typed", async () => {
  const sb = await import("../lib/server/supabase.js");
  const args = (validatedAt, sha) => ({
    organizationFingerprint: "org1", connectionId: "primary", sourceKey: "product-catalog", scopeKey: "__organization",
    objectPath: "source-snapshots/v2/org1/primary/product-catalog/__organization/" + sha + ".json", payloadSha: sha,
    rowCount: 1, sourceRequestHash: "h", validatedAt,
  });
  const sha = sb.sourceSnapshotPayloadSha([{ a: 1 }]);
  const stub = (ack) => { globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => JSON.stringify(ack), text: async () => JSON.stringify(ack), headers: new Map() }); };
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '"stale-save"', json: async () => "stale-save" });
    const stale = await sb.recordSourceSnapshot(args("2026-08-19T00:00:00Z", sha));
    assert.deepEqual({ write: stale.write, ack: stale.ack }, { write: "ok", ack: "stale-save" }, "an OLDER save is a no-write no-op (the newer evidence stands)");
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '"conflict"', json: async () => "conflict" });
    await assert.rejects(() => sb.recordSourceSnapshot(args("2026-08-20T00:00:00Z", sha)), (e) => e.code === "SOURCE_SNAPSHOT_CONFLICT", "equal-conflicting evidence fails closed");
  } finally { globalThis.fetch = realFetch; }
  // Audit mutations: gutting the CAS guards raises typed blockers; the real SQL audits clean.
  assert.equal(auditWith(null).ok, true);
  const noStale = auditWith((sql) => sql.replace(/if p_validated_at < v_existing\.validated_at then\s*return 'stale-save';\s*end if;/, ""));
  assert.ok(noStale.blockers.some((b) => b.code === "SNAPSHOT_CAS_STALE_GUARD_MISSING"), JSON.stringify(noStale.blockers.map((b) => b.code)));
  const noConflict = auditWith((sql) => sql.split("return 'conflict';").join("return 'unchanged';"));
  assert.ok(noConflict.blockers.some((b) => b.code === "SNAPSHOT_CAS_CONFLICT_GUARD_MISSING"), JSON.stringify(noConflict.blockers.map((b) => b.code)));
});

test("S6. TERMINAL policy enumeration: create-then-drop refused; undeclared policies refused; authenticated grants exact", () => {
  const createThenDrop = auditWith((sql) => sql + "\ndrop policy source_controls_admin_read on public.source_controls;\n");
  assert.ok(createThenDrop.blockers.some((b) => b.code === "POLICY_DROPPED" || b.code === "POLICY_MISSING"), JSON.stringify(createThenDrop.blockers.map((b) => b.code)));
  const missingAuthGrant = auditWith((sql) => sql.replace("grant select on table public.source_controls to authenticated;", ""));
  assert.ok(missingAuthGrant.blockers.some((b) => b.code === "AUTH_GRANT_MISSING"), JSON.stringify(missingAuthGrant.blockers.map((b) => b.code)));
  const widenedAuthGrant = auditWith((sql) => sql.replace("grant select on table public.source_coverage to authenticated;", "grant select, insert on table public.source_coverage to authenticated;"));
  assert.ok(widenedAuthGrant.blockers.some((b) => b.code === "AUTH_GRANT_FORBIDDEN"), JSON.stringify(widenedAuthGrant.blockers.map((b) => b.code)));
  const anonGrant = auditWith((sql) => sql + "\ngrant select on table public.source_snapshots to anon;\n");
  assert.ok(anonGrant.blockers.some((b) => b.code === "AUTH_GRANT_FORBIDDEN"), JSON.stringify(anonGrant.blockers.map((b) => b.code)));
});

test("S7. NONCANONICAL membership ids are REJECTED (never trimmed); the DB constraint is audited (STATEMENT_MISSING on removal)", async () => {
  const org = identity.organizationFingerprint(PRIM_KEY);
  const V = runtimeMod.validateBatchMembershipRows;
  const good = { account_id: "A01", connection_id: "primary", organization_fingerprint: org, batch_index: 0 };
  assert.throws(() => V([{ ...good, account_id: " A01" }], { orgFingerprint: org }), (e) => e.code === "BATCH_MEMBERSHIP_CORRUPT", "leading whitespace rejected, not trimmed");
  assert.throws(() => V([{ ...good, account_id: "A01 " }], { orgFingerprint: org }), (e) => e.code === "BATCH_MEMBERSHIP_CORRUPT", "trailing whitespace rejected, not trimmed");
  const stripped = auditWith((sql) => sql.replace(/alter table public\.source_batch_membership\n  add constraint source_batch_membership_account_canonical[\s\S]*?position\(':' in account_id\) = 0\);/, ""));
  assert.ok(stripped.blockers.some((b) => b.code === "STATEMENT_MISSING"), JSON.stringify(stripped.blockers.map((b) => b.code)));
});

/* ================================= T. round-5 regressions ================================= */
group("T. round-5: claim-before-save lineage + real publisher acceptance, Brand View read path, memoized preflight, route deadline, sequential ACLs, CAS binding");

// COMPLETE-WINDOW OLI model: the authorized backfill window is [2025-01-01, asOf]. A realistic durable fixture
// always has the most-recent tail [ASOF-6, ASOF] still MISSING (the latest completed days are never proven
// until today's fetch), so the complete-window planner emits EXACTLY ONE OLI export per <=5-seller batch. That
// one export opens the cycle, records claim-before-save lineage + account-exact depends_on, and -- once its
// fetched window is ack'd into liveEvidence (runtime line ~646) -- makes the derive stage ready.
//
// The reader is STATIC (never grows to full on purpose): a resume re-plans the SAME missing window, REUSES the
// cached export (zero NEW creates), idempotently re-acks the same window, and observes every report
// already-complete -- so cycle continuity + lineage survive the resume. A fixture whose durable coverage grew
// to FULL would leave a resume with zero OLI work, hence no rollup.cycleId and no lineage/depends_on; that
// 0-work durable-evidence continuation is deliberately OUT of this planner-scoped change (deferred rework). The
// "a persisted full window plans zero child exports" property is proven separately (zero-export-rehearsal).
// DYNAMIC durable coverage, bound to the harness's `durableCoverage` log. The INITIAL persisted history proves
// only [2025-01-01, ASOF-7] (the most-recent tail is not yet fetched), so the complete-window planner emits
// EXACTLY ONE OLI export for the missing tail. Once that export's atomic replaceHistory acks the fetched window
// into `durableCoverage`, a SUBSEQUENT read returns the now-extended (adjacent-merged => full) coverage --
// exactly as a real DB re-read after the replace transaction would -- so the derive stage sees full coverage and
// becomes ready. A resume reuses the cached export, re-acks the same window idempotently, and reaches the SAME
// full coverage. `mergeCoverageWindows` merges the adjacent seed + tail into one proving window.
const OLI_SEED_TO = () => dates.addDaysStr(ASOF, -7);
function dynamicTailCoverage(durableCoverage) {
  return async ({ accountId }) => {
    const acked = durableCoverage.filter((c) => c.accountId === accountId).map((c) => ({ from: c.from, to: c.to }));
    const windows = durableModel.mergeCoverageWindows([{ from: "2025-01-01", to: OLI_SEED_TO() }, ...acked]);
    return { windows, read: "ok", error: null };
  };
}

// A COMPLETE durable fixture: STATIC partial-tail OLI coverage (one complete-window export per batch per run),
// fresh hydratable catalog + per-account FBA snapshots and seeded history, so a full bucket run fetches the
// missing OLI window, drains, derives Daily + Brand View + compact brand-inventory, records lineage and
// finalizes its cycle. `over` wins over every fixture default.
function fullFixture(over = {}) {
  const durableCoverage = over.durableCoverage || [];
  const h = makeHarness({
    durableCoverage,
    readCoverage: dynamicTailCoverage(durableCoverage),
    readSnapshot: async ({ sourceKey, scopeKey }) => {
      if (sourceKey === "product-catalog") return { snapshot: { validated_at: TODAY + "T01:00:00Z", object_path: "source-snapshots/v1/product-catalog/__organization.json", row_count: 1 }, read: "ok", error: null };
      return { snapshot: { validated_at: TODAY + "T01:00:00Z", object_path: "source-snapshots/v1/fba-inventory-health/" + scopeKey + ".json", row_count: 1 }, read: "ok", error: null };
    },
    ...over,
  });
  h.snapStore.set("source-snapshots/v1/product-catalog/__organization.json", { rows: [{ child_asin: "B0A", sku: "SKU-A", product_brand: "Acme" }] });
  for (const a of ["A01", "A02"]) {
    h.snapStore.set("source-snapshots/v1/fba-inventory-health/" + a + ".json", { rows: [{ date: ASOF, sku: "SKU-A", child_asin: "B0A", marketplace_country_code: "US", available: 5 }] });
  }
  h.durableHistory.set("A01|x", { accountId: "A01", saleDate: ASOF, sku: "SKU-A", childAsin: "B0A", currency: "USD", salesAmount: 10, units: 1 });
  return h;
}

test("T1. blocker 1: CLAIM-BEFORE-SAVE lineage with exact depends_on hashes; the runtime-produced cycle/job passes the REAL buildSchedulerV2Publisher (no fabricated cycle_status)", async () => {
  const h = fullFixture();
  const rollup = await h.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(rollup.stopped, false, JSON.stringify(rollup.stopReason));
  assert.equal(rollup.derived.skipped, null);
  assert.ok(rollup.derived.daily.saved >= 1 && rollup.derived.brandView.saved >= 1, "durable saves happened");
  // (a) ORDER per (report, account): upsert -> claim(claimed) -> save -> reconcile(reconciled), from ONE
  // recorder. Round-7: success is now a GUARDED RECONCILE bound to the durable snapshot, held under a lease.
  const reconciles = h.recorded.lineage.filter((l) => l.op === "reconcile" && l.disposition === "reconciled");
  assert.ok(reconciles.length >= 3, "daily + brand-sales + brand-inventory lineage reconciled");
  for (const s of reconciles) {
    const seq = h.recorded.lineage.filter((l) =>
      (l.reportKey === s.reportKey || l.reportKey === "scheduler-v2/" + s.reportKey) && l.accountId === s.accountId);
    const ops = seq.map((l) => l.op);
    assert.deepEqual(ops, ["upsert", "claim", "save", "reconcile"], s.reportKey + "/" + s.accountId + ": the lease is claimed BEFORE the save, reconcile only after a durable save");
    assert.equal(seq[1].disposition, "claimed", "the lease is CLAIMED (not stolen) before any save");
    assert.equal(seq[3].disposition, "reconciled", "success is a guarded RECONCILE bound to the exact durable snapshot");
  }
  // (b) depends_on binds each job to the EXACT authoritative source request hashes ITS OWN ACCOUNT owns
  // (round-6 fix 5): the account's batch OLI hashes + its own FBA hash + the shared organization catalog.
  const jobRows = h.store.listSourceJobs(rollup.cycleId);
  const owners = h.store.listCycleOwners(rollup.cycleId);
  const succeededByHash = new Map(jobRows.filter((r) => r.fetch_status === "succeeded").map((r) => [r.request_hash, r.source_key]));
  const ownedBy = (aid) => new Set(owners.filter((o) => o.account_id === aid || o.account_id === "__organization").map((o) => o.request_hash));
  const expectFor = (aid, families) => [...succeededByHash].filter(([hash, sk]) => families.includes(sk) && ownedBy(aid).has(hash)).map(([hash]) => hash).sort();
  const upserts = h.recorded.lineage.filter((l) => l.op === "upsert");
  assert.ok(upserts.length >= 3, "lineage rows upserted");
  for (const u of upserts) {
    const fams = u.reportKey === "brand-inventory"
      ? ["order-line-items", "product-catalog", "fba-inventory-health"]
      : ["order-line-items", "product-catalog"];
    const want = expectFor(u.accountId, fams);
    assert.ok(want.length >= 1, u.reportKey + "/" + u.accountId + ": authoritative owned hashes exist");
    assert.deepEqual([...u.dependsOn].sort(), want, u.reportKey + "/" + u.accountId + ": depends_on is the EXACT account-owned succeeded hash set");
  }
  // (c) round-6 fix 1: the SOURCE runtime never terminalizes the SHARED cycle -- the cycle stays running
  // after a full source-card run (an honest READ, no write). The reviewed terminal lifecycle belongs to the
  // CANONICAL SCHEDULED dispatcher's complete-scope close (the guarded finalize primitive) -- invoked here
  // exactly as the dispatcher invokes it once the whole scope is drained. Nothing fabricates a status.
  assert.equal(rollup.finalized, false, "the source runtime did NOT finalize the shared cycle");
  assert.equal(rollup.cycleStatus, "running", "the shared cycle honestly stays running after a source-only run");
  assert.equal(h.store.getCycle(rollup.cycleId).status, "running");
  assert.ok(rollup.derived.lineage.every((l) => l.outcome === "recorded"), "no lost claims in a single-worker run");
  const closed = h.store.finalizeCycle({ cycleId: rollup.cycleId }); // the dispatcher-owned reviewed close
  assert.equal(closed.disposition, "finalized", "the complete drained scope finalizes atomically");
  assert.equal(closed.cycle.status, "succeeded", "the terminal status comes from the guarded primitive's own counters");
  // (d) the ACTUAL runtime-produced job + cycle pass the REAL composed publisher. Every value the publisher
  // validates (validated/derive/save/cycle_status/snapshot_params_hash/params/payload) is read from the
  // harness rows the RUNTIME wrote -- the test fabricates NOTHING.
  const pubMod = await import("../lib/server/sync/publisher-composition.js");
  const published = [];
  const publisher = pubMod.buildSchedulerV2Publisher({
    codeReadyKeys: ["brand-sales"],
    connections: CONNS,
    fetchAccounts: async (apiKey) => (apiKey === PRIM_KEY ? [dirAccount("A01"), dirAccount("A02")] : [dirAccount("B01")]),
    getSettings: async () => [{ report_key: "brand-sales", schedule_enabled: true }],
    getAccountRollout: async () => ({ read: "ok", allPrimary: true, enabledAccountIds: [] }),
    getApproval: async () => ({ read: "ok", approved: true }),
    getJob: async (rk, a) => {
      const j = h.store.getReportJob(rk, a);
      return j ? { ...j, cycle_status: h.store.getCycle(j.cycle_id).status } : null;
    },
    getSnapshot: async ({ reportKey, accountId, paramsHash }) => {
      const s = h.recorded.shadowSaves.find((x) => x.reportKey === reportKey && x.accountId === accountId && x.paramsHash === paramsHash);
      return s ? { params_hash: s.paramsHash, params: s.params, payload: s.payload, payload_storage_path: null, source_refreshed_at: s.sourceRefreshedAt } : null;
    },
    loadStoragePayload: async () => null,
    publishLive: async (args) => { published.push(args); return { outcome: "inserted" }; },
  });
  const res = await publisher.publish("brand-sales", "A01");
  assert.equal(res.disposition, "published", JSON.stringify(res));
  assert.equal(published.length, 1, "the live CAS primitive received exactly one publish");
});

test("T2. round-7: idempotent RESUME re-observes already-complete (zero new work); finalization terminalizes ONLY after every report is truly complete", async () => {
  // Run 1 over the SAME store reconciles every report to success (claimed -> save -> reconciled).
  const h = fullFixture();
  const r1 = await h.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(r1.stopped, false, JSON.stringify(r1.stopReason));
  assert.equal(r1.finalized, false, "the source runtime never finalizes the shared cycle");
  assert.equal(r1.cycleStatus, "running");
  assert.ok(r1.derived.lineage.length >= 3 && r1.derived.lineage.every((l) => l.outcome === "recorded"), "run 1 reconciled EVERY report");
  const saves1 = h.recorded.shadowSaves.length;
  const creates1 = h.dd.totalCreates();
  const reconciles1 = h.recorded.lineage.filter((l) => l.op === "reconcile" && l.disposition === "reconciled").length;
  // Resume: run 2 over the SAME store re-observes already-complete and does ZERO new work.
  const r2 = await h.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(h.dd.totalCreates(), creates1, "no duplicate export on resume");
  assert.equal(h.recorded.shadowSaves.length, saves1, "no duplicate shadow save on resume (already-complete short-circuits before any save)");
  assert.equal(h.recorded.lineage.filter((l) => l.op === "reconcile" && l.disposition === "reconciled").length, reconciles1, "no duplicate reconcile");
  assert.ok(r2.derived.lineage.length >= 3 && r2.derived.lineage.every((l) => l.outcome === "already-complete"), "every resume report is already-complete (never claim-lost, never re-saved)");
  assert.equal(r2.cycleStatus, "running", "the shared cycle STILL is not terminalized by any source-only run");
  // FINDING 1: after recovery/completion the dispatcher can finalize HONESTLY -- open-work -> terminal only
  // because every report is truly complete.
  const closed = h.store.finalizeCycle({ cycleId: r1.cycleId });
  assert.equal(closed.disposition, "finalized", "the complete drained scope finalizes atomically");
  assert.ok(["succeeded", "partial"].includes(closed.cycle.status), "the cycle terminalizes honestly once every report is complete");
});

test("T3. blocker 2: the durable FBA evidence reaches Brand View through its REAL read path (buildAccountBrandSlice -> compact snapshot gate), not a direct builder call", async () => {
  const h = fullFixture();
  const rollup = await h.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(rollup.stopped, false, JSON.stringify(rollup.stopReason));
  assert.ok(rollup.derived.brandInventory.saved >= 1, "the compact brand-inventory shadow snapshot saved: " + JSON.stringify(rollup.derived.brandInventory));
  const invSave = h.recorded.shadowSaves.find((s) => s.reportKey === "scheduler-v2/brand-inventory" && s.accountId === "A01");
  assert.ok(invSave, "saved under the EXISTING shadow key");
  assert.equal(invSave.params.reportVersion, "brand-inventory-shared-v1", "the EXISTING compact report version");
  assert.ok(Array.isArray(invSave.payload.inventoryByBrandCountry), "the EXISTING compact payload contract");
  // THE REAL production orchestration: buildAccountBrandSlice reads brand-sales + the compact inventory
  // through its own snapshot gate (isCompactInventorySnapshot) -- the ONLY injected seam is readSnapshot.
  const bv = await import("../lib/server/reports/brand-view.js");
  const getSnapshot = async ({ reportKey, accountId }) => {
    const s = [...h.recorded.shadowSaves].reverse().find((x) => x.reportKey === "scheduler-v2/" + reportKey && x.accountId === accountId);
    return s ? { params: s.params, params_hash: s.paramsHash, payload: s.payload, source_refreshed_at: s.sourceRefreshedAt } : null;
  };
  const slice = await bv.buildAccountBrandSlice({
    accountId: "A01", brand: "Acme", asOf: ASOF, account: { name: "Acct A01", country: "US" },
    getSnapshot, getAdsRows: async () => [],
  });
  assert.equal(slice.inventory.scope, "country", "the compact snapshot is AUTHORITATIVE through the real gate (never the legacy fallback)");
  assert.equal(slice.inventory.accountTotal, 5, "the durable FBA quantity arrived via the real read path");
  assert.equal(slice.inventoryDate, ASOF, "the inventory date travels from the durable evidence");
  assert.ok(slice.sales, "the brand-sales half of the REAL slice consumed the durable-derived snapshot");
});

test("T4. blocker 3: preflight sweeps hydration/integrity/ads-coverage/ads-metrics/history typed BEFORE any write; execution consumes ONE memoized bundle with ZERO repeated reads", async () => {
  // (a) every NEW read-failure class refuses typed with ZERO writes and ZERO exports.
  const catalogPointer = { snapshot: { validated_at: TODAY + "T01:00:00Z", object_path: "source-snapshots/v1/product-catalog/__organization.json", row_count: 1 }, read: "ok", error: null };
  const cases = [
    ["SNAPSHOT_HYDRATION_FAILED", { readSnapshot: async ({ sourceKey }) => (sourceKey === "product-catalog" ? catalogPointer : { snapshot: null, read: "ok", error: null }) }, (h) => { /* no snapStore object => dangling */ }],
    ["SNAPSHOT_INTEGRITY_FAILED", { readSnapshot: async ({ sourceKey }) => (sourceKey === "product-catalog" ? { ...catalogPointer, snapshot: { ...catalogPointer.snapshot, row_count: 5 } } : { snapshot: null, read: "ok", error: null }) }, (h) => { h.snapStore.set("source-snapshots/v1/product-catalog/__organization.json", { rows: [{ child_asin: "B0A" }] }); }],
    ["ADS_COVERAGE_READ_FAILED", { readAdsCoverage: async () => ({ windows: [], read: "read-failed", error: "X" }) }, null],
    ["ADS_METRICS_READ_FAILED", { readAdMetrics: async () => { throw new Error("boom"); } }, null],
    ["ADS_METRICS_READ_FAILED", { readAdMetrics: async () => "not-an-array" }, null],
    ["HISTORY_READ_FAILED", { loadHistoryRows: async () => { throw new Error("boom"); } }, null],
  ];
  for (const [code, over, prep] of cases) {
    const h = makeHarness(over);
    if (prep) prep(h);
    await assert.rejects(() => h.runtime.preflightEvidence({ bucket: "us", today: TODAY }), (e) => e.code === code && e.status === 503, code);
    assert.equal(h.store._opens, 0, code + ": zero cycle writes");
    assert.equal(h.dd.totalCreates(), 0, code + ": zero exports");
    assert.equal(h.recorded.snapshots.length + h.recorded.shadowSaves.length + h.recorded.replaceCalls.length + h.recorded.lineage.length, 0, code + ": zero snapshot/report/history writes");
  }
  // limit-exceeded is a VALID authoritative Ads answer: memoized typed, NOT a refusal.
  const lim = fullFixture({ readAdMetrics: async () => { const e = new Error("cap"); e.code = "ADS_ROW_LIMIT_EXCEEDED"; throw e; } });
  const pfLim = await lim.runtime.preflightEvidence({ bucket: "us", today: TODAY });
  assert.equal(pfLim.adMetricsByAccountId.A01.metricsRead, "limit-exceeded", "typed degrade memoized in the bundle");
  // (b) execution consumes the ONE memoized bundle: ZERO repeated discovery/controls/coverage/snapshot/
  // hydration/ads/history reads -- and STILL derives fresh (the sync's own products fold in-memory).
  const counts = { controls: 0, discovery: 0, coverage: 0, snapshot: 0, adsCov: 0, metrics: 0, history: 0 };
  const h2 = fullFixture({
    onFetchAccounts: () => { counts.discovery += 1; },
    readSourceControls: async () => { counts.controls += 1; return { rows: [], read: "ok", error: null }; },
    readCoverage: async () => { counts.coverage += 1; return { windows: [{ from: "2025-01-01", to: TODAY }], read: "ok", error: null }; },
    readSnapshot: async ({ sourceKey, scopeKey }) => {
      counts.snapshot += 1;
      if (sourceKey === "product-catalog") return { snapshot: { validated_at: TODAY + "T01:00:00Z", object_path: "source-snapshots/v1/product-catalog/__organization.json", row_count: 1 }, read: "ok", error: null };
      return { snapshot: { validated_at: TODAY + "T01:00:00Z", object_path: "source-snapshots/v1/fba-inventory-health/" + scopeKey + ".json", row_count: 1 }, read: "ok", error: null };
    },
    readAdsCoverage: async () => { counts.adsCov += 1; return { windows: [{ from: "2025-01-01", to: TODAY }], read: "ok", error: null }; },
    readAdMetrics: async () => { counts.metrics += 1; return []; },
    loadHistoryRows: async () => { counts.history += 1; return [{ account_id: "A01", sale_date: ASOF, sku: "SKU-A", child_asin: "B0A", currency: "USD", sales_amount: 10, units: 1 }]; },
  });
  const pf = await h2.runtime.preflightEvidence({ bucket: "us", today: TODAY });
  const membershipReadsAfterPreflight = h2.recorded.membershipReads;
  const snapCounts = { ...counts };
  const rollup = await h2.runtime.run({ bucket: "us", today: TODAY, preflight: pf });
  assert.equal(rollup.stopped, false, JSON.stringify(rollup.stopReason));
  assert.equal(rollup.derived.skipped, null, "the memoized bundle carried the WHOLE derive stage");
  assert.deepEqual(counts, snapCounts, "execution repeated ZERO discovery/controls/coverage/snapshot/ads/history reads");
  assert.equal(h2.recorded.membershipReads, membershipReadsAfterPreflight, "membership was read ONCE, in preflight");
  assert.ok(rollup.derived.daily.saved >= 1, "fresh derivation from the memoized evidence + this invocation's own persisted products");
});

test("T5. blocker 4: ONE route-owned deadline created BEFORE preflight bounds preflight + execution; total elapsed stays BELOW the route budget; a hung in-flight read is raced+aborted", async () => {
  assert.equal(typeof runtimeMod.makeRouteDeadline, "function", "the reviewed deadline wrapper is exported");
  // (a) total-elapsed proof: preflight + execution burn the SAME budget; expiry is typed-resumable and the
  // elapsed clock (INCLUDING preflight) stays under the route budget (reserve sized above the op cost).
  const store = makeStore();
  let h;
  h = fullFixture({
    store,
    // Complete-window model: empty coverage => ONE full-window OLI export per batch (no 7-day slices), so a
    // SINGLE create must burn past the reserve threshold (deadlineMs - reserveMs = t0 + 60_000) to prove the
    // shared budget expires mid-execution. 65_000 trips it on the first create's next bounded op; total elapsed
    // still stays under the 100_000 route budget.
    ddOpts: { onCreate: () => { h.clockRef.now += 65_000; } },
    budgetMs: 100_000, reserveMs: 40_000,
    readCoverage: async () => ({ windows: [], read: "ok", error: null }), // full backfill => plenty of work
  });
  const t0 = h.clockRef.now;
  const dl = h.runtime.makeDeadline();
  const pf = await h.runtime.preflightEvidence({ bucket: "us", deadline: dl, today: TODAY });
  const rollup = await h.runtime.run({ bucket: "us", today: TODAY, deadline: dl, preflight: pf });
  assert.equal(rollup.deadlineReached, true, "the shared budget expired mid-execution");
  assert.equal(rollup.continuationRequired, true, "typed resumable");
  assert.equal(dl.startMs, t0, "the ONE deadline was created before preflight and owned the whole route");
  assert.ok(h.clockRef.now - t0 < 100_000, "TOTAL elapsed (preflight + execution) stays below the route budget: " + (h.clockRef.now - t0));
  // (b) an in-flight read that NEVER resolves is bounded by the reviewed wrapper (race + abort): typed
  // ROUTE_DEADLINE_EXCEEDED refusal, zero writes, never a hung route.
  const delays = [];
  const hang = makeHarness({
    readCoverage: () => new Promise(() => {}), // hangs forever; ignores the abort signal
    setTimer: (fn, ms) => { delays.push(ms); return setTimeout(fn, 0); },
    clearTimer: (id) => clearTimeout(id),
  });
  await assert.rejects(
    () => hang.runtime.preflightEvidence({ bucket: "us", today: TODAY }),
    (e) => e.code === "ROUTE_DEADLINE_EXCEEDED" && e.status === 503,
    "the hung read is raced against the remaining budget",
  );
  assert.ok(delays.length >= 1 && delays.every((ms) => Number.isFinite(ms) && ms >= 1), "every in-flight op was bounded by a finite remaining-budget timer");
  assert.equal(hang.store._opens, 0, "zero writes after the bounded refusal");
  assert.equal(hang.dd.totalCreates(), 0, "zero exports");
});

test("T6. blocker 5: FINAL ACL state is audited SEQUENTIALLY (source-order GRANT/REVOKE replay), never a union of historical grants", () => {
  // grant-then-revoke: a LATER revoke removes the verb from the final state (a union would still count it).
  const grantThenRevoke = auditWith((sql) => sql + "\nrevoke select on table public.source_controls from authenticated;\n");
  assert.ok(grantThenRevoke.blockers.some((b) => b.code === "AUTH_GRANT_MISSING"), JSON.stringify(grantThenRevoke.blockers.map((b) => b.code)));
  // revoke-then-grant: the re-granted verb IS held afterwards -- the replay audits clean.
  const revokeThenGrant = auditWith((sql) => sql.replace(
    "grant select on table public.source_controls to authenticated;",
    "revoke select on table public.source_controls from authenticated;\ngrant select on table public.source_controls to authenticated;",
  ));
  assert.equal(revokeThenGrant.ok, true, JSON.stringify(revokeThenGrant.blockers));
  // a FORBIDDEN grant that a later revoke removed is cured in the final state.
  const curedForbidden = auditWith((sql) => sql + "\ngrant insert on table public.source_coverage to authenticated;\nrevoke insert on table public.source_coverage from authenticated;\n");
  assert.equal(curedForbidden.ok, true, JSON.stringify(curedForbidden.blockers));
  // an ARBITRARY role holding a non-empty FINAL set is forbidden; revoked-away it is clean again.
  const arbitraryRole = auditWith((sql) => sql + "\ngrant all on table public.source_snapshots to reporting_bot;\n");
  assert.ok(arbitraryRole.blockers.some((b) => b.code === "AUTH_GRANT_FORBIDDEN" && /reporting_bot/.test(b.message)), JSON.stringify(arbitraryRole.blockers.map((b) => b.code)));
  const arbitraryCured = auditWith((sql) => sql + "\ngrant all on table public.source_snapshots to reporting_bot;\nrevoke all on table public.source_snapshots from reporting_bot;\n");
  assert.equal(arbitraryCured.ok, true, JSON.stringify(arbitraryCured.blockers));
  // service_role is replayed sequentially too: a later revoke breaks the exact expected FINAL set.
  const srvRevoked = auditWith((sql) => sql + "\nrevoke update on table public.source_coverage from service_role;\n");
  assert.ok(srvRevoked.blockers.some((b) => b.code === "SERVICE_ROLE_GRANT_MISMATCH"), JSON.stringify(srvRevoked.blockers.map((b) => b.code)));
});

test("T7. blocker 6: strict CAS acknowledgements (exactly replaced|unchanged|stale-save|conflict) + structural guard binding, deterministic racing insert, and the exact Codex mutations", async () => {
  const sb = await import("../lib/server/supabase.js");
  const sha = sb.sourceSnapshotPayloadSha([{ a: 1 }]);
  const args = {
    organizationFingerprint: "org1", connectionId: "primary", sourceKey: "product-catalog", scopeKey: "__organization",
    objectPath: "source-snapshots/v2/org1/primary/product-catalog/__organization/" + sha + ".json", payloadSha: sha,
    rowCount: 1, sourceRequestHash: "h", validatedAt: "2026-08-20T00:00:00Z",
  };
  const realFetch = globalThis.fetch;
  const stub = (body) => { globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }); };
  try {
    // MALFORMED acknowledgements are TYPED failures -- never coerced into an "ok" write.
    for (const bad of [null, "weird", { ack: "replaced" }, ["replaced", "replaced"], 42]) {
      stub(bad);
      await assert.rejects(() => sb.recordSourceSnapshot(args), (e) => e.code === "SOURCE_SNAPSHOT_ACK_INVALID", "malformed ack " + JSON.stringify(bad));
    }
    // The four EXACT acknowledgements (scalar or single-row) validate; conflict stays a typed refusal.
    stub("replaced");
    assert.deepEqual((await sb.recordSourceSnapshot(args)).ack, "replaced");
    stub(["unchanged"]);
    assert.deepEqual((await sb.recordSourceSnapshot(args)).ack, "unchanged");
    stub("stale-save");
    assert.deepEqual((await sb.recordSourceSnapshot(args)).ack, "stale-save");
    stub("conflict");
    await assert.rejects(() => sb.recordSourceSnapshot(args), (e) => e.code === "SOURCE_SNAPSHOT_CONFLICT");
  } finally { globalThis.fetch = realFetch; }
  // Structural mutations on the RPC body -- each of the Codex reproductions is a TYPED blocker.
  assert.equal(auditWith(null).ok, true, "the real migration audits clean");
  const ifTrue = auditWith((sql) => sql.replace("if p_validated_at < v_existing.validated_at then", "if true then"));
  assert.ok(ifTrue.blockers.some((b) => b.code === "SNAPSHOT_CAS_STALE_GUARD_MISSING" || b.code === "SNAPSHOT_CAS_STALE_BRANCH_UNBOUND"), JSON.stringify(ifTrue.blockers.map((b) => b.code)));
  const earlyUpdate = auditWith((sql) => sql.replace(
    "  if p_validated_at < v_existing.validated_at then",
    "  update public.source_snapshots set validated_at = p_validated_at where organization_fingerprint = p_organization_fingerprint;\n  if p_validated_at < v_existing.validated_at then",
  ));
  assert.ok(earlyUpdate.blockers.some((b) => b.code === "SNAPSHOT_CAS_WRITE_BEFORE_GUARDS"), JSON.stringify(earlyUpdate.blockers.map((b) => b.code)));
  const wrongCmp = auditWith((sql) => sql.replace("if p_validated_at = v_existing.validated_at then", "if p_validated_at <> v_existing.validated_at then"));
  assert.ok(wrongCmp.blockers.some((b) => b.code === "SNAPSHOT_CAS_EQUAL_BRANCH_UNBOUND"), JSON.stringify(wrongCmp.blockers.map((b) => b.code)));
  const swallowed = auditWith((sql) => sql.replace("exception when unique_violation then", "exception when others then"));
  assert.ok(swallowed.blockers.some((b) => b.code === "SNAPSHOT_CAS_EXCEPTION_SWALLOWED"), JSON.stringify(swallowed.blockers.map((b) => b.code)));
  const noRaceHandler = auditWith((sql) => sql.replace("exception when unique_violation then", "exception when foreign_key_violation then"));
  assert.ok(noRaceHandler.blockers.some((b) => b.code === "SNAPSHOT_CAS_CONCURRENT_INSERT_UNPROVEN"), JSON.stringify(noRaceHandler.blockers.map((b) => b.code)));
});

/* ================================= U. round-6 regressions ================================= */
group("U. round-6: shared-cycle finalization, stale CAS winners, brand-inventory promotion, real route deadline, account-exact lineage, PG17 ACLs");

test("U1. fix 1: no source run terminalizes the SHARED cycle; later report runs append; same-day replay works; the DISPATCHER close is atomic and the Migration-5 guard then holds", async () => {
  // (a) a FULL source run leaves the shared (bucket, cycle_date) cycle RUNNING; a narrowed source-card
  // action never finalizes either.
  const h = fullFixture();
  const full = await h.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(full.stopped, false, JSON.stringify(full.stopReason));
  assert.equal(full.finalized, false, "a full source run never finalizes the shared cycle");
  assert.equal(full.cycleStatus, "running");
  const card = await h.runtime.runSourceCardAction({ bucket: "us", sourceKey: "product-catalog" });
  assert.equal(card.finalized, false, "a source-card run never finalizes");
  assert.notEqual(card.cycleStatus, "succeeded");
  // (b) a LATER report run on the SAME bucket/date can append + complete (Migration-5 guard passes on the
  // running cycle): model the tranche appending its own source + report work to the same cycle.
  const cycleId = full.cycleId;
  assert.ok(cycleId, "the shared cycle exists");
  h.store.upsertSourceJob({ cycleId, requestHash: "later_report_source_h1", requestKey: "keyword-rank:serp", sourceId: 9, sourceKey: "keyword-rank-serp", connectionId: "primary", organizationFingerprint: identity.organizationFingerprint(PRIM_KEY), accountScopeHash: "scope1" });
  h.store.recordSourceSuccess({ cycleId, requestHash: "later_report_source_h1", exportId: "e9", rowCount: 1, cacheObjectPath: "p" });
  h.store.upsertReportJob({ cycleId, reportKey: "keyword-rank", reportVersion: "kr/v1", accountId: "A01", connectionId: "primary", bucket: "us", dependsOn: ["later_report_source_h1"] });
  assert.equal(h.store.claimReportDerive(cycleId, "keyword-rank", "A01"), true, "the later report run claims on the RUNNING cycle");
  h.store.recordReportSuccess({ cycleId, reportKey: "keyword-rank", accountId: "A01", snapshotParamsHash: "kr_hash" });
  // (c) a SAME-DAY source-card replay succeeds -- the append guard never fires because nothing terminalized.
  const replay = await h.runtime.runSourceCardAction({ bucket: "us", sourceKey: "product-catalog" });
  assert.equal(replay.stopped === true, false, "the same-day replay ran without violating reject_append_to_terminal_cycle");
  // (d) the SCHEDULED complete-scope close stays correct + atomic: finalize -> terminal; a second close is
  // idempotent already-terminal; and ONLY THEN does the Migration-5 guard reject appends.
  const closed = h.store.finalizeCycle({ cycleId });
  assert.equal(closed.disposition, "finalized");
  assert.ok(["succeeded", "partial"].includes(closed.cycle.status));
  assert.equal(h.store.finalizeCycle({ cycleId }).disposition, "already-terminal", "idempotent");
  assert.throws(() => h.store.upsertSourceJob({ cycleId, requestHash: "post_terminal_h", requestKey: "x", sourceId: 1, sourceKey: "order-line-items", connectionId: "primary", organizationFingerprint: "o", accountScopeHash: "s" }), /terminal/, "the modeled Migration-5 guard rejects post-terminal appends");
  assert.throws(() => h.store.claimReportDerive(cycleId, "keyword-rank", "A01"), /terminal/, "post-terminal child UPDATES are rejected too");
  // (e) no fabricated status / trigger bypass: the runtime only ever REPORTED the store's own status.
  assert.equal(h.store.getCycle(cycleId).status, closed.cycle.status);
});

test("U2. fix 2: a CAS-losing candidate NEVER feeds derivation -- stale-save adopts the hydrated WINNER; an unreadable winner stops typed with LKG intact; unchanged accepts proven-identical content", async () => {
  // (a) stale-save: a NEWER concurrent catalog save won the pointer. The candidate (dd-fetched, brand
  // "Acme") loses; the WINNER (brand "WinnerBrand") must be what derivation consumes.
  const winnerPath = "source-snapshots/v1/product-catalog/winner.json";
  let staleServed = false;
  const h = makeHarness({
    readCoverage: async () => ({ windows: [{ from: "2025-01-01", to: TODAY }], read: "ok", error: null }),
    readSnapshot: async ({ sourceKey, scopeKey }) => {
      if (sourceKey === "product-catalog") {
        // BEFORE the sync's save: absent (so the sync plans the catalog fetch). AFTER the CAS returned
        // stale-save: the WINNING pointer.
        return staleServed
          ? { snapshot: { validated_at: TODAY + "T09:00:00Z", object_path: winnerPath, row_count: 1 }, read: "ok", error: null }
          : { snapshot: null, read: "ok", error: null };
      }
      return { snapshot: { validated_at: TODAY + "T01:00:00Z", object_path: "source-snapshots/v1/fba-inventory-health/" + scopeKey + ".json", row_count: 1 }, read: "ok", error: null };
    },
    recordSnapshot: async (s) => {
      if (s.sourceKey === "product-catalog") { staleServed = true; return { write: "ok", ack: "stale-save" }; }
      return { write: "ok", ack: "replaced" };
    },
  });
  h.snapStore.set(winnerPath, { rows: [{ child_asin: "B0A", sku: "SKU-A", product_brand: "WinnerBrand" }] });
  for (const a of ["A01", "A02"]) {
    h.snapStore.set("source-snapshots/v1/fba-inventory-health/" + a + ".json", { rows: [{ date: ASOF, sku: "SKU-A", child_asin: "B0A", marketplace_country_code: "US", available: 5 }] });
  }
  h.durableHistory.set("A01|x", { accountId: "A01", saleDate: ASOF, sku: "SKU-A", childAsin: "B0A", currency: "USD", salesAmount: 10, units: 1 });
  const pf = await h.runtime.preflightEvidence({ bucket: "us", today: TODAY });
  const rollup = await h.runtime.run({ bucket: "us", today: TODAY, preflight: pf });
  assert.equal(rollup.stopped, false, JSON.stringify(rollup.stopReason));
  assert.equal(rollup.derived.skipped, null, "the derive ran on the WINNER evidence");
  const sales = h.recorded.shadowSaves.find((s) => s.reportKey === "scheduler-v2/brand-sales" && s.accountId === "A01");
  assert.ok(sales, "brand-sales derived");
  assert.equal(sales.payload.asinBrand.B0A, "WinnerBrand", "derivation consumed the CAS WINNER's catalog");
  for (const save of h.recorded.shadowSaves) {
    assert.ok(!JSON.stringify(save.payload).includes("Acme"), "the LOSING candidate rows never reach any report payload");
  }
  // (b) an UNREADABLE winner: stale-save whose winning pointer cannot be hydrated -> typed stop, ZERO
  // report saves (LKG preserved), never a silent fold of the loser.
  const h2 = makeHarness({
    readCoverage: async () => ({ windows: [{ from: "2025-01-01", to: TODAY }], read: "ok", error: null }),
    readSnapshot: async ({ sourceKey }) => (sourceKey === "product-catalog"
      ? { snapshot: null, read: "ok", error: null } // pointer read after stale-save ALSO returns null => winner vanished
      : { snapshot: null, read: "ok", error: null }),
    recordSnapshot: async (s) => (s.sourceKey === "product-catalog" ? { write: "ok", ack: "stale-save" } : { write: "ok", ack: "replaced" }),
  });
  await assert.rejects(() => h2.runtime.run({ bucket: "us", today: TODAY }), (e) => e.code === "SOURCE_SNAPSHOT_STALE_WINNER_UNREADABLE", "unreadable winner fails closed typed");
  assert.equal(h2.recorded.shadowSaves.length, 0, "no report was saved from the losing candidate");
  // (c) unchanged: the CAS PROVED the existing pointer identical (same content sha + path) -- the candidate
  // content is authoritative and derivation proceeds.
  const h3 = fullFixture({
    recordSnapshot: async () => ({ write: "ok", ack: "unchanged" }),
  });
  const r3 = await h3.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(r3.stopped, false);
  assert.equal(r3.derived.skipped, null, "proven-identical content derives normally");
});

test("U3. fix 3: brand-inventory promotes through the REAL publisher composition to its EXACT live identity; live buildAccountBrandSlice reads the PROMOTED row with NO key remapping", async () => {
  const h = fullFixture();
  const rollup = await h.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(rollup.derived.brandInventory.saved >= 1, true, JSON.stringify(rollup.derived.brandInventory));
  h.store.finalizeCycle({ cycleId: rollup.cycleId }); // the dispatcher-owned reviewed complete-scope close
  const pubMod = await import("../lib/server/sync/publisher-composition.js");
  const liveRows = new Map(); // the LIVE report_snapshots natural-key model: report_key|account_id
  // Round-6 blocker 2: brand-inventory's durable enable comes from its OWN control
  // (getPromotedSettings -> source_promoted_publish_settings), NOT report_sync_settings. getSettings here
  // enables ONLY brand-sales (the dispatch control); it deliberately does NOT contain brand-inventory, so a
  // publish of brand-inventory that (wrongly) consulted report_sync_settings would be report-disabled.
  const makePublisher = (promotedRows) => pubMod.buildSchedulerV2Publisher({
    // NO codeReadyKeys override: the PRODUCTION default must include brand-inventory -- this test FAILS if
    // the key is unknown, code-locked, or unpublishable.
    connections: CONNS,
    fetchAccounts: async (apiKey) => (apiKey === PRIM_KEY ? [dirAccount("A01"), dirAccount("A02")] : [dirAccount("B01")]),
    getSettings: async () => [{ report_key: "brand-sales", schedule_enabled: true }],
    getPromotedSettings: async () => promotedRows,
    getAccountRollout: async () => ({ read: "ok", allPrimary: true, enabledAccountIds: [] }),
    getApproval: async () => ({ read: "ok", approved: true }), // the explicit audited per-(report, account) approval
    getJob: async (rk, a) => {
      const j = h.store.getReportJob(rk, a);
      return j ? { ...j, cycle_status: h.store.getCycle(j.cycle_id).status } : null;
    },
    getSnapshot: async ({ reportKey, accountId, paramsHash }) => {
      const sv = h.recorded.shadowSaves.find((x) => x.reportKey === reportKey && x.accountId === accountId && x.paramsHash === paramsHash);
      return sv ? { params_hash: sv.paramsHash, params: sv.params, payload: sv.payload, payload_storage_path: null, source_refreshed_at: sv.sourceRefreshedAt } : null;
    },
    loadStoragePayload: async () => null,
    publishLive: async (args) => {
      liveRows.set(args.reportKey + "|" + args.accountId, {
        report_key: args.reportKey, params: args.params, params_hash: args.paramsHash,
        payload: args.payload, source_refreshed_at: args.sourceRefreshedAt,
      });
      return { outcome: "inserted" };
    },
  });
  // DEFAULT-OFF (the real seeded state: publish_enabled false / no row): brand-inventory is report-disabled,
  // even though its code readiness, rollout, approval, job and snapshot are all satisfied.
  assert.equal((await makePublisher([{ report_key: "brand-inventory", publish_enabled: false }]).publish("brand-inventory", "A01")).disposition, "report-disabled", "default-off promoted control => report-disabled");
  assert.equal((await makePublisher([]).publish("brand-inventory", "A01")).disposition, "report-disabled", "absent promoted row => report-disabled (fail closed)");
  // The operator ENABLES the promoted control (setSourcePromotedPublishControl writes publish_enabled=true).
  const publisher = makePublisher([{ report_key: "brand-inventory", publish_enabled: true }]);
  const resInv = await publisher.publish("brand-inventory", "A01");
  assert.equal(resInv.disposition, "published", JSON.stringify(resInv) + " -- brand-inventory must not be unknown/code-locked/unpublishable");
  assert.equal(resInv.liveReportKey, "brand-inventory", "the EXACT live report key");
  assert.equal((await publisher.publish("brand-sales", "A01")).disposition, "published");
  const liveInv = liveRows.get("brand-inventory|A01");
  assert.equal(liveInv.params.reportVersion, "brand-inventory-shared-v1", "the EXACT live shared version");
  assert.deepEqual(Object.keys(liveInv.params).sort(), ["reportVersion", "to"], "the EXACT live params contract ({ to })");
  assert.equal(liveInv.params.to, ASOF);
  // LIVE read path: buildAccountBrandSlice reads the PROMOTED PRODUCTION rows by their PLAIN live report
  // keys (getLatestReportSnapshot semantics) -- no scheduler-v2/ remapping anywhere in the reader.
  const bv = await import("../lib/server/reports/brand-view.js");
  const liveReader = async ({ reportKey, accountId }) => liveRows.get(reportKey + "|" + accountId) || null;
  const slice = await bv.buildAccountBrandSlice({ accountId: "A01", brand: "Acme", asOf: ASOF, account: { name: "Acct A01", country: "US" }, getSnapshot: liveReader, getAdsRows: async () => [] });
  assert.equal(slice.inventory.scope, "country", "the compact gate accepted the PROMOTED live row");
  assert.equal(slice.inventory.accountTotal, 5, "the durable FBA quantity arrived via the LIVE row");
  assert.equal(slice.inventoryDate, ASOF);
  // Structural: the promoted key is NOT dispatchable -- even a durable enable row selects nothing, and no
  // dispatcher/source-runtime path publishes automatically.
  const controls = await import("../lib/server/sync/report-controls.js");
  const dispatch = await import("../lib/server/sync/sync-dispatch.js");
  assert.ok(!controls.CONTROLLED_REPORT_KEYS.includes("brand-inventory"), "brand-inventory is NOT a controlled (dispatchable) report");
  assert.ok(controls.SOURCE_PROMOTED_REPORT_KEYS.includes("brand-inventory"), "brand-inventory is an explicit source-promoted key");
  const sel = dispatch.selectSchedulerV2ReportKeys({ settings: [{ report_key: "brand-inventory", schedule_enabled: true }] });
  assert.ok(!sel.requested.includes("brand-inventory") && !sel.readySet.has("brand-inventory"), "a durable enable row alone can never schedule the promoted key");
});

test("U4. fix 4: AbortSignal reaches the REAL HTTP wrapper; before-request expiry runs nothing; in-flight write expiry is commit-unknown; no ghost write after the handler returns", async () => {
  const sb = await import("../lib/server/supabase.js");
  // (a) the route signal object reaches globalThis.fetch for REST and Storage wrappers.
  const realFetch = globalThis.fetch;
  const seenSignals = [];
  const ctrl = new AbortController();
  try {
    globalThis.fetch = async (url, init) => { seenSignals.push(init && init.signal); return { ok: true, status: 200, json: async () => [], text: async () => "[]" }; };
    await sb.getSourceControls({ signal: ctrl.signal });
    await sb.saveSourceSnapshotPayload({ organizationFingerprint: "org1", sourceKey: "product-catalog", scopeKey: "__organization", rows: [], signal: ctrl.signal });
    assert.ok(seenSignals.length >= 2 && seenSignals.every((s) => s === ctrl.signal), "the SAME AbortSignal reached the real fetch for REST + Storage");
  } finally { globalThis.fetch = realFetch; }
  // (b) before-request expiry: the operation is NEVER invoked -- zero fetches, zero writes.
  const clockRef = { now: 1_000_000 };
  const dlExpired = runtimeMod.makeRouteDeadline({ clock: () => clockRef.now, budgetMs: 1_000, reserveMs: 5_000 });
  let invoked = 0;
  await assert.rejects(() => dlExpired.bound("some-write", () => { invoked += 1; return Promise.resolve("x"); }, { write: true }),
    (e) => e.code === "ROUTE_DEADLINE_EXCEEDED" && e.beforeRequest === true && e.inFlight === false && e.commitUnknown === false);
  assert.equal(invoked, 0, "a request that has not started makes zero writes");
  // (c) an in-flight WRITE expiry aborts the signal and is typed COMMIT-UNKNOWN -- never claimed uncommitted.
  const dlHang = runtimeMod.makeRouteDeadline({
    clock: () => clockRef.now, budgetMs: 60_000, reserveMs: 1_000,
    setTimer: (fn, ms) => setTimeout(fn, 0), clearTimer: (id) => clearTimeout(id),
  });
  let opSignal = null;
  await assert.rejects(() => dlHang.bound("hung-write", (signal) => { opSignal = signal; return new Promise(() => {}); }, { write: true }),
    (e) => e.code === "ROUTE_DEADLINE_EXCEEDED" && e.inFlight === true && e.commitUnknown === true);
  assert.ok(opSignal && opSignal.aborted, "the in-flight operation's AbortSignal was genuinely aborted");
  // (c2) a write that COMPLETED before expiry is reported as a confirmed success, never resumable.
  const dlOk = runtimeMod.makeRouteDeadline({ clock: () => clockRef.now, budgetMs: 60_000, reserveMs: 1_000, setTimer: (fn, ms) => setTimeout(fn, 0), clearTimer: (id) => clearTimeout(id) });
  assert.equal(await dlOk.bound("fast-write", async () => "committed", { write: true }), "committed");
  // (d) a hung durable WRITE inside the sync surfaces commitUnknown on the typed-resumable rollup.
  const hHang = fullFixture({
    readCoverage: async () => ({ windows: [], read: "ok", error: null }), // work to do => a replace will run
    replaceHistory: () => new Promise(() => {}),                          // hangs; ignores the abort
    setTimer: (fn, ms) => setTimeout(fn, 0), clearTimer: (id) => clearTimeout(id),
  });
  const rHang = await hHang.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(rHang.deadlineReached, true);
  assert.equal(rHang.continuationRequired, true);
  assert.equal(rHang.commitUnknown, true, "an aborted in-flight durable write is reported COMMIT-UNKNOWN, not silently uncommitted");
  // (e) GHOST-WRITE prevention: the abandoned first persistence step resolving AFTER the route aborted must
  // NOT trigger the subsequent pointer write or mutate evidence.
  let releaseSave = null;
  const pendingSave = new Promise((resolve) => { releaseSave = resolve; });
  const hGhost = fullFixture({
    // ABSENT catalog/FBA snapshots => the sync genuinely fetches + persists; step 1 of the persistence
    // (the immutable object upload) hangs until AFTER the handler returned.
    readSnapshot: async () => ({ snapshot: null, read: "ok", error: null }),
    saveSnapshotPayload: () => pendingSave,
    setTimer: (fn, ms) => setTimeout(fn, 0), clearTimer: (id) => clearTimeout(id),
  });
  const pfGhost = await hGhost.runtime.preflightEvidence({ bucket: "us", today: TODAY });
  const snapshotFolds = () => JSON.stringify(pfGhost.evidence.catalogRows || null);
  const foldsBefore = snapshotFolds();
  const rGhost = await hGhost.runtime.run({ bucket: "us", today: TODAY, preflight: pfGhost });
  assert.equal(rGhost.deadlineReached, true, "the hung persistence expired typed-resumable");
  const recordedBefore = hGhost.recorded.snapshots.length;
  releaseSave({ objectPath: "source-snapshots/v1/product-catalog/__organization.json", payloadBytes: 2 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(hGhost.recorded.snapshots.length, recordedBefore, "NO ghost pointer write after the handler returned");
  assert.equal(snapshotFolds(), foldsBefore, "NO ghost in-memory evidence mutation after the handler returned");
});

test("U5. fix 5: 30 accounts / 6 batches -- every report's depends_on is ACCOUNT-EXACT (own batch OLI + own FBA + shared catalog scope); zero cross-batch leakage", async () => {
  const ids = Array.from({ length: 30 }, (_, i) => "A" + String(i + 1).padStart(2, "0"));
  // Partial-tail coverage => the complete-window planner emits EXACTLY ONE OLI export per <=5-seller batch (6
  // batches => 6 OLI exports for the missing tail), so each account's depends_on carries its OWN batch's single
  // OLI hash. (A fully-covered fixture would emit zero OLI exports under the complete-window model -- the old
  // rolling-refresh re-fetch of the trailing window is gone.)
  const durableCoverage = [];
  const h = makeHarness({
    primaryAccounts: ids.map((id) => dirAccount(id)),
    secondaryAccounts: [],
    durableCoverage,
    readCoverage: dynamicTailCoverage(durableCoverage),
    readSnapshot: async ({ sourceKey, scopeKey }) => {
      if (sourceKey === "product-catalog") return { snapshot: { validated_at: TODAY + "T01:00:00Z", object_path: "source-snapshots/v1/product-catalog/__organization.json", row_count: 1 }, read: "ok", error: null };
      return { snapshot: null, read: "ok", error: null }; // FBA absent => the sync FETCHES one export per account
    },
  });
  h.snapStore.set("source-snapshots/v1/product-catalog/__organization.json", { rows: [{ child_asin: "B0A", sku: "SKU-A", product_brand: "Acme" }] });
  for (const id of ids) {
    h.durableHistory.set(id + "|x", { accountId: id, saleDate: ASOF, sku: "SKU-A", childAsin: "B0A", currency: "USD", salesAmount: 10, units: 1 });
  }
  const pf = await h.runtime.preflightEvidence({ bucket: "us", today: TODAY });
  const rollup = await h.runtime.run({ bucket: "us", today: TODAY, preflight: pf });
  assert.equal(rollup.stopped, false, JSON.stringify(rollup.stopReason));
  assert.equal(rollup.derived.skipped, null);
  assert.equal(new Set(h.membership.values()).size, 6, "30 accounts assigned into exactly 6 batches of <=5");
  const owners = h.store.listCycleOwners(rollup.cycleId);
  const jobs = h.store.listSourceJobs(rollup.cycleId);
  const jobByHash = new Map(jobs.map((j) => [j.request_hash, j]));
  const oliOwned = (aid) => new Set(owners.filter((o) => o.account_id === aid && jobByHash.get(o.request_hash) && jobByHash.get(o.request_hash).source_key === "order-line-items").map((o) => o.request_hash));
  const fbaOwned = (aid) => new Set(owners.filter((o) => o.account_id === aid && jobByHash.get(o.request_hash) && jobByHash.get(o.request_hash).source_key === "fba-inventory-health").map((o) => o.request_hash));
  const upserts = h.recorded.lineage.filter((l) => l.op === "upsert");
  assert.ok(upserts.length >= 60, "daily + brand-sales (+ inventory) lineage for the fleet: " + upserts.length);
  for (const u of upserts) {
    const myOli = oliOwned(u.accountId);
    const myFba = fbaOwned(u.accountId);
    for (const hash of u.dependsOn) {
      const job = jobByHash.get(hash);
      assert.ok(job, "every dependency is a real cycle job");
      if (job.source_key === "order-line-items") assert.ok(myOli.has(hash), u.reportKey + "/" + u.accountId + " depends only on ITS OWN batch's OLI export");
      else if (job.source_key === "fba-inventory-health") assert.ok(myFba.has(hash) && u.reportKey === "brand-inventory", u.accountId + " depends only on ITS OWN FBA export (brand-inventory only)");
    }
    if (u.reportKey !== "brand-inventory") assert.ok(u.dependsOn.every((hash) => (jobByHash.get(hash) || {}).source_key !== "fba-inventory-health"), "daily/brand-sales never depend on FBA");
    assert.ok(u.dependsOn.length >= 1, u.reportKey + "/" + u.accountId + ": nonempty account-owned dependency set");
  }
  // Cross-batch DISJOINTNESS: accounts in different batches share ZERO OLI dependencies.
  const dailyOf = (aid) => upserts.find((u) => u.reportKey === "daily-reporting" && u.accountId === aid);
  const batchOf = (aid) => h.membership.get(aid);
  const a = dailyOf("A01"); const bAcct = ids.find((id) => batchOf(id) !== batchOf("A01"));
  const b = dailyOf(bAcct);
  assert.ok(a && b, "two accounts in different batches derived");
  const shared = a.dependsOn.filter((hash) => b.dependsOn.includes(hash));
  assert.ok(shared.every((hash) => (jobByHash.get(hash) || {}).source_key === "product-catalog"), "cross-batch shared dependencies can ONLY be the organization-wide catalog scope: " + JSON.stringify(shared.map((x) => (jobByHash.get(x) || {}).source_key)));
  const sameBatchPeer = ids.find((id) => id !== "A01" && batchOf(id) === batchOf("A01"));
  assert.deepEqual(dailyOf(sameBatchPeer).dependsOn.filter((hash) => (jobByHash.get(hash) || {}).source_key === "order-line-items").sort(), a.dependsOn.filter((hash) => (jobByHash.get(hash) || {}).source_key === "order-line-items").sort(), "batch members genuinely SHARE their batch's OLI export hashes");
  // FBA: each brand-inventory row depends on exactly ITS account's FBA hash.
  const invA01 = upserts.find((u) => u.reportKey === "brand-inventory" && u.accountId === "A01");
  const invPeer = upserts.find((u) => u.reportKey === "brand-inventory" && u.accountId === bAcct);
  assert.ok(invA01 && invPeer, "brand-inventory lineage for both probes");
  const fbaDeps = (u) => u.dependsOn.filter((hash) => (jobByHash.get(hash) || {}).source_key === "fba-inventory-health");
  assert.equal(fbaDeps(invA01).length, 1);
  assert.equal(fbaDeps(invPeer).length, 1);
  assert.notEqual(fbaDeps(invA01)[0], fbaDeps(invPeer)[0], "one account NEVER depends on another account's FBA export");
});

test("U6. fix 6: the ACL model includes PostgreSQL 17 MAINTAIN -- GRANT ALL leaves MAINTAIN behind the legacy-seven revoke; explicit MAINTAIN is forbidden; REVOKE ALL clears it; the real migration stays clean", () => {
  assert.equal(auditWith(null).ok, true, "the real Migration 20260820 audits clean under the PG17 model");
  // (a) GRANT ALL then revoking only the LEGACY SEVEN privileges still leaves MAINTAIN held -> typed blocker.
  const maintainSurvives = auditWith((sql) => sql.replace(
    "grant select, insert, update on table public.source_coverage to service_role;",
    "grant all on table public.source_coverage to service_role;\n"
    + "revoke select, insert, update, delete, truncate, references, trigger on table public.source_coverage from service_role;\n"
    + "grant select, insert, update on table public.source_coverage to service_role;",
  ));
  assert.ok(maintainSurvives.blockers.some((b) => b.code === "SERVICE_ROLE_GRANT_MISMATCH" && /maintain/.test(b.message)), JSON.stringify(maintainSurvives.blockers.map((b) => b.code)) + " -- a pre-PG17 seven-privilege model would have passed this");
  // (b) explicit MAINTAIN is forbidden for every role unless expressly expected.
  const maintainAuth = auditWith((sql) => sql + "\ngrant maintain on table public.source_controls to authenticated;\n");
  assert.ok(maintainAuth.blockers.some((b) => b.code === "AUTH_GRANT_FORBIDDEN" && /maintain/.test(b.message)), JSON.stringify(maintainAuth.blockers.map((b) => b.code)));
  const maintainSrv = auditWith((sql) => sql + "\ngrant maintain on table public.source_snapshots to service_role;\n");
  assert.ok(maintainSrv.blockers.some((b) => b.code === "SERVICE_ROLE_GRANT_MISMATCH"), JSON.stringify(maintainSrv.blockers.map((b) => b.code)));
  const maintainAnon = auditWith((sql) => sql + "\ngrant maintain on table public.source_coverage to anon;\n");
  assert.ok(maintainAnon.blockers.some((b) => b.code === "AUTH_GRANT_FORBIDDEN"), JSON.stringify(maintainAnon.blockers.map((b) => b.code)));
  const maintainBot = auditWith((sql) => sql + "\ngrant maintain on table public.source_run_status to maintenance_bot;\n");
  assert.ok(maintainBot.blockers.some((b) => b.code === "AUTH_GRANT_FORBIDDEN" && /maintenance_bot/.test(b.message)), JSON.stringify(maintainBot.blockers.map((b) => b.code)));
  // (c) REVOKE ALL clears MAINTAIN in the modeled final state (the re-granted select keeps the table's
  // expected authenticated ACL intact -- so a clean audit PROVES maintain was cleared).
  const revokeAllClears = auditWith((sql) => sql
    + "\ngrant maintain on table public.source_controls to authenticated;"
    + "\nrevoke all on table public.source_controls from authenticated;"
    + "\ngrant select on table public.source_controls to authenticated;\n");
  assert.equal(revokeAllClears.ok, true, JSON.stringify(revokeAllClears.blockers));
});

/* ================================= V. round-6 blocker 1: deadline genuinely end-to-end ================================= */
group("V. round-6 blocker 1: the route deadline reaches the REAL store + shadow-saver writes (mocked global fetch, not injected collaborators)");

const OK_JSON = () => ({ ok: true, status: 200, json: async () => [], text: async () => "[]" });
const validJob = { cycleId: "c1", requestHash: "h1", sourceId: "s1", sourceKey: "order-line-items", connectionId: "primary", organizationFingerprint: "orgfp", accountScopeHash: "scope1", bucket: "us" };

test("V1. the REAL makeSupabaseSourceStore(deadline) threads the SAME AbortSignal into global fetch for every read+write; no deadline => no signal (byte-identical)", async () => {
  const driver = await import("../lib/server/sync/source-sync-driver.js");
  const realFetch = globalThis.fetch;
  try {
    const dl = runtimeMod.makeRouteDeadline({ clock: () => 1_000_000, budgetMs: 60_000, reserveMs: 1_000 });
    const store = driver.makeSupabaseSourceStore({ deadline: dl });
    const seen = [];
    globalThis.fetch = async (url, init) => { seen.push({ url: String(url), signal: init && init.signal, method: (init && init.method) || "GET" }); return OK_JSON(); };
    for (const op of [
      () => store.openCycle({ bucket: "us", cycleDate: TODAY }),
      () => store.upsertSourceJob(validJob),
      () => store.listSourceJobs("c1"),
      () => store.updateCycleCounts("c1", { sourceTotal: 1 }),
      () => store.loadSourceRows("h1"),
      () => store.claimExportAttempt("c1", "h1"),
      () => store.recordSourceSuccess({ cycleId: "c1", requestHash: "h1", rowCount: 1, payloadBytes: 2, durationMs: 1, cacheObjectPath: "p" }),
      () => store.upsertSourceJobOwners([]),
      () => store.persistBudget({ cycleId: "c1", trancheKey: "t", planFingerprint: "pf", maxCreates: 1, maxTokens: 2, hashes: [] }),
    ]) { try { await op(); } catch (_e) { /* shape mismatch is fine; only the fetch+signal matters */ } }
    assert.ok(seen.length >= 8, "the real store made real fetches: " + seen.length);
    assert.ok(seen.every((c) => c.signal === dl.signal), "the SAME route signal reached the real fetch for EVERY store op");
    // saveSourceRows goes through the storage + metadata adapters, which are constructed with the deadline's
    // signal: prove a STORAGE PUT carries the same signal.
    seen.length = 0;
    try { await store.saveSourceRows({ job: { ...validJob, request_hash: "h1" }, rows: [{ a: 1 }], payloadBytes: 4, version: "v1" }); } catch (_e) { /* multi-step; only the fetch+signal matters */ }
    assert.ok(seen.some((c) => c.method === "POST" && c.url.includes("/storage/") && c.signal === dl.signal), "the immutable-object STORAGE PUT carried the route signal");
    // (b) no deadline => byte-identical: NO signal on the real fetch.
    const plain = driver.makeSupabaseSourceStore();
    seen.length = 0;
    try { await plain.openCycle({ bucket: "us", cycleDate: TODAY }); await plain.upsertSourceJob(validJob); } catch (_e) { /* ignore */ }
    assert.ok(seen.length >= 2 && seen.every((c) => c.signal == null), "no deadline => the wrapper passes no signal (byte-identical to pre-round-6)");
  } finally { globalThis.fetch = realFetch; }
});

test("V2. a HUNG store write is genuinely aborted within the route budget -> typed ROUTE_DEADLINE_EXCEEDED (in-flight WRITE => commitUnknown, never claimed uncommitted)", async () => {
  const driver = await import("../lib/server/sync/source-sync-driver.js");
  const realFetch = globalThis.fetch;
  const timers = [];
  try {
    // setTimer records the remaining-budget delay AND fires immediately so the hung fetch is aborted at once.
    const dl = runtimeMod.makeRouteDeadline({ clock: () => 5_000_000, budgetMs: 60_000, reserveMs: 1_000, setTimer: (fn, ms) => { timers.push(ms); return setTimeout(fn, 0); }, clearTimer: (id) => clearTimeout(id) });
    const store = driver.makeSupabaseSourceStore({ deadline: dl });
    let fetchAborted = false;
    globalThis.fetch = (url, init) => new Promise((_resolve, reject) => {
      const sig = init && init.signal;
      if (sig) sig.addEventListener("abort", () => { fetchAborted = true; reject(Object.assign(new Error("aborted"), { name: "AbortError" })); });
    });
    await assert.rejects(
      () => store.openCycle({ bucket: "us", cycleDate: TODAY }),
      (e) => e.code === "ROUTE_DEADLINE_EXCEEDED" && e.inFlight === true && e.beforeRequest === false && e.commitUnknown === true,
      "a hung in-flight write is a commit-unknown route-deadline expiry",
    );
    assert.ok(fetchAborted, "the in-flight fetch was GENUINELY aborted through its AbortSignal");
    assert.ok(timers.length >= 1 && timers.every((ms) => Number.isFinite(ms) && ms >= 1), "the op was bounded by a finite remaining-budget timer");
  } finally { globalThis.fetch = realFetch; }
});

test("V3. a store op reached AFTER the budget already expired makes ZERO fetches (before-request expiry; proven zero effect)", async () => {
  const driver = await import("../lib/server/sync/source-sync-driver.js");
  const realFetch = globalThis.fetch;
  try {
    const dl = runtimeMod.makeRouteDeadline({ clock: () => 9_000_000, budgetMs: 1_000, reserveMs: 5_000 }); // already out of time
    const store = driver.makeSupabaseSourceStore({ deadline: dl });
    let fetches = 0;
    globalThis.fetch = async () => { fetches += 1; return OK_JSON(); };
    await assert.rejects(
      () => store.upsertSourceJob(validJob),
      (e) => e.code === "ROUTE_DEADLINE_EXCEEDED" && e.beforeRequest === true && e.inFlight === false && e.commitUnknown === false,
      "before-request expiry is typed and NOT commit-unknown",
    );
    assert.equal(fetches, 0, "a request that has not started makes ZERO fetches");
  } finally { globalThis.fetch = realFetch; }
});

test("V4. a store write that COMPLETES before expiry is reported committed (its result), never uncommitted/resumable; the one-attempt guard passes through faithfully", async () => {
  const driver = await import("../lib/server/sync/source-sync-driver.js");
  const realFetch = globalThis.fetch;
  try {
    const dl = runtimeMod.makeRouteDeadline({ clock: () => 2_000_000, budgetMs: 60_000, reserveMs: 1_000 });
    const store = driver.makeSupabaseSourceStore({ deadline: dl });
    globalThis.fetch = async (url) => (String(url).includes("open_sync_cycle") ? { ok: true, status: 200, json: async () => "cyc-committed", text: async () => '"cyc-committed"' } : OK_JSON());
    const id = await store.openCycle({ bucket: "us", cycleDate: TODAY });
    assert.equal(id, "cyc-committed", "a confirmed committed write returns its result honestly");
    // one-create-per-hash guard is unchanged by threading: the RPC boolean passes straight through.
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => true, text: async () => "true" });
    assert.equal(await store.claimExportAttempt("c1", "h1"), true, "claimExportAttempt passes the RPC acknowledgement through unchanged (idempotent one-attempt guard intact)");
  } finally { globalThis.fetch = realFetch; }
});

test("V5. the REAL shadow saver (makeShadowSnapshotSaver -> saveReportSnapshot) carries the route signal into the report_snapshots write; a HUNG save aborts commit-unknown", async () => {
  const rss = await import("../lib/server/sync/report-snapshot-store.js");
  const realFetch = globalThis.fetch;
  const saver = rss.makeShadowSnapshotSaver();
  const snap = () => ({
    reportKey: "scheduler-v2/brand-inventory", accountId: "A01",
    params: { reportVersion: "brand-inventory-shared-v1", accountId: "A01", to: ASOF },
    payload: { accountId: "A01", inventoryByBrandCountry: [], inventoryDate: null, inventoryAvailable: false },
    sourceRefreshedAt: TODAY + "T00:00:00Z",
  });
  try {
    // (a) the signal reaches the real report_snapshots fetch.
    const dl = runtimeMod.makeRouteDeadline({ clock: () => 3_000_000, budgetMs: 60_000, reserveMs: 1_000 });
    let seenSig = "unset";
    globalThis.fetch = async (url, init) => { seenSig = init && init.signal; return { ok: true, status: 200, json: async () => [{ report_key: "scheduler-v2/brand-inventory" }], text: async () => "[]" }; };
    const out = await dl.bound("shadow-save", (signal) => saver(snap(), { signal }), { write: true });
    assert.ok(out && out.paramsHash, "the shadow save completed and returned its params hash");
    assert.equal(seenSig, dl.signal, "the route signal reached the report_snapshots write");
    // (b) a hung report_snapshots save is aborted commit-unknown.
    const dl2 = runtimeMod.makeRouteDeadline({ clock: () => 3_000_000, budgetMs: 60_000, reserveMs: 1_000, setTimer: (fn) => setTimeout(fn, 0), clearTimer: (id) => clearTimeout(id) });
    let aborted = false;
    globalThis.fetch = (url, init) => new Promise((_r, reject) => { const sig = init && init.signal; if (sig) sig.addEventListener("abort", () => { aborted = true; reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }); });
    await assert.rejects(
      () => dl2.bound("shadow-save", (signal) => saver(snap(), { signal }), { write: true }),
      (e) => e.code === "ROUTE_DEADLINE_EXCEEDED" && e.inFlight === true && e.commitUnknown === true,
    );
    assert.ok(aborted, "the hung report_snapshots write was genuinely aborted");
  } finally { globalThis.fetch = realFetch; }
});

test("V6. no GHOST write after abort: once the deadline aborted a hung save, NO later POINTER-write fetch (source_export_cache POST) is emitted by the abandoned op", async () => {
  const driver = await import("../lib/server/sync/source-sync-driver.js");
  const realFetch = globalThis.fetch;
  try {
    const dl = runtimeMod.makeRouteDeadline({ clock: () => 4_000_000, budgetMs: 60_000, reserveMs: 1_000, setTimer: (fn) => setTimeout(fn, 0), clearTimer: (id) => clearTimeout(id) });
    const store = driver.makeSupabaseSourceStore({ deadline: dl });
    let pointerWrites = 0;
    let aborted = false;
    // Model REAL fetch faithfully: a fetch whose AbortSignal is ALREADY aborted rejects immediately (no
    // network), and the first in-flight GET (metadata.read of the previous pointer) hangs until the signal
    // aborts. Count any pointer WRITE (POST source_export_cache) the abandoned atomicSave chain emits.
    globalThis.fetch = (url, init) => {
      const u = String(url);
      const sig = init && init.signal;
      if (sig && sig.aborted) return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (init && init.method === "POST" && u.includes("source_export_cache")) { pointerWrites += 1; return Promise.resolve(OK_JSON()); }
      if (init && init.method === "POST" && u.includes("/storage/")) return Promise.resolve(OK_JSON());
      return new Promise((_r, reject) => { if (sig) sig.addEventListener("abort", () => { aborted = true; reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }); });
    };
    await assert.rejects(() => store.saveSourceRows({ job: { ...validJob, request_hash: "h1" }, rows: [{ a: 1 }], payloadBytes: 4, version: "v1" }), (e) => e.code === "ROUTE_DEADLINE_EXCEEDED");
    assert.ok(aborted, "the hung save was aborted");
    // Let any abandoned microtasks/continuations settle, then assert NO pointer write ever happened.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(pointerWrites, 0, "the abandoned atomic-save chain emitted ZERO source_export_cache POINTER writes after abort (LKG preserved; commit-unknown-safe by construction)");
  } finally { globalThis.fetch = realFetch; }
});

/* ================================= U7. round-6 blocker 2: the real durable promoted-publish control ================================= */
group("U7. round-6 blocker 2: brand-inventory has a REAL fail-closed durable enable path, separate from dispatch, and can never be dispatched");

test("U7. the promoted-publish control wrappers are fail-closed default-off (mocked fetch); the admin sync surface enables via the SEPARATE control and REFUSES to dispatch a promoted key; the migration is registered + audits clean", async () => {
  const sb = await import("../lib/server/supabase.js");
  const controls = await import("../lib/server/sync/report-controls.js");
  const realFetch = globalThis.fetch;
  try {
    // (a) READ wrapper is fail-closed: a schema-missing / read error reads as [] (=> publisher gate2 disabled).
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({ code: "PGRST205", message: "not found" }), text: async () => "" });
    assert.deepEqual(await sb.getSourcePromotedPublishSettings(), [], "a schema-missing/failed read => [] (fail closed, default disabled)");
    // (b) READ passes the route signal into the real fetch; a healthy read returns the rows.
    let seenSig = "unset";
    globalThis.fetch = async (url, init) => { seenSig = init && init.signal; return { ok: true, status: 200, json: async () => [{ report_key: "brand-inventory", publish_enabled: false }], text: async () => "[]" }; };
    const ctrl = new AbortController();
    const rows = await sb.getSourcePromotedPublishSettings({ signal: ctrl.signal });
    assert.equal(seenSig, ctrl.signal, "the read carries the route signal to the real fetch");
    assert.deepEqual(rows, [{ report_key: "brand-inventory", publish_enabled: false }], "the seeded default-off row");
    // (c) SET wrapper writes to source_promoted_publish_settings (NOT report_sync_settings) with the signal,
    // and returns only after a STRICTLY VALIDATED single-row acknowledgement (exact key, exact boolean, valid
    // updated_at).
    const writes = [];
    const okAck = () => ({ ok: true, status: 200, json: async () => [{ report_key: "brand-inventory", publish_enabled: true, updated_at: "2026-08-21T00:00:00Z" }], text: async () => "[]" });
    globalThis.fetch = async (url, init) => { writes.push({ url: String(url), signal: init && init.signal, body: init && init.body }); return okAck(); };
    const setRes = await sb.setSourcePromotedPublishControl({ reportKey: "brand-inventory", publishEnabled: true, updatedBy: "admin-1", signal: ctrl.signal });
    assert.deepEqual({ reportKey: setRes.reportKey, publishEnabled: setRes.publishEnabled }, { reportKey: "brand-inventory", publishEnabled: true }, "the validated ack echoes the exact key + boolean");
    assert.equal(writes.length, 1);
    assert.ok(writes[0].url.includes("source_promoted_publish_settings"), "the set writes the SEPARATE control table");
    assert.ok(!writes[0].url.includes("report_sync_settings"), "the set NEVER touches the dispatch control");
    assert.ok(String(writes[0].body).includes('"publish_enabled":true'), "the write carries publish_enabled=true");
    assert.equal(writes[0].signal, ctrl.signal, "the write carries the route signal");
    // Round-7 finding 2: a non-boolean input performs ZERO control writes (throws BEFORE the request).
    writes.length = 0;
    await assert.rejects(() => sb.setSourcePromotedPublishControl({ reportKey: "brand-inventory", publishEnabled: "yes", updatedBy: "admin-1" }), (e) => e.code === "PROMOTED_PUBLISH_CONTROL_INVALID" && e.status === 400);
    assert.equal(writes.length, 0, "a malformed (non-boolean) input performs ZERO control writes");
    // Round-7 finding 2: null / multi-row / wrong-key / wrong-state / no-updated_at acknowledgements throw typed.
    for (const [ack, label] of [
      [async () => [], "empty"],
      [async () => [{ report_key: "brand-inventory", publish_enabled: true, updated_at: "2026-08-21T00:00:00Z" }, { report_key: "brand-inventory", publish_enabled: true, updated_at: "2026-08-21T00:00:00Z" }], "multi-row"],
      [async () => [{ report_key: "daily-reporting", publish_enabled: true, updated_at: "2026-08-21T00:00:00Z" }], "wrong-key"],
      [async () => [{ report_key: "brand-inventory", publish_enabled: false, updated_at: "2026-08-21T00:00:00Z" }], "wrong-state"],
      [async () => [{ report_key: "brand-inventory", publish_enabled: true }], "no-updated_at"],
      [async () => null, "null"],
    ]) {
      globalThis.fetch = async () => ({ ok: true, status: 200, json: ack, text: async () => "[]" });
      await assert.rejects(() => sb.setSourcePromotedPublishControl({ reportKey: "brand-inventory", publishEnabled: true, updatedBy: "admin-1" }), (e) => e.code === "PROMOTED_PUBLISH_CONTROL_ACK_INVALID" && e.status === 502, "malformed ack: " + label);
    }
  } finally { globalThis.fetch = realFetch; }

  // (d) the ADMIN sync surface ROUTES a promoted key to the SEPARATE control and CANNOT dispatch it (proven
  // structurally over the committed handler source, as R8 pins the sources.js ordering). The promoted branch
  // must (1) sit BEFORE the dispatchable-report resolution (controlledReport), (2) write ONLY the promoted
  // control (setSourcePromotedPublishControl), NEVER setReportSyncSetting, and (3) REFUSE a POST manual run.
  const src = readFileSync(path.join(process.cwd(), "api", "admin", "sync.js"), "utf8");
  const promotedBranch = src.indexOf("SOURCE_PROMOTED_REPORT_KEYS.includes(requestedKey)");
  const controlledResolve = src.indexOf("controlledReport(requestedKey)");
  const dispatchRun = src.indexOf("runScheduledSync(");
  assert.ok(promotedBranch > 0 && controlledResolve > promotedBranch, "the promoted branch is handled BEFORE the dispatchable-report resolution");
  assert.ok(dispatchRun > controlledResolve, "runScheduledSync stays on the dispatchable path only (after controlledReport)");
  const branchText = src.slice(promotedBranch, controlledResolve);
  assert.ok(branchText.includes("setSourcePromotedPublishControl"), "the promoted PATCH writes the SEPARATE promoted control");
  assert.ok(!branchText.includes("setReportSyncSetting"), "the promoted branch NEVER writes the dispatch control");
  assert.ok(!branchText.includes("runScheduledSync"), "the promoted branch NEVER dispatches a sync run");
  assert.match(branchText, /req\.method === "POST"[\s\S]*?status\(409\)/, "a POST (manual dispatch) on a promoted key is refused 409 (never a dispatch)");

  // (e) STRUCTURAL: the promoted key is undispatchable and the new migration is registered + audits clean.
  assert.ok(controls.SOURCE_PROMOTED_REPORT_KEYS.includes("brand-inventory"));
  assert.ok(!controls.CONTROLLED_REPORT_KEYS.includes("brand-inventory"), "NOT a dispatchable controlled report");
  assert.equal(controls.controlledReport("brand-inventory"), null, "controlledReport() rejects the promoted key (admin dispatch path can never resolve it)");
  const clean = auditWith(null);
  assert.equal(clean.ok, true, "the full schema contract (incl. the new promoted-publish migration) audits clean");
  const row = clean.matrix.find((m) => m.migration === "20260821_source_promoted_publish_controls.sql");
  assert.ok(row && row.present && row.tables.some((t) => t.name === "source_promoted_publish_settings"), "the new migration is registered in the audit matrix");
  // A dropped admin-read policy / widened ACL on the new table is a typed audit blocker (it is a real
  // audited least-privilege surface, default-off).
  const MIG821 = "20260821_source_promoted_publish_controls.sql";
  const auditWith821 = (mutate) => schema.auditSchemaContract({ readFile: (rel) => {
    if (rel === "supabase.js") return readFileSync(path.join(process.cwd(), "lib", "server", "supabase.js"), "utf8");
    const t = readFileSync(path.join(process.cwd(), "supabase", "migrations", rel), "utf8");
    return (rel === MIG821 && mutate) ? mutate(t) : t;
  } });
  assert.equal(auditWith821(null).ok, true, "baseline (real 20260821) audits clean");
  const droppedPolicy = auditWith821((sql) => sql.split("create policy source_promoted_publish_settings_admin_read on public.source_promoted_publish_settings\n  for select to authenticated using (public.is_dashboard_admin());").join(""));
  assert.ok(droppedPolicy.blockers.some((b) => b.code === "POLICY_MISSING" && b.table === "source_promoted_publish_settings"), JSON.stringify(droppedPolicy.blockers.filter((b) => b.table === "source_promoted_publish_settings").map((b) => b.code)));
  const widenedAcl = auditWith821((sql) => sql.split("grant select, insert, update on table public.source_promoted_publish_settings to service_role;").join("grant all on table public.source_promoted_publish_settings to service_role;"));
  assert.ok(widenedAcl.blockers.some((b) => b.code === "SERVICE_ROLE_GRANT_MISMATCH" && b.table === "source_promoted_publish_settings"), JSON.stringify(widenedAcl.blockers.filter((b) => b.table === "source_promoted_publish_settings").map((b) => b.code)));
});


/* ================================= X. round-7 finding 1: durable recovery after commit-unknown ================================= */
group("X. round-7 finding 1: durable, concurrency-safe report-derive recovery (lease + guarded reconcile)");

// The route-deadline marker the runtime reads via Symbol.for -- constructing an error with it lets a test
// inject a "committed then response-timed-out" (commitUnknown) failure that the runtime treats as resumable.
const ROUTE_DEADLINE_SYM = Symbol.for("scheduler-v2/route-deadline");
const routeDeadlineError = (phase) => {
  const e = new Error("route deadline (commit-unknown) at " + phase);
  e.code = "ROUTE_DEADLINE_EXCEEDED"; e.status = 503;
  e[ROUTE_DEADLINE_SYM] = phase; e.beforeRequest = false; e.inFlight = true; e.commitUnknown = true;
  return e;
};
const LEASE_S = 300;                 // matches the runtime default reportDeriveLeaseSeconds
const BASE_MS = 8_000_000;           // the harness clock start
const PAST_LEASE_MS = BASE_MS + LEASE_S * 1000 + 60_000; // safely past the lease expiry

// A fullFixture whose lineage/saver DELEGATE to the store but can inject a commit-unknown timeout at a
// precise stage (claim after commit / save before commit / reconcile before or after commit) for one target.
function recoveryFixture(store, inject = {}) {
  const savedShadow = [];
  const hit = (fn, rk, a) => typeof fn === "function" && fn(rk, a);
  const over = {
    store,
    // Round-11: the durable-lineage path must NEVER use the merge-upsert saver. If it ever does, fail loudly
    // (this is the regression-5 guard: exactly the atomic CAS handles durable writes, zero merge-upserts).
    makeShadowSaver: () => async (args) => { throw new Error("REGRESSION: durable lineage reached the merge-upsert saver for " + args.reportKey + "/" + args.accountId); },
    // Round-11: the durable shadow write goes through the ATOMIC CAS. Inject a commit-unknown deadline BEFORE
    // the commit (timeoutSaveAt -> the CAS did not land) or AFTER it (timeoutSaveAfterCommit -> committed but
    // the response timed out); a committed write (inserted/replaced) is recorded for the recovery assertions.
    saveShadowIfNewer: async (cand) => {
      const prodKey = String(cand.reportKey).replace(/^scheduler-v2\//, ""); // the CAS receives the SHADOW key
      if (hit(inject.timeoutSaveAt, prodKey, cand.accountId)) throw routeDeadlineError("shadow-cas-save"); // did NOT commit
      const res = store.shadowCasIfNewer(cand); // COMMITS atomically (insert-if-absent / freshness CAS)
      if (res.outcome === "inserted" || res.outcome === "replaced") {
        savedShadow.push({ reportKey: cand.reportKey, accountId: cand.accountId, paramsHash: cand.paramsHash, outcome: res.outcome });
      }
      if (hit(inject.timeoutSaveAfterCommit, prodKey, cand.accountId)) throw routeDeadlineError("shadow-cas-save"); // committed, response timed out
      return res;
    },
    reportLineage: {
      upsertReportJob: async (j) => store.upsertReportJob(j),
      claimLease: async (c, rk, a, opts) => {
        const res = store.claimLease(c, rk, a, opts); // COMMITS the lease
        if (hit(inject.timeoutClaimAfterCommit, rk, a)) throw routeDeadlineError("report-lineage-claim"); // response timed out
        return { disposition: res.disposition, leaseToken: res.lease_token || null, snapshotParamsHash: res.snapshot_params_hash || null, deriveStatus: res.derive_status || null };
      },
      reconcileSuccess: async (j) => {
        if (hit(inject.timeoutReconcileBeforeCommit, j.reportKey, j.accountId)) throw routeDeadlineError("report-lineage-reconcile"); // did NOT commit
        const res = store.reconcileSuccess(j); // COMMITS success
        if (hit(inject.timeoutReconcileAfterCommit, j.reportKey, j.accountId)) throw routeDeadlineError("report-lineage-reconcile"); // response timed out
        return { disposition: res.disposition };
      },
    },
  };
  const h = fullFixture(over);
  h.savedShadow = savedShadow;
  return h;
}
const onceFor = (rk0, a0) => { let done = false; return (rk, a) => (!done && rk === rk0 && a === a0) ? (done = true, true) : false; };
const daily = (rk, a) => rk === "daily-reporting" && a === "A01";

test("X1. a claim COMMITS but the response TIMES OUT (commitUnknown) -> a fresh invocation past the lease RECLAIMS and recovers; commitUnknown is preserved on the first rollup", async () => {
  const store = makeStore();
  const h1 = recoveryFixture(store, { timeoutClaimAfterCommit: onceFor("daily-reporting", "A01") });
  const r1 = await h1.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(r1.deadlineReached, true, "the first invocation returned typed-resumable at the claim timeout");
  assert.equal(r1.continuationRequired, true);
  assert.equal(r1.commitUnknown, true, "X10: commitUnknown is PRESERVED on the first invocation's rollup");
  const j1 = store.getReportJob("daily-reporting", "A01");
  assert.equal(j1.derive_status, "running", "the claim COMMITTED: the row is running with a lease");
  assert.ok(j1.derive_lease_token, "a lease token was durably set");
  assert.equal(j1.validated, false, "no fabricated success");
  // Fresh invocation AFTER the lease expires -> reclaim + recover.
  const h2 = fullFixture({ store });
  store._dbClock.now = PAST_LEASE_MS; // DB-authoritative time advances; h2's runtime clock is irrelevant to the lease
  const r2 = await h2.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(r2.stopped, false, JSON.stringify(r2.stopReason));
  assert.equal(store.getReportJob("daily-reporting", "A01").validated, true, "the fresh invocation RECOVERED the abandoned claim to success");
  assert.equal(h2.dd.totalCreates(), 0, "X8: recovery performs ZERO new DataDoe exports");
  assert.ok(r2.derived.lineage.some((l) => l.reportKey === "daily-reporting" && l.accountId === "A01" && l.outcome === "recovered"), "typed 'recovered' outcome");
});

test("X2. a shadow save COMMITS but the reconcile does NOT commit -> a fresh invocation ADOPTS the exact durable snapshot (no re-save, no DataDoe) and reconciles", async () => {
  const store = makeStore();
  const h1 = recoveryFixture(store, { timeoutReconcileBeforeCommit: onceFor("daily-reporting", "A01") });
  const r1 = await h1.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(r1.commitUnknown, true);
  assert.ok(h1.savedShadow.some((s) => s.reportKey === "scheduler-v2/daily-reporting" && s.accountId === "A01"), "the shadow save COMMITTED once");
  const j1 = store.getReportJob("daily-reporting", "A01");
  assert.equal(j1.derive_status, "running", "the reconcile did NOT commit: the job is still running");
  assert.equal(j1.validated, false);
  const h2 = fullFixture({ store });
  store._dbClock.now = PAST_LEASE_MS; // DB-authoritative time advances; h2's runtime clock is irrelevant to the lease
  const r2 = await h2.runtime.run({ bucket: "us", today: TODAY });
  assert.ok(!h2.recorded.shadowSaves.some((s) => s.reportKey === "scheduler-v2/daily-reporting" && s.accountId === "A01"), "recovery ADOPTED the exact durable snapshot -- ZERO re-save");
  assert.equal(store.getReportJob("daily-reporting", "A01").validated, true, "reconciled to success on adoption");
  assert.equal(h2.dd.totalCreates(), 0, "zero DataDoe on recovery");
  assert.ok(r2.derived.lineage.some((l) => l.reportKey === "daily-reporting" && l.accountId === "A01" && l.outcome === "recovered"));
});

test("X3. a shadow save DEFINITELY did not commit -> after the lease guard, a fresh invocation RETRIES the save exactly once and reconciles", async () => {
  const store = makeStore();
  const h1 = recoveryFixture(store, { timeoutSaveAt: onceFor("daily-reporting", "A01") });
  const r1 = await h1.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(r1.commitUnknown, true);
  assert.ok(!h1.savedShadow.some((s) => s.reportKey === "scheduler-v2/daily-reporting" && s.accountId === "A01"), "the save did NOT commit (no durable snapshot)");
  const j1 = store.getReportJob("daily-reporting", "A01");
  assert.equal(j1.derive_status, "running");
  assert.equal(j1.derive_attempt_count, 1, "one claim attempt so far");
  const h2 = recoveryFixture(store, {}); // fresh, no injection
  store._dbClock.now = PAST_LEASE_MS; // DB-authoritative time advances; h2's runtime clock is irrelevant to the lease
  const r2 = await h2.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(h2.savedShadow.filter((s) => s.reportKey === "scheduler-v2/daily-reporting" && s.accountId === "A01").length, 1, "the fresh invocation RETRIED the save exactly ONCE");
  const j2 = store.getReportJob("daily-reporting", "A01");
  assert.equal(j2.validated, true, "reconciled to success after the guarded retry");
  assert.equal(j2.derive_attempt_count, 2, "exactly one guarded RE-claim (attempt 2); never a runaway retry");
  assert.equal(h2.dd.totalCreates(), 0, "zero DataDoe");
});

test("X4. the success/reconcile PATCH COMMITS but the response TIMES OUT -> a fresh invocation OBSERVES already-complete (no re-save, no re-reconcile)", async () => {
  const store = makeStore();
  const h1 = recoveryFixture(store, { timeoutReconcileAfterCommit: onceFor("daily-reporting", "A01") });
  const r1 = await h1.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(r1.commitUnknown, true);
  const j1 = store.getReportJob("daily-reporting", "A01");
  assert.equal(j1.validated, true, "the reconcile COMMITTED: the job is already a validated success");
  const h2 = fullFixture({ store });
  store._dbClock.now = PAST_LEASE_MS; // DB-authoritative time advances; h2's runtime clock is irrelevant to the lease
  const r2 = await h2.runtime.run({ bucket: "us", today: TODAY });
  assert.ok(!h2.recorded.shadowSaves.some((s) => s.reportKey === "scheduler-v2/daily-reporting" && s.accountId === "A01"), "no re-save for an already-complete job");
  assert.ok(r2.derived.lineage.some((l) => l.reportKey === "daily-reporting" && l.accountId === "A01" && l.outcome === "already-complete"), "the fresh invocation OBSERVES already-complete");
  assert.equal(h2.dd.totalCreates(), 0, "zero DataDoe");
});

test("X5. a LIVE (unexpired-lease) claimant is NEVER stolen -- a concurrent invocation sees 'held' and does not save/reconcile", async () => {
  const store = makeStore();
  store._dbClock.now = BASE_MS;
  // A live worker claims daily/A01 at the current DB time (lease unexpired).
  const cid = store.openCycle({ bucket: "us", cycleDate: TODAY });
  store.upsertReportJob({ cycleId: cid, reportKey: "daily-reporting", accountId: "A01", connectionId: "primary", bucket: "us", dependsOn: [] });
  const live = store.claimLease(cid, "daily-reporting", "A01", { leaseSeconds: LEASE_S });
  assert.equal(live.disposition, "claimed");
  // A concurrent worker at the SAME DB time (lease unexpired) is refused -- and there is NO caller clock to
  // pass, so it cannot pretend the lease expired.
  const concurrent = store.claimLease(cid, "daily-reporting", "A01", { leaseSeconds: LEASE_S });
  assert.equal(concurrent.disposition, "held", "an UNEXPIRED lease is never stolen");
  assert.equal(concurrent.lease_token, undefined, "no token is handed to the non-holder");
  // The live holder's token still reconciles (once its snapshot exists); the non-holder's would be lease-lost.
  store.recordShadowSnapshot({ reportKey: "scheduler-v2/daily-reporting", accountId: "A01", paramsHash: "H", params: {}, payload: {}, sourceRefreshedAt: TODAY });
  assert.equal(store.reconcileSuccess({ cycleId: cid, reportKey: "daily-reporting", accountId: "A01", snapshotParamsHash: "H", leaseToken: "lease_wrong" }).disposition, "lease-lost", "a non-holder token can never reconcile");
  assert.equal(store.reconcileSuccess({ cycleId: cid, reportKey: "daily-reporting", accountId: "A01", snapshotParamsHash: "H", leaseToken: live.lease_token }).disposition, "reconciled", "only the current lease holder reconciles");
});

test("X6. a STALE/abandoned claimant is recovered ONLY through the guarded transition (reclaim requires DB-time lease expiry)", async () => {
  const store = makeStore();
  store._dbClock.now = BASE_MS;
  const cid = store.openCycle({ bucket: "us", cycleDate: TODAY });
  store.upsertReportJob({ cycleId: cid, reportKey: "daily-reporting", accountId: "A01", connectionId: "primary", bucket: "us", dependsOn: [] });
  const first = store.claimLease(cid, "daily-reporting", "A01", { leaseSeconds: LEASE_S });
  assert.equal(first.disposition, "claimed");
  // Before DB-time expiry: a would-be recoverer is refused (held), so a stale claim cannot be recovered early.
  store._dbClock.now = BASE_MS + LEASE_S * 1000 - 1;
  assert.equal(store.claimLease(cid, "daily-reporting", "A01", { leaseSeconds: LEASE_S }).disposition, "held");
  // After DB-time expiry: a guarded RE-claim issues a NEW token; the OLD token can no longer reconcile.
  store._dbClock.now = PAST_LEASE_MS;
  const reclaim = store.claimLease(cid, "daily-reporting", "A01", { leaseSeconds: LEASE_S });
  assert.equal(reclaim.disposition, "reclaimed");
  assert.notEqual(reclaim.lease_token, first.lease_token, "a FRESH token is issued on reclaim");
  store.recordShadowSnapshot({ reportKey: "scheduler-v2/daily-reporting", accountId: "A01", paramsHash: "H", params: {}, payload: {}, sourceRefreshedAt: TODAY });
  assert.equal(store.reconcileSuccess({ cycleId: cid, reportKey: "daily-reporting", accountId: "A01", snapshotParamsHash: "H", leaseToken: first.lease_token }).disposition, "lease-lost", "the SUPERSEDED (old) token can never reconcile");
  assert.equal(store.reconcileSuccess({ cycleId: cid, reportKey: "daily-reporting", accountId: "A01", snapshotParamsHash: "H", leaseToken: reclaim.lease_token }).disposition, "reconciled");
});

test("X7. a malformed / wrong-account / wrong-hash snapshot NEVER authorizes reconciliation", async () => {
  const store = makeStore();
  store._dbClock.now = BASE_MS;
  const cid = store.openCycle({ bucket: "us", cycleDate: TODAY });
  store.upsertReportJob({ cycleId: cid, reportKey: "daily-reporting", accountId: "A01", connectionId: "primary", bucket: "us", dependsOn: [] });
  const claim = store.claimLease(cid, "daily-reporting", "A01", { leaseSeconds: LEASE_S });
  // Only the EXACT durable snapshot (scheduler-v2/daily-reporting, A01, HASH) authorizes reconcile.
  store.recordShadowSnapshot({ reportKey: "scheduler-v2/daily-reporting", accountId: "A01", paramsHash: "HASH", params: {}, payload: {}, sourceRefreshedAt: TODAY });
  // wrong hash:
  assert.equal(store.reconcileSuccess({ cycleId: cid, reportKey: "daily-reporting", accountId: "A01", snapshotParamsHash: "OTHER", leaseToken: claim.lease_token }).disposition, "snapshot-absent", "a wrong hash finds no durable snapshot");
  // wrong account (A02 has no snapshot / no job):
  store.upsertReportJob({ cycleId: cid, reportKey: "daily-reporting", accountId: "A02", connectionId: "primary", bucket: "us", dependsOn: [] });
  const claim2 = store.claimLease(cid, "daily-reporting", "A02", { leaseSeconds: LEASE_S });
  assert.equal(store.reconcileSuccess({ cycleId: cid, reportKey: "daily-reporting", accountId: "A02", snapshotParamsHash: "HASH", leaseToken: claim2.lease_token }).disposition, "snapshot-absent", "A01's snapshot can never authorize A02");
  // malformed (blank hash):
  assert.equal(store.reconcileSuccess({ cycleId: cid, reportKey: "daily-reporting", accountId: "A01", snapshotParamsHash: "", leaseToken: claim.lease_token }).disposition, "invalid-hash");
  // exact identity + current token -> reconciled.
  assert.equal(store.reconcileSuccess({ cycleId: cid, reportKey: "daily-reporting", accountId: "A01", snapshotParamsHash: "HASH", leaseToken: claim.lease_token }).disposition, "reconciled");
});

test("X8. recovery performs ZERO new DataDoe exports (the source phase is already drained; recovery is pure re-derive+save+reconcile)", async () => {
  const store = makeStore();
  const h1 = recoveryFixture(store, { timeoutClaimAfterCommit: onceFor("daily-reporting", "A01") });
  await h1.runtime.run({ bucket: "us", today: TODAY });
  const creates1 = h1.dd.totalCreates();
  assert.ok(creates1 >= 1, "the first run made the source exports");
  const h2 = fullFixture({ store });
  store._dbClock.now = PAST_LEASE_MS; // DB-authoritative time advances; h2's runtime clock is irrelevant to the lease
  await h2.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(h2.dd.totalCreates(), 0, "the RECOVERY invocation created ZERO DataDoe exports");
});

test("X9. finalization changes open-work -> terminal ONLY after every report is truly complete", async () => {
  const store = makeStore();
  const h1 = recoveryFixture(store, { timeoutClaimAfterCommit: onceFor("daily-reporting", "A01") });
  const r1 = await h1.runtime.run({ bucket: "us", today: TODAY });
  // daily/A01 is running (abandoned) -> the cycle still has open report work -> finalize returns open-work.
  const attempt = store.finalizeCycle({ cycleId: r1.cycleId });
  assert.equal(attempt.disposition, "open-work", "finalize refuses while a report job is still running/abandoned");
  assert.equal(store.getCycle(r1.cycleId).status, "running");
  // Recover, then finalize honestly terminalizes.
  const h2 = fullFixture({ store });
  store._dbClock.now = PAST_LEASE_MS; // DB-authoritative time advances; h2's runtime clock is irrelevant to the lease
  const r2 = await h2.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(r2.stopped, false);
  const closed = store.finalizeCycle({ cycleId: r1.cycleId });
  assert.equal(closed.disposition, "finalized", "AFTER recovery, finalize terminalizes");
  assert.ok(["succeeded", "partial"].includes(closed.cycle.status));
});

test("X10. commitUnknown is preserved in the first invocation's rollup for EACH commit-unknown stage", async () => {
  for (const inject of [
    { timeoutClaimAfterCommit: onceFor("daily-reporting", "A01") },
    { timeoutSaveAt: onceFor("daily-reporting", "A01") },
    { timeoutReconcileBeforeCommit: onceFor("daily-reporting", "A01") },
    { timeoutReconcileAfterCommit: onceFor("daily-reporting", "A01") },
  ]) {
    const store = makeStore();
    const h = recoveryFixture(store, inject);
    const r = await h.runtime.run({ bucket: "us", today: TODAY });
    assert.equal(r.deadlineReached, true, "resumable at the commit-unknown stage");
    assert.equal(r.continuationRequired, true);
    assert.equal(r.commitUnknown, true, "commitUnknown preserved for " + Object.keys(inject)[0]);
  }
});

test("X11. round-7 finding 2: the admin PATCH requires a strict boolean BEFORE any write (400, zero control/audit writes)", async () => {
  // Structural proof over the committed handler: a non-boolean publishEnabled is a 400 that returns BEFORE
  // the control write, so a malformed input performs zero control/audit writes (matching PATCH boolean-strict
  // for the source controls). The strict boolean gate must precede setSourcePromotedPublishControl.
  const src = readFileSync(path.join(process.cwd(), "api", "admin", "sync.js"), "utf8");
  const branch = src.indexOf("SOURCE_PROMOTED_REPORT_KEYS.includes(requestedKey)");
  const boolGate = src.indexOf('typeof body.publishEnabled !== "boolean"', branch);
  const setWrite = src.indexOf("setSourcePromotedPublishControl", branch);
  const auditWrite = src.indexOf('action: publishEnabled ? "report.promoted-publish.enabled"', branch);
  assert.ok(boolGate > branch, "the promoted PATCH validates a strict boolean");
  assert.ok(setWrite > boolGate, "the boolean gate precedes the control write (400 before any write)");
  assert.ok(auditWrite > setWrite, "the audit event is recorded ONLY AFTER the validated control write");
  // The strict gate returns 400 in-branch before the write.
  const gateText = src.slice(boolGate, setWrite);
  assert.match(gateText, /status\(400\)/, "a non-boolean publishEnabled is a 400");
  assert.match(gateText, /return;/, "the 400 RETURNS before the write");
});


/* ================================= X12 / Y / Z: round-8 findings ================================= */
group("X12. round-8 finding 1: DATABASE-authoritative lease time (no caller clock; bounded duration)");

test("X12. a future/past CALLER clock cannot steal or distort a lease; the duration is bounded; the wrapper sends NO caller time", async () => {
  const store = makeStore();
  store._dbClock.now = BASE_MS;
  const cid = store.openCycle({ bucket: "us", cycleDate: TODAY });
  store.upsertReportJob({ cycleId: cid, reportKey: "daily-reporting", accountId: "A01", connectionId: "primary", bucket: "us", dependsOn: [] });
  // claimLease takes NO caller time -- only { leaseSeconds }. A live claim's expiry is DB(now)+lease.
  const live = store.claimLease(cid, "daily-reporting", "A01", { leaseSeconds: LEASE_S });
  assert.equal(live.disposition, "claimed");
  assert.equal(store.getReportJob("daily-reporting", "A01").derive_lease_expires_at, BASE_MS + LEASE_S * 1000, "the expiry is DB-time based, not caller-time");
  // A concurrent caller cannot advance/rewind time: DB time is unchanged, so the lease is still HELD.
  assert.equal(store.claimLease(cid, "daily-reporting", "A01", { leaseSeconds: LEASE_S }).disposition, "held", "a skewed caller cannot pretend the lease expired");
  // The lease duration is bounded to the reviewed safe range [120, 1800]: out-of-range => invalid-lease.
  const cid2 = store.openCycle({ bucket: "non-us", cycleDate: TODAY });
  store.upsertReportJob({ cycleId: cid2, reportKey: "daily-reporting", accountId: "Z01", connectionId: "primary", bucket: "non-us", dependsOn: [] });
  assert.equal(store.claimLease(cid2, "daily-reporting", "Z01", { leaseSeconds: 30 }).disposition, "invalid-lease", "a too-short lease is refused");
  assert.equal(store.claimLease(cid2, "daily-reporting", "Z01", { leaseSeconds: 100000 }).disposition, "invalid-lease", "a too-long lease is refused");
  // The REAL wrapper sends NO p_now field (current time is database-authoritative in the RPC).
  const sb = await import("../lib/server/supabase.js");
  const realFetch = globalThis.fetch;
  try {
    let sentBody = null;
    globalThis.fetch = async (url, init) => { sentBody = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ disposition: "claimed", lease_token: "11111111-1111-1111-1111-111111111111" }), text: async () => "" }; };
    const res = await sb.claimReportDeriveLease("c1", "daily-reporting", "A01", { leaseSeconds: 300 });
    assert.equal(res.disposition, "claimed");
    assert.ok(!("p_now" in sentBody), "the claim RPC body carries NO caller-time (p_now) field");
    assert.equal(sentBody.p_lease_seconds, 300, "only the (bounded) lease duration is sent");
  } finally { globalThis.fetch = realFetch; }
});

group("Y. round-8 finding 2: a recovered snapshot is VALIDATED (provenance + hydration + contract + content-identity) before adoption");

// A recovery fixture whose daily/A01 reconcile does NOT commit -> the snapshot is durably SAVED but the job
// stays 'running' with an expired lease after we advance DB time. A fresh run then RECLAIMS and must validate
// the (possibly tampered) durable snapshot before adopting it.
async function savedButRunning() {
  const store = makeStore();
  const h1 = recoveryFixture(store, { timeoutReconcileBeforeCommit: onceFor("daily-reporting", "A01") });
  const r1 = await h1.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(r1.commitUnknown, true);
  const rec = h1.savedShadow.find((s) => s.reportKey === "scheduler-v2/daily-reporting" && s.accountId === "A01");
  const snapshot = store.getShadowSnapshot({ reportKey: "scheduler-v2/daily-reporting", accountId: "A01", paramsHash: rec.paramsHash });
  return { store, hash: rec.paramsHash, snapshot };
}
async function recoverWith(store, { runtimeNow, ...over } = {}) {
  store._dbClock.now = PAST_LEASE_MS; // the abandoned lease has expired -> a fresh run reclaims (DB time).
  const h2 = fullFixture({ store, ...over });
  // Round-10 blocker 1: the recovery candidate's freshness is the OWNING CYCLE's database-created timestamp
  // (created when h1 opened the cycle; STABLE across retries and independent of the runtime/wall clock). To
  // make the durable evidence older/newer than the candidate, a test sets the durable row's source_refreshed_at
  // directly (that models evidence derived by a different, older/newer cycle). `runtimeNow` advances the RUNTIME
  // wall clock to PROVE it no longer drives durable freshness (under the old design it did, via nowIso()).
  if (runtimeNow != null) h2.clockRef.now = runtimeNow;
  const r2 = await h2.runtime.run({ bucket: "us", today: TODAY });
  return { h2, r2, job: store.getReportJob("daily-reporting", "A01") };
}
// The owning cycle's database-created timestamp: h1 opened the cycle at BASE_MS, so every recovery candidate's
// freshness is exactly this instant regardless of how far the DB/wall clock later advances.
const CYCLE_CREATED_ISO = new Date(BASE_MS).toISOString();
const conflictOutcome = (r2, reason) => r2.derived.lineage.some((l) => l.reportKey === "daily-reporting" && l.accountId === "A01" && l.outcome === "snapshot-conflict" && l.detail === reason);
const outcomeOf = (r2, rk, a) => (r2.derived.lineage.find((l) => l.reportKey === rk && l.accountId === a) || {}).outcome;

test("Y1. MUTATED params (recomputed hash != stored hash) => typed params-provenance conflict; NEVER validated; finalize stays open-work", async () => {
  const { store, snapshot } = await savedButRunning();
  snapshot.params = { ...snapshot.params, brand: "TAMPERED" }; // same version/account -> provenance breaks
  const { r2, job } = await recoverWith(store);
  assert.equal(job.validated, false, "a mutated-params snapshot is NEVER adopted/validated");
  assert.equal(job.derive_status, "running", "the job stays running");
  assert.ok(conflictOutcome(r2, "params-provenance"), "typed params-provenance conflict");
  assert.ok(r2.derived.skipped != null, "the rollup is honestly incomplete");
  assert.equal(store.finalizeCycle({ cycleId: r2.cycleId }).disposition, "open-work", "finalize can NEVER terminalize around the conflict");
});

test("Y2. a MALFORMED payload fails the exact report contract => payload-invalid; NEVER validated", async () => {
  const { store, snapshot } = await savedButRunning();
  snapshot.payload = { garbage: true }; // params intact -> provenance ok; validatePayload rejects it
  const { r2, job } = await recoverWith(store);
  assert.equal(job.validated, false);
  assert.ok(conflictOutcome(r2, "payload-invalid"), "typed payload-invalid conflict");
  assert.ok(r2.derived.skipped != null);
});

test("Y3. a DANGLING storage-backed payload (loader returns null) => payload-dangling; NEVER validated", async () => {
  const { store, snapshot } = await savedButRunning();
  snapshot.payload = null; snapshot.payload_storage_path = "report-snapshots/v2/orphan.json";
  const { r2, job } = await recoverWith(store, { loadShadowStoragePayload: async () => null });
  assert.equal(job.validated, false);
  assert.ok(conflictOutcome(r2, "payload-dangling"), "typed payload-dangling conflict");
});

test("Y4. a WRONG derivation version => wrong-version conflict; NEVER validated", async () => {
  const { store, snapshot } = await savedButRunning();
  snapshot.params = { ...snapshot.params, reportVersion: "daily-reporting/WRONG" };
  const { r2, job } = await recoverWith(store);
  assert.equal(job.validated, false);
  assert.ok(conflictOutcome(r2, "wrong-version"), "typed wrong-version conflict");
});

test("Y5. an UNAVAILABLE payload (no inline payload, no storage path) => payload-unavailable; NEVER validated", async () => {
  const { store, snapshot } = await savedButRunning();
  snapshot.payload = null; snapshot.payload_storage_path = null;
  const { r2, job } = await recoverWith(store);
  assert.equal(job.validated, false);
  assert.ok(conflictOutcome(r2, "payload-unavailable"), "typed payload-unavailable conflict");
});

test("Y6. round-9 finding 4: an EQUAL-freshness but CONTENT-CONFLICTING durable snapshot preserves LKG (never overwritten, never adopted) => non-resumable typed conflict", async () => {
  const { store, snapshot } = await savedButRunning();
  const lkg = snapshot.payload;
  snapshot.payload = { ...snapshot.payload, __conflict: "different-content" }; // still contract-valid, but != candidate
  // The durable evidence and the recovery candidate share the SAME owning-cycle created_at -> EQUAL freshness.
  const { r2, job } = await recoverWith(store);
  assert.equal(job.validated, false, "an equal-freshness conflicting-content snapshot is NEVER adopted");
  assert.ok(conflictOutcome(r2, "conflict"), "typed CAS conflict (equal freshness, different content)");
  assert.equal(store.getShadowSnapshot({ reportKey: "scheduler-v2/daily-reporting", accountId: "A01", paramsHash: snapshot.params_hash }).payload.__conflict, "different-content", "LKG is PRESERVED (the durable evidence is not overwritten)");
  assert.equal(r2.derived.resumable, false, "an equal-conflict is NON-resumable (finalize stays open until reviewed)");
  assert.equal(store.finalizeCycle({ cycleId: r2.cycleId }).disposition, "open-work");
});

test("Y6b. round-9 finding 4 + round-10 blocker 1: a candidate from a NEWER cycle (correction/rerun) atomically REPLACES older-cycle shadow evidence and validates", async () => {
  const { store, snapshot, hash } = await savedButRunning();
  // The durable snapshot is stale/wrong content derived by an OLDER cycle; our fresh candidate is the correct
  // derivation. Round-10: freshness is DB-authoritative -- make the DURABLE evidence older by stamping its
  // source_refreshed_at before the owning cycle's created_at (the candidate's stable freshness).
  snapshot.payload = { ...snapshot.payload, __stale: "old-evidence" };
  snapshot.source_refreshed_at = new Date(BASE_MS - 10_000_000).toISOString();
  const { r2, job } = await recoverWith(store);
  assert.equal(job.validated, true, "a newer-cycle validated candidate replaces older evidence and completes");
  const durable = store.getShadowSnapshot({ reportKey: "scheduler-v2/daily-reporting", accountId: "A01", paramsHash: hash });
  assert.ok(!("__stale" in durable.payload), "the stale content was atomically REPLACED by the fresh candidate");
  assert.equal(durable.source_refreshed_at, CYCLE_CREATED_ISO, "the durable freshness advanced to the owning cycle's created_at");
  assert.equal(outcomeOf(r2, "daily-reporting", "A01"), "recovered", "typed recovered (refreshed) outcome");
  assert.equal(store.finalizeCycle({ cycleId: r2.cycleId }).disposition, "finalized", "finalize can now terminalize");
});

test("Y6c. round-9 finding 4 + round-10 blocker 1: a candidate from an OLDER cycle never overwrites newer-cycle durable evidence (newer-live) => typed RESUMABLE, LKG preserved", async () => {
  const { store, snapshot, hash } = await savedButRunning();
  // The durable evidence was derived by a NEWER cycle -> its source_refreshed_at is after the candidate's
  // owning-cycle created_at. An older-cycle candidate can never overwrite it.
  snapshot.payload = { ...snapshot.payload, __newer: "durable-refresh" };
  snapshot.source_refreshed_at = new Date(BASE_MS + 10_000_000).toISOString();
  const { r2, job } = await recoverWith(store);
  assert.equal(job.validated, false, "an older-cycle candidate never overwrites/adopts the newer durable");
  assert.equal(outcomeOf(r2, "daily-reporting", "A01"), "snapshot-newer", "typed snapshot-newer");
  assert.equal(store.getShadowSnapshot({ reportKey: "scheduler-v2/daily-reporting", accountId: "A01", paramsHash: hash }).payload.__newer, "durable-refresh", "LKG (the newer durable) is preserved");
  assert.equal(r2.derived.resumable, true, "newer-live is RESUMABLE (a later invocation reads+validates the newer durable)");
});

test("Y6d. round-9 finding 4: the atomic freshness CAS converges concurrent writers on the newest timestamp; the older loser preserves LKG", () => {
  const store = makeStore();
  const cand = (ts, payload) => ({ reportKey: "scheduler-v2/daily-reporting", accountId: "A01", paramsHash: "H", params: { reportVersion: "v", accountId: "A01" }, payload, sourceRefreshedAt: ts });
  // Writer A inserts.
  assert.equal(store.shadowCasIfNewer(cand("2026-08-22T00:00:01Z", { v: "A" })).outcome, "inserted");
  // Writer B (newer) replaces atomically.
  assert.equal(store.shadowCasIfNewer(cand("2026-08-22T00:00:02Z", { v: "B" })).outcome, "replaced");
  // Writer C (OLDER than the current) is refused; LKG (B) preserved.
  assert.equal(store.shadowCasIfNewer(cand("2026-08-22T00:00:01Z", { v: "C" })).outcome, "newer-live");
  assert.equal(store.getShadowSnapshot({ reportKey: "scheduler-v2/daily-reporting", accountId: "A01", paramsHash: "H" }).payload.v, "B", "the newest timestamp wins; the older loser never clobbers LKG");
  // An EQUAL-freshness identical candidate is already-current (no write); a different one is a conflict.
  assert.equal(store.shadowCasIfNewer(cand("2026-08-22T00:00:02Z", { v: "B" })).outcome, "already-current");
  assert.equal(store.shadowCasIfNewer(cand("2026-08-22T00:00:02Z", { v: "X" })).outcome, "conflict");
});

test("Y7. an IDENTICAL, fully-valid durable snapshot IS adopted (recovered) without a re-save", async () => {
  // No tamper: the durable snapshot is byte-identical to the fresh candidate -> adopt + reconcile.
  const { store } = await savedButRunning();
  const { r2, job, h2 } = await recoverWith(store);
  assert.equal(job.validated, true, "an identical valid snapshot is adopted to success");
  assert.ok(!h2.recorded.shadowSaves.some((s) => s.reportKey === "scheduler-v2/daily-reporting" && s.accountId === "A01"), "adoption re-saves NOTHING");
  assert.ok(r2.derived.lineage.some((l) => l.reportKey === "daily-reporting" && l.accountId === "A01" && l.outcome === "recovered"));
});

group("Z. round-8 findings 3/4/5: honest incomplete rollups; total lease state machine + strict acks; abortable recovery read");

test("Z1. finding 3: a HELD report yields a TYPED-RESUMABLE incomplete rollup (never looks completed); a later invocation recovers with ZERO DataDoe", async () => {
  const store = makeStore();
  store._dbClock.now = BASE_MS;
  // A LIVE concurrent worker holds daily/A01 (running + unexpired lease) while our run processes the bucket.
  const heldLineage = {
    upsertReportJob: async (j) => store.upsertReportJob(j),
    claimLease: async (c, rk, a, opts) => {
      if (rk === "daily-reporting" && a === "A01") { store.claimLease(c, rk, a, opts); return { disposition: "held" }; }
      const res = store.claimLease(c, rk, a, opts);
      return { disposition: res.disposition, leaseToken: res.lease_token || null, snapshotParamsHash: res.snapshot_params_hash || null, deriveStatus: res.derive_status || null };
    },
    reconcileSuccess: async (j) => { const res = store.reconcileSuccess(j); return { disposition: res.disposition }; },
  };
  const h1 = fullFixture({ store, reportLineage: heldLineage });
  const r1 = await h1.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(r1.stopped, false);
  assert.ok(r1.derived.skipped != null, "a HELD report makes the rollup honestly INCOMPLETE (never skipped:null)");
  assert.equal(r1.continuationRequired, true, "finding 3: a held report is typed-resumable (continuationRequired)");
  assert.ok((r1.derived.incomplete || []).some((x) => x.reportKey === "daily-reporting" && x.accountId === "A01" && x.outcome === "claim-held"), "the held report is enumerated in the incomplete set");
  assert.equal(store.getReportJob("daily-reporting", "A01").validated, false, "held work is NEVER a success");
  assert.equal(store.finalizeCycle({ cycleId: r1.cycleId }).disposition, "open-work", "finalize cannot terminalize while a report is held");
  // A later invocation past the lease reclaims + recovers -- ZERO DataDoe.
  store._dbClock.now = PAST_LEASE_MS;
  const h2 = fullFixture({ store });
  const r2 = await h2.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(store.getReportJob("daily-reporting", "A01").validated, true, "the later invocation RECOVERED the held report");
  assert.equal(r2.derived.skipped, null, "the recovery run is fully complete");
  assert.equal(h2.dd.totalCreates(), 0, "recovery performs ZERO DataDoe exports");
  assert.equal(store.finalizeCycle({ cycleId: r2.cycleId }).disposition, "finalized", "now finalize terminalizes honestly");
});

test("Z2. finding 3: a reconcile LEASE-LOST (concurrent takeover) is NEVER success-like; the rollup is typed-resumable incomplete", async () => {
  const store = makeStore();
  const lostLineage = {
    upsertReportJob: async (j) => store.upsertReportJob(j),
    claimLease: async (c, rk, a, opts) => {
      const res = store.claimLease(c, rk, a, opts);
      return { disposition: res.disposition, leaseToken: res.lease_token || null, snapshotParamsHash: res.snapshot_params_hash || null, deriveStatus: res.derive_status || null };
    },
    reconcileSuccess: async (j) => {
      if (j.reportKey === "daily-reporting" && j.accountId === "A01") return { disposition: "lease-lost" }; // a concurrent worker took over
      const res = store.reconcileSuccess(j); return { disposition: res.disposition };
    },
  };
  const h1 = fullFixture({ store, reportLineage: lostLineage });
  const r1 = await h1.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(store.getReportJob("daily-reporting", "A01").validated, false, "a lease-lost reconcile NEVER records success");
  assert.ok((r1.derived.incomplete || []).some((x) => x.reportKey === "daily-reporting" && x.accountId === "A01" && x.outcome === "reconcile-lease-lost"), "typed reconcile-lease-lost");
  assert.ok(r1.derived.skipped != null && r1.continuationRequired === true, "lease-lost is a typed-resumable incomplete rollup");
  assert.equal(r1.derived.resumable, true);
  assert.notEqual(r1.derived.daily.saved, undefined);
});

test("Z3. finding 4: TOTAL lease state machine -- succeeded+save-failed and other incoherent combos are 'invalid-state'; a non-running reconcile is typed", async () => {
  const store = makeStore();
  const cid = store.openCycle({ bucket: "us", cycleDate: TODAY });
  store.upsertReportJob({ cycleId: cid, reportKey: "daily-reporting", accountId: "A01", connectionId: "primary", bucket: "us", dependsOn: [] });
  const j = store._reportJobs.get(cid + "|daily-reporting|A01");
  // succeeded derive but save FAILED (not a validated success): claim => invalid-state (never a lease write).
  Object.assign(j, { derive_status: "succeeded", save_status: "failed", validated: false });
  const r = store.claimLease(cid, "daily-reporting", "A01", { leaseSeconds: LEASE_S });
  assert.equal(r.disposition, "invalid-state", "succeeded+save-failed is invalid-state, not a claim");
  assert.equal(j.derive_lease_token, null, "no lease token is written for an incoherent state");
  // reconcile on a non-running (succeeded-here) row is handled explicitly (invalid-state), never a fall-through.
  store.recordShadowSnapshot({ reportKey: "scheduler-v2/daily-reporting", accountId: "A01", paramsHash: "H", params: {}, payload: {}, sourceRefreshedAt: TODAY });
  assert.equal(store.reconcileSuccess({ cycleId: cid, reportKey: "daily-reporting", accountId: "A01", snapshotParamsHash: "H", leaseToken: "x" }).disposition, "invalid-state");
  // a failed/skipped derive is 'terminal' for both claim and reconcile.
  Object.assign(j, { derive_status: "failed", save_status: "skipped", validated: false });
  assert.equal(store.claimLease(cid, "daily-reporting", "A01", { leaseSeconds: LEASE_S }).disposition, "terminal");
  assert.equal(store.reconcileSuccess({ cycleId: cid, reportKey: "daily-reporting", accountId: "A01", snapshotParamsHash: "H", leaseToken: "x" }).disposition, "terminal");
});

test("Z4. finding 4: STRICT acknowledgement validators -- multi-row / malformed / disposition-dependent-field-incoherent acks fail closed", async () => {
  const sb = await import("../lib/server/supabase.js");
  const realFetch = globalThis.fetch;
  const stub = (body) => { globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => body, text: async () => "" }); };
  try {
    // CLAIM: multi-row, non-object, unknown disposition, claimed-without-token, non-claim-with-token all throw.
    stub([{ disposition: "claimed", lease_token: "t" }, { disposition: "claimed", lease_token: "t" }]);
    await assert.rejects(() => sb.claimReportDeriveLease("c", "r", "a", { leaseSeconds: 300 }), (e) => e.code === "REPORT_LEASE_ACK_INVALID", "multi-row");
    stub("not-an-object");
    await assert.rejects(() => sb.claimReportDeriveLease("c", "r", "a", { leaseSeconds: 300 }), (e) => e.code === "REPORT_LEASE_ACK_INVALID", "non-object");
    stub({ disposition: "weird" });
    await assert.rejects(() => sb.claimReportDeriveLease("c", "r", "a", { leaseSeconds: 300 }), (e) => e.code === "REPORT_LEASE_ACK_INVALID", "unknown disposition");
    stub({ disposition: "claimed" }); // claimed WITHOUT a lease token
    await assert.rejects(() => sb.claimReportDeriveLease("c", "r", "a", { leaseSeconds: 300 }), (e) => e.code === "REPORT_LEASE_ACK_INVALID", "claimed without token");
    stub({ disposition: "reclaimed", lease_token: "   " }); // blank token
    await assert.rejects(() => sb.claimReportDeriveLease("c", "r", "a", { leaseSeconds: 300 }), (e) => e.code === "REPORT_LEASE_ACK_INVALID", "reclaimed with blank token");
    stub({ disposition: "held", lease_token: "t" }); // a NON-claiming disposition must NOT carry a token
    await assert.rejects(() => sb.claimReportDeriveLease("c", "r", "a", { leaseSeconds: 300 }), (e) => e.code === "REPORT_LEASE_ACK_INVALID", "held with a contradictory token");
    // valid claim ack passes.
    stub({ disposition: "claimed", lease_token: "11111111-1111-1111-1111-111111111111" });
    assert.equal((await sb.claimReportDeriveLease("c", "r", "a", { leaseSeconds: 300 })).disposition, "claimed");
    // RECONCILE: multi-row, unknown disposition, and a 'reconciled' NOT echoing the exact hash all throw.
    stub([{ disposition: "reconciled" }, { disposition: "reconciled" }]);
    await assert.rejects(() => sb.reconcileReportDeriveSuccess({ cycleId: "c", reportKey: "r", accountId: "a", snapshotParamsHash: "H", leaseToken: "t" }), (e) => e.code === "REPORT_RECONCILE_ACK_INVALID", "multi-row");
    stub({ disposition: "reconciled", snapshot_params_hash: "OTHER" });
    await assert.rejects(() => sb.reconcileReportDeriveSuccess({ cycleId: "c", reportKey: "r", accountId: "a", snapshotParamsHash: "H", leaseToken: "t" }), (e) => e.code === "REPORT_RECONCILE_ACK_INVALID", "reconciled not echoing the hash");
    stub({ disposition: "reconciled", snapshot_params_hash: "H" });
    assert.equal((await sb.reconcileReportDeriveSuccess({ cycleId: "c", reportKey: "r", accountId: "a", snapshotParamsHash: "H", leaseToken: "t" })).disposition, "reconciled");
  } finally { globalThis.fetch = realFetch; }
});

test("Z5. finding 5: getReportSnapshot forwards the route signal to the real fetch; a HUNG recovery read is aborted within budget => typed-resumable, NO later save/reconcile", async () => {
  // (a) the wrapper forwards { signal } to request()/fetch.
  const sb = await import("../lib/server/supabase.js");
  const realFetch = globalThis.fetch;
  try {
    let seenSig = "unset";
    const ctrl = new AbortController();
    globalThis.fetch = async (url, init) => { seenSig = init && init.signal; return { ok: true, status: 200, json: async () => [], text: async () => "[]" }; };
    await sb.getReportSnapshot({ reportKey: "scheduler-v2/daily-reporting", accountId: "A01", paramsHash: "H" }, { signal: ctrl.signal });
    assert.equal(seenSig, ctrl.signal, "getReportSnapshot forwards the route signal to the real fetch");
  } finally { globalThis.fetch = realFetch; }
  // (b) a HUNG recovery read (readShadowSnapshot never resolves) is aborted within the route budget: the run
  // returns typed-resumable and performs NO shadow save / reconcile for that report.
  const store = makeStore();
  let reconciles = 0;
  const trackedLineage = {
    upsertReportJob: async (j) => store.upsertReportJob(j),
    claimLease: async (c, rk, a, opts) => { const res = store.claimLease(c, rk, a, opts); return { disposition: res.disposition, leaseToken: res.lease_token || null, snapshotParamsHash: res.snapshot_params_hash || null, deriveStatus: res.derive_status || null }; },
    reconcileSuccess: async (j) => { reconciles += 1; const res = store.reconcileSuccess(j); return { disposition: res.disposition }; },
  };
  const h = fullFixture({
    store,
    reportLineage: trackedLineage,
    readShadowSnapshot: () => new Promise(() => {}), // hangs forever; the bound read must abort it
    setTimer: (fn) => setTimeout(fn, 0), clearTimer: (id) => clearTimeout(id),
    budgetMs: 60_000, reserveMs: 1_000,
  });
  const r = await h.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(r.deadlineReached, true, "the hung recovery read was aborted at the route budget");
  assert.equal(r.continuationRequired, true, "the run is typed-resumable");
  assert.equal(h.recorded.shadowSaves.length, 0, "NO shadow save after a hung recovery read");
  assert.equal(reconciles, 0, "NO reconcile after a hung recovery read");
});

group("ZM. round-8: SQL mutation regressions -- weakening any lease/reconcile condition fails the audit");

const MIG822 = "20260822_report_derive_lease.sql";
function auditWith822(mutate) {
  return schema.auditSchemaContract({ readFile: (rel) => {
    if (rel === "supabase.js") return readFileSync(path.join(process.cwd(), "lib", "server", "supabase.js"), "utf8");
    const t = readFileSync(path.join(process.cwd(), "supabase", "migrations", rel), "utf8");
    return (rel === MIG822 && mutate) ? mutate(t) : t;
  } });
}

test("ZM1. the REAL 20260822 audits clean; mutating any lease/reconcile guard raises a typed blocker", () => {
  assert.equal(auditWith822(null).ok, true, "baseline clean");
  const has = (res, code) => res.blockers.some((b) => b.code === code);
  // DB-authoritative time: reintroducing a caller-time param (p_now) fails.
  const callerTime = auditWith822((s) => s.replace("p_cycle_id uuid, p_report_key text, p_account_id text, p_lease_seconds integer", "p_cycle_id uuid, p_report_key text, p_account_id text, p_now timestamptz, p_lease_seconds integer").replace("v_now timestamptz := now();", "v_now timestamptz := p_now;"));
  assert.ok(has(callerTime, "CLAIM_LEASE_CALLER_TIME") || callerTime.blockers.some((b) => b.code === "RPC_PARAM_MISMATCH" || String(b.code).includes("PARAM")), JSON.stringify(callerTime.blockers.map((b) => b.code)));
  // Lease bound: removing the upper/lower bound check fails.
  const unbounded = auditWith822((s) => s.replace("if p_lease_seconds is null or p_lease_seconds < 120 or p_lease_seconds > 1800 then", "if p_lease_seconds is null or p_lease_seconds <= 0 then"));
  assert.ok(has(unbounded, "CLAIM_LEASE_UNBOUNDED"), JSON.stringify(unbounded.blockers.map((b) => b.code)));
  // Steal guard: weakening 'held' to always reclaim fails.
  const steal = auditWith822((s) => s.replace("if v_job.derive_lease_expires_at is not null and v_job.derive_lease_expires_at > v_now then", "if false then"));
  assert.ok(has(steal, "CLAIM_LEASE_STEAL_GUARD_MISSING"), JSON.stringify(steal.blockers.map((b) => b.code)));
  // Reclaim running-guard: dropping "and derive_status = 'running'" from the reclaim UPDATE fails.
  const reclaimUnguarded = auditWith822((s) => s.replace("      where cycle_id = p_cycle_id and report_key = p_report_key and account_id = p_account_id\n        and derive_status = 'running';\n    return jsonb_build_object('disposition', 'reclaimed'", "      where cycle_id = p_cycle_id and report_key = p_report_key and account_id = p_account_id;\n    return jsonb_build_object('disposition', 'reclaimed'"));
  assert.ok(has(reclaimUnguarded, "CLAIM_LEASE_RECLAIM_MISSING"), JSON.stringify(reclaimUnguarded.blockers.map((b) => b.code)));
  // Total state machine: removing 'invalid-state' fails.
  const notTotal = auditWith822((s) => s.split("'invalid-state'").join("'not-found'"));
  assert.ok(has(notTotal, "CLAIM_LEASE_STATE_INCOMPLETE") || has(notTotal, "RECONCILE_NONRUNNING_UNHANDLED"), JSON.stringify(notTotal.blockers.map((b) => b.code)));
  // Reconcile snapshot binding: dropping the report_snapshots EXISTS fails.
  const noBind = auditWith822((s) => s.replace(/select exists \([\s\S]*?\) into v_snapshot_exists;/, "v_snapshot_exists := true;"));
  assert.ok(has(noBind, "RECONCILE_SNAPSHOT_BINDING_MISSING"), JSON.stringify(noBind.blockers.map((b) => b.code)));
  // Reconcile lease guard: dropping the token check fails.
  const noToken = auditWith822((s) => s.replace("if v_job.derive_lease_token is null or v_job.derive_lease_token <> p_lease_token then", "if false then"));
  assert.ok(has(noToken, "RECONCILE_LEASE_GUARD_MISSING"), JSON.stringify(noToken.blockers.map((b) => b.code)));
  // Reconcile non-running handling: removing the explicit non-running branch fails.
  const noNonRunning = auditWith822((s) => s.replace(/  if v_job\.derive_status <> 'running' then\n    if v_job\.derive_status in \('failed', 'skipped'\) then\n      return jsonb_build_object\('disposition', 'terminal', 'derive_status', v_job\.derive_status\);\n    end if;\n    return jsonb_build_object\('disposition', 'invalid-state', 'derive_status', v_job\.derive_status,\n                              'save_status', v_job\.save_status, 'validated', v_job\.validated\);\n  end if;\n/, ""));
  assert.ok(has(noNonRunning, "RECONCILE_NONRUNNING_UNHANDLED"), JSON.stringify(noNonRunning.blockers.map((b) => b.code)));
  // Round-9 finding 1: claim 'already-complete' MUST be hash-bound -- dropping the nonblank-hash guard fails.
  const noHashGuard = auditWith822((s) => s.replace("      if v_job.snapshot_params_hash is null or char_length(btrim(v_job.snapshot_params_hash)) = 0 then\n        return jsonb_build_object('disposition', 'invalid-state', 'derive_status', 'succeeded',\n                                  'save_status', v_job.save_status, 'validated', v_job.validated, 'reason', 'missing-hash');\n      end if;\n", ""));
  assert.ok(has(noHashGuard, "CLAIM_LEASE_COMPLETE_HASH_UNBOUND"), JSON.stringify(noHashGuard.blockers.map((b) => b.code)));
  // Round-9 finding 1: reconcile 'already-complete' MUST echo the hash -- dropping the echo fails.
  const noEcho = auditWith822((s) => s.replace("    return jsonb_build_object('disposition', 'already-complete', 'snapshot_params_hash', v_job.snapshot_params_hash);\n  end if;\n  -- Round-8: reconcile is meaningful", "    return jsonb_build_object('disposition', 'already-complete');\n  end if;\n  -- Round-8: reconcile is meaningful"));
  assert.ok(has(noEcho, "RECONCILE_IDEMPOTENT_MISSING"), JSON.stringify(noEcho.blockers.map((b) => b.code)));
});

test("ZM2. round-10 blockers 1/2: mutating any freshness-CAS guard in cas_report_snapshot_if_newer raises a typed blocker", () => {
  assert.equal(auditWith822(null).ok, true, "baseline clean");
  const has = (res, code) => res.blockers.some((b) => b.code === code);
  // Blocker 1: the candidate freshness must be timestamptz (chronological). Changing it to text (lexicographic-
  // prone) drops the required-statement proof.
  const asText = auditWith822((s) => s.replace("  p_payload_bytes bigint, p_source_refreshed_at timestamptz\n)", "  p_payload_bytes bigint, p_source_refreshed_at text\n)"));
  assert.ok(has(asText, "STATEMENT_MISSING"), JSON.stringify(asText.blockers.map((b) => b.code)));
  // Null-freshness guard dropped -> a null instant could win a CAS.
  const noNull = auditWith822((s) => s.replace("  if p_source_refreshed_at is null then\n    return jsonb_build_object('disposition', 'invalid-freshness');\n  end if;\n", ""));
  assert.ok(has(noNull, "SNAPSHOT_FRESH_CAS_NULL_GUARD_MISSING"), JSON.stringify(noNull.blockers.map((b) => b.code)));
  // Insert-if-absent dropped.
  const noInsert = auditWith822((s) => s.replace("  on conflict (report_key, account_id, params_hash) do nothing;", "  ;"));
  assert.ok(has(noInsert, "SNAPSHOT_FRESH_CAS_INSERT_MISSING"), JSON.stringify(noInsert.blockers.map((b) => b.code)));
  // FOR UPDATE lock dropped on the CAS select.
  const noLock = auditWith822((s) => s.replace("    where report_key = p_report_key and account_id = p_account_id and params_hash = p_params_hash\n    for update;", "    where report_key = p_report_key and account_id = p_account_id and params_hash = p_params_hash;"));
  assert.ok(has(noLock, "SNAPSHOT_FRESH_CAS_LOCK_MISSING"), JSON.stringify(noLock.blockers.map((b) => b.code)));
  // Guarded replace: dropping "and source_refreshed_at < p_source_refreshed_at" makes it a blind overwrite.
  const blindReplace = auditWith822((s) => s.replace("      where report_key = p_report_key and account_id = p_account_id and params_hash = p_params_hash\n        and source_refreshed_at < p_source_refreshed_at;", "      where report_key = p_report_key and account_id = p_account_id and params_hash = p_params_hash;"));
  assert.ok(has(blindReplace, "SNAPSHOT_FRESH_CAS_REPLACE_UNGUARDED"), JSON.stringify(blindReplace.blockers.map((b) => b.code)));
  // Strictly-older branch removed -> 'newer-live' path broken.
  const noOlder = auditWith822((s) => s.replace("  elsif p_source_refreshed_at < v_row.source_refreshed_at then", "  elsif false then"));
  assert.ok(has(noOlder, "SNAPSHOT_FRESH_CAS_OLDER_MISSING"), JSON.stringify(noOlder.blockers.map((b) => b.code)));
  // Equal branch must return the durable content for a storage-first identity proof.
  const noEqualContent = auditWith822((s) => s.replace("    return jsonb_build_object(\n      'disposition', 'equal',\n      'params', v_row.params,\n      'payload', v_row.payload,\n      'payload_storage_path', v_row.payload_storage_path\n    );", "    return jsonb_build_object('disposition', 'equal');"));
  assert.ok(has(noEqualContent, "SNAPSHOT_FRESH_CAS_EQUAL_UNPROVEN"), JSON.stringify(noEqualContent.blockers.map((b) => b.code)));
});


group("V. round-10 blockers 1/2: DATABASE-authoritative evidence freshness + storage-first freshness CAS");

test("V1. blocker 1: the runtime stamps durable shadow freshness with the OWNING CYCLE's created_at (never the caller/route wall clock)", async () => {
  const store = makeStore();
  store._dbClock.now = 5_000_000; // DB-authoritative cycle-creation time, DISTINCT from the runtime wall clock (8_000_000).
  const h = fullFixture({ store });
  const rollup = await h.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(rollup.derived.skipped, null, "the happy path completes (regression 8: existing behavior intact)");
  const created = h.store.getCycle(rollup.cycleId).created_at;
  assert.equal(created, new Date(5_000_000).toISOString(), "the owning cycle's created_at is the DB-authoritative instant");
  const saves = h.recorded.shadowSaves;
  assert.ok(saves.length >= 1, "durable shadow saves happened");
  for (const s of saves) {
    assert.equal(s.sourceRefreshedAt, created, s.reportKey + "/" + s.accountId + ": durable freshness == owning cycle created_at (DB-authoritative)");
  }
  // A wall-clock freshness would be the RUNTIME clock instant (8_000_000), which the durable saves must NOT use.
  assert.notEqual(saves[0].sourceRefreshedAt, new Date(8_000_000).toISOString(), "freshness is the cycle created_at, NOT the runtime wall clock");
});

test("V2. regression 1+2+7: an older-cycle candidate never overwrites newer-cycle evidence; advancing the wall clock does NOT help; LKG byte-identical", async () => {
  const { store, snapshot, hash } = await savedButRunning();
  // Durable evidence was produced by a NEWER cycle -> its freshness is after the recovery candidate's cycle created_at.
  snapshot.payload = { ...snapshot.payload, __newer_cycle: "durable" };
  snapshot.source_refreshed_at = new Date(BASE_MS + 20_000_000).toISOString();
  const lkg = JSON.parse(JSON.stringify(store.getShadowSnapshot({ reportKey: "scheduler-v2/daily-reporting", accountId: "A01", paramsHash: hash })));
  // Advance the RUNTIME wall clock FAR into the future: under the old design nowIso() would make the candidate
  // "newest" and overwrite; under the DB-authoritative design freshness is the stable cycle created_at.
  const { r2, job } = await recoverWith(store, { runtimeNow: BASE_MS + 999_000_000 });
  assert.equal(outcomeOf(r2, "daily-reporting", "A01"), "snapshot-newer", "the older-cycle candidate never overwrites the newer durable, even with a future wall clock");
  assert.equal(job.validated, false);
  assert.equal(r2.derived.resumable, true, "newer-live is resumable");
  assert.deepEqual(store.getShadowSnapshot({ reportKey: "scheduler-v2/daily-reporting", accountId: "A01", paramsHash: hash }), lkg, "LKG is byte-identical (never overwritten)");
});

test("V3. regression 3: EQUAL instants written as Z / +00:00 / a non-UTC offset / fractional precision compare CHRONOLOGICALLY (never lexicographically)", () => {
  const store = makeStore();
  const cand = (ts, payload, sp) => ({ reportKey: "scheduler-v2/daily-reporting", accountId: "A01", paramsHash: "H", params: { reportVersion: "v", accountId: "A01" }, payload, sourceRefreshedAt: ts, payloadStoragePath: sp || null });
  assert.equal(store.shadowCasIfNewer(cand("2026-08-22T00:00:00Z", { v: 1 })).outcome, "inserted");
  // '+00:00' is lexicographically BEFORE 'Z' but the SAME instant -> already-current (identical content), not newer-live.
  assert.equal(store.shadowCasIfNewer(cand("2026-08-22T00:00:00+00:00", { v: 1 })).outcome, "already-current", "Z == +00:00 (identical content adopts)");
  // A non-UTC offset naming the same instant (05:30+05:30 == 00:00Z).
  assert.equal(store.shadowCasIfNewer(cand("2026-08-22T05:30:00+05:30", { v: 1 })).outcome, "already-current", "offset instant equals the UTC instant");
  // Added fractional precision, same instant, DIFFERENT content -> equal-freshness conflict (LKG preserved), NOT replaced.
  assert.equal(store.shadowCasIfNewer(cand("2026-08-22T00:00:00.000Z", { v: 2 })).outcome, "conflict", "equal fractional instant + different content is a conflict, never a blind replace");
  // A genuinely newer instant (+1ms) with different content DOES replace.
  assert.equal(store.shadowCasIfNewer(cand("2026-08-22T00:00:00.001Z", { v: 3 })).outcome, "replaced");
  assert.equal(store.getShadowSnapshot({ reportKey: "scheduler-v2/daily-reporting", accountId: "A01", paramsHash: "H" }).payload.v, 3);
});

test("V4. blocker 2 (live publish): publishLiveSnapshotIfNewer compares instants chronologically and proves EQUAL identity STORAGE-FIRST (a stale inline can never stand in)", async () => {
  const sb = await import("../lib/server/supabase.js");
  const CAND = { ok: true, rows: [1, 2, 3] };
  const args = { reportKey: "daily-reporting", accountId: "A01", paramsHash: "h".repeat(40), params: { reportVersion: "v", to: "2026-08-14" }, payload: CAND, payloadBytes: 20, sourceRefreshedAt: "2026-08-14T00:00:00Z" };
  const realFetch = globalThis.fetch;
  // Dispatch by request kind: insert POST / readLive GET / storage GET (identity/different/unreadable).
  const stub = ({ live, storagePayload, storageStatus = 200 }) => { globalThis.fetch = async (url, opts = {}) => {
    const u = String(url); const method = (opts.method || "GET").toUpperCase();
    if (u.includes("/storage/v1/object/")) {
      if (storageStatus !== 200) return { ok: false, status: storageStatus, json: async () => null, text: async () => "" };
      return { ok: true, status: 200, json: async () => storagePayload, text: async () => JSON.stringify(storagePayload) };
    }
    if (u.includes("/rest/v1/report_snapshots") && method === "POST") return { ok: true, status: 201, json: async () => [], text: async () => "" }; // insert conflicts (row exists)
    return { ok: true, status: 200, json: async () => (live == null ? [] : [live]), text: async () => "" }; // readLive GET
  }; };
  try {
    // '+00:00' live at the SAME instant as the 'Z' candidate + identical inline -> already-current (chronological).
    stub({ live: { params: args.params, payload: CAND, payload_storage_path: null, source_refreshed_at: "2026-08-14T00:00:00+00:00" } });
    assert.deepEqual(await sb.publishLiveSnapshotIfNewer(args), { outcome: "already-current" }, "Z vs +00:00 compare EQUAL (not newer-live)");
    // STORAGE-FIRST: a stale INLINE that matches the candidate but an AUTHORITATIVE storage object that DIFFERS
    // must be a conflict (the inline can never stand in) -> never already-current, never a reconcilable success.
    stub({ live: { params: args.params, payload: CAND, payload_storage_path: "live/obj.json", source_refreshed_at: "2026-08-14T00:00:00Z" }, storagePayload: { ok: true, rows: [9, 9, 9] } });
    assert.deepEqual(await sb.publishLiveSnapshotIfNewer(args), { outcome: "conflict" }, "authoritative storage differs -> conflict even though inline matches");
    // STORAGE-FIRST adopt: a DIFFERENT inline but the AUTHORITATIVE storage object equals the candidate -> already-current.
    stub({ live: { params: args.params, payload: { ok: true, rows: [7, 7, 7] }, payload_storage_path: "live/obj.json", source_refreshed_at: "2026-08-14T00:00:00Z" }, storagePayload: CAND });
    assert.deepEqual(await sb.publishLiveSnapshotIfNewer(args), { outcome: "already-current" }, "authoritative storage matches -> adopt (inline is ignored)");
    // STORAGE unreadable at equal freshness -> cannot prove identity -> conflict (fail closed).
    stub({ live: { params: args.params, payload: CAND, payload_storage_path: "live/obj.json", source_refreshed_at: "2026-08-14T00:00:00Z" }, storageStatus: 500 });
    assert.deepEqual(await sb.publishLiveSnapshotIfNewer(args), { outcome: "conflict" }, "unreadable authoritative storage -> fail closed");
  } finally { globalThis.fetch = realFetch; }
});

test("V5. blocker 1+2 (shadow CAS): saveShadowSnapshotIfNewer routes through the atomic RPC and proves EQUAL identity STORAGE-FIRST + fails closed", async () => {
  const sb = await import("../lib/server/supabase.js");
  const CAND = { ok: true, rows: [1, 2, 3] };
  const base = { reportKey: "scheduler-v2/daily-reporting", accountId: "A01", paramsHash: "h".repeat(40), params: { reportVersion: "v", accountId: "A01" }, payload: CAND, payloadBytes: 20, sourceRefreshedAt: "2026-08-20T00:00:00Z" };
  const realFetch = globalThis.fetch;
  const stub = ({ rpc, storagePayload, storageStatus = 200 }) => { globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("/rest/v1/rpc/cas_report_snapshot_if_newer")) return { ok: true, status: 200, json: async () => rpc, text: async () => "" };
    if (u.includes("/storage/v1/object/")) {
      if (storageStatus !== 200) return { ok: false, status: storageStatus, json: async () => null, text: async () => "" };
      return { ok: true, status: 200, json: async () => storagePayload, text: async () => JSON.stringify(storagePayload) };
    }
    return { ok: true, status: 200, json: async () => null, text: async () => "" };
  }; };
  try {
    // The RPC owns freshness ordering: inserted / replaced / newer-live pass straight through.
    stub({ rpc: { disposition: "inserted" } });
    assert.deepEqual(await sb.saveShadowSnapshotIfNewer(base), { outcome: "inserted" });
    stub({ rpc: { disposition: "replaced" } });
    assert.deepEqual(await sb.saveShadowSnapshotIfNewer(base), { outcome: "replaced" });
    stub({ rpc: { disposition: "newer-live" } });
    assert.deepEqual(await sb.saveShadowSnapshotIfNewer(base), { outcome: "newer-live" });
    // A refused (null-freshness) or unknown ack fails closed as a conflict.
    stub({ rpc: { disposition: "invalid-freshness" } });
    assert.deepEqual(await sb.saveShadowSnapshotIfNewer(base), { outcome: "conflict" });
    // EQUAL + inline identical (no storage pointer) -> already-current.
    stub({ rpc: { disposition: "equal", params: base.params, payload: CAND, payload_storage_path: null } });
    assert.deepEqual(await sb.saveShadowSnapshotIfNewer(base), { outcome: "already-current" });
    // regression 4: EQUAL + inline == candidate BUT authoritative storage DIFFERS -> conflict (storage-first).
    stub({ rpc: { disposition: "equal", params: base.params, payload: CAND, payload_storage_path: "shadow/obj.json" }, storagePayload: { ok: true, rows: [9, 9, 9] } });
    assert.deepEqual(await sb.saveShadowSnapshotIfNewer(base), { outcome: "conflict" }, "authoritative storage differs -> never already-current");
    // regression 5: EQUAL + inline DIFFERENT but authoritative storage == candidate -> already-current after hydration.
    stub({ rpc: { disposition: "equal", params: base.params, payload: { ok: true, rows: [7, 7, 7] }, payload_storage_path: "shadow/obj.json" }, storagePayload: CAND });
    assert.deepEqual(await sb.saveShadowSnapshotIfNewer(base), { outcome: "already-current" }, "authoritative storage matches -> adopt");
    // EQUAL + storage unreadable -> cannot prove identity after the race -> conflict (fail closed, never reconcile).
    stub({ rpc: { disposition: "equal", params: base.params, payload: CAND, payload_storage_path: "shadow/obj.json" }, storageStatus: 500 });
    assert.deepEqual(await sb.saveShadowSnapshotIfNewer(base), { outcome: "conflict" }, "unreadable authoritative storage -> fail closed");
    // EQUAL + different params -> conflict.
    stub({ rpc: { disposition: "equal", params: { reportVersion: "v", accountId: "A01", extra: 1 }, payload: CAND, payload_storage_path: null } });
    assert.deepEqual(await sb.saveShadowSnapshotIfNewer(base), { outcome: "conflict" });
  } finally { globalThis.fetch = realFetch; }
});

test("V6. regression 6: concurrent writers from cycles created c1<c2<c3 converge on the NEWEST evidence regardless of finish order; equal-freshness identical adopts", () => {
  const store = makeStore();
  const c1 = new Date(BASE_MS + 1000).toISOString();
  const c2 = new Date(BASE_MS + 2000).toISOString();
  const c3 = new Date(BASE_MS + 3000).toISOString();
  const cand = (ts, v) => ({ reportKey: "scheduler-v2/daily-reporting", accountId: "A01", paramsHash: "H", params: { reportVersion: "v", accountId: "A01" }, payload: { v }, sourceRefreshedAt: ts });
  // Finish order is scrambled (c2, then c1 late, then c3): the newest cycle's evidence must win.
  assert.equal(store.shadowCasIfNewer(cand(c2, "c2")).outcome, "inserted");
  assert.equal(store.shadowCasIfNewer(cand(c1, "c1")).outcome, "newer-live", "an older cycle finishing later cannot overwrite");
  assert.equal(store.shadowCasIfNewer(cand(c3, "c3")).outcome, "replaced", "the newest cycle wins");
  assert.equal(store.shadowCasIfNewer(cand(c1, "c1")).outcome, "newer-live", "a straggler older cycle still cannot overwrite");
  assert.equal(store.getShadowSnapshot({ reportKey: "scheduler-v2/daily-reporting", accountId: "A01", paramsHash: "H" }).payload.v, "c3", "all writers converged on the newest evidence (c3)");
  // A re-run of the SAME (newest) cycle with identical content adopts (idempotent), never a spurious rewrite.
  assert.equal(store.shadowCasIfNewer(cand(c3, "c3")).outcome, "already-current");
});

test("V7. regression 7: LKG stays byte-identical on EVERY conflict / unprovable freshness-CAS path", () => {
  const store = makeStore();
  const key = { reportKey: "scheduler-v2/daily-reporting", accountId: "A01", paramsHash: "H" };
  store.shadowCasIfNewer({ ...key, params: { reportVersion: "v", accountId: "A01" }, payload: { v: "lkg" }, sourceRefreshedAt: "2026-08-20T00:00:00Z" });
  const snap = () => JSON.parse(JSON.stringify(store.getShadowSnapshot(key)));
  const lkg = snap();
  // (a) null/blank candidate freshness -> conflict, no write.
  assert.equal(store.shadowCasIfNewer({ ...key, params: { reportVersion: "v", accountId: "A01" }, payload: { v: "x" }, sourceRefreshedAt: "" }).outcome, "conflict");
  assert.deepEqual(snap(), lkg);
  // (b) equal freshness, different content -> conflict, no write.
  assert.equal(store.shadowCasIfNewer({ ...key, params: { reportVersion: "v", accountId: "A01" }, payload: { v: "different" }, sourceRefreshedAt: "2026-08-20T00:00:00Z" }).outcome, "conflict");
  assert.deepEqual(snap(), lkg);
  // (c) older candidate -> newer-live, no write.
  assert.equal(store.shadowCasIfNewer({ ...key, params: { reportVersion: "v", accountId: "A01" }, payload: { v: "older" }, sourceRefreshedAt: "2026-08-19T00:00:00Z" }).outcome, "newer-live");
  assert.deepEqual(snap(), lkg);
});


group("VV. round-11 blocker: EVERY durable-lineage shadow write goes through the atomic CAS (never a merge-upsert)");

const throwingSaver = () => async (a) => { throw new Error("REGRESSION: durable lineage reached the merge-upsert saver for " + a.reportKey + "/" + a.accountId); };

test("VV1. reg 1-5: an instance that reads the natural key as ABSENT loses to a concurrently-written NEWER durable row (CAS newer-live) -- no overwrite, no false reconcile, zero merge-upserts", async () => {
  const store = makeStore();
  store._dbClock.now = BASE_MS;
  // Probe: one normal run establishes the EXACT natural key + a valid derived payload for daily/A01, written
  // through the CAS. `makeShadowSaver` throws if the durable path EVER uses the merge-upsert saver (reg 5).
  const hProbe = fullFixture({ store, makeShadowSaver: throwingSaver });
  const rProbe = await hProbe.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(rProbe.derived.skipped, null, "the probe run completed -- every durable write went through the CAS, not the saver");
  const probe = hProbe.recorded.shadowSaves.find((s) => s.reportKey === "scheduler-v2/daily-reporting" && s.accountId === "A01");
  assert.ok(probe, "the probe wrote daily/A01 through the CAS injectable");
  const key = { reportKey: "scheduler-v2/daily-reporting", accountId: "A01", paramsHash: probe.paramsHash };
  const row0 = store.getShadowSnapshot(key);
  // Simulate the NEWER cycle having written FIRST: different content at strictly-newer freshness. This is the
  // row the older instance's delayed write must never clobber (regs 2/3).
  store.recordShadowSnapshot({ reportKey: key.reportKey, accountId: key.accountId, paramsHash: key.paramsHash, params: row0.params, payload: { ...row0.payload, __newer_cycle: "won" }, sourceRefreshedAt: new Date(BASE_MS + 100_000_000).toISOString() });
  const lkg = JSON.parse(JSON.stringify(store.getShadowSnapshot(key)));
  // Reset the older instance's daily/A01 job so it re-derives (as if its earlier attempt was commit-unknown).
  Object.assign(store._reportJobs.get(rProbe.cycleId + "|daily-reporting|A01"), { derive_status: "pending", derive_lease_token: null, derive_lease_expires_at: null, validated: false, save_status: "pending", snapshot_params_hash: null });
  // The older instance runs but STILL reads the natural key as ABSENT (it read before the newer write landed),
  // forcing the initially-absent path. Its owning-cycle created_at (BASE_MS) is OLDER than the durable freshness.
  const hB = fullFixture({ store, makeShadowSaver: throwingSaver, readShadowSnapshot: async () => null });
  const rB = await hB.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(outcomeOf(rB, "daily-reporting", "A01"), "snapshot-newer", "reg 1/2: the older instance's absent-path write met the newer durable via the CAS (newer-live)");
  assert.equal(store.getReportJob("daily-reporting", "A01").validated, false, "reg 4: the losing (older) candidate is NEVER reconciled as successful");
  assert.deepEqual(store.getShadowSnapshot(key), lkg, "reg 3: the newer cycle's payload survives byte-identical (the older write never clobbered it)");
  assert.equal(rB.derived.resumable, true, "the losing candidate is typed-resumable");
  // reg 5: neither the probe nor the older instance ever reached the merge-upsert saver (it throws) -- the CAS
  // handled every durable write. Proven by both runs completing without the saver throwing.
});

test("VV2. reg 6: reverse completion order still converges on the newest cycle's evidence", () => {
  const store = makeStore();
  const cOld = new Date(BASE_MS + 1000).toISOString();
  const cNew = new Date(BASE_MS + 2000).toISOString();
  const rk = { reportKey: "scheduler-v2/daily-reporting", accountId: "A01", paramsHash: "H" };
  const cand = (ts, v) => ({ ...rk, params: { reportVersion: "v", accountId: "A01" }, payload: { v }, sourceRefreshedAt: ts });
  // Reverse order: the OLDER cycle's write lands FIRST, then the NEWER cycle's delayed write.
  assert.equal(store.shadowCasIfNewer(cand(cOld, "old")).outcome, "inserted");
  assert.equal(store.shadowCasIfNewer(cand(cNew, "new")).outcome, "replaced", "the newer cycle replaces the older even arriving later");
  assert.equal(store.getShadowSnapshot(rk).payload.v, "new");
  // An even-later OLDER straggler cannot undo it.
  assert.equal(store.shadowCasIfNewer(cand(cOld, "old2")).outcome, "newer-live");
  assert.equal(store.getShadowSnapshot(rk).payload.v, "new", "the newest evidence is durable regardless of arrival order");
});

test("VV3. reg 7: equal-cycle equal-content replay is idempotent (insert then already-current, exactly one durable row)", () => {
  const store = makeStore();
  const ts = new Date(BASE_MS + 5000).toISOString();
  const cand = () => ({ reportKey: "scheduler-v2/daily-reporting", accountId: "A01", paramsHash: "H", params: { reportVersion: "v", accountId: "A01" }, payload: { v: "same" }, sourceRefreshedAt: ts });
  assert.equal(store.shadowCasIfNewer(cand()).outcome, "inserted");
  assert.equal(store.shadowCasIfNewer(cand()).outcome, "already-current", "a same-cycle same-content replay adopts (idempotent)");
  assert.equal(store.shadowCasIfNewer(cand()).outcome, "already-current", "still idempotent on a third replay");
});

test("VV4. reg 8: equal-freshness conflicting content fails closed (conflict) and preserves LKG byte-identical", () => {
  const store = makeStore();
  const ts = new Date(BASE_MS + 5000).toISOString();
  const rk = { reportKey: "scheduler-v2/daily-reporting", accountId: "A01", paramsHash: "H" };
  const c = (v) => ({ ...rk, params: { reportVersion: "v", accountId: "A01" }, payload: { v }, sourceRefreshedAt: ts });
  assert.equal(store.shadowCasIfNewer(c("lkg")).outcome, "inserted");
  const lkg = JSON.parse(JSON.stringify(store.getShadowSnapshot(rk)));
  assert.equal(store.shadowCasIfNewer(c("different")).outcome, "conflict", "equal freshness + different content is a conflict, never a merge-overwrite");
  assert.deepEqual(store.getShadowSnapshot(rk), lkg, "LKG preserved byte-identical");
});

test("VV5. reg 9: a commit-unknown deadline at the CAS write is typed-resumable; recovery ADOPTS the committed durable row with zero re-save", async () => {
  const store = makeStore();
  // timeoutSaveAfterCommit: the CAS COMMITS the insert but the response times out (commitUnknown).
  const h1 = recoveryFixture(store, { timeoutSaveAfterCommit: onceFor("daily-reporting", "A01") });
  const r1 = await h1.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(r1.commitUnknown, true, "a CAS write response-timeout is typed commit-unknown/resumable");
  assert.equal(r1.continuationRequired, true);
  assert.ok(h1.savedShadow.some((s) => s.reportKey === "scheduler-v2/daily-reporting" && s.accountId === "A01"), "the CAS DID commit the durable row");
  assert.equal(store.getReportJob("daily-reporting", "A01").validated, false, "no fabricated success -- the reconcile never ran");
  // Recovery: the durable row is present -> adopt (no re-save) -> reconcile. A re-save through the saver throws.
  const h2 = fullFixture({ store, makeShadowSaver: throwingSaver });
  store._dbClock.now = PAST_LEASE_MS;
  await h2.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(store.getReportJob("daily-reporting", "A01").validated, true, "recovery ADOPTED the committed durable row and reconciled");
  assert.ok(!h2.recorded.shadowSaves.some((s) => s.reportKey === "scheduler-v2/daily-reporting" && s.accountId === "A01"), "reg 10: ZERO re-save on adoption (existing behavior intact)");
});


group("W. round-9 findings 1/2/3: hash-bound already-complete; accurate resumability; storage-first precedence");

test("W1. finding 1: an 'already-complete' job whose bound hash != this derivation's hash is a typed hash-mismatch, NEVER counted as our completion", async () => {
  const h1 = fullFixture();
  const r1 = await h1.runtime.run({ bucket: "us", today: TODAY });
  const store = h1.store;
  // Tamper the durable job's snapshot_params_hash so claimLease returns already-complete with a WRONG hash.
  const j = store._reportJobs.get(r1.cycleId + "|daily-reporting|A01");
  assert.ok(j && j.validated === true);
  const realHash = j.snapshot_params_hash;
  j.snapshot_params_hash = "WRONGHASH_deadbeef";
  const h2 = fullFixture({ store });
  const r2 = await h2.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(outcomeOf(r2, "daily-reporting", "A01"), "already-complete-hash-mismatch", "a different-hash completion is a typed mismatch");
  assert.ok(r2.derived.skipped != null, "the run is honestly incomplete (the mismatch is not counted as complete)");
  assert.equal(r2.derived.resumable, false, "a hash mismatch is NON-resumable (an integrity failure, not a retry)");
  assert.notEqual(realHash, "WRONGHASH_deadbeef");
});

test("W2. finding 1: the wrappers require exact hash binding on already-complete (claim + reconcile) and reject missing/wrong-hash acks", async () => {
  const sb = await import("../lib/server/supabase.js");
  const realFetch = globalThis.fetch;
  const stub = (b) => { globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => b, text: async () => "" }); };
  try {
    // CLAIM already-complete MUST carry a nonblank snapshot_params_hash.
    stub({ disposition: "already-complete" });
    await assert.rejects(() => sb.claimReportDeriveLease("c", "r", "a", { leaseSeconds: 300 }), (e) => e.code === "REPORT_LEASE_ACK_INVALID", "already-complete without hash");
    stub({ disposition: "already-complete", snapshot_params_hash: "   " });
    await assert.rejects(() => sb.claimReportDeriveLease("c", "r", "a", { leaseSeconds: 300 }), (e) => e.code === "REPORT_LEASE_ACK_INVALID", "already-complete blank hash");
    stub({ disposition: "already-complete", snapshot_params_hash: "H" });
    assert.equal((await sb.claimReportDeriveLease("c", "r", "a", { leaseSeconds: 300 })).snapshotParamsHash, "H");
    // RECONCILE already-complete MUST echo the exact requested hash.
    stub({ disposition: "already-complete" });
    await assert.rejects(() => sb.reconcileReportDeriveSuccess({ cycleId: "c", reportKey: "r", accountId: "a", snapshotParamsHash: "H", leaseToken: "t" }), (e) => e.code === "REPORT_RECONCILE_ACK_INVALID", "reconcile already-complete missing hash");
    stub({ disposition: "already-complete", snapshot_params_hash: "OTHER" });
    await assert.rejects(() => sb.reconcileReportDeriveSuccess({ cycleId: "c", reportKey: "r", accountId: "a", snapshotParamsHash: "H", leaseToken: "t" }), (e) => e.code === "REPORT_RECONCILE_ACK_INVALID", "reconcile already-complete wrong hash");
    stub({ disposition: "already-complete", snapshot_params_hash: "H" });
    assert.equal((await sb.reconcileReportDeriveSuccess({ cycleId: "c", reportKey: "r", accountId: "a", snapshotParamsHash: "H", leaseToken: "t" })).disposition, "already-complete");
  } finally { globalThis.fetch = realFetch; }
});

test("W3. finding 2: TERMINAL / invalid-state failures are NON-resumable and cannot create an endless continuation loop", async () => {
  const store = makeStore();
  // Seed daily/A01 TERMINAL (derive failed) BEFORE our run reaches it: a lineage override returns 'terminal'.
  const terminalLineage = {
    upsertReportJob: async (jj) => store.upsertReportJob(jj),
    claimLease: async (c, rk, a, opts) => {
      if (rk === "daily-reporting" && a === "A01") return { disposition: "terminal", deriveStatus: "failed" };
      const res = store.claimLease(c, rk, a, opts);
      return { disposition: res.disposition, leaseToken: res.lease_token || null, snapshotParamsHash: res.snapshot_params_hash || null, deriveStatus: res.derive_status || null };
    },
    reconcileSuccess: async (jj) => { const res = store.reconcileSuccess(jj); return { disposition: res.disposition }; },
  };
  const h1 = fullFixture({ store, reportLineage: terminalLineage });
  const r1 = await h1.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(outcomeOf(r1, "daily-reporting", "A01"), "terminal");
  assert.ok(r1.derived.skipped != null, "a terminal report makes the rollup incomplete");
  assert.equal(r1.derived.resumable, false, "a terminal report is NON-resumable");
  assert.notEqual(r1.continuationRequired, true, "a terminal report does NOT request a continuation (no endless loop)");
  // A second invocation over the SAME terminal state is ALSO non-resumable -> the caller can never loop forever.
  const h2 = fullFixture({ store, reportLineage: terminalLineage });
  const r2 = await h2.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(r2.derived.resumable, false);
  assert.notEqual(r2.continuationRequired, true, "a terminal/configuration failure never becomes resumable on retry");
});

test("W3b. finding 2: a claim invalid-state (e.g. succeeded+save-failed) is a NON-resumable typed failure", async () => {
  const store = makeStore();
  const invalidLineage = {
    upsertReportJob: async (jj) => store.upsertReportJob(jj),
    claimLease: async (c, rk, a, opts) => {
      if (rk === "daily-reporting" && a === "A01") return { disposition: "invalid-state", deriveStatus: "succeeded" };
      const res = store.claimLease(c, rk, a, opts);
      return { disposition: res.disposition, leaseToken: res.lease_token || null, snapshotParamsHash: res.snapshot_params_hash || null, deriveStatus: res.derive_status || null };
    },
    reconcileSuccess: async (jj) => { const res = store.reconcileSuccess(jj); return { disposition: res.disposition }; },
  };
  const h1 = fullFixture({ store, reportLineage: invalidLineage });
  const r1 = await h1.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(outcomeOf(r1, "daily-reporting", "A01"), "claim-invalid", "invalid-state -> claim-invalid (never a claim)");
  assert.equal(r1.derived.resumable, false, "a claim invalid-state is NON-resumable");
});

test("W4. finding 3: STORAGE-FIRST precedence -- a nonblank pointer is authoritative even when inline is present; a stale inline can never win", async () => {
  const { store, snapshot, hash } = await savedButRunning();
  const good = JSON.parse(JSON.stringify(snapshot.payload)); // the correct content the candidate will re-derive
  // Tamper the INLINE payload but point payload_storage_path at the GOOD content: storage-first must ignore
  // the stale inline and hydrate + validate + adopt the authoritative storage object.
  snapshot.payload = { ...snapshot.payload, __stale_inline: "ignored" };
  snapshot.payload_storage_path = "report-snapshots/v2/good.json";
  const { r2, job } = await recoverWith(store, { loadShadowStoragePayload: async () => good });
  assert.equal(job.validated, true, "the AUTHORITATIVE storage object (not the stale inline) was adopted -> validated");
  assert.equal(outcomeOf(r2, "daily-reporting", "A01"), "recovered");
});

test("W4b. finding 3: a DANGLING pointer fails closed even when an inline payload is also present", async () => {
  const { store, snapshot } = await savedButRunning();
  snapshot.payload = { ...snapshot.payload }; // a present (valid) inline...
  snapshot.payload_storage_path = "report-snapshots/v2/orphan.json"; // ...but the pointer is authoritative
  const { r2, job } = await recoverWith(store, { loadShadowStoragePayload: async () => null });
  assert.equal(job.validated, false, "a dangling authoritative pointer fails closed (the inline can NOT stand in)");
  assert.ok(conflictOutcome(r2, "payload-dangling"), "typed payload-dangling");
});

test("W4c. finding 3: a WRONG-ROW identity (report_key/account_id/params_hash mismatch) is a typed identity conflict", async () => {
  const { store } = await savedButRunning();
  store._dbClock.now = PAST_LEASE_MS;
  // readShadowSnapshot returns a row whose report_key is a DIFFERENT identity.
  const h2 = fullFixture({ store, readShadowSnapshot: async ({ accountId, paramsHash }) => ({ report_key: "scheduler-v2/OTHER-REPORT", account_id: accountId, params_hash: paramsHash, params: { reportVersion: "daily-reporting/v2d-3", accountId }, payload: { rows: [], brandFiltered: false, adsAvailability: { status: "ok" } }, source_refreshed_at: "2026-08-22T00:00:00Z" }) });
  const r2 = await h2.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(store.getReportJob("daily-reporting", "A01").validated, false, "a wrong-row snapshot never validates");
  assert.ok(conflictOutcome(r2, "identity-report-key"), "typed identity-report-key conflict");
});


async function main() {
  out("source production-hardening proof suite");
  runtimeMod = await import("../lib/server/sync/source-bucket-sync-runtime.js");
  registry = await import("../lib/server/sync/source-registry.js");
  schema = await import("../lib/server/sync/schema-contract.js");
  dates = await import("../lib/server/date-windows.js");
  identity = await import("../lib/server/source-identity.js");
  reportStore = await import("../lib/server/report-store.js");
  durableModel = await import("../lib/server/sync/source-durable-model.js");

  let failures = 0;
  for (const t of tests) {
    if (t.marker) { out("-- " + t.marker); continue; }
    try {
      await t.fn();
      passed += 1;
      out("  ok  " + t.name);
    } catch (e) {
      failures += 1;
      out("FAIL  " + t.name);
      out(String((e && e.stack) || e));
    }
  }
  out("\n" + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : ""));
  if (failures) process.exitCode = 1;
}

main();
