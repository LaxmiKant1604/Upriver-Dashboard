// FBA Shipment Plan REDESIGN regressions (static-source guards over the inline view in App.jsx + the .plan-page
// CSS in theme.js). The fbaplan view is rendered inline inside the App component (not a standalone export), so --
// exactly like dashboard-transition.test.mjs / hook-order.test.js -- these guards assert on the SOURCE that the
// approved flat redesign kept every handler wired, every dynamic column/group represented, missing inventory an em
// dash (never a fabricated zero), the US/non-US AWD behaviour, and introduced NO invented status; and that every FBA
// visual override is scoped under .plan-page so the SHARED .plan-*/.pt-* classes stay byte-identical for the other
// reports. LF, no top-level await.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = readFileSync(path.join(appRoot, "src/App.jsx"), "utf8");
const THEME = readFileSync(path.join(appRoot, "src/styles/theme.js"), "utf8");

// The fbaplan view slice (from `view === "fbaplan"` to the next `view === "skupl"`).
const fbaStart = APP.indexOf('view === "fbaplan" && (');
const fbaEnd = APP.indexOf('view === "skupl" && (');
assert.ok(fbaStart > 0 && fbaEnd > fbaStart, "found the fbaplan view slice");
const VIEW = APP.slice(fbaStart, fbaEnd);

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const has = (hay, needle, msg) => assert.ok(hay.includes(needle), msg + `\n  missing: ${needle}`);

/* ------------------------------------------------------ handlers stay connected */
test("existing handlers remain wired to the same callbacks", () => {
  has(VIEW, "<PlanningSettingsBar settings={planAccountSettings} onSave={savePlanSettings}", "PlanningSettingsBar keeps its save handler");
  has(VIEW, "onSave={saveWddWeights}", "WddSettingsBar keeps its WDD save handler");
  has(VIEW, "onApply={bulkImportWarehouse}", "warehouse import keeps its apply handler");
  has(VIEW, "downloadPlanSpreadsheet(planVisibleColumns, planRowsWithWdd, planData)", "Download Excel keeps the exact export call (columns + rows + data)");
  has(VIEW, "onClick={downloadLeadTimeTemplate}", "lead-time template download stays wired");
  has(VIEW, "onImportLeadTimeFile(f)", "lead-time import stays wired to the file handler");
  has(VIEW, "onToggle={(id) => planColsApi.toggle(id)}", "column chooser keeps its toggle handler");
  has(VIEW, "onSave={saveSkuHorizon}", "per-SKU horizon editor keeps its save handler");
  has(VIEW, "onRefresh={loadCachedPlan}", "the snapshot refresh stays saved-data-only (loadCachedPlan)");
  // No new export/source action is introduced by the redesign.
  for (const bad of ["createExport", "requestExport", "DataDoe.fetch", "triggerExport"]) {
    assert.ok(!VIEW.includes(bad), `the redesign introduces no source/export call ("${bad}")`);
  }
});

/* ------------------------------------------------- dynamic columns + groups kept */
test("all dynamic columns and the dynamic grouping are still rendered from the same models", () => {
  has(VIEW, "planVisibleColumns.map", "every visible column is rendered from planVisibleColumns");
  has(VIEW, "planGroupSpans.map", "the grouped header band is rendered from planGroupSpans");
  has(VIEW, "planVisibleColumns.map((c) => c.cell(r))", "each row renders every column's own cell renderer");
  has(VIEW, "planVisibleColumns.map((c) => c.foot(planTotals, planRowsWithWdd))", "the totals row renders every column's foot renderer");
  has(VIEW, "PLAN_GROUP_BAND_LABEL[g.group] || g.group", "the band uses the presentation label map, falling back to the raw group");
});

