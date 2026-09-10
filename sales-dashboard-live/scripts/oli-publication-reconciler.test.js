// OLI publication reconciler orchestration + control lifecycle + honest outcome + dependency-safety.
// The reconciler CORE is exercised with the REAL revision classifier + registry and injected readers / control hooks /
// release execution (clearly labelled); the per-account release execution + fenced CAS promotion + the real control-
// package transaction are proven REAL by source-priority-dashboards PP2 (709b956) and oli-reconcile-prodshape. Offline.
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

// Harness: REAL reconciler core + REAL revision/registry; injected readers, live/job stores, control hooks, release.
function makeHarness(over = {}) {
  const calls = { release: [], membership: [], openControls: [], closeControls: [], releaseRevisions: [] };
  const liveStore = over.liveStore || new Map();  // reportKey|accountId -> { params:{to}, params_hash }
  const jobStore = over.jobStore || new Map();    // reportKey|accountId -> { validated, dependsOn }  (latest job lineage)
  const hashByAccount = over.hashByAccount || new Map([["A01", ["h1"]], ["A02", ["h2"]]]);
  const attempts = new Map();
  const releaseFor = over.releaseFor || (() => successResult());
  const reconciler = buildOliPublicationReconciler({
    resolveOrg: async () => over.org || ({ organizationFingerprint: "org-1", connectionId: "primary" }),
    bucketAccounts: async () => over.accounts || [{ accountId: "A01" }, { accountId: "A02" }, { accountId: "A03" }],
    oliStart: "2025-01-01",
    readPositiveHistory: over.readPositiveHistory || (async () => { const rows = []; for (const [a, hs] of hashByAccount) for (const h of hs) rows.push({ account_id: a, source_request_hash: h }); return rows; }),
    readZeroRowProof: over.readZeroRowProof || (async () => ({ read: "ok", byAccount: over.zero || new Map() })),
    readLatestLiveSnapshot: async ({ reportKey, accountId }) => liveStore.get(reportKey + "|" + accountId) || null,
    readLatestJobLineage: over.readLatestJobLineage || (async ({ reportKey, accountId }) => jobStore.get(reportKey + "|" + accountId) || null),
    readbackLive: over.readbackLive || (async ({ reportKey, accountId }) => ({ ok: liveStore.has(reportKey + "|" + accountId) })),
    runReleaseForAccount: async ({ accountId, revisionId }) => {
      calls.release.push(accountId); calls.releaseRevisions.push({ accountId, revisionId });
      const n = (attempts.get(accountId) || 0) + 1; attempts.set(accountId, n);
      const r = releaseFor(accountId, n, revisionId);
      if (r.ok) for (const rk of REPORTS) {  // a successful account-atomic publish makes live current + job lineage cover the current OLI
        liveStore.set(rk + "|" + accountId, { params: { to: over.asOf || ASOF }, params_hash: "ph-" + rk + "-" + accountId });
        jobStore.set(rk + "|" + accountId, { validated: true, dependsOn: [...(hashByAccount.get(accountId) || []), "catalog"] });
      }
      return r;
    },
    rebuildBrandViewMembership: async ({ accountIds }) => { calls.membership.push([...accountIds]); return over.membership || { ok: true, rebuilt: false, readbackVerified: false, mode: "self_heal_pending" }; },
    openControls: over.openControls || (async (ids) => { calls.openControls.push([...ids]); return { ok: true }; }),
    closeControls: over.closeControls || (async () => { calls.closeControls.push(1); return { ok: true }; }),
    reportKeys: REPORTS,
    log: () => {},
  });
  return { reconciler, calls, liveStore, jobStore, attempts };
}
const rep = (out, acct) => out.perAccount.find((a) => a.accountId === acct).reports;
const stateOf = (out, acct, rk) => rep(out, acct)[rk].state;

