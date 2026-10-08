// FBA Shipment Plan -- PURE planning helpers. No DataDoe, no I/O, no React. Every value is derived from already-saved
// evidence (the fba-plan snapshot rows) plus the seller's durable planning settings + seller-warehouse quantity, so a
// settings/warehouse change re-computes here with ZERO DataDoe. Missing evidence stays `null` (Unavailable) and is
// NEVER coerced to a fabricated 0; no output is ever Infinity/NaN/negative.
//
// ==================================== LISTINGS INVENTORY MODEL (documented) ====================================
// Since the Listings inventory cutover (2026-10) the FBA figures use ONE Listings-model shape. Per account the server
// picks the VALIDATED canonical DataDoe Listings snapshot, else the account's LAST SAVED FBA Inventory Health snapshot as
// a clearly labelled READ-ONLY bridge (no Health export refreshes it; used only while its date is within 2 days of the
// plan's inventory as-of: available; inbound = working + shipped + received; reserved / FC transfer unavailable), else
// Unavailable (payload.inventorySource; adaptFbaPlanPayload below also maps a pre-phase-2 saved Health plan onto the same
// shape). AWD (owner decision 2026-10-08): on an AWD marketplace a BLANK Listings AWD cell is ASSUMED 0 (rows flagged
// awdAssumedZero, counted in awdAssumedZeroSkus -- never shown as verified); on a non-AWD marketplace AWD contributes 0
// and is displayed "N/A". Listings is a CURRENT per-listing snapshot with NO date; the server fold
// (lib/server/listings-inventory.js) deduplicates listing rows per SKU and never sums duplicates. Per ASIN:
//   immediatelyAvailable = fba_quantity_available        (sellable now)
//   fbaInbound           = fba_quantity_inbound          (en route to FBA; Listings reports ONE total for all inbound
//                                                         states -- the working/shipped/received split is not available)
//   fbaReservedTotal     = fba_quantity_reserved         DISPLAY ONLY -- never supply (contains customer orders)
//   fbaFcTransfer        = fba_quantity_fc_transfer      DISPLAY ONLY -- not counted in supply until its non-overlap with
//                                                         the other buckets is proven beyond the five-seller canary
//   fbaSupply            = immediatelyAvailable + fbaInbound                          (FBA only; NO AWD)
//   awdAvailable         = awd_available_distributable_quantity  (distributable AWD; counts as usable supply)
//   awdInbound           = awd_total_inbound_quantity            (inbound TO AWD; DISPLAY ONLY)
//   amazonNetworkPosition= fbaSupply + awdAvailable (AWD only where validated for an AWD marketplace)
//   totalNetworkPosition = amazonNetworkPosition + sellerWarehouseQty
// Every dependent figure is null (Unavailable) when any input is unknown -- never a fabricated 0. Planning supply (what
// reduces the restock shortage) = amazonNetworkPosition; the seller warehouse is applied afterward in the
// ship-from-warehouse / production split. Every UI number, both Totals rows, the export and planning derive from THIS
// one model.

const N = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const num0 = (v) => { const n = N(v); return n == null ? 0 : n; };
const clampNonNeg = (v) => (v == null ? null : Math.max(0, v));

export const SYSTEM_DEFAULT_HORIZON = Object.freeze({ kind: "months", months: 2 });
export const FORECAST_METHODS = Object.freeze(["three-month", "mtd", "higher", "weighted"]);
export const DEFAULT_FORECAST_METHOD = "higher";
export const DEFAULT_SAFETY_DAYS = 14;
export const MIN_CUSTOM_DAYS = 1;
export const MAX_CUSTOM_DAYS = 365;

