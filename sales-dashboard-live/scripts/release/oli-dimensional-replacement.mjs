// TRUSTED, ONE-TIME OLI DIMENSIONAL HISTORICAL REPLACEMENT for ONE bucket (DIRECT re-export, cycle-independent).
// Re-exports the FULL canonical Order Line Items history [fixed-start .. asOf] with the NEW 9-column contract
// (amazon_order_status / fulfillment_channel / address_state / address_city) and persists it dimensionally
// through the atomic replace_oli_dimensional_window RPC (replaces the dimensional rows + the NON-cancelled daily
// rollup in source_oli_daily_history + coverage). It is DIRECT (does not open a daily sync_cycle) so it is never
// blocked by the day's terminal cycle, and it uses BOUNDED windows so the high-cardinality dimensional grain
// (address_city) never truncates an export.
//
//   node scripts/release/oli-dimensional-replacement.mjs --bucket=us|non-us [--as-of=YYYY-MM-DD] [--window-days=N] [--apply]
//
// DRY by default: reconciles accounts, proves the plan, FREEZES the exact export/token ceiling, checks the live
// balance -- writes nothing, spends nothing. --apply performs the replacement:
//   - refuses to start while any Scheduler-v2 / manual OLI operation is active on THIS bucket (no collision);
//   - refuses BEFORE the first create if the usable balance is below the frozen ceiling;
//   - <=5 sellers/export, US/Non-US never mixed; a TRUNCATED export (rows at the row cap) is a typed STOP
//     (never a partial save); an OLD pre-dimensional export is never adopted (the 9-column identity differs);
//   - a value-missing / status-missing account is BLOCKED (LKG preserved) and reported separately.
// Never prints a seller/account/export id (only counts + short prefixes). Campaign Ads / FBA untouched.

import { loadReleaseEnv } from "./env-bootstrap.mjs";

loadReleaseEnv();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const bucket = argOf("bucket");
const asOfArg = argOf("as-of");
const WINDOW_DAYS = Math.max(15, Math.min(180, Math.trunc(Number(argOf("window-days") ?? 60))));
const APPLY = process.argv.includes("--apply");
if (bucket !== "us" && bucket !== "non-us") { console.error("STOP --bucket must be us|non-us"); process.exit(2); }

const { buildBucketSourceSyncRuntime } = await import("../../lib/server/sync/source-bucket-sync-runtime.js");
const { assignAccountBatches, MAX_ACCOUNTS_PER_BATCH } = await import("../../lib/server/sync/source-batching.js");
const { oliDimensionalRowsFromFragment, oliBackfillWindow } = await import("../../lib/server/sync/source-durable-model.js");
const { fetchExportRows } = await import("../../lib/server/datadoe.js");
const { getDataDoeTokenBalance } = await import("../../lib/server/datadoe-usage.js");
const { addDaysStr } = await import("../../lib/server/date-windows.js");
const { OLI_SALES_COLUMNS } = await import("../../lib/server/sync/report-source-contracts.js");
const pgMod = (await import("pg")).default;

const OLI_ID = "89b27535d27c2a94db5ae39af4717f542624ff4df7802fd633e16c78674a1778";
const OLI_AGGREGATIONS = [{ column: "item_price_value", aggregation: "sum", alias: "total_sales_sum" }, { column: "quantity", aggregation: "sum", alias: "total_units_sum" }];
const ROW_CAP = 50000; // the direct historical fetch accepts a large response; a result AT the cap is truncated.
const log = (m) => console.log("oli-dim-replace[" + bucket + "]: " + m);

const runtime = buildBucketSourceSyncRuntime({ budgetMs: 550_000, ...(asOfArg ? { asOfOverride: asOfArg } : {}) });
const dl = runtime.makeDeadline();
const pf = await runtime.preflightEvidence({ bucket, sourceKey: "order-line-items", deadline: dl });
const accounts = (pf.accounts || []).filter((a) => a.rawSellerId && a.accountId);
if (!accounts.length) { console.error("STOP no discovered accounts for " + bucket); process.exit(1); }
const asOf = pf.asOf;
const orgFp = pf.orgFingerprint || (pf.primary && (pf.primary.organizationFingerprint));
if (!orgFp) { console.error("STOP no organization fingerprint from preflight"); process.exit(1); }
const backfill = oliBackfillWindow(asOf); // [fixed-start, asOf]
log("discovered " + accounts.length + " primary accounts; full window [" + backfill.from + ".." + backfill.to + "]; <=" + WINDOW_DAYS + "-day exports");

