// Returns (FBA & FBM) event source -- SCHEDULER WIRING + OPERATOR SWITCH + REGISTRIES + REPUBLISH PATH, MAIN (scheduler) LINE.
// The main-line port of the production-line returns-source-workflow.test.js (DESIGN-v2 4.2-4.4). Offline pins for this line's
// .github/workflows/scheduler-v2.yml and the shared registries:
//   A. the returns_source job: appended LAST, right after bootstrap-ack with EXACTLY one blank line (the bootstrap-ack and
//      header blocks keep their pinned digests); needs [run, fba, materialize, materialize-inventory] (ordering only: its
//      republish lands after the base materialize job's); the execute_downstream + token + bootstrap gates; the five secrets
//      ONLY; the refresh step (continue-on-error, 45 min, per-region CAP/RESERVE 4/108 11/120 6/110 with RESERVE = 100 + 2 x
//      the asin_ads cap, unknown region -> STOP exit 2, the exact scheduled command, no operator-only flag) and the republish
//      step (only on rows_written == 'true': the base materialize job's own command + --only=returns-leakage) -- each pinned
//      byte for byte; nothing needs it. This line has NO fenced route CLI / recovery worker / zero-export guard;
//   B. scripts/release/returns-schedule-switch.mjs (byte-identical to the production line): static env/import ordering, the
//      only reachable writers, dry-run before every write, read-back after it, no secret / fingerprint / full account id in
//      any output -- and its PURE helper block evaluated in a vm sandbox;
//   C. registries: the scheduled family declaration, OPERATOR_SWITCHED_SOURCE_KEYS, the regional status fold, and the
//      cross-part contract names (refresh CLI flags, core key / regions: unconditional);
//   D. the returns-leakage republish path: the --only subset (grammar, a returns-only run derives only returns-leakage, the
//      CLI validates before any discovery), the 'returns' coverage reader binding, and the payload fingerprint that makes a
//      coverage-only day a real update.
// Zero network (fetch refused + counted), zero database, zero DataDoe, NO CLI is ever executed (a spawned CLI would load
// .env.local and reach production). 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

let passed = 0; let failed = 0;
const ok = (n, c) => { if (c) { passed += 1; writeSync(1, "  ok " + n + "\n"); } else { failed += 1; process.exitCode = 1; writeSync(1, "  not ok " + n + "\n"); } };
writeSync(1, "returns-source-workflow\n");

let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls += 1; throw new Error("returns-source-workflow: network is forbidden in this offline suite"); };

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, "..");
const REPO = path.resolve(here, "..", "..");
const lf = (s) => s.replace(/\r\n/g, "\n");
const readApp = (rel) => lf(readFileSync(path.join(APP, rel), "utf8"));
const readRepo = (rel) => lf(readFileSync(path.join(REPO, rel), "utf8"));
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/[^\n]*/g, "$1");
const count = (s, needle) => s.split(needle).length - 1;
const J = (v) => JSON.stringify(v);
const isAscii = (s) => [...s].every((c) => c.charCodeAt(0) < 128);

