// FBA Inventory latest-snapshot COMPACTION -- pure offline verification (no DataDoe/Supabase/network, no process.exit).
//
// Proves compactLatestInventorySnapshot: the 7 completeness conditions for a cap-sized payload; a >8MB-but-under-cap
// payload (the e5ce6a shape) compacts to a <8MB latest-date block; a cap-sized payload with a complete leading latest
// date (the fd7653 shape) is accepted for ONLY that date; every failure mode is rejected (never inferred complete);
// rows are FILTERED to the latest date, never SUMMED, with zero/null values preserved verbatim; the normalization is
// scoped to fba-inventory-health only; and a consumer taking the latest date sees the SAME rows from a compacted cache
// as from an old full-range cache (backward compatible). 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import {
  compactLatestInventorySnapshot, isLatestSnapshotSource,
  FBA_INVENTORY_ROW_CAP, FBA_INVENTORY_MAX_OBJECT_BYTES, LATEST_SNAPSHOT_NORMALIZATION_VERSION,
} from "../lib/server/sync/fba-inventory-latest-snapshot.js";
import { REPORT_SOURCE_CONTRACTS } from "../lib/server/sync/report-source-contracts.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "fba-inventory-latest-snapshot\n");

const SELLER = "S-1";
const MKT = "IN";
const row = (date, extra = {}) => ({ date, seller_or_vendor_id: SELLER, marketplace_country_code: MKT, ...extra });
const rowsOf = (date, n, extra = () => ({})) => Array.from({ length: n }, (_, i) => row(date, extra(i)));
// A latest-date consumer (what FBA Plan latestInventoryBySku + Listing Health v3 do): take only the max date's rows.
const latestDateRows = (rows) => { const max = rows.reduce((m, r) => (String(r.date) > m ? String(r.date) : m), ""); return rows.filter((r) => String(r.date) === max); };

/* ===================== A. e5ce6a shape: >8MB but UNDER the row cap -> compacts to a <8MB latest-date block ========= */
(() => {
  const PAD = "x".repeat(500); // ~560 bytes/row serialized => >8MB across 15859 rows, <8MB across the 1980 latest.
  const latest = rowsOf("2026-09-05", 1980, () => ({ pad: PAD }));
  const older = [];
  for (let d = 4; d >= 0; d -= 1) older.push(...rowsOf(`2026-09-0${d}`, Math.ceil((15859 - 1980) / 5), () => ({ pad: PAD })));
  const rows = [...latest, ...older].slice(0, 15859);
  const c = compactLatestInventorySnapshot({ rows, seller: SELLER, marketplace: MKT, exportRef: "exp-e5ce6a", requestedFrom: "2026-08-26", requestedTo: "2026-09-05" });
  ok("A: e5ce6a-shape latest date is provably complete", c.complete === true);
  ok("A: raw payload is > 8MB (the oversized single-seller export)", c.metadata.rawPayloadBytes > FBA_INVENTORY_MAX_OBJECT_BYTES);
  ok("A: compacted latest-date block is <= 8MB (fits the cache-object limit)", c.metadata.compactedPayloadBytes <= FBA_INVENTORY_MAX_OBJECT_BYTES);
  ok("A: compacted to ONLY the latest date (1980 rows, not the 15859 raw)", c.metadata.compactedRowCount === 1980 && c.metadata.rawRowCount === 15859);
  ok("A: snapshot date is the latest date", c.snapshotDate === "2026-09-05" && c.metadata.inventorySnapshotDate === "2026-09-05");
  ok("A: every returned row is the latest date (no summing across dates)", c.rows.length === 1980 && c.rows.every((r) => r.date === "2026-09-05"));
  ok("A: metadata records the export reference + requested window", c.metadata.sourceExportRef === "exp-e5ce6a" && c.metadata.requestedFrom === "2026-08-26" && c.metadata.requestedTo === "2026-09-05");
  ok("A: metadata carries the normalization version + flag", c.metadata.normalizedLatestSnapshot === true && c.metadata.normalizationVersion === LATEST_SNAPSHOT_NORMALIZATION_VERSION);
})();

