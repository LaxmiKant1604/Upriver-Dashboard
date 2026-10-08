// Advanced Listing Health -- OLI-based, window-aware derivation CORE (dormant backend foundation).
//
// This is a PURE, additive module. It is NOT wired into the live serve path, the scheduler-v2 dispatch, the
// report registry, or the frontend. The existing Listing Health (api/datadoe.js "listing-health" ->
// buildListingHealth, listing-health/v2d-1 durable shadow) is left BYTE-UNCHANGED; this module is the reviewed
// activation target for the next phase. Reasons it lives beside, not inside, the current path:
//   - Sales/units come from DURABLE Order Line Items (enriched: priced + operational overlay + estimates),
//     NOT Profit by SKU & Date -- so the NEW path has no Profit-by-SKU reachability at all.
//   - It serves ANY inclusive window (7D / 14D / 30D-default / selected calendar month / custom) by
//     RE-AGGREGATING the already-stored OLI daily history -- selecting a window creates ZERO DataDoe exports.
//   - It keeps status / issues / on-hand stock on the LATEST saved snapshots, independent of the sales window, and
//     never sums stock across dates. On-hand FBA follows the ONE per-account inventory-source decision (Listings
//     inventory CUTOVER): the account's VALIDATED Listings rows, else its LAST SAVED FBA Inventory Health snapshot as a
//     dated read-only temporary bridge (only while it is within HEALTH_BRIDGE_MAX_AGE_DAYS of the report as-of; no
//     Health export -- and no listing-health-v3:inventory fragment -- exists any more), else Unavailable -- never a mix
//     of the two inside one account.
//
// Reuse (never reinvent): the enriched OLI merge output shape (mergeOrderedOliHistory); the coverage-window
// union (source-durable-model.mergeCoverageWindows); the completeness summary (oli-completeness-serve); the
// existing Listing Health folds/guards (derivation-core); the shared inventory-source consumer glue
// (inventory-consumer.js); and numOrNull for honest unknown-vs-zero values.

import {
  num,
  salesMoversBrandLabel,
  salesMoversCatalogFold,
  listingHealthRawFold,
  assertListingHealthCurrencyIsolation,
} from "./derivation-core.js";
import { addDaysStr, monthStartStr, daysInMonthUTC } from "../date-windows.js";
import { mergeCoverageWindows } from "../sync/source-durable-model.js";
import { summarizeCompleteness } from "./oli-completeness-serve.js";
import {
  HEALTH_BRIDGE_MAX_AGE_DAYS,
  INVENTORY_SOURCE_MODEL,
  INVENTORY_SOURCE_HEALTH_FALLBACK,
  INVENTORY_SOURCE_LISTINGS,
  INVENTORY_SOURCE_UNAVAILABLE,
  asinForSkuFrom,
  selectConsumerInventory,
} from "./inventory-consumer.js";
import { listingsAsin } from "../listings-inventory.js";

export const LISTING_HEALTH_ADVANCED_VERSION = "listing-health/v3-oli-window";
export const LISTING_HEALTH_ADVANCED_SALES_SOURCE = "order-line-items";
export const LISTING_HEALTH_DEFAULT_WINDOW_DAYS = 30;

const S = (v) => (v == null ? "" : String(v));

