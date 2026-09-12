// WORK D correction (blocker 4) -- BEHAVIORAL tests of the STRICT serve-side live resolver
// (listing-health-v3-live-resolver.js) over injected doubles. Proves it serves a promoted row ONLY when it is the
// genuine EXACT-D-1 promotion (exact params_hash at params.to === the expected UTC-yesterday D-1, live report version,
// params provenance, storage-first hydration with NO inline fallback, validatePayload, not dataUnavailable), and
// returns { ok:false } (serve falls through to the preview) for D-2 / future / wrong account / wrong version / wrong
// hash / malformed params / storage missing/throwing / inline-fallback attempt / invalid payload / dataUnavailable.
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { buildListingHealthV3LiveResolver, expectedListingHealthV3LiveAsOf } from "../lib/server/reports/listing-health-v3-live-resolver.js";
import { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } from "../lib/server/sync/report-publisher.js";
import { REPORT_DERIVATIONS } from "../lib/server/sync/report-derivation.js";
import { paramsHashFor } from "../lib/server/report-store.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "listing-health-v3-live-resolver\n");

const ACCT = "acct-00";
const LIVE_VERSION = "listing-health-v3-shared-v1";
const FIXED_NOW = Date.parse("2026-09-05T12:00:00.000Z");
const EXPECTED_D1 = expectedListingHealthV3LiveAsOf(FIXED_NOW); // "2026-09-04"
const D1_HASH = paramsHashFor(LIVE_VERSION, { to: EXPECTED_D1 });

ok("expectedListingHealthV3LiveAsOf is UTC-yesterday (D-1)", EXPECTED_D1 === "2026-09-04");

// A structurally valid listing-health-v3 payload (passes the STRICT REPORT_DERIVATIONS validatePayload).
const validPayload = (asOf = EXPECTED_D1, extra = {}) => ({
  accountId: ACCT, asOf, rows: [], catalogBrands: [], currencies: [], issuesAvailable: true,
  window: { preset: "30D" }, coverage: {}, salesWindowStatus: "covered", inventory: { available: false },
  listingCount: 0, issuesUnavailableReason: null, salesSource: "order-line-items", ...extra,
});
// A promoted live row keyed by the EXACT expected D-1 (params_hash = D1_HASH), payload inline unless a storage path.
const liveRow = (o = {}) => ({
  report_key: "listing-health-v3", account_id: ACCT, params_hash: o.params_hash || D1_HASH,
  params: o.params || { reportVersion: LIVE_VERSION, to: EXPECTED_D1 },
  payload: "payload" in o ? o.payload : validPayload(),
  payload_storage_path: o.payload_storage_path || "", source_refreshed_at: o.source_refreshed_at || "2026-09-04T07:00:00.000Z",
});

// Build a resolver whose getReportSnapshot returns cfg.row when the lookup matches (reportKey/account/paramsHash), and
// whose loadStoragePayload returns cfg.storage (or throws if cfg.storageThrows).
function make(cfg = {}) {
  return buildListingHealthV3LiveResolver({
    getReportSnapshot: async ({ reportKey, accountId, paramsHash }) => {
      if (cfg.rowFor) return cfg.rowFor({ reportKey, accountId, paramsHash });
      return cfg.row === undefined ? null : cfg.row;
    },
    loadStoragePayload: async () => { if (cfg.storageThrows) throw new Error("storage down"); return cfg.storage === undefined ? null : cfg.storage; },
    liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS,
    reportDerivations: REPORT_DERIVATIONS,
    computeHash: paramsHashFor,
    now: () => FIXED_NOW,
  });
}

