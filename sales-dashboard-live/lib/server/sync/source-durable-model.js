// Scheduler v2 -- DURABLE BACKFILL + INCREMENTAL SOURCE MODEL (pure, ZERO I/O).
//
// The policy layer over the durable source tables (20260820_source_durable_model.sql -- PREPARED,
// UNAPPLIED): which windows the Order Line Items history must cover, which calendar slices are STILL
// MISSING versus proven coverage (completed historical coverage is NEVER exported again), how a stable
// <=5-account batch exports a slice for exactly the members missing it (a newly discovered account
// backfills SOLO; the steady-state rolling refresh stays ONE batch export), how canonical fragment rows map
// onto durable history rows (idempotent grain so late Amazon corrections replace matching rows), and the
// once-daily catalog / FBA-snapshot refresh decisions (a failed refresh preserves the latest VALIDATED
// snapshot -- enforced by the recordSourceSnapshot wrapper, decided here).
//
// Everything here is deterministic and imports only dependency-free leaves. Request identities are
// UNCHANGED: slices come from the SAME canonicalOliSlices the five OLI reports already share, so a durable
// backfill export for a slice carries the exact canonical request_hash those reports reuse.

import { addDaysStr, monthStartStr, canonicalOliSlices } from "../date-windows.js";
import { canonicalCurrency } from "../currency.js";
import { sourceRegistryEntry } from "./source-registry.js";
import { classifyOliDimensionalRow, OliOrderRuleError } from "./oli-order-rules.js";

export const OLI_SOURCE_KEY = "order-line-items";
export const CATALOG_SOURCE_KEY = "product-catalog";
export const FBA_INVENTORY_SOURCE_KEY = "fba-inventory-health";
export const ORGANIZATION_SCOPE_KEY = "__organization";

// The MAXIMUM trailing DataDoe settlement lag the publish may honestly clamp back over. A recent unsettled tail
// on the newest one or two days is normal (DataDoe restates the last days), so the publish clamps back to the
// latest COMMON gapless date. But a clamp of MORE than this many days behind the requested date is NOT a normal
// settlement tail -- it is stale/stuck evidence, and it FAILS CLOSED (never a silently very-old publish). This is
// the ONE tolerance; interior/leading historical holes always fail closed regardless of the lag.
export const MAX_PUBLISH_TAIL_LAG_DAYS = 2;

// Whole-day difference b - a for two YYYY-MM-DD strings (deterministic; UTC midnight anchored). Never negative
// here because the caller only passes eff <= refreshAsOf.
function inclusiveDayLag(a, b) {
  return Math.round((Date.parse(b + "T00:00:00.000Z") - Date.parse(a + "T00:00:00.000Z")) / 86400000);
}

const isDateStr = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

// APPLICATION safety cap on a SINGLE OLI export's date range. This is NOT a documented DataDoe date-range limit
// -- it is the largest OLI window we have EMPIRICALLY proven to succeed against the live API (441 inclusive days,
// 2026-08-22). A larger single-export range is simply UNVALIDATED; we cap here to FAIL SAFE and only raise the
// cap after an empirical probe proves a larger range works. The brand-sales:order-lines contract window
// (monthStart(asOf)-420 .. asOf) can reach ~450 days at month end and the initial backfill is longer still, so a
// complete missing window that exceeds this cap is SPLIT into contiguous <=cap chunks (each its own export;
// their coverage merges back to one window) -- no single export ever exceeds the proven-safe range.
export const MAX_OLI_EXPORT_WINDOW_DAYS = 441;

// A live five-seller OLI export over the full 441-day cap returned exactly the 50,000-row response limit and
// was rejected as TRUNCATED. Keep 441 as the proven outer request boundary, but split only multi-seller chunks
// to at most 221 inclusive days. Applying this AFTER the outer split preserves the existing short remainder
// identity (for example the 157-day 2026 remainder), so successful exact-cache evidence remains reusable while
// the truncated 441-day identity is never retried.
export const MAX_MULTI_SELLER_OLI_EXPORT_WINDOW_DAYS = 221;

// Split an inclusive [from, to] window into contiguous chunks of at most `maxDays` inclusive days each (the
// last chunk holds the remainder). from/to must be valid YYYY-MM-DD with from <= to.
export function splitWindowToMaxSpan({ from, to }, maxDays = MAX_OLI_EXPORT_WINDOW_DAYS) {
  if (!isDateStr(from) || !isDateStr(to) || from > to) {
    throw new Error("splitWindowToMaxSpan requires a valid from <= to window (fail closed).");
  }
  if (!Number.isInteger(maxDays) || maxDays < 1) throw new Error("splitWindowToMaxSpan requires maxDays >= 1 (fail closed).");
  const chunks = [];
  let start = from;
  for (;;) {
    const end = addDaysStr(start, maxDays - 1); // inclusive => this chunk spans <= maxDays days
    if (end >= to) { chunks.push({ from: start, to }); break; }
    chunks.push({ from: start, to: end });
    start = addDaysStr(end, 1);
  }
  return chunks;
}

