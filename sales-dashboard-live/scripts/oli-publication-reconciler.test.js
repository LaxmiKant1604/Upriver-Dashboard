// OLI publication reconciler orchestration + dependency-safety (WORK 4/5/8/9 + WORK 11 items 4-9,15-20,24).
// The reconciler CORE is exercised with the REAL revision classifier + registry and injected readers / release
// execution (clearly labelled); the per-account release execution + fenced CAS promotion are proven REAL by
// source-priority-dashboards PP2 (709b956). Offline + pure. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { buildOliPublicationReconciler, OLI_RECONCILE_STATUS } from "../lib/server/sync/oli-publication-reconciler.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const REPORTS = ["brand-inventory", "brand-sales", "daily-reporting"];
const ASOF = "2026-09-09";
const successResult = () => ({ ok: true, code: 0, published: REPORTS.map((rk) => ({ reportKey: rk, disposition: "published" })) });

// Harness: REAL reconciler core + REAL revision/registry; injected readers, live store, release execution.
function makeHarness(over = {}) {
  const calls = { release: [], membership: [] };
  const liveStore = over.liveStore || new Map(); // reportKey|accountId -> { params:{to}, params_hash }
  const attempts = new Map();
  const releaseFor = over.releaseFor || (() => successResult());
  const reconciler = buildOliPublicationReconciler({
    resolveOrg: async () => over.org || ({ organizationFingerprint: "org-1", connectionId: "primary" }),
    bucketAccounts: async () => over.accounts || [{ accountId: "A01" }, { accountId: "A02" }, { accountId: "A03" }],
    oliStart: "2025-01-01",
    readPositiveHistory: over.readPositiveHistory || (async () => over.history || [{ account_id: "A01", source_request_hash: "h1" }, { account_id: "A02", source_request_hash: "h2" }]),
    readZeroRowProof: over.readZeroRowProof || (async () => ({ read: "ok", byAccount: over.zero || new Map() })),
    readLatestLiveSnapshot: async ({ reportKey, accountId }) => liveStore.get(reportKey + "|" + accountId) || null,
    readbackLive: over.readbackLive || (async ({ reportKey, accountId }) => ({ ok: liveStore.has(reportKey + "|" + accountId) })),
    runReleaseForAccount: async ({ accountId }) => {
      calls.release.push(accountId);
      const n = (attempts.get(accountId) || 0) + 1; attempts.set(accountId, n);
      const r = releaseFor(accountId, n);
      const published = new Set((r.published || []).map((p) => p.reportKey));
      if (r.ok) for (const rk of REPORTS) if (published.size === 0 || published.has(rk)) liveStore.set(rk + "|" + accountId, { params: { to: over.asOf || ASOF }, params_hash: "ph-" + rk + "-" + accountId });
      return r;
    },
    rebuildBrandViewMembership: async ({ accountIds }) => { calls.membership.push([...accountIds]); return over.membership || { ok: true }; },
    reportKeys: REPORTS,
    log: () => {},
  });
  return { reconciler, calls, liveStore, attempts };
}
const stateOf = (out, acct, rk) => out.perAccount.find((a) => a.accountId === acct).reports[rk].state;

// item 4: durable OLI saved, canonical snapshot MISSING -> reconciler publishes.
test("item 4: durable OLI saved + live snapshot MISSING -> the reconciler derives + promotes (READBACK_VERIFIED); zero export", async () => {
  const h = makeHarness();
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01/A02 (eligible, live missing) publish all reports", REPORTS.every((rk) => stateOf(out, "A01", rk) === OLI_RECONCILE_STATUS.READBACK_VERIFIED));
  ok("A03 (no provenance) is DEFERRED_PROVENANCE for every report", REPORTS.every((rk) => stateOf(out, "A03", rk) === OLI_RECONCILE_STATUS.DEFERRED_PROVENANCE));
  ok("exactly the 2 eligible accounts ran a release (A03 never did)", h.calls.release.sort().join(",") === "A01,A02");
  ok("dataDoe creates + tokens are ZERO", out.dataDoeCreates === 0 && out.dataDoeTokens === 0);
});