// ---- date helpers (UTC, calendar-aware) ---------------------------------------------------------------------
const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
export function addDaysStr(dateStr, n) {
  if (!isDate(dateStr)) return null;
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + Number(n || 0));
  return d.toISOString().slice(0, 10);
}
// Add whole calendar MONTHS, clamping the day to the target month's last day (e.g. Jan 31 + 1mo -> Feb 28/29).
export function addMonthsStr(dateStr, months) {
  if (!isDate(dateStr)) return null;
  const d = new Date(dateStr + "T00:00:00Z");
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + Number(months || 0));
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString().slice(0, 10);
}
export function daysBetween(fromStr, toStr) {
  if (!isDate(fromStr) || !isDate(toStr)) return null;
  return Math.round((new Date(toStr + "T00:00:00Z") - new Date(fromStr + "T00:00:00Z")) / 86400000);
}
export function daysInMonthOf(dateStr) {
  if (!isDate(dateStr)) return null;
  const d = new Date(dateStr + "T00:00:00Z");
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

// ---- planning-horizon settings ------------------------------------------------------------------------------
// A horizon is { kind:'months', months:1|2|3 } or { kind:'days', days:1..365 }. Invalid input -> null (caller falls back).
export function normalizeHorizon(h) {
  if (!h || typeof h !== "object") return null;
  if (h.kind === "months") {
    const m = Number(h.months);
    return [1, 2, 3].includes(m) ? { kind: "months", months: m } : null;
  }
  if (h.kind === "days") {
    const d = Number(h.days);
    // Custom horizon is a WHOLE number of days in [1, 365]; a fractional value is rejected (not truncated).
    return Number.isInteger(d) && d >= MIN_CUSTOM_DAYS && d <= MAX_CUSTOM_DAYS ? { kind: "days", days: d } : null;
  }
  return null;
}
// Resolution order: SKU override -> account default -> system default. Returns { horizon, source }.
export function resolveHorizon({ skuOverride = null, accountDefault = null } = {}) {
  const sku = normalizeHorizon(skuOverride);
  if (sku) return { horizon: sku, source: "sku" };
  const acct = normalizeHorizon(accountDefault);
  if (acct) return { horizon: acct, source: "account" };
  return { horizon: { ...SYSTEM_DEFAULT_HORIZON }, source: "system" };
}
// Calendar-aware window from the report's proven effectiveAsOf. Presets use REAL month boundaries; custom uses the
// exact day count. Projection starts the day AFTER effectiveAsOf (the first not-yet-observed day).
export function horizonWindow(effectiveAsOf, horizon) {
  const h = normalizeHorizon(horizon) || { ...SYSTEM_DEFAULT_HORIZON };
  if (!isDate(effectiveAsOf)) return { start: null, end: null, effectiveHorizonDays: null, horizon: h };
  const start = addDaysStr(effectiveAsOf, 1);
  const end = h.kind === "months" ? addMonthsStr(effectiveAsOf, h.months) : addDaysStr(effectiveAsOf, h.days);
  const effectiveHorizonDays = daysBetween(effectiveAsOf, end); // inclusive span from asOf to end
  return { start, end, effectiveHorizonDays, horizon: h };
}

// ---- forecast --------------------------------------------------------------------------------------------------
// Weights (percent) for [m1, m2, m3, mtdProjected]. Valid only when every weight is a finite >=0 number and they sum
// to EXACTLY 100. Returns { valid, sum, weights } (weights echoed as numbers).
export function validateWeights(weights) {
  const w = Array.isArray(weights) ? weights.map((x) => N(x)) : null;
  if (!w || w.length !== 4 || w.some((x) => x == null || x < 0)) return { valid: false, sum: null, weights: w };
  const sum = Math.round(w.reduce((s, x) => s + x, 0) * 100) / 100;
  return { valid: sum === 100, sum, weights: w };
}
// baseMonthlyForecast (a MONTHLY unit figure). monthlyValues = the 3 completed months [m1,m2,m3] (oldest->newest);
// each is a NUMBER (a covered zero is 0) or null (that month has NO proven evidence). mtdProjected = the current-month
// MTD projection (or null). A missing month / MTD is NEVER coerced to 0: a method that needs a missing input returns
// null (Unavailable). This is the fix that removes the old map(num0) missing-to-zero behaviour.
export function baseMonthlyForecast({ method = DEFAULT_FORECAST_METHOD, monthlyValues = [], mtdProjected = null, weights = null } = {}) {
  const months = (Array.isArray(monthlyValues) ? monthlyValues : []).map((v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v)));
  // Three-month average REQUIRES all three completed months present (else Unavailable).
  const allThree = months.length === 3 && months.every((v) => v != null);
  const threeMonthAverage = allThree ? Math.round((months.reduce((s, x) => s + x, 0) / 3) * 100) / 100 : null;
  const mtd = mtdProjected == null || !Number.isFinite(Number(mtdProjected)) ? null : Number(mtdProjected);
  switch (method) {
    case "three-month": return threeMonthAverage;
    case "mtd": return mtd;
    case "weighted": {
      const v = validateWeights(weights);
      if (!v.valid) return null; // an invalid weighted config yields no forecast (caller shows Unavailable + a reason)
      const vals = [months[0] ?? null, months[1] ?? null, months[2] ?? null, mtd];
      // EVERY input carrying a positive weight must be available; a missing one -> Unavailable (never treated as 0).
      for (let i = 0; i < 4; i++) if (v.weights[i] > 0 && vals[i] == null) return null;
      return Math.round(vals.reduce((s, x, i) => s + (v.weights[i] / 100) * (x == null ? 0 : x), 0) * 100) / 100;
    }
    case "higher":
    default: {
      // Higher of the two, using ONLY the available side(s) -- a missing side is never treated as 0. Null iff both missing.
      const cands = [threeMonthAverage, mtd].filter((x) => x != null);
      return cands.length ? Math.max(...cands) : null;
    }
  }
}

