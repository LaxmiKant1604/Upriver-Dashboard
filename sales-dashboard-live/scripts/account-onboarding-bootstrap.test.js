// The TRUSTED scheduler-v2 bootstrap scope + the REGION-LOCAL, IMMUTABLE wave + the RETRY-SAFE,
// PLAN-HASH-BOUND budget. Proves the Round-4 corrective properties: region-local immutable waves; the
// frozen dispatch scope resolved from the immutable row (readiness flap defers, never widens); the full
// approved-work binding via stepPlanHash (a changed date/window/source is PLAN_DRIFT even at equal token
// counts); retry-safe cumulative reservations (a smaller retry reuses the one reservation; cumulative
// actuals can never exceed the approved ceiling); and the SQL-modelled reserve/record semantics. Plus
// the static migration + wiring guards. Fully offline. 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  filterBootstrapPendingAccounts, ONBOARDING_STATUS,
  computeOnboardingWaveIdentity, computeAllRegionOnboardingWaves, bootstrapAccountSetHash,
  onboardingPlanFingerprint, onboardingStepPlanHash, bootstrapCycleBucket, dispatchMembershipHash,
  bootstrapFbaCycleBucket,
} from "../lib/server/sync/account-onboarding.js";
import {
  resolveBootstrapScopeByDispatch, gateOnboardingBudget, recordOnboardingActualSpend,
  buildOnboardingStepEntry, findApprovedStepEntry, bootstrapStepRef,
  assertBootstrapStepPlan, fbaSellerBatches as fbaSellerBatchesFn, verifyBootstrapCompletion,
  fbaPlanStructure,
} from "../lib/server/sync/account-onboarding-bootstrap.js";
import { buildFbaPlanRelease } from "../lib/server/sync/fba-plan-release-composition.js";
import { advanceFbaPlanBucket } from "../lib/server/sync/fba-plan-operation.js";
import { runControlPackageTransaction, buildFbaPlanControlPackage, buildPrioritySafeClosePackage } from "../lib/server/sync/source-priority-control-package.js";
import { fbaPlanPayload } from "../lib/server/reports/derivation-core.js";
import { REPORT_DERIVATIONS } from "../lib/server/sync/report-derivation.js";

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); };
writeSync(1, "account-onboarding-bootstrap\n");

const detailed = (id, country, ready = true) => ({
  id, name: `A ${id}`, country, countryName: country, currency: "USD", locale: "en-US", timeZone: "UTC",
  readiness: { sellerCentralReady: ready, rowCount: 10, sellerCentralRowCount: 5, adsConnected: true, adsReady: ready, adsRowCount: 3, accountType: "SELLER", marketplaceId: "M1" },
});
const row = (id, status, { region = "india", operationId = `account-bootstrap/${id}/2026-09-06` } = {}) => ({
  account_id: id, status, region, operation_id: status === ONBOARDING_STATUS.BOOTSTRAPPING ? operationId : null,
});

/* ===================== A. the FROZEN scope + REGION-LOCAL wave ===================== */
(() => {
  const rows = [
    row("in-1", ONBOARDING_STATUS.BOOTSTRAPPING),
    row("in-2", ONBOARDING_STATUS.BOOTSTRAPPING),
    row("in-ready", ONBOARDING_STATUS.READY),
    row("in-wait", ONBOARDING_STATUS.WAITING_FOR_DATADOE),
    row("eu-1", ONBOARDING_STATUS.BOOTSTRAPPING, { region: "europe-au" }),
  ];
  const accounts = [detailed("in-1", "IN"), detailed("in-2", "IN"), detailed("eu-1", "DE")];
  const scope = filterBootstrapPendingAccounts({ detailedAccounts: accounts, onboardingRows: rows, region: "india" });
  ok("A: EXACTLY the region's claimed accounts are in scope", scope.accounts.map((a) => a.id).sort().join(",") === "in-1,in-2");

  const wIndia = computeOnboardingWaveIdentity(rows, "india");
  const wEurope = computeOnboardingWaveIdentity(rows, "europe-au");
  ok("A: the wave key is REGION-LOCAL (india vs europe-au differ; each names only its own accounts)",
    /^onboarding-wave\/india\/[0-9a-f]{32}$/.test(wIndia.waveKey) && /^onboarding-wave\/europe-au\//.test(wEurope.waveKey)
    && wIndia.accounts.join(",") === "in-1,in-2" && wEurope.accounts.join(",") === "eu-1");
  ok("A: the dispatch id is region-local + membership-hashed", wIndia.dispatchId === `onboarding-bootstrap/india/${wIndia.membershipHash.slice(0, 16)}`);
  // A NEW europe account NEVER changes india's identity (region isolation).
  const rows2 = [...rows, row("eu-2", ONBOARDING_STATUS.BOOTSTRAPPING, { region: "europe-au" })];
  ok("A: adding a Europe account leaves india's wave key + dispatch id UNCHANGED (region-local)",
    computeOnboardingWaveIdentity(rows2, "india").waveKey === wIndia.waveKey
    && computeOnboardingWaveIdentity(rows2, "india").dispatchId === wIndia.dispatchId
    && computeOnboardingWaveIdentity(rows2, "europe-au").waveKey !== wEurope.waveKey);
  // A NEW india account DOES change india's identity.
  const rows3 = [...rows, row("in-3", ONBOARDING_STATUS.BOOTSTRAPPING)];
  ok("A: adding an india account mints a DIFFERENT india wave key + dispatch id",
    computeOnboardingWaveIdentity(rows3, "india").waveKey !== wIndia.waveKey);
  ok("A: computeAllRegionOnboardingWaves returns only regions with claims", [...computeAllRegionOnboardingWaves(rows).keys()].sort().join(",") === "europe-au,india");
  let threw = null;
  try { computeOnboardingWaveIdentity(rows, "us"); } catch (e) { threw = String(e.message); }
  ok("A: a non-region fails closed", threw && threw.includes("routing region"));
  ok("A: bootstrapCycleBucket is WAVE-BOUND (bootstrap-<region>-<membership-hash-16>)", bootstrapCycleBucket("india", wIndia.membershipHash.slice(0, 16)) === "bootstrap-india-" + wIndia.membershipHash.slice(0, 16));
})();

/* ===================== B. stepPlanHash binds the FULL approved work (P0-3 primitive) ===================== */
(() => {
  const base = { step: "oli", region: "india", accounts: ["a", "b"], operationIds: ["op-a", "op-b"], accountSetHash: "h1", planAsOf: "2026-09-06", sourceKeys: ["order-line-items"], windows: [{ sourceKey: "order-line-items", from: "2025-01-01", to: "2026-09-06" }], plannedCreates: 3, plannedTokens: 6 };
  const h = onboardingStepPlanHash(base);
  ok("B: the step plan hash is deterministic + order-insensitive on sets", h === onboardingStepPlanHash({ ...base, accounts: ["b", "a"], sourceKeys: ["order-line-items", "order-line-items"] }));
  ok("B: a different planAsOf changes the hash at IDENTICAL token counts", h !== onboardingStepPlanHash({ ...base, planAsOf: "2026-09-09" }));
  ok("B: a different WINDOW changes the hash at identical counts", h !== onboardingStepPlanHash({ ...base, windows: [{ sourceKey: "order-line-items", from: "2026-08-01", to: "2026-09-06" }] }));
  ok("B: a different SOURCE key changes the hash", h !== onboardingStepPlanHash({ ...base, sourceKeys: ["product-catalog"] }));
  ok("B: a different account SET changes the hash", h !== onboardingStepPlanHash({ ...base, accountSetHash: "h2" }));
  ok("B: a different operation-id set changes the hash", h !== onboardingStepPlanHash({ ...base, operationIds: ["op-a", "op-c"] }));
  const entry = buildOnboardingStepEntry(base);
  ok("B: buildOnboardingStepEntry folds the same hash into a stored entry", entry.stepPlanHash === h && entry.plannedTokens === 6);
  // The fingerprint folds stepPlanHash, so different work -> different fingerprint even at equal counts.
  const s1 = [buildOnboardingStepEntry(base)];
  const s2 = [buildOnboardingStepEntry({ ...base, planAsOf: "2026-09-09" })];
  ok("B: the plan fingerprint changes when any step's work changes (equal counts)", onboardingPlanFingerprint(s1) !== onboardingPlanFingerprint(s2));
})();

/* ===================== C. resolveBootstrapScopeByDispatch (frozen row; defer flap; never widen) ===================== */
await (async () => {
  const waveKey = "onboarding-wave/india/abc";
  const frozen = ["in-1", "in-2"];
  const did = "onboarding-bootstrap/india/0123456789abcdef";
  const budget = { budget_key: waveKey, status: "authorized", plan_fingerprint: "fp", approved_plan: [{ step: "oli", region: "india", accountSetHash: bootstrapAccountSetHash(frozen), stepPlanHash: "sph", plannedTokens: 6, plannedCreates: 3, planAsOf: "2026-09-06" }] };
  const dispatchRow = { region: "india", dispatch_id: did, wave_key: waveKey, status: "queued", account_ids: frozen, operation_ids: ["op-1", "op-2"] };
  const deps = {
    apiKey: "k", region: "india", dispatchId: did,
    readDispatchRow: async () => dispatchRow, readBudget: async () => budget,
    fetchDetailed: async () => [detailed("in-1", "IN", true), detailed("in-2", "IN", false)], // in-2 FLAPPED to not-ready
  };
  const scope = await resolveBootstrapScopeByDispatch(deps);
  ok("C: the scope is loaded FROM THE ROW (frozen accounts + operation ids), never recomputed",
    scope.ok && JSON.stringify(scope.frozenAccountIds) === JSON.stringify(frozen) && scope.operationIds.join(",") === "op-1,op-2");
  ok("C(regression 3): a FLAPPED account DEFERS THE ENTIRE WAVE (allReady=false, accounts=[]) -- never a ready subset",
    scope.allReady === false && scope.accounts.length === 0 && scope.deferred.join(",") === "in-2");
  ok("C: the accountSetHash is ALWAYS the FULL immutable set's hash + the wave-bound cycle bucket is exposed",
    scope.accountSetHash === bootstrapAccountSetHash(frozen) && scope.cycleBucket === "bootstrap-india-0123456789abcdef");
  // A newly-ready account that is NOT in the frozen row can never join (scope never widens); all-ready proceeds.
  const wideDeps = { ...deps, fetchDetailed: async () => [detailed("in-1", "IN", true), detailed("in-2", "IN", true), detailed("in-99", "IN", true)] };
  const wideScope = await resolveBootstrapScopeByDispatch(wideDeps);
  ok("C: with EVERY frozen account ready the wave proceeds; a non-frozen ready account NEVER enters (immutable set only)",
    wideScope.allReady === true && wideScope.accounts.length === 2 && !wideScope.accounts.some((a) => a.id === "in-99"));
  const malformed = await resolveBootstrapScopeByDispatch({ ...deps, dispatchId: "onboarding-bootstrap/india/xyz" });
  ok("C: a malformed dispatch id (non-16-hex) fails typed (DISPATCH_ID_MALFORMED)", malformed.ok === false && malformed.reason === "DISPATCH_ID_MALFORMED");
  // Fail-closed reasons.
  const noRow = await resolveBootstrapScopeByDispatch({ ...deps, readDispatchRow: async () => null });
  ok("C: a missing dispatch row fails typed (DISPATCH_ROW_NOT_FOUND)", noRow.ok === false && noRow.reason === "DISPATCH_ROW_NOT_FOUND");
  const noBudget = await resolveBootstrapScopeByDispatch({ ...deps, readBudget: async () => null });
  ok("C: a missing budget fails typed (BUDGET_NOT_AUTHORIZED)", noBudget.ok === false && noBudget.reason === "BUDGET_NOT_AUTHORIZED");
  const wrongKey = await resolveBootstrapScopeByDispatch({ ...deps, readBudget: async () => ({ ...budget, budget_key: "onboarding-wave/india/OTHER" }) });
  ok("C: a budget whose key != the row's wave_key fails typed (WAVE_IDENTITY_MISMATCH)", wrongKey.ok === false && wrongKey.reason === "WAVE_IDENTITY_MISMATCH");
})();