test("the group-band label map covers every column group (Identity/Sales/Forecast/Inventory/Planning)", () => {
  const mapMatch = APP.match(/const PLAN_GROUP_BAND_LABEL = \{[\s\S]*?\};/);
  assert.ok(mapMatch, "PLAN_GROUP_BAND_LABEL is defined");
  for (const g of ["Identity:", "Sales:", "Forecast:", "Inventory:", "Planning:"]) has(mapMatch[0], g, `band label map covers ${g}`);
  // The class is still derived from the raw group key (not the display label), so grouping/CSS is unchanged.
  has(VIEW, 'g.group.toLowerCase().replace(/[^a-z]+/g, "-")', "the group CSS class is still derived from the raw group key");
});

/* --------------------------------------------- US / non-US AWD behaviour preserved */
test("US/non-US AWD behaviour is unchanged (columns tagged, chooser filters, never a fake 0)", () => {
  has(APP, 'id: "awd", group: "Inventory"', "the AWD Available column still exists");
  has(APP, "awd: true", "AWD columns stay tagged so they vanish for non-US accounts");
  has(APP, "g.cols.filter((c) => isUS || !c.awd)", "the column chooser still hides AWD columns for non-US");
  has(VIEW, 'live FBA{planAwdEligible ? " + AWD" : ""}', "the subtitle still reflects AWD eligibility dynamically");
});

/* -------------------------------------------- missing inventory stays an em dash */
test("missing inventory stays an em dash -- never a fabricated zero", () => {
  // KPI cells gate every inventory total on anyInv/evaluatedCount and fall back to em dash.
  has(VIEW, 'planTotals.anyInv ? nInt(planTotals.recommended) : "—"', "Recommended Units KPI is an em dash without inventory");
  has(VIEW, 'planTotals.anyInv ? nInt(planTotals.fbaAvailable) : "—"', "FBA Available KPI is an em dash without inventory");
  has(VIEW, 'planTotals.anyInv ? nInt(planTotals.totalFbaInv) : "—"', "Total FBA Inv. KPI is an em dash without inventory");
  has(VIEW, 'planTotals.evaluatedCount > 0 ? planTotals.restockCount.toLocaleString("en-US") : "—"', "Needs Restock KPI is an em dash when nothing is evaluated");
  // Inventory column foots keep the same anyInv-gated em dash.
  has(APP, 't.anyInv ? nInt(t.fbaAvailable) : "—"', "the FBA Available column total stays an em dash without inventory");
  has(APP, 't.anyInv ? nInt(t.totalFbaInv) : "—"', "the Total FBA Inv. column total stays an em dash without inventory");
});

test("no invented status is introduced (no fake row badge or disconnected-feed language)", () => {
  for (const bad of ["Inv. Pending", "Inv Pending", "Feed disconnected", "Calculation paused"]) {
    assert.ok(!APP.includes(bad), `App.jsx must not introduce the invented status "${bad}"`);
  }
  // The real unavailable-inventory copy is preserved.
  has(VIEW, "Live FBA inventory is unavailable for this account right now", "the honest inventory-unavailable warning is preserved");
});

/* ------------------------------------------- KPI + emphasis presentation (no logic) */
test("the six KPI cells include Planning Horizon as a presentation of the existing setting", () => {
  has(VIEW, ">ASINs<", "ASINs KPI present");
  has(VIEW, ">Needs Restock<", "Needs Restock KPI present");
  has(VIEW, ">Recommended Units<", "Recommended Units KPI present");
  has(VIEW, ">FBA Available<", "FBA Available KPI present");
  has(VIEW, ">Total FBA Inv.<", "Total FBA Inv. KPI present");
  has(VIEW, ">Planning Horizon<", "Planning Horizon KPI present (the sixth cell)");
  has(VIEW, "planHorizonKpiValue(planAccountSettings.horizon)", "Planning Horizon reads the existing account setting, not a new calculation");
  has(VIEW, "PLAN_FORECAST_LABEL[planAccountSettings.forecastMethod]", "its subtext is the existing forecast-method setting");
});

