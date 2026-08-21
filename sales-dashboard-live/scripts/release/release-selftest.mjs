// OFFLINE self-tests for the release engine (no database). A handler-based fake q / fake client returns
// synthetic catalog rows; tests prove the engine ACCEPTS a correct shape and REJECTS every drift Codex
// enumerated. Run: node scripts/release/release-selftest.mjs
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  validateIdentity, verifyTable, verifyFunction, verifyTriggers, verifyTableAcl, verifyPolicies, verifyIndexes,
  verifyMigrationAbsent, bodyCanon, APPROVED_IDENTITY, APPROVED_INVARIANTS, PROTECTED_DIGESTS, PROTECTED_DIGEST_KEYS, MIGRATIONS, NEW6,
} from "./release-manifest.mjs";
import {
  verifyLedgerForStage, verifyApprovedInvariants, compareProtectedDigest, requirePinnedStage0Digest,
  buildBaseline, validateBaseline, shouldCreateBaseline, beginReadOnlySnapshot, applyInTransaction, runApply,
  buildStage3Baseline, validateStage3Baseline, shouldCreateStage3Baseline,
} from "./release-state.mjs";

let passed = 0, failed = 0;
const tests = [];
const test = (n, f) => tests.push({ n, f });
const fakeQ = (handlers) => async (text, params) => { for (const [needle, fn] of handlers) if (text.includes(needle)) return { rows: fn(params || []) }; return { rows: [] }; };
const clone = (v) => JSON.parse(JSON.stringify(v));
const REF = APPROVED_IDENTITY.projectRef;
const goodEnv = { SUPABASE_URL: `https://${REF}.supabase.co`, POSTGRES_URL: "postgres" + "://postgres." + REF + "@" + APPROVED_IDENTITY.pgHost + ":" + APPROVED_IDENTITY.pgPort + "/" + APPROVED_IDENTITY.pgDatabase };

// ---------- table catalog + handlers (new engine) --------------------------------------------------------
const conDefFor = (kind, spec) =>
  kind === "p" ? `PRIMARY KEY (${spec.cols.join(", ")})`
  : kind === "f" ? `FOREIGN KEY ${spec.canon}`
  : spec.enum ? `CHECK ((${spec.enum.col} = ANY (ARRAY[${spec.enum.values.map((v) => `'${v}'`).join(", ")}])))`
  : `CHECK ((${spec.canon}))`;
const T = {
  name: "t", rls: true,
  columns: [["a", "text", true, null], ["b", "integer", true, "0"], ["c", "text", true, "'primary'::text"]],
  constraints: [["t_pk", "p", { cols: ["a", "b"] }], ["t_bounds", "c", { canon: "b>=0ANDb<=max_b" }], ["t_enum", "c", { enum: { col: "c", values: ["primary", "dd-secondary"] } }], ["t_fk", "f", { canon: "updated_byREFERENCESauth.usersidONDELETESETNULL" }]],
  indexes: [{ name: "t_idx", cols: ["a", "b"] }],
  policies: [{ name: "t_read", table: "t", permissive: "PERMISSIVE", cmd: "SELECT", roles: ["authenticated"], using: "is_dashboard_admin()", withCheck: null }],
  triggers: [{ name: "t_touch", table: "t", tgtype: 19, enabled: "O", fnsig: "public.touch_updated_at()" }],
  acl: { service_role: ["SELECT"] },
  seed: { column: "a", exact: true, values: ["s1", "s2"], off: "b >= 0" },
};
function actualFromTable(t) {
  return {
    exists: true,
    columns: t.columns.map(([attname, typ, nn, def]) => ({ attname, typ, nn, def })),
    constraints: t.constraints.map(([conname, contype, spec]) => ({ conname, contype, def: conDefFor(contype, spec) })),
    indexes: [
      ...t.indexes.map((e) => ({ indexname: e.name, indexdef: `CREATE INDEX ${e.name} ON public.${t.name} USING btree (${e.cols.join(", ")})` })),
      ...t.constraints.filter((x) => x[1] === "p" || x[1] === "u").map((x) => ({ indexname: x[0], indexdef: `CREATE UNIQUE INDEX ${x[0]} ON public.${t.name} USING btree (${x[2].cols.join(", ")})` })),
    ],
    rls: t.rls,
    policies: t.policies.map((p) => ({ policyname: p.name, permissive: p.permissive, cmd: p.cmd, roles: p.roles, qual: p.using, with_check: p.withCheck })),
    triggers: new Map(t.triggers.map((tg) => [tg.name, { tgtype: tg.tgtype, tgenabled: tg.enabled, fn_ok: true }])),
    owner: "mig_owner",
    acl: [{ grantee: "mig_owner", priv: "SELECT" }, ...Object.entries(t.acl).flatMap(([g, vs]) => vs.map((v) => ({ grantee: g, priv: v })))],
    seedKeys: [...(t.seed.values || [])],
    seedOffViolations: 0,
  };
}
const tHandlers = (name, a) => [
  ["from pg_trigger t where not t.tgisinternal and t.tgrelid=$1::regclass and t.tgname=$2", (p) => { const tg = a.triggers.get(p[1]); return tg ? [{ tgtype: tg.tgtype, tgenabled: tg.tgenabled, fn_ok: tg.fn_ok }] : []; }],
  ["select t.tgname from pg_trigger t", () => [...a.triggers].map(([n]) => ({ tgname: n }))],
  ["format_type(a.atttypid,a.atttypmod) typ", () => a.columns],
  ["and conname=$2", (p) => { const c = a.constraints.find((x) => x.conname === p[1]); return c ? [c] : []; }],
  ["pg_get_constraintdef(oid) def from pg_constraint where conrelid=$1::regclass", () => a.constraints],
  ["select 1 from pg_constraint", (p) => (a.constraints.some((x) => x.conname === p[1]) ? [{}] : [])],
  ["select 1 from pg_attribute", (p) => (a.columns.some((c) => c.attname === p[1]) ? [{}] : [])],
  ["from pg_indexes", () => a.indexes],
  ["relrowsecurity r", () => [{ r: a.rls }]],
  ["from pg_policies", () => a.policies],
  ["c.relowner", () => [{ o: a.owner }]],
  ["aclexplode(c.relacl)", () => a.acl],
  ["and not (", () => [{ c: a.seedOffViolations }]],
  [" k from public.", () => a.seedKeys.map((k) => ({ k }))],
  ["to_regclass($1)", (p) => [{ r: p[0] === `public.${name}` && a.exists ? p[0] : null }]],
];
const tq = (a) => fakeQ(tHandlers(T.name, a));

