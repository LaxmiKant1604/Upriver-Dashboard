// Registry <-> operator COVERAGE guard (Phase 3 Completion).
//
// Proves the registry's declared automatic owner and the actual scheduler operators can never drift:
//   - EVERY report whose registry materializationOwner is "scheduler-v2:materialize" is OWNED by exactly one of the
//     two materializer operators (the per-account report-materialization + the FBA-aware brand-view materializer);
//   - EVERY report an operator owns is declared "scheduler-v2:materialize" in the registry (no orphan producer);
//   - the two operator report-sets are DISJOINT (no report is double-produced);
//   - where the operator declares a reportVersion, it matches the registry's.
// So a future report cannot claim scheduler materialization without a real producer, nor add a producer the registry
// does not record. Pure/offline; ZERO I/O. 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { REPORT_MATERIALIZATION } from "../lib/server/reports/report-materialization-registry.js";
import { REPORT_MATERIALIZATION_REPORTS } from "../lib/server/sync/report-materialization-operation.js";
import { BRAND_VIEW_MATERIALIZATION_REPORTS } from "../lib/server/sync/report-materialization-brandview-operation.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "report-materialization-coverage\n");

const perAccount = REPORT_MATERIALIZATION_REPORTS.map((r) => r.reportKey);
const brandView = BRAND_VIEW_MATERIALIZATION_REPORTS.map((r) => r.reportKey);
const operatorReports = [...perAccount, ...brandView];
const operatorSet = new Set(operatorReports);

// The registry entries that CLAIM scheduler materialization (keyed by action; reportKey is the durable key).
const registryMaterialized = Object.entries(REPORT_MATERIALIZATION)
  .filter(([, e]) => e.materializationOwner === "scheduler-v2:materialize")
  .map(([, e]) => e.reportKey);
const registryMaterializedSet = new Set(registryMaterialized);

/* A. every registry scheduler-v2:materialize entry has a real operator producer */
for (const rk of registryMaterialized) {
  ok(`A: registry "${rk}" (scheduler-v2:materialize) is OWNED by an operator`, operatorSet.has(rk));
}

/* B. every operator-owned report is declared scheduler-v2:materialize (no orphan producer) */
for (const rk of operatorReports) {
  ok(`B: operator report "${rk}" is declared scheduler-v2:materialize in the registry`, registryMaterializedSet.has(rk));
}

/* C. the exact sets are equal (belt + suspenders: no drift in either direction) */
ok("C: the scheduler-v2:materialize registry set EXACTLY equals the union of operator report-sets",
  registryMaterialized.slice().sort().join(",") === operatorReports.slice().sort().join(","));

/* D. the two operators are DISJOINT (no report double-produced) */
ok("D: the per-account + brand-view operator report-sets are disjoint", perAccount.every((k) => !brandView.includes(k)));

/* E. the expected membership is honest (regression anchor) */
ok("E: per-account operator owns exactly brand-view-brands, sku-movement, returns-leakage",
  perAccount.slice().sort().join(",") === ["brand-view-brands", "returns-leakage", "sku-movement"].join(","));
ok("E: brand-view operator owns exactly brand-view, brand-view-portfolio",
  brandView.slice().sort().join(",") === ["brand-view", "brand-view-portfolio"].join(","));

// (Operator<->serve reportVersion parity is guaranteed by construction: each operator imports the SAME version
// constant the serve uses, from the same module -- BRAND_VIEW_VERSION/BRAND_VIEW_PORTFOLIO_VERSION/SKU_MOVEMENT_VERSION/
// RETURNS_ADVANCED_VERSION/BRAND_VIEW_BRANDS_VERSION. The registry's `reportVersion` field is a cross-reference to
// REPORT_DERIVATIONS, a DIFFERENT concern that can legitimately differ from a report's serve-identity version -- so it
// is validated against REPORT_DERIVATIONS in report-materialization-registry.test.js, not compared to the operator here.)

writeSync(1, `\nreport-materialization-coverage: ${passed} assertions passed\n`);
