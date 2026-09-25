// Publication recovery WP1 -- the OPTIONAL publisher contract hooks (liveAccountId, gateAccountIds, liveParamsExtra,
// asOfField, promotedGateKey, targetIdentity), the five zero-export ROUTE contracts (sku-movement, returns-leakage-v3,
// brand-view-brands, brand-view, brand-view-portfolio), their SOURCE_PROMOTED keys and their PUBLISH-ONLY derivations.
//
// Proves, fully offline (every collaborator injected; ZERO DataDoe / Supabase / network -- the live write is a faithful
// in-memory model of publishLiveSnapshotFencedIfNewer's CAS: insert-if-absent, strictly-newer replace, strictly-older
// newer-live, EQUAL freshness => canonical params THEN payload identity proof => already-current | conflict):
//   (A) static surface: the route contracts are pinned to the live modules' constants, stay undispatchable
//       (SOURCE_PROMOTED is disjoint from CONTROLLED + READY), every route liveParams builder is IDEMPOTENT over its own
//       stored live params (so the shared read-back re-derives the identity hash), the publish-only derivations refuse
//       to derive and validate the REAL builders' payloads, and the recovery registry still classifies every key;
//   (B) the publisher: the portfolio AND gate (every member rolled out AND approved; zero live writes otherwise), the
//       brand-view OWNER gate (never the scope id) + targetIdentity, liveParamsExtra stored but never hashed (resolver
//       provenance still passes), the equal-stamp replay/conflict semantics, and the fba-plan promotedGateKey;
//   (C) the binding: asOfField 'asOf' / null and liveAccountId != targetId give the correct PUBLICATION_NOT_REQUIRED /
//       STALE reasons in evaluatePublicationBinding AND resolveValidatedLiveCandidate.
// 7-bit ASCII, LF, no top-level await; dynamic imports after a dummy Supabase env.

import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = process.env[SB_KEY_ENV] || ["test", "svc", "role", "key"].join("-");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; out("  ok  " + name); };

let P; // report-publisher.js
let B; // publication-binding.js
let D; // report-derivation.js
let C; // report-controls.js
let R; // recovery/registry.js
let BV; // reports/brand-view.js
let paramsHashFor, buildLivePromotedResolver, skuMovementPayload, buildReturnsAdvancedPayload, RETURNS_ADVANCED_VERSION;

const OWNER = "IN1";
const IN2 = "IN2";
const IN3 = "IN3";
const ASOF = "2026-09-24";
const TS = "2026-09-25T03:00:00.000Z";
const TS_LATER = "2026-09-25T09:00:00.000Z";
const ROUTE_KEYS = ["sku-movement", "returns-leakage-v3", "brand-view-brands", "brand-view", "brand-view-portfolio"];

// ---- the fenced-CAS model (publishLiveSnapshotFencedIfNewer + cas_report_snapshot_if_newer semantics) ----
function makeCasStore() {
  const rows = new Map();
  const k = (rk, a, h) => rk + "|" + a + "|" + h;
  return {
    rows,
    publish: async ({ reportKey, accountId, paramsHash, params, payload, sourceRefreshedAt }) => {
      const key = k(reportKey, accountId, paramsHash);
      const live = rows.get(key);
      if (!live) {
        rows.set(key, { report_key: reportKey, account_id: accountId, params_hash: paramsHash, params, payload, payload_storage_path: null, source_refreshed_at: sourceRefreshedAt });
        return { outcome: "inserted" };
      }
      const cand = Date.parse(sourceRefreshedAt);
      const cur = Date.parse(live.source_refreshed_at);
      if (cand > cur) { Object.assign(live, { params, payload, source_refreshed_at: sourceRefreshedAt }); return { outcome: "replaced" }; }
      if (cand < cur) return { outcome: "newer-live" };
      // EQUAL freshness: canonical params first, then the payload (supabase.js publishLiveSnapshotFencedIfNewer).
      if (B.stableJson(live.params) !== B.stableJson(params)) return { outcome: "conflict" };
      if (B.stableJson(live.payload) !== B.stableJson(payload)) return { outcome: "conflict" };
      return { outcome: "already-current" };
    },
    get: async ({ reportKey, accountId, paramsHash }) => rows.get(k(reportKey, accountId, paramsHash)) || null,
  };
}

// ---- one publisher harness: EXACT job + shadow for (key, targetId, params); production code readiness (no override) ----
function harness({ key, targetId, params, payload, rollout = [OWNER], discovered = [OWNER, IN2, IN3], approved = null, dispatch = [], promoted = [key], promotedThrows = false, cas = makeCasStore(), ts = TS }) {
  const hash = paramsHashFor(params.reportVersion, params);
  const calls = { settings: 0, promoted: 0, rollout: 0, discover: 0, approvals: [], job: 0, shadow: [], publish: [] };
  const deps = {
    getReportSyncSettings: async () => { calls.settings += 1; return dispatch.map((rk) => ({ report_key: rk, schedule_enabled: true })); },
    getPromotedPublishSettings: async () => { calls.promoted += 1; if (promotedThrows) throw new Error("promoted read boom"); return promoted.map((rk) => ({ report_key: rk, publish_enabled: true })); },
    loadAccountRollout: async () => { calls.rollout += 1; return { read: "ok", allPrimary: false, enabledAccountIds: rollout }; },
    discoverPrimaryAccounts: async () => { calls.discover += 1; return discovered.map((id) => ({ accountId: id, country: "IN" })); },
    getPublishApproval: async (rk, a) => { calls.approvals.push(rk + "|" + a); return { read: "ok", approved: approved == null ? true : approved.includes(a) }; },
    getLatestReportJob: async () => { calls.job += 1; return { cycle_id: "cyc-1", validated: true, snapshot_params_hash: hash, derive_status: "succeeded", save_status: "succeeded", cycle_status: "partial" }; },
    getShadowSnapshot: async (sk, a, h) => {
      calls.shadow.push(sk + "|" + a);
      return sk === "scheduler-v2/" + key && a === targetId && h === hash
        ? { params_hash: hash, params: { ...params }, payload, payload_storage_path: null, source_refreshed_at: ts }
        : null;
    },
    loadStoragePayload: async () => null,
    publishLive: async (args) => { calls.publish.push(args); return cas.publish(args); },
  };
  const run = (preflight = false) => P.publishSchedulerV2Snapshot(deps, { reportKey: key, accountId: targetId, preflight });
  return { deps, calls, cas, hash, run };
}