// ---------- identity (blocker 5: exact host/port/db) -----------------------------------------------------
test("identity: approved ref/host/port/db passes", () => { assert.equal(validateIdentity(goodEnv).ok, true); });
test("identity: WRONG port fails", () => { assert.equal(validateIdentity({ ...goodEnv, POSTGRES_URL: goodEnv.POSTGRES_URL.replace(":6543", ":5432") }).ok, false); });
test("identity: WRONG host (substring-only) fails", () => { assert.equal(validateIdentity({ ...goodEnv, POSTGRES_URL: goodEnv.POSTGRES_URL.replace(APPROVED_IDENTITY.pgHost, "evil." + APPROVED_IDENTITY.pgHost) }).ok, false); });
test("identity: WRONG db fails", () => { assert.equal(validateIdentity({ ...goodEnv, POSTGRES_URL: goodEnv.POSTGRES_URL.replace("/postgres", "/otherdb") }).ok, false); });
test("identity: WRONG project ref fails", () => { assert.equal(validateIdentity({ ...goodEnv, SUPABASE_URL: "https://zzzzzzzzzzzzzzzzzzzz.supabase.co" }).ok, false); });

// ---------- function ACL ---------------------------------------------------------------------------------
const FN = { sig: "public.f(uuid, text)", ret: "text", secdef: true, searchPath: "public", acl: { service_role: ["EXECUTE"] } };
const fnQ = (meta, acl) => fakeQ([["p.prosecdef sd", () => (meta ? [meta] : [])], ["aclexplode(p.proacl)", () => acl]]);
const goodMeta = { oid: 1, sd: true, cfg: ["search_path=public"], ret: "text", owner: "mig_owner", noacl: false };
test("function: correct passes", async () => { assert.deepEqual(await verifyFunction(fnQ(goodMeta, [{ grantee: "service_role", priv: "EXECUTE" }]), FN), []); });
test("function: DEFAULT (PUBLIC) acl fails", async () => { assert.ok((await verifyFunction(fnQ({ ...goodMeta, noacl: true }, []), FN)).length); });
test("function: arbitrary grantee fails", async () => { assert.ok((await verifyFunction(fnQ(goodMeta, [{ grantee: "service_role", priv: "EXECUTE" }, { grantee: "bot", priv: "EXECUTE" }]), FN)).length); });

// ---------- table ACL incl MAINTAIN ----------------------------------------------------------------------
const aclQ = (owner, acl) => fakeQ([["c.relowner", () => [{ o: owner }]], ["aclexplode(c.relacl)", () => acl]]);
test("table ACL: exact verbs pass (owner ignored)", async () => { assert.deepEqual(await verifyTableAcl(aclQ("o", [{ grantee: "o", priv: "DELETE" }, { grantee: "service_role", priv: "SELECT" }, { grantee: "service_role", priv: "INSERT" }, { grantee: "service_role", priv: "UPDATE" }, { grantee: "authenticated", priv: "SELECT" }]), "t", { service_role: ["SELECT", "INSERT", "UPDATE"], authenticated: ["SELECT"] }), []); });
test("table ACL: PG17 MAINTAIN fails", async () => { assert.ok((await verifyTableAcl(aclQ("o", [{ grantee: "service_role", priv: "SELECT" }, { grantee: "service_role", priv: "MAINTAIN" }]), "t", { service_role: ["SELECT"] })).length); });
test("table ACL: anon fails", async () => { assert.ok((await verifyTableAcl(aclQ("o", [{ grantee: "service_role", priv: "SELECT" }, { grantee: "anon", priv: "SELECT" }]), "t", { service_role: ["SELECT"] })).length); });

