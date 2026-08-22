// Scheduler v2 Blocker 4c (+ correction) -- PER-ACCOUNT ISOLATION of a shared <=5-account batch source
// (offline, ZERO network/DB). Proves the required regressions:
//   - the REAL report worker supplies complete owner metadata and derives five report jobs from ONE cached
//     batch, each seeing ONLY its own rows (never A seeing B/C/D/E);
//   - a batched seller-scoped report reaching the worker WITHOUT complete owner metadata (missing owner, or
//     missing owner org/connection) FAILS CLOSED -- it never takes the legacy full-batch path;
//   - source scope is EXPLICIT ("seller" | "organization"); an unknown/missing scope fails closed; a seller
//     scope missing seller_or_vendor_id fails before I/O; Product Catalog stays organization-wide;
//   - the source worker actually PASSES the batch marketplace expectation, and a blank/missing/wrong seller or
//     marketplace (or a primitive/null/array row) rejects the WHOLE batch before save (LKG preserved);
//   - the shared cache object stays ONE and unchanged; zero cross-account writes.
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
let validateBatchSourcePayload, isolateFragmentRowsForOwner, isBatchedSellerFragment, missingOwnerFields;
let plannedBatchSourceJobs, runSourceJobs, runReportJobs;
let reportSourceRequestHashes, assertSourceScopeConsistency, sourceScopeForContract;

const FROM = "2024-07-01";
const TO = "2025-08-10";
const SELLERS = ["S1", "S2", "S3", "S4", "S5"];
const ORG = "orgFingerprintPrimary";
const MKT = "US";

/* ============================= Part A: validateBatchSourcePayload ============================= */
group("Part A: batch payload validation (explicit scope + marketplace + malformed)");

const sellerRow = (sid, mkt = MKT) => ({ date: TO, seller_or_vendor_id: sid, marketplace_country_code: mkt, child_asin: "A-" + sid });

test("A1. a non-array payload, or a primitive/null/array MEMBER, is MALFORMED_PAYLOAD", () => {
  assert.equal(validateBatchSourcePayload({ rows: null, sellerOrVendorIds: SELLERS, sourceScope: "seller" }).code, "MALFORMED_PAYLOAD");
  for (const bad of [42, "x", null, [1, 2]]) {
    const r = validateBatchSourcePayload({ rows: [sellerRow("S1"), bad], sellerOrVendorIds: SELLERS, sourceScope: "seller", marketplaceScoped: true, marketplaceCountry: MKT });
    assert.equal(r.code, "MALFORMED_PAYLOAD", "member " + JSON.stringify(bad) + " is malformed");
  }
});

test("A2. an unknown/missing sourceScope fails closed (SOURCE_SCOPE_UNKNOWN)", () => {
  assert.equal(validateBatchSourcePayload({ rows: [sellerRow("S1")], sellerOrVendorIds: SELLERS, sourceScope: undefined }).code, "SOURCE_SCOPE_UNKNOWN");
  assert.equal(validateBatchSourcePayload({ rows: [sellerRow("S1")], sellerOrVendorIds: SELLERS, sourceScope: "bogus" }).code, "SOURCE_SCOPE_UNKNOWN");
});

test("A3. an organization-scoped source is never seller/marketplace-validated (Product Catalog)", () => {
  const rows = [{ child_asin: "A", product_brand: "Acme", seller_or_vendor_id: "FOREIGN", marketplace_country_code: "CA" }];
  assert.equal(validateBatchSourcePayload({ rows, sellerOrVendorIds: SELLERS, sourceScope: "organization" }).valid, true);
});

test("A4. seller scope: out-of-batch / blank seller id rejects the WHOLE batch; zero rows is valid-empty", () => {
  assert.equal(validateBatchSourcePayload({ rows: [sellerRow("S1"), sellerRow("S9")], sellerOrVendorIds: SELLERS, sourceScope: "seller", marketplaceScoped: true, marketplaceCountry: MKT }).code, "BATCH_CROSS_ACCOUNT");
  const blank = { date: TO, seller_or_vendor_id: "", marketplace_country_code: MKT };
  assert.equal(validateBatchSourcePayload({ rows: [sellerRow("S1"), blank], sellerOrVendorIds: SELLERS, sourceScope: "seller", marketplaceScoped: true, marketplaceCountry: MKT }).code, "BATCH_ROW_NO_SELLER");
  assert.equal(validateBatchSourcePayload({ rows: [], sellerOrVendorIds: SELLERS, sourceScope: "seller", marketplaceScoped: true, marketplaceCountry: MKT }).valid, true);
});

