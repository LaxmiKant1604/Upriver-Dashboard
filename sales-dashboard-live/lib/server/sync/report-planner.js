// Scheduler v2 -- production-shape SHADOW planner for Daily Reporting, SKU P&L, FBA Shipment Plan
// and Reconciliation.
//
// Turns an authorized account (from the account directory) into a single-account report request
// carrying the exact source-contract windows the approved contracts declare, plus a planned context
// whose scope (accountId / rawSellerId / from / to / brand / asOf) is AUTHORITATIVE. It resolves the
// raw seller/vendor id from account metadata (resolveDataDoeAccountIds), NEVER from untrusted rows,
// and keeps primary vs dd-secondary organizations isolated (one connection per account; the raw id
// and the org fingerprint come from that connection). The request feeds buildDependencyPlan() ->
// runSourceJobs (source half) and runReportJobs (derive half). SHADOW MODE: not wired to any
// cron/route; report-controls keeps every planned report locked until live approval.
//
// Only Daily Reporting (ALL-brand), SKU P&L, FBA Shipment Plan and Reconciliation are planned here.
// No other adapter (Keyword Rank, insight reports) is started.

import { resolveDataDoeAccountIds, classifyDirectoryAccounts } from "../datadoe-connections.js";
import { reportSourceRequestHashes, REPORT_SOURCE_CONTRACTS, evaluateFallbackCondition, evaluateStagedActivation, evaluateAdsCurrencyGate, salesMoversWindows, isValidCalendarDate } from "./report-source-contracts.js";
import { REPORT_DERIVATIONS } from "./report-derivation.js";
import { monthBackStr, monthStartStr, splitDateRangeByMonth, sixCompleteCalendarMonths, planMonthWindows, addDaysStr, splitDateRangeByDays, canonicalOliSlices } from "../date-windows.js";
import { bucketForCountry } from "./registry.js";
import { buildDependencyPlan } from "./planner.js";
import { assignAccountBatches, batchSellerIds, MAX_ACCOUNTS_PER_BATCH } from "./source-batching.js";
import { organizationFingerprint, accountScopeHash } from "../source-identity.js";
import { awdCapableMarketplace } from "../reports/awd-capability.js";
import { regionForMarketplace } from "./campaign-region-routing.js";

// Daily Reporting spans the last SIX calendar months exactly as the live UI does:
// [monthBack(asOf, 5).from .. asOf] (first day of the month five months back .. today). The prior
// 150-day approximation (monthStart(asOf)-150d) silently trimmed the first days of the oldest month.
const DAILY_MONTHS_BACK = 5;

// Brand Sales lookback (days back from asOf's month start) -- byte-identical to the live window
// (src/App.jsx ~1286 + registry.js): addDaysStr(monthStartStr(asOf), -420). Both the Order Line Items
// superset AND the Product Catalog span this SAME {from,to} (buildBrandSalesPayload passes one window
// to both), so the scheduled windows match the live route exactly.
const BRAND_SALES_MONTH_START_LOOKBACK_DAYS = 420;

// Content Change Alerts catalog lookback (days) -- byte-identical to the api/datadoe.js content-changes
// route: catalogFrom = addDaysStr(asOf, -365). The notification EVENTS source is no-date (event_time
// DESC; from/to null); only the catalog carries the 365-day window.
const CONTENT_CHANGES_CATALOG_LOOKBACK_DAYS = 365;

// FBA inventory-health lookback (days) -- byte-identical to the api/datadoe.js PLAN_INVENTORY_LOOKBACK_DAYS
// constant, so the scheduled inventory window (asOf-10d..asOf) matches the live route exactly.
const FBA_INVENTORY_LOOKBACK_DAYS = 10;

// Keyword Rank SQP + catalog lookbacks (days) -- byte-identical to the api/datadoe.js
// SQP_WEEKLY_LOOKBACK_DAYS / SQP_MONTHLY_LOOKBACK_DAYS (the monthly SQP + 365-day catalog share the
// long window), so the scheduled SQP/catalog windows match the live route exactly.
const SQP_WEEKLY_LOOKBACK_DAYS = 84;
const SQP_LONG_LOOKBACK_DAYS = 365;
// Listing & Search Optimizer SQP lookback (days) -- byte-identical to listing-optimizer.js LOOKBACK_DAYS.
const OPT_LOOKBACK_DAYS = 84;

// Sales Movers lookbacks (days) -- byte-identical to the live builder/sources: the latest-completed-date
// probe looks back (SALES_TRAFFIC.lagDays 4 + WINDOW_DAYS*3 = 25) days; the shared FBA inventory snapshot
// looks back FBA_INVENTORY_HEALTH.snapshotLookbackDays (10). The recent/prior weeks come from
// salesMoversWindows(latest); WINDOW_DAYS is 7.
const SM_LAG_DAYS = 4;
const SM_WINDOW_DAYS = 7;
const SM_INVENTORY_LOOKBACK_DAYS = 10;

// Buy Box Loss lookbacks (days) -- byte-identical to the live builder/sources: buy-box.js WINDOW_DAYS (28)
// + SLICE_DAYS (7) fetch the raw daily grain as four ordered 7-day slices; the shared FBA inventory
// snapshot looks back FBA_INVENTORY_HEALTH.snapshotLookbackDays (10). So the scheduled windows match the
// live route exactly, and the derivation (which recomputes the same windows) validates them by construction.
const BB_WINDOW_DAYS = 28;
const BB_SLICE_DAYS = 7;
const BB_INVENTORY_LOOKBACK_DAYS = 10;

// Returns & Refund Leakage lookback (days) -- byte-identical to the live builder/sources: returns.js
// WINDOW_DAYS = RETURNS.historyDays (60). Returns, settlements and traffic all span [asOf-59d, asOf]; the
// catalog is the shared no-date insight catalog. So the scheduled windows match the live route exactly.
const RET_WINDOW_DAYS = 60;

// Listing Health lookbacks (days) -- byte-identical to the live builder/sources: listing-health.js
// SALES_WINDOW_DAYS (30) for the trailing sales window, FBA_INVENTORY_HEALTH.snapshotLookbackDays (10) for
// the shared inventory snapshot. Listings, Listings (Raw JSON) and the catalog are no-date. So the scheduled
// windows match the live route exactly.
const LH_SALES_WINDOW_DAYS = 30;
const LH_INVENTORY_LOOKBACK_DAYS = 10;

// Gate-6 Cycle-1 timeout remediation: DataDoe terminally TIMEOUTed the largest dated exports (whole-month
// Sales&Traffic/order/settlement fragments, the 60-day Returns range). For sources whose rows are PER-DAY
// (their groupBy -- or raw grain -- includes `date`), any partition of the window partitions the output rows
// EXACTLY, so smaller non-overlapping fragments concatenate to the identical fold. These sources now plan
// bounded <=7-day slices (the established buy-box slicing policy, splitDateRangeByDays -- ordered, gapless,
// non-overlapping, exact original from/to). Month-scoped sources slice WITHIN each calendar month so every
// fragment still lies in exactly one month (reconciliation's month-set integrity is preserved by
// construction). Sources whose groupBy EXCLUDES date (whole-window aggregate rows: sku-pl monthly-profit,
// fba-plan monthly-units, listing-health sales, sales-movers traffic/ads, returns settlements/traffic) and
// no-date/current-state sources are NOT sliced -- splitting would change their row identity/semantics.
// This is an INTENTIONAL request-window change: the affected request_hashes change and are golden-tested.
const TIMEOUT_SAFE_SLICE_DAYS = 7;
const sliceWindowByDays = (from, to) => splitDateRangeByDays(from, to, TIMEOUT_SAFE_SLICE_DAYS);
const sliceMonthsByDays = (months) => months.flatMap((m) => sliceWindowByDays(m.from, m.to));
export { TIMEOUT_SAFE_SLICE_DAYS };

