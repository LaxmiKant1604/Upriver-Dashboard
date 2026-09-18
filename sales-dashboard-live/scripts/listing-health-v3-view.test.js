// Phase 3 -- Advanced Listing Health v3 PURE PRESENTER + view/wiring source guards.
// Proves: the exact 19 UI columns with Amazon Listing Status BEFORE the derived Health Finding; deterministic Health
// Finding / Confidence / Evidence source / Why Flagged / Recommended Action from server evidence (never an invented
// cause; a no-evidence row is "Needs verification", NEVER a fabricated OK or a negative finding); null-vs-zero vs
// Not-applicable formatting; ranked Priority Actions collapsed by default; the Excel export mirrors the authorized,
// filtered rows with the same truthful values; hook-order stability; and the v1->v3 CONSOLIDATION wiring (one sidebar
// item, legacy route redirects to v3, v1 not mounted/fed to the feed). Offline, no React render. 7-bit, LF.

import assert from "node:assert/strict";
import { readFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  V3_GATES, GATE_RANK, v3GateForRow, v3WhyFlagged, v3RecommendedAction, v3Confidence, v3EvidenceSource,
  buildV3Rows, buildV3PriorityActions, v3ExportRows, v3WindowStatusLabel,
  fmtOnHand, fmtBool, fmtIssue,
} from "../src/lib/listing-health-v3-view.js";
import { LISTING_HEALTH_V3 } from "../src/lib/feature-flags.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "listing-health-v3-view\n");

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const reason = (code, confidence = "confirmed", detail = null) => ({ code, confidence, detail });
const row = (o = {}) => ({ sku: o.sku ?? "S", asin: o.asin ?? "ASIN-S", brand: o.brand ?? "BrandX", productName: o.productName ?? "P", listingStatus: o.listingStatus ?? "Active", channel: o.channel ?? "FBA", price: o.price ?? 10, currency: o.currency ?? "USD", onHandFba: o.onHandFba ?? 5, onHandFbaApplicable: o.onHandFbaApplicable ?? true, onHandFbm: o.onHandFbm ?? null, onHandFbmApplicable: o.onHandFbmApplicable ?? false, sales: o.sales ?? 0, units: o.units ?? 0, salesAtRisk: o.salesAtRisk ?? 0, buyable: o.buyable ?? true, discoverable: o.discoverable ?? true, liveOffer: o.liveOffer ?? true, issues: o.issues ?? [], flagged: o.flagged ?? false, flagReasons: o.flagReasons ?? [] });

/* ===================== A. deterministic Gate (server evidence -> visual gate; flagged is NEVER OK) ===================== */
(() => {
  ok("A: amazon_issue_error -> gate 'error'", v3GateForRow(row({ flagReasons: [reason("amazon_issue_error")] })) === "error");
  ok("A: not_buyable -> gate 'suppressed'", v3GateForRow(row({ flagReasons: [reason("not_buyable")] })) === "suppressed");
  ok("A: not_discoverable -> gate 'suppressed'", v3GateForRow(row({ flagReasons: [reason("not_discoverable")] })) === "suppressed");
  ok("A: no_live_offer -> gate 'no_live_offer'", v3GateForRow(row({ flagReasons: [reason("no_live_offer")] })) === "no_live_offer");
  ok("A: no_price_while_active -> gate 'no_price'", v3GateForRow(row({ listingStatus: "Active", flagReasons: [reason("no_price_while_active")] })) === "no_price");
  ok("A: Inactive status -> gate 'inactive'", v3GateForRow(row({ listingStatus: "Inactive", flagReasons: [reason("status_not_active", "possible")] })) === "inactive");
  ok("A: Incomplete status -> gate 'incomplete'", v3GateForRow(row({ listingStatus: "Incomplete", flagReasons: [reason("status_not_active", "possible")] })) === "incomplete");
  ok("A: stranded only (blank status) -> gate 'stranded'", v3GateForRow(row({ listingStatus: "", flagReasons: [reason("stranded_stock", "possible")] })) === "stranded");
  ok("A: any other non-Active flagged status -> gate 'inactive' (a flagged row is NEVER shown OK)", v3GateForRow(row({ listingStatus: "Deleted", flagReasons: [reason("status_not_active", "possible")] })) === "inactive");
  ok("A: no reasons -> gate 'ok'", v3GateForRow(row({ flagReasons: [] })) === "ok");
  ok("A: a confirmed cause outranks a possible one (error + status_not_active -> error)", v3GateForRow(row({ listingStatus: "Inactive", flagReasons: [reason("status_not_active", "possible"), reason("amazon_issue_error")] })) === "error");
  ok("A: every gate maps to a real CSS tone (bad|warn|ok)", Object.values(V3_GATES).every((g) => ["bad", "warn", "ok"].includes(g.tone)));
})();

