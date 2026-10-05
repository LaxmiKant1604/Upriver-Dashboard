// The daily Returns (FBA & FBM)-ONLY region runner (lib/server/sync/returns-event-runner.js) -- EXECUTABLE offline proof
// with FULLY INJECTED fakes: no network (every fetch is refused), no database (an in-memory store emulates the 20260942
// RPC contract: lease, create slots, replace / count / confirm / failure, account state, 'returns' coverage). Covers:
//   A the initial 60-day load of a new account (state none -> loaded -> complete), the rolling 14-day replace, a new
//     account joining automatically, per-account state isolation, a duplicate same-day run (skipped-current, zero creates),
//     the plan RE-READ under the run lease, a 'loaded' state with nothing to confirm re-loaded (never stuck);
//   B a capped export (bisection + reassembly; never persisted at the cap) and a single day at the cap (fail closed);
//   C provider loading notice (split on a multi-seller batch; single seller = history-loading), data-source issue, missing
//     rowCount, length mismatch: nothing persisted, last-known-good untouched; an omitted NULLABLE column is null; a
//     shape / row-outside-window / data-source page rejection on a multi-seller batch splits it;
//   D failed staging (RPC raise -> LKG + failure recorded), confirm mismatch, independent read-back mismatch (confirm still
//     runs, no failure write) / unreadable, a crash between replace and confirm (zero-token re-verify next run), an UNKNOWN
//     replace outcome (no state write);
//   E completed-export reuse at zero tokens, the slot ceiling (budget-deferred), the token reserve, the GET-only retry and
//     its run deadline;
//   F one invalid account isolated while batch-mates persist, a rejected multi-seller create split / isolated, an
//     ambiguous create reconciled adopt-only (and left incomplete without the listing);
//   G identity-ambiguous account persisted + held (and a held leftover of a crash re-verified at zero tokens), a coverage
//     gap reported, the lease held -> typed skip, schema drift, dry-run (zero creates / listing / writes), the guarded
//     create body, the rate-limited fetch (spacing, AbortSignal, bounded GET-only 429 retry);
//   H OUTPUT CONTRACT: fixtures full of order ids / LPNs / RMAs / FNSKUs / SKUs / full seller ids never reach the logs,
//     the RESULT payload, the step summary, the status rows, the failure details or the identity detail.
// The suite exits 0 ONLY after every test ran and passed (a never-settling test can no longer drain the loop to exit 0).
// The real transport + real supabase.js wrappers + the CLI are proven in scripts/returns-only-exports.test.js.
// 7-bit ASCII, LF, no top-level await inside test bodies.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = process.env[SB_KEY_ENV] || ["test", "svc", "role", "key"].join("-");
process.env.DATADOE_API_KEY = process.env.DATADOE_API_KEY || ["dd", "test"].join("_");
// ZERO network: any real fetch is a test failure.
let networkAttempts = 0;
globalThis.fetch = async (u) => { networkAttempts += 1; throw new Error("NETWORK REFUSED IN TEST: " + String(u).slice(0, 40)); };

const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
let passed = 0; const tests = []; const test = (name, fn) => tests.push({ name, fn });

const R = await import("../lib/server/sync/returns-event-runner.js");
const CORE = await import("../lib/server/sync/returns-event-source.js");
const AS = await import("../lib/server/ads-sync.js");
const { organizationFingerprint } = await import("../lib/server/source-identity.js");
const SRC = await import("../lib/server/reports/sources.js");

const NOW = "2026-10-04T12:00:00.000Z";
const ASOF = "2026-10-03";
const INITIAL = { from: "2026-08-05", to: "2026-10-03" };   // [D1-59, D1]
const ROLLING = { from: "2026-09-20", to: "2026-10-03" };   // [D1-13, D1]
const KEY = ["prim", "key"].join("-");
const CONNS = [{ id: "primary", apiKey: KEY, accountPrefix: "" }];
const ORG = organizationFingerprint(KEY);
const id = (n) => "a" + String(n).padStart(7, "0") + "-0000-4000-8000-" + String(n).padStart(12, "0");
const SPEC_OK = { sources: [{ id: SRC.RETURNS.id, isPremium: false, columns: CORE.RETURNS_EVENT_COLUMNS.map((name) => ({ name })) }] };
const RETURNS_NAMES = new Set(["returns (fba & fbm)", "settlements"]);

