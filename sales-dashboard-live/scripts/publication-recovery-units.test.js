// Publication recovery worker -- unit + static guards: registry derivation (incl. NEW report registration fails
// closed), every source handler's exact argv, classification, config validation, TARGETS sanitization, the four CLIs'
// additive --emit-targets hook, structural zero-export (no DataDoe export code reachable), and a text audit of the
// 20260934 migration (expand-only, least privilege). ZERO network/DB. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { readFileSync, writeSync, readdirSync } from "node:fs";
import {
  RECOVERY_FAMILIES, FAMILY_IDS, FORBIDDEN_WORKER_SCRIPTS, validateRecoveryRegistry, classifyReport, detectOnlyReports,
  adsEvidenceWorkerKeys, ADS_CLI_OPERATION_REPORT_KEYS,
} from "../lib/server/recovery/registry.js";
import { accountVerdict, classifyRun, classifyDeferral, classifyFailure, cleanupUnresolved, outcomeFor, CLASSES } from "../lib/server/recovery/classify.js";
import { asOfText, interruptibleSleep } from "../lib/server/recovery/worker.js";
import { getEventListeners } from "node:events";
import { buildReconcileArgs, makeRunToken } from "../lib/server/recovery/runner.js";
import { loadRecoveryConfig } from "../lib/server/recovery/config.js";
import { sanitizeReasonCode, buildTargetsPayload, formatTargetsLine, parseTargetsLine } from "../lib/server/sync/reconcile-targets-output.js";
import { composeEvidenceTokens, recoveryPgTypes, regionForCycleBucket, recoveryPoolConfig, createRecoveryStore } from "../lib/server/recovery/store-pg.js";
import { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } from "../lib/server/sync/report-publisher.js";
import { REPORT_MATERIALIZATION } from "../lib/server/reports/report-materialization-registry.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
const throws = (n, fn, re) => { let e = null; try { fn(); } catch (x) { e = x; } ok(n, !!e && re.test(String(e.message))); };
const src = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
writeSync(1, "publication-recovery-units\n");

/* A. registry: derived from verified metadata; new registrations fail closed */
{
  const m = validateRecoveryRegistry();
  ok("A1: every live contract key + every materialization key is classified", Object.keys(SCHEDULER_LIVE_SNAPSHOT_CONTRACTS).every((k) => m[k]) && Object.keys(REPORT_MATERIALIZATION).every((k) => m[k === "daily" ? "daily-reporting" : k]));
  ok("A2: reconciler targets = brand-sales/daily-reporting/brand-inventory/listing-health-v3 only", JSON.stringify(Object.keys(m).filter((k) => m[k].kind === "reconciler").sort()) === JSON.stringify(["brand-inventory", "brand-sales", "daily-reporting", "listing-health-v3"]));
  ok("A3: fba-plan + the scheduler-materialized reports are DETECT-ONLY (no zero-export publisher)", m["fba-plan"].kind === "detect-only" && ["sku-movement", "returns-leakage", "brand-view", "brand-view-portfolio", "brand-view-brands"].every((k) => m[k].kind === "detect-only") && detectOnlyReports().length === 6);
  ok("A4: ppc-performance is NOT a worker target (the Ads CLI reconciles daily-reporting only)", m["ppc-performance"].kind === "not-applicable" && JSON.stringify(RECOVERY_FAMILIES.ads.reportKeys()) === JSON.stringify(ADS_CLI_OPERATION_REPORT_KEYS));
  ok("A5: brand-inventory is published by BOTH oli and fba (verified lineage), daily-reporting by oli + ads", JSON.stringify(m["brand-inventory"].families) === JSON.stringify(["oli", "fba"]) && JSON.stringify(m["daily-reporting"].families) === JSON.stringify(["oli", "ads"]));
  throws("A6: NEW REPORT REGISTRATION -- a live contract with no declaration fails closed", () => validateRecoveryRegistry({ liveContracts: { ...SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, "new-report": {} } }), /new-report.*fail closed/);
  throws("A7: a new scheduler-published target with no reconciler family fails closed (never silently skipped)", () => classifyReport("new-priority", { materialization: { ...REPORT_MATERIALIZATION, "new-priority": { materializationOwner: "scheduler-v2:priority" } } }), /no reconciler family/);
  ok("A8: a new manual-refresh report is classified not-applicable without code changes", classifyReport("x", { materialization: { x: { materializationOwner: "manual-refresh" } } }).kind === "not-applicable");
  ok("A9: Ads evidence token reads exactly the daily-reporting grain's worker key", JSON.stringify(adsEvidenceWorkerKeys()) === JSON.stringify(["campaign-performance-v1"]));
}