/**
 * The INITIAL OLI backfill window as of `asOf`: [fixed-start, asOf]. The registry pins a GENUINELY FIXED
 * calendar start (2025-01-01) -- a SUPERSET of the longest period any Daily Reporting / Brand View (brand-sales)
 * contract requires (brand-sales monthStart(asOf)-420; Daily's 5-month window is a strict subset), cross-checked
 * against the executable contracts by the registry test. Because the start is fixed (not "N days from the month
 * start"), it does NOT drift forward as the month rolls over -- August, September and every later month keep the
 * exact same 2025-01-01 start. (The legacy window-days branch is retained for any non-OLI caller.)
 */
export function oliBackfillWindow(asOf) {
  if (!isDateStr(asOf)) throw new Error("oliBackfillWindow requires a YYYY-MM-DD asOf (fail closed).");
  const policy = sourceRegistryEntry(OLI_SOURCE_KEY).initialBackfill;
  // fixed-start: the authorized durable OLI backfill runs one COMPLETE window [start, asOf] per <=5-seller batch
  // (no 7-day pre-slicing). window-days (the legacy rolling policy) is kept for any non-OLI caller.
  if (policy.kind === "fixed-start") {
    if (!isDateStr(policy.start)) throw new Error("oliBackfillWindow: fixed-start policy requires a YYYY-MM-DD start (fail closed).");
    // asOf before the fixed start => an EMPTY authorized window (from > to): the planner site skips OLI (nothing
    // to backfill from a not-yet-reached start). Never throws -- an out-of-range asOf is not a config error.
    return { from: policy.start, to: asOf };
  }
  if (policy.kind === "window-days") return { from: addDaysStr(monthStartStr(asOf), -policy.days), to: asOf };
  throw new Error("oliBackfillWindow: unsupported OLI backfill policy kind (fail closed).");
}

/**
 * The GOING-FORWARD incremental refresh window: a rolling window ending at `asOf` whose length comes from
 * the registry policy (7 days). Re-exporting inside this window is intentional -- its slices UPSERT
 * idempotently so late Amazon corrections replace matching rows.
 */
export function oliRollingRefreshWindow(asOf) {
  if (!isDateStr(asOf)) throw new Error("oliRollingRefreshWindow requires a YYYY-MM-DD asOf (fail closed).");
  const policy = sourceRegistryEntry(OLI_SOURCE_KEY).incrementalRefresh;
  if (policy.kind !== "rolling-window-days") throw new Error("oliRollingRefreshWindow: the registry OLI refresh policy is not rolling-window-days (fail closed).");
  return { from: addDaysStr(asOf, -(policy.days - 1)), to: asOf };
}

// Merge proven coverage windows (any order, overlaps allowed) into a sorted, disjoint list. A malformed
// window fails the WHOLE merge (fail closed) -- partial coverage evidence must never read as proven.
export function mergeCoverageWindows(windows) {
  const list = [];
  for (const w of windows || []) {
    if (!w || !isDateStr(w.from) || !isDateStr(w.to) || w.from > w.to) {
      throw new Error("mergeCoverageWindows: malformed coverage window; refusing ALL coverage evidence (fail closed).");
    }
    list.push({ from: w.from, to: w.to });
  }
  list.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  const merged = [];
  for (const w of list) {
    const last = merged[merged.length - 1];
    if (last && w.from <= addDaysStr(last.to, 1)) {
      if (w.to > last.to) last.to = w.to;
    } else {
      merged.push({ ...w });
    }
  }
  return merged;
}

// True iff the merged proven windows fully contain [from, to] (no interior gap).
export function windowsProve(windows, from, to) {
  const merged = mergeCoverageWindows(windows);
  return merged.some((w) => w.from <= from && w.to >= to);
}

/**
 * The canonical OLI slices of [from, to] that are NOT fully proven by the account's coverage windows.
 * Proven slices are returned under `covered` (never re-exported); missing ones under `missing` (the only
 * export candidates). Slicing is the SAME canonicalOliSlices the report contracts use, so a missing slice's
 * export carries the exact canonical request identity the reports reuse.
 */
export function missingOliSlices({ coverageWindows, from, to }) {
  if (!isDateStr(from) || !isDateStr(to) || from > to) {
    throw new Error("missingOliSlices requires a valid from <= to window (fail closed).");
  }
  const merged = mergeCoverageWindows(coverageWindows);
  const missing = [];
  const covered = [];
  for (const slice of canonicalOliSlices(from, to)) {
    if (merged.some((w) => w.from <= slice.from && w.to >= slice.to)) covered.push(slice);
    else missing.push(slice);
  }
  return { missing, covered };
}

