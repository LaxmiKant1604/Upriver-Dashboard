// Advanced Listing Health v3 -- PURE client presenter (Phase 3 read-only preview). Turns the server v3 payload
// (from api action "listing-health-v3", built from durable enriched OLI + latest saved evidence) into the agreed
// 16-column rows + deterministic Recommended Action + Why Flagged + a collapsible Priority Actions list. It NEVER
// re-derives sales/units (those are the server's durable-OLI numbers) and never invents a cause: every recommendation
// is deterministic from the evidence the server already validated. Pure + framework-free (unit-testable).

// Visual HEALTH FINDING (ordered: most severe first). DERIVED from the row's evidence -- it is NOT the Amazon source
// status (that is `listingStatus`, shown separately). `needs_verification` is an honest "we cannot confirm health"
// state used when the confirming evidence (Buyable/Discoverable/Live offer) is absent -- NEVER a fabricated OK, and
// NEVER a negative finding. Only explicit evidence produces a negative finding.
export const V3_GATES = Object.freeze({
  error: { label: "Amazon error", tone: "bad" },
  suppressed: { label: "Suppressed", tone: "bad" },
  no_live_offer: { label: "No live offer", tone: "bad" },
  no_price: { label: "No price", tone: "warn" },
  inactive: { label: "Inactive", tone: "warn" },
  incomplete: { label: "Incomplete", tone: "warn" },
  stranded: { label: "Stranded stock", tone: "warn" },
  needs_verification: { label: "Needs verification", tone: "warn" },
  ok: { label: "OK", tone: "ok" },
});
const GATE_ORDER = ["error", "suppressed", "no_live_offer", "no_price", "inactive", "incomplete", "stranded", "needs_verification", "ok"];
export const GATE_RANK = Object.freeze(Object.fromEntries(GATE_ORDER.map((g, i) => [g, i])));

const has = (reasons, code) => Array.isArray(reasons) && reasons.some((r) => r && r.code === code);
// A row carries a CONFIRMED positive health signal when Amazon explicitly reports it Buyable, Discoverable, or with a
// live offer (all tri-state; only an explicit `true` counts -- null/undefined is UNKNOWN, never a positive).
function hasPositiveHealthSignal(row) {
  return row.buyable === true || row.discoverable === true || row.liveOffer === true;
}

// The HEALTH FINDING for a row, from the server-validated evidence (flagReasons + status/price). Confirmed Amazon facts
// outrank heuristic/possible states. An UNFLAGGED row is "ok" ONLY when it carries a confirmed positive health signal;
// with NO confirming evidence (Buyable/Discoverable/Live offer all unknown) the finding is "needs_verification" -- we
// never fabricate a healthy state from missing evidence.
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
  // Unflagged: confirmed-healthy ONLY with an explicit positive signal; otherwise honestly "needs verification".
  return hasPositiveHealthSignal(row) ? "ok" : "needs_verification";
}

// Per-row CONFIDENCE for the Health Finding: "confirmed" (an Amazon-confirmed flag, or a confirmed positive OK),
// "possible" (only heuristic/possible flags), or "unavailable" (no confirming evidence -> the needs_verification row).
export function v3Confidence(row) {
  const reasons = row.flagReasons || [];
  if (reasons.length) return reasons.some((r) => r && r.confidence === "confirmed") ? "confirmed" : "possible";
  return hasPositiveHealthSignal(row) ? "confirmed" : "unavailable";
}

// The evidence backing a row's finding, for the "Evidence source" column. Never claims evidence it does not have:
// Listings status/price always present when the row exists; Raw JSON (Buyable/Discoverable/Live offer/issues) only
// when saved. When neither health signal is present it is honestly "Unavailable".
export function v3EvidenceSource(row) {
  const hasRaw = row.buyable != null || row.discoverable != null || row.liveOffer != null || (Array.isArray(row.issues) && row.issues.length > 0);
  const hasListing = row.listingStatus != null || row.price != null || row.channel != null;
  if (hasListing && hasRaw) return "Listings + Raw JSON";
  if (hasRaw) return "Raw JSON";
  if (hasListing) return "Listings";
  return "Unavailable";
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
  // Unflagged: a confirmed-healthy OK needs nothing; a needs-verification row (no confirming evidence) is flagged for
  // manual verification, NOT asserted as a problem.
  if (!hasPositiveHealthSignal(row)) return "Verify this listing in Seller Central — Amazon Buyable/Discoverable/live-offer evidence is not available, so health cannot be confirmed.";
  return "No action needed.";
}

