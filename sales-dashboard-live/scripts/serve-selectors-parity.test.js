// Publication recovery WP4 -- SERVE-SELECTOR PARITY. The pure selectors in lib/server/recovery/serve-selectors.js must
// pick EXACTLY the row the dashboard serve returns (the served row is what a route verifies -- never only the canonical
// row it wrote). Proven offline by running the REAL report-store.js serveSharedReport (refresh=false; its readers
// injected -- no Supabase, no network) and each selector over the SAME fake report_snapshots rows, across a fixture matrix:
//   exact hit; stale scope (date rolled); C3 -- a NEWER row of ANOTHER version hiding an older same-version LKG (the serve
//   shows nothing, the selector returns null 'version-hidden'); an OUT-OF-LINE payload row (payload null + storage path:
//   never served by the shared serve); an exact-TODAY refresh=1 row holding the browser's exact slot (the selector returns
//   it and the default verdict calls it 'exact-identity-row', not fixable); the brand scope (named brand never falls back
//   to ALL) and the portfolio REGION scope; plus the dedicated selectors (scope-latest, exact, the authoritative Brand
//   View inventory, the flag-aware LHv3 live row) against the SAME shared functions the serve uses, the copied stale-scope
//   helpers pinned IDENTICAL to report-store.js, the browser as-of pinned to lib/marketplaces.js, and the default
//   served-row verdict. P12b runs the REAL strict LHv3 resolver (the api's only live-serve path) over the same readers.
//   P15 -- where the REAL handler lives in api/datadoe.js (not exported; importing that Vercel entry evaluates the whole
//   runtime, so it is never run here) -- STATIC PINS: the exact read lines each dedicated selector mirrors (Returns v3 /
//   SKU Movement stored-row reads, the brand-view-brands directory, the Brand View inventory wiring, the LHv3 live gate)
//   and the supabase.js reader semantics the fake table reproduces, printed with their source lines. The SKU Movement
//   serve may return a READ-ONLY re-derive when its freshness probe disagrees (WP6 / WP10 own that). 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// isSupabaseConfigured() captures the env at module load -> dummy creds BEFORE any import (readers are injected).
process.env.SUPABASE_URL = "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = ["test", "svc", "role", "key"].join("-");
const net = { calls: 0 };
globalThis.fetch = async () => { net.calls += 1; throw new Error("network refused in an offline test"); };

const RS = await import("../lib/server/report-store.js");
const SEL = await import("../lib/server/recovery/serve-selectors.js");
const { marketplaceToday } = await import("../lib/marketplaces.js");
const { selectAuthoritativeInventorySnapshot } = await import("../lib/server/reports/brand-view.js");
const { expectedListingHealthV3LiveAsOf, buildListingHealthV3LiveResolver } = await import("../lib/server/reports/listing-health-v3-live-resolver.js");
const { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } = await import("../lib/server/sync/report-publisher.js");
const { REPORT_DERIVATIONS } = await import("../lib/server/sync/report-derivation.js");
const { RETURNS_ADVANCED_VERSION } = await import("../lib/server/reports/returns-advanced.js");
const { paramsHashFor } = RS;

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; out("  ok  " + name); };
const S = (v) => (v == null ? "" : String(v));

// ---- one fake report_snapshots table + the EXACT supabase.js reader semantics over it ---------------------------------
function makeTable() {
  const rows = []; let seq = 0;
  const add = ({ reportKey, accountId, reportVersion, params, payload = undefined, storagePath = null, sra = null }) => {
    const id = "row-" + (++seq);
    const row = {
      id, report_key: reportKey, account_id: accountId, params_hash: paramsHashFor(reportVersion, params),
      params: { reportVersion, ...params }, payload: payload === undefined ? { __row: id } : payload, payload_storage_path: storagePath,
      payload_bytes: 10, source_refreshed_at: sra || new Date(Date.UTC(2026, 8, 20) + seq * 3600000).toISOString(), updated_at: new Date(Date.UTC(2026, 8, 20) + seq * 3600000).toISOString(),
    };
    rows.push(row);
    return row;
  };
  const byAcct = (rk, a) => rows.filter((r) => r.report_key === rk && r.account_id === a);
  const newest = (rs) => rs.slice().sort((x, y) => (x.updated_at < y.updated_at ? 1 : x.updated_at > y.updated_at ? -1 : 0))[0] || null;
  const readers = {
    // supabase.js getReportSnapshot: exact (report_key, account_id, params_hash), limit 1.
    getReportSnapshot: async ({ reportKey, accountId, paramsHash }) => byAcct(reportKey, accountId).find((r) => r.params_hash === paramsHash) || null,
    // supabase.js:453-463 getLatestReportSnapshot: newest by updated_at for (report, account), ANY version / scope.
    getLatestReportSnapshot: async ({ reportKey, accountId }) => newest(byAcct(reportKey, accountId)),
    // supabase.js:507-522 getLatestReportSnapshotForScope: version filter (when given) + params->>k = v for non-null v.
    getLatestReportSnapshotForScope: async ({ reportKey, accountId, reportVersion = null, scope = {} }) => newest(byAcct(reportKey, accountId).filter((r) => (reportVersion == null || S(r.params.reportVersion) === S(reportVersion)) && Object.entries(scope || {}).every(([k, v]) => v == null || (r.params[k] != null && S(r.params[k]) === S(v))))),
    // supabase.js:486-505 getInventorySnapshotCandidates: newest AVAILABLE compact (inline payload filter) + newest overall.
    getInventorySnapshotCandidates: async ({ reportKey, accountId, reportVersion }) => {
      const avail = newest(byAcct(reportKey, accountId).filter((r) => r.payload && S(r.payload.inventoryAvailable) === "true" && (reportVersion == null || S(r.params.reportVersion) === S(reportVersion))));
      const latest = newest(byAcct(reportKey, accountId));
      const o = []; if (avail) o.push(avail); if (latest && (!avail || S(latest.id) !== S(avail.id))) o.push(latest); return o;
    },
  };
  return { rows, add, readers };
}

