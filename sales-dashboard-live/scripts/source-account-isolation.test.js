// Scheduler v2 Blocker 4c -- PER-ACCOUNT ISOLATION of a shared <=5-account batch source (offline, ZERO
// network/DB). Proves the required regressions:
//   - a five-account OLI batch: each of the five owners sees ONLY its own rows;
//   - account A can never see B/C/D/E rows;
//   - a missing/blank/out-of-batch seller id rejects the WHOLE batch BEFORE success;
//   - the SAME raw seller id from another org/connection is rejected;
//   - one account with ZERO rows receives validated EMPTY evidence (never another account's rows);
//   - the shared cache object/path stays ONE and unchanged (no per-account duplicate object);
//   - a filtered fragment's sellerOrVendorIds is EXACTLY [ownerRawSellerId];
//   - existing single-account behavior stays byte-identical (no owner => legacy assembleSources);
//   - Product Catalog stays organization-wide (never seller-filtered).
// Report folds/parity + LKG preservation stay green in the existing report suites (run by verify.mjs).
//
// 7-bit ASCII, LF, no top-level await, synchronous writeSync progress, dynamic imports after a dummy env.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = process.env[SB_KEY_ENV] || ["test", "svc", "role", "key"].join("-");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const group = (label) => tests.push({ marker: label });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

// Assigned in main() after the dummy env is set.
let validateBatchSourcePayload, isolateFragmentRowsForOwner, isSellerScopedColumns;
let assembleSources, plannedBatchSourceJobs, runSourceJobs;
let sourceRequestIdentity;
let REPORT_SOURCE_CONTRACTS, SOURCE_CONTRACTS;

const CYCLE_DATE = "2026-08-17";
const FROM = "2025-07-14";
const TO = "2025-07-20";
const SELLERS = ["S1", "S2", "S3", "S4", "S5"];
const ORG = "orgFingerprintPrimary";

const oliContract = () => (REPORT_SOURCE_CONTRACTS["returns-leakage"] || []).find((c) => c.requestKey === "returns-leakage:oli-sales");
const OLI_SOURCE_ID = () => SOURCE_CONTRACTS.find((c) => c.key === "order-line-items").ids[0];
const oliColumns = () => oliContract().columns;
const catalogColumns = () => (REPORT_SOURCE_CONTRACTS["returns-leakage"] || []).find((c) => c.requestKey === "returns-leakage:catalog").columns;

// An OLI-shaped row for a given seller. Only seller_or_vendor_id matters for isolation.
const oliRow = (sid, tag) => ({ date: TO, seller_or_vendor_id: sid, sku: "SKU-" + tag, child_asin: tag, item_price_currency: "USD" });

// The batch's resolved canonical source (one request_hash over the sorted batch seller ids).
function resolvedBatch(sellers = SELLERS) {
  const c = oliContract();
  const options = { groupBy: c.groupBy || undefined, aggregations: c.aggregations || undefined, orderByColumn: c.orderByColumn, orderByDirection: c.orderByDirection };
  const id = sourceRequestIdentity({ apiKey: "k", sourceId: OLI_SOURCE_ID(), columns: c.columns, ids: sellers, from: FROM, to: TO, limit: c.limit, options });
  return {
    requestHash: id.requestHash, requestKey: "returns-leakage:oli-sales", sourceId: OLI_SOURCE_ID(), sourceKey: "order-line-items",
    organizationFingerprint: id.organizationFingerprint, accountScopeHash: id.accountScopeHash, requestMeta: id.requestMeta,
    bucket: "us", strict: true, limit: c.limit, from: FROM, to: TO, options, sellerOrVendorIds: sellers,
  };
}

/* ============================= Part A: validateBatchSourcePayload ============================= */
group("Part A: batch payload validation (before save)");

test("A1. a non-array payload is MALFORMED_PAYLOAD", () => {
  const r = validateBatchSourcePayload({ rows: null, sellerOrVendorIds: SELLERS, columns: oliColumns() });
  assert.equal(r.valid, false); assert.equal(r.code, "MALFORMED_PAYLOAD");
});

