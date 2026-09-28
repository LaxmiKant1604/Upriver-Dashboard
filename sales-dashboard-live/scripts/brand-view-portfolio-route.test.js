// Publication recovery WP9 -- the brand-view-portfolio route: the extracted browser-parity directory membership
// (lib/server/reports/brand-directory-membership.js), the worker-side declaration + the shared L1 evidence compose
// (lib/server/recovery/routes/brand-view-portfolio.route.js), the CLI-side release runtime
// (lib/server/sync/routes/brand-view-portfolio.release.js) and the brand-view.js sliceConcurrency knob.
//
// Fully offline: ONE in-memory report_snapshots table (dependency rows + scheduler-v2 shadows + live rows) backs a fake
// READ-ONLY supabase facade (PostgREST-shaped rows: timestamps like "2026-09-24T03:00:01.234567+00:00", trailing zeros
// trimmed), a fake pgReadOnly answering the route's evidence SQL with the SAME semantics (timestamps rendered like
// to_char's "...01.234567Z"), and a faithful lineage world (sync_cycles / sync_report_jobs / shadow CAS / FENCED live CAS)
// driven by the REAL four-gate publisher (publisher-composition.js with build-time overrides), the REAL generic route
// release, the REAL saved-data reconciler two-phase core and the REAL serve selectors. ZERO DataDoe / Supabase / network
// (the global fetch is a refusing stub, asserted untouched).
//   M. membership parity with the browser: the REAL api/datadoe.js sharedSnapshotBrandAccounts (its source text compiled
//      with injected readers -- api/datadoe.js runs side effects on import and does not export it) + the page's region
//      selection (src/lib/region-view.js) + the serve's region filter, vs the extracted function and the route's unit
//      expansion: 'Unassigned', an out-of-line brand-sales payload, a still-loading account, a region filter excluding an
//      unknown-country account, an inactive account, a cross-region display label, a settingUp member; scope ids ==
//      brandViewPortfolioScopeId; snapshotBrandNames pinned verbatim to api/datadoe.js.
//   P. publish end to end: the live row IS the serve's identity with the serve's OWN legacy fingerprint (the api's
//      brandViewDepFingerprintReaders source compiled over the same data) and the serve's OWN payload; re-scan current
//      (served-row verdict + TARGETS v2 tok); a live re-run writes nothing; verify-exact.
//   G. the AND gate (through WP1): one unapproved / not-rolled-out member blocks only its brand units.
//   R. the IN 18:30 UTC rollover changes the token (stable otherwise); a mid-run roll defers with zero writes; the new
//      identity then publishes and the old row stays LKG.
//   I. per-unit isolation + typed deferrals (read failures, REST/SQL divergence, strict storage hydration, membership,
//      evidence SQL failure).
//   C. capacity-exceeded (heap + deadline): typed deferrals, zero writes.
//   S. sliceConcurrency: default unchanged (4 in flight), 1 = one slice at a time, identical payloads.
//   X. the route derive == the composition's deriveBrandViewPortfolio (the materializer's closure) over the same data.
//   V. the route contract (worker + CLI + runtime + pair validate against the REAL contracts), worker/CLI token parity,
//      the UTF-8 BYTE unit target bound (a 32-member portfolio publishes; an over-bound id defers typed before any
//      write), fail-closed build.
//   P6-P10 (P2-2) the PER-UNIT current predicate: a region-token advance re-publishes ONLY the units whose own inputs
//      changed (zero writes for the rest, proven by job lineage + shadow + the stored live manifestToken + served row).
//   H. (P2-3) an ABSENT storage object is a typed failure.  T. (P3-1) latest-row ties are typed + token-visible.
//   A. (P3-2) the durable Ads rows over the build window are evidence.  N. (P3-3) directory values keep the serve's type.
//   A5/A6 (round 3 P2, the WP9 v2 probes Q1a/Q1b) an Ads UPDATE / delete+insert whose updated_at is NOT above the max
//      (count, max and content_rev unchanged) is STALE via the exact content digest -- never current -- then republished.
//   D. (round 3 P2) the SHARED 'adr1:' digest: the JS twin == the Postgres aggregate interpreted from the SQL text itself.
//   K. (round 3 P3-1) derivation-code identity: any version / ACTIVE_ADS_SOURCE_KEY / DERIVE_REV change moves pf1 + pfm2.
// 7-bit ASCII, LF.
import "./_supabase-env-stub.mjs"; // FIRST: supabase.js module consts (its real hydrated reader runs over injected readers only)
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// The network is NEVER reached: every fetch is recorded and refused.
const net = { calls: [] };
globalThis.fetch = async (url, opts = {}) => { net.calls.push(String((opts && opts.method) || "GET") + " " + String(url)); throw new Error("network refused in an offline test"); };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(path.join(ROOT, p), "utf8");

const MEM = await import("../lib/server/reports/brand-directory-membership.js");
const BM = await import("../lib/server/reports/brand-membership.js");
const RSC = await import("../lib/server/reports/region-scope.js");
const BV = await import("../lib/server/reports/brand-view.js");
const FPM = await import("../lib/server/reports/brand-view-dependency-fingerprint.js");
const W = await import("../lib/server/recovery/routes/brand-view-portfolio.route.js");
const C = await import("../lib/server/sync/routes/brand-view-portfolio.release.js");
const RC = await import("../lib/server/recovery/route-contract.js");
const REL = await import("../lib/server/sync/route-publication-release.js");
const SDR = await import("../lib/server/sync/saved-data-reconciler.js");
const TGT = await import("../lib/server/sync/reconcile-targets-output.js");
const SEL = await import("../lib/server/recovery/serve-selectors.js");
const B = await import("../lib/server/sync/publication-binding.js");
const SB = await import("../lib/server/supabase.js");
const COMP = await import("../lib/server/sync/report-materialization-brandview-composition.js");
const DEPR = await import("../lib/server/sync/brand-view-dependency-readers.js");
const RV = await import("../src/lib/region-view.js");
const { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS: LC } = await import("../lib/server/sync/report-publisher.js");
const { REPORT_DERIVATIONS: RD } = await import("../lib/server/sync/report-derivation.js");
const { paramsHashFor } = await import("../lib/server/report-store.js");
const { buildSchedulerV2Publisher } = await import("../lib/server/sync/publisher-composition.js");
const { campaignMappingRevision } = await import("../lib/server/reports/campaign-ads-aggregation.js");
const { ACTIVE_ADS_SOURCE_KEY } = await import("../lib/server/active-ads-source.js");

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; out("  ok  " + name); };
const S = (v) => (v == null ? "" : String(v));
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const J = (v) => B.stableJson(v);
const isAmbiguous = (ident) => !!(ident && ident.ambiguous === true);