test("MTD/Target get restrained blue and Recommended gets amber only when a recommendation exists", () => {
  has(APP, 'td("mtdUnits", r.mtdUnits, "mono pt-mtd")', "the MTD cell carries the pt-mtd emphasis class");
  has(APP, 'td("targetUnits", r.targetUnits, "mono pt-strong pt-target")', "the Target Units cell carries the pt-target emphasis class");
  has(APP, 'Number(r.recommended) > 0 ? " pt-reco" : ""', "the Recommended cell is amber ONLY when the value is a positive number");
  has(APP, 't.anyInv && Number(t.recommended) > 0 ? " pt-reco" : ""', "the Recommended total is amber only with inventory AND a positive recommendation");
});

/* ------------------------------------------------- methodology becomes a disclosure */
test("the methodology footer is an accessible disclosure that keeps its operational detail", () => {
  has(VIEW, '<details className="plan-methodology">', "methodology is a collapsible disclosure");
  has(VIEW, "<summary>Restock logic, inventory attribution, and lead-time calculations</summary>", "the disclosure summary matches the approved label");
  // The important attribution + AWD distinction + unavailable-data policy survive verbatim.
  has(VIEW, "Total FBA Inv.</strong> = FBA Available + Reserved (FC) + Inbound Pipeline", "the Total FBA Inv. formula is preserved");
  has(VIEW, "AWD does not apply to non-US accounts and its columns are hidden (never shown as 0)", "the non-US AWD policy is preserved");
  has(VIEW, "recompute locally without new DataDoe requests", "the zero-DataDoe policy statement is preserved");
});

/* ----------------------------------------------- CSS is scoped, no global leakage */
test("every FBA visual override is scoped under .plan-page (shared plan-*/pt-* rules untouched)", () => {
  // Pull the new FBA operational block and assert every selector line is scoped.
  const blockStart = THEME.indexOf("FBA SHIPMENT PLAN -- flat Amazon operational workspace (.plan-page)");
  const blockEnd = THEME.indexOf("---- SKU MOVEMENT (.sku-mv-page)", blockStart);
  assert.ok(blockStart > 0 && blockEnd > blockStart, "found the new .plan-page block");
  const block = THEME.slice(blockStart, blockEnd);
  const selectorLines = block.split("\n").filter((l) => /^\s*\.[A-Za-z]/.test(l));
  assert.ok(selectorLines.length > 20, "the block defines a substantial set of rules");
  for (const line of selectorLines) {
    assert.ok(line.includes(".plan-page"), `every rule in the FBA block is scoped under .plan-page:\n  ${line.trim()}`);
  }
  // The shared grouped base rule (plan-table + recon/daily/data) must NOT be part of the FBA block.
  assert.ok(!/\.plan-table,\s*\.recon-table/.test(block), "the shared grouped table selector is not redefined inside the FBA block");
  // Group bands: Historical Sales Velocity blue, Restock Decision Plan amber. The selectors must out-specify
  // `.plan-group-row th` (0,3,1) -- combining the two classes on the th (.plan-group-th.plan-group-sales) does that.
  has(block, ".plan-group-th.plan-group-sales{", "the Sales group band is styled (blue) and out-specifies the base band rule");
  has(block, ".plan-group-th.plan-group-planning{", "the Planning group band is styled (amber) and out-specifies the base band rule");
  // The MTD/Target header emphasis must out-specify the `thead tr:last-child th` neutral rule (0,3,3).
  has(block, "thead tr:last-child th.pt-mtd{", "the MTD header emphasis out-specifies the neutral header rule");
  has(block, "thead tr:last-child th.pt-target{", "the Target header emphasis out-specifies the neutral header rule");
  has(block, "#146EB4", "blue accent present");
  has(block, "#FF9900", "orange/amber accent present");
  assert.ok(!/linear-gradient/.test(block), "no gradients in the FBA block");
});

for (const t of tests) {
  try { t.fn(); passed += 1; out("  ok  " + t.name); }
  catch (e) { out("FAIL  " + t.name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; }
}
out(`\nfba-plan-redesign: ${passed}/${tests.length} checks passed`);
