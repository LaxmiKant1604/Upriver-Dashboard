// AUTHORITATIVE-SCOPE RECOVERY (reproduce-then-fix, run 34183173600): the india watchdog deferred
// "no-authoritative-scope: 51 account(s) discovered but NONE carry authoritative onboarding/established scope" although
// the durable account-directory snapshot proved 8 established india accounts. Root cause: the scheduled preflight
// scripts composed the export-eligibility gate WITHOUT the established-directory reader, so an EMPTY onboarding table
// (the */30 worker had crashed before populating it) collapsed into no-authoritative-scope.
//
// This suite drives the REAL composition: the real supabase.js readers (getAccountOnboardingRows +
// getAccountDirectorySnapshotAccounts) over a stubbed HTTP layer, through the real fetchExportEligibleAccounts +
// classifyDiscoveryOutcome. No network, no DataDoe, no tokens. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeSync } from "node:fs";
import path from "node:path";

process.env.SUPABASE_URL = "http://supabase.test";
const SECRET = ["SUPABASE", "SECRET", "KEY"].join("_");
process.env[SECRET] = process.env[SECRET] || "test-secret";

// ---- stubbed PostgREST (installed BEFORE supabase.js is imported so every reader goes through it) ----
const http = { onboarding: () => [], directory: () => [], calls: [] };
globalThis.fetch = async (url) => {
  const u = String(url);
  http.calls.push(u);
  const body = u.includes("/rest/v1/account_onboarding") ? http.onboarding()
    : u.includes("/rest/v1/report_snapshots") ? http.directory()
      : new Error("unexpected route " + u);
  if (body instanceof Error) return { ok: false, status: 500, json: async () => ({ message: body.message, code: "XX000" }) };
  return { ok: true, status: 200, json: async () => body };
};

const sb = await import("../lib/server/supabase.js");
const { fetchExportEligibleAccounts, classifyDiscoveryOutcome, EXCLUDE_NOT_ONBOARDED, EXCLUDE_DATADOE_NOT_READY } = await import("../lib/server/sync/account-onboarding.js");

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); };
writeSync(1, "discovery-scope-recovery\n");

const det = (id, { ready = true, country = "IN" } = {}) => ({ id, name: "acct " + id, country, readiness: { sellerCentralReady: ready } });
const dir = (id, extra = {}) => ({ id, name: "acct " + id, country: "IN", currency: "INR", ...extra });
const IN8 = ["IN1", "IN2", "IN3", "IN4", "IN5", "IN6", "IN7", "IN8"];

// The REAL production composition (what every scheduled caller must wire): real readers, real gate.
const realDiscover = (detailed, { withEstablished = true } = {}) => fetchExportEligibleAccounts("k", {
  fetchDetailed: async () => detailed,
  readOnboardingRows: sb.getAccountOnboardingRows,
  ...(withEstablished ? { readEstablishedAccountIds: sb.getAccountDirectorySnapshotAccounts } : {}),
});

