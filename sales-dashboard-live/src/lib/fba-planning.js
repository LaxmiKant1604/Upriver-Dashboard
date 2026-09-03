// FBA Shipment Plan -- PURE planning helpers. No DataDoe, no I/O, no React. Every value is derived from already-saved
// evidence (the fba-plan snapshot rows) plus the seller's durable planning settings + seller-warehouse quantity, so a
// settings/warehouse change re-computes here with ZERO DataDoe. Missing evidence stays `null` (Unavailable) and is
// NEVER coerced to a fabricated 0; no output is ever Infinity/NaN/negative.
//
// ============================ CANONICAL, NON-OVERLAPPING INVENTORY MODEL (documented) ============================
// FBA Inventory Health (source 44fc5ba0ce) exposes these MUTUALLY-EXCLUSIVE states for a SKU -- Amazon places each
// physical unit in exactly one bucket, and `available` (fulfillable) EXCLUDES every reserved and inbound state:
//   available               -- sellable now, in an FC (fulfillable)
//   reserved_customer_order -- already allocated to placed customer orders (being picked/packed) -> already SOLD
//   reserved_fc_transfer    -- reserved for an FC->FC transfer (in-network, temporarily unavailable, becomes sellable)
//   reserved_fc_processing  -- being processed at an FC (in-network, temporarily unavailable, becomes sellable)
//   inbound_working         -- shipment created, not yet shipped (en route to the FBA network)
//   inbound_shipped         -- shipped to Amazon, in transit (en route)
//   inbound_received        -- received at an FC, not yet checked in to `available` (en route to fulfillable)
// We NEVER use total_reserved_quantity (the aggregate of the reserved_* components) NOR inbound_quantity (the aggregate
// of the inbound_* states) -- using an aggregate together with its components would double-count. reserved_fc_transfer
// is used RAW (no inbound-shipped subtraction: the authoritative source metadata proves the reserved and inbound
// states are DISTINCT buckets, so there is no overlap to net off). Each component is added AT MOST ONCE.
//
// Canonical named quantities (each unit appears in exactly one summand):
//   sellableNow          = available                                                         (fulfillable NOW)
//   reservedFcTotal      = reserved_fc_transfer + reserved_fc_processing                      (in-FC, becoming sellable)
//   inboundPipeline      = inbound_working + inbound_shipped + inbound_received               (en route to the FC)
//   amazonPipeline       = reservedFcTotal + inboundPipeline                                  (in-network, not yet sellable)
//   customerOrderReserved= reserved_customer_order  -- DISPLAY ONLY; already sold, EXCLUDED from every usable total.
//   totalFbaInventory    = sellableNow + amazonPipeline                                       (FBA network only; NO AWD)
//   awdAvailable (US)    = awd_available_distributable_quantity  -- distributable AWD stock (counts as usable supply)
//   awdInbound   (US)    = awd_total_inbound_quantity            -- inbound TO AWD, NOT yet distributable: DISPLAY ONLY,
//                                                                  EXCLUDED from every usable total (never a fake 0 non-US)
//   amazonNetworkPosition= totalFbaInventory + awdAvailable       (all Amazon-held stock that is/will be sellable)
//   totalNetworkPosition = amazonNetworkPosition + sellerWarehouseQty  (adds the seller's uncommitted warehouse stock)
// Planning supply (what reduces the restock shortage) = amazonNetworkPosition; the seller warehouse is applied
// afterward in the ship-from-warehouse / production split. Every UI number, footer, export column and planning figure
// derives from THIS one model. No quantity is double-counted (proven in scripts/fba-planning.test.js).

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
 * mutated. `inv` carries the non-cancelled FBA states; `awd` is included ONLY when isUS && the AWD evidence is
 * validated. `settings` = resolved account/SKU planning config. Returns an object with the display + planning fields;
 * any field whose evidence is unavailable is `null` (render as an em dash), never 0.
 */
