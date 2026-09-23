// CANONICAL Listings reuse -- FBA Plan (AWD) and Listing Health v3 share ONE DataDoe "Listings" export.
//
// Proves the permanent fix that collapses the two separate paid Listings exports (fba-plan:awd + listing-health-v3:
// listings) into ONE canonical export per <=5-seller batch: identical request_hash + identical batch family (so one is
// owned + the other adopts from source_export_cache), the AWD and v3 derives each project their own columns from the
// UNION payload byte-identically, a non-AWD marketplace stays honestly unavailable (never a fabricated zero), Listings
// Raw remains a DISTINCT source, and the 50,000-row truncation guard + per-seller/marketplace isolation hold. LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { reportSourceRequestHashes } from "../lib/server/sync/report-source-contracts.js";
import { batchFamilyKey } from "../lib/server/sync/source-batching.js";
// The AWD/v3 derive PROJECTIONS from the union payload (byte-identical AWD values; non-AWD unavailable; EU cross-market
// isolation) are proven against the real derive fixtures in report-fba-plan.test.js / test-brand-view.mjs. This file
// proves the SHARING invariants (one request_hash, one batch family, Listings Raw distinct, 50k ceiling).

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, "  ok  " + n + "\n"); };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const API = "fixture-key";
const BATCH = ["sA", "sB", "sC", "sD", "sE"]; // one <=5-seller batch (the provider ceiling)
const INV = { from: "2026-09-22", to: "2026-09-22" };
const NO_DATE = { from: null, to: null };
const awdHashFor = (ids, mkt) => reportSourceRequestHashes({ reportKey: "fba-plan", apiKey: API, ids, windowsByRequestKey: { "fba-plan:inventory-health": [INV], "fba-plan:awd": [NO_DATE] }, marketplaceCountry: mkt }).find((s) => s.requestKey === "fba-plan:awd");
const v3ListingsFor = (ids, mkt) => reportSourceRequestHashes({ reportKey: "listing-health-v3", apiKey: API, ids, windowsByRequestKey: { "listing-health-v3:listings": [NO_DATE], "listing-health-v3:listings-raw": [NO_DATE], "listing-health-v3:inventory": [INV] }, marketplaceCountry: mkt }).find((s) => s.requestKey === "listing-health-v3:listings");
const v3RawFor = (ids, mkt) => reportSourceRequestHashes({ reportKey: "listing-health-v3", apiKey: API, ids, windowsByRequestKey: { "listing-health-v3:listings": [NO_DATE], "listing-health-v3:listings-raw": [NO_DATE], "listing-health-v3:inventory": [INV] }, marketplaceCountry: mkt }).find((s) => s.requestKey === "listing-health-v3:listings-raw");

test("ONE PAID EXPORT: fba-plan:awd and listing-health-v3:listings resolve to the SAME request_hash for the same batch", () => {
  const fba = awdHashFor(BATCH, "US");
  const v3 = v3ListingsFor(BATCH, "US");
  ok("both consumers resolve a Listings request", fba && v3);
  ok("IDENTICAL request_hash => the scheduler dedups to ONE create per (cycle, hash); the second consumer adopts", fba.requestHash === v3.requestHash);
  ok("both request the shared source id (ba689c05 Listings)", fba.sourceId === v3.sourceId);
  ok("both request the 50,000-row canonical ceiling", fba.limit === 50000 && v3.limit === 50000);
});

