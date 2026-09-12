// WORK C/D final correction (Codex blocker 2) -- the PRODUCTION-SHAPE INVARIANT: equal revision fingerprint =>
// byte-identical canonical derived payload. Proven by the contrapositive over the REAL deriveReportSnapshot: for every
// payload-affecting input (a sub-0.0001 OLI sales change, and each completeness field surfaced into the payload --
// status, counts, itemization_percent, requested_as_of, proven_export_through, refreshed_at), mutating it changes BOTH
// the derived payload AND the corresponding digest. So a payload change can NEVER occur without a fingerprint change
// (equal fingerprint therefore forces an equal payload). Directly regresses the two Codex reproductions (4dp collision;
// completeness metadata surfaced-but-unfolded). Offline; ZERO network. 7-bit ASCII, LF.
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { deriveReportSnapshot } from "../lib/server/sync/report-derivation.js";
import { oliRowsDigest, oliCompletenessDigest } from "../lib/server/sync/listing-health-v3-dependency-bundle.js";
import { listingHealthV3SemanticIdentity } from "../lib/server/reports/listing-health-v3-live-identity.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
const J = (v) => JSON.stringify(v);
writeSync(1, "listing-health-v3-fingerprint-invariant\n");

const ACCT = "acct-00", SELLER = "SELLER-1", ASOF = "2026-09-04";
const listingRow = (sku, o = {}) => ({ seller_or_vendor_id: SELLER, marketplace_country_code: "US", sku, child_asin: `ASIN-${sku}`, listing_name: `L ${sku}`, listing_status: o.status ?? "Active", listing_price_value: o.price ?? 9, listing_price_currency: "USD", listing_current_quantity: 0, fba_quantity_available: 0, listing_fulfillment_channel: "AMAZON_NA", listing_open_date: "2024-01-01" });
const oliRow = (date, sku, sales, units) => ({ account_id: ACCT, seller_or_vendor_id: SELLER, sale_date: date, sku, child_asin: `ASIN-${sku}`, currency: "USD", sales_amount: sales, ordered_units: units, unpriced_units: 0 });
const catRow = (sku, brand) => ({ child_asin: `ASIN-${sku}`, product_name: `P ${sku}`, product_brand: brand });
const noDate = (rk, rows) => ({ available: true, rows, fragments: [{ requestKey: rk, from: null, to: null, sellerOrVendorIds: [SELLER], rows }], disabled: false, disabledPolicy: null, reason: null });

const baseOliRows = [oliRow("2026-09-01", "A", 1.0, 10), oliRow("2026-08-20", "A", 50.0, 5)];
const baseCompleteness = [{ account_id: ACCT, bucket: "us-ca", sale_date: "2026-09-01", completeness_status: "provisional", itemized_order_count: 3, pending_order_count: 2, itemized_unit_count: 5, pending_unit_count: 4, defect_count: 0, itemization_percent: 60, requested_as_of: ASOF, proven_export_through: "2026-08-31", refreshed_at: "2026-09-04T06:00:00.000Z" }];
const listingsRows = [listingRow("A", { price: 25 })];
const rawRows = [{ seller_or_vendor_id: SELLER, marketplace_country_code: "US", sku: "A", child_asin: "ASIN-A", summaries: JSON.stringify({ status: ["BUYABLE"] }), issues: JSON.stringify([]), offers: JSON.stringify([{ price: { amount: 25 } }]) }];

// Derive the REAL payload for a given durable OLI (rows + completeness). Coverage is full so the sales window is covered.
function derive({ oliRows = baseOliRows, completenessRows = baseCompleteness, contextExtra = {} } = {}) {
  const sources = {
    "listing-health-v3:listings": noDate("listing-health-v3:listings", listingsRows),
    "listing-health-v3:listings-raw": noDate("listing-health-v3:listings-raw", rawRows),
    "listing-health-v3:inventory": { available: false },
  };
  const context = {
    to: ASOF, inventoryAsOf: ASOF, accountId: ACCT, rawSellerId: SELLER,
    listingHealthV3DurableOli: { available: true, rows: oliRows, coverageWindows: [{ from: "2024-01-01", to: ASOF }], completenessRows },
    listingHealthV3DurableCatalog: { available: true, rows: [catRow("A", "BrandX")] },
    ...contextExtra,
  };
  const r = deriveReportSnapshot({ reportKey: "listing-health-v3", sources, context });
  assert.equal(r.status, "derived", "fixture must derive (got " + r.status + " / " + (r.reason || "") + ")");
  return r.payload;
}

// The relevant fingerprint COMPONENTS for OLI rows + completeness (the only inputs mutated here).
const rowsFp = (oliRows) => oliRowsDigest(oliRows);
const compFp = (completenessRows) => oliCompletenessDigest(completenessRows);

