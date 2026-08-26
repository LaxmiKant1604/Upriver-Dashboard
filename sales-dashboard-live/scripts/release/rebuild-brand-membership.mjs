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
const { buildBrandAccountMembership, accountsForBrand, scopePrimaryMembership } = await import("../../lib/server/reports/brand-membership.js");

// The AUTHORITATIVE current-primary account-id set: the persisted account directory, restricted to active,
// primary-connection, canonical-UUID entries. Membership is scoped to this set at rebuild time so a stale/retired,
// dd-secondary, or malformed account that still has a historical brand-sales snapshot can never appear.
async function currentPrimaryAccountIdSet() {
  const dir = await sb.getLatestReportSnapshot({ reportKey: "account-directory", accountId: "__account-directory__" }).catch(() => null);
  const ids = new Set();
  for (const a of dir?.payload?.accounts || []) {
    const id = String(a?.id || "").trim();
    if (id && a?.active !== false && !id.includes(":")) ids.add(id);
  }
  return ids;
}

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

// Authoritatively scope to CURRENT PRIMARY accounts BEFORE building membership, and classify what is dropped
// (counts + typed categories only -- never raw ids).
const primarySet = await currentPrimaryAccountIdSet();
const { scoped, dropped } = scopePrimaryMembership(perAccount, primarySet);
console.log("brand-membership scope: " + perAccount.length + " brand-sales snapshot accounts -> " + scoped.length
  + " current-primary (of " + primarySet.size + " discovered); dropped stale/retired=" + dropped.staleRetired
  + " dd-secondary=" + dropped.ddSecondary + " malformed=" + dropped.malformed + ".");
if (scoped.length > primarySet.size) { console.error("STOP scoped membership (" + scoped.length + ") exceeds current primary discovery (" + primarySet.size + ") -- fail closed."); process.exit(1); }

const membership = buildBrandAccountMembership(scoped);
const brandCount = membership.size;
const accountsWithMembership = new Set();
let pairs = 0;
// Each membership value is { display, accounts: Set<accountId> } (buildBrandAccountMembership), so the account
// set is entry.accounts -- iterating the entry object itself is not iterable and undercounts the pairs.
for (const entry of membership.values()) { pairs += entry.accounts.size; for (const a of entry.accounts) accountsWithMembership.add(a); }
console.log("brand-membership: rebuilt from " + perAccount.length + " brand-sales snapshots -> " + brandCount + " brands, " + accountsWithMembership.size + " accounts, " + pairs + " (brand,account) pairs.");

if (brandCount === 0 || pairs === 0) { console.error("STOP rebuilt membership is EMPTY -- brand-sales is missing or unreadable (fail closed)."); process.exit(1); }

if (verifyBrand) {
  const accts = accountsForBrand(membership, verifyBrand);
  console.log("brand-membership: '" + verifyBrand + "' resolves to " + accts.length + " accounts.");
  if (accts.length < expectMin) { console.error("STOP '" + verifyBrand + "' resolved to " + accts.length + " accounts (< expected " + expectMin + ")."); process.exit(1); }
}
console.log("brand-membership: OK.");
process.exit(0);
