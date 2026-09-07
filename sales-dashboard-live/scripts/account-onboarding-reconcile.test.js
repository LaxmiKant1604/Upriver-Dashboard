// Reproduce-then-fix regressions for the empty/partial account_onboarding exclusion outage (US-CA
// "no primary us-ca accounts discovered") and the established-account reconciliation gate. Fully offline,
// pure functions only -- no DataDoe, no network, no tokens. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  filterExportEligibleAccounts, fetchExportEligibleAccounts, classifyOnboardingAccount,
  ONBOARDING_STATUS, EXPORT_ELIGIBLE_STATUSES, EXCLUDE_NOT_ONBOARDED, EXCLUDE_DATADOE_NOT_READY,
} from "../lib/server/sync/account-onboarding.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); };
writeSync(1, "account-onboarding-reconcile\n");

const ready = (id, country = "US") => ({ id, name: id, country, readiness: { sellerCentralReady: true, marketplaceId: "M", rowCount: 10 } });
const loading = (id, country = "US") => ({ id, name: id, country, readiness: { sellerCentralReady: false } });
const ids = (xs) => xs.map((a) => a.id);
const exReasons = (r) => r.excluded.map((e) => e.accountId + ":" + e.reason);

/* ===== A. THE OUTAGE: an empty onboarding table must NOT exclude existing DataDoe-ready accounts ===== */
{
  const acc = [ready("US1"), ready("US2"), loading("US3")];
  // Empty table (subsystem uninitialised) => readiness-only, NOT a blanket NOT_ONBOARDED exclusion.
  const empty = filterExportEligibleAccounts({ detailedAccounts: acc, onboardingRows: [] });
  ok("A1: an EMPTY onboarding table falls back to readiness-only (existing DataDoe-ready accounts stay eligible; the US-CA outage is fixed)",
    JSON.stringify(ids(empty.eligible)) === JSON.stringify(["US1", "US2"]) && empty.gateMode === "readiness-only"
    && exReasons(empty).join(",") === "US3:" + EXCLUDE_DATADOE_NOT_READY);
  // Unreadable table (null) keeps the same fail-soft behaviour (no regression).
  const nul = filterExportEligibleAccounts({ detailedAccounts: acc, onboardingRows: null });
  ok("A2: an unreadable (null) table stays readiness-only (unchanged)", JSON.stringify(ids(nul.eligible)) === JSON.stringify(["US1", "US2"]));
}

/* ===== B. Established reconciliation: existing accounts are safe; brand-new ids are never exposed ===== */
{
  const acc = [ready("US1"), ready("US2"), loading("US3")];
  // Empty table + established set => only ESTABLISHED DataDoe-ready accounts are eligible.
  const est1 = filterExportEligibleAccounts({ detailedAccounts: acc, onboardingRows: [], establishedAccountIds: ["US1"] });
  ok("B1: on an empty table an ESTABLISHED account (US1) is reconciled-eligible while a BRAND-NEW id (US2) is NOT blindly exposed",
    JSON.stringify(ids(est1.eligible)) === JSON.stringify(["US1"]) && est1.reconciled.map((x) => x.accountId).join(",") === "US1"
    && exReasons(est1).includes("US2:" + EXCLUDE_NOT_ONBOARDED) && est1.gateMode === "reconcile");
  // Partial table (US2 has a row; US1 established but no row) => BOTH eligible (US1 reconciled).
  const partial = filterExportEligibleAccounts({ detailedAccounts: acc, onboardingRows: [{ account_id: "US2", status: "ready" }], establishedAccountIds: ["US1"] });
  ok("B2: a PARTIAL table never excludes an established account missing a row (US1 reconciled, US2 via its row)",
    JSON.stringify(ids(partial.eligible)) === JSON.stringify(["US1", "US2"]) && partial.reconciled.map((x) => x.accountId).join(",") === "US1");
  // REGRESSION: an EMPTY established set (e.g. account-directory snapshot absent) is NOT a signal -- an empty
  // onboarding table must STILL fall back to readiness-only, never a blanket exclusion (the outage must not recur).
  const emptyEstablished = filterExportEligibleAccounts({ detailedAccounts: acc, onboardingRows: [], establishedAccountIds: [] });
  ok("B1b: an EMPTY established set + empty table falls back to readiness-only (no signal never means blanket-exclude)",
    JSON.stringify(ids(emptyEstablished.eligible)) === JSON.stringify(["US1", "US2"]) && emptyEstablished.gateMode === "readiness-only");
  // A truly brand-new DataDoe-ready account (populated table, not established) stays excluded -> onboarding flow.
  const brandNew = filterExportEligibleAccounts({
    detailedAccounts: [ready("US1"), ready("NEW9")],
    onboardingRows: [{ account_id: "US1", status: "ready" }], establishedAccountIds: ["US1"],
  });
  ok("B3: a BRAND-NEW DataDoe-ready account (not established, no row) is excluded NOT_ONBOARDED (routed through onboarding, never auto-exposed)",
    JSON.stringify(ids(brandNew.eligible)) === JSON.stringify(["US1"]) && exReasons(brandNew).includes("NEW9:" + EXCLUDE_NOT_ONBOARDED));
}