export const SHADOW_PLANNED_REPORT_KEYS = Object.freeze(["brand-sales", "daily-reporting", "content-changes", "sku-pl", "fba-plan", "reconciliation", "buy-box-loss", "returns-leakage", "listing-health"]);

// Keyword Rank is NOT a generic single-shot plan: its weekly->monthly fallback and catalog token
// are staged per account by runKeywordRankShadowCycle (keyword-rank-cycle.js). It therefore has ONE
// canonical entry point and MUST NOT flow through the eager generic builder (which would emit weekly +
// an eager catalog with no account-scoped fallback orchestration). buildShadowReportPlan rejects it
// fail-closed rather than silently planning or silently dropping a requested key.
export const STAGED_CYCLE_REPORT_KEYS = Object.freeze(["keyword-rank", "sales-movers", "ppc-performance", "listing-optimizer"]);

// Each staged-cycle report -> the account-scoped shadow cycle a caller must use instead of the generic
// eager builder. Surfaced in the fail-closed rejection so a mis-routed request names its correct entry point.
const STAGED_CYCLE_ENTRY_POINTS = Object.freeze({
  "keyword-rank": "runKeywordRankShadowCycle (staged weekly/monthly/catalog)",
  "sales-movers": "runSalesMoversShadowCycle (staged probe/traffic/ads/inventory/catalog)",
  "ppc-performance": "runPpcShadowCycle (persisted-Ads signal gates catalog/total-sales)",
  "listing-optimizer": "runListingOptimizerShadowCycle (staged SQP-weekly kickoff then content catalog)",
});

// PPC Performance lookback (days) -- byte-identical to ppc.js WINDOW_DAYS (30). The total-sales denominator
// spans [asOf-29d, asOf]; the catalog is no-date. PPC is NEVER in the generic planner: it must not fetch the
// catalog before the persisted Ads currency signal is validated (that would spend a DataDoe token on an
// unvalidated/unseeded account), so it is planned ONLY by runPpcShadowCycle via planPpcPerformance below.
const PPC_WINDOW_DAYS = 30;

/**
 * Resolve the AUTHORITATIVE single-account scope for the planner from account metadata.
 * Returns { accountId(public), rawSellerId, connectionId(orgId), apiKey, country, currency, bucket }.
 * Throws (fail closed) on a missing/ambiguous account, a missing marketplace country, or a missing
 * account currency. The raw seller/vendor id + currency come from account metadata -- never inferred
 * from report rows. `currency` is the authoritative account currency the Daily Ads validator uses.
 */
export function resolveAccountScope({ accountId, country, currency, connections }) {
  const publicId = String(accountId || "").trim();
  if (!publicId) throw new Error("planner requires a public accountId.");
  const resolved = resolveDataDoeAccountIds([publicId], connections);
  if (!resolved) throw new Error(`planner could not resolve account "${publicId}".`);
  // Exactly one raw id per account (resolveDataDoeAccountIds maps one public id -> one raw id).
  if (resolved.rawAccountIds.length !== 1) {
    throw new Error(`planner requires exactly one raw seller/vendor id for "${publicId}", got ${resolved.rawAccountIds.length}.`);
  }
  const marketplace = String(country || "").trim().toUpperCase();
  if (!marketplace) throw new Error(`planner requires an authoritative marketplace country for account "${publicId}".`);
  const accountCurrency = String(currency || "").trim().toUpperCase();
  if (!accountCurrency) throw new Error(`planner requires an authoritative account currency for account "${publicId}".`);
  return {
    accountId: publicId,
    rawSellerId: resolved.rawAccountIds[0],
    connectionId: resolved.connection.id, // organization id (primary | secondary)
    apiKey: resolved.connection.apiKey,   // organization-scoped credential (drives the org fingerprint)
    country: marketplace,
    currency: accountCurrency,
    bucket: bucketForCountry(marketplace),
  };
}

// Stamp each resolved source with the report's connection/bucket and its required/optional flag from
// the derivation registry, so the plan carries everything buildDependencyPlan + the workers need.
function decorateSources(sources, { reportKey, connectionId, bucket }) {
  const entry = REPORT_DERIVATIONS[reportKey];
  const optionalKeys = new Set(entry ? entry.optionalRequestKeys : []);
  return (sources || []).map((source) => ({
    ...source,
    connectionId,
    bucket,
    optional: optionalKeys.has(source.requestKey),
    // assembleSources reads `disabledPolicy` to detect a source-disabled degraded/terminal state (so the
    // report worker can degrade or block correctly); the resolver names the SAME normalized policy
    // `availabilityPolicy`. Surface it under the name the worker reads. A source with no policy stays null,
    // so this is inert for every non-degradable source (e.g. Buy Box / Returns / the required sources).
    disabledPolicy: source.availabilityPolicy || null,
  }));
}

/**
 * Plan Brand Sales (the flagship ALL-brand "Dashboard" report) for ONE account. Emits the Order Line
 * Items superset + the Product Catalog, BOTH over the SAME [monthStart(asOf)-420d, asOf] window (the
 * live route passes one {from,to} to both), for the one raw seller id. Both sources are INDEPENDENTLY
 * required (no probe / staged activation), so Brand Sales uses the generic owner-scoped source cycle,
 * never a dedicated staged driver. The derive (orderSalesByBrand) reads only the two saved source rows.
 */
export function planBrandSales({ accountId, country, currency, connections, asOf }) {
  const scope = resolveAccountScope({ accountId, country, currency, connections });
  const to = String(asOf);
  const from = addDaysStr(monthStartStr(to), -BRAND_SALES_MONTH_START_LOOKBACK_DAYS);
  const windowsByRequestKey = {
    "brand-sales:order-lines": [{ from, to }],
    "brand-sales:catalog": [{ from, to }],
  };
  const sources = reportSourceRequestHashes({
    reportKey: "brand-sales", apiKey: scope.apiKey, ids: [scope.rawSellerId],
    windowsByRequestKey, marketplaceCountry: scope.country,
  });
  return {
    reportKey: "brand-sales",
    reportVersion: REPORT_DERIVATIONS["brand-sales"].snapshotVersion,
    accountId: scope.accountId,
    connectionId: scope.connectionId,
    bucket: scope.bucket,
    sources: decorateSources(sources, { reportKey: "brand-sales", connectionId: scope.connectionId, bucket: scope.bucket }),
    context: { from, to, rawSellerId: scope.rawSellerId },
  };
}

/**
 * Plan Content Change Alerts for ONE account. Emits the NO-DATE notification EVENTS export (event_time
 * DESC; from/to null -- the notification stream is the report's only substantive source, and its
 * contract's structured availabilityPolicy blocks the report when the org disables the source) plus the
 * Product Catalog over [asOf-365d, asOf], for the one raw seller id. Both sources are INDEPENDENTLY
 * required (no probe / staged activation), so Content Changes uses the generic owner-scoped source cycle,
 * never a dedicated staged driver. The derive (contentChangesPayload) reads context.accountId (the
 * authoritative public id the worker pins) and context.retrievedAt (latest source fetch time), never a clock.
 */
