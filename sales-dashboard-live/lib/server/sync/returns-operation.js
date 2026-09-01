// Returns & Refund Leakage -- the DEDICATED bucket operator (dependency-injected; the CLI wires real DataDoe +
// Supabase, tests inject fakes). Fully decoupled from scheduler-v2 / Daily / Brand / FBA: it opens no shared cycle,
// touches no other report_key, creates ZERO OLI/Catalog exports (it ADOPTS the durable OLI + Catalog), and preserves
// last-known-good on every failure (atomic window replace + CAS publish; a failed account never erases its snapshot).
//
// Per <=5-seller batch it spends exactly TWO standard exports (Returns 60d + Settlements 21d/initial) = 4 tokens, so
// US (2 batches) = 8 tokens and Non-US (5 batches) = 20 tokens -- the exact ceiling. A batch already covering asOf is
// SKIPPED with zero tokens (this is the source-refresh marker AND the primary/fallback idempotency: a fallback after a
// successful primary spends nothing). Modes: `dry-run` proves the plan with zero creates/writes; `go-live` executes.

import {
  planReturnsBatches, returnsTokenPlan, returnsWindow, settlementWindow,
  aggregateReturnsForAccount, aggregateSettlementsForAccount,
  RETURNS_SOURCE_COLUMNS, SETTLEMENT_GROUP_BY, SETTLEMENT_AGGREGATIONS,
  RETURNS_BUCKET_TOKEN_CEILING, RETURNS_TOKENS_PER_EXPORT,
} from "./returns-source-refresh.js";
import { RETURNS, SETTLEMENTS, ROW_LIMITS } from "../reports/sources.js";

const S = (v) => (v == null ? "" : String(v));
const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

// A batch is "already covered" (this asOf already fetched today) iff EVERY account in it EITHER already has durable
// SETTLEMENTS through asOf, OR was refreshed today (its durable window was written on the current run date). Two
// facts make this the right marker:
//   * Settlements are DENSE, so a fetched window [from, asOf] usually lands a row on asOf (settlementMax == asOf).
//     Returns are SPARSE (many days have zero returns), so returnsMax lags asOf even after a fresh fetch and can
//     NEVER be a marker.
//   * BUT some accounts' settlements legitimately LAG asOf by a day or two (DataDoe has not itemized asOf yet), so
//     settlementMax never reaches asOf and re-fetching cannot help -- the "refreshed today" fact records that we
//     already ATTEMPTED asOf, so the same-day FALLBACK spends zero tokens (primary/fallback idempotency), while a
//     genuinely NEW day (runDate advances) is not covered and refreshes.
function batchAlreadyCovered(batchIds, coverage, asOf, runDate) {
  return batchIds.every((id) => {
    const c = coverage.get(id) || {};
    if (isDate(c.settlementMax) && c.settlementMax >= asOf) return true;
    // "refreshed today" = EITHER source's durable window was written on the current run date. Using both covers an
    // account that has returns but no settlements at all (DataDoe returns no settlement rows for it), which would
    // otherwise have no marker and re-fetch every run.
    const stamps = [c.settlementRefreshedAt, c.returnsRefreshedAt].filter(Boolean).map((t) => String(t).slice(0, 10));
    const refreshedDay = stamps.length ? stamps.sort().slice(-1)[0] : null;
    return isDate(runDate) && isDate(refreshedDay) && refreshedDay >= runDate;
  });
}

/**
 * Run one bucket's Returns cycle. Dependencies:
 *   listAccounts()              -> [{ accountId, country, currency, marketplaceCountryCode, sellerOrVendorId,
 *                                     connectionId, organizationFingerprint, name }]
 *   bucketForCountry(country)   -> 'us' | 'non-us' | 'unknown'
 *   readCoverage(accountIds)    -> Map(accountId -> { returnsMax, settlementMax, settlementMin })   (durable dates)
 *   getTokenBalance()           -> number | null   (null = unreadable)
 *   tokenGate(balance, need)    -> { outcome: 'proceed'|'skip'|'fail', usable, ... }
 *   fetchExport({ sourceId, columns, ids, from, to, options, label }) -> { rows, exportId, requestHash }
 *   replaceReturns({ accountId, organizationFingerprint, connectionId, from, to, rows }) -> { write }
 *   replaceSettlements({ accountId, organizationFingerprint, connectionId, from, to, rows }) -> { write }
 *   publishAccount({ account, asOf }) -> { published, latestDataDate, outcome }
 *   log(msg)
 */