// ---- synthetic rows: every sensitive value carries a SECRET marker the redaction check hunts for ----
let rowSeq = 0;
const SENSITIVE = new Set();
const mark = (v) => { SENSITIVE.add(v); return v; };
function fba(seller, mkt, date, over = {}) {
  const k = ++rowSeq;
  return {
    seller_or_vendor_id: seller, marketplace_country_code: mkt, date, order_date: null, sku: mark("SKU-SECRET-" + k), child_asin: "B0TESTASN" + (k % 10),
    fnsku: mark("X00SECRETFN" + k), amazon_order_id: mark("406-SECRET-ORDER-" + k), quantity: 1, amazon_return_reason: "DEFECTIVE",
    amazon_fulfillment_channel: "FBA", amazon_return_request_status: "Unit returned to inventory", amazon_return_detailed_disposition: "SELLABLE",
    amazon_return_rmaid: null, amazon_return_seller_rmaid: null, amazon_return_label_to_be_paid_by: null, amazon_return_refunded_amount: null,
    amazon_return_label_cost: null, cogs_item_value: "4.50", cogs_shipping_value: "0.50", cogs_total_value: "5.00", cogs_currency: "EUR", cogs_present: true,
    amazon_license_plate_number: mark("LPNSECRET" + k), ...over,
  };
}
function fbm(seller, mkt, date, over = {}) {
  const k = ++rowSeq;
  return {
    seller_or_vendor_id: seller, marketplace_country_code: mkt, date, order_date: "2026-08-01", sku: mark("SKU-SECRET-" + k), child_asin: "B0TESTASN" + (k % 10),
    fnsku: null, amazon_order_id: mark("171-SECRET-ORDER-" + k), quantity: 2, amazon_return_reason: "NO_LONGER_NEEDED",
    amazon_fulfillment_channel: "FBM", amazon_return_request_status: "Approved", amazon_return_detailed_disposition: null,
    amazon_return_rmaid: mark("RMASECRET" + k), amazon_return_seller_rmaid: mark("SRMASECRET" + k), amazon_return_label_to_be_paid_by: "Seller",
    amazon_return_refunded_amount: "12.50", amazon_return_label_cost: "3.10", cogs_item_value: null, cogs_shipping_value: null, cogs_total_value: null,
    cogs_currency: null, cogs_present: false, amazon_license_plate_number: "", ...over,
  };
}
const addDays = (day, n) => { const x = new Date(day + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const rpcError = (fn, code) => Object.assign(new Error(fn + ": " + code), { status: 400, code: "P0001", returnsCode: code });

// ---------------------------------------------------------------------------------------------------------------------
// The world: provider double + in-memory store emulating the RPC contract. One per test (or shared across "runs").
// ---------------------------------------------------------------------------------------------------------------------
function world(opts = {}) {
  const accounts = opts.accounts || [{ id: id(1), country: "IN" }];
  const dataset = opts.dataset || {};                      // seller -> raw rows the provider "has"
  const states = new Map(Object.entries(opts.states || {}).map(([a, s]) => [a, { account_id: a, ...s }]));
  const coverage = new Map(Object.entries(opts.coverage || {}).map(([a, ws]) => [a, ws.map((w) => ({ ...w }))]));
  const events = new Map(Object.entries(opts.events || {}).map(([a, es]) => [a, es.map((e) => ({ ...e }))]));
  const calls = { creates: [], downloads: [], slots: [], balances: 0, replaces: [], counts: [], confirms: [], failures: [], status: [], leases: [], renews: 0, releases: [], listings: 0, stateLog: [], logs: [] };
  const exportsMeta = new Map();
  const replacedIdentity = new Map();                      // account -> the identity status its last replace logged (1.7)
  let seq = 0;
  const slotCount = new Map(Object.entries(opts.slotsUsed || {}));
  let lease = null; let leaseGen = 41;
  let balance = opts.balance == null ? 1000 : opts.balance;
  const page = (rows) => ({ status: "COMPLETED", rowCount: rows.length, rows, loadingNotice: null, dataSourceIssues: [] });
  const rowsFor = opts.rowsFor || (({ ids, from, to }) => ids.flatMap((s) => (dataset[s] || []).filter((r) => r.date >= from && r.date <= to)));
  const snap = (a, at) => { const s = states.get(a); calls.stateLog.push({ accountId: a, at, initial_status: s && s.initial_status, last_status: s && s.last_status }); };
  const inWin = (e, from, to) => e.return_date >= from && e.return_date <= to;
  const leaseOk = (p) => lease && p.ownerToken === lease.owner && p.generation === lease.generation;
  // [from,to] removed from the account's coverage (the remaining parts of a merged window are kept)
  const removeCoverage = (a, from, to) => {
    const keep = [];
    for (const w of coverage.get(a) || []) {
      if (w.to < from || w.from > to) { keep.push(w); continue; }
      if (w.from < from) keep.push({ from: w.from, to: addDays(from, -1) });
      if (w.to > to) keep.push({ from: addDays(to, 1), to: w.to });
    }
    coverage.set(a, keep);
  };
  // ONE merged window over every saved window that overlaps or touches [from,to] (the compacted coverage of DESIGN 1.6h)
  const addCoverage = (a, from, to) => {
    let nf = from; let nt = to; const keep = [];
    for (const w of coverage.get(a) || []) {
      if (addDays(w.to, 1) >= nf && w.from <= addDays(nt, 1)) { if (w.from < nf) nf = w.from; if (w.to > nt) nt = w.to; } else keep.push(w);
    }
    keep.push({ from: nf, to: nt });
    coverage.set(a, keep.sort((x, y) => (x.from < y.from ? -1 : 1)));
  };
  const deps = {
    getConnections: () => CONNS,
    fetchAccounts: async () => accounts,
    readReturnsSpec: async () => R.checkReturnsSpec(opts.spec || SPEC_OK),
    fetchCompatibleSourceNames: async (_k, acct) => {
      if ((opts.sourcesUnreadable || []).includes(acct)) throw new Error("sources 503");
      return (opts.incompatible || []).includes(acct) ? new Set(["settlements"]) : RETURNS_NAMES;
    },
    getReturnsAccountStates: async ({ organizationFingerprint: org, accountIds }) => {
      assert.equal(org, ORG);
      if (opts.statesRead) return opts.statesRead;
      return { read: "ok", rows: accountIds.filter((a) => states.has(a)).map((a) => ({ ...states.get(a) })) };
    },
    getSourceCoverageWindows: async ({ accountId, sourceKey }) => {
      assert.equal(sourceKey, "returns");
      if ((opts.coverageUnreadable || []).includes(accountId)) return { windows: [], read: "read-failed", error: "SOURCE_COVERAGE_READ_FAILED" };
      return { windows: (coverage.get(accountId) || []).map((w) => ({ ...w, updatedAt: NOW })), read: "ok", error: null };
    },
    acquireReturnsRunLease: async (p) => {
      calls.leases.push({ region: p.region, ttlSeconds: p.ttlSeconds });
      if (opts.leaseHeld) return { granted: false, holderRunKey: "returns-events/other", expiresAt: "2026-10-04T12:10:00Z" };
      leaseGen += 1; lease = { owner: p.ownerToken, generation: leaseGen };
      return { granted: true, generation: leaseGen, expiresAt: "2026-10-04T12:15:00Z" };
    },
    renewReturnsRunLease: async (p) => {
      calls.renews += 1;
      if (opts.renewFailsAfter != null && calls.renews > opts.renewFailsAfter) return { renewed: false };
      return { renewed: leaseOk(p) };
    },
    releaseReturnsRunLease: async (p) => { calls.releases.push(p.generation); if (leaseOk(p)) lease = null; return { released: true }; },
    claimReturnsCreateSlot: async (p) => {
      if (!leaseOk(p)) throw rpcError("claim_returns_create_slot", "RETURNS_LEASE_LOST");
      assert.ok(/^[0-9a-f]{64}$/.test(p.requestHash), "slot claim carries the 64-hex request hash");
      const k = p.region + "|" + p.asOf;
      const claimed = slotCount.get(k) || 0;
      calls.slots.push({ region: p.region, asOf: p.asOf, max: p.maxCreates, granted: claimed < p.maxCreates });
      if (claimed >= p.maxCreates) return { granted: false, claimed, max: p.maxCreates };
      slotCount.set(k, claimed + 1);
      return { granted: true, claimed: claimed + 1, max: p.maxCreates };
    },
    getDataDoeTokenBalance: async () => { calls.balances += 1; return opts.balanceUnreadable ? { read: "error", usable: null } : { read: "ok", usable: balance }; },
    createExport: async (_k, source, ids, from, to, skip = 0) => {
      const n = ++seq;
      if (opts.createThrows) { const e = opts.createThrows({ ids, from, to, n, register: () => { const x = "exp-landed-" + n + "-0000"; exportsMeta.set(x, { ids: [...ids], from, to, body: AS.buildAdsExportRequestBody(source, ids, from, to, skip) }); return x; } }); if (e) throw e; }
      if (opts.createHangs && opts.createHangs({ n })) return new Promise(() => {});
      const exportId = "exp-" + String(n).padStart(4, "0") + "-cafe-0000-0000-000000000000";
      const body = AS.buildAdsExportRequestBody(source, ids, from, to, skip);
      calls.creates.push({ sourceId: source.sourceId, ids: [...ids], from, to, body });
      exportsMeta.set(exportId, { ids: [...ids], from, to, body });
      balance -= 2;
      return { exportId };
    },
    downloadExport: async (_k, exportId) => {
      calls.downloads.push(exportId);
      const m = exportsMeta.get(exportId) || (opts.listed || []).map((x) => ({ x, m: { ids: x.sellerOrVendorIds, from: String(x.from).slice(0, 10), to: String(x.to).slice(0, 10) } })).find((y) => y.x.id === exportId)?.m;
      if (!m) throw new Error("unknown export");
      if (opts.downloadThrows && opts.downloadThrows({ exportId, attempt: calls.downloads.filter((d) => d === exportId).length })) throw new Error("DataDoe export download failed (502).");
      const p = rowsFor({ ids: m.ids, from: m.from, to: m.to });
      return Array.isArray(p) ? page(p) : p;
    },
    listRecentExports: async () => {
      calls.listings += 1;
      const landed = [...exportsMeta.entries()].filter(([x]) => x.startsWith("exp-landed-")).map(([x, m]) => ({ id: x, status: "COMPLETED", createdAt: "2026-10-04T11:59:00Z", expiresAt: "2026-10-05T11:59:00Z", ...m.body }));
      return [...(opts.listed || []), ...landed];
    },
    replaceReturnsEventsWindow: async (p) => {
      calls.replaces.push(p);
      if (!leaseOk(p)) throw rpcError("replace_returns_events_window", "RETURNS_LEASE_LOST");
      if (opts.replaceThrows) { const code = opts.replaceThrows(p); if (code) throw rpcError("replace_returns_events_window", code); }
      if (opts.replaceRawError) { const e = opts.replaceRawError(p); if (e) throw e; }  // a wrapper error that never reached / left the RPC
      const a = p.accountId;
      assert.equal(p.organizationFingerprint, ORG); assert.equal(p.connectionId, "primary"); assert.equal(p.sellerOrVendorId, a);
      assert.equal(p.attribution, "as-delivered");
      const st = states.get(a) || { account_id: a, initial_status: "pending", legacy_fence: true, identity_status: "clear", hold_reason: null };
      if (p.mode === "rolling" && st.initial_status !== "complete") throw rpcError("replace_returns_events_window", "RETURNS_ROLLING_REQUIRES_COMPLETE");
      if (p.events.length !== p.expectedCount) throw rpcError("replace_returns_events_window", "RETURNS_COUNT_MISMATCH");
      const units = p.events.reduce((t, e) => t + (e.quantity == null ? 0 : e.quantity), 0);
      if (units !== p.expectedUnits) throw rpcError("replace_returns_events_window", "RETURNS_UNITS_MISMATCH");
      for (const e of p.events) {
        if (!p.requestHashes.includes(e.source_request_hash)) throw rpcError("replace_returns_events_window", "RETURNS_EVENT_HASH_UNKNOWN");
        if (e.export_id != null && !p.exportIds.includes(e.export_id)) throw rpcError("replace_returns_events_window", "RETURNS_EVENT_EXPORT_UNKNOWN");
        if (!inWin(e, p.from, p.to) || e.seller_or_vendor_id !== p.sellerOrVendorId || e.marketplace_country_code !== p.marketplace) throw rpcError("replace_returns_events_window", "RETURNS_EVENT_INVALID");
        if ("order_owner" in e) throw rpcError("replace_returns_events_window", "RETURNS_EVENT_INVALID");
      }
      if (CORE.assessIdentity(p.events).status === "ambiguous" && p.identityStatus === "clear") throw rpcError("replace_returns_events_window", "RETURNS_IDENTITY_MISMATCH");
      const old = (events.get(a) || []).filter((e) => inWin(e, p.from, p.to));
      if (p.expectedCount === 0 && old.length && !p.allowShrink) throw rpcError("replace_returns_events_window", "RETURNS_ACCOUNT_SUDDEN_EMPTY");
      events.set(a, [...(events.get(a) || []).filter((e) => !inWin(e, p.from, p.to)), ...p.events.map((e) => ({ ...e }))]);
      addCoverage(a, p.from, p.to);
      const ns = { ...st, marketplace_country_code: p.marketplace, last_mode: p.mode, last_window_from: p.from, last_window_to: p.to, last_status: "replaced",
        last_event_count: p.expectedCount, last_unit_sum: p.expectedUnits, last_request_hashes: [...p.requestHashes], last_export_ids: [...p.exportIds],
        last_run_key: p.runKey, last_region: p.region, identity_status: p.identityStatus, identity_detail: p.identityDetail,
        hold_reason: p.identityStatus === "ambiguous" ? "RETURNS_IDENTITY_AMBIGUOUS" : st.hold_reason };
      if (p.mode === "initial") Object.assign(ns, { initial_status: "loaded", initial_window_from: p.from, initial_window_to: p.to });
      states.set(a, ns); snap(a, "replace"); replacedIdentity.set(a, p.identityStatus);
      // COMMITTED, then the response is lost (transport): the caller cannot know the outcome
      if (opts.replaceLosesResponse && opts.replaceLosesResponse(p)) throw Object.assign(new Error("replace_returns_events_window failed: TRANSPORT"), { name: "ReturnsRpcError", status: null, code: null, returnsCode: null });
      return { eventsDeleted: old.length, eventsInserted: p.events.length, initialStatus: ns.initial_status };
    },
    countReturnsEventsWindow: async (p) => {
      calls.counts.push(p.accountId);
      if (opts.countFails && opts.countFails(p)) return { read: "error" };
      const n = (events.get(p.accountId) || []).filter((e) => inWin(e, p.from, p.to)).length;
      return { read: "ok", count: opts.countSkew ? n + opts.countSkew : n };
    },
    confirmReturnsEventsWindow: async (p) => {
      calls.confirms.push(p);
      if (opts.confirmThrows && opts.confirmThrows(p)) throw new Error("connection reset");
      const st = states.get(p.accountId);
      if (!st || st.last_status !== "replaced" || st.last_window_from !== p.from || st.last_window_to !== p.to || JSON.stringify(st.last_request_hashes) !== JSON.stringify(p.requestHashes)) return { verified: false, reason: "superseded" };
      const evs = (events.get(p.accountId) || []).filter((e) => inWin(e, p.from, p.to));
      const ok = !opts.confirmMismatch && evs.length === p.expectedCount;
      if (!ok) {
        Object.assign(st, { last_status: "failed", last_error_code: "RETURNS_VERIFY_MISMATCH" });
        if (p.mode === "initial") st.initial_status = "pending";
        removeCoverage(p.accountId, p.from, p.to); snap(p.accountId, "confirm");
        return { verified: false, reason: "mismatch" };
      }
      Object.assign(st, { last_status: "succeeded", last_success_at: NOW });
      // complete ONLY when the replace itself logged identity 'clear' AND no hold is set (never the state's current value)
      const held = replacedIdentity.get(p.accountId) !== "clear" || !!st.hold_reason;
      if (p.mode === "initial") { if (!held) st.initial_status = "complete"; else removeCoverage(p.accountId, p.from, p.to); }
      snap(p.accountId, "confirm");
      // the wrapper's shape: { verified, reason: 'verified' | 'held' | 'superseded' | 'mismatch', counts, initialStatus }
      return { verified: true, reason: held ? "held" : "verified", counts: { events: evs.length }, initialStatus: st.initial_status };
    },
    recordReturnsWindowFailure: async (p) => {
      calls.failures.push(p);
      // a replace awaiting its confirm keeps EVERY state field (its recorded evidence is the zero-token re-verify input)
      if (states.has(p.accountId) && states.get(p.accountId).last_status === "replaced") { snap(p.accountId, "failure-kept"); return { recorded: true, stateKept: true }; }
      const st = states.get(p.accountId) || { account_id: p.accountId, initial_status: "pending", identity_status: "clear", hold_reason: null };
      Object.assign(st, { last_status: "failed", last_error_code: p.errorCode, marketplace_country_code: p.marketplace });
      // a HELD initial stays 'loaded' (the RPC never demotes it while hold_reason is set); an unheld one goes back to pending
      if (st.initial_status === "loaded" && !st.hold_reason) st.initial_status = "pending";
      states.set(p.accountId, st); snap(p.accountId, "failure");
      return { recorded: true };
    },
    upsertSourceRunStatus: async (e) => { calls.status.push(e); return { write: "ok" }; },
    sleep: async () => {},
    nowMs: () => Date.parse(NOW),
    now: () => NOW,
    reconcileWaitMs: 0,
  };
  const run = (extra = {}) => {
    const { deps: extraDeps, ...rest } = extra;
    return R.runReturnsRegion({ region: opts.region || "india", asOf: ASOF, maxCreates: opts.maxCreates == null ? 4 : opts.maxCreates, reserveTokens: opts.reserve == null ? 100 : opts.reserve,
      log: (m) => calls.logs.push(String(m)), ...rest, deps: { ...deps, ...(extraDeps || {}) } });
  };
  return { deps, calls, states, coverage, events, run, setBalance: (b) => { balance = b; }, get balance() { return balance; } };
}
const codeOf = (r, accountId) => r.accountCodes[accountId];
const inCat = (r, cat, accountId) => r.outcomes[cat].includes(accountId);
const completeState = (over = {}) => ({ initial_status: "complete", last_status: "succeeded", last_mode: "rolling", last_window_from: "2026-09-19", last_window_to: "2026-10-02", last_success_at: "2026-10-03T09:00:00Z", identity_status: "clear", hold_reason: null, legacy_fence: true, ...over });

// ================================================ A. windows, modes, onboarding ================================================
test("A1 a NEW account gets the 60-day INITIAL load [D1-59, D1]: state none -> loaded (replace) -> complete (confirm); ONE Returns-only create", async () => {
  const A = id(1);
  const w = world({ accounts: [{ id: A, country: "IN" }], dataset: { [A]: [fba(A, "IN", "2026-08-05"), fba(A, "IN", "2026-09-01"), fbm(A, "IN", "2026-10-03")] } });
  const r = await w.run();
  assert.equal(r.ok, true); assert.equal(r.classification, "COMPLETE");
  assert.equal(w.calls.creates.length, 1); assert.equal(r.creates, 1); assert.equal(r.tokens, 2);
  const c = w.calls.creates[0];
  assert.equal(c.sourceId, SRC.RETURNS.id); assert.deepEqual(c.ids, [A]); assert.equal(c.from, INITIAL.from); assert.equal(c.to, INITIAL.to);
  assert.deepEqual(c.body.columns, [...CORE.RETURNS_EVENT_COLUMNS]); assert.equal(c.body.limit, 50000); assert.equal(c.body.skip, 0);
  const rep = w.calls.replaces[0];
  assert.equal(rep.mode, "initial"); assert.equal(rep.from, INITIAL.from); assert.equal(rep.to, INITIAL.to); assert.equal(rep.expectedCount, 3); assert.equal(rep.expectedUnits, 4);
  assert.equal(rep.identityStatus, "clear"); assert.equal(rep.allowShrink, false); assert.equal(rep.marketplace, "IN");
  assert.deepEqual(w.calls.stateLog.filter((s) => s.accountId === A).map((s) => s.at + ":" + s.initial_status + "/" + s.last_status), ["replace:loaded/replaced", "confirm:complete/succeeded"]);
  assert.ok(inCat(r, "initial-loaded", A)); assert.equal(r.rowsWritten, true);
  assert.deepEqual(w.coverage.get(A), [{ from: INITIAL.from, to: INITIAL.to }]);
  assert.equal(w.calls.leases.length, 1); assert.equal(w.calls.leases[0].ttlSeconds, 900); assert.equal(w.calls.releases.length, 1);
  assert.equal(w.calls.status.length, 1); assert.equal(w.calls.status[0].sourceKey, "returns"); assert.equal(w.calls.status[0].bucket, "india"); assert.equal(w.calls.status[0].lastStatus, "succeeded");
  assert.equal(networkAttempts, 0);
});

test("A2 a COMPLETE account gets the ROLLING 14-day replace [D1-13, D1] (rows outside the window untouched)", async () => {
  const A = id(1);
  const old = { return_date: "2026-08-10", event_key: "0".repeat(64), occurrence: 1, amazon_order_id: "x" };
  const w = world({ accounts: [{ id: A, country: "IN" }], states: { [A]: completeState() }, coverage: { [A]: [{ from: "2026-08-04", to: "2026-10-02" }] },
    events: { [A]: [old] }, dataset: { [A]: [fba(A, "IN", "2026-09-20"), fba(A, "IN", "2026-10-03")] } });
  const r = await w.run();
  assert.equal(r.classification, "COMPLETE");
  assert.equal(w.calls.creates.length, 1); assert.equal(w.calls.creates[0].from, ROLLING.from); assert.equal(w.calls.creates[0].to, ROLLING.to);
  assert.equal(w.calls.replaces[0].mode, "rolling");
  assert.ok(inCat(r, "daily-refreshed", A));
  assert.ok(w.events.get(A).some((e) => e.return_date === "2026-08-10"), "the older saved row outside the rolling window is kept");
  assert.equal(w.states.get(A).initial_status, "complete"); assert.equal(w.states.get(A).last_status, "succeeded");
  assert.deepEqual(w.coverage.get(A), [{ from: "2026-08-04", to: "2026-10-03" }]);
});

test("A3 a NEW account joins automatically: the current accounts create nothing, ONLY the newcomer gets an initial create", async () => {
  const [A, B, N] = [id(1), id(2), id(3)];
  const cur = completeState({ last_window_to: ASOF, last_window_from: ROLLING.from });
  const w = world({ accounts: [{ id: A, country: "IN" }, { id: B, country: "IN" }, { id: N, country: "IN" }],
    states: { [A]: cur, [B]: cur }, coverage: { [A]: [{ from: INITIAL.from, to: ASOF }], [B]: [{ from: INITIAL.from, to: ASOF }] }, dataset: { [N]: [fba(N, "IN", "2026-09-30")] } });
  const r = await w.run();
  assert.equal(w.calls.creates.length, 1); assert.deepEqual(w.calls.creates[0].ids, [N]); assert.equal(w.calls.creates[0].from, INITIAL.from);
  assert.ok(inCat(r, "skipped-current", A) && inCat(r, "skipped-current", B) && inCat(r, "initial-loaded", N));
  assert.equal(r.classification, "COMPLETE");
});

test("A4 per-account state isolation: initial and rolling accounts batch SEPARATELY (rolling first); each persists under its own mode / window / state", async () => {
  const [N, B, C] = [id(1), id(2), id(3)];
  const w = world({ accounts: [N, B, C].map((x) => ({ id: x, country: "IN" })), states: { [B]: completeState(), [C]: completeState({ last_success_at: "2026-10-01T09:00:00Z" }) },
    coverage: { [B]: [{ from: "2026-08-01", to: "2026-10-02" }], [C]: [{ from: "2026-08-01", to: "2026-10-02" }] },
    dataset: { [N]: [fba(N, "IN", "2026-08-06")], [B]: [fba(B, "IN", "2026-09-25")], [C]: [fbm(C, "IN", "2026-10-01")] } });
  const r = await w.run();
  assert.equal(w.calls.creates.length, 2);
  assert.deepEqual([w.calls.creates[0].from, w.calls.creates[1].from], [ROLLING.from, INITIAL.from], "rolling batch first, then initial");
  assert.deepEqual(w.calls.creates[0].ids, [C, B], "inside a window the stalest account first (C succeeded 10-01, B 10-03)");
  assert.deepEqual(w.calls.replaces.map((p) => p.accountId + ":" + p.mode), [C + ":rolling", B + ":rolling", N + ":initial"]);
  assert.ok(inCat(r, "daily-refreshed", B) && inCat(r, "daily-refreshed", C) && inCat(r, "initial-loaded", N));
  assert.equal(w.states.get(N).initial_status, "complete"); assert.equal(w.states.get(B).last_window_from, ROLLING.from);
});

test("A5 a duplicate run the SAME day: every account skipped-current, ZERO creates, ZERO slots", async () => {
  const [A, B] = [id(1), id(2)];
  const w = world({ accounts: [A, B].map((x) => ({ id: x, country: "IN" })), dataset: { [A]: [fba(A, "IN", "2026-09-01")], [B]: [] } });
  const r1 = await w.run();
  assert.equal(r1.classification, "COMPLETE"); assert.equal(w.calls.creates.length, 1);
  const r2 = await w.run();
  assert.equal(r2.creates, 0); assert.equal(w.calls.creates.length, 1); assert.equal(w.calls.slots.length, 1);
  assert.ok(inCat(r2, "skipped-current", A) && inCat(r2, "skipped-current", B)); assert.equal(r2.classification, "COMPLETE"); assert.equal(r2.rowsWritten, false);
});

test("A6 an empty window of a NEW account is persisted as proven-empty (0 events) and completes", async () => {
  const A = id(1);
  const w = world({ accounts: [{ id: A, country: "IN" }], dataset: {} });
  const r = await w.run();
  assert.equal(w.calls.replaces[0].expectedCount, 0); assert.ok(inCat(r, "initial-loaded", A));
});
test("A7 the plan is RE-READ under the run lease: an account another run completed between planning and the lease grant creates NOTHING (skipped-current, zero slots)", async () => {
  const [A, B] = [id(1), id(2)];
  const w = world({ accounts: [A, B].map((x) => ({ id: x, country: "IN" })), dataset: { [A]: [fba(A, "IN", "2026-09-01")], [B]: [fba(B, "IN", "2026-09-02")] } });
  const lateAcquire = async (p) => {
    // the overlapping run finishes A (state complete + current, coverage written) while this one waits for the lease
    w.states.set(A, { account_id: A, ...completeState({ last_window_from: ROLLING.from, last_window_to: ASOF }) });
    w.coverage.set(A, [{ from: INITIAL.from, to: ASOF }]);
    return w.deps.acquireReturnsRunLease(p);
  };
  const r = await w.run({ deps: { acquireReturnsRunLease: lateAcquire } });
  assert.deepEqual(w.calls.creates.map((c) => c.ids), [[B]], "only B is still owed an export");
  assert.equal(w.calls.slots.length, 1); assert.ok(inCat(r, "skipped-current", A)); assert.ok(inCat(r, "initial-loaded", B));
  assert.equal(r.plan.skippedCurrent, 1, "the reported plan is the re-read one");
  const w2 = world({ accounts: [{ id: A, country: "IN" }], dataset: { [A]: [fba(A, "IN", "2026-09-01")] } });
  const r2 = await w2.run({ deps: { getReturnsAccountStates: (() => { let n = 0; return async (q) => (++n === 1 ? w2.deps.getReturnsAccountStates(q) : { read: "error" }); })() } });
  assert.equal(r2.ok, false); assert.equal(r2.code, "RETURNS_STATE_UNREADABLE", "an unreadable re-read under the lease stops the run (fail closed)");
  assert.equal(w2.calls.creates.length + w2.calls.slots.length, 0); assert.equal(w2.calls.releases.length, 1, "the lease is still released");
});
test("A8 an initial 'loaded' account whose last attempt is NOT 'replaced' (no hold) re-loads its 60-day window -- never a stuck re-verify / pending", async () => {
  const A = id(1);
  const loaded = { initial_status: "loaded", initial_window_from: INITIAL.from, initial_window_to: INITIAL.to, last_mode: "initial", last_window_from: INITIAL.from,
    last_window_to: INITIAL.to, last_status: "succeeded", last_request_hashes: ["a".repeat(64)], last_event_count: 1, last_unit_sum: 1, identity_status: "clear", hold_reason: null, legacy_fence: true };
  // the saved window matches the recorded count, so a (futile) re-verify would reach the confirm -> 'superseded' -> stuck
  const w = world({ accounts: [{ id: A, country: "IN" }], states: { [A]: loaded }, events: { [A]: [{ return_date: "2026-09-01", event_key: "2".repeat(64), occurrence: 1 }] },
    dataset: { [A]: [fba(A, "IN", "2026-09-01")] } });
  const r = await w.run();
  assert.equal(w.calls.confirms.filter((c) => c.requestHashes[0] === "a".repeat(64)).length, 0, "no futile re-verify of a non-'replaced' state");
  assert.equal(r.reverify.attempted, 0); assert.equal(w.calls.counts.length, 1, "only the new replace's read-back");
  assert.equal(w.calls.creates.length, 1); assert.equal(w.calls.creates[0].from, INITIAL.from); assert.equal(w.calls.replaces[0].mode, "initial");
  assert.ok(inCat(r, "initial-loaded", A)); assert.equal(w.states.get(A).initial_status, "complete");
});

// ================================================ B. the 50,000-row cap ================================================
test("B1 a capped export is NEVER persisted: the window bisects, the halves are reassembled and persisted with BOTH fragment hashes", async () => {
  const A = id(1);
  const real = [fba(A, "IN", "2026-08-20"), fba(A, "IN", "2026-09-28")];
  const capRow = fba(A, "IN", INITIAL.from);
  const w = world({ accounts: [{ id: A, country: "IN" }], maxCreates: 6,
    rowsFor: ({ from, to }) => (from === INITIAL.from && to === INITIAL.to ? Array.from({ length: 50000 }, () => capRow) : real.filter((x) => x.date >= from && x.date <= to)) });
  const r = await w.run();
  assert.equal(w.calls.creates.length, 3);
  assert.deepEqual(w.calls.creates.map((c) => c.from + ".." + c.to), [INITIAL.from + ".." + INITIAL.to, "2026-08-05..2026-09-03", "2026-09-04..2026-10-03"]);
  const rep = w.calls.replaces[0];
  assert.equal(rep.expectedCount, 2); assert.equal(rep.requestHashes.length, 2); assert.deepEqual(rep.fragmentRows, [1, 1]); assert.equal(rep.exportIds.length, 2);
  assert.ok(rep.events.every((e) => rep.requestHashes.includes(e.source_request_hash)));
  assert.ok(inCat(r, "initial-loaded", A));
  assert.ok(r.fragments.every((f) => f.rowCount < 50000));
});

test("B2 a SINGLE day still at the cap fails closed (RETURNS_DAY_AT_ROW_LIMIT): nothing persisted", async () => {
  const A = id(1);
  const capRow = fba(A, "IN", "2026-09-15");
  const w = world({ accounts: [{ id: A, country: "IN" }], maxCreates: 20,
    rowsFor: ({ from, to }) => ("2026-09-15" >= from && "2026-09-15" <= to ? Array.from({ length: 50000 }, () => capRow) : []) });
  const r = await w.run();
  assert.equal(w.calls.replaces.length, 0);
  assert.ok(inCat(r, "failed", A)); assert.equal(codeOf(r, A), "RETURNS_DAY_AT_ROW_LIMIT");
  assert.ok(w.calls.creates.length > 3 && w.calls.creates.length <= 20);
  assert.equal(w.calls.creates.at(-1).from, "2026-09-15"); assert.equal(w.calls.creates.at(-1).to, "2026-09-15");
  assert.equal(r.classification, "PARTIAL");
});

test("B3 the slot ceiling cuts a split tree: a capped window whose halves exceed the cap is budget-deferred, never persisted", async () => {
  const A = id(1);
  const capRow = fba(A, "IN", INITIAL.from);
  const w = world({ accounts: [{ id: A, country: "IN" }], maxCreates: 2, rowsFor: ({ from, to }) => (from === INITIAL.from && to === INITIAL.to ? Array.from({ length: 50000 }, () => capRow) : []) });
  const r = await w.run();
  assert.equal(w.calls.creates.length, 2); assert.equal(w.calls.replaces.length, 0);
  assert.ok(inCat(r, "incomplete", A)); assert.equal(codeOf(r, A), "RETURNS_BUDGET_DEFERRED"); assert.equal(r.slotsRefused, 1);
});

// ================================================ C. provider completeness signals ================================================
const lkgWorld = (A, pageFn, more = {}) => world({ accounts: [{ id: A, country: "IN" }], states: { [A]: completeState() }, coverage: { [A]: [{ from: "2026-08-04", to: "2026-10-02" }] },
  events: { [A]: [{ return_date: "2026-09-25", event_key: "1".repeat(64), occurrence: 1 }] }, rowsFor: pageFn, ...more });
const assertLkg = (w, A) => {
  assert.equal(w.calls.replaces.length, 0, "no replace");
  assert.deepEqual(w.events.get(A), [{ return_date: "2026-09-25", event_key: "1".repeat(64), occurrence: 1 }], "saved events untouched");
  assert.deepEqual(w.coverage.get(A), [{ from: "2026-08-04", to: "2026-10-02" }], "coverage untouched");
};
test("C1 a provider LOADING NOTICE on a single seller: history-loading (incomplete), nothing persisted, LKG untouched", async () => {
  const A = id(1);
  const w = lkgWorld(A, () => ({ status: "COMPLETED", rowCount: 1, rows: [fba(A, "IN", "2026-09-25")], loadingNotice: "Historical data is still loading", dataSourceIssues: [] }));
  const r = await w.run();
  assertLkg(w, A); assert.ok(inCat(r, "incomplete", A)); assert.equal(codeOf(r, A), "RETURNS_HISTORY_LOADING");
});
test("C2 a loading notice on a MULTI-seller batch splits it like a rejection: the loading seller is isolated, the other persists", async () => {
  const [A, B] = [id(1), id(2)];
  const w = world({ accounts: [A, B].map((x) => ({ id: x, country: "IN" })), maxCreates: 6,
    rowsFor: ({ ids, from, to }) => (ids.includes(A) ? { status: "COMPLETED", rowCount: 0, rows: [], loadingNotice: { message: "loading" }, dataSourceIssues: [] } : [fba(B, "IN", "2026-09-01")].filter((x) => x.date >= from && x.date <= to)) });
  const r = await w.run();
  assert.deepEqual(w.calls.creates.map((c) => c.ids.length), [2, 1, 1]);
  assert.ok(inCat(r, "incomplete", A)); assert.equal(codeOf(r, A), "RETURNS_HISTORY_LOADING");
  assert.ok(inCat(r, "initial-loaded", B)); assert.deepEqual(w.calls.replaces.map((p) => p.accountId), [B]);
});
test("C3 a DATA-SOURCE ISSUE fails closed (RETURNS_DATA_SOURCE_ISSUE): nothing persisted, LKG untouched", async () => {
  const A = id(1);
  const w = lkgWorld(A, () => ({ status: "COMPLETED", rowCount: 1, rows: [fba(A, "IN", "2026-09-25")], loadingNotice: null, dataSourceIssues: [{ code: "X" }] }));
  const r = await w.run();
  assertLkg(w, A); assert.ok(inCat(r, "failed", A)); assert.equal(codeOf(r, A), "RETURNS_DATA_SOURCE_ISSUE");
});
test("C4 a MISSING rowCount fails closed (RETURNS_EXPORT_PAGE_INVALID): nothing persisted, LKG untouched", async () => {
  const A = id(1);
  const w = lkgWorld(A, () => ({ status: "COMPLETED", rowCount: null, rows: [fba(A, "IN", "2026-09-25")], loadingNotice: null, dataSourceIssues: [] }));
  const r = await w.run();
  assertLkg(w, A); assert.equal(codeOf(r, A), "RETURNS_EXPORT_PAGE_INVALID");
});
test("C5 a raw LENGTH that disagrees with rowCount fails closed: nothing persisted, LKG untouched", async () => {
  const A = id(1);
  const w = lkgWorld(A, () => ({ status: "COMPLETED", rowCount: 2, rows: [fba(A, "IN", "2026-09-25")], loadingNotice: null, dataSourceIssues: [] }));
  const r = await w.run();
  assertLkg(w, A); assert.ok(inCat(r, "failed", A)); assert.equal(codeOf(r, A), "RETURNS_EXPORT_PAGE_INVALID");
});
test("C6 a row missing a requested column (provider shape change) or dated outside its fragment fails closed", async () => {
  const A = id(1);
  const bad = fba(A, "IN", "2026-09-25"); delete bad.cogs_present;
  const w1 = lkgWorld(A, () => ({ status: "COMPLETED", rowCount: 1, rows: [bad], loadingNotice: null, dataSourceIssues: [] }));
  assert.equal(codeOf(await w1.run(), A), "RETURNS_SHAPE_MISMATCH"); assertLkg(w1, A);
  const w2 = lkgWorld(A, () => [fba(A, "IN", "2026-09-01")]);
  assert.equal(codeOf(await w2.run(), A), "RETURNS_ROW_OUTSIDE_WINDOW"); assertLkg(w2, A);
});
test("C7 rows of a seller NOT in the batch fail the whole batch closed (RETURNS_SELLER_NOT_IN_BATCH)", async () => {
  const A = id(1);
  const w = lkgWorld(A, () => [fba(A, "IN", "2026-09-25"), fba(id(9), "IN", "2026-09-26")]);
  const r = await w.run();
  assertLkg(w, A); assert.equal(codeOf(r, A), "RETURNS_SELLER_NOT_IN_BATCH");
});
test("C8 a row WITHOUT a nullable column (the provider omits null-only keys) is persisted with null there; the request still asks all 24 columns", async () => {
  const A = id(1);
  const sparse = fba(A, "IN", "2026-09-25");
  for (const c of ["order_date", "fnsku", "amazon_return_detailed_disposition", "amazon_return_rmaid", "amazon_return_seller_rmaid", "amazon_return_label_to_be_paid_by",
    "amazon_return_refunded_amount", "amazon_return_label_cost", "cogs_item_value", "cogs_shipping_value", "cogs_total_value", "cogs_currency"]) delete sparse[c];
  const w = lkgWorld(A, () => ({ status: "COMPLETED", rowCount: 1, rows: [sparse], loadingNotice: null, dataSourceIssues: [] }));
  const r = await w.run();
  assert.ok(inCat(r, "daily-refreshed", A), "persisted, not RETURNS_SHAPE_MISMATCH");
  const e = w.calls.replaces[0].events[0];
  assert.deepEqual([e.fnsku, e.detailed_disposition, e.cogs_total_value, e.cogs_currency, e.order_date], [null, null, null, null, null]);
  assert.equal(w.calls.creates[0].body.columns.length, 24);
});
test("C9 a page rejected for SHAPE / ROW_OUTSIDE_WINDOW / DATA_SOURCE_ISSUE on a MULTI-seller batch SPLITS (each half a new create within the cap); the single seller keeps the typed failure, its batch-mate persists", async () => {
  const [A, B] = [id(1), id(2)];
  const cases = [
    ["RETURNS_SHAPE_MISMATCH", ({ from }) => { const x = fba(A, "IN", from); delete x.sku; return [x]; }],
    ["RETURNS_ROW_OUTSIDE_WINDOW", ({ from }) => [fba(A, "IN", addDays(from, -1))]],
    ["RETURNS_DATA_SOURCE_ISSUE", ({ from }) => ({ status: "COMPLETED", rowCount: 1, rows: [fba(A, "IN", from)], loadingNotice: null, dataSourceIssues: [{ code: "X" }] })],
  ];
  for (const [code, badPage] of cases) {
    const w = world({ accounts: [A, B].map((x) => ({ id: x, country: "IN" })), maxCreates: 6,
      rowsFor: ({ ids, from, to }) => (ids.includes(A) ? badPage({ from, to }) : [fba(B, "IN", "2026-09-01")].filter((x) => x.date >= from && x.date <= to)) });
    const r = await w.run();
    assert.deepEqual(w.calls.creates.map((c) => c.ids.length), [2, 1, 1], code + ": split into single-seller halves");
    assert.ok(inCat(r, "failed", A), code); assert.equal(codeOf(r, A), code);
    assert.ok(inCat(r, "initial-loaded", B), code + ": the batch-mate persists"); assert.deepEqual(w.calls.replaces.map((p) => p.accountId), [B]);
    assert.ok(w.calls.slots.every((s) => s.granted), code + ": every half claimed its own slot");
  }
  // a split that the slot ceiling cuts short is budget-deferred, never a POST past the cap
  const w2 = world({ accounts: [A, B].map((x) => ({ id: x, country: "IN" })), maxCreates: 2, rowsFor: ({ ids, from }) => (ids.includes(A) ? [fba(A, "IN", addDays(from, -1))] : []) });
  const r2 = await w2.run();
  assert.equal(w2.calls.creates.length, 2); assert.equal(r2.slotsRefused, 1);
});

// ================================================ D. persistence + verification ================================================
test("D1 an RPC raise (failed staging) keeps LKG and records the failure (typed code, counts-only detail)", async () => {
  const A = id(1);
  const w = lkgWorld(A, ({ from, to }) => [fba(A, "IN", "2026-09-25")].filter((x) => x.date >= from && x.date <= to), { replaceThrows: () => "RETURNS_VERIFY_MISMATCH" });
  const r = await w.run();
  assert.equal(w.calls.replaces.length, 1);
  assert.deepEqual(w.events.get(A), [{ return_date: "2026-09-25", event_key: "1".repeat(64), occurrence: 1 }]);
  assert.ok(inCat(r, "failed", A)); assert.equal(codeOf(r, A), "RETURNS_VERIFY_MISMATCH");
  assert.equal(w.calls.failures.length, 1); assert.equal(w.calls.failures[0].errorCode, "RETURNS_VERIFY_MISMATCH"); assert.equal(w.calls.failures[0].mode, "rolling");
  assert.equal(r.rowsWritten, false); assert.equal(w.states.get(A).last_status, "failed");
});
test("D2 the sudden-empty guard refuses an empty window over saved rows (failed, LKG) -- unless the operator's --allow-shrink names the account", async () => {
  const A = id(1);
  const w = lkgWorld(A, () => []);
  const r = await w.run();
  assert.equal(codeOf(r, A), "RETURNS_ACCOUNT_SUDDEN_EMPTY"); assert.equal(w.events.get(A).length, 1);
  const w2 = lkgWorld(A, () => []);
  const r2 = await w2.run({ allowShrinkIds: [A] });
  assert.equal(w2.calls.replaces[0].allowShrink, true); assert.ok(inCat(r2, "daily-refreshed", A)); assert.equal(w2.events.get(A).length, 0);
  await assert.rejects(() => lkgWorld(A, () => []).run({ allowShrinkIds: [id(7)] }), /RETURNS_ALLOW_SHRINK_NOT_IN_SCOPE/);
});
test("D3 a CONFIRM mismatch fails the account (RETURNS_VERIFY_MISMATCH); an initial load goes back to pending and its coverage is removed", async () => {
  const A = id(1);
  const w = world({ accounts: [{ id: A, country: "IN" }], dataset: { [A]: [fba(A, "IN", "2026-09-01")] }, confirmMismatch: true });
  const r = await w.run();
  assert.ok(inCat(r, "failed", A)); assert.equal(codeOf(r, A), "RETURNS_VERIFY_MISMATCH");
  assert.equal(w.states.get(A).initial_status, "pending"); assert.deepEqual(w.coverage.get(A), []);
});
test("D4 the INDEPENDENT read-back: a count mismatch still runs the confirm (the SERVER recounts + cuts coverage) and fails the account RETURNS_READBACK_MISMATCH with NO failure write; an unreadable count is pending and re-verified next run at ZERO tokens", async () => {
  const A = id(1);
  const w = world({ accounts: [{ id: A, country: "IN" }], dataset: { [A]: [fba(A, "IN", "2026-09-01")] }, countSkew: 1 });
  const r = await w.run();
  assert.ok(inCat(r, "failed", A)); assert.equal(codeOf(r, A), "RETURNS_READBACK_MISMATCH");
  assert.equal(w.calls.confirms.length, 1, "the confirm judges the committed window"); assert.equal(w.calls.failures.length, 0, "no failure write can erase the replace's evidence");
  const wm = world({ accounts: [{ id: A, country: "IN" }], dataset: { [A]: [fba(A, "IN", "2026-09-01")] }, countSkew: 1, confirmMismatch: true });
  const rm = await wm.run();
  assert.equal(codeOf(rm, A), "RETURNS_READBACK_MISMATCH"); assert.equal(wm.calls.failures.length, 0);
  assert.equal(wm.states.get(A).initial_status, "pending", "the server-side mismatch sent the initial back to pending"); assert.deepEqual(wm.coverage.get(A), [], "and removed the window's coverage");
  let failCount = true;
  const w2 = world({ accounts: [{ id: A, country: "IN" }], dataset: { [A]: [fba(A, "IN", "2026-09-01")] }, countFails: () => failCount });
  const r2 = await w2.run();
  assert.ok(inCat(r2, "pending", A)); assert.equal(codeOf(r2, A), "RETURNS_VERIFY_UNREADABLE"); assert.equal(w2.states.get(A).last_status, "replaced");
  failCount = false;
  const r3 = await w2.run();
  assert.equal(r3.creates, 0); assert.equal(w2.calls.creates.length, 1); assert.equal(r3.reverify.verified, 1);
  assert.ok(inCat(r3, "skipped-current", A)); assert.equal(w2.states.get(A).initial_status, "complete");
});
test("D5 a CRASH between replace and confirm costs ZERO tokens: the next run re-verifies first (no create, no slot) and the account is current", async () => {
  const A = id(1);
  let crash = true;
  const w = world({ accounts: [{ id: A, country: "IN" }], dataset: { [A]: [fba(A, "IN", "2026-09-01"), fbm(A, "IN", "2026-09-02")] }, confirmThrows: () => crash });
  const r1 = await w.run();
  assert.ok(inCat(r1, "pending", A)); assert.equal(w.states.get(A).last_status, "replaced"); assert.equal(w.states.get(A).initial_status, "loaded");
  crash = false;
  const slotsBefore = w.calls.slots.length;
  const r2 = await w.run();
  assert.equal(r2.creates, 0); assert.equal(w.calls.slots.length, slotsBefore); assert.equal(w.calls.creates.length, 1);
  assert.equal(r2.reverify.attempted, 1); assert.equal(r2.reverify.verified, 1);
  const conf = w.calls.confirms.at(-1);
  assert.equal(conf.mode, "initial"); assert.equal(conf.from, INITIAL.from); assert.equal(conf.expectedCount, 2); assert.equal(conf.expectedUnits, 3);
  assert.ok(inCat(r2, "skipped-current", A)); assert.equal(w.states.get(A).initial_status, "complete");
});
test("D6 an UNKNOWN replace outcome (transport loss / a 5xx without a code) writes NO failure: pending RETURNS_PERSIST_UNCONFIRMED; a replace that DID commit is re-verified next run at ZERO tokens", async () => {
  const A = id(1);
  let lose = true;
  const w = world({ accounts: [{ id: A, country: "IN" }], dataset: { [A]: [fba(A, "IN", "2026-09-01"), fbm(A, "IN", "2026-09-03")] }, replaceLosesResponse: () => lose });
  const r = await w.run();
  assert.ok(inCat(r, "pending", A)); assert.equal(codeOf(r, A), "RETURNS_PERSIST_UNCONFIRMED");
  assert.equal(w.calls.failures.length, 0, "no state write over an unknown outcome"); assert.equal(w.calls.confirms.length, 0);
  assert.equal(w.states.get(A).last_status, "replaced"); assert.equal(w.states.get(A).initial_status, "loaded");
  lose = false;
  const r2 = await w.run();
  assert.equal(r2.creates, 0); assert.equal(w.calls.creates.length, 1); assert.equal(r2.reverify.verified, 1);
  assert.ok(inCat(r2, "skipped-current", A)); assert.equal(w.states.get(A).initial_status, "complete");
  // a 502 WITHOUT any code (a gateway page): unknown too -- nothing written, the account keeps its previous state
  const untyped = () => Object.assign(new Error("replace_returns_events_window failed (502): UNTYPED"), { name: "ReturnsRpcError", status: 502, code: null, returnsCode: null });
  const w2 = lkgWorld(A, ({ from, to }) => [fba(A, "IN", "2026-09-25")].filter((x) => x.date >= from && x.date <= to), { replaceRawError: untyped });
  const r3 = await w2.run();
  assert.equal(codeOf(r3, A), "RETURNS_PERSIST_UNCONFIRMED"); assert.equal(w2.calls.failures.length, 0); assert.equal(w2.states.get(A).last_status, "succeeded");
  // DEFINITIVE rollbacks still record: a typed RPC refusal (D1) and a bare PostgREST / SQLSTATE code (e.g. a statement timeout)
  for (const code of ["57014", "PGRST003"]) {
    const coded = () => Object.assign(new Error("replace_returns_events_window failed (500): " + code), { name: "ReturnsRpcError", status: 500, code, returnsCode: null });
    const w3 = lkgWorld(A, ({ from, to }) => [fba(A, "IN", "2026-09-25")].filter((x) => x.date >= from && x.date <= to), { replaceRawError: coded });
    const r4 = await w3.run();
    assert.ok(inCat(r4, "failed", A), code); assert.equal(codeOf(r4, A), "RETURNS_PERSIST_FAILED"); assert.equal(w3.calls.failures.length, 1, code + " records the failure");
  }
  // a statement whose completion is unknown (SQLSTATE 40003 / connection class 08) is NOT definitive
  for (const code of ["40003", "08006"]) {
    const unsure = () => Object.assign(new Error("x failed (500): " + code), { name: "ReturnsRpcError", status: 500, code, returnsCode: null });
    const w5 = lkgWorld(A, ({ from, to }) => [fba(A, "IN", "2026-09-25")].filter((x) => x.date >= from && x.date <= to), { replaceRawError: unsure });
    assert.equal(codeOf(await w5.run(), A), "RETURNS_PERSIST_UNCONFIRMED", code); assert.equal(w5.calls.failures.length, 0, code);
  }
});

// ================================================ E. reuse, ceilings, reserve, GET-only retry ================================================
test("E1 an exact COMPLETED export is REUSED at zero tokens: no slot, no POST, persisted through the same gates", async () => {
  const A = id(1);
  const body = R.guardedReturnsBody(CORE.RETURNS_PSEUDO_SOURCE, [A], INITIAL.from, INITIAL.to);
  const listed = [{ id: "lst-0001-beef-0000-0000-000000000000", status: "COMPLETED", createdAt: "2026-10-04T10:00:00Z", expiresAt: "2026-10-05T10:00:00Z", ...body }];
  const w = world({ accounts: [{ id: A, country: "IN" }], dataset: { [A]: [fba(A, "IN", "2026-09-01")] }, listed });
  const r = await w.run();
  assert.equal(w.calls.creates.length, 0); assert.equal(w.calls.slots.length, 0); assert.equal(r.reused, 1); assert.equal(r.tokens, 0);
  assert.ok(inCat(r, "initial-loaded", A)); assert.deepEqual(w.calls.replaces[0].exportIds, [listed[0].id]);
  const w2 = world({ accounts: [{ id: A, country: "IN" }], dataset: { [A]: [fba(A, "IN", "2026-09-01")] }, listed });
  await w2.run({ adoptList: false });
  assert.equal(w2.calls.listings, 0, "--no-adopt-list never lists exports"); assert.equal(w2.calls.creates.length, 1);
});
test("E2 the DB slot ceiling: a refused claim budget-defers the rest (zero POSTs after it; LKG kept); a prior invocation's slots count", async () => {
  const accts = [1, 2, 3, 4, 5, 6].map(id);
  const w = world({ accounts: accts.map((x) => ({ id: x, country: "IN" })), maxCreates: 1, dataset: Object.fromEntries(accts.map((x) => [x, [fba(x, "IN", "2026-09-01")]])) });
  const r = await w.run();
  assert.equal(w.calls.creates.length, 1); assert.equal(r.slotsRefused, 1);
  const deferred = r.outcomes.incomplete;
  assert.equal(deferred.length, 1); assert.equal(codeOf(r, deferred[0]), "RETURNS_BUDGET_DEFERRED"); assert.equal(r.outcomes["initial-loaded"].length, 5);
  const w2 = world({ accounts: [{ id: id(1), country: "IN" }], maxCreates: 4, slotsUsed: { ["india|" + ASOF]: 4 } });
  const r2 = await w2.run();
  assert.equal(w2.calls.creates.length, 0); assert.equal(codeOf(r2, id(1)), "RETURNS_BUDGET_DEFERRED");
});
test("E3 the token RESERVE: a fresh balance below remaining x 2 + reserve stops creating (typed RETURNS_TOKEN_RESERVE, zero POSTs)", async () => {
  const A = id(1);
  const w = world({ accounts: [{ id: A, country: "IN" }], balance: 105, reserve: 100, maxCreates: 4 });
  const r = await w.run();
  assert.equal(w.calls.creates.length, 0); assert.ok(w.calls.balances >= 1);
  assert.equal(codeOf(r, A), "RETURNS_TOKEN_RESERVE"); assert.equal(r.classification, "RETURNS_TOKEN_RESERVE");
  const w2 = world({ accounts: [{ id: A, country: "IN" }], balanceUnreadable: true });
  const r2 = await w2.run();
  assert.equal(w2.calls.creates.length, 0); assert.equal(codeOf(r2, A), "RETURNS_BALANCE_UNREADABLE");
});
test("E4 a failed status / download GET keeps the export id: ONE end-of-run GET-only retry persists it (no new slot, no new POST)", async () => {
  const A = id(1);
  const w = world({ accounts: [{ id: A, country: "IN" }], dataset: { [A]: [fba(A, "IN", "2026-09-01")] }, downloadThrows: ({ attempt }) => attempt === 1 });
  const r = await w.run();
  assert.equal(w.calls.creates.length, 1); assert.equal(w.calls.slots.length, 1); assert.equal(w.calls.downloads.length, 2);
  assert.ok(inCat(r, "initial-loaded", A)); assert.equal(r.reconciled, 1);
  const w2 = world({ accounts: [{ id: A, country: "IN" }], dataset: { [A]: [fba(A, "IN", "2026-09-01")] }, downloadThrows: () => true });
  const r2 = await w2.run();
  assert.equal(w2.calls.creates.length, 1); assert.ok(inCat(r2, "failed", A)); assert.equal(codeOf(r2, A), "RETURNS_DOWNLOAD_FAILED");
});
test("E5 the zero-create pass honours the run DEADLINE: checked before each batch AND before each download (no GET past it; the batch keeps its main-pass outcome)", async () => {
  const A = id(1);
  const deadline = Date.parse(NOW) + 60000;
  // (a) the deadline passes during the main pass -> the zero-create pass starts no batch
  let clock = Date.parse(NOW);
  const w = world({ accounts: [{ id: A, country: "IN" }], dataset: { [A]: [fba(A, "IN", "2026-09-01")] },
    downloadThrows: ({ attempt }) => { if (attempt === 1) { clock = deadline + 1; return true; } return false; } });
  const r = await w.run({ deps: { nowMs: () => clock, deadlineAtMs: deadline } });
  assert.equal(w.calls.downloads.length, 1, "no GET after the deadline"); assert.equal(r.reconciled, 0);
  assert.ok(inCat(r, "failed", A)); assert.equal(codeOf(r, A), "RETURNS_DOWNLOAD_FAILED"); assert.equal(w.calls.replaces.length, 0);
  // (b) the deadline passes between the batch check and its download (here: during the pre-batch lease renewal)
  let clock2 = Date.parse(NOW); let failedOnce = false;
  const w2 = world({ accounts: [{ id: A, country: "IN" }], dataset: { [A]: [fba(A, "IN", "2026-09-01")] },
    downloadThrows: ({ attempt }) => { if (attempt === 1) { failedOnce = true; return true; } return false; } });
  const lateRenew = async (p) => { if (failedOnce) clock2 = deadline + 1; return w2.deps.renewReturnsRunLease(p); };
  const r2 = await w2.run({ deps: { nowMs: () => clock2, deadlineAtMs: deadline, renewReturnsRunLease: lateRenew } });
  assert.equal(w2.calls.downloads.length, 1, "the download itself is gated"); assert.equal(r2.reconciled, 0);
  assert.equal(codeOf(r2, A), "RETURNS_DOWNLOAD_FAILED"); assert.ok(w2.calls.logs.some((l) => /deadline/i.test(l)), "the stop is logged");
  // (c) inside the deadline the GET-only retry still runs (E4 unchanged)
  const w3 = world({ accounts: [{ id: A, country: "IN" }], dataset: { [A]: [fba(A, "IN", "2026-09-01")] }, downloadThrows: ({ attempt }) => attempt === 1 });
  const r3 = await w3.run({ deps: { deadlineAtMs: deadline } });
  assert.equal(w3.calls.downloads.length, 2); assert.ok(inCat(r3, "initial-loaded", A));
});

// ================================================ F. isolation ================================================
test("F1 ONE invalid account fails ALONE (failure recorded, nothing written) while its batch-mates persist", async () => {
  const [A, B, C] = [id(1), id(2), id(3)];
  const w = world({ accounts: [{ id: A, country: "UK" }, { id: B, country: "DE" }, { id: C, country: "UK" }], region: "europe-au",
    dataset: { [A]: [fba(A, "GB", "2026-09-01")], [B]: [fba(B, "FR", "2026-09-02")], [C]: [fba(C, "GB", "2026-09-03", { quantity: -1 })] } });
  const r = await w.run();
  assert.equal(w.calls.creates.length, 1); assert.equal(w.calls.creates[0].ids.length, 3);
  assert.ok(inCat(r, "initial-loaded", A)); assert.equal(w.calls.replaces[0].marketplace, "GB", "UK is persisted as GB");
  assert.equal(codeOf(r, B), "RETURNS_MARKETPLACE_MISMATCH"); assert.equal(codeOf(r, C), "RETURNS_QUANTITY_INVALID");
  assert.deepEqual(w.calls.replaces.map((p) => p.accountId), [A]);
  assert.deepEqual(w.calls.failures.map((f) => f.accountId + ":" + f.errorCode).sort(), [B + ":RETURNS_MARKETPLACE_MISMATCH", C + ":RETURNS_QUANTITY_INVALID"].sort());
  assert.equal(r.rowFailures.RETURNS_MARKETPLACE_MISMATCH, 1); assert.equal(r.rowFailures.RETURNS_QUANTITY_INVALID, 1);
});
test("F2 a REJECTED multi-seller create splits; the rejecting seller is isolated (failed), the rest persist", async () => {
  const accts = [1, 2, 3, 4, 5].map(id);
  const X = accts[3];
  const w = world({ accounts: accts.map((x) => ({ id: x, country: "IN" })), maxCreates: 10, dataset: Object.fromEntries(accts.map((x) => [x, [fba(x, "IN", "2026-09-01")]])),
    createThrows: ({ ids }) => (ids.includes(X) ? Object.assign(new Error("DataDoe returns-events export creation failed (400)"), { httpStatus: 400, sourceStage: "create" }) : null) });
  const r = await w.run();
  assert.ok(inCat(r, "failed", X)); assert.equal(codeOf(r, X), "RETURNS_EXPORT_REJECTED");
  assert.equal(r.outcomes["initial-loaded"].length, 4);
  assert.ok(w.calls.creates.every((c) => !c.ids.includes(X)));
  assert.equal(w.calls.failures.length, 0, "an export-level rejection writes no account state");
});
test("F3 an AMBIGUOUS create is never re-POSTed: the end-of-run adopt-only pass reuses the landed export; without the listing it stays incomplete", async () => {
  const A = id(1);
  const throwsFirst = ({ n, register }) => (n === 1 ? (register(), Object.assign(new Error("DataDoe returns-events create network failure"), { sourceStage: "create", network: true })) : null);
  const w = world({ accounts: [{ id: A, country: "IN" }], dataset: { [A]: [fba(A, "IN", "2026-09-01")] }, createThrows: throwsFirst });
  const r = await w.run();
  assert.equal(r.creates, 1); assert.equal(w.calls.slots.length, 1, "the ambiguous POST consumed its slot; nothing re-POSTed");
  assert.ok(inCat(r, "initial-loaded", A)); assert.equal(r.reused, 1); assert.ok(w.calls.listings >= 1);
  const w2 = world({ accounts: [{ id: A, country: "IN" }], dataset: { [A]: [fba(A, "IN", "2026-09-01")] }, createThrows: throwsFirst });
  const r2 = await w2.run({ adoptList: false });
  assert.equal(w2.calls.listings, 0); assert.ok(inCat(r2, "incomplete", A)); assert.equal(codeOf(r2, A), "RETURNS_CREATE_AMBIGUOUS"); assert.equal(w2.calls.replaces.length, 0);
});
test("F4 a create past its deadline is AMBIGUOUS (not re-sent)", async () => {
  const A = id(1);
  const w = world({ accounts: [{ id: A, country: "IN" }], createHangs: ({ n }) => n === 1 });
  const r = await w.run({ deps: { createTimeoutMs: 20 }, adoptList: false });
  assert.equal(codeOf(r, A), "RETURNS_CREATE_AMBIGUOUS"); assert.equal(w.calls.slots.length, 1);
});

// ================================================ G. identity, gaps, skips ================================================
test("G1 an identity-AMBIGUOUS account is persisted with EVERY row, reported and HELD (initial not complete; zero creates next run)", async () => {
  const A = id(1);
  const one = fba(A, "IN", "2026-09-01");
  const dup = { ...fba(A, "IN", "2026-09-05"), amazon_order_id: one.amazon_order_id, sku: one.sku, amazon_license_plate_number: one.amazon_license_plate_number };
  const w = world({ accounts: [{ id: A, country: "IN" }], dataset: { [A]: [one, dup, fba(A, "IN", "2026-09-07")] } });
  const r = await w.run();
  const rep = w.calls.replaces[0];
  assert.equal(rep.identityStatus, "ambiguous"); assert.equal(rep.events.length, 3); assert.equal(rep.identityDetail.keyCollisions, 1);
  assert.ok(inCat(r, "held", A)); assert.equal(codeOf(r, A), "RETURNS_IDENTITY_AMBIGUOUS"); assert.equal(r.identityAmbiguous, 1);
  assert.equal(w.states.get(A).initial_status, "loaded"); assert.equal(w.states.get(A).hold_reason, "RETURNS_IDENTITY_AMBIGUOUS");
  const r2 = await w.run();
  assert.equal(r2.creates, 0); assert.ok(inCat(r2, "held", A)); assert.equal(r2.classification, "PARTIAL");
});
test("G1b a HELD account a crashed run left 'replaced' is re-verified at ZERO tokens (the confirm drops the ambiguous initial's coverage) and stays held", async () => {
  const A = id(1);
  const one = fba(A, "IN", "2026-09-01");
  const dup = { ...fba(A, "IN", "2026-09-05"), amazon_order_id: one.amazon_order_id, sku: one.sku, amazon_license_plate_number: one.amazon_license_plate_number };
  let crash = true;
  const w = world({ accounts: [{ id: A, country: "IN" }], dataset: { [A]: [one, dup] }, confirmThrows: () => crash });
  const r1 = await w.run();
  assert.ok(inCat(r1, "pending", A)); assert.equal(codeOf(r1, A), "RETURNS_VERIFY_UNREADABLE");
  assert.equal(w.states.get(A).last_status, "replaced"); assert.equal(w.states.get(A).hold_reason, "RETURNS_IDENTITY_AMBIGUOUS");
  assert.deepEqual(w.coverage.get(A), [{ from: INITIAL.from, to: INITIAL.to }], "the replace wrote the window's coverage");
  crash = false;
  const dry = await w.run({ dryRun: true, maxCreates: null });
  assert.deepEqual(dry.reverifyPending, [A], "the dry-run reports the held leftover as a zero-token re-verify");
  const slotsBefore = w.calls.slots.length;
  const r2 = await w.run();
  assert.equal(r2.creates, 0); assert.equal(w.calls.slots.length, slotsBefore); assert.equal(w.calls.creates.length, 1);
  assert.equal(r2.reverify.attempted, 1); assert.equal(r2.reverify.verified, 1);
  assert.deepEqual(w.coverage.get(A), [], "the confirm removed the ambiguous initial's window coverage (rows kept, load NOT complete)");
  assert.equal(w.states.get(A).initial_status, "loaded"); assert.equal(w.states.get(A).last_status, "succeeded");
  assert.ok(inCat(r2, "held", A)); assert.equal(codeOf(r2, A), "RETURNS_IDENTITY_AMBIGUOUS");
  const r3 = await w.run();
  assert.equal(r3.reverify.attempted, 0, "a verified held account is not re-verified again"); assert.equal(r3.creates, 0); assert.ok(inCat(r3, "held", A));
});
test("G2 a COVERAGE GAP older than the rolling window is REPORTED (typed + day count), never fetched", async () => {
  const A = id(1);
  const w = world({ accounts: [{ id: A, country: "IN" }], states: { [A]: completeState() }, coverage: { [A]: [{ from: "2026-08-20", to: "2026-10-02" }] }, dataset: { [A]: [] } });
  const r = await w.run();
  assert.equal(w.calls.creates[0].from, ROLLING.from, "never a catch-up window");
  assert.deepEqual(r.coverageGaps, [{ accountId: A, days: 15 }]);
  const p = R.returnsResultPayload(r);
  assert.equal(p.coverageGapDays, 15); assert.deepEqual(p.coverageGaps, [{ id: A.slice(0, 8), days: 15, code: "RETURNS_COVERAGE_GAP" }]);
  assert.match(R.returnsStepSummary(r), /RETURNS_COVERAGE_GAP/);
  assert.equal(w.calls.status[0].safeErrorCode, "RETURNS_COVERAGE_GAP");
});
test("G3 the run LEASE held by another run: typed RETURNS_LEASE_HELD skip, zero creates / slots / writes, a status row written", async () => {
  const A = id(1);
  const w = world({ accounts: [{ id: A, country: "IN" }], leaseHeld: true });
  const r = await w.run();
  assert.equal(r.classification, "RETURNS_LEASE_HELD"); assert.equal(r.ok, true);
  assert.equal(w.calls.creates.length + w.calls.slots.length + w.calls.replaces.length + w.calls.confirms.length, 0);
  assert.equal(w.calls.status.length, 1); assert.equal(w.calls.status[0].safeErrorCode, "RETURNS_LEASE_HELD"); assert.equal(w.calls.status[0].lastStatus, "partial");
});
test("G4 a lost lease stops the run (systemic): no further creates or persists", async () => {
  const accts = [1, 2, 3, 4, 5, 6].map(id);
  const w = world({ accounts: accts.map((x) => ({ id: x, country: "IN" })), dataset: Object.fromEntries(accts.map((x) => [x, [fba(x, "IN", "2026-09-01")]])), renewFailsAfter: 2 });
  const r = await w.run();
  assert.equal(r.ok, false); assert.equal(r.code, "RETURNS_LEASE_LOST"); assert.equal(r.classification, "RETURNS_FAILED");
  assert.ok(w.calls.replaces.length <= 1);
  assert.equal(w.calls.status.at(-1).lastStatus, "failed");
});
test("G5 public SCHEMA DRIFT (a missing column or a premium price): typed skip with zero creates and a failed status row", async () => {
  const A = id(1);
  const drift = { sources: [{ id: SRC.RETURNS.id, isPremium: false, columns: CORE.RETURNS_EVENT_COLUMNS.filter((c) => c !== "quantity").map((name) => ({ name })) }] };
  const w = world({ accounts: [{ id: A, country: "IN" }], spec: drift });
  const r = await w.run();
  assert.equal(r.classification, "RETURNS_SCHEMA_DRIFT"); assert.equal(w.calls.creates.length + w.calls.leases.length, 0);
  assert.equal(w.calls.status[0].safeErrorCode, "RETURNS_SCHEMA_DRIFT"); assert.equal(w.calls.status[0].lastStatus, "failed");
  assert.equal(R.checkReturnsSpec({ sources: [{ ...SPEC_OK.sources[0], isPremium: true }] }).ok, false);
  assert.equal(R.checkReturnsSpec(SPEC_OK).ok, true); assert.equal(R.checkReturnsSpec({}).read, "error");
});
test("G6 DRY-RUN: the plan, exposure and balance only -- ZERO creates, ZERO export listing, ZERO writes (no lease, no status)", async () => {
  const [A, B] = [id(1), id(2)];
  const w = world({ accounts: [A, B].map((x) => ({ id: x, country: "IN" })), states: { [B]: completeState() }, coverage: { [B]: [{ from: "2026-08-01", to: "2026-10-02" }] } });
  const r = await w.run({ dryRun: true, maxCreates: null });
  assert.equal(r.classification, "DRY_RUN");
  assert.equal(w.calls.creates.length + w.calls.listings + w.calls.slots.length + w.calls.leases.length + w.calls.replaces.length + w.calls.confirms.length + w.calls.failures.length + w.calls.status.length, 0);
  assert.equal(r.exposure.plannedCreates, 2); assert.equal(r.exposure.expectedTokens, 4);
  assert.deepEqual(r.planned.map((p) => p.mode).sort(), ["initial", "rolling"]);
  assert.equal(r.balanceBefore, 1000);
});
test("G7 incompatible / unreadable sources and unreadable coverage are excluded and reported (never exported)", async () => {
  const [A, B, C, D] = [id(1), id(2), id(3), id(4)];
  const w = world({ accounts: [A, B, C, D].map((x) => ({ id: x, country: "IN" })), incompatible: [A], sourcesUnreadable: [B], coverageUnreadable: [C] });
  const r = await w.run();
  assert.ok(inCat(r, "incompatible", A)); assert.ok(inCat(r, "pending", B)); assert.equal(codeOf(r, B), "RETURNS_SOURCES_UNREADABLE");
  assert.ok(inCat(r, "pending", C)); assert.equal(codeOf(r, C), "RETURNS_COVERAGE_UNREADABLE");
  assert.deepEqual(w.calls.creates.map((c) => c.ids), [[D]]);
});
test("G8 the guarded create body refuses anything but a Returns-only request inside the provider contract", () => {
  const ok = R.guardedReturnsBody(CORE.RETURNS_PSEUDO_SOURCE, [id(1)], INITIAL.from, INITIAL.to);
  assert.equal(ok.sourceId, SRC.RETURNS.id); assert.equal(ok.limit, 50000); assert.deepEqual(ok.columns, [...CORE.RETURNS_EVENT_COLUMNS]); assert.equal(ok.groupBy, undefined);
  assert.throws(() => R.guardedReturnsBody({ ...CORE.RETURNS_PSEUDO_SOURCE }, [id(1)], INITIAL.from, INITIAL.to), /RETURNS_SOURCE_MISMATCH/);
  assert.throws(() => R.guardedReturnsBody(CORE.RETURNS_PSEUDO_SOURCE, [1, 2, 3, 4, 5, 6].map(id), INITIAL.from, INITIAL.to), /RETURNS_SELLER_LIMIT/);
  assert.throws(() => R.guardedReturnsBody(CORE.RETURNS_PSEUDO_SOURCE, [], INITIAL.from, INITIAL.to), /RETURNS_SELLER_LIMIT/);
  assert.throws(() => R.guardedReturnsBody(CORE.RETURNS_PSEUDO_SOURCE, [id(1)], INITIAL.to, INITIAL.from), /RETURNS_WINDOW_INVALID/);
});
test("G8b the runner's rate-limited fetch: spaced, an AbortSignal on every call, a GET 429 retried after Retry-After (bounded), a POST never retried", async () => {
  const waits = []; const seen = []; let clock = 1000;
  const replies = [];
  const impl = async (url, o) => { seen.push({ method: (o && o.method) || "GET", hasSignal: !!(o && o.signal) }); return replies.shift(); };
  const r429 = (ra) => ({ status: 429, ok: false, headers: { get: (k) => (k === "retry-after" && ra != null ? String(ra) : null) } });
  const ok = { status: 200, ok: true, headers: { get: () => null } };
  const f = R.createRateLimitedFetch({ fetchImpl: impl, minIntervalMs: 550, sleep: async (ms) => { waits.push(ms); clock += ms; }, nowMs: () => clock });
  replies.push(r429(3), ok);
  assert.equal((await f("https://api.datadoe.com/api/v1/usage-logs?pageSize=100", { headers: {} })).status, 200);
  assert.deepEqual(waits, [3000], "Retry-After honoured (it already covers the 550 ms spacing)");
  replies.push(r429(null), r429(null), r429(null));
  assert.equal((await f("https://api.datadoe.com/api/v1/exports?pageSize=25&page=1", { method: "GET" })).status, 429, "bounded: at most 2 retries");
  assert.deepEqual(waits.slice(1), [550, 1000, 2000], "spacing, then the 1 s / 2 s backoff without a Retry-After");
  replies.push(r429(1));
  assert.equal((await f("https://api.datadoe.com/api/v1/exports", { method: "POST" })).status, 429, "a POST is never retried here");
  assert.deepEqual(waits.slice(4), [550], "only the spacing before the POST -- no retry wait after its 429");
  assert.equal(seen.length, 6); assert.ok(seen.every((s) => s.hasSignal), "every request carries an AbortSignal timeout");
  assert.equal(seen.filter((s) => s.method === "POST").length, 1);
});
test("G9 an operator allowlist outside the region is refused before anything else; the region is validated", async () => {
  const w = world({ accounts: [{ id: id(1), country: "IN" }, { id: id(2), country: "US" }] });
  await assert.rejects(() => w.run({ accountAllowlist: [id(2)] }), /RETURNS_ALLOWLIST_NOT_IN_REGION/);
  await assert.rejects(() => w.run({ region: "us" }), /RETURNS_BAD_REGION/);
  assert.equal(w.calls.leases.length, 0);
  const r = await w.run({ accountAllowlist: [id(1)] });
  assert.ok(inCat(r, "initial-loaded", id(1)));
});

// ================================================ H. output contract ================================================
test("H1 REDACTION: no order id / LPN / RMA / FNSKU / SKU / full seller id reaches the logs, RESULT, summary, status rows, failure details or identity detail", async () => {
  const accts = [1, 2, 3].map(id);
  const [A, B, C] = accts;
  const one = fba(A, "IN", "2026-09-01");
  const dup = { ...fba(A, "IN", "2026-09-02"), amazon_order_id: one.amazon_order_id, sku: one.sku, amazon_license_plate_number: one.amazon_license_plate_number };
  const w = world({ accounts: accts.map((x) => ({ id: x, country: "IN" })),
    dataset: { [A]: [one, dup], [B]: [fbm(B, "IN", "2026-09-03"), fba(B, "IN", "2026-09-04")], [C]: [fba(C, "IN", "2026-09-05", { marketplace_country_code: "US" })] } });
  const r = await w.run();
  const r2 = await world({ accounts: [{ id: A, country: "IN" }], dataset: { [A]: [fba(A, "IN", "2026-09-01")] }, replaceThrows: () => "RETURNS_VERIFY_MISMATCH" }).run();
  const captured = [
    ...w.calls.logs, JSON.stringify(R.returnsResultPayload(r)), R.returnsStepSummary(r), JSON.stringify(w.calls.status),
    JSON.stringify(w.calls.failures.map((f) => f.detail)), JSON.stringify(w.calls.replaces.map((p) => p.identityDetail)),
    JSON.stringify(R.returnsResultPayload(r2)), R.returnsStepSummary(r2), JSON.stringify(R.buildStatusEntry(r2, null)),
  ].join("\n");
  assert.ok(SENSITIVE.size > 10);
  for (const v of SENSITIVE) assert.ok(!captured.includes(v), "a sensitive fixture value leaked into the output contract");
  for (const a of accts) { assert.ok(!captured.includes(a), "a full seller id leaked"); assert.ok(captured.includes(a.slice(0, 8)), "the 8-char prefix is the reporting form"); }
  assert.ok(!/SECRET/.test(captured), "no SECRET-marked value anywhere");
  assert.ok(inCat(r, "held", A) && inCat(r, "initial-loaded", B) && inCat(r, "failed", C));
  assert.equal(r.crossAccount.orders, 0);
  for (const f of w.calls.failures) assert.ok(Object.values(f.detail).every((v) => typeof v === "number" || typeof v === "boolean" || /^[A-Za-z0-9_-]+$/.test(String(v))));
});
test("H2 cross-account order collisions are COUNTED only (pan-EU signature), never listed", async () => {
  const [A, B] = [id(1), id(2)];
  const shared = fba(A, "GB", "2026-09-01");
  const w = world({ accounts: [{ id: A, country: "UK" }, { id: B, country: "DE" }], region: "europe-au",
    dataset: { [A]: [shared], [B]: [{ ...fba(B, "DE", "2026-09-01"), amazon_order_id: shared.amazon_order_id }] } });
  const r = await w.run();
  assert.deepEqual(r.crossAccount, { orders: 1, accountsAffected: 2 });
  const p = R.returnsResultPayload(r);
  assert.deepEqual(p.crossAccountOrders, { orders: 1, accountsAffected: 2 }); assert.ok(!JSON.stringify(p).includes(shared.amazon_order_id));
});
test("H3 the status entry goes through the core helper (counts + codes only) and a CLI-level skip writes a MINIMAL entry", () => {
  const e = R.returnsSkipStatusEntry({ region: "us-ca", code: "RETURNS_CONTROLS_UNREADABLE", nowIso: NOW });
  assert.deepEqual(Object.keys(e).sort(), ["bucket", "lastAttemptAt", "lastStatus", "safeErrorCode", "safeErrorStage", "sourceKey"]);
  assert.equal(e.sourceKey, "returns"); assert.equal(e.lastStatus, "failed"); assert.equal(e.safeErrorCode, "RETURNS_CONTROLS_UNREADABLE");
  assert.equal(e.safeErrorStage, "controls");
  assert.equal(R.returnsSkipStatusEntry({ region: "india", code: "RETURNS_RUN_FAILED", nowIso: NOW, stage: "run" }).safeErrorStage, "run");
  assert.equal(R.returnsSkipStatusEntry({ region: "india", code: "406-SECRET-ORDER-1", nowIso: NOW, stage: "anything" }).safeErrorCode, "RETURNS_FAILED", "a non-code never reaches the status row");
  assert.deepEqual(R.countsOnly({ a: 1, b: "406-SECRET-ORDER-1", c: "RETURNS_X", d: true, e: { x: 1 }, f: "2026-10-03" }), { a: 1, c: "RETURNS_X", d: true, f: "2026-10-03" });
});

// The suite can only exit 0 after EVERY test ran and passed: a test whose promise never settles (with no open handle) lets
// the event loop drain silently, so the exit code is 1 until the summary line is printed, and the exit hook names it.
process.exitCode = 1;
let finished = false;
process.on("exit", () => {
  if (!finished) { out("not ok - the event loop drained after " + passed + " of " + tests.length + " test(s): a test never settled"); process.exitCode = 1; }
});
(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); passed += 1; out("ok - " + t.name); }
    catch (e) { failed += 1; out("not ok - " + t.name + "\n  " + String(e && e.stack ? e.stack : e).split("\n").slice(0, 8).join("\n  ")); }
  }
  finished = true;
  out("\nreturns-event-runner: " + passed + "/" + tests.length + " passed");
  process.exitCode = failed === 0 && passed === tests.length ? 0 : 1;
})();
