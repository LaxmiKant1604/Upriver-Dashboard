// Scheduler v2 -- schema-contract MUTATION proofs (senior review Finding 3, offline, ZERO network/DB).
//
// Proves the runtime preflight FAILS CLOSED when the two new 20260817 migrations or their wrappers are missing
// or WEAKENED: a missing migration, a drifted RPC signature, a removed RPC, a weakened least-privilege ACL, a
// missing REVOKE, a missing index, RLS not enabled, a dropped primary key, and a removed required wrapper each
// surface a TYPED audit blocker. The baseline (unmutated real files) must audit clean, so the mutations are the
// only cause of failure.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { auditSchemaContract } from "../lib/server/sync/schema-contract.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REUSE = "20260817_scheduler_v2_reuse_cas.sql";
const BATCH = "20260817_source_batch_membership.sql";
const WRAP = "supabase.js";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

function realContent(name) {
  if (name === WRAP) return fs.readFileSync(join(ROOT, "lib/server/supabase.js"), "utf8");
  return fs.readFileSync(join(ROOT, "supabase/migrations", name), "utf8");
}
// mutations: { [name]: (text)=>newText | null }. A null value simulates a MISSING file.
function auditWith(mutations = {}) {
  const readFile = (name) => {
    if (Object.prototype.hasOwnProperty.call(mutations, name)) {
      const m = mutations[name];
      return m === null ? null : m(realContent(name));
    }
    return realContent(name);
  };
  return auditSchemaContract({ readFile });
}
const hasBlocker = (audit, code) => audit.blockers.some((b) => b.code === code);

test("baseline. the REAL committed migrations + wrappers audit CLEAN (so a mutation is the only failure cause)", () => {
  const a = auditWith({});
  assert.equal(a.ok, true, "audit ok");
  assert.equal(a.blockers.length, 0, "zero blockers on the real files");
  assert.equal(a.requiredWrappers.ok, true, "every required wrapper present");
});

test("missing-migration. a missing 20260817 reuse-CAS migration => MIGRATION_MISSING (fail closed)", () => {
  const a = auditWith({ [REUSE]: null });
  assert.ok(!a.ok && hasBlocker(a, "MIGRATION_MISSING"), "MIGRATION_MISSING");
});

test("rpc-drift. a drifted adopt_source_export_cache parameter => RPC_PARAM_MISMATCH", () => {
  const a = auditWith({ [REUSE]: (t) => t.split("p_expected_source_id").join("p_drifted_source_id") });
  assert.ok(!a.ok && hasBlocker(a, "RPC_PARAM_MISMATCH"), "RPC_PARAM_MISMATCH");
});

test("rpc-missing. a removed adopt_source_export_cache function => RPC_MISSING", () => {
  const a = auditWith({ [REUSE]: (t) => t.replace("function public.adopt_source_export_cache(", "function public.adopt_source_export_cache_removed(") });
  assert.ok(!a.ok && hasBlocker(a, "RPC_MISSING"), "RPC_MISSING");
});

test("acl-weakened. GRANT ALL (instead of SELECT) to service_role on source_batch_membership => SERVICE_ROLE_GRANT_MISMATCH (direct-write bypass forbidden)", () => {
  const a = auditWith({ [BATCH]: (t) => t.replace("grant select on table public.source_batch_membership to service_role", "grant all on table public.source_batch_membership to service_role") });
  assert.ok(!a.ok && hasBlocker(a, "SERVICE_ROLE_GRANT_MISMATCH"), "SERVICE_ROLE_GRANT_MISMATCH");
});

test("acl-revoke-missing. a missing REVOKE ALL ... FROM service_role => SERVICE_ROLE_REVOKE_MISSING", () => {
  const a = auditWith({ [BATCH]: (t) => t.replace("from public, anon, authenticated, service_role;", "from public, anon, authenticated;") });
  assert.ok(!a.ok && hasBlocker(a, "SERVICE_ROLE_REVOKE_MISSING"), "SERVICE_ROLE_REVOKE_MISSING");
});

test("index-missing. a renamed/absent required index => INDEX_MISSING", () => {
  const a = auditWith({ [BATCH]: (t) => t.split("source_batch_membership_family_idx").join("source_batch_membership_family_idx_gone") });
  assert.ok(!a.ok && hasBlocker(a, "INDEX_MISSING"), "INDEX_MISSING");
});

test("rls-missing. RLS not enabled on source_batch_membership => RLS_NOT_ENABLED", () => {
  const a = auditWith({ [BATCH]: (t) => t.replace("alter table public.source_batch_membership enable row level security;", "") });
  assert.ok(!a.ok && hasBlocker(a, "RLS_NOT_ENABLED"), "RLS_NOT_ENABLED");
});

test("pk-dropped. a renamed primary-key constraint => NAMED_CONSTRAINT_MISSING", () => {
  const a = auditWith({ [BATCH]: (t) => t.replace("source_batch_membership_pk primary key", "source_batch_membership_pk_renamed primary key") });
  assert.ok(!a.ok && hasBlocker(a, "NAMED_CONSTRAINT_MISSING"), "NAMED_CONSTRAINT_MISSING");
});

test("wrapper-missing. a removed adoptSourceExportCache wrapper => REQUIRED_WRAPPER_MISSING", () => {
  const a = auditWith({ [WRAP]: (t) => t.replace("export async function adoptSourceExportCache(", "export async function adoptSourceExportCacheGone(") });
  assert.ok(!a.ok && hasBlocker(a, "REQUIRED_WRAPPER_MISSING"), "REQUIRED_WRAPPER_MISSING");
});

let failures = 0;
for (const t of tests) {
  try { t.fn(); passed += 1; out("  ok  " + t.name); }
  catch (err) { failures += 1; out("FAIL  " + t.name); out(String(err && err.stack ? err.stack : err)); }
}
out("\n" + passed + " assertions passed");
if (failures) process.exitCode = 1;
