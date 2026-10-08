// ZERO-EXPORT durable FBA-inventory persist (backstop enabler) -- since the Listings inventory cutover the fba job lands
// the account's SAVED LISTINGS snapshot (public.source_listings_snapshot) from the ALREADY-FETCHED canonical Listings batch
// (fba-plan:awd). FBA Inventory Health (source_snapshots 'fba-inventory-health') is retired and is never written here.
//
// Covers: (A) per-account persist of the SAVED LISTINGS pointer -- asOf = the cycle's inventoryAsOf, validatedAt = the
// batch's fetched_at, sourceRequestHash = the (date-free) batch request hash; (B) European cross-market isolation (a
// seller's rows in a DIFFERENT warehouse marketplace are NEVER attributed/double-counted); (C) cache miss -> skip (no
// fabrication); (D) valid-EMPTY for a proven batch member -> persisted honestly, a NON-member empty and a pre-cutover (not
// expanded) payload are SKIPPED; (E) one account's persist failure never blocks the others; (F) only fetched (included)
// accounts are persisted; (G) idempotent CAS acks are not errors; (H) incomplete owner metadata fails closed; (N) never a
// source_snapshots / fba-inventory-health write; (I) structural zero export + the go-live/release/route wiring; (SEAM) the
// persisted pointer drives the FBA reconciler's revision. Offline; zero network. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { persistDurableListingsSnapshotsFromPlan, DURABLE_LISTINGS_SOURCE_KEY } from "../lib/server/sync/fba-durable-source-persist.js";
import { computeFbaAccountRevision, FBA_REVISION_STATUS } from "../lib/server/sync/fba-inventory-revision.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const ASOF = "2026-09-22";               // the cycle's inventory as-of (the pointer's as_of)
const FETCHED_AT = "2026-09-23T04:10:00.000Z"; // the Listings batch fetch time (the pointer's validated_at)
const ORG = "org-1";
const BATCH_HASH = "LISTINGS-BATCH-HASH-1";

const ownerOf = (accountId, rawSellerId, marketplace) => ({
  accountId, rawSellerId, connectionId: "primary", organizationFingerprint: ORG,
  accountScopeHash: "scope-" + rawSellerId, marketplace,
});
// Every account's Listings source is the SAME shared batch fragment (batch requestHash + the batch's seller ids).
const listingsSource = (over = {}) => ({
  requestKey: "fba-plan:awd", requestHash: BATCH_HASH,
  sellerOrVendorIds: ["sA", "sB", "sC"], sourceScope: "seller",
  organizationFingerprint: ORG, connectionId: "primary", ...over,
});
const requestOf = (accountId, rawSellerId, marketplace, sources = [listingsSource()]) => ({
  accountId, owner: ownerOf(accountId, rawSellerId, marketplace), sources,
});

// An EXPANDED (post-cutover, 18-column) canonical Listings row.
const listingsRow = (seller, mkt, sku, available) => ({
  seller_or_vendor_id: seller, marketplace_country_code: mkt, sku, child_asin: "B0" + sku.toUpperCase(),
  listing_fulfillment_channel: "AMAZON_EU",
  fba_quantity_available: available, fba_quantity_inbound: 0, fba_quantity_reserved: 1, fba_quantity_fc_transfer: 0,
  awd_available_distributable_quantity: null, awd_total_inbound_quantity: null,
});
// A PRE-CUTOVER (15-column) Listings row: fba_quantity_available only, no inbound / reserved / fc-transfer keys.
const preCutoverRow = (seller, mkt, sku, available) => ({
  seller_or_vendor_id: seller, marketplace_country_code: mkt, sku, child_asin: "B0" + sku.toUpperCase(),
  listing_fulfillment_channel: "AMAZON_EU", fba_quantity_available: available,
});

