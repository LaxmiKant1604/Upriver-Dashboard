// TRUSTED operator for the ZERO-EXPORT FBA Inventory overflow recovery via LATEST-SNAPSHOT COMPACTION. It recovers the
// accounts blocked by a terminal TRUNCATED (oversized) inventory batch by REUSING their EXISTING single-seller exports
// (read-only download of the retained manual-source marker export id) and reducing each payload to its latest PROVABLY-
// COMPLETE date -- which fits the row cap + 8MB cache limit -- then persisting that compacted block under the child's
// canonical hash. It creates NO new export and spends NO tokens; it NEVER retries/recreates the failed parent export or
// the successful sibling batch, NEVER sums across dates, and NEVER raises the 50000 row cap.
//
//   node scripts/release/fba-inventory-recovery.mjs --region=india --mode=dry-run   [--cycle-date=YYYY-MM-DD]
//   node scripts/release/fba-inventory-recovery.mjs --region=india --mode=recover --cycle-date=YYYY-MM-DD \
//       --confirm=fba-inventory-recovery/india/YYYY-MM-DD [--max-creates=3]
//
// dry-run: READ-ONLY -- discovers accounts, derives the proven-overflow sellers from recent terminal TRUNCATED
//   evidence, plans the single-seller children, and for each downloads its retained export and reports whether the
//   latest date is provably complete. ZERO creates, ZERO tokens.
// recover: refuses unless the operator is authorized + --confirm is exact; then, for each child, downloads its retained
//   export (read-only), compacts to the latest provably-complete date, and persists the compacted block. If a child's
//   latest date is not provably complete (or no retained export exists), it STOPS that account (never infers
//   completeness, never creates a new export). --max-creates is a legacy ceiling kept for the cost preflight; the
//   recovery itself makes ZERO creates.

import { loadReleaseEnv } from "./env-bootstrap.mjs";
loadReleaseEnv();

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const region = (argOf("region") || "").toLowerCase();
const mode = argOf("mode") || "dry-run";
const confirm = argOf("confirm");
const maxCreates = Number(argOf("max-creates") || 3);
const AUTHORIZED_OPERATOR = "laxmikant@superboring.in";
const operator = process.env.PRIORITY_OPERATOR || argOf("operator") || AUTHORIZED_OPERATOR;
const cycleDate = argOf("cycle-date") || new Date().toISOString().slice(0, 10);
if (!["india", "europe-au", "us-ca"].includes(region)) { console.error("STOP --region must be india | europe-au | us-ca"); process.exit(2); }
if (mode !== "dry-run" && mode !== "recover") { console.error("STOP --mode must be dry-run | recover"); process.exit(2); }
const operationId = `fba-inventory-recovery/${region}/${cycleDate}`;
const log = (m) => console.log(`fba-inv-recovery[${mode}/${region}]: ${m}`);

const { buildFbaPlanRelease } = await import("../../lib/server/sync/fba-plan-release-composition.js");
const { fbaBucketAccounts, planFbaBucketCost } = await import("../../lib/server/sync/fba-plan-operation.js");
const { getDataDoeConnections, resolveDataDoeAccountIds } = await import("../../lib/server/datadoe-connections.js");
const { getDataDoeTokenBalance } = await import("../../lib/server/datadoe-usage.js");
const { downloadExport } = await import("../../lib/server/datadoe.js");
const { compactLatestInventorySnapshot } = await import("../../lib/server/sync/fba-inventory-latest-snapshot.js");
const { materializeListingHealthV3PerAccount } = await import("../../lib/server/sync/listing-health-v3-materialize.js");
const { planListingHealthV3BucketBatched } = await import("../../lib/server/sync/report-planner.js");
const { getSourceExportCache, saveSourceExportCache, getSourceExportCacheMeta, getReportSnapshot } = await import("../../lib/server/supabase.js");
const { paramsHashFor } = await import("../../lib/server/report-store.js");
// Read the retained manual-source marker for a request hash -> its resumable export id (READ-ONLY; never creates).
const markerExportId = async (requestHash) => {
  try { const snap = await getReportSnapshot({ reportKey: "manual-source-attempt", accountId: "__manual-source-attempt__", paramsHash: paramsHashFor("manual-source-attempt-v1", { requestHash }) }); const m = snap && snap.payload; return m && (m.exportId || m.export_id) || null; } catch { return null; }
};