// The CANONICAL current-month MTD projection (never a multi-month forecast):
//   mtdProjectedUnits = (mtdUnits / elapsedCompletedDays) * totalDaysInCurrentMonth
// Uses the report's proven effectiveAsOf/D-1 (via elapsedCompletedDays + daysInCurrentMonth), never the wall clock.
export function mtdProjectedUnits({ mtdUnits, elapsedCompletedDays, daysInCurrentMonth }) {
  const u = N(mtdUnits); const e = N(elapsedCompletedDays); const d = N(daysInCurrentMonth);
  if (u == null || e == null || d == null || e <= 0 || d <= 0) return null;
  return Math.round((u / e) * d * 100) / 100;
}

// ---- the full per-row planning computation --------------------------------------------------------------------
/**
 * Compute every planning output for one SKU row. All evidence quantities are Amazon-source-derived and are NEVER
 * mutated. Since the Listings inventory cutover the FBA figures come from the canonical Listings export:
 *   FBA Supply              = FBA Available + FBA Inbound          (null when either is unknown)
 *   Amazon Network Position = FBA Supply + AWD Available           (AWD only when validated for an AWD marketplace;
 *                                                                    null when the ASIN's AWD is unknown)
 * FBA Reserved (Total) and FC Transfer are DISPLAY ONLY -- never supply (their overlap with other buckets is not proven
 * beyond the 2026-10-07 five-seller canary). AWD Inbound is display only. Any field whose evidence is unavailable is
 * `null` (render as an em dash), never 0. fbaContext "mfn-only" = a merchant-fulfilled product (its FBA figures are
 * null and it is never reported as an FBA stockout).
 */