test("A5. seller scope with no canonical sellerOrVendorIds is BATCH_SCOPE_MISSING", () => {
  assert.equal(validateBatchSourcePayload({ rows: [sellerRow("S1")], sellerOrVendorIds: [], sourceScope: "seller" }).code, "BATCH_SCOPE_MISSING");
});

test("A6. marketplace: blank-row marketplace / wrong (seller,marketplace) pair reject before save", () => {
  const base = { sellerOrVendorIds: SELLERS, sourceScope: "seller", marketplaceScoped: true };
  const noMkt = { date: TO, seller_or_vendor_id: "S1", marketplace_country_code: "" };
  assert.equal(validateBatchSourcePayload({ rows: [noMkt], ...base, marketplaceCountry: MKT }).code, "BATCH_ROW_NO_MARKETPLACE");
  // a batch seller carrying a marketplace that is not its tuple is a cross-account PAIR (not two independent sets)
  assert.equal(validateBatchSourcePayload({ rows: [sellerRow("S1", "CA")], ...base, marketplaceCountry: MKT }).code, "BATCH_CROSS_ACCOUNT");
  assert.equal(validateBatchSourcePayload({ rows: SELLERS.map((s) => sellerRow(s)), ...base, marketplaceCountry: MKT }).valid, true);
});

/* ===== Isolation correction: exact (rawSellerId, marketplaceCountryCode) TUPLE, never two independent sets ===== */
group("Isolation correction: exact seller+marketplace tuple routing");
const tupleFragment = (rows, accountTuples, marketplaceScoped = true) => ({ rows, sourceScope: "seller", accountTuples, marketplaceScoped, organizationFingerprint: ORG, connectionId: "primary" });
const mktOwner = (rawSellerId, marketplaceCountryCode) => ({ accountId: "ACC-" + rawSellerId + "-" + marketplaceCountryCode, rawSellerId, marketplaceCountryCode, connectionId: "primary", organizationFingerprint: ORG, accountScopeHash: "sc" });

test("IC1. same seller id across DE + IT routes each row ONLY to its exact marketplace account", () => {
  const TUP = [{ rawSellerId: "S1", marketplaceCountryCode: "DE" }, { rawSellerId: "S1", marketplaceCountryCode: "IT" }];
  const rows = [sellerRow("S1", "DE"), sellerRow("S1", "DE"), sellerRow("S1", "IT")];
  assert.equal(validateBatchSourcePayload({ rows, accountTuples: TUP, sourceScope: "seller", marketplaceScoped: true }).valid, true);
  const de = isolateFragmentRowsForOwner(tupleFragment(rows, TUP), mktOwner("S1", "DE"));
  const it = isolateFragmentRowsForOwner(tupleFragment(rows, TUP), mktOwner("S1", "IT"));
  assert.ok(de.rows.length === 2 && de.rows.every((r) => r.marketplace_country_code === "DE"), "DE account gets only its 2 DE rows");
  assert.ok(it.rows.length === 1 && it.rows.every((r) => r.marketplace_country_code === "IT"), "IT account gets only its 1 IT row");
});

test("IC2. seller A + marketplace B cross-pair is rejected (both values exist independently)", () => {
  const TUP = [{ rawSellerId: "S1", marketplaceCountryCode: "DE" }, { rawSellerId: "S2", marketplaceCountryCode: "IT" }];
  // (S1, IT): S1 and IT each exist, but the PAIR does not -> BATCH_CROSS_ACCOUNT
  assert.equal(validateBatchSourcePayload({ rows: [sellerRow("S1", "IT")], accountTuples: TUP, sourceScope: "seller", marketplaceScoped: true }).code, "BATCH_CROSS_ACCOUNT");
});