// A nullable numeric read (byte-identical to datadoe.numOrNull), inlined so this pure module never imports the
// DataDoe transport: null/undefined/blank/malformed/non-finite -> null (UNKNOWN); a finite number -> that number
// (a genuine 0 is preserved, never coerced away).
function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Dependency-free calendar-date check (avoids importing the large source-contracts module and any cycle).
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isCalendarDate(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function daysInclusive(from, to) {
  return Math.floor((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86400000) + 1;
}

// A validated SELECTED calendar month (any month, incl. previous months and leap February). A full month resolves
// to [first, lastDay]; the CURRENT month (last day > asOf) is clamped to month-to-date [first, asOf]; a wholly
// future month is rejected. Leap February is handled by daysInMonthUTC.
function resolveMonthWindow(month, asOf) {
  const mm = /^(\d{4})-(\d{2})$/.exec(S(month).trim());
  if (!mm) throw new Error("Listing Health MONTH requires a YYYY-MM month.");
  const y = Number(mm[1]); const mo = Number(mm[2]);
  if (!(mo >= 1 && mo <= 12)) throw new Error("Listing Health MONTH has an invalid month number.");
  const first = `${mm[1]}-${mm[2]}-01`;
  const last = `${mm[1]}-${mm[2]}-${String(daysInMonthUTC(y, mo)).padStart(2, "0")}`;
  if (!isCalendarDate(first) || !isCalendarDate(last)) throw new Error("Listing Health MONTH produced an invalid range.");
  if (first > asOf) throw new Error("Listing Health MONTH cannot be a future month.");
  const to = last <= asOf ? last : asOf; // clamp the current month to month-to-date
  return { kind: "MONTH", month: `${mm[1]}-${mm[2]}`, from: first, to, days: daysInclusive(first, to) };
}

/**
 * Resolve an INCLUSIVE [from, to] sales window from a control choice. Never silently widens/shortens.
 *   - preset OMITTED (null/undefined/"") -> the documented 30D DEFAULT (only omission uses the default);
 *   - "7D"|"14D"|"30D" -> [asOf-(n-1), asOf];
 *   - "MONTH" (optional `month` YYYY-MM) -> a validated selected calendar month (default: current month-to-date);
 *   - "CUSTOM" -> [from, to] (both real dates, from<=to, to<=asOf);
 *   - any other, explicitly-provided preset -> THROWS (an explicitly invalid preset is never coerced).
 */
export function resolveListingHealthWindow({ preset = null, from = null, to = null, month = null, asOf } = {}) {
  if (!isCalendarDate(asOf)) throw new Error("resolveListingHealthWindow requires a real calendar asOf.");
  const provided = preset != null && S(preset).trim() !== "";
  if (!provided) {
    return { kind: "30D", from: addDaysStr(asOf, -(LISTING_HEALTH_DEFAULT_WINDOW_DAYS - 1)), to: asOf, days: LISTING_HEALTH_DEFAULT_WINDOW_DAYS };
  }
  const key = S(preset).trim().toUpperCase();
  const presetDays = { "7D": 7, "14D": 14, "30D": 30 };
  if (key in presetDays) {
    const days = presetDays[key];
    return { kind: key, from: addDaysStr(asOf, -(days - 1)), to: asOf, days };
  }
  if (key === "MONTH") {
    // Omitted month -> current month-to-date; a supplied month -> the validated selected calendar month.
    return resolveMonthWindow(month != null && S(month).trim() !== "" ? month : monthStartStr(asOf).slice(0, 7), asOf);
  }
  if (key === "CUSTOM") {
    if (!isCalendarDate(from) || !isCalendarDate(to)) throw new Error("Custom Listing Health window requires two real calendar dates.");
    if (from > to) throw new Error("Custom Listing Health window requires from <= to.");
    if (to > asOf) throw new Error("Custom Listing Health window cannot end after the report asOf.");
    return { kind: "CUSTOM", from, to, days: daysInclusive(from, to) };
  }
  throw new Error(`Listing Health window preset "${preset}" is not one of 7D/14D/30D/MONTH/CUSTOM (explicitly invalid).`);
}

// The uncovered sub-intervals of [from, to] given MERGED (sorted, disjoint, non-adjacent) coverage windows.
// Reports every genuine gap -- leading, interior and trailing -- and never bridges one.
function computeCoverageGaps(merged, from, to) {
  const gaps = [];
  let cursor = from; // the next day we still need covered
  for (const w of merged) {
    if (w.to < cursor) continue;      // entirely before what we still need
    if (w.from > to) break;           // beyond the request
    if (w.from > cursor) gaps.push({ from: cursor, to: addDaysStr(w.from, -1) > to ? to : addDaysStr(w.from, -1) });
    const advanceTo = w.to >= to ? to : w.to;
    if (addDaysStr(advanceTo, 1) > cursor) cursor = addDaysStr(advanceTo, 1);
    if (cursor > to) break;
  }
  if (cursor <= to) gaps.push({ from: cursor, to }); // trailing gap
  return gaps;
}

/**
 * Assess durable-OLI coverage of a REQUESTED [from, to]. Coverage windows are UNIONED (overlapping/adjacent
 * intervals merged via the shared mergeCoverageWindows) so a split-but-contiguous history is not reported as a
 * gap; genuine gaps (leading/interior/trailing) are reported and never bridged. Malformed coverage evidence
 * fails CLOSED (treated as uncovered), never as false coverage. Returns { complete, gaps[], coveredFrom,
 * coveredTo, gapFrom, gapTo, requestedFrom, requestedTo }.
 */
export function assessOliCoverage({ oliCoverageWindows = [], from, to } = {}) {
  const empty = { requestedFrom: from, requestedTo: to, coveredFrom: null, coveredTo: null, complete: false, gaps: [{ from, to }], gapFrom: from, gapTo: to };
  if (!isCalendarDate(from) || !isCalendarDate(to) || from > to) return empty;
  let merged;
  try { merged = mergeCoverageWindows(Array.isArray(oliCoverageWindows) ? oliCoverageWindows : []); }
  catch (_e) { return empty; } // malformed coverage -> fail closed (uncovered)
  const gaps = computeCoverageGaps(merged, from, to);
  const complete = gaps.length === 0;
  const containing = merged.find((w) => w.from <= from && w.to >= from) || null; // covers the requested start?
  const coveredFrom = containing ? from : null;
  const coveredTo = containing ? (containing.to < to ? containing.to : to) : null;
  return {
    requestedFrom: from, requestedTo: to,
    coveredFrom, coveredTo, complete, gaps,
    gapFrom: gaps.length ? gaps[0].from : null,
    gapTo: gaps.length ? gaps[0].to : null,
  };
}

/**
 * Fold ENRICHED OLI rows (already single-account) to per-SKU window sales/units. Rows are the output of
 * mergeOrderedOliHistory: sales_amount = actual priced + internal estimate; units = ordered (priced + operational
 * overlay); unpriced_units = overlay not covered by an estimate. INCLUSIVE date filter [from,to]. Currency is
 * carried per SKU and NEVER summed across currencies (isolation is asserted separately, fail-closed). A blank
 * SKU is skipped. Returns { salesBySku, currencies }.
 */
export function foldOliWindowSales(enrichedRows, { from, to } = {}) {
  const salesBySku = new Map();
  const currencies = new Set();
  for (const r of Array.isArray(enrichedRows) ? enrichedRows : []) {
    const date = S(r.sale_date ?? r.saleDate);
    if (!isCalendarDate(date) || date < from || date > to) continue; // window is inclusive; never sum outside it
    const sku = S(r.sku).trim();
    if (!sku) continue;
    const currency = S(r.currency).trim() || null;
    if (currency) currencies.add(currency);
    const cur = salesBySku.get(sku) || { sales: 0, units: 0, unpricedUnits: 0, currency };
    cur.sales += num(r.sales_amount ?? r.salesAmount);
    cur.units += num(r.ordered_units ?? r.orderedUnits ?? r.units);
    cur.unpricedUnits += num(r.unpriced_units ?? r.unpricedUnits);
    if (!cur.currency && currency) cur.currency = currency;
    salesBySku.set(sku, cur);
  }
  return { salesBySku, currencies };
}

// The per-row On Hand FBA source tag for each account-level inventory source (null when the value is unknown). The
// "fba-health-fallback" tag is kept for payload compatibility; it now means the dated saved Health BRIDGE.
export const ON_HAND_FBA_SOURCE = Object.freeze({
  [INVENTORY_SOURCE_LISTINGS]: "listings",
  [INVENTORY_SOURCE_HEALTH_FALLBACK]: "fba-health-fallback",
});

/**
 * The account's ONE On Hand FBA source decision (Listings inventory CUTOVER), over the shared consumer glue
 * (inventory-consumer.js selectConsumerInventory -> lib/server/inventory-source.js selectAccountInventory):
 *   - "listings"        : the account's Listings rows are VALIDATED inventory evidence (expanded fields, no unresolved
 *                         duplicate conflict, no unattributed stock, no blank FBA field, no foreign rows). Duplicate
 *                         identical listing rows of one SKU count ONCE; a still-conflicting SKU is unknown (null).
 *   - "health-fallback" : Listings is not validated (reasons listed) and the account's LAST SAVED FBA Inventory Health
 *                         snapshot (`inventoryRows`, read-only -- the bridge) is no older than asOf -
 *                         HEALTH_BRIDGE_MAX_AGE_DAYS: its LATEST date only (never summed across dates), labelled with
 *                         that date as a saved, no-longer-refreshed temporary bridge.
 *   - "unavailable"     : neither (or the bridge is stale / there is no asOf) -- every On Hand FBA is unknown (null),
 *                         never 0.
 * The two sources are never mixed inside one account. `asinForSku` is the account's own unambiguous SKU -> ASIN map
 * (from its OLI rows) used ONLY to resolve a missing / conflicting Listings ASIN.
 */
export function listingHealthInventorySelection({ listingRows = [], inventoryRows = [], marketplace = "", asinForSku = null, listingsRefreshedAt = null, asOf = null, inventoryUnavailableReason = null } = {}) {
  const healthRows = Array.isArray(inventoryRows) ? inventoryRows : [];
  return selectConsumerInventory({
    listingsRows: Array.isArray(listingRows) ? listingRows : [],
    healthRows,
    marketplace: canonMarketplace(marketplace),
    awdEligible: false, // Listing Health shows no AWD figure
    asinForSku,
    listingsRefreshedAt: listingsRefreshedAt || null,
    healthUnavailableReason: healthRows.length ? null : (S(inventoryUnavailableReason).trim() || "health-snapshot-missing"),
    asOf,
  });
}

// Deterministic flag evidence. CONFIRMED = Amazon's own facts; POSSIBLE = heuristics that alone do not prove a
// cause (an Inactive status is POSSIBLE, never confirmed). No cause invented; no blocking DATE asserted.
function flagEvidence({ statusActive, buyable, discoverable, liveOffer, priceMissingWhileActive, errorIssue, strandedStock }) {
  const reasons = [];
  if (errorIssue) reasons.push({ code: "amazon_issue_error", confidence: "confirmed", detail: "Amazon reported an ERROR-severity listing issue." });
  if (buyable === false) reasons.push({ code: "not_buyable", confidence: "confirmed", detail: "Amazon summaries report the listing as not Buyable." });
  if (discoverable === false) reasons.push({ code: "not_discoverable", confidence: "confirmed", detail: "Amazon summaries report the listing as not Discoverable." });
  if (liveOffer === false) reasons.push({ code: "no_live_offer", confidence: "confirmed", detail: "No live, priced offer is present." });
  if (priceMissingWhileActive) reasons.push({ code: "no_price_while_active", confidence: "confirmed", detail: "Listing is Active but carries no price." });
  if (!statusActive) reasons.push({ code: "status_not_active", confidence: "possible", detail: "Listing status is not Active; this alone does not prove the cause." });
  if (strandedStock) reasons.push({ code: "stranded_stock", confidence: "possible", detail: "On-hand stock exists while the listing is not Active." });
  return reasons;
}

// TRUSTED PROJECTION BOUNDARY (defensive, fail-closed): every row that CARRIES account evidence must match the
// trusted owner. A row without account evidence is assumed already projected to this owner by the caller (via the
// batched-source owner isolation, isolateFragmentRowsForOwner). This module never attributes a row by SKU/ASIN.
// NOTE: this is a same-account row guard only -- brand-scope and capability AUTHORIZATION are enforced by the
// api/report-authorization integration layer, which this dormant module does not replace.
function assertRowsOwnedBy(rows, owner, label) {
  // Canonical owner marketplace (mirrors source-account-isolation MARKETPLACE_COLUMN = "marketplace_country_code",
  // uppercase-trim compare). Enforced ONLY when the owner carries a nonblank marketplace (fail-open otherwise, exactly
  // like the account/seller axes -- a row without ownership evidence is assumed already projected by the ingestion
  // isolate boundary). Currency is deliberately NOT an ownership axis here: listing_price_currency is legitimately
  // blank on many rows and cross-currency merges are already fail-closed by assertListingHealthCurrencyIsolation.
  const ownerMkt = canonMarketplace(owner.marketplace);
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r !== "object" || Array.isArray(r)) continue;
    const acct = S(r.account_id ?? r.accountId);
    if (acct && acct !== S(owner.accountId)) throw new Error(`Listing Health ${label}: row account_id "${acct}" != trusted owner "${owner.accountId}" (cross-account; fail closed).`);
    const seller = S(r.seller_or_vendor_id ?? r.sellerOrVendorId);
    if (seller && seller !== S(owner.rawSellerId)) throw new Error(`Listing Health ${label}: row seller "${seller}" != trusted owner "${owner.rawSellerId}" (cross-account; fail closed).`);
    // Marketplace isolation (defence-in-depth): never silently merge rows from different marketplaces.
    const rowMkt = canonMarketplace(r.marketplace_country_code ?? r.marketplaceCountryCode);
    if (rowMkt && ownerMkt && rowMkt !== ownerMkt) throw new Error(`Listing Health ${label}: row marketplace "${rowMkt}" != trusted owner marketplace "${ownerMkt}" (cross-marketplace; fail closed).`);
  }
}

