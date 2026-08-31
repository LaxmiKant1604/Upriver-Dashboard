// Date-scope serving for Daily Reporting v2 (serveSharedReport read path). Proves, end-to-end with injected
// readers (no live Supabase), the mission's Phase-3 guarantees:
//   - a request one day BEYOND durable coverage serves the latest PROVEN v2 snapshot, clearly labelled as that
//     earlier as-of (staleScope), never "Nothing saved", never claiming today is covered;
//   - a named-brand request is ISOLATED: it never falls back to the ALL-brand snapshot, and vice versa;
//   - an exact-key hit still serves directly (unchanged);
//   - reports that pass no staleScopeKeys keep the original report-version-only stale behaviour (no regression).
import assert from "node:assert/strict";
import { writeSync } from "node:fs";

// isSupabaseConfigured() captures SUPABASE_URL/KEY at module load -> set dummy creds BEFORE importing the module.
// The readers are fully injected, so no real Supabase request is ever made; only the "configured" gate matters.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost:0";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test-key";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const testAsync = async (name, fn) => { try { await fn(); passed += 1; out("  ok  " + name); } catch (e) { out("FAIL  " + name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; } };

const { serveSharedReport, paramsHashFor } = await import("../lib/server/report-store.js");

const RK = "daily-reporting", V2 = "daily-reporting-shared-v2", ACC = "A01";
const FROM = "2026-03-01", PROVEN = "2026-08-22", TODAY = "2026-08-25";

function makeReaders() {
  const rows = []; let seq = 0;
  const seed = ({ accountId = ACC, from = FROM, to, brand, payload }) => {
    const params = { reportVersion: V2, from, to, brand };
    const paramsHash = paramsHashFor(V2, { from, to, brand });
    rows.push({ reportKey: RK, accountId, paramsHash, params, payload, updated_at: ++seq });
    return paramsHash;
  };
  const forAcct = (reportKey, accountId) => rows.filter((r) => r.reportKey === reportKey && r.accountId === accountId);
  const readers = {
    getReportSnapshot: async ({ reportKey, accountId, paramsHash }) => forAcct(reportKey, accountId).filter((r) => r.paramsHash === paramsHash).slice(-1)[0] || null,
    getLatestReportSnapshot: async ({ reportKey, accountId }) => forAcct(reportKey, accountId).sort((a, b) => b.updated_at - a.updated_at)[0] || null,
    getLatestReportSnapshotForScope: async ({ reportKey, accountId, reportVersion, scope }) =>
      forAcct(reportKey, accountId)
        .filter((r) => (reportVersion == null || r.params.reportVersion === reportVersion)
          && Object.entries(scope || {}).every(([k, v]) => String(r.params[k] ?? "") === String(v)))
        .sort((a, b) => b.updated_at - a.updated_at)[0] || null,
  };
  return { readers, seed };
}
const fakeRes = () => { const cap = {}; return { res: { status: (c) => ({ json: (b) => { cap.code = c; cap.body = b; } }) }, cap }; };
const noBuild = async () => { throw new Error("build() must NEVER be called on a non-refresh read"); };
const req = (over) => ({ refresh: false, reportKey: RK, reportVersion: V2, accountId: ACC, label: "Daily Reporting", build: noBuild, ...over });

await testAsync("a request one day BEYOND coverage serves the latest proven v2, labelled as that earlier as-of (not 'Nothing saved')", async () => {
  const { readers, seed } = makeReaders();
  seed({ to: PROVEN, brand: "ALL", payload: { rows: [{ date: PROVEN, total_sales: 160 }], brandFiltered: false } });
  const { res, cap } = fakeRes();
  await serveSharedReport(req({ res, params: { from: FROM, to: TODAY, brand: "ALL" }, staleScopeKeys: ["brand"], readers }));
  assert.equal(cap.code, 200);
  assert.equal(cap.body.snapshotMissing, undefined, "NOT a 'Nothing saved' response");
  assert.equal(cap.body.rows[0].total_sales, 160, "the proven v2 rows are served");
  assert.equal(cap.body.snapshot.staleScope, true, "labelled stale (an earlier as-of)");
  assert.equal(cap.body.snapshot.savedForParams.to, PROVEN, "honest coverage date = the latest proven date");
  assert.equal(cap.body.snapshot.requestedParams.to, TODAY, "and the requested date it does NOT claim to cover");
});

