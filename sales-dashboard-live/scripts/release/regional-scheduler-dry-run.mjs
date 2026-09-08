// READ-ONLY regional scheduler dry-run -- proves the 3-region routing + the exact zero-create plan for OLI + Campaign
// + the one shared Catalog, plus the token balance, WITHOUT a single create or durable write. Usage (from
// sales-dashboard-live/):
//   node scripts/release/regional-scheduler-dry-run.mjs [--region=india|europe-au|us-ca|all]
//
// It discovers accounts from the DataDoe directory (ZERO tokens), routes them into india / europe-au / us-ca by
// trusted stored marketplace evidence (UK->GB + AU -> europe-au; unknown -> UNASSIGNED, alerted + skipped, never a
// leaked identity), forms deterministic <=5-seller batches, and computes per region: OLI exports/tokens, Campaign
// exports/tokens, and the shared 1-create Catalog, then reads the live balance and prints a createReady verdict per
// region. It NEVER creates an export, opens a control, or writes a cycle. Prints counts + 8-char id prefixes only.

import { loadReleaseEnv } from "./env-bootstrap.mjs";
import { REGIONS, REGION_SCOPES } from "../../lib/server/sync/scheduler-scope.js";

loadReleaseEnv();

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const regionArg = (argOf("region") || "all").toLowerCase();
if (regionArg !== "all" && !REGION_SCOPES.includes(regionArg)) { console.error("STOP --region must be india | europe-au | us-ca | all (got: " + regionArg + ")"); process.exit(2); }

const { getDataDoeConnections, classifyDirectoryAccounts } = await import("../../lib/server/datadoe-connections.js");
const { fetchAccountsDetailed } = await import("../../lib/server/datadoe.js");
const { fetchExportEligibleAccounts, classifyDiscoveryOutcome } = await import("../../lib/server/sync/account-onboarding.js");
const { getAccountOnboardingRows: readOnboardingRows } = await import("../../lib/server/supabase.js");
// EXPORT-ELIGIBILITY GATE (dry-run parity with the live scheduler): show exactly the gated account set
// plus the typed exclusions, so the dry-run rehearses the real scope.
const fetchAccounts = (apiKey) => fetchExportEligibleAccounts(apiKey, {
  fetchDetailed: fetchAccountsDetailed, readOnboardingRows,
  onExcluded: (excluded, gateMode) => console.log(`onboarding gate (${gateMode}): excluded ${excluded.length} account(s): ${excluded.map((x) => `${x.accountId.slice(0, 8)}:${x.reason}`).join(", ")}`),
});
const { routeAccounts, batchAccounts, REGION_SCHEDULE, MAX_SELLERS_PER_BATCH } = await import("../../lib/server/sync/campaign-region-routing.js");
const { OLI_TOKENS_PER_CREATE } = await import("../../lib/server/sync/source-scheduled-oli.js");
const { getDataDoeTokenBalance } = await import("../../lib/server/datadoe-usage.js");

const CAMPAIGN_TOKENS_PER_CREATE = 2; // one STANDARD Campaign export
const CATALOG_TOKENS = 2;             // one STANDARD Catalog export, shared across ALL regions (1 create/day)
const log = (m) => console.log("regional-dry-run: " + m);

const connections = getDataDoeConnections();
const primary = connections.find((c) => c && c.id === "primary" && String(c.apiKey || "").trim());
if (!primary) { console.error("STOP no primary DataDoe connection / api key (fail closed)"); process.exit(1); }

// Discover PRIMARY accounts + their trusted marketplace/country evidence (zero tokens).
const rows = (await fetchAccounts(primary.apiKey)) || [];
const { active } = classifyDirectoryAccounts(rows, connections);
const seen = new Set();
const accounts = [];
for (const a of active) {
  const accountId = String((a && (a.accountId ?? a.id)) || "").trim();
  if (!accountId || accountId.includes(":") || seen.has(accountId)) continue;
  seen.add(accountId);
  accounts.push({ accountId, marketplace: String((a && a.country) || "").toUpperCase() });
}
if (!accounts.length) {
  // P1-4: surface the TYPED discovery disposition (no-authoritative-scope / all-awaiting-onboarding / empty
  // directory) instead of a generic "no accounts discovered" -- the dry-run rehearses the exact live deferral.
  const disp = classifyDiscoveryOutcome(rows);
  console.error("STOP " + (disp.deferred ? disp.message : "no primary accounts discovered after classification")); process.exit(1);
}
log("discovered " + accounts.length + " primary accounts (max sellers/batch = " + MAX_SELLERS_PER_BATCH + ")");

