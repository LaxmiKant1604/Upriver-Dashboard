// The three Brand View tables, as data.
//
// WHY THIS IS A MODULE AND NOT JSX
//   The account-scoped report and the cross-account portfolio report render the
//   same three tables from the same payload shape. Building them here means the
//   two pages cannot drift apart, the export cannot disagree with the screen
//   (both consume this output), and the whole thing is unit-testable without a
//   browser.
//
//   A table is `{ headers: [{key,label,hint}], rows: [row] }` where a row is
//   `{ key, kind, label, sublabel, subcells, hints, cells }` and each cell is
//   `{ t }` or `{ t, n }` — display text plus the raw number for Excel.
//
// THE RULES IT PRESERVES
//   - An unavailable value is an em dash. Never a zero.
//   - Money is only ever totalled inside one currency group.
//   - Share of total is measured against the group the row belongs to, because
//     a share across currencies is not a number.

import { FLAGS, fmtDateHuman, fmtMoney, monthKeyLabel, nInt } from "./format.js";
import { marketplaceProfile } from "../../lib/marketplaces.js";
import {
  currencyGroups, dailySnapshotRows, inventoryCoverDays, isConvertedMode,
  monthlySnapshotRows, sevenDayColumnTotals, sevenDayRows, shareOf, tacos,
  unconvertibleCurrencies,
} from "./brand-view.js";

export const DASH = "—";
// The reference report distinguishes "this metric has no value here" (an em
// dash) from "this marketplace has no inventory record at all" (n/a). Keeping
// both is more informative than collapsing them, and neither is ever a zero.
export const NA = "n/a";
// Ad spend is routinely a fraction of a currency unit, so it keeps two decimals
// while sales figures stay whole units. This mirrors the reference report.
export const SALES_DECIMALS = 0;
export const SPEND_DECIMALS = 2;

/* ============================== FORMATTERS ============================== */

export function countryLabel(code) {
  if (!code) return "Unknown marketplace";
  const profile = marketplaceProfile(code);
  if (profile.countryName && profile.countryName !== "Marketplace") return profile.countryName;
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) || code;
  } catch (error) {
    return code;
  }
}

export function countryTitle(code) {
  return `${FLAGS[code] || ""} ${countryLabel(code)}`.trim();
}

export function money(value, currency, decimals = SALES_DECIMALS, country) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return DASH;
  return fmtMoney(Number(value), currency, decimals, country);
}

export function ratePct(value, decimals = 1) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return DASH;
  return `${(Number(value) * 100).toFixed(decimals)}%`;
}

/**
 * Inventory cover in months, e.g. "3.0m".
 *
 * Months rather than days because that is the unit restock decisions are made
 * in, and it is what the report this screen replaces used. The exact day count
 * is in the cell tooltip, so nothing is lost.
 */
export function coverLabel(days, fallback = DASH) {
  if (days === null || days === undefined || !Number.isFinite(Number(days))) return fallback;
  const rounded = Math.round(Number(days));
  return `${rounded.toLocaleString("en-US")} day${rounded === 1 ? "" : "s"}`;
}

export function coverHint(days) {
  if (days === null || days === undefined || !Number.isFinite(Number(days))) return undefined;
  return `${Math.round(Number(days)).toLocaleString("en-US")} days of cover at this brand's average daily unit sales for the selected report range`;
}

/**
 * Share of a group total, for the small line under a value.
 *
 * Returns null when the group has a single marketplace: "100.0%" under every
 * figure is noise, and the brief asked for the share only where it can be shown
 * without crowding the table.
 */
function sharePct(value, total, groupSize) {
  if (groupSize !== undefined && groupSize < 2) return null;
  const share = shareOf(value, total);
  return share === null ? null : `${(share * 100).toFixed(1)}%`;
}