/* ===================== B. deterministic Recommended Action (no invented cause) ===================== */
(() => {
  ok("B: error -> resolve the Amazon listing error", /Amazon listing error/.test(v3RecommendedAction(row({ flagReasons: [reason("amazon_issue_error")], issues: [{ code: "8541", severity: "ERROR", message: "x" }] }))));
  ok("B: error action includes the concrete issue code(s)", /8541/.test(v3RecommendedAction(row({ flagReasons: [reason("amazon_issue_error")], issues: [{ code: "8541", severity: "ERROR" }] }))));
  ok("B: not_buyable -> clear the suppression in Seller Central", /suppressed/i.test(v3RecommendedAction(row({ flagReasons: [reason("not_buyable")] }))));
  ok("B: no_live_offer -> restore a live, priced offer", /Restore a live, priced offer/.test(v3RecommendedAction(row({ flagReasons: [reason("no_live_offer")] }))));
  ok("B: no_price_while_active -> set a valid price", /Set a valid price/.test(v3RecommendedAction(row({ flagReasons: [reason("no_price_while_active")] }))));
  const investigate = v3RecommendedAction(row({ listingStatus: "Inactive", flagReasons: [reason("status_not_active", "possible")] }));
  ok("B: status_not_active (possible) -> an INVESTIGATE step", /Investigate/.test(investigate));
  ok("B: a possible reason NEVER asserts an unproven cause", /status alone does not prove the cause/.test(investigate));
  ok("B: stranded_stock -> investigate stranded stock", /Investigate stranded stock/.test(v3RecommendedAction(row({ listingStatus: "", flagReasons: [reason("stranded_stock", "possible")] }))));
  ok("B: no reasons -> 'No action needed.'", v3RecommendedAction(row({ flagReasons: [] })) === "No action needed.");
  // Determinism: identical evidence -> identical action across calls.
  const r = row({ flagReasons: [reason("no_live_offer")] });
  ok("B: identical evidence yields identical action (deterministic)", v3RecommendedAction(r) === v3RecommendedAction(r));
})();

/* ===================== C. Why Flagged separates confirmed vs possible ===================== */
(() => {
  const why = v3WhyFlagged(row({ flagReasons: [reason("amazon_issue_error", "confirmed", "Amazon ERROR issue"), reason("status_not_active", "possible", "Not Active")] }));
  ok("C: why-flagged labels confirmed evidence", /Confirmed: Amazon ERROR issue/.test(why));
  ok("C: why-flagged labels possible evidence separately", /Possible: Not Active/.test(why));
  ok("C: an unflagged row has empty why-flagged", v3WhyFlagged(row({ flagReasons: [] })) === "");
})();