// Batch payload: seller sA rows in GB (2) + a cross-warehouse sA row in DE (must NOT be attributed to the GB account),
// seller sB rows in DE (1), and a FOREIGN seller sX (must be excluded from both). Seller sC is a batch MEMBER with no rows.
const BATCH_ROWS = [
  listingsRow("sA", "GB", "a1", 10),
  listingsRow("sA", "GB", "a2", 5),
  listingsRow("sA", "DE", "aX", 99),
  listingsRow("sB", "DE", "b1", 7),
  listingsRow("sX", "GB", "x1", 1),
];

function makeIO(over = {}) {
  const saveCalls = [], recordCalls = [], healthCalls = [];
  const loadSourceExportCache = over.loadSourceExportCache || (async (h) => (h === BATCH_HASH ? { rows: BATCH_ROWS, fetched_at: FETCHED_AT } : null));
  const saveSnapshotPayload = over.saveSnapshotPayload || (async (a) => {
    saveCalls.push(a);
    const sha = "sha-" + a.scopeKey;
    return { objectPath: "source-snapshots/" + a.sourceKey + "/" + a.scopeKey + "/" + sha + ".json", payloadSha: sha, payloadBytes: JSON.stringify({ rows: a.rows }).length };
  });
  const recordListingsSnapshot = over.recordListingsSnapshot || (async (a) => { recordCalls.push(a); return { write: "ok", ack: "replaced" }; });
  // A TRAP for the retired source_snapshots recorder: the persist must never reach it (it is not even a parameter).
  const recordSnapshot = async (a) => { healthCalls.push(a); throw new Error("source_snapshots write attempted"); };
  return { saveCalls, recordCalls, healthCalls, loadSourceExportCache, saveSnapshotPayload, recordListingsSnapshot, recordSnapshot };
}

const A_ID = "acct-A", B_ID = "acct-B";
const baseArgs = (io, over = {}) => ({
  reportRequests: over.reportRequests || [requestOf(A_ID, "sA", "GB"), requestOf(B_ID, "sB", "DE")],
  includedIds: over.includedIds || [A_ID, B_ID],
  inventoryAsOf: over.inventoryAsOf || ASOF,
  loadSourceExportCache: io.loadSourceExportCache, saveSnapshotPayload: io.saveSnapshotPayload,
  recordListingsSnapshot: io.recordListingsSnapshot,
  recordSnapshot: io.recordSnapshot, // ignored by the persist (trap)
});

// (A) per-account persist of the SAVED LISTINGS pointer.
test("A: persists per account the SAVED LISTINGS pointer (asOf=inventoryAsOf, validatedAt=batch fetched_at, sourceRequestHash=batch hash)", async () => {
  const io = makeIO();
  const out = await persistDurableListingsSnapshotsFromPlan(baseArgs(io));
  ok("both accounts persisted", out.persisted.length === 2 && out.failed.length === 0 && out.skipped.length === 0);
  const recA = io.recordCalls.find((c) => c.accountId === A_ID);
  const recB = io.recordCalls.find((c) => c.accountId === B_ID);
  ok("A recorded under the org + primary connection + its account id + marketplace GB", recA && recA.organizationFingerprint === ORG && recA.connectionId === "primary" && recA.marketplace === "GB");
  ok("B recorded with marketplace DE", recB && recB.marketplace === "DE");
  ok("asOf = the cycle's inventoryAsOf (the requested day the readers prove)", recA.asOf === ASOF && recB.asOf === ASOF);
  ok("validatedAt = the batch's fetched_at (the Listings fetch time), never a wall clock", recA.validatedAt === FETCHED_AT && recB.validatedAt === FETCHED_AT);
  ok("sourceRequestHash = the date-free batch request hash (shared with the v3 materializer)", recA.sourceRequestHash === BATCH_HASH && recB.sourceRequestHash === BATCH_HASH);
  ok("objectPath / payloadSha / rowCount / payloadBytes come from the content-addressed save", recA.objectPath.endsWith("/" + recA.payloadSha + ".json") && recA.rowCount === 2 && recA.payloadBytes > 0);
  ok("the payload is saved under sourceKey 'listings', scoped per account", DURABLE_LISTINGS_SOURCE_KEY === "listings" && io.saveCalls.every((c) => c.sourceKey === "listings") && io.saveCalls.map((c) => c.scopeKey).sort().join(",") === [A_ID, B_ID].join(","));
  ok("the result reports the batch hash + row counts", out.persisted.find((p) => p.accountId === A_ID).requestHash === BATCH_HASH && out.persisted.find((p) => p.accountId === B_ID).rowCount === 1);
});

