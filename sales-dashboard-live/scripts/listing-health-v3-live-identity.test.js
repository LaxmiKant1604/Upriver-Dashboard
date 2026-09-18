// WORK C/D correction round 3 (Codex blocker 3) -- the LHv3 SEMANTIC payload-identity COVERAGE hardening. The hook
// previously only rejected non-empty gaps when gaps was already an array, so it accepted { complete:true, gaps:"corrupt" },
// { complete:true, gaps:[], coveredFrom:null }, and { complete:false, gaps:[] }. This suite proves the strengthened
// checks: gaps MUST be an array of well-formed, in-window, strictly-ascending {from,to} intervals; complete ===
// (gaps.length === 0); a complete window carries coveredFrom===from and coveredTo===to. It ALSO proves -- against the
// REAL deriveReportSnapshot -- that no genuine payload (fully-covered / partial / no-coverage / multi-gap) is rejected,
// and drives the REAL publishSchedulerV2Snapshot end to end (malformed coverage -> invalid-snapshot, never promoted;
// a real-derived payload passes the semantic gate -> published). Offline; ZERO network. 7-bit ASCII, LF.
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { listingHealthV3SemanticIdentity } from "../lib/server/reports/listing-health-v3-live-identity.js";
import { LISTING_HEALTH_DEFAULT_WINDOW_DAYS } from "../lib/server/reports/listing-health-advanced.js";
import { addDaysStr } from "../lib/server/date-windows.js";
import { deriveReportSnapshot, REPORT_DERIVATIONS } from "../lib/server/sync/report-derivation.js";
import { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, publishSchedulerV2Snapshot } from "../lib/server/sync/report-publisher.js";
import { paramsHashFor } from "../lib/server/report-store.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "listing-health-v3-live-identity\n");

const ACCT = "acct-00", SELLER = "SELLER-1", ASOF = "2026-09-04";
const WFROM = addDaysStr(ASOF, -(LISTING_HEALTH_DEFAULT_WINDOW_DAYS - 1)); // 2026-08-06
const WIN = { kind: "30D", from: WFROM, to: ASOF, days: LISTING_HEALTH_DEFAULT_WINDOW_DAYS };
// A synthetic payload that PASSES the hook, overridable per-case.
const base = (o = {}) => ({
  accountId: ACCT, asOf: ASOF, window: { ...WIN },
  coverage: { requestedFrom: WFROM, requestedTo: ASOF, coveredFrom: WFROM, coveredTo: ASOF, complete: true, gaps: [] },
  ...o,
});
const covP = (coverage) => base({ coverage });
const reason = (p, args = { accountId: ACCT, to: ASOF }) => listingHealthV3SemanticIdentity(p, args).reason;
const passes = (p, args = { accountId: ACCT, to: ASOF }) => listingHealthV3SemanticIdentity(p, args).ok === true;

// ---- (1) happy path + account/asOf/window (regression of the blocker-1 checks) ----
ok("canonical synthetic payload passes", passes(base()));
ok("payload not an object -> payload-not-object", reason(null) === "payload-not-object");
ok("expected `to` not a real date -> expected-to-not-a-date", reason(base(), { accountId: ACCT, to: "2026-99-99" }) === "expected-to-not-a-date");
ok("account mismatch -> payload-account-mismatch", reason(base({ accountId: "OTHER" })) === "payload-account-mismatch");
ok("asOf mismatch -> payload-asof-mismatch", reason(base({ asOf: "2026-09-03" })) === "payload-asof-mismatch");
ok("window.kind != 30D -> payload-window-kind", reason(base({ window: { ...WIN, kind: "7D" } })) === "payload-window-kind");
ok("window.from shifted -> payload-window-from", reason(base({ window: { ...WIN, from: "2026-08-01" } })) === "payload-window-from");
ok("window.to != to -> payload-window-to", reason(base({ window: { ...WIN, to: "2026-09-03" } })) === "payload-window-to");

