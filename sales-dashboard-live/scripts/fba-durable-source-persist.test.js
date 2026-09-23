// ZERO-EXPORT durable FBA source-snapshot persist (backstop enabler) -- focused regression tests for the proven
// FBA-reconciler gap: the fba-plan go-live fetched + derived FBA inventory but NEVER wrote the durable
// source_snapshots(fba-inventory-health) row the zero-export reconciler reads, so the backstop could not converge.
//
// Covers: (A) per-account persist from a shared batch payload under the EXACTLY-reconciler-expected per-seller
// identity resolvedFbaSnapshot(account).requestHash; (B) European cross-market isolation (a seller's rows in a
// DIFFERENT warehouse marketplace are NEVER attributed/double-counted); (C) cache miss -> skip (no fabrication);
// (D) valid-EMPTY inventory -> persisted honestly (unavailable, never a fabricated zero, never skipped); (E) one
// account's persist failure never blocks the others; (F) only fetched (included) accounts are persisted; (G)
// idempotent CAS acks (unchanged / stale-save) are not errors; (H) incomplete owner metadata fails closed;
// (I) structural zero export + the go-live/release/route wiring. Offline; zero network. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { persistDurableFbaSnapshotsFromPlan } from "../lib/server/sync/fba-durable-source-persist.js";
import { resolvedFbaSnapshot } from "../lib/server/sync/source-bucket-sync.js";
import { FBA_INVENTORY_SOURCE_KEY } from "../lib/server/sync/source-durable-model.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const ASOF = "2026-09-22";
const BUCKET = "europe-au";
const API_KEY = "fixture-key";
const ORG = "org-1";
const BATCH_HASH = "BATCH-HASH-1";

// The reconciler's expected per-seller identity for an account -- recomputed EXACTLY as resolveExpectedRequestHash does.
const expectedHashFor = (rawSellerId, country) =>
  String(resolvedFbaSnapshot({ apiKey: API_KEY, account: { rawSellerId, country }, asOf: ASOF, bucket: BUCKET }).requestHash);

const ownerOf = (accountId, rawSellerId, marketplace) => ({
  accountId, rawSellerId, connectionId: "primary", organizationFingerprint: ORG,
  accountScopeHash: "scope-" + rawSellerId, marketplace,
});
// Every account's inventory source is the SAME shared batch fragment (batch requestHash + the batch's seller ids).
const invSource = () => ({
  requestKey: "fba-plan:inventory-health", requestHash: BATCH_HASH,
  sellerOrVendorIds: ["sA", "sB"], sourceScope: "seller",
  organizationFingerprint: ORG, connectionId: "primary",
});
const requestOf = (accountId, rawSellerId, marketplace) => ({
  accountId, owner: ownerOf(accountId, rawSellerId, marketplace), sources: [invSource()],
});

// Batch payload: seller sA rows in GB (2) + a cross-warehouse sA row in DE (must NOT be attributed to the GB account),
// seller sB rows in DE (1), and a FOREIGN seller sX (must be excluded from both).
const BATCH_ROWS = [
  { seller_or_vendor_id: "sA", marketplace_country_code: "GB", sku: "a1", available_units: 10 },
  { seller_or_vendor_id: "sA", marketplace_country_code: "GB", sku: "a2", available_units: 5 },
  { seller_or_vendor_id: "sA", marketplace_country_code: "DE", sku: "aX", available_units: 99 },
  { seller_or_vendor_id: "sB", marketplace_country_code: "DE", sku: "b1", available_units: 7 },
  { seller_or_vendor_id: "sX", marketplace_country_code: "GB", sku: "x1", available_units: 1 },
];

function makeIO(over = {}) {
  const saveCalls = [], recordCalls = [];
  const loadSourceExportCache = over.loadSourceExportCache || (async (h) => (h === BATCH_HASH ? { rows: BATCH_ROWS } : null));
  const saveSnapshotPayload = over.saveSnapshotPayload || (async (a) => {
    saveCalls.push(a);
    return { objectPath: "source-snapshots/" + a.scopeKey + "/sha.json", payloadSha: "sha-" + a.scopeKey, payloadBytes: JSON.stringify({ rows: a.rows }).length };
  });
  const recordSnapshot = over.recordSnapshot || (async (a) => { recordCalls.push(a); return { write: "ok", ack: "replaced" }; });
  return { saveCalls, recordCalls, loadSourceExportCache, saveSnapshotPayload, recordSnapshot };
}

