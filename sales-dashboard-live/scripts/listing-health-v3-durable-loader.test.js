// WORK C/D correction round 3 (Codex blocker 2) -- the STRICT reconciler-loader Catalog integrity. The strict catalog
// check previously VALIDATED row_count only when it was already an integer (`Number.isInteger(Number(row_count)) &&
// length !== row_count`), so a missing / null / malformed / negative / non-integer row_count FAIL-OPEN (skipped the
// hydrated-count check). This suite proves the hardened strict path: row_count must be finite/integer/>=0 FIRST, then
// hydrated rows.length === row_count; the pointer must echo the exact org/connection/source_key=product-catalog/
// scope_key=__organization identity, carry a nonblank source_request_hash + payload_sha and a REAL validated_at, and
// its object_path must embed the sha AND equal the recomputed namespace path. Each invalid case returns {} from the
// loader AND makes resolveListingHealthV3DependencyBundle DEFER (eligible:false, revisionId null, no contentDeps) --
// i.e. ZERO cycle/job/shadow/live writes, LKG preserved. A VALID (incl. zero-row) catalog stays honest. Preview
// (non-strict) behavior is byte-unchanged. Offline; ZERO network. 7-bit ASCII, LF.
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { makeListingHealthV3DurableContextLoader } from "../lib/server/sync/listing-health-v3-durable-loader.js";
import { resolveListingHealthV3DependencyBundle, LISTING_HEALTH_V3_BUNDLE_STATUS } from "../lib/server/sync/listing-health-v3-dependency-bundle.js";
import { organizationFingerprint as organizationFingerprintOf } from "../lib/server/source-identity.js";
import { sourceSnapshotObjectPath } from "../lib/server/supabase.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "listing-health-v3-durable-loader\n");

const connections = [{ id: "primary", apiKey: "fixture-key", accountPrefix: "" }];
const SELLER = "acct-00", MKT = "US", CONN = "primary", ASOF = "2026-09-04";
const ORG = organizationFingerprintOf("fixture-key");
const pathFor = (sourceKey, scopeKey, sha) => sourceSnapshotObjectPath({ organizationFingerprint: ORG, connectionId: CONN, sourceKey, scopeKey, payloadSha: sha });

// A fully-valid Product Catalog snapshot (org-scoped) whose object_path is the real recomputed namespace path.
const CAT_SHA = "sha-cat";
const validCat = () => ({ organization_fingerprint: ORG, connection_id: CONN, source_key: "product-catalog", scope_key: "__organization", object_path: pathFor("product-catalog", "__organization", CAT_SHA), payload_sha: CAT_SHA, row_count: 2, source_request_hash: "rh-cat", validated_at: "2026-09-04T05:00:00.000Z" });
const catRows2 = [{ child_asin: "ASIN-A", product_name: "P A", product_brand: "BrandX" }, { child_asin: "ASIN-B", product_name: "P B", product_brand: "BrandY" }];
const oliRow = { account_id: SELLER, seller_or_vendor_id: SELLER, sale_date: "2026-08-10", sku: "A", child_asin: "ASIN-A", currency: "USD", sales_amount: 10, ordered_units: 1, unpriced_units: 0 };

// The REAL strict loader over OK OLI doubles + the catalog under test.
function strictLoader(catSnapshot, catPayload) {
  return makeListingHealthV3DurableContextLoader({
    connections,
    getEnrichedOli: async () => [oliRow],
    getOliCoverage: async () => ({ read: "ok", windows: [{ from: "2024-01-01", to: ASOF }] }),
    getCompleteness: async () => [],
    getCatalogSnapshot: async () => ({ read: "ok", snapshot: catSnapshot }),
    loadCatalogPayload: async () => catPayload,
    strict: true,
    buildObjectPath: sourceSnapshotObjectPath,
  });
}
const runLoader = (catSnapshot, catPayload = { rows: catRows2 }) => strictLoader(catSnapshot, catPayload)({ reportKey: "listing-health-v3", accountId: SELLER, planned: { context: { to: ASOF } }, signal: null });

