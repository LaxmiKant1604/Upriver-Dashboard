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

/**
 * The INITIAL OLI backfill window as of `asOf`: the longest period any Daily Reporting / Brand View
 * (brand-sales) contract requires -- 420 days back from the month start (the Brand Sales span; Daily's
 * 5-month window is a strict subset). The day count is READ from the registry's reviewed policy and
 * cross-checked against the executable contracts by the registry test, so this window can never silently
 * drift from what the dashboards actually need.
 */
export function oliBackfillWindow(asOf) {
  if (!isDateStr(asOf)) throw new Error("oliBackfillWindow requires a YYYY-MM-DD asOf (fail closed).");
  const policy = sourceRegistryEntry(OLI_SOURCE_KEY).initialBackfill;
  if (policy.kind !== "window-days") throw new Error("oliBackfillWindow: the registry OLI backfill policy is not window-days (fail closed).");
  return { from: addDaysStr(monthStartStr(asOf), -policy.days), to: asOf };
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

// The contiguous MISSING sub-windows (gaps) of [from, to] NOT proven by the coverage windows -- NO fixed
// 7-day pre-slicing. An initial backfill (no coverage) returns a SINGLE gap [from, to] -> ONE complete-window
// export. A fully-proven window returns []. This is the normal (non-adaptive) OLI planner input; adaptive
// date splitting into slices is a SEPARATE path invoked ONLY after a confirmed row-cap truncation or a typed
// terminal DataDoe processing failure (never for a normal initial backfill).
export function missingCoverageWindows(coverageWindows, from, to) {
  if (!isDateStr(from) || !isDateStr(to) || from > to) {
    throw new Error("missingCoverageWindows requires a valid from <= to window (fail closed).");
  }
  const merged = mergeCoverageWindows(coverageWindows).filter((w) => w.to >= from && w.from <= to);
  const gaps = [];
  let cursor = from;
  for (const w of merged) {
    if (w.from > cursor) gaps.push({ from: cursor, to: addDaysStr(w.from, -1) });
    if (addDaysStr(w.to, 1) > cursor) cursor = addDaysStr(w.to, 1);
    if (cursor > to) break;
  }
  if (cursor <= to) gaps.push({ from: cursor, to });
  return gaps.filter((g) => g.from <= g.to && g.to <= to);
}

/**
 * Plan the per-slice EXPORT UNITS for one stable <=5-account batch: for every canonical slice of
 * [from, to], the batch members whose own coverage does NOT prove that slice form ONE export unit scoped to
 * exactly those members (sorted; a stable subset => a stable request identity).
 *   - steady state (all members missing the new rolling slices)   => ONE batch export per slice;
 *   - a newly discovered account joining the batch                => SOLO exports for ONLY its missing
 *     historical slices -- completed members are never re-exported;
 *   - fully proven slices                                          => NO unit at all.
 * `batchAccounts`: [{ accountId, rawSellerId }] (any number -- one batch per US/Non-US family; the membership
 * order is irrelevant, members are sorted per unit). `coverageByAccountId`: accountId -> proven windows.
 * Returns [{ slice:{from,to}, accounts:[{accountId,rawSellerId}], sellerOrVendorIds:[sorted] }].
 */
export function planOliSliceExports({ batchAccounts, coverageByAccountId, from, to }) {
  const accounts = Array.isArray(batchAccounts) ? batchAccounts : [];
  if (accounts.length === 0) {
    throw new Error("planOliSliceExports requires a non-empty stable batch (fail closed).");
  } // no upper cap: DataDoe allows any number of sellers per export
  for (const a of accounts) {
    if (!a || !String(a.accountId || "").trim() || !String(a.rawSellerId || "").trim()) {
      throw new Error("planOliSliceExports: every batch account requires accountId + rawSellerId (fail closed).");
    }
  }
  const coverage = coverageByAccountId || {};
  // COMPLETE-WINDOW planning (Blocker A): plan ONE export per contiguous MISSING window, grouping accounts that
  // share the EXACT same missing-window set. There is NO fixed 7-day pre-slicing: a normal initial 420-day
  // backfill with no coverage yields ONE unit over [from, to] per bucket (-> one US + one Non-US export = 4
  // tokens). A fully-covered account contributes no unit; completed historical coverage is never re-exported.
  const groups = new Map(); // JSON(missing windows) -> { windows, accounts }
  for (const a of accounts) {
    const missing = missingCoverageWindows(coverage[a.accountId] || [], from, to);
    if (!missing.length) continue; // fully proven -- never exported again
    const sig = JSON.stringify(missing);
    if (!groups.has(sig)) groups.set(sig, { windows: missing, accounts: [] });
    groups.get(sig).accounts.push(a);
  }
  const units = [];
  for (const { windows, accounts: grp } of groups.values()) {
    const sorted = [...grp].sort((x, y) => (x.rawSellerId < y.rawSellerId ? -1 : 1));
    for (const w of windows) {
      units.push({
        slice: { from: w.from, to: w.to }, // a COMPLETE missing window (not a fixed 7-day slice)
        accounts: sorted,
        sellerOrVendorIds: sorted.map((a) => String(a.rawSellerId)),
      });
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
 * canonical grain. Row attribution is by seller_or_vendor_id against the batch's AUTHORITATIVE account
 * records. Supply EITHER the exact-tuple `accounts: [{ rawSellerId, accountId, ... }]` list (preferred) OR
 * the legacy `accountsBySellerId` map ({ rawSellerId -> { accountId } }).
 *
 * EXACT-TUPLE ISOLATION (isolation correction): the OLI contract is marketplace-BLIND (no
 * marketplace_country_code column), so a rawSellerId that maps to MORE THAN ONE account in the batch (e.g. a
 * single European seller id operating across GB/DE/FR marketplace accounts) cannot be split per account and
 * REJECTS the whole payload (AMBIGUOUS_ACCOUNT_EVIDENCE) rather than silently attributing every row to one
 * account. Seller-only attribution is allowed ONLY when the rawSellerId maps to exactly one account. An
 * unknown/blank seller REJECTS the whole payload (fail closed -- mirrors validateBatchSourcePayload).
 * currency must be a canonical AAA code; sku/child_asin may be blank (kept as '' grain components). Two
 * fragment rows on the same grain SUM (partial aggregates of one grain cell); the durable upsert then
 * REPLACES the whole matching row, so re-exported corrected slices never duplicate.
 */
export function oliHistoryRowsFromFragment({ rows, accounts = null, accountsBySellerId = null, organizationFingerprint, connectionId, sourceRequestHash }) {
  if (!Array.isArray(rows)) throw new Error("oliHistoryRowsFromFragment requires an array payload (fail closed).");
  if (!organizationFingerprint || !connectionId || !sourceRequestHash) {
    throw new Error("oliHistoryRowsFromFragment requires organizationFingerprint + connectionId + sourceRequestHash (fail closed).");
  }
  // Build the authoritative rawSellerId -> Set(accountId) map. `accounts` (the batch's exact records) is the
  // canonical source of truth and preserves multiplicity so a seller shared across marketplace accounts is
  // detected as AMBIGUOUS; the legacy `accountsBySellerId` map is a pre-resolved single-account fallback.
  const sellerAccounts = new Map();
  if (Array.isArray(accounts)) {
    for (const a of accounts) {
      const sid = String((a && a.rawSellerId) ?? "").trim();
      const aid = String((a && a.accountId) ?? "").trim();
      if (!sid || !aid) throw new Error("oliHistoryRowsFromFragment: a batch account record is missing rawSellerId/accountId (fail closed).");
      if (!sellerAccounts.has(sid)) sellerAccounts.set(sid, new Set());
      sellerAccounts.get(sid).add(aid);
    }
  } else if (accountsBySellerId) {
    for (const [sid, v] of Object.entries(accountsBySellerId)) {
      const aid = String((v && v.accountId) ?? "").trim();
      if (aid) { if (!sellerAccounts.has(sid)) sellerAccounts.set(sid, new Set()); sellerAccounts.get(sid).add(aid); }
    }
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
    const accts = seller ? sellerAccounts.get(seller) : null;
    if (!seller || !accts || accts.size === 0) {
      throw new Error("oliHistoryRowsFromFragment: a row's seller_or_vendor_id is blank/unknown to the batch; rejecting the whole payload (fail closed).");
    }
    if (accts.size > 1) {
      const e = new Error("oliHistoryRowsFromFragment: a rawSellerId maps to multiple marketplace accounts but the marketplace-blind OLI payload cannot disambiguate; rejecting the whole payload (fail closed).");
      e.code = "AMBIGUOUS_ACCOUNT_EVIDENCE";
      throw e;
    }
    const account = { accountId: [...accts][0] };
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
