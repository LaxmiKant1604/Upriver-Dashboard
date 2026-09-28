// Publication recovery D3 -- the FBA reconciler's FAIR EXECUTION ORDER + the fba job's reconcile deadline. The REAL
// shared reconciler core + REAL FBA wrapper/revision/binding with injected durable readers, control hooks, release
// execution and a capacity-bound deadline (clearly labelled fakes). Proves: the pure order (status, served date, per-day
// tie); the core hook is opt-in (absent -> the sorted order, no reorder, no extra read), a strict PERMUTATION (else the
// sorted order + a logged fallback), single-phase only, and runs BEFORE the controls open; the deadline still defers the
// TAIL of the (fair) order with LKG kept; the served-date reads are isolated (a throw / junk is 'most starved', never a
// blocked run); honest-empty accounts still publish (unavailable), after the stocked ones; and the multi-day starvation
// the sorted order produced for the 5 europe-au tail accounts is gone. Plus the CLI wiring and the workflow pins.
// Offline; zero network; zero DataDoe. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { buildFbaPublicationReconciler, fbaFairOrder, FBA_FAIR_STATUS_RANK, FBA_RECONCILE_STATUS } from "../lib/server/sync/fba-publication-reconciler.js";
import { buildSavedDataReconciler, RECONCILE_STATUS } from "../lib/server/sync/saved-data-reconciler.js";
import { FBA_REVISION_STATUS } from "../lib/server/sync/fba-inventory-revision.js";
import { selectAuthoritativeInventorySnapshot, BRAND_INVENTORY_REPORT_VERSION } from "../lib/server/reports/brand-view.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

// The 32 europe-au account ids of 2026-09-28 (8-hex prefixes stand in for the uuids; sorted like the directory).
const EU = ["06700b34", "128bf8ad", "1788ae27", "183e4070", "1881cd08", "2813ef66", "29cc64c3", "2d26092e", "2d81982d", "4bb5b7da",
  "54bb4dfa", "572a7b1b", "5d507e3b", "64f6593a", "68ee90b8", "70642927", "8aa74e96", "9675c625", "9aa10836", "9af2fe64", "9c9203af",
  "9eba36e9", "ab545c58", "b1a80d6c", "b60cf168", "b7b13aac", "bf623cf8", "c3092b8c", "d2769ce0", "f08cefca", "f0bd8ce3", "fbd72f10"];
// The 9 accounts whose durable FBA snapshot is a valid EMPTY (honest unavailable) every day.
const EMPTY = new Set(["572a7b1b", "5d507e3b", "68ee90b8", "9af2fe64", "9c9203af", "9eba36e9", "b60cf168", "c3092b8c", "d2769ce0"]);
const TAIL5 = ["b7b13aac", "bf623cf8", "f08cefca", "f0bd8ce3", "fbd72f10"];
const AVAILABLE = EU.filter((a) => !EMPTY.has(a));

const REPORTS = ["brand-inventory"];
const CONTRACTS = { "brand-inventory": { liveReportKey: "brand-inventory", liveReportVersion: "brand-inventory-live", liveParams: (p) => ({ to: p.to }) } };
const RD = { "brand-inventory": { snapshotVersion: "brand-inventory/shadow", validatePayload: (p) => !!(p && p.valid === true) } };
const HASH = (v, params) => v + "|" + JSON.stringify(params);