/* ===== C. Row status is authoritative when present; DataDoe-not-ready is never eligible ===== */
{
  // An explicit non-eligible row status wins over the established fallback.
  const waiting = filterExportEligibleAccounts({ detailedAccounts: [ready("US1")], onboardingRows: [{ account_id: "US1", status: "waiting_for_datadoe" }], establishedAccountIds: ["US1"] });
  ok("C1: an explicit onboarding row status is authoritative over the established fallback (waiting_for_datadoe stays excluded)",
    waiting.eligible.length === 0 && waiting.excluded[0].reason === "ONBOARDING_WAITING_FOR_DATADOE");
  // Rule 1 never degraded: a DataDoe in-progress account gets ZERO paid exports even if established.
  const stillLoading = filterExportEligibleAccounts({ detailedAccounts: [loading("US1")], onboardingRows: [], establishedAccountIds: ["US1"] });
  ok("C2: a DataDoe in-progress (loading) account is NEVER eligible even when established (zero paid exports)",
    stillLoading.eligible.length === 0 && stillLoading.excluded[0].reason === EXCLUDE_DATADOE_NOT_READY);
}

/* ===== D. Isolation: the gate never mutates inputs (directory/authorization mappings untouched) ===== */
{
  const acc = [ready("US1")];
  const rows = [{ account_id: "US1", status: "ready" }];
  const established = ["US1", "US2"];
  const before = JSON.stringify({ acc, rows, established });
  filterExportEligibleAccounts({ detailedAccounts: acc, onboardingRows: rows, establishedAccountIds: established });
  ok("D1: the gate is PURE -- it mutates neither the detailed accounts, the onboarding rows, nor the established set",
    JSON.stringify({ acc, rows, established }) === before);
}

/* ===== E. classifyOnboardingAccount: in-progress -> ready transitions (no manual coding per account) ===== */
{
  const disc = (ready) => ({ id: "IN1", name: "IN1", country: "IN", readiness: { sellerCentralReady: ready, marketplaceId: "A21TJRUUN4KGV" } });
  const loadingT = classifyOnboardingAccount({ discovered: disc(false), existing: null });
  ok("E1: a newly connected, still-loading account is waiting_for_datadoe (visible, zero exports)",
    loadingT.row.status === ONBOARDING_STATUS.WAITING_FOR_DATADOE);
  const readyT = classifyOnboardingAccount({ discovered: disc(true), existing: { account_id: "IN1", status: ONBOARDING_STATUS.WAITING_FOR_DATADOE } });
  ok("E2: once DataDoe is ready the account transitions to ready_for_bootstrap automatically (no per-account code)",
    readyT.row.status === ONBOARDING_STATUS.READY_FOR_BOOTSTRAP && /waiting_for_datadoe->ready_for_bootstrap/.test(readyT.transition));
  const grandfathered = classifyOnboardingAccount({ discovered: disc(true), existing: null, evidence: { hasDaily: true, hasBrandSales: true, hasFbaPlan: true, hasListingHealthV3: true, oliCoveredTo: "2026-09-06", campaignCoveredTo: "2026-09-06" } });
  ok("E3: an existing fully-serving account is grandfathered straight to ready (the reconciliation seed)",
    grandfathered.row.status === ONBOARDING_STATUS.READY);
  // ready_for_bootstrap is deliberately NOT export-eligible; ready/bootstrapping/partially_ready are.
  ok("E4: ready_for_bootstrap is not yet export-eligible (waits for the atomic claim); ready IS eligible",
    !EXPORT_ELIGIBLE_STATUSES.includes(ONBOARDING_STATUS.READY_FOR_BOOTSTRAP) && EXPORT_ELIGIBLE_STATUSES.includes(ONBOARDING_STATUS.READY));
}

