// WORK D -- the listing-health-v3 LIVE contract + serve switch + reconcile workflow gates. Proves: the contract entry
// is pinned + undispatchable; the dependent-reports registry declares exactly listing-health-v3; the api/datadoe.js
// serve switch is DOUBLE-GATED (LHV3_PUBLISH_LIVE && LISTING_HEALTH_V3, both default OFF) + DEFAULT-WINDOW only + falls
// through to the UNCHANGED preview (never blank/fabricated); the 30-min + immediate reconcile paths are gated on
// vars.LISTINGS_RECONCILE_LIVE (default OFF); and no new api/*.js was added (Vercel Hobby cap = 12). 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS, SCHEDULER_V2_PUBLISHABLE_REPORT_KEYS } from "../lib/server/sync/report-publisher.js";
import { SOURCE_PROMOTED_REPORT_KEYS, CONTROLLED_REPORT_KEYS, SCHEDULER_V2_READY_REPORT_KEYS } from "../lib/server/sync/report-controls.js";
import { REPORT_DERIVATIONS } from "../lib/server/sync/report-derivation.js";
import { listingsDependentLiveReportKeys, isListingsDependentLiveReport } from "../lib/server/sync/listing-health-v3-dependent-reports.js";
import { buildListingHealthV3ControlPackage } from "../lib/server/sync/source-priority-control-package.js";
import { envFlagOn } from "../src/lib/env-flag.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; };
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO = path.dirname(ROOT);
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
const readRepo = (p) => readFileSync(path.join(REPO, p), "utf8");
process.stdout.write("listing-health-v3-live-contract\n");

// ---- (1) the live contract entry ----
{
  const c = SCHEDULER_LIVE_SNAPSHOT_CONTRACTS["listing-health-v3"];
  ok("contract exists", !!c);
  ok("liveReportKey === listing-health-v3", c.liveReportKey === "listing-health-v3");
  ok("liveReportVersion === listing-health-v3-shared-v1 (DISTINCT from the shadow snapshotVersion)", c.liveReportVersion === "listing-health-v3-shared-v1" && c.liveReportVersion !== REPORT_DERIVATIONS["listing-health-v3"].snapshotVersion);
  ok("liveParams is { to } and fails closed on a missing/malformed date", JSON.stringify(c.liveParams({ to: "2026-09-04" })) === JSON.stringify({ to: "2026-09-04" }) && c.liveParams({}) === null && c.liveParams({ to: "2026-9-4" }) === null);
}

// ---- (2) source-promoted + UNDISPATCHABLE ----
{
  ok("listing-health-v3 is a SOURCE_PROMOTED key", SOURCE_PROMOTED_REPORT_KEYS.includes("listing-health-v3"));
  ok("listing-health-v3 is in SCHEDULER_V2_PUBLISHABLE_REPORT_KEYS (code-ready to publish)", SCHEDULER_V2_PUBLISHABLE_REPORT_KEYS.includes("listing-health-v3"));
  ok("listing-health-v3 is NOT a CONTROLLED (dispatchable) report", !CONTROLLED_REPORT_KEYS.includes("listing-health-v3"));
  ok("listing-health-v3 is NOT in SCHEDULER_V2_READY_REPORT_KEYS (dispatch readiness)", !SCHEDULER_V2_READY_REPORT_KEYS.includes("listing-health-v3"));
  ok("the READY dispatch allowlist stays EXACTLY 13 (unchanged by the promotion)", SCHEDULER_V2_READY_REPORT_KEYS.length === 13);
}

// ---- (3) the dependent-reports registry ----
{
  ok("listingsDependentLiveReportKeys() === exactly [listing-health-v3]", JSON.stringify(listingsDependentLiveReportKeys()) === JSON.stringify(["listing-health-v3"]));
  ok("isListingsDependentLiveReport(listing-health-v3) is true", isListingsDependentLiveReport("listing-health-v3") === true);
  ok("isListingsDependentLiveReport(brand-inventory) is false", isListingsDependentLiveReport("brand-inventory") === false);
}