await testAsync("an EXACT-key match still serves directly (fresh, not stale)", async () => {
  const { readers, seed } = makeReaders();
  seed({ to: PROVEN, brand: "ALL", payload: { rows: [{ date: PROVEN, total_sales: 5 }], brandFiltered: false } });
  const { res, cap } = fakeRes();
  await serveSharedReport(req({ res, params: { from: FROM, to: PROVEN, brand: "ALL" }, staleScopeKeys: ["brand"], readers }));
  assert.equal(cap.body.rows[0].total_sales, 5);
  assert.notEqual(cap.body.snapshot.staleScope, true, "exact match is not labelled stale");
});

await testAsync("a NAMED-brand request is ISOLATED: it never falls back to the ALL-brand snapshot", async () => {
  const { readers, seed } = makeReaders();
  seed({ to: PROVEN, brand: "ALL", payload: { rows: [{ date: PROVEN, total_sales: 999 }], brandFiltered: false } }); // ONLY an ALL snapshot exists
  const { res, cap } = fakeRes();
  // deriveDurable=null: with no named-brand snapshot the honest answer is "waiting", NOT the ALL-brand payload.
  await serveSharedReport(req({ res, params: { from: FROM, to: TODAY, brand: "Acme" }, staleScopeKeys: ["brand"], readers }));
  assert.equal(cap.body.snapshotMissing, true, "named-brand with no snapshot -> honest 'waiting'");
  assert.equal(cap.body.rows, undefined, "the ALL-brand rows are NOT leaked to the named-brand request");
});

await testAsync("a MISSING named-brand snapshot SELF-HEALS: derives from durable evidence, SAVES under the named-brand identity, serves in the same request (zero exports)", async () => {
  const { readers, seed } = makeReaders();
  seed({ to: PROVEN, brand: "ALL", payload: { rows: [{ date: PROVEN, total_sales: 999 }], brandFiltered: false } }); // ALL exists; Acme does not
  // Injectable self-heal store (the same shape production wires): lock + snapshot persistence.
  const snaps = new Map(); const locks = new Set();
  const key = (o) => [o.reportKey, o.accountId, o.paramsHash].join("|");
  const store = {
    claimRefreshLock: async (o) => { const k = key(o); if (locks.has(k)) return false; locks.add(k); return true; },
    releaseRefreshLock: async (o) => { locks.delete(key(o)); },
    getReportSnapshot: async (o) => snaps.get(key(o)) || null,
    saveReportSnapshot: async (o) => { const row = { id: "s", updated_at: "u", source_refreshed_at: o.sourceRefreshedAt, payload: o.payload, params: o.params }; snaps.set(key(o), row); return row; },
    publishSnapshotUpdate: async () => {},
  };
  let derives = 0;
  const deriveDurable = async () => {
    derives += 1; // simulates rederiveDailyV2 clampToProven for brand=Acme: brand-scoped sales + catalog-attributed ads
    return {
      payload: { rows: [{ date: PROVEN, total_sales: 42, ad_sales: 7, ad_spend: 2, ad_clicks: 1 }], brandFiltered: true, adsAvailability: { status: "validated", coveredFrom: FROM, coveredTo: PROVEN, latestMetricDate: PROVEN } },
      sourceRefreshedAt: "2026-08-22T01:00:00.000Z",
      effectiveParams: { from: FROM, to: PROVEN, brand: "Acme" }, latestCompletedDate: PROVEN,
    };
  };
  const { res, cap } = fakeRes();
  await serveSharedReport(req({ res, params: { from: FROM, to: TODAY, brand: "Acme" }, staleScopeKeys: ["brand"], readers, store, deriveDurable }));
  assert.equal(derives, 1, "the self-heal derived exactly once");
  assert.equal(cap.body.snapshotMissing, undefined, "NOT a waiting state -- served in the same request");
  assert.equal(cap.body.rows[0].total_sales, 42, "the BRAND payload is served (never the ALL-brand 999)");
  assert.equal(cap.body.rows[0].ad_sales, 7, "brand-scoped ads are present");
  assert.equal(cap.body.snapshot.rederived, true, "flagged as re-derived");
  const stored = [...snaps.values()][0];
  assert.equal(stored.params.brand, "Acme", "SAVED under the named-brand identity (clamped effective params)");
  assert.equal(stored.params.to, PROVEN, "honest clamped as-of");
});

