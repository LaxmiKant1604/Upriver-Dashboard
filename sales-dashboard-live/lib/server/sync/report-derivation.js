// Scheduler v2 Phase 1d -- report-derivation registry + PURE derivation orchestrator.
//
// A derivation adapter turns ALREADY-SAVED canonical source rows (fetched + validated by the
// Phase 1c source worker and stored in source_export_cache) into a report snapshot payload.
// It performs ZERO DataDoe exports: this module imports only pure leaves
// (reports/derivation-core.js, report-source-contracts.js, planner.js) and NEVER
// datadoe.js / createExport / pollExport / downloadExport / fetchExportRows. That import
// boundary is the structural guarantee behind the "zero DataDoe calls during derivation"
// safety rule; a test also asserts this module's transitive imports exclude transport.
//
// Safety rules enforced here (mirrors the source worker's last-known-good discipline):
//   - Derive ONLY from validated saved payloads (a loaded array; [] is a valid empty set).
//   - A cache miss / malformed / non-array payload / failed source is NEVER an empty success.
//   - A required source that is unavailable => do NOT derive (report stays last-known-good).
//   - Terminal-disabled required source => blocked (that report only). Degraded/optional
//     source => derive with an explicitly-unavailable field, per the approved policy.
//   - Truncation is rejected upstream (strict source jobs never save a capped page), so an
//     unavailable required source can never be a silent truncated success.

import {
  orderSalesByBrand,
  catalogBrandNames,
  contentChangesPayload,
  dailyReportingPayload,
  skuPlPayload,
  reconciliationPayload,
  fbaPlanPayload,
  keywordRankPayload,
  sqpDistinctPeriods,
  salesMoversLatestReportedDate,
  salesMoversPayload,
  salesMoversUnavailablePayload,
  buyBoxLossPayload,
  returnsLeakagePayload,
  listingHealthPayload,
  assertListingHealthCurrencyIsolation,
  listingOptimizerPayload,
  listingOptimizerUnavailablePayload,
  ppcPerformancePayload,
} from "../reports/derivation-core.js";
import {
  declaredReportKeys,
  declaredRequestKeys,
  REPORT_DERIVED_ONLY,
  sourceDisabledOutcome,
  resolveDailyAdsAvailability,
  validateSkuPlMonthlyWindows,
  isValidCalendarDate,
  salesMoversWindows,
} from "./report-source-contracts.js";
// planMonthWindows/addDaysStr are shared dependency-free window helpers (byte-identical to the
// api/datadoe.js fba-plan route copies; proven equal in the FBA parity harness). Reaching them here
// keeps the pure derivation graph free of any DataDoe transport / Supabase import.
import { planMonthWindows, addDaysStr, splitDateRangeByDays, splitDateRangeByMonth, isFullCalendarMonthWindow } from "../date-windows.js";
// PURE typed PPC coverage contract (server-only loader, no transport import): re-enforced here so the derive
// never folds/saves a PPC snapshot on an injected context that lacks or contradicts the durable-coverage gate.
import { validatePpcSourceCoverage } from "./ppc-ads-loader.js";

// FBA inventory-health lookback (days) -- byte-identical to the api/datadoe.js PLAN_INVENTORY_LOOKBACK_DAYS
// constant. The derivation RECOMPUTES the expected inventory start as addDaysStr(asOf, -10) and pins
// BOTH endpoints, so a planner/caller that shifts the snapshot window (a shortened or extended lookback)
// is rejected -- the derivation never implicitly trusts the fragment's window.
const FBA_INVENTORY_LOOKBACK_DAYS = 10;

// Keyword Rank SQP + catalog lookbacks (days) -- byte-identical to the api/datadoe.js
// SQP_WEEKLY_LOOKBACK_DAYS / SQP_MONTHLY_LOOKBACK_DAYS (the monthly SQP and the 365-day catalog share
// the long window). The derivation RECOMPUTES both window starts from asOf and pins both endpoints.
const SQP_WEEKLY_LOOKBACK_DAYS = 84;
const SQP_LONG_LOOKBACK_DAYS = 365;

// Listing & Search Optimizer constants -- byte-identical to lib/server/reports/listing-optimizer.js
// LOOKBACK_DAYS (84) and the SQP_WEEKLY.label / SQP_WEEKLY.enableHint / PRODUCT_CATALOG.label strings from
// reports/sources.js. The derivation RECOMPUTES the SQP window start from asOf and pins both endpoints, so
// a caller that shifts the window is rejected; the label/hint match the live sqpAvailable:false snapshot.
const OPT_LOOKBACK_DAYS = 84;
const OPT_SQP_LABEL = "Search Query Performance (SQP) by ASIN (Weekly)";
const OPT_SQP_ENABLE_HINT = "In DataDoe, open Settings > Data tables and enable Search Query Performance (SQP) by ASIN (Weekly), then refresh this report again.";
const OPT_CATALOG_LABEL = "Product Catalog by ASIN";

// Sales Movers constants -- byte-identical to the live builder/sources: SALES_TRAFFIC.lagDays (4),
// sales-movers.js WINDOW_DAYS (7), FBA_INVENTORY_HEALTH.snapshotLookbackDays (10), SALES_TRAFFIC.label.
// The derivation RECOMPUTES the probe/inventory windows from asOf and pins them, never trusting a caller.
const SM_LAG_DAYS = 4;
const SM_WINDOW_DAYS = 7;
const SM_INVENTORY_LOOKBACK_DAYS = 10;
const SM_SOURCE_LABEL = "Sales & Traffic by ASIN & Date";

// Buy Box Loss constants -- byte-identical to the live builder/sources: buy-box.js WINDOW_DAYS (28) +
// SLICE_DAYS (7), FBA_INVENTORY_HEALTH.snapshotLookbackDays (10), PROFIT_BY_SKU.label, and the fixed
// price-source label. The derivation RECOMPUTES the four 7-day daily slices + the inventory window from
// asOf and pins every endpoint, never trusting a caller's fragment windows.
const BB_WINDOW_DAYS = 28;
const BB_SLICE_DAYS = 7;
const BB_INVENTORY_LOOKBACK_DAYS = 10;
const BB_SOURCE_LABEL = "Profit by SKU & Date";
const BB_PRICE_SOURCE_LABEL = "FBA Inventory Health";

// Returns & Refund Leakage constants -- byte-identical to the live builder/sources: returns.js WINDOW_DAYS
// = RETURNS.historyDays (60); the source labels + SALES_TRAFFIC.lagDays (4). The derivation RECOMPUTES the
// single [asOf-59d, asOf] window from asOf and pins it, never trusting a caller's fragment window.
const RET_WINDOW_DAYS = 60;
const RET_RETURNS_LABEL = "Returns (FBA & FBM)";
const RET_MONEY_LABEL = "Settlements & P&L Components";
const RET_RATE_LABEL = "Sales & Traffic by ASIN & Date";
const RET_RATE_LAG_DAYS = 4;

// Listing Health constants -- byte-identical to the live builder/sources: listing-health.js
// SALES_WINDOW_DAYS (30), FBA_INVENTORY_HEALTH.snapshotLookbackDays (10), the source labels, and the
// exact LISTINGS_RAW.enableHint shown when the optional Listings (Raw JSON) enrichment is disabled. The
// derivation RECOMPUTES the sales/inventory windows from asOf and pins them, never trusting a caller.
const LH_SALES_WINDOW_DAYS = 30;
const LH_INVENTORY_LOOKBACK_DAYS = 10;
const LH_SOURCE_LABEL = "Listings";
const LH_SALES_SOURCE_LABEL = "Profit by SKU & Date";
const LH_ISSUES_SOURCE_LABEL = "Listings (Raw JSON)";
const LH_ISSUES_ENABLE_HINT = "In DataDoe, open Settings > Data tables and enable Listings (Raw JSON) to add Amazon's own listing issue codes, severities and suppression flags to this report.";

// PPC Performance constants -- byte-identical to the live builder/sources: ppc.js WINDOW_DAYS (30),
// SALES_TRAFFIC.label / lagDays (the TACoS denominator), and the four persisted Ads source descriptors
// (syncKey/label/coverage/defaultDataset/enableHint) in campaign,asin,targeting,search-terms order --
// coverage for campaign/asin is the hardcoded route wording, targeting/search-terms use the ADS_* coverage.
// ALL advertising data is DERIVED from persisted ads_daily_source_rows; PPC creates ZERO DataDoe Ads exports.
const PPC_WINDOW_DAYS = 30;
const PPC_TOTAL_SALES_LABEL = "Sales & Traffic by ASIN & Date";
const PPC_TOTAL_SALES_LAG_DAYS = 4;
const PPC_MULTI_CURRENCY_REASON = "TACoS is unavailable because this account's saved Ads rows use multiple currencies. A combined total-sales denominator would be meaningless.";
const PPC_TOTAL_SALES_DEGRADED_REASON = "TACoS is unavailable because the account total-sales export for the denominator did not complete this cycle; every other PPC figure is still current.";
const PPC_ADS_SOURCE_DESCRIPTORS = Object.freeze([
  { syncKey: "campaign-performance-v1", label: "Ad Performance by Campaign & Date", coverage: "All campaign types present in the account", defaultDataset: true },
  { syncKey: "asin-performance-v1", label: "Ad Performance by ASIN & Date", coverage: "Same-SKU attributed metrics", defaultDataset: true },
  { syncKey: "keyword-targeting-performance-v1", label: "Keyword Targeting Performance", coverage: "SP + SB + SD", defaultDataset: false, enableHint: "In DataDoe, open Settings > Data tables and enable Keyword Targeting Performance, then refresh this report again." },
  { syncKey: "search-terms-performance-v1", label: "Search Term Performance (Ads)", coverage: "SP + SB only (no Sponsored Display)", defaultDataset: false, enableHint: "In DataDoe, open Settings > Data tables and enable Search Term Performance (Ads), then refresh this report again." },
]);

// Shadow-mode namespace: v2 snapshots are written under a namespaced report_key so they can
// NEVER collide with (or overwrite) a production report_snapshots row. Comparison helpers map
// a production report key to its shadow key and back.
export const SHADOW_SNAPSHOT_NAMESPACE = "scheduler-v2";
export function shadowSnapshotKey(reportKey) {
  return `${SHADOW_SNAPSHOT_NAMESPACE}/${reportKey}`;
}
export function isShadowSnapshotKey(key) {
  return typeof key === "string" && key.startsWith(`${SHADOW_SNAPSHOT_NAMESPACE}/`);
}
export function productionKeyFromShadow(key) {
  return isShadowSnapshotKey(key) ? key.slice(SHADOW_SNAPSHOT_NAMESPACE.length + 1) : key;
}

// Reports that OWN no source contracts and derive from other saved snapshots/report output.
// They must never create a source job. brand-directory is the legacy portfolio derivation.
export const DERIVED_ONLY_REPORT_KEYS = Object.freeze(
  [...REPORT_DERIVED_ONLY, "brand-directory"].filter((k, i, a) => a.indexOf(k) === i),
);