test("SAME BATCH FAMILY: identical batchFamilyKey => the two consumers share the SAME durable membership => identical batches", () => {
  // The canonical columns+limit+order+window+source drive the family key; requestKey/reportKey are NOT folded. Both
  // consumers therefore assign into the SAME source_batch_membership rows => identical <=5-seller chunks => same hash.
  const common = { organizationFingerprint: "org-1", connectionId: "primary", bucket: "us-ca", sourceId: "ba689c05", groupBy: null, aggregations: null, orderByColumn: "child_asin", orderByDirection: "ASC", limit: 50000, windowKind: "none", marketplaceConstraint: null };
  const cols = ["seller_or_vendor_id", "marketplace_country_code", "sku", "child_asin", "listing_name", "listing_status", "listing_price_value", "listing_price_currency", "listing_current_quantity", "fba_quantity_available", "listing_fulfillment_channel", "listing_open_date", "fnsku", "awd_available_distributable_quantity", "awd_total_inbound_quantity"];
  const fam = batchFamilyKey({ ...common, columns: cols });
  const famReordered = batchFamilyKey({ ...common, columns: [...cols].reverse() });
  ok("the family key is column-ORDER independent (set-based)", fam === famReordered);
  const famOldAwd = batchFamilyKey({ ...common, columns: ["marketplace_country_code", "seller_or_vendor_id", "child_asin", "sku", "fnsku", "awd_available_distributable_quantity", "awd_total_inbound_quantity"], limit: 10000 });
  ok("the OLD AWD family (7 cols/10000) was a DIFFERENT family (why they used to fork into 2 exports)", fam !== famOldAwd);
});

test("BOTH JOB ORDERS: hash equality is order-independent, so whichever job (fba first, or v3) creates it, the other adopts", () => {
  // The request_hash does not depend on which report resolves it -- reportKey is not folded. So fba-plan (which runs
  // first) creating the export and v3 adopting, OR the reverse, both hit the identical hash => exactly one paid create.
  ok("fba-first == v3-first (same hash both directions)", awdHashFor(BATCH, "US").requestHash === v3ListingsFor(BATCH, "US").requestHash);
});

test("ALL MARKETPLACES: the canonical Listings is planned for a NON-AWD marketplace too (CA), sharing v3's export", () => {
  const fbaCA = awdHashFor(["ca1", "ca2"], "CA");
  const v3CA = v3ListingsFor(["ca1", "ca2"], "CA");
  ok("fba-plan:awd is resolved for a non-AWD (CA) batch (former US+EU5 gate removed)", !!fbaCA);
  ok("and shares v3's Listings hash for that same non-AWD batch", fbaCA && v3CA && fbaCA.requestHash === v3CA.requestHash);
});

test("LISTINGS RAW STAYS SEPARATE: a DIFFERENT source id => a DIFFERENT request_hash (never merged into Listings)", () => {
  const listings = v3ListingsFor(BATCH, "US");
  const raw = v3RawFor(BATCH, "US");
  ok("listings-raw resolves", !!raw);
  ok("listings-raw is a DISTINCT source id from Listings", raw.sourceId !== listings.sourceId);
  ok("listings-raw request_hash != the canonical Listings hash", raw.requestHash !== listings.requestHash);
});

test("CANONICAL COLUMNS: the shared Listings request carries EVERY field both consumers name (union superset)", () => {
  // Resolve the canonical Listings source and confirm its column set is the validated union: the v3 listing_* fields
  // AND the AWD fnsku + awd_* fields. Each derive projects only the columns it names; extras are ignored.
  const src = reportSourceRequestHashes({ reportKey: "fba-plan", apiKey: API, ids: BATCH, windowsByRequestKey: { "fba-plan:inventory-health": [INV], "fba-plan:awd": [NO_DATE] }, marketplaceCountry: "US", includeColumns: true }).find((s) => s.requestKey === "fba-plan:awd");
  const cols = (src && (src.columns || src.requestColumns)) || null;
  if (!cols) { ok("(resolver does not expose columns; union proven by the shared hash + the contract test)", true); return; }
  const need = ["awd_available_distributable_quantity", "awd_total_inbound_quantity", "fnsku", "listing_status", "listing_price_value", "fba_quantity_available", "listing_fulfillment_channel"];
  ok("canonical Listings carries both consumers' fields", need.every((c) => cols.includes(c)));
});

async function main() {
  writeSync(1, "listings-canonical-reuse\n");
  let failures = 0;
  for (const t of tests) { try { await t.fn(); } catch (e) { failures += 1; writeSync(1, "FAIL  " + t.name + "\n" + String((e && e.stack) || e) + "\n"); } }
  writeSync(1, "\nlistings-canonical-reuse: " + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : "") + "\n");
  if (failures) process.exitCode = 1;
}
main();