export async function runReturnsBucketCycle({ bucket, asOf, mode = "dry-run", maxBatches = null, runDate = null, deps }) {
  const {
    listAccounts, bucketForCountry, readCoverage, getTokenBalance, tokenGate,
    fetchExport, replaceReturns, replaceSettlements, publishAccount, log = () => {},
  } = deps || {};
  if (bucket !== "us" && bucket !== "non-us") throw new Error(`runReturnsBucketCycle: invalid bucket ${bucket}`);
  if (!isDate(asOf)) throw new Error(`runReturnsBucketCycle: invalid asOf ${asOf}`);
  const ceiling = RETURNS_BUCKET_TOKEN_CEILING[bucket];
  const today = isDate(runDate) ? runDate : new Date().toISOString().slice(0, 10);

  // 1) discover + filter to THIS bucket only (never mix buckets).
  const all = await listAccounts();
  const accounts = (Array.isArray(all) ? all : []).filter((a) => a && bucketForCountry(a.country) === bucket);
  const byId = new Map(accounts.map((a) => [S(a.accountId).trim(), a]));
  const batches = planReturnsBatches(accounts);

  // 2) coverage marker -> which batches still need a fetch.
  const coverage = (await readCoverage(accounts.map((a) => S(a.accountId).trim()))) || new Map();
  let fetchBatches = batches.filter((b) => !batchAlreadyCovered(b, coverage, asOf, today));
  const skippedCovered = batches.length - fetchBatches.length;
  // Bounded CANARY: cap the number of batches fetched this run (the rest fetch on the next run; already-covered
  // batches are free). Applies to go-live only; a null/<=0 value means "all batches".
  const canaryCap = Number(maxBatches);
  const canaryLimited = Number.isFinite(canaryCap) && canaryCap > 0 && canaryCap < fetchBatches.length;
  if (canaryLimited) fetchBatches = fetchBatches.slice(0, canaryCap);

  // 3) token plan + ceiling.
  const plan = returnsTokenPlan(fetchBatches.length);
  const ret = returnsWindow(asOf);
  const summary = {
    bucket, asOf, mode, ceiling,
    accounts: accounts.length, batches: batches.length, fetchBatches: fetchBatches.length, skippedCovered, canaryLimited,
    plannedCreates: plan.creates, plannedTokens: plan.tokens,
    returnsWindow: ret, batchPlan: batches.map((b) => ({ ids: b, covered: batchAlreadyCovered(b, coverage, asOf, today) })),
    creates: 0, tokens: 0, durableWrites: 0, published: 0, publishFailed: 0, outcome: "PENDING", errors: [],
  };
  if (plan.tokens > ceiling) {
    summary.outcome = "TOKEN_CEILING_EXCEEDED";
    log(`STOP ${bucket}: planned ${plan.tokens} tokens > ceiling ${ceiling}`);
    return summary;
  }

  // 4) dry-run: prove the plan, ZERO creates / writes.
  if (mode !== "go-live") {
    summary.outcome = plan.tokens === 0 ? "DRY_RUN_ALREADY_COVERED" : "DRY_RUN";
    log(`DRY-RUN ${bucket} asOf ${asOf}: ${accounts.length} accts, ${batches.length} batches, ${fetchBatches.length} to fetch, ${plan.tokens} tokens (ceiling ${ceiling})`);
    return summary;
  }

  // 5) go-live token gate (only when there is something to fetch). tokenGate is tokenGateDecision(balanceObj, need)
  // -> { decision: 'fail'|'skip'|'proceed', usable }. FAIL closed on an unreadable balance; a readable-but-short
  // balance is a TYPED SAFE SKIP (LKG unchanged).
  if (plan.tokens > 0 && typeof getTokenBalance === "function" && typeof tokenGate === "function") {
    const balance = await getTokenBalance();
    const gate = tokenGate(balance, plan.tokens);
    summary.tokenBalance = gate.usable ?? null;
    if (gate.decision === "fail") { summary.outcome = "TOKEN_BALANCE_UNREADABLE"; log(`STOP ${bucket}: token balance unreadable`); return summary; }
    if (gate.decision === "skip") { summary.outcome = "SKIPPED_INSUFFICIENT_TOKENS"; log(`SKIP ${bucket}: usable ${gate.usable} < needed ${plan.tokens} (LKG preserved)`); return summary; }
  }

  // 6) fetch + atomic durable replace per fetch-batch (each failure is isolated: LKG preserved for that batch).
  for (const batchIds of fetchBatches) {
    const batchAccts = batchIds.map((id) => byId.get(id)).filter(Boolean);
    if (!batchAccts.length) continue;
    const org = batchAccts[0].organizationFingerprint;
    const conn = batchAccts[0].connectionId || "primary";
    const sellerIds = batchAccts.map((a) => S(a.sellerOrVendorId ?? a.accountId).trim());
    // Settlement window: the WIDEST (earliest-from) any account in the batch needs (initial covers all). An account
    // whose durable history already reaches the daily start needs only the 21-day window; a fresh account needs the
    // initial backfill from the 2026-07-01 floor. The min of the per-account froms is the batch window.
    let settFrom = null;
    for (const a of batchAccts) {
      const w = settlementWindow(asOf, (coverage.get(S(a.accountId).trim()) || {}).settlementMin || null);
      if (settFrom === null || w.from < settFrom) settFrom = w.from;
    }
    if (settFrom === null) settFrom = settlementWindow(asOf).from;
    try {
      const retExport = await fetchExport({
        sourceId: RETURNS.id, columns: RETURNS_SOURCE_COLUMNS, ids: sellerIds, from: ret.from, to: asOf,
        options: { orderByColumn: "date", orderByDirection: "DESC" }, limit: ROW_LIMITS.rawGrain, label: "Returns",
      });
      summary.creates += 1; summary.tokens += RETURNS_TOKENS_PER_EXPORT;
      const settExport = await fetchExport({
        sourceId: SETTLEMENTS.id, columns: SETTLEMENT_GROUP_BY, ids: sellerIds, from: settFrom, to: asOf,
        options: { groupBy: SETTLEMENT_GROUP_BY, aggregations: SETTLEMENT_AGGREGATIONS, orderByColumn: "date", orderByDirection: "ASC" },
        limit: ROW_LIMITS.aggregated, label: "Settlements",
      });
      summary.creates += 1; summary.tokens += RETURNS_TOKENS_PER_EXPORT;

      for (const a of batchAccts) {
        const id = S(a.accountId).trim();
        const seller = S(a.sellerOrVendorId ?? a.accountId).trim();
        const cc = S(a.marketplaceCountryCode ?? a.country ?? "");
        const retRows = aggregateReturnsForAccount({ rows: retExport.rows, accountId: id, sellerOrVendorId: seller, marketplaceCountryCode: cc, from: ret.from, to: asOf, sourceRequestHash: retExport.requestHash, refreshedAt: retExport.refreshedAt || null });
        const settRows = aggregateSettlementsForAccount({ rows: settExport.rows, accountId: id, sellerOrVendorId: seller, marketplaceCountryCode: cc, from: settFrom, to: asOf, sourceRequestHash: settExport.requestHash, refreshedAt: settExport.refreshedAt || null });
        const rw = await replaceReturns({ accountId: id, organizationFingerprint: org, connectionId: conn, from: ret.from, to: asOf, rows: retRows });
        const sw = await replaceSettlements({ accountId: id, organizationFingerprint: org, connectionId: conn, from: settFrom, to: asOf, rows: settRows });
        if (rw && rw.write === "ok") summary.durableWrites += 1;
        if (sw && sw.write === "ok") summary.durableWrites += 1;
        if ((rw && rw.write !== "ok") || (sw && sw.write !== "ok")) summary.errors.push({ accountId: id, returns: rw?.error, settlements: sw?.error });
      }
    } catch (e) {
      summary.errors.push({ batch: batchIds, error: S(e && e.message) }); // LKG preserved for this batch
      log(`batch ${batchIds.join(",")} failed: ${S(e && e.message)} (LKG preserved)`);
    }
  }

  // 7) publish every bucket account from durable evidence (ZERO tokens; CAS keeps LKG on a not-ready/older derive).
  for (const a of accounts) {
    try {
      const res = await publishAccount({ account: a, asOf });
      if (res && res.published) summary.published += 1; else summary.publishFailed += 1;
    } catch (e) { summary.publishFailed += 1; summary.errors.push({ accountId: S(a.accountId), publish: S(e && e.message) }); }
  }

  summary.outcome = summary.tokens === 0 ? "COMPLETED_ALREADY_COVERED" : "COMPLETED";
  log(`DONE ${bucket} asOf ${asOf}: creates ${summary.creates}, tokens ${summary.tokens}, durableWrites ${summary.durableWrites}, published ${summary.published}/${accounts.length}`);
  return summary;
}
