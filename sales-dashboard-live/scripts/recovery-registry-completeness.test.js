// Publication recovery WP11 -- ROUTE REGISTRY COMPLETENESS + the ONE pinned evidence ctx shape, FAIL-CLOSED:
//   R1 a static literal scan of `reportKey: "..."` and `*_REPORT_KEY = "..."` over lib/, api/ and scripts/release/ finds
//      EVERY key classified (the scheduler-v2/* shadow namespace included); the pinned live-contract table EQUALS the real
//      SCHEDULER_LIVE_SNAPSHOT_CONTRACTS; an injected unclassified key (in any source registry) THROWS;
//   R2 every registry violation THROWS: a route without deps / evidence / a served selector, an awaits cycle / unknown
//      await, a forbidden or non-allow-listed CLI, a route-cli without its release module, a publisher key without a
//      derivation or outside READY u SOURCE_PROMOTED, a double route id, a priority-order break, a C10 owner
//      contradiction, a route class that disagrees with the publishing routes, a report-level legacy-superseded class,
//      a missing contract override;
//   R3 parity pins with the route CLI (max targets, regions, the region account rule, the fbaInventoryAsOf epoch) and
//      every route-cli worker/CLI pair validates against the REAL contracts;
//   R4 the ONE ctx shape for EVERY route (10 = 6 route-cli + 4 legacy wrappers): params(ctx) and compose(rowsByName, ctx)
//      receive the SAME frozen ctx object { epoch, now (epoch ms), accountIds, directory (buildDurableDirectory Map),
//      region, organizationFingerprint, connectionId:'primary' }; compose returns the pinned Map shape (region null or
//      the scan region; token null only with a typed reason); tier1.liveRowScope({ targetKey, accountId?, region }) and
//      identityAsOf(target, { now, directory }) accept the pinned target; the portfolio scope is REGION-scoped and its
//      owners never gate the region target; malformed ctx / compose results are refused.
// ZERO network / DB. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { readFileSync, writeSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateRouteRegistry, REPORT_RECOVERY_CLASSIFICATION, REPORT_RECOVERY_CLASSIFICATION_ENTRIES, LIVE_CONTRACT_PINS, classifyReportKey,
  SERVED_SELECTOR_FOR_PUBLISHER_KEY, CONTRACT_CLASSIFICATION_OVERRIDES, classificationTable, KNOWN_SNAPSHOT_KEYS, isForbiddenWorkerScript,
} from "../lib/server/recovery/registry.js";
import {
  PUBLICATION_ROUTES, ROUTE_IDS, ROUTE_CLI_MAX_TARGETS, buildEvidenceContext, evaluateRouteEvidence, regionEvidenceAccountIds, tier1Target,
  liveRowScopesFor, identityAsOfFor, ownersGateTarget, utcDMinus1, regionTargetKey, deepSweepDue, routeById,
} from "../lib/server/recovery/routes.js";
import {
  evidenceContextProblems, makeEvidenceContext, composeResultProblems, validateRoutePair, validateRouteModule, ROUTE_REGIONS, LEGACY_CLI_SCRIPTS,
} from "../lib/server/recovery/route-contract.js";
import { composeEvidenceTokens } from "../lib/server/recovery/routes/oli.route.js";
import * as REL from "../lib/server/sync/route-publication-release.js";
import { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } from "../lib/server/sync/report-publisher.js";
import { REPORT_DERIVATIONS } from "../lib/server/sync/report-derivation.js";
import { SOURCE_PROMOTED_REPORT_KEYS, CONTROLLED_REPORT_KEYS, SCHEDULER_V2_READY_REPORT_KEYS } from "../lib/server/sync/report-controls.js";
import { REPORT_MATERIALIZATION } from "../lib/server/reports/report-materialization-registry.js";
import { accountInScope } from "../lib/server/sync/scheduler-scope.js";
import { fbaInventoryAsOf } from "../lib/server/sync/fba-plan-operation.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
const throws = (n, fn, re) => { let e = null; try { fn(); } catch (x) { e = x; } ok(n + (e && !re.test(String(e.message)) ? " -- GOT: " + String(e.message).slice(0, 200) : ""), !!e && re.test(String(e.message))); };
const rejects = async (n, fn, re) => { let e = null; try { await fn(); } catch (x) { e = x; } ok(n + (e && !re.test(String(e.message)) ? " -- GOT: " + String(e.message).slice(0, 200) : ""), !!e && re.test(String(e.message))); };
const J = (x) => JSON.stringify(x);
writeSync(1, "recovery-registry-completeness\n");