/* ===================== D. the RETRY-SAFE, PLAN-HASH-BOUND budget (SQL-modelled reserve/record) ===================== */
await (async () => {
  // Offline model of reserve_onboarding_spend / record_onboarding_spend_actual with the migration's EXACT
  // Round-4 semantics: reserve the CEILING; retry reuses the one reservation; cumulative actuals capped.
  function makeStore() {
    const store = { rows: new Map() };
    store.authorize = ({ waveKey, tokens, planFingerprint, approvedPlan }) => {
      if (store.rows.has(waveKey)) throw new Error("never overwritten");
      store.rows.set(waveKey, { budget_key: waveKey, authorized_tokens: tokens, plan_fingerprint: planFingerprint, status: "authorized", reserved_tokens: 0, spent_tokens: 0, reservations: {}, approved_plan: approvedPlan });
    };
    store.readBudget = async (key) => { const r = store.rows.get(key); return r ? { ...r } : null; };
    store.reserve = async ({ budgetKey, ref, stepType, region, accountSetHash, planFingerprint, stepPlanHash, tokens, creates }) => {
      const r = store.rows.get(budgetKey);
      if (!r) return { disposition: "refused", reason: "BUDGET_NOT_AUTHORIZED" };
      if (r.status !== "authorized") return { disposition: "refused", reason: "BUDGET_CLOSED" };
      if (r.plan_fingerprint !== planFingerprint) return { disposition: "refused", reason: "PLAN_DRIFT", detail: "plan-fingerprint-mismatch" };
      const entry = r.approved_plan.find((e) => e.step === stepType && e.region === region);
      if (!entry) return { disposition: "refused", reason: "PLAN_DRIFT", detail: "step-not-in-approved-plan" };
      if (entry.accountSetHash !== accountSetHash) return { disposition: "refused", reason: "PLAN_DRIFT", detail: "account-set-mismatch" };
      if (entry.stepPlanHash !== stepPlanHash) return { disposition: "refused", reason: "PLAN_DRIFT", detail: "step-plan-hash-mismatch" };
      const ceilT = entry.plannedTokens, ceilC = entry.plannedCreates;
      if (tokens > ceilT || creates > ceilC) return { disposition: "refused", reason: "PLAN_DRIFT", detail: "exceeds-approved-step-plan" };
      const ex = r.reservations[ref];
      if (ex) {
        if (ex.stepType !== stepType || ex.region !== region || ex.accountSetHash !== accountSetHash || ex.stepPlanHash !== stepPlanHash) return { disposition: "refused", reason: "PLAN_DRIFT", detail: "existing-ref-field-mismatch" };
        if (ex.actualTokens + tokens > ceilT || ex.actualCreates + creates > ceilC) return { disposition: "refused", reason: "BUDGET_EXCEEDED", ceiling_tokens: ceilT, actual_tokens: ex.actualTokens, attempt_tokens: tokens };
        return { disposition: "already-reserved", ref, ceiling_tokens: ceilT, remaining_tokens: ceilT - ex.actualTokens, reserved_tokens: r.reserved_tokens, authorized_tokens: r.authorized_tokens };
      }
      if (r.reserved_tokens + ceilT > r.authorized_tokens) return { disposition: "refused", reason: "BUDGET_EXCEEDED", ceiling_tokens: ceilT, reserved_tokens: r.reserved_tokens, authorized_tokens: r.authorized_tokens };
      r.reserved_tokens += ceilT;
      r.reservations[ref] = { stepType, region, accountSetHash, stepPlanHash, tokens: ceilT, creates: ceilC, actualTokens: 0, actualCreates: 0 };
      return { disposition: "reserved", ref, ceiling_tokens: ceilT, reserved_tokens: r.reserved_tokens, authorized_tokens: r.authorized_tokens };
    };
    store.record = async ({ budgetKey, ref, actualTokens, actualCreates }) => {
      const r = store.rows.get(budgetKey);
      if (!r) return { disposition: "not-found" };
      const res = r.reservations[ref];
      if (!res) return { disposition: "not-reserved" };
      res.actualTokens += actualTokens; res.actualCreates += actualCreates;
      r.spent_tokens = Object.values(r.reservations).reduce((n, x) => n + x.actualTokens, 0);
      const over = res.actualTokens > res.tokens || res.actualCreates > res.creates;
      return over
        ? { disposition: "over-reservation", ref, spent_tokens: r.spent_tokens, ceiling_tokens: res.tokens, cumulative_tokens: res.actualTokens }
        : { disposition: "recorded", ref, spent_tokens: r.spent_tokens, cumulative_tokens: res.actualTokens };
    };
    return store;
  }

  const waveKey = "onboarding-wave/india/w1";
  const hash = bootstrapAccountSetHash(["in-1", "in-2"]);
  const oliEntry = buildOnboardingStepEntry({ step: "oli", region: "india", accounts: ["in-1", "in-2"], operationIds: ["op-1", "op-2"], accountSetHash: hash, planAsOf: "2026-09-06", sourceKeys: ["order-line-items"], windows: [{ sourceKey: "order-line-items", from: "2025-01-01", to: "2026-09-06" }], plannedCreates: 4, plannedTokens: 8 });
  const store = makeStore();
  store.authorize({ waveKey, tokens: 20, planFingerprint: onboardingPlanFingerprint([oliEntry]), approvedPlan: [oliEntry] });
  const fp = onboardingPlanFingerprint([oliEntry]);
  const stableRef = bootstrapStepRef({ step: "oli", region: "india", stepPlanHash: oliEntry.stepPlanHash });

  const gate = (opts) => gateOnboardingBudget({ waveKey, ref: stableRef, stepType: "oli", region: "india", accountSetHash: hash, stepPlanHash: oliEntry.stepPlanHash, readBudget: store.readBudget, reserve: store.reserve, ...opts });

  // First attempt: reserves the CEILING (8), not the attempt plan (6).
  const g1 = await gate({ plannedTokens: 6, plannedCreates: 3 });
  ok("D: first reserve books the APPROVED CEILING (reserved 8), not the attempt plan (6)", g1.ok && g1.disposition === "reserved" && store.rows.get(waveKey).reserved_tokens === 8);
  // Record a PARTIAL actual spend (crash-after-partial: 4 tok / 2 creates).
  await recordOnboardingActualSpend({ waveKey, ref: stableRef, actualTokens: 4, actualCreates: 2, record: (a) => store.record({ ...a, budgetKey: waveKey }) });
  ok("D(regression 6): a SMALLER same-ref retry (2 tok) REUSES the one reservation (already-reserved; no second reservation, no BUDGET_EXCEEDED)",
    (await gate({ plannedTokens: 2, plannedCreates: 1 })).disposition === "already-reserved" && store.rows.get(waveKey).reserved_tokens === 8);
  // Cumulative actuals accumulate; the ceiling is the hard bound.
  await recordOnboardingActualSpend({ waveKey, ref: stableRef, actualTokens: 2, actualCreates: 1, record: (a) => store.record({ ...a, budgetKey: waveKey }) });
  ok("D: actuals ACCUMULATE across attempts (4+2=6 of 8), never last-write-wins", store.rows.get(waveKey).spent_tokens === 6);
  const overAttempt = await gate({ plannedTokens: 4, plannedCreates: 2 }); // 6 cumulative + 4 attempt = 10 > 8 ceiling
  ok("D(retry cap): an attempt whose plan + cumulative actuals would EXCEED the approved ceiling is refused BEFORE any POST (BUDGET_EXCEEDED)",
    overAttempt.ok === false && overAttempt.refusal === "BUDGET_EXCEEDED");
  const overRec = await recordOnboardingActualSpend({ waveKey, ref: stableRef, actualTokens: 5, actualCreates: 0, record: (a) => store.record({ ...a, budgetKey: waveKey }) });
  ok("D: cumulative actuals ABOVE the ceiling are NEVER silent (typed over-reservation: 11 > 8)", overRec.disposition === "over-reservation" && overRec.cumulative_tokens === 11);

  /* ---- regression 7: SAME counts, CHANGED asOf/window/source => PLAN_DRIFT before POST ---- */
  const driftedEntry = buildOnboardingStepEntry({ step: "oli", region: "india", accounts: ["in-1", "in-2"], operationIds: ["op-1", "op-2"], accountSetHash: hash, planAsOf: "2026-09-09", sourceKeys: ["order-line-items"], windows: [{ sourceKey: "order-line-items", from: "2025-01-01", to: "2026-09-09" }], plannedCreates: 4, plannedTokens: 8 });
  ok("D(regression 7): a changed date/window (SAME token counts) has a DIFFERENT stepPlanHash", driftedEntry.stepPlanHash !== oliEntry.stepPlanHash);
  const driftGate = await gateOnboardingBudget({ waveKey, ref: bootstrapStepRef({ step: "oli", region: "india", stepPlanHash: driftedEntry.stepPlanHash }), stepType: "oli", region: "india", accountSetHash: hash, stepPlanHash: driftedEntry.stepPlanHash, plannedTokens: 8, plannedCreates: 4, readBudget: store.readBudget, reserve: store.reserve });
  ok("D(regression 7): reserving the drifted work is PLAN_DRIFT before any POST (equal counts, different dates)", driftGate.ok === false && driftGate.refusal === "PLAN_DRIFT");

  /* ---- regression 1 support: a larger account set never rides this reservation ---- */
  const grownHash = bootstrapAccountSetHash(["in-1", "in-2", "in-3"]);
  const grownGate = await gateOnboardingBudget({ waveKey, ref: stableRef, stepType: "oli", region: "india", accountSetHash: grownHash, stepPlanHash: oliEntry.stepPlanHash, plannedTokens: 2, plannedCreates: 1, readBudget: store.readBudget, reserve: store.reserve });
  ok("D: a re-reserve with a LARGER account set is PLAN_DRIFT (account growth can never ride the reservation)", grownGate.ok === false && grownGate.refusal === "PLAN_DRIFT");

  /* ---- regression 1 (old wave + new account => not authorized) ---- */
  const newWaveKey = "onboarding-wave/india/w2";
  const g = await gateOnboardingBudget({ waveKey: newWaveKey, ref: "oli/india/zzz", stepType: "oli", region: "india", accountSetHash: grownHash, stepPlanHash: "x", plannedTokens: 2, plannedCreates: 1, readBudget: store.readBudget, reserve: store.reserve });
  ok("D(regression 1): a NEW wave finds NO budget (BUDGET_NOT_AUTHORIZED) -- the old wave never spends for it", g.ok === false && g.refusal === "BUDGET_NOT_AUTHORIZED");
})();