const wf = readRepo(".github/workflows/scheduler-v2.yml");
// The SAME job-block split as scheduler-v2-route-switch.test.js: a block starts at its `  <name>:` line walked back over the
// contiguous comment lines that document it, and ends where the next block starts.
function splitJobs(txt) {
  const L = txt.split("\n");
  const jobsAt = L.findIndex((l) => /^jobs:\s*$/.test(l));
  assert.ok(jobsAt > 0, "workflow has a jobs: key");
  const heads = [];
  for (let i = jobsAt + 1; i < L.length; i++) { const m = /^ {2}([a-z][a-z0-9_-]*):\s*$/.exec(L[i]); if (m) heads.push({ name: m[1], at: i }); }
  const starts = heads.map((h) => { let s = h.at; while (s - 1 > jobsAt && /^\s*#/.test(L[s - 1])) s--; return s; });
  const out = new Map([["<header>", L.slice(0, starts[0]).join("\n")]]);
  heads.forEach((h, k) => out.set(h.name, L.slice(starts[k], k + 1 < starts.length ? starts[k + 1] : L.length).join("\n")));
  return { blocks: out, starts: new Map(heads.map((h, k) => [h.name, starts[k]])), lines: L };
}
const { blocks: JOBS, starts: STARTS, lines: WL } = splitJobs(wf);
const job = (name) => { const b = JOBS.get(name); assert.ok(typeof b === "string" && b.length > 0, "job " + name + " exists"); return b; };
const codeOf = (block) => block.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n").replace(/\n+$/, "");
function stepsOf(block) {
  const L = block.split("\n"); const idx = [];
  L.forEach((l, i) => { if (/^ {6}- /.test(l)) idx.push(i); });
  return idx.map((s, k) => L.slice(s, k + 1 < idx.length ? idx[k + 1] : L.length).join("\n").replace(/\n+$/, ""));
}

/* ============================== A. the returns_source job ============================== */
const REGION = "${{ needs.run.outputs.region }}";
const EPOCH = "${{ needs.run.outputs.inventory_asof }}";
const ASOF = "${{ needs.run.outputs.asof }}";
const MATERIALIZE_CLI = "scripts/release/report-materialization.mjs";
const REFRESH_CLI = "scripts/release/scheduled-returns-refresh.mjs";
const GATE = "always() && needs.run.outputs.region != '' && needs.run.outputs.execute_downstream == 'true' && needs.run.outputs.token_proceed == 'true' && needs.run.outputs.scope != 'bootstrap'";
const REFRESH_CMD = `node ${REFRESH_CLI} --bucket=${REGION} --as-of=${ASOF} --scheduled --max-creates=$CAP --reserve-tokens=$RESERVE`;
// The base `materialize` job's own command (same CLI, region, live mode and --as-of ceiling) restricted to returns-leakage.
const MATERIALIZE_CMD = `node ${MATERIALIZE_CLI} --region=${REGION} --mode=live --as-of=${EPOCH}`;
const REPUBLISH_CMD = `${MATERIALIZE_CMD} --only=returns-leakage`;
const STEP_REFRESH = [
  "      - name: Refresh Returns (FBA & FBM) events (this region; additional durable source; runs only while schedule_enabled)",
  "        id: refresh",
  "        continue-on-error: true",
  "        timeout-minutes: 45",
  "        run: |",
  "          case \"" + REGION + "\" in",
  "            india) CAP=4; RESERVE=108 ;;",
  "            europe-au) CAP=11; RESERVE=120 ;;",
  "            us-ca) CAP=6; RESERVE=110 ;;",
  "            *) echo \"STOP unknown region " + REGION + "\" >&2; exit 2 ;;",
  "          esac",
  "          " + REFRESH_CMD,
].join("\n");
const STEP_REPUBLISH = [
  "      - name: Republish returns-leakage from the saved Returns events (zero export; only after the refresh wrote rows)",
  "        id: republish",
  "        if: always() && steps.refresh.outputs.rows_written == 'true'",
  "        timeout-minutes: 30",
  "        run: " + REPUBLISH_CMD,
].join("\n");
const EXPECTED_JOB = [
  "  returns_source:",
  "    needs: [run, fba, materialize, materialize-inventory]",
  "    if: " + GATE,
  "    runs-on: ubuntu-latest",
  "    timeout-minutes: 85",
  "    defaults:",
  "      run:",
  "        working-directory: sales-dashboard-live",
  "    env:",
  "      POSTGRES_URL: ${{ secrets.POSTGRES_URL }}",
  "      SUPABASE_URL: ${{ secrets.SUPABASE_URL }}",
  "      VITE_SUPABASE_URL: ${{ secrets.VITE_SUPABASE_URL }}",
  "      SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}",
  "      DATADOE_API_KEY: ${{ secrets.DATADOE_API_KEY }}",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      - uses: actions/setup-node@v4",
  "        with:",
  "          node-version: \"24\"",
  "      - name: Install dependencies",
  "        run: npm ci",
  STEP_REFRESH, STEP_REPUBLISH,
].join("\n");

const rs = job("returns_source");
const rsCode = codeOf(rs);
const jobNames = [...JOBS.keys()].filter((k) => k !== "<header>");
{
  ok("A1 the returns_source job (minus its YAML comment lines) is EXACTLY the reviewed text (needs / gate / runner / 85 min / working dir / five secrets / five steps)",
    rsCode === EXPECTED_JOB);
  // Placement: LAST, directly after bootstrap-ack, exactly ONE blank line between, a comment block above it, file ends in one LF.
  const at = STARTS.get("returns_source");
  ok("A2 appended LAST, right after bootstrap-ack, with EXACTLY one blank line between (a documenting comment block above the job; the file ends with a single newline)",
    J(jobNames.slice(-2)) === J(["bootstrap-ack", "returns_source"]) && WL[at - 1] === "" && WL[at - 2] === "          fi" && /^ {2}# /.test(WL[at])
    && wf.endsWith("\n") && !wf.endsWith("\n\n"));
  // The digests of the two blocks that border this edit at origin/main 260f61e: appending a job leaves both byte-identical.
  ok("A3 the bootstrap-ack block keeps its pinned digest (b49e612e...) and the workflow header (name / on / concurrency / permissions) its pinned digest (5bd4932b...)",
    sha256(job("bootstrap-ack")) === "b49e612e09af9c663400f1067a6f8be4790b7eb909329d2f36fb20512e47731a"
    && sha256(JOBS.get("<header>")) === "5bd4932bbaaf1d56bf30fa28d963d5b052f9f07052b0915bfa6d65daa9e67c32");
  ok("A4 needs [run, fba, materialize, materialize-inventory] is ORDERING only: the gate is always() + region + execute_downstream + token_proceed + not bootstrap, and NO upstream result / output other than needs.run.outputs is read anywhere in the job",
    /\n {4}needs: \[run, fba, materialize, materialize-inventory\]\n/.test(rsCode) && rsCode.includes("\n    if: " + GATE + "\n")
    && !/needs\.(fba|materialize|materialize-inventory)\.|needs\.run\.result/.test(rsCode));
  const steps = stepsOf(rs);
  const [checkout, setup, install, refresh, republish] = steps;
  ok("A5 five steps in order: checkout@v4, setup-node@v4 (node 24), npm ci, refresh, republish",
    steps.length === 5 && checkout === "      - uses: actions/checkout@v4" && setup.startsWith("      - uses: actions/setup-node@v4\n        with:\n          node-version: \"24\"")
    && install === "      - name: Install dependencies\n        run: npm ci" && /\n {8}id: refresh\n/.test(refresh) && /\n {8}id: republish\n/.test(republish));
  ok("A6 the refresh step is EXACTLY the reviewed text (id refresh, continue-on-error, 45 min, NO if:, NO step env)", refresh === STEP_REFRESH);
  ok("A7 the republish step is EXACTLY the reviewed text (id republish, only when rows_written == 'true', 30 min, NO step env, NEVER continue-on-error)", republish === STEP_REPUBLISH);
  // The republish is the base materialize job's command, byte for byte, plus ONLY --only=returns-leakage (same identity +
  // ceiling, so it writes exactly the snapshot the base job would write for returns-leakage and nothing else).
  ok("A8 the republish command is the `materialize` job's own command + --only=returns-leakage (same CLI / region / live mode / --as-of ceiling)",
    job("materialize").includes("\n        run: " + MATERIALIZE_CMD + "\n") && count(rsCode, MATERIALIZE_CMD) === 1
    && rsCode.endsWith("        run: " + REPUBLISH_CMD));
  // The per-region cap / reserve table, evaluated: every active region has one arm, an unknown region STOPs (exit 2), the cap is
  // within the create-slot RPC bound (0..60) and RESERVE = 100 + 2 x the asin_ads cap of the SAME region (DESIGN-v2 4.3).
  const arms = [...refresh.matchAll(/^ {12}([a-z-]+)\) CAP=(\d+); RESERVE=(\d+) ;;$/gm)].map((m) => [m[1], Number(m[2]), Number(m[3])]);
  const asinArms = new Map([...job("asin_ads").matchAll(/^ {12}([a-z-]+)\) CAP=(\d+) ;;$/gm)].map((m) => [m[1], Number(m[2])]));
  ok("A9 CAP/RESERVE india 4/108, europe-au 11/120, us-ca 6/110 (= 42 tokens/day ceiling); each cap within the slot RPC bound 0..60; RESERVE = 100 + 2 x that region's asin_ads cap; an unknown region STOPs with exit 2",
    J(arms) === J([["india", 4, 108], ["europe-au", 11, 120], ["us-ca", 6, 110]]) && arms.every(([, cap]) => cap >= 0 && cap <= 60)
    && arms.every(([r, , reserve]) => asinArms.has(r) && reserve === 100 + 2 * asinArms.get(r)) && arms.reduce((t, [, cap]) => t + cap * 2, 0) === 42
    && /^ {12}\*\) echo "STOP unknown region \$\{\{ needs\.run\.outputs\.region \}\}" >&2; exit 2 ;;$/m.test(refresh));
  ok("A10 the scheduled refresh passes ONLY --bucket / --as-of (the run's asof; no date computed in YAML) / --scheduled / --max-creates / --reserve-tokens: never an operator-only flag (--confirm-paid, --accounts, --allow-shrink, --dry-run, --no-adopt-list, --evidence-file)",
    count(rsCode, REFRESH_CMD) === 1 && !/--confirm-paid|--accounts|--allow-shrink|--dry-run|--no-adopt-list|--evidence-file|--force/.test(rsCode)
    && !/\bdate\b\s+-u|\$\(date/.test(rsCode));
  ok("A11 no NODE_OPTIONS / preload anywhere in the job (no step or job env beyond the five secrets)",
    !/NODE_OPTIONS|--import=/.test(rsCode) && count(rsCode, "\n        env:") === 0);
  ok("A12 the job env is the five secrets ONLY: no DATADOE_API_KEY_SECONDARY, no PRIORITY_OPERATOR, no repo variable, no job-level NODE_OPTIONS",
    !/DATADOE_API_KEY_SECONDARY|PRIORITY_OPERATOR|\$\{\{ vars\./.test(rs) && count(rsCode, "${{ secrets.") === 5);
  ok("A13 exactly ONE continue-on-error (the refresh: a source failure never fails the run) -- the republish step keeps a HARD failure red",
    count(rsCode, "continue-on-error") === 1 && !/continue-on-error/.test(republish));
  ok("A14 the only scripts the job runs are the refresh CLI (once) and the materialization CLI (once, returns-leakage only): no legacy returns go-live, no Settlements / OLI / Ads / FBA operator",
    J([...rsCode.matchAll(/node (scripts\/[^\s"']+)/g)].map((m) => m[1])) === J([REFRESH_CLI, MATERIALIZE_CLI])
    && !/returns-leakage-golive|oli-refresh|campaign|asin|fba-plan|settlement/i.test(rsCode.replace(/scheduled-returns-refresh/g, "")));
  const jobTimeout = Number((/\n {4}timeout-minutes: (\d+)\n/.exec(rsCode) || [])[1]);
  const stepTimeouts = [refresh, republish].map((s) => Number((/\n {8}timeout-minutes: (\d+)\n/.exec(s + "\n") || [])[1]));
  ok(`A15 the job timeout (${jobTimeout} min) covers refresh ${stepTimeouts[0]} + republish ${stepTimeouts[1]} + >= 5 min setup`,
    jobTimeout === 85 && J(stepTimeouts) === J([45, 30]) && jobTimeout >= stepTimeouts.reduce((a, b) => a + b, 0) + 5);
  // YAML sanity without a parser (none is a dependency): spaces only, even indentation, the job's keys in the reviewed order.
  const L = rs.split("\n");
  ok("A16 YAML sanity: no tabs, every line indented by an even number of spaces, job keys exactly [needs, if, runs-on, timeout-minutes, defaults, env, steps], 7-bit ASCII",
    !/\t/.test(rs) && L.every((l) => l === "" || ((/^ */.exec(l)[0].length % 2) === 0)) && isAscii(rs)
    && J(L.map((l) => /^ {4}([a-z-]+):/.exec(l)).filter(Boolean).map((m) => m[1])) === J(["needs", "if", "runs-on", "timeout-minutes", "defaults", "env", "steps"]));
}
{
  // Nothing waits on returns_source and nothing outside it runs the refresh CLI; no native schedule appeared.
  const needsOf = (name) => { const m = /\n {4}needs: (\[[^\]]*\]|[A-Za-z0-9_-]+)\n/.exec(job(name)); return m ? m[1].replace(/[[\]\s]/g, "").split(",").filter(Boolean) : []; };
  ok("A17 NO job needs returns_source and no expression reads needs.returns_source (it is never a prerequisite of a publication or an ack)",
    jobNames.every((n) => !needsOf(n).includes("returns_source")) && !/needs\.returns_source/.test(wf));
  ok("A18 the refresh CLI appears in the workflow exactly once (this job); the run job's publication path never runs it; scheduler-v2 still has NO native schedule",
    count(wf, "scheduled-returns-refresh.mjs") === 1 && !/scheduled-returns-refresh/.test(job("run")) && !/^\s*schedule:/m.test(wf) && !/- cron:/.test(wf));
  ok("A19 --only appears in the workflow code exactly once (this job's republish); the base materialize job still materializes EVERY owned report",
    count(codeOf(wf), "--only=") === 1 && count(rsCode, "--only=returns-leakage") === 1 && !/--only/.test(job("materialize")) && !/--only/.test(job("materialize-inventory")));
}
{
  // The refresh CLI (DESIGN-v2 4.1) must exist, accept every flag the job passes and emit the rows_written step output the
  // republish step gates on. UNCONDITIONAL: a missing CLI is a failure, never a skip.
  const cli = existsSync(path.join(APP, REFRESH_CLI)) ? readApp(REFRESH_CLI) : "";
  ok("A23 scheduled-returns-refresh.mjs EXISTS, handles every flag the job passes (bucket / as-of / scheduled / max-creates / reserve-tokens) and writes rows_written to $GITHUB_OUTPUT",
    cli.length > 0 && ["bucket", "as-of", "scheduled", "max-creates", "reserve-tokens"].every((f) => cli.includes(f)) && /rows_written/.test(cli) && /GITHUB_OUTPUT/.test(cli));
}

/* ============================== D. the returns-leakage republish path (main line) ============================== */
{
  const OP = await import("../lib/server/sync/report-materialization-operation.js");
  // --only grammar: null = every owned report; an owned key list -> that Set; an unknown key or an empty list THROWS.
  const throws = (v) => { try { OP.normalizeReportSubset(v); return false; } catch { return true; } };
  ok("D1 normalizeReportSubset: null = all; ['returns-leakage'] / 'returns-leakage' -> that one key; an unknown key, an empty list or a blank value refuses",
    OP.normalizeReportSubset(null) === null && OP.normalizeReportSubset(undefined) === null
    && J([...OP.normalizeReportSubset(["returns-leakage"])]) === J(["returns-leakage"]) && J([...OP.normalizeReportSubset("returns-leakage")]) === J(["returns-leakage"])
    && throws(["returns"]) && throws([]) && throws([" "]) && throws(["returns-leakage", "bogus"]) && OP.RETURNS_REPORT_KEY === "returns-leakage");
  // A returns-only run derives ONLY returns-leakage (no brand directory, no SKU Movement), with the SAME { to } identity
  // and ceiling as a full run; a full run is unchanged (all three families). Dry-run fakes: no store, no network.
  const calls = [];
  const collab = {
    deriveBrandViewBrands: async ({ accountId }) => { calls.push("brands:" + accountId); return { brands: ["B1"] }; },
    deriveSkuMovement: async ({ accountId, brand }) => { calls.push("sku:" + accountId + ":" + brand); return { notReady: "x" }; },
    deriveReturns: async ({ accountId, asOf }) => { calls.push("returns:" + accountId + ":" + asOf); return { payload: { latestDataDate: "2026-10-03" }, latestDataDate: "2026-10-03", sourceRefreshedAt: "2026-10-04T00:00:00.000Z" }; },
  };
  const accounts = [{ accountId: "acct-1" }, { accountId: "acct-2" }];
  const only = await OP.runReportMaterialization({ region: "india", accounts, ceiling: "2026-10-04", dryRun: true, only: ["returns-leakage"] }, collab);
  const onlyCalls = calls.splice(0);
  const full = await OP.runReportMaterialization({ region: "india", accounts, ceiling: "2026-10-04", dryRun: true }, collab);
  const fullCalls = calls.splice(0);
  let unknownRefused = false;
  try { await OP.runReportMaterialization({ region: "india", accounts, ceiling: "2026-10-04", dryRun: true, only: ["bogus"] }, collab); } catch { unknownRefused = true; }
  ok("D2 a returns-only run derives ONLY returns-leakage per account (same ceiling), every event is a returns-leakage unit; a full run still derives all three families; an unknown key refuses before any derive",
    J(onlyCalls) === J(["returns:acct-1:2026-10-04", "returns:acct-2:2026-10-04"]) && only.events.every((e) => e.report === "returns-leakage") && only.summary.tokens === 0
    && fullCalls.includes("brands:acct-1") && fullCalls.includes("sku:acct-1:ALL") && fullCalls.includes("returns:acct-2:2026-10-04")
    && full.events.some((e) => e.report === "sku-movement") && unknownRefused && calls.length === 0);
  // The CLI flag: parsed, validated through the SAME normalizeReportSubset BEFORE any account discovery, refused with exit 2,
  // and handed to the operator. Static checks only (running the CLI would load .env.local).
  const mcli = stripComments(readApp(MATERIALIZE_CLI));
  const iOnly = mcli.indexOf("normalizeReportSubset(only)"), iRelease = mcli.indexOf("buildReportMaterializationRelease({"), iDiscover = mcli.indexOf("await release.discoverAccounts(");
  ok("D3 report-materialization.mjs: --only is split on commas, validated by normalizeReportSubset BEFORE the release is built or any account is discovered, refused with exit 2, and passed to runReportMaterialization",
    /const onlyArg = argOf\("only", null\);/.test(mcli) && iOnly > 0 && iOnly < iRelease && iOnly < iDiscover
    && /invalid --only[^\n]*Refusing\.`\);\n\s*process\.exit\(2\);/.test(mcli)
    && /runReportMaterialization\(\{ region, accounts, ceiling, dryRun, only \}/.test(mcli));
  // The derive reads the Returns event-source coverage through its own key and the payload carries a content fingerprint, so
  // a coverage-only day (no new return date, no rewritten row) is a real update (materializeSnapshot compares depFingerprint).
  const comp = stripComments(readApp("lib/server/sync/report-materialization-composition.js"));
  ok("D4 the composition binds readReturnsCoverage = getSourceCoverageWindows with source_key 'returns' into the Returns readers",
    /readReturnsCoverage = \(a\) => getSourceCoverageWindows\(\{ \.\.\.a, sourceKey: "returns" \}\)/.test(comp)
    && /const returnsReaders = \{[^}]*readReturnsCoverage,[^}]*\};/.test(comp));
  const PUB = await import("../lib/server/reports/returns-publish.js");
  const base = { accountId: "acct-1", latestDataDate: "2026-10-01", returnsCoveredThrough: "2026-10-03", returnsCoverageWindows: [{ from: "2026-08-05", to: "2026-10-03" }], rows: [{ asin: "A1", returnCount: 1 }] };
  const fp = (o) => PUB.returnsPayloadFingerprint({ ...base, ...o });
  ok("D5 returnsPayloadFingerprint: stable for the same payload, and moved by a coverage-only change (later coverage, a legacy horizon) or any row change",
    fp({}) === fp({}) && /^[0-9a-f]{40}$/.test(fp({})) && fp({ returnsCoveredThrough: "2026-10-04", returnsCoverageWindows: [{ from: "2026-08-05", to: "2026-10-04" }] }) !== fp({})
    && fp({ returnsLegacyCoveredThrough: "2026-08-31" }) !== fp({}) && fp({ rows: [{ asin: "A1", returnCount: 2 }] }) !== fp({}));
  // gatherReturnsEvidence end to end on fakes: the coverage is read FIRST (before the history rows), it reaches the payload,
  // and the result carries depFingerprint = returnsPayloadFingerprint(payload); an absent reader is not a failure.
  const order = [];
  const readers = {
    readReturnsCoverage: async (a) => { order.push("coverage:" + a.accountId); return { read: "ok", windows: [{ from: "2026-08-05", to: "2026-10-03" }] }; },
    readReturnsHistory: async () => { order.push("returns"); return [{ account_id: "acct-1", return_date: "2026-10-01", sku: "S1", child_asin: "B000000001", amazon_return_reason: "DEFECTIVE", fulfillment_channel: "FBA", request_status: "Approved", label_payer: "Amazon", return_count: 1, returned_units: 1, refunded_amount: "0", label_cost: "0", cogs_total_value: "0", refreshed_at: "2026-10-04T03:00:00Z" }]; },
    readSettlementHistory: async () => { order.push("settlement"); return []; },
    readOliHistory: async () => [], readOliCoverage: async () => ({ read: "ok", windows: [] }), readOliOperationalUnits: async () => [],
    readCatalogSnapshot: async () => null, loadCatalogPayload: async () => null, readOliSkuAsinResolution: async () => [], readDirectory: async () => [],
  };
  const ev = await PUB.gatherReturnsEvidence({ accountId: "acct-1", organizationFingerprint: "fp-test", asOf: "2026-10-04" }, readers);
  const { readReturnsCoverage: _omit, ...noCoverage } = readers;
  const ev0 = await PUB.gatherReturnsEvidence({ accountId: "acct-1", organizationFingerprint: "fp-test", asOf: "2026-10-04" }, noCoverage);
  ok("D6 gatherReturnsEvidence reads the 'returns' coverage BEFORE the history rows, carries it into the payload, returns depFingerprint = returnsPayloadFingerprint(payload); without the reader it still derives (coverage fields empty, a different fingerprint)",
    order[0] === "coverage:acct-1" && order.indexOf("returns") > 0 && !!ev && !!ev.payload && ev.payload.returnsCoveredThrough === "2026-10-03"
    && ev.depFingerprint === PUB.returnsPayloadFingerprint(ev.payload) && !!ev0 && !!ev0.payload && ev0.payload.returnsCoveredThrough == null
    && typeof ev0.depFingerprint === "string" && ev0.depFingerprint !== ev.depFingerprint);
}

/* ============================== B. the operator switch ============================== */
const SWITCH_REL = "scripts/release/returns-schedule-switch.mjs";
const SW = readApp(SWITCH_REL);
const swCode = stripComments(SW);
{
  const staticImports = [...swCode.matchAll(/^import\s[^\n]*from\s+"([^"]+)";/gm)].map((m) => m[1]);
  const dynImports = [...swCode.matchAll(/await import\("([^"]+)"\)/g)].map((m) => m[1]);
  const iUsage = swCode.indexOf("process.exit(2);"), iEnv = swCode.indexOf("\nloadReleaseEnv();"), iDyn = swCode.indexOf("await import(");
  ok("B1 env ordering: its ONLY static import is ./env-bootstrap.mjs; the usage STOP (exit 2) runs BEFORE loadReleaseEnv() (called once), which runs BEFORE every dynamic import",
    J(staticImports) === J(["./env-bootstrap.mjs"]) && iUsage > 0 && iUsage < iEnv && iEnv < iDyn && count(swCode, "loadReleaseEnv(") === 1 && count(swCode, "process.exit(2)") === 1);
  ok("B2 it imports ONLY supabase.js (the reviewed wrappers), datadoe-connections.js (the primary fingerprint) and scheduler-scope.js (region routing)",
    J([...dynImports].sort()) === J(["../../lib/server/datadoe-connections.js", "../../lib/server/supabase.js", "../../lib/server/sync/scheduler-scope.js"]));
  const supaImport = /const \{ ([^}]+) \} = await import\("\.\.\/\.\.\/lib\/server\/supabase\.js"\);/.exec(swCode);
  const supaNames = supaImport ? supaImport[1].split(",").map((s) => s.trim()).filter(Boolean).sort() : null;
  ok("B3 the ONLY database surface: NAMED imports getSourceControls / setSourceControl (the one 'returns' row) / getReturnsAccountStates + the two CONTRACT D release wrappers (never the module namespace as a value, so the writer-fence analysis proves no report_snapshots sink) -- no request / fetch / pg / rpc path, no env or key access",
    J(supaNames) === J(["getReturnsAccountStates", "getSourceControls", "releaseReturnsIdentityHold", "releaseReturnsLegacyFence", "setSourceControl"])
    && !/\bsb\b/.test(swCode) && count(swCode, "await setSourceControl(") === 1
    && /await setSourceControl\(\{ sourceKey: RETURNS_CONTROL_KEY, \.\.\.plan\.write \}\)/.test(swCode) && count(swCode, "await releaseFn(") === 1
    && /const releaseFn = parsed\.action === "release-hold" \? releaseReturnsIdentityHold : releaseReturnsLegacyFence;/.test(swCode)
    && !/\bfetch\s*\(|\brequest\s*\(|\bpg\b|new Client|\/rest\/v1|\/rpc\/|process\.env|apiKey|DATADOE_API_KEY|SERVICE_ROLE|POSTGRES_URL|child_process|writeFile/.test(swCode));
  ok("B4 the release wrappers get the PRIMARY organization fingerprint + connection 'primary' + the region the stored marketplace routes to (CONTRACT D argument names)",
    /const orgFp = primaryOrganizationFingerprint\(\);/.test(swCode) && /if \(!orgFp\) stop\("RETURNS_NO_PRIMARY_CONNECTION"/.test(swCode)
    && /await releaseFn\(\{ organizationFingerprint: orgFp, connectionId: "primary", accountId: parsed\.accountId, runKey, region \}\)/.test(swCode)
    && /await getReturnsAccountStates\(\{ organizationFingerprint: orgFp, connectionId: "primary", accountIds: \[parsed\.accountId\] \}\)/.test(swCode)
    && /const region = before \? regionForCountry\(before\.marketplace_country_code\) : "";/.test(swCode));
  const dry = [...swCode.matchAll(/if \(!parsed\.apply\) process\.exit\(0\);/g)].map((m) => m.index);
  const iSet = swCode.indexOf("await setSourceControl("), iRel = swCode.indexOf("await releaseFn(");
  ok("B5 DRY RUN by default: --apply gates BOTH writes; the paused / release refusals are decided BEFORE that gate (a dry run shows them too)",
    dry.length === 2 && dry[0] < iSet && dry[1] < iRel && dry[1] > iSet
    && swCode.indexOf("if (plan.refused) stop(") < dry[0] && swCode.indexOf("if (refusal) stop(") > iSet && swCode.indexOf("if (refusal) stop(") < dry[1]);
  const afterSet = swCode.slice(iSet), afterRel = swCode.slice(iRel);
  ok("B6 every write is READ BACK and verified before COMMITTED (control: controlVerified; release: releaseVerified), a mismatch exits 1",
    afterSet.indexOf("await readControl()") > 0 && afterSet.indexOf("controlVerified(after, plan.write)") > afterSet.indexOf("await readControl()")
    && afterSet.indexOf("RETURNS_SWITCH_READBACK_MISMATCH") > 0 && afterRel.indexOf("await readState()") > 0
    && afterRel.indexOf("releaseVerified(after, parsed.action)") > afterRel.indexOf("await readState()") && afterRel.indexOf("RETURNS_RELEASE_READBACK_MISMATCH") > 0);
  // Redaction (public repo): the fingerprint is never printed; the full account id only reaches the reads / the RPC / mask8.
  const lines = swCode.split("\n");
  const fpLines = lines.filter((l) => /\borgFp\b/.test(l));
  const idLines = lines.filter((l) => /parsed\.accountId/.test(l));
  ok("B7 OUTPUT CONTRACT: the organization fingerprint is NEVER in an output line; the full account id appears only in the state read, its row filter, the release call and mask8 (8 chars)",
    fpLines.every((l) => !/\b(log|stop|console\.\w+)\(/.test(l) || /stop\("RETURNS_NO_PRIMARY_CONNECTION"/.test(l) || /^\s*try \{ r = await getReturnsAccountStates\(/.test(l))
    && fpLines.every((l) => !/\+\s*orgFp|orgFp\s*\+/.test(l))
    && idLines.every((l) => /accountIds: \[parsed\.accountId\]|x\.account_id === parsed\.accountId|accountId: parsed\.accountId, runKey|mask8\(parsed\.accountId\)/.test(l))
    && !/\+\s*parsed\.accountId|parsed\.accountId\s*\+/.test(swCode) && !/e\.message|err\.message|\.stack\b/.test(swCode));
  ok("B8 the switch is 7-bit ASCII + LF and never names a secret value", isAscii(SW) && !/\r/.test(SW));
}
// The PURE helper block, evaluated in a vm sandbox (no loader, no env, no process): the argv grammar and every decision.
const BEGIN = "// ---- PURE helpers", END = "// ---- END PURE helpers ----";
const iB = SW.indexOf(BEGIN), iE = SW.indexOf(END);
const pureBlock = iB > 0 && iE > iB ? SW.slice(iB, iE) : "";
ok("B9 the pure helper block exists before loadReleaseEnv() and is self-contained (no import / require / process / await / fetch / globalThis / eval)",
  pureBlock.length > 0 && iE < SW.indexOf("\nloadReleaseEnv();") && !/\bimport\b|\brequire\s*\(|\bprocess\b|\bawait\b|\bfetch\b|globalThis|\beval\b|Function\(/.test(stripComments(pureBlock)));
const sandbox = vm.createContext({});
vm.runInContext(pureBlock + "\n;globalThis.__api = { parseSwitchArgv, controlTarget, controlVerified, releaseRefusal, releaseVerified, stateSummary, mask8, RETURNS_CONTROL_KEY, RETURNS_REGIONS, RELEASE_RPC, RELEASE_WRAPPER };", sandbox, { timeout: 2000 });
const api = sandbox.__api;
const ID = "a0000001-0000-4000-8000-000000000000"; // synthetic (never a real seller / account id)
{
  const p = (argv) => { const r = api.parseSwitchArgv(argv); return JSON.parse(J(r)); };
  const e = p(["--enable"]), d = p(["--disable", "--apply"]), h = p(["--release-hold=" + ID, "--apply"]), f = p(["--release-fence=" + ID]);
  ok("B10 argv: --enable is a DRY RUN by default; --disable --apply applies; --release-hold=<id> / --release-fence=<id> carry ONE account id",
    e.ok === true && e.action === "enable" && e.apply === false && e.accountId === null && d.ok === true && d.action === "disable" && d.apply === true
    && h.ok === true && h.action === "release-hold" && h.apply === true && h.accountId === ID && f.ok === true && f.action === "release-fence" && f.apply === false);
  const refused = [[], ["--apply"], ["--enable", "--disable"], ["--enable", "--enable"], ["--disable", "--unpause"], ["--enable", "--keep-unpaused"],
    ["--release-hold=" + ID, "--unpause"], ["--release-hold=" + ID, "--release-fence=" + ID], ["--release-hold=" + ID, "--enable"], ["--release-hold="],
    ["--release-hold=dd-secondary:" + ID], ["--release-hold=" + ID + "," + ID], ["--release-hold=" + ID, "--release-hold=" + ID], ["--ENABLE"], ["--live"],
    ["enable"], ["--enable=true"], ["--apply=yes", "--enable"], ["--release-hold", ID]];
  ok("B11 argv: every malformed / ambiguous invocation is REFUSED (no action, two actions, duplicates, a flag outside its action, a blank / prefixed / listed id, unknown or positional arguments)",
    refused.every((a) => p(a).ok === false));
  const leak = [p(["--enable", ID]), p(["--release-hold=" + ID + "!"]), p(["--" + ID])];
  ok("B12 a refusal message NEVER echoes an id-shaped argument (positions / flag names only)",
    leak.every((r) => r.ok === false && typeof r.message === "string" && !r.message.includes(ID.slice(0, 9))));
  const T = (before, args) => JSON.parse(J(api.controlTarget(before, args)));
  const pausedEnable = T({ paused: true, schedule_enabled: false }, { action: "enable" });
  ok("B13 --enable REFUSES while paused (typed RETURNS_SWITCH_PAUSED, even as a dry run); --unpause clears the pause in the SAME write; unpaused -> schedule_enabled only",
    pausedEnable.refused === "RETURNS_SWITCH_PAUSED" && !pausedEnable.write
    && J(T({ paused: true }, { action: "enable", unpause: true }).write) === J({ scheduleEnabled: true, paused: false })
    && J(T({ paused: false }, { action: "enable" }).write) === J({ scheduleEnabled: true }));
  ok("B14 --disable writes schedule_enabled=false AND paused=true (Tier-1 rollback); --keep-unpaused leaves paused untouched",
    J(T({ paused: false, schedule_enabled: true }, { action: "disable" }).write) === J({ scheduleEnabled: false, paused: true })
    && J(T({ paused: false }, { action: "disable", keepUnpaused: true }).write) === J({ scheduleEnabled: false }));
  ok("B15 the control read-back proof: schedule_enabled AND (when written) paused must equal the target",
    api.controlVerified({ schedule_enabled: false, paused: true }, { scheduleEnabled: false, paused: true }) === true
    && api.controlVerified({ schedule_enabled: false, paused: false }, { scheduleEnabled: false, paused: true }) === false
    && api.controlVerified({ schedule_enabled: true, paused: true }, { scheduleEnabled: true }) === true
    && api.controlVerified(null, { scheduleEnabled: true }) === false);
  const st = (o) => ({ account_id: ID, marketplace_country_code: "GB", initial_status: "loaded", identity_status: "ambiguous", hold_reason: "RETURNS_IDENTITY_AMBIGUOUS", legacy_fence: true, last_status: "succeeded", ...o });
  const R = (s, a, r) => { const x = api.releaseRefusal(s, a, r); return x ? x.code : null; };
  ok("B16 release preconditions: no state row / no hold / fence already released / an unroutable marketplace are typed refusals (zero writes); a held or fenced account in an active region may proceed",
    R(null, "release-hold", "europe-au") === "RETURNS_STATE_ROW_MISSING" && R(st({ hold_reason: null }), "release-hold", "europe-au") === "RETURNS_NO_HOLD"
    && R(st({ hold_reason: " " }), "release-hold", "europe-au") === "RETURNS_NO_HOLD" && R(st({ legacy_fence: false }), "release-fence", "europe-au") === "RETURNS_FENCE_NOT_SET"
    && R(st(), "release-hold", "unassigned") === "RETURNS_REGION_UNRESOLVED" && R(st(), "release-hold", "europe-au") === null && R(st(), "release-fence", "india") === null
    && R(st(), "enable", "india") === "RETURNS_SWITCH_ACTION");
  // A hold release while a replace still awaits its post-commit confirm would let that pending confirm read identity
  // 'clear' and promote the AMBIGUOUS load (DESIGN-v2 1.11b): the switch refuses it exactly like the RPC does.
  ok("B16b --release-hold is REFUSED (typed RETURNS_CONFIRM_PENDING, zero writes) while the state's last_status is 'replaced'; a verified held account may proceed",
    R(st({ last_status: "replaced" }), "release-hold", "europe-au") === "RETURNS_CONFIRM_PENDING"
    && R(st({ last_status: "failed" }), "release-hold", "europe-au") === null && R(st({ last_status: null }), "release-hold", "india") === null
    && R(st({ last_status: "replaced", hold_reason: null }), "release-hold", "india") === "RETURNS_NO_HOLD");
  ok("B17 release read-back proofs: hold -> hold cleared + identity clear + initial pending; fence -> legacy_fence false + initial pending",
    api.releaseVerified({ hold_reason: null, identity_status: "clear", initial_status: "pending" }, "release-hold") === true
    && api.releaseVerified({ hold_reason: "RETURNS_IDENTITY_AMBIGUOUS", identity_status: "clear", initial_status: "pending" }, "release-hold") === false
    && api.releaseVerified({ hold_reason: null, identity_status: "clear", initial_status: "loaded" }, "release-hold") === false
    && api.releaseVerified({ legacy_fence: false, initial_status: "pending" }, "release-fence") === true
    && api.releaseVerified({ legacy_fence: true, initial_status: "pending" }, "release-fence") === false && api.releaseVerified(null, "release-fence") === false);
  const summary = api.stateSummary(st({ seller_or_vendor_id: ID, identity_detail: { keyedFba: 3, keyCollisions: 1, orderId: "123-4567890-1234567", unkeyed: -1 }, last_error_code: "drop table x" }));
  ok("B18 the state summary prints typed statuses + identity COUNTS only: never an account / seller id, an unknown detail key, a negative count or an untyped value",
    !summary.includes(ID.slice(0, 9)) && !summary.includes("123-4567890") && /identity_counts\{keyedFba=3,keyCollisions=1\}/.test(summary)
    && /hold_reason=RETURNS_IDENTITY_AMBIGUOUS/.test(summary) && /last_error_code=\?/.test(summary) && /legacy_fence=true/.test(summary)
    && api.stateSummary(null) === "state=absent" && api.mask8(ID) === ID.slice(0, 8));
  ok("B19 the switch names the CONTRACT D wrappers + DESIGN-v2 1.11 / 1.11b RPCs, the 'returns' control key and the three active regions",
    api.RELEASE_WRAPPER["release-hold"] === "releaseReturnsIdentityHold" && api.RELEASE_WRAPPER["release-fence"] === "releaseReturnsLegacyFence"
    && api.RELEASE_RPC["release-hold"] === "release_returns_identity_hold" && api.RELEASE_RPC["release-fence"] === "release_returns_legacy_fence"
    && api.RETURNS_CONTROL_KEY === "returns" && J([...api.RETURNS_REGIONS]) === J(["india", "europe-au", "us-ca"]));
  // A legacy handback is a Tier-1 rollback step only: while the schedule is ON (or the control row is unreadable) the next
  // regional run would re-own the account with a fresh paid initial load, so --release-fence refuses BEFORE the --apply gate.
  const iFenceRefusal = swCode.indexOf('if (parsed.action === "release-fence" && scheduleOn !== false) {');
  const releaseGate = [...swCode.matchAll(/if \(!parsed\.apply\) process\.exit\(0\);/g)].map((m) => m.index)[1];
  const iReleaseWrite = swCode.indexOf("await releaseFn(");
  ok("B20 --release-fence is REFUSED while the schedule is ON or the control row is unreadable (RETURNS_SCHEDULE_ON / RETURNS_CONTROLS_UNREADABLE), decided BEFORE the --apply gate and the release write",
    iFenceRefusal > 0 && releaseGate > 0 && iFenceRefusal < releaseGate && iFenceRefusal < iReleaseWrite
    && /scheduleOn = row \? row\.schedule_enabled === true && row\.paused !== true : null;/.test(swCode)
    && /catch \(_e\) \{ scheduleOn = null; \}/.test(swCode)
    && swCode.slice(iFenceRefusal, iFenceRefusal + 400).includes('"RETURNS_SCHEDULE_ON"') && swCode.slice(iFenceRefusal, iFenceRefusal + 400).includes('"RETURNS_CONTROLS_UNREADABLE"'));
}

/* ============================== C. registries ============================== */
{
  const FAM = await import("../lib/server/sync/scheduled-family-registry.js");
  const f = FAM.SCHEDULED_FAMILY_REGISTRY.returns;
  ok("C1 the scheduled family 'returns' is declared (own owner scheduler-v2:returns-source, capped per region, visibly partial, completion = RESULT + (returns, region) run status, no frozen plan, depends on order-line-items) and the guard passes",
    !!f && f.family === "returns" && f.schedulerOwner === "scheduler-v2:returns-source" && f.ceiling === "capped-per-region" && f.partialBehavior === "stay-visibly-partial"
    && f.completionOutput === "returns-result-and-run-status" && f.frozenPlanParticipation === "none" && f.watchdogIdempotency === "idempotent-replay"
    && J(f.dependencies) === J(["order-line-items"]) && J(FAM.validateScheduledFamilyRegistry()) === J({ ok: true, problems: [] })
    && FAM.SCHEDULER_OWNERS.includes("scheduler-v2:returns-source") && FAM.COMPLETION_OUTPUTS.includes("returns-result-and-run-status") && isAscii(JSON.stringify(f)));
  ok("C2 the declared owner is a real scheduler-v2 job (scheduler-v2:returns-source <-> job returns_source)", jobNames.includes(f.schedulerOwner.split(":")[1].replace(/-/g, "_")));
  const SSO = await import("../lib/server/sync/source-scheduled-oli.js");
  const sweep = readApp("scripts/release/scheduled-source-controls.mjs");
  ok("C3 OPERATOR_SWITCHED_SOURCE_KEYS is EXACTLY [ads-asin-date, returns]: the config sweep never writes the 'returns' row (it is the switch the job reads) and never flags it as unexpectedly enabled; it is not an unconditionally scheduled key",
    J([...SSO.OPERATOR_SWITCHED_SOURCE_KEYS]) === J(["ads-asin-date", "returns"]) && !SSO.SCHEDULED_ENABLED_SOURCE_KEYS.includes("returns")
    && !SSO.scheduledSourceControlPlan(["returns", "settlements", "order-line-items"]).some((x) => x.sourceKey === "returns")
    && SSO.scheduledSourceControlPlan(["returns", "settlements"]).some((x) => x.sourceKey === "settlements" && x.scheduleEnabled === false)
    && /!OPERATOR_SWITCHED_SOURCE_KEYS\.includes\(k\)/.test(sweep));
  const ST = await import("../lib/server/sync/source-status.js");
  const { sourceRegistryEntry } = await import("../lib/server/sync/source-registry.js");
  const rows = [
    { source_key: "returns", bucket: "india", last_status: "succeeded", last_attempt_at: "2026-10-04T03:40:00Z", last_success_at: "2026-10-04T03:40:00Z", covered_from: "2026-09-21", covered_to: "2026-10-03", accounts_completed: 8, accounts_total: 8, creates_spent: 2, tokens_spent: 4, creates_ceiling: 4, tokens_ceiling: 8 },
    { source_key: "returns", bucket: "europe-au", last_status: "partial", last_attempt_at: "2026-10-04T09:30:00Z", accounts_completed: 30, accounts_failed: 2, accounts_total: 32, creates_spent: 7, tokens_spent: 14, creates_ceiling: 11, tokens_ceiling: 22, safe_error_code: "RETURNS_IDENTITY_AMBIGUOUS" },
    { source_key: "returns", bucket: "us-ca", last_status: "succeeded", last_attempt_at: "2026-10-04T17:00:00Z", last_success_at: "2026-10-04T17:00:00Z", covered_from: "2026-09-21", covered_to: "2026-10-03", accounts_completed: 11, accounts_total: 11, creates_spent: 3, tokens_spent: 6, creates_ceiling: 6, tokens_ceiling: 12 },
  ];
  const nonUs = ST.shapeSourceCards({ bucket: "non-us", controls: [{ source_key: "returns", paused: false, schedule_enabled: true }], runStatuses: rows }).find((c) => c.sourceKey === "returns");
  const us = ST.shapeSourceCards({ bucket: "us", controls: [], runStatuses: rows }).find((c) => c.sourceKey === "returns");
  const own = ST.shapeSourceCards({ bucket: "us", controls: [], runStatuses: [...rows, { source_key: "returns", bucket: "us", last_status: "failed" }] }).find((c) => c.sourceKey === "returns");
  ok("C4 the Data Sync Center 'returns' card FOLDS its (returns, region) rows like ASIN: non-us = india + europe-au (worst status, summed spend + ceilings, no coverage claim while a region is partial), us = us-ca; a bucket row of its own still wins",
    !!sourceRegistryEntry("returns") && J(ST.REGIONAL_STATUS_SOURCES.returns) === J({ us: ["us-ca"], "non-us": ["india", "europe-au"] })
    && J(ST.REGIONAL_STATUS_SOURCES["ads-asin-date"]) === J({ us: ["us-ca"], "non-us": ["india", "europe-au"] })
    && nonUs && nonUs.status.lastStatus === "partial" && nonUs.status.tokensSpent === 18 && nonUs.status.tokensCeiling === 30 && nonUs.status.coveredTo === null
    && nonUs.status.safeErrorCode === "RETURNS_IDENTITY_AMBIGUOUS" && nonUs.scheduleEnabled === true
    && us && us.status.lastStatus === "succeeded" && us.status.coveredTo === "2026-10-03" && us.status.createsCeiling === 6 && own && own.status.lastStatus === "failed");
  // Cross-part contract names (CONTRACT.md A). UNCONDITIONAL: the core module is part of this tree (a missing one throws).
  const CORE = await import("../lib/server/sync/returns-event-source.js");
  ok("C6 the core module's RETURNS_EVENT_SOURCE_KEY / RETURNS_REGIONS equal the switch's control key / regions and the workflow's CAP arms",
    CORE.RETURNS_EVENT_SOURCE_KEY === api.RETURNS_CONTROL_KEY && J([...CORE.RETURNS_REGIONS]) === J([...api.RETURNS_REGIONS])
    && J([...CORE.RETURNS_REGIONS]) === J([...stepsOf(rs)[3].matchAll(/^ {12}([a-z-]+)\) CAP=/gm)].map((m) => m[1])));
}

ok("Z the whole suite made ZERO network calls", fetchCalls === 0);
writeSync(1, `\nreturns-source-workflow: ${passed} passed, ${failed} failed\n`);
if (failed) process.exitCode = 1;
