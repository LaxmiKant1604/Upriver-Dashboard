// Scheduler v2 -- SOURCE-FIRST tranche orchestration descriptor (SHADOW MODE, pure, zero I/O).
//
// A "source tranche" is a BUILD-TIME, plan-derived selection of which canonical source families a
// single reviewed dispatch invocation is allowed to EXECUTE. It never changes the plan itself: the
// full canonical plan (every source job + every owner membership) is still upserted durably; the
// tranche only narrows the set of jobs actually created/polled/downloaded this pass. Unselected
// families stay pending/retryable, so the cycle stays non-drained and the NEXT tranche resumes the
// SAME (bucket, cycle_date) cycle. A null tranche means "execute everything" (behavior unchanged).
//
// The selector is a genuinely IMMUTABLE, UNFORGEABLE descriptor (Blocker 5). It selects by canonical
// source_key (the common case: run one source family at a time) OR by an explicit request_hash allowlist.
// Both fail closed on a malformed spec so a buggy caller can never widen execution to an unintended family.
//
// IMMUTABILITY / TRUST MODEL (why not a plain frozen object with a Set):
//   - The membership set is kept PRIVATE inside the built closure; the descriptor exposes only FROZEN
//     ARRAY snapshots (`sourceKeys` / `requestHashes`) for inspection, never a mutable Set a caller could
//     `.add()` to and thereby widen trusted policy after construction.
//   - `selects(job)` is a FIXED function built HERE from the validated spec. A tranche NEVER adopts a
//     caller-supplied `selects()` -- a spec's own `selects` property (if any) is ignored, and a forged
//     "already-built" object is rejected (see below), so an arbitrary predicate can never become policy.
//   - Authenticity is a module-PRIVATE Symbol brand (TRANCHE_BRAND). Only makeSourceTranche can stamp it,
//     so isSourceTranche cannot be satisfied by any object a caller constructs; idempotent normalization
//     therefore passes through only genuine, this-module-built descriptors.

import { REPORT_SOURCE_CONTRACTS } from "./report-source-contracts.js";

// Module-private brand. Not exported, so no external caller can place it on a forged object.
const TRANCHE_BRAND = Symbol("source-tranche/v2");

// A value is a genuine built tranche ONLY if it carries the private brand (and is frozen). Duck-typing on
// a `selects` function / a Set is deliberately NOT used: that let a caller forge a policy object.
export function isSourceTranche(value) {
  return !!value && typeof value === "object" && value[TRANCHE_BRAND] === true && Object.isFrozen(value);
}

function requireNonblankStringArray(arr, label) {
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error(`makeSourceTranche: ${label} must be a non-empty array of nonblank strings (fail closed).`);
  }
  const values = arr.map((v) => {
    if (typeof v !== "string" || v.trim() === "") {
      throw new Error(`makeSourceTranche: ${label} entries must all be nonblank strings (fail closed).`);
    }
    return v;
  });
  return values;
}

/**
 * Build a genuinely IMMUTABLE, branded tranche descriptor
 * `{ name, mode, sourceKeys:frozen[], requestHashes:frozen[], selects(job) }` (Blocker 5).
 * Accepts EXACTLY ONE of:
 *   - `{ sourceKeys: [nonblank strings], name? }` -> selects(job) is true iff the deduped/canonical job's
 *     source_key (job.sourceKey || job.source_key) is in the (private) set;
 *   - `{ requestHashes: [nonblank strings], name? }` -> selects(job) is true iff job.requestHash
 *     (job.requestHash || job.request_hash) is in the (private) set.
 * A malformed spec (not an object, both/neither selector, a blank/non-string entry) THROWS (fail closed).
 * A GENUINE already-built (branded, frozen) descriptor is returned unchanged (idempotent); a spec's own
 * `selects`/`sourceKeys`-Set properties are NEVER trusted -- only the validated string arrays are used.
 */
export function makeSourceTranche(spec) {
  if (isSourceTranche(spec)) return spec;
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error("makeSourceTranche requires a spec object { sourceKeys:[...] } or { requestHashes:[...] } (fail closed).");
  }
  const hasSourceKeys = spec.sourceKeys !== undefined;
  const hasRequestHashes = spec.requestHashes !== undefined;
  if (hasSourceKeys === hasRequestHashes) {
    throw new Error("makeSourceTranche requires EXACTLY ONE of `sourceKeys` or `requestHashes` (fail closed).");
  }
  if (spec.name !== undefined && (typeof spec.name !== "string" || spec.name.trim() === "")) {
    throw new Error("makeSourceTranche: when supplied, `name` must be a nonblank string (fail closed).");
  }

  const mode = hasSourceKeys ? "sourceKeys" : "requestHashes";
  // requireNonblankStringArray fails closed on a Set (not an Array), so a forged `{ sourceKeys: new Set() }`
  // can never slip through as a spec; only a real nonblank string ARRAY is accepted.
  const values = requireNonblankStringArray(hasSourceKeys ? spec.sourceKeys : spec.requestHashes, mode);
  // PRIVATE membership set (closure-local, never exposed). Lookup is O(1); policy cannot be mutated later.
  const memberSet = new Set(values);
  const memberList = Object.freeze([...memberSet]);
  const sourceKeys = hasSourceKeys ? memberList : Object.freeze([]);
  const requestHashes = hasRequestHashes ? memberList : Object.freeze([]);
  const name = (typeof spec.name === "string" && spec.name.trim() !== "")
    ? spec.name
    : (hasSourceKeys ? memberList.join("+") : `requestHashes(${memberSet.size})`);

  const selects = (job) => {
    if (!job || typeof job !== "object") return false;
    if (mode === "sourceKeys") {
      const key = job.sourceKey ?? job.source_key ?? "";
      return memberSet.has(key);
    }
    const hash = job.requestHash ?? job.request_hash ?? "";
    return memberSet.has(hash);
  };

  const descriptor = { name, mode, sourceKeys, requestHashes, selects };
  // Stamp the private brand as a non-enumerable, non-writable, non-configurable own property, then freeze.
  Object.defineProperty(descriptor, TRANCHE_BRAND, { value: true, enumerable: false, writable: false, configurable: false });
  return Object.freeze(descriptor);
}