/* ===================== E. static migration + wiring guards ===================== */
(() => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const read = (p) => readFileSync(path.join(root, p), "utf8");
  const sql = read("supabase/migrations/20260919_account_onboarding.sql");
  for (const needle of [
    "primary key (region, dispatch_id)",
    "account_onboarding_dispatch_one_active",
    "operation_ids jsonb",
    "wave_key text not null",
    "p_step_plan_hash text",
    "'step-plan-hash-mismatch'",
    "region-busy", "region text not null",
    "v_actual_tokens + p_tokens > v_ceiling_tokens",
    "v_cum_tokens := coalesce",
    // Round-5/6: wave-bound cycle bucket pattern (not arbitrary; -fba variant); publication manifest.
    // Round-7: the manifest carries PROVENANCE (run_token + FK + not-bucket-label) and there is a global
    // control-plane lease. The typed-unavailable table/RPC/enum are REMOVED (dead FBA path, blocker 3).
    "^bootstrap(-fba)?-(india|europe-au|us-ca)-[0-9a-f]{16}$",
    "account_onboarding_publication", "record_onboarding_publication",
    "account_onboarding_publication_dispatch_fk", "account_onboarding_publication_cycle_fk",
    "cycle_id uuid not null", "references public.sync_cycles (id)",
    "run_token text not null", "stale-run-token", "outside the frozen membership",
    // Round-8: the RPC proves the cycle's bucket + date; the lease has a fencing generation + heartbeat + reclaim.
    "from public.sync_cycles where id = v_cycle_uuid", "generation bigint not null",
    "control_plane_lease", "acquire_control_plane_lease", "renew_control_plane_lease", "release_control_plane_lease",
    "active_run_token", "'superseded-or-not-owner'", "'lease-owned'",
  ]) ok(`E: migration declares ${needle.slice(0, 48)}`, sql.includes(needle));
  // Round-7 blocker 3: the dead typed-unavailable table/RPC/enum are GONE.
  for (const gone of ["create table if not exists public.account_onboarding_unavailable", "function public.record_onboarding_unavailable", "account_onboarding_unavailable_reason_enum", "'FBA_SOURCE_DATA_UNAVAILABLE'"]) {
    ok(`E(round-7, blocker 3): migration NO LONGER declares ${gone.slice(0, 48)}`, !sql.includes(gone));
  }
  ok("E: the reserve RPC is the NEW 9-arg drift+retry signature (service_role only)",
    sql.includes("grant execute on function public.reserve_onboarding_spend(text, text, text, text, text, text, text, integer, integer) to service_role;"));
  ok("E: the lease/mark RPCs carry wave_key + operation_ids (5-arg) and are service_role only",
    sql.includes("grant execute on function public.lease_onboarding_dispatch(text, text, text, jsonb, jsonb) to service_role;")
    && sql.includes("grant execute on function public.mark_onboarding_dispatch_awaiting_budget(text, text, text, jsonb, jsonb) to service_role;"));
  ok("E(round-8/9): the ack RPC is 5-arg; the publication RPC is 10-arg; the lease RPCs are service_role only (release is now 2-arg owner+generation); the FENCED CAS RPC exists (10-arg)",
    sql.includes("grant execute on function public.ack_onboarding_dispatch(text, text, text, text, text) to service_role;")
    && sql.includes("grant execute on function public.record_onboarding_publication(text, text, text, text, text, date, text, text, text, text) to service_role;")
    && sql.includes("grant execute on function public.acquire_control_plane_lease(text, text, int) to service_role;")
    && sql.includes("grant execute on function public.renew_control_plane_lease(text, bigint, int) to service_role;")
    && sql.includes("grant execute on function public.release_control_plane_lease(text, bigint) to service_role;")
    && sql.includes("grant execute on function public.cas_report_snapshot_if_newer_fenced(text, text, text, jsonb, jsonb, text, bigint, timestamptz, text, bigint) to service_role;"));
  ok("E(round-6, blocker 2): the cycle-bucket CHECK + open_sync_cycle guard use the reviewed PATTERN widened to bootstrap(-fba) (never an arbitrary bucket)",
    sql.includes("bucket ~ '^bootstrap(-fba)?-(india|europe-au|us-ca)-[0-9a-f]{16}$'") && sql.includes("p_bucket ~ '^bootstrap(-fba)?-(india|europe-au|us-ca)-[0-9a-f]{16}$'"));
  ok("E: no static/global wave key survives (every wave key is region-local)",
    !sql.includes("onboarding-wave/v1") && !read("lib/server/sync/account-onboarding-bootstrap.js").includes("ONBOARDING_WAVE_BUDGET_KEY"));

  // Operators resolve by DISPATCH ID (frozen), DEFER the whole wave when not all-ready, and RECOMPUTE the
  // step plan hash from the runtime plan (never echo the stored approved hash).
  for (const [file, step] of [["scripts/release/oli-refresh-d1.mjs", "oli"], ["scripts/release/scheduled-campaign-ads-refresh.mjs", "campaign"], ["scripts/release/fba-plan-golive.mjs", "fba"]]) {
    const src = read(file);
    ok(`E: ${file} resolves the FROZEN scope by --dispatch-id, DEFERS on !allReady, and gates stepType "${step}"`,
      src.includes("resolveBootstrapScopeByDispatch") && src.includes("--dispatch-id") && src.includes("bootstrapStepRef") && src.includes("allReady") && src.includes(`stepType: "${step}"`));
    ok(`E(regression 4): ${file} RECOMPUTES the step plan hash from the runtime plan (assertBootstrapStepPlan) -- NEVER echoes bootstrapEntry.stepPlanHash into the gate`,
      src.includes("assertBootstrapStepPlan") && src.includes("chk.stepPlanHash") && !/stepPlanHash:\s*String\(bootstrapEntry\.stepPlanHash/.test(src));
  }

  // TRUE SCOPED PUBLICATION: dedicated composition + WAVE-BOUND cycle + recompute + the ONLY completed gate.
  const pub = read("scripts/release/bootstrap-publish.mjs");
  ok("E(regression 4): the scoped publication uses the WAVE-BOUND cycle (scope.cycleBucket), recomputes the catalog hash, defers the whole wave, and narrows discovery to the frozen accounts",
    pub.includes("resolveBootstrapScopeByDispatch") && pub.includes("scope.cycleBucket") && pub.includes("assertBootstrapStepPlan") && pub.includes("scope.allReady") && pub.includes("fetchAccounts: async () => frozenAccounts") && pub.includes("runPriorityDashboardsRelease"));
  const rel = read("lib/server/sync/source-priority-dashboards.js");
  ok("E: the release composition threads the dedicated cycleBucket into derive + finalize (byte-identical when null)",
    rel.includes("cycleBucketFor") && rel.includes("cycleBucket != null ? cycleBucket : bucket") && rel.includes("cycleKeyBucket = cycleBucketFor(bucket)"));
  const verify = read("scripts/release/verify-bootstrap-published.mjs");
  ok("E(round-7, blocker 2): the completed gate reads by EXACT identity from the publication MANIFEST (not the newest) + compares the ACTIVE run token; the typed-unavailable read is GONE",
    verify.includes("verifyBootstrapCompletion") && verify.includes("getOnboardingPublication") && verify.includes("readByIdentity") && verify.includes("getReportSnapshot(") && !verify.includes("getLatestReportSnapshot") && verify.includes("expectedRunToken") && verify.includes("active_run_token") && !verify.includes("getOnboardingUnavailable") && verify.includes("EMPTY_WAVE_SCOPE") && verify.includes("BOOTSTRAP_NOT_FULLY_PUBLISHED"));
  const bootstrapMod = read("lib/server/sync/account-onboarding-bootstrap.js");
  ok("E(round-7, blocker 2): the shared completion core binds the exact manifest identity + PROVENANCE (no-cycle-provenance / cycle-is-bucket-label / superseded-attempt) + coversAsOf==D-1 + payload validity; the typed-unavailable branch is GONE",
    bootstrapMod.includes("no-manifest-entry") && bootstrapMod.includes("identity-mismatch") && bootstrapMod.includes("no-cycle-provenance") && bootstrapMod.includes("cycle-is-bucket-label") && bootstrapMod.includes("superseded-attempt") && bootstrapMod.includes("payload-contract") && !bootstrapMod.includes("no-typed-unavailable") && !bootstrapMod.includes("unavailableRows"));
  const fba = read("scripts/release/fba-plan-golive.mjs");
  ok("E(round-7, blockers 1/2/3): the FBA operator scopes to frozenAccountIds, uses the wave-bound FBA cycle + control OWNER TOKEN, runs STRICT, binds the DEFAULT plan structure, records the manifest with the ACTUAL cycle id + run token, and NO LONGER writes the dead typed-unavailable path",
    fba.includes("accountScopeIds: bootstrapScope.frozenAccountIds") && fba.includes("bootstrapFbaCycleBucket") && fba.includes("strict: true")
    && fba.includes("ownerToken: runToken") && fba.includes("fbaPlanStructure(defaultFbaPlan") && fba.includes("runToken")
    && !fba.includes("waveSourceIncapable") && !fba.includes("FBA_SOURCE_DATA_UNAVAILABLE") && !fba.includes("recordOnboardingUnavailable")
    && !fba.includes("getReportSnapshotPresence"));

  // Round-7 blocker 1 SOURCE GUARDS: the single control-plane funnel enforces the owner lease, the pg store
  // implements it, and EVERY control-plane caller threads an owner token -- so no caller can do an un-leased
  // global reconcile/safe-close (the global safe-close cannot return for scoped/concurrent ownership).
  const ctlPkg = read("lib/server/sync/source-priority-control-package.js");
  ok("E(round-7, blocker 1): runControlPackageTransaction takes ownerToken, REQUIRES it when the store is lease-capable (fail closed), acquires on apply, requires ownership on rollback (skipped: lease-not-owner), and releases on safe-close",
    ctlPkg.includes("ownerToken") && ctlPkg.includes("leaseCapable") && ctlPkg.includes("acquireControlLease") && ctlPkg.includes("assertControlLeaseOwner") && ctlPkg.includes("releaseControlLease")
    && ctlPkg.includes("CONTROL_LEASE_HELD") && ctlPkg.includes("lease-not-owner")
    && /leaseCapable && !owner\)?\s*throw/.test(ctlPkg.replace(/\s+/g, " ")));
  const pgStore = read("lib/server/sync/priority-control-pg-store.js");
  ok("E(round-7/8, blocker 1): the pg store implements the lease via the acquire/renew/release/read RPCs",
    pgStore.includes("acquire_control_plane_lease") && pgStore.includes("renew_control_plane_lease") && pgStore.includes("release_control_plane_lease") && pgStore.includes("read_control_plane_lease")
    && pgStore.includes("acquireControlLease") && pgStore.includes("renewControlLease") && pgStore.includes("releaseControlLease") && pgStore.includes("assertControlLeaseOwner"));
  ok("E(round-7/9, blocker 1): the FBA release seam threads ownerToken into BOTH control apply + close (close also passes ownerGeneration)",
    (read("lib/server/sync/fba-plan-release-composition.js").match(/mode: "apply"[\s\S]{0,300}?ownerToken/g) || []).length >= 1
    && (read("lib/server/sync/fba-plan-release-composition.js").match(/mode: "rollback"[\s\S]{0,200}?ownerToken/g) || []).length >= 1
    && read("lib/server/sync/fba-plan-release-composition.js").includes("ownerGeneration: leaseFence ? leaseFence.generation : null"));
  ok("E(round-7/8, blocker 1): EVERY control-plane caller passes an owner token (priority CLI EFFECTIVE_TOKEN, manual operator, route apply+fba)",
    read("scripts/release/priority-control-package.mjs").includes("--owner-token=") && read("scripts/release/priority-control-package.mjs").includes("ownerToken: EFFECTIVE_TOKEN")
    && read("scripts/release/manual-source-sync.mjs").includes("ownerToken: OWNER_TOKEN")
    && read("api/admin/sources.js").includes("route-fba:") && read("api/admin/sources.js").includes("route-priority:"));
  const ymlSrc = read("../.github/workflows/scheduler-v2.yml");
  ok("E(round-7, blocker 1): the workflow threads the same owner/run token (github run_id-run_attempt) through priority apply, safe-close, bootstrap-publish, and FBA go-live",
    (ymlSrc.match(/--owner-token=\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/g) || []).length >= 3
    && (ymlSrc.match(/--run-token=\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/g) || []).length >= 2);
  // Round-7 blocker 2 SOURCE GUARDS: the scoped publication records the REAL durable cycle id + run token.
  ok("E(round-7, blocker 2): bootstrap-publish records the ACTUAL durable cycle id (never scope.cycleBucket) + the active run token; the runner surfaces the durable cycle id per identity",
    !/cycleId:\s*scope\.cycleBucket/.test(pub) && pub.includes("--run-token") && pub.includes("runToken,")
    && read("lib/server/sync/source-priority-release-runner.js").includes("cycleIdByAccount")
    && read("lib/server/sync/source-priority-release-runner.js").includes("cycleId: S(cycleIdByAccount.get(p.accountId))"));

  // ---- Round-8 SOURCE GUARDS ----
  const fbaOp = read("lib/server/sync/fba-plan-operation.js");
  ok("E(round-8, blocker 1): advanceFbaPlanBucket takes a verifyLease hook, heartbeats BEFORE each publish chunk, and returns typed leaseLost contention",
    fbaOp.includes("verifyLease") && fbaOp.includes("leaseLost") && fbaOp.includes('phase: "contention"') && /await verifyLease\(\)/.test(fbaOp));
  ok("E(round-8, blocker 1): the priority runner heartbeats before each publish (CONTROL_LEASE_LOST) + the FBA release exposes verifyLease + the callers wire it",
    read("lib/server/sync/source-priority-release-runner.js").includes("CONTROL_LEASE_LOST") && read("lib/server/sync/source-priority-release-runner.js").includes("verifyLease")
    && read("lib/server/sync/fba-plan-release-composition.js").includes("verifyLease") && read("lib/server/sync/fba-plan-release-composition.js").includes("renewControlLease")
    && read("scripts/release/fba-plan-golive.mjs").includes("verifyLease: release.verifyLease") && read("api/admin/sources.js").includes("verifyLease: release.verifyLease")
    && pub.includes("renewControlPlaneLease") && !pub.includes("acquireControlPlaneLease")); // Round-11: bootstrap-publish RENEWS the apply fence, never re-acquires
  ok("E(round-8, blocker 1): the transaction funnel adds the reclaim mode (acquire-if-free -> safe-close -> release), returns the fencing generation on apply, and lease-not-owner is a TYPED NON-SUCCESS",
    ctlPkg.includes('mode === "reclaim"') && ctlPkg.includes("leaseGeneration") && /leaseNotOwner:\s*true/.test(ctlPkg) && /committed:\s*false,\s*mode,\s*code:\s*0,\s*skipped:\s*"lease-not-owner"/.test(ctlPkg.replace(/\s+/g, " ")));
  ok("E(round-8, blocker 1): an explicit expired-lease cleanup exists (--reclaim-stale) that acquires only a free lease before closing",
    read("scripts/release/priority-control-package.mjs").includes("--reclaim-stale") && read("scripts/release/priority-control-package.mjs").includes('MODE === "reclaim"'));
  ok("E(round-8, blocker 2): the route mints a CRYPTOGRAPHICALLY-UNIQUE per-execution token (randomUUID), NOT operator+bucket; the manual CLI REQUIRES --owner-token (no fallback) + typed lease-not-owner skip",
    read("api/admin/sources.js").includes("randomUUID") && /route-fba:" \+ bucket \+ ":" \+ randomUUID\(\)/.test(read("api/admin/sources.js"))
    && read("scripts/release/priority-control-package.mjs").includes("--owner-token is REQUIRED")
    && !/priority-control\/"\s*\+\s*\(BUCKET \|\| "all"\) \+ "\/" \+ process\.pid/.test(read("scripts/release/priority-control-package.mjs"))
    && read("scripts/release/priority-control-package.mjs").includes("SKIPPED control package"));
  ok("E(round-8, blocker 3): the manifest cycle_id is a REAL sync_cycles uuid (FK) + the RPC proves bucket/date; bootstrap-publish + fba-golive pass the cycle_bucket; the verifier compares expectedProvenance per report",
    sql.includes("cycle_id uuid not null") && sql.includes("references public.sync_cycles (id)") && sql.includes("v_cyc.cycle_date <> p_covers_asof")
    && pub.includes("cycleBucket: scope.cycleBucket") && read("scripts/release/fba-plan-golive.mjs").includes("cycleBucket: bootstrapCycleBucket")
    && bootstrapMod.includes("expectedProvenance") && bootstrapMod.includes("cycle-mismatch") && bootstrapMod.includes("operation-mismatch")
    && read("scripts/release/verify-bootstrap-published.mjs").includes("expectedProvenance") && read("scripts/release/verify-bootstrap-published.mjs").includes("getBaseSyncCycleByBucketDate"));

  // ---- Round-9 SOURCE GUARDS: write-boundary fencing wired end-to-end ----
  ok("E(round-9, P0-A): the FENCED CAS RPC checks the lease fence (owner+generation+unexpired) THEN delegates to the atomic cas_report_snapshot_if_newer -- all in ONE transaction; a mismatch is 'lease-lost' with zero writes",
    sql.includes("function public.cas_report_snapshot_if_newer_fenced") && sql.includes("return public.cas_report_snapshot_if_newer(")
    && /generation-superseded/.test(sql) && /'lease-lost', 'reason', 'expired'/.test(sql));
  ok("E(round-9, P0-A + property 5): supabase.js has the fenced live wrapper; the publisher composition makes a CONTROL-ENABLED publisher route the FENCED CAS and FAIL CLOSED (lease-lost) when no live fence is supplied",
    read("lib/server/supabase.js").includes("publishLiveSnapshotFencedIfNewer") && read("lib/server/supabase.js").includes("cas_report_snapshot_if_newer_fenced")
    && read("lib/server/sync/publisher-composition.js").includes("getControlFence") && read("lib/server/sync/publisher-composition.js").includes("fencedPublishLive")
    && /outcome:\s*"lease-lost",\s*reason:\s*"no-fence"/.test(read("lib/server/sync/publisher-composition.js")));
  ok("E(round-9, P0-A): the publisher maps 'lease-lost' to a typed disposition; advanceFbaPlanBucket stops on a per-account 'lease-lost' (write-boundary, property 6); the FBA + priority releases build the publisher WITH getControlFence",
    read("lib/server/sync/report-publisher.js").includes('"lease-lost"') && /"lease-lost":\s*"lease-lost"/.test(read("lib/server/sync/report-publisher.js"))
    && /disp === "lease-lost"/.test(read("lib/server/sync/fba-plan-operation.js"))
    && read("lib/server/sync/fba-plan-release-composition.js").includes("makePublisher({ getControlFence:")
    && read("lib/server/sync/source-priority-dashboards.js").includes("getControlFence"));
  ok("E(round-9, P0-B, property 7): BOTH the priority runner AND runReleaseSlice stop on a write-boundary 'lease-lost' with typed CONTROL_LEASE_LOST contention; the route builds the priority release WITH getControlFence",
    /disposition === "lease-lost"/.test(read("lib/server/sync/source-priority-release-runner.js")) && read("lib/server/sync/source-priority-release-runner.js").includes("CONTROL_LEASE_LOST")
    && /disposition\) === "lease-lost"/.test(read("lib/server/sync/source-sync-operation.js")) && read("lib/server/sync/source-sync-operation.js").includes("CONTROL_LEASE_LOST")
    && read("api/admin/sources.js").includes("getControlFence: () => priorityFence"));
  ok("E(round-9/11/12, P1-C): release requires BOTH owner_token AND generation; the close verifies ownership ATOMICALLY via store.lockAndVerifyControlLease(owner, ownerGeneration) with NO non-locking fallback; every close passes the captured generation",
    sql.includes("release_control_plane_lease(\n  p_owner_token text,\n  p_generation bigint\n)") && /generation-superseded/.test(sql)
    && read("lib/server/sync/source-priority-control-package.js").includes("ownerGeneration") && read("lib/server/sync/source-priority-control-package.js").includes("store.lockAndVerifyControlLease(owner, ownerGeneration)")
    && !/verifyOwner\s*=/.test(read("lib/server/sync/source-priority-control-package.js")) // Round-12: the assert-fallback verifier is GONE
    && read("lib/server/sync/priority-control-pg-store.js").includes("release_control_plane_lease($1, $2::bigint)")
    && read("lib/server/sync/fba-plan-release-composition.js").includes("ownerGeneration: leaseFence ? leaseFence.generation : null"));
  ok("E(round-9, P1-C, property 9): the generation is THREADED explicitly (never inferred) -- --apply EMITS it, --rollback consumes --owner-generation, and the workflow passes the matching apply's generation into safe-close",
    read("scripts/release/priority-control-package.mjs").includes("--owner-generation=") && read("scripts/release/priority-control-package.mjs").includes("CONTROL_LEASE_GENERATION=")
    && ymlSrc.includes("--owner-generation=${{ steps.full_controls.outputs.generation || steps.bootstrap_controls.outputs.generation }}"));
  ok("E(round-9, P1-D): the admin route maps CONTROL_LEASE_HELD/LOST to a TYPED RETRYABLE 409/423 (never a generic 500)",
    /res\.status\(409\)[\s\S]{0,120}CONTROL_LEASE_LOST/.test(read("api/admin/sources.js")) && /res\.status\(423\)[\s\S]{0,120}CONTROL_LEASE_HELD/.test(read("api/admin/sources.js")));

  // ---- Round-10 SOURCE GUARDS: the fence generation is MANDATORY everywhere; the Gate-7 publisher is always fenced ----
  ok("E(round-10, blocker 1): the SQL renew/release/fenced-CAS reject a NULL/<=0 generation and use EXACT equality (never `is not null and`)",
    (sql.match(/p_generation is null or p_generation <= 0/g) || []).length >= 3
    && !/p_generation is not null and/.test(sql)
    && /v_row\.generation <> p_generation/.test(sql) && /v_lease\.generation <> p_generation/.test(sql));
  ok("E(round-10, blocker 1): the pg store's renew/release/assert wrappers REJECT an invalid generation (positive safe integer) BEFORE SQL",
    (read("lib/server/sync/priority-control-pg-store.js").match(/Number\.isSafeInteger\(generation\) && generation > 0/g) || []).length >= 3);
  ok("E(round-10, blocker 2+3): runControlPackageTransaction rejects a rollback without a valid ownerGeneration BEFORE BEGIN, and fails closed if acquire returns no valid generation",
    ctlPkg.includes("rollback requires a valid ownerGeneration") && /Number\.isSafeInteger\(g\) && g > 0/.test(ctlPkg) && ctlPkg.includes("CONTROL_LEASE_NO_GENERATION"));
  ok("E(round-10, blocker 5): buildSchedulerV2Publisher is ALWAYS fenced -- publishLive is fencedPublishLive (no unfenced branch); an invalid/missing fence => lease-lost",
    /publishLive:\s*fencedPublishLive,/.test(read("lib/server/sync/publisher-composition.js")) && !/controlEnabled \? fencedPublishLive : publishLive/.test(read("lib/server/sync/publisher-composition.js"))
    && /!validGen\(fence\.generation\)/.test(read("lib/server/sync/publisher-composition.js")));
  ok("E(round-10, blocker 5): priority-dashboards-release.mjs REQUIRES --run-token for publication; the priority release always threads getControlFence to the publisher",
    read("scripts/release/priority-dashboards-release.mjs").includes("STOP --run-token is REQUIRED for publication")
    && read("lib/server/sync/source-priority-dashboards.js").includes("buildPublisher({ getControlFence })"));
  ok("E(round-10, blocker 6): route/manual/FBA control apply require a VALID returned generation IMMEDIATELY (fail closed at apply, not at the first write)",
    read("api/admin/sources.js").includes("CONTROL_LEASE_NO_GENERATION") && read("scripts/release/manual-source-sync.mjs").includes("no valid fencing generation")
    && read("lib/server/sync/fba-plan-release-composition.js").includes("did not return a valid fencing generation"));
  ok("E(round-10, blocker 4): --apply EMITS a valid generation (GITHUB_OUTPUT failure is FATAL); the workflow safe-close runs ONLY when a matching apply emitted a non-blank generation",
    /could not write the apply generation to GITHUB_OUTPUT[\s\S]{0,220}process\.exit\(1\)/.test(read("scripts/release/priority-control-package.mjs"))
    && ymlSrc.includes("(steps.full_controls.outputs.generation != '' || steps.bootstrap_controls.outputs.generation != '')"));

  // Wave plan + authorize emit/validate stepPlanHash + region; append-only budget.
  const wavePlan = read("scripts/release/onboarding-wave-plan.mjs");
  ok("E: the wave planner emits per-region plans with stepPlanHash entries + a catalog step",
    wavePlan.includes("buildOnboardingStepEntry") && wavePlan.includes('step: "catalog"') && wavePlan.includes("ONBOARDING_REGIONS") && wavePlan.includes("computeOnboardingWaveIdentity(onboardingRows, region)"));
  const authorize = read("scripts/release/authorize-onboarding-budget.mjs");
  ok("E: the authorize operator requires --region, re-derives each step plan hash, and stores region + approved_plan",
    authorize.includes("--region") && authorize.includes("onboardingStepPlanHash") && authorize.includes("region: regionArg") && authorize.includes("stepPlanHash"));

  // Workflow: --dispatch-id on every bootstrap step; scoped publication; completion-gated ack.
  const yml = read("../.github/workflows/scheduler-v2.yml");
  ok("E: every bootstrap paid step receives --dispatch-id",
    (yml.match(/--dispatch-id=\$\{\{ inputs\.dispatch_id \}\}/g) || []).length >= 4);
  ok("E(regression 4): the workflow bootstrap path calls the SCOPED publication (not the full-region release)",
    yml.includes("bootstrap-publish.mjs --region=${{ steps.cfg.outputs.region }} --dispatch-id=${{ inputs.dispatch_id }}")
    && yml.includes("priority-control-package.mjs --apply --bucket=${{ steps.cfg.outputs.region }} --account-scope=bootstrap --dispatch-id=${{ inputs.dispatch_id }}"));
  ok("E(regression 5): 'completed' is acked ONLY after the read-only completion proof passes",
    yml.includes("verify-bootstrap-published.mjs") && yml.includes("steps.verify_published.outcome }}\" = \"success\"") && yml.includes("--phase=completed"));
  ok("E(regression 9): the natural full-region path is gated scope != 'bootstrap' (byte-identical natural behavior)",
    yml.includes("steps.cfg.outputs.scope != 'bootstrap'") && yml.includes("priority-dashboards-release.mjs"));
  ok("E(round-5, regression 8): both full-region materializers are SKIPPED in bootstrap (zero outside-wave writes)",
    (yml.match(/needs\.run\.outputs\.scope != 'bootstrap'/g) || []).length >= 2);
  ok("E(round-5, stale-ack): every bootstrap ack carries --run-token (running + completed + failed)",
    (yml.match(/--run-token=\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/g) || []).length >= 3);
})();