const maxIsoDate = (values) => {
  let latest = null;
  for (const v of values) {
    const s = v == null ? "" : String(v);
    if (s && (!latest || s > latest)) latest = s;
  }
  return latest;
};

// FBA monthly-units contract: the saved fragments must be EXACTLY the expected windows
// [3 completed months + current MTD], IN ORDER, one single-account fragment each. A positional
// window match rejects a reordered/duplicate/partial month; the length check rejects a missing/extra
// fragment; the seller-id check rejects a cross-account or multi-id fragment. Returns { ok, reason };
// never throws on data (malformed => ok:false). `expected`: [{from,to}] x4 from planMonthWindows.
function validateFbaMonthlyUnitsWindows(fragments, expected, rawSellerId) {
  if (!Array.isArray(fragments)) return { ok: false, reason: "monthly-units-fragments-missing" };
  if (fragments.length !== expected.length) return { ok: false, reason: "expected-exactly-four-monthly-units-fragments" };
  for (let i = 0; i < expected.length; i += 1) {
    const f = fragments[i];
    if (!f || typeof f !== "object" || Array.isArray(f)) return { ok: false, reason: "malformed-monthly-units-fragment" };
    const ids = f.sellerOrVendorIds;
    if (!Array.isArray(ids) || ids.length !== 1) return { ok: false, reason: "monthly-units-fragment-must-carry-exactly-one-seller-id" };
    const sellerId = typeof ids[0] === "string" ? ids[0].trim() : "";
    if (!sellerId) return { ok: false, reason: "monthly-units-fragment-seller-id-missing" };
    if (rawSellerId != null && sellerId !== String(rawSellerId)) return { ok: false, reason: "monthly-units-fragment-cross-account" };
    if (f.from !== expected[i].from || f.to !== expected[i].to) return { ok: false, reason: "monthly-units-window-mismatch" };
  }
  return { ok: true, reason: null };
}

// A required single-range source must be EXACTLY one single-account fragment. `wantFrom/wantTo`
// (when provided) pin the window; a null skips that side of the pin (e.g. inventory's lookback
// `from` is a planner constant, so only its `to` is pinned). Returns the fragment rows or throws
// (a throw becomes a derive-invalid => last-known-good preserved).
function singleAccountFragmentRows(source, key, rawSellerId, wantFrom, wantTo) {
  const frags = (source && source.fragments) || [];
  const f = frags.length === 1 ? frags[0] : null;
  const ids = f && f.sellerOrVendorIds;
  const ok = !!f
    && (wantFrom == null || f.from === wantFrom)
    && (wantTo == null || f.to === wantTo)
    && Array.isArray(ids) && ids.length === 1
    && (rawSellerId == null || String(ids[0]).trim() === String(rawSellerId));
  if (!ok) throw new Error(`${key} must be exactly one single-account fragment for its window; snapshot blocked.`);
  return source.rows;
}

// A required multi-window source must be EXACTLY the `expected` ordered single-account fragments, whose
// windows equal the recomputed canonical windows positionally (Sales Movers' [recent, prior]; Buy Box's
// four ordered 7-day daily slices). A positional match rejects a reordered/duplicate/partial/extra/
// missing/cross-account/overlapping/wrong-window fragment. Returns the ordered fragments (with rows) or
// throws (=> derive-invalid => last-known-good preserved, zero writes).
function validateOrderedSingleAccountWindows(source, expected, rawSellerId, key) {
  const frags = (source && source.fragments) || [];
  if (frags.length !== expected.length) {
    throw new Error(`${key} must be exactly ${expected.length} ordered single-account fragments; snapshot blocked.`);
  }
  for (let i = 0; i < expected.length; i += 1) {
    const f = frags[i];
    const ids = f && f.sellerOrVendorIds;
    const ok = !!f && typeof f === "object" && !Array.isArray(f)
      && f.from === expected[i].from && f.to === expected[i].to
      && Array.isArray(ids) && ids.length === 1
      && (rawSellerId == null || String(ids[0]).trim() === String(rawSellerId));
    if (!ok) {
      throw new Error(`${key} fragment ${i} does not match its expected single-account window ${expected[i].from}..${expected[i].to}; snapshot blocked.`);
    }
  }
  return frags;
}

// Gate-6 Cycle-1 timeout remediation -- the derive-side contract for TIMEOUT-SAFE SLICED sources. Must stay
// equal to report-planner.js TIMEOUT_SAFE_SLICE_DAYS (asserted by the slicing parity tests; report-derivation
// cannot import report-planner without creating an import cycle). The expected fragment sequence is RECOMPUTED
// here from the report's own window facts -- never trusted from the planner/caller.
export const DERIVE_TIMEOUT_SAFE_SLICE_DAYS = 7;

// Validate a timeout-safe SLICED dated source: fragments must be EXACTLY the recomputed expected slice
// sequence (ordered, positional -- validateOrderedSingleAccountWindows rejects reordered/duplicate/partial/
// extra/missing/cross-account/wrong-window), AND every fragment's rows must each be a plain object whose real
// calendar date lies inside THAT fragment's own window (a row outside its own slice -- even if inside the
// overall range -- is rejected). Returns the source's canonical concatenated rows. Throws => derive-invalid
// => zero writes => last-known-good preserved.
function slicedFragmentRows(source, expectedSlices, rawSellerId, label) {
  const frags = validateOrderedSingleAccountWindows(source, expectedSlices, rawSellerId, label);
  for (const f of frags) {
    if (!Array.isArray(f.rows)) throw new Error(`${label} fragment ${f.from}..${f.to} has no validated row array; snapshot blocked.`);
    assertRowsInWindow(f.rows, f.from, f.to, `${label} slice ${f.from}..${f.to}`);
  }
  return source.rows;
}

// Sales Movers catalog: exactly ONE single-account NO-DATE fragment (from === null, to === null). A dated
// or multi/zero fragment throws => derive-invalid => last-known-good preserved.
function noDateFragmentRows(source, key, rawSellerId) {
  const frags = (source && source.fragments) || [];
  const f = frags.length === 1 ? frags[0] : null;
  const ids = f && f.sellerOrVendorIds;
  const ok = !!f && f.from === null && f.to === null
    && Array.isArray(ids) && ids.length === 1
    && (rawSellerId == null || String(ids[0]).trim() === String(rawSellerId));
  if (!ok) throw new Error(`${key} must be exactly one single-account no-date fragment (from === null, to === null); snapshot blocked.`);
  return source.rows;
}

// Every saved fragment row must be a plain object (a non-object row is malformed source data): one such
// row makes the report invalid (throws => derive-invalid => zero snapshot writes => last-known-good kept).
function assertPlainObjectRows(rows, label) {
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`${label} contains a non-object row; snapshot blocked (invalid).`);
    }
  }
}

// Typed-throw helpers so the derive can raise blocked / unavailable (not just invalid). A
// terminally-disabled conditionally-required source => blocked; a failed/missing/unreadable one =>
// unavailable. deriveReportSnapshot reads `error.deriveStatus`.
function deriveError(message, deriveStatus) {
  const e = new Error(message);
  if (deriveStatus) e.deriveStatus = deriveStatus;
  return e;
}

// Shared, report-neutral row-window guard: EVERY row of a dated fragment must be a plain object whose
// `date` is a REAL YYYY-MM-DD calendar date INSIDE the exact fragment window [from..to]. Invalid rows are
// NOT silently filtered -- one malformed / non-calendar / future / out-of-window / wrong-slice row makes
// the report `invalid` (throws -> derive-invalid -> zero snapshot writes -> last-known-good preserved).
// Used by Keyword Rank (weekly/monthly SQP), Sales Movers (latest-date probe) and Buy Box Loss (each daily
// 7-day slice + the inventory snapshot window). Pure; behavior unchanged from the former SQP-named helper.
function assertRowsInWindow(rows, from, to, label) {
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`${label} contains a non-object row; snapshot blocked (invalid).`);
    }
    const d = row.date;
    if (!isValidCalendarDate(d)) {
      throw new Error(`${label} contains a row whose date is not a real YYYY-MM-DD calendar date; snapshot blocked (invalid).`);
    }
    if (d < from || d > to) {
      throw new Error(`${label} contains a row date ${d} outside its ${from}..${to} fragment window; snapshot blocked (invalid).`);
    }
  }
}

