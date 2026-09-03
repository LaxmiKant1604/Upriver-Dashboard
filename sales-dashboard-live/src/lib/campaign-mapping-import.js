// Campaign Brand Mapping template + import -- PURE, dependency-light, offline-testable. Reuses the repository's proven
// RFC4180 parser (parseDelimited from warehouse-import.js) for CSV/TSV; the XLSX path feeds the SAME validator with
// the string[][] that readXlsxFirstSheet produces. Campaign and profile identifiers are treated STRICTLY as strings
// and never coerced, rounded, or reconstructed. This module writes NO data and calls NO API -- it only parses,
// validates and builds the download matrix; the server remains the authorization + write authority.
import { parseDelimited } from "./warehouse-import.js";

// The mapping columns, in order. The FIRST exported row is exactly this header (never a 0,1,2... index row).
export const CAMPAIGN_MAPPING_COLUMNS = Object.freeze([
  "account", "marketplace", "ads_profile_id", "campaign_id", "campaign_name", "campaign_type",
  "campaign_status", "current_brand", "new_brand", "action", "note", "last_synced_at",
]);
// Columns whose values are long numeric identifiers Excel must keep as TEXT (never scientific notation).
export const CAMPAIGN_TEXT_COLUMNS = Object.freeze(["account", "marketplace", "ads_profile_id", "campaign_id"]);

const norm = (v) => String(v == null ? "" : v).replace(/^﻿/, "").trim();
const normKey = (v) => norm(v).toLowerCase();

// Build the download matrix (array of arrays, header first). EVERY cell is a STRING so the XLSX writer emits inline
// (text) cells and Excel cannot convert a long campaign_id/ads_profile_id to scientific notation. Reused for CSV too.
export function buildCampaignMappingMatrix({ accountId = "", campaigns = [] } = {}) {
  const rows = [[...CAMPAIGN_MAPPING_COLUMNS]];
  for (const c of Array.isArray(campaigns) ? campaigns : []) {
    rows.push([
      String(accountId ?? ""), String(c.marketplace ?? ""), String(c.adsProfileId ?? ""), String(c.campaignId ?? ""),
      String(c.campaignName ?? ""), String(c.campaignType ?? ""), String(c.campaignStatus ?? ""),
      String(c.brandDisplay ?? ""), "", "", "", String(c.lastObservedDate ?? ""),
    ]);
  }
  return rows;
}

// Detect the REAL header row within the first few non-empty rows: the first row that contains BOTH campaign_id and
// marketplace (case-insensitive, BOM/space-trimmed). A legacy numeric-index row (0,1,2,...,11) written by the old
// buggy exporter is simply skipped -- the real header is identified beneath it. Returns { headerIndex, map } or
// { headerIndex: -1 }.
export function detectHeader(matrix) {
  const rows = Array.isArray(matrix) ? matrix : [];
  const limit = Math.min(rows.length, 6);
  for (let i = 0; i < limit; i += 1) {
    const keys = (rows[i] || []).map(normKey);
    if (keys.includes("campaign_id") && keys.includes("marketplace")) {
      const map = {};
      keys.forEach((k, idx) => { if (k && !(k in map)) map[k] = idx; });
      return { headerIndex: i, map };
    }
  }
  return { headerIndex: -1, map: null };
}

// Excel-damage detection for an identifier that MUST stay an exact string. Never coerces or reconstructs.
const SCIENTIFIC = /\d[eE][+-]?\d/;
export function idCorruption(value) {
  const v = norm(value);
  if (v === "") return null;
  if (SCIENTIFIC.test(v)) return "scientific-notation";              // 1.06167E+14
  if (/^[+-]?\d*\.\d+$/.test(v)) return "decimal-form";               // 106167000000000.0
  if (/^[+-]?(nan|infinity)$/i.test(v)) return "not-a-number";        // NaN / Infinity
  return null;
}

const SCI_MESSAGE = "Campaign IDs were converted to scientific notation by Excel and cannot be matched safely. Download the new XLSX mapping template, enter brands there, and upload it again. Nothing was written.";

