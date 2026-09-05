// Phase 2 -- Adaptive FBA Inventory batch-splitting (overflow self-heal) offline verification.
//
// Proves: the overflow-evidence derivation (multi-seller TRUNCATED -> isolate; single-seller TRUNCATED -> hard stop;
// recency/expiry); the planner isolation (byte-identical default; a proven-overflow inventory batch splits to
// single-seller children while EVERY other batch hash stays byte-identical; v3 inventory hashes match the FBA children);
// and the overflowSellers threading through buildShadowReportPlan + advanceFbaPlanBucket. ZERO DataDoe/network. 7-bit, LF.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { planFbaPlanBucketBatched, planListingHealthV3BucketBatched, buildShadowReportPlan } from "../lib/server/sync/report-planner.js";
import { advanceFbaPlanBucket } from "../lib/server/sync/fba-plan-operation.js";
import {
  defaultInventoryBatchesOf, overflowSellersFromTruncated, readRecentTruncatedInventoryHashes, DEFAULT_OVERFLOW_EVIDENCE_MAX_AGE_DAYS,
} from "../lib/server/sync/fba-inventory-overflow.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "report-fba-inventory-overflow\n");

const conns = [{ id: "primary", apiKey: "fixture-key", accountPrefix: "" }];
const asOf = "2026-09-05";
const IN8 = Array.from({ length: 8 }, (_, i) => ({ accountId: `in-${i}`, country: "IN", currency: "INR" }));
const invSrcsOf = (plan, key) => [...new Map(plan.flatMap((r) => r.sources.filter((s) => s.requestKey === key).map((s) => [s.requestHash, s]))).values()];

/* ===================== A. planner isolation: byte-identical default + [5]+[1,1,1] split ===================== */
const base = planFbaPlanBucketBatched({ accounts: IN8, connections: conns, asOfFor: () => asOf, inventoryAsOf: asOf });
const baseInv = invSrcsOf(base, "fba-plan:inventory-health");
const three = baseInv.find((s) => s.sellerOrVendorIds.length === 3).sellerOrVendorIds.map(String);
const fiveHash = baseInv.find((s) => s.sellerOrVendorIds.length === 5).requestHash;
const threeHash = baseInv.find((s) => s.sellerOrVendorIds.length === 3).requestHash;
(() => {
  const again = invSrcsOf(planFbaPlanBucketBatched({ accounts: IN8, connections: conns, asOfFor: () => asOf, inventoryAsOf: asOf, overflowSellers: new Set() }), "fba-plan:inventory-health");
  ok("A: empty overflow set is byte-identical (same inventory hash set)", JSON.stringify(baseInv.map((s) => s.requestHash).sort()) === JSON.stringify(again.map((s) => s.requestHash).sort()));
  const split = invSrcsOf(planFbaPlanBucketBatched({ accounts: IN8, connections: conns, asOfFor: () => asOf, inventoryAsOf: asOf, overflowSellers: new Set(three) }), "fba-plan:inventory-health");
  ok("A: the overflow [3] batch splits to three single-seller children ([5,1,1,1])", split.map((s) => s.sellerOrVendorIds.length).sort().join(",") === "1,1,1,5");
  ok("A: the untouched [5] batch hash is byte-identical", split.some((s) => s.requestHash === fiveHash && s.sellerOrVendorIds.length === 5));
  ok("A: the [3] parent hash is gone (fully split); three NEW single-seller child hashes exist", !split.some((s) => s.requestHash === threeHash) && split.filter((s) => s.sellerOrVendorIds.length === 1).length === 3);
  ok("A: each child is a strict, 50000-capped inventory export", split.filter((s) => s.sellerOrVendorIds.length === 1).every((s) => s.strict === true && s.limit === 50000));
})();

