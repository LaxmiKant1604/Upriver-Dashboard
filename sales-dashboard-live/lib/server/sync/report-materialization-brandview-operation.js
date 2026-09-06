// Scheduler-owned, ZERO-EXPORT Brand View materializer (Phase 3 Completion). The BACKEND PRODUCER for the two reports
// that had none: brand-view (single account+brand) and brand-view-portfolio (a brand across a region's accounts). Both
// serve via deferRebuildOnRead / no-deriveDurable, so before this a missing/stale exact-identity snapshot returned
// updating=true and the read-only poll never converged until the user clicked Refresh. This operator publishes the
// exact serve identities from the scheduler so the pages converge with NO user interaction.
//
// It reuses the EXACT existing builders (buildBrandViewSnapshot / buildBrandViewPortfolioSnapshot) with the SAME readers
// the serve wires -- zero formula/payload change -- and the SHARED idempotent core (report-materialization-core.js). It
// runs in the FBA-aware second materialization job (needs [run, fba, materialize]) because Brand View reads the
// brand-inventory (priority) + fba-plan (fba) snapshots for fbaAvailable; when FBA is unavailable the payload honestly
// carries fbaAvailable:null (never a fabricated zero), and missing Ads mappings yield adsAvailable:false per country.
//
// IDENTITY (must byte-match the serve): single -> reportKey "brand-view", version "brand-view-account-scoped-v2",
// scope id brandViewScopeId(accountId,brand), params {accountId,brand,asOf=marketplaceToday(account.country)}.
// Portfolio -> reportKey "brand-view-portfolio", version "brand-view-portfolio-v1", scope id
// brandViewPortfolioScopeId(sortedAccountIds,brand), params {accountIds:join(","),brand,asOf=marketplaceToday("IN"),region}.
// The account set per brand is buildBrandAccountMembership(brand-sales) -> accountsForBrand, i.e. exactly the browser's
// region-scoped brand membership. Provenance (source_refreshed_at) is the newest brand-sales provenance across the
// account(s) -- the SAME value the serve's contributingProvenanceAt compares -- so a converged read is not flagged
// stale, and a source advance re-flags updating until the next scheduled publish.

import {
  BRAND_VIEW_REPORT_KEY, BRAND_VIEW_VERSION, BRAND_VIEW_PORTFOLIO_REPORT_KEY, BRAND_VIEW_PORTFOLIO_VERSION,
  brandViewScopeId, brandViewPortfolioScopeId,
} from "../reports/brand-view.js";
import { buildBrandAccountMembership } from "../reports/brand-membership.js";
import { materializeSnapshot, runUnit, summarize } from "./report-materialization-core.js";

// The Brand View report families this operator OWNS (declared as data so the registry-to-operator coverage guard can
// assert the exact set without importing the run loop).
export const BRAND_VIEW_MATERIALIZATION_REPORTS = Object.freeze([
  Object.freeze({ reportKey: BRAND_VIEW_REPORT_KEY, reportVersion: BRAND_VIEW_VERSION, grain: "account-brand" }),
  Object.freeze({ reportKey: BRAND_VIEW_PORTFOLIO_REPORT_KEY, reportVersion: BRAND_VIEW_PORTFOLIO_VERSION, grain: "account-region" }),
]);

const cleanBrands = (arr) => [...new Set((Array.isArray(arr) ? arr : []).map((b) => String(b == null ? "" : b).trim()).filter(Boolean))];

/**
 * Materialize Brand View + Brand View Portfolio for one region's accounts, from durable evidence only.
 *
 * @param {object} args  { region, accounts:[{accountId,country,currency,name}], dryRun, now }
 * @param {object} collaborators  (all zero-export):
 *   readAccountBrands({ accountId }) -> string[]              (single brand-view brands = brand-view-brands directory)
 *   readAccountSalesBrands({ accountId }) -> string[]          (brand-sales brands = portfolio membership evidence)
 *   deriveBrandView({ accountId, brand, asOf, account }) -> { payload, sourceRefreshedAt } | { notReady }
 *   deriveBrandViewPortfolio({ accountIds, brand, asOf, region, accountsById }) -> { payload, sourceRefreshedAt } | { notReady }
 *   readSnapshot / persistSnapshot / claimLock / releaseLock  (shared-core store contract)
 *   marketplaceToday(country, now) -> "YYYY-MM-DD"
 *   log?(msg)
 */
