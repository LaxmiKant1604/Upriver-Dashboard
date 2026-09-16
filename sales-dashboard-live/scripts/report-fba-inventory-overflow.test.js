// Adaptive FBA Inventory batch-splitting (overflow self-heal) offline verification.
//
// Proves: the OWNERSHIP-based overflow-evidence derivation (multi-seller TRUNCATED -> isolate; single-seller TRUNCATED
// -> hard stop; hard-stop precedence; recency/expiry; org/connection/source scope; membership changes; and -- the
// REPRODUCED DEFECT -- survival across the daily inventory-date rollover D -> D+1); the planner isolation (byte-
// identical default; a proven-overflow inventory batch splits to single-seller children while EVERY other batch hash
// stays byte-identical; v3 inventory hashes match the FBA children); and the overflowSellers threading through
// buildShadowReportPlan + advanceFbaPlanBucket. ZERO DataDoe/network. 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { planFbaPlanBucketBatched, planListingHealthV3BucketBatched, buildShadowReportPlan } from "../lib/server/sync/report-planner.js";
import { advanceFbaPlanBucket } from "../lib/server/sync/fba-plan-operation.js";
import { accountScopeHash } from "../lib/server/source-identity.js";
import {
  defaultInventoryBatchesOf, overflowSellersFromTruncated, readRecentTruncatedInventoryOwnership, DEFAULT_OVERFLOW_EVIDENCE_MAX_AGE_DAYS,
  isSingleDayOverflowEvidence,
} from "../lib/server/sync/fba-inventory-overflow.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "report-fba-inventory-overflow\n");

const conns = [{ id: "primary", apiKey: "fixture-key", accountPrefix: "" }];
const asOf = "2026-09-05";
const IN8 = Array.from({ length: 8 }, (_, i) => ({ accountId: `in-${i}`, country: "IN", currency: "INR" }));
const invSrcsOf = (plan, key) => [...new Map(plan.flatMap((r) => r.sources.filter((s) => s.requestKey === key).map((s) => [s.requestHash, s]))).values()];
// The DURABLE ownership of a truncated batch: its members' individual scope hashes (= accountScopeHash([rawSellerId]),
// EXACTLY what the plan writes to owner.accountScopeHash and what sync_source_job_owners.account_scope_hash stores).
const ownershipOf = (...sellerBatches) => sellerBatches.map((sellers) => ({ scopeHashes: sellers.map((s) => accountScopeHash([String(s)])) }));

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

/* ===================== D. OWNERSHIP-based derivation (multi -> isolate; single -> hard stop; precedence) =========== */
(() => {
  const fiveSellers = baseInv.find((s) => s.requestHash === fiveHash).sellerOrVendorIds.map(String);
  const defaultInventoryBatches = [{ requestHash: fiveHash, sellerOrVendorIds: fiveSellers }, { requestHash: threeHash, sellerOrVendorIds: three }];
  const r = overflowSellersFromTruncated({ defaultInventoryBatches, truncatedOwnership: ownershipOf(three) });
  ok("D: a MULTI-seller TRUNCATED batch (resolved by owner scope hashes) marks all its sellers overflow", r.overflowSellers.size === 3 && three.every((s) => r.overflowSellers.has(s)) && r.singleSellerHardStops.length === 0);
  ok("D: the succeeded [5] batch is NOT flagged overflow (its sellers never truncated)", !fiveSellers.some((s) => r.overflowSellers.has(s)));
  const single = overflowSellersFromTruncated({ defaultInventoryBatches: [{ requestHash: "hX", sellerOrVendorIds: ["solo"] }], truncatedOwnership: ownershipOf(["solo"]) });
  ok("D: a SINGLE-seller TRUNCATED batch is a HARD STOP (never re-routed -> no recursive split)", single.overflowSellers.size === 0 && single.singleSellerHardStops.join() === "solo");
  // Hard-stop precedence: a seller that truncated ALONE (single) AND in an older multi batch stays a hard stop.
  const prec = overflowSellersFromTruncated({ defaultInventoryBatches: [{ requestHash: "h", sellerOrVendorIds: ["a", "b"] }], truncatedOwnership: ownershipOf(["a", "b"], ["a"]) });
  ok("D: hard-stop precedence -- a seller truncated alone is a hard stop even if also in a multi batch", prec.singleSellerHardStops.includes("a") && !prec.overflowSellers.has("a") && prec.overflowSellers.has("b"));
  ok("D: defaultInventoryBatchesOf extracts inventory batches (hash -> sellers) from a plan", defaultInventoryBatchesOf(base).length === 2);
})();

