// P0-1 reproduce-then-fix: the onboarding bulk-upsert 400 "All object keys must match". INTEGRATION style --
// drives the REAL supabase request wrapper (upsertAccountOnboardingRows over a stubbed global fetch that mimics
// PostgREST's heterogeneous-key rejection), with rows built by the REAL classifyOnboardingAccount. No network,
// no DataDoe, no tokens. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
const SECRET = ["SUPABASE", "SECRET", "KEY"].join("_");
process.env[SECRET] = process.env[SECRET] || "test-secret";

const { classifyOnboardingAccount, ONBOARDING_STATUS } = await import("../lib/server/sync/account-onboarding.js");
const sb = await import("../lib/server/supabase.js");

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); };
writeSync(1, "account-onboarding-upsert\n");

// PostgREST fetch double: a POST whose body is an array with >1 distinct key signature is rejected 400 (exactly the
// production failure). `failSignature` forces one specific group's POST to fail (to prove honest whole-pass failure).
function stubPostgrest({ failSignature = null } = {}) {
  const posts = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    if ((opts.method || "GET") === "POST" && Array.isArray(body)) {
      const sigs = [...new Set(body.map((o) => Object.keys(o).sort().join(",")))];
      posts.push({ url: String(url), rows: body, keySets: sigs });
      if (sigs.length > 1) return { ok: false, status: 400, json: async () => ({ message: "All object keys must match", code: "PGRST102" }) };
      if (failSignature && sigs[0] === failSignature) return { ok: false, status: 400, json: async () => ({ message: "forced group failure", code: "PGRSTXX" }) };
    }
    return { ok: true, status: 200, json: async () => [] };
  };
  return { posts, restore: () => { globalThis.fetch = orig; } };
}

const disc = (id, country, ready, mp = "M1") => ({ id, name: id, country, readiness: { sellerCentralReady: ready, marketplaceId: mp, rowCount: 10, sellerCentralRowCount: 5, adsConnected: true, adsReady: ready, adsRowCount: 3 } });
const FULL = { hasDaily: true, hasBrandSales: true, hasFbaPlan: true, hasListingHealthV3: true, oliCoveredTo: "2026-09-06", campaignCoveredTo: "2026-09-06" };
// The six statuses the discovery worker can emit, via the REAL classifier.
const mixedBatch = () => [
  classifyOnboardingAccount({ discovered: disc("W1", "IN", false), existing: null }).row,                                                              // waiting_for_datadoe
  classifyOnboardingAccount({ discovered: disc("R1", "IN", true), existing: null }).row,                                                               // ready_for_bootstrap (+ready_at)
  classifyOnboardingAccount({ discovered: disc("G1", "IN", true), existing: null, evidence: FULL }).row,                                               // ready grandfathered (+ready_at +bootstrap_completed_at)
  classifyOnboardingAccount({ discovered: disc("P1", "IN", true), existing: { account_id: "P1", status: ONBOARDING_STATUS.BOOTSTRAPPING, operation_id: "op/P1/2026-09-06", ready_at: "2026-09-01T00:00:00Z" }, evidence: { hasDaily: true } }).row, // partially_ready
  classifyOnboardingAccount({ discovered: disc("BS1", "IN", true), existing: { account_id: "BS1", status: ONBOARDING_STATUS.BOOTSTRAPPING, operation_id: "op/BS1/2026-09-06" }, evidence: null }).row, // bootstrapping
  classifyOnboardingAccount({ discovered: disc("B1", "ZZ", true), existing: null }).row,                                                               // blocked (unsupported marketplace)
];
const sig = (o) => Object.keys(o).sort().join(",");