// ---- The derivation registry (dependency map) ------------------------------------------
//
// Each entry:
//   snapshotVersion   : shadow snapshot version tag (folded into the snapshot params hash)
//   optionalRequestKeys : request keys allowed to be absent/degraded WITHOUT blocking
//   derivedSourceKeys : persisted non-DataDoe sources (e.g. ads_daily_source_rows)
//   derive            : PURE ({ sources, context }) -> payload | null (null = not yet wired)
//   validatePayload   : (payload) -> boolean structural validity (a derived success is real)
//   latestDataDate    : (payload, context, sources) -> ISO date | null. `sources` is the SAME validated
//                       saved-fragment map the derive ran on (present only on a `derived` success, so its
//                       rows already passed plain-object / real-calendar-date / in-window validation); an
//                       adapter may read a source EVIDENCE date from it (e.g. Returns' max raw return date).
//                       Existing adapters ignore the third arg and stay behavior-identical.
//
// requiredRequestKeys are computed from the report's declared contract minus optional keys,
// so the map can never drift from report-source-contracts.js.
const REGISTRY = {
  "brand-sales": {
    // v2d-2: the payload now carries the ADDITIVE first-wins `asinBrand` map, matching the live route's
    // buildBrandSalesPayload ({ rows, catalogBrands, asinBrand }) -- Brand View reads it from the saved
    // brand-sales payload for FBA inventory brand attribution (Gate 6 Cycle-1 parity finding).
    snapshotVersion: "brand-sales/v2d-2",
    optionalRequestKeys: [],
    derivedSourceKeys: [],
    derive: ({ sources }) => {
      const catalogRows = sources["brand-sales:catalog"].rows;
      // Additive ASIN->brand map, FIRST-WINS per child_asin with blank asin/brand skipped -- byte-identical
      // semantics to the live route (api/datadoe.js buildBrandSalesPayload).
      const asinBrand = {};
      for (const c of catalogRows) {
        const asin = String((c && c.child_asin) || "").trim();
        const brand = String((c && c.product_brand) || "").trim();
        if (asin && brand && !(asin in asinBrand)) asinBrand[asin] = brand;
      }
      // Route-identical fail-closed guard (brandSalesUnavailable): a catalog with ZERO usable brand mappings
      // must never overwrite a previously valid Brand Sales snapshot with asinBrand:{} / lost attribution.
      // Typed unavailable => zero writes, last-known-good preserved, a later cycle retries.
      if (Object.keys(asinBrand).length === 0) {
        throw deriveError("brand-sales Product Catalog has no usable ASIN->brand mappings; last-known-good preserved.", "unavailable");
      }
      const rows = orderSalesByBrand(sources["brand-sales:order-lines"].rows, catalogRows);
      return { rows, catalogBrands: catalogBrandNames(rows), asinBrand };
    },
    validatePayload: (p) => !!p && Array.isArray(p.rows) && Array.isArray(p.catalogBrands)
      && !!p.asinBrand && typeof p.asinBrand === "object" && !Array.isArray(p.asinBrand)
      && Object.keys(p.asinBrand).length > 0,
    latestDataDate: (p) => maxIsoDate((p.rows || []).map((r) => r.date)),
  },
  "content-changes": {
    snapshotVersion: "content-changes/v2d-1",
    optionalRequestKeys: [],
    derivedSourceKeys: [],
    // Full production-parity payload via the shared assembler. retrievedAt/accountId come from
    // the deterministic derivation context (source fetch time / plan), never Date.now().
    derive: ({ sources, context }) => contentChangesPayload({
      accountId: context.accountId ?? null,
      notificationRows: sources["content-changes:events"].rows,
      catalogRows: sources["content-changes:catalog"].rows,
      retrievedAt: context.retrievedAt ?? null,
    }),
    validatePayload: (p) => !!p && Array.isArray(p.events) && Array.isArray(p.catalogBrands)
      && typeof p.unassignedEvents === "number" && ("accountId" in p) && ("retrievedAt" in p),
    // Event times are timestamps; latest_data_date must be date-only (Postgres date).
    latestDataDate: (p) => { const d = maxIsoDate((p.events || []).map((e) => e.eventTime)); return d ? String(d).slice(0, 10) : null; },
  },

  // ---- Declared dependency map; derive wiring lands in the next faithful tranche. ----
  // These entries carry the exact required/optional request keys so the worker gates,
  // claims, and preserves last-known-good correctly today; `derive: null` means the pure
  // calc extraction (from an impure builder) is pending and the worker records the report
  // as derive-pending rather than fabricating an unfaithful payload.
  // Daily Reporting: derive BOTH all-brand and every named brand from the ONE saved ASIN/day
  // superset + catalog. `context.brand` selects the mode (default "ALL"); the worker stores the
  // ALL-brand snapshot this tranche (per-brand snapshot planning is deferred to orchestration).
  // Ads are injected via `context.adRows` (planner-loaded from the scheduled Ads rows); the pure
  // core imports no Supabase. All-brand rows/units re-aggregate additively; there are no ratio
  // fields to sum (daily ratios are recomputed in the browser from these base sums).
  "daily-reporting": {
    snapshotVersion: "daily-reporting/v2d-1", optionalRequestKeys: [], derivedSourceKeys: ["ads-campaign-date"],
    // Blocker 1: ONLY `adsCoverage` may be injected through the derive context. The worker's
    // per-report allowlist drops any other derived field and never lets a derived input override
    // the planned account/brand/from/to scope (the snapshot identity stays in the planned scope).
    derivedContextKeys: ["adsCoverage"],
    derive: ({ sources, context }) => {
      // Timeout-safe sliced superset: RECOMPUTE the expected <=7-day-within-month slice sequence from the
      // planned window and accept ONLY exactly that ordered single-account sequence, every row bound to its
      // own fragment window. The superset rows are per-day grouped, so the concatenation is IDENTICAL to the
      // former whole-month fetch (proven in the slicing parity tests).
      const winFrom = context.from != null ? String(context.from) : "";
      const winTo = context.to != null ? String(context.to) : "";
      if (!isValidCalendarDate(winFrom) || !isValidCalendarDate(winTo) || winFrom > winTo) {
        throw new Error("daily-reporting derivation requires an authoritative planned from/to window.");
      }
      const expectedSlices = splitDateRangeByMonth(winFrom, winTo)
        .flatMap((m) => splitDateRangeByDays(m.from, m.to, DERIVE_TIMEOUT_SAFE_SLICE_DAYS));
      const supersetRows = slicedFragmentRows(
        sources["daily-reporting:asin-day-superset"], expectedSlices,
        context.rawSellerId != null ? String(context.rawSellerId) : null, "daily-reporting:asin-day-superset",
      );
      const catalogRows = sources["daily-reporting:catalog"].rows;
      const brand = context.brand ?? "ALL";
      // Named-brand path: catalog ASIN->brand join, folded to one row/day, NO ads (like the route).
      if (brand && brand !== "ALL") {
        return dailyReportingPayload({ supersetRows, catalogRows, brand });
      }
      // ALL path (blocker 3): SALES validity is INDEPENDENT of Ads. Always derive + save the sales
      // snapshot; layer Ads on ONLY for proven-covered dates, and record an explicit availability
      // state so uncovered periods are UNAVAILABLE (never fabricated zero). Ads never blocks the
      // sales snapshot: an availability failure degrades Ads, it does not throw.
      let availability;
      let coveredAdRows;
      try {
        const resolved = resolveDailyAdsAvailability(context.adsCoverage, {
          accountId: context.accountId ?? null,
          rawSellerId: context.rawSellerId ?? null,
          currency: context.currency ?? null,
          from: context.from ?? null,
          to: context.to ?? null,
        });
        availability = resolved.availability;
        coveredAdRows = resolved.adRows;
      } catch (_e) {
        // Defensive: any unexpected error marks Ads failed but NEVER blocks the sales snapshot.
        availability = { status: "failed", coveredFrom: null, coveredTo: null, requestedFrom: context.from ?? null, requestedTo: context.to ?? null, currency: context.currency ?? null, latestMetricDate: null, reason: "ads-availability-error" };
        coveredAdRows = [];
      }
      return dailyReportingPayload({ supersetRows, catalogRows, adRows: coveredAdRows, brand: "ALL", adsAvailability: availability });
    },
    validatePayload: (p) => !!p && Array.isArray(p.rows) && typeof p.brandFiltered === "boolean"
      && (p.brandFiltered === true || (p.adsAvailability && typeof p.adsAvailability.status === "string")),
    latestDataDate: (p) => maxIsoDate((p.rows || []).map((r) => r.date)),
  },
  // FBA Shipment Plan: reproduce the api/datadoe.js `fba-plan` payload byte-for-byte from the saved
  // fragments. AWD is US-only (marketplace-conditional), so it is NOT a blanket required dep; instead
  // the derive enforces it per-account: a US account with a missing/failed AWD source BLOCKS (throws
  // -> derive-invalid -> last-known-good preserved) so it can never silently become zero, while a
  // VALIDATED empty AWD source is honored as "no AWD rows". Non-US never plans or reads AWD.
  "fba-plan": {
    snapshotVersion: "fba-plan/v2d-1", optionalRequestKeys: ["fba-plan:awd"], derivedSourceKeys: [],
    derive: ({ sources, context }) => {
      const asOf = context.to != null ? String(context.to) : "";
      if (!isValidCalendarDate(asOf)) {
        throw new Error("fba-plan derivation requires an authoritative asOf (context.to) that is a real calendar date.");
      }
      const rawSellerId = context.rawSellerId != null ? String(context.rawSellerId) : null;
      const isUS = context.isUS === true;
      // Recompute the exact route windows from asOf (never trust caller-supplied month boundaries).
      const { completed, current } = planMonthWindows(asOf);

      // 1) monthly-units == [completed0, completed1, completed2, currentMTD], in order, single-account.
      const expectedUnitWindows = [
        ...completed.map((m) => ({ from: m.from, to: m.to })),
        { from: current.from, to: current.to },
      ];
      const unitFrags = sources["fba-plan:monthly-units"].fragments || [];
      const unitCheck = validateFbaMonthlyUnitsWindows(unitFrags, expectedUnitWindows, rawSellerId);
      if (!unitCheck.ok) {
        throw new Error(`fba-plan monthly-units contract violated (${unitCheck.reason}); snapshot blocked.`);
      }
      const completedUnitRows = completed.map((_m, i) => unitFrags[i].rows);
      const mtdUnitRows = unitFrags[completed.length].rows;

      // 2) single-account single-fragment required ranges.
      const dailyDateRows = singleAccountFragmentRows(sources["fba-plan:current-daily-dates"], "fba-plan:current-daily-dates", rawSellerId, current.from, current.to);
      const catalogRows = singleAccountFragmentRows(sources["fba-plan:catalog"], "fba-plan:catalog", rawSellerId, completed[0].from, current.to);
      // Inventory window is EXACTLY [asOf - 10d .. asOf]. Recompute the expected start here and pin
      // BOTH endpoints (a shortened or extended lookback fragment is rejected -> derive-invalid ->
      // last-known-good preserved), never implicitly trusting the planner/caller.
      const expectedInventoryFrom = addDaysStr(asOf, -FBA_INVENTORY_LOOKBACK_DAYS);
      const invRows = singleAccountFragmentRows(sources["fba-plan:inventory-health"], "fba-plan:inventory-health", rawSellerId, expectedInventoryFrom, asOf);

      // 3) AWD -- US only. Missing/failed for a US account BLOCKS (never a silent zero); a validated
      //    (possibly empty) AWD source is honored. Non-US never reads AWD.
      let awdRows = [];
      if (isUS) {
        const awd = sources["fba-plan:awd"];
        if (!awd || awd.available !== true || !Array.isArray(awd.rows)) {
          throw new Error("fba-plan US account requires a validated AWD source; it is missing or failed, so the snapshot is blocked (previous data preserved).");
        }
        // AWD is a NO-DATE source: require EXACTLY one single-account fragment whose window is the
        // canonical {from:null, to:null}. A dated AWD fragment (a wrong/narrowed listings window) is
        // rejected -> derive-invalid -> last-known-good preserved.
        const frags = awd.fragments || [];
        const f = frags.length === 1 ? frags[0] : null;
        const ids = f && f.sellerOrVendorIds;
        const ok = !!f && f.from === null && f.to === null
          && Array.isArray(ids) && ids.length === 1 && (rawSellerId == null || String(ids[0]).trim() === rawSellerId);
        if (!ok) throw new Error("fba-plan AWD must be exactly one single-account no-date fragment (from === null, to === null); snapshot blocked.");
        awdRows = awd.rows;
      }

      return fbaPlanPayload({
        asOf,
        accountName: context.accountName ?? null,
        marketCountry: context.marketCountry ?? null,
        isUS,
        completed, current,
        completedUnitRows, mtdUnitRows,
        dailyDateRows, catalogRows, invRows, awdRows,
      });
    },
    validatePayload: (p) => !!p && Array.isArray(p.rows) && Array.isArray(p.months)
      && Array.isArray(p.inventoryByBrandCountry) && typeof p.isUS === "boolean"
      && ("asOf" in p) && ("inventoryAvailable" in p) && ("awdAvailable" in p),
    // Latest real data date = the most recent of the sales/inventory dates (already date-only).
    latestDataDate: (p) => maxIsoDate([p.salesLatestDate, p.inventoryDate]),
  },
  // Reconciliation: reproduce the api/datadoe.js `reconciliation` payload from the six monthly
  // order + settlement fragments and the single full-range catalog fragment. Enforce EXACTLY six
  // complete consecutive calendar months for orders AND settlements (reuse the strict sku-pl helper),
  // one account across both sources, and a single full-range single-account catalog -- rejecting any
  // duplicate/missing/extra/reordered/partial-month/cross-account fragment (a violation throws ->
  // derive-invalid -> last-known-good preserved, zero writes). Currencies are never merged (the pure
  // folds key each order/settlement by its own currency).
  "reconciliation": {
    snapshotVersion: "reconciliation/v2d-1", optionalRequestKeys: [], derivedSourceKeys: [],
    derive: ({ sources, context }) => {
      const from = context.from ?? null;
      const to = context.to ?? null;
      const rawSellerId = context.rawSellerId != null ? String(context.rawSellerId) : null;
      // SIX-COMPLETE-CALENDAR-MONTH integrity now lives on the CONTEXT window (the fragment shape changed to
      // timeout-safe <=7-day slices): from..to must still span exactly six complete consecutive calendar
      // months -- the same strict month-set the pre-slicing validator enforced on the fragments themselves.
      if (!isValidCalendarDate(from) || !isValidCalendarDate(to) || from > to) {
        throw new Error("reconciliation six-complete-calendar-month contract violated (invalid-context-window); snapshot blocked.");
      }
      const expectedMonths = splitDateRangeByMonth(from, to);
      if (expectedMonths.length !== 6 || expectedMonths.some((w) => !isFullCalendarMonthWindow(w))) {
        throw new Error("reconciliation six-complete-calendar-month contract violated (not-six-complete-calendar-months); snapshot blocked.");
      }
      // Timeout-safe sliced orders + settlements: EXACTLY the recomputed <=7-day-within-month slice sequence
      // (ordered, single-account, no duplicate/missing/extra/reordered/partial/cross-account fragment), every
      // per-day-grouped row bound to its own slice window. Concatenation is IDENTICAL to the former
      // whole-month fetch (proven in the slicing parity tests); month bucketing folds from row.date.
      const expectedSlices = expectedMonths.flatMap((m) => splitDateRangeByDays(m.from, m.to, DERIVE_TIMEOUT_SAFE_SLICE_DAYS));
      const orderRows = slicedFragmentRows(sources["reconciliation:order-lines"], expectedSlices, rawSellerId, "reconciliation:order-lines");
      const settlementRows = slicedFragmentRows(sources["reconciliation:settlements"], expectedSlices, rawSellerId, "reconciliation:settlements");
      // One account across BOTH sources; never cross-account/organization. slicedFragmentRows already pins
      // every fragment to the PLANNED rawSellerId when planned; this cross-source check also fails closed
      // when no rawSellerId was planned (defense in depth -- the two sources must still agree).
      const accountsSeen = new Set();
      for (const s of [sources["reconciliation:order-lines"], sources["reconciliation:settlements"]]) {
        for (const f of s.fragments || []) {
          const ids = f && f.sellerOrVendorIds;
          if (Array.isArray(ids) && ids.length === 1) accountsSeen.add(String(ids[0]).trim());
        }
      }
      if (accountsSeen.size !== 1) throw new Error("reconciliation orders and settlements resolve different accounts; snapshot blocked.");
      // Catalog: exactly ONE single-account fragment spanning the full six-month window.
      const catalogFrags = sources["reconciliation:catalog"].fragments || [];
      const catFrag = catalogFrags.length === 1 ? catalogFrags[0] : null;
      const catIds = catFrag && catFrag.sellerOrVendorIds;
      const catOk = !!catFrag && catFrag.from === from && catFrag.to === to
        && Array.isArray(catIds) && catIds.length === 1
        && (rawSellerId == null || String(catIds[0]).trim() === rawSellerId);
      if (!catOk) throw new Error("reconciliation catalog must be exactly one single-account full-range fragment; snapshot blocked.");
      return reconciliationPayload({
        from, to,
        months: expectedMonths.map((m) => m.from.slice(0, 7)),
        orderRows,
        settlementRows,
        catalogRows: sources["reconciliation:catalog"].rows,
      });
    },
    validatePayload: (p) => !!p && Array.isArray(p.orders) && Array.isArray(p.settlements)
      && Array.isArray(p.months) && ("from" in p) && ("to" in p),
    // Monthly report: the latest data date is the end of the last covered month (the window `to`).
    latestDataDate: (p, context) => { const d = context && context.to != null ? String(context.to).slice(0, 10) : null; return d || null; },
  },
  // SKU P&L: fold the six monthly-profit fragments into the exact route payload (RAW byMonth per
  // currency|sku|child_asin). Each fragment carries its window, so monthKey = fragment.from's
  // month; two five-ID chunks in the same month sum into one bucket; currencies never merge (part
  // of the identity key). COGS overrides are NOT baked in (the browser applies them at display via
  // computeSkuPlRow), so the snapshot equals the route payload byte-for-byte.
  "sku-pl": {
    snapshotVersion: "sku-pl/v2d-1", optionalRequestKeys: [], derivedSourceKeys: [],
    derive: ({ sources, context }) => {
      const fragments = sources["sku-pl:monthly-profit"].fragments || [];
      // Blocker 3: enforce the production contract before folding -- exactly six complete,
      // consecutive calendar months whose span equals context.from/to (first month start ..
      // last month end), one account, no missing/duplicate/overlapping/reordered/extra month --
      // reusing the SAME strict calendar helpers the route uses (no weaker duplicate). A violation
      // BLOCKS the snapshot (throws -> derive-invalid -> last-known-good preserved, zero writes).
      // Each fragment carries its own single-account seller scope so the validator can reject a
      // duplicate month, a multi-seller fragment, or a missing seller id BEFORE the fold (finding 1).
      const check = validateSkuPlMonthlyWindows({
        from: context.from ?? null,
        to: context.to ?? null,
        windows: fragments.map((f) => ({ from: f.from, to: f.to, sellerOrVendorIds: f.sellerOrVendorIds })),
      });
      if (!check.ok) {
        throw new Error(`sku-pl six-complete-calendar-month contract violated (${check.reason}); snapshot blocked.`);
      }
      return skuPlPayload({
        accountId: context.accountId ?? null,
        from: context.from ?? null,
        to: context.to ?? null,
        monthlyBatches: fragments.map((f) => ({ monthKey: String(f.from || "").slice(0, 7), rows: f.rows })),
      });
    },
    validatePayload: (p) => !!p && Array.isArray(p.rows) && Array.isArray(p.months)
      && Array.isArray(p.currencies) && Array.isArray(p.catalogBrands),
    // Monthly report: the latest data date is the end of the last covered month (the window `to`).
    latestDataDate: (p, context) => { const d = context && context.to != null ? String(context.to).slice(0, 10) : null; return d || null; },
  },
  // Keyword Rank: reproduce the api/datadoe.js `keyword-rank` payload from the saved SQP-weekly +
  // catalog fragments (both required), plus the SQP-monthly fallback fragment when weekly has < 4
  // distinct periods. Cadence mirrors the route exactly: weekly (>= 4 weekly periods), monthly (weekly
  // < 4 AND monthly >= 2 periods), else baseline (prefer non-empty weekly rows, else monthly). Monthly
  // is OPTIONAL in the gate (it is a data-dependent fallback), so the derive enforces it CONDITIONALLY:
  // when weekly < 4 periods a missing/failed/disabled monthly BLOCKS (never a silent baseline). Windows
  // are recomputed from asOf and both endpoints pinned; a missing/malformed/partial/wrong-window/
  // reordered/cross-account fragment throws -> derive-invalid -> last-known-good preserved.
  "keyword-rank": {
    snapshotVersion: "keyword-rank/v2d-1", optionalRequestKeys: ["keyword-rank:sqp-monthly"], derivedSourceKeys: [],
    derive: ({ sources, context }) => {
      const asOf = context.to != null ? String(context.to) : "";
      if (!isValidCalendarDate(asOf)) {
        throw new Error("keyword-rank derivation requires an authoritative asOf (context.to) that is a real calendar date.");
      }
      const rawSellerId = context.rawSellerId != null ? String(context.rawSellerId) : null;
      const weeklyFrom = addDaysStr(asOf, -SQP_WEEKLY_LOOKBACK_DAYS);
      const longFrom = addDaysStr(asOf, -SQP_LONG_LOOKBACK_DAYS);
      // Required, exact-window, single-account fragments (recompute windows from asOf; never trust caller).
      const weeklyRows = singleAccountFragmentRows(sources["keyword-rank:sqp-weekly"], "keyword-rank:sqp-weekly", rawSellerId, weeklyFrom, asOf);
      const catalogRows = singleAccountFragmentRows(sources["keyword-rank:catalog"], "keyword-rank:catalog", rawSellerId, longFrom, asOf);

      // Blocker 4: validate every weekly SQP row (plain object + real calendar date inside the 84-day
      // window) BEFORE counting periods, so a stale/out-of-window/malformed row can never select the
      // wrong cadence or enter a saved payload -- it makes the report invalid instead.
      assertRowsInWindow(weeklyRows, weeklyFrom, asOf, "keyword-rank weekly SQP");
      const weeklyPeriods = sqpDistinctPeriods(weeklyRows);
      let cadence = "weekly";
      let rows = weeklyRows;
      let periods = weeklyPeriods;
      if (weeklyPeriods.length < 4) {
        // Monthly SQP fallback is REQUIRED here. Preserve TYPED outcomes (Blocker 3): a terminal-disabled
        // monthly => blocked; a failed/missing/unreadable monthly cache => unavailable (never a silent
        // baseline). A VALIDATED (possibly empty) monthly array is honored as real baseline input.
        const monthly = sources["keyword-rank:sqp-monthly"];
        if (!monthly || monthly.available !== true || !Array.isArray(monthly.rows)) {
          if (monthly && monthly.disabled && sourceDisabledOutcome(monthly.disabledPolicy || null).blocks) {
            throw deriveError("keyword-rank monthly SQP fallback is required (weekly < 4 periods) but the monthly source is disabled; snapshot blocked.", "blocked");
          }
          throw deriveError("keyword-rank monthly SQP fallback is required (weekly < 4 periods) but its cache is missing/failed/unreadable; last-known-good preserved.", "unavailable");
        }
        const monthlyRows = singleAccountFragmentRows(monthly, "keyword-rank:sqp-monthly", rawSellerId, longFrom, asOf);
        assertRowsInWindow(monthlyRows, longFrom, asOf, "keyword-rank monthly SQP");
        const monthlyPeriods = sqpDistinctPeriods(monthlyRows);
        if (monthlyPeriods.length >= 2) {
          cadence = "monthly"; rows = monthlyRows; periods = monthlyPeriods;
        } else {
          // Prefer the fresher weekly observation; when it is empty use the monthly rows so the user
          // still gets an honest current baseline (verbatim route logic).
          cadence = "baseline";
          rows = weeklyRows.length ? weeklyRows : monthlyRows;
          periods = sqpDistinctPeriods(rows);
        }
      }

      return keywordRankPayload({
        accountId: context.accountId ?? null,
        cadence, periods,
        weeklyPeriodCount: weeklyPeriods.length,
        rows, catalogRows,
        // Deterministic from the saved source fetch metadata (the worker pins context.retrievedAt to
        // the latest fragment fetch time), NEVER Date.now().
        retrievedAt: context.retrievedAt ?? null,
      });
    },
    validatePayload: (p) => !!p && Array.isArray(p.rows) && Array.isArray(p.products)
      && Array.isArray(p.catalogBrands) && Array.isArray(p.periods) && typeof p.cadence === "string"
      && typeof p.weeklyPeriodCount === "number" && ("accountId" in p) && ("retrievedAt" in p),
    // The latest data date is the most recent SQP period in the chosen cadence (date-only already).
    latestDataDate: (p) => maxIsoDate((p.periods || []).map(String)),
  },
  // Sales Movers: reproduce the api/datadoe.js `sales-movers` payload from the validated saved fragments.
  // The latest-date PROBE is the only required source; a validated probe with NO reported date derives the
  // honest dataUnavailable snapshot (no traffic/ads/inventory/catalog requested). A validated probe WITH a
  // date requires the two-window traffic + ads, the shared inventory snapshot, and the shared no-date
  // catalog (all optional in the static gate so the no-data path never blocks; the derive enforces them
  // conditionally). Windows are recomputed from asOf + the probe date and pinned; a missing/failed/
  // unreadable downstream => unavailable (LKG preserved); a wrong/reordered/duplicate/cross-account/
  // out-of-window/malformed fragment => invalid (zero writes, LKG preserved). Advertising is never
  // combined across currencies; inventory is null unless the snapshot is available; buy box is never
  // evaluated. ZERO DataDoe/network calls (pure).
  "sales-movers": {
    snapshotVersion: "sales-movers/v2d-1",
    optionalRequestKeys: ["sales-movers:traffic", "sales-movers:ads", "sales-movers:inventory", "sales-movers:catalog"],
    derivedSourceKeys: [],
    derive: ({ sources, context }) => {
      const asOf = context.to != null ? String(context.to) : "";
      if (!isValidCalendarDate(asOf)) {
        throw new Error("sales-movers derivation requires an authoritative asOf (context.to) that is a real calendar date.");
      }
      // Two DISTINCT identities. rawSellerId (the DataDoe raw seller id) scopes every fragment: it is the
      // DataDoe request scope AND the sellerOrVendorIds a fragment must carry, so cross-account rows are
      // rejected. publicAccountId (context.accountId, the authoritative public/prefixed id the report job
      // + snapshot row are keyed by, e.g. "dd-secondary:RAW1") is what the PAYLOAD carries, so the payload
      // accountId matches the snapshot key and the frontend scopes catalogBrands to the right account. They
      // are EQUAL for primary accounts (public == raw), so this is byte-identical on the primary route.
      const rawSellerId = context.rawSellerId != null ? String(context.rawSellerId) : null;
      const publicAccountId = context.accountId != null ? String(context.accountId) : rawSellerId;
      const probeFrom = addDaysStr(asOf, -(SM_LAG_DAYS + SM_WINDOW_DAYS * 3));
      // Required PROBE: exactly one single-account fragment over [probeFrom, asOf]; every row a plain
      // object with a real calendar date inside that window (recompute the window; never trust the caller).
      const probeRows = singleAccountFragmentRows(sources["sales-movers:sales-latest-probe"], "sales-movers:sales-latest-probe", rawSellerId, probeFrom, asOf);
      assertRowsInWindow(probeRows, probeFrom, asOf, "sales-movers latest-date probe");
      const latestReportedDate = salesMoversLatestReportedDate(probeRows);
      if (!latestReportedDate) {
        // Validated probe, no reported units => a VALID completed dataUnavailable snapshot; no downstream.
        return salesMoversUnavailablePayload({ accountId: publicAccountId, asOf, lagDays: SM_LAG_DAYS, sourceLabel: SM_SOURCE_LABEL, probeFrom });
      }
      // The reported date must fall inside the probe window; the recent/prior weeks derive from it.
      if (latestReportedDate < probeFrom || latestReportedDate > asOf) {
        throw new Error(`sales-movers latest reported date ${latestReportedDate} is outside the probe window ${probeFrom}..${asOf}; snapshot blocked.`);
      }
      const { recent, prior } = salesMoversWindows(latestReportedDate);
      // Downstream is REQUIRED now. A missing/failed/unreadable required source => unavailable (LKG kept).
      for (const key of ["sales-movers:traffic", "sales-movers:ads", "sales-movers:inventory", "sales-movers:catalog"]) {
        const s = sources[key];
        if (!s || s.available !== true || !Array.isArray(s.rows)) {
          throw deriveError(`sales-movers ${key} is required (validated probe date) but its cache is missing/failed/unreadable; last-known-good preserved.`, "unavailable");
        }
      }
      // Traffic + Ads: exactly two ordered single-account fragments [recent, prior].
      const trafficFrags = validateOrderedSingleAccountWindows(sources["sales-movers:traffic"], [recent, prior], rawSellerId, "sales-movers:traffic");
      const adsFrags = validateOrderedSingleAccountWindows(sources["sales-movers:ads"], [recent, prior], rawSellerId, "sales-movers:ads");
      // Inventory: one single-account fragment over [asOf-10d, asOf] (pin both endpoints).
      const inventoryFrom = addDaysStr(asOf, -SM_INVENTORY_LOOKBACK_DAYS);
      const inventoryRows = singleAccountFragmentRows(sources["sales-movers:inventory"], "sales-movers:inventory", rawSellerId, inventoryFrom, asOf);
      // Catalog: exactly one single-account no-date fragment.
      const catalogRows = noDateFragmentRows(sources["sales-movers:catalog"], "sales-movers:catalog", rawSellerId);
      // Every saved fragment row must be a plain object.
      assertPlainObjectRows(trafficFrags[0].rows, "sales-movers traffic (recent)");
      assertPlainObjectRows(trafficFrags[1].rows, "sales-movers traffic (prior)");
      assertPlainObjectRows(adsFrags[0].rows, "sales-movers ads (recent)");
      assertPlainObjectRows(adsFrags[1].rows, "sales-movers ads (prior)");
      assertPlainObjectRows(inventoryRows, "sales-movers inventory");
      assertPlainObjectRows(catalogRows, "sales-movers catalog");
      return salesMoversPayload({
        accountId: publicAccountId, asOf, latestReportedDate, recent, prior,
        lagDays: SM_LAG_DAYS, sourceLabel: SM_SOURCE_LABEL, windowDays: SM_WINDOW_DAYS,
        recentTrafficRows: trafficFrags[0].rows, priorTrafficRows: trafficFrags[1].rows,
        recentAdsRows: adsFrags[0].rows, priorAdsRows: adsFrags[1].rows,
        inventoryRows, catalogRows,
      });
    },
    validatePayload: (p) => !!p && ("accountId" in p) && ("asOf" in p) && typeof p.dataUnavailable === "boolean"
      && Array.isArray(p.rows) && Array.isArray(p.catalogBrands) && ("salesLatestDate" in p)
      && (p.dataUnavailable === true
        || (Array.isArray(p.currencies) && p.buyBoxEvaluated === false && ("inventoryAvailable" in p)
          && ("inventorySnapshotDate" in p) && !!p.windows && typeof p.windows === "object")),
    // Latest real data date = the latest reported sales date (date-only already), null when unavailable.
    latestDataDate: (p) => (isValidCalendarDate(p && p.salesLatestDate) ? p.salesLatestDate : null),
  },
  // Buy Box Loss: reproduce the api/datadoe.js `buy-box-loss` payload from the FOUR ordered 7-day raw
  // daily slices (Profit by SKU & Date), the shared FBA inventory snapshot, and the shared no-date
  // catalog. ALL three sources are required (optionalRequestKeys: []) -- the report fetch gate keeps the
  // report PENDING until every slice + inventory + catalog succeeds, so a failed/terminal/truncated/
  // missing required source never saves (last-known-good preserved). Windows are RECOMPUTED from asOf and
  // pinned positionally: exactly four ordered non-overlapping 7-day slices covering [asOf-27d, asOf], the
  // inventory [asOf-10d, asOf], and one no-date catalog -- a wrong/missing/duplicate/reordered/overlapping/
  // partial/extra/cross-account/malformed fragment throws => derive-invalid => zero writes, LKG preserved.
  // buybox_percentage is a ratio (page-view weighted, unweighted-mean fallback); null observations are
  // excluded; currencies never merge. ZERO DataDoe/network calls (pure).
  "buy-box-loss": {
    snapshotVersion: "buy-box-loss/v2d-1", optionalRequestKeys: [], derivedSourceKeys: [],
    derive: ({ sources, context }) => {
      const asOf = context.to != null ? String(context.to) : "";
      if (!isValidCalendarDate(asOf)) {
        throw new Error("buy-box-loss derivation requires an authoritative asOf (context.to) that is a real calendar date.");
      }
      // rawSellerId (raw DataDoe seller id) is the SOLE source scope: DataDoe request scope + the id every
      // fragment must carry (cross-account rejection). publicAccountId (context.accountId) is the public/
      // prefixed id the report job + snapshot row are keyed by and is what the PAYLOAD carries, so the
      // frontend scopes catalogBrands to the right account. They are equal on the primary route.
      const rawSellerId = context.rawSellerId != null ? String(context.rawSellerId) : null;
      const publicAccountId = context.accountId != null ? String(context.accountId) : rawSellerId;
      const from = addDaysStr(asOf, -(BB_WINDOW_DAYS - 1));
      // All three sources are required; defensively reject a missing/failed/unreadable cache (the worker
      // fetch gate already keeps such a report PENDING/blocked, but never derive an empty success).
      for (const key of ["buy-box-loss:daily", "buy-box-loss:inventory", "buy-box-loss:catalog"]) {
        const s = sources[key];
        if (!s || s.available !== true || !Array.isArray(s.rows)) {
          throw deriveError(`buy-box-loss ${key} is required but its cache is missing/failed/unreadable; last-known-good preserved.`, "unavailable");
        }
      }
      // Daily: EXACTLY the four ordered 7-day slices covering [asOf-27d, asOf], recomputed + pinned.
      const expectedSlices = splitDateRangeByDays(from, asOf, BB_SLICE_DAYS);
      const dailyFrags = validateOrderedSingleAccountWindows(sources["buy-box-loss:daily"], expectedSlices, rawSellerId, "buy-box-loss:daily");
      // Inventory: one single-account fragment over [asOf-10d, asOf] (pin both endpoints).
      const inventoryFrom = addDaysStr(asOf, -BB_INVENTORY_LOOKBACK_DAYS);
      const inventoryRows = singleAccountFragmentRows(sources["buy-box-loss:inventory"], "buy-box-loss:inventory", rawSellerId, inventoryFrom, asOf);
      // Catalog: exactly one single-account no-date fragment.
      const catalogRows = noDateFragmentRows(sources["buy-box-loss:catalog"], "buy-box-loss:catalog", rawSellerId);
      // Bind EVERY source ROW to its validated window, not just the fragment metadata: each daily row must
      // be a plain object with a real calendar date INSIDE ITS OWN seven-day slice (never merely inside the
      // 28-day range -- a row in the wrong slice is rejected), and each inventory row must carry a real date
      // inside [asOf-10d, asOf]. One malformed/impossible/future/out-of-window/wrong-slice row => invalid
      // (zero writes, LKG preserved); bad rows are NEVER silently filtered. Catalog rows are no-date.
      dailyFrags.forEach((f, i) => assertRowsInWindow(f.rows, expectedSlices[i].from, expectedSlices[i].to, `buy-box-loss daily slice ${i}`));
      assertRowsInWindow(inventoryRows, inventoryFrom, asOf, "buy-box-loss inventory");
      assertPlainObjectRows(catalogRows, "buy-box-loss catalog");
      return buyBoxLossPayload({
        accountId: publicAccountId, asOf, from, windowDays: BB_WINDOW_DAYS, sliceDays: BB_SLICE_DAYS,
        sourceLabel: BB_SOURCE_LABEL, priceSourceLabel: BB_PRICE_SOURCE_LABEL,
        dailySliceRows: dailyFrags.map((f) => f.rows),
        inventoryRows, catalogRows,
      });
    },
    validatePayload: (p) => !!p && ("accountId" in p) && ("asOf" in p) && Array.isArray(p.rows)
      && Array.isArray(p.catalogBrands) && Array.isArray(p.currencies) && !!p.window && typeof p.window === "object"
      && ("inventoryAvailable" in p) && ("inventorySnapshotDate" in p) && ("observedWindow" in p),
    // Latest real data date = the latest observed daily date (the observed-window `to`), null when empty.
    latestDataDate: (p) => (p && p.observedWindow && isValidCalendarDate(p.observedWindow.to) ? p.observedWindow.to : null),
  },
  // Returns & Refund Leakage: reproduce the api/datadoe.js `returns-leakage` payload from the raw Returns
  // rows, the grouped Settlements money, the grouped Sales & Traffic pair, and the shared no-date catalog.
  // ALL four sources are required (optionalRequestKeys: []) -- the fetch gate keeps the report PENDING until
  // every source succeeds, so a failed/terminal/truncated/missing required source never saves (LKG kept).
  // The single [asOf-59d, asOf] window is RECOMPUTED from asOf and pinned; returns raw rows must carry a real
  // date inside it (per-row date bound, never merely fragment metadata); settlements/traffic/catalog are
  // grouped/no-date so their rows need only be plain objects. A wrong-window/cross-account/malformed/bad-date
  // fragment or row => invalid (zero writes, LKG preserved); a missing/failed source => unavailable (LKG).
  // Currency is never merged; refund money is absolute; the return-fee component is zero-clamped. ZERO
  // DataDoe/network calls (pure).
  "returns-leakage": {
    snapshotVersion: "returns-leakage/v2d-1", optionalRequestKeys: [], derivedSourceKeys: [],
    derive: ({ sources, context }) => {
      const asOf = context.to != null ? String(context.to) : "";
      if (!isValidCalendarDate(asOf)) {
        throw new Error("returns-leakage derivation requires an authoritative asOf (context.to) that is a real calendar date.");
      }
      // rawSellerId (raw DataDoe seller id) is the SOLE source scope: DataDoe request scope + the id every
      // fragment must carry (cross-account rejection). publicAccountId (context.accountId) is the public/
      // prefixed id the report job + snapshot row are keyed by and is what the PAYLOAD carries.
      const rawSellerId = context.rawSellerId != null ? String(context.rawSellerId) : null;
      const publicAccountId = context.accountId != null ? String(context.accountId) : rawSellerId;
      const from = addDaysStr(asOf, -(RET_WINDOW_DAYS - 1));
      // All four sources are required; defensively reject a missing/failed/unreadable cache (never an empty success).
      for (const key of ["returns-leakage:returns", "returns-leakage:settlements", "returns-leakage:traffic", "returns-leakage:catalog"]) {
        const s = sources[key];
        if (!s || s.available !== true || !Array.isArray(s.rows)) {
          throw deriveError(`returns-leakage ${key} is required but its cache is missing/failed/unreadable; last-known-good preserved.`, "unavailable");
        }
      }
      // Returns: timeout-safe SLICED raw grain -- EXACTLY the recomputed <=7-day slice sequence over
      // [asOf-59d, asOf], NEWEST-FIRST (returns is fetched date DESC; each date lives in exactly one slice,
      // so newest-first slices with DESC rows concatenate to the former whole-window DESC order exactly),
      // single-account, every raw returned-item row bound to its OWN slice window.
      const expectedReturnSlices = splitDateRangeByDays(from, asOf, DERIVE_TIMEOUT_SAFE_SLICE_DAYS).reverse();
      const returnRows = slicedFragmentRows(sources["returns-leakage:returns"], expectedReturnSlices, rawSellerId, "returns-leakage:returns");
      // Settlements / Traffic: GROUPED WITHOUT date (whole-window aggregate rows -- NOT sliceable), exactly
      // one single-account fragment each over [asOf-59d, asOf].
      const settlementRows = singleAccountFragmentRows(sources["returns-leakage:settlements"], "returns-leakage:settlements", rawSellerId, from, asOf);
      const trafficRows = singleAccountFragmentRows(sources["returns-leakage:traffic"], "returns-leakage:traffic", rawSellerId, from, asOf);
      // Catalog: exactly one single-account no-date fragment.
      const catalogRows = noDateFragmentRows(sources["returns-leakage:catalog"], "returns-leakage:catalog", rawSellerId);
      // Settlements + Traffic are GROUPED and Catalog is NO-DATE => plain objects (the returns rows were
      // already per-slice window-bound above -- a stronger check than the former whole-range bound).
      assertPlainObjectRows(settlementRows, "returns-leakage settlements");
      assertPlainObjectRows(trafficRows, "returns-leakage traffic");
      assertPlainObjectRows(catalogRows, "returns-leakage catalog");
      return returnsLeakagePayload({
        accountId: publicAccountId, asOf, from, windowDays: RET_WINDOW_DAYS,
        returnsSourceLabel: RET_RETURNS_LABEL, moneySourceLabel: RET_MONEY_LABEL,
        rateSourceLabel: RET_RATE_LABEL, rateSourceLagDays: RET_RATE_LAG_DAYS, returnHistoryDays: RET_WINDOW_DAYS,
        returnRows, settlementRows, trafficRows, catalogRows,
      });
    },
    validatePayload: (p) => !!p && ("accountId" in p) && ("asOf" in p) && Array.isArray(p.rows)
      && Array.isArray(p.catalogBrands) && Array.isArray(p.currencies) && Array.isArray(p.reasonTotals)
      && !!p.window && typeof p.window === "object" && !!p.fbmOnly && typeof p.fbmOnly === "object"
      && ("returnRecordCount" in p) && ("pendingReturnRequests" in p),
    // Latest real data date = the MAXIMUM real date OBSERVED in the already-validated raw Returns rows (each
    // is a plain object with a real YYYY-MM-DD date inside [asOf-59d, asOf] -- validated in derive above), or
    // null when that row array is empty. This is a source EVIDENCE date, NOT the requested asOf: four
    // successful-but-empty sources must report null so the Admin Data Sync Center never claims empty/lagged
    // data is current. An empty-ASIN raw row (skipped by the fold) still carries a valid source date, so it
    // counts as freshness evidence. Uses `sources` (the third callback arg); never context.to / window.to /
    // Date.now() / fetched_at / saved_at.
    latestDataDate: (p, context, sources) => {
      const src = sources && sources["returns-leakage:returns"];
      const rows = src && Array.isArray(src.rows) ? src.rows : [];
      return maxIsoDate(rows.map((r) => r && r.date));
    },
  },
  // Listing Health: reproduce the api/datadoe.js `listing-health` payload from the no-date Listings, the
  // grouped 30d Sales, the shared FBA inventory snapshot, the shared no-date catalog, and the OPTIONAL
  // no-date Listings (Raw JSON) enrichment. The four non-raw sources are required (fetch gate keeps the
  // report PENDING until each succeeds); `listing-health:listings-raw` is OPTIONAL + degradable. Windows
  // are RECOMPUTED from asOf and pinned; inventory ROW dates are validated real + inside [asOf-10d, asOf];
  // a wrong-window/cross-account/malformed/bad-date fragment => invalid (LKG, zero writes); a missing/failed
  // required source => unavailable (LKG). Currencies never merge; buy box is never evaluated. ZERO DataDoe/
  // network calls (pure).
  "listing-health": {
    snapshotVersion: "listing-health/v2d-1",
    optionalRequestKeys: ["listing-health:listings-raw"],
    derivedSourceKeys: [],
    derive: ({ sources, context }) => {
      const asOf = context.to != null ? String(context.to) : "";
      if (!isValidCalendarDate(asOf)) {
        throw new Error("listing-health derivation requires an authoritative asOf (context.to) that is a real calendar date.");
      }
      // rawSellerId (raw DataDoe seller id) is the SOLE source scope: DataDoe request scope + the id every
      // fragment must carry (cross-account rejection). publicAccountId (context.accountId) is the public/
      // prefixed id the report job + snapshot row are keyed by and is what the PAYLOAD carries.
      const rawSellerId = context.rawSellerId != null ? String(context.rawSellerId) : null;
      const publicAccountId = context.accountId != null ? String(context.accountId) : rawSellerId;
      const salesFrom = addDaysStr(asOf, -(LH_SALES_WINDOW_DAYS - 1));
      const inventoryFrom = addDaysStr(asOf, -LH_INVENTORY_LOOKBACK_DAYS);
      // The FOUR required sources must be a validated saved array (never an empty-success coercion).
      for (const key of ["listing-health:listings", "listing-health:sales", "listing-health:inventory", "listing-health:catalog"]) {
        const s = sources[key];
        if (!s || s.available !== true || !Array.isArray(s.rows)) {
          throw deriveError(`listing-health ${key} is required but its cache is missing/failed/unreadable; last-known-good preserved.`, "unavailable");
        }
      }
      // Listings + Catalog: exactly one single-account NO-DATE fragment each (from === null, to === null).
      const listingRows = noDateFragmentRows(sources["listing-health:listings"], "listing-health:listings", rawSellerId);
      const catalogRows = noDateFragmentRows(sources["listing-health:catalog"], "listing-health:catalog", rawSellerId);
      // Sales: one single-account fragment over [asOf-29d, asOf]. Inventory: one over [asOf-10d, asOf].
      const salesRows = singleAccountFragmentRows(sources["listing-health:sales"], "listing-health:sales", rawSellerId, salesFrom, asOf);
      const inventoryRows = singleAccountFragmentRows(sources["listing-health:inventory"], "listing-health:inventory", rawSellerId, inventoryFrom, asOf);
      // Optional Listings (Raw JSON) enrichment -- EXACT state handling:
      //   validated success (incl. empty rows) => issuesAvailable true (build the raw fold);
      //   the approved degraded/disabled availabilityPolicy => save a valid snapshot with issuesAvailable
      //     false + the exact enable hint (a terminal-disabled policy would block instead);
      //   pending / missing / failed-for-other-reasons / unreadable => unavailable (LKG preserved).
      const rawSource = sources["listing-health:listings-raw"];
      let issuesAvailable = true;
      let issuesUnavailableReason = null;
      let rawRows = [];
      if (rawSource && rawSource.available === true && Array.isArray(rawSource.rows)) {
        rawRows = noDateFragmentRows(rawSource, "listing-health:listings-raw", rawSellerId);
      } else if (rawSource && rawSource.disabled === true) {
        const outcome = sourceDisabledOutcome(rawSource.disabledPolicy || null);
        if (outcome.blocks) {
          throw deriveError("listing-health:listings-raw is terminally disabled; snapshot blocked.", "blocked");
        }
        issuesAvailable = false;
        issuesUnavailableReason = LH_ISSUES_ENABLE_HINT;
      } else {
        throw deriveError("listing-health:listings-raw is not a validated success and not the approved degraded/disabled state (pending/missing/failed/unreadable); last-known-good preserved.", "unavailable");
      }
      // Row-level validation: every listings / sales / catalog / raw row must be a plain object; every
      // inventory row must carry a real calendar date inside [asOf-10d, asOf] (never silently filtered).
      assertPlainObjectRows(listingRows, "listing-health listings");
      assertPlainObjectRows(salesRows, "listing-health sales");
      assertPlainObjectRows(catalogRows, "listing-health catalog");
      assertPlainObjectRows(rawRows, "listing-health listings-raw");
      assertRowsInWindow(inventoryRows, inventoryFrom, asOf, "listing-health inventory");
      // B2 fail-closed currency isolation: the route payload folds sales by SKU only, so a SKU split across
      // currencies (or a listing currency conflicting with its single sales currency) would silently merge
      // money. Reject BEFORE folding => typed invalid, zero writes, LKG preserved (route core unchanged).
      assertListingHealthCurrencyIsolation(listingRows, salesRows);
      return listingHealthPayload({
        accountId: publicAccountId, asOf, salesFrom, windowDays: LH_SALES_WINDOW_DAYS,
        sourceLabel: LH_SOURCE_LABEL, salesSourceLabel: LH_SALES_SOURCE_LABEL, issuesSourceLabel: LH_ISSUES_SOURCE_LABEL,
        issuesAvailable, issuesUnavailableReason,
        listingRows, salesRows, inventoryRows, catalogRows, rawRows,
      });
    },
    validatePayload: (p) => !!p && ("accountId" in p) && ("asOf" in p) && Array.isArray(p.rows)
      && Array.isArray(p.catalogBrands) && Array.isArray(p.currencies) && typeof p.issuesAvailable === "boolean"
      && !!p.salesWindow && typeof p.salesWindow === "object" && ("inventoryAvailable" in p)
      && ("inventorySnapshotDate" in p) && ("listingCount" in p) && ("issuesUnavailableReason" in p),
    // Latest real data date = the validated inventory snapshot date (source evidence), or null. Never asOf /
    // fetched_at / saved_at / Date.now().
    latestDataDate: (p) => (p && p.inventoryAvailable && isValidCalendarDate(p.inventorySnapshotDate) ? p.inventorySnapshotDate : null),
  },
  // Listing & Search Optimizer: reproduce the api/datadoe.js `listing-optimizer` payload from the
  // validated saved fragments. SQP-weekly is the KICKOFF/required-but-DEGRADABLE source: a durable
  // SOURCE_DISABLED (degraded) yields the faithful sqpAvailable:false snapshot (save-unavailable-snapshot);
  // a terminal-disabled SQP => blocked; a missing/failed/unreadable SQP => unavailable (LKG preserved). A
  // validated SQP success (INCLUDING a genuine zero-row success) then REQUIRES the rich no-date content
  // catalog (staged only after SQP succeeds); a missing/failed/unreadable catalog after SQP success =>
  // unavailable (LKG preserved). Windows are recomputed from asOf and pinned; a wrong/multi/zero/
  // cross-account/out-of-window/malformed fragment => invalid (zero writes, LKG preserved). The derive ALSO
  // fails closed on non-finite SQP counts/rank/price, a malformed median-price currency, and an ambiguous
  // cross-currency median-price group -- strictness the live route never needs. ZERO DataDoe/network (pure).
  "listing-optimizer": {
    // BOTH request keys are optional in the STATIC gate so the no-data path never blocks: SQP-weekly
    // degrades (disabled => sqpAvailable:false snapshot) and the catalog is CONDITIONALLY required (only
    // after a validated SQP success). The derive below enforces the real dependency fail-closed.
    snapshotVersion: "listing-optimizer/v2d-1", optionalRequestKeys: ["listing-optimizer:sqp-weekly", "listing-optimizer:catalog"], derivedSourceKeys: [],
    derive: ({ sources, context }) => {
      const asOf = context.to != null ? String(context.to) : "";
      if (!isValidCalendarDate(asOf)) {
        throw new Error("listing-optimizer derivation requires an authoritative asOf (context.to) that is a real calendar date.");
      }
      // rawSellerId scopes every DataDoe fragment; the PAYLOAD carries the PUBLIC account id (equal to raw
      // on the primary route), so the snapshot accountId matches the snapshot key + the frontend scope.
      const rawSellerId = context.rawSellerId != null ? String(context.rawSellerId) : null;
      const publicAccountId = context.accountId != null ? String(context.accountId) : rawSellerId;
      const from = addDaysStr(asOf, -OPT_LOOKBACK_DAYS);

      const sqp = sources["listing-optimizer:sqp-weekly"];
      // Durable SOURCE_DISABLED (degraded) => the faithful sqpAvailable:false snapshot; terminal => blocked.
      if (sqp && sqp.disabled) {
        if (sourceDisabledOutcome(sqp.disabledPolicy || null).blocks) {
          throw deriveError("listing-optimizer SQP source is terminally disabled; snapshot blocked.", "blocked");
        }
        return listingOptimizerUnavailablePayload({
          accountId: publicAccountId, asOf, from, lookbackDays: OPT_LOOKBACK_DAYS,
          sqpUnavailableReason: OPT_SQP_ENABLE_HINT, sqpSourceLabel: OPT_SQP_LABEL,
        });
      }
      // SQP is REQUIRED to kick off: a validated (cleanly-loaded) array is a success ([] is a real empty
      // success). A missing/failed/unreadable SQP cache => unavailable (last-known-good preserved).
      if (!sqp || sqp.available !== true || !Array.isArray(sqp.rows)) {
        throw deriveError("listing-optimizer SQP is required but its cache is missing/failed/unreadable; last-known-good preserved.", "unavailable");
      }
      // Exactly one single-account weekly fragment over [asOf-84d, asOf]; every row a plain object whose
      // date is a real calendar date inside that exact window (recompute the window; never trust a caller).
      const sqpRows = singleAccountFragmentRows(sqp, "listing-optimizer:sqp-weekly", rawSellerId, from, asOf);
      assertRowsInWindow(sqpRows, from, asOf, "listing-optimizer weekly SQP");

      // A validated SQP success (incl. zero rows) ACTIVATES the catalog, which is now REQUIRED. A
      // terminal-disabled catalog => blocked; a missing/failed/unreadable catalog => unavailable (LKG kept).
      const catalog = sources["listing-optimizer:catalog"];
      if (!catalog || catalog.available !== true || !Array.isArray(catalog.rows)) {
        if (catalog && catalog.disabled && sourceDisabledOutcome(catalog.disabledPolicy || null).blocks) {
          throw deriveError("listing-optimizer catalog is required after SQP success but disabled; snapshot blocked.", "blocked");
        }
        throw deriveError("listing-optimizer catalog is required after SQP success but its cache is missing/failed/unreadable; last-known-good preserved.", "unavailable");
      }
      // Exactly one single-account NO-DATE catalog fragment; every row a plain object.
      const catalogRows = noDateFragmentRows(catalog, "listing-optimizer:catalog", rawSellerId);
      assertPlainObjectRows(catalogRows, "listing-optimizer catalog");

      return listingOptimizerPayload({
        accountId: publicAccountId, asOf, from, lookbackDays: OPT_LOOKBACK_DAYS,
        sqpRows, catalogRows, sqpSourceLabel: OPT_SQP_LABEL, contentSourceLabel: OPT_CATALOG_LABEL,
      });
    },
    validatePayload: (p) => !!p && typeof p === "object" && typeof p.sqpAvailable === "boolean"
      && !!p.window && typeof p.window === "object"
      && Array.isArray(p.periods) && Array.isArray(p.queries) && Array.isArray(p.products)
      && Array.isArray(p.catalogBrands) && ("accountId" in p) && ("asOf" in p),
    // The latest data date is the most recent SQP weekly period (date-only already); no SQP data => null.
    latestDataDate: (p) => maxIsoDate((p.periods || []).map(String)),
  },
  // PPC Performance: reproduce the api/datadoe.js `ppc-performance` payload. ALL advertising figures are
  // DERIVED from the persisted Supabase Ads history injected via the derive context (`context.ppcAds`, loaded
  // + validated by the server-only PPC Ads loader) -- this derive makes ZERO DataDoe/network calls and PPC
  // creates ZERO Ads exports. The only DataDoe inputs are the REQUIRED shared no-date catalog and the
  // OPTIONAL total-sales denominator (TACoS). Total-sales is planned ONLY when the validated Ads currency
  // signal proves <= 1 currency; a >1-currency account skips it by design; a planned-but-failed/degraded
  // total-sales degrades ONLY TACoS and never blocks campaigns/ASINs/targets/search terms. Currency is never
  // merged (every rollup key includes currency). Payload accountId is the PUBLIC id; rawSellerId scopes the
  // DataDoe catalog/total-sales fragments.
  "ppc-performance": {
    snapshotVersion: "ppc-performance/v2d-1",
    optionalRequestKeys: ["ppc-performance:total-sales"],
    derivedSourceKeys: ["ads-campaign-date", "ads-asin-date", "ads-targeting-date", "ads-search-terms-date"],
    derivedContextKeys: ["ppcAds"],
    derive: ({ sources, context }) => {
      const asOf = context.to != null ? String(context.to) : "";
      if (!isValidCalendarDate(asOf)) {
        throw new Error("ppc-performance derivation requires an authoritative asOf (context.to) that is a real calendar date.");
      }
      const rawSellerId = context.rawSellerId != null ? String(context.rawSellerId) : null;
      const publicAccountId = context.accountId != null ? String(context.accountId) : rawSellerId;
      const from = addDaysStr(asOf, -(PPC_WINDOW_DAYS - 1));
      // Persisted Ads context (validated by the server-only PPC Ads loader). status !== "ok" means the Ads
      // read failed / was unvalidated / the account is unseeded (or the 120k row cap was hit) => unavailable
      // (LKG preserved). A validated EMPTY window (status "ok", adsRows []) is DISTINCT and derives a valid,
      // honestly-empty report.
      const ppcAds = context.ppcAds;
      if (!ppcAds || ppcAds.status !== "ok" || !Array.isArray(ppcAds.adsRows) || !Array.isArray(ppcAds.syncStates)) {
        throw deriveError("ppc-performance persisted Ads context is unavailable (Ads read failed/unvalidated/unseeded, or the row cap was exceeded); last-known-good preserved.", "unavailable");
      }
      // Re-enforce the DURABLE-coverage contract on the injected context (the loadDerivedContext boundary is an
      // injected orchestration seam, so a wrong/future loader could hand back status:"ok" with missing or
      // contradictory sourceCoverage). Missing/duplicate/unknown keys, mismatched required flags, an unproven
      // default (campaign/ASIN), or an optional whose folded != proven => fail closed, save nothing, keep LKG.
      const coverageContract = validatePpcSourceCoverage(ppcAds.sourceCoverage);
      if (!coverageContract.ok) {
        throw deriveError(`ppc-performance persisted Ads coverage contract is missing/invalid (${coverageContract.reason}); last-known-good preserved.`, "unavailable");
      }
      // Catalog is REQUIRED: exactly one single-account no-date fragment (a missing/failed catalog =>
      // unavailable, LKG preserved).
      const catalogSource = sources["ppc-performance:catalog"];
      if (!catalogSource || catalogSource.available !== true || !Array.isArray(catalogSource.rows)) {
        throw deriveError("ppc-performance catalog is required but its cache is missing/failed/unreadable; last-known-good preserved.", "unavailable");
      }
      const catalogRows = noDateFragmentRows(catalogSource, "ppc-performance:catalog", rawSellerId);
      assertPlainObjectRows(catalogRows, "ppc-performance catalog");
      // TACoS denominator state (total-sales is OPTIONAL and its failure degrades ONLY TACoS):
      //   > 1 Ads currency  -> not planned; the exact multi-currency explanation.
      //   <= 1 currency, total-sales succeeded -> sum the validated saved rows.
      //   <= 1 currency, total-sales missing/failed/degraded/malformed/wrong-window -> safe degraded reason.
      const currencyCount = new Set(ppcAds.adsRows.map((r) => String((r && r.currency) || "").trim()).filter(Boolean)).size;
      let totalSalesRows = null;
      let totalSalesUnavailable = null;
      if (currencyCount > 1) {
        totalSalesUnavailable = PPC_MULTI_CURRENCY_REASON;
      } else {
        try {
          const ts = sources["ppc-performance:total-sales"];
          if (ts && ts.available === true && Array.isArray(ts.rows)) {
            totalSalesRows = singleAccountFragmentRows(ts, "ppc-performance:total-sales", rawSellerId, from, asOf);
            assertRowsInWindow(totalSalesRows, from, asOf, "ppc-performance total-sales");
          } else {
            totalSalesUnavailable = PPC_TOTAL_SALES_DEGRADED_REASON;
          }
        } catch (_e) {
          // A malformed / cross-account / wrong-window total-sales fragment degrades ONLY TACoS; it must
          // NEVER invalidate or block the rest of PPC.
          totalSalesRows = null;
          totalSalesUnavailable = PPC_TOTAL_SALES_DEGRADED_REASON;
        }
      }
      return ppcPerformancePayload({
        accountId: publicAccountId, asOf, from, windowDays: PPC_WINDOW_DAYS,
        adsSourceDescriptors: PPC_ADS_SOURCE_DESCRIPTORS,
        totalSalesSourceLabel: PPC_TOTAL_SALES_LABEL, totalSalesLagDays: PPC_TOTAL_SALES_LAG_DAYS,
        adsRows: ppcAds.adsRows, syncStates: ppcAds.syncStates, sourceCoverage: ppcAds.sourceCoverage, catalogRows,
        totalSalesRows, totalSalesUnavailable,
      });
    },
    validatePayload: (p) => !!p && ("accountId" in p) && ("asOf" in p) && Array.isArray(p.campaigns)
      && Array.isArray(p.asins) && Array.isArray(p.targets) && Array.isArray(p.searchTerms) && Array.isArray(p.daily)
      && Array.isArray(p.currencies) && Array.isArray(p.sourceAvailability) && Array.isArray(p.catalogBrands)
      && ("totalSales" in p) && ("totalSalesUnavailable" in p) && ("adsRowCount" in p) && ("latestMetricDate" in p),
    // Latest real data date = the MAX validated Ads metric_date (source evidence); null for a validated
    // empty Ads window. Never asOf / fetched_at / saved_at / Date.now().
    latestDataDate: (p) => (p && isValidCalendarDate(p.latestMetricDate) ? p.latestMetricDate : null),
  },
};