// ---------- triggers -------------------------------------------------------------------------------------
const exp1 = [{ name: "x_touch", table: "x", tgtype: 19, enabled: "O", fnsig: "public.touch_updated_at()" }];
test("triggers: correct passes", async () => { assert.deepEqual(await verifyTriggers(fakeQ([["and t.tgname=$2", () => [{ tgtype: 19, tgenabled: "O", fn_ok: true }]], ["select t.tgname from pg_trigger t", () => [{ tgname: "x_touch" }]]]), "x", exp1), []); });
test("triggers: EXTRA trigger fails", async () => { assert.ok((await verifyTriggers(fakeQ([["and t.tgname=$2", () => [{ tgtype: 19, tgenabled: "O", fn_ok: true }]], ["select t.tgname from pg_trigger t", () => [{ tgname: "x_touch" }, { tgname: "x_extra" }]]]), "x", exp1)).length); });
test("triggers: wrong tgfoid (wrong-schema fn) fails", async () => { assert.ok((await verifyTriggers(fakeQ([["and t.tgname=$2", () => [{ tgtype: 19, tgenabled: "O", fn_ok: false }]], ["select t.tgname from pg_trigger t", () => [{ tgname: "x_touch" }]]]), "x", exp1)).length); });

// ---------- verifyTable ----------------------------------------------------------------------------------
test("table: fully-correct passes", async () => { assert.deepEqual(await verifyTable(tq(actualFromTable(T)), T), []); });
test("table: EXTRA column fails", async () => { const a = actualFromTable(T); a.columns.push({ attname: "z", typ: "text", nn: false, def: null }); assert.ok((await verifyTable(tq(a), T)).length); });
test("table: REORDERED columns fail", async () => { const a = actualFromTable(T); [a.columns[0], a.columns[1]] = [a.columns[1], a.columns[0]]; assert.ok((await verifyTable(tq(a), T)).length); });
test("table: constraint AND->OR fails (structure)", async () => { const a = actualFromTable(T); a.constraints[1].def = "CHECK ((b>=0ORb<=max_b))"; assert.ok((await verifyTable(tq(a), T)).length); });
test("table: upper bound removed fails", async () => { const a = actualFromTable(T); a.constraints[1].def = "CHECK ((b>=0))"; assert.ok((await verifyTable(tq(a), T)).length); });
test("table: enum WIDENED fails", async () => { const a = actualFromTable(T); a.constraints[2].def = "CHECK ((c = ANY (ARRAY['primary', 'dd-secondary', 'evil'])))"; assert.ok((await verifyTable(tq(a), T)).length); });
test("table: FK wrong target/action fails", async () => { const a = actualFromTable(T); a.constraints[3].def = "FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE CASCADE"; assert.ok((await verifyTable(tq(a), T)).length); });
test("table: PK reordered columns fail", async () => { const a = actualFromTable(T); a.constraints[0].def = "PRIMARY KEY (b, a)"; assert.ok((await verifyTable(tq(a), T)).length); });
test("table: REVERSED index columns fail", async () => { const a = actualFromTable(T); a.indexes[0].indexdef = "CREATE INDEX t_idx ON public.t USING btree (b, a)"; assert.ok((await verifyTable(tq(a), T)).length); });
test("table: EXTRA index column fails", async () => { const a = actualFromTable(T); a.indexes[0].indexdef = "CREATE INDEX t_idx ON public.t USING btree (a, b, c)"; assert.ok((await verifyTable(tq(a), T)).length); });
test("table: UNIQUE drift on index fails", async () => { const a = actualFromTable(T); a.indexes[0].indexdef = "CREATE UNIQUE INDEX t_idx ON public.t USING btree (a, b)"; assert.ok((await verifyTable(tq(a), T)).length); });
test("table: index PREDICATE drift fails", async () => { const a = actualFromTable(T); a.indexes[0].indexdef = "CREATE INDEX t_idx ON public.t USING btree (a, b) WHERE (b > 0)"; assert.ok((await verifyTable(tq(a), T)).length); });
test("table: EXTRA index fails", async () => { const a = actualFromTable(T); a.indexes.push({ indexname: "t_x", indexdef: "CREATE INDEX t_x ON public.t USING btree (b)" }); assert.ok((await verifyTable(tq(a), T)).length); });
test("table: RLS disabled fails", async () => { const a = actualFromTable(T); a.rls = false; assert.ok((await verifyTable(tq(a), T)).length); });
test("table: policy OR-true fails", async () => { const a = actualFromTable(T); a.policies[0].qual = "(is_dashboard_admin() OR true)"; assert.ok((await verifyTable(tq(a), T)).length); });
test("table: EXTRA seed row fails", async () => { const a = actualFromTable(T); a.seedKeys.push("s3"); assert.ok((await verifyTable(tq(a), T)).length); });

// ---------- policies (isolated) --------------------------------------------------------------------------
const polQ = (rows) => fakeQ([["from pg_policies", () => rows]]);
const P1 = [{ name: "p", table: "t", permissive: "PERMISSIVE", cmd: "SELECT", roles: ["authenticated"], using: "is_dashboard_admin()", withCheck: null }];
test("policy: correct passes", async () => { assert.deepEqual(await verifyPolicies(polQ([{ policyname: "p", permissive: "PERMISSIVE", cmd: "SELECT", roles: ["authenticated"], qual: "is_dashboard_admin()", with_check: null }]), "t", P1), []); });
test("policy: RESTRICTIVE fails", async () => { assert.ok((await verifyPolicies(polQ([{ policyname: "p", permissive: "RESTRICTIVE", cmd: "SELECT", roles: ["authenticated"], qual: "is_dashboard_admin()", with_check: null }]), "t", P1)).length); });
test("policy: (is_dashboard_admin() OR true) fails", async () => { assert.ok((await verifyPolicies(polQ([{ policyname: "p", permissive: "PERMISSIVE", cmd: "SELECT", roles: ["authenticated"], qual: "(is_dashboard_admin() OR true)", with_check: null }]), "t", P1)).length); });
test("policy: unexpected WITH CHECK fails", async () => { assert.ok((await verifyPolicies(polQ([{ policyname: "p", permissive: "PERMISSIVE", cmd: "SELECT", roles: ["authenticated"], qual: "is_dashboard_admin()", with_check: "(true)" }]), "t", P1)).length); });