/* ===== A. THE INDIA REPRODUCTION: empty onboarding table + valid established directory ===== */
{
  http.onboarding = () => [];                                        // table read OK, ZERO rows (worker never populated it)
  http.directory = () => [{ updated_at: "2026-09-08T00:00:00Z", payload: { accounts: [
    ...IN8.map((id) => dir(id)),
    dir("LOAD1"),                                                     // established but currently loading in DataDoe
    dir("SETUP1", { settingUp: true, onboardingStatus: "waiting_for_datadoe" }), // merged by the worker: NOT established
  ] } }];
  const detailed = [
    ...IN8.map((id) => det(id)),
    det("LOAD1", { ready: false }),
    det("SETUP1"),
    det("NEWREADY"),                                                  // brand-new: DataDoe-ready, no row, not in the directory
    det("US1", { country: "US" }), det("DE1", { country: "DE" }),     // other regions (directory-wide count, not india)
  ];
  http.directory = ((d) => () => [{ updated_at: "x", payload: { accounts: [...IN8.map((id) => dir(id)), dir("LOAD1"), dir("SETUP1", { settingUp: true }), dir("US1", { country: "US" }), dir("DE1", { country: "DE" })] } }])();
  const rows = await realDiscover(detailed);
  const ids = rows.map((r) => r.id).sort();
  ok("A1: with the established reader wired, the EMPTY onboarding table no longer hides the established accounts (india 8 + US1 + DE1 eligible)",
    rows.discoveryState === "eligible" && JSON.stringify(ids) === JSON.stringify([...IN8, "DE1", "US1"].sort()));
  ok("A2: readers are TYPED: onboarding read OK but EMPTY; established directory read OK with ids",
    rows.readers.onboarding === "empty" && rows.readers.onboardingRowCount === 0 && rows.readers.established === "ids" && rows.readers.establishedCount === 11);
  const ex = Object.fromEntries(rows.excluded.map((x) => [x.accountId, x.reason]));
  ok("A3: a BRAND-NEW DataDoe-ready account is NEVER classified established merely because DataDoe reports ready (NOT_ONBOARDED)", ex.NEWREADY === EXCLUDE_NOT_ONBOARDED);
  ok("A4: a directory 'Setting up' entry is NOT established evidence (the worker-merged entry stays NOT_ONBOARDED)", ex.SETUP1 === EXCLUDE_NOT_ONBOARDED);
  ok("A5: an established account that is still LOADING in DataDoe gets zero paid exports (DATADOE_NOT_READY)", ex.LOAD1 === EXCLUDE_DATADOE_NOT_READY);
  ok("A6: gateMode is 'reconcile' (durable ownership/serving evidence), never readiness-only on a paid path", rows.gateMode === "reconcile" && rows.hasAuthoritativeScope === true);
  ok("A7: the real supabase readers were driven (account_onboarding + report_snapshots/account-directory GETs)",
    http.calls.some((u) => u.includes("/rest/v1/account_onboarding")) && http.calls.some((u) => u.includes("report_key=eq.account-directory")));
}

/* ===== B. the OLD composition (reader NOT supplied) reproduces the production deferral, now labelled a composition defect ===== */
{
  http.onboarding = () => [];
  const rows = await realDiscover([...IN8.map((id) => det(id))], { withEstablished: false });
  const disp = classifyDiscoveryOutcome(rows);
  ok("B1: without the established reader the gate still fails CLOSED (zero eligible; no readiness-only exposure)", rows.length === 0 && rows.discoveryState === "no-authoritative-scope");
  ok("B2: ...but the deferral now NAMES the composition defect (reader not supplied) instead of implying onboarding has not run",
    rows.readers.established === "not-supplied" && /COMPOSITION DEFECT/.test(disp.message) && /NOT SUPPLIED/.test(disp.message) && disp.code === "no-authoritative-scope");
}

/* ===== C. both readers UNAVAILABLE (read failure) is DISTINGUISHABLE from a successful empty response ===== */
{
  http.onboarding = () => new Error("db down");
  http.directory = () => new Error("db down");
  const rows = await realDiscover([...IN8.map((id) => det(id))]);
  const disp = classifyDiscoveryOutcome(rows);
  ok("C1: a read FAILURE on both readers defers with the DISTINCT code 'scope-unreadable' (zero eligible, fail closed)",
    rows.length === 0 && rows.discoveryState === "scope-unreadable" && disp.deferred === true && disp.code === "scope-unreadable");
  ok("C2: the message says it is a READ FAILURE and NOT evidence that onboarding has not run",
    /READ FAILURE/.test(disp.message) && /NOT evidence that onboarding has not run/.test(disp.message) && /UNREADABLE/.test(disp.message));
  ok("C3: reader states are 'unavailable' for both (the supabase onboarding wrapper returns null on failure; the directory reader throws)",
    rows.readers.onboarding === "unavailable" && rows.readers.established === "unavailable" && /db down/.test(String(rows.readers.establishedError)));

  // one reader failing while the other is empty is STILL a read failure (never "onboarding has not run")
  http.onboarding = () => [];
  http.directory = () => new Error("snapshot read boom");
  const half = await realDiscover([...IN8.map((id) => det(id))]);
  ok("C4: onboarding empty + directory UNREADABLE => scope-unreadable (the empty table alone never proves anything while a reader failed)",
    half.discoveryState === "scope-unreadable" && half.readers.onboarding === "empty" && half.readers.established === "unavailable");

  // both readers SUCCEED and are empty => onboarding genuinely has not run yet (typed separately from a code defect)
  http.onboarding = () => [];
  http.directory = () => [];
  const empty = await realDiscover([...IN8.map((id) => det(id))]);
  const dispEmpty = classifyDiscoveryOutcome(empty);
  ok("C5: both readers succeed EMPTY => 'no-authoritative-scope' (onboarding has not run) -- a DIFFERENT code from scope-unreadable, gate NOT weakened (zero eligible)",
    empty.length === 0 && empty.discoveryState === "no-authoritative-scope" && dispEmpty.code === "no-authoritative-scope"
    && /read OK but EMPTY/.test(dispEmpty.message) && !/COMPOSITION DEFECT/.test(dispEmpty.message) && empty.readers.established === "empty");
}