await testAsync("a named-brand request serves ITS OWN snapshot (not the ALL-brand one, even if ALL is newer)", async () => {
  const { readers, seed } = makeReaders();
  seed({ to: PROVEN, brand: "Acme", payload: { rows: [{ date: PROVEN, total_sales: 42 }], brandFiltered: true } });
  seed({ to: PROVEN, brand: "ALL", payload: { rows: [{ date: PROVEN, total_sales: 999 }], brandFiltered: false } }); // newer
  const { res, cap } = fakeRes();
  await serveSharedReport(req({ res, params: { from: FROM, to: TODAY, brand: "Acme" }, staleScopeKeys: ["brand"], readers }));
  assert.equal(cap.body.rows[0].total_sales, 42, "the Acme snapshot is served");
  assert.equal(cap.body.snapshot.savedForParams.brand, "Acme");
});

await testAsync("an ALL-brand request is NOT polluted by a newer named-brand snapshot", async () => {
  const { readers, seed } = makeReaders();
  seed({ to: PROVEN, brand: "ALL", payload: { rows: [{ date: PROVEN, total_sales: 7 }], brandFiltered: false } });
  seed({ to: PROVEN, brand: "Acme", payload: { rows: [{ date: PROVEN, total_sales: 999 }], brandFiltered: true } }); // newer named-brand
  const { res, cap } = fakeRes();
  await serveSharedReport(req({ res, params: { from: FROM, to: TODAY, brand: "ALL" }, staleScopeKeys: ["brand"], readers }));
  assert.equal(cap.body.rows[0].total_sales, 7, "the ALL snapshot is served, not the newer named-brand one");
  assert.equal(cap.body.snapshot.savedForParams.brand, "ALL");
});

await testAsync("brand '' and 'ALL' are the same scope (a blank brand is the whole-account view)", async () => {
  const { readers, seed } = makeReaders();
  seed({ to: PROVEN, brand: "ALL", payload: { rows: [{ date: PROVEN, total_sales: 3 }], brandFiltered: false } });
  const { res, cap } = fakeRes();
  await serveSharedReport(req({ res, params: { from: FROM, to: TODAY, brand: "" }, staleScopeKeys: ["brand"], readers }));
  assert.equal(cap.body.rows[0].total_sales, 3, "a blank brand request is answered by the ALL snapshot");
});

await testAsync("no regression: with NO staleScopeKeys the report-version-only stale fallback is unchanged", async () => {
  const { readers, seed } = makeReaders();
  seed({ to: PROVEN, brand: "ALL", payload: { rows: [{ date: PROVEN, total_sales: 11 }], brandFiltered: false } });
  const { res, cap } = fakeRes();
  await serveSharedReport(req({ res, params: { from: FROM, to: TODAY, brand: "ALL" }, readers })); // staleScopeKeys omitted
  assert.equal(cap.body.rows[0].total_sales, 11, "the latest same-version snapshot is served as before");
  assert.equal(cap.body.snapshot.staleScope, true);
});

