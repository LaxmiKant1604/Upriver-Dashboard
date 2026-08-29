// Trusted ZERO-EXPORT backfill runner: populate source_oli_operational_units for all primary accounts from the
// ALREADY-STORED dimensional history (priced + explicit-zero + cancelled units). PENDING units are forward-only
// (never persisted historically) so they are NOT reconstructed here -- they flow in from the next OLI sync. There is
// NO DataDoe adapter in this path, so a create-export is structurally impossible: it spends ZERO tokens and never
// touches sync_cycles, source controls, publishing, Daily/Brand Sales, the priced rollup, or any other report.
//
//   node scripts/release/oli-operational-units-backfill.mjs                  # dry-run (no writes)
//   BACKFILL_APPLY=1 node scripts/release/oli-operational-units-backfill.mjs # apply
//
// Idempotent: it replaces each account's operational-unit window (delete+insert by exact account/window), so a
// re-run writes the same rows. Revenue is untouched (this table is never read by any financial calculation).
import { readFileSync } from "node:fs";

const ENV_PATH = "C:/Users/laxmi/Documents/Codex/2026-07-01/can/Upriver-Dashboard/.env.local";
const txt = readFileSync(ENV_PATH, "utf8");
for (const l of txt.split(/\r?\n/)) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(l);
  if (m) { let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); if (!process.env[m[1]]) process.env[m[1]] = v; }
}
if (!process.env.SUPABASE_URL && process.env.VITE_SUPABASE_URL) process.env.SUPABASE_URL = process.env.VITE_SUPABASE_URL;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const APPLY = process.env.BACKFILL_APPLY === "1";

const sb = await import("../../lib/server/supabase.js");
const { operationalUnitsFromDimensionalRows } = await import("../../lib/server/sync/oli-order-rules.js");
const { getDataDoeConnections } = await import("../../lib/server/datadoe-connections.js");
const { organizationFingerprint } = await import("../../lib/server/source-identity.js");

if (!sb.isSupabaseConfigured()) { console.error("Supabase is not configured (env)."); process.exit(1); }

const primary = getDataDoeConnections().find((c) => c && c.id === "primary" && String(c.apiKey || "").trim());
if (!primary) { console.error("No primary DataDoe connection with an API key."); process.exit(1); }
const orgFp = primary.organizationFingerprint || organizationFingerprint(primary.apiKey);

const dir = await sb.getLatestReportSnapshot({ reportKey: "account-directory", accountId: "__account-directory__" });
const accounts = (dir?.payload?.accounts || [])
  .filter((a) => a && String(a.id) && !String(a.id).includes(":") && a.active !== false)
  .map((a) => ({ accountId: String(a.id), country: a.country }));
console.log(`accounts: ${accounts.length} | mode=${APPLY ? "APPLY (writes)" : "DRY-RUN (no writes)"}`);

let totals = { accounts: 0, windows: 0, priced: 0, zero: 0, cancelled: 0, rows: 0 };
for (const a of accounts) {
  const cov = await sb.getSourceCoverageWindows({ organizationFingerprint: orgFp, connectionId: "primary", accountId: a.accountId, sourceKey: "order-line-items" }).catch(() => null);
  const windows = cov && cov.read === "ok" ? (cov.windows || []) : [];
  if (!windows.length) { console.log(`  ${a.accountId}: no coverage -> skip`); continue; }
  const from = windows.reduce((m, w) => (String(w.from) < m ? String(w.from) : m), String(windows[0].from));
  const to = windows.reduce((m, w) => (String(w.to) > m ? String(w.to) : m), String(windows[0].to));
  const dimRows = await sb.getSourceOliDimensionalUnitRows({ organizationFingerprint: orgFp, connectionId: "primary", accountId: a.accountId, from, to });
  const unitRows = operationalUnitsFromDimensionalRows(dimRows);
  const p = unitRows.reduce((s, r) => s + Number(r.pricedUnits || 0), 0);
  const z = unitRows.reduce((s, r) => s + Number(r.explicitZeroUnits || 0), 0);
  const c = unitRows.reduce((s, r) => s + Number(r.cancelledUnits || 0), 0);
  totals.accounts += 1; totals.priced += p; totals.zero += z; totals.cancelled += c; totals.rows += unitRows.length;
  console.log(`  ${a.accountId} [${from}..${to}] dim=${dimRows.length} -> grains=${unitRows.length} priced=${p} zero=${z} cancelled=${c}`);
  if (APPLY && unitRows.length) {
    // Chunk the atomic replace by CALENDAR MONTH so each window-scoped delete+insert carries a bounded payload
    // (high-volume accounts have tens of thousands of grains). Months are DISJOINT windows, so replacing each in turn
    // covers the whole range without overlap and stays idempotent.
    const byMonth = new Map();
    for (const r of unitRows) { const mk = String(r.saleDate).slice(0, 7); (byMonth.get(mk) || byMonth.set(mk, []).get(mk)).push(r); }
    let wroteRows = 0;
    for (const [mk, rows] of [...byMonth.entries()].sort()) {
      const mFrom = mk + "-01";
      const mTo = rows.reduce((m, r) => (r.saleDate > m ? r.saleDate : m), rows[0].saleDate);
      const res = await sb.replaceOliOperationalUnitsWindow({ organizationFingerprint: orgFp, connectionId: "primary", accountId: a.accountId, coveredFrom: mFrom, coveredTo: mTo, unitRows: rows });
      if (res.write !== "ok") { console.error(`    WRITE FAILED month=${mk} (${res.error}) -- aborting`); process.exit(1); }
      wroteRows += res.inserted; totals.windows += 1;
    }
    console.log(`    wrote ${byMonth.size} month windows, ${wroteRows} grain rows`);
  }
}
console.log(`\nDONE ${APPLY ? "(APPLIED)" : "(DRY-RUN)"}: accounts=${totals.accounts} grains=${totals.rows} priced=${totals.priced} zero=${totals.zero} cancelled=${totals.cancelled}`);