export function planContentChanges({ accountId, country, currency, connections, asOf }) {
  const scope = resolveAccountScope({ accountId, country, currency, connections });
  const to = String(asOf);
  const catalogFrom = addDaysStr(to, -CONTENT_CHANGES_CATALOG_LOOKBACK_DAYS);
  const windowsByRequestKey = {
    "content-changes:events": [{ from: null, to: null }],
    "content-changes:catalog": [{ from: catalogFrom, to }],
  };
  const sources = reportSourceRequestHashes({
    reportKey: "content-changes", apiKey: scope.apiKey, ids: [scope.rawSellerId],
    windowsByRequestKey, marketplaceCountry: scope.country,
  });
  return {
    reportKey: "content-changes",
    reportVersion: REPORT_DERIVATIONS["content-changes"].snapshotVersion,
    accountId: scope.accountId,
    connectionId: scope.connectionId,
    bucket: scope.bucket,
    sources: decorateSources(sources, { reportKey: "content-changes", connectionId: scope.connectionId, bucket: scope.bucket }),
    context: { to, rawSellerId: scope.rawSellerId },
  };
}

/**
 * Plan Daily Reporting (ALL-brand only) for ONE account. Emits the ASIN/day superset (monthly
 * fragments) + the catalog (single range) over monthStart(asOf) - 150d .. asOf, all for the one raw
 * seller id. No extra Daily sales or Ads DataDoe export is added (Ads are a derive-only input read
 * from ad_daily_metrics; see daily-ads-loader.js). rawSellerId is stored in the planned context.
 */
export function planDailyReporting({ accountId, country, currency, connections, asOf }) {
  const scope = resolveAccountScope({ accountId, country, currency, connections });
  const from = monthBackStr(asOf, DAILY_MONTHS_BACK);
  const to = String(asOf);
  const windowsByRequestKey = {
    // Blocker 1: the ONE canonical Order Line Items sales fragment, sliced by canonicalOliSlices
    // (calendar-anchored bins). Interior + asOf-boundary slices share request_hashes with the other OLI
    // reports (one export, many owners); the per-day grouped slices concatenate to the identical superset.
    "daily-reporting:oli-sales": canonicalOliSlices(from, to),
    "daily-reporting:catalog": [{ from, to }],
  };
  const sources = reportSourceRequestHashes({
    reportKey: "daily-reporting", apiKey: scope.apiKey, ids: [scope.rawSellerId],
    windowsByRequestKey, marketplaceCountry: scope.country,
  });
  return {
    reportKey: "daily-reporting",
    reportVersion: REPORT_DERIVATIONS["daily-reporting"].snapshotVersion,
    accountId: scope.accountId,
    connectionId: scope.connectionId,
    bucket: scope.bucket,
    sources: decorateSources(sources, { reportKey: "daily-reporting", connectionId: scope.connectionId, bucket: scope.bucket }),
    // Planned scope is authoritative: brand ALL, the reporting window, the raw seller id (used to
    // validate every Ads row), and the account currency (used to reject mismatched/null Ads
    // currency). The worker's fail-closed context builder pins these.
    context: { brand: "ALL", from, to, rawSellerId: scope.rawSellerId, currency: scope.currency },
  };
}

/**
 * Plan SKU P&L for ONE account over exactly SIX complete consecutive calendar months (one monthly
 * fragment per month), first day of month one to last day of month six, all for the one raw seller
 * id. Reuses the strict six-month helper so the plan satisfies validateSkuPlMonthlyWindows by
 * construction. No COGS override is baked into the snapshot (the browser applies overrides at
 * display; that is unchanged).
 */
export function planSkuPl({ accountId, country, currency, connections, asOf }) {
  const scope = resolveAccountScope({ accountId, country, currency, connections });
  const span = sixCompleteCalendarMonths(asOf);
  if (!span) throw new Error(`sku-pl planner could not compute six complete calendar months from asOf "${asOf}".`);
  const windowsByRequestKey = { "sku-pl:monthly-profit": span.months };
  const sources = reportSourceRequestHashes({
    reportKey: "sku-pl", apiKey: scope.apiKey, ids: [scope.rawSellerId],
    windowsByRequestKey, marketplaceCountry: scope.country,
  });
  return {
    reportKey: "sku-pl",
    reportVersion: REPORT_DERIVATIONS["sku-pl"].snapshotVersion,
    accountId: scope.accountId,
    connectionId: scope.connectionId,
    bucket: scope.bucket,
    sources: decorateSources(sources, { reportKey: "sku-pl", connectionId: scope.connectionId, bucket: scope.bucket }),
    context: { from: span.from, to: span.to, rawSellerId: scope.rawSellerId },
  };
}

/**
 * Plan Reconciliation for ONE account over exactly SIX complete consecutive calendar months. Emits
 * the per-month order-line + settlement fragments plus a single full-range catalog, all for the one
 * raw seller id. Reuses the strict six-month helper so the plan satisfies the derivation's
 * six-complete-calendar-month contract by construction. Never mixes currencies or organizations (one
 * account, one connection). The browser localises to a single currency at display; unchanged here.
 */
export function planReconciliation({ accountId, country, currency, connections, asOf }) {
  const scope = resolveAccountScope({ accountId, country, currency, connections });
  const span = sixCompleteCalendarMonths(asOf);
  if (!span) throw new Error(`reconciliation planner could not compute six complete calendar months from asOf "${asOf}".`);
  const windowsByRequestKey = {
    // Timeout-safe slicing: whole-month order/settlement fragments TIMEOUTed on large accounts. Both are
    // per-day grouped (their groupBy includes `date`), so <=7-day slices WITHIN each of the six calendar
    // months concatenate to the identical fold; every fragment lies in exactly one month, preserving the
    // six-complete-month integrity by construction. The catalog stays one full-range fragment.
    "reconciliation:order-lines": sliceMonthsByDays(span.months),
    "reconciliation:settlements": sliceMonthsByDays(span.months),
    "reconciliation:catalog": [{ from: span.from, to: span.to }],
  };
  const sources = reportSourceRequestHashes({
    reportKey: "reconciliation", apiKey: scope.apiKey, ids: [scope.rawSellerId],
    windowsByRequestKey, marketplaceCountry: scope.country,
  });
  return {
    reportKey: "reconciliation",
    reportVersion: REPORT_DERIVATIONS.reconciliation.snapshotVersion,
    accountId: scope.accountId,
    connectionId: scope.connectionId,
    bucket: scope.bucket,
    sources: decorateSources(sources, { reportKey: "reconciliation", connectionId: scope.connectionId, bucket: scope.bucket }),
    context: { from: span.from, to: span.to, rawSellerId: scope.rawSellerId },
  };
}

/**
 * Plan FBA Shipment Plan for ONE account. Emits the exact route windows from planMonthWindows(asOf):
 * monthly-units = 3 completed months + current MTD (one fragment each), a current-month daily-date
 * probe, a catalog over completed[0].from .. asOf, an inventory-health snapshot over asOf-10d..asOf,
 * and -- for US accounts only -- the no-date AWD listing source. All for the one raw seller id.
 * `name` is the AUTHORITATIVE account name; `marketCountry` (raw) + `isUS` drive the US-only AWD +
 * per-row AWD payload fields. The AWD source is planned ONLY for US (the contract is US-conditional).
 */
