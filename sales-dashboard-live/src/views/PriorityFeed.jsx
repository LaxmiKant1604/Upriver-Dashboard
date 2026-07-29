// Cross-report Priority Feed — one ranked list of what to fix first, combining
// only the insights the six reports could actually evidence.
//
// Two rules shape this screen:
//
//  1. Currencies are never mixed. Money at risk is only ever compared inside a
//     single currency, so the feed is grouped by currency and signals with no
//     monetary basis (search-funnel and content findings, account-level
//     patterns) are listed in their own group instead of being ranked against
//     money they do not have.
//  2. Nothing here fetches. The feed reads the same shared snapshots the six
//     reports read, and re-derives every insight locally, so opening it costs
//     no DataDoe request. A report that has never been refreshed is reported as
//     missing rather than silently contributing nothing.

import React, { useMemo, useState } from "react";
import { ListChecks } from "lucide-react";

import {
  SEVERITY_RANK,
  buildBuyBoxInsights,
  buildBuyBoxRows,
  buildListingHealthInsights,
  buildListingHealthRows,
  buildOptimizerInsights,
  buildOptimizerRows,
  buildPpcInsights,
  buildPpcRows,
  buildReturnsInsights,
  buildReturnsRows,
  buildSalesMoversInsights,
  buildSalesMoversRows,
  dedupeInsights,
  insightExportRows,
  sortInsights,
} from "../lib/insights.js";
import { downloadCsv, reportFilename } from "../lib/csv.js";
import { fmtMoney, nInt } from "../lib/format.js";
import {
  EmptyPanel,
  ExportButton,
  InsightRow,
  Notice,
  ReportHeader,
  SelectField,
  StatRow,
} from "./shared.jsx";

const NO_CURRENCY = "__none__";