// ---- REAL payloads from the live builders (pure; fake durable readers only) ----
const SALES_ROWS = [
  { date: "2026-09-23", marketplace_country_code: "IN", currency: "INR", product_brand: "Acme", total_sales: 100, total_units_sold: 4 },
  { date: "2026-09-24", marketplace_country_code: "IN", currency: "INR", product_brand: "Acme", total_sales: 50, total_units_sold: 2 },
];
const salesSnapshotFor = (ids) => ({ reportKey, accountId }) => Promise.resolve(reportKey === "brand-sales" && ids.includes(String(accountId))
  ? { source_refreshed_at: TS, params: { from: "2026-03-01", to: ASOF }, payload: { catalogBrands: ["Acme"], rows: SALES_ROWS } }
  : null);

async function realPayloads() {
  const brandView = await BV.buildBrandViewSnapshot({ accountId: OWNER, brand: "Acme", asOf: ASOF, account: { name: "India One", country: "IN" }, getSnapshot: salesSnapshotFor([OWNER]), getAdsRows: async () => [] });
  const portfolio = await BV.buildBrandViewPortfolioSnapshot({ accountIds: [IN2, OWNER, IN3].sort(), brand: "Acme", asOf: ASOF, accountsById: {}, getSnapshot: salesSnapshotFor([OWNER, IN2, IN3]), getAdsRows: async () => [] });
  const brands = await BV.buildBrandViewBrandDirectory({ accountId: OWNER, getSnapshot: salesSnapshotFor([OWNER]) });
  const sku = skuMovementPayload({ oliRows: [], catalogRows: [], effectiveAsOf: ASOF, brand: "ALL", accountId: OWNER });
  const returns = buildReturnsAdvancedPayload({
    accountId: OWNER, asOf: ASOF, from: "2026-07-27", windowDays: 60,
    returnsSourceLabel: "Returns (FBA & FBM)", moneySourceLabel: "Settlements & P&L Components", rateSourceLabel: "Order Line Items", rateSourceLagDays: 0, returnHistoryDays: 60,
  });
  return { brandView, portfolio, brands, sku, returns };
}

// ---- shadow params EXACTLY as a route saves them: { reportVersion: snapshotVersion, accountId: targetId, ...identity, ...tokens } ----
const TOK = (p) => p + ":" + "a".repeat(64);
const skuTarget = (acct, brand) => "sku-movement:" + acct + "::" + brand;
const skuParams = (over = {}) => ({ reportVersion: "sku-movement/v2", accountId: skuTarget(OWNER, "ALL"), ownerAccountId: OWNER, asOf: ASOF, brand: "ALL", evidenceToken: TOK("sm1"), serveToken: TOK("sms1"), manifestToken: TOK("mf1"), ...over });
const bvParams = (over = {}) => ({ reportVersion: "brand-view/route-1", accountId: BV.brandViewScopeId(OWNER, "Acme"), ownerAccountId: OWNER, brand: "Acme", asOf: ASOF, depFingerprint: TOK("dfp"), evidenceToken: TOK("bv1"), ...over });
const PF_MEMBERS = [IN2, OWNER, IN3]; // deliberately unsorted: the contract sorts
const pfParams = (over = {}) => ({ reportVersion: "brand-view-portfolio/route-1", accountId: BV.brandViewPortfolioScopeId(PF_MEMBERS, "Acme"), members: PF_MEMBERS, brand: "Acme", asOf: ASOF, region: "india", depFingerprint: TOK("dfp"), evidenceToken: TOK("pf1"), ...over });
const bbParams = (over = {}) => ({ reportVersion: "brand-view-brands/route-1", accountId: OWNER, evidenceToken: TOK("bb1"), ...over });
const rlParams = (over = {}) => ({ reportVersion: "returns-leakage/v3-route", accountId: OWNER, to: ASOF, evidenceToken: TOK("rl1"), manifestToken: TOK("mf1"), ...over });
// The scheduler's PAID fba-plan shadow params (report-planner.js) -- no route tokens.
const fbaPaidParams = () => ({ reportVersion: "fba-plan/v2d-5", accountId: OWNER, to: ASOF, inventoryAsOf: ASOF, rawSellerId: "RAW1", accountName: "India One", marketCountry: "IN", isUS: false });
const FBA_PAYLOAD = { rows: [], months: [], inventoryByBrandCountry: [], isUS: false, asOf: ASOF, inventoryAvailable: true, awdAvailable: false };

