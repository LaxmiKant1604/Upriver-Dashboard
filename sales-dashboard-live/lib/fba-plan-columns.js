// Canonical FBA Shipment Plan COLUMN registry -- the ONE source of truth shared by the client (App.jsx renders the
// same ids/labels/groups with attached cell renderers) and the server (api/fba-plan-columns.js validates a saved
// hidden set against it). PURE + offline-testable: no React, no supabase, no Node built-ins, so it is safe to import
// into BOTH the browser bundle and the serverless handler. A drift-guard test asserts these ids/locked/awd/order stay
// identical to App.jsx's planColumns, so validation can never diverge from the rendered table.
//
// `locked` columns (Product / ASIN) can never be hidden. `awd` columns are valid hideable ids everywhere, but the
// client only SHOWS them for AWD-eligible marketplaces (planVisibleColumns filters them out otherwise) -- a saved
// hidden set may legitimately contain them, so validation accepts them.

export const FBA_PLAN_COLUMNS = Object.freeze([
  { id: "asin", group: "Identity", locked: true },
  { id: "m1", group: "Sales" },
  { id: "m2", group: "Sales" },
  { id: "m3", group: "Sales" },
  { id: "mtdUnits", group: "Sales" },
  { id: "threeMoAvg", group: "Forecast" },
  { id: "mtdProjected", group: "Forecast" },
  { id: "targetUnits", group: "Forecast" },
  { id: "fbaAvailable", group: "Inventory" },
  { id: "fbaDaysCover", group: "Inventory" },
  { id: "custReserved", group: "Inventory" },
  { id: "reserved", group: "Inventory" },
  { id: "reservedFcTransfer", group: "Inventory" },
  { id: "reservedFcProcessing", group: "Inventory" },
  { id: "inboundPipeline", group: "Inventory" },
  { id: "inboundWorking", group: "Inventory" },
  { id: "inboundShipped", group: "Inventory" },
  { id: "inboundReceived", group: "Inventory" },
  { id: "awd", group: "Inventory", awd: true },
  { id: "awdInbound", group: "Inventory", awd: true },
  { id: "totalFbaInv", group: "Inventory" },
  { id: "amazonNetwork", group: "Inventory" },
  { id: "recommended", group: "Inventory" },
  { id: "pipeline", group: "Planning" },
  { id: "horizon", group: "Planning" },
  { id: "horizonDemand", group: "Planning" },
  { id: "safety", group: "Planning" },
  { id: "targetInv", group: "Planning" },
  { id: "sellerWh", group: "Planning" },
  { id: "shipWh", group: "Planning" },
  { id: "produce", group: "Planning" },
  { id: "stockout", group: "Planning" },
  { id: "priority", group: "Planning" },
  { id: "remark", group: "Status" },
  { id: "avg7", group: "Demand (WDD)" },
  { id: "avg30", group: "Demand (WDD)" },
  { id: "avg60", group: "Demand (WDD)" },
  { id: "wdd", group: "Demand (WDD)" },
  { id: "ltProd", group: "Lead Time" },
  { id: "ltShip", group: "Lead Time" },
  { id: "ltAwd", group: "Lead Time" },
  { id: "ltSafety", group: "Lead Time" },
  { id: "ltTotal", group: "Lead Time" },
  { id: "inboundEta", group: "Lead Time" },
  { id: "daysToInbound", group: "Lead Time" },
  { id: "idealCover", group: "Reorder" },
  { id: "existingCover", group: "Reorder" },
  { id: "reorderStatus", group: "Reorder" },
  { id: "suggestedReorder", group: "Reorder" },
]);

// The columns HIDDEN by default for an account with no saved preference (the raw inventory-component columns).
export const PLAN_DEFAULT_HIDDEN_COLS = Object.freeze([
  "reservedFcTransfer", "reservedFcProcessing", "inboundWorking", "inboundShipped", "inboundReceived",
]);

export const FBA_PLAN_COLUMN_IDS = Object.freeze(FBA_PLAN_COLUMNS.map((c) => c.id));
const ID_SET = new Set(FBA_PLAN_COLUMN_IDS);
export const FBA_PLAN_LOCKED_IDS = Object.freeze(FBA_PLAN_COLUMNS.filter((c) => c.locked).map((c) => c.id));
const LOCKED_SET = new Set(FBA_PLAN_LOCKED_IDS);
export const FBA_PLAN_AWD_IDS = Object.freeze(FBA_PLAN_COLUMNS.filter((c) => c.awd).map((c) => c.id));
// A hidden set can carry at most every HIDEABLE (non-locked) column id. This is the hard cap the server enforces.
export const MAX_FBA_PLAN_HIDDEN = FBA_PLAN_COLUMN_IDS.length - FBA_PLAN_LOCKED_IDS.length;

export function isFbaPlanColumnId(id) { return ID_SET.has(String(id)); }
export function isFbaPlanLockedColumn(id) { return LOCKED_SET.has(String(id)); }

/**
 * Validate a saved hidden-column set against the canonical registry. PURE. Returns
 *   { ok: true, cleaned: string[] }  (canonical registry order, deduped) OR
 *   { ok: false, error: string }.
 * Rejects: a non-array; a non-string / blank / whitespace-padded id; an unknown id; a LOCKED id (Product / ASIN can
 * never be hidden); a duplicate id; more than MAX_FBA_PLAN_HIDDEN ids. The AWD ids are accepted (a valid hideable id;
 * marketplace eligibility is a client display concern, never a save-validity one).
 */
export function validateHiddenColumns(hidden) {
  if (!Array.isArray(hidden)) return { ok: false, error: "hiddenColumns must be an array of column ids." };
  if (hidden.length > MAX_FBA_PLAN_HIDDEN) return { ok: false, error: `too many hidden columns (max ${MAX_FBA_PLAN_HIDDEN}).` };
  const seen = new Set();
  for (const raw of hidden) {
    if (typeof raw !== "string") return { ok: false, error: "every hidden column id must be a string." };
    if (raw !== raw.trim() || raw.trim() === "") return { ok: false, error: "a hidden column id is blank or malformed." };
    if (!ID_SET.has(raw)) return { ok: false, error: `unknown FBA plan column id: ${raw}.` };
    if (LOCKED_SET.has(raw)) return { ok: false, error: `column ${raw} is locked and can never be hidden.` };
    if (seen.has(raw)) return { ok: false, error: `duplicate hidden column id: ${raw}.` };
    seen.add(raw);
  }
  // Return in canonical registry order (stable, independent of the request's ordering).
  return { ok: true, cleaned: FBA_PLAN_COLUMN_IDS.filter((id) => seen.has(id)) };
}
