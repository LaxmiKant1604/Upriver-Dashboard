// Publication recovery worker -- the orchestrator (all I/O injected: store, run, clock, sleep, log).
//
// LOOP (concurrency 1, no busy-wait): each iteration = heartbeat -> (every pollSeconds) watermark pass -> at most ONE
// full-scan STEP (one family x region dry-run; the scan itself is DB-scheduled + single-flight) -> at most ONE claimed
// job batch -> sleep when idle. So the 10-minute consistency scan never blocks pending work for more than one child run.
//
// A job (family, region, account, as-of) is processed as:
//   gates (as-of rollover -> superseded; family not live / scheduler window / global lease held -> deferred, no attempt;
//   an awaited family still open for the same account -> deferred) -> PRE-CHECK dry-run (the reconciler's exact binding;
//   an already-current account is VERIFIED without publishing -- this is what makes a crash AFTER publish safe) -> LIVE
//   run of the existing reconciler for ONLY the still-stale accounts (unique run token; --cleanup with the SAME token
//   after any abnormal exit) -> VERIFY dry-run. Verified only when the binding reports PUBLICATION_NOT_REQUIRED.
// Structurally zero-export: the only spawnable programs are the four zero-export reconciler CLIs (runner.js); a child
// that ever reports a DataDoe create/token dead-letters its jobs and TRIPS the family off for the life of the process.

import { RECOVERY_FAMILIES, FAMILY_IDS, detectOnlyReports, adsEvidenceWorkerKeys } from "./registry.js";
import { accountVerdict, classifyRun, cleanupUnresolved, outcomeFor, CLASSES } from "./classify.js";
import { makeRunToken } from "./runner.js";

const S = (v) => (v == null ? "" : String(v));
const CHILD_BEAT_MS = 60000;
export const yesterdayUtc = (ms) => new Date(ms - 86400000).toISOString().slice(0, 10);
// requested_as_of must arrive as 'YYYY-MM-DD' text (store-pg pins the date parser). A Date here would be node-postgres'
// LOCAL-midnight parse, so read it back with LOCAL getters (toISOString would shift it a day east of UTC).
/** Interruptible sleep that never leaks: the abort listener is removed when the timer fires normally (one listener per
 *  idle tick would otherwise accumulate for the life of the process). */
export const interruptibleSleep = (ms, signal) => new Promise((resolve) => {
  if (signal && signal.aborted) return resolve();
  const onAbort = () => { clearTimeout(t); resolve(); };
  const t = setTimeout(() => { if (signal) signal.removeEventListener("abort", onAbort); resolve(); }, ms);
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
});
const pad2 = (n) => String(n).padStart(2, "0");
export const asOfText = (v) => (v instanceof Date ? `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}` : S(v).slice(0, 10));

