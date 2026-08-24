// Scheduler v2 -- CANONICAL BRAND RESOLUTION over the durable Product Catalog (pure, ZERO I/O).
//
// The ONE reviewed brand-mapping policy for the durable source model (Daily Reporting + Brand View first):
//   1. child_asin -> product_brand from the organization-wide catalog;
//   2. when the ASIN does not resolve, SKU -> child_asin (from durable OLI history) -> catalog brand;
//   3. the SKU fallback applies ONLY when the SKU maps to exactly ONE child_asin (unique, non-conflicting) AND
//      that ASIN resolves to exactly one real catalog brand;
//   4. conflicting or blank mappings remain UNMAPPED (fail closed -- never a guess);
//   5. "Unassigned" is NEVER a real catalog brand: a catalog row claiming it is treated as BLANK, and this
//      module never returns it. Presentation layers may LABEL unmapped rows however they wish; the durable
//      model records them as unmapped (brand null).
//
// The SKU->child_asin evidence comes from durable OLI history (each OLI row carries both sku and child_asin),
// NEVER from an unproven catalog `sku` column: Product Catalog 68d2de238e does not support `sku` (DataDoe
// rejects it HTTP 400), so the durable org-wide catalog fetches only child_asin/parent_asin/product_name/
// product_brand. With no OLI rows the SKU index is simply empty (rule 2 never fires) -- correct, never wrong.

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
 * Build the frozen brand maps from organization-wide catalog rows ({ child_asin, product_brand, ... }) and
 * durable OLI history rows ({ childAsin | child_asin, sku, ... }).
 *   byAsin    : child_asin -> brand, ONLY when every real brand seen for that ASIN agrees (a conflict unmaps
 *               the ASIN and records it in conflictedAsins -- never first/last-row-wins);
 *   skuToAsin : sku -> child_asin from OLI, ONLY when that SKU maps to exactly ONE child_asin (else ambiguousSkus);
 *   bySku     : sku -> brand, the COMPOSITION skuToAsin[sku] -> byAsin[asin] (so a SKU resolves ONLY when its
 *               child_asin is unique AND that ASIN resolves to one real brand); ASIN attribution stays first
 *               priority (see resolveBrand);
 *   conflictedAsins / ambiguousSkus: the rejected keys, for observability.
 * Malformed CATALOG rows (non-object) fail the WHOLE build (fail closed). Malformed OLI rows are skipped
 * defensively (durable OLI history is validated upstream). Rows with blank/Unassigned brands contribute
 * nothing (rule 4/5); an empty oliRows simply yields an empty SKU index (rule 2 never fires).
 */
export function buildBrandMaps(catalogRows, oliRows = []) {
  if (!Array.isArray(catalogRows)) {
    throw new Error("buildBrandMaps requires an array of catalog rows (fail closed).");
  }
  const asinBrands = new Map(); // asin -> Set(real brands)
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
  }
  const byAsin = new Map();
  const conflictedAsins = [];
  for (const [asin, brands] of asinBrands) {
    if (brands.size === 1) byAsin.set(asin, [...brands][0]);
    else conflictedAsins.push(asin);
  }

  // SKU -> child_asin evidence from durable OLI history (each OLI row carries sku + child_asin). A SKU seen with
  // MORE THAN ONE distinct child_asin is ambiguous (conflicting) and never resolves.
  const skuAsins = new Map(); // sku -> Set(child_asin)
  for (const row of Array.isArray(oliRows) ? oliRows : []) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const sku = clean(row.sku ?? row.SKU);
    const asin = clean(row.childAsin ?? row.child_asin).toUpperCase();
    if (!sku || !asin) continue;
    if (!skuAsins.has(sku)) skuAsins.set(sku, new Set());
    skuAsins.get(sku).add(asin);
  }
  const skuToAsin = new Map();
  const bySku = new Map();
  const ambiguousSkus = [];
  for (const [sku, asins] of skuAsins) {
    if (asins.size !== 1) { ambiguousSkus.push(sku); continue; } // conflicting SKU->ASIN => never resolves
    const asin = [...asins][0];
    skuToAsin.set(sku, asin);
    if (byAsin.has(asin)) bySku.set(sku, byAsin.get(asin)); // unique SKU->ASIN whose ASIN has one real brand
  }
  return Object.freeze({
    byAsin, bySku, skuToAsin,
    conflictedAsins: Object.freeze(conflictedAsins.sort()),
    ambiguousSkus: Object.freeze(ambiguousSkus.sort()),
  });
}

/**
 * Resolve one (childAsin, sku) pair against the built maps. Returns { brand, via } where via is
 * "asin" | "sku" | null. The ASIN mapping WINS when present; the unique-SKU fallback (bySku = the OLI-derived
 * SKU->child_asin->catalog-brand composition) fires only when the ASIN does not resolve; anything else stays
 * unmapped (brand null) -- never "Unassigned", never a guess.
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
