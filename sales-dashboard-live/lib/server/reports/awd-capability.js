// AWD (Amazon Warehousing & Distribution) marketplace CAPABILITY -- the single, explicit rule for which marketplaces
// expose Amazon AWD inventory via the DataDoe "Listings" source (id ba689c05d7, requestKey fba-plan:awd). This
// GENERALIZES the former US-only gate WITHOUT changing US behavior: awdCapableMarketplace("US") is true exactly as the
// old `country === "US"` check was, and US remains a HARD requirement (a missing AWD source still blocks a US snapshot,
// preserving last-known-good).
//
// SCOPE: Amazon offers AWD in the US and the European "EU5" marketplaces -- United Kingdom, Germany, France, Italy,
// Spain. It is NOT offered in Australia (EXPLICITLY excluded from this expansion), Canada, India, or the smaller
// European marketplaces (Netherlands, Belgium, Ireland, Poland, Sweden, Austria), which carry no AWD warehousing. A
// marketplace not in this set is NEVER fetched for AWD and NEVER renders an AWD value -- its AWD stays honestly
// unavailable, never a fabricated zero. UK and GB are the same marketplace: the account directory calls it "UK", while
// Amazon's rows (marketplace_country_code) call it "GB"; both canonicalize to GB here.
//
// EVIDENCE (zero-token, 2026-09-03): proven against the trusted account_directory + DataDoe GET /exports/sources -- the
// Listings source is compatible for the connected US + EU5 seller-central accounts; AU + the smaller EU marketplaces
// are excluded. Adding a marketplace here requires the SAME proof (Amazon AWD availability + Listings source
// compatibility), never an assumption. Never combine or attribute one marketplace's AWD to another.

const S = (v) => String(v == null ? "" : v).trim().toUpperCase();

// UK <-> GB are ONE marketplace; Amazon's AWD rows carry "GB". Every other code already matches the account directory.
export function canonicalAwdMarketplace(marketplace) { const m = S(marketplace); return m === "UK" ? "GB" : m; }

// The CANONICAL marketplace codes where Amazon AWD is offered AND the DataDoe Listings source exposes AWD fields.
export const AWD_CAPABLE_MARKETPLACES = Object.freeze(["US", "GB", "DE", "FR", "IT", "ES"]);
const CAPABLE_SET = new Set(AWD_CAPABLE_MARKETPLACES);

// The RAW account-directory country codes the source contract's `marketplaceCountries` gate matches against. It carries
// BOTH "UK" and "GB" so the gate accepts either code space (the account directory uses "UK"; Amazon rows use "GB").
export const AWD_CONTRACT_COUNTRIES = Object.freeze(["US", "GB", "UK", "DE", "FR", "IT", "ES"]);

// Is this marketplace AWD-capable? (US byte-identical to the former `country === "US"`.) Accepts either UK or GB.
export function awdCapableMarketplace(marketplace) { return CAPABLE_SET.has(canonicalAwdMarketplace(marketplace)); }

// Is AWD a HARD requirement for this marketplace (a missing/failed AWD source BLOCKS the snapshot -> last-known-good
// preserved)? US ONLY -- preserved EXACTLY. Europe AWD is best-effort: a missing/failed source leaves AWD honestly
// unavailable and NEVER blocks the FBA plan (mission: a failed Europe AWD fetch must not blank the plan).
export function awdRequiredForMarketplace(marketplace) { return canonicalAwdMarketplace(marketplace) === "US"; }