// Bounded windows across [fixed-start .. asOf].
const windows = [];
for (let from = backfill.from; from <= backfill.to;) {
  let to = addDaysStr(from, WINDOW_DAYS - 1);
  if (to > backfill.to) to = backfill.to;
  windows.push({ from, to });
  from = addDaysStr(to, 1);
}
const { batches } = assignAccountBatches(accounts, pf.membership, MAX_ACCOUNTS_PER_BATCH);
const ceiling = batches.length * windows.length; const tokenCeiling = ceiling * 2;
log("FROZEN ceiling: " + ceiling + " exports (" + batches.length + " batches x " + windows.length + " windows) / " + tokenCeiling + " tokens");

const balRead = await getDataDoeTokenBalance({ apiKey: process.env.DATADOE_API_KEY }).catch(() => null);
const balance = balRead && balRead.read === "ok" ? Number(balRead.usable) : null;
log("usable token balance: " + (balance == null ? "UNREADABLE" : balance));

if (!APPLY) { log("DRY RUN complete (no writes, no exports). Re-run with --apply to perform the replacement."); process.exit(0); }

// ---- APPLY guards ----
if (balance == null || balance < tokenCeiling) { console.error("STOP insufficient/unreadable balance (" + balance + ") < frozen ceiling " + tokenCeiling + " -- refusing before the first create."); process.exit(1); }
const gc = new pgMod.Client({ connectionString: String(process.env.POSTGRES_URL).split("?")[0], ssl: { rejectUnauthorized: false } });
await gc.connect();
const activeOpen = (await gc.query("select count(*)::int n from public.sync_source_jobs j join public.sync_cycles y on y.id=j.cycle_id where y.status='running' and y.bucket=$1 and y.cycle_date >= (now()::date - 1) and (j.fetch_status='pending' or j.fetch_status='attempted') and j.source_key='order-line-items'", [bucket])).rows[0].n;
await gc.end();
if (activeOpen > 0) { console.error("STOP a Scheduler-v2/manual OLI operation is ACTIVE for " + bucket + " (" + activeOpen + " open OLI jobs) -- not colliding."); process.exit(1); }
log("no-collision proof: 0 active open OLI jobs on a current " + bucket + " cycle.");

// A (batch, window) is ALREADY DONE when EVERY account in the batch already has DIMENSIONAL rows inside
// [from, to] -- i.e. this replacement previously persisted it. (source_coverage cannot be used: the ORIGINAL
// pre-dimensional OLI backfill left coverage for every window, so it would falsely skip the blocked windows.)
// A resumable re-run then re-fetches ONLY the windows a blocked account left without dimensional rows.
const skipClient = new pgMod.Client({ connectionString: String(process.env.POSTGRES_URL).split("?")[0], ssl: { rejectUnauthorized: false } });
await skipClient.connect();
async function batchWindowCovered(batch, w) {
  const ids = batch.accounts.map((a) => a.accountId);
  const r = await skipClient.query(
    "select count(distinct account_id)::int n from public.source_oli_dimensional_history where organization_fingerprint=$1 and connection_id='primary' and account_id = any($2::text[]) and sale_date between $3 and $4",
    [orgFp, ids, w.from, w.to],
  );
  return r.rows[0].n >= ids.length; // every account already has dimensional evidence for this window
}