export function computePlanRow({
  isUS = false,
  effectiveAsOf = null,
  daysInCurrentMonth = null,
  inventoryAvailable = false, // whether a validated (expanded) Listings inventory snapshot exists at all
  // Listings FBA quantities (already SKU->ASIN folded; null = unknown).
  available = null, fbaInbound = null, fbaReservedTotal = null, fbaFcTransfer = null, fbaContext = null,
  // AWD (US + EU5). awdAvailable/awdInbound are null when unavailable; only counted when awdValidated.
  // awdApplicable (Listings inventory cutover): false = a NON-AWD marketplace (IN, AU, CA, NL, BE, PL, SE, IE, ...): AWD
  // does not exist there, so it contributes 0 to the network position (displayed "N/A", never a stock 0) and never
  // blocks planning. true = an AWD marketplace: an AWD source that is not validated leaves the network position UNKNOWN
  // (null), never silently AWD-less. undefined = the former behaviour (AWD counted only when awdValidated).
  awdValidated = false, awdAvailable = null, awdInbound = null, awdApplicable = undefined,
  // seller-owned + demand + config
  sellerWarehouseQty = null,
  monthlyValues = [], mtdUnits = null, elapsedCompletedDays = null,
  forecastMethod = DEFAULT_FORECAST_METHOD, forecastWeights = null,
  horizon = null, safetyDays = DEFAULT_SAFETY_DAYS,
} = {}) {
  const known = (v) => v != null && Number.isFinite(Number(v));
  const q = (v) => (inventoryAvailable && known(v) ? Math.max(0, Number(v)) : null);
  // 1) FBA figures (null when the snapshot is unavailable or the ASIN's value is unknown / merchant-fulfilled only).
  const immediatelyAvailable = q(available); // sellable now
  const inbound = q(fbaInbound); // en route to FBA (all inbound states)
  const reservedTotal = q(fbaReservedTotal); // DISPLAY ONLY
  const fcTransfer = q(fbaFcTransfer); // DISPLAY ONLY
  const fbaSupply = immediatelyAvailable == null || inbound == null ? null : immediatelyAvailable + inbound; // FBA only, NO AWD

  // 2) AWD (validated for this account's marketplace). awdAvailable is DISTRIBUTABLE stock -> counts as usable supply.
  //    awdInbound is inbound TO the AWD warehouse and is NOT yet distributable -> DISPLAY ONLY.
  const awdNotApplicable = awdApplicable === false;
  const awdOn = awdValidated && !awdNotApplicable;
  const awdAvail = awdOn && known(awdAvailable) ? Math.max(0, Number(awdAvailable)) : null;
  const awdInb = awdOn && known(awdInbound) ? Math.max(0, Number(awdInbound)) : null;

  // 3) network totals. amazonNetworkPosition = FBA Supply + distributable AWD (the usable planning supply). When AWD is
  //    validated for the marketplace but this ASIN's AWD is unknown, the network position is unknown (null). A non-AWD
  //    marketplace contributes 0 (AWD does not exist there); an AWD marketplace whose AWD source is not validated is
  //    unknown (null) -- never a network position that silently leaves AWD out.
  const totalAmazonAwdStock = fbaSupply == null ? null
    : awdNotApplicable ? fbaSupply
      : awdOn ? (awdAvail == null ? null : fbaSupply + awdAvail)
        : (awdApplicable === true ? null : fbaSupply);
  const whQty = sellerWarehouseQty == null ? null : Math.max(0, Math.trunc(num0(sellerWarehouseQty)));
  const totalNetworkStock = totalAmazonAwdStock == null ? null : totalAmazonAwdStock + num0(whQty);

  // 4) demand / forecast.
  const mtdProj = mtdProjectedUnits({ mtdUnits, elapsedCompletedDays, daysInCurrentMonth });
  const baseForecast = baseMonthlyForecast({ method: forecastMethod, monthlyValues, mtdProjected: mtdProj, weights: forecastWeights });
  // The plain three-month average, exposed for DISPLAY (null unless all three completed months have proven evidence,
  // never a missing month coerced to 0). Independent of the chosen forecast method.
  const monthsForAvg = (Array.isArray(monthlyValues) ? monthlyValues : []).map((v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v)));
  const threeMonthAverage = monthsForAvg.length === 3 && monthsForAvg.every((v) => v != null)
    ? Math.round((monthsForAvg.reduce((s, x) => s + x, 0) / 3) * 100) / 100 : null;
  const win = horizonWindow(effectiveAsOf, horizon);
  const basisMonthDays = N(daysInCurrentMonth);
  const dailyRunRate = baseForecast == null || basisMonthDays == null || basisMonthDays <= 0
    ? null
    : Math.round((baseForecast / basisMonthDays) * 1000) / 1000;
  const effectiveHorizonDays = win.effectiveHorizonDays;
  const horizonDemand = dailyRunRate == null || effectiveHorizonDays == null ? null : Math.round(dailyRunRate * effectiveHorizonDays);
  const sd = N(safetyDays);
  const safetyStockUnits = dailyRunRate == null || sd == null || sd < 0 ? null : Math.round(dailyRunRate * sd);
  const targetInventory = horizonDemand == null || safetyStockUnits == null ? null : Math.ceil(horizonDemand + safetyStockUnits);

  // 5) shortage / ship / production. Requires the target + the Amazon network position (supply) evidence.
  let shortageBeforeWarehouse = null, shipFromSellerWarehouse = null, productionRequirement = null;
  if (targetInventory != null && totalAmazonAwdStock != null) {
    shortageBeforeWarehouse = Math.max(0, targetInventory - totalAmazonAwdStock);
    const wh = num0(whQty);
    shipFromSellerWarehouse = Math.min(wh, shortageBeforeWarehouse);
    productionRequirement = Math.max(0, shortageBeforeWarehouse - wh);
  }

  // 6) estimated stockout date -- immediately-available inventory / daily run rate. Null (with a reason) when the
  //    rate is 0/unknown or immediately-available is unavailable. Never Infinity.
  let estimatedStockoutDate = null, stockoutReason = null;
  if (fbaContext === "mfn-only") { stockoutReason = "merchant-fulfilled listing (no FBA stock)"; }
  else if (immediatelyAvailable == null) { stockoutReason = "inventory unavailable"; }
  else if (dailyRunRate == null) { stockoutReason = "forecast unavailable"; }
  else if (dailyRunRate <= 0) { stockoutReason = "no recent demand"; }
  else if (!isDate(effectiveAsOf)) { stockoutReason = "as-of date unavailable"; }
  else { estimatedStockoutDate = addDaysStr(effectiveAsOf, Math.floor(num0(immediatelyAvailable) / dailyRunRate)); }

  // 7) planning priority + recommended action.
  const { priority, action } = planningPriorityAction({
    productionRequirement, shipFromSellerWarehouse, shortageBeforeWarehouse,
    immediatelyAvailable, dailyRunRate, safetyDays: sd, targetInventory, totalAmazonAwdStock,
  });

  return {
    // display breakdown (Listings): Reserved (Total) + FC Transfer are display only, never counted
    immediatelyAvailable, fbaInbound: inbound, fbaReservedTotal: reservedTotal, fbaFcTransfer: fcTransfer,
    fbaContext: fbaContext || null,
    awdAvailable: awdAvail, awdInbound: awdInb, awdNotApplicable,
    sellerWarehouseQty: whQty,
    // canonical named totals (one model for UI, both Totals rows, export + planning)
    fbaSupply, amazonNetworkPosition: totalAmazonAwdStock, totalNetworkPosition: totalNetworkStock,
    totalAmazonAwdStock, totalNetworkStock, // kept as aliases for existing callers/tests
    // horizon + forecast
    forecastMethod, mtdProjectedUnits: mtdProj, threeMonthAverage, baseMonthlyForecast: baseForecast, dailyRunRate,
    projectionStart: win.start, projectionEnd: win.end, effectiveHorizonDays,
    horizonDemand, safetyStockUnits, targetInventory,
    // outputs
    shortageBeforeWarehouse, shipFromSellerWarehouse, productionRequirement,
    estimatedStockoutDate, stockoutReason,
    planningPriority: priority, recommendedAction: action,
  };
}