/* ===================== F. ROUND-5 functional regressions (real functions, not string-only) ===================== */
(() => {
  // --- Two waves, same region/date: DISTINCT wave-bound cycles (independent). ---
  const rowsA = [row("a1", ONBOARDING_STATUS.BOOTSTRAPPING)];
  const rowsB = [row("b1", ONBOARDING_STATUS.BOOTSTRAPPING)];
  const wA = computeOnboardingWaveIdentity(rowsA, "india");
  const wB = computeOnboardingWaveIdentity(rowsB, "india");
  const bucketA = bootstrapCycleBucket("india", dispatchMembershipHash(wA.dispatchId));
  const bucketB = bootstrapCycleBucket("india", dispatchMembershipHash(wB.dispatchId));
  ok("F(regression 1): two distinct same-region/same-day waves get DISTINCT wave-bound cycle buckets (neither can adopt/block the other)",
    bucketA !== bucketB && /^bootstrap-india-[0-9a-f]{16}$/.test(bucketA) && /^bootstrap-india-[0-9a-f]{16}$/.test(bucketB));
  ok("F(regression 2): a RETRY of the SAME dispatch reuses ITS OWN cycle bucket (stable); a different dispatch never reuses it",
    bootstrapCycleBucket("india", dispatchMembershipHash(wA.dispatchId)) === bucketA && bucketA !== bucketB);

  // --- Recompute detects modified runtime plan; excludes coverage counts (retry-stable). ---
  const base = { step: "oli", region: "india", accounts: ["a", "b"], operationIds: ["op-a", "op-b"], accountSetHash: bootstrapAccountSetHash(["a", "b"]), planAsOf: "2026-09-06", sourceKeys: ["order-line-items"], windows: [{ sourceKey: "order-line-items", from: "2025-01-01", to: "2026-09-06" }], batchMembership: [["a", "b"]] };
  const approvedEntry = { stepPlanHash: onboardingStepPlanHash(base) };
  ok("F(regression 4): assertBootstrapStepPlan ACCEPTS an unchanged runtime plan (recompute == approved)", assertBootstrapStepPlan(approvedEntry, base).ok === true && assertBootstrapStepPlan(approvedEntry, base).stepPlanHash === approvedEntry.stepPlanHash);
  ok("F(regression 4): a modified runtime BATCH is rejected (STEP_PLAN_DRIFT) before reservation", assertBootstrapStepPlan(approvedEntry, { ...base, batchMembership: [["a"], ["b"]] }).reason === "STEP_PLAN_DRIFT");
  ok("F(regression 4): a modified runtime DATE is rejected", assertBootstrapStepPlan(approvedEntry, { ...base, planAsOf: "2026-09-09", windows: [{ sourceKey: "order-line-items", from: "2025-01-01", to: "2026-09-09" }] }).reason === "STEP_PLAN_DRIFT");
  ok("F(regression 4): a modified runtime ACCOUNT set is rejected", assertBootstrapStepPlan(approvedEntry, { ...base, accounts: ["a", "c"], accountSetHash: bootstrapAccountSetHash(["a", "c"]) }).reason === "STEP_PLAN_DRIFT");
  ok("F: the step hash EXCLUDES coverage-dependent counts (a smaller retry never drifts)",
    onboardingStepPlanHash({ ...base, plannedCreates: 3, plannedTokens: 6 }) === onboardingStepPlanHash({ ...base, plannedCreates: 1, plannedTokens: 2 }));

  // --- fbaSellerBatches: stable seller grouping from an FBA plan (shared by planner + operator). ---
  const fbaPlan = { reportRequests: [{ sources: [{ requestKey: "fba-inventory-health", sellerOrVendorIds: ["s2", "s1"] }, { requestKey: "product-catalog", sellerOrVendorIds: ["s9"] }] }] };
  ok("F: fbaSellerBatches extracts ONLY sorted fba-inventory seller groups (catalog/other excluded)",
    JSON.stringify(fbaSellerBatchesFn(fbaPlan)) === JSON.stringify([["s1", "s2"]]));
})();

/* ===================== H. ROUND-7 completion proof: EXACT wave-produced identity + PROVENANCE via the
   publication MANIFEST (blockers 2 + 3 + 7). Completion re-reads each live snapshot by the EXACT (report_key,
   account, params_hash) the wave RECORDED -- never the newest -- and proves: a real durable cycle_id (never a
   bucket label), the ACTIVE run_token (a superseded attempt fails), manifest coversAsOf == approved D-1, live
   provenance, exact coversAsOf, and a valid+available payload. fba-plan is a FIRST-CLASS required report (its
   empty-inventory snapshot is a valid published identity -- there is NO typed-unavailable path). Every failure
   mode is a distinct, named regression. ==== */