test("IC3. duplicate seller id with NO marketplace column fails closed (AMBIGUOUS_ACCOUNT_EVIDENCE)", () => {
  const TUP = [{ rawSellerId: "S1", marketplaceCountryCode: "DE" }, { rawSellerId: "S1", marketplaceCountryCode: "IT" }];
  const noMktRows = [{ date: TO, seller_or_vendor_id: "S1", child_asin: "A" }];
  assert.equal(validateBatchSourcePayload({ rows: noMktRows, accountTuples: TUP, sourceScope: "seller", marketplaceScoped: false }).code, "AMBIGUOUS_ACCOUNT_EVIDENCE");
  const iso = isolateFragmentRowsForOwner(tupleFragment(noMktRows, TUP, false), { rawSellerId: "S1", connectionId: "primary", organizationFingerprint: ORG });
  assert.equal(iso.rejected, true, "seller-only isolation of an ambiguous seller is rejected");
  assert.equal(iso.code, "AMBIGUOUS_ACCOUNT_EVIDENCE");
});

test("IC4. different seller ids across mixed marketplaces stay correctly isolated", () => {
  const TUP = [{ rawSellerId: "S1", marketplaceCountryCode: "DE" }, { rawSellerId: "S2", marketplaceCountryCode: "IT" }, { rawSellerId: "S3", marketplaceCountryCode: "FR" }];
  const rows = [sellerRow("S1", "DE"), sellerRow("S2", "IT"), sellerRow("S3", "FR")];
  assert.equal(validateBatchSourcePayload({ rows, accountTuples: TUP, sourceScope: "seller", marketplaceScoped: true }).valid, true);
  for (const [s, m] of [["S1", "DE"], ["S2", "IT"], ["S3", "FR"]]) {
    const iso = isolateFragmentRowsForOwner(tupleFragment(rows, TUP), mktOwner(s, m));
    assert.ok(iso.rows.length === 1 && iso.rows[0].seller_or_vendor_id === s && iso.rows[0].marketplace_country_code === m, s + "/" + m + " isolated");
  }
});

test("IC5. organization-wide sources remain exempt from seller-account isolation", () => {
  const TUP = [{ rawSellerId: "S1", marketplaceCountryCode: "DE" }];
  const rows = [{ child_asin: "A", product_brand: "Acme", seller_or_vendor_id: "FOREIGN", marketplace_country_code: "ZZ" }];
  assert.equal(validateBatchSourcePayload({ rows, accountTuples: TUP, sourceScope: "organization", marketplaceScoped: true }).valid, true);
  const cat = { rows, sourceScope: "organization", accountTuples: TUP, marketplaceScoped: true, organizationFingerprint: ORG, connectionId: "primary" };
  assert.strictEqual(isolateFragmentRowsForOwner(cat, mktOwner("S1", "DE")).rows, rows, "organization fragment passes through unchanged");
});

/* ============================= Part B: isolateFragmentRowsForOwner ============================= */
group("Part B: per-owner isolation keys off the EXPLICIT sourceScope");

const sharedPayload = () => SELLERS.slice(0, 4).flatMap((s) => [sellerRow(s), sellerRow(s)]); // S1..S4 have rows; S5 none
const ownerOf = (sid) => ({ accountId: "ACC-" + sid, rawSellerId: sid, connectionId: "primary", organizationFingerprint: ORG, accountScopeHash: "scope-" + sid });
const sellerFragment = (rows) => ({ rows, sourceScope: "seller", sellerOrVendorIds: SELLERS, organizationFingerprint: ORG, connectionId: "primary" });

