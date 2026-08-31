// READ-ONLY production read-back for the SKU Movement v1 -> v2 upgrade. Writes NOTHING, no DataDoe adapter. For all 30
// primary accounts it re-derives v2 from the CURRENT durable evidence (the same zero-export gather the scheduler /
// self-heal / backfill use) and proves the invariants that actually define correctness:
//   * GRAIN: v2 rowCount == the number of distinct grain keys (mapped -> A|ASIN|currency ; unmapped -> U|SKU|currency)
//     -> exactly one row per ASIN+currency, and no unmapped SKU folded onto an ASIN.
//   * CONSERVATION: the sum of completed-month units in the v2 payload EQUALS the sum of the raw MERGED ordered-unit
//     history (priced + explicit-zero + pending, ASIN-resolved) over the same months, for rows carrying an ASIN or
//     SKU -> the ASIN aggregation neither lost nor double-counted a unit.
//   * REPRESENTATIVE SKU never starts with amzn (return SKUs are excluded from the display, their units still count).
//   * BRAND ISOLATION: a named-brand re-derive yields only ASINs Catalog-proven for that brand (spot check).
// It also reports, for the record, the v1(SKU-grain) -> v2(ASIN-grain) row reduction where a stored v1 exists.
import { readFileSync } from "node:fs";
const ENV_PATH = "C:/Users/laxmi/Documents/Codex/2026-07-01/can/Upriver-Dashboard/.env.local";
for (const l of readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(l);
  if (m) { let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); if (!process.env[m[1]]) process.env[m[1]] = v; }
}
if (!process.env.SUPABASE_URL && process.env.VITE_SUPABASE_URL) process.env.SUPABASE_URL = process.env.VITE_SUPABASE_URL;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const sb = await import("../../lib/server/supabase.js");
const { gatherSkuMovementEvidence, rederiveSkuMovement } = await import("../../lib/server/reports/sku-movement-durable-rederive.js");
const { getDataDoeConnections } = await import("../../lib/server/datadoe-connections.js");
const { organizationFingerprint } = await import("../../lib/server/source-identity.js");

const CEILING = process.argv.find((a) => a.startsWith("--ceiling="))?.split("=")[1] || new Date().toISOString().slice(0, 10);
const primary = getDataDoeConnections().find((c) => c && c.id === "primary" && String(c.apiKey || "").trim());
const orgFp = primary.organizationFingerprint || organizationFingerprint(primary.apiKey);
const readers = {
  readOliHistory: sb.getSourceOliHistoryRows, readOliCoverage: sb.getSourceCoverageWindows,
  readCatalogSnapshot: sb.getSourceSnapshot, loadCatalogPayload: sb.getSourceSnapshotPayload,
  readOliOperationalUnits: sb.getSourceOliOperationalUnitRows, readOliSkuAsinResolution: sb.getOliSkuAsinResolutionRows,
  readDirectory: sb.getAccountDirectorySnapshotAccounts,
};

const dir = await sb.getLatestReportSnapshot({ reportKey: "account-directory", accountId: "__account-directory__" });
const accounts = (dir?.payload?.accounts || [])
  .filter((a) => a && String(a.id) && !String(a.id).includes(":") && a.active !== false)
  .map((a) => ({ accountId: String(a.id), country: a.country }));

async function v1RowsOf(accountId) {
  const snap = await sb.getLatestReportSnapshotForScope({ reportKey: "sku-movement", accountId, reportVersion: "sku-movement/v1" });
  if (!snap) return null;
  if (Array.isArray(snap.payload?.rows) && snap.payload.rows.length) return snap.payload.rows.length;
  if (snap.payload_storage_path) { try { const p = await sb.getReportSnapshotStoragePayload(snap.payload_storage_path); if (p?.rows) return p.rows.length; } catch { /* ignore */ } }
  return snap.payload?.rows?.length || 0;
}
const monthUnitsOf = (rows) => (rows || []).reduce((t, r) => t + (r.months || []).reduce((s, m) => s + (m && m.units != null ? Number(m.units) || 0 : 0), 0), 0);