if (mode === "recover") {
  if (confirm !== operationId) { console.error(`STOP recover requires --confirm=${operationId} (exact); got ${confirm ? "a mismatched value" : "none"}.`); process.exit(2); }
  if (operator !== AUTHORIZED_OPERATOR) { console.error("STOP operator identity is not authorized for a recovery run."); process.exit(2); }
}

// The release provides discovery + overflow derivation + the publisher/controls/read-back. Its default runtime is
// used only for discovery; the actual fetch/derive runs on a CANARY runtime scoped to EXACTLY the overflow accounts
// (composed below, once they are known) so no other account is ever fetched or created.
const release = buildFbaPlanRelease({ operator });
const connections = getDataDoeConnections();
const primaryApiKey = (connections.find((c) => c && c.id === "primary") || {}).apiKey || null;
const balanceNow = async () => { if (!primaryApiKey) return null; const b = await getDataDoeTokenBalance({ apiKey: primaryApiKey }); return b && b.read === "ok" ? b.usable : null; };

// Stage 0: discover + scope to the region.
const accounts = await release.loadAccounts();
const bucketAccounts = fbaBucketAccounts(accounts, region);
log(`discovered ${accounts.length} primary accounts; ${bucketAccounts.length} in region ${region}`);
if (!bucketAccounts.length) { console.error("STOP no accounts in region."); process.exit(1); }

// Stage 1: derive proven-overflow sellers from recent terminal TRUNCATED evidence.
const { overflowSellers, singleSellerHardStops } = await release.resolveOverflowSellers({ bucket: region, bucketAccounts, asOf: cycleDate, inventoryAsOf: cycleDate });
if (singleSellerHardStops.length) log(`HARD STOP: ${singleSellerHardStops.length} single-seller inventory batch(es) still exceed 50000 -- cannot split further; NOT recovered (never auto-raise the limit): ${singleSellerHardStops.map((s) => String(s).slice(0, 6)).join(",")}`);
if (!overflowSellers.size) { log("no proven-overflow (multi-seller TRUNCATED) sellers to recover. Nothing to do."); process.exit(singleSellerHardStops.length ? 1 : 0); }

// The accounts to recover: those whose raw seller id is a proven-overflow seller.
const overflowAccounts = bucketAccounts.filter((a) => { try { const r = resolveDataDoeAccountIds([a.accountId], connections); return r && r.rawAccountIds.length === 1 && overflowSellers.has(String(r.rawAccountIds[0])); } catch { return false; } });
log(`recovering ${overflowAccounts.length} account(s) as single-seller inventory exports: ${overflowAccounts.map((a) => String(a.accountId).slice(0, 6)).join(",")}`);

