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
import { sourceRegistryEntry } from "./source-registry.js";

export const OLI_SOURCE_KEY = "order-line-items";
export const CATALOG_SOURCE_KEY = "product-catalog";
export const FBA_INVENTORY_SOURCE_KEY = "fba-inventory-health";
export const ORGANIZATION_SCOPE_KEY = "__organization";

const isDateStr = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

// APPLICATION safety cap on a SINGLE OLI export's date range. This is NOT a documented DataDoe date-range limit
// -- it is the largest OLI window we have EMPIRICALLY proven to succeed against the live API (441 inclusive days,
// 2026-08-22). A larger single-export range is simply UNVALIDATED; we cap here to FAIL SAFE and only raise the
// cap after an empirical probe proves a larger range works. The brand-sales:order-lines contract window
// (monthStart(asOf)-420 .. asOf) can reach ~450 days at month end and the initial backfill is longer still, so a
// complete missing window that exceeds this cap is SPLIT into contiguous <=cap chunks (each its own export;
// their coverage merges back to one window) -- no single export ever exceeds the proven-safe range.
export const MAX_OLI_EXPORT_WINDOW_DAYS = 441;

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
 * is a COMPLETE window (not a 7-day bin) capped at MAX_OLI_EXPORT_WINDOW_DAYS. NO adaptive slicing beyond the
 * cap: a truncated/row-capped export fails closed upstream.
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
        units.push({ slice: { from: chunk.from, to: chunk.to }, accounts: sorted, sellerOrVendorIds: ids });
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
 * map ({ rawSellerId -> { accountId } }); an unknown/blank seller REJECTS the whole payload (fail closed --
 * mirrors validateBatchSourcePayload). currency must be a canonical AAA code; sku/child_asin may be blank
 * (kept as '' grain components). Two fragment rows on the same grain SUM (they are partial aggregates of
 * one grain cell); the durable upsert then REPLACES the whole matching row, so re-exported corrected slices
 * never duplicate.
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
    const currency = String(row.item_price_currency ?? "").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new Error("oliHistoryRowsFromFragment: a row carries no canonical currency; rejecting the whole payload (fail closed).");
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