// ---------- ledger ---------------------------------------------------------------------------------------
const BASE12 = ["20260728_shared_dashboard.sql", "20260729_automated_ads_sync.sql", "20260729_dashboard_auth_and_access.sql", "20260803_fx_rate_cache.sql", "20260805_scheduled_sync.sql", "20260806_shared_source_export_cache.sql", "20260807_scheduler_v2.sql", "20260810_ads_sync_coverage.sql", "20260810_report_sync_controls.sql", "20260811_sync_source_job_owners.sql", "20260815_sync_cycle_finalize.sql", "20260816_account_rollout.sql"];
const ledgerQ = (rec) => fakeQ([["from public.app_schema_migrations group by filename", () => rec.map((f) => (typeof f === "string" ? { filename: f, c: 1 } : f))]]);
test("ledger: stage prefixes accepted; stage1 not-absent", async () => { for (let s = 0; s <= 6; s++) assert.deepEqual(await verifyLedgerForStage(ledgerQ([...BASE12, ...NEW6.slice(0, s)]), s), []); assert.deepEqual(await verifyLedgerForStage(ledgerQ([...BASE12, NEW6[0]]), 1), []); });
test("ledger: extra filename fails", async () => { assert.ok((await verifyLedgerForStage(ledgerQ([...BASE12, "99_rogue.sql"]), 0)).length); });
test("ledger: duplicate fails", async () => { assert.ok((await verifyLedgerForStage(ledgerQ([...BASE12, { filename: BASE12[0], c: 2 }]), 0)).length); });

// ---------- pinned control invariants + dfca8f75 child state (blocker 3) ---------------------------------
const A = APPROVED_INVARIANTS;
const invQ = (o = {}) => fakeQ([
  ["to_regclass('cron.job')", () => [{ r: o.cron ? "cron.job" : null }]],
  ["count(*)::int c from cron.job", () => [{ c: o.cronCount || 0 }]],
  ["all_primary from public.scheduler_rollout_mode", () => [{ all_primary: o.allPrimary === undefined ? false : o.allPrimary }]],
  ["account_id, enabled from public.scheduler_account_rollout", () => o.rollout || A.rolloutRows],
  ["account_id, report_key, approved from public.scheduler_publish_approvals", () => o.approvals || A.approvalRows],
  ["report_key, schedule_enabled from public.report_sync_settings", () => o.settings || A.reportSyncSettings],
  ["select id from public.sync_cycles where id::text like", () => Array.from({ length: o.dfcaCount === undefined ? 1 : o.dfcaCount }, (_, i) => ({ id: "dfca8f75-000" + i }))],
  ["status, source_total::int st", () => [o.dfca || { status: "running", st: 122, ss: 8, sf: 9, rt: 0, rs: 0, rf: 0, finished_at: null }]],
  ["fetch_status, count(*)::int c from public.sync_source_jobs", () => o.srcStatus || [{ fetch_status: "succeeded", c: 8 }, { fetch_status: "failed", c: 9 }, { fetch_status: "attempted", c: 4 }, { fetch_status: "pending", c: 101 }]],
  ["max(create_export_count)", () => [o.createExport || { mx: 1, over1: 0 }]],
  ["count(*)::int total, count(*) filter", () => [o.reportJobs || { total: 8, pp: 8 }]],
  ["to_regclass($1)", () => [{ r: "present" }]],
]);
test("invariants: matching pinned state + child state passes", async () => { assert.deepEqual(await verifyApprovedInvariants(invQ(), A), []); });
test("invariants: all_primary=true fails", async () => { assert.ok((await verifyApprovedInvariants(invQ({ allPrimary: true }), A)).length); });
test("invariants: TOTAL cron > 0 fails", async () => { assert.ok((await verifyApprovedInvariants(invQ({ cron: true, cronCount: 1 }), A)).length); });
test("invariants: EXTRA disabled rollout row fails", async () => { assert.ok((await verifyApprovedInvariants(invQ({ rollout: [...A.rolloutRows, { account_id: "other", enabled: false }] }), A)).length); });
test("invariants: FALSE approval row fails", async () => { assert.ok((await verifyApprovedInvariants(invQ({ approvals: A.approvalRows.map((r, i) => (i === 0 ? { ...r, approved: false } : r)) }), A)).length); });
test("invariants: extra approval row fails", async () => { assert.ok((await verifyApprovedInvariants(invQ({ approvals: [...A.approvalRows, { account_id: A.rolloutRows[0].account_id, report_key: "daily-reporting", approved: true }] }), A)).length); });
test("invariants: missing settings row fails", async () => { assert.ok((await verifyApprovedInvariants(invQ({ settings: A.reportSyncSettings.slice(1) }), A)).length); });
test("invariants: MULTIPLE dfca prefix matches fail", async () => { assert.ok((await verifyApprovedInvariants(invQ({ dfcaCount: 2 }), A)).length); });
test("invariants: dfca source counter drift fails", async () => { assert.ok((await verifyApprovedInvariants(invQ({ dfca: { status: "running", st: 122, ss: 9, sf: 9, rt: 0, rs: 0, rf: 0, finished_at: null } }), A)).length); });
test("invariants: dfca report_succeeded drift fails", async () => { assert.ok((await verifyApprovedInvariants(invQ({ dfca: { status: "running", st: 122, ss: 8, sf: 9, rt: 0, rs: 1, rf: 0, finished_at: null } }), A)).length); });
test("invariants: dfca cycle report_total non-zero (old 8 mis-encoding) fails vs corrected 0 pin", async () => { assert.ok((await verifyApprovedInvariants(invQ({ dfca: { status: "running", st: 122, ss: 8, sf: 9, rt: 8, rs: 0, rf: 0, finished_at: null } }), A)).length); });
test("invariants: dfca CHILD source status drift fails", async () => { assert.ok((await verifyApprovedInvariants(invQ({ srcStatus: [{ fetch_status: "succeeded", c: 9 }, { fetch_status: "failed", c: 9 }, { fetch_status: "attempted", c: 4 }, { fetch_status: "pending", c: 100 }] }), A)).length); });
test("invariants: dfca CHILD create_export_count > 1 fails", async () => { assert.ok((await verifyApprovedInvariants(invQ({ createExport: { mx: 2, over1: 1 } }), A)).length); });
test("invariants: dfca CHILD report jobs total drift fails", async () => { assert.ok((await verifyApprovedInvariants(invQ({ reportJobs: { total: 7, pp: 7 } }), A)).length); });
test("invariants: dfca CHILD report jobs not-all-pending fails", async () => { assert.ok((await verifyApprovedInvariants(invQ({ reportJobs: { total: 8, pp: 7 } }), A)).length); });
test("invariants: NULL sentinel fails-closed", async () => { assert.ok((await verifyApprovedInvariants(invQ(), { ...A, rolloutRows: null })).length); });