/* R1. every report key the code names is classified; pins equal the real registries */
{
  const files = [];
  const walk = (dir) => { for (const f of readdirSync(dir)) { const p = path.join(dir, f); if (f === "node_modules" || f.startsWith(".")) continue; const st = statSync(p); if (st.isDirectory()) walk(p); else if (/\.(m?js)$/.test(f)) files.push(p); } };
  for (const d of ["lib", "api", "scripts/release"]) walk(path.join(ROOT, d));
  const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const found = new Map();
  for (const f of files) {
    const code = noComments(readFileSync(f, "utf8"));
    for (const m of code.matchAll(/\breportKey\s*:\s*["']([^"'\n]*)["']|\b[A-Z0-9_]*_REPORT_KEY\s*=\s*["']([^"'\n]*)["']/g)) {
      const k = m[1] ?? m[2];
      if (k && !found.has(k)) found.set(k, path.relative(ROOT, f).split(path.sep).join("/"));
    }
  }
  const unclassified = [...found.keys()].filter((k) => !classifyReportKey(k));
  ok(`R1: the static literal scan (reportKey: "..." / *_REPORT_KEY = "...") over lib/, api/, scripts/release/ (${files.length} files, ${found.size} keys) finds EVERY key classified` + (unclassified.length ? " -- UNCLASSIFIED: " + unclassified.map((k) => k + "@" + found.get(k)).join(" ") : ""), unclassified.length === 0 && found.size >= 25 && ["brand-sales", "fba-plan", "account-directory", "source-sync"].every((k) => found.has(k)));
  ok("R1: the pinned live-contract table EQUALS SCHEDULER_LIVE_SNAPSHOT_CONTRACTS (keys + liveReportKey) -- report-publisher.js stays out of the worker graph without drifting", J(Object.keys(LIVE_CONTRACT_PINS).sort()) === J(Object.keys(SCHEDULER_LIVE_SNAPSHOT_CONTRACTS).sort()) && Object.keys(LIVE_CONTRACT_PINS).every((k) => LIVE_CONTRACT_PINS[k].liveReportKey === SCHEDULER_LIVE_SNAPSHOT_CONTRACTS[k].liveReportKey));
  const real = validateRouteRegistry({ liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS });
  const universe = new Set([...Object.keys(SCHEDULER_LIVE_SNAPSHOT_CONTRACTS), ...Object.keys(REPORT_MATERIALIZATION).map((k) => REPORT_MATERIALIZATION[k].reportKey || k), ...SOURCE_PROMOTED_REPORT_KEYS, ...CONTROLLED_REPORT_KEYS, ...KNOWN_SNAPSHOT_KEYS]);
  ok("R1: the registry validates against the REAL contracts; its universe covers every registry + the static KNOWN_SNAPSHOT_KEYS; every table row has a class and a reason", [...universe].every((k) => real.universe.includes(k)) && classificationTable().every((r) => r.class && r.reason) && classificationTable().length === REPORT_RECOVERY_CLASSIFICATION.size + Object.keys(CONTRACT_CLASSIFICATION_OVERRIDES).length);
  for (const [name, opts] of [
    ["SCHEDULER_LIVE_SNAPSHOT_CONTRACTS", { liveContracts: { ...LIVE_CONTRACT_PINS, "zz-new": { liveReportKey: "zz-new" } } }],
    ["SOURCE_PROMOTED_REPORT_KEYS", { sourcePromotedKeys: [...SOURCE_PROMOTED_REPORT_KEYS, "zz-new"] }],
    ["SCHEDULER_V2_READY_REPORT_KEYS", { readyKeys: [...SCHEDULER_V2_READY_REPORT_KEYS, "zz-new"] }],
    ["CONTROLLED_REPORT_KEYS", { controlledKeys: [...CONTROLLED_REPORT_KEYS, "zz-new"] }],
    ["KNOWN_SNAPSHOT_KEYS", { knownSnapshotKeys: [...KNOWN_SNAPSHOT_KEYS, "zz-new"] }],
    ["REPORT_MATERIALIZATION", { materialization: { ...REPORT_MATERIALIZATION, "zz-new": { reportKey: "zz-new", materializationOwner: "manual-refresh" } } }],
  ]) throws(`R1: an injected UNCLASSIFIED key in ${name} throws (fail closed)`, () => validateRouteRegistry(opts), /report 'zz-new' is unclassified.*fail closed/);
}

