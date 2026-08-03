// Server-side exchange-rate service for the account-scoped Brand View.
//
// DESIGN RULES (all of these are correctness rules, not preferences):
//
//  1. There are NO static FX multipliers anywhere in this file. If a rate is
//     missing for a currency the caller needs, the conversion returns null and
//     the UI must render an explicit "unavailable" state. A wrong rate is worse
//     than a visible gap.
//  2. A browser never calls the exchange-rate provider. It calls our API, which
//     reads the saved table in Supabase.
//  3. The provider is called at most once per FX_MIN_REFRESH_HOURS, and only
//     when the provider's own published "next update" time has passed. Clicking
//     Refresh does not bypass that: the provider publishes daily, so a second
//     fetch inside the same cycle would return identical numbers and only spend
//     rate limit.
//  4. If the provider fails, the newest cached table is served with
//     `fallback: true` so the UI can say so. If nothing has ever been cached,
//     the response is `unavailable` — never a guessed rate.
//
// PROVIDER / LICENCE
//   ExchangeRate-API "Open Access" endpoint: https://open.er-api.com/v6/latest/USD
//   Documentation: https://www.exchangerate-api.com/docs/free
//   Terms:         https://www.exchangerate-api.com/terms
//   - No API key required for the open endpoint.
//   - Updates once per day; the response carries `time_last_update_utc` and
//     `time_next_update_utc`, which this module honours directly.
//   - The terms permit caching (which is what this module does) and require
//     attribution. The Brand View footer and every export carry the required
//     "Rates by Exchange Rate API" credit — see src/views/BrandView.jsx.
//   - Redistribution of the rate table is not permitted, which is why the
//     Supabase table has RLS enabled with no browser-readable policy.
//   An optional paid key is supported without any code change: set
//   EXCHANGERATE_API_KEY server-side and the keyed v6 endpoint is used instead.
//   The key is read from process.env only and is never returned to a client.

import { claimRefreshLock, getLatestFxSnapshot, isSupabaseConfigured, releaseRefreshLock, saveFxSnapshot } from "./supabase.js";

// Every rate is stored against one base so a cross rate is always derived from
// two numbers taken from the same provider observation. Mixing observations
// would make totals fail to reconcile.
export const FX_BASE_CURRENCY = "USD";

export const FX_PROVIDER_OPEN = "exchangerate-api-open";
export const FX_PROVIDER_KEYED = "exchangerate-api-v6";
export const FX_PROVIDER_ATTRIBUTION = "Rates by Exchange Rate API (exchangerate-api.com)";

// Minimum spacing between two provider calls. The provider publishes once a
// day, so this is deliberately at the low end of the 12-24 hour target.
export const FX_MIN_REFRESH_HOURS = 12;
// Used only when the provider did not publish a next-update time.
export const FX_ASSUMED_CYCLE_HOURS = 24;
// Beyond this the saved table is still served, but labelled as older than one
// provider cycle so nobody reads a converted total as today's number.
export const FX_STALE_AFTER_HOURS = 26;

const FX_LOCK_REPORT_KEY = "fx-rates";
const FX_LOCK_ACCOUNT_ID = "__fx-rates__";
const FX_LOCK_SECONDS = 60;

/** The display currencies the Brand View currency selector offers. */
export const FX_DISPLAY_CURRENCIES = ["USD", "EUR", "GBP", "INR", "CAD", "AUD", "JPY", "AED"];

function hoursBetween(laterIso, earlierIso) {
  const later = Date.parse(laterIso);
  const earlier = Date.parse(earlierIso);
  if (!Number.isFinite(later) || !Number.isFinite(earlier)) return null;
  return (later - earlier) / 3600000;
}

/**
 * Should the provider be called right now?
 *
 * Pure so the rate-limit policy is unit-testable without any network or
 * database access. `nowIso` is passed in for the same reason.
 */
