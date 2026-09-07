// TRUSTED operator that records the EXPLICITLY-APPROVED paid ceiling for EXACTLY ONE REGION-LOCAL wave.
// Until this row exists, every bootstrap-scoped paid step REFUSES before its first create POST
// (BUDGET_NOT_AUTHORIZED) and the discovery worker holds the wave in awaiting-budget (zero dispatches).
//
//   node scripts/release/authorize-onboarding-budget.mjs --region=<india|europe-au|us-ca> \
//       --wave-key=<onboarding-wave/<region>/...> --plan-fingerprint=<fp> \
//       --plan-file=<path from onboarding-wave-plan.mjs> --tokens=<N> \
//       --confirm=onboarding-budget/<wave-key>/<N>
//
// BINDING: the REGION-LOCAL wave key is RECOMPUTED here from the CURRENT durable claim state and must
// equal --wave-key AND the plan file's -- if that region's membership changed since the plan was
// generated (an account was claimed or graduated in THIS region; other regions never affect it), the
// recomputed key differs and this STOPS: re-plan, re-approve. The plan fingerprint is recomputed from
// the plan file's steps (which fold each step's full plan hash) and must equal --plan-fingerprint. The
// INSERT records the region, the full wave membership + the approved per-step plan (incl. stepPlanHash),
// so every later reservation is validated against exactly what was approved (any drift => PLAN_DRIFT).
// INSERT-only: an existing row for the SAME wave key is NEVER overwritten; a FUTURE wave is a NEW key.

import { readFileSync } from "node:fs";
import { loadReleaseEnv } from "./env-bootstrap.mjs";
loadReleaseEnv();

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const regionArg = (argOf("region") || "").trim();
const waveKeyArg = (argOf("wave-key") || "").trim();
const tokens = Number(argOf("tokens"));
const planFingerprintArg = (argOf("plan-fingerprint") || "").trim();
const planFile = (argOf("plan-file") || "").trim();
const confirm = argOf("confirm");

const { computeOnboardingWaveIdentity, onboardingPlanFingerprint, onboardingStepPlanHash, ONBOARDING_REGIONS } = await import("../../lib/server/sync/account-onboarding.js");

if (!ONBOARDING_REGIONS.includes(regionArg)) { console.error("STOP --region must be india | europe-au | us-ca (got: " + regionArg + ")"); process.exit(2); }
if (!waveKeyArg.startsWith("onboarding-wave/" + regionArg + "/")) { console.error("STOP --wave-key must be the canonical onboarding-wave/<region>/<hash> key for --region=" + regionArg + "."); process.exit(2); }
if (!Number.isInteger(tokens) || tokens <= 0) { console.error("STOP --tokens must be a positive integer (the approved hard ceiling)."); process.exit(2); }
if (!planFingerprintArg) { console.error("STOP --plan-fingerprint is MANDATORY (the exact fingerprint the dry-run plan emitted)."); process.exit(2); }
if (!planFile) { console.error("STOP --plan-file is required (the plan JSON onboarding-wave-plan.mjs wrote)."); process.exit(2); }
const expectedConfirm = `onboarding-budget/${waveKeyArg}/${tokens}`;
if (confirm !== expectedConfirm) { console.error("STOP live authorization requires --confirm=" + expectedConfirm + " (exact)."); process.exit(2); }