const A_ID = "acct-A", B_ID = "acct-B";
const baseArgs = (io, over = {}) => ({
  reportRequests: over.reportRequests || [requestOf(A_ID, "sA", "GB"), requestOf(B_ID, "sB", "DE")],
  includedIds: over.includedIds || [A_ID, B_ID],
  inventoryAsOf: ASOF, bucket: BUCKET, apiKey: API_KEY,
  accountsById: over.accountsById || new Map([[A_ID, { country: "UK" }], [B_ID, { country: "DE" }]]),
  loadSourceExportCache: io.loadSourceExportCache, saveSnapshotPayload: io.saveSnapshotPayload, recordSnapshot: io.recordSnapshot,
});

// (A) + (I) per-account persist under the EXACT per-seller reconciler identity, from the shared batch.
test("A: persists per account under resolvedFbaSnapshot(account).requestHash (the exact identity the reconciler recomputes)", async () => {
  const io = makeIO();
  const out = await persistDurableFbaSnapshotsFromPlan(baseArgs(io));
  ok("both accounts persisted", out.persisted.length === 2 && out.failed.length === 0);
  const recA = io.recordCalls.find((c) => c.scopeKey === A_ID);
  const recB = io.recordCalls.find((c) => c.scopeKey === B_ID);
  ok("A persisted under the per-seller identity the reconciler expects", recA && recA.sourceRequestHash === expectedHashFor("sA", "UK"));
  ok("B persisted under the per-seller identity the reconciler expects", recB && recB.sourceRequestHash === expectedHashFor("sB", "DE"));
  ok("both persisted to source_snapshots(fba-inventory-health), scoped per account", recA.sourceKey === FBA_INVENTORY_SOURCE_KEY && recA.scopeKey === A_ID && recB.sourceKey === FBA_INVENTORY_SOURCE_KEY && recB.scopeKey === B_ID);
  ok("A's per-seller identity DIFFERS from B's (no cross-account collision)", recA.sourceRequestHash !== recB.sourceRequestHash);
});

// (B) EUROPEAN CROSS-MARKET: the isolated rows are EXACTLY the account's seller + marketplace -- a same-seller row in a
// DIFFERENT warehouse marketplace and a foreign seller are BOTH excluded (never double-counted / cross-attributed).
test("B: European cross-market isolation -- only this account's seller+marketplace rows persist (no cross-warehouse double-count)", async () => {
  const io = makeIO();
  await persistDurableFbaSnapshotsFromPlan(baseArgs(io));
  const saveA = io.saveCalls.find((c) => c.scopeKey === A_ID);
  const saveB = io.saveCalls.find((c) => c.scopeKey === B_ID);
  ok("A persists ONLY its GB rows (a1,a2) -- the DE row aX and foreign seller sX are excluded", saveA.rows.length === 2 && saveA.rows.every((r) => r.seller_or_vendor_id === "sA" && r.marketplace_country_code === "GB"));
  ok("A does NOT contain the cross-warehouse DE row aX (no double-count)", !saveA.rows.some((r) => r.sku === "aX"));
  ok("B persists ONLY its DE row b1", saveB.rows.length === 1 && saveB.rows[0].sku === "b1" && saveB.rows[0].marketplace_country_code === "DE");
  const recA = io.recordCalls.find((c) => c.scopeKey === A_ID);
  ok("recorded row_count matches the isolated rows (2 for A)", recA.rowCount === 2);
});

// (C) cache miss -> SKIP, never a persist, never fabrication.
test("C: source-cache miss -> account skipped (no persist, no fabricated snapshot)", async () => {
  const io = makeIO({ loadSourceExportCache: async () => null });
  const out = await persistDurableFbaSnapshotsFromPlan(baseArgs(io));
  ok("nothing persisted; both skipped source-cache-miss", out.persisted.length === 0 && out.skipped.filter((s) => s.reason === "source-cache-miss").length === 2);
  ok("no save/record calls (LKG untouched, no fabrication)", io.saveCalls.length === 0 && io.recordCalls.length === 0);
});