/* ===== F. fetchExportEligibleAccounts is a PAID path: FAIL-CLOSED when ownership is unprovable (P0-A) ===== */
{
  const detailed = [ready("US1"), ready("US2")];
  // P0-A: onboarding read AND established reader BOTH unavailable (throw) on the PAID default
  // (requireAuthoritativeScope=true) => ownership unprovable => ZERO eligible (never readiness-only exposure).
  const out1 = await fetchExportEligibleAccounts("key", {
    fetchDetailed: async () => detailed,
    readOnboardingRows: async () => { throw new Error("onboarding read boom"); },
    readEstablishedAccountIds: async () => { throw new Error("directory read boom"); },
  });
  ok("F1: on the PAID default, an unavailable onboarding read AND unavailable established evidence yields ZERO eligible (no readiness-only exposure)",
    out1.length === 0);
  // Established reader returns directory-shaped rows => reconciles ONLY those established ids from an empty table.
  const out2 = await fetchExportEligibleAccounts("key", {
    fetchDetailed: async () => detailed,
    readOnboardingRows: async () => [],
    readEstablishedAccountIds: async () => [{ accountId: "US1" }],
  });
  ok("F2: the established reader accepts {accountId} directory rows and reconciles only those ids (US1 in, US2 not exposed)",
    JSON.stringify(out2.map((a) => a.accountId || a.id)) === JSON.stringify(["US1"]));
  // Visibility path (requireAuthoritativeScope=false) still fail-soft to readiness-only for DISPLAY only.
  const vis = await fetchExportEligibleAccounts("key", {
    fetchDetailed: async () => detailed,
    readOnboardingRows: async () => [],
    requireAuthoritativeScope: false,
  });
  ok("F3: the visibility path (requireAuthoritativeScope=false) still fail-soft to readiness-only for display",
    JSON.stringify(vis.map((a) => a.accountId || a.id).sort()) === JSON.stringify(["US1", "US2"]));
}

/* ===== H. P0-A: no authoritative scope on a paid path defers (zero eligible, typed) ===== */
{
  const acc = [ready("US1"), ready("US2")];
  // Empty onboarding + no established evidence + paid path => no-authoritative-scope, ZERO eligible.
  const deferred = filterExportEligibleAccounts({ detailedAccounts: acc, onboardingRows: [], requireAuthoritativeScope: true });
  ok("H1: PAID path with NO authoritative scope (empty onboarding + no established) => zero eligible, gateMode 'no-authoritative-scope' (defers before any cycle/export)",
    deferred.eligible.length === 0 && deferred.gateMode === "no-authoritative-scope" && deferred.hasAuthoritativeScope === false
    && deferred.excluded.every((e) => e.reason === "NO_AUTHORITATIVE_SCOPE"));
  // Established evidence present => existing account stays eligible; a brand-new id stays blocked.
  const scoped = filterExportEligibleAccounts({ detailedAccounts: acc, onboardingRows: [], establishedAccountIds: ["US1"], requireAuthoritativeScope: true });
  ok("H2: with established evidence the existing account (US1) stays scheduler-eligible while the brand-new id (US2) is blocked (NOT_ONBOARDED)",
    JSON.stringify(ids(scoped.eligible)) === JSON.stringify(["US1"]) && scoped.hasAuthoritativeScope === true
    && scoped.excluded.some((e) => e.accountId === "US2" && e.reason === EXCLUDE_NOT_ONBOARDED));
  // A brand-new account never reaches a paid path directly regardless of readiness -- it must be onboarded first.
  ok("H3: a brand-new ready account is NEVER directly paid-eligible without an onboarding row or established evidence (requires the onboarding state machine)",
    filterExportEligibleAccounts({ detailedAccounts: [ready("BRAND-NEW")], onboardingRows: [], requireAuthoritativeScope: true }).eligible.length === 0);
}

/* ===== G. Source guard: the paid dispatch paths thread the established reader ===== */
{
  const pgStore = readFileSync(path.join(ROOT, "lib/server/sync/priority-control-pg-store.js"), "utf8");
  const runtime = readFileSync(path.join(ROOT, "lib/server/sync/runtime-composition.js"), "utf8");
  ok("G1: discoverPrimaryAccountIds + the production discovery both thread readEstablishedAccountIds: getAccountDirectorySnapshotAccounts",
    pgStore.includes("readEstablishedAccountIds: getAccountDirectorySnapshotAccounts")
    && runtime.includes("readEstablishedAccountIds")
    && runtime.includes("getAccountDirectorySnapshotAccounts"));
}

writeSync(1, `\naccount-onboarding-reconcile: ${passed} checks passed\n`);
