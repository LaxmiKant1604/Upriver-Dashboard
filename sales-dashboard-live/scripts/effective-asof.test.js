// EFFECTIVE PUBLISH AS-OF -- deterministic OFFLINE proof that the scheduler separates the date it TRIED to reach
// (refreshAsOf) from the latest date every account can PROVE with gapless durable OLI coverage
// (effectivePublishAsOf): a recent unsettled tail clamps to the latest COMMON proven completed date, an interior
// historical hole fails closed, and nothing is ever zero-padded forward. Composes the same two pure functions the
// runtime composes (resolveEffectivePublishAsOf + dailyReportingReadiness). 7-bit ASCII, LF, no top-level await.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { resolveEffectivePublishAsOf } from "../lib/server/sync/source-durable-model.js";
import { dailyReportingReadiness } from "../lib/server/sync/durable-dashboards.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const FROM = "2025-01-01";
const REFRESH = "2026-08-25";
// A validated catalog snapshot + ASIN-grain ads so ONLY OLI coverage drives daily.ready in these cases.
const CATALOG = { validated_at: "2026-08-26T00:00:00Z" };
const win = (from, to) => [{ from, to }];

/* ===== A. no clamp when every account reaches the requested date ===== */

test("A1. all accounts prove through refreshAsOf -> effectiveAsOf === refreshAsOf, no blockers", () => {
  const r = resolveEffectivePublishAsOf({
    coverageByAccountId: { a: win(FROM, REFRESH), b: win(FROM, REFRESH) },
    accountIds: ["a", "b"], from: FROM, refreshAsOf: REFRESH,
  });
  assert.equal(r.effectiveAsOf, REFRESH);
  assert.deepEqual(r.blockers, []);
});

/* ===== B. trailing unsettled tail clamps to the latest COMMON proven date ===== */

test("B1. a recent trailing gap on some accounts clamps effectiveAsOf to the min proven date (never past it)", () => {
  const r = resolveEffectivePublishAsOf({
    coverageByAccountId: {
      full1: win(FROM, "2026-08-25"),
      full2: win(FROM, "2026-08-25"),
      tail1: win(FROM, "2026-08-24"), // 08-25 unsettled
      tail2: win(FROM, "2026-08-24"),
    },
    accountIds: ["full1", "full2", "tail1", "tail2"], from: FROM, refreshAsOf: REFRESH,
  });
  assert.equal(r.effectiveAsOf, "2026-08-24", "clamped to the latest date EVERY account proves");
  assert.deepEqual(r.blockers, [], "a trailing tail is NOT a blocker -- it clamps");
  assert.equal(r.perAccount.tail1, "2026-08-24");
  assert.equal(r.perAccount.full1, "2026-08-25");
});

test("B2. effectiveAsOf never exceeds refreshAsOf even when coverage runs past it", () => {
  const r = resolveEffectivePublishAsOf({
    coverageByAccountId: { a: win(FROM, "2026-09-30") },
    accountIds: ["a"], from: FROM, refreshAsOf: REFRESH,
  });
  assert.equal(r.effectiveAsOf, REFRESH, "clamped DOWN to refreshAsOf, never forward");
});

test("B3. NO zero-padding: within the 2-day cap the clamped date is a REAL proven date, never invented forward", () => {
  const r = resolveEffectivePublishAsOf({
    coverageByAccountId: { a: win(FROM, "2026-08-23"), b: win(FROM, "2026-08-25") },
    accountIds: ["a", "b"], from: FROM, refreshAsOf: REFRESH,
  });
  // min proven = 08-23 (account a), lag 2 -- exactly the cap; it is a's covered_to, never invented past it.
  assert.equal(r.effectiveAsOf, "2026-08-23");
  assert.equal(r.status, "UPSTREAM_TAIL_LAG");
  assert.equal(r.tailLagDays, 2);
  assert.deepEqual(r.blockers, []);
});

/* ===== B'. the BOUNDED (<=2 day) settlement-lag cap ===== */

