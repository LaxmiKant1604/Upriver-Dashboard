// Publication recovery worker -- unit + static guards (WP11 route design): the fail-closed ROUTE registry (every report
// key classified; injected violations throw), every route's exact argv (the four legacy CLIs BYTE-IDENTICAL to the
// pre-route runner; the route CLI's --route / --targets / --run-token / --verify-exact shapes), the guard preload +
// ZEROEXPORT / OOM / STOP parsing, classification v2 (worst-unit verdicts, every HANDOFF typed reason, fail-closed
// unknowns, the classifyRun masking fix, owner hand-off classes), config validation, TARGETS sanitization + the moved
// evidence-token compose, structural zero-export (no DataDoe export code reachable), a text audit of the 20260934
// migration (expand-only, least privilege), and (K) the WP11 verifier round-2 fixes: race-prone codes, leading '-threw'
// codes, the strict served-proof default, the scope-race STOP, the guard's leading newline. ZERO network/DB. 7-bit
// ASCII, LF.
import assert from "node:assert/strict";
import { readFileSync, writeSync, readdirSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  FORBIDDEN_WORKER_SCRIPTS, validateRecoveryRegistry, validateRouteRegistry,
  ADS_CLI_OPERATION_REPORT_KEYS, REPORT_RECOVERY_CLASSIFICATION, REPORT_RECOVERY_CLASSIFICATION_ENTRIES, classifyReportKey,
  isForbiddenWorkerScript, ACTIVE_PUBLICATION_REPORT_KEYS, CONTRACT_CLASSIFICATION_OVERRIDES, handoffForReportClass,
} from "../lib/server/recovery/registry.js";
import { PUBLICATION_ROUTES, ROUTE_IDS, LEGACY_ROUTE_IDS, topoOrder, routeById, utcDMinus1 } from "../lib/server/recovery/routes.js";
import {
  accountVerdict, jobVerdict, classifyRun, classifyReason, classifyDeferral, classifyFailure, cleanupUnresolved, outcomeFor, handoffClass,
  repairKindFor, awaitVerdict, CLASSES, HANDOFF_CLASSES, STATES, NOT_ACTIVATED_STOP_CODES, REASON_RULES, ROUTE_REASON_VOCABULARY, routeReasonKnown, unitServedProof,
  LEGACY_PROVENANCE_RE, isKnownLegacyReason, FBA_PLAN_EVIDENCE_INSTANT_NOTE, RUN_ARGS_ERRORS, SCOPE_RACE_STOP_CODES, RACE_TRANSIENT_CODES, leadingThrewHead,
} from "../lib/server/recovery/classify.js";
import { asOfText, interruptibleSleep, verdictReportKeys as workerVerdictReportKeys } from "../lib/server/recovery/worker.js";
import { getEventListeners } from "node:events";
import * as REGISTRY from "../lib/server/recovery/registry.js";
import * as RUNNER from "../lib/server/recovery/runner.js";
import { adsEvidenceWorkerKeys } from "../lib/server/recovery/routes/ads.route.js";
import { LEGACY_CLI_SCRIPTS } from "../lib/server/recovery/route-contract.js";
import { buildRouteArgs, makeRunToken, runRoute, parseZeroExportLine as runnerParseZeroExport, childHeapFor, zeroExportGuardUrl } from "../lib/server/recovery/runner.js";
import { loadRecoveryConfig, parseSchedulerWindows, inSchedulerWindow, LIVE_ROUTE_CONFIG_ATTESTATIONS, missingLiveAttestation } from "../lib/server/recovery/config.js";
import { SCHEDULER_V2_READY_REPORT_KEYS } from "../lib/server/sync/report-controls.js";
import { sanitizeReasonCode, buildTargetsPayload, formatTargetsLine, parseTargetsLine, normalizeTargets } from "../lib/server/sync/reconcile-targets-output.js";
import { composeEvidenceTokens, recoveryPgTypes, regionForCycleBucket, recoveryPoolConfig, createRecoveryStore } from "../lib/server/recovery/store-pg.js";
import { composeEvidenceTokens as composeAtHome, LEGACY_EVIDENCE_SQL } from "../lib/server/recovery/routes/oli.route.js";
import { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } from "../lib/server/sync/report-publisher.js";
import { REPORT_MATERIALIZATION } from "../lib/server/reports/report-materialization-registry.js";
import { fbaInventoryAsOf } from "../lib/server/sync/fba-plan-operation.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
const throws = (n, fn, re) => { let e = null; try { fn(); } catch (x) { e = x; } ok(n, !!e && re.test(String(e.message))); };
const src = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const J = (x) => JSON.stringify(x);
writeSync(1, "publication-recovery-units\n");

/* A. the ROUTE registry: every key classified exactly once; violations fail closed */
{
  const v = validateRouteRegistry();
  const compat = validateRecoveryRegistry();
  const vReal = validateRouteRegistry({ liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS });
  const cls = (k) => (classifyReportKey(k) || {}).cls;
  ok("A1: every live contract key + every materialization key is classified (pinned table AND the real SCHEDULER_LIVE_SNAPSHOT_CONTRACTS)", Object.keys(SCHEDULER_LIVE_SNAPSHOT_CONTRACTS).every((k) => classifyReportKey(k)) && Object.keys(REPORT_MATERIALIZATION).every((k) => classifyReportKey(REPORT_MATERIALIZATION[k].reportKey || k)) && vReal.universe.length === v.universe.length && v.universe.every((k) => compat[k] && compat[k].cls === classifyReportKey(k).cls) && J(compat["returns-leakage-v3"]) === J(compat["returns-leakage"]));
  ok("A2: the four legacy families are routes -- brand-sales route:oli, daily-reporting route:oli+ads, brand-inventory route:oli+fba, listing-health-v3 route:listings", cls("brand-sales") === "route:oli" && cls("daily-reporting") === "route:oli+ads" && cls("brand-inventory") === "route:oli+fba" && cls("listing-health-v3") === "route:listings");
  ok("A3: the 10 active publication-required keys EACH map to a route; detect-only is removed (fba-plan / sku-movement / returns-leakage / brand-view* are route-owned)", ACTIVE_PUBLICATION_REPORT_KEYS.length === 10 && ACTIVE_PUBLICATION_REPORT_KEYS.every((k) => classifyReportKey(k).kind === "route") && cls("fba-plan") === "route:fba-plan" && cls("sku-movement") === "route:sku-movement" && cls("returns-leakage") === "route:returns-v3" && cls("brand-view-brands") === "route:brand-view-brands" && cls("brand-view") === "route:brand-view" && cls("brand-view-portfolio") === "route:brand-view-portfolio" && !("detectOnlyReports" in REGISTRY));
  ok("A4: ppc-performance is manual-paid (the Ads route publishes ONLY what the Ads CLI reconciles: daily-reporting)", cls("ppc-performance") === "manual-paid" && J(routeById("ads").publisherKeys) === J(ADS_CLI_OPERATION_REPORT_KEYS) && J(routeById("ads").liveReportKeys) === J(["daily-reporting"]));
  ok("A5: the unserved returns-leakage v2 dispatch CONTRACT is legacy-superseded:returns-v3; the publisher key returns-leakage-v3 is route:returns-v3", CONTRACT_CLASSIFICATION_OVERRIDES["returns-leakage"].cls === "legacy-superseded:returns-v3" && cls("returns-leakage-v3") === "route:returns-v3" && SCHEDULER_LIVE_SNAPSHOT_CONTRACTS["returns-leakage"].liveReportVersion === "returns-leakage-v2");
  throws("A6: NEW REPORT REGISTRATION -- a live contract with no classification fails closed", () => validateRouteRegistry({ liveContracts: { ...SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, "new-report": { liveReportKey: "new-report" } } }), /new-report.*unclassified.*fail closed/);
  throws("A7: C10 -- a scheduler-materialized report classified as anything but a route fails closed", () => validateRouteRegistry({ classification: REPORT_RECOVERY_CLASSIFICATION_ENTRIES.map((e) => (e.reportKey === "sku-movement" ? { ...e, cls: "manual-paid" } : e)) }), /sku-movement/);
  throws("A8: a double classification fails closed", () => validateRouteRegistry({ classification: [...REPORT_RECOVERY_CLASSIFICATION_ENTRIES, { reportKey: "sales", cls: "dormant", reason: "x" }] }), /double-classified/);
  ok("A9: the Ads route's evidence token reads exactly the daily-reporting grain's worker key", J(adsEvidenceWorkerKeys()) === J(["campaign-performance-v1"]));
  ok("A10: PUBLICATION_ROUTES in priority order (oli, listings, fba-plan, returns-v3, ads, fba, brand-view-brands, sku-movement, brand-view, brand-view-portfolio); the awaits topo order keeps every upstream first", J(ROUTE_IDS) === J(["oli", "listings", "fba-plan", "returns-v3", "ads", "fba", "brand-view-brands", "sku-movement", "brand-view", "brand-view-portfolio"]) && PUBLICATION_ROUTES.every((r) => r.awaits.every((a) => topoOrder().indexOf(a) < topoOrder().indexOf(r.id))) && J(v.order) === J(topoOrder()));
  ok("A11: every non-route class carries a reason; every class string parses; the hand-off of a non-route class is not-applicable:<type>", [...REPORT_RECOVERY_CLASSIFICATION.values()].every((e) => e.kind === "route" || e.reason.trim().length > 10) && handoffForReportClass(classifyReportKey("sku-pl")) === "not-applicable:manual-paid" && handoffForReportClass(classifyReportKey("brand-directory")) === "not-applicable:read-only-self-heal" && handoffForReportClass(classifyReportKey("brand-sales")) === null && classifyReportKey("scheduler-v2/fba-plan").kind === "shadow-namespace-never-live");
  ok("A12: the legacy families are EXACTLY the four legacy-cli routes; the ffb035b four-family COMPAT view is REMOVED (WP12: the worker drives routes.js)", J(LEGACY_ROUTE_IDS) === J(["oli", "listings", "ads", "fba"]) && LEGACY_ROUTE_IDS.every((f) => LEGACY_CLI_SCRIPTS.includes(routeById(f).cli.script)) && ["RECOVERY_FAMILIES", "FAMILY_IDS", "detectOnlyReports", "adsEvidenceWorkerKeys", "routesForLiveReport", "ROUTE_REGISTRY_IDS"].every((k) => !(k in REGISTRY)) && ["buildReconcileArgs", "runReconcile"].every((k) => !(k in RUNNER)) && typeof REGISTRY.validateRecoveryRegistry === "function");
}