// Priority + one-line recommended action. Priority is ALSO conveyed by the text (never colour alone).
export function planningPriorityAction({ productionRequirement, shipFromSellerWarehouse, shortageBeforeWarehouse, immediatelyAvailable, dailyRunRate, safetyDays, targetInventory }) {
  // An unknown shortage (the supply -- e.g. FBA Inbound or AWD -- is unknown) is Unknown, never read as "no shortage".
  if (targetInventory == null || immediatelyAvailable == null || dailyRunRate == null || shortageBeforeWarehouse == null) {
    return { priority: "Unknown", action: "Awaiting inventory or demand evidence" };
  }
  const daysOfCover = dailyRunRate > 0 ? num0(immediatelyAvailable) / dailyRunRate : Infinity;
  if (num0(shortageBeforeWarehouse) <= 0) {
    return { priority: "OK", action: "Sufficient network stock for the horizon" };
  }
  // There is a shortage. Grade urgency by how soon immediately-available stock runs out vs the safety buffer.
  let priority = "Medium";
  if (Number.isFinite(daysOfCover)) {
    if (daysOfCover <= num0(safetyDays)) priority = "Critical";
    else if (daysOfCover <= num0(safetyDays) * 2) priority = "High";
    else priority = "Medium";
  } else priority = "Low";
  const parts = [];
  if (num0(shipFromSellerWarehouse) > 0) parts.push(`Ship ${Math.round(num0(shipFromSellerWarehouse))} from warehouse`);
  if (num0(productionRequirement) > 0) parts.push(`Produce ${Math.round(num0(productionRequirement))} units`);
  return { priority, action: parts.length ? parts.join("; ") : "Restock from network" };
}