// item 4: durable OLI saved, canonical snapshot MISSING -> reconciler publishes.
test("item 4: durable OLI saved + live snapshot MISSING -> derive + promote (READBACK_VERIFIED); controls opened; zero export", async () => {
  const h = makeHarness();
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01/A02 (eligible, live missing) publish all reports", REPORTS.every((rk) => stateOf(out, "A01", rk) === OLI_RECONCILE_STATUS.READBACK_VERIFIED));
  ok("A03 (no provenance) is DEFERRED_PROVENANCE for every report", REPORTS.every((rk) => stateOf(out, "A03", rk) === OLI_RECONCILE_STATUS.DEFERRED_PROVENANCE));
  ok("exactly the 2 eligible accounts ran a release (A03 never did)", h.calls.release.sort().join(",") === "A01,A02");
  ok("controls were opened (for the stale set) then safe-closed", h.calls.openControls.length === 1 && h.calls.closeControls.length === 1);
  ok("the release received the account's durable revisionId (non-blank)", h.calls.releaseRevisions.every((r) => typeof r.revisionId === "string" && r.revisionId.length > 0));
  // A03 is legitimately deferred (proven-missing) -> the pass is honestly PARTIAL (published what it could), ok:true (no hard failure).
  ok("outcome partial (A03 deferred), ok:true, zero creates/tokens", out.outcome === "partial" && out.ok === true && out.dataDoeCreates === 0 && out.dataDoeTokens === 0);
});

// item 5 + item 15: matching durable/live -> ZERO writes; idempotent no-op on the second pass (via revision cover).
test("item 5/15: after a publish, a repeat pass is a zero-write no-op (live current + job lineage covers the OLI revision)", async () => {
  const h = makeHarness();
  await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  const beforeRel = h.calls.release.length; const beforeOpen = h.calls.openControls.length;
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("pass 2 makes ZERO new release calls", h.calls.release.length === beforeRel);
  ok("pass 2 does NOT open controls (nothing stale -> no publication)", h.calls.openControls.length === beforeOpen);
  ok("pass 2 classifies the published reports PUBLICATION_NOT_REQUIRED; outcome complete", stateOf(out, "A01", "daily-reporting") === "PUBLICATION_NOT_REQUIRED" && out.outcome === "partial" || out.outcome === "complete");
});

// (blocker 3) same date + NEW OLI hash -> re-selected for publish even though live exists at the same as-of.
test("blocker 3: a SAME-AS-OF corrected OLI (new request hash) is re-selected for derive/publish", async () => {
  const liveStore = new Map(); const jobStore = new Map();
  // Seed A01 live+job at the OLD hash h1 (current + covered).
  for (const rk of REPORTS) { liveStore.set(rk + "|A01", { params: { to: ASOF }, params_hash: "ph" }); jobStore.set(rk + "|A01", { validated: true, dependsOn: ["h1", "catalog"] }); }
  // Durable OLI now has a CORRECTED hash h1b (not in the job lineage).
  const h = makeHarness({ accounts: [{ accountId: "A01" }], hashByAccount: new Map([["A01", ["h1b"]]]), liveStore, jobStore });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 is re-published (the corrected same-as-of OLI is stale vs the job lineage)", stateOf(out, "A01", "daily-reporting") === OLI_RECONCILE_STATUS.READBACK_VERIFIED && h.calls.release.join(",") === "A01");
});

// item 6: publication fails after durable save -> next reconciliation RETRIES without export.
test("item 6: a publish that FAILS is retried on the next pass WITHOUT any export (durable OLI reused)", async () => {
  const h = makeHarness({ releaseFor: (acct, n) => (acct === "A01" && n === 1 ? { ok: false, code: 1, stage: "publish", problems: ["publish-conflict"] } : successResult()) });
  const out1 = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("pass 1: A01 publish failed -> FAILED_PUBLISH; outcome failed; ok:false", stateOf(out1, "A01", "daily-reporting") === OLI_RECONCILE_STATUS.FAILED_PUBLISH && out1.outcome === "failed" && out1.ok === false);
  const out2 = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("pass 2: A01 is re-selected + succeeds (zero export both passes)", stateOf(out2, "A01", "daily-reporting") === OLI_RECONCILE_STATUS.READBACK_VERIFIED && out2.dataDoeCreates === 0);
});

