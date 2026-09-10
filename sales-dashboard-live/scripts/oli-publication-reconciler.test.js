// OLI publication reconciler orchestration: exact publication binding, typed classification, authoritative control
// outcomes, cooperative deadline, honest outcome + dependency-safety. The reconciler CORE is exercised with the REAL
// revision/binding + registry and injected readers / control hooks / release execution (clearly labelled); the real
// end-to-end composition is proven by oli-reconcile-prodshape. Offline. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { buildOliPublicationReconciler, OLI_RECONCILE_STATUS } from "../lib/server/sync/oli-publication-reconciler.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const REPORTS = ["brand-inventory", "brand-sales", "daily-reporting"];
const ASOF = "2026-09-09";
const CONTRACTS = Object.fromEntries(REPORTS.map((rk) => [rk, { liveReportKey: rk, liveReportVersion: rk + "-live", liveParams: (p) => ({ to: p.to }) }]));
const HASH = (v, params) => v + "|" + JSON.stringify(params);

// Harness: REAL reconciler core + REAL revision/binding/registry; injected readers/control hooks/release. Per-account
// publication state is modelled by shadowRefresh (advances when OLI advances) + liveRefresh (set on a successful
// promote) + payload equality. A first pass has no live (unpromoted). Set liveRefresh<shadowRefresh to model an
// UNPROMOTED newer job (blocker 1). jobDependsOn defaults to the current durable hashes (covered).
function makeHarness(over = {}) {
  const calls = { release: [], openControls: [], closeControls: [], membership: [], releaseRevisions: [], outOfTime: 0 };
  const hashByAccount = over.hashByAccount || new Map([["A01", ["h1"]], ["A02", ["h2"]]]); // A03: none -> DEFERRED_PROVENANCE
  const jobDependsOn = over.jobDependsOn || null; // null -> derive from hashByAccount (covered)
  const shadowRefresh = over.shadowRefresh || new Map(); // account -> ISO (job shadow freshness); default below
  const liveRefresh = over.liveRefresh || new Map();     // account -> ISO promoted freshness; absent = not promoted
  const jobPromotable = over.jobPromotable || new Map(); // account -> bool (default true)
  const shadowPayload = over.shadowPayload || { rows: [] };
  const livePayload = over.livePayload || shadowPayload; // mismatch to model content drift
  const attempts = new Map();
  const releaseFor = over.releaseFor || (() => ({ ok: true, code: 0 }));
  const shRef = (a) => shadowRefresh.get(a) || "2026-09-09T05:00:00Z";
  const reconciler = buildOliPublicationReconciler({
    resolveOrg: async () => over.org || ({ organizationFingerprint: "org-1", connectionId: "primary" }),
    bucketAccounts: async () => over.accounts || [{ accountId: "A01" }, { accountId: "A02" }, { accountId: "A03" }],
    oliStart: "2025-01-01",
    readPositiveHistory: over.readPositiveHistory || (async () => { const rows = []; for (const [a, hs] of hashByAccount) for (const h of hs) rows.push({ account_id: a, source_request_hash: h }); return rows; }),
    readZeroRowProof: over.readZeroRowProof || (async () => ({ read: "ok", byAccount: over.zero || new Map() })),
    readLatestReportJob: async ({ reportKey, accountId }) => {
      if (!hashByAccount.has(accountId)) return null;
      const promo = jobPromotable.has(accountId) ? jobPromotable.get(accountId) : true;
      if (!promo) return { deriveStatus: "failed", saveStatus: "succeeded", validated: false, cycleStatus: "running", snapshotParamsHash: "", dependsOn: [] };
      return { deriveStatus: "succeeded", saveStatus: "succeeded", validated: true, cycleStatus: "succeeded", snapshotParamsHash: "sh|" + reportKey + "|" + accountId, dependsOn: [...(jobDependsOn ? (jobDependsOn.get(accountId) || []) : (hashByAccount.get(accountId) || [])), "catalog"] };
    },
    readShadowSnapshot: async ({ reportKey, accountId, paramsHash }) => { const rk = reportKey.replace("scheduler-v2/", ""); if (!hashByAccount.has(accountId)) return null; return { params_hash: paramsHash, params: { reportVersion: rk + "/shadow", accountId, to: ASOF }, payload: shadowPayload, payload_storage_path: null, source_refreshed_at: shRef(accountId) }; },
    readLiveSnapshot: async ({ reportKey, accountId, paramsHash }) => { if (!liveRefresh.has(accountId)) return null; return { report_key: reportKey, account_id: accountId, params_hash: paramsHash, params: { reportVersion: CONTRACTS[reportKey].liveReportVersion, to: ASOF }, payload: livePayload, payload_storage_path: null, source_refreshed_at: liveRefresh.get(accountId) }; },
    loadStoragePayload: async () => null,
    liveContracts: CONTRACTS,
    computeHash: HASH,
    runReleaseForAccount: async ({ accountId, revisionId }) => { calls.release.push(accountId); calls.releaseRevisions.push({ accountId, revisionId }); const n = (attempts.get(accountId) || 0) + 1; attempts.set(accountId, n); const r = releaseFor(accountId, n, revisionId); if (r.ok) liveRefresh.set(accountId, shRef(accountId)); return r; },
    rebuildBrandViewMembership: async ({ accountIds }) => { calls.membership.push([...accountIds]); return over.membership || { ok: true, rebuilt: false, readbackVerified: false, mode: "self_heal_pending" }; },
    openControls: over.openControls || (async (ids) => { calls.openControls.push([...ids]); return { ok: true }; }),
    closeControls: over.closeControls || (async () => { calls.closeControls.push(1); return { ok: true }; }),
    outOfTime: over.outOfTime || (() => { calls.outOfTime += 1; return false; }),
    reportKeys: REPORTS,
    log: () => {},
  });
  return { reconciler, calls, shadowRefresh, liveRefresh };
}
const rep = (out, acct) => out.perAccount.find((a) => a.accountId === acct).reports;
const stateOf = (out, acct, rk) => rep(out, acct)[rk].state;

