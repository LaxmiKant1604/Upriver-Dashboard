// Serve-time COMPLETENESS augmentation for the two-layer provisional/final D-1 model. The completeness lives in its
// own durable table (source_oli_completeness, per account + sale_date) and is joined onto the report response at
// SERVE time -- so the label is ALWAYS current (a provisional D-1 promotes to final the moment the source table is
// updated, with no snapshot rewrite) and is NEVER baked into the snapshot payload. Pure summariser + a thin factory
// around an injected reader; the read is advisory and never fails a report read. 7-bit ASCII.

import { operationalUnitMetrics } from "../sync/oli-order-rules.js";
import { oliGroupKey, resolvedEstimateGroupKeys } from "../sync/oli-sales-estimate.js";

const S = (v) => (v == null ? "" : String(v));
const N = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Reduce a set of durable operational-unit rows (source_oli_operational_units) to ONE day's transparent observed-unit
// breakdown, using the canonical operationalUnitMetrics classifier. `onDate` restricts to the report's headline day
// (the completeness latestDate); when null the latest date PRESENT in the rows is used. Returns null when there are no
// operational-unit rows on that day (the UI simply shows no breakdown). Revenue is never derived from this -- units only.
export function summarizeOperationalUnitBreakdown(rows, onDate = null, resolvedKeys = null) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && S(r.sale_date ?? r.saleDate));
  if (list.length === 0) return null;
  const day = onDate && S(onDate)
    ? S(onDate)
    : list.reduce((m, r) => { const d = S(r.sale_date ?? r.saleDate); return d > m ? d : m; }, S(list[0].sale_date ?? list[0].saleDate));
  const onDay = list.filter((r) => S(r.sale_date ?? r.saleDate) === day);
  if (onDay.length === 0) return null;
  // A grain whose missing units are RESOLVED by an internal sales estimate must no longer appear as unresolved:
  // its explicit-zero + pending units move into priced (they now carry an estimated price -- no separate label).
  // Genuinely-unresolved grains (no estimate) keep their explicit-zero / pending classes. observedUnits is
  // unchanged either way (units are only reclassified, never added or removed). resolvedKeys=null => legacy behaviour.
  const resolved = resolvedKeys instanceof Set ? resolvedKeys : null;
  const m = operationalUnitMetrics(onDay.map((r) => {
    const zero = N(r.explicit_zero_units ?? r.explicitZeroUnits);
    const pending = N(r.pending_units ?? r.pendingUnits);
    const priced = N(r.priced_units ?? r.pricedUnits);
    const isResolved = resolved != null && resolved.has(oliGroupKey({
      accountId: r.account_id ?? r.accountId, saleDate: r.sale_date ?? r.saleDate,
      sku: r.sku, childAsin: r.child_asin ?? r.childAsin, currency: r.currency,
    }));
    return {
      sku: S(r.sku), childAsin: S(r.child_asin ?? r.childAsin),
      pricedUnits: priced + (isResolved ? zero + pending : 0),
      pricedSales: N(r.priced_sales ?? r.pricedSales),
      explicitZeroUnits: isResolved ? 0 : zero,
      pendingUnits: isResolved ? 0 : pending,
      cancelledUnits: N(r.cancelled_units ?? r.cancelledUnits),
    };
  }));
  return {
    onDate: day,
    pricedUnits: m.pricedUnits,
    explicitZeroUnits: m.explicitZeroUnits,
    pendingWithSkuUnits: m.pendingPriceUnitsWithSku,
    pendingWithoutSkuUnits: m.pendingPriceUnitsWithoutSku,
    cancelledUnits: m.cancelledUnits,
    observedUnits: m.observedUnits,
    skuMovementUnits: m.skuMovementUnits,
  };
}

// Advisory helper: read + summarise the observed-unit breakdown for a report's headline day. ANY failure (missing
// reader, read error, additive table absent) yields null so a breakdown hiccup never affects the completeness read.
async function readUnitBreakdownFor({ read, readEstimates = null, organizationFingerprint, connectionId, accountIds, onDate }) {
  if (typeof read !== "function" || !onDate || !S(onDate)) return null;
  try {
    const rows = await read({ organizationFingerprint, connectionId, accountIds, from: S(onDate), to: S(onDate) });
    // Advisory: read the internal sales estimates for the day so RESOLVED grains drop out of the unresolved
    // breakdown. Any failure leaves resolvedKeys null (legacy breakdown) -- it never breaks the completeness read.
    let resolvedKeys = null;
    if (typeof readEstimates === "function") {
      try {
        const est = await readEstimates({ organizationFingerprint, connectionId, accountIds, from: S(onDate), to: S(onDate) });
        resolvedKeys = resolvedEstimateGroupKeys(Array.isArray(est) ? est : []);
      } catch (_e2) { resolvedKeys = null; }
    }
    return summarizeOperationalUnitBreakdown(rows, S(onDate), resolvedKeys);
  } catch (_e) {
    return null;
  }
}

