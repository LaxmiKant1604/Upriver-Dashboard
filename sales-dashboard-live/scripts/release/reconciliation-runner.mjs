// THROWAWAY strictly READ-ONLY production-state reconciliation runner (Scheduler-v2 release, final round).
// Validates the pinned identity BEFORE connecting; runs inside BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY
// (SELECT-only; ROLLBACK in finally). Classifies live + scheduler-v2 shadow report_snapshots using the EXACT
// registered contracts (REPORT_DERIVATIONS.validatePayload, paramsHashFor) and the trusted read-only storage
// loader, re-checks every pinned production invariant in the SAME snapshot, and prints ONLY safe metadata and
// typed pass/fail summaries -- never payloads, params, storage contents, export IDs, secrets, or raw errors.
// It NEVER writes and NEVER changes a pin; it prints the candidate 8-dataset digests for a human to pin.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { validateIdentity, APPROVED_INVARIANTS, PROTECTED_DIGEST_KEYS } from "./release-manifest.mjs";
import { verifyApprovedInvariants, verifyLedgerForStage, verifyStageObjects, captureProtectedDigest, beginReadOnlySnapshot } from "./release-state.mjs";
import { parseEnv } from "./release-fs.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..", "..");
const env = parseEnv(readFileSync(path.resolve(appRoot, "..", ".env.local"), "utf8"));
for (const [k, v] of Object.entries(env)) if (process.env[k] == null) process.env[k] = v; // for lib/server config

const id = validateIdentity(env);
console.log(`IDENTITY  approved_ref=${id.projectRef} host=${id.pgHost}:${id.pgPort} ok=${id.ok}`);
if (!id.ok) { console.error("STOP identity: " + id.problems.join("; ")); process.exit(1); }

// Registered contracts + hash + trusted loader (imported AFTER env is populated).
const imp = (rel) => import(pathToFileURL(path.resolve(appRoot, rel)).href);
const { REPORT_DERIVATIONS, productionKeyFromShadow, isShadowSnapshotKey } = await imp("lib/server/sync/report-derivation.js");
const { paramsHashFor } = await imp("lib/server/report-store.js");
const { getReportSnapshotStoragePayload } = await imp("lib/server/supabase.js");
const KNOWN_SHADOW_KEYS = new Set([...Object.keys(REPORT_DERIVATIONS), "brand-inventory"]);
const ab = (s) => (s == null ? "-" : String(s).slice(0, 8)); // abbreviated identifier/hash

const u = new URL(env.POSTGRES_URL); u.searchParams.set("sslmode", "no-verify");
const client = new pg.Client({ connectionString: u.toString() });
const q = (t, p) => client.query(t, p);
await client.connect();

