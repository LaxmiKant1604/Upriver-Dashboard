// Returns & Refund Leakage -- the durable Returns + Settlement REST readers (lib/server/supabase.js
// getReturnsHistoryRows / getSettlementHistoryRows) page by OFFSET (limit 1000), so their ORDER BY must be TOTAL over
// the table's primary key: with a partial order, rows tied on the ordered columns may come back in a different order
// on each page request, so a tie group straddling a page boundary returns one row TWICE and never returns another
// while the total COUNT still matches (publication recovery WP5 verifier finding P2-1; it affected the dashboard serve
// and the returns-v3 route alike).
//
// Proves, fully offline (the REAL readers over a fake PostgREST installed as the global fetch -- nothing leaves the
// process; the fake honours select / eq / gte / lte / in / order / limit / offset and breaks ties ADVERSARIALLY,
// differently on alternate pages, the way a real plan may):
//   O1 static: the primary keys parsed from the 20260914 DDL; returns-publish.js's strict duplicate-key columns are
//      exactly those keys minus the eq-pinned organization_fingerprint + connection_id.
//   O2 the REAL readers' requests: every PK column is in the ORDER BY or pinned by an eq filter of the same request
//      (a total order over the rows the request can return); the former leading order columns keep their sequence; the
//      select list, filters and the 1000-row page size are unchanged.
//   O3 a tie group straddling a page boundary: the REAL readers return the EXACT row set (no duplicate, none missing);
//      the SAME fake driven with the former 4-column order duplicates + skips at the same count (the hazard is real,
//      so this test would have caught the defect).
//   O4 a larger series (> 2 default pages, many ties) through the default 1000-row page: exact.
// 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

process.env.SUPABASE_URL = "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = ["test", "svc", "role", "key"].join("-");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; out("  ok  " + name); };
const S = (v) => (v == null ? "" : String(v));

// ---- the fake PostgREST (the ONLY fetch target; anything else is refused and recorded) ----------------------------
const server = { tables: { source_returns_history: [], source_settlement_history: [] }, requests: [], refused: [] };
function evalFilter(row, col, expr) {
  const v = S(row[col]);
  if (expr.startsWith("eq.")) return v === expr.slice(3);
  if (expr.startsWith("gte.")) return v >= expr.slice(4);
  if (expr.startsWith("lte.")) return v <= expr.slice(4);
  if (expr.startsWith("in.(") && expr.endsWith(")")) return expr.slice(4, -1).split(",").map((x) => x.replace(/^"|"$/g, "")).includes(v);
  throw new Error("fake PostgREST: unsupported filter " + col + "=" + expr);
}
// PostgREST semantics over the table: filters -> ORDER BY the requested columns -> OFFSET/LIMIT -> select projection.
// Rows tied on EVERY ordered column come back in an order that differs between alternate pages (ascending on even page
// indexes, descending on odd ones): legal for SQL (ties are unordered) and exactly what breaks offset paging.
function serve(table, qs) {
  const rows = server.tables[table];
  if (!rows) throw new Error("fake PostgREST: unknown table " + table);
  const select = S(qs.get("select")).split(",");
  const order = S(qs.get("order")).split(",").filter(Boolean).map((o) => { const [col, dir] = o.split("."); if (dir !== "asc") throw new Error("fake: asc only"); return col; });
  const limit = Number(qs.get("limit"));
  const offset = Number(qs.get("offset"));
  const filters = [];
  for (const [k, v] of qs.entries()) if (!["select", "order", "limit", "offset"].includes(k)) filters.push([k, v]);
  const page = Math.floor(offset / limit);
  const tieKey = (r) => JSON.stringify(r);
  const cmp = (a, b) => {
    for (const c of order) { const x = S(a[c]); const y = S(b[c]); if (x !== y) return x < y ? -1 : 1; }
    const ta = tieKey(a); const tb = tieKey(b);
    if (ta === tb) return 0;
    return (ta < tb ? -1 : 1) * (page % 2 === 0 ? 1 : -1);
  };
  const hit = rows.filter((r) => filters.every(([k, v]) => evalFilter(r, k, v))).sort(cmp);
  return hit.slice(offset, offset + limit).map((r) => Object.fromEntries(select.map((c) => [c, r[c] === undefined ? null : r[c]])));
}
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  const method = String(opts.method || "GET");
  const m = /^\/rest\/v1\/([a-z_]+)$/.exec(u.pathname);
  if (u.origin !== "http://supabase.test" || method !== "GET" || !m) { server.refused.push(method + " " + String(url)); throw new Error("network refused in an offline test"); }
  server.requests.push({ table: m[1], qs: u.searchParams });
  const body = serve(m[1], u.searchParams);
  return { ok: true, status: 200, json: async () => body };
};

