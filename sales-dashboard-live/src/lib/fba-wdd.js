// PURE, offline-testable Weighted Daily Demand (WDD) + lead-time + inventory-cover + reorder model for the FBA
// Shipment Plan. ADDITIVE: it computes the NEW columns that sit BESIDE the existing plan columns and never touches the
// existing planning math (src/lib/fba-planning.js). Demand REUSES the shared SKU Movement v2 ordered-unit evidence --
// the sku-movement payload's per-ASIN `dailyUnits` over its proven daily axis, which already applies non-cancelled OLI
// units, ASIN aggregation, `amzn*` handling, catalog-first ASIN resolution and account/marketplace/currency/brand
// isolation. No DataDoe, no I/O, no React. Missing evidence or settings -> null (Unavailable / Not configured), NEVER a
// fabricated 0. No output is ever Infinity/NaN/negative.

const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

export const WDD_DEFAULT_WEIGHTS = Object.freeze({ w7: 50, w30: 30, w60: 20 });
export const WDD_WINDOWS = Object.freeze([7, 30, 60]);

function addDaysISO(dateStr, n) { const d = new Date(dateStr + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + Number(n || 0)); return d.toISOString().slice(0, 10); }
function diffDaysISO(a, b) { return Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400000); }

// The marketplace-LOCAL current date (YYYY-MM-DD) for a marketplace IANA timezone, via Intl (en-CA -> ISO order). An
// unknown/blank tz falls back to UTC. `now` is injectable so tests can pin the instant (no wall-clock dependency).
export function marketplaceLocalDate(timeZone, now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const get = (t) => parts.find((p) => p.type === t)?.value;
    const y = get("year"), m = get("month"), d = get("day");
    if (y && m && d) return `${y}-${m}-${d}`;
  } catch (_e) { /* fall through */ }
  return new Date(now).toISOString().slice(0, 10);
}

// The trailing-N daily average from the SKU Movement v2 evidence for ONE ASIN. `dailyUnits` is the sparse
// { date: units } map from that ASIN's payload row; `effectiveAsOf` is the account's latest proven date; `coverageFrom`
// is the earliest proven date. The window is the N calendar days ending at effectiveAsOf. A day earlier than
// coverageFrom is UNCOVERED -- missing evidence, excluded from BOTH the numerator and the denominator (never fabricated
// as 0). A covered day with no qualifying unit is a REAL 0 (counted in the denominator). avg = covered units / covered
// day count; null when 0 covered days. When the full N days are covered (the normal case) this is exactly
// `covered units / N` as specified.
export function trailingDailyAverage(dailyUnits, effectiveAsOf, coverageFrom, n) {
  if (!isDate(effectiveAsOf) || !(n > 0)) return { avg: null, coveredDays: 0, units: 0 };
  const windowStart = addDaysISO(effectiveAsOf, -(n - 1));
  const lo = isDate(coverageFrom) && coverageFrom > windowStart ? coverageFrom : windowStart;
  if (lo > effectiveAsOf) return { avg: null, coveredDays: 0, units: 0 };
  const coveredDays = diffDaysISO(lo, effectiveAsOf) + 1; // inclusive covered calendar days in the window
  let units = 0;
  const map = dailyUnits && typeof dailyUnits === "object" ? dailyUnits : {};
  for (const [date, u] of Object.entries(map)) if (date >= lo && date <= effectiveAsOf) units += Number(u) || 0;
  const avg = coveredDays > 0 ? Math.round((units / coveredDays) * 1000) / 1000 : null;
  return { avg, coveredDays, units };
}

// The 7/30/60-day averages for ONE ASIN's dailyUnits. Returns the three averages (null when uncovered) + covered-day
// counts (for an honest "partial coverage" note).
export function dailyAverages(dailyUnits, effectiveAsOf, coverageFrom) {
  const a7 = trailingDailyAverage(dailyUnits, effectiveAsOf, coverageFrom, 7);
  const a30 = trailingDailyAverage(dailyUnits, effectiveAsOf, coverageFrom, 30);
  const a60 = trailingDailyAverage(dailyUnits, effectiveAsOf, coverageFrom, 60);
  return { avg7: a7.avg, avg30: a30.avg, avg60: a60.avg, covered7: a7.coveredDays, covered30: a30.coveredDays, covered60: a60.coveredDays };
}

// Validate a WDD weight triple. Each must be numeric in [0,100]; the total must equal EXACTLY 100. Distinguishes the
// over/under-100 messages the mission requires. Returns { valid, total, weights?, reason? }.
export function validateWddWeights({ w7, w30, w60 } = {}) {
  const a = num(w7), b = num(w30), c = num(w60);
  if ([a, b, c].some((x) => x == null || x < 0 || x > 100)) return { valid: false, total: null, reason: "Each weight must be a number between 0 and 100." };
  const total = Math.round((a + b + c) * 100) / 100;
  if (total > 100) return { valid: false, total, reason: `Weights total ${total}% — they must total exactly 100%.` };
  if (total < 100) return { valid: false, total, reason: "Weights must total 100%." };
  return { valid: true, total: 100, weights: { w7: a, w30: b, w60: c } };
}

// WDD = (7D avg * w7/100) + (30D avg * w30/100) + (60D avg * w60/100). Requires a VALID (total-100) weight set; a
// positive-weighted average that is missing (uncovered) -> null (Unavailable), never treated as 0. Full precision is
// retained for comparisons; the UI displays it to 2 decimals.
export function weightedDailyDemand({ avg7, avg30, avg60 } = {}, weights) {
  const v = validateWddWeights(weights);
  if (!v.valid) return null;
  const { w7, w30, w60 } = v.weights;
  const pairs = [[w7, num(avg7)], [w30, num(avg30)], [w60, num(avg60)]];
  for (const [w, a] of pairs) if (w > 0 && a == null) return null;
  const wdd = pairs.reduce((s, [w, a]) => s + (w / 100) * (a == null ? 0 : a), 0);
  return Math.round(wdd * 1e6) / 1e6;
}

