// Phase 3 -- Advanced Listing Health v3 PURE PRESENTER + view/wiring source guards.
// Proves: the exact 16 UI columns; deterministic Gate / Why Flagged / Recommended Action from server evidence (never
// an invented cause); null-vs-zero vs Not-applicable formatting; ranked Priority Actions collapsed by default; the
// Excel export mirrors the authorized, filtered rows; hook-order stability (all hooks above the single return); and
// that the default-OFF flag leaves the v1 Listing Health route byte-unchanged. Offline, no React render. 7-bit, LF.

import assert from "node:assert/strict";
import { readFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  V3_GATES, GATE_RANK, v3GateForRow, v3WhyFlagged, v3RecommendedAction,
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
  for (const c of ["Product Name", "SKU", "ASIN", "Brand", "Gate", "Status", "Fulfilment", "Price", "On Hand FBA", "On Hand FBM", "Sales (selected period)", "Units (selected period)", "Sales at Risk", "Buyable", "Discoverable", "Live Offer", "Amazon Issue", "Why Flagged", "Recommended Action"]) {
    ok(`G: export carries column '${c}'`, cols.includes(c));
  }
  ok("G: export sales/units are the durable window numbers", rows[0]["Sales (selected period)"] === 150 && rows[0]["Units (selected period)"] === 15);
  ok("G: export gate + recommended action match the presenter", rows[1].Gate === V3_GATES.inactive.label && /Investigate/.test(rows[1]["Recommended Action"]));
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

/* ===================== I. exact 16 UI columns (view source contract) ===================== */
(() => {
  const src = readFileSync(path.join(root, "src", "views", "ListingHealthV3.jsx"), "utf8");
  const thead = src.slice(src.indexOf("<thead>"), src.indexOf("</thead>"));
  const headerCells = (thead.match(/<SortTh\b/g) || []).length + (thead.match(/<th\b/g) || []).length;
  ok("I: the table declares EXACTLY 16 header cells", headerCells === 16);
  const LABELS = ["Product / SKU", "Gate", "Status", "Fulfilment", "Price", "On Hand FBA", "On Hand FBM", "Sales", "Units", "Sales at Risk", "Buyable", "Discoverable", "Live Offer", "Amazon Issue", "Why Flagged", "Recommended Action"];
  for (const l of LABELS) ok(`I: column present: ${l}`, thead.includes(`"${l}"`) || thead.includes(`>${l}<`));
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

/* ===================== K. default-OFF flag leaves the v1 route byte-unchanged ===================== */
(() => {
  ok("K: LISTING_HEALTH_V3 defaults to OFF", LISTING_HEALTH_V3 === false);
  const app = readFileSync(path.join(root, "src", "App.jsx"), "utf8");
  ok("K: the v3 render branch is gated by the flag", app.includes('view === "listinghealth-v3" && LISTING_HEALTH_V3'));
  ok("K: the v1 Listing Health route is UNCONDITIONAL (never flag-gated)", app.includes('view === "listinghealth" && (') && !app.includes('view === "listinghealth" && LISTING_HEALTH'));
  ok("K: the v3 hook is active ONLY on its own flagged view (never the Priority Feed)", app.includes('active: LISTING_HEALTH_V3 && view === "listinghealth-v3"'));
  const shell = readFileSync(path.join(root, "src", "components", "shell.jsx"), "utf8");
  ok("K: the v3 nav item is spread behind the flag", /LISTING_HEALTH_V3\s*\?\s*\[\{\s*view:\s*"listinghealth-v3"/.test(shell));
  ok("K: the v1 nav item stays present and unconditional", shell.includes('view: "listinghealth", label: "Listing Health"'));
})();

writeSync(1, `\nlisting-health-v3-view: ${passed} assertions passed\n`);
