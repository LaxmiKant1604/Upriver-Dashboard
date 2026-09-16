// WORK B unit -- durable Listings / Listings-Raw persistence wired into the LHv3 per-account materialization.
// Drives the REAL materializeListingHealthV3PerAccount with an in-memory durable harness (a faithful record RPC ladder
// over a Map keyed (org,connection,account), and a content-addressed payload store) to prove the ZERO-EXPORT persistence
// hook: one durable pointer per account per NEW-export source, exact identity/isolation, the as_of-dominant CAS ladder
// (replaced / stale-save / unchanged / conflict / cross-marketplace), independent Listings-vs-Raw failure, valid-empty,
// :inventory never persisted, and migration-unapplied fail-soft (alias survives). Offline; zero network. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { planListingHealthV3BucketBatched } from "../lib/server/sync/report-planner.js";
import { materializeListingHealthV3PerAccount } from "../lib/server/sync/listing-health-v3-materialize.js";
import { LISTINGS_SOURCE_KEY, LISTINGS_RAW_SOURCE_KEY } from "../lib/server/sync/source-durable-model.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "listings-durable-model\n");

const API_KEY = "fixture-key";
const connections = [{ id: "primary", apiKey: API_KEY, accountPrefix: "" }];
const asOf = "2026-09-02";
const inv = "2026-09-04";
const SELLERS = ["acct-00", "acct-01"];
const usAccounts = SELLERS.map((id, i) => ({ accountId: id, country: "US", currency: "USD", name: `A${i}` }));
const listingRow = (seller, sku) => ({ seller_or_vendor_id: seller, marketplace_country_code: "US", sku, child_asin: `ASIN-${sku}`, listing_name: `L ${sku}`, listing_status: "Active", listing_price_value: 9, listing_price_currency: "USD", listing_current_quantity: 0, fba_quantity_available: 0, listing_fulfillment_channel: "AMAZON_NA", listing_open_date: "2024-01-01" });
const rawRow = (seller, sku) => ({ seller_or_vendor_id: seller, marketplace_country_code: "US", sku, child_asin: `ASIN-${sku}`, summaries: JSON.stringify({ status: ["BUYABLE"] }), issues: JSON.stringify([]), offers: JSON.stringify([{ price: { amount: 9 } }]) });
const invRow = (seller, sku) => ({ date: inv, seller_or_vendor_id: seller, marketplace_country_code: "US", child_asin: `ASIN-${sku}`, sku, available: 3 });

// EXACT replicas of supabase.js sourceSnapshotPayloadSha / sourceSnapshotObjectPath (content-addressing is source-key-
// agnostic; the prod-shape test exercises the REAL functions). Kept inline so this unit test needs no env / no network.
const payloadSha = (rows) => createHash("sha256").update(JSON.stringify({ rows })).digest("hex").slice(0, 32);
const objectPath = ({ organizationFingerprint, connectionId, sourceKey, scopeKey, payloadSha: sha }) => {
  const clean = (v) => String(v || "").trim().replaceAll("/", "_");
  return `source-snapshots/v2/${clean(organizationFingerprint)}/${connectionId}/${clean(sourceKey)}/${clean(scopeKey)}/${clean(sha)}.json`;
};

function makeCache() {
  const map = new Map();
  return {
    map,
    readSourceCache: async (h) => (map.has(h) ? { ...map.get(h) } : null),
    writeSourceCache: async ({ requestHash, rows, expiresAt, sourceId, organizationFingerprint: org, accountScopeHash: scope, requestMeta }) => { map.set(requestHash, { rows: [...rows], expires_at: expiresAt, source_id: sourceId, organization_fingerprint: org, account_scope_hash: scope, request_meta: requestMeta }); },
  };
}
const plans = () => planListingHealthV3BucketBatched({ accounts: usAccounts, connections, asOfFor: () => asOf, inventoryAsOf: inv });
function seedBatch(cache, plan, { listings, raw, inventory }) {
  const rowsByKey = { "listing-health-v3:listings": listings, "listing-health-v3:listings-raw": raw, "listing-health-v3:inventory": inventory };
  const seen = new Set();
  for (const src of plan[0].sources) {
    if (seen.has(src.requestHash)) continue; seen.add(src.requestHash);
    if (rowsByKey[src.requestKey] === undefined) continue;
    cache.map.set(src.requestHash, { rows: [...rowsByKey[src.requestKey]], fetched_at: "2026-09-02T06:00:00.000Z", expires_at: "2999-01-01T00:00:00.000Z", source_id: src.sourceId, organization_fingerprint: src.organizationFingerprint, account_scope_hash: src.accountScopeHash });
  }
}