// ---- (1) VALID catalog (incl. a valid ZERO-ROW catalog) stays honest -> catalog present ----
{
  const c = await runLoader(validCat());
  ok("valid strict catalog -> listingHealthV3DurableCatalog present (available, 2 rows, sha)", c.listingHealthV3DurableCatalog && c.listingHealthV3DurableCatalog.available === true && c.listingHealthV3DurableCatalog.rows.length === 2 && c.listingHealthV3DurableCatalog.payloadSha === CAT_SHA);
  const ZERO_SHA = "sha-cat0";
  const zeroSnap = { ...validCat(), payload_sha: ZERO_SHA, object_path: pathFor("product-catalog", "__organization", ZERO_SHA), row_count: 0 };
  const z = await runLoader(zeroSnap, { rows: [] });
  ok("valid ZERO-ROW catalog (row_count 0 === hydrated 0) stays honest -> catalog present with 0 rows", z.listingHealthV3DurableCatalog && z.listingHealthV3DurableCatalog.available === true && z.listingHealthV3DurableCatalog.rows.length === 0);
}

// ---- The invalid-catalog case table (Codex blocker 2): row_count validity + identity + timestamp + path integrity ----
const badCases = [
  ["missing row_count", () => { const c = validCat(); delete c.row_count; return c; }],
  ["null row_count", () => ({ ...validCat(), row_count: null })],
  ["malformed row_count ('abc')", () => ({ ...validCat(), row_count: "abc" })],
  ["negative row_count (-1)", () => ({ ...validCat(), row_count: -1 })],
  ["non-integer row_count (2.5)", () => ({ ...validCat(), row_count: 2.5 })],
  ["Infinity row_count", () => ({ ...validCat(), row_count: Infinity })],
  ["organization_fingerprint mismatch", () => ({ ...validCat(), organization_fingerprint: "OTHER-ORG" })],
  ["connection_id mismatch", () => ({ ...validCat(), connection_id: "dd-secondary" })],
  ["source_key mismatch (not product-catalog)", () => ({ ...validCat(), source_key: "order-line-items" })],
  ["scope_key mismatch (not __organization)", () => ({ ...validCat(), scope_key: SELLER })],
  ["blank source_request_hash", () => ({ ...validCat(), source_request_hash: "" })],
  ["blank payload_sha", () => ({ ...validCat(), payload_sha: "" })],
  ["invalid validated_at (unparseable)", () => ({ ...validCat(), validated_at: "not-a-timestamp" })],
  ["blank validated_at", () => ({ ...validCat(), validated_at: "" })],
  ["object_path does not embed the declared sha", () => ({ ...validCat(), object_path: pathFor("product-catalog", "__organization", "OTHER-SHA") })],
  ["object_path outside the expected namespace", () => ({ ...validCat(), object_path: "source-snapshots/v2/OTHER-ORG/primary/product-catalog/__organization/" + CAT_SHA + ".json" })],
  ["hydrated rows.length != row_count (row_count 2, 1 hydrated)", () => validCat()], // payload override below
];

// ---- (2) direct loader: EVERY invalid catalog -> {} (no catalog, no OLI; the loader performs zero writes) ----
for (const [label, mk] of badCases) {
  const payload = label.startsWith("hydrated rows.length") ? { rows: [catRows2[0]] } : { rows: catRows2 };
  const c = await runLoader(mk(), payload);
  ok("strict loader defers ({}) on: " + label, c && typeof c === "object" && Object.keys(c).length === 0);
}
// A strict loader constructed WITHOUT buildObjectPath cannot verify the namespace -> fail closed ({}).
{
  const noBuild = makeListingHealthV3DurableContextLoader({ connections, getEnrichedOli: async () => [oliRow], getOliCoverage: async () => ({ read: "ok", windows: [{ from: "2024-01-01", to: ASOF }] }), getCompleteness: async () => [], getCatalogSnapshot: async () => ({ read: "ok", snapshot: validCat() }), loadCatalogPayload: async () => ({ rows: catRows2 }), strict: true, buildObjectPath: null });
  const c = await noBuild({ reportKey: "listing-health-v3", accountId: SELLER, planned: { context: { to: ASOF } } });
  ok("strict loader WITHOUT buildObjectPath -> defers ({}) (cannot verify the namespace, fail closed)", Object.keys(c).length === 0);
}

