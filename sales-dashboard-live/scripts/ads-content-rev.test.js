// Item 2 regression: adsWindowContentRev is the durable per-account Ads CONTENT revision the sync writer stamps on
// ads_sync_state.content_rev. It must change IFF the persisted row VALUES change (a same-window correction) and be
// byte-stable on an unchanged re-sync + independent of row order and metrics/dimensions key order (so a Brand View
// zero-write replay holds). Pure; ZERO I/O. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { adsWindowContentRev, committedContentRev, EMPTY_ADS_CONTENT_REV } from "../lib/server/ads-sync.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "ads-content-rev (Item 2)\n");

const row = (over = {}) => ({
  dimension_key: "camp-1|SP", metric_date: "2026-09-06", marketplace_country_code: "IN", currency: "INR",
  metrics: { ad_spend: 100, ad_sales: 400, ad_clicks: 20 }, dimensions: { campaign_id: "camp-1" }, ...over,
});
const base = [row(), row({ dimension_key: "camp-2|SB", metrics: { ad_spend: 50, ad_sales: 150, ad_clicks: 8 } })];

// Round-4 Defect 3: a SUCCESSFULLY-read EMPTY window gets a STABLE, NON-NULL revision (empty-success), distinct from
// any non-empty window and byte-stable across replays -- so a nonempty->empty transition flips the stored rev.
ok("A (empty-success): empty rows -> a stable non-null EMPTY revision (not null)",
  adsWindowContentRev([]) === EMPTY_ADS_CONTENT_REV && adsWindowContentRev(undefined) === EMPTY_ADS_CONTENT_REV
  && typeof EMPTY_ADS_CONTENT_REV === "string" && /^[0-9a-f]{40}$/.test(EMPTY_ADS_CONTENT_REV));

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

// ---- committedContentRev: describes COMMITTED durable data (window-independent, delete-aware, fail-soft) --------
// Item 3: the sync computes the rev by RE-READING the committed durable store over a CANONICAL window, so it
// describes committed data (not the fetch batch). A store double serves the committed rows for any [from..to].
const store = base.slice();
const reader = async ({ from, to }) => store.filter((r) => r.metric_date >= from && r.metric_date <= to);
const revW1 = await committedContentRev({ readDurableRows: reader, accountId: "a", sourceKey: "campaign-performance-v1", from: "2026-08-01", to: "2026-09-30", batchRowsFallback: [] });
const revW2 = await committedContentRev({ readDurableRows: reader, accountId: "a", sourceKey: "campaign-performance-v1", from: "2026-07-01", to: "2026-09-30", batchRowsFallback: [] });
ok("D (window-independent): the same COMMITTED rows read over two DIFFERENT windows that both contain them -> SAME rev",
  revW1 === revW2 && revW1 === revBase);

// A correction in the committed store flips the committed rev (even though the window is unchanged).
store[0] = row({ metrics: { ad_spend: 123, ad_sales: 400, ad_clicks: 20 } });
const revCorrected = await committedContentRev({ readDurableRows: reader, accountId: "a", sourceKey: "campaign-performance-v1", from: "2026-08-01", to: "2026-09-30", batchRowsFallback: [] });
ok("D (correction): a committed-store correction changes the committed rev", revCorrected !== revW1);

// A delete (fewer committed rows) changes the rev (delete-aware) -- the fetch-batch approach could not see this.
store.pop();
const revAfterDelete = await committedContentRev({ readDurableRows: reader, accountId: "a", sourceKey: "campaign-performance-v1", from: "2026-08-01", to: "2026-09-30", batchRowsFallback: [] });
ok("D (delete-aware): removing a committed row changes the rev", revAfterDelete !== revCorrected);

// Fail-soft: an ABSENT reader (pre-migration / unit path) falls back to the batch rows (never breaks the sync).
const revNoReader = await committedContentRev({ readDurableRows: null, accountId: "a", sourceKey: "s", from: "x", to: "y", batchRowsFallback: base });
ok("D (fail-soft): absent reader falls back to the batch-rows rev", revNoReader === revBase);
// A THROWN durable read is a transient failure, NOT a data change: it returns null so the caller PRESERVES the
// previous rev (contentRev || previous?.content_rev). Falling back to the narrower batch window here would compute
// a different rev over the SAME committed data -> a spurious content_rev flip -> an unwarranted Brand View rebuild.
const revThrows = await committedContentRev({ readDurableRows: async () => { throw new Error("read fail"); }, accountId: "a", sourceKey: "s", from: "x", to: "y", batchRowsFallback: base });
ok("D (fail-soft): a THROWN durable read returns null (preserve previous rev; no spurious flip over unchanged data)", revThrows === null);

// ---- Round-4 Defect 3: empty-SUCCESS vs read FAILURE through committedContentRev (nonempty -> empty invalidates) ----
// A store that starts with rows, then has them all removed (a complete authoritative empty), then replays empty.
const store2 = base.slice();
const reader2 = async ({ from, to }) => store2.filter((r) => r.metric_date >= from && r.metric_date <= to);
const revFull = await committedContentRev({ readDurableRows: reader2, accountId: "a", sourceKey: "s", from: "2026-08-01", to: "2026-09-30", batchRowsFallback: [] });
store2.length = 0; // all committed rows removed
const revEmptied = await committedContentRev({ readDurableRows: reader2, accountId: "a", sourceKey: "s", from: "2026-08-01", to: "2026-09-30", batchRowsFallback: [] });
ok("E (nonempty->empty): a committed store emptied of all rows FLIPS the rev to the stable EMPTY rev (invalidates dependents)",
  revFull !== revEmptied && revEmptied === EMPTY_ADS_CONTENT_REV);
const revEmptyReplay = await committedContentRev({ readDurableRows: reader2, accountId: "a", sourceKey: "s", from: "2026-08-01", to: "2026-09-30", batchRowsFallback: [] });
ok("E (empty replay): an unchanged empty re-read yields the SAME empty rev (replay-stable -> zero-write)", revEmptyReplay === revEmptied);
// Empty-SUCCESS (a real empty read) is DISTINCT from a read FAILURE (null): they must never be conflated.
ok("E (empty-success != failure): an empty successful read is the non-null EMPTY rev, a thrown read is null -- distinct",
  revEmptied === EMPTY_ADS_CONTENT_REV && revThrows === null && revEmptied !== revThrows);

writeSync(1, `\nads-content-rev: ${passed} assertions passed\n`);