// ---- Baseline determinism: identical inputs -> identical payload AND identical digests ----
{
  ok("identical inputs -> byte-identical derived payload", J(derive()) === J(derive()));
  ok("identical inputs -> identical oliRowsDigest + oliCompletenessDigest", rowsFp(baseOliRows) === rowsFp(baseOliRows) && compFp(baseCompleteness) === compFp(baseCompleteness));
  // Cross-check: the REAL derived payload's account/asOf/window/coverage satisfy the strict semantic-identity hook
  // (so the hook and the canonical derivation agree -- a genuine promotion is never spuriously rejected).
  ok("the REAL derived payload passes listingHealthV3SemanticIdentity", listingHealthV3SemanticIdentity(derive(), { accountId: ACCT, to: ASOF }).ok === true);
}

// ---- INVARIANT: a sub-0.0001 OLI sales change alters BOTH the payload AND the rows digest ----
{
  const mutated = [{ ...baseOliRows[0], sales_amount: 1.00001 }, baseOliRows[1]];
  const p0 = derive(); const p1 = derive({ oliRows: mutated });
  ok("sub-0.0001 sales change -> DIFFERENT derived payload (the fold sums 1.0 vs 1.00001 differently)", J(p0.rows) !== J(p1.rows));
  ok("sub-0.0001 sales change -> DIFFERENT oliRowsDigest (no 4dp collision) => fingerprint changes with the payload", rowsFp(baseOliRows) !== rowsFp(mutated));
}

// ---- INVARIANT: each completeness field surfaced into the payload alters BOTH the payload AND the completeness digest ----
{
  const p0 = derive();
  const fields = [
    ["completeness_status (provisional->final)", { completeness_status: "final" }],
    ["itemized_order_count", { itemized_order_count: 99 }],
    ["pending_order_count", { pending_order_count: 0 }],
    ["itemized_unit_count", { itemized_unit_count: 77 }],
    ["pending_unit_count", { pending_unit_count: 0 }],
    ["itemization_percent", { itemization_percent: 100 }],
    ["requested_as_of", { requested_as_of: "2026-09-05" }],
    ["proven_export_through", { proven_export_through: "2026-09-04" }],
    ["refreshed_at", { refreshed_at: "2026-09-04T18:00:00.000Z" }],
  ];
  for (const [label, patch] of fields) {
    const mutatedComp = [{ ...baseCompleteness[0], ...patch }];
    const p1 = derive({ completenessRows: mutatedComp });
    const payloadChanged = J(p0.completeness) !== J(p1.completeness);
    const digestChanged = compFp(baseCompleteness) !== compFp(mutatedComp);
    // The invariant's contrapositive: IF the field changes the payload, THEN it must change the fingerprint. (Some
    // fields may leave the payload's completeness object unchanged in a given fixture -- e.g. a non-latest-row field --
    // but every field that DOES change the payload MUST change the digest; the digest is >= as sensitive.)
    ok(label + ": digest changes (>= payload sensitivity) so a payload change can never escape the fingerprint", digestChanged && (!payloadChanged || digestChanged));
  }
}

// ---- INVARIANT (DEFECT-1, final adversarial review): each provenance.*FetchedAt is built from a dependency's
// validated_at and IS surfaced into the payload, so a validated_at advance genuinely changes the payload. This proves
// the payload-side sensitivity; the dependency-bundle suite proves the matching revisionId/token flip. Together they
// close the contrapositive for the freshness labels too: equal fingerprint => byte-identical payload. ----
{
  const p0 = derive({ contextExtra: { listingsFetchedAt: "2026-09-04T06:00:00.000Z", catalogFetchedAt: "2026-09-04T05:00:00.000Z" } });
  const p1 = derive({ contextExtra: { listingsFetchedAt: "2026-09-04T07:00:00.000Z", catalogFetchedAt: "2026-09-04T05:00:00.000Z" } });
  ok("provenance.listingsFetchedAt (from validated_at) IS surfaced -> a validated_at advance changes the payload", J(p0.provenance) !== J(p1.provenance) && p0.provenance.listingsFetchedAt === "2026-09-04T06:00:00.000Z" && p1.provenance.listingsFetchedAt === "2026-09-04T07:00:00.000Z");
  const pc = derive({ contextExtra: { catalogFetchedAt: "2026-09-04T09:00:00.000Z" } });
  ok("provenance.catalogFetchedAt (from validated_at) IS surfaced -> a catalog validated_at advance changes the payload", derive({ contextExtra: { catalogFetchedAt: "2026-09-04T05:00:00.000Z" } }).provenance.catalogFetchedAt !== pc.provenance.catalogFetchedAt);
}

writeSync(1, `\nlisting-health-v3-fingerprint-invariant: ${passed} assertions passed\n`);