test("A2. a seller-scoped batch whose rows all belong to the canonical sellers is VALID", () => {
  const rows = SELLERS.flatMap((s) => [oliRow(s, s + "a"), oliRow(s, s + "b")]);
  assert.equal(validateBatchSourcePayload({ rows, sellerOrVendorIds: SELLERS, columns: oliColumns() }).valid, true);
});

test("A3. an OUT-OF-BATCH seller id rejects the WHOLE batch (BATCH_CROSS_ACCOUNT)", () => {
  const rows = [oliRow("S1", "x"), oliRow("S9", "y")]; // S9 is not in the batch
  const r = validateBatchSourcePayload({ rows, sellerOrVendorIds: SELLERS, columns: oliColumns() });
  assert.equal(r.valid, false); assert.equal(r.code, "BATCH_CROSS_ACCOUNT");
});

test("A4. a non-empty row with a BLANK/missing seller id rejects the batch (BATCH_ROW_NO_SELLER)", () => {
  const blank = { date: TO, seller_or_vendor_id: "", sku: "SKU", child_asin: "A" };
  const missing = { date: TO, sku: "SKU", child_asin: "A" };
  assert.equal(validateBatchSourcePayload({ rows: [oliRow("S1", "x"), blank], sellerOrVendorIds: SELLERS, columns: oliColumns() }).code, "BATCH_ROW_NO_SELLER");
  assert.equal(validateBatchSourcePayload({ rows: [oliRow("S1", "x"), missing], sellerOrVendorIds: SELLERS, columns: oliColumns() }).code, "BATCH_ROW_NO_SELLER");
});

test("A5. a ZERO-ROW batch is VALID-EMPTY evidence", () => {
  assert.equal(validateBatchSourcePayload({ rows: [], sellerOrVendorIds: SELLERS, columns: oliColumns() }).valid, true);
});

test("A6. a NON-seller-scoped source (Product Catalog columns) is never seller-validated (organization-wide)", () => {
  // Even a row with a foreign seller id passes, because Product Catalog does not fetch seller_or_vendor_id.
  assert.equal(isSellerScopedColumns(catalogColumns()), false, "catalog columns are not seller-scoped");
  const rows = [{ child_asin: "A", product_brand: "Acme", seller_or_vendor_id: "S9" }];
  assert.equal(validateBatchSourcePayload({ rows, sellerOrVendorIds: SELLERS, columns: catalogColumns() }).valid, true);
});

test("A7. a cross-MARKETPLACE row is rejected when an expected marketplace is supplied", () => {
  const rows = [{ ...oliRow("S1", "x"), marketplace_country_code: "US" }, { ...oliRow("S2", "y"), marketplace_country_code: "CA" }];
  const r = validateBatchSourcePayload({ rows, sellerOrVendorIds: SELLERS, columns: [...oliColumns(), "marketplace_country_code"], marketplaceCountry: "US" });
  assert.equal(r.valid, false); assert.equal(r.code, "BATCH_CROSS_MARKETPLACE");
});

test("A8. a seller-scoped batch with NO canonical sellerOrVendorIds is BATCH_SCOPE_MISSING (fail closed)", () => {
  const r = validateBatchSourcePayload({ rows: [oliRow("S1", "x")], sellerOrVendorIds: [], columns: oliColumns() });
  assert.equal(r.valid, false); assert.equal(r.code, "BATCH_SCOPE_MISSING");
});

/* ============================= Part B: isolateFragmentRowsForOwner ============================= */
group("Part B: per-owner row isolation (derive time)");

const sharedPayload = () => SELLERS.slice(0, 4).flatMap((s) => [oliRow(s, s + "a"), oliRow(s, s + "b")]); // S1..S4 have rows; S5 has none
const ownerOf = (sid) => ({ accountId: "ACC-" + sid, rawSellerId: sid, connectionId: "primary", organizationFingerprint: ORG });
const oliFragment = (rows) => ({ rows, columns: oliColumns(), sellerOrVendorIds: SELLERS, organizationFingerprint: ORG, connectionId: "primary" });

test("B1. each of five owners sees ONLY its own rows; account A never sees B/C/D/E rows", () => {
  const rows = sharedPayload();
  for (const sid of SELLERS.slice(0, 4)) {
    const iso = isolateFragmentRowsForOwner(oliFragment(rows), ownerOf(sid));
    assert.ok(iso.rows.every((r) => r.seller_or_vendor_id === sid), sid + " sees only its own rows");
    assert.ok(iso.rows.length === 2, sid + " sees exactly its two rows");
    for (const other of SELLERS) if (other !== sid) assert.ok(iso.rows.every((r) => r.seller_or_vendor_id !== other), sid + " never sees " + other);
  }
});

