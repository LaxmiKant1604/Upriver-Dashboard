// Client brand-scope SELECTOR filter (defense-in-depth) -- pure, offline. Proves the browser can never OFFER a brand
// name outside the user's grant even when a stale/pre-restriction cache contributed it, that the canonical key
// matches the SERVER brandKey exactly (punctuation-distinct isolation preserved), and that admin / ALL_BRANDS are
// byte-identical (null = unrestricted -> list returned unchanged).
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import {
  canonicalBrandKey, permittedBrandKeySetFromGrant, permittedBrandKeySetForAccount, filterBrandNamesToPermitted,
} from "../src/lib/brand-scope-filter.js";
import { brandKey as serverBrandKey } from "../lib/server/reports/brand-membership.js";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

test("canonicalBrandKey mirrors the SERVER brandKey exactly (case/whitespace/punctuation/empty)", () => {
  for (const v of ["Acme", " acme ", "AC ME", "AC\t ME", "Bebi-Born", "Bebi Born", "", "  ", null, undefined, "Shrida Naturals"]) {
    assert.equal(canonicalBrandKey(v), serverBrandKey(v), `mismatch for ${JSON.stringify(v)}`);
  }
  // punctuation-distinct brands stay SEPARATE (no fuzzy merge)
  assert.notEqual(canonicalBrandKey("Bebi-Born"), canonicalBrandKey("Bebi Born"));
  passed += 1;
});

test("permittedBrandKeySetFromGrant: SELECTED_BRANDS -> canonical key set; ALL_BRANDS/none -> null; empty SELECTED -> empty set (never 'all')", () => {
  const sel = permittedBrandKeySetFromGrant({ mode: "SELECTED_BRANDS", brandKeys: ["Acme", "Bebi Born"] });
  assert.ok(sel instanceof Set); assert.deepEqual([...sel].sort(), ["acme", "bebi born"]);
  assert.equal(permittedBrandKeySetFromGrant({ mode: "ALL_BRANDS", brandKeys: null }), null);
  assert.equal(permittedBrandKeySetFromGrant(null), null);
  assert.equal(permittedBrandKeySetFromGrant(undefined), null);
  const empty = permittedBrandKeySetFromGrant({ mode: "SELECTED_BRANDS", brandKeys: [] });
  assert.ok(empty instanceof Set && empty.size === 0, "empty SELECTED_BRANDS is NO brands, never a fall-back to all");
  passed += 1;
});

test("permittedBrandKeySetForAccount: admin -> null (unrestricted); per-account grant lookup", () => {
  const access = { role: "member", accountGrants: { A: { mode: "SELECTED_BRANDS", brandKeys: ["acme"] }, B: { mode: "ALL_BRANDS", brandKeys: null } } };
  assert.deepEqual([...permittedBrandKeySetForAccount(access, "A")], ["acme"]);
  assert.equal(permittedBrandKeySetForAccount(access, "B"), null, "ALL_BRANDS account -> unrestricted");
  assert.equal(permittedBrandKeySetForAccount(access, "C"), null, "no grant row -> unrestricted (account-gated elsewhere)");
  assert.equal(permittedBrandKeySetForAccount({ role: "admin", accountGrants: { A: { mode: "SELECTED_BRANDS", brandKeys: ["acme"] } } }, "A"), null, "admin unrestricted");
  passed += 1;
});

test("AC#1/#2: restricted selector shows ONLY the granted brand; forbidden names are removed (even from a stale cache list)", () => {
  // Simulate a merged selector list that includes a pre-restriction cached forbidden brand.
  const merged = ["Brilliant Kids", "Cleanfect", "Shrida", "Shrida Naturals"];
  const permitted = permittedBrandKeySetForAccount({ role: "member", accountGrants: { A: { mode: "SELECTED_BRANDS", brandKeys: ["Brilliant Kids"] } } }, "A");
  const shown = filterBrandNamesToPermitted(merged, permitted);
  assert.deepEqual(shown, ["Brilliant Kids"], "only the granted brand is offered");
  assert.ok(!shown.includes("Cleanfect"), "forbidden brand ABSENT from the selector");
  passed += 1;
});

test("AC#4: 'All permitted' aggregation offers only granted brands (multiple permitted)", () => {
  const merged = ["Acme", "Bravo", "Charlie", "Delta"];
  const permitted = permittedBrandKeySetFromGrant({ mode: "SELECTED_BRANDS", brandKeys: ["Acme", "Charlie"] });
  assert.deepEqual(filterBrandNamesToPermitted(merged, permitted).sort(), ["Acme", "Charlie"]);
  passed += 1;
});

test("AC#10/#11: admin + ALL_BRANDS are byte-identical (null set -> list returned unchanged, order preserved)", () => {
  const list = ["Zed", "Acme", "mid"];
  assert.deepEqual(filterBrandNamesToPermitted(list, null), list, "unrestricted -> unchanged, original order");
  passed += 1;
});

test("punctuation-distinct brands are isolated in the filter (no fuzzy merge)", () => {
  const permitted = permittedBrandKeySetFromGrant({ mode: "SELECTED_BRANDS", brandKeys: ["Bebi Born"] });
  assert.deepEqual(filterBrandNamesToPermitted(["Bebi Born", "Bebi-Born"], permitted), ["Bebi Born"], "only the exact permitted brand; the punctuation variant is a DIFFERENT brand and stays hidden");
  passed += 1;
});

async function main() {
  out("brand-scope-filter (client selector defense-in-depth)");
  let failures = 0;
  for (const t of tests) {
    try { await t.fn(); out("  ok  " + t.name); }
    catch (e) { failures += 1; out("FAIL  " + t.name); out(String((e && e.stack) || e)); }
  }
  out("\n" + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : ""));
  if (failures) process.exitCode = 1;
}
main();