// ---- the Postgres EMULATION of the shared Ads-row digest, INTERPRETED FROM THE SQL TEXT (never the JS twin) ----------
// The per-row program (column order + field encodings) is parsed out of adsRowDigestTextSql(""), and the aggregate
// (prefix, count, the md5 lanes: substr start / length and the bit width) out of adsRowsDigestSql(""); each op is then
// evaluated with Postgres semantics: octet_length = UTF-8 bytes, to_char(date, 'YYYY-MM-DD'), to_char(ts at time zone
// 'UTC', '...US"Z"') over the STORED timestamptz (any offset, microseconds kept), md5 hex, ('x' || hex)::bit(n)::bigint,
// sum(bigint) exact (numeric). So an edit of the SQL that the JS twin does not mirror fails the parity pins below.
const pgToCharUs = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(String(s));
  if (!m) throw new Error("emulator: unparsable timestamptz " + s);
  const tz = m[8];
  const off = tz === "Z" ? 0 : (tz[0] === "-" ? -1 : 1) * (Number(tz.slice(1, 3)) * 60 + (tz.length > 3 ? Number(tz.slice(-2)) : 0));
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) - off * 60000;
  return new Date(ms).toISOString().slice(0, 19) + "." + (m[7] || "").padEnd(6, "0") + "Z";
};
function adsDigestProgram() {
  const rowSql = DEPR.adsRowDigestTextSql("");
  const OP = /^(?:octet_length\(coalesce\(([a-z_]+), ''\)\)::text \|\| ':' \|\| coalesce\(\1, ''\) \|\| '\|'|coalesce\(to_char\(([a-z_]+), 'YYYY-MM-DD'\), ''\) \|\| '\|'|coalesce\(to_char\(([a-z_]+) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS\.US"Z"'\), ''\) \|\| '\|')/;
  const ops = [];
  let rest = rowSql;
  while (rest.length) {
    const m = OP.exec(rest);
    if (!m) throw new Error("emulator: unparsed digest SQL at: " + rest.slice(0, 60));
    ops.push(m[1] ? ["L", m[1]] : m[2] ? ["D", m[2]] : ["T", m[3]]);
    rest = rest.slice(m[0].length);
    if (rest.startsWith(" || ")) rest = rest.slice(4);
  }
  const aggSql = DEPR.adsRowsDigestSql("");
  const prefix = (aggSql.match(/^'([a-z0-9]+:)' \|\| count\(account_id\)::text/) || [])[1];
  const lanes = [...aggSql.matchAll(/coalesce\(sum\(\('x' \|\| substr\(md5\((.+?)\), (\d+), (\d+)\)\)::bit\((\d+)\)::bigint\), 0\)::text/g)].map((m) => ({ arg: m[1], start: Number(m[2]), len: Number(m[3]), bits: Number(m[4]) }));
  if (!prefix || lanes.length !== 2 || lanes.some((l) => l.arg !== rowSql || l.bits !== l.len * 4)) throw new Error("emulator: unexpected digest aggregate SQL");
  return { ops, prefix, lanes };
}
const ADS_DIGEST_PROGRAM = adsDigestProgram();
// The emulated SQL aggregate over STORED rows (REST-shaped test rows: text columns, 'YYYY-MM-DD' dates, offset instants).
function pgAdsRowsDigest(rows) {
  const { ops, prefix, lanes } = ADS_DIGEST_PROGRAM;
  const sums = lanes.map(() => 0n);
  let n = 0;
  for (const r of rows) {
    n += 1;
    const text = ops.map(([k, col]) => {
      const v = r[col];
      if (k === "L") { const t = v == null ? "" : String(v); return Buffer.byteLength(t, "utf8") + ":" + t + "|"; }
      if (k === "D") return (v == null ? "" : String(v).slice(0, 10)) + "|";
      return (v == null ? "" : pgToCharUs(v)) + "|";
    }).join("");
    const h = createHash("md5").update(Buffer.from(text, "utf8")).digest("hex");
    lanes.forEach((l, i) => { sums[i] += BigInt("0x" + h.substr(l.start - 1, l.len)); });
  }
  return prefix + n + ":" + sums.map(String).join(":");
}

const PK = "brand-view-portfolio";
const ORG = "org-fp-1";
const EPOCH = "2026-09-24"; // the job epoch (UTC D-1)
const CLOCK0 = Date.UTC(2026, 8, 25, 6, 0, 0); // IN day 2026-09-25
const IN_ASOF = "2026-09-25";
const RS = { NR: "PUBLICATION_NOT_REQUIRED", RV: "READBACK_VERIFIED", DD: "DEFERRED_DEPENDENCY", DP: "DEFERRED_PROVENANCE", FD: "FAILED_DERIVE", FP: "FAILED_PUBLISH" };

// Accounts (UUID-shaped primary ids).
const A1 = "11111111-1111-4111-8111-111111111111"; // IN
const A2 = "22222222-2222-4222-8222-222222222222"; // IN, OUT-OF-LINE brand-sales
const A3 = "33333333-3333-4333-8333-333333333333"; // IN, settingUp, no brand-sales yet ("still loading")
const A4 = "44444444-4444-4444-8444-444444444444"; // unknown country (blank) -> no region
const A5 = "55555555-5555-4555-8555-555555555555"; // IN, INACTIVE (retained, not selectable)
const A6 = "66666666-6666-4666-8666-666666666666"; // IN, settingUp WITH brand-sales (a member the route cannot publish)
const B1 = "77777777-7777-4777-8777-777777777777"; // DE (europe-au)
const DDS = "dd-secondary:99999999-9999-4999-8999-999999999999";

const salesRow = (date, cc, cur, brand, sales, units, seller) => ({ date, marketplace_country_code: cc, currency: cur, product_brand: brand, total_sales: sales, total_units_sold: units, missing_order_value_units: 0, seller_or_vendor_name: seller });

function fixture({ extraDirectory = [], extraSales = {} } = {}) {
  return {
    directory: [
      { id: A1, name: "Bebi IN", country: "IN", currency: "INR", active: true },
      { id: A2, name: "Zeta IN", country: "IN", currency: "INR", active: true },
      { id: A3, name: "Loading IN", country: "IN", currency: "INR", active: true, settingUp: true },
      { id: A4, name: "Unknown mkt", country: "", currency: "INR", active: true },
      { id: A5, name: "Retired IN", country: "IN", currency: "INR", active: false },
      { id: A6, name: "Setup seller", country: "IN", currency: "INR", active: true, settingUp: true },
      { id: B1, name: "Bebi DE", country: "DE", currency: "EUR", active: true },
      { id: DDS, name: "Secondary", country: "IN", currency: "INR", active: true },
      ...extraDirectory,
    ],
    brandSales: {
      [A1]: { rows: [salesRow("2026-09-20", "IN", "INR", "Bebi Born", 100, 2, "Bebi IN"), salesRow("2026-09-21", "IN", "INR", "Unassigned", 40, 1, "Bebi IN"), salesRow("2026-09-22", "IN", "INR", "Acme", 30, 1, "Bebi IN")] },
      [A2]: { outOfLine: true, rows: [salesRow("2026-09-20", "IN", "INR", "Bebi Born", 60, 1, "Zeta IN"), salesRow("2026-09-23", "IN", "INR", "Zeta", 90, 3, "Zeta IN")] },
      [A4]: { rows: [salesRow("2026-09-20", "IN", "INR", "Bebi Born", 10, 1, "Unknown")] },
      [A5]: { rows: [salesRow("2026-09-20", "IN", "INR", "Bebi Born", 10, 1, "Retired")] },
      [A6]: { rows: [salesRow("2026-09-20", "IN", "INR", "Gamma", 10, 1, "Setup")] },
      [B1]: { rows: [salesRow("2026-09-20", "DE", "EUR", "ACME", 20, 1, "Bebi DE"), salesRow("2026-09-21", "DE", "EUR", "Bebi Born", 25, 1, "Bebi DE")] },
      [DDS]: { rows: [salesRow("2026-09-20", "IN", "INR", "Bebi Born", 5, 1, "Secondary")] },
      ...extraSales,
    },
    // A COMPLETE catalog for A1 adds a SELECTOR-only brand ('Omega'): selectable in the page, pins NO membership.
    brandCatalog: { [A1]: { catalogSyncStatus: "complete", catalogBrands: ["Bebi Born", "Omega"] } },
  };
}

// =====================================================================================================================
// The in-memory data world: ONE report_snapshots table + ads / mapping / catalog stores, a REST facade and the SQL fake.
// =====================================================================================================================
function makeDb(fx) {
  const rows = new Map(); const storage = new Map();
  const db = { rows, storage, fail: new Set(), swallow: new Set(), hooks: {}, seq: 0, sqlCalls: 0, restCalls: 0 };
  let micro = BigInt(Date.UTC(2026, 8, 24, 3, 0, 0)) * 1000n;
  db.nextMicro = () => { micro += 1234567n; return micro; };
  // PostgREST shape (trailing fraction zeros trimmed, "+00:00") vs to_char shape (6 digits, "Z").
  db.restTs = (m) => { const ms = Number(m / 1000n); const frac = String(m % 1000000n).padStart(6, "0").replace(/0+$/, ""); return new Date(ms).toISOString().slice(0, 19) + (frac ? "." + frac : "") + "+00:00"; };
  db.sqlTs = (m) => new Date(Number(m / 1000n)).toISOString().slice(0, 19) + "." + String(m % 1000000n).padStart(6, "0") + "Z";
  const key = (rk, a, h) => rk + "|" + a + "|" + h;
  db.key = key;
  db.put = ({ reportKey, accountId, params, payload, outOfLine = false }) => {
    const h = paramsHashFor(String(params.reportVersion || "x"), params);
    const m = db.nextMicro();
    const row = { id: "row-" + (++db.seq), report_key: reportKey, account_id: accountId, params_hash: h, params: clone(params), payload: outOfLine ? null : clone(payload), payload_storage_path: null, payload_bytes: 10, source_refreshed_at: db.restTs(m), updated_at: db.restTs(m), _u: m, _s: m };
    if (outOfLine) { row.payload_storage_path = "report-snapshots/" + reportKey + "/" + accountId + "/" + row.id + ".json"; storage.set(row.payload_storage_path, clone(payload)); }
    rows.set(key(reportKey, accountId, h), row);
    return row;
  };
  // An UPDATE of an existing row (updated_at is trigger-touched on every update).
  db.touch = (row, { payload } = {}) => { const m = db.nextMicro(); row._u = m; row._s = m; row.updated_at = db.restTs(m); row.source_refreshed_at = db.restTs(m); if (payload !== undefined) { if (row.payload_storage_path) storage.set(row.payload_storage_path, clone(payload)); else row.payload = clone(payload); } };
  const byAcct = (rk, a) => [...rows.values()].filter((r) => r.report_key === rk && r.account_id === a);
  const newest = (list) => list.slice().sort((x, y) => (x._u < y._u ? 1 : x._u > y._u ? -1 : 0))[0] || null;
  db.latest = (rk, a) => newest(byAcct(rk, a));
  db.adsState = new Map(); db.adsCoverage = new Map(); db.adsRows = []; db.mappings = []; db.catalog = new Map(); db.catalogPayload = new Map();
  const chk = (name) => { db.restCalls += 1; if (db.hooks.onAny) db.hooks.onAny(name); if (db.fail.has(name)) throw new Error("injected read failure " + name); };
  const strip = (r) => { if (!r) return null; const c = clone({ ...r, _u: undefined, _s: undefined }); delete c._u; delete c._s; return c; };
  const invAvailable = (rk, a, rv) => newest(byAcct(rk, a).filter((r) => r.payload && String(r.payload.inventoryAvailable) === "true" && (rv == null || S(r.params && r.params.reportVersion) === S(rv))));
  db.sb = Object.freeze({
    getLatestReportSnapshot: async ({ reportKey, accountId }) => { if (db.hooks.onLatest) db.hooks.onLatest(reportKey, accountId); chk("latest:" + reportKey + ":" + accountId); return strip(db.latest(reportKey, accountId)); },
    getReportSnapshot: async ({ reportKey, accountId, paramsHash }) => { chk("exact"); return strip(rows.get(key(reportKey, accountId, paramsHash)) || null); },
    getLatestReportSnapshotForScope: async ({ reportKey, accountId, reportVersion = null, scope = {} }) => { chk("scope"); return strip(newest(byAcct(reportKey, accountId).filter((r) => (reportVersion == null || S(r.params && r.params.reportVersion) === S(reportVersion)) && Object.entries(scope || {}).every(([k, v]) => v == null || S(r.params && r.params[k]) === S(v))))); },
    getLatestReportSnapshotMeta: async ({ reportKey, accountId }) => { chk("meta:" + reportKey + ":" + accountId); const r = db.latest(reportKey, accountId); return r ? { params_hash: r.params_hash, source_refreshed_at: r.source_refreshed_at, updated_at: r.updated_at } : null; },
    getInventorySnapshotCandidates: async ({ reportKey, accountId, reportVersion }) => {
      chk("inventory:" + accountId);
      // A SWALLOWED sub-read (the real reader .catch()es both reads into []/null) -- invisible to the serve.
      if (db.swallow.has("inventory:" + accountId)) return [];
      const avail = invAvailable(reportKey, accountId, reportVersion); const latest = db.latest(reportKey, accountId);
      const o = []; if (avail) o.push(strip(avail)); if (latest && (!avail || latest.id !== avail.id)) o.push(strip(latest));
      return o;
    },
    getReportSnapshotStoragePayload: async (p) => { chk("storage:" + p); return storage.has(p) ? clone(storage.get(p)) : null; },
    inlinePayloadUsable: SB.inlinePayloadUsable,
    getDailyAdsCoverage: async (accountId, sourceKey) => {
      db.restCalls += 1;
      if (db.fail.has("ads-coverage:" + accountId)) return { windows: [], status: "missing", latestMetricDate: null, contentRev: null, read: "read-failed", error: "COVERAGE_READ_FAILED" };
      const st = db.adsState.get(accountId + "|" + sourceKey) || null;
      return { windows: (db.adsCoverage.get(accountId + "|" + sourceKey) || []).map(([f, t]) => ({ from: f, to: t })), status: st ? (st.last_status || "missing") : "missing", latestMetricDate: st ? (st.latest_metric_date || null) : null, contentRev: st ? (st.content_rev || null) : null, read: "ok", error: null };
    },
    getCampaignBrandMappings: async ({ organizationFingerprint, connectionId = "primary", accountId }) => { chk("mappings:" + accountId); return db.mappings.filter((m) => m.organization_fingerprint === organizationFingerprint && m.connection_id === connectionId && m.account_id === accountId).map(clone); },
    getSourceSnapshot: async ({ organizationFingerprint, connectionId = "primary", sourceKey, scopeKey }) => {
      db.restCalls += 1;
      if (db.fail.has("catalog")) return { snapshot: null, read: "read-failed", error: "SOURCE_SNAPSHOT_READ_FAILED" };
      const s = db.catalog.get([organizationFingerprint, connectionId, sourceKey, scopeKey].join("|")) || null;
      if (!s) return { snapshot: null, read: "ok", error: null };
      const { _va, ...ptr } = s;
      return { snapshot: { ...clone(ptr), validated_at: db.restTs(_va) }, read: "ok", error: null };
    },
    getSourceSnapshotPayload: async (p) => { chk("catalog-payload"); return { rows: clone(db.catalogPayload.get(p) || []) }; },
    getAdsDailySourceRows: async ({ accountId, sourceKeys, from, to }) => { if (db.hooks.onAdsRows) db.hooks.onAdsRows(accountId); chk("ads-rows:" + accountId); return db.adsRows.filter((r) => r.account_id === accountId && sourceKeys.includes(r.source_key) && r.metric_date >= from && r.metric_date <= to).map(clone); },
    getLatestSourceProvenance: async () => "",
  });
  // ->> semantics: JSON null / missing -> SQL null; scalars -> text. jsonb_typeof: a missing key -> SQL null.
  const jtext = (v) => (v == null ? null : (typeof v === "object" ? JSON.stringify(v) : String(v)));
  const jkind = (v) => (v === undefined ? null : v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "object" ? "object" : typeof v);
  // rank() = 1 semantics: EVERY row at the newest updated_at (a tie returns them all).
  const rankOne = (list) => { let top = null; for (const r of list) if (top === null || r._u > top) top = r._u; return list.filter((r) => r._u === top).sort((x, y) => (x.id < y.id ? -1 : 1)); };
  db.pgReadOnly = async (text, params = []) => {
    const q = W.EVIDENCE_SQL.find((x) => x.text === text);
    if (!q || !RC.isReadOnlyEvidenceSql(text)) throw new Error("unexpected / non-read-only SQL");
    db.sqlCalls += 1;
    if (db.fail.has("sql:" + q.name)) throw new Error("injected sql failure " + q.name);
    switch (q.name) {
      case "account_directory": {
        const d = db.latest("account-directory", "__account-directory__");
        const accts = d && d.payload && Array.isArray(d.payload.accounts) ? d.payload.accounts : [];
        return accts.map((e, i) => {
          const obj = e && typeof e === "object" && !Array.isArray(e) ? e : null;
          return { ord: i + 1, kind: jkind(e), id: jtext(obj ? obj.id : undefined), name: jtext(obj ? obj.name : undefined), name_kind: jkind(obj ? obj.name : undefined), country: jtext(obj ? obj.country : undefined), country_kind: jkind(obj ? obj.country : undefined), inactive: !!obj && obj.active === false, setting_up: !!obj && obj.settingUp === true };
        });
      }
      case "snapshot_latest": {
        const groups = new Map();
        for (const r of rows.values()) if (params[0].includes(r.report_key)) { const k = r.report_key + "|" + r.account_id; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
        return [...groups.values()].flatMap(rankOne).map((r) => ({ report_key: r.report_key, account_id: r.account_id, id: r.id, params_hash: r.params_hash, report_version: r.params && r.params.reportVersion != null ? String(r.params.reportVersion) : "", sra: db.sqlTs(r._s), ua: db.sqlTs(r._u) }));
      }
      case "inventory_available": {
        const groups = new Map();
        for (const r of rows.values()) if (r.report_key === "brand-inventory" && r.payload && String(r.payload.inventoryAvailable) === "true" && S(r.params && r.params.reportVersion) === S(params[0])) { if (!groups.has(r.account_id)) groups.set(r.account_id, []); groups.get(r.account_id).push(r); }
        return [...groups.values()].flatMap(rankOne).map((r) => ({ account_id: r.account_id, id: r.id, params_hash: r.params_hash, report_version: S(r.params && r.params.reportVersion), sra: db.sqlTs(r._s), ua: db.sqlTs(r._u) }));
      }
      case "ads_rows": {
        // count(*) + max(updated_at) + the digest aggregate (interpreted from the SQL text) per account over [$2, $3] for
        // source $1; the window echoed as text; accounts without a row in the window have no result row.
        const by = new Map();
        for (const r of db.adsRows) if (r.source_key === params[0] && r.metric_date >= params[1] && r.metric_date <= params[2]) { const g = by.get(r.account_id) || { n: 0, max: "", rows: [] }; g.n += 1; g.rows.push(r); const u = pgToCharUs(r.updated_at); if (u > g.max) g.max = u; by.set(r.account_id, g); }
        return [...by.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([a, g]) => ({ account_id: a, n: String(g.n), max_ua: g.max, rows_digest: pgAdsRowsDigest(g.rows), win_from: params[1], win_to: params[2] }));
      }
      case "ads_state": return [...db.adsState.entries()].filter(([k]) => k.endsWith("|" + params[0])).map(([k, st]) => ({ account_id: k.split("|")[0], last_status: S(st.last_status), latest_metric_date: S(st.latest_metric_date), content_rev: S(st.content_rev) }));
      case "ads_coverage": return [...db.adsCoverage.entries()].filter(([k]) => k.endsWith("|" + params[0])).flatMap(([k, wins]) => wins.map(([f, t]) => ({ account_id: k.split("|")[0], covered_from: f, covered_to: t })));
      case "campaign_mappings": return db.mappings.filter((m) => m.connection_id === "primary").map((m) => ({ organization_fingerprint: m.organization_fingerprint, account_id: m.account_id, marketplace: m.marketplace, ads_profile_id: m.ads_profile_id, ad_campaign_id: m.ad_campaign_id, canonical_brand_key: m.canonical_brand_key }));
      case "catalog": return [...db.catalog.values()].filter((s) => s.connection_id === "primary" && s.source_key === "product-catalog" && s.scope_key === "__organization").map((s) => ({ organization_fingerprint: s.organization_fingerprint, payload_sha: s.payload_sha, object_path: s.object_path, validated_at: db.sqlTs(s._va) }));
      default: throw new Error("unknown query");
    }
  };
  // ---- seed ----
  db.put({ reportKey: "account-directory", accountId: "__account-directory__", params: { reportVersion: "account-directory-shared-v1" }, payload: { accounts: fx.directory } });
  for (const [acct, bs] of Object.entries(fx.brandSales)) db.put({ reportKey: "brand-sales", accountId: acct, params: { reportVersion: "brand-sales-shared-v1", from: "2025-07-01", to: "2026-09-24" }, payload: { rows: bs.rows, catalogBrands: [] }, outOfLine: bs.outOfLine === true });
  for (const [acct, cat] of Object.entries(fx.brandCatalog || {})) db.put({ reportKey: "brand-catalog", accountId: acct, params: { reportVersion: "brand-catalog-v1" }, payload: cat });
  // Dependencies the portfolio build reads: A1 fba-plan + an AVAILABLE compact inventory shadowed by a NEWER unavailable
  // placeholder (the authoritative selection must still pick the available one); A2 an OUT-OF-LINE listing-health.
  db.put({ reportKey: "fba-plan", accountId: A1, params: { reportVersion: "fba-plan-shared-v1", to: "2026-09-24" }, payload: { rows: [{ asin: "B0A1", brand: "Bebi Born", fbaAvailable: 12 }] } });
  db.put({ reportKey: "brand-inventory", accountId: A1, params: { reportVersion: BV.BRAND_INVENTORY_REPORT_VERSION, to: "2026-09-23" }, payload: { inventoryAvailable: true, inventoryDate: "2026-09-23", inventoryByBrandCountry: [{ brand: "Bebi Born", country: "IN", available: 12 }] } });
  db.put({ reportKey: "brand-inventory", accountId: A1, params: { reportVersion: BV.BRAND_INVENTORY_REPORT_VERSION, to: "2026-09-24" }, payload: { inventoryAvailable: false, inventoryByBrandCountry: [] } });
  db.put({ reportKey: "listing-health", accountId: A2, params: { reportVersion: "listing-health-v1", to: "2026-09-24" }, payload: { rows: [{ asin: "B0A2", brand: "Zeta", fbaAvailable: 3 }] }, outOfLine: true });
  db.adsState.set(A1 + "|" + ACTIVE_ADS_SOURCE_KEY, { last_status: "succeeded", latest_metric_date: "2026-09-23", content_rev: "crev-1" });
  db.adsCoverage.set(A1 + "|" + ACTIVE_ADS_SOURCE_KEY, [["2026-04-01", "2026-09-23"]]);
  db.adsRows.push({ account_id: A1, source_key: ACTIVE_ADS_SOURCE_KEY, metric_date: "2026-09-20", marketplace_country_code: "IN", campaign_id: "C1", campaign_type: "SP", dimension_key: "C1", currency: "INR", dimensions: { ad_campaign_id: "C1", marketplace_country_code: "IN" }, metrics: { ad_spend: 5, ad_sales: 20 }, source_refreshed_at: "2026-09-24T01:00:00+00:00", updated_at: "2026-09-24T01:00:00+00:00" });
  db.mappings.push({ organization_fingerprint: ORG, connection_id: "primary", account_id: A1, marketplace: "IN", ads_profile_id: "", ad_campaign_id: "C1", canonical_brand_key: "bebi born", brand_display_name: "Bebi Born", mapping_source: "MANUAL", updated_at: "2026-09-20T00:00:00+00:00" });
  const catPath = "source-snapshots/product-catalog/sha-cat-1.json";
  db.catalog.set([ORG, "primary", "product-catalog", "__organization"].join("|"), { organization_fingerprint: ORG, connection_id: "primary", source_key: "product-catalog", scope_key: "__organization", object_path: catPath, payload_sha: "sha-cat-1", row_count: 2, payload_bytes: 10, source_request_hash: "h", _va: db.nextMicro() });
  db.catalogPayload.set(catPath, [{ child_asin: "B0A1", product_brand: "Bebi Born" }, { child_asin: "B0A2", product_brand: "Zeta" }]);
  return db;
}

// The REAL supabase.js storage-first hydrated reader over the fake table (exactly what the serve + directory read).
const hydratedOver = (db) => (args) => SB.getLatestReportSnapshotHydrated(args, { readLatest: db.sb.getLatestReportSnapshot, readStorage: db.sb.getReportSnapshotStoragePayload });
// The CLI's durable directory over the same account-directory snapshot (getAccountDirectorySnapshotAccounts semantics).
const durableDirectory = (fx) => REL.buildDurableDirectory({
  rows: fx.directory.filter((a) => !(a && a.settingUp === true)).map((a) => ({ accountId: S(a.accountId || a.id || a.account_id).trim(), country: S(a.country || a.marketCountry || a.marketplace).trim(), currency: a.currency || null, name: a.name || null })).filter((a) => a.accountId),
  resolveRawSellerId: (id) => (id.includes(":") ? "" : id),
}).directory;

// =====================================================================================================================
// The faithful lineage world (cycles / jobs / shadow CAS / FENCED live CAS) over the SAME table + the REAL publisher.
// =====================================================================================================================
function makeWorld(fx = fixture(), { unapproved = [], rollout = null } = {}) {
  const db = makeDb(fx);
  const cycles = new Map(); const jobs = [];
  const n = { cycleCreate: 0, jobInsert: 0, shadowWrite: 0, reconcile: 0, finalize: 0, liveCas: 0, liveWrite: 0, preflight: 0, publish: 0 };
  let seq = 0; let stamp = CLOCK0;
  const w = { fx, db, cycles, jobs, n, unapproved: new Set(unapproved) };
  const allIds = fx.directory.map((a) => S(a.id)).filter((id) => id && !id.includes(":"));
  w.rollout = rollout ? rollout.slice() : allIds.slice();
  w.discovered = allIds.slice();
  w.clock = CLOCK0;
  w.now = () => w.clock;
  const iso = (ms) => new Date(ms).toISOString();
  const cycleById = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  const jobOf = (cycleId, rk, a) => jobs.find((j) => j.cycle_id === cycleId && j.report_key === rk && j.account_id === a) || null;
  const putRow = (row) => { const m = db.nextMicro(); const r = { ...row, _u: m, _s: m, updated_at: db.restTs(m) }; db.rows.set(db.key(row.report_key, row.account_id, row.params_hash), r); return r; };
  w.openCycle = async ({ bucket, cycleDate }) => { const k = bucket + "|" + cycleDate; if (!cycles.has(k)) { n.cycleCreate += 1; stamp += 60000; cycles.set(k, { id: "cyc-" + (++seq), bucket, cycle_date: cycleDate, status: "pending", created_at: iso(stamp) }); } };
  w.getCycleByBucketDate = async (bucket, cycleDate) => { const c = cycles.get(bucket + "|" + cycleDate); return c ? { ...c } : null; };
  w.claimCycle = async (id) => { const c = cycleById(id); if (c && c.status === "pending") { c.status = "running"; return true; } return false; };
  w.readCycle = async (id) => { const c = cycleById(id); return c ? { ...c } : null; };
  w.upsertReportJob = async (job) => {
    if (jobOf(job.cycleId, job.reportKey, job.accountId)) return;
    n.jobInsert += 1;
    jobs.push({ id: "job-" + (++seq), cycle_id: job.cycleId, report_key: job.reportKey, account_id: job.accountId, bucket: job.bucket, connection_id: job.connectionId, report_version: job.reportVersion, depends_on: [...(job.dependsOn || [])], durable_content_deps: [...(job.durableContentDeps || [])], derive_status: "pending", save_status: "pending", validated: false, snapshot_params_hash: null, lease_token: null, created_at: ++seq });
  };
  w.claimLease = async (cycleId, rk, a) => {
    const j = jobOf(cycleId, rk, a);
    if (!j) return { disposition: "not-found", leaseToken: null };
    if (j.validated === true) return { disposition: "already-complete", leaseToken: null, snapshotParamsHash: j.snapshot_params_hash };
    j.derive_status = "running"; j.lease_token = "lt-" + (++seq);
    return { disposition: "claimed", leaseToken: j.lease_token };
  };
  const casWrite = (args, counter) => {
    const k = db.key(args.reportKey, args.accountId, args.paramsHash); const cur = db.rows.get(k);
    const cand = Date.parse(args.sourceRefreshedAt);
    if (cur) {
      const have = Date.parse(cur.source_refreshed_at);
      if (have > cand) return { outcome: "newer-live" };
      if (have === cand) return J(cur.params) === J(args.params) && J(cur.payload) === J(args.payload) ? { outcome: "already-current" } : { outcome: "conflict" };
    }
    n[counter] += 1;
    putRow({ id: (counter === "liveWrite" ? "live-" : "snap-") + (++seq), report_key: args.reportKey, account_id: args.accountId, params_hash: args.paramsHash, params: clone(args.params), payload: clone(args.payload), payload_storage_path: null, payload_bytes: 10, source_refreshed_at: args.sourceRefreshedAt });
    return { outcome: cur ? "replaced" : "inserted" };
  };
  w.saveShadow = async (args) => casWrite(args, "shadowWrite");
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
    c.status = jobs.some((j) => j.cycle_id === cycleId && j.validated === true) ? "succeeded" : "partial";
    return { disposition: "finalized" };
  };
  const latestJobRow = (rk, a) => jobs.filter((x) => x.report_key === rk && x.account_id === a).sort((x, y) => y.created_at - x.created_at)[0] || null;
  w.readLatestJob = async (rk, a) => {
    const j = latestJobRow(rk, a); if (!j) return null;
    const c = cycleById(j.cycle_id);
    return { reportKey: j.report_key, accountId: j.account_id, deriveStatus: j.derive_status, saveStatus: j.save_status, validated: j.validated === true, dependsOn: j.depends_on.map(String), durableContentDeps: j.durable_content_deps.map(String), snapshotParamsHash: j.snapshot_params_hash, latestDataDate: null, cycleStatus: c ? c.status : null, id: j.id, cycleId: j.cycle_id, createdAt: j.created_at };
  };
  w.readSnapshot = async ({ reportKey, accountId, paramsHash }) => { const r = db.rows.get(db.key(reportKey, accountId, paramsHash)); if (!r) return null; const { _u, _s, ...row } = r; return clone(row); };
  w.loadStoragePayload = async (p) => (db.storage.has(p) ? clone(db.storage.get(p)) : null);
  w.fence = { ownerToken: "op-owner", generation: 7 };
  w.liveCas = async (args) => {
    n.liveCas += 1;
    if (args.ownerToken !== w.fence.ownerToken || Number(args.generation) !== Number(w.fence.generation)) return { outcome: "lease-lost", reason: "fence-mismatch" };
    return casWrite(args, "liveWrite");
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
        getPromotedSettings: async () => [{ report_key: PK, publish_enabled: true }],
        getApproval: async (_rk, a) => ({ read: "ok", approved: !w.unapproved.has(String(a)) }),
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
  w.readbackLive = REL.buildRouteLiveReadback({ getReportSnapshot: w.readSnapshot, loadStoragePayload: w.loadStoragePayload, liveContracts: LC, reportDerivations: RD, computeHash: paramsHashFor });
  w.writes = () => n.cycleCreate + n.jobInsert + n.shadowWrite + n.reconcile + n.finalize + n.liveWrite;
  w.directoryMap = durableDirectory(fx);
  return w;
}

const runtimeDeps = (w, region, capacity) => Object.freeze({
  bucket: region, epoch: EPOCH, directory: w.directoryMap, orgFp: ORG, connectionId: "primary",
  sb: w.db.sb, pgReadOnly: w.db.pgReadOnly, selectors: SEL, computeHash: paramsHashFor, liveContracts: LC, reportDerivations: RD,
  now: w.now, strict: true, log: () => {}, ...(capacity ? { capacity } : {}),
});

function buildAll(w, { region = "india", capacity = null, verifyExact = false } = {}) {
  const cliRoute = C.default;
  const runtime = cliRoute.build(runtimeDeps(w, region, capacity));
  const release = REL.buildRoutePublicationRelease({
    route: cliRoute, runtime,
    deps: {
      openCycle: w.openCycle, getCycleByBucketDate: w.getCycleByBucketDate, claimCycle: w.claimCycle, readCycle: w.readCycle,
      upsertReportJob: w.upsertReportJob, claimLease: w.claimLease, saveShadow: w.saveShadow, reconcileSuccess: w.reconcileSuccess, finalizeCycle: w.finalizeCycle,
      readLatestJob: w.readLatestJob, readSnapshot: w.readSnapshot, loadStoragePayload: w.loadStoragePayload,
      publisherFor: w.publisherFor, verifyLease: async () => ({ ok: true }), readbackLive: w.readbackLive,
      liveContracts: LC, reportDerivations: RD, computeHash: paramsHashFor,
      evidenceContext: { directory: w.directoryMap, organizationFingerprint: ORG, connectionId: "primary" },
      now: w.now,
    },
  });
  const adapter = REL.buildRouteReconcileAdapter({ route: cliRoute, runtime, bucket: region, directory: w.directoryMap, liveContracts: LC, readLatestJob: w.readLatestJob, verifyExact });
  const controls = { opened: [], closed: 0 };
  const reconciler = SDR.buildSavedDataReconciler({
    resolveOrg: async () => ({ organizationFingerprint: ORG, connectionId: "primary" }),
    bucketAccounts: async () => (await runtime.scopeTargets({ directory: w.directoryMap, bucket: region })).map((accountId) => ({ accountId })),
    adapter,
    readLatestReportJob: ({ reportKey, accountId }) => w.readLatestJob(reportKey, accountId),
    readShadowSnapshot: (a) => w.readSnapshot(a), readLiveSnapshot: (a) => w.readSnapshot(a), loadStoragePayload: w.loadStoragePayload,
    verifyLiveReadback: w.readbackLive, liveContracts: LC, computeHash: paramsHashFor, reportDerivations: RD,
    runPrepareForUnit: (a) => release.prepareForUnit(a), runPublishForUnit: (a) => release.publishForUnit(a),
    openControls: async (x) => { controls.opened.push(x); return { ok: true }; }, closeControls: async () => { controls.closed += 1; return { ok: true }; },
    reportKeys: [PK], family: "brand-view-portfolio",
  });
  const run = (dryRun = false) => reconciler.run({ bucket: region, requestedAsOf: EPOCH, mode: "periodic", dryRun });
  return { runtime, release, adapter, controls, run };
}

// Unit summary: unitKey -> { state, reason, targetId }.
const unitsOf = (summary) => {
  const m = new Map();
  for (const rec of summary.perAccount || []) for (const u of rec.units || []) m.set(u.unitKey, { state: u.reports[PK] && u.reports[PK].state, reason: u.reports[PK] && u.reports[PK].reason, targetId: u.targetId, owners: u.ownerAccountIds, asOf: u.targetAsOf, served: u.reports[PK] && u.reports[PK].served });
  return m;
};
const UK = (brand) => C.portfolioUnitKey(BM.brandKey(brand));
const scopeOf = (members, brand) => BV.brandViewPortfolioScopeId(members, brand);
const liveHash = (members, brand, asOf, region) => paramsHashFor(BV.BRAND_VIEW_PORTFOLIO_VERSION, { accountIds: [...members].sort().join(","), brand, asOf, region });
const liveRow = (w, members, brand, asOf = IN_ASOF, region = "india") => w.db.rows.get(w.db.key(PK, scopeOf(members, brand), liveHash(members, brand, asOf, region))) || null;

// ---- api/datadoe.js source harness: compile the REAL serve functions over injected readers (no import) -------------
const API = src("api/datadoe.js");
function matchBracket(text, i, open, close) {
  let depth = 0;
  for (; i < text.length; i++) {
    const c = text[i]; const d = text[i + 1];
    if (c === "/" && d === "/") { i = text.indexOf("\n", i); if (i < 0) return -1; continue; }
    if (c === "/" && d === "*") { i = text.indexOf("*/", i + 2) + 1; continue; }
    if (c === "'" || c === '"' || c === "`") { const q = c; i++; while (i < text.length && text[i] !== q) { if (text[i] === "\\") i++; i++; } continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}
function extractFunction(text, header) {
  const start = text.indexOf(header);
  if (start < 0) return null;
  const close = matchBracket(text, text.indexOf("(", start), "(", ")");
  const end = matchBracket(text, text.indexOf("{", close), "{", "}");
  return end > 0 ? text.slice(start, end + 1) : null;
}
const apiConst = (name) => (API.match(new RegExp("^const " + name + " = \"([^\"]+)\";", "m")) || [])[1];
const API_SNAPSHOT_BRAND_NAMES = extractFunction(API, "function snapshotBrandNames(payload)");
const API_SHARED_DIRECTORY = extractFunction(API, "async function sharedSnapshotBrandAccounts(");
function compileApi(bodySrc, scope, ret) {
  const names = Object.keys(scope);
  return new Function(...names, bodySrc + "\nreturn " + ret + ";")(...names.map((k) => scope[k]));
}
// The serve's directory membership function, compiled from api/datadoe.js over the fake table.
function apiDirectory(db) {
  const apiNames = API_SNAPSHOT_BRAND_NAMES ? compileApi(API_SNAPSHOT_BRAND_NAMES, {}, "snapshotBrandNames") : MEM.snapshotBrandNames;
  return compileApi(API_SHARED_DIRECTORY, {
    isSupabaseConfigured: () => true, primaryAccountIdsOnly: BM.primaryAccountIdsOnly, getLatestReportSnapshotHydrated: hydratedOver(db),
    BRAND_CATALOG_REPORT_KEY: apiConst("BRAND_CATALOG_REPORT_KEY"), BRAND_SALES_REPORT_KEY: apiConst("BRAND_SALES_REPORT_KEY"),
    snapshotBrandNames: apiNames, buildBrandAccountMembership: BM.buildBrandAccountMembership, selectorBrandsForAccount: BM.selectorBrandsForAccount,
    membershipFingerprint: BM.membershipFingerprint, brandKey: BM.brandKey, brandDisplay: BM.brandDisplay,
    SAFE_CATALOG_CODES: new Set(), CATALOG_ATTEMPT_PENDING: "PENDING", CATALOG_SOURCE_UNAVAILABLE: "UNAVAILABLE",
    BRAND_DIRECTORY_SNAPSHOT_KEYS: ["brand-catalog", "brand-sales", "fba-plan", "sku-pl"], defaultGetCatalogAttemptState: async () => null,
    // WP10 routes the serve through the shared module: its exports are provided so the compiled source keeps running.
    computeBrandDirectoryMembership: MEM.computeBrandDirectoryMembership,
  }, "sharedSnapshotBrandAccounts");
}
// The serve's Brand View dependency-fingerprint readers (api/datadoe.js campaignMappingsReader + brandViewDepFingerprint-
// Readers), compiled over the fake table.
function apiFingerprintReaders(db) {
  const body = [extractFunction(API, "function campaignMappingsReader()"), extractFunction(API, "function brandViewDepFingerprintReaders()")].join("\n");
  return compileApi(body, {
    primaryOrgFingerprintOrNull: () => ORG, getCampaignBrandMappings: db.sb.getCampaignBrandMappings, getLatestReportSnapshotMeta: db.sb.getLatestReportSnapshotMeta,
    getDailyAdsCoverage: db.sb.getDailyAdsCoverage, ACTIVE_ADS_SOURCE_KEY, campaignMappingRevision, getSourceSnapshot: db.sb.getSourceSnapshot,
    getInventorySnapshotCandidates: db.sb.getInventorySnapshotCandidates, BRAND_INVENTORY_SNAPSHOT_KEY: BV.BRAND_INVENTORY_SNAPSHOT_KEY,
    BRAND_INVENTORY_REPORT_VERSION: BV.BRAND_INVENTORY_REPORT_VERSION, selectAuthoritativeInventorySnapshot: BV.selectAuthoritativeInventorySnapshot,
    makeBrandViewDepReaders: DEPR.makeBrandViewDepReaders,
  }, "brandViewDepFingerprintReaders()");
}
// The serve's portfolio payload build (api/datadoe.js brand-view-portfolio wiring) over the fake table.
function servePortfolioPayload(db, { members, brand, asOf, accountsById }) {
  const catalogRows = async () => {
    const read = await db.sb.getSourceSnapshot({ organizationFingerprint: ORG, connectionId: "primary", sourceKey: "product-catalog", scopeKey: "__organization" });
    const ptr = read && typeof read === "object" && "snapshot" in read ? read.snapshot : read;
    if (!ptr || !ptr.object_path) return null;
    const payload = await db.sb.getSourceSnapshotPayload(ptr.object_path);
    return Array.isArray(payload) ? payload : (payload && Array.isArray(payload.rows) ? payload.rows : null);
  };
  return BV.buildBrandViewPortfolioSnapshot({
    accountIds: members, brand, asOf, accountsById, getSnapshot: hydratedOver(db), getAdsRows: db.sb.getAdsDailySourceRows, getCatalogRows: catalogRows, deadline: null,
    getCampaignMappings: async ({ accountId }) => db.sb.getCampaignBrandMappings({ organizationFingerprint: ORG, connectionId: "primary", accountId }).catch(() => []),
    getInventorySnapshots: ({ reportKey, accountId }) => db.sb.getInventorySnapshotCandidates({ reportKey, accountId, reportVersion: BV.BRAND_INVENTORY_REPORT_VERSION }),
  });
}

// The PAGE + SERVE portfolio identities (admin view) for one region: the account list ('accounts' action: active !==
// false), the brand directory (the REAL api sharedSnapshotBrandAccounts over that list, serialised), the page's region
// intersection (src/lib/region-view.js), the brand label it sends, then the serve's region filter over the directory's
// { name, country } -> { key -> { brand, members, scopeId, params } }.
async function browserServedIdentities(db, fx, region) {
  const accounts = fx.directory.filter((a) => a.active !== false);
  const signature = [...new Set(accounts.map((a) => String(a.id)))].sort();
  const directory = await apiDirectory(db)(signature);
  const payload = BM.serialiseBrandAccountMembership(directory.membership, directory.selectorEntries);
  const regionAccounts = RV.accountsInRegion(accounts, region);
  const regionIds = new Set(regionAccounts.map((a) => String(a.id)));
  const displayByKey = new Map(payload.brands.map((b) => [BM.brandKey(b), b]));
  const outMap = new Map();
  for (const [key, mapped] of Object.entries(payload.brandAccounts)) {
    if (!Array.isArray(mapped) || !mapped.some((id) => regionIds.has(String(id)))) continue;
    const allowed = new Set(mapped.map(String));
    const requested = [...new Set(accounts.filter((a) => allowed.has(String(a.id)) && regionIds.has(String(a.id))).map((a) => String(a.id)))].sort();
    const brand = displayByKey.get(key) || key;
    // serve: accountsById from the account-directory snapshot, then filterAccountIdsToRegion (trusted country).
    const accountsById = Object.fromEntries(fx.directory.filter((e) => requested.includes(String(e.id))).map((e) => [String(e.id), { name: e.name || null, country: e.country || null }]));
    const members = RSC.filterAccountIdsToRegion(requested, accountsById, region);
    if (!members.length) continue;
    outMap.set(key, { brand, members, scopeId: BV.brandViewPortfolioScopeId(members, brand), accountsById });
  }
  return { identities: outMap, directory, payload };
}

// =====================================================================================================================
// V. the route contract + worker/CLI parity + fail-closed build
// =====================================================================================================================
{
  const worker = RC.validateRouteModule(W, { side: "worker" });
  const cli = RC.validateRouteModule(C, { side: "cli", liveContracts: LC, reportDerivations: RD });
  ok("V1 the worker + CLI modules validate against route-contract.js with the REAL live contracts + report derivations, and pair", RC.validateRoutePair(worker, cli, { liveContracts: LC }) === true);
  ok("V1 worker declaration: grain region / unit region-brand / awaits [oli, fba, fba-plan, returns-v3, brand-view-brands] / priority 8 / deadline 720 / hard 840 / childHeapMb 448 = minChildHeapMb 448 / the generic route CLI",
    worker.grain === "region" && worker.unit === "region-brand" && J(worker.awaits) === J(["oli", "fba", "fba-plan", "returns-v3", "brand-view-brands"]) && worker.priority === 8 && worker.deadlineSeconds === 720 && worker.hardTimeoutSeconds === 840
    && worker.childHeapMb === 448 && worker.minChildHeapMb === 448 && worker.cli.script === RC.ROUTE_CLI_SCRIPT && J(worker.publisherKeys) === J([PK]) && J(worker.liveReportKeys) === J(["brand-view-portfolio"]) && cli.stampPolicy === "cycle");
  // Every SELECT list: a timestamptz column appears ONLY inside to_char(... at time zone 'UTC', ...) (a window's ORDER BY
  // inside rank() over (...) is never projected).
  const selectLists = (t) => [...t.matchAll(/select\s+(.*?)\s+from\s/gis)].map((m) => m[1]);
  const bareInstants = (t) => selectLists(t).flatMap((l) => l.replace(/over\s*\([^)]*\)/g, "").replace(/to_char\([^)]*\)/g, "").replace(/\bas\s+[a-z_]+/g, "").match(/\b[a-z_]+_at\b/g) || []);
  const sqlOf = (name) => W.EVIDENCE_SQL.find((q) => q.name === name).text;
  ok("V1 every evidence query is a single read-only SELECT/WITH; instants are read as to_char UTC text and dates as ::text (never a JS Date)",
    W.EVIDENCE_SQL.every((q) => RC.isReadOnlyEvidenceSql(q.text)) && W.EVIDENCE_SQL.every((q) => bareInstants(q.text).length === 0)
    && W.EVIDENCE_SQL.filter((q) => /to_char\((?:[a-z_]+|max\([a-z_]+\)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS\.US"Z"'\)/.test(q.text)).length === 4
    && /latest_metric_date::text/.test(sqlOf("ads_state")) && /covered_from::text/.test(sqlOf("ads_coverage")));
  ok("V1 P3-1: the latest-row reads are rank()-based (never DISTINCT ON) -- a tie at the newest updated_at is VISIBLE",
    ["snapshot_latest", "inventory_available"].every((n) => /rank\(\) over \(partition by [a-z_, ]+ order by updated_at desc\)/.test(sqlOf(n)) && /where id in \(select id from ranked where rnk = 1\)/.test(sqlOf(n)) && !/distinct on/i.test(sqlOf(n))));
  ok("V1 P3-2: ads_rows = per-account count(*) + to_char(max(updated_at)) over ads_daily_source_rows for the ACTIVE source and the build window ($2/$3 cast ONLY to date, echoed DateStyle-independently)",
    /count\(\*\)::text as n/.test(sqlOf("ads_rows")) && /to_char\(max\(updated_at\) at time zone 'UTC'/.test(sqlOf("ads_rows")) && /from public\.ads_daily_source_rows where source_key = \$1 and metric_date >= \$2::date and metric_date <= \$3::date group by account_id/.test(sqlOf("ads_rows"))
    && /to_char\(\$2::date, 'YYYY-MM-DD'\) as win_from, to_char\(\$3::date, 'YYYY-MM-DD'\) as win_to/.test(sqlOf("ads_rows")) && !/\$[23]::text/.test(sqlOf("ads_rows"))
    && J(W.EVIDENCE_SQL.find((q) => q.name === "ads_rows").params({ now: CLOCK0 })) === J([ACTIVE_ADS_SOURCE_KEY, "2026-04-01", IN_ASOF]));
  ok("V1 round-3 P2: ads_rows ALSO selects the EXACT content digest -- the SHARED adsRowsDigestSql fragment embedded VERBATIM (one definition with the JS twin; count + max alone is not a content identity)",
    sqlOf("ads_rows").includes(" " + DEPR.adsRowsDigestSql("") + " as rows_digest, ") && /^'adr1:' \|\| count\(account_id\)::text/.test(DEPR.adsRowsDigestSql("")));
  // The build window IS buildAccountBrandSlice's getAdsRows window (the brand-view.js source expression, pinned).
  const BVSRC = src("lib/server/reports/brand-view.js");
  ok("V1 P3-2: adsBuildWindow == brand-view.js buildAccountBrandSlice's Ads window (monthBack(asOf, 5)?.from || monthStart(asOf) .. asOf), incl. a January as-of",
    /const adsRequestFrom = monthBack\(asOf, 5\)\?\.from \|\| monthStart\(asOf\);/.test(BVSRC) && /getAdsRows\(\{ accountId, sourceKeys: \[BRAND_VIEW_ADS_SOURCE_KEY\], from: adsRequestFrom, to: asOf, maxRows: ADS_MAX_ROWS \}\)/.test(BVSRC)
    && J(W.adsBuildWindow("2026-09-25")) === J({ from: "2026-04-01", to: "2026-09-25" }) && J(W.adsBuildWindow("2027-01-03")) === J({ from: "2026-08-01", to: "2027-01-03" }));
  ok("V1 P3-3: the directory projection carries jsonb_typeof of name + country (the serve reads the JSON VALUES)", /jsonb_typeof\(e\.value->'name'\) as name_kind/.test(sqlOf("account_directory")) && /jsonb_typeof\(e\.value->'country'\) as country_kind/.test(sqlOf("account_directory")));
  const w = makeWorld();
  const runtime = C.default.build(runtimeDeps(w, "india"));
  ok("V2 build(deps) returns a complete, well-formed runtime (validateRouteRuntime)", RC.validateRouteRuntime(runtime, "brand-view-portfolio") === runtime);
  const throwsOn = (over) => { try { C.default.build(Object.freeze({ ...runtimeDeps(w, "india"), ...over })); return false; } catch { return true; } };
  ok("V2 build fails CLOSED on a non-region bucket, a missing pgReadOnly / computeHash / org fingerprint, or a missing supabase reader", throwsOn({ bucket: "us" }) && throwsOn({ pgReadOnly: null }) && throwsOn({ computeHash: null }) && throwsOn({ orgFp: "" }) && throwsOn({ sb: { ...w.db.sb, getInventorySnapshotCandidates: undefined } }));
  ok("V3 MAX_UNIT_TARGET_BYTES equals the saved-data reconciler's unit target bound (the real MAX_TARGET_ID_BYTES constant, 2048 UTF-8 bytes)", C.MAX_UNIT_TARGET_BYTES === Number((src("lib/server/sync/saved-data-reconciler.js").match(/export const MAX_TARGET_ID_BYTES = (\d+);/) || [])[1]) && C.MAX_UNIT_TARGET_BYTES === 2048 && SDR.MAX_TARGET_ID_BYTES === 2048);
  // worker compose == CLI token (the job is claimed with the worker's token; the verify child evaluates the CLI's).
  const rowsByName = {};
  for (const q of W.EVIDENCE_SQL) rowsByName[q.name] = await w.db.pgReadOnly(q.text, q.params({ now: CLOCK0 }));
  const tokens = W.default.evidence.compose(rowsByName, { now: CLOCK0, epoch: EPOCH });
  const ev = await runtime.readScopeEvidence({ scope: ["region:india"], epoch: EPOCH, bucket: "india" });
  const rev = runtime.computeRevision({ accountId: "region:india", evidence: ev.perAccount.get("region:india"), epoch: EPOCH, bucket: "india" });
  ok("V4 worker compose -> region targets with owners = the region's selectable primary accounts; its token EQUALS the CLI's evaluated revision token",
    tokens instanceof Map && tokens.has("region:india") && tokens.has("region:europe-au") && !tokens.has("region:us-ca")
    && J(tokens.get("region:india").owners) === J([A1, A2, A3, A6].sort()) && J(tokens.get("region:europe-au").owners) === J([B1])
    && rev.eligible === true && rev.evidenceToken === tokens.get("region:india").token && /^pf1:[0-9a-f]{64}$/.test(rev.evidenceToken));
  ok("V4 the worker identityAsOf is the IN day the page sends (marketplaceToday('IN'))", W.default.identityAsOf("region:india", { now: CLOCK0 }) === IN_ASOF && W.default.identityAsOf("region:india", { now: Date.UTC(2026, 8, 25, 18, 30) }) === "2026-09-26");
  ok("V5 scope targets: the region target exists only when the durable directory has an account there", J(await runtime.scopeTargets({ directory: w.directoryMap })) === J(["region:india"]) && J(await C.default.build(runtimeDeps(w, "us-ca")).scopeTargets({ directory: w.directoryMap })) === J([]));
  const u = { unitKey: "x", targetId: scopeOf([A1, A2], "Odd::Brand"), liveAccountId: scopeOf([A1, A2], "Odd::Brand"), ownerAccountIds: [A1, A2], targetAsOf: IN_ASOF, reportKeys: [PK] };
  ok("V6 decodePortfolioUnit round-trips (members, brand) from the scope id -- even a brand containing '::' -- and refuses a foreign target", J(C.decodePortfolioUnit(u)) === J({ members: [A1, A2], brand: "Odd::Brand" }) && C.decodePortfolioUnit({ ...u, targetId: "brand-view:" + A1 + "::X" }) === null && C.decodePortfolioUnit({ ...u, ownerAccountIds: [A1] }) === null);
}

// =====================================================================================================================
// M. membership parity with the browser + the serve
// =====================================================================================================================
{
  const fx = fixture();
  const db = makeDb(fx);
  // Pin: the extracted snapshotBrandNames is api/datadoe.js's VERBATIM (or the api already imports the shared module).
  const apiImportsShared = /from "\.\.\/lib\/server\/reports\/brand-directory-membership\.js"/.test(API);
  const memSrc = extractFunction(src("lib/server/reports/brand-directory-membership.js"), "function snapshotBrandNames(payload)");
  ok("M0 snapshotBrandNames is byte-identical to api/datadoe.js's (or api/datadoe.js imports it from brand-directory-membership.js)", apiImportsShared ? !API_SNAPSHOT_BRAND_NAMES : (!!API_SNAPSHOT_BRAND_NAMES && API_SNAPSHOT_BRAND_NAMES === memSrc));
  ok("M0 the api's sharedSnapshotBrandAccounts source was extracted and still builds membership from brand-sales ONLY (primaryAccountIdsOnly scope)", !!API_SHARED_DIRECTORY && /primaryAccountIdsOnly\(accountIds\)/.test(API_SHARED_DIRECTORY) && /reportKey: BRAND_SALES_REPORT_KEY/.test(API_SHARED_DIRECTORY));

  const accounts = fx.directory.filter((a) => a.active !== false);
  const signature = [...new Set(accounts.map((a) => String(a.id)))].sort();
  const api = await apiDirectory(db)(signature);
  // The extracted function over the SAME evidence: each account's hydrated brand-sales payload.
  const perAccountSales = [];
  for (const id of signature) { const snap = await hydratedOver(db)({ reportKey: "brand-sales", accountId: id }); perAccountSales.push({ accountId: id, salesPayload: snap ? snap.payload : null }); }
  const mine = MEM.computeBrandDirectoryMembership(perAccountSales);
  const ser = (m) => J([...m.entries()].map(([k, v]) => [k, v.display, [...v.accounts].sort()]).sort());
  ok("M1 computeBrandDirectoryMembership == the REAL api sharedSnapshotBrandAccounts membership (keys, display labels, account sets) over the same fixtures", ser(mine.membership) === ser(api.membership));
  ok("M1 ... including 'Unassigned', the OUT-OF-LINE brand-sales account (hydrated storage-first), the cross-region display 'ACME' and NO dd-secondary / selector-only membership",
    mine.membership.has("unassigned") && [...mine.membership.get("zeta").accounts].includes(A2) && mine.membership.get("acme").display === "ACME"
    && ![...mine.membership.values()].some((e) => [...e.accounts].includes(DDS)) && !mine.membership.has("omega") && J(mine.selectorKeys) === J([...mine.membership.keys()].sort()));
  const perSalesBrands = MEM.computeBrandDirectoryMembership(perAccountSales.map((e) => ({ accountId: e.accountId, salesBrands: MEM.snapshotBrandNames(e.salesPayload) })));
  ok("M1 a pre-extracted salesBrands entry is equivalent (the serve extracts names inside its per-account read)", ser(perSalesBrands.membership) === ser(mine.membership));

  for (const region of ["india", "europe-au"]) {
    const browser = await browserServedIdentities(db, fx, region);
    const w = { db, directoryMap: durableDirectory(fx), now: () => CLOCK0 };
    const runtime = C.default.build(runtimeDeps(w, region));
    const ev = (await runtime.readScopeEvidence({ scope: ["region:" + region], epoch: EPOCH, bucket: region })).perAccount.get("region:" + region);
    const rev = runtime.computeRevision({ accountId: "region:" + region, evidence: ev });
    const units = await runtime.expandUnits({ accountId: "region:" + region, revision: rev, evidence: ev, requestedAsOf: EPOCH, bucket: region });
    const routeIds = units.filter((x) => x.targetId.startsWith("brand-view-portfolio:")).map((x) => x.targetId).sort();
    const browserIds = [...browser.identities.values()].map((x) => x.scopeId).sort();
    ok(`M2 [${region}] the route's unit scope ids == the page-requested + serve-filtered portfolio identities (brandViewPortfolioScopeId(members, label))`, routeIds.length > 0 && J(routeIds) === J(browserIds));
    const regional = MEM.regionPortfolioMembers(mine.membership, Object.fromEntries(fx.directory.map((e) => [String(e.id), { country: e.country || null }])), region);
    ok(`M2 [${region}] regionPortfolioMembers == the serve's filterAccountIdsToRegion over each brand's sorted members`, J(regional.map((b) => [b.display, b.members])) === J([...browser.identities.values()].map((x) => [x.brand, x.members]).sort((a, b) => (BM.brandKey(a[0]) < BM.brandKey(b[0]) ? -1 : 1))));
    for (const x of units) {
      if (!x.targetId.startsWith("brand-view-portfolio:")) continue;
      const d = C.decodePortfolioUnit(x);
      if (!(d && x.liveAccountId === x.targetId && J(x.ownerAccountIds) === J(d.members) && x.targetAsOf === IN_ASOF && x.unitKey === C.portfolioUnitKey(BM.brandKey(d.brand)))) throw new Error("M2 unit shape " + x.targetId);
    }
    ok(`M2 [${region}] every unit: liveAccountId = targetId = scope id, owners = members (the AND gate), targetAsOf = the IN day, unitKey = sha12(brandKey)`, true);
  }
  const india = await browserServedIdentities(db, fx, "india");
  ok("M3 region filter: the unknown-country account (A4) and the inactive account (A5) never join an india member set; the still-loading account (A3, no brand-sales) pins nothing",
    [...india.identities.values()].every((x) => !x.members.includes(A4) && !x.members.includes(A5) && !x.members.includes(A3)) && J(india.identities.get("bebi born").members) === J([A1, A2]));
  const w = { db, directoryMap: durableDirectory(fx), now: () => CLOCK0 };
  const rt = C.default.build(runtimeDeps(w, "india"));
  const ev = (await rt.readScopeEvidence({ scope: ["region:india"], epoch: EPOCH, bucket: "india" })).perAccount.get("region:india");
  const units = await rt.expandUnits({ accountId: "region:india", revision: rt.computeRevision({ accountId: "region:india", evidence: ev }), evidence: ev, requestedAsOf: EPOCH, bucket: "india" });
  const byKey = new Map(units.map((x) => [x.unitKey, x]));
  ok("M4 the settingUp member's brand ('Gamma', member A6) is a TYPED deferred unit at its real scope id (the page would request it; the route never publishes it)",
    byKey.get(UK("Gamma")).deferred && byKey.get(UK("Gamma")).deferred.reason === "member-setting-up" && byKey.get(UK("Gamma")).targetId === scopeOf([A6], "Gamma"));
  ok("M4 the cross-region label: india's 'acme' unit carries the page's label 'ACME' (the smallest variant across ALL accounts) with member A1 only",
    byKey.get(UK("Acme")).targetId === scopeOf([A1], "ACME") && !byKey.get(UK("Acme")).deferred);
  const n = SDR.normalizeRouteUnits(units, { accountId: "region:india", requestedAsOf: EPOCH, reportKeys: [PK] });
  ok("M4 the expansion passes the reconciler's unit validation (owners grammar, unique keys, bounded targets)", n.ok === true && n.units.length === 5);
}

// =====================================================================================================================
// P. publish end to end + serve parity + current re-scan + zero-write re-run + verify-exact
// =====================================================================================================================
{
  const w = makeWorld();
  const { runtime, controls, run } = buildAll(w);
  const s1 = await run(false);
  const u1 = unitsOf(s1);
  ok("P1 the region run publishes every publishable brand (Bebi Born, Unassigned, Zeta) and defers typed (ACME: the label no member sold -> build failed; Gamma: settingUp member)",
    s1.counts.targetsPublished === 3 && s1.counts.targetsDeferred === 2 && s1.counts.targetsFailed === 0 && s1.outcome === "partial"
    && u1.get(UK("Bebi Born")).state === RS.RV && u1.get(UK("Unassigned")).state === RS.RV && u1.get(UK("Zeta")).state === RS.RV
    && u1.get(UK("Acme")).state === RS.DD && u1.get(UK("Acme")).reason === "derive-not-ready:portfolio-build-failed"
    && u1.get(UK("Gamma")).state === RS.DP && u1.get(UK("Gamma")).reason === "member-setting-up");
  ok("P1 controls opened ONCE for the prepared units' members (the AND-gate owners) and the publisher key", controls.opened.length === 1 && J(controls.opened[0]) === J({ owners: [A1, A2], publisherKeys: [PK] }) && controls.closed === 1);
  const live = liveRow(w, [A1, A2], "Bebi Born");
  const browser = await browserServedIdentities(w.db, w.fx, "india");
  const idBB = browser.identities.get("bebi born");
  ok("P2 the live row IS the page's identity: account_id = the serve's scope id, params_hash = paramsHashFor(brand-view-portfolio-v1, { accountIds, brand, asOf, region })",
    !!live && live.account_id === idBB.scopeId && live.params_hash === liveHash(idBB.members, idBB.brand, IN_ASOF, "india") && live.params.reportVersion === "brand-view-portfolio-v1" && live.params.accountIds === [A1, A2].join(",") && live.params.region === "india" && live.params.asOf === IN_ASOF);
  const serveFp = await FPM.collectBrandViewDependencyFingerprint({ scope: "portfolio", brand: "Bebi Born", accountIds: idBB.members, reportVersion: BV.BRAND_VIEW_PORTFOLIO_VERSION, readers: apiFingerprintReaders(w.db) });
  ok("P2 params.depFingerprint == the SERVE's own legacy fingerprint (api/datadoe.js brandViewDepFingerprintReaders compiled over the same data) -> the 'updating' flag keeps working", live.params.depFingerprint === serveFp && /^[0-9a-f]{40}$/.test(serveFp));
  const servePayload = await servePortfolioPayload(w.db, { members: idBB.members, brand: "Bebi Born", asOf: IN_ASOF, accountsById: idBB.accountsById });
  ok("P2 the live payload == the payload the serve's own build produces for the page's request (region portfolio parity; sliceConcurrency 1 vs the serve's 4)", J(live.payload) === J(servePayload) && live.payload.scope === "portfolio" && live.payload.brand === "Bebi Born");
  ok("P2 the payload sums BOTH members (A2 hydrated from storage) and took the AUTHORITATIVE available compact inventory date (not the newer unavailable placeholder)", live.payload.accounts.length === 2 && live.payload.series.length === 1 && live.payload.series[0].s === 160 && live.payload.coverage.inventoryDate === "2026-09-23");
  const tokenNow = runtime.computeRevision({ accountId: "region:india", evidence: (await runtime.readScopeEvidence({ scope: ["region:india"], epoch: EPOCH, bucket: "india" })).perAccount.get("region:india") }).evidenceToken;
  ok("P2 the live row stores the region evidence token (liveParamsExtra; never hashed)", live.params.evidenceToken === tokenNow);
  const s2 = await run(true);
  const u2 = unitsOf(s2);
  ok("P3 re-scan: every published unit is PUBLICATION_NOT_REQUIRED via the exact binding AND the served-row verdict (served = the canonical live row)",
    [UK("Bebi Born"), UK("Unassigned"), UK("Zeta")].every((k) => u2.get(k).state === RS.NR && u2.get(k).served && u2.get(k).served.h === w.db.rows.get(w.db.key(PK, u2.get(k).targetId, u2.get(k).served.h)).params_hash));
  const line = TGT.parseTargetsLine(TGT.formatTargetsLine({ v: 2, route: "brand-view-portfolio", summary: { ...s2, bucket: "india", requestedAsOf: EPOCH, dryRun: true } }));
  ok("P3 TARGETS v2: ONE region target 'region:india' whose tok is the L1 token and whose units are sha12 keys (never brand text)",
    line && line.targets.length === 1 && line.targets[0].id === "region:india" && line.targets[0].tok === tokenNow && line.targets[0].units.every((x) => /^[0-9a-f]{12}$/.test(x.u)) && !JSON.stringify(line).includes("Bebi"));
  const writes = w.writes(); const opened = controls.opened.length;
  const s3 = await run(false);
  ok("P4 a live re-run over current data performs ZERO writes and opens ZERO control windows (ACME re-derives read-only and defers again)", s3.counts.targetsAlreadyCurrent === 3 && s3.counts.targetsPublished === 0 && w.writes() === writes && controls.opened.length === opened);
  const ve = buildAll(w, { verifyExact: true });
  const s4 = await ve.run(true);
  ok("P5 verify-exact: the re-resolved unit manifest is carried by each latest job's durable_content_deps -> still current", [UK("Bebi Born"), UK("Unassigned"), UK("Zeta")].every((k) => unitsOf(s4).get(k).state === RS.NR));
  ok("P5b the live row stores the PER-UNIT manifest token (liveParamsExtra manifestToken == the shadow's == in the job lineage)",
    live.params.manifestToken && /^pfm2:[0-9a-f]{64}$/.test(live.params.manifestToken) && (await w.readLatestJob(PK, live.account_id)).durableContentDeps.includes(live.params.manifestToken));
  // P2-2: a change of ONE account's input (A2's brand-sales) moves the REGION token, but only the units whose OWN inputs
  // changed re-publish; the A1-only 'Unassigned' unit is proven current by its unchanged per-unit manifest (zero writes).
  const unassigned0 = liveRow(w, [A1], "Unassigned");
  const jobsBefore = w.jobs.filter((j) => j.account_id === scopeOf([A1], "Unassigned")).length;
  const shadowsBefore = [...w.db.rows.values()].filter((r) => r.report_key === "scheduler-v2/" + PK && r.account_id === scopeOf([A1], "Unassigned")).length;
  const a2 = w.db.latest("brand-sales", A2);
  w.db.touch(a2, { payload: { rows: [salesRow("2026-09-20", "IN", "INR", "Bebi Born", 61, 1, "Zeta IN"), salesRow("2026-09-23", "IN", "INR", "Zeta", 90, 3, "Zeta IN")], catalogBrands: [] } });
  const s5 = await run(true);
  const u5 = unitsOf(s5);
  const tok5 = s5.perAccount[0].evidenceToken;
  ok("P6 an A2-only change moves the region token; the units containing A2 (Bebi Born, Zeta) are STALE, the A1-only Unassigned unit is PUBLICATION_NOT_REQUIRED 'unit-manifest-unchanged' with the served row == its live row",
    tok5 !== tokenNow && u5.get(UK("Bebi Born")).state === "STALE" && u5.get(UK("Zeta")).state === "STALE"
    && u5.get(UK("Unassigned")).state === RS.NR && u5.get(UK("Unassigned")).reason === C.UNIT_MANIFEST_UNCHANGED && u5.get(UK("Unassigned")).served && u5.get(UK("Unassigned")).served.id === unassigned0.id);
  const s6 = await run(false);
  const unassigned1 = liveRow(w, [A1], "Unassigned");
  ok("P6 ... the live run re-publishes ONLY the changed units (Bebi Born carries A2's corrected sales); Unassigned gets ZERO writes (same live row + stamp, no new job, no new shadow)",
    s6.counts.targetsPublished === 2 && liveRow(w, [A1, A2], "Bebi Born").payload.series[0].s === 161 && unitsOf(s6).get(UK("Unassigned")).state === RS.NR
    && unassigned1.id === unassigned0.id && unassigned1.source_refreshed_at === unassigned0.source_refreshed_at && unassigned1.params.evidenceToken === unassigned0.params.evidenceToken
    && w.jobs.filter((j) => j.account_id === scopeOf([A1], "Unassigned")).length === jobsBefore
    && [...w.db.rows.values()].filter((r) => r.report_key === "scheduler-v2/" + PK && r.account_id === scopeOf([A1], "Unassigned")).length === shadowsBefore);
  const s6b = await run(true);
  ok("P6 ... and a re-scan is fully current at the NEW region token (Unassigned via its manifest, the re-published units via the exact binding)",
    s6b.perAccount[0].evidenceToken === tok5 && [UK("Bebi Born"), UK("Unassigned"), UK("Zeta")].every((k) => unitsOf(s6b).get(k).state === RS.NR)
    && unitsOf(s6b).get(UK("Bebi Born")).reason === null && unitsOf(s6b).get(UK("Unassigned")).reason === C.UNIT_MANIFEST_UNCHANGED);
  const ve2 = await buildAll(w, { verifyExact: true }).run(true);
  ok("P6 ... verify-exact agrees: every unit current (the re-resolved per-unit manifest is carried by each latest job's lineage)", [UK("Bebi Born"), UK("Unassigned"), UK("Zeta")].every((k) => unitsOf(ve2).get(k).state === RS.NR));
  // ANY member input change re-publishes its unit (A1's fba-plan re-saved: every A1 unit; Zeta untouched).
  w.db.touch(w.db.latest("fba-plan", A1));
  const s7 = await run(true);
  ok("P8 a MEMBER input change (A1 fba-plan re-saved) re-arms every unit containing A1 (Bebi Born, Unassigned) and ONLY those (Zeta current by manifest)",
    unitsOf(s7).get(UK("Bebi Born")).state === "STALE" && unitsOf(s7).get(UK("Unassigned")).state === "STALE" && unitsOf(s7).get(UK("Zeta")).state === RS.NR && unitsOf(s7).get(UK("Zeta")).reason === C.UNIT_MANIFEST_UNCHANGED);
  const s8 = await run(false);
  ok("P8 ... and the live run re-publishes exactly those two", s8.counts.targetsPublished === 2 && liveRow(w, [A1], "Unassigned").id !== unassigned0.id);
  // A member's Ads state (content_rev), its directory name, the org catalog: each is a unit input.
  w.db.adsState.get(A1 + "|" + ACTIVE_ADS_SOURCE_KEY).content_rev = "crev-2";
  const s9 = await run(true);
  ok("P8 a member's Ads content_rev bump re-arms only A1's units", unitsOf(s9).get(UK("Bebi Born")).state === "STALE" && unitsOf(s9).get(UK("Unassigned")).state === "STALE" && unitsOf(s9).get(UK("Zeta")).state === RS.NR);
  await run(false);
  const dir = w.db.latest("account-directory", "__account-directory__");
  w.db.touch(dir, { payload: { accounts: w.fx.directory.map((e) => (e.id === A2 ? { ...e, name: "Zeta IN renamed" } : e)) } });
  const s10 = await run(true);
  ok("P8 a member's directory NAME change re-arms only that member's units (A2: Bebi Born + Zeta; Unassigned current)", unitsOf(s10).get(UK("Bebi Born")).state === "STALE" && unitsOf(s10).get(UK("Zeta")).state === "STALE" && unitsOf(s10).get(UK("Unassigned")).state === RS.NR);
  await run(false);
  // A label DECIDER outside the region (B1, DE) adds a variant of 'bebi born' that does NOT change the label: the Bebi
  // Born unit re-arms (its decider digests changed); the other units stay current.
  w.db.touch(w.db.latest("brand-sales", B1), { payload: { rows: [salesRow("2026-09-20", "DE", "EUR", "ACME", 20, 1, "Bebi DE"), salesRow("2026-09-21", "DE", "EUR", "Bebi Born", 25, 1, "Bebi DE"), salesRow("2026-09-22", "DE", "EUR", "bebi born", 5, 1, "Bebi DE")], catalogBrands: [] } });
  const s11 = await run(true);
  ok("P9 an out-of-region label decider's variant change (label unchanged) re-arms ONLY the brand it decides (Bebi Born); Unassigned + Zeta current",
    unitsOf(s11).get(UK("Bebi Born")).state === "STALE" && unitsOf(s11).get(UK("Bebi Born")).targetId === scopeOf([A1, A2], "Bebi Born") && unitsOf(s11).get(UK("Unassigned")).state === RS.NR && unitsOf(s11).get(UK("Zeta")).state === RS.NR);
  await run(false);
  // Never on tokens alone: a region advance over a unit whose LIVE row no longer is its job's promotion re-publishes.
  w.db.touch(w.db.latest("brand-sales", B1));
  const zl = liveRow(w, [A2], "Zeta");
  zl.payload = { ...zl.payload, brand: "Zeta" , series: [] };
  const s12 = await run(true);
  ok("P10 NEVER on the manifest alone: a unit whose live payload no longer equals its job's shadow is STALE across a region advance (the exact binding against the job lineage fails)", unitsOf(s12).get(UK("Zeta")).state === "STALE" && unitsOf(s12).get(UK("Unassigned")).state === RS.NR);
  await run(false);
  w.db.touch(w.db.latest("brand-sales", B1));
  const ul = liveRow(w, [A1], "Unassigned");
  ul.params = { ...ul.params, manifestToken: "pfm2:" + "0".repeat(64) };
  const s13 = await run(true);
  ok("P10 ... and a live row whose STORED manifestToken is not the unit's current manifest is STALE (the stored extra is checked, not trusted)", unitsOf(s13).get(UK("Unassigned")).state === "STALE");
  ok("P7 zero network / zero DataDoe across every run", net.calls.length === 0);
}

// =====================================================================================================================
// G. the AND gate (WP1): one unapproved / not-rolled-out member blocks ONLY its brand units
// =====================================================================================================================
{
  const w = makeWorld(fixture(), { unapproved: [A2] });
  const { run } = buildAll(w);
  const s = await run(false);
  const u = unitsOf(s);
  ok("G1 member A2 unapproved: Bebi Born (A1+A2) and Zeta (A2) are refused at the publisher's GATE 4 (typed FAILED_PUBLISH, zero live writes); Unassigned (A1 only) publishes",
    u.get(UK("Bebi Born")).state === RS.FP && /preflight-publish-not-approved/.test(u.get(UK("Bebi Born")).reason) && u.get(UK("Zeta")).state === RS.FP
    && u.get(UK("Unassigned")).state === RS.RV && !liveRow(w, [A1, A2], "Bebi Born") && !liveRow(w, [A2], "Zeta") && !!liveRow(w, [A1], "Unassigned"));
  const w2 = makeWorld(fixture(), { rollout: [A2, A3, A6, B1] });
  const s2 = await buildAll(w2).run(false);
  const u2 = unitsOf(s2);
  ok("G2 member A1 not rolled out: every unit containing A1 is 'account-disabled' (GATE 3 AND over members); Zeta (A2 only) publishes",
    /preflight-account-disabled/.test(u2.get(UK("Bebi Born")).reason) && /preflight-account-disabled/.test(u2.get(UK("Unassigned")).reason) && u2.get(UK("Zeta")).state === RS.RV && !!liveRow(w2, [A2], "Zeta"));
}

// =====================================================================================================================
// R. the IN 18:30 UTC rollover
// =====================================================================================================================
{
  const w = makeWorld();
  const at = (h, m, s = 0, ms = 0) => Date.UTC(2026, 8, 25, h, m, s, ms);
  // ONE evidence read per clock (the SQL params' Ads window and the compose share `now`, exactly like the CLI read).
  const tok = async (now) => { const rowsByName = {}; for (const q of W.EVIDENCE_SQL) rowsByName[q.name] = await w.db.pgReadOnly(q.text, q.params({ now })); return W.composeRegionTokens(rowsByName, { now }).get("region:india").token; };
  ok("R1 the token changes EXACTLY at the IN midnight (18:30 UTC) and is stable within an IN day", (await tok(at(18, 29, 59, 999))) !== (await tok(at(18, 30))) && (await tok(at(6, 0))) === (await tok(at(18, 29, 59, 999))) && (await tok(at(18, 30))) === (await tok(at(23, 59))));
  {
    // A params / compose clock split across the IN midnight (rows counted over the OLD window, composed at the NEW as-of)
    // fails the region closed (typed), never a token over the wrong window.
    const rowsByName = {};
    for (const q of W.EVIDENCE_SQL) rowsByName[q.name] = await w.db.pgReadOnly(q.text, q.params({ now: at(18, 29) }));
    const ev = W.composeBrandViewPortfolioEvidence(rowsByName, { now: at(18, 31) }).get("india");
    ok("R1 P3-2: Ads rows counted over another window than the compose's as-of -> 'ads-rows-window-mismatch' (the region is ineligible, typed)", ev.problems.includes("ads-rows-window-mismatch") && C.default.build(runtimeDeps(w, "india")).computeRevision({ accountId: "region:india", evidence: ev }).reason === "ads-rows-window-mismatch");
  }
  const { run } = buildAll(w);
  await run(false); // 06:00 -> the 2026-09-25 identities are live
  const oldRow = liveRow(w, [A1, A2], "Bebi Born");
  // A mid-run roll at ENTRY: the scan binds the pre-roll revision; the prepare re-reads after the roll.
  w.db.touch(w.db.latest("brand-sales", A1));
  w.clock = at(18, 29);
  const b = buildAll(w);
  const scan = await b.run(true);
  const rec = scan.perAccount[0];
  const unitBB = rec.units.find((x) => x.unitKey === UK("Bebi Born"));
  const revision = REL.normalizeRouteRevision(b.runtime.computeRevision({ accountId: "region:india", evidence: (await b.runtime.readScopeEvidence({ scope: ["region:india"], epoch: EPOCH, bucket: "india" })).perAccount.get("region:india") }));
  const pubUnit = { unitKey: unitBB.unitKey, targetId: unitBB.targetId, liveAccountId: unitBB.liveAccountId, ownerAccountIds: unitBB.ownerAccountIds, targetAsOf: unitBB.targetAsOf, reportKeys: [PK] };
  w.clock = at(18, 30, 1);
  const writes0 = w.writes();
  const p1 = await b.release.prepareForUnit({ unit: pubUnit, revision, epoch: EPOCH, region: "india", bucket: "india" });
  ok("R2 a roll between the scan and the prepare DEFERS (typed, retryable) with ZERO writes", p1.ok === false && p1.reason === "revision-advanced-at-entry" && SDR.statusFromRelease(p1) === RS.DD && w.writes() === writes0);
  // A roll DURING the derive (between the entry resolve and the pre-write re-resolve).
  w.clock = at(18, 29, 30);
  const revision2 = REL.normalizeRouteRevision(b.runtime.computeRevision({ accountId: "region:india", evidence: (await b.runtime.readScopeEvidence({ scope: ["region:india"], epoch: EPOCH, bucket: "india" })).perAccount.get("region:india") }));
  w.db.hooks.onAdsRows = () => { w.clock = at(18, 30, 5); };
  const p2 = await b.release.prepareForUnit({ unit: pubUnit, revision: revision2, epoch: EPOCH, region: "india", bucket: "india" });
  w.db.hooks.onAdsRows = null;
  ok("R3 a roll DURING the derive defers before the first write (revision / as-of advanced) with ZERO writes", p2.ok === false && (p2.reason === "revision-advanced-before-write" || p2.reason === "asof-rolled") && w.writes() === writes0);
  w.clock = at(18, 31);
  const s = await buildAll(w).run(false);
  const fresh = liveRow(w, [A1, A2], "Bebi Born", "2026-09-26");
  ok("R4 after the roll the region publishes the NEW identity (asOf 2026-09-26) and the previous day's row stays as LKG (untouched)",
    s.counts.targetsPublished === 3 && !!fresh && fresh.params.asOf === "2026-09-26" && !!liveRow(w, [A1, A2], "Bebi Born") && liveRow(w, [A1, A2], "Bebi Born").id === oldRow.id && liveRow(w, [A1, A2], "Bebi Born").source_refreshed_at === oldRow.source_refreshed_at);
}

// =====================================================================================================================
// I. per-unit isolation + typed deferrals (strict reads, REST/SQL divergence, membership, evidence SQL)
// =====================================================================================================================
{
  const w = makeWorld();
  w.db.fail.add("ads-rows:" + A2);
  const s = await buildAll(w).run(false);
  const u = unitsOf(s);
  ok("I1 ONE brand unit's failure is isolated: A2's Ads read fails -> Bebi Born + Zeta defer 'evidence-read-failed:ads-rows' (zero writes for them) while Unassigned publishes",
    u.get(UK("Bebi Born")).reason === "derive-not-ready:evidence-read-failed:ads-rows" && u.get(UK("Zeta")).state === RS.DD && u.get(UK("Unassigned")).state === RS.RV
    && !liveRow(w, [A1, A2], "Bebi Born") && !!liveRow(w, [A1], "Unassigned") && w.n.shadowWrite === 1);

  const w2 = makeWorld();
  w2.db.swallow.add("inventory:" + A1);
  const u2 = unitsOf(await buildAll(w2).run(false));
  ok("I2 a SWALLOWED inventory read (the serve reader would silently return []) is caught by the SQL identity cross-check -> 'evidence-advanced:brand-inventory' for A1's units; Zeta publishes",
    u2.get(UK("Bebi Born")).reason === "bundle-evidence-advanced:brand-inventory" && u2.get(UK("Unassigned")).state === RS.DD && u2.get(UK("Zeta")).state === RS.RV);

  const w3 = makeWorld();
  w3.db.fail.add("ads-coverage:" + A1);
  const u3 = unitsOf(await buildAll(w3).run(false));
  ok("I3 a fail-soft Ads coverage read (read:'read-failed') never feeds a published fingerprint -> 'evidence-read-failed:ads-coverage' for A1's units only", u3.get(UK("Bebi Born")).reason === "bundle-evidence-read-failed:ads-coverage" && u3.get(UK("Zeta")).state === RS.RV);

  const w4 = makeWorld();
  w4.db.fail.add("catalog");
  const s4 = await buildAll(w4).run(false);
  ok("I4 an unreadable org catalog pointer defers EVERY unit typed (never a catalog-less payload) with zero writes", [...unitsOf(s4).values()].filter((x) => !/member-setting-up/.test(S(x.reason))).every((x) => x.reason === "bundle-evidence-read-failed:catalog") && w4.writes() === 0);

  const w5 = makeWorld();
  const lh = w5.db.latest("listing-health", A2);
  w5.db.fail.add("storage:" + lh.payload_storage_path);
  const u5 = unitsOf(await buildAll(w5).run(false));
  ok("I5 STRICT storage hydration: A2's out-of-line listing-health cannot be hydrated (the serve would silently use the empty inline stub) -> A2's units defer; A1-only units publish",
    u5.get(UK("Zeta")).reason === "derive-not-ready:evidence-read-failed:snapshot:listing-health" && u5.get(UK("Unassigned")).state === RS.RV);

  const w6 = makeWorld();
  w6.db.fail.add("storage:" + w6.db.latest("brand-sales", A2).payload_storage_path);
  const s6 = await buildAll(w6).run(false);
  const u6 = unitsOf(s6);
  ok("I6 an unreadable member brand-sales payload makes the MEMBERSHIP unprovable -> ONE typed sentinel deferral for the region target (never a silently-shrunk unit set), zero writes",
    u6.size === 1 && u6.get(C.MEMBERSHIP_SENTINEL_UNIT_KEY).state === RS.DD && u6.get(C.MEMBERSHIP_SENTINEL_UNIT_KEY).reason === "membership-read-failed" && w6.writes() === 0);

  const w7 = makeWorld();
  w7.db.fail.add("sql:ads_state");
  const s7 = await buildAll(w7).run(false);
  ok("I7 an unreadable evidence query fails the run CLOSED (typed DURABLE_SOURCE_UNREADABLE, zero writes, zero units)", s7.ok === false && s7.outcome === "failed" && /^DURABLE_SOURCE_UNREADABLE: brand-view-portfolio evidence-read-failed:ads_state/.test(s7.code) && w7.writes() === 0);

  const w8 = makeWorld();
  const dir = w8.db.latest("account-directory", "__account-directory__");
  w8.db.touch(dir, { payload: { accounts: [...w8.fx.directory, { id: "bad id!", name: "x", country: "IN", active: true }] } });
  const s8 = await buildAll(w8).run(false);
  ok("I8 a selectable in-region directory id that can never own controls fails the region target closed ('directory-id-invalid', typed, zero writes)", s8.perAccount[0].reports[PK].reason === "directory-id-invalid" && w8.writes() === 0);
}

// =====================================================================================================================
// C. capacity-exceeded (typed, deferred, zero writes)
// =====================================================================================================================
{
  const w = makeWorld();
  const s = await buildAll(w, { capacity: { heapStats: () => ({ used: 95, limit: 100 }) } }).run(false);
  const u = unitsOf(s);
  ok("C1 a build above the heap high-water mark stops BETWEEN slices -> 'capacity-exceeded:heap' (DEFERRED, alertable) with ZERO shadow / live writes",
    [UK("Bebi Born"), UK("Unassigned"), UK("Zeta"), UK("Acme")].every((k) => u.get(k).state === RS.DD && u.get(k).reason === "derive-not-ready:capacity-exceeded:heap") && w.n.shadowWrite === 0 && w.n.liveWrite === 0);
  const w2 = makeWorld();
  w2.db.hooks.onAny = () => { w2.clock += 5; };
  const s2 = await buildAll(w2, { capacity: { unitBudgetMs: 1 } }).run(false);
  ok("C2 a unit over its wall-clock budget -> 'capacity-exceeded:deadline' (typed), zero writes", [UK("Bebi Born"), UK("Zeta")].every((k) => unitsOf(s2).get(k).reason === "derive-not-ready:capacity-exceeded:deadline") && w2.n.shadowWrite === 0);
  ok("C3 the defaults are the documented constants (heap high-water 0.85, unit budget 300 s)", C.PORTFOLIO_HEAP_HIGH_WATER === 0.85 && C.PORTFOLIO_UNIT_BUDGET_MS === 300000);
}

// =====================================================================================================================
// S. sliceConcurrency (brand-view.js): default unchanged, 1 = one slice at a time, identical payloads
// =====================================================================================================================
{
  const ids = ["a1", "a2", "a3", "a4", "a5", "a6"];
  const mk = () => {
    const st = { inflight: 0, max: 0 };
    const getSnapshot = async ({ reportKey, accountId }) => {
      if (reportKey !== "brand-sales") return null;
      st.inflight += 1; st.max = Math.max(st.max, st.inflight);
      await new Promise((r) => setTimeout(r, 2));
      st.inflight -= 1;
      return { params: { from: "2026-09-01", to: "2026-09-24" }, payload: { rows: [salesRow("2026-09-20", "IN", "INR", "Bebi Born", 10 + accountId.length, 1, accountId)] } };
    };
    return { st, getSnapshot };
  };
  const build = async (extra) => { const m = mk(); const p = await BV.buildBrandViewPortfolioSnapshot({ accountIds: ids, brand: "Bebi Born", asOf: IN_ASOF, accountsById: {}, getSnapshot: m.getSnapshot, getAdsRows: async () => [], ...extra }); return { p, max: m.st.max }; };
  const dflt = await build({});
  const one = await build({ sliceConcurrency: 1 });
  const two = await build({ sliceConcurrency: 2 });
  const bad = await build({ sliceConcurrency: 0 });
  ok("S1 omitted sliceConcurrency == PORTFOLIO_SLICE_CONCURRENCY (4 slices in flight: byte-identical to before); 1 reads ONE slice at a time; an invalid value falls back to the default",
    BV.PORTFOLIO_SLICE_CONCURRENCY === 4 && dflt.max === 4 && one.max === 1 && two.max === 2 && bad.max === 4);
  ok("S1 the assembled payload never depends on the slice concurrency", J(dflt.p) === J(one.p) && J(one.p) === J(two.p) && J(two.p) === J(bad.p));
}

// =====================================================================================================================
// X. the route derive == the composition's deriveBrandViewPortfolio (the scheduler materializer's closure)
// =====================================================================================================================
{
  const w = makeWorld();
  const runtime = C.default.build(runtimeDeps(w, "india"));
  const ev = (await runtime.readScopeEvidence({ scope: ["region:india"], epoch: EPOCH, bucket: "india" })).perAccount.get("region:india");
  const units = await runtime.expandUnits({ accountId: "region:india", revision: runtime.computeRevision({ accountId: "region:india", evidence: ev }), evidence: ev, requestedAsOf: EPOCH, bucket: "india" });
  const unit = units.find((x) => x.unitKey === UK("Bebi Born"));
  const bundle = await runtime.resolveBundle(unit, { strict: true, epoch: EPOCH, bucket: "india" });
  const derived = await runtime.derive(bundle.bundle, { unit, epoch: EPOCH, bucket: "india", strict: true });
  const composition = COMP.buildBrandViewMaterializationRelease({
    getConnections: () => [{ id: "primary", apiKey: "k", organizationFingerprint: ORG }],
    getSnapshotHydrated: hydratedOver(w.db), getAdsRows: w.db.sb.getAdsDailySourceRows,
    getSnapshotMeta: w.db.sb.getLatestReportSnapshotMeta, getAdsCoverageState: w.db.sb.getDailyAdsCoverage,
    getSourceSnap: w.db.sb.getSourceSnapshot, loadSourcePayload: w.db.sb.getSourceSnapshotPayload, getMappings: w.db.sb.getCampaignBrandMappings,
    getInventoryCandidates: w.db.sb.getInventorySnapshotCandidates, getProvenance: async () => null,
  });
  const materializer = await composition.deriveBrandViewPortfolio({ accountIds: bundle.bundle.members, brand: bundle.bundle.brand, asOf: bundle.bundle.asOf, region: "india", accountsById: bundle.bundle.accountsById });
  ok("X1 the route derive's payload + fingerprint == the materializer's own deriveBrandViewPortfolio over the same data (strict readers change failure handling only, never content)",
    bundle.eligible === true && !!derived.payload && J(derived.payload) === J(materializer.payload) && bundle.depFingerprint === materializer.depFingerprint);
  ok("X1 the bundle binds the unit's identity: members, the page's label, the IN day, the region, and the PER-UNIT pfm2 manifest token", J(bundle.bundle.members) === J([A1, A2]) && bundle.bundle.brand === "Bebi Born" && bundle.bundle.asOf === IN_ASOF && bundle.bundle.region === "india" && /^pfm2:[0-9a-f]{64}$/.test(bundle.manifestToken) && J(bundle.deps) === J([bundle.evidenceToken]));
  const params = runtime.identityParams(unit, { bundle: bundle.bundle, epoch: EPOCH });
  ok("X2 identityParams -> the portfolio contract's live identity + targetIdentity (members/brand/asOf/region)", J(LC[PK].liveParams(params)) === J({ accountIds: [A1, A2].join(","), brand: "Bebi Born", asOf: IN_ASOF, region: "india" }) && LC[PK].targetIdentity(params, unit.targetId) === true);
}

// =====================================================================================================================
// V7. the unit target bound is the core's UTF-8 BYTE bound (2048: every btree index over account_id stays below Postgres's
//     2704-byte tuple cap): a real 32-member portfolio publishes; an id over the bound -- in BYTES, even when its UTF-16
//     length is under it -- is ONE typed deferral before any write, never a broken region / a dangling cycle
// =====================================================================================================================
{
  const ids = (n) => Array.from({ length: n }, (_, i) => "a" + String(i).padStart(7, "0") + "-0000-4000-8000-000000000000");
  const worldWith = (members, brand) => makeWorld(fixture({
    extraDirectory: members.map((id) => ({ id, name: id, country: "IN", currency: "INR", active: true })),
    extraSales: Object.fromEntries(members.map((id) => [id, { rows: [salesRow("2026-09-20", "IN", "INR", brand, 5, 1, id)] }])),
  }));
  ok("V7a the route's bound IS the core's exported MAX_TARGET_ID_BYTES (2048 UTF-8 bytes) and the SAME measure (targetIdByteLength), not a local copy",
    C.MAX_UNIT_TARGET_BYTES === SDR.MAX_TARGET_ID_BYTES && SDR.MAX_TARGET_ID_BYTES === 2048 && SDR.targetIdByteLength("\u20ac") === 3 && SDR.targetIdByteLength("abc") === 3
    && /targetIdByteLength\(scopeId\) > MAX_UNIT_TARGET_BYTES/.test(src("lib/server/sync/routes/brand-view-portfolio.release.js")) && !/MAX_TARGET_ID_CHARS/.test(src("lib/server/sync/saved-data-reconciler.js")));
  const many = ids(32); // every europe-au-sized region account sells it: a ~1.2 KB scope id
  const w32 = worldWith(many, "Widely Sold Brand");
  const s = await buildAll(w32).run(false);
  const u = unitsOf(s).get(UK("Widely Sold Brand"));
  const live32 = liveRow(w32, many, "Widely Sold Brand");
  ok("V7b a brand sold by 32 region accounts (a ~1.2 KB scope id) is an ordinary unit and PUBLISHES end to end (job + shadow + live keyed by the long id)",
    SDR.targetIdByteLength(scopeOf(many, "Widely Sold Brand")) > 1100 && SDR.targetIdByteLength(scopeOf(many, "Widely Sold Brand")) <= 2048
    && u && u.state === RS.RV && !!live32 && live32.account_id === scopeOf(many, "Widely Sold Brand") && w32.jobs.some((j) => j.account_id === scopeOf(many, "Widely Sold Brand")));
  // A non-ASCII brand: 281 x U+20AC (3 UTF-8 bytes each) over the 32 members -> 2049 BYTES while its UTF-16 length is ~1487.
  const euro = "\u20ac".repeat(281);
  const wide = scopeOf(many, euro);
  ok("V7c (fixture) the non-ASCII scope id is 2049 UTF-8 bytes but FEWER than 2049 UTF-16 units (a .length check would pass it)", SDR.targetIdByteLength(wide) === 2049 && wide.length < 2049);
  const wE = worldWith(many, euro);
  const s2 = await buildAll(wE).run(false);
  const u2 = unitsOf(s2).get(UK(euro));
  ok("V7c a scope id over the core's BYTE bound is ONE typed deferred unit ('portfolio-scope-id-too-long', DEFERRED_PROVENANCE) with ZERO cycle / job / shadow / live writes for it; the region's other units still publish",
    u2 && u2.state === RS.DP && u2.reason === "portfolio-scope-id-too-long" && !wE.jobs.some((j) => j.account_id === wide || j.account_id.includes("scope-too-long")) && wE.n.cycleCreate === [...unitsOf(s2).values()].filter((x) => x.state === RS.RV).length
    && ![...wE.db.rows.values()].some((r) => r.account_id === wide) && unitsOf(s2).get(UK("Zeta")).state === RS.RV);
  const euro2 = "\u20ac".repeat(280) + "ab"; // 280 x 3 + 2 = 842 -> exactly 2048 bytes
  ok("V7d exactly 2048 UTF-8 bytes is inside the bound (a normal unit)", SDR.targetIdByteLength(scopeOf(many, euro2)) === 2048 && SDR.normalizeRouteUnits([{ unitKey: "k", targetId: scopeOf(many, euro2), ownerAccountIds: many }], { accountId: "region:india", requestedAsOf: EPOCH, reportKeys: [PK] }).ok === true
    && SDR.normalizeRouteUnits([{ unitKey: "k", targetId: wide, ownerAccountIds: many }], { accountId: "region:india", requestedAsOf: EPOCH, reportKeys: [PK] }).reason === "unit-target-invalid");
}

// =====================================================================================================================
// H. (P2-3) an ABSENT storage object behind an unusable inline stub is a typed failure, never the stub
// =====================================================================================================================
{
  const w = makeWorld();
  const lh = w.db.latest("listing-health", A2);
  w.db.storage.delete(lh.payload_storage_path); // storage read returns null (absent object); the inline payload is null
  // The serve's own reader silently falls back to the stub (listing-health skipped -> a "complete" portfolio).
  const serveRow = await hydratedOver(w.db)({ reportKey: "listing-health", accountId: A2 });
  const s = await buildAll(w).run(false);
  const u = unitsOf(s);
  ok("H1 A2's listing-health storage object is ABSENT (the serve silently uses the empty stub): A2's units defer 'evidence-read-failed:storage-missing:listing-health' with ZERO writes; the A1-only unit publishes",
    !!serveRow && serveRow.payload == null && u.get(UK("Zeta")).state === RS.DD && u.get(UK("Zeta")).reason === "derive-not-ready:evidence-read-failed:storage-missing:listing-health"
    && u.get(UK("Bebi Born")).reason === "derive-not-ready:evidence-read-failed:storage-missing:listing-health" && !liveRow(w, [A2], "Zeta") && !liveRow(w, [A1, A2], "Bebi Born")
    && u.get(UK("Unassigned")).state === RS.RV && w.n.shadowWrite === 1);
  const w2 = makeWorld();
  w2.db.storage.delete(w2.db.latest("brand-sales", A2).payload_storage_path);
  const s2 = await buildAll(w2).run(false);
  const u2 = unitsOf(s2);
  ok("H2 an ABSENT member brand-sales storage object makes the MEMBERSHIP unprovable -> the ONE typed sentinel 'membership-read-failed' (never the stub's empty brand list), zero writes",
    u2.size === 1 && u2.get(C.MEMBERSHIP_SENTINEL_UNIT_KEY).state === RS.DD && u2.get(C.MEMBERSHIP_SENTINEL_UNIT_KEY).reason === "membership-read-failed" && w2.writes() === 0);
}

// =====================================================================================================================
// T. (P3-1) a TIE at the newest updated_at is a typed, token-visible deferral (never a nondeterministic token)
// =====================================================================================================================
{
  const evOf = async (w, reverse = false) => {
    const rowsByName = {};
    for (const q of W.EVIDENCE_SQL) { const rows = await w.db.pgReadOnly(q.text, q.params({ now: CLOCK0 })); rowsByName[q.name] = reverse ? rows.slice().reverse() : rows; }
    return W.composeBrandViewPortfolioEvidence(rowsByName, { now: CLOCK0 }).get("india");
  };
  const w = makeWorld();
  const before = await evOf(w);
  const cur = w.db.latest("fba-plan", A1);
  const twin = w.db.put({ reportKey: "fba-plan", accountId: A1, params: { reportVersion: "fba-plan-shared-v1", to: "2026-09-23" }, payload: { rows: [{ asin: "B0A1", brand: "Bebi Born", fbaAvailable: 99 }] } });
  twin._u = cur._u; twin.updated_at = cur.updated_at; // an exact tie at the newest updated_at
  const e1 = await evOf(w); const e2 = await evOf(w, true);
  ok("T1 a tied latest fba-plan row enters the evidence as { ambiguous, ids } (both ids, sorted); the token is DETERMINISTIC (row order irrelevant) and differs from the untied token",
    J(e1.snaps[A1]["fba-plan"]) === J({ ambiguous: true, ids: [cur.id, twin.id].sort() }) && J(e1.ambiguous[A1]) === J(["fba-plan"]) && e1.token === e2.token && e1.token !== before.token);
  const s = await buildAll(w).run(false);
  const u = unitsOf(s);
  ok("T1 ... every unit containing A1 defers typed 'latest-row-ambiguous:fba-plan' (DEFERRED_PROVENANCE, zero writes); Zeta (A2) publishes",
    u.get(UK("Bebi Born")).state === RS.DP && u.get(UK("Bebi Born")).reason === "latest-row-ambiguous:fba-plan" && u.get(UK("Unassigned")).reason === "latest-row-ambiguous:fba-plan"
    && u.get(UK("Zeta")).state === RS.RV && !liveRow(w, [A1, A2], "Bebi Born") && !liveRow(w, [A1], "Unassigned"));
  const w2 = makeWorld();
  const bs = w2.db.latest("brand-sales", B1);
  const bsTwin = w2.db.put({ reportKey: "brand-sales", accountId: B1, params: { reportVersion: "brand-sales-shared-v1", from: "2025-07-01", to: "2026-09-23" }, payload: { rows: [salesRow("2026-09-20", "DE", "EUR", "Bebi Born", 1, 1, "Bebi DE")], catalogBrands: [] } });
  bsTwin._u = bs._u; bsTwin.updated_at = bs.updated_at;
  const s2 = await buildAll(w2).run(false);
  const u2 = unitsOf(s2);
  ok("T2 a tied latest brand-sales row of a LABEL-deciding account (B1, even out of region) makes the membership unprovable -> the typed sentinel 'latest-row-ambiguous:brand-sales', zero writes",
    u2.size === 1 && u2.get(C.MEMBERSHIP_SENTINEL_UNIT_KEY).reason === "latest-row-ambiguous:brand-sales" && w2.writes() === 0);
  const w3 = makeWorld();
  const av = [...w3.db.rows.values()].find((r) => r.report_key === "brand-inventory" && r.account_id === A1 && r.payload && r.payload.inventoryAvailable === true);
  const avTwin = w3.db.put({ reportKey: "brand-inventory", accountId: A1, params: { reportVersion: BV.BRAND_INVENTORY_REPORT_VERSION, to: "2026-09-22" }, payload: { inventoryAvailable: true, inventoryDate: "2026-09-22", inventoryByBrandCountry: [] } });
  avTwin._u = av._u; avTwin.updated_at = av.updated_at;
  const e3 = await evOf(w3);
  const u3 = unitsOf(await buildAll(w3).run(false));
  ok("T3 a tied newest AVAILABLE compact is ambiguous too ('latest-row-ambiguous:brand-inventory-available' for A1's units; Zeta publishes)",
    isAmbiguous(e3.invAvail[A1]) && u3.get(UK("Unassigned")).reason === "latest-row-ambiguous:" + W.INVENTORY_AVAILABLE_KEY && u3.get(UK("Zeta")).state === RS.RV);
}

// =====================================================================================================================
// A. (P3-2) the durable Ads rows over the build window are evidence: an edit that bypasses content_rev re-arms
// =====================================================================================================================
{
  const w = makeWorld();
  const { run } = buildAll(w);
  await run(false);
  const bb0 = liveRow(w, [A1, A2], "Bebi Born");
  const tok0 = (await run(true)).perAccount[0].evidenceToken;
  // An Ads row value edit that does NOT bump ads_sync_state.content_rev (updated_at is trigger-touched on UPDATE).
  w.db.adsRows[0].metrics = { ad_spend: 7, ad_sales: 20 };
  w.db.adsRows[0].updated_at = "2026-09-24T09:00:00.5+00:00";
  const s1 = await run(true);
  ok("A1 an Ads row edit that bypasses content_rev moves the region token (max(updated_at)) and re-arms exactly A1's units (Zeta current)",
    s1.perAccount[0].evidenceToken !== tok0 && unitsOf(s1).get(UK("Bebi Born")).state === "STALE" && unitsOf(s1).get(UK("Unassigned")).state === "STALE" && unitsOf(s1).get(UK("Zeta")).state === RS.NR);
  const s2 = await run(false);
  ok("A1 ... and the live run re-publishes exactly those two from the edited Ads rows (a new live row + stamp for Bebi Born)", s2.counts.targetsPublished === 2 && liveRow(w, [A1, A2], "Bebi Born").id !== bb0.id && liveRow(w, [A1, A2], "Bebi Born").source_refreshed_at !== bb0.source_refreshed_at);
  // An INSERT with an OLDER updated_at (max unchanged): the count moves the token.
  const tok1 = (await run(true)).perAccount[0].evidenceToken;
  w.db.adsRows.push({ ...clone(w.db.adsRows[0]), metric_date: "2026-09-21", dimension_key: "C1b", metrics: { ad_spend: 1, ad_sales: 0 }, updated_at: "2026-09-20T00:00:00+00:00" });
  const s3 = await run(true);
  ok("A2 an Ads row INSERT whose updated_at is older than the max still moves the token (count) and re-arms A1's units", s3.perAccount[0].evidenceToken !== tok1 && unitsOf(s3).get(UK("Unassigned")).state === "STALE");
  await run(false);
  const tok2 = (await run(true)).perAccount[0].evidenceToken;
  const writes = w.writes();
  w.db.adsRows.push({ ...clone(w.db.adsRows[0]), metric_date: "2026-03-01", dimension_key: "C1old", updated_at: "2026-09-25T00:00:00+00:00" });
  const s4 = await run(false);
  ok("A3 a row OUTSIDE the build window (2026-03-01 < 2026-04-01) is not counted: token unchanged, ZERO writes", s4.perAccount[0].evidenceToken === tok2 && s4.counts.targetsPublished === 0 && w.writes() === writes);
  // An edit BETWEEN the evidence read and the build's Ads read: the strict reader catches it (never a payload over rows
  // the token did not see).
  let fired = false;
  w.db.hooks.onAdsRows = (acct) => { if (!fired && acct === A1) { fired = true; w.db.adsRows[0].updated_at = "2026-09-24T10:00:00+00:00"; } };
  w.db.adsState.get(A1 + "|" + ACTIVE_ADS_SOURCE_KEY).content_rev = "crev-9"; // arm A1's units
  const s5 = await run(false);
  w.db.hooks.onAdsRows = null;
  ok("A4 an Ads row edited between the evidence read and the build read -> 'evidence-advanced:ads-rows' (typed, zero writes for that unit)",
    fired && unitsOf(s5).get(UK("Bebi Born")).reason === "derive-not-ready:evidence-advanced:ads-rows" && liveRow(w, [A1, A2], "Bebi Born").params.evidenceToken !== s5.perAccount[0].evidenceToken);
}
{
  // A5 / A6 (round 3 P2 -- the WP9 v2 verifier probes Q1a / Q1b, reproduced exactly): Postgres now() is the TRANSACTION
  // START time, so an UPDATE of a NON-max row can carry an updated_at OLDER than the current max. count, max(updated_at)
  // and content_rev are then all unchanged -- only the EXACT content digest moves. Owner rule: current ONLY when content
  // identity, lineage and served read-back all match -> the unit must be STALE (then republished), never current. The
  // A1-only 'Unassigned' unit carries A1's attributed Ads (campaign CU mapped to 'unassigned').
  const members = [A1];
  const accountsById = (w) => Object.fromEntries(w.fx.directory.filter((e) => members.includes(String(e.id))).map((e) => [String(e.id), { name: e.name || null, country: e.country || null }]));
  const fresh = (w) => servePortfolioPayload(w.db, { members, brand: "Unassigned", asOf: IN_ASOF, accountsById: accountsById(w) });
  const spendOf = (p) => (p.series || []).map((r) => [r.d, r.a]);
  const evNow = async (w) => { const rowsByName = {}; for (const q of W.EVIDENCE_SQL) rowsByName[q.name] = await w.db.pgReadOnly(q.text, q.params({ now: w.now() })); return W.composeBrandViewPortfolioEvidence(rowsByName, { now: w.now() }).get("india"); };
  const cuRow = (date, dim, ua, spend) => ({ account_id: A1, source_key: ACTIVE_ADS_SOURCE_KEY, metric_date: date, marketplace_country_code: "IN", campaign_id: "CU", campaign_type: "SP", dimension_key: dim, currency: "INR", dimensions: { ad_campaign_id: "CU", marketplace_country_code: "IN" }, metrics: { ad_spend: spend, ad_sales: 1 }, source_refreshed_at: ua, updated_at: ua });
  const setup = (w) => {
    w.db.mappings.push({ organization_fingerprint: ORG, connection_id: "primary", account_id: A1, marketplace: "IN", ads_profile_id: "", ad_campaign_id: "CU", canonical_brand_key: "unassigned", brand_display_name: "Unassigned", mapping_source: "MANUAL", updated_at: "2026-09-20T00:00:00+00:00" });
    w.db.adsRows.push(cuRow("2026-09-21", "CU-a", "2026-09-24T01:10:00+00:00", 5));
    w.db.adsRows.push(cuRow("2026-09-21", "CU-b", "2026-09-24T02:00:00+00:00", 7)); // the max
  };
  const w = makeWorld(); setup(w);
  const { run } = buildAll(w);
  await run(false);
  const un0 = liveRow(w, members, "Unassigned");
  const ev0 = await evNow(w);
  ok("A5 setup: the live Unassigned payload == a fresh serve derive and carries A1's attributed spend (5 + 7 on 2026-09-21); A1's max Ads updated_at is 02:00",
    !!un0 && J(un0.payload) === J(await fresh(w)) && J(spendOf(un0.payload)) === J([["2026-09-21", 12]]) && ev0.ads[A1].rows === "3" && ev0.ads[A1].rowsMaxUa === "2026-09-24T02:00:00.000000Z");
  // Q1a: the OLDER row's spend is corrected by a transaction whose now() (01:30) predates the current max (02:00).
  const cuA = w.db.adsRows.find((x) => x.dimension_key === "CU-a");
  cuA.metrics = { ad_spend: 50, ad_sales: 1 };
  cuA.updated_at = "2026-09-24T01:30:00+00:00";
  const ev1 = await evNow(w);
  const sA = await run(true);
  const f1 = await fresh(w);
  ok("A5 (Q1a) count, max(updated_at) and content_rev are ALL unchanged, yet the exact digest moves and so does the region token",
    ev1.ads[A1].rows === ev0.ads[A1].rows && ev1.ads[A1].rowsMaxUa === ev0.ads[A1].rowsMaxUa && ev1.ads[A1].contentRev === ev0.ads[A1].contentRev
    && ev1.ads[A1].rowsDigest !== ev0.ads[A1].rowsDigest && ev1.token !== ev0.token && sA.perAccount[0].evidenceToken === ev1.token);
  ok("A5 (Q1a) ... the served payload really is stale (spend 12 vs a fresh derive's 57) and the unit is STALE (never current); every A1 unit re-arms, Zeta stays current",
    J(spendOf(liveRow(w, members, "Unassigned").payload)) === J([["2026-09-21", 12]]) && J(spendOf(f1)) === J([["2026-09-21", 57]])
    && unitsOf(sA).get(UK("Unassigned")).state === "STALE" && unitsOf(sA).get(UK("Bebi Born")).state === "STALE" && unitsOf(sA).get(UK("Zeta")).state === RS.NR);
  // Q1b: an unrelated region change moves the region token -> the PER-UNIT predicate decides: pfm2 binds the digest.
  w.db.touch(w.db.latest("brand-sales", B1));
  const sB = await run(true);
  ok("A5 (Q1b) after an unrelated region move the per-unit predicate NEVER calls it 'unit-manifest-unchanged': Unassigned + Bebi Born STALE (pfm2 binds the digest); Zeta current by its manifest",
    unitsOf(sB).get(UK("Unassigned")).state === "STALE" && unitsOf(sB).get(UK("Unassigned")).reason !== C.UNIT_MANIFEST_UNCHANGED && unitsOf(sB).get(UK("Bebi Born")).state === "STALE"
    && unitsOf(sB).get(UK("Zeta")).state === RS.NR && unitsOf(sB).get(UK("Zeta")).reason === C.UNIT_MANIFEST_UNCHANGED);
  const sC = await run(false);
  const un1 = liveRow(w, members, "Unassigned");
  ok("A5 (Q1c) the live run re-publishes exactly the two A1 units and the served Unassigned payload now EQUALS a fresh derive (spend 57)",
    sC.counts.targetsPublished === 2 && un1.id !== un0.id && J(un1.payload) === J(f1) && J(spendOf(un1.payload)) === J([["2026-09-21", 57]]));
  const sD = await run(true);
  ok("A5 ... and a re-scan is fully current (content identity + lineage + served read-back all match)", [UK("Bebi Born"), UK("Unassigned"), UK("Zeta")].every((k) => unitsOf(sD).get(k).state === RS.NR));
  // A6: a DELETE + INSERT keeping the row count, the new row's updated_at below the max, after a region move.
  const w2 = makeWorld(); setup(w2);
  const r2 = buildAll(w2);
  await r2.run(false);
  const e20 = await evNow(w2);
  w2.db.adsRows.splice(w2.db.adsRows.findIndex((x) => x.dimension_key === "CU-a"), 1);
  w2.db.adsRows.push(cuRow("2026-09-21", "CU-c", "2026-09-24T01:59:00+00:00", 3));
  w2.db.touch(w2.db.latest("brand-sales", B1));
  const e21 = await evNow(w2);
  const s2 = await r2.run(true);
  ok("A6 a same-count DELETE + INSERT whose new updated_at is below the max (count + max unchanged) moves the digest -> Unassigned STALE (never 'unit-manifest-unchanged')",
    e21.ads[A1].rows === e20.ads[A1].rows && e21.ads[A1].rowsMaxUa === e20.ads[A1].rowsMaxUa && e21.ads[A1].rowsDigest !== e20.ads[A1].rowsDigest
    && unitsOf(s2).get(UK("Unassigned")).state === "STALE" && unitsOf(s2).get(UK("Unassigned")).reason !== C.UNIT_MANIFEST_UNCHANGED);
  await r2.run(false);
  const un2 = liveRow(w2, members, "Unassigned");
  ok("A6 ... and the live run converges the served payload to a fresh derive (spend 3 + 7)", J(un2.payload) === J(await fresh(w2)) && J(spendOf(un2.payload)) === J([["2026-09-21", 10]]));
}

// =====================================================================================================================
// D. (round 3 P2) the SHARED exact Ads-row digest: the JS twin == the SQL aggregate interpreted from its own text
// =====================================================================================================================
{
  const base = { account_id: A1, source_key: ACTIVE_ADS_SOURCE_KEY, marketplace_country_code: "IN", metric_date: "2026-09-20", dimension_key: "C1", campaign_id: "C1", campaign_type: "SP", child_asin: "", targeting_id: "", currency: "INR", dimensions: { ad_campaign_id: "C1" }, metrics: { ad_spend: 5 }, source_refreshed_at: "2026-09-24T01:00:00+00:00", updated_at: "2026-09-24T01:00:00.1234+00:00" };
  const rows = [
    base,
    { ...base, metric_date: "2026-09-21", dimension_key: "x|y:1\n\"q\",[null]", campaign_id: "a|b", updated_at: "2026-09-24T06:30:00.000001+05:30" },
    { ...base, marketplace_country_code: "DE", dimension_key: "\u20ac\u00e9\ud83d\ude00", currency: "EUR", child_asin: "B0\u00df", updated_at: "2026-09-23T22:00:00-02:00" },
    { ...base, metric_date: "2026-04-01", dimension_key: "C9", targeting_id: "t-1", source_refreshed_at: "2026-09-24T01:00:00.5+00:00", updated_at: "2026-09-24T01:00:00Z" },
  ];
  const js = DEPR.adsRowsDigest(rows);
  ok("D1 the JS twin (adsRowsDigest over REST rows) == the Postgres aggregate INTERPRETED FROM adsRowsDigestSql's own text over the SAME rows (non-ASCII, '|' / ':' / newline inside keys, any offset, micro fractions)",
    /^adr1:4:\d+:\d+$/.test(js) && js === pgAdsRowsDigest(rows) && ADS_DIGEST_PROGRAM.ops.length === 12 && J(ADS_DIGEST_PROGRAM.ops.map((o) => o[1])) === J(["source_key", "account_id", "marketplace_country_code", "metric_date", "dimension_key", "campaign_id", "campaign_type", "child_asin", "targeting_id", "currency", "source_refreshed_at", "updated_at"]));
  ok("D1 REST instant shapes ('+00:00', a trimmed fraction, another offset) digest exactly like the SQL to_char text; the digest is order-independent; the empty set is 'adr1:0:0:0' both ways",
    DEPR.adsRowsDigest([{ ...base, updated_at: "2026-09-24T01:00:00.1234+00:00" }]) === DEPR.adsRowsDigest([{ ...base, updated_at: "2026-09-24T01:00:00.123400Z" }])
    && DEPR.adsRowsDigest([{ ...base, updated_at: "2026-09-24T06:30:00.1234+05:30" }]) === DEPR.adsRowsDigest([{ ...base, updated_at: "2026-09-24T01:00:00.1234+00:00" }])
    && DEPR.adsRowsDigest(rows.slice().reverse()) === js && DEPR.adsRowsDigest([]) === DEPR.EMPTY_ADS_ROWS_DIGEST && pgAdsRowsDigest([]) === DEPR.EMPTY_ADS_ROWS_DIGEST && DEPR.EMPTY_ADS_ROWS_DIGEST === "adr1:0:0:0");
  // ANY single-row change: every scalar column, an updated_at ONE MICROSECOND earlier (now() = transaction start), a
  // delete, an insert, a same-count delete + insert; the jsonb metrics are bound through updated_at (trigger).
  const variants = [
    ...["source_key", "account_id", "marketplace_country_code", "dimension_key", "campaign_id", "campaign_type", "child_asin", "targeting_id", "currency"].map((k) => [{ ...base, [k]: String(base[k]) + "z" }, ...rows.slice(1)]),
    [{ ...base, metric_date: "2026-09-19" }, ...rows.slice(1)],
    [{ ...base, source_refreshed_at: "2026-09-24T01:00:00.000001+00:00" }, ...rows.slice(1)],
    [{ ...base, updated_at: "2026-09-24T01:00:00.123399+00:00" }, ...rows.slice(1)],
    rows.slice(1), [...rows, { ...base, dimension_key: "C10" }], [{ ...base, dimension_key: "C11" }, ...rows.slice(1)],
  ];
  ok("D2 ANY single-row change moves the digest (each scalar column, updated_at one MICROSECOND earlier, a delete, an insert, a same-count delete + insert) -- and the SQL emulation agrees on every variant",
    variants.length === 15 && variants.every((v) => DEPR.adsRowsDigest(v) !== js && DEPR.adsRowsDigest(v) === pgAdsRowsDigest(v)) && new Set(variants.map((v) => DEPR.adsRowsDigest(v))).size === variants.length);
  ok("D2 the encoding is INJECTIVE: moving a '|' / ':' across the marketplace / dimension_key boundary changes the per-row text and the digest",
    DEPR.adsRowDigestText({ ...base, marketplace_country_code: "IN|", dimension_key: "C1" }) !== DEPR.adsRowDigestText({ ...base, marketplace_country_code: "IN", dimension_key: "|C1" })
    && DEPR.adsRowsDigest([{ ...base, marketplace_country_code: "IN|", dimension_key: "C1" }]) !== DEPR.adsRowsDigest([{ ...base, marketplace_country_code: "IN", dimension_key: "|C1" }]));
  ok("D3 the metrics / dimensions jsonb are NOT hashed (not reproducible from parsed REST JSON) -- they are bound through updated_at, which every UPDATE trigger-touches (the DDL trigger is pinned)",
    DEPR.adsRowsDigest([{ ...base, metrics: { ad_spend: 999 } }]) === DEPR.adsRowsDigest([base])
    && /create trigger ads_daily_source_rows_touch_updated_at before update on public\.ads_daily_source_rows\s+for each row execute function public\.touch_updated_at\(\);/.test(src("supabase/migrations/20260729_automated_ads_sync.sql"))
    && /primary key \(source_key, account_id, marketplace_country_code, metric_date, dimension_key\)/.test(src("supabase/migrations/20260729_automated_ads_sync.sql")));
  ok("D3 the digest covers EXACTLY the scalar columns the REST read selects (supabase.js getAdsDailySourceRows select list minus the two jsonb columns)",
    (() => { const m = src("lib/server/supabase.js").match(/select: "(account_id,source_key,metric_date,marketplace_country_code,dimension_key,[a-z_,]+)",\s*\n\s*account_id: `eq\.\$\{accountId\}`,\s*\n\s*source_key: `in\./); return !!m && J(m[1].split(",").filter((c) => c !== "dimensions" && c !== "metrics").sort()) === J(ADS_DIGEST_PROGRAM.ops.map((o) => o[1]).sort()); })());
}

// =====================================================================================================================
// K. (round 3 P3-1) DERIVATION-CODE identity: pf1 AND pfm2 move when ANY code-identity constant changes
// =====================================================================================================================
{
  const w = makeWorld();
  const rowsByName = {};
  for (const q of W.EVIDENCE_SQL) rowsByName[q.name] = await w.db.pgReadOnly(q.text, q.params({ now: CLOCK0 }));
  const evOf = (code) => W.composeBrandViewPortfolioEvidence(rowsByName, code ? { now: CLOCK0, code } : { now: CLOCK0 }).get("india");
  const mOf = (ev) => C.portfolioUnitManifestToken(ev, { region: "india", orgFp: ORG, key: "bebi born", display: "Bebi Born", members: [A1, A2], labelDeciders: [] });
  const base = evOf(null);
  const CODE = W.PORTFOLIO_CODE_IDENTITY;
  ok("K1 the default code identity is the REAL constants: brand-view / brands / portfolio versions, the compact inventory version, ACTIVE_ADS_SOURCE_KEY and the route's DERIVE_REV (frozen; carried on the evidence)",
    Object.isFrozen(CODE) && J(CODE) === J({ bv: BV.BRAND_VIEW_VERSION, bvb: BV.BRAND_VIEW_BRANDS_VERSION, bvp: BV.BRAND_VIEW_PORTFOLIO_VERSION, inv: BV.BRAND_INVENTORY_REPORT_VERSION, ads: ACTIVE_ADS_SOURCE_KEY, rev: String(W.DERIVE_REV) })
    && Number.isInteger(W.DERIVE_REV) && J(base.code) === J(CODE) && evOf({ ...CODE }).token === base.token && mOf(evOf({ ...CODE })) === mOf(base));
  const moved = Object.keys(CODE).map((k) => { const ev = evOf({ ...CODE, [k]: CODE[k] + "-changed" }); return [k, ev.token !== base.token, mOf(ev) !== mOf(base)]; });
  ok("K1 changing ANY ONE of them (a version, ACTIVE_ADS_SOURCE_KEY -- e.g. the ASIN rollback flip -- or DERIVE_REV) moves BOTH the region token pf1 AND the per-unit manifest pfm2",
    moved.length === 6 && moved.every(([, a, b]) => a && b) && evOf({ ...CODE, ads: "asin-performance-v1" }).token !== base.token);
  ok("K1 the production compose path takes NO code override (the worker tier-1 compose and the CLI evaluate the SAME default code identity)",
    W.default.evidence.compose(rowsByName, { now: CLOCK0, code: { ...CODE, rev: "x" } }).get("region:india").token === base.token);
}

// =====================================================================================================================
// N. (P3-3) directory entry values keep the serve's JSON type (name 123 stays a number; 0 -> null)
// =====================================================================================================================
{
  const fx = fixture();
  fx.directory = fx.directory.map((e) => (e.id === A1 ? { ...e, name: 123 } : e.id === A2 ? { ...e, name: 0 } : e));
  const w = makeWorld(fx);
  const rowsByName = {};
  for (const q of W.EVIDENCE_SQL) rowsByName[q.name] = await w.db.pgReadOnly(q.text, q.params({ now: CLOCK0 }));
  const ev = W.composeBrandViewPortfolioEvidence(rowsByName, { now: CLOCK0 }).get("india");
  ok("N1 the projection applies the serve's `entry.name || null` to the JSON VALUE: 123 stays the NUMBER 123, 0 becomes null (the ->> text would give '123' / '0')",
    ev.serveAccountsById[A1].name === 123 && ev.serveAccountsById[A2].name === null && ev.accounts[A1].name === 123);
  await buildAll(w).run(false);
  const live = liveRow(w, [A1, A2], "Bebi Born");
  const browser = await browserServedIdentities(w.db, w.fx, "india");
  const idBB = browser.identities.get("bebi born");
  const servePayload = await servePortfolioPayload(w.db, { members: idBB.members, brand: "Bebi Born", asOf: IN_ASOF, accountsById: idBB.accountsById });
  ok("N1 ... the published payload equals the serve's own payload for the same request (account name 123 is a number in both)",
    !!live && J(live.payload) === J(servePayload) && live.payload.accounts.some((a) => a.name === 123) && !live.payload.accounts.some((a) => a.name === "123"));
}

ok("Z zero network / zero DataDoe across the whole suite", net.calls.length === 0);
out(`brand-view-portfolio-route: ${passed} passed`);
