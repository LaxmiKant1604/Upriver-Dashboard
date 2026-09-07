// PRIMARY account onboarding -- classification, export-eligibility gate, directory-snapshot merge.
// Reproduces the 2026-09-06 incidents (ready accounts invisible; loading accounts spending paid
// creates) as permanent regressions. ZERO I/O; 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import {
  ONBOARDING_STATUS, EXPORT_ELIGIBLE_STATUSES, UNSUPPORTED_MARKETPLACE,
  EXCLUDE_DATADOE_NOT_READY, EXCLUDE_NOT_ONBOARDED,
  bootstrapOperationId, accountDataDoeReady, toLegacyAccountShape, gradeBootstrapEvidence,
  classifyOnboardingAccount, filterExportEligibleAccounts, mergeOnboardingIntoDirectorySnapshot,
  fetchExportEligibleAccounts,
} from "../lib/server/sync/account-onboarding.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); };
writeSync(1, "account-onboarding\n");

const detailed = (id, country, { ready = true, name = null, rowCount = 1000, adsConnected = true, adsReady = true } = {}) => ({
  id, name: name || `Account ${id}`, country, countryName: country, currency: "USD", locale: "en-US", timeZone: "UTC",
  readiness: {
    sellerCentralReady: ready, rowCount, sellerCentralRowCount: Math.floor(rowCount / 2),
    adsConnected, adsReady, adsRowCount: adsConnected ? 10 : null, accountType: "SELLER", marketplaceId: "M1",
  },
});

/* ===================== A. readiness is initialLoadComplete, NEVER mere presence ===================== */
(() => {
  ok("A: sellerCentralReady true => ready", accountDataDoeReady(detailed("a", "IN")) === true);
  ok("A: sellerCentralReady false => NOT ready (the account ID existing is never readiness)",
    accountDataDoeReady(detailed("a", "IN", { ready: false })) === false);
  ok("A: a legacy account object with NO readiness evidence is NOT ready (fail closed)",
    accountDataDoeReady({ id: "a", name: "x", country: "IN" }) === false);
  const legacy = toLegacyAccountShape(detailed("a", "IN"));
  ok("A: toLegacyAccountShape strips readiness and keeps the exact legacy fields",
    !("readiness" in legacy) && Object.keys(legacy).sort().join(",") === "country,countryName,currency,id,locale,name,timeZone");
})();

/* ===================== B. classification transitions ===================== */
(() => {
  const now = Date.parse("2026-09-06T12:00:00Z");
  // New loading account -> waiting_for_datadoe.
  const w = classifyOnboardingAccount({ discovered: detailed("acct-load", "IT", { ready: false }), now });
  ok("B: new loading account => waiting_for_datadoe (zero paid exports)",
    w.row.status === ONBOARDING_STATUS.WAITING_FOR_DATADOE && w.transition === "new:waiting_for_datadoe");
  ok("B: readiness/progress fields are PRESERVED on the row (not dropped)",
    w.row.datadoe_ready === false && w.row.datadoe_row_count === 1000 && w.row.ads_connected === true && w.row.marketplace_id === "M1");
  // New ready account with no evidence -> ready_for_bootstrap (awaiting the atomic claim).
  const r = classifyOnboardingAccount({ discovered: detailed("acct-new", "IN"), now });
  ok("B: new ready account => ready_for_bootstrap + ready_at stamped",
    r.row.status === ONBOARDING_STATUS.READY_FOR_BOOTSTRAP && !!r.row.ready_at);
  // in-progress -> ready AUTOMATICALLY starts the bootstrap path (waiting -> ready_for_bootstrap).
  const flip = classifyOnboardingAccount({ discovered: detailed("acct-load", "IT", { ready: true }), existing: w.row, now: now + 900000 });
  ok("B: in-progress -> ready flips waiting_for_datadoe => ready_for_bootstrap automatically",
    flip.row.status === ONBOARDING_STATUS.READY_FOR_BOOTSTRAP && flip.transition === "waiting_for_datadoe->ready_for_bootstrap");
  // GRANDFATHER: a ready account already FULLY serving (the pre-onboarding scheduler population) is ready outright.
  const evidence = { oliCoveredFrom: "2024-12-31", oliCoveredTo: "2026-09-04", hasDaily: true, hasBrandSales: true };
  const g = classifyOnboardingAccount({ discovered: detailed("acct-live", "FR"), evidence, now });
  ok("B: a ready account ALREADY fully serving => ready outright (no second bootstrap)",
    g.row.status === ONBOARDING_STATUS.READY && !!g.row.bootstrap_completed_at);
  // bootstrapping grades forward on evidence; never regressed by a readiness flap.
  const boot = { ...r.row, status: ONBOARDING_STATUS.BOOTSTRAPPING, operation_id: "account-bootstrap/acct-new/2026-09-06" };
  const partial = classifyOnboardingAccount({ discovered: detailed("acct-new", "IN"), existing: boot, evidence: { oliCoveredTo: "2026-09-05" }, now });
  ok("B: bootstrapping + partial evidence => partially_ready", partial.row.status === ONBOARDING_STATUS.PARTIALLY_READY);
  const full = classifyOnboardingAccount({ discovered: detailed("acct-new", "IN"), existing: boot, evidence, now });
  ok("B: bootstrapping + full evidence => ready + bootstrap_completed_at", full.row.status === ONBOARDING_STATUS.READY && !!full.row.bootstrap_completed_at);
  const flap = classifyOnboardingAccount({ discovered: detailed("acct-new", "IN", { ready: false }), existing: { ...full.row, bootstrap_completed_at: "2026-09-06T12:00:00.000Z" }, now });
  ok("B: a DataDoe readiness FLAP never regresses a ready account (LKG status kept; datadoe_ready records the live bit)",
    flap.row.status === ONBOARDING_STATUS.READY && flap.row.datadoe_ready === false);
  // Losing readiness BEFORE the claim returns to waiting (zero exports).
  const back = classifyOnboardingAccount({ discovered: detailed("acct-new", "IN", { ready: false }), existing: r.row, now });
  ok("B: losing readiness before the claim => back to waiting_for_datadoe", back.row.status === ONBOARDING_STATUS.WAITING_FOR_DATADOE);
})();