/* ===================== E. MEMBERSHIP CHANGE + SCOPE ISOLATION (only current, in-scope sellers isolate) =========== */
(() => {
  // A truncated batch {s1,s2,s3}; the CURRENT plan has {s1,s2,newX} (s3 departed, newX joined, never truncated).
  const [s1, s2, s3] = three;
  const current = [{ requestHash: "cur", sellerOrVendorIds: [s1, s2, "newX"] }];
  const r = overflowSellersFromTruncated({ defaultInventoryBatches: current, truncatedOwnership: ownershipOf([s1, s2, s3]) });
  ok("E: a DEPARTED seller (in the truncated batch but not the current plan) is ignored", !r.overflowSellers.has(s3));
  ok("E: a NEW seller (in the current plan but never truncated) is NOT isolated", !r.overflowSellers.has("newX"));
  ok("E: the STILL-PRESENT truncated sellers ARE isolated (membership change followed)", r.overflowSellers.has(s1) && r.overflowSellers.has(s2) && r.overflowSellers.size === 2);
  // Scope isolation: ownership for a DIFFERENT set of sellers must not leak into this bucket's overflow.
  const other = overflowSellersFromTruncated({ defaultInventoryBatches: current, truncatedOwnership: ownershipOf(["z1", "z2"]) });
  ok("E: another org/region's truncation (disjoint sellers) never marks THIS bucket's sellers overflow", other.overflowSellers.size === 0);
})();

/* ===================== F. THE REPRODUCED DEFECT: overflow survives the inventory-date rollover D -> D+1 =========== */
(() => {
  const dayD = "2026-09-05";
  const dayD1 = "2026-09-06";
  const invD = invSrcsOf(planFbaPlanBucketBatched({ accounts: IN8, connections: conns, asOfFor: () => dayD, inventoryAsOf: dayD }), "fba-plan:inventory-health");
  const invD1 = invSrcsOf(planFbaPlanBucketBatched({ accounts: IN8, connections: conns, asOfFor: () => dayD1, inventoryAsOf: dayD1 }), "fba-plan:inventory-health");
  const batchD = invD.find((s) => s.sellerOrVendorIds.length === 3);
  const batchD1 = invD1.find((s) => s.sellerOrVendorIds.length === 3);
  const sellersD = batchD.sellerOrVendorIds.map(String);
  // PROVE the date-dependence that broke the OLD hash comparison: same sellers, the request hash CHANGES D -> D+1.
  ok("F: the inventory batch hash CHANGES across the date rollover (identical sellers, D vs D+1)", batchD.requestHash !== batchD1.requestHash && JSON.stringify(sellersD.sort()) === JSON.stringify(batchD1.sellerOrVendorIds.map(String).sort()));
  // The truncation happened on day D (its owner scope hashes are date-INDEPENDENT). Resolve overflow against the
  // CURRENT (D+1) plan: the OLD hash-match yielded EMPTY here (hash_D != hash_{D+1}); the ownership match still fires.
  const r = overflowSellersFromTruncated({ defaultInventoryBatches: defaultInventoryBatchesOf(invD1.map((s) => ({ sources: [s] }))), truncatedOwnership: ownershipOf(sellersD) });
  ok("F: overflow STILL resolves the 3 sellers on D+1 (the daily-empty regression is fixed)", r.overflowSellers.size === 3 && sellersD.every((s) => r.overflowSellers.has(s)));
})();

