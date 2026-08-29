// FBA Shipment Plan brand filtering -- pure regressions. Proves: All shows everything; a named brand shows ONLY its
// canonical-key matches (whitespace/case normalized, punctuation significant) and NEVER falls back to All; Unmapped
// shows only rows with no proven brand; a proven brand never appears under Unmapped. 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { matchesPlanBrand, UNMAPPED_BRAND } from "../src/lib/plan-brand.js";

// Mirror App.jsx#brandKey / lib/server/reports/brand-membership.js#brandKey.
const brandKey = (v) => { const t = String(v == null ? "" : v).trim().replace(/\s+/g, " ").toLowerCase(); return t || null; };
const m = (rowBrand, sel) => matchesPlanBrand(rowBrand, sel, brandKey);

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("All Brands shows every row (mapped + unmapped)", () => {
  assert.equal(m("Acme", "ALL"), true);
  assert.equal(m(null, "ALL"), true);
  assert.equal(m("", "ALL"), true);
});

test("a named brand matches ONLY that brand and never falls back to All", () => {
  assert.equal(m("Acme", "Acme"), true);
  assert.equal(m("Beta", "Acme"), false, "other brand hidden");
  assert.equal(m(null, "Acme"), false, "unmapped row hidden under a named brand");
  assert.equal(m("", "Acme"), false);
});

test("named-brand matching uses the canonical key (case + interior whitespace); punctuation stays significant", () => {
  assert.equal(m("acme  labs", "Acme Labs"), true, "case + collapsed whitespace match");
  assert.equal(m(" Acme Labs ", "acme labs"), true);
  assert.equal(m("Acme-Labs", "Acme Labs"), false, "punctuation is significant -- distinct brands stay separate");
});

test("Unmapped shows ONLY rows with no proven brand; a proven brand never appears under Unmapped", () => {
  assert.equal(m(null, UNMAPPED_BRAND), true);
  assert.equal(m("", UNMAPPED_BRAND), true);
  assert.equal(m("Acme", UNMAPPED_BRAND), false, "a catalog-proven brand is never Unmapped");
});

test("a blank named brand degrades to All rather than hiding everything", () => {
  assert.equal(m("Acme", "   "), true);
});

let failures = 0;
for (const t of tests) {
  try { t.fn(); passed += 1; out("  ok  " + t.name); }
  catch (e) { failures += 1; out("FAIL  " + t.name); out(String((e && e.stack) || e)); }
}
out("\n" + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : ""));
if (failures) process.exitCode = 1;