// Canonical marketplace for the ownership compare: uppercase-trimmed, with the ONLY known account-directory-vs-row
// divergence folded (the account directory may call the UK marketplace "UK" while row marketplace_country_code uses
// "GB"). Folding UK->GB prevents a legitimate GB/UK account from being wrongly rejected. Blank stays blank (fail-open).
function canonMarketplace(v) {
  const s = S(v).trim().toUpperCase();
  return s === "UK" ? "GB" : s;
}

// Window-SCOPED completeness: filter completeness evidence to the requested [from,to] and mark the window
// provisional if ANY in-window day is provisional (never "final" just because the latest day is final) OR if the
// window is not fully covered. Reuses summarizeCompleteness for the rich fields but overrides the window verdict.
function windowCompleteness(rows, from, to, coverageComplete) {
  const inWin = (Array.isArray(rows) ? rows : []).filter((r) => r && isCalendarDate(S(r.sale_date)) && S(r.sale_date) >= from && S(r.sale_date) <= to);
  const anyDefect = inWin.some((r) => r.completeness_status === "source-defect");
  const anyProvisional = inWin.some((r) => r.completeness_status === "provisional");
  const base = summarizeCompleteness(inWin); // null when no in-window rows
  const provisional = anyProvisional || !coverageComplete;
  const status = anyDefect ? "source-defect" : (anyProvisional ? "provisional" : (coverageComplete ? (base ? base.status : "final") : "provisional"));
  if (!base) {
    return { status: coverageComplete ? null : "provisional", provisional, sourceDefect: anyDefect, latestDate: null, windowScoped: true, coverageComplete };
  }
  return { ...base, status, provisional, sourceDefect: anyDefect, windowScoped: true, coverageComplete };
}