await (async () => {
  const D1 = "2026-09-08";
  const RUN = "run-active-1";
  const liveContracts = {
    "daily-reporting": { liveReportKey: "daily-reporting", liveReportVersion: "daily-reporting-shared-v2" },
    "brand-sales": { liveReportKey: "brand-sales", liveReportVersion: "brand-sales-shared-v1" },
    "brand-inventory": { liveReportKey: "brand-inventory", liveReportVersion: "brand-inventory-shared-v1" },
    "fba-plan": { liveReportKey: "fba-plan", liveReportVersion: "fba-plan-shared-v1" },
  };
  const reportDerivations = Object.fromEntries(Object.keys(liveContracts).map((k) => [k, { validatePayload: (p) => !!p && p.ok === true }]));
  const REPORTS = ["daily-reporting", "brand-sales", "brand-inventory", "fba-plan"];
  const ph = (liveKey, a) => `PH-${liveKey}-${a}`;
  const mkLive = (liveKey, a, hash, over = {}) => ({
    report_key: liveKey, account_id: a, params_hash: hash,
    params: { reportVersion: liveContracts[liveKey] ? liveContracts[liveKey].liveReportVersion : "v", to: D1 },
    source_refreshed_at: "2026-09-09T00:00:00Z", payload: { ok: true }, ...over,
  });
  // Build a fully-published wave: the MANIFEST (exact identities + PROVENANCE: real cycle_id + active run_token)
  // + a store keyed by (report_key|account|params_hash).
  const freshWave = (accounts) => {
    const manifest = []; const store = {};
    for (const a of accounts) for (const rk of REPORTS) {
      const c = liveContracts[rk]; const hash = ph(c.liveReportKey, a);
      manifest.push({ account_id: a, report_key: c.liveReportKey, params_hash: hash, covers_asof: D1, cycle_id: "cyc-real-" + a, operation_key: "op-" + rk, run_token: RUN });
      store[`${c.liveReportKey}|${a}|${hash}`] = mkLive(c.liveReportKey, a, hash);
    }
    return { manifest, store };
  };
  const reader = (store) => async ({ reportKey, accountId, paramsHash }) => store[`${reportKey}|${accountId}|${paramsHash}`] || null;
  const verify = (over) => verifyBootstrapCompletion({ planAsOf: D1, inventoryAsOf: D1, expectedRunToken: RUN, hydrate: async () => null, liveContracts, reportDerivations, ...over });

  // FRESH: a matching manifest + exact-identity live snapshots at D-1 -> COMPLETE.
  { const { manifest, store } = freshWave(["a1"]);
    const r = await verify({ frozenAccountIds: ["a1"], publicationRows: manifest, readByIdentity: reader(store) });
    ok("H: a wave with a matching MANIFEST + exact-identity live snapshots at D-1 is COMPLETE", r.ok === true); }

  // EMPTY scope is never a completion.
  { const r = await verify({ frozenAccountIds: [], publicationRows: [], readByIdentity: reader({}) });
    ok("H: an EMPTY wave scope is NEVER a successful completion (EMPTY_WAVE_SCOPE)", r.ok === false && r.problems.includes("EMPTY_WAVE_SCOPE")); }

  // MISSING manifest entry -> no-manifest-entry (presence / newest never substitutes).
  { const w = freshWave(["a1"]); const man = w.manifest.filter((m) => m.report_key !== "daily-reporting");
    const r = await verify({ frozenAccountIds: ["a1"], publicationRows: man, readByIdentity: reader(w.store) });
    ok("H(blocker 7): a MISSING manifest entry fails (no-manifest-entry) -- newest-snapshot fallback is gone",
      r.ok === false && r.problems.some((p) => p.includes("daily-reporting(no-manifest-entry)"))); }

  // Manifest coversAsOf < approved D-1 -> manifest-stale-coversAsOf (a wave that recorded a stale date is caught).
  { const w = freshWave(["a1"]); for (const m of w.manifest) if (m.report_key === "daily-reporting") m.covers_asof = "2026-09-05";
    const r = await verify({ frozenAccountIds: ["a1"], publicationRows: w.manifest, readByIdentity: reader(w.store) });
    ok("H(blocker 7): a manifest whose recorded coversAsOf < approved D-1 fails (manifest-stale-coversAsOf)",
      r.ok === false && r.problems.some((p) => p.includes("manifest-stale-coversAsOf"))); }

  // Manifest points at a NON-EXISTENT exact identity (foreign/stale hash) -> no-live-snapshot-at-identity.
  { const w = freshWave(["a1"]); for (const m of w.manifest) if (m.report_key === "brand-sales") m.params_hash = "PH-FOREIGN";
    const r = await verify({ frozenAccountIds: ["a1"], publicationRows: w.manifest, readByIdentity: reader(w.store) });
    ok("H(blocker 7): a manifest pointing at a NON-EXISTENT exact identity fails (no-live-snapshot-at-identity)",
      r.ok === false && r.problems.some((p) => p.includes("brand-sales(no-live-snapshot-at-identity)"))); }

  // A live row that does NOT echo the requested identity -> identity-mismatch.
  { const w = freshWave(["a1"]);
    const badReader = async ({ reportKey, accountId, paramsHash }) => {
      const r = w.store[`${reportKey}|${accountId}|${paramsHash}`];
      return r && reportKey === "brand-inventory" ? { ...r, params_hash: "OTHER" } : (r || null);
    };
    const r = await verify({ frozenAccountIds: ["a1"], publicationRows: w.manifest, readByIdentity: badReader });
    ok("H(blocker 7): a live row that does not ECHO the requested (report_key, account, params_hash) fails (identity-mismatch)",
      r.ok === false && r.problems.some((p) => p.includes("brand-inventory(identity-mismatch)"))); }

  // Wrong live provenance (reportVersion) -> live-version.
  { const w = freshWave(["a1"]); w.store[`daily-reporting|a1|${ph("daily-reporting", "a1")}`].params.reportVersion = "WRONG";
    const r = await verify({ frozenAccountIds: ["a1"], publicationRows: w.manifest, readByIdentity: reader(w.store) });
    ok("H(blocker 7): a live snapshot whose reportVersion != the live contract fails (live-version provenance)",
      r.ok === false && r.problems.some((p) => p.includes("daily-reporting(live-version)"))); }

  // Live params.to < D-1 even though the manifest coversAsOf == D-1 -> stale-coversAsOf.
  { const w = freshWave(["a1"]); w.store[`brand-sales|a1|${ph("brand-sales", "a1")}`].params.to = "2026-09-05";
    const r = await verify({ frozenAccountIds: ["a1"], publicationRows: w.manifest, readByIdentity: reader(w.store) });
    ok("H(blocker 7): a live snapshot whose params.to < approved D-1 fails (stale-coversAsOf) even with a D-1 manifest",
      r.ok === false && r.problems.some((p) => p.includes("brand-sales(stale-coversAsOf)"))); }

  // Self-declared-unavailable / invalid payload -> payload-contract.
  { const w = freshWave(["a1"]); w.store[`brand-inventory|a1|${ph("brand-inventory", "a1")}`].payload = { dataUnavailable: true };
    const r = await verify({ frozenAccountIds: ["a1"], publicationRows: w.manifest, readByIdentity: reader(w.store) });
    ok("H(blocker 7): a self-declared-unavailable payload fails the completion contract (payload-contract)",
      r.ok === false && r.problems.some((p) => p.includes("brand-inventory(payload-contract)"))); }

  // FBA (blocker 3): fba-plan is a FIRST-CLASS required report -- a MISSING fba-plan manifest FAILS exactly like
  // the others (its empty-inventory snapshot would be a VALID published identity). There is NO typed-unavailable
  // fallback (the fresh wave already proves the present-fba-plan case COMPLETES).
  { const w = freshWave(["a1"]); const manNoFba = w.manifest.filter((m) => m.report_key !== "fba-plan");
    const r = await verify({ frozenAccountIds: ["a1"], publicationRows: manNoFba, readByIdentity: reader(w.store) });
    ok("H(blocker 3): a MISSING fba-plan manifest FAILS (no-manifest-entry) -- fba-plan is required, no typed-unavailable fallback",
      r.ok === false && r.problems.some((p) => p.includes("fba-plan(no-manifest-entry)")) && !r.problems.some((p) => p.includes("no-typed-unavailable"))); }

  // Blocker 2 PROVENANCE: a BLANK cycle_id -> no-cycle-provenance.
  { const w = freshWave(["a1"]); for (const m of w.manifest) if (m.report_key === "fba-plan") m.cycle_id = "";
    const r = await verify({ frozenAccountIds: ["a1"], publicationRows: w.manifest, readByIdentity: reader(w.store) });
    ok("H(blocker 2): a manifest row with a BLANK cycle_id fails (no-cycle-provenance)",
      r.ok === false && r.problems.some((p) => p.includes("fba-plan(no-cycle-provenance)"))); }

  // Blocker 2 PROVENANCE: a bucket-LABEL cycle_id -> cycle-is-bucket-label (never store a bucket in cycle_id).
  { const w = freshWave(["a1"]); for (const m of w.manifest) if (m.report_key === "fba-plan") m.cycle_id = "bootstrap-fba-india-0123456789abcdef";
    const r = await verify({ frozenAccountIds: ["a1"], publicationRows: w.manifest, readByIdentity: reader(w.store) });
    ok("H(blocker 2): a manifest cycle_id that is a BUCKET LABEL fails (cycle-is-bucket-label)",
      r.ok === false && r.problems.some((p) => p.includes("fba-plan(cycle-is-bucket-label)"))); }

  // Blocker 2 PROVENANCE: a manifest written by a SUPERSEDED attempt (run_token != active) can NEVER complete.
  { const w = freshWave(["a1"]); for (const m of w.manifest) if (m.report_key === "daily-reporting") m.run_token = "run-OLD";
    const r = await verify({ frozenAccountIds: ["a1"], publicationRows: w.manifest, readByIdentity: reader(w.store) });
    ok("H(blocker 2): a manifest row from a SUPERSEDED attempt (run_token != active) fails (superseded-attempt)",
      r.ok === false && r.problems.some((p) => p.includes("daily-reporting(superseded-attempt)"))); }

  // Blocker 2: when NO expectedRunToken is supplied (e.g. a read-only audit), provenance still requires a real
  // cycle id but does not compare the run token -- a fresh wave still COMPLETES.
  { const w = freshWave(["a1"]);
    const r = await verifyBootstrapCompletion({ frozenAccountIds: ["a1"], planAsOf: D1, inventoryAsOf: D1, publicationRows: w.manifest, expectedRunToken: "", hydrate: async () => null, liveContracts, reportDerivations, readByIdentity: reader(w.store) });
    ok("H(blocker 2): with no expectedRunToken the run-token compare is skipped but a real cycle id is still required (fresh wave COMPLETES)", r.ok === true); }

  // Completion requires EVERY frozen account: one account short keeps the wave incomplete (a deferred account never completes).
  { const w = freshWave(["a1", "a2"]); const man = w.manifest.filter((m) => !(m.account_id === "a2" && m.report_key === "brand-sales"));
    const r = await verify({ frozenAccountIds: ["a1", "a2"], publicationRows: man, readByIdentity: reader(w.store) });
    ok("H: completion requires EVERY frozen account -- a2 short one report keeps the wave incomplete (a1 clean)",
      r.ok === false && r.problems.some((p) => p.startsWith("a2:brand-sales")) && !r.problems.some((p) => p.startsWith("a1:"))); }

  // Round-8 blocker 3: EXACT per-report provenance. expectedProvenance = the resolved (cycleId, operationKey,
  // runToken) each report must carry. An arbitrary/foreign cycle or operation FAILS; the exact valid path COMPLETES.
  const expProv = () => ({
    "daily-reporting": { cycleId: "cyc-real-a1", operationKey: "op-daily-reporting", runToken: RUN },
    "brand-sales": { cycleId: "cyc-real-a1", operationKey: "op-brand-sales", runToken: RUN },
    "brand-inventory": { cycleId: "cyc-real-a1", operationKey: "op-brand-inventory", runToken: RUN },
    "fba-plan": { cycleId: "cyc-real-a1", operationKey: "op-fba-plan", runToken: RUN },
  });
  const verifyProv = (over) => verifyBootstrapCompletion({ frozenAccountIds: ["a1"], planAsOf: D1, inventoryAsOf: D1, expectedRunToken: RUN, expectedProvenance: expProv(), hydrate: async () => null, liveContracts, reportDerivations, ...over });
  { const w = freshWave(["a1"]);
    ok("H(blocker 3): the EXACT expected provenance (cycleId + operationKey + runToken) per report COMPLETES",
      (await verifyProv({ publicationRows: w.manifest, readByIdentity: reader(w.store) })).ok === true); }
  { const w = freshWave(["a1"]); for (const m of w.manifest) if (m.report_key === "brand-inventory") m.cycle_id = "cyc-FOREIGN";
    const r = await verifyProv({ publicationRows: w.manifest, readByIdentity: reader(w.store) });
    ok("H(blocker 3): a manifest cycle_id != the EXPECTED durable cycle fails (cycle-mismatch) -- arbitrary nonblank never passes",
      r.ok === false && r.problems.some((p) => p.includes("brand-inventory(cycle-mismatch)"))); }
  { const w = freshWave(["a1"]); for (const m of w.manifest) if (m.report_key === "fba-plan") m.operation_key = "op-WRONG";
    const r = await verifyProv({ publicationRows: w.manifest, readByIdentity: reader(w.store) });
    ok("H(blocker 3): a manifest operation_key != the EXPECTED operation fails (operation-mismatch)",
      r.ok === false && r.problems.some((p) => p.includes("fba-plan(operation-mismatch)"))); }
  { const w = freshWave(["a1"]);
    const r = await verifyProv({ publicationRows: w.manifest, readByIdentity: reader(w.store), expectedProvenance: { ...expProv(), "brand-sales": { cycleId: "cyc-real-a1", operationKey: "op-brand-sales", runToken: "run-DIFFERENT" } } });
    ok("H(blocker 3): a manifest run_token != the EXPECTED run token fails (run-token-mismatch)",
      r.ok === false && r.problems.some((p) => p.includes("brand-sales(run-token-mismatch)"))); }
})();

/* ===================== I. ROUND-6/7 integration regressions against the REAL production compositions
   (buildFbaPlanRelease / advanceFbaPlanBucket / fbaPlanStructure / runControlPackageTransaction / fbaPlanPayload).
   Proves: the account-scope override cascades to runtime rollout + control discovery + ownership (leak closed)
   and natural mode is byte-identical; the wave-bound FBA cycle is used; per-account FBA honesty (strict partial
   vs LKG-tolerant natural; data-unavailable IS a failure); exact FBA plan-structure binding; the CONTROL-PLANE
   OWNER LEASE serializes concurrent operations (real interleaving, stale-owner close refused); and the FBA
   unavailable CONTRACT via the real derivation. ==== */