export function fxCacheDecision({ cached, nowIso }) {
  if (!cached || !cached.rates) {
    return { shouldFetch: true, reason: "no-cached-rates", ageHours: null, stale: true };
  }
  const ageHours = hoursBetween(nowIso, cached.fetched_at);
  // An unparseable timestamp must not be treated as "fresh".
  if (ageHours === null) return { shouldFetch: true, reason: "unknown-cache-age", ageHours: null, stale: true };

  const nextUpdate = cached.provider_next_update_at ? Date.parse(cached.provider_next_update_at) : NaN;
  const providerDue = Number.isFinite(nextUpdate)
    ? Date.parse(nowIso) >= nextUpdate
    : ageHours >= FX_ASSUMED_CYCLE_HOURS;

  return {
    // Both conditions must hold: the provider says a new table exists AND we
    // have waited at least the minimum spacing.
    shouldFetch: providerDue && ageHours >= FX_MIN_REFRESH_HOURS,
    reason: providerDue ? "provider-cycle-elapsed" : "within-provider-cycle",
    ageHours,
    stale: ageHours > FX_STALE_AFTER_HOURS,
  };
}

/**
 * Normalise a provider response into `{ rates, providerUpdatedAt, providerNextUpdateAt, rateDate }`.
 *
 * Rejects anything that is not a usable table rather than saving a partial one:
 * a half-populated rate table would silently make some countries unavailable
 * and others convertible, which reads as a data bug rather than a source gap.
 */
export function fxRatesFromProviderPayload(body, { baseCurrency = FX_BASE_CURRENCY } = {}) {
  const raw = body?.rates || body?.conversion_rates;
  if (!raw || typeof raw !== "object") {
    throw new Error("The exchange-rate provider returned no rate table.");
  }
  const rates = {};
  for (const [code, value] of Object.entries(raw)) {
    if (!/^[A-Z]{3}$/.test(code)) continue;
    const rate = Number(value);
    if (!Number.isFinite(rate) || rate <= 0) continue;
    rates[code] = rate;
  }
  if (Math.abs((rates[baseCurrency] || 0) - 1) > 1e-9) {
    throw new Error(`The exchange-rate provider did not return ${baseCurrency} as its base currency.`);
  }
  // Refuse a table that cannot serve the currencies this dashboard offers.
  const missing = FX_DISPLAY_CURRENCIES.filter((code) => !rates[code]);
  if (missing.length) {
    throw new Error(`The exchange-rate provider is missing required currencies: ${missing.join(", ")}.`);
  }

  const providerUpdatedAt = isoOrNull(body?.time_last_update_utc) || isoOrNull(body?.time_last_update_unix, true);
  const providerNextUpdateAt = isoOrNull(body?.time_next_update_utc) || isoOrNull(body?.time_next_update_unix, true);
  return {
    rates,
    providerUpdatedAt,
    providerNextUpdateAt,
    // The rate date is the provider's own publication date, not our fetch date,
    // so re-fetching the same table twice does not create two rows.
    rateDate: (providerUpdatedAt || new Date().toISOString()).slice(0, 10),
  };
}

function isoOrNull(value, isUnixSeconds = false) {
  if (value === null || value === undefined || value === "") return null;
  if (isUnixSeconds) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return new Date(seconds * 1000).toISOString();
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function providerRequest() {
  const key = String(process.env.EXCHANGERATE_API_KEY || "").trim();
  if (key) {
    return {
      provider: FX_PROVIDER_KEYED,
      // The key stays in the server environment. It is never logged and never
      // included in a response body.
      url: `https://v6.exchangerate-api.com/v6/${encodeURIComponent(key)}/latest/${FX_BASE_CURRENCY}`,
    };
  }
  return { provider: FX_PROVIDER_OPEN, url: `https://open.er-api.com/v6/latest/${FX_BASE_CURRENCY}` };
}

async function fetchProviderRates() {
  const { provider, url } = providerRequest();
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    // Deliberately does not include the URL: for the keyed endpoint that string
    // contains the API key.
    throw new Error(`The exchange-rate provider returned HTTP ${response.status}.`);
  }
  const body = await response.json().catch(() => null);
  if (body?.result && body.result !== "success") {
    throw new Error(`The exchange-rate provider reported: ${body["error-type"] || body.result}.`);
  }
  return { provider, ...fxRatesFromProviderPayload(body) };
}