// ---- STALE-BY-COVERAGE-ADVANCE self-heal (named-brand horizon tracks the ACCOUNT, not the brand's last sale) ----
const PROVEN_NEW = "2026-08-30";
function makeSelfHealStore() {
  const snaps = new Map(); const locks = new Set();
  const key = (o) => [o.reportKey, o.accountId, o.paramsHash].join("|");
  const store = {
    claimRefreshLock: async (o) => { const k = key(o); if (locks.has(k)) return false; locks.add(k); return true; },
    releaseRefreshLock: async (o) => { locks.delete(key(o)); },
    getReportSnapshot: async (o) => snaps.get(key(o)) || null,
    saveReportSnapshot: async (o) => { const row = { id: "s", updated_at: "u", source_refreshed_at: o.sourceRefreshedAt, payload: o.payload, params: o.params }; snaps.set(key(o), row); return row; },
    publishSnapshotUpdate: async () => {},
  };
  return { store, snaps, locks, key };
}
const brandDerive = (to, sales) => async () => ({
  payload: { rows: [{ date: to, total_sales: sales }], brandFiltered: true },
  sourceRefreshedAt: to + "T01:00:00.000Z",
  effectiveParams: { from: FROM, to, brand: "Caruso Italy" }, latestCompletedDate: to,
});

await testAsync("STALE named-brand snapshot (as-of behind the account's proven horizon) SELF-HEALS on read (zero exports)", async () => {
  const { readers, seed } = makeReaders();
  seed({ to: PROVEN, brand: "Caruso Italy", payload: { rows: [{ date: PROVEN, total_sales: 10 }], brandFiltered: true } }); // stale as-of PROVEN(08-22)
  const { store, snaps } = makeSelfHealStore();
  let derives = 0; const dd = async () => { derives += 1; return brandDerive(PROVEN_NEW, 55)(); };
  const { res, cap } = fakeRes();
  await serveSharedReport(req({ res, params: { from: FROM, to: TODAY, brand: "Caruso Italy" }, staleScopeKeys: ["brand"], readers, store, deriveDurable: dd, staleWhenParamsToBefore: PROVEN_NEW }));
  assert.equal(derives, 1, "the account's proven horizon advanced past the snapshot's as-of -> re-derived once");
  assert.equal(cap.body.rows[0].total_sales, 55, "the FRESH named-brand payload is served");
  assert.equal(cap.body.snapshot.rederived, true, "flagged re-derived");
  const saved = [...snaps.values()][0];
  assert.equal(saved.params.to, PROVEN_NEW, "saved under the account's proven horizon (not the brand's last sale)");
  assert.equal(saved.params.brand, "Caruso Italy", "brand isolation preserved through the self-heal");
});

await testAsync("FRESH named-brand snapshot (as-of == proven horizon) is REUSED without a write", async () => {
  const { readers, seed } = makeReaders();
  seed({ to: PROVEN_NEW, brand: "Caruso Italy", payload: { rows: [{ date: PROVEN_NEW, total_sales: 33 }], brandFiltered: true } });
  const { store } = makeSelfHealStore();
  let derives = 0; const dd = async () => { derives += 1; return brandDerive(PROVEN_NEW, 99)(); };
  const { res, cap } = fakeRes();
  await serveSharedReport(req({ res, params: { from: FROM, to: PROVEN_NEW, brand: "Caruso Italy" }, staleScopeKeys: ["brand"], readers, store, deriveDurable: dd, staleWhenParamsToBefore: PROVEN_NEW }));
  assert.equal(derives, 0, "as-of is not behind the proven horizon -> NO re-derive, NO write");
  assert.equal(cap.body.rows[0].total_sales, 33, "the existing fresh snapshot is served");
});

