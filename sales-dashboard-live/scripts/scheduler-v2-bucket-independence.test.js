// SCHEDULER V2 -- INDEPENDENT PER-BUCKET PUBLISH regression suite (Phase 8). Deterministic + OFFLINE (no network,
// no DB, no real .env.local). Proves the two buckets publish independently, neither blocks nor mutates the other,
// each publishes honestly at its OWN effectivePublishAsOf (bounded 2-day settlement tail; interior gap / lag>2 fail
// closed), the shared Catalog is created at most once and reused, Brand View membership combines both buckets, all
// failure paths safe-close, and Campaign Ads / FBA never publish. Order-ID capture + the shared manual OLI
// persistence path stay intact. Composes the SAME production functions the scheduler + release runner compose.

import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// supabase.js is pulled transitively by the release/control modules; give it harmless dummy env so the import
// never throws (every test is pure -- nothing here makes a real request).
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.VITE_SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "dummy-service-role-key";
process.env.POSTGRES_URL = process.env.POSTGRES_URL || "postgres://user:pass@localhost:5432/db";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = resolve(HERE, "..", "..", ".github", "workflows", "scheduler-v2.yml");
const RELEASE_DIR = resolve(HERE, "release");

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const group = (label) => tests.push({ marker: label });

async function main() {
  const { runPriorityDashboardsRelease } = await import("../lib/server/sync/source-priority-release-runner.js");
  const { resolveEffectivePublishAsOf, MAX_PUBLISH_TAIL_LAG_DAYS } = await import("../lib/server/sync/source-durable-model.js");
  const { assessBucketPublishReadiness } = await import("../lib/server/sync/source-scheduled-prerequisites.js");
  const { makeDurableCatalogGuard, PRIORITY_DASHBOARDS } = await import("../lib/server/sync/source-priority-dashboards.js");
  const { SCHEDULED_ENABLED_SOURCE_KEYS } = await import("../lib/server/sync/source-scheduled-oli.js");
  const { PRIORITY_DISPATCH_ENABLED, PRIORITY_PROMOTED_ENABLED } = await import("../lib/server/sync/source-priority-control-package.js");
  const { buildBrandAccountMembership, accountsForBrand } = await import("../lib/server/reports/brand-membership.js");
  const { classifyOliDimensionalRow, canonicalizeOrderId } = await import("../lib/server/sync/oli-order-rules.js");

  const yml = readFileSync(WORKFLOW, "utf8");

  const THREE = ["daily-reporting", "brand-sales", "brand-inventory"];
  const idResults = (a, disp) => THREE.map((rk) => ({ reportKey: rk, disposition: disp, liveReportKey: rk, paramsHash: "ph_" + rk + "_" + a }));
  const NONUS = Array.from({ length: 22 }, (_, i) => "N" + String(i + 1).padStart(2, "0"));
  const US = Array.from({ length: 8 }, (_, i) => "U" + String(i + 1).padStart(2, "0"));
  const accountsFor = (b) => (b === "us" ? US : NONUS);
  const completeRollup = (n) => ({ rollup: { stopped: false, derived: { skipped: null, daily: { ready: true, saved: n }, brandView: { ready: true, saved: n }, brandInventory: { saved: n }, lineage: Array.from({ length: 3 * n }, (_, i) => i), effectivePublishAsOf: "2026-08-25", refreshAsOf: "2026-08-26", asOfClamped: true } } });

  // A release fake that RECORDS which buckets/accounts each phase touched and writes into an injected LKG map (the
  // only "publish" side effect), so a run can be proven to touch EXACTLY one bucket's accounts and nothing else.
  function trackedRelease(lkg, calls, over = {}) {
    return {
      publishOrder: THREE, reportKeys: THREE,
      deriveBucket: over.deriveBucket || (async (b) => { calls.derive.push(b); return completeRollup(accountsFor(b).length); }),
      finalizeBucket: over.finalizeBucket || (async (b) => { calls.finalize.push(b); return { disposition: "finalized", cycleStatus: "succeeded", accounts: accountsFor(b) }; }),
      preflightAccount: over.preflightAccount || (async (a) => ({ accountId: a, results: idResults(a, "ready") })),
      publishAccount: over.publishAccount || (async (a) => { calls.publish.push(a); lkg[a] = (lkg[a] || 0) + 1; return { accountId: a, results: idResults(a, "published") }; }),
      catalogReservation: over.catalogReservation || (async () => ({ tokensSpent: 2, status: "created" })),
    };
  }
  const deps = (bucket, rel, over = {}) => ({ release: rel, reconcile: over.reconcile || (async () => ({ ok: true })), readbackLive: over.readbackLive || (async () => ({ ok: true })), assertNoCron: over.assertNoCron || (async () => ({ ok: true })), bucket });

  /* ============ 1-6: bucket independence via the strict runner ============ */
  group("bucket independence (runner is scoped to exactly one bucket)");

  test("1. Non-US publishes 22x3 WITHOUT waiting for or touching US", async () => {
    const lkg = {}, calls = { derive: [], finalize: [], publish: [] };
    const r = await runPriorityDashboardsRelease(deps("non-us", trackedRelease(lkg, calls)));
    assert.equal(r.code, 0); assert.equal(r.ok, true);
    assert.equal(r.evidence.accounts, 22); assert.equal(r.evidence.published, 66, "22 accounts x 3 reports");
    assert.deepEqual(calls.derive, ["non-us"], "derived ONLY non-us");
    assert.deepEqual(calls.finalize, ["non-us"], "finalized ONLY non-us");
    assert.equal(calls.publish.length, 22);
    assert.ok(calls.publish.every((a) => NONUS.includes(a)) && calls.publish.every((a) => !US.includes(a)), "published only Non-US accounts");
    assert.equal(r.evidence.bucket, "non-us");
  });

  test("2. US publishes 8x3 WITHOUT requiring the same-day Non-US run + without touching Non-US", async () => {
    const lkg = {}, calls = { derive: [], finalize: [], publish: [] };
    const r = await runPriorityDashboardsRelease(deps("us", trackedRelease(lkg, calls)));
    assert.equal(r.code, 0); assert.equal(r.evidence.accounts, 8); assert.equal(r.evidence.published, 24);
    assert.deepEqual(calls.derive, ["us"]); assert.deepEqual(calls.finalize, ["us"]);
    assert.ok(calls.publish.every((a) => US.includes(a)) && calls.publish.every((a) => !NONUS.includes(a)));
  });

  test("3. a Non-US FAILURE (even at the last step) leaves every US LKG snapshot byte-identical", async () => {
    const lkg = {}; US.forEach((a) => { lkg[a] = "us-lkg-" + a; });
    const calls = { derive: [], finalize: [], publish: [] };
    const r = await runPriorityDashboardsRelease(deps("non-us", trackedRelease(lkg, calls), { readbackLive: async () => ({ ok: false, reason: "x" }) }));
    assert.equal(r.code, 1); assert.equal(r.stage, "readback");
    US.forEach((a) => assert.equal(lkg[a], "us-lkg-" + a, "US LKG untouched by a Non-US failure"));
    assert.ok(calls.publish.every((a) => !US.includes(a)), "no US account was written during a Non-US run");
  });

  test("4. a US FAILURE leaves the morning Non-US publication byte-identical", async () => {
    const lkg = {}; NONUS.forEach((a) => { lkg[a] = "nonus-lkg-" + a; });
    const calls = { derive: [], finalize: [], publish: [] };
    const r = await runPriorityDashboardsRelease(deps("us", trackedRelease(lkg, calls), { readbackLive: async () => ({ ok: false, reason: "x" }) }));
    assert.equal(r.code, 1);
    NONUS.forEach((a) => assert.equal(lkg[a], "nonus-lkg-" + a, "Non-US LKG untouched by a US failure"));
    assert.ok(calls.publish.every((a) => !NONUS.includes(a)));
  });

  test("5. NO cross-bucket account is ever published (a Non-US run never derives/finalizes/publishes US)", async () => {
    const lkg = {}, calls = { derive: [], finalize: [], publish: [] };
    await runPriorityDashboardsRelease(deps("non-us", trackedRelease(lkg, calls)));
    assert.ok(!calls.derive.includes("us") && !calls.finalize.includes("us"), "US bucket never entered");
    assert.equal(new Set(calls.publish).size, 22, "exactly the 22 distinct Non-US accounts, no extras");
  });

  test("6. a within-bucket preflight failure on ONE account => ZERO live writes (all-or-nothing per bucket)", async () => {
    const lkg = {}, calls = { derive: [], finalize: [], publish: [] };
    const rel = trackedRelease(lkg, calls, {
      preflightAccount: async (a) => (a === NONUS[7]
        ? { accountId: a, results: [{ reportKey: "daily-reporting", disposition: "report-disabled", liveReportKey: "daily-reporting", paramsHash: "p" }, { reportKey: "brand-sales", disposition: "ready", liveReportKey: "brand-sales", paramsHash: "p" }, { reportKey: "brand-inventory", disposition: "ready", liveReportKey: "brand-inventory", paramsHash: "p" }] }
        : { accountId: a, results: idResults(a, "ready") }),
    });
    const r = await runPriorityDashboardsRelease(deps("non-us", rel));
    assert.equal(r.code, 1); assert.equal(r.stage, "publish-gates");
    assert.equal(calls.publish.length, 0, "not a single account was published when one preflight was not ready");
  });

  /* ============ 7-11: honest per-bucket effectivePublishAsOf policy ============ */
  group("honest per-bucket effectivePublishAsOf (bounded 2-day settlement tail)");

  const FROM = "2025-01-01";
  const REQ = "2026-08-26";
  const discN = (n) => Array.from({ length: n }, (_, i) => ({ accountId: "N" + String(i + 1).padStart(2, "0") }));
  const flat = (accounts, to) => { const c = {}, p = {}; accounts.forEach((a) => { c[a.accountId] = [{ from: FROM, to }]; p[a.accountId] = false; }); return { coverageByAccountId: c, provenanceBlankByAccountId: p }; };
  const readiness = (over = {}) => {
    const accounts = over.discoveredAccounts || discN(22);
    const cp = over.coverage || flat(accounts, "2026-08-25");
    return assessBucketPublishReadiness({ bucket: "non-us", requestedAsOf: REQ, from: FROM, discoveredAccounts: accounts, coverageByAccountId: cp.coverageByAccountId, provenanceBlankByAccountId: cp.provenanceBlankByAccountId, cyclePresent: true, cycleOliAssessment: { ok: true, problems: [] }, ...over.extra });
  };

  test("7. requested 08-26 but every account proves 08-25 (tail-only) -> publish honestly through 08-25 (UPSTREAM_TAIL_LAG)", () => {
    const accounts = discN(22);
    const cov = flat(accounts, "2026-08-25");
    // 5 accounts DID settle 08-26; the honest COMMON date is still 08-25.
    for (let i = 0; i < 5; i += 1) cov.coverageByAccountId[accounts[i].accountId] = [{ from: FROM, to: "2026-08-26" }];
    const r = readiness({ discoveredAccounts: accounts, coverage: cov });
    assert.equal(r.ok, true); assert.equal(r.effectiveAsOf, "2026-08-25"); assert.equal(r.status, "UPSTREAM_TAIL_LAG"); assert.equal(r.tailLagDays, 1);
    assert.notEqual(r.effectiveAsOf, r.requestedAsOf, "never claims 08-26 is covered");
    assert.ok((r.notes || []).some((n) => /UPSTREAM_TAIL_LAG/.test(n)));
  });

  test("8. an INTERIOR historical gap fails closed (never clamps around the hole)", () => {
    const accounts = discN(22);
    const cov = flat(accounts, "2026-08-25");
    cov.coverageByAccountId[accounts[3].accountId] = [{ from: FROM, to: "2026-06-01" }, { from: "2026-06-10", to: "2026-08-25" }]; // hole 06-02..06-09
    const r = readiness({ discoveredAccounts: accounts, coverage: cov });
    assert.equal(r.ok, false); assert.equal(r.effectiveAsOf, null);
    assert.ok(r.problems.some((p) => /interior-gap/.test(p)));
  });

  test("9. a tail lag GREATER than two days fails closed (stale/stuck evidence, not a settlement tail)", () => {
    const accounts = discN(22);
    const cov = flat(accounts, "2026-08-25");
    cov.coverageByAccountId[accounts[9].accountId] = [{ from: FROM, to: "2026-08-23" }]; // 3-day lag vs 08-26
    const r = readiness({ discoveredAccounts: accounts, coverage: cov });
    assert.equal(r.ok, false); assert.equal(r.status, "TAIL_LAG_EXCEEDED");
    assert.ok(r.problems.some((p) => /tail-lag-exceeded/.test(p)));
    // and the boundary is honoured directly in the resolver (lag 2 ok, lag 3 not).
    assert.equal(MAX_PUBLISH_TAIL_LAG_DAYS, 2);
    assert.equal(resolveEffectivePublishAsOf({ coverageByAccountId: { a: [{ from: FROM, to: "2026-08-24" }] }, accountIds: ["a"], from: FROM, refreshAsOf: REQ }).effectiveAsOf, "2026-08-24");
    assert.equal(resolveEffectivePublishAsOf({ coverageByAccountId: { a: [{ from: FROM, to: "2026-08-23" }] }, accountIds: ["a"], from: FROM, refreshAsOf: REQ }).effectiveAsOf, null);
  });

  test("10. OLI source jobs SUCCEEDED but durable coverage did NOT advance -> cannot claim requested-date success", () => {
    // The exact run 33039807358 shape: a green scheduled OLI cycle (jobs succeeded) but coverage only through 08-25.
    const accounts = discN(22);
    const r = readiness({ discoveredAccounts: accounts, coverage: flat(accounts, "2026-08-25"), extra: { cyclePresent: true, cycleOliAssessment: { ok: true, problems: [] } } });
    assert.equal(r.ok, true, "a settlement tail is publishable");
    assert.notEqual(r.status, "exact", "a green cycle does NOT upgrade the effective date to the requested date");
    assert.equal(r.effectiveAsOf, "2026-08-25");
    assert.notEqual(r.effectiveAsOf, "2026-08-26");
  });

  test("11. five Ads-DISCONNECTED accounts are typed UNAVAILABLE + non-blocking; the OLI sales half still publishes", () => {
    const accounts = discN(22);
    const cov = flat(accounts, "2026-08-25");
    const adsUnavailable = {}, adsCovered = {};
    accounts.forEach((a, i) => { adsUnavailable[a.accountId] = i < 5; adsCovered[a.accountId] = i >= 5; }); // 5 disconnected
    const r = assessBucketPublishReadiness({ bucket: "non-us", requestedAsOf: REQ, from: FROM, discoveredAccounts: accounts, coverageByAccountId: cov.coverageByAccountId, provenanceBlankByAccountId: cov.provenanceBlankByAccountId, adsCoveredByAccountId: adsCovered, adsUnavailableByAccountId: adsUnavailable, cyclePresent: true, cycleOliAssessment: { ok: true, problems: [] } });
    assert.equal(r.ok, true, "ads-disconnected never blocks the OLI publish");
    assert.equal(r.effectiveAsOf, "2026-08-25");
    assert.ok((r.notes || []).some((n) => /ads-unavailable-note:5/.test(n)));
    // even ads-INCOMPLETE on a connected account is a note, never a blocker (ads never blocks the sales half).
    const adsGap = {}; accounts.forEach((a) => { adsGap[a.accountId] = false; });
    const r2 = assessBucketPublishReadiness({ bucket: "non-us", requestedAsOf: REQ, from: FROM, discoveredAccounts: accounts, coverageByAccountId: cov.coverageByAccountId, provenanceBlankByAccountId: cov.provenanceBlankByAccountId, adsCoveredByAccountId: adsGap, cyclePresent: true, cycleOliAssessment: { ok: true, problems: [] } });
    assert.equal(r2.ok, true, "an ads-window gap never blocks");
    assert.ok((r2.notes || []).some((n) => /ads-incomplete-note/.test(n)));
  });

  /* ============ 12: shared Catalog created at most once, reused across both buckets ============ */
  group("shared Product Catalog: one create, reused across buckets");

  function fakeReservation() {
    let row = null; const self = {
      reserve: async ({ catalogRequestHash }) => {
        if (!row) { row = { hash: catalogRequestHash, exportId: null, tokens: 0 }; return { disposition: "reserved" }; }
        if (row.hash !== catalogRequestHash) return { disposition: "hash-mismatch" };
        return { disposition: "exists", exportId: row.exportId };
      },
      recordExport: async ({ exportId, tokens }) => { row.exportId = exportId; row.tokens = tokens; return { disposition: "recorded" }; },
      get: async () => (row ? { status: "created", catalogRequestHash: row.hash, exportId: row.exportId, tokensSpent: row.tokens } : null),
    };
    return self;
  }

  test("12. the Catalog is created EXACTLY ONCE (2 tokens) and the second bucket ADOPTS it (0 tokens)", async () => {
    const reservation = fakeReservation();
    let creates = 0;
    const inner = { create: async () => { creates += 1; return { exportId: "cat-export-1" }; }, poll: async () => ({}), download: async () => ({}) };
    const guard = makeDurableCatalogGuard({ inner, reservation, operationKey: "priority-dashboards/scheduled/2026-08-26" });
    const first = await guard.create({ sourceKey: "product-catalog", requestHash: "CAT_HASH" });   // Non-US morning: wins the create
    const second = await guard.create({ sourceKey: "product-catalog", requestHash: "CAT_HASH" });  // US evening: adopts
    assert.equal(creates, 1, "one create across both buckets");
    assert.equal(first.exportId, "cat-export-1");
    assert.equal(second.adopted, true); assert.equal(second.exportId, "cat-export-1");
    assert.equal((await reservation.get()).tokensSpent, 2, "two tokens total");
  });

  /* ============ 13: Brand View membership combines both buckets ============ */
  group("Brand View membership: new bucket + other-bucket LKG");

  test("13. membership combines the fresh bucket's brand-sales with the other bucket's LKG (a shared brand spans both)", () => {
    // Bebi Born sells in BOTH a Non-US account (fresh) and a US account (LKG); membership must include both.
    const perAccount = [
      { accountId: "N01", salesBrands: ["Bebi Born", "OnlyNonUsBrand"] }, // fresh Non-US brand-sales
      { accountId: "U01", salesBrands: ["Bebi Born"] },                    // US latest-known-good brand-sales
    ];
    const membership = buildBrandAccountMembership(perAccount);
    const bebi = accountsForBrand(membership, "Bebi Born");
    assert.ok(bebi.includes("N01") && bebi.includes("U01"), "Bebi Born resolves to accounts from BOTH buckets");
    const onlyNonUs = accountsForBrand(membership, "OnlyNonUsBrand");
    assert.deepEqual(onlyNonUs, ["N01"], "a single-bucket brand stays single-bucket");
    // dropping the US LKG (as if US never ran) must NOT remove Non-US membership.
    const membershipNonUsOnly = buildBrandAccountMembership([perAccount[0]]);
    assert.ok(accountsForBrand(membershipNonUsOnly, "Bebi Born").includes("N01"), "the fresh bucket keeps its membership regardless of the other bucket");
  });

  /* ============ 14-16: failure safety + no campaign/fba + manual dispatch parity (workflow shape) ============ */
  group("workflow: always-safe-close, no Campaign Ads/FBA, manual dispatch parity");

  test("14. EVERY real pipeline failure safe-closes controls; the verified US duplicate no-op stays zero-write", () => {
    assert.match(
      yml,
      /if:\s*always\(\)\s*&&\s*\(steps\.cfg\.outputs\.bucket != 'us' \|\| steps\.us_guard\.outputs\.run_required == 'true'\)\n\s*run:\s*node scripts\/release\/priority-control-package\.mjs --rollback/,
      "Non-US and every non-no-op US pipeline attempt safe-close",
    );
    assert.match(yml, /already_published == 'true'[\s\S]*zero creates, zero controls, zero tokens/i, "the verified US duplicate is explicitly zero-write");
  });

  test("15. Post ASIN->Campaign cutover: Campaign Ads is the scheduled active source but never a priority-published report/control; ASIN Ads is retired; FBA never publishes; the Catalog release guard refuses any non-catalog create", async () => {
    assert.ok(SCHEDULED_ENABLED_SOURCE_KEYS.includes("ads-campaign-date"), "Campaign Ads is schedule-enabled (the active Ads source)");
    assert.ok(!SCHEDULED_ENABLED_SOURCE_KEYS.includes("ads-asin-date"), "ASIN Ads is retired (not schedule-enabled)");
    assert.ok(!SCHEDULED_ENABLED_SOURCE_KEYS.some((k) => /fba/i.test(k)), "no FBA source is schedule-enabled");
    assert.ok(!PRIORITY_DISPATCH_ENABLED.some((k) => /campaign|fba/i.test(k)), "campaign/fba are never a priority-published dispatch control");
    assert.ok(!/campaign|fba/i.test(PRIORITY_PROMOTED_ENABLED), "the promoted control is brand-inventory, not campaign/fba");
    assert.doesNotMatch(yml, /node scripts\/[^\n]*fba/i, "no workflow step invokes an FBA script");
    // The Catalog release guard still forbids a campaign create THROUGH the priority release (campaign is refreshed in
    // its own dedicated step, never as a release-owned export).
    const guard = makeDurableCatalogGuard({ inner: { create: async () => ({ exportId: "x" }), poll: async () => ({}), download: async () => ({}) }, reservation: { reserve: async () => ({ disposition: "reserved" }), recordExport: async () => ({ disposition: "recorded" }), get: async () => null }, operationKey: "priority-dashboards/scheduled/2026-08-26" });
    await assert.rejects(() => guard.create({ sourceKey: "ads-campaign-date", requestHash: "X" }), /PRIORITY_FORBIDDEN_CREATE/);
  });

  test("16. manual workflow_dispatch follows the SAME bucket-scoped pipeline as the cron", () => {
    assert.match(yml, /workflow_dispatch:/);
    assert.match(yml, /bucket="\$\{\{ github\.event\.inputs\.bucket \}\}"/, "dispatch resolves the bucket from the input");
    // both triggers feed the SAME steps.cfg.outputs.bucket into the bucket-scoped control apply + release.
    assert.match(yml, /priority-control-package\.mjs --apply --bucket=\$\{\{ steps\.cfg\.outputs\.bucket \}\}/);
    assert.match(yml, /priority-dashboards-release\.mjs --bucket=\$\{\{ steps\.cfg\.outputs\.bucket \}\}/);
  });

  /* ============ 17-18: shared manual OLI persistence + Order-ID capture unchanged ============ */
  group("manual OLI persistence path + Order-ID capture unchanged");

  test("17. the Data Sync Center manual OLI sync uses the SAME runtime + persistence path as the scheduled OLI refresh", () => {
    const manual = readFileSync(resolve(RELEASE_DIR, "manual-source-sync.mjs"), "utf8");
    const sched = readFileSync(resolve(RELEASE_DIR, "scheduled-oli-refresh.mjs"), "utf8");
    for (const [label, src] of [["manual", manual], ["scheduled", sched]]) {
      assert.match(src, /buildBucketSourceSyncRuntime/, label + " builds the same source runtime");
      assert.match(src, /runSourceCardAction/, label + " drives the same source-card action (one persistence path)");
    }
    assert.match(manual, /order-line-items/, "the manual operator still runs the order-line-items family");
  });

  test("18. Order-ID capture stays active on the next successful OLI sync (audit-only, never blocking)", () => {
    const base = { seller_or_vendor_id: "s1", sale_date: "2026-08-26", item_price_currency: "USD", amazon_order_status: "Shipped", total_units_sum: 1, total_sales_sum: 12.5 };
    const withId = classifyOliDimensionalRow({ ...base, amazon_order_id: "111-2223334-5556667" });
    assert.equal(withId.orderIdAvailable, true); assert.equal(withId.orderId, "111-2223334-5556667");
    // a missing order id is AUDIT-ONLY: it never blocks the window (the row still classifies + contributes).
    const noId = classifyOliDimensionalRow({ ...base, amazon_order_id: "" });
    assert.equal(noId.orderIdAvailable, false); assert.equal(noId.orderId, "");
    assert.equal(noId.contributesToRollup, true, "a blank Order ID never blocks the sale");
    assert.equal(canonicalizeOrderId("  111-2223334-5556667 "), "111-2223334-5556667", "canonicalization is intact");
  });

  // ---- run ----
  let failures = 0;
  for (const t of tests) {
    if (t.marker) { out("== " + t.marker); continue; }
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (err) { failures += 1; out("FAIL  " + t.name); out(String(err && err.stack ? err.stack : err)); }
  }
  out("\n" + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : ""));
  if (failures) process.exitCode = 1;
}

main().catch((e) => { out("FATAL " + String(e && e.stack ? e.stack : e)); process.exitCode = 1; });
