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
  BRAND_INVENTORY_SNAPSHOT_KEY, BRAND_INVENTORY_REPORT_VERSION, compactInventoryFromFbaPlanPayload,
  brandViewScopeId, brandViewPortfolioScopeId,
} from "../reports/brand-view.js";
import { buildBrandAccountMembership } from "../reports/brand-membership.js";
import { materializeSnapshot, runUnit, summarize } from "./report-materialization-core.js";
import { paramsHashFor } from "../report-store.js";

// The compact brand-inventory family this operator REBUILDS from fresh fba-plan evidence (declared as data so the
// registry/family guards can assert the exact set without importing the run loop).
export const BRAND_INVENTORY_MATERIALIZATION_REPORT = Object.freeze({
  reportKey: BRAND_INVENTORY_SNAPSHOT_KEY, reportVersion: BRAND_INVENTORY_REPORT_VERSION, grain: "account",
});

/**
 * REBUILD the compact brand-inventory (reportKey "brand-inventory") from each account's FRESH fba-plan report
 * snapshot (Defect A). Runs in the FBA-aware materialize-inventory job AFTER the fba job, so the compact snapshot
 * Brand View reads is CURRENT before the brand-view/portfolio derive runs (the priority run publishes it BEFORE FBA
 * as inventoryAvailable:false; this makes it available the SAME day). ZERO DataDoe -- it reuses the already-validated
 * fba-plan fold via the pure compactInventoryFromFbaPlanPayload adapter (one inventory definition, no second export).
 *
 * Gated on the SAME source-promoted publish control the priority publisher checks (publish_enabled): when disabled,
 * it writes nothing and Brand View falls back to the legacy fba-plan inventory path. Per-account zero-vs-missing is
 * preserved: an account whose fba-plan has no available inventory (the source omitted it, or a validator failure left
 * only an old snapshot without inventory) leaves the existing compact untouched (honest unavailable, never a
 * fabricated zero). Newer-only: a compact already newer than this fba-plan evidence is preserved (LKG).
 *
 * @param {object} args { region, accounts:[{accountId,country,...}], dryRun, now }
 * @param {object} collaborators (all zero-export):
 *   readFbaPlan({ accountId }) -> the account's latest fba-plan snapshot { payload, source_refreshed_at } | null
 *   promotedPublishEnabled() -> boolean (brand-inventory source-promoted publish control)
 *   readSnapshot / persistSnapshot / claimLock / releaseLock (shared-core store contract)
 *   log?(msg)
 */
export async function runBrandInventoryRebuild({ region, accounts, dryRun = false, now = () => new Date() }, collaborators = {}) {
  const {
    readFbaPlan, promotedPublishEnabled,
    readSnapshot, persistSnapshot, claimLock = async () => true, releaseLock = async () => {},
    log = () => {},
  } = collaborators;
  const events = [];
  // Not wired (e.g. an older test harness / a dry non-FBA context) -> a green no-op that writes nothing.
  if (typeof readFbaPlan !== "function" || typeof promotedPublishEnabled !== "function") {
    return { region: region || null, dryRun, events, summary: summarize(events), skipped: "not-wired" };
  }
  let enabled = false;
  try { enabled = await promotedPublishEnabled(); } catch { enabled = false; }
  if (!enabled) {
    log(`brand-inventory-rebuild[${region || "-"}]: source-promoted publish disabled -> skip (0 writes; legacy fba-plan fallback serves inventory)`);
    return { region: region || null, dryRun, events, summary: summarize(events), skipped: "promoted-publish-disabled" };
  }

  for (const a of accounts || []) {
    const accountId = String((a && (a.accountId || a.id)) || "").trim();
    if (!accountId || accountId.includes(":")) {
      events.push({ report: BRAND_INVENTORY_SNAPSHOT_KEY, account: accountId || "(blank)", status: "skipped", reason: "non-primary-or-blank", tokens: 0 });
      continue;
    }
    // eslint-disable-next-line no-loop-func
    await runUnit(events, async () => {
      const plan = await readFbaPlan({ accountId });
      const payload = compactInventoryFromFbaPlanPayload(plan && plan.payload, accountId);
      if (!payload) {
        // fba-plan absent / no available inventory / no strict date -> leave the existing compact (honest unavailable).
        return { report: BRAND_INVENTORY_SNAPSHOT_KEY, account: accountId, status: "unavailable", preservedLkg: true, blockedBy: [{ reason: "fba-plan-no-available-inventory" }], tokens: 0 };
      }
      const sourceRefreshedAt = (plan && (plan.source_refreshed_at || plan.sourceRefreshedAt || plan.updated_at)) || null;
      // NEWER-ONLY: never overwrite a compact that is already newer than this fba-plan evidence (LKG protection).
      if (!dryRun && typeof readSnapshot === "function" && sourceRefreshedAt) {
        const paramsHash = paramsHashFor(BRAND_INVENTORY_REPORT_VERSION, { to: payload.inventoryDate });
        const existing = await readSnapshot({ reportKey: BRAND_INVENTORY_SNAPSHOT_KEY, accountId, paramsHash }).catch(() => null);
        if (existing && existing.payload && String(existing.source_refreshed_at || "") > String(sourceRefreshedAt)) {
          return { report: BRAND_INVENTORY_SNAPSHOT_KEY, account: accountId, status: "unchanged", reason: "existing-newer", tokens: 0 };
        }
      }
      return materializeSnapshot({
        reportKey: BRAND_INVENTORY_SNAPSHOT_KEY, reportVersion: BRAND_INVENTORY_REPORT_VERSION,
        accountId, params: { to: payload.inventoryDate }, scopeLabel: "brand-inventory",
        derived: { payload, sourceRefreshedAt },
        dryRun, now, readSnapshot, persistSnapshot, claimLock, releaseLock,
      });
    }, { report: BRAND_INVENTORY_SNAPSHOT_KEY, account: accountId, scope: "brand-inventory" });
  }
  const summary = summarize(events);
  log(`brand-inventory-rebuild[${region || "-"}]${dryRun ? " (dry-run)" : ""}: materialized ${summary.materialized}, unchanged ${summary.unchanged}, unavailable ${summary.unavailable}, error ${summary.error} across ${summary.units} accounts; tokens ${summary.tokens}`);
  return { region: region || null, dryRun, events, summary };
}

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