// Brand-key normaliser mirroring the app's canonical key (trim, collapse whitespace, lowercase).
const brandKey = (v) => String(v || "").trim().replace(/\s+/g, " ").toLowerCase();

// Evidence as-of helpers (pure): extract the YYYY-MM-DD date from an ISO timestamp; mark evidence STALE when its
// as-of is more than 2 calendar days older than the report as-of (visibly labelled in the UI, never hidden).
const dateOnly = (v) => { const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v || "")); return m ? m[1] : null; };
const daysBetween = (a, b) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(a || "") || !/^\d{4}-\d{2}-\d{2}$/.test(b || "")) return null; return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000); };
export const isEvidenceStale = (asOf, reportAsOf) => { const d = daysBetween(asOf, reportAsOf); return d !== null && d > 2; };

// The On Hand FBA source model the server stamps on every payload since phase 2 of the Listings inventory cutover: ONE
// source per account -- validated Listings, else the account's last SAVED FBA Inventory Health snapshot as a dated,
// read-only, temporary bridge (used by the server only while it is within 2 days of the report as-of; FBA Inventory
// Health is no longer refreshed), else Unavailable. A payload
// WITHOUT it predates phase 2 (e.g. a browser-cached response): its On Hand FBA chained Health and Listings per SKU, so
// it is never shown.
export const V3_INVENTORY_SOURCE_MODEL = "inventory-source-v1";
export const isInventorySourcePayload = (payload) => !!(payload && payload.inventory && payload.inventory.model === V3_INVENTORY_SOURCE_MODEL);

// A pre-phase-2 row: its FBA on-hand (and a "stranded stock" flag that rested on it) came from a per-SKU Health/Listings
// chain, so EVERY on-hand FBA becomes Unavailable and an FBA-channel stranded reason is withdrawn (flagged / sales-at-risk
// follow). FBM on-hand and every other Amazon finding are kept.
function withoutLegacyInventory(r) {
  const fbaChannel = r.channel !== "FBM"; // FBA or unknown channel: the stranded gate read the FBA on-hand
  const reasons = Array.isArray(r.flagReasons) ? r.flagReasons : [];
  const flagReasons = fbaChannel ? reasons.filter((x) => !(x && x.code === "stranded_stock")) : reasons;
  const flagged = flagReasons.length > 0;
  return { ...r, onHandFba: null, onHandFbaSource: null, flagReasons, flagged, salesAtRisk: flagged ? r.salesAtRisk : 0 };
}