// Reduce a set of per-date completeness rows (one account) to the report's headline completeness: the LATEST date's
// state (that is the day the report leads with, e.g. D-1) plus the account's finalized-through high-water mark.
// Returns null when there is no completeness evidence at all (the report renders unlabelled, as before).
export function summarizeCompleteness(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && S(r.sale_date));
  if (list.length === 0) return null;
  const sorted = [...list].sort((a, b) => S(a.sale_date).localeCompare(S(b.sale_date)));
  const latest = sorted[sorted.length - 1];
  const finals = sorted.filter((r) => r.completeness_status === "final");
  const finalizedThrough = finals.length ? S(finals[finals.length - 1].sale_date) : null;
  const status = S(latest.completeness_status) || "final";
  return {
    status,                                   // provisional | final | source-defect
    provisional: status === "provisional",
    sourceDefect: status === "source-defect",
    latestDate: S(latest.sale_date),
    itemizedOrderCount: N(latest.itemized_order_count),
    pendingOrderCount: N(latest.pending_order_count),
    itemizedUnitCount: N(latest.itemized_unit_count),
    pendingUnitCount: N(latest.pending_unit_count),
    itemizationPercent: N(latest.itemization_percent),
    requestedAsOf: latest.requested_as_of ? S(latest.requested_as_of) : null,
    provenThrough: latest.proven_export_through ? S(latest.proven_export_through) : null,
    finalizedThrough,
    refreshedAt: latest.refreshed_at ? S(latest.refreshed_at) : null,
    // A single honest notice string the UI can show verbatim (never implies the provisional amount is final).
    notice: status === "provisional"
      ? "Amazon/DataDoe has returned D-1 orders, but some item-level prices are still pending. Sales and ratio metrics may increase automatically."
      : (status === "source-defect"
        ? "A source-data issue was detected for this day; showing the last finalized data while it is investigated."
        : null),
  };
}

// Aggregate completeness across a PORTFOLIO of accounts (Brand View). Take each account's LATEST-date row; the
// portfolio is provisional if ANY account is provisional, source-defect if any is source-defect, else final. Pending
// order/unit counts sum; the itemization % is the portfolio's itemized / (itemized + pending) orders. Never
// fabricated -- pending is always shown separately.
export function summarizePortfolioCompleteness(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && S(r.sale_date) && S(r.account_id));
  if (list.length === 0) return null;
  const latestByAccount = new Map();
  for (const r of list) {
    const a = S(r.account_id); const prev = latestByAccount.get(a);
    if (!prev || S(r.sale_date) > S(prev.sale_date)) latestByAccount.set(a, r);
  }
  let provisional = 0, final = 0, sourceDefect = 0, itemizedOrders = 0, pendingOrders = 0, itemizedUnits = 0, pendingUnits = 0, latestDate = null;
  for (const r of latestByAccount.values()) {
    const st = S(r.completeness_status);
    if (st === "provisional") provisional += 1; else if (st === "final") final += 1; else if (st === "source-defect") sourceDefect += 1;
    itemizedOrders += N(r.itemized_order_count); pendingOrders += N(r.pending_order_count);
    itemizedUnits += N(r.itemized_unit_count); pendingUnits += N(r.pending_unit_count);
    if (!latestDate || S(r.sale_date) > latestDate) latestDate = S(r.sale_date);
  }
  const tot = itemizedOrders + pendingOrders;
  const status = sourceDefect > 0 ? "source-defect" : (provisional > 0 ? "provisional" : "final");
  return {
    status, provisional: status === "provisional", sourceDefect: status === "source-defect",
    latestDate,
    accountsProvisional: provisional, accountsFinal: final, accountsSourceDefect: sourceDefect,
    itemizedOrderCount: itemizedOrders, pendingOrderCount: pendingOrders,
    itemizedUnitCount: itemizedUnits, pendingUnitCount: pendingUnits,
    itemizationPercent: tot > 0 ? Math.round((itemizedOrders / tot) * 1000) / 10 : 100,
    notice: status === "provisional"
      ? "Amazon/DataDoe has returned D-1 orders, but some item-level prices are still pending. Brand sales may increase automatically."
      : (status === "source-defect" ? "A source-data issue was detected for one or more accounts; showing the last finalized data while it is investigated." : null),
  };
}

// Portfolio (multi-account) augment: reads completeness for a fixed set of accounts and aggregates. `params.asOf`
// (Brand View) or `params.to` bounds the window; a null `from` reads all durable dates (the summariser keeps the
// latest per account). Advisory: any failure returns {}.
export function makePortfolioCompletenessAugment({ organizationFingerprint, connectionId = "primary", accountIds, read, readUnitBreakdown = null, readEstimates = null }) {
  const ids = (Array.isArray(accountIds) ? accountIds : []).map(String).filter(Boolean);
  return async ({ params }) => {
    if (!organizationFingerprint || ids.length === 0 || typeof read !== "function") return {};
    try {
      const to = params && (params.asOf || params.to) ? String(params.asOf || params.to) : null;
      const rows = await read({ organizationFingerprint, connectionId, accountIds: ids, from: null, to });
      const c = summarizePortfolioCompleteness(rows);
      if (!c) return {};
      const breakdown = await readUnitBreakdownFor({ read: readUnitBreakdown, readEstimates, organizationFingerprint, connectionId, accountIds: ids, onDate: c.latestDate });
      if (breakdown) c.unitBreakdown = breakdown;
      return { completeness: c };
    } catch (_e) {
      return {};
    }
  };
}

