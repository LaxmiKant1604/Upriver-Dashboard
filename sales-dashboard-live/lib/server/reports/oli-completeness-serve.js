// Serve-time COMPLETENESS augmentation for the two-layer provisional/final D-1 model. The completeness lives in its
// own durable table (source_oli_completeness, per account + sale_date) and is joined onto the report response at
// SERVE time -- so the label is ALWAYS current (a provisional D-1 promotes to final the moment the source table is
// updated, with no snapshot rewrite) and is NEVER baked into the snapshot payload. Pure summariser + a thin factory
// around an injected reader; the read is advisory and never fails a report read. 7-bit ASCII.

const S = (v) => (v == null ? "" : String(v));
const N = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

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
export function makePortfolioCompletenessAugment({ organizationFingerprint, connectionId = "primary", accountIds, read }) {
  const ids = (Array.isArray(accountIds) ? accountIds : []).map(String).filter(Boolean);
  return async ({ params }) => {
    if (!organizationFingerprint || ids.length === 0 || typeof read !== "function") return {};
    try {
      const to = params && (params.asOf || params.to) ? String(params.asOf || params.to) : null;
      const rows = await read({ organizationFingerprint, connectionId, accountIds: ids, from: null, to });
      const c = summarizePortfolioCompleteness(rows);
      return c ? { completeness: c } : {};
    } catch (_e) {
      return {};
    }
  };
}

// Build the async serveSharedReport augment: ({ accountId, params }) => { completeness } | {}. The read is advisory:
// any failure returns {} so a completeness hiccup never breaks a report read.
export function makeCompletenessAugment({ organizationFingerprint, connectionId = "primary", read }) {
  return async ({ accountId, params }) => {
    if (!organizationFingerprint || !accountId || typeof read !== "function") return {};
    try {
      const rows = await read({
        organizationFingerprint, connectionId, accountIds: [String(accountId)],
        from: params && params.from ? String(params.from) : null,
        to: params && params.to ? String(params.to) : null,
      });
      const c = summarizeCompleteness(rows);
      return c ? { completeness: c } : {};
    } catch (_e) {
      return {};
    }
  };
}