await (async () => {
  // --- Blocker 1: accountScopeIds scopes runtime rollout + control discovery + ownership; natural mode untouched. ---
  const stubRuntime = { run: async () => ({}), store: {} };
  const relCommon = {
    getConnections: () => [{ id: "primary", apiKey: "x" }],
    makePublisher: () => ({ preflight: async () => ({}), publish: async () => ({}) }),
  };
  let controlDiscoveryIds = null, runtimeRollout = null;
  const scoped = buildFbaPlanRelease({
    ...relCommon, operator: "op", accountScopeIds: ["FROZEN-1", "FROZEN-2"],
    runControlPackage: async ({ discoverAccounts }) => { if (discoverAccounts) controlDiscoveryIds = await discoverAccounts(); return { committed: true, code: 0 }; },
    discoverAccounts: async () => ["FULL-a", "FULL-b"], // the full-region discovery -- must NOT reach fetch/control/ownership
    makeRuntime: async (opts) => { runtimeRollout = opts && opts.getAccountRollout ? await opts.getAccountRollout() : null; return stubRuntime; },
  });
  await scoped.controls.apply();
  const runtimeRolloutIds = runtimeRollout ? runtimeRollout.enabledAccountIds : null;
  ok("I(blocker 1): accountScopeIds makes runtime rollout + control discovery EXACTLY the frozen set (no full-region leak)",
    JSON.stringify(controlDiscoveryIds) === JSON.stringify(["FROZEN-1", "FROZEN-2"]) && JSON.stringify(runtimeRolloutIds) === JSON.stringify(["FROZEN-1", "FROZEN-2"]));
  ok("I(blocker 1): the scoped runtime rollout is a fail-closed allowlist (read:ok, allPrimary:false, only the frozen ids enabled)",
    !!runtimeRollout && runtimeRollout.read === "ok" && runtimeRollout.allPrimary === false && JSON.stringify(runtimeRollout.enabledAccountIds) === JSON.stringify(["FROZEN-1", "FROZEN-2"]));

  let naturalOverride = false, naturalDiscovery = null;
  const natural = buildFbaPlanRelease({
    ...relCommon, operator: "op",
    runControlPackage: async ({ discoverAccounts }) => { if (discoverAccounts) naturalDiscovery = await discoverAccounts(); return { committed: true, code: 0 }; },
    discoverAccounts: async () => ["FULL-a", "FULL-b"],
    makeRuntime: (opts) => { naturalOverride = typeof (opts && opts.getAccountRollout) === "function"; return stubRuntime; },
  });
  await natural.controls.apply();
  ok("I(blocker 1): natural mode (no accountScopeIds) is byte-identical -- NO rollout override, discovery = full region",
    naturalOverride === false && JSON.stringify(naturalDiscovery) === JSON.stringify(["FULL-a", "FULL-b"]));

  // --- Blocker 2: the wave-bound FBA cycle bucket is used, never the natural <region>-fba terminal cycle. ---
  ok("I(blocker 2): bootstrapFbaCycleBucket is wave-bound and matches the reviewed -fba pattern",
    /^bootstrap-fba-india-[0-9a-f]{16}$/.test(bootstrapFbaCycleBucket("india", "0123456789abcdef")));
  {
    // The natural india-fba cycle is already terminal (would BLOCK a natural re-run). The bootstrap uses a
    // DIFFERENT, wave-bound bucket, so it opens/finalizes its OWN dedicated cycle and never touches india-fba.
    const bootBucket = bootstrapFbaCycleBucket("india", "0123456789abcdef");
    let getBucketSeen = null, runBucketSeen = null, finalized = false;
    const runtime = {
      run: async ({ cycleBucket } = {}) => { runBucketSeen = cycleBucket; return { cycleId: "cyc-boot", drained: true }; },
      store: {
        // Non-terminal (null) until THIS operation finalizes its own dedicated cycle -> proves fetch actually ran
        // under the override bucket (a terminal natural india-fba cycle could never satisfy this).
        getCycleByBucketDate: async (cb) => { getBucketSeen = cb; return finalized ? { id: "cyc-boot", status: "succeeded" } : null; },
        finalizeCycle: async ({ cycleId }) => { finalized = true; return { disposition: "finalized", cycle: { id: cycleId, status: "succeeded" } }; },
      },
    };
    const res = await advanceFbaPlanBucket({ bucket: "india", asOf: D_1(), inventoryAsOf: D_1(), includedIds: ["ok-1"],
      bucketAccounts: [{ accountId: "ok-1", country: "IN" }], cost: { tokens: 2, creates: 1, sourceJobs: 1, plan: { sourceJobs: [1] } }, maxTokens: 90,
      runtime, publisher: { preflight: async () => ({ disposition: "ready" }), publish: async () => ({ disposition: "published", liveReportKey: "fba-plan", paramsHash: "h" }) },
      controls: { apply: async () => {}, close: async () => {} }, readbackLive: async () => ({ ok: true }),
      cycleBucketOverride: bootBucket, strict: true });
    ok("I(blocker 2): with cycleBucketOverride the FETCH + durable cycle lookup use the BOOTSTRAP bucket (never the natural india-fba)",
      runBucketSeen === bootBucket && getBucketSeen === bootBucket && bootBucket !== "india-fba" && res.ok === true);
  }

  // --- Blocker 4: per-account FBA honesty. strict partial vs LKG-tolerant natural; data-unavailable != failure. ---
  const cyc = { id: "cyc-1", status: "succeeded" };
  const runtime = { run: async () => ({ cycleId: "cyc-1", drained: true }),
    store: { getCycleByBucketDate: async () => cyc, finalizeCycle: async () => ({ disposition: "already-terminal", cycle: cyc }) } };
  const controls = { apply: async () => {}, close: async () => {} };
  const two = [{ accountId: "ok-1", country: "IN" }, { accountId: "bad-1", country: "IN" }];
  const cost = { tokens: 2, creates: 1, sourceJobs: 1, plan: { sourceJobs: [1] } };
  const pubFail = { preflight: async () => ({ disposition: "ready" }), publish: async (_rk, a) => a === "ok-1" ? { disposition: "published", liveReportKey: "fba-plan", paramsHash: "h" } : { disposition: "not-successful" } };
  const strictRes = await advanceFbaPlanBucket({ bucket: "india", asOf: D_1(), inventoryAsOf: D_1(), includedIds: ["ok-1", "bad-1"], bucketAccounts: two, cost, maxTokens: 90, runtime, publisher: pubFail, controls, readbackLive: async () => ({ ok: true }), strict: true });
  ok("I(blocker 4): STRICT mode returns phase=partial ok=false when an included account FAILED to publish (never a false complete)",
    strictRes.phase === "partial" && strictRes.ok === false && Array.isArray(strictRes.failedAccounts) && strictRes.failedAccounts.includes("bad-1"));
  const natRes = await advanceFbaPlanBucket({ bucket: "india", asOf: D_1(), inventoryAsOf: D_1(), includedIds: ["ok-1", "bad-1"], bucketAccounts: two, cost, maxTokens: 90, runtime, publisher: pubFail, controls, readbackLive: async () => ({ ok: true }) });
  ok("I(blocker 4): natural (strict=false) FBA stays LKG-tolerant/byte-identical -- a per-account failure still completes",
    natRes.phase === "complete" && natRes.ok === true);
  // Blocker 3 HONESTY: an (unexpected) data-unavailable disposition for fba-plan is a FAILURE to retry (LKG
  // untouched) -- NEVER "permanently source-incapable". There is no perAccount.sourceIncapable ledger.
  const pubIncap = { preflight: async () => ({ disposition: "ready" }), publish: async (_rk, a) => a === "ok-1" ? { disposition: "published", liveReportKey: "fba-plan", paramsHash: "h" } : { disposition: "data-unavailable" } };
  const incapRes = await advanceFbaPlanBucket({ bucket: "india", asOf: D_1(), inventoryAsOf: D_1(), includedIds: ["ok-1", "nofba-1"], bucketAccounts: [{ accountId: "ok-1", country: "IN" }, { accountId: "nofba-1", country: "IN" }], cost, maxTokens: 90, runtime, publisher: pubIncap, controls, readbackLive: async () => ({ ok: true }), strict: true });
  ok("I(blocker 3): a data-unavailable disposition for fba-plan is treated as a FAILURE (strict -> partial), never a source-incapable success; NO sourceIncapable ledger exists",
    incapRes.phase === "partial" && incapRes.ok === false && incapRes.failedAccounts.includes("nofba-1") && incapRes.perAccount.sourceIncapable === undefined);

  // --- Blocker 6: exact FBA plan-structure binding (real fbaPlanStructure) -- never empty membership/hashes/limits. ---
  const plan = { reportRequests: [{ sources: [{ requestKey: "fba-plan:inventory-health", requestHash: "rh1", limit: 50000, sellerOrVendorIds: ["s2", "s1"], marketplacePairs: [{ sellerId: "s1", marketplace: "IN" }] }] }] };
  const st = fbaPlanStructure(plan, D_1());
  ok("I(blocker 6): fbaPlanStructure binds sellers + marketplacePairs + defaultBatches + requestHashes + sourceKeys + rowLimits + inventoryAsOf + adaptiveSplitAllowed (never empty)",
    JSON.stringify(st.sellers) === JSON.stringify(["s1", "s2"]) && st.marketplacePairs.length === 1 && st.defaultBatches.length === 1
    && st.requestHashes.join() === "rh1" && st.sourceKeys.join() === "fba-plan:inventory-health" && st.rowLimits.join() === "50000"
    && st.inventoryAsOf === D_1() && st.adaptiveSplitAllowed === true);

  // --- Blocker 1 CONTROL-PLANE LEASE: a DETERMINISTIC INTERLEAVING against the REAL runControlPackageTransaction
  //     with a lease-capable shared store (models the DB CAS). A apply -> B apply -> A check -> A close -> B.
  //     Proves concurrent regional operations cannot overwrite/close each other's controls, a stale/foreign
  //     safe-close never closes an owner's controls, idempotent owner replay, and fail-closed without a token. ---
  {
    const OP = "op@upriver.test";
    const db = { rollout: new Map(), dispatch: new Map(), promoted: new Map(), approvals: new Map(), lease: { owner: "", gen: 0, exp: 0 } };
    let snap = null; const now = () => Date.now();
    const store = {
      begin: async () => { snap = { rollout: new Map(db.rollout), dispatch: new Map(db.dispatch), promoted: new Map(db.promoted), approvals: new Map(db.approvals), lease: { ...db.lease } }; },
      commit: async () => { snap = null; },
      rollback: async () => { if (snap) { Object.assign(db, snap); snap = null; } },
      readAllPrimary: async () => false, hasCron: async () => false,
      setRolloutEnabled: async (ids) => { for (const a of ids) db.rollout.set(a, true); for (const a of [...db.rollout.keys()]) if (!ids.includes(a)) db.rollout.set(a, false); },
      disableAllRollout: async () => { for (const a of [...db.rollout.keys()]) db.rollout.set(a, false); },
      setDispatchEnabled: async (keys, controlled) => { for (const rk of controlled) db.dispatch.set(rk, keys.includes(rk)); },
      pauseAllDispatch: async (controlled) => { for (const rk of controlled) db.dispatch.set(rk, false); },
      setPromotedEnabled: async (keys) => { for (const rk of keys) db.promoted.set(rk, true); for (const rk of [...db.promoted.keys()]) if (!keys.includes(rk)) db.promoted.set(rk, false); },
      disableAllPromoted: async () => { for (const rk of [...db.promoted.keys()]) db.promoted.set(rk, false); },
      setApprovalsApproved: async (pairs) => { for (const p of pairs) db.approvals.set(p, true); for (const p of [...db.approvals.keys()]) if (!pairs.includes(p)) db.approvals.set(p, false); },
      revokeAllApprovals: async () => { for (const p of [...db.approvals.keys()]) db.approvals.set(p, false); },
      rolloutRows: async () => [...db.rollout].map(([account_id, enabled]) => ({ account_id, enabled })),
      dispatchRows: async () => [...db.dispatch].map(([report_key, schedule_enabled]) => ({ report_key, schedule_enabled })),
      promotedRows: async () => [...db.promoted].map(([report_key, publish_enabled]) => ({ report_key, publish_enabled })),
      approvalRows: async () => [...db.approvals].map((e) => { const [report_key, account_id] = e[0].split("|"); return { report_key, account_id, approved: e[1] }; }),
      // Round-10: acquire returns the (bumped/kept) generation; release/assert require owner AND generation.
      // Round-12: the COMPLETE coherent lease interface (renew + the atomic lockAndVerify) is mandatory.
      acquireControlLease: async (token, opKey, ttl) => { const free = !db.lease.owner || db.lease.exp <= now(); if (free || db.lease.owner === token) { const same = db.lease.owner === token && !free; db.lease = { owner: token, gen: same ? db.lease.gen : db.lease.gen + 1, exp: now() + (ttl || 900) * 1000 }; return { disposition: "acquired", generation: db.lease.gen }; } return { disposition: "held", owner_token: db.lease.owner }; },
      renewControlLease: async (token, gen, ttl) => { if (!(Number.isSafeInteger(gen) && gen > 0) || db.lease.owner !== token || db.lease.gen !== gen || db.lease.exp <= now()) return { disposition: "lost" }; db.lease.exp = now() + (ttl || 900) * 1000; return { disposition: "renewed", generation: db.lease.gen }; },
      releaseControlLease: async (token, gen) => { if (db.lease.owner === token && db.lease.exp > now() && db.lease.gen === gen) { db.lease = { owner: "", gen: db.lease.gen, exp: 0 }; return { disposition: "released" }; } return { disposition: "not-owner" }; },
      assertControlLeaseOwner: async (token, gen) => db.lease.owner === token && db.lease.exp > now() && db.lease.gen === gen,
      // ATOMIC lock model (single-threaded fake): verifies EXACT owner + generation + unexpired (post-lock clock).
      lockAndVerifyControlLease: async (token, gen) => Number.isSafeInteger(gen) && gen > 0 && db.lease.owner === token && db.lease.exp > now() && db.lease.gen === gen,
    };
    const pkgA = buildFbaPlanControlPackage({ accounts: ["IN1", "IN2"], operator: OP });
    const pkgB = buildFbaPlanControlPackage({ accounts: ["EU1", "EU2"], operator: OP });
    const rolloutOn = async (a) => (await store.rolloutRows()).find((r) => r.account_id === a)?.enabled === true;
    const approvalOn = async (rk, a) => (await store.approvalRows()).find((r) => r.report_key === rk && r.account_id === a)?.approved === true;
    const tx = (pkg, mode, ownerToken, ownerGeneration) => runControlPackageTransaction({ store, pkg, mode, ownerToken, ownerGeneration });

    const aApply = await tx(pkgA, "apply", "run-A");
    const bApply = await tx(pkgB, "apply", "run-B");
    ok("I(blocker 1): A holds the lease; a concurrent B.apply is REFUSED (CONTROL_LEASE_HELD) with ZERO writes -- A's controls are intact",
      aApply.committed === true && bApply.committed === false && /CONTROL_LEASE_HELD/.test(String(bApply.problem)) && (await rolloutOn("IN1")) === true && (await approvalOn("fba-plan", "IN1")) === true && (await rolloutOn("EU1")) === false);
    const aClose = await tx(buildPrioritySafeClosePackage({ operator: OP }), "rollback", "run-A", aApply.leaseGeneration);
    ok("I(blocker 1): A.close (the owner) safe-closes + RELEASES the lease", aClose.committed === true && (await rolloutOn("IN1")) === false);
    const bApply2 = await tx(pkgB, "apply", "run-B");
    ok("I(blocker 1): after A releases, B can now acquire + apply + publish its OWN accounts",
      bApply2.committed === true && (await rolloutOn("EU1")) === true && (await approvalOn("fba-plan", "EU1")) === true);
    const foreignClose = await tx(buildPrioritySafeClosePackage({ operator: OP }), "rollback", "run-STALE", 99);
    ok("I(blocker 1): a STALE/foreign safe-close (not the lease owner) NEVER closes B's controls (TYPED NON-SUCCESS skip: lease-not-owner)",
      foreignClose.committed === false && foreignClose.skipped === "lease-not-owner" && foreignClose.leaseNotOwner === true && (await rolloutOn("EU1")) === true);
    const bReplay = await tx(pkgB, "apply", "run-B");
    ok("I(blocker 1): idempotent owner replay -- the SAME owner re-acquires/renews with no error (controls unchanged)",
      bReplay.committed === true && (await rolloutOn("EU1")) === true);
    let threw = false;
    try { await runControlPackageTransaction({ store, pkg: pkgA, mode: "apply", ownerToken: "" }); } catch { threw = true; }
    ok("I(blocker 1): fail-closed -- a lease-capable store REQUIRES an ownerToken (no un-leased global reconcile/safe-close)", threw === true);
    // Round-10 (blocker 3): a rollback WITHOUT a valid ownerGeneration is REJECTED before BEGIN (no owner-only close).
    for (const badGen of [undefined, null, 0, -1, 1.5, NaN, "1"]) {
      let rejected = false;
      try { await tx(buildPrioritySafeClosePackage({ operator: OP }), "rollback", "run-B", badGen); } catch { rejected = true; }
      ok("I(round-10, blocker 3): a rollback with an INVALID ownerGeneration (" + String(badGen) + ") is REJECTED before BEGIN (no owner-only close)", rejected === true);
    }
  }

  // --- Blocker 3 FBA UNAVAILABLE CONTRACT via the REAL fbaPlanPayload derivation + the REAL derivation validator. ---
  {
    const inputs = (over) => ({ asOf: D_1(), accountName: "Acme", marketCountry: "IN", isUS: false, awdEligible: false, completed: [{ key: "2026-08", from: "2026-08-01", to: "2026-08-31" }], current: { key: "2026-09", from: "2026-09-01", to: D_1() }, completedUnitRows: [[]], mtdUnitRows: [], dailyDateRows: [], catalogRows: [], invRows: [], awdRows: [], ...over });
    const der = REPORT_DERIVATIONS["fba-plan"];
    const empty = fbaPlanPayload(inputs());
    ok("I(blocker 3): an EMPTY validated D-1 inventory is an HONEST VALID fba-plan snapshot (inventoryAvailable:false, no dataUnavailable) that PASSES the real validator (so it PUBLISHES + earns a manifest identity)",
      der.validatePayload(empty) === true && empty.inventoryAvailable === false && !("dataUnavailable" in empty));
    const withInv = fbaPlanPayload(inputs({ invRows: [{ date: D_1(), child_asin: "B01", sku: "SKU1", available: 12, marketplace_country_code: "IN", product_name: "X" }] }));
    ok("I(blocker 3): a NON-empty D-1 inventory is inventoryAvailable:true and valid (the same contract; empty vs present differ only in the flag)",
      der.validatePayload(withInv) === true && withInv.inventoryAvailable === true);
    // A publisher's data-unavailable disposition requires payload.dataUnavailable===true, which fba-plan NEVER sets:
    ok("I(blocker 3): fba-plan payloads NEVER carry dataUnavailable, so the publisher's data-unavailable disposition is unreachable for fba-plan (dead path correctly removed)",
      !("dataUnavailable" in empty) && !("dataUnavailable" in withInv));
  }

  // --- Round-8 blocker 1 PUBLICATION FENCING via the REAL advanceFbaPlanBucket publish loop. ---
  {
    const cyc = { id: "cyc-x", status: "succeeded" };
    const runtime = { run: async () => ({ cycleId: "cyc-x", drained: true }),
      store: { getCycleByBucketDate: async () => cyc, finalizeCycle: async () => ({ disposition: "already-terminal", cycle: cyc }) } };
    const controls = { apply: async () => {}, close: async () => {} };
    const eight = Array.from({ length: 8 }, (_, i) => ({ accountId: "a" + (i + 1), country: "IN" }));
    const ids8 = eight.map((a) => a.accountId);
    const cost = { tokens: 2, creates: 1, sourceJobs: 1, plan: { sourceJobs: [1] } };
    const mkPub = (log) => ({ preflight: async () => ({ disposition: "ready" }), publish: async (_rk, a) => { log.push(a); return { disposition: "published", liveReportKey: "fba-plan", paramsHash: "h" }; } });
    const run = (verifyLease, log) => advanceFbaPlanBucket({ bucket: "india", asOf: D_1(), inventoryAsOf: D_1(), includedIds: ids8, bucketAccounts: eight, cost, maxTokens: 90, runtime, publisher: mkPub(log), controls, readbackLive: async () => ({ ok: true }), strict: true, verifyLease });
    // fence LOST at the 2nd chunk: publish only chunk 1 (6), then STOP -> typed contention.
    { const log = []; let n = 0; const r = await run(async () => { n += 1; return n === 1 ? { ok: true } : { ok: false, reason: "expired" }; }, log);
      ok("I(round-8, blocker 1): a lease lost mid-publish stops immediately (typed contention, retryable) and publishes NOTHING further",
        r.phase === "contention" && r.ok === false && r.leaseLost === true && r.continuationRequired === true && log.length === 6); }
    // heartbeat OK before every chunk -> all publish.
    { const log = []; let calls = 0; const r = await run(async () => { calls += 1; return { ok: true }; }, log);
      ok("I(round-8, blocker 1): a heartbeat renewed before EACH chunk lets all publish (verifyLease called once per chunk)", r.ok === true && log.length === 8 && calls === 2); }
    // fence lost BEFORE the first chunk -> publish nothing.
    { const log = []; const r = await run(async () => ({ ok: false, reason: "owner-changed" }), log);
      ok("I(round-8, blocker 1): a lease lost before the first publish publishes NOTHING (LKG preserved)", r.phase === "contention" && log.length === 0); }
    // no verifyLease -> byte-identical natural behavior.
    { const log = []; const r = await advanceFbaPlanBucket({ bucket: "india", asOf: D_1(), inventoryAsOf: D_1(), includedIds: ids8, bucketAccounts: eight, cost, maxTokens: 90, runtime, publisher: mkPub(log), controls, readbackLive: async () => ({ ok: true }), strict: true });
      ok("I(round-8, blocker 1): no verifyLease => byte-identical natural behavior (all publish, no fencing)", r.ok === true && log.length === 8); }
  }

  // --- Round-8 blocker 1 RECLAIM + typed lease-not-owner via the REAL runControlPackageTransaction + a fence store. ---
  {
    const db = { rollout: new Map(), dispatch: new Map(), promoted: new Map(), approvals: new Map(), lease: { owner: "", gen: 0, exp: 0 } };
    let snap = null; const now = () => Date.now();
    const store = {
      begin: async () => { snap = { rollout: new Map(db.rollout), dispatch: new Map(db.dispatch), promoted: new Map(db.promoted), approvals: new Map(db.approvals), lease: { ...db.lease } }; },
      commit: async () => { snap = null; }, rollback: async () => { if (snap) { Object.assign(db, snap); snap = null; } },
      readAllPrimary: async () => false, hasCron: async () => false,
      setRolloutEnabled: async (ids) => { for (const a of ids) db.rollout.set(a, true); for (const a of [...db.rollout.keys()]) if (!ids.includes(a)) db.rollout.set(a, false); },
      disableAllRollout: async () => { for (const a of [...db.rollout.keys()]) db.rollout.set(a, false); },
      setDispatchEnabled: async (keys, c) => { for (const rk of c) db.dispatch.set(rk, keys.includes(rk)); },
      pauseAllDispatch: async (c) => { for (const rk of c) db.dispatch.set(rk, false); },
      setPromotedEnabled: async (keys) => { for (const rk of keys) db.promoted.set(rk, true); for (const rk of [...db.promoted.keys()]) if (!keys.includes(rk)) db.promoted.set(rk, false); },
      disableAllPromoted: async () => { for (const rk of [...db.promoted.keys()]) db.promoted.set(rk, false); },
      setApprovalsApproved: async (p) => { for (const x of p) db.approvals.set(x, true); for (const x of [...db.approvals.keys()]) if (!p.includes(x)) db.approvals.set(x, false); },
      revokeAllApprovals: async () => { for (const x of [...db.approvals.keys()]) db.approvals.set(x, false); },
      rolloutRows: async () => [...db.rollout].map(([account_id, enabled]) => ({ account_id, enabled })),
      dispatchRows: async () => [...db.dispatch].map(([report_key, schedule_enabled]) => ({ report_key, schedule_enabled })),
      promotedRows: async () => [...db.promoted].map(([report_key, publish_enabled]) => ({ report_key, publish_enabled })),
      approvalRows: async () => [...db.approvals].map((e) => { const [report_key, account_id] = e[0].split("|"); return { report_key, account_id, approved: e[1] }; }),
      acquireControlLease: async (t, k, ttl) => { const free = !db.lease.owner || db.lease.exp <= now(); if (free || db.lease.owner === t) { const same = db.lease.owner === t && !free; db.lease = { owner: t, gen: same ? db.lease.gen : db.lease.gen + 1, exp: now() + (ttl || 900) * 1000 }; return { disposition: "acquired", generation: db.lease.gen }; } return { disposition: "held", owner_token: db.lease.owner }; },
      renewControlLease: async (t, g, ttl) => { if (db.lease.owner !== t || db.lease.gen !== g || db.lease.exp <= now()) return { disposition: "lost" }; db.lease.exp = now() + (ttl || 900) * 1000; return { disposition: "renewed", generation: db.lease.gen }; },
      releaseControlLease: async (t, g) => { if (db.lease.owner === t && db.lease.exp > now() && db.lease.gen === g) { db.lease = { owner: "", gen: db.lease.gen, exp: 0 }; return { disposition: "released" }; } return { disposition: "not-owner" }; },
      assertControlLeaseOwner: async (t, g) => db.lease.owner === t && db.lease.exp > now() && db.lease.gen === g,
      lockAndVerifyControlLease: async (t, g) => Number.isSafeInteger(g) && g > 0 && db.lease.owner === t && db.lease.exp > now() && db.lease.gen === g, // Round-12: complete interface
    };
    const OP = "op@upriver.test";
    const apply = await runControlPackageTransaction({ store, pkg: buildFbaPlanControlPackage({ accounts: ["IN1"], operator: OP }), mode: "apply", ownerToken: "A" });
    ok("I(round-8, blocker 1): apply returns the fencing generation (>=1) for the publish heartbeat", apply.committed === true && Number(apply.leaseGeneration) >= 1);
    const foreign = await runControlPackageTransaction({ store, pkg: buildPrioritySafeClosePackage({ operator: OP }), mode: "rollback", ownerToken: "B", ownerGeneration: 1 });
    ok("I(round-8, blocker 2): a non-owner rollback is a TYPED NON-SUCCESS (committed:false, leaseNotOwner) -- never a committed safe-close",
      foreign.committed === false && foreign.skipped === "lease-not-owner" && foreign.leaseNotOwner === true);
    const held = await runControlPackageTransaction({ store, pkg: buildPrioritySafeClosePackage({ operator: OP }), mode: "reclaim", ownerToken: "R" });
    ok("I(round-8, blocker 1): reclaim REFUSES while a LIVE owner holds the lease (never closes a live owner's controls)",
      held.committed === false && /CONTROL_LEASE_HELD/.test(String(held.problem)) && (await store.rolloutRows()).find((r) => r.account_id === "IN1")?.enabled === true);
    db.lease.exp = now() - 1000; // A's lease expires
    const reclaimed = await runControlPackageTransaction({ store, pkg: buildPrioritySafeClosePackage({ operator: OP }), mode: "reclaim", ownerToken: "R" });
    ok("I(round-8, blocker 1): reclaim safe-closes stale controls ONLY once no live owner exists (expired), then releases",
      reclaimed.committed === true && (await store.rolloutRows()).every((r) => r.enabled === false) && db.lease.owner === "");
  }

  // --- Round-9 P0-A WRITE-BOUNDARY FENCING via the REAL advanceFbaPlanBucket: a per-account 'lease-lost'
  //     disposition (the fenced CAS wrote zero rows) STOPS the operation mid-chunk (property 6). ---
  {
    const cyc = { id: "cyc-w", status: "succeeded" };
    const runtime = { run: async () => ({ cycleId: "cyc-w", drained: true }),
      store: { getCycleByBucketDate: async () => cyc, finalizeCycle: async () => ({ disposition: "already-terminal", cycle: cyc }) } };
    const controls = { apply: async () => {}, close: async () => {} };
    const eight = Array.from({ length: 8 }, (_, i) => ({ accountId: "a" + (i + 1), country: "IN" }));
    const cost = { tokens: 2, creates: 1, sourceJobs: 1, plan: { sourceJobs: [1] } };
    // The publisher fences EACH write: accounts a1..a4 publish (fence valid), then the lease is superseded and the
    // fenced CAS returns 'lease-lost' for the rest (zero rows). No chunk heartbeat -- the WRITE fence is authoritative.
    let written = 0; const supersedeAfter = 4;
    const pub = { preflight: async () => ({ disposition: "ready" }),
      publish: async (_rk, a) => { if (written >= supersedeAfter) return { disposition: "lease-lost" }; written += 1; return { disposition: "published", liveReportKey: "fba-plan", paramsHash: "h" }; } };
    const res = await advanceFbaPlanBucket({ bucket: "india", asOf: D_1(), inventoryAsOf: D_1(), includedIds: eight.map((a) => a.accountId), bucketAccounts: eight, cost, maxTokens: 90,
      runtime, publisher: pub, controls, readbackLive: async () => ({ ok: true }), strict: true });
    ok("I(round-9, P0-A/property 6): a per-account write-boundary 'lease-lost' STOPS the FBA operation (typed contention, retryable); the superseded accounts write ZERO rows and are never counted as failures",
      res.phase === "contention" && res.ok === false && res.leaseLost === true && written === supersedeAfter && (!res.failedAccounts || res.failedAccounts.length === 0));
  }

  // --- Round-9 P1-C: rollback/release require BOTH owner + generation. A stale process (same token, OLD
  //     generation) must NOT close/release a newer generation's lease (real runControlPackageTransaction). ---
  {
    const db2 = { rollout: new Map([["IN1", true]]), dispatch: new Map(), promoted: new Map(), approvals: new Map(), lease: { owner: "T", gen: 2, exp: Date.now() + 9e5 } };
    let snap = null; const now = () => Date.now();
    const store2 = {
      begin: async () => { snap = { rollout: new Map(db2.rollout), dispatch: new Map(db2.dispatch), promoted: new Map(db2.promoted), approvals: new Map(db2.approvals), lease: { ...db2.lease } }; },
      commit: async () => { snap = null; }, rollback: async () => { if (snap) { Object.assign(db2, snap); snap = null; } },
      readAllPrimary: async () => false, hasCron: async () => false,
      setRolloutEnabled: async () => {}, disableAllRollout: async () => { for (const a of [...db2.rollout.keys()]) db2.rollout.set(a, false); },
      setDispatchEnabled: async () => {}, pauseAllDispatch: async (c) => { for (const rk of c) db2.dispatch.set(rk, false); }, setPromotedEnabled: async () => {}, disableAllPromoted: async () => {},
      setApprovalsApproved: async () => {}, revokeAllApprovals: async () => {},
      rolloutRows: async () => [...db2.rollout].map(([account_id, enabled]) => ({ account_id, enabled })),
      dispatchRows: async () => [...db2.dispatch].map(([report_key, schedule_enabled]) => ({ report_key, schedule_enabled })), promotedRows: async () => [], approvalRows: async () => [],
      // assert/lockAndVerify/release check owner AND EXACT generation (Round-10: reject invalid; exact equality).
      assertControlLeaseOwner: async (t, g) => Number.isSafeInteger(g) && g > 0 && db2.lease.owner === t && db2.lease.exp > now() && db2.lease.gen === g,
      lockAndVerifyControlLease: async (t, g) => Number.isSafeInteger(g) && g > 0 && db2.lease.owner === t && db2.lease.exp > now() && db2.lease.gen === g, // Round-12: atomic lock model (exact owner+gen+unexpired)
      releaseControlLease: async (t, g) => { if (Number.isSafeInteger(g) && g > 0 && db2.lease.owner === t && db2.lease.exp > now() && db2.lease.gen === g) { db2.lease = { owner: "", gen: db2.lease.gen, exp: 0 }; return { disposition: "released" }; } return { disposition: "not-owner" }; },
      acquireControlLease: async () => ({ disposition: "held", owner_token: db2.lease.owner }),
      renewControlLease: async () => ({ disposition: "lost" }),
    };
    // A STALE process (token T but expected generation 1) tries to safe-close; the live lease is generation 2.
    const staleClose = await runControlPackageTransaction({ store: store2, pkg: buildPrioritySafeClosePackage({ operator: "op@upriver.test" }), mode: "rollback", ownerToken: "T", ownerGeneration: 1 });
    ok("I(round-9, P1-C): a stale process (same token, SUPERSEDED generation) CANNOT close/release the newer lease (typed lease-not-owner; controls + lease untouched)",
      staleClose.committed === false && staleClose.leaseNotOwner === true && (await store2.rolloutRows()).find((r) => r.account_id === "IN1")?.enabled === true && db2.lease.owner === "T" && db2.lease.gen === 2);
    // The CURRENT generation owner CAN close + release.
    const okClose = await runControlPackageTransaction({ store: store2, pkg: buildPrioritySafeClosePackage({ operator: "op@upriver.test" }), mode: "rollback", ownerToken: "T", ownerGeneration: 2 });
    ok("I(round-9, P1-C): the CURRENT generation owner safe-closes + releases", okClose.committed === true && db2.lease.owner === "");
  }

  // --- Round-10 SQL MODEL: the mandatory-generation lease RPCs (renew/release/assert/fenced-CAS) mirror the SQL
  //     EXACTLY -- reject NULL/undefined/zero/negative/fractional/NaN/string + a superseded generation; EXACT
  //     equality. NOT executed against a live PostgreSQL (no DB harness in repo); the SQL is static-guarded above. ---
  {
    const validGen = (g) => Number.isSafeInteger(g) && g > 0;
    const now = () => Date.now();
    const lease = { owner: "T", gen: 2, exp: now() + 9e5 }; // token T reacquired gen2 after gen1 expired
    const renew = (t, g) => { if (!validGen(g)) return { disposition: "lost", reason: "invalid-generation" }; if (lease.owner !== t) return { disposition: "lost", reason: "owner-changed" }; if (lease.gen !== g) return { disposition: "lost", reason: "generation-superseded" }; if (lease.exp <= now()) return { disposition: "lost", reason: "expired" }; return { disposition: "renewed" }; };
    const release = (t, g) => { if (!validGen(g)) return { disposition: "not-owner", reason: "invalid-generation" }; if (lease.owner !== t || lease.exp <= now()) return { disposition: "not-owner" }; if (lease.gen !== g) return { disposition: "not-owner", reason: "generation-superseded" }; return { disposition: "released" }; };
    const assertOwner = (t, g) => validGen(g) && lease.owner === t && lease.exp > now() && lease.gen === g;
    const fencedCas = (t, g) => { if (!t) return { disposition: "lease-lost", reason: "no-fence" }; if (!validGen(g)) return { disposition: "lease-lost", reason: "invalid-generation" }; if (lease.owner !== t) return { disposition: "lease-lost", reason: "owner-changed" }; if (lease.gen !== g) return { disposition: "lease-lost", reason: "generation-superseded" }; if (lease.exp <= now()) return { disposition: "lease-lost", reason: "expired" }; return { disposition: "inserted", wrote: 1 }; };
    let allRejected = true; let anyWrite = 0;
    for (const g of [null, undefined, 0, -1, 1.5, NaN, "2", 1]) { // 1 == stale gen1; the rest structurally invalid
      if (renew("T", g).disposition !== "lost") allRejected = false;
      if (release("T", g).disposition !== "not-owner") allRejected = false;
      if (assertOwner("T", g) !== false) allRejected = false;
      const cas = fencedCas("T", g); if (cas.disposition !== "lease-lost") allRejected = false; anyWrite += cas.wrote || 0;
    }
    ok("I(round-10, blocker 1): a stale gen1 / NULL / undefined / zero / negative / fractional / NaN / string generation cannot renew, close, assert, or WRITE gen2 (all rejected, ZERO writes)",
      allRejected === true && anyWrite === 0);
    ok("I(round-10, blocker 1): the CURRENT owner+generation (T/gen2) still renews, asserts, writes ONE row, and releases normally",
      renew("T", 2).disposition === "renewed" && assertOwner("T", 2) === true && fencedCas("T", 2).wrote === 1 && release("T", 2).disposition === "released");
  }
  function D_1() { return "2026-09-08"; }
})();