/* ===================== B. v3 inventory hashes match the FBA single-seller children ===================== */
(() => {
  const fbaChildren = invSrcsOf(planFbaPlanBucketBatched({ accounts: IN8, connections: conns, asOfFor: () => asOf, inventoryAsOf: asOf, overflowSellers: new Set(three) }), "fba-plan:inventory-health").filter((s) => s.sellerOrVendorIds.length === 1).map((s) => s.requestHash);
  const v3 = planListingHealthV3BucketBatched({ accounts: IN8, connections: conns, asOfFor: () => asOf, inventoryAsOf: asOf, overflowSellers: new Set(three) });
  const v3ChildInv = new Set(invSrcsOf(v3, "listing-health-v3:inventory").filter((s) => s.sellerOrVendorIds.length === 1).map((s) => s.requestHash));
  ok("B: v3 single-seller inventory hashes MATCH the FBA children (v3 reuse survives the split)", fbaChildren.length === 3 && fbaChildren.every((h) => v3ChildInv.has(h)));
  const v3Base = new Set(invSrcsOf(planListingHealthV3BucketBatched({ accounts: IN8, connections: conns, asOfFor: () => asOf, inventoryAsOf: asOf }), "listing-health-v3:inventory").map((s) => s.requestHash));
  const v3Empty = new Set(invSrcsOf(planListingHealthV3BucketBatched({ accounts: IN8, connections: conns, asOfFor: () => asOf, inventoryAsOf: asOf, overflowSellers: new Set() }), "listing-health-v3:inventory").map((s) => s.requestHash));
  ok("B: v3 empty overflow is byte-identical", JSON.stringify([...v3Base].sort()) === JSON.stringify([...v3Empty].sort()));
})();

/* ===================== C. unaffected batches (other India + other regions) stay byte-identical ===================== */
(() => {
  const mixed = [...IN8, ...Array.from({ length: 7 }, (_, i) => ({ accountId: `us-${i}`, country: "US", currency: "USD" }))];
  const baseMixed = planFbaPlanBucketBatched({ accounts: mixed, connections: conns, asOfFor: () => asOf, inventoryAsOf: asOf });
  const splitMixed = planFbaPlanBucketBatched({ accounts: mixed, connections: conns, asOfFor: () => asOf, inventoryAsOf: asOf, overflowSellers: new Set(three) });
  const baseNonOverflow = new Set(invSrcsOf(baseMixed, "fba-plan:inventory-health").filter((s) => !s.sellerOrVendorIds.map(String).some((x) => three.includes(x))).map((s) => s.requestHash));
  const splitHashes = new Set(invSrcsOf(splitMixed, "fba-plan:inventory-health").map((s) => s.requestHash));
  ok("C: every inventory batch NOT containing an overflow seller keeps its exact hash (US + other India untouched)", [...baseNonOverflow].every((h) => splitHashes.has(h)));
})();

/* ===================== D. overflow-evidence derivation (multi-seller -> isolate; single -> hard stop) ===================== */
(() => {
  const defaultInventoryBatches = [{ requestHash: fiveHash, sellerOrVendorIds: baseInv.find((s) => s.requestHash === fiveHash).sellerOrVendorIds }, { requestHash: threeHash, sellerOrVendorIds: three }];
  const r = overflowSellersFromTruncated({ defaultInventoryBatches, recentTruncatedHashes: new Set([threeHash]) });
  ok("D: a MULTI-seller TRUNCATED batch contributes all its sellers to the overflow set", r.overflowSellers.size === 3 && three.every((s) => r.overflowSellers.has(s)) && r.singleSellerHardStops.length === 0);
  ok("D: the succeeded [5] batch is NOT flagged overflow", ![...r.overflowSellers].some((s) => baseInv.find((x) => x.requestHash === fiveHash).sellerOrVendorIds.map(String).includes(s)));
  const single = overflowSellersFromTruncated({ defaultInventoryBatches: [{ requestHash: "h1", sellerOrVendorIds: ["solo"] }], recentTruncatedHashes: new Set(["h1"]) });
  ok("D: a SINGLE-seller TRUNCATED batch is a HARD STOP (never re-routed -> no recursive split)", single.overflowSellers.size === 0 && single.singleSellerHardStops.join() === "solo");
  ok("D: defaultInventoryBatchesOf extracts inventory batches (hash -> sellers) from a plan", defaultInventoryBatchesOf(base).length === 2);
})();