test("B2. an account with ZERO rows in the batch gets validated EMPTY evidence (never another account's rows)", () => {
  const iso = isolateFragmentRowsForOwner(oliFragment(sharedPayload()), ownerOf("S5"));
  assert.deepEqual(iso.rows, []); assert.equal(iso.rejected, false);
});

test("B3. the filtered fragment scope is EXACTLY [ownerRawSellerId]", () => {
  const iso = isolateFragmentRowsForOwner(oliFragment(sharedPayload()), ownerOf("S2"));
  assert.deepEqual(iso.sellerOrVendorIds, ["S2"]);
});

test("B4. isolation NEVER mutates the shared payload (same array, same length, same objects)", () => {
  const rows = sharedPayload();
  const before = rows.slice();
  const iso = isolateFragmentRowsForOwner(oliFragment(rows), ownerOf("S1"));
  assert.notStrictEqual(iso.rows, rows, "a NEW array is returned");
  assert.equal(rows.length, before.length, "shared payload length unchanged");
  assert.ok(rows.every((r, i) => r === before[i]), "shared payload objects unchanged");
});

test("B5. the SAME raw seller id from ANOTHER org or connection is rejected (rows -> null, fail closed)", () => {
  const rows = sharedPayload();
  const otherOrg = { accountId: "ACC-S1", rawSellerId: "S1", connectionId: "primary", organizationFingerprint: "orgFingerprintOTHER" };
  const otherConn = { accountId: "ACC-S1", rawSellerId: "S1", connectionId: "dd-secondary", organizationFingerprint: ORG };
  assert.equal(isolateFragmentRowsForOwner(oliFragment(rows), otherOrg).rejected, true, "another org rejected");
  assert.equal(isolateFragmentRowsForOwner(oliFragment(rows), otherOrg).rows, null);
  assert.equal(isolateFragmentRowsForOwner(oliFragment(rows), otherConn).rejected, true, "another connection rejected");
});

test("B6. Product Catalog (organization-wide) is NEVER seller-filtered, even with an owner", () => {
  const catRows = [{ child_asin: "A", product_brand: "Acme" }, { child_asin: "B", product_brand: "Beta" }];
  const frag = { rows: catRows, columns: catalogColumns(), sellerOrVendorIds: SELLERS, organizationFingerprint: ORG, connectionId: "primary" };
  const iso = isolateFragmentRowsForOwner(frag, ownerOf("S1"));
  assert.strictEqual(iso.rows, catRows, "catalog rows pass through unchanged");
  assert.deepEqual(iso.sellerOrVendorIds, SELLERS, "catalog scope is NOT narrowed");
});

test("B7. no owner => byte-identical passthrough (legacy single-account path)", () => {
  const rows = sharedPayload();
  const iso = isolateFragmentRowsForOwner(oliFragment(rows), null);
  assert.strictEqual(iso.rows, rows); assert.deepEqual(iso.sellerOrVendorIds, SELLERS); assert.equal(iso.rejected, false);
});

/* ============================= Part C: assembleSources owner-aware ============================= */
group("Part C: assembleSources per-account assembly");

// Build planned report sources: a batched OLI fragment (seller-scoped) + a catalog fragment (org-wide).
function plannedReportSources(batch) {
  return [
    { requestKey: "returns-leakage:oli-sales", requestHash: batch.requestHash, from: FROM, to: TO, sellerOrVendorIds: SELLERS, requestMeta: batch.requestMeta, organizationFingerprint: ORG, connectionId: "primary" },
    { requestKey: "returns-leakage:catalog", requestHash: "catalogHash", from: null, to: null, sellerOrVendorIds: SELLERS, columns: catalogColumns(), organizationFingerprint: ORG, connectionId: "primary" },
  ];
}