export function planFbaPlan({ accountId, name, country, currency, connections, asOf }) {
  const scope = resolveAccountScope({ accountId, country, currency, connections });
  const asOfStr = String(asOf);
  const isUS = scope.country === "US";
  // OLI sales + Product Catalog are DERIVED durable dependencies for fba-plan (read from source_oli_daily_history +
  // the org Product Catalog snapshot via makeFbaPlanDurableContextLoader) -- NOT owned exports -- so the planner
  // emits NO OLI/catalog windows. Only the FBA Inventory Health snapshot + US-only AWD listing are owned exports.
  const windowsByRequestKey = {
    "fba-plan:inventory-health": [{ from: addDaysStr(asOfStr, -FBA_INVENTORY_LOOKBACK_DAYS), to: asOfStr }],
  };
  // AWD is a no-date source for the AWD-CAPABLE marketplaces (US + EU5); supply its window only for those (the
  // contract's country gate would otherwise reject an inapplicable request key). US is byte-identical (awdCapable("US")
  // === true, exactly the former isUS gate). See lib/server/reports/awd-capability.js.
  if (awdCapableMarketplace(scope.country)) windowsByRequestKey["fba-plan:awd"] = [{ from: null, to: null }];
  const sources = reportSourceRequestHashes({
    reportKey: "fba-plan", apiKey: scope.apiKey, ids: [scope.rawSellerId],
    windowsByRequestKey, marketplaceCountry: scope.country,
  });
  return {
    reportKey: "fba-plan",
    reportVersion: REPORT_DERIVATIONS["fba-plan"].snapshotVersion,
    accountId: scope.accountId,
    connectionId: scope.connectionId,
    bucket: scope.bucket,
    sources: decorateSources(sources, { reportKey: "fba-plan", connectionId: scope.connectionId, bucket: scope.bucket }),
    // asOf/name/country/isUS are authoritative account metadata the derivation reproduces in the
    // payload; rawSellerId scopes every fragment. marketCountry is the RAW account country (the
    // payload preserves it verbatim), isUS is derived from the uppercased scope country.
    context: { to: asOfStr, rawSellerId: scope.rawSellerId, accountName: name || null, marketCountry: country || null, isUS },
  };
}

// The canonical AMAZON marketplace code for an account-directory country. Amazon (and the FBA Inventory Health
// rows' marketplace_country_code) calls the United Kingdom marketplace "GB", while the account directory calls it
// "UK"; every other marketplace already matches. Used so a marketplace-safe FBA batch is validated against the code
// its rows actually carry. Exported for the batched planner + its tests.
export function marketplaceCodeFor(country) {
  const c = String(country || "").trim().toUpperCase();
  return c === "UK" ? "GB" : c;
}

/**
 * Regional FBA planning: pack each owned source independently into <=5-seller batches, across marketplaces,
 * within one region and connection/organization. Carry exact seller-marketplace pairs for source validation
 * and per-account ownership for derivation. inventoryAsOf is independent of the sales asOfFor cutoff.
 */
export function planFbaPlanBucketBatched({ accounts = [], connections, asOfFor, inventoryAsOf = null, existingFbaMembership = new Map() }) {
  const scoped = (accounts || []).map((a) => {
    const scope = resolveAccountScope({ accountId: a.accountId, country: a.country, currency: a.currency, connections });
    const asOf = String(typeof asOfFor === "function" ? asOfFor(a.country) : a.asOf);
    if (!isValidCalendarDate(asOf)) throw new Error(`planFbaPlanBucketBatched requires a real calendar as-of for account "${a.accountId}" (got "${asOf}").`);
    const inventoryTo = inventoryAsOf == null ? asOf : String(inventoryAsOf);
    if (!isValidCalendarDate(inventoryTo)) throw new Error("FBA inventoryAsOf must be a real calendar date.");
    const region = regionForMarketplace(scope.country);
    if (region === "unassigned") throw new Error("FBA account has no supported regional assignment.");
    return { account: a, scope, asOf, inventoryTo, region };
  });

  // Marketplace is NOT a partition: its exact seller binding travels with every batch instead.
  const partitions = new Map();
  for (const s of scoped) {
    const key = `${s.scope.connectionId}|${organizationFingerprint(s.scope.apiKey)}|${s.region}|${s.inventoryTo}`;
    if (!partitions.has(key)) partitions.set(key, []);
    partitions.get(key).push(s);
  }

  const requests = [];
  for (const members of partitions.values()) {
    const apiKey = members[0].scope.apiKey;
    const sourcesByAccount = new Map(members.map((m) => [m.scope.accountId, []]));
    // Pack each source independently: ineligible AWD accounts must neither be exported nor fragment the AWD batches.
    for (const requestKey of ["fba-plan:inventory-health", "fba-plan:awd"]) {
      const eligible = members.filter((m) => requestKey !== "fba-plan:awd" || awdCapableMarketplace(m.scope.country));
      const byId = new Map(eligible.map((m) => [m.scope.accountId, m]));
      const membership = new Map([...existingFbaMembership].filter(([id]) => byId.has(id)));
      const { batches } = assignAccountBatches(eligible.map((m) => ({ accountId: m.scope.accountId, rawSellerId: m.scope.rawSellerId })), membership, MAX_ACCOUNTS_PER_BATCH);
      for (const batch of batches) {
        const owners = batch.accounts.map((a) => byId.get(a.accountId));
        const pairs = owners.map((m) => ({ sellerId: m.scope.rawSellerId, marketplace: marketplaceCodeFor(m.scope.country) }));
        const markets = [...new Set(pairs.map((p) => p.marketplace))];
        const inventoryTo = owners[0].inventoryTo;
        const windowsByRequestKey = { "fba-plan:inventory-health": [{ from: addDaysStr(inventoryTo, -FBA_INVENTORY_LOOKBACK_DAYS), to: inventoryTo }] };
        if (awdCapableMarketplace(markets[0])) windowsByRequestKey["fba-plan:awd"] = [{ from: null, to: null }];
        const resolved = reportSourceRequestHashes({ reportKey: "fba-plan", apiKey, ids: batchSellerIds(batch), windowsByRequestKey, marketplaceCountry: markets[0] }).filter((s) => s.requestKey === requestKey);
        const sources = resolved.map((s) => ({ ...s, marketplaceConstraint: markets.length === 1 ? markets[0] : null,
          marketplacePairs: pairs, ...(inventoryAsOf == null ? {} : { freshnessNotBefore: inventoryTo + "T00:00:00.000Z" }) }));
        for (const m of owners) sourcesByAccount.get(m.scope.accountId).push(...sources);
      }
    }
    for (const m of members) {
        requests.push({
          reportKey: "fba-plan",
          reportVersion: REPORT_DERIVATIONS["fba-plan"].snapshotVersion,
          accountId: m.scope.accountId,
          connectionId: m.scope.connectionId,
          bucket: m.scope.bucket,
          sources: decorateSources(sourcesByAccount.get(m.scope.accountId), { reportKey: "fba-plan", connectionId: m.scope.connectionId, bucket: m.scope.bucket }),
          // COMPLETE owner metadata the report worker requires to isolate this account's rows from the shared
          // batch (missing/blank => OWNER_BINDING_MISSING, fail closed). The org fingerprint is derived from the
          // connection's api key (never printed); the individual scope is accountScopeHash([this raw seller id]).
          owner: {
            accountId: m.scope.accountId,
            rawSellerId: m.scope.rawSellerId,
            connectionId: m.scope.connectionId,
            organizationFingerprint: organizationFingerprint(m.scope.apiKey),
            accountScopeHash: accountScopeHash([m.scope.rawSellerId]),
            marketplace: marketplaceCodeFor(m.scope.country),
          },
          context: { to: m.asOf, ...(inventoryAsOf == null ? {} : { inventoryAsOf: m.inventoryTo }), rawSellerId: m.scope.rawSellerId, accountName: m.account.name || null, marketCountry: m.account.country || null, isUS: m.scope.country === "US" },
        });
    }
  }
  return requests;
}

