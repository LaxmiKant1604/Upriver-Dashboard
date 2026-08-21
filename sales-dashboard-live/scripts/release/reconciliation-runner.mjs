// THROWAWAY strictly READ-ONLY production-state reconciliation runner (Scheduler-v2 release, corrected round).
// Validates the pinned identity BEFORE connecting; runs inside BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY
// (SELECT-only; ROLLBACK in finally). Prints ONLY safe metadata and typed pass/fail -- never payloads, params,
// storage contents, export IDs, secrets, or raw errors.
//
// CORRECTIONS (Phase 1):
//  A. VERSION-AWARE classification. The registered REPORT_DERIVATIONS.validatePayload is the SHADOW derivation
//     contract (e.g. brand-sales/v2d-2 requires a non-empty asinBrand map). It is applied ONLY to shadow rows
//     whose params.reportVersion EQUALS the registered snapshotVersion. Live rows use the DIFFERENT live-shared
//     contracts (brand-sales-shared-v1, ...) and are NEVER validated with the shadow contract. Older known
//     versions => LEGACY-HISTORICAL (identity + params-hash + readable payload + lineage; no newer contract).
//     Unknown versions fail closed. Live current-published rows are checked on the current live contract
//     version; older inactive live rows are preserved unchanged.
//  B. PARAMS PROVENANCE. paramsHashFor(reportVersion, params) is recomputed for every live+shadow row that
//     carries a reportVersion; a mismatch fails (an active-row mismatch STOPs; a legacy-row mismatch is a
//     reported legacy-provenance failure).
//  C. LINEAGE. Inspect ALL matching sync_report_jobs (never rows[0]); require >=1 exact validated succeeded job
//     in a TERMINAL cycle (succeeded/partial), coherent owners/dependencies, primary connection. For each
//     approved (report,account) it audits live<-shadow promotion byte-identity SERVER-SIDE (md5(payload::text))
//     -- reported as evidence; a broken shadow-candidate lineage fails closed.
//  D. dfca8f75 cycle-column report_total pin corrected to 0 (in release-manifest.mjs); child evidence stays 8.
//  E. TIMEOUT-SAFE. Deterministic paging; payloads validated in small bounded batches; digests + byte-identity
//     computed server-side; only the small set of CURRENT shadow candidates is ever hydrated to the client.

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

// Registered contracts + hash + live promotion mapping (imported AFTER env is populated).
const imp = (rel) => import(pathToFileURL(path.resolve(appRoot, rel)).href);
const { REPORT_DERIVATIONS, productionKeyFromShadow, isShadowSnapshotKey, shadowSnapshotKey } = await imp("lib/server/sync/report-derivation.js");
const { paramsHashFor } = await imp("lib/server/report-store.js");
const { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } = await imp("lib/server/sync/report-publisher.js");
const { getReportSnapshotStoragePayload } = await imp("lib/server/supabase.js");

const KNOWN_SHADOW_KEYS = new Set([...Object.keys(REPORT_DERIVATIONS), "brand-inventory"]);
const LIVE_VERSION = {}; // reportKey -> current live-shared reportVersion
for (const [k, c] of Object.entries(SCHEDULER_LIVE_SNAPSHOT_CONTRACTS)) LIVE_VERSION[k] = c.liveReportVersion;
const ab = (s) => (s == null ? "-" : String(s).slice(0, 8)); // abbreviated identifier
const BATCH = 8; // bounded payload-hydration batch (timeout-safe)

const u = new URL(env.POSTGRES_URL); u.searchParams.set("sslmode", "no-verify");
const client = new pg.Client({ connectionString: u.toString() });
const q = (t, p) => client.query(t, p);
await client.connect();

const failures = [];      // any entry => STOP (never pin)
const legacyNotes = [];   // legacy-row anomalies: reported, do NOT auto-pin, but distinct from active failures
const fail = (cat, msg) => failures.push(`[${cat}] ${msg}`);
const note = (cat, msg) => legacyNotes.push(`[${cat}] ${msg}`);