/* ===== A. REPRODUCE + FIX: a heterogeneous batch now upserts as same-shape groups (no 400) ===== */
{
  const rows = mixedBatch();
  const distinct = new Set(rows.map((r) => { const { first_discovered_at, operation_id, bootstrap_started_at, ...owned } = r; return sig(owned); }));
  ok("A0: the real classifier produces a HETEROGENEOUS batch (>1 distinct key signature) -- the exact 400 trigger", distinct.size > 1);
  const s = stubPostgrest();
  let threw = null;
  try { await sb.upsertAccountOnboardingRows(rows); } catch (e) { threw = e; }
  s.restore();
  ok("A1: the mixed batch upserts WITHOUT the 'All object keys must match' 400 (grouped by key signature)", threw === null);
  ok("A2: exactly ONE upsert POST per distinct key signature", s.posts.length === distinct.size);
  ok("A3: EVERY POST body has a single uniform key signature (PostgREST-safe)", s.posts.every((p) => p.keySets.length === 1));
  ok("A4: all six accounts were sent across the groups (none dropped)",
    new Set(s.posts.flatMap((p) => p.rows.map((r) => r.account_id))).size === 6);
  ok("A5: every POST targets the account_id conflict key with merge-duplicates", s.posts.every((p) => p.url.includes("on_conflict=account_id")));
}

/* ===== B. omission preserved: optional columns are NEVER sent as null (merge-duplicates keeps durable values) ===== */
{
  const rows = mixedBatch();
  const s = stubPostgrest();
  await sb.upsertAccountOnboardingRows(rows);
  s.restore();
  const byId = new Map(s.posts.flatMap((p) => p.rows).map((r) => [r.account_id, r]));
  ok("B1: a waiting row OMITS ready_at + bootstrap_completed_at (never sent as null -> durable value preserved)",
    !("ready_at" in byId.get("W1")) && !("bootstrap_completed_at" in byId.get("W1")));
  ok("B2: a ready_for_bootstrap row carries ready_at but OMITS bootstrap_completed_at", ("ready_at" in byId.get("R1")) && !("bootstrap_completed_at" in byId.get("R1")));
  ok("B3: a grandfathered ready row carries BOTH ready_at + bootstrap_completed_at", ("ready_at" in byId.get("G1")) && ("bootstrap_completed_at" in byId.get("G1")));
  ok("B4: a bootstrapping row OMITS ready_at/bootstrap_completed_at (preserves whatever the DB already holds)",
    !("ready_at" in byId.get("BS1")) && !("bootstrap_completed_at" in byId.get("BS1")));
}

/* ===== C. worker-unowned fields are stripped from EVERY payload ===== */
{
  const row = classifyOnboardingAccount({ discovered: disc("X1", "IN", true), existing: null }).row;
  const dirty = { ...row, first_discovered_at: "2026-01-01T00:00:00Z", operation_id: "op/X1/x", bootstrap_started_at: "2026-02-02T00:00:00Z" };
  const s = stubPostgrest();
  await sb.upsertAccountOnboardingRows([dirty]);
  s.restore();
  const sent = s.posts.flatMap((p) => p.rows)[0];
  ok("C1: first_discovered_at, operation_id, bootstrap_started_at are NEVER sent (only the claim RPC / DB own them)",
    !("first_discovered_at" in sent) && !("operation_id" in sent) && !("bootstrap_started_at" in sent) && sent.account_id === "X1");
}

/* ===== D. idempotent replay -- the SAME batch upserts identically a second time, no error ===== */
{
  const rows = mixedBatch();
  const s = stubPostgrest();
  await sb.upsertAccountOnboardingRows(rows);
  const first = s.posts.length;
  await sb.upsertAccountOnboardingRows(rows);
  const second = s.posts.length - first;
  s.restore();
  ok("D1: a replay produces the SAME number of same-shape groups (idempotent; merge-duplicates preserves durable values)", first === second && first > 0);
}

/* ===== E. one failed group => the WHOLE call throws (never a silent partial-success) ===== */
{
  const rows = mixedBatch();
  // Force the waiting/bootstrapping/blocked group (the base 16-key signature) to fail.
  const baseSig = (() => { const { first_discovered_at, operation_id, bootstrap_started_at, ...owned } = rows[0]; return sig(owned); })();
  const s = stubPostgrest({ failSignature: baseSig });
  let threw = null;
  try { await sb.upsertAccountOnboardingRows(rows); } catch (e) { threw = e; }
  s.restore();
  ok("E1: a single failing group throws a typed Supabase error (the caller must fail the whole pass, never claim partial success)",
    threw !== null && /Supabase request failed \(400\)/.test(String(threw.message)) && threw.status === 400);
}

writeSync(1, `\naccount-onboarding-upsert: ${passed} checks passed\n`);
