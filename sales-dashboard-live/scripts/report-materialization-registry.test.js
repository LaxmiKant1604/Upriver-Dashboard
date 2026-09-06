// CANONICAL REPORT-MATERIALIZATION REGISTRY guard (Phase 2 release-guard).
//
// Proves (a) the live registry is complete + internally consistent against the authoritative REPORT_CAPABILITIES,
// REPORT_DERIVATIONS and REPORT_SOURCE_CONTRACTS; and (b) the STRUCTURAL PREVENTION contract -- a future report cannot
// ship without a complete declaration AND a backend materialization path: a new capability with no entry, a missing
// declaration field, a non-backend materialization owner, a NON_REPORT entry, an omitted contract source, or a
// capability mismatch all FAIL validation. Pure/offline; ZERO I/O. 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import {
  REPORT_MATERIALIZATION, MATERIALIZATION_OWNERS, REQUIRED_DECLARATION_FIELDS,
  validateReportMaterializationRegistry,
} from "../lib/server/reports/report-materialization-registry.js";
import { REPORT_CAPABILITIES, CAPABILITY, isBrandAccessible } from "../lib/server/report-authorization.js";
import { REPORT_SOURCE_CONTRACTS } from "../lib/server/sync/report-source-contracts.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
const throwsWith = (n, fn, re) => { let msg = null; try { fn(); } catch (e) { msg = String(e && e.message || e); } ok(n, msg != null && (!re || re.test(msg))); };
writeSync(1, "report-materialization-registry\n");

const reportActions = Object.entries(REPORT_CAPABILITIES).filter(([, c]) => c !== CAPABILITY.NON_REPORT).map(([a]) => a);
const clone = () => JSON.parse(JSON.stringify(REPORT_MATERIALIZATION));

/* ===================== A. the LIVE registry is valid + complete ===================== */
(() => {
  const r = validateReportMaterializationRegistry();
  ok("A: the live registry validates against capabilities/derivations/contracts", r.ok === true);
  ok("A: it covers every REPORT capability (non NON_REPORT) exactly", r.reports === reportActions.length && reportActions.every((a) => a in REPORT_MATERIALIZATION));
  ok("A: no NON_REPORT action is declared", !Object.keys(REPORT_MATERIALIZATION).some((a) => REPORT_CAPABILITIES[a] === CAPABILITY.NON_REPORT));
  ok("A: every entry declares a BACKEND materialization path (owner from the enum)", Object.values(REPORT_MATERIALIZATION).every((e) => MATERIALIZATION_OWNERS.includes(e.materializationOwner)));
  ok("A: every entry declares provenance fields (no dash without a machine-readable reason)", Object.values(REPORT_MATERIALIZATION).every((e) => Array.isArray(e.provenanceFields) && e.provenanceFields.length > 0));
})();

/* ===================== B. STRUCTURAL PREVENTION -- a future undeclared report FAILS ===================== */
throwsWith("B: a new report capability with NO materialization entry fails (a new report must declare one)",
  () => validateReportMaterializationRegistry({ capabilities: { ...REPORT_CAPABILITIES, "brand-new-report": CAPABILITY.BRAND_FILTERABLE } }),
  /brand-new-report.*NO report-materialization entry/);

/* ===================== C. an incomplete declaration FAILS ===================== */
throwsWith("C: a missing required declaration field fails", () => {
  const reg = clone(); delete reg["brand-sales"].grain;
  validateReportMaterializationRegistry({ registry: reg });
}, /missing required declaration field "grain"/);

throwsWith("C: a non-BACKEND materialization owner (page-open-only) fails", () => {
  const reg = clone(); reg["brand-sales"].materializationOwner = "page-open-only";
  validateReportMaterializationRegistry({ registry: reg });
}, /materializationOwner .* not a declared BACKEND materialization path/);

throwsWith("C: an empty required-source list fails", () => {
  const reg = clone(); reg["brand-sales"].requiredSources = [];
  validateReportMaterializationRegistry({ registry: reg });
}, /at least one required durable source/);

throwsWith("C: dropping all provenance fields fails", () => {
  const reg = clone(); reg["brand-sales"].provenanceFields = [];
  validateReportMaterializationRegistry({ registry: reg });
}, /at least one provenance field/);

/* ===================== D. a NON_REPORT entry FAILS ===================== */
throwsWith("D: declaring a NON_REPORT action (accounts) in the registry fails", () => {
  const reg = clone(); reg["accounts"] = { ...reg["brand-sales"], reportKey: "accounts", capability: CAPABILITY.NON_REPORT };
  validateReportMaterializationRegistry({ registry: reg });
}, /NON_REPORT action and must not be declared/);

/* ===================== E. an omitted contract-owned source FAILS ===================== */
throwsWith("E: omitting a contract-owned source from the declared deps fails", () => {
  const reg = clone();
  // fba-plan's contract owns fba-inventory-health + listings; drop both from the declaration.
  reg["fba-plan"].requiredSources = ["order-line-items"]; reg["fba-plan"].optionalSources = [];
  validateReportMaterializationRegistry({ registry: reg });
}, /omits contract-owned source/);

/* ===================== F. a capability mismatch FAILS ===================== */
throwsWith("F: a declared capability that disagrees with REPORT_CAPABILITIES fails", () => {
  const reg = clone(); reg["fba-plan"].capability = CAPABILITY.BRAND_FILTERABLE; // real value is DENY_FOR_BRAND_RESTRICTED_USERS
  validateReportMaterializationRegistry({ registry: reg });
}, /declares capability .* but REPORT_CAPABILITIES says/);