test("A2: asOf is the INVENTORY as-of passed in (not the fetch day); validatedAt stays the batch fetched_at", async () => {
  const io = makeIO();
  await persistDurableListingsSnapshotsFromPlan(baseArgs(io, { inventoryAsOf: "2026-09-21", reportRequests: [requestOf(A_ID, "sA", "GB")], includedIds: [A_ID] }));
  const rec = io.recordCalls[0];
  ok("asOf = 2026-09-21 (inventoryAsOf), not the fetched_at day 2026-09-23", rec && rec.asOf === "2026-09-21");
  ok("validatedAt = FETCHED_AT", rec.validatedAt === FETCHED_AT);
});

test("A3: a cached batch WITHOUT fetched_at is skipped (never stamped with a fabricated fetch time)", async () => {
  const io = makeIO({ loadSourceExportCache: async () => ({ rows: BATCH_ROWS }) });
  const out = await persistDurableListingsSnapshotsFromPlan(baseArgs(io));
  ok("both skipped batch-fetched-at-missing; zero writes", out.persisted.length === 0 && out.skipped.filter((s) => s.reason === "batch-fetched-at-missing").length === 2 && io.saveCalls.length === 0 && io.recordCalls.length === 0);
  const io2 = makeIO({ loadSourceExportCache: async () => ({ rows: BATCH_ROWS, fetchedAt: FETCHED_AT }) });
  await persistDurableListingsSnapshotsFromPlan(baseArgs(io2, { reportRequests: [requestOf(A_ID, "sA", "GB")], includedIds: [A_ID] }));
  ok("a camelCase fetchedAt is honoured", io2.recordCalls.length === 1 && io2.recordCalls[0].validatedAt === FETCHED_AT);
});

// (B) EUROPEAN CROSS-MARKET: the isolated rows are EXACTLY the account's seller + marketplace.
test("B: European cross-market isolation -- only this account's seller+marketplace rows persist (no cross-warehouse double-count)", async () => {
  const io = makeIO();
  await persistDurableListingsSnapshotsFromPlan(baseArgs(io));
  const saveA = io.saveCalls.find((c) => c.scopeKey === A_ID);
  const saveB = io.saveCalls.find((c) => c.scopeKey === B_ID);
  ok("A persists ONLY its GB rows (a1,a2) -- the DE row aX and foreign seller sX are excluded", saveA.rows.length === 2 && saveA.rows.every((r) => r.seller_or_vendor_id === "sA" && r.marketplace_country_code === "GB"));
  ok("A does NOT contain the cross-warehouse DE row aX (no double-count)", !saveA.rows.some((r) => r.sku === "aX"));
  ok("B persists ONLY its DE row b1", saveB.rows.length === 1 && saveB.rows[0].sku === "b1" && saveB.rows[0].marketplace_country_code === "DE");
  ok("the persisted rows are the expanded Listings rows byte-for-byte (no reshaping)", JSON.stringify(saveB.rows[0]) === JSON.stringify(BATCH_ROWS[3]));
  const recA = io.recordCalls.find((c) => c.accountId === A_ID);
  ok("recorded row_count matches the isolated rows (2 for A)", recA.rowCount === 2);
});

// (C) cache miss -> SKIP, never a persist, never fabrication.
test("C: source-cache miss -> account skipped (no persist, no fabricated snapshot)", async () => {
  const io = makeIO({ loadSourceExportCache: async () => null });
  const out = await persistDurableListingsSnapshotsFromPlan(baseArgs(io));
  ok("nothing persisted; both skipped source-cache-miss", out.persisted.length === 0 && out.skipped.filter((s) => s.reason === "source-cache-miss").length === 2);
  ok("no save/record calls (LKG untouched, no fabrication)", io.saveCalls.length === 0 && io.recordCalls.length === 0);
});