// ---- (2) coverage consistency (blocker 3): each malformed state is rejected with its exact reason ----
ok("coverage missing -> payload-coverage-missing", reason(base({ coverage: null })) === "payload-coverage-missing");
ok("coverage is an array -> payload-coverage-missing", reason(base({ coverage: [] })) === "payload-coverage-missing");
ok("requested range != window -> payload-coverage-window", reason(covP({ requestedFrom: "2026-01-01", requestedTo: ASOF, complete: true, gaps: [] })) === "payload-coverage-window");
ok("complete not a boolean -> payload-coverage-complete", reason(covP({ requestedFrom: WFROM, requestedTo: ASOF, complete: "yes", gaps: [] })) === "payload-coverage-complete");
ok("gaps not an array ('corrupt') -> payload-coverage-gaps-not-array", reason(covP({ requestedFrom: WFROM, requestedTo: ASOF, coveredFrom: null, coveredTo: null, complete: false, gaps: "corrupt" })) === "payload-coverage-gaps-not-array");
ok("a gap that is not an object -> payload-coverage-gap-not-object", reason(covP({ requestedFrom: WFROM, requestedTo: ASOF, coveredFrom: null, coveredTo: null, complete: false, gaps: ["2026-08-10"] })) === "payload-coverage-gap-not-object");
ok("a gap with a non-date -> payload-coverage-gap-date", reason(covP({ requestedFrom: WFROM, requestedTo: ASOF, coveredFrom: null, coveredTo: null, complete: false, gaps: [{ from: "nope", to: ASOF }] })) === "payload-coverage-gap-date");
ok("a gap with an impossible calendar date (2026-02-30) -> payload-coverage-gap-date", reason(covP({ requestedFrom: WFROM, requestedTo: ASOF, coveredFrom: null, coveredTo: null, complete: false, gaps: [{ from: "2026-02-30", to: ASOF }] })) === "payload-coverage-gap-date");
ok("a reversed gap (from > to) -> payload-coverage-gap-reversed", reason(covP({ requestedFrom: WFROM, requestedTo: ASOF, coveredFrom: null, coveredTo: null, complete: false, gaps: [{ from: "2026-08-20", to: "2026-08-10" }] })) === "payload-coverage-gap-reversed");
ok("a gap outside the window -> payload-coverage-gap-out-of-window", reason(covP({ requestedFrom: WFROM, requestedTo: ASOF, coveredFrom: null, coveredTo: null, complete: false, gaps: [{ from: "2020-01-01", to: "2020-01-02" }] })) === "payload-coverage-gap-out-of-window");
ok("a gap ending after the window -> payload-coverage-gap-out-of-window", reason(covP({ requestedFrom: WFROM, requestedTo: ASOF, coveredFrom: null, coveredTo: null, complete: false, gaps: [{ from: "2026-09-01", to: "2027-01-01" }] })) === "payload-coverage-gap-out-of-window");
ok("overlapping / unordered gaps -> payload-coverage-gap-unordered", reason(covP({ requestedFrom: WFROM, requestedTo: ASOF, coveredFrom: null, coveredTo: null, complete: false, gaps: [{ from: "2026-08-10", to: "2026-08-20" }, { from: "2026-08-15", to: "2026-08-25" }] })) === "payload-coverage-gap-unordered");
ok("complete=true with any gap -> payload-coverage-gaps", reason(covP({ requestedFrom: WFROM, requestedTo: ASOF, coveredFrom: WFROM, coveredTo: ASOF, complete: true, gaps: [{ from: "2026-08-10", to: "2026-08-11" }] })) === "payload-coverage-gaps");
ok("complete=false with no gaps -> payload-coverage-incomplete-no-gaps", reason(covP({ requestedFrom: WFROM, requestedTo: ASOF, coveredFrom: WFROM, coveredTo: "2026-08-20", complete: false, gaps: [] })) === "payload-coverage-incomplete-no-gaps");
ok("complete=true but coveredTo != window.to -> payload-coverage-covered-window", reason(covP({ requestedFrom: WFROM, requestedTo: ASOF, coveredFrom: WFROM, coveredTo: "2026-08-20", complete: true, gaps: [] })) === "payload-coverage-covered-window");
ok("complete=true but coveredFrom is null -> payload-coverage-covered-window", reason(covP({ requestedFrom: WFROM, requestedTo: ASOF, coveredFrom: null, coveredTo: null, complete: true, gaps: [] })) === "payload-coverage-covered-window");
ok("partial coverage coveredTo out of window -> payload-coverage-range", reason(covP({ requestedFrom: WFROM, requestedTo: ASOF, coveredFrom: WFROM, coveredTo: "2027-01-01", complete: false, gaps: [{ from: "2026-09-01", to: ASOF }] })) === "payload-coverage-range");