// ---------- manifest-pinned protected digests (blocker 2) ------------------------------------------------
const TESTPINS = Object.fromEntries(PROTECTED_DIGEST_KEYS.map((k, i) => [k, { c: 10 + i, h: "hash" + i }]));
const fullObs = () => Object.fromEntries(PROTECTED_DIGEST_KEYS.map((k, i) => [k, { present: true, c: 10 + i, h: "hash" + i }]));
test("digest: all-8 pinned exact-match passes", () => { assert.deepEqual(requirePinnedStage0Digest(fullObs(), TESTPINS), []); });
test("digest: real manifest now pins ALL 8 (no null fail-open remains)", () => { assert.ok(PROTECTED_DIGEST_KEYS.every((k) => PROTECTED_DIGESTS[k] && typeof PROTECTED_DIGESTS[k].h === "string" && Number.isInteger(PROTECTED_DIGESTS[k].c))); });
test("digest: real manifest fails closed on any drift from its 8 pins", () => { assert.equal(requirePinnedStage0Digest(fullObs()).length, 8); });
test("digest: EDIT any observed hash fails", () => { const o = fullObs(); o.rollout.h = "x"; assert.ok(requirePinnedStage0Digest(o, TESTPINS).length); });
test("digest: EDIT any observed count fails", () => { const o = fullObs(); o.settings.c = 999; assert.ok(requirePinnedStage0Digest(o, TESTPINS).length); });
test("digest: EXTRA observed key fails", () => { const o = fullObs(); o.rogue = { c: 1, h: "z" }; assert.ok(requirePinnedStage0Digest(o, TESTPINS).length); });
test("digest: MISSING observed key fails", () => { const o = fullObs(); delete o.mode; assert.ok(requirePinnedStage0Digest(o, TESTPINS).length); });
test("digest: compareProtectedDigest drift fails", () => { const b = { live_snapshots: { h: "a", c: 1 } }; assert.deepEqual(compareProtectedDigest(b, clone(b)), []); assert.ok(compareProtectedDigest(b, { live_snapshots: { h: "z", c: 1 } }).length); });

// ---------- Migration-4 POSITION serialization: constraint mutation regressions (recovery from stage 3) ---
// `position(':' in account_id) = 0` serializes in PostgreSQL as the SQL-standard operator form
// POSITION(':' IN account_id) -- NOT the strpos-style position(account_id, ':'). The pin is that exact form.
const M4 = MIGRATIONS.find((m) => m.file === "20260820_source_durable_model.sql");
const M4_CANON = M4.alters[0].addConstraints.find((c) => c[0] === "source_batch_membership_account_canonical")[2].canon;
const M4_PG = "CHECK ((account_id = btrim(account_id)) AND (char_length(account_id) > 0) AND (POSITION((':'::text) IN account_id) = 0))";
test("m4 POSITION: exact PostgreSQL POSITION(':' IN account_id) serialization matches the pin", () => { assert.equal(bodyCanon(M4_PG), M4_CANON); });
test("m4 POSITION: reversed operands POSITION(account_id IN ':') fails", () => { assert.notEqual(bodyCanon("CHECK ((account_id = btrim(account_id)) AND (char_length(account_id) > 0) AND (POSITION(account_id IN (':'::text)) = 0))"), M4_CANON); });
test("m4 POSITION: strpos-style position(account_id, ':') (the old wrong pin) fails", () => { assert.notEqual("account_id=btrimaccount_idANDchar_lengthaccount_id>0ANDpositionaccount_id,':'=0", M4_CANON); });
test("m4 POSITION: changed needle POSITION(';' IN account_id) fails", () => { assert.notEqual(bodyCanon("CHECK ((account_id = btrim(account_id)) AND (char_length(account_id) > 0) AND (POSITION((';'::text) IN account_id) = 0))"), M4_CANON); });
test("m4 POSITION: changed haystack POSITION(':' IN seller_or_vendor_id) fails", () => { assert.notEqual(bodyCanon("CHECK ((account_id = btrim(account_id)) AND (char_length(account_id) > 0) AND (POSITION((':'::text) IN seller_or_vendor_id) = 0))"), M4_CANON); });
test("m4 POSITION: removed canonical-account (position) condition fails", () => { assert.notEqual(bodyCanon("CHECK ((account_id = btrim(account_id)) AND (char_length(account_id) > 0))"), M4_CANON); });