/**
 * Regional Advanced Listing Health (SHADOW) planning: pack the region's accounts into STABLE <=5-seller batches
 * ACROSS marketplaces, within one connection/organization, for the three OWNED exports (Listings, Listings Raw,
 * inventory). Carry the EXACT seller-marketplace pairs (so every returned row is validated + isolated per account)
 * and per-account owner metadata (for derive-time isolation). OLI sales/units + Product Catalog are DERIVED durable
 * dependencies (never exports), injected into the derive context by the loader. inventoryAsOf is independent of the
 * sales asOf. This planner is NOT in PLANNERS / SHADOW_PLANNED_REPORT_KEYS: v3 is dormant (nothing dispatches it),
 * so this is invoked only by the shadow build/verify path and the zero-create dry-run.
 */
export function planListingHealthV3BucketBatched({ accounts = [], connections, asOfFor, inventoryAsOf = null, existingMembership = new Map() }) {
  const scoped = (accounts || []).map((a) => {
    const scope = resolveAccountScope({ accountId: a.accountId, country: a.country, currency: a.currency, connections });
    const asOf = String(typeof asOfFor === "function" ? asOfFor(a.country) : a.asOf);
    if (!isValidCalendarDate(asOf)) throw new Error(`planListingHealthV3BucketBatched requires a real calendar as-of for account "${a.accountId}" (got "${asOf}").`);
    const inventoryTo = inventoryAsOf == null ? asOf : String(inventoryAsOf);
    if (!isValidCalendarDate(inventoryTo)) throw new Error("listing-health-v3 inventoryAsOf must be a real calendar date.");
    const region = regionForMarketplace(scope.country);
    if (region === "unassigned") throw new Error("listing-health-v3 account has no supported regional assignment.");
    return { account: a, scope, asOf, inventoryTo, region };
  });

  // Marketplace is NOT a partition: the exact seller-marketplace binding travels on every batch (across marketplaces).
  const partitions = new Map();
  for (const s of scoped) {
    const key = `${s.scope.connectionId}|${organizationFingerprint(s.scope.apiKey)}|${s.region}|${s.inventoryTo}`;
    if (!partitions.has(key)) partitions.set(key, []);
    partitions.get(key).push(s);
  }

  const requests = [];
  for (const members of partitions.values()) {
    const apiKey = members[0].scope.apiKey;
    const byId = new Map(members.map((m) => [m.scope.accountId, m]));
    const membership = new Map([...existingMembership].filter(([id]) => byId.has(id)));
    const { batches } = assignAccountBatches(members.map((m) => ({ accountId: m.scope.accountId, rawSellerId: m.scope.rawSellerId })), membership, MAX_ACCOUNTS_PER_BATCH);
    const sourcesByAccount = new Map(members.map((m) => [m.scope.accountId, []]));
    for (const batch of batches) {
      const owners = batch.accounts.map((a) => byId.get(a.accountId));
      const pairs = owners.map((m) => ({ sellerId: m.scope.rawSellerId, marketplace: marketplaceCodeFor(m.scope.country) }));
      const markets = [...new Set(pairs.map((p) => p.marketplace))];
      const inventoryTo = owners[0].inventoryTo;
      const windowsByRequestKey = {
        "listing-health-v3:listings": [{ from: null, to: null }],
        "listing-health-v3:listings-raw": [{ from: null, to: null }],
        "listing-health-v3:inventory": [{ from: addDaysStr(inventoryTo, -FBA_INVENTORY_LOOKBACK_DAYS), to: inventoryTo }],
      };
      const resolved = reportSourceRequestHashes({ reportKey: "listing-health-v3", apiKey, ids: batchSellerIds(batch), windowsByRequestKey, marketplaceCountry: markets[0] });
      const sources = resolved.map((s) => ({ ...s, marketplaceConstraint: markets.length === 1 ? markets[0] : null,
        marketplacePairs: pairs, ...(inventoryAsOf == null ? {} : { freshnessNotBefore: inventoryTo + "T00:00:00.000Z" }) }));
      for (const m of owners) sourcesByAccount.get(m.scope.accountId).push(...sources);
    }
    for (const m of members) {
      requests.push({
        reportKey: "listing-health-v3",
        reportVersion: REPORT_DERIVATIONS["listing-health-v3"].snapshotVersion,
        accountId: m.scope.accountId,
        connectionId: m.scope.connectionId,
        bucket: m.scope.bucket,
        sources: decorateSources(sourcesByAccount.get(m.scope.accountId), { reportKey: "listing-health-v3", connectionId: m.scope.connectionId, bucket: m.scope.bucket }),
        owner: {
          accountId: m.scope.accountId,
          rawSellerId: m.scope.rawSellerId,
          connectionId: m.scope.connectionId,
          organizationFingerprint: organizationFingerprint(m.scope.apiKey),
          accountScopeHash: accountScopeHash([m.scope.rawSellerId]),
          marketplace: marketplaceCodeFor(m.scope.country),
        },
        context: { to: m.asOf, inventoryAsOf: m.inventoryTo, rawSellerId: m.scope.rawSellerId, accountId: m.scope.accountId, accountName: m.account.name || null, marketCountry: m.account.country || null },
      });
    }
  }
  return requests;
}

/**
 * Plan Keyword Rank for ONE account from that account's OWN typed weekly signal (Blocker 1: never a
 * global request-key signal). Emits the SQP-weekly probe (asOf-84d..asOf) + the 365-day catalog, and --
 * ONLY when the typed weekly signal makes the contract's `distinct_periods < 4` fallback apply -- the
 * monthly SQP request (asOf-365d..asOf). The catalog window is always resolved here (the catalog
 * contract is unconditional); the STAGED-cycle driver decides WHEN the catalog export is actually
 * spent (never before the cadence is resolved -- Blocker 2). request_hash + primary/dd-secondary
 * isolation come from the shared resolver (unchanged by staging).
 */
