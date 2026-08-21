// Ledger/stage + pinned control-state invariants + protected digests (runbook algorithm) + manifest-pinned
// baseline + phase-tracked applier + validate-before-connect runner. Pure over injected q/client; testable.

import { MIGRATIONS, NEW6, BASELINE, BASELINE_VERSION, APPROVED_IDENTITY, PROTECTED_DIGESTS, PROTECTED_DIGEST_KEYS, ALTERED_TABLE_PROJECTIONS, validateIdentity, verifyMigrationPresent, verifyMigrationAbsent } from "./release-manifest.mjs";

async function rows(q, text, params) { const r = await q(text, params || []); return r && r.rows ? r.rows : []; }
async function one(q, text, params) { const r = await rows(q, text, params); return r[0] || null; }
const setEq = (a, b) => { const A = [...new Set(a)].sort(), B = [...new Set(b)].sort(); return A.length === B.length && A.every((v, i) => v === B[i]); };
function cmpExactRows(label, got, want) {
  const s = (a) => a.map((x) => JSON.stringify(x)).sort();
  const g = s(got), w = s(want);
  if (g.length !== w.length || !g.every((v, i) => v === w[i])) return [`${label} EXACT-SET mismatch: got ${JSON.stringify(g)} != approved ${JSON.stringify(w)}`];
  return [];
}

export async function verifyLedgerForStage(q, stage) {
  const P = [];
  const led = await rows(q, "select filename, count(*)::int c from public.app_schema_migrations group by filename");
  const counts = new Map(led.map((r) => [r.filename, Number(r.c)]));
  for (const [f, c] of counts) if (c !== 1) P.push(`ledger ${f} recorded ${c} times (duplicate)`);
  const expected = [...BASELINE, ...NEW6.slice(0, stage)];
  if (!setEq([...counts.keys()], expected)) {
    const extra = [...counts.keys()].filter((f) => !expected.includes(f));
    const missing = expected.filter((f) => !counts.has(f));
    if (extra.length) P.push(`ledger unexpected filename(s): ${extra.sort().join(",")}`);
    if (missing.length) P.push(`ledger missing: ${missing.sort().join(",")}`);
  }
  return P;
}

export async function verifyStageObjects(q, stage) {
  const P = [];
  for (let i = 0; i < MIGRATIONS.length; i++) {
    if (i < stage) P.push(...(await verifyMigrationPresent(q, MIGRATIONS[i])).map((m) => `[applied ${NEW6[i]}] ${m}`));
    else P.push(...(await verifyMigrationAbsent(q, MIGRATIONS[i])).map((m) => `[unapplied ${NEW6[i]}] ${m}`));
  }
  return P;
}

// Blocker 3: dfca8f75 durable child state (source + report jobs), queried by the uniquely-matched cycle id.
async function verifyDfcaChildren(q, cid, ch) {
  const P = [];
  const src = await rows(q, "select fetch_status, count(*)::int c from public.sync_source_jobs where cycle_id=$1 group by fetch_status", [cid]);
  const byStatus = Object.fromEntries(src.map((r) => [r.fetch_status, Number(r.c)]));
  const total = src.reduce((a, r) => a + Number(r.c), 0);
  if (total !== ch.source.total) P.push(`dfca source jobs total ${total} != ${ch.source.total}`);
  for (const [st, want] of Object.entries(ch.source.byStatus)) if ((byStatus[st] || 0) !== want) P.push(`dfca source ${st}=${byStatus[st] || 0} != ${want}`);
  for (const st of Object.keys(byStatus)) if (!(st in ch.source.byStatus) && byStatus[st] > 0) P.push(`dfca source unexpected status ${st}=${byStatus[st]}`);
  const cx = await one(q, "select coalesce(max(create_export_count),0)::int mx, count(*) filter (where create_export_count>1)::int over1 from public.sync_source_jobs where cycle_id=$1", [cid]);
  if (cx && Number(cx.mx) !== ch.source.maxCreateExport) P.push(`dfca max create_export_count ${cx.mx} != ${ch.source.maxCreateExport}`);
  if (cx && Number(cx.over1) !== ch.source.overCreateCount) P.push(`dfca source create_export_count>1 count ${cx.over1} != ${ch.source.overCreateCount}`);
  const rep = await one(q, "select count(*)::int total, count(*) filter (where derive_status='pending' and save_status='pending')::int pp from public.sync_report_jobs where cycle_id=$1", [cid]);
  if (rep && Number(rep.total) !== ch.report.total) P.push(`dfca report jobs total ${rep.total} != ${ch.report.total}`);
  if (rep && Number(rep.pp) !== ch.report.pendingPending) P.push(`dfca report jobs pending/pending ${rep.pp} != ${ch.report.pendingPending}`);
  return P;
}

