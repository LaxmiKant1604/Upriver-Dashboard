// WORK C/D correction -- the COMPLETE dependency manifest + fingerprint + FULL pointer/payload integrity
// (listing-health-v3-dependency-bundle.js). Proves blocker 1 (the fingerprint folds EVERY selected input that can
// change the payload: Listings/Raw sha, OLI rows/coverage/completeness content, Catalog sha, FBA token-or-UNAVAILABLE)
// and blocker 3 (fail-closed pointer/payload integrity: org/conn/account/marketplace/source-key/D-1/validated_at/
// row_count/hash/sha + object-path namespace + storage-first hydrate + rows.length===row_count + NO inline fallback).
// Uses the REAL resolver over injected doubles + the REAL sourceSnapshotObjectPath. Offline; zero network. 7-bit ASCII.
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import {
  resolveListingHealthV3DependencyBundle, fingerprintListingHealthV3Bundle, validateListingsPointer,
  oliRowsDigest, oliCoverageDigest, oliCompletenessDigest, inventoryFingerprintToken, LISTING_HEALTH_V3_BUNDLE_STATUS,
} from "../lib/server/sync/listing-health-v3-dependency-bundle.js";
import { sourceSnapshotObjectPath } from "../lib/server/supabase.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "listing-health-v3-dependency-bundle\n");

const ORG = "org-1", ACCT = "acct-00", MKT = "US", SELLER = "SELLER-1", ASOF = "2026-09-04", CONN = "primary";
const pathFor = (sourceKey, sha) => sourceSnapshotObjectPath({ organizationFingerprint: ORG, connectionId: CONN, sourceKey, scopeKey: ACCT, payloadSha: sha });
// A fully-valid Listings/Raw pointer whose object_path is the real recomputed namespace path.
const ptr = (sourceKey, o = {}) => {
  const sha = o.payload_sha || (sourceKey === "listings" ? "sha-l" : "sha-r");
  return {
    organization_fingerprint: ORG, connection_id: CONN, account_id: ACCT, marketplace: MKT, source_key: sourceKey,
    as_of: o.as_of || ASOF, object_path: o.object_path || pathFor(sourceKey, sha), payload_sha: sha, row_count: o.row_count == null ? 2 : o.row_count,
    payload_bytes: 100, source_request_hash: o.source_request_hash || (sourceKey === "listings" ? "rh-l" : "rh-r"), validated_at: o.validated_at || "2026-09-04T06:00:00.000Z",
  };
};
const oliRows = [{ account_id: ACCT, seller_or_vendor_id: SELLER, sale_date: "2026-09-01", sku: "A", child_asin: "ASIN-A", currency: "USD", sales_amount: 100.12345, ordered_units: 10, unpriced_units: 0 }];
const durableCtxOk = () => ({
  listingHealthV3DurableOli: { available: true, rows: oliRows, coverageWindows: [{ from: "2024-01-01", to: ASOF }], completenessRows: [{ account_id: ACCT, bucket: "us-ca", sale_date: "2026-09-01", completeness_status: "final", itemized_order_count: 3, pending_order_count: 0, itemized_unit_count: 5, pending_unit_count: 0, defect_count: 0, itemization_percent: 100 }] },
  listingHealthV3DurableCatalog: { available: true, rows: [{ child_asin: "ASIN-A", product_name: "P A", product_brand: "BrandX" }], payloadSha: "sha-cat", validatedAt: "2026-09-04T05:00:00.000Z" },
});
const INV_HASH = "rh-inv";
const invPtr = () => ({ scope_key: ACCT, object_path: "obj/inv.json", payload_sha: "sha-i", row_count: 1, source_request_hash: INV_HASH, validated_at: "2026-09-04T06:00:00.000Z" });
const invRows = [{ date: ASOF, seller_or_vendor_id: SELLER, marketplace_country_code: MKT, sku: "A", child_asin: "ASIN-A", available: 30 }];

