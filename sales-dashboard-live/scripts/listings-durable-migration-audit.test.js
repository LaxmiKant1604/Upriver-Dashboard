// SCHEMA + ACL AUDIT for the PREPARED/UNAPPLIED durable Listings + Listings-Raw migrations (WORK B). Pure source
// inspection of the two migration files (no DB, no apply) proving they match the reviewed source_snapshots durable
// template: content-addressed identity, marketplace/as-of/source isolation, a STRICTLY-NEWER-OR-EQUAL-IDENTICAL CAS
// (older never overwrites newer; equal+conflicting fails closed), RLS on, direct writes revoked, service_role SELECT
// only (the SECURITY DEFINER RPC is the sole write path), and the PREPARED/UNAPPLIED/APPROVAL-GATED header. 7-bit ASCII.
import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "listings-durable-migration-audit\n");

const here = path.dirname(fileURLToPath(import.meta.url));
const mig = (f) => readFileSync(path.join(here, "..", "supabase", "migrations", f), "utf8");

const CASES = [
  { file: "20260926_source_listings_snapshot.sql", table: "source_listings_snapshot", rpc: "record_source_listings_snapshot", sk: "listings" },
  { file: "20260927_source_listings_raw_snapshot.sql", table: "source_listings_raw_snapshot", rpc: "record_source_listings_raw_snapshot", sk: "listings-raw" },
];

for (const { file, table, rpc, sk } of CASES) {
  const sql = mig(file);
  ok(`${file}: PREPARED/UNAPPLIED/APPROVAL-GATED header (do not apply without sign-off)`, /PREPARED \/ UNAPPLIED -- APPROVAL-GATED\. DO NOT APPLY WITHOUT EXPLICIT SIGN-OFF\./.test(sql) && /MIGRATE_ONLY=/.test(sql));
  ok(`${file}: creates public.${table} idempotently`, new RegExp("create table if not exists public\\." + table + "\\b").test(sql));
  ok(`${file}: content-addressed identity columns (object_path, payload_sha, row_count, source_request_hash, validated_at)`, /object_path text not null/.test(sql) && /payload_sha text not null/.test(sql) && /row_count integer not null/.test(sql) && /source_request_hash text not null/.test(sql) && /validated_at timestamptz not null/.test(sql));
  ok(`${file}: organization/connection/account/marketplace/as_of/source identity`, /organization_fingerprint text not null/.test(sql) && /connection_id text not null/.test(sql) && /account_id text not null/.test(sql) && /marketplace text not null/.test(sql) && /as_of date not null/.test(sql) && new RegExp("source_key text not null default '" + sk + "'").test(sql));
  ok(`${file}: marketplace is a 2-letter code + account is canonical (no ':' prefix)`, /marketplace ~ '\^\[A-Z\]\{2\}\$'/.test(sql) && /position\(':' in account_id\) = 0/.test(sql));
  ok(`${file}: bounded valid-empty allowed (row_count >= 0) and payload nonneg`, /row_count >= 0/.test(sql) && /payload_bytes >= 0/.test(sql));
  ok(`${file}: PK is (organization_fingerprint, connection_id, account_id) -- one latest-good pointer per account`, new RegExp("primary key \\(organization_fingerprint, connection_id, account_id\\)").test(sql));
  // The CAS RPC: SECURITY DEFINER + all four terminal dispositions (older never overwrites newer; equal-identical
  // idempotent; equal-conflicting fails closed; strictly-newer replaces).
  ok(`${file}: SECURITY DEFINER CAS RPC ${rpc}`, new RegExp("create or replace function public\\." + rpc + "\\b").test(sql) && /security definer/.test(sql) && /set search_path = public/.test(sql));
  ok(`${file}: CAS returns stale-save (older) / unchanged (equal-identical) / conflict (equal-conflicting) / replaced (strictly-newer)`, /return 'stale-save'/.test(sql) && /return 'unchanged'/.test(sql) && /return 'conflict'/.test(sql) && /return 'replaced'/.test(sql));
  ok(`${file}: CAS locks the row FOR UPDATE + guards BEFORE any write (p_validated_at < existing -> stale-save)`, /for update/.test(sql) && /if p_validated_at < v_existing\.validated_at then\s*\n\s*return 'stale-save'/.test(sql));
  ok(`${file}: CAS rejects incomplete evidence before any write`, new RegExp("raise exception '" + rpc + ": incomplete validated").test(sql));
  ok(`${file}: RLS ENABLED + direct writes REVOKED from all + service_role SELECT only (RPC is the sole write path)`, new RegExp("alter table public\\." + table + " enable row level security").test(sql) && new RegExp("revoke all on table public\\." + table + " from public, anon, authenticated, service_role").test(sql) && new RegExp("grant select on table public\\." + table + " to service_role").test(sql) && !new RegExp("grant (insert|update|delete)[^;]*public\\." + table).test(sql));
  ok(`${file}: touch trigger reuses public.touch_updated_at`, new RegExp(table + "_touch").test(sql) && /execute function public\.touch_updated_at\(\)/.test(sql));
}

// The two stores are SEPARATE (Listings Raw is never merged with Listings) -- distinct tables + distinct source_key checks.
ok("Listings + Listings-Raw are SEPARATE durable stores (distinct tables, distinct source_key)", mig(CASES[0].file).includes("source_listings_snapshot") && mig(CASES[1].file).includes("source_listings_raw_snapshot") && mig(CASES[0].file).includes("source_key = 'listings'") && mig(CASES[1].file).includes("source_key = 'listings-raw'"));

writeSync(1, `\nlistings-durable-migration-audit: ${passed} assertions passed\n`);