// ---- (3) PREVIEW (non-strict) behavior is byte-UNCHANGED: a malformed row_count is NOT a defer trigger ----
{
  const preview = makeListingHealthV3DurableContextLoader({ connections, getEnrichedOli: async () => [oliRow], getOliCoverage: async () => ({ read: "ok", windows: [{ from: "2024-01-01", to: ASOF }] }), getCompleteness: async () => [], getCatalogSnapshot: async () => ({ read: "ok", snapshot: { object_path: "cat/p", payload_sha: "s", row_count: "not-a-number" } }), loadCatalogPayload: async () => ({ rows: catRows2 }) });
  const c = await preview({ reportKey: "listing-health-v3", accountId: SELLER, planned: { context: { to: ASOF } } });
  ok("PREVIEW (non-strict) accepts a minimal catalog pointer unchanged (no strict integrity)", c.listingHealthV3DurableCatalog && c.listingHealthV3DurableCatalog.available === true && c.listingHealthV3DurableCatalog.rows.length === 2);
}

// ---- (4) BUNDLE COMPOSITION: the real strict loader wired into resolveListingHealthV3DependencyBundle. A valid
//          catalog -> eligible (revision). EACH invalid catalog -> DEFER (eligible:false, revisionId null, no
//          contentDeps) = zero cycle/job/shadow/live writes, LKG preserved. ----
const L_SHA = "sha-l", R_SHA = "sha-r";
const listPtr = (sourceKey, sha, rh) => ({ organization_fingerprint: ORG, connection_id: CONN, account_id: SELLER, marketplace: MKT, source_key: sourceKey, as_of: ASOF, object_path: pathFor(sourceKey, SELLER, sha), payload_sha: sha, row_count: 1, source_request_hash: rh, validated_at: "2026-09-04T06:00:00.000Z" });
function bundleWith(catSnapshot, catPayload = { rows: catRows2 }) {
  const payloadByPath = { [pathFor("listings", SELLER, L_SHA)]: { rows: [{ seller_or_vendor_id: SELLER, sku: "A" }] }, [pathFor("listings-raw", SELLER, R_SHA)]: { rows: [{ seller_or_vendor_id: SELLER, sku: "A", issues: "[]" }] } };
  return resolveListingHealthV3DependencyBundle({
    readListingsSnapshot: async () => ({ read: "ok", snapshot: listPtr("listings", L_SHA, "rh-l") }),
    readListingsRawSnapshot: async () => ({ read: "ok", snapshot: listPtr("listings-raw", R_SHA, "rh-r") }),
    readInventorySnapshot: async () => ({ read: "ok", snapshot: null }),
    loadSnapshotPayload: async (p) => { const v = payloadByPath[p]; if (v === undefined) throw new Error("no payload for " + p); return v; },
    resolveExpectedInventoryRequestHash: async () => "", // FBA unavailable -> still eligible
    loadDurableContext: strictLoader(catSnapshot, catPayload),
    buildObjectPath: sourceSnapshotObjectPath,
  }, { organizationFingerprint: ORG, connectionId: CONN, accountId: SELLER, marketplace: MKT, rawSellerId: SELLER, requestedAsOf: ASOF, signal: null });
}
{
  const good = await bundleWith(validCat());
  ok("BUNDLE: a valid strict catalog -> eligible (32-hex revisionId + one manifest contentDep)", good.eligible === true && /^[0-9a-f]{32}$/.test(good.revisionId) && good.contentDeps.length === 1);
}
for (const [label, mk] of badCases) {
  const payload = label.startsWith("hydrated rows.length") ? { rows: [catRows2[0]] } : { rows: catRows2 };
  const b = await bundleWith(mk(), payload);
  ok("BUNDLE DEFERS (zero writes, LKG) on invalid catalog: " + label, b.eligible === false && b.status === LISTING_HEALTH_V3_BUNDLE_STATUS.MISSING && b.revisionId === null && b.contentDeps.length === 0);
}

writeSync(1, `\nlisting-health-v3-durable-loader: ${passed} assertions passed\n`);