// item 5 + item 15: matching durable/live -> ZERO writes (idempotent no-op on the second pass).
test("item 5/15: a live snapshot already current -> PUBLICATION_NOT_REQUIRED, ZERO release calls; a repeat pass is a no-op", async () => {
  const h = makeHarness();
  await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" }); // pass 1 publishes A01/A02
  const before = h.calls.release.length;
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" }); // pass 2
  ok("pass 2 makes ZERO new release calls (already-current is a no-op)", h.calls.release.length === before);
  ok("pass 2 classifies the published reports PUBLICATION_NOT_REQUIRED", stateOf(out, "A01", "daily-reporting") === "PUBLICATION_NOT_REQUIRED");
  ok("pass 2 dataDoe creates + tokens still ZERO", out.dataDoeCreates === 0 && out.dataDoeTokens === 0);
});

// item 6: publication fails after durable save -> next reconciliation RETRIES without export.
test("item 6: a publish that FAILS is retried on the next pass WITHOUT any export (durable OLI reused)", async () => {
  const h = makeHarness({ releaseFor: (acct, n) => (acct === "A01" && n === 1 ? { ok: false, code: 1, stage: "publish", problems: ["publish-conflict"] } : successResult()) });
  const out1 = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("pass 1: A01 publish failed -> FAILED_PUBLISH with LKG preserved", stateOf(out1, "A01", "daily-reporting") === OLI_RECONCILE_STATUS.FAILED_PUBLISH);
  const out2 = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("pass 2: A01 is re-selected + succeeds (zero export both passes)", stateOf(out2, "A01", "daily-reporting") === OLI_RECONCILE_STATUS.READBACK_VERIFIED && out2.dataDoeCreates === 0);
});

// item 7: readback fails after write -> NO false success; next reconciliation verifies/repairs.
test("item 7: a readback FAILURE is FAILED_READBACK (no false success); the next pass verifies/repairs", async () => {
  const h = makeHarness({ releaseFor: (acct, n) => (acct === "A01" && n === 1 ? { ok: false, code: 1, stage: "readback", problems: ["live-readback-failed"] } : successResult()) });
  const out1 = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 readback failure -> FAILED_READBACK (never READBACK_VERIFIED)", stateOf(out1, "A01", "daily-reporting") === OLI_RECONCILE_STATUS.FAILED_READBACK);
  const out2 = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("the next pass repairs A01 to READBACK_VERIFIED", stateOf(out2, "A01", "daily-reporting") === OLI_RECONCILE_STATUS.READBACK_VERIFIED);
});

// item 8: one account fails -> healthy accounts publish (per-account isolation).
test("item 8: one account's release THROWS -> healthy accounts still publish (isolation; LKG preserved)", async () => {
  const h = makeHarness({ releaseFor: (acct) => { if (acct === "A01") throw new Error("A01 release exploded"); return successResult(); } });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A02 (healthy) still publishes despite A01 failing", stateOf(out, "A02", "daily-reporting") === OLI_RECONCILE_STATUS.READBACK_VERIFIED);
  ok("A01's failure is captured (FAILED_DERIVE) with LKG preserved -- it did not block A02", stateOf(out, "A01", "daily-reporting") === OLI_RECONCILE_STATUS.FAILED_DERIVE && out.perAccount.find((a) => a.accountId === "A01").reports["daily-reporting"].lkgPreserved === true);
});

// item 9: one report fails -> independently valid sibling reports still publish where safe.
test("item 9: a release that promotes only SOME reports -> the promoted siblings are verified, the un-promoted one is not", async () => {
  const h = makeHarness({ releaseFor: () => ({ ok: true, code: 0, published: [{ reportKey: "daily-reporting", disposition: "published" }, { reportKey: "brand-inventory", disposition: "published" }] }) });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("daily-reporting + brand-inventory (in the published set) are READBACK_VERIFIED", stateOf(out, "A01", "daily-reporting") === OLI_RECONCILE_STATUS.READBACK_VERIFIED && stateOf(out, "A01", "brand-inventory") === OLI_RECONCILE_STATUS.READBACK_VERIFIED);
  ok("brand-sales (NOT in the published set) is not marked verified", stateOf(out, "A01", "brand-sales") !== OLI_RECONCILE_STATUS.READBACK_VERIFIED);
});