// Harness: REAL FBA reconciler. Every account's latest job is NOT promotable -> the exact binding says STALE (the
// production shape of the 24 europe-au targets: 'fba-revision-changed' / rebuild-written rows), so a run executes every
// stale account in the reconciler's order until the deadline. capacity = releases a run may START (outOfTime flips
// after that many, like the 180 s / 780 s start cutoff). servedAsOf is the dashboard-served date per account (mutated
// by a successful release of an account with stock, like the serve's selection would).
// Optional deadline collaborators (the CLI's per-account budget): deadlineRace / awaitSettled / outOfTime overrides and
// the served-date read budget seams (readCapMs / readBudgetMs).
function harness({ accounts = EU, day = "2026-09-28", capacity = Infinity, servedAsOf = new Map(), readServed = "default", seq = [], logs = [], releaseFor = null, releaseImpl = null, deadlineRace = null, awaitSettled = null, outOfTime = null, readCapMs, readBudgetMs } = {}) {
  const calls = { release: [], open: [], served: [], close: 0 };
  let started = 0;
  const extra = {};
  if (deadlineRace) extra.deadlineRace = deadlineRace;
  if (awaitSettled) extra.awaitSettled = awaitSettled;
  if (readCapMs != null) extra.readCapMs = readCapMs;
  if (readBudgetMs != null) extra.readBudgetMs = readBudgetMs;
  const reconciler = buildFbaPublicationReconciler({
    ...extra,
    resolveOrg: async () => ({ organizationFingerprint: "org-1", connectionId: "primary" }),
    bucketAccounts: async () => accounts.map((accountId) => ({ accountId })),
    readFbaSnapshot: async ({ accountId }) => ({ read: "ok", snapshot: { source_request_hash: "rh-" + accountId + "-" + day, payload_sha: "ps-" + accountId + "-" + day, row_count: EMPTY.has(accountId) ? 0 : 7 } }),
    resolveExpectedRequestHash: async ({ accountId }) => "rh-" + accountId + "-" + day,
    readServedInventoryDate: readServed === "default" ? (async ({ accountId }) => { seq.push("served:" + accountId); calls.served.push(accountId); return servedAsOf.get(accountId) ?? null; }) : readServed,
    readLatestReportJob: async () => ({ deriveStatus: "failed", saveStatus: "succeeded", validated: false, cycleStatus: "running", snapshotParamsHash: "", dependsOn: [], durableContentDeps: [] }),
    readShadowSnapshot: async () => null,
    readLiveSnapshot: async () => null,
    loadStoragePayload: async () => null,
    verifyLiveReadback: async () => ({ ok: true }),
    liveContracts: CONTRACTS, computeHash: HASH, reportDerivations: RD,
    runReleaseForAccount: (args) => {
      const { accountId } = args;
      started += 1; calls.release.push(accountId); seq.push("release:" + accountId);
      if (releaseImpl) return releaseImpl(args);
      const r = releaseFor ? releaseFor(accountId) : { ok: true, code: 0 };
      if (r.ok && !EMPTY.has(accountId)) servedAsOf.set(accountId, day);
      return Promise.resolve(r);
    },
    openControls: async (ids) => { seq.push("open"); calls.open.push([...ids]); return { ok: true }; },
    closeControls: async () => { seq.push("close"); calls.close += 1; return { ok: true }; },
    outOfTime: outOfTime || (() => started >= capacity),
    reportKeys: REPORTS,
    log: (m) => logs.push(String(m)),
  });
  return { reconciler, calls, servedAsOf };
}
const stateOf = (out, a) => out.perAccount.find((r) => r.accountId === a).reports["brand-inventory"];

// ---- 1. the PURE order ------------------------------------------------------------------------------------------------
test("F1 fbaFairOrder: status rank, then the OLDEST served date (none = most starved), then a per-day tie", () => {
  const statusOf = new Map([["A", FBA_REVISION_STATUS.PROVEN_EMPTY], ["B", FBA_REVISION_STATUS.AVAILABLE], ["C", FBA_REVISION_STATUS.AVAILABLE], ["D", "missing"], ["E", FBA_REVISION_STATUS.AVAILABLE]]);
  const servedAsOf = new Map([["B", "2026-09-27"], ["C", "2026-09-23"], ["E", null]]);
  const order = fbaFairOrder({ staleAccounts: ["A", "B", "C", "D", "E"], statusOf, servedAsOf, requestedAsOf: "2026-09-28" });
  ok("F1a available (E none served, C 09-23, B 09-27) before proven-empty (A) before anything else (D)", JSON.stringify(order) === JSON.stringify(["E", "C", "B", "A", "D"]));
  ok("F1b the rank table is exactly available=0 / proven-empty=1", FBA_FAIR_STATUS_RANK.available === 0 && FBA_FAIR_STATUS_RANK["proven-empty"] === 1 && Object.keys(FBA_FAIR_STATUS_RANK).length === 2);
  const junk = fbaFairOrder({ staleAccounts: ["X", "Y"], statusOf: new Map([["X", "available"], ["Y", "available"]]), servedAsOf: new Map([["X", "2026-09-27"], ["Y", "yesterday"]]), requestedAsOf: "2026-09-28" });
  ok("F1c a malformed served date counts as none (most starved first)", junk[0] === "Y");
  ok("F1d duplicates collapse; a non-array is an empty order (never a throw)", JSON.stringify(fbaFairOrder({ staleAccounts: ["Q", "Q"], statusOf: new Map([["Q", "available"]]) })) === '["Q"]' && fbaFairOrder({ staleAccounts: null }).length === 0);
  const eq = new Map(AVAILABLE.map((a) => [a, "available"]));
  const d1 = fbaFairOrder({ staleAccounts: AVAILABLE, statusOf: eq, requestedAsOf: "2026-09-28" });
  const d1b = fbaFairOrder({ staleAccounts: [...AVAILABLE].reverse(), statusOf: eq, requestedAsOf: "2026-09-28" });
  const days = ["2026-09-29", "2026-09-30", "2026-10-01"].map((d) => fbaFairOrder({ staleAccounts: AVAILABLE, statusOf: eq, requestedAsOf: d }));
  ok("F1e among equals the order is deterministic for a day (input order irrelevant)", JSON.stringify(d1) === JSON.stringify(d1b));
  ok("F1f and reshuffled across days (no fixed tail among equals)", days.every((o) => JSON.stringify(o) !== JSON.stringify(d1)) && new Set(days.map((o) => o[o.length - 1])).size > 1);
});

