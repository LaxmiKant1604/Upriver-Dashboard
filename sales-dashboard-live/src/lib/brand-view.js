// Account-scoped Brand View calculations.
//
// Every number the Brand View screen shows is produced here, from the compact
// snapshot the server saved. Keeping it in one dependency-free module means the
// currency maths, the "unavailable is not zero" rule and the three report shapes
// are all unit-testable without a browser.
//
// FOUR RULES THIS MODULE ENFORCES
//
//  1. `null` means "the source does not tell us", and it propagates. It is never
//     coerced to 0. A metric that is null must reach the screen as "—".
//  2. In Original marketplace currency mode, money is grouped by currency and
//     NEVER summed across currencies. There is no single cross-currency total.
//  3. In a converted mode, every country value is converted individually at full
//     precision and the group total is the SUM OF THOSE CONVERTED VALUES. It is
//     never the converted value of an original-currency total, so the visible
//     rows always add up to the visible total apart from display rounding.
//  4. Unit counts and inventory unit counts are never converted.

import {
  addDays, daysInMonth, monthBack, monthStart, parseDateStr, shiftYear,
} from "../../lib/server/reports/brand-view.js";

export { addDays, monthBack, monthStart, shiftYear };

/* ============================== CURRENCY MODEL ============================== */

/** The sentinel for "leave every marketplace in its own currency". */
export const ORIGINAL_CURRENCY = "ORIGINAL";

export const CURRENCY_OPTIONS = [
  { value: ORIGINAL_CURRENCY, label: "Original marketplace currency", short: "Original" },
  { value: "USD", label: "USD — US dollar", short: "USD" },
  { value: "EUR", label: "EUR — Euro", short: "EUR" },
  { value: "GBP", label: "GBP — Pound sterling", short: "GBP" },
  { value: "INR", label: "INR — Indian rupee", short: "INR" },
  { value: "CAD", label: "CAD — Canadian dollar", short: "CAD" },
  { value: "AUD", label: "AUD — Australian dollar", short: "AUD" },
  { value: "JPY", label: "JPY — Japanese yen", short: "JPY" },
  { value: "AED", label: "AED — UAE dirham", short: "AED" },
];

export function isConvertedMode(displayCurrency) {
  return Boolean(displayCurrency) && displayCurrency !== ORIGINAL_CURRENCY;
}

/**
 * Convert one money value between currencies using a single-base rate table.
 *
 * `rates` maps a currency code to "how many units of that currency one base unit
 * buys", which is what the provider publishes. The cross rate therefore divides
 * out the base. Both legs must exist, or the answer is null — there is no static
 * fallback multiplier anywhere in this module.
 */
export function convertMoney(value, fromCurrency, toCurrency, rates) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const from = String(fromCurrency || "").toUpperCase();
  const to = String(toCurrency || "").toUpperCase();
  if (!from || !to) return null;
  if (from === to) return Number(value);
  const fromRate = Number(rates?.[from]);
  const toRate = Number(rates?.[to]);
  if (!Number.isFinite(fromRate) || fromRate <= 0) return null;
  if (!Number.isFinite(toRate) || toRate <= 0) return null;
  // Full internal precision. Rounding happens only in the formatter.
  return (Number(value) / fromRate) * toRate;
}

/**
 * Which of a report's currencies cannot be converted to `displayCurrency`.
 * Used to show one explicit unavailable state instead of a table of dashes.
 */
export function unconvertibleCurrencies(currencies, displayCurrency, rates) {
  if (!isConvertedMode(displayCurrency)) return [];
  return [...new Set(currencies.filter(Boolean))]
    .filter((currency) => convertMoney(1, currency, displayCurrency, rates) === null)
    .sort();
}

/* ============================== DATE RANGE ============================== */

export const RANGE_PRESETS = [
  { value: "LATEST", label: "Latest reported day" },
  { value: "7D", label: "Last 7 days" },
  { value: "30D", label: "Last 30 days" },
  { value: "MTD", label: "Month to date" },
  { value: "LASTMONTH", label: "Last full month" },
  { value: "CUSTOM", label: "Custom range" },
];

/**
 * Resolve a preset to a concrete window, clamped to what the saved data covers.
 *
 * Everything is measured from `latestDate` — the newest date the source actually
 * populated — not from the wall clock, so "last 7 days" never silently includes
 * days the source has not filled.
 */
