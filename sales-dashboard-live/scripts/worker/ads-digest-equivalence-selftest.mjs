// OFFLINE PGlite self-test (in-process WASM Postgres; NEVER a real database): the SHARED per-day Ads digest partials
// (brand-view-dependency-readers.js ADS_DAILY_PARTIALS_SQL + splitAdsDailyPartials + adsWindowRowsFromDaily) against the
// two per-window statements they replace -- Brand View's ADS_ROWS_SQL (LEFT JOIN per account) and the portfolio's
// PORTFOLIO_ADS_ROWS_SQL (GROUP BY account) -- and the JS twin adsRowsDigest over the SAME rows read back, on real
// Postgres semantics (md5, to_char, bit(60)::bigint, numeric sums, the LEFT JOIN null-extension).
//   PRW_PGLITE_DIR=<repo>/sales-dashboard-live/scratchpad/pglite node scripts/worker/ads-digest-equivalence-selftest.mjs
// Exit 0 = all assertions pass; 1 = a failure; 3 = PGlite not available (SKIPPED -- not a pass).
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = process.env.PRW_PGLITE_DIR;
const entry = dir ? path.join(dir, "node_modules", "@electric-sql", "pglite", "dist", "index.js") : null;
let PGlite;
try { ({ PGlite } = await import(entry && existsSync(entry) ? pathToFileURL(entry).href : "@electric-sql/pglite")); }
catch { console.log("SKIPPED: PGlite not available (set PRW_PGLITE_DIR; see header). This is NOT a pass."); process.exit(3); }

const D = await import("../../lib/server/sync/brand-view-dependency-readers.js");
const BV = await import("../../lib/server/recovery/routes/brand-view.route.js");
const PF = await import("../../lib/server/recovery/routes/brand-view-portfolio.route.js");

let passed = 0, failed = 0;
const ok = (name, cond) => { if (cond) { passed += 1; console.log("  ok " + name); } else { failed += 1; console.log("  FAIL " + name); } };

const db = new PGlite();
await db.exec(`create table public.ads_daily_source_rows (
  source_key text not null, account_id text not null, marketplace_country_code text not null, metric_date date not null,
  dimension_key text not null, campaign_id text not null default '', campaign_type text not null default '', child_asin text not null default '',
  targeting_id text not null default '', currency text not null default '', dimensions jsonb not null default '{}', metrics jsonb not null default '{}',
  source_refreshed_at timestamptz not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  primary key (source_key, account_id, marketplace_country_code, metric_date, dimension_key))`);

let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const day = (base, plus) => new Date(Date.parse(base + "T00:00:00Z") + plus * 86400000).toISOString().slice(0, 10);
const usTs = (ms) => { const d = new Date(ms); return d.toISOString().replace(/\.(\d{3})Z$/, "." + String(d.getUTCMilliseconds()).padStart(3, "0") + String(Math.floor(rnd() * 1000)).padStart(3, "0") + "+00"); };
const ACTIVE = "campaign-performance-v1";
const ACCTS = ["IN1", "IN2", "GB1", "US1"]; // "EMPTY1" is requested but never has a row
let n = 0;
for (let i = 0; i < 2500; i += 1) {
  const acct = pick(ACCTS);
  const src = rnd() < 0.85 ? ACTIVE : "asin-performance-v1"; // another source key in the same table must never leak in
  const vals = [src, acct, pick(["IN", "GB", "US"]), day("2026-03-15", Math.floor(rnd() * 210)), "dim|" + i + (rnd() < 0.2 ? ":|é中" : ""),
    "c" + Math.floor(rnd() * 50), pick(["SP", "SB", "SD"]), rnd() < 0.3 ? "" : "B0" + Math.floor(rnd() * 1e6), "t" + (i % 17), pick(["INR", "GBP", "USD"]),
    usTs(Date.UTC(2026, 8, 1) + Math.floor(rnd() * 2e9)), usTs(Date.UTC(2026, 8, 1) + Math.floor(rnd() * 2e9))];
  const r = await db.query("insert into public.ads_daily_source_rows (source_key, account_id, marketplace_country_code, metric_date, dimension_key, campaign_id, campaign_type, child_asin, targeting_id, currency, source_refreshed_at, updated_at) values ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11::timestamptz,$12::timestamptz) on conflict do nothing", vals);
  n += r.affectedRows || 0;
}
ok(`seeded ${n} rows (2 source keys, 4 accounts, unicode / delimiter-laden dimension keys, microsecond instants)`, n > 2000);

