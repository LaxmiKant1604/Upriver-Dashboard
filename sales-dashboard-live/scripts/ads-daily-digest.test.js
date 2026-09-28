// Publication recovery tier-1 performance -- the SHARED per-day Ads digest partials + the worker's sweep cache. Offline
// (JS only; the real-Postgres equivalence against both old statements is scripts/worker/ads-digest-equivalence-
// selftest.mjs). Proves: folding per-day partials reproduces the JS twin adsRowsDigest over the SAME window EXACTLY (the
// digest is additive), incl. the empty set ('adr1:0:0:0'), boundaries, BigInt sums past 2^53 and max(updated_at);
// malformed partials / sentinels fail closed; the union window covers every marketplace's build window at timezone and
// month edges; the shared statement is region-independent; sweepMemoQuery runs a shared statement once per sweep, never
// caches a failure, freezes what it shares and leaves every other statement alone; the route contract types `shared`.
// Zero network. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { createHash } from "node:crypto";
import * as D from "../lib/server/sync/brand-view-dependency-readers.js";
import * as A from "../lib/server/recovery/routes/ads-daily-evidence.js";
import { sweepMemoQuery, buildEvidenceContext, evaluateRouteEvidence } from "../lib/server/recovery/routes.js";
import { workerRouteProblems } from "../lib/server/recovery/route-contract.js";
import { marketplaceToday } from "../lib/marketplaces.js";
import BV_ROUTE from "../lib/server/recovery/routes/brand-view.route.js";
import PF_ROUTE from "../lib/server/recovery/routes/brand-view-portfolio.route.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
const J = JSON.stringify;

// A deterministic pseudo-random generator (no Math.random: reproducible failures).
let seed = 0x9e3779b9;
const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const day = (base, plus) => new Date(Date.parse(base + "T00:00:00Z") + plus * 86400000).toISOString().slice(0, 10);
const TS = (ms) => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, ".$1000Z");