const failures = []; // any entry => STOP (never pin)
const fail = (cat, msg) => failures.push(`[${cat}] ${msg}`);
try {
  await beginReadOnlySnapshot(client);

  // ---- (A) snapshot growth metadata (safe fields only) --------------------------------------------------
  const metaFor = async (kind, where) => {
    const c = Number((await q(`select count(*)::int c from public.report_snapshots where ${where}`)).rows[0].c);
    const byKey = (await q(`select report_key, count(*)::int c from public.report_snapshots where ${where} group by report_key order by report_key`)).rows;
    const accts = Number((await q(`select count(distinct account_id)::int c from public.report_snapshots where ${where}`)).rows[0].c);
    const dup = Number((await q(`select coalesce(sum(c-1),0)::int d from (select count(*)::int c from public.report_snapshots where ${where} group by report_key, account_id, params_hash having count(*)>1) t`)).rows[0].d);
    const rng = (await q(`select min(created_at) cmin, max(created_at) cmax, max(updated_at) umax, max(source_refreshed_at) smax from public.report_snapshots where ${where}`)).rows[0];
    const store = (await q(`select count(*) filter (where payload_storage_path is not null)::int backed, count(*) filter (where payload is not null)::int inline from public.report_snapshots where ${where}`)).rows[0];
    console.log(`GROWTH ${kind}: total=${c} accounts=${accts} dup_natural_ids=${dup} storage_backed=${store.backed} inline=${store.inline}`);
    console.log(`GROWTH ${kind}: created ${ab(rng.cmin && rng.cmin.toISOString())}..${ab(rng.cmax && rng.cmax.toISOString())} updated_max=${ab(rng.umax && rng.umax.toISOString())} refreshed_max=${ab(rng.smax && rng.smax.toISOString())}`);
    console.log(`GROWTH ${kind}: by_report_key = ${byKey.map((r) => r.report_key + ":" + r.c).join(", ")}`);
    if (dup > 0) fail("duplicated", `${kind} has ${dup} duplicate natural identities`);
    return c;
  };
  const liveWhere = "report_key not like 'scheduler-v2/%'";
  const shadowWhere = "report_key like 'scheduler-v2/%'";
  const liveCount = await metaFor("LIVE", liveWhere);
  const shadowCount = await metaFor("SHADOW", shadowWhere);
  // newest rows (classification of the growth vs Appendix AI 176/26) -- safe metadata only.
  for (const [kind, where, n] of [["LIVE", liveWhere, Math.max(0, liveCount - 176)], ["SHADOW", shadowWhere, Math.max(0, shadowCount - 26)]]) {
    const newest = (await q(`select report_key, account_id, params_hash, params->>'reportVersion' rv, (payload_storage_path is not null) backed, created_at from public.report_snapshots where ${where} order by created_at desc nulls last limit greatest($1,0)`, [n])).rows;
    console.log(`NEWEST ${kind} (${n} beyond Appendix AI): ${newest.map((r) => `${r.report_key}/${ab(r.account_id)}/${ab(r.params_hash)}@${r.rv || "?"}${r.backed ? "[S]" : "[I]"}`).join("  ") || "(none)"}`);
  }

  // ---- (B) per-row validation (live + shadow) -----------------------------------------------------------
  const rowsAll = (await q(`select id, report_key, account_id, params_hash, params, payload, payload_storage_path from public.report_snapshots`)).rows;
  let validated = 0, contractPass = 0, contractSkip = 0, hashChecked = 0, hydrated = 0, shadowLineaged = 0;
  for (const r of rowsAll) {
    const shadow = isShadowSnapshotKey(r.report_key);
    const prodKey = shadow ? productionKeyFromShadow(r.report_key) : r.report_key;
    // natural-identity completeness
    if (!r.report_key || !r.account_id || !r.params_hash) { fail("malformed", `row ${ab(r.id)} missing natural identity`); continue; }
    // known key (shadow must be a registered Scheduler-v2 report key)
    if (shadow && !KNOWN_SHADOW_KEYS.has(prodKey)) { fail("unclassified", `shadow ${r.report_key} is not a known Scheduler-v2 report key`); continue; }
    // params_hash recompute (where supported: params carries reportVersion)
    const rv = r.params && typeof r.params === "object" ? r.params.reportVersion : null;
    if (rv) { hashChecked += 1; const rh = paramsHashFor(rv, r.params); if (shadow && rh !== r.params_hash) fail("malformed", `shadow ${prodKey}/${ab(r.account_id)} params_hash recompute mismatch`); }
    else if (shadow) fail("malformed", `shadow ${prodKey}/${ab(r.account_id)} params has no reportVersion`);
    // payload: hydrate storage-backed via the trusted loader; inline otherwise
    let payload = r.payload;
    if (r.payload_storage_path) { try { payload = await getReportSnapshotStoragePayload(String(r.payload_storage_path)); hydrated += 1; } catch { fail("malformed", `row ${ab(r.id)} storage payload unreadable`); continue; } if (payload == null) { fail("malformed", `row ${ab(r.id)} dangling storage pointer`); continue; } }
    // contract validation using the EXACT registered contract (where one exists)
    const entry = REPORT_DERIVATIONS[prodKey];
    if (entry && typeof entry.validatePayload === "function") {
      if (payload == null || entry.validatePayload(payload) !== true) { fail("contract-invalid", `${shadow ? "shadow" : "live"} ${prodKey}/${ab(r.account_id)} failed the registered payload contract`); continue; }
      contractPass += 1;
    } else if (shadow) {
      // a known shadow key without a REPORT_DERIVATIONS entry (brand-inventory): require a non-null object payload.
      if (payload == null || typeof payload !== "object") { fail("contract-invalid", `shadow ${prodKey}/${ab(r.account_id)} has no usable payload`); continue; }
      contractPass += 1;
    } else { contractSkip += 1; }
    validated += 1;
  }
  console.log(`ROWS    validated=${validated}/${rowsAll.length}  contract_pass=${contractPass}  contract_skip(live,no-registered-contract)=${contractSkip}  hash_recomputed=${hashChecked}  storage_hydrated=${hydrated}`);

  // ---- (C) shadow lineage: owning validated sync_report_job + owning cycle; scope coherence --------------
  try {
  const shadowRows = rowsAll.filter((r) => isShadowSnapshotKey(r.report_key));
  for (const r of shadowRows) {
    const prodKey = productionKeyFromShadow(r.report_key);
    const job = (await q("select cycle_id, validated, save_status, derive_status, connection_id, bucket from public.sync_report_jobs where report_key=$1 and account_id=$2 and snapshot_params_hash=$3", [prodKey, r.account_id, r.params_hash])).rows[0];
    if (!job) { fail("unlineaged", `shadow ${prodKey}/${ab(r.account_id)} has no owning sync_report_job`); continue; }
    if (job.validated !== true || job.save_status !== "succeeded" || job.derive_status !== "succeeded") { fail("unlineaged", `shadow ${prodKey}/${ab(r.account_id)} owning job not a validated success`); continue; }
    const cyc = (await q("select 1 from public.sync_cycles where id=$1", [job.cycle_id])).rows[0];
    if (!cyc) { fail("unlineaged", `shadow ${prodKey}/${ab(r.account_id)} owning cycle missing`); continue; }
    // no ownerless source dependency: every depends_on hash of the owning job has an owner row this cycle.
    const dep = (await q(`select count(*)::int missing from (select unnest(depends_on) h from public.sync_report_jobs where cycle_id=$1 and report_key=$2 and account_id=$3) d where not exists (select 1 from public.sync_source_job_owners o where o.cycle_id=$1 and o.request_hash=d.h)`, [job.cycle_id, prodKey, r.account_id])).rows[0];
    if (dep && Number(dep.missing) > 0) fail("unlineaged", `shadow ${prodKey}/${ab(r.account_id)} has ${dep.missing} ownerless source dependency`);
    if (job.connection_id !== "primary") fail("wrong-account", `shadow ${prodKey}/${ab(r.account_id)} owning job connection ${job.connection_id} != primary`);
    shadowLineaged += 1;
  }
  console.log(`LINEAGE shadow_rows_with_validated_lineage=${shadowLineaged}/${shadowRows.length}`);
  } catch (e) { fail("runner-C", `lineage error name=${e && e.name} code=${e && e.code} (message suppressed)`); }

  // ---- (D) all pinned production invariants, in the SAME snapshot ----------------------------------------
  try {
    const inv = [...await verifyLedgerForStage(q, 0), ...await verifyStageObjects(q, 0), ...await verifyApprovedInvariants(q, APPROVED_INVARIANTS)];
    console.log(`INVARIANTS ${inv.length === 0 ? "ALL PASS" : inv.length + " FAIL"}`);
    for (const p of inv) { console.log("  - " + p); fail("invariant", p); }
  } catch (e) { fail("runner-D", `invariants error name=${e && e.name} code=${e && e.code} (message suppressed)`); }

  // ---- (E) candidate manifest pins (runbook algorithm) for all 8 datasets -------------------------------
  try {
    const dig = await captureProtectedDigest(q);
    console.log("\nCANDIDATE MANIFEST PINS (runbook algorithm; pin ONLY if the verdict is RECONCILED PASS):");
    for (const k of PROTECTED_DIGEST_KEYS) console.log(`  ${k}: { c: ${dig[k].c}, h: "${dig[k].h}" },`);
  } catch (e) { fail("runner-E", `digest error name=${e && e.name} code=${e && e.code} (message suppressed)`); }
} catch (e) {
  // Sanitized: name + SQLSTATE only (never the raw error message, which could echo a param/value).
  fail("runner", `error name=${e && e.name} code=${e && e.code} (message suppressed)`);
} finally {
  try { await client.query("ROLLBACK"); } catch {}
  await client.end();
}

console.log("\nVERDICT " + (failures.length === 0 ? "RECONCILED PASS -- every row and invariant passed; the printed pins may be committed." : `STOP -- ${failures.length} issue(s); DO NOT change any pin:`));
for (const f of failures.slice(0, 40)) console.log("  - " + f);
process.exit(failures.length === 0 ? 0 : 1);