export function planKeywordRank({ accountId, country, currency, connections, asOf, weeklySignal = null }) {
  const scope = resolveAccountScope({ accountId, country, currency, connections });
  const end = String(asOf);
  const weeklyFrom = addDaysStr(end, -SQP_WEEKLY_LOOKBACK_DAYS);
  const longFrom = addDaysStr(end, -SQP_LONG_LOOKBACK_DAYS);
  const windowsByRequestKey = {
    "keyword-rank:sqp-weekly": [{ from: weeklyFrom, to: end }],
    "keyword-rank:catalog": [{ from: longFrom, to: end }],
  };
  const dependencySignals = {};
  if (weeklySignal != null) {
    dependencySignals["keyword-rank:sqp-weekly"] = weeklySignal;
    // Supply the monthly window ONLY when the typed weekly signal makes the fallback apply (fail
    // closed via the shared evaluateFallbackCondition); the resolver rejects an inapplicable window.
    const monthlyContract = (REPORT_SOURCE_CONTRACTS["keyword-rank"] || []).find((c) => c.requestKey === "keyword-rank:sqp-monthly");
    if (monthlyContract && evaluateFallbackCondition(monthlyContract.condition, weeklySignal)) {
      windowsByRequestKey["keyword-rank:sqp-monthly"] = [{ from: longFrom, to: end }];
    }
  }
  const sources = reportSourceRequestHashes({
    reportKey: "keyword-rank", apiKey: scope.apiKey, ids: [scope.rawSellerId],
    windowsByRequestKey, marketplaceCountry: scope.country, dependencySignals,
  });
  return {
    reportKey: "keyword-rank",
    reportVersion: REPORT_DERIVATIONS["keyword-rank"].snapshotVersion,
    accountId: scope.accountId,
    connectionId: scope.connectionId,
    bucket: scope.bucket,
    sources: decorateSources(sources, { reportKey: "keyword-rank", connectionId: scope.connectionId, bucket: scope.bucket }),
    context: { to: end, rawSellerId: scope.rawSellerId },
  };
}

/**
 * Plan Sales Movers for ONE account from that account's OWN typed latest-sales-date PROBE signal (never a
 * global request-key signal). Always emits the probe (asOf-25d..asOf). ONLY when the typed probe signal is
 * a validated success with a real reported date (the contract's `validated_success` + `requireReportedDate`
 * staged activation) does it emit the downstream: two-window traffic + ads (recent/prior from
 * salesMoversWindows), the shared FBA inventory snapshot (asOf-10d..asOf), and the shared no-date catalog.
 * A validated probe with NO date, or a failed/terminal/unvalidated probe, plans no downstream (the derive
 * then produces the honest dataUnavailable snapshot or the typed blocked/unavailable outcome). request_hash
 * + primary/dd-secondary isolation come from the shared resolver; the STAGED-cycle driver decides WHEN the
 * downstream exports are actually spent. Shared inventory/catalog identities dedupe with other reports.
 */
export function planSalesMovers({ accountId, country, currency, connections, asOf, probeSignal = null }) {
  const scope = resolveAccountScope({ accountId, country, currency, connections });
  const end = String(asOf);
  const probeFrom = addDaysStr(end, -(SM_LAG_DAYS + SM_WINDOW_DAYS * 3));
  const windowsByRequestKey = {
    "sales-movers:sales-latest-probe": [{ from: probeFrom, to: end }],
  };
  const dependencySignals = {};
  if (probeSignal != null) {
    dependencySignals["sales-movers:sales-latest-probe"] = probeSignal;
    // Stage the downstream ONLY once the typed probe validates with a real reported date (fail closed via
    // the shared evaluateStagedActivation); the resolver then binds/validates the exact recent+prior weeks.
    const trafficContract = (REPORT_SOURCE_CONTRACTS["sales-movers"] || []).find((c) => c.requestKey === "sales-movers:traffic");
    // A validated probe date is required to derive the windows; a malformed date stages no downstream (the
    // derive rejects the bad probe row as invalid instead), so the planner never throws on bad source data.
    if (trafficContract && evaluateStagedActivation(trafficContract.activation, probeSignal) && isValidCalendarDate(probeSignal.latestReportedDate)) {
      const { recent, prior } = salesMoversWindows(probeSignal.latestReportedDate);
      windowsByRequestKey["sales-movers:traffic"] = [recent, prior];
      windowsByRequestKey["sales-movers:ads"] = [recent, prior];
      windowsByRequestKey["sales-movers:inventory"] = [{ from: addDaysStr(end, -SM_INVENTORY_LOOKBACK_DAYS), to: end }];
      windowsByRequestKey["sales-movers:catalog"] = [{ from: null, to: null }];
    }
  }
  const sources = reportSourceRequestHashes({
    reportKey: "sales-movers", apiKey: scope.apiKey, ids: [scope.rawSellerId],
    windowsByRequestKey, marketplaceCountry: scope.country, dependencySignals,
  });
  return {
    reportKey: "sales-movers",
    reportVersion: REPORT_DERIVATIONS["sales-movers"].snapshotVersion,
    accountId: scope.accountId,
    connectionId: scope.connectionId,
    bucket: scope.bucket,
    sources: decorateSources(sources, { reportKey: "sales-movers", connectionId: scope.connectionId, bucket: scope.bucket }),
    context: { to: end, rawSellerId: scope.rawSellerId },
  };
}

/**
 * Plan PPC Performance for ONE account. PPC creates ZERO DataDoe Ads exports -- every advertising figure is
 * DERIVED from persisted Supabase Ads history. Its only owned DataDoe requests are the shared no-date catalog
 * and the OPTIONAL total-sales TACoS denominator ([asOf-29d, asOf]). Planning is driven ENTIRELY by the
 * validated Ads-currency signal so no DataDoe token is spent before the persisted Ads context is validated:
 *   - Ads read failed / unvalidated / unseeded  -> plan NOTHING (zero tokens; report stays last-known-good);
 *   - validated Ads with <= 1 currency          -> plan total-sales + catalog (gate includes total-sales);
 *   - validated Ads with  > 1 currency          -> plan catalog only (gate skips total-sales; TACoS unavailable).
 * The ads-currency gate lives in the shared resolver (reportSourceRequestHashes); request_hash + primary/
 * dd-secondary isolation come from there. The shared catalog identity dedupes with Sales Movers/Buy Box/
 * Returns/Listing Health. This is staged by runPpcShadowCycle, NEVER the generic planner.
 */
export function planPpcPerformance({ accountId, country, currency, connections, asOf, adsCurrencySignal = null }) {
  const scope = resolveAccountScope({ accountId, country, currency, connections });
  const end = String(asOf);
  const from = addDaysStr(end, -(PPC_WINDOW_DAYS - 1));
  const sig = adsCurrencySignal;
  const adsValidated = !!sig && sig.status === "success" && sig.validated === true;
  const base = {
    reportKey: "ppc-performance",
    reportVersion: REPORT_DERIVATIONS["ppc-performance"].snapshotVersion,
    accountId: scope.accountId,
    connectionId: scope.connectionId,
    bucket: scope.bucket,
    context: { to: end, rawSellerId: scope.rawSellerId },
  };
  // Ads read failed/unvalidated => plan NO DataDoe source (spend zero tokens; the catalog is never fetched
  // before the Ads context is validated). The report then stays last-known-good via the derive gate.
  if (!adsValidated) return { ...base, sources: [] };
  // The catalog is unconditional; the total-sales WINDOW is emitted ONLY when the ads-currency gate passes
  // (<= 1 currency), so a multi-currency account plans catalog only and the resolver is never asked to
  // resolve a source it will gate out. The signal is ALSO passed so the resolver's gate agrees by
  // construction. request_hash + primary/dd-secondary isolation come from the shared resolver.
  const windowsByRequestKey = { "ppc-performance:catalog": [{ from: null, to: null }] };
  if (evaluateAdsCurrencyGate(sig)) {
    windowsByRequestKey["ppc-performance:oli-sales"] = canonicalOliSlices(from, end);
  }
  const sources = reportSourceRequestHashes({
    reportKey: "ppc-performance", apiKey: scope.apiKey, ids: [scope.rawSellerId],
    windowsByRequestKey, marketplaceCountry: scope.country,
    dependencySignals: { "ppc-performance:ads-currency": sig },
  });
  return { ...base, sources: decorateSources(sources, { reportKey: "ppc-performance", connectionId: scope.connectionId, bucket: scope.bucket }) };
}