// A faithful in-memory durable family: content-addressed object store + the record RPC ladder from the migration
// (record_source_listings_snapshot :103-161). One instance shared across listings + listings-raw (separate source keys
// -> disjoint pointer namespaces). `injectFail` / `injectSchemaMissing` model per-source-key failures.
function makeDurable() {
  const objects = new Map();     // objectPath -> { rows }
  const pointers = new Map();    // sourceKey|org|conn|account -> row
  const opts = { fail: new Set(), schemaMissing: new Set() };
  const key = (sk, o, c, a) => [sk, o, c, a].join("|");
  // Store the SNAKE-CASE row the real source_listings_snapshot table (+ getSourceListingsSnapshot) returns.
  const toRow = (a, sourceKey) => ({ organization_fingerprint: a.organizationFingerprint, connection_id: a.connectionId, account_id: a.accountId, marketplace: a.marketplace, source_key: sourceKey, as_of: a.asOf, object_path: a.objectPath, payload_sha: a.payloadSha, row_count: a.rowCount, payload_bytes: a.payloadBytes, source_request_hash: a.sourceRequestHash, validated_at: a.validatedAt });
  const saveDurablePayload = async ({ organizationFingerprint, connectionId, sourceKey, scopeKey, rows }) => {
    const sha = payloadSha(rows); const path = objectPath({ organizationFingerprint, connectionId, sourceKey, scopeKey, payloadSha: sha });
    objects.set(path, { rows: [...rows] });
    return { objectPath: path, payloadSha: sha, payloadBytes: Buffer.byteLength(JSON.stringify({ rows })) };
  };
  const recordFor = (sourceKey) => async (a) => {
    if (opts.schemaMissing.has(sourceKey)) { const e = new Error("schema missing"); e.code = "PGRST205"; throw e; }
    if (opts.fail.has(sourceKey)) { const e = new Error("write failed"); e.code = "PGRST500"; throw e; }
    // Guards the RPC applies before HTTP (mirror recordSourceListingsSnapshot).
    if (!/^[A-Z]{2}$/.test(a.marketplace) || !/^\d{4}-\d{2}-\d{2}$/.test(a.asOf) || !a.objectPath.endsWith(`/${a.payloadSha}.json`) || (a.connectionId !== "primary" && a.connectionId !== "dd-secondary")) throw new Error("bad evidence");
    const k = key(sourceKey, a.organizationFingerprint, a.connectionId, a.accountId);
    const cur = pointers.get(k);
    if (!cur) { pointers.set(k, toRow(a, sourceKey)); return { write: "ok", ack: "replaced" }; }
    if (a.marketplace !== cur.marketplace) return { write: "ok", ack: "conflict" };          // immutable marketplace
    if (a.asOf < cur.as_of) return { write: "ok", ack: "stale-save" };                        // as_of dominates
    if (a.asOf === cur.as_of) {
      if (a.validatedAt < cur.validated_at) return { write: "ok", ack: "stale-save" };
      if (a.validatedAt === cur.validated_at) {
        const same = cur.object_path === a.objectPath && cur.payload_sha === a.payloadSha && cur.row_count === a.rowCount && cur.payload_bytes === a.payloadBytes && cur.source_request_hash === a.sourceRequestHash;
        return { write: "ok", ack: same ? "unchanged" : "conflict" };
      }
    }
    pointers.set(k, toRow(a, sourceKey)); return { write: "ok", ack: "replaced" };
  };
  return {
    objects, pointers, opts, saveDurablePayload,
    recordDurableByKey: { "listing-health-v3:listings": recordFor(LISTINGS_SOURCE_KEY), "listing-health-v3:listings-raw": recordFor(LISTINGS_RAW_SOURCE_KEY) },
    isSchemaMissingError: (e) => e && e.code === "PGRST205",
    isFunctionSignatureMissingError: (e) => e && e.code === "PGRST202",
    ptr: (sk, a) => pointers.get(key(sk, usAccounts[0].name ? undefined : undefined, "primary", a)),
    ptrOf: (sk, org, a) => pointers.get(key(sk, org, "primary", a)),
    count: (sk) => [...pointers.keys()].filter((k) => k.startsWith(sk + "|")).length,
  };
}
const run = (cache, d, over = {}) => materializeListingHealthV3PerAccount({ plans: plans(), connections, readSourceCache: cache.readSourceCache, writeSourceCache: cache.writeSourceCache, saveDurablePayload: d.saveDurablePayload, recordDurableByKey: d.recordDurableByKey, isSchemaMissingError: d.isSchemaMissingError, isFunctionSignatureMissingError: d.isFunctionSignatureMissingError, ...over });