export async function runBrandViewMaterialization({ region, accounts, dryRun = false, now = () => new Date() }, collaborators = {}) {
  const {
    readAccountBrands, readAccountSalesBrands, deriveBrandView, deriveBrandViewPortfolio,
    readSnapshot, persistSnapshot, claimLock = async () => true, releaseLock = async () => {},
    marketplaceToday, log = () => {},
  } = collaborators;
  if (typeof readAccountBrands !== "function") throw new Error("runBrandViewMaterialization requires readAccountBrands");
  if (typeof readAccountSalesBrands !== "function") throw new Error("runBrandViewMaterialization requires readAccountSalesBrands");
  if (typeof deriveBrandView !== "function") throw new Error("runBrandViewMaterialization requires deriveBrandView");
  if (typeof deriveBrandViewPortfolio !== "function") throw new Error("runBrandViewMaterialization requires deriveBrandViewPortfolio");
  if (typeof marketplaceToday !== "function") throw new Error("runBrandViewMaterialization requires marketplaceToday");
  if (!dryRun && typeof persistSnapshot !== "function") throw new Error("runBrandViewMaterialization requires persistSnapshot for a live run");

  const events = [];
  const matOne = (u) => materializeSnapshot({ ...u, dryRun, now, readSnapshot, persistSnapshot, claimLock, releaseLock });
  const unit = (fn, ctx) => runUnit(events, fn, ctx);

  // Region-scoped primary accounts (the caller already region-filtered them). Drop prefixed/countryless ids.
  const accountsById = new Map();
  const primaries = [];
  for (const a of accounts || []) {
    const accountId = String((a && (a.accountId || a.id)) || "").trim();
    if (!accountId || accountId.includes(":")) { events.push({ report: "*", account: accountId || "(blank)", status: "skipped", reason: "non-primary-or-blank", tokens: 0 }); continue; }
    accountsById.set(accountId, { accountId, country: (a && a.country) || null, currency: (a && a.currency) || null, name: (a && a.name) || null });
    primaries.push(accountId);
  }
  const accountsByIdObj = Object.fromEntries(accountsById);

  // (1) BRAND VIEW SINGLE: every (account, brand) pair. brands = the account's brand-view-brands directory (the SAME
  //     set the browser dropdown offers); asOf = marketplaceToday(account.country) (the exact value the browser sends).
  for (const accountId of primaries) {
    const account = accountsById.get(accountId);
    const asOf = marketplaceToday(account && account.country, now());
    let brands = [];
    try { brands = cleanBrands(await readAccountBrands({ accountId })); }
    catch (e) { unit(async () => { throw e; }, { report: BRAND_VIEW_REPORT_KEY, account: accountId, scope: "brands" }); continue; }
    for (const brand of brands) {
      // eslint-disable-next-line no-loop-func
      await unit(async () => {
        const derived = await deriveBrandView({ accountId, brand, asOf, account });
        return matOne({
          reportKey: BRAND_VIEW_REPORT_KEY, reportVersion: BRAND_VIEW_VERSION,
          accountId: brandViewScopeId(accountId, brand), params: { accountId, brand, asOf }, scopeLabel: `brand:${brand}`,
          derived: derived && derived.payload ? derived : { notReady: (derived && derived.notReady) || "brand-view-not-ready" },
        });
      }, { report: BRAND_VIEW_REPORT_KEY, account: accountId, scope: `brand:${brand}` });
    }
  }

  // (2) BRAND VIEW PORTFOLIO: every brand sold in this region -> its sorted account set (brand-sales membership,
  //     exactly the browser's region-scoped brandDirectoryAccounts[brand] ∩ region). asOf = marketplaceToday("IN")
  //     (a FIXED India anchor the browser uses for the portfolio regardless of the selected region).
  const perAccountSales = [];
  for (const accountId of primaries) {
    let salesBrands = [];
    try { salesBrands = cleanBrands(await readAccountSalesBrands({ accountId })); } catch (_e) { salesBrands = []; }
    perAccountSales.push({ accountId, salesBrands });
  }
  const membership = buildBrandAccountMembership(perAccountSales); // Map<brandKey, { display, accounts:Set<accountId> }>
  const portfolioAsOf = marketplaceToday("IN", now());
  for (const [, entry] of membership) {
    const accountIds = [...entry.accounts].filter((id) => accountsById.has(id)).sort();
    if (!accountIds.length) continue;
    const brand = entry.display; // the display name the browser selects (canonical-key -> pickDisplay, matches the serve)
    // eslint-disable-next-line no-loop-func
    await unit(async () => {
      const derived = await deriveBrandViewPortfolio({ accountIds, brand, asOf: portfolioAsOf, region, accountsById: accountsByIdObj });
      return matOne({
        reportKey: BRAND_VIEW_PORTFOLIO_REPORT_KEY, reportVersion: BRAND_VIEW_PORTFOLIO_VERSION,
        accountId: brandViewPortfolioScopeId(accountIds, brand),
        params: { accountIds: accountIds.join(","), brand, asOf: portfolioAsOf, region },
        scopeLabel: `region:${region}|brand:${brand}`,
        derived: derived && derived.payload ? derived : { notReady: (derived && derived.notReady) || "portfolio-not-ready" },
      });
    }, { report: BRAND_VIEW_PORTFOLIO_REPORT_KEY, account: brandViewPortfolioScopeId(accountIds, brand), scope: `region:${region}|brand:${brand}` });
  }

  const summary = summarize(events);
  log(`brand-view-materialization[${region || "-"}] portfolio-asOf ${portfolioAsOf}${dryRun ? " (dry-run)" : ""}: `
    + `materialized ${summary.materialized}, unchanged ${summary.unchanged}, unavailable ${summary.unavailable}, `
    + `planned ${summary.planned}, error ${summary.error} across ${summary.accounts} identities; tokens ${summary.tokens}`);

  return { region: region || null, portfolioAsOf, dryRun, events, summary };
}
