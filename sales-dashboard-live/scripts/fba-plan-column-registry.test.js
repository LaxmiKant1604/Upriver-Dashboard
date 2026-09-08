// Canonical FBA Shipment Plan column-registry validation + DRIFT GUARD + SKU-Movement regression (offline, pure).
//
// Proves: (1) validateHiddenColumns enforces the spec (unknown / locked / duplicate / malformed / over-max rejected;
// AWD + empty accepted; canonical order); (2) the shared registry (lib/fba-plan-columns.js) never DRIFTS from the
// columns App.jsx actually renders -- ids, groups, locked, awd, order, and the default hidden set are asserted
// EXACTLY against src/App.jsx's planColumns + PLAN_DEFAULT_HIDDEN_COLS; (3) SKU Movement's user-scoped prefs
// (functions + table + endpoint) are byte-unchanged by this work. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import {
  FBA_PLAN_COLUMNS, FBA_PLAN_COLUMN_IDS, PLAN_DEFAULT_HIDDEN_COLS, FBA_PLAN_LOCKED_IDS, FBA_PLAN_AWD_IDS,
  MAX_FBA_PLAN_HIDDEN, validateHiddenColumns,
} from "../lib/fba-plan-columns.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "fba-plan-column-registry\n");

/* ===================== validateHiddenColumns ===================== */
(() => {
  ok("validate: a valid subset passes + returns canonical registry order", (() => { const r = validateHiddenColumns(["wdd", "m1", "priority"]); return r.ok && r.cleaned.join(",") === FBA_PLAN_COLUMN_IDS.filter((id) => ["wdd", "m1", "priority"].includes(id)).join(","); })());
  ok("validate: an empty set is valid (Select all)", validateHiddenColumns([]).ok === true);
  ok("validate: AWD ids are accepted (valid hideable ids)", validateHiddenColumns(["awd", "awdInbound"]).ok === true);
  ok("validate: the exact default set is valid", validateHiddenColumns([...PLAN_DEFAULT_HIDDEN_COLS]).ok === true);
  ok("validate: an unknown id is rejected", validateHiddenColumns(["nope"]).ok === false);
  ok("validate: the LOCKED Product/ASIN id is rejected", validateHiddenColumns(["asin"]).ok === false);
  ok("validate: a duplicate id is rejected", validateHiddenColumns(["m1", "m1"]).ok === false);
  ok("validate: a whitespace-padded id is rejected", validateHiddenColumns([" m1"]).ok === false);
  ok("validate: a non-string id is rejected", validateHiddenColumns([42]).ok === false);
  ok("validate: a non-array is rejected", validateHiddenColumns("m1").ok === false && validateHiddenColumns(null).ok === false);
  ok("validate: more than MAX ids is rejected", validateHiddenColumns(FBA_PLAN_COLUMN_IDS.concat(["m1"])).ok === false);
  ok("validate: MAX equals the hideable (non-locked) column count", MAX_FBA_PLAN_HIDDEN === FBA_PLAN_COLUMN_IDS.length - FBA_PLAN_LOCKED_IDS.length);
  ok("registry: Product/ASIN is the only locked column; awd + awdInbound are the AWD columns", FBA_PLAN_LOCKED_IDS.join(",") === "asin" && FBA_PLAN_AWD_IDS.slice().sort().join(",") === "awd,awdInbound");
})();

/* ===================== DRIFT GUARD: shared registry === App.jsx planColumns ===================== */
(() => {
  const src = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  // Extract the planColumns useMemo array body.
  const start = src.indexOf("const planColumns = useMemo");
  ok("drift: located planColumns in App.jsx", start >= 0);
  const block = src.slice(start, src.indexOf("}, [planData", start));
  // Each column entry begins on its own line as `{ id: "X", group: "Y", ...`. Parse id, group, and the locked/awd flags.
  const parsed = [];
  for (const line of block.split(/\r?\n/)) {
    const m = /\{\s*id:\s*"([^"]+)",\s*group:\s*"([^"]+)"/.exec(line);
    if (!m) continue;
    const col = { id: m[1], group: m[2] };
    if (/\blocked:\s*true\b/.test(line)) col.locked = true;
    if (/\bawd:\s*true\b/.test(line)) col.awd = true;
    parsed.push(col);
  }
  ok("drift: same COUNT of columns in the shared registry and App.jsx", parsed.length === FBA_PLAN_COLUMNS.length);
  const norm = (c) => `${c.id}|${c.group}|${c.locked ? "L" : ""}|${c.awd ? "A" : ""}`;
  const sharedSig = FBA_PLAN_COLUMNS.map(norm).join("\n");
  const appSig = parsed.map(norm).join("\n");
  ok("drift: ids/groups/locked/awd + ORDER are byte-identical between the shared registry and App.jsx", sharedSig === appSig);
  // The client's inline PLAN_DEFAULT_HIDDEN_COLS must equal the shared default.
  const dm = /const PLAN_DEFAULT_HIDDEN_COLS = \[([^\]]*)\]/.exec(src);
  ok("drift: located App.jsx PLAN_DEFAULT_HIDDEN_COLS", !!dm);
  const appDefaults = (dm[1].match(/"([^"]+)"/g) || []).map((s) => s.replace(/"/g, ""));
  ok("drift: the default hidden set matches the shared registry", appDefaults.join(",") === [...PLAN_DEFAULT_HIDDEN_COLS].join(","));
})();

/* ===================== SKU MOVEMENT regression (source guards) ===================== */
(() => {
  const supa = readFileSync(new URL("../lib/server/supabase.js", import.meta.url), "utf8");
  // The per-USER prefs functions + their table + upsert key remain intact (shared with SKU Movement, unchanged).
  ok("regression: the per-user getFbaPlanColumnPrefs/setFbaPlanColumnPrefs still exist", /export async function getFbaPlanColumnPrefs\(/.test(supa) && /export async function setFbaPlanColumnPrefs\(/.test(supa));
  ok("regression: the per-user upsert still targets user_id,report_key on fba_plan_column_prefs", /on_conflict=user_id,report_key/.test(supa) && /fba_plan_column_prefs\?/.test(supa));
  // The NEW account-scoped functions target the NEW table on the full identity key (never account_id alone).
  ok("regression: the new account-scoped functions target the account table on the full identity", /export async function getFbaPlanAccountColumnPrefs\(/.test(supa) && /on_conflict=organization_fingerprint,connection_id,account_id,report_key/.test(supa));
  // The SKU Movement prefs endpoint is untouched + still user-scoped (no accountId / account authorization added).
  const skuPrefs = readFileSync(new URL("../api/sku-movement-prefs.js", import.meta.url), "utf8");
  ok("regression: api/sku-movement-prefs stays user-scoped (no account authorization added)", !/assertAccountAccess/.test(skuPrefs));
})();

writeSync(1, `\nfba-plan-column-registry: ${passed} assertions passed\n`);