/**
 * The CONTIGUOUS missing windows of [from, to] NOT proven by `coverageWindows` (the complement of the merged
 * coverage inside [from, to]). Empty coverage => the single window [from, to]; full coverage => []. A gap
 * boundary is inclusive on both ends. Malformed coverage fails the WHOLE computation closed (via mergeCoverage
 * Windows) -- partial evidence never reads as proven.
 */
export function missingCoverageWindows(coverageWindows, from, to) {
  if (!isDateStr(from) || !isDateStr(to) || from > to) {
    throw new Error("missingCoverageWindows requires a valid from <= to window (fail closed).");
  }
  const merged = mergeCoverageWindows(coverageWindows);
  const gaps = [];
  let cursor = from; // the next uncovered date
  for (const w of merged) {
    const wf = w.from < from ? from : w.from;
    const wt = w.to > to ? to : w.to;
    if (wt < from || wf > to) continue; // window entirely outside [from, to]
    if (wf > cursor) gaps.push({ from: cursor, to: addDaysStr(wf, -1) });
    const next = addDaysStr(wt, 1);
    if (next > cursor) cursor = next;
  }
  if (cursor <= to) gaps.push({ from: cursor, to });
  return gaps;
}

/**
 * Resolve the EFFECTIVE publish as-of date across a publication scope, separating the date the scheduler tried
 * to reach (`refreshAsOf`) from the latest date every account can actually PROVE with gapless durable OLI
 * coverage. For each account over [from, refreshAsOf]:
 *   - no gaps                          -> that account proves through refreshAsOf (coveredTo = refreshAsOf);
 *   - a SINGLE TRAILING unsettled gap  -> [G..refreshAsOf] with nothing proven after it: the account proves
 *     through the day before G (coveredTo = G-1); the recent unsettled tail is clamped, NOT fabricated;
 *   - a LEADING gap (`from` itself uncovered) or an INTERIOR gap (coverage RESUMES after a hole) -> fail closed:
 *     the account is a typed blocker and the whole scope's effective as-of is null (never clamp AROUND an
 *     interior historical hole and silently drop the proven data after it).
 * effectivePublishAsOf = min(coveredTo) across accounts and never exceeds refreshAsOf. When any account is
 * blocked (interior/leading gap, malformed coverage, or an empty scope) effectiveAsOf is null and `blockers`
 * enumerates the sanitized reasons; the caller then fails closed (a null effective date leaves the readiness
 * window pinned at refreshAsOf, so windowsProve rejects the blocked account with coverage-incomplete).
 *
 * BOUNDED trailing tolerance: the clamp may fall at most `maxTailLagDays` (default MAX_PUBLISH_TAIL_LAG_DAYS = 2)
 * days behind refreshAsOf. A clamp of MORE than that is NOT a normal DataDoe settlement tail -- it is stale/stuck
 * evidence -> effectiveAsOf is null with a `tail-lag-exceeded` blocker (fail closed; never a silently very-old
 * publish). `status` is "exact" (lag 0), "UPSTREAM_TAIL_LAG" (0 < lag <= cap), or "TAIL_LAG_EXCEEDED"/blocked.
 * Returns { effectiveAsOf, perAccount: {accountId: coveredTo|null}, blockers: [{accountId, reason}], tailLagDays,
 * status }.
 */