test("B4. lag exactly 0 -> status 'exact', no clamp", () => {
  const r = resolveEffectivePublishAsOf({ coverageByAccountId: { a: win(FROM, REFRESH) }, accountIds: ["a"], from: FROM, refreshAsOf: REFRESH });
  assert.equal(r.effectiveAsOf, REFRESH);
  assert.equal(r.status, "exact");
  assert.equal(r.tailLagDays, 0);
});

test("B5. lag of 1 or 2 days publishes honestly (UPSTREAM_TAIL_LAG); lag of 3+ FAILS CLOSED (tail-lag-exceeded)", () => {
  const at = (to) => resolveEffectivePublishAsOf({ coverageByAccountId: { a: win(FROM, to) }, accountIds: ["a"], from: FROM, refreshAsOf: REFRESH });
  const lag1 = at("2026-08-24");
  assert.equal(lag1.effectiveAsOf, "2026-08-24"); assert.equal(lag1.status, "UPSTREAM_TAIL_LAG"); assert.equal(lag1.tailLagDays, 1);
  const lag2 = at("2026-08-23");
  assert.equal(lag2.effectiveAsOf, "2026-08-23"); assert.equal(lag2.status, "UPSTREAM_TAIL_LAG"); assert.equal(lag2.tailLagDays, 2);
  const lag3 = at("2026-08-22");
  assert.equal(lag3.effectiveAsOf, null, "a 3-day lag is stale/stuck, not a settlement tail");
  assert.equal(lag3.status, "TAIL_LAG_EXCEEDED");
  assert.equal(lag3.tailLagDays, 3);
  assert.ok(lag3.blockers.some((b) => b.reason === "tail-lag-exceeded"));
});

test("B6. the cap is honoured across the WHOLE scope: one very-stale account fails the whole bucket closed", () => {
  const r = resolveEffectivePublishAsOf({
    coverageByAccountId: { fresh: win(FROM, REFRESH), stale: win(FROM, "2026-08-10") }, // stale is 15 days behind
    accountIds: ["fresh", "stale"], from: FROM, refreshAsOf: REFRESH,
  });
  assert.equal(r.effectiveAsOf, null);
  assert.equal(r.status, "TAIL_LAG_EXCEEDED");
  assert.ok(r.blockers.some((b) => b.reason === "tail-lag-exceeded"));
});

test("B7. an explicit maxTailLagDays override widens/narrows the tolerance", () => {
  const cov = { a: win(FROM, "2026-08-20") }; // lag 5
  assert.equal(resolveEffectivePublishAsOf({ coverageByAccountId: cov, accountIds: ["a"], from: FROM, refreshAsOf: REFRESH, maxTailLagDays: 5 }).effectiveAsOf, "2026-08-20", "cap 5 admits a 5-day lag");
  assert.equal(resolveEffectivePublishAsOf({ coverageByAccountId: cov, accountIds: ["a"], from: FROM, refreshAsOf: REFRESH, maxTailLagDays: 4 }).effectiveAsOf, null, "cap 4 rejects a 5-day lag");
});

/* ===== C. interior + leading historical holes FAIL CLOSED (never clamp around them) ===== */

test("C1. an INTERIOR gap (coverage resumes after a hole) fails closed -> effectiveAsOf null, interior-gap blocker", () => {
  const r = resolveEffectivePublishAsOf({
    coverageByAccountId: {
      a: win(FROM, "2026-08-25"),
      b: [{ from: FROM, to: "2026-06-01" }, { from: "2026-06-10", to: "2026-08-25" }], // hole 06-02..06-09
    },
    accountIds: ["a", "b"], from: FROM, refreshAsOf: REFRESH,
  });
  assert.equal(r.effectiveAsOf, null, "an interior hole is never clamped around");
  assert.ok(r.blockers.some((x) => x.accountId === "b" && x.reason === "interior-gap"));
});

test("C2. a LEADING gap (the window start itself uncovered) fails closed with leading-gap", () => {
  const r = resolveEffectivePublishAsOf({
    coverageByAccountId: { a: [{ from: "2025-03-01", to: "2026-08-25" }] }, // starts AFTER FROM
    accountIds: ["a"], from: FROM, refreshAsOf: REFRESH,
  });
  assert.equal(r.effectiveAsOf, null);
  assert.ok(r.blockers.some((x) => x.reason === "leading-gap"));
});