// (D) VALID-EMPTY for a proven batch member -> persisted HONESTLY as empty.
test("D: a batch MEMBER with zero rows persists an EMPTY pointer (honest unavailable, never fabricated, never dropped)", async () => {
  const io = makeIO();
  const out = await persistDurableListingsSnapshotsFromPlan(baseArgs(io, { reportRequests: [requestOf("acct-C", "sC", "GB")], includedIds: ["acct-C"] }));
  const recC = io.recordCalls.find((c) => c.accountId === "acct-C");
  ok("acct-C persisted as VALID-EMPTY (row_count 0), not skipped/failed", out.persisted.length === 1 && recC && recC.rowCount === 0 && out.failed.length === 0);
  const saveC = io.saveCalls.find((c) => c.scopeKey === "acct-C");
  ok("the empty snapshot carries an EMPTY rows array (no fabricated units)", Array.isArray(saveC.rows) && saveC.rows.length === 0);
});

test("D2: a NON-member's empty isolation is SKIPPED (missing membership != empty) -- zero writes", async () => {
  const io = makeIO();
  const out = await persistDurableListingsSnapshotsFromPlan(baseArgs(io, { reportRequests: [requestOf("acct-Z", "sZ", "GB")], includedIds: ["acct-Z"] }));
  ok("acct-Z skipped not-a-batch-member", out.persisted.length === 0 && out.skipped.length === 1 && out.skipped[0].reason === "not-a-batch-member");
  ok("no save / record for the non-member (its LKG pointer stays)", io.saveCalls.length === 0 && io.recordCalls.length === 0);
});

test("D3: a PRE-CUTOVER (not expanded) Listings payload is SKIPPED -- it never replaces the pointer from the fba job", async () => {
  const old = [preCutoverRow("sA", "GB", "a1", 10), preCutoverRow("sA", "GB", "a2", 5)];
  const io = makeIO({ loadSourceExportCache: async () => ({ rows: old, fetched_at: FETCHED_AT }) });
  const out = await persistDurableListingsSnapshotsFromPlan(baseArgs(io, { reportRequests: [requestOf(A_ID, "sA", "GB")], includedIds: [A_ID] }));
  ok("15-column payload -> skipped listings-not-expanded; zero writes", out.persisted.length === 0 && out.skipped[0] && out.skipped[0].reason === "listings-not-expanded" && io.saveCalls.length === 0 && io.recordCalls.length === 0);
  // A MIXED payload (one expanded row, one pre-cutover row) is also not expanded -> skipped.
  const io2 = makeIO({ loadSourceExportCache: async () => ({ rows: [listingsRow("sA", "GB", "a1", 10), preCutoverRow("sA", "GB", "a2", 5)], fetched_at: FETCHED_AT }) });
  const out2 = await persistDurableListingsSnapshotsFromPlan(baseArgs(io2, { reportRequests: [requestOf(A_ID, "sA", "GB")], includedIds: [A_ID] }));
  ok("mixed payload -> skipped listings-not-expanded; zero writes", out2.persisted.length === 0 && out2.skipped[0].reason === "listings-not-expanded" && io2.recordCalls.length === 0);
  // An expanded row whose new fields are present-but-null is STILL expanded (unknown values are the fold's job).
  const nullish = { ...listingsRow("sA", "GB", "a1", null), fba_quantity_inbound: null, fba_quantity_reserved: null, fba_quantity_fc_transfer: null };
  const io3 = makeIO({ loadSourceExportCache: async () => ({ rows: [nullish], fetched_at: FETCHED_AT }) });
  const out3 = await persistDurableListingsSnapshotsFromPlan(baseArgs(io3, { reportRequests: [requestOf(A_ID, "sA", "GB")], includedIds: [A_ID] }));
  ok("present-but-null expanded fields persist (row_count 1)", out3.persisted.length === 1 && io3.recordCalls[0].rowCount === 1);
});