// ---- (4) the api/datadoe.js serve switch: DOUBLE-GATED + default-window only + fall-through preview ----
{
  const src = read("api/datadoe.js");
  const block = src.slice(src.indexOf('if (action === "listing-health-v3")'), src.indexOf('if (action === "listing-health-v3")') + 3400);
  ok("the serve switch is DOUBLE-GATED on LHV3_PUBLISH_LIVE && LISTING_HEALTH_V3 (both === \"true\")", /process\.env\.LHV3_PUBLISH_LIVE === "true"[\s\S]{0,120}process\.env\.LISTING_HEALTH_V3 === "true"/.test(block));
  ok("the live path is DEFAULT-WINDOW only, treating the client's explicit '30D' preset as default (else a 7D request would serve the 30D live row)", /lhv3DefaultWindow/.test(block) && /!req\.query\.windowPreset \|\| req\.query\.windowPreset === "30D"/.test(block) && /!req\.query\.windowFrom/.test(block));
  ok("the live read is the STRICT resolveListingHealthV3LivePromoted (NOT the latest-pointer getLatestReportSnapshotHydrated shortcut)", /resolveListingHealthV3LivePromoted\(\{ accountId:/.test(block) && !/getLatestReportSnapshotHydrated\(\{ reportKey: "listing-health-v3"/.test(block));
  ok("the live payload is served ONLY on { ok:true } from the strict resolver", /live && live\.ok === true && live\.payload/.test(block));
  ok("a live miss / OFF / windowed / read failure FALLS THROUGH to the UNCHANGED serveListingHealthV3Preview", block.indexOf("serveListingHealthV3Preview") > block.indexOf("LHV3_PUBLISH_LIVE"));
}

// ---- (4b) the dedicated listing-health-v3 control package (opens EXACTLY the LHv3 promoted+approval gates) ----
{
  const pkg = buildListingHealthV3ControlPackage({ accounts: ["A1", "A2"], operator: "op@x.co" });
  ok("control package promotes EXACTLY listing-health-v3 (not brand-inventory)", pkg.post.promotedEnabled === "listing-health-v3" && pkg.apply.promoted.length === 1 && pkg.apply.promoted[0].report_key === "listing-health-v3" && pkg.apply.promoted[0].publish_enabled === true);
  ok("control package approves listing-health-v3 x each account and NOTHING else", JSON.stringify(pkg.post.approvals) === JSON.stringify(["listing-health-v3|A1", "listing-health-v3|A2"]));
  ok("control package enables NO dispatch control (source-promoted, not dispatched)", pkg.post.dispatchEnabled.length === 0);
  ok("control package enables rollout for exactly the accounts", JSON.stringify([...pkg.post.rolloutEnabled].sort()) === JSON.stringify(["A1", "A2"]));
  ok("control package fails closed on an empty account set / blank operator", (() => { try { buildListingHealthV3ControlPackage({ accounts: [], operator: "op@x.co" }); return false; } catch { return true; } })() && (() => { try { buildListingHealthV3ControlPackage({ accounts: ["A1"], operator: "" }); return false; } catch { return true; } })());
  const entry = readFileSync(path.join(ROOT, "scripts/release/listing-health-v3-reconcile.mjs"), "utf8");
  ok("the entrypoint wires buildApplyPackage: buildListingHealthV3ControlPackage in openControls (so the publish gate is opened for listing-health-v3, not brand-inventory)", /buildApplyPackage: buildListingHealthV3ControlPackage/.test(entry));
  // MARKETPLACE CODE NORMALIZATION (UK->GB): the directory reports country "UK" for the UK marketplace, but every durable
  // source (Listings/Listings-Raw/Catalog) stores Amazon's code "GB". The bundle identity MUST normalize (not pass raw
  // "UK") or validateListingsPointer's marketplace check ("UK" !== "GB") defers EVERY UK account's LHv3 forever.
  ok("(marketplace) the bundle identity NORMALIZES the directory country to the Amazon code (UK->GB), matching the durable listings -- never the raw country", /marketplace: normalizeMarketplace\(m\.country\)/.test(entry) && !/marketplace: String\(m\.country\)\.toUpperCase\(\)/.test(entry));
}

// ---- (5) the 30-min reconcile workflow + immediate hook gates ----
{
  const wf = readRepo(".github/workflows/listing-health-v3-reconcile.yml");
ok("daily recovery workflow gates live on vars.LISTINGS_RECONCILE_LIVE == 'true'", /vars\.LISTINGS_RECONCILE_LIVE == 'true'/.test(wf));
ok("daily recovery workflow cron is 21:58 UTC", /cron: "58 21 \* \* \*"/.test(wf));
ok("disabled scheduled recovery allocates no runner; manual dispatch remains available", /if: github\.event_name == 'workflow_dispatch' \|\| vars\.LISTINGS_RECONCILE_LIVE == 'true'/.test(wf));
  ok("30-min workflow calls listing-health-v3-reconcile.mjs --mode=periodic", /listing-health-v3-reconcile\.mjs --bucket=.*--mode=periodic/.test(wf));
  ok("30-min workflow has an always() cleanup job gated the same way", /needs: reconcile/.test(wf) && /--cleanup/.test(wf));

  const sched = readRepo(".github/workflows/scheduler-v2.yml");
  const jobIdx = sched.indexOf("\n  listing_health_v3_reconcile:");
  ok("scheduler-v2 has a SEPARATE listing_health_v3_reconcile job (like ads_reconcile)", jobIdx > 0);
  const job = sched.slice(jobIdx, jobIdx + 2600);
  ok("the immediate reconcile job NEEDS the listing-health-v3 shadow job (runs after ingestion persists the pointers)", /needs: \[run, fba, listing-health-v3\]/.test(job));
  ok("the immediate reconcile job is gated on execute_downstream + non-bootstrap + inventory_asof present", /execute_downstream == 'true'/.test(job) && /scope != 'bootstrap'/.test(job) && /inventory_asof != ''/.test(job));
  ok("the immediate reconcile job REQUIRES the LHv3 shadow ingestion succeeded (needs.listing-health-v3.result == 'success')", /needs\.listing-health-v3\.result == 'success'/.test(job));
  ok("the immediate reconcile step is continue-on-error + gated on vars.LISTINGS_RECONCILE_LIVE", /continue-on-error: true/.test(job) && /vars\.LISTINGS_RECONCILE_LIVE/.test(job));
  ok("the immediate hook uses --as-of=inventory_asof (== the durable Listings/Raw as_of)", /listing-health-v3-reconcile\.mjs --bucket=\$\{\{ needs\.run\.outputs\.region \}\} --as-of=\$\{\{ needs\.run\.outputs\.inventory_asof \}\}/.test(job));
}

// ---- (6) Vercel Hobby cap: exactly 12 api/*.js functions (no new function added) ----
{
  const apiDir = path.join(ROOT, "api");
  const top = readdirSync(apiDir).filter((f) => f.endsWith(".js")).length;
  const admin = readdirSync(path.join(apiDir, "admin")).filter((f) => f.endsWith(".js")).length;
  const cron = readdirSync(path.join(apiDir, "cron")).filter((f) => f.endsWith(".js")).length;
  ok(`api function count === 12 (${top} top-level + ${admin} admin + ${cron} cron)`, top + admin + cron === 12);
}

// ---- (7) FRONTEND activation flag (Blocker 1): a BUILD-TIME Vite gate, DEFAULT OFF, ON only for the exact "true" ----
{
  // envFlagOn is the pure predicate feature-flags.js applies to import.meta.env.VITE_LISTING_HEALTH_V3.
  ok("envFlagOn is ON only for the exact string 'true'", envFlagOn("true") === true);
  ok("envFlagOn is OFF for absent/blank/false/FALSE/1/yes/whitespace/boolean/number (default OFF)",
    [undefined, null, "", "false", "FALSE", "1", "yes", " true ", "True", true, 1].every((v) => envFlagOn(v) === false));
  const ff = read("src/lib/feature-flags.js");
  ok("LISTING_HEALTH_V3 is the BUILD-TIME Vite gate envFlagOn(...import.meta.env.VITE_LISTING_HEALTH_V3...) -- NOT hardcoded",
    /export const LISTING_HEALTH_V3 = envFlagOn\(/.test(ff) && /import\.meta\.env\.VITE_LISTING_HEALTH_V3/.test(ff) && !/export const LISTING_HEALTH_V3 = (?:true|false)\b/.test(ff));
  ok("feature-flags.js documents the THREE distinct gates (frontend VITE_LISTING_HEALTH_V3 + server LISTING_HEALTH_V3 + server LHV3_PUBLISH_LIVE)",
    /VITE_LISTING_HEALTH_V3/.test(ff) && /LISTING_HEALTH_V3\s+\(SERVER env\)/.test(ff) && /LHV3_PUBLISH_LIVE\s+\(SERVER env\)/.test(ff));
  const ef = read("src/lib/env-flag.js");
  ok("env-flag.js is PURE (no import.meta) so the predicate is unit-testable in Node", !/import\.meta/.test(ef) && /export function envFlagOn/.test(ef));
}

process.stdout.write(`\nlisting-health-v3-live-contract: ${passed} assertions passed\n`);