const fakeRes = () => { const cap = {}; return { res: { status: (c) => ({ json: (b) => { cap.code = c; cap.body = b; } }) }, cap }; };
const noBuild = async () => { throw new Error("build() must never run on a read"); };
// Run the REAL serve and return the served row id (the payload marker) or null ("nothing served").
async function served({ table, reportKey, accountId, reportVersion, params, staleScopeKeys = [] }) {
  const { res, cap } = fakeRes();
  await RS.serveSharedReport({ res, refresh: false, reportKey, reportVersion, accountId, params, label: "Parity", build: noBuild, staleScopeKeys, readers: table.readers });
  if (cap.code !== 200) throw new Error("serve returned " + cap.code);
  if (cap.body.snapshotMissing === true) return null;
  return S(cap.body.__row) || "served-without-marker";
}
const parity = async (name, args, selectorFn, expect) => {
  const serveRow = await served(args);
  const sel = await selectorFn(args);
  const selRow = sel.row ? sel.row.id : null;
  ok(name + " -> serve=" + (serveRow || "nothing") + ", selector=" + (selRow || "null:" + sel.reason), serveRow === selRow && (expect === undefined || expect(sel, serveRow)));
  return sel;
};
const viaLatest = (a) => SEL.selectExactThenLatest({ reportKey: a.reportKey, accountId: a.accountId, reportVersion: a.reportVersion, params: a.params, readers: a.table.readers, computeHash: paramsHashFor });
const viaScope = (a) => SEL.selectExactThenScopeLatest({ reportKey: a.reportKey, accountId: a.accountId, reportVersion: a.reportVersion, params: a.params, staleScopeKeys: a.staleScopeKeys, readers: a.table.readers, computeHash: paramsHashFor });

const ACC = "IN1";
const FBA = { reportKey: "fba-plan", reportVersion: "fba-plan-shared-v1" };

