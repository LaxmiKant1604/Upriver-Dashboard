// Listing & Search Optimizer — where each ASIN loses the search funnel, and
// which listing field the evidence points at. Read-only: it measures and
// recommends, and never edits a listing.

import React, { useMemo, useState } from "react";
import { FileSearch } from "lucide-react";

import {
  OPTIMIZER_GATES,
  TITLE_MAX_CHARS,
  buildOptimizerInsights,
  buildOptimizerRows,
  insightExportRows,
} from "../lib/insights.js";
import { downloadCsv, reportFilename } from "../lib/csv.js";
import { fmtDateHuman, fmtRate, nDec, nInt } from "../lib/format.js";
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
  snapshotFreshnessLabel,
  sortRows,
  useSortState,
} from "./shared.jsx";

const PAGE_SIZE = 25;

const VIEWS = [
  { key: "products", label: "By product" },
  { key: "queries", label: "By search query" },
];

const PRODUCT_ACCESSORS = {
  productName: (row) => String(row.productName || row.asin || "").toLowerCase(),
  brand: (row) => String(row.brand || "").toLowerCase(),
  volume: (row) => row.volume,
  queryCount: (row) => row.queryCount,
  moneyQueryCount: (row) => row.moneyQueryCount,
  purchases: (row) => row.purchases,
  ctr: (row) => row.ctr,
  cvr: (row) => row.cvr,
  titleLength: (row) => row.titleAudit.length,
  bulletCount: (row) => row.bulletCount,
  issues: (row) => row.contentIssues.length,
  gaps: (row) => row.keywordGaps.length,
  dominantGate: (row) => row.dominantGate || "zzz",
};

const QUERY_ACCESSORS = {
  query: (row) => String(row.query || "").toLowerCase(),
  productName: (row) => String(row.productName || row.asin || "").toLowerCase(),
  volume: (row) => row.volume,
  impressionShare: (row) => row.impressionShare,
  yourCtr: (row) => row.yourCtr,
  ctrVsMarket: (row) => row.ctrVsMarket,
  yourCvr: (row) => row.yourCvr,
  cvrVsMarket: (row) => row.cvrVsMarket,
  purchases: (row) => row.asinPurchases,
  bestRank: (row) => row.bestRank,
  gate: (row) => row.gate || "zzz",
};

