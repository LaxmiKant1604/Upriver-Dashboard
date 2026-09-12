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

// The canonical 30D default window for a given `to` (D-1): from = to-(30-1). Matches resolveListingHealthWindow.
const WINDOW_FROM = "2026-08-06"; // 2026-09-04 minus 29 days
// A structurally valid listing-health-v3 payload that ALSO passes the LHv3 semantic-identity hook (accountId===acct,
// asOf===to, canonical 30D window {kind,from,to,days}). Overridable via `extra` for the negative cases.
const validPayload = (asOf = EXPECTED_D1, extra = {}) => ({
  accountId: ACCT, asOf, rows: [], catalogBrands: [], currencies: [], issuesAvailable: true,
  window: { kind: "30D", from: WINDOW_FROM, to: asOf, days: 30 },
  coverage: { requestedFrom: WINDOW_FROM, requestedTo: asOf, coveredFrom: WINDOW_FROM, coveredTo: asOf, complete: true, gaps: [] }, salesWindowStatus: "covered",
  inventory: { available: false }, listingCount: 0, issuesUnavailableReason: null, salesSource: "order-line-items", ...extra,
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

// ---- SEMANTIC identity (Codex blocker 1 repro): a structurally-valid row whose PAYLOAD is for a different account or
//      a different day/window is REJECTED even at the exact D-1 row identity + params_hash ----
{
  const wrong = validPayload(EXPECTED_D1, { accountId: "OTHER", asOf: "2026-09-03", window: { kind: "30D", from: "2026-08-05", to: "2026-09-03", days: 30 } });
  ok("EXACT repro: exact-D-1 row identity + params_hash but payload account=OTHER + asOf/window=D-2 -> NOT ok", (await make({ row: liveRow({ payload: wrong }) })({ accountId: ACCT })).ok === false);
  ok("payload.accountId mismatch -> semantic payload-account-mismatch", (await make({ row: liveRow({ payload: validPayload(EXPECTED_D1, { accountId: "OTHER" }) }) })({ accountId: ACCT })).reason.includes("payload-account-mismatch"));
  ok("payload.asOf = D-2 (row/params D-1) -> semantic payload-asof-mismatch", (await make({ row: liveRow({ payload: validPayload(EXPECTED_D1, { asOf: "2026-09-03" }) }) })({ accountId: ACCT })).reason.includes("payload-asof-mismatch"));
  ok("payload.window.to = D-2 -> semantic payload-window-to", (await make({ row: liveRow({ payload: validPayload(EXPECTED_D1, { window: { kind: "30D", from: WINDOW_FROM, to: "2026-09-03", days: 30 } }) }) })({ accountId: ACCT })).reason.includes("payload-window-to"));
  ok("payload.window.kind = 7D -> semantic payload-window-kind", (await make({ row: liveRow({ payload: validPayload(EXPECTED_D1, { window: { kind: "7D", from: "2026-08-29", to: EXPECTED_D1, days: 7 } }) }) })({ accountId: ACCT })).reason.includes("payload-window-kind"));
  ok("payload.window.from shifted (not to-29) -> semantic payload-window-from", (await make({ row: liveRow({ payload: validPayload(EXPECTED_D1, { window: { kind: "30D", from: "2026-08-01", to: EXPECTED_D1, days: 30 } }) }) })({ accountId: ACCT })).reason.includes("payload-window-from"));
  ok("payload.window.to a malformed calendar date (2026-02-30) -> semantic reject", (await make({ row: liveRow({ payload: validPayload(EXPECTED_D1, { asOf: "2026-02-30", window: { kind: "30D", from: "2026-02-01", to: "2026-02-30", days: 30 } }) }) })({ accountId: ACCT })).ok === false);
  ok("the CANONICAL exact-D-1 payload with the 30D window passes the semantic hook (regression of the happy path)", (await make({ row: liveRow() })({ accountId: ACCT })).ok === true);
  // coverage internal consistency (Codex blocker 1: "coverage/window dates are real and internally consistent")
  ok("coverage.requestedFrom != window.from -> semantic payload-coverage-window", (await make({ row: liveRow({ payload: validPayload(EXPECTED_D1, { coverage: { requestedFrom: "2026-01-01", requestedTo: EXPECTED_D1, complete: true, gaps: [] } }) }) })({ accountId: ACCT })).reason.includes("payload-coverage-window"));
  ok("coverage.complete=true with non-empty gaps -> semantic payload-coverage-gaps", (await make({ row: liveRow({ payload: validPayload(EXPECTED_D1, { coverage: { requestedFrom: WINDOW_FROM, requestedTo: EXPECTED_D1, complete: true, gaps: [{ from: "2026-08-10", to: "2026-08-11" }] } }) }) })({ accountId: ACCT })).reason.includes("payload-coverage-gaps"));
  // coveredTo outside the window (a valid gap present so the partial state is internally consistent) -> range check.
  ok("coverage.coveredTo outside the window -> semantic payload-coverage-range", (await make({ row: liveRow({ payload: validPayload(EXPECTED_D1, { coverage: { requestedFrom: WINDOW_FROM, requestedTo: EXPECTED_D1, coveredTo: "2027-01-01", complete: false, gaps: [{ from: "2026-09-01", to: EXPECTED_D1 }] } }) }) })({ accountId: ACCT })).reason.includes("payload-coverage-range"));
  ok("missing coverage object -> NOT ok (rejected by the structural validatePayload before the semantic hook)", (await make({ row: liveRow({ payload: validPayload(EXPECTED_D1, { coverage: null }) }) })({ accountId: ACCT })).ok === false);
  // ---- Blocker 3 (semantic coverage consistency): the strict resolver rejects every malformed coverage state so a
  //      corrupt/degraded coverage can never serve as this account's exact-D-1 coverage (serve falls through to preview).
  const covPayload = (coverage) => validPayload(EXPECTED_D1, { coverage });
  const covReason = async (coverage) => (await make({ row: liveRow({ payload: covPayload(coverage) }) })({ accountId: ACCT })).reason || "";
  ok("coverage.gaps not an array ('corrupt') -> payload-coverage-gaps-not-array", (await covReason({ requestedFrom: WINDOW_FROM, requestedTo: EXPECTED_D1, coveredFrom: null, coveredTo: null, complete: false, gaps: "corrupt" })).includes("payload-coverage-gaps-not-array"));
  ok("a gap that is not an object -> payload-coverage-gap-not-object", (await covReason({ requestedFrom: WINDOW_FROM, requestedTo: EXPECTED_D1, coveredFrom: null, coveredTo: null, complete: false, gaps: ["2026-08-10"] })).includes("payload-coverage-gap-not-object"));
  ok("a reversed gap (from > to) -> payload-coverage-gap-reversed", (await covReason({ requestedFrom: WINDOW_FROM, requestedTo: EXPECTED_D1, coveredFrom: null, coveredTo: null, complete: false, gaps: [{ from: "2026-08-20", to: "2026-08-10" }] })).includes("payload-coverage-gap-reversed"));
  ok("a gap outside the window -> payload-coverage-gap-out-of-window", (await covReason({ requestedFrom: WINDOW_FROM, requestedTo: EXPECTED_D1, coveredFrom: null, coveredTo: null, complete: false, gaps: [{ from: "2020-01-01", to: "2020-01-02" }] })).includes("payload-coverage-gap-out-of-window"));
  ok("overlapping / unordered gaps -> payload-coverage-gap-unordered", (await covReason({ requestedFrom: WINDOW_FROM, requestedTo: EXPECTED_D1, coveredFrom: null, coveredTo: null, complete: false, gaps: [{ from: "2026-08-10", to: "2026-08-20" }, { from: "2026-08-15", to: "2026-08-25" }] })).includes("payload-coverage-gap-unordered"));
  ok("complete=false with NO gaps -> payload-coverage-incomplete-no-gaps", (await covReason({ requestedFrom: WINDOW_FROM, requestedTo: EXPECTED_D1, coveredFrom: WINDOW_FROM, coveredTo: "2026-08-20", complete: false, gaps: [] })).includes("payload-coverage-incomplete-no-gaps"));
  ok("complete=true but coveredTo != window.to -> payload-coverage-covered-window", (await covReason({ requestedFrom: WINDOW_FROM, requestedTo: EXPECTED_D1, coveredFrom: WINDOW_FROM, coveredTo: "2026-08-20", complete: true, gaps: [] })).includes("payload-coverage-covered-window"));
  ok("complete=true with coveredFrom=null -> payload-coverage-covered-window (a genuine complete window is fully covered)", (await covReason({ requestedFrom: WINDOW_FROM, requestedTo: EXPECTED_D1, coveredFrom: null, coveredTo: null, complete: true, gaps: [] })).includes("payload-coverage-covered-window"));
  // A genuine PARTIAL payload (one real in-window gap, coveredFrom/To real) still passes the semantic hook.
  ok("a genuine PARTIAL coverage (one in-window gap, complete=false) PASSES the semantic hook", (await make({ row: liveRow({ payload: covPayload({ requestedFrom: WINDOW_FROM, requestedTo: EXPECTED_D1, coveredFrom: WINDOW_FROM, coveredTo: "2026-08-20", complete: false, gaps: [{ from: "2026-08-21", to: EXPECTED_D1 }] }) }) })({ accountId: ACCT })).ok === true);
}

writeSync(1, `\nlisting-health-v3-live-resolver: ${passed} assertions passed\n`);
