// WORK B prod-shape -- the REAL supabase.js durable Listings / Listings-Raw readers+writers over a stubbed HTTP layer.
// Proves: recordSourceListings[Raw]Snapshot REJECTS malformed evidence BEFORE any HTTP (a fetch tripwire); the RPC POST
// carries all 11 p_* args to the CORRECT rpc url; the scalar-ack ladder (replaced/unchanged/stale-save -> {write,ack};
// conflict -> typed CONFLICT; malformed -> typed ACK_INVALID); getSourceListings[Raw]Snapshot maps 200->snapshot,
// 404+PGRST205->schema-missing, non-schema->read-failed, and threads the AbortSignal; and the content-addressed payload
// round-trip (save -> get validates the sha; a mutated object -> MISMATCH). Offline; zero real network. 7-bit ASCII, LF.
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";

import assert from "node:assert/strict";
import { writeSync } from "node:fs";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
const rejects = async (n, fn, codeOrTest) => {
  let threw = null; try { await fn(); } catch (e) { threw = e; }
  const good = threw && (typeof codeOrTest === "function" ? codeOrTest(threw) : (codeOrTest ? threw.code === codeOrTest : true));
  ok(n, good);
};
writeSync(1, "listings-durable-prodshape\n");

// ---- Swappable HTTP layer. Each test sets `fetchImpl`; default is a TRIPWIRE that fails if reached. ----
let fetchImpl = () => { throw new Error("SPY_FETCH_CALLED: HTTP reached unexpectedly"); };
const calls = [];
globalThis.fetch = async (url, options = {}) => { calls.push({ url: String(url), options }); return fetchImpl(String(url), options); };
const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

const sb = await import("../lib/server/supabase.js");

const GOOD = {
  organizationFingerprint: "org-1", connectionId: "primary", accountId: "acct-00", marketplace: "US", asOf: "2026-09-02",
  objectPath: "source-snapshots/v2/org-1/primary/listings/acct-00/deadbeefdeadbeefdeadbeefdeadbeef.json",
  payloadSha: "deadbeefdeadbeefdeadbeefdeadbeef", rowCount: 3, payloadBytes: 100, sourceRequestHash: "rh-1", validatedAt: "2026-09-02T06:00:00.000Z",
};

// ---- (1) FETCH TRIPWIRE: malformed evidence REJECTS before any HTTP (fetch never called) ----
{
  fetchImpl = () => { throw new Error("SPY_FETCH_CALLED"); };
  const badCases = [
    ["marketplace 'USA' (not 2-letter)", { marketplace: "USA" }],
    ["marketplace 'us' (lowercase)", { marketplace: "us" }],
    ["marketplace '' (blank)", { marketplace: "" }],
    ["blank accountId", { accountId: "" }],
    ["accountId with ':'", { accountId: "dd-secondary:acct-00" }],
    ["asOf not YYYY-MM-DD", { asOf: "2026-9-2" }],
    ["asOf null", { asOf: null }],
    ["missing objectPath", { objectPath: "" }],
    ["missing payloadSha", { payloadSha: "" }],
    ["missing sourceRequestHash", { sourceRequestHash: "" }],
    ["missing validatedAt", { validatedAt: null }],
    ["negative rowCount", { rowCount: -1 }],
    ["non-integer rowCount", { rowCount: 2.5 }],
    ["negative payloadBytes", { payloadBytes: -5 }],
    ["connectionId outside {primary,dd-secondary}", { connectionId: "secondary" }],
    ["objectPath not ending /<sha>.json", { objectPath: "source-snapshots/v2/org-1/primary/listings/acct-00/other.json" }],
  ];
  let allRejectedNoFetch = true;
  for (const [, over] of badCases) {
    calls.length = 0;
    let threw = false; try { await sb.recordSourceListingsSnapshot({ ...GOOD, ...over }); } catch { threw = true; }
    if (!threw || calls.length !== 0) allRejectedNoFetch = false;
  }
  ok(`recordSourceListingsSnapshot REJECTS all ${badCases.length} malformed-evidence cases BEFORE any HTTP (zero fetch)`, allRejectedNoFetch);
  // The Raw twin enforces the same guard.
  calls.length = 0;
  let rawThrew = false; try { await sb.recordSourceListingsRawSnapshot({ ...GOOD, marketplace: "USA" }); } catch { rawThrew = true; }
  ok("recordSourceListingsRawSnapshot enforces the same pre-HTTP validation (marketplace) with zero fetch", rawThrew && calls.length === 0);
}