/**
 * Plan Listing & Search Optimizer for ONE account from that account's OWN typed SQP-weekly signal (never a
 * global request-key signal). ALWAYS emits the SQP-weekly kickoff over [asOf-84d, asOf]. ONLY when the typed
 * SQP signal is a validated success (the contract's `validated_success` staged activation -- a genuine
 * ZERO-ROW SQP success still activates it) does it emit the rich no-date content catalog. A disabled/failed/
 * unvalidated/missing SQP plans NO catalog (zero catalog tokens; the derive then produces the honest
 * sqpAvailable:false snapshot or preserves last-known-good). request_hash + primary/dd-secondary isolation
 * come from the shared resolver; the STAGED-cycle driver (runListingOptimizerShadowCycle) decides WHEN the
 * catalog export is actually spent. The rich content catalog identity is DISTINCT from the common 4-column
 * insight catalog (richer columns => different request_hash), so it deliberately does NOT share that export.
 */
export function planListingOptimizer({ accountId, country, currency, connections, asOf, sqpSignal = null }) {
  const scope = resolveAccountScope({ accountId, country, currency, connections });
  const end = String(asOf);
  const sqpFrom = addDaysStr(end, -OPT_LOOKBACK_DAYS);
  const windowsByRequestKey = {
    "listing-optimizer:sqp-weekly": [{ from: sqpFrom, to: end }],
  };
  const dependencySignals = {};
  if (sqpSignal != null) {
    dependencySignals["listing-optimizer:sqp-weekly"] = sqpSignal;
    // Stage the rich catalog ONLY once the typed SQP signal is a validated success (fail closed via the
    // shared evaluateStagedActivation; a genuine zero-row SQP success still activates it -- no reported-date
    // requirement). A disabled/failed/unvalidated SQP leaves the catalog window absent => no catalog source.
    const catalogContract = (REPORT_SOURCE_CONTRACTS["listing-optimizer"] || []).find((c) => c.requestKey === "listing-optimizer:catalog");
    if (catalogContract && evaluateStagedActivation(catalogContract.activation, sqpSignal)) {
      windowsByRequestKey["listing-optimizer:catalog"] = [{ from: null, to: null }];
    }
  }
  const sources = reportSourceRequestHashes({
    reportKey: "listing-optimizer", apiKey: scope.apiKey, ids: [scope.rawSellerId],
    windowsByRequestKey, marketplaceCountry: scope.country, dependencySignals,
  });
  return {
    reportKey: "listing-optimizer",
    reportVersion: REPORT_DERIVATIONS["listing-optimizer"].snapshotVersion,
    accountId: scope.accountId,
    connectionId: scope.connectionId,
    bucket: scope.bucket,
    sources: decorateSources(sources, { reportKey: "listing-optimizer", connectionId: scope.connectionId, bucket: scope.bucket }),
    context: { to: end, rawSellerId: scope.rawSellerId },
  };
}

/**
 * Plan Buy Box Loss for ONE account. Emits the exact route windows: the raw daily grain (Profit by SKU &
 * Date) as FOUR ordered non-overlapping 7-day slices covering [asOf-27d, asOf] (splitDateRangeByDays, the
 * SAME helper the builder + derivation use, so the four slices agree by construction), the shared FBA
 * inventory snapshot over [asOf-10d, asOf], and the shared no-date catalog -- all for the one raw seller
 * id. All three sources are INDEPENDENTLY required (no probe / staged activation), so Buy Box uses the
 * generic owner-scoped source cycle, never a dedicated staged-cycle driver. Shared inventory/catalog
 * canonical hashes dedupe with Sales Movers + other insight reports.
 */
export function planBuyBoxLoss({ accountId, country, currency, connections, asOf }) {
  const scope = resolveAccountScope({ accountId, country, currency, connections });
  const end = String(asOf);
  const from = addDaysStr(end, -(BB_WINDOW_DAYS - 1));
  // The daily buy-box source keeps its four 7-day slices; the canonical OLI sales/units source is sliced
  // by canonicalOliSlices (Blocker 1) so its interior + asOf-boundary slices share request_hashes with the
  // other OLI reports. Both cover [asOf-27d, asOf] and the fold joins them on currency|sku.
  const dailySlices = splitDateRangeByDays(from, end, BB_SLICE_DAYS);
  const windowsByRequestKey = {
    "buy-box-loss:daily": dailySlices,
    "buy-box-loss:oli-sales": canonicalOliSlices(from, end),
    "buy-box-loss:inventory": [{ from: addDaysStr(end, -BB_INVENTORY_LOOKBACK_DAYS), to: end }],
    "buy-box-loss:catalog": [{ from: null, to: null }],
  };
  const sources = reportSourceRequestHashes({
    reportKey: "buy-box-loss", apiKey: scope.apiKey, ids: [scope.rawSellerId],
    windowsByRequestKey, marketplaceCountry: scope.country,
  });
  return {
    reportKey: "buy-box-loss",
    reportVersion: REPORT_DERIVATIONS["buy-box-loss"].snapshotVersion,
    accountId: scope.accountId,
    connectionId: scope.connectionId,
    bucket: scope.bucket,
    sources: decorateSources(sources, { reportKey: "buy-box-loss", connectionId: scope.connectionId, bucket: scope.bucket }),
    context: { to: end, rawSellerId: scope.rawSellerId },
  };
}

/**
 * Plan Returns & Refund Leakage for ONE account. Emits the exact route windows: the raw Returns rows, the
 * grouped Settlements money, and the grouped Sales & Traffic pair -- all over [asOf-59d, asOf] -- plus the
 * shared no-date insight catalog, for the one raw seller id. All four sources are INDEPENDENTLY required
 * (no probe / staged activation), so Returns uses the generic owner-scoped source cycle, never a dedicated
 * staged-cycle driver. The catalog canonical hash dedupes with Sales Movers + Buy Box + other insight
 * catalogs; returns/settlements/traffic carry their own distinct identities (the traffic column/aggregation
 * set + 60-day window differ from Sales Movers traffic, so it is deliberately NOT shared).
 */