/* ===================== B. fd7653 shape: CAP-SIZED (50000) with a complete leading latest date -> accepted =========== */
(() => {
  const latestN = 9191;
  const rows = [...rowsOf("2026-09-05", latestN), ...rowsOf("2026-09-04", FBA_INVENTORY_ROW_CAP - latestN)];
  assert.equal(rows.length, FBA_INVENTORY_ROW_CAP);
  const c = compactLatestInventorySnapshot({ rows, seller: SELLER, marketplace: MKT, exportRef: "exp-fd7653" });
  ok("B: a cap-sized payload with a complete leading latest date is accepted", c.complete === true && c.proof.capSized === true);
  ok("B: accepted for ONLY the latest date (9191 rows), the raw 50000 is not persisted", c.metadata.compactedRowCount === latestN && c.metadata.rawRowCount === FBA_INVENTORY_ROW_CAP);
  ok("B: the older-date-after proof held (the latest block was not itself truncated)", c.proof.olderDateAfterBlock === true && c.proof.noLatestAfterOlder === true);
  ok("B: never summed -- compacted row count is strictly less than the raw count", c.metadata.compactedRowCount < c.metadata.rawRowCount);
})();

/* ===================== C. CAP-SIZED all one date -> REJECTED (block fills the cap; no older date proves completeness) */
(() => {
  const rows = rowsOf("2026-09-05", FBA_INVENTORY_ROW_CAP);
  const c = compactLatestInventorySnapshot({ rows, seller: SELLER, marketplace: MKT });
  ok("C: a cap-sized single-date payload is REJECTED (single-seller latest-date overflow = hard stop)", c.complete === false);
  ok("C: the failing conditions are olderDateAfterBlock + blockUnderRowCap", /olderDateAfterBlock/.test(c.reason) && /blockUnderRowCap/.test(c.reason));
})();

/* ===================== D. non-monotonic ordering -> REJECTED ===================== */
(() => {
  const rows = [row("2026-09-05"), row("2026-09-03"), row("2026-09-04")]; // 09-04 after 09-03 breaks date-DESC
  const c = compactLatestInventorySnapshot({ rows, seller: SELLER, marketplace: MKT });
  ok("D: a non-monotonic (not date-descending) payload is REJECTED", c.complete === false && /monotonicDesc/.test(c.reason));
})();

/* ===================== E. a latest-date row after an older date -> REJECTED ===================== */
(() => {
  const rows = [row("2026-09-05"), row("2026-09-05"), row("2026-09-04"), row("2026-09-05")];
  const c = compactLatestInventorySnapshot({ rows, seller: SELLER, marketplace: MKT });
  ok("E: a latest-date row reappearing after an older date is REJECTED", c.complete === false && /noLatestAfterOlder/.test(c.reason));
})();

/* ===================== F. cross-seller / cross-marketplace row in the latest block -> REJECTED ===================== */
(() => {
  const wrongSeller = [row("2026-09-05"), { date: "2026-09-05", seller_or_vendor_id: "OTHER", marketplace_country_code: MKT }, row("2026-09-04")];
  const cS = compactLatestInventorySnapshot({ rows: wrongSeller, seller: SELLER, marketplace: MKT });
  ok("F: a cross-SELLER row in the latest block is REJECTED", cS.complete === false && /allBlockSellerMkt/.test(cS.reason));
  const wrongMkt = [row("2026-09-05"), { date: "2026-09-05", seller_or_vendor_id: SELLER, marketplace_country_code: "US" }, row("2026-09-04")];
  const cM = compactLatestInventorySnapshot({ rows: wrongMkt, seller: SELLER, marketplace: MKT });
  ok("F: a cross-MARKETPLACE row in the latest block is REJECTED", cM.complete === false && /allBlockSellerMkt/.test(cM.reason));
})();