// ---- (0) source-key constants ----
ok("LISTINGS_SOURCE_KEY / LISTINGS_RAW_SOURCE_KEY match the migration table source_key literals", LISTINGS_SOURCE_KEY === "listings" && LISTINGS_RAW_SOURCE_KEY === "listings-raw");

// ---- (1) natural validated persistence: ONE pointer per account per NEW-export source; exact identity; zero export ----
{
  const cache = makeCache(); const d = makeDurable(); const p = plans();
  seedBatch(cache, p, { listings: SELLERS.flatMap((s) => [listingRow(s, "K1"), listingRow(s, "K2")]), raw: SELLERS.map((s) => rawRow(s, "K1")), inventory: SELLERS.map((s) => invRow(s, "K1")) });
  const sum = await run(cache, d);
  ok("one durable listings pointer + one listings-raw pointer PER account (2 sellers -> 2 each); NONE for :inventory", d.count(LISTINGS_SOURCE_KEY) === 2 && d.count(LISTINGS_RAW_SOURCE_KEY) === 2 && sum.durableWritten === 4);
  const anyPtr = [...d.pointers.values()].find((r) => r.source_key === LISTINGS_SOURCE_KEY);
  ok("pointer records exact evidence: as_of == plan.context.to, marketplace UPPERCASE, connection_id 'primary', rowCount>=0, real request hash, validated_at == batch fetched_at", anyPtr.as_of === asOf && anyPtr.marketplace === "US" && anyPtr.connection_id === "primary" && Number.isInteger(anyPtr.row_count) && !!anyPtr.source_request_hash && anyPtr.validated_at === "2026-09-02T06:00:00.000Z");
  ok("the durable payload object is content-addressed under the listings sourceKey namespace", [...d.objects.keys()].some((k) => k.includes("/listings/")) && [...d.objects.keys()].some((k) => k.includes("/listings-raw/")));
}

// ---- (2) idempotent replay -> 'unchanged', no duplicate pointer ----
{
  const cache = makeCache(); const d = makeDurable(); const p = plans();
  seedBatch(cache, p, { listings: SELLERS.map((s) => listingRow(s, "K1")), raw: SELLERS.map((s) => rawRow(s, "K1")), inventory: [] });
  await run(cache, d);
  const before = d.count(LISTINGS_SOURCE_KEY);
  const sum2 = await run(cache, d); // identical replay
  ok("replay: 'unchanged' acks, no duplicate pointers (idempotent)", sum2.durableUnchanged === 4 && sum2.durableWritten === 0 && d.count(LISTINGS_SOURCE_KEY) === before);
}

