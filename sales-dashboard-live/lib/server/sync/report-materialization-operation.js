// Scheduler-owned, ZERO-EXPORT report materialization operator (Phase 3, Increment 1).
//
// PURPOSE. Move report materialization OFF the browser read path and into the regional scheduler. Today several
// durable reports self-heal (derive + save a snapshot) on a plain GET the first time (or after evidence advances)
// a page is opened -- so opening a page is the event that "completes" that report. This operator performs the SAME
// zero-export derivations from the scheduler, after the regional durable sources land, so a normal page visit finds
// a ready snapshot and never has to write one.
//
// SCOPE (Increment 1). It materializes the three report families whose serve derive is already a standalone,
// exported, ZERO-export function with a clean canonical snapshot identity:
//   - brand-view-brands  (per account; membership directory; identity { accountId })
//   - sku-movement       (per account x brand incl. ALL; identity { asOf, brand } -- the client re-windows N days
//                          from this canonical payload, so ONE snapshot per (account,brand) serves every window)
//   - returns-leakage    (per account; identity { to } -- the serve reads latest-for-scope, so one per account)
// Daily named-brand, brand-directory and the Brand View REPORT itself are deliberately NOT here yet (a separate,
// natural-run-gated follow-on): daily needs dynamic-window handling and its ALL-brand is already priority-
// materialized, and the brand-directory / brand-view builders are not yet extracted from the serve module.
//
// CONTRACT.
//   - ZERO DataDoe. No adapter, no token, no export is reachable from here -- only the injected durable derives
//     (which read Supabase and compute) and the injected snapshot writer.
//   - HONEST. A derive that is not ready (missing/incomplete durable evidence) writes NOTHING and preserves the
//     last-known-good; it is reported unavailable/deferred, never fabricated as an empty/zero report.
//   - INDEPENDENT. Every (account, report) unit is isolated in its own try/catch, so one account's or one report's
//     failure never blocks the others.
//   - IDEMPOTENT / REPLAY-SAFE. The write is saveReportSnapshot's merge-upsert on the natural key
//     (report_key, account_id, params_hash); a re-run whose evidence has not advanced is detected (same identity +
//     same source provenance) and SKIPPED, and even an unconditional re-write cannot create a duplicate row. A
//     watchdog replay or two overlapping runs therefore produce no duplicate snapshots.
//   - ISOLATED BY IDENTITY. Every snapshot is written under the EXACT (reportKey, accountId, paramsHash) the serve
//     reads, computed with the same paramsHashFor + report version, so materialized data never leaks across
//     account, brand, region or report version.
//
// The core is PURE: identity helpers are imported (no I/O), and every derive / read / write / lock / clock is an
// injected collaborator, so the zero-export + isolation + idempotency contract is provable offline.

import { RETURNS_ADVANCED_VERSION } from "../reports/returns-advanced.js";
import { SKU_MOVEMENT_VERSION } from "../reports/sku-movement-backfill.js";
import { BRAND_VIEW_BRANDS_REPORT_KEY, BRAND_VIEW_BRANDS_VERSION } from "../reports/brand-view.js";
import { materializeSnapshot, runUnit as runUnitCore, summarize } from "./report-materialization-core.js";

export { summarize };

export const SKU_MOVEMENT_REPORT_KEY = "sku-movement";
export const RETURNS_REPORT_KEY = "returns-leakage";

// The report families this operator OWNS in the scheduler (Increment 1). Kept as data so the release guard and the
// tests can assert the exact set without importing the run loop.
export const REPORT_MATERIALIZATION_REPORTS = Object.freeze([
  Object.freeze({ reportKey: BRAND_VIEW_BRANDS_REPORT_KEY, reportVersion: BRAND_VIEW_BRANDS_VERSION, grain: "account" }),
  Object.freeze({ reportKey: SKU_MOVEMENT_REPORT_KEY, reportVersion: SKU_MOVEMENT_VERSION, grain: "account-brand" }),
  Object.freeze({ reportKey: RETURNS_REPORT_KEY, reportVersion: RETURNS_ADVANCED_VERSION, grain: "account" }),
]);