// The build windows: every account at 2026-09-24 plus an account that never had a row.
const windows = ["IN1", "IN2", "GB1", "US1", "EMPTY1"].map((a) => ({ accountId: a, from: "2026-04-01", to: a === "US1" ? "2026-09-23" : "2026-09-24" }));
const union = { from: "2026-04-01", to: "2026-09-24" };

// 1. the OLD Brand View statement vs the new partials + fold (includeEmpty).
const oldBv = (await db.query(BV.ADS_ROWS_SQL, [windows.map((w) => w.accountId), windows.map((w) => w.from), windows.map((w) => w.to), ACTIVE])).rows;
const split = D.splitAdsDailyPartials((await db.query(D.ADS_DAILY_PARTIALS_SQL, [ACTIVE, union.from, union.to])).rows);
ok("the shared statement returns ONE sentinel echoing the scanned range", !!split && split.range.from === union.from && split.range.to === union.to);
const newBv = D.adsWindowRowsFromDaily(split.rows, windows, { includeEmpty: true });
const byA = (rows) => new Map(rows.map((r) => [r.account_id, r]));
const ob = byA(oldBv); const nb = byA(newBv);
ok("Brand View: for EVERY account WITH rows the new digest equals the old LEFT JOIN statement's EXACTLY", ["IN1", "IN2", "GB1", "US1"].every((a) => ob.get(a) && nb.get(a) && ob.get(a).rows_digest === nb.get(a).rows_digest && ob.get(a).win_from === nb.get(a).win_from && ob.get(a).win_to === nb.get(a).win_to));
const phantom = ob.get("EMPTY1") && ob.get("EMPTY1").rows_digest;
ok(`Brand View: for the account with NO row the OLD statement digests the LEFT JOIN's null-extended row (${phantom}: count 0, NON-zero lanes -- the latent defect: the JS twin can never match it)`, /^adr1:0:\d+:\d+$/.test(phantom) && phantom !== D.EMPTY_ADS_ROWS_DIGEST);
ok("Brand View: the new path yields the documented empty digest 'adr1:0:0:0' for it (== the JS twin over zero rows)", nb.get("EMPTY1").rows_digest === D.EMPTY_ADS_ROWS_DIGEST && D.adsRowsDigest([]) === D.EMPTY_ADS_ROWS_DIGEST);

// 1b. windows whose FROM side is inside the scanned range too (not only the `to` side): old statement == new fold.
const inner = [{ accountId: "IN2", from: "2026-05-10", to: "2026-08-31" }, { accountId: "GB1", from: "2026-06-01", to: "2026-06-30" }, { accountId: "IN1", from: "2026-09-24", to: "2026-09-24" }];
const oldInner = byA((await db.query(BV.ADS_ROWS_SQL, [inner.map((w) => w.accountId), inner.map((w) => w.from), inner.map((w) => w.to), ACTIVE])).rows);
const newInner = byA(D.adsWindowRowsFromDaily(split.rows, inner, { includeEmpty: true }));
const rowsIn = async (w) => (await db.query("select count(*)::int as n from public.ads_daily_source_rows where source_key = $1 and account_id = $2 and metric_date between $3::date and $4::date", [ACTIVE, w.accountId, w.from, w.to])).rows[0].n;
const counts = await Promise.all(inner.map(rowsIn));
ok("windows with an inner FROM bound fold to EXACTLY the old statement's digests whenever the window HAS rows",
  inner.every((w, i) => counts[i] === 0 || oldInner.get(w.accountId).rows_digest === newInner.get(w.accountId).rows_digest) && counts.filter((c) => c > 0).length >= 2);