// Blocker 3 + 5: the PINNED production control state, verified exactly. cron is the TOTAL count. Null pins are
// fail-closed. No arbitrary current state is ever blessed.
export async function verifyApprovedInvariants(q, approved) {
  const P = [];
  for (const t of ["scheduler_account_rollout", "scheduler_rollout_mode", "scheduler_publish_approvals", "report_sync_settings", "sync_cycles", "sync_source_jobs", "sync_report_jobs"]) {
    const r = await one(q, "select to_regclass($1) r", [`public.${t}`]);
    if (!(r && r.r)) P.push(`control object public.${t} absent`);
  }
  for (const k of ["rolloutRows", "approvalRows", "reportSyncSettings", "dfca8f75", "dfca8f75Children"]) if (approved[k] == null) P.push(`APPROVED_INVARIANTS.${k} not pinned (fail-closed)`);
  const mode = await one(q, "select all_primary from public.scheduler_rollout_mode where id=1");
  if (!mode) P.push("scheduler_rollout_mode id=1 missing");
  else if (mode.all_primary !== approved.allPrimary) P.push(`all_primary ${JSON.stringify(mode.all_primary)} != approved ${approved.allPrimary}`);
  const cronReg = await one(q, "select to_regclass('cron.job') r");
  if (cronReg && cronReg.r) { const c = await one(q, "select count(*)::int c from cron.job"); if (c && Number(c.c) !== approved.cronJobsTotal) P.push(`cron.job total ${c.c} != approved ${approved.cronJobsTotal}`); }
  if (approved.rolloutRows) { const r = await rows(q, "select account_id, enabled from public.scheduler_account_rollout"); P.push(...cmpExactRows("rollout", r.map((x) => ({ account_id: x.account_id, enabled: x.enabled })), approved.rolloutRows)); }
  if (approved.approvalRows) { const r = await rows(q, "select account_id, report_key, approved from public.scheduler_publish_approvals"); P.push(...cmpExactRows("approvals", r.map((x) => ({ account_id: x.account_id, report_key: x.report_key, approved: x.approved })), approved.approvalRows)); }
  if (approved.reportSyncSettings) { const r = await rows(q, "select report_key, schedule_enabled from public.report_sync_settings"); P.push(...cmpExactRows("report_sync_settings", r.map((x) => ({ report_key: x.report_key, schedule_enabled: x.schedule_enabled })), approved.reportSyncSettings)); }
  if (approved.dfca8f75) {
    const idr = await rows(q, "select id from public.sync_cycles where id::text like 'dfca8f75%'");
    if (idr.length !== 1) P.push(`dfca8f75 prefix matched ${idr.length} cycles (want exactly 1)`);
    else {
      const cid = idr[0].id;
      const d = await one(q, "select status, source_total::int st, source_succeeded::int ss, source_failed::int sf, report_total::int rt, report_succeeded::int rs, report_failed::int rf, finished_at from public.sync_cycles where id=$1", [cid]);
      const got = { status: d.status, source_total: Number(d.st), source_succeeded: Number(d.ss), source_failed: Number(d.sf), report_total: Number(d.rt), report_succeeded: Number(d.rs), report_failed: Number(d.rf), finished_at: d.finished_at == null ? null : String(d.finished_at) };
      if (JSON.stringify(got) !== JSON.stringify(approved.dfca8f75)) P.push(`dfca8f75 cycle ${JSON.stringify(got)} != approved ${JSON.stringify(approved.dfca8f75)}`);
      if (approved.dfca8f75Children) P.push(...await verifyDfcaChildren(q, cid, approved.dfca8f75Children));
    }
  }
  return P;
}