async function main() {
  ({ paramsHashFor } = await import("../lib/server/report-store.js"));
  P = await import("../lib/server/sync/report-publisher.js");
  B = await import("../lib/server/sync/publication-binding.js");
  D = await import("../lib/server/sync/report-derivation.js");
  C = await import("../lib/server/sync/report-controls.js");
  R = await import("../lib/server/recovery/registry.js");
  BV = await import("../lib/server/reports/brand-view.js");
  ({ buildLivePromotedResolver } = await import("../lib/server/sync/live-promoted-resolver.js"));
  ({ skuMovementPayload } = await import("../lib/server/reports/sku-movement-core.js"));
  ({ buildReturnsAdvancedPayload, RETURNS_ADVANCED_VERSION } = await import("../lib/server/reports/returns-advanced.js"));
  const K = P.SCHEDULER_LIVE_SNAPSHOT_CONTRACTS;
  const PAY = await realPayloads();

  // =============================================================================================================
  out("== A. static surface");
  {
    const want = {
      "sku-movement": ["sku-movement", "sku-movement/v2", "asOf"],
      "returns-leakage-v3": ["returns-leakage", RETURNS_ADVANCED_VERSION, undefined],
      "brand-view-brands": ["brand-view-brands", BV.BRAND_VIEW_BRANDS_VERSION, null],
      "brand-view": ["brand-view", BV.BRAND_VIEW_VERSION, "asOf"],
      "brand-view-portfolio": ["brand-view-portfolio", BV.BRAND_VIEW_PORTFOLIO_VERSION, "asOf"],
    };
    for (const [k, [lk, lv, f]] of Object.entries(want)) {
      ok(`A1 ${k}: liveReportKey ${lk} + liveReportVersion ${lv} (the live module constant) + asOfField ${String(f)}`, !!K[k] && Object.isFrozen(K[k]) && K[k].liveReportKey === lk && K[k].liveReportVersion === lv && K[k].asOfField === f);
    }
    ok("A1 the returns v3 live version is the serve's RETURNS_ADVANCED_VERSION literal and the sku-movement version is the serve's literal", RETURNS_ADVANCED_VERSION === "returns-leakage-v3" && readFileSync(path.join(ROOT, "api", "datadoe.js"), "utf8").includes('reportKey: "sku-movement", reportVersion: "sku-movement/v2"'));
    ok("A1 the v2 'returns-leakage' dispatch contract is UNTOUCHED (no hook)", K["returns-leakage"].liveReportVersion === "returns-leakage-v2" && ["liveAccountId", "gateAccountIds", "liveParamsExtra", "asOfField", "promotedGateKey", "targetIdentity", "semanticIdentity"].every((h) => !(h in K["returns-leakage"])));
    const HOOKS = ["liveAccountId", "gateAccountIds", "liveParamsExtra", "asOfField", "promotedGateKey", "targetIdentity"];
    const legacy = ["brand-sales", "daily-reporting", "reconciliation", "sku-pl", "keyword-rank", "content-changes", "sales-movers", "listing-health", "buy-box-loss", "returns-leakage", "ppc-performance", "listing-optimizer", "brand-inventory", "listing-health-v3"];
    ok("A2 the 14 non-fba-plan pre-existing contracts carry NONE of the route hooks (byte-identical path)", legacy.every((k) => HOOKS.every((h) => !(h in K[k]))));
    ok("A2 fba-plan gains ONLY promotedGateKey 'fba-plan' + liveParamsExtra (identity hooks absent; live identity { to } unchanged)", K["fba-plan"].promotedGateKey === "fba-plan" && typeof K["fba-plan"].liveParamsExtra === "function" && ["liveAccountId", "gateAccountIds", "asOfField", "targetIdentity"].every((h) => !(h in K["fba-plan"])) && JSON.stringify(K["fba-plan"].liveParams(fbaPaidParams())) === JSON.stringify({ to: ASOF }));
    ok("A2 exactly 20 contracts (15 pre-existing + 5 route)", Object.keys(K).length === 20 && ROUTE_KEYS.every((k) => k in K));
    ok("A2 RECOVERY_ROUTE_PUBLISHER_KEYS is exactly the 5 route contracts (frozen)", Object.isFrozen(P.RECOVERY_ROUTE_PUBLISHER_KEYS) && JSON.stringify(P.RECOVERY_ROUTE_PUBLISHER_KEYS) === JSON.stringify(ROUTE_KEYS));
    const { LIVE_PUBLISHABLE_REPORT_KEYS } = await import("../lib/server/delivery-status.js");
    ok("A2 the read-only Delivery Status view keeps its pre-existing 15-key universe (route keys excluded => no extra live-meta read)", JSON.stringify(LIVE_PUBLISHABLE_REPORT_KEYS) === JSON.stringify([...legacy, "fba-plan"].sort()));

    const SP = C.SOURCE_PROMOTED_REPORT_KEYS;
    ok("A3 every route key is SOURCE_PROMOTED and publisher-code-ready", ROUTE_KEYS.every((k) => SP.includes(k) && P.SCHEDULER_V2_PUBLISHABLE_REPORT_KEYS.includes(k)));
    ok("A3 SOURCE_PROMOTED is DISJOINT from CONTROLLED (no dispatcher can ever select a promoted key)", SP.every((k) => !C.CONTROLLED_REPORT_KEYS.includes(k)));
    ok("A3 SOURCE_PROMOTED is DISJOINT from the READY dispatch allowlist, which stays EXACTLY the 13 approved keys", SP.every((k) => !C.SCHEDULER_V2_READY_REPORT_KEYS.includes(k)) && C.SCHEDULER_V2_READY_REPORT_KEYS.length === 13);
    ok("A3 no SOURCE_PROMOTED key is duplicated", new Set(SP).size === SP.length);

    // Read-back provenance: buildLivePromotedResolver re-derives the hash from contract.liveParams(STORED live params).
    const shadows = { "sku-movement": skuParams(), "returns-leakage-v3": rlParams(), "brand-view-brands": bbParams(), "brand-view": bvParams(), "brand-view-portfolio": pfParams() };
    for (const k of ROUTE_KEYS) {
      const lp = K[k].liveParams(shadows[k]);
      const extra = B.contractLiveParamsExtra(K[k], shadows[k], lp);
      const stored = { reportVersion: K[k].liveReportVersion, ...lp, ...extra.extra };
      ok(`A4 ${k}: liveParams is IDEMPOTENT over its own stored live params (+ extras) -> the read-back re-derives the identity hash`, !!lp && extra.ok === true && JSON.stringify(K[k].liveParams(stored)) === JSON.stringify(lp) && paramsHashFor(K[k].liveReportVersion, K[k].liveParams(stored)) === paramsHashFor(K[k].liveReportVersion, lp));
    }
    ok("A4 portfolio live params: SORTED unique members joined by ',' + brand + asOf + region (the serve's identity shape)", JSON.stringify(K["brand-view-portfolio"].liveParams(pfParams())) === JSON.stringify({ accountIds: [IN2, OWNER, IN3].sort().join(","), brand: "Acme", asOf: ASOF, region: "india" }));
    ok("A4 brand-view live params are keyed by the OWNER account (never the scope id)", JSON.stringify(K["brand-view"].liveParams(bvParams())) === JSON.stringify({ accountId: OWNER, brand: "Acme", asOf: ASOF }));
    for (const k of ROUTE_KEYS) ok(`A4 ${k}: a missing/malformed identity fails CLOSED (null)`, K[k].liveParams({}) === null && K[k].liveParams({ ...shadows[k], asOf: "2026-02-30", to: "2026-02-30", accountId: "", ownerAccountId: "", members: [] }) === null);

    const DV = D.REPORT_DERIVATIONS;
    const PUB = { "returns-leakage-v3": ["returns-leakage/v3-route", PAY.returns], "brand-view-brands": ["brand-view-brands/route-1", PAY.brands], "brand-view": ["brand-view/route-1", PAY.brandView], "brand-view-portfolio": ["brand-view-portfolio/route-1", PAY.portfolio] };
    for (const [k, [ver, payload]] of Object.entries(PUB)) {
      ok(`A5 ${k}: publish-only derivation (snapshotVersion ${ver}, derive null, no source contract) validates the REAL builder payload`, DV[k].snapshotVersion === ver && DV[k].derive === null && DV[k].publishOnly === true && DV[k].requiredRequestKeys.length === 0 && DV[k].validatePayload(payload) === true);
    }
    ok("A5 returns v3 validator: rejects a v2-shaped payload and a v3 payload missing dayAxis/series/freshness", DV["returns-leakage-v3"].validatePayload({ ...PAY.returns, version: "returns-leakage-v2" }) === false && DV["returns-leakage-v3"].validatePayload({ ...PAY.returns, dayAxis: null }) === false && DV["returns-leakage-v3"].validatePayload({ ...PAY.returns, series: [] }) === false && DV["returns-leakage-v3"].validatePayload({ ...PAY.returns, freshness: null }) === false);
    ok("A5 brand-view-brands validator: rejects a non-string brand, a missing sources[] and a blank accountId", DV["brand-view-brands"].validatePayload({ ...PAY.brands, brands: [1] }) === false && DV["brand-view-brands"].validatePayload({ ...PAY.brands, sources: null }) === false && DV["brand-view-brands"].validatePayload({ ...PAY.brands, accountId: " " }) === false);
    ok("A5 brand-view validators are SCOPE-bound: an account payload never validates as a portfolio and vice versa", DV["brand-view"].validatePayload(PAY.portfolio) === false && DV["brand-view-portfolio"].validatePayload(PAY.brandView) === false && DV["brand-view"].validatePayload({ ...PAY.brandView, brandViewVersion: "brand-view-account-scoped-v1" }) === false && DV["brand-view"].validatePayload({ ...PAY.brandView, asOf: "2026-02-30" }) === false);
    ok("A5 the pre-existing derivations are unchanged (no publishOnly flag leaks onto them; brand-inventory keeps derive null)", Object.keys(DV).filter((k) => !(k in PUB)).every((k) => !("publishOnly" in DV[k])) && DV["brand-inventory"].derive === null && DV["sku-movement"].snapshotVersion === "sku-movement/v2");
    for (const k of Object.keys(PUB)) {
      const r = D.deriveReportSnapshot({ reportKey: k, sources: {}, context: { to: ASOF } });
      ok(`A6 deriveReportSnapshot REFUSES the publish-only key ${k} (typed non-terminal not-implemented, 'publish-only', no payload)`, r.status === "not-implemented" && r.publishOnly === true && r.validated === false && r.payload === null && /publish-only/.test(r.reason));
    }
    const bi = D.deriveReportSnapshot({ reportKey: "brand-inventory", sources: {}, context: {} });
    ok("A6 the legacy derive:null brand-inventory result is byte-identical (not flagged publish-only)", JSON.stringify(bi) === JSON.stringify({ status: "not-implemented", validated: false, payload: null, latestDataDate: null, errorStage: "derive", reason: 'derivation for "brand-inventory" is declared but not yet wired' }));
    ok("A6 reportDerivationCoverage stays clean (no declared report unmapped, none both declared and derived-only)", D.reportDerivationCoverage().missing.length === 0 && D.reportDerivationCoverage().both.length === 0);

    const reg = R.validateRecoveryRegistry();
    ok("A7 the recovery registry still classifies every live contract key (fail-closed validator passes)", Object.keys(K).every((k) => reg[k]));
    ok("A7 returns-leakage-v3 is classified EXACTLY like its registry entry returns-leakage", JSON.stringify(reg["returns-leakage-v3"]) === JSON.stringify(reg["returns-leakage"]));
  }

  // =============================================================================================================
  out("== B. publisher hooks");
  {
    // ---- B1 portfolio AND gate ----
    const pfKey = "brand-view-portfolio";
    const pfTarget = BV.brandViewPortfolioScopeId(PF_MEMBERS, "Acme");
    const good = harness({ key: pfKey, targetId: pfTarget, params: pfParams(), payload: PAY.portfolio, rollout: [OWNER, IN2, IN3] });
    const g = await good.run();
    ok("B1 portfolio: every member rolled out + approved -> published at the scope id", g.disposition === "published" && good.calls.publish.length === 1 && good.calls.publish[0].accountId === pfTarget && g.liveAccountId === pfTarget);
    ok("B1 portfolio: an approval was required for EVERY member (sorted), never for the scope id", JSON.stringify(good.calls.approvals) === JSON.stringify([IN2, OWNER, IN3].sort().map((a) => pfKey + "|" + a)));
    ok("B1 portfolio: rollout + discovery were read ONCE for the whole member set", good.calls.rollout === 1 && good.calls.discover === 1);
    const notRolled = harness({ key: pfKey, targetId: pfTarget, params: pfParams(), payload: PAY.portfolio, rollout: [OWNER, IN2] });
    const nr = await notRolled.run();
    ok("B1 portfolio: ONE member not rolled out -> account-disabled, ZERO publishLive calls, zero approvals read", nr.disposition === "account-disabled" && notRolled.calls.publish.length === 0 && notRolled.calls.approvals.length === 0);
    const undiscovered = harness({ key: pfKey, targetId: pfTarget, params: pfParams(), payload: PAY.portfolio, rollout: [OWNER, IN2, IN3], discovered: [OWNER, IN2] });
    ok("B1 portfolio: ONE member rolled out but not freshly discovered -> account-disabled, zero writes", (await undiscovered.run()).disposition === "account-disabled" && undiscovered.calls.publish.length === 0);
    const unapproved = harness({ key: pfKey, targetId: pfTarget, params: pfParams(), payload: PAY.portfolio, rollout: [OWNER, IN2, IN3], approved: [OWNER, IN2] });
    const ua = await unapproved.run();
    ok("B1 portfolio: ONE member unapproved -> publish-not-approved, ZERO publishLive calls", ua.disposition === "publish-not-approved" && unapproved.calls.publish.length === 0);
    const secParams = pfParams({ members: [OWNER, "dd-secondary:IN9"], accountId: BV.brandViewPortfolioScopeId([OWNER, "dd-secondary:IN9"], "Acme") });
    const sec = harness({ key: pfKey, targetId: secParams.accountId, params: secParams, payload: PAY.portfolio, rollout: [OWNER, "dd-secondary:IN9"] });
    ok("B1 portfolio: a prefixed (dd-secondary) member id can never be a gate account -> account-disabled, zero writes", (await sec.run()).disposition === "account-disabled" && sec.calls.publish.length === 0);
    const wrongTarget = harness({ key: pfKey, targetId: BV.brandViewPortfolioScopeId([OWNER, IN2], "Acme"), params: pfParams({ accountId: BV.brandViewPortfolioScopeId([OWNER, IN2], "Acme") }), payload: PAY.portfolio, rollout: [OWNER, IN2, IN3] });
    ok("B1 portfolio: a target id that is not the scope id of the shadow's (members, brand) -> invalid-snapshot BEFORE any gate read", (await wrongTarget.run()).disposition === "invalid-snapshot" && wrongTarget.calls.publish.length === 0 && wrongTarget.calls.rollout === 0 && wrongTarget.calls.approvals.length === 0);

    // ---- B2 brand-view owner gate + targetIdentity ----
    const bvTarget = BV.brandViewScopeId(OWNER, "Acme");
    const bv = harness({ key: "brand-view", targetId: bvTarget, params: bvParams(), payload: PAY.brandView, rollout: [OWNER] });
    const bvr = await bv.run();
    const w = bv.calls.publish[0];
    ok("B2 brand-view: gated on the OWNER (rollout [owner] + approval (brand-view, owner)) -> published", bvr.disposition === "published" && JSON.stringify(bv.calls.approvals) === JSON.stringify(["brand-view|" + OWNER]));
    ok("B2 brand-view: the live row is the scope id with the serve's identity { accountId: owner, brand, asOf } + the stored extras", w.accountId === bvTarget && w.reportKey === "brand-view" && JSON.stringify(w.params) === JSON.stringify({ reportVersion: BV.BRAND_VIEW_VERSION, accountId: OWNER, brand: "Acme", asOf: ASOF, depFingerprint: TOK("dfp"), evidenceToken: TOK("bv1") }) && w.paramsHash === paramsHashFor(BV.BRAND_VIEW_VERSION, { accountId: OWNER, brand: "Acme", asOf: ASOF }));
    const scopeOnly = harness({ key: "brand-view", targetId: bvTarget, params: bvParams(), payload: PAY.brandView, rollout: [bvTarget], discovered: [bvTarget, OWNER] });
    ok("B2 brand-view: rolling out ONLY the scope id never opens the gate (account-disabled, zero writes)", (await scopeOnly.run()).disposition === "account-disabled" && scopeOnly.calls.publish.length === 0);
    const mism = harness({ key: "brand-view", targetId: bvTarget, params: bvParams({ brand: "Other" }), payload: PAY.brandView, rollout: [OWNER] });
    ok("B2 brand-view: a targetIdentity mismatch (target is not brandViewScopeId(owner, brand)) -> invalid-snapshot, zero gate reads, zero writes", (await mism.run()).disposition === "invalid-snapshot" && mism.calls.publish.length === 0 && mism.calls.rollout === 0 && mism.calls.approvals.length === 0);
    const semBad = harness({ key: "brand-view", targetId: bvTarget, params: bvParams(), payload: { ...PAY.brandView, brand: "Other" }, rollout: [OWNER] });
    ok("B2 brand-view: a payload whose OWN brand differs from the identity -> invalid-snapshot (semanticIdentity)", (await semBad.run()).disposition === "invalid-snapshot" && semBad.calls.publish.length === 0);
    const pre = await harness({ key: "brand-view", targetId: bvTarget, params: bvParams(), payload: PAY.brandView, rollout: [OWNER] }).run(true);
    ok("B2 brand-view preflight: 'ready' carries the exact live identity incl. liveAccountId, zero writes", pre.disposition === "ready" && pre.liveAccountId === bvTarget && pre.liveReportKey === "brand-view");

    // ---- B3 liveParamsExtra stored, never hashed ----
    const sk = harness({ key: "sku-movement", targetId: skuTarget(OWNER, "ALL"), params: skuParams({ unlisted: "never-live" }), payload: PAY.sku });
    const skr = await sk.run();
    const sw = sk.calls.publish[0];
    const identityHash = paramsHashFor("sku-movement/v2", { asOf: ASOF, brand: "ALL" });
    ok("B3 sku-movement: published at the OWNER live account (liveAccountId != targetId), gated + approved on the owner only", skr.disposition === "published" && sw.accountId === OWNER && skr.liveAccountId === OWNER && skr.accountId === skuTarget(OWNER, "ALL") && JSON.stringify(sk.calls.approvals) === JSON.stringify(["sku-movement|" + OWNER]));
    ok("B3 sku-movement: the three extras are STORED but EXCLUDED from paramsHash; an unlisted shadow param never reaches live params", sw.paramsHash === identityHash && skr.paramsHash === identityHash && JSON.stringify(sw.params) === JSON.stringify({ reportVersion: "sku-movement/v2", asOf: ASOF, brand: "ALL", evidenceToken: TOK("sm1"), serveToken: TOK("sms1"), manifestToken: TOK("mf1") }));
    const resolve = buildLivePromotedResolver({ getReportSnapshot: sk.cas.get, loadStoragePayload: async () => null, liveContracts: P.SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, reportDerivations: D.REPORT_DERIVATIONS, computeHash: paramsHashFor });
    const rb = await resolve({ reportKey: "sku-movement", liveReportKey: "sku-movement", accountId: OWNER, paramsHash: identityHash });
    ok("B3 the shared resolver's params-provenance + semantic identity PASS with the extras stored", rb.ok === true && B.stableJson(rb.payload) === B.stableJson(PAY.sku));
    for (const [label, over] of [["a non-string token", { evidenceToken: 123 }], ["a 201-char token", { serveToken: "x".repeat(201) }], ["a blank token", { manifestToken: "  " }], ["a null token", { evidenceToken: null }]]) {
      const h = harness({ key: "sku-movement", targetId: skuTarget(OWNER, "ALL"), params: skuParams(over), payload: PAY.sku });
      ok(`B3 ${label} -> invalid-snapshot, zero writes`, (await h.run()).disposition === "invalid-snapshot" && h.calls.publish.length === 0);
    }
    ok("B3 a 200-char token is accepted (the bound is inclusive)", (await harness({ key: "sku-movement", targetId: skuTarget(OWNER, "ALL"), params: skuParams({ serveToken: "y".repeat(200) }), payload: PAY.sku }).run()).disposition === "published");
    const fake = { liveParams: (p) => ({ to: p.to }), liveParamsExtra: (p) => p.x };
    ok("B3 contractLiveParamsExtra: an UNKNOWN extra key -> invalid (the publisher maps it to invalid-snapshot)", B.contractLiveParamsExtra(fake, { x: { foo: "bar" } }, { to: ASOF }).ok === false);
    ok("B3 contractLiveParamsExtra: an extra colliding with reportVersion / a live param, an array, or a throwing hook -> invalid", B.contractLiveParamsExtra(fake, { x: { reportVersion: "v" } }, { to: ASOF }).ok === false && B.contractLiveParamsExtra({ liveParamsExtra: () => ({ evidenceToken: "t" }) }, {}, { evidenceToken: "z" }).ok === false && B.contractLiveParamsExtra(fake, { x: ["evidenceToken"] }, { to: ASOF }).ok === false && B.contractLiveParamsExtra({ liveParamsExtra: () => { throw new Error("x"); } }, {}, {}).ok === false);
    ok("B3 contractLiveParamsExtra: the allowlist is exactly { depFingerprint, evidenceToken, serveToken, manifestToken } (<= 200 chars)", JSON.stringify(B.LIVE_PARAMS_EXTRA_KEYS) === JSON.stringify(["depFingerprint", "evidenceToken", "serveToken", "manifestToken"]) && B.LIVE_PARAMS_EXTRA_MAX_CHARS === 200);
    const skSem = harness({ key: "sku-movement", targetId: skuTarget(OWNER, "ALL"), params: skuParams(), payload: { ...PAY.sku, effectiveAsOf: "2026-09-23" } });
    ok("B3 sku-movement: payload.effectiveAsOf != identity asOf -> invalid-snapshot (semanticIdentity)", (await skSem.run()).disposition === "invalid-snapshot" && skSem.calls.publish.length === 0);

    // ---- B4 equal-stamp replay vs different extra ----
    const cas = makeCasStore();
    const first = await harness({ key: "sku-movement", targetId: skuTarget(OWNER, "ALL"), params: skuParams(), payload: PAY.sku, cas }).run();
    const snapshotAfterFirst = B.stableJson([...cas.rows.values()]);
    const replay = await harness({ key: "sku-movement", targetId: skuTarget(OWNER, "ALL"), params: skuParams(), payload: PAY.sku, cas }).run();
    ok("B4 an equal-stamp IDENTICAL replay -> already-current (live row byte-identical)", first.disposition === "published" && replay.disposition === "already-current" && B.stableJson([...cas.rows.values()]) === snapshotAfterFirst);
    const other = await harness({ key: "sku-movement", targetId: skuTarget(OWNER, "ALL"), params: skuParams({ evidenceToken: TOK("sm2") }), payload: PAY.sku, cas }).run();
    ok("B4 an equal stamp with a DIFFERENT extra (same identity hash, same payload) -> publish-conflict, live row byte-identical", other.disposition === "publish-conflict" && other.paramsHash === first.paramsHash && B.stableJson([...cas.rows.values()]) === snapshotAfterFirst && cas.rows.size === 1);
    const newer = await harness({ key: "sku-movement", targetId: skuTarget(OWNER, "ALL"), params: skuParams({ evidenceToken: TOK("sm2") }), payload: PAY.sku, cas, ts: TS_LATER }).run();
    ok("B4 the SAME change at a strictly newer stamp replaces the row (published) and stores the new extra", newer.disposition === "published" && [...cas.rows.values()][0].params.evidenceToken === TOK("sm2"));
    const older = await harness({ key: "sku-movement", targetId: skuTarget(OWNER, "ALL"), params: skuParams({ evidenceToken: TOK("sm3") }), payload: PAY.sku, cas }).run();
    ok("B4 an older stamp never overwrites (newer-live), live row unchanged", older.disposition === "newer-live" && [...cas.rows.values()][0].params.evidenceToken === TOK("sm2"));

    // ---- B5 fba-plan promotedGateKey ----
    const fba = (over) => harness({ key: "fba-plan", targetId: OWNER, params: fbaPaidParams(), payload: FBA_PAYLOAD, ...over });
    const dOnly = fba({ dispatch: ["fba-plan"], promoted: [] });
    const dr = await dOnly.run();
    ok("B5 fba-plan: dispatch-only (schedule_enabled) passes, the promoted control is NEVER read", dr.disposition === "published" && dOnly.calls.promoted === 0);
    ok("B5 fba-plan paid-path shadow: stored params EXACTLY { reportVersion, to } (the extras pick is empty -- paid behaviour unchanged)", JSON.stringify(dOnly.calls.publish[0].params) === JSON.stringify({ reportVersion: "fba-plan-shared-v1", to: ASOF }) && !("liveAccountId" in dr));
    const pOnly = fba({ dispatch: [], promoted: ["fba-plan"] });
    ok("B5 fba-plan: promoted-only (dispatch control paused) passes GATE 2", (await pOnly.run()).disposition === "published" && pOnly.calls.promoted === 1);
    const neither = fba({ dispatch: [], promoted: [] });
    ok("B5 fba-plan: neither control -> report-disabled, zero writes", (await neither.run()).disposition === "report-disabled" && neither.calls.publish.length === 0 && neither.calls.rollout === 0);
    const otherPromoted = fba({ dispatch: [], promoted: ["brand-inventory", "listing-health-v3"] });
    ok("B5 fba-plan: another report's promoted row never opens fba-plan (report-disabled)", (await otherPromoted.run()).disposition === "report-disabled");
    const pThrow = fba({ dispatch: [], promoted: ["fba-plan"], promotedThrows: true });
    ok("B5 fba-plan: a failed promoted read with the dispatch control off fails CLOSED as report-disabled (the pre-hook disposition)", (await pThrow.run()).disposition === "report-disabled" && pThrow.calls.publish.length === 0);
    const route = harness({ key: "fba-plan", targetId: OWNER, params: { ...fbaPaidParams(), evidenceToken: TOK("fp1"), manifestToken: TOK("mf1") }, payload: FBA_PAYLOAD, dispatch: [], promoted: ["fba-plan"] });
    const rr = await route.run();
    ok("B5 fba-plan route shadow: the evidence + manifest tokens are stored, the { to } identity hash is unchanged", rr.disposition === "published" && JSON.stringify(route.calls.publish[0].params) === JSON.stringify({ reportVersion: "fba-plan-shared-v1", to: ASOF, evidenceToken: TOK("fp1"), manifestToken: TOK("mf1") }) && rr.paramsHash === paramsHashFor("fba-plan-shared-v1", { to: ASOF }));
    const sm = harness({ key: "sales-movers", targetId: OWNER, params: { reportVersion: "sales-movers/v2d-1", accountId: OWNER, to: ASOF }, payload: { accountId: OWNER, asOf: ASOF, dataUnavailable: true, rows: [], catalogBrands: [], salesLatestDate: null }, dispatch: [], promoted: ["sales-movers"] });
    ok("B5 a dispatch report WITHOUT promotedGateKey is never opened by a promoted row (report-disabled, promoted never read)", (await sm.run()).disposition === "report-disabled" && sm.calls.promoted === 0);

    // ---- B6 returns v3 + brand-view-brands (no identity hooks: the ORIGINAL early gate order on the target) ----
    const rl = harness({ key: "returns-leakage-v3", targetId: OWNER, params: rlParams(), payload: PAY.returns });
    const rlr = await rl.run();
    ok("B6 returns-leakage-v3: published to live report_key 'returns-leakage' at { to } under the v3 version, tokens stored, not hashed", rlr.disposition === "published" && rl.calls.publish[0].reportKey === "returns-leakage" && rl.calls.publish[0].paramsHash === paramsHashFor(RETURNS_ADVANCED_VERSION, { to: ASOF }) && JSON.stringify(rl.calls.publish[0].params) === JSON.stringify({ reportVersion: RETURNS_ADVANCED_VERSION, to: ASOF, evidenceToken: TOK("rl1"), manifestToken: TOK("mf1") }));
    const rlOff = harness({ key: "returns-leakage-v3", targetId: OWNER, params: rlParams(), payload: PAY.returns, rollout: [IN2] });
    ok("B6 returns-leakage-v3: gates keep the ORIGINAL order (account-disabled BEFORE any job/shadow read)", (await rlOff.run()).disposition === "account-disabled" && rlOff.calls.job === 0 && rlOff.calls.shadow.length === 0);
    const rlDisp = harness({ key: "returns-leakage-v3", targetId: OWNER, params: rlParams(), payload: PAY.returns, dispatch: ["returns-leakage-v3", "returns-leakage"], promoted: [] });
    ok("B6 returns-leakage-v3: its GATE 2 is the promoted control ONLY (a dispatch row never opens it)", (await rlDisp.run()).disposition === "report-disabled");
    const bb = harness({ key: "brand-view-brands", targetId: OWNER, params: bbParams(), payload: PAY.brands });
    const bbr = await bb.run();
    ok("B6 brand-view-brands: published at { accountId } with the evidence token stored (the serve's exact identity hash)", bbr.disposition === "published" && bb.calls.publish[0].paramsHash === paramsHashFor(BV.BRAND_VIEW_BRANDS_VERSION, { accountId: OWNER }) && bb.calls.publish[0].params.evidenceToken === TOK("bb1"));
    const bbSem = harness({ key: "brand-view-brands", targetId: OWNER, params: bbParams(), payload: { ...PAY.brands, accountId: IN2 } });
    ok("B6 brand-view-brands: another account's directory payload -> invalid-snapshot (semanticIdentity)", (await bbSem.run()).disposition === "invalid-snapshot" && bbSem.calls.publish.length === 0);
    ok("B6 every observed disposition stays inside the typed PUBLISH_DISPOSITIONS contract (+ preflight 'ready')", [g, nr, ua, bvr, skr, first, replay, other, newer, older, dr, rr, rlr, bbr].every((x) => P.PUBLISH_DISPOSITIONS.includes(x.disposition)));
  }

  // =============================================================================================================
  out("== C. binding: asOfField + liveAccountId");
  {
    const K2 = P.SCHEDULER_LIVE_SNAPSHOT_CONTRACTS;
    const fixture = (key, targetId, params, payload, liveAcct) => {
      const contract = K2[key];
      const hash = paramsHashFor(params.reportVersion, params);
      const lp = contract.liveParams(params);
      const x = B.contractLiveParamsExtra(contract, params, lp);
      const candHash = paramsHashFor(contract.liveReportVersion, lp);
      const shadow = { report_key: "scheduler-v2/" + key, account_id: targetId, params_hash: hash, params: { ...params }, payload, payload_storage_path: null, source_refreshed_at: TS };
      const live = { report_key: contract.liveReportKey, account_id: liveAcct, params_hash: candHash, params: { reportVersion: contract.liveReportVersion, ...lp, ...x.extra }, payload, payload_storage_path: null, source_refreshed_at: TS };
      const job = { deriveStatus: "succeeded", saveStatus: "succeeded", validated: true, cycleStatus: "partial", snapshotParamsHash: hash, dependsOn: ["req-1"], durableContentDeps: [params.evidenceToken] };
      const revision = { eligible: true, deps: ["req-1"], contentDeps: [params.evidenceToken] };
      const bind = (over = {}) => B.evaluatePublicationBinding({
        revision, accountId: targetId, reportKey: key, requestedAsOf: ASOF, expectedShadowKey: "scheduler-v2/" + key,
        job, shadow, hydratedShadowPayload: payload, live, hydratedLivePayload: payload, liveReadback: { ok: true },
        contract, computeHash: paramsHashFor, reportDerivations: D.REPORT_DERIVATIONS, ...over,
      });
      const rows = new Map([["scheduler-v2/" + key + "|" + targetId + "|" + hash, shadow], [contract.liveReportKey + "|" + liveAcct + "|" + candHash, live]]);
      const readSnapshot = async ({ reportKey, accountId, paramsHash }) => rows.get(reportKey + "|" + accountId + "|" + paramsHash) || null;
      const verifyLiveReadback = buildLivePromotedResolver({ getReportSnapshot: readSnapshot, loadStoragePayload: async () => null, liveContracts: K2, reportDerivations: D.REPORT_DERIVATIONS, computeHash: paramsHashFor });
      const cand = (over = {}) => B.resolveValidatedLiveCandidate({ reportKey: key, accountId: targetId, readReportJob: async () => job, readSnapshot, loadStoragePayload: async () => null, verifyLiveReadback, liveContracts: K2, computeHash: paramsHashFor, reportDerivations: D.REPORT_DERIVATIONS, ...over });
      return { bind, cand, live, shadow };
    };
    const NR = B.PUBLICATION_STATE.PUBLICATION_NOT_REQUIRED;
    const ST = B.PUBLICATION_STATE.STALE;
    // sku-movement: asOfField 'asOf', live account = owner != target
    const s = fixture("sku-movement", skuTarget(OWNER, "ALL"), skuParams(), PAY.sku, OWNER);
    ok("C1 sku-movement (asOfField 'asOf', liveAccountId owner != target): exact -> PUBLICATION_NOT_REQUIRED", s.bind().state === NR);
    ok("C1 sku-movement: another requested as-of -> STALE candidate-asof-not-exact", s.bind({ requestedAsOf: "2026-09-23" }).reason === "candidate-asof-not-exact" && s.bind({ requestedAsOf: "2026-09-23" }).state === ST);
    ok("C1 sku-movement: a malformed requested as-of -> STALE requested-asof-invalid", s.bind({ requestedAsOf: "2026-9-24" }).reason === "requested-asof-invalid");
    ok("C1 sku-movement: a live row keyed at the TARGET id (not the owner) -> STALE live-identity-mismatch", s.bind({ live: { ...s.live, account_id: skuTarget(OWNER, "ALL") } }).reason === "live-identity-mismatch");
    ok("C1 sku-movement: a caller-supplied liveAccountId equal to the contract's -> NOT_REQUIRED; a different one -> STALE live-account-mismatch", s.bind({ liveAccountId: OWNER }).state === NR && s.bind({ liveAccountId: IN2 }).reason === "live-account-mismatch");
    ok("C1 sku-movement: an uncovered evidence token (content dep) -> STALE source-revision-changed", s.bind({ revision: { eligible: true, deps: ["req-1"], contentDeps: [TOK("sm9")] } }).reason === "source-revision-changed");
    ok("C1 sku-movement: a shadow with an invalid extra is never publisher-identical -> STALE", s.bind({ shadow: { ...s.shadow, params: { ...s.shadow.params, serveToken: 7 }, params_hash: paramsHashFor("sku-movement/v2", { ...s.shadow.params, serveToken: 7 }) }, job: { deriveStatus: "succeeded", saveStatus: "succeeded", validated: true, cycleStatus: "partial", snapshotParamsHash: paramsHashFor("sku-movement/v2", { ...s.shadow.params, serveToken: 7 }), dependsOn: ["req-1"], durableContentDeps: [TOK("sm1")] } }).reason === "shadow-live-params-extra-invalid");
    const sc = await s.cand({ requestedAsOf: ASOF });
    ok("C4 resolveValidatedLiveCandidate sku-movement: exact asOf -> ok, the owner-keyed live row proven (payload + dependsOn)", sc.ok === true && JSON.stringify(sc.dependsOn) === JSON.stringify(["req-1"]));
    ok("C4 resolveValidatedLiveCandidate sku-movement: another asOf -> candidate-asof-not-exact; a wrong caller liveAccountId -> live-account-mismatch", (await s.cand({ requestedAsOf: "2026-09-23" })).reason === "candidate-asof-not-exact" && (await s.cand({ liveAccountId: IN2 })).reason === "live-account-mismatch");
    // brand-view-brands: asOfField null
    const b = fixture("brand-view-brands", OWNER, bbParams(), PAY.brands, OWNER);
    ok("C2 brand-view-brands (asOfField null): the requested-as-of gate is SKIPPED -> NOT_REQUIRED for any requestedAsOf", b.bind().state === NR && b.bind({ requestedAsOf: "2020-01-01" }).state === NR && b.bind({ requestedAsOf: "garbage" }).state === NR);
    ok("C2 brand-view-brands: every other binding check still applies (live payload differs -> STALE live-payload-differs)", b.bind({ hydratedLivePayload: { ...PAY.brands, brands: ["Zed"] } }).reason === "live-payload-differs");
    ok("C4 resolveValidatedLiveCandidate brand-view-brands (null): ok for any requestedAsOf", (await b.cand({ requestedAsOf: "2020-01-01" })).ok === true && (await b.cand()).ok === true);
    // brand-view: asOf + target identity + scope-id live account
    const v = fixture("brand-view", BV.brandViewScopeId(OWNER, "Acme"), bvParams(), PAY.brandView, BV.brandViewScopeId(OWNER, "Acme"));
    ok("C3 brand-view: NOT_REQUIRED at the scope id; the owner-keyed live row is NOT this identity (STALE live-identity-mismatch)", v.bind().state === NR && v.bind({ live: { ...v.live, account_id: OWNER } }).reason === "live-identity-mismatch");
    // A self-consistent job + shadow keyed by scope(owner, "Other") whose params name brand "Acme": hash provenance holds,
    // so ONLY the target identity can refuse it.
    const vt = fixture("brand-view", BV.brandViewScopeId(OWNER, "Other"), bvParams({ accountId: BV.brandViewScopeId(OWNER, "Other") }), PAY.brandView, BV.brandViewScopeId(OWNER, "Other"));
    const vtBind = vt.bind();
    ok("C3 brand-view: a shadow whose (owner, brand) is not the target's scope -> STALE shadow-target-identity (binding AND resolver)", vtBind.state === ST && vtBind.reason === "shadow-target-identity" && (await vt.cand({ requestedAsOf: ASOF })).reason === "shadow-target-identity");
    ok("C4 resolveValidatedLiveCandidate brand-view: exact asOf -> ok", (await v.cand({ requestedAsOf: ASOF })).ok === true);
    // returns v3: default asOfField 'to', live report_key differs from the publisher key
    const r = fixture("returns-leakage-v3", OWNER, rlParams(), PAY.returns, OWNER);
    ok("C5 returns-leakage-v3 (default 'to'): NOT_REQUIRED at live report_key 'returns-leakage'; an older requestedAsOf -> STALE candidate-asof-not-exact", r.bind().state === NR && r.bind({ requestedAsOf: "2026-09-25" }).reason === "candidate-asof-not-exact");
    ok("C6 contractAsOfField: default 'to'; 'asOf'; null; anything else is a malformed contract (undefined)", B.contractAsOfField({}) === "to" && B.contractAsOfField({ asOfField: "asOf" }) === "asOf" && B.contractAsOfField({ asOfField: null }) === null && B.contractAsOfField({ asOfField: "from" }) === undefined);
    ok("C6 a contract with a malformed asOfField fails CLOSED in the binding and the resolver", b.bind({ contract: { ...K2["brand-view-brands"], asOfField: "from" } }).reason === "live-contract-asof-field-invalid" && (await b.cand({ liveContracts: { ...K2, "brand-view-brands": { ...K2["brand-view-brands"], asOfField: "from" } } })).reason === "live-contract-asof-field-invalid");
  }

  out(`publisher-route-hooks: ${passed} assertions passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