// ---- valid live promotion ----
{
  const r = await make({ row: liveRow() })({ accountId: ACCT });
  ok("VALID exact-D-1 promotion -> { ok:true, payload }", r.ok === true && r.payload && r.payload.salesSource === "order-line-items");
}
// ---- the lookup is by the EXACT D-1 hash: a D-2 / future promoted row is simply not found at the D-1 hash ----
{
  // Only a D-2-keyed row exists; the resolver looks up the D-1 hash -> no row -> miss (never serves the D-2 row).
  const d2Hash = paramsHashFor(LIVE_VERSION, { to: "2026-09-03" });
  const r = await make({ rowFor: ({ paramsHash }) => (paramsHash === d2Hash ? liveRow({ params_hash: d2Hash, params: { reportVersion: LIVE_VERSION, to: "2026-09-03" }, payload: validPayload("2026-09-03") }) : null) })({ accountId: ACCT });
  ok("a D-2 promoted row is NOT served (lookup is by the exact D-1 hash)", r.ok === false && r.reason === "no-live-snapshot");
  const futHash = paramsHashFor(LIVE_VERSION, { to: "2026-09-06" });
  const rf = await make({ rowFor: ({ paramsHash }) => (paramsHash === futHash ? liveRow({ params_hash: futHash, params: { reportVersion: LIVE_VERSION, to: "2026-09-06" } }) : null) })({ accountId: ACCT });
  ok("a FUTURE promoted row is NOT served", rf.ok === false && rf.reason === "no-live-snapshot");
}
// ---- a row returned at the D-1 hash but whose stored params.to is D-2 (tampered) fails provenance ----
{
  const r = await make({ row: liveRow({ params: { reportVersion: LIVE_VERSION, to: "2026-09-03" } }) })({ accountId: ACCT });
  ok("row with params.to=D-2 but D-1 params_hash -> params-provenance (mutated identity rejected)", r.ok === false && r.reason === "params-provenance");
}
// ---- wrong account / version / hash ----
{
  ok("wrong account echo -> identity-account", (await make({ row: { ...liveRow(), account_id: "acct-99" } })({ accountId: ACCT })).reason === "identity-account");
  ok("wrong report version -> live-version", (await make({ row: liveRow({ params: { reportVersion: "listing-health/v3-oli-window", to: EXPECTED_D1 } }) })({ accountId: ACCT })).reason === "live-version");
  ok("row params_hash != looked-up hash -> identity-hash", (await make({ row: { ...liveRow(), params_hash: "deadbeef" } })({ accountId: ACCT })).reason === "identity-hash");
  ok("malformed params (no reportVersion) -> live-version", (await make({ row: liveRow({ params: { to: EXPECTED_D1 } }) })({ accountId: ACCT })).reason === "live-version");
}
// ---- storage-first: no inline fallback ----
{
  // storage path present + storage returns null -> payload-dangling (NOT the inline payload).
  const rNull = await make({ row: liveRow({ payload_storage_path: "obj/p.json", payload: validPayload() }), storage: null })({ accountId: ACCT });
  ok("storage path + storage MISSING -> payload-dangling (no inline fallback)", rNull.ok === false && rNull.reason === "payload-dangling");
  const rThrow = await make({ row: liveRow({ payload_storage_path: "obj/p.json", payload: validPayload() }), storageThrows: true })({ accountId: ACCT });
  ok("storage path + storage THROWS -> payload-dangling (no inline fallback)", rThrow.ok === false && rThrow.reason === "payload-dangling");
  // storage path present + storage returns the valid payload -> ok (storage-first authoritative).
  const rOk = await make({ row: liveRow({ payload_storage_path: "obj/p.json", payload: null }), storage: validPayload() })({ accountId: ACCT });
  ok("storage path + storage hydrates the valid payload -> ok", rOk.ok === true && rOk.payload.salesSource === "order-line-items");
}
// ---- invalid payload / dataUnavailable / no row / blank account ----
{
  ok("payload fails validatePayload -> payload-contract", (await make({ row: liveRow({ payload: { accountId: ACCT, asOf: EXPECTED_D1 } }) })({ accountId: ACCT })).reason === "payload-contract");
  ok("payload dataUnavailable:true -> payload-contract", (await make({ row: liveRow({ payload: validPayload(EXPECTED_D1, { dataUnavailable: true }) }) })({ accountId: ACCT })).reason === "payload-contract");
  ok("no promoted row -> no-live-snapshot", (await make({ row: null })({ accountId: ACCT })).reason === "no-live-snapshot");
  ok("blank account -> blank-account (never a cross-account read)", (await make({ row: liveRow() })({ accountId: "" })).reason === "blank-account");
}

writeSync(1, `\nlisting-health-v3-live-resolver: ${passed} assertions passed\n`);
