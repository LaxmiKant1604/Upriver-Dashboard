// All-region scheduler repair (Work 1) regression: the OLI D-1 plan is built over the READINESS-GATED primary set,
// so a seller whose DataDoe initial load is not complete (sellerCentralConnection.initialLoadComplete=false) is
// EXCLUDED from the <=5-seller export batch -- it can no longer poison healthy batch-mates with a terminal
// DATADOE_INITIAL_LOAD_INCOMPLETE (the observed Europe-AU failure). Healthy sellers stay in ONE <=5-seller batch
// (NOT forced into single-seller exports), and the unready seller waits (LKG preserved). Exercises the REAL gate
// (filterExportEligibleAccounts) + the REAL plan (oliBucketPlan), and guards the runtime wiring in oli-refresh-d1.mjs.
// Offline, pure (no network). 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { filterExportEligibleAccounts, EXCLUDE_DATADOE_NOT_READY } from "../lib/server/sync/account-onboarding.js";
import { oliBucketPlan } from "../lib/server/sync/source-scheduled-oli.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "scheduler-oli-readiness-plan (Work 1: readiness-gated OLI plan)\n");

// A DataDoe directory-detailed account (readiness = initialLoadComplete via sellerCentralReady).
const detailed = (id, { ready = true } = {}) => ({
  id, name: `Account ${id}`, country: "AU", countryName: "AU", currency: "AUD", locale: "en-AU", timeZone: "UTC",
  readiness: { sellerCentralReady: ready, rowCount: 1000, sellerCentralRowCount: 500, adsConnected: true, adsReady: true, adsRowCount: 10, accountType: "SELLER", marketplaceId: "M1" },
});

// 5 fully-loaded sellers + 1 whose initial load is NOT complete (the batch-poisoner the provider rejects).
const accounts = ["s1", "s2", "s3", "s4", "s5"].map((id) => detailed(id)).concat([detailed("unready", { ready: false })]);

// (1) THE GATE: readiness-only mode (fail-soft, no onboarding rows) excludes ONLY the unready seller, with the typed reason.
const gated = filterExportEligibleAccounts({ detailedAccounts: accounts, onboardingRows: null });
ok("A: the readiness gate excludes ONLY the unready seller (initialLoadComplete=false) with the typed reason",
  gated.eligible.map((a) => a.id).sort().join(",") === "s1,s2,s3,s4,s5"
  && gated.excluded.length === 1 && gated.excluded[0].accountId === "unready" && gated.excluded[0].reason === EXCLUDE_DATADOE_NOT_READY);

// (2) THE PLAN over the GATED set: the 5 healthy sellers form ONE <=5-seller batch (maxCreates=1), NOT 5 single exports,
// and the unready seller is absent from every batch. This is what the runtime now plans (oli-refresh-d1.mjs injects
// the gated set as fetchAccounts), so the provider never receives the unready seller inside a multi-seller OLI request.
const gatedPlan = oliBucketPlan(gated.eligible.map((a) => ({ accountId: a.id })));
const plannedIds = gatedPlan.batches.flatMap((b) => (b.accounts || []).map((x) => String(x.accountId || x)));
ok("B: the gated 5-seller plan is ONE <=5-seller batch (maxCreates=1), never 5 forced single-seller exports",
  gatedPlan.expectedBatches === 1 && gatedPlan.maxCreates === 1 && gatedPlan.batches[0].accounts.length === 5);
ok("B: the unready seller is absent from the OLI plan (it waits; LKG preserved) while all 5 healthy sellers are planned",
  !plannedIds.includes("unready") && ["s1", "s2", "s3", "s4", "s5"].every((id) => plannedIds.includes(id)));

// (3) CONTRAST: the UNGATED set (the old defect) would have grouped the unready seller INTO the batch -> the provider
// rejects the whole multi-seller request. Prove the ungated plan includes it (so the gating is what prevents it).
const ungatedPlan = oliBucketPlan(accounts.map((a) => ({ accountId: a.id })));
ok("C: WITHOUT the gate the unready seller IS grouped into the batch (the poisoning the fix prevents)",
  ungatedPlan.batches.some((b) => (b.accounts || []).some((x) => String(x.accountId || x) === "unready")));

// (4) WIRING GUARD: oli-refresh-d1.mjs must (a) capture the gate-excluded (unready) account ids and (b) pass them to
// the runtime as preemptiveUnreadyAccountIds -- so the runtime DEFERS them from the FRESH plan while DISCOVERY stays
// FULL (the frozen-owner safety check is preserved). It must NOT gate discovery via a fetchAccounts override (that
// would omit a now-unready frozen owner and defer the whole continuation -- Codex finding 2).
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "release", "oli-refresh-d1.mjs"), "utf8");
const runtimeCall = src.slice(src.indexOf("buildBucketSourceSyncRuntime({"), src.indexOf("buildBucketSourceSyncRuntime({") + 400);
ok("D: oli-refresh-d1.mjs passes preemptiveUnreadyAccountIds to the runtime (defer from the fresh plan) and captures the gate-excluded ids",
  /preemptiveUnreadyAccountIds\s*:\s*preemptiveUnreadyIds/.test(runtimeCall)
  && /preemptiveUnreadyIds\.add\(/.test(src));
ok("D: oli-refresh-d1.mjs does NOT gate the runtime DISCOVERY with a fetchAccounts override (discovery stays full so the frozen-owner check is preserved)",
  !/buildBucketSourceSyncRuntime\(\{[\s\S]{0,400}fetchAccounts\s*:/.test(src));

// (5) POSITIVE-ALLOWLIST WIRING GUARD (Codex req 2): oli-refresh-d1.mjs must ALSO pass an EXPLICIT authorized
// fresh-plan account set (freshPlanAccountIds) to the runtime -- built from the gate's eligible ids (`ids`) -- so the
// FRESH plan is discovery INTER allowlist, not merely discovery-minus-exclusions. A new account that appears in the
// runtime's full directory read but was not gated/authorized here cannot enter the fresh plan or issue a create.
ok("E: oli-refresh-d1.mjs builds a positive fresh-plan allowlist from the authorized eligible ids and passes it to the runtime (freshPlanAccountIds)",
  /freshPlanAllowlistIds\s*=\s*new Set\(ids\)/.test(src)
  && /buildBucketSourceSyncRuntime\(\{[\s\S]{0,400}freshPlanAccountIds\s*:\s*freshPlanAllowlistIds/.test(src));

writeSync(1, `\nscheduler-oli-readiness-plan: ${passed} assertions passed\n`);
