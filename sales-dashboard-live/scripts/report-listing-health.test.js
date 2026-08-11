// Listing Health Scheduler-v2 derivation + generic-cycle parity tests (SHADOW MODE, offline).
//
// Part A drives deriveReportSnapshot("listing-health") against hand-built saved fragments and proves the
// pure payload deep-equals a hand-computed production-route fixture, plus every Listings Raw state, JSON
// issues/summary/live-offer parsing, currency isolation, inventory null-vs-genuine-zero, window + row-date
// validation, cross-account/public-raw identity, missing-source LKG, and zero network. Part B drives the
// REAL buildShadowReportPlan -> runStagedSourceCycle -> runReportJobs path (five canonical jobs, shared
// inventory/catalog dedup, strict-cap, resume, primary-only, pending-then-saved-once, disabled enrichment).

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

let assembleSources, deriveReportSnapshot, runReportJobs, runSourceJobs, plannedSourceJob, runStagedSourceCycle, sourceJobOwnerId;
let planListingHealth, planBuyBoxLoss, planSalesMovers, planReturnsLeakage, buildShadowReportPlan, SHADOW_PLANNED_REPORT_KEYS, addDaysStr;

const ID = "A1";
const ASOF = "2025-08-10";
const dash = (...p) => p.join("-");
const CONNS = [
  { id: "primary", apiKey: dash("prim", "key"), accountPrefix: "" },
  { id: "secondary", apiKey: dash("sec", "key"), accountPrefix: dash("dd", "secondary") + ":" },
];
const SOURCE_LABEL = "Listings";
const SALES_LABEL = "Profit by SKU & Date";
const ISSUES_LABEL = "Listings (Raw JSON)";
const ENABLE_HINT = "In DataDoe, open Settings > Data tables and enable Listings (Raw JSON) to add Amazon's own listing issue codes, severities and suppression flags to this report.";
const DRIVER_CONNECTION_ID = { primary: "primary", secondary: "dd-secondary" };
const DEGRADED = { disabledSource: "degraded", safeCode: "SOURCE_DISABLED", reportOutcome: "save-unavailable-snapshot" };
const TERMINAL = { disabledSource: "terminal", safeCode: "SOURCE_DISABLED", reportOutcome: "blocked" };

let SALES_FROM, INV_FROM; // computed in main()

let hashSeq = 0;
const frag = (requestKey, from, to, ids = [ID], extra = {}) => ({ requestKey, requestHash: "h" + (hashSeq += 1), from, to, sellerOrVendorIds: ids, ...extra });

function buildSources(planned, rowsByHash, statusOverride = {}) {
  const statusByHash = {};
  const loaded = new Map();
  for (const p of planned) {
    const st = statusOverride[p.requestHash] || "succeeded";
    statusByHash[p.requestHash] = st;
    if (st === "succeeded") loaded.set(p.requestHash, { rows: Object.prototype.hasOwnProperty.call(rowsByHash, p.requestHash) ? rowsByHash[p.requestHash] : [] });
  }
  return assembleSources(planned, statusByHash, loaded).sources;
}

// listings/raw/catalog are no-date; sales [SALES_FROM,ASOF]; inventory [INV_FROM,ASOF]. `rawState` controls
// the optional Listings Raw fragment: "success" | "disabled" | "disabled-terminal" | "failed" | "pending" |
// "missing". Returns { planned, rows, statusOverride } already wired for the requested raw state.
function lhPlanned({ listings = [], raw = [], sales = [], inventory = [], catalog = [], ids = [ID], rawState = "success" } = {}) {
  const planned = []; const rows = {}; const statusOverride = {};
  const add = (key, from, to, data, extra) => { const f = frag(key, from, to, ids, extra); planned.push(f); rows[f.requestHash] = data; return f; };
  add("listing-health:listings", null, null, listings);
  if (rawState !== "missing") {
    const policy = rawState === "disabled" ? DEGRADED : rawState === "disabled-terminal" ? TERMINAL : null;
    const f = add("listing-health:listings-raw", null, null, raw, policy ? { disabledPolicy: policy } : {});
    if (rawState === "disabled" || rawState === "disabled-terminal" || rawState === "failed") statusOverride[f.requestHash] = "failed";
    else if (rawState === "pending") statusOverride[f.requestHash] = "pending";
  }
  add("listing-health:sales", SALES_FROM, ASOF, sales);
  add("listing-health:inventory", INV_FROM, ASOF, inventory);
  add("listing-health:catalog", null, null, catalog);
  return { planned, rows, statusOverride };
}
const ctx = (over = {}) => ({ to: ASOF, rawSellerId: ID, accountId: ID, ...over });
const deriveLH = (built, context = ctx(), extraStatus = {}) =>
  deriveReportSnapshot({ reportKey: "listing-health", sources: buildSources(built.planned, built.rows, { ...built.statusOverride, ...extraStatus }), context });

// ---- row builders ----
const listing = (sku, asin, o = {}) => ({
  sku, child_asin: asin, listing_name: o.name ?? `Listing ${sku}`, listing_status: o.status ?? "Active",
  listing_price_value: o.price === undefined ? 0 : o.price, listing_price_currency: o.currency ?? "USD",
  listing_current_quantity: o.qty ?? 0, listing_pending_quantity: o.pending ?? 0,
  fba_quantity_available: o.fbaAvail ?? 0, fba_quantity_inbound: o.fbaInbound ?? 0, fba_quantity_reserved: o.fbaReserved ?? 0,
  listing_fulfillment_channel: o.channel ?? "", listing_open_date: o.openDate ?? null,
});
const sale = (sku, asin, currency, sales, units, profit) => ({ sku, child_asin: asin, currency, sales_sum: sales, units_sum: units, profit_sum: profit });
const inv = (date, sku, asin, available) => ({ date, sku, child_asin: asin, product_name: `P ${sku}`, currency: "USD", available });
const cat = (asin, parent, name, brand) => ({ child_asin: asin, parent_asin: parent, product_name: name, product_brand: brand });
const rawRow = (sku, asin, issues, summaries, offers) => ({ sku, child_asin: asin, summaries, issues, offers });