// Stage 2: prove the freshness-aware cost (ZERO creates) with the split applied.
const { plan, cost } = await planFbaBucketCost({ bucketAccounts: overflowAccounts, connections: release.connections, asOf: cycleDate, inventoryAsOf: cycleDate, getSourceExportCache: release.getSourceExportCache, overflowSellers });
const childSources = [...new Map(plan.reportRequests.flatMap((r) => r.sources.filter((s) => s.requestKey === "fba-plan:inventory-health").map((s) => [s.requestHash, s]))).values()];
log(`PLAN: ${childSources.length} single-seller inventory children; every child sellers=${childSources.every((s) => s.sellerOrVendorIds.length === 1)}; creates=${cost.creates} tokens=${cost.tokens} (ceiling ${maxCreates})`);
for (const s of childSources) log(`  child seller=${String(s.sellerOrVendorIds[0]).slice(0, 6)} hash=${String(s.requestHash).slice(0, 12)} window=${s.from}..${s.to} strict=${s.strict} limit=${s.limit}`);
if (childSources.length !== overflowAccounts.length || !childSources.every((s) => s.sellerOrVendorIds.length === 1)) { console.error("STOP the split did not produce exactly one single-seller child per overflow account; refusing (fail closed)."); process.exit(1); }
if (Number(cost.creates || 0) > maxCreates) { console.error(`STOP planned creates ${cost.creates} exceed --max-creates ${maxCreates}; refusing.`); process.exit(1); }
if (mode === "dry-run") {
  log("DRY-RUN (READ-ONLY, ZERO creates/tokens): reuse existing exports; prove latest-date completeness per child.");
  for (const s of childSources) {
    const seller = String(s.sellerOrVendorIds[0]);
    if (await getSourceExportCache(s.requestHash)) { log(`  ${seller.slice(0, 6)}: already cached (previously recovered) -- skip.`); continue; }
    const exportId = await markerExportId(s.requestHash);
    if (!exportId) { log(`  ${seller.slice(0, 6)}: NO retained export id -> cannot reuse read-only (a NEW export would be required -- NOT authorized).`); continue; }
    let rows; try { rows = await downloadExport(primaryApiKey, exportId); } catch (e) { log(`  ${seller.slice(0, 6)}: downloadExport FAILED (export gone?): ${String(e && e.message || e).slice(0, 80)}`); continue; }
    const c = compactLatestInventorySnapshot({ rows, seller, marketplace: "IN", rowCap: Number(s.limit) || undefined, exportRef: exportId, requestedFrom: s.from, requestedTo: s.to });
    log(`  ${seller.slice(0, 6)}: exportId=${String(exportId).slice(0, 8)} rawRows=${Array.isArray(rows) ? rows.length : "-"} latest=${c.snapshotDate || "-"} complete=${c.complete}` + (c.complete ? ` compactRows=${c.metadata.compactedRowCount} compactMB=${(c.metadata.compactedPayloadBytes / 1048576).toFixed(3)}` : ` reason=${c.reason}`));
  }
  log("DRY-RUN complete. ZERO creates, ZERO tokens.");
  process.exit(0);
}

