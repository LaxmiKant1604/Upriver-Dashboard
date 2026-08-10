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
} from "../reports/derivation-core.js";
import {
  declaredReportKeys,
  declaredRequestKeys,
  REPORT_DERIVED_ONLY,
  sourceDisabledOutcome,
  resolveDailyAdsAvailability,
  validateSkuPlMonthlyWindows,
} from "./report-source-contracts.js";

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

// ---- The derivation registry (dependency map) ------------------------------------------
//
// Each entry:
//   snapshotVersion   : shadow snapshot version tag (folded into the snapshot params hash)
//   optionalRequestKeys : request keys allowed to be absent/degraded WITHOUT blocking
//   derivedSourceKeys : persisted non-DataDoe sources (e.g. ads_daily_source_rows)
//   derive            : PURE ({ sources, context }) -> payload | null (null = not yet wired)
//   validatePayload   : (payload) -> boolean structural validity (a derived success is real)
//   latestDataDate    : (payload, context) -> ISO date | null
//
// requiredRequestKeys are computed from the report's declared contract minus optional keys,
// so the map can never drift from report-source-contracts.js.
const REGISTRY = {
  "brand-sales": {
    snapshotVersion: "brand-sales/v2d-1",
    optionalRequestKeys: [],
    derivedSourceKeys: [],
    derive: ({ sources }) => {
      const rows = orderSalesByBrand(
        sources["brand-sales:order-lines"].rows,
        sources["brand-sales:catalog"].rows,
      );
      return { rows, catalogBrands: catalogBrandNames(rows) };
    },
    validatePayload: (p) => !!p && Array.isArray(p.rows) && Array.isArray(p.catalogBrands),
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
      const supersetRows = sources["daily-reporting:asin-day-superset"].rows;
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
  "fba-plan": { snapshotVersion: "fba-plan/v2d-1", optionalRequestKeys: ["fba-plan:awd"], derivedSourceKeys: [], derive: null }, // awd is US-only (marketplace-conditional), so not a blanket required dep
  "reconciliation": { snapshotVersion: "reconciliation/v2d-1", optionalRequestKeys: [], derivedSourceKeys: [], derive: null },
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
  "keyword-rank": { snapshotVersion: "keyword-rank/v2d-1", optionalRequestKeys: ["keyword-rank:sqp-monthly"], derivedSourceKeys: [], derive: null },
  "sales-movers": { snapshotVersion: "sales-movers/v2d-1", optionalRequestKeys: [], derivedSourceKeys: [], derive: null },
  "buy-box-loss": { snapshotVersion: "buy-box-loss/v2d-1", optionalRequestKeys: [], derivedSourceKeys: [], derive: null },
  "returns-leakage": { snapshotVersion: "returns-leakage/v2d-1", optionalRequestKeys: [], derivedSourceKeys: [], derive: null },
  "listing-health": { snapshotVersion: "listing-health/v2d-1", optionalRequestKeys: ["listing-health:listings-raw"], derivedSourceKeys: [], derive: null },
  "listing-optimizer": { snapshotVersion: "listing-optimizer/v2d-1", optionalRequestKeys: ["listing-optimizer:sqp-weekly"], derivedSourceKeys: [], derive: null },
  "ppc-performance": { snapshotVersion: "ppc-performance/v2d-1", optionalRequestKeys: ["ppc-performance:total-sales"], derivedSourceKeys: ["ads-campaign-date", "ads-asin-date", "ads-targeting-date", "ads-search-terms-date"], derive: null },
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
    return { status: "invalid", validated: false, payload: null, latestDataDate: null, errorStage: "derive", reason: "derivation threw", detail: error && error.message ? error.message : String(error) };
  }
  if (!entry.validatePayload(payload)) {
    return { status: "invalid", validated: false, payload: null, latestDataDate: null, errorStage: "validate", reason: `derived payload for "${reportKey}" failed validation` };
  }
  return {
    status: "derived",
    validated: true,
    payload,
    latestDataDate: entry.latestDataDate(payload, context) || null,
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