// ---- protected digests: the RUNBOOK (Appendix W) algorithm  md5(string_agg(md5(row::text), ',' ORDER BY
// natural_key)). Payload-free server-side md5 output only. ------------------------------------------------
async function digestHist(q, table, { where, orderKey, rh } = {}) {
  const reg = await one(q, "select to_regclass($1) r", [`public.${table}`]);
  if (!(reg && reg.r)) return { present: false, h: "MISSING", c: -1 };
  const rhExpr = rh || "md5(t::text)";
  const r = await one(q, `select coalesce(md5(string_agg(${rhExpr}, ',' order by ${orderKey})), 'EMPTY') h, count(*)::int c from public.${table} t${where ? " where " + where : ""}`);
  return { present: true, h: r ? r.h : "ERR", c: r ? Number(r.c) : -1 };
}
const NK_SNAP = "(report_key || '/' || account_id || '/' || params_hash)";
export async function captureProtectedDigest(q) {
  const excl = ALTERED_TABLE_PROJECTIONS.sync_report_jobs.map((c) => ` - '${c}'`).join("");
  return {
    live_snapshots: await digestHist(q, "report_snapshots", { where: "report_key not like 'scheduler-v2/%'", orderKey: NK_SNAP }),
    shadow_snapshots: await digestHist(q, "report_snapshots", { where: "report_key like 'scheduler-v2/%'", orderKey: NK_SNAP }),
    rollout: await digestHist(q, "scheduler_account_rollout", { orderKey: "account_id" }),
    mode: await digestHist(q, "scheduler_rollout_mode", { orderKey: "id::text" }),
    approvals: await digestHist(q, "scheduler_publish_approvals", { orderKey: "(report_key || '/' || account_id)" }),
    settings: await digestHist(q, "report_sync_settings", { orderKey: "report_key" }),
    sync_cycles: await digestHist(q, "sync_cycles", { orderKey: "id::text" }),
    report_jobs: await digestHist(q, "sync_report_jobs", { orderKey: "(cycle_id::text || '/' || report_key || '/' || account_id)", rh: `md5((to_jsonb(t)${excl})::text)` }),
  };
}
export function compareProtectedDigest(baseline, current) {
  const P = [];
  for (const k of new Set([...Object.keys(baseline || {}), ...Object.keys(current || {})])) {
    const b = baseline[k], c = current[k];
    if (!b || !c) { P.push(`protected digest ${k} appeared/disappeared`); continue; }
    if (b.h !== c.h || b.c !== c.c) P.push(`protected data drift in ${k}: count ${b.c}->${c.c} hash ${String(b.h).slice(0, 8)}->${String(c.h).slice(0, 8)}`);
  }
  return P;
}
// Blocker 2: the observed stage-0 digest MUST equal the manifest pin for EVERY protected key (fail-closed on
// any unpinned key). Rejects missing/extra observed keys.
export function requirePinnedStage0Digest(observed, pins = PROTECTED_DIGESTS) {
  const P = [];
  for (const k of PROTECTED_DIGEST_KEYS) {
    const pin = pins[k];
    if (pin == null) { P.push(`digest ${k} not pinned in the manifest (awaits the read-only diagnostic)`); continue; }
    const o = observed[k];
    if (!o) P.push(`digest ${k} not observed`);
    else if (o.c !== pin.c || o.h !== pin.h) P.push(`stage-0 ${k} observed {c:${o.c},h:${String(o.h).slice(0, 8)}} != pinned {c:${pin.c},h:${pin.h.slice(0, 8)}}`);
  }
  const extra = Object.keys(observed).filter((k) => !PROTECTED_DIGEST_KEYS.includes(k));
  if (extra.length) P.push(`observed digest has unexpected keys: ${extra.join(",")}`);
  return P;
}

