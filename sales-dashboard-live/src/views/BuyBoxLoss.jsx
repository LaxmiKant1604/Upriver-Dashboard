// Buy Box Loss — SKUs losing the featured offer, the revenue that costs, and
// whether price, stock or fulfilment explains it.

import React, { useMemo, useState } from "react";
import { Trophy } from "lucide-react";

import {
  buildBuyBoxInsights,
  buildBuyBoxRows,
  insightExportRows,
} from "../lib/insights.js";
import { downloadCsv, reportFilename } from "../lib/csv.js";
import { fmtDateHuman, fmtMoney, fmtRate, nInt } from "../lib/format.js";
import {
  ExportButton,
  FreshnessBar,
  IdentityCell,
  Notice,
  Pagination,
  PriorityActions,
  ReportHeader,
  SearchField,
  SelectField,
  SnapshotState,
  SortTh,
  StatRow,
  StaleScopeNotice,
  moneyScope,
  snapshotFreshnessLabel,
  totalMoney,
  sortRows,
  useSortState,
} from "./shared.jsx";

const PAGE_SIZE = 50;

const CAUSE_LABEL = {
  price: "Price",
  stock: "Stock",
  fulfilment: "Fulfilment",
  unconfirmed: "Unconfirmed",
};

const CAUSE_TONE = {
  price: "warn",
  stock: "bad",
  fulfilment: "warn",
  unconfirmed: "ok",
};

const ACCESSORS = {
  productName: (row) => String(row.productName || row.sku || "").toLowerCase(),
  sku: (row) => String(row.sku || "").toLowerCase(),
  brand: (row) => String(row.brand || "").toLowerCase(),
  buyBoxPct: (row) => row.buyBoxPct,
  sales: (row) => Number(row.sales) || 0,
  units: (row) => Number(row.units) || 0,
  salesAtRisk: (row) => row.salesAtRisk,
  effectivePrice: (row) => row.effectivePrice,
  featuredOfferPrice: (row) => row.featuredOfferPrice,
  priceGap: (row) => row.priceGap,
  available: (row) => row.available,
  cause: (row) => row.cause,
};