export function resolveEffectivePublishAsOf({ coverageByAccountId = {}, accountIds = [], from, refreshAsOf, maxTailLagDays = MAX_PUBLISH_TAIL_LAG_DAYS } = {}) {
  if (!isDateStr(from) || !isDateStr(refreshAsOf)) {
    throw new Error("resolveEffectivePublishAsOf requires from + refreshAsOf as YYYY-MM-DD dates (fail closed).");
  }
  const cap = Number.isFinite(Number(maxTailLagDays)) && Number(maxTailLagDays) >= 0 ? Number(maxTailLagDays) : MAX_PUBLISH_TAIL_LAG_DAYS;
  // asOf BEFORE the fixed backfill start (from > refreshAsOf) is the SAME degenerate empty window the OLI planner
  // already honours (a not-yet-reached start), NOT a config error: there is nothing to clamp, so the effective
  // date is simply refreshAsOf and the downstream empty-window readiness (backfill-start-not-reached) takes over.
  if (from > refreshAsOf) return { effectiveAsOf: refreshAsOf, perAccount: {}, blockers: [], tailLagDays: 0, status: "exact" };
  const ids = [...new Set((accountIds || []).map((a) => String(a)).filter((s) => s && !s.includes(":")))].sort();
  const perAccount = {};
  const blockers = [];
  if (!ids.length) return { effectiveAsOf: null, perAccount, blockers: [{ accountId: null, reason: "no-accounts" }], tailLagDays: null, status: "blocked" };
  let eff = refreshAsOf;
  for (const id of ids) {
    let gaps;
    try { gaps = missingCoverageWindows(coverageByAccountId[id] || [], from, refreshAsOf); }
    catch (_e) { perAccount[id] = null; blockers.push({ accountId: id, reason: "coverage-malformed" }); continue; }
    if (!gaps.length) { perAccount[id] = refreshAsOf; continue; }
    const first = gaps[0];
    if (first.from === from) { perAccount[id] = null; blockers.push({ accountId: id, reason: "leading-gap" }); continue; }
    // The account proves the contiguous prefix [from .. first.from-1]. It is a pure TRAILING tail only when the
    // one-and-only gap runs to refreshAsOf; anything else means proven data resumes after a hole (interior gap).
    const trailingOnly = gaps.length === 1 && first.to === refreshAsOf;
    if (!trailingOnly) { perAccount[id] = null; blockers.push({ accountId: id, reason: "interior-gap" }); continue; }
    const coveredTo = addDaysStr(first.from, -1);
    perAccount[id] = coveredTo;
    if (coveredTo < eff) eff = coveredTo;
  }
  if (blockers.length) return { effectiveAsOf: null, perAccount, blockers, tailLagDays: null, status: "blocked" };
  // BOUNDED tail: a clamp of more than `cap` days behind refreshAsOf is stale/stuck evidence, not a settlement
  // tail -> fail closed. `addDaysStr(eff, cap) < refreshAsOf` is exactly "lag > cap" (string-safe, no Date math).
  const tailLagDays = inclusiveDayLag(eff, refreshAsOf);
  if (addDaysStr(eff, cap) < refreshAsOf) {
    return { effectiveAsOf: null, perAccount, blockers: [{ accountId: null, reason: "tail-lag-exceeded" }], tailLagDays, status: "TAIL_LAG_EXCEEDED" };
  }
  return { effectiveAsOf: eff, perAccount, blockers: [], tailLagDays, status: tailLagDays === 0 ? "exact" : "UPSTREAM_TAIL_LAG" };
}

/**
 * Plan the COMPLETE-WINDOW export units for one stable <=5-account batch: DataDoe caps sellerOrVendorIds at 5,
 * so a batch is <=5 accounts, and the AUTHORIZED durable OLI backfill fetches the complete missing window per
 * batch -- NO seven-day canonical pre-slicing. Members with the SAME missing-window signature share the exports
 * for their contiguous missing window(s) (a stable member subset over a stable window => a stable request
 * identity). A missing window longer than DataDoe's proven single-export range (MAX_OLI_EXPORT_WINDOW_DAYS) is
 * SPLIT into contiguous <=cap chunks (fail-safe: no export ever exceeds the proven range); a within-cap window
 * stays ONE export:
 *   - initial backfill (all members missing the full window)  => the full window as one-or-more <=cap exports;
 *   - continuation over a persisted window                    => the NEW missing dates (typically the trailing
 *                                                                rolling-refresh window the caller left missing),
 *                                                                or NONE when the window is fully proven;
 *   - a newly discovered account joining the batch            => its own <=cap export(s) for ONLY its missing
 *                                                                window -- completed members are never re-exported.
 * `batchAccounts`: [{ accountId, rawSellerId }] (<=5). `coverageByAccountId`: accountId -> proven windows.
 * Returns [{ slice:{from,to}, accounts:[{accountId,rawSellerId}], sellerOrVendorIds:[sorted] }] -- each `slice`
 * is a COMPLETE window (not a 7-day bin) capped at MAX_OLI_EXPORT_WINDOW_DAYS. Multi-seller chunks are further
 * bounded by MAX_MULTI_SELLER_OLI_EXPORT_WINDOW_DAYS after live row-cap evidence proved 441 days can truncate;
 * single-seller chunks retain the empirically proven 441-day cap and short remainder identities stay stable.
 */
