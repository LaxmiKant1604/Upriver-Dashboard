// Scheduler v2 -- CANONICAL BRAND RESOLUTION over the durable Product Catalog (pure, ZERO I/O).
//
// The ONE reviewed brand-mapping policy for the durable source model (Daily Reporting + Brand View first):
//   1. child_asin -> product_brand from the organization-wide catalog;
//   2. when the ASIN does not resolve, sku -> product_brand from the SAME catalog;
//   3. the SKU fallback applies ONLY when that SKU maps to exactly ONE nonblank brand;
//   4. conflicting or blank mappings remain UNMAPPED (fail closed -- never a guess);
//   5. "Unassigned" is NEVER a real catalog brand: a catalog row claiming it is treated as BLANK, and this
//      module never returns it. Presentation layers may LABEL unmapped rows however they wish; the durable
//      model records them as unmapped (brand null).
//
// NOTE: the SKU fallback requires catalog rows that carry `sku`. The EXISTING per-report catalog contracts
// deliberately do NOT fetch `sku` (adding it would change every catalog request_hash); the durable catalog
// snapshot introduces its own versioned organization-wide request instead (see the durable-model design),
// so golden request hashes stay byte-identical. Until that snapshot exists, maps built from sku-less rows
// simply have an empty SKU index (rule 2 never fires) -- behavior stays correct, never wrong.

export const UNASSIGNED_BRAND_LABEL = "Unassigned";

const clean = (v) => String(v ?? "").trim();

// A catalog brand value is REAL only when nonblank and not the fabricated "Unassigned" label.
function realBrand(value) {
  const b = clean(value);
  if (!b) return null;
  if (b.toLowerCase() === UNASSIGNED_BRAND_LABEL.toLowerCase()) return null;
  return b;
}

/**
 * Build the frozen brand maps from organization-wide catalog rows ({ child_asin, sku, product_brand, ... }).
 *   byAsin  : child_asin -> brand, ONLY when every real brand seen for that ASIN agrees (a conflict unmaps
 *             the ASIN and records it in conflictedAsins -- never first/last-row-wins);
 *   bySku   : sku -> brand, ONLY when that SKU maps to exactly one real brand (else ambiguousSkus);
 *   conflictedAsins / ambiguousSkus: the rejected keys, for observability.
 * Malformed rows (non-object) fail the WHOLE build (fail closed). Rows with blank/Unassigned brands
 * contribute nothing (rule 4/5).
 */
export function buildBrandMaps(catalogRows) {
  if (!Array.isArray(catalogRows)) {
    throw new Error("buildBrandMaps requires an array of catalog rows (fail closed).");
  }
  const asinBrands = new Map(); // asin -> Set(real brands)
  const skuBrands = new Map();  // sku  -> Set(real brands)
  for (const row of catalogRows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("buildBrandMaps: malformed catalog row; rejecting the whole catalog (fail closed).");
    }
    const brand = realBrand(row.product_brand);
    if (!brand) continue; // blank / "Unassigned" maps nothing (rules 4 + 5)
    const asin = clean(row.child_asin).toUpperCase();
    if (asin) {
      if (!asinBrands.has(asin)) asinBrands.set(asin, new Set());
      asinBrands.get(asin).add(brand);
    }
    const sku = clean(row.sku);
    if (sku) {
      if (!skuBrands.has(sku)) skuBrands.set(sku, new Set());
      skuBrands.get(sku).add(brand);
    }
  }
  const byAsin = new Map();
  const conflictedAsins = [];
  for (const [asin, brands] of asinBrands) {
    if (brands.size === 1) byAsin.set(asin, [...brands][0]);
    else conflictedAsins.push(asin);
  }
  const bySku = new Map();
  const ambiguousSkus = [];
  for (const [sku, brands] of skuBrands) {
    if (brands.size === 1) bySku.set(sku, [...brands][0]);
    else ambiguousSkus.push(sku);
  }
  return Object.freeze({
    byAsin, bySku,
    conflictedAsins: Object.freeze(conflictedAsins.sort()),
    ambiguousSkus: Object.freeze(ambiguousSkus.sort()),
  });
}

/**
 * Resolve one (childAsin, sku) pair against the built maps. Returns { brand, via } where via is
 * "asin" | "sku" | null. The ASIN mapping WINS when present; the unique-SKU fallback fires only when the
 * ASIN does not resolve; anything else stays unmapped (brand null) -- never "Unassigned", never a guess.
 */
export function resolveBrand({ childAsin, sku } = {}, maps) {
  if (!maps || !(maps.byAsin instanceof Map) || !(maps.bySku instanceof Map)) {
    throw new Error("resolveBrand requires the maps built by buildBrandMaps (fail closed).");
  }
  const asin = clean(childAsin).toUpperCase();
  if (asin && maps.byAsin.has(asin)) return { brand: maps.byAsin.get(asin), via: "asin" };
  const skuKey = clean(sku);
  if (skuKey && maps.bySku.has(skuKey)) return { brand: maps.bySku.get(skuKey), via: "sku" };
  return { brand: null, via: null };
}
