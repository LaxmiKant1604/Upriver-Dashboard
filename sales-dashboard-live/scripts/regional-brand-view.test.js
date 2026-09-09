// Regional Brand View -- server region enforcement + end-to-end wiring (offline, source-invariant).
//
// A. Behavioural unit tests of lib/server/reports/region-scope.js (the server's region authority): a browser region
//    is validated but never trusted to define membership; the account set is re-filtered from TRUSTED country, so a
//    tampered request cannot smuggle a cross-region account into a region rollup, and an unknown marketplace is
//    fail-closed OUT of every region.
// B. Static-source assertions that the pieces are actually wired: the datadoe portfolio route validates + filters +
//    segregates the snapshot by region; BrandPortfolio sends region; the header exposes the global Account/Brand view
//    switch on every scoped page with a Region selector and searchable comboboxes; App scopes the brand list/accounts
//    to the region and remembers/restores the account-context report.
//
// 7-bit ASCII, LF, no top-level await.

import assert from "node:assert/strict";
import { readFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { normalizeRegionParam, filterAccountIdsToRegion, RegionScopeError, isRegionScope } from "../lib/server/reports/region-scope.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const app = read("src/App.jsx");
const shell = read("src/components/shell.jsx");
const portfolio = read("src/views/BrandPortfolio.jsx");
const datadoe = read("api/datadoe.js");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); }

writeSync(1, "regional-brand-view\n");

/* ============================ A. server enforcement ============================ */

// normalizeRegionParam
ok("blank region -> null (optional; legacy path unchanged)", normalizeRegionParam("") === null && normalizeRegionParam(undefined) === null);
["india", "europe-au", "us-ca"].forEach((r) => ok(`valid region '${r}' passes`, normalizeRegionParam(` ${r} `) === r));
ok("invalid region throws RegionScopeError(400)", (() => {
  try { normalizeRegionParam("atlantis"); return false; }
  catch (e) { return e instanceof RegionScopeError && e.status === 400; }
})());
ok("legacy scopes are NOT accepted as Brand View regions", (() => {
  try { normalizeRegionParam("us"); return false; } catch (e) { return e instanceof RegionScopeError; }
})());
ok("isRegionScope agrees with the three regions only", isRegionScope("india") && isRegionScope("us-ca") && !isRegionScope("us") && !isRegionScope(""));

// filterAccountIdsToRegion -- the trusted-metadata membership filter.
const dir = {
  us1: { country: "US" }, ca1: { country: "CA" },
  de1: { country: "DE" }, gb1: { country: "GB" }, au1: { country: "AU" },
  in1: { country: "IN" },
  bad: { country: "ZZ" },      // unknown marketplace
  missingCountry: {},           // no country
};
ok("no region -> passthrough (byte-identical legacy)", JSON.stringify(filterAccountIdsToRegion(["us1", "de1"], dir, null)) === JSON.stringify(["us1", "de1"]));
ok("region filters to only in-region accounts", JSON.stringify(filterAccountIdsToRegion(["us1", "ca1", "de1", "in1"], dir, "us-ca")) === JSON.stringify(["us1", "ca1"]));
ok("europe-au keeps GB + DE + AU", JSON.stringify(filterAccountIdsToRegion(["gb1", "de1", "au1", "us1"], dir, "europe-au")) === JSON.stringify(["gb1", "de1", "au1"]));
// SECURITY: a tampered request that bundles a US account under india is dropped server-side.
ok("cross-region smuggling is dropped (US id under 'india' -> removed)", JSON.stringify(filterAccountIdsToRegion(["us1", "in1"], dir, "india")) === JSON.stringify(["in1"]));
ok("unknown marketplace is fail-closed OUT of every region", filterAccountIdsToRegion(["bad"], dir, "us-ca").length === 0 && filterAccountIdsToRegion(["bad"], dir, "europe-au").length === 0);
ok("an id absent from the trusted directory is dropped (fail-closed)", filterAccountIdsToRegion(["ghost"], dir, "us-ca").length === 0);
ok("an account with no country is dropped (never coerced in)", filterAccountIdsToRegion(["missingCountry"], dir, "europe-au").length === 0);
ok("region filter is role-independent (applies to admin requests too)", JSON.stringify(filterAccountIdsToRegion(["us1", "de1"], dir, "us-ca")) === JSON.stringify(["us1"]));

/* ============================ B. datadoe.js wiring ============================ */