// (D) VALID-EMPTY inventory (a seller with zero matching rows) -> persisted HONESTLY as empty (unavailable), never
// skipped-as-failed and never a fabricated zero-units row.
test("D: valid-empty inventory persists an EMPTY snapshot (honest unavailable, never fabricated, never dropped)", async () => {
  const io = makeIO();
  // account C's seller sC has NO rows in the batch -> isolation yields [] -> valid-empty.
  const args = baseArgs(io, {
    reportRequests: [requestOf("acct-C", "sC", "GB")], includedIds: ["acct-C"],
    accountsById: new Map([["acct-C", { country: "UK" }]]),
  });
  const out = await persistDurableFbaSnapshotsFromPlan(args);
  const recC = io.recordCalls.find((c) => c.scopeKey === "acct-C");
  ok("acct-C persisted as VALID-EMPTY (row_count 0), not skipped/failed", out.persisted.length === 1 && recC && recC.rowCount === 0 && out.failed.length === 0);
  const saveC = io.saveCalls.find((c) => c.scopeKey === "acct-C");
  ok("the empty snapshot carries an EMPTY rows array (no fabricated units)", Array.isArray(saveC.rows) && saveC.rows.length === 0);
});

// (E) one account's persist FAILURE is isolated -- the others still persist.
test("E: one account's record failure is isolated (the healthy account still persists)", async () => {
  const io = makeIO({ recordSnapshot: async (a) => { if (a.scopeKey === B_ID) throw new Error("boom"); return { write: "ok", ack: "replaced" }; } });
  const out = await persistDurableFbaSnapshotsFromPlan(baseArgs(io));
  ok("A persisted; B failed (isolated, not blocking A)", out.persisted.some((p) => p.accountId === A_ID) && out.failed.some((f) => f.accountId === B_ID));
  ok("exactly one persisted, one failed", out.persisted.length === 1 && out.failed.length === 1);
});

// (F) only FETCHED (included) accounts are persisted -- a blocked/excluded account is never touched.
test("F: only included accounts persist (a non-included account is never persisted)", async () => {
  const io = makeIO();
  const out = await persistDurableFbaSnapshotsFromPlan(baseArgs(io, { includedIds: [A_ID] }));
  ok("only A persisted; B untouched", out.persisted.length === 1 && out.persisted[0].accountId === A_ID && !io.recordCalls.some((c) => c.scopeKey === B_ID));
});
test("F2: an EMPTY includedIds persists nothing (never a full-scope fallback)", async () => {
  const io = makeIO();
  const out = await persistDurableFbaSnapshotsFromPlan(baseArgs(io, { includedIds: [] }));
  ok("empty includedIds -> zero persists, zero I/O", out.persisted.length === 0 && io.recordCalls.length === 0 && io.saveCalls.length === 0);
});

// (G) idempotent CAS acks are NOT errors.
test("G: idempotent CAS acks (unchanged / stale-save) are counted persisted, never thrown", async () => {
  for (const ack of ["unchanged", "stale-save"]) {
    const io = makeIO({ recordSnapshot: async () => ({ write: "ok", ack }) });
    const out = await persistDurableFbaSnapshotsFromPlan(baseArgs(io, { reportRequests: [requestOf(A_ID, "sA", "GB")], includedIds: [A_ID] }));
    ok("ack '" + ack + "' -> persisted, no failure", out.persisted.length === 1 && out.persisted[0].ack === ack && out.failed.length === 0);
  }
});

// (H) incomplete owner metadata fails CLOSED (never a cross-account attribution).
test("H: incomplete owner metadata (missing rawSellerId) -> skipped owner-incomplete (fail closed)", async () => {
  const io = makeIO();
  const req = requestOf(A_ID, "sA", "GB"); delete req.owner.rawSellerId;
  const out = await persistDurableFbaSnapshotsFromPlan(baseArgs(io, { reportRequests: [req], includedIds: [A_ID] }));
  ok("skipped owner-incomplete; nothing persisted", out.persisted.length === 0 && out.skipped.some((s) => String(s.reason).startsWith("owner-incomplete")));
});

// A cross-ORG owner can never see the batch rows (isolation rejects) -> skipped isolation-rejected.
test("H2: a cross-organization owner is rejected by isolation (no cross-org attribution)", async () => {
  const io = makeIO();
  const req = requestOf(A_ID, "sA", "GB"); req.owner.organizationFingerprint = "other-org";
  const out = await persistDurableFbaSnapshotsFromPlan(baseArgs(io, { reportRequests: [req], includedIds: [A_ID] }));
  ok("cross-org owner -> isolation-rejected skip, nothing persisted", out.persisted.length === 0 && out.skipped.some((s) => s.reason === "isolation-rejected"));
});