/**
 * Build the advanced Listing Health payload for ONE account and ONE window from durable + snapshot evidence.
 * PURE (no I/O). `owner` = the TRUSTED {accountId, rawSellerId} projection boundary (required, fail-closed).
 * `window` OMITTED uses the 30D default; a SUPPLIED window is validated (reversed / future / malformed => throw).
 * Provides everything the agreed 16 columns and future deterministic diagnostics need, with provenance. Does NOT
 * compute the visual "Gate" label -- it exposes deterministic `flagged`/`flagReasons` (confirmed/possible).
 *
 * Inventory: FBA on-hand follows ONE per-account source (listingHealthInventorySelection): the VALIDATED Listings
 * per-SKU fba_quantity_available, else the account's last SAVED FBA Inventory Health snapshot (`inventoryRows` -- the
 * dated read-only bridge, only while within HEALTH_BRIDGE_MAX_AGE_DAYS of `asOf`), else Unavailable.
 * A genuine 0 is kept; unknown (blank, conflicting duplicate, SKU absent from the selected source) is `null` =
 * UNAVAILABLE, never 0, and never filled from the other source. payload.inventory carries the model, source, label,
 * the Health snapshot date (fallback only -- Listings has no date), the Listings refresh time (Listings only), the
 * fallback / unavailable reasons and the Listings fold's unresolved conflicts. The non-applicable channel's on-hand is
 * `null`, applicable=false -- except that a merchant-fulfilled (DEFAULT) listing with PROVEN positive FBA stock keeps
 * it visible (never blanket-exclude DEFAULT). Latest status/stock/issues are independent of the selected sales window.
 */
