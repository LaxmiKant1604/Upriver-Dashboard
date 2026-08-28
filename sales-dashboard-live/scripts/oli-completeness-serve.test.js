// OLI COMPLETENESS serve-time summarisers -- deterministic OFFLINE proof that the two-layer provisional/final label
// the frontend shows is derived honestly from the durable per-date completeness rows: the report leads with the
// LATEST date's state, an account/portfolio is provisional if its latest day still has pending order shells, the
// finalized-through high-water mark is exposed, and pending counts are always surfaced separately. 7-bit ASCII.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { summarizeCompleteness, summarizePortfolioCompleteness, makeCompletenessAugment } from "../lib/server/reports/oli-completeness-serve.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const test = (name, fn) => { try { fn(); passed += 1; out("  ok  " + name); } catch (e) { out("FAIL  " + name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; } };

const row = (o) => ({ account_id: "A1", sale_date: "2026-08-26", completeness_status: "final", itemized_order_count: 10, pending_order_count: 0, itemized_unit_count: 20, pending_unit_count: 0, itemization_percent: 100, requested_as_of: "2026-08-26", proven_export_through: "2026-08-26", refreshed_at: "2026-08-27T10:00:00Z", ...o });

/* 1 */ test("no completeness evidence -> null (report renders unlabelled, as before)", () => {
  assert.equal(summarizeCompleteness([]), null);
  assert.equal(summarizeCompleteness(null), null);
});

/* 2 */ test("the LATEST date decides the headline: a provisional D-1 over a final D-2 -> provisional", () => {
  const c = summarizeCompleteness([
    row({ sale_date: "2026-08-25", completeness_status: "final" }),
    row({ sale_date: "2026-08-26", completeness_status: "provisional", itemized_order_count: 13, pending_order_count: 77, pending_unit_count: 90, itemization_percent: 14.4 }),
  ]);
  assert.equal(c.status, "provisional");
  assert.equal(c.provisional, true);
  assert.equal(c.latestDate, "2026-08-26");
  assert.equal(c.pendingOrderCount, 77);
  assert.equal(c.pendingUnitCount, 90);
  assert.equal(c.itemizationPercent, 14.4);
  assert.ok(/prices are still pending/.test(c.notice), "an honest provisional notice, never implying finality");
});

/* 3 */ test("finalizedThrough = the last FINAL date (the LKG the user can reference)", () => {
  const c = summarizeCompleteness([
    row({ sale_date: "2026-08-24", completeness_status: "final" }),
    row({ sale_date: "2026-08-25", completeness_status: "final" }),
    row({ sale_date: "2026-08-26", completeness_status: "provisional", pending_order_count: 5 }),
  ]);
  assert.equal(c.finalizedThrough, "2026-08-25");
  assert.equal(c.status, "provisional");
});

/* 4 */ test("a fully-itemized latest date -> final (no provisional notice)", () => {
  const c = summarizeCompleteness([row({ sale_date: "2026-08-26", completeness_status: "final", itemized_order_count: 30, pending_order_count: 0, itemization_percent: 100 })]);
  assert.equal(c.status, "final");
  assert.equal(c.provisional, false);
  assert.equal(c.notice, null);
});

/* 5 */ test("source-defect latest date -> sourceDefect flag + an investigate notice", () => {
  const c = summarizeCompleteness([row({ sale_date: "2026-08-26", completeness_status: "source-defect" })]);
  assert.equal(c.status, "source-defect");
  assert.equal(c.sourceDefect, true);
  assert.ok(/source-data issue/.test(c.notice));
});

/* 6 */ test("portfolio: ANY account provisional (its latest date) -> portfolio provisional; pending sums", () => {
  const c = summarizePortfolioCompleteness([
    row({ account_id: "A1", sale_date: "2026-08-26", completeness_status: "final", itemized_order_count: 10, pending_order_count: 0 }),
    row({ account_id: "A2", sale_date: "2026-08-26", completeness_status: "provisional", itemized_order_count: 4, pending_order_count: 6, pending_unit_count: 9 }),
  ]);
  assert.equal(c.status, "provisional");
  assert.equal(c.accountsProvisional, 1);
  assert.equal(c.accountsFinal, 1);
  assert.equal(c.pendingOrderCount, 6);
  assert.equal(c.pendingUnitCount, 9);
  assert.equal(c.itemizedOrderCount, 14);
  assert.equal(c.itemizationPercent, 70); // 14 / (14+6)
});

