// TRUSTED operator for the ADAPTIVE FBA Inventory overflow recovery. It recovers the accounts blocked by a terminal
// TRUNCATED (oversized) inventory batch by re-fetching them as SINGLE-SELLER inventory exports -- reusing the SHARED
// fba-plan operation core (fetch -> derive -> publish -> read-back -> safe-close), a FROZEN inventory recovery tranche
// (atomic pre-POST reservation), and the adaptive planner split (overflowSellers). It NEVER retries/recreates the
// failed parent export or the successful sibling batch, and NEVER raises the 50000 row cap.
//
//   node scripts/release/fba-inventory-recovery.mjs --region=india --mode=dry-run   [--cycle-date=YYYY-MM-DD]
//   node scripts/release/fba-inventory-recovery.mjs --region=india --mode=recover --cycle-date=YYYY-MM-DD \
//       --confirm=fba-inventory-recovery/india/YYYY-MM-DD [--max-creates=3]
//
// dry-run: ZERO creates -- discovers accounts, derives the proven-overflow sellers from recent terminal TRUNCATED
//   evidence, plans the single-seller children, proves the create/token cost vs --max-creates. It never fetches.
// recover: refuses unless the operator is authorized + --confirm is exact; then runs ONE bounded recovery to
//   completion, creating at most --max-creates single-seller inventory exports (a frozen tranche caps it atomically).
//   If any single-seller child reaches the 50000 cap it is a HARD STOP for that account (never auto-raise the limit).

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
const { fetchExportRowsStrict } = await import("../../lib/server/datadoe.js");
const { validateBatchSourcePayload } = await import("../../lib/server/sync/source-account-isolation.js");
const { materializeListingHealthV3PerAccount } = await import("../../lib/server/sync/listing-health-v3-materialize.js");
const { planListingHealthV3BucketBatched } = await import("../../lib/server/sync/report-planner.js");
const { getSourceExportCache, saveSourceExportCache, getSourceExportCacheMeta } = await import("../../lib/server/supabase.js");

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
if (mode === "dry-run") { log(`DRY-RUN complete: ${childSources.length} children, ${cost.creates} creates. Budget-model estimate ${cost.tokens} tokens (premium class); OBSERVED billing is ~2/export => ~${cost.creates * 2} tokens expected. ZERO creates made.`); process.exit(0); }

// Stage 3: RECOVER via a DIRECT, fully-controlled single-seller fetch per child. fetchExportRowsStrict makes AT MOST
// ONE create-export per canonical request_hash (marker protocol: persists the export id before polling, resumes the
// same export on a later invocation, and a replay reuses the durable cache -> ZERO new creates), persists the rows
// under the child's canonical hash ONLY when under the 50000 cap, and THROWS on a cap-sized (TRUNCATED) result -- a
// HARD STOP for that account (never re-created, never limit-raised). No cycle machinery, so it cannot touch the
// terminal daily cycle, the successful [5] batch, or the failed parent export.
const before = await balanceNow();
log(`usable balance before: ${before}`);
const recovered = []; const failed = []; const hardStops = [];
for (const s of childSources) {
  const seller = String(s.sellerOrVendorIds[0]);
  const columns = (s.requestMeta && s.requestMeta.columns) || [];
  let rows = null;
  try {
    rows = await fetchExportRowsStrict(primaryApiKey, s.sourceId, columns, s.sellerOrVendorIds, s.from, s.to, s.limit, s.options || {}, `FBA inventory ${seller.slice(0, 6)}`);
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (/row cap/i.test(msg)) { hardStops.push(seller); log(`HARD STOP ${seller.slice(0, 6)}: single-seller export reached the 50000 cap -- cannot split further; NOT recovered, limit NOT raised.`); continue; }
    failed.push({ seller, error: msg.slice(0, 120) }); log(`WARN ${seller.slice(0, 6)} fetch failed (LKG preserved): ${msg.slice(0, 120)}`); continue;
  }
  // Isolation validation (exact single seller + IN marketplace); a cross-account/marketplace row fails closed.
  const bv = validateBatchSourcePayload({ rows, sellerOrVendorIds: [seller], sourceScope: "seller", marketplaceScoped: true, marketplacePairs: [{ sellerId: seller, marketplace: "IN" }] });
  if (!bv.valid) { failed.push({ seller, error: "isolation:" + bv.code }); log(`WARN ${seller.slice(0, 6)} isolation check failed (${bv.code}); not counted recovered.`); continue; }
  const cached = await getSourceExportCache(s.requestHash);
  recovered.push({ seller, hash: s.requestHash, rows: rows.length, cached: !!cached });
  log(`RECOVERED ${seller.slice(0, 6)}: ${rows.length} rows (< 50000), isolated (IN), persisted under ${String(s.requestHash).slice(0, 12)} cache=${!!cached}`);
}
const after = await balanceNow();
log(`usable balance after: ${after}; attributable usage: ${before != null && after != null ? before - after : "unknown"} tokens; recovered=${recovered.length} hardStops=${hardStops.length} failed=${failed.length}`);

// Stage 4: materialize the per-account v3 inventory aliases for the recovered children (ZERO export). v3 single-seller
// inventory hashes match the FBA children, so the materializer reads each child inventory + writes the per-account alias.
try {
  const recoveredAccounts = overflowAccounts.filter((a) => { try { const r = resolveDataDoeAccountIds([a.accountId], connections); return r && recovered.some((x) => x.seller === String(r.rawAccountIds[0])); } catch { return false; } });
  if (recoveredAccounts.length) {
    const v3Plan = planListingHealthV3BucketBatched({ accounts: recoveredAccounts, connections: release.connections, asOfFor: () => cycleDate, inventoryAsOf: cycleDate, overflowSellers });
    const mat = await materializeListingHealthV3PerAccount({ plans: v3Plan, connections: release.connections, readSourceCache: getSourceExportCache, writeSourceCache: saveSourceExportCache, readAliasMeta: async (h) => { const e = await getSourceExportCacheMeta(h); return e && e.request_meta ? { batchFetchedAt: e.request_meta.batchFetchedAt } : null; } });
    log(`v3 per-account inventory aliases materialized: written=${mat.aliasesWritten} empty=${mat.emptyAliases} batchMissing=${mat.batchMissing}`);
  }
} catch (e) { log("WARN v3 alias materialization failed (non-fatal, re-runnable): " + String(e && e.message ? e.message : e)); }

log("NOTE: the recovered per-account inventory is now current + isolated (cached under each child hash). The FBA plan");
log("      LIVE snapshot for these accounts is refreshed by the next daily India FBA cycle, which now self-heals via the");
log("      deployed adaptive split (a FRESH cycle deriving+publishing from these single-seller inventory children).");
if (hardStops.length || failed.length) { console.error(`STOP partial recovery: recovered=${recovered.length} hardStops=${JSON.stringify(hardStops.map((s) => s.slice(0, 6)))} failed=${JSON.stringify(failed.map((f) => f.seller.slice(0, 6)))}. Region remains honestly partial.`); process.exit(1); }
log(`DONE: recovered ${recovered.length}/${overflowAccounts.length} account(s) as isolated single-seller inventory.`);
process.exit(0);