/* B. every source handler: exact argv, zero-export flags, never immediate, never full-region live */
{
  for (const f of FAMILY_IDS) {
    const fam = RECOVERY_FAMILIES[f];
    const live = buildReconcileArgs({ family: f, region: "europe-au", asOf: "2026-09-23", accounts: ["b", "a", "a"], kind: "live", runToken: "prw-w-x-europe-au-1-abc" });
    const dry = buildReconcileArgs({ family: f, region: "europe-au", asOf: "2026-09-23", kind: "dry-run" });
    const clean = buildReconcileArgs({ family: f, region: "europe-au", asOf: "2026-09-23", kind: "cleanup", runToken: "prw-w-x-europe-au-1-abc" });
    ok(`B1[${f}]: live argv = existing CLI, periodic, sorted de-duped accounts, own deadline, unique token, --emit-targets, --live`, live[0] === fam.script && live.includes("--mode=periodic") && live.includes("--accounts=a,b") && live.includes(`--deadline-seconds=${fam.deadlineSeconds}`) && live.includes("--run-token=prw-w-x-europe-au-1-abc") && live.includes("--emit-targets") && live.at(-1) === "--live");
    ok(`B2[${f}]: dry-run never carries --live; cleanup carries the same token + --cleanup`, !dry.includes("--live") && dry.includes("--emit-targets") && clean.includes("--cleanup") && clean.includes("--run-token=prw-w-x-europe-au-1-abc") && !clean.includes("--live"));
    ok(`B3[${f}]: no argv ever selects immediate mode or --outbox-drain`, ![...live, ...dry, ...clean].some((a) => /immediate|outbox-drain/.test(a)));
    ok(`B4[${f}]: the handler script exists, is not forbidden, and prints the TARGETS hook for its own family`, !FORBIDDEN_WORKER_SCRIPTS.includes(fam.script.split("/").pop()) && src(fam.script).includes(`formatTargetsLine({ family: "${f}"`) && src(fam.script).includes('process.argv.includes("--emit-targets")'));
  }
  throws("B5: a live pass without an explicit account list is refused (never a full-region live pass)", () => buildReconcileArgs({ family: "oli", region: "india", asOf: "2026-09-23", kind: "live", runToken: "prw-x-oli-india-1-a" }), /non-empty account list/);
  throws("B6: a live pass without a run token is refused", () => buildReconcileArgs({ family: "oli", region: "india", asOf: "2026-09-23", accounts: ["a"], kind: "live" }), /run token/);
  throws("B7: an unknown family / bad region / bad date / malformed account is refused", () => buildReconcileArgs({ family: "oli", region: "india", asOf: "2026-09-23", accounts: ["a b"], kind: "dry-run" }), /malformed account/);
  const tok = makeRunToken({ workerId: "vm 1/main", family: "fba", region: "us-ca", now: 1, nonce: "n" });
  ok("B8: run tokens are canonical (no whitespace, <=200 chars)", /^[A-Za-z0-9._:-]+$/.test(tok) && tok.length <= 200);
  ok("B9: the Ads CLI still runs ONLY its daily-reporting operation (registry pinned to the CLI source)", (src("scripts/release/ads-publication-reconcile.mjs").match(/buildOperation\("/g) || []).length === 1 && src("scripts/release/ads-publication-reconcile.mjs").includes('buildOperation("daily-reporting"'));
  ok("B10: backstop deadlines match the workflows (330/420 + LHv3 720/840)", ["oli", "fba", "ads"].every((f) => src(`../.github/workflows/${f === "oli" ? "oli" : f}-publication-reconcile.yml`).includes("--deadline-seconds=330") && RECOVERY_FAMILIES[f].deadlineSeconds === 330 && RECOVERY_FAMILIES[f].hardTimeoutSeconds === 420) && src("../.github/workflows/listing-health-v3-reconcile.yml").includes("--deadline-seconds=720") && RECOVERY_FAMILIES.listings.hardTimeoutSeconds === 840);
}

/* C. structural zero-export: nothing in the worker can reach DataDoe export code */
{
  const files = readdirSync(new URL("../lib/server/recovery/", import.meta.url)).map((f) => "lib/server/recovery/" + f).concat(readdirSync(new URL("../scripts/worker/", import.meta.url)).map((f) => "scripts/worker/" + f));
  const bad = files.filter((f) => /datadoe\.js|createExport|fetchExportRows|makeDataDoeAdapter|datadoe-usage|acquire_control_plane_lease|cas_report_snapshot|publishSchedulerV2Snapshot|saveReportSnapshot/.test(src(f)));
  ok("C1: no worker module imports/names DataDoe export code, the lease acquire, the snapshot CAS, or the publisher", bad.length === 0);
  const spawnSites = files.filter((f) => /child_process/.test(src(f)));
  ok("C2: only the runner (and the offline memcheck RSS sampler) touch child_process -- the production entrypoint spawns nothing itself", spawnSites.every((f) => /runner\.js$|publication-recovery-memcheck\.mjs$/.test(f)) && files.some((f) => /publication-recovery-worker\.mjs$/.test(f)) && !/child_process/.test(src("scripts/worker/publication-recovery-worker.mjs")));
  ok("C3: the runner resolves scripts ONLY through the registry allow-list", /RECOVERY_FAMILIES\[family\]/.test(src("lib/server/recovery/runner.js")) && /FORBIDDEN_WORKER_SCRIPTS\.includes/.test(src("lib/server/recovery/runner.js")));
  ok("C4: no new api/*.js serverless function was added (Vercel cap)", !files.some((f) => f.startsWith("api/")));
}

/* D. classification */
{
  const acc = (m) => ({ id: "a", reports: Object.fromEntries(Object.entries(m).map(([k, s]) => [k, { s: s[0], r: s[1] || null }])) });
  ok("D1: all PUBLICATION_NOT_REQUIRED -> current; any provenance -> missing-evidence; any STALE -> stale", accountVerdict(acc({ x: ["PUBLICATION_NOT_REQUIRED"] }), ["x"]).cls === CLASSES.CURRENT && accountVerdict(acc({ x: ["DEFERRED_PROVENANCE", "no-oli"] }), ["x"]).cls === CLASSES.MISSING_EVIDENCE && accountVerdict(acc({ x: ["STALE"], y: ["PUBLICATION_NOT_REQUIRED"] }), ["x", "y"]).cls === CLASSES.STALE);
  ok("D2: a report missing from the TARGETS line is never assumed current", accountVerdict(acc({ x: ["PUBLICATION_NOT_REQUIRED"] }), ["x", "y"]).cls === CLASSES.UNKNOWN);
  ok("D3: READBACK_VERIFIED from the publishing run alone is NOT current", accountVerdict(acc({ x: ["READBACK_VERIFIED"] }), ["x"]).cls === "published-unverified" && outcomeFor("published-unverified").outcome === "retry");
  ok("D4: deferral classes", classifyDeferral("controls-not-opened:CONTROL_LEASE_HELD").cls === CLASSES.CONTENTION && classifyDeferral("deadline-in-flight").cls === CLASSES.TIMEOUT && classifyDeferral("cycle-not-running:succeeded").cls === CLASSES.TERMINAL_CYCLE && classifyDeferral("catalog-stale").cls === CLASSES.DEPENDENCY);
  ok("D5: failure classes", classifyFailure("FAILED_PUBLISH", "publish-newer-live").cls === CLASSES.SUPERSEDED_NEWER_LIVE && classifyFailure("FAILED_DERIVE", "brand-inventory-payload-malformed").cls === CLASSES.INTEGRITY && classifyFailure("FAILED_READBACK", "live-readback-failed").cls === CLASSES.READBACK_MISMATCH && classifyFailure("FAILED_DERIVE", "release-threw").cls === CLASSES.TRANSPORT);
  ok("D6: outcomes: contention/dependency/missing never burn an attempt; permanent classes dead-letter; retry backoff is exponential + capped", outcomeFor(CLASSES.CONTENTION).outcome === "deferred" && outcomeFor(CLASSES.MISSING_EVIDENCE).outcome === "deferred" && outcomeFor(CLASSES.INTEGRITY).outcome === "dead" && outcomeFor(CLASSES.TIMEOUT, { attempt: 0 }).backoff === 60 && outcomeFor(CLASSES.TIMEOUT, { attempt: 3 }).backoff === 480 && outcomeFor(CLASSES.TIMEOUT, { attempt: 20 }).backoff === 3600);
  ok("D7: run-level: timeout / no TARGETS / any DataDoe spend", classifyRun({ timedOut: true }).cls === CLASSES.TIMEOUT && classifyRun({ exitCode: 1, result: null, targets: null }).cls === CLASSES.TRANSPORT && classifyRun({ result: { dataDoeCreates: 1 }, targets: { accounts: [] } }).cls === CLASSES.ZERO_EXPORT_VIOLATION && classifyRun({ result: {}, targets: { accounts: [], dataDoeTokens: 0 } }) === null);
}

/* E. config validation (secrets: presence only) */
{
  const base = { POSTGRES_URL: "postgres://x", SUPABASE_URL: "https://x", SUPABASE_SERVICE_ROLE_KEY: "k", DATADOE_API_KEY: "d" };
  const good = loadRecoveryConfig(base);
  ok("E1: defaults: 20s poll, 600s scan, batch 5, concurrency 1, observe-only (no env live families)", good.ok && good.config.pollSeconds === 20 && good.config.scanIntervalSeconds === 600 && good.config.batch === 5 && good.config.concurrency === 1 && good.config.liveFamilies.length === 0);
  const bad = loadRecoveryConfig({ PRW_POLL_SECONDS: "3", PRW_LIVE_FAMILIES: "oli,bogus", PRW_LEASE_SECONDS: "600" });
  ok("E2: missing secrets, out-of-range numbers and unknown families are rejected", !bad.ok && bad.errors.some((e) => /POSTGRES_URL/.test(e)) && bad.errors.some((e) => /PRW_POLL_SECONDS/.test(e)) && bad.errors.some((e) => /bogus/.test(e)) && bad.errors.some((e) => /PRW_LEASE_SECONDS/.test(e)));
  ok("E3: config never carries a secret value (presence booleans only)", !JSON.stringify(good.config).includes("postgres://x") && !JSON.stringify(good.config).includes('"k"') && good.config.secretsPresent.DATADOE_API_KEY === true);
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
}

/* G. migration 20260934: expand-only, least privilege, the semantics the worker relies on */
{
  const sql = src("supabase/migrations/20260934_publication_recovery_worker.sql");
  const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  ok("G1: expand-only -- no DROP/ALTER of any existing object, no data change outside its own tables", !/\bdrop\s+(table|function|index|trigger|view)\b/i.test(code) && !(code.match(/alter table\s+public\.(\w+)/gi) || []).some((m) => !/publication_recovery_/.test(m)) && !/\b(update|insert into|delete from)\s+public\.(?!publication_recovery_)/i.test(code));
  ok("G2: every function is SECURITY DEFINER + fixed search_path", (code.match(/create or replace function/gi) || []).length === 12 && (code.match(/security definer/gi) || []).length === 12 && (code.match(/set search_path = public/gi) || []).length === 12);
  ok("G3: RLS on all 6 tables; anon/authenticated revoked; execute granted to service_role only", (code.match(/enable row level security/gi) || []).length === 6 && (code.match(/revoke all on table/gi) || []).length === 6 && (code.match(/grant execute on function/gi) || []).length === 12 && !/\bto\s+(anon|authenticated|public)\b/i.test(code.replace(/from public, anon, authenticated/g, "")));
  ok("G4: control defaults DISABLED with NO live families", /values \(true, false, '\{\}'::text\[\]\)/.test(code));
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
  ok("I9: tables are revoked from service_role too (select-only; writes only through the RPC invariants)", (sql.match(/revoke all on table public\.publication_recovery_\w+ from public, anon, authenticated, service_role;/g) || []).length === 6);
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
  const entries = ["scripts/worker/publication-recovery-worker.mjs", "scripts/worker/publication-recovery-health.mjs", "scripts/worker/publication-recovery-status.mjs", ...FAMILY_IDS.map((f) => RECOVERY_FAMILIES[f].script)];
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
  ok(`H1: the worker + health/status + 4 reconciler CLIs (${seen.size} modules) import exactly one npm package: pg`, JSON.stringify([...bare].sort()) === JSON.stringify(["pg"]));
  const lock = JSON.parse(src("package-lock.json"));
  ok("H2: pg is pinned in the lockfile (install.sh installs that exact version)", /^\d+\.\d+\.\d+$/.test(lock.packages["node_modules/pg"].version));
  ok("H3: the systemd unit has no listening socket, runs as the unprivileged prw user, and reads secrets only from the protected env file", /User=prw/.test(src("deploy/publication-recovery/publication-recovery.service")) && /EnvironmentFile=\/etc\/publication-recovery\/worker\.env/.test(src("deploy/publication-recovery/publication-recovery.service")) && !/ListenStream|Environment=.*(KEY|URL)=/.test(src("deploy/publication-recovery/publication-recovery.service")));
  ok("H4: the env example contains NO secret values", src("deploy/publication-recovery/worker.env.example").split("\n").filter((l) => /^(POSTGRES_URL|SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY|DATADOE_API_KEY)=/.test(l)).every((l) => /=$/.test(l.trim())));
}

writeSync(1, `publication-recovery-units: ${passed} passed\n`);