/* ===================== G. ownership reader: TRUNCATED filter + source/connection/org scope + recency + fail-soft === */
await (async () => {
  const sh = (s) => accountScopeHash([s]);
  let sawSince = null;
  const readRecentCycleIds = async (_cb, since) => { sawSince = since; return ["cyc-1"]; };
  const jobs = [
    { request_hash: "H3", source_key: "fba-inventory-health", fetch_status: "failed", error_code: "TRUNCATED", terminal: true },
    { request_hash: "H5", source_key: "fba-inventory-health", fetch_status: "succeeded", error_code: null, terminal: false }, // succeeded -> not evidence
    { request_hash: "HL", source_key: "listings", fetch_status: "failed", error_code: "TRUNCATED", terminal: true },          // wrong source -> ignored
    { request_hash: "HN", source_key: "fba-inventory-health", fetch_status: "failed", error_code: "TRUNCATED", terminal: false }, // not terminal -> ignored
  ];
  const owners = [
    { request_hash: "H3", request_key: "fba-plan:inventory-health", account_id: "a1", account_scope_hash: sh("s1"), connection_id: "primary", organization_fingerprint: "ORG", owner_status: "active" },
    { request_hash: "H3", request_key: "fba-plan:inventory-health", account_id: "a2", account_scope_hash: sh("s2"), connection_id: "primary", organization_fingerprint: "ORG", owner_status: "active" },
    { request_hash: "H3", request_key: "fba-plan:awd", account_id: "a3", account_scope_hash: sh("sAWD"), connection_id: "primary", organization_fingerprint: "ORG", owner_status: "active" }, // wrong request_key
    { request_hash: "H3", request_key: "fba-plan:inventory-health", account_id: "a4", account_scope_hash: sh("sStale"), connection_id: "primary", organization_fingerprint: "ORG", owner_status: "stale" }, // stale
    { request_hash: "H3", request_key: "fba-plan:inventory-health", account_id: "a5", account_scope_hash: sh("sConn"), connection_id: "dd-secondary", organization_fingerprint: "ORG", owner_status: "active" }, // wrong connection
    { request_hash: "H3", request_key: "fba-plan:inventory-health", account_id: "a6", account_scope_hash: sh("sOrg"), connection_id: "primary", organization_fingerprint: "OTHER", owner_status: "active" }, // wrong org
    { request_hash: "H5", request_key: "fba-plan:inventory-health", account_id: "a7", account_scope_hash: sh("s5"), connection_id: "primary", organization_fingerprint: "ORG", owner_status: "active" }, // succeeded batch -> excluded
  ];
  const own = await readRecentTruncatedInventoryOwnership({ cycleBucket: "india-fba", now: () => Date.parse("2026-09-05T00:00:00Z"), connectionId: "primary", organizationFingerprint: "ORG", readRecentCycleIds, readSourceJobs: async () => jobs, readOwners: async () => owners });
  ok("G: exactly ONE truncated inventory batch resolved (H3); the succeeded batch is not evidence", own.length === 1 && own[0].requestHash === "H3");
  ok("G: only the in-scope inventory owners are kept (s1,s2); awd/stale/wrong-connection/wrong-org excluded", JSON.stringify([...own[0].scopeHashes].sort()) === JSON.stringify([sh("s1"), sh("s2")].sort()));
  ok("G: the recency window (expiry) is applied (sinceDate = now - maxAgeDays)", sawSince === new Date(Date.parse("2026-09-05T00:00:00Z") - DEFAULT_OVERFLOW_EVIDENCE_MAX_AGE_DAYS * 86400000).toISOString().slice(0, 10));
  const empty = await readRecentTruncatedInventoryOwnership({ cycleBucket: "india-fba", readRecentCycleIds: async () => [], readSourceJobs: async () => jobs, readOwners: async () => owners });
  ok("G: no recent cycles (all expired) => empty evidence => default batching", empty.length === 0);
  const failSoft = await readRecentTruncatedInventoryOwnership({ cycleBucket: "india-fba", readRecentCycleIds: async () => { throw new Error("db down"); }, readSourceJobs: async () => jobs, readOwners: async () => owners });
  ok("G: a read failure fails soft to empty (never blocks planning)", failSoft.length === 0);
  const ownerFail = await readRecentTruncatedInventoryOwnership({ cycleBucket: "india-fba", now: () => Date.parse("2026-09-05T00:00:00Z"), readRecentCycleIds, readSourceJobs: async () => jobs, readOwners: async () => { throw new Error("owner read boom"); } });
  ok("G: an OWNER read failure fails soft (that cycle yields no ownership, never throws)", ownerFail.length === 0);
})();