/* ===================== E. evidence reader: recency window + TRUNCATED-terminal-only filter ===================== */
await (async () => {
  let sawSince = null;
  const readRecentCycleIds = async (_cb, since) => { sawSince = since; return ["cyc-1"]; };
  const jobs = [
    { request_hash: threeHash, source_key: "fba-inventory-health", fetch_status: "failed", error_code: "TRUNCATED", terminal: true },
    { request_hash: fiveHash, source_key: "fba-inventory-health", fetch_status: "succeeded", error_code: null, terminal: false },
    { request_hash: "other", source_key: "listings", fetch_status: "failed", error_code: "TRUNCATED", terminal: true }, // wrong source -> ignored
    { request_hash: "nonterm", source_key: "fba-inventory-health", fetch_status: "failed", error_code: "TRUNCATED", terminal: false }, // not terminal -> ignored
  ];
  const hashes = await readRecentTruncatedInventoryHashes({ cycleBucket: "india-fba", now: () => Date.parse("2026-09-05T00:00:00Z"), readRecentCycleIds, readSourceJobs: async () => jobs });
  ok("E: only terminal TRUNCATED fba-inventory-health hashes are collected", hashes.size === 1 && hashes.has(threeHash));
  ok("E: the recency window (expiry) is applied (sinceDate = now - maxAgeDays)", sawSince === new Date(Date.parse("2026-09-05T00:00:00Z") - DEFAULT_OVERFLOW_EVIDENCE_MAX_AGE_DAYS * 86400000).toISOString().slice(0, 10));
  const empty = await readRecentTruncatedInventoryHashes({ cycleBucket: "india-fba", readRecentCycleIds: async () => [], readSourceJobs: async () => jobs });
  ok("E: no recent cycles (all expired) => empty evidence => default batching", empty.size === 0);
  const failSoft = await readRecentTruncatedInventoryHashes({ cycleBucket: "india-fba", readRecentCycleIds: async () => { throw new Error("db down"); }, readSourceJobs: async () => jobs });
  ok("E: a read failure fails soft to empty (never blocks planning)", failSoft.size === 0);
})();

/* ===================== F. threading: buildShadowReportPlan + advanceFbaPlanBucket forward overflowSellers ===================== */
(() => {
  const planned = buildShadowReportPlan({ accounts: IN8, reportKeys: ["fba-plan"], connections: conns, asOfFor: () => asOf, inventoryAsOf: asOf, overflowSellers: new Set(three) });
  const inv = invSrcsOf(planned.reportRequests, "fba-plan:inventory-health");
  ok("F: buildShadowReportPlan forwards overflowSellers to the FBA planner (split applied)", inv.filter((s) => s.sellerOrVendorIds.length === 1).length === 3);
})();

await (async () => {
  let forwarded = null;
  const fakeRuntime = { run: async (args) => { forwarded = args.overflowSellers; return { cycleId: null, drained: true }; }, store: { getCycleByBucketDate: async () => null, finalizeCycle: async () => ({ disposition: "finalized", cycle: { status: "succeeded" } }) } };
  const fakePublisher = { preflight: async () => ({}), publish: async () => ({ disposition: "already-current", liveReportKey: "fba-plan", paramsHash: "ph" }) };
  const fakeControls = { apply: async () => {}, close: async () => {} };
  // A non-empty bucket with a runtime that returns cycleId=null triggers the false-success guard AFTER forwarding the
  // run args -- which is all we assert here (that overflowSellers reached runtime.run).
  await advanceFbaPlanBucket({ bucket: "india", asOf, inventoryAsOf: asOf, includedIds: ["in-0"], bucketAccounts: [{ accountId: "in-0", country: "IN" }], cost: { tokens: 2 }, maxTokens: 6, runtime: fakeRuntime, publisher: fakePublisher, controls: fakeControls, readbackLive: async () => ({ ok: true }), overflowSellers: new Set(three), deadlineMs: Infinity, outOfTime: () => false });
  ok("F: advanceFbaPlanBucket forwards overflowSellers into runtime.run", forwarded instanceof Set && [...forwarded].sort().join() === [...three].sort().join());
})();

writeSync(1, `\nreport-fba-inventory-overflow: ${passed} assertions passed\n`);