// ---- the hand-computed production-route fixture ----
const FIXTURE = () => ({
  listings: [
    listing("SKU-A", "ASIN-A", { name: "Listing A", status: "Active", price: 19.99, currency: "USD", qty: 100, pending: 5, fbaAvail: 80, fbaInbound: 10, fbaReserved: 3, channel: "AMAZON_NA", openDate: "2024-01-15" }),
    listing("SKU-B", "ASIN-B", { name: "Listing B", status: "Inactive", price: null, currency: "", qty: 0, channel: "DEFAULT", openDate: null }),
    listing("", "", { name: "", status: "", price: null, currency: "", channel: "" }), // blank sku + asin -> skipped, but counted in listingCount
    listing("SKU-C", "ASIN-C", { name: "", status: "Incomplete", price: 0, currency: "USD", qty: 20, channel: "", openDate: "2023-06-01" }),
  ],
  raw: [
    rawRow("SKU-A", "ASIN-A", JSON.stringify([{ severity: "ERROR", code: 8001, message: "Listing suppressed" }, { severity: "warning", message: "Low quality image" }]), [{ status: ["BUYABLE", "DISCOVERABLE"] }], [{ price: { amount: 19.99 } }]),
    rawRow("SKU-B", "ASIN-B", "not-json", { statuses: ["discoverable"] }, []),
    rawRow("", "ASIN-X", "[]", null, null), // blank sku -> skipped
  ],
  sales: [
    sale("SKU-A", "ASIN-A", "USD", 1000, 50, 300),
    sale("SKU-B", "ASIN-B", "CAD", 200, 10, 40),
    sale("", "ASIN-X", "USD", 99, 9, 9), // blank sku -> skipped
  ],
  inventory: [
    inv("2025-08-08", "SKU-A", "ASIN-A", 70), // older snapshot -> dropped
    inv("2025-08-09", "SKU-A", "ASIN-A", 75), // latest
    inv("2025-08-09", "SKU-B", "ASIN-B", 0),  // genuine zero, latest
  ],
  catalog: [
    cat("ASIN-A", "P1", "Catalog A", "Acme"),
    cat("ASIN-B", "P2", "", "Beta"), // blank catalog name -> listing name fallback
  ],
});
const expectedFixturePayload = () => ({
  accountId: "A1", asOf: "2025-08-10",
  salesWindow: { from: SALES_FROM, to: "2025-08-10", days: 30 },
  sourceLabel: SOURCE_LABEL, salesSourceLabel: SALES_LABEL,
  issuesAvailable: true, issuesUnavailableReason: null, issuesSourceLabel: ISSUES_LABEL,
  inventoryAvailable: true, inventorySnapshotDate: "2025-08-09",
  currencies: ["CAD", "USD"], listingCount: 4,
  rows: [
    { sku: "SKU-A", asin: "ASIN-A", productName: "Catalog A", brand: "Acme", listingStatus: "Active", fulfillmentChannel: "FBA", fulfillmentChannelRaw: "AMAZON_NA", price: 19.99, currency: "USD", listingQuantity: 100, fbaAvailable: 80, fbaInbound: 10, fbaReserved: 3, snapshotAvailable: 75, openDate: "2024-01-15", sales30d: 1000, units30d: 50, profit30d: 300, hasSalesData: true, issues: [{ severity: "ERROR", code: "8001", message: "Listing suppressed" }, { severity: "WARNING", code: null, message: "Low quality image" }], summary: { buyable: true, discoverable: true, status: "BUYABLE,DISCOVERABLE" }, hasLiveOffer: true },
    { sku: "SKU-B", asin: "ASIN-B", productName: "Listing B", brand: "Beta", listingStatus: "Inactive", fulfillmentChannel: "FBM", fulfillmentChannelRaw: "DEFAULT", price: null, currency: "CAD", listingQuantity: 0, fbaAvailable: 0, fbaInbound: 0, fbaReserved: 0, snapshotAvailable: 0, openDate: null, sales30d: 200, units30d: 10, profit30d: 40, hasSalesData: true, issues: [], summary: { buyable: false, discoverable: true, status: "DISCOVERABLE" }, hasLiveOffer: null },
    { sku: "SKU-C", asin: "ASIN-C", productName: null, brand: "Unassigned", listingStatus: "Incomplete", fulfillmentChannel: null, fulfillmentChannelRaw: null, price: 0, currency: "USD", listingQuantity: 20, fbaAvailable: 0, fbaInbound: 0, fbaReserved: 0, snapshotAvailable: null, openDate: "2023-06-01", sales30d: 0, units30d: 0, profit30d: 0, hasSalesData: false, issues: [], summary: null, hasLiveOffer: null },
  ],
  catalogBrands: ["Acme", "Beta"],
});

/* ============================= Part A: pure derivation parity ============================= */

group("listing-health derive: exact production-route payload parity");

test("1. pure payload deep-equals the hand-computed production-route fixture", () => {
  const r = deriveLH(lhPlanned(FIXTURE()));
  assert.equal(r.status, "derived");
  assert.deepEqual(r.payload, expectedFixturePayload());
});

test("2. listing status + FBA/FBM channel mapping (AMAZON_* => FBA, DEFAULT => FBM, blank => null)", () => {
  const p = deriveLH(lhPlanned(FIXTURE())).payload;
  const by = (sku) => p.rows.find((r) => r.sku === sku);
  assert.deepEqual([by("SKU-A").listingStatus, by("SKU-A").fulfillmentChannel, by("SKU-A").fulfillmentChannelRaw], ["Active", "FBA", "AMAZON_NA"]);
  assert.deepEqual([by("SKU-B").fulfillmentChannel, by("SKU-B").fulfillmentChannelRaw], ["FBM", "DEFAULT"]);
  assert.deepEqual([by("SKU-C").fulfillmentChannel, by("SKU-C").fulfillmentChannelRaw], [null, null]);
});

