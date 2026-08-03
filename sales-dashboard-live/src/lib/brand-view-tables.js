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

export function coverLabel(days) {
  if (days === null || days === undefined || !Number.isFinite(Number(days))) return DASH;
  return `${Math.round(Number(days)).toLocaleString("en-US")} d`;
}

export function coverHint(days) {
  if (days === null || days === undefined || !Number.isFinite(Number(days))) return undefined;
  // 30.44 = mean days per calendar month, so the month equivalent is honest.
  return `${(Number(days) / 30.44).toFixed(1)} months of cover at the current month-to-date daily run rate`;
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

/** The small grey line under a country name. */
function countrySublabel(row, { converted, scope }) {
  const parts = [];
  if (row.salesOnly) parts.push("Inventory only (no sales in range)");
  if (scope === "portfolio" && row.accounts?.length) parts.push(row.accounts.join(", "));
  parts.push(converted ? `from ${row.currency || "unknown currency"}` : row.currency);
  if (row.currencyConflict) parts.push("multiple currencies reported");
  return parts.filter(Boolean).join(" · ");
}

function groupSublabel(group, displayCurrency, suffix) {
  const currency = group.converted ? displayCurrency : (group.currency || "currency unavailable");
  return suffix ? `${suffix} · ${currency}` : currency;
}

/* ============================== 1. DAILY ============================== */

export function buildDailyTable({ daily, groups, displayCurrency, scope }) {
  if (!daily) return null;
  const converted = isConvertedMode(displayCurrency);
  const headers = [
    { key: "country", label: "Country" },
    { key: "sales", label: converted ? `Sales (${displayCurrency})` : "Sales" },
    { key: "ly", label: converted ? `Last year sales (${displayCurrency})` : "Last year sales", hint: "Shown only when the saved snapshot fully covers the equivalent previous-year window." },
    { key: "spend", label: converted ? `Ad spend (${displayCurrency})` : "Ad spend", hint: "Same-ASIN advertising spend for this brand only. Blank means the saved Ads history cannot answer for this marketplace and window — not zero spend." },
    { key: "tacos", label: "TACoS", hint: "Brand ad spend divided by brand sales for the same marketplace and window." },
    { key: "fba", label: "FBA inventory", hint: "Available FBA units for this brand's ASINs from the latest saved FBA snapshot. Never converted." },
    { key: "cover", label: "Inv. cover (days)", hint: "Available FBA units divided by this brand's month-to-date daily unit run rate." },
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
  for (const group of groups) {
    const groupTacos = tacos(group.totals.adSpend, group.totals.sales);
    const groupFba = group.fbaAvailable === null ? unattributedFba : group.fbaAvailable;
    const groupMtdUnits = group.rows.reduce((sum, row) => sum + (Number(row.mtdUnits) || 0), 0);
    const groupCover = daily.mtd ? inventoryCoverDays(groupFba, groupMtdUnits, daily.mtd.elapsedDays) : null;
    rows.push({
      key: `total-${group.key}`,
      kind: "total",
      label: "All Markets",
      sublabel: groupSublabel(group, displayCurrency, `${group.rows.length} marketplace${group.rows.length === 1 ? "" : "s"}`),
      hints: [undefined, undefined, undefined, undefined, undefined, undefined, coverHint(groupCover), undefined],
      cells: [
        cell("All Markets"),
        cell(money(group.totals.sales, group.currency, SALES_DECIMALS), group.totals.sales),
        cell(money(group.totals.lySales, group.currency, SALES_DECIMALS), group.totals.lySales),
        cell(money(group.totals.adSpend, group.currency, SPEND_DECIMALS), group.totals.adSpend),
        cell(ratePct(groupTacos), groupTacos === null ? null : groupTacos * 100),
        cell(groupFba === null ? DASH : nInt(groupFba), groupFba),
        cell(coverLabel(groupCover), groupCover === null ? null : Math.round(groupCover)),
        cell(nInt(group.units), group.units),
      ],
    });
    for (const row of group.rows) {
      const rowTacos = tacos(row.adSpend, row.sales);
      rows.push({
        key: `${group.key}-${row.country}`,
        kind: "row",
        label: countryTitle(row.country),
        sublabel: countrySublabel(row, { converted, scope }),
        subcells: { 1: sharePct(row.sales, group.totals.sales, group.rows.length) },
        hints: [undefined, undefined, undefined, undefined, undefined, undefined, coverHint(row.coverDays), undefined],
        cells: [
          cell(countryTitle(row.country)),
          cell(money(row.sales, row.displayCurrency, SALES_DECIMALS, converted ? undefined : row.country), row.sales),
          cell(money(row.lySales, row.displayCurrency, SALES_DECIMALS, converted ? undefined : row.country), row.lySales),
          cell(money(row.adSpend, row.displayCurrency, SPEND_DECIMALS, converted ? undefined : row.country), row.adSpend),
          cell(ratePct(rowTacos), rowTacos === null ? null : rowTacos * 100),
          cell(row.fbaAvailable === null ? DASH : nInt(row.fbaAvailable), row.fbaAvailable),
          cell(coverLabel(row.coverDays), row.coverDays === null ? null : Math.round(row.coverDays)),
          cell(nInt(row.units), row.units),
        ],
      });
    }
  }
  return { headers, rows };
}

/* ============================== 2. MONTHLY ============================== */

export function buildMonthlyTable({ monthly, groups, displayCurrency, scope }) {
  if (!monthly || !monthly.columns.current) return null;
  const converted = isConvertedMode(displayCurrency);
  const current = monthly.columns.current;
  const completed = monthly.columns.completed;
  const headers = [
    { key: "country", label: "Country" },
    ...completed.map((month) => ({ key: month.key, label: monthKeyLabel(month.key) })),
    { key: "actual", label: `${monthKeyLabel(current.key)} actual`, hint: `Month to date, ${current.from} to ${current.to}.` },
    { key: "runrate", label: `${monthKeyLabel(current.key)} run rate`, hint: `Actual / ${current.elapsedDays} elapsed days x ${current.daysInMonth} days in month.` },
    { key: "spend", label: "Ad spend (MTD)", hint: "Brand same-ASIN spend for the current month to date. Blank means unavailable, not zero." },
    { key: "tacos", label: "TACoS (MTD)" },
  ];

  const rows = [];
  for (const group of groups) {
    const groupTacos = tacos(group.totals.adSpend, group.totals.currentActual);
    rows.push({
      key: `total-${group.key}`,
      kind: "total",
      label: "All Markets",
      sublabel: groupSublabel(group, displayCurrency, `${group.rows.length} marketplace${group.rows.length === 1 ? "" : "s"}`),
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
      // otherwise.
      const subcells = {};
      completed.forEach((month, index) => {
        subcells[index + 1] = sharePct(row[`m_${month.key}`], group.totals[`m_${month.key}`], group.rows.length);
      });
      subcells[completed.length + 1] = sharePct(row.currentActual, group.totals.currentActual, group.rows.length);
      rows.push({
        key: `${group.key}-${row.country}`,
        kind: "row",
        label: countryTitle(row.country),
        sublabel: countrySublabel(row, { converted, scope }),
        subcells,
        cells: [
          cell(countryTitle(row.country)),
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
  }
  return { headers, rows };
}

/* ============================== 3. 7-DAY ============================== */

export function buildWeeklyTable({ weekly, groups, displayCurrency, rates, scope }) {
  if (!weekly || !weekly.dates.length) return null;
  const converted = isConvertedMode(displayCurrency);
  const dates = weekly.dates;
  const shortDate = (date) => fmtDateHuman(date).replace(/, \d{4}$/, "");
  const headers = [
    { key: "metric", label: "Metric" },
    ...dates.map((date, index) => ({
      key: date,
      label: index === dates.length - 1 ? `${shortDate(date)} (latest)` : shortDate(date),
    })),
    { key: "total", label: "7-day total" },
  ];

  const rows = [];
  for (const group of groups) {
    const totals = sevenDayColumnTotals(group, dates, displayCurrency, rates);
    const label = group.converted ? displayCurrency : (group.currency || "currency unavailable");
    const weekSales = group.totals.sales;
    const weekSpend = group.totals.adSpend;
    const weekTacos = tacos(weekSpend, weekSales);

    rows.push({
      key: `sales-${group.key}`, kind: "total", label: "Daily sales", sublabel: label,
      cells: [
        cell("Daily sales"),
        ...dates.map((date) => cell(money(totals[date].sales, group.currency, SALES_DECIMALS), totals[date].sales)),
        cell(money(weekSales, group.currency, SALES_DECIMALS), weekSales),
      ],
    });
    rows.push({
      key: `units-${group.key}`, kind: "row", label: "Units", sublabel: label,
      cells: [
        cell("Units"),
        ...dates.map((date) => cell(nInt(totals[date].units), totals[date].units)),
        cell(nInt(group.units), group.units),
      ],
    });
    rows.push({
      key: `spend-${group.key}`, kind: "row", label: "Ad spend", sublabel: label,
      cells: [
        cell("Ad spend"),
        ...dates.map((date) => cell(money(totals[date].adSpend, group.currency, SPEND_DECIMALS), totals[date].adSpend)),
        cell(money(weekSpend, group.currency, SPEND_DECIMALS), weekSpend),
      ],
    });
    rows.push({
      key: `tacos-${group.key}`, kind: "row", label: "TACoS", sublabel: label,
      cells: [
        cell("TACoS"),
        ...dates.map((date) => {
          const value = totals[date].tacos;
          return cell(ratePct(value), value === null ? null : value * 100);
        }),
        cell(ratePct(weekTacos), weekTacos === null ? null : weekTacos * 100),
      ],
    });
  }

  // Units are counts, not money, so this section is one list across every
  // marketplace rather than one block per currency.
  rows.push({ key: "units-section", kind: "section", cells: [cell("Units by country")] });
  for (const row of weekly.rows) {
    rows.push({
      key: `country-${row.country}`,
      kind: "row",
      label: countryTitle(row.country),
      sublabel: countrySublabel(row, { converted, scope }),
      cells: [
        cell(countryTitle(row.country)),
        ...dates.map((date) => {
          const units = row.byDate[date]?.units || 0;
          return cell(units ? nInt(units) : DASH, units || null);
        }),
        cell(nInt(row.units), row.units),
      ],
    });
  }

  return { headers, rows };
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