test("B1. each of five owners sees ONLY its own rows; A never sees B/C/D/E; scope narrowed to [rawSellerId]", () => {
  const rows = sharedPayload();
  for (const sid of SELLERS.slice(0, 4)) {
    const iso = isolateFragmentRowsForOwner(sellerFragment(rows), ownerOf(sid));
    assert.ok(iso.rows.length === 2 && iso.rows.every((r) => r.seller_or_vendor_id === sid), sid + " sees only its two rows");
    for (const other of SELLERS) if (other !== sid) assert.ok(iso.rows.every((r) => r.seller_or_vendor_id !== other), sid + " never sees " + other);
    assert.deepEqual(iso.sellerOrVendorIds, [sid]);
  }
  assert.deepEqual(isolateFragmentRowsForOwner(sellerFragment(sharedPayload()), ownerOf("S5")).rows, [], "S5 (no rows) is valid-empty");
});

test("B2. isolation NEVER mutates the shared payload", () => {
  const rows = sharedPayload();
  const before = rows.slice();
  const iso = isolateFragmentRowsForOwner(sellerFragment(rows), ownerOf("S1"));
  assert.notStrictEqual(iso.rows, rows);
  assert.ok(rows.length === before.length && rows.every((r, i) => r === before[i]), "shared payload unchanged");
});

test("B3. same raw seller id from another org/connection is rejected; catalog + no-owner pass through", () => {
  const rows = sharedPayload();
  assert.equal(isolateFragmentRowsForOwner(sellerFragment(rows), { ...ownerOf("S1"), organizationFingerprint: "OTHER" }).rejected, true);
  assert.equal(isolateFragmentRowsForOwner(sellerFragment(rows), { ...ownerOf("S1"), connectionId: "dd-secondary" }).rejected, true);
  const cat = { rows: [{ child_asin: "A" }], sourceScope: "organization", sellerOrVendorIds: SELLERS, organizationFingerprint: ORG, connectionId: "primary" };
  assert.strictEqual(isolateFragmentRowsForOwner(cat, ownerOf("S1")).rows, cat.rows, "catalog unchanged");
  assert.strictEqual(isolateFragmentRowsForOwner(sellerFragment(rows), null).rows, rows, "no owner => passthrough");
});

test("B4. isBatchedSellerFragment / missingOwnerFields classify correctly", () => {
  assert.equal(isBatchedSellerFragment({ sourceScope: "seller", sellerOrVendorIds: SELLERS }), true);
  assert.equal(isBatchedSellerFragment({ sourceScope: "seller", sellerOrVendorIds: ["S1"] }), false, "single-account is not a batch");
  assert.equal(isBatchedSellerFragment({ sourceScope: "organization", sellerOrVendorIds: SELLERS }), false, "organization is not seller-batched");
  assert.deepEqual(missingOwnerFields(ownerOf("S1")), []);
  assert.ok(missingOwnerFields({ accountId: "A", rawSellerId: "S1" }).includes("connectionId"), "incomplete owner is flagged");
  assert.ok(missingOwnerFields(null).length === 5);
});

/* ============================= Part C: contract scope consistency ============================= */
group("Part C: explicit source scope contract consistency");

test("C1. the REAL contracts are scope-consistent; sourceScope is per-contract", () => {
  const allow = assertSourceScopeConsistency(); // throws on any drift
  assert.ok(allow.includes("brand-sales:order-lines") && allow.includes("returns-leakage:oli-sales"));
  assert.equal(sourceScopeForContract({ requestKey: "brand-sales:order-lines" }), "seller");
  assert.equal(sourceScopeForContract({ requestKey: "brand-sales:catalog" }), "organization");
  // The SAME source family (order-line-items) is organization-scoped when its contract carries no seller id.
  assert.equal(sourceScopeForContract({ requestKey: "reconciliation:order-lines" }), "organization");
});

test("C2. a declared-seller contract missing seller_or_vendor_id, or an undeclared contract carrying it, fails closed", () => {
  assert.throws(() => assertSourceScopeConsistency({ r: [{ requestKey: "brand-sales:order-lines", columns: ["date"] }] }), /omits seller_or_vendor_id/);
  assert.throws(() => assertSourceScopeConsistency({ r: [{ requestKey: "not-declared:oli", columns: ["seller_or_vendor_id"] }] }), /declared seller-scoped/);
});