// ---- 2. the core hook: opt-in, before the controls, permutation-validated --------------------------------------------
test("F2 the fair order is applied BEFORE the controls open, the stale set is unchanged, and the deadline defers the TAIL of the fair order (LKG kept)", async () => {
  const seq = []; const logs = [];
  const servedAsOf = new Map(EU.map((a) => [a, "2026-09-27"]));
  for (const a of TAIL5) servedAsOf.set(a, "2026-09-23"); // the tail accounts' last fenced available row (production)
  const h = harness({ capacity: 8, servedAsOf, seq, logs });
  const out = await h.reconciler.run({ bucket: "europe-au", requestedAsOf: "2026-09-28", mode: "periodic" });
  const firstOpen = seq.indexOf("open");
  ok("F2a every served-date read happens before the controls open (no read holds the lease) and ONLY the 23 stocked accounts are read (a proven-empty account's served date is never used)",
    firstOpen > 0 && seq.slice(firstOpen).every((s) => !s.startsWith("served:")) && seq.slice(0, firstOpen).filter((s) => s.startsWith("served:")).length === 23 && !seq.some((s) => s.startsWith("served:") && EMPTY.has(s.slice(7))));
  ok("F2b the controls open for exactly the 32 stale accounts (the set is unchanged by the order)", h.calls.open.length === 1 && JSON.stringify([...h.calls.open[0]].sort()) === JSON.stringify(EU));
  ok("F2c capacity 8: the FIVE starved tail accounts run first (oldest served date), then 3 others", JSON.stringify(h.calls.release.slice(0, 5).sort()) === JSON.stringify(TAIL5) && h.calls.release.length === 8);
  const deferred = EU.filter((a) => !h.calls.release.includes(a));
  ok("F2d the 24 not started are deferred 'deadline-cleanup-reserved' with LKG preserved (the tail of the FAIR order)",
    deferred.length === 24 && deferred.every((a) => stateOf(out, a).state === RECONCILE_STATUS.DEFERRED_DEPENDENCY && stateOf(out, a).reason === "deadline-cleanup-reserved" && stateOf(out, a).lkgPreserved === true));
  ok("F2e the started ones are READBACK_VERIFIED; the run is 'partial' (honest), zero DataDoe", h.calls.release.every((a) => stateOf(out, a).state === FBA_RECONCILE_STATUS.READBACK_VERIFIED) && out.outcome === "partial" && out.dataDoeCreates === 0 && out.dataDoeTokens === 0);
  ok("F2f the stocked accounts all run before any honest-empty account", h.calls.release.every((a) => !EMPTY.has(a)));
  ok("F2g the order is logged (count only), never the fallback", logs.some((l) => /stale-order fair: 32 stale account/.test(l)) && !logs.some((l) => /stale-order-fallback/.test(l)));
  ok("F2h the perAccount record order (the RESULT) stays the sorted scope order", JSON.stringify(out.perAccount.map((r) => r.accountId)) === JSON.stringify(EU));
});

test("F3 unlimited capacity (the 900 s deadline) publishes all 32: stocked accounts AND the 9 honest-empty ones (unavailable, never zero)", async () => {
  const h = harness({});
  const out = await h.reconciler.run({ bucket: "europe-au", requestedAsOf: "2026-09-28", mode: "periodic" });
  ok("F3a 32 releases, each READBACK_VERIFIED; outcome complete", h.calls.release.length === 32 && EU.every((a) => stateOf(out, a).state === FBA_RECONCILE_STATUS.READBACK_VERIFIED) && out.outcome === "complete");
  ok("F3b the 23 stocked accounts run first, the 9 honest-empty after", h.calls.release.slice(0, 23).every((a) => !EMPTY.has(a)) && h.calls.release.slice(23).every((a) => EMPTY.has(a)));
});