// (E) one account's persist FAILURE is isolated -- the others still persist.
test("E: one account's record failure is isolated (the healthy account still persists)", async () => {
  const io = makeIO({ recordListingsSnapshot: async (a) => { if (a.accountId === B_ID) throw new Error("boom"); return { write: "ok", ack: "replaced" }; } });
  const out = await persistDurableListingsSnapshotsFromPlan(baseArgs(io));
  ok("A persisted; B failed (isolated, not blocking A)", out.persisted.some((p) => p.accountId === A_ID) && out.failed.some((f) => f.accountId === B_ID && /^persist-threw:boom/.test(f.reason)));
  ok("exactly one persisted, one failed", out.persisted.length === 1 && out.failed.length === 1);
});

// (F) only FETCHED (included) accounts are persisted.
test("F: only included accounts persist (a non-included account is never persisted)", async () => {
  const io = makeIO();
  const out = await persistDurableListingsSnapshotsFromPlan(baseArgs(io, { includedIds: [A_ID] }));
  ok("only A persisted; B untouched", out.persisted.length === 1 && out.persisted[0].accountId === A_ID && !io.recordCalls.some((c) => c.accountId === B_ID));
});
test("F2: an EMPTY includedIds persists nothing (never a full-scope fallback)", async () => {
  const io = makeIO();
  const out = await persistDurableListingsSnapshotsFromPlan(baseArgs(io, { includedIds: [] }));
  ok("empty includedIds -> zero persists, zero I/O", out.persisted.length === 0 && io.recordCalls.length === 0 && io.saveCalls.length === 0);
});

// (G) idempotent CAS acks are NOT errors (the v3 materializer re-persists the identical rows -> "unchanged").
test("G: idempotent CAS acks (unchanged / stale-save) are counted persisted, never thrown", async () => {
  for (const ack of ["unchanged", "stale-save"]) {
    const io = makeIO({ recordListingsSnapshot: async () => ({ write: "ok", ack }) });
    const out = await persistDurableListingsSnapshotsFromPlan(baseArgs(io, { reportRequests: [requestOf(A_ID, "sA", "GB")], includedIds: [A_ID] }));
    ok("ack '" + ack + "' -> persisted, no failure", out.persisted.length === 1 && out.persisted[0].ack === ack && out.failed.length === 0);
  }
});

// (H) incomplete owner metadata fails CLOSED (never a cross-account attribution).
test("H: incomplete owner metadata (missing rawSellerId) -> skipped owner-incomplete (fail closed)", async () => {
  const io = makeIO();
  const req = requestOf(A_ID, "sA", "GB"); delete req.owner.rawSellerId;
  const out = await persistDurableListingsSnapshotsFromPlan(baseArgs(io, { reportRequests: [req], includedIds: [A_ID] }));
  ok("skipped owner-incomplete; nothing persisted", out.persisted.length === 0 && out.skipped.some((s) => String(s.reason).startsWith("owner-incomplete")));
});
test("H2: a cross-organization owner is rejected by isolation (no cross-org attribution)", async () => {
  const io = makeIO();
  const req = requestOf(A_ID, "sA", "GB"); req.owner.organizationFingerprint = "other-org";
  const out = await persistDurableListingsSnapshotsFromPlan(baseArgs(io, { reportRequests: [req], includedIds: [A_ID] }));
  ok("cross-org owner -> isolation-rejected skip, nothing persisted", out.persisted.length === 0 && out.skipped.some((s) => s.reason === "isolation-rejected"));
});
test("H3: no 2-letter owner marketplace -> skipped no-marketplace (the pointer's marketplace is immutable)", async () => {
  const io = makeIO();
  const req = requestOf(A_ID, "sA", "");
  const out = await persistDurableListingsSnapshotsFromPlan(baseArgs(io, { reportRequests: [req], includedIds: [A_ID] }));
  ok("skipped no-marketplace; zero writes", out.persisted.length === 0 && out.skipped[0] && out.skipped[0].reason === "no-marketplace" && io.recordCalls.length === 0);
});