/* ===== G2. WINDOW-SHAPE COMPATIBILITY: a multi-day-window truncation is NOT single-day-overflow evidence ========= */
await (async () => {
  // Pure predicate.
  ok("G2: single-day truncation (from==to) IS trusted", isSingleDayOverflowEvidence({ request_meta: { from: "2026-09-05", to: "2026-09-05" } }) === true);
  ok("G2: multi-day-window truncation (from<to) is EXCLUDED", isSingleDayOverflowEvidence({ request_meta: { from: "2026-08-26", to: "2026-09-05" } }) === false);
  ok("G2: missing window metadata preserves old behaviour (trusted)", isSingleDayOverflowEvidence({ request_hash: "H" }) === true);
  ok("G2: malformed window dates preserve old behaviour (trusted)", isSingleDayOverflowEvidence({ request_meta: { from: "nope", to: "2026-09-05" } }) === true);

  // Reader integration: the SAME truncated hash, once with a legacy 10-day window and once single-day.
  const sh = (s) => accountScopeHash([s]);
  const readRecentCycleIds = async () => ["cyc-1"];
  const owners = [
    { request_hash: "HW", request_key: "fba-plan:inventory-health", account_id: "a1", account_scope_hash: sh("s1"), connection_id: "primary", organization_fingerprint: "ORG", owner_status: "active" },
    { request_hash: "HW", request_key: "fba-plan:inventory-health", account_id: "a2", account_scope_hash: sh("s2"), connection_id: "primary", organization_fingerprint: "ORG", owner_status: "active" },
    { request_hash: "HD", request_key: "fba-plan:inventory-health", account_id: "a3", account_scope_hash: sh("s3"), connection_id: "primary", organization_fingerprint: "ORG", owner_status: "active" },
    { request_hash: "HD", request_key: "fba-plan:inventory-health", account_id: "a4", account_scope_hash: sh("s4"), connection_id: "primary", organization_fingerprint: "ORG", owner_status: "active" },
  ];
  const base = { source_key: "fba-inventory-health", fetch_status: "failed", error_code: "TRUNCATED", terminal: true };
  const jobs = [
    { ...base, request_hash: "HW", request_meta: { from: "2026-08-26", to: "2026-09-05" } }, // 10-day WINDOW -> excluded
    { ...base, request_hash: "HD", request_meta: { from: "2026-09-05", to: "2026-09-05" } }, // SINGLE-DAY -> trusted
  ];
  const own = await readRecentTruncatedInventoryOwnership({ cycleBucket: "india-fba", now: () => Date.parse("2026-09-06T00:00:00Z"), connectionId: "primary", organizationFingerprint: "ORG", readRecentCycleIds, readSourceJobs: async () => jobs, readOwners: async () => owners });
  ok("G2: only the SINGLE-DAY truncated export (HD) is trusted evidence; the window one (HW) is excluded", own.length === 1 && own[0].requestHash === "HD");
  ok("G2: the window-truncation members (s1,s2) are NOT isolated; only the single-day members (s3,s4) are", JSON.stringify([...own[0].scopeHashes].sort()) === JSON.stringify([sh("s3"), sh("s4")].sort()));

  // India reproduction: the three real single-day sellers, isolated ONLY because a 10-day-window export truncated,
  // are freed once window truncations are excluded -> the canonical [5,3] plan (no single-seller split).
  const three = ["seller-e5ce", "seller-fd76", "seller-d658"];
  const windowTruncOwners = three.map((s, i) => ({ request_hash: "HWIN", request_key: "fba-plan:inventory-health", account_id: `ia${i}`, account_scope_hash: sh(s), connection_id: "primary", organization_fingerprint: "ORG", owner_status: "active" }));
  const windowTruncJobs = [{ ...base, request_hash: "HWIN", request_meta: { from: "2026-08-26", to: "2026-09-05" } }];
  const repro = await readRecentTruncatedInventoryOwnership({ cycleBucket: "india-fba", now: () => Date.parse("2026-09-16T00:00:00Z"), connectionId: "primary", organizationFingerprint: "ORG", readRecentCycleIds, readSourceJobs: async () => windowTruncJobs, readOwners: async () => windowTruncOwners });
  const reproBatches = defaultInventoryBatchesOf([{ sources: [{ requestKey: "fba-plan:inventory-health", requestHash: "cur", sellerOrVendorIds: three }] }]);
  const reproOverflow = overflowSellersFromTruncated({ defaultInventoryBatches: reproBatches, truncatedOwnership: repro });
  ok("G2: India repro -> a legacy 10-day-window truncation isolates ZERO single-day sellers (4->2 exports fixed)", repro.length === 0 && reproOverflow.overflowSellers.size === 0);
})();

/* ===================== H. threading: buildShadowReportPlan + advanceFbaPlanBucket forward overflowSellers ========= */
(() => {
  const planned = buildShadowReportPlan({ accounts: IN8, reportKeys: ["fba-plan"], connections: conns, asOfFor: () => asOf, inventoryAsOf: asOf, overflowSellers: new Set(three) });
  const inv = invSrcsOf(planned.reportRequests, "fba-plan:inventory-health");
  ok("H: buildShadowReportPlan forwards overflowSellers to the FBA planner (split applied)", inv.filter((s) => s.sellerOrVendorIds.length === 1).length === 3);
})();

await (async () => {
  let forwarded = null;
  const fakeRuntime = { run: async (args) => { forwarded = args.overflowSellers; return { cycleId: null, drained: true }; }, store: { getCycleByBucketDate: async () => null, finalizeCycle: async () => ({ disposition: "finalized", cycle: { status: "succeeded" } }) } };
  const fakePublisher = { preflight: async () => ({}), publish: async () => ({ disposition: "already-current", liveReportKey: "fba-plan", paramsHash: "ph" }) };
  const fakeControls = { apply: async () => {}, close: async () => {} };
  await advanceFbaPlanBucket({ bucket: "india", asOf, inventoryAsOf: asOf, includedIds: ["in-0"], bucketAccounts: [{ accountId: "in-0", country: "IN" }], cost: { tokens: 2 }, maxTokens: 6, runtime: fakeRuntime, publisher: fakePublisher, controls: fakeControls, readbackLive: async () => ({ ok: true }), overflowSellers: new Set(three), deadlineMs: Infinity, outOfTime: () => false });
  ok("H: advanceFbaPlanBucket forwards overflowSellers into runtime.run", forwarded instanceof Set && [...forwarded].sort().join() === [...three].sort().join());
})();

writeSync(1, `\nreport-fba-inventory-overflow: ${passed} assertions passed\n`);
