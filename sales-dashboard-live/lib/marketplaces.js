// Marketplace metadata shared by the browser and server. An Amazon account is
// always viewed in its marketplace's local business day; money is never
// converted between these currencies.

const MARKETPLACES = {
  IN: { name: "India", currency: "INR", locale: "en-IN", timeZone: "Asia/Kolkata" },
  US: { name: "United States", currency: "USD", locale: "en-US", timeZone: "America/New_York" },
  CA: { name: "Canada", currency: "CAD", locale: "en-CA", timeZone: "America/Toronto" },
  AU: { name: "Australia", currency: "AUD", locale: "en-AU", timeZone: "Australia/Sydney" },
  GB: { name: "United Kingdom", currency: "GBP", locale: "en-GB", timeZone: "Europe/London" },
  UK: { name: "United Kingdom", currency: "GBP", locale: "en-GB", timeZone: "Europe/London" },
  DE: { name: "Germany", currency: "EUR", locale: "de-DE", timeZone: "Europe/Berlin" },
  FR: { name: "France", currency: "EUR", locale: "fr-FR", timeZone: "Europe/Paris" },
  IT: { name: "Italy", currency: "EUR", locale: "it-IT", timeZone: "Europe/Rome" },
  ES: { name: "Spain", currency: "EUR", locale: "es-ES", timeZone: "Europe/Madrid" },
  NL: { name: "Netherlands", currency: "EUR", locale: "nl-NL", timeZone: "Europe/Amsterdam" },
  BE: { name: "Belgium", currency: "EUR", locale: "nl-BE", timeZone: "Europe/Brussels" },
  IE: { name: "Ireland", currency: "EUR", locale: "en-IE", timeZone: "Europe/Dublin" },
  PL: { name: "Poland", currency: "PLN", locale: "pl-PL", timeZone: "Europe/Warsaw" },
  SE: { name: "Sweden", currency: "SEK", locale: "sv-SE", timeZone: "Europe/Stockholm" },
  TR: { name: "Turkey", currency: "TRY", locale: "tr-TR", timeZone: "Europe/Istanbul" },
  AE: { name: "United Arab Emirates", currency: "AED", locale: "en-AE", timeZone: "Asia/Dubai" },
  SA: { name: "Saudi Arabia", currency: "SAR", locale: "en-SA", timeZone: "Asia/Riyadh" },
  JP: { name: "Japan", currency: "JPY", locale: "ja-JP", timeZone: "Asia/Tokyo" },
  MX: { name: "Mexico", currency: "MXN", locale: "es-MX", timeZone: "America/Mexico_City" },
  BR: { name: "Brazil", currency: "BRL", locale: "pt-BR", timeZone: "America/Sao_Paulo" },
  SG: { name: "Singapore", currency: "SGD", locale: "en-SG", timeZone: "Asia/Singapore" },
  EG: { name: "Egypt", currency: "EGP", locale: "en-US", timeZone: "Africa/Cairo" },
};

const CURRENCY_DEFAULTS = {
  INR: { locale: "en-IN" }, USD: { locale: "en-US" }, CAD: { locale: "en-CA" },
  AUD: { locale: "en-AU" }, GBP: { locale: "en-GB" }, EUR: { locale: "en-IE" },
  PLN: { locale: "pl-PL" }, SEK: { locale: "sv-SE" }, TRY: { locale: "tr-TR" },
  AED: { locale: "en-AE" }, SAR: { locale: "en-SA" }, JPY: { locale: "ja-JP" },
  MXN: { locale: "es-MX" }, BRL: { locale: "pt-BR" }, SGD: { locale: "en-SG" },
  EGP: { locale: "en-US" },
};

const FALLBACK = { name: "Marketplace", currency: null, locale: "en-US", timeZone: "UTC" };

export function marketplaceProfile(country, currency) {
  const countryCode = String(country || "").trim().toUpperCase();
  const configured = MARKETPLACES[countryCode] || null;
  const currencyCode = String(currency || configured?.currency || "").trim().toUpperCase() || null;
  const currencyDefaults = CURRENCY_DEFAULTS[currencyCode] || FALLBACK;
  return {
    country: countryCode || null,
    countryName: configured?.name || FALLBACK.name,
    currency: currencyCode,
    locale: configured?.locale || currencyDefaults.locale,
    timeZone: configured?.timeZone || FALLBACK.timeZone,
  };
}

// Date-only API windows must use the marketplace's business day, not the
// viewer's browser timezone. This prevents accidental future-date requests.
export function marketplaceToday(country, now = new Date()) {
  const { timeZone } = marketplaceProfile(country);
  const values = {};
  for (const part of new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now)) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  return `${values.year}-${values.month}-${values.day}`;
}