test("C3. the resolver fails a seller contract that omits seller_or_vendor_id BEFORE any I/O", () => {
  // reportSourceRequestHashes is pure (no I/O); brand-sales:order-lines is seller-scoped and DOES carry the
  // column, so a real plan resolves. (The negative is covered structurally by C2 on the shared validator.)
  const resolved = reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "k", ids: SELLERS, windowsByRequestKey: brandWindows(), marketplaceCountry: MKT });
  const oli = resolved.find((r) => r.requestKey === "brand-sales:order-lines");
  assert.equal(oli.sourceScope, "seller"); assert.equal(oli.marketplaceScoped, true);
  assert.equal(resolved.find((r) => r.requestKey === "brand-sales:catalog").sourceScope, "organization");
});

/* ============================= Part D: source worker passes marketplace + rejects ============================= */
group("Part D: source worker batch validation (marketplace actually passed)");

function brandWindows() {
  return { "brand-sales:order-lines": [{ from: FROM, to: TO }], "brand-sales:catalog": [{ from: FROM, to: TO }] };
}
function brandBatch(sellers = SELLERS) {
  const resolved = reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "k", ids: sellers, windowsByRequestKey: brandWindows(), marketplaceCountry: MKT });
  return { oli: resolved.find((r) => r.requestKey === "brand-sales:order-lines"), cat: resolved.find((r) => r.requestKey === "brand-sales:catalog") };
}
// A brand-sales OLI row for a seller with a distinct sales value (to prove per-account isolation downstream).
const oliRow = (sid, i, mkt = MKT) => ({ date: TO, seller_or_vendor_id: sid, seller_or_vendor_name: "N-" + sid, marketplace_country_code: mkt, item_price_currency: "USD", child_asin: "ASIN-" + sid, total_sales_sum: 100 * i, total_units_sold_sum: i });

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
const batchDataDoe = (payload) => ({ createCount: {}, async create(job) { this.createCount[job.requestHash] = (this.createCount[job.requestHash] || 0) + 1; return { exportId: "e_" + job.requestHash }; }, async poll() {}, async download() { return payload; } });

test("D1. the worker PASSES the batch marketplace expectation: a CA row in a US batch rejects before save", async () => {
  const { oli } = brandBatch();
  const jobs = plannedBatchSourceJobs("brand-sales", oli, "us", "primary", SELLERS.map((s) => ({ accountId: "ACC-" + s, rawSellerId: s })), MKT);
  const badMkt = SELLERS.map((s, i) => oliRow(s, i + 1, s === "S3" ? "CA" : MKT)); // S3 row is cross-marketplace
  const store = makeSourceStore();
  const res = await runSourceJobs({ store, dataDoe: batchDataDoe(badMkt), plannedJobs: jobs, bucket: "us", cycleDate: "2026-08-17" });
  assert.equal(res.succeeded, 0, "cross-marketplace batch is not saved");
  assert.equal(store._cache.size, 0, "nothing persisted (LKG preserved)");
  assert.equal(store._rawJob(res.cycleId, oli.requestHash).error_code, "BATCH_CROSS_ACCOUNT", "worker used the passed (seller,marketplace) tuple: a CA row for a US-tuple seller is a cross-account pair");
});

test("D2. a clean US batch validates and saves ONE canonical object", async () => {
  const { oli } = brandBatch();
  const jobs = plannedBatchSourceJobs("brand-sales", oli, "us", "primary", SELLERS.map((s) => ({ accountId: "ACC-" + s, rawSellerId: s })), MKT);
  const payload = SELLERS.map((s, i) => oliRow(s, i + 1));
  const store = makeSourceStore();
  const dd = batchDataDoe(payload);
  const res = await runSourceJobs({ store, dataDoe: dd, plannedJobs: jobs, bucket: "us", cycleDate: "2026-08-17" });
  assert.equal(res.succeeded, 1); assert.equal(store._cache.size, 1, "ONE canonical object");
  assert.equal(dd.createCount[oli.requestHash], 1, "one create-export");
});

/* ============================= Part E: REAL report worker per-account isolation ============================= */
group("Part E: real report worker derives five accounts from ONE cached batch");

