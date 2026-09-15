// Listings / Listings-Raw / FBA-Plan-AWD outbound DataDoe request contract: DATE-FREE, current-state.
//
// Listings and Listings Raw are current-state, DATE-FREE DataDoe sources: they must ALWAYS fetch the latest
// source state at export time. Their outbound request must carry NO date range/filter (from/to null), NO
// date-based order (order-by child_asin, never a date), and NO cycle date folded into the request identity/hash
// -- so the request_hash is byte-STABLE day to day even as the scheduler cycle date (D-1) advances. Freshness is
// carried by validated_at + that stable date-free hash, never by a date IN the request.
//
// This is the OUTBOUND-request half of the Listings freshness contract (the durable-adoption half lives in
// listing-health-v3-dependency-bundle.test.js). It exercises the REAL request builder (reportSourceRequestIdentity
// via reportSourceRequestHashes) with the EXACT window maps the planner emits (report-planner.js:534-536 for LHv3,
// :446-447 for fba-plan), for two different cycle dates, and proves:
//   (1) listing-health-v3:listings      request has no date filter/window/order        [mandatory test 1 + 4]
//   (2) listing-health-v3:listings-raw  request has no date filter/window/order        [mandatory test 2 + 4]
//   (3) fba-plan:awd                    request has no date filter/window/order        [mandatory test 3]
//   (5) a DIFFERENT scheduler cycle date does NOT change any of those request hashes,  [mandatory test 5]
//       while the DATED sibling (single-day D-1 FBA inventory) request hash DOES change -- proving the stability
//       is a real property, not a vacuous one where the date never mattered anywhere.
//   (9) D-1 stays REQUIRED for the dated FBA Inventory Health request (single-day from===to===asOf).  [mandatory test 9]
//
// NOTE on columns: LH_V3_LISTING_COLUMNS legitimately contains `listing_open_date` -- that is a per-listing DATA
// ATTRIBUTE returned by the current-state snapshot, NOT a date FILTER on the request. The contract forbids a date
// WINDOW / date ORDER / cycle date in the request identity; it does NOT forbid date-valued data columns. So these
// assertions check from/to/orderBy and that the cycle date does not appear in the request identity -- never "no
// column is named *date*". Offline; pure functions only.
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
process.env.POSTGRES_URL = "postgres://user:pass@localhost:5432/db";

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { reportSourceRequestHashes, REPORT_SOURCE_CONTRACTS } from "../lib/server/sync/report-source-contracts.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "listings-date-free-request-contract\n");

const API_KEY = "test-api-key";
const SELLER = "SELLER-RAW-1";
const MKT = "US"; // AWD-capable (US + EU5); listings/raw are marketplace-agnostic on the date contract.
const CYCLE_A = "2026-09-13"; // an EARLIER scheduler cycle D-1
const CYCLE_B = "2026-09-14"; // a LATER scheduler cycle D-1 (the stale-vs-fresh incident pair)

// Resolve one request row by requestKey from the REAL builder, using the planner's EXACT window maps.
function resolveOne({ reportKey, requestKey, windowsByRequestKey }) {
  const rows = reportSourceRequestHashes({ reportKey, apiKey: API_KEY, ids: [SELLER], windowsByRequestKey, marketplaceCountry: MKT });
  const row = rows.find((r) => r.requestKey === requestKey);
  assert.ok(row, `expected a resolved request row for ${requestKey}`);
  return row;
}

// The planner's LHv3 window map (report-planner.js:533-537): listings + listings-raw date-free, inventory single-day D-1.
const lhv3Windows = (cycleDate) => ({
  "listing-health-v3:listings": [{ from: null, to: null }],
  "listing-health-v3:listings-raw": [{ from: null, to: null }],
  "listing-health-v3:inventory": [{ from: cycleDate, to: cycleDate }],
});
// The planner's fba-plan window map (report-planner.js:446-447): inventory single-day D-1, AWD date-free.
const fbaWindows = (cycleDate) => ({
  "fba-plan:inventory-health": [{ from: cycleDate, to: cycleDate }],
  "fba-plan:awd": [{ from: null, to: null }],
});

// A resolved request is DATE-FREE iff: no from/to on the row OR in the folded request identity, order is not a date,
// and the cycle date does not appear anywhere in the request identity (which is exactly what the hash is taken over).
function assertDateFree(label, row, cycleDate) {
  ok(`${label}: from === null (no date range)`, row.from === null);
  ok(`${label}: to === null (no date range)`, row.to === null);
  ok(`${label}: requestMeta.from === null (no date folded into identity)`, row.requestMeta.from === null);
  ok(`${label}: requestMeta.to === null (no date folded into identity)`, row.requestMeta.to === null);
  ok(`${label}: order-by is child_asin, never a date`, row.options.orderByColumn === "child_asin" && row.requestMeta.orderByColumn === "child_asin");
  const identity = JSON.stringify(row.requestMeta);
  ok(`${label}: the cycle date ${cycleDate} does NOT appear in the request identity`, !identity.includes(cycleDate));
}

// ---- (1) listing-health-v3:listings is date-free [mandatory 1 + 4] ----
{
  const row = resolveOne({ reportKey: "listing-health-v3", requestKey: "listing-health-v3:listings", windowsByRequestKey: lhv3Windows(CYCLE_A) });
  assertDateFree("LHv3 listings", row, CYCLE_A);
}

