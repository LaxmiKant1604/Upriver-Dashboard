// TRUSTED Brand View portfolio-membership rebuild + verification. Usage (run from sales-dashboard-live/):
//   node scripts/release/rebuild-brand-membership.mjs
//
// Recomputes the brand -> accounts MEMBERSHIP map from the CURRENT validated brand-sales snapshots (the exact
// evidence sharedSnapshotBrandAccounts + the figures use) and verifies it is non-empty + internally consistent.
// Membership is derived on-demand by the app, so this is the workflow's explicit post-publish "rebuild + verify"
// step: it fails closed if the fresh brand-sales did not yield a usable membership. Supabase-ONLY -- it reads no
// DataDoe and spends ZERO tokens. Optional --verify-brand="Name" --expect-min=N asserts a brand's account count.

import { loadReleaseEnv } from "./env-bootstrap.mjs";
import pg from "pg";

loadReleaseEnv();

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const verifyBrand = argOf("verify-brand");
const expectMin = Number(argOf("expect-min") || 0);

const sb = await import("../../lib/server/supabase.js");
const { buildBrandAccountMembership, accountsForBrand } = await import("../../lib/server/reports/brand-membership.js");

// Extract brand names from a brand-sales payload the same way the live directory does (catalogBrands UNION each
// row's product_brand/brand), trimmed.
const salesBrandNames = (payload) => {
  const names = new Set((payload?.catalogBrands || []).map((b) => String(b || "").trim()).filter(Boolean));
  (payload?.rows || []).forEach((row) => { const b = row?.product_brand || row?.brand; if (String(b || "").trim()) names.add(String(b).trim()); });
  return [...names];
};

const base = String(process.env.POSTGRES_URL).split("?")[0];
const client = new pg.Client({ connectionString: base, ssl: { rejectUnauthorized: false } });
await client.connect();

let perAccount = [];
try {
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const accounts = (await client.query("select distinct account_id from public.report_snapshots where report_key='brand-sales'")).rows.map((r) => String(r.account_id));
  for (const accountId of accounts) {
    const r = await client.query("select payload, payload_storage_path from public.report_snapshots where report_key='brand-sales' and account_id=$1 order by updated_at desc limit 1", [accountId]);
    if (!r.rows.length) continue;
    let payload = r.rows[0].payload;
    const path = r.rows[0].payload_storage_path;
    if ((!payload || (!payload.rows && !payload.catalogBrands)) && path) { try { payload = await sb.getReportSnapshotStoragePayload(path); } catch { payload = payload || null; } }
    perAccount.push({ accountId, salesBrands: salesBrandNames(payload) });
  }
  await client.query("ROLLBACK");
} catch (e) {
  try { await client.query("ROLLBACK"); } catch { /* ignore */ }
  console.error("STOP brand-sales read failed: " + (e && e.message ? e.message : e));
  process.exit(1);
} finally { await client.end(); }

const membership = buildBrandAccountMembership(perAccount);
const brandCount = membership.size;
const accountsWithMembership = new Set();
let pairs = 0;
for (const set of membership.values()) { pairs += set.size; for (const a of set) accountsWithMembership.add(a); }
console.log("brand-membership: rebuilt from " + perAccount.length + " brand-sales snapshots -> " + brandCount + " brands, " + accountsWithMembership.size + " accounts, " + pairs + " (brand,account) pairs.");

if (brandCount === 0 || pairs === 0) { console.error("STOP rebuilt membership is EMPTY -- brand-sales is missing or unreadable (fail closed)."); process.exit(1); }

if (verifyBrand) {
  const accts = accountsForBrand(membership, verifyBrand);
  console.log("brand-membership: '" + verifyBrand + "' resolves to " + accts.length + " accounts.");
  if (accts.length < expectMin) { console.error("STOP '" + verifyBrand + "' resolved to " + accts.length + " accounts (< expected " + expectMin + ")."); process.exit(1); }
}
console.log("brand-membership: OK.");
process.exit(0);