export function buildAdvancedListingHealth({
  owner, asOf, window,
  enrichedOliRows = [], oliCoverageWindows = [], completenessRows = [],
  listingRows = [], inventoryRows = [], catalogRows = [], rawRows = [],
  issuesAvailable = false, issuesUnavailableReason = null,
  inventoryUnavailableReason = null,
  provenance = {},
} = {}) {
  if (!isCalendarDate(asOf)) throw new Error("buildAdvancedListingHealth requires a real calendar asOf.");
  if (!owner || typeof owner !== "object" || S(owner.rawSellerId).trim() === "" || S(owner.accountId).trim() === "") {
    throw new Error("buildAdvancedListingHealth requires a trusted owner { accountId, rawSellerId } (projection boundary; fail closed).");
  }
  // Window: only an OMITTED control uses the default; a supplied window is validated strictly.
  let win;
  if (window == null) {
    win = resolveListingHealthWindow({ preset: "30D", asOf });
  } else {
    if (!isCalendarDate(window.from) || !isCalendarDate(window.to)) throw new Error("buildAdvancedListingHealth: supplied window must carry real from/to calendar dates.");
    if (window.from > window.to) throw new Error("buildAdvancedListingHealth: supplied window is reversed (from > to).");
    if (window.to > asOf) throw new Error("buildAdvancedListingHealth: supplied window ends after asOf (future endpoint).");
    win = window;
  }

  // TRUSTED PROJECTION BOUNDARY: reject any cross-account row before deriving (identical SKU/ASIN across accounts
  // can never leak). Catalog is organization-wide by contract and carries no seller, so it is not seller-guarded.
  assertRowsOwnedBy(enrichedOliRows, owner, "OLI");
  assertRowsOwnedBy(listingRows, owner, "listings");
  assertRowsOwnedBy(inventoryRows, owner, "inventory");
  assertRowsOwnedBy(rawRows, owner, "listings-raw");

  const windowedOli = (Array.isArray(enrichedOliRows) ? enrichedOliRows : []).filter((r) => {
    const d = S(r.sale_date ?? r.saleDate);
    return isCalendarDate(d) && d >= win.from && d <= win.to;
  });
  // Currency isolation BEFORE folding money (reuse the established fail-closed guard).
  assertListingHealthCurrencyIsolation(listingRows, windowedOli);

  const { salesBySku, currencies } = foldOliWindowSales(windowedOli, { from: win.from, to: win.to });
  // ONE per-account On Hand FBA source (validated Listings -> the dated saved Health bridge within its threshold of the
  // report as-of -> Unavailable). The SKU -> ASIN resolver uses ONLY this account's own (owner-asserted) OLI rows.
  const inv = listingHealthInventorySelection({
    listingRows, inventoryRows, marketplace: owner.marketplace,
    asinForSku: asinForSkuFrom(enrichedOliRows), listingsRefreshedAt: provenance.listingsFetchedAt || null,
    asOf, inventoryUnavailableReason,
  });
  const onHandFbaSourceTag = ON_HAND_FBA_SOURCE[inv.source] || null;
  const catalog = salesMoversCatalogFold(catalogRows);
  const rawBySku = issuesAvailable ? listingHealthRawFold(rawRows) : new Map();
  const coverage = assessOliCoverage({ oliCoverageWindows, from: win.from, to: win.to });

  // Honest sales-window status: proven coverage vs partial vs unavailable (a 0 in a non-covered window is NOT a
  // proven zero). Derived from the genuine gap days (never from a single containing window).
  const totalDays = daysInclusive(win.from, win.to);
  const gapDays = (coverage.gaps || []).reduce((s, g) => s + daysInclusive(g.from, g.to), 0);
  const salesWindowStatus = gapDays <= 0 ? "covered" : (gapDays >= totalDays ? "unavailable" : "partial");
  const completeness = windowCompleteness(completenessRows, win.from, win.to, coverage.complete);

  const rows = [];
  for (const listing of Array.isArray(listingRows) ? listingRows : []) {
    const sku = S(listing.sku).trim();
    const asin = listingsAsin(listing.child_asin); // DataDoe's "__EMPTY__" placeholder is a missing ASIN (shown blank)
    if (!sku && !asin) continue;
    const meta = catalog.byAsin.get(asin) || {};
    const sales = salesBySku.get(sku) || null;
    const stock = sku ? inv.skus.get(sku) || null : null;
    const raw = rawBySku.get(sku) || null;

    const channelRaw = S(listing.listing_fulfillment_channel).trim().toUpperCase();
    const channel = channelRaw ? (channelRaw === "DEFAULT" ? "FBM" : "FBA") : null;
    const channelKnown = channel !== null;

    // FBA on-hand: the SELECTED source's per-SKU value (incl. a genuine 0), or null (UNAVAILABLE) when unknown, a
    // conflicting duplicate, merchant-fulfilled-only, or absent from that source. Never filled from the other source.
    const onHandFba = stock && stock.fbaAvailable !== undefined ? stock.fbaAvailable : null;
    const onHandFbaSource = onHandFba !== null ? onHandFbaSourceTag : null;
    const inventoryConflict = !!(stock && stock.conflict);
    // FBM on-hand from the Listings current quantity (unknown-preserving).
    const onHandFbm = numOrNull(listing.listing_current_quantity);

    // The OTHER channel is "not applicable". Unknown channel -> both applicable (values may still be unavailable).
    // A merchant-fulfilled (DEFAULT) listing that still holds PROVEN positive FBA stock keeps it visible (owner rule:
    // never blanket-exclude DEFAULT; a merchant-fulfilled zero is simply not applicable, never an FBA stockout).
    const channelFbaApplicable = !channelKnown || channel === "FBA";
    const fbaApplicable = channelFbaApplicable || (onHandFba !== null && onHandFba > 0);
    const fbmApplicable = !channelKnown || channel === "FBM";

    const statusRaw = S(listing.listing_status).trim();
    const statusActive = statusRaw.toUpperCase() === "ACTIVE";
    // Price is UNKNOWN-preserving: null/blank/malformed -> null (UNAVAILABLE), a finite number (incl. a genuine 0) ->
    // that number. numOrNull (not num) so a BLANK price is never coerced to 0 and mistaken for a confirmed zero price.
    const priceVal = numOrNull(listing.listing_price_value);
    const buyable = raw && raw.summary ? raw.summary.buyable : null;
    const discoverable = raw && raw.summary ? raw.summary.discoverable : null;
    const liveOffer = raw ? raw.hasLiveOffer : null;
    const issues = raw ? raw.issues : [];
    const errorIssue = Array.isArray(issues) && issues.some((i) => S(i.severity).toUpperCase() === "ERROR");

    // Stranded-stock gate: the on-hand of the listing's OWN channel (unchanged channel rule).
    const applicableOnHand = channelFbaApplicable ? onHandFba : onHandFbm;
    const strandedStock = applicableOnHand !== null && applicableOnHand > 0 && statusRaw !== "" && !statusActive;
    const flagReasons = flagEvidence({
      statusActive: statusActive || statusRaw === "", // an unknown status is not itself a flag
      buyable, discoverable, liveOffer,
      // "No price" is a CONFIRMED finding ONLY from explicit evidence: an Active listing whose price is an explicit
      // invalid value (0). A null/blank/unavailable price is UNKNOWN evidence -> NEVER a negative finding (the row's
      // price simply shows Unavailable). This distinguishes "confirmed missing/invalid price" from "price unavailable".
      priceMissingWhileActive: statusActive && priceVal === 0,
      errorIssue, strandedStock,
    });
    const flagged = flagReasons.length > 0;
    const windowSales = sales ? sales.sales : 0;

    rows.push({
      sku: sku || null,
      asin: asin || null,
      productName: meta.name || S(listing.listing_name).trim() || null,
      brand: salesMoversBrandLabel(meta.brand),
      listingStatus: statusRaw || null,
      channel,
      channelRaw: channelRaw || null,
      price: priceVal,
      currency: S(listing.listing_price_currency).trim() || (sales ? sales.currency : null) || null,
      // On-hand, split by channel; null = unavailable, number (incl. 0) = known. `*Applicable:false` => "Not applicable".
      onHandFba: fbaApplicable ? onHandFba : null,
      onHandFbaApplicable: fbaApplicable,
      onHandFbaSource: fbaApplicable ? onHandFbaSource : null,
      // True when this SKU's Listings rows conflict (Listings source only: duplicates that disagree / an invalid
      // quantity): on-hand FBA is Unavailable for it and the SKU is listed in inventory.conflicts.
      inventoryConflict,
      onHandFbm: fbmApplicable ? onHandFbm : null,
      onHandFbmApplicable: fbmApplicable,
      // Window sales/units from durable enriched OLI (actual priced + estimate; ordered units). No profit, no refunds.
      sales: windowSales,
      units: sales ? sales.units : 0,
      unpricedUnits: sales ? sales.unpricedUnits : 0,
      hasSalesData: Boolean(sales),
      // Whether this SKU's window sales are a fully-covered proven total. When false, a 0 is UNKNOWN, not proven zero.
      salesCovered: coverage.complete,
      // Selected-period historical sales EXPOSURE for a currently-flagged listing. NOT proven lost revenue and NOT
      // proof the listing was blocked during the window -- it is the window's sales for a listing flagged NOW.
      salesAtRisk: flagged ? windowSales : 0,
      openDate: listing.listing_open_date || null,
      buyable, discoverable, liveOffer,
      issues,
      flagged,
      flagReasons,
    });
  }

  return {
    accountId: S(owner.accountId),
    // The trusted owner marketplace (CANONICAL: uppercase + UK->GB, matching row marketplace_country_code) so
    // consumers (the page, the Priority Feed alert) can show it and never merge marketplaces. Null when unresolved.
    marketplace: canonMarketplace(owner.marketplace) || null,
    asOf,
    salesSource: LISTING_HEALTH_ADVANCED_SALES_SOURCE,
    window: { kind: win.kind, from: win.from, to: win.to, days: win.days, ...(win.month ? { month: win.month } : {}) },
    // Honest coverage + a single sales-window verdict: covered (proven) / partial / unavailable.
    coverage,
    salesWindowStatus,
    completeness,
    // On Hand FBA source (model inventory-source-v1; a payload without it predates phase 2 and is never served as
    // current). snapshotDate is the saved FBA Inventory Health BRIDGE date ONLY when the bridge is the source (Listings
    // has no date); refreshedAt is the Listings fetch time ONLY when Listings is the source. bridgeMaxAgeDays = how old
    // the saved bridge may be (vs asOf) before inventory turns Unavailable (FBA Inventory Health is no longer refreshed).
    inventory: {
      model: INVENTORY_SOURCE_MODEL,
      source: inv.source,
      label: inv.label,
      available: inv.source !== INVENTORY_SOURCE_UNAVAILABLE,
      bridgeMaxAgeDays: HEALTH_BRIDGE_MAX_AGE_DAYS,
      snapshotDate: inv.source === INVENTORY_SOURCE_HEALTH_FALLBACK ? (inv.healthDate || null) : null,
      refreshedAt: inv.source === INVENTORY_SOURCE_LISTINGS ? (inv.listingsRefreshedAt || null) : null,
      fallbackReasons: inv.source === INVENTORY_SOURCE_LISTINGS ? [] : [...(inv.listingsReasons || [])],
      unavailableReasons: [...(inv.unavailableReasons || [])],
      conflicts: inv.conflicts || [],
      resolvedConflicts: inv.source === INVENTORY_SOURCE_LISTINGS ? (inv.resolvedConflicts || []) : [],
    },
    issuesAvailable,
    issuesUnavailableReason,
    provenance: {
      // *FetchedAt = the truer EFFECTIVE/as-of date (the source batch's real download time); *SavedAt = the
      // materialization time; *SourceType = the fragment's source id -- so every fragment records source type, saved
      // time, effective date, and (via the client stale marker) freshness. Null when the dimension is Unavailable.
      listingsFetchedAt: provenance.listingsFetchedAt || null,
      inventoryFetchedAt: provenance.inventoryFetchedAt || null,
      rawFetchedAt: provenance.rawFetchedAt || null,
      catalogFetchedAt: provenance.catalogFetchedAt || null,
      listingsSavedAt: provenance.listingsSavedAt || null,
      inventorySavedAt: provenance.inventorySavedAt || null,
      rawSavedAt: provenance.rawSavedAt || null,
      listingsSourceType: provenance.listingsSourceType || null,
      inventorySourceType: provenance.inventorySourceType || null,
      rawSourceType: provenance.rawSourceType || null,
      // The saved FBA Inventory Health bridge date ONLY when the bridge is this account's source.
      inventorySnapshotDate: inv.source === INVENTORY_SOURCE_HEALTH_FALLBACK ? (inv.healthDate || null) : null,
      oliCoveredTo: coverage.coveredTo,
    },
    currencies: [...currencies].sort(),
    listingCount: (Array.isArray(listingRows) ? listingRows : []).length,
    rows,
    catalogBrands: catalog.catalogBrands,
  };
}