/* R2. every registry violation throws */
{
  const R = (id) => PUBLICATION_ROUTES.find((r) => r.id === id);
  const replace = (id, patch) => PUBLICATION_ROUTES.map((r) => (r.id === id ? { ...r, ...patch } : r));
  const noKey = (id, key) => PUBLICATION_ROUTES.map((r) => { if (r.id !== id) return r; const c = { ...r }; delete c[key]; return c; });
  throws("R2: a route without deps throws", () => validateRouteRegistry({ routes: noKey("returns-v3", "deps") }), /returns-v3.*deps-invalid/);
  throws("R2: a route with empty deps.sources throws", () => validateRouteRegistry({ routes: replace("sku-movement", { deps: { sources: [], reports: [] } }) }), /sku-movement.*deps-invalid/);
  throws("R2: a route without evidence throws", () => validateRouteRegistry({ routes: noKey("brand-view", "evidence") }), /brand-view.*evidence-invalid/);
  throws("R2: a route without a served selector for a publisher contract throws", () => validateRouteRegistry({ servedSelectors: { ...SERVED_SELECTOR_FOR_PUBLISHER_KEY, "fba-plan": undefined } }), /fba-plan.*no served selector/);
  throws("R2: a served selector naming a function serve-selectors.js does not export throws", () => validateRouteRegistry({ servedSelectors: { ...SERVED_SELECTOR_FOR_PUBLISHER_KEY, "brand-view": "selectNothing" } }), /no served selector/);
  throws("R2: an awaits CYCLE throws", () => validateRouteRegistry({ routes: replace("oli", { awaits: ["ads"] }) }), /cycle/);
  throws("R2: an await naming an unknown route throws", () => validateRouteRegistry({ routes: replace("brand-view", { awaits: ["nope-route"] }) }), /unknown route 'nope-route'/);
  throws("R2: a forbidden / non-allow-listed CLI throws (a legacy-cli naming a backfill script)", () => validateRouteRegistry({ routes: replace("oli", { cli: { script: "scripts/release/backfill-brand-sales.mjs", fixedArgs: [] } }) }), /oli.*cli-script-not-legacy|forbidden/);
  ok("R2: the forbidden list catches the returns go-live, every backfill (incl. a future one) and the paid operators", ["returns-leakage-golive.mjs", "backfill-sku-movement.mjs", "backfill-anything-new.mjs", "fba-plan-golive.mjs", "listing-health-v3-ingestion.mjs"].every(isForbiddenWorkerScript) && ![...LEGACY_CLI_SCRIPTS, "scripts/release/publication-route-reconcile.mjs"].some(isForbiddenWorkerScript));
  throws("R2: a route-cli without lib/server/sync/routes/<id>.release.js throws", () => validateRouteRegistry({ releaseModuleExists: (id) => id !== "brand-view-brands" }), /route-cli 'brand-view-brands' has no lib\/server\/sync\/routes\/brand-view-brands\.release\.js/);
  throws("R2: a publisher key without a REPORT_DERIVATIONS entry throws", () => { const d = { ...REPORT_DERIVATIONS }; delete d["fba-plan"]; return validateRouteRegistry({ reportDerivations: d }); }, /fba-plan.*REPORT_DERIVATIONS/);
  throws("R2: a publisher key outside READY u SOURCE_PROMOTED throws", () => validateRouteRegistry({ sourcePromotedKeys: SOURCE_PROMOTED_REPORT_KEYS.filter((k) => k !== "sku-movement") }), /sku-movement.*outside READY u SOURCE_PROMOTED/);
  throws("R2: a route declared twice throws", () => validateRouteRegistry({ routes: [...PUBLICATION_ROUTES, R("oli")] }), /declared twice/);
  throws("R2: a priority-order break throws", () => validateRouteRegistry({ routes: replace("fba-plan", { priority: 9 }) }), /priority order/);
  throws("R2: C10 -- a scheduler-materialized report classified non-route throws", () => validateRouteRegistry({ materialization: { ...REPORT_MATERIALIZATION, sales: { ...REPORT_MATERIALIZATION.sales, materializationOwner: "scheduler-v2:materialize" } } }), /sales.*contradicts.*C10/);
  throws("R2: C10 -- an unknown materializationOwner throws", () => validateRouteRegistry({ materialization: { ...REPORT_MATERIALIZATION, sales: { ...REPORT_MATERIALIZATION.sales, materializationOwner: "page-open" } } }), /unknown materializationOwner/);
  throws("R2: a route class that disagrees with the routes that publish the key throws (daily-reporting is oli + ads)", () => validateRouteRegistry({ classification: REPORT_RECOVERY_CLASSIFICATION_ENTRIES.map((e) => (e.reportKey === "daily-reporting" ? { ...e, cls: "route:oli" } : e)) }), /daily-reporting.*disagrees/);
  throws("R2: legacy-superseded is a CONTRACT override only, never a report class", () => validateRouteRegistry({ classification: REPORT_RECOVERY_CLASSIFICATION_ENTRIES.map((e) => (e.reportKey === "sales" ? { ...e, cls: "legacy-superseded:returns-v3" } : e)) }), /CONTRACT override/);
  throws("R2: without the legacy-superseded override the unserved returns-leakage v2 contract is unowned -> throws", () => validateRouteRegistry({ contractOverrides: {} }), /live contract 'returns-leakage' is route-classified but no route publishes it/);
  throws("R2: an unknown class string throws", () => validateRouteRegistry({ classification: [...REPORT_RECOVERY_CLASSIFICATION_ENTRIES.filter((e) => e.reportKey !== "sales"), { reportKey: "sales", cls: "detect-only", reason: "x" }] }), /unknown class 'detect-only'/);
  throws("R2: a non-route class without a reason throws", () => validateRouteRegistry({ classification: REPORT_RECOVERY_CLASSIFICATION_ENTRIES.map((e) => (e.reportKey === "sales" ? { ...e, reason: " " } : e)) }), /needs a reason/);
  throws("R2: an active publication key mapped to a non-route class throws", () => validateRouteRegistry({ activeKeys: ["brand-sales", "sales"] }), /active publication report 'sales'/);
}

