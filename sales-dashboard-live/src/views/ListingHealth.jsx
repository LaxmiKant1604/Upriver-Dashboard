// Listing Health / Suppressed Listings — which offers are not selling normally,
// ranked by the sales actually at risk.

import React, { useMemo, useState } from "react";
import { ShieldAlert } from "lucide-react";

import {
  LISTING_GATES,
  buildListingHealthInsights,
  buildListingHealthRows,
  insightExportRows,
} from "../lib/insights.js";
import { downloadCsv, reportFilename } from "../lib/csv.js";
import { fmtDateHuman, fmtMoney, nInt } from "../lib/format.js";
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

const GATE_ORDER = ["error", "suppressed", "inactive", "incomplete", "stranded", "no_price", "warning", "ok"];
const GATE_RANK = Object.fromEntries(GATE_ORDER.map((gate, index) => [gate, index]));

const ACCESSORS = {
  productName: (row) => String(row.productName || row.sku || "").toLowerCase(),
  sku: (row) => String(row.sku || "").toLowerCase(),
  brand: (row) => String(row.brand || "").toLowerCase(),
  gate: (row) => GATE_RANK[row.gate],
  status: (row) => String(row.listingStatus || "").toLowerCase(),
  channel: (row) => String(row.fulfillmentChannel || "").toLowerCase(),
  price: (row) => row.price,
  unitsOnHand: (row) => row.unitsOnHand,
  sales30d: (row) => Number(row.sales30d) || 0,
  units30d: (row) => Number(row.units30d) || 0,
  salesAtRisk: (row) => row.salesAtRisk,
  issueCount: (row) => row.errors.length + row.warnings.length,
};

