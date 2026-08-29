// FBA Shipment Plan brand filtering -- pure + testable. Named-brand selection matches on the CANONICAL brand key
// (whitespace-normalized, case-folded, punctuation-significant) and NEVER falls back to All Brands; the "Unmapped"
// option matches only rows with no catalog-proven brand; a catalog-proven brand never appears under Unmapped.

export const UNMAPPED_BRAND = "Unmapped";

// keyFn is the shared canonical brand-key (App.jsx#brandKey, mirroring lib/server/reports/brand-membership.js#brandKey).
export function matchesPlanBrand(rowBrand, selectedBrand, keyFn) {
  if (selectedBrand == null || selectedBrand === "ALL") return true;
  if (selectedBrand === UNMAPPED_BRAND) return !rowBrand; // only rows WITHOUT a proven brand
  const want = keyFn(selectedBrand);
  if (want == null) return true; // a blank named brand degrades to All rather than hiding everything
  return keyFn(rowBrand) === want; // exact canonical match; no fallback to All
}