// ---- inventory source (Listings inventory cutover, phase 2) -----------------------------------------------------
export const FBA_PLAN_INVENTORY_MODEL = "listings-v1";
export const FBA_PLAN_SOURCE_LISTINGS = "listings";
export const FBA_PLAN_SOURCE_HEALTH_FALLBACK = "health-fallback";
export const FBA_PLAN_SOURCE_UNAVAILABLE = "unavailable";
// The schedule refreshes Listings once a day per region: a Listings snapshot older than this means the account's latest
// Listings batch failed or was skipped (the last-known values stay, with a visible warning).
export const FBA_PLAN_LISTINGS_STALE_HOURS = 36;
// The reason code an adapted pre-phase-2 (FBA Inventory Health model) saved plan carries.
export const FBA_PLAN_LEGACY_HEALTH_REASON = "legacy-health-plan";

const finiteOrNull = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * ONE client view of every saved fba-plan payload, whatever server version produced it:
 *   - a phase-2 payload (inventoryModel "listings-v1" + inventorySource) is returned unchanged;
 *   - a Listings-model payload WITHOUT a source (the unshipped hard-cutover shape) gets source listings | unavailable;
 *   - a PRE-phase-2 saved plan (snapshot fba-plan/v2d-5 and older: the FBA Inventory Health model -- available,
 *     customerOrderReserved, reservedFcTransfer / Processing, inboundWorking / Shipped / Received) is rendered as a
 *     Health-sourced plan in the SAME shape: fbaAvailable = the saved available; fbaInbound = working + shipped + received
 *     (null when any part is missing); FBA Reserved (Total) / FC Transfer null (unavailable from Health); AWD as saved;
 *     labelled with its saved snapshot date (inventoryHealthDate = inventoryDate, inventoryLegacy true). Production stock
 *     is never hidden during the deploy-before-scheduler window, and no value is ever invented.
 * Never mutates the input. A non-object / row-less payload is returned as is.
 */
export function adaptFbaPlanPayload(payload) {
  const p = payload;
  if (!p || typeof p !== "object" || !Array.isArray(p.rows)) return p;
  if (p.inventoryModel === FBA_PLAN_INVENTORY_MODEL && typeof p.inventorySource === "string") return p;
  if (p.inventoryModel === FBA_PLAN_INVENTORY_MODEL) {
    const ok = p.inventoryAvailable === true;
    return {
      ...p,
      inventorySource: ok ? FBA_PLAN_SOURCE_LISTINGS : FBA_PLAN_SOURCE_UNAVAILABLE,
      inventoryListingsReasons: ok ? [] : [String(p.inventoryUnavailableReason || "listings-empty")],
      inventoryHealthDate: null,
    };
  }
  const available = p.inventoryAvailable === true;
  const inboundOf = (r) => {
    const parts = [r.inboundWorking, r.inboundShipped, r.inboundReceived].map(finiteOrNull);
    return parts.some((v) => v == null) ? null : parts.reduce((s, v) => s + v, 0);
  };
  const rows = p.rows.map((r) => {
    const src = r && typeof r === "object" ? r : {};
    // eslint-disable-next-line no-unused-vars
    const { customerOrderReserved, reservedFcTransfer, reservedFcProcessing, inboundWorking, inboundShipped, inboundReceived, ...rest } = src;
    return {
      ...rest,
      fbaContext: available ? "fba" : "absent",
      inventoryConflict: false,
      fbaAvailable: available ? finiteOrNull(src.fbaAvailable) : null,
      fbaInbound: available ? inboundOf(src) : null,
      fbaReservedTotal: null,
      fbaFcTransfer: null,
      awdAvailable: finiteOrNull(src.awdAvailable),
      awdInbound: finiteOrNull(src.awdInbound),
    };
  });
  return {
    ...p,
    rows,
    inventoryModel: FBA_PLAN_INVENTORY_MODEL,
    inventorySource: available ? FBA_PLAN_SOURCE_HEALTH_FALLBACK : FBA_PLAN_SOURCE_UNAVAILABLE,
    inventoryLegacy: true,
    inventoryListingsReasons: [FBA_PLAN_LEGACY_HEALTH_REASON],
    inventoryHealthDate: available ? (p.inventoryDate || null) : null,
    inventoryConflicts: [],
    inventoryResolvedConflicts: [],
    inventoryUnattributed: null,
    awdUnattributedSkus: 0,
    listingsRefreshedAt: null,
    healthFetchedAt: p.inventoryFetchedAt || null,
  };
}