try {
  await beginReadOnlySnapshot(client);
  // Keep each statement bounded so a heavy row can never wedge the run (57014 => a typed, sanitized finding).
  await q("SET LOCAL statement_timeout = '25s'");

  // ---- (A) snapshot growth metadata (safe fields only; no payloads) --------------------------------------
  const metaFor = async (kind, where) => {
    const c = Number((await q(`select count(*)::int c from public.report_snapshots where ${where}`)).rows[0].c);
    const byKey = (await q(`select report_key, count(*)::int c from public.report_snapshots where ${where} group by report_key order by report_key`)).rows;
    const accts = Number((await q(`select count(distinct account_id)::int c from public.report_snapshots where ${where}`)).rows[0].c);
    const dup = Number((await q(`select coalesce(sum(c-1),0)::int d from (select count(*)::int c from public.report_snapshots where ${where} group by report_key, account_id, params_hash having count(*)>1) t`)).rows[0].d);
    const store = (await q(`select count(*) filter (where payload_storage_path is not null)::int backed, count(*) filter (where payload is not null)::int inline from public.report_snapshots where ${where}`)).rows[0];
    console.log(`GROWTH ${kind}: total=${c} accounts=${accts} dup_natural_ids=${dup} storage_backed=${store.backed} inline=${store.inline}`);
    console.log(`GROWTH ${kind}: by_report_key = ${byKey.map((r) => r.report_key + ":" + r.c).join(", ")}`);
    if (dup > 0) fail("duplicated", `${kind} has ${dup} duplicate natural identities`);
    return c;
  };
  await metaFor("LIVE", "report_key not like 'scheduler-v2/%'");
  await metaFor("SHADOW", "report_key like 'scheduler-v2/%'");

  // ---- (B) version-aware classification + params provenance ----------------------------------------------
  // Fetch light identities only (NO payload); page deterministically by id.
  const ids = (await q("select id, report_key, account_id, params_hash, params, (payload is not null) has_inline, (payload_storage_path is not null) has_store, payload_storage_path from public.report_snapshots order by id")).rows;
  const currentShadowIds = []; // ids that need the exact shadow contract validated (bounded hydration)
  const cls = { currentShadow: 0, legacyShadow: 0, currentLive: 0, legacyLive: 0, brandInv: 0 };
  let hashChecked = 0;
  for (const r of ids) {
    if (!r.report_key || !r.account_id || !r.params_hash) { fail("malformed", `row ${ab(r.id)} missing natural identity`); continue; }
    const shadow = isShadowSnapshotKey(r.report_key);
    const prodKey = shadow ? productionKeyFromShadow(r.report_key) : r.report_key;
    const entry = REPORT_DERIVATIONS[prodKey];
    const params = r.params && typeof r.params === "object" ? r.params : null;
    const rv = params && typeof params.reportVersion === "string" ? params.reportVersion : null;
    const readable = r.has_inline || r.has_store;

    // (B) params provenance. paramsHashFor is computed over the SEMANTIC params. The v1 scheduler adapter
    // (lib/server/sync/adapters/report-adapter.js) hashes the semantic params, then STORES them enriched with a
    // `syncManaged: true` marker (and reportVersion) that were NOT part of the hash. So for LIVE rows the recompute
    // accepts EITHER the stored params as-is OR with that marker stripped (reportVersion folds in idempotently);
    // a genuinely tampered row reproduces NEITHER (fail-closed). Shadow rows are hashed over stored params as-is.
    const recompute = (p) => paramsHashFor(rv, p);
    const stripMarker = (p) => { const o = { ...p }; delete o.syncManaged; return o; };
    let hashOk = true;
    if (rv) { hashChecked += 1; hashOk = shadow ? recompute(params) === r.params_hash : (recompute(params) === r.params_hash || recompute(stripMarker(params)) === r.params_hash); }

    if (shadow) {
      if (!KNOWN_SHADOW_KEYS.has(prodKey)) { fail("unclassified", `shadow ${r.report_key} is not a known Scheduler-v2 report key`); continue; }
      if (!rv) { fail("malformed", `shadow ${prodKey}/${ab(r.account_id)} has no reportVersion`); continue; }
      if (!hashOk) { fail("malformed", `shadow ${prodKey}/${ab(r.account_id)} params_hash recompute mismatch`); continue; }
      const curV = entry && entry.snapshotVersion;
      if (curV && rv === curV) { currentShadowIds.push(r.id); cls.currentShadow += 1; }        // needs exact contract
      else if (!entry && prodKey === "brand-inventory") { if (!readable) { fail("contract-invalid", `shadow brand-inventory/${ab(r.account_id)} has no payload`); continue; } cls.brandInv += 1; }
      else if (rv.startsWith(prodKey + "/")) { if (!readable) { fail("malformed", `legacy shadow ${rv}/${ab(r.account_id)} unreadable payload`); continue; } cls.legacyShadow += 1; note("legacy-shadow", `${rv}/${ab(r.account_id)} (older version; legacy classification)`); }
      else { fail("unclassified", `shadow ${prodKey}/${ab(r.account_id)} unknown reportVersion`); continue; }
    } else {
      // LIVE row: the shadow contract NEVER applies. Classify by the current live-shared version.
      const liveV = LIVE_VERSION[prodKey] || null;
      if (rv && liveV && rv === liveV) {
        // current-published live identity: active. readable + provenance required.
        if (!readable) { fail("contract-invalid", `live ${prodKey}/${ab(r.account_id)} current row has no payload`); continue; }
        if (!hashOk) { fail("malformed", `live ${prodKey}/${ab(r.account_id)} current row params_hash mismatch`); continue; }
        cls.currentLive += 1;
      } else {
        // older/inactive live row: preserve unchanged; readable + (if versioned) provenance as a legacy note.
        if (!readable) { note("legacy-live", `${prodKey}/${ab(r.account_id)} inactive row has no payload`); }
        if (rv && !hashOk) note("legacy-live", `${prodKey}/${ab(r.account_id)}@${rv} params_hash mismatch (inactive)`);
        cls.legacyLive += 1;
      }
    }
  }
  console.log(`CLASSIFY current_shadow=${cls.currentShadow} legacy_shadow=${cls.legacyShadow} brand_inventory=${cls.brandInv} current_live=${cls.currentLive} legacy_live=${cls.legacyLive} hash_recomputed=${hashChecked} rows=${ids.length}`);

  // Bounded hydration: validate ONLY current shadow candidates against the EXACT registered contract.
  let contractPass = 0;
  for (let i = 0; i < currentShadowIds.length; i += BATCH) {
    const chunk = currentShadowIds.slice(i, i + BATCH);
    const rows = (await q("select id, report_key, account_id, params_hash, payload, payload_storage_path from public.report_snapshots where id = any($1::uuid[])", [chunk])).rows;
    for (const r of rows) {
      const prodKey = productionKeyFromShadow(r.report_key);
      const entry = REPORT_DERIVATIONS[prodKey];
      let payload = r.payload;
      if (r.payload_storage_path) { try { payload = await getReportSnapshotStoragePayload(String(r.payload_storage_path)); } catch { fail("malformed", `shadow ${prodKey}/${ab(r.account_id)} storage payload unreadable`); continue; } }
      if (payload == null || entry.validatePayload(payload) !== true) { fail("contract-invalid", `shadow ${prodKey}/${ab(r.account_id)} failed the exact registered ${entry.snapshotVersion} contract`); continue; }
      contractPass += 1;
    }
  }
  console.log(`CONTRACT current_shadow_contract_pass=${contractPass}/${currentShadowIds.length} (exact registered validatePayload)`);

  // ---- (C) lineage: ALL matching jobs for each CURRENT shadow candidate --------------------------------
  try {
    const shadowRows = (await q("select account_id, report_key, params_hash from public.report_snapshots where id = any($1::uuid[])", [currentShadowIds])).rows;
    let lineaged = 0;
    for (const r of shadowRows) {
      const prodKey = productionKeyFromShadow(r.report_key);
      const jobs = (await q("select cycle_id, validated, save_status, derive_status, connection_id, depends_on from public.sync_report_jobs where report_key=$1 and account_id=$2 and snapshot_params_hash=$3", [prodKey, r.account_id, r.params_hash])).rows;
      if (!jobs.length) { fail("unlineaged", `shadow ${prodKey}/${ab(r.account_id)} has no owning sync_report_job`); continue; }
      // require >=1 exact validated success in a terminal cycle, primary connection, ownerless-free deps
      let ok = false;
      for (const job of jobs) {
        if (job.validated !== true || job.save_status !== "succeeded" || job.derive_status !== "succeeded") continue;
        if (job.connection_id !== "primary") continue;
        const cyc = (await q("select status from public.sync_cycles where id=$1", [job.cycle_id])).rows[0];
        if (!cyc || !(cyc.status === "succeeded" || cyc.status === "partial")) continue;
        const dep = (await q("select count(*)::int missing from unnest($1::text[]) h where not exists (select 1 from public.sync_source_job_owners o where o.cycle_id=$2 and o.request_hash=h)", [job.depends_on || [], job.cycle_id])).rows[0];
        if (dep && Number(dep.missing) > 0) continue;
        ok = true; break;
      }
      if (ok) lineaged += 1; else fail("unlineaged", `shadow ${prodKey}/${ab(r.account_id)} has ${jobs.length} job(s) but none is a validated terminal-cycle primary success with coherent owners`);
    }
    console.log(`LINEAGE current_shadow_with_validated_terminal_lineage=${lineaged}/${shadowRows.length}`);
  } catch (e) { fail("runner-C1", `lineage error name=${e && e.name} code=${e && e.code} (message suppressed)`); }

  // ---- (C) approved live<-shadow promotion byte-identity audit (server-side md5; evidence only) ---------
  try {
    const approvals = APPROVED_INVARIANTS.approvalRows || [];
    const rep = [];
    for (const a of approvals) {
      const K = a.report_key, A = a.account_id;
      const liveV = LIVE_VERSION[K];
      // The best validated terminal shadow candidate for (K,A): newest validated+succeeded job's snapshot.
      const cand = (await q(
        `select s.params_hash, md5(s.payload::text) sh from public.report_snapshots s
           join public.sync_report_jobs j on j.report_key=$1 and j.account_id=$2 and j.snapshot_params_hash=s.params_hash
           join public.sync_cycles c on c.id=j.cycle_id
          where s.report_key=$3 and s.account_id=$2 and j.validated=true and j.save_status='succeeded'
                and j.derive_status='succeeded' and j.connection_id='primary' and c.status in ('succeeded','partial')
                and s.payload is not null
          order by s.updated_at desc nulls last limit 1`,
        [K, A, shadowSnapshotKey(K)],
      )).rows[0];
      // The current-published live row for (K,A) on the live-shared version.
      const live = (await q(
        `select md5(payload::text) lh from public.report_snapshots
          where report_key=$1 and account_id=$2 and params->>'reportVersion'=$3 and payload is not null
          order by updated_at desc nulls last limit 1`,
        [K, A, liveV],
      )).rows[0];
      const state = !cand ? "no-validated-shadow-candidate"
        : !live ? "no-current-live-row(legacy-absent)"
        : (cand.sh === live.lh ? "byte-identical" : "differs(legacy-live-not-yet-promoted)");
      rep.push(`${K}/${ab(A)}=${state}`);
    }
    console.log(`PROMO-AUDIT (approved report/account; server-side md5): ${rep.join("  ")}`);
  } catch (e) { fail("runner-C2", `promo-audit error name=${e && e.name} code=${e && e.code} (message suppressed)`); }

  // ---- (D) all pinned production invariants, in the SAME snapshot ---------------------------------------
  try {
    const inv = [...await verifyLedgerForStage(q, 0), ...await verifyStageObjects(q, 0), ...await verifyApprovedInvariants(q, APPROVED_INVARIANTS)];
    console.log(`INVARIANTS ${inv.length === 0 ? "ALL PASS" : inv.length + " FAIL"}`);
    for (const p of inv) { console.log("  - " + p); fail("invariant", p); }
  } catch (e) { fail("runner-D", `invariants error name=${e && e.name} code=${e && e.code} (message suppressed)`); }

  // ---- (E) candidate manifest pins (runbook algorithm, server-side) for all 8 datasets -----------------
  try {
    const dig = await captureProtectedDigest(q);
    console.log("\nCANDIDATE MANIFEST PINS (server-side runbook algorithm; pin ONLY on RECONCILED PASS):");
    for (const k of PROTECTED_DIGEST_KEYS) console.log(`  ${k}: { c: ${dig[k].c}, h: "${dig[k].h}" },`);
  } catch (e) { fail("runner-E", `digest error name=${e && e.name} code=${e && e.code} (message suppressed)`); }
} catch (e) {
  fail("runner", `error name=${e && e.name} code=${e && e.code} (message suppressed)`);
} finally {
  try { await client.query("ROLLBACK"); } catch {}
  await client.end();
}

if (legacyNotes.length) { console.log(`\nLEGACY NOTES (${legacyNotes.length}; historical rows -- preserved unchanged, not auto-pinnable):`); for (const n of legacyNotes.slice(0, 40)) console.log("  - " + n); }
console.log("\nVERDICT " + (failures.length === 0
  ? (legacyNotes.length === 0 ? "RECONCILED PASS -- every active row, lineage, and invariant passed; printed pins may be committed." : "RECONCILED PASS (active) with LEGACY NOTES -- active state is clean; legacy anomalies listed above must be human-reviewed before pinning.")
  : `STOP -- ${failures.length} active issue(s); DO NOT change any pin:`));
for (const f of failures.slice(0, 40)) console.log("  - " + f);
process.exit(failures.length === 0 ? 0 : 1);