test("C3. an empty scope is a typed no-accounts blocker (never a silent pass)", () => {
  const r = resolveEffectivePublishAsOf({ coverageByAccountId: {}, accountIds: [], from: FROM, refreshAsOf: REFRESH });
  assert.equal(r.effectiveAsOf, null);
  assert.ok(r.blockers.some((x) => x.reason === "no-accounts"));
});

test("C4. dd-secondary (':'-bearing) ids are ignored by the primary-only scope", () => {
  const r = resolveEffectivePublishAsOf({
    coverageByAccountId: { a: win(FROM, REFRESH) },
    accountIds: ["a", "dd-secondary:x"], from: FROM, refreshAsOf: REFRESH,
  });
  assert.equal(r.effectiveAsOf, REFRESH);
  assert.equal(r.perAccount["dd-secondary:x"], undefined, "secondary id never scored");
});

/* ===== D. the readiness GATE composed with the clamp (the exact runtime composition) ===== */

test("D1. readiness at refreshAsOf FAILS (coverage-incomplete) but PASSES at the clamped effectiveAsOf", () => {
  const coverage = { full: win(FROM, "2026-08-25"), tail: win(FROM, "2026-08-24") };
  const ids = ["full", "tail"];
  // (a) at the requested date the tail account is not proven -> ready=false with a sanitizable OLI blocker.
  const atRefresh = dailyReportingReadiness({
    accounts: ids, oliCoverageByAccountId: coverage, catalogSnapshot: CATALOG, asinAds: null,
    from: "2026-03-25", to: "2026-08-25",
  });
  assert.equal(atRefresh.ready, false, "the unsettled tail blocks the requested date");
  assert.ok(atRefresh.blockedBy.some((b) => b.sourceKey === "order-line-items" && b.reason === "coverage-incomplete" && b.blocksSales === true));
  // (b) resolve the effective date and re-check -> ready.
  const eff = resolveEffectivePublishAsOf({ coverageByAccountId: coverage, accountIds: ids, from: FROM, refreshAsOf: "2026-08-25" });
  assert.equal(eff.effectiveAsOf, "2026-08-24");
  const atEffective = dailyReportingReadiness({
    accounts: ids, oliCoverageByAccountId: coverage, catalogSnapshot: CATALOG, asinAds: null,
    from: "2026-03-24", to: eff.effectiveAsOf,
  });
  assert.equal(atEffective.ready, true, "at the latest common proven date the sales half is ready");
  assert.equal(atEffective.blockedBy.filter((b) => b.blocksSales).length, 0);
});

test("D2. Ads/catalog degradation is separable: a missing catalog blocks sales, an Ads gap does NOT", () => {
  const coverage = { a: win(FROM, "2026-08-24") };
  const eff = resolveEffectivePublishAsOf({ coverageByAccountId: coverage, accountIds: ["a"], from: FROM, refreshAsOf: "2026-08-25" });
  // Ads null -> ads blocker present but blocksSales:false; catalog present -> sales ready at the effective date.
  const ready = dailyReportingReadiness({
    accounts: ["a"], oliCoverageByAccountId: coverage, catalogSnapshot: CATALOG, asinAds: null,
    from: "2026-03-24", to: eff.effectiveAsOf,
  });
  assert.equal(ready.ready, true, "an Ads gap never blocks the sales half");
  assert.ok(ready.blockedBy.some((b) => b.sourceKey === "ads-asin-date" && b.blocksSales === false));
  // a missing catalog DOES block sales
  const noCatalog = dailyReportingReadiness({
    accounts: ["a"], oliCoverageByAccountId: coverage, catalogSnapshot: null, asinAds: null,
    from: "2026-03-24", to: eff.effectiveAsOf,
  });
  assert.equal(noCatalog.ready, false);
  assert.ok(noCatalog.blockedBy.some((b) => b.sourceKey === "product-catalog" && b.blocksSales === true));
});

let failures = 0;
for (const t of tests) {
  try { t.fn(); passed += 1; out("  ok  " + t.name); }
  catch (e) { failures += 1; out("FAIL  " + t.name); out(String((e && e.stack) || e)); }
}
out("\n" + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : ""));
if (failures) process.exitCode = 1;