/* ===================== G. ROUND-6 ack run-token LEASE model (blocker 5): a FAITHFUL offline model of the
   ack_onboarding_dispatch running branch -- CLAIM only from queued|running+unset; IDEMPOTENT same-token refresh
   (token unchanged); LEASE-OWNED (a different token NEVER steals a running lease + NEVER overwrites the token);
   only an explicit expired-lease (release, which clears the token) may reassign. Plus the concurrent two-run
   regression. Mirrors supabase/migrations/20260919_account_onboarding.sql lines 371-410. ===================== */
(() => {
  function makeDispatch() {
    const d = { status: "queued", attempts: 1, active_run_token: null };
    const tok = () => d.active_run_token || "";
    return {
      ack: (phase, token) => {
        const v = String(token || "").trim();
        if (v === "") return { disposition: "error", reason: "blank-run-token" }; // SQL raises; modeled as a hard reject
        if (d.status === "completed") return { disposition: "already-completed" };
        if (phase === "running") {
          // CLAIM: queued, or running with an UNSET token.
          if (d.status === "queued" || (d.status === "running" && tok() === "")) {
            d.status = "running"; d.active_run_token = v; return { disposition: "acked", status: "running" };
          }
          // IDEMPOTENT: the SAME owner re-acking running -- refresh only, token UNCHANGED.
          if (d.status === "running" && tok() === v) return { disposition: "acked", status: "running", idempotent: true };
          // LEASE-OWNED: a DIFFERENT run holds the lease -- NEVER overwrite the token (no steal).
          if (d.status === "running") return { disposition: "stale-ack", reason: "lease-owned", status: d.status };
          return { disposition: "stale-ack", reason: "not-active", status: d.status };
        }
        // completed | failed: only the current lease owner may finish.
        if (d.status !== "running" || tok() !== v) return { disposition: "stale-ack", reason: "superseded-or-not-owner", status: d.status };
        d.status = phase === "completed" ? "completed" : "failed";
        if (phase === "failed") d.active_run_token = null;
        return { disposition: "acked", status: d.status };
      },
      release: () => { d.status = "queued"; d.attempts += 1; d.active_run_token = null; }, // explicit expired-lease re-queue
      state: () => ({ ...d }),
    };
  }

  // A blank run token is rejected (the SQL raises the stale-ack guard).
  ok("G(blocker 5): a blank run-token is rejected (never claims a lease)", makeDispatch().ack("running", "  ").disposition === "error");

  // CONCURRENT TWO-RUN: run-1 claims from queued; run-2 (different token) CANNOT steal the running lease and
  // must NOT overwrite the token; run-1 stays the owner and completes; run-2's completed-ack is a stale no-op.
  const d = makeDispatch();
  ok("G(blocker 5): run-1 CLAIMS the queued wave (acked running, token stamped)",
    d.ack("running", "run-1").disposition === "acked" && d.state().active_run_token === "run-1");
  const steal = d.ack("running", "run-2");
  ok("G(blocker 5, concurrent two-run): a SECOND simultaneous run (different token) gets stale-ack lease-owned and CANNOT steal the lease (token still run-1)",
    steal.disposition === "stale-ack" && steal.reason === "lease-owned" && d.state().active_run_token === "run-1" && d.state().status === "running");
  ok("G(blocker 5): the SAME owner re-acking running is idempotent -- token unchanged, still running",
    d.ack("running", "run-1").idempotent === true && d.state().active_run_token === "run-1");
  ok("G(blocker 5): the non-owner run-2 CANNOT complete the wave (superseded-or-not-owner)",
    d.ack("completed", "run-2").disposition === "stale-ack" && d.state().status === "running");
  ok("G(blocker 5): the OWNING run-1 can complete it", d.ack("completed", "run-1").disposition === "acked" && d.state().status === "completed");
  ok("G(blocker 5): a completed wave is terminal -- even the owner's re-ack is already-completed (no revive)",
    d.ack("running", "run-1").disposition === "already-completed");

  // EXPIRED-LEASE reassignment: only an explicit release (clears the token) lets a new run take over.
  const d2 = makeDispatch();
  d2.ack("running", "run-1");
  ok("G(blocker 5): before release, a foreign run cannot claim a live lease (lease-owned)", d2.ack("running", "run-2").reason === "lease-owned");
  d2.release(); // explicit expired-lease transaction clears the token + re-queues
  ok("G(blocker 5): after an explicit expired-lease release, a NEW run may claim (reassignment is explicit-only)",
    d2.ack("running", "run-2").disposition === "acked" && d2.state().active_run_token === "run-2");
  ok("G(blocker 5, regression): the ORIGINAL run-1's late completed-ack is now a stale no-op (never revives the superseded run)",
    d2.ack("completed", "run-1").disposition === "stale-ack" && d2.state().status === "running");
  ok("G(blocker 5): the current owner run-2 can complete", d2.ack("completed", "run-2").disposition === "acked");

  // A failed ack clears the token (so the next lease re-queues cleanly), and only the owner may fail it.
  const d3 = makeDispatch();
  d3.ack("running", "run-1");
  ok("G(blocker 5): a non-owner cannot FAIL the wave (superseded-or-not-owner)", d3.ack("failed", "run-X").disposition === "stale-ack");
  ok("G(blocker 5): the owner's failed-ack clears the token (a clean re-queue) and is retryable",
    d3.ack("failed", "run-1").disposition === "acked" && d3.state().active_run_token === null && d3.state().status === "failed");
})();

writeSync(1, `\naccount-onboarding-bootstrap: ${passed} assertions passed\n`);
