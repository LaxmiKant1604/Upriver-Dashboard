// Trusted ZERO-EXPORT Daily v2 backfill operator: publishes daily-reporting-shared-v2 for a set of primary
// accounts from durable evidence ONLY. Proves: each account ends at its OWN latest proven OLI date (never padded
// to a ceiling, never a fabricated zero); the derivation is the REAL contract (v2, never a v1 copy); it is
// structurally incapable of a DataDoe export (no adapter); a replay performs ZERO writes (idempotent); a single
// account's failure is isolated and never overwrites its last-known-good snapshot; params_hash provenance is
// enforced (a wrong hash is refused); each identity is serialized through the refresh lock.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { REPORT_DERIVATIONS } from "../lib/server/sync/report-derivation.js";
import { paramsHashFor } from "../lib/server/report-store.js";
import { backfillDailyV2, makeProvenanceGuardedSave, DAILY_V2_REPORT_KEY } from "../lib/server/reports/daily-v2-backfill.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const testAsync = async (name, fn) => { try { await fn(); passed += 1; out("  ok  " + name); } catch (e) { out("FAIL  " + name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; } };

const V2 = "daily-reporting-shared-v2";
const FROM = "2026-03-01", CEIL = "2026-08-24";
const CATALOG = [
  { child_asin: "B0A", sku: "SKU-A", parent_asin: "P", product_name: "A", product_brand: "Acme" },
  { child_asin: "B0B", sku: "SKU-B", parent_asin: "P", product_name: "B", product_brand: "Bolt" },
];
const CATALOG_SNAP = { validated_at: "2026-08-25T01:00:00.000Z", object_path: "cat/obj", row_count: 2 };
const salesOf = (p) => (p.rows || []).reduce((a, r) => a + (Number(r.total_sales) || 0), 0);

// A durable-reader factory. Per-account OLI history + coverage windows are injected so we can vary each
// account's latest proven date. NO create/adapter is ever present -> a DataDoe export is impossible.
function makeReaders({ historyByAcct, windowsByAcct, adsFail = false, calls }) {
  return {
    readOliHistory: async ({ accountIds }) => { calls.oliHistory += 1; return historyByAcct[accountIds[0]] || []; },
    readOliCoverage: async ({ accountId }) => { calls.oliCov += 1; return { windows: windowsByAcct[accountId] || [], read: "ok", status: "succeeded" }; },
    readAsinAds: async () => { calls.ads += 1; if (adsFail) { const e = new Error("ads unreadable"); e.code = "ADS_READ"; throw e; } return []; },
    readAdsCoverage: async () => ({ windows: [], read: adsFail ? "read-failed" : "ok", status: "missing", latestMetricDate: null }),
    readCatalogSnapshot: async () => ({ snapshot: CATALOG_SNAP, read: "ok", error: null }), // production {snapshot,read,error} shape
    loadCatalogPayload: async () => ({ rows: CATALOG }),
  };
}

// A fake durable store: real paramsHashFor (provenance), an in-memory snapshot map, a lock set, and a
// provenance-guarded save. `saveCalls` records every write so a replay can be asserted to perform ZERO.
function makeStore({ saveCalls, lockLog, seed = new Map() }) {
  const snaps = seed; const locks = new Set();
  const guardedSave = makeProvenanceGuardedSave({
    paramsHashFor,
    saveSnapshot: async ({ accountId, paramsHash, params, payload }) => {
      saveCalls.push({ accountId, paramsHash, params });
      const row = { id: "s-" + accountId, updated_at: "u", source_refreshed_at: "r", payload, params, payload_bytes: 42 };
      snaps.set([DAILY_V2_REPORT_KEY, accountId, paramsHash].join("|"), row);
      return row;
    },
  });
  return {
    snaps,
    paramsHashFor,
    claimLock: async ({ accountId, paramsHash }) => { const k = accountId + "|" + paramsHash; if (locks.has(k)) return false; locks.add(k); lockLog.push("claim:" + accountId); return true; },
    releaseLock: async ({ accountId }) => { for (const k of [...locks]) if (k.startsWith(accountId + "|")) locks.delete(k); lockLog.push("release:" + accountId); },
    getExisting: async ({ accountId, paramsHash }) => snaps.get([DAILY_V2_REPORT_KEY, accountId, paramsHash].join("|")) || null,
    save: guardedSave,
    validatePayload: (p) => REPORT_DERIVATIONS["daily-reporting"].validatePayload(p),
  };
}

