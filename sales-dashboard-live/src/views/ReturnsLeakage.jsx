// Returns & Refund Leakage — products ranked by the money returns actually
// cost, with the fixable cause named only when the reason mix supports it.

import React, { useMemo, useState } from "react";
import { Undo2 } from "lucide-react";

import {
  RETURN_BUCKET_META,
  buildReturnsInsights,
  buildReturnsRows,
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

const ACCESSORS = {
  productName: (row) => String(row.productName || row.asin || "").toLowerCase(),
  brand: (row) => String(row.brand || "").toLowerCase(),
  totalLeakage: (row) => row.totalLeakage,
  refundedAmount: (row) => Number(row.refundedAmount) || 0,
  returnFees: (row) => Number(row.returnFees) || 0,
  returnCount: (row) => row.returnCount,
  returnRate: (row) => row.returnRate,
  unitsShipped: (row) => row.unitsShipped,
  refundedUnitsSettled: (row) => Number(row.refundedUnitsSettled) || 0,
  cogsOnRefundedUnits: (row) => Number(row.cogsOnRefundedUnits) || 0,
  actionableShare: (row) => row.actionableShare,
  dominantBucket: (row) => row.dominantBucket || "zzz",
};

export default function ReturnsLeakage({ data, loading, error, accountName, selectedBrand, currency }) {
  const [search, setSearch] = useState("");
  const [bucketFilter, setBucketFilter] = useState("ALL");
  const [page, setPage] = useState(1);
  const [sort, onSort] = useSortState("totalLeakage", ["productName", "brand", "dominantBucket"]);

  const rows = useMemo(() => buildReturnsRows(data, selectedBrand), [data, selectedBrand]);
  const insights = useMemo(() => buildReturnsInsights(data, rows), [data, rows]);

  const totals = useMemo(() => {
    const leakage = rows.reduce((sum, row) => sum + row.totalLeakage, 0);
    const returned = rows.reduce((sum, row) => sum + (row.returnCount || 0), 0);
    const shipped = rows.reduce((sum, row) => sum + (Number(row.unitsShipped) || 0), 0);
    const refundedUnits = rows.reduce((sum, row) => sum + (Number(row.unitsRefunded) || 0), 0);
    const actionable = rows.reduce((sum, row) => sum + (row.actionableCount || 0), 0);
    return {
      leakage,
      returned,
      cogs: rows.reduce((sum, row) => sum + (Number(row.cogsOnRefundedUnits) || 0), 0),
      // A portfolio return rate is recomputed from the summed units, never
      // averaged from the per-product rates.
      rate: shipped > 0 ? (refundedUnits / shipped) * 100 : null,
      actionableShare: returned > 0 ? (actionable / returned) * 100 : null,
    };
  }, [rows]);

  const bucketCounts = useMemo(() => {
    const counts = {};
    rows.forEach((row) => {
      if (row.dominantBucket) counts[row.dominantBucket] = (counts[row.dominantBucket] || 0) + 1;
    });
    return counts;
  }, [rows]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (bucketFilter !== "ALL" && row.dominantBucket !== bucketFilter) return false;
      if (!query) return true;
      const reasons = (row.topReasons || []).map((entry) => entry.reason).join(" ");
      return `${row.asin || ""} ${row.sku || ""} ${row.productName || ""} ${row.brand || ""} ${reasons}`.toLowerCase().includes(query);
    });
  }, [rows, search, bucketFilter]);

  const sorted = useMemo(() => sortRows(filtered, ACCESSORS, sort, "totalLeakage"), [filtered, sort]);

  React.useEffect(() => { setPage(1); }, [search, bucketFilter, selectedBrand, sort.key, sort.dir]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageRows = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const state = <SnapshotState data={data} loading={loading} error={error} label="Returns & Refund Leakage report" icon={<Undo2 size={22} />} />;
  // Money may only be totalled inside a single currency.
  const money = moneyScope(data, currency);
  const scopeLabel = `${accountName || "the selected account"}${selectedBrand === "ALL" ? "" : ` · ${selectedBrand}`}`;

  const exportTable = () => downloadCsv(sorted.map((row) => ({
    "Product Name": row.productName || "",
    ASIN: row.asin || "",
    SKU: row.sku || "",
    Brand: row.brand || "",
    Currency: row.currency || "",
    "Total Leakage": Number(row.totalLeakage || 0).toFixed(2),
    "Customer Refunds": Number(row.refundedAmount || 0).toFixed(2),
    "Return Fees (seller)": Number(row.returnFees || 0).toFixed(2),
    "Refunded Referral Fee Credit": Number(row.refundedReferralFeeCredit || 0).toFixed(2),
    "COGS on Refunded Units": Number(row.cogsOnRefundedUnits || 0).toFixed(2),
    "Returned Items": row.returnCount || 0,
    "Refunded Units (settled)": Math.round(Number(row.refundedUnitsSettled) || 0),
    "Units Shipped (window)": row.unitsShipped === null ? "" : Math.round(row.unitsShipped),
    "Units Refunded (Amazon)": row.unitsRefunded === null ? "" : Math.round(row.unitsRefunded),
    "Return Rate %": row.returnRate === null ? (row.lagInflated ? "withheld - lag artefact" : "") : row.returnRate.toFixed(1),
    "FBA Returns": row.fbaReturns || 0,
    "FBM Returns": row.fbmReturns || 0,
    "Pending Return Requests": row.pendingReturnRequests || 0,
    "Dominant Reason Bucket": row.dominantBucketMeta ? row.dominantBucketMeta.label : "",
    "Dominant Bucket Share %": row.dominantShare === null ? "" : row.dominantShare.toFixed(0),
    "Fixable Share %": row.actionableShare === null ? "" : row.actionableShare.toFixed(0),
    "Top Reasons": (row.topReasons || []).map((entry) => `${entry.reason} (${entry.count})`).join(" | "),
    "Fix Lever": row.dominantBucketMeta ? row.dominantBucketMeta.lever : "",
  })), reportFilename("returns-leakage", accountName, data?.asOf));

  const exportInsights = () => downloadCsv(insightExportRows(insights), reportFilename("returns-leakage-insights", accountName, data?.asOf));

  return (
    <div className="container skupl-page">
      <ReportHeader
        title="Returns &amp; Refund Leakage"
        subtitle={`Products ranked by the money returns cost for ${scopeLabel}, not by return percentage alone`}
      />

      {state}

      <StaleScopeNotice data={data} />

      {data && !data.snapshotMissing && <>
        <FreshnessBar items={[
          `${data.window.days}-day window ${fmtDateHuman(data.window.from)} – ${fmtDateHuman(data.window.to)}`,
          `reasons from ${data.returnsSourceLabel} (about ${data.returnHistoryDays} days of history)`,
          `money from ${data.moneySourceLabel} REFUND events`,
          `rates from ${data.rateSourceLabel}, which can lag about ${data.rateSourceLagDays} days`,
          snapshotFreshnessLabel(data),
        ]} />

        <Notice>
          A refund only exists here once Amazon posts a <strong>REFUND settlement event</strong>. Cancelled orders never settle and so never appear as refunds, and a return that is still awaiting approval shows as a pending return request rather than as money lost. {data.pendingReturnRequests > 0 ? `${data.pendingReturnRequests} return request${data.pendingReturnRequests === 1 ? " is" : "s are"} still pending approval in this window.` : "No return requests are pending approval in this window."}
        </Notice>

        {(data.currencies?.length || 0) > 1 && (
          <Notice>
            This account reports {data.currencies.join(", ")}. Each product keeps its settlement currency and the totals below are only meaningful for a single-currency scope; nothing is converted.
          </Notice>
        )}

        {(data.fbmOnly?.sellerBorneLabelCost > 0 || data.fbmOnly?.refundedAmount > 0) && (
          <Notice>
            The Returns source also reports FBM-only figures for this window: {fmtMoney(data.fbmOnly.refundedAmount, currency)} of refunded amount and {fmtMoney(data.fbmOnly.sellerBorneLabelCost, currency)} of return labels billed to the seller. These are shown separately because those two columns exist for FBM returns only and are not part of the per-product leakage above, which comes from settlement events covering both channels.
          </Notice>
        )}

        <StatRow stats={[
          { label: "Return leakage", value: totalMoney(totals.leakage, money, fmtMoney), tone: totals.leakage > 0 && !money.mixed ? "bad" : "good", hint: money.mixed ? "This account reports more than one currency, so a combined total would be meaningless." : undefined },
          { label: "Returned items", value: nInt(totals.returned) },
          { label: "Return rate", value: totals.rate === null ? "—" : fmtRate(totals.rate), hint: "Units refunded divided by units shipped, recomputed from the summed units" },
          { label: "Fixable share", value: totals.actionableShare === null ? "—" : fmtRate(totals.actionableShare, 0), hint: "Product, listing and sizing reasons as a share of all returns" },
          { label: "COGS on refunded units", value: totalMoney(totals.cogs, money, fmtMoney), hint: "Goods value tied to refunded units. Not counted as leakage: the source does not say whether the stock came back sellable." },
        ]} />

        <PriorityActions
          insights={insights}
          mixedCurrency={(data.currencies?.length || 0) > 1}
          onExport={exportInsights}
          exportDisabled={!insights.length}
          emptyNote="No product lost enough to returns in this window to justify an action."
        />

        <div className="panel skupl-table-panel" style={{ padding: 0, overflow: "hidden" }}>
          <div className="skupl-toolbar">
            <SearchField value={search} onChange={setSearch} placeholder="ASIN, SKU, product, brand, or reason" />
            <SelectField
              label="Dominant cause"
              value={bucketFilter}
              onChange={setBucketFilter}
              options={[
                { value: "ALL", label: `All causes (${rows.length})` },
                ...Object.entries(RETURN_BUCKET_META).map(([key, meta]) => ({
                  value: key,
                  label: `${meta.label} (${bucketCounts[key] || 0})`,
                })),
              ]}
            />
            <div className="skupl-toolbar-spacer" />
            <ExportButton onClick={exportTable} disabled={!sorted.length} />
          </div>
          <div className="plan-scroll">
            <table className="plan-table returns-table">
              <thead>
                <tr>
                  <SortTh className="pt-id" label="Product / ASIN" col="productName" sort={sort} onSort={onSort} align="left" />
                  <SortTh label="Total Leakage" col="totalLeakage" sort={sort} onSort={onSort} hint="Customer refunds plus seller-borne return fees" />
                  <SortTh label="Refunds" col="refundedAmount" sort={sort} onSort={onSort} />
                  <SortTh label="Return Fees" col="returnFees" sort={sort} onSort={onSort} />
                  <SortTh label="COGS Refunded" col="cogsOnRefundedUnits" sort={sort} onSort={onSort} hint="Goods value on refunded units. Not included in leakage." />
                  <SortTh label="Returned Items" col="returnCount" sort={sort} onSort={onSort} />
                  <SortTh label="Refunded Units" col="refundedUnitsSettled" sort={sort} onSort={onSort} />
                  <SortTh label="Units Shipped" col="unitsShipped" sort={sort} onSort={onSort} />
                  <SortTh label="Return Rate" col="returnRate" sort={sort} onSort={onSort} />
                  <SortTh label="Fixable %" col="actionableShare" sort={sort} onSort={onSort} />
                  <SortTh label="Dominant Reason" col="dominantBucket" sort={sort} onSort={onSort} align="left" />
                </tr>
              </thead>
              <tbody>
                {pageRows.map((row) => (
                  <tr key={`${row.currency || "na"}|${row.asin}`} className={row.returnRate !== null && row.returnRate >= 15 ? "plan-restock" : ""}>
                    <IdentityCell name={row.productName} primary={row.asin} secondary={row.sku} brand={row.brand} />
                    <td className="mono pt-strong sku-neg">{fmtMoney(row.totalLeakage, row.currency || currency)}</td>
                    <td className="mono">{fmtMoney(row.refundedAmount, row.currency || currency)}</td>
                    <td className="mono">{fmtMoney(row.returnFees, row.currency || currency)}</td>
                    <td className="mono">{row.cogsOnRefundedUnits ? fmtMoney(row.cogsOnRefundedUnits, row.currency || currency) : "—"}</td>
                    <td className="mono">{nInt(row.returnCount)}</td>
                    <td className="mono">{nInt(row.refundedUnitsSettled)}</td>
                    <td className="mono">{row.unitsShipped === null ? "—" : nInt(row.unitsShipped)}</td>
                    <td className="mono">
                      {row.returnRate === null
                        ? <span className="movers-unattributed" title={row.lagInflated ? "More units were refunded than shipped inside this window, so these returns belong to earlier sales. A percentage here would be meaningless, so it is withheld and the row is ranked by money instead." : "No shipped units in the window to divide by."}>{row.lagInflated ? "lag*" : "—"}</span>
                        : fmtRate(row.returnRate)}
                    </td>
                    <td className="mono">{row.actionableShare === null ? "—" : fmtRate(row.actionableShare, 0)}</td>
                    <td className="returns-reason">
                      {row.dominantBucketMeta
                        ? <>
                          <span className={"pt-badge sku-badge-" + (row.dominantBucketMeta.actionable ? "warn" : "ok")} title={row.dominantBucketMeta.action}>
                            {row.dominantBucketMeta.label}
                          </span>
                          <div className="buybox-cause-detail">
                            {row.dominantShare === null ? "" : `${row.dominantShare.toFixed(0)}% of returns · `}
                            {(row.topReasons || []).slice(0, 2).map((entry) => `${entry.reason} (${entry.count})`).join(", ")}
                          </div>
                        </>
                        : <span className="movers-unattributed">no return records in window</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!pageRows.length && <div className="empty-note" style={{ padding: "14px 16px" }}>{rows.length ? "No products match these filters." : "No returns or refund settlements were reported for this scope in the window."}</div>}
          <Pagination page={safePage} pageCount={pageCount} onChange={setPage} />
        </div>

        <div className="footer-note">
          Ranking is by <strong>money, not percentage</strong>: a high-volume product with a modest return rate outranks a tiny product with a scary one. Total Leakage = settled customer refunds + seller-borne return fees (return commission and the FBA customer-return per-unit fee, less any restocking fee recovered), all from DataDoe <code>Settlements &amp; P&amp;L Components</code> rows where <code>settlement_type = REFUND</code> — which covers both FBA and FBM. The Returns source's own refunded amount and label cost exist for <strong>FBM only</strong>, so they are reported separately above and never mixed into these totals.
          {" "}Return rate is Amazon's own <code>units_refunded ÷ units_shipped</code> from <code>Sales &amp; Traffic by ASIN &amp; Date</code>. When more units were refunded than shipped inside the window, the returns belong to earlier sales and the rate is shown as <strong>lag*</strong> rather than as a figure above 100%. <code>COGS on refunded units</code> is displayed but deliberately excluded from leakage, because the source does not report whether returned stock came back sellable. Reason buckets come from <code>amazon_return_reason</code>; a cause is only named when one bucket accounts for at least half of a product's returns. Return history is limited to roughly {data.returnHistoryDays} days by the source itself. Currencies are never combined. Filters, search, sorting, paging and both exports are local; only Refresh calls DataDoe, and it saves one shared snapshot for every user with access to this account.
        </div>
      </>}
    </div>
  );
}