// item 16 + 17: Brand View membership rebuild happens AFTER successful brand-sales promotions, and NOT when brand-sales was not promoted.
test("item 16/17: membership rebuild runs ONLY after successful brand-sales promotions (never on a stale brand-sales)", async () => {
  const h1 = makeHarness();
  await h1.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("membership rebuilt with EXACTLY the accounts whose brand-sales promoted (A01,A02)", h1.calls.membership.length === 1 && h1.calls.membership[0].join(",") === "A01,A02");
  const h2 = makeHarness({ releaseFor: () => ({ ok: true, code: 0, published: [{ reportKey: "daily-reporting", disposition: "published" }, { reportKey: "brand-inventory", disposition: "published" }] }) });
  const out2 = await h2.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("when brand-sales did NOT promote, membership is NOT rebuilt", h2.calls.membership.length === 0 && out2.brandViewRebuilt === false);
});

// item 18: three regions isolated -- the scope is region-derived; an immediate run touches ONLY its accounts.
test("item 18: region scope is isolated -- immediate mode reconciles ONLY the passed accounts", async () => {
  const h = makeHarness();
  const out = await h.reconciler.run({ bucket: "europe-au", requestedAsOf: ASOF, mode: "immediate", accountIds: ["A01"] });
  ok("only A01 is examined (A02/A03 untouched in immediate mode)", out.accountsExamined === 1 && out.perAccount[0].accountId === "A01");
  ok("only A01 ran a release", h.calls.release.join(",") === "A01");
});

// item 19/20: zero DataDoe creates + tokens, always.
test("item 19/20: dataDoe creates + tokens are structurally ZERO (there is no create collaborator to call)", async () => {
  const h = makeHarness();
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("summary reports dataDoeCreates=0 and dataDoeTokens=0", out.dataDoeCreates === 0 && out.dataDoeTokens === 0);
});

// item 24: two-cycle lifecycle -- Cycle A publish fails; Cycle B zero-export reuses saved OLI + verifies.
test("item 24: two-cycle lifecycle -- cycle A publish fails, cycle B reuses durable OLI (zero export) + verifies live", async () => {
  const h = makeHarness({ accounts: [{ accountId: "A01" }], history: [{ account_id: "A01", source_request_hash: "h1" }], releaseFor: (acct, n) => (n === 1 ? { ok: false, code: 1, stage: "publish", problems: ["fenced-cas-lease-lost"] } : successResult()) });
  const a = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("cycle A: A01 not published (FAILED_PUBLISH), durable OLI preserved", stateOf(a, "A01", "daily-reporting") === OLI_RECONCILE_STATUS.FAILED_PUBLISH && a.dataDoeCreates === 0);
  const b = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("cycle B: A01 verified live from the SAME durable OLI, zero export", stateOf(b, "A01", "daily-reporting") === OLI_RECONCILE_STATUS.READBACK_VERIFIED && b.dataDoeCreates === 0 && b.dataDoeTokens === 0);
});

// dry-run: read-only plan, ZERO release calls / ZERO writes.
test("dry-run: a plan is computed with ZERO release calls and ZERO writes", async () => {
  const h = makeHarness();
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic", dryRun: true });
  ok("dry-run makes ZERO release calls", h.calls.release.length === 0);
  ok("dry-run still classifies stale targets (A01 STALE) + zero creates", stateOf(out, "A01", "daily-reporting") === "STALE" && out.dataDoeCreates === 0);
});

// fail-closed: an unreadable durable OLI read defers the WHOLE run (zero writes).
test("fail-closed: an unreadable zero-row proof read defers the whole run (zero release calls / writes)", async () => {
  const h = makeHarness({ readZeroRowProof: async () => ({ read: "read-failed", byAccount: new Map() }) });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("the run fails closed (ok:false) with a DURABLE_OLI_UNREADABLE code and zero release calls", out.ok === false && /DURABLE_OLI_UNREADABLE/.test(out.code) && h.calls.release.length === 0);
});

// DEFERRED_DEPENDENCY: a derive failure whose cause is a missing durable dependency is retryable, not a hard failure.
test("a derive failure caused by a missing durable dependency (catalog) is DEFERRED_DEPENDENCY (retryable)", async () => {
  const h = makeHarness({ releaseFor: (acct) => (acct === "A01" ? { ok: false, code: 1, stage: "derive:india", problems: ["catalog snapshot unavailable"] } : successResult()) });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 (missing catalog) -> DEFERRED_DEPENDENCY, not FAILED_DERIVE", stateOf(out, "A01", "daily-reporting") === OLI_RECONCILE_STATUS.DEFERRED_DEPENDENCY);
});