// Resolve the effective weights for ONE ASIN: its OWN brand's saved weights (by canonical brand key), else -- for an
// unmapped ASIN -- the explicit ACCOUNT-DEFAULT record (key ''), else the recommended 50/30/20 default. One brand's
// weights are NEVER used for another brand (a mapped brand never reads the '' account-default record).
// `savedByKey` is a Map: canonical brand key -> { w7, w30, w60 }; '' is the account-default record.
export function resolveWddWeights(savedByKey, brandKey) {
  const map = savedByKey instanceof Map ? savedByKey : new Map(Object.entries(savedByKey || {}));
  const key = brandKey || ""; // '' == unmapped -> account-default record
  const own = map.get(key);
  if (own && validateWddWeights(own).valid) return { weights: { w7: Number(own.w7), w30: Number(own.w30), w60: Number(own.w60) }, source: key === "" ? "account-default" : "brand" };
  return { weights: { ...WDD_DEFAULT_WEIGHTS }, source: "default" };
}

// Total Lead Time = Production + Shipping + AWD Transfer + Safety Stock. Any missing input -> null (Not configured).
export function totalLeadTime({ production, shipping, awd, safety } = {}) {
  const p = num(production), s = num(shipping), a = num(awd), sf = num(safety);
  if ([p, s, a, sf].some((x) => x == null || x < 0)) return null;
  return p + s + a + sf;
}

// Inbound ETA computed at an explicit start/reset: start date + Production + Shipping + AWD Transfer. Safety Stock is
// EXCLUDED because it is a buffer, not transit time. Any of the three transit inputs missing -> null.
export function computeInboundEta(startDate, { production, shipping, awd } = {}) {
  const p = num(production), s = num(shipping), a = num(awd);
  if (!isDate(startDate) || [p, s, a].some((x) => x == null || x < 0)) return null;
  return addDaysISO(startDate, p + s + a);
}

// Days to Inbound = max(0, Inbound ETA - marketplace-local current date). Derived LIVE on read; never stored/decremented.
export function daysToInbound(inboundEta, marketplaceToday) {
  if (!isDate(inboundEta) || !isDate(marketplaceToday)) return null;
  return Math.max(0, diffDaysISO(marketplaceToday, inboundEta));
}

// The inventory-cover + reorder model, from NON-OVERLAPPING evidence:
//   Existing Cover Raw = FBA Available + AWD Available + Inbound Pipeline - (WDD * Days to Inbound)
//   Existing Cover     = max(0, Existing Cover Raw)
//   Ideal Cover        = WDD * Total Lead Time
//   Reorder Status     = Reorder when Existing Cover < Ideal Cover (full precision), else Sufficient
//   Suggested Reorder  = ceil(max(0, Ideal Cover - Existing Cover))
// Total FBA Inventory is deliberately NOT used (it already contains inbound quantities -> double count). AWD/Inbound
// that are genuinely absent (non-US AWD, or none inbound) contribute 0 SUPPLY, but only when FBA availability exists;
// if demand, inventory or the lead-time/countdown settings are unavailable the status is "Unavailable" (never a false
// "Sufficient"). Comparisons use full precision; unit outputs are whole units.
export function coverModel({ wdd, totalLeadTime: tlt, daysToInbound: dti, fbaAvailable, awdAvailable, inboundPipeline } = {}) {
  const w = num(wdd), lt = num(tlt), dd = num(dti);
  const fba = num(fbaAvailable), awd = num(awdAvailable), inb = num(inboundPipeline);
  const idealExact = w == null || lt == null ? null : w * lt;
  let existingExact = null;
  if (w != null && dd != null && fba != null) {
    const supply = fba + (awd == null ? 0 : awd) + (inb == null ? 0 : inb);
    existingExact = Math.max(0, supply - w * dd);
  }
  let reorderStatus = "Unavailable";
  let suggestedReorder = null;
  if (idealExact != null && existingExact != null) {
    reorderStatus = existingExact < idealExact ? "Reorder" : "Sufficient";
    suggestedReorder = Math.ceil(Math.max(0, idealExact - existingExact));
  }
  return {
    idealCover: idealExact == null ? null : Math.round(idealExact),
    existingCover: existingExact == null ? null : Math.round(existingExact),
    reorderStatus,
    suggestedReorder,
  };
}

// The full additive per-ASIN computation, given one ASIN's demand evidence (dailyUnits + the account's proven window),
// its resolved weights, its lead-time record, the marketplace-local today, and the plan row's inventory buckets.
// A convenience that composes the pieces above so the UI and tests share ONE path.
export function computeAsinWdd({ dailyUnits, effectiveAsOf, coverageFrom, weights, leadTime = null, marketplaceToday = null, fbaAvailable = null, awdAvailable = null, inboundPipeline = null } = {}) {
  const avgs = dailyAverages(dailyUnits, effectiveAsOf, coverageFrom);
  const wdd = weightedDailyDemand(avgs, weights);
  const lt = leadTime || {};
  const tlt = totalLeadTime({ production: lt.production, shipping: lt.shipping, awd: lt.awd, safety: lt.safety });
  const dti = daysToInbound(lt.inboundEta, marketplaceToday);
  const cover = coverModel({ wdd, totalLeadTime: tlt, daysToInbound: dti, fbaAvailable, awdAvailable, inboundPipeline });
  return { ...avgs, wdd, totalLeadTime: tlt, daysToInbound: dti, inboundEta: lt.inboundEta || null, ...cover };
}
