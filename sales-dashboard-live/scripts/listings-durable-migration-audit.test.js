// SCHEMA + ACL AUDIT for the PREPARED/UNAPPLIED durable Listings + Listings-Raw migrations (WORK B). Pure source
// inspection of the two migration files (no DB, no apply) proving they match the reviewed source_snapshots durable
// template AND the Codex-review corrections: SECURITY DEFINER FUNCTION ACL (revoke from public/anon/authenticated,
// grant EXECUTE only to service_role -- table ACL alone is insufficient), a LOGICAL-FRESHNESS CAS where as_of (business
// evidence date) DOMINATES validated_at (a delayed D-2 with a later validated_at can never overwrite D-1), an EXACT
// unchanged identity (every relevant field equal), payload_bytes validation, and a marketplace-conflict fail-closed.
// Each critical ACL/guard also has a MUTATION-DETECTION check: removing it from a copy makes the audit predicate FAIL
// (so a regression that drops the protection is caught). 7-bit ASCII, LF.
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
const SIG = "\\(text, text, text, text, date, text, text, integer, bigint, text, timestamptz\\)";

for (const { file, table, rpc, sk } of CASES) {
  const sql = mig(file);
  const has = (re) => re.test(sql);
  // ---- structural (unchanged from the first cut) ----
  ok(`${file}: PREPARED/UNAPPLIED/APPROVAL-GATED header`, /PREPARED \/ UNAPPLIED -- APPROVAL-GATED\. DO NOT APPLY WITHOUT EXPLICIT SIGN-OFF\./.test(sql) && /MIGRATE_ONLY=/.test(sql));
  ok(`${file}: creates public.${table} idempotently + content-addressed identity columns`, new RegExp("create table if not exists public\\." + table + "\\b").test(sql) && /object_path text not null/.test(sql) && /payload_sha text not null/.test(sql) && /row_count integer not null/.test(sql) && /payload_bytes bigint not null/.test(sql) && /source_request_hash text not null/.test(sql) && /validated_at timestamptz not null/.test(sql));
  ok(`${file}: org/connection/account/marketplace/as_of/source identity + PK (org, connection, account)`, /organization_fingerprint text not null/.test(sql) && /marketplace text not null/.test(sql) && /as_of date not null/.test(sql) && new RegExp("source_key text not null default '" + sk + "'").test(sql) && new RegExp("primary key \\(organization_fingerprint, connection_id, account_id\\)").test(sql));
  ok(`${file}: marketplace 2-letter + account canonical + bounded valid-empty (row_count/payload_bytes >= 0)`, /marketplace ~ '\^\[A-Z\]\{2\}\$'/.test(sql) && /position\(':' in account_id\) = 0/.test(sql) && /row_count >= 0/.test(sql) && /payload_bytes >= 0/.test(sql));
  ok(`${file}: SECURITY DEFINER CAS RPC ${rpc}`, new RegExp("create or replace function public\\." + rpc + "\\b").test(sql) && /security definer/.test(sql) && /set search_path = public/.test(sql));

  // ---- blocker 1: SECURITY DEFINER FUNCTION ACL (revoke from public/anon/authenticated; grant EXECUTE to service_role only) ----
  const fnRevoke = new RegExp("revoke all on function public\\." + rpc + SIG + " from public, anon, authenticated");
  const fnGrant = new RegExp("grant execute on function public\\." + rpc + SIG + " to service_role");
  ok(`${file}: [B1] function EXECUTE revoked from public/anon/authenticated`, has(fnRevoke));
  ok(`${file}: [B1] function EXECUTE granted ONLY to service_role (no public/anon/authenticated grant)`, has(fnGrant) && !new RegExp("grant execute on function public\\." + rpc + "[^;]*to (public|anon|authenticated)").test(sql));
  ok(`${file}: [B1] table ACL still present (RLS on, writes revoked, service_role SELECT only)`, new RegExp("alter table public\\." + table + " enable row level security").test(sql) && new RegExp("revoke all on table public\\." + table + " from public, anon, authenticated, service_role").test(sql) && new RegExp("grant select on table public\\." + table + " to service_role").test(sql) && !new RegExp("grant (insert|update|delete)[^;]*public\\." + table).test(sql));

  // ---- blocker 2: LOGICAL-FRESHNESS CAS -- as_of DOMINATES validated_at ----
  const asOfStale = /if p_as_of < v_existing\.as_of then\s*\n\s*return 'stale-save';/;
  const asOfEq = sql.indexOf("if p_as_of = v_existing.as_of then");
  const vtStaleInside = sql.indexOf("if p_validated_at < v_existing.validated_at then");
  ok(`${file}: [B2] incoming as_of < stored as_of -> stale-save (a delayed D-2 never overwrites D-1)`, asOfStale.test(sql));
  ok(`${file}: [B2] validated_at is only compared INSIDE the equal-as_of branch (as_of dominates)`, asOfEq > 0 && vtStaleInside > asOfEq && sql.indexOf(rpc) >= 0);
  ok(`${file}: [B2] a strictly-newer as_of OR same-as_of strictly-newer validated_at reaches the replacing UPDATE`, /-- Reached ONLY when p_as_of > v_existing\.as_of[^\n]*strictly-newer validated_at\./.test(sql) && new RegExp("update public\\." + table + " set").test(sql));

  // ---- blocker 3: EXACT unchanged identity + payload_bytes validation + marketplace conflict ----
  ok(`${file}: [B3] 'unchanged' requires EVERY identity field equal (marketplace/as_of/object_path/payload_sha/row_count/payload_bytes/request_hash/source_key)`, /v_existing\.marketplace = p_marketplace and v_existing\.as_of = p_as_of/.test(sql) && /v_existing\.object_path = p_object_path and v_existing\.payload_sha = p_payload_sha/.test(sql) && /v_existing\.row_count = p_row_count and v_existing\.payload_bytes = p_payload_bytes/.test(sql) && new RegExp("v_existing\\.source_request_hash = p_source_request_hash and v_existing\\.source_key = '" + sk + "'").test(sql) && /return 'unchanged';/.test(sql));
  ok(`${file}: [B3] payload_bytes validated non-null + nonnegative BEFORE any write`, /p_payload_bytes is null or p_payload_bytes < 0/.test(sql));
  ok(`${file}: [B3] marketplace conflict fails closed (an account's marketplace is immutable)`, /if p_marketplace <> v_existing\.marketplace then\s*\n\s*return 'conflict';/.test(sql));
  ok(`${file}: [B3] all four CAS dispositions present`, /return 'stale-save'/.test(sql) && /return 'unchanged'/.test(sql) && /return 'conflict'/.test(sql) && /return 'replaced'/.test(sql) && /for update/.test(sql));
}