{
  // 1. exact hit.
  const t = makeTable();
  t.add({ ...FBA, accountId: ACC, params: { to: "2026-09-22" } });
  const exact = t.add({ ...FBA, accountId: ACC, params: { to: "2026-09-23" } });
  const sel = await parity("P1 exact identity hit", { table: t, ...FBA, accountId: ACC, params: { to: "2026-09-23" } }, viaLatest, (s) => s.via === "exact" && s.row.id === exact.id);
  ok("P1 the selector returns the served row's IDENTITY only (id, report_key, account_id, params_hash, source_refreshed_at, updated_at -- never a payload)", JSON.stringify(Object.keys(sel.row)) === JSON.stringify(SEL.SERVED_ROW_FIELDS) && !("payload" in sel.row));

  // 2. stale scope: the date rolled, the latest same-version row serves.
  const t2 = makeTable();
  const lkg = t2.add({ ...FBA, accountId: ACC, params: { to: "2026-09-22" } });
  t2.add({ ...FBA, accountId: "IN2", params: { to: "2026-09-24" } });
  await parity("P2 stale scope (exact miss) -> the ONE latest same-version row", { table: t2, ...FBA, accountId: ACC, params: { to: "2026-09-24" } }, viaLatest, (s) => s.via === "latest" && s.row.id === lkg.id);

  // 3. C3: a NEWER row of ANOTHER version hides an older same-version LKG.
  const t3 = makeTable();
  t3.add({ ...FBA, accountId: ACC, params: { to: "2026-09-22" } });
  t3.add({ reportKey: "fba-plan", reportVersion: "fba-plan-shared-v0", accountId: ACC, params: { to: "2026-09-23" } });
  await parity("P3 C3: a newer OTHER-version row hides the older same-version LKG -> the serve shows nothing, selector null 'version-hidden'", { table: t3, ...FBA, accountId: ACC, params: { to: "2026-09-24" } }, viaLatest, (s) => s.row === null && s.reason === "version-hidden");

  // 4. out-of-line payload rows are never served by the shared serve.
  const t4 = makeTable();
  t4.add({ ...FBA, accountId: ACC, params: { to: "2026-09-22" } });
  t4.add({ ...FBA, accountId: ACC, params: { to: "2026-09-23" }, payload: null, storagePath: "snapshots/x.json" });
  await parity("P4 an OUT-OF-LINE exact row (payload in storage) is skipped AND, being the latest, hides the LKG -> nothing, 'out-of-line'", { table: t4, ...FBA, accountId: ACC, params: { to: "2026-09-23" } }, viaLatest, (s) => s.row === null && s.reason === "out-of-line");
  const t4b = makeTable();
  const inl = t4b.add({ ...FBA, accountId: ACC, params: { to: "2026-09-23" } });
  await parity("P4 ... while an inline exact row serves directly", { table: t4b, ...FBA, accountId: ACC, params: { to: "2026-09-23" } }, viaLatest, (s) => s.row.id === inl.id);

  // 5. exact-TODAY refresh=1 row: the browser's exact slot is held by a non-canonical row.
  const t5 = makeTable();
  const canonical = t5.add({ ...FBA, accountId: ACC, params: { to: "2026-09-23" } });
  const today = t5.add({ ...FBA, accountId: ACC, params: { to: "2026-09-24" } });
  const sel5 = await parity("P5 an exact-TODAY refresh row serves (the browser sends today's identity)", { table: t5, ...FBA, accountId: ACC, params: { to: "2026-09-24" } }, viaLatest, (s) => s.via === "exact" && s.row.id === today.id);
  const v5 = SEL.defaultServedVerdict(sel5, SEL.servedRowIdentity(canonical));
  ok("P5 ... the default verdict against the route's canonical row: NOT fixable 'exact-identity-row' (preempted -- alert, never a publish loop)", v5.ok === false && v5.fixable === false && v5.reason === "exact-identity-row");

  // 6. the brand scope (named-brand Daily): a named brand never falls back to ALL, and vice versa.
  const DR = { reportKey: "daily-reporting", reportVersion: "daily-reporting-shared-v2" };
  const t6 = makeTable();
  const all = t6.add({ ...DR, accountId: ACC, params: { from: "2026-03-01", to: "2026-09-20", brand: "ALL" } });
  t6.add({ ...DR, accountId: ACC, params: { from: "2026-03-01", to: "2026-09-21", brand: "Other" } });
  await parity("P6 brand scope: a named-brand request with no same-brand row serves NOTHING (never the ALL / other-brand row)", { table: t6, ...DR, accountId: ACC, params: { from: "2026-03-01", to: "2026-09-24", brand: "Acme" }, staleScopeKeys: ["brand"] }, viaScope, (s) => s.row === null && s.reason === "missing");
  await parity("P6 brand scope: the ALL request serves the latest ALL row", { table: t6, ...DR, accountId: ACC, params: { from: "2026-03-01", to: "2026-09-24", brand: "ALL" }, staleScopeKeys: ["brand"] }, viaScope, (s) => s.row.id === all.id && s.via === "scope-latest");
  await parity("P6 brand scope: a blank brand is the ALL scope (report-store scopeValue)", { table: t6, ...DR, accountId: ACC, params: { from: "2026-03-01", to: "2026-09-24", brand: "" }, staleScopeKeys: ["brand"] }, viaScope, (s) => s.row && s.row.id === all.id);

  // 7. the portfolio REGION scope.
  const PF = { reportKey: "brand-view-portfolio", reportVersion: "brand-view-portfolio-v1" };
  const SCOPE = "portfolio:acme";
  const t7 = makeTable();
  const india = t7.add({ ...PF, accountId: SCOPE, params: { accountIds: "IN1,IN2", brand: "Acme", asOf: "2026-09-22", region: "india" } });
  t7.add({ ...PF, accountId: SCOPE, params: { accountIds: "GB1", brand: "Acme", asOf: "2026-09-23", region: "europe-au" } });
  await parity("P7 portfolio region scope: the india request serves the india LKG (never the newer europe-au row)", { table: t7, ...PF, accountId: SCOPE, params: { accountIds: "IN1,IN2", brand: "Acme", asOf: "2026-09-24", region: "india" }, staleScopeKeys: ["region"] }, viaScope, (s) => s.row.id === india.id);
  await parity("P7 portfolio region scope: a region with no row serves nothing", { table: t7, ...PF, accountId: SCOPE, params: { accountIds: "U1", brand: "Acme", asOf: "2026-09-24", region: "us-ca" }, staleScopeKeys: ["region"] }, viaScope, (s) => s.row === null);
  const t7b = makeTable();
  t7b.add({ ...PF, accountId: SCOPE, params: { accountIds: "IN1", brand: "Acme", asOf: "2026-09-22", region: "india" } });
  t7b.add({ reportKey: PF.reportKey, reportVersion: "brand-view-portfolio-v0", accountId: SCOPE, params: { accountIds: "IN1", brand: "Acme", asOf: "2026-09-23", region: "india" } });
  await parity("P7 the scope reader is VERSION-filtered: an other-version newer row does NOT hide the same-version scope LKG", { table: t7b, ...PF, accountId: SCOPE, params: { accountIds: "IN1", brand: "Acme", asOf: "2026-09-24", region: "india" }, staleScopeKeys: ["region"] }, viaScope, (s) => !!s.row);
  const selEmptyKeys = await viaScope({ table: t3, ...FBA, accountId: ACC, params: { to: "2026-09-24" }, staleScopeKeys: [] });
  ok("P7 empty staleScopeKeys == selectExactThenLatest (the serve's own branch)", selEmptyKeys.row === null && selEmptyKeys.reason === "version-hidden");

  // 8. a reader failure is 'read-failed' (never a guess), exactly where the serve itself would throw.
  const tf = makeTable();
  const failing = { ...tf.readers, getReportSnapshot: async () => { throw new Error("503"); } };
  const sf = await SEL.selectExactThenLatest({ ...FBA, accountId: ACC, params: { to: "2026-09-24" }, readers: failing, computeHash: paramsHashFor });
  let serveThrew = false;
  try { const { res } = fakeRes(); await RS.serveSharedReport({ res, refresh: false, ...FBA, accountId: ACC, params: { to: "2026-09-24" }, label: "x", build: noBuild, readers: failing }); } catch { serveThrew = true; }
  ok("P8 a failing reader -> selector null 'read-failed' (the serve itself errors -- nothing is served)", sf.row === null && sf.reason === "read-failed" && serveThrew);
  let missingReader = null;
  try { await SEL.selectExactThenLatest({ ...FBA, accountId: ACC, params: {}, readers: {}, computeHash: paramsHashFor }); } catch (e) { missingReader = e; }
  ok("P8 a selector without its reader / hash function throws at use (fail closed)", !!missingReader);
}