/* ===================== G. cross-registry chain: capability set <-> materialization set are identical ============ */
(() => {
  const matReports = new Set(Object.keys(REPORT_MATERIALIZATION));
  ok("G: the materialization report set EXACTLY equals the non-NON_REPORT capability set", matReports.size === reportActions.length && reportActions.every((a) => matReports.has(a)));
  // Every entry with a source contract declares (at least) its contract-owned sources.
  ok("G: every report that has a source contract declares all its contract-owned sources", Object.entries(REPORT_MATERIALIZATION).every(([a, e]) => {
    const contract = REPORT_SOURCE_CONTRACTS[e.reportKey];
    if (!contract) return true;
    const declared = new Set([...(e.requiredSources || []), ...(e.optionalSources || [])]);
    return [...new Set(contract.map((c) => c.sourceKey))].every((s) => declared.has(s));
  }));
})();

/* ===================== H. the registry honestly records the page-open-write gap (documented, not hidden) ========= */
(() => {
  const pageOpenWriters = Object.entries(REPORT_MATERIALIZATION).filter(([, e]) => e.pageOpenWrite).map(([a]) => a).sort();
  // These are the reports whose plain GET currently writes a snapshot (zero DataDoe self-heal) -- the honest set the
  // later scheduler-move must address. Recorded so a change to it is reviewable; brand-accessible ones stay projectable.
  ok("H: the page-open-write reports are exactly the known zero-export self-heal set", JSON.stringify(pageOpenWriters) === JSON.stringify(["brand-directory", "brand-view-brands", "daily", "returns-leakage", "sku-movement"]));
  ok("H: every declared field name is one of the required declaration fields (no typos leak in)", Object.values(REPORT_MATERIALIZATION).every((e) => Object.keys(e).every((k) => REQUIRED_DECLARATION_FIELDS.includes(k))));
  ok("H: brand-accessible reports remain brand-accessible in the registry (capability parity)", Object.entries(REPORT_MATERIALIZATION).every(([a, e]) => isBrandAccessible(e.capability) === isBrandAccessible(REPORT_CAPABILITIES[a])));
})();

/* ===================== I. PHASE 3 read-only invariants (browser-triggered writes) ===================== */
(() => {
  // Every report declares clientOpenTriggeredWrite, and after Phase 3 it is FALSE for ALL of them (the two brand-view
  // auto-converge effects now poll read-only).
  ok("I: every entry declares clientOpenTriggeredWrite=false (no browser converge/poll calls the write endpoint)",
    Object.values(REPORT_MATERIALIZATION).every((e) => e.clientOpenTriggeredWrite === false));
  ok("I: the live registry reports pageOpenWriters count equal to the grandfathered allowlist size (5)",
    validateReportMaterializationRegistry().pageOpenWriters === 5);
})();

// A NEW report cannot ship a page-open snapshot write (not in the shrinking grandfathered allowlist).
throwsWith("I: a NEW report with pageOpenWrite=true (not grandfathered) fails", () => {
  const reg = clone();
  reg["shiny-new"] = {
    ...clone()["sku-movement"], reportKey: "shiny-new", capability: CAPABILITY.BRAND_FILTERABLE,
    serveMode: "self-heal-write-on-read", materializationOwner: "serve:self-heal", pageOpenWrite: true, clientOpenTriggeredWrite: false,
  };
  validateReportMaterializationRegistry({ registry: reg, capabilities: { ...REPORT_CAPABILITIES, "shiny-new": CAPABILITY.BRAND_FILTERABLE } });
}, /NOT in PAGE_OPEN_WRITE_GRANDFATHERED/);

// A report may never reintroduce a client-open-triggered (browser page-open) write.
throwsWith("I: a report that flags clientOpenTriggeredWrite=true fails (allowlist is empty)", () => {
  const reg = clone(); reg["brand-view"].clientOpenTriggeredWrite = true;
  validateReportMaterializationRegistry({ registry: reg });
}, /clientOpenTriggeredWrite:true/);

// The write flag cannot hide behind a read-looking serve mode (biconditional).
throwsWith("I: pageOpenWrite=true with a non-self-heal serve mode fails", () => {
  const reg = clone(); reg["brand-sales"].pageOpenWrite = true; // brand-sales serveMode is read-snapshot
  validateReportMaterializationRegistry({ registry: reg });
}, /page-open write must serve via self-heal-write-on-read/);

throwsWith("I: a self-heal serve mode with pageOpenWrite=false fails", () => {
  const reg = clone(); reg["brand-inventory"].serveMode = "self-heal-write-on-read"; // pageOpenWrite is false
  validateReportMaterializationRegistry({ registry: reg });
}, /self-heal serve DOES write on a read miss/);

// The grandfather must stay in lockstep: making a grandfathered report read-only without shrinking the allowlist fails.
throwsWith("I: flipping a grandfathered report to read-only without shrinking the allowlist fails (lockstep)", () => {
  const reg = clone(); reg["daily"].pageOpenWrite = false; reg["daily"].serveMode = "read-snapshot"; // now not a page-open writer
  validateReportMaterializationRegistry({ registry: reg });
}, /must EQUAL the set of reports declaring pageOpenWrite:true/);

// A NON-self-heal materialization owner that still flags a page-open write is caught (owner->write consistency).
throwsWith("I: a serve:self-heal owner with pageOpenWrite not true fails", () => {
  const reg = clone(); reg["brand-directory"].pageOpenWrite = false; reg["brand-directory"].serveMode = "read-snapshot";
  validateReportMaterializationRegistry({ registry: reg });
}, /must EQUAL the set of reports declaring pageOpenWrite:true|self-heal owner writes on a read miss/);

writeSync(1, `\nreport-materialization-registry: ${passed} assertions passed\n`);