await testAsync("stale self-heal with a NOT-READY derive falls back to serving the snapshot as LKG (never blank)", async () => {
  const { readers, seed } = makeReaders();
  seed({ to: PROVEN, brand: "Caruso Italy", payload: { rows: [{ date: PROVEN, total_sales: 10 }], brandFiltered: true } });
  const { store } = makeSelfHealStore();
  const dd = async () => ({ notReady: "not-ready", blockedBy: [{ sourceKey: "order-line-items", blocksSales: true }] });
  const { res, cap } = fakeRes();
  await serveSharedReport(req({ res, params: { from: FROM, to: TODAY, brand: "Caruso Italy" }, staleScopeKeys: ["brand"], readers, store, deriveDurable: dd, staleWhenParamsToBefore: PROVEN_NEW }));
  assert.equal(cap.body.snapshotMissing, undefined, "never a blank page");
  assert.equal(cap.body.rows[0].total_sales, 10, "the stale LKG is served when the derive is not ready");
});

await testAsync("concurrent stale reads self-heal exactly ONCE (serialized by the refresh lock)", async () => {
  const { readers, seed } = makeReaders();
  seed({ to: PROVEN, brand: "Caruso Italy", payload: { rows: [{ date: PROVEN, total_sales: 10 }], brandFiltered: true } });
  const { store } = makeSelfHealStore();
  let derives = 0; const dd = async () => { derives += 1; await new Promise((r) => setTimeout(r, 5)); return brandDerive(PROVEN_NEW, 55)(); };
  const r1 = fakeRes(); const r2 = fakeRes();
  await Promise.all([
    serveSharedReport(req({ res: r1.res, params: { from: FROM, to: TODAY, brand: "Caruso Italy" }, staleScopeKeys: ["brand"], readers, store, deriveDurable: dd, staleWhenParamsToBefore: PROVEN_NEW })),
    serveSharedReport(req({ res: r2.res, params: { from: FROM, to: TODAY, brand: "Caruso Italy" }, staleScopeKeys: ["brand"], readers, store, deriveDurable: dd, staleWhenParamsToBefore: PROVEN_NEW })),
  ]);
  assert.equal(derives, 1, "the lock serializes -> exactly ONE derive/save across concurrent reads");
  // The lock winner serves the FRESH re-derive (55); the loser serves the last-known-good (10) while the winner
  // is mid-derive -- neither ever blanks, and the derive/save happens exactly once.
  for (const x of [r1, r2]) assert.ok(x.cap.body.rows && x.cap.body.rows.length, "neither concurrent read blanks");
  const served = [r1.cap.body.rows[0].total_sales, r2.cap.body.rows[0].total_sales].sort((a, b) => a - b);
  assert.deepEqual(served, [10, 55], "one fresh (55) + one LKG (10) -- exactly one derive, no blank, no double-write");
});

await testAsync("stale self-heal is OFF for reports that never pass staleWhenParamsToBefore (byte-identical stale-scope serve)", async () => {
  const { readers, seed } = makeReaders();
  seed({ to: PROVEN, brand: "Caruso Italy", payload: { rows: [{ date: PROVEN, total_sales: 10 }], brandFiltered: true } });
  const { store } = makeSelfHealStore();
  let derives = 0; const dd = async () => { derives += 1; return brandDerive(PROVEN_NEW, 55)(); };
  const { res, cap } = fakeRes();
  // staleWhenParamsToBefore omitted -> the old stale-scope serve, no self-heal.
  await serveSharedReport(req({ res, params: { from: FROM, to: TODAY, brand: "Caruso Italy" }, staleScopeKeys: ["brand"], readers, store, deriveDurable: dd }));
  assert.equal(derives, 0, "without the proven-horizon signal the stale-scope serve is unchanged");
  assert.equal(cap.body.snapshot.staleScope, true);
  assert.equal(cap.body.rows[0].total_sales, 10);
});

out("\n" + passed + " assertions passed");