export function resolveRange({ preset, latestDate, coverageFrom, customFrom, customTo }) {
  if (!latestDate) return ["", ""];
  let from;
  let to = latestDate;
  switch (preset) {
    case "7D": from = addDays(latestDate, -6); break;
    case "30D": from = addDays(latestDate, -29); break;
    case "MTD": from = monthStart(latestDate); break;
    case "LASTMONTH":
      from = monthStart(addDays(monthStart(latestDate), -1));
      to = addDays(monthStart(latestDate), -1);
      break;
    case "CUSTOM":
      from = customFrom || coverageFrom || latestDate;
      to = customTo || latestDate;
      break;
    default: from = latestDate;
  }
  if (coverageFrom && from < coverageFrom) from = coverageFrom;
  if (to > latestDate) to = latestDate;
  if (from > to) from = to;
  return [from, to];
}

/* ============================== THE DATA MODEL ============================== */

/** Safe addition that keeps `null` meaning "unavailable". */
function addMaybe(current, value) {
  if (value === null || value === undefined) return current;
  return (current === null ? 0 : current) + Number(value);
}

/**
 * Index the saved snapshot into per-country daily lookups.
 *
 * The snapshot is already aggregated to (country, date), so this is a cheap
 * reshape and stays fast for accounts with thousands of SKUs — the SKU dimension
 * was aggregated away server-side.
 */
export function brandViewModel(payload) {
  const countries = new Map();
  const ensure = (country, currency) => {
    const key = String(country || "").toUpperCase();
    const existing = countries.get(key);
    if (existing) {
      if (!existing.currency && currency) existing.currency = currency;
      return existing;
    }
    const created = {
      country: key,
      currency: currency || null,
      hasSales: false,
      adsAvailable: false,
      fbaAvailable: null,
      currencyConflict: false,
      // Which accounts sell this brand in this marketplace. Empty for the
      // single-account report; populated for the cross-account one, where it is
      // what tells the reader an India row is two accounts added together.
      accounts: [],
      byDate: new Map(),
    };
    countries.set(key, created);
    return created;
  };

  for (const meta of payload?.countries || []) {
    const entry = ensure(meta.country, meta.currency);
    entry.hasSales = Boolean(meta.hasSales);
    entry.adsAvailable = Boolean(meta.adsAvailable);
    entry.fbaAvailable = meta.fbaAvailable === null || meta.fbaAvailable === undefined ? null : Number(meta.fbaAvailable);
    entry.currencyConflict = Boolean(meta.currencyConflict);
    entry.accounts = Array.isArray(meta.accounts) ? meta.accounts : [];
  }

  for (const row of payload?.series || []) {
    const entry = ensure(row.c, row.cur);
    const day = entry.byDate.get(row.d) || { sales: 0, units: 0, adSpend: null, missingOrderValueUnits: 0 };
    day.sales += Number(row.s) || 0;
    day.units += Number(row.u) || 0;
    day.missingOrderValueUnits += Number(row.x) || 0;
    // `a` is absent when the saved Ads history has nothing for that country/day.
    if (row.a !== undefined && row.a !== null) day.adSpend = (day.adSpend === null ? 0 : day.adSpend) + Number(row.a);
    entry.byDate.set(row.d, day);
  }

  const coverage = payload?.coverage || {};
  return {
    brand: payload?.brand || "",
    // "account" for the single-account report, "portfolio" for the
    // cross-account one. The two share every calculation below; only the label
    // and the per-country account list differ.
    scope: payload?.scope || "account",
    accountId: payload?.accountId || "",
    accountName: payload?.accountName || null,
    accounts: payload?.accounts || [],
    asOf: payload?.asOf || null,
    countries: [...countries.values()].sort((a, b) => a.country.localeCompare(b.country)),
    coverage,
    notes: payload?.notes || [],
    // The last date the sales source actually populated. Every "today" and every
    // elapsed-day count is measured against this, not against the wall clock, so
    // a run rate is never diluted by dates the source has not filled yet.
    latestDate: coverage.salesLatestDate || null,
  };
}