test("F4 the served-date read is ISOLATED: a throw or junk is 'most starved' for that account only; the run is never blocked", async () => {
  const servedAsOf = new Map(EU.map((a) => [a, "2026-09-27"]));
  const readServed = async ({ accountId }) => { if (accountId === "06700b34") throw new Error("REST 503"); if (accountId === "128bf8ad") return { to: "2026-09-27" }; return servedAsOf.get(accountId); };
  const logs = [];
  const h = harness({ capacity: 2, servedAsOf, readServed, logs });
  const out = await h.reconciler.run({ bucket: "europe-au", requestedAsOf: "2026-09-28", mode: "periodic" });
  ok("F4a the two unreadable accounts are treated as most starved and run first", JSON.stringify([...h.calls.release].sort()) === JSON.stringify(["06700b34", "128bf8ad"]));
  ok("F4b the run still opened the controls and deferred the rest with LKG (no whole-run failure)", h.calls.open.length === 1 && out.outcome === "partial" && stateOf(out, "fbd72f10").reason === "deadline-cleanup-reserved");
  ok("F4c the log counts the unread accounts", logs.some((l) => /fair order: 32 stale account\(s\) -- 23 available first, 2 of them with no served available date/.test(l)));
});

test("F5 no served-date reader: status + per-day tie only (still fair, still a permutation)", async () => {
  const h = harness({ readServed: null, capacity: 32 });
  await h.reconciler.run({ bucket: "europe-au", requestedAsOf: "2026-09-28", mode: "periodic" });
  ok("F5 all 32 run, stocked first; no served read at all", h.calls.release.length === 32 && h.calls.served.length === 0 && h.calls.release.slice(0, 23).every((a) => !EMPTY.has(a)));
});

// A minimal core (no FBA wrapper) to prove the hook itself.
function core({ adapterExtra = {}, capacity = Infinity, twoPhase = false, logs = [], accounts = ["C", "A", "B", "D"] } = {}) {
  const calls = { release: [], open: 0 };
  let started = 0;
  const adapter = {
    readScopeEvidence: async ({ scope }) => ({ ok: true, perAccount: new Map(scope.map((a) => [a, {}])) }),
    computeAccountRevision: ({ accountId }) => ({ eligible: true, revisionId: "rev-" + accountId, deps: ["d"], status: "available", reason: null }),
    ...adapterExtra,
  };
  const base = {
    resolveOrg: async () => ({ organizationFingerprint: "org", connectionId: "primary" }),
    bucketAccounts: async () => accounts.map((accountId) => ({ accountId })), adapter,
    readLatestReportJob: async () => ({ deriveStatus: "failed", saveStatus: "succeeded", validated: false, cycleStatus: "running", snapshotParamsHash: "", dependsOn: [], durableContentDeps: [] }),
    readShadowSnapshot: async () => null, readLiveSnapshot: async () => null, loadStoragePayload: async () => null, verifyLiveReadback: async () => ({ ok: true }),
    liveContracts: CONTRACTS, computeHash: HASH, reportDerivations: RD, reportKeys: REPORTS,
    openControls: async () => { calls.open += 1; return { ok: true }; }, closeControls: async () => ({ ok: true }),
    outOfTime: () => started >= capacity, log: (m) => logs.push(String(m)),
  };
  if (twoPhase) Object.assign(base, { runPrepareForUnit: async () => ({ ok: true, prepared: true, code: 0 }), runPublishForUnit: async () => ({ ok: true, code: 0 }) });
  else base.runReleaseForAccount = ({ accountId }) => { started += 1; calls.release.push(accountId); return Promise.resolve({ ok: true, code: 0 }); };
  return { reconciler: buildSavedDataReconciler(base), calls };
}

test("F6 the core hook: absent -> the sorted order (byte-identical, no reorder log); present -> its order", async () => {
  const logs0 = [];
  const a = core({ logs: logs0 });
  await a.reconciler.run({ bucket: "india", requestedAsOf: "2026-09-28" });
  ok("F6a no orderStale -> releases in the SORTED scope order and no stale-order log line", JSON.stringify(a.calls.release) === '["A","B","C","D"]' && !logs0.some((l) => /stale-order/.test(l)));
  const b = core({ adapterExtra: { orderStale: async ({ staleAccounts }) => [...staleAccounts].reverse() } });
  await b.reconciler.run({ bucket: "india", requestedAsOf: "2026-09-28" });
  ok("F6b orderStale -> releases in the adapter's order", JSON.stringify(b.calls.release) === '["D","C","B","A"]');
  const one = core({ accounts: ["A"], adapterExtra: { orderStale: async () => { throw new Error("must not be called for one account"); } } });
  await one.reconciler.run({ bucket: "india", requestedAsOf: "2026-09-28" });
  ok("F6c a single stale account never calls the hook", JSON.stringify(one.calls.release) === '["A"]');
  const dry = core({ adapterExtra: { orderStale: async () => { throw new Error("must not be called in a dry run"); } } });
  const outDry = await dry.reconciler.run({ bucket: "india", requestedAsOf: "2026-09-28", dryRun: true });
  ok("F6d a dry run never calls the hook (zero reads beyond the classification) and releases nothing", dry.calls.release.length === 0 && outDry.dryRun === true);
});