function harness(over = {}) {
  const payloadByPath = {
    [pathFor("listings", "sha-l")]: { rows: [{ seller_or_vendor_id: SELLER, sku: "A" }, { seller_or_vendor_id: SELLER, sku: "B" }] },
    [pathFor("listings-raw", "sha-r")]: { rows: [{ seller_or_vendor_id: SELLER, sku: "A", issues: "[]" }, { seller_or_vendor_id: SELLER, sku: "B", issues: "[]" }] },
    "obj/inv.json": { rows: invRows },
    ...(over.payloadByPath || {}),
  };
  const deps = {
    readListingsSnapshot: over.readListingsSnapshot || (async () => ({ read: "ok", snapshot: ptr("listings", (over.listingsPtr || {})) })),
    readListingsRawSnapshot: over.readListingsRawSnapshot || (async () => ({ read: "ok", snapshot: ptr("listings-raw", (over.rawPtr || {})) })),
    readInventorySnapshot: over.readInventorySnapshot || (async () => ({ read: "ok", snapshot: invPtr() })),
    loadSnapshotPayload: over.loadSnapshotPayload || (async (path) => { const p = payloadByPath[path]; if (p === undefined) throw new Error("no payload for " + path); return p; }),
    resolveExpectedInventoryRequestHash: over.resolveExpectedInventoryRequestHash || (async () => INV_HASH),
    loadDurableContext: over.loadDurableContext || (async () => durableCtxOk()),
    buildObjectPath: sourceSnapshotObjectPath,
  };
  const args = { organizationFingerprint: ORG, connectionId: CONN, accountId: ACCT, marketplace: MKT, rawSellerId: SELLER, requestedAsOf: ASOF, signal: over.signal || null };
  return { deps, args };
}
const run = (over = {}) => { const { deps, args } = harness(over); return resolveListingHealthV3DependencyBundle(deps, args); };

// ---- (1) PURE digests: determinism, order-independence, float-normalization, change-on-change ----
{
  const rowsA = [oliRows[0], { ...oliRows[0], sku: "B", sales_amount: 5 }];
  const rowsB = [{ ...oliRows[0], sku: "B", sales_amount: 5 }, oliRows[0]]; // reordered
  ok("oliRowsDigest is order-independent (sorted total order)", oliRowsDigest(rowsA) === oliRowsDigest(rowsB));
  ok("oliRowsDigest changes on a sales_amount correction", oliRowsDigest(rowsA) !== oliRowsDigest([{ ...oliRows[0], sales_amount: 100.99 }, rowsA[1]]));
  ok("oliRowsDigest float-normalizes to 4dp (100.123450001 == 100.12345)", oliRowsDigest([{ ...oliRows[0], sales_amount: 100.123450001 }]) === oliRowsDigest([{ ...oliRows[0], sales_amount: 100.12345 }]));
  ok("oliCoverageDigest changes when a covered window changes", oliCoverageDigest([{ from: "2024-01-01", to: ASOF }]) !== oliCoverageDigest([{ from: "2024-06-01", to: ASOF }]));
  ok("oliCompletenessDigest changes on a provisional->final flip", oliCompletenessDigest([{ sale_date: "2026-09-01", completeness_status: "provisional", itemization_percent: 40 }]) !== oliCompletenessDigest([{ sale_date: "2026-09-01", completeness_status: "final", itemization_percent: 100 }]));
  ok("oliCompletenessDigest IGNORES refreshed_at (wall-clock churn excluded)", oliCompletenessDigest([{ sale_date: "2026-09-01", completeness_status: "final", refreshed_at: "T1" }]) === oliCompletenessDigest([{ sale_date: "2026-09-01", completeness_status: "final", refreshed_at: "T2" }]));
  ok("inventoryFingerprintToken: available folds hashes; unavailable is a stable sentinel", inventoryFingerprintToken({ accountId: ACCT, connectionId: CONN, requestedAsOf: ASOF, available: true, sourceRequestHash: "h", payloadSha: "s" }).includes("|h|s") && inventoryFingerprintToken({ accountId: ACCT, connectionId: CONN, requestedAsOf: ASOF, available: false }).endsWith("UNAVAILABLE"));
}