/** Sum sales/units for one country over an inclusive date range. */
export function rangeSales(country, from, to) {
  let sales = 0;
  let units = 0;
  let missingOrderValueUnits = 0;
  for (const [date, day] of country.byDate) {
    if (date < from || date > to) continue;
    sales += day.sales;
    units += day.units;
    missingOrderValueUnits += day.missingOrderValueUnits;
  }
  return { sales, units, missingOrderValueUnits };
}

/**
 * Ad spend for one country over a range, or null when the saved Ads history
 * cannot answer for that whole range.
 *
 * Returning 0 for an unsynced marketplace would claim it spent nothing, and
 * returning a partial sum for a range that extends past the Ads window would
 * understate TACoS. Both are refused.
 */
export function rangeAdSpend(model, country, from, to) {
  if (!country.adsAvailable) return null;
  const countryCoverage = model.coverage?.adsCoverageByCountry?.[country.country];
  const adsFrom = countryCoverage?.from || model.coverage?.adsFrom;
  const adsTo = countryCoverage?.to || model.coverage?.adsTo;
  if (!adsFrom || !adsTo) return null;
  if (from < adsFrom || to > adsTo) return null;
  let spend = 0;
  for (const [date, day] of country.byDate) {
    if (date < from || date > to) continue;
    if (day.adSpend !== null) spend += day.adSpend;
  }
  return spend;
}

/**
 * The equivalent previous-year window, only when the saved snapshot fully covers
 * it. A partial last-year figure is worse than no figure, so this returns null
 * rather than a number the user would read as a real comparison.
 */
export function lastYearWindow(model, from, to) {
  const lyFrom = shiftYear(from, -1);
  const lyTo = shiftYear(to, -1);
  const { salesFrom, salesTo } = model.coverage || {};
  if (!lyFrom || !lyTo || !salesFrom || !salesTo) return null;
  if (lyFrom < salesFrom || lyTo > salesTo) return null;
  return { from: lyFrom, to: lyTo };
}

/** Month-to-date window and elapsed days, anchored to the latest populated date. */
export function mtdWindow(model, anchorDate) {
  const anchor = anchorDate || model.latestDate;
  const parts = parseDateStr(anchor);
  if (!parts) return null;
  return {
    from: monthStart(anchor),
    to: anchor,
    elapsedDays: parts.d,
    daysInMonth: daysInMonth(parts.y, parts.m),
    monthKey: `${anchor.slice(0, 7)}`,
  };
}

/**
 * Inventory cover in days: available FBA units divided by the brand's
 * average daily unit sales for the measured report range in that marketplace.
 */
export function inventoryCoverDays(fbaAvailable, unitsSold, elapsedDays) {
  if (fbaAvailable === null || fbaAvailable === undefined) return null;
  if (!Number.isFinite(Number(unitsSold)) || Number(unitsSold) <= 0) return null;
  if (!Number.isFinite(Number(elapsedDays)) || Number(elapsedDays) <= 0) return null;
  const dailyRunRate = Number(unitsSold) / Number(elapsedDays);
  if (dailyRunRate <= 0) return null;
  return Number(fbaAvailable) / dailyRunRate;
}

/** Inclusive calendar-day count for the report's selected sales window. */
function daysInSelectedRange(from, to) {
  const start = parseDateStr(from);
  const end = parseDateStr(to);
  if (!start || !end) return null;
  const startUtc = Date.UTC(start.y, start.m - 1, start.d);
  const endUtc = Date.UTC(end.y, end.m - 1, end.d);
  const days = Math.floor((endUtc - startUtc) / 86400000) + 1;
  return days > 0 ? days : null;
}

/** TACoS as a fraction. Null unless both a real spend and a real sales base exist. */
export function tacos(adSpend, sales) {
  if (adSpend === null || adSpend === undefined) return null;
  if (!Number.isFinite(Number(sales)) || Number(sales) <= 0) return null;
  return Number(adSpend) / Number(sales);
}

/* ============================ CURRENCY GROUPING ============================ */

/**
 * Split rows into the groups that may legitimately be totalled together.
 *
 * Original mode  -> one group per marketplace currency. There is deliberately no
 *                   combined group, because a EUR + GBP total is not a number.
 * Converted mode -> exactly one group, in the chosen display currency.
 *
 * `moneyFields` are the row keys that hold money in the row's own currency; each
 * is converted per row and then summed, so totals reconcile to the visible rows.
 */