test("item 4: durable OLI saved + live UNPROMOTED (missing) -> derive + promote (READBACK_VERIFIED); controls opened; zero export", async () => {
  const h = makeHarness();
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01/A02 (eligible, live missing) publish all reports", REPORTS.every((rk) => stateOf(out, "A01", rk) === OLI_RECONCILE_STATUS.READBACK_VERIFIED));
  ok("A03 (no provenance) is DEFERRED_PROVENANCE", REPORTS.every((rk) => stateOf(out, "A03", rk) === OLI_RECONCILE_STATUS.DEFERRED_PROVENANCE));
  ok("only the 2 eligible accounts ran a release", h.calls.release.sort().join(",") === "A01,A02");
  ok("controls opened + safe-closed; revisionId threaded", h.calls.openControls.length === 1 && h.calls.closeControls.length === 1 && h.calls.releaseRevisions.every((r) => typeof r.revisionId === "string" && r.revisionId.length > 0));
  ok("outcome partial (A03 deferred), ok:true, zero creates/tokens", out.outcome === "partial" && out.ok === true && out.dataDoeCreates === 0 && out.dataDoeTokens === 0);
});

// blocker 1: valid live at the same as-of + a NEWER validated job whose shadow was NOT promoted -> STALE -> publish.
test("blocker 1: unbound job/live -- a valid live but the newer validated job's shadow was NOT promoted -> STALE -> reconciled", async () => {
  const shadowRefresh = new Map([["A01", "2026-09-09T09:00:00Z"]]); // newer job shadow
  const liveRefresh = new Map([["A01", "2026-09-08T00:00:00Z"]]);   // live is an OLDER promotion (unpromoted newer job)
  const h = makeHarness({ accounts: [{ accountId: "A01" }], hashByAccount: new Map([["A01", ["h1"]]]), shadowRefresh, liveRefresh });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 is re-published (the exact job candidate was never promoted; the live is a different derivation)", stateOf(out, "A01", "daily-reporting") === OLI_RECONCILE_STATUS.READBACK_VERIFIED && h.calls.release.join(",") === "A01");
});

test("item 5/15: after promotion, a repeat pass is a zero-write no-op (live proven equal to the job's shadow candidate)", async () => {
  const h = makeHarness();
  await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" }); // promotes A01/A02 (liveRefresh set)
  const beforeRel = h.calls.release.length, beforeOpen = h.calls.openControls.length;
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("pass 2 makes ZERO new release calls + does NOT open controls (nothing stale)", h.calls.release.length === beforeRel && h.calls.openControls.length === beforeOpen);
  ok("pass 2 classifies the promoted reports PUBLICATION_NOT_REQUIRED", stateOf(out, "A01", "daily-reporting") === "PUBLICATION_NOT_REQUIRED");
});