test("F7 a NON-PERMUTATION or a throw keeps the sorted order and logs the fallback -- the stale set and the publication are unchanged", async () => {
  const bad = [
    ["missing id", ({ staleAccounts }) => staleAccounts.slice(1)],
    ["duplicate id", ({ staleAccounts }) => [staleAccounts[0], ...staleAccounts.slice(0, -1)]],
    ["foreign id", ({ staleAccounts }) => [...staleAccounts.slice(1), "ZZ"]],
    ["not an array", () => ({ order: ["A"] })],
    ["throws", () => { throw new Error("boom"); }],
  ];
  for (const [label, fn] of bad) {
    const logs = [];
    const c = core({ logs, adapterExtra: { orderStale: fn } });
    const out = await c.reconciler.run({ bucket: "india", requestedAsOf: "2026-09-28" });
    ok(`F7 ${label}: sorted order kept, every account still published, fallback logged`,
      JSON.stringify(c.calls.release) === '["A","B","C","D"]' && out.counts.targetsPublished === 4 && logs.some((l) => /stale-order-fallback/.test(l)));
  }
});

test("F8 the hook is fail-closed at build: non-function, or combined with the two-phase runner, THROWS", () => {
  let e1 = null; try { core({ adapterExtra: { orderStale: "yes" } }); } catch (e) { e1 = e; }
  let e2 = null; try { core({ twoPhase: true, adapterExtra: { orderStale: () => [] } }); } catch (e) { e2 = e; }
  ok("F8a a non-function orderStale throws", !!e1 && /orderStale must be a function/.test(e1.message));
  ok("F8b orderStale + two-phase throws (never silently ignored)", !!e2 && /single-phase only/.test(e2.message));
});

// ---- 3. the multi-day starvation the sorted order produced, and its absence under the fair order ---------------------
test("F9 multi-day: capacity 8 (the old 300 s deadline) -- the sorted order NEVER reaches the 5 tail accounts; the fair order reaches every stocked account within ceil(23/8)=3 days", async () => {
  const sortedFirst8 = [...EU].slice(0, 8);
  ok("F9a (the production defect) the sorted order's first 8 never include a tail account", TAIL5.every((a) => !sortedFirst8.includes(a)));
  const servedAsOf = new Map(EU.map((a) => [a, "2026-09-20"]));
  const lastPublished = new Map();
  let maxGap = 0;
  const days = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30"];
  for (let i = 0; i < days.length; i += 1) {
    const h = harness({ day: days[i], capacity: 8, servedAsOf });
    await h.reconciler.run({ bucket: "europe-au", requestedAsOf: days[i], mode: "periodic" });
    for (const a of h.calls.release) { const prev = lastPublished.has(a) ? lastPublished.get(a) : -1; maxGap = Math.max(maxGap, i - prev); lastPublished.set(a, i); }
  }
  for (const a of AVAILABLE) maxGap = Math.max(maxGap, days.length - (lastPublished.has(a) ? lastPublished.get(a) : -1));
  ok("F9b every stocked account (incl. the 5 tail) is published at least every 3 days under capacity 8", maxGap <= 3 && TAIL5.every((a) => lastPublished.has(a)));
});