test("C1. assembleSources with an owner isolates OLI rows per account and keeps catalog organization-wide", () => {
  const batch = resolvedBatch();
  const sources = plannedReportSources(batch);
  const status = { [batch.requestHash]: "succeeded", catalogHash: "succeeded" };
  const catRows = [{ child_asin: "A", product_brand: "Acme" }];
  const loaded = new Map([[batch.requestHash, { rows: sharedPayload() }], ["catalogHash", { rows: catRows }]]);
  for (const sid of SELLERS.slice(0, 4)) {
    const { sources: asm } = assembleSources(sources, status, loaded, {}, ownerOf(sid));
    const oli = asm["returns-leakage:oli-sales"];
    assert.ok(oli.available && oli.rows.every((r) => r.seller_or_vendor_id === sid), sid + " OLI rows isolated");
    assert.equal(oli.rows.length, 2);
    assert.deepEqual(oli.fragments[0].sellerOrVendorIds, [sid], "fragment scope narrowed to [rawSellerId]");
    // Catalog stays organization-wide (unfiltered, full scope). assembleSources always rebuilds the rows
    // array (flatMap over fragments), so it is a NEW array with the SAME values -- never seller-filtered.
    assert.deepEqual(asm["returns-leakage:catalog"].rows, catRows);
    assert.deepEqual(asm["returns-leakage:catalog"].fragments[0].sellerOrVendorIds, SELLERS);
  }
});

test("C2. an owner with zero rows => available with an EMPTY rows array (valid-empty)", () => {
  const batch = resolvedBatch();
  const sources = plannedReportSources(batch);
  const status = { [batch.requestHash]: "succeeded", catalogHash: "succeeded" };
  const loaded = new Map([[batch.requestHash, { rows: sharedPayload() }], ["catalogHash", { rows: [] }]]);
  const { sources: asm } = assembleSources(sources, status, loaded, {}, ownerOf("S5"));
  assert.equal(asm["returns-leakage:oli-sales"].available, true);
  assert.deepEqual(asm["returns-leakage:oli-sales"].rows, []);
});

test("C3. no owner => byte-identical to the legacy assembly (full batch rows, full scope)", () => {
  const batch = resolvedBatch();
  const sources = plannedReportSources(batch);
  const status = { [batch.requestHash]: "succeeded", catalogHash: "succeeded" };
  const payload = sharedPayload();
  const loaded = new Map([[batch.requestHash, { rows: payload }], ["catalogHash", { rows: [] }]]);
  const legacy = assembleSources(sources, status, loaded, {});
  const explicitNull = assembleSources(sources, status, loaded, {}, null);
  assert.equal(legacy.sources["returns-leakage:oli-sales"].rows.length, payload.length, "legacy sees the full batch");
  assert.deepEqual(legacy.sources["returns-leakage:oli-sales"].fragments[0].sellerOrVendorIds, SELLERS, "legacy scope unchanged");
  assert.deepEqual(explicitNull.sources["returns-leakage:oli-sales"].rows, legacy.sources["returns-leakage:oli-sales"].rows);
});

test("C4. a cross-org owner makes the seller-scoped source UNAVAILABLE (fail closed, LKG preserved)", () => {
  const batch = resolvedBatch();
  const sources = plannedReportSources(batch);
  const status = { [batch.requestHash]: "succeeded", catalogHash: "succeeded" };
  const loaded = new Map([[batch.requestHash, { rows: sharedPayload() }], ["catalogHash", { rows: [] }]]);
  const crossOrg = { accountId: "ACC-S1", rawSellerId: "S1", connectionId: "primary", organizationFingerprint: "orgFingerprintOTHER" };
  const { sources: asm } = assembleSources(sources, status, loaded, {}, crossOrg);
  assert.equal(asm["returns-leakage:oli-sales"].available, false, "cross-org => source unavailable, never attributes rows");
});

/* ============================= Part D: end-to-end save + isolation ============================= */
group("Part D: five-account batch -> ONE cached object -> per-account isolation");