/* R3. parity pins with the route CLI */
{
  const dirRows = [
    { accountId: "IN1", country: "IN", name: "In One" }, { accountId: "IN2", country: "IN", name: "In Two" }, { accountId: "UK1", country: "UK", name: "Uk" },
    { accountId: "AU1", country: "AU", name: "Au" }, { accountId: "US1", country: "US", name: "Us" }, { accountId: "CA1", country: "CA", name: "Ca" },
  ];
  const { directory } = REL.buildDurableDirectory({ rows: dirRows, resolveRawSellerId: (id) => "RAW-" + id });
  ok("R3: ROUTE_CLI_MAX_TARGETS, the regions and the region account rule EQUAL the route CLI's (route-publication-release.js)", ROUTE_CLI_MAX_TARGETS === REL.ROUTE_CLI_MAX_TARGETS && J(ROUTE_REGIONS) === J(REL.ROUTE_REGIONS) && ROUTE_REGIONS.every((r) => J(regionEvidenceAccountIds(directory, r)) === J(REL.regionAccountIds(directory, r, accountInScope))) && J(regionEvidenceAccountIds(directory, "europe-au")) === J(["AU1", "UK1"]));
  ok("R3: the job epoch is fbaInventoryAsOf(now) (UTC D-1) at every instant", [0, 1, Date.UTC(2026, 8, 25, 23, 59, 59, 999), Date.UTC(2026, 8, 26, 0, 0), Date.UTC(2028, 1, 29, 12)].every((t) => utcDMinus1(t) === fbaInventoryAsOf(t)));
  const pairs = PUBLICATION_ROUTES.filter((r) => r.kind === "route-cli");
  const cliMods = await Promise.all(pairs.map((r) => import(`../lib/server/sync/routes/${r.id}.release.js`)));
  ok(`R3: every route-cli worker/CLI pair (${pairs.length}) validates against the REAL live contracts + derivations`, pairs.length === 6 && pairs.every((r, i) => validateRoutePair(r, validateRouteModule(cliMods[i], { side: "cli", liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, reportDerivations: REPORT_DERIVATIONS }), { liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS })));
  const due = deepSweepDue({ now: 10 * 3600000, deepSweepHours: 6, lastAtByRoute: { oli: 9 * 3600000, "returns-v3": 1 } });
  ok("R3: the periodic deep sweep: every route due once per PRW_DEEP_SWEEP_HOURS -- route-cli as a read-only 'verify' (--verify-exact) pass, legacy as its dry-run", !due.some((d) => d.routeId === "oli") && due.find((d) => d.routeId === "returns-v3").kind === "verify" && due.find((d) => d.routeId === "listings").kind === "dry-run" && due.length === ROUTE_IDS.length - 1);
}