// ---- (2) PURE fingerprint: folds EVERY component; determinism ----
{
  const base = { organizationFingerprint: ORG, connectionId: CONN, accountId: ACCT, marketplace: MKT, requestedAsOf: ASOF, status: "available", listings: { sourceRequestHash: "rh-l", payloadSha: "sha-l", asOf: ASOF }, listingsRaw: { sourceRequestHash: "rh-r", payloadSha: "sha-r", asOf: ASOF }, catalogPayloadSha: "sha-cat", inventoryToken: "fba-inventory|acct|primary|2026-09-04|h|s", oliDigests: { rows: "OR", coverage: "OC", completeness: "OM" } };
  const fp0 = fingerprintListingHealthV3Bundle(base).revisionId;
  ok("fingerprint is deterministic + 32 hex", fp0 === fingerprintListingHealthV3Bundle(base).revisionId && /^[0-9a-f]{32}$/.test(fp0));
  const flips = [
    ["listings sha", { ...base, listings: { ...base.listings, payloadSha: "sha-l2" } }],
    ["listings-raw sha", { ...base, listingsRaw: { ...base.listingsRaw, payloadSha: "sha-r2" } }],
    ["catalog sha", { ...base, catalogPayloadSha: "sha-cat2" }],
    ["inventory token", { ...base, inventoryToken: base.inventoryToken.replace("UNAVAIL", "x") + "z" }],
    ["oli rows digest", { ...base, oliDigests: { ...base.oliDigests, rows: "OR2" } }],
    ["oli coverage digest", { ...base, oliDigests: { ...base.oliDigests, coverage: "OC2" } }],
    ["oli completeness digest", { ...base, oliDigests: { ...base.oliDigests, completeness: "OM2" } }],
    ["marketplace", { ...base, marketplace: "CA" }],
  ];
  for (const [label, mutated] of flips) ok("fingerprint CHANGES when the " + label + " changes", fingerprintListingHealthV3Bundle(mutated).revisionId !== fp0);
  ok("the manifest token embeds the fingerprint + identity", fingerprintListingHealthV3Bundle(base).manifestToken === "listing-health-v3-manifest|" + ORG + "|" + CONN + "|" + ACCT + "|" + ASOF + "|" + fp0);
}

// ---- (3) validateListingsPointer: each fail-closed reason ----
{
  const good = ptr("listings");
  const eop = pathFor("listings", good.payload_sha);
  const V = (snap, over = {}) => validateListingsPointer({ snapshot: snap, expectedOrg: ORG, durableConn: CONN, sourceKey: "listings", accountId: ACCT, marketplace: MKT, requestedAsOf: ASOF, expectedObjectPath: eop, ...over });
  ok("valid pointer passes", V(good).ok === true);
  ok("null snapshot -> no-durable-snapshot", V(null).reason === "no-durable-snapshot");
  ok("org mismatch -> org-mismatch", V({ ...good, organization_fingerprint: "other" }).reason === "org-mismatch");
  ok("connection mismatch -> connection-mismatch", V({ ...good, connection_id: "dd-secondary" }).reason === "connection-mismatch");
  ok("account mismatch -> account-mismatch (cross-account fail-closed)", V({ ...good, account_id: "acct-99" }).reason === "account-mismatch");
  ok("marketplace mismatch -> marketplace-mismatch (cross-marketplace fail-closed)", V({ ...good, marketplace: "CA" }).reason === "marketplace-mismatch");
  ok("bad marketplace shape -> marketplace-mismatch", V({ ...good, marketplace: "USA" }).reason === "marketplace-mismatch");
  ok("wrong source key -> source-key-mismatch", V({ ...good, source_key: "listings-raw" }).reason === "source-key-mismatch");
  ok("older as_of -> not-d1", V({ ...good, as_of: "2026-09-03" }).reason === "not-d1");
  ok("future as_of -> not-d1", V({ ...good, as_of: "2026-09-05" }).reason === "not-d1");
  ok("malformed date -> not-d1", V({ ...good, as_of: "2026-9-4" }).reason === "not-d1");
  ok("blank validated_at -> validated-at-blank", V({ ...good, validated_at: "" }).reason === "validated-at-blank");
  ok("blank request hash -> request-hash-blank", V({ ...good, source_request_hash: "" }).reason === "request-hash-blank");
  ok("blank payload sha -> payload-sha-blank", V({ ...good, payload_sha: "" }).reason === "payload-sha-blank");
  ok("negative row_count -> row-count-invalid", V({ ...good, row_count: -1 }).reason === "row-count-invalid");
  ok("non-integer row_count -> row-count-invalid", V({ ...good, row_count: 2.5 }).reason === "row-count-invalid");
  ok("path does not embed the declared sha -> path-sha-mismatch", V({ ...good, object_path: pathFor("listings", "OTHERSHA"), payload_sha: good.payload_sha }, { expectedObjectPath: pathFor("listings", good.payload_sha) }).reason === "path-sha-mismatch");
  ok("path outside the expected namespace -> path-namespace-mismatch", V({ ...good, object_path: "source-snapshots/v2/OTHERORG/primary/listings/" + ACCT + "/" + good.payload_sha + ".json" }).reason === "path-namespace-mismatch");
}