// ---- (3) empty validated fragment -> a valid-empty row_count=0 pointer (distinct from missing) ----
{
  const cache = makeCache(); const d = makeDurable(); const p = plans();
  seedBatch(cache, p, { listings: [], raw: [], inventory: [] }); // batch present but empty -> valid-empty per account
  const sum = await run(cache, d);
  const empties = [...d.pointers.values()].filter((r) => r.row_count === 0);
  ok("validated-empty batch persists row_count=0 pointers (valid-empty, not missing)", empties.length === 4 && sum.durableWritten === 4);
}

// ---- (4) :inventory is NEVER persisted to a listings table (reuse-only fba-inventory-health) ----
{
  const cache = makeCache(); const d = makeDurable(); const p = plans();
  seedBatch(cache, p, { listings: SELLERS.map((s) => listingRow(s, "K1")), raw: SELLERS.map((s) => rawRow(s, "K1")), inventory: SELLERS.map((s) => invRow(s, "K1")) });
  await run(cache, d);
  ok("no durable pointer is ever keyed by an inventory/fba source", ![...d.pointers.values()].some((r) => /inventory|fba/.test(String(r.source_key))));
}

// ---- (5) older as_of -> 'stale-save' (LKG survives); same-date correction -> 'replaced' ----
{
  const cache = makeCache(); const d = makeDurable();
  // First persist at asOf 2026-09-02.
  const p1 = planListingHealthV3BucketBatched({ accounts: usAccounts, connections, asOfFor: () => "2026-09-02", inventoryAsOf: inv });
  const c1 = makeCache();
  const rowsByKey = { "listing-health-v3:listings": SELLERS.map((s) => listingRow(s, "K1")), "listing-health-v3:listings-raw": SELLERS.map((s) => rawRow(s, "K1")) };
  for (const src of p1[0].sources) { if (rowsByKey[src.requestKey]) c1.map.set(src.requestHash, { rows: [...rowsByKey[src.requestKey]], fetched_at: "2026-09-02T06:00:00.000Z", expires_at: "2999-01-01T00:00:00.000Z", source_id: src.sourceId, organization_fingerprint: src.organizationFingerprint, account_scope_hash: src.accountScopeHash }); }
  await materializeListingHealthV3PerAccount({ plans: p1, connections, readSourceCache: c1.readSourceCache, writeSourceCache: c1.writeSourceCache, saveDurablePayload: d.saveDurablePayload, recordDurableByKey: d.recordDurableByKey });
  // An OLDER as_of (2026-09-01) -> stale-save (never overwrites the newer D-1).
  const pOld = planListingHealthV3BucketBatched({ accounts: usAccounts, connections, asOfFor: () => "2026-09-01", inventoryAsOf: inv });
  const cOld = makeCache();
  for (const src of pOld[0].sources) { if (rowsByKey[src.requestKey]) cOld.map.set(src.requestHash, { rows: rowsByKey[src.requestKey].map((r) => ({ ...r, sku: "OLD" })), fetched_at: "2026-09-01T06:00:00.000Z", expires_at: "2999-01-01T00:00:00.000Z", source_id: src.sourceId, organization_fingerprint: src.organizationFingerprint, account_scope_hash: src.accountScopeHash }); }
  const sumOld = await materializeListingHealthV3PerAccount({ plans: pOld, connections, readSourceCache: cOld.readSourceCache, writeSourceCache: cOld.writeSourceCache, saveDurablePayload: d.saveDurablePayload, recordDurableByKey: d.recordDurableByKey });
  const stillD1 = [...d.pointers.values()].every((r) => r.as_of === "2026-09-02");
  ok("older as_of -> 'stale-save'; the newer D-1 pointer is NEVER overwritten (LKG intact)", sumOld.durableStale >= 2 && sumOld.durableWritten === 0 && stillD1);
}