// Freeze each entry with computed requiredRequestKeys (declared keys minus optional).
export const REPORT_DERIVATIONS = Object.freeze(
  Object.fromEntries(Object.entries(REGISTRY).map(([reportKey, entry]) => {
    const declared = declaredRequestKeys(reportKey) || [];
    const optional = entry.optionalRequestKeys || [];
    const requiredRequestKeys = declared.filter((k) => !optional.includes(k));
    return [reportKey, Object.freeze({
      reportKey,
      snapshotVersion: entry.snapshotVersion,
      requiredRequestKeys: Object.freeze(requiredRequestKeys),
      optionalRequestKeys: Object.freeze([...optional]),
      derivedSourceKeys: Object.freeze([...(entry.derivedSourceKeys || [])]),
      // Blocker 1 allowlist: the ONLY derive-context field names a loader may inject for this
      // report (empty for every report that needs no derived input). Frozen so it can't drift.
      derivedContextKeys: Object.freeze([...(entry.derivedContextKeys || [])]),
      derive: entry.derive || null,
      validatePayload: entry.validatePayload || ((p) => p != null),
      latestDataDate: entry.latestDataDate || (() => null),
    })];
  })),
);

// Coverage: every scheduler-declared report has a derivation entry, and every report is
// covered exactly once (declared derivation OR derived-only). Used by the sidebar-coverage
// test and by callers that enumerate the map.
export function reportDerivationCoverage() {
  const declared = declaredReportKeys();
  const covered = new Set(Object.keys(REPORT_DERIVATIONS));
  const derivedOnly = new Set(DERIVED_ONLY_REPORT_KEYS);
  const missing = declared.filter((k) => !covered.has(k) && !derivedOnly.has(k));
  const both = declared.filter((k) => covered.has(k) && derivedOnly.has(k));
  return { declared, covered: [...covered], derivedOnly: [...derivedOnly], missing, both };
}