/* 7 */ test("portfolio: all accounts final -> portfolio final; source-defect takes priority over provisional", () => {
  assert.equal(summarizePortfolioCompleteness([
    row({ account_id: "A1", completeness_status: "final", pending_order_count: 0 }),
    row({ account_id: "A2", completeness_status: "final", pending_order_count: 0 }),
  ]).status, "final");
  assert.equal(summarizePortfolioCompleteness([
    row({ account_id: "A1", completeness_status: "provisional", pending_order_count: 3 }),
    row({ account_id: "A2", completeness_status: "source-defect" }),
  ]).status, "source-defect");
});

/* 8 */ test("portfolio uses each account's LATEST date only (an older provisional does not resurrect)", () => {
  const c = summarizePortfolioCompleteness([
    row({ account_id: "A1", sale_date: "2026-08-25", completeness_status: "provisional", pending_order_count: 9 }),
    row({ account_id: "A1", sale_date: "2026-08-26", completeness_status: "final", itemized_order_count: 10, pending_order_count: 0 }),
  ]);
  assert.equal(c.status, "final", "A1's latest (08-26) is final; the older 08-25 provisional is ignored");
  assert.equal(c.pendingOrderCount, 0);
});

/* 9 */ test("the serve augment is advisory: a reader throw yields {} (never breaks a report read)", async () => {
  const aug = makeCompletenessAugment({ organizationFingerprint: "org", connectionId: "primary", read: async () => { throw new Error("db down"); } });
  assert.deepEqual(await aug({ accountId: "A1", params: { from: "2026-08-20", to: "2026-08-26" } }), {});
  const augOk = makeCompletenessAugment({ organizationFingerprint: "org", read: async () => [row({ completeness_status: "provisional", pending_order_count: 4 })] });
  const r = await augOk({ accountId: "A1", params: {} });
  assert.equal(r.completeness.status, "provisional");
});

/* 10 */ test("a missing org/account short-circuits the augment to {} (no read attempted)", async () => {
  let called = false;
  const aug = makeCompletenessAugment({ organizationFingerprint: "", read: async () => { called = true; return []; } });
  assert.deepEqual(await aug({ accountId: "A1", params: {} }), {});
  assert.equal(called, false);
});

/* 11 */ test("a 0%-itemized D-1 (covered but no itemized sales yet) is provisional with the latest FINAL date earlier -- honest, no fabricated zero", () => {
  const c = summarizeCompleteness([
    row({ sale_date: "2026-08-25", completeness_status: "final", itemized_order_count: 40, pending_order_count: 0, itemization_percent: 100 }),
    row({ sale_date: "2026-08-26", completeness_status: "provisional", itemized_order_count: 13, pending_order_count: 20, itemization_percent: 39 }),
    row({ sale_date: "2026-08-27", completeness_status: "provisional", itemized_order_count: 0, pending_order_count: 59, pending_unit_count: 60, itemization_percent: 0 }),
  ]);
  assert.equal(c.status, "provisional");
  assert.equal(c.latestDate, "2026-08-27", "covered THROUGH D-1 even at 0% itemized");
  assert.equal(c.itemizationPercent, 0, "D-1 is 0% itemized (no itemized sales yet)");
  assert.equal(c.pendingOrderCount, 59);
  assert.equal(c.finalizedThrough, "2026-08-25", "the latest FULLY-itemized day is earlier -- shown honestly, never as a D-1 zero");
});

/* 12 */ test("an inactive account (only a final/zero D-1 row) is Final D-1, never a false provisional", () => {
  const c = summarizeCompleteness([row({ sale_date: "2026-08-27", completeness_status: "final", itemized_order_count: 0, pending_order_count: 0, itemization_percent: 100 })]);
  assert.equal(c.status, "final");
  assert.equal(c.provisional, false);
  assert.equal(c.pendingOrderCount, 0);
});

out("\n" + passed + " assertions passed");