// ---- (2) RPC POST: 11 p_* args to the CORRECT url; ack ladder ----
{
  const seen = {};
  fetchImpl = (url, options) => {
    const body = JSON.parse(options.body || "{}");
    if (url.includes("/rest/v1/rpc/record_source_listings_snapshot")) { seen.listings = body; return jsonResponse(200, seen._ack); }
    if (url.includes("/rest/v1/rpc/record_source_listings_raw_snapshot")) { seen.raw = body; return jsonResponse(200, seen._ack); }
    throw new Error("unexpected url " + url);
  };
  seen._ack = "replaced";
  const r = await sb.recordSourceListingsSnapshot(GOOD);
  const b = seen.listings;
  const args11 = ["p_organization_fingerprint", "p_connection_id", "p_account_id", "p_marketplace", "p_as_of", "p_object_path", "p_payload_sha", "p_row_count", "p_payload_bytes", "p_source_request_hash", "p_validated_at"];
  ok("the RPC POST body carries EXACTLY the 11 p_* args in the migration signature", Object.keys(b).length === 11 && args11.every((k) => k in b) && b.p_marketplace === "US" && b.p_as_of === "2026-09-02" && b.p_row_count === 3);
  ok("'replaced' ack -> { write:'ok', ack:'replaced' }", r.write === "ok" && r.ack === "replaced");
  seen._ack = "unchanged"; ok("'unchanged' ack -> ack:'unchanged'", (await sb.recordSourceListingsSnapshot(GOOD)).ack === "unchanged");
  seen._ack = "stale-save"; ok("'stale-save' ack -> ack:'stale-save' (older evidence never overwrites)", (await sb.recordSourceListingsSnapshot(GOOD)).ack === "stale-save");
  seen._ack = "conflict"; await rejects("'conflict' ack -> typed SOURCE_LISTINGS_SNAPSHOT_CONFLICT (fail closed, no overwrite)", () => sb.recordSourceListingsSnapshot(GOOD), "SOURCE_LISTINGS_SNAPSHOT_CONFLICT");
  for (const bad of [null, [], ["a", "b"], {}, "nope", 42]) { seen._ack = bad; await rejects(`malformed ack ${JSON.stringify(bad)} -> typed ACK_INVALID`, () => sb.recordSourceListingsSnapshot(GOOD), "SOURCE_LISTINGS_SNAPSHOT_ACK_INVALID"); }
  // The Raw variant hits its OWN rpc url + its OWN typed codes.
  seen._ack = "replaced"; await sb.recordSourceListingsRawSnapshot(GOOD);
  ok("recordSourceListingsRawSnapshot posts to record_source_listings_raw_snapshot (distinct rpc)", !!seen.raw && Object.keys(seen.raw).length === 11);
  seen._ack = "conflict"; await rejects("raw 'conflict' -> SOURCE_LISTINGS_RAW_SNAPSHOT_CONFLICT", () => sb.recordSourceListingsRawSnapshot(GOOD), "SOURCE_LISTINGS_RAW_SNAPSHOT_CONFLICT");
}