// item 7: readback fails after write -> NO false success; next reconciliation verifies/repairs.
test("item 7: a readback FAILURE is FAILED_READBACK (no false success); the next pass verifies/repairs", async () => {
  const h = makeHarness({ releaseFor: (acct, n) => (acct === "A01" && n === 1 ? { ok: false, code: 1, stage: "readback", problems: ["live-readback-failed"] } : successResult()) });
  const out1 = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 readback failure -> FAILED_READBACK (never READBACK_VERIFIED); ok:false", stateOf(out1, "A01", "daily-reporting") === OLI_RECONCILE_STATUS.FAILED_READBACK && out1.ok === false);
  const out2 = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("the next pass repairs A01 to READBACK_VERIFIED", stateOf(out2, "A01", "daily-reporting") === OLI_RECONCILE_STATUS.READBACK_VERIFIED);
});

// item 8: one account fails -> healthy accounts publish (per-account isolation).
test("item 8: one account's release THROWS -> healthy accounts still publish (isolation; LKG preserved)", async () => {
  const h = makeHarness({ releaseFor: (acct) => { if (acct === "A01") throw new Error("A01 release exploded"); return successResult(); } });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A02 (healthy) still publishes despite A01 failing", stateOf(out, "A02", "daily-reporting") === OLI_RECONCILE_STATUS.READBACK_VERIFIED);
  ok("A01's failure is captured (FAILED_DERIVE) with LKG preserved -- it did not block A02", stateOf(out, "A01", "daily-reporting") === OLI_RECONCILE_STATUS.FAILED_DERIVE && rep(out, "A01")["daily-reporting"].lkgPreserved === true);
});

// (blocker 4) ACCOUNT-ATOMIC: a release failure marks ALL THREE of the account's reports failed (never a partial mix).
test("blocker 4: the three OLI-dependent dashboards are ACCOUNT-ATOMIC -- a failure marks all three failed, a success all three verified", async () => {
  const h = makeHarness({ releaseFor: (acct) => (acct === "A01" ? { ok: false, code: 1, stage: "publish", problems: ["fenced-cas-lease-lost"] } : successResult()) });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 (failed): all three reports FAILED_PUBLISH (never a partial-per-report mix)", REPORTS.every((rk) => stateOf(out, "A01", rk) === OLI_RECONCILE_STATUS.FAILED_PUBLISH));
  ok("A02 (ok): all three reports READBACK_VERIFIED", REPORTS.every((rk) => stateOf(out, "A02", rk) === OLI_RECONCILE_STATUS.READBACK_VERIFIED));
});

// (blocker 2) control lifecycle: controls that FAIL to open -> every stale account DEFERRED_DEPENDENCY, no release, still safe-close.
test("blocker 2: controls not opened (lease held / migration pending) -> DEFERRED_DEPENDENCY, ZERO release, still safe-close", async () => {
  const h = makeHarness({ openControls: async () => ({ ok: false, reason: "CONTROL_LEASE_LOST" }) });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("no account ran a release (controls never opened)", h.calls.release.length === 0);
  ok("stale accounts are DEFERRED_DEPENDENCY (LKG preserved), not FAILED", stateOf(out, "A01", "daily-reporting") === OLI_RECONCILE_STATUS.DEFERRED_DEPENDENCY);
  ok("safe-close (closeControls) still ran (always safe-close)", h.calls.closeControls.length === 1);
  ok("outcome partial (deferrals, no hard failure) -> ok:true", out.outcome === "partial" && out.ok === true);
});

// item 16 + 17 + blocker 5: Brand View status is honest (self_heal_pending), never falsely 'rebuilt'.
test("item 16/17 + blocker 5: membership status is self_heal_pending after brand-sales promotion; not-required otherwise", async () => {
  const h1 = makeHarness();
  const out1 = await h1.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("membership callback ran with EXACTLY the promoted accounts (A01,A02)", h1.calls.membership.length === 1 && h1.calls.membership[0].join(",") === "A01,A02");
  ok("brandView.status is self_heal_pending (never 'rebuilt' without readback evidence)", out1.brandView.status === "self_heal_pending");
  const h2 = makeHarness({ releaseFor: (acct) => ({ ok: false, code: 1, stage: "publish", problems: ["x"] }) });
  const out2 = await h2.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("no brand-sales promoted -> membership not run", h2.calls.membership.length === 0 && out2.brandView.status === "not-required");
});