export function currencyGroups(rows, displayCurrency, rates, moneyFields) {
  const converted = isConvertedMode(displayCurrency);
  const buckets = new Map();

  for (const row of rows) {
    const groupKey = converted ? displayCurrency : (row.currency || "UNKNOWN");
    const bucket = buckets.get(groupKey) || {
      key: groupKey,
      currency: converted ? displayCurrency : row.currency || null,
      converted,
      rows: [],
      totals: Object.fromEntries(moneyFields.map((field) => [field, null])),
      units: 0,
      fbaAvailable: null,
      unconvertible: false,
    };

    const displayRow = { ...row, displayCurrency: bucket.currency };
    for (const field of moneyFields) {
      const original = row[field];
      const value = converted ? convertMoney(original, row.currency, displayCurrency, rates) : (original ?? null);
      displayRow[field] = value;
      // A row whose currency has no rate makes itself unavailable but must not
      // silently drop out of the total and leave the total looking complete.
      if (converted && original !== null && original !== undefined && value === null) bucket.unconvertible = true;
      else bucket.totals[field] = addMaybe(bucket.totals[field], value);
    }
    bucket.units += Number(row.units) || 0;
    bucket.fbaAvailable = addMaybe(bucket.fbaAvailable, row.fbaAvailable);
    bucket.rows.push(displayRow);
    buckets.set(groupKey, bucket);
  }

  return [...buckets.values()].sort((a, b) => String(a.key).localeCompare(String(b.key)));
}

/** Share of a group total, as a fraction. Null when the base is not a real total. */
export function shareOf(value, total) {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(Number(total)) || Number(total) === 0) return null;
  return Number(value) / Number(total);
}

/* ============================ 1. DAILY SNAPSHOT ============================ */

/**
 * Per-country metrics for the selected date range, in each marketplace's own
 * currency. Presentation and conversion happen afterwards in `currencyGroups`.
 */
export function dailySnapshotRows(model, { from, to }) {
  const ly = lastYearWindow(model, from, to);
  const mtd = mtdWindow(model, to);
  const selectedRangeDays = daysInSelectedRange(from, to);
  const rows = [];

  for (const country of model.countries) {
    const current = rangeSales(country, from, to);
    const adSpend = rangeAdSpend(model, country, from, to);
    const lySales = ly ? rangeSales(country, ly.from, ly.to).sales : null;
    const coverDays = selectedRangeDays
      ? inventoryCoverDays(country.fbaAvailable, current.units, selectedRangeDays)
      : null;

    // A marketplace with no sales in the window is still shown when it holds
    // stock for the brand (the "FC only" case), and is hidden otherwise so no
    // unrelated marketplace appears.
    const relevant = current.sales !== 0 || current.units !== 0
      || adSpend !== null || country.fbaAvailable !== null;
    if (!relevant) continue;

    rows.push({
      key: country.country,
      country: country.country,
      currency: country.currency,
      accounts: country.accounts,
      currencyConflict: country.currencyConflict,
      sales: current.sales,
      units: current.units,
      missingOrderValueUnits: current.missingOrderValueUnits,
      adSpend,
      lySales,
      fbaAvailable: country.fbaAvailable,
      coverUnits: current.units,
      coverDays,
      salesOnly: !country.hasSales,
    });
  }

  return {
    rows,
    lastYearWindow: ly,
    mtd,
    selectedRangeDays,
    // Passed through so the All Markets row can show a real account-level FBA
    // total when the saved inventory source has no marketplace dimension.
    inventoryScope: model.coverage?.inventoryScope || "unavailable",
    inventoryAccountTotal: model.coverage?.inventoryAccountTotal ?? null,
  };
}

/* =========================== 2. MONTHLY SNAPSHOT =========================== */

/**
 * Five completed calendar months, the current month to date, and its run rate.
 *
 * Run rate = current-month actual / elapsed calendar days x days in the month,
 * where elapsed days come from the latest populated source date.
 */