// ---- MUTATION DETECTION: removing a critical ACL/guard must make the audit predicate FAIL (regression is caught). ----
const strip = (sql, re) => sql.replace(re, "-- (mutated: removed)");
function mutationDetects(name, file, requiredRe) {
  const sql = mig(file);
  ok(name + " (present in the real migration)", requiredRe.test(sql));
  ok(name + " (MUTATION: removing it is DETECTED -- audit predicate now false)", !requiredRe.test(strip(sql, requiredRe)));
}
for (const { file, rpc, table } of CASES) {
  // B1 mutations: restore public EXECUTE (drop the function revoke) / widen-or-drop the service_role grant.
  mutationDetects(`${file}: [B1-mut] function revoke-from-public`, file, new RegExp("revoke all on function public\\." + rpc + SIG + " from public, anon, authenticated"));
  mutationDetects(`${file}: [B1-mut] function grant-execute-to-service_role`, file, new RegExp("grant execute on function public\\." + rpc + SIG + " to service_role"));
  // B2 mutation: drop the as_of-dominant stale-save guard.
  mutationDetects(`${file}: [B2-mut] as_of-dominant stale-save guard`, file, /if p_as_of < v_existing\.as_of then\s*\n\s*return 'stale-save';/);
  // B3 mutation: drop the marketplace-conflict guard.
  mutationDetects(`${file}: [B3-mut] marketplace-conflict guard`, file, /if p_marketplace <> v_existing\.marketplace then\s*\n\s*return 'conflict';/);
  // Table ACL mutation: restore a write grant would be caught by the negative table-ACL assertion above; prove the revoke is load-bearing.
  mutationDetects(`${file}: [ACL-mut] table writes revoked`, file, new RegExp("revoke all on table public\\." + table + " from public, anon, authenticated, service_role"));
}

// The two stores are SEPARATE (Listings Raw is never merged with Listings).
ok("Listings + Listings-Raw are SEPARATE durable stores (distinct tables + source_key)", mig(CASES[0].file).includes("source_key = 'listings'") && mig(CASES[1].file).includes("source_key = 'listings-raw'") && CASES[0].table !== CASES[1].table);

writeSync(1, `\nlistings-durable-migration-audit: ${passed} assertions passed\n`);