export function computePlanRow({
  isUS = false,
  effectiveAsOf = null,
  daysInCurrentMonth = null,
  inventoryAvailable = false, // whether the FBA inventory snapshot exists at all
  // FBA states (already SKU->ASIN folded; null when the whole snapshot is unavailable). Each is a DISTINCT state per
  // the source metadata (inbound_quantity = sum of the 3 inbound states; reserved_fc_transfer is a separate reserved
  // state), so reserved_fc_transfer is used RAW -- there is NO proven inbound-shipped overlap to subtract.
  available = null, customerOrderReserved = null, reservedFcTransfer = null, reservedFcProcessing = null,
  inboundWorking = null, inboundShipped = null, inboundReceived = null,
  // AWD (US-only). awdAvailable/awdInbound are null when unavailable; only counted when isUS && awdValidated.
  awdValidated = false, awdAvailable = null, awdInbound = null,
  // seller-owned + demand + config
  sellerWarehouseQty = null,
  monthlyValues = [], mtdUnits = null, elapsedCompletedDays = null,
  forecastMethod = DEFAULT_FORECAST_METHOD, forecastWeights = null,
  horizon = null, safetyDays = DEFAULT_SAFETY_DAYS,
} = {}) {
  // 1) inventory buckets (non-overlapping). When the snapshot is unavailable every FBA figure is null.
  const avail = inventoryAvailable ? num0(available) : null;
  const custReserved = inventoryAvailable ? (customerOrderReserved == null ? null : num0(customerOrderReserved)) : null;
  const fcTransferNet = num0(reservedFcTransfer); // RAW: a distinct reserved state, no proven inbound-shipped overlap
  const reservedFcTotal = inventoryAvailable ? fcTransferNet + num0(reservedFcProcessing) : null; // in-FC, becoming sellable
  const inboundPipeline = inventoryAvailable ? num0(inboundWorking) + num0(inboundShipped) + num0(inboundReceived) : null; // en route
  const pipelineParts = inventoryAvailable ? num0(reservedFcTotal) + num0(inboundPipeline) : null;
  const immediatelyAvailable = avail; // sellable now
  const amazonPipeline = pipelineParts; // in-network, not yet sellable (customer-order-reserved EXCLUDED)
  const totalFbaInventory = immediatelyAvailable == null ? null : num0(immediatelyAvailable) + num0(amazonPipeline); // FBA only, NO AWD

  // 2) AWD (US-only, validated). Non-US or unvalidated -> null (Unavailable), never 0.
  //    awdAvailable is DISTRIBUTABLE stock -> counts as usable supply. awdInbound is inbound TO the AWD warehouse and
  //    is NOT yet distributable -> DISPLAY ONLY, never added to usable/network/planning supply.
  // AWD is counted whenever the caller proves it validated for THIS account's marketplace (US + EU5). The caller's
  // awdValidated already encodes marketplace eligibility (payload.awdEligible && payload.awdAvailable), so US stays
  // byte-identical (awdValidated was only ever true for US) and European AWD now flows through the SAME formulas.
  const awdAvail = awdValidated ? (awdAvailable == null ? null : num0(awdAvailable)) : null;
  const awdInb = awdValidated ? (awdInbound == null ? null : num0(awdInbound)) : null;
  const distributableAwdStock = awdValidated ? num0(awdAvail) : 0; // awdInbound EXCLUDED (not yet distributable)

  // 3) network totals. amazonNetworkPosition = FBA inventory + distributable AWD (the usable planning supply).
  const totalAmazonAwdStock = immediatelyAvailable == null ? null : num0(totalFbaInventory) + distributableAwdStock;
  const whQty = sellerWarehouseQty == null ? null : Math.max(0, Math.trunc(num0(sellerWarehouseQty)));
  const totalNetworkStock = totalAmazonAwdStock == null ? (whQty == null ? null : whQty) : num0(totalAmazonAwdStock) + num0(whQty);

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

  // 5) shortage / ship / production. Requires the target + Amazon-network stock evidence.
  let shortageBeforeWarehouse = null, shipFromSellerWarehouse = null, productionRequirement = null;
  if (targetInventory != null && immediatelyAvailable != null) {
    const amazonNetwork = num0(totalFbaInventory) + distributableAwdStock; // == amazonNetworkPosition (usable supply)
    shortageBeforeWarehouse = Math.max(0, targetInventory - amazonNetwork);
    const wh = num0(whQty);
    shipFromSellerWarehouse = Math.min(wh, shortageBeforeWarehouse);
    productionRequirement = Math.max(0, shortageBeforeWarehouse - wh);
  }

  // 6) estimated stockout date -- immediately-available inventory / daily run rate. Null (with a reason) when the
  //    rate is 0/unknown or immediately-available is unavailable. Never Infinity.
  let estimatedStockoutDate = null, stockoutReason = null;
  if (immediatelyAvailable == null) { stockoutReason = "inventory unavailable"; }
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
    // display breakdown (each shown separately, each counted at most once)
    immediatelyAvailable, customerOrderReserved: custReserved, amazonPipeline,
    reservedFcTransfer: inventoryAvailable ? fcTransferNet : null,
    reservedFcProcessing: inventoryAvailable ? (reservedFcProcessing == null ? null : num0(reservedFcProcessing)) : null,
    reservedFcTotal, inboundPipeline,
    inboundWorking: inventoryAvailable ? (inboundWorking == null ? null : num0(inboundWorking)) : null,
    inboundShipped: inventoryAvailable ? (inboundShipped == null ? null : num0(inboundShipped)) : null,
    inboundReceived: inventoryAvailable ? (inboundReceived == null ? null : num0(inboundReceived)) : null,
    awdAvailable: awdAvail, awdInbound: awdInb,
    sellerWarehouseQty: whQty,
    // canonical named totals (one model for UI, footer, export + planning)
    totalFbaInventory, amazonNetworkPosition: totalAmazonAwdStock, totalNetworkPosition: totalNetworkStock,
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
  if (targetInventory == null || immediatelyAvailable == null || dailyRunRate == null) {
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