// ---- (2) listing-health-v3:listings-raw is date-free [mandatory 2 + 4] ----
{
  const row = resolveOne({ reportKey: "listing-health-v3", requestKey: "listing-health-v3:listings-raw", windowsByRequestKey: lhv3Windows(CYCLE_A) });
  assertDateFree("LHv3 listings-raw", row, CYCLE_A);
}

// ---- (3) fba-plan:awd (Listings AWD Available/Inbound) is date-free [mandatory 3] ----
{
  const row = resolveOne({ reportKey: "fba-plan", requestKey: "fba-plan:awd", windowsByRequestKey: fbaWindows(CYCLE_A) });
  assertDateFree("FBA-plan AWD", row, CYCLE_A);
}

// ---- Contract-declaration lock: the registry itself declares these three no-date + child_asin order ----
{
  const v3 = REPORT_SOURCE_CONTRACTS["listing-health-v3"];
  const listings = v3.find((c) => c.requestKey === "listing-health-v3:listings");
  const raw = v3.find((c) => c.requestKey === "listing-health-v3:listings-raw");
  const awd = REPORT_SOURCE_CONTRACTS["fba-plan"].find((c) => c.requestKey === "fba-plan:awd");
  ok("contract: LHv3 listings windowKind is none + order child_asin", /^none\b/.test(listings.windowKind) && listings.orderByColumn === "child_asin");
  ok("contract: LHv3 listings-raw windowKind is none + order child_asin", /^none\b/.test(raw.windowKind) && raw.orderByColumn === "child_asin");
  ok("contract: fba-plan AWD windowKind is none + order child_asin", /^none\b/.test(awd.windowKind) && awd.orderByColumn === "child_asin");
}

// ---- (5) a different cycle date does NOT change the date-free request hashes (and DOES change the dated sibling) ----
{
  const lhA = reportSourceRequestHashes({ reportKey: "listing-health-v3", apiKey: API_KEY, ids: [SELLER], windowsByRequestKey: lhv3Windows(CYCLE_A), marketplaceCountry: MKT });
  const lhB = reportSourceRequestHashes({ reportKey: "listing-health-v3", apiKey: API_KEY, ids: [SELLER], windowsByRequestKey: lhv3Windows(CYCLE_B), marketplaceCountry: MKT });
  const hashOf = (rows, key) => rows.find((r) => r.requestKey === key).requestHash;

  ok("[5] LHv3 listings request_hash is IDENTICAL across cycle dates", hashOf(lhA, "listing-health-v3:listings") === hashOf(lhB, "listing-health-v3:listings"));
  ok("[5] LHv3 listings-raw request_hash is IDENTICAL across cycle dates", hashOf(lhA, "listing-health-v3:listings-raw") === hashOf(lhB, "listing-health-v3:listings-raw"));
  // Meaningful contrast: the DATED sibling (single-day D-1 inventory) request_hash MUST differ across cycle dates,
  // proving the cycle date genuinely flows into dated requests -- so listings' stability is a real property.
  ok("[5] LHv3 inventory (dated D-1) request_hash DIFFERS across cycle dates (meaningful control)", hashOf(lhA, "listing-health-v3:inventory") !== hashOf(lhB, "listing-health-v3:inventory"));

  const fbaA = reportSourceRequestHashes({ reportKey: "fba-plan", apiKey: API_KEY, ids: [SELLER], windowsByRequestKey: fbaWindows(CYCLE_A), marketplaceCountry: MKT });
  const fbaB = reportSourceRequestHashes({ reportKey: "fba-plan", apiKey: API_KEY, ids: [SELLER], windowsByRequestKey: fbaWindows(CYCLE_B), marketplaceCountry: MKT });
  ok("[5] fba-plan AWD request_hash is IDENTICAL across cycle dates", hashOf(fbaA, "fba-plan:awd") === hashOf(fbaB, "fba-plan:awd"));
  ok("[5] fba-plan inventory-health (dated D-1) request_hash DIFFERS across cycle dates (meaningful control)", hashOf(fbaA, "fba-plan:inventory-health") !== hashOf(fbaB, "fba-plan:inventory-health"));
}

// ---- (9) D-1 stays REQUIRED for the dated FBA Inventory Health request (single-day from===to===asOf) ----
{
  const v3inv = resolveOne({ reportKey: "listing-health-v3", requestKey: "listing-health-v3:inventory", windowsByRequestKey: lhv3Windows(CYCLE_B) });
  ok("[9] LHv3 inventory is dated single-day D-1 (from === to === cycle D-1)", v3inv.from === CYCLE_B && v3inv.to === CYCLE_B);
  ok("[9] LHv3 inventory folds the D-1 date INTO its request identity", v3inv.requestMeta.from === CYCLE_B && v3inv.requestMeta.to === CYCLE_B);
  const fbaInv = resolveOne({ reportKey: "fba-plan", requestKey: "fba-plan:inventory-health", windowsByRequestKey: fbaWindows(CYCLE_B) });
  ok("[9] fba-plan inventory-health is dated single-day D-1 (from === to === cycle D-1)", fbaInv.from === CYCLE_B && fbaInv.to === CYCLE_B);
}

writeSync(1, `\nlistings-date-free-request-contract: ${passed} assertions passed\n`);