// Plain-language text for the server's inventory-source reason codes (Listings validation + Health availability).
// An unknown code is shown as-is (never hidden).
const INVENTORY_REASON_TEXT = {
  "listings-empty": "no saved Listings rows",
  "listings-foreign-marketplace-rows": "Listings rows from another marketplace",
  "listings-not-expanded": "the saved Listings export has no inventory fields",
  "listings-invalid-rows": "invalid Listings rows",
  "listings-unresolved-conflicts": "SKUs with conflicting duplicate Listings rows",
  "listings-unattributed-stock": "SKUs with stock but no ASIN in Listings",
  "listings-blank-fba-fields": "FBA SKUs with blank Listings stock fields",
  "health-snapshot-missing": "no saved FBA Inventory Health snapshot",
  "health-snapshot-empty": "the saved FBA Inventory Health snapshot is empty",
  "health-snapshot-read-failed": "the saved FBA Inventory Health snapshot could not be read",
  "health-payload-unreadable": "the saved FBA Inventory Health snapshot could not be read",
  "health-payload-row-count-mismatch": "the saved FBA Inventory Health snapshot failed its integrity check",
  "health-payload-malformed": "the saved FBA Inventory Health snapshot failed its integrity check",
  "health-snapshot-identity-mismatch": "the saved FBA Inventory Health snapshot does not belong to this account",
  "health-identity-unavailable": "this account's saved FBA Inventory Health snapshot could not be identified",
  "health-foreign-seller-rows": "the saved FBA Inventory Health snapshot contains another seller's rows",
  "health-foreign-marketplace-rows": "the saved FBA Inventory Health snapshot contains another marketplace's rows",
  "health-foreign-seller-or-marketplace-rows": "the saved FBA Inventory Health snapshot contains another seller's or marketplace's rows",
  "health-bridge-not-loaded": "the saved FBA Inventory Health snapshot was not loaded",
  "health-bridge-as-of-missing": "the saved FBA Inventory Health snapshot cannot be checked against a report date",
};
export function v3InventoryReasonText(code) {
  const s = String(code == null ? "" : code).trim();
  // health-bridge-stale:<date> -- the last saved Health snapshot is too old to use (FBA Inventory Health is no longer
  // refreshed); it drives no figure.
  const stale = /^health-bridge-stale:(\d{4}-\d{2}-\d{2})?$/.exec(s);
  if (stale) return `the last saved FBA Inventory Health snapshot${stale[1] ? ` (${stale[1]})` : ""} is too old to use (no longer refreshed)`;
  const m = /^([a-z0-9-]+):(\d+)$/.exec(s);
  const key = m ? m[1] : s;
  const text = INVENTORY_REASON_TEXT[key];
  if (!text) return s;
  return m ? `${text} (${m[2]})` : text;
}
const reasonsText = (codes) => (Array.isArray(codes) ? codes : []).map(v3InventoryReasonText).filter(Boolean).join("; ");

// An ISO time -> "YYYY-MM-DD HH:MM UTC" (a non-ISO string is shown as-is; never a fabricated time).
function utcMinute(v) {
  const at = typeof v === "string" && v.trim() ? v.trim() : null;
  if (!at) return null;
  const t = Date.parse(at);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC" : at;
}

/**
 * The On Hand FBA freshness/source the page shows, for the account's ONE inventory source. Returns
 * { label, tone, note|null, conflicts, source, hint }:
 *   listings        -> "Listings refreshed <YYYY-MM-DD HH:MM UTC>" (Listings has no inventory date);
 *   health-fallback -> "FBA Inventory Health snapshot <date> (saved, no longer refreshed -- temporary bridge: <reasons>)",
 *                      warn, with a note that the values come from that dated saved snapshot because this account's
 *                      Listings could not be validated;
 *   unavailable     -> "On Hand FBA unavailable" + the reasons (never 0);
 *   legacy (no inventory-source-v1 model) -> On Hand FBA Unavailable until the snapshot is refreshed.
 */