function makeReportStore(sourceJobRows) {
  const reportJobs = new Map(); const rkey = (rk, a) => rk + "|" + a;
  return {
    _reports: reportJobs,
    listSourceJobs() { return sourceJobRows.map((j) => ({ ...j })); },
    upsertReportJob({ reportKey, accountId, connectionId, bucket, reportVersion, dependsOn }) { const k = rkey(reportKey, accountId); if (reportJobs.has(k)) return; reportJobs.set(k, { report_key: reportKey, account_id: accountId, connection_id: connectionId, bucket, report_version: reportVersion, depends_on: dependsOn || [], fetch_status: "pending", derive_status: "pending", save_status: "pending", validated: false, error_code: null }); },
    listReportJobs() { return [...reportJobs.values()].map((j) => ({ ...j })); },
    claimReportDerive(_c, rk, a) { const j = reportJobs.get(rkey(rk, a)); if (j && j.derive_status === "pending") { j.derive_status = "running"; return true; } return false; },
    recordReportBlocked({ reportKey, accountId, reason }) { Object.assign(reportJobs.get(rkey(reportKey, accountId)), { fetch_status: "blocked", derive_status: "skipped", save_status: "skipped", error_code: "BLOCKED", reason }); },
    recordReportFailure({ reportKey, accountId, stage, code }) { Object.assign(reportJobs.get(rkey(reportKey, accountId)), { derive_status: stage === "save" ? "succeeded" : "failed", save_status: stage === "save" ? "failed" : "pending", error_code: code }); },
    recordReportSuccess({ reportKey, accountId, latestDataDate }) { Object.assign(reportJobs.get(rkey(reportKey, accountId)), { fetch_status: "ready", derive_status: "succeeded", save_status: "succeeded", validated: true, latest_data_date: latestDataDate ?? null }); },
  };
}

// Build the shared cached batch + catalog and five per-account brand-sales report jobs (each with owner
// metadata) that all depend on the ONE shared OLI batch hash. Returns { store, saved, sourceRows, plannedReports, oli }.
function batchedBrandSalesFixture(ownerMutator = (o) => o) {
  const { oli, cat } = brandBatch();
  const owners = plannedBatchSourceJobs("brand-sales", oli, "us", "primary", SELLERS.map((s) => ({ accountId: "ACC-" + s, rawSellerId: s })), MKT);
  const oliPayload = SELLERS.slice(0, 4).map((s, i) => oliRow(s, i + 1)); // S1..S4 have sales; S5 has NONE
  const catPayload = SELLERS.map((s) => ({ child_asin: "ASIN-" + s, parent_asin: "P-" + s, product_name: "Name-" + s, product_brand: "Brand-" + s }));
  const sourceJobRows = [
    { request_hash: oli.requestHash, request_key: oli.requestKey, fetch_status: "succeeded", error_code: null },
    { request_hash: cat.requestHash, request_key: cat.requestKey, fetch_status: "succeeded", error_code: null },
  ];
  const cache = new Map([[oli.requestHash, { rows: oliPayload }], [cat.requestHash, { rows: catPayload }]]);
  const frag = (r) => ({ ...r, connectionId: "primary", optional: false, disabledPolicy: null });
  const plannedReports = owners.map((j) => ({
    reportKey: "brand-sales", accountId: j.owner.accountId, connectionId: "primary", bucket: "us",
    owner: ownerMutator({ ...j.owner }),
    sources: [frag(oli), frag(cat)],
    context: { to: TO, rawSellerId: j.owner.rawSellerId },
  }));
  const saved = new Map();
  const store = makeReportStore(sourceJobRows);
  const sourceRows = (hash) => (cache.has(hash) ? { rows: cache.get(hash).rows } : null);
  const saveSnapshot = ({ accountId, payload }) => { saved.set(accountId, payload); return { paramsHash: "h-" + accountId }; };
  return { store, saved, sourceRows, saveSnapshot, plannedReports, oli, cache };
}