// Stage 3: RECOVER by latest-snapshot COMPACTION of the EXISTING exports -- ZERO new creates. For each child: read its
// retained export id, download it READ-ONLY, compact to the latest PROVABLY-COMPLETE date, and persist the compacted
// (<8MB, <50000-row) payload under the child's canonical hash with normalization metadata. If a child's latest date is
// not provably complete, stop that account (never infer completeness, never raise a limit). No cycle machinery, so the
// successful [5] batch, the failed parent export, and the six fresh accounts are untouched.
const before = await balanceNow();
log(`usable balance before: ${before}`);
const recovered = []; const skipped = []; const failed = [];
for (const s of childSources) {
  const seller = String(s.sellerOrVendorIds[0]);
  if (await getSourceExportCache(s.requestHash)) { skipped.push(seller); log(`SKIP ${seller.slice(0, 6)}: already cached (previously recovered).`); continue; }
  const exportId = await markerExportId(s.requestHash);
  if (!exportId) { failed.push({ seller, error: "no-retained-export" }); log(`STOP-ACCOUNT ${seller.slice(0, 6)}: no retained export id -> reuse impossible; a NEW export would be required (NOT authorized).`); continue; }
  let rows; try { rows = await downloadExport(primaryApiKey, exportId); } catch (e) { failed.push({ seller, error: "download-failed" }); log(`WARN ${seller.slice(0, 6)} download failed (LKG preserved): ${String(e && e.message || e).slice(0, 80)}`); continue; }
  const c = compactLatestInventorySnapshot({ rows, seller, marketplace: "IN", rowCap: Number(s.limit) || undefined, exportRef: exportId, requestedFrom: s.from, requestedTo: s.to });
  if (!c.complete) { failed.push({ seller, error: c.reason }); log(`STOP-ACCOUNT ${seller.slice(0, 6)}: latest date NOT provably complete (${c.reason}); NOT persisted.`); continue; }
  await saveSourceExportCache({ requestHash: s.requestHash, sourceId: s.sourceId, organizationFingerprint: s.organizationFingerprint, accountScopeHash: s.accountScopeHash, requestMeta: { ...(s.requestMeta || {}), ...c.metadata }, rows: c.rows, payloadBytes: c.metadata.compactedPayloadBytes, expiresAt: new Date(Date.now() + 8 * 3600 * 1000).toISOString() });
  const verify = await getSourceExportCache(s.requestHash);
  recovered.push({ seller, snapshotDate: c.snapshotDate, rawRows: c.metadata.rawRowCount, compactRows: c.metadata.compactedRowCount, rawMB: (c.metadata.rawPayloadBytes / 1048576).toFixed(2), compactMB: (c.metadata.compactedPayloadBytes / 1048576).toFixed(3), cached: !!verify });
  log(`RECOVERED ${seller.slice(0, 6)}: latest ${c.snapshotDate} ${c.metadata.compactedRowCount} rows (${(c.metadata.compactedPayloadBytes / 1048576).toFixed(3)}MB, from ${c.metadata.rawRowCount} rows / ${(c.metadata.rawPayloadBytes / 1048576).toFixed(2)}MB) persisted under ${String(s.requestHash).slice(0, 12)} cache=${!!verify}`);
}
const after = await balanceNow();
log(`usable balance after: ${after}; attributable usage: ${before != null && after != null ? before - after : "unknown"} tokens (ZERO creates -- reused existing exports); recovered=${recovered.length} skipped=${skipped.length} failed=${failed.length}`);

// Stage 4: materialize the v3 per-account inventory aliases for the recovered accounts (ZERO export). v3 single-seller
// inventory hashes match the FBA children, so the materializer reads each compacted child inventory + writes the alias.
try {
  const recSet = new Set(recovered.map((r) => r.seller));
  const recAccounts = overflowAccounts.filter((a) => { try { const r = resolveDataDoeAccountIds([a.accountId], connections); return recSet.has(String(r.rawAccountIds[0])); } catch { return false; } });
  if (recAccounts.length) {
    const v3Plan = planListingHealthV3BucketBatched({ accounts: recAccounts, connections: release.connections, asOfFor: () => cycleDate, inventoryAsOf: cycleDate, overflowSellers });
    const mat = await materializeListingHealthV3PerAccount({ plans: v3Plan, connections: release.connections, readSourceCache: getSourceExportCache, writeSourceCache: saveSourceExportCache, readAliasMeta: async (h) => { const e = await getSourceExportCacheMeta(h); return e && e.request_meta ? { batchFetchedAt: e.request_meta.batchFetchedAt } : null; } });
    log(`v3 per-account inventory aliases materialized: written=${mat.aliasesWritten} empty=${mat.emptyAliases} batchMissing=${mat.batchMissing}`);
  }
} catch (e) { log("WARN v3 alias materialization failed (non-fatal, re-runnable): " + String(e && e.message || e)); }

log("NOTE: recovered inventory is now current + isolated (compacted LATEST snapshot, cached under each child hash; no");
log("      dates summed). The FBA plan LIVE snapshot for these accounts refreshes on the next daily India FBA cycle,");
log("      which now compacts single-seller latest-snapshot inventory before persistence (deployed source-worker contract).");
if (failed.length) { console.error(`STOP partial: recovered=${recovered.length} skipped=${skipped.length} failed=${JSON.stringify(failed.map((f) => f.seller.slice(0, 6) + ":" + f.error))}. Provide a separately authorized plan for the failures.`); process.exit(1); }
log(`DONE: recovered ${recovered.length} account(s) via latest-snapshot compaction; ${skipped.length} already fresh. ZERO creates/tokens.`);
process.exit(0);