// ---- (4) resolver: happy path + eligibility + fingerprint stability ----
{
  const b = await run();
  ok("happy path: eligible with a 32-hex revisionId + one manifest contentDep + deps=[]", b.eligible === true && /^[0-9a-f]{32}$/.test(b.revisionId) && b.contentDeps.length === 1 && b.contentDeps[0].startsWith("listing-health-v3-manifest|") && b.deps.length === 0);
  ok("bundle carries listings/raw rows + inventorySource(available) + context(OLI+catalog+rawSellerId)", b.bundle.listingsRows.length === 2 && b.bundle.rawRows.length === 2 && b.bundle.inventorySource.available === true && b.bundle.context.listingHealthV3DurableOli.available === true && b.bundle.context.listingHealthV3DurableCatalog.payloadSha === "sha-cat" && b.bundle.context.rawSellerId === SELLER);
  ok("resolver is deterministic (same evidence -> same revisionId)", (await run()).revisionId === b.revisionId);
}

// ---- (5) resolver: EVERY dependency correction changes the revisionId (the manifest is complete) ----
{
  const base = (await run()).revisionId;
  ok("a Listings same-date sha correction changes the revisionId", (await run({ listingsPtr: { payload_sha: "sha-l-v2" }, payloadByPath: { [pathFor("listings", "sha-l-v2")]: { rows: [{ sku: "A" }, { sku: "B" }] } } })).revisionId !== base);
  ok("a Listings-Raw sha correction changes the revisionId", (await run({ rawPtr: { payload_sha: "sha-r-v2" }, payloadByPath: { [pathFor("listings-raw", "sha-r-v2")]: { rows: [{ sku: "A" }, { sku: "B" }] } } })).revisionId !== base);
  ok("a same-as_of OLI row correction changes the revisionId (closes the OLI-freshness gap)", (await run({ loadDurableContext: async () => { const c = durableCtxOk(); c.listingHealthV3DurableOli.rows = [{ ...oliRows[0], sales_amount: 999.5 }]; return c; } })).revisionId !== base);
  ok("an OLI completeness provisional->final changes the revisionId", (await run({ loadDurableContext: async () => { const c = durableCtxOk(); c.listingHealthV3DurableOli.completenessRows = [{ ...durableCtxOk().listingHealthV3DurableOli.completenessRows[0], completeness_status: "provisional", itemization_percent: 20 }]; return c; } })).revisionId !== base);
  ok("a Catalog content (payload_sha) change changes the revisionId", (await run({ loadDurableContext: async () => { const c = durableCtxOk(); c.listingHealthV3DurableCatalog.payloadSha = "sha-cat-v2"; return c; } })).revisionId !== base);
  ok("FBA available->unavailable changes the revisionId", (await run({ resolveExpectedInventoryRequestHash: async () => "no-match" })).revisionId !== base);
}