const utcDate = (d) => new Date(d).toISOString().slice(0, 10);

// Normalize a brand token to the canonical scope value the serve uses ("" -> "ALL", trimmed otherwise).
function canonicalBrand(brand) {
  const s = String(brand == null ? "" : brand).trim();
  return s === "" ? "ALL" : s;
}

/**
 * Materialize the owned reports for one region's accounts from durable evidence only.
 *
 * @param {object} args
 * @param {string} args.region                canonical scheduler region (india|europe-au|us-ca) -- for reporting only.
 * @param {Array<{accountId:string,country?:string,currency?:string,name?:string}>} args.accounts  primary accounts.
 * @param {string} [args.ceiling]             UTC future-guard date (YYYY-MM-DD); defaults to now()'s UTC date.
 * @param {boolean} [args.dryRun=false]       when true, derive nothing is written -- every unit is reported "planned".
 * @param {() => (Date|number|string)} [args.now]
 * @param {object} collaborators              injected (all zero-export):
 *   deriveBrandViewBrands({ accountId }) -> { brands:string[], ... }
 *   deriveSkuMovement({ accountId, brand, ceiling }) -> { payload, effectiveParams:{asOf,brand}, sourceRefreshedAt } | { notReady, blockedBy? }
 *   deriveReturns({ accountId, asOf }) -> { payload, latestDataDate, sourceRefreshedAt } | { notReady }
 *   readSnapshot({ reportKey, accountId, paramsHash }) -> row|null           (exact-identity idempotency probe)
 *   persistSnapshot({ reportKey, reportVersion, accountId, paramsHash, params, payload, sourceRefreshedAt }) -> { savedAt, bytes }
 *   claimLock?({ reportKey, accountId, paramsHash }) -> boolean              (best-effort; default: always true)
 *   releaseLock?({ reportKey, accountId, paramsHash }) -> void
 *   log?(msg)
 * @returns {Promise<{ region, ceiling, dryRun, events: Array, summary: object }>}
 */