test("F10 two runs a day (immediate 8 + backstop 17 = 25 >= 23 stocked): EVERY stocked account is served fresh EVERY day; the leftover honest-empty ones rotate", async () => {
  const servedAsOf = new Map(EU.map((a) => [a, "2026-09-20"]));
  // DISTINCT stale LKG dates on the honest-empty accounts (their publishes never advance them): the per-day tie alone must
  // order them, else the dated ones would never get a slot (tier-1 review P3-2).
  [...EMPTY].forEach((a, i) => servedAsOf.set(a, i < 5 ? null : "2026-08-0" + i));
  const emptyHits = new Map();
  let allFresh = true;
  for (const d of ["2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28"]) {
    const done = new Set();
    for (const cap of [8, 17]) {
      const h = harness({ accounts: EU.filter((a) => !done.has(a)), day: d, capacity: cap, servedAsOf });
      await h.reconciler.run({ bucket: "europe-au", requestedAsOf: d, mode: "periodic" });
      for (const a of h.calls.release) { done.add(a); if (EMPTY.has(a)) emptyHits.set(a, (emptyHits.get(a) || 0) + 1); }
    }
    if (!AVAILABLE.every((a) => servedAsOf.get(a) === d)) allFresh = false;
  }
  ok("F10a all 23 stocked accounts (incl. the 5 tail) served on the SAME day, 5 days running", allFresh);
  ok("F10b the 2 leftover slots per day rotate across different honest-empty accounts (per-day tie)", emptyHits.size >= 5);
});

// ---- 4. the wiring -----------------------------------------------------------------------------------------------------
test("F11 the CLI's served-date reader is the SERVE's own selection (read-only), and the entrypoint gains no writer", () => {
  const s = src("./release/fba-publication-reconcile.mjs");
  ok("F11a it passes readServedInventoryDate into the reconciler", /\n  readServedInventoryDate,\n/.test(s));
  ok("F11b the reader = sb.getInventorySnapshotCandidates(brand-inventory, BRAND_INVENTORY_REPORT_VERSION) + selectAuthoritativeInventorySnapshot, available only",
    /sb\.getInventorySnapshotCandidates\(\{ reportKey: "brand-inventory", accountId, reportVersion: BRAND_INVENTORY_REPORT_VERSION \}\)/.test(s)
    && /const served = selectAuthoritativeInventorySnapshot\(rows\);/.test(s) && /served\.payload\.inventoryAvailable !== true\) return null;/.test(s));
  ok("F11c no report_snapshots literal and no new write sink in the entrypoint", !/report_snapshots/.test(s.replace(/^\s*\/\/.*$/gm, "")) && (s.match(/sb\.(publish|save|upsert|delete|insert)/g) || []).length === (s.match(/sb\.(saveShadowSnapshotIfNewer|upsertSyncReportJob)/g) || []).length);
});

test("F12 serve-parity of the served date: a fresh PLACEHOLDER never hides an older AVAILABLE compact; none available = null", () => {
  const compact = (to, avail, upd) => ({ params: { reportVersion: BRAND_INVENTORY_REPORT_VERSION, to }, payload: { inventoryAvailable: avail, inventoryDate: to, inventoryByBrandCountry: [] }, updated_at: upd });
  const pick = (rows) => { const s = selectAuthoritativeInventorySnapshot(rows); return s && s.payload.inventoryAvailable === true ? s.payload.inventoryDate : null; };
  ok("F12a placeholder 09-28 (newer) + available 09-23 -> served 09-23 (the starved date the order sees)", pick([compact("2026-09-28", false, "2026-09-28T09:24:00Z"), compact("2026-09-23", true, "2026-09-23T12:44:00Z")]) === "2026-09-23");
  ok("F12b only a placeholder -> null (most starved)", pick([compact("2026-09-28", false, "2026-09-28T09:24:00Z")]) === null);
});

test("F13 workflow pins: the fba job's reconcile deadline is 900 s; the evening backstop stays 330/420 (the recovery worker's fba argv pins it)", () => {
  const sched = src("../../.github/workflows/scheduler-v2.yml");
  const back = src("../../.github/workflows/fba-publication-reconcile.yml");
  ok("F13a scheduler-v2 fba step: --mode=periodic --deadline-seconds=900 --lease-wait-seconds=600", /fba-publication-reconcile\.mjs --bucket=\$\{\{ needs\.run\.outputs\.region \}\} --as-of=\$\{\{ needs\.run\.outputs\.inventory_asof \}\} --mode=periodic --deadline-seconds=900 --lease-wait-seconds=600 \$LIVE\n/.test(sched));
  ok("F13b the fba job timeout stays 120 minutes", /\n  fba:\n[\s\S]{0,2400}?timeout-minutes: 120\n/.test(sched));
  ok("F13c the backstop keeps timeout 420 + --deadline-seconds=330", /timeout 420 node scripts\/release\/fba-publication-reconcile\.mjs [^\n]*--deadline-seconds=330 /.test(back));
});