/** An export/display cell: `t` is the text, `n` the raw number for Excel. */
export function cell(text, number) {
  return number === null || number === undefined || !Number.isFinite(Number(number))
    ? { t: text }
    : { t: text, n: Number(number) };
}

/**
 * The country cell.
 *
 * Deliberately spare: a flag, a name, and a short inline qualifier only when
 * there is something real to say. Everything else that used to sit under the
 * name (currency, account names) is either in the currency band above the group
 * or in the row tooltip, because a sub-line on every row made the table hard to
 * scan.
 */
function countryCellLabel(row) {
  const parts = [countryTitle(row.country)];
  // The reference report's "(FC only)": stock in a marketplace with no sales.
  if (row.salesOnly) parts.push("(FC only)");
  return parts.join(" ");
}

function countryCellTitle(row, { scope }) {
  const parts = [];
  if (scope === "portfolio" && row.accounts?.length) {
    parts.push(row.accounts.length > 1
      ? `Combined from ${row.accounts.length} accounts: ${row.accounts.join(", ")}`
      : row.accounts[0]);
  }
  if (row.salesOnly) parts.push("Holds FBA inventory for this brand but recorded no sales in the selected range.");
  if (row.currencyConflict) parts.push("This marketplace reported more than one currency in the saved data.");
  return parts.join(" · ") || undefined;
}

/**
 * The band that introduces a currency group.
 *
 * Rendered only when the report has more than one currency. With a single
 * currency — which is every converted view, and every single-marketplace-region
 * account — the table reads exactly like one plain table with one All Markets
 * row, which is the shape this report is meant to have.
 */
function currencyBand(group, displayCurrency, index) {
  const currency = group.converted ? displayCurrency : (group.currency || "currency unavailable");
  const count = group.rows.length;
  return {
    key: `band-${group.key}-${index}`,
    kind: "band",
    cells: [{ t: `${currency} · ${count} marketplace${count === 1 ? "" : "s"}` }],
  };
}

/**
 * Should this group get an All Markets total row?
 *
 * A group with one marketplace would print the same figures twice, once as
 * "All Markets" and once as the country. So the total is shown when the group
 * actually aggregates something, or when it is the only group — in which case
 * the report still needs its top line, exactly as the reference report has.
 */
function showsTotalRow(group, groupCount) {
  return group.rows.length > 1 || groupCount === 1;
}

// Daily keeps a sales-and-inventory focus. Monthly exposes current-month ad
// spend and TACoS, while the 7-Day report exposes them day by day.
function withoutAdvertisingColumns({ headers, rows }, { showAdvertising = false } = {}) {
  const visibleIndexes = headers
    .map((header, index) => ({ header, index }))
    .filter(({ header }) => showAdvertising || (header.key !== "spend" && header.key !== "tacos"))
    .map(({ index }) => index);

  return {
    headers: visibleIndexes.map((index) => {
      const header = headers[index];
      return header.key === "cover"
        ? {
          ...header,
          label: "FBA Cover (days)",
          hint: "Available FBA units divided by this brand's average daily unit sales in the selected report range.",
        }
        : header;
    }),
    rows: rows
      .filter((row) => showAdvertising || (row.label !== "Ad Spend" && row.label !== "TACoS%"))
      .map((row) => {
        if (row.kind === "section" || row.kind === "band") return row;
        const subcells = row.subcells
          ? Object.fromEntries(visibleIndexes
            .map((oldIndex, newIndex) => [newIndex, row.subcells[oldIndex]])
            .filter(([, value]) => value !== undefined))
          : undefined;
        return {
          ...row,
          cells: visibleIndexes.map((index) => row.cells[index]),
          hints: row.hints ? visibleIndexes.map((index) => row.hints[index]) : undefined,
          subcells,
        };
      }),
  };
}
/* ============================== 1. DAILY ============================== */

