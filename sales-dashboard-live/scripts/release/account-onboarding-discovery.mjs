// TRUSTED operator for the 15-minute PRIMARY account-onboarding DISCOVERY worker.
//
//   node scripts/release/account-onboarding-discovery.mjs --mode=dry-run   (ZERO writes; reports every planned action)
//   node scripts/release/account-onboarding-discovery.mjs --mode=live      (Supabase writes only; ZERO DataDoe exports)
//
// What one pass does (see lib/server/sync/account-onboarding-discovery.js):
//   1. zero-token DataDoe directory GET (the ONLY DataDoe call -- structurally no export/create path);
//   2. classify every PRIMARY account against account_onboarding (readiness = initialLoadComplete,
//      NEVER mere directory presence; unsupported marketplace => blocked, never silently routed);
//   3. atomically CLAIM account-bootstrap/<accountId>/<firstDiscoveredDate> for newly-ready accounts
//      (idempotent RPC: polls/restarts/watchdogs converge on ONE operation, never two);
//   4. additively merge new accounts into the shared account-directory snapshot (admins see
//      "Setting up" immediately; existing entries and permissions are NEVER touched);
//   5. refresh the account_directory table (Data Sync Center visibility; region as sync bucket).
// Scheduler-v2 stays the ONE owner of paid exports: a claimed account is bootstrapped by the next
// regional run through the existing per-source machinery under the existing regional ceilings.
//
// Exit codes: 0 success (including a no-op pass); 1 typed failure (e.g. migration not applied,
// discovery GET failed) -- always BEFORE any partial write where possible; never prints a secret.

import { loadReleaseEnv } from "./env-bootstrap.mjs";
loadReleaseEnv();

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const mode = argOf("mode") || "dry-run";
if (mode !== "dry-run" && mode !== "live") { console.error("STOP --mode must be dry-run | live"); process.exit(2); }

const { runAccountOnboardingDiscovery, buildProductionOnboardingDeps } = await import("../../lib/server/sync/account-onboarding-discovery.js");

try {
  const deps = await buildProductionOnboardingDeps();
  const summary = await runAccountOnboardingDiscovery({ mode, deps, log: (m) => console.log(m) });
  const gh = process.env.GITHUB_STEP_SUMMARY;
  if (gh) {
    const { appendFileSync } = await import("node:fs");
    try {
      appendFileSync(gh, [
        "### account-onboarding discovery (" + mode + ")",
        "- discovered: " + summary.discovered + " (ready " + summary.ready + " / loading " + summary.loading + ")",
        "- upserts: " + summary.upserts + " · claims: " + summary.claims.length + " · snapshotChanged: " + summary.snapshotChanged,
        ...summary.transitions.map((t) => "- " + t.accountId.slice(0, 8) + " " + t.name + ": " + t.transition),
      ].join("\n") + "\n");
    } catch { /* summary only */ }
  }
  console.log("account-onboarding discovery OK (" + mode + "): " + summary.upserts + " upsert(s), " + summary.claims.length + " claim(s), snapshotChanged=" + summary.snapshotChanged);
} catch (error) {
  console.error("STOP account-onboarding discovery failed: " + String(error && error.message ? error.message : error));
  process.exit(1);
}