export default function BuyBoxLoss({ data, loading, error, accountName, selectedBrand, currency }) {
  const [search, setSearch] = useState("");
  const [threshold, setThreshold] = useState(90);
  const [causeFilter, setCauseFilter] = useState("ALL");
  const [page, setPage] = useState(1);
  const [sort, onSort] = useSortState("salesAtRisk", ["productName", "sku", "brand", "cause"]);

  // The threshold is a local control on purpose: it re-derives every row and
  // insight in the browser and must never trigger a DataDoe request.
  const safeThreshold = Number.isFinite(Number(threshold)) && Number(threshold) > 0 ? Number(threshold) : 90;

  const rows = useMemo(() => buildBuyBoxRows(data, selectedBrand, safeThreshold), [data, selectedBrand, safeThreshold]);
  const insights = useMemo(() => buildBuyBoxInsights(data, rows, safeThreshold), [data, rows, safeThreshold]);

  const losing = useMemo(() => rows.filter((row) => row.belowThreshold), [rows]);

  const totals = useMemo(() => ({
    tracked: rows.length,
    losing: losing.length,
    salesAtRisk: losing.reduce((sum, row) => sum + row.salesAtRisk, 0),
    sales: rows.reduce((sum, row) => sum + (Number(row.sales) || 0), 0),
    // A portfolio Buy Box share must be weighted by the sales it applies to,
    // never averaged across SKUs.
    weightedBuyBox: (() => {
      const weight = rows.reduce((sum, row) => sum + (Number(row.sales) || 0), 0);
      if (weight <= 0) return null;
      return rows.reduce((sum, row) => sum + row.buyBoxPct * (Number(row.sales) || 0), 0) / weight;
    })(),
    priceCaused: losing.filter((row) => row.cause === "price").length,
    stockCaused: losing.filter((row) => row.cause === "stock").length,
    unconfirmed: losing.filter((row) => row.cause === "unconfirmed").length,
  }), [rows, losing]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return losing.filter((row) => {
      if (causeFilter !== "ALL" && row.cause !== causeFilter) return false;
      if (!query) return true;
      return `${row.sku || ""} ${row.asin || ""} ${row.productName || ""} ${row.brand || ""}`.toLowerCase().includes(query);
    });
  }, [losing, search, causeFilter]);

  const sorted = useMemo(() => sortRows(filtered, ACCESSORS, sort, "salesAtRisk"), [filtered, sort]);

  React.useEffect(() => { setPage(1); }, [search, causeFilter, selectedBrand, safeThreshold, sort.key, sort.dir]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageRows = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const state = <SnapshotState data={data} loading={loading} error={error} label="Buy Box Loss report" icon={<Trophy size={22} />} />;
  // Money may only be totalled inside a single currency.
  const money = moneyScope(data, currency);
  const scopeLabel = `${accountName || "the selected account"}${selectedBrand === "ALL" ? "" : ` · ${selectedBrand}`}`;

  const exportTable = () => downloadCsv(sorted.map((row) => ({
    "Product Name": row.productName || "",
    SKU: row.sku || "",
    ASIN: row.asin || "",
    Brand: row.brand || "",
    Currency: row.currency || currency || "",
    "Buy Box %": row.buyBoxPct.toFixed(1),
    "Buy Box Basis": row.buyBoxBasis,
    "Days Observed": `${row.buyBoxDays} of ${row.windowDays}`,
    [`Sales (${row.windowDays}d)`]: Number(row.sales || 0).toFixed(2),
    [`Units (${row.windowDays}d)`]: Math.round(Number(row.units) || 0),
    "Sales at Risk": Number(row.salesAtRisk || 0).toFixed(2),
    "Your Effective Price": row.effectivePrice === null ? "" : row.effectivePrice.toFixed(2),
    "Featured Offer Price": row.featuredOfferPrice === null ? "" : row.featuredOfferPrice.toFixed(2),
    "Lowest New + Shipping": row.lowestPrice === null ? "" : row.lowestPrice.toFixed(2),
    "Price Gap": row.priceGap === null ? "" : row.priceGap.toFixed(2),
    "FBA Available": row.available === null ? "" : Math.round(row.available),
    "30-day Run Rate": row.dailyRate === null ? "" : row.dailyRate.toFixed(2),
    "Likely Cause": CAUSE_LABEL[row.cause],
    "Cause Evidence": row.causeDetail,
  })), reportFilename("buy-box-loss", accountName, data?.asOf));

  const exportInsights = () => downloadCsv(insightExportRows(insights), reportFilename("buy-box-loss-insights", accountName, data?.asOf));

  return (
    <div className="container skupl-page">
      <ReportHeader
        title="Buy Box Loss"
        subtitle={`Featured-offer share and the revenue it costs for ${scopeLabel}`}
      />

      {state}

      <StaleScopeNotice data={data} />

      {data && !data.snapshotMissing && <>
        <FreshnessBar items={[
          `${data.sourceLabel}, ${data.window.days} days${data.observedWindow ? ` (${fmtDateHuman(data.observedWindow.from)} – ${fmtDateHuman(data.observedWindow.to)} observed)` : ""}`,
          data.inventoryAvailable ? `competitive prices from the ${fmtDateHuman(data.inventorySnapshotDate)} FBA snapshot` : "FBA snapshot unavailable — no price or stock evidence",
          snapshotFreshnessLabel(data),
        ]} />

        {!data.inventoryAvailable && (
          <Notice tone="warn">
            The FBA Inventory Health snapshot is unavailable for this account, so no Buy Box loss can be attributed to price or stock. Every affected SKU is reported with an unconfirmed cause rather than a guessed one.
          </Notice>
        )}

        {(data.currencies?.length || 0) > 1 && (
          <Notice>
            This account reports {data.currencies.join(", ")}. Each SKU keeps its own currency and prices are compared only within a currency; the combined totals below are only meaningful for a single-currency scope.
          </Notice>
        )}

        <StatRow stats={[
          { label: "SKUs with Buy Box data", value: nInt(totals.tracked) },
          { label: `Below ${safeThreshold}%`, value: nInt(totals.losing), tone: totals.losing ? "bad" : "good" },
          { label: "Sales at risk", value: totalMoney(totals.salesAtRisk, money, fmtMoney), tone: totals.salesAtRisk > 0 && !money.mixed ? "bad" : undefined, hint: money.mixed ? "This account reports more than one currency, so a combined total would be meaningless." : undefined },
          { label: "Sales-weighted Buy Box", value: totals.weightedBuyBox === null ? "—" : fmtRate(totals.weightedBuyBox) },
          { label: "Price / stock / unclear", value: `${totals.priceCaused} / ${totals.stockCaused} / ${totals.unconfirmed}` },
        ]} />

        <PriorityActions
          insights={insights}
          mixedCurrency={(data.currencies?.length || 0) > 1}
          onExport={exportInsights}
          exportDisabled={!insights.length}
          emptyNote={`No selling SKU is below the ${safeThreshold}% Buy Box threshold in this scope.`}
        />

        <div className="panel skupl-table-panel" style={{ padding: 0, overflow: "hidden" }}>
          <div className="skupl-toolbar">
            <SearchField value={search} onChange={setSearch} placeholder="SKU, ASIN, product, or brand" />
            <label className="plan-field">
              <span className="plan-field-label">Buy Box threshold %</span>
              <input
                type="number" min="1" max="100" step="1" value={threshold}
                onChange={(event) => setThreshold(event.target.value === "" ? "" : Number(event.target.value))}
                onBlur={(event) => { if (event.target.value === "" || Number(event.target.value) <= 0) setThreshold(90); }}
                aria-label="Buy Box threshold percent"
              />
            </label>
            <SelectField
              label="Likely cause"
              value={causeFilter}
              onChange={setCauseFilter}
              options={[
                { value: "ALL", label: `All causes (${losing.length})` },
                { value: "price", label: `Price (${totals.priceCaused})` },
                { value: "stock", label: `Stock (${totals.stockCaused})` },
                { value: "fulfilment", label: `Fulfilment (${losing.filter((row) => row.cause === "fulfilment").length})` },
                { value: "unconfirmed", label: `Unconfirmed (${totals.unconfirmed})` },
              ]}
            />
            <div className="skupl-toolbar-spacer" />
            <ExportButton onClick={exportTable} disabled={!sorted.length} />
          </div>
          <div className="plan-scroll">
            <table className="plan-table buybox-table">
              <thead>
                <tr>
                  <SortTh className="pt-id" label="Product / SKU" col="productName" sort={sort} onSort={onSort} align="left" />
                  <SortTh label="Buy Box %" col="buyBoxPct" sort={sort} onSort={onSort} hint="Page-view-weighted share of the observed days; days Amazon reported no featured-offer competition are excluded, not counted as 0%." />
                  <SortTh label={`Sales (${data.window.days}d)`} col="sales" sort={sort} onSort={onSort} />
                  <SortTh label="Sales at Risk" col="salesAtRisk" sort={sort} onSort={onSort} hint="Sales × (1 − Buy Box share)" />
                  <SortTh label="Units" col="units" sort={sort} onSort={onSort} />
                  <SortTh label="Your Price" col="effectivePrice" sort={sort} onSort={onSort} />
                  <SortTh label="Featured Offer" col="featuredOfferPrice" sort={sort} onSort={onSort} />
                  <SortTh label="Gap" col="priceGap" sort={sort} onSort={onSort} />
                  <SortTh label="FBA Avail" col="available" sort={sort} onSort={onSort} />
                  <SortTh label="Likely Cause" col="cause" sort={sort} onSort={onSort} align="left" />
                </tr>
              </thead>
              <tbody>
                {pageRows.map((row) => (
                  <tr key={`${row.currency || ""}|${row.sku}`} className={row.buyBoxPct < 50 ? "skupl-row-loss" : "plan-restock"}>
                    <IdentityCell name={row.productName} primary={row.sku || "—"} secondary={row.asin} brand={row.brand} />
                    <td className={"mono pt-strong" + (row.buyBoxPct < 50 ? " sku-neg" : "")} title={`${row.buyBoxBasis} · ${row.buyBoxDays} of ${row.windowDays} days observed`}>{fmtRate(row.buyBoxPct)}</td>
                    <td className="mono">{fmtMoney(row.sales, row.currency || currency)}</td>
                    <td className="mono pt-strong sku-neg">{fmtMoney(row.salesAtRisk, row.currency || currency)}</td>
                    <td className="mono">{nInt(row.units)}</td>
                    <td className="mono">{row.effectivePrice === null ? "—" : fmtMoney(row.effectivePrice, row.currency || currency, 2)}</td>
                    <td className="mono">{row.featuredOfferPrice === null ? "—" : fmtMoney(row.featuredOfferPrice, row.currency || currency, 2)}</td>
                    <td className={"mono" + (row.priceGap !== null && row.priceGap > 0 ? " sku-neg" : "")}>{row.priceGap === null ? "—" : fmtMoney(row.priceGap, row.currency || currency, 2)}</td>
                    <td className="mono">{row.available === null ? "—" : nInt(row.available)}</td>
                    <td className="pt-left buybox-cause">
                      <span className={"pt-badge sku-badge-" + CAUSE_TONE[row.cause]} title={row.causeDetail}>{CAUSE_LABEL[row.cause]}</span>
                      <div className="buybox-cause-detail">{row.causeDetail}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!pageRows.length && (
            <div className="empty-note" style={{ padding: "14px 16px" }}>
              {losing.length
                ? "No SKUs match these filters."
                : rows.length
                  ? `Every SKU with Buy Box data is at or above ${safeThreshold}%.`
                  : "No SKU in this scope had both sales and reported Buy Box data in the window."}
            </div>
          )}
          <Pagination page={safePage} pageCount={pageCount} onChange={setPage} />
        </div>

        <div className="footer-note">
          Amazon publishes no dedicated Buy Box table. <code>buybox_percentage</code> lives on DataDoe <code>Profit by SKU &amp; Date</code> at SKU/day grain, and it is a ratio, so it is never summed and never averaged naively: this report fetches the raw daily rows for {data.window.days} days (in {data.window.sliceDays}-day slices to stay under the export row cap, rejecting any slice that hits the cap) and computes a <strong>page-view-weighted</strong> share, so a day with two page views cannot count as much as a day with two thousand. Days where Amazon reported no featured-offer competition are excluded from the share rather than treated as 0%, because a sole seller has not lost anything.
          {" "}Sales at risk = sales × (1 − Buy Box share) over the same window. Cause attribution uses only the competitive prices and stock on the latest <code>FBA Inventory Health</code> snapshot: your offer above <code>featuredoffer_price</code> is Price; zero or near-zero <code>available</code> against the 30-day run rate is Stock; a selling SKU with no FBA row at all is flagged Fulfilment because it is almost certainly merchant-fulfilled. When none of those fields is present the cause is <strong>Unconfirmed</strong> and confidence drops — the report will not name a cause it cannot evidence. Currencies are never combined. The threshold, filters, search, sorting, paging and both exports are local; only Refresh calls DataDoe, and it saves one shared snapshot for every user with access to this account.
        </div>
      </>}
    </div>
  );
}