export function v3InventoryFreshness(payload) {
  const inv = (payload && payload.inventory) || null;
  if (!isInventorySourcePayload(payload)) {
    return {
      label: "On Hand FBA unavailable", tone: "warn", conflicts: 0, source: "legacy",
      hint: "On Hand FBA is unavailable for this saved snapshot (never shown as 0)",
      note: "This saved Listing Health snapshot predates the per-account inventory source, so On Hand FBA is shown as Unavailable until it is refreshed.",
    };
  }
  const conflicts = Array.isArray(inv.conflicts) ? inv.conflicts.length : 0;
  if (inv.source === "listings" && inv.available === true) {
    const when = utcMinute(inv.refreshedAt);
    return {
      label: when ? `Listings refreshed ${when}` : "Listings refresh time unavailable",
      tone: conflicts ? "warn" : "ok",
      conflicts,
      source: "listings",
      hint: "FBA available from this account's validated Listings (as of the Listings refresh time; no inventory date)",
      note: conflicts ? `${conflicts} SKU${conflicts === 1 ? " has" : "s have"} conflicting Listings rows; their On Hand FBA is Unavailable (duplicate rows are never summed).` : null,
    };
  }
  if (inv.source === "health-fallback" && inv.available === true) {
    const date = typeof inv.snapshotDate === "string" && inv.snapshotDate.trim() ? inv.snapshotDate.trim() : "(date unavailable)";
    const why = reasonsText(inv.fallbackReasons) || "Listings not validated";
    return {
      label: `FBA Inventory Health snapshot ${date} (saved, no longer refreshed — temporary bridge: ${why})`,
      tone: "warn",
      conflicts,
      source: "health-fallback",
      hint: `FBA available from the last saved FBA Inventory Health snapshot ${date} (a temporary read-only bridge; Listings not validated for this account)`,
      note: `On Hand FBA comes from the last saved FBA Inventory Health snapshot (${date}) because this account's Listings could not be validated (${why}). FBA Inventory Health is no longer refreshed: this is a temporary bridge, and stock may have changed since that date.`,
    };
  }
  const why = reasonsText(inv.unavailableReasons && inv.unavailableReasons.length ? inv.unavailableReasons : inv.fallbackReasons);
  return {
    label: "On Hand FBA unavailable",
    tone: "warn",
    conflicts,
    source: "unavailable",
    hint: "On Hand FBA unavailable for this account (never shown as 0)",
    note: `On Hand FBA is Unavailable for this account (it is never shown as 0)${why ? `: ${why}` : ""}.`,
  };
}

/**
 * Build the 16-column presentation rows from the server v3 payload. Optionally filter to a selected brand (client
 * display filter, mirroring v1). Sales/units are the server's durable-OLI numbers (never re-derived here). Returns
 * rows carrying every field the 16 columns + the Priority Actions list need, plus gate/why/recommendedAction.
 */
export function buildV3Rows(payload, selectedBrand = null) {
  const rows = payload && Array.isArray(payload.rows) ? payload.rows : [];
  const wantBrand = selectedBrand && brandKey(selectedBrand) !== "all" ? brandKey(selectedBrand) : null;
  const prov = (payload && payload.provenance) || {};
  const reportAsOf = (payload && payload.asOf) || null;
  // The evidence as-of for a row's HEALTH finding: the saved Listings/Raw snapshot's fetched_at (falling back to the
  // report as-of). Never a fabricated date and never the inventory day -- null when nothing is available.
  const evidenceAsOf = dateOnly(prov.rawFetchedAt) || dateOnly(prov.listingsFetchedAt) || reportAsOf || null;
  const evidenceStale = isEvidenceStale(evidenceAsOf, reportAsOf);
  const legacyInventory = rows.length > 0 && !isInventorySourcePayload(payload);
  const out = [];
  for (const src of rows) {
    if (wantBrand && brandKey(src.brand) !== wantBrand) continue;
    const r = legacyInventory ? withoutLegacyInventory(src) : src;
    const gate = v3GateForRow(r);
    out.push({
      ...r,
      gate,
      gateMeta: V3_GATES[gate],
      confidence: v3Confidence(r),
      evidenceSource: v3EvidenceSource(r),
      evidenceAsOf,
      evidenceStale,
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

// The exact flat export rows for the Excel download -- MUST mirror the authorized, filtered UI rows. "Amazon Listing
// Status" is the Amazon SOURCE status (Unavailable when absent -- never a derived value); "Health Finding" is the
// DERIVED finding. Sales/Units/at-Risk carry the SAME truthful durable values as before.
export function v3ExportRows(rows) {
  return (rows || []).map((r) => ({
    "Product Name": r.productName || "",
    SKU: r.sku || "",
    ASIN: r.asin || "",
    Brand: r.brand || "",
    "Amazon Listing Status": r.listingStatus || "Unavailable",
    "Health Finding": (r.gateMeta && r.gateMeta.label) || r.gate,
    Confidence: r.confidence || "",
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
    "Evidence Source": r.evidenceSource || "Unavailable",
    "Evidence As Of": r.evidenceAsOf ? (r.evidenceStale ? `${r.evidenceAsOf} (stale)` : r.evidenceAsOf) : "Unavailable",
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