// ---- (3) genuine coverage states that MUST pass (never reject a real derivation output) ----
ok("genuine PARTIAL (one in-window gap, coveredFrom/To real) passes", passes(covP({ requestedFrom: WFROM, requestedTo: ASOF, coveredFrom: WFROM, coveredTo: "2026-08-20", complete: false, gaps: [{ from: "2026-08-21", to: ASOF }] })));
ok("genuine NO-COVERAGE (whole-window gap, both covered null) passes", passes(covP({ requestedFrom: WFROM, requestedTo: ASOF, coveredFrom: null, coveredTo: null, complete: false, gaps: [{ from: WFROM, to: ASOF }] })));
ok("genuine MULTI-GAP (leading + trailing, covered null) passes", passes(covP({ requestedFrom: WFROM, requestedTo: ASOF, coveredFrom: null, coveredTo: null, complete: false, gaps: [{ from: WFROM, to: "2026-08-14" }, { from: "2026-08-21", to: ASOF }] })));

// ---- REAL-DERIVED payloads (via the CANONICAL deriveReportSnapshot) pass the hook for every coverage shape ----
const listingRow = (sku) => ({ seller_or_vendor_id: SELLER, marketplace_country_code: "US", sku, child_asin: `ASIN-${sku}`, listing_name: `L ${sku}`, listing_status: "Active", listing_price_value: 9, listing_price_currency: "USD", listing_current_quantity: 0, fba_quantity_available: 0, listing_fulfillment_channel: "AMAZON_NA", listing_open_date: "2024-01-01" });
const oliRow = (date, sku, sales, units) => ({ account_id: ACCT, seller_or_vendor_id: SELLER, sale_date: date, sku, child_asin: `ASIN-${sku}`, currency: "USD", sales_amount: sales, ordered_units: units, unpriced_units: 0 });
const noDate = (rk, rows) => ({ available: true, rows, fragments: [{ requestKey: rk, from: null, to: null, sellerOrVendorIds: [SELLER], rows }], disabled: false, disabledPolicy: null, reason: null });
const SOURCES = {
  "listing-health-v3:listings": noDate("listing-health-v3:listings", [listingRow("A")]),
  "listing-health-v3:listings-raw": noDate("listing-health-v3:listings-raw", [{ seller_or_vendor_id: SELLER, marketplace_country_code: "US", sku: "A", child_asin: "ASIN-A", summaries: JSON.stringify({ status: ["BUYABLE"] }), issues: JSON.stringify([]), offers: JSON.stringify([{ price: { amount: 9 } }]) }]),
  "listing-health-v3:inventory": { available: false },
};
function derive(coverageWindows) {
  const context = {
    // marketCountry = the trusted account-directory marketplace the derive requires to validate row ownership (matches
    // these US rows); the real planner + live-promote bundle always supply it.
    to: ASOF, inventoryAsOf: ASOF, accountId: ACCT, rawSellerId: SELLER, marketCountry: "US",
    listingHealthV3DurableOli: { available: true, rows: [oliRow("2026-08-10", "A", 10, 1)], coverageWindows, completenessRows: [] },
    listingHealthV3DurableCatalog: { available: true, rows: [{ child_asin: "ASIN-A", product_name: "P A", product_brand: "BrandX" }] },
  };
  const r = deriveReportSnapshot({ reportKey: "listing-health-v3", sources: SOURCES, context });
  assert.equal(r.status, "derived", "fixture must derive (" + r.status + "/" + (r.reason || "") + ")");
  return r.payload;
}
{
  const full = derive([{ from: "2024-01-01", to: ASOF }]);
  ok("REAL-DERIVED fully-covered payload passes the hook (complete=true, covered===window)", passes(full) && full.coverage.complete === true && full.coverage.coveredFrom === WFROM && full.coverage.coveredTo === ASOF);
  const partial = derive([{ from: WFROM, to: "2026-08-20" }]);
  ok("REAL-DERIVED partial-coverage payload passes the hook (complete=false + a genuine in-window gap)", passes(partial) && partial.coverage.complete === false && partial.coverage.gaps.length >= 1);
  const none = derive([]);
  ok("REAL-DERIVED no-coverage payload passes the hook (whole-window gap, covered null)", passes(none) && none.coverage.coveredFrom === null && none.coverage.gaps.length >= 1);
}