/* B. every route: exact argv, zero-export flags, never immediate/scheduler, never full-region live */
{
  // The PRE-ROUTE runner's argv, frozen verbatim (the four legacy CLIs must be byte-identical).
  const LEGACY = { oli: ["scripts/release/oli-publication-reconcile.mjs", 330], ads: ["scripts/release/ads-publication-reconcile.mjs", 330], fba: ["scripts/release/fba-publication-reconcile.mjs", 330], listings: ["scripts/release/listing-health-v3-reconcile.mjs", 720] };
  for (const f of LEGACY_ROUTE_IDS) {
    const [script, dl] = LEGACY[f];
    const tok = "prw-w-x-europe-au-1-abc";
    const live = buildRouteArgs({ route: f, region: "europe-au", asOf: "2026-09-23", targets: ["b", "a", "a"], kind: "live", runToken: tok });
    const dry = buildRouteArgs({ route: f, region: "europe-au", asOf: "2026-09-23", kind: "dry-run" });
    const dryAcc = buildRouteArgs({ route: f, region: "europe-au", asOf: "2026-09-23", targets: ["a"], kind: "dry-run" });
    const clean = buildRouteArgs({ route: f, region: "europe-au", asOf: "2026-09-23", kind: "cleanup", runToken: tok });
    const head = [script, "--bucket=europe-au", "--as-of=2026-09-23", "--mode=periodic"];
    ok(`B1[${f}]: live argv BYTE-IDENTICAL to the pre-route runner (existing CLI, periodic, sorted de-duped accounts, own deadline, token, --emit-targets, --live)`, J(live) === J([...head, "--accounts=a,b", `--deadline-seconds=${dl}`, `--run-token=${tok}`, "--emit-targets", "--live"]));
    ok(`B2[${f}]: dry-run / cleanup argv byte-identical; 'verify' on a legacy CLI is its dry-run (no manifest pass)`, J(dry) === J([...head, `--deadline-seconds=${dl}`, "--emit-targets"]) && J(dryAcc) === J([...head, "--accounts=a", `--deadline-seconds=${dl}`, "--emit-targets"]) && J(clean) === J([...head, `--run-token=${tok}`, "--cleanup"]) && J(buildRouteArgs({ route: f, region: "europe-au", asOf: "2026-09-23", kind: "verify" })) === J(dry));
    ok(`B3[${f}]: no argv ever selects immediate mode or --outbox-drain`, ![...live, ...dry, ...clean].some((a) => /immediate|outbox-drain/.test(a)));
    ok(`B4[${f}]: the handler script exists, is not forbidden, and prints the TARGETS hook for its own family`, !isForbiddenWorkerScript(script) && src(script).includes(`formatTargetsLine({ family: "${f}"`) && src(script).includes('process.argv.includes("--emit-targets")'));
  }
  throws("B5: a live pass without an explicit account list is refused (never a full-region live pass)", () => buildRouteArgs({ route: "oli", region: "india", asOf: "2026-09-23", kind: "live", runToken: "prw-x-oli-india-1-a" }), /non-empty account list/);
  throws("B6: a live pass without a run token is refused", () => buildRouteArgs({ route: "oli", region: "india", asOf: "2026-09-23", targets: ["a"], kind: "live" }), /run token/);
  throws("B7: a malformed account is refused", () => buildRouteArgs({ route: "oli", region: "india", asOf: "2026-09-23", targets: ["a b"], kind: "dry-run" }), /malformed account/);
  const tok = makeRunToken({ workerId: "vm 1/main", route: "brand-view-portfolio", region: "europe-au", now: 1, nonce: "n" });
  ok("B8: run tokens are canonical (no whitespace, <=150 chars -- the route CLI's bound) and unique per invocation", /^[A-Za-z0-9._:-]+$/.test(tok) && tok.length <= 150 && makeRunToken({ workerId: "w", route: "oli", region: "india", now: 1 }) !== makeRunToken({ workerId: "w", route: "oli", region: "india", now: 1 }));
  ok("B9: the Ads CLI still runs ONLY its daily-reporting operation (registry pinned to the CLI source)", (src("scripts/release/ads-publication-reconcile.mjs").match(/buildOperation\("/g) || []).length === 1 && src("scripts/release/ads-publication-reconcile.mjs").includes('buildOperation("daily-reporting"'));
  ok("B10: backstop deadlines match the workflows (330/420 + LHv3 720/840)", ["oli", "fba", "ads"].every((f) => src(`../.github/workflows/${f}-publication-reconcile.yml`).includes("--deadline-seconds=330") && routeById(f).deadlineSeconds === 330 && routeById(f).hardTimeoutSeconds === 420) && src("../.github/workflows/listing-health-v3-reconcile.yml").includes("--deadline-seconds=720") && routeById("listings").deadlineSeconds === 720 && routeById("listings").hardTimeoutSeconds === 840);
  // route-cli argv
  const T = "prw-w-returns-v3-india-1-abc";
  const rbase = ["scripts/release/publication-route-reconcile.mjs", "--route=returns-v3", "--bucket=india", "--as-of=2026-09-24", "--mode=periodic"];
  ok("B11: route-cli argv = [script, --route, --bucket, --as-of, --mode=periodic, --targets=<sorted>, --deadline-seconds, --emit-targets] + --verify-exact (verify) | --run-token --live (live) | --run-token --live --verify-exact (repair)",
    J(buildRouteArgs({ route: "returns-v3", region: "india", asOf: "2026-09-24", targets: ["B", "A"], kind: "dry-run" })) === J([...rbase, "--targets=A,B", "--deadline-seconds=330", "--emit-targets"])
    && J(buildRouteArgs({ route: "returns-v3", region: "india", asOf: "2026-09-24", kind: "verify" })) === J([...rbase, "--deadline-seconds=330", "--emit-targets", "--verify-exact"])
    && J(buildRouteArgs({ route: "returns-v3", region: "india", asOf: "2026-09-24", targets: ["A"], kind: "live", runToken: T })) === J([...rbase, "--targets=A", "--deadline-seconds=330", "--emit-targets", `--run-token=${T}`, "--live"])
    && J(buildRouteArgs({ route: "returns-v3", region: "india", asOf: "2026-09-24", targets: ["A"], kind: "repair", runToken: T })) === J([...rbase, "--targets=A", "--deadline-seconds=330", "--emit-targets", `--run-token=${T}`, "--live", "--verify-exact"])
    && J(buildRouteArgs({ route: "returns-v3", region: "india", asOf: "2026-09-24", kind: "cleanup", runToken: T })) === J([...rbase, `--run-token=${T}`, "--cleanup"]));
  throws("B11b: a route-cli live pass WITHOUT --run-token is refused (the CLI now STOPs without it)", () => buildRouteArgs({ route: "returns-v3", region: "india", asOf: "2026-09-24", targets: ["A"], kind: "live" }), /run token/);
  throws("B11c: a route-cli live pass without targets is refused", () => buildRouteArgs({ route: "sku-movement", region: "india", asOf: "2026-09-24", kind: "repair", runToken: T }), /non-empty target list/);
  throws("B11d: more than 25 targets per route CLI run is refused", () => buildRouteArgs({ route: "brand-view", region: "india", asOf: "2026-09-24", targets: Array.from({ length: 26 }, (_, i) => "A" + i), kind: "dry-run" }), /at most 25/);
  throws("B11e: the worker never selects --mode=scheduler / immediate", () => buildRouteArgs({ route: "returns-v3", region: "india", asOf: "2026-09-24", kind: "dry-run", mode: "scheduler" }), /periodic/);
  throws("B11f: a legacy route has no repair (--verify-exact) pass", () => buildRouteArgs({ route: "oli", region: "india", asOf: "2026-09-24", targets: ["A"], kind: "repair", runToken: T }), /no --verify-exact/);
  ok("B11g: region-grain targets are 'region:<bucket>' (ACCOUNT_RE widened to 160 incl. ':'); a foreign region target is refused", J(buildRouteArgs({ route: "brand-view-portfolio", region: "us-ca", asOf: "2026-09-24", targets: ["region:us-ca"], kind: "live", runToken: T }).slice(5, 6)) === J(["--targets=region:us-ca"]));
  throws("B11h: ... a foreign region target is refused", () => buildRouteArgs({ route: "brand-view-portfolio", region: "us-ca", asOf: "2026-09-24", targets: ["region:india"], kind: "dry-run" }), /region-grain/);
  const NOW = Date.UTC(2026, 8, 25, 0, 30);
  ok("B12: the fba-plan --as-of MUST be fbaInventoryAsOf(now) (UTC D-1; fba-plan-operation.js) -- routes.utcDMinus1 is that function", [0, NOW, Date.UTC(2026, 0, 1, 23, 59, 59), Date.UTC(2024, 2, 1, 0, 0)].every((t) => utcDMinus1(t) === fbaInventoryAsOf(t)) && buildRouteArgs({ route: "fba-plan", region: "india", asOf: fbaInventoryAsOf(NOW), kind: "dry-run", now: NOW }).includes("--as-of=2026-09-24"));
  throws("B12b: an fba-plan pass at any other as-of (or without now) is refused -- only its cleanup keeps the run's own as-of", () => buildRouteArgs({ route: "fba-plan", region: "india", asOf: "2026-09-23", kind: "dry-run", now: NOW }), /fbaInventoryAsOf/);
  const backfills = readdirSync(new URL("../scripts/release/", import.meta.url)).filter((f) => /^backfill-.*\.mjs$/.test(f));
  ok("B13: FORBIDDEN_WORKER_SCRIPTS += returns-leakage-golive.mjs, backfill-sku-movement.mjs and EVERY scripts/release/backfill-*.mjs (enumerated + by pattern, incl. a future one)", ["returns-leakage-golive.mjs", "backfill-sku-movement.mjs"].every((s) => FORBIDDEN_WORKER_SCRIPTS.includes(s)) && backfills.length >= 4 && backfills.every((f) => FORBIDDEN_WORKER_SCRIPTS.includes(f) && isForbiddenWorkerScript("scripts/release/" + f)) && isForbiddenWorkerScript("backfill-future-thing.mjs") && !isForbiddenWorkerScript("publication-route-reconcile.mjs"));
}

/* B'. the guard preload + machine-line parsing (fake child; nothing spawned) */
{
  const fakeSpawn = (script) => {
    const calls = [];
    const impl = (exe, args, opts) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
      calls.push({ exe, args, opts });
      setImmediate(() => {
        for (const [stream, line] of script) child[stream].write(line + "\n");
        child.stdout.end(); child.stderr.end();
        setImmediate(() => child.emit("close", script.exitCode ?? 0, script.signal ?? null));
      });
      return child;
    };
    impl.calls = calls;
    return impl;
  };
  const targetsV1 = formatTargetsLine({ family: "oli", summary: { bucket: "india", requestedAsOf: "2026-09-24", dryRun: true, perAccount: [{ accountId: "A", eligible: true, revisionId: "r", status: "nonempty", reports: { "brand-sales": { state: "PUBLICATION_NOT_REQUIRED", reason: null } } }] } });
  const clean = Object.assign([["stdout", targetsV1], ["stdout", 'RESULT {"ok":true,"dataDoeCreates":0,"dataDoeTokens":0}'], ["stderr", 'ZEROEXPORT {"blocked":0,"allowedAccountsGets":1,"final":true}']], { exitCode: 0 });
  const sp1 = fakeSpawn(clean);
  const r1 = await runRoute({ appRoot: process.cwd(), route: "oli", region: "india", asOf: "2026-09-24", kind: "dry-run", spawnImpl: sp1, childMaxOldSpaceMb: 448 });
  const no = sp1.calls[0].opts.env.NODE_OPTIONS;
  ok("C5: the guard preload is present in EVERY child's NODE_OPTIONS (--max-old-space-size=<heap> --import=<file URL of zero-export-guard.mjs>); a legacy CLI's heap stays PRW_CHILD_MAX_OLD_SPACE_MB", /^--max-old-space-size=448 --import=file:\/\/\S+\/lib\/server\/recovery\/zero-export-guard\.mjs$/.test(no) && zeroExportGuardUrl(process.cwd()) === no.split("--import=")[1] && r1.heapMb === 448 && classifyRun(r1) === null && r1.zeroExport.blocked === 0 && r1.zeroExport.allowedAccountsGets === 1 && r1.targetsV2.targets[0].id === "A");
  const sp2 = fakeSpawn(Object.assign([["stdout", targetsV1], ["stderr", 'ZEROEXPORT {"blocked":1,"allowedAccountsGets":0}'], ["stdout", 'RESULT {"ok":true,"dataDoeCreates":0,"dataDoeTokens":0}']], { exitCode: 0 }));
  const r2 = await runRoute({ appRoot: process.cwd(), route: "returns-v3", region: "india", asOf: "2026-09-24", kind: "dry-run", spawnImpl: sp2 });
  const sp3 = fakeSpawn(Object.assign([["stdout", 'ZEROEXPORT {"blocked":2,"allowedAccountsGets":0,"final":true}'], ["stdout", targetsV1]], { exitCode: 0 }));
  const r3 = await runRoute({ appRoot: process.cwd(), route: "oli", region: "india", asOf: "2026-09-24", kind: "dry-run", spawnImpl: sp3 });
  ok("C6: a ZEROEXPORT line with blocked>0 on stderr OR stdout trips the route (ZERO_EXPORT_VIOLATION) even when the child exits 0 with a green RESULT", classifyRun(r2).cls === CLASSES.ZERO_EXPORT_VIOLATION && classifyRun(r3).cls === CLASSES.ZERO_EXPORT_VIOLATION && r3.zeroExport.blocked === 2 && outcomeFor(CLASSES.ZERO_EXPORT_VIOLATION).outcome === "dead");
  const { formatZeroExportLine, parseZeroExportLine: guardParse } = await import("../lib/server/recovery/zero-export-guard.mjs");
  const zl = [formatZeroExportLine({ blocked: 3, allowedAccountsGets: 1 }, { final: true }), "ZEROEXPORT {bad", "ZEROEXPORT {\"x\":1}", "NOPE"];
  ok("C7: the runner's ZEROEXPORT parser is the guard's own rule (identical on well-formed and malformed lines)", zl.every((l) => J(runnerParseZeroExport(l)) === J(guardParse(l))));
  const sp4 = fakeSpawn(Object.assign([["stderr", "<--- Last few GCs --->"], ["stderr", "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory"]], { exitCode: 134, signal: null }));
  const r4 = await runRoute({ appRoot: process.cwd(), route: "brand-view", region: "india", asOf: "2026-09-24", kind: "dry-run", spawnImpl: sp4 });
  const r5 = await runRoute({ appRoot: process.cwd(), route: "brand-view-portfolio", region: "india", asOf: "2026-09-24", kind: "dry-run", spawnImpl: fakeSpawn([]), childMaxOldSpaceMb: 256 });
  ok("C8: a V8 heap OOM child and a heap cap below the route's minimum both classify capacity-exceeded (the latter WITHOUT spawning)", classifyRun(r4).cls === CLASSES.CAPACITY_EXCEEDED && classifyRun(r5).cls === CLASSES.CAPACITY_EXCEEDED && r5.capacityExceeded === "child-heap-cap-below-minimum" && childHeapFor(routeById("brand-view-portfolio"), 448) === 448 && childHeapFor(routeById("sku-movement"), 448) === 384);
  const sp6 = fakeSpawn(Object.assign([["stderr", "STOP FBA_PLAN_ROUTE_FENCE_NOT_ATTESTED: FBA_PLAN_ROUTE_FENCE_ATTESTED is not exactly 'true' -- fail closed."]], { exitCode: 2 }));
  const r6 = await runRoute({ appRoot: process.cwd(), route: "fba-plan", region: "india", asOf: fbaInventoryAsOf(Date.now()), targets: ["A"], kind: "live", runToken: "prw-w-fba-plan-india-1-abc", spawnImpl: sp6 });
  const sp7 = fakeSpawn(Object.assign([["stderr", "STOP ROUTE_DIRECTORY_EMPTY: the durable account directory is empty -- fail closed, zero writes."]], { exitCode: 1 }));
  const r7 = await runRoute({ appRoot: process.cwd(), route: "returns-v3", region: "india", asOf: "2026-09-24", kind: "dry-run", spawnImpl: sp7 });
  ok("C9 (WP11 fixer P3): NOT_ACTIVATED_STOP_CODES is the EXPLICIT list read from the emitters -- EMPTY (no allowed CLI STOPs on an attestation; fba-plan's fence surfaces per unit) -- so any STOP (even a made-up *_NOT_ATTESTED one) is a run failure + alert; route-not-activated is deferred (never terminal) and hands off 'deferred' (P2a), never not-applicable", NOT_ACTIVATED_STOP_CODES.size === 0 && classifyRun(r6).cls === CLASSES.RUN_FAILED && classifyRun(r6).alert === "route-cli-stop" && /stop:FBA_PLAN_ROUTE_FENCE_NOT_ATTESTED/.test(classifyRun(r6).reason) && classifyRun({ stop: { code: "ATTESTATION_READ_FAILED" }, exitCode: 2 }).cls === CLASSES.RUN_FAILED && handoffClass(CLASSES.ROUTE_NOT_ACTIVATED) === HANDOFF_CLASSES.DEFERRED && outcomeFor(CLASSES.ROUTE_NOT_ACTIVATED).outcome === "deferred" && classifyRun(r7).cls === CLASSES.RUN_FAILED && classifyRun(r7).alert === "route-cli-stop" && r6.args.includes("--targets=<1>"));
}

/* C. structural zero-export: nothing in the worker can reach DataDoe export code */
{
  // Recursive: the worker-side route modules (lib/server/recovery/routes/*.route.js) are worker code too.
  const files = readdirSync(new URL("../lib/server/recovery/", import.meta.url), { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => (d.parentPath || d.path).replace(/\\/g, "/").replace(/^.*\/lib\/server\/recovery\/?/, "lib/server/recovery/").replace(/\/?$/, "/") + d.name).concat(readdirSync(new URL("../scripts/worker/", import.meta.url)).map((f) => "scripts/worker/" + f));
  // Code only: route modules cite their serve source ("api/datadoe.js brandViewDirectory") in whole-line / block comments.
  const code = (f) => src(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // Offline PGlite self-test TOOLS (scripts/worker/*-selftest.mjs) legitimately name the CAS they exercise against an
  // in-memory database; they are never part of the worker runtime (C1b proves the entrypoint never imports one).
  const isSelftestTool = (f) => /^scripts\/worker\/[a-z0-9-]+-selftest\.mjs$/.test(f);
  const bad = files.filter((f) => !isSelftestTool(f) && /datadoe\.js|createExport|fetchExportRows|makeDataDoeAdapter|datadoe-usage|acquire_control_plane_lease|cas_report_snapshot|publishSchedulerV2Snapshot|saveReportSnapshot/.test(code(f)));
  ok("C1: no worker module imports/names DataDoe export code, the lease acquire, the snapshot CAS, or the publisher", bad.length === 0);
  ok("C1b: no worker module (entrypoint, lib/server/recovery/**) imports an offline *-selftest.mjs tool",
    files.filter((f) => !isSelftestTool(f)).every((f) => !/-selftest\.mjs["']/.test(code(f))));
  const spawnSites = files.filter((f) => /child_process/.test(src(f)));
  ok("C2: only the runner (and the offline memcheck RSS sampler) touch child_process -- the production entrypoint spawns nothing itself", spawnSites.every((f) => /runner\.js$|publication-recovery-memcheck\.mjs$/.test(f)) && files.some((f) => /publication-recovery-worker\.mjs$/.test(f)) && !/child_process/.test(src("scripts/worker/publication-recovery-worker.mjs")));
  ok("C3: the runner resolves scripts ONLY through the route registry (routeById) + the worker allow-list + the forbidden check", /const r = routeById\(route\)/.test(src("lib/server/recovery/runner.js")) && /ALLOWED_WORKER_SCRIPTS\.includes\(script\)/.test(src("lib/server/recovery/runner.js")) && /isForbiddenWorkerScript\(base\)/.test(src("lib/server/recovery/runner.js")));
  ok("C4: no new api/*.js serverless function was added (Vercel cap)", !files.some((f) => f.startsWith("api/")));
}

/* D. classification v2 */
{
  const acc = (m) => ({ id: "a", reports: Object.fromEntries(Object.entries(m).map(([k, s]) => [k, { s: s[0], r: s[1] || null }])) });
  ok("D1: all PUBLICATION_NOT_REQUIRED -> current; any provenance -> missing-evidence; any STALE -> stale", accountVerdict(acc({ x: ["PUBLICATION_NOT_REQUIRED"] }), ["x"]).cls === CLASSES.CURRENT && accountVerdict(acc({ x: ["DEFERRED_PROVENANCE", "no-oli"] }), ["x"]).cls === CLASSES.MISSING_EVIDENCE && accountVerdict(acc({ x: ["STALE"], y: ["PUBLICATION_NOT_REQUIRED"] }), ["x", "y"]).cls === CLASSES.STALE);
  ok("D2: a report missing from the TARGETS line is never assumed current", accountVerdict(acc({ x: ["PUBLICATION_NOT_REQUIRED"] }), ["x", "y"]).cls === CLASSES.UNKNOWN && outcomeFor(CLASSES.UNKNOWN).outcome === "deferred" && outcomeFor(CLASSES.UNKNOWN).alert === true);
  ok("D3: READBACK_VERIFIED from the publishing run alone is NOT current", accountVerdict(acc({ x: ["READBACK_VERIFIED"] }), ["x"]).cls === CLASSES.PUBLISHED_UNVERIFIED && outcomeFor(CLASSES.PUBLISHED_UNVERIFIED).outcome === "retry");
  const LG = { routeKind: "legacy-cli" };
  ok("D4: deferral classes (the legacy code 'catalog-stale' is typed -- no alert -- ONLY under the legacy kind; on a route it is an unmapped deferral + alert)", classifyDeferral("controls-not-opened:CONTROL_LEASE_HELD").cls === CLASSES.CONTENTION && classifyDeferral("deadline-in-flight").cls === CLASSES.TIMEOUT && classifyDeferral("cycle-not-running:succeeded").cls === CLASSES.TERMINAL_CYCLE && classifyDeferral("catalog-stale", LG).cls === CLASSES.DEPENDENCY && classifyDeferral("catalog-stale", LG).alert === null && classifyDeferral("catalog-stale", { routeKind: "route-cli" }).alert === "unmapped-reason:catalog-stale");
  ok("D5: failure classes (legacy kind: unchanged, incl. the ffb035b FAILED newer-live -> superseded); a ROUTE FAILED newer-live code is never superseded (P1: the superseded rule is DEFERRED_* only)", classifyFailure("FAILED_PUBLISH", "publish-newer-live", LG).cls === CLASSES.SUPERSEDED_NEWER_LIVE && classifyFailure("FAILED_DERIVE", "brand-inventory-payload-malformed", LG).cls === CLASSES.INTEGRITY && classifyFailure("FAILED_READBACK", "live-readback-failed", LG).cls === CLASSES.READBACK_MISMATCH && classifyFailure("FAILED_DERIVE", "release-threw", LG).cls === CLASSES.TRANSPORT && classifyFailure("FAILED_PUBLISH", "publish-newer-live", { routeKind: "route-cli" }).cls !== CLASSES.SUPERSEDED_NEWER_LIVE && classifyFailure("FAILED_DERIVE", "payload-too-large").cls === CLASSES.INTEGRITY && classifyFailure("FAILED_PUBLISH", "publish-threw:boom").cls === CLASSES.TRANSPORT);
  ok("D6: outcomes: contention/dependency/missing never burn an attempt; permanent classes dead-letter; retry backoff is exponential + capped", outcomeFor(CLASSES.CONTENTION).outcome === "deferred" && outcomeFor(CLASSES.MISSING_EVIDENCE).outcome === "deferred" && outcomeFor(CLASSES.INTEGRITY).outcome === "dead" && outcomeFor(CLASSES.TIMEOUT, { attempt: 0 }).backoff === 60 && outcomeFor(CLASSES.TIMEOUT, { attempt: 3 }).backoff === 480 && outcomeFor(CLASSES.TIMEOUT, { attempt: 20 }).backoff === 3600);
  ok("D7: run-level: timeout / no TARGETS / any DataDoe spend", classifyRun({ timedOut: true }).cls === CLASSES.TIMEOUT && classifyRun({ exitCode: 1, result: null, targets: null }).cls === CLASSES.TRANSPORT && classifyRun({ result: { dataDoeCreates: 1 }, targets: { v: 1, accounts: [] } }).cls === CLASSES.ZERO_EXPORT_VIOLATION && classifyRun({ result: {}, targets: { v: 1, accounts: [], dataDoeTokens: 0 } }) === null);
  // D8 the masking fix (ffb035b classifyRun :121-125): 'failed' WITH per-target entries classifies per target.
  const failedWithTargets = { exitCode: 1, result: { ok: false, outcome: "failed", code: "SOME_ROUTE_FAILED" }, targets: parseTargetsLine(formatTargetsLine({ v: 2, route: "returns-v3", summary: { bucket: "india", requestedAsOf: "2026-09-24", outcome: "failed", code: "X", perAccount: [{ accountId: "A", revisionId: "t", units: [{ unitKey: "-", targetAsOf: "2026-09-24", reports: { "returns-leakage-v3": { state: "PUBLICATION_NOT_REQUIRED", reason: null } } }] }, { accountId: "B", units: [{ unitKey: "-", targetAsOf: "2026-09-24", reports: { "returns-leakage-v3": { state: "DEFERRED_PROVENANCE", reason: "returns-evidence-missing" } } }] }] } })) };
  const failedEmpty = { exitCode: 1, result: { ok: false }, targets: parseTargetsLine(formatTargetsLine({ v: 2, route: "returns-v3", summary: { bucket: "india", requestedAsOf: "2026-09-24", outcome: "failed", code: "DURABLE_SOURCE_UNREADABLE", perAccount: [] } })) };
  const tv = new Map(normalizeTargets(failedWithTargets.targets).targets.map((t) => [t.id, t]));
  ok("D8: classifyRun: outcome 'failed' WITH populated targets classifies PER TARGET (A current -- current-unserved under the STRICT default without its served row (WP11 verifier F8), current under the legacy kind; B missing-evidence); only an EMPTY target list is RUN_FAILED", classifyRun(failedWithTargets) === null && jobVerdict(tv.get("A"), ["returns-leakage-v3"]).cls === CLASSES.CURRENT_UNSERVED && jobVerdict(tv.get("A"), ["returns-leakage-v3"], { routeKind: "legacy-cli" }).cls === CLASSES.CURRENT && jobVerdict(tv.get("B"), ["returns-leakage-v3"]).cls === CLASSES.MISSING_EVIDENCE && classifyRun(failedEmpty).cls === CLASSES.RUN_FAILED && /DURABLE_SOURCE_UNREADABLE/.test(classifyRun(failedEmpty).reason));
  // D9 EVERY HANDOFF typed reason -> its stated class (SUBSTRING match; releases prefix 'derive-not-ready:' / 'bundle-').
  const P = STATES.PROVENANCE, D = STATES.DEPENDENCY, C = STATES.CURRENT, F = STATES.FAILED_DERIVE;
  const table = [
    [D, "served-newer-to", CLASSES.SUPERSEDED_NEWER_LIVE], [D, "evidence-not-newer-than-live", CLASSES.SUPERSEDED_NEWER_LIVE], [D, "evidence-not-newer-than-served", CLASSES.SUPERSEDED_NEWER_LIVE],
    [D, "superseded-newer-live:served-newer-to", CLASSES.SUPERSEDED_NEWER_LIVE], [D, "superseded-newer-live:served-newer-inventory", CLASSES.SUPERSEDED_NEWER_LIVE], [D, "superseded-newer-live:served-newer-awd", CLASSES.SUPERSEDED_NEWER_LIVE],
    [D, "superseded-newer-live:paid-publish-pending:inventory", CLASSES.SUPERSEDED_NEWER_LIVE], [D, "superseded-newer-live:paid-publish-pending:to", CLASSES.SUPERSEDED_NEWER_LIVE], [D, "superseded-newer-live:paid-owned", CLASSES.SUPERSEDED_NEWER_LIVE],
    [D, "shadow-newer-live", CLASSES.SUPERSEDED_NEWER_LIVE], [D, "NEWER_LIVE", CLASSES.SUPERSEDED_NEWER_LIVE],
    [C, "source-stale-manual", CLASSES.CURRENT, "source-stale-manual"], [C, "unit-manifest-unchanged", CLASSES.CURRENT], [C, "content-equivalent", CLASSES.CURRENT], [C, "already-current", CLASSES.CURRENT],
    [P, "returns-evidence-missing", CLASSES.MISSING_EVIDENCE], [P, "catalog-missing", CLASSES.MISSING_EVIDENCE], [P, "oli-coverage-short", CLASSES.MISSING_EVIDENCE], [P, "directory-country-missing", CLASSES.MISSING_EVIDENCE],
    [P, "directory-region-unassigned", CLASSES.MISSING_EVIDENCE], [P, "no-sales-snapshot", CLASSES.MISSING_EVIDENCE], [P, "brand-source-out-of-line:fba-plan", CLASSES.MISSING_EVIDENCE],
    [P, "evidence-read-failed:storage-missing:brand-sales", CLASSES.MISSING_EVIDENCE, "storage-missing"], [P, "storage-missing:sku-pl", CLASSES.MISSING_EVIDENCE, "storage-missing"], [D, "membership-read-failed", CLASSES.MISSING_EVIDENCE],
    [P, "bundle-catalog-empty", CLASSES.MISSING_EVIDENCE], [P, "serve-token-underivable", CLASSES.MISSING_EVIDENCE], [P, "brand-list-invalid", CLASSES.MISSING_EVIDENCE, "evidence-ambiguous-or-invalid"], [P, "brand-target-unrepresentable", CLASSES.MISSING_EVIDENCE, "evidence-ambiguous-or-invalid"],
    [P, "fba-pointer-integrity:duplicate-pointer", CLASSES.INTEGRITY, "integrity"], [P, "catalog-pointer-integrity:sha", CLASSES.INTEGRITY, "integrity"], [P, "awd-pointer-integrity:x", CLASSES.INTEGRITY, "integrity"],
    [D, "derive-not-ready:capacity-exceeded:heap", CLASSES.CAPACITY_EXCEEDED, "capacity-exceeded"], [D, "derive-not-ready:capacity-exceeded:deadline", CLASSES.CAPACITY_EXCEEDED, "capacity-exceeded"],
    [D, "served-row-preempted:exact-today-row", CLASSES.SERVED_ROW_PREEMPTED, "served-row-preempted"],
    [D, "member-setting-up", CLASSES.DEPENDENCY], [P, "member-directory-ambiguous", CLASSES.MISSING_EVIDENCE, "evidence-ambiguous-or-invalid"], [D, "membership-evidence-advanced", CLASSES.EVIDENCE_ADVANCED],
    [P, "portfolio-scope-id-too-long", CLASSES.INTEGRITY, "portfolio-scope-id-too-long"], [D, "derive-not-ready:portfolio-build-failed", CLASSES.DEPENDENCY, "portfolio-build-failed"],
    [D, "latest-row-ambiguous:brand-inventory-available", CLASSES.DEPENDENCY, "latest-row-ambiguous"], [P, "latest-row-ambiguous:brand-sales", CLASSES.DEPENDENCY, "latest-row-ambiguous"],
    [D, "ads-rows-window-mismatch", CLASSES.EVIDENCE_ADVANCED], [D, "evidence-advanced:ads-rows", CLASSES.EVIDENCE_ADVANCED], [D, "evidence-inconsistent", CLASSES.EVIDENCE_ADVANCED],
    [D, "bundle-inventory-guard:served-unreadable", CLASSES.TRANSPORT, "guard-unreadable"], [D, "inventory-guard:live-unreadable", CLASSES.TRANSPORT, "guard-unreadable"], [D, "bundle-awd-regression-guard:served-unreadable", CLASSES.TRANSPORT, "guard-unreadable"],
    [D, "inventory-guard:paid-lineage-unreadable", CLASSES.TRANSPORT, "guard-unreadable"], [D, "bundle-inventory-guard:fetch-unordered", CLASSES.TRANSPORT, "guard-unreadable"], [D, "inventory-guard:awd-fetch-unordered", CLASSES.TRANSPORT, "guard-unreadable"],
    [D, "paid-job-in-flight", CLASSES.DEPENDENCY], [D, "bundle-paid-job-in-flight", CLASSES.DEPENDENCY], [D, "paid-job-raced-insert", CLASSES.TRANSPORT, "paid-job-raced-insert"], [D, "paid-job-stale-in-flight", CLASSES.DEPENDENCY, "paid-job-stale-in-flight"],
    [D, "publish-guard:lineage-advanced", CLASSES.EVIDENCE_ADVANCED], [D, "publish-guard:guard-missing", CLASSES.INTEGRITY, "publish-guard-defect"], [D, "publish-guard:guard-mismatch", CLASSES.INTEGRITY, "publish-guard-defect"],
    [D, "publish-guard-threw:boom", CLASSES.TRANSPORT, "publish-guard-threw"], [D, "hydrate-failed:brand-sales", CLASSES.TRANSPORT],
    [P, "brand-not-sold", CLASSES.NOT_APPLICABLE], [D, "evidence-instant-not-advanced", CLASSES.DEPENDENCY, "evidence-instant-not-advanced"],
    [F, "derive-threw:fba-plan-route-fence-not-attested:", CLASSES.ROUTE_NOT_ACTIVATED, "route-not-activated"], [P, "coverage-incomplete", CLASSES.MISSING_EVIDENCE], [P, "no-marketplace", CLASSES.MISSING_EVIDENCE], [D, "brand-directory-unpublished", CLASSES.DEPENDENCY],
    // WP11 fixer P1: the refused-shadow codes + the stamp inversion (never the generic benign superseded).
    [F, "shadow-newer-live:content-differs", CLASSES.INTEGRITY, "shadow-content-differs"], [D, "shadow-newer-live:shadow-payload-unavailable", CLASSES.TRANSPORT, "shadow-newer-live-unreadable"],
    [D, "shadow-newer-live:shadow-missing", CLASSES.TRANSPORT, "shadow-newer-live-unreadable"], [D, "shadow-newer-live:shadow-not-this-revision", CLASSES.TRANSPORT, "shadow-newer-live-unreadable"],
    [D, "superseded-newer-live:paid-publish-refused-by-route-stamp", CLASSES.SUPERSEDED_NEWER_LIVE, "paid-publish-refused-by-route-stamp"], [D, "bundle-superseded-newer-live:paid-publish-refused-by-route-stamp", CLASSES.SUPERSEDED_NEWER_LIVE, "paid-publish-refused-by-route-stamp"],
    [D, "fba-plan-route-fence-not-attested", CLASSES.ROUTE_NOT_ACTIVATED, "route-not-activated"],
    // WP13 verifier P2-2: sku-movement defers every LIVE write while SKU_MOVEMENT_SERVE_TOKEN_ATTESTED is unset (derive gate + publishGuard).
    [D, "derive-not-ready:sku-movement-serve-not-attested:route-not-activated", CLASSES.ROUTE_NOT_ACTIVATED, "route-not-activated"], [D, "sku-movement-serve-not-attested:route-not-activated", CLASSES.ROUTE_NOT_ACTIVATED, "route-not-activated"],
    // WP7 round 4 / final: the fill-only guard + paid-cycle vocabulary.
    [D, "inventory-guard:sales-asof-unordered", CLASSES.TRANSPORT, "guard-unreadable"], [D, "bundle-inventory-guard:sales-asof-missing", CLASSES.TRANSPORT, "guard-unreadable"], [D, "inventory-guard:paid-cycle-unreadable", CLASSES.TRANSPORT, "guard-unreadable"],
    [D, "bundle-inventory-guard:paid-cycle-unreadable", CLASSES.TRANSPORT, "guard-unreadable"], [D, "paid-cycle-open:us-ca-fba", CLASSES.DEPENDENCY, null], [D, "bundle-paid-cycle-open:non-us-fba", CLASSES.DEPENDENCY, null],
    [D, "paid-cycle-stale-open:india-fba", CLASSES.DEPENDENCY, "paid-cycle-stale-open"], [D, "bundle-paid-cycle-stale-open:us-ca-fba", CLASSES.DEPENDENCY, "paid-cycle-stale-open"],
    // P3: '*-advanced' -> re-armed; served-row-unreadable / target-not-this-region / content-derive-failed explicit.
    [D, "bundle-fingerprint-inputs-advanced:ads", CLASSES.EVIDENCE_ADVANCED, null], [D, "derive-not-ready:dep-fingerprint-advanced", CLASSES.EVIDENCE_ADVANCED, null], [D, "brand-list-advanced", CLASSES.EVIDENCE_ADVANCED, null],
    [D, "bundle-unit-identity-changed", CLASSES.EVIDENCE_ADVANCED, null], [D, "served-row-unreadable", CLASSES.TRANSPORT, null], [P, "target-not-this-region", CLASSES.CONFIG_ALERT, "target-not-this-region"],
    [STATES.STALE, "content-derive-failed", CLASSES.STALE, "content-derive-failed"],
    // P2b: a route derive that refused its own payload identity is integrity; the returns / settlement duplicate-PK read is alerted.
    [D, "derive-not-ready:payload-account-mismatch", CLASSES.INTEGRITY, "derive-mismatch"], [D, "derive-not-ready:payload-asof-mismatch", CLASSES.INTEGRITY, "derive-mismatch"], [D, "derive-not-ready:payload-latest-date-mismatch", CLASSES.INTEGRITY, "derive-mismatch"],
    [D, "bundle-evidence-inconsistent:returns-duplicate", CLASSES.EVIDENCE_ADVANCED, "history-duplicate-key"], [D, "bundle-evidence-inconsistent:settlement-duplicate", CLASSES.EVIDENCE_ADVANCED, "history-duplicate-key"],
    [D, "bundle-evidence-inconsistent:asof", CLASSES.EVIDENCE_ADVANCED, null],
  ];
  const bad = table.filter(([s, r, c, a]) => { const v = classifyReason(s, r, {}); return v.cls !== c || (a !== undefined && v.alert !== a); });
  ok(`D9: every HANDOFF typed reason (${table.length}) classifies to its stated class + alert -- SUBSTRING match through 'derive-not-ready:' / 'bundle-' prefixes` + (bad.length ? " BAD: " + J(bad.map((b) => [b[1], classifyReason(b[0], b[1], {})])) : ""), bad.length === 0);
  const fbaInstant = classifyReason(D, "evidence-instant-not-advanced", { routeId: "fba-plan" });
  const otherInstant = classifyReason(D, "evidence-instant-not-advanced", { routeId: "returns-v3" });
  ok("D9b (WP11 fixer P3): fba-plan fill-only: evidence-instant-not-advanced keeps its reason VERBATIM with note 'awaiting-next-fba-fetch' and NO alert (the accepted WP7 fill-only deviation; deferred, never current); every other route keeps the alert and no note", fbaInstant.cls === CLASSES.DEPENDENCY && fbaInstant.reason === "evidence-instant-not-advanced" && fbaInstant.note === FBA_PLAN_EVIDENCE_INSTANT_NOTE && FBA_PLAN_EVIDENCE_INSTANT_NOTE === "awaiting-next-fba-fetch" && fbaInstant.alert === null && outcomeFor(fbaInstant.cls).outcome === "deferred" && otherInstant.alert === "evidence-instant-not-advanced" && otherInstant.note === null && jobVerdict({ id: "A", tok: "t", units: [{ u: "-", rk: "fba-plan", s: D, r: "evidence-instant-not-advanced" }] }, ["fba-plan"], { routeId: "fba-plan", routeKind: "route-cli" }).note === "awaiting-next-fba-fetch");
  ok("D9c: sku-movement 'served-row-preempted:serve-rederives' before SKU_MOVEMENT_SERVE_TOKEN_ATTESTED is the expected pre-WP10 state (alert 'serve-not-attested'); attested -> the ordinary preempted alert", classifyReason(D, "served-row-preempted:serve-rederives", {}).alert === "serve-not-attested" && classifyReason(D, "served-row-preempted:serve-rederives", { skuMovementServeAttested: true }).alert === "served-row-preempted");
  ok("D9d (WP11 fixer P3): 'epoch-not-current-d1' (bare or bundle-): the runner only spawns fba-plan at --as-of == fbaInventoryAsOf(spawn), so an as-of EQUAL to or ONE day behind the verdict-time D-1 (the UTC midnight rolled mid-run, incl. a verdict measured after a long live child) is a re-armed retry; an as-of the roll cannot explain (2+ days, a future one, or no run context) is a CONFIG alert", classifyReason(P, "bundle-epoch-not-current-d1", { argAsOf: "2026-09-24", expectedAsOf: "2026-09-24" }).cls === CLASSES.EVIDENCE_ADVANCED && classifyReason(P, "epoch-not-current-d1", { argAsOf: "2026-09-23", expectedAsOf: "2026-09-24" }).cls === CLASSES.EVIDENCE_ADVANCED && classifyReason(P, "epoch-not-current-d1", { argAsOf: "2026-09-23", expectedAsOf: "2026-09-24" }).alert === null && classifyReason(D, "bundle-epoch-not-current-d1", { argAsOf: "2026-12-31", expectedAsOf: "2027-01-01" }).cls === CLASSES.EVIDENCE_ADVANCED && classifyReason(P, "epoch-not-current-d1", { argAsOf: "2026-09-22", expectedAsOf: "2026-09-24" }).cls === CLASSES.CONFIG_ALERT && classifyReason(P, "epoch-not-current-d1", { argAsOf: "2026-09-25", expectedAsOf: "2026-09-24" }).cls === CLASSES.CONFIG_ALERT && classifyReason(P, "epoch-not-current-d1", {}).alert === "as-of-not-utc-d1");
  // D10 unknown reasons / states fail closed.
  const unk = [classifyReason(C, "some-new-current-reason"), classifyReason(D, "zz-brand-new-deferral"), classifyReason(P, "zz-brand-new-ineligibility"), classifyReason(F, "zz-brand-new-failure"), classifyReason("WEIRD_STATE", "x"), classifyReason(STATES.PUBLISHED, null)];
  ok("D10: an UNKNOWN reason (on any state) or state classifies FAIL-CLOSED as a typed deferral + alert -- never current, never published", unk.slice(0, 5).every((v) => v.cls !== CLASSES.CURRENT && v.cls !== CLASSES.PUBLISHED_UNVERIFIED && ["deferred"].includes(outcomeFor(v.cls).outcome) && /unmapped-reason|unrecognized-state/.test(S(v.alert))) && unk[5].cls !== CLASSES.CURRENT);
  // D11 worst-unit ordering over a v2 target.
  const tgt = (rows) => ({ id: "A", owners: ["A"], tok: "t", units: rows.map(([u, s, r]) => ({ u, rk: "brand-view", s, r: r || null, asOf: "2026-09-24", h: null, sra: null, served: null })) });
  const order = [
    [[["u1", "PUBLICATION_NOT_REQUIRED"], ["u2", "DEFERRED_PROVENANCE", "no-oli"]], CLASSES.MISSING_EVIDENCE],
    [[["u1", "DEFERRED_PROVENANCE", "no-oli"], ["u2", "STALE", "live-refresh-differs"]], CLASSES.STALE],
    [[["u1", "STALE"], ["u2", "FAILED_PUBLISH", "publish-threw:boom"]], CLASSES.TRANSPORT],
    [[["u1", "FAILED_PUBLISH", "publish-threw:boom"], ["u2", "DEFERRED_PROVENANCE", "fba-pointer-integrity:x"]], CLASSES.INTEGRITY],
    [[["u1", "DEFERRED_DEPENDENCY", "superseded-newer-live:paid-owned"], ["u2", "DEFERRED_DEPENDENCY", "served-row-preempted:x"]], CLASSES.SERVED_ROW_PREEMPTED],
    [[["u1", "DEFERRED_DEPENDENCY", "superseded-newer-live:paid-owned"], ["u2", "PUBLICATION_NOT_REQUIRED"]], CLASSES.SUPERSEDED_NEWER_LIVE],
    [[["u1", "PUBLICATION_NOT_REQUIRED"], ["u2", "PUBLICATION_NOT_REQUIRED", "unit-manifest-unchanged"]], CLASSES.CURRENT],
  ];
  // (the units carry no served fields: the ordering is read under the explicit legacy kind -- an OMITTED kind is STRICT
  // since the WP11 verifier F8 fix and would read the all-current row as current-unserved; pinned in K4)
  ok("D11: jobVerdict takes the WORST unit: zero-export/integrity > failed > stale > preempted/dependency/missing-evidence > superseded > current", order.every(([rows, want]) => jobVerdict(tgt(rows), ["brand-view"], { routeKind: "legacy-cli" }).cls === want) && jobVerdict({ id: "A", units: [], r: "units-empty" }, ["brand-view"]).cls === CLASSES.DEPENDENCY && jobVerdict({ id: "A", units: [], r: "units-empty" }, ["brand-view"]).alert === "units-empty");
  // D12 normalizeTargets(v1) gives verdicts identical to the OLD (ffb035b) accountVerdict for the 4 families (frozen copy).
  const OLD = (() => {
    const Sx = (v) => (v == null ? "" : String(v));
    const oldDeferral = (r) => (/newer-live|NEWER_LIVE/i.test(r) ? "superseded-newer-live" : /^controls-not-opened|CONTROL_LEASE|lease-lost|leaseLost|control-apply|CONTROL_PLANE/i.test(r) ? "contention" : /^deadline-cleanup-reserved/i.test(r) ? "not-attempted" : /^deadline/i.test(r) ? "timeout" : /^cycle-not-running/i.test(r) ? "terminal-cycle-stuck" : "dependency-deferral");
    const oldFailure = (s, r) => (/newer-live|NEWER_LIVE/i.test(r) ? "superseded-newer-live" : /^cycle-not-running/i.test(r) ? "terminal-cycle-stuck" : /malformed|conflict|integrity|dangling|mismatch|invalid|payload-unreadable|not-d1|corrupt/i.test(r) ? "permanent-integrity" : (s === "FAILED_READBACK" || /readback/i.test(r)) ? "readback-mismatch" : "transport");
    return (account, keys) => {
      const reports = account.reports || {};
      const rows = keys.map((rk) => ({ rk, s: Sx(reports[rk] && reports[rk].s), r: reports[rk] ? reports[rk].r : null }));
      if (!rows.length || rows.some((x) => !x.s)) return "unclassified";
      if (rows.every((x) => x.s === "PUBLICATION_NOT_REQUIRED")) return "current";
      if (rows.find((x) => x.s === "DEFERRED_PROVENANCE")) return "missing-evidence";
      if (rows.find((x) => x.s === "STALE")) return "stale";
      const f = rows.find((x) => /^FAILED_/.test(x.s)); if (f) return oldFailure(f.s, Sx(f.r));
      const d = rows.find((x) => x.s === "DEFERRED_DEPENDENCY"); if (d) return oldDeferral(Sx(d.r));
      if (rows.every((x) => ["PUBLICATION_NOT_REQUIRED", "PUBLISHED_LIVE", "READBACK_VERIFIED"].includes(x.s))) return "published-unverified";
      return "unclassified";
    };
  })();
  const SHAPES = [["PUBLICATION_NOT_REQUIRED", null], ["STALE", "live-refresh-differs"], ["DEFERRED_PROVENANCE", "oli-provenance-missing"], ["DEFERRED_DEPENDENCY", "publish-newer-live"], ["DEFERRED_DEPENDENCY", "controls-not-opened:CONTROL_LEASE_HELD"], ["DEFERRED_DEPENDENCY", "deadline-cleanup-reserved"], ["DEFERRED_DEPENDENCY", "cycle-not-running:succeeded"], ["DEFERRED_DEPENDENCY", "brand-sales-candidate-to-mismatch"], ["FAILED_DERIVE", "payload-malformed"], ["FAILED_READBACK", "live-readback-failed"], ["FAILED_PUBLISH", "release-threw"], ["READBACK_VERIFIED", null], ["PUBLISHED_LIVE", null]];
  const mismatches = [];
  let compared = 0;
  for (const f of LEGACY_ROUTE_IDS) {
    const keys = [...routeById(f).liveReportKeys];
    const accounts = SHAPES.map(([s, r]) => ({ id: "A", eligible: true, rev: "r", status: "x", reports: Object.fromEntries(keys.map((k) => [k, { s, r }])) }));
    // Mixed shapes where the old and new orderings AGREE (current + one other; the documented reorderings are D11).
    for (const [s, r] of SHAPES.slice(1)) accounts.push({ id: "A", reports: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? { s, r } : { s: "PUBLICATION_NOT_REQUIRED", r: null }])) });
    for (const a of accounts) {
      const norm = normalizeTargets({ v: 1, family: f, bucket: "india", requestedAsOf: "2026-09-24", accounts: [a] });
      const nv = jobVerdict(norm.targets[0], keys, { routeKind: "legacy-cli" }).cls; const old = OLD(a, keys); compared += 1;
      if (nv !== old || accountVerdict(a, keys).cls !== nv) mismatches.push([f, J(a.reports).slice(0, 80), old, nv]);
    }
  }
  ok(`D12: normalizeTargets(v1) -> jobVerdict gives verdicts IDENTICAL to the old accountVerdict for the 4 families (${compared} v1 shapes: every state, homogeneous + current-mixed)` + (mismatches.length ? " BAD " + J(mismatches.slice(0, 3)) : ""), mismatches.length === 0 && compared >= 4 * 25);
  ok("D13: owner hand-off classes -- repaired (published + verified + SERVED proof) / already-current (+ served proof) / deferred (current WITHOUT the served proof: current-unserved) / missing-source / failed / not-applicable", handoffClass(CLASSES.CURRENT, { published: true, servedConfirmed: true }) === HANDOFF_CLASSES.REPAIRED && handoffClass(CLASSES.CURRENT, { servedConfirmed: true }) === HANDOFF_CLASSES.ALREADY_CURRENT && handoffClass(CLASSES.CURRENT) === HANDOFF_CLASSES.DEFERRED && handoffClass(CLASSES.CURRENT, { published: true, servedConfirmed: false }) === HANDOFF_CLASSES.DEFERRED && handoffClass(CLASSES.CURRENT_UNSERVED, { servedConfirmed: true }) === HANDOFF_CLASSES.DEFERRED && handoffClass(CLASSES.MISSING_EVIDENCE) === HANDOFF_CLASSES.MISSING_SOURCE && handoffClass(CLASSES.NOT_APPLICABLE) === HANDOFF_CLASSES.NOT_APPLICABLE && handoffClass(CLASSES.INTEGRITY) === HANDOFF_CLASSES.FAILED && handoffClass(CLASSES.TRANSPORT) === HANDOFF_CLASSES.FAILED && handoffClass(CLASSES.SUPERSEDED_NEWER_LIVE) === HANDOFF_CLASSES.DEFERRED && handoffClass(CLASSES.UNKNOWN) === HANDOFF_CLASSES.DEFERRED && handoffClass(CLASSES.STALE) === HANDOFF_CLASSES.DEFERRED);
  ok("D14: new outcomes -- preempted deferred 3600 + alert; capacity deferred 21600 + alert; evidence-advanced re-armed (deferred 60, no attempt); await-timeout proceed + alert; not-applicable / superseded terminal for the token, no alert", J(outcomeFor(CLASSES.SERVED_ROW_PREEMPTED)) === J({ outcome: "deferred", backoff: 3600, alert: true }) && J(outcomeFor(CLASSES.CAPACITY_EXCEEDED)) === J({ outcome: "deferred", backoff: 21600, alert: true }) && J(outcomeFor(CLASSES.EVIDENCE_ADVANCED)) === J({ outcome: "deferred", backoff: 60, alert: false }) && outcomeFor(CLASSES.AWAIT_TIMEOUT).outcome === "proceed" && outcomeFor(CLASSES.AWAIT_TIMEOUT).alert === true && outcomeFor(CLASSES.NOT_APPLICABLE).outcome === "dead" && outcomeFor(CLASSES.NOT_APPLICABLE).alert === false && outcomeFor(CLASSES.SUPERSEDED_NEWER_LIVE).alert === false);
  ok("D15: await escape hatch (PRW_AWAIT_MAX_MINUTES): still waiting -> dependency; past the bound -> await-timeout (proceed + alert); a manifest drift needs a 'repair' (--live --verify-exact) pass", awaitVerdict({ openSinceMs: 0, nowMs: 119 * 60000, maxMinutes: 120 }).cls === CLASSES.DEPENDENCY && awaitVerdict({ openSinceMs: 0, nowMs: 120 * 60000, maxMinutes: 120 }).cls === CLASSES.AWAIT_TIMEOUT && repairKindFor(jobVerdict(tgt([["u1", "STALE", "manifest-differs"]]), ["brand-view"])) === "repair" && repairKindFor(jobVerdict(tgt([["u1", "STALE", "served-row-differs"]]), ["brand-view"])) === "live");
}
function S(v) { return v == null ? "" : String(v); }

/* E. config validation (secrets: presence only; every flag OFF / safe by default) */
{
  const base = { POSTGRES_URL: "postgres://x", SUPABASE_URL: "https://x", SUPABASE_SERVICE_ROLE_KEY: "k", DATADOE_API_KEY: "d" };
  const good = loadRecoveryConfig(base);
  const c = good.config;
  ok("E1: defaults: 20s poll, 600s scan, batch 5, concurrency 1, observe-only (no live route), cooldown 900, deep sweep 6h, await 120min, lease 2700, no shadow prune, no scheduler windows, nothing attested", good.ok && c.pollSeconds === 20 && c.scanIntervalSeconds === 600 && c.batch === 5 && c.concurrency === 1 && c.liveRoutes.length === 0 && !("liveFamilies" in c) && c.maxRearms === 12 && c.schedulerCooldownSeconds === 900 && c.deepSweepHours === 6 && c.awaitMaxMinutes === 120 && c.leaseSeconds === 2700 && c.shadowPrune === false && c.schedulerWindows.length === 0 && Object.values(c.attestations).every((x) => x === false));
  const bad = loadRecoveryConfig({ PRW_POLL_SECONDS: "3", PRW_LIVE_ROUTES: "oli,bogus", PRW_LEASE_SECONDS: "600", PRW_SCHEDULER_COOLDOWN_SECONDS: "100", PRW_DEEP_SWEEP_HOURS: "48", PRW_SHADOW_PRUNE: "yes" });
  ok("E2: missing secrets, out-of-range numbers, an unknown route id and a non-boolean flag are rejected", !bad.ok && bad.errors.some((e) => /POSTGRES_URL/.test(e)) && bad.errors.some((e) => /PRW_POLL_SECONDS/.test(e)) && bad.errors.some((e) => /PRW_LIVE_ROUTES.*bogus/.test(e)) && bad.errors.some((e) => /PRW_LEASE_SECONDS/.test(e)) && bad.errors.some((e) => /PRW_SCHEDULER_COOLDOWN_SECONDS/.test(e)) && bad.errors.some((e) => /PRW_DEEP_SWEEP_HOURS/.test(e)) && bad.errors.some((e) => /PRW_SHADOW_PRUNE/.test(e)));
  ok("E3: config never carries a secret value (presence booleans only)", !JSON.stringify(good.config).includes("postgres://x") && !JSON.stringify(good.config).includes('"k"') && good.config.secretsPresent.DATADOE_API_KEY === true);
  const old = loadRecoveryConfig({ ...base, PRW_LIVE_FAMILIES: "oli" });
  ok("E4: PRW_LIVE_FAMILIES is RETIRED -- setting it is a clear configuration error (never silently mapped)", !old.ok && old.errors.some((e) => /PRW_LIVE_FAMILIES is RETIRED.*PRW_LIVE_ROUTES/.test(e)) && old.config.liveRoutes.length === 0);
  const live = loadRecoveryConfig({ ...base, PRW_LIVE_ROUTES: "oli,brand-view-portfolio,oli", PRW_SCHEDULER_WINDOWS: "03:00-03:45, 23:30-00:30", PRW_SHADOW_PRUNE: "true", SKU_MOVEMENT_SERVE_TOKEN_ATTESTED: "TRUE" });
  ok("E5: PRW_LIVE_ROUTES validated against ROUTE_IDS (de-duplicated; the retired liveFamilies compat is gone); windows parse (wrap midnight); only the literal 'true' attests", live.ok && J(live.config.liveRoutes) === J(["oli", "brand-view-portfolio"]) && !("liveFamilies" in live.config) && live.config.shadowPrune === true && live.config.attestations.skuMovementServeToken === false && inSchedulerWindow(live.config.schedulerWindows, Date.UTC(2026, 8, 25, 0, 15)) && inSchedulerWindow(live.config.schedulerWindows, Date.UTC(2026, 8, 25, 3, 0)) && !inSchedulerWindow(live.config.schedulerWindows, Date.UTC(2026, 8, 25, 3, 45)));
  const errs = []; parseSchedulerWindows("25:00-01:00,03:00-03:00,3:00-4:00", errs);
  const shortLease = loadRecoveryConfig({ ...base, PRW_LIVE_ROUTES: "brand-view", PRW_LEASE_SECONDS: "2400" });
  ok("E6: a malformed / empty window is rejected; the lease must cover a live route's child sequence (3 x hard timeout + cleanup)", errs.length === 3 && !shortLease.ok && shortLease.errors.some((e) => /PRW_LEASE_SECONDS=2400.*2700/.test(e)) && loadRecoveryConfig({ ...base, PRW_LIVE_ROUTES: "oli", PRW_LEASE_SECONDS: "1500" }).ok);
}

/* F. TARGETS line + evidence tokens */
{
  ok("F1: reasons reduce to a stable machine code (free text can never leak)", sanitizeReasonCode("controls-not-opened:CONTROL_LEASE_HELD") === "controls-not-opened:CONTROL_LEASE_HELD" && sanitizeReasonCode("release-threw: connect ECONNREFUSED 10.0.0.1 password=x") === "release-threw:" && sanitizeReasonCode(null) === null);
  const line = formatTargetsLine({ family: "fba", summary: { bucket: "us-ca", requestedAsOf: "2026-09-23", dryRun: true, perAccount: [{ accountId: "A", eligible: true, revisionId: "r".repeat(99), status: "nonempty", reports: { "brand-inventory": { state: "STALE", reason: "live-refresh-differs", lkgPreserved: true } } }] } });
  const back = parseTargetsLine(line);
  ok("F2: TARGETS round-trips and carries only ids + state + reason code", back && back.family === "fba" && back.accounts[0].reports["brand-inventory"].s === "STALE" && back.accounts[0].rev.length === 64 && !line.includes("lkgPreserved"));
  ok("F3: a malformed/foreign line never parses as TARGETS", parseTargetsLine("RESULT {}") === null && parseTargetsLine("TARGETS {bad") === null && parseTargetsLine('TARGETS {"v":2,"accounts":[]}') === null);
  ok("F4: summary without perAccount yields an empty, well-formed payload", buildTargetsPayload({ family: "oli", summary: null }).accounts.length === 0);
  const t = composeEvidenceTokens({ oli: [{ account_id: "A", covered_to: "2026-09-23", refreshed: "x" }], fba: [{ account_id: "A", source_request_hash: "h", payload_sha: "s" }], listings: [{ account_id: "A", l_sha: "l", l_at: "t" }], catalog: { payload_sha: "c" } });
  ok("F5: the listings token folds FBA + catalog + OLI (the LHv3 fingerprint's inputs), so any of them re-checks LHv3", /fba:h:s/.test(t.listings.get("A")) && /cat:c/.test(t.listings.get("A")) && /cov:2026-09-23/.test(t.listings.get("A")));
  // F6: composeEvidenceTokens MOVED VERBATIM (store-pg re-exports the SAME function; token strings byte-identical to the
  // pre-move goldens).
  const d = new Date(Date.UTC(2026, 8, 24, 1, 2, 3, 4));
  const g = composeAtHome({ oli: [{ account_id: "A", covered_to: "2026-09-23", refreshed: d }], oliCompleteness: [{ account_id: "A", refreshed: d }], fba: [{ account_id: "A", source_request_hash: "h", payload_sha: "s" }], ads: [{ account_id: "A", revs: "campaign-performance-v1=r1@2026-09-23" }], listings: [{ account_id: "A", l_sha: "l", l_at: d, r_sha: null, r_at: null }, { account_id: "B", l_sha: "m", l_at: "t2", r_sha: "q", r_at: "t3" }], catalog: { payload_sha: "c" } });
  ok("F6: composeEvidenceTokens moved VERBATIM (store-pg re-exports the SAME function) -- token strings byte-identical to the pre-move goldens", composeEvidenceTokens === composeAtHome
    && g.oli.get("A") === "cov:2026-09-23@2026-09-24T01:02:03.004Z|cmp:2026-09-24T01:02:03.004Z" && g.fba.get("A") === "fba:h:s" && g.ads.get("A") === "ads:campaign-performance-v1=r1@2026-09-23"
    && g.listings.get("A") === "lst:l@2026-09-24T01:02:03.004Z|raw:-@-|fba:h:s|cat:c|cov:2026-09-23@2026-09-24T01:02:03.004Z|cmp:2026-09-24T01:02:03.004Z" && g.listings.get("B") === "lst:m@t2|raw:q@t3|fba:-|cat:c|oli:-");
  const storeText = src("lib/server/recovery/store-pg.js");
  // The legacy watermark statements, BYTE-IDENTICAL to the pre-route store-pg.js readEvidenceTokens texts (goldens).
  const GOLD = {
    oli_coverage: "select account_id, max(covered_to)::text covered_to, max(source_refreshed_at) refreshed from public.source_coverage where connection_id = 'primary' and source_key = 'order-line-items' and status = 'succeeded' group by account_id",
    oli_completeness: "select account_id, max(refreshed_at) refreshed from public.source_oli_completeness where connection_id = 'primary' and sale_date between ($1::date - 3) and $1::date group by account_id",
    fba_pointers: "select scope_key account_id, source_request_hash, payload_sha from public.source_snapshots where connection_id = 'primary' and source_key = 'fba-inventory-health'",
    ads_revs: "select account_id, string_agg(source_key || '=' || coalesce(content_rev, '') || '@' || coalesce(latest_metric_date::text, ''), ',' order by source_key) revs from public.ads_sync_state where source_key = any($1) group by account_id",
    listings_pointers: "select l.account_id, l.payload_sha l_sha, l.validated_at l_at, r.payload_sha r_sha, r.validated_at r_at from public.source_listings_snapshot l left join public.source_listings_raw_snapshot r on r.organization_fingerprint = l.organization_fingerprint and r.connection_id = l.connection_id and r.account_id = l.account_id where l.connection_id = 'primary'",
    catalog_pointer: "select payload_sha from public.source_snapshots where connection_id = 'primary' and source_key = 'product-catalog' order by validated_at desc limit 1",
  };
  ok("F7: the legacy routes' evidence statements are BYTE-IDENTICAL to the pre-route watermark texts; store-pg.js runs every route's OWN evidence SQL (evaluateRouteEvidence) and carries none of its own", Object.entries(GOLD).every(([n, t]) => LEGACY_EVIDENCE_SQL[n].text === t) && !Object.values(GOLD).some((t) => storeText.includes(JSON.stringify(t))) && /evaluateRouteEvidence\(route, q, ctx\)/.test(storeText) && !/export function composeEvidenceTokens/.test(storeText));
}

/* G. migration 20260934: expand-only, least privilege, the semantics the worker relies on */
{
  const sql = src("supabase/migrations/20260934_publication_recovery_worker.sql");
  const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  ok("G1: expand-only -- no DROP/ALTER of any existing object, no data change outside its own tables", !/\bdrop\s+(table|function|index|trigger|view)\b/i.test(code) && !(code.match(/alter table\s+public\.(\w+)/gi) || []).some((m) => !/publication_recovery_/.test(m)) && !/\b(update|insert into|delete from)\s+public\.(?!publication_recovery_)/i.test(code));
  ok("G2: every function is SECURITY DEFINER + fixed search_path", (code.match(/create or replace function/gi) || []).length === 12 && (code.match(/security definer/gi) || []).length === 12 && (code.match(/set search_path = public/gi) || []).length === 12);
  ok("G3: RLS on all 7 tables (incl. the route registry); anon/authenticated revoked; execute granted to service_role only", (code.match(/enable row level security/gi) || []).length === 7 && (code.match(/revoke all on table/gi) || []).length === 7 && (code.match(/grant execute on function/gi) || []).length === 12 && !/\bto\s+(anon|authenticated|public)\b/i.test(code.replace(/from public, anon, authenticated/g, "")));
  ok("G4: control defaults DISABLED; every seeded route live_enabled=false with no live region (the retired live_families column is gone)", /insert into public\.publication_recovery_control \(id, enabled\) values \(true, false\)/.test(code) && /live_enabled boolean not null default false/.test(code) && /live_regions text\[\] not null default '\{\}'::text\[\]/.test(code) && !/live_families text/.test(code) && !/live_enabled = true|live_enabled\) values|, true\)\s*,?\s*$/m.test(code.split("insert into public.publication_recovery_routes")[1].split(";")[0]));
  ok("G5: one live job per key + SKIP LOCKED claims + crash-loop dead-letter + owner-only finish + re-arm", /where status in \('pending','claimed','deferred'\)/.test(code) && /for update skip locked/i.test(code) && /crash-loop/.test(code) && /return 'not-owner'/.test(code) && /return 're-armed'/.test(code) && /dead-same-evidence/.test(code) && /already-verified/.test(code));
  ok("G6: the rollback is NOT in supabase/migrations (the ledger runner can never apply it)", !readdirSync(new URL("../supabase/migrations/", import.meta.url)).some((f) => /rollback/i.test(f)) && src("deploy/publication-recovery/ROLLBACK_20260934.sql").includes("drop table if exists public.publication_recovery_jobs"));
}

/* I. adversarial-review regressions (each pinned to the real reconciler contract it was checked against) */
{
  // saved-data-reconciler maps NEWER_LIVE -> DEFERRED_DEPENDENCY with publish-newer-live / shadow-newer-live.
  ok("I1: newer-live arrives as a DEFERRAL (the real contract) and is terminal for that evidence, not a looping dependency", classifyDeferral("publish-newer-live").cls === CLASSES.SUPERSEDED_NEWER_LIVE && classifyDeferral("shadow-newer-live").cls === CLASSES.SUPERSEDED_NEWER_LIVE && outcomeFor(CLASSES.SUPERSEDED_NEWER_LIVE).outcome === "dead" && /RETRYABLE_STATUS = new Set\(\[[^\]]*"NEWER_LIVE"/.test(src("lib/server/sync/saved-data-reconciler.js")));
  ok("I2: deadline-cleanup-reserved (never attempted) defers WITHOUT an attempt; other deadline reasons still retry", classifyDeferral("deadline-cleanup-reserved").cls === CLASSES.NOT_ATTEMPTED && outcomeFor(CLASSES.NOT_ATTEMPTED).outcome === "deferred" && classifyDeferral("deadline-in-flight").cls === CLASSES.TIMEOUT && src("lib/server/sync/saved-data-reconciler.js").includes('"deadline-cleanup-reserved"'));
  const failedRun = { exitCode: 1, result: { ok: false, outcome: "failed", code: "DURABLE_ADS_UNREADABLE" }, targets: { v: 1, outcome: "failed", code: "DURABLE_ADS_UNREADABLE", accounts: [] } };
  ok("I3: a whole-run failure (fail(): outcome failed, perAccount []) is ONE run-level class, never 'every account missing'", classifyRun(failedRun).cls === CLASSES.RUN_FAILED && /run-failed:DURABLE_ADS_UNREADABLE/.test(classifyRun(failedRun).reason) && outcomeFor(CLASSES.RUN_FAILED).outcome === "retry" && classifyRun({ result: {}, targets: { outcome: "failed", code: "payload-malformed", accounts: [] } }).cls === CLASSES.INTEGRITY);
  ok("I4: CONTROL_CLEANUP_UNRESOLVED is recognized from the RESULT code AND the TARGETS flag", cleanupUnresolved({ result: { code: "CONTROL_CLEANUP_UNRESOLVED" } }) && cleanupUnresolved({ targets: { controlCleanupUnresolved: true } }) && !cleanupUnresolved({ result: { code: "OK" }, targets: { controlCleanupUnresolved: false } }));
  ok("I5: a Postgres date is kept as its exact text (no local-midnight Date -> previous-day shift east of UTC)", recoveryPgTypes.getTypeParser(1082, "text")("2026-09-24") === "2026-09-24" && typeof recoveryPgTypes.getTypeParser(1184, "text") === "function");
  ok("I6: a Date that still reaches the worker is read with LOCAL getters (matches node-postgres' local-midnight parse)", asOfText(new Date(2026, 8, 23)) === "2026-09-23" && asOfText("2026-09-23") === "2026-09-23");
  ok("I7: every scheduler-v2 cycle bucket maps to its region (natural, -fba, LHv3, bootstrap-*, priority-partial-*); legacy/unknown do not", regionForCycleBucket("india") === "india" && regionForCycleBucket("us-ca-fba") === "us-ca" && regionForCycleBucket("listing-health-v3-europe-au") === "europe-au" && regionForCycleBucket("bootstrap-fba-us-ca-0123456789abcdef") === "us-ca" && regionForCycleBucket("bootstrap-india-0123456789abcdef") === "india" && regionForCycleBucket("priority-partial-europe-au-0123456789abcdef") === "europe-au" && regionForCycleBucket("us") === null && regionForCycleBucket("non-us-fba") === null && regionForCycleBucket("bootstrap-india-xyz") === null);
  const sql = src("supabase/migrations/20260934_publication_recovery_worker.sql");
  ok("I8: finish re-arms on advanced evidence for verified/retry/deferred/dead and resets claims on every owner finish but 'released'", /if p_outcome in \('verified','retry','deferred','dead'\)\s+and v\.evidence_token is not null and p_evaluated_token is distinct from v\.evidence_token/.test(sql) && (sql.match(/claims = 0/g) || []).length >= 6 && /claims = greatest\(v\.claims - 1, 0\)/.test(sql));
  ok("I9: tables are revoked from service_role too (select-only; writes only through the RPC invariants)", (sql.match(/revoke all on table public\.publication_recovery_\w+ from public, anon, authenticated, service_role;/g) || []).length === 7);
  // --- safety/deploy review ---
  const secretUrl = "postgresql://postgres.ref:Sup3r-Secret@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?sslmode=require&supa=base-pooler.x";
  const pc = recoveryPoolConfig(secretUrl, { max: 2 });
  ok("I11: the worker pool uses VERIFIED TLS (pinned Supabase root CA + hostname), the URL query (sslmode/supa) removed", pc.ssl && pc.ssl.rejectUnauthorized === true && /BEGIN CERTIFICATE/.test(pc.ssl.ca) && !pc.connectionString.includes("?") && pc.max === 2 && pc.types === recoveryPgTypes);
  let urlErr = "";
  try { recoveryPoolConfig("postgres://u:pa#ss/word@host:5432/db?x"); recoveryPoolConfig("not a url with Sup3r-Secret"); } catch (e) { urlErr = String(e && e.message) + String(e && e.input); }
  ok("I12: a malformed POSTGRES_URL throws a REDACTED error (never the value)", /not a valid URL/.test(urlErr) && !urlErr.includes("Sup3r-Secret"));
  const handlers = [];
  const fakePool = { on: (ev, fn) => handlers.push([ev, fn]), query: async () => ({ rows: [] }), end: async () => {} };
  const codes = [];
  createRecoveryStore({ connectionString: "postgres://u:p@h/db", poolImpl: fakePool, onError: (c) => codes.push(c) });
  const errH = handlers.find(([ev]) => ev === "error");
  if (errH) errH[1](Object.assign(new Error("Connection terminated unexpectedly password=x"), { code: "ECONNRESET" }));
  ok("I13: the pool has an 'error' listener (an idle-client drop can never crash the worker) and only the CODE is surfaced", !!errH && codes.length === 1 && codes[0] === "ECONNRESET");
  const ac = new AbortController();
  for (let i = 0; i < 25; i += 1) await interruptibleSleep(1, ac.signal);
  const leftover = getEventListeners(ac.signal, "abort").length;
  const pending = interruptibleSleep(60000, ac.signal); ac.abort(); await pending;
  ok("I14: the production sleep leaves NO abort listener behind after a normal wake, and abort still interrupts it", leftover === 0);
  ok("I15: .gitattributes pins LF for the deployed *.sh / *.service / *.example (git archive on Windows would ship CRLF)", ["*.sh", "*.service", "*.example"].every((p) => new RegExp("^" + p.replace(/[.*]/g, (c) => "\\" + c) + "\\s+text eol=lf$", "m").test(src("../.gitattributes"))));
  const inst = src("deploy/publication-recovery/install.sh");
  ok("I16: install.sh checks the unit's /usr/bin/node, stages + validates before activating, pins the WHOLE pg closure, never overwrites the rollback target with itself", /NODE=\/usr\/bin\/node/.test(inst) && /\.staging-/.test(inst) && /\.complete/.test(inst) && /visit\("", "pg"\)/.test(inst) && /installed " \+ got \+ " but the lockfile pins/.test(inst) && /"\$CUR" != "\$\(readlink -f "\$REL"\)"/.test(inst) && /PRW_VERSION=/.test(src("deploy/publication-recovery/rollback.sh")));
  ok("I17: the child heap ceiling fits the unit (worker 160 + child <= 512 under MemoryMax=850M)", !loadRecoveryConfig({ POSTGRES_URL: "postgres://x", SUPABASE_URL: "https://x", SUPABASE_SERVICE_ROLE_KEY: "k", DATADOE_API_KEY: "d", PRW_CHILD_MAX_OLD_SPACE_MB: "768" }).ok && loadRecoveryConfig({ POSTGRES_URL: "postgres://x", SUPABASE_URL: "https://x", SUPABASE_SERVICE_ROLE_KEY: "k", DATADOE_API_KEY: "d", PRW_CHILD_MAX_OLD_SPACE_MB: "512" }).ok);
  ok("I10: the systemd unit pins TZ=UTC and a stop timeout that covers a live child's own deadline", /Environment=TZ=UTC/.test(src("deploy/publication-recovery/publication-recovery.service")) && Number((src("deploy/publication-recovery/publication-recovery.service").match(/TimeoutStopSec=(\d+)/) || [])[1]) >= 840 + 60);
}

/* H. deployment contract: the VM installs ONLY `pg` (install.sh) -- the worker + CLI import closure must need nothing else */
{
  const { existsSync } = await import("node:fs");
  const pathMod = (await import("node:path")).default;
  const { fileURLToPath } = await import("node:url");
  const root = pathMod.resolve(pathMod.dirname(fileURLToPath(import.meta.url)), "..");
  const { ALLOWED_WORKER_SCRIPTS } = await import("../lib/server/recovery/routes.js");
  const entries = ["scripts/worker/publication-recovery-worker.mjs", "scripts/worker/publication-recovery-health.mjs", "scripts/worker/publication-recovery-status.mjs", ...ALLOWED_WORKER_SCRIPTS];
  const seen = new Set(), bare = new Set(), queue = entries.map((e) => pathMod.resolve(root, e));
  // Real import syntax only (line-start static import/export-from, literal dynamic import) -- never prose in comments.
  const IMPORT_RES = [/^\s*import\s+(?:[\w*{}\s,$]+\s+from\s+)?["']([^"'\n]+)["']/gm, /^\s*export\s+[\w*{}\s,$]+\s+from\s+["']([^"'\n]+)["']/gm, /\bimport\(\s*["']([^"'\n]+)["']\s*\)/g];
  const SPEC = /^(?:\.{1,2}\/|node:|(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*(?:\/|$))/;
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f) || !existsSync(f)) continue;
    seen.add(f);
    const text = readFileSync(f, "utf8");
    for (const m of IMPORT_RES.flatMap((re) => [...text.matchAll(re)])) {
      const sp = m[1];
      if (!SPEC.test(sp)) continue;
      if (sp.startsWith(".")) { let r = pathMod.resolve(pathMod.dirname(f), sp); if (!existsSync(r) && existsSync(r + ".js")) r += ".js"; queue.push(r); }
      else if (!sp.startsWith("node:")) bare.add(sp.startsWith("@") ? sp.split("/").slice(0, 2).join("/") : sp.split("/")[0]);
    }
  }
  ok(`H1: the worker + health/status + every allowed worker CLI (4 legacy reconcilers + the route CLI; ${seen.size} modules) import exactly one npm package: pg`, JSON.stringify([...bare].sort()) === JSON.stringify(["pg"]));
  const lock = JSON.parse(src("package-lock.json"));
  ok("H2: pg is pinned in the lockfile (install.sh installs that exact version)", /^\d+\.\d+\.\d+$/.test(lock.packages["node_modules/pg"].version));
  ok("H3: the systemd unit has no listening socket, runs as the unprivileged prw user, and reads secrets only from the protected env file", /User=prw/.test(src("deploy/publication-recovery/publication-recovery.service")) && /EnvironmentFile=\/etc\/publication-recovery\/worker\.env/.test(src("deploy/publication-recovery/publication-recovery.service")) && !/ListenStream|Environment=.*(KEY|URL)=/.test(src("deploy/publication-recovery/publication-recovery.service")));
  ok("H4: the env example contains NO secret values", src("deploy/publication-recovery/worker.env.example").split("\n").filter((l) => /^(POSTGRES_URL|SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY|DATADOE_API_KEY)=/.test(l)).every((l) => /=$/.test(l.trim())));
}

/* J. WP11 FIXER pins (P2b vocabulary / legacy scope, P2c live pass on ANY stale unit, P2d served proof, runner argv
   refusals + the ZEROEXPORT prefix, the config attestation gate, the registry universe + verdictReportKeys) */
{
  const D = STATES.DEPENDENCY, P = STATES.PROVENANCE, F = STATES.FAILED_DERIVE, C = STATES.CURRENT;
  const RC = { routeKind: "route-cli" }, LG = { routeKind: "legacy-cli" };
  // P1 rule ORDER: the specific refused-shadow / stamp-inversion rules precede the generic superseded rule.
  const idx = (id) => REASON_RULES.findIndex((r) => r.id === id);
  ok("J1 (P1): 'paid-refused-by-route-stamp' and both shadow-newer-live rules PRECEDE the generic 'newer-live' rule; the generic rule is DEFERRED_* only on a route (a FAILED 'superseded-newer-live:*' / 'publish-newer-live' is never superseded there)", idx("paid-refused-by-route-stamp") >= 0 && idx("paid-refused-by-route-stamp") < idx("newer-live") && idx("shadow-content-differs") < idx("newer-live") && idx("shadow-newer-live-unreadable") < idx("newer-live") && classifyReason(F, "superseded-newer-live:paid-owned", RC).cls !== CLASSES.SUPERSEDED_NEWER_LIVE && classifyReason(STATES.FAILED_PUBLISH, "publish-newer-live", RC).cls !== CLASSES.SUPERSEDED_NEWER_LIVE && classifyReason(D, "superseded-newer-live:paid-owned", RC).cls === CLASSES.SUPERSEDED_NEWER_LIVE && classifyReason(P, "bundle-superseded-newer-live:served-newer-to", RC).cls === CLASSES.SUPERSEDED_NEWER_LIVE);
  const shadowCodes = ["shadow-missing", "shadow-identity", "shadow-params-identity", "shadow-hash-provenance", "shadow-refresh-blank", "shadow-not-this-revision", "shadow-target-identity", "shadow-payload-unavailable", "shadow-payload-invalid"];
  ok("J2 (P1): EVERY 'shadow-newer-live:<validShadowAt code>' (9) is a RETRYABLE transport failure + alert -- never superseded, never dead on the first pass; 'shadow-newer-live:content-differs' (FAILED_DERIVE) is integrity + alert (dead)", shadowCodes.every((c) => { const v = classifyReason(D, "shadow-newer-live:" + c, RC); return v.cls === CLASSES.TRANSPORT && v.alert === "shadow-newer-live-unreadable" && outcomeFor(v.cls).outcome === "retry"; }) && classifyReason(F, "shadow-newer-live:content-differs", RC).cls === CLASSES.INTEGRITY && outcomeFor(CLASSES.INTEGRITY).outcome === "dead" && classifyReason(D, "shadow-newer-live", RC).cls === CLASSES.SUPERSEDED_NEWER_LIVE);
  // P2b: route reasons are typed ONLY by REASON_RULES + ROUTE_REASON_VOCABULARY; the legacy whitelist is legacy-cli only.
  ok("J3 (P2b): an unknown route reason is an unmapped typed deferral + alert on every state (never current); a LEGACY-only code on a route is unmapped too; the same code under the legacy kind is typed (no alert)", ["zz-new-route-code", "catalog-stale", "oli-provenance-missing", "no-oli"].every((r) => /^unmapped-reason:/.test(S(classifyReason(D, r, RC).alert)) && /^unmapped-reason:/.test(S(classifyReason(P, r, RC).alert))) && classifyReason(F, "zz-new-route-code-threw", RC).cls === CLASSES.UNKNOWN && ["catalog-stale", "oli-provenance-missing", "no-oli", "order-line-items:coverage-incomplete"].every((r) => classifyReason(P, r, LG).alert === null));
  ok("J4 (P2b): 'derive-not-ready:<sub>' is whitelisted ONLY for an enumerated legacy sub-code (none exist) -- never a blanket prefix: an unknown sub-code alerts on BOTH paths; the bare legacy 'derive-not-ready' stays typed under the legacy kind", /^unmapped-reason:/.test(S(classifyReason(D, "derive-not-ready:zz-anything", LG).alert)) && /^unmapped-reason:/.test(S(classifyReason(D, "derive-not-ready:zz-anything", RC).alert)) && classifyReason(D, "derive-not-ready", LG).alert === null && !isKnownLegacyReason("derive-not-ready:catalog-stale") && isKnownLegacyReason("derive-not-ready"));
  ok("J5 (P2b): LEGACY_PROVENANCE_RE is NARROWED -- a made-up code full of the old pattern's words ('zz-snapshot-evidence-missing-unavailable') is no longer whitelisted, while the legacy families' real code shapes still are", !LEGACY_PROVENANCE_RE.test("zz-snapshot-evidence-missing-unavailable") && !isKnownLegacyReason("zz-snapshot-evidence-missing-unavailable") && ["oli-provenance-missing", "no-oli", "fba-snapshot:x", "ads-coverage-state:y", "order-line-items:coverage-incomplete", "campaign-performance-v1:ads-coverage-incomplete", "daily-reporting:catalog"].every((r) => isKnownLegacyReason(r)));
  ok("J6 (P2b): a vocabulary code no rule names classifies by its STATE without an unmapped alert (payload-too-large / publisher-unavailable FAILED -> integrity; claim-held -> contention; a '*-threw' deferral -> bounded transport retry, alerted 'route-step-threw' since the WP11 verifier F4 fix); a ':'-prefix entry matches its dynamic tail (an empty tail included: a blank error message still leaves the code) but never a longer code", classifyReason(F, "payload-too-large", RC).cls === CLASSES.INTEGRITY && classifyReason(STATES.FAILED_PUBLISH, "publisher-unavailable", RC).cls === CLASSES.INTEGRITY && classifyReason(D, "claim-held", RC).cls === CLASSES.CONTENTION && classifyReason(D, "cycle-open-threw:boom", RC).cls === CLASSES.TRANSPORT && classifyReason(D, "cycle-open-threw:boom", RC).alert === "route-step-threw" && routeReasonKnown("lineage-read-threw:x") && !routeReasonKnown("zz-new-route-code") && ROUTE_REASON_VOCABULARY.has("lineage-read-threw:") && classifyReason(D, "lineage-read-threw:", RC).alert === "route-step-threw" && !routeReasonKnown("lineage-read-threwX") && /^unmapped-reason:/.test(S(classifyReason(D, "lineage-read-threwX", RC).alert)));
  ok("J7 (P3): brand-view's verified EMPTY brand directory (target r 'units-empty') is NOT_APPLICABLE (source-absent; dead for THIS token only); units-empty on any other route stays a dependency deferral + alert", jobVerdict({ id: "A", units: [], r: "units-empty" }, ["brand-view"], { routeId: "brand-view", routeKind: "route-cli" }).cls === CLASSES.NOT_APPLICABLE && handoffClass(CLASSES.NOT_APPLICABLE) === HANDOFF_CLASSES.NOT_APPLICABLE && jobVerdict({ id: "region:india", units: [], r: "units-empty" }, ["brand-view-portfolio"], { routeId: "brand-view-portfolio", routeKind: "route-cli" }).cls === CLASSES.DEPENDENCY && jobVerdict({ id: "region:india", units: [], r: "units-empty" }, ["brand-view-portfolio"], { routeId: "brand-view-portfolio" }).alert === "units-empty");
  // P2c: ANY stale unit -> the live pass; the worst class is only the final outcome.
  const u = (x, s, r = null, extra = {}) => ({ u: x, rk: "brand-view-portfolio", s, r, asOf: "2026-09-24", h: null, sra: null, served: null, ...extra });
  const mixed = jobVerdict({ id: "region:india", tok: "t", units: [u("b1", P, "portfolio-scope-id-too-long"), u("b2", STATES.STALE, "live-refresh-differs")] }, ["brand-view-portfolio"], RC);
  ok("J8 (P2c): jobVerdict exposes anyStale / staleUnits: an INTEGRITY unit + a STALE unit -> final class integrity, anyStale true, staleUnits [b2] (the worker's live pass runs for b2); no stale unit -> anyStale false", mixed.cls === CLASSES.INTEGRITY && mixed.anyStale === true && J(mixed.staleUnits) === J([{ u: "b2", rk: "brand-view-portfolio" }]) && jobVerdict({ id: "A", tok: "t", units: [u("b1", P, "catalog-missing")] }, ["brand-view-portfolio"], RC).anyStale === false);
  // P2d: already-current REQUIRES the served proof.
  const cur = (extra) => ({ id: "A", tok: "t", units: [u("b1", C, null, extra)] });
  const unserved = jobVerdict(cur({ h: "h1", sra: "s1", served: null }), ["brand-view-portfolio"], RC);
  const foreign = jobVerdict(cur({ h: "h1", sra: "s1", served: { id: "r", h: "hX", sra: "s1" } }), ["brand-view-portfolio"], RC);
  const proven = jobVerdict(cur({ h: "h1", sra: "s1", served: { id: "r", h: "h1", sra: "s1" } }), ["brand-view-portfolio"], RC);
  const bare = jobVerdict(cur({}), ["brand-view-portfolio"], RC);
  ok("J9 (P2d): a ROUTE CLI's PUBLICATION_NOT_REQUIRED unit is current ONLY with its served row carrying the unit's own h / sra; no served row / another row / no served fields at all -> typed 'current-unserved' deferral + alert (900 s, hand-off deferred) -- never already-current", unserved.cls === CLASSES.CURRENT_UNSERVED && unserved.alert === "current-unserved" && foreign.cls === CLASSES.CURRENT_UNSERVED && bare.cls === CLASSES.CURRENT_UNSERVED && proven.cls === CLASSES.CURRENT && proven.servedConfirmed === true && J(outcomeFor(CLASSES.CURRENT_UNSERVED)) === J({ outcome: "deferred", backoff: 900, alert: true }) && handoffClass(unserved.cls) === HANDOFF_CLASSES.DEFERRED && unitServedProof({ h: "h1", sra: "s1", served: { h: "h1", sra: "s1" } }) === true && unitServedProof({ h: null, sra: null, served: null }) === null);
  const v1 = normalizeTargets({ v: 1, family: "oli", bucket: "india", requestedAsOf: "2026-09-24", accounts: [{ id: "A", reports: { "brand-sales": { s: C, r: null } } }] }).targets[0];
  const lgNo = jobVerdict(v1, ["brand-sales"], LG), lgYes = jobVerdict(v1, ["brand-sales"], { ...LG, servedConfirmed: true });
  ok("J10 (P2d): a LEGACY (v1) current unit carries no served fields -> its class stays current (the durable verification the tier-1 served-row check is anchored to) with servedConfirmed null -> hand-off DEFERRED; with the worker's tier-1 confirmation (ctx.servedConfirmed === true) -> servedConfirmed true -> already-current / repaired", lgNo.cls === CLASSES.CURRENT && lgNo.servedConfirmed === null && handoffClass(lgNo.cls, { servedConfirmed: lgNo.servedConfirmed }) === HANDOFF_CLASSES.DEFERRED && lgYes.servedConfirmed === true && handoffClass(lgYes.cls, { servedConfirmed: lgYes.servedConfirmed }) === HANDOFF_CLASSES.ALREADY_CURRENT && handoffClass(lgYes.cls, { published: true, servedConfirmed: true }) === HANDOFF_CLASSES.REPAIRED);
  // P3 runner: target grammars, argv refusals, the fba-plan midnight roll, the ZEROEXPORT prefix.
  const a121 = "a".repeat(121), a120 = "a".repeat(120);
  let legacy121 = null; try { buildRouteArgs({ route: "oli", region: "india", asOf: "2026-09-24", targets: [a121], kind: "dry-run" }); } catch (e) { legacy121 = e; }
  ok("J11 (P3): a LEGACY-CLI account keeps the pre-route {1,120} bound (121 chars refused exactly like the old runner; 120 accepted), while a ROUTE-CLI target allows {1,160} (incl. 'region:<r>')", legacy121 && /malformed account/.test(legacy121.message) && buildRouteArgs({ route: "oli", region: "india", asOf: "2026-09-24", targets: [a120], kind: "dry-run" }).includes("--accounts=" + a120) && buildRouteArgs({ route: "sku-movement", region: "india", asOf: "2026-09-24", targets: ["A"], kind: "dry-run" }).includes("--targets=A") && RUNNER.LEGACY_ACCOUNT_RE.source.includes("{1,120}") && RUNNER.ROUTE_TARGET_RE.source.includes("{1,160}") && RUNNER.ACCOUNT_RE === RUNNER.ROUTE_TARGET_RE);
  const noSpawn = () => { throw new Error("must not spawn"); };
  const NOW2 = Date.UTC(2026, 8, 25, 0, 0, 5);
  const bad = await runRoute({ appRoot: process.cwd(), route: "returns-v3", region: "india", asOf: "2026-09-24", targets: ["a b"], kind: "dry-run", spawnImpl: noSpawn });
  const unk = await runRoute({ appRoot: process.cwd(), route: "no-such-route", region: "india", asOf: "2026-09-24", kind: "dry-run", spawnImpl: noSpawn });
  const rolled = await runRoute({ appRoot: process.cwd(), route: "fba-plan", region: "india", asOf: "2026-09-23", targets: ["A"], kind: "dry-run", spawnImpl: noSpawn, now: () => NOW2 });
  const stale2 = await runRoute({ appRoot: process.cwd(), route: "fba-plan", region: "india", asOf: "2026-09-22", targets: ["A"], kind: "dry-run", spawnImpl: noSpawn, now: () => NOW2 });
  ok("J12 (P3): runRoute RESOLVES a typed { argsError } on a malformed argv (never throws past the worker, never spawns): a malformed target / an unknown route -> 'argv-refused' (classifyRun: config alert); an fba-plan job whose as-of is the PREVIOUS UTC D-1 (the midnight rolled after the claim) -> 'fba-plan-as-of-rolled' (classifyRun: evidence-advanced, re-armed); an older as-of -> argv-refused", bad.argsError === RUN_ARGS_ERRORS.REFUSED && unk.argsError === RUN_ARGS_ERRORS.REFUSED && rolled.argsError === RUN_ARGS_ERRORS.FBA_PLAN_AS_OF_ROLLED && stale2.argsError === RUN_ARGS_ERRORS.REFUSED && classifyRun(bad).cls === CLASSES.CONFIG_ALERT && classifyRun(bad).alert === "argv-refused" && classifyRun(rolled).cls === CLASSES.EVIDENCE_ADVANCED && classifyRun(rolled).alert === null && classifyRun(stale2).cls === CLASSES.CONFIG_ALERT && RUNNER.ARGS_ERROR_FBA_PLAN_AS_OF_ROLLED === RUN_ARGS_ERRORS.FBA_PLAN_AS_OF_ROLLED && /^[\x20-\x7E]*$/.test(S(bad.argsErrorMessage)));
  const embedded = await (async () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    const zl = (n) => "ZEROEXPORT " + JSON.stringify({ blocked: n, allowedAccountsGets: 0 });
    const sp = () => { setImmediate(() => { child.stderr.write("warn: " + zl(3) + "\n"); child.stderr.write(" " + zl(4) + "\n"); child.stdout.write("RESULT " + JSON.stringify({ ok: true, note: zl(5) }) + "\n"); child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit("close", 0, null)); }); return child; };
    return runRoute({ appRoot: process.cwd(), route: "returns-v3", region: "india", asOf: "2026-09-24", kind: "dry-run", spawnImpl: sp });
  })();
  ok("J13 (P3): the ZEROEXPORT guard line is matched ONLY as a line PREFIX -- a fragment later in a line, an indented copy, or text inside a RESULT payload is never parsed as a guard line", runnerParseZeroExport('x ZEROEXPORT {"blocked":1}') === null && runnerParseZeroExport(' ZEROEXPORT {"blocked":1}') === null && runnerParseZeroExport('ZEROEXPORT {"blocked":1}').blocked === 1 && embedded.zeroExport.blocked === 0 && embedded.zeroExport.lines === 0 && embedded.argsError === null);
  // P2a config gate.
  const base = { POSTGRES_URL: "postgres://x", SUPABASE_URL: "https://x", SUPABASE_SERVICE_ROLE_KEY: "k", DATADOE_API_KEY: "d" };
  const fp = (v) => loadRecoveryConfig({ ...base, PRW_LIVE_ROUTES: "fba-plan", ...(v === undefined ? {} : { FBA_PLAN_ROUTE_FENCE_ATTESTED: v }) });
  const sm = (v) => loadRecoveryConfig({ ...base, PRW_LIVE_ROUTES: "sku-movement", ...(v === undefined ? {} : { SKU_MOVEMENT_SERVE_TOKEN_ATTESTED: v }) });
  ok("J14 (P2a): loadRecoveryConfig REJECTS 'fba-plan' / 'sku-movement' in PRW_LIVE_ROUTES unless FBA_PLAN_ROUTE_FENCE_ATTESTED / SKU_MOVEMENT_SERVE_TOKEN_ATTESTED is EXACTLY 'true' (unset / 'TRUE' / ' true' / '1' refused); 'listings' stays a runtime route-not-activated deferral (its live reconciler never reads LHV3_SERVE_GATE_ATTESTED) -- not a startup error", [undefined, "TRUE", " true", "1", ""].every((v) => !fp(v).ok && fp(v).errors.some((e) => /PRW_LIVE_ROUTES names 'fba-plan'.*FBA_PLAN_ROUTE_FENCE_ATTESTED/.test(e)) && !sm(v).ok && sm(v).errors.some((e) => /sku-movement.*SKU_MOVEMENT_SERVE_TOKEN_ATTESTED/.test(e))) && fp("true").ok && sm("true").ok && J(LIVE_ROUTE_CONFIG_ATTESTATIONS) === J({ "fba-plan": "FBA_PLAN_ROUTE_FENCE_ATTESTED", "sku-movement": "SKU_MOVEMENT_SERVE_TOKEN_ATTESTED" }) && loadRecoveryConfig({ ...base, PRW_LIVE_ROUTES: "listings" }).ok && missingLiveAttestation(loadRecoveryConfig({ ...base, PRW_LIVE_ROUTES: "listings" }).config, "listings") === "lhv3ServeGate");
  // registry: the universe includes SCHEDULER_V2_READY_REPORT_KEYS; verdictReportKeys is the ONE source.
  let readyErr = null; try { validateRouteRegistry({ readyKeys: [...SCHEDULER_V2_READY_REPORT_KEYS, "zz-ready-new"] }); } catch (e) { readyErr = e; }
  const SMNA = (await import("../lib/server/sync/routes/sku-movement.release.js")).SKU_MOVEMENT_ROUTE_NOT_ACTIVATED;
  const smForms = ["derive-not-ready:" + SMNA, SMNA].map((r) => jobVerdict({ id: "A", tok: "t", units: [{ u: "ALL", rk: "sku-movement", s: D, r }] }, ["sku-movement"], { routeId: "sku-movement", routeKind: "route-cli" }));
  ok("J16 (WP13 verifier P2-2): sku-movement's 'sku-movement-serve-not-attested:route-not-activated' (both forms: the derive gate 'derive-not-ready:<code>' and the bare publishGuard code, DEFERRED_DEPENDENCY) is ROUTE_NOT_ACTIVATED -- a deferral that burns no attempt, alert 'route-not-activated', hand-off 'deferred'; never unmapped, never a failure; it is a route vocabulary code", SMNA === "sku-movement-serve-not-attested:route-not-activated" && smForms.every((v) => v.cls === CLASSES.ROUTE_NOT_ACTIVATED && v.alert === "route-not-activated" && outcomeFor(v.cls).outcome === "deferred" && handoffClass(v.cls) === HANDOFF_CLASSES.DEFERRED) && ROUTE_REASON_VOCABULARY.has(SMNA) && routeReasonKnown("derive-not-ready:" + SMNA));
  ok("J15 (P3): the classification universe includes every SCHEDULER_V2_READY_REPORT_KEYS key (an unclassified READY key throws); registry.verdictReportKeys(route) === route.publisherKeys for every route and worker.js re-exports that SAME function", readyErr && /zz-ready-new.*unclassified/.test(readyErr.message) && [...SCHEDULER_V2_READY_REPORT_KEYS].every((k) => validateRouteRegistry().universe.includes(k)) && PUBLICATION_ROUTES.every((r) => REGISTRY.verdictReportKeys(r) === r.publisherKeys) && workerVerdictReportKeys === REGISTRY.verdictReportKeys);
}