{
  // 9. the dedicated durable serves: selectLatestForScope (Returns v3 {} / SKU Movement {brand}).
  const RL = { reportKey: "returns-leakage", reportVersion: "returns-leakage-v3" };
  const t = makeTable();
  const v3 = t.add({ ...RL, accountId: ACC, params: { to: "2026-09-22" } });
  t.add({ reportKey: "returns-leakage", reportVersion: "returns-leakage-v2", accountId: ACC, params: { to: "2026-09-23" } });
  const direct = await t.readers.getLatestReportSnapshotForScope({ ...RL, accountId: ACC, scope: {} });
  const s = await SEL.selectLatestForScope({ ...RL, accountId: ACC, scope: {}, readers: t.readers });
  ok("P9 selectLatestForScope (Returns v3): the latest row of THIS version (a newer v2 row never serves as v3)", s.row.id === v3.id && direct.id === v3.id && s.via === "scope-latest");
  const t2 = makeTable();
  t2.add({ reportKey: "sku-movement", reportVersion: "sku-movement/v2", accountId: ACC, params: { asOf: "2026-09-22", brand: "ALL" } });
  const acme = t2.add({ reportKey: "sku-movement", reportVersion: "sku-movement/v2", accountId: ACC, params: { asOf: "2026-09-21", brand: "Acme" } });
  const s2 = await SEL.selectLatestForScope({ reportKey: "sku-movement", reportVersion: "sku-movement/v2", accountId: ACC, scope: { brand: "Acme" }, readers: t2.readers });
  ok("P9 selectLatestForScope (SKU Movement): the brand scope isolates brands", s2.row.id === acme.id);
  const t3 = makeTable();
  t3.add({ ...RL, accountId: ACC, params: { to: "2026-09-22" }, payload: null, storagePath: "x.json" });
  ok("P9 an out-of-line latest row is not served", (await SEL.selectLatestForScope({ ...RL, accountId: ACC, scope: {}, readers: t3.readers })).reason === "out-of-line");

  // 10. selectExact (brand-view-brands directory).
  const BB = { reportKey: "brand-view-brands", reportVersion: "brand-view-brands-v1" };
  const t4 = makeTable();
  const dirRow = t4.add({ ...BB, accountId: ACC, params: { accountId: ACC } });
  const e1 = await SEL.selectExact({ ...BB, accountId: ACC, params: { accountId: ACC }, readers: t4.readers, computeHash: paramsHashFor });
  const e2 = await SEL.selectExact({ ...BB, accountId: "IN9", params: { accountId: "IN9" }, readers: t4.readers, computeHash: paramsHashFor });
  ok("P10 selectExact: the exact identity row (paramsHashFor(version, params)) or null 'missing' -- never a latest fallback", e1.row.id === dirRow.id && e1.row.params_hash === paramsHashFor("brand-view-brands-v1", { accountId: ACC }) && e2.row === null && e2.reason === "missing");

  // 11. selectInventoryAuthoritative: the SHARED selectAuthoritativeInventorySnapshot over the two candidate reads.
  const BI = { reportKey: "brand-inventory", reportVersion: "brand-inventory-shared-v1" };
  const t5 = makeTable();
  const compact = (avail, date) => ({ inventoryByBrandCountry: [], inventoryDate: date, inventoryAvailable: avail, compactVersion: 1 });
  const lkgAvail = t5.add({ ...BI, accountId: ACC, params: { to: "2026-09-21" }, payload: compact(true, "2026-09-21") });
  t5.add({ ...BI, accountId: ACC, params: { to: "2026-09-23" }, payload: compact(false, null) });
  const cands = await t5.readers.getInventorySnapshotCandidates({ ...BI, accountId: ACC });
  const sharedPick = selectAuthoritativeInventorySnapshot(cands);
  const s5 = await SEL.selectInventoryAuthoritative({ accountId: ACC, reportVersion: BI.reportVersion, readers: t5.readers });
  ok("P11 selectInventoryAuthoritative == the shared selectAuthoritativeInventorySnapshot over the same candidates (an available LKG beats a newer placeholder)", !!sharedPick && sharedPick.id === lkgAvail.id && !!s5.row && s5.row.id === sharedPick.id && s5.via === "inventory");
  const s5e = await SEL.selectInventoryAuthoritative({ accountId: "IN9", reportVersion: BI.reportVersion, readers: t5.readers });
  const t6 = makeTable();
  t6.add({ ...BI, accountId: ACC, params: { to: "2026-09-21" }, payload: { notCompact: true } });
  const s6 = await SEL.selectInventoryAuthoritative({ accountId: ACC, reportVersion: BI.reportVersion, readers: t6.readers });
  ok("P11 no candidate rows -> null 'missing' (fixable by publishing); rows but no compact -> 'no-compact'", s5e.row === null && s5e.reason === "missing" && s6.row === null && s6.reason === "no-compact" && selectAuthoritativeInventorySnapshot(await t6.readers.getInventorySnapshotCandidates({ ...BI, accountId: ACC })) === null);
}

