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
  compactContentChangeEvents,
} from "../reports/derivation-core.js";
import {
  declaredReportKeys,
  declaredRequestKeys,
  REPORT_DERIVED_ONLY,
  sourceDisabledOutcome,
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
    derive: ({ sources }) => {
      const events = compactContentChangeEvents(
        sources["content-changes:events"].rows,
        sources["content-changes:catalog"].rows,
      );
      return { events, catalogBrands: catalogBrandNames(sources["content-changes:catalog"].rows) };
    },
    validatePayload: (p) => !!p && Array.isArray(p.events) && Array.isArray(p.catalogBrands),
    latestDataDate: (p) => maxIsoDate((p.events || []).map((e) => e.eventTime)),
  },

  // ---- Declared dependency map; derive wiring lands in the next faithful tranche. ----
  // These entries carry the exact required/optional request keys so the worker gates,
  // claims, and preserves last-known-good correctly today; `derive: null` means the pure
  // calc extraction (from an impure builder) is pending and the worker records the report
  // as derive-pending rather than fabricating an unfaithful payload.
  "daily-reporting": { snapshotVersion: "daily-reporting/v2d-1", optionalRequestKeys: [], derivedSourceKeys: ["ads-campaign-date"], derive: null },
  "fba-plan": { snapshotVersion: "fba-plan/v2d-1", optionalRequestKeys: ["fba-plan:listings-awd"], derivedSourceKeys: [], derive: null },
  "reconciliation": { snapshotVersion: "reconciliation/v2d-1", optionalRequestKeys: [], derivedSourceKeys: [], derive: null },
  "sku-pl": { snapshotVersion: "sku-pl/v2d-1", optionalRequestKeys: [], derivedSourceKeys: [], derive: null },
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
