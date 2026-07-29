// PPC Performance & Wasted Spend — account, campaign, ASIN, keyword/target and
// customer search-term views over the persisted Amazon Ads history.

import React, { useMemo, useState } from "react";
import { Megaphone } from "lucide-react";

import {
  PPC_WASTE_META,
  buildPpcInsights,
  buildPpcRows,
  insightExportRows,
  ppcMetrics,
} from "../lib/insights.js";
import { downloadCsv, reportFilename } from "../lib/csv.js";
import { fmtDateHuman, fmtMoney, fmtRate, nDec, nInt } from "../lib/format.js";
import {
  ExportButton,
  FreshnessBar,
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

const LEVELS = [
  { key: "campaigns", label: "Campaigns", identity: "Campaign" },
  { key: "asins", label: "ASINs", identity: "Product / ASIN" },
  { key: "targets", label: "Keywords & targets", identity: "Target" },
  { key: "searchTerms", label: "Search terms", identity: "Customer search term" },
];

const ACCESSORS = {
  identity: (row) => String(row.searchTerm || row.targetText || row.campaignName || row.productName || row.asin || row.campaignId || "").toLowerCase(),
  spend: (row) => row.spend,
  sales: (row) => row.sales,
  acos: (row) => row.acos,
  tacos: (row) => row.tacos,
  roas: (row) => row.roas,
  clicks: (row) => row.clicks,
  impressions: (row) => row.impressions,
  orders: (row) => row.orders,
  units: (row) => row.units,
  cpc: (row) => row.cpc,
  ctr: (row) => row.ctr,
  cvr: (row) => row.cvr,
  wasted: (row) => row.waste.wasted,
  wasteKind: (row) => row.waste.kind,
};

function identityOf(row) {
  return row.searchTerm || row.targetText || row.campaignName || row.productName || row.asin || row.campaignId || "—";
}

export default function PpcPerformance({ data, loading, error, accountName, selectedBrand, currency }) {
  const [level, setLevel] = useState("campaigns");
  const [search, setSearch] = useState("");
  const [wasteFilter, setWasteFilter] = useState("ALL");
  const [campaignTypeFilter, setCampaignTypeFilter] = useState("ALL");
  const [breakEven, setBreakEven] = useState(30);
  const [page, setPage] = useState(1);
  const [sort, onSort] = useSortState("spend", ["identity", "wasteKind"]);

  // Break-even ACoS is a local control: it re-derives every waste figure and
  // insight in the browser and must never trigger a DataDoe request.
  const safeBreakEven = Number.isFinite(Number(breakEven)) && Number(breakEven) > 0 ? Number(breakEven) : 30;

  const rows = useMemo(
    () => buildPpcRows(data, level, { breakEvenAcos: safeBreakEven, selectedBrand }),
    [data, level, safeBreakEven, selectedBrand]
  );
  const insights = useMemo(() => buildPpcInsights(data, rows, level, safeBreakEven), [data, rows, level, safeBreakEven]);

  const account = useMemo(() => {
    if (!data?.campaigns) return null;
    const totals = data.campaigns.reduce((acc, row) => ({
      spend: acc.spend + (Number(row.spend) || 0),
      sales: acc.sales + (Number(row.sales) || 0),
      clicks: acc.clicks + (Number(row.clicks) || 0),
      impressions: acc.impressions + (Number(row.impressions) || 0),
      orders: acc.orders + (Number(row.orders) || 0),
      units: acc.units + (Number(row.units) || 0),
    }), { spend: 0, sales: 0, clicks: 0, impressions: 0, orders: 0, units: 0 });
    return ppcMetrics(totals, { totalSales: data.totalSales });
  }, [data]);

  const wastedTotal = useMemo(() => rows.reduce((sum, row) => sum + row.waste.wasted, 0), [rows]);

  const campaignTypes = useMemo(
    () => [...new Set(rows.flatMap((row) => row.campaignTypes || []))].sort(),
    [rows]
  );

  const wasteCounts = useMemo(() => {
    const counts = {};
    rows.forEach((row) => { counts[row.waste.kind] = (counts[row.waste.kind] || 0) + 1; });
    return counts;
  }, [rows]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (wasteFilter !== "ALL" && row.waste.kind !== wasteFilter) return false;
      if (campaignTypeFilter !== "ALL" && !(row.campaignTypes || []).includes(campaignTypeFilter)) return false;
      if (!query) return true;
      return `${identityOf(row)} ${row.campaignName || ""} ${row.adGroupName || ""} ${row.matchedKeyword || ""} ${row.asin || ""} ${row.brand || ""}`
        .toLowerCase().includes(query);
    });
  }, [rows, search, wasteFilter, campaignTypeFilter]);

  const sorted = useMemo(() => sortRows(filtered, ACCESSORS, sort, "spend"), [filtered, sort]);

  React.useEffect(() => { setPage(1); }, [level, search, wasteFilter, campaignTypeFilter, safeBreakEven, selectedBrand, sort.key, sort.dir]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageRows = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const state = <SnapshotState data={data} loading={loading} error={error} label="PPC Performance report" icon={<Megaphone size={22} />} />;
  // Money may only be totalled inside a single currency.
  const money = moneyScope(data, currency);
  const scopeLabel = `${accountName || "the selected account"}${level === "asins" && selectedBrand !== "ALL" ? ` · ${selectedBrand}` : ""}`;
  const activeLevel = LEVELS.find((item) => item.key === level);
  const levelCoverage = data?.sourceAvailability?.find((entry) => entry.key?.startsWith(
    level === "searchTerms" ? "search-terms" : level === "targets" ? "keyword-targeting" : level === "asins" ? "asin" : "campaign"
  ));

  const exportTable = () => downloadCsv(sorted.map((row) => ({
    Level: activeLevel.label,
    [activeLevel.identity]: identityOf(row),
    ASIN: row.asin || "",
    Brand: row.brand || "",
    Campaign: row.campaignName || "",
    "Ad Group": row.adGroupName || "",
    "Match Type": row.matchType || "",
    "Matched Keyword": row.matchedKeyword || "",
    "Ad Product (campaign type)": (row.campaignTypes || []).join(" | "),
    Currency: row.currencies?.join(" | ") || currency || "",
    Spend: row.spend.toFixed(2),
    "Attributed Sales": row.sales.toFixed(2),
    "ACoS %": row.acos === null ? "" : row.acos.toFixed(1),
    "TACoS %": row.tacos === null ? "" : row.tacos.toFixed(2),
    ROAS: row.roas === null ? "" : row.roas.toFixed(2),
    Clicks: Math.round(row.clicks),
    Impressions: Math.round(row.impressions),
    Orders: Math.round(row.orders),
    Units: Math.round(row.units),
    "CPC": row.cpc === null ? "" : row.cpc.toFixed(2),
    "CTR %": row.ctr === null ? "" : row.ctr.toFixed(2),
    "CVR %": row.cvr === null ? "" : row.cvr.toFixed(2),
    "Waste Class": row.wasteMeta.label,
    "Wasted Spend": row.waste.wasted.toFixed(2),
    "Waste Evidence": row.waste.note,
    "Break-even ACoS Used %": safeBreakEven,
    "Active Days": row.activeDays || "",
  })), reportFilename("ppc-performance", accountName, data?.asOf, activeLevel.label));

  const exportInsights = () => downloadCsv(insightExportRows(insights), reportFilename("ppc-performance-insights", accountName, data?.asOf, activeLevel.label));

  return (
    <div className="container skupl-page">
      <ReportHeader
        title="PPC Performance &amp; Wasted Spend"
        subtitle={`Advertising performance and wasted spend for ${scopeLabel}, read from the saved Amazon Ads history`}
      >
        {data && !data.snapshotMissing && (
          <div className="report-tabs" role="tablist" aria-label="PPC level">
            {LEVELS.map((item) => (
              <button
                key={item.key}
                role="tab"
                aria-selected={level === item.key}
                className={level === item.key ? "active" : ""}
                onClick={() => setLevel(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
      </ReportHeader>

      {state}

      <StaleScopeNotice data={data} />

      {data && !data.snapshotMissing && <>
        <FreshnessBar items={[
          `${data.window.days}-day window ${fmtDateHuman(data.window.from)} – ${fmtDateHuman(data.window.to)}`,
          data.latestMetricDate ? `latest saved Ads day ${fmtDateHuman(data.latestMetricDate)}` : "no saved Ads days in this window",
          `${nInt(data.adsRowCount)} saved Ads rows read from Supabase — no Amazon Ads export was run`,
          snapshotFreshnessLabel(data),
        ]} />

        {data.adsRowCount === 0 && (
          <Notice tone="warn">
            No saved Amazon Ads rows exist for this account in this window, so no advertising figures are shown — this is missing history, not zero spend. The scheduled worker seeds each account once and then keeps a rolling window current. Check the source status below; a source that has never run has no seed timestamp.
          </Notice>
        )}

        {data.sourceAvailability?.some((entry) => entry.rows === 0) && data.adsRowCount > 0 && (
          <Notice tone="warn">
            {data.sourceAvailability.filter((entry) => entry.rows === 0).map((entry) => `${entry.label} has no saved rows in this window${entry.defaultDataset === false ? ` — it is not a default DataDoe table. ${entry.enableHint}` : "."}`).join(" ")}
          </Notice>
        )}

        <Notice>
          Ad-product coverage differs by level and this report does not blur it. <strong>{levelCoverage?.label}</strong>: {levelCoverage?.coverage}. Keyword Targeting Performance covers Sponsored Products, Sponsored Brands and Sponsored Display; Search Term Performance covers Sponsored Products and Sponsored Brands <strong>only</strong> and never Sponsored Display, so a term missing here may still exist in a Display campaign. Every row keeps its <code>ad_campaign_type</code>.
        </Notice>

        {(data.currencies?.length || 0) > 1 && (
          <Notice>
            This account's saved Ads rows report {data.currencies.join(", ")}. Spend and sales are shown per row in that row's own currency and are never converted or combined; treat the account totals as meaningful only for a single-currency account.
          </Notice>
        )}

        {level === "asins" && selectedBrand !== "ALL" && (
          <Notice>Brand filtering applies at the ASIN level only. Campaign, target and search-term rows are not brand-attributable in the Ads sources, so they are never filtered by brand — hiding them would silently remove real spend from the totals.</Notice>
        )}

        <StatRow stats={[
          { label: "Ad spend", value: totalMoney(account?.spend, money, fmtMoney), hint: money.mixed ? "This account's saved Ads rows report more than one currency, so a combined total would be meaningless." : undefined },
          { label: "Attributed sales", value: totalMoney(account?.sales, money, fmtMoney) },
          { label: "ACoS", value: account?.acos === null || account?.acos === undefined ? "—" : fmtRate(account.acos), hint: "Spend ÷ attributed sales, recomputed from the summed totals" },
          {
            label: "TACoS",
            value: account?.tacos === null || account?.tacos === undefined ? "—" : fmtRate(account.tacos, 2),
            hint: data.totalSalesUnavailable
              ? `Unavailable: ${data.totalSalesUnavailable}`
              : `Ad spend ÷ total account sales from ${data.totalSalesSourceLabel}, which can lag about ${data.totalSalesLagDays} days`,
          },
          { label: `Wasted spend (${activeLevel.label.toLowerCase()})`, value: totalMoney(wastedTotal, money, fmtMoney), tone: wastedTotal > 0 && !money.mixed ? "bad" : "good" },
        ]} />

        {data.totalSalesUnavailable && (
          <Notice tone="warn">TACoS is unavailable because the total-sales export failed: {data.totalSalesUnavailable}. Every advertising figure above is unaffected — it comes from the saved Ads history.</Notice>
        )}

        <PriorityActions
          insights={insights}
          mixedCurrency={(data.currencies?.length || 0) > 1}
          onExport={exportInsights}
          exportDisabled={!insights.length}
          title={`Priority Actions · ${activeLevel.label}`}
          emptyNote={`No ${activeLevel.label.toLowerCase()} in this window crossed the waste or scaling thresholds at a ${safeBreakEven}% break-even ACoS.`}
        />

        <div className="panel skupl-table-panel" style={{ padding: 0, overflow: "hidden" }}>
          <div className="skupl-toolbar">
            <SearchField value={search} onChange={setSearch} placeholder={`${activeLevel.identity}, campaign, or ASIN`} />
            <label className="plan-field">
              <span className="plan-field-label">Break-even ACoS %</span>
              <input
                type="number" min="1" max="100" step="1" value={breakEven}
                onChange={(event) => setBreakEven(event.target.value === "" ? "" : Number(event.target.value))}
                onBlur={(event) => { if (event.target.value === "" || Number(event.target.value) <= 0) setBreakEven(30); }}
                aria-label="Break-even ACoS percent"
              />
            </label>
            <SelectField
              label="Classification"
              value={wasteFilter}
              onChange={setWasteFilter}
              options={[
                { value: "ALL", label: `All rows (${rows.length})` },
                ...Object.entries(PPC_WASTE_META).map(([key, meta]) => ({ value: key, label: `${meta.label} (${wasteCounts[key] || 0})` })),
              ]}
            />
            {campaignTypes.length > 1 && (
              <SelectField
                label="Ad product"
                value={campaignTypeFilter}
                onChange={setCampaignTypeFilter}
                options={[{ value: "ALL", label: "All ad products" }, ...campaignTypes.map((type) => ({ value: type, label: type }))]}
              />
            )}
            <div className="skupl-toolbar-spacer" />
            <ExportButton onClick={exportTable} disabled={!sorted.length} />
          </div>
          <div className="plan-scroll">
            <table className="plan-table ppc-table">
              <thead>
                <tr>
                  <SortTh className="pt-id" label={activeLevel.identity} col="identity" sort={sort} onSort={onSort} align="left" />
                  <SortTh label="Spend" col="spend" sort={sort} onSort={onSort} />
                  <SortTh label="Ad Sales" col="sales" sort={sort} onSort={onSort} />
                  <SortTh label="ACoS" col="acos" sort={sort} onSort={onSort} />
                  <SortTh label="TACoS" col="tacos" sort={sort} onSort={onSort} hint="Spend ÷ total account sales for the window" />
                  <SortTh label="ROAS" col="roas" sort={sort} onSort={onSort} />
                  <SortTh label="Clicks" col="clicks" sort={sort} onSort={onSort} />
                  <SortTh label="Impr." col="impressions" sort={sort} onSort={onSort} />
                  <SortTh label="Orders" col="orders" sort={sort} onSort={onSort} />
                  <SortTh label="CPC" col="cpc" sort={sort} onSort={onSort} />
                  <SortTh label="CTR" col="ctr" sort={sort} onSort={onSort} />
                  <SortTh label="CVR" col="cvr" sort={sort} onSort={onSort} />
                  <SortTh label="Wasted" col="wasted" sort={sort} onSort={onSort} />
                  <SortTh label="Classification" col="wasteKind" sort={sort} onSort={onSort} align="left" />
                </tr>
              </thead>
              <tbody>
                {pageRows.map((row) => {
                  const rowCurrency = row.currencies?.[0] || currency;
                  return (
                    <tr key={row.key} className={row.waste.kind === "dead" ? "skupl-row-loss" : row.waste.kind === "breach" ? "plan-restock" : ""}>
                      <td className="pt-id">
                        <div className="pt-name" title={identityOf(row)}>{identityOf(row)}</div>
                        <div className="pt-meta mono">
                          {[row.campaignName, row.adGroupName, row.matchType, row.asin].filter(Boolean).join(" · ") || (row.campaignTypes || []).join(", ")}
                        </div>
                        {row.brand && <div className="pt-brand">{row.brand}</div>}
                      </td>
                      <td className="mono pt-strong">{fmtMoney(row.spend, rowCurrency)}</td>
                      <td className="mono">{fmtMoney(row.sales, rowCurrency)}</td>
                      <td className={"mono" + (row.acos !== null && row.acos > safeBreakEven ? " sku-neg" : "")}>{row.acos === null ? "—" : fmtRate(row.acos)}</td>
                      <td className="mono">{row.tacos === null ? "—" : fmtRate(row.tacos, 2)}</td>
                      <td className="mono">{row.roas === null ? "—" : `${nDec(row.roas, 2)}x`}</td>
                      <td className="mono">{nInt(row.clicks)}</td>
                      <td className="mono">{nInt(row.impressions)}</td>
                      <td className="mono">{nInt(row.orders)}</td>
                      <td className="mono">{row.cpc === null ? "—" : fmtMoney(row.cpc, rowCurrency, 2)}</td>
                      <td className="mono">{row.ctr === null ? "—" : fmtRate(row.ctr, 2)}</td>
                      <td className="mono">{row.cvr === null ? "—" : fmtRate(row.cvr, 1)}</td>
                      <td className={"mono pt-strong" + (row.waste.wasted > 0 ? " sku-neg" : "")}>{row.waste.wasted > 0 ? fmtMoney(row.waste.wasted, rowCurrency) : "—"}</td>
                      <td className="ppc-term">
                        <span className={"pt-badge sku-badge-" + row.wasteMeta.tone}>{row.wasteMeta.label}</span>
                        <div className="buybox-cause-detail">{row.waste.note}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!pageRows.length && (
            <div className="empty-note" style={{ padding: "14px 16px" }}>
              {rows.length
                ? "No rows match these filters."
                : `No saved ${activeLevel.label.toLowerCase()} rows exist for this account in this window.`}
            </div>
          )}
          <Pagination page={safePage} pageCount={pageCount} onChange={setPage} />
        </div>

        <div className="panel">
          <div className="panel-head"><div><div className="panel-title">Saved Ads source status</div><div className="page-sub">What the scheduled worker has actually persisted for this account. A source with no seed timestamp has never run.</div></div></div>
          <div className="recon-table-scroll">
            <table className="recon-table" style={{ minWidth: 900 }}>
              <thead>
                <tr>
                  <th className="recon-left">Source</th>
                  <th className="recon-left">Ad-product coverage</th>
                  <th>Rows in window</th>
                  <th>Seeded</th>
                  <th>Last daily sync</th>
                  <th>Latest day</th>
                  <th className="recon-left">Status</th>
                </tr>
              </thead>
              <tbody>
                {(data.sourceAvailability || []).map((entry) => (
                  <tr key={entry.key}>
                    <td>{entry.label}{entry.defaultDataset === false ? " *" : ""}</td>
                    <td>{entry.coverage}</td>
                    <td className="mono">{nInt(entry.rows)}</td>
                    <td className="mono">{entry.sync?.initial_seeded_at ? new Date(entry.sync.initial_seeded_at).toLocaleDateString() : "never"}</td>
                    <td className="mono">{entry.sync?.last_daily_sync_at ? new Date(entry.sync.last_daily_sync_at).toLocaleDateString() : "—"}</td>
                    <td className="mono">{entry.sync?.latest_metric_date || "—"}</td>
                    <td title={entry.sync?.last_error || ""}>{entry.sync?.last_status || "no state recorded"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="page-sub" style={{ marginTop: 10 }}>* Not a default DataDoe table — it must be enabled in DataDoe Settings &gt; Data tables before the worker can persist it.</div>
        </div>

        <div className="footer-note">
          Every advertising figure here is read from the <strong>persisted Supabase Amazon Ads history</strong>, not from a live export: opening this report, switching level, filtering, sorting and even pressing Refresh do not run an Amazon Ads export, so dashboard traffic cannot consume Ads quota. The scheduled worker owns those exports and keeps late attribution correct by re-fetching each source's documented rolling window (21 days daily, 49 days monthly) and upserting on its natural daily key, so a figure Amazon revises is replaced rather than added twice. Sources: <code>Ad Performance by Campaign &amp; Date</code>, <code>Ad Performance by ASIN &amp; Date</code> (same-SKU attributed), <code>Keyword Targeting Performance</code> (SP + SB + SD) and <code>Search Term Performance</code> (SP + SB only).
          {" "}ACoS, ROAS, CPC, CTR and CVR are recomputed from summed spend, sales, clicks, impressions and orders — no ratio is ever summed or averaged. TACoS is ad spend ÷ total account sales from <code>{data.totalSalesSourceLabel}</code>, the one non-Ads figure this report needs, which is fetched once per refresh and can lag about {data.totalSalesLagDays} days. <strong>Dead spend</strong> is the whole spend of a row with clicks but no attributed orders, and only above {data.minClicksForWaste} clicks so a small sample is not called waste. A <strong>break-even breach</strong> counts only the spend <em>above</em> your break-even ACoS as wasted, because the sales up to that point are still worth buying. Scaling candidates are shown separately as opportunities. This report is strictly read-only: it never changes a bid, a budget, or a negative keyword. The break-even input, level tabs, filters, search, sorting, paging and both exports are all local.
        </div>
      </>}
    </div>
  );
}