ok("... and an EMPTY inner window (the single day) is the old phantom vs the documented 'adr1:0:0:0' -- the ONLY difference",
  inner.every((w, i) => counts[i] > 0 || (oldInner.get(w.accountId).rows_digest === phantom && newInner.get(w.accountId).rows_digest === D.EMPTY_ADS_ROWS_DIGEST)) && counts.some((c) => c === 0));

// 1c. the ACCOUNT-SCOPED twin (every reader without a sweep cache) folds to the SAME digests as the unscoped statement.
const scopedAccts = ["IN1", "US1", "EMPTY1"];
const scopedSplit = D.splitAdsDailyPartials((await db.query(D.ADS_DAILY_ACCOUNT_PARTIALS_SQL, [ACTIVE, union.from, union.to, scopedAccts])).rows);
const scopedWins = windows.filter((w) => scopedAccts.includes(w.accountId));
const viaScoped = byA(D.adsWindowRowsFromDaily(scopedSplit.rows, scopedWins, { includeEmpty: true }));
ok("the account-scoped twin returns ONLY the requested accounts' partials + ONE sentinel with the same range", !!scopedSplit && scopedSplit.range.from === union.from && scopedSplit.range.to === union.to && scopedSplit.rows.every((r) => scopedAccts.includes(r.account_id)));
ok("the account-scoped twin folds to the SAME digests as the unscoped statement (incl. the empty account)", scopedWins.every((w) => viaScoped.get(w.accountId).rows_digest === nb.get(w.accountId).rows_digest));

// 2. the OLD portfolio statement vs the new fold (GROUP BY semantics) over the IN window.
const inWin = { from: "2026-04-01", to: "2026-09-24" };
const oldPf = (await db.query(PF.PORTFOLIO_ADS_ROWS_SQL, [ACTIVE, inWin.from, inWin.to])).rows;
const accts = [...new Set(split.rows.map((r) => r.account_id))].sort();
const newPf = D.adsWindowRowsFromDaily(split.rows, accts.map((a) => ({ accountId: a, from: inWin.from, to: inWin.to })), { includeEmpty: false });
const sameRow = (a, b) => a.account_id === b.account_id && String(a.n) === String(b.n) && String(a.max_ua) === String(b.max_ua) && a.rows_digest === b.rows_digest && a.win_from === b.win_from && a.win_to === b.win_to;
ok(`portfolio: the new rows are IDENTICAL to the old GROUP BY statement's (${oldPf.length} accounts: n, max_ua, rows_digest, window)`, oldPf.length === newPf.length && oldPf.length === 4 && oldPf.every((r, i) => sameRow(r, newPf[i])));

// 3. the JS twin over the SAME rows read back (REST-like text shapes) equals the new digests.
const raw = (await db.query("select source_key, account_id, marketplace_country_code, metric_date::text as metric_date, dimension_key, campaign_id, campaign_type, child_asin, targeting_id, currency, source_refreshed_at::text as source_refreshed_at, updated_at::text as updated_at from public.ads_daily_source_rows where source_key = $1", [ACTIVE])).rows;
ok("the JS twin adsRowsDigest over the rows read back equals the new digest for every window (incl. the empty one)",
  windows.every((w) => D.adsRowsDigest(raw.filter((r) => r.account_id === w.accountId && r.metric_date >= w.from && r.metric_date <= w.to)) === nb.get(w.accountId).rows_digest));

// 4. an empty scan still proves its range (the sentinel), so a window outside it is detectable.
const emptySplit = D.splitAdsDailyPartials((await db.query(D.ADS_DAILY_PARTIALS_SQL, ["no-such-source", "2026-04-01", "2026-04-02"])).rows);
ok("an EMPTY scan returns exactly the sentinel (range proven, zero partials)", !!emptySplit && emptySplit.rows.length === 0 && emptySplit.range.to === "2026-04-02");

await db.close();
console.log(`ads-digest-equivalence-selftest: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