const SB = await import("../lib/server/supabase.js");
const RP = await import("../lib/server/reports/returns-publish.js");

const ORG = "org-fp-1";
const own = { organization_fingerprint: ORG, connection_id: "primary" };
const retRow = (o) => ({ ...own, account_id: "IN1", seller_or_vendor_id: "raw-IN1", marketplace_country_code: "IN", return_date: "2026-09-20", sku: "SKU-A", child_asin: "B0A", amazon_return_reason: "DEFECTIVE", fulfillment_channel: "AFN", request_status: "Approved", label_payer: "Amazon", detailed_disposition: "SELLABLE", return_count: 1, fbm_refunded_amount: 0, fbm_seller_label_cost: 0, cogs_total_value: 0, source_request_hash: "h-ret", refreshed_at: "2026-09-24T02:00:00+00:00", ...o });
const setRow = (o) => ({ ...own, account_id: "IN1", seller_or_vendor_id: "raw-IN1", marketplace_country_code: "IN", settlement_date: "2026-09-21", sku: "SKU-A", child_asin: "B0A", currency: "INR", settlement_type: "REFUND", quantity: 1, item_price: 0, refunded_amount: -500, refund_tax: 0, refunded_referral_fee: 0, refund_commission: 0, refund_restocking_fee: 0, fba_customer_return_per_unit_fee: 0, fba_customer_return_fee: 0, customer_return_hrr_unit_fee: 0, cogs_total_value: 0, refund_event_count: 1, source_request_hash: "h-set", refreshed_at: "2026-09-24T02:00:00+00:00", ...o });
const readArgs = (extra = {}) => ({ organizationFingerprint: ORG, connectionId: "primary", accountIds: ["IN1"], from: "2026-07-27", to: "2026-09-24", ...extra });
const keyOf = (r, cols) => JSON.stringify(cols.map((c) => S(r[c])));
// The exact-row-set verdict of a read against the table's in-window truth: same count, no repeated key, none missing.
function exactness(read, truth, cols) {
  const want = new Set(truth.map((r) => keyOf(r, cols)));
  const got = read.map((r) => keyOf(r, cols));
  const distinct = new Set(got);
  return { sameCount: read.length === truth.length, duplicates: got.length - distinct.size, missing: [...want].filter((k) => !distinct.has(k)).length };
}

// =====================================================================================================================
// O1. static: the primary keys from the DDL; the strict duplicate-key columns derive from them.
// =====================================================================================================================
const ddl = readFileSync(path.join(ROOT, "supabase", "migrations", "20260914_returns_leakage_durable.sql"), "utf8");
const pkOf = (name) => { const m = new RegExp("constraint " + name + " primary key\\s*\\(([^)]*)\\)").exec(ddl); return m ? m[1].split(",").map((c) => c.trim()).filter(Boolean) : []; };
const PK = { returns: pkOf("source_returns_hist_pk"), settlement: pkOf("source_settle_hist_pk") };
const PINNED = ["organization_fingerprint", "connection_id"];
ok("O1 the DDL primary keys: source_returns_hist_pk (10 columns) + source_settle_hist_pk (8 columns), both led by organization_fingerprint + connection_id",
  PK.returns.length === 10 && PK.settlement.length === 8 && PINNED.every((c, i) => PK.returns[i] === c && PK.settlement[i] === c));
ok("O1 returns-publish.js's strict duplicate-key columns are EXACTLY the DDL keys minus the eq-pinned org + connection (the columns the readers select)",
  JSON.stringify(RP.RETURNS_HISTORY_KEY_COLUMNS) === JSON.stringify(PK.returns.filter((c) => !PINNED.includes(c)))
  && JSON.stringify(RP.SETTLEMENT_HISTORY_KEY_COLUMNS) === JSON.stringify(PK.settlement.filter((c) => !PINNED.includes(c))));

