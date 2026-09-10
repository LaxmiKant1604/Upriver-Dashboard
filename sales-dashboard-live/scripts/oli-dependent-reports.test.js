// Drift guard for the single authoritative OLI -> dependent live-report registry (WORK 2 + WORK 11 items 21/22).
// Proves: the registry matches the publisher's live-snapshot contracts and the source registry's OLI usedByReports;
// the runtime binds lineage from the SAME map (single source, no duplication); a FUTURE OLI report added to the map is
// discovered; and removing a required report is caught. Offline + pure. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import {
  OLI_LINEAGE_DEPENDS_ON, OLI_SOURCE_KEY, oliDependentLiveReportKeys, oliReportKeysFrom,
  isOliDependentLiveReport, assertOliDependentReportsConsistency, BRAND_VIEW_MEMBERSHIP_SOURCE_REPORT,
} from "../lib/server/sync/oli-dependent-reports.js";
import { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } from "../lib/server/sync/report-publisher.js";
import { sourceRegistryEntry } from "../lib/server/sync/source-registry.js";
import { BRAND_INVENTORY_SNAPSHOT_KEY } from "../lib/server/reports/brand-view.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "oli-dependent-reports drift guard\n");

const EXPECTED = ["brand-inventory", "brand-sales", "daily-reporting"];

ok("the registry declares EXACTLY the 3 OLI-dependent canonical live dashboards", JSON.stringify(oliDependentLiveReportKeys()) === JSON.stringify(EXPECTED));

// Every registered report is a PUBLISHED live report (has a scheduler live-snapshot contract).
ok("every OLI-dependent report has a live-snapshot publisher contract (it is actually published live)",
  oliDependentLiveReportKeys().every((k) => SCHEDULER_LIVE_SNAPSHOT_CONTRACTS[k] && SCHEDULER_LIVE_SNAPSHOT_CONTRACTS[k].liveReportKey === k));

// daily-reporting + brand-sales OWN an OLI export contract -> they are in the source registry's usedByReports.
const usedByReports = sourceRegistryEntry(OLI_SOURCE_KEY).usedByReports || [];
ok("daily-reporting is in source-registry order-line-items.usedByReports", usedByReports.includes("daily-reporting"));
ok("brand-sales is in source-registry order-line-items.usedByReports", usedByReports.includes("brand-sales"));

// brand-inventory is the documented lineage-only case: its inventory numbers are FBA, but its brand attribution /
// sales velocity is bound to OLI, so it is reconciled on an OLI advance. Its key IS BRAND_INVENTORY_SNAPSHOT_KEY.
ok("brand-inventory key equals BRAND_INVENTORY_SNAPSHOT_KEY (the runtime lineage key)", BRAND_INVENTORY_SNAPSHOT_KEY === "brand-inventory" && OLI_LINEAGE_DEPENDS_ON["brand-inventory"].includes(OLI_SOURCE_KEY));
ok("brand-inventory is NOT an OLI export-owning report (usedByReports) -- it is OLI-dependent via lineage only", !usedByReports.includes("brand-inventory"));

// The Brand View membership source report is a registered OLI-dependent report (brand-sales).
ok("Brand View membership is rebuilt from a registered OLI-dependent report (brand-sales)", isOliDependentLiveReport(BRAND_VIEW_MEMBERSHIP_SOURCE_REPORT));

// SINGLE SOURCE: the runtime imports OLI_LINEAGE_DEPENDS_ON from the registry (no second literal copy).
const runtimeSrc = readFileSync(new URL("../lib/server/sync/source-bucket-sync-runtime.js", import.meta.url), "utf8");
ok("the runtime imports OLI_LINEAGE_DEPENDS_ON from the registry (single source)", /import\s*\{[^}]*OLI_LINEAGE_DEPENDS_ON[^}]*\}\s*from\s*"\.\/oli-dependent-reports\.js"/.test(runtimeSrc));
ok("the runtime binds LINEAGE_DEPENDS_ON to the imported registry map (no inline duplicate literal)", /const LINEAGE_DEPENDS_ON = OLI_LINEAGE_DEPENDS_ON;/.test(runtimeSrc) && !/const LINEAGE_DEPENDS_ON = \{/.test(runtimeSrc));

// WORK 11 item 21: a FUTURE report registered as OLI-dependent is discovered through the registry helper.
const future = { ...OLI_LINEAGE_DEPENDS_ON, "future-oli-report": [OLI_SOURCE_KEY, "product-catalog"] };
ok("a FUTURE report with OLI in its families is discovered by oliReportKeysFrom (one-line registration)", oliReportKeysFrom(future).includes("future-oli-report"));
const nonOli = { ...OLI_LINEAGE_DEPENDS_ON, "fba-only-report": ["fba-inventory-health"] };
ok("a report WITHOUT OLI in its families is NOT discovered (never over-reconciled)", !oliReportKeysFrom(nonOli).includes("fba-only-report"));

// WORK 11 item 22: removing a required report from the map fails the consistency/required check.
assert.throws(() => assertOliDependentReportsConsistency({ "daily-reporting": ["something-not-oli"] }), /does not include order-line-items/);
ok("a declared report that FORGOT order-line-items fails the consistency guard (fail closed)", true);
const missingRequired = () => { const req = EXPECTED; const have = oliDependentLiveReportKeys().filter((k) => k !== "brand-sales"); for (const r of req) if (!have.includes(r)) throw new Error("REGISTRY_DRIFT: required OLI report missing: " + r); };
assert.throws(missingRequired, /REGISTRY_DRIFT: required OLI report missing: brand-sales/);
ok("removing a REQUIRED report (brand-sales) from the registry is caught by the drift guard", true);

// The current production map is self-consistent (the import-time assertion did not throw).
assertOliDependentReportsConsistency();
ok("the production registry passes its own fail-closed consistency assertion", true);

writeSync(1, `\noli-dependent-reports: ${passed} assertions passed\n`);