export function buildDailyTable({ daily, groups, displayCurrency, scope }) {
  if (!daily) return null;
  const converted = isConvertedMode(displayCurrency);
  const banded = groups.length > 1;
  const suffix = converted ? ` (${displayCurrency})` : "";
  const headers = [
    { key: "country", label: "Country" },
    { key: "sales", label: `Total Sales${suffix}` },
    { key: "ly", label: `LY Sales${suffix}`, hint: "The equivalent period one year earlier. Shown only when the saved snapshot fully covers that window." },
    { key: "spend", label: `Ad Spend${suffix}`, hint: "Ad Spend from Campaign Ads campaigns mapped to this brand, for this marketplace and window. A dash means Ads are unavailable, or the marketplace has campaign spend not yet mapped to a brand (unknown attribution) — never zero spend." },
    { key: "tacos", label: "TACoS%", hint: "This brand's Ad Spend divided by its Total Sales for the same marketplace and window; All Markets divides aggregated spend by aggregated sales." },
    { key: "fba", label: "FBA Inv.", tone: "positive", hint: "Available FBA units for this brand's ASINs from the latest saved FBA snapshot. Never currency converted." },
    { key: "cover", label: "Inv Cover", tone: "positive", hint: "Months of cover: available FBA units divided by this brand's month-to-date daily unit run rate." },
    { key: "units", label: "Units" },
  ];

  // When the saved inventory source has no marketplace dimension its total is
  // real but cannot be attributed to a country. It is shown on the All Markets
  // row only when the report has a single currency group, so it is never
  // silently assigned to one currency out of several.
  const unattributedFba = daily.inventoryScope !== "country" && groups.length === 1
    ? daily.inventoryAccountTotal
    : null;

  const rows = [];
  groups.forEach((group, index) => {
    if (banded) rows.push(currencyBand(group, displayCurrency, index));

    // All Markets Ad Spend is COMPLETE only when EVERY contributing marketplace has an available spend for this
    // window (saved Ads coverage AND, in converted mode, a display-currency rate). currencyGroups sums with addMaybe,
    // which silently omits an unavailable marketplace and would leave the total reading as complete -- so when any
    // marketplace is unavailable, WITHHOLD the All Markets Ad Spend + TACoS (em dash + tooltip) instead of showing a
    // partial figure. A genuine covered zero (every marketplace present, summing to 0) still shows 0.
    const adSpendComplete = group.rows.every((row) => row.adSpend !== null && row.adSpend !== undefined);
    const groupAdSpend = adSpendComplete ? group.totals.adSpend : null;
    const groupTacos = tacos(groupAdSpend, group.totals.sales);
    const partialSpendHint = adSpendComplete ? undefined
      : "Withheld: at least one marketplace has no Ad Spend for this window (no saved Ads coverage, or no exchange rate to the display currency), so the All Markets Ad Spend and TACoS are not shown as a partial total.";
    const groupFba = group.fbaAvailable === null ? unattributedFba : group.fbaAvailable;
    const groupRangeUnits = group.rows.reduce((sum, row) => sum + (Number(row.coverUnits) || 0), 0);
    const groupCover = daily.selectedRangeDays
      ? inventoryCoverDays(groupFba, groupRangeUnits, daily.selectedRangeDays)
      : null;
    if (showsTotalRow(group, groups.length)) rows.push({
      key: `total-${group.key}`,
      kind: "total",
      label: "All Markets",
      hints: [undefined, undefined, undefined, partialSpendHint, partialSpendHint, undefined, coverHint(groupCover), undefined],
      cells: [
        cell("All Markets"),
        cell(money(group.totals.sales, group.currency, SALES_DECIMALS), group.totals.sales),
        cell(money(group.totals.lySales, group.currency, SALES_DECIMALS), group.totals.lySales),
        cell(money(groupAdSpend, group.currency, SPEND_DECIMALS), groupAdSpend),
        cell(ratePct(groupTacos), groupTacos === null ? null : groupTacos * 100),
        cell(groupFba === null ? NA : nInt(groupFba), groupFba),
        cell(coverLabel(groupCover, NA), groupCover),
        cell(nInt(group.units), group.units),
      ],
    });

    for (const row of group.rows) {
      const rowTacos = tacos(row.adSpend, row.sales);
      rows.push({
        key: `${group.key}-${row.country}`,
        kind: "row",
        label: countryCellLabel(row),
        labelTitle: countryCellTitle(row, { scope }),
        subcells: { 1: sharePct(row.sales, group.totals.sales, group.rows.length) },
        hints: [undefined, undefined, undefined, undefined, undefined, undefined, coverHint(row.coverDays), undefined],
        cells: [
          cell(countryCellLabel(row)),
          cell(money(row.sales, row.displayCurrency, SALES_DECIMALS, converted ? undefined : row.country), row.sales),
          cell(money(row.lySales, row.displayCurrency, SALES_DECIMALS, converted ? undefined : row.country), row.lySales),
          cell(money(row.adSpend, row.displayCurrency, SPEND_DECIMALS, converted ? undefined : row.country), row.adSpend),
          cell(ratePct(rowTacos), rowTacos === null ? null : rowTacos * 100),
          cell(row.fbaAvailable === null ? NA : nInt(row.fbaAvailable), row.fbaAvailable),
          cell(coverLabel(row.coverDays, NA), row.coverDays),
          cell(nInt(row.units), row.units),
        ],
      });
    }
  });
  // Daily Snapshot now shows Ad Spend + TACoS% (between LY Sales and FBA Inv.) for every brand and marketplace,
  // including the All Markets row -- the same canonical Brand View model + saved Ads evidence the Monthly and 7-Day
  // reports already display. showAdvertising:true keeps the two columns (screen + Excel/CSV/print share this builder).
  return withoutAdvertisingColumns({ headers, rows }, { showAdvertising: true });
}