function makeSourceStore() {
  const cycles = new Map(); const jobs = new Map(); const cache = new Map(); let seq = 0;
  const find = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  return {
    _cache: cache,
    openCycle({ bucket, cycleDate }) { const k = bucket + "|" + cycleDate; if (!cycles.has(k)) { const id = "cyc_" + (seq += 1); cycles.set(k, { id, bucket, status: "pending" }); jobs.set(id, new Map()); } return cycles.get(k).id; },
    claimCycle(id) { const c = find(id); if (c && c.status === "pending") { c.status = "running"; return true; } return false; },
    getCycle(id) { return find(id); },
    upsertSourceJob(job) { const m = jobs.get(job.cycleId); if (m.has(job.requestHash)) return; m.set(job.requestHash, { request_hash: job.requestHash, request_key: job.requestKey, source_id: job.sourceId, source_key: job.sourceKey, connection_id: job.connectionId, organization_fingerprint: job.organizationFingerprint, account_scope_hash: job.accountScopeHash, fetch_status: "pending", attempted_at: null, create_export_count: 0, export_id: null, terminal: false, error_stage: null, error_code: null, error_message: null, row_count: null, cache_object_path: null }); },
    listSourceJobs(id) { return [...((jobs.get(id) && jobs.get(id).values()) || [])].map((j) => ({ ...j })); },
    _rawJob(id, h) { return jobs.get(id) && jobs.get(id).get(h); },
    claimExportAttempt(id, h) { const j = jobs.get(id) && jobs.get(id).get(h); if (j && j.fetch_status === "pending" && j.attempted_at === null) { j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted"; return true; } return false; },
    recordExportCreated({ cycleId, requestHash, exportId }) { jobs.get(cycleId).get(requestHash).export_id = exportId; },
    saveSourceRows({ job, rows, payloadBytes }) { const h = job.request_hash != null ? job.request_hash : job.requestHash; const objectPath = "source-cache/v2/" + h + ".json"; cache.set(h, { rows: [...rows], object_path: objectPath, row_count: rows.length, payload_bytes: payloadBytes }); return objectPath; },
    recordSourceSuccess({ cycleId, requestHash, exportId, rowCount, cacheObjectPath }) { Object.assign(jobs.get(cycleId).get(requestHash), { fetch_status: "succeeded", export_id: exportId, row_count: rowCount, cache_object_path: cacheObjectPath, error_stage: null, error_code: null }); },
    recordSourceFailure({ cycleId, requestHash, stage, code, message, terminal, rowCount }) { const j = jobs.get(cycleId).get(requestHash); Object.assign(j, { fetch_status: "failed", error_stage: stage, error_code: code, error_message: message, terminal: !!terminal }); if (rowCount != null) j.row_count = rowCount; },
    updateCycleCounts() { /* not asserted */ },
  };
}

// A DataDoe fake whose download returns the WHOLE batch payload (rows for S1..S4, S5 has none).
function makeBatchDataDoe(payload) {
  const create = {};
  const bump = (h) => { create[h] = (create[h] || 0) + 1; };
  return { createCount: (h) => create[h] || 0, async create(job) { bump(job.requestHash); return { exportId: "e_" + job.requestHash }; }, async poll() {}, async download() { return payload; } };
}

test("D1. a five-account OLI batch validates, saves ONE canonical object, and each owner isolates its own rows (S5 valid-empty)", async () => {
  const batch = resolvedBatch();
  const batchAccounts = SELLERS.map((s) => ({ accountId: "ACC-" + s, rawSellerId: s }));
  const jobs = plannedBatchSourceJobs("returns-leakage", batch, "us", "primary", batchAccounts);
  assert.equal(jobs.length, 5, "five owner jobs");
  assert.equal(new Set(jobs.map((j) => j.requestHash)).size, 1, "one shared canonical request_hash");

  const payload = SELLERS.slice(0, 4).flatMap((s) => [oliRow(s, s + "a"), oliRow(s, s + "b")]); // S5 => no rows
  const store = makeSourceStore();
  const dd = makeBatchDataDoe(payload);
  const res = await runSourceJobs({ store, dataDoe: dd, plannedJobs: jobs, bucket: "us", cycleDate: CYCLE_DATE });
  assert.equal(res.succeeded, 1, "the one shared canonical batch job succeeds");
  assert.equal(dd.createCount(batch.requestHash), 1, "exactly one create-export for the batch");

  // ONE cache object for the batch hash -- no per-account duplicate object/path.
  assert.equal(store._cache.size, 1, "exactly ONE cached object");
  const cached = store._cache.get(batch.requestHash);
  assert.ok(cached && cached.object_path === "source-cache/v2/" + batch.requestHash + ".json", "one canonical object path");
  assert.equal(cached.rows.length, payload.length, "the one object holds the whole batch payload");

  // Per-owner isolation over the ONE shared object.
  const status = { [batch.requestHash]: "succeeded" };
  const loaded = new Map([[batch.requestHash, { rows: cached.rows }]]);
  const frags = [{ requestKey: "returns-leakage:oli-sales", requestHash: batch.requestHash, from: FROM, to: TO, sellerOrVendorIds: SELLERS, requestMeta: batch.requestMeta, organizationFingerprint: batch.organizationFingerprint, connectionId: "primary" }];
  for (const j of jobs) {
    const { sources: asm } = assembleSources(frags, status, loaded, {}, j.owner);
    const oli = asm["returns-leakage:oli-sales"];
    assert.equal(oli.available, true, j.owner.rawSellerId + " has validated evidence");
    assert.ok(oli.rows.every((r) => r.seller_or_vendor_id === j.owner.rawSellerId), j.owner.rawSellerId + " sees only its rows");
    assert.deepEqual(oli.fragments[0].sellerOrVendorIds, [j.owner.rawSellerId], "scope narrowed to the owner's raw id");
  }
  const s5 = jobs.find((j) => j.owner.rawSellerId === "S5");
  const { sources: asmS5 } = assembleSources(frags, status, loaded, {}, s5.owner);
  assert.deepEqual(asmS5["returns-leakage:oli-sales"].rows, [], "S5 (no rows in the batch) is valid-empty");
  // The shared cached object is still ONE and unchanged after all isolation.
  assert.equal(store._cache.size, 1, "still exactly one cached object");
  assert.equal(store._cache.get(batch.requestHash).rows.length, payload.length, "shared object unchanged");
});

test("D2. a batch download containing an OUT-OF-BATCH seller id FAILS validation BEFORE success (no save)", async () => {
  const batch = resolvedBatch();
  const batchAccounts = SELLERS.map((s) => ({ accountId: "ACC-" + s, rawSellerId: s }));
  const jobs = plannedBatchSourceJobs("returns-leakage", batch, "us", "primary", batchAccounts);
  const badPayload = [oliRow("S1", "a"), oliRow("S9", "b")]; // S9 is not a batch seller
  const store = makeSourceStore();
  const res = await runSourceJobs({ store, dataDoe: makeBatchDataDoe(badPayload), plannedJobs: jobs, bucket: "us", cycleDate: CYCLE_DATE });
  assert.equal(res.succeeded, 0, "no success on a cross-account batch");
  assert.equal(store._cache.size, 0, "nothing saved (LKG preserved)");
  const jobRow = store._rawJob(res.cycleId, batch.requestHash);
  assert.equal(jobRow.fetch_status, "failed"); assert.equal(jobRow.error_stage, "validate"); assert.equal(jobRow.error_code, "BATCH_CROSS_ACCOUNT");
});

async function main() {
  ({ validateBatchSourcePayload, isolateFragmentRowsForOwner, isSellerScopedColumns } = await import("../lib/server/sync/source-account-isolation.js"));
  ({ assembleSources, runSourceJobs } = await import("../lib/server/sync/report-worker.js").then(async (rw) => ({ assembleSources: rw.assembleSources, runSourceJobs: (await import("../lib/server/sync/source-worker.js")).runSourceJobs })));
  ({ plannedBatchSourceJobs } = await import("../lib/server/sync/source-sync-driver.js"));
  ({ sourceRequestIdentity } = await import("../lib/server/source-identity.js"));
  ({ REPORT_SOURCE_CONTRACTS } = await import("../lib/server/sync/report-source-contracts.js"));
  ({ SOURCE_CONTRACTS } = await import("../lib/server/source-contracts.js"));

  let failures = 0;
  for (const t of tests) {
    if (t.marker) { out("\n# " + t.marker); continue; }
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (err) { failures += 1; out("FAIL  " + t.name); out(String(err && err.stack ? err.stack : err)); }
  }
  out("\n" + passed + " assertions passed");
  return failures;
}

main().then((failures) => { if (failures) process.exitCode = 1; }).catch((err) => { out("FATAL " + String(err && err.stack ? err.stack : err)); process.exitCode = 1; });