// ---- (4) PUBLISHER behavioral: the REAL publishSchedulerV2Snapshot runs the semantic hook BEFORE the live CAS. A
//      malformed / wrong-account / inconsistent-coverage payload => disposition 'invalid-snapshot' (NEVER promoted;
//      live LKG untouched); a real-derived canonical payload passes the semantic gate => 'published'. Same 4-gate +
//      validated-job + shadow hash-provenance + storage-first path as production (source-promoted contract). ----
{
  const LIVE_VERSION = SCHEDULER_LIVE_SNAPSHOT_CONTRACTS["listing-health-v3"].liveReportVersion;
  const SHADOW_VERSION = REPORT_DERIVATIONS["listing-health-v3"].snapshotVersion;
  assert.notEqual(LIVE_VERSION, SHADOW_VERSION, "live vs shadow versions differ");
  const params = { reportVersion: SHADOW_VERSION, accountId: ACCT, to: ASOF };
  const jobHash = paramsHashFor(SHADOW_VERSION, params);
  const publisherDeps = (payload) => ({
    codeReadyKeys: ["listing-health-v3"],
    getPromotedPublishSettings: async () => [{ report_key: "listing-health-v3", publish_enabled: true }],
    loadAccountRollout: async () => ({ read: "ok", allPrimary: false, enabledAccountIds: [ACCT] }),
    discoverPrimaryAccounts: async () => [{ accountId: ACCT, country: "US", currency: "USD", name: "Acct" }],
    getPublishApproval: async () => ({ read: "ok", approved: true }),
    getLatestReportJob: async () => ({ cycle_id: "cyc-1", validated: true, snapshot_params_hash: jobHash, derive_status: "succeeded", save_status: "succeeded", cycle_status: "succeeded" }),
    getShadowSnapshot: async () => ({ params_hash: jobHash, params: { ...params }, payload, source_refreshed_at: "2026-09-04T07:00:00.000Z" }),
    loadStoragePayload: async () => null,
    publishLive: async (a) => ({ outcome: "inserted", liveRefreshedAt: a.sourceRefreshedAt }),
  });
  const publish = (payload) => publishSchedulerV2Snapshot(publisherDeps(payload), { reportKey: "listing-health-v3", accountId: ACCT });
  const good = derive([{ from: "2024-01-01", to: ASOF }]);
  ok("PUBLISHER: a real-derived canonical payload passes the semantic gate -> published", (await publish(good)).disposition === "published");
  ok("PUBLISHER: gaps:'corrupt' payload -> invalid-snapshot (never promoted)", (await publish({ ...good, coverage: { ...good.coverage, gaps: "corrupt" } })).disposition === "invalid-snapshot");
  ok("PUBLISHER: wrong-account payload -> invalid-snapshot", (await publish({ ...good, accountId: "OTHER" })).disposition === "invalid-snapshot");
  ok("PUBLISHER: complete=false with no gaps -> invalid-snapshot", (await publish({ ...good, coverage: { ...good.coverage, complete: false, gaps: [] } })).disposition === "invalid-snapshot");
  ok("PUBLISHER: complete=true with coveredTo != window.to -> invalid-snapshot", (await publish({ ...good, coverage: { ...good.coverage, coveredTo: "2026-08-20" } })).disposition === "invalid-snapshot");
}

writeSync(1, `\nlisting-health-v3-live-identity: ${passed} assertions passed\n`);
