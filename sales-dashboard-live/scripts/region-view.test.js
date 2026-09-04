// Regional Brand View -- client Region -> Brand selection helpers (offline, source-invariant).
//
// Proves src/lib/region-view.js routes accounts to the THREE scheduler regions using the SINGLE canonical mapping,
// offers only regions the user can access, inherits a newly-connected account's region automatically, never assigns
// an unknown marketplace to a region, and resolves/keeps a valid region selection deterministically.
//
// 7-bit ASCII, LF, no top-level await.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import {
  REGIONS, REGION_OPTIONS, accountRegion, accountsInRegion, regionsForAccounts,
  resolveSelectedRegion, isSelectableRegion, regionLabel, unassignedAccounts,
} from "../src/lib/region-view.js";

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); }

writeSync(1, "region-view\n");

// Sample accounts across the three regions + an unknown marketplace.
const IN = { id: "in1", name: "IndiaCo", country: "IN", currency: "INR" };
const GB = { id: "gb1", name: "UKCo", country: "GB", currency: "GBP" };
const UK = { id: "uk1", name: "UKCo2", country: "UK", currency: "GBP" }; // UK is an alias of GB
const DE = { id: "de1", name: "DeCo", country: "DE", currency: "EUR" };
const AU = { id: "au1", name: "AuCo", country: "AU", currency: "AUD" };
const US = { id: "us1", name: "UsCo", country: "US", currency: "USD" };
const CA = { id: "ca1", name: "CaCo", country: "CA", currency: "CAD" };
const XX = { id: "xx1", name: "MysteryCo", country: "ZZ", currency: "???" }; // unknown marketplace
const BLANK = { id: "bl1", name: "BlankCo", country: "", currency: "" };

// ---- canonical routing ----
ok("India -> india", accountRegion(IN) === REGIONS.INDIA);
ok("GB -> europe-au", accountRegion(GB) === REGIONS.EUROPE_AU);
ok("UK alias -> europe-au", accountRegion(UK) === REGIONS.EUROPE_AU);
ok("DE -> europe-au", accountRegion(DE) === REGIONS.EUROPE_AU);
ok("AU -> europe-au (Australia lives in europe-au)", accountRegion(AU) === REGIONS.EUROPE_AU);
ok("US -> us-ca", accountRegion(US) === REGIONS.US_CA);
ok("CA -> us-ca", accountRegion(CA) === REGIONS.US_CA);
ok("unknown marketplace -> unassigned (never silently assigned)", accountRegion(XX) === REGIONS.UNASSIGNED);
ok("blank marketplace -> unassigned", accountRegion(BLANK) === REGIONS.UNASSIGNED);
ok("unassigned is NOT a selectable region", !isSelectableRegion(REGIONS.UNASSIGNED) && !isSelectableRegion(""));
ok("the three regions ARE selectable", ["india", "europe-au", "us-ca"].every(isSelectableRegion));
ok("REGION_OPTIONS is exactly the three regions in canonical order",
  REGION_OPTIONS.map((o) => o.value).join(",") === "india,europe-au,us-ca");
ok("regionLabel is human", regionLabel("india") === "India" && /US/.test(regionLabel("us-ca")) && /Europe/.test(regionLabel("europe-au")));

// ---- accountsInRegion ----
const mixed = [IN, GB, DE, AU, US, CA, XX, BLANK];
ok("accountsInRegion(india) = the India account only", JSON.stringify(accountsInRegion(mixed, "india").map((a) => a.id)) === JSON.stringify(["in1"]));
ok("accountsInRegion(europe-au) = GB + DE + AU", JSON.stringify(accountsInRegion(mixed, "europe-au").map((a) => a.id)) === JSON.stringify(["gb1", "de1", "au1"]));
ok("accountsInRegion(us-ca) = US + CA", JSON.stringify(accountsInRegion(mixed, "us-ca").map((a) => a.id)) === JSON.stringify(["us1", "ca1"]));
ok("accountsInRegion never returns an unassigned account", ![...accountsInRegion(mixed, "india"), ...accountsInRegion(mixed, "europe-au"), ...accountsInRegion(mixed, "us-ca")].some((a) => a.id === "xx1" || a.id === "bl1"));
ok("accountsInRegion for a bogus region is empty", accountsInRegion(mixed, "atlantis").length === 0);

// ---- regionsForAccounts (only regions the user can access) ----
const onlyUsCa = regionsForAccounts([US, CA, XX]);
ok("regionsForAccounts offers only regions with authorized accounts", onlyUsCa.length === 1 && onlyUsCa[0].value === "us-ca" && onlyUsCa[0].count === 2);
ok("regionsForAccounts excludes unassigned-only accounts entirely", regionsForAccounts([XX, BLANK]).length === 0);
const allThree = regionsForAccounts(mixed);
ok("regionsForAccounts returns regions in canonical order", allThree.map((r) => r.value).join(",") === "india,europe-au,us-ca");
ok("regionsForAccounts counts are correct", allThree.find((r) => r.value === "europe-au").count === 3);
ok("unassignedAccounts surfaces the unknown marketplaces separately", unassignedAccounts(mixed).map((a) => a.id).sort().join(",") === "bl1,xx1");

// ---- new-account inheritance (recomputed every time; no stored assignment) ----
let live = [US];
ok("before: only us-ca available", regionsForAccounts(live).map((r) => r.value).join(",") === "us-ca");
live = [...live, DE]; // a newly-connected European account
ok("after connecting a DE account: europe-au appears automatically", regionsForAccounts(live).map((r) => r.value).sort().join(",") === "europe-au,us-ca");
ok("the new DE account is immediately in europe-au", accountsInRegion(live, "europe-au").map((a) => a.id).join(",") === "de1");

// ---- resolveSelectedRegion (keep valid prior, else first available, else "") ----
ok("resolveSelectedRegion keeps a still-valid prior region", resolveSelectedRegion("us-ca", mixed) === "us-ca");
ok("resolveSelectedRegion drops a now-invalid prior region -> first available", resolveSelectedRegion("india", [US, CA]) === "us-ca");
ok("resolveSelectedRegion with no prior -> first available", resolveSelectedRegion("", mixed) === "india");
ok("resolveSelectedRegion with no authorized regions -> ''", resolveSelectedRegion("india", [XX]) === "");

// ---- same brand across multiple regions/accounts is disambiguated by region ----
// (A brand present in both a US account and a DE account is reachable in us-ca AND europe-au, but the account SET
// differs per region -- the portfolio account set is always region.accounts intersect brand.accounts.)
const brandAccounts = new Set(["us1", "de1"]); // the accounts selling "Acme"
const usCaForBrand = accountsInRegion(mixed, "us-ca").filter((a) => brandAccounts.has(a.id)).map((a) => a.id);
const euForBrand = accountsInRegion(mixed, "europe-au").filter((a) => brandAccounts.has(a.id)).map((a) => a.id);
ok("same brand in us-ca resolves to only the US account", JSON.stringify(usCaForBrand) === JSON.stringify(["us1"]));
ok("same brand in europe-au resolves to only the DE account", JSON.stringify(euForBrand) === JSON.stringify(["de1"]));
ok("the two region account sets are disjoint (no cross-region bleed)", !usCaForBrand.some((id) => euForBrand.includes(id)));

writeSync(1, `\nregion-view: ${passed} assertions passed\n`);