// ---- 5. review round 1 (D3 reviewer P2-1 + P3s) ---------------------------------------------------------------------
test("F7b a SPARSE array (holes skip map / every) is NOT a permutation -> the sorted order + fallback", async () => {
  const logs = [];
  const c = core({ logs, adapterExtra: { orderStale: ({ staleAccounts }) => { const o = new Array(staleAccounts.length); o[0] = staleAccounts[2]; o[1] = staleAccounts[0]; return o; } } });
  const out = await c.reconciler.run({ bucket: "india", requestedAsOf: "2026-09-28" });
  ok("F7b sparse array -> sorted order kept, all 4 published, fallback logged (no dropped account, no throw)", JSON.stringify(c.calls.release) === '["A","B","C","D"]' && out.counts.targetsPublished === 4 && logs.some((l) => /stale-order-fallback/.test(l)));
});

test("F1g honest-empty accounts are ordered by the per-day tie ALONE (their served date never advances, so it must never rank them)", () => {
  const statusOf = new Map([...EMPTY].map((a) => [a, FBA_REVISION_STATUS.PROVEN_EMPTY]));
  const dated = new Map([...EMPTY].map((a, i) => [a, "2026-08-0" + (i + 1)]));
  const withDates = fbaFairOrder({ staleAccounts: [...EMPTY], statusOf, servedAsOf: dated, requestedAsOf: "2026-09-28" });
  const noDates = fbaFairOrder({ staleAccounts: [...EMPTY], statusOf, servedAsOf: new Map(), requestedAsOf: "2026-09-28" });
  ok("F1g the proven-empty order ignores any served / LKG date (identical with and without dates)", JSON.stringify(withDates) === JSON.stringify(noDates));
});

test("F14 HEAD-OF-LINE: a HUNG account (the most starved -> FIRST every run) is cut by its OWN budget and the run CONTINUES", async () => {
  const servedAsOf = new Map(EU.map((a) => [a, "2026-09-27"]));
  const HUNG = "fbd72f10";
  servedAsOf.set(HUNG, "2026-09-20");
  const releaseImpl = ({ accountId, signal }) => {
    if (accountId !== HUNG) { if (!EMPTY.has(accountId)) servedAsOf.set(accountId, "2026-09-28"); return Promise.resolve({ ok: true, code: 0 }); }
    // cooperative: the op settles when its signal aborts (like fba-brand-inventory-release's abort handling)
    return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ ok: false, code: 1, stage: "reconcile", status: "DEADLINE_ABORTED", reason: "deadline-aborted" })));
  };
  // the CLI's per-account budget, compressed to 5 ms (fba-publication-reconcile.mjs ACCOUNT_DEADLINE_SECONDS)
  const deadlineRace = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r({ __accountDeadline: true }), 5))]);
  const h = harness({ servedAsOf, releaseImpl, deadlineRace });
  const out = await h.reconciler.run({ bucket: "europe-au", requestedAsOf: "2026-09-28", mode: "periodic" });
  ok("F14a the hung account runs FIRST and is deferred typed 'deadline-account-in-flight' (termination confirmed, LKG kept)",
    h.calls.release[0] === HUNG && stateOf(out, HUNG).state === RECONCILE_STATUS.DEFERRED_DEPENDENCY && stateOf(out, HUNG).reason === "deadline-account-in-flight" && stateOf(out, HUNG).terminationConfirmed === true && stateOf(out, HUNG).lkgPreserved === true);
  ok("F14b the run CONTINUES: all 31 other accounts publish; the controls are safe-closed; the run is honest 'partial'",
    EU.filter((a) => a !== HUNG).every((a) => stateOf(out, a).state === FBA_RECONCILE_STATUS.READBACK_VERIFIED) && h.calls.close === 1 && out.outcome === "partial" && out.controlCleanupUnresolved === false);
  // unconfirmed termination: the run stops exactly as a run deadline does (the op may still hold the fence).
  const neverSettles = ({ accountId }) => (accountId === HUNG ? new Promise(() => {}) : Promise.resolve({ ok: true, code: 0 }));
  const served2 = new Map(EU.map((a) => [a, "2026-09-27"])); served2.set(HUNG, "2026-09-20"); // the hung account leads
  const h2 = harness({ servedAsOf: served2, releaseImpl: neverSettles, deadlineRace, awaitSettled: async () => ({ settled: false }) });
  const out2 = await h2.reconciler.run({ bucket: "europe-au", requestedAsOf: "2026-09-28", mode: "periodic" });
  ok("F14c UNCONFIRMED termination -> 'deadline-termination-unconfirmed', every remaining account deferred, NO safe-close (lease + controls left for cleanup), run non-green",
    stateOf(out2, HUNG).reason === "deadline-termination-unconfirmed" && EU.filter((a) => a !== HUNG).every((a) => stateOf(out2, a).reason === "deadline-cleanup-reserved") && h2.calls.close === 0 && out2.controlCleanupUnresolved === true && out2.ok === false);
});