// ---- (6) resolver: integrity failures -> defer (LKG, no bundle) ----
const miss = async (n, over, reason) => { const b = await run(over); ok(n, b.eligible === false && b.status === LISTING_HEALTH_V3_BUNDLE_STATUS.MISSING && b.revisionId === null && b.contentDeps.length === 0 && (reason ? String(b.reason).includes(reason) : true)); };
await miss("cross-account listings pointer -> defer", { readListingsSnapshot: async () => ({ read: "ok", snapshot: { ...ptr("listings"), account_id: "acct-99" } }) }, "account-mismatch");
await miss("cross-marketplace listings pointer -> defer", { readListingsSnapshot: async () => ({ read: "ok", snapshot: { ...ptr("listings"), marketplace: "CA" } }) }, "marketplace-mismatch");
await miss("wrong-source listings pointer -> defer", { readListingsSnapshot: async () => ({ read: "ok", snapshot: { ...ptr("listings"), source_key: "listings-raw" } }) }, "source-key-mismatch");
await miss("wrong-path listings pointer -> defer", { readListingsSnapshot: async () => ({ read: "ok", snapshot: { ...ptr("listings"), object_path: "source-snapshots/v2/OTHER/primary/listings/" + ACCT + "/sha-l.json" } }) }, "path-namespace-mismatch");
await miss("row_count mismatch (rows.length !== row_count) -> defer", { readListingsSnapshot: async () => ({ read: "ok", snapshot: ptr("listings", { row_count: 5 }) }) }, "row-count-mismatch");
await miss("malformed as_of -> defer", { readListingsSnapshot: async () => ({ read: "ok", snapshot: ptr("listings", { as_of: "2026-9-4" }) }) }, "not-d1");
await miss("storage failure -> defer (NO inline fallback)", { loadSnapshotPayload: async (p) => { if (p.includes("/listings/")) throw new Error("storage down"); return { rows: [{ sku: "A" }, { sku: "B" }] }; } }, "payload-unreadable");
await miss("schema-missing pointer -> defer", { readListingsSnapshot: async () => ({ read: "schema-missing", snapshot: null }) }, "no-durable-snapshot");
await miss("durable OLI unavailable -> defer", { loadDurableContext: async () => ({ listingHealthV3DurableOli: {}, listingHealthV3DurableCatalog: { available: true, rows: [], payloadSha: "s" } }) }, "durable-oli-unavailable");
await miss("durable Catalog unavailable -> defer", { loadDurableContext: async () => ({ listingHealthV3DurableOli: durableCtxOk().listingHealthV3DurableOli }) }, "durable-catalog-unavailable");
await miss("catalog sha missing -> defer", { loadDurableContext: async () => { const c = durableCtxOk(); delete c.listingHealthV3DurableCatalog.payloadSha; return c; } }, "durable-catalog-sha-missing");

// ---- (7) resolver: FBA optional -- absent inventory is a stable UNAVAILABLE identity, still eligible ----
{
  const b = await run({ resolveExpectedInventoryRequestHash: async () => "" }); // no expected hash -> inventory unavailable
  ok("optional FBA absence -> eligible with inventorySource.available:false (never an error)", b.eligible === true && b.bundle.inventorySource.available === false);
}

// ---- (8) resolver: abort -> defer, no derive ----
{
  const ac = new AbortController(); ac.abort();
  const b = await run({ signal: ac.signal });
  ok("aborted signal -> defer (miss)", b.eligible === false && String(b.reason).includes("abort"));
}

writeSync(1, `\nlisting-health-v3-dependency-bundle: ${passed} assertions passed\n`);