// (I) STRUCTURAL zero export + wiring: the module references NO provider export/token transport symbol, and the
// go-live / release / route all thread the collaborator (so the durable source actually lands on the fetch path).
test("I: structural zero export -- the persist module references NO provider export/token transport symbol", async () => {
  const src = readFileSync(new URL("../lib/server/sync/fba-durable-source-persist.js", import.meta.url), "utf8");
  for (const sym of ["createExport", "exportsCreate", "makeDataDoeAdapter", "reserveTokens", "/exports", "source-sync-driver", "datadoe"]) {
    ok("module has no '" + sym + "' (zero export, structurally)", !src.includes(sym));
  }
  ok("module reuses the CANONICAL isolation + validation + identity (no re-implementation)",
    /isolateFragmentRowsForOwner/.test(src) && /validateFbaSnapshotRows/.test(src) && /resolvedFbaSnapshot/.test(src) && /FBA_INVENTORY_SOURCE_KEY/.test(src));
});
test("I2: the go-live, release, and route all wire persistDurableFbaSnapshots (the durable source lands on the fetch path)", async () => {
  const op = readFileSync(new URL("../lib/server/sync/fba-plan-operation.js", import.meta.url), "utf8");
  const rel = readFileSync(new URL("../lib/server/sync/fba-plan-release-composition.js", import.meta.url), "utf8");
  const cli = readFileSync(new URL("./release/fba-plan-golive.mjs", import.meta.url), "utf8");
  const route = readFileSync(new URL("../api/admin/sources.js", import.meta.url), "utf8");
  ok("advanceFbaPlanBucket accepts + invokes the collaborator AFTER the terminal-cycle proof (before publish)",
    /persistDurableFbaSnapshots = null/.test(op) && /await persistDurableFbaSnapshots\(/.test(op)
    && op.indexOf("base.cycleId = S(cycleId)") < op.indexOf("await persistDurableFbaSnapshots(")
    && op.indexOf("await persistDurableFbaSnapshots(") < op.indexOf("// ---------------- PUBLISH phase"));
  ok("the collaborator is NON-FATAL (wrapped) and never gates the fba-plan publish", /WARN durable FBA source persist failed/.test(op));
  ok("the release builds + exposes persistDurableFbaSnapshots (reusing getSourceExportCache + the source-snapshot CAS)",
    /const persistDurableFbaSnapshots = async/.test(rel) && /persistDurableFbaSnapshotsFromPlan\(/.test(rel) && /saveSnapshotPayload: saveSourceSnapshotPayload/.test(rel) && /recordSnapshot: recordSourceSnapshot/.test(rel) && /loadSourceExportCache: \(h\) => readExportCache\(h\)/.test(rel));
  ok("the scheduled go-live threads release.persistDurableFbaSnapshots", /persistDurableFbaSnapshots: release\.persistDurableFbaSnapshots/.test(cli));
  ok("the Data Sync route threads release.persistDurableFbaSnapshots", /persistDurableFbaSnapshots: release\.persistDurableFbaSnapshots/.test(route));
});

// Guard: missing I/O collaborators fail closed with a typed error (never a silent no-op success).
test("guard: missing I/O collaborators -> typed error, zero persists", async () => {
  const out = await persistDurableFbaSnapshotsFromPlan({ reportRequests: [requestOf(A_ID, "sA", "GB")], includedIds: [A_ID], inventoryAsOf: ASOF, bucket: BUCKET, apiKey: API_KEY });
  ok("typed error, nothing persisted", out.persisted.length === 0 && typeof out.error === "string" && out.error.includes("requires"));
});
test("guard: a non-date inventoryAsOf fails closed (never binds a wrong-day identity)", async () => {
  const io = makeIO();
  const out = await persistDurableFbaSnapshotsFromPlan(baseArgs(io, {}));
  out.inventoryAsOf = "not-a-date"; // sanity: the real guard is below
  const bad = await persistDurableFbaSnapshotsFromPlan({ ...baseArgs(io), inventoryAsOf: "not-a-date" });
  ok("blank/invalid inventoryAsOf -> typed error, zero persists", typeof bad.error === "string" && bad.persisted.length === 0);
});

async function main() {
  writeSync(1, "fba-durable-source-persist\n");
  let failures = 0;
  for (const t of tests) { try { await t.fn(); } catch (e) { failures += 1; writeSync(1, "FAIL  " + t.name + "\n" + String((e && e.stack) || e) + "\n"); } }
  writeSync(1, `\nfba-durable-source-persist: ${passed} assertions passed${failures ? ", " + failures + " FAILED" : ""}\n`);
  if (failures) process.exitCode = 1;
}
main();