test("F15 the served-date reads are CAPPED per read and in TOTAL: a hanging reader cannot delay the run", async () => {
  const t0 = Date.now();
  const h = harness({ readServed: async ({ accountId }) => (accountId === "06700b34" ? new Promise(() => {}) : "2026-09-27"), readCapMs: 20, capacity: 1 });
  await h.reconciler.run({ bucket: "europe-au", requestedAsOf: "2026-09-28", mode: "periodic" });
  ok("F15a a hanging read resolves null after the per-read cap (that account is 'most starved' -> first) and the run proceeds promptly", h.calls.release[0] === "06700b34" && Date.now() - t0 < 5000);
  const logs = [];
  let reads = 0;
  const h2 = harness({ readServed: async () => { reads += 1; return new Promise((r) => setTimeout(() => r("2026-09-27"), 15)); }, readCapMs: 1000, readBudgetMs: 40, logs, capacity: 0 });
  await h2.reconciler.run({ bucket: "europe-au", requestedAsOf: "2026-09-28", mode: "periodic" });
  ok("F15b the TOTAL read budget stops further reads (the rest are null) and is logged", reads > 0 && reads < 23 && logs.some((l) => /served-date read budget reached/.test(l)));
  // The budget also bounds the LAST read: a read that starts inside the budget is cut when the budget runs out, never
  // after its full per-read cap (the phase was budget + one cap before; review P3).
  const logs3 = [];
  let reads3 = 0;
  const t3 = Date.now();
  const h3 = harness({ readServed: async () => { reads3 += 1; return new Promise(() => {}); }, readCapMs: 5000, readBudgetMs: 60, logs: logs3, capacity: 0 });
  await h3.reconciler.run({ bucket: "europe-au", requestedAsOf: "2026-09-28", mode: "periodic" });
  ok("F15c an in-flight read is cut at the budget left (min(per-read cap, budget left)): hung reads under a 60 ms budget and a 5 s cap end the phase near 60 ms, never after the 5 s cap",
    reads3 >= 1 && reads3 <= 3 && Date.now() - t3 < 2500 && logs3.some((l) => /served-date read budget reached/.test(l)));
});

test("F16 when the fair-order phase itself reaches the start cutoff, NO control is opened (no apply + rollback for zero work)", async () => {
  let ordered = false;
  const logs = [];
  const h = harness({ readServed: async () => { ordered = true; return "2026-09-27"; }, outOfTime: () => ordered, logs });
  const out = await h.reconciler.run({ bucket: "europe-au", requestedAsOf: "2026-09-28", mode: "periodic" });
  ok("F16 no openControls, every stale account deferred 'deadline-cleanup-reserved' (LKG kept), logged, zero releases",
    h.calls.open.length === 0 && h.calls.release.length === 0 && EU.every((a) => stateOf(out, a).reason === "deadline-cleanup-reserved") && logs.some((l) => /fair-order phase reached the start cutoff/.test(l)));
});

test("F17 the CLI gives every account its OWN budget, PROPORTIONAL to the run (a quarter of the deadline within [60, 180] s), signalled with { __accountDeadline: true }", () => {
  const s = src("./release/fba-publication-reconcile.mjs");
  const m = s.match(/const ACCOUNT_DEADLINE_SECONDS = (deadlineSec > 0 \? Math\.min\(180, Math\.max\(60, Math\.floor\(deadlineSec \/ 4\)\)\) : 0);/);
  const budget = (deadlineSec) => (m ? new Function("deadlineSec", "return " + m[1])(deadlineSec) : NaN);
  ok("F17 budget = 180 s for the 900 s scheduler step, 82 s for the 330 s backstop / worker child, 60 s floor, 0 without a deadline; the race resolves the account marker only when the account budget comes first",
    !!m && budget(900) === 180 && budget(330) === 82 && budget(120) === 60 && budget(0) === 0
    && /accountFirst \? \{ __accountDeadline: true \} : \{ __deadline: true \}/.test(s) && /const accountFirst = accountMs < remainingMs;/.test(s));
});

for (const t of tests) {
  try { await t.fn(); } catch (e) { writeSync(2, `FAIL ${t.name}\n${e && e.stack ? e.stack : e}\n`); process.exit(1); }
}
writeSync(1, `fba-reconcile-fairness: ${passed} assertions passed\n`);