// Build the async serveSharedReport augment: ({ accountId, params }) => { completeness } | {}. The read is advisory:
// any failure returns {} so a completeness hiccup never breaks a report read.
export function makeCompletenessAugment({ organizationFingerprint, connectionId = "primary", read, readUnitBreakdown = null, readEstimates = null, readCoverage = null, coverageSourceKey = "order-line-items" }) {
  return async ({ accountId, params, servedTo = null }) => {
    // Daily uses the real accountId as the serve id; the Brand endpoints use a brand-SCOPED serve id but carry the
    // real account in params.accountId -- prefer that so completeness always keys on the real account.
    const acc = params && params.accountId ? String(params.accountId) : (accountId ? String(accountId) : "");
    if (!organizationFingerprint || !acc || typeof read !== "function") return {};
    try {
      const rows = await read({
        organizationFingerprint, connectionId, accountIds: [acc],
        from: params && params.from ? String(params.from) : null,
        to: params && (params.to || params.asOf) ? String(params.to || params.asOf) : null,
      });
      let c = summarizeCompleteness(rows);
      // FRESHNESS <= SERVED VALUES (invariant): the completeness LABEL must never claim finalized/latest/proven data
      // NEWER than the snapshot values actually being served. When the served snapshot window (servedTo, the snapshot's
      // own params.to) ends BEFORE the account's real completeness horizon -- a convergence lag where the scheduler/
      // reconciler has not yet republished the newer window, e.g. a stale-scope LKG at Sep-17 while completeness reads
      // Sep-20 -- clamp the label to the served window and expose the true durable horizon as `completenessHorizon` +
      // `behindServedTo` so the UI shows an honest "updating to <date>" instead of stapling a later "Final through
      // <date>" onto older values. servedTo null/blank (unknown window) => no clamp (fail-soft, byte-identical).
      const isD = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
      if (c && isD(servedTo)) {
        const horizon = [c.finalizedThrough, c.provenThrough, c.latestDate].filter(isD).sort();
        const realHorizon = horizon.length ? horizon[horizon.length - 1] : null;
        if (isD(realHorizon) && realHorizon > servedTo) {
          const clamp = (d) => (isD(d) && d > servedTo ? servedTo : d);
          c = {
            ...c,
            finalizedThrough: clamp(c.finalizedThrough),
            latestDate: clamp(c.latestDate),
            provenThrough: clamp(c.provenThrough),
            servedThrough: servedTo,
            completenessHorizon: realHorizon,   // the true durable horizon the snapshot is CATCHING UP to
            behindServedTo: true,               // the served values lag the source; a zero-export republish is due
            updating: true,
          };
        }
      }
      // OLI COVERAGE bounds (flexii UK repair): surface the account's PROVEN OLI coverage window bounds so the client
      // can render a period with NO coverage as Unavailable / em dash instead of a fabricated zero (a covered date
      // that simply has no sales stays a genuine zero -- coverageFrom marks where proof BEGINS, not where sales do).
      // Attached ONLY onto an EXISTING completeness object (never as a coverage-only object -- that would make the
      // DataStatusBanner assert a spurious "final" label for an account with no completeness rows). Advisory: any read
      // failure simply omits coverage (the client falls back to its row-presence behaviour).
      if (c && typeof readCoverage === "function") {
        try {
          const cov = await readCoverage({ organizationFingerprint, connectionId, accountId: acc, sourceKey: coverageSourceKey });
          // coverageRead is ALWAYS surfaced (ok / read-failed / schema-missing) so the client can distinguish a
          // covered/empty period from one whose evidence could not be read (UNKNOWN -> em dash, never a fabricated 0).
          const read = cov && S(cov.read) ? S(cov.read) : "read-failed";
          const windows = read === "ok" && Array.isArray(cov.windows)
            ? cov.windows.filter((w) => w && /^\d{4}-\d{2}-\d{2}$/.test(S(w.from)) && /^\d{4}-\d{2}-\d{2}$/.test(S(w.to))).map((w) => ({ from: S(w.from), to: S(w.to) }))
            : [];
          const coverageFrom = windows.length ? windows.reduce((m, w) => (!m || w.from < m ? w.from : m), null) : null;
          const coverageTo = windows.length ? windows.reduce((m, w) => (!m || w.to > m ? w.to : m), null) : null;
          c = { ...c, coverageRead: read, coverageWindows: windows, coverageFrom, coverageTo };
        } catch (_ce) { c = { ...c, coverageRead: "read-failed", coverageWindows: [], coverageFrom: null, coverageTo: null }; }
      }
      if (!c) return {};
      const breakdown = c.latestDate ? await readUnitBreakdownFor({ read: readUnitBreakdown, readEstimates, organizationFingerprint, connectionId, accountIds: [acc], onDate: c.latestDate }) : null;
      if (breakdown) c.unitBreakdown = breakdown;
      return { completeness: c };
    } catch (_e) {
      return {};
    }
  };
}