// =====================================================================================================================
// O2. the REAL readers' requests: total order over the PK; select / filters / page size unchanged.
// =====================================================================================================================
const RET_SELECT = "account_id,seller_or_vendor_id,marketplace_country_code,return_date,sku,child_asin,amazon_return_reason,fulfillment_channel,request_status,label_payer,detailed_disposition,return_count,fbm_refunded_amount,fbm_seller_label_cost,cogs_total_value,source_request_hash,refreshed_at";
const SET_SELECT = "account_id,seller_or_vendor_id,marketplace_country_code,settlement_date,sku,child_asin,currency,settlement_type,quantity,item_price,refunded_amount,refund_tax,refunded_referral_fee,refund_commission,refund_restocking_fee,fba_customer_return_per_unit_fee,fba_customer_return_fee,customer_return_hrr_unit_fee,cogs_total_value,refund_event_count,source_request_hash,refreshed_at";
const LEGACY_ORDER = { returns: "return_date.asc,account_id.asc,child_asin.asc,sku.asc", settlement: "settlement_date.asc,account_id.asc,child_asin.asc,sku.asc" };
const SPEC = {
  returns: { table: "source_returns_history", read: SB.getReturnsHistoryRows, date: "return_date", select: RET_SELECT, cols: RP.RETURNS_HISTORY_KEY_COLUMNS },
  settlement: { table: "source_settlement_history", read: SB.getSettlementHistoryRows, date: "settlement_date", select: SET_SELECT, cols: RP.SETTLEMENT_HISTORY_KEY_COLUMNS },
};
for (const [name, sp] of Object.entries(SPEC)) {
  server.tables[sp.table] = [name === "returns" ? retRow({}) : setRow({})];
  server.requests.length = 0;
  const rows = await sp.read(readArgs());
  const req = server.requests[0];
  const qs = req.qs;
  const order = S(qs.get("order")).split(",").map((o) => o.split(".")[0]);
  const eqPinned = [...qs.entries()].filter(([, v]) => v.startsWith("eq.")).map(([k]) => k);
  ok(`O2 ${name}: every DDL primary-key column is in the ORDER BY or pinned by an eq filter of the same request -> a TOTAL order (no two returnable rows can tie)`,
    rows.length === 1 && server.requests.length === 1 && req.table === sp.table && PK[name].every((c) => order.includes(c) || eqPinned.includes(c)) && PINNED.every((c) => eqPinned.includes(c)) && order.every((c) => sp.select.split(",").includes(c)));
  ok(`O2 ${name}: the former leading order (${LEGACY_ORDER[name]}) is kept as the prefix, every sort is ascending, no column repeats`,
    S(qs.get("order")).startsWith(LEGACY_ORDER[name] + ",") && S(qs.get("order")).split(",").every((o) => o.endsWith(".asc")) && new Set(order).size === order.length);
  ok(`O2 ${name}: select list, filters (org eq, connection eq, ${sp.date} gte + lte, account in) and the 1000-row page size are UNCHANGED`,
    qs.get("select") === sp.select && qs.get("organization_fingerprint") === "eq." + ORG && qs.get("connection_id") === "eq.primary"
    && JSON.stringify(qs.getAll(sp.date)) === JSON.stringify(["gte.2026-07-27", "lte.2026-09-24"]) && qs.get("account_id") === 'in.("IN1")'
    && qs.get("limit") === "1000" && qs.get("offset") === "0" && [...new Set([...qs.keys()])].sort().join(",") === ["account_id", "connection_id", "limit", "offset", "order", "organization_fingerprint", "select", sp.date].sort().join(","));
}