// 1. Load + validate the approved plan document (every step must carry a non-blank stepPlanHash that
// RE-derives from its own bound parameters, so a tampered plan file is rejected).
let plan = null;
try { plan = JSON.parse(readFileSync(planFile, "utf8")); } catch (e) { console.error("STOP cannot read plan file " + planFile + ": " + (e && e.message)); process.exit(2); }
const steps = Array.isArray(plan && plan.steps) ? plan.steps : null;
if (!steps || !steps.length) { console.error("STOP plan file has no steps -- regenerate with onboarding-wave-plan.mjs."); process.exit(2); }
for (const s of steps) {
  if (!s || !String(s.step || "").trim() || String(s.region || "").trim() !== regionArg || !String(s.accountSetHash || "").trim()
    || !String(s.stepPlanHash || "").trim()
    || !Number.isInteger(Number(s.plannedCreates)) || Number(s.plannedCreates) < 0
    || !Number.isInteger(Number(s.plannedTokens)) || Number(s.plannedTokens) < 0) {
    console.error("STOP plan file contains a malformed step entry (or wrong region): " + JSON.stringify(s)); process.exit(2);
  }
  const recomputedStep = onboardingStepPlanHash({
    step: s.step, region: s.region, accounts: plan.accounts, operationIds: plan.operations, accountSetHash: s.accountSetHash,
    planAsOf: s.planAsOf, inventoryAsOf: s.inventoryAsOf, sourceKeys: s.sourceKeys, windows: s.windows,
    requestHashes: s.requestHashes, batchMembership: s.batchMembership, limits: s.limits, structure: s.structure,
  });
  if (recomputedStep !== String(s.stepPlanHash).trim()) { console.error("STOP step plan hash mismatch for " + s.step + " -- the plan file was altered; re-plan."); process.exit(2); }
}
const recomputedFp = onboardingPlanFingerprint(steps);
if (recomputedFp !== planFingerprintArg) { console.error("STOP plan-fingerprint mismatch: --plan-fingerprint=" + planFingerprintArg + " but the plan file's steps hash to " + recomputedFp + " -- the plan changed; re-plan and re-approve."); process.exit(2); }
if (String(plan.waveKey || "").trim() !== waveKeyArg) { console.error("STOP wave-key mismatch: --wave-key=" + waveKeyArg + " but the plan file records " + plan.waveKey + " -- re-plan and re-approve."); process.exit(2); }
const planTokens = steps.reduce((t, s) => t + Number(s.plannedTokens), 0);
if (tokens < planTokens) { console.error("STOP --tokens=" + tokens + " is BELOW the plan's total " + planTokens + " -- authorize at least the planned total (or re-plan smaller)."); process.exit(2); }

// 2. Recompute the REGION-LOCAL wave identity from the CURRENT durable claim state; it must still match.
const sb = await import("../../lib/server/supabase.js");
const onboardingRows = await sb.getAccountOnboardingRows();
if (!Array.isArray(onboardingRows)) { console.error("STOP account_onboarding unreadable (fail closed)."); process.exit(1); }
const wave = computeOnboardingWaveIdentity(onboardingRows, regionArg);
if (wave.waveKey !== waveKeyArg) {
  console.error("STOP WAVE_MEMBERSHIP_CHANGED: the durable claim state for " + regionArg + " now hashes to " + (wave.waveKey || "(no claimed wave)")
    + " but the approval targets " + waveKeyArg + " -- an old approval can NEVER cover a changed membership. Re-run onboarding-wave-plan.mjs and re-approve.");
  process.exit(1);
}

// 3. INSERT-only (service-role INSERT is granted; UPDATE/DELETE are not, so this can only create).
const existing = await sb.getOnboardingBudget(waveKeyArg);
if (existing) {
  console.error("STOP an authorization already exists for " + waveKeyArg
    + " (authorized=" + existing.authorized_tokens + ", reserved=" + existing.reserved_tokens + ", spent=" + existing.spent_tokens + ", status=" + existing.status + ") -- never overwritten.");
  process.exit(1);
}
const res = await fetch(String(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL).replace(/\/$/, "") + "/rest/v1/account_onboarding_budget", {
  method: "POST",
  headers: {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  },
  body: JSON.stringify({
    budget_key: waveKeyArg,
    region: regionArg,
    authorized_tokens: tokens,
    plan_fingerprint: planFingerprintArg,
    wave_accounts: wave.accounts,
    wave_operations: wave.operations,
    approved_plan: steps.map((s) => ({
      step: String(s.step).trim(), region: String(s.region).trim(), accountSetHash: String(s.accountSetHash).trim(),
      stepPlanHash: String(s.stepPlanHash).trim(),
      planAsOf: String(s.planAsOf || "").trim(), inventoryAsOf: String(s.inventoryAsOf || "").trim(),
      sourceKeys: Array.isArray(s.sourceKeys) ? s.sourceKeys : [], windows: Array.isArray(s.windows) ? s.windows : [],
      requestHashes: Array.isArray(s.requestHashes) ? s.requestHashes : [], batchMembership: Array.isArray(s.batchMembership) ? s.batchMembership : [],
      limits: Array.isArray(s.limits) ? s.limits : [], ...(s.structure != null ? { structure: s.structure } : {}),
      plannedCreates: Number(s.plannedCreates), plannedTokens: Number(s.plannedTokens),
    })),
  }),
});
if (!res.ok) { console.error("STOP authorization insert failed (HTTP " + res.status + ")."); process.exit(1); }
console.log("AUTHORIZED " + regionArg + " onboarding wave " + waveKeyArg + ": hard ceiling=" + tokens + " tokens over " + wave.accounts.length
  + " account(s) / " + steps.length + " step(s); plan fingerprint=" + planFingerprintArg + ".");
console.log("The next */30 discovery pass may now lease + dispatch THIS region's wave; every paid step reserves against this ceiling and refuses past it BEFORE any create POST.");
