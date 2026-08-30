// Zero-DataDoe backfill of the durable ACCOUNT-SKU OWNERSHIP authority (fba_account_sku_ownership) from every
// account's CURRENT validated/hydrated fba-plan/v2d-5 snapshot + its own seller-warehouse identities. Reads only
// already-saved evidence; creates NO DataDoe exports and spends NO tokens. Idempotent: each account's rows are
// atomically REPLACED. Runs standalone OR is invoked from the go-live operator's completion path (so ownership is
// never a forgotten manual step).
//
//   node scripts/backfill-fba-ownership.mjs           # apply
//   node scripts/backfill-fba-ownership.mjs --dry-run # report only, no writes
//
// Requires the usual server env (POSTGRES/Supabase service role + a primary DataDoe connection for the org
// fingerprint). Prints a per-account summary + totals.

import { fileURLToPath } from "node:url";
import {
  listFbaPlanSnapshotAccountIds, getLatestReportSnapshotHydrated, getSellerWarehouseRows, replaceFbaAccountSkuOwnership,
} from "../lib/server/supabase.js";
import { getDataDoeConnections } from "../lib/server/datadoe-connections.js";
import { organizationFingerprint } from "../lib/server/source-identity.js";
import { buildOwnershipRows } from "../lib/server/reports/warehouse-ownership.js";

const S = (v) => (v == null ? "" : String(v));

function orgFingerprint() {
  const primary = getDataDoeConnections().find((c) => c && c.id === "primary" && S(c.apiKey).trim());
  if (!primary) throw new Error("No primary DataDoe connection is configured (needed for the org fingerprint).");
  return primary.organizationFingerprint || organizationFingerprint(primary.apiKey);
}

/**
 * Backfill the durable account-SKU ownership authority from every published fba-plan/v2d-5 snapshot. Zero DataDoe,
 * idempotent (atomic per-account replace). Returns { applied, totalRows, skippedNoV5, skippedAccounts }. Injected
 * for testability; production defaults are the Supabase wrappers.
 */
export async function backfillFbaOwnership({ dry = false, log = () => {}, readers = {} } = {}) {
  const {
    listAccounts = listFbaPlanSnapshotAccountIds,
    getSnapshot = getLatestReportSnapshotHydrated,
    getWarehouse = getSellerWarehouseRows,
    replaceOwnership = replaceFbaAccountSkuOwnership,
    resolveOrg = orgFingerprint,
  } = readers;
  const org = resolveOrg();
  const connectionId = "primary";
  const accountIds = await listAccounts();
  log(`[ownership-backfill]${dry ? " (dry-run)" : ""} org=${org.slice(0, 8)}... accounts=${accountIds.length}`);
  let totalRows = 0; let applied = 0; let skippedNoV5 = 0; const skippedAccounts = [];
  for (const accountId of accountIds) {
    const snap = await getSnapshot({ reportKey: "fba-plan", accountId });
    const payload = snap?.payload || null;
    if (!payload || !Array.isArray(payload.accountSkuDirectory)) {
      skippedNoV5 += 1; skippedAccounts.push(accountId);
      log(`  skip ${accountId}: no v2d-5 directory (snapshot version ${S(payload?.snapshotVersion) || "?"})`);
      continue;
    }
    const warehouseRows = await getWarehouse({ organizationFingerprint: org, connectionId, accountId });
    const rows = buildOwnershipRows(payload, warehouseRows);
    totalRows += rows.length;
    if (dry) { log(`  would set ${accountId}: ${rows.length} ownership rows`); continue; }
    const res = await replaceOwnership({ organizationFingerprint: org, connectionId, accountId, rows });
    applied += 1;
    log(`  set  ${accountId}: ${res?.rows ?? rows.length} ownership rows`);
  }
  log(`[ownership-backfill] done: ${applied} account(s) ${dry ? "would be " : ""}populated, ${totalRows} rows total, ${skippedNoV5} skipped (no v2d-5).`);
  if (skippedNoV5 > 0) log(`  skipped (need a v2d-5 re-derive first): ${skippedAccounts.join(", ")}`);
  return { applied, totalRows, skippedNoV5, skippedAccounts };
}

// CLI entry (only when run directly, never on import).
const isMain = (() => { try { return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]; } catch { return false; } })();
if (isMain) {
  backfillFbaOwnership({ dry: process.argv.includes("--dry-run"), log: (m) => console.log(m) })
    .catch((e) => { console.error("[ownership-backfill] FAILED:", e && e.message ? e.message : e); process.exitCode = 1; });
}