/* ===================== D. null vs genuine zero vs Not-applicable ===================== */
(() => {
  ok("D: on-hand genuine 0 renders '0' (not blank/unavailable)", fmtOnHand(0, true) === "0");
  ok("D: on-hand unknown (null) renders 'Unavailable'", fmtOnHand(null, true) === "Unavailable");
  ok("D: on-hand for the opposite channel renders 'Not applicable'", fmtOnHand(5, false) === "Not applicable");
  ok("D: buyable true/false/null render Yes/No/Unavailable", fmtBool(true) === "Yes" && fmtBool(false) === "No" && fmtBool(null) === "Unavailable");
  ok("D: issue formatter surfaces severity/code/message", fmtIssue([{ severity: "ERROR", code: "8541", message: "blocked" }]) === "ERROR 8541: blocked");
  ok("D: no issue -> empty string", fmtIssue([]) === "");
})();

/* ===================== E. buildV3Rows: brand filter + attached derivations ===================== */
(() => {
  const payload = { rows: [row({ sku: "A", brand: "BrandX" }), row({ sku: "B", brand: "BrandY" })] };
  ok("E: no brand -> all rows", buildV3Rows(payload).length === 2);
  ok("E: 'ALL' -> all rows", buildV3Rows(payload, "ALL").length === 2);
  const only = buildV3Rows(payload, "BrandX");
  ok("E: a selected brand filters to that brand only (client display filter)", only.length === 1 && only[0].sku === "A");
  ok("E: each built row carries gate + gateMeta + whyFlagged + recommendedAction", only[0].gate && only[0].gateMeta && "whyFlagged" in only[0] && "recommendedAction" in only[0]);
  ok("E: a null/empty payload yields no rows (never throws)", buildV3Rows(null).length === 0 && buildV3Rows({}).length === 0);
})();

/* ===================== F. Priority Actions: flagged only, ranked by exposure then severity ===================== */
(() => {
  const built = buildV3Rows({ rows: [
    row({ sku: "HI", flagged: true, salesAtRisk: 300, listingStatus: "Inactive", flagReasons: [reason("status_not_active", "possible")] }),
    row({ sku: "LO", flagged: true, salesAtRisk: 50, listingStatus: "Inactive", flagReasons: [reason("status_not_active", "possible")] }),
    row({ sku: "MID", flagged: true, salesAtRisk: 200, listingStatus: "Active", flagReasons: [reason("amazon_issue_error")] }),
    row({ sku: "OK", flagged: false, salesAtRisk: 0 }),
  ] });
  const pa = buildV3PriorityActions(built);
  ok("F: only flagged rows appear", pa.length === 3 && !pa.some((p) => p.sku === "OK"));
  ok("F: ranked by sales-at-risk descending", pa.map((p) => p.sku).join(",") === "HI,MID,LO");
  ok("F: each action carries ranked evidence + confidence + recommended action", pa[0].evidence.length >= 4 && pa[0].confidence && pa[0].action);
  ok("F: a confirmed-cause row reports confidence 'confirmed'", pa.find((p) => p.sku === "MID").confidence === "confirmed");
  ok("F: a possible-only row reports confidence 'possible'", pa.find((p) => p.sku === "HI").confidence === "possible");
})();