/* ===================== G. the latest-date block itself exceeds 8MB -> REJECTED ===================== */
(() => {
  const PAD = "y".repeat(600);
  const rows = [...rowsOf("2026-09-05", 15000, () => ({ pad: PAD })), ...rowsOf("2026-09-04", 100, () => ({ pad: PAD }))]; // 15100 < cap
  const c = compactLatestInventorySnapshot({ rows, seller: SELLER, marketplace: MKT });
  ok("G: a latest-date block over 8MB is REJECTED (compacted payload would exceed the cache-object limit)", c.complete === false && /compactUnder8MB/.test(c.reason));
  ok("G: it was NOT a row-cap or ordering failure (only the byte guard failed)", c.proof.blockUnderRowCap === true && c.proof.monotonicDesc === true && c.proof.olderDateAfterBlock === true);
})();

/* ===================== H. FILTERED not SUMMED; zero + null values preserved verbatim ===================== */
(() => {
  const rows = [
    row("2026-09-05", { sku: "A", units: 0 }),
    row("2026-09-05", { sku: "B", units: null }),
    row("2026-09-05", { sku: "C", units: 7 }),
    row("2026-09-04", { sku: "A", units: 5 }),
    row("2026-09-04", { sku: "B", units: 9 }),
  ];
  const c = compactLatestInventorySnapshot({ rows, seller: SELLER, marketplace: MKT });
  ok("H: only the 3 latest-date rows are returned (the 2 older rows are dropped, not merged)", c.complete === true && c.rows.length === 3 && c.rows.every((r) => r.date === "2026-09-05"));
  ok("H: a zero inventory value is preserved verbatim", c.rows.find((r) => r.sku === "A").units === 0);
  ok("H: a null inventory value is preserved verbatim", c.rows.find((r) => r.sku === "B").units === null);
  ok("H: NOT summed -- SKU A's latest units is 0, never 0+5=5 from the older date", c.rows.find((r) => r.sku === "A").units !== 5);
  ok("H: the returned rows are the exact latest-date row objects (unmutated)", c.rows[0] === rows[0] && c.rows[1] === rows[1] && c.rows[2] === rows[2]);
})();

/* ===================== I. normal small single-date snapshot (daily happy path) -> complete ===================== */
(() => {
  const rows = rowsOf("2026-09-05", 5);
  const c = compactLatestInventorySnapshot({ rows, seller: SELLER, marketplace: MKT });
  ok("I: a small single-date (non-cap) snapshot is complete without an older-date-after proof", c.complete === true && c.proof.capSized === false && c.metadata.compactedRowCount === 5);
})();

/* ===================== J. backward compatibility: a consumer's latest-date view is identical either way ============ */
(() => {
  const full = [...rowsOf("2026-09-05", 4), ...rowsOf("2026-09-04", 10), ...rowsOf("2026-09-03", 6)];
  const c = compactLatestInventorySnapshot({ rows: full, seller: SELLER, marketplace: MKT });
  // A latest-date consumer over the OLD full-range cache and over the NEW compacted cache must see identical rows.
  ok("J: a latest-date consumer sees the SAME rows from a full-range cache and a compacted cache", JSON.stringify(latestDateRows(full)) === JSON.stringify(c.rows));
  ok("J: the compacted output IS the latest-date subset (no additional/duplicated rows)", c.rows.length === 4 && c.rows.every((r) => r.date === "2026-09-05"));
})();

/* ===================== K. malformed / empty / undated payloads -> typed rejects (never inferred complete) ========== */
(() => {
  ok("K: a non-array payload is MALFORMED_PAYLOAD", compactLatestInventorySnapshot({ rows: null, seller: SELLER, marketplace: MKT }).reason === "MALFORMED_PAYLOAD");
  ok("K: an empty payload is EMPTY_PAYLOAD", compactLatestInventorySnapshot({ rows: [], seller: SELLER, marketplace: MKT }).reason === "EMPTY_PAYLOAD");
  ok("K: rows with no valid date are NO_VALID_LATEST_DATE", compactLatestInventorySnapshot({ rows: [{ seller_or_vendor_id: SELLER, marketplace_country_code: MKT }], seller: SELLER, marketplace: MKT }).reason === "NO_VALID_LATEST_DATE");
})();