test("3. prices, currencies (listing currency then sales fallback), quantities", () => {
  const p = deriveLH(lhPlanned(FIXTURE())).payload;
  const a = p.rows.find((r) => r.sku === "SKU-A"); const b = p.rows.find((r) => r.sku === "SKU-B"); const c = p.rows.find((r) => r.sku === "SKU-C");
  assert.deepEqual([a.price, a.currency, a.listingQuantity, a.fbaAvailable, a.fbaInbound, a.fbaReserved], [19.99, "USD", 100, 80, 10, 3]);
  assert.deepEqual([b.price, b.currency], [null, "CAD"], "blank listing currency falls back to the sales currency");
  assert.deepEqual([c.price, c.currency], [0, "USD"], "a zero price is kept (0), not null");
});

test("4. currencies never merge; sorted account currency set", () => {
  assert.deepEqual(deriveLH(lhPlanned(FIXTURE())).payload.currencies, ["CAD", "USD"]);
});

test("5. 30-day sales/units/profit joined by SKU; hasSalesData flag", () => {
  const p = deriveLH(lhPlanned(FIXTURE())).payload;
  const a = p.rows.find((r) => r.sku === "SKU-A");
  assert.deepEqual([a.sales30d, a.units30d, a.profit30d, a.hasSalesData], [1000, 50, 300, true]);
  assert.deepEqual([p.rows.find((r) => r.sku === "SKU-C").sales30d, p.rows.find((r) => r.sku === "SKU-C").hasSalesData], [0, false]);
});

test("6. latest inventory snapshot: available quantity per SKU, genuine zero vs null-when-missing", () => {
  const p = deriveLH(lhPlanned(FIXTURE())).payload;
  assert.equal(p.inventorySnapshotDate, "2025-08-09", "the newest snapshot date wins");
  assert.equal(p.rows.find((r) => r.sku === "SKU-A").snapshotAvailable, 75);
  assert.equal(p.rows.find((r) => r.sku === "SKU-B").snapshotAvailable, 0, "genuine zero (SKU present in snapshot)");
  assert.equal(p.rows.find((r) => r.sku === "SKU-C").snapshotAvailable, null, "SKU absent from snapshot => null, never fabricated zero");
});

test("7. inventory snapshot unavailable => every snapshotAvailable null, inventoryAvailable false", () => {
  const p = deriveLH(lhPlanned({ ...FIXTURE(), inventory: [] })).payload;
  assert.equal(p.inventoryAvailable, false);
  assert.equal(p.inventorySnapshotDate, null);
  assert.ok(p.rows.every((r) => r.snapshotAvailable === null));
});

test("8. product-name (catalog -> listing name) + brand (catalog only) precedence; blank => Unassigned", () => {
  const p = deriveLH(lhPlanned(FIXTURE())).payload;
  assert.equal(p.rows.find((r) => r.sku === "SKU-A").productName, "Catalog A");
  assert.equal(p.rows.find((r) => r.sku === "SKU-B").productName, "Listing B", "blank catalog name -> listing name");
  assert.equal(p.rows.find((r) => r.sku === "SKU-C").productName, null);
  assert.equal(p.rows.find((r) => r.sku === "SKU-C").brand, "Unassigned");
});

test("9. JSON issues parsing + six-issue limit + malformed JSON tolerance", () => {
  const p = deriveLH(lhPlanned(FIXTURE())).payload;
  assert.deepEqual(p.rows.find((r) => r.sku === "SKU-A").issues, [{ severity: "ERROR", code: "8001", message: "Listing suppressed" }, { severity: "WARNING", code: null, message: "Low quality image" }]);
  assert.deepEqual(p.rows.find((r) => r.sku === "SKU-B").issues, [], "malformed JSON issues => []");
  // Seven issues are capped at six.
  const many = FIXTURE();
  many.raw[0] = rawRow("SKU-A", "ASIN-A", JSON.stringify(Array.from({ length: 7 }, (_v, i) => ({ severity: "INFO", code: String(i), message: "m" + i }))), null, null);
  assert.equal(deriveLH(lhPlanned(many)).payload.rows.find((r) => r.sku === "SKU-A").issues.length, 6, "capped at six");
});

test("10. summaries in object AND one-element-array forms; BUYABLE/DISCOVERABLE flags; live-offer detection", () => {
  const p = deriveLH(lhPlanned(FIXTURE())).payload;
  assert.deepEqual(p.rows.find((r) => r.sku === "SKU-A").summary, { buyable: true, discoverable: true, status: "BUYABLE,DISCOVERABLE" }, "one-element-array summary");
  assert.deepEqual(p.rows.find((r) => r.sku === "SKU-B").summary, { buyable: false, discoverable: true, status: "DISCOVERABLE" }, "object summary with statuses");
  assert.equal(p.rows.find((r) => r.sku === "SKU-A").hasLiveOffer, true, "an offer with amount > 0 is live");
  assert.equal(p.rows.find((r) => r.sku === "SKU-B").hasLiveOffer, null, "no offers => null (not false)");
});

test("11. blank SKU/ASIN listing rows are skipped but still counted in listingCount", () => {
  const p = deriveLH(lhPlanned(FIXTURE())).payload;
  assert.equal(p.listingCount, 4, "raw listing count includes the blank-sku/asin row");
  assert.equal(p.rows.length, 3, "the blank-sku/asin row is not emitted");
});

group("listing-health derive: Listings Raw state handling");

test("12. validated Raw success (incl. EMPTY rows) => issuesAvailable true, empty enrichment", () => {
  const empty = deriveLH(lhPlanned({ ...FIXTURE(), raw: [] })).payload;
  assert.equal(empty.issuesAvailable, true);
  assert.equal(empty.issuesUnavailableReason, null);
  assert.ok(empty.rows.every((r) => Array.isArray(r.issues) && r.issues.length === 0 && r.summary === null && r.hasLiveOffer === null), "no raw rows => empty issues, but issuesAvailable stays true");
});