/* ===== D. a READY NEW account, and MIXED ready/loading accounts, under a populated onboarding table ===== */
{
  http.onboarding = () => [
    { account_id: "IN1", status: "ready" },
    { account_id: "IN2", status: "ready" },            // ready in the table but LOADING in DataDoe right now
    { account_id: "NEWWAIT", status: "waiting_for_datadoe" },
  ];
  http.directory = () => [{ updated_at: "x", payload: { accounts: [dir("IN1"), dir("IN2"), dir("EST3")] } }];
  const rows = await realDiscover([det("IN1"), det("IN2", { ready: false }), det("EST3"), det("NEWWAIT"), det("NEWREADY")]);
  const ex = Object.fromEntries(rows.excluded.map((x) => [x.accountId, x.reason]));
  ok("D1: a READY NEW account with no row and no established evidence stays behind the onboarding gate (NOT_ONBOARDED, never eligible)",
    ex.NEWREADY === EXCLUDE_NOT_ONBOARDED && !rows.some((r) => r.id === "NEWREADY"));
  ok("D2: a new account still waiting on DataDoe readiness is excluded by its typed onboarding status", ex.NEWWAIT === "ONBOARDING_WAITING_FOR_DATADOE");
  ok("D3: MIXED ready/loading: the loading established account is excluded (DATADOE_NOT_READY) even though its row says ready",
    ex.IN2 === EXCLUDE_DATADOE_NOT_READY);
  ok("D4: ...while the ready accounts are eligible (IN1 via its row, EST3 reconciled from durable established evidence)",
    JSON.stringify(rows.map((r) => r.id).sort()) === JSON.stringify(["EST3", "IN1"]) && rows.discoveryState === "eligible");
}

/* ===== E. SOURCE GUARD: every scheduled/operator gate composition supplies the established-directory reader ===== */
{
  const root = path.resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..");
  const files = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); } else if (/\.(m?js)$/.test(e.name) && !/\.test\./.test(e.name)) files.push(p); } };
  walk(path.join(root, "lib", "server"));
  walk(path.join(root, "scripts", "release"));
  walk(path.join(root, "api"));
  const offenders = [];
  let callSites = 0;
  for (const f of files) {
    if (/account-onboarding\.js$/.test(f)) continue; // the definition site
    const t = readFileSync(f, "utf8");
    let idx = t.indexOf("fetchExportEligibleAccounts(");
    while (idx >= 0) {
      const window = t.slice(idx, idx + 600);
      const callEnd = window.indexOf("})");
      const callText = callEnd > 0 ? window.slice(0, callEnd) : window;
      callSites += 1;
      if (!/readEstablishedAccountIds/.test(callText)) offenders.push(path.relative(root, f) + "@" + idx);
      idx = t.indexOf("fetchExportEligibleAccounts(", idx + 1);
    }
  }
  ok(`E1: every production fetchExportEligibleAccounts call site (${callSites}) supplies readEstablishedAccountIds (offenders: ${offenders.join(", ") || "none"})`,
    callSites >= 8 && offenders.length === 0);
  const scheduled = ["verify-us-d1-published.mjs", "scheduled-cycle-preflight.mjs", "oli-refresh-d1.mjs", "verify-bucket-readiness.mjs", "regional-scheduler-dry-run.mjs"];
  const missing = scheduled.filter((n) => !/readEstablishedAccountIds:\s*[A-Za-z.]*getAccountDirectorySnapshotAccounts|getAccountDirectorySnapshotAccounts:\s*readEstablishedAccountIds/.test(readFileSync(path.join(root, "scripts", "release", n), "utf8")));
  ok("E2: the scheduler-v2 preflight/run scripts bind the reader to the DURABLE account-directory snapshot (getAccountDirectorySnapshotAccounts)", missing.length === 0);
}

writeSync(1, `\ndiscovery-scope-recovery: ${passed} checks passed\n`);
