// Publication recovery worker -- IN-MEMORY store (tests + the synthetic memory/throughput check ONLY; never used by the
// production entrypoint). It mirrors the 20260934 RPC semantics rule-for-rule; scripts/worker/publication-recovery-
// sql-selftest.mjs runs the SAME scenarios against the real SQL (PGlite) to prove the two agree.

const S = (v) => (v == null ? "" : String(v));
const LIVE = new Set(["pending", "claimed", "deferred"]);
let seq = 0;

export function createMemoryStore({ clock = () => Date.now(), control = { enabled: true, liveFamilies: ["oli", "fba", "ads", "listings"] } } = {}) {
  const jobs = [];
  const state = new Map(); // family|region|account|asOf -> row
  const observations = new Map();
  const workers = new Map();
  const scanRow = { holder: null, leaseExpiresAt: null, lastStartedAt: null, lastFinishedAt: null, lastOutcome: null, lastSummary: {} };
  const env = { tokens: { oli: new Map(), fba: new Map(), ads: new Map(), listings: new Map() }, busyRegions: new Set(), lease: { held: false, operationKey: "", expiresAt: null }, detectOnly: [] };
  const now = () => clock();
  const k = (f, r, a, d) => `${f}|${r}|${a}|${d}`;
  const liveJob = (f, r, a, d) => jobs.find((j) => j.family === f && j.region === r && j.account_id === a && j.requested_as_of === d && LIVE.has(j.status));
  const ready = (j) => ((j.status === "pending" || j.status === "deferred") && j.next_attempt_at <= now()) || (j.status === "claimed" && j.lease_expires_at < now());
  const clearClaim = (j) => { j.claim_token = null; j.claimed_by = null; j.lease_expires_at = null; };
  const calls = { enqueue: 0, claim: 0, finish: 0 };

  const store = {
    env, jobs, state, observations, workers, scanRow, calls, control,
    async control() { return { enabled: !!control.enabled, liveFamilies: [...control.liveFamilies] }; },
    async enqueue({ family, region, accountId, asOf, token, origin, priority = 5 }) {
      calls.enqueue += 1;
      const lj = liveJob(family, region, accountId, asOf);
      if (lj) {
        if (token != null && lj.evidence_token !== token) {
          lj.evidence_token = token;
          if (lj.status === "deferred") { lj.status = "pending"; lj.next_attempt_at = now(); }
          lj.priority = Math.min(lj.priority, priority);
          return "refreshed";
        }
        return "exists";
      }
      if (origin === "watermark" && token != null) {
        const st = state.get(k(family, region, accountId, asOf));
        if (st && st.verified_token != null && st.verified_token === token) return "already-verified";
      }
      if (jobs.some((j) => j.family === family && j.region === region && j.account_id === accountId && j.requested_as_of === asOf && j.status === "dead" && S(j.evidence_token) === S(token) && (j.evidence_token == null) === (token == null))) return "dead-same-evidence";
      jobs.push({ id: `job-${++seq}`, family, region, account_id: accountId, requested_as_of: asOf, evidence_token: token ?? null, origin, status: "pending", priority, attempts: 0, claims: 0, claim_token: null, claimed_by: null, claimed_at: null, lease_expires_at: null, next_attempt_at: now(), created_at: now() + (seq / 1e6), last_class: null, last_reason: null, verified_at: null });
      return "enqueued";
    },
    async claim({ workerId, claimToken, limit = 5, leaseSeconds = 1500, maxClaims = 8 }) {
      calls.claim += 1;
      const lease = Math.max(120, Math.min(leaseSeconds, 7200)) * 1000;
      const max = Math.max(2, Math.min(maxClaims, 50));
      for (const j of jobs) if (j.status === "claimed" && j.lease_expires_at < now() && j.claims >= max) { j.status = "dead"; j.last_class = "crash-loop"; clearClaim(j); }
      const cand = jobs.filter(ready).sort((a, b) => a.priority - b.priority || a.next_attempt_at - b.next_attempt_at || a.created_at - b.created_at);
      if (!cand.length) return [];
      const h = cand[0];
      const pick = cand.filter((j) => j.family === h.family && j.region === h.region && j.requested_as_of === h.requested_as_of).slice(0, Math.max(1, Math.min(limit, 25)));
      for (const j of pick) { j.status = "claimed"; j.claims += 1; j.claim_token = claimToken; j.claimed_by = workerId; j.claimed_at = now(); j.lease_expires_at = now() + lease; }
      return pick.map((j) => ({ ...j }));
    },
    async renewClaim({ ids, claimToken, leaseSeconds = 1500 }) {
      let n = 0;
      for (const j of jobs) if (ids.includes(j.id) && j.status === "claimed" && j.claim_token === claimToken) { j.lease_expires_at = now() + Math.max(120, Math.min(leaseSeconds, 7200)) * 1000; n += 1; }
      return n;
    },
    async finish({ id, claimToken, outcome, cls, reason, backoff = 60, maxAttempts = 6, runToken = null, evaluatedToken = null }) {
      calls.finish += 1;
      const j = jobs.find((x) => x.id === id);
      if (!j) return "not-found";
      if (j.status !== "claimed" || j.claim_token !== claimToken) return "not-owner";
      j.updated_at = now();
      const b = Math.max(0, Math.min(backoff || 0, 86400)) * 1000;
      const max = Math.max(1, Math.min(maxAttempts, 50));
      // Evidence refreshed while the job ran: the outcome describes OLD evidence -> re-arm (attempts + claims reset).
      if (["verified", "retry", "deferred", "dead"].includes(outcome) && j.evidence_token != null && evaluatedToken !== j.evidence_token) {
        j.status = "pending"; j.next_attempt_at = now(); j.attempts = 0; j.claims = 0; clearClaim(j); j.last_class = "evidence-advanced"; if (runToken) j.last_run_token = runToken; return "re-armed";
      }
      j.last_class = S(cls || outcome).slice(0, 64); j.last_reason = reason == null ? null : S(reason).slice(0, 240); if (runToken) j.last_run_token = runToken;
      if (outcome !== "released") j.claims = 0; // claims = consecutive claims that never reached an owner finish
      if (outcome === "verified") {
        j.status = "verified"; j.verified_at = now(); clearClaim(j);
        state.set(k(j.family, j.region, j.account_id, j.requested_as_of), { family: j.family, region: j.region, account_id: j.account_id, requested_as_of: j.requested_as_of, verified_token: j.evidence_token, observed_token: j.evidence_token, verified_at: now(), last_class: j.last_class, observed_at: now() });
        return "verified";
      }
      if (outcome === "retry") {
        if (j.attempts + 1 >= max) { j.attempts += 1; j.status = "dead"; j.last_class = "max-attempts:" + S(cls).slice(0, 50); clearClaim(j); return "dead"; }
        j.attempts += 1; j.status = "pending"; j.next_attempt_at = now() + b; clearClaim(j); return "retry";
      }
      if (outcome === "deferred") { j.status = "deferred"; j.next_attempt_at = now() + b; clearClaim(j); return "deferred"; }
      if (outcome === "released") { j.status = "pending"; j.claims = Math.max(0, j.claims - 1); j.next_attempt_at = now(); j.last_class = "released"; clearClaim(j); return "released"; }
      if (outcome === "dead") { j.status = "dead"; clearClaim(j); return "dead"; }
      if (outcome === "superseded") { j.status = "superseded"; clearClaim(j); return "superseded"; }
      throw new Error("unknown outcome " + outcome);
    },
    async recordBaseline(rows) {
      for (const r of rows) {
        const key = k(r.family, r.region, r.account_id, r.requested_as_of);
        const prev = state.get(key) || { family: r.family, region: r.region, account_id: r.account_id, requested_as_of: r.requested_as_of, verified_token: null, verified_at: null };
        const cur = r.class === "current";
        state.set(key, { ...prev, verified_token: cur ? (r.token || null) : prev.verified_token, observed_token: r.token || null, verified_at: cur ? now() : prev.verified_at, last_class: r.class, last_reason: r.reason || null, observed_at: now() });
      }
      return rows.length;
    },
    async recordObservations(rows) { for (const r of rows) observations.set(`${r.region}|${r.account_id}|${r.report_key}|${r.requested_as_of}|${r.family}`, { ...r, observed_at: now() }); return rows.length; },
    async beat(b) { workers.set(b.workerId, { ...b, last_beat_at: now() }); },
    async tryBeginScan({ holder, leaseSeconds = 3600, minIntervalSeconds = 600 }) {
      const leaseLive = scanRow.holder && scanRow.leaseExpiresAt > now();
      if (leaseLive && scanRow.holder !== holder) return false;
      const staleHolder = scanRow.holder && scanRow.leaseExpiresAt <= now();
      if (scanRow.lastFinishedAt != null && scanRow.lastFinishedAt > now() - Math.max(60, minIntervalSeconds) * 1000 && !staleHolder) return false;
      scanRow.holder = holder; scanRow.leaseExpiresAt = now() + Math.max(300, leaseSeconds) * 1000; scanRow.lastStartedAt = now();
      return true;
    },
    async renewScan({ holder, leaseSeconds = 3600 }) { if (scanRow.holder !== holder) return false; scanRow.leaseExpiresAt = now() + Math.max(300, leaseSeconds) * 1000; return true; },
    async finishScan({ holder, outcome, summary }) { if (scanRow.holder !== holder) return false; scanRow.holder = null; scanRow.leaseExpiresAt = null; scanRow.lastFinishedAt = now(); scanRow.lastOutcome = outcome; scanRow.lastSummary = summary; return true; },
    // Mirrors prune_publication_recovery: keep window clamped to [3, 90] days; finished jobs by last touch, observations
    // and state by observation time.
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
      return { jobs: { by_status: by, dead_letter: by.dead || 0 }, workers: [...workers.values()], scan: { ...scanRow } };
    },
    async readScope({ asOf }) { return [...state.values()].filter((r) => r.requested_as_of === asOf).map((r) => ({ family: r.family, region: r.region, account_id: r.account_id, verified_token: r.verified_token, observed_token: r.observed_token ?? null })); },
    async readOpenJobs({ asOf }) { return jobs.filter((j) => j.requested_as_of === asOf && LIVE.has(j.status)).map((j) => ({ family: j.family, region: j.region, account_id: j.account_id, status: j.status })); },
    async readEvidenceTokens() { return env.tokens; },
    async readBusyRegions() { return new Set(env.busyRegions); },
    async readControlLease() { return { ...env.lease }; },
    async readDetectOnly({ region, asOf, accounts }) { return env.detectOnly.filter((r) => r.region === region && r.requested_as_of === asOf && accounts.includes(r.account_id)); },
    async close() {},
  };
  return store;
}
