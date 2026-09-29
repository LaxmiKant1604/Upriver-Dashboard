// Publication recovery worker -- IN-MEMORY store (tests + the synthetic memory/throughput check ONLY; never used by the
// production entrypoint). It mirrors the 20260934 RPC semantics rule-for-rule (route FK + owner bound on enqueue,
// coherent route/region/as-of claims, the evaluatedToken re-arm, state recorded on every evaluated finish, the tier-1 /
// deep scan slots) and decides the global scheduler gate, the upstream blockers and the durable directory through the
// SAME pure functions the Postgres store uses (store-pg.js). scripts/worker/publication-recovery-sql-selftest.mjs runs
// the same scenarios against the real SQL (PGlite) to prove the two agree.

import { PUBLICATION_ROUTES } from "./routes.js";
import { evaluateSchedulerGate, upstreamBlockersFrom, buildWorkerDirectory, likeToRegExp } from "./store-pg.js";

const S = (v) => (v == null ? "" : String(v));
const LIVE = new Set(["pending", "claimed", "deferred"]);
const OWNER_RE = /^[A-Za-z0-9._-]{1,120}$/;
const TARGET_RE = /^[A-Za-z0-9._:-]{1,160}$/;
let seq = 0;

/**
 * control: { enabled, routes: { [routeId]: { liveEnabled, liveRegions } } } (default: enabled, every route live in every
 * region -- tests narrow it). env.* are the fake "database" the read methods consult.
 */
