// Brand View freshness / serve-mode decision -- deterministic OFFLINE proof.
//
//   - a Brand View assembly is STALE the moment a contributing brand-sales snapshot is newer (source advanced
//     21 -> 25 Aug): serve the LKG NOW + updating:true (a zero-export rebuild is due) -- never a blank;
//   - a fresh assembly (no contributing snapshot newer) serves updating:false;
//   - no snapshot at all -> "updating-missing" (a typed updating state, NEVER a blank fatal error);
//   - the across-day LKG fallback (different params hash) is also updating + staleScope;
//   - a bounded rebuild that ran out of route budget without publishing keeps updating:true (poll again).
//
// 7-bit ASCII, LF, no top-level await.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { decideBrandViewServe, contributingProvenanceAt } from "../lib/server/reports/brand-view-freshness.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const snap = (t, extra = {}) => ({ source_refreshed_at: t, payload: { ok: true }, ...extra });

test("contributingProvenanceAt returns the NEWEST source_refreshed_at (or updated_at) across accounts", () => {
  assert.equal(contributingProvenanceAt([{ source_refreshed_at: "2026-08-24T06:00:00Z" }, { source_refreshed_at: "2026-08-26T06:01:00Z" }, { updated_at: "2026-08-25T00:00:00Z" }]), "2026-08-26T06:01:00Z");
  assert.equal(contributingProvenanceAt([]), "");
  assert.equal(contributingProvenanceAt(null), "");
});

test("SOURCE ADVANCED 21->25 Aug: the cached assembly is stale -> serve LKG NOW + updating (rebuild due)", () => {
  const exact = snap("2026-08-21T10:00:00Z"); // assembled when brand-sales was at 21 Aug
  const d = decideBrandViewServe({ exact, lkg: exact, contributingAt: "2026-08-26T06:01:00Z" });
  assert.equal(d.mode, "serve-stale");
  assert.equal(d.snapshot, exact, "the LKG is served immediately (never blank)");
  assert.equal(d.updating, true, "a zero-export rebuild is due");
  assert.equal(d.reason, "source-advanced");
});

test("FRESH: no contributing snapshot newer than the assembly -> serve it, updating:false", () => {
  const exact = snap("2026-08-26T06:05:00Z");
  const d = decideBrandViewServe({ exact, lkg: exact, contributingAt: "2026-08-26T06:01:00Z" });
  assert.equal(d.mode, "serve-fresh");
  assert.equal(d.updating, false);
  assert.equal(d.staleScope, false);
  assert.equal(d.reason, "fresh");
});

test("equal provenance is FRESH (not stale): assembly built exactly at the contributing time", () => {
  const exact = snap("2026-08-26T06:01:00Z");
  const d = decideBrandViewServe({ exact, lkg: exact, contributingAt: "2026-08-26T06:01:00Z" });
  assert.equal(d.updating, false, "servedAt == provAt is fresh (only strictly-older is stale)");
});

test("NO SNAPSHOT at all -> updating-missing (a typed updating state, never a blank fatal error)", () => {
  const d = decideBrandViewServe({ exact: null, lkg: null, contributingAt: "2026-08-26T06:01:00Z" });
  assert.equal(d.mode, "updating-missing");
  assert.equal(d.snapshot, null);
  assert.equal(d.updating, true);
});

test("ACROSS-DAY fallback: only the LKG for a different params hash exists -> serve it + staleScope + updating", () => {
  const lkg = snap("2026-08-26T06:05:00Z"); // fresh by provenance, but it is not the EXACT requested hash
  const d = decideBrandViewServe({ exact: null, lkg, contributingAt: "2026-08-26T06:01:00Z" });
  assert.equal(d.mode, "serve-stale");
  assert.equal(d.snapshot, lkg);
  assert.equal(d.staleScope, true, "served the LKG for a different scope/day");
  assert.equal(d.updating, true);
  assert.equal(d.reason, "scope-fallback");
});

test("REBUILD DEADLINE with an LKG present -> keep serving LKG + updating (frontend polls again)", () => {
  const exact = snap("2026-08-26T06:05:00Z");
  const d = decideBrandViewServe({ exact, lkg: exact, contributingAt: "2026-08-26T06:01:00Z", deadlineExceeded: true });
  assert.equal(d.mode, "serve-stale");
  assert.equal(d.snapshot, exact);
  assert.equal(d.updating, true, "the rebuild did not finish this pass -> stay in updating");
});

test("no contributing provenance readable (empty) -> never falsely flags stale; serves what exists", () => {
  const exact = snap("2026-08-21T10:00:00Z");
  const d = decideBrandViewServe({ exact, lkg: exact, contributingAt: "" });
  assert.equal(d.updating, false, "unknown provenance must not fabricate staleness");
  assert.equal(d.mode, "serve-fresh");
});

let failures = 0;
for (const t of tests) {
  try { t.fn(); passed += 1; out("  ok  " + t.name); }
  catch (e) { failures += 1; out("FAIL  " + t.name); out(String((e && e.stack) || e)); }
}
out("\n" + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : ""));
if (failures) process.exitCode = 1;
