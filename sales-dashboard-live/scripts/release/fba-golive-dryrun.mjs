// READ-ONLY FBA go-live cost dry-run (ZERO DataDoe tokens): plans fba-plan for all primary accounts and reports, per
// source request-key, how many distinct request_hashes are ALREADY in source_export_cache (adoptable, 0 tokens) vs
// must be fetched, plus the token cost of the fetches. This answers the decisive cost question -- whether fba-plan's
// OLI (3-month) + catalog are reusable or must be re-fetched -- BEFORE any create. No exports are created.
//
//   node scripts/release/fba-golive-dryrun.mjs
//
// Uses the CURRENT (single-account) planner, so counts are per-account; it reveals adoptability of every source.

import pg from "pg";
import { getDataDoeConnections } from "../../lib/server/datadoe-connections.js";
import { planFbaPlan } from "../../lib/server/sync/report-planner.js";
import { getSourceExportCache } from "../../lib/server/supabase.js";

const asOf = process.env.FBA_AS_OF || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const PREMIUM = new Set(["fba-plan:inventory-health", "fba-plan:awd"]);
const tokFor = (rk) => (PREMIUM.has(rk) ? 5 : 2);

const u = new URL(process.env.POSTGRES_URL); u.searchParams.set("sslmode", "no-verify");
const c = new pg.Client({ connectionString: u.toString() });
await c.connect();
const ad = (await c.query(`select payload from public.report_snapshots where report_key='account-directory' order by updated_at desc limit 1`)).rows[0]?.payload;
await c.end();
const accts = Array.isArray(ad?.accounts) ? ad.accounts : (Array.isArray(ad) ? ad : []);
if (!accts.length) { console.error("STOP no account-directory."); process.exit(1); }

const connections = getDataDoeConnections();
// requestKey -> { hashes:Set, byHash:Map(hash->{cached}) }
const perKey = new Map();
let planned = 0, usc = 0, nonus = 0;
for (const a of accts) {
  const accountId = String(a.accountId || a.id || a.account_id || "").trim();
  const country = String(a.country || a.marketCountry || a.marketplace || "").trim();
  if (!accountId) continue;
  if (country.toUpperCase() === "US") usc += 1; else nonus += 1;
  let plan;
  try { plan = planFbaPlan({ accountId, name: a.name || null, country, currency: a.currency || null, connections, asOf }); }
  catch (e) { console.error(`  plan failed ${accountId.slice(0, 6)}: ${e.message}`); continue; }
  planned += 1;
  for (const s of plan.sources || []) {
    const rk = s.requestKey; const h = s.requestHash;
    if (!rk || !h) continue;
    if (!perKey.has(rk)) perKey.set(rk, new Map());
    perKey.get(rk).set(h, null); // dedupe hashes
  }
}
console.log(`planned=${planned} accounts (us=${usc} nonUs=${nonus}) asOf=${asOf}`);

let totalFetch = 0, totalTokens = 0;
for (const [rk, hashes] of [...perKey.entries()].sort()) {
  let cached = 0, need = 0;
  for (const h of hashes.keys()) {
    let row = null;
    try { row = await getSourceExportCache(h); } catch { row = null; }
    if (row) cached += 1; else need += 1;
  }
  const tokens = need * tokFor(rk);
  totalFetch += need; totalTokens += tokens;
  console.log(`  ${rk}: distinct=${hashes.size} adoptable(cached)=${cached} need-fetch=${need} tokenClass=${PREMIUM.has(rk) ? "premium(5)" : "standard(2)"} fetch-tokens=${tokens}`);
}
console.log(`== PER-ACCOUNT TOTAL: ${totalFetch} creates need fetching / ${totalTokens} tokens (before any 5-seller batching) ==`);
console.log(`(5-seller batching would REDUCE OLI + catalog + FBA-Health create counts where multi-account/marketplace batches apply; AWD stays US-only.)`);