export default function ListingOptimizer({ data, loading, error, accountName, selectedBrand }) {
  const [mode, setMode] = useState("products");
  const [search, setSearch] = useState("");
  const [gateFilter, setGateFilter] = useState("ALL");
  const [page, setPage] = useState(1);
  const [productSort, onProductSort] = useSortState("volume", ["productName", "brand", "dominantGate"]);
  const [querySort, onQuerySort] = useSortState("volume", ["query", "productName", "gate"]);

  const rows = useMemo(() => buildOptimizerRows(data, selectedBrand), [data, selectedBrand]);
  const insights = useMemo(() => buildOptimizerInsights(data, rows), [data, rows]);

  // Flattened query view. Each query carries its product identity so the table
  // stays readable without a second lookup.
  const queryRows = useMemo(() => rows.flatMap((row) => row.queries.map((query) => ({
    ...query,
    productName: row.productName,
    brand: row.brand,
  }))), [rows]);

  const gateCounts = useMemo(() => {
    const counts = {};
    queryRows.forEach((row) => { if (row.gate) counts[row.gate] = (counts[row.gate] || 0) + 1; });
    return counts;
  }, [queryRows]);

  const totals = useMemo(() => ({
    products: rows.length,
    queries: queryRows.length,
    unclassified: queryRows.filter((row) => !row.gate).length,
    titleGaps: rows.filter((row) => row.topQueryInTitle === false).length,
    contentIssues: rows.reduce((sum, row) => sum + row.contentIssues.length, 0),
    overLengthTitles: rows.filter((row) => row.titleAudit.overLength).length,
  }), [rows, queryRows]);

  const filteredProducts = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (gateFilter !== "ALL" && row.dominantGate !== gateFilter) return false;
      if (!query) return true;
      return `${row.asin || ""} ${row.productName || ""} ${row.brand || ""}`.toLowerCase().includes(query);
    });
  }, [rows, search, gateFilter]);

  const filteredQueries = useMemo(() => {
    const query = search.trim().toLowerCase();
    return queryRows.filter((row) => {
      if (gateFilter !== "ALL" && row.gate !== gateFilter) return false;
      if (!query) return true;
      return `${row.query || ""} ${row.asin || ""} ${row.productName || ""} ${row.brand || ""}`.toLowerCase().includes(query);
    });
  }, [queryRows, search, gateFilter]);

  const sortedProducts = useMemo(() => sortRows(filteredProducts, PRODUCT_ACCESSORS, productSort, "volume"), [filteredProducts, productSort]);
  const sortedQueries = useMemo(() => sortRows(filteredQueries, QUERY_ACCESSORS, querySort, "volume"), [filteredQueries, querySort]);

  const activeRows = mode === "products" ? sortedProducts : sortedQueries;

  React.useEffect(() => { setPage(1); }, [mode, search, gateFilter, selectedBrand, productSort.key, productSort.dir, querySort.key, querySort.dir]);

  const pageCount = Math.max(1, Math.ceil(activeRows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageRows = activeRows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const state = <SnapshotState data={data} loading={loading} error={error} label="Listing & Search Optimizer report" icon={<FileSearch size={22} />} />;
  const scopeLabel = `${accountName || "the selected account"}${selectedBrand === "ALL" ? "" : ` · ${selectedBrand}`}`;

  const exportTable = () => {
    if (mode === "products") {
      return downloadCsv(sortedProducts.map((row) => ({
        "Product Name": row.productName || "",
        ASIN: row.asin || "",
        Brand: row.brand || "",
        Category: row.category || "",
        "Best Seller Rank": row.bestSellerRank || "",
        "Search Queries": row.queryCount,
        "Converting Queries": row.moneyQueryCount,
        "Query Volume": Math.round(row.volume),
        Impressions: Math.round(row.impressions),
        Clicks: Math.round(row.clicks),
        Purchases: Math.round(row.purchases),
        "CTR %": row.ctr === null ? "" : (row.ctr * 100).toFixed(2),
        "CVR %": row.cvr === null ? "" : (row.cvr * 100).toFixed(2),
        "Title Length": row.titleAudit.length,
        [`Over ${TITLE_MAX_CHARS} chars`]: row.titleAudit.overLength ? "Yes" : "No",
        "Bullets Filled": `${row.bulletCount} of 5`,
        "Has Description": row.hasDescription ? "Yes" : "No",
        "Has Image": row.hasImage ? "Yes" : "No",
        "Top Converting Query": row.topQuery?.query || "",
        "Top Query In Title": row.topQueryInTitle === null ? "" : row.topQueryInTitle ? "Yes" : "No",
        "Missing Keywords": row.keywordGaps.map((gap) => gap.token).join(" | "),
        "Content Issues": row.contentIssues.join(" | "),
        "Dominant Funnel Gate": row.dominantGateMeta ? row.dominantGateMeta.label : "",
        "Recommended Action": row.dominantGateMeta ? row.dominantGateMeta.action : "",
      })), reportFilename("listing-optimizer-products", accountName, data?.asOf));
    }
    return downloadCsv(sortedQueries.map((row) => ({
      "Search Query": row.query,
      ASIN: row.asin || "",
      "Product Name": row.productName || "",
      Brand: row.brand || "",
      "Query Volume": Math.round(row.volume),
      "Your Impressions": Math.round(row.asinImpressions),
      "Query Impressions": Math.round(row.totalImpressions),
      "Impression Share %": row.impressionShare === null ? "" : (row.impressionShare * 100).toFixed(2),
      "Your CTR %": row.yourCtr === null ? "" : (row.yourCtr * 100).toFixed(2),
      "Market CTR %": row.marketCtr === null ? "" : (row.marketCtr * 100).toFixed(2),
      "CTR vs Market": row.ctrVsMarket === null ? "" : row.ctrVsMarket.toFixed(2),
      "Your Cart Rate %": row.cartRate === null ? "" : (row.cartRate * 100).toFixed(2),
      "Your CVR %": row.yourCvr === null ? "" : (row.yourCvr * 100).toFixed(2),
      "Market CVR %": row.marketCvr === null ? "" : (row.marketCvr * 100).toFixed(2),
      "CVR vs Market": row.cvrVsMarket === null ? "" : row.cvrVsMarket.toFixed(2),
      "Your Purchases": Math.round(row.asinPurchases),
      "Purchase Share %": row.purchaseShare === null ? "" : (row.purchaseShare * 100).toFixed(2),
      "Best Organic Rank": row.bestRank === null ? "" : Math.round(row.bestRank),
      "Funnel Gate": row.gate ? OPTIMIZER_GATES[row.gate].label : "Unclassified",
      "Recommended Action": row.gate ? OPTIMIZER_GATES[row.gate].action : "Not classified: this query lacks the market denominators needed for a comparison.",
    })), reportFilename("listing-optimizer-queries", accountName, data?.asOf));
  };

  const exportInsights = () => downloadCsv(insightExportRows(insights), reportFilename("listing-optimizer-insights", accountName, data?.asOf));

  return (
    <div className="container skupl-page">
      <ReportHeader
        title="Listing &amp; Search Optimizer"
        subtitle={`Search-funnel gaps and listing content issues for ${scopeLabel}`}
      >
        {data && !data.snapshotMissing && data.sqpAvailable && (
          <div className="report-tabs" role="tablist" aria-label="Optimizer view">
            {VIEWS.map((item) => (
              <button key={item.key} role="tab" aria-selected={mode === item.key} className={mode === item.key ? "active" : ""} onClick={() => setMode(item.key)}>
                {item.label}
              </button>
            ))}
          </div>
        )}
      </ReportHeader>

      {state}

      {data && !data.snapshotMissing && !data.sqpAvailable && (
        <Notice tone="warn">{data.sqpUnavailableReason}</Notice>
      )}

      {data && !data.snapshotMissing && data.sqpAvailable && <>
        <FreshnessBar items={[
          `${data.sqpSourceLabel}, ${data.periodCount} weekly period${data.periodCount === 1 ? "" : "s"} in ${data.window.days} days`,
          data.periods?.length ? `latest period ${fmtDateHuman(data.periods[data.periods.length - 1])}` : "no periods returned",
          `listing content from ${data.contentSourceLabel}`,
          snapshotFreshnessLabel(data),
        ]} />

        {data.periodCount < 4 && (
          <Notice tone="warn">
            Only {data.periodCount} weekly Search Query Performance period{data.periodCount === 1 ? "" : "s"} exist{data.periodCount === 1 ? "s" : ""} for this account. That source starts with about 21 days of history and adds one period per week, so the funnel comparisons below are a current snapshot rather than a trend. They are still valid — every rate is compared against the same query's market rate in the same period — but treat small differences cautiously.
          </Notice>
        )}

        {totals.unclassified > 0 && (
          <Notice>
            {nInt(totals.unclassified)} of {nInt(totals.queries)} queries are left <strong>unclassified</strong> because the query-level denominators needed for a market comparison were not present. They are shown but never assigned a cause.
          </Notice>
        )}

        <StatRow stats={[
          { label: "Products with search data", value: nInt(totals.products) },
          { label: "Search queries", value: nInt(totals.queries) },
          { label: "Top term missing from title", value: nInt(totals.titleGaps), tone: totals.titleGaps ? "bad" : "good" },
          { label: `Titles over ${TITLE_MAX_CHARS} chars`, value: nInt(totals.overLengthTitles), tone: totals.overLengthTitles ? "bad" : "good" },
          { label: "Content gaps", value: nInt(totals.contentIssues), tone: totals.contentIssues ? "bad" : "good" },
        ]} />

        <PriorityActions
          insights={insights}
          onExport={exportInsights}
          exportDisabled={!insights.length}
          emptyNote="No listing or search-funnel gap met the evidence thresholds in this scope."
        />

        <div className="panel skupl-table-panel" style={{ padding: 0, overflow: "hidden" }}>
          <div className="skupl-toolbar">
            <SearchField value={search} onChange={setSearch} placeholder={mode === "products" ? "ASIN, product, or brand" : "Search query, ASIN, or product"} />
            <SelectField
              label="Funnel gate"
              value={gateFilter}
              onChange={setGateFilter}
              options={[
                { value: "ALL", label: "All gates" },
                ...Object.entries(OPTIMIZER_GATES).map(([key, meta]) => ({ value: key, label: `${meta.label} (${gateCounts[key] || 0})` })),
              ]}
            />
            <div className="skupl-toolbar-spacer" />
            <ExportButton onClick={exportTable} disabled={!activeRows.length} />
          </div>
          <div className="plan-scroll">
            {mode === "products" ? (
              <table className="plan-table optimizer-table">
                <thead>
                  <tr>
                    <SortTh className="pt-id" label="Product / ASIN" col="productName" sort={productSort} onSort={onProductSort} align="left" />
                    <SortTh label="Query Vol." col="volume" sort={productSort} onSort={onProductSort} />
                    <SortTh label="Queries" col="queryCount" sort={productSort} onSort={onProductSort} />
                    <SortTh label="Converting" col="moneyQueryCount" sort={productSort} onSort={onProductSort} />
                    <SortTh label="Purchases" col="purchases" sort={productSort} onSort={onProductSort} />
                    <SortTh label="CTR" col="ctr" sort={productSort} onSort={onProductSort} />
                    <SortTh label="CVR" col="cvr" sort={productSort} onSort={onProductSort} />
                    <SortTh label="Title Len" col="titleLength" sort={productSort} onSort={onProductSort} hint={`Amazon's 2026 limit for non-media categories is ${TITLE_MAX_CHARS} characters`} />
                    <SortTh label="Bullets" col="bulletCount" sort={productSort} onSort={onProductSort} />
                    <SortTh label="Gaps" col="gaps" sort={productSort} onSort={onProductSort} hint="Words from converting queries that appear nowhere in the listing" />
                    <SortTh label="Content Issues" col="issues" sort={productSort} onSort={onProductSort} align="left" />
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((row) => (
                    <tr key={row.asin} className={row.topQueryInTitle === false ? "plan-restock" : ""}>
                      <IdentityCell name={row.productName} primary={row.asin} brand={row.brand} />
                      <td className="mono">{nInt(row.volume)}</td>
                      <td className="mono">{nInt(row.queryCount)}</td>
                      <td className="mono">{nInt(row.moneyQueryCount)}</td>
                      <td className="mono">{nInt(row.purchases)}</td>
                      <td className="mono">{row.ctr === null ? "—" : fmtRate(row.ctr * 100, 2)}</td>
                      <td className="mono">{row.cvr === null ? "—" : fmtRate(row.cvr * 100, 1)}</td>
                      <td className={"mono" + (row.titleAudit.overLength ? " sku-neg" : "")}>{row.titleAudit.length}</td>
                      <td className={"mono" + (row.bulletCount < 5 ? " sku-warn" : "")}>{row.bulletCount}/5</td>
                      <td className="mono">{nInt(row.keywordGaps.length)}</td>
                      <td className="optimizer-note">
                        {row.topQueryInTitle === false && (
                          <div><strong>Top term "{row.topQuery.query}" not in title.</strong></div>
                        )}
                        {row.contentIssues.length ? row.contentIssues.join("; ") : row.topQueryInTitle === false ? "" : "No content issues found."}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <table className="plan-table optimizer-table">
                <thead>
                  <tr>
                    <SortTh className="pt-id" label="Search Query" col="query" sort={querySort} onSort={onQuerySort} align="left" />
                    <SortTh label="Volume" col="volume" sort={querySort} onSort={onQuerySort} />
                    <SortTh label="Impr. Share" col="impressionShare" sort={querySort} onSort={onQuerySort} />
                    <SortTh label="Your CTR" col="yourCtr" sort={querySort} onSort={onQuerySort} />
                    <SortTh label="vs Market" col="ctrVsMarket" sort={querySort} onSort={onQuerySort} hint="Your CTR divided by the whole query's CTR. Below 1.0x means below market." />
                    <SortTh label="Your CVR" col="yourCvr" sort={querySort} onSort={onQuerySort} />
                    <SortTh label="vs Market" col="cvrVsMarket" sort={querySort} onSort={onQuerySort} />
                    <SortTh label="Purchases" col="purchases" sort={querySort} onSort={onQuerySort} />
                    <SortTh label="Best Rank" col="bestRank" sort={querySort} onSort={onQuerySort} hint="Best (lowest) organic rank observed. Ranks are never averaged." />
                    <SortTh label="Diagnosis" col="gate" sort={querySort} onSort={onQuerySort} align="left" />
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((row, index) => {
                    const meta = row.gate ? OPTIMIZER_GATES[row.gate] : null;
                    return (
                      <tr key={`${row.asin}|${row.query}|${index}`} className={row.gate === "conversion" ? "plan-restock" : ""}>
                        <td className="pt-id">
                          <div className="pt-name" title={row.query}>{row.query}</div>
                          <div className="pt-meta mono">{row.asin}</div>
                          {row.brand && <div className="pt-brand">{row.brand}</div>}
                        </td>
                        <td className="mono">{nInt(row.volume)}</td>
                        <td className="mono">{row.impressionShare === null ? "—" : fmtRate(row.impressionShare * 100, 2)}</td>
                        <td className="mono">{row.yourCtr === null ? "—" : fmtRate(row.yourCtr * 100, 2)}</td>
                        <td className={"mono" + (row.ctrVsMarket !== null && row.ctrVsMarket < 0.8 ? " sku-neg" : "")}>{row.ctrVsMarket === null ? "—" : `${nDec(row.ctrVsMarket, 2)}x`}</td>
                        <td className="mono">{row.yourCvr === null ? "—" : fmtRate(row.yourCvr * 100, 1)}</td>
                        <td className={"mono" + (row.cvrVsMarket !== null && row.cvrVsMarket < 0.8 ? " sku-neg" : "")}>{row.cvrVsMarket === null ? "—" : `${nDec(row.cvrVsMarket, 2)}x`}</td>
                        <td className="mono">{nInt(row.asinPurchases)}</td>
                        <td className="mono">{row.bestRank === null ? "—" : Math.round(row.bestRank)}</td>
                        <td className="optimizer-note">
                          {meta
                            ? <>
                              <span className={"pt-badge sku-badge-" + meta.tone}>{meta.label}</span>
                              <div className="buybox-cause-detail">{meta.action}</div>
                            </>
                            : <span className="movers-unattributed" title="This query did not carry the market denominators needed to compare against, so no cause is claimed.">Unclassified</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          {!pageRows.length && <div className="empty-note" style={{ padding: "14px 16px" }}>{activeRows.length ? "Nothing matches these filters." : "No Search Query Performance rows were returned for this scope."}</div>}
          <Pagination page={safePage} pageCount={pageCount} onChange={setPage} />
        </div>

        <div className="footer-note">
          Search data comes from DataDoe <code>Search Query Performance (SQP) by ASIN (Weekly)</code>, which reports both this ASIN's impressions, clicks, cart-adds and purchases AND the whole query's totals. That is what makes every diagnosis a measurement: impression share = your impressions ÷ query impressions, and "below market" means your CTR or CVR divided by the same query's CTR or CVR is under 1.0x. All rates are computed from summed counts; organic rank uses the <strong>best</strong> rank observed rather than an average, because averaging ranks across weeks is meaningless. Listing content — title, the five bullets, description and image presence — comes from <code>Product Catalog by ASIN</code>.
          {" "}Diagnoses are checked in order: low share with both CTR and CVR below market means the query is <strong>not your product</strong> and should not be chased; low share with market-level conversion and a weak rank is a <strong>discoverability</strong> gap; low share with everything else healthy needs <strong>rank or ads</strong>, not new copy; below-market CTR is an image/title/price signal; below-market CVR is an offer-page problem. A query without the market denominators is left <strong>unclassified</strong> rather than guessed. Title checks apply Amazon's published 2026 rules for non-media categories: a {TITLE_MAX_CHARS}-character limit, no promotional words, no disallowed symbols, and no word repeated more than twice. A missing keyword is a word that produced purchases in a query but appears in neither the title, bullets nor description — a coverage fact, not an instruction to stuff the listing. <strong>This report never modifies a listing and never writes copy for you</strong>; it identifies the exact field and the evidence, and you make the change in Seller Central. Both views, filters, search, sorting, paging and all three exports are local; only Refresh calls DataDoe.
        </div>
      </>}
    </div>
  );
}