/* ===================== G. Excel export mirrors the authorized, filtered rows ===================== */
(() => {
  const built = buildV3Rows({ rows: [row({ sku: "A", sales: 150, units: 15, salesAtRisk: 0 }), row({ sku: "B", brand: "BrandY", flagged: true, listingStatus: "Inactive", salesAtRisk: 200, flagReasons: [reason("status_not_active", "possible")] })] });
  const rows = v3ExportRows(built);
  ok("G: one export row per UI row (exact 1:1)", rows.length === built.length);
  const cols = Object.keys(rows[0]);
  for (const c of ["Product Name", "SKU", "ASIN", "Brand", "Amazon Listing Status", "Health Finding", "Confidence", "Fulfilment", "Price", "On Hand FBA", "On Hand FBM", "Sales (selected period)", "Units (selected period)", "Sales at Risk", "Buyable", "Discoverable", "Live Offer", "Amazon Issue", "Evidence Source", "Evidence As Of", "Why Flagged", "Recommended Action"]) {
    ok(`G: export carries column '${c}'`, cols.includes(c));
  }
  ok("G: export never uses the ambiguous 'Gate'/'Status' headers", !cols.includes("Gate") && !cols.includes("Status"));
  ok("G: export sales/units are the SAME truthful durable window numbers", rows[0]["Sales (selected period)"] === 150 && rows[0]["Units (selected period)"] === 15);
  ok("G: export Health Finding + recommended action match the presenter", rows[1]["Health Finding"] === V3_GATES.inactive.label && /Investigate/.test(rows[1]["Recommended Action"]));
  ok("G: export Amazon Listing Status is the Amazon source string (Unavailable when absent, never a derived value)", v3ExportRows(buildV3Rows({ rows: [{ sku: "X", listingStatus: null, buyable: null, discoverable: null, liveOffer: null, issues: [], flagReasons: [] }] }))[0]["Amazon Listing Status"] === "Unavailable");
  // Filtering the UI rows filters the export identically (exported rows == authorized filtered rows).
  const filtered = built.filter((r) => r.flagged);
  ok("G: exporting a filtered subset yields exactly those rows", v3ExportRows(filtered).length === 1 && v3ExportRows(filtered)[0].SKU === "B");
})();

/* ===================== H. window-status labels are honest ===================== */
(() => {
  ok("H: covered", v3WindowStatusLabel({ salesWindowStatus: "covered" }).label === "Covered");
  ok("H: partial", v3WindowStatusLabel({ salesWindowStatus: "partial" }).label === "Partial");
  ok("H: unavailable (a 0 is not a proven zero)", v3WindowStatusLabel({ salesWindowStatus: "unavailable" }).label === "Unavailable" && /not a proven zero/.test(v3WindowStatusLabel({ salesWindowStatus: "unavailable" }).note));
})();

/* ===================== I. exact 19 UI columns; Amazon status BEFORE the derived finding (view source contract) ===================== */
(() => {
  const src = readFileSync(path.join(root, "src", "views", "ListingHealthV3.jsx"), "utf8");
  const thead = src.slice(src.indexOf("<thead>"), src.indexOf("</thead>"));
  const headerCells = (thead.match(/<SortTh\b/g) || []).length + (thead.match(/<th\b/g) || []).length;
  ok("I: the table declares EXACTLY 19 header cells", headerCells === 19);
  const LABELS = ["Product / SKU", "Amazon Listing Status", "Health Finding", "Confidence", "Fulfilment", "Price", "On Hand FBA", "On Hand FBM", "Sales", "Units", "Sales at Risk", "Buyable", "Discoverable", "Live Offer", "Amazon Issue", "Evidence source", "As of", "Why Flagged", "Recommended Action"];
  for (const l of LABELS) ok(`I: column present: ${l}`, thead.includes(`"${l}"`) || thead.includes(`>${l}<`));
  // The Amazon SOURCE status must render BEFORE the derived Health Finding so a derived condition is never confused with it.
  ok("I: 'Amazon Listing Status' precedes 'Health Finding'", thead.indexOf('"Amazon Listing Status"') > 0 && thead.indexOf('"Amazon Listing Status"') < thead.indexOf('"Health Finding"'));
  ok("I: the ambiguous 'Gate'/'Status' header labels are gone", !/label="Gate"|label="Status"/.test(thead));
  ok("I: the four forbidden columns are absent (no FBA Inbound / FBA Reserved / Profit)", !/FBA Inbound|FBA Reserved|Profit/i.test(thead));
})();