{
  // 12. the flag-aware LHv3 live serve.
  const contract = SCHEDULER_LIVE_SNAPSHOT_CONTRACTS["listing-health-v3"];
  const now = Date.UTC(2026, 8, 25, 10, 0, 0);
  ok("P12 lhv3ExpectedLiveAsOf is IDENTICAL to the strict resolver's expectedListingHealthV3LiveAsOf", [now, Date.UTC(2026, 0, 1, 0, 0, 0), Date.UTC(2026, 2, 1, 23, 59, 59), Date.UTC(2028, 1, 29, 12)].every((t) => SEL.lhv3ExpectedLiveAsOf(t) === expectedListingHealthV3LiveAsOf(t)));
  const t = makeTable();
  const d1 = expectedListingHealthV3LiveAsOf(now);
  const row = t.add({ reportKey: "listing-health-v3", reportVersion: "listing-health-v3-shared-v1", accountId: ACC, params: { to: d1 }, payload: { bogus: true } });
  const off = await SEL.selectLhv3({ accountId: ACC, env: { LHV3_PUBLISH_LIVE: "true" }, now: () => now, readers: t.readers, computeHash: paramsHashFor, contract });
  ok("P12 flags off (either one) -> null 'serve-flag-off' (the page serves the preview)", off.row === null && off.reason === "serve-flag-off");
  const resolver = buildListingHealthV3LiveResolver({ getReportSnapshot: t.readers.getReportSnapshot, loadStoragePayload: async () => null, now: () => now });
  const prove = async () => resolver({ accountId: ACC });
  const unproven = await SEL.selectLhv3({ accountId: ACC, env: { LHV3_PUBLISH_LIVE: "true", LISTING_HEALTH_V3: "true" }, now: () => now, readers: t.readers, computeHash: paramsHashFor, contract, prove });
  ok("P12 flags on + the strict resolver REJECTS the row (invalid payload) -> null 'unproven' (the serve falls through to the preview)", unproven.row === null && unproven.reason === "unproven");
  const bare = await SEL.selectLhv3({ accountId: ACC, env: { LHV3_PUBLISH_LIVE: "true", LISTING_HEALTH_V3: "true" }, now: () => now, readers: t.readers, computeHash: paramsHashFor, contract });
  ok("P12 flags on: the EXACT row at {to: UTC D-1} (the resolver's identity) is the served candidate", bare.row && bare.row.id === row.id && bare.row.params_hash === paramsHashFor(contract.liveReportVersion, { to: d1 }));
  ok("P12 the LHv3 contract + derivation used here are the live ones", !!REPORT_DERIVATIONS["listing-health-v3"] && contract.liveReportKey === "listing-health-v3");

  // P12b PARITY against the REAL serving path (P3-7): the api listing-health-v3 action serves live ONLY through the
  // strict resolveListingHealthV3LivePromoted (= buildListingHealthV3LiveResolver over the production readers). With the
  // SAME fake readers: the real resolver ACCEPTS a genuine exact-D-1 promotion -> selectLhv3 (prove = that resolver)
  // selects exactly that row; the real resolver REJECTS a row at another as-of / an invalid payload -> selectLhv3 null.
  const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
  const validLhv3 = (acct, asOf) => {
    const from = addDays(asOf, -29);
    return { accountId: acct, asOf, rows: [], catalogBrands: [], currencies: ["INR"], issuesAvailable: true, window: { kind: "30D", days: 30, from, to: asOf }, coverage: { requestedFrom: from, requestedTo: asOf, coveredFrom: from, coveredTo: asOf, complete: true, gaps: [] }, salesWindowStatus: "complete", inventory: {}, listingCount: 0, issuesUnavailableReason: null, salesSource: "order-line-items" };
  };
  const tv = makeTable();
  const good = tv.add({ reportKey: "listing-health-v3", reportVersion: contract.liveReportVersion, accountId: ACC, params: { to: d1 }, payload: validLhv3(ACC, d1) });
  tv.add({ reportKey: "listing-health-v3", reportVersion: contract.liveReportVersion, accountId: "IN2", params: { to: "2026-09-20" }, payload: validLhv3("IN2", "2026-09-20") });
  const realResolver = buildListingHealthV3LiveResolver({ getReportSnapshot: tv.readers.getReportSnapshot, loadStoragePayload: async () => null, now: () => now });
  const envOn = { LHV3_PUBLISH_LIVE: "true", LISTING_HEALTH_V3: "true" };
  const realOk = await realResolver({ accountId: ACC });
  const selOk = await SEL.selectLhv3({ accountId: ACC, env: envOn, now: () => now, readers: tv.readers, computeHash: paramsHashFor, contract, prove: async () => realResolver({ accountId: ACC }) });
  const realNo = await realResolver({ accountId: "IN2" });
  const selNo = await SEL.selectLhv3({ accountId: "IN2", env: envOn, now: () => now, readers: tv.readers, computeHash: paramsHashFor, contract, prove: async () => realResolver({ accountId: "IN2" }) });
  ok("P12b the REAL strict resolver and selectLhv3 agree over the same readers: a genuine exact-D-1 row is served (the SAME row), an older-as-of row is not (null)", realOk && realOk.ok === true && selOk.row && selOk.row.id === good.id && (!realNo || realNo.ok !== true) && selNo.row === null);
}

