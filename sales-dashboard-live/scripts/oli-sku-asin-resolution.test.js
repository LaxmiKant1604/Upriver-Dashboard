// Structural proof of migration 20260910_oli_sku_asin_resolution.sql: the READ-ONLY, isolated, fail-closed
// server-side SKU -> child_asin resolver. No DB -- reads the SQL text and asserts the contract. 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writeSync } from "node:fs";

const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
let passed = 0;
const check = (name, fn) => { try { fn(); passed += 1; out("  ok  " + name); } catch (e) { out("FAIL  " + name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; } };

const sql = readFileSync("supabase/migrations/20260910_oli_sku_asin_resolution.sql", "utf8");
const lower = sql.toLowerCase();

check("adds the resolve_oli_sku_asin function", () => {
  assert.match(lower, /create or replace function\s+public\.resolve_oli_sku_asin\s*\(/);
});

check("is SECURITY DEFINER with a pinned search_path (least surprise)", () => {
  assert.match(lower, /security definer/);
  assert.match(lower, /set search_path = public/);
});

check("is READ-ONLY: declared STABLE, language sql, and mutates nothing", () => {
  assert.match(lower, /\bstable\b/);
  assert.match(lower, /language sql/);
  // No write statements whatsoever.
  for (const kw of ["insert into", "update ", "delete from", "drop table", "create table", "alter table", "truncate"]) {
    assert.equal(lower.includes(kw), false, "the resolver must never " + kw.trim());
  }
});

check("reads the durable dimensional history under the EXACT isolation boundary", () => {
  assert.match(lower, /from\s+public\.source_oli_dimensional_history/);
  assert.match(lower, /organization_fingerprint\s*=\s*p_organization_fingerprint/);
  assert.match(lower, /connection_id\s*=\s*p_connection_id/);
  assert.match(lower, /account_id\s*=\s*p_account_id/);
  // grouping is per seller + currency + sku (never crosses seller/currency/account/marketplace)
  assert.match(lower, /group by\s+seller_or_vendor_id\s*,\s*currency\s*,\s*sku/);
});

check("excludes cancelled history and blank SKUs, and requires at least one real ASIN", () => {
  assert.match(lower, /is_cancelled\s*=\s*false/);
  assert.match(lower, /char_length\(btrim\(sku\)\)\s*>\s*0/);
  assert.match(lower, /count\(distinct child_asin\)\s*filter\s*\(where btrim\(child_asin\)\s*<>\s*''\)/);
  assert.match(lower, /having\s+count\(distinct child_asin\)\s*filter\s*\(where btrim\(child_asin\)\s*<>\s*''\)\s*>=\s*1/);
});

check("returns asin_count so the caller can fail closed on ambiguity", () => {
  assert.match(lower, /asin_count\s+integer/);
});

check("least-privilege: revokes PUBLIC/anon/authenticated and grants EXECUTE only to service_role", () => {
  assert.match(lower, /revoke all on function public\.resolve_oli_sku_asin\(text, text, text\) from public, anon, authenticated/);
  assert.match(lower, /grant execute on function public\.resolve_oli_sku_asin\(text, text, text\) to service_role/);
});

out("\n" + passed + " structural assertions passed");
