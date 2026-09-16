// Unit coverage for the OLI reconciler's shared-Catalog cold-cache latch (oli-catalog-cold-latch.js). Proves the
// signal is recognised ONLY for the shared-carrier deferral, the fast-defer is the byte-identical typed deferral a
// genuine derive defer produces, and a simulated per-account loop converges: one real cold defer then N-1 fast defers,
// while a WARM first account never engages the latch. Offline; zero network. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import {
  CATALOG_COLD_DEFER_REASON,
  isSharedCatalogColdDefer,
  buildCatalogColdFastDefer,
} from "../lib/server/sync/oli-catalog-cold-latch.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };

// The EXACT mapped shape a genuine Catalog-cold derive defer produces in the operator (captured live from
// runReleaseForAccount): code 1 / ok false / status null / reason SOURCE_READINESS_PENDING / no blockerCodes.
const realColdDefer = (bucket) => ({ code: 1, ok: false, stage: "derive:" + bucket, status: null, leaseLost: false, reason: "SOURCE_READINESS_PENDING", blockerCodes: [], problems: ["derive did not complete: SOURCE_READINESS_PENDING"] });
const published = (bucket) => ({ code: 0, ok: true, stage: "publish:" + bucket, status: "PUBLISHED", leaseLost: false, reason: null, blockerCodes: [], problems: [] });
const acctSpecificDefer = (bucket) => ({ code: 1, ok: false, stage: "derive:" + bucket, status: null, leaseLost: false, reason: "DATADOE_D1_NOT_READY", blockerCodes: [], problems: ["D-1 not ready"] });
const deadlineAborted = (bucket) => ({ code: 1, ok: false, stage: "reconcile", status: "DEADLINE_ABORTED", leaseLost: false, reason: "deadline-aborted", blockerCodes: [], problems: ["deadline-aborted before start"] });

const tests = [];
const test = (n, f) => tests.push({ name: n, fn: f });

test("the reason constant is the shared-carrier readiness code", () => {
  ok("constant is SOURCE_READINESS_PENDING", CATALOG_COLD_DEFER_REASON === "SOURCE_READINESS_PENDING");
});

test("isSharedCatalogColdDefer recognises ONLY the shared-carrier deferral", () => {
  ok("real cold defer -> true", isSharedCatalogColdDefer(realColdDefer("india")) === true);
  ok("published -> false", isSharedCatalogColdDefer(published("india")) === false);
  ok("account-specific D-1 defer -> false (distinct code)", isSharedCatalogColdDefer(acctSpecificDefer("india")) === false);
  ok("deadline-aborted -> false", isSharedCatalogColdDefer(deadlineAborted("india")) === false);
  ok("null -> false", isSharedCatalogColdDefer(null) === false);
  ok("undefined -> false", isSharedCatalogColdDefer(undefined) === false);
  ok("no-reason object -> false", isSharedCatalogColdDefer({ code: 1 }) === false);
});

test("buildCatalogColdFastDefer is the byte-identical typed deferral (bar the traceable problems note)", () => {
  const fast = buildCatalogColdFastDefer("india");
  const real = realColdDefer("india");
  for (const k of ["code", "ok", "stage", "status", "leaseLost", "reason"]) ok("typed field " + k + " identical", fast[k] === real[k]);
  ok("blockerCodes identical (empty)", Array.isArray(fast.blockerCodes) && fast.blockerCodes.length === 0);
  ok("classified as a cold defer by our own recogniser", isSharedCatalogColdDefer(fast) === true);
  ok("problems carries a traceable fast-defer note", fast.problems.length === 1 && /fast-defer/.test(fast.problems[0]));
  // bucket is threaded into the stage
  ok("stage reflects the bucket", buildCatalogColdFastDefer("europe-au").stage === "derive:europe-au");
});

// Simulate the operator's per-account loop latch to prove convergence + safety.
function simulateLoop(results) {
  let latched = false; const out = []; let realReleases = 0;
  for (const r of results) {
    if (latched) { out.push({ served: buildCatalogColdFastDefer("india"), ran: false }); continue; }
    realReleases += 1; // a real release would run here
    out.push({ served: r, ran: true });
    if (isSharedCatalogColdDefer(r)) latched = true;
  }
  return { out, realReleases };
}

test("COLD pass: one real defer then all remaining fast-defer (deadline-safe)", () => {
  const eight = Array.from({ length: 8 }, () => realColdDefer("india"));
  const { out, realReleases } = simulateLoop(eight);
  ok("exactly ONE account ran a real release", realReleases === 1);
  ok("the other 7 were fast-deferred", out.filter((o) => !o.ran).length === 7);
  ok("every account is classified deferred (SOURCE_READINESS_PENDING)", out.every((o) => isSharedCatalogColdDefer(o.served)));
});

test("WARM pass: every account publishes -> latch never engages, all run normally", () => {
  const warm = [published("india"), published("india"), published("india"), published("india")];
  const { out, realReleases } = simulateLoop(warm);
  ok("all 4 ran a real release (nothing fast-deferred on a warm pass)", realReleases === 4);
  ok("no account was fast-deferred", out.every((o) => o.ran));
  ok("nothing is classified a cold defer", out.every((o) => !isSharedCatalogColdDefer(o.served)));
});

test("MIXED pass: account-specific defers never latch; a later shared cold defer latches the rest", () => {
  const mixed = [acctSpecificDefer("india"), published("india"), realColdDefer("india"), acctSpecificDefer("india"), published("india")];
  const { out, realReleases } = simulateLoop(mixed);
  ok("first three ran (two non-latching + the cold defer itself)", out.slice(0, 3).every((o) => o.ran) && realReleases === 3);
  ok("the two accounts AFTER the cold defer were fast-deferred", out.slice(3).every((o) => !o.ran));
});

const run = async () => {
  for (const t of tests) { await t.fn(); }
  writeSync(1, `\noli-catalog-cold-latch: ${passed} assertions passed across ${tests.length} tests\n`);
};
run().catch((e) => { writeSync(2, String(e && e.stack || e) + "\n"); process.exit(1); });
