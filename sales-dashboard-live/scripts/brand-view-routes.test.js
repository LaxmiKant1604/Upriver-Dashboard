// Publication recovery WP8 -- the zero-export `brand-view-brands` + `brand-view` recovery routes, the extracted Brand
// View dependency-reader factory (brand-view-dependency-readers.js) and the memoised hydrated reader.
//
// Proves, fully offline (ZERO DataDoe / Supabase / network -- the global fetch is a refusing stub and its call count is
// asserted 0) over ONE faithful in-memory world: report_snapshots rows (upstream sources + the release's shadows + live
// rows, PostgREST timestamp text), storage objects, Ads state / coverage, campaign mappings, the catalog pointer, a
// sync_cycles / sync_report_jobs lineage store and the fenced live CAS; driven by the REAL four-gate publisher
// (publisher-composition.js with build-time overrides), the REAL shared live read-back, the REAL serve selectors, the
// REAL generic route release + adapter and the REAL saved-data reconciler two-phase core. The routes' metadata-only
// evidence SQL is executed by a Postgres-semantics EMULATOR keyed by the exact SQL text (rank ties, to_char instants,
// jsonb extraction), and its column names are verified against the supabase/migrations DDL:
//   A. module contracts: both routes validate worker + CLI + pair against the REAL SCHEDULER_LIVE_SNAPSHOT_CONTRACTS /
//      REPORT_DERIVATIONS; the plan's awaits / priority / timeouts / heap; read-only SQL; DDL column check; topo order.
//   B. composition refactor: the legacy dependency fingerprint + the reader call set are BYTE-IDENTICAL to the
//      pre-refactor composition over the pinned fixture worlds; makeMemoHydratedReader + canonicalInstant semantics.
//   C. writer / serve fingerprint parity: the route's params.depFingerprint == the fingerprint the REAL api/datadoe.js
//      brandViewDepFingerprintReaders (source-extracted, fakes injected) computes over the same fake supabase, and the
//      REAL serveSharedReport serves the published row NOT 'updating'.
//   D. brand-view-brands: publish end to end; an empty list only when all three reads are ok; a read failure / an
//      advanced row defers with zero writes; an upstream fba-plan change changes the token and re-publishes; worker
//      compose token == the CLI TARGETS v2 tok.
//   E. brand-view: every brand unit published (served exact), brand-sales hydrated ONCE per account across N brands,
//      one brand's build failure isolated, an Ads contentRev-only change and a mapping edit re-publish, a local-midnight
//      roll before the first write defers 'asof-rolled' then publishes the new identity, strict reads defer.
//   F. the WP8 verifier fixes: a tied latest row never shares a token with an absent one and the worker compose returns
//      token null + the CLI's typed reason (returns-v3 contract); an out-of-line directory source is HYDRATED
//      storage-first (WP10: the serve + the route read it together) and defers typed 'storage-missing' / 'hydrate-failed'
//      (LKG kept) when its object is absent / unreadable, while a genuinely empty inline payload publishes; an unsold
//      directory brand is typed 'brand-not-sold'
//      while a real build failure stays 'brand-view-build-failed'; worker hooks accept target string | { targetKey |
//      accountId } and now fn | Date | ms; paramsHashFor is a pure leaf outside the worker's report-store graph.
//   Round 3: E11 / F7 (P2b) the durable Ads ROWS are identity-checked (the former documented residual is CLOSED): the
//      evidence binds the SHARED exact 'adr1:' digest (the SQL emulated by INTERPRETING the SQL text), a non-monotonic
//      Ads UPDATE is STALE then republished, a mid-derive edit defers 'evidence-advanced:ads-rows'; F8 (P3-2) a static
//      proof that no code path uploads / overwrites a report-snapshot storage object + the invariant documented at both
//      hydration sites; F9 (P3-1) the derivation-code identity moves bv1 (-> bvm1) and bb1.
// 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

process.env.SUPABASE_URL = "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = ["test", "svc", "role", "key"].join("-");

// The network is NEVER reached: every fetch is recorded and refused.
const net = { calls: [] };
globalThis.fetch = async (url, opts = {}) => { net.calls.push(String(opts.method || "GET") + " " + String(url)); throw new Error("network refused in an offline test"); };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(path.join(ROOT, p), "utf8");

const REL = await import("../lib/server/sync/route-publication-release.js");
const { buildSchedulerV2Publisher } = await import("../lib/server/sync/publisher-composition.js");
const { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } = await import("../lib/server/sync/report-publisher.js");
const { REPORT_DERIVATIONS } = await import("../lib/server/sync/report-derivation.js");
const { paramsHashFor, serveSharedReport } = await import("../lib/server/report-store.js");
const B = await import("../lib/server/sync/publication-binding.js");
const SDR = await import("../lib/server/sync/saved-data-reconciler.js");
const RC = await import("../lib/server/recovery/route-contract.js");
const SEL = await import("../lib/server/recovery/serve-selectors.js");
const TGT = await import("../lib/server/sync/reconcile-targets-output.js");
const SB = await import("../lib/server/supabase.js");
const BV = await import("../lib/server/reports/brand-view.js");
const FPM = await import("../lib/server/reports/brand-view-dependency-fingerprint.js");
const { campaignMappingRevision } = await import("../lib/server/reports/campaign-ads-aggregation.js");
const { ACTIVE_ADS_SOURCE_KEY } = await import("../lib/server/active-ads-source.js");
const { marketplaceToday } = await import("../lib/marketplaces.js");
const { normalizeMarketplace } = await import("../lib/server/sync/oli-sales-estimate.js");
const COMP = await import("../lib/server/sync/report-materialization-brandview-composition.js");
const RD = await import("../lib/server/sync/brand-view-dependency-readers.js");
const BVB_W = await import("../lib/server/recovery/routes/brand-view-brands.route.js");
const BVB_C = await import("../lib/server/sync/routes/brand-view-brands.release.js");
const BV_W = await import("../lib/server/recovery/routes/brand-view.route.js");
const ADE = await import("../lib/server/recovery/routes/ads-daily-evidence.js");
const ROUTES = await import("../lib/server/recovery/routes.js");
const BV_C = await import("../lib/server/sync/routes/brand-view.release.js");

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; out("  ok  " + name); };
const S = (v) => (v == null ? "" : String(v));
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const L = SCHEDULER_LIVE_SNAPSHOT_CONTRACTS;
const D = REPORT_DERIVATIONS;
const RS = { NR: "PUBLICATION_NOT_REQUIRED", RV: "READBACK_VERIFIED", DD: "DEFERRED_DEPENDENCY", DP: "DEFERRED_PROVENANCE", ST: "STALE" };
const ORG = "org-fp-test";
const EPOCH = "2026-09-23";
const REGION = "india";
const BVB = "brand-view-brands";
const BVK = "brand-view";
out("brand-view-routes (WP8)");

// =====================================================================================================================
// A. module contracts
// =====================================================================================================================
const bvbWorker = RC.validateRouteModule(BVB_W, { side: "worker" });
const bvbCli = RC.validateRouteModule(BVB_C, { side: "cli", liveContracts: L, reportDerivations: D });
const bvWorker = RC.validateRouteModule(BV_W, { side: "worker" });
const bvCli = RC.validateRouteModule(BV_C, { side: "cli", liveContracts: L, reportDerivations: D });
ok("A1 both routes validate worker + CLI side against the REAL live contracts + report derivations, and each pair agrees", RC.validateRoutePair(bvbWorker, bvbCli, { liveContracts: L }) === true && RC.validateRoutePair(bvWorker, bvCli, { liveContracts: L }) === true);
ok("A2 brand-view-brands: awaits [oli, fba-plan], priority 5, deadline 330 / hard 420, unit none, stampPolicy 'cycle', publisher + live key brand-view-brands",
  JSON.stringify(bvbWorker.awaits) === JSON.stringify(["oli", "fba-plan"]) && bvbWorker.priority === 5 && bvbWorker.deadlineSeconds === 330 && bvbWorker.hardTimeoutSeconds === 420 && bvbWorker.unit === "none" && bvbWorker.grain === "account"
  && bvbCli.stampPolicy === "cycle" && bvbCli.publisherKey === BVB && bvbWorker.identityAsOf === null && bvbWorker.kind === "route-cli" && bvbWorker.cli.script === RC.ROUTE_CLI_SCRIPT);
ok("A2 brand-view: unit 'brand', awaits [oli, fba, fba-plan, returns-v3, brand-view-brands], priority 7, deadline 720 / hard 840, childHeapMb 448, stampPolicy 'cycle'",
  bvWorker.unit === "brand" && bvWorker.grain === "account" && JSON.stringify(bvWorker.awaits) === JSON.stringify(["oli", "fba", "fba-plan", "returns-v3", "brand-view-brands"])
  && bvWorker.priority === 7 && bvWorker.deadlineSeconds === 720 && bvWorker.hardTimeoutSeconds === 840 && bvWorker.childHeapMb === 448 && bvCli.stampPolicy === "cycle" && bvCli.publisherKey === BVK && typeof bvWorker.identityAsOf === "function");
ok("A3 every evidence SQL is a single read-only SELECT/WITH (route-contract), and the awaits order runs brand-view-brands BEFORE brand-view",
  [...bvbWorker.evidence.sql, ...bvWorker.evidence.sql].every((q) => RC.isReadOnlyEvidenceSql(q.text)) && JSON.stringify(RC.routeTopoOrder([bvWorker, bvbWorker])) === JSON.stringify([BVB, BVK]));
ok("A3 the brand-view evidence covers EVERY report the builder reads (brand-sales, brand-inventory + the ASIN->brand map inputs) and brand-view-brands covers the directory's three sources",
  JSON.stringify([...BV_W.BRAND_VIEW_EVIDENCE_REPORT_KEYS].sort()) === JSON.stringify([...new Set(["brand-sales", BV.BRAND_INVENTORY_SNAPSHOT_KEY, ...BV.ASIN_BRAND_SNAPSHOT_KEYS])].sort())
  && JSON.stringify(BVB_W.BRAND_VIEW_BRANDS_EVIDENCE_REPORT_KEYS) === JSON.stringify(BV.BRAND_SOURCE_SNAPSHOT_KEYS));
{
  // A4: every alias.column the evidence SQL names exists in the supabase/migrations DDL of its table.
  const MIG = readdirSync(path.join(ROOT, "supabase", "migrations")).filter((f) => f.endsWith(".sql")).map((f) => src("supabase/migrations/" + f)).join("\n");
  const TYPES = "(text|uuid|jsonb|bigint|integer|int|date|timestamptz|boolean|smallint|numeric)";
  const columnsOf = (table) => {
    const cols = new Set();
    for (const m of MIG.matchAll(new RegExp("create table (?:if not exists )?public\\." + table + " \\(([\\s\\S]*?)\\n\\);", "g"))) {
      for (const line of m[1].split("\n")) { const mm = line.trim().match(new RegExp("^([a-z_][a-z0-9_]*)\\s+" + TYPES + "\\b")); if (mm) cols.add(mm[1]); }
    }
    for (const m of MIG.matchAll(new RegExp("alter table (?:if exists )?public\\." + table + "\\s+add column (?:if not exists )?([a-z_][a-z0-9_]*)", "g"))) cols.add(m[1]);
    return cols;
  };
  const problems = [];
  let refs = 0;
  for (const q of [...bvbWorker.evidence.sql, ...bvWorker.evidence.sql]) {
    const alias = new Map();
    for (const m of q.text.matchAll(/(?:from|join) public\.([a-z_]+) ([a-z]+)\b/g)) alias.set(m[2], m[1]);
    for (const m of q.text.matchAll(/\b([a-z]{1,3})\.([a-z_][a-z0-9_]*)\b/g)) {
      if (!alias.has(m[1])) continue;
      refs += 1;
      if (!columnsOf(alias.get(m[1])).has(m[2])) problems.push(q.name + ":" + alias.get(m[1]) + "." + m[2]);
    }
  }
  ok(`A4 every table.column the evidence SQL references (${refs} refs over report_snapshots / ads_sync_state / ads_sync_coverage / campaign_brand_mapping / source_snapshots) exists in the migrations DDL`, refs > 30 && problems.length === 0);
}