/**
 * Derive one report snapshot from saved source rows. PURE and offline: no I/O, no transport.
 *
 * `sources` maps each requestKey the report depends on to a load result:
 *   { available: boolean, rows: array|null, reason?: string, disabled?: boolean }
 * `available:true` REQUIRES `Array.isArray(rows)` (a validated saved payload; [] is valid).
 * The caller (worker) builds this from the source cache; a miss/malformed/failed source is
 * `available:false` and NEVER coerced to an empty array here.
 *
 * Returns a typed result the worker maps onto sync_report_jobs statuses:
 *   status: "derived" | "unavailable" | "blocked" | "invalid" | "unmapped" | "not-implemented"
 */
export function deriveReportSnapshot({ reportKey, sources = {}, context = {} }) {
  const entry = REPORT_DERIVATIONS[reportKey];
  if (!entry) {
    return { status: "unmapped", validated: false, payload: null, latestDataDate: null, errorStage: "derive", reason: `no derivation adapter for "${reportKey}"` };
  }

  // 1) Every REQUIRED source must be a validated saved array. Missing/malformed/failed =>
  //    do NOT derive; a terminally-disabled required source blocks only this report.
  for (const key of entry.requiredRequestKeys) {
    const s = sources[key];
    const ok = !!s && s.available === true && Array.isArray(s.rows);
    if (!ok) {
      const blocked = !!(s && s.disabled) && sourceDisabledOutcome(s.disabledPolicy || null).blocks;
      return {
        status: blocked ? "blocked" : "unavailable",
        validated: false,
        payload: null,
        latestDataDate: null,
        errorStage: blocked ? "fetch" : "validate",
        reason: (s && s.reason) || `required source "${key}" is not a validated saved payload`,
        requestKey: key,
      };
    }
  }

  if (typeof entry.derive !== "function") {
    // Dependencies are ready but the pure calc extraction is not wired yet. Report it
    // honestly (derive-pending) rather than saving a fabricated/empty snapshot.
    return { status: "not-implemented", validated: false, payload: null, latestDataDate: null, errorStage: "derive", reason: `derivation for "${reportKey}" is declared but not yet wired` };
  }

  // 2) Derive (pure). 3) Validate the derived payload is structurally real.
  let payload;
  try {
    payload = entry.derive({ sources, context });
  } catch (error) {
    // A derive may raise a TYPED outcome for a CONDITIONALLY-required source (one the static required
    // gate cannot see): a terminal-disabled such source => `blocked`; a failed/missing/unreadable one
    // => `unavailable`. Any other throw is genuine data-invalidity => `invalid`. All three preserve
    // last-known-good (no snapshot is written).
    const typed = error && (error.deriveStatus === "blocked" || error.deriveStatus === "unavailable")
      ? error.deriveStatus : "invalid";
    return {
      status: typed, validated: false, payload: null, latestDataDate: null,
      errorStage: typed === "blocked" ? "fetch" : "derive",
      reason: typed === "invalid" ? "derivation threw" : (error && error.message ? error.message : String(error)),
      detail: error && error.message ? error.message : String(error),
    };
  }
  if (!entry.validatePayload(payload)) {
    return { status: "invalid", validated: false, payload: null, latestDataDate: null, errorStage: "validate", reason: `derived payload for "${reportKey}" failed validation` };
  }
  return {
    status: "derived",
    validated: true,
    payload,
    latestDataDate: entry.latestDataDate(payload, context, sources) || null,
    errorStage: null,
    reason: null,
  };
}