const bvpIdx = datadoe.indexOf('if (action === "brand-view-portfolio") {');
ok("datadoe has the brand-view-portfolio route", bvpIdx >= 0);
const bvpBlock = datadoe.slice(bvpIdx, bvpIdx + 9000);
ok("portfolio route validates the region param (normalizeRegionParam)", /normalizeRegionParam\(req\.query\.region\)/.test(bvpBlock));
ok("portfolio route rejects an invalid region with 400 (no disclosure)", /RegionScopeError/.test(bvpBlock) && /status\(400\)/.test(bvpBlock));
ok("portfolio route re-filters the account set from trusted metadata (filterAccountIdsToRegion)", /filterAccountIdsToRegion\(authorizedIds, accountsById, region\)/.test(bvpBlock));
ok("region participates in the snapshot params identity", /\.\.\.\(region \? \{ region \} : \{\}\)/.test(bvpBlock));
ok("cross-region snapshot cannot be served as stale LKG (staleScopeKeys region)", /staleScopeKeys: region \? \["region"\]/.test(bvpBlock));
ok("empty region set returns an honest 200 (never a disclosing 403)", /No saved data for this brand in the selected region yet/.test(bvpBlock));
ok("datadoe imports the region-scope helpers (single canonical mapping)", /from "\.\.\/lib\/server\/reports\/region-scope\.js"/.test(datadoe));

/* ============================ B. BrandPortfolio wiring ============================ */
ok("BrandPortfolio accepts a region prop", /function BrandPortfolio\(\{[\s\S]*?\bregion\b/.test(portfolio));
ok("BrandPortfolio sends region in the report params", /action: "brand-view-portfolio"[\s\S]*?region \}/.test(portfolio) || /ids: idsKey, brand, asOf, region/.test(portfolio));
ok("BrandPortfolio requires a region before requesting (region-first)", /if \(!brand \|\| !idsKey \|\| !region\) return null;/.test(portfolio));

/* ============================ B. shell.jsx header ============================ */
ok("shell exports a SearchableSelect combobox", /export function SearchableSelect\(/.test(shell));
ok("combobox uses accessible roles (combobox/listbox/option)", /role="combobox"/.test(shell) && /role="listbox"/.test(shell) && /role="option"/.test(shell));
ok("combobox is keyboard-complete (Escape / ArrowDown / Enter)", /"Escape"/.test(shell) && /"ArrowDown"/.test(shell) && /"Enter"/.test(shell));
ok("combobox returns focus to the trigger on close", /triggerRef\.current\.focus\(\)/.test(shell));
ok("Account + Brand selectors are searchable comboboxes", /AccountSelector[\s\S]*?<SearchableSelect/.test(shell) && /BrandSelector[\s\S]*?<SearchableSelect/.test(shell));
ok("shell exports a RegionSelector", /export function RegionSelector\(/.test(shell));
ok("TopBar shows the Account/Brand view switch whenever onDashboardModeChange is passed", /\{onDashboardModeChange && <DashboardModeSelector/.test(shell));
ok("TopBar renders Region + Brand in brand mode", /dashboardMode === "brand" \? \(\s*<>\s*<RegionSelector/.test(shell));

/* ============================ B. App.jsx wiring ============================ */
ok("App imports the region-view helpers", /from "\.\/lib\/region-view\.js"/.test(app));
ok("the global view switch is available on every scoped report page", /onDashboardModeChange=\{showGlobalScope \? handleDashboardModeChange : undefined\}/.test(app));
ok("switching to Brand View remembers the account-context report", /setAccountReturnView\(view\); setView\("dashboard"\); setDashboardMode\("brand"\)/.test(app));
ok("switching back to Account View restores the remembered report", /setDashboardMode\("account"\);\s*setView\(accountReturnView \|\| "dashboard"\)/.test(app));
ok("the region selector is passed the user's available regions", /regions=\{availableRegions\}/.test(app) && /regionsForAccounts\(accounts\)/.test(app));
ok("the portfolio brand list is region-scoped (empty until a region is chosen)", /if \(!selectedRegion\) return \[\];/.test(app));
ok("the portfolio account set is intersected with the region", /allowedIds\.has\(String\(account\.id\)\) && regionAccountIdSet\.has\(String\(account\.id\)\)/.test(app));
ok("a region change keeps a valid brand else clears it (never substitutes)", /if \(selectedPortfolioBrand && !selectedBrandInRegion\) setSelectedPortfolioBrand\(""\)/.test(app));
ok("region is passed to the BrandPortfolio workspace", /region=\{selectedRegion\}/.test(app));

writeSync(1, `\nregional-brand-view: ${passed} assertions passed\n`);