const histRow = (id, date, amt) => ({ account_id: id, sale_date: date, sku: "SKU-A", child_asin: "B0A", currency: "USD", sales_amount: amt, units: 2 });

async function main() {
await testAsync("publishes each account ENDING at its OWN latest proven date (13-behind vs full), ZERO exports", async () => {
  // acctFull proves through the ceiling; acctBehind only through 2026-08-22 (like the 17 real accounts).
  const historyByAcct = {
    acctFull: [histRow("acctFull", "2026-03-05", 100), histRow("acctFull", "2026-08-24", 24)],
    acctBehind: [histRow("acctBehind", "2026-03-05", 50), histRow("acctBehind", "2026-08-22", 22)],
  };
  const windowsByAcct = { acctFull: [{ from: "2025-01-01", to: "2026-08-24" }], acctBehind: [{ from: "2025-01-01", to: "2026-08-22" }] };
  const calls = { oliHistory: 0, oliCov: 0, ads: 0 };
  const saveCalls = []; const lockLog = [];
  const readers = makeReaders({ historyByAcct, windowsByAcct, calls });
  const store = makeStore({ saveCalls, lockLog });
  const { results, summary } = await backfillDailyV2({
    accounts: [{ accountId: "acctFull", currency: "USD" }, { accountId: "acctBehind", currency: "USD" }],
    from: FROM, asOfCeiling: CEIL, organizationFingerprint: "org", readers, store,
  });
  assert.equal(summary.attempted, 2);
  assert.equal(summary.published, 2);
  assert.equal(summary.failed, 0);
  assert.equal(summary.creates, 0); assert.equal(summary.tokens, 0);
  const full = results.find((r) => r.accountId === "acctFull");
  const behind = results.find((r) => r.accountId === "acctBehind");
  assert.equal(full.to, "2026-08-24", "full account published through the ceiling");
  assert.equal(behind.to, "2026-08-22", "behind account published through its OWN latest proven date, NOT padded to the ceiling");
  // Provenance: each row's params_hash equals paramsHashFor(V2, effective window).
  assert.equal(saveCalls.find((s) => s.accountId === "acctBehind").paramsHash, paramsHashFor(V2, { from: FROM, to: "2026-08-22", brand: "ALL" }));
  // No adapter anywhere -> structurally zero exports.
  assert.equal("create" in readers, false);
});

await testAsync("idempotent replay performs ZERO writes (existing valid v2 snapshots are skipped)", async () => {
  const historyByAcct = { a1: [histRow("a1", "2026-03-05", 100)] };
  const windowsByAcct = { a1: [{ from: "2025-01-01", to: "2026-08-24" }] };
  const calls = { oliHistory: 0, oliCov: 0, ads: 0 };
  const saveCalls = []; const lockLog = [];
  const readers = makeReaders({ historyByAcct, windowsByAcct, calls });
  const store = makeStore({ saveCalls, lockLog });
  const args = { accounts: [{ accountId: "a1", currency: "USD" }], from: FROM, asOfCeiling: CEIL, organizationFingerprint: "org", readers, store };
  const first = await backfillDailyV2(args);
  assert.equal(first.summary.published, 1);
  assert.equal(saveCalls.length, 1, "first run writes once");
  const second = await backfillDailyV2(args); // replay against the SAME store
  assert.equal(second.summary.published, 0);
  assert.equal(second.summary.existing, 1, "replay recognises the existing valid v2 snapshot");
  assert.equal(saveCalls.length, 1, "replay performs ZERO additional writes (idempotent)");
});

await testAsync("a single account's failure is isolated + never overwrites its last-known-good snapshot", async () => {
  // a1 has a gap at the window start (from in a gap) -> fails; a2 is healthy -> publishes. a1 has a pre-seeded LKG.
  const seed = new Map();
  const lkgKey = [DAILY_V2_REPORT_KEY, "a1", paramsHashFor(V2, { from: FROM, to: "2026-07-01", brand: "ALL" })].join("|");
  seed.set(lkgKey, { payload: { rows: [{ date: "2026-07-01", total_sales: 999 }], brandFiltered: false }, params: { reportVersion: V2, from: FROM, to: "2026-07-01", brand: "ALL" } });
  const historyByAcct = { a1: [histRow("a1", "2026-05-05", 10)], a2: [histRow("a2", "2026-03-05", 20)] };
  const windowsByAcct = { a1: [{ from: "2026-04-01", to: "2026-08-24" }], a2: [{ from: "2025-01-01", to: "2026-08-24" }] }; // a1: gap before 2026-03-01
  const calls = { oliHistory: 0, oliCov: 0, ads: 0 };
  const saveCalls = []; const lockLog = [];
  const readers = makeReaders({ historyByAcct, windowsByAcct, calls });
  const store = makeStore({ saveCalls, lockLog, seed });
  const { results, summary } = await backfillDailyV2({ accounts: [{ accountId: "a1", currency: "USD" }, { accountId: "a2", currency: "USD" }], from: FROM, asOfCeiling: CEIL, organizationFingerprint: "org", readers, store });
  assert.equal(summary.failed, 1); assert.equal(summary.published, 1);
  const a1 = results.find((r) => r.accountId === "a1");
  assert.equal(a1.status, "failed"); assert.equal(a1.reason, "oli-coverage-incomplete");
  assert.equal(store.snaps.get(lkgKey).payload.rows[0].total_sales, 999, "a1's last-known-good snapshot is UNTOUCHED");
  assert.equal(saveCalls.some((s) => s.accountId === "a1"), false, "no write for the failed account");
});

await testAsync("OLI sales are published even when ASIN Ads are unavailable, and Ads is typed unavailable (never zero)", async () => {
  const historyByAcct = { a1: [histRow("a1", "2026-03-05", 100), histRow("a1", "2026-03-06", 60)] };
  const windowsByAcct = { a1: [{ from: "2025-01-01", to: "2026-08-24" }] };
  const calls = { oliHistory: 0, oliCov: 0, ads: 0 };
  const saveCalls = []; const lockLog = [];
  const readers = makeReaders({ historyByAcct, windowsByAcct, adsFail: true, calls });
  const store = makeStore({ saveCalls, lockLog });
  const { results } = await backfillDailyV2({ accounts: [{ accountId: "a1", currency: "USD" }], from: FROM, asOfCeiling: CEIL, organizationFingerprint: "org", readers, store });
  const r = results[0];
  assert.equal(r.status, "published");
  const saved = store.snaps.get([DAILY_V2_REPORT_KEY, "a1", r.paramsHash].join("|"));
  assert.equal(salesOf(saved.payload), 160, "OLI sales survive a failed Ads read");
  assert.notEqual(saved.payload.adsAvailability.status, "validated", "Ads not validated when unreadable");
  const anyAd = saved.payload.rows.some((row) => "ad_sales" in row || "ad_spend" in row);
  assert.equal(anyAd, false, "no fabricated zero ad_* fields");
});

await testAsync("each identity is serialized through the refresh lock (claim before save, release after)", async () => {
  const historyByAcct = { a1: [histRow("a1", "2026-03-05", 100)] };
  const windowsByAcct = { a1: [{ from: "2025-01-01", to: "2026-08-24" }] };
  const calls = { oliHistory: 0, oliCov: 0, ads: 0 };
  const saveCalls = []; const lockLog = [];
  const readers = makeReaders({ historyByAcct, windowsByAcct, calls });
  const store = makeStore({ saveCalls, lockLog });
  await backfillDailyV2({ accounts: [{ accountId: "a1", currency: "USD" }], from: FROM, asOfCeiling: CEIL, organizationFingerprint: "org", readers, store });
  assert.deepEqual(lockLog, ["claim:a1", "release:a1"], "lock claimed then released around the account");
});

await testAsync("the provenance guard REFUSES a save under a mismatched params_hash (wrong-hash refused)", async () => {
  const guarded = makeProvenanceGuardedSave({ paramsHashFor, saveSnapshot: async () => ({ id: "should-not-happen" }) });
  await assert.rejects(
    () => guarded({ reportKey: DAILY_V2_REPORT_KEY, reportVersion: V2, accountId: "a1", paramsHash: "deadbeef", params: { reportVersion: V2, from: FROM, to: "2026-08-24", brand: "ALL" }, payload: {} }),
    /wrong-hash refused/,
    "a forged/stale params_hash is refused",
  );
  // The correct hash is accepted.
  let wrote = false;
  const ok = makeProvenanceGuardedSave({ paramsHashFor, saveSnapshot: async () => { wrote = true; return { id: "ok" }; } });
  await ok({ reportKey: DAILY_V2_REPORT_KEY, reportVersion: V2, accountId: "a1", paramsHash: paramsHashFor(V2, { from: FROM, to: "2026-08-24", brand: "ALL" }), params: { reportVersion: V2, from: FROM, to: "2026-08-24", brand: "ALL" }, payload: {} });
  assert.equal(wrote, true, "the provenance-correct hash is accepted");
});

await testAsync("THIRTY accounts publish distinct v2 payloads (per-account isolation), ZERO creates/tokens", async () => {
  const ids = Array.from({ length: 30 }, (_, i) => "acc" + String(i + 1).padStart(2, "0"));
  const historyByAcct = {}; const windowsByAcct = {};
  for (let i = 0; i < ids.length; i += 1) {
    historyByAcct[ids[i]] = [histRow(ids[i], "2026-03-05", 100 + i)];
    // Half the accounts are a couple days behind, like production.
    windowsByAcct[ids[i]] = [{ from: "2025-01-01", to: i % 2 ? "2026-08-22" : "2026-08-24" }];
  }
  const calls = { oliHistory: 0, oliCov: 0, ads: 0 };
  const saveCalls = []; const lockLog = [];
  const readers = makeReaders({ historyByAcct, windowsByAcct, calls });
  const store = makeStore({ saveCalls, lockLog });
  const { results, summary } = await backfillDailyV2({ accounts: ids.map((id) => ({ accountId: id, currency: "USD" })), from: FROM, asOfCeiling: CEIL, organizationFingerprint: "org", readers, store });
  assert.equal(summary.attempted, 30); assert.equal(summary.published, 30); assert.equal(summary.failed, 0);
  assert.equal(summary.creates, 0); assert.equal(summary.tokens, 0);
  assert.equal(new Set(results.map((r) => r.accountId)).size, 30, "30 distinct identities");
  const behindCount = results.filter((r) => r.to === "2026-08-22").length;
  assert.equal(behindCount, 15, "the behind accounts are published at 2026-08-22, the full ones at 2026-08-24");
  const s1 = salesOf(store.snaps.get([DAILY_V2_REPORT_KEY, "acc01", results.find((r) => r.accountId === "acc01").paramsHash].join("|")).payload);
  const s2 = salesOf(store.snaps.get([DAILY_V2_REPORT_KEY, "acc02", results.find((r) => r.accountId === "acc02").paramsHash].join("|")).payload);
  assert.notEqual(s1, s2, "distinct durable evidence -> distinct totals (no cross-account bleed)");
});
}

await main();
out("\n" + passed + " assertions passed");