export default function PriorityFeed({ reports, accountName, selectedBrand, currency }) {
  const [severityFilter, setSeverityFilter] = useState("ALL");
  const [reportFilter, setReportFilter] = useState("ALL");
  const [kindFilter, setKindFilter] = useState("risk");

  // Each contributor re-derives its insights from its own shared snapshot with
  // the current brand scope applied, so the feed always agrees with the report
  // it came from.
  const contributions = useMemo(() => {
    const out = [];

    const movers = reports.salesMovers?.data;
    if (movers && !movers.snapshotMissing) {
      const rows = buildSalesMoversRows(movers, selectedBrand);
      out.push({ key: "sales-movers", label: "Sales Movers", insights: buildSalesMoversInsights(movers, rows, currency) });
    } else {
      out.push({ key: "sales-movers", label: "Sales Movers", insights: [], missing: true });
    }

    const health = reports.listingHealth?.data;
    if (health && !health.snapshotMissing) {
      const rows = buildListingHealthRows(health, selectedBrand);
      out.push({ key: "listing-health", label: "Listing Health", insights: buildListingHealthInsights(health, rows) });
    } else {
      out.push({ key: "listing-health", label: "Listing Health", insights: [], missing: true });
    }

    const buyBox = reports.buyBox?.data;
    if (buyBox && !buyBox.snapshotMissing) {
      const rows = buildBuyBoxRows(buyBox, selectedBrand, 90);
      out.push({ key: "buy-box-loss", label: "Buy Box Loss", insights: buildBuyBoxInsights(buyBox, rows, 90) });
    } else {
      out.push({ key: "buy-box-loss", label: "Buy Box Loss", insights: [], missing: true });
    }

    const returns = reports.returns?.data;
    if (returns && !returns.snapshotMissing) {
      const rows = buildReturnsRows(returns, selectedBrand);
      out.push({ key: "returns-leakage", label: "Returns & Refunds", insights: buildReturnsInsights(returns, rows) });
    } else {
      out.push({ key: "returns-leakage", label: "Returns & Refunds", insights: [], missing: true });
    }

    const ppc = reports.ppc?.data;
    if (ppc && !ppc.snapshotMissing) {
      // Campaigns are the one non-overlapping PPC grain. Search terms, targets,
      // and ASIN rows are useful drill-downs in the PPC report but each rolls
      // up to campaign spend; adding them here would count the same exposure
      // multiple times in the global priority total.
      const campaignRows = buildPpcRows(ppc, "campaigns", { breakEvenAcos: 30, selectedBrand });
      out.push({
        key: "ppc-performance",
        label: "PPC Performance",
        insights: buildPpcInsights(ppc, campaignRows, "campaigns", 30),
      });
    } else {
      out.push({ key: "ppc-performance", label: "PPC Performance", insights: [], missing: true });
    }

    const optimizer = reports.optimizer?.data;
    if (optimizer && !optimizer.snapshotMissing && optimizer.sqpAvailable) {
      const rows = buildOptimizerRows(optimizer, selectedBrand);
      out.push({ key: "listing-optimizer", label: "Listing Optimizer", insights: buildOptimizerInsights(optimizer, rows) });
    } else {
      out.push({
        key: "listing-optimizer",
        label: "Listing Optimizer",
        insights: [],
        missing: !optimizer || optimizer.snapshotMissing,
        unavailable: optimizer && !optimizer.snapshotMissing && !optimizer.sqpAvailable,
      });
    }

    return out;
  }, [reports, selectedBrand, currency]);

  // Dedupe collapses repeated alerts for the same report, category and product
  // so one problem is not listed several times.
  const all = useMemo(
    () => dedupeInsights(contributions.flatMap((entry) => entry.insights)),
    [contributions]
  );

  const filtered = useMemo(() => all.filter((insight) => {
    if (kindFilter !== "ALL" && insight.kind !== kindFilter) return false;
    if (severityFilter !== "ALL" && insight.severity !== severityFilter) return false;
    if (reportFilter !== "ALL" && insight.reportKey !== reportFilter) return false;
    return true;
  }), [all, kindFilter, severityFilter, reportFilter]);

  // Grouping by currency is what keeps the ranking honest: money is only ever
  // compared against money in the same currency.
  const groups = useMemo(() => {
    const byCurrency = new Map();
    for (const insight of filtered) {
      const key = insight.moneyAtRisk === null || !insight.currency ? NO_CURRENCY : insight.currency;
      const list = byCurrency.get(key) || [];
      list.push(insight);
      byCurrency.set(key, list);
    }
    return [...byCurrency.entries()]
      .map(([key, list]) => ({
        currency: key === NO_CURRENCY ? null : key,
        insights: sortInsights(list),
        total: key === NO_CURRENCY ? null : list.reduce((sum, insight) => sum + (insight.moneyAtRisk || 0), 0),
      }))
      // Money-bearing groups first, largest exposure leading; the
      // no-monetary-basis group always sits last.
      .sort((a, b) => {
        if (a.currency === null) return 1;
        if (b.currency === null) return -1;
        return (b.total || 0) - (a.total || 0);
      });
  }, [filtered]);

  const missing = contributions.filter((entry) => entry.missing);
  const unavailable = contributions.filter((entry) => entry.unavailable);
  const counts = useMemo(() => ({
    high: all.filter((insight) => insight.severity === "high" && insight.kind === "risk").length,
    medium: all.filter((insight) => insight.severity === "medium" && insight.kind === "risk").length,
    opportunities: all.filter((insight) => insight.kind === "opportunity").length,
  }), [all]);

  const exportFeed = () => downloadCsv(insightExportRows(filtered), reportFilename("priority-feed", accountName, new Date().toISOString().slice(0, 10)));

  const scopeLabel = `${accountName || "the selected account"}${selectedBrand === "ALL" ? "" : ` · ${selectedBrand}`}`;

  return (
    <div className="container skupl-page">
      <ReportHeader
        title="Priority Feed"
        subtitle={`Everything the six reports can evidence for ${scopeLabel}, ranked by impact and urgency`}
      >
        <ExportButton onClick={exportFeed} disabled={!filtered.length} label="Download feed" />
      </ReportHeader>

      {missing.length > 0 && (
        <Notice tone="warn">
          {missing.length === contributions.length
            ? "None of the six reports has saved data for this account yet. Open each report and press Refresh once; the feed then combines them without any further DataDoe requests."
            : `Not yet contributing, because ${missing.length === 1 ? "it has" : "they have"} no saved snapshot for this account: ${missing.map((entry) => entry.label).join(", ")}. Open ${missing.length === 1 ? "that report" : "those reports"} and press Refresh once.`}
        </Notice>
      )}

      {unavailable.length > 0 && (
        <Notice>
          {unavailable.map((entry) => entry.label).join(", ")} has a saved snapshot but its DataDoe source is not enabled for this organisation, so it contributes nothing to the feed. Nothing is inferred in its place.
        </Notice>
      )}

      <StatRow stats={[
        { label: "High priority", value: nInt(counts.high), tone: counts.high ? "bad" : "good" },
        { label: "Medium priority", value: nInt(counts.medium) },
        { label: "Opportunities", value: nInt(counts.opportunities), tone: "good" },
        { label: "Reports contributing", value: `${contributions.length - missing.length - unavailable.length} of ${contributions.length}` },
        { label: "Signals after dedupe", value: nInt(all.length) },
      ]} />

      <div className="panel">
        <div className="panel-head">
          <div>
            <div className="panel-title">Filters</div>
            <div className="page-sub">Every filter here is local. The feed re-derives itself from the same saved snapshots the reports use.</div>
          </div>
        </div>
        <div className="recon-filters" style={{ marginBottom: 0 }}>
          <SelectField
            label="Type"
            value={kindFilter}
            onChange={setKindFilter}
            options={[
              { value: "risk", label: `Risks (${all.filter((insight) => insight.kind === "risk").length})` },
              { value: "opportunity", label: `Opportunities (${counts.opportunities})` },
              { value: "ALL", label: `Everything (${all.length})` },
            ]}
          />
          <SelectField
            label="Priority"
            value={severityFilter}
            onChange={setSeverityFilter}
            options={[
              { value: "ALL", label: "All priorities" },
              { value: "high", label: "High only" },
              { value: "medium", label: "Medium only" },
              { value: "low", label: "Low only" },
            ]}
          />
          <SelectField
            label="Report"
            value={reportFilter}
            onChange={setReportFilter}
            options={[
              { value: "ALL", label: "All reports" },
              ...contributions.map((entry) => ({ value: entry.key, label: `${entry.label} (${entry.insights.length})` })),
            ]}
          />
        </div>
      </div>

      {groups.length === 0 ? (
        <EmptyPanel icon={<ListChecks size={22} />}>
          {all.length
            ? "Nothing matches these filters."
            : missing.length === contributions.length
              ? "No saved report data for this account yet."
              : "Nothing in the saved reports met the evidence thresholds for this scope — which is a good result, not a missing one."}
        </EmptyPanel>
      ) : groups.map((group) => (
        <div className="panel priority-panel" key={group.currency || "no-currency"}>
          <div className="panel-head">
            <div>
              <div className="panel-title">
                {group.currency
                  ? `${group.currency} — ${fmtMoney(group.total, group.currency)} at risk`
                  : "Signals with no monetary basis"}
              </div>
              <div className="page-sub">
                {group.currency
                  ? `${group.insights.length} signal${group.insights.length === 1 ? "" : "s"}, ranked by money at risk within this currency only`
                  : `${group.insights.length} signal${group.insights.length === 1 ? "" : "s"} the underlying source cannot price — search-funnel and listing-content findings report counts, not revenue, so no money value is invented for them`}
              </div>
            </div>
            {group.currency && <span className="feed-source">{group.currency}</span>}
          </div>
          <div className="insight-list">
            {group.insights.map((insight) => (
              <div key={insight.id}>
                <div className="feed-source" style={{ marginBottom: 6 }}>{insight.reportLabel}</div>
                <InsightRow insight={insight} />
              </div>
            ))}
          </div>
        </div>
      ))}

      <div className="footer-note">
        This feed contains nothing of its own. It re-derives the same insights the six reports produce, from the same shared Supabase snapshots, with the current Account and Brand scope applied — so opening it makes no DataDoe request and it can never disagree with the report a signal came from. Repeated alerts for the same report, category and product are collapsed, and the most severe one survives with a note of how many were merged.
        {" "}Money at risk is compared <strong>only within a single currency</strong>: each currency gets its own ranked group and the totals are never added together or converted. Signals whose source reports counts rather than revenue — search-funnel diagnoses, listing-content gaps, account-level return patterns — are listed separately with no money value rather than being given a fabricated one. A report with no saved snapshot is named above as not contributing; it is never treated as "nothing wrong". Sorting is risks before opportunities, then priority, then money at risk, then confidence.
      </div>
    </div>
  );
}