function presentSnapshot(cached, extra = {}) {
  return {
    base: cached.base_currency,
    rates: cached.rates,
    provider: cached.provider,
    rateDate: cached.rate_date,
    providerUpdatedAt: cached.provider_updated_at || null,
    providerNextUpdateAt: cached.provider_next_update_at || null,
    fetchedAt: cached.fetched_at,
    attribution: FX_PROVIDER_ATTRIBUTION,
    ...extra,
  };
}

/**
 * The one entry point. Returns a rate table plus everything the UI needs to
 * label its freshness honestly.
 *
 * Shape: { base, rates, provider, rateDate, providerUpdatedAt, fetchedAt,
 *          source: "cache" | "provider", stale, fallback, unavailable, message }
 */
export async function getFxRates({ nowIso = new Date().toISOString() } = {}) {
  if (!isSupabaseConfigured()) {
    return {
      unavailable: true,
      attribution: FX_PROVIDER_ATTRIBUTION,
      message: "Currency conversion is unavailable because this deployment has no Supabase exchange-rate cache configured. Original marketplace currency remains available.",
    };
  }

  const cached = await getLatestFxSnapshot(FX_BASE_CURRENCY).catch(() => null);
  const decision = fxCacheDecision({ cached, nowIso });

  if (!decision.shouldFetch && cached) {
    return presentSnapshot(cached, { source: "cache", stale: decision.stale, ageHours: decision.ageHours });
  }

  // Only one serverless instance may call the provider for a given cycle.
  const locked = await claimRefreshLock({
    reportKey: FX_LOCK_REPORT_KEY,
    accountId: FX_LOCK_ACCOUNT_ID,
    paramsHash: FX_BASE_CURRENCY,
    lockSeconds: FX_LOCK_SECONDS,
  }).catch(() => false);

  if (!locked) {
    // Another request is already fetching. Serving the cached table is correct;
    // returning an error because a colleague got the lock would not be.
    if (cached) {
      return presentSnapshot(cached, {
        source: "cache",
        stale: decision.stale,
        ageHours: decision.ageHours,
        message: "Newer exchange rates are being fetched by another request. These are the rates saved before that started.",
      });
    }
    return {
      unavailable: true,
      attribution: FX_PROVIDER_ATTRIBUTION,
      message: "Exchange rates are being fetched for the first time. Try again in a moment, or use Original marketplace currency.",
    };
  }

  try {
    const fresh = await fetchProviderRates();
    const saved = await saveFxSnapshot({
      baseCurrency: FX_BASE_CURRENCY,
      rateDate: fresh.rateDate,
      provider: fresh.provider,
      rates: fresh.rates,
      providerUpdatedAt: fresh.providerUpdatedAt,
      providerNextUpdateAt: fresh.providerNextUpdateAt,
      fetchedAt: nowIso,
    });
    return presentSnapshot(saved || {
      base_currency: FX_BASE_CURRENCY,
      rate_date: fresh.rateDate,
      provider: fresh.provider,
      rates: fresh.rates,
      provider_updated_at: fresh.providerUpdatedAt,
      provider_next_update_at: fresh.providerNextUpdateAt,
      fetched_at: nowIso,
    }, { source: "provider", stale: false, ageHours: 0 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (cached) {
      return presentSnapshot(cached, {
        source: "cache",
        fallback: true,
        stale: decision.stale,
        ageHours: decision.ageHours,
        message: `Live exchange rates could not be fetched (${detail}). Showing the last rates saved in Supabase.`,
      });
    }
    return {
      unavailable: true,
      attribution: FX_PROVIDER_ATTRIBUTION,
      message: `Exchange rates are unavailable and none have been cached yet (${detail}). Switch to Original marketplace currency to keep using this report.`,
    };
  } finally {
    await releaseRefreshLock({
      reportKey: FX_LOCK_REPORT_KEY,
      accountId: FX_LOCK_ACCOUNT_ID,
      paramsHash: FX_BASE_CURRENCY,
    }).catch(() => {});
  }
}