export async function runReportMaterialization(
  { region, accounts, ceiling, dryRun = false, now = () => new Date() },
  collaborators = {},
) {
  const {
    deriveBrandViewBrands,
    deriveSkuMovement,
    deriveReturns,
    readSnapshot,
    persistSnapshot,
    claimLock = async () => true,
    releaseLock = async () => {},
    log = () => {},
  } = collaborators;

  if (typeof deriveBrandViewBrands !== "function") throw new Error("runReportMaterialization requires deriveBrandViewBrands");
  if (typeof deriveSkuMovement !== "function") throw new Error("runReportMaterialization requires deriveSkuMovement");
  if (typeof deriveReturns !== "function") throw new Error("runReportMaterialization requires deriveReturns");
  if (!dryRun && typeof persistSnapshot !== "function") throw new Error("runReportMaterialization requires persistSnapshot for a live run");

  const effectiveCeiling = ceiling || utcDate(now());
  const events = [];
  const push = (ev) => { events.push(ev); return ev; };

  // Idempotent, LKG-preserving, isolated materialization -- the SHARED core (report-materialization-core.js), so this
  // per-account operator and the FBA-aware Brand View operator can never drift. Binds this run's dryRun/now + the
  // injected store to the core primitive; every unit is isolated so one throw never aborts the rest.
  const materializeOne = (u) => materializeSnapshot({ ...u, dryRun, now, readSnapshot, persistSnapshot, claimLock, releaseLock });
  const runUnit = (fn, ctx) => runUnitCore(events, fn, ctx);

  for (const account of accounts || []) {
    const accountId = String((account && (account.accountId || account.id)) || "").trim();
    if (!accountId || accountId.includes(":")) {
      push({ report: "*", account: accountId || "(blank)", status: "skipped", reason: "non-primary-or-blank", tokens: 0 });
      continue;
    }

    // 1) brand-view-brands (also yields the account's brand list for the per-brand SKU Movement materialization).
    let brands = [];
    await runUnit(async () => {
      const derived = await deriveBrandViewBrands({ accountId });
      brands = Array.isArray(derived && derived.brands) ? derived.brands.filter((b) => String(b || "").trim() !== "") : [];
      // brand-view-brands is a membership directory: it is ALWAYS materializable (an empty brand list is the honest,
      // real membership for a brand-less account, not a fabricated value). Its provenance is the newest contributing
      // brand-source snapshot time (derived.sources[].savedAt), NOT the clock -- so a same-evidence replay is
      // idempotent (detected "unchanged") rather than a needless rewrite.
      const provenance = derived && derived.sourceRefreshedAt
        ? derived.sourceRefreshedAt
        : (Array.isArray(derived && derived.sources)
            ? (derived.sources.map((s) => String((s && s.savedAt) || "")).filter(Boolean).sort().pop() || null)
            : null);
      return materializeOne({
        reportKey: BRAND_VIEW_BRANDS_REPORT_KEY, reportVersion: BRAND_VIEW_BRANDS_VERSION,
        accountId, params: { accountId }, scopeLabel: "directory",
        derived: derived && derived.brands != null
          ? { payload: { accountId, ...derived }, sourceRefreshedAt: provenance || new Date(now()).toISOString() }
          : { notReady: "brand-view-brands-unavailable" },
      });
    }, { report: BRAND_VIEW_BRANDS_REPORT_KEY, account: accountId, scope: "directory" });

    // 2) sku-movement for ALL + each named brand (each an independent unit; the canonical { asOf, brand } identity).
    const skuBrands = ["ALL", ...brands.map(canonicalBrand).filter((b) => b !== "ALL")];
    const seenSkuBrand = new Set();
    for (const brand of skuBrands) {
      const cb = canonicalBrand(brand);
      if (seenSkuBrand.has(cb)) continue;
      seenSkuBrand.add(cb);
      await runUnit(async () => {
        const derived = await deriveSkuMovement({ accountId, brand: cb, ceiling: effectiveCeiling });
        const asOf = derived && derived.effectiveParams ? derived.effectiveParams.asOf : null;
        return materializeOne({
          reportKey: SKU_MOVEMENT_REPORT_KEY, reportVersion: SKU_MOVEMENT_VERSION,
          accountId, params: { asOf, brand: cb }, scopeLabel: `brand:${cb}`,
          derived: derived && derived.payload && asOf ? derived : { notReady: (derived && derived.notReady) || "sku-not-ready", blockedBy: derived && derived.blockedBy },
        });
      }, { report: SKU_MOVEMENT_REPORT_KEY, account: accountId, scope: `brand:${cb}` });
    }

    // 3) returns-leakage (single per account; identity { to: latest proven returns date }). deriveReturns REQUIRES a
    //    valid YYYY-MM-DD asOf (gatherReturnsEvidence rejects a blank one); the derive clamps its own window to the
    //    account's real returns/settlement horizon, so the future-guard ceiling is the correct as-of to pass.
    await runUnit(async () => {
      const derived = await deriveReturns({ accountId, asOf: effectiveCeiling });
      const to = derived && (derived.latestDataDate || (derived.payload && derived.payload.latestDataDate)) ? (derived.latestDataDate || derived.payload.latestDataDate) : null;
      return materializeOne({
        reportKey: RETURNS_REPORT_KEY, reportVersion: RETURNS_ADVANCED_VERSION,
        accountId, params: { to }, scopeLabel: "account",
        derived: derived && derived.payload && to ? derived : { notReady: (derived && derived.notReady) || "returns-not-ready" },
      });
    }, { report: RETURNS_REPORT_KEY, account: accountId, scope: "account" });
  }

  const summary = summarize(events);
  log(`report-materialization[${region || "-"}] as-of ${effectiveCeiling}${dryRun ? " (dry-run)" : ""}: `
    + `materialized ${summary.materialized}, unchanged ${summary.unchanged}, unavailable ${summary.unavailable}, `
    + `planned ${summary.planned}, error ${summary.error} across ${summary.accounts} accounts; tokens ${summary.tokens}`);

  return { region: region || null, ceiling: effectiveCeiling, dryRun, events, summary };
}