export async function beginReadOnlySnapshot(client) { await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); }

// ---- manifest-pinned baseline (blocker 2; not a cryptographic signature) --------------------------------
export function buildBaseline({ head, fingerprint, pins = PROTECTED_DIGESTS }) {
  return {
    version: BASELINE_VERSION, projectRef: APPROVED_IDENTITY.projectRef, head, manifestFingerprint: fingerprint,
    migrationHashes: Object.fromEntries(MIGRATIONS.map((m) => [m.file, m.sha])), stage: 0,
    protectedDigest: Object.fromEntries(PROTECTED_DIGEST_KEYS.map((k) => [k, pins[k]])), // manifest-pinned values ONLY
  };
}
export function validateBaseline(baseline, { currentHead, currentFingerprint, envRef, pins = PROTECTED_DIGESTS } = {}) {
  const P = [];
  if (!baseline || typeof baseline !== "object") return ["baseline malformed (not an object)"];
  if (baseline.version !== BASELINE_VERSION) P.push(`baseline version ${baseline.version} != ${BASELINE_VERSION}`);
  if (baseline.projectRef !== APPROVED_IDENTITY.projectRef) P.push(`baseline projectRef ${baseline.projectRef} != approved`);
  if (envRef != null && baseline.projectRef !== envRef) P.push(`baseline projectRef != current env ref ${envRef} (environment switched)`);
  if (baseline.head !== currentHead) P.push(`baseline HEAD ${baseline.head} != current HEAD ${currentHead}`);
  if (baseline.manifestFingerprint !== currentFingerprint) P.push("baseline manifest fingerprint stale");
  if (baseline.stage !== 0) P.push(`baseline stage ${baseline.stage} != 0`);
  if (JSON.stringify(baseline.migrationHashes) !== JSON.stringify(Object.fromEntries(MIGRATIONS.map((m) => [m.file, m.sha])))) P.push("baseline migration hashes differ from the manifest");
  const pd = baseline.protectedDigest;
  if (!pd || typeof pd !== "object") { P.push("baseline protectedDigest malformed"); return P; }
  if (!setEq(Object.keys(pd), PROTECTED_DIGEST_KEYS)) P.push(`baseline digest key set {${Object.keys(pd).sort()}} != required {${[...PROTECTED_DIGEST_KEYS].sort()}}`);
  for (const k of PROTECTED_DIGEST_KEYS) {
    const pin = pins[k], b = pd[k];
    if (pin == null) { P.push(`digest ${k} not pinned in the manifest (awaits the read-only diagnostic)`); continue; }
    if (!b || b.c !== pin.c || b.h !== pin.h) P.push(`baseline ${k} {c:${b && b.c},h:${b && String(b.h).slice(0, 8)}} != manifest pin {c:${pin.c},h:${pin.h.slice(0, 8)}}`);
  }
  return P;
}

export function shouldCreateBaseline({ stage, problemCount, rolledBack }) { return stage === 0 && problemCount === 0 && rolledBack === true; }