const { byRegion, unassigned } = routeAccounts(accounts);

// Alert (never silently drop) any UNASSIGNED account -- an unknown/blank marketplace fails closed out of every region.
if (unassigned.length) {
  log("ALERT " + unassigned.length + " UNASSIGNED account(s) (unknown/blank marketplace -> skipped, never coerced into a region): "
    + unassigned.map((a) => a.accountId.slice(0, 8) + "(" + (a.marketplace || a.country || "?") + ")").join(", "));
}

const regionsToPlan = regionArg === "all" ? [...REGION_SCOPES] : [regionArg];
let grandExports = 0; let grandTokens = 0; let catalogCounted = false;
const perRegion = [];
for (const region of regionsToPlan) {
  const regionAccounts = byRegion[region] || [];
  const oliBatches = batchAccounts(regionAccounts).length;      // <=5 sellers/batch
  const campaignBatches = oliBatches;                           // same batching for the Campaign grain
  const oliTokens = oliBatches * OLI_TOKENS_PER_CREATE;
  const campaignTokens = campaignBatches * CAMPAIGN_TOKENS_PER_CREATE;
  // Catalog is shared org-wide (1 create/day across ALL regions); attribute it once to the first planned region.
  const catalogTokens = catalogCounted ? 0 : CATALOG_TOKENS;
  catalogCounted = true;
  const regionExports = oliBatches + campaignBatches + (catalogTokens ? 1 : 0);
  const regionTokens = oliTokens + campaignTokens + catalogTokens;
  grandExports += regionExports; grandTokens += regionTokens;
  const sched = REGION_SCHEDULE[region];
  perRegion.push({ region, label: sched.label, accounts: regionAccounts.length, oliBatches, campaignBatches, regionExports, regionTokens });
  log("REGION " + region + " (" + sched.label + ", primary " + sched.primaryCron + " / watchdog " + sched.watchdogCron + "): "
    + regionAccounts.length + " accounts -> OLI " + oliBatches + " batch/" + oliTokens + "tok + Campaign " + campaignBatches + " batch/" + campaignTokens + "tok"
    + (catalogTokens ? " + Catalog 1/" + catalogTokens + "tok (shared)" : " + Catalog 0 (reuses shared)")
    + " => " + regionExports + " exports / " + regionTokens + " worst-case tokens");
}

// Read the live usable balance (zero tokens; read-only /usage-logs).
let balance = null;
try { balance = await getDataDoeTokenBalance({ apiKey: primary.apiKey }); } catch (e) { log("balance read failed: " + (e && e.message ? e.message : e)); }
const usable = balance && Number.isFinite(Number(balance.usable ?? balance.remaining ?? balance.balance)) ? Number(balance.usable ?? balance.remaining ?? balance.balance) : null;
const createReady = usable != null && usable >= grandTokens;

log("PLAN TOTAL across " + regionsToPlan.join("+") + ": " + grandExports + " exports / " + grandTokens + " worst-case tokens; usable balance = " + (usable == null ? "UNREADABLE" : usable));
log("createReady (balance >= worst-case) = " + (usable == null ? "UNKNOWN (fail closed -- authorize no create)" : (usable >= grandTokens ? "YES" : "NO")) + "  [DRY-RUN: zero creates, zero writes]");
console.log("RESULT " + JSON.stringify({
  ok: true, dryRun: true, creates: 0, regions: perRegion, unassigned: unassigned.length,
  totalExports: grandExports, worstCaseTokens: grandTokens, usable, createReady: usable == null ? false : usable >= grandTokens,
}));
process.exit(0);