/* K. WP11 verifier round-2 fixes (F2 scope STOP, F3 race-prone codes, F4/F7 leading '-threw', F5 guard framing, F8 strict
   default) -- ported from the verifier probes (probe-classify2 / prw-poison / zeg-diag) */
{
  const D = STATES.DEPENDENCY, P = STATES.PROVENANCE, F = STATES.FAILED_DERIVE;
  const RC = { routeKind: "route-cli" }, LG = { routeKind: "legacy-cli" };
  // F3 race-prone FAILED codes.
  const race = RACE_TRANSIENT_CODES.flatMap((c) => [c, "bundle-" + c, "derive-not-ready:" + c]).flatMap((r) => [STATES.FAILED_DERIVE, STATES.FAILED_PUBLISH, STATES.FAILED_READBACK].map((st) => classifyReason(st, r, RC)));
  ok("K1 (F3): the race-prone route FAILED_* codes (preflight-not-successful, reconcile-lease-lost, claim-terminal, finalize-open-work; bare, 'bundle-' and 'derive-not-ready:' wrapped; every FAILED state) are a BOUNDED transport retry + alert 'race-transient' -- never the catch-all integrity dead-letter; a DEFERRED form and the legacy kind keep their verdicts",
    J(RACE_TRANSIENT_CODES) === J(["preflight-not-successful", "reconcile-lease-lost", "claim-terminal", "finalize-open-work"]) && race.length === 36 && race.every((v) => v.cls === CLASSES.TRANSPORT && v.alert === "race-transient") && outcomeFor(CLASSES.TRANSPORT).outcome === "retry"
    && classifyReason(D, "claim-terminal", RC).cls === CLASSES.DEPENDENCY && classifyReason(D, "reconcile-lease-lost", RC).cls === CLASSES.CONTENTION && classifyReason(F, "claim-terminal", LG).alert !== "race-transient" && classifyReason(F, "payload-too-large", RC).cls === CLASSES.INTEGRITY);
  // F4 / F7 leading '-threw': the tail is a message, never a typed code.
  const T = (st, r, ctx = RC) => classifyReason(st, r, ctx);
  const tr = (v) => v.cls === CLASSES.TRANSPORT && v.alert === "route-step-threw";
  ok("K2 (F4/F7): a TYPED route reason whose LEADING code ends '-threw' is classified by that code BEFORE any substring rule reads its tail -- 'lineage-read-threw:brand-not-sold' is not not-applicable, ':evidence-advanced' not re-armed, 'bundle-resolve-threw:superseded-newer-live' not superseded, ':route-not-activated' not activated, DEFERRED_PROVENANCE 'revision-threw' not missing-evidence, 'derive-threw:newer-live-row-ahead' not superseded: each a bounded transport retry + alert 'route-step-threw'",
    REASON_RULES[0].id === "writer-fenced" && REASON_RULES[1].id === "leading-threw" && tr(T(D, "lineage-read-threw:brand-not-sold")) && tr(T(D, "lineage-read-threw:evidence-advanced")) && tr(T(D, "bundle-resolve-threw:superseded-newer-live")) && tr(T(D, "bundle-resolve-threw:route-not-activated"))
    && tr(T(P, "revision-threw")) && tr(T(D, "revision-threw")) && tr(T(F, "derive-threw:newer-live-row-ahead")) && tr(T(D, "derive-not-ready:derive-threw:TypeError")) && tr(T(STATES.FAILED_PUBLISH, "publish-threw:boom")) && tr(T(D, "controls-open-threw"))
    && leadingThrewHead("derive-not-ready:derive-threw:x").head === "derive-not-ready:derive-threw" && leadingThrewHead("bundle-resolve-threw:y").code === "bundle-resolve-threw" && leadingThrewHead("served-row-preempted:verdict-threw") === null);
  ok("K3 (F4/F7): ... the rules that name the LEADING code itself still apply to the head (publish-guard-threw keeps its own alert; a DEFERRED portfolio-derive-threw stays the route code-defect integrity); the CONTRACT-THROWN tails stay typed by their tail (the fba-plan fence -> route-not-activated, the fba-plan derive integrity error -> integrity); an UNTYPED '-threw' code stays unmapped (fail closed); the legacy kind keeps its frozen verdict",
    T(D, "publish-guard-threw:x").cls === CLASSES.TRANSPORT && T(D, "publish-guard-threw:x").alert === "publish-guard-threw" && T(D, "portfolio-derive-threw").cls === CLASSES.INTEGRITY && T(D, "portfolio-derive-threw").alert === "route-code-defect"
    && T(F, "derive-threw:fba-plan-route-fence-not-attested:").cls === CLASSES.ROUTE_NOT_ACTIVATED && T(F, "derive-threw:fba-plan-route-fence-not-attested: FBA_PLAN_ROUTE_FENCE_ATTESTED").cls === CLASSES.ROUTE_NOT_ACTIVATED
    && T(F, "derive-threw:fba-plan-derive-invalid:FBA_PLAN_SKU_ASIN_CONFLICT").cls === CLASSES.INTEGRITY && T(F, "derive-threw:fba-plan-derive-invalid:FBA_PLAN_SKU_ASIN_CONFLICT").alert === "derive-invalid"
    && T(F, "zz-new-route-code-threw").cls === CLASSES.UNKNOWN && /^unmapped-reason:/.test(S(T(D, "zz-new-threw:boom").alert)) && T(D, "lineage-read-threw:brand-not-sold", LG).cls === CLASSES.NOT_APPLICABLE);
  ok("K7 (WP14 e2e): a writer-fence refusal ('REPORT_WRITER_FENCED:<key>', RWF01; bare, in a -threw tail, route or legacy, deferred or failed) is INTEGRITY + alert 'writer-fenced' -- checked FIRST, never unclassified, never a retry loop against the fence",
    [[F, "REPORT_WRITER_FENCED:brand-sales"], [STATES.FAILED_PUBLISH, "publish-threw:REPORT_WRITER_FENCED:sku-movement"], [D, "REPORT_WRITER_FENCED:brand-view"]].every(([st, r]) => T(st, r).cls === CLASSES.INTEGRITY && T(st, r).alert === "writer-fenced")
    && T(F, "REPORT_WRITER_FENCED:brand-sales", LG).cls === CLASSES.INTEGRITY && T(F, "REPORT_WRITER_FENCED:brand-sales", LG).alert === "writer-fenced");
  // F8 strict default.
  const cur = { id: "A", tok: "t", units: [{ u: "-", rk: "x", s: STATES.CURRENT, r: null }] };
  const proven = { id: "A", tok: "t", units: [{ u: "-", rk: "x", s: STATES.CURRENT, r: null, h: "h1", sra: "s1", served: { id: "r", h: "h1", sra: "s1" } }] };
  ok("K4 (F8): jobVerdict with routeKind OMITTED (or unknown) defaults STRICT like classifyReason: a current unit without its own served read-back is 'current-unserved' even when ctx.servedConfirmed === true (never accepted leniently); with the unit proof it is current; ONLY the explicit legacy kind defers to ctx.servedConfirmed",
    jobVerdict(cur, ["x"]).cls === CLASSES.CURRENT_UNSERVED && jobVerdict(cur, ["x"], { servedConfirmed: true }).cls === CLASSES.CURRENT_UNSERVED && jobVerdict(cur, ["x"], { routeKind: "zz", servedConfirmed: true }).cls === CLASSES.CURRENT_UNSERVED
    && jobVerdict(proven, ["x"]).cls === CLASSES.CURRENT && jobVerdict(proven, ["x"]).servedConfirmed === true && jobVerdict(cur, ["x"], { ...LG, servedConfirmed: true }).servedConfirmed === true && jobVerdict(cur, ["x"], LG).servedConfirmed === null);
  // F2 the scope STOP.
  const scope = classifyRun({ stop: { code: "ROUTE_TARGET_OUT_OF_SCOPE" }, exitCode: 2, targets: null, result: null });
  ok("K5 (F2): a route CLI 'STOP ROUTE_TARGET_OUT_OF_SCOPE' (the directory-cache race) is a DEPENDENCY deferral (900 s > the 600 s directory TTL, NO attempt) + alert 'route-target-out-of-scope' -- never RUN_FAILED for the batch; every other STOP stays run-failed; the CLI emits exactly that STOP for an explicit target outside its scope",
    scope.cls === CLASSES.DEPENDENCY && scope.reason === "route-target-out-of-scope:ROUTE_TARGET_OUT_OF_SCOPE" && scope.alert === "route-target-out-of-scope" && J(outcomeFor(scope.cls)) === J({ outcome: "deferred", backoff: 900, alert: false })
    && J([...SCOPE_RACE_STOP_CODES]) === J(["ROUTE_TARGET_OUT_OF_SCOPE"]) && classifyRun({ stop: { code: "ROUTE_SCOPE_UNRESOLVED" } }).cls === CLASSES.RUN_FAILED && /STOP ROUTE_TARGET_OUT_OF_SCOPE: /.test(src("scripts/release/publication-route-reconcile.mjs")));
  // F5 the guard framing through the runner (synthetic child: a newline-less stderr write right before a guard line).
  const framed = async (lead) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    const zl = (n, x = {}) => "ZEROEXPORT " + JSON.stringify({ blocked: n, allowedAccountsGets: 0, ...x });
    const sp = () => { setImmediate(() => { child.stderr.write("warn: partial"); child.stderr.write(lead + zl(1) + "\n"); child.stderr.write("tail"); child.stderr.write(lead + zl(1, { final: true }) + "\n"); child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit("close", 0, null)); }); return child; };
    return runRoute({ appRoot: process.cwd(), route: "returns-v3", region: "india", asOf: "2026-09-24", kind: "dry-run", spawnImpl: sp });
  };
  const withLead = await framed("\n"), without = await framed("");
  const guardSrc = src("lib/server/recovery/zero-export-guard.mjs");
  ok("K6 (F5): the guard writes every ZEROEXPORT line as \"\\n\" + line + \"\\n\" (per block and the final summary), so the runner's UNCHANGED line-prefix parse counts it after a newline-less stderr write (blocked 1, final, 2 lines -> ZERO_EXPORT_VIOLATION); the old framing would have lost both lines",
    withLead.zeroExport.blocked === 1 && withLead.zeroExport.final === true && withLead.zeroExport.lines === 2 && classifyRun(withLead).cls === CLASSES.ZERO_EXPORT_VIOLATION && without.zeroExport.lines === 0
    && /const onBlock = \(\) => write\("\\n" \+ formatZeroExportLine\(counters\) \+ "\\n"\);/.test(guardSrc) && /process\.on\("exit", \(\) => write\("\\n" \+ formatZeroExportLine\(counters, \{ final: true \}\) \+ "\\n"\)\);/.test(guardSrc));
}

writeSync(1, `publication-recovery-units: ${passed} passed\n`);