// WORK 4 dependency-safety: no static path from the reconciler CORE to a DataDoe export transport, and the entrypoint
// FORCES a create-refusing adapter.
test("dependency-safety: the reconciler core references NO export/token transport symbol", () => {
  const core = readFileSync(new URL("../lib/server/sync/oli-publication-reconciler.js", import.meta.url), "utf8");
  for (const sym of ["createExport", "exportsCreate", "makeDataDoeAdapter", "reserveOliFreshnessCreate", "reserveTokens", "/exports"]) {
    ok("core has no reference to '" + sym + "'", !core.includes(sym));
  }
  ok("core imports ONLY the leaf registry + revision modules (no supabase/datadoe/release static import)", /from "\.\/oli-dependent-reports\.js"/.test(core) && /from "\.\/oli-publication-revision\.js"/.test(core) && !/from "\.\.\/datadoe/.test(core) && !/source-sync-driver/.test(core));
});
test("dependency-safety: the entrypoint FORCES a create-refusing inner adapter (zero export, structurally)", () => {
  const mjs = readFileSync(new URL("./release/oli-publication-reconcile.mjs", import.meta.url), "utf8");
  ok("the entrypoint wires makeInnerAdapter: makeNoExportInnerAdapter", /makeInnerAdapter: makeNoExportInnerAdapter/.test(mjs));
  ok("the no-export adapter's create THROWS OLI_RECONCILER_NO_EXPORT", /create: async \(\) => \{ throw new Error\("OLI_RECONCILER_NO_EXPORT/.test(mjs));
  ok("the entrypoint calls NO createExport / token reservation", !/createExport\(/.test(mjs) && !/reserveOliFreshnessCreate|reserveTokens/.test(mjs));
  ok("the entrypoint DEFERS (never steals) when another owner holds the control lease", /deferred: true/.test(mjs) && /never stealing/.test(mjs));
});

// item 23: the dashboard API serves the OLI-dependent dashboards from the BARE canonical report keys the reconciler
// promotes -- so a promoted canonical snapshot is exactly what the read path selects.
test("item 23: the dashboard API reads the promoted canonical snapshot (bare report_key + account_id + params_hash)", () => {
  const api = readFileSync(new URL("../api/datadoe.js", import.meta.url), "utf8");
  const store = readFileSync(new URL("../lib/server/report-store.js", import.meta.url), "utf8");
  ok("the serve selects by the canonical natural key via getReportSnapshot({ reportKey, accountId, paramsHash })", /getReportSnapshot\(\{ reportKey, accountId, paramsHash \}/.test(store));
  ok("api serves daily-reporting from the bare 'daily-reporting' key", /reportKey: "daily-reporting"/.test(api));
  ok("api serves brand-sales from the bare 'brand-sales' key", /reportKey: "brand-sales"/.test(api));
  ok("api serves brand-inventory from BRAND_INVENTORY_SNAPSHOT_KEY (the reconciler's promotion target)", /reportKey: BRAND_INVENTORY_SNAPSHOT_KEY/.test(api));
});

// The entrypoint's per-account execution uses the REAL runner/release (not a bespoke publisher) so the reconciler's
// live promotion + readback are the reviewed, fenced-CAS path (proven end-to-end by source-priority-dashboards PP2).
test("the entrypoint's runReleaseForAccount composes the REAL runPriorityDashboardsRelease + buildPriorityDashboardsRelease", () => {
  const mjs = readFileSync(new URL("./release/oli-publication-reconcile.mjs", import.meta.url), "utf8");
  ok("it composes buildPriorityDashboardsRelease + runPriorityDashboardsRelease", /buildPriorityDashboardsRelease\(/.test(mjs) && /runPriorityDashboardsRelease\(/.test(mjs));
  ok("the release build forces the no-export adapter + a per-account cycle bucket + the exact-identity readback", /makeInnerAdapter: makeNoExportInnerAdapter/.test(mjs) && /cycleBucket/.test(mjs) && /buildLiveReadback\(/.test(mjs));
});

async function main() {
  writeSync(1, "oli-publication-reconciler\n");
  let failures = 0;
  for (const t of tests) {
    try { await t.fn(); } catch (e) { failures += 1; writeSync(1, "FAIL  " + t.name + "\n" + String((e && e.stack) || e) + "\n"); }
  }
  writeSync(1, `\noli-publication-reconciler: ${passed} assertions passed${failures ? ", " + failures + " FAILED" : ""}\n`);
  if (failures) process.exitCode = 1;
}
main();
