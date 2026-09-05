// Advanced Listing Health v3 -- PURE client presenter (Phase 3 read-only preview). Turns the server v3 payload
// (from api action "listing-health-v3", built from durable enriched OLI + latest saved evidence) into the agreed
// 16-column rows + deterministic Recommended Action + Why Flagged + a collapsible Priority Actions list. It NEVER
// re-derives sales/units (those are the server's durable-OLI numbers) and never invents a cause: every recommendation
// is deterministic from the evidence the server already validated. Pure + framework-free (unit-testable).

// Visual health gate (ordered: most severe first). Derived from the row's evidence, NOT stored server-side.
export const V3_GATES = Object.freeze({
  error: { label: "Amazon error", tone: "bad" },
  suppressed: { label: "Suppressed", tone: "bad" },
  no_live_offer: { label: "No live offer", tone: "bad" },
  no_price: { label: "No price", tone: "warn" },
  inactive: { label: "Inactive", tone: "warn" },
  incomplete: { label: "Incomplete", tone: "warn" },
  stranded: { label: "Stranded stock", tone: "warn" },
  ok: { label: "OK", tone: "ok" },
});
const GATE_ORDER = ["error", "suppressed", "no_live_offer", "no_price", "inactive", "incomplete", "stranded", "ok"];
export const GATE_RANK = Object.freeze(Object.fromEntries(GATE_ORDER.map((g, i) => [g, i])));

const has = (reasons, code) => Array.isArray(reasons) && reasons.some((r) => r && r.code === code);

// The visual gate for a row, from the server-validated evidence (flagReasons + status/price). Confirmed Amazon facts
// outrank heuristic/possible states. An unflagged row is "ok".
export function v3GateForRow(row) {
  const reasons = row.flagReasons || [];
  const status = String(row.listingStatus || "").trim();
  if (has(reasons, "amazon_issue_error")) return "error";
  if (has(reasons, "not_buyable") || has(reasons, "not_discoverable")) return "suppressed";
  if (has(reasons, "no_live_offer")) return "no_live_offer";
  if (has(reasons, "no_price_while_active")) return "no_price";
  if (/^inactive$/i.test(status)) return "inactive";
  if (/^incomplete$/i.test(status)) return "incomplete";
  if (has(reasons, "stranded_stock")) return "stranded";
  // Any other non-Active status the server flagged (e.g. "Deleted") -> treat as inactive so a flagged row is never
  // shown as OK. Falls AFTER the specific gates so a precise cause always wins.
  if (has(reasons, "status_not_active")) return "inactive";
  return "ok";
}

// Why Flagged: the human evidence string, each reason tagged confirmed/possible (never an invented cause).
export function v3WhyFlagged(row) {
  const reasons = row.flagReasons || [];
  if (!reasons.length) return "";
  const confirmed = reasons.filter((r) => r.confidence === "confirmed").map((r) => r.detail || r.code);
  const possible = reasons.filter((r) => r.confidence !== "confirmed").map((r) => r.detail || r.code);
  const parts = [];
  if (confirmed.length) parts.push("Confirmed: " + confirmed.join("; "));
  if (possible.length) parts.push("Possible: " + possible.join("; "));
  return parts.join("  |  ");
}

// DETERMINISTIC recommended action from the evidence. Never claims an unproven cause: an Amazon-confirmed signal gets
// a direct fix; a "possible" signal (inactive alone) gets an investigate step, explicitly not asserted as the cause.
export function v3RecommendedAction(row) {
  const reasons = row.flagReasons || [];
  const issueCodes = (row.issues || []).map((i) => i && i.code).filter(Boolean).slice(0, 3).join(", ");
  if (has(reasons, "amazon_issue_error")) return `Resolve the Amazon listing error${issueCodes ? " (" + issueCodes + ")" : ""} in Seller Central, then re-check Buyable/Discoverable.`;
  if (has(reasons, "not_buyable") || has(reasons, "not_discoverable")) return "Amazon reports this listing suppressed (not Buyable/Discoverable): open the listing in Seller Central and clear the suppression.";
  if (has(reasons, "no_live_offer")) return "Restore a live, priced offer for this SKU (no active priced offer is present).";
  if (has(reasons, "no_price_while_active")) return "Set a valid price: the listing is Active but carries no price.";
  if (has(reasons, "status_not_active")) return "Investigate why the listing is not Active and reactivate/complete it (status alone does not prove the cause).";
  if (has(reasons, "stranded_stock")) return "Investigate stranded stock: on-hand inventory exists while the listing is not Active.";
  return "No action needed.";
}

// Brand-key normaliser mirroring the app's canonical key (trim, collapse whitespace, lowercase).
const brandKey = (v) => String(v || "").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Build the 16-column presentation rows from the server v3 payload. Optionally filter to a selected brand (client
 * display filter, mirroring v1). Sales/units are the server's durable-OLI numbers (never re-derived here). Returns
 * rows carrying every field the 16 columns + the Priority Actions list need, plus gate/why/recommendedAction.
 */