// ---- (6) migration UNAPPLIED -> fail-soft (durableSchemaMissing) + the per-account ALIAS still written ----
{
  const cache = makeCache(); const d = makeDurable(); d.opts.schemaMissing.add(LISTINGS_SOURCE_KEY); d.opts.schemaMissing.add(LISTINGS_RAW_SOURCE_KEY); const p = plans();
  seedBatch(cache, p, { listings: SELLERS.map((s) => listingRow(s, "K1")), raw: SELLERS.map((s) => rawRow(s, "K1")), inventory: [] });
  const sum = await run(cache, d);
  ok("schema-missing durable RPC -> fail-soft durableSchemaMissing, ZERO pointers, aliases STILL written (LKG unaffected)", sum.durableSchemaMissing === 4 && d.count(LISTINGS_SOURCE_KEY) === 0 && sum.aliasesWritten === 4);
}

// ---- (7) Listings failing while Listings-Raw succeeds -> independently typed (one fails, the other persists) ----
{
  const cache = makeCache(); const d = makeDurable(); d.opts.fail.add(LISTINGS_SOURCE_KEY); const p = plans();
  seedBatch(cache, p, { listings: SELLERS.map((s) => listingRow(s, "K1")), raw: SELLERS.map((s) => rawRow(s, "K1")), inventory: [] });
  const sum = await run(cache, d);
  ok("Listings write-failure is isolated: listings pointers 0 + durableWriteFailed>=2, WHILE listings-raw persists 2", d.count(LISTINGS_SOURCE_KEY) === 0 && sum.durableWriteFailed >= 2 && d.count(LISTINGS_RAW_SOURCE_KEY) === 2 && sum.durableWritten === 2);
}

// ---- (8) durable persistence is STRICTLY ADDITIVE: with NO durable writers injected, alias behavior is unchanged ----
{
  const cache = makeCache(); const p = plans();
  seedBatch(cache, p, { listings: SELLERS.map((s) => listingRow(s, "K1")), raw: SELLERS.map((s) => rawRow(s, "K1")), inventory: [] });
  const sum = await materializeListingHealthV3PerAccount({ plans: p, connections, readSourceCache: cache.readSourceCache, writeSourceCache: cache.writeSourceCache });
  ok("no durable writers injected -> aliases written as before, no durable counters advanced (backward compatible)", sum.aliasesWritten === 4 && sum.durableWritten === 0 && sum.durableSchemaMissing === 0 && sum.durableSkippedEvidence === 0);
}

// ---- (9) THE INDIA/EU ROOT-CAUSE FIX: durable pointer is BACKFILLED on the freshness-SKIP path (alias already ----
//         current from a prior pre-wiring materialization) -- persistence is DECOUPLED from the alias-write guard. ----
{
  const cache = makeCache(); const d = makeDurable(); const p = plans();
  seedBatch(cache, p, { listings: SELLERS.map((s) => listingRow(s, "K1")), raw: SELLERS.map((s) => rawRow(s, "K1")), inventory: [] });
  // Pass 1 = the pre-wiring world: aliases are written (batchFetchedAt stamped) but NO durable writers are injected,
  // so ZERO durable pointers exist -- exactly India's + Europe/AU's steady state.
  const sum1 = await materializeListingHealthV3PerAccount({ plans: p, connections, readSourceCache: cache.readSourceCache, writeSourceCache: cache.writeSourceCache });
  ok("9: pre-wiring pass writes aliases but NO durable pointers (reproduces the India/EU gap)", sum1.aliasesWritten === 4 && d.count(LISTINGS_SOURCE_KEY) === 0 && d.count(LISTINGS_RAW_SOURCE_KEY) === 0);
  // Pass 2 = wiring now deployed. The SAME cached batch is re-adopted; the alias's stored batchFetchedAt EQUALS the
  // batch fetched_at, so the freshness guard trips (skippedStale) and the alias is NOT rewritten. BEFORE the fix the
  // durable step (after the `continue`) never ran; AFTER the fix persistDurable backfills the missing pointer.
  const readAliasMeta = async (h) => { const e = cache.map.get(h); return e && e.request_meta ? { batchFetchedAt: e.request_meta.batchFetchedAt } : null; };
  const sum2 = await run(cache, d, { readAliasMeta });
  // skippedStale = 6 (2 accounts x 3 read keys: listings + listings-raw + inventory alias); durable backfills the two
  // NEW-export families only (inventory has no durable source key -> persistDurable no-ops without counting).
  ok("9: freshness guard trips (skippedStale=6, aliasesWritten=0) yet durable pointers are BACKFILLED (durableWritten=4)", sum2.skippedStale === 6 && sum2.aliasesWritten === 0 && sum2.durableWritten === 4 && d.count(LISTINGS_SOURCE_KEY) === 2 && d.count(LISTINGS_RAW_SOURCE_KEY) === 2);
  // Pass 3 = replay after backfill: the alias is still current AND the durable pointer now exists -> zero writes.
  const sum3 = await run(cache, d, { readAliasMeta });
  ok("9: replay after backfill -> skippedStale=6, durableUnchanged=4, ZERO new writes (idempotent)", sum3.skippedStale === 6 && sum3.durableUnchanged === 4 && sum3.durableWritten === 0);
}