/* ===================== C. unsupported marketplace => blocked, never routed ===================== */
(() => {
  const b = classifyOnboardingAccount({ discovered: detailed("acct-xx", "XX") });
  ok("C: an unsupported marketplace is stored BLOCKED with the typed failure code",
    b.row.status === ONBOARDING_STATUS.BLOCKED && b.row.failure_code === UNSUPPORTED_MARKETPLACE && b.row.region === "unassigned");
  const gate = filterExportEligibleAccounts({
    detailedAccounts: [detailed("acct-xx", "XX")],
    onboardingRows: [{ account_id: "acct-xx", status: ONBOARDING_STATUS.BLOCKED }],
  });
  ok("C: a blocked account is NEVER export-eligible (never silently routed)",
    gate.eligible.length === 0 && gate.excluded[0].reason === "ONBOARDING_BLOCKED");
  ok("C: every supported marketplace routes to a region (IE/SE included in europe-au)",
    classifyOnboardingAccount({ discovered: detailed("a", "IE") }).row.region === "europe-au"
    && classifyOnboardingAccount({ discovered: detailed("b", "SE") }).row.region === "europe-au"
    && classifyOnboardingAccount({ discovered: detailed("c", "IN") }).row.region === "india"
    && classifyOnboardingAccount({ discovered: detailed("d", "CA") }).row.region === "us-ca");
})();

