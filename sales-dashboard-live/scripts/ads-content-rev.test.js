// Item 2 regression: adsWindowContentRev is the durable per-account Ads CONTENT revision the sync writer stamps on
// ads_sync_state.content_rev. It must change IFF the persisted row VALUES change (a same-window correction) and be
// byte-stable on an unchanged re-sync + independent of row order and metrics/dimensions key order (so a Brand View
// zero-write replay holds). Pure; ZERO I/O. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { adsWindowContentRev } from "../lib/server/ads-sync.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "ads-content-rev (Item 2)\n");

const row = (over = {}) => ({
  dimension_key: "camp-1|SP", metric_date: "2026-09-06", marketplace_country_code: "IN", currency: "INR",
  metrics: { ad_spend: 100, ad_sales: 400, ad_clicks: 20 }, dimensions: { campaign_id: "camp-1" }, ...over,
});
const base = [row(), row({ dimension_key: "camp-2|SB", metrics: { ad_spend: 50, ad_sales: 150, ad_clicks: 8 } })];

ok("A: empty rows -> null (no content identity)", adsWindowContentRev([]) === null && adsWindowContentRev(undefined) === null);

const revBase = adsWindowContentRev(base);
ok("A: a non-empty window -> a 40-hex content revision", typeof revBase === "string" && /^[0-9a-f]{40}$/.test(revBase));

// REPLAY-STABLE: identical values (even re-fetched) -> identical rev.
ok("B: an unchanged re-sync yields the SAME rev (replay-stable -> zero-write)", adsWindowContentRev(base.map((r) => ({ ...r, metrics: { ...r.metrics }, dimensions: { ...r.dimensions } }))) === revBase);

// ORDER-INDEPENDENT: row order does not change the rev.
ok("B: row ORDER does not change the rev", adsWindowContentRev([base[1], base[0]]) === revBase);

// KEY-ORDER-INDEPENDENT: metrics/dimensions key order does not change the rev (canonicalized).
const permutedKeys = [
  row({ metrics: { ad_clicks: 20, ad_sales: 400, ad_spend: 100 }, dimensions: { campaign_id: "camp-1" } }),
  row({ dimension_key: "camp-2|SB", metrics: { ad_sales: 150, ad_clicks: 8, ad_spend: 50 } }),
];
ok("B: metrics/dimensions KEY order does not change the rev (canonicalization)", adsWindowContentRev(permutedKeys) === revBase);

// CORRECTION: a same-date/same-window spend correction (value change) -> DIFFERENT rev.
const corrected = [row({ metrics: { ad_spend: 123, ad_sales: 400, ad_clicks: 20 } }), base[1]];
ok("C: a SAME-WINDOW value correction (spend 100 -> 123, dates/grain unchanged) changes the rev", adsWindowContentRev(corrected) !== revBase);

// A clicks-only correction also flips it (all persisted metrics participate).
const clicksCorrected = [row({ metrics: { ad_spend: 100, ad_sales: 400, ad_clicks: 21 } }), base[1]];
ok("C: a clicks-only correction also changes the rev", adsWindowContentRev(clicksCorrected) !== revBase);

writeSync(1, `\nads-content-rev: ${passed} assertions passed\n`);
