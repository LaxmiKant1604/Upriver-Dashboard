// Trusted ZERO-EXPORT backfill: (re)compute source_oli_sales_estimates for every primary account from the
// ALREADY-STORED durable truth (source_oli_operational_units missing/zero-price units + source_oli_dimensional_history
// priced references). There is NO DataDoe adapter in this path, so a create-export is structurally impossible: it
// spends ZERO tokens and never touches sync_cycles, source controls, publishing, the priced rollup, units, Ads,
// inventory, or any report snapshot. It writes ONLY the additive estimate table.
//
//   node scripts/release/oli-sales-estimate-backfill.mjs                 # dry-run (no writes)
//   BACKFILL_APPLY=1 node scripts/release/oli-sales-estimate-backfill.mjs # apply
//
// Idempotent: each account's estimate window is atomically REPLACED (delete + insert) chunked by CALENDAR MONTH, so
// a re-run writes byte-identical rows and a grain that has resolved (actual data arrived) leaves NO estimate. The
// reference look-back (7 days) reads across the month boundary, so month chunking never loses a nearest-prior match.
import { readFileSync } from "node:fs";

// Flexible env: prefer already-set process.env (GitHub Actions); else load .vercel/.env.production.local or .env.local.
function loadEnvFile(path) {
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (m) { let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); if (!process.env[m[1]]) process.env[m[1]] = v; }
    }
  } catch { /* file absent -> rely on process.env */ }
}
if (!process.env.POSTGRES_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  loadEnvFile("sales-dashboard-live/.vercel/.env.production.local");
  loadEnvFile(".vercel/.env.production.local");
  loadEnvFile("../../.env.local");
  loadEnvFile("C:/Users/laxmi/Documents/Codex/2026-07-01/can/Upriver-Dashboard/.env.local");
}
if (!process.env.SUPABASE_URL && process.env.VITE_SUPABASE_URL) process.env.SUPABASE_URL = process.env.VITE_SUPABASE_URL;
process.env.PGSSLMODE = process.env.PGSSLMODE || "no-verify";
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const APPLY = process.env.BACKFILL_APPLY === "1";
const LOOKBACK_ONLY_DAYS = Number(process.env.ESTIMATE_BACKFILL_DAYS || 0); // 0 => full history; else only the last N days

const sb = await import("../../lib/server/supabase.js");
const { recomputeOliSalesEstimatesWindow } = await import("../../lib/server/sync/oli-sales-estimate-recompute.js");
const { addDaysStr } = await import("../../lib/server/date-windows.js");
const pg = (await import("pg")).default;

if (!process.env.POSTGRES_URL) { console.error("POSTGRES_URL is required."); process.exit(1); }

// Resolve org fingerprint + accounts + per-account date span from the durable operational-units table itself
// (NO DataDoe key needed -- the rows are already stamped with the organization fingerprint).
async function loadScope() {
  const u = new URL(process.env.POSTGRES_URL); u.searchParams.set("sslmode", "no-verify");
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  try {
    const rows = (await c.query(
      "select organization_fingerprint, connection_id, account_id, min(sale_date)::text as from_date, max(sale_date)::text as to_date " +
      "from public.source_oli_operational_units " +
      "where (explicit_zero_units > 0 or pending_units > 0) " +
      "group by organization_fingerprint, connection_id, account_id order by account_id"
    )).rows;
    return rows;
  } finally { await c.end(); }
}

const scope = await loadScope();
if (!scope.length) { console.log("No accounts have missing/zero-price operational units -> nothing to estimate."); process.exit(0); }
const orgFingerprint = scope[0].organization_fingerprint;
console.log(`org=${String(orgFingerprint).slice(0, 8)} | accounts with missing/zero units: ${scope.length} | mode=${APPLY ? "APPLY (writes)" : "DRY-RUN (no writes)"}${LOOKBACK_ONLY_DAYS ? ` | last ${LOOKBACK_ONLY_DAYS} days only` : ""}`);

const monthsBetween = (from, to) => {
  const out = [];
  let y = Number(from.slice(0, 4)); let m = Number(from.slice(5, 7));
  const endY = Number(to.slice(0, 4)); const endM = Number(to.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    const mm = String(m).padStart(2, "0");
    const mFrom = `${y}-${mm}-01`;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const mTo = `${y}-${mm}-${String(lastDay).padStart(2, "0")}`;
    out.push({ from: mFrom > from ? mFrom : from, to: mTo < to ? mTo : to });
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
};

let totals = { accounts: 0, estimated: 0, unresolved: 0, windows: 0 };
const ceiling = LOOKBACK_ONLY_DAYS ? addDaysStr(new Date().toISOString().slice(0, 10), -1) : null;
for (const s of scope) {
  const accountId = s.account_id;
  const connectionId = s.connection_id || "primary";
  let from = s.from_date; const to = s.to_date;
  if (LOOKBACK_ONLY_DAYS && ceiling) { const cut = addDaysStr(ceiling, -(LOOKBACK_ONLY_DAYS - 1)); if (cut > from) from = cut; }
  let acctEst = 0; let acctUnres = 0; let acctWin = 0;
  for (const win of monthsBetween(from, to)) {
    const r = await recomputeOliSalesEstimatesWindow({
      organizationFingerprint: orgFingerprint, connectionId, accountId, from: win.from, to: win.to,
      readOperationalUnits: sb.getSourceOliOperationalUnitRows,
      readDimensionalRows: sb.getSourceOliDimensionalUnitRows,
      // DRY-RUN never writes: a no-op writer that reports what WOULD be written.
      writeEstimates: APPLY ? sb.replaceOliSalesEstimatesWindow : (async () => ({ write: "dry-run" })),
    });
    acctEst += r.estimates.length; acctUnres += r.unresolved.length; acctWin += 1;
    if (APPLY && r.write && r.write.write !== "ok") { console.error(`  WRITE FAILED account=${accountId.slice(0, 6)} window=${win.from}..${win.to} (${r.write.error})`); }
  }
  totals.accounts += 1; totals.estimated += acctEst; totals.unresolved += acctUnres; totals.windows += acctWin;
  console.log(`  ${accountId.slice(0, 6)} [${from}..${to}] months=${acctWin} estimated=${acctEst} unresolved=${acctUnres}`);
}
console.log(`\nDONE ${APPLY ? "(APPLIED)" : "(DRY-RUN)"}: accounts=${totals.accounts} windows=${totals.windows} estimatedGrains=${totals.estimated} unresolvedGrains=${totals.unresolved}`);
