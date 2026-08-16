// Scheduler v2 -- shared PURE canonical-currency validator + Ads-currency evidence classifier.
//
// A dependency-free leaf: it imports NOTHING (no DataDoe transport, no Supabase, no other module),
// so it is safe to reuse from BOTH the sync signal layer (source-signals.js) AND the transport-free
// derivation graph (lib/server/reports/derivation-core.js) without pulling any forbidden module into
// that graph. The gate (report-source-contracts.js) and the TACoS denominator (ppc.js /
// derivation-core.js) therefore agree BY CONSTRUCTION about what a trustworthy Ads currency is.

// A canonical currency is a TRIMMED, UPPERCASE ISO-style 3-letter code. Anything else -> null.
//   "usd" -> "USD" (valid, normalized)   "US D" -> null (space)   "USDX" -> null (4 letters)
//   ""    -> null                        "  "   -> null           null    -> null
export function canonicalCurrency(value) {
  const c = String(value ?? "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : null;
}

// 4-state Ads-currency evidence, shared by the signal AND the report folds. Each row's currency is
// read from row.currency. Rules, IN ORDER:
//   not an array -> "invalid"
//   length 0     -> "empty"
//   ANY row whose currency is blank/absent OR fails canonicalCurrency (malformed) -> "invalid"
//   exactly 1 distinct VALID canonical currency -> "single-valid" (currency = that code)
//   > 1 distinct VALID canonical currencies      -> "multiple"
// currencyCount is ALWAYS the number of distinct VALID canonical currencies observed (for back-compat
// with the signal's currencyCount field); the gate keys on `state`, never on the count.
export function adsCurrencyEvidence(rows) {
  if (!Array.isArray(rows)) return { state: "invalid", currency: null, currencyCount: 0 };
  if (rows.length === 0) return { state: "empty", currency: null, currencyCount: 0 };
  const valid = new Set();
  let malformed = false;
  for (const row of rows) {
    const c = canonicalCurrency(row && row.currency);
    if (c === null) malformed = true;
    else valid.add(c);
  }
  if (malformed) return { state: "invalid", currency: null, currencyCount: valid.size };
  if (valid.size === 1) return { state: "single-valid", currency: [...valid][0], currencyCount: 1 };
  return { state: "multiple", currency: null, currencyCount: valid.size };
}