// (N) NEVER the retired FBA Inventory Health store.
test("N: a request carrying ONLY a retired fba-plan:inventory-health source is skipped (no-listings-source); nothing is ever written to source_snapshots", async () => {
  const io = makeIO({ loadSourceExportCache: async () => ({ rows: BATCH_ROWS, fetched_at: FETCHED_AT }) });
  const healthOnly = requestOf(A_ID, "sA", "GB", [listingsSource({ requestKey: "fba-plan:inventory-health", requestHash: "HEALTH-HASH" })]);
  const out = await persistDurableListingsSnapshotsFromPlan(baseArgs(io, { reportRequests: [healthOnly], includedIds: [A_ID] }));
  ok("Health-only request -> skipped no-listings-source; zero writes", out.persisted.length === 0 && out.skipped[0] && out.skipped[0].reason === "no-listings-source" && io.saveCalls.length === 0 && io.recordCalls.length === 0);
  const io2 = makeIO();
  const both = requestOf(A_ID, "sA", "GB", [listingsSource({ requestKey: "fba-plan:inventory-health", requestHash: "HEALTH-HASH" }), listingsSource()]);
  await persistDurableListingsSnapshotsFromPlan(baseArgs(io2, { reportRequests: [both, requestOf(B_ID, "sB", "DE")] }));
  ok("with both sources present, ONLY the Listings batch is read + recorded (never the Health hash)", io2.recordCalls.length === 2 && io2.recordCalls.every((c) => c.sourceRequestHash === BATCH_HASH));
  ok("the retired source_snapshots recorder is NEVER reached", io.healthCalls.length === 0 && io2.healthCalls.length === 0);
  ok("no write names fba-inventory-health (every save is sourceKey 'listings'; the pointer recorder carries no sourceKey)",
    io2.saveCalls.every((c) => c.sourceKey === "listings") && io2.recordCalls.every((c) => !("sourceKey" in c) && !("scopeKey" in c)));
});