test("13. approved DEGRADED/disabled Listings Raw => valid snapshot, issuesAvailable false + exact enable hint", () => {
  const r = deriveLH(lhPlanned({ ...FIXTURE(), rawState: "disabled" }));
  assert.equal(r.status, "derived", "a disabled optional enrichment still SAVES a valid snapshot");
  assert.equal(r.payload.issuesAvailable, false);
  assert.equal(r.payload.issuesUnavailableReason, ENABLE_HINT);
  assert.ok(r.payload.rows.every((row) => row.issues.length === 0 && row.summary === null && row.hasLiveOffer === null), "no issues invented when disabled");
  assert.equal(r.payload.rows.length, 3, "the rest of the report is unchanged");
});

test("14. Listings Raw states OTHER than explicit source-disabled => typed unavailable (LKG), never a silent empty", () => {
  for (const rawState of ["failed", "pending", "missing"]) {
    const r = deriveLH(lhPlanned({ ...FIXTURE(), rawState }));
    assert.equal(r.status, "unavailable", `${rawState} Listings Raw => unavailable (LKG preserved)`);
  }
  // A terminally-disabled optional source blocks (not degraded).
  assert.equal(deriveLH(lhPlanned({ ...FIXTURE(), rawState: "disabled-terminal" })).status, "blocked");
});

group("listing-health derive: window + account validation fail closed");

test("15. exact source windows (sales asOf-29d..asOf; inventory asOf-10d..asOf; no-date listings/raw/catalog)", () => {
  assert.equal(deriveLH(lhPlanned(FIXTURE())).status, "derived");
  assert.equal(SALES_FROM, addDaysStr(ASOF, -29));
  assert.equal(INV_FROM, addDaysStr(ASOF, -10));
});

test("16. wrong-window sales/inventory + dated no-date sources fail closed (invalid)", () => {
  const good = FIXTURE();
  const shift = (key) => { const b = lhPlanned(good); const i = b.planned.findIndex((p) => p.requestKey === key); b.planned[i] = { ...b.planned[i], from: addDaysStr(b.planned[i].from || ASOF, -1) }; return deriveLH(b).status; };
  assert.equal(shift("listing-health:sales"), "invalid", "shifted sales window => invalid");
  assert.equal(shift("listing-health:inventory"), "invalid", "shifted inventory window => invalid");
  for (const key of ["listing-health:listings", "listing-health:catalog", "listing-health:listings-raw"]) {
    const b = lhPlanned(good); const i = b.planned.findIndex((p) => p.requestKey === key);
    b.planned[i] = { ...b.planned[i], from: SALES_FROM, to: ASOF };
    assert.equal(deriveLH(b).status, "invalid", `dated ${key} => invalid`);
  }
});

test("17. inventory ROW dates must be real calendar dates inside [asOf-10d, asOf] (never silently filtered)", () => {
  const bad = (date) => deriveLH(lhPlanned({ ...FIXTURE(), inventory: [inv(date, "SKU-A", "ASIN-A", 5)] })).status;
  assert.equal(bad("2025-02-30"), "invalid", "impossible date");
  assert.equal(bad(addDaysStr(INV_FROM, -1)), "invalid", "before window");
  assert.equal(bad(addDaysStr(ASOF, 1)), "invalid", "after asOf");
  assert.equal(bad("2099-01-01"), "invalid", "future date");
});

test("18. cross-account fragments fail closed (invalid)", () => {
  for (const key of ["listing-health:listings", "listing-health:sales", "listing-health:inventory", "listing-health:catalog", "listing-health:listings-raw"]) {
    const b = lhPlanned(FIXTURE());
    const i = b.planned.findIndex((p) => p.requestKey === key);
    b.planned[i] = { ...b.planned[i], sellerOrVendorIds: ["OTHER"] };
    assert.equal(deriveLH(b).status, "invalid", `cross-account ${key} => invalid`);
  }
});

test("19. a missing/failed REQUIRED source => unavailable, ZERO writes, last-known-good preserved", () => {
  for (const key of ["listing-health:listings", "listing-health:sales", "listing-health:inventory", "listing-health:catalog"]) {
    const b = lhPlanned(FIXTURE());
    const hash = b.planned.find((p) => p.requestKey === key).requestHash;
    assert.equal(deriveLH(b, ctx(), { [hash]: "failed" }).status, "unavailable", `failed ${key} => unavailable`);
  }
});

group("listing-health derive: public-vs-raw identity + purity");

const RAW1 = "RAW1";
const PUB1 = dash("dd", "secondary") + ":RAW1";
const idCtx = (publicId, rawId) => ctx({ accountId: publicId, rawSellerId: rawId });

test("20. primary (public==raw==A1) => payload.accountId A1; dormant secondary => PUBLIC prefixed id, never raw", () => {
  assert.equal(deriveLH(lhPlanned({ ...FIXTURE(), ids: [ID] }), idCtx(ID, ID)).payload.accountId, "A1");
  const p = deriveLH(lhPlanned({ ...FIXTURE(), ids: [RAW1] }), idCtx(PUB1, RAW1)).payload;
  assert.equal(p.accountId, PUB1);
  assert.notEqual(p.accountId, RAW1);
  assert.deepEqual(p.rows, expectedFixturePayload().rows, "row calculations unchanged by the identity fix");
});

test("21. fragments still require the RAW seller id; a public-id-scoped fragment is cross-account", () => {
  assert.equal(deriveLH(lhPlanned({ ...FIXTURE(), ids: [RAW1] }), idCtx(PUB1, RAW1)).status, "derived");
  assert.equal(deriveLH(lhPlanned({ ...FIXTURE(), ids: [PUB1] }), idCtx(PUB1, RAW1)).status, "invalid");
});

test("22. derivation makes ZERO network calls; 23. repeated derivation is idempotent; latestDataDate = snapshot date", () => {
  const realFetch = globalThis.fetch; let hits = 0;
  globalThis.fetch = () => { hits += 1; throw new Error("network during derivation"); };
  let a, b;
  try { a = deriveLH(lhPlanned(FIXTURE())); b = deriveLH(lhPlanned(FIXTURE())); } finally { globalThis.fetch = realFetch; }
  assert.equal(hits, 0, "zero DataDoe/network calls during derivation");
  assert.deepEqual(a.payload, b.payload, "repeated derivation is idempotent");
  assert.deepEqual(a.payload, expectedFixturePayload());
  assert.equal(a.latestDataDate, "2025-08-09", "latestDataDate = the validated inventory snapshot date (source evidence)");
  // Inventory unavailable => latestDataDate null (never asOf).
  assert.equal(deriveLH(lhPlanned({ ...FIXTURE(), inventory: [] })).latestDataDate, null);
});