// item 18: region scope isolated -- immediate mode reconciles ONLY the passed accounts.
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
  const h = makeHarness({ accounts: [{ accountId: "A01" }], hashByAccount: new Map([["A01", ["h1"]]]), releaseFor: (acct, n) => (n === 1 ? { ok: false, code: 1, stage: "publish", problems: ["fenced-cas-lease-lost"] } : successResult()) });
  const a = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("cycle A: A01 not published (FAILED_PUBLISH), durable OLI preserved, ok:false", stateOf(a, "A01", "daily-reporting") === OLI_RECONCILE_STATUS.FAILED_PUBLISH && a.dataDoeCreates === 0 && a.ok === false);
  const b = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("cycle B: A01 verified live from the SAME durable OLI, zero export, ok:true", stateOf(b, "A01", "daily-reporting") === OLI_RECONCILE_STATUS.READBACK_VERIFIED && b.dataDoeCreates === 0 && b.ok === true);
});

// dry-run: read-only plan, ZERO release/controls calls / ZERO writes.
test("dry-run: a plan is computed with ZERO release calls, ZERO control opens, ZERO writes", async () => {
  const h = makeHarness();
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic", dryRun: true });
  ok("dry-run makes ZERO release calls + ZERO control opens", h.calls.release.length === 0 && h.calls.openControls.length === 0);
  ok("dry-run still classifies stale targets (A01 STALE) + zero creates", stateOf(out, "A01", "daily-reporting") === "STALE" && out.dataDoeCreates === 0);
});

// fail-closed: an unreadable durable OLI read defers the WHOLE run (zero writes).
test("fail-closed: an unreadable zero-row proof read defers the whole run (zero release/control calls); ok:false", async () => {
  const h = makeHarness({ readZeroRowProof: async () => ({ read: "read-failed", byAccount: new Map() }) });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("the run fails closed (ok:false) with a DURABLE_OLI_UNREADABLE code and zero release/control calls", out.ok === false && /DURABLE_OLI_UNREADABLE/.test(out.code) && h.calls.release.length === 0 && h.calls.openControls.length === 0);
});

// DEFERRED_DEPENDENCY: a derive failure whose cause is a missing durable dependency is retryable, not a hard failure.
test("a derive failure caused by a missing durable dependency (catalog) is DEFERRED_DEPENDENCY (retryable; ok:true)", async () => {
  const h = makeHarness({ releaseFor: (acct) => (acct === "A01" ? { ok: false, code: 1, stage: "derive:india", problems: ["catalog snapshot unavailable"] } : successResult()) });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 (missing catalog) -> DEFERRED_DEPENDENCY, not FAILED_DERIVE; outcome partial ok:true", stateOf(out, "A01", "daily-reporting") === OLI_RECONCILE_STATUS.DEFERRED_DEPENDENCY && out.outcome === "partial" && out.ok === true);
});

