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

out("\n" + passed + " assertions passed");