// ---- (10) MISSING MEMBERSHIP != EMPTY: an owner whose seller is NOT a canonical member of the batch isolates to ----
//          rows:[] (rejected:false) but must NEVER be persisted as a genuine zero (fail closed, defer to evidence). ----
{
  const cache = makeCache(); const d = makeDurable(); const p = plans();
  seedBatch(cache, p, { listings: [listingRow("acct-00", "K1")], raw: [rawRow("acct-00", "K1")], inventory: [] }); // batch carries ONLY acct-00's rows
  // Keep ONLY acct-01's plan, and DROP acct-01 from every source's canonical member set -> acct-01 is a non-member.
  const nonMemberPlan = p.filter((pl) => pl.owner.accountId === "acct-01").map((pl) => ({ ...pl, sources: pl.sources.map((s) => ({ ...s, sellerOrVendorIds: (s.sellerOrVendorIds || []).filter((id) => String(id) !== "acct-01") })) }));
  const sum = await materializeListingHealthV3PerAccount({ plans: nonMemberPlan, connections, readSourceCache: cache.readSourceCache, writeSourceCache: cache.writeSourceCache, saveDurablePayload: d.saveDurablePayload, recordDurableByKey: d.recordDurableByKey, isSchemaMissingError: d.isSchemaMissingError, isFunctionSignatureMissingError: d.isFunctionSignatureMissingError });
  ok("10: a non-member's empty fragment is NEVER a durable proven-empty (0 pointers, durableSkippedEvidence>0)", d.count(LISTINGS_SOURCE_KEY) === 0 && d.count(LISTINGS_RAW_SOURCE_KEY) === 0 && sum.durableSkippedEvidence >= 2);
  // Contrast: a genuine MEMBER with an empty fragment DOES persist a valid-empty (proves the gate keys on membership).
  const cache2 = makeCache(); const d2 = makeDurable(); const p2 = plans();
  seedBatch(cache2, p2, { listings: [], raw: [], inventory: [] });
  await run(cache2, d2);
  ok("10: a genuine member with an empty fragment DOES persist a row_count=0 pointer (membership proven)", d2.count(LISTINGS_SOURCE_KEY) === 2 && [...d2.pointers.values()].every((r) => r.row_count === 0));
}

// ---- (11) Listings/Raw persistence is INDEPENDENT of each other and of OLI/Catalog/inventory: with ONLY the two ----
//          NEW-export batches present (no inventory/OLI/Catalog seeded), both still persist (source-decoupled). ----
{
  const cache = makeCache(); const d = makeDurable(); const p = plans();
  seedBatch(cache, p, { listings: SELLERS.map((s) => listingRow(s, "K1")), raw: SELLERS.map((s) => rawRow(s, "K1")) }); // inventory intentionally ABSENT
  const sum = await run(cache, d);
  ok("11: Listings + Listings-Raw both persist with NO inventory/OLI/Catalog present (persistence is source-decoupled)", d.count(LISTINGS_SOURCE_KEY) === 2 && d.count(LISTINGS_RAW_SOURCE_KEY) === 2 && sum.durableWritten === 4 && sum.batchMissing === 2);
}

writeSync(1, `\nlistings-durable-model: ${passed} assertions passed\n`);