export function planOliSliceExports({ batchAccounts, coverageByAccountId, from, to }) {
  const accounts = Array.isArray(batchAccounts) ? batchAccounts : [];
  if (accounts.length === 0 || accounts.length > 5) {
    throw new Error("planOliSliceExports requires a 1..5 account stable batch (fail closed).");
  }
  for (const a of accounts) {
    if (!a || !String(a.accountId || "").trim() || !String(a.rawSellerId || "").trim()) {
      throw new Error("planOliSliceExports: every batch account requires accountId + rawSellerId (fail closed).");
    }
  }
  const coverage = coverageByAccountId || {};
  // Group members by their EXACT contiguous missing-window signature; each group emits ONE complete-window
  // export per missing window over exactly those members (sorted => a stable request identity).
  const groups = new Map();
  for (const a of accounts) {
    const missing = missingCoverageWindows(coverage[a.accountId] || [], from, to);
    if (!missing.length) continue; // completed coverage is never exported again
    const sig = missing.map((w) => w.from + ":" + w.to).join("|");
    if (!groups.has(sig)) groups.set(sig, { windows: missing, accounts: [] });
    groups.get(sig).accounts.push(a);
  }
  const units = [];
  for (const g of groups.values()) {
    const sorted = [...g.accounts].sort((x, y) => (x.rawSellerId < y.rawSellerId ? -1 : 1));
    const ids = sorted.map((a) => String(a.rawSellerId));
    for (const w of g.windows) {
      // A missing window longer than DataDoe's proven single-export range is SPLIT into contiguous <=cap chunks;
      // a within-range window stays ONE export. The chunks' coverage merges back into the one contiguous window.
      for (const chunk of splitWindowToMaxSpan(w)) {
        const safeChunks = ids.length > 1
          ? splitWindowToMaxSpan(chunk, MAX_MULTI_SELLER_OLI_EXPORT_WINDOW_DAYS)
          : [chunk];
        for (const safeChunk of safeChunks) {
          units.push({ slice: { from: safeChunk.from, to: safeChunk.to }, accounts: sorted, sellerOrVendorIds: ids });
        }
      }
    }
  }
  return units;
}

// Contiguous canonical slices -> minimal coverage windows to record after their exports succeed.
export function coverageWindowsFromSlices(slices) {
  return mergeCoverageWindows((slices || []).map((s) => ({ from: s.from, to: s.to })));
}

/**
 * Map ONE downloaded canonical OLI fragment (the shared batch payload) onto durable history rows at the
 * canonical grain. Row attribution is by seller_or_vendor_id against the AUTHORITATIVE accountsBySellerId
 * map ({ rawSellerId -> { accountId, currency } }); an unknown/blank seller REJECTS the whole payload
 * (fail closed -- mirrors validateBatchSourcePayload). A nonblank row currency must be canonical. When
 * DataDoe leaves it blank, the exact seller/account's canonical discovery currency is authoritative; a
 * missing/malformed fallback still rejects the whole payload. sku/child_asin may be blank (kept as '' grain
 * components). Two fragment rows on the same grain SUM (they are partial aggregates of one grain cell); the
 * durable upsert then REPLACES the whole matching row, so re-exported corrected slices never duplicate.
 */
export function oliHistoryRowsFromFragment({ rows, accountsBySellerId, organizationFingerprint, connectionId, sourceRequestHash }) {
  if (!Array.isArray(rows)) throw new Error("oliHistoryRowsFromFragment requires an array payload (fail closed).");
  if (!organizationFingerprint || !connectionId || !sourceRequestHash) {
    throw new Error("oliHistoryRowsFromFragment requires organizationFingerprint + connectionId + sourceRequestHash (fail closed).");
  }
  const byGrain = new Map();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("oliHistoryRowsFromFragment: malformed fragment row; rejecting the whole payload (fail closed).");
    }
    const values = Object.values(row);
    const nonEmpty = values.some((v) => v != null && String(v).trim() !== "");
    if (!nonEmpty) continue; // an all-blank row carries nothing
    const seller = String(row.seller_or_vendor_id ?? "").trim();
    const account = accountsBySellerId ? accountsBySellerId[seller] : null;
    if (!seller || !account || !String(account.accountId || "").trim()) {
      throw new Error("oliHistoryRowsFromFragment: a row's seller_or_vendor_id is blank/unknown to the batch; rejecting the whole payload (fail closed).");
    }
    const date = String(row.date ?? "").trim();
    if (!isDateStr(date)) {
      throw new Error("oliHistoryRowsFromFragment: a row carries no valid date; rejecting the whole payload (fail closed).");
    }
    const rawCurrency = String(row.item_price_currency ?? "").trim();
    const currency = rawCurrency ? canonicalCurrency(rawCurrency) : canonicalCurrency(account.currency);
    if (!currency) {
      throw new Error("oliHistoryRowsFromFragment: a row carries no canonical currency and its exact account has no canonical fallback currency; rejecting the whole payload (fail closed).");
    }
    const sales = Number(row.total_sales_sum ?? 0);
    const units = Number(row.total_units_sum ?? 0);
    if (!Number.isFinite(sales) || !Number.isFinite(units)) {
      throw new Error("oliHistoryRowsFromFragment: a row carries a non-finite sales/units value; rejecting the whole payload (fail closed).");
    }
    const sku = String(row.sku ?? "");
    const childAsin = String(row.child_asin ?? "");
    const grain = [account.accountId, date, sku, childAsin, currency].join("\u001f");
    const existing = byGrain.get(grain);
    if (existing) {
      existing.salesAmount += sales;
      existing.units += units;
    } else {
      byGrain.set(grain, {
        organizationFingerprint, connectionId,
        accountId: String(account.accountId), sellerOrVendorId: seller,
        saleDate: date, sku, childAsin, currency,
        salesAmount: sales, units,
        sourceRequestHash,
      });
    }
  }
  return [...byGrain.values()];
}