export function planReturnsLeakage({ accountId, country, currency, connections, asOf }) {
  const scope = resolveAccountScope({ accountId, country, currency, connections });
  const end = String(asOf);
  const from = addDaysStr(end, -(RET_WINDOW_DAYS - 1));
  const windowsByRequestKey = {
    // Timeout-safe slicing: the single 60-day raw Returns range TIMEOUTed on a large account. Returns rows
    // are RAW returned-item grain with a real per-row date, so <=7-day slices concatenate to the identical
    // row set. Returns is fetched date DESC, so the slices are ordered NEWEST-FIRST: each slice's rows
    // arrive DESC and every date lives in exactly one slice, so the concatenation reproduces the former
    // whole-window DESC order exactly. Settlements/ordered are GROUPED WITHOUT date (whole-window aggregate
    // rows) and the catalog is no-date -- none of those can be sliced; they stay single-window.
    "returns-leakage:returns": sliceWindowByDays(from, end).reverse(),
    "returns-leakage:settlements": [{ from, to: end }],
    // Blocker 1: canonical OLI sales fragment sliced by canonicalOliSlices (shares request_hashes with the
    // other OLI reports); the fold binds ordered evidence per (currency, child_asin) — Blocker 2.
    "returns-leakage:oli-sales": canonicalOliSlices(from, end),
    "returns-leakage:catalog": [{ from: null, to: null }],
  };
  const sources = reportSourceRequestHashes({
    reportKey: "returns-leakage", apiKey: scope.apiKey, ids: [scope.rawSellerId],
    windowsByRequestKey, marketplaceCountry: scope.country,
  });
  return {
    reportKey: "returns-leakage",
    reportVersion: REPORT_DERIVATIONS["returns-leakage"].snapshotVersion,
    accountId: scope.accountId,
    connectionId: scope.connectionId,
    bucket: scope.bucket,
    sources: decorateSources(sources, { reportKey: "returns-leakage", connectionId: scope.connectionId, bucket: scope.bucket }),
    context: { to: end, rawSellerId: scope.rawSellerId },
  };
}

/**
 * Plan Listing Health for ONE account. Emits the exact route requests: the no-date Listings snapshot, the
 * no-date OPTIONAL Listings (Raw JSON) enrichment, the grouped 30d Sales `[asOf-29d, asOf]`, the shared FBA
 * inventory snapshot `[asOf-10d, asOf]`, and the shared no-date catalog -- all for the one raw seller id.
 * All non-raw sources are INDEPENDENTLY required (no probe / staged activation); listings-raw degrades (does
 * not block). So Listing Health uses the generic owner-scoped source cycle, never a dedicated staged driver.
 * The inventory canonical hash dedupes with Sales Movers + Buy Box; the catalog dedupes with Sales Movers +
 * Buy Box + Returns + other insight catalogs.
 */
export function planListingHealth({ accountId, country, currency, connections, asOf }) {
  const scope = resolveAccountScope({ accountId, country, currency, connections });
  const end = String(asOf);
  const salesFrom = addDaysStr(end, -(LH_SALES_WINDOW_DAYS - 1));
  const windowsByRequestKey = {
    "listing-health:listings": [{ from: null, to: null }],
    "listing-health:listings-raw": [{ from: null, to: null }],
    "listing-health:sales": [{ from: salesFrom, to: end }],
    "listing-health:inventory": [{ from: addDaysStr(end, -LH_INVENTORY_LOOKBACK_DAYS), to: end }],
    "listing-health:catalog": [{ from: null, to: null }],
  };
  const sources = reportSourceRequestHashes({
    reportKey: "listing-health", apiKey: scope.apiKey, ids: [scope.rawSellerId],
    windowsByRequestKey, marketplaceCountry: scope.country,
  });
  return {
    reportKey: "listing-health",
    reportVersion: REPORT_DERIVATIONS["listing-health"].snapshotVersion,
    accountId: scope.accountId,
    connectionId: scope.connectionId,
    bucket: scope.bucket,
    sources: decorateSources(sources, { reportKey: "listing-health", connectionId: scope.connectionId, bucket: scope.bucket }),
    context: { to: end, rawSellerId: scope.rawSellerId },
  };
}

// Generic single-shot planners ONLY. keyword-rank + sales-movers are deliberately absent: they are staged
// by their own account-scoped shadow cycles (see STAGED_CYCLE_REPORT_KEYS), never dispatched here.
const PLANNERS = {
  "brand-sales": planBrandSales,
  "content-changes": planContentChanges,
  "daily-reporting": planDailyReporting,
  "sku-pl": planSkuPl,
  "fba-plan": planFbaPlan,
  reconciliation: planReconciliation,
  "buy-box-loss": planBuyBoxLoss,
  "returns-leakage": planReturnsLeakage,
  "listing-health": planListingHealth,
};

/**
 * Build the full SHADOW plan for a set of authorized accounts. Returns:
 *   - reportRequests: the per-account report requests (fed to runReportJobs as plannedReports);
 *   - sourceJobs: the DEDUPLICATED canonical source jobs (fed to runSourceJobs) -- one job per
 *     unique request_hash, so identical source contracts across reports/accounts fetch once;
 *   - reportJobs: buildDependencyPlan's report->sources dependency map (telemetry).
 * `accounts`: [{ accountId, country, currency }] (from the authoritative account directory).
 * `asOfFor(country)` supplies the marketplace-local as-of date (the caller passes marketplaceToday).
 * Plans ONLY the generic single-shot reports (SHADOW_PLANNED_REPORT_KEYS); a requested staged-cycle
 * key (Keyword Rank) is REJECTED fail-closed, never silently planned OR silently dropped. Any other
 * unknown key is ignored. Pure given its inputs; no I/O.
 */
export function buildShadowReportPlan({ accounts = [], reportKeys = SHADOW_PLANNED_REPORT_KEYS, connections, asOfFor, inventoryAsOf = null }) {
  const requested = reportKeys || [];
  // Fail closed: a staged-cycle report (Keyword Rank) has ONE canonical entry point
  // (runKeywordRankShadowCycle) and must never be planned by -- or silently dropped from -- the generic
  // eager builder. A caller that explicitly asks for it here is a bug we surface rather than mis-plan.
  const stagedRequested = requested.filter((key) => STAGED_CYCLE_REPORT_KEYS.includes(key));
  if (stagedRequested.length) {
    const directions = stagedRequested.map((key) => `${key} -> ${STAGED_CYCLE_ENTRY_POINTS[key] || "its account-scoped staged cycle"}`).join("; ");
    throw new Error(`buildShadowReportPlan cannot plan staged-cycle report(s) [${stagedRequested.join(", ")}]; use ${directions}.`);
  }
  const keys = requested.filter((key) => SHADOW_PLANNED_REPORT_KEYS.includes(key));
  // Primary-only safety: partition the directory against the CONFIGURED connections BEFORE planning. A
  // stale `dd-secondary:` account (secondary org retired) is never planned, never routed to the primary
  // key, and its prefix/snapshots are untouched -- it is returned read-only so its unavailability cannot
  // fail the primary cycle or spend a token.
  const { active, unavailable } = classifyDirectoryAccounts(accounts, connections);
  const reportRequests = [];
  // fba-plan uses MARKETPLACE-SAFE <=5-seller BATCHED planning across the whole bucket (its owned FBA Health +
  // US AWD exports are seller-scoped/batchable) -- planned ONCE across all accounts, not per-account.
  const perAccountKeys = keys.filter((k) => k !== "fba-plan");
  for (const account of active) {
    const asOf = typeof asOfFor === "function" ? asOfFor(account.country) : account.asOf;
    for (const reportKey of perAccountKeys) {
      // `name` is threaded for FBA Shipment Plan (its payload carries the authoritative account
      // name); the other planners ignore it.
      reportRequests.push(PLANNERS[reportKey]({ accountId: account.accountId, name: account.name, country: account.country, currency: account.currency, connections, asOf }));
    }
  }
  if (keys.includes("fba-plan")) {
    reportRequests.push(...planFbaPlanBucketBatched({ accounts: active, connections, asOfFor, inventoryAsOf }));
  }
  const { sourceJobs, reportJobs } = buildDependencyPlan(reportRequests);
  return { reportRequests, sourceJobs, reportJobs, unavailableAccounts: unavailable };
}