/* R4. the ONE ctx shape for EVERY route */
{
  const NOW = Date.UTC(2026, 8, 25, 10, 0, 0);
  const EPOCH = utcDMinus1(NOW);
  const ORG = "org-fp-1";
  const dirRows = [
    { accountId: "IN1", country: "IN", name: "In One", currency: "INR" }, { accountId: "IN2", country: "IN", name: "In Two", currency: "INR" },
    { accountId: "UK1", country: "UK", name: "Uk", currency: "GBP" }, { accountId: "US1", country: "US", name: "Us", currency: "USD" },
  ];
  const { directory } = REL.buildDurableDirectory({ rows: dirRows, resolveRawSellerId: (id) => "RAW-" + id });
  // Realistic metadata rows where cheap: the legacy statements + the portfolio's directory (so a region target exists).
  const d = new Date(Date.UTC(2026, 8, 24, 3, 0, 0));
  const ROWS = {
    oli_coverage: [{ account_id: "IN1", covered_to: EPOCH, refreshed: d }, { account_id: "US1", covered_to: EPOCH, refreshed: d }],
    oli_completeness: [{ account_id: "IN1", refreshed: d }],
    fba_pointers: [{ account_id: "IN1", source_request_hash: "h1", payload_sha: "s1" }],
    ads_revs: [{ account_id: "IN1", revs: "campaign-performance-v1=r@2026-09-24" }],
    listings_pointers: [{ account_id: "IN1", l_sha: "l1", l_at: d, r_sha: "r1", r_at: d }],
    catalog_pointer: [{ payload_sha: "c1" }],
    account_directory: dirRows.map((r, i) => ({ ord: i + 1, kind: "object", id: r.accountId, name: r.name, name_kind: "string", country: r.country, country_kind: "string", inactive: false, setting_up: r.accountId === "IN2" })),
  };
  const query = (seenTexts) => async (text) => { seenTexts.push(text); const q = PUBLICATION_ROUTES.flatMap((r) => r.evidence.sql).find((x) => x.text === text); return (q && ROWS[q.name]) ? ROWS[q.name] : []; };
  const failures = [];
  const results = new Map();
  for (const region of ["india", "europe-au", "us-ca"]) {
    const ctx = buildEvidenceContext({ epoch: EPOCH, now: NOW, directory, region, organizationFingerprint: ORG });
    for (const route of PUBLICATION_ROUTES) {
      // SPY: every params() and the compose must receive the SAME frozen ctx object.
      const seen = [];
      const spy = { ...route, evidence: { ...route.evidence, sql: route.evidence.sql.map((q) => ({ ...q, params: (c) => { seen.push(c); return q.params(c); } })), compose: (rows, c) => { seen.push(c); return route.evidence.compose(rows, c); } } };
      try {
        const texts = [];
        const m = await evaluateRouteEvidence(spy, query(texts), ctx);
        if (!(seen.length === route.evidence.sql.length + 1 && seen.every((c) => c === ctx) && Object.isFrozen(ctx) && Object.isFrozen(ctx.accountIds))) failures.push(route.id + "@" + region + ":ctx-not-shared");
        if (composeResultProblems(m, { ctx, grain: route.grain }).length) failures.push(route.id + "@" + region + ":compose-shape");
        if (route.grain === "account" && J([...m.keys()].sort()) !== J(ctx.accountIds)) failures.push(route.id + "@" + region + ":account-targets");
        if (route.grain === "region" && ![...m.keys()].every((k) => k === regionTargetKey(region))) failures.push(route.id + "@" + region + ":foreign-region-target");
        results.set(route.id + "@" + region, m);
        for (const key of route.grain === "region" ? [regionTargetKey(region)] : ctx.accountIds) {
          const t = tier1Target(route, key, region);
          const scopes = liveRowScopesFor(route, t);
          if (!scopes.length || !scopes.every((s) => route.liveReportKeys.includes(s.reportKey))) failures.push(route.id + ":scope-report");
          if (route.grain === "account" && !scopes.every((s) => s.accountIdEq === key || (s.accountIdLike || "").includes(key))) failures.push(route.id + ":scope-account");
          if (route.identityAsOf) { const a = identityAsOfFor(route, t, { now: NOW, directory }); if (!/^\d{4}-\d{2}-\d{2}$/.test(String(a))) failures.push(route.id + ":identity-asof"); }
        }
      } catch (e) { failures.push(route.id + "@" + region + ":threw:" + String(e && e.message).slice(0, 160)); }
    }
  }
  ok(`R4: EVERY route (${PUBLICATION_ROUTES.length}: ${ROUTE_IDS.join(", ")}) runs on the ONE pinned ctx in every region -- the SAME frozen ctx object reaches every params() and the compose, the compose result is the pinned shape, liveRowScope / identityAsOf accept the pinned target` + (failures.length ? " -- FAILURES: " + failures.join(" | ") : ""), failures.length === 0 && PUBLICATION_ROUTES.length === 10);
  const inOli = results.get("oli@india");
  const golden = composeEvidenceTokens({ oli: ROWS.oli_coverage, oliCompleteness: ROWS.oli_completeness, fba: ROWS.fba_pointers, ads: ROWS.ads_revs, listings: ROWS.listings_pointers, catalog: ROWS.catalog_pointer[0] });
  ok("R4: the legacy wrappers' compose tokens are EXACTLY composeEvidenceTokens' (the pre-route watermark tokens); an account with no token material is { token: null, reason: 'no-evidence-token' }", inOli.get("IN1").token === golden.oli.get("IN1") && inOli.get("IN2").token === null && inOli.get("IN2").reason === "no-evidence-token" && results.get("listings@india").get("IN1").token === golden.listings.get("IN1") && results.get("fba@india").get("IN1").token === golden.fba.get("IN1") && results.get("ads@india").get("IN1").token === golden.ads.get("IN1") && results.get("oli@us-ca").get("US1").token === golden.oli.get("US1"));
  const pf = results.get("brand-view-portfolio@india");
  const pfUs = results.get("brand-view-portfolio@us-ca");
  ok("R4: the portfolio compose yields ONLY the scan region's target; its owners (incl. a settingUp member) never gate it (ownersGateTarget false; account routes true)", J([...pf.keys()]) === J(["region:india"]) && J(pf.get("region:india").owners) === J(["IN1", "IN2"]) && J([...pfUs.keys()]) === J(["region:us-ca"]) && ownersGateTarget(routeById("brand-view-portfolio")) === false && PUBLICATION_ROUTES.filter((r) => r.grain === "account").every(ownersGateTarget));
  const sIn = liveRowScopesFor("brand-view-portfolio", tier1Target("brand-view-portfolio", "region:india", "india"));
  const sUs = liveRowScopesFor("brand-view-portfolio", tier1Target("brand-view-portfolio", "region:us-ca", "us-ca"));
  ok("R4: the portfolio tier-1 live-row scope is REGION-scoped (params->>'region'), never every region's rows", J(sIn) === J([{ reportKey: "brand-view-portfolio", accountIdLike: "brand-view-portfolio:%", paramsEq: { region: "india" } }]) && sUs[0].paramsEq.region === "us-ca");
  throws("R4: ... an unresolvable portfolio region target fails closed", () => routeById("brand-view-portfolio").tier1.liveRowScope({ targetKey: "region:mars", region: "mars" }), /region:<r>/);
  // malformed contexts / results are refused
  const good = buildEvidenceContext({ epoch: EPOCH, now: NOW, directory, region: "india", organizationFingerprint: ORG });
  const badCtxs = [
    [{ ...good, now: new Date(NOW) }, /ctx-now-not-epoch-ms/], [{ ...good, now: () => NOW }, /ctx-now-not-epoch-ms/], [{ ...good, organizationFingerprint: "" }, /ctx-org-invalid/],
    [{ ...good, connectionId: "dd-secondary" }, /ctx-connection-not-primary/], [{ ...good, accountIds: ["IN2", "IN1"] }, /not-sorted-unique/], [{ ...good, accountIds: ["NOPE"] }, /not-in-directory/],
    [{ ...good, accountIds: ["dd:IN1"] }, /ctx-account-ids-invalid/], [{ ...good, extra: 1 }, /ctx-unknown-key:extra/], [{ ...good, region: "mars" }, /ctx-region-invalid/], [{ ...good, directory: [...directory.values()] }, /ctx-directory-not-map/], [{ ...good, epoch: "2026-02-30" }, /ctx-epoch-invalid/],
  ];
  ok("R4: a malformed evidence ctx (Date / function now, blank org, non-primary connection, unsorted / unknown / prefixed ids, extra key, bad region / directory / epoch) is refused", badCtxs.every(([c, re]) => re.test(evidenceContextProblems(c).join(","))) && evidenceContextProblems(good).length === 0);
  await rejects("R4: evaluateRouteEvidence refuses a hand-built malformed ctx before any read", () => evaluateRouteEvidence("returns-v3", async () => { throw new Error("read attempted"); }, { ...good, now: new Date(NOW) }), /evidence context is invalid.*ctx-now-not-epoch-ms/);
  throws("R4: makeEvidenceContext throws on a malformed input", () => makeEvidenceContext({ epoch: EPOCH, now: NOW, accountIds: ["IN1"], directory, region: "india", organizationFingerprint: " org" }), /ctx-org-invalid/);
  const bogusRoute = (compose) => ({ ...routeById("returns-v3"), evidence: { ...routeById("returns-v3").evidence, compose } });
  await rejects("R4: a compose yielding a FOREIGN-region target is refused", () => evaluateRouteEvidence(bogusRoute(() => new Map([["IN1", { token: "t", owners: ["IN1"], region: "us-ca", alerts: [] }]])), async () => [], good), /compose-region-foreign/);
  await rejects("R4: a compose yielding token null WITHOUT a typed reason is refused", () => evaluateRouteEvidence(bogusRoute(() => new Map([["IN1", { token: null, owners: ["IN1"], region: "india", alerts: [] }]])), async () => [], good), /compose-null-token-needs-reason/);
  await rejects("R4: a compose entry without alerts (the pre-WP11 fba-plan / portfolio shape) is refused", () => evaluateRouteEvidence(bogusRoute(() => new Map([["IN1", { token: "t", owners: ["IN1"], region: "india" }]])), async () => [], good), /compose-alerts-invalid/);
}

writeSync(1, `recovery-registry-completeness: ${passed} passed\n`);