/**
 * DIMENSIONAL variant of oliHistoryRowsFromFragment: maps the canonical OLI fragment -- now carrying
 * amazon_order_status, fulfillment_channel, address_state and address_city -- onto durable DIMENSIONAL history
 * rows (the p_rows shape replace_oli_dimensional_window persists), grouped PER ACCOUNT so one account's invalid
 * evidence never poisons another's write.
 *
 * The authoritative order rules (oli-order-rules.js) are enforced fail-closed. Structural corruption (a non-object
 * row, an unknown seller, a bad date/currency) rejects the WHOLE payload (matching the non-dimensional builder).
 * An account is HELD/BLOCKED (excluded from `byAccount` so its window is never written and its coverage never
 * advanced -> LKG preserved, reported in `blocked` with a redacted itemization summary) when its rows carry:
 *   - a missing amazon_order_status -> OLI_ORDER_STATUS_MISSING (cancellation unclassifiable);
 *   - an ITEMIZED recognized-sale (item_status present) with a genuinely null value -> OLI_ITEMIZED_VALUE_MISSING
 *     (a real source-data defect, precedence over pending);
 *   - otherwise a not-yet-itemized (item_status blank) or pre-sale Pending null-value row -> OLI_D1_PENDING_ITEMIZATION
 *     (an expected, transient Amazon item-level lag: an HONEST wait, never a fabricated value).
 * Cancelled + resolved (value-present, incl. explicit-zero) rows are kept (audit) and carry through to the
 * dimensional table; the RPC folds the NON-cancelled rollup. Same-grain fragment rows SUM (value sums only present
 * values; units always sum). A fully-resolved account (no pending, no defect) persists and its coverage advances,
 * even with zero completed sales (only cancelled / explicit-zero).
 *
 * Returns { byAccount, rollupByAccount, orderAuditByAccount, blocked: [{ accountId, code, detail }] }.
 */
// A redacted, PII-free itemization summary for honest diagnostics (never leaks order ids / customer data): how
// many rows resolved (priced) vs are still PENDING Amazon item-level sync, split by reason, plus the itemized %
// overall and for the latest (D-1) date. `resolved`/`pending` are non-cancelled row counts.
export function oliItemizationDetail(summary) {
  const dates = [...summary.byDate.keys()].sort();
  const latest = dates.length ? dates[dates.length - 1] : null;
  const ld = latest ? summary.byDate.get(latest) : null;
  const pct = (r, d) => (d > 0 ? Math.round((r / d) * 1000) / 10 : null);
  const denom = summary.resolved + summary.pending;
  const latestDenom = ld ? ld.resolved + ld.pending : 0;
  return {
    resolved: summary.resolved,
    pending: summary.pending,
    notItemized: summary.notItemized,       // item_status blank -> Amazon has not yet itemized the order
    presalePending: summary.presale,        // amazon_order_status = Pending (pre-sale, payment unconfirmed)
    cancelled: summary.cancelled,
    zeroPriced: summary.zero,
    defect: summary.defect || 0,            // itemized recognized-sale rows with a genuinely null value
    itemizedPct: pct(summary.resolved, denom),
    latestDate: latest,
    latestResolved: ld ? ld.resolved : 0,
    latestPending: ld ? ld.pending : 0,
    latestItemizedPct: pct(ld ? ld.resolved : 0, latestDenom),
  };
}