export function createMemoryStore({ clock = () => Date.now(), control = null, routes = PUBLICATION_ROUTES } = {}) {
  const routeRows = new Map(routes.map((r) => [r.id, { grain: r.grain }]));
  const ctl = control || { enabled: true, routes: Object.fromEntries(routes.map((r) => [r.id, { liveEnabled: true, liveRegions: ["india", "europe-au", "us-ca"] }])) };
  const jobs = [];
  const state = new Map(); // route|region|target|asOf -> row
  const observations = new Map();
  const workers = new Map();
  const scanRow = { holder: null, leaseExpiresAt: null, lastStartedAt: null, lastFinishedAt: null, lastOutcome: null, lastSummary: {}, lastTier1At: null, tier1Summary: {}, deepSweep: {} };
  // The fake database behind the READ methods.
  const env = {
    directoryAccounts: [],                // the account-directory payload.accounts (buildWorkerDirectory folds it)
    evidence: new Map(),                  // 'route|region' -> Map | (ctx) => Map   (the route's compose result)
    cycles: [],                           // sync_cycles facts: { bucket, status, cycle_date, started_ms, updated_ms, report_jobs, ... }
    liveRows: [],                         // report_snapshots metadata: { report_key, account_id, params, updated_ms }
    lease: { held: false, operationKey: "", expiresAt: null },
    fence: { state: "absent" },
    reportKeys: [],
    failReads: new Set(),                 // method names that throw (transport failure injection)
  };
  const calls = { enqueue: 0, claim: 0, finish: 0, evidence: 0, gate: 0, blockers: 0, liveWrites: 0 };
  const now = () => clock();
  const k = (r, g, t, d) => `${r}|${g}|${t}|${d}`;
  const liveJob = (r, g, t, d) => jobs.find((j) => j.route_id === r && j.region === g && j.target_key === t && j.requested_as_of === d && LIVE.has(j.status));
  const ready = (j) => ((j.status === "pending" || j.status === "deferred") && j.next_attempt_at <= now()) || (j.status === "claimed" && j.lease_expires_at < now());
  const clearClaim = (j) => { j.claim_token = null; j.claimed_by = null; j.lease_expires_at = null; };
  const failIf = (name) => { if (env.failReads.has(name)) { const e = new Error(name + " failed"); e.code = "ECONNRESET"; throw e; } };
  const upsertState = (key, base, patch) => {
    const prev = state.get(key) || { ...base, verified_token: null, observed_token: null, verified_at: null, verified_rows: [], last_class: null, class_since: now() };
    const cls = patch.last_class !== undefined ? patch.last_class : prev.last_class;
    state.set(key, { ...prev, ...patch, class_since: prev.last_class !== cls ? now() : prev.class_since, observed_at: now() });
  };
  // The SERVED proof a (re-)verification records (the 20260934 STICKY-REVOCATION rule, mirrored): an explicit positive
  // proof (a route CLI's unit-level served read-back) always stands; a REPUBLISH by this worker resets the proof to what
  // it proved (null for a legacy family: tier-1 re-checks against the new verification instant); otherwise a tier-1
  // REVOCATION (false) of the SAME verified token survives the re-verification (only a NEW token clears it).
  const verifiedServed = (prev, token, served, published = false) => {
    if (served === true) return true;
    if (!published && prev && prev.served_confirmed === false && prev.verified_token != null && prev.verified_token === token) return false;
    return served == null ? null : !!served;
  };

  const store = {
    env, jobs, state, observations, workers, scanRow, calls, controlRow: ctl,
    async control() { failIf("control"); return { enabled: !!ctl.enabled, routes: JSON.parse(JSON.stringify(ctl.routes || {})) }; },
    async enqueue({ route, region, targetKey, owners = [], asOf, token, origin, priority = 5 }) {
      calls.enqueue += 1;
      failIf("enqueue");
      const rr = routeRows.get(route);
      if (!rr) throw new Error(`enqueue_publication_recovery_job: unknown route ${S(route).slice(0, 60)} (fail closed)`);
      const own = Array.isArray(owners) ? owners : [];
      if (own.length > 128) throw new Error("enqueue_publication_recovery_job: owners exceed the 128 bound (fail closed)");
      if (own.some((o) => !OWNER_RE.test(S(o)))) throw new Error("enqueue_publication_recovery_job: a malformed owner account id (fail closed)");
      if (!TARGET_RE.test(S(targetKey))) throw new Error("target_key check violation");
      if (rr.grain === "region" && targetKey !== "region:" + region) throw new Error("enqueue_publication_recovery_job: a region-grain target must be region:<region> (fail closed)");
      if (rr.grain === "account" && !OWNER_RE.test(S(targetKey))) throw new Error("enqueue_publication_recovery_job: an account-grain target must be a canonical account id (fail closed)");
      if (!["watermark", "scan", "deep-scan", "dependency", "manual"].includes(origin)) throw new Error("origin check violation");
      const lj = liveJob(route, region, targetKey, asOf);
      if (lj) {
        if (token != null && lj.evidence_token !== token) {
          lj.evidence_token = token;
          if (own.length) lj.owner_account_ids = [...own];
          if (lj.status === "deferred") { lj.status = "pending"; lj.next_attempt_at = now(); }
          lj.priority = Math.min(lj.priority, priority);
          lj.updated_at = now();
          return "refreshed";
        }
        return "exists";
      }
      if (origin === "watermark" && token != null) {
        const st = state.get(k(route, region, targetKey, asOf));
        if (st && st.verified_token != null && st.verified_token === token) return "already-verified";
      }
      if (jobs.some((j) => j.route_id === route && j.region === region && j.target_key === targetKey && j.requested_as_of === asOf && j.status === "dead" && S(j.evidence_token) === S(token) && (j.evidence_token == null) === (token == null))) return "dead-same-evidence";
      jobs.push({ id: `job-${++seq}`, route_id: route, region, target_key: targetKey, owner_account_ids: [...own], requested_as_of: asOf, evidence_token: token ?? null, origin, status: "pending", priority, attempts: 0, claims: 0, claim_token: null, claimed_by: null, claimed_at: null, lease_expires_at: null, next_attempt_at: now(), created_at: now() + (seq / 1e6), created_ms: now(), updated_at: now(), last_class: null, last_reason: null, last_alert: null, published: false, verified_at: null });
      return "enqueued";
    },
    async claim({ workerId, claimToken, limit = 5, leaseSeconds = 1500, maxClaims = 8 }) {
      calls.claim += 1;
      failIf("claim");
      const lease = Math.max(120, Math.min(leaseSeconds, 7200)) * 1000;
      const max = Math.max(2, Math.min(maxClaims, 50));
      for (const j of jobs) if (j.status === "claimed" && j.lease_expires_at < now() && j.claims >= max) { j.status = "dead"; j.last_class = "crash-loop"; j.updated_at = now(); clearClaim(j); }
      const cand = jobs.filter(ready).sort((a, b) => a.priority - b.priority || a.next_attempt_at - b.next_attempt_at || a.created_at - b.created_at);
      if (!cand.length) return [];
      const h = cand[0];
      const pick = cand.filter((j) => j.route_id === h.route_id && j.region === h.region && j.requested_as_of === h.requested_as_of).slice(0, Math.max(1, Math.min(limit, 25)));
      for (const j of pick) { j.status = "claimed"; j.claims += 1; j.claim_token = claimToken; j.claimed_by = workerId; j.claimed_at = now(); j.lease_expires_at = now() + lease; j.updated_at = now(); }
      return pick.map((j) => ({ ...j, owner_account_ids: [...j.owner_account_ids] }));
    },
    async renewClaim({ ids, claimToken, leaseSeconds = 1500 }) {
      let n = 0;
      for (const j of jobs) if (ids.includes(j.id) && j.status === "claimed" && j.claim_token === claimToken) { j.lease_expires_at = now() + Math.max(120, Math.min(leaseSeconds, 7200)) * 1000; n += 1; }
      return n;
    },
    async finish({ id, claimToken, outcome, cls, reason, backoff = 60, maxAttempts = 6, runToken = null, evaluatedToken = null, verifiedRows = null, alert = null, published = false, handoff = null, recordState = true, servedConfirmed = null, maxRearms = 12 }) {
      calls.finish += 1;
      failIf("finish");
      const j = jobs.find((x) => x.id === id);
      if (!j) return "not-found";
      if (j.status !== "claimed" || j.claim_token !== claimToken) return "not-owner";
      j.updated_at = now();
      let b = Math.max(0, Math.min(backoff || 0, 86400)) * 1000;
      const max = Math.max(1, Math.min(maxAttempts, 50));
      const maxRe = Math.max(1, Math.min(Number(maxRearms) || 12, 1000));
      j.rearms = j.rearms || 0;
      if (["verified", "retry", "deferred", "dead"].includes(outcome) && j.evidence_token != null && evaluatedToken !== j.evidence_token) {
        const bound = j.rearms + 1 >= maxRe;
        j.status = "pending"; j.rearms += 1; j.next_attempt_at = now() + (bound ? 600000 : 0); j.attempts = 0; j.claims = 0; clearClaim(j); j.last_class = "evidence-advanced"; if (bound) j.last_alert = "evidence-rearm-bound"; if (runToken) j.last_run_token = runToken; return "re-armed";
      }
      const vClass = S(cls || outcome).slice(0, 64);
      let vAlert = alert == null ? null : S(alert).slice(0, 120);
      if (outcome === "deferred" && vClass === "evidence-advanced") { if (j.rearms + 1 >= maxRe) { vAlert = vAlert || "evidence-rearm-bound"; b = Math.max(b, 600000); } j.rearms += 1; }
      j.last_class = vClass; j.last_reason = reason == null ? null : S(reason).slice(0, 240); j.last_alert = vAlert; if (runToken) j.last_run_token = runToken;
      if (outcome !== "released") j.claims = 0;
      const key = k(j.route_id, j.region, j.target_key, j.requested_as_of);
      const base = { route_id: j.route_id, region: j.region, target_key: j.target_key, requested_as_of: j.requested_as_of };
      const recordEval = (c, h) => { if (recordState !== false) upsertState(key, base, { owner_account_ids: [...j.owner_account_ids], observed_token: j.evidence_token, last_class: c, last_reason: j.last_reason, last_alert: j.last_alert, handoff: h }); };
      if (outcome === "verified") {
        j.status = "verified"; j.verified_at = now(); j.published = !!published; clearClaim(j);
        const served = verifiedServed(state.get(key), j.evidence_token, servedConfirmed, !!published);
        upsertState(key, base, { owner_account_ids: [...j.owner_account_ids], verified_token: j.evidence_token, observed_token: j.evidence_token, verified_at: now(), verified_ms: now(), verified_rows: Array.isArray(verifiedRows) ? verifiedRows : [], last_class: vClass, last_reason: j.last_reason, last_alert: j.last_alert, handoff: handoff || (published ? "repaired" : "already-current"), served_confirmed: served });
        return "verified";
      }
      if (outcome === "retry") {
        if (j.attempts + 1 >= max) { j.attempts += 1; j.status = "dead"; j.last_class = "max-attempts:" + S(cls).slice(0, 50); clearClaim(j); recordEval(j.last_class, handoff || "failed"); return "dead"; }
        j.attempts += 1; j.status = "pending"; j.next_attempt_at = now() + b; clearClaim(j); recordEval(vClass, handoff); return "retry";
      }
      if (outcome === "deferred") { j.status = "deferred"; j.next_attempt_at = now() + b; clearClaim(j); recordEval(vClass, handoff); return "deferred"; }
      if (outcome === "released") { j.status = "pending"; j.claims = Math.max(0, j.claims - 1); j.next_attempt_at = now(); j.last_class = "released"; clearClaim(j); return "released"; }
      if (outcome === "dead") { j.status = "dead"; clearClaim(j); recordEval(vClass, handoff); return "dead"; }
      if (outcome === "superseded") { j.status = "superseded"; clearClaim(j); return "superseded"; }
      throw new Error("unknown outcome " + outcome);
    },
    async recordBaseline(rows) {
      failIf("recordBaseline");
      for (const r of rows) {
        const key = k(r.route_id, r.region, r.target_key, r.requested_as_of);
        // The tier-1 served confirmation / revocation: only on the verification it evaluated (r.token, when sent); a
        // revocation is STICKY -- 'true' never overwrites 'false' for the same verified token.
        if (r.kind === "served") {
          const s = state.get(key);
          if (s && s.verified_token != null && (r.token == null || s.verified_token === r.token)) {
            if (r.served_confirmed === false) s.served_confirmed = false;
            else if (r.served_confirmed === true && s.served_confirmed !== false) s.served_confirmed = true;
          }
          continue;
        }
        const cur = r.class === "current";
        const prev = state.get(key);
        upsertState(key, { route_id: r.route_id, region: r.region, target_key: r.target_key, requested_as_of: r.requested_as_of }, {
          owner_account_ids: Array.isArray(r.owners) ? [...r.owners] : [],
          verified_token: cur ? (r.token || null) : (prev ? prev.verified_token : null),
          verified_at: cur ? now() : (prev ? prev.verified_at : null),
          verified_ms: cur ? now() : (prev ? prev.verified_ms : null),
          verified_rows: cur ? (Array.isArray(r.verified_rows) ? r.verified_rows : []) : (prev ? prev.verified_rows : []),
          observed_token: r.token || null, last_class: r.class, last_reason: r.reason || null, last_alert: r.alert || null, handoff: r.handoff || null,
          served_confirmed: cur ? verifiedServed(prev, r.token || null, typeof r.served_confirmed === "boolean" ? r.served_confirmed : null) : (prev ? prev.served_confirmed ?? null : null),
        });
      }
      return rows.length;
    },
    async recordObservations(rows) {
      failIf("recordObservations");
      for (const r of rows) observations.set(`${r.region}|${r.target_key}|${r.unit_key || "-"}|${r.report_key}|${r.requested_as_of}|${r.route_id}`, { ...r, unit_key: r.unit_key || "-", observed_at: now() });
      return rows.length;
    },
    async beat(b) { failIf("beat"); workers.set(b.workerId, { ...b, last_beat_at: now() }); },
    async tryBeginScan({ holder, leaseSeconds = 3600, minIntervalSeconds = 600, kind = "deep" }) {
      if (kind === "tier1") {
        if (scanRow.lastTier1At != null && scanRow.lastTier1At > now() - Math.max(60, minIntervalSeconds) * 1000) return false;
        scanRow.lastTier1At = now();
        return true;
      }
      const leaseLive = scanRow.holder && scanRow.leaseExpiresAt > now();
      if (leaseLive && scanRow.holder !== holder) return false;
      const staleHolder = scanRow.holder && scanRow.leaseExpiresAt <= now();
      if (scanRow.lastFinishedAt != null && scanRow.lastFinishedAt > now() - Math.max(60, minIntervalSeconds) * 1000 && !staleHolder) return false;
      scanRow.holder = holder; scanRow.leaseExpiresAt = now() + Math.max(300, leaseSeconds) * 1000; scanRow.lastStartedAt = now();
      return true;
    },
    async renewScan({ holder, leaseSeconds = 3600 }) { if (scanRow.holder !== holder) return false; scanRow.leaseExpiresAt = now() + Math.max(300, leaseSeconds) * 1000; return true; },
    async finishScan({ holder, outcome, summary, kind = "deep", deepSweep = null }) {
      if (kind === "tier1") { scanRow.tier1Summary = summary || {}; return true; }
      if (scanRow.holder !== holder) return false;
      scanRow.holder = null; scanRow.leaseExpiresAt = null; scanRow.lastFinishedAt = now(); scanRow.lastOutcome = outcome; scanRow.lastSummary = summary;
      if (deepSweep != null) scanRow.deepSweep = deepSweep;
      return true;
    },
    // Mirrors prune_publication_recovery: keep window clamped to [3, 90] days.
    async prune(keepDays = 14) {
      const cut = now() - Math.max(3, Math.min(Number(keepDays) || 14, 90)) * 86400000;
      let n = 0;
      for (let i = jobs.length - 1; i >= 0; i -= 1) {
        const j = jobs[i];
        if (["verified", "superseded", "dead"].includes(j.status) && (j.updated_at ?? j.created_at) < cut) { jobs.splice(i, 1); n += 1; }
      }
      for (const [key, r] of observations) if (r.observed_at < cut) { observations.delete(key); n += 1; }
      for (const [key, r] of state) if ((r.observed_at ?? 0) < cut) { state.delete(key); n += 1; }
      return n;
    },
    async status() {
      const by = {}; for (const j of jobs) by[j.status] = (by[j.status] || 0) + 1;
      const epoch = [...state.values()].map((s) => s.requested_as_of).sort().pop() || null;
      // Mirrors publication_recovery_status state rows: open_job (a pending / claimed / deferred job exists for the
      // target) and tier1_state (the tier-1 finding, only when recorded AFTER the verification).
      const openJob = (s) => jobs.some((j) => j.route_id === s.route_id && j.region === s.region && j.target_key === s.target_key && j.requested_as_of === s.requested_as_of && LIVE.has(j.status));
      const tier1 = (s) => { const o = observations.get(`${s.region}|${s.target_key}|-|tier-1|${s.requested_as_of}|${s.route_id}`); return o && (s.verified_at == null || o.observed_at > s.verified_at) ? o.state : null; };
      return {
        control: { enabled: !!ctl.enabled }, jobs: { by_status: by, dead_letter: by.dead || 0 }, workers: [...workers.values()],
        scan: { ...scanRow }, state_epoch: epoch, alerts: (scanRow.tier1Summary && scanRow.tier1Summary.alerts) || [],
        state: [...state.values()].filter((s) => s.requested_as_of === epoch).map((s) => ({ route_id: s.route_id, region: s.region, target_key: s.target_key, owner_account_ids: s.owner_account_ids || [], last_class: s.last_class, last_reason: s.last_reason || null, last_alert: s.last_alert || null, handoff: s.handoff || null, served_confirmed: s.served_confirmed ?? null, open_job: openJob(s), tier1_state: tier1(s) })),
      };
    },
    // ---------------- READ-ONLY metadata reads (the fake database) ----------------
    async readDirectory() { failIf("readDirectory"); return buildWorkerDirectory(env.directoryAccounts).directory; },
    async readRouteEvidence(route, ctx) {
      calls.evidence += 1;
      failIf("readRouteEvidence");
      const v = env.evidence.get(`${route.id}|${ctx.region}`);
      const m = typeof v === "function" ? v(ctx) : v;
      return m instanceof Map ? m : new Map();
    },
    async readState({ route, region, epoch }) {
      failIf("readState");
      const out = new Map();
      for (const s of state.values()) if (s.route_id === route && s.region === region && s.requested_as_of === epoch) out.set(s.target_key, { ...s, verified_ms: s.verified_ms ?? null, verified_rows: Array.isArray(s.verified_rows) ? s.verified_rows : [] });
      return out;
    },
    async readLiveRowWritesSince(scopes) {
      calls.liveWrites += 1;
      failIf("readLiveRowWritesSince");
      const out = new Map();
      for (const sc of scopes) {
        const re = sc.accountIdLike != null ? likeToRegExp(sc.accountIdLike) : null;
        for (const row of env.liveRows) {
          if (row.report_key !== sc.reportKey) continue;
          if (sc.accountIdEq != null ? row.account_id !== sc.accountIdEq : !re.test(row.account_id)) continue;
          if (sc.paramsEq && Object.entries(sc.paramsEq).some(([pk, pv]) => S(row.params && row.params[pk]) !== S(pv))) continue;
          const prev = out.get(sc.key);
          if (!prev || row.updated_ms > prev.maxMs) out.set(sc.key, { maxMs: row.updated_ms });
        }
      }
      return out;
    },
    async readUpstreamBlockers({ awaits, region, owners = null, epoch }) {
      calls.blockers += 1;
      failIf("readUpstreamBlockers");
      const aw = new Set(awaits || []);
      const openJobs = jobs.filter((j) => aw.has(j.route_id) && j.region === region && j.requested_as_of === epoch && LIVE.has(j.status)).map((j) => ({ ...j }));
      const states = [...state.values()].filter((s) => aw.has(s.route_id) && s.region === region && s.requested_as_of === epoch && s.last_class === "stale");
      return upstreamBlockersFrom({ jobs: openJobs, states, owners });
    },
    async readSchedulerGate({ cooldownSeconds = 900 } = {}) {
      calls.gate += 1;
      failIf("readSchedulerGate");
      const t = now();
      const rows = env.cycles.filter((c) => c.status === "pending" || c.status === "running" || (t - (c.updated_ms ?? 0)) < cooldownSeconds * 1000).map((c) => ({
        id: c.id || c.bucket, bucket: c.bucket, status: c.status, cycle_date: c.cycle_date || "",
        age_seconds: Math.floor((t - (c.started_ms ?? c.updated_ms ?? t)) / 1000),
        idle_seconds: Math.floor((t - Math.max(c.updated_ms ?? 0, c.activity_ms ?? 0)) / 1000),
        report_jobs: c.report_jobs ?? 0, source_jobs: c.source_jobs ?? 0, open_report_jobs: c.open_report_jobs ?? 0,
        failed_report_jobs: c.failed_report_jobs ?? 0, open_source_jobs: c.open_source_jobs ?? 0,
        open_fba_plan_age_seconds: c.open_fba_plan_since_ms == null ? null : Math.floor((t - c.open_fba_plan_since_ms) / 1000),
      }));
      return evaluateSchedulerGate(rows, { cooldownSeconds });
    },
    async readControlLease() { failIf("readControlLease"); return { ...env.lease }; },
    async readFence() { return typeof env.fence === "function" ? env.fence() : env.fence; },
    async readReportKeys() { failIf("readReportKeys"); return env.reportKeys.map((r) => (typeof r === "string" ? { report_key: r, n: 1 } : r)); },
    async readScanState() { return { deepSweep: scanRow.deepSweep || {}, holder: scanRow.holder, lastTier1Ms: scanRow.lastTier1At }; },
    async close() {},
  };
  return store;
}