export default function ListingHealth({ data, loading, error, accountName, selectedBrand, currency }) {
  const [search, setSearch] = useState("");
  const [gateFilter, setGateFilter] = useState("ISSUES");
  const [channelFilter, setChannelFilter] = useState("ALL");
  const [page, setPage] = useState(1);
  const [sort, onSort] = useSortState("salesAtRisk", ["productName", "sku", "brand", "status", "channel", "gate"]);

  const rows = useMemo(() => buildListingHealthRows(data, selectedBrand), [data, selectedBrand]);
  const insights = useMemo(() => buildListingHealthInsights(data, rows), [data, rows]);

  const counts = useMemo(() => {
    const result = Object.fromEntries(GATE_ORDER.map((gate) => [gate, 0]));
    rows.forEach((row) => { result[row.gate] = (result[row.gate] || 0) + 1; });
    return result;
  }, [rows]);

  const totals = useMemo(() => {
    const problems = rows.filter((row) => row.gate !== "ok");
    return {
      problems: problems.length,
      salesAtRisk: problems.reduce((sum, row) => sum + row.salesAtRisk, 0),
      strandedUnits: rows.filter((row) => row.gate === "stranded").reduce((sum, row) => sum + row.unitsOnHand, 0),
      blocked: rows.filter((row) => ["error", "suppressed", "inactive"].includes(row.gate)).length,
    };
  }, [rows]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (gateFilter === "ISSUES" && row.gate === "ok") return false;
      if (gateFilter !== "ISSUES" && gateFilter !== "ALL" && row.gate !== gateFilter) return false;
      if (channelFilter !== "ALL" && (row.fulfillmentChannel || "unknown") !== channelFilter) return false;
      if (!query) return true;
      return `${row.sku || ""} ${row.asin || ""} ${row.productName || ""} ${row.brand || ""} ${row.errors.map((issue) => `${issue.code} ${issue.message}`).join(" ")}`
        .toLowerCase().includes(query);
    });
  }, [rows, search, gateFilter, channelFilter]);

  const sorted = useMemo(() => sortRows(filtered, ACCESSORS, sort, "salesAtRisk"), [filtered, sort]);

  React.useEffect(() => { setPage(1); }, [search, gateFilter, channelFilter, selectedBrand, sort.key, sort.dir]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageRows = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const state = <SnapshotState data={data} loading={loading} error={error} label="Listing Health report" icon={<ShieldAlert size={22} />} />;
  // Money may only be totalled inside a single currency.
  const money = moneyScope(data, currency);
  const scopeLabel = `${accountName || "the selected account"}${selectedBrand === "ALL" ? "" : ` · ${selectedBrand}`}`;

  const exportTable = () => downloadCsv(sorted.map((row) => ({
    "Product Name": row.productName || "",
    SKU: row.sku || "",
    ASIN: row.asin || "",
    Brand: row.brand || "",
    "Health Gate": row.gateMeta.label,
    "Listing Status": row.listingStatus || "",
    Fulfilment: row.fulfillmentChannel || "",
    Price: row.price === null ? "" : Number(row.price).toFixed(2),
    Currency: row.currency || currency || "",
    "Units On Hand": Math.round(row.unitsOnHand),
    "Sales (30d)": Number(row.sales30d || 0).toFixed(2),
    "Units (30d)": Math.round(Number(row.units30d) || 0),
    "Sales At Risk": Number(row.salesAtRisk || 0).toFixed(2),
    "Error Issues": row.errors.map((issue) => `${issue.code || ""} ${issue.message || ""}`.trim()).join(" | "),
    "Warning Issues": row.warnings.map((issue) => `${issue.code || ""} ${issue.message || ""}`.trim()).join(" | "),
    "Buyable Flag": row.summary ? String(row.summary.buyable) : "",
    "Discoverable Flag": row.summary ? String(row.summary.discoverable) : "",
    "Why Flagged": row.gateMeta.blurb,
  })), reportFilename("listing-health", accountName, data?.asOf));

  const exportInsights = () => downloadCsv(insightExportRows(insights), reportFilename("listing-health-insights", accountName, data?.asOf));

  const gateOptions = [
    { value: "ISSUES", label: `Needs attention (${totals.problems})` },
    { value: "ALL", label: `All listings (${rows.length})` },
    ...GATE_ORDER.map((gate) => ({ value: gate, label: `${LISTING_GATES[gate].label} (${counts[gate] || 0})` })),
  ];

  return (
    <div className="container skupl-page">
      <ReportHeader
        title="Listing Health"
        subtitle={`Suppressed, inactive, incomplete and stranded listings for ${scopeLabel}, ranked by sales at risk`}
      />

      {state}

      <StaleScopeNotice data={data} />

      {data && !data.snapshotMissing && <>
        <FreshnessBar items={[
          `${data.sourceLabel} as of ${fmtDateHuman(data.asOf)}`,
          `sales at risk from ${data.salesSourceLabel}, ${data.salesWindow.days} days to ${fmtDateHuman(data.salesWindow.to)}`,
          data.inventoryAvailable ? `FBA snapshot ${fmtDateHuman(data.inventorySnapshotDate)}` : "FBA snapshot unavailable",
          data.issuesAvailable ? `Amazon issue codes from ${data.issuesSourceLabel}` : "Amazon issue codes unavailable",
          snapshotFreshnessLabel(data),
        ]} />

        {!data.issuesAvailable && (
          <Notice tone="warn">
            {data.issuesUnavailableReason} Until then this report detects problems from <code>listing_status</code>, price, stock and offer data only, so a listing that Amazon has suppressed while still marked Active will not be labelled Suppressed. Nothing is inferred in its place.
          </Notice>
        )}

        {!data.inventoryAvailable && (
          <Notice tone="warn">
            The FBA inventory snapshot is unavailable, so units on hand fall back to the quantities on the listing record itself. Stranded-stock detection is less reliable until the snapshot returns.
          </Notice>
        )}

        {(data.currencies?.length || 0) > 1 && (
          <Notice>
            This account reports {data.currencies.join(", ")}. Sales at risk is shown in each listing's own currency and is never combined across currencies, so the total below is only meaningful for a single-currency scope.
          </Notice>
        )}

        <StatRow stats={[
          { label: "Listings scanned", value: nInt(rows.length) },
          { label: "Needs attention", value: nInt(totals.problems), tone: totals.problems ? "bad" : "good" },
          { label: "Blocked from selling", value: nInt(totals.blocked), tone: totals.blocked ? "bad" : "good" },
          { label: "Sales at risk (30d)", value: totalMoney(totals.salesAtRisk, money, fmtMoney), tone: totals.salesAtRisk > 0 && !money.mixed ? "bad" : undefined, hint: money.mixed ? "This account reports more than one currency, so a combined total would be meaningless." : undefined },
          { label: "Stranded units", value: nInt(totals.strandedUnits) },
        ]} />

        <PriorityActions
          insights={insights}
          mixedCurrency={(data.currencies?.length || 0) > 1}
          onExport={exportInsights}
          exportDisabled={!insights.length}
          emptyNote="Every listing in this scope is active, priced, and free of reported issues."
        />

        <div className="panel skupl-table-panel" style={{ padding: 0, overflow: "hidden" }}>
          <div className="skupl-toolbar">
            <SearchField value={search} onChange={setSearch} placeholder="SKU, ASIN, product, brand, or issue text" />
            <SelectField label="Health gate" value={gateFilter} onChange={setGateFilter} options={gateOptions} />
            <SelectField
              label="Fulfilment"
              value={channelFilter}
              onChange={setChannelFilter}
              options={[
                { value: "ALL", label: "All channels" },
                { value: "FBA", label: "FBA" },
                { value: "FBM", label: "FBM" },
                { value: "unknown", label: "Unknown" },
              ]}
            />
            <div className="skupl-toolbar-spacer" />
            <ExportButton onClick={exportTable} disabled={!sorted.length} />
          </div>
          <div className="plan-scroll">
            <table className="plan-table listing-health-table">
              <thead>
                <tr>
                  <SortTh className="pt-id" label="Product / SKU" col="productName" sort={sort} onSort={onSort} align="left" />
                  <SortTh label="Gate" col="gate" sort={sort} onSort={onSort} align="left" />
                  <SortTh label="Status" col="status" sort={sort} onSort={onSort} align="left" />
                  <SortTh label="Channel" col="channel" sort={sort} onSort={onSort} align="left" />
                  <SortTh label="Price" col="price" sort={sort} onSort={onSort} />
                  <SortTh label="On Hand" col="unitsOnHand" sort={sort} onSort={onSort} hint="FBA snapshot units for FBA offers, merchant quantity for FBM. These views of stock are never added together." />
                  <SortTh label="Sales (30d)" col="sales30d" sort={sort} onSort={onSort} />
                  <SortTh label="Units (30d)" col="units30d" sort={sort} onSort={onSort} />
                  <SortTh label="Sales at Risk" col="salesAtRisk" sort={sort} onSort={onSort} />
                  <SortTh label="Amazon Issue" col="issueCount" sort={sort} onSort={onSort} align="left" />
                </tr>
              </thead>
              <tbody>
                {pageRows.map((row) => {
                  const issue = row.errors[0] || row.warnings[0] || null;
                  return (
                    <tr key={`${row.sku || ""}|${row.asin || ""}`} className={["error", "suppressed", "inactive"].includes(row.gate) ? "skupl-row-loss" : row.gate === "ok" ? "" : "plan-restock"}>
                      <IdentityCell name={row.productName} primary={row.sku || "—"} secondary={row.asin} brand={row.brand} />
                      <td className="pt-left"><span className={"pt-badge sku-badge-" + row.gateMeta.tone} title={row.gateMeta.blurb}>{row.gateMeta.label}</span></td>
                      <td className="pt-left">{row.listingStatus || "—"}</td>
                      <td className="pt-left">{row.fulfillmentChannel || "—"}</td>
                      <td className="mono">{row.price === null ? "—" : fmtMoney(row.price, row.currency || currency, 2)}</td>
                      <td className="mono">{nInt(row.unitsOnHand)}</td>
                      <td className="mono">{fmtMoney(row.sales30d, row.currency || currency)}</td>
                      <td className="mono">{nInt(row.units30d)}</td>
                      <td className={"mono pt-strong" + (row.salesAtRisk > 0 ? " sku-neg" : "")}>{row.gate === "ok" ? "—" : fmtMoney(row.salesAtRisk, row.currency || currency)}</td>
                      <td className="listing-issue">
                        {issue
                          ? <span title={issue.message || ""}>{issue.severity}{issue.code ? ` ${issue.code}` : ""}{issue.message ? `: ${issue.message}` : ""}</span>
                          : data.issuesAvailable ? "—" : <span className="movers-unattributed" title={data.issuesUnavailableReason}>not available</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!pageRows.length && <div className="empty-note" style={{ padding: "14px 16px" }}>{rows.length ? "No listings match these filters." : "No listings were returned for this account and brand."}</div>}
          <Pagination page={safePage} pageCount={pageCount} onChange={setPage} />
        </div>

        <div className="footer-note">
          Listing state comes from DataDoe <code>Listings</code>: <code>listing_status</code> is Amazon's own Active / Inactive / Incomplete value, <code>listing_fulfillment_channel</code> distinguishes FBM (<code>DEFAULT</code>) from FBA, and price, currency and quantities come from the same record. Sales at risk is the trailing {data.salesWindow.days}-day <code>total_sales</code> for that SKU from <code>Profit by SKU &amp; Date</code> — the money that stops while the listing cannot sell normally, not a forecast. Units on hand uses the FBA snapshot for FBA offers and the merchant quantity for FBM offers; these are different views of the same stock and are never added.
          {" "}Gates are checked in order: reported ERROR issue, missing buyable/discoverable flag, Inactive, Incomplete, stock on hand with no active or buyable offer (stranded), Active with no price, then WARNING/INFO issues. Amazon's own issue severity, code and message require the non-default <code>Listings (Raw JSON)</code> table; when it is not enabled the report says so rather than inferring suppression. Currencies are never combined. Filters, search, sorting, paging and both exports run locally; only Refresh calls DataDoe, and it saves one shared snapshot for every user with access to this account.
        </div>
      </>}
    </div>
  );
}
