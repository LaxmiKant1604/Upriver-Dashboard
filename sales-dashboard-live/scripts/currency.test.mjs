// Unit tests for the shared PURE currency leaf (lib/server/currency.js).
//
// canonicalCurrency: only a trimmed, UPPERCASE ISO-style 3-letter code matches.
// adsCurrencyEvidence: the 4-state classifier the Ads-currency signal AND the TACoS folds both key on.
//
// Run with: npm run test:currency

import assert from "node:assert/strict";
import { canonicalCurrency, adsCurrencyEvidence } from "../lib/server/currency.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}`);
    console.error(error.message);
    process.exitCode = 1;
  }
}

console.log("Currency leaf");

test("canonicalCurrency: only a trimmed UPPERCASE 3-letter code is valid; everything else => null", () => {
  assert.equal(canonicalCurrency("USD"), "USD");
  assert.equal(canonicalCurrency("usd"), "USD", "lowercase normalizes");
  assert.equal(canonicalCurrency("  cad "), "CAD", "surrounding whitespace is trimmed");
  assert.equal(canonicalCurrency("US D"), null, "an embedded space is not a 3-letter code");
  assert.equal(canonicalCurrency("USDX"), null, "4 letters => null");
  assert.equal(canonicalCurrency("US"), null, "2 letters => null");
  assert.equal(canonicalCurrency("US1"), null, "a digit is not a letter");
  assert.equal(canonicalCurrency(""), null);
  assert.equal(canonicalCurrency("   "), null, "whitespace-only => null");
  assert.equal(canonicalCurrency(null), null);
  assert.equal(canonicalCurrency(undefined), null);
});

test("adsCurrencyEvidence: non-array => invalid; empty => empty", () => {
  assert.deepEqual(adsCurrencyEvidence(null), { state: "invalid", currency: null, currencyCount: 0 });
  assert.deepEqual(adsCurrencyEvidence("USD"), { state: "invalid", currency: null, currencyCount: 0 }, "a string is not an array");
  assert.deepEqual(adsCurrencyEvidence([]), { state: "empty", currency: null, currencyCount: 0 });
});

test("adsCurrencyEvidence: exactly one distinct valid canonical currency => single-valid (normalized)", () => {
  assert.deepEqual(adsCurrencyEvidence([{ currency: "USD" }, { currency: "USD" }]), { state: "single-valid", currency: "USD", currencyCount: 1 });
  assert.deepEqual(adsCurrencyEvidence([{ currency: "usd" }, { currency: "USD" }]), { state: "single-valid", currency: "USD", currencyCount: 1 }, "case-canonicalized to one identity");
});

test("adsCurrencyEvidence: ANY blank/absent/malformed row => invalid (fail closed), count = distinct-valid", () => {
  assert.deepEqual(adsCurrencyEvidence([{ currency: "USD" }, { currency: "" }]), { state: "invalid", currency: null, currencyCount: 1 }, "blank row");
  assert.deepEqual(adsCurrencyEvidence([{ currency: "USD" }, { currency: "  " }]), { state: "invalid", currency: null, currencyCount: 1 }, "whitespace-only row");
  assert.deepEqual(adsCurrencyEvidence([{ currency: "USD" }, {}]), { state: "invalid", currency: null, currencyCount: 1 }, "absent currency");
  assert.deepEqual(adsCurrencyEvidence([{ currency: "USD" }, { currency: "US D" }]), { state: "invalid", currency: null, currencyCount: 1 }, "malformed nonblank (space)");
  assert.deepEqual(adsCurrencyEvidence([{ currency: "" }, { currency: "  " }]), { state: "invalid", currency: null, currencyCount: 0 }, "all-blank => invalid, NOT single");
});

test("adsCurrencyEvidence: more than one distinct valid canonical currency => multiple", () => {
  assert.deepEqual(adsCurrencyEvidence([{ currency: "USD" }, { currency: "CAD" }]), { state: "multiple", currency: null, currencyCount: 2 });
  assert.deepEqual(adsCurrencyEvidence([{ currency: "usd" }, { currency: "cad" }, { currency: "USD" }]), { state: "multiple", currency: null, currencyCount: 2 }, "distinct-valid dedupes canonically");
});

console.log(`\n${passed} assertions passed${process.exitCode ? " (with failures above)" : ""}`);