/* ===================== K2. bounded exact-single-day EMPTY -> typed inventory-UNAVAILABLE (defect 2) ============ */
(() => {
  // A validated, successfully-completed export for the EXACT single D-1 day that returned ZERO rows is honest
  // inventory-UNAVAILABLE: complete:true + empty + inventoryAvailable:false + snapshotDate null + rows [] -- NOT a
  // measured zero, NOT a proven snapshot date, NOT a truncation. This makes a single-seller latest-snapshot empty
  // response CONSISTENT with a multi-seller batch's zero-row valid-empty (which the generic path already accepts),
  // so splitting a seller can no longer flip a successful empty inventory export from valid-empty to blocked.
  const c = compactLatestInventorySnapshot({ rows: [], seller: SELLER, marketplace: MKT, requestedFrom: "2026-09-08", requestedTo: "2026-09-08", exportRef: "exp-empty" });
  ok("K2: a bounded exact-single-day (D-1) EMPTY export is complete + typed unavailable (valid-empty, not blocked)", c.complete === true && c.empty === true && c.inventoryAvailable === false);
  ok("K2: an empty D-1 export has NO snapshot date and NO rows (never a proven date, never a fabricated zero)", c.snapshotDate === null && Array.isArray(c.rows) && c.rows.length === 0);
  ok("K2: the metadata records the unavailable/empty provenance (distinguishable from a nonempty snapshot)",
    c.metadata.inventoryUnavailable === true && c.metadata.emptyInventorySnapshot === true && c.metadata.inventorySnapshotDate === null
    && c.metadata.normalizedLatestSnapshot === true && c.metadata.normalizationVersion === LATEST_SNAPSHOT_NORMALIZATION_VERSION && c.metadata.sourceExportRef === "exp-empty");
  // An UNBOUNDED / multi-day / missing-window empty proves NOTHING -> still EMPTY_PAYLOAD (rejected), never inferred
  // unavailable (section K already covers the no-window case; here prove a MULTI-DAY empty lookback stays rejected).
  const multi = compactLatestInventorySnapshot({ rows: [], seller: SELLER, marketplace: MKT, requestedFrom: "2026-08-30", requestedTo: "2026-09-08" });
  ok("K2: a MULTI-day empty lookback is STILL EMPTY_PAYLOAD (unbounded empty proves nothing; not relabeled unavailable)", multi.complete === false && multi.reason === "EMPTY_PAYLOAD");
  const halfBound = compactLatestInventorySnapshot({ rows: [], seller: SELLER, marketplace: MKT, requestedFrom: "2026-09-08", requestedTo: "" });
  ok("K2: a half-bounded (from only) empty is STILL EMPTY_PAYLOAD (requires from===to, both real dates)", halfBound.complete === false && halfBound.reason === "EMPTY_PAYLOAD");

  // CALENDAR validation (Codex finding 2): the window must be a REAL day (round-trip), not just YYYY-MM-DD shape. An
  // impossible day/month is REJECTED (never mistaken for a bounded D-1 empty); a valid historical / leap day is honored.
  const emptyBounded = (from, to) => compactLatestInventorySnapshot({ rows: [], seller: SELLER, marketplace: MKT, requestedFrom: from, requestedTo: to });
  ok("K2-cal: an IMPOSSIBLE day (2026-02-30) is REJECTED (EMPTY_PAYLOAD), not accepted as bounded-empty", emptyBounded("2026-02-30", "2026-02-30").complete === false && emptyBounded("2026-02-30", "2026-02-30").reason === "EMPTY_PAYLOAD");
  ok("K2-cal: an IMPOSSIBLE month/day (2026-99-99) is REJECTED (EMPTY_PAYLOAD)", emptyBounded("2026-99-99", "2026-99-99").complete === false && emptyBounded("2026-99-99", "2026-99-99").reason === "EMPTY_PAYLOAD");
  ok("K2-cal: 0000-00-00 / month 00 is REJECTED (EMPTY_PAYLOAD)", emptyBounded("2026-00-00", "2026-00-00").reason === "EMPTY_PAYLOAD" && emptyBounded("0000-00-00", "0000-00-00").reason === "EMPTY_PAYLOAD");
  ok("K2-cal: a NON-leap Feb 29 (2026-02-29) is REJECTED (EMPTY_PAYLOAD)", emptyBounded("2026-02-29", "2026-02-29").complete === false && emptyBounded("2026-02-29", "2026-02-29").reason === "EMPTY_PAYLOAD");
  const leap = emptyBounded("2024-02-29", "2024-02-29");
  ok("K2-cal: a VALID leap Feb 29 (2024-02-29) empty is accepted as bounded inventory-UNAVAILABLE", leap.complete === true && leap.empty === true && leap.inventoryAvailable === false);
  const historical = emptyBounded("2025-01-15", "2025-01-15");
  ok("K2-cal: a VALID historical exact-day empty is preserved (accepted; no comparison against today's D-1)", historical.complete === true && historical.empty === true && historical.snapshotDate === null);
})();