export function oliDimensionalRowsFromFragment({ rows, accountsBySellerId, organizationFingerprint, connectionId, sourceRequestHash }) {
  if (!Array.isArray(rows)) throw new Error("oliDimensionalRowsFromFragment requires an array payload (fail closed).");
  if (!organizationFingerprint || !connectionId || !sourceRequestHash) {
    throw new Error("oliDimensionalRowsFromFragment requires organizationFingerprint + connectionId + sourceRequestHash (fail closed).");
  }
  const US = "";
  // First resolve every row's account + canonical grain fields (structural fail-closed like the non-dim builder),
  // grouping raw rows by account so ORDER-rule validation can be isolated per account.
  const rawByAccount = new Map();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("oliDimensionalRowsFromFragment: malformed fragment row; rejecting the whole payload (fail closed).");
    }
    const values = Object.values(row);
    const nonEmpty = values.some((v) => v != null && String(v).trim() !== "");
    if (!nonEmpty) continue;
    const seller = String(row.seller_or_vendor_id ?? "").trim();
    const account = accountsBySellerId ? accountsBySellerId[seller] : null;
    if (!seller || !account || !String(account.accountId || "").trim()) {
      throw new Error("oliDimensionalRowsFromFragment: a row's seller_or_vendor_id is blank/unknown to the batch; rejecting the whole payload (fail closed).");
    }
    const date = String(row.date ?? "").trim();
    if (!isDateStr(date)) {
      throw new Error("oliDimensionalRowsFromFragment: a row carries no valid date; rejecting the whole payload (fail closed).");
    }
    const rawCurrency = String(row.item_price_currency ?? "").trim();
    const currency = rawCurrency ? canonicalCurrency(rawCurrency) : canonicalCurrency(account.currency);
    if (!currency) {
      throw new Error("oliDimensionalRowsFromFragment: a row carries no canonical currency and its exact account has no canonical fallback currency; rejecting the whole payload (fail closed).");
    }
    const accountId = String(account.accountId);
    (rawByAccount.get(accountId) || rawByAccount.set(accountId, []).get(accountId)).push({ row, seller, date, currency });
  }

  const byAccount = new Map();
  const rollupByAccount = new Map();
  const orderAuditByAccount = new Map(); // ORDER-level audit (dimensional grain + amazon_order_id); folded OUT of byAccount
  const blocked = [];
  for (const [accountId, entries] of rawByAccount) {
    let violated = null; // a hard order-rule violation (missing status) -> refuse the account immediately
    // ITEMIZATION summary for honest diagnostics + the pending/defect block decision (see oliItemizationDetail).
    const summary = { resolved: 0, pending: 0, notItemized: 0, presale: 0, cancelled: 0, zero: 0, defect: 0, byDate: new Map() };
    const byGrain = new Map();      // dimensional grain (full evidence, cancelled included) -- NO order_id (byte-identical)
    const rollupByGrain = new Map(); // NON-cancelled rollup at (date, sku, child_asin, currency)
    const orderAuditByGrain = new Map(); // dimensional grain + amazon_order_id (a blank ID stays its own grain)
    for (const { row, seller, date, currency } of entries) {
      let c;
      try {
        c = classifyOliDimensionalRow(row); // throws only on a HARD rule violation (missing status / malformed)
      } catch (e) {
        if (e instanceof OliOrderRuleError && e.code === "OLI_ORDER_STATUS_MISSING") {
          violated = { accountId, code: e.code, detail: { ...e.detail } };
          break; // cancellation cannot be classified -> the account's window is refused; LKG preserved
        }
        throw e; // a malformed (non-finite) row is a hard payload failure
      }
      // Tally the itemization state (per account + per date) for the honest diagnostics and the block decision.
      const ds = summary.byDate.get(date) || { resolved: 0, pending: 0 };
      if (c.isCancelled) summary.cancelled += 1;
      else if (c.pending) { summary.pending += 1; ds.pending += 1; if (c.pendingReason === "pre-sale-pending") summary.presale += 1; else summary.notItemized += 1; }
      else if (c.defect) summary.defect += 1;
      else if (c.valuePresent) { summary.resolved += 1; ds.resolved += 1; if (Number(c.value) === 0) summary.zero += 1; }
      summary.byDate.set(date, ds);
      // A PENDING (not-yet-itemized / pre-sale) or DEFECT (itemized-but-null) row carries a MISSING value: keep it
      // out of the persisted dimensional/audit/rollup grains (never persist a null non-cancelled value) -- it is
      // captured in the summary and the account is blocked below (LKG preserved). Cancelled + resolved rows persist.
      if (c.pending || c.defect) continue;
      const sku = String(row.sku ?? "");
      const childAsin = String(row.child_asin ?? "");
      const grain = [accountId, date, seller, sku, childAsin, currency, c.status, c.fulfillmentChannel, c.addressState, c.addressCity].join(US);
      const existing = byGrain.get(grain);
      if (existing) {
        existing.total_units_sum += c.units;
        if (c.valuePresent) existing.total_sales_sum = (existing.total_sales_sum ?? 0) + c.value;
      } else {
        byGrain.set(grain, {
          seller_or_vendor_id: seller, sale_date: date, sku, child_asin: childAsin, currency,
          amazon_order_status: c.status, fulfillment_channel: c.fulfillmentChannel,
          address_state: c.addressState, address_city: c.addressCity,
          total_sales_sum: c.valuePresent ? c.value : null,
          total_units_sum: c.units,
          source_request_hash: sourceRequestHash,
        });
      }
      // ORDER-AUDIT grain = dimensional grain PLUS the canonical Order ID. A blank ('') Order ID forms its OWN grain
      // (never merged into a neighbour's real ID). A distinct ' ' join separator (absent from all text fields)
      // keeps two distinct orders from ever colliding. The SQL RPC re-aggregates by the same natural identity.
      const orderGrain = [accountId, date, seller, sku, childAsin, currency, c.status, c.fulfillmentChannel, c.addressState, c.addressCity, c.orderId].join(" ");
      const oexisting = orderAuditByGrain.get(orderGrain);
      if (oexisting) {
        oexisting.total_units_sum += c.units;
        if (c.valuePresent) oexisting.total_sales_sum = (oexisting.total_sales_sum ?? 0) + c.value;
      } else {
        orderAuditByGrain.set(orderGrain, {
          seller_or_vendor_id: seller, sale_date: date, sku, child_asin: childAsin, currency,
          amazon_order_status: c.status, fulfillment_channel: c.fulfillmentChannel,
          address_state: c.addressState, address_city: c.addressCity,
          amazon_order_id: c.orderId,
          total_sales_sum: c.valuePresent ? c.value : null,
          total_units_sum: c.units,
          source_request_hash: sourceRequestHash,
        });
      }
      // The NON-cancelled rollup mirrors what the RPC persists into source_oli_daily_history (dashboards read it).
      // A row contributes ONLY when not cancelled AND its value is present and > 0; a cancelled row or a real
      // zero-priced non-cancelled unit contributes ZERO (it still lives in the dimensional table for audit).
      if (c.contributesToRollup) {
        const rgrain = [accountId, date, sku, childAsin, currency].join(US);
        const rexisting = rollupByGrain.get(rgrain);
        if (rexisting) {
          rexisting.salesAmount += c.value;
          rexisting.units += c.units;
        } else {
          rollupByGrain.set(rgrain, {
            organizationFingerprint, connectionId,
            accountId, sellerOrVendorId: seller, saleDate: date, sku, childAsin, currency,
            salesAmount: c.value, units: c.units, sourceRequestHash,
          });
        }
      }
    }
    if (violated) { blocked.push(violated); continue; }
    // A real DEFECT (an itemized recognized-sale with a genuinely null value) takes precedence: block the account
    // and flag it as a source-data problem to investigate. Otherwise, if any row is PENDING (not-yet-itemized /
    // pre-sale), HOLD the account window (honest wait until Amazon finishes item-level sync) with a precise,
    // transient reason + the itemization %. Only a fully-resolved account (no pending, no defect) persists.
    if (summary.defect > 0) { blocked.push({ accountId, code: "OLI_ITEMIZED_VALUE_MISSING", detail: oliItemizationDetail(summary) }); continue; }
    if (summary.pending > 0) { blocked.push({ accountId, code: "OLI_D1_PENDING_ITEMIZATION", detail: oliItemizationDetail(summary) }); continue; }
    byAccount.set(accountId, [...byGrain.values()]);
    rollupByAccount.set(accountId, [...rollupByGrain.values()]);
    orderAuditByAccount.set(accountId, [...orderAuditByGrain.values()]);
  }
  return { byAccount, rollupByAccount, orderAuditByAccount, blocked };
}