test("blocker 3: oli-revision-changed -- durable OLI advanced past the latest job's depends_on -> STALE -> re-derive", async () => {
  const liveRefresh = new Map([["A01", "2026-09-09T05:00:00Z"]]); // a live exists
  const jobDependsOn = new Map([["A01", ["oldhash"]]]);            // job bound to the OLD OLI hash
  const h = makeHarness({ accounts: [{ accountId: "A01" }], hashByAccount: new Map([["A01", ["newhash"]]]), jobDependsOn, liveRefresh });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 is re-derived (the current durable OLI hash is not in the job's depends_on)", stateOf(out, "A01", "daily-reporting") === OLI_RECONCILE_STATUS.READBACK_VERIFIED);
});

test("item 6: a publish that FAILS is retried next pass without export; ok:false on the failing pass", async () => {
  const h = makeHarness({ releaseFor: (a, n) => (a === "A01" && n === 1 ? { ok: false, code: 1, stage: "publish", reason: "publish-conflict" } : { ok: true, code: 0 }) });
  const out1 = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("pass 1: A01 FAILED_PUBLISH; outcome failed; ok:false", stateOf(out1, "A01", "daily-reporting") === OLI_RECONCILE_STATUS.FAILED_PUBLISH && out1.outcome === "failed" && out1.ok === false);
  const out2 = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("pass 2: A01 verified, zero export", stateOf(out2, "A01", "daily-reporting") === OLI_RECONCILE_STATUS.READBACK_VERIFIED && out2.dataDoeCreates === 0);
});

test("item 7: a readback failure is FAILED_READBACK (no false success)", async () => {
  const h = makeHarness({ releaseFor: (a, n) => (a === "A01" && n === 1 ? { ok: false, code: 1, stage: "readback", reason: "live-readback-failed" } : { ok: true, code: 0 }) });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 -> FAILED_READBACK, ok:false", stateOf(out, "A01", "daily-reporting") === OLI_RECONCILE_STATUS.FAILED_READBACK && out.ok === false);
});

test("item 8 + blocker 4: account isolation + ACCOUNT-ATOMIC (a failure marks all 3 reports failed; a success all 3 verified)", async () => {
  const h = makeHarness({ releaseFor: (a) => (a === "A01" ? { ok: false, code: 1, stage: "publish", reason: "fenced-cas-lease-lost" } : { ok: true, code: 0 }) });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A02 (healthy) publishes despite A01 failing", REPORTS.every((rk) => stateOf(out, "A02", rk) === OLI_RECONCILE_STATUS.READBACK_VERIFIED));
  ok("A01 (failed): all three reports FAILED_PUBLISH (account-atomic; LKG preserved)", REPORTS.every((rk) => stateOf(out, "A01", rk) === OLI_RECONCILE_STATUS.FAILED_PUBLISH) && rep(out, "A01")["daily-reporting"].lkgPreserved === true);
});

// blocker 3: TYPED classification via the runner's typed { stage, status, leaseLost, reason } -- never text matching.
test("blocker 3: catalog snapshot genuinely unavailable (derive stop code SOURCE_UNAVAILABLE) -> DEFERRED_DEPENDENCY", async () => {
  const h = makeHarness({ releaseFor: () => ({ ok: false, code: 1, stage: "derive:india", reason: "SOURCE_UNAVAILABLE" }) });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 deferred (retryable), ok:true", stateOf(out, "A01", "daily-reporting") === OLI_RECONCILE_STATUS.DEFERRED_DEPENDENCY && out.ok === true);
});
for (const rr of ["catalog-not-org-scope", "catalog-job-count", "catalog-hash-blank"]) {
  test(`blocker 3: finalize integrity '${rr}' -> hard FAILED (exit nonzero), NOT deferred by the word 'catalog'`, async () => {
    const h = makeHarness({ releaseFor: () => ({ ok: false, code: 1, stage: "finalize:india", reason: rr }) });
    const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
    ok(rr + " -> FAILED_PUBLISH, outcome failed, ok:false", stateOf(out, "A01", "daily-reporting") === OLI_RECONCILE_STATUS.FAILED_PUBLISH && out.outcome === "failed" && out.ok === false);
  });
}
test("blocker 3: CONTROL_LEASE_LOST (leaseLost) -> typed contention DEFERRED_DEPENDENCY, without text parsing", async () => {
  const h = makeHarness({ releaseFor: () => ({ ok: false, code: 1, stage: "contention", status: "CONTROL_LEASE_LOST", leaseLost: true, reason: "renew-lost" }) });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 deferred (contention), ok:true, leaseLost flagged", stateOf(out, "A01", "daily-reporting") === OLI_RECONCILE_STATUS.DEFERRED_DEPENDENCY && rep(out, "A01")["daily-reporting"].leaseLost === true && out.ok === true);
});
test("blocker 3: a derive stop that is NOT a source/readiness code -> hard FAILED_DERIVE", async () => {
  const h = makeHarness({ releaseFor: () => ({ ok: false, code: 1, stage: "derive:india", reason: "DERIVE_INVALID" }) });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("DERIVE_INVALID -> FAILED_DERIVE, ok:false", stateOf(out, "A01", "daily-reporting") === OLI_RECONCILE_STATUS.FAILED_DERIVE && out.ok === false);
});

// blocker 4: control outcomes are authoritative.
test("blocker 4: controls not opened (lease held) -> DEFERRED_DEPENDENCY, ZERO release, still safe-close, ok:true", async () => {
  const h = makeHarness({ openControls: async () => ({ ok: false, reason: "CONTROL_LEASE_LOST" }) });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("no release ran; stale accounts DEFERRED_DEPENDENCY; outcome partial ok:true", h.calls.release.length === 0 && stateOf(out, "A01", "daily-reporting") === OLI_RECONCILE_STATUS.DEFERRED_DEPENDENCY && out.outcome === "partial" && out.ok === true);
});
test("blocker 4: control-apply COMMIT_UNKNOWN -> hard FAILED (never a zero-write deferral; NO rollback/retry); ok:false", async () => {
  const h = makeHarness({ openControls: async () => ({ ok: false, commitUnknown: true, reason: "apply-commit-unknown" }) });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("stale accounts FAILED_PUBLISH with reconcileRequired; outcome failed; controlCleanupUnresolved; ok:false", stateOf(out, "A01", "daily-reporting") === OLI_RECONCILE_STATUS.FAILED_PUBLISH && rep(out, "A01")["daily-reporting"].reconcileRequired === true && out.outcome === "failed" && out.controlCleanupUnresolved === true && out.ok === false);
  ok("no release ran (apply commit was unknown; NEVER retried)", h.calls.release.length === 0);
});
test("blocker 4: a successful publication + closeControls {ok:false} must NEVER return complete/ok:true", async () => {
  const h = makeHarness({ accounts: [{ accountId: "A01" }], hashByAccount: new Map([["A01", ["h1"]]]), closeControls: async () => ({ ok: false, reason: "safe-close-failed" }) });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("reports published but the safe-close failed -> outcome failed, controlCleanupUnresolved, ok:false", stateOf(out, "A01", "daily-reporting") === OLI_RECONCILE_STATUS.READBACK_VERIFIED && out.outcome === "failed" && out.controlCleanupUnresolved === true && out.ok === false && out.code === "CONTROL_CLEANUP_UNRESOLVED");
});
test("blocker 4: safe-close COMMIT_UNKNOWN -> control-cleanup-unresolved, ok:false", async () => {
  const h = makeHarness({ accounts: [{ accountId: "A01" }], hashByAccount: new Map([["A01", ["h1"]]]), closeControls: async () => ({ ok: false, commitUnknown: true, reason: "safe-close-commit-unknown" }) });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("outcome failed, controlCleanupUnresolved, ok:false", out.outcome === "failed" && out.controlCleanupUnresolved === true && out.ok === false);
});

// blocker 5: cooperative deadline -- once out of time, stop publishing new accounts (defer) BUT always safe-close.
test("blocker 5: a deadline hit after some accounts published -> remaining DEFERRED, safe-close STILL runs", async () => {
  let n = 0;
  const h = makeHarness({ accounts: [{ accountId: "A01" }, { accountId: "A02" }], hashByAccount: new Map([["A01", ["h1"]], ["A02", ["h2"]]]), outOfTime: () => (++n > 1) }); // false for A01, true from A02
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("A01 published, A02 deferred (deadline-cleanup-reserved)", stateOf(out, "A01", "daily-reporting") === OLI_RECONCILE_STATUS.READBACK_VERIFIED && stateOf(out, "A02", "daily-reporting") === OLI_RECONCILE_STATUS.DEFERRED_DEPENDENCY && rep(out, "A02")["daily-reporting"].reason === "deadline-cleanup-reserved");
  ok("safe-close STILL ran despite the deadline (never bypassed); ok:true (deferral, not a hard failure)", h.calls.closeControls.length === 1 && out.ok === true);
});

test("item 16/17 + blocker 5: brand-view status is self_heal_pending after brand-sales promotion; not-required otherwise", async () => {
  const h1 = makeHarness();
  const out1 = await h1.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("membership ran with the promoted accounts; status self_heal_pending (never rebuilt without readback)", h1.calls.membership.length === 1 && h1.calls.membership[0].join(",") === "A01,A02" && out1.brandView.status === "self_heal_pending");
  const h2 = makeHarness({ releaseFor: () => ({ ok: false, code: 1, stage: "publish", reason: "x" }) });
  const out2 = await h2.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("no brand-sales promoted -> membership not run", h2.calls.membership.length === 0 && out2.brandView.status === "not-required");
});

test("item 18: region scope isolated -- immediate mode reconciles ONLY the passed accounts", async () => {
  const h = makeHarness();
  const out = await h.reconciler.run({ bucket: "europe-au", requestedAsOf: ASOF, mode: "immediate", accountIds: ["A01"] });
  ok("only A01 examined + released", out.accountsExamined === 1 && h.calls.release.join(",") === "A01");
});

test("item 19/20: dataDoe creates + tokens are structurally ZERO", async () => {
  const h = makeHarness();
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("creates=0 tokens=0", out.dataDoeCreates === 0 && out.dataDoeTokens === 0);
});

test("item 24: two-cycle lifecycle -- cycle A publish fails, cycle B reuses durable OLI (zero export) + verifies", async () => {
  const h = makeHarness({ accounts: [{ accountId: "A01" }], hashByAccount: new Map([["A01", ["h1"]]]), releaseFor: (a, n) => (n === 1 ? { ok: false, code: 1, stage: "publish", reason: "lease-lost-cas" } : { ok: true, code: 0 }) });
  const a = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("cycle A: FAILED_PUBLISH, ok:false, zero export", stateOf(a, "A01", "daily-reporting") === OLI_RECONCILE_STATUS.FAILED_PUBLISH && a.ok === false && a.dataDoeCreates === 0);
  const b = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("cycle B: verified from the SAME durable OLI, zero export, ok:true", stateOf(b, "A01", "daily-reporting") === OLI_RECONCILE_STATUS.READBACK_VERIFIED && b.ok === true && b.dataDoeCreates === 0);
});

test("dry-run: ZERO release calls, ZERO control opens, ZERO writes; still classifies stale targets", async () => {
  const h = makeHarness();
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic", dryRun: true });
  ok("dry-run: no release, no control open; A01 STALE; creates=0", h.calls.release.length === 0 && h.calls.openControls.length === 0 && stateOf(out, "A01", "daily-reporting") === "STALE" && out.dataDoeCreates === 0);
});

test("fail-closed: an unreadable zero-row proof read defers the whole run (zero release/control calls); ok:false", async () => {
  const h = makeHarness({ readZeroRowProof: async () => ({ read: "read-failed", byAccount: new Map() }) });
  const out = await h.reconciler.run({ bucket: "india", requestedAsOf: ASOF, mode: "periodic" });
  ok("fail closed (ok:false), DURABLE_OLI_UNREADABLE, zero release/control", out.ok === false && /DURABLE_OLI_UNREADABLE/.test(out.code) && h.calls.release.length === 0 && h.calls.openControls.length === 0);
});

test("item 23: the dashboard API reads the promoted canonical snapshot (bare report_key + account_id + params_hash)", () => {
  const api = readFileSync(new URL("../api/datadoe.js", import.meta.url), "utf8");
  const store = readFileSync(new URL("../lib/server/report-store.js", import.meta.url), "utf8");
  ok("serve selects by the canonical natural key via getReportSnapshot({ reportKey, accountId, paramsHash })", /getReportSnapshot\(\{ reportKey, accountId, paramsHash \}/.test(store));
  ok("api serves the 3 OLI-dependent dashboards from their bare canonical keys", /reportKey: "daily-reporting"/.test(api) && /reportKey: "brand-sales"/.test(api) && /reportKey: BRAND_INVENTORY_SNAPSHOT_KEY/.test(api));
});

test("dependency-safety: the reconciler core references NO export/token transport symbol", () => {
  const core = readFileSync(new URL("../lib/server/sync/oli-publication-reconciler.js", import.meta.url), "utf8");
  for (const sym of ["createExport", "exportsCreate", "makeDataDoeAdapter", "reserveOliFreshnessCreate", "reserveTokens", "/exports"]) ok("core has no reference to '" + sym + "'", !core.includes(sym));
  ok("core imports ONLY the leaf registry + revision modules", /from "\.\/oli-dependent-reports\.js"/.test(core) && /from "\.\/oli-publication-revision\.js"/.test(core) && !/from "\.\.\/datadoe/.test(core) && !/source-sync-driver/.test(core));
});

// Entrypoint guards for the new wiring.
test("entrypoint: reviewed priority-partial namespace + capability preflight; typed threading; deadline + cleanup; no-export", () => {
  const mjs = readFileSync(new URL("./release/oli-publication-reconcile.mjs", import.meta.url), "utf8");
  ok("cycle bucket is priority-partial-<region>-<16hex> over {accountId, revisionId}; never oli-reconcile-<...>", /"priority-partial-" \+ b \+ "-" \+ sha256\(JSON\.stringify\(\[accountId, revisionId/.test(mjs) && !/"oli-reconcile-" \+ b \+ "-"/.test(mjs));
  ok("readPartialCycleCapability gates the namespace (blocker 1)", /readPartialCycleCapability\(/.test(mjs) && /PRIORITY_PARTIAL_MIGRATION_PENDING/.test(mjs));
  ok("IMMEDIATE renews the scheduler fence; PERIODIC uses control-package apply + always safe-close (blocker 2)", /renewControlPlaneLease\(\{ ownerToken: runToken, generation: ownerGeneration/.test(mjs) && /runControlPackageCli\(\{[\s\S]{0,120}mode: "apply"/.test(mjs) && /runControlPackageCli\(\{ mode: "rollback"/.test(mjs) && !/acquireControlLease\(/.test(mjs));
  ok("apply + safe-close detect COMMIT_UNKNOWN (code 3) (blocker 4)", (mjs.match(/COMMIT_UNKNOWN \(code 3\)/g) || []).length >= 2 && /commitUnknown: true/.test(mjs));
  ok("runReleaseForAccount threads typed status/leaseLost/reason (blocker 3)", /status: result\.status/.test(mjs) && /leaseLost: result\.leaseLost === true/.test(mjs) && /reason: result\.reason/.test(mjs));
  ok("cooperative deadline (--deadline-seconds -> outOfTime) + --cleanup reclaim path (blocker 5)", /deadline-seconds/.test(mjs) && /const outOfTime = \(\)/.test(mjs) && /--cleanup/.test(mjs) && /mode: "reclaim"/.test(mjs));
  ok("the no-export adapter makes create/poll/download throw", /makeInnerAdapter: makeNoExportInnerAdapter/.test(mjs) && (mjs.match(/OLI_RECONCILER_NO_EXPORT/g) || []).length >= 3 && !/createExport\(/.test(mjs));
});

async function main() {
  writeSync(1, "oli-publication-reconciler\n");
  let failures = 0;
  for (const t of tests) { try { await t.fn(); } catch (e) { failures += 1; writeSync(1, "FAIL  " + t.name + "\n" + String((e && e.stack) || e) + "\n"); } }
  writeSync(1, `\noli-publication-reconciler: ${passed} assertions passed${failures ? ", " + failures + " FAILED" : ""}\n`);
  if (failures) process.exitCode = 1;
}
main();