{
  // 15. P3-7 -- STATIC PINS of the serving source each selector mirrors where the REAL handler lives in api/datadoe.js
  // (not exported; importing that Vercel entry evaluates the whole sync runtime + credentials, so it is NOT run here).
  // Each pin asserts the EXACT read lines inside the named handler (whitespace-normalized) and prints where they are, so
  // a serve change that the selectors do not follow FAILS this suite instead of silently diverging.
  //   selectLatestForScope         <- serveSelfHealingReturns   (scope {}, RETURNS_ADVANCED_VERSION, inline payload)
  //                                <- serveSelfHealingSkuMovement (scope { brand }, blank -> 'ALL'). NOTE: that serve may
  //                                   instead return a READ-ONLY RE-DERIVE when its cheap freshness probe disagrees with
  //                                   the stored row's provenance -- the SKU Movement route's current predicate / serve
  //                                   token own that decision (WP6 / WP10); the selector returns the STORED row the page
  //                                   serves when it is current.
  //   selectExact                  <- brandViewDirectory (the brand-view-brands directory: exact { accountId } hash, inline)
  //   selectInventoryAuthoritative <- the Brand View serve's getInventorySnapshots / getInventorySelected wiring
  //                                   (getInventorySnapshotCandidates -> the SHARED selectAuthoritativeInventorySnapshot)
  //   selectLhv3                   <- the listing-health-v3 action's double flag gate + DEFAULT-window condition + the
  //                                   strict resolver (a windowed request re-derives the preview; the route verifies the
  //                                   default-window row)
  // plus the supabase.js reader semantics the fake table above reproduces (version filter, non-null scope filters,
  // newest-by-updated_at, limit 1; the available-compact candidate filter).
  const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
  const norm = (s) => s.replace(/\s+/g, " ");
  const bodyOf = (src, header) => { const i = src.indexOf(header); if (i < 0) return null; const j = src.indexOf("\n}\n", i); return { text: src.slice(i, j < 0 ? undefined : j + 2), line: src.slice(0, i).split("\n").length }; };
  // The source line of a snippet (whitespace-flexible), searched inside the handler body when one is named.
  const lineOf = (src, from, s) => {
    const re = new RegExp(s.trim().split(/\s+/).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"));
    const m = re.exec(src.slice(from));
    return m ? src.slice(0, from + m.index).split("\n").length : null;
  };
  const pin = (label, file, header, snippets) => {
    const src = read(file);
    const start = header ? src.indexOf(header) : 0;
    const b = header ? bodyOf(src, header) : { text: src, line: 1 };
    const missing = b ? snippets.filter((s) => !norm(b.text).includes(norm(s))) : snippets;
    const lines = b ? snippets.map((s) => lineOf(src, Math.max(0, start), s)) : [];
    ok("P15 " + label + " -- " + file + (header ? " " + header.replace(/\($/, "") : "") + " L" + lines.map((x) => (x == null ? "?" : x)).join(",") + (missing.length ? " MISSING: " + missing.join(" | ") : ""), !!b && missing.length === 0 && lines.length === snippets.length && lines.every((x) => x != null));
  };
  pin("selectLatestForScope mirrors the Returns v3 stored-row read", "api/datadoe.js", "async function serveSelfHealingReturns(", [
    'const reportKey = "returns-leakage";', "const reportVersion = RETURNS_ADVANCED_VERSION;",
    "const stored = await getLatestReportSnapshotForScope({ reportKey, accountId, reportVersion, scope: {} }).catch(() => null);",
    "if (stored && stored.payload && !refresh) { serveStored(stored); return; }",
  ]);
  pin("selectLatestForScope mirrors the SKU Movement stored-row read (brand scope; the read-only re-derive is WP6/WP10's)", "api/datadoe.js", "async function serveSelfHealingSkuMovement(", [
    'const brand = params && params.brand != null ? params.brand : "ALL";',
    'const brandScope = { brand: String(brand).trim() === "" ? "ALL" : String(brand).trim() };',
    "const stored = await getLatestReportSnapshotForScope({ reportKey, accountId, reportVersion, scope: brandScope }).catch(() => null);",
  ]);
  pin("selectExact mirrors the brand-view-brands directory read", "api/datadoe.js", "async function brandViewDirectory(", [
    "const paramsHash = paramsHashFor(BRAND_VIEW_BRANDS_VERSION, { accountId });",
    "const saved = await getReportSnapshot({ reportKey: BRAND_VIEW_BRANDS_REPORT_KEY, accountId, paramsHash });",
    "if (saved?.payload) {",
  ]);
  // WP10: the serve's dependency-fingerprint readers are built by the SHARED factory (brand-view-dependency-readers.js
  // makeBrandViewDepReaders) over the serve's own getInventorySnapshotCandidates -- so the pinned candidate read + the
  // SHARED selector now live in that factory (same semantics), and the serve pins the wiring into it.
  pin("selectInventoryAuthoritative mirrors the Brand View serve's candidate read (wired into the SHARED dependency-reader factory)", "api/datadoe.js", "function brandViewDepFingerprintReaders(", [
    "return makeBrandViewDepReaders({",
    "getInventoryCandidates: getInventorySnapshotCandidates,",
  ]);
  pin("... the SHARED factory's selected-inventory read: the candidate read + the SHARED selector", "lib/server/sync/brand-view-dependency-readers.js", null, [
    'const BRAND_INVENTORY_LIVE_REPORT_KEY = "brand-inventory";',
    "getInventorySelected: (accountId) => getInventoryCandidates({ reportKey: BRAND_INVENTORY_LIVE_REPORT_KEY, accountId, reportVersion: BRAND_INVENTORY_REPORT_VERSION })",
    ".then((rows) => selectAuthoritativeInventorySnapshot(rows)).catch(() => null),",
  ]);
  pin("... and the Brand View serve's builder reads the SAME candidates", "api/datadoe.js", null, [
    "getInventorySnapshots: ({ reportKey, accountId: id }) => getInventorySnapshotCandidates({ reportKey, accountId: id, reportVersion: BRAND_INVENTORY_REPORT_VERSION }),",
  ]);
  pin("... and the Brand View builder SELECTS through that shared function", "lib/server/reports/brand-view.js", null, [
    "const rows = await getInventorySnapshots({ reportKey: BRAND_INVENTORY_SNAPSHOT_KEY, accountId }).catch(() => null);",
    "selected = selectAuthoritativeInventorySnapshot(rows);",
  ]);
  pin("selectLhv3 mirrors the listing-health-v3 live gate (both flags, the DEFAULT window, the strict resolver)", "api/datadoe.js", null, [
    'const lhv3DefaultWindow = (!req.query.windowPreset || req.query.windowPreset === "30D") && !req.query.windowFrom && !req.query.windowTo && !req.query.windowMonth;',
    'if (process.env.LHV3_PUBLISH_LIVE === "true" && process.env.LISTING_HEALTH_V3 === "true" && lhv3DefaultWindow) {',
    "const live = await resolveListingHealthV3LivePromoted({ accountId: accountScope.accountIds[0] });",
    "if (live && live.ok === true && live.payload && typeof live.payload === \"object\" && !Array.isArray(live.payload)) { res.status(200).json(live.payload); return; }",
  ]);
  pin("the fake getLatestReportSnapshotForScope reproduces supabase.js (version filter, non-null scope filters, newest by updated_at, limit 1)", "lib/server/supabase.js", "export async function getLatestReportSnapshotForScope(", [
    'order: "updated_at.desc",', 'limit: "1",',
    'if (reportVersion != null) query.append("params->>reportVersion", `eq.${reportVersion}`);',
    "for (const [k, v] of Object.entries(scope || {})) {", "if (v == null) continue;", "query.append(`params->>${k}`, `eq.${v}`);", "return rows[0] || null;",
  ]);
  pin("the fake getInventorySnapshotCandidates reproduces supabase.js (the newest AVAILABLE compact + the newest row, deduped)", "lib/server/supabase.js", "export async function getInventorySnapshotCandidates(", [
    '"payload->>inventoryAvailable": "eq.true",', 'if (reportVersion != null) availableQuery.append("params->>reportVersion", `eq.${reportVersion}`);',
    "getLatestReportSnapshot({ reportKey, accountId }).catch(() => null),",
    "if (latest && (!available || String(latest.id) !== String(available.id))) out.push(latest);",
  ]);
  ok("P15 the Returns v3 serve's RETURNS_ADVANCED_VERSION is the version the Returns route's selector reads ('returns-leakage-v3')", RETURNS_ADVANCED_VERSION === "returns-leakage-v3");
}

{
  // 13. the copied stale-scope helpers are IDENTICAL to report-store.js; the browser as-of is lib/marketplaces.js.
  const paramsSet = [{}, { brand: "Acme" }, { brand: "" }, { brand: " ALL " }, { brand: null }, { region: "india" }, { region: "" }, { brand: "Acme", region: "europe-au" }];
  const keysSet = [[], ["brand"], ["region"], ["brand", "region"]];
  const snaps = [null, {}, { params: {} }, { params: { brand: "Acme", reportVersion: "v1" } }, { params: { brand: "ALL", region: "india", reportVersion: "v2" } }, { params: { reportVersion: "v1" } }];
  let same = true;
  for (const p of paramsSet) for (const k of keysSet) {
    if (JSON.stringify(SEL.pickStaleScope(p, k)) !== JSON.stringify(RS.pickStaleScope(p, k))) same = false;
    for (const s of snaps) if (SEL.staleSnapshotMatchesScope(s, p, k) !== RS.staleSnapshotMatchesScope(s, p, k)) same = false;
  }
  for (const s of snaps) for (const v of ["v1", "v2", undefined]) if (SEL.staleSnapshotMatchesReportVersion(s, v) !== RS.staleSnapshotMatchesReportVersion(s, v)) same = false;
  ok("P13 pickStaleScope / staleSnapshotMatchesScope / staleSnapshotMatchesReportVersion are IDENTICAL to report-store.js over the whole matrix", same);
  const times = [Date.UTC(2026, 8, 24, 18, 45), Date.UTC(2026, 8, 24, 23, 30), Date.UTC(2026, 8, 25, 2, 0)];
  ok("P13 browserAsOf is lib/marketplaces.js marketplaceToday (the date the page itself sends) for IN / UK / US / AU", ["IN", "UK", "GB", "US", "AU", "CA"].every((c) => times.every((t) => SEL.browserAsOf(c, new Date(t)) === marketplaceToday(c, new Date(t)))));
}

{
  // 14. the default served-row verdict.
  const exp = { report_key: "fba-plan", account_id: ACC, params_hash: "a".repeat(40), source_refreshed_at: "2026-09-24T05:00:00.000Z" };
  const row = (o = {}) => ({ row: { id: "r", ...exp, updated_at: exp.source_refreshed_at, ...o }, reason: null, via: o.via || "exact" });
  const V = SEL.defaultServedVerdict;
  ok("P14 verdict: equal identity -> ok; nothing served ('missing' / 'no-compact') -> fixable; any other null reason -> not fixable",
    V(row(), exp).ok === true && V({ row: null, reason: "missing" }, exp).fixable === true && V({ row: null, reason: "no-compact" }, exp).fixable === true
    && ["version-hidden", "out-of-line", "scope-mismatch", "serve-flag-off", "read-failed", "unproven"].every((r) => V({ row: null, reason: r }, exp).fixable === false));
  ok("P14 verdict: same identity with an OLDER stamp -> fixable 'stale-sra'; a NEWER stamp -> not fixable 'newer-write'; another account/report -> 'foreign-row'; another hash -> 'exact-identity-row' (exact slot) / 'other-identity'",
    V(row({ source_refreshed_at: "2026-09-24T04:00:00.000Z" }), exp).reason === "stale-sra" && V(row({ source_refreshed_at: "2026-09-24T04:00:00.000Z" }), exp).fixable === true
    && V(row({ source_refreshed_at: "2026-09-24T06:00:00.000Z" }), exp).reason === "newer-write" && V(row({ source_refreshed_at: "2026-09-24T06:00:00.000Z" }), exp).fixable === false
    && V(row({ account_id: "IN2" }), exp).reason === "foreign-row" && V(row({ params_hash: "b".repeat(40) }), exp).reason === "exact-identity-row" && V({ ...row({ params_hash: "b".repeat(40) }), via: "latest" }, exp).reason === "other-identity"
    && V(row(), { ...exp, source_refreshed_at: "" }).ok === false);
}

ok("Z zero network (the serve + every selector ran over injected readers only)", net.calls === 0);
out(`serve-selectors-parity: ${passed} passed`);