/** One Listings reason code ("listings-unresolved-conflicts:3") -> the plain-language reason shown to the user. */
export function fbaPlanInventoryReasonText(code) {
  const s = String(code == null ? "" : code).trim();
  const i = s.indexOf(":");
  const key = i >= 0 ? s.slice(0, i) : s;
  const nRaw = i >= 0 ? s.slice(i + 1) : "";
  const n = Number(nRaw);
  const one = n === 1;
  const count = Number.isFinite(n) ? n.toLocaleString("en-US") : nRaw;
  switch (key) {
    case "listings-not-expanded": return "this account's Listings snapshot does not yet include the new inventory fields";
    case "listings-unresolved-conflicts": return `${count} SKU${one ? " has" : "s have"} conflicting duplicate Listings rows`;
    case "listings-unattributed-stock": return `${count} Listings SKU${one ? " holds" : "s hold"} stock with no ASIN`;
    case "listings-blank-fba-fields": return `${count} FBA SKU${one ? " has" : "s have"} blank Listings quantities`;
    case "listings-foreign-marketplace-rows": return "this account's Listings snapshot contains rows of another marketplace";
    case "listings-empty": return "this account's Listings snapshot has no rows";
    case "listings-invalid-rows": return `${count} Listings row${one ? " is" : "s are"} malformed`;
    case "listings-source-unavailable": return "this account's Listings snapshot was not available for this plan";
    case "listings-fragment-malformed": return "this account's Listings snapshot did not have the expected single-account shape";
    case "listings-capped": return `the Listings export reached the ${count}-row limit and may be incomplete`;
    case FBA_PLAN_LEGACY_HEALTH_REASON: return "this plan was saved before FBA inventory moved to Listings";
    default: return s || "the Listings snapshot is not validated";
  }
}

// The READ-ONLY FBA Inventory Health bridge may drive figures only while its snapshot date is at most this many days
// before the plan's inventory as-of (lib/server/inventory-source.js HEALTH_BRIDGE_MAX_AGE_DAYS; the payload carries it).
export const FBA_PLAN_HEALTH_BRIDGE_MAX_AGE_DAYS = 2;

/**
 * One READ-ONLY Health bridge reason code (payload.inventoryHealthReasons) -> the plain-language reason shown to the user.
 * ctx: { maxAgeDays, asOf } (the payload's inventoryBridgeMaxAgeDays / inventoryAsOf) for the 2-day rule wording.
 */
export function fbaPlanHealthReasonText(code, { maxAgeDays = FBA_PLAN_HEALTH_BRIDGE_MAX_AGE_DAYS, asOf = null } = {}) {
  const s = String(code == null ? "" : code).trim();
  const i = s.indexOf(":");
  const key = i >= 0 ? s.slice(0, i) : s;
  const arg = i >= 0 ? s.slice(i + 1) : "";
  const days = Number.isFinite(Number(maxAgeDays)) ? Number(maxAgeDays) : FBA_PLAN_HEALTH_BRIDGE_MAX_AGE_DAYS;
  switch (key) {
    case "health-snapshot-missing":
    case "health-bridge-missing": return "there is no saved FBA Inventory Health snapshot for this account";
    case "health-bridge-stale": return `the saved FBA Inventory Health snapshot of ${arg || "an unknown date"} is more than ${days} day${days === 1 ? "" : "s"} older than this plan's inventory date${asOf ? ` (${asOf})` : ""}, and FBA Inventory Health is no longer refreshed`;
    case "health-bridge-after-as-of": return `the saved FBA Inventory Health snapshot (${arg || "unknown date"}) is dated after this plan's inventory date`;
    case "health-bridge-as-of-missing": return "this plan has no inventory date to check the saved FBA Inventory Health snapshot against";
    case "health-foreign-marketplace-rows": return "the saved FBA Inventory Health snapshot contains rows of another marketplace";
    default: return "the saved FBA Inventory Health snapshot could not be verified for this account";
  }
}