// (I) STRUCTURAL zero export + wiring.
test("I: structural zero export -- the persist module references NO provider export/token transport symbol, and no retired Health store", async () => {
  const src = readFileSync(new URL("../lib/server/sync/fba-durable-source-persist.js", import.meta.url), "utf8");
  for (const sym of ["createExport", "exportsCreate", "makeDataDoeAdapter", "reserveTokens", "/exports", "source-sync-driver", "datadoe"]) {
    ok("module has no '" + sym + "' (zero export, structurally)", !src.includes(sym));
  }
  ok("module reuses the CANONICAL isolation + the shared expanded-shape check (no re-implementation)",
    /isolateFragmentRowsForOwner/.test(src) && /listingsRowsExpanded/.test(src) && /"fba-plan:awd"/.test(src));
  ok("module never names the retired Health store / its recorder / its identity",
    !src.includes("FBA_INVENTORY_SOURCE_KEY") && !src.includes("\"fba-inventory-health\"") && !src.includes("fba-plan:inventory-health") && !/recordSnapshot\b/.test(src) && !src.includes("resolvedFbaSnapshot") && !src.includes("validateFbaSnapshotRows"));
});
test("I2: the go-live, release, and route all wire persistDurableFbaSnapshots (the saved Listings pointer lands on the fetch path)", async () => {
  const op = readFileSync(new URL("../lib/server/sync/fba-plan-operation.js", import.meta.url), "utf8");
  const rel = readFileSync(new URL("../lib/server/sync/fba-plan-release-composition.js", import.meta.url), "utf8");
  const cli = readFileSync(new URL("./release/fba-plan-golive.mjs", import.meta.url), "utf8");
  const route = readFileSync(new URL("../api/admin/sources.js", import.meta.url), "utf8");
  ok("advanceFbaPlanBucket invokes the collaborator AFTER the publish phase (publish gets the bounded slice first) but before the outcome returns",
    /persistDurableFbaSnapshots = null/.test(op) && /await persistDurableFbaSnapshots\(/.test(op)
    && op.indexOf("base.cycleId = S(cycleId)") < op.indexOf("await persistDurableFbaSnapshots(")
    && op.indexOf("// ---------------- PUBLISH phase") < op.indexOf("await persistDurableFbaSnapshots(")
    && op.indexOf("await persistDurableFbaSnapshots(") < op.indexOf("const okReadback = typeof readbackLive"));
  ok("the op passes inventoryAsOf (never the sales asOf alone) as the pointer's as-of", /inventoryAsOf: inventoryAsOf \|\| asOf/.test(op));
  ok("the op reads reportRequests from the PLAN arg, never cost.plan",
    /Array\.isArray\(plan && plan\.reportRequests\) \? plan\.reportRequests : \[\]/.test(op) && !/cost\.plan\.reportRequests/.test(op));
  ok("the collaborator is NON-FATAL (wrapped) and never gates the fba-plan publish", /WARN durable FBA source persist failed/.test(op));
  ok("the release builds + exposes persistDurableFbaSnapshots over persistDurableListingsSnapshotsFromPlan (getSourceExportCache + the saved Listings CAS)",
    /const persistDurableFbaSnapshots = async/.test(rel) && /persistDurableListingsSnapshotsFromPlan\(/.test(rel)
    && /saveSnapshotPayload: saveSourceSnapshotPayload/.test(rel) && /recordListingsSnapshot: recordSourceListingsSnapshot/.test(rel)
    && /loadSourceExportCache: \(h\) => readExportCache\(h\)/.test(rel));
  ok("the release no longer wires the retired source_snapshots recorder or the Health overflow self-heal",
    !/recordSnapshot: recordSourceSnapshot/.test(rel) && !/recordSourceSnapshot\b/.test(rel) && !/persistDurableFbaSnapshotsFromPlan\(/.test(rel)
    && /const resolveOverflowSellers = async \(\) => \(\{ overflowSellers: new Set\(\), singleSellerHardStops: \[\] \}\)/.test(rel));
  ok("the scheduled go-live threads release.persistDurableFbaSnapshots", /persistDurableFbaSnapshots: release\.persistDurableFbaSnapshots/.test(cli));
  ok("the Data Sync route threads release.persistDurableFbaSnapshots", /persistDurableFbaSnapshots: release\.persistDurableFbaSnapshots/.test(route));
});

// ===== INTEGRATION SEAM: the persisted pointer DRIVES the FBA reconciler's revision =====
// The zero-export reconciler READS exactly what the fba job WRITES: these tests build the pointer precisely as the persist
// recorded it (as_of / source_request_hash / payload_sha / row_count / validated_at / object_path) and feed it to
// computeFbaAccountRevision -- proving the persist output is a requested-day-proven, ELIGIBLE, content-bound pointer.
const pointerOf = (rec) => ({ as_of: rec.asOf, source_request_hash: rec.sourceRequestHash, payload_sha: rec.payloadSha, row_count: rec.rowCount, validated_at: rec.validatedAt, object_path: rec.objectPath });
test("SEAM: a persisted non-empty pointer is requested-day-proven + ELIGIBLE (status AVAILABLE) and binds a 'listings|...' content token", async () => {
  const io = makeIO();
  await persistDurableListingsSnapshotsFromPlan(baseArgs(io, { reportRequests: [requestOf(A_ID, "sA", "GB")], includedIds: [A_ID] }));
  const rec = io.recordCalls.find((c) => c.accountId === A_ID);
  ok("persist recorded a pointer for A (2 isolated GB rows)", !!rec && rec.rowCount === 2);
  const rev = computeFbaAccountRevision({ organizationFingerprint: ORG, connectionId: "primary", accountId: A_ID, requestedAsOf: ASOF, snapshot: pointerOf(rec) });
  ok("the reconciler accepts the persisted pointer as ELIGIBLE (status AVAILABLE, revisionId bound)", rev.eligible === true && rev.status === FBA_REVISION_STATUS.AVAILABLE && !!rev.revisionId);
  ok("the content token is listings|account|connection|batch hash|payload_sha", rev.contentDeps.length === 1 && rev.contentDeps[0] === ["listings", A_ID, "primary", BATCH_HASH, rec.payloadSha].join("|"));
});
test("SEAM: a valid-EMPTY persisted pointer is ELIGIBLE (status PROVEN_EMPTY) -- honest unavailable, never a fabricated zero", async () => {
  const io = makeIO();
  await persistDurableListingsSnapshotsFromPlan(baseArgs(io, { reportRequests: [requestOf("acct-C", "sC", "GB")], includedIds: ["acct-C"] }));
  const rec = io.recordCalls.find((c) => c.accountId === "acct-C");
  ok("empty pointer recorded (row_count 0)", !!rec && rec.rowCount === 0);
  const rev = computeFbaAccountRevision({ organizationFingerprint: ORG, accountId: "acct-C", requestedAsOf: ASOF, snapshot: pointerOf(rec) });
  ok("valid-empty is ELIGIBLE + PROVEN_EMPTY (unavailable band, not a defer, not a zero)", rev.eligible === true && rev.status === FBA_REVISION_STATUS.PROVEN_EMPTY);
});
test("SEAM: a WRONG-DAY reconciler request DEFERS the persisted pointer (listings-snapshot-not-requested-day) -- never publishes stale as fresh", async () => {
  const io = makeIO();
  await persistDurableListingsSnapshotsFromPlan(baseArgs(io, { reportRequests: [requestOf(A_ID, "sA", "GB")], includedIds: [A_ID] }));
  const rec = io.recordCalls.find((c) => c.accountId === A_ID);
  const rev = computeFbaAccountRevision({ organizationFingerprint: ORG, accountId: A_ID, requestedAsOf: "2026-09-23", snapshot: pointerOf(rec) });
  ok("a pointer whose as_of != the reconciler's requested day DEFERS, preserving LKG", rev.eligible === false && rev.reason === "listings-snapshot-not-requested-day" && rev.contentDeps.length === 0);
});

// Guard: missing I/O collaborators fail closed with a typed error (never a silent no-op success).
test("guard: missing I/O collaborators -> typed error, zero persists", async () => {
  const out = await persistDurableListingsSnapshotsFromPlan({ reportRequests: [requestOf(A_ID, "sA", "GB")], includedIds: [A_ID], inventoryAsOf: ASOF });
  ok("typed error, nothing persisted", out.persisted.length === 0 && typeof out.error === "string" && out.error.includes("requires"));
  const io = makeIO();
  const noListingsRecorder = await persistDurableListingsSnapshotsFromPlan({ ...baseArgs(io), recordListingsSnapshot: undefined });
  ok("a source_snapshots recorder alone is NOT accepted (recordListingsSnapshot required)", typeof noListingsRecorder.error === "string" && noListingsRecorder.persisted.length === 0 && io.healthCalls.length === 0);
});
test("guard: a non-date inventoryAsOf fails closed (never records a wrong-day pointer)", async () => {
  const io = makeIO();
  const bad = await persistDurableListingsSnapshotsFromPlan({ ...baseArgs(io), inventoryAsOf: "not-a-date" });
  ok("blank/invalid inventoryAsOf -> typed error, zero persists", typeof bad.error === "string" && bad.persisted.length === 0 && io.recordCalls.length === 0);
});

async function main() {
  writeSync(1, "fba-durable-source-persist\n");
  let failures = 0;
  for (const t of tests) { try { await t.fn(); } catch (e) { failures += 1; writeSync(1, "FAIL  " + t.name + "\n" + String((e && e.stack) || e) + "\n"); } }
  writeSync(1, `\nfba-durable-source-persist: ${passed} assertions passed${failures ? ", " + failures + " FAILED" : ""}\n`);
  if (failures) process.exitCode = 1;
}
main();