export function buildV3Rows(payload, selectedBrand = null) {
  const rows = payload && Array.isArray(payload.rows) ? payload.rows : [];
  const wantBrand = selectedBrand && brandKey(selectedBrand) !== "all" ? brandKey(selectedBrand) : null;
  const out = [];
  for (const r of rows) {
    if (wantBrand && brandKey(r.brand) !== wantBrand) continue;
    const gate = v3GateForRow(r);
    out.push({
      ...r,
      gate,
      gateMeta: V3_GATES[gate],
      whyFlagged: v3WhyFlagged(r),
      recommendedAction: v3RecommendedAction(r),
      // salesCovered comes from the server (window coverage); used to mark a 0 that is not a proven zero.
    });
  }
  return out;
}

// Ranked, collapsible Priority Actions from the flagged rows: each carries ranked evidence, reason, confidence and the
// deterministic recommended action. Ranked by selected-period exposure (Sales at Risk) desc, then gate severity.
export function buildV3PriorityActions(rows) {
  const flagged = (rows || []).filter((r) => r.flagged);
  const ranked = flagged.slice().sort((a, b) => (Number(b.salesAtRisk) || 0) - (Number(a.salesAtRisk) || 0) || (GATE_RANK[a.gate] - GATE_RANK[b.gate]));
  return ranked.map((r) => {
    const reasons = r.flagReasons || [];
    const confidence = reasons.some((x) => x.confidence === "confirmed") ? "confirmed" : "possible";
    return {
      id: r.sku || r.asin,
      sku: r.sku,
      productName: r.productName,
      gate: r.gate,
      gateLabel: (r.gateMeta && r.gateMeta.label) || r.gate,
      severity: r.gateMeta && r.gateMeta.tone === "bad" ? "high" : "medium",
      salesAtRisk: Number(r.salesAtRisk) || 0,
      currency: r.currency || null,
      why: r.whyFlagged,
      confidence,
      action: r.recommendedAction,
      evidence: [
        { label: "Status", value: r.listingStatus || "Unknown" },
        { label: "Buyable", value: r.buyable === null || r.buyable === undefined ? "Unavailable" : (r.buyable ? "Yes" : "No") },
        { label: "Discoverable", value: r.discoverable === null || r.discoverable === undefined ? "Unavailable" : (r.discoverable ? "Yes" : "No") },
        { label: "Live offer", value: r.liveOffer === null || r.liveOffer === undefined ? "Unavailable" : (r.liveOffer ? "Yes" : "No") },
        { label: "Sales at risk", value: String(Number(r.salesAtRisk) || 0) },
      ],
    };
  });
}

// Display helpers (null/unavailable vs genuine zero vs not-applicable) -- kept here so the view + tests share them.
export const fmtOnHand = (value, applicable) => {
  if (applicable === false) return "Not applicable";
  if (value === null || value === undefined) return "Unavailable";
  return String(value);
};
export const fmtBool = (v) => (v === null || v === undefined ? "Unavailable" : (v ? "Yes" : "No"));
export const fmtIssue = (issues) => {
  const first = Array.isArray(issues) && issues[0];
  if (!first) return "";
  return `${first.severity || ""}${first.code ? " " + first.code : ""}${first.message ? ": " + first.message : ""}`.trim();
};

// The exact flat export rows for the Excel download -- MUST mirror the authorized, filtered UI rows (same 16 columns).
export function v3ExportRows(rows) {
  return (rows || []).map((r) => ({
    "Product Name": r.productName || "",
    SKU: r.sku || "",
    ASIN: r.asin || "",
    Brand: r.brand || "",
    Gate: (r.gateMeta && r.gateMeta.label) || r.gate,
    Status: r.listingStatus || "",
    Fulfilment: r.channel || "",
    Price: r.price === null || r.price === undefined ? "" : r.price,
    Currency: r.currency || "",
    "On Hand FBA": fmtOnHand(r.onHandFba, r.onHandFbaApplicable),
    "On Hand FBM": fmtOnHand(r.onHandFbm, r.onHandFbmApplicable),
    "Sales (selected period)": Number(r.sales) || 0,
    "Units (selected period)": Number(r.units) || 0,
    "Sales at Risk": Number(r.salesAtRisk) || 0,
    Buyable: fmtBool(r.buyable),
    Discoverable: fmtBool(r.discoverable),
    "Live Offer": fmtBool(r.liveOffer),
    "Amazon Issue": fmtIssue(r.issues),
    "Why Flagged": r.whyFlagged || "",
    "Recommended Action": r.recommendedAction || "",
  }));
}

// The window-status label the UI shows (Covered / Partial / Unavailable) with an honest note.
export function v3WindowStatusLabel(payload) {
  const s = payload && payload.salesWindowStatus;
  if (s === "covered") return { label: "Covered", tone: "ok", note: "Sales & Units are fully covered by durable Order Line Items for the selected window." };
  if (s === "partial") return { label: "Partial", tone: "warn", note: "Durable OLI covers only part of the selected window; totals are for the covered portion, not proven for the whole range." };
  return { label: "Unavailable", tone: "bad", note: "No durable OLI coverage for the selected window; sales/units are unavailable (not a proven zero)." };
}