// ---------- Migrations 5 & 6 catalog expectations remain exact (unchanged by the migration-4 fix) ---------
const M5 = MIGRATIONS.find((m) => m.file === "20260821_source_promoted_publish_controls.sql");
const M5T = M5.tables.find((t) => t.name === "source_promoted_publish_settings");
const M5_CK = M5T.constraints.find((c) => c[0] === "source_promoted_publish_settings_report_key_nonblank")[2].canon;
const M5_FK = M5T.constraints.find((c) => c[0] === "source_promoted_publish_settings_updated_by_fkey")[2].canon;
test("m5 CK: char_length(btrim(report_key)) > 0 serialization matches the pin", () => { assert.equal(bodyCanon("CHECK ((char_length(btrim(report_key)) > 0))"), M5_CK); });
test("m5 CK: a different column btrim(account_id) fails", () => { assert.notEqual(bodyCanon("CHECK ((char_length(btrim(account_id)) > 0))"), M5_CK); });
test("m5 FK: updated_by REFERENCES auth.users(id) ON DELETE SET NULL matches the pin", () => { assert.equal(bodyCanon("FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL"), M5_FK); });
test("m5 FK: a different action ON DELETE CASCADE fails", () => { assert.notEqual(bodyCanon("FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE CASCADE"), M5_FK); });
const M6 = MIGRATIONS.find((m) => m.file === "20260822_report_derive_lease.sql");
test("m6 catalog: adds NO new tables and NO new constraints (add-columns only)", () => { assert.equal((M6.tables || []).length, 0); assert.deepEqual(M6.alters[0].addConstraints, []); });