/**
 * The inventory-source facts the FBA Shipment Plan page shows, from an ADAPTED payload (adaptFbaPlanPayload). Pure.
 * -> { source, legacy, fallback, inventoryOk, healthDate, listingsRefreshedAt, reasons:[text], listingsStale,
 *      listingsAgeHours, healthReasons:[text], healthReasonCodes, bridgeSnapshotDate, bridgeStale, bridgeMaxAgeDays,
 *      inventoryAsOf, awdApplicable, awdAssumedZeroSkus }.
 * inventoryOk = the plan shows inventory figures (Listings or the READ-ONLY Health bridge); fallback = the bridge drives
 * this plan (a saved, no-longer-refreshed snapshot); listingsStale applies to the Listings source only (age >
 * FBA_PLAN_LISTINGS_STALE_HOURS); healthReasons say why the bridge is NOT used (an Unavailable plan); bridgeStale = the
 * saved snapshot exists but is older than the 2-day rule allows; awdAssumedZeroSkus = the account's Listings SKUs whose
 * BLANK AWD cell is assumed 0 (AWD marketplaces only).
 */
export function fbaPlanInventoryView(payload, nowMs = Date.now()) {
  const p = payload && typeof payload === "object" ? payload : {};
  const source = p.inventoryModel === FBA_PLAN_INVENTORY_MODEL && typeof p.inventorySource === "string" ? p.inventorySource : FBA_PLAN_SOURCE_UNAVAILABLE;
  const inventoryOk = source !== FBA_PLAN_SOURCE_UNAVAILABLE && p.inventoryAvailable === true;
  const legacy = p.inventoryLegacy === true;
  const fallback = source === FBA_PLAN_SOURCE_HEALTH_FALLBACK && !legacy;
  const reasons = (Array.isArray(p.inventoryListingsReasons) ? p.inventoryListingsReasons : []).map(fbaPlanInventoryReasonText);
  const at = source === FBA_PLAN_SOURCE_LISTINGS ? Date.parse(String(p.listingsRefreshedAt || "")) : NaN;
  const listingsAgeHours = Number.isFinite(at) ? (Number(nowMs) - at) / 3600000 : null;
  const bridgeMaxAgeDays = Number.isFinite(Number(p.inventoryBridgeMaxAgeDays)) && p.inventoryBridgeMaxAgeDays !== null ? Number(p.inventoryBridgeMaxAgeDays) : FBA_PLAN_HEALTH_BRIDGE_MAX_AGE_DAYS;
  const inventoryAsOf = p.inventoryAsOf || p.inventoryRequestedThrough || null;
  const healthReasonCodes = source === FBA_PLAN_SOURCE_UNAVAILABLE && Array.isArray(p.inventoryHealthReasons) ? p.inventoryHealthReasons.map(String) : [];
  const staleCode = healthReasonCodes.find((c) => c.startsWith("health-bridge-stale")) || null;
  const awdApplicable = p.awdEligible === undefined ? p.isUS === true : p.awdEligible === true;
  return {
    source, legacy, fallback, inventoryOk,
    healthDate: source === FBA_PLAN_SOURCE_HEALTH_FALLBACK ? (p.inventoryHealthDate || null) : null,
    listingsRefreshedAt: source === FBA_PLAN_SOURCE_LISTINGS ? (p.listingsRefreshedAt || null) : null,
    reasons,
    listingsAgeHours,
    listingsStale: listingsAgeHours !== null && listingsAgeHours > FBA_PLAN_LISTINGS_STALE_HOURS,
    healthReasonCodes,
    healthReasons: healthReasonCodes.map((c) => fbaPlanHealthReasonText(c, { maxAgeDays: bridgeMaxAgeDays, asOf: inventoryAsOf })),
    bridgeSnapshotDate: p.inventoryBridgeSnapshotDate || (staleCode ? staleCode.slice(staleCode.indexOf(":") + 1) || null : null),
    bridgeStale: !!staleCode,
    bridgeMaxAgeDays,
    inventoryAsOf,
    awdApplicable,
    awdAssumedZeroSkus: awdApplicable && p.awdAvailable === true && Number.isFinite(Number(p.awdAssumedZeroSkus)) ? Math.max(0, Number(p.awdAssumedZeroSkus)) : 0,
  };
}