/* ===================== D. THE EXPORT GATE: in-progress accounts create ZERO exports ===================== */
(() => {
  const accounts = [
    detailed("acct-live", "IN"),                       // ready + onboarded ready
    detailed("acct-load", "IT", { ready: false }),     // DataDoe still loading (the incident class)
    detailed("acct-new", "US"),                        // ready but not yet claimed
    detailed("acct-boot", "DE"),                       // ready + claimed (bootstrapping)
  ];
  const rows = [
    { account_id: "acct-live", status: ONBOARDING_STATUS.READY },
    { account_id: "acct-load", status: ONBOARDING_STATUS.WAITING_FOR_DATADOE },
    { account_id: "acct-new", status: ONBOARDING_STATUS.READY_FOR_BOOTSTRAP },
    { account_id: "acct-boot", status: ONBOARDING_STATUS.BOOTSTRAPPING },
  ];
  const gated = filterExportEligibleAccounts({ detailedAccounts: accounts, onboardingRows: rows });
  ok("D: onboarding mode includes ONLY ready/partially_ready/bootstrapping accounts",
    gated.gateMode === "onboarding" && gated.eligible.map((a) => a.id).join(",") === "acct-live,acct-boot");
  ok("D: a DataDoe IN-PROGRESS account is excluded with the typed reason (ZERO paid exports)",
    gated.excluded.some((x) => x.accountId === "acct-load" && x.reason === EXCLUDE_DATADOE_NOT_READY));
  ok("D: a readiness-proven but UNCLAIMED account waits for its atomic claim (excluded)",
    gated.excluded.some((x) => x.accountId === "acct-new" && x.reason === "ONBOARDING_READY_FOR_BOOTSTRAP"));
  // FAIL-SOFT: table unreadable -> readiness-only mode. Loading accounts STAY excluded; ready ones stay included.
  const soft = filterExportEligibleAccounts({ detailedAccounts: accounts, onboardingRows: null });
  ok("D: fail-soft (table unreadable) => readiness-only mode: every DataDoe-ready account included, loading STILL excluded",
    soft.gateMode === "readiness-only"
    && soft.eligible.map((a) => a.id).join(",") === "acct-live,acct-new,acct-boot"
    && soft.excluded.length === 1 && soft.excluded[0].reason === EXCLUDE_DATADOE_NOT_READY);
  // A brand-new account with NO onboarding row, in an INITIALISED (non-empty) table, fails closed
  // (routed through onboarding; no unclaimed bootstrap). Setup uses a populated table so the strict
  // onboarding gate applies -- an EMPTY table now means "subsystem uninitialised" (see the next case).
  const noRow = filterExportEligibleAccounts({ detailedAccounts: [detailed("acct-ghost", "IN")], onboardingRows: [{ account_id: "other-acct", status: ONBOARDING_STATUS.READY }] });
  ok("D: a brand-new account with NO onboarding row (initialised table) is excluded NOT_ONBOARDED until the worker classifies it",
    noRow.eligible.length === 0 && noRow.excluded[0].reason === EXCLUDE_NOT_ONBOARDED);
  // FIX (US-CA outage): an EMPTY onboarding table is NOT authoritative evidence of exclusion -- it means the
  // subsystem is uninitialised, so the gate falls back to readiness-only and never blanket-excludes existing
  // DataDoe-ready accounts as NOT_ONBOARDED.
  const emptyTable = filterExportEligibleAccounts({ detailedAccounts: [detailed("acct-ghost", "IN")], onboardingRows: [] });
  ok("D: an EMPTY onboarding table falls back to readiness-only (existing DataDoe-ready accounts stay eligible; not blanket NOT_ONBOARDED)",
    emptyTable.gateMode === "readiness-only" && emptyTable.eligible.length === 1 && emptyTable.excluded.length === 0);
})();

/* ===================== E. the composed gated fetch (legacy shape; typed reporting) ===================== */
await (async () => {
  const accounts = [detailed("acct-live", "IN"), detailed("acct-load", "IT", { ready: false })];
  const rows = [{ account_id: "acct-live", status: ONBOARDING_STATUS.READY }];
  let reported = null;
  const out = await fetchExportEligibleAccounts("key", {
    fetchDetailed: async () => accounts,
    readOnboardingRows: async () => rows,
    onExcluded: (excluded, gateMode) => { reported = { excluded, gateMode }; },
  });
  ok("E: gated fetch returns ONLY eligible accounts in the exact legacy shape",
    out.length === 1 && out[0].id === "acct-live" && !("readiness" in out[0]));
  ok("E: exclusions are reported typed (never silently dropped)",
    reported && reported.gateMode === "onboarding" && reported.excluded[0].accountId === "acct-load");
  // P0-A: on the PAID default (requireAuthoritativeScope=true), a throwing onboarding read with NO established
  // evidence yields ZERO eligible -- ownership is unprovable, so no readiness-only exposure on a paid path.
  const noScope = await fetchExportEligibleAccounts("key", {
    fetchDetailed: async () => accounts,
    readOnboardingRows: async () => { throw new Error("table missing"); },
  });
  ok("E(P0-A): a throwing onboarding read with NO established evidence fails CLOSED on the paid path (zero eligible, never readiness-only)",
    noScope.length === 0);
  // But established directory evidence still serves the existing account (the outage stays fixed safely).
  const viaEstablished = await fetchExportEligibleAccounts("key", {
    fetchDetailed: async () => accounts,
    readOnboardingRows: async () => { throw new Error("table missing"); },
    readEstablishedAccountIds: async () => [{ accountId: "acct-live" }],
  });
  ok("E(P0-A): with durable established evidence the existing account is still served (reconciled) despite an unreadable onboarding table",
    viaEstablished.length === 1 && viaEstablished[0].id === "acct-live");
})();