// =====================================================================================================================
// O3. a tie group straddling a page boundary: exact through the REAL readers; the former order duplicates + skips.
// =====================================================================================================================
// The former reader loop, driven with the FORMER order through the same fake (to prove the hazard the fix removes).
async function legacyRead(table, dateCol, orderStr, select, pageRows) {
  const outRows = [];
  for (let offset = 0; ; offset += pageRows) {
    const qs = new URLSearchParams({ select, organization_fingerprint: `eq.${ORG}`, connection_id: "eq.primary", [dateCol]: "gte.2026-07-27", order: orderStr, limit: String(pageRows), offset: String(offset) });
    qs.append(dateCol, "lte.2026-09-24");
    qs.append("account_id", 'in.("IN1")');
    const res = await globalThis.fetch(`http://supabase.test/rest/v1/${table}?${qs}`);
    const list = await res.json();
    outRows.push(...list);
    if (list.length < pageRows) break;
  }
  return outRows;
}
{
  // Returns: four rows of ONE (date, account, asin, sku) differing only by reason / channel / status / label payer --
  // tied under the former order, straddling the 2-row page boundary.
  const ret = [
    retRow({ amazon_return_reason: "DEFECTIVE" }), retRow({ amazon_return_reason: "UNWANTED_ITEM" }),
    retRow({ amazon_return_reason: "DEFECTIVE", fulfillment_channel: "MFN" }), retRow({ amazon_return_reason: "DEFECTIVE", request_status: "Pending", label_payer: "Seller" }),
  ];
  // Settlement: ORDER + REFUND + OTHER of one SKU-day plus a second currency -- tied under the former order.
  const set = [
    setRow({ settlement_type: "ORDER", item_price: 500, refunded_amount: 0, refund_event_count: 0 }), setRow({ settlement_type: "REFUND" }),
    setRow({ settlement_type: "OTHER", refunded_amount: 0, refund_event_count: 0 }), setRow({ currency: "AED", settlement_type: "REFUND" }),
  ];
  server.tables.source_returns_history = ret;
  server.tables.source_settlement_history = set;
  for (const [name, sp] of Object.entries(SPEC)) {
    const truth = server.tables[sp.table];
    const real = exactness(await sp.read(readArgs({ pageRows: 2 })), truth, sp.cols);
    const legacy = exactness(await legacyRead(sp.table, sp.date, LEGACY_ORDER[name], sp.select, 2), truth, sp.cols);
    ok(`O3 ${name}: a 4-row tie group across a 2-row page boundary -- the REAL reader returns the EXACT row set (same count, 0 duplicates, 0 missing)`,
      real.sameCount && real.duplicates === 0 && real.missing === 0);
    ok(`O3 ${name}: ... while the FORMER order through the same pages returns the SAME COUNT with duplicated AND missing rows (the P2-1 hazard; this test fails on the pre-fix reader)`,
      legacy.sameCount && legacy.duplicates > 0 && legacy.missing === legacy.duplicates);
    ok(`O3 ${name}: ... and returns-publish's strict duplicate-key check flags exactly that legacy read (0 on the exact one)`,
      RP.duplicateKeyCount(await legacyRead(sp.table, sp.date, LEGACY_ORDER[name], sp.select, 2), sp.cols) === legacy.duplicates && RP.duplicateKeyCount(await sp.read(readArgs({ pageRows: 2 })), sp.cols) === 0);
  }
}

// =====================================================================================================================
// O4. a larger series through the DEFAULT 1000-row page (3 pages, dense ties): exact.
// =====================================================================================================================
{
  const REASONS = ["DEFECTIVE", "UNWANTED_ITEM", "NOT_AS_DESCRIBED", "DAMAGED", "SWITCHEROO"];
  const CH = ["AFN", "MFN"]; const ST = ["Approved", "Pending", "Closed"]; const LP = ["Amazon", "Seller"];
  const ret = [];
  for (let d = 0; d < 4 && ret.length < 2345; d += 1) for (let s = 0; s < 4; s += 1) for (const r of REASONS) for (const c of CH) for (const st of ST) for (const lp of LP) for (let a = 0; a < 3; a += 1) {
    if (ret.length >= 2345) break;
    ret.push(retRow({ return_date: "2026-09-" + String(10 + d), sku: "SKU-" + s, child_asin: "B0" + a, amazon_return_reason: r, fulfillment_channel: c, request_status: st, label_payer: lp }));
  }
  const TYPES = ["ORDER", "REFUND", "OTHER"]; const CUR = ["INR", "AED", "USD"];
  const set = [];
  for (let d = 0; d < 30 && set.length < 2222; d += 1) for (let s = 0; s < 9; s += 1) for (const t of TYPES) for (const cu of CUR) {
    if (set.length >= 2222) break;
    set.push(setRow({ settlement_date: "2026-08-" + String(10 + (d % 20)).padStart(2, "0"), sku: "SKU-" + s + "-" + d, child_asin: "B0" + (s % 3), settlement_type: t, currency: cu }));
  }
  server.tables.source_returns_history = ret;
  server.tables.source_settlement_history = set;
  for (const [name, sp] of Object.entries(SPEC)) {
    const truth = server.tables[sp.table];
    server.requests.length = 0;
    const read = await sp.read(readArgs());
    const e = exactness(read, truth, sp.cols);
    ok(`O4 ${name}: ${truth.length} rows (dense ties under the former order) through the default 1000-row page -> ${server.requests.length} requests, the EXACT row set`,
      truth.length > 2000 && server.requests.length === Math.floor(truth.length / 1000) + 1 && server.requests.every((r) => r.qs.get("limit") === "1000") && e.sameCount && e.duplicates === 0 && e.missing === 0);
  }
}

ok("ZERO real network: every request went to the in-process fake PostgREST (GET /rest/v1/<durable history table>), nothing refused", server.refused.length === 0);
out(`returns-history-reader-order: ${passed} passed`);