// ---- Parity / comparison (PURE; no export) --------------------------------------------
//
// Compare a Scheduler v2 shadow snapshot payload against the equivalent current (production)
// report payload WITHOUT re-fetching anything. Both payloads are already-saved objects; this
// only diffs their structure/totals so a reviewer can confirm v2 reproduces v1 before any
// cutover. `arrayKeys` names the payload's primary row arrays to length-check (defaults cover
// the wired reports). Returns a structured, JSON-safe summary; `equal` is a strict deep-equal.
export function compareReportPayloads(shadowPayload, productionPayload, { arrayKeys = ["rows", "events"] } = {}) {
  const summary = { equal: false, bothPresent: false, keyDiff: { onlyInShadow: [], onlyInProduction: [] }, arrayLengths: {}, sampleMismatches: [] };
  if (shadowPayload == null || productionPayload == null) {
    summary.bothPresent = false;
    summary.reason = shadowPayload == null && productionPayload == null ? "neither snapshot present"
      : shadowPayload == null ? "shadow snapshot missing" : "production snapshot missing";
    return summary;
  }
  summary.bothPresent = true;
  const sKeys = Object.keys(shadowPayload);
  const pKeys = Object.keys(productionPayload);
  summary.keyDiff.onlyInShadow = sKeys.filter((k) => !pKeys.includes(k)).sort();
  summary.keyDiff.onlyInProduction = pKeys.filter((k) => !sKeys.includes(k)).sort();
  for (const key of arrayKeys) {
    const s = Array.isArray(shadowPayload[key]) ? shadowPayload[key].length : null;
    const p = Array.isArray(productionPayload[key]) ? productionPayload[key].length : null;
    if (s != null || p != null) summary.arrayLengths[key] = { shadow: s, production: p, match: s === p };
  }
  summary.equal = stableStringify(shadowPayload) === stableStringify(productionPayload);
  return summary;
}

// Deterministic stringify (sorted keys) for a stable deep-equality check across payloads.
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}