/* ============================= Part B: real generic planner/driver ============================= */

group("listing-health generic path: buildShadowReportPlan -> runStagedSourceCycle -> runReportJobs");

function makeStore() {
  const cycles = new Map(); const jobsByCycle = new Map(); const ownersByCycle = new Map();
  const cache = new Map(); const reportJobs = new Map(); const snapshots = new Map(); let seq = 0;
  const findCycle = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  const ownerRows = (cid) => [...((ownersByCycle.get(cid) && ownersByCycle.get(cid).values()) || [])];
  const rkey = (rk, a) => rk + "|" + a;
  return {
    _owners: (cid) => ownerRows(cid).map((m) => ({ ...m })),
    _snapshots: snapshots, saveCalls: 0,
    openCycle({ bucket, cycleDate }) { const k = bucket + "|" + cycleDate; if (!cycles.has(k)) { const id = "cyc_" + (seq += 1); cycles.set(k, { id, bucket, status: "pending" }); jobsByCycle.set(id, new Map()); } return cycles.get(k).id; },
    claimCycle(id) { const c = findCycle(id); if (c && c.status === "pending") { c.status = "running"; return true; } return false; },
    getCycle(id) { return findCycle(id); },
    upsertSourceJob(job) { const m = jobsByCycle.get(job.cycleId); if (m.has(job.requestHash)) return; m.set(job.requestHash, { request_hash: job.requestHash, request_key: job.requestKey, source_id: job.sourceId, source_key: job.sourceKey, connection_id: job.connectionId, organization_fingerprint: job.organizationFingerprint, account_scope_hash: job.accountScopeHash, fetch_status: "pending", attempted_at: null, create_export_count: 0, export_id: null, terminal: false, row_count: null }); },
    listSourceJobs(id) { return [...((jobsByCycle.get(id) && jobsByCycle.get(id).values()) || [])].map((j) => ({ ...j })); },
    upsertSourceJobOwners(ms) { for (const m of ms || []) { if (!ownersByCycle.has(m.cycleId)) ownersByCycle.set(m.cycleId, new Map()); ownersByCycle.get(m.cycleId).set(m.ownerId + "|" + m.requestHash, { cycle_id: m.cycleId, request_hash: m.requestHash, owner_id: m.ownerId, request_key: m.requestKey, report_key: m.reportKey, account_id: m.accountId, connection_id: m.connectionId, organization_fingerprint: m.organizationFingerprint, account_scope_hash: m.accountScopeHash, owner_status: "active", error_code: null }); } },
    listSourceJobOwners(cid, ids) { const s = new Set(ids || []); return ownerRows(cid).filter((m) => s.has(m.owner_id)).map((m) => ({ ...m })); },
    recordSourceOwnerStale({ cycleId, requestHash, ownerId, code }) { const m = ownersByCycle.get(cycleId) && ownersByCycle.get(cycleId).get(ownerId + "|" + requestHash); if (m) { m.owner_status = "stale"; m.error_code = code || "STALE_PLAN"; } },
    claimExportAttempt(id, h) { const j = jobsByCycle.get(id) && jobsByCycle.get(id).get(h); if (j && j.attempted_at === null) { j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted"; return true; } return false; },
    recordExportCreated({ cycleId, requestHash, exportId }) { jobsByCycle.get(cycleId).get(requestHash).export_id = exportId; },
    loadSourceRows(h) { const e = cache.get(h); return e ? { rows: e.rows } : null; },
    saveSourceRows({ job, rows }) { const h = job.request_hash != null ? job.request_hash : job.requestHash; cache.set(h, { rows: [...rows] }); return "p/" + h; },
    recordSourceSuccess({ cycleId, requestHash, exportId, rowCount, cacheObjectPath }) { Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "succeeded", export_id: exportId, row_count: rowCount, cache_object_path: cacheObjectPath }); },
    recordSourceFailure({ cycleId, requestHash, stage, code, terminal }) { Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "failed", error_stage: stage, error_code: code, terminal: !!terminal }); },
    updateCycleCounts() {},
    seedSnapshot(rk, a, payload) { snapshots.set(rkey(rk, a), { payload }); },
    report(rk, a) { return reportJobs.get(rkey(rk, a)); },
    listReportJobs() { return [...reportJobs.values()].map((j) => ({ ...j })); },
    upsertReportJob({ reportKey, accountId, connectionId, bucket, reportVersion, dependsOn }) { const k = rkey(reportKey, accountId); if (reportJobs.has(k)) return; reportJobs.set(k, { report_key: reportKey, account_id: accountId, connection_id: connectionId, bucket, report_version: reportVersion, depends_on: dependsOn || [], fetch_status: "pending", derive_status: "pending", save_status: "pending", validated: false }); },
    claimReportDerive(_c, rk, a) { const j = reportJobs.get(rkey(rk, a)); if (j && j.derive_status === "pending") { j.derive_status = "running"; return true; } return false; },
    recordReportBlocked({ reportKey, accountId }) { Object.assign(reportJobs.get(rkey(reportKey, accountId)), { fetch_status: "blocked", derive_status: "skipped", save_status: "skipped" }); },
    recordReportFailure({ reportKey, accountId, stage, code }) { Object.assign(reportJobs.get(rkey(reportKey, accountId)), { derive_status: stage === "save" ? "succeeded" : "failed", save_status: stage === "save" ? "failed" : "pending", error_code: code }); },
    recordReportSuccess({ reportKey, accountId, latestDataDate }) { Object.assign(reportJobs.get(rkey(reportKey, accountId)), { fetch_status: "ready", derive_status: "succeeded", save_status: "succeeded", validated: true, latest_data_date: latestDataDate ?? null }); },
  };
}