/**
 * Once-daily refresh decision for a durable-snapshot source (catalog per ORGANIZATION, FBA inventory per
 * account): refresh iff there is no snapshot yet or its validated_at falls before `today` (UTC date). A
 * refresh FAILURE changes nothing here -- the decision reads only the last VALIDATED snapshot, and the
 * recordSourceSnapshot wrapper refuses non-validated evidence, so latest-good is preserved end to end.
 */
export function snapshotRefreshDecision({ sourceKey, lastValidatedAt, today }) {
  const entry = sourceRegistryEntry(sourceKey);
  if (entry.incrementalRefresh.kind !== "daily-snapshot") {
    throw new Error(`snapshotRefreshDecision: "${sourceKey}" is not a daily-snapshot source (fail closed).`);
  }
  if (!isDateStr(today)) throw new Error("snapshotRefreshDecision requires a YYYY-MM-DD today (fail closed).");
  if (!lastValidatedAt) return { refresh: true, reason: "never-validated" };
  const validatedDate = String(lastValidatedAt).slice(0, 10);
  if (!isDateStr(validatedDate)) return { refresh: true, reason: "invalid-validated-at" };
  return validatedDate < today
    ? { refresh: true, reason: "stale-day" }
    : { refresh: false, reason: "fresh-today" };
}

// The catalog refreshes once per ORGANIZATION per day -- never once per dashboard or per seller. The scope
// key is the organization sentinel by construction.
export function catalogSnapshotScope() {
  const entry = sourceRegistryEntry(CATALOG_SOURCE_KEY);
  if (entry.scope !== "organization" || entry.incrementalRefresh.perOrganization !== true) {
    throw new Error("catalogSnapshotScope: the registry no longer declares the catalog organization-wide/per-organization (fail closed).");
  }
  return ORGANIZATION_SCOPE_KEY;
}