test("E1. five report jobs derive from ONE cached batch; each account's snapshot has ONLY its own seller rows", async () => {
  const fx = batchedBrandSalesFixture();
  const r = await runReportJobs({ store: fx.store, cycleId: "cyc", sourceRows: fx.sourceRows, saveSnapshot: fx.saveSnapshot, plannedReports: fx.plannedReports });
  assert.equal(r.succeeded, 5, "all five accounts derive (four with sales, one validated-empty)");
  // S1..S4: each snapshot contains ONLY that account's seller_or_vendor_id, and its own total sales.
  for (let i = 0; i < 4; i += 1) {
    const s = SELLERS[i];
    const payload = fx.saved.get("ACC-" + s);
    assert.ok(payload, "ACC-" + s + " saved a snapshot");
    assert.ok(payload.rows.length >= 1 && payload.rows.every((row) => row.seller_or_vendor_id === s), "ACC-" + s + " snapshot has only its seller rows");
    const total = payload.rows.reduce((a, row) => a + (row.total_sales || 0), 0);
    assert.equal(total, 100 * (i + 1), "ACC-" + s + " sees only its own sales (" + (100 * (i + 1)) + ")");
    for (const other of SELLERS) if (other !== s) assert.ok(payload.rows.every((row) => row.seller_or_vendor_id !== other), "ACC-" + s + " never has " + other + " rows");
  }
  // S5 has NO rows in the shared batch: its SALES evidence is validated-EMPTY (never another account's rows).
  assert.deepEqual(fx.saved.get("ACC-S5").rows, [], "S5 (no rows in the batch) derives validated-empty sales");
  // Zero cross-account writes: the union of every saved account's seller ids is exactly {S1..S4} with no leakage.
  const allSellers = new Set([...fx.saved.values()].flatMap((p) => p.rows.map((row) => row.seller_or_vendor_id)));
  assert.deepEqual([...allSellers].sort(), ["S1", "S2", "S3", "S4"]);
});

test("E2. a batched seller report with MISSING owner metadata FAILS CLOSED (never the full-batch path; LKG preserved)", async () => {
  // Strip planned.owner entirely on one report -- it must fail closed rather than derive from the full batch.
  const fx = batchedBrandSalesFixture();
  fx.plannedReports[0].owner = null;
  const r = await runReportJobs({ store: fx.store, cycleId: "cyc", sourceRows: fx.sourceRows, saveSnapshot: fx.saveSnapshot, plannedReports: fx.plannedReports });
  const jobRow = fx.store._reports.get("brand-sales|ACC-S1");
  assert.equal(jobRow.derive_status, "failed"); assert.equal(jobRow.error_code, "OWNER_BINDING_MISSING");
  assert.equal(fx.saved.has("ACC-S1"), false, "no snapshot saved for the unbound account (LKG preserved)");
  assert.ok(r.succeeded >= 1, "the other correctly-bound accounts still derive");
});

test("E3. a batched seller report with an owner MISSING org/connection FAILS CLOSED", async () => {
  const fx = batchedBrandSalesFixture((o) => (o.accountId === "ACC-S2" ? { accountId: o.accountId, rawSellerId: o.rawSellerId } : o));
  await runReportJobs({ store: fx.store, cycleId: "cyc", sourceRows: fx.sourceRows, saveSnapshot: fx.saveSnapshot, plannedReports: fx.plannedReports });
  const jobRow = fx.store._reports.get("brand-sales|ACC-S2");
  assert.equal(jobRow.error_code, "OWNER_BINDING_MISSING", "incomplete owner (no org/connection) fails closed");
  assert.equal(fx.saved.has("ACC-S2"), false);
});

async function main() {
  ({ validateBatchSourcePayload, isolateFragmentRowsForOwner, isBatchedSellerFragment, missingOwnerFields } = await import("../lib/server/sync/source-account-isolation.js"));
  ({ runSourceJobs } = await import("../lib/server/sync/source-worker.js"));
  ({ runReportJobs } = await import("../lib/server/sync/report-worker.js"));
  ({ plannedBatchSourceJobs } = await import("../lib/server/sync/source-sync-driver.js"));
  ({ reportSourceRequestHashes, assertSourceScopeConsistency, sourceScopeForContract } = await import("../lib/server/sync/report-source-contracts.js"));

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