function makeDataDoe(opts = {}) {
  const create = {}; let hits = 0;
  const deadlineErr = () => Object.assign(new Error("deferred"), { code: "DATADOE_DEADLINE" });
  const rowsFor = (job) => {
    const rk = job.requestKey || ""; const fp = job.fetchParams || {};
    if (rk.includes("listings-raw")) return [rawRow("SKU-A", "ASIN-A", JSON.stringify([{ severity: "ERROR", code: 1, message: "x" }]), [{ status: ["BUYABLE"] }], [{ price: { amount: 9.99 } }])];
    if (rk.includes("listing-health:listings")) return [listing("SKU-A", "ASIN-A", { name: "Listing A", channel: "AMAZON_NA", price: 9.99, qty: 10, fbaAvail: 5 })];
    if (rk.includes("sales")) return [sale("SKU-A", "ASIN-A", "USD", 100, 10, 30)];
    if (rk.includes("inventory")) return [inv(fp.to || ASOF, "SKU-A", "ASIN-A", 5)];
    if (rk.includes("catalog")) return [cat("ASIN-A", "P1", "Catalog A", "Acme")];
    return [{ child_asin: "ASIN-A" }];
  };
  return {
    createCount: (h) => create[h] || 0, totalCreates: () => Object.values(create).reduce((a, b) => a + b, 0),
    async create(job) { create[job.requestHash] = (create[job.requestHash] || 0) + 1; return { exportId: "e_" + job.requestHash }; },
    async poll(job) { if (opts.deferKey && (job.requestKey || "").includes(opts.deferKey)) { hits += 1; if (hits === 1) throw deadlineErr(); } },
    async download(job) { if (opts.capKey && (job.requestKey || "").includes(opts.capKey)) return new Array(Number(job.limit)).fill(0).map(() => ({ x: 1 })); return rowsFor(job); },
  };
}

const ACCTS = [{ accountId: ID, country: "US", currency: "USD" }];
const asOfForUS = () => ASOF;
const shadowPlan = (accounts, keys, connections = CONNS) => buildShadowReportPlan({ accounts, reportKeys: keys, connections, asOfFor: asOfForUS });
const resolveFromPlan = (plan) => () => ({
  sourceJobs: plan.reportRequests.flatMap((req) => req.sources.map((s) => plannedSourceJob(req.reportKey, s, req.bucket, DRIVER_CONNECTION_ID[req.connectionId] || req.connectionId, req.accountId))),
});
const runGeneric = (store, dd, plan, opts = {}) => runStagedSourceCycle({ store, dataDoe: dd, resolvePlan: resolveFromPlan(plan), bucket: "us", cycleDate: "2026-08-11", ...opts });
const srcOf = (plan, key) => plan.reportRequests[0].sources.find((s) => s.requestKey === key);

test("24. default AND explicit planning include listing-health; exactly FIVE canonical jobs with exact windows/deps/owner/context", () => {
  assert.ok(SHADOW_PLANNED_REPORT_KEYS.includes("listing-health"));
  assert.ok(shadowPlan(ACCTS).reportRequests.some((r) => r.reportKey === "listing-health"), "DEFAULT plan includes listing-health");
  const plan = shadowPlan(ACCTS, ["listing-health"]);
  const lh = plan.reportRequests.find((r) => r.reportKey === "listing-health");
  assert.equal(plan.sourceJobs.length, 5, "exactly five deduplicated canonical source jobs");
  for (const key of ["listing-health:listings", "listing-health:listings-raw", "listing-health:catalog"]) {
    assert.deepEqual([srcOf(plan, key).from, srcOf(plan, key).to], [null, null], `${key} is no-date`);
  }
  assert.deepEqual([srcOf(plan, "listing-health:sales").from, srcOf(plan, "listing-health:sales").to], [SALES_FROM, ASOF]);
  assert.deepEqual([srcOf(plan, "listing-health:inventory").from, srcOf(plan, "listing-health:inventory").to], [INV_FROM, ASOF]);
  const rj = plan.reportJobs.find((j) => j.reportKey === "listing-health");
  assert.equal(rj.dependsOn.length, 5);
  assert.deepEqual([...rj.dependsOn].sort(), plan.sourceJobs.map((j) => j.requestHash).sort());
  assert.deepEqual(lh.context, { to: ASOF, rawSellerId: ID });
  // listings-raw is OPTIONAL; the four others are required.
  assert.equal(srcOf(plan, "listing-health:listings-raw").optional, true, "listings-raw is the optional source");
  assert.ok(["listing-health:listings", "listing-health:sales", "listing-health:inventory", "listing-health:catalog"].every((k) => srcOf(plan, k).optional === false), "the four non-raw sources are required");
});

test("25. inventory + catalog canonical hashes are SHARED with Sales Movers, Buy Box (+ Returns catalog)", () => {
  const lh = shadowPlan(ACCTS, ["listing-health"]);
  const bb = planBuyBoxLoss({ accountId: ID, country: "US", currency: "USD", connections: CONNS, asOf: ASOF });
  const sm = planSalesMovers({ accountId: ID, country: "US", currency: "USD", connections: CONNS, asOf: ASOF, probeSignal: { status: "success", validated: true, latestReportedDate: "2025-08-08" } });
  const ret = shadowPlan(ACCTS, ["returns-leakage"]).reportRequests[0];
  const lhInv = srcOf(lh, "listing-health:inventory").requestHash;
  const lhCat = srcOf(lh, "listing-health:catalog").requestHash;
  assert.equal(lhInv, bb.sources.find((s) => s.requestKey === "buy-box-loss:inventory").requestHash, "shared inventory identity with Buy Box");
  assert.equal(lhInv, sm.sources.find((s) => s.requestKey === "sales-movers:inventory").requestHash, "shared inventory identity with Sales Movers");
  assert.equal(lhCat, bb.sources.find((s) => s.requestKey === "buy-box-loss:catalog").requestHash, "shared catalog identity with Buy Box");
  assert.equal(lhCat, sm.sources.find((s) => s.requestKey === "sales-movers:catalog").requestHash, "shared catalog identity with Sales Movers");
  assert.equal(lhCat, ret.sources.find((s) => s.requestKey === "returns-leakage:catalog").requestHash, "shared catalog identity with Returns");
});

