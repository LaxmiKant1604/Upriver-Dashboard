// REPORT CAPABILITY REGISTRY coverage (fail-closed). Scans the REAL api/datadoe.js for every report action it serves
// (the ACCOUNT_SCOPED_ACTIONS set + the multi-account brand actions) and asserts each is registered in
// REPORT_CAPABILITIES. A future report route that forgets to register a capability makes this test FAIL -- so no
// route can ship brand-accessible (or silently account-wide) without an explicit, reviewed capability decision.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { REPORT_CAPABILITIES, CAPABILITY, isBrandAccessible } from "../lib/server/report-authorization.js";

let passed = 0;
const out = (s) => { try { process.stdout.write(s + "\n"); } catch (_e) { /* ignore */ } };
const test = (name, fn) => { try { fn(); passed += 1; out("  ok  " + name); } catch (e) { out("FAIL  " + name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; } };

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(path.join(root, "api", "datadoe.js"), "utf8");

// Extract the ACCOUNT_SCOPED_ACTIONS set literal + the multi-account brand actions handled by their own branches.
function accountScopedActions() {
  const m = src.match(/const ACCOUNT_SCOPED_ACTIONS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(m, "found the ACCOUNT_SCOPED_ACTIONS literal");
  return [...m[1].matchAll(/"([a-z0-9-]+)"/g)].map((x) => x[1]);
}
// Multi-account brand actions are not in the set; they have dedicated handlers.
const MULTI_ACCOUNT_BRAND_ACTIONS = ["brand-portfolio", "brand-view-portfolio", "brand-directory"];

test("33. every account-scoped report action is registered in the capability registry", () => {
  const actions = accountScopedActions();
  assert.ok(actions.length >= 15, `parsed a realistic action set (${actions.length})`);
  for (const a of actions) {
    assert.ok(a in REPORT_CAPABILITIES, `action '${a}' MUST be registered in REPORT_CAPABILITIES (fail closed)`);
  }
});

test("33b. every multi-account Brand View action is registered", () => {
  for (const a of MULTI_ACCOUNT_BRAND_ACTIONS) assert.ok(a in REPORT_CAPABILITIES, `'${a}' registered`);
});

test("34. no report action is BOTH brand-accessible AND account-wide-only (capabilities are exclusive + intentional)", () => {
  for (const [a, cap] of Object.entries(REPORT_CAPABILITIES)) {
    assert.ok(Object.values(CAPABILITY).includes(cap), `'${a}' has a real capability`);
  }
});

test("34b. the account-wide reports that MUST deny a brand-restricted user are denied (not silently brand-accessible)", () => {
  // These carry account-wide payloads with no reviewed per-brand server projection -> must be DENY.
  const mustDeny = ["reconciliation", "sku-pl", "keyword-rank", "content-changes", "fba-plan", "brand-inventory", "sales",
    "sales-movers", "listing-health", "buy-box-loss", "returns-leakage", "ppc-performance", "listing-optimizer", "oli-quality-summary"];
  for (const a of mustDeny) {
    assert.equal(REPORT_CAPABILITIES[a], CAPABILITY.DENY_FOR_BRAND_RESTRICTED_USERS, `'${a}' must DENY for brand-restricted users`);
    assert.equal(isBrandAccessible(REPORT_CAPABILITIES[a]), false);
  }
});

test("34c. the brand-projected reports are exactly the reviewed set (Dashboard/SKU Movement/Daily/Brand View/oli-quality)", () => {
  const accessible = Object.entries(REPORT_CAPABILITIES).filter(([, c]) => isBrandAccessible(c)).map(([a]) => a).sort();
  assert.deepEqual(accessible, [
    "brand-directory", "brand-portfolio", "brand-sales", "brand-view", "brand-view-brands", "brand-view-portfolio",
    "daily", "oli-quality", "sku-movement",
  ], "the brand-accessible set is exactly the reviewed reports");
});

out("\n" + passed + " assertions passed");