// JS per-day partials, computed with the SAME per-row digest text the SQL + the JS twin hash (adsRowDigestText).
function jsPartials(rows, from, to) {
  const groups = new Map();
  for (const r of rows) {
    if (r.metric_date < from || r.metric_date > to) continue;
    const k = r.account_id + "\u0000" + r.metric_date;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  for (const [k, list] of groups) {
    let s1 = 0n; let s2 = 0n; let ua = "";
    for (const r of list) {
      const h = createHash("md5").update(D.adsRowDigestText(r), "utf8").digest("hex");
      s1 += BigInt("0x" + h.slice(0, 15)); s2 += BigInt("0x" + h.slice(15, 30));
      const u = D.canonicalInstant(r.updated_at); if (u > ua) ua = u;
    }
    out.push({ account_id: list[0].account_id, metric_date: list[0].metric_date, n: String(list.length), s1: s1.toString(), s2: s2.toString(), max_ua: ua, range_from: from, range_to: to });
  }
  out.push({ account_id: null, metric_date: null, n: "0", s1: "0", s2: "0", max_ua: null, range_from: from, range_to: to });
  return out;
}
const mkRow = (acct, d, i) => ({
  source_key: "campaign-performance-v1", account_id: acct, marketplace_country_code: pick(["IN", "GB", "US", "AU"]), metric_date: d,
  dimension_key: "k|" + i + (rnd() < 0.2 ? ":|\n\u00e9" : ""), campaign_id: "c" + Math.floor(rnd() * 99), campaign_type: pick(["SP", "SB", "SD"]),
  child_asin: rnd() < 0.3 ? "" : "B0" + Math.floor(rnd() * 1e6), targeting_id: "t" + i, currency: pick(["INR", "GBP", "USD"]),
  source_refreshed_at: TS(Date.UTC(2026, 8, 20) + Math.floor(rnd() * 8e8)), updated_at: TS(Date.UTC(2026, 8, 20) + Math.floor(rnd() * 8e8) + (rnd() < 0.5 ? 123 : 0)),
});

// ---- 1. the fold == the JS twin, for many random windows -------------------------------------------------------------
{
  const accts = ["A1", "A2", "A3", "A4"]; // A4 has no row at all
  const rows = [];
  for (let i = 0; i < 1500; i += 1) rows.push(mkRow(pick(accts.slice(0, 3)), day("2026-03-01", Math.floor(rnd() * 230)), i));
  const scanFrom = "2026-03-01"; const scanTo = "2026-10-20";
  const split = D.splitAdsDailyPartials(jsPartials(rows, scanFrom, scanTo));
  let all = true; let checked = 0; let empties = 0;
  for (let t = 0; t < 400; t += 1) {
    const a = pick(accts); const f = day("2026-03-01", Math.floor(rnd() * 200)); const to = day(f, Math.floor(rnd() * 60));
    if (to > scanTo) continue;
    const want = D.adsRowsDigest(rows.filter((r) => r.account_id === a && r.metric_date >= f && r.metric_date <= to));
    const got = D.adsWindowRowsFromDaily(split.rows, [{ accountId: a, from: f, to }], { includeEmpty: true })[0];
    if (!got || got.rows_digest !== want || got.win_from !== f || got.win_to !== to) { all = false; break; }
    if (want === D.EMPTY_ADS_ROWS_DIGEST) empties += 1;
    checked += 1;
  }
  ok(`D1 folding per-day partials == the JS twin adsRowsDigest over the same window (${checked} random windows, ${empties} empty) -- the digest is ADDITIVE`, all && checked > 300 && empties > 0);
  const full = D.adsWindowRowsFromDaily(split.rows, [{ accountId: "A1", from: scanFrom, to: scanTo }], { includeEmpty: true })[0];
  const a1 = rows.filter((r) => r.account_id === "A1");
  ok("D1b the whole-window digest matches too; its count is the row count; max_ua is the max canonical updated_at", full.rows_digest === D.adsRowsDigest(a1) && full.n === String(a1.length) && full.max_ua === a1.map((r) => D.canonicalInstant(r.updated_at)).sort().pop());
  const lanes = full.rows_digest.split(":").slice(2).map((x) => BigInt(x));
  ok("D1c the lane sums exceed 2^53 and stay exact (BigInt, never Number)", lanes.every((x) => x > 2n ** 53n));
}

// ---- 2. the empty set, includeEmpty, and the GROUP BY semantics ------------------------------------------------------
{
  const split = D.splitAdsDailyPartials(jsPartials([], "2026-04-01", "2026-09-29"));
  const withEmpty = D.adsWindowRowsFromDaily(split.rows, [{ accountId: "Z", from: "2026-04-01", to: "2026-09-28" }], { includeEmpty: true });
  const groupBy = D.adsWindowRowsFromDaily(split.rows, [{ accountId: "Z", from: "2026-04-01", to: "2026-09-28" }], { includeEmpty: false });
  ok("D2a an account with NO row: includeEmpty -> ONE row 'adr1:0:0:0' (n '0', max_ua null) -- the JS twin's value, NOT the old LEFT JOIN's phantom", withEmpty.length === 1 && withEmpty[0].rows_digest === D.EMPTY_ADS_ROWS_DIGEST && withEmpty[0].rows_digest === D.adsRowsDigest([]) && withEmpty[0].n === "0" && withEmpty[0].max_ua === null);
  ok("D2b without includeEmpty (the portfolio's GROUP BY) the account has no row", groupBy.length === 0);
  const r = [mkRow("B", "2026-06-30", 1), mkRow("B", "2026-07-01", 2)];
  const sp = D.splitAdsDailyPartials(jsPartials(r, "2026-01-01", "2026-12-31"));
  ok("D2c window bounds are INCLUSIVE on both days", D.adsWindowRowsFromDaily(sp.rows, [{ accountId: "B", from: "2026-06-30", to: "2026-06-30" }])[0].n === "1" && D.adsWindowRowsFromDaily(sp.rows, [{ accountId: "B", from: "2026-07-01", to: "2026-07-01" }])[0].n === "1" && D.adsWindowRowsFromDaily(sp.rows, [{ accountId: "B", from: "2026-06-30", to: "2026-07-01" }])[0].n === "2");
}

// ---- 3. fail closed on malformed input -------------------------------------------------------------------------------
{
  const good = jsPartials([mkRow("C", "2026-05-05", 1)], "2026-04-01", "2026-09-29");
  const throws = (f) => { try { f(); return false; } catch { return true; } };
  ok("D3a a malformed partial of a REQUESTED account (non-integer count / sum, non-date day) THROWS -- never a plausible digest",
    [{ n: "1.5" }, { s1: "-3" }, { s2: "x" }, { metric_date: "2026-5-5" }].every((bad) => throws(() => D.adsWindowRowsFromDaily([{ ...good[0], ...bad }], [{ accountId: "C", from: "2026-04-01", to: "2026-09-29" }]))));
  const okRow = { ...good[0] };
  const isolated = D.adsWindowRowsFromDaily([okRow, { ...good[0], account_id: "X", n: "1.5" }, { ...good[0], account_id: "" }], [{ accountId: "C", from: "2026-04-01", to: "2026-09-29" }], { includeEmpty: true });
  ok("D3a' ISOLATION: a malformed partial of an account no window asks for (or a blank account) never blocks -- the requested account's digest is exact",
    isolated.length === 1 && isolated[0].rows_digest === D.adsWindowRowsFromDaily([okRow], [{ accountId: "C", from: "2026-04-01", to: "2026-09-29" }])[0].rows_digest);
  ok("D3b a malformed window THROWS", throws(() => D.adsWindowRowsFromDaily(good.slice(0, 1), [{ accountId: "C", from: "April", to: "2026-09-29" }])));
  const noSentinel = good.filter((r) => r.account_id != null);
  const twoSentinels = [...good, good[good.length - 1]];
  const rangeDiff = [{ ...good[0], range_to: "2026-09-30" }, good[1]];
  const blank = good.map((r) => ({ ...r, range_from: "" }));
  const inverted = good.map((r) => ({ ...r, range_from: "2026-10-01" }));
  ok("D3c splitAdsDailyPartials -> null (missing evidence) for: no sentinel, two sentinels, a row with another range, a blank range, an inverted range, a non-array",
    [noSentinel, twoSentinels, rangeDiff, blank, inverted, null, "x"].every((x) => D.splitAdsDailyPartials(x) === null));
  const sp = D.splitAdsDailyPartials(good);
  ok("D3d a well-formed result splits into the range + the real partials (the sentinel removed)", !!sp && J(sp.range) === J({ from: "2026-04-01", to: "2026-09-29" }) && sp.rows.length === 1 && sp.rows[0].account_id === "C");
}

// ---- 4. the union window and the shared statement's region independence ---------------------------------------------
{
  const COUNTRIES = ["IN", "GB", "DE", "FR", "IT", "ES", "NL", "SE", "PL", "BE", "IE", "AU", "US", "CA", "MX", "BR", "AE", "SA", "JP", "SG", "TR", "EG"];
  const dir = new Map(COUNTRIES.map((c, i) => ["acct-" + i, { country: c }]));
  let covered = true; let checked = 0;
  // every hour across a month end + a year end: every country's build window lies inside the union
  for (const base of [Date.UTC(2026, 8, 30, 0, 0), Date.UTC(2026, 11, 31, 0, 0), Date.UTC(2027, 1, 28, 0, 0)]) {
    for (let h = -12; h <= 36; h += 1) {
      const now = base + h * 3600000;
      const u = A.adsDailyUnionWindow({ now, directory: dir });
      for (const c of COUNTRIES) { if (!A.adsWindowCovered(D.brandViewAdsWindow(marketplaceToday(c, new Date(now))), u)) covered = false; checked += 1; }
    }
  }
  ok(`D4a every marketplace's build window lies inside the union at every hour around month / year ends (${checked} checks)`, covered);
  ok("D4b the union ALWAYS contains the anchor (IN) window, even with an empty directory", A.adsWindowCovered(D.brandViewAdsWindow(marketplaceToday("IN", new Date(Date.UTC(2026, 8, 30, 20)))), A.adsDailyUnionWindow({ now: Date.UTC(2026, 8, 30, 20), directory: new Map() })));
  const ctx = (region, ids) => ({ epoch: "2026-09-27", now: Date.UTC(2026, 8, 28, 16, 0), directory: dir, region, accountIds: ids, organizationFingerprint: "org", connectionId: "primary" });
  const p = (c) => J(A.ADS_DAILY_STATEMENT.params(c));
  ok("D4c the shared statement's params are IDENTICAL for any region / account subset at the same clock (-> one sweep-cache key)", p(ctx("india", ["acct-0"])) === p(ctx("us-ca", ["acct-12", "acct-13"])) && p(ctx("europe-au", [])) === p(ctx("india", ["acct-0"])));
  ok("D4d the portfolio reads the unscoped shared statement; Brand View reads the ACCOUNT-SCOPED twin whose sweep-mode sharedVariant IS that same frozen object",
    PF_ROUTE.evidence.sql.includes(A.ADS_DAILY_STATEMENT) && A.ADS_DAILY_STATEMENT.shared === true && Object.isFrozen(A.ADS_DAILY_STATEMENT)
    && BV_ROUTE.evidence.sql.includes(A.ADS_DAILY_SCOPED_STATEMENT) && A.ADS_DAILY_SCOPED_STATEMENT.sharedVariant === A.ADS_DAILY_STATEMENT && A.ADS_DAILY_SCOPED_STATEMENT.shared !== true
    && A.ADS_DAILY_SCOPED_STATEMENT.text === D.ADS_DAILY_ACCOUNT_PARTIALS_SQL && Object.isFrozen(A.ADS_DAILY_SCOPED_STATEMENT));
  const sp = (c) => A.ADS_DAILY_SCOPED_STATEMENT.params(c);
  ok("D4d' the scoped params carry the evidence accounts ($4, region-dependent) and share the union ($1..$3) with the shared variant",
    J(sp(ctx("india", ["acct-0"]))[3]) === J(["acct-0"]) && J(sp(ctx("us-ca", ["acct-12", "acct-13"]))[3]) === J(["acct-12", "acct-13"]) && J(sp(ctx("india", ["acct-0"])).slice(0, 3)) === p(ctx("us-ca", []))
    && J(A.adsDailyUnionWindow({ now: Date.UTC(2026, 8, 30, 21), directory: Object.fromEntries(dir) })) === J(A.adsDailyUnionWindow({ now: Date.UTC(2026, 8, 30, 21), directory: dir })));
  ok("D4e the clock rule accepts a function / a Date / epoch ms identically and fails closed on junk", p({ now: () => Date.UTC(2026, 8, 28, 16), directory: dir }) === p({ now: new Date(Date.UTC(2026, 8, 28, 16)), directory: dir }) && p({ now: Date.UTC(2026, 8, 28, 16), directory: dir }) === p({ now: new Date(Date.UTC(2026, 8, 28, 16)), directory: dir }) && (() => { try { A.adsDailyUnionWindow({ now: "yesterday" }); return false; } catch { return true; } })());
  ok("D4f the ONLY cache-reusable statement anywhere is the region-independent Ads partials (the portfolio's statement / Brand View's sweep variant)",
    PF_ROUTE.evidence.sql.filter((q) => q.shared === true).length === 1 && BV_ROUTE.evidence.sql.filter((q) => q.shared === true).length === 0
    && BV_ROUTE.evidence.sql.filter((q) => q.sharedVariant).length === 1 && PF_ROUTE.evidence.sql.filter((q) => q.sharedVariant).length === 0);
}

// ---- 5. sweepMemoQuery ------------------------------------------------------------------------------------------------
{
  const calls = [];
  const base = async (text, values) => { calls.push(text + "|" + J(values)); if (text === "FAIL") throw new Error("boom"); if (text === "NOTARR") return { rows: [] }; return [{ a: 1, text }]; };
  const cache = new Map();
  const q = sweepMemoQuery(base, cache);
  const S1 = { shared: true }; const PLAIN = { shared: false };
  const r1 = await q("select 1", [1], S1); const r2 = await q("select 1", [1], S1); const r3 = await q("select 1", [2], S1);
  ok("D5a a shared statement runs ONCE per (text, values) per cache; other values run again", calls.filter((c) => c === 'select 1|[1]').length === 1 && calls.filter((c) => c === 'select 1|[2]').length === 1 && r1 === r2 && r3 !== r1);
  ok("D5b the shared rows are FROZEN (a mutating compose throws -> that evaluation defers)", Object.isFrozen(r1) && Object.isFrozen(r1[0]) && (() => { try { "use strict"; r1[0].a = 2; return false; } catch { return true; } })());
  await q("select 2", [], PLAIN); await q("select 2", [], PLAIN); await q("select 2", []);
  ok("D5c a non-shared (or unflagged) statement is NEVER cached", calls.filter((c) => c === "select 2|[]").length === 3);
  let threw = 0; try { await q("FAIL", [], S1); } catch { threw += 1; } try { await q("FAIL", [], S1); } catch (e) { threw += /earlier in this pass/.test(String(e && e.message)) ? 1 : 0; }
  ok("D5d a FAILED shared read fails FAST for the rest of the pass (ONE underlying read; later evaluations re-throw at once)", threw === 2 && calls.filter((c) => c === "FAIL|[]").length === 1);
  let retried = 0; try { await sweepMemoQuery(base, new Map())("FAIL", [], S1); } catch { retried = calls.filter((c) => c === "FAIL|[]").length; }
  ok("D5d' ... and the NEXT pass (a new cache) retries it", retried === 2);
  const na1 = await q("NOTARR", [], S1); await q("NOTARR", [], S1);
  ok("D5e a non-array result is passed through (evaluateRouteEvidence fails closed on it) and never cached", !Array.isArray(na1) && calls.filter((c) => c === "NOTARR|[]").length === 2);
  ok("D5f a truthy NON-boolean shared flag does not enable reuse", (await (async () => { const c2 = []; const q2 = sweepMemoQuery(async (t) => { c2.push(t); return []; }, new Map()); await q2("x", [], { shared: "true" }); await q2("x", [], { shared: "true" }); return c2.length; })()) === 2);
  ok("D5g no cache -> the query itself (byte-identical path)", sweepMemoQuery(base, null) === base);
  // End to end through evaluateRouteEvidence: two region evaluations of the SAME route share ONE Ads partials read.
  const dir = new Map([["IN1", { country: "IN", name: "a" }], ["US1", { country: "US", name: "b" }]]);
  const now = Date.UTC(2026, 8, 28, 16, 0);
  const reads = [];
  const kindOf = (text) => (text === A.ADS_DAILY_STATEMENT.text ? "unscoped" : text === A.ADS_DAILY_SCOPED_STATEMENT.text ? "scoped" : "other");
  const fake = async (text, values) => { reads.push(kindOf(text)); return kindOf(text) !== "other" ? jsPartials([], values[1], values[2]) : []; };
  const evalAll = async (sweepMode) => {
    const sweep = new Map(); const errs = [];
    for (const route of ["brand-view", "brand-view-portfolio"]) for (const region of ["india", "us-ca"]) {
      const c = buildEvidenceContext({ epoch: "2026-09-27", now, directory: dir, region, organizationFingerprint: "org" });
      try { await evaluateRouteEvidence(route, sweepMode ? sweepMemoQuery(fake, sweep) : fake, c, sweepMode ? { sweep: true } : undefined); } catch (e) { errs.push(route + "/" + region + ":" + e.message); }
    }
    return errs;
  };
  const errsSweep = await evalAll(true);
  const sweepReads = reads.splice(0);
  const errsPlain = await evalAll(false);
  const plainReads = reads.splice(0);
  ok("D5h SWEEP mode: 4 route x region evaluations (Brand View + portfolio, 2 regions) issue ONE unscoped Ads partials read and no scoped one; every other statement runs per evaluation; no evaluation throws",
    errsSweep.length === 0 && sweepReads.filter((x) => x === "unscoped").length === 1 && sweepReads.filter((x) => x === "scoped").length === 0 && sweepReads.filter((x) => x === "other").length > 4);
  ok("D5h' WITHOUT sweep mode (the CLI / per-job reads): Brand View reads the ACCOUNT-SCOPED twin per evaluation, the portfolio its unscoped statement per evaluation (no reuse); no evaluation throws",
    errsPlain.length === 0 && plainReads.filter((x) => x === "scoped").length === 2 && plainReads.filter((x) => x === "unscoped").length === 2);
}

// ---- 6. the route contract types `shared` -----------------------------------------------------------------------------
{
  const withShared = (v) => ({ ...PF_ROUTE, evidence: { ...PF_ROUTE.evidence, sql: PF_ROUTE.evidence.sql.map((q) => (q.name === "ads_daily" ? { ...q, shared: v } : q)) } });
  ok("D6 a non-boolean `shared` is a contract problem; true / false / absent are valid", workerRouteProblems(withShared("yes")).includes("evidence-sql-shared-invalid:ads_daily") && !workerRouteProblems(withShared(true)).some((p) => /shared/.test(p)) && !workerRouteProblems(withShared(false)).some((p) => /shared/.test(p)) && workerRouteProblems(PF_ROUTE).length === 0);
  const withVariant = (patch) => ({ ...BV_ROUTE, evidence: { ...BV_ROUTE.evidence, sql: BV_ROUTE.evidence.sql.map((q) => (q.name === "ads_daily" ? { ...q, ...patch } : q)) } });
  const bad = (patch) => workerRouteProblems(withVariant(patch)).includes("evidence-sql-shared-variant-invalid:ads_daily");
  ok("D6' `sharedVariant` must be a read-only `shared: true` statement with params and no nested variant, on a statement that is not itself shared; Brand View's is valid",
    workerRouteProblems(BV_ROUTE).length === 0 && bad({ sharedVariant: { ...A.ADS_DAILY_STATEMENT, shared: false } }) && bad({ sharedVariant: { ...A.ADS_DAILY_STATEMENT, text: "delete from x" } })
    && bad({ sharedVariant: { ...A.ADS_DAILY_STATEMENT, params: null } }) && bad({ sharedVariant: { ...A.ADS_DAILY_STATEMENT, sharedVariant: A.ADS_DAILY_STATEMENT } }) && bad({ shared: true }) && bad({ sharedVariant: "x" }));
}

writeSync(1, `ads-daily-digest: ${passed} assertions passed\n`);