/* ===================== F. ready-but-missing account becomes VISIBLE (the Cruchlorent/Rugs4Less repro) ===================== */
(() => {
  // The live snapshot held 30 accounts; 4 fully-serving ready accounts were absent. The merge adds a
  // ready account as active + NOT settingUp; a loading account as active + settingUp ("Setting up").
  const prior = [{ id: "acct-old", name: "Old", country: "IN", currency: "INR", active: true }];
  const merge = mergeOnboardingIntoDirectorySnapshot({
    priorAccounts: prior,
    detailedAccounts: [detailed("acct-missing-ready", "IT"), detailed("acct-loading", "ES", { ready: false })],
    onboardingRows: [
      { account_id: "acct-missing-ready", status: ONBOARDING_STATUS.READY },
      { account_id: "acct-loading", status: ONBOARDING_STATUS.WAITING_FOR_DATADOE },
    ],
  });
  ok("F: merge is ADDITIVE (prior entries untouched; nothing removed)",
    merge.changed === true && merge.accounts.length === 3 && merge.accounts[0] === merge.accounts.find((a) => a.id === "acct-old")
    && JSON.stringify(merge.accounts[0]) === JSON.stringify(prior[0]));
  const readyEntry = merge.accounts.find((a) => a.id === "acct-missing-ready");
  ok("F: a READY-but-missing account appears active + NOT settingUp (fully selectable)",
    readyEntry.active === true && readyEntry.settingUp === false && readyEntry.onboardingStatus === "ready");
  const loadingEntry = merge.accounts.find((a) => a.id === "acct-loading");
  ok("F: a LOADING account appears active + settingUp (admins see 'Setting up' before any report data)",
    loadingEntry.active === true && loadingEntry.settingUp === true && loadingEntry.onboardingStatus === "waiting_for_datadoe");
  // Idempotent: re-merging the same state changes nothing.
  const again = mergeOnboardingIntoDirectorySnapshot({
    priorAccounts: merge.accounts,
    detailedAccounts: [detailed("acct-missing-ready", "IT"), detailed("acct-loading", "ES", { ready: false })],
    onboardingRows: [
      { account_id: "acct-missing-ready", status: ONBOARDING_STATUS.READY },
      { account_id: "acct-loading", status: ONBOARDING_STATUS.WAITING_FOR_DATADOE },
    ],
  });
  ok("F: re-merging the same state is a no-op (changed=false; zero duplicate entries)",
    again.changed === false && again.accounts.length === 3);
  // Graduation: loading -> ready clears settingUp on the existing entry.
  const grad = mergeOnboardingIntoDirectorySnapshot({
    priorAccounts: merge.accounts,
    detailedAccounts: [detailed("acct-loading", "ES")],
    onboardingRows: [{ account_id: "acct-loading", status: ONBOARDING_STATUS.READY }],
  });
  ok("F: graduation clears settingUp on the existing entry (no duplicate row)",
    grad.changed === true && grad.accounts.length === 3 && grad.accounts.find((a) => a.id === "acct-loading").settingUp === false);
})();

/* ===================== G. operation identity + evidence grading ===================== */
(() => {
  ok("G: bootstrapOperationId is deterministic (account-bootstrap/<id>/<discoveredDate>)",
    bootstrapOperationId("acct-1", "2026-09-06") === "account-bootstrap/acct-1/2026-09-06");
  let threw = false; try { bootstrapOperationId("acct-1", "not-a-date"); } catch { threw = true; }
  ok("G: a malformed discovered date fails closed", threw);
  ok("G: evidence grading -- full requires OLI + daily + brand-sales; anything alone is partial",
    gradeBootstrapEvidence({ oliCoveredTo: "2026-09-05", hasDaily: true, hasBrandSales: true }).fully === true
    && gradeBootstrapEvidence({ oliCoveredTo: "2026-09-05" }).fully === false
    && gradeBootstrapEvidence({ oliCoveredTo: "2026-09-05" }).partially === true
    && gradeBootstrapEvidence({}).partially === false);
})();

/* ===================== H. source guards: serving filters + gate wiring stay in place ===================== */
(() => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const read = (p) => readFileSync(path.join(root, p), "utf8");
  const api = read("api/datadoe.js");
  ok("H: the accounts serve keeps the admin/permission projection (admins all; others only granted accounts)",
    /access\.role === "admin"\s*\?\s*selectable/.test(api));
  const sb = read("lib/server/supabase.js");
  ok("H: getAccountDirectorySnapshotAccounts excludes settingUp entries (operator scope never sees them)",
    /settingUp === true/.test(sb.slice(sb.indexOf("getAccountDirectorySnapshotAccounts"))));
  const rc = read("lib/server/sync/runtime-composition.js");
  ok("H: makeProductionDiscoverAccounts routes the primary connection through the export-eligibility gate",
    /fetchExportEligibleAccounts\(/.test(rc));
  for (const p of [
    "lib/server/sync/priority-control-pg-store.js",
    "lib/server/sync/scheduled-campaign-ads-runner.js",
    "scripts/release/oli-refresh-d1.mjs",
    "scripts/release/verify-bucket-readiness.mjs",
    "scripts/release/verify-us-d1-published.mjs",
    "scripts/release/scheduled-cycle-preflight.mjs",
  ]) {
    ok(`H: ${p} discovery goes through fetchExportEligibleAccounts`, /fetchExportEligibleAccounts/.test(read(p)));
  }
})();

writeSync(1, `\naccount-onboarding: ${passed} assertions passed\n`);