// =====================================================================================================================
// B. the composition refactor (pure) + the memo reader + canonical instants
// =====================================================================================================================
// ---- FIXTURE (identical to the pre-refactor golden capture) ----
const FX_INV_V = "brand-inventory-shared-v1";
function fixtureWorld(variant) {
  const t = (d, h) => `2026-09-${d}T${h}:00:00.000Z`;
  const w = {
    meta: {
      "brand-sales|a1": { params_hash: "bs-a1", source_refreshed_at: t(20, "03"), updated_at: t(20, "04") },
      "fba-plan|a1": { params_hash: "fp-a1", source_refreshed_at: t(20, "05"), updated_at: t(20, "05") },
      "listing-health|a1": { params_hash: "lh-a1", source_refreshed_at: null, updated_at: t(19, "07") },
      "brand-sales|a2": { params_hash: "bs-a2", source_refreshed_at: t(21, "03"), updated_at: t(21, "03") },
      "brand-inventory|a2": { params_hash: "bi-a2-latest", source_refreshed_at: t(21, "09"), updated_at: t(21, "09") },
    },
    ads: {
      a1: { windows: [{ from: "2026-07-01", to: "2026-09-19" }, { from: "2026-06-01", to: "2026-06-30" }], status: "succeeded", latestMetricDate: "2026-09-19", contentRev: "adsrev-a1", read: "ok", error: null },
      a2: { windows: [], status: "missing", latestMetricDate: null, contentRev: null, read: "ok", error: null },
    },
    mappings: {
      a1: [
        { marketplace: "IN", ads_profile_id: "", ad_campaign_id: "c-1", canonical_brand_key: "acme", brand_display_name: "Acme", mapping_source: "MANUAL", updated_at: t(18, "10") },
        { marketplace: "IN", ads_profile_id: "p9", ad_campaign_id: "c-2", canonical_brand_key: "zeta", brand_display_name: "Zeta", mapping_source: "BULK", updated_at: t(18, "11") },
      ],
    },
    catalog: { snapshot: { validated_at: t(19, "00"), payload_sha: "cat-sha-1", object_path: "catalog/obj" } },
    inventory: {
      a1: [
        { id: "inv-a1-avail", params_hash: "bi-a1-avail", params: { reportVersion: FX_INV_V, to: "2026-09-18" }, payload: { inventoryAvailable: true, inventoryDate: "2026-09-18", inventoryByBrandCountry: [] }, source_refreshed_at: t(18, "12"), updated_at: t(18, "12") },
        { id: "inv-a1-ph", params_hash: "bi-a1-ph", params: { reportVersion: FX_INV_V, to: "2026-09-20" }, payload: { inventoryAvailable: false, inventoryByBrandCountry: [] }, source_refreshed_at: t(20, "12"), updated_at: t(20, "12") },
      ],
      a2: [],
    },
    org: "org-fp-1",
  };
  if (variant === "catalog-sha-only") w.catalog = { snapshot: { payload_sha: "cat-sha-2" } };
  if (variant === "catalog-direct") w.catalog = { validated_at: t(17, "00"), payload_sha: "cat-sha-3" };
  if (variant === "no-org") w.org = null;
  if (variant === "empty") { w.meta = {}; w.ads = {}; w.mappings = {}; w.catalog = null; w.inventory = {}; }
  w.throws = variant === "throwing";
  return w;
}
function compositionOverrides(w, calls = []) {
  const boom = (what) => { calls.push("throw:" + what); throw new Error("read failed: " + what); };
  return {
    getConnections: () => (w.org ? [{ id: "primary", apiKey: "k-primary", organizationFingerprint: w.org }] : [{ id: "secondary", apiKey: "k2" }]),
    getSnapshotMeta: async ({ reportKey, accountId }) => { calls.push("meta:" + reportKey + ":" + accountId); if (w.throws && reportKey === "listing-health") boom("meta"); return w.meta[reportKey + "|" + accountId] || null; },
    getAdsCoverageState: async (accountId, sourceKey) => { calls.push("ads:" + accountId + ":" + sourceKey); if (w.throws) boom("ads"); return w.ads[accountId] || { windows: [], status: "missing", latestMetricDate: null, contentRev: null, read: "ok", error: null }; },
    getMappings: async ({ organizationFingerprint, connectionId, accountId }) => { calls.push("map:" + organizationFingerprint + ":" + connectionId + ":" + accountId); if (w.throws) boom("map"); return w.mappings[accountId] || []; },
    getSourceSnap: async ({ organizationFingerprint, connectionId, sourceKey, scopeKey }) => { calls.push("cat:" + organizationFingerprint + ":" + connectionId + ":" + sourceKey + ":" + scopeKey); if (w.throws) boom("cat"); return w.catalog; },
    getInventoryCandidates: async ({ reportKey, accountId, reportVersion }) => { calls.push("inv:" + reportKey + ":" + accountId + ":" + reportVersion); if (w.throws) boom("inv"); return w.inventory[accountId] || []; },
    getProvenance: async () => "2026-09-20T03:00:00.000Z",
    getAdsRows: async () => [],
    buildSingle: async () => ({ ok: true }),
    buildPortfolio: async () => ({ ok: true }),
  };
}
const FX_VARIANTS = ["full", "catalog-sha-only", "catalog-direct", "no-org", "empty", "throwing"];
// ---- END FIXTURE ----
// Captured from the PRE-refactor composition (HEAD 6a59a1f): [single a1 Acme, single a2 Zeta, portfolio {a2,a1} Acme]
// dependency fingerprints + a digest of the sorted reader-call list, per fixture variant.
const GOLDEN = {
  full: ["eb642b7f5281ba5a56f8d33037a33969de97d31e", "11e4eb771700b72b1a68e1237775c160b4f49653", "735c480ab092cd1d2069a0a17a1e56c7d18e4ec4", "d035ec7205dede9c"],
  "catalog-sha-only": ["d26c6fa24cc25cd2ca6ae96940ef7c656f47d60e", "99dba2cebf21638792018bce0045e4d3ab9cc81f", "1d9f95e38dd6158361ae3e9c6d5243184e66f311", "d035ec7205dede9c"],
  "catalog-direct": ["a58fa307d40cfb6dea12e1de8d3983f9c30ea95f", "6f17d0d7c3d1263774167082dd9e2b9cb59cfd2f", "3e801b94f7c74c73d697682cc3af26118275210a", "d035ec7205dede9c"],
  "no-org": ["56cf1b5d5c712a3b3b5781d3fe84cd9afb3d4ea7", "903ed17f3c0b6a6af344d15ab3f6c69142c82205", "3bcc054ca48a5faa43ad5722cb561389333dc1b9", "6673d1674357d83c"],
  empty: ["4c369db27ddc60f7ddc4ece761e710a4cea408df", "1ca895c5690184c8959e87276caebf66280d9732", "cad4180cf85cfce7b15c7c218d36d40885a38166", "d035ec7205dede9c"],
  throwing: ["f08ccfbceade1162629b9f9e3ec5e7ed61566596", "9eb3400bc507b16a04a9cccde6c77d27c3e5734a", "c06f34e2688dee0ea0420dd84361aa2efacaee42", "a4257ad863c8b825"],
};
{
  const got = {};
  const direct = {};
  for (const v of FX_VARIANTS) {
    const w = fixtureWorld(v);
    const calls = [];
    const rel = COMP.buildBrandViewMaterializationRelease(compositionOverrides(w, calls));
    const s1 = await rel.deriveBrandView({ accountId: "a1", brand: "Acme", asOf: "2026-09-21", account: { country: "IN" } });
    const s2 = await rel.deriveBrandView({ accountId: "a2", brand: "Zeta", asOf: "2026-09-21", account: { country: "IN" } });
    const p = await rel.deriveBrandViewPortfolio({ accountIds: ["a2", "a1"], brand: "Acme", asOf: "2026-09-21", region: "india", accountsById: {} });
    got[v] = [s1.depFingerprint, s2.depFingerprint, p.depFingerprint, createHash("sha256").update(calls.slice().sort().join("|")).digest("hex").slice(0, 16)];
    // The extracted factory used DIRECTLY (as the brand-view route does) over the same readers.
    const o = compositionOverrides(w, []);
    const orgFp = w.org;
    const readers = makeReadersFromOverrides(o);
    direct[v] = await FPM.collectBrandViewDependencyFingerprint({ scope: "account", brand: "Acme", accountIds: ["a1"], reportVersion: BV.BRAND_VIEW_VERSION, readers: RD.makeBrandViewDepReaders({ orgFp, readers }) });
  }
  ok("B1 composition refactor: the legacy dependency fingerprint (single + portfolio) is BYTE-IDENTICAL to the pre-refactor composition over all 6 fixture worlds", FX_VARIANTS.every((v) => JSON.stringify(got[v].slice(0, 3)) === JSON.stringify(GOLDEN[v].slice(0, 3))));
  ok("B1 ... and the composition issues EXACTLY the pre-refactor reader call set (same readers, same args, incl. the no-org + throwing worlds)", FX_VARIANTS.every((v) => got[v][3] === GOLDEN[v][3]));
  ok("B2 makeBrandViewDepReaders used directly (the route's path) yields the composition's fingerprint over the same readers", FX_VARIANTS.every((v) => direct[v] === GOLDEN[v][0]));
  const cs = src("lib/server/sync/report-materialization-brandview-composition.js");
  ok("B2 the composition no longer carries its own depReaders literal: it imports the extracted factory (one implementation) and exports makeBrandViewDerivers", /makeBrandViewDepReaders\(/.test(cs) && !/getMappingRev:/.test(cs) && typeof COMP.makeBrandViewDerivers === "function");
}
function makeReadersFromOverrides(o) {
  return { getSnapshotMeta: o.getSnapshotMeta, getAdsCoverageState: o.getAdsCoverageState, getMappings: o.getMappings, getSourceSnap: o.getSourceSnap, getInventoryCandidates: o.getInventoryCandidates };
}
{
  // B3: the memo reader.
  const calls = [];
  let fail = false;
  const read = RD.makeMemoHydratedReader(async ({ reportKey, accountId }) => { calls.push(reportKey + ":" + accountId); if (fail) throw new Error("boom"); return { id: reportKey + "@" + accountId, payload: { big: true } }; });
  const [x1, x2] = await Promise.all([read({ reportKey: "brand-sales", accountId: "A" }), read({ reportKey: "brand-sales", accountId: "A" })]);
  const x3 = await read({ reportKey: "brand-sales", accountId: "A" });
  ok("B3 memo: concurrent + repeated reads of one (report, account) share ONE underlying hydration (the SAME row object)", calls.length === 1 && x1 === x2 && x2 === x3 && read.stats.reads === 1 && read.stats.hits === 2);
  await read({ reportKey: "fba-plan", accountId: "A" });
  await read({ reportKey: "brand-sales", accountId: "B" });
  ok("B3 memo: a read for ANOTHER account clears the cache (at most one account's payloads are held)", read.size() === 1 && read.stats.clears === 1 && calls.length === 3);
  await read({ reportKey: "brand-sales", accountId: "A" });
  ok("B3 memo: ... so returning to the first account re-reads (no cross-account reuse)", calls.length === 4);
  read.invalidate({ reportKey: "brand-sales", accountId: "A" });
  await read({ reportKey: "brand-sales", accountId: "A" });
  ok("B3 memo: invalidate() evicts one key (the next read re-hydrates)", calls.length === 5);
  fail = true;
  let threw = 0;
  try { await read({ reportKey: "sku-pl", accountId: "A" }); } catch { threw += 1; }
  fail = false;
  await read({ reportKey: "sku-pl", accountId: "A" });
  ok("B3 memo: a REJECTED read is evicted, never cached (the retry re-reads)", threw === 1 && calls.filter((c) => c === "sku-pl:A").length === 2);
  let refused = false;
  try { RD.makeMemoHydratedReader(null); } catch { refused = true; }
  ok("B3 memo: construction without a reader fails closed", refused);
}
{
  // B4: canonical instants.
  const ci = RD.canonicalInstant;
  ok("B4 canonicalInstant: PostgREST text (trimmed fraction, +00:00), SQL to_char text and ISO Z map to ONE microsecond UTC form",
    ci("2026-09-24T00:16:00.1234+00:00") === "2026-09-24T00:16:00.123400Z" && ci("2026-09-24T00:16:00.123400Z") === "2026-09-24T00:16:00.123400Z"
    && ci("2026-09-24T00:16:00+00:00") === "2026-09-24T00:16:00.000000Z" && ci("2026-09-24 00:16:00.5+00") === "2026-09-24T00:16:00.500000Z");
  ok("B4 canonicalInstant: an offset is applied (never a local-time parse); an impossible date / garbage / null is null",
    ci("2026-09-24T05:46:00.25+05:30") === "2026-09-24T00:16:00.250000Z" && ci("2026-09-23T20:16:00-04:00") === "2026-09-24T00:16:00.000000Z"
    && ci("2026-02-30T00:00:00Z") === null && ci("yesterday") === null && ci(null) === null && ci("2026-09-24") === null);
  const a = RD.snapshotRowIdentity({ id: "r1", params_hash: "h", source_refreshed_at: "2026-09-24T00:16:00.1+00:00", updated_at: "2026-09-24T00:16:01+00:00", params: { reportVersion: "v1" } });
  const b = RD.snapshotRowIdentity({ id: "r1", params_hash: "h", source_refreshed_at: "2026-09-24T00:16:00.100000Z", updated_at: "2026-09-24T00:16:01.000000Z", report_version: "v1" });
  ok("B4 a REST row and its evidence-SQL row have the SAME identity; any id / hash / instant / version change differs; absent == absent only",
    RD.sameSnapshotIdentity(a, b) && !RD.sameSnapshotIdentity(a, { ...b, upd: "2026-09-24T00:16:01.000001Z" }) && !RD.sameSnapshotIdentity(a, { ...b, v: "v2" }) && !RD.sameSnapshotIdentity(a, { ...b, id: "r2" })
    && RD.sameSnapshotIdentity(null, null) && !RD.sameSnapshotIdentity(a, null));
}

// =====================================================================================================================
// The faithful in-memory world (report_snapshots + storage + Ads + mappings + catalog + lineage + fenced live CAS).
// =====================================================================================================================
// PostgREST renders a timestamptz as ISO with the fraction's trailing zeros trimmed and a +00:00 offset.
const pgrest = (ms) => { const iso = new Date(ms).toISOString(); const m = iso.match(/^(.*T\d{2}:\d{2}:\d{2})\.(\d{3})Z$/); const f = m[2].replace(/0+$/, ""); return m[1] + (f ? "." + f : "") + "+00:00"; };
// The SQL emulator's to_char(... at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') -- an INDEPENDENT formatter.
const toChar = (s) => (s == null ? null : new Date(Date.parse(s)).toISOString().replace(/\.(\d{3})Z$/, ".$1000Z"));
// The Postgres EMULATION of the shared Ads-row digest aggregate, INTERPRETED FROM THE SQL TEXT (never the JS twin): the
// per-row program is parsed out of adsRowDigestTextSql("r.") and the lanes / prefix out of adsRowsDigestSql("r."), then
// evaluated with Postgres semantics (octet_length = UTF-8 bytes, to_char of the STORED instant in UTC with microseconds,
// md5 hex, ('x' || hex)::bit(n)::bigint, exact sums).
const pgUs = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(String(s));
  if (!m) throw new Error("emulator: unparsable timestamptz " + s);
  const off = m[8] === "Z" ? 0 : (m[8][0] === "-" ? -1 : 1) * (Number(m[8].slice(1, 3)) * 60 + (m[8].length > 3 ? Number(m[8].slice(-2)) : 0));
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - off * 60000).toISOString().slice(0, 19) + "." + (m[7] || "").padEnd(6, "0") + "Z";
};
const ADS_PROGRAM = (() => {
  const rowSql = RD.adsRowDigestTextSql("r.");
  const OP = /^(?:octet_length\(coalesce\(r\.([a-z_]+), ''\)\)::text \|\| ':' \|\| coalesce\(r\.\1, ''\) \|\| '\|'|coalesce\(to_char\(r\.([a-z_]+), 'YYYY-MM-DD'\), ''\) \|\| '\|'|coalesce\(to_char\(r\.([a-z_]+) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS\.US"Z"'\), ''\) \|\| '\|')(?: \|\| |$)/;
  const ops = []; let rest = rowSql;
  while (rest.length) { const m = OP.exec(rest); if (!m) throw new Error("emulator: unparsed digest SQL"); ops.push(m[1] ? ["L", m[1]] : m[2] ? ["D", m[2]] : ["T", m[3]]); rest = rest.slice(m[0].length); }
  const agg = RD.adsRowsDigestSql("r.");
  const prefix = (agg.match(/^'([a-z0-9]+:)' \|\| count\(r\.account_id\)::text/) || [])[1];
  const lanes = [...agg.matchAll(/substr\(md5\((.+?)\), (\d+), (\d+)\)\)::bit\((\d+)\)::bigint\), 0\)::text/g)].map((m) => ({ arg: m[1], start: +m[2], len: +m[3], bits: +m[4] }));
  if (!prefix || lanes.length !== 2 || lanes.some((l) => l.arg !== rowSql || l.bits !== 4 * l.len)) throw new Error("emulator: unexpected digest aggregate");
  return { ops, prefix, lanes };
})();
const pgAdsRowsDigest = (rows) => {
  const sums = ADS_PROGRAM.lanes.map(() => 0n);
  for (const r of rows) {
    const text = ADS_PROGRAM.ops.map(([k, c]) => (k === "L" ? Buffer.byteLength(S(r[c]), "utf8") + ":" + S(r[c]) : k === "D" ? S(r[c]).slice(0, 10) : (r[c] == null ? "" : pgUs(r[c]))) + "|").join("");
    const h = createHash("md5").update(Buffer.from(text, "utf8")).digest("hex");
    ADS_PROGRAM.lanes.forEach((l, i) => { sums[i] += BigInt("0x" + h.substr(l.start - 1, l.len)); });
  }
  return ADS_PROGRAM.prefix + rows.length + ":" + sums.map(String).join(":");
};
// The SHARED per-day partials statement (RD.ADS_DAILY_PARTIALS_SQL) emulated with the SAME digest program: one row per
// (account, metric_date) with rows in [from, to] of source `key` -- n, the two lane sums, max(updated_at) as to_char'd.
const pgAdsDailyPartials = (rows, key, from, to) => {
  const groups = new Map();
  for (const r of rows) {
    if (r.source_key !== key || S(r.metric_date).slice(0, 10) < from || S(r.metric_date).slice(0, 10) > to) continue;
    const g = r.account_id + "\u0000" + S(r.metric_date).slice(0, 10);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  const partials = [...groups.keys()].sort().map((g) => {
    const list = groups.get(g);
    const [, n, s1, s2] = pgAdsRowsDigest(list).split(":");
    const maxUa = list.map((r) => pgUs(r.updated_at)).sort().pop();
    return { account_id: list[0].account_id, metric_date: S(list[0].metric_date).slice(0, 10), n, s1, s2, max_ua: maxUa, range_from: from, range_to: to };
  });
  // the always-present SENTINEL row (UNION ALL) echoing the scanned range
  return [...partials, { account_id: null, metric_date: null, n: "0", s1: "0", s2: "0", max_ua: null, range_from: from, range_to: to }];
};
const jsonbTypeof = (v) => (v === undefined ? null : v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "object" ? "object" : typeof v === "string" ? "string" : typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : null);

function makeWorld() {
  let clock = Date.UTC(2026, 8, 24, 6, 0, 0); // 11:30 IST: IN today = 2026-09-24
  const snaps = new Map(); const storage = new Map(); const storageFail = new Set();
  const cycles = new Map(); const jobs = [];
  const adsState = new Map(); const adsCoverage = []; const mappings = []; const catalog = [];
  const adsRows = []; // durable ads_daily_source_rows (PostgREST-shaped: '+00:00' instants, 'YYYY-MM-DD' dates)
  const n = { cycleCreate: 0, jobInsert: 0, claimLease: 0, shadowCas: 0, shadowWrite: 0, reconcile: 0, finalize: 0, liveCas: 0, liveWrite: 0, preflight: 0, publish: 0, snapshotUpdate: 0 };
  const rest = []; const restFail = new Set(); const sql = []; let sqlFail = false;
  let seq = 0;
  const w = { snaps, storage, storageFail, cycles, jobs, adsState, adsCoverage, mappings, catalog, adsRows, hooks: {}, n, rest, restFail, sql, adsReads: [] };
  w.now = () => clock;
  w.setClock = (ms) => { clock = ms; };
  w.tick = (ms = 1000) => { clock += ms; return clock; };
  w.setSqlFail = (v) => { sqlFail = !!v; };
  w.lease = { ownerToken: "op-owner", generation: 7 };
  w.fence = { ownerToken: "op-owner", generation: 7 };
  w.promoted = [BVB, BVK];
  w.rollout = ["IN1", "IN2", "IN3"];
  w.discovered = ["IN1", "IN2", "IN3"];
  const snapKey = (rk, a, h) => rk + "|" + a + "|" + h;
  const byAcct = (rk, a) => [...snaps.values()].filter((r) => r.report_key === rk && r.account_id === a);
  const newest = (rows) => rows.slice().sort((x, y) => Date.parse(y.updated_at) - Date.parse(x.updated_at))[0] || null;

  // ---- upstream source rows ----
  w.putRow = ({ reportKey, accountId, params, payload = null, storagePath = null, hash = null }) => {
    const h = hash || paramsHashFor(S(params && params.reportVersion) || "x", params || {});
    const k = snapKey(reportKey, accountId, h);
    const cur = snaps.get(k);
    const at = pgrest(w.tick(1000));
    const row = { id: cur ? cur.id : "row-" + (++seq), report_key: reportKey, account_id: accountId, params_hash: h, params: clone(params || {}), payload: clone(payload), payload_storage_path: storagePath, source_refreshed_at: at, updated_at: at };
    snaps.set(k, row);
    return row;
  };
  // ---- the REST facade (supabase.js reader names; every row a FRESH copy, like a real HTTP read) ----
  const call = (name, key, fn) => { rest.push(name + (key ? ":" + key : "")); if (restFail.has(name) || (key && restFail.has(name + ":" + key))) throw new Error("rest read failed: " + name); return fn(); };
  const ns = {};
  ns.getLatestReportSnapshot = async ({ reportKey, accountId }) => call("getLatestReportSnapshot", reportKey, () => clone(newest(byAcct(reportKey, accountId))));
  ns.getReportSnapshot = async ({ reportKey, accountId, paramsHash }) => call("getReportSnapshot", reportKey, () => clone(snaps.get(snapKey(reportKey, accountId, paramsHash)) || null));
  ns.getLatestReportSnapshotForScope = async ({ reportKey, accountId, reportVersion = null, scope = {} }) => call("getLatestReportSnapshotForScope", reportKey, () => clone(newest(byAcct(reportKey, accountId).filter((r) => (reportVersion == null || S(r.params && r.params.reportVersion) === S(reportVersion)) && Object.entries(scope || {}).every(([k, v]) => v == null || S(r.params && r.params[k]) === S(v))))));
  ns.getReportSnapshotStoragePayload = async (p) => call("getReportSnapshotStoragePayload", null, () => { if (storageFail.has(p)) throw new Error("storage read failed"); return storage.has(p) ? clone(storage.get(p)) : null; });
  // The REAL storage-first hydration (supabase.js) over the fake latest + storage readers.
  ns.getLatestReportSnapshotHydrated = async (args, opts = {}) => { rest.push("getLatestReportSnapshotHydrated:" + args.reportKey + ":" + args.accountId); return SB.getLatestReportSnapshotHydrated(args, { ...opts, readLatest: ns.getLatestReportSnapshot, readStorage: opts.readStorage || ns.getReportSnapshotStoragePayload }); };
  ns.getLatestReportSnapshotMeta = async ({ reportKey, accountId }) => call("getLatestReportSnapshotMeta", reportKey, () => { const r = newest(byAcct(reportKey, accountId)); return r ? { params_hash: r.params_hash, source_refreshed_at: r.source_refreshed_at, updated_at: r.updated_at } : null; });
  ns.getDailyAdsCoverage = async (accountId, sourceKey) => {
    rest.push("getDailyAdsCoverage");
    if (restFail.has("getDailyAdsCoverage")) return { windows: [], status: "missing", latestMetricDate: null, contentRev: null, read: "read-failed", error: "COVERAGE_READ_FAILED" };
    const windows = adsCoverage.filter((c) => c.account_id === accountId && c.source_key === sourceKey && c.status === "succeeded").sort((x, y) => (x.covered_from < y.covered_from ? -1 : 1)).map((c) => ({ from: c.covered_from, to: c.covered_to }));
    const st = adsState.get(accountId + "|" + sourceKey) || null;
    return { windows, status: st ? (st.last_status || "missing") : "missing", latestMetricDate: st ? st.latest_metric_date || null : null, contentRev: st ? st.content_rev || null : null, read: "ok", error: null };
  };
  ns.getCampaignBrandMappings = async ({ organizationFingerprint, connectionId = "primary", accountId }) => call("getCampaignBrandMappings", null, () => clone(mappings.filter((m) => m.organization_fingerprint === organizationFingerprint && m.connection_id === connectionId && m.account_id === accountId).map((m) => ({ marketplace: m.marketplace, ads_profile_id: m.ads_profile_id, ad_campaign_id: m.ad_campaign_id, canonical_brand_key: m.canonical_brand_key, brand_display_name: m.brand_display_name, mapping_source: m.mapping_source, updated_at: m.updated_at }))));
  ns.getSourceSnapshot = async ({ organizationFingerprint, connectionId = "primary", sourceKey, scopeKey }) => {
    rest.push("getSourceSnapshot");
    if (restFail.has("getSourceSnapshot")) return { snapshot: null, read: "read-failed", error: "SOURCE_SNAPSHOT_READ_FAILED" };
    const r = catalog.find((c) => c.organization_fingerprint === organizationFingerprint && c.connection_id === connectionId && c.source_key === sourceKey && c.scope_key === scopeKey) || null;
    return { snapshot: clone(r), read: "ok", error: null };
  };
  ns.getInventorySnapshotCandidates = async ({ reportKey, accountId, reportVersion }) => call("getInventorySnapshotCandidates", null, () => {
    const rows = byAcct(reportKey, accountId);
    const available = newest(rows.filter((r) => r.payload && S(r.payload.inventoryAvailable) === "true" && (reportVersion == null || S(r.params && r.params.reportVersion) === S(reportVersion))));
    const latest = newest(rows);
    const o = [];
    if (available) o.push(clone(available));
    if (latest && (!available || latest.id !== available.id)) o.push(clone(latest));
    return o;
  });
  ns.getAdsDailySourceRows = async ({ accountId, sourceKeys = [], from, to } = {}) => call("getAdsDailySourceRows", null, () => {
    if (typeof w.hooks.onAdsRows === "function") w.hooks.onAdsRows(accountId);
    return clone(adsRows.filter((r) => r.account_id === accountId && sourceKeys.includes(r.source_key) && r.metric_date >= from && r.metric_date <= to));
  });
  // The pure out-of-line test the facade carries (route-publication-release ROUTE_PURE_SUPABASE_HELPERS allowlist).
  ns.inlinePayloadUsable = SB.inlinePayloadUsable;
  w.sbNs = ns;
  w.sb = REL.readOnlySupabase(ns);
  w.restCount = (prefix) => rest.filter((x) => x.startsWith(prefix)).length;

  // ---- the Postgres-semantics EMULATOR of the routes' evidence SQL (keyed by the exact text) ----
  const rank1 = (rows) => { if (!rows.length) return []; const max = Math.max(...rows.map((r) => Date.parse(r.updated_at))); return rows.filter((r) => Date.parse(r.updated_at) === max); };
  const invCols = (r) => (r.report_key === "brand-inventory" ? { inv_available: r.payload == null ? null : (r.payload.inventoryAvailable === undefined ? null : r.payload.inventoryAvailable), inv_date: r.payload && r.payload.inventoryDate !== undefined ? r.payload.inventoryDate : null, inv_snapshot_date: r.payload && r.payload.inventorySnapshotDate !== undefined ? r.payload.inventorySnapshotDate : null, inv_ibbc_type: r.payload ? jsonbTypeof(r.payload.inventoryByBrandCountry) : null } : { inv_available: null, inv_date: null, inv_snapshot_date: null, inv_ibbc_type: null });
  const idCols = (r) => ({ report_key: r.report_key, account_id: r.account_id, id: r.id, params_hash: r.params_hash, source_refreshed_at: toChar(r.source_refreshed_at), updated_at: toChar(r.updated_at), report_version: r.params && r.params.reportVersion !== undefined ? S(r.params.reportVersion) : null });
  w.pgReadOnly = async (text, values = []) => {
    sql.push(text.slice(0, 40));
    if (!RC.isReadOnlyEvidenceSql(text)) throw new Error("pgReadOnly refuses a non-read-only statement");
    if (sqlFail) throw new Error("pg read failed");
    if (text === BVB_W.LATEST_ROWS_SQL) {
      const [keys, accts] = values;
      const o = [];
      for (const rk of keys) for (const a of accts) for (const r of rank1(byAcct(rk, a))) o.push({ ...idCols(r), ...invCols(r) });
      return clone(o);
    }
    if (text === BV_W.INVENTORY_AVAILABLE_SQL) {
      const [accts, ver] = values;
      const o = [];
      for (const a of accts) for (const r of rank1(byAcct("brand-inventory", a).filter((x) => x.payload != null && S(x.payload.inventoryAvailable) === "true" && S(x.params && x.params.reportVersion) === S(ver)))) o.push({ ...idCols(r), ...invCols(r) });
      return clone(o);
    }
    if (text === BV_W.DIRECTORY_ROWS_SQL) {
      const [accts, hashes] = values;
      return clone([...snaps.values()].filter((r) => r.report_key === "brand-view-brands" && accts.includes(r.account_id) && hashes.includes(r.params_hash)).map((r) => ({ ...idCols(r), inline_payload: r.payload != null, brands: r.payload && r.payload.brands !== undefined ? r.payload.brands : null, payload_account_id: r.payload && r.payload.accountId != null ? S(r.payload.accountId) : null })));
    }
    if (text === BV_W.ADS_STATE_SQL) {
      const [accts, key] = values;
      return accts.map((a) => {
        const st = adsState.get(a + "|" + key) || null;
        const cov = adsCoverage.filter((c) => c.account_id === a && c.source_key === key && c.status === "succeeded").sort((x, y) => (x.covered_from < y.covered_from ? -1 : x.covered_from > y.covered_from ? 1 : (x.covered_to < y.covered_to ? -1 : 1)));
        return { account_id: a, has_state: !!st, last_status: st ? st.last_status : null, latest_metric_date: st ? st.latest_metric_date : null, content_rev: st ? st.content_rev : null, windows: cov.length ? cov.map((c) => c.covered_from + ".." + c.covered_to).join(",") : null };
      });
    }
    if (text === BV_W.CAMPAIGN_MAPPING_SQL) {
      const [accts, org] = values;
      const o = [];
      for (const a of accts) {
        const rows = mappings.filter((m) => m.organization_fingerprint === org && m.connection_id === "primary" && m.account_id === a).sort((x, y) => (x.marketplace + "\u0000" + x.ads_profile_id + "\u0000" + x.ad_campaign_id < y.marketplace + "\u0000" + y.ads_profile_id + "\u0000" + y.ad_campaign_id ? -1 : 1));
        if (!rows.length) continue;
        const max = rows.map((m) => toChar(m.updated_at)).sort().pop();
        const agg = rows.map((m) => [m.marketplace, m.ads_profile_id, m.ad_campaign_id, m.canonical_brand_key, m.brand_display_name, m.mapping_source, toChar(m.updated_at)].join("|")).join(",");
        o.push({ account_id: a, n: rows.length, max_updated_at: max, content_md5: createHash("md5").update(agg).digest("hex") });
      }
      return o;
    }
    if (text === BV_W.PRODUCT_CATALOG_SQL) {
      const [org] = values;
      return catalog.filter((c) => c.connection_id === "primary" && c.source_key === "product-catalog" && c.scope_key === "__organization" && c.organization_fingerprint === org).map((c) => ({ organization_fingerprint: c.organization_fingerprint, payload_sha: c.payload_sha, validated_at: toChar(c.validated_at), source_request_hash: c.source_request_hash }));
    }
    if (text === RD.ADS_DAILY_PARTIALS_SQL) {
      // the SHARED per-day partials over [$2, $3] of source $1 (every account; the route folds them per window).
      const [key, from, to] = values;
      w.adsReads.push({ scoped: false, accounts: null });
      return clone(pgAdsDailyPartials(adsRows, key, from, to));
    }
    if (text === RD.ADS_DAILY_ACCOUNT_PARTIALS_SQL) {
      // the ACCOUNT-SCOPED twin: the same partials restricted to $4 (the evidence accounts) + the sentinel.
      const [key, from, to, accts] = values;
      w.adsReads.push({ scoped: true, accounts: [...accts] });
      return clone(pgAdsDailyPartials(adsRows.filter((r) => accts.includes(r.account_id)), key, from, to));
    }
    throw new Error("unknown evidence SQL");
  };

  // ---- lineage store + fenced live CAS + the REAL publisher ----
  const cycleById = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  const jobOf = (cycleId, rk, a) => jobs.find((j) => j.cycle_id === cycleId && j.report_key === rk && j.account_id === a) || null;
  w.openCycle = async ({ bucket, cycleDate }) => { const k = bucket + "|" + cycleDate; if (!cycles.has(k)) { n.cycleCreate += 1; cycles.set(k, { id: "cyc-" + (++seq), bucket, cycle_date: cycleDate, status: "pending", created_at: pgrest(w.tick()) }); } };
  w.getCycleByBucketDate = async (bucket, cycleDate) => { const c = cycles.get(bucket + "|" + cycleDate); return c ? { ...c } : null; };
  w.claimCycle = async (id) => { const c = cycleById(id); if (c && c.status === "pending") { c.status = "running"; return true; } return false; };
  w.readCycle = async (id) => { const c = cycleById(id); return c ? { ...c } : null; };
  w.upsertReportJob = async (job) => {
    if (jobOf(job.cycleId, job.reportKey, job.accountId)) return;
    n.jobInsert += 1;
    jobs.push({ id: "job-" + (++seq), cycle_id: job.cycleId, report_key: job.reportKey, account_id: job.accountId, bucket: job.bucket, depends_on: [...(job.dependsOn || [])], durable_content_deps: [...(job.durableContentDeps || [])], derive_status: "pending", save_status: "pending", validated: false, snapshot_params_hash: null, lease_token: null, lease_expires: 0, created_at: ++seq });
  };
  w.claimLease = async (cycleId, rk, a, { leaseSeconds = 300 } = {}) => {
    n.claimLease += 1;
    const j = jobOf(cycleId, rk, a);
    if (!j) return { disposition: "not-found", leaseToken: null, snapshotParamsHash: null };
    if (j.validated === true) return { disposition: "already-complete", leaseToken: null, snapshotParamsHash: j.snapshot_params_hash };
    if (j.derive_status === "running" && j.lease_expires > clock) return { disposition: "held", leaseToken: null, snapshotParamsHash: null };
    const disposition = j.derive_status === "running" ? "reclaimed" : "claimed";
    j.derive_status = "running"; j.lease_token = "lt-" + (++seq); j.lease_expires = clock + leaseSeconds * 1000;
    return { disposition, leaseToken: j.lease_token, snapshotParamsHash: null };
  };
  const casInto = (counterCas, counterWrite, idPrefix) => async ({ reportKey, accountId, paramsHash, params, payload, sourceRefreshedAt, ownerToken, generation, fenced }) => {
    n[counterCas] += 1;
    if (fenced && (ownerToken !== w.lease.ownerToken || Number(generation) !== Number(w.lease.generation))) return { outcome: "lease-lost", reason: "fence-mismatch" };
    const k = snapKey(reportKey, accountId, paramsHash); const cur = snaps.get(k);
    const cand = Date.parse(sourceRefreshedAt);
    if (cur) {
      const have = Date.parse(cur.source_refreshed_at);
      if (have > cand) return { outcome: "newer-live" };
      if (have === cand) return B.stableJson(cur.params) === B.stableJson(params) && B.stableJson(cur.payload) === B.stableJson(payload) ? { outcome: "already-current" } : { outcome: "conflict" };
    }
    n[counterWrite] += 1;
    snaps.set(k, { id: cur ? cur.id : idPrefix + (++seq), report_key: reportKey, account_id: accountId, params_hash: paramsHash, params: clone(params), payload: clone(payload), payload_storage_path: null, source_refreshed_at: sourceRefreshedAt, updated_at: pgrest(w.tick(1000)) });
    return { outcome: cur ? "replaced" : "inserted" };
  };
  w.saveShadow = casInto("shadowCas", "shadowWrite", "shadow-");
  const liveCasRaw = casInto("liveCas", "liveWrite", "live-");
  w.liveCas = (args) => liveCasRaw({ ...args, fenced: true });
  w.reconcileSuccess = async ({ cycleId, reportKey, accountId, snapshotParamsHash, leaseToken }) => {
    n.reconcile += 1;
    const j = jobOf(cycleId, reportKey, accountId); if (!j) return { disposition: "not-found" };
    if (j.validated === true) return { disposition: "already-complete" };
    if (j.lease_token !== leaseToken) return { disposition: "lease-lost" };
    Object.assign(j, { validated: true, derive_status: "succeeded", save_status: "succeeded", snapshot_params_hash: snapshotParamsHash });
    return { disposition: "reconciled" };
  };
  w.finalizeCycle = async ({ cycleId }) => {
    n.finalize += 1;
    const c = cycleById(cycleId); if (!c) return { disposition: "not-found" };
    if (c.status === "succeeded" || c.status === "partial") return { disposition: "already-terminal" };
    if (c.status !== "running") return { disposition: "invalid-status" };
    c.status = jobs.some((j) => j.cycle_id === cycleId && j.validated === true) ? "succeeded" : "partial";
    return { disposition: "finalized" };
  };
  const latestJobRow = (rk, a) => jobs.filter((x) => x.report_key === rk && x.account_id === a).sort((x, y) => y.created_at - x.created_at)[0] || null;
  w.readLatestJob = async (rk, a) => {
    const j = latestJobRow(rk, a); if (!j) return null;
    const c = cycleById(j.cycle_id);
    return { reportKey: j.report_key, accountId: j.account_id, deriveStatus: j.derive_status, saveStatus: j.save_status, validated: j.validated === true, dependsOn: j.depends_on.map(String), durableContentDeps: j.durable_content_deps.map(String), snapshotParamsHash: j.snapshot_params_hash, latestDataDate: null, cycleStatus: c ? c.status : null, id: j.id, cycleId: j.cycle_id, createdAt: j.created_at };
  };
  w.readSnapshot = async ({ reportKey, accountId, paramsHash }) => clone(snaps.get(snapKey(reportKey, accountId, paramsHash)) || null);
  w.loadStoragePayload = async (p) => (storage.has(p) ? clone(storage.get(p)) : null);
  let publisher = null;
  w.publisherFor = (signal) => {
    w.activeSignal = signal || null;
    if (!publisher) {
      const real = buildSchedulerV2Publisher({
        connections: [{ id: "primary", apiKey: "test-key", label: "Primary" }],
        fetchAccounts: async () => w.discovered.map((id) => ({ id, name: id, country: "IN" })),
        getAccountRollout: async () => ({ read: "ok", allPrimary: false, enabledAccountIds: w.rollout }),
        getSettings: async () => [],
        getPromotedSettings: async () => w.promoted.map((rk) => ({ report_key: rk, publish_enabled: true })),
        getApproval: async () => ({ read: "ok", approved: true }),
        getJob: async (rk, a) => { const j = latestJobRow(rk, a); if (!j) return null; const c = cycleById(j.cycle_id); return { cycle_id: j.cycle_id, report_key: rk, account_id: a, derive_status: j.derive_status, save_status: j.save_status, validated: j.validated === true, snapshot_params_hash: j.snapshot_params_hash, cycle_status: c ? c.status : null }; },
        getSnapshot: w.readSnapshot,
        loadStoragePayload: w.loadStoragePayload,
        publishLiveFenced: (args) => w.liveCas(args),
        getControlFence: () => (w.activeSignal && w.activeSignal.aborted ? null : w.fence),
      });
      publisher = { preflight: async (rk, a) => { n.preflight += 1; return real.preflight(rk, a); }, publish: async (rk, a) => { n.publish += 1; return real.publish(rk, a); } };
    }
    return publisher;
  };
  w.verifyLease = async () => ({ ok: true });
  w.readbackLive = REL.buildRouteLiveReadback({ getReportSnapshot: w.readSnapshot, loadStoragePayload: w.loadStoragePayload, liveContracts: L, reportDerivations: D, computeHash: paramsHashFor });
  w.writes = () => n.cycleCreate + n.jobInsert + n.shadowWrite + n.reconcile + n.finalize + n.liveWrite;
  w.directory = new Map([
    ["IN1", { accountId: "IN1", country: "IN", marketplace: "IN", rawSellerId: "raw-1", name: "India One", currency: "INR" }],
    ["IN2", { accountId: "IN2", country: "IN", marketplace: "IN", rawSellerId: "raw-2", name: "India Two", currency: "INR" }],
    ["IN3", { accountId: "IN3", country: "IN", marketplace: "IN", rawSellerId: "raw-3", name: "India Three", currency: "INR" }],
  ]);
  return w;
}

// The seeded upstream evidence: IN1 sells Acme + Zeta (brand-sales), Beta appears only in fba-plan (a directory brand
// with NO order value -> its Brand View build fails); IN2 sells Acme; IN3 records only "Unassigned" (an empty directory).
const salesRows = (brands) => brands.flatMap((b) => ["2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23"].map((d, i) => ({ date: d, marketplace_country_code: "IN", currency: "INR", product_brand: b, total_sales: 100 + i, total_units_sold: 2, seller_or_vendor_name: "Seller" })));
function seed(w) {
  w.putRow({ reportKey: "brand-sales", accountId: "IN1", params: { reportVersion: "brand-sales-shared-v1", from: "2026-08-01", to: "2026-09-23" }, payload: { rows: salesRows(["Acme", "Zeta"]) } });
  w.putRow({ reportKey: "fba-plan", accountId: "IN1", params: { reportVersion: "fba-plan-shared-v1", to: "2026-09-23" }, payload: { rows: [{ asin: "B0A", brand: "Acme", fbaAvailable: 5 }, { asin: "B0B", brand: "Beta", fbaAvailable: 2 }] } });
  w.putRow({ reportKey: "sku-pl", accountId: "IN1", params: { reportVersion: "sku-pl-shared-v1", from: "2026-08-24", to: "2026-09-23" }, payload: { rows: [{ asin: "B0Z", brand: "Zeta" }] } });
  w.putRow({ reportKey: "brand-inventory", accountId: "IN1", params: { reportVersion: BV.BRAND_INVENTORY_REPORT_VERSION, to: "2026-09-22" }, payload: { accountId: "IN1", inventoryAvailable: true, inventoryDate: "2026-09-22", inventoryByBrandCountry: [{ brand: "Acme", country: "IN", fbaAvailable: 7 }] } });
  w.putRow({ reportKey: "brand-inventory", accountId: "IN1", params: { reportVersion: BV.BRAND_INVENTORY_REPORT_VERSION, to: "2026-09-23" }, payload: { accountId: "IN1", inventoryAvailable: false, inventoryByBrandCountry: [] } });
  w.putRow({ reportKey: "brand-sales", accountId: "IN2", params: { reportVersion: "brand-sales-shared-v1", from: "2026-08-01", to: "2026-09-23" }, payload: { rows: salesRows(["Acme"]) } });
  w.putRow({ reportKey: "brand-sales", accountId: "IN3", params: { reportVersion: "brand-sales-shared-v1", from: "2026-08-01", to: "2026-09-23" }, payload: { rows: salesRows(["Unassigned"]) } });
  w.adsState.set("IN1|" + ACTIVE_ADS_SOURCE_KEY, { last_status: "succeeded", latest_metric_date: "2026-09-22", content_rev: "rev-1" });
  w.adsCoverage.push({ account_id: "IN1", source_key: ACTIVE_ADS_SOURCE_KEY, covered_from: "2026-06-01", covered_to: "2026-09-22", status: "succeeded" });
  w.mappings.push({ organization_fingerprint: ORG, connection_id: "primary", account_id: "IN1", marketplace: "IN", ads_profile_id: "", ad_campaign_id: "c-1", canonical_brand_key: "acme", brand_display_name: "Acme", mapping_source: "MANUAL", updated_at: pgrest(w.tick()) });
  w.catalog.push({ organization_fingerprint: ORG, connection_id: "primary", source_key: "product-catalog", scope_key: "__organization", payload_sha: "cat-sha-1", validated_at: pgrest(w.tick()), source_request_hash: "rh-1", object_path: "catalog/obj" });
  w.tick(60000);
}

// The route deps the CLI hands build() (publication-route-reconcile.mjs), over a world.
const routeDeps = (w) => Object.freeze({
  bucket: REGION, epoch: EPOCH, directory: w.directory, orgFp: ORG, connectionId: "primary", sb: w.sb, pgReadOnly: w.pgReadOnly, selectors: SEL,
  computeHash: paramsHashFor, liveContracts: L, reportDerivations: D, marketplaceToday, normalizeMarketplace, now: () => w.now(), strict: true, log: () => {},
});
// Build one route's runtime + release + reconciler over a world; run({ dryRun, accounts }).
function routeHarness(w, cliRoute, { wrap = null, verifyExact = false } = {}) {
  let runtime = cliRoute.build(routeDeps(w));
  if (typeof wrap === "function") runtime = wrap(runtime);
  RC.validateRouteRuntime(runtime, cliRoute.id);
  const release = REL.buildRoutePublicationRelease({
    route: cliRoute, runtime,
    deps: {
      openCycle: w.openCycle, getCycleByBucketDate: w.getCycleByBucketDate, claimCycle: w.claimCycle, readCycle: w.readCycle,
      upsertReportJob: w.upsertReportJob, claimLease: w.claimLease, saveShadow: w.saveShadow, reconcileSuccess: w.reconcileSuccess, finalizeCycle: w.finalizeCycle,
      readLatestJob: w.readLatestJob, readSnapshot: w.readSnapshot, loadStoragePayload: w.loadStoragePayload,
      publisherFor: w.publisherFor, verifyLease: w.verifyLease, readbackLive: w.readbackLive,
      liveContracts: L, reportDerivations: D, computeHash: paramsHashFor,
      evidenceContext: { directory: w.directory, organizationFingerprint: ORG, connectionId: "primary" },
      publishSnapshotUpdate: async () => { w.n.snapshotUpdate += 1; },
      now: () => w.now(), log: () => {},
    },
  });
  const controls = { opened: [], closed: 0 };
  const run = ({ dryRun = false, accounts = ["IN1", "IN2", "IN3"] } = {}) => SDR.buildSavedDataReconciler({
    resolveOrg: async () => ({ organizationFingerprint: ORG, connectionId: "primary" }),
    bucketAccounts: async () => accounts.map((accountId) => ({ accountId })),
    adapter: REL.buildRouteReconcileAdapter({ route: cliRoute, runtime, bucket: REGION, directory: w.directory, liveContracts: L, readLatestJob: w.readLatestJob, verifyExact }),
    readLatestReportJob: ({ reportKey, accountId }) => w.readLatestJob(reportKey, accountId),
    readShadowSnapshot: (a) => w.readSnapshot(a), readLiveSnapshot: (a) => w.readSnapshot(a), loadStoragePayload: w.loadStoragePayload,
    verifyLiveReadback: w.readbackLive, liveContracts: L, computeHash: paramsHashFor, reportDerivations: D,
    runPrepareForUnit: (a) => release.prepareForUnit(a), runPublishForUnit: (a) => release.publishForUnit(a),
    openControls: async (x) => { controls.opened.push(x); return { ok: true }; }, closeControls: async () => { controls.closed += 1; return { ok: true }; },
    reportKeys: [cliRoute.publisherKey], family: cliRoute.id,
  }).run({ bucket: REGION, requestedAsOf: EPOCH, mode: "periodic", dryRun });
  return { runtime, release, run, controls };
}
const recOf = (s, acct) => s.perAccount.find((r) => r.accountId === acct) || null;
const unitOf = (s, acct, brand) => { const r = recOf(s, acct); return r && Array.isArray(r.units) ? r.units.find((u) => u.unitKey === BV_C.brandUnitKey(brand)) || null : null; };
const bvState = (s, acct, brand) => { const u = unitOf(s, acct, brand); return u && u.reports[BVK] ? u.reports[BVK] : null; };
const bvbLiveHash = (acct) => paramsHashFor("brand-view-brands-v1", { accountId: acct });
const bvbLive = (w, acct) => w.snaps.get(BVB + "|" + acct + "|" + bvbLiveHash(acct)) || null;
const bvLiveHash = (acct, brand, asOf) => paramsHashFor(BV.BRAND_VIEW_VERSION, { accountId: acct, brand, asOf });
const bvLive = (w, acct, brand, asOf) => w.snaps.get(BVK + "|" + BV.brandViewScopeId(acct, brand) + "|" + bvLiveHash(acct, brand, asOf)) || null;
const targetsTok = (s, route) => { const t = TGT.parseTargetsLine(TGT.formatTargetsLine({ v: 2, route, summary: { ...s, bucket: REGION, requestedAsOf: EPOCH, dryRun: true } })); return t ? new Map(t.targets.map((x) => [x.id, x.tok])) : new Map(); };
// The worker's own tier-1 token: run the WORKER module's evidence SQL + compose (ctx as the worker store passes it).
async function workerTokens(w, workerRoute) {
  const ctx = { directory: w.directory, organizationFingerprint: ORG, now: new Date(w.now()) };
  const rows = {};
  for (const q of workerRoute.evidence.sql) rows[q.name] = await w.pgReadOnly(q.text, q.params(ctx));
  return workerRoute.evidence.compose(rows, ctx);
}
// The SAME evaluation in SWEEP MODE (the worker's tier-1 / watermark pass): a statement's sharedVariant runs through ONE
// sweep cache (routes.js sweepMemoQuery), exactly as evaluateRouteEvidence(..., { sweep: true }) does.
async function workerTokensSweep(w, workerRoute, cache) {
  const ctx = { directory: w.directory, organizationFingerprint: ORG, now: new Date(w.now()) };
  const q2 = ROUTES.sweepMemoQuery(w.pgReadOnly, cache);
  const rows = {};
  for (const q of workerRoute.evidence.sql) { const st = q.sharedVariant || q; rows[q.name] = await q2(st.text, st.params(ctx), st); }
  return workerRoute.evidence.compose(rows, ctx);
}

// =====================================================================================================================
// D. brand-view-brands
// =====================================================================================================================
const W = makeWorld();
seed(W);
{
  let refused = 0;
  try { BVB_C.default.build({ ...routeDeps(W), pgReadOnly: null }); } catch { refused += 1; }
  try { BV_C.default.build({ ...routeDeps(W), sb: REL.readOnlySupabase({}) }); } catch { refused += 1; }
  // WP10: brand-view-brands derives through the serve's storage-first HYDRATED reader (+ the observed storage loader).
  try { BVB_C.default.build({ ...routeDeps(W), sb: REL.readOnlySupabase({ ...W.sbNs, getLatestReportSnapshotHydrated: undefined }) }); } catch { refused += 1; }
  try { BVB_C.default.build({ ...routeDeps(W), sb: REL.readOnlySupabase({ ...W.sbNs, getReportSnapshotStoragePayload: undefined }) }); } catch { refused += 1; }
  ok("A5 build() fails closed without its read-only collaborators (pgReadOnly / the REST readers / brand-view-brands' hydrated reader + storage loader); the runtimes carry only known hooks", refused === 4
    && typeof W.sb.getLatestReportSnapshotHydrated === "function" && typeof W.sb.getReportSnapshotStoragePayload === "function"
    && RC.routeRuntimeProblems(BVB_C.default.build(routeDeps(W))).length === 0 && RC.routeRuntimeProblems(BV_C.default.build(routeDeps(W))).length === 0);
}
const HB = routeHarness(W, BVB_C.default);
{
  const s0 = await HB.run({ dryRun: true });
  const wt = await workerTokens(W, BVB_W.default);
  const tok = targetsTok(s0, BVB);
  ok("D1 scan: all three accounts STALE (never published); the CLI TARGETS v2 tok == the WORKER's own evidence compose token (byte-identical, 'bb1:' + sha256)",
    ["IN1", "IN2", "IN3"].every((a) => recOf(s0, a).reports[BVB].state === RS.ST && tok.get(a) === wt.get(a).token && /^bb1:[0-9a-f]{64}$/.test(tok.get(a)))
    && [...wt.values()].every((x) => x.region === REGION && x.owners.length === 1) && W.writes() === 0);
  const s1 = await HB.run();
  const live1 = bvbLive(W, "IN1"); const live3 = bvbLive(W, "IN3");
  ok("D2 live pass: every directory publishes through the REAL four-gate publisher (READBACK_VERIFIED) at the serve's EXACT identity { accountId }",
    s1.ok === true && s1.counts.targetsPublished === 3 && ["IN1", "IN2", "IN3"].every((a) => recOf(s1, a).reports[BVB].state === RS.RV) && !!live1 && !!live3);
  ok("D2 the IN1 directory = the (storage-first hydrated) builder over brand-sales + fba-plan + sku-pl (Acme, Beta, Zeta), live params carry the evidence token (stored, never hashed)",
    JSON.stringify(live1.payload.brands) === JSON.stringify(["Acme", "Beta", "Zeta"]) && live1.payload.accountId === "IN1" && live1.params.reportVersion === "brand-view-brands-v1"
    && live1.params.accountId === "IN1" && live1.params.evidenceToken === tok.get("IN1") && JSON.stringify(Object.keys(live1.params).sort()) === JSON.stringify(["accountId", "evidenceToken", "reportVersion"]));
  ok("D3 an EMPTY brand list is published ONLY because all three reads were ok (IN3 records only 'Unassigned'; fba-plan / sku-pl genuinely absent)",
    Array.isArray(live3.payload.brands) && live3.payload.brands.length === 0 && live3.payload.sources.length === 0 && typeof live3.payload.message === "string");
  const sel = await SEL.selectExact({ reportKey: BVB, accountId: "IN1", reportVersion: "brand-view-brands-v1", params: { accountId: "IN1" }, readers: { getReportSnapshot: W.sbNs.getReportSnapshot }, computeHash: paramsHashFor });
  ok("D2 the served selector (the serve's cache-first exact read) returns EXACTLY the published row", !!sel.row && sel.row.id === live1.id && sel.row.params_hash === bvbLiveHash("IN1") && sel.via === "exact");
  const s2 = await HB.run({ dryRun: true });
  ok("D2 re-scan: every directory PUBLICATION_NOT_REQUIRED (exact binding + served-row check)", ["IN1", "IN2", "IN3"].every((a) => recOf(s2, a).reports[BVB].state === RS.NR && recOf(s2, a).reports[BVB].served && recOf(s2, a).reports[BVB].served.h === bvbLiveHash(a)));
}
{
  // D4: a READ FAILURE defers (never an empty / partial directory) with ZERO writes.
  const w = makeWorld(); seed(w);
  const h = routeHarness(w, BVB_C.default);
  w.restFail.add("getLatestReportSnapshot:fba-plan");
  const s = await h.run({ accounts: ["IN1"] });
  const e = recOf(s, "IN1").reports[BVB];
  ok("D4 a throwing fba-plan read DEFERS the directory ('derive-not-ready:read-failed:fba-plan') -- zero cycle / job / shadow / live writes, nothing published",
    e.state === RS.DD && /read-failed:fba-plan/.test(S(e.reason)) && w.writes() === 0 && !bvbLive(w, "IN1") && s.counts.targetsPublished === 0);
  w.restFail.clear();
  w.setSqlFail(true);
  const s2 = await h.run({ accounts: ["IN1"] });
  ok("D4 an unreadable evidence SQL defers the WHOLE run (fail closed), zero writes", s2.ok === false && w.writes() === 0 && !bvbLive(w, "IN1"));
  w.setSqlFail(false);
  // A row that advanced between the evidence read and the build: the derive sees a DIFFERENT row than the token binds.
  const rt = BVB_C.default.build(routeDeps(w));
  const b = await rt.resolveBundle({ targetId: "IN1" });
  w.putRow({ reportKey: "sku-pl", accountId: "IN1", params: { reportVersion: "sku-pl-shared-v1", from: "2026-08-24", to: "2026-09-23" }, payload: { rows: [{ asin: "B0Z", brand: "Zeta" }, { asin: "B0Q", brand: "Quux" }] } });
  const d = await rt.derive(b.bundle, {});
  ok("D4 a source row that ADVANCED after the evidence read is never built from (derive notReady 'evidence-advanced:sku-pl')", d.notReady === true && d.reason === "evidence-advanced:sku-pl");
  // A tie at the newest updated_at (two latest rows) is ambiguous: typed ineligible, never a coin flip.
  const tie = await BVB_W.default.evidence.compose({ latest_rows: [{ report_key: "brand-sales", account_id: "IN1", id: "x1", params_hash: "h1", source_refreshed_at: "2026-09-24T00:00:00.000000Z", updated_at: "2026-09-24T00:00:00.000000Z", report_version: "v" }, { report_key: "brand-sales", account_id: "IN1", id: "x2", params_hash: "h2", source_refreshed_at: "2026-09-24T00:00:00.000000Z", updated_at: "2026-09-24T00:00:00.000000Z", report_version: "v" }] }, { directory: w.directory });
  const tieEv = BVB_W.composeBrandViewBrandsEvidence({ latest_rows: [{ report_key: "brand-sales", account_id: "IN1", id: "x1", updated_at: "2026-09-24T00:00:00.000000Z" }, { report_key: "brand-sales", account_id: "IN1", id: "x2", updated_at: "2026-09-24T00:00:00.000000Z" }] }, { accountIds: ["IN1"] }).get("IN1");
  ok("D4 an AMBIGUOUS latest row (a tie at the newest updated_at) is a typed ineligible revision ('latest-row-ambiguous:brand-sales')", tie instanceof Map && BVB_C.brandViewBrandsRevision(tieEv).eligible === false && BVB_C.brandViewBrandsRevision(tieEv).reason === "latest-row-ambiguous:brand-sales");
}
{
  // D5: an upstream fba-plan change changes the token and re-publishes the directory.
  const before = targetsTok(await HB.run({ dryRun: true }), BVB).get("IN1");
  W.putRow({ reportKey: "fba-plan", accountId: "IN1", params: { reportVersion: "fba-plan-shared-v1", to: "2026-09-24" }, payload: { rows: [{ asin: "B0A", brand: "Acme", fbaAvailable: 5 }, { asin: "B0B", brand: "Beta", fbaAvailable: 2 }, { asin: "B0N", brand: "Nova", fbaAvailable: 1 }] } });
  const s1 = await HB.run({ dryRun: true });
  const after = targetsTok(s1, BVB).get("IN1");
  ok("D5 an upstream fba-plan change (a new latest row) changes the IN1 token; IN1 turns STALE while IN2 / IN3 stay current", before !== after && recOf(s1, "IN1").reports[BVB].state === RS.ST && recOf(s1, "IN2").reports[BVB].state === RS.NR);
  const s2 = await HB.run();
  ok("D5 ... and the live pass re-publishes the IN1 directory (now carrying Nova) with the new token", s2.counts.targetsPublished === 1 && JSON.stringify(bvbLive(W, "IN1").payload.brands) === JSON.stringify(["Acme", "Beta", "Nova", "Zeta"]) && bvbLive(W, "IN1").params.evidenceToken === after);
  // Nova sells nothing: restore the directory to the seeded shape for the brand-view section (a new, brand-free fba-plan row).
  W.putRow({ reportKey: "fba-plan", accountId: "IN1", params: { reportVersion: "fba-plan-shared-v1", to: "2026-09-24" }, payload: { rows: [{ asin: "B0A", brand: "Acme", fbaAvailable: 5 }, { asin: "B0B", brand: "Beta", fbaAvailable: 2 }] } });
  const s3 = await HB.run();
  ok("D5 the next change re-converges the directory (Acme, Beta, Zeta) -- zero network throughout", s3.counts.targetsPublished === 1 && JSON.stringify(bvbLive(W, "IN1").payload.brands) === JSON.stringify(["Acme", "Beta", "Zeta"]) && net.calls.length === 0);
}

// =====================================================================================================================
// E. brand-view
// =====================================================================================================================
const HV = routeHarness(W, BV_C.default);
const IN_TODAY = "2026-09-24";
{
  const s0 = await HV.run({ dryRun: true });
  const wt = await workerTokens(W, BV_W.default);
  const tok = targetsTok(s0, BVK);
  ok("E1 scan: units = the brands of each account's EXACT live brand-view-brands row (IN1: Acme / Beta / Zeta, IN2: Acme, IN3: none -> units-empty), each bound at marketplaceToday('IN') and STALE",
    JSON.stringify(recOf(s0, "IN1").units.map((u) => u.targetId)) === JSON.stringify(["Acme", "Beta", "Zeta"].map((b) => BV.brandViewScopeId("IN1", b)))
    && recOf(s0, "IN1").units.every((u) => u.targetAsOf === IN_TODAY && u.liveAccountId === u.targetId && JSON.stringify(u.ownerAccountIds) === JSON.stringify(["IN1"]) && /^[0-9a-f]{12}$/.test(u.unitKey) && u.reports[BVK].state === RS.ST)
    && recOf(s0, "IN2").units.length === 1 && recOf(s0, "IN3").unitsReason === SDR.UNITS_EMPTY_REASON && marketplaceToday("IN", new Date(W.now())) === IN_TODAY);
  ok("E1 the CLI TARGETS v2 tok == the WORKER's own evidence compose token for every account ('bv1:' + sha256)", ["IN1", "IN2", "IN3"].every((a) => tok.get(a) === wt.get(a).token && /^bv1:[0-9a-f]{64}$/.test(tok.get(a))));
  ok("E1 worker side: identityAsOf(target) is the browser's marketplaceToday(directory country); the tier-1 live-row scopes are the exact directory row / the owner's LIKE-escaped scope-id prefix",
    bvWorker.identityAsOf("IN1", { now: new Date(W.now()), directory: W.directory }) === IN_TODAY && bvWorker.identityAsOf("NOPE", { now: new Date(W.now()), directory: W.directory }) === null
    && JSON.stringify(bvbWorker.tier1.liveRowScope("IN1")) === JSON.stringify({ reportKey: BVB, accountIdEq: "IN1" })
    && JSON.stringify(bvWorker.tier1.liveRowScope("a_1%")) === JSON.stringify({ reportKey: BVK, accountIdLike: "brand-view:a\\_1\\%::%" }));
  const hydBefore = W.restCount("getLatestReportSnapshotHydrated:brand-sales:");
  const restMark = W.rest.length; // WP10: the brand-view-brands route (section D) hydrates brand-sales too -- count THIS pass only
  const writesBefore = W.writes();
  const s1 = await HV.run();
  ok("E2 live pass: Acme + Zeta (IN1) and Acme (IN2) publish (READBACK_VERIFIED) through the REAL publisher; each unit its own cycle / job / shadow",
    bvState(s1, "IN1", "Acme").state === RS.RV && bvState(s1, "IN1", "Zeta").state === RS.RV && bvState(s1, "IN2", "Acme").state === RS.RV && s1.counts.targetsPublished === 3 && W.writes() > writesBefore);
  ok("E3 units ISOLATED: Beta (a directory brand only fba-plan records -- NO order value) DEFERS TYPED 'brand-not-sold' (the builder's own predicate, pre-checked; never the generic 'brand-view-build-failed'), leaving the other brands published",
    bvState(s1, "IN1", "Beta").state === RS.DD && /(^|:)brand-not-sold$/.test(S(bvState(s1, "IN1", "Beta").reason)) && !/build-failed/.test(S(bvState(s1, "IN1", "Beta").reason)) && !bvLive(W, "IN1", "Beta", IN_TODAY));
  ok("E4 memo: brand-sales is hydrated ONCE per account across its N brand units (IN1: 3 units -> 1 hydration; IN2: 1)", W.restCount("getLatestReportSnapshotHydrated:brand-sales:") - hydBefore === 2
    && W.rest.slice(restMark).filter((x) => x === "getLatestReportSnapshotHydrated:brand-sales:IN1").length === 1);
  const acme = bvLive(W, "IN1", "Acme", IN_TODAY);
  ok("E5 the live row: account = brandViewScopeId(owner, brand), identity { accountId: owner, brand, asOf } (version brand-view-account-scoped-v2), payload scoped to the owner + brand + asOf",
    !!acme && acme.account_id === BV.brandViewScopeId("IN1", "Acme") && acme.params.accountId === "IN1" && acme.params.brand === "Acme" && acme.params.asOf === IN_TODAY
    && acme.params.reportVersion === BV.BRAND_VIEW_VERSION && acme.payload.scope === "account" && acme.payload.accountId === "IN1" && acme.payload.brand === "Acme" && acme.payload.asOf === IN_TODAY
    && acme.params.evidenceToken === tok.get("IN1") && /^[0-9a-f]{40}$/.test(acme.params.depFingerprint));
  ok("E5 ... built from the durable directory account (name / country) and the SELECTED available inventory compact (not the newer placeholder)",
    acme.payload.accountName === "India One" && acme.payload.accountCountry === "IN" && acme.payload.coverage.inventoryDate === "2026-09-22");
  const served = await SEL.selectExactThenLatest({ reportKey: BVK, accountId: BV.brandViewScopeId("IN1", "Acme"), reportVersion: BV.BRAND_VIEW_VERSION, params: { accountId: "IN1", brand: "Acme", asOf: IN_TODAY }, readers: { getReportSnapshot: W.sbNs.getReportSnapshot, getLatestReportSnapshot: W.sbNs.getLatestReportSnapshot }, computeHash: paramsHashFor });
  ok("E5 the served selector (exact at the browser's { accountId, brand, asOf }, else the scope id's latest row) returns EXACTLY the published row", !!served.row && served.row.id === acme.id && served.via === "exact");
  const s2 = await HV.run({ dryRun: true });
  ok("E5 re-scan: the published units are PUBLICATION_NOT_REQUIRED (binding + served-row check); Beta stays STALE (nothing to promote)",
    bvState(s2, "IN1", "Acme").state === RS.NR && bvState(s2, "IN1", "Zeta").state === RS.NR && bvState(s2, "IN2", "Acme").state === RS.NR && bvState(s2, "IN1", "Beta").state === RS.ST);
  const casBefore = W.n.liveCas;
  const s3 = await HV.run({ accounts: ["IN2"] });
  ok("E5 a live pass over a current unit performs ZERO writes (no CAS)", s3.counts.targetsAlreadyCurrent === 1 && W.n.liveCas === casBefore);
}

// ---- C. writer / serve fingerprint parity (the REAL api/datadoe.js readers, source-extracted) ------------------------
function extractFunction(text, name) {
  const start = text.indexOf("function " + name + "(");
  if (start < 0) return null;
  let i = text.indexOf("{", text.indexOf(")", start));
  let depth = 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === "\"" || c === "'" || c === "`") { const q = c; i++; while (i < text.length && text[i] !== q) { if (text[i] === "\\") i++; i++; } continue; }
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && text[i + 1] === "*") { i = text.indexOf("*/", i + 2) + 1; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}
function serveReaders(w, { org = ORG } = {}) {
  const api = src("api/datadoe.js");
  const parts = ["primaryOrgFingerprintOrNull", "campaignMappingsReader", "brandViewDepFingerprintReaders"].map((nm) => extractFunction(api, nm));
  if (parts.some((p) => !p)) return null;
  const inject = {
    getDataDoeConnections: () => (org ? [{ id: "primary", apiKey: "k", organizationFingerprint: org }] : []), organizationFingerprint: () => org,
    getCampaignBrandMappings: w.sbNs.getCampaignBrandMappings, getLatestReportSnapshotMeta: w.sbNs.getLatestReportSnapshotMeta, getDailyAdsCoverage: w.sbNs.getDailyAdsCoverage,
    getSourceSnapshot: w.sbNs.getSourceSnapshot, getInventorySnapshotCandidates: w.sbNs.getInventorySnapshotCandidates,
    ACTIVE_ADS_SOURCE_KEY, campaignMappingRevision, BRAND_INVENTORY_SNAPSHOT_KEY: BV.BRAND_INVENTORY_SNAPSHOT_KEY, BRAND_INVENTORY_REPORT_VERSION: BV.BRAND_INVENTORY_REPORT_VERSION,
    selectAuthoritativeInventorySnapshot: BV.selectAuthoritativeInventorySnapshot,
    makeBrandViewDepReaders: RD.makeBrandViewDepReaders, makeCampaignMappingsReader: RD.makeCampaignMappingsReader, makeCatalogValidatedAtReader: RD.makeCatalogValidatedAtReader,
  };
  // eslint-disable-next-line no-new-func
  const factory = new Function(...Object.keys(inject), parts.join("\n") + "\nreturn brandViewDepFingerprintReaders;");
  return factory(...Object.values(inject))();
}
{
  const readers = serveReaders(W);
  ok("C1 the serve's brandViewDepFingerprintReaders (+ its org / mapping helpers) is extracted from api/datadoe.js and runs over the fake supabase", !!readers && typeof readers.getSnapshotMeta === "function" && typeof readers.getInventorySelected === "function");
  const serveFp = await FPM.collectBrandViewDependencyFingerprint({ scope: "account", brand: "Acme", accountIds: ["IN1"], reportVersion: BV.BRAND_VIEW_VERSION, readers });
  const routeRt = BV_C.default.build(routeDeps(W));
  const unit = { unitKey: BV_C.brandUnitKey("Acme"), targetId: BV.brandViewScopeId("IN1", "Acme"), liveAccountId: BV.brandViewScopeId("IN1", "Acme"), ownerAccountIds: ["IN1"], targetAsOf: IN_TODAY, reportKeys: [BVK] };
  const b = await routeRt.resolveBundle(unit, { strict: true });
  ok("C2 writer / serve parity: the route's params.depFingerprint (extracted readers) == the serve's fingerprint (api/datadoe.js readers) over the SAME fake supabase",
    b.eligible === true && b.depFingerprint === serveFp && bvLive(W, "IN1", "Acme", IN_TODAY).params.depFingerprint === serveFp);
  const direct = await FPM.collectBrandViewDependencyFingerprint({ scope: "account", brand: "Acme", accountIds: ["IN1"], reportVersion: BV.BRAND_VIEW_VERSION, readers: RD.makeBrandViewDepReaders({ orgFp: ORG, readers: { getSnapshotMeta: W.sbNs.getLatestReportSnapshotMeta, getAdsCoverageState: W.sbNs.getDailyAdsCoverage, getMappings: W.sbNs.getCampaignBrandMappings, getSourceSnap: W.sbNs.getSourceSnapshot, getInventoryCandidates: W.sbNs.getInventorySnapshotCandidates } }) });
  const noOrgServe = await FPM.collectBrandViewDependencyFingerprint({ scope: "account", brand: "Acme", accountIds: ["IN1"], reportVersion: BV.BRAND_VIEW_VERSION, readers: serveReaders(W, { org: null }) });
  const noOrgDirect = await FPM.collectBrandViewDependencyFingerprint({ scope: "account", brand: "Acme", accountIds: ["IN1"], reportVersion: BV.BRAND_VIEW_VERSION, readers: RD.makeBrandViewDepReaders({ orgFp: null, readers: { getSnapshotMeta: W.sbNs.getLatestReportSnapshotMeta, getAdsCoverageState: W.sbNs.getDailyAdsCoverage, getMappings: W.sbNs.getCampaignBrandMappings, getSourceSnap: W.sbNs.getSourceSnapshot, getInventoryCandidates: W.sbNs.getInventorySnapshotCandidates } }) });
  ok("C2 ... and the extracted factory agrees with the serve readers with AND without a primary org (mapping / catalog absent)", direct === serveFp && noOrgServe === noOrgDirect && noOrgServe !== serveFp);
  const res = { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(x) { this.body = x; return this; } };
  await serveSharedReport({
    res, refresh: false, reportKey: BVK, reportVersion: BV.BRAND_VIEW_VERSION, accountId: BV.brandViewScopeId("IN1", "Acme"), params: { accountId: "IN1", brand: "Acme", asOf: IN_TODAY },
    userId: "u", label: "Brand View", contributingProvenanceAt: null, contributingDepFingerprint: serveFp,
    readers: { getReportSnapshot: W.sbNs.getReportSnapshot, getLatestReportSnapshot: W.sbNs.getLatestReportSnapshot, getLatestReportSnapshotForScope: W.sbNs.getLatestReportSnapshotForScope },
  });
  ok("C3 the REAL serveSharedReport serves the route-published row NOT 'updating' (stored depFingerprint == the serve's) -- the 'updating' semantics are unchanged with NO serve change",
    res.statusCode === 200 && !res.body.updating && res.body.brand === "Acme" && res.body.accountId === "IN1");
}
{
  // E6: an Ads contentRev-only change (same windows / latest date / status) re-publishes.
  const before = bvLive(W, "IN1", "Acme", IN_TODAY);
  W.adsState.set("IN1|" + ACTIVE_ADS_SOURCE_KEY, { last_status: "succeeded", latest_metric_date: "2026-09-22", content_rev: "rev-2" });
  const s0 = await HV.run({ dryRun: true, accounts: ["IN1"] });
  ok("E6 an Ads content_rev-only change turns the IN1 units STALE (the token binds the Ads content revision)", bvState(s0, "IN1", "Acme").state === RS.ST && bvState(s0, "IN1", "Zeta").state === RS.ST);
  const s1 = await HV.run({ accounts: ["IN1"] });
  const after = bvLive(W, "IN1", "Acme", IN_TODAY);
  ok("E6 ... and re-publishes them: the live row carries the new evidence token + a new legacy depFingerprint (the serve's 'updating' flips back to fresh)",
    bvState(s1, "IN1", "Acme").state === RS.RV && bvState(s1, "IN1", "Zeta").state === RS.RV && after.params.evidenceToken !== before.params.evidenceToken
    && after.params.depFingerprint !== before.params.depFingerprint && Date.parse(after.source_refreshed_at) > Date.parse(before.source_refreshed_at)
    && after.params.depFingerprint === await FPM.collectBrandViewDependencyFingerprint({ scope: "account", brand: "Acme", accountIds: ["IN1"], reportVersion: BV.BRAND_VIEW_VERSION, readers: serveReaders(W) }));
  // E7: a campaign->brand mapping edit re-publishes.
  const m = W.mappings[0];
  m.canonical_brand_key = "zeta"; m.brand_display_name = "Zeta"; m.updated_at = pgrest(W.tick());
  const s2 = await HV.run({ dryRun: true, accounts: ["IN1"] });
  const s3 = await HV.run({ accounts: ["IN1"] });
  const after2 = bvLive(W, "IN1", "Acme", IN_TODAY);
  ok("E7 a campaign->brand mapping edit turns the units STALE and re-publishes them with a new token + depFingerprint", bvState(s2, "IN1", "Acme").state === RS.ST && bvState(s3, "IN1", "Acme").state === RS.RV
    && after2.params.evidenceToken !== after.params.evidenceToken && after2.params.depFingerprint !== after.params.depFingerprint);
  // A mapping ADDED for another marketplace (count changes, content identity changes) is also caught.
  W.mappings.push({ organization_fingerprint: ORG, connection_id: "primary", account_id: "IN1", marketplace: "IN", ads_profile_id: "", ad_campaign_id: "c-9", canonical_brand_key: "acme", brand_display_name: "Acme", mapping_source: "BULK", updated_at: pgrest(W.tick()) });
  const s4 = await HV.run({ dryRun: true, accounts: ["IN1"] });
  ok("E7 a mapping ADDED also turns the units STALE (row count + newest updated_at + content md5 in the token)", bvState(s4, "IN1", "Acme").state === RS.ST);
  await HV.run({ accounts: ["IN1"] });
}
{
  // E8: a local-midnight roll BEFORE the first write defers 'asof-rolled' (zero writes), then the next pass publishes
  // the NEW identity.
  const w = makeWorld(); seed(w);
  await routeHarness(w, BVB_C.default).run({ accounts: ["IN1"] });
  w.setClock(Date.UTC(2026, 8, 24, 18, 29, 0)); // 23:59 IST
  const rollAt = Date.UTC(2026, 8, 24, 18, 31, 0); // 00:01 IST -> IN today = 2026-09-25
  const hv = routeHarness(w, BV_C.default, { wrap: (rt) => ({ ...rt, derive: async (...a) => { const r = await rt.derive(...a); if (w.now() < rollAt) w.setClock(rollAt); return r; } }) });
  const writes0 = w.writes();
  const s1 = await hv.run({ accounts: ["IN1"] });
  const acmeUnit = bvState(s1, "IN1", "Acme");
  ok("E8 the marketplace day rolls DURING the unit's derive (between the two resolves): the prepare defers 'asof-rolled' with ZERO cycle / job / shadow / live writes",
    acmeUnit.state === RS.DD && acmeUnit.reason === "asof-rolled" && w.writes() === writes0 && !bvLive(w, "IN1", "Acme", IN_TODAY) && !bvLive(w, "IN1", "Acme", "2026-09-25"));
  const s2 = await routeHarness(w, BV_C.default).run({ accounts: ["IN1"] });
  const fresh = bvLive(w, "IN1", "Acme", "2026-09-25");
  ok("E8 ... then the next pass binds the NEW identity as-of (the token changed with the day) and publishes it", bvState(s2, "IN1", "Acme").state === RS.RV && recOf(s2, "IN1").units.every((u) => u.targetAsOf === "2026-09-25")
    && !!fresh && fresh.params.asOf === "2026-09-25" && fresh.payload.asOf === "2026-09-25");
  // A roll between the scan and the prepare (the unit is bound at yesterday) is refused at the live identity: 'asof-rolled'.
  const w2 = makeWorld(); seed(w2);
  await routeHarness(w2, BVB_C.default).run({ accounts: ["IN1"] });
  const rt2 = BV_C.default.build(routeDeps(w2));
  const rel2 = routeHarness(w2, BV_C.default).release;
  const ev2 = await rt2.readScopeEvidence({ scope: ["IN1"] });
  const rev2 = REL.normalizeRouteRevision(rt2.computeRevision({ accountId: "IN1", evidence: ev2.perAccount.get("IN1") }));
  const unit2 = (await rt2.expandUnits({ accountId: "IN1", evidence: ev2.perAccount.get("IN1") })).find((u) => u.unitKey === BV_C.brandUnitKey("Acme"));
  w2.setClock(Date.UTC(2026, 8, 24, 18, 45, 0));
  const w2before = w2.writes();
  const p2 = await rel2.prepareForUnit({ unit: unit2, revision: rev2, epoch: EPOCH, region: REGION, bucket: REGION, accountId: "IN1" });
  ok("E8 a roll between the SCAN and the prepare (unit bound at yesterday, today's derive) is never written: typed 'asof-rolled', zero writes", p2.ok === false && p2.reason === "asof-rolled" && w2.writes() === w2before);
}
{
  // E9: strict reads -- a failure DEFERS the unit (never a degraded / zero-filled view), zero writes.
  const w = makeWorld(); seed(w);
  await routeHarness(w, BVB_C.default).run({ accounts: ["IN1"] });
  const hv = routeHarness(w, BV_C.default);
  const cases = [
    ["getCampaignBrandMappings", /fingerprint-read-failed:mapping|read-failed:mapping/],
    ["getDailyAdsCoverage", /fingerprint-read-failed:ads/],
    ["getSourceSnapshot", /fingerprint-read-failed:catalog/],
    ["getAdsDailySourceRows", /read-failed:ads-rows/],
  ];
  const results = [];
  for (const [fn, re] of cases) {
    w.restFail.add(fn);
    const s = await hv.run({ accounts: ["IN1"] });
    w.restFail.delete(fn);
    const e = bvState(s, "IN1", "Acme");
    results.push(e && e.state === RS.DD && re.test(S(e.reason)) && !bvLive(w, "IN1", "Acme", IN_TODAY));
  }
  ok("E9 a failing mapping / Ads-coverage / catalog / Ads-row read DEFERS the unit (typed reason) -- never an empty mapping, a zero ad spend or a stale fingerprint", results.every(Boolean) && w.n.liveWrite === 1);
  // An out-of-line brand-sales payload whose storage object cannot be read: DEFER (the serve would degrade to the stub).
  const bs = [...w.snaps.values()].find((r) => r.report_key === "brand-sales" && r.account_id === "IN1");
  w.storage.set("snap/IN1/brand-sales.json", bs.payload);
  w.putRow({ reportKey: "brand-sales", accountId: "IN1", params: bs.params, payload: null, storagePath: "snap/IN1/brand-sales.json" });
  w.storageFail.add("snap/IN1/brand-sales.json");
  const hv2 = routeHarness(w, BV_C.default);
  const s5 = await hv2.run({ accounts: ["IN1"] });
  ok("E9 an out-of-line brand-sales payload that cannot be hydrated DEFERS every unit ('hydrate-failed:brand-sales'), never built from the inline stub", ["Acme", "Zeta"].every((b) => bvState(s5, "IN1", b).state === RS.DD && S(bvState(s5, "IN1", b).reason).includes("hydrate-failed:brand-sales")));
  w.storageFail.delete("snap/IN1/brand-sales.json");
  const hv3 = routeHarness(w, BV_C.default);
  const s6 = await hv3.run({ accounts: ["IN1"] });
  ok("E9 ... once the storage object reads, the SAME out-of-line row hydrates (storage-first) and every sold brand publishes", bvState(s6, "IN1", "Acme").state === RS.RV && bvState(s6, "IN1", "Zeta").state === RS.RV && !!bvLive(w, "IN1", "Acme", IN_TODAY));
  // No brand-view-brands row yet: the brand-view target is a typed deferral (never an empty unit set).
  const w3 = makeWorld(); seed(w3);
  const s7 = await routeHarness(w3, BV_C.default).run({ dryRun: true, accounts: ["IN1"] });
  ok("E9 an account whose brand-view-brands row is not yet published DEFERS typed ('brand-directory-unpublished'), zero units, zero writes", recOf(s7, "IN1").reports[BVK].state === RS.DP && recOf(s7, "IN1").reports[BVK].reason === "brand-directory-unpublished" && w3.writes() === 0);
}
{
  // E10: verify-exact re-resolves the bundle and requires the job's manifest token (the published content identity).
  const hvx = routeHarness(W, BV_C.default, { verifyExact: true });
  const s = await hvx.run({ dryRun: true, accounts: ["IN1", "IN2"] });
  ok("E10 --verify-exact: every published unit is PUBLICATION_NOT_REQUIRED with its manifest token in the job lineage (Beta stays STALE)", bvState(s, "IN1", "Acme").state === RS.NR && bvState(s, "IN1", "Zeta").state === RS.NR && bvState(s, "IN2", "Acme").state === RS.NR && bvState(s, "IN1", "Beta").state === RS.ST);
  const hbx = routeHarness(W, BVB_C.default, { verifyExact: true });
  const s2 = await hbx.run({ dryRun: true });
  ok("E10 --verify-exact: every brand-view-brands directory is PUBLICATION_NOT_REQUIRED", ["IN1", "IN2", "IN3"].every((a) => recOf(s2, a).reports[BVB].state === RS.NR));
}
{
  // E11 (round 3 P2b -- the former Ads-rows residual): the durable Ads ROWS a brand-view build reads are bound by the
  // EXACT 'adr1:' content digest (evidence SQL) and strictly cross-checked at the derive's REST read.
  const w = makeWorld(); seed(w);
  const adRow = (date, dim, ua, spend) => ({ account_id: "IN1", source_key: ACTIVE_ADS_SOURCE_KEY, metric_date: date, marketplace_country_code: "IN", campaign_id: "c-1", campaign_type: "SP", dimension_key: dim, child_asin: "", targeting_id: "", currency: "INR", dimensions: { ad_campaign_id: "c-1", marketplace_country_code: "IN" }, metrics: { ad_spend: spend, ad_sales: 1 }, source_refreshed_at: ua, updated_at: ua });
  w.adsRows.push(adRow("2026-09-21", "c1-a", "2026-09-23T01:10:00+00:00", 5), adRow("2026-09-21", "c1-b", "2026-09-23T02:00:00+00:00", 7));
  await routeHarness(w, BVB_C.default).run({ accounts: ["IN1"] });
  const hv = routeHarness(w, BV_C.default);
  const spendOn = (p, d) => ((p && p.series) || []).filter((r) => r.d === d && r.c === "IN").map((r) => r.a)[0];
  const evOf = async () => (await BV_C.default.build(routeDeps(w)).readScopeEvidence({ scope: ["IN1"] })).perAccount.get("IN1");
  const s0 = await hv.run({ accounts: ["IN1"] });
  const acme0 = bvLive(w, "IN1", "Acme", IN_TODAY);
  const ev0 = await evOf();
  ok("E11 setup: Acme publishes with IN1's attributed Ads spend (5 + 7 on 2026-09-21); the evidence binds the rows' EXACT digest (JS twin == the SQL emulation interpreted from the SQL text) over the IN build window",
    bvState(s0, "IN1", "Acme").state === RS.RV && spendOn(acme0.payload, "2026-09-21") === 12
    && JSON.stringify(ev0.adsRows) === JSON.stringify({ from: "2026-04-01", to: IN_TODAY, digest: RD.adsRowsDigest(w.adsRows) }) && ev0.adsRows.digest === pgAdsRowsDigest(w.adsRows) && /^adr1:2:\d+:\d+$/.test(ev0.adsRows.digest));
  const scan0 = await hv.run({ dryRun: true, accounts: ["IN1"] });
  ok("E11 worker token == CLI token with Ads rows present (the worker compose runs the SAME account-scoped ads_daily partials statement + compose at the SAME ctx.now)",
    (await workerTokens(w, BV_W.default)).get("IN1").token === targetsTok(scan0, BVK).get("IN1") && bvState(scan0, "IN1", "Acme").state === RS.NR);
  // The Q1a case on brand-view: the OLDER row is corrected by a transaction whose now() (01:30) predates the newest
  // updated_at (02:00): content_rev, coverage windows and latest_metric_date are all unchanged.
  const cA = w.adsRows.find((r) => r.dimension_key === "c1-a");
  cA.metrics = { ad_spend: 50, ad_sales: 1 }; cA.updated_at = "2026-09-23T01:30:00+00:00";
  const ev1 = await evOf();
  const s1 = await hv.run({ dryRun: true, accounts: ["IN1"] });
  ok("E11 (P2b) an Ads UPDATE whose updated_at is below the newest (Ads state + windows unchanged) moves the digest and bv1 -> Acme + Zeta STALE (never current)",
    JSON.stringify(ev1.ads) === JSON.stringify(ev0.ads) && ev1.adsRows.digest !== ev0.adsRows.digest && ev1.token !== ev0.token
    && targetsTok(s1, BVK).get("IN1") === ev1.token && bvState(s1, "IN1", "Acme").state === RS.ST && bvState(s1, "IN1", "Zeta").state === RS.ST);
  const s2 = await hv.run({ accounts: ["IN1"] });
  const acme1 = bvLive(w, "IN1", "Acme", IN_TODAY);
  ok("E11 ... the live pass re-publishes and the served Acme payload carries the corrected spend (57); a re-scan is current",
    bvState(s2, "IN1", "Acme").state === RS.RV && spendOn(acme1.payload, "2026-09-21") === 57 && acme1.params.evidenceToken === ev1.token
    && bvState(await hv.run({ dryRun: true, accounts: ["IN1"] }), "IN1", "Acme").state === RS.NR);
  // A row OUTSIDE the build window (2026-03-31 < 2026-04-01) is not read by the build: token unchanged.
  w.adsRows.push(adRow("2026-03-31", "c1-old", "2026-09-23T05:00:00+00:00", 99));
  const s3 = await hv.run({ dryRun: true, accounts: ["IN1"] });
  ok("E11 a row OUTSIDE the build window leaves the digest + token unchanged (the unit stays current)", (await evOf()).token === ev1.token && bvState(s3, "IN1", "Acme").state === RS.NR);
  // An edit BETWEEN the evidence read and the build's REST read: the strict cross-check catches it.
  let fired = false;
  w.hooks.onAdsRows = (acct) => { if (!fired && acct === "IN1") { fired = true; cA.metrics = { ad_spend: 60, ad_sales: 1 }; cA.updated_at = "2026-09-23T03:00:00+00:00"; } };
  w.adsState.set("IN1|" + ACTIVE_ADS_SOURCE_KEY, { last_status: "succeeded", latest_metric_date: "2026-09-22", content_rev: "rev-9" }); // arm the units
  const live0 = w.n.liveWrite;
  const s4 = await hv.run({ accounts: ["IN1"] });
  w.hooks.onAdsRows = null;
  const reasons = ["Acme", "Zeta"].map((b) => S(bvState(s4, "IN1", b) && bvState(s4, "IN1", b).reason));
  ok("E11 an Ads row edited between the evidence read and the build read DEFERS typed 'evidence-advanced:ads-rows' (the unit that read it; the next unit's entry sees the advanced revision) -- zero live writes, the LKG spend (57) kept",
    fired && reasons.some((r) => /(^|:)evidence-advanced:ads-rows$/.test(r)) && ["Acme", "Zeta"].every((b) => bvState(s4, "IN1", b).state === RS.DD)
    && w.n.liveWrite === live0 && spendOn(bvLive(w, "IN1", "Acme", IN_TODAY).payload, "2026-09-21") === 57);
  const s5 = await hv.run({ accounts: ["IN1"] });
  ok("E11 ... the next pass binds the new rows and publishes them (spend 60 + 7)", bvState(s5, "IN1", "Acme").state === RS.RV && spendOn(bvLive(w, "IN1", "Acme", IN_TODAY).payload, "2026-09-21") === 67);
  // Pure compose contract: the window echo + the one-row-per-account LEFT JOIN.
  const ctx = { accountIds: ["IN1"], directory: w.directory, organizationFingerprint: ORG };
  const rowsAt = async (now) => { const r = {}; for (const q of BV_W.default.evidence.sql) r[q.name] = await w.pgReadOnly(q.text, q.params({ ...ctx, now })); return r; };
  const beforeRoll = await rowsAt(Date.UTC(2026, 8, 24, 18, 29)); // IN 23:59 -> 2026-09-24
  const split = BV_W.composeBrandViewEvidence(beforeRoll, { ...ctx, now: Date.UTC(2026, 8, 24, 18, 31) }).get("IN1"); // IN 2026-09-25
  const missing = BV_W.composeBrandViewEvidence({ ...beforeRoll, ads_daily: [] }, { ...ctx, now: Date.UTC(2026, 8, 24, 18, 29) }).get("IN1");
  const wSplit = BV_W.default.evidence.compose(beforeRoll, { ...ctx, now: Date.UTC(2026, 8, 24, 18, 31) }).get("IN1");
  ok("E11 a params / compose clock split across the IN midnight fails closed typed 'ads-rows-window-mismatch' (the window lies outside the SCANNED range the sentinel echoes; CLI revision ineligible; worker token null + the SAME reason); absent / sentinel-less partials are 'ads-rows-evidence-missing'",
    BV_C.brandViewRevision(split).eligible === false && BV_C.brandViewRevision(split).reason === "ads-rows-window-mismatch" && split.adsRows === null
    && wSplit.token === null && wSplit.reason === "ads-rows-window-mismatch" && BV_C.brandViewRevision(missing).reason === "ads-rows-evidence-missing");
  // Tier-1 performance: the evidence reads the SHARED per-day partials (ONE frozen statement object for both Brand View
  // routes) instead of the per-region ads_rows LEFT JOIN, which stays exported as the equivalence reference.
  const adsStmt = BV_W.default.evidence.sql.find((q) => q.name === "ads_daily");
  const region2 = { ...ctx, accountIds: ["IN2"], now: W.now() };
  ok("E11 the evidence reads ADS_DAILY_SCOPED_STATEMENT: ACCOUNT-SCOPED by default (params [ACTIVE source, union from, union to, the evidence accounts]; the index-driven twin) with the unscoped portfolio statement as its sweep-mode sharedVariant (region-independent params); no per-region ads_rows; ADS_ROWS_SQL kept as the reference (SHARED digest fragment VERBATIM, LEFT JOIN)",
    !!adsStmt && adsStmt === ADE.ADS_DAILY_SCOPED_STATEMENT && adsStmt.text === RD.ADS_DAILY_ACCOUNT_PARTIALS_SQL && RC.isReadOnlyEvidenceSql(adsStmt.text) && adsStmt.shared !== true
    && adsStmt.sharedVariant === ADE.ADS_DAILY_STATEMENT && adsStmt.sharedVariant.shared === true && adsStmt.sharedVariant.text === RD.ADS_DAILY_PARTIALS_SQL
    && !BV_W.default.evidence.sql.some((q) => q.name === "ads_rows")
    && JSON.stringify(adsStmt.params(region2).slice(0, 3)) === JSON.stringify(adsStmt.sharedVariant.params(region2)) && JSON.stringify(adsStmt.params(region2)[3]) === JSON.stringify(["IN2"])
    && JSON.stringify(adsStmt.sharedVariant.params({ ...ctx, accountIds: ["IN1", "IN2", "NOPE"], now: W.now() })) === JSON.stringify(adsStmt.sharedVariant.params(region2))
    && adsStmt.params(region2)[0] === ACTIVE_ADS_SOURCE_KEY && adsStmt.params(region2)[1] <= "2026-04-01" && adsStmt.params(region2)[2] >= IN_TODAY
    && BV_W.ADS_ROWS_SQL.includes(" " + RD.adsRowsDigestSql("r.") + " as rows_digest from ") && RC.isReadOnlyEvidenceSql(BV_W.ADS_ROWS_SQL));
  // P1 (tier-1 review): the route CLI's reads (scope, b1 / b2, the publish-time token, verify-exact) and the worker's
  // reads WITHOUT a sweep cache are the ACCOUNT-SCOPED twin -- never the unscoped all-accounts scan -- and a per-unit read
  // carries exactly the unit's account.
  ok("E11 (scope) every Ads partials read so far (CLI runs incl. publish + verify, worker evaluations without a sweep cache) is ACCOUNT-SCOPED; the CLI's per-unit reads carry exactly ['IN1']",
    w.adsReads.length > 0 && w.adsReads.every((r) => r.scoped === true) && w.adsReads.some((r) => JSON.stringify(r.accounts) === JSON.stringify(["IN1"])));
  const sweepCache = new Map();
  const before = w.adsReads.length;
  const tScoped = (await workerTokens(w, BV_W.default)).get("IN1").token;
  const tSweep = (await workerTokensSweep(w, BV_W.default, sweepCache)).get("IN1").token;
  const tSweep2 = (await workerTokensSweep(w, BV_W.default, sweepCache)).get("IN1").token;
  const sweepReads = w.adsReads.slice(before).filter((r) => r.scoped === false).length;
  ok("E11 (sweep) sweep mode reads the UNSCOPED shared variant ONCE per cache (a second evaluation is a cache hit) and yields the BYTE-IDENTICAL token of the scoped evaluation",
    tScoped != null && tSweep === tScoped && tSweep2 === tScoped && sweepReads === 1);
  ok("E11 zero network", net.calls.length === 0);
}
// =====================================================================================================================
// F. WP8 verifier fixes: P2-1 ambiguity-vs-absent token + the compose contract, P2-2 an out-of-line directory source,
//    P2-3 a directory brand that is not sold, P3-1 worker-hook argument shapes, P3-2 the pure paramsHashFor leaf,
//    P3-3 the documented Ads-rows residual.
// =====================================================================================================================
const FT1 = "2026-09-24T01:00:00.000000Z";
const FT2 = "2026-09-24T02:00:00.000000Z";
const evRow = (rk, a, id, upd, v = "v1", extra = {}) => ({ report_key: rk, account_id: a, id, params_hash: "h-" + id, source_refreshed_at: upd, updated_at: upd, report_version: v, inv_available: null, inv_date: null, inv_snapshot_date: null, inv_ibbc_type: null, ...extra });
const sha256hex = (v) => createHash("sha256").update(String(v)).digest("hex");
{
  // F1 (P2-1) brand-view-brands.
  const DIR1 = new Map([["A", { country: "IN" }]]);
  const base = [evRow("brand-sales", "A", "bs1", FT1), evRow("fba-plan", "A", "fp1", FT1)];
  const tieRows = [...base, evRow("sku-pl", "A", "sp2", FT2), evRow("sku-pl", "A", "sp1", FT2)];
  const tie2Rows = [...base, evRow("sku-pl", "A", "sp3", FT2), evRow("sku-pl", "A", "sp4", FT2)];
  const cev = (rows) => BVB_W.composeBrandViewBrandsEvidence({ latest_rows: rows }, { accountIds: ["A"] }).get("A");
  const evAbsent = cev(base); const evTie = cev(tieRows); const evTie2 = cev(tie2Rows);
  ok("F1 (P2-1) brand-view-brands: a TIED sku-pl latest row never hashes like an ABSENT one (nor like another tie set); the tied ids are bound sorted, the identity stays null",
    evAbsent.token !== evTie.token && evTie.token !== evTie2.token && evAbsent.token !== evTie2.token
    && JSON.stringify(evTie.ambiguousIds) === JSON.stringify({ "sku-pl": ["sp1", "sp2"] }) && evTie.identities["sku-pl"] === null && JSON.stringify(evTie.ambiguous) === JSON.stringify(["sku-pl"]));
  // Round 3 P3-1: bb1 also binds the derivation-code identity (so the pre-fix material + { code } -- one deliberate
  // re-publish of every directory when this ships; nothing is live on the route yet).
  const expectBb = (ev) => "bb1:" + sha256hex(B.stableJson({ a: ev.accountId, r: BVB_W.BRAND_VIEW_BRANDS_EVIDENCE_REPORT_KEYS.map((rk) => [rk, ev.identities[rk] || null]), code: { ...BVB_W.BRAND_VIEW_BRANDS_CODE_IDENTITY } }));
  ok("F1 ... an account WITHOUT ambiguity hashes EXACTLY the documented material (the pre-fix material + the derivation-code identity; the tie binding adds nothing)", evAbsent.token === expectBb(evAbsent) && BVB_W.brandViewBrandsToken("A", evAbsent.identities) === evAbsent.token);
  const wc = (rows, ctx) => BVB_W.default.evidence.compose({ latest_rows: rows }, ctx);
  const wAbsent = wc(base, { accountIds: ["A"], directory: DIR1 }).get("A");
  const wTie = wc(tieRows, { accountIds: ["A"], directory: DIR1 }).get("A");
  ok("F1 worker compose (the returns-v3 contract): eligible -> { token == the CLI revision token, owners, region, alerts [] }; TIED -> { token: null, reason } with the CLI revision's OWN reason 'latest-row-ambiguous:sku-pl'",
    wAbsent.token === BVB_C.brandViewBrandsRevision(evAbsent).evidenceToken && wAbsent.region === REGION && JSON.stringify(wAbsent.owners) === JSON.stringify(["A"])
    && Array.isArray(wAbsent.alerts) && wAbsent.alerts.length === 0 && !("reason" in wAbsent)
    && wTie.token === null && wTie.reason === "latest-row-ambiguous:sku-pl" && wTie.reason === BVB_C.brandViewBrandsRevision(evTie).reason
    && wTie.region === REGION && JSON.stringify(wTie.owners) === JSON.stringify(["A"]) && Array.isArray(wTie.alerts));
  const unr = wc(base, { accountIds: ["A", "B", "C"], directory: new Map([...DIR1, ["B", { country: " " }], ["C", { country: "ZZ" }]]) });
  ok("F1 an UNROUTABLE account is { token: null, region: null } typed 'directory-country-missing' / 'directory-region-unassigned' (never a routable token); the routable one is unchanged",
    unr.size === 3 && unr.get("B").token === null && unr.get("B").region === null && unr.get("B").reason === "directory-country-missing"
    && unr.get("C").token === null && unr.get("C").region === null && unr.get("C").reason === "directory-region-unassigned" && unr.get("A").token === wAbsent.token);
}
{
  // F2 (P2-1) brand-view.
  const DIRA = new Map([["A", { country: "IN", name: "Acct A", currency: "INR" }]]);
  const INV_V = BV.BRAND_INVENTORY_REPORT_VERSION;
  const baseRows = () => ({
    latest_rows: [evRow("brand-sales", "A", "bs1", FT1), evRow("fba-plan", "A", "fp1", FT1), evRow("brand-inventory", "A", "bi1", FT1, INV_V, { inv_available: false, inv_date: "2026-09-22", inv_ibbc_type: "array" })],
    inventory_available: [],
    directory_rows: [{ account_id: "A", id: "d1", params_hash: paramsHashFor("brand-view-brands-v1", { accountId: "A" }), source_refreshed_at: FT1, updated_at: FT1, report_version: "brand-view-brands-v1", inline_payload: true, brands: ["Alpha", "Beta"], payload_account_id: "A" }],
    ads_state: [{ account_id: "A", has_state: true, last_status: "succeeded", latest_metric_date: "2026-09-22", content_rev: "r1", windows: "2026-08-01..2026-09-22" }],
    campaign_mapping: [{ account_id: "A", n: 2, max_updated_at: FT1, content_md5: "m1" }],
    product_catalog: [{ organization_fingerprint: ORG, payload_sha: "sha1", validated_at: FT1, source_request_hash: "q" }],
    // The account's Ads-row digest over its IN build window at 2026-09-24 (brandViewAdsWindow: 2026-04-01 .. 2026-09-24):
    // ONE per-day partial inside the window (n 2, lanes 11 / 22 -> 'adr1:2:11:22') + the sentinel echoing the scanned range.
    ads_daily: [
      { account_id: "A", metric_date: "2026-09-22", n: "2", s1: "11", s2: "22", max_ua: "2026-09-23T02:00:00.000000Z", range_from: "2026-04-01", range_to: "2026-09-24" },
      { account_id: null, metric_date: null, n: "0", s1: "0", s2: "0", max_ua: null, range_from: "2026-04-01", range_to: "2026-09-24" },
    ],
  });
  const NOW = Date.UTC(2026, 8, 24, 6, 0, 0);
  const ctx = { accountIds: ["A"], directory: DIRA, organizationFingerprint: ORG, now: NOW };
  const r0 = baseRows();
  const rTie = baseRows(); rTie.latest_rows.push(evRow("sku-pl", "A", "sp1", FT2), evRow("sku-pl", "A", "sp2", FT2));
  const avRow = (id) => evRow("brand-inventory", "A", id, FT2, INV_V, { inv_available: true, inv_date: "2026-09-23", inv_ibbc_type: "array" });
  const rAvTie = baseRows(); rAvTie.inventory_available.push(avRow("ia1"), avRow("ia2"));
  const rOut = baseRows(); rOut.directory_rows[0].inline_payload = false; rOut.directory_rows[0].brands = null;
  const cev = (rows) => BV_W.composeBrandViewEvidence(rows, ctx).get("A");
  const e0 = cev(r0); const eTie = cev(rTie); const eAvTie = cev(rAvTie); const eOut = cev(rOut);
  ok("F2 (P2-1) brand-view: a TIED sku-pl latest row and a TIED available compact never hash like the ABSENT case (tied ids + typed problems are bound)",
    e0.token !== eTie.token && e0.token !== eAvTie.token && eTie.token !== eAvTie.token
    && JSON.stringify(eTie.ambiguousIds) === JSON.stringify({ "sku-pl": ["sp1", "sp2"] }) && JSON.stringify(eAvTie.ambiguousIds) === JSON.stringify({ "brand-inventory-available": ["ia1", "ia2"] })
    && BV_C.brandViewRevision(eTie).reason === "latest-row-ambiguous:sku-pl" && BV_C.brandViewRevision(eAvTie).reason === "latest-row-ambiguous:brand-inventory-available");
  // Round 3 (P2b + P3-1): bv1 also binds the durable Ads-row digest + its window and the derivation-code identity.
  const expectBv = (ev) => "bv1:" + sha256hex(B.stableJson({
    v: BV.BRAND_VIEW_VERSION, a: ev.accountId, country: ev.country, name: ev.name, asOf: ev.asOf,
    r: BV_W.BRAND_VIEW_EVIDENCE_REPORT_KEYS.map((rk) => [rk, ev.identities[rk] || null]),
    inv: ev.inventorySelected || null, ads: ev.ads, adsRows: ev.adsRows.digest, map: ev.mapping, cat: ev.catalog, bvb: { id: ev.directory.identity, brands: ev.directory.brands },
    code: { ...BV_W.BRAND_VIEW_CODE_IDENTITY },
  }));
  ok("F2 ... an ELIGIBLE account hashes EXACTLY the documented material (incl. the Ads-row digest + window and the derivation-code identity)",
    e0.problems.length === 0 && e0.token === expectBv(e0) && JSON.stringify(e0.adsRows) === JSON.stringify({ from: "2026-04-01", to: "2026-09-24", digest: "adr1:2:11:22" }));
  const wc = (rows, c = ctx) => BV_W.default.evidence.compose(rows, c);
  const w0 = wc(r0).get("A"); const wTie = wc(rTie).get("A"); const wOut = wc(rOut).get("A");
  ok("F2 worker compose (the returns-v3 contract): eligible -> the CLI token + targetAsOf (the units' identity as-of) + alerts []; TIED -> token null + 'latest-row-ambiguous:sku-pl'; an out-of-line directory -> token null + 'brand-directory-out-of-line' (each the CLI revision's OWN reason)",
    w0.token === BV_C.brandViewRevision(e0).evidenceToken && w0.targetAsOf === "2026-09-24" && w0.region === REGION && w0.alerts.length === 0 && !("reason" in w0)
    && wTie.token === null && wTie.reason === BV_C.brandViewRevision(eTie).reason && wTie.reason === "latest-row-ambiguous:sku-pl"
    && wOut.token === null && wOut.reason === "brand-directory-out-of-line" && wOut.reason === BV_C.brandViewRevision(eOut).reason && !("targetAsOf" in wOut));
  const unr = wc(r0, { ...ctx, accountIds: ["A", "B", "C"], directory: new Map([...DIRA, ["B", { country: "" }], ["C", { country: "ZZ" }]]) });
  ok("F2 an UNROUTABLE account: token null, region null, typed 'directory-country-missing' / 'directory-region-unassigned'",
    unr.get("B").token === null && unr.get("B").region === null && unr.get("B").reason === "directory-country-missing"
    && unr.get("C").token === null && unr.get("C").region === null && unr.get("C").reason === "directory-region-unassigned" && unr.get("A").token === w0.token);
}
{
  // F3 (P2-2): an OUT-OF-LINE directory source row never becomes a fabricated empty / reduced directory.
  const w = makeWorld(); seed(w);
  const hb = routeHarness(w, BVB_C.default);
  await hb.run({ accounts: ["IN2"] });
  const lkg = clone(bvbLive(w, "IN2"));
  const bs = [...w.snaps.values()].find((r) => r.report_key === "brand-sales" && r.account_id === "IN2");
  // WP10 (the serve + this route moved to the storage-first HYDRATED reader TOGETHER): IN2's ONLY brand source moves out
  // of line with its storage object ABSENT (a payload_storage_path, an unusable inline payload, nothing stored).
  const OBJ = "snap/IN2/brand-sales.json";
  w.putRow({ reportKey: "brand-sales", accountId: "IN2", params: bs.params, payload: null, storagePath: OBJ });
  const writes0 = w.writes(); const cas0 = w.n.liveCas + w.n.shadowCas;
  const s1 = await hb.run({ accounts: ["IN2"] });
  const e1 = recOf(s1, "IN2").reports[BVB];
  ok("F3 (P2-2 / WP10) an OUT-OF-LINE brand-sales row whose storage object is ABSENT DEFERS typed 'storage-missing:brand-sales' with ZERO writes; the LKG directory [Acme] is kept byte-for-byte (never a fabricated empty list from the inline stub)",
    JSON.stringify(lkg.payload.brands) === JSON.stringify(["Acme"]) && e1.state === RS.DD && /storage-missing:brand-sales/.test(S(e1.reason))
    && w.writes() === writes0 && w.n.liveCas + w.n.shadowCas === cas0 && B.stableJson(bvbLive(w, "IN2")) === B.stableJson(lkg) && s1.counts.targetsPublished === 0);
  // The probe's direct derive over the same world: deferred, typed.
  const rt = BVB_C.default.build(routeDeps(w));
  const b = await rt.resolveBundle({ targetId: "IN2" });
  const d = await rt.derive(b.bundle, {});
  ok("F3 ... the direct derive (the verifier probe's case) is notReady 'storage-missing:brand-sales' -- no payload", b.eligible === true && d.notReady === true && d.reason === "storage-missing:brand-sales" && !d.payload);
  // The object exists but its load THROWS: typed 'hydrate-failed:brand-sales', zero writes.
  w.storage.set(OBJ, { rows: salesRows(["Acme", "Omega"]) });
  w.storageFail.add(OBJ);
  const dFail = await rt.derive((await rt.resolveBundle({ targetId: "IN2" })).bundle, {});
  const sFail = await hb.run({ accounts: ["IN2"] });
  ok("F3 ... a storage load that THROWS defers typed 'hydrate-failed:brand-sales' (zero writes, LKG kept)",
    dFail.notReady === true && dFail.reason === "hydrate-failed:brand-sales" && /hydrate-failed:brand-sales/.test(S(recOf(sFail, "IN2").reports[BVB].reason))
    && w.writes() === writes0 && B.stableJson(bvbLive(w, "IN2")) === B.stableJson(lkg));
  // The object reads: the out-of-line payload is HYDRATED and contributes its brands (the serve derives the same list).
  w.storageFail.delete(OBJ);
  const sHyd = await hb.run({ accounts: ["IN2"] });
  ok("F3 ... once the storage object reads, the SAME out-of-line row is HYDRATED storage-first and its brands publish [Acme, Omega] (READBACK_VERIFIED) -- no longer deferred",
    recOf(sHyd, "IN2").reports[BVB].state === RS.RV && JSON.stringify(bvbLive(w, "IN2").payload.brands) === JSON.stringify(["Acme", "Omega"]) && sHyd.counts.targetsPublished === 1);
  // A storage path with a USABLE inline payload is read inline exactly like the serve (the path alone never defers).
  w.putRow({ reportKey: "brand-sales", accountId: "IN2", params: bs.params, payload: { rows: salesRows(["Acme", "Kappa"]) }, storagePath: "snap/IN2/brand-sales.json" });
  const s2 = await hb.run({ accounts: ["IN2"] });
  ok("F3 ... a row whose INLINE payload is usable is read inline (serve parity; a storage path alone never defers): republished [Acme, Kappa]",
    recOf(s2, "IN2").reports[BVB].state === RS.RV && JSON.stringify(bvbLive(w, "IN2").payload.brands) === JSON.stringify(["Acme", "Kappa"]));
  // A GENUINELY empty inline payload (no storage path; fba-plan / sku-pl absent): all three reads ok -> the empty list publishes.
  w.putRow({ reportKey: "brand-sales", accountId: "IN2", params: bs.params, payload: { rows: [] } });
  const s3 = await hb.run({ accounts: ["IN2"] });
  const live3 = bvbLive(w, "IN2");
  ok("F3 ... a GENUINELY empty INLINE brand-sales payload (no storage path) publishes the honest empty directory",
    recOf(s3, "IN2").reports[BVB].state === RS.RV && Array.isArray(live3.payload.brands) && live3.payload.brands.length === 0 && typeof live3.payload.message === "string" && live3.payload.accountId === "IN2");
}
{
  // F4 (P2-3): typed not-applicable vs a real build failure.
  const w = makeWorld(); seed(w);
  await routeHarness(w, BVB_C.default).run({ accounts: ["IN1"] });
  const hv = routeHarness(w, BV_C.default);
  const bs = [...w.snaps.values()].find((r) => r.report_key === "brand-sales" && r.account_id === "IN1");
  const live0 = w.n.liveWrite; // the directory publish above
  // (a) the account's saved brand-sales records NO row: every directory brand (from fba-plan / sku-pl) is typed.
  w.putRow({ reportKey: "brand-sales", accountId: "IN1", params: bs.params, payload: { rows: [] } });
  const s1 = await hv.run({ accounts: ["IN1"] });
  ok("F4 (P2-3) an account whose saved brand-sales records NO row: every directory brand defers TYPED 'no-sales-snapshot' (the builder's first predicate), zero live writes",
    ["Acme", "Beta", "Zeta"].every((b) => bvState(s1, "IN1", b) && bvState(s1, "IN1", b).state === RS.DD && /(^|:)no-sales-snapshot$/.test(S(bvState(s1, "IN1", b).reason))) && w.n.liveWrite === live0);
  // (b) a REAL build failure (a malformed saved row the builder dereferences: a null row + no directory name).
  w.putRow({ reportKey: "brand-sales", accountId: "IN1", params: bs.params, payload: { rows: [null, ...salesRows(["Acme", "Zeta"])] } });
  w.directory.get("IN1").name = null;
  const s2 = await hv.run({ accounts: ["IN1"] });
  ok("F4 ... a REAL build failure keeps the generic 'brand-view-build-failed' (Acme / Zeta), while the unsold Beta stays typed 'brand-not-sold' -- zero live writes",
    ["Acme", "Zeta"].every((b) => bvState(s2, "IN1", b).state === RS.DD && /(^|:)brand-view-build-failed$/.test(S(bvState(s2, "IN1", b).reason)))
    && bvState(s2, "IN1", "Beta").state === RS.DD && /(^|:)brand-not-sold$/.test(S(bvState(s2, "IN1", "Beta").reason)) && w.n.liveWrite === live0);
  // (c) the same account, healthy again: the sold brands publish, Beta stays typed.
  w.directory.get("IN1").name = "India One";
  w.putRow({ reportKey: "brand-sales", accountId: "IN1", params: bs.params, payload: { rows: salesRows(["Acme", "Zeta"]) } });
  const s3 = await hv.run({ accounts: ["IN1"] });
  ok("F4 ... once the saved sales are healthy, Acme + Zeta publish (READBACK_VERIFIED) and Beta stays typed 'brand-not-sold' (never published, never a generic failure)",
    bvState(s3, "IN1", "Acme").state === RS.RV && bvState(s3, "IN1", "Zeta").state === RS.RV && /(^|:)brand-not-sold$/.test(S(bvState(s3, "IN1", "Beta").reason)) && !bvLive(w, "IN1", "Beta", IN_TODAY));
}
{
  // F5 (P3-1): worker-hook argument shapes.
  const ms = W.now();
  const idAsOf = (t, now) => bvWorker.identityAsOf(t, { now, directory: W.directory });
  ok("F5 (P3-1) identityAsOf accepts target = the account id OR { targetKey | accountId }, and now = a function, a Date or epoch ms (normalized once) -- one as-of",
    [idAsOf("IN1", ms), idAsOf({ targetKey: "IN1" }, new Date(ms)), idAsOf({ accountId: "IN1" }, () => ms), idAsOf("IN1", () => new Date(ms))].every((v) => v === IN_TODAY)
    && idAsOf({ targetKey: "NOPE" }, ms) === null && idAsOf("IN1", undefined) === marketplaceToday("IN", new Date()));
  let bad = 0;
  for (const nowBad of ["2026-09-24", () => Number.NaN, new Date(Number.NaN), {}]) { try { idAsOf("IN1", nowBad); } catch { bad += 1; } }
  ok("F5 ... an invalid now (a date string, NaN, an Invalid Date, an object) FAILS CLOSED (throws) -- never an 'Invalid Date' as-of", bad === 4);
  ok("F5 tier1.liveRowScope accepts the account id or { targetKey | accountId } on BOTH routes (identical scopes)",
    ["IN1", { targetKey: "IN1" }, { accountId: "IN1" }].every((t) => JSON.stringify(bvbWorker.tier1.liveRowScope(t)) === JSON.stringify({ reportKey: BVB, accountIdEq: "IN1" })
      && JSON.stringify(bvWorker.tier1.liveRowScope(t)) === JSON.stringify({ reportKey: BVK, accountIdLike: "brand-view:IN1::%" }))
    && JSON.stringify(bvWorker.tier1.liveRowScope({ targetKey: "a_1%" })) === JSON.stringify({ reportKey: BVK, accountIdLike: "brand-view:a\\_1\\%::%" }));
  const cctx = { directory: W.directory, organizationFingerprint: ORG };
  const rows = {};
  // The SQL params and the compose share ctx.now (the Ads-row window is derived from each account's as-of).
  for (const q of BV_W.default.evidence.sql) rows[q.name] = await W.pgReadOnly(q.text, q.params({ ...cctx, now: ms }));
  const variants = [ms, new Date(ms), () => ms, () => new Date(ms)].map((now) => B.stableJson([...BV_W.default.evidence.compose(rows, { ...cctx, now }).entries()]));
  let composeBad = false;
  try { BV_W.default.evidence.compose(rows, { ...cctx, now: () => "later" }); } catch { composeBad = true; }
  ok("F5 evidence.compose accepts ctx.now as a function, a Date or epoch ms -> byte-identical targets; an invalid now fails closed", variants.every((v) => v === variants[0]) && /bv1:/.test(variants[0]) && composeBad);
}
{
  // F6 (P3-2): the pure paramsHashFor leaf; the worker routes' static import closure never reaches report-store.js / supabase.js.
  const leafSrc = src("lib/server/report-params-hash.js");
  const leafImports = [...leafSrc.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
  const LEAF = await import("../lib/server/report-params-hash.js");
  ok("F6 (P3-2) paramsHashFor lives in the PURE leaf report-params-hash.js (imports ONLY node:crypto); report-store.js re-exports the SAME function; the identity hashes are byte-identical to the pre-move goldens",
    JSON.stringify(leafImports) === JSON.stringify(["node:crypto"]) && LEAF.paramsHashFor === paramsHashFor
    && paramsHashFor("brand-view-brands-v1", { accountId: "IN1" }) === "0673111818033bc8ed27d096fc602456080fd6e5"
    && paramsHashFor(BV.BRAND_VIEW_VERSION, { accountId: "IN1", brand: "Acme", asOf: "2026-09-24" }) === "8841f6f33fafe4c29c80aaf8425b4098974761d1"
    && paramsHashFor("v", { b: 1, a: "", c: null, d: "x" }) === "a07301a41dc3ba58280d487716cf19800b7ef75e");
  const closure = (entries) => {
    const seen = new Set(); const stack = entries.map((e) => path.join(ROOT, e));
    while (stack.length) {
      const f = stack.pop(); if (seen.has(f)) continue; seen.add(f);
      const text = readFileSync(f, "utf8").replace(/^\s*\/\/.*$/gm, "");
      for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?\sfrom\s+"(\.[^"]+)"/g)) stack.push(path.resolve(path.dirname(f), m[1]));
    }
    return [...seen].map((f) => path.relative(ROOT, f).split(path.sep).join("/"));
  };
  const reached = closure(["lib/server/recovery/routes/brand-view.route.js", "lib/server/recovery/routes/brand-view-brands.route.js"]);
  ok("F6 the WORKER-side brand-view / brand-view-brands routes' static import closure reaches the leaf and NEITHER report-store.js NOR supabase.js (no snapshot writer in the worker graph)",
    reached.includes("lib/server/report-params-hash.js") && !reached.includes("lib/server/report-store.js") && !reached.includes("lib/server/supabase.js") && reached.length > 5);
}
{
  // F7 (round 3 P2b -- was the P3-3 documented residual): the Ads rows ARE identity-checked now. The read-site note says
  // the residual is CLOSED (both former gaps named), the strict reader applies brandViewAdsRowsMatch, and no
  // "NOT identity-checked" claim is left behind. The behaviour is proven in E11.
  const rs = src("lib/server/sync/routes/brand-view.release.js");
  const at = rs.indexOf("const getAdsRows = async");
  const k = at > 0 ? rs.lastIndexOf("IDENTITY-CHECKED (the former KNOWN RESIDUAL is CLOSED)", at) : -1;
  const note = k >= 0 ? rs.slice(k, at) : "";
  const body = at > 0 ? rs.slice(at, rs.indexOf("\n    };", at)) : "";
  ok("F7 (round 3 P2b) the brand-view derive documents, at the Ads-row read site, that the rows ARE identity-checked (the former KNOWN RESIDUAL is CLOSED: content_rev's MAX_REQUIRED_COVERAGE_DAYS window + the non-atomic ads_sync_state read), and the reader enforces it",
    at > 0 && k > 0 && at - k < 3500 && !/\n\s*(const|let|return|if)\s/.test(note) && /MAX_REQUIRED_COVERAGE_DAYS/.test(note) && /ads_sync_state/.test(note) && /SEPARATE reads/.test(note) && /adsRowsDigest/.test(note)
    && /brandViewAdsRowsMatch\(args, rows, ev, owner\)/.test(body) && /"evidence-advanced:ads-rows"/.test(body) && !/NOT\s+(\/\/\s+)?identity-checked/.test(rs));
}
{
  // F8 (round 3 P3-2): report-snapshot STORAGE IMMUTABILITY. Both routes trust a hydrated storage payload as the content
  // of the row identity the evidence bound (the bytes are not in the token). That is sound only while NO code path under
  // lib/, api/ or scripts/ uploads / overwrites a report-snapshot storage object for an existing row. Proven statically:
  //   (1) the Storage object API (/storage/v1/object, x-upsert) is reached ONLY by lib/server/supabase.js;
  //   (2) supabase.js has ONE upload primitive (putPrivateStorageObject) with exactly THREE call sites, all SOURCE-cache
  //       writers: saveSourceExportCache (source-cache/v1/<requestHash>), saveSourceSnapshotPayload (content-addressed
  //       source-snapshots/v2/<sha>) and sourceCacheStorageAdapter.put -- whose only caller path is source-cache.js
  //       atomicSaveSourcePayload writing versionedObjectPath (source-cache/v2/<hash>/<version>, unique per save);
  //   (3) NO report_snapshots writer is ever handed a storage path: outside supabase.js nothing sets payloadStoragePath /
  //       p_payload_storage_path / payload_storage_path, inside it they are null or the pass-through parameter, and no
  //       script SQL inserts / updates report_snapshots.payload_storage_path;
  //   (4) the invariant is documented at BOTH routes' hydration sites.
  const walk = (dir) => readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((d) => (d.isDirectory()
    ? (d.name === "node_modules" ? [] : walk(dir + "/" + d.name)) : (/\.m?js$/.test(d.name) ? [dir + "/" + d.name] : [])));
  // Offline PGlite self-test tools (scripts/worker/*-selftest.mjs) run their SQL -- incl. deliberate negative cases -- only
  // against an in-memory database, never production, so they are test code here too.
  const isTest = (f) => /\.test\.m?js$/.test(f) || /\/test-[^/]*\.m?js$/.test(f) || /_supabase-env-stub\.mjs$/.test(f) || /^scripts\/worker\/[a-z0-9-]+-selftest\.mjs$/.test(f);
  const prod = ["lib", "api", "scripts"].flatMap(walk).filter((f) => !isTest(f));
  // Whole-line // comments FIRST (a line comment may contain '/*'), then block comments.
  const code = (f) => src(f).split("\n").map((l) => l.replace(/^\s*\/\/.*$/, "")).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
  const storageApi = prod.filter((f) => /\/storage\/v1\/object|x-upsert/i.test(code(f)));
  const SBC = code("lib/server/supabase.js");
  const putCalls = [...SBC.matchAll(/(?<!function )putPrivateStorageObject\(/g)].map((m) => m.index); // call sites only
  const enclosing = (i) => { const before = SBC.slice(0, i); const m = [...before.matchAll(/\n(?:export )?(?:async )?function ([A-Za-z0-9_]+)\(/g)].pop(); return m ? m[1] : null; };
  const putOwners = putCalls.map(enclosing);
  const putElsewhere = prod.filter((f) => f !== "lib/server/supabase.js" && /putPrivateStorageObject/.test(code(f)));
  const adapterUsers = prod.filter((f) => f !== "lib/server/supabase.js" && /sourceCacheStorageAdapter\(/.test(code(f)));
  const puts = prod.flatMap((f) => [...code(f).matchAll(/\b([A-Za-z_$][\w$]*)\.put\(([^,)]*)/g)].map((m) => f + ":" + m[1] + ":" + m[2].trim()));
  const SC = code("lib/server/sync/source-cache.js");
  ok("F8 (round 3 P3-2) (1)+(2) the ONLY storage uploader is supabase.js putPrivateStorageObject, called ONLY by the three SOURCE-cache writers (never a report-snapshot object); the adapter's put is reached only via source-cache.js with a UNIQUE versioned path",
    JSON.stringify(storageApi) === JSON.stringify(["lib/server/supabase.js"]) && putElsewhere.length === 0
    && (SBC.match(/async function putPrivateStorageObject\(/g) || []).length === 1 && JSON.stringify(putOwners) === JSON.stringify(["saveSourceExportCache", "saveSourceSnapshotPayload", "sourceCacheStorageAdapter"])
    && /const objectPath = `source-cache\/v1\/\$\{requestHash\.slice\(0, 2\)\}\/\$\{requestHash\}\.json`;\s*\n\s*const serialised = JSON\.stringify\(\{ rows \}\);\s*\n\s*await putPrivateStorageObject\(SOURCE_CACHE_BUCKET, objectPath, serialised\);/.test(SBC)
    && /const objectPath = sourceSnapshotObjectPath\(\{ organizationFingerprint, connectionId, sourceKey, scopeKey, payloadSha \}\);[\s\S]{0,200}await putPrivateStorageObject\(SOURCE_CACHE_BUCKET, objectPath, body,/.test(SBC)
    && JSON.stringify(adapterUsers) === JSON.stringify(["lib/server/sync/source-sync-driver.js"]) && JSON.stringify(puts) === JSON.stringify(["lib/server/sync/source-cache.js:storage:newPath"])
    && /const newPath = versionedObjectPath\(requestHash, version\);/.test(SC) && /return `source-cache\/v2\/\$\{safeHash\.slice\(0, 2\)\}\/\$\{safeHash\}\/\$\{safeVersion\}\.json`;/.test(SC));
  const pathSetters = prod.filter((f) => f !== "lib/server/supabase.js").filter((f) => /\bpayloadStoragePath\s*:|\bp_payload_storage_path\s*:|[^.\w]payload_storage_path\s*:/.test(code(f)));
  const sbValues = [...SBC.matchAll(/\b(?:p_)?payload_storage_path\s*:\s*([^,\n}]+)/g)].map((m) => m[1].trim());
  const sqlWriters = prod.filter((f) => /(?:update\s+public\.report_snapshots\s+set[\s\S]{0,300}payload_storage_path|insert\s+into\s+public\.report_snapshots[\s\S]{0,300}payload_storage_path)/i.test(code(f)));
  ok("F8 (3) NO report_snapshots write carries a storage path: no caller outside supabase.js supplies one, supabase.js only passes null / the caller's (never supplied) parameter, and no script SQL writes payload_storage_path -- out-of-line report rows are LEGACY-only",
    pathSetters.length === 0 && sbValues.length === 6 && sbValues.every((v) => /^(null|snapshot\.payloadStoragePath \|\| null|payloadStoragePath \|\| null)$/.test(v)) && sqlWriters.length === 0);
  const docBefore = (file, anchor) => { const t = src(file); const at = t.indexOf(anchor); const k = at > 0 ? t.lastIndexOf("STORAGE IMMUTABILITY INVARIANT", at) : -1; return k > 0 && at - k < 1800 ? t.slice(k, at) : ""; };
  const dPf = docBefore("lib/server/sync/routes/brand-view-portfolio.release.js", "async function strictHydrated(");
  const dBv = docBefore("lib/server/sync/routes/brand-view.release.js", "const memo = makeMemoHydratedReader(");
  ok("F8 (4) the invariant is documented AT both routes' hydration sites (what is trusted, why it holds, where it would break)",
    [dPf, dBv].every((d) => /NOT in the token/.test(d) && /putPrivateStorageObject/.test(d) && /would BREAK/.test(d) && /brand-view-routes\.test\.js F8/.test(d)));
}
{
  // F9 (round 3 P3-1): DERIVATION-CODE identity in bv1 (-> the CLI's bvm1 manifest) and bb1.
  const BVCODE = BV_W.BRAND_VIEW_CODE_IDENTITY; const BBCODE = BVB_W.BRAND_VIEW_BRANDS_CODE_IDENTITY;
  const real = (rev) => JSON.stringify({ bv: BV.BRAND_VIEW_VERSION, bvb: BV.BRAND_VIEW_BRANDS_VERSION, bvp: BV.BRAND_VIEW_PORTFOLIO_VERSION, inv: BV.BRAND_INVENTORY_REPORT_VERSION, ads: ACTIVE_ADS_SOURCE_KEY, rev: String(rev) });
  ok("F9 (round 3 P3-1) the default code identities are the REAL constants (Brand View / brands / portfolio versions, compact inventory version, ACTIVE_ADS_SOURCE_KEY) + each route's DERIVE_REV (frozen)",
    Object.isFrozen(BVCODE) && Object.isFrozen(BBCODE) && JSON.stringify(BVCODE) === real(BV_W.DERIVE_REV) && JSON.stringify(BBCODE) === real(BVB_W.DERIVE_REV)
    && Number.isInteger(BV_W.DERIVE_REV) && Number.isInteger(BVB_W.DERIVE_REV));
  const ev = (await BV_C.default.build(routeDeps(W)).readScopeEvidence({ scope: ["IN1"] })).perAccount.get("IN1");
  const bvBase = BV_W.brandViewToken(ev, ev.asOf);
  const bbEv = BVB_W.composeBrandViewBrandsEvidence({ latest_rows: [evRow("brand-sales", "A", "bs1", FT1), evRow("fba-plan", "A", "fp1", FT1)] }, { accountIds: ["A"] }).get("A");
  const bbBase = BVB_W.brandViewBrandsToken("A", bbEv.identities, bbEv.ambiguousIds);
  const bvMoves = Object.keys(BVCODE).every((k) => BV_W.brandViewToken(ev, ev.asOf, { ...BVCODE, [k]: BVCODE[k] + "-changed" }) !== bvBase);
  const bbMoves = Object.keys(BBCODE).every((k) => BVB_W.brandViewBrandsToken("A", bbEv.identities, bbEv.ambiguousIds, { ...BBCODE, [k]: BBCODE[k] + "-changed" }) !== bbBase);
  ok("F9 changing ANY ONE code-identity constant (a version, ACTIVE_ADS_SOURCE_KEY -- the ASIN rollback flip -- or DERIVE_REV) moves bv1 AND bb1; the defaults reproduce the production tokens",
    Object.keys(BVCODE).length === 6 && bvMoves && bbMoves && bvBase === ev.token && bbBase === bbEv.token
    && BV_W.brandViewToken(ev, ev.asOf, { ...BVCODE }) === bvBase && BV_W.brandViewToken(ev, ev.asOf, { ...BVCODE, ads: "asin-performance-v1" }) !== bvBase);
  // bvm1 hashes bv1 (resolveBundle), so it inherits the code identity + the Ads-row digest: pinned structurally.
  const rel = src("lib/server/sync/routes/brand-view.release.js");
  ok("F9 the per-unit manifest bvm1 is a hash OVER the bv1 evidence token (so any code-identity / Ads-row change moves it too)",
    /const evidenceToken = brandViewToken\(ev, boundAsOf\);/.test(rel) && /const manifestToken = "bvm1:" \+ sha256\(stableJson\(\[evidenceToken, p\.targetId, p\.brand, boundAsOf, fp\.depFingerprint\]\)\);/.test(rel));
}

ok("Z zero network / zero DataDoe across every scan, prepare, publish, read-back and served check", net.calls.length === 0);

out(`\nbrand-view-routes: ${passed} passed`);