// Validate ALREADY-PARSED rows (string[][], any leading numeric-index row tolerated). Pure. Returns a preview +
// all-or-nothing apply set. `applyRows` is EMPTY unless the whole file is valid (one invalid row -> zero writes).
export function validateCampaignMappingRows(matrix) {
  const rows = Array.isArray(matrix) ? matrix : [];
  const { headerIndex, map } = detectHeader(rows);
  const preview = { total: 0, assign: 0, clear: 0, ignored: 0, invalid: 0 };
  if (headerIndex < 0) {
    return { ok: false, missingHeader: true, scientificDetected: false, errors: [{ line: 0, reason: "The file must include a header row with at least campaign_id and marketplace." }], applyRows: [], preview, message: "The file must include at least campaign_id and marketplace columns." };
  }
  const iCamp = map.campaign_id, iMkt = map.marketplace;
  const iProf = "ads_profile_id" in map ? map.ads_profile_id : -1;
  const iNew = "new_brand" in map ? map.new_brand : -1;
  const iNote = "note" in map ? map.note : -1;
  const iAction = "action" in map ? map.action : -1;
  const errors = [];
  const applyRows = [];
  const seen = new Map(); // identity -> brand (same-file conflict guard)
  let scientificDetected = false;
  for (let d = headerIndex + 1; d < rows.length; d += 1) {
    const r = rows[d] || [];
    if (!r.some((c) => norm(c) !== "")) continue; // skip a wholly-blank row
    const line = d + 1; // 1-based line number in the file
    preview.total += 1;
    const action = (iAction >= 0 ? norm(r[iAction]) : "").toUpperCase();
    const newBrand = iNew >= 0 ? norm(r[iNew]) : "";
    if (!newBrand && action !== "CLEAR") { preview.ignored += 1; continue; } // unchanged row -> ignored
    const campaignId = norm(r[iCamp]);
    const marketplace = norm(r[iMkt]);
    const adsProfileId = iProf >= 0 ? norm(r[iProf]) : "";
    if (!campaignId || !marketplace) { errors.push({ line, reason: "blank campaign_id or marketplace" }); preview.invalid += 1; continue; }
    const corrupt = idCorruption(campaignId) || idCorruption(adsProfileId);
    if (corrupt === "scientific-notation") { scientificDetected = true; errors.push({ line, reason: "campaign_id/ads_profile_id in scientific notation" }); preview.invalid += 1; continue; }
    if (corrupt) { errors.push({ line, reason: `campaign_id/ads_profile_id is ${corrupt} (identifiers must be exact)` }); preview.invalid += 1; continue; }
    const identity = `${marketplace}|${adsProfileId}|${campaignId}`;
    const brand = action === "CLEAR" ? "" : newBrand;
    if (seen.has(identity) && seen.get(identity) !== brand) { errors.push({ line, reason: `campaign ${campaignId} appears more than once with conflicting brands` }); preview.invalid += 1; continue; }
    seen.set(identity, brand);
    if (action === "CLEAR") preview.clear += 1; else preview.assign += 1;
    applyRows.push({ campaignId, marketplace, adsProfileId, brand, note: iNote >= 0 ? norm(r[iNote]) : "", action: action === "CLEAR" ? "CLEAR" : "ASSIGN", line });
  }
  const nothingToApply = errors.length === 0 && applyRows.length === 0;
  const ok = errors.length === 0 && applyRows.length > 0;
  const message = errors.length
    ? (scientificDetected ? SCI_MESSAGE : `${errors.length} row(s) are invalid; nothing was written. First: line ${errors[0].line} — ${errors[0].reason}.`)
    : nothingToApply ? "No rows to apply (fill new_brand or set action=CLEAR)." : null;
  return { ok, missingHeader: false, scientificDetected, errors, applyRows: ok ? applyRows : [], preview, nothingToApply, message };
}

// Full validate from raw CSV/TSV text (BOM, quoted commas, escaped quotes, CRLF/LF, blank trailing cells) using the
// shared RFC4180 parser -- the SAME validator the XLSX path uses.
export function validateCampaignMappingText(text) {
  return validateCampaignMappingRows(parseDelimited(text));
}