test("26. one canonical export per shared inventory/catalog hash across Listing Health + Buy Box owners", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const plan = shadowPlan(ACCTS, ["listing-health"]);
  const lhJobs = resolveFromPlan(plan)().sourceJobs;
  const extra = [];
  for (const [lhKey, bbKey] of [["listing-health:inventory", "buy-box-loss:inventory"], ["listing-health:catalog", "buy-box-loss:catalog"]]) {
    const src = lhJobs.find((j) => j.requestKey === lhKey);
    const ownerId = sourceJobOwnerId({ reportKey: "buy-box-loss", connectionId: src.connectionId, organizationFingerprint: src.organizationFingerprint, accountScopeHash: src.accountScopeHash });
    extra.push({ ...src, requestKey: bbKey, owner: { ownerId, requestKey: bbKey, reportKey: "buy-box-loss", accountId: ID } });
  }
  const plannedJobs = [...lhJobs, ...extra];
  const r = await runSourceJobs({ store, dataDoe: dd, plannedJobs, ownerIds: [...new Set(plannedJobs.map((j) => j.owner.ownerId))], bucket: "us", cycleDate: "2026-08-11" });
  for (const key of ["listing-health:inventory", "listing-health:catalog"]) {
    const h = srcOf(plan, key).requestHash;
    assert.equal(dd.createCount(h), 1, `${key} shared export created exactly once`);
    assert.equal(store.listSourceJobs(r.cycleId).filter((j) => j.request_hash === h).length, 1, "one canonical row");
    assert.equal(store._owners(r.cycleId).filter((m) => m.request_hash === h).length, 2, "two owner memberships share the one hash");
  }
});

test("27. owner reconciliation never stales another report's membership sharing inventory/catalog", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const plan = shadowPlan(ACCTS, ["listing-health"]);
  const r = await runGeneric(store, dd, plan);
  const cid = r.cycleId;
  for (const [lhKey, otherKey] of [["listing-health:inventory", "sales-movers:inventory"], ["listing-health:catalog", "sales-movers:catalog"]]) {
    const src = srcOf(plan, lhKey);
    const ownerId = sourceJobOwnerId({ reportKey: "sales-movers", connectionId: "primary", organizationFingerprint: src.organizationFingerprint, accountScopeHash: src.accountScopeHash });
    store.upsertSourceJobOwners([{ cycleId: cid, requestHash: src.requestHash, ownerId, requestKey: otherKey, reportKey: "sales-movers", accountId: ID, connectionId: "primary", organizationFingerprint: src.organizationFingerprint, accountScopeHash: src.accountScopeHash }]);
  }
  await runGeneric(store, dd, plan); // re-run to fixpoint: reconciliation touches only listing-health owners
  const smMemberships = store._owners(cid).filter((m) => m.report_key === "sales-movers");
  assert.equal(smMemberships.length, 2);
  assert.ok(smMemberships.every((m) => m.owner_status === "active"), "the second owner's shared memberships are never staled");
});

test("28. strict-cap: a listings export at the row cap fails TRUNCATED, saves no source, report never derives (LKG)", async () => {
  const store = makeStore();
  const dd = makeDataDoe({ capKey: "listing-health:listings" });
  const plan = shadowPlan(ACCTS, ["listing-health"]);
  const r = await runGeneric(store, dd, plan);
  const listJobs = store.listSourceJobs(r.cycleId).filter((j) => j.request_key === "listing-health:listings");
  assert.ok(listJobs.every((j) => j.fetch_status === "failed" && j.error_code === "TRUNCATED"), "capped listings fail TRUNCATED");
  assert.ok(!store.loadSourceRows(listJobs[0].request_hash), "no truncated source payload is saved");
  const saved = [];
  const saveSnapshot = async ({ accountId, payload }) => { saved.push({ accountId, payload }); return { paramsHash: "ph" }; };
  const res = await runReportJobs({ store, cycleId: r.cycleId, sourceRows: (h) => store.loadSourceRows(h), saveSnapshot, plannedReports: plan.reportRequests });
  assert.equal(res.succeeded, 0);
  assert.equal(saved.length, 0, "zero snapshot writes (LKG preserved)");
});

test("29. report stays PENDING until the four required sources succeed, then saves EXACTLY once; zero network in derive; idempotent", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const plan = shadowPlan(ACCTS, ["listing-health"]);
  const saved = [];
  const saveSnapshot = async ({ reportKey, accountId, payload }) => { store.saveCalls += 1; store.seedSnapshot(reportKey, accountId, payload); saved.push({ accountId, payload }); return { paramsHash: "ph" }; };
  const r1 = await runGeneric(store, dd, plan, { maxJobs: 2 });
  assert.ok(store.listSourceJobs(r1.cycleId).filter((j) => j.fetch_status === "succeeded").length < 5, "not all sources succeeded yet");
  let res = await runReportJobs({ store, cycleId: r1.cycleId, sourceRows: (h) => store.loadSourceRows(h), saveSnapshot, plannedReports: plan.reportRequests });
  assert.equal(res.succeeded, 0, "report PENDING while a required source is missing");
  assert.equal(saved.length, 0);
  const r2 = await runGeneric(store, dd, plan);
  assert.ok(store.listSourceJobs(r2.cycleId).every((j) => j.fetch_status === "succeeded"), "all five sources succeeded after resume");
  const realFetch = globalThis.fetch; let hits = 0;
  globalThis.fetch = () => { hits += 1; throw new Error("network during derivation"); };
  try { res = await runReportJobs({ store, cycleId: r2.cycleId, sourceRows: (h) => store.loadSourceRows(h), saveSnapshot, plannedReports: plan.reportRequests }); } finally { globalThis.fetch = realFetch; }
  assert.equal(hits, 0, "zero DataDoe/network during derivation");
  assert.equal(res.succeeded, 1);
  assert.equal(saved.length, 1, "snapshot saved exactly once");
  assert.equal(saved[0].payload.issuesAvailable, true, "listings-raw succeeded => issuesAvailable true");
  assert.equal(saved[0].payload.accountId, ID);
  const before = store.saveCalls;
  await runReportJobs({ store, cycleId: r2.cycleId, sourceRows: (h) => store.loadSourceRows(h), saveSnapshot, plannedReports: plan.reportRequests });
  assert.equal(store.saveCalls, before, "no duplicate snapshot on re-run");
});