// ---------------------------------------------------------------------------------------------------
// SOURCE_TRANCHE_ORDER -- the deterministic, reviewed order in which a source-first cutover drains the
// canonical source families, ONE tranche at a time, resuming the same cycle between tranches.
//
// The classification is DERIVED from REPORT_SOURCE_CONTRACTS metadata (the distinct set of fetched
// source_key families) and cross-checked below so it can never silently drift from the contracts. The
// five ordered groups (documented resulting order):
//
//   [1] order-line-items                                     -- the single canonical OLI sales fragment
//   [2] product-catalog                                      -- the organization-wide catalog
//   [3] settlements, returns, profit-by-sku-date,            -- remaining DATE-SLICEABLE families (a date
//       sales-traffic-asin-date                                 window; not OLI/catalog)
//   [4] listings, listings-raw, fba-inventory-health,        -- CURRENT-STATE families (no/short as-of
//       content-changes                                         snapshot; not date-sliced history)
//   [5] sqp-weekly, sqp-monthly                              -- STAGED / SIGNAL-DEPENDENT SQP families
//
// NOTE on sales-traffic-asin-date: it is EXCLUSIVE to Sales Movers (a signal-dependent staged report),
// but the source FAMILY itself carries a date window, so it is classified as date-sliceable in tranche
// [3]. Tranche [5] is the SQP weekly/monthly signal families. Each source family appears in EXACTLY one
// tranche; the cross-check below proves the union equals the full contract source set (no drift, no gap).
const TRANCHE_CLASSIFICATION = [
  { name: "order-line-items", sourceKeys: ["order-line-items"] },
  { name: "product-catalog", sourceKeys: ["product-catalog"] },
  { name: "date-sliceable", sourceKeys: ["settlements", "returns", "profit-by-sku-date", "sales-traffic-asin-date"] },
  { name: "current-state", sourceKeys: ["listings", "listings-raw", "fba-inventory-health", "content-changes"] },
  { name: "staged-signal", sourceKeys: ["sqp-weekly", "sqp-monthly"] },
];

// The complete set of fetched source families the contracts actually declare (a contract entry without a
// sourceKey is a DERIVED input -- e.g. ads_daily_source_rows -- and creates no source job, so it is excluded).
function contractSourceKeySet() {
  const keys = new Set();
  for (const sources of Object.values(REPORT_SOURCE_CONTRACTS)) {
    for (const c of sources || []) {
      if (c && typeof c.sourceKey === "string" && c.sourceKey.trim() !== "") keys.add(c.sourceKey);
    }
  }
  return keys;
}

/**
 * Compute (and validate against the contract metadata) the deterministic ordered list of tranche specs.
 * Fails closed if the hand-reviewed classification drifts from REPORT_SOURCE_CONTRACTS -- a NEW fetched
 * family with no tranche, a classified family no contract declares, or a family in two tranches. Returns
 * a frozen array of frozen `{ name, sourceKeys:[...] }` specs (inputs to makeSourceTranche).
 */
export function sourceTrancheOrder() {
  const contractKeys = contractSourceKeySet();
  const declared = [];
  for (const t of TRANCHE_CLASSIFICATION) {
    for (const k of t.sourceKeys) {
      if (declared.includes(k)) {
        throw new Error(`sourceTrancheOrder: source family "${k}" is classified into more than one tranche (fail closed).`);
      }
      declared.push(k);
    }
  }
  for (const k of contractKeys) {
    if (!declared.includes(k)) {
      throw new Error(`sourceTrancheOrder: fetched source family "${k}" from REPORT_SOURCE_CONTRACTS is not classified into any tranche (drift; fail closed).`);
    }
  }
  for (const k of declared) {
    if (!contractKeys.has(k)) {
      throw new Error(`sourceTrancheOrder: classified source family "${k}" is not present in REPORT_SOURCE_CONTRACTS (stale; fail closed).`);
    }
  }
  // Tranche 1 must be exactly OLI and tranche 2 exactly the catalog (the source-first invariant).
  if (!(TRANCHE_CLASSIFICATION[0].sourceKeys.length === 1 && TRANCHE_CLASSIFICATION[0].sourceKeys[0] === "order-line-items")) {
    throw new Error("sourceTrancheOrder: tranche 1 must be exactly [order-line-items] (fail closed).");
  }
  if (!(TRANCHE_CLASSIFICATION[1].sourceKeys.length === 1 && TRANCHE_CLASSIFICATION[1].sourceKeys[0] === "product-catalog")) {
    throw new Error("sourceTrancheOrder: tranche 2 must be exactly [product-catalog] (fail closed).");
  }
  return Object.freeze(TRANCHE_CLASSIFICATION.map((t) => Object.freeze({ name: t.name, sourceKeys: Object.freeze([...t.sourceKeys]) })));
}

// The frozen, validated tranche order (computed once at module load; drift throws immediately).
export const SOURCE_TRANCHE_ORDER = sourceTrancheOrder();