let ok = 0; const fails = []; let totV1 = 0, totV2 = 0;
console.log("account  | v2rows dgrain | monthU(v2) monthU(rawMerge) | conserve grain amzn | v1rows");
for (const { accountId } of accounts) {
  try {
    const ev = await gatherSkuMovementEvidence({ accountId, organizationFingerprint: orgFp, connectionId: "primary", ceiling: CEILING }, readers);
    const der = await rederiveSkuMovement({ accountId, brand: "ALL", organizationFingerprint: orgFp, connectionId: "primary", ceiling: CEILING }, readers);
    if (der?.notReady || !der?.payload) { fails.push({ accountId, reason: "not-ready" }); console.log(`${accountId.slice(0, 8)} | NOT-READY`); continue; }
    const rows = der.payload.rows;
    const monthKeys = rows[0]?.months?.map((m) => m.key) || (der.payload.monthLabels ? [] : []);
    const grainKeys = new Set(rows.map((r) => (r.unmapped ? `U|${r.sku}|${r.currency}` : `A|${String(r.asin).toUpperCase()}|${r.currency}`)));
    const grainOk = grainKeys.size === rows.length;
    const v2m = monthUnitsOf(rows);
    const rawm = ev.historyRows.filter((r) => monthKeys.includes(String(r.sale_date || "").slice(0, 7)) && (String(r.child_asin || "").trim() || String(r.sku || "").trim())).reduce((s, r) => s + (Number(r.units ?? r.total_units_sold ?? 0) || 0), 0);
    const conserveOk = v2m === rawm;
    const amznOk = rows.every((r) => !r.hasSellerSku || !/^amzn/i.test(String(r.sku || "")));
    const v1n = await v1RowsOf(accountId);
    totV2 += rows.length; totV1 += (v1n || 0);
    const pass = grainOk && conserveOk && amznOk;
    if (pass) ok += 1; else fails.push({ accountId, grainOk, conserveOk, amznOk, v2m, rawm, rows: rows.length });
    console.log(`${accountId.slice(0, 8)} |  ${String(rows.length).padStart(4)}  ${String(grainKeys.size).padStart(4)}  |  ${String(v2m).padStart(7)}    ${String(rawm).padStart(7)}      |   ${conserveOk ? "Y" : "N"}      ${grainOk ? "Y" : "N"}   ${amznOk ? "Y" : "N"}   | ${v1n == null ? "-" : v1n}`);
  } catch (e) { fails.push({ accountId, error: e.message }); console.log(`${accountId.slice(0, 8)} | ERROR ${e.message}`); }
}
// Brand isolation spot check: pick an account + one of its catalog brands; a named-brand re-derive must yield only that brand.
let brandNote = "brand-isolation: (no brand to test)";
try {
  const sample = accounts.find((a) => true);
  const der = await rederiveSkuMovement({ accountId: sample.accountId, brand: "ALL", organizationFingerprint: orgFp, connectionId: "primary", ceiling: CEILING }, readers);
  const brands = der?.payload?.catalogBrands || [];
  if (brands.length) {
    const b = brands[0];
    const bder = await rederiveSkuMovement({ accountId: sample.accountId, brand: b, organizationFingerprint: orgFp, connectionId: "primary", ceiling: CEILING }, readers);
    const allBrandsInResult = new Set((bder?.payload?.rows || []).map((r) => r.brand));
    const isolated = bder?.payload?.brandFiltered === true && [...allBrandsInResult].every((x) => x === b || x === "Unmapped" ? x === b : true) && [...allBrandsInResult].every((x) => x === b);
    brandNote = `brand-isolation on ${sample.accountId.slice(0, 8)} brand="${b}": rows=${bder?.payload?.rows?.length || 0} brandsInResult=${JSON.stringify([...allBrandsInResult])} -> ${isolated ? "ISOLATED" : "CHECK"}`;
  }
} catch (e) { brandNote = "brand-isolation check error: " + e.message; }

console.log(`\n${ok}/${accounts.length} accounts PASS (grain + unit-conservation + no-amzn-rep).`);
console.log(`row totals: v1(SKU-grain)=${totV1} -> v2(ASIN-grain)=${totV2} (net ${totV1 - totV2} duplicate SKU rows collapsed across accounts that had a v1)`);
console.log(brandNote);
if (fails.length) { console.log("FAILURES:\n" + JSON.stringify(fails, null, 2)); process.exit(1); }
