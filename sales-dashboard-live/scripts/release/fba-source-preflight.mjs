// READ-ONLY FBA go-live preflight (ZERO DataDoe tokens): proves the credential path in GitHub Actions and answers the
// batching-feasibility question before any code change or create. It (1) reads the live DataDoe token balance, and
// (2) fetches GET /exports/sources for a few representative sellers and reports, for the FBA Inventory Health and
// Listings sources, the exact available column names -- specifically whether `seller_or_vendor_id` is available (which
// is what a <=5-seller batched export needs to be splittable per account). NO exports are created.
//
//   node scripts/release/fba-source-preflight.mjs
//
// Prints a compact, secret-free report to stdout (never prints the API key).

import pg from "pg";

const apiKey = process.env.DATADOE_API_KEY;
if (!apiKey) { console.error("STOP DATADOE_API_KEY not configured."); process.exit(1); }
const DATADOE_BASE = process.env.DATADOE_BASE || "https://api.datadoe.com";
const FBA_HEALTH_ID = "44fc5ba0ce81a7807601f6d7a9b8b7aaec64be4c7e046ea30dc6864d1a4aa823";
const LISTINGS_ID = "ba689c05d7f7cee1a1690990c28995680a0654b7ed258230f4173d61bbcd1ab3";
const hdr = { "datadoe-api-key": apiKey, "Content-Type": "application/json" };

// ---- 1) balance (zero-token usage-logs read) ----
async function balance() {
  const r = await fetch(`${DATADOE_BASE}/usage-logs?pageSize=100`, { headers: hdr });
  if (!r.ok) return { read: "error", status: r.status };
  const b = await r.json();
  const rows = Array.isArray(b?.data) ? b.data : (Array.isArray(b) ? b : []);
  if (!rows.length) return { read: "empty" };
  const latest = rows.slice().sort((a, c) => String(c?.usedAt).localeCompare(String(a?.usedAt)))[0];
  const usable = (Number(latest.balanceAfter) || 0) + (Number(latest.extraTokensAfter) || 0) + (Number(latest.bundleTokensAfter) || 0);
  return { read: "ok", usable, asOf: String(latest.usedAt || "") };
}

// ---- representative sellers from durable OLI (raw DataDoe seller ids) ----
async function sellers() {
  const u = new URL(process.env.POSTGRES_URL); u.searchParams.set("sslmode", "no-verify");
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  const rows = (await c.query(`select distinct seller_or_vendor_id from public.source_oli_daily_history where seller_or_vendor_id is not null and btrim(seller_or_vendor_id) <> '' limit 4`)).rows;
  await c.end();
  return rows.map((r) => String(r.seller_or_vendor_id).trim()).filter(Boolean);
}

function fieldsOf(src) {
  // Try the common shapes DataDoe uses for per-source column metadata.
  for (const k of ["columns", "fields", "availableColumns", "schema", "attributes"]) {
    const v = src && src[k];
    if (Array.isArray(v)) return v.map((f) => String((f && (f.name ?? f.column ?? f.field ?? f.key)) ?? f).trim()).filter(Boolean);
  }
  return null;
}

const bal = await balance();
console.log("== DataDoe balance ==", JSON.stringify(bal));

const ids = await sellers();
console.log("== representative sellers ==", ids.length);
let reported = { fbaHealth: null, listings: null };
for (const sellerId of ids) {
  const r = await fetch(`${DATADOE_BASE}/exports/sources?sellerOrVendorIds=${encodeURIComponent(sellerId)}`, { headers: hdr });
  if (!r.ok) { console.log(`  seller ${sellerId.slice(0, 6)}...: /exports/sources HTTP ${r.status}`); continue; }
  const body = await r.json();
  const list = Array.isArray(body?.sources) ? body.sources : [];
  const names = list.map((s) => String(s?.name || "").trim()).filter(Boolean);
  const findBy = (idOrName) => list.find((s) => String(s?.id || s?.sourceId || "") === idOrName)
    || list.find((s) => String(s?.name || "").toLowerCase().includes(idOrName));
  const fba = findBy(FBA_HEALTH_ID) || findBy("inventory health") || findBy("fba inventory");
  const lst = findBy(LISTINGS_ID) || findBy("listing");
  console.log(`  seller ${sellerId.slice(0, 6)}...: ${names.length} sources; FBA-health=${!!fba} listings=${!!lst}`);
  if (fba && !reported.fbaHealth) {
    const f = fieldsOf(fba);
    reported.fbaHealth = { name: fba.name, columns: f, hasSellerId: f ? f.map((x) => x.toLowerCase()).includes("seller_or_vendor_id") : "unknown-shape", raw: f ? undefined : JSON.stringify(fba).slice(0, 1200) };
  }
  if (lst && !reported.listings) {
    const f = fieldsOf(lst);
    reported.listings = { name: lst.name, columns: f, hasSellerId: f ? f.map((x) => x.toLowerCase()).includes("seller_or_vendor_id") : "unknown-shape", raw: f ? undefined : JSON.stringify(lst).slice(0, 1200) };
  }
  if (reported.fbaHealth && reported.listings) break;
}
console.log("== FBA Inventory Health source metadata ==", JSON.stringify(reported.fbaHealth, null, 2));
console.log("== Listings/AWD source metadata ==", JSON.stringify(reported.listings, null, 2));
console.log("== FEASIBILITY: seller_or_vendor_id available? fbaHealth=" + (reported.fbaHealth?.hasSellerId) + " listings=" + (reported.listings?.hasSellerId) + " ==");