/* ===================== L. the exception is scoped to fba-inventory-health ONLY ===================== */
(() => {
  ok("L: fba-inventory-health IS a latest-snapshot source", isLatestSnapshotSource("fba-inventory-health") === true);
  ok("L: OLI / catalog / ads / listings are NOT (generic strict validator unchanged for them)",
    ["order-line-items", "product-catalog", "ads-campaign-performance", "listings", "listings-raw", ""].every((k) => isLatestSnapshotSource(k) === false));
  ok("L: FBA_INVENTORY_ROW_CAP + MAX_OBJECT_BYTES match the source cache limits", FBA_INVENTORY_ROW_CAP === 50000 && FBA_INVENTORY_MAX_OBJECT_BYTES === 8 * 1024 * 1024);
})();

/* ===================== M. the `latestSnapshot` flag is on EXACTLY the two FBA/v3 inventory contracts =============== */
(() => {
  const contract = (reportKey, requestKey) => (REPORT_SOURCE_CONTRACTS[reportKey] || []).find((c) => c.requestKey === requestKey);
  const flagged = [["fba-plan", "fba-plan:inventory-health"], ["listing-health-v3", "listing-health-v3:inventory"]];
  const notFlagged = [["buy-box-loss", "buy-box-loss:inventory"], ["sales-movers", "sales-movers:inventory"]];
  ok("M: fba-plan + v3 inventory contracts ARE marked latestSnapshot:true", flagged.every(([r, k]) => contract(r, k) && contract(r, k).latestSnapshot === true));
  ok("M: they both use the fba-inventory-health source key (shared identity)", flagged.every(([r, k]) => contract(r, k).sourceKey === "fba-inventory-health"));
  ok("M: the insight reports' inventory (buy-box-loss/sales-movers) is NOT flagged (generic validator kept)", notFlagged.every(([r, k]) => contract(r, k) && contract(r, k).latestSnapshot !== true));
  ok("M: the insight inventory shares the source key but a DIFFERENT column set (=> different request_hash, separate job)",
    notFlagged.every(([r, k]) => contract(r, k).sourceKey === "fba-inventory-health"
      && JSON.stringify(contract(r, k).columns) !== JSON.stringify(contract("fba-plan", "fba-plan:inventory-health").columns)));
  // No OTHER contract anywhere in the registry carries the flag.
  const allFlagged = Object.entries(REPORT_SOURCE_CONTRACTS).flatMap(([r, cs]) => cs.filter((c) => c.latestSnapshot === true).map((c) => `${r}:${c.requestKey}`));
  ok("M: EXACTLY two contracts in the whole registry are latestSnapshot", allFlagged.length === 2 && allFlagged.includes("fba-plan:fba-plan:inventory-health") && allFlagged.includes("listing-health-v3:listing-health-v3:inventory"));
})();

writeSync(1, `\nfba-inventory-latest-snapshot: ${passed} assertions passed\n`);
