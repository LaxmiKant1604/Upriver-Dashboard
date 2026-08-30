// Zero-DataDoe backfill of the durable ACCOUNT-SKU OWNERSHIP authority (fba_account_sku_ownership) from every
// account's CURRENT validated/hydrated fba-plan/v2d-5 snapshot + its own seller-warehouse identities. Reads only
// already-saved evidence; creates NO DataDoe exports and spends NO tokens. Run in production AFTER migrations
// 20260903/20260904/20260905 are applied and after any re-derive/republish, so the cross-account ownership check sees
// complete evidence. Idempotent: each account's rows are atomically REPLACED.
//
//   node scripts/backfill-fba-ownership.mjs           # apply
//   node scripts/backfill-fba-ownership.mjs --dry-run # report only, no writes
//
// Requires the usual server env (POSTGRES/Supabase service role + a primary DataDoe connection for the org
// fingerprint). Prints a per-account summary + totals.

import {
  listFbaPlanSnapshotAccountIds, getLatestReportSnapshotHydrated, getSellerWarehouseRows, replaceFbaAccountSkuOwnership,
} from "../lib/server/supabase.js";
import { getDataDoeConnections } from "../lib/server/datadoe-connections.js";
import { organizationFingerprint } from "../lib/server/source-identity.js";
import { buildOwnershipRows } from "../lib/server/reports/warehouse-ownership.js";

const DRY = process.argv.includes("--dry-run");
const S = (v) => (v == null ? "" : String(v));

function orgFingerprint() {
  const primary = getDataDoeConnections().find((c) => c && c.id === "primary" && S(c.apiKey).trim());
  if (!primary) throw new Error("No primary DataDoe connection is configured (needed for the org fingerprint).");
  return primary.organizationFingerprint || organizationFingerprint(primary.apiKey);
}

async function main() {
  const org = orgFingerprint();
  const connectionId = "primary";
  const accountIds = await listFbaPlanSnapshotAccountIds();
  console.log(`[ownership-backfill]${DRY ? " (dry-run)" : ""} org=${org.slice(0, 8)}... accounts=${accountIds.length}`);
  let totalRows = 0; let applied = 0; let skippedNoV5 = 0; const skippedAccounts = [];
  for (const accountId of accountIds) {
    const snap = await getLatestReportSnapshotHydrated({ reportKey: "fba-plan", accountId });
    const payload = snap?.payload || null;
    if (!payload || !Array.isArray(payload.accountSkuDirectory)) {
      skippedNoV5 += 1; skippedAccounts.push(accountId);
      console.log(`  skip ${accountId}: no v2d-5 directory (snapshot version ${S(payload?.snapshotVersion) || "?"})`);
      continue;
    }
    const warehouseRows = await getSellerWarehouseRows({ organizationFingerprint: org, connectionId, accountId });
    const rows = buildOwnershipRows(payload, warehouseRows);
    totalRows += rows.length;
    if (DRY) { console.log(`  would set ${accountId}: ${rows.length} ownership rows`); continue; }
    const res = await replaceFbaAccountSkuOwnership({ organizationFingerprint: org, connectionId, accountId, rows });
    applied += 1;
    console.log(`  set  ${accountId}: ${res?.rows ?? rows.length} ownership rows`);
  }
  console.log(`[ownership-backfill] done: ${applied} account(s) ${DRY ? "would be " : ""}populated, ${totalRows} rows total, ${skippedNoV5} skipped (no v2d-5).`);
  if (skippedNoV5 > 0) console.log(`  skipped (need a v2d-5 re-derive first): ${skippedAccounts.join(", ")}`);
}

main().catch((e) => { console.error("[ownership-backfill] FAILED:", e && e.message ? e.message : e); process.exitCode = 1; });