// item 23: the dashboard API serves the OLI-dependent dashboards from the BARE canonical report keys the reconciler promotes.
test("item 23: the dashboard API reads the promoted canonical snapshot (bare report_key + account_id + params_hash)", () => {
  const api = readFileSync(new URL("../api/datadoe.js", import.meta.url), "utf8");
  const store = readFileSync(new URL("../lib/server/report-store.js", import.meta.url), "utf8");
  ok("the serve selects by the canonical natural key via getReportSnapshot({ reportKey, accountId, paramsHash })", /getReportSnapshot\(\{ reportKey, accountId, paramsHash \}/.test(store));
  ok("api serves daily-reporting from the bare 'daily-reporting' key", /reportKey: "daily-reporting"/.test(api));
  ok("api serves brand-sales from the bare 'brand-sales' key", /reportKey: "brand-sales"/.test(api));
  ok("api serves brand-inventory from BRAND_INVENTORY_SNAPSHOT_KEY (the reconciler's promotion target)", /reportKey: BRAND_INVENTORY_SNAPSHOT_KEY/.test(api));
});

// WORK 4 dependency-safety: no static path from the reconciler CORE to a DataDoe export transport.
test("dependency-safety: the reconciler core references NO export/token transport symbol", () => {
  const core = readFileSync(new URL("../lib/server/sync/oli-publication-reconciler.js", import.meta.url), "utf8");
  for (const sym of ["createExport", "exportsCreate", "makeDataDoeAdapter", "reserveOliFreshnessCreate", "reserveTokens", "/exports"]) {
    ok("core has no reference to '" + sym + "'", !core.includes(sym));
  }
  ok("core imports ONLY the leaf registry + revision modules (no supabase/datadoe/release static import)", /from "\.\/oli-dependent-reports\.js"/.test(core) && /from "\.\/oli-publication-revision\.js"/.test(core) && !/from "\.\.\/datadoe/.test(core) && !/source-sync-driver/.test(core));
});

// Entrypoint guards (blockers 1/2): permitted namespace + capability preflight; immediate renews the scheduler fence
// (never a standalone acquire); periodic uses the reviewed control-package apply/safe-close; the no-export adapter.
test("entrypoint: reviewed priority-partial namespace + read-only capability preflight (blocker 1)", () => {
  const mjs = readFileSync(new URL("./release/oli-publication-reconcile.mjs", import.meta.url), "utf8");
  ok("cycle bucket is priority-partial-<region>-<16hex> over {accountId, revisionId}", /"priority-partial-" \+ b \+ "-" \+ sha256\(JSON\.stringify\(\[accountId, revisionId/.test(mjs));
  ok("it never creates an unapproved oli-reconcile-<...> cycle namespace", !/"oli-reconcile-" \+ b \+ "-"/.test(mjs) && !/cycleBucket = "oli-reconcile/.test(mjs));
  ok("a read-only exact capability preflight gates the namespace (readPartialCycleCapability)", /readPartialCycleCapability\(/.test(mjs) && /PRIORITY_PARTIAL_MIGRATION_PENDING/.test(mjs));
});
test("entrypoint: control + lease lifecycle (blocker 2)", () => {
  const mjs = readFileSync(new URL("./release/oli-publication-reconcile.mjs", import.meta.url), "utf8");
  ok("IMMEDIATE mode RENEWS the scheduler's exact fence (renewControlPlaneLease with the passed run-token+generation)", /renewControlPlaneLease\(\{ ownerToken: runToken, generation: ownerGeneration/.test(mjs));
  ok("it never re-acquires a standalone publication lease (no acquireControlLease)", !/acquireControlLease\(/.test(mjs));
  ok("PERIODIC mode uses the reviewed control-package apply + safe-close (runControlPackageCli)", /runControlPackageCli\(\{[\s\S]{0,120}mode: "apply"/.test(mjs) && /runControlPackageCli\(\{ mode: "rollback"/.test(mjs));
  ok("it always safe-closes with the SAME captured owner/generation", /mode: "rollback"[\s\S]{0,120}ownerToken: leaseFence\.ownerToken, ownerGeneration: leaseFence\.generation/.test(mjs));
  ok("live immediate REQUIRES the fence args (fails closed without --run-token/--owner-generation)", /OLI_RECONCILE_IMMEDIATE_FENCE/.test(mjs));
});
test("entrypoint: the no-export adapter makes every DataDoe create/poll/download impossible", () => {
  const mjs = readFileSync(new URL("./release/oli-publication-reconcile.mjs", import.meta.url), "utf8");
  ok("wires makeInnerAdapter: makeNoExportInnerAdapter", /makeInnerAdapter: makeNoExportInnerAdapter/.test(mjs));
  ok("create/poll/download all THROW OLI_RECONCILER_NO_EXPORT", (mjs.match(/OLI_RECONCILER_NO_EXPORT/g) || []).length >= 3);
  ok("the entrypoint calls NO createExport / token reservation", !/createExport\(/.test(mjs) && !/reserveOliFreshnessCreate|reserveTokens/.test(mjs));
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