// ---- phase-tracked applier core (COMMIT_UNKNOWN unchanged) ----------------------------------------------
export async function applyInTransaction(ctx) {
  const {
    client, mig, stageIdx, sql, baseline, currentHead, currentFingerprint, envRef, approved,
    _validate = validateBaseline, _ledger = verifyLedgerForStage, _invariants = verifyApprovedInvariants,
    _objects = verifyStageObjects, _present = verifyMigrationPresent, _capture = captureProtectedDigest, _compare = compareProtectedDigest,
  } = ctx;
  const q = (t, p) => client.query(t, p);
  let phase = "init";
  try {
    const bp = _validate(baseline, { currentHead, currentFingerprint, envRef });
    if (bp.length) throw new Error("baseline invalid:\n  - " + bp.join("\n  - "));
    phase = "begun"; await q("BEGIN");
    phase = "locked"; await q("select pg_advisory_xact_lock($1::int, $2::int)", mig.adv);
    const pre = [];
    pre.push(...await _ledger(q, stageIdx));
    pre.push(...await _invariants(q, approved));
    pre.push(...await _objects(q, stageIdx));
    const d0 = await _capture(q);
    pre.push(..._compare(baseline.protectedDigest, d0).map((m) => "baseline " + m));
    if (pre.length) throw new Error(`stage ${stageIdx} preconditions failed:\n  - ` + pre.join("\n  - "));
    phase = "prechecked";
    await q(sql); phase = "executed";
    const man = await _present(q, mig);
    if (man.length) throw new Error("manifest verification failed:\n  - " + man.join("\n  - "));
    phase = "verified";
    const d1 = await _capture(q);
    const drift = [..._compare(d0, d1), ..._compare(baseline.protectedDigest, d1)];
    if (drift.length) throw new Error("protected data-plane drift:\n  - " + drift.join("\n  - "));
    phase = "digest-checked";
    await q("insert into public.app_schema_migrations (filename) values ($1)", [mig.file]);
    const cnt = await q("select count(*)::int c from public.app_schema_migrations where filename=$1", [mig.file]);
    if (Number(cnt.rows[0].c) !== 1) throw new Error(`ledger count ${cnt.rows[0].c} != 1`);
    phase = "ledger-inserted";
    phase = "committing";
    await q("COMMIT");
    phase = "committed";
    return { code: 0, phase, message: `COMMITTED ${mig.file} (stage ${stageIdx} -> ${stageIdx + 1})` };
  } catch (e) {
    if (phase === "committing") return { code: 3, phase, message: `COMMIT_UNKNOWN for ${mig.file}: ${e.message}. Run \`node scripts/release/ro-prod-check.mjs ${stageIdx + 1}\` to determine the true state; DO NOT re-run the applier.` };
    try { await q("ROLLBACK"); } catch {}
    return { code: 1, phase, message: `ROLLBACK ${mig.file} at phase '${phase}': ${e.message}` };
  }
}

// Blocker 1: every validation completes BEFORE makeClient() -- a malformed/edited baseline yields ZERO connect.
export async function runApply(deps) {
  const { filename, sqlText, actualSha, env, currentHead, currentFingerprint, envRef, baselineText, makeClient, approved, _validate = validateBaseline } = deps;
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) return { code: 1, connected: false, message: `rejected path/filename: ${filename}` };
  const stageIdx = NEW6.indexOf(filename);
  if (stageIdx < 0) return { code: 1, connected: false, message: `${filename} is not one of the six frozen migrations` };
  const mig = MIGRATIONS[stageIdx];
  if (actualSha !== mig.sha) return { code: 1, connected: false, message: `sha256 mismatch for ${filename}` };
  const id = validateIdentity(env);
  if (!id.ok) return { code: 1, connected: false, message: "identity: " + id.problems.join("; ") };
  let baseline;
  try { baseline = JSON.parse(baselineText); } catch { return { code: 1, connected: false, message: "baseline malformed JSON" }; }
  const bp = _validate(baseline, { currentHead, currentFingerprint, envRef });
  if (bp.length) return { code: 1, connected: false, message: "baseline invalid: " + bp.join("; ") };
  const client = makeClient();
  let connected = false;
  try {
    await client.connect(); connected = true;
    const r = await applyInTransaction({ client, mig, stageIdx, sql: sqlText, baseline, currentHead, currentFingerprint, envRef, approved });
    return { ...r, connected };
  } catch (e) { return { code: 1, connected, message: "connect/apply error: " + e.message }; }
  finally { try { await client.end(); } catch {} }
}