// ---- (3) getSourceListingsSnapshot: 200->snapshot, 404+PGRST205->schema-missing, non-schema->read-failed, signal thread ----
{
  const row = { organization_fingerprint: "org-1", connection_id: "primary", account_id: "acct-00", marketplace: "US", source_key: "listings", as_of: "2026-09-02", object_path: GOOD.objectPath, payload_sha: GOOD.payloadSha, row_count: 3, payload_bytes: 100, source_request_hash: "rh-1", validated_at: GOOD.validatedAt };
  let sawSignal = false;
  fetchImpl = (url, options) => { if (options.signal) sawSignal = true; return jsonResponse(200, [row]); };
  const okRead = await sb.getSourceListingsSnapshot({ organizationFingerprint: "org-1", connectionId: "primary", accountId: "acct-00", signal: new AbortController().signal });
  ok("200 -> { read:'ok', snapshot:<row> } with the full pointer identity", okRead.read === "ok" && okRead.snapshot && okRead.snapshot.as_of === "2026-09-02" && okRead.snapshot.marketplace === "US");
  ok("the AbortSignal reaches the HTTP layer", sawSignal === true);
  fetchImpl = () => jsonResponse(404, { code: "PGRST205", message: "Could not find the table 'public.source_listings_snapshot' in the schema cache" });
  const missing = await sb.getSourceListingsSnapshot({ organizationFingerprint: "org-1", accountId: "acct-00" });
  ok("404 PGRST205 -> read:'schema-missing' (migration UNAPPLIED is fail-soft, not a crash)", missing.read === "schema-missing" && missing.snapshot === null && missing.error === "SOURCE_LISTINGS_SNAPSHOT_SCHEMA_MISSING");
  fetchImpl = () => jsonResponse(403, { code: "42501", message: "permission denied" }); // non-retry, non-schema
  const failed = await sb.getSourceListingsSnapshot({ organizationFingerprint: "org-1", accountId: "acct-00" });
  ok("non-schema error -> read:'read-failed' (typed, honest)", failed.read === "read-failed" && failed.snapshot === null);
  const rawMissing = await sb.getSourceListingsRawSnapshot({ organizationFingerprint: "org-1", accountId: "acct-00" }).catch(() => null);
  ok("getSourceListingsRawSnapshot exists + returns a typed read", rawMissing && typeof rawMissing.read === "string");
}

// ---- (4) content-addressed payload round-trip (REUSED save/get): save -> get validates the sha; mutation -> MISMATCH ----
{
  const store = new Map(); // objectUrl -> body string
  fetchImpl = (url, options) => {
    if (String(options.method) === "POST" && url.includes("/storage/v1/object/")) { store.set(url, String(options.body)); return jsonResponse(200, { Key: url }); }
    if ((options.method === undefined || options.method === "GET") && url.includes("/storage/v1/object/")) {
      const b = store.get(url); if (b === undefined) return jsonResponse(404, { message: "not found" });
      return { ok: true, status: 200, json: async () => JSON.parse(b), text: async () => b };
    }
    throw new Error("unexpected url " + url);
  };
  const rows = [{ sku: "K1", child_asin: "ASIN-K1" }, { sku: "K2", child_asin: "ASIN-K2" }];
  const saved = await sb.saveSourceSnapshotPayload({ organizationFingerprint: "org-1", connectionId: "primary", sourceKey: "listings", scopeKey: "acct-00", rows });
  ok("saveSourceSnapshotPayload writes a content-addressed object under the listings sourceKey namespace", saved.objectPath.includes("/listings/acct-00/") && saved.objectPath.endsWith(`/${saved.payloadSha}.json`));
  const hydrated = await sb.getSourceSnapshotPayload(saved.objectPath);
  ok("getSourceSnapshotPayload hydrates + content-address-validates the round-tripped rows", Array.isArray(hydrated.rows) && hydrated.rows.length === 2);
  // MUTATE the stored object -> its content no longer matches the sha embedded in the path -> MISMATCH.
  const urlKey = [...store.keys()][0];
  store.set(urlKey, JSON.stringify({ rows: [{ sku: "TAMPERED" }] }));
  await rejects("a MUTATED object -> SOURCE_SNAPSHOT_PAYLOAD_MISMATCH (truncated/foreign/mutated can never masquerade)", () => sb.getSourceSnapshotPayload(saved.objectPath), (e) => e.code === "SOURCE_SNAPSHOT_PAYLOAD_MISMATCH");
}

writeSync(1, `\nlistings-durable-prodshape: ${passed} assertions passed\n`);