export function createRecoveryWorker({ store, run, config, clock = () => Date.now(), sleep, log = () => {}, randomUUID, version = "dev", pid = process.pid }) {
  if (!store || typeof run !== "function" || !config || typeof sleep !== "function" || typeof randomUUID !== "function") throw new Error("createRecoveryWorker: store, run, config, sleep, randomUUID are required");
  const workerId = config.workerId;
  const pollMs = config.pollSeconds * 1000;
  const tripped = new Set();
  const startedAt = new Date(clock()).toISOString();
  const stats = { polls: 0, watermarkEnqueued: 0, scanSteps: 0, scansCompleted: 0, scansAbandoned: 0, batches: 0, childRuns: 0, verified: 0, deferred: 0, retried: 0, dead: 0, superseded: 0, released: 0, rearmed: 0, lastError: null, lastScanAt: null, lastVerifiedAt: null };
  let stopping = false, currentChild = null, scan = null, nextWatermarkAt = 0, claimed = null;
  const byPriority = [...FAMILY_IDS].sort((a, b) => RECOVERY_FAMILIES[a].priority - RECOVERY_FAMILIES[b].priority);
  const materializedKeys = detectOnlyReports().filter((d) => d.reason === "scheduler-materialized" && d.reportKey !== "brand-view-portfolio").map((d) => d.reportKey);
  const adsKeys = adsEvidenceWorkerKeys();

  const spawn = async (args) => {
    stats.childRuns += 1;
    // Keep the heartbeat fresh while a (possibly long: up to the 840 s hard timeout) child runs, so a stale heartbeat
    // means a hung/dead worker, not a legitimate long batch.
    const beat = setInterval(() => { heartbeat("child:" + args.kind); }, CHILD_BEAT_MS);
    if (beat.unref) beat.unref();
    let res;
    try { res = await run({ ...args, onChild: (c) => { currentChild = { child: c, kind: args.kind }; } }); }
    finally { clearInterval(beat); currentChild = null; }
    // Structural zero-export tripwire on EVERY child (scan, pre-check, live, cleanup, verify).
    const rc = classifyRun(res);
    if (rc && rc.cls === CLASSES.ZERO_EXPORT_VIOLATION && !tripped.has(args.family)) {
      tripped.add(args.family);
      log(`ZERO-EXPORT VIOLATION reported by the ${args.family} reconciler (${args.kind}) -- family TRIPPED off for this process.`);
    }
    return res;
  };

  async function liveFamilies() {
    const c = await store.control();
    if (!c.enabled) return [];
    return config.liveFamilies.filter((f) => c.liveFamilies.includes(f) && !tripped.has(f));
  }

  async function heartbeat(mode) {
    try {
      await store.beat({ workerId, host: config.host, pid, version, mode, startedAt, lastErrorCode: stats.lastError, stats: { ...stats, tripped: [...tripped] } });
    } catch (e) { stats.lastError = "heartbeat-failed"; log("heartbeat failed: " + S(e && e.code)); }
  }

  // ---------------- fast watermark pass (metadata only) ----------------
  async function watermarkPass() {
    const live = await liveFamilies();
    if (!live.length) return 0;
    const asOf = yesterdayUtc(clock());
    const scope = await store.readScope({ asOf });
    if (!scope.length) return 0; // the first scan of this as-of establishes the reconciler-scoped account set
    const tokens = await store.readEvidenceTokens({ asOf, adsWorkerKeys: adsKeys });
    let n = 0;
    for (const row of scope) {
      if (!live.includes(row.family)) continue;
      const tok = tokens[row.family] && tokens[row.family].get(S(row.account_id));
      // React only to evidence that CHANGED since the scan classified it (observed) or the binding proved it (verified):
      // an account the scan saw as missing-evidence/deferred is reported there, not re-enqueued on every poll.
      if (!tok || tok === row.verified_token || tok === row.observed_token) continue;
      const d = await store.enqueue({ family: row.family, region: row.region, accountId: row.account_id, asOf, token: tok, origin: "watermark", priority: RECOVERY_FAMILIES[row.family].priority });
      if (d === "enqueued" || d === "refreshed") n += 1;
    }
    stats.watermarkEnqueued += n;
    return n;
  }

  // ---------------- full consistency scan (stepped) ----------------
  // Single-flight end to end: the scan lease is renewed before and after every child run (scan steps AND batch
  // children); a renewal refused because another worker took the scan over abandons this scan instead of running two.
  async function keepScanLease() {
    if (!scan) return false;
    const ok = await store.renewScan({ holder: workerId, leaseSeconds: config.scanLeaseSeconds });
    if (!ok) { log(`scan lease lost (as-of ${scan.asOf}, step ${scan.idx}/${scan.steps.length}) -- abandoning this scan`); stats.scansAbandoned += 1; scan = null; }
    return !!ok;
  }

  async function scanStep() {
    if (!scan) {
      const ok = await store.tryBeginScan({ holder: workerId, leaseSeconds: config.scanLeaseSeconds, minIntervalSeconds: config.scanIntervalSeconds });
      if (!ok) return false;
      const asOf = yesterdayUtc(clock());
      const steps = [];
      for (const region of config.regions) for (const family of byPriority) steps.push({ region, family });
      scan = { asOf, steps, idx: 0, live: await liveFamilies(), accountsByRegion: new Map(), summary: { asOf, steps: {}, errors: 0, stale: 0, current: 0, enqueued: 0 } };
      log(`scan start as-of=${asOf} steps=${steps.length} live=[${scan.live.join(",")}]`);
      return true;
    }
    if (scan.idx < scan.steps.length) {
      const { region, family } = scan.steps[scan.idx++];
      if (!(await keepScanLease())) return true;
      const fam = RECOVERY_FAMILIES[family];
      // Tokens are read per step, BEFORE the dry-run: evidence that lands during the run is then newer than the
      // recorded token, so the watermark still reacts to it (never records newer evidence as already evaluated).
      const tokens = await store.readEvidenceTokens({ asOf: scan.asOf, adsWorkerKeys: adsKeys });
      const r = await spawn({ family, region, asOf: scan.asOf, kind: "dry-run", accounts: null });
      stats.scanSteps += 1;
      if (!(await keepScanLease())) return true; // lapsed during the child and another worker took the scan over
      const rc = classifyRun(r);
      const key = `${region}/${family}`;
      if (rc) { scan.summary.errors += 1; scan.summary.steps[key] = { error: rc.cls, reason: S(rc.reason).slice(0, 80) }; return true; }
      const baseline = [], obs = [];
      let stale = 0, current = 0, enq = 0;
      const regionAccounts = scan.accountsByRegion.get(region) || new Set();
      for (const acc of r.targets.accounts) {
        regionAccounts.add(acc.id);
        const v = accountVerdict(acc, fam.reportKeys());
        const tok = (tokens[family] && tokens[family].get(acc.id)) || null;
        baseline.push({ family, region, account_id: acc.id, requested_as_of: scan.asOf, token: tok, class: v.cls, reason: v.reason });
        for (const [rk, st] of Object.entries(acc.reports)) obs.push({ region, account_id: acc.id, report_key: rk, requested_as_of: scan.asOf, family, state: st.s, reason_code: st.r });
        if (v.cls === CLASSES.CURRENT) current += 1;
        if (v.cls === CLASSES.STALE) {
          stale += 1;
          if (scan.live.includes(family)) {
            const d = await store.enqueue({ family, region, accountId: acc.id, asOf: scan.asOf, token: tok, origin: "scan", priority: fam.priority });
            if (d === "enqueued" || d === "refreshed") enq += 1;
          }
        }
      }
      scan.accountsByRegion.set(region, regionAccounts);
      await store.recordBaseline(baseline);
      await store.recordObservations(obs);
      scan.summary.stale += stale; scan.summary.current += current; scan.summary.enqueued += enq;
      scan.summary.steps[key] = { accounts: r.targets.accounts.length, stale, current, enqueued: enq, ms: r.durationMs };
      return true;
    }
    // Final step: detect-only observations (metadata only), retention, finish.
    for (const [region, accounts] of scan.accountsByRegion) {
      try { await store.recordObservations(await store.readDetectOnly({ region, asOf: scan.asOf, accounts: [...accounts], materializedKeys })); }
      catch (e) { scan.summary.errors += 1; log("detect-only read failed: " + S(e && e.code)); }
    }
    try { await store.prune(config.keepDays); } catch { /* retention is best-effort */ }
    const outcome = scan.summary.errors ? "partial" : "complete";
    if (!(await store.finishScan({ holder: workerId, outcome, summary: scan.summary }))) { log("scan lease lost before finish -- result discarded"); scan = null; return true; }
    stats.scansCompleted += 1; stats.lastScanAt = new Date(clock()).toISOString();
    log(`scan ${outcome} as-of=${scan.asOf} current=${scan.summary.current} stale=${scan.summary.stale} enqueued=${scan.summary.enqueued} errors=${scan.summary.errors}`);
    scan = null;
    return true;
  }

  // ---------------- one claimed batch ----------------
  // Every finish carries the evidence token the job held WHEN CLAIMED (the evidence this outcome is about): if an
  // enqueue refreshed it meanwhile, the store RE-ARMS the job instead of recording a verdict on evidence never evaluated.
  async function finishJob(job, outcome, cls, reason, extra = {}) {
    const d = await store.finish({ id: job.id, claimToken: claimed.token, outcome, cls, reason: S(reason).slice(0, 240) || null, backoff: extra.backoff || 0, maxAttempts: config.maxAttempts, runToken: extra.runToken || null, evaluatedToken: job.evidence_token ?? null });
    if (d === "verified") { stats.verified += 1; stats.lastVerifiedAt = new Date(clock()).toISOString(); }
    else if (d === "deferred") stats.deferred += 1;
    else if (d === "retry") stats.retried += 1;
    else if (d === "dead") stats.dead += 1;
    else if (d === "superseded") stats.superseded += 1;
    else if (d === "released") stats.released += 1;
    else if (d === "re-armed") stats.rearmed += 1;
    claimed.open.delete(job.id);
    return d;
  }
  const finishCls = (job, cls, reason, runToken) => {
    const o = outcomeFor(cls, { attempt: Number(job.attempts) || 0 });
    return finishJob(job, o.outcome, cls, reason, { backoff: o.backoff, runToken });
  };

  async function processOneBatch() {
    const live = await liveFamilies();
    if (!live.length) return false; // observe-only: no job is ever processed
    const token = randomUUID();
    const jobs = await store.claim({ workerId, claimToken: token, limit: config.batch, leaseSeconds: config.leaseSeconds, maxClaims: config.maxClaims });
    if (!jobs.length) return false;
    claimed = { token, open: new Map(jobs.map((j) => [j.id, j])) };
    stats.batches += 1;
    const { family, region } = jobs[0];
    const asOf = asOfText(jobs[0].requested_as_of);
    const fam = RECOVERY_FAMILIES[family];
    // Keep BOTH leases alive across every child: the job claim, and (when a stepped scan is in progress) the scan.
    const renew = async () => {
      if (claimed.open.size) await store.renewClaim({ ids: [...claimed.open.keys()], claimToken: token, leaseSeconds: config.leaseSeconds });
      if (scan) await keepScanLease();
    };
    let failure = null;
    try {
      // (1) as-of rollover: a newer D-1 makes this job moot (the scan re-detects under the new as-of).
      if (asOf < yesterdayUtc(clock())) { for (const j of jobs) await finishJob(j, "superseded", "superseded-by-new-as-of", `as-of ${asOf} < ${yesterdayUtc(clock())}`); return true; }
      if (!fam || !live.includes(family)) { for (const j of jobs) await finishJob(j, "deferred", "family-not-live", "family not enabled for live publication", { backoff: 600 }); return true; }
      // (2) gates that make a publish attempt pointless right now -- deferred WITHOUT consuming an attempt.
      if ((await store.readBusyRegions()).has(region)) { for (const j of jobs) await finishJob(j, "deferred", "scheduler-window", `a scheduler-v2 ${region} cycle is in flight`, { backoff: 300 }); return true; }
      const lease = await store.readControlLease();
      if (lease.held) { for (const j of jobs) await finishJob(j, "deferred", CLASSES.CONTENTION, "control-plane lease held:" + S(lease.operationKey).slice(0, 60), { backoff: 120 }); return true; }
      // (3) dependency ordering: e.g. FBA brand-inventory needs OLI's live brand-sales at the same as-of first.
      let ready = jobs;
      if (fam.awaits.length) {
        const open = await store.readOpenJobs({ asOf });
        const blocked = new Set(open.filter((o) => fam.awaits.includes(o.family) && o.region === region).map((o) => S(o.account_id)));
        const waiting = jobs.filter((j) => blocked.has(S(j.account_id)));
        for (const j of waiting) await finishJob(j, "deferred", CLASSES.DEPENDENCY, `awaiting-${fam.awaits.join("+")}`, { backoff: 180 });
        ready = jobs.filter((j) => !blocked.has(S(j.account_id)));
        if (!ready.length) return true;
      }
      if (stopping) return true; // shutting down: the finally hands every open job back unexecuted
      const accounts = ready.map((j) => S(j.account_id));
      const jobByAcc = new Map(ready.map((j) => [S(j.account_id), j]));
      // (4) PRE-CHECK: the reconciler's exact binding. Already-current -> verified (crash-after-publish recovery).
      const pre = await spawn({ family, region, asOf, kind: "dry-run", accounts });
      await renew();
      if (stopping) return true; // a shutdown may have terminated the pre-check: hand the jobs back, no attempt burned
      const preRc = classifyRun(pre);
      if (preRc) { for (const j of ready) await finishCls(j, preRc.cls, preRc.reason); return true; }
      const preByAcc = new Map(pre.targets.accounts.map((a) => [a.id, a]));
      const toPublish = [];
      for (const acc of accounts) {
        const j = jobByAcc.get(acc);
        const entry = preByAcc.get(acc);
        if (!entry) { await finishCls(j, CLASSES.TRANSPORT, "account-missing-from-targets"); continue; }
        const v = accountVerdict(entry, fam.reportKeys());
        if (v.cls === CLASSES.STALE) toPublish.push(acc);
        else await finishCls(j, v.cls, v.reason);
      }
      if (!toPublish.length || stopping) return true;
      // (5) PUBLISH via the existing reconciler (unique run token; never immediate mode; never a full-region live pass).
      const runToken = makeRunToken({ workerId, family, region, now: clock() });
      const liveRun = await spawn({ family, region, asOf, kind: "live", accounts: toPublish, runToken });
      await renew();
      const liveRc = classifyRun(liveRun);
      const abnormal = liveRun.timedOut || liveRun.spawnError || (liveRun.exitCode !== 0 && !liveRun.result) || cleanupUnresolved(liveRun);
      if (abnormal && !liveRun.spawnError) {
        const c = await spawn({ family, region, asOf, kind: "cleanup", runToken });
        log(`cleanup ${family}/${region} run=${runToken} -> exit ${c.exitCode} cleaned=${!!(c.result && c.result.cleaned)}`);
        await renew();
      }
      // Shutting down after the (mandatory) cleanup: hand the jobs back; the next start's PRE-CHECK proves whether the
      // interrupted publish landed (verified without re-publishing) or must be retried.
      if (stopping) return true;
      if (liveRc && liveRc.cls === CLASSES.ZERO_EXPORT_VIOLATION) {
        // spawn() already tripped the family off for this process; the jobs are dead-lettered.
        for (const acc of toPublish) await finishJob(jobByAcc.get(acc), "dead", CLASSES.ZERO_EXPORT_VIOLATION, liveRc.reason, { runToken });
        return true;
      }
      const liveByAcc = new Map(((liveRun.targets && liveRun.targets.accounts) || []).map((a) => [a.id, a]));
      // (6) VERIFY with the exact binding. Only PUBLICATION_NOT_REQUIRED completes a job.
      const ver = await spawn({ family, region, asOf, kind: "dry-run", accounts: toPublish });
      // A shutdown may have terminated the verify: hand the jobs back; the next start's PRE-CHECK proves the publish.
      if (stopping) return true;
      const verRc = classifyRun(ver);
      const verByAcc = new Map(((ver.targets && ver.targets.accounts) || []).map((a) => [a.id, a]));
      for (const acc of toPublish) {
        const j = jobByAcc.get(acc);
        const vv = verByAcc.get(acc) ? accountVerdict(verByAcc.get(acc), fam.reportKeys()) : null;
        if (vv && vv.cls === CLASSES.CURRENT) { await finishJob(j, "verified", "verified-live-readback", null, { runToken }); continue; }
        const lv = liveByAcc.get(acc) ? accountVerdict(liveByAcc.get(acc), fam.reportKeys()) : null;
        let cls, reason;
        if (liveRc) { cls = liveRc.cls; reason = liveRc.reason; }
        else if (lv && lv.cls !== "published-unverified" && lv.cls !== CLASSES.CURRENT) { cls = lv.cls; reason = lv.reason; }
        else if (verRc) { cls = CLASSES.TRANSPORT; reason = "verify-" + S(verRc.reason); }
        else if (vv && vv.cls === CLASSES.STALE) { cls = CLASSES.READBACK_MISMATCH; reason = "published-but-binding-still-stale:" + S(vv.reason); }
        else { cls = vv ? vv.cls : CLASSES.TRANSPORT; reason = vv ? vv.reason : "account-missing-from-verify"; }
        await finishCls(j, cls, reason, runToken);
      }
      return true;
    } catch (e) {
      failure = e;
      throw e;
    } finally {
      // Still-open jobs: a graceful shutdown hands them back unexecuted ('released', no attempt). An EXCEPTION counts as
      // an attempt (bounded retry -> dead-letter), so a job that always throws can never loop at the head of the queue.
      // If even the finish fails (DB down), the claim lease expires and the crash-loop guard bounds the reclaims.
      for (const j of [...claimed.open.values()]) {
        try {
          if (failure && !stopping) await finishCls(j, CLASSES.TRANSPORT, "batch-exception:" + (S(failure.code || failure.name) || "error").slice(0, 60));
          else await finishJob(j, "released", "released", "batch-aborted");
        } catch { /* lease expiry reclaims */ }
      }
      claimed = null;
    }
  }

  async function tick() {
    stats.polls += 1;
    await heartbeat("running");
    if (clock() >= nextWatermarkAt) { await watermarkPass(); nextWatermarkAt = clock() + pollMs; }
    if (stopping) return false;
    const scanned = await scanStep();
    if (stopping) return scanned;
    const processed = await processOneBatch();
    return scanned || processed;
  }

  async function runForever({ signal } = {}) {
    await heartbeat("starting");
    while (!stopping && !(signal && signal.aborted)) {
      let busy = false;
      try { busy = await tick(); stats.lastError = null; }
      catch (e) { stats.lastError = S(e && (e.code || e.name)) || "tick-error"; log("tick error: " + stats.lastError); busy = false; }
      if (!busy && !stopping) await sleep(pollMs, signal);
    }
    await heartbeat("stopped");
  }

  /**
   * Graceful stop: stop claiming and starting children. A running DRY-RUN child (scan step / pre-check / verify) is
   * terminated after the grace window -- it writes nothing, and its jobs are handed back without burning an attempt.
   * A LIVE or CLEANUP child is NEVER terminated here: the reconcilers finalize a cycle before publishing, so a kill in
   * that window would strand the revision's cycle (cycle-not-running:succeeded); each is bounded by its own
   * --deadline-seconds and the runner's hard timeout (the systemd TimeoutStopSec covers that bound).
   */
  function stop() {
    stopping = true;
    const cur = currentChild;
    if (cur && cur.kind === "dry-run") {
      const t = setTimeout(() => { try { cur.child.kill("SIGTERM"); } catch { /* ignore */ } }, config.stopGraceSeconds * 1000);
      t.unref?.();
    }
  }

  return { tick, runForever, stop, watermarkPass, scanStep, processOneBatch, stats, get stopping() { return stopping; }, tripped };
}