// ---------- manifest-pinned baseline ---------------------------------------------------------------------
const FP = "fp".repeat(20), HEAD = "a".repeat(40);
const good = buildBaseline({ head: HEAD, fingerprint: FP, pins: TESTPINS });
const vb = (b, over = {}) => validateBaseline(b, { currentHead: HEAD, currentFingerprint: FP, envRef: REF, pins: TESTPINS, ...over });
test("baseline: build uses manifest-pinned values only (all 8 keys)", () => { assert.deepEqual(Object.keys(good.protectedDigest).sort(), [...PROTECTED_DIGEST_KEYS].sort()); assert.equal(good.protectedDigest.rollout.h, TESTPINS.rollout.h); });
test("baseline: valid passes", () => { assert.deepEqual(vb(good), []); });
test("baseline: EDIT any digest hash fails", () => { const b = clone(good); b.protectedDigest.approvals.h = "tampered"; assert.ok(vb(b).length); });
test("baseline: EDIT any digest count fails", () => { const b = clone(good); b.protectedDigest.sync_cycles.c = 777; assert.ok(vb(b).length); });
test("baseline: ADD a digest key fails", () => { const b = clone(good); b.protectedDigest.rogue = { c: 1, h: "z" }; assert.ok(vb(b).length); });
test("baseline: REMOVE a digest key fails", () => { const b = clone(good); delete b.protectedDigest.report_jobs; assert.ok(vb(b).length); });
test("baseline: real manifest pins reject a baseline built from foreign (test) pins", () => { assert.ok(validateBaseline(good, { currentHead: HEAD, currentFingerprint: FP, envRef: REF }).length); });
test("baseline: malformed fails", () => { assert.ok(vb("nope").length); });
test("baseline: wrong-HEAD fails", () => { assert.ok(vb(good, { currentHead: "b".repeat(40) }).length); });
test("baseline: stale fingerprint fails", () => { assert.ok(vb(good, { currentFingerprint: "x" }).length); });
test("baseline: environment switched fails", () => { assert.ok(vb(good, { envRef: "zzzzzzzzzzzzzzzzzzzz" }).length); });
test("baseline: shouldCreate gate", () => { assert.equal(shouldCreateBaseline({ stage: 0, problemCount: 0, rolledBack: true }), true); assert.equal(shouldCreateBaseline({ stage: 0, problemCount: 1, rolledBack: true }), false); assert.equal(shouldCreateBaseline({ stage: 0, problemCount: 0, rolledBack: false }), false); assert.equal(shouldCreateBaseline({ stage: 1, problemCount: 0, rolledBack: true }), false); });
test("baseline: atomic exclusive create refuses second write", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rel-")); const f = path.join(dir, "b.json");
  try { writeFileSync(f, "{}", { flag: "wx" }); let threw = false; try { writeFileSync(f, "{}", { flag: "wx" }); } catch (e) { threw = e.code === "EEXIST"; } assert.equal(threw, true); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- applier commit-unknown / rollback / runApply-before-connect (blocker 1/2) --------------------
const recClient = (opts = {}) => { const calls = []; return { calls, async query(text) { calls.push(text); if (opts.throwAt && text.includes(opts.throwAt)) throw new Error(opts.err || "boom"); if (text.includes("count(*)")) return { rows: [{ c: 1 }] }; return { rows: [] }; }, async end() { calls.push("END"); }, async connect() { calls.push("CONNECT"); } }; };
const passHooks = { _validate: () => [], _ledger: async () => [], _invariants: async () => [], _objects: async () => [], _present: async () => [], _capture: async () => ({ live_snapshots: { h: "a", c: 0 } }), _compare: () => [] };
const applyCtx = (client) => ({ client, mig: MIGRATIONS[0], stageIdx: 0, sql: "MIGSQL", baseline: { protectedDigest: {} }, currentHead: HEAD, currentFingerprint: FP, envRef: REF, approved: {}, ...passHooks });
test("applier: committed -> code 0", async () => { const c = recClient({}); assert.equal((await applyInTransaction(applyCtx(c))).code, 0); assert.ok(c.calls.includes("COMMIT")); });
test("applier: COMMIT ack lost -> code 3, NO rollback", async () => { const c = recClient({ throwAt: "COMMIT", err: "Connection terminated" }); const r = await applyInTransaction(applyCtx(c)); assert.equal(r.code, 3); assert.ok(!c.calls.includes("ROLLBACK")); });
test("applier: pre-commit failure -> code 1 + ROLLBACK once", async () => { const c = recClient({ throwAt: "MIGSQL" }); const r = await applyInTransaction(applyCtx(c)); assert.equal(r.code, 1); assert.equal(c.calls.filter((x) => x === "ROLLBACK").length, 1); });
test("runApply: MALFORMED baseline -> ZERO client construction/connect", async () => {
  let made = 0;
  const r = await runApply({ filename: NEW6[0], sqlText: "X", actualSha: MIGRATIONS[0].sha, env: goodEnv, currentHead: HEAD, currentFingerprint: FP, envRef: REF, baselineText: "{ this is not json", makeClient: () => { made += 1; return recClient({}); }, approved: {} });
  assert.equal(made, 0, "makeClient must NOT be called on a malformed baseline");
  assert.equal(r.connected, false); assert.equal(r.code, 1);
});
test("runApply: WRONG identity -> ZERO client construction/connect", async () => {
  let made = 0;
  const r = await runApply({ filename: NEW6[0], sqlText: "X", actualSha: MIGRATIONS[0].sha, env: { ...goodEnv, POSTGRES_URL: goodEnv.POSTGRES_URL.replace(":6543", ":5432") }, currentHead: HEAD, currentFingerprint: FP, envRef: REF, baselineText: JSON.stringify(good), makeClient: () => { made += 1; return recClient({}); }, approved: {} });
  assert.equal(made, 0); assert.equal(r.connected, false);
});
test("runApply: valid pre-checks -> client IS constructed", async () => {
  // _validate injected to pass (the real manifest's 6 unpinned digests fail-close until the diagnostic runs).
  let made = 0;
  await runApply({ filename: NEW6[0], sqlText: "X", actualSha: MIGRATIONS[0].sha, env: goodEnv, currentHead: HEAD, currentFingerprint: FP, envRef: REF, baselineText: JSON.stringify(good), _validate: () => [], makeClient: () => { made += 1; return recClient({}); }, approved: APPROVED_INVARIANTS });
  assert.equal(made, 1, "client is constructed once when every pre-connect check passes");
});

// ---------- DEDICATED stage-3 re-anchor baseline (forward-only recovery; governs ONLY migrations 4-6) -----
const s3 = buildStage3Baseline({ head: HEAD, fingerprint: FP, pins: TESTPINS });
const vs3 = (b, over = {}) => validateStage3Baseline(b, { currentHead: HEAD, currentFingerprint: FP, envRef: REF, pins: TESTPINS, ...over });
test("stage3: build binds anchorStage=3, all 6 migration hashes, manifest-pinned digests", () => { assert.equal(s3.anchorStage, 3); assert.equal(Object.keys(s3.migrationHashes).length, 6); assert.deepEqual(Object.keys(s3.protectedDigest).sort(), [...PROTECTED_DIGEST_KEYS].sort()); });
test("stage3: valid passes for a migration 4-6 (stageIdx>=3) and for a read-only check (no stageIdx)", () => { assert.deepEqual(vs3(s3, { stageIdx: 3 }), []); assert.deepEqual(vs3(s3, { stageIdx: 5 }), []); assert.deepEqual(vs3(s3), []); });
test("stage3: anchorStage != exactly 3 fails", () => { const b = clone(s3); b.anchorStage = 0; assert.ok(vs3(b).length); b.anchorStage = 4; assert.ok(vs3(b).length); });
test("stage3: applying a migration whose stage PRECEDES the anchor (stageIdx<3) fails", () => { assert.ok(vs3(s3, { stageIdx: 2 }).length); assert.ok(vs3(s3, { stageIdx: 0 }).length); });
test("stage3: wrong HEAD fails", () => { assert.ok(vs3(s3, { currentHead: "b".repeat(40) }).length); });
test("stage3: stale manifest fingerprint fails", () => { assert.ok(vs3(s3, { currentFingerprint: "x" }).length); });
test("stage3: environment switched (envRef mismatch) fails", () => { assert.ok(vs3(s3, { envRef: "otherproject" }).length); });
test("stage3: wrong project ref fails", () => { const b = clone(s3); b.projectRef = "someoneelse"; assert.ok(vs3(b, { stageIdx: 3, envRef: null }).length); });
test("stage3: EDIT a digest hash fails", () => { const b = clone(s3); b.protectedDigest.approvals.h = "tampered"; assert.ok(vs3(b, { stageIdx: 3 }).length); });
test("stage3: EDIT a digest count fails", () => { const b = clone(s3); b.protectedDigest.settings.c = 999; assert.ok(vs3(b, { stageIdx: 3 }).length); });
test("stage3: ADD an extra digest key fails", () => { const b = clone(s3); b.protectedDigest.rogue = { c: 1, h: "z" }; assert.ok(vs3(b, { stageIdx: 3 }).length); });
test("stage3: REMOVE a digest key fails", () => { const b = clone(s3); delete b.protectedDigest.report_jobs; assert.ok(vs3(b, { stageIdx: 3 }).length); });
test("stage3: migration-hash drift fails", () => { const b = clone(s3); b.migrationHashes[NEW6[0]] = "deadbeef"; assert.ok(vs3(b, { stageIdx: 3 }).length); });
test("stage3: real manifest pins reject a foreign-pins stage-3 baseline", () => { assert.ok(validateStage3Baseline(s3, { currentHead: HEAD, currentFingerprint: FP, envRef: REF, stageIdx: 3 }).length); });
test("stage3: shouldCreate requires zero problems AND a clean rollback", () => { assert.equal(shouldCreateStage3Baseline({ problemCount: 0, rolledBack: true }), true); assert.equal(shouldCreateStage3Baseline({ problemCount: 1, rolledBack: true }), false); assert.equal(shouldCreateStage3Baseline({ problemCount: 0, rolledBack: false }), false); });
// applier: the stage-3 baseline governs ONLY migrations 4-6.
test("stage3 applier: migration 4 (stageIdx 3) + VALID stage-3 baseline constructs the client", async () => { let made = 0; const b = buildStage3Baseline({ head: HEAD, fingerprint: FP }); await runApply({ filename: NEW6[3], sqlText: "X", actualSha: MIGRATIONS[3].sha, env: goodEnv, currentHead: HEAD, currentFingerprint: FP, envRef: REF, baselineText: JSON.stringify(b), makeClient: () => { made += 1; return recClient({}); }, approved: APPROVED_INVARIANTS }); assert.equal(made, 1); });
test("stage3 applier: migration 4 REJECTS a stage-0-shaped baseline (no anchorStage) -> zero connect", async () => { let made = 0; const b = buildBaseline({ head: HEAD, fingerprint: FP }); const r = await runApply({ filename: NEW6[3], sqlText: "X", actualSha: MIGRATIONS[3].sha, env: goodEnv, currentHead: HEAD, currentFingerprint: FP, envRef: REF, baselineText: JSON.stringify(b), makeClient: () => { made += 1; return recClient({}); }, approved: APPROVED_INVARIANTS }); assert.equal(made, 0); assert.equal(r.code, 1); });
test("stage3 applier: migration 1 (stageIdx 0) REJECTS a stage-3 baseline -> zero connect", async () => { let made = 0; const b = buildStage3Baseline({ head: HEAD, fingerprint: FP }); const r = await runApply({ filename: NEW6[0], sqlText: "X", actualSha: MIGRATIONS[0].sha, env: goodEnv, currentHead: HEAD, currentFingerprint: FP, envRef: REF, baselineText: JSON.stringify(b), makeClient: () => { made += 1; return recClient({}); }, approved: APPROVED_INVARIANTS }); assert.equal(made, 0); assert.equal(r.code, 1); });

// ---------- absent-check must not crash when an altered table is absent (42P01 guard) --------------------
test("absent: altered-table absent -> 'absent', never a 42P01 crash", async () => {
  // M4 (index 3) ALTERs source_batch_membership; at stage 0 that table does not exist yet. to_regclass/
  // to_regprocedure resolve to null (absent) so columnExists/constraintExists must short-circuit, not throw.
  const q = fakeQ([["to_regclass($1)", () => [{ r: null }]], ["to_regprocedure($1) r", () => [{ r: null }]]]);
  assert.deepEqual(await verifyMigrationAbsent(q, MIGRATIONS[3]), []);
  assert.deepEqual(await verifyMigrationAbsent(q, MIGRATIONS[5]), []); // M6 ALTERs sync_report_jobs columns
});

// ---------- read consistency -----------------------------------------------------------------------------
test("read: beginReadOnlySnapshot issues REPEATABLE READ READ ONLY", async () => { const calls = []; await beginReadOnlySnapshot({ query: async (t) => { calls.push(t); return { rows: [] }; } }); assert.equal(calls[0], "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); });

// ---------- run ------------------------------------------------------------------------------------------
for (const t of tests) { try { await t.f(); passed += 1; console.log("ok   " + t.n); } catch (e) { failed += 1; console.error("FAIL " + t.n + " :: " + (e && e.message)); } }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