/* ===================== J. hook-order stability (all hooks above the single return) ===================== */
(() => {
  const src = readFileSync(path.join(root, "src", "views", "ListingHealthV3.jsx"), "utf8");
  const body = src.slice(src.indexOf("export default function ListingHealthV3"));
  const retIdx = body.indexOf("\n  return (");
  ok("J: the component has a single top-level JSX return", retIdx > 0 && body.indexOf("\n  return (", retIdx + 1) === -1);
  const beforeReturn = body.slice(0, retIdx);
  ok("J: NO early return precedes the hooks / JSX return (Rules of Hooks)", !/\n  return\b/.test(beforeReturn));
  const hookRe = /\b(useState|useMemo|useEffect|useCallback|useRef|useSortState)\s*\(/g;
  let m, lastHook = -1, count = 0;
  while ((m = hookRe.exec(beforeReturn))) { lastHook = m.index; count += 1; }
  ok("J: every hook call sits before the JSX return", count >= 6 && lastHook > 0 && lastHook < retIdx);
})();

/* ===================== K. v1 -> v3 CONSOLIDATION: one item, legacy route redirects, v1 not mounted/fed ===================== */
(() => {
  const app = readFileSync(path.join(root, "src", "App.jsx"), "utf8");
  const shell = readFileSync(path.join(root, "src", "components", "shell.jsx"), "utf8");
  const pf = readFileSync(path.join(root, "src", "views", "PriorityFeed.jsx"), "utf8");

  // (nav) Exactly ONE Listing Health item, the v3 one, unconditional; the v1 item is removed.
  ok("K: the sole v3 nav item is present + unconditional (not flag-gated)", shell.includes('view: "listinghealth-v3"') && !/LISTING_HEALTH_V3\s*\?/.test(shell));
  ok("K: the sole item carries the preserved v3 title", shell.includes('label: "Listing Health — v3 preview (read-only)"'));
  ok("K: the legacy v1 nav item is GONE", !shell.includes('view: "listinghealth", label: "Listing Health"'));
  ok("K: exactly one sidebar item mentions listinghealth (no duplicate Listing Health entries)", (shell.match(/view:\s*"listinghealth/g) || []).length === 1);

  // (route) The legacy "listinghealth" key redirects to v3 (onNavigate remap) and resolves to the v3 render (no broken route).
  ok("K: onNavigate remaps the legacy key to v3", app.includes('next === "listinghealth" ? "listinghealth-v3"'));
  ok("K: the v3 render resolves BOTH the v3 key and the legacy key", app.includes('(view === "listinghealth-v3" || view === "listinghealth")'));
  ok("K: v3 render is NOT flag-gated any more (unconditional production default)", !app.includes('view === "listinghealth-v3" && LISTING_HEALTH_V3'));
  ok("K: the v1 <ListingHealth> is no longer mounted on its own key", !app.includes('{view === "listinghealth" && ('));

  // (loader) The v1 report is never fetched (rollback-only) and never fed to the Priority Feed.
  ok("K: the v1 listing-health loader is inactive (retained for rollback only)", app.includes('const listingHealth = useSharedReport({ params: listingHealthParams, active: false })'));

  // (feed) Priority Feed builds Listing Health alerts from the VERIFIED v3 adapter only; never the legacy v1 builders.
  ok("K: Priority Feed builds Listing Health alerts from the verified v3 adapter (buildListingHealthV3Insights)", pf.includes("buildListingHealthV3Insights(lhv3"));
  ok("K: Priority Feed never invokes the legacy v1 listing-health builders", !/buildListingHealthInsights\b|buildListingHealthRows\b/.test(pf));
  ok("K: the v3 report is loaded on the feed (read-only) and passed to Priority Feed", app.includes('view === "listinghealth-v3" || view === "listinghealth" || onFeed') && /reports=\{\{[^}]*listingHealthV3/.test(app));

  // The build-time flag constant still resolves OFF in Node (it no longer gates the page, but its default is unchanged).
  ok("K: LISTING_HEALTH_V3 build flag still resolves OFF in a non-Vite context", LISTING_HEALTH_V3 === false);
})();

/* ===================== L. ACCURACY: no fabricated OK; tri-state confidence + evidence; missing != negative ===================== */
(() => {
  // A "Needs verification" finding exists and is a neutral/caution tone (never a fabricated OK, never a fabricated negative).
  ok("L: V3_GATES has a 'needs_verification' finding labelled 'Needs verification'", V3_GATES.needs_verification && V3_GATES.needs_verification.label === "Needs verification");

  // A builder that PRESERVES explicit null tri-state (the row() fixture coalesces null via ??, so it cannot express UNKNOWN).
  const nev = (o = {}) => ({ sku: "S", asin: "A", productName: "P", listingStatus: "Active", channel: "FBA", price: 10, currency: "USD", buyable: null, discoverable: null, liveOffer: null, issues: [], flagReasons: [], ...o });
  // A non-flagged row with NO confirming evidence must be "needs_verification", NOT a fabricated OK.
  ok("L: unflagged + no Buyable/Discoverable/Live-offer evidence -> 'needs_verification' (never a fabricated OK)", v3GateForRow(nev()) === "needs_verification");
  ok("L: unflagged + a confirmed positive signal (buyable true) -> 'ok'", v3GateForRow(nev({ buyable: true })) === "ok");
  ok("L: a needs_verification row is NOT a negative finding", V3_GATES[v3GateForRow(nev())].tone !== "bad");

  // Missing / blank Amazon status must NEVER become Inactive/Suppressed by default.
  ok("L: blank status + no evidence -> 'needs_verification', NEVER 'inactive'/'suppressed'", v3GateForRow(nev({ listingStatus: "" })) === "needs_verification");

  // v3Confidence tri-state.
  ok("L: confidence — a confirmed flag -> 'confirmed'", v3Confidence(row({ flagReasons: [reason("amazon_issue_error", "confirmed")] })) === "confirmed");
  ok("L: confidence — only a possible flag -> 'possible'", v3Confidence(row({ flagReasons: [reason("status_not_active", "possible")] })) === "possible");
  ok("L: confidence — unflagged + positive signal -> 'confirmed'", v3Confidence(nev({ buyable: true })) === "confirmed");
  ok("L: confidence — unflagged + no evidence -> 'unavailable'", v3Confidence(nev()) === "unavailable");

  // v3EvidenceSource: never claims evidence it does not have.
  ok("L: evidence source — Listings + Raw when a raw signal is present", v3EvidenceSource(row({ listingStatus: "Active", buyable: true })) === "Listings + Raw JSON");
  ok("L: evidence source — Listings only when raw signals are all unknown", v3EvidenceSource(nev({ listingStatus: "Active" })) === "Listings");
  ok("L: evidence source — Unavailable when nothing backs the row", v3EvidenceSource({ listingStatus: null, price: null, channel: null, buyable: null, discoverable: null, liveOffer: null, issues: [] }) === "Unavailable");

  // buildV3Rows attaches the new per-row fields.
  const built = buildV3Rows({ asOf: "2026-09-18", provenance: { listingsFetchedAt: "2026-09-17T04:00:00Z" }, rows: [nev()] });
  ok("L: buildV3Rows attaches confidence + evidenceSource + evidenceAsOf per row", built[0].confidence === "unavailable" && "evidenceSource" in built[0] && built[0].evidenceAsOf === "2026-09-17");
  ok("L: a no-evidence row's recommended action asks to VERIFY (never asserts a problem)", /Verify this listing/.test(v3RecommendedAction(nev())));
  // Stale evidence is flagged when the snapshot is >2 days older than the report as-of.
  const stale = buildV3Rows({ asOf: "2026-09-18", provenance: { listingsFetchedAt: "2026-09-10T04:00:00Z" }, rows: [nev()] });
  ok("L: evidence older than 2 days before as-of is marked stale", stale[0].evidenceStale === true && built[0].evidenceStale === false);
})();

writeSync(1, `\nlisting-health-v3-view: ${passed} assertions passed\n`);