export function monthlyColumns(model, anchorDate) {
  const anchor = anchorDate || model.latestDate;
  if (!parseDateStr(anchor)) return { completed: [], current: null };
  const completed = [];
  for (let back = 5; back >= 1; back -= 1) completed.push(monthBack(anchor, back));
  const parts = parseDateStr(anchor);
  return {
    completed,
    current: {
      key: `${parts.y}-${String(parts.m).padStart(2, "0")}`,
      from: monthStart(anchor),
      to: anchor,
      elapsedDays: parts.d,
      daysInMonth: daysInMonth(parts.y, parts.m),
    },
  };
}

export function monthlySnapshotRows(model, anchorDate) {
  const columns = monthlyColumns(model, anchorDate);
  const current = columns.current;
  const rows = [];

  for (const country of model.countries) {
    const byMonth = {};
    let any = false;
    for (const month of columns.completed) {
      const value = rangeSales(country, month.from, month.to).sales;
      byMonth[month.key] = value;
      if (value) any = true;
    }
    const currentActual = current ? rangeSales(country, current.from, current.to).sales : 0;
    if (currentActual) any = true;
    const runRate = current && current.elapsedDays > 0
      ? (currentActual / current.elapsedDays) * current.daysInMonth
      : null;
    const adSpend = current ? rangeAdSpend(model, country, current.from, current.to) : null;
    if (adSpend !== null) any = true;
    if (!any) continue;

    rows.push({
      key: country.country,
      country: country.country,
      currency: country.currency,
      accounts: country.accounts,
      byMonth,
      currentActual,
      runRate,
      adSpend,
      units: 0,
      fbaAvailable: null,
    });
  }

  return { columns, rows };
}

/* ========================== 3. 7-DAY PERFORMANCE ========================== */

export function sevenDayDates(anchorDate) {
  if (!parseDateStr(anchorDate)) return [];
  return Array.from({ length: 7 }, (unused, index) => addDays(anchorDate, index - 6));
}

/**
 * Per-country per-day sales, units and ad spend for the last seven days.
 *
 * Rows carry `byDate` so a currency group can total each day column from the
 * already-converted country values rather than converting a mixed total.
 */
export function sevenDayRows(model, anchorDate) {
  const dates = sevenDayDates(anchorDate);
  const rows = [];

  for (const country of model.countries) {
    const byDate = {};
    let anySales = 0;
    let anyUnits = 0;
    let adSpendTotal = null;
    for (const date of dates) {
      const day = country.byDate.get(date);
      const sales = day ? day.sales : 0;
      const units = day ? day.units : 0;
      const adSpend = rangeAdSpend(model, country, date, date);
      byDate[date] = { sales, units, adSpend };
      anySales += sales;
      anyUnits += units;
      adSpendTotal = addMaybe(adSpendTotal, adSpend);
    }
    if (!anySales && !anyUnits && adSpendTotal === null) continue;
    rows.push({
      key: country.country,
      country: country.country,
      currency: country.currency,
      accounts: country.accounts,
      byDate,
      sales: anySales,
      units: anyUnits,
      adSpend: adSpendTotal,
      fbaAvailable: null,
    });
  }

  return { dates, rows };
}

/**
 * Total one seven-day column for a currency group.
 *
 * Every country's value is converted first and the converted values are summed,
 * so the visible day total equals the sum of the visible country values.
 */
export function sevenDayColumnTotals(group, dates, displayCurrency, rates) {
  const converted = isConvertedMode(displayCurrency);
  const totals = {};
  for (const date of dates) {
    let sales = null;
    let units = 0;
    let adSpend = null;
    let unconvertible = false;
    for (const row of group.rows) {
      const day = row.byDate?.[date];
      if (!day) continue;
      units += Number(day.units) || 0;
      const daySales = converted ? convertMoney(day.sales, row.currency, displayCurrency, rates) : day.sales;
      if (converted && day.sales !== null && daySales === null) unconvertible = true;
      else sales = addMaybe(sales, daySales);
      const daySpend = converted ? convertMoney(day.adSpend, row.currency, displayCurrency, rates) : day.adSpend;
      if (converted && day.adSpend !== null && day.adSpend !== undefined && daySpend === null) unconvertible = true;
      else adSpend = addMaybe(adSpend, daySpend);
    }
    totals[date] = { sales, units, adSpend, tacos: tacos(adSpend, sales), unconvertible };
  }
  return totals;
}