/* ============================== 2. MONTHLY ============================== */

export function buildMonthlyTable({ monthly, groups, displayCurrency, scope }) {
  if (!monthly || !monthly.columns.current) return null;
  const converted = isConvertedMode(displayCurrency);
  const banded = groups.length > 1;
  const current = monthly.columns.current;
  const completed = monthly.columns.completed;
  const currentLabel = monthKeyLabel(current.key).replace(/ '\d\d$/, "");
  const headers = [
    { key: "country", label: "Country" },
    ...completed.map((month) => ({ key: month.key, label: monthKeyLabel(month.key) })),
    { key: "actual", label: `${currentLabel} Act.`, tone: "positive", hint: `Month to date, ${current.from} to ${current.to}.` },
    { key: "runrate", label: `${currentLabel} RR`, tone: "positive", hint: `Run rate = actual / ${current.elapsedDays} elapsed days x ${current.daysInMonth} days in the month.` },
    { key: "spend", label: "Ad Spend", tone: "accent", hint: "Ad Spend from Campaign Ads campaigns mapped to this brand, for the current month to date. A dash means unavailable, not zero." },
    { key: "tacos", label: "TACoS%", tone: "accent" },
  ];

  const rows = [];
  groups.forEach((group, index) => {
    if (banded) rows.push(currencyBand(group, displayCurrency, index));

    const groupTacos = tacos(group.totals.adSpend, group.totals.currentActual);
    if (showsTotalRow(group, groups.length)) rows.push({
      key: `total-${group.key}`,
      kind: "total",
      label: "All Markets",
      cells: [
        cell("All Markets"),
        ...completed.map((month) => {
          const value = group.totals[`m_${month.key}`];
          return cell(money(value, group.currency, SALES_DECIMALS), value);
        }),
        cell(money(group.totals.currentActual, group.currency, SALES_DECIMALS), group.totals.currentActual),
        cell(money(group.totals.runRate, group.currency, SALES_DECIMALS), group.totals.runRate),
        cell(money(group.totals.adSpend, group.currency, SPEND_DECIMALS), group.totals.adSpend),
        cell(ratePct(groupTacos), groupTacos === null ? null : groupTacos * 100),
      ],
    });

    for (const row of group.rows) {
      const rowTacos = tacos(row.adSpend, row.currentActual);
      // Share of the total this row may legitimately be compared against: its
      // own currency group in original mode, the single converted total
      // otherwise. A share across currencies would be meaningless.
      const subcells = {};
      completed.forEach((month, monthIndex) => {
        subcells[monthIndex + 1] = sharePct(row[`m_${month.key}`], group.totals[`m_${month.key}`], group.rows.length);
      });
      subcells[completed.length + 1] = sharePct(row.currentActual, group.totals.currentActual, group.rows.length);
      subcells[completed.length + 2] = sharePct(row.runRate, group.totals.runRate, group.rows.length);
      rows.push({
        key: `${group.key}-${row.country}`,
        kind: "row",
        label: countryCellLabel(row),
        labelTitle: countryCellTitle(row, { scope }),
        subcells,
        cells: [
          cell(countryCellLabel(row)),
          ...completed.map((month) => {
            const value = row[`m_${month.key}`];
            return cell(money(value, row.displayCurrency, SALES_DECIMALS, converted ? undefined : row.country), value);
          }),
          cell(money(row.currentActual, row.displayCurrency, SALES_DECIMALS, converted ? undefined : row.country), row.currentActual),
          cell(money(row.runRate, row.displayCurrency, SALES_DECIMALS, converted ? undefined : row.country), row.runRate),
          cell(money(row.adSpend, row.displayCurrency, SPEND_DECIMALS, converted ? undefined : row.country), row.adSpend),
          cell(ratePct(rowTacos), rowTacos === null ? null : rowTacos * 100),
        ],
      });
    }
  });
  return withoutAdvertisingColumns({ headers, rows }, { showAdvertising: true });
}

/* ============================== 3. 7-DAY ============================== */

export function buildWeeklyTable({ weekly, groups, displayCurrency, rates, scope }) {
  if (!weekly || !weekly.dates.length) return null;
  const converted = isConvertedMode(displayCurrency);
  const banded = groups.length > 1;
  const dates = weekly.dates;
  const latest = dates[dates.length - 1];
  const shortDate = (date) => fmtDateHuman(date).replace(/, \d{4}$/, "");
  const headers = [
    { key: "metric", label: "Metric" },
    ...dates.map((date) => ({ key: date, label: shortDate(date), tone: date === latest ? "latest" : undefined })),
    { key: "total", label: "7D Total", tone: "total" },
  ];

  const rows = [];
  groups.forEach((group, index) => {
    if (banded) rows.push(currencyBand(group, displayCurrency, index));

    const totals = sevenDayColumnTotals(group, dates, displayCurrency, rates);
    const weekSales = group.totals.sales;
    const weekSpend = group.totals.adSpend;
    const weekTacos = tacos(weekSpend, weekSales);

    rows.push({
      key: `sales-${group.key}`, kind: "total", label: "Total Sales",
      cells: [
        cell("Total Sales"),
        ...dates.map((date) => cell(money(totals[date].sales, group.currency, SALES_DECIMALS), totals[date].sales)),
        cell(money(weekSales, group.currency, SALES_DECIMALS), weekSales),
      ],
    });
    rows.push({
      key: `units-${group.key}`, kind: "row", label: "Units",
      cells: [
        cell("Units"),
        ...dates.map((date) => cell(nInt(totals[date].units), totals[date].units)),
        cell(nInt(group.units), group.units),
      ],
    });
    rows.push({
      key: `spend-${group.key}`, kind: "row", label: "Ad Spend",
      cells: [
        cell("Ad Spend"),
        ...dates.map((date) => cell(money(totals[date].adSpend, group.currency, SPEND_DECIMALS), totals[date].adSpend)),
        cell(money(weekSpend, group.currency, SPEND_DECIMALS), weekSpend),
      ],
    });
    rows.push({
      key: `tacos-${group.key}`, kind: "row", label: "TACoS%",
      cells: [
        cell("TACoS%"),
        ...dates.map((date) => {
          const value = totals[date].tacos;
          return cell(ratePct(value), value === null ? null : value * 100);
        }),
        cell(ratePct(weekTacos), weekTacos === null ? null : weekTacos * 100),
      ],
    });
  });

  // Units are counts, not money, so this section is one list across every
  // marketplace rather than one block per currency.
  rows.push({ key: "units-section", kind: "section", cells: [cell("Units by country")] });
  for (const row of weekly.rows) {
    rows.push({
      key: `country-${row.country}`,
      kind: "row",
      label: countryCellLabel(row),
      labelTitle: countryCellTitle(row, { scope }),
      cells: [
        cell(countryCellLabel(row)),
        ...dates.map((date) => {
          const units = row.byDate[date]?.units || 0;
          return cell(units ? nInt(units) : DASH, units || null);
        }),
        cell(nInt(row.units), row.units),
      ],
    });
  }

  return withoutAdvertisingColumns({ headers, rows }, { showAdvertising: true });
}

/* ========================= THE ONE ENTRY POINT ========================= */

/**
 * Everything both Brand View pages need to render, from one model.
 *
 * @param {object} model            output of `brandViewModel`
 * @param {string} options.rangeFrom  Daily Snapshot window start
 * @param {string} options.rangeTo    Daily Snapshot window end, also the anchor
 *                                    for the Monthly and 7-Day reports
 * @param {string} options.displayCurrency  ORIGINAL_CURRENCY or an ISO code
 * @param {object|null} options.rates       the FX table, or null
 */
export function buildBrandTables(model, { rangeFrom, rangeTo, displayCurrency, rates }) {
  if (!model) return null;
  const scope = model.scope || "account";
  const anchor = rangeTo || model.latestDate;

  const daily = rangeFrom && rangeTo ? dailySnapshotRows(model, { from: rangeFrom, to: rangeTo }) : null;
  const monthly = anchor ? monthlySnapshotRows(model, anchor) : null;
  const weekly = anchor ? sevenDayRows(model, anchor) : null;

  const dailyGroups = daily ? currencyGroups(daily.rows, displayCurrency, rates, ["sales", "lySales", "adSpend"]) : [];
  const monthlyGroups = monthly
    ? currencyGroups(
      monthly.rows.map((row) => {
        const flat = { ...row };
        monthly.columns.completed.forEach((month) => { flat[`m_${month.key}`] = row.byMonth[month.key] ?? null; });
        return flat;
      }),
      displayCurrency,
      rates,
      [...monthly.columns.completed.map((month) => `m_${month.key}`), "currentActual", "runRate", "adSpend"]
    )
    : [];
  const weeklyGroups = weekly ? currencyGroups(weekly.rows, displayCurrency, rates, ["sales", "adSpend"]) : [];

  return {
    scope,
    anchor,
    daily,
    monthly,
    weekly,
    dailyGroups,
    monthlyGroups,
    weeklyGroups,
    dailyTable: buildDailyTable({ daily, groups: dailyGroups, displayCurrency, scope }),
    monthlyTable: buildMonthlyTable({ monthly, groups: monthlyGroups, displayCurrency, scope }),
    weeklyTable: buildWeeklyTable({ weekly, groups: weeklyGroups, displayCurrency, rates, scope }),
    missingRates: unconvertibleCurrencies(
      model.countries.map((entry) => entry.currency).filter(Boolean),
      displayCurrency,
      rates
    ),
    totalUnits: dailyGroups.reduce((sum, group) => sum + group.units, 0),
    marketplaceCount: daily?.rows.length || 0,
  };
}