let created = 0; let persisted = 0; let skipped = 0; const blockedAll = [];
for (const batch of batches) {
  const sellerIds = [...new Set(batch.accounts.map((a) => a.rawSellerId))].sort();
  const accountsBySellerId = Object.fromEntries(batch.accounts.map((a) => [a.rawSellerId, { accountId: a.accountId, currency: a.currency }]));
  for (const w of windows) {
    if (await batchWindowCovered(batch, w)) { skipped += 1; continue; } // every account already covers this window
    if (created >= ceiling) { console.error("STOP frozen ceiling reached (" + ceiling + ") -- refusing further creates."); process.exit(1); }
    let rows;
    try {
      rows = await fetchExportRows(process.env.DATADOE_API_KEY, OLI_ID, OLI_SALES_COLUMNS, sellerIds, w.from, w.to, ROW_CAP, { groupBy: OLI_SALES_COLUMNS, aggregations: OLI_AGGREGATIONS, orderByColumn: "date", orderByDirection: "ASC" });
    } catch (e) { console.error("STOP export failed for [" + w.from + ".." + w.to + "] (" + sellerIds.length + " sellers): " + String(e && e.message).slice(0, 120)); process.exit(1); }
    created += 1;
    if (rows.length >= ROW_CAP) { console.error("STOP TRUNCATED: [" + w.from + ".." + w.to + "] returned " + rows.length + " rows at the cap -- narrow --window-days and re-run (never a partial save)."); process.exit(1); }
    const hash = "oli-dim-replace:" + w.from + ".." + w.to; // a stable provenance hash for these direct rows
    const { byAccount, blocked } = oliDimensionalRowsFromFragment({ rows, accountsBySellerId, organizationFingerprint: orgFp, connectionId: "primary", sourceRequestHash: hash });
    for (const b of blocked) blockedAll.push({ ...b, from: w.from, to: w.to });
    const blockedSet = new Set(blocked.map((b) => b.accountId));
    for (const a of batch.accounts) {
      if (blockedSet.has(a.accountId)) continue;
      // Persist via DIRECT pg (the RPC), not the PostgREST wrapper: a busy account's dimensional window is
      // multi-MB of rows and exceeds PostgREST's request-body limit; direct pg handles it (the RPC itself is
      // identical). The RPC folds the non-cancelled rollup internally, so no rollupRows are threaded here.
      const dimRows = byAccount.get(a.accountId) || [];
      const pRows = dimRows.map((r) => ({ seller_or_vendor_id: r.seller_or_vendor_id, sale_date: r.sale_date, sku: r.sku, child_asin: r.child_asin, currency: r.currency, amazon_order_status: r.amazon_order_status, fulfillment_channel: r.fulfillment_channel, address_state: r.address_state, address_city: r.address_city, total_sales_sum: r.total_sales_sum, total_units_sum: r.total_units_sum, source_request_hash: r.source_request_hash }));
      try {
        await skipClient.query("select public.replace_oli_dimensional_window($1,$2,$3,$4,$5,$6::jsonb,now())", [orgFp, "primary", a.accountId, w.from, w.to, JSON.stringify(pRows)]);
        persisted += 1;
      } catch (e) {
        const msg = String(e && e.message ? e.message : e);
        if (msg.includes("OLI_NON_CANCELLED_VALUE_MISSING")) { blockedAll.push({ accountId: a.accountId, code: "OLI_NON_CANCELLED_VALUE_MISSING", from: w.from, to: w.to }); continue; }
        if (msg.includes("OLI_ORDER_STATUS_MISSING")) { blockedAll.push({ accountId: a.accountId, code: "OLI_ORDER_STATUS_MISSING", from: w.from, to: w.to }); continue; }
        console.error("STOP persist failed for account " + a.accountId.slice(0, 8) + " [" + w.from + ".." + w.to + "]: " + msg.slice(0, 160)); await skipClient.end().catch(() => {}); process.exit(1);
      }
    }
  }
  log("batch [" + sellerIds.length + " sellers] done: " + windows.length + " windows");
}
await skipClient.end().catch(() => {});
log("REPLACEMENT COMPLETE: " + created + " exports created / " + (created * 2) + " tokens; " + skipped + " (batch,window) already-covered skipped (zero tokens); " + persisted + " (account,window) rollups persisted; " + blockedAll.length + " blocked (LKG preserved).");
if (blockedAll.length) log("BLOCKED (invalid non-cancelled zero-value / missing status; LKG kept): " + blockedAll.slice(0, 12).map((b) => b.accountId.slice(0, 8) + ":" + b.code + "@" + b.from).join(" "));
process.exit(0);