test("30. worker-level DISABLED Listings Raw => a valid unavailable-enrichment snapshot is saved (issuesAvailable false)", async () => {
  const store = makeStore();
  const cid = store.openCycle({ bucket: "us", cycleDate: "2026-08-11" });
  const plan = shadowPlan(ACCTS, ["listing-health"]);
  const rawSrc = srcOf(plan, "listing-health:listings-raw");
  assert.ok(rawSrc.disabledPolicy && rawSrc.disabledPolicy.disabledSource === "degraded", "the planned listings-raw source carries the degraded availabilityPolicy");
  const dd = makeDataDoe();
  // Succeed the four required sources; mark listings-raw FAILED (a genuine source-disabled outcome).
  const jobs = resolveFromPlan(plan)().sourceJobs;
  for (const j of jobs) {
    store.upsertSourceJob({ cycleId: cid, requestHash: j.requestHash, requestKey: j.requestKey, sourceId: j.sourceId, sourceKey: j.sourceKey, connectionId: j.connectionId, organizationFingerprint: j.organizationFingerprint, accountScopeHash: j.accountScopeHash });
    if (j.requestKey === "listing-health:listings-raw") {
      store.recordSourceFailure({ cycleId: cid, requestHash: j.requestHash, stage: "create", code: "SOURCE_DISABLED", terminal: true });
    } else {
      store.saveSourceRows({ job: { request_hash: j.requestHash }, rows: (await dd.download({ ...j, fetchParams: j.fetchParams })) });
      store.recordSourceSuccess({ cycleId: cid, requestHash: j.requestHash, exportId: "e", rowCount: 1, cacheObjectPath: "p/" + j.requestHash });
    }
  }
  const saved = [];
  const saveSnapshot = async ({ accountId, payload }) => { saved.push({ accountId, payload }); return { paramsHash: "ph" }; };
  const res = await runReportJobs({ store, cycleId: cid, sourceRows: (h) => store.loadSourceRows(h), saveSnapshot, plannedReports: plan.reportRequests });
  assert.equal(res.succeeded, 1, "the report saves even though the optional enrichment is disabled");
  assert.equal(saved[0].payload.issuesAvailable, false, "issuesAvailable false");
  assert.equal(saved[0].payload.issuesUnavailableReason, ENABLE_HINT, "exact enable hint");
});

test("31. maxJobs partial + poll-deferral resume through the real driver with ONE create-export per hash", async () => {
  const s1 = makeStore(); const d1 = makeDataDoe();
  const plan = shadowPlan(ACCTS, ["listing-health"]);
  await runGeneric(s1, d1, plan, { maxJobs: 2 });
  const r = await runGeneric(s1, d1, plan);
  assert.ok(s1.listSourceJobs(r.cycleId).every((j) => j.fetch_status === "succeeded"), "all sources complete after maxJobs resume");
  for (const j of s1.listSourceJobs(r.cycleId)) assert.ok(d1.createCount(j.request_hash) <= 1, j.request_key + " exported at most once");
  const s2 = makeStore();
  const dDefer = makeDataDoe({ deferKey: "listing-health:inventory" });
  const r1 = await runGeneric(s2, dDefer, plan);
  assert.ok((r1.deferred || 0) > 0, "the driver surfaces the resumable deferral");
  assert.ok(s2._owners(r1.cycleId).every((m) => m.owner_status === "active"), "no membership staled by a deferral");
  const invHash = srcOf(plan, "listing-health:inventory").requestHash;
  const dOk = makeDataDoe();
  const r2 = await runGeneric(s2, dOk, plan);
  assert.equal(dDefer.createCount(invHash) + dOk.createCount(invHash), 1, "inventory export created exactly once across deferral + resume");
  assert.ok(s2.listSourceJobs(r2.cycleId).every((j) => j.fetch_status === "succeeded"));
});

test("32. primary-only: a stale dd-secondary account is skipped read-only with ZERO DataDoe calls and never routed through the primary key", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const PRIMARY_ONLY = [{ id: "primary", apiKey: dash("prim", "key"), accountPrefix: "" }];
  const accounts = [{ accountId: ID, country: "US", currency: "USD" }, { accountId: PUB1, country: "US", currency: "USD" }];
  const plan = shadowPlan(accounts, ["listing-health"], PRIMARY_ONLY);
  assert.deepEqual(plan.unavailableAccounts.map((a) => a.accountId), [PUB1]);
  assert.deepEqual(plan.reportRequests.map((r) => r.accountId), [ID]);
  const r = await runGeneric(store, dd, plan);
  const jobs = store.listSourceJobs(r.cycleId);
  assert.ok(jobs.every((j) => j.connection_id === "primary"), "no dd-secondary jobs; nothing routed to primary for the stale account");
  assert.equal(jobs.length, 5, "exactly the five primary-account canonical jobs ran");
});

async function main() {
  ({ assembleSources, runReportJobs } = await import("../lib/server/sync/report-worker.js"));
  ({ deriveReportSnapshot } = await import("../lib/server/sync/report-derivation.js"));
  ({ runSourceJobs } = await import("../lib/server/sync/source-worker.js"));
  ({ plannedSourceJob, runStagedSourceCycle } = await import("../lib/server/sync/source-sync-driver.js"));
  ({ sourceJobOwnerId } = await import("../lib/server/source-identity.js"));
  ({ planListingHealth, planBuyBoxLoss, planSalesMovers, planReturnsLeakage, buildShadowReportPlan, SHADOW_PLANNED_REPORT_KEYS } = await import("../lib/server/sync/report-planner.js"));
  ({ addDaysStr } = await import("../lib/server/date-windows.js"));
  SALES_FROM = addDaysStr(ASOF, -29);
  INV_FROM = addDaysStr(ASOF, -10);

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
