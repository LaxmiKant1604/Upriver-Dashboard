// Publication recovery worker -- the GENERIC orchestrator over the route registry (WP12; all I/O injected: store, run,
// clock, sleep, log). It carries NO report-specific code: every route is driven through its declaration in routes.js
// (evidence SQL + compose, awaits, tier-1 live-row scope, identity as-of, CLI + timeouts + heap).
//
// TICK (concurrency 1, no busy-wait):
//   1. heartbeat;
//   2. WATERMARK (per route, every route.evidence.everySeconds; LIVE (route, region) pairs only): the route's metadata
//      evidence tokens -> enqueue (origin 'watermark') every target whose token is neither the verified nor the observed
//      token of its state row (a target with no state row included);
//   3. TIER-1 CONSISTENCY SCAN (every PRW_SCAN_INTERVAL_SECONDS, DB-claimed so one worker per interval; ALL routes and
//      regions; in-process metadata SQL only): token vs state, served-row writes since verification (tier1.liveRowScope),
//      identity as-of rollover (identityAsOf vs verified_rows[].asOf), missing targets -> enqueue ('scan') when live, else
//      observations; plus the global alerts (stranded / paid cycles, unregistered live report keys, writer-fence state);
//   4. DEEP SWEEP STEP (single-flight through the scan lease; once per epoch after the scheduler gate clears, then every
//      PRW_DEEP_SWEEP_HOURS -- fba-plan and the portfolio only on a token change): one read-only child per (region,
//      route) (--verify-exact for a route CLI), recording the unit-level baseline (verified_rows) and enqueueing stale
//      targets ('deep-scan');
//   5. ONE CLAIMED BATCH (same route, region, epoch): epoch rollover -> superseded; route live? (control.enabled AND
//      route.live_enabled AND region in live_regions AND PRW_LIVE_ROUTES AND not tripped); the GLOBAL scheduler gate
//      (deferred, no attempt); the control lease (contention) -- a READ failure of any gate defers 'gate-unreadable' with
//      NO attempt; capacity (child heap below the route minimum); the owner activation attestation; SCOPE (an account
//      target no longer in the region's durable directory -> superseded 'superseded-target-out-of-scope', never handed
//      to the CLI); live-state awaits (an OPEN upstream job / a 'stale' upstream state blocks; past
//      PRW_AWAIT_MAX_MINUTES it proceeds with alert 'await-timeout'); then PRE-CHECK child -> RE-CHECK (the claim -- a
//      lost one is dropped without a finish --, the epoch, the trip, the route switch, the scheduler gate, the lease:
//      any closed -> the batch-start outcome, NO live child) -> LIVE child for the stale targets (-> CLEANUP child with
//      the same run token after an abnormal exit) -> VERIFY child (--verify-exact).
//      VERIFIED only when the verdict is current AND the child's evaluated token equals the job's token (a route CLI); a
//      token mismatch re-arms through finish(evaluatedToken). After a verified PUBLISH the dependents are enqueued
//      (origin 'dependency'; owner scope for account routes, region scope for the portfolio).
// Structurally zero-export: the only spawnable programs are the allow-listed route CLIs (runner.js); a child that ever
// reports a blocked DataDoe request / a create / a token TRIPS its route off for the life of the process and
// dead-letters its jobs.

import { createHash } from "node:crypto";
import {
  PUBLICATION_ROUTES, topoOrder, utcDMinus1, buildEvidenceContext, tier1Target, liveRowScopesFor, identityAsOfFor,
  supportsVerifyExact, deepSweepDue, regionTargetKey, regionEvidenceAccountIds, reusableEntriesOf, seedReusable, adsChangeProbeSignature,
} from "./routes.js";
import { jobVerdict, classifyRun, runTargets, cleanupUnresolved, outcomeFor, handoffClass, repairKindFor, awaitVerdict, CLASSES, HANDOFF_CLASSES, STATES } from "./classify.js";
import { makeRunToken, childHeapFor } from "./runner.js";
import { inSchedulerWindow, missingLiveAttestation } from "./config.js";
import { classifyReportKey, handoffForReportClass, REPORT_RECOVERY_CLASSIFICATION, ACTIVE_PUBLICATION_REPORT_KEYS, verdictReportKeys } from "./registry.js";
import { fenceStatusSummary, classifyReportWriterError, REPORT_WRITER_FENCED_EVENT } from "../sync/report-writer-fence.js";

const S = (v) => (v == null ? "" : String(v));
const CHILD_BEAT_MS = 60000;
export const yesterdayUtc = (ms) => utcDMinus1(ms);
/** Interruptible sleep that never leaks: the abort listener is removed when the timer fires normally (one listener per
 *  idle tick would otherwise accumulate for the life of the process). */
export const interruptibleSleep = (ms, signal) => new Promise((resolve) => {
  if (signal && signal.aborted) return resolve();
  const onAbort = () => { clearTimeout(t); resolve(); };
  const t = setTimeout(() => { if (signal) signal.removeEventListener("abort", onAbort); resolve(); }, ms);
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
});
const pad2 = (n) => String(n).padStart(2, "0");
// requested_as_of must arrive as 'YYYY-MM-DD' text (store-pg pins the date parser). A Date here would be node-postgres'
// LOCAL-midnight parse, so read it back with LOCAL getters (toISOString would shift it a day east of UTC).
export const asOfText = (v) => (v instanceof Date ? `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}` : S(v).slice(0, 10));

// Deep-sweep routes whose PERIODIC sweep runs only on a token change (they still sweep once per epoch): the fba-plan
// fill-only route and the region portfolio (the heaviest build).
export const TOKEN_CHANGE_ONLY_SWEEP_ROUTES = Object.freeze(["fba-plan", "brand-view-portfolio"]);
// A finish that evaluated nothing (a gate held it) never touches the state row. UNREADABLE: a gate / lease / claim /
// directory READ failed -- deferred 300 s + alert 'gate-unreadable', NO attempt (never the batch-exception attempt path).
export const GATE_CLASSES = Object.freeze({ SCHEDULER: "scheduler-window-global", NOT_LIVE: "route-not-live", TRIPPED: "route-tripped", UNREADABLE: "gate-unreadable" });
// The class an account target that LEFT its region's durable directory is superseded with (worker.js step 3b).
export const TARGET_OUT_OF_SCOPE_CLASS = "superseded-target-out-of-scope";
// Tier-1 findings (newer than the verification) that make a verified target's hand-off 'deferred' in the matrix.
// 'served-unknown': the tier-1 live-row read FAILED, so the served proof could not be re-checked this pass (never 'ok').
const TIER1_STALE_HANDOFF = Object.freeze({ "token-advanced": "evidence-advanced", "identity-rollover": "identity-rollover", "served-unknown": "served-unknown" });
const errCode = (e) => (S(e && (e.code || e.name)) || "error").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40) || "error";
// Tier-1 finding codes that need a re-check (enqueue 'scan' when live).
const ACTIONABLE_TIER1 = new Set(["target-missing", "token-unobserved", "token-advanced", "served-row-foreign", "identity-rollover"]);
// The not-applicable hand-off types (owner rule: exactly manual-paid / read-only-self-heal / source-absent).
const SOURCE_ABSENT_REASONS = new Set(["no-evidence-token", "brand-not-sold"]);
const VERIFIED_ROWS_MAX_CHARS = 6000;
const WRITER_FENCED_RE = /writer-fenced|REPORT_WRITER_FENCED/;

/** The report keys a route's TARGETS units carry: registry.js verdictReportKeys (= route.publisherKeys), re-exported. */
export { verdictReportKeys };

/**
 * The owner hand-off of a worker class (+ reason): EXACTLY repaired | already-current | deferred | missing-source |
 * failed | not-applicable. servedConfirmed is passed through to classify's handoffClass (the served read-back proof).
 */
export function handoffFor(cls, { published = false, reason = null, servedConfirmed = null } = {}) {
  if (cls === CLASSES.ROUTE_NOT_ACTIVATED) return HANDOFF_CLASSES.DEFERRED; // applicable -- just not activated yet
  if (cls === CLASSES.MISSING_EVIDENCE && SOURCE_ABSENT_REASONS.has(S(reason))) return HANDOFF_CLASSES.NOT_APPLICABLE;
  return handoffClass(cls, { published, servedConfirmed });
}

/** True when ANY unit x report of a verdict is STALE (jobVerdict's anyStale: the live / repair pass runs for it; the worst class is only the final outcome). */
export const hasStaleUnit = (verdict) => !!(verdict && (verdict.anyStale === true || (Array.isArray(verdict.rows) && verdict.rows.some((r) => r.cls === CLASSES.STALE))));

/**
 * The SERVED read-back proof of a route CLI target (TARGETS v2): EVERY unit carries its served row with the content hash
 * (and, when present, the source_refreshed_at) of the unit's own live row. null for a legacy (v1) target -- its served
 * proof is the worker's tier-1 served-row check (publication_recovery_state.served_confirmed).
 */
export function servedConfirmedFromUnits(target) {
  const units = target && Array.isArray(target.units) ? target.units : [];
  if (!units.length || units.every((u) => u.served == null && u.h == null)) return null;
  return units.every((u) => u.served && u.h != null && u.served.h === u.h && (u.sra == null || u.served.sra === u.sra));
}

/**
 * The unit-level verified rows [{u, rk, acct, h, sra, upd, asOf}] of a verified target (TARGETS v2 units), compacted
 * under the 20260934 verified_rows bound: over VERIFIED_ROWS_MAX_CHARS the units collapse per (report, as-of) into
 * { u: '*<n>', rk, acct, h: null, sra: max, upd, asOf } -- the tier-1 rollover check needs only the as-of set.
 */
export function compactVerifiedRows(target, { upd = null, maxChars = VERIFIED_ROWS_MAX_CHARS } = {}) {
  const t = target && typeof target === "object" ? target : {};
  const acct = S(t.id);
  const rows = (Array.isArray(t.units) ? t.units : []).map((u) => ({
    u: S(u.u), rk: S(u.rk), acct, h: u.h || (u.served && u.served.h) || null, sra: u.sra || (u.served && u.served.sra) || null, upd, asOf: u.asOf || null,
  })).sort((a, b) => (a.rk + "|" + a.u < b.rk + "|" + b.u ? -1 : 1));
  if (JSON.stringify(rows).length <= maxChars) return rows;
  const groups = new Map();
  for (const r of rows) {
    const key = r.rk + "|" + S(r.asOf);
    const g = groups.get(key) || { n: 0, rk: r.rk, asOf: r.asOf, sra: null };
    g.n += 1; if (r.sra && (!g.sra || r.sra > g.sra)) g.sra = r.sra;
    groups.set(key, g);
  }
  return [...groups.values()].slice(0, 40).map((g) => ({ u: "*" + g.n, rk: g.rk, acct, h: null, sra: g.sra, upd, asOf: g.asOf }));
}

/**
 * The owner HAND-OFF MATRIX per (region x account x report): exactly the classes repaired | already-current (content +
 * lineage + served read-back proven by the binding) | deferred (typed) | missing-source (typed) | failed (typed) |
 * not-applicable (typed: manual-paid / read-only-self-heal / source-absent). stateRows = the status RPC's latest-epoch
 * state rows; directory = the durable directory Map; regions = the regions reported. Two routes feeding one report
 * (daily-reporting: oli + ads) combine WORST-first (failed > deferred > missing-source > repaired > already-current >
 * not-applicable). A route target with no state row is 'deferred' typed 'not-yet-evaluated'. A verified row is handed
 * off 'deferred' (typed 'evidence-advanced' / 'identity-rollover' / 'job-open') while a newer tier-1 finding or an open
 * job says it is no longer the latest word (state rows: tier1_state, open_job -- publication_recovery_status). Pure.
 */
export function buildHandoffMatrix({ stateRows = [], directory = new Map(), regions = ["india", "europe-au", "us-ca"], routes = PUBLICATION_ROUTES, classification = REPORT_RECOVERY_CLASSIFICATION } = {}) {
  const RANK = { failed: 6, deferred: 5, "missing-source": 4, repaired: 3, "already-current": 2, "not-applicable": 1 };
  const byKey = new Map(stateRows.map((s) => [`${s.route_id}|${s.region}|${s.target_key}`, s]));
  const rows = [];
  const accountsOf = (region) => [...(directory instanceof Map ? directory : new Map()).values()].filter((m) => routes.length && buildEvidenceRegion(m, region)).map((m) => m.accountId).sort();
  for (const region of regions) {
    const targets = [...accountsOf(region).map((a) => ({ target: a, account: a })), { target: regionTargetKey(region), account: "*" }];
    for (const reportKey of ACTIVE_PUBLICATION_REPORT_KEYS) {
      const rs = routes.filter((r) => r.liveReportKeys.includes(reportKey));
      for (const { target, account } of targets) {
        const applicable = rs.filter((r) => (account === "*" ? r.grain === "region" : r.grain === "account"));
        if (!applicable.length) continue;
        let best = null;
        for (const r of applicable) {
          const s = byKey.get(`${r.id}|${region}|${target}`);
          const cls = s ? S(s.last_class) : null;
          let handoff = s ? (s.handoff || handoffFor(cls, { reason: s.last_reason })) : "deferred";
          // A CURRENT state row's hand-off is re-derived from its LATEST served proof (classify handoffClass honours
          // servedConfirmed): a legacy verification stored 'deferred' becomes repaired / already-current once the tier-1
          // served-row check confirms it, and falls back to 'deferred' when a foreign served-row write revokes it.
          if (s && cls === CLASSES.CURRENT) handoff = handoffFor(CLASSES.CURRENT, { published: s.handoff === "repaired" || S(s.last_reason) === "verified-live-readback", servedConfirmed: s.served_confirmed === true });
          let type = !s ? "not-yet-evaluated" : handoff === "not-applicable" ? "source-absent" : (handoff === "repaired" || handoff === "already-current") ? null : cls === CLASSES.CURRENT ? "current-unserved" : `${cls}${s.last_reason ? ":" + S(s.last_reason).slice(0, 80) : ""}`;
          // 'already-current' / 'repaired' REQUIRE the served read-back (content + lineage alone are not enough) -- and a
          // verification that is no longer the latest word (WP12 verifier P2-3): a tier-1 finding NEWER than the
          // verification that the evidence token advanced / the identity as-of rolled (status tier1_state), or an OPEN
          // job for the target (status open_job: the worker is re-checking it) -> 'deferred', typed.
          if (handoff === "repaired" || handoff === "already-current") {
            if (s.served_confirmed !== true) { handoff = "deferred"; type = "current-unserved"; }
            else if (TIER1_STALE_HANDOFF[S(s.tier1_state)]) { handoff = "deferred"; type = TIER1_STALE_HANDOFF[S(s.tier1_state)]; }
            else if (s.open_job === true) { handoff = "deferred"; type = "job-open"; }
          }
          const cand = { region, accountId: account, reportKey, handoff, type, routes: [r.id] };
          if (!best || RANK[cand.handoff] > RANK[best.handoff]) best = { ...cand, routes: [...(best ? best.routes : []), r.id] };
          else best.routes.push(r.id);
        }
        rows.push(best);
      }
    }
    // Non-route reports: typed not-applicable (manual-paid / read-only-self-heal), one row per region.
    for (const e of classification.values()) {
      const h = handoffForReportClass(e);
      if (!h || !(e.kind === "manual-paid" || e.kind === "read-only-self-heal")) continue;
      rows.push({ region, accountId: "*", reportKey: e.reportKey, handoff: HANDOFF_CLASSES.NOT_APPLICABLE, type: e.kind, routes: [] });
    }
  }
  return rows;
}
// Region membership of a directory entry (the route CLI's accountInScope rule, via the ONE evidence-context builder).
function buildEvidenceRegion(entry, region) {
  try { return buildEvidenceContext({ epoch: "2000-01-01", now: 0, directory: new Map([[entry.accountId, entry]]), region, organizationFingerprint: "x" }).accountIds.length === 1; }
  catch { return false; }
}

/** The token digest of a route over every region's targets (the deep-sweep token-change rule; tier-1 and the sweep agree). */
const tokenDigestOf = (parts) => createHash("sha256").update([...parts].sort().join("\n")).digest("hex").slice(0, 32);

/** A bounded alert collector: code -> { code, n, samples (<= 5) } (<= 60 codes). */
function alertBag() {
  const m = new Map();
  return {
    add(code, sample = null) {
      const c = S(code).slice(0, 120); if (!c) return;
      if (!m.has(c)) { if (m.size >= 60) return; m.set(c, { code: c, n: 0, samples: [] }); }
      const e = m.get(c); e.n += 1; if (sample != null && e.samples.length < 5) e.samples.push(typeof sample === "string" ? sample.slice(0, 120) : sample);
    },
    list() { return [...m.values()]; },
    get size() { return m.size; },
  };
}

export function createRecoveryWorker({ store, run, config, clock = () => Date.now(), sleep, log = () => {}, randomUUID, version = "dev", pid = process.pid, routes = PUBLICATION_ROUTES, organizationFingerprint = null }) {
  if (!store || typeof run !== "function" || !config || typeof sleep !== "function" || typeof randomUUID !== "function") throw new Error("createRecoveryWorker: store, run, config, sleep, randomUUID are required");
  if (typeof organizationFingerprint !== "string" || organizationFingerprint.trim() === "") throw new Error("createRecoveryWorker: the primary connection's organizationFingerprint is required (the ONE evidence ctx; fail closed)");
  const workerId = config.workerId;
  const pollMs = config.pollSeconds * 1000;
  const routeOf = new Map(routes.map((r) => [r.id, r]));
  const byPriority = topoOrder(routes);
  const tripped = new Set();
  const startedAt = new Date(clock()).toISOString();
  const stats = {
    polls: 0, watermarkEnqueued: 0, tier1Scans: 0, tier1Ms: 0, tier1Enqueued: 0, deepSteps: 0, deepSweeps: 0, deepAbandoned: 0, batches: 0, childRuns: 0,
    verified: 0, repaired: 0, deferred: 0, retried: 0, dead: 0, superseded: 0, released: 0, rearmed: 0, dependencyEnqueued: 0,
    gateDeferred: 0, awaitDeferred: 0, awaitTimeouts: 0, tokenDisagreements: 0, writerFenced: 0, evidenceErrors: 0,
    gateUnreadable: 0, liveGateHeld: 0, claimsLost: 0, outOfScope: 0, tier1Skipped: 0, sharedReuseHits: 0, sharedReuseScans: 0, deepPaused: 0,
    lastError: null, lastTier1At: null, lastVerifiedAt: null,
  };
  let stopping = false, currentChild = null, sweep = null, claimed = null, nextSweepCheckAt = 0;
  const lastWatermarkAt = new Map();
  const tokenDigest = new Map(); // route -> digest of every region's tokens at the last tier-1 (deep-sweep token-change rule)
  // route -> region -> that region's token parts at its LAST successful tier-1 evaluation: the digest is taken over every
  // region's latest parts, so a pass that could not evaluate a region never yields a partial (spuriously 'changed') digest.
  const tokenParts = new Map();
  // CROSS-pass reuse of shared evidence (route-contract.js SHARED_REUSE_TABLES; the Ads digest partials): key ->
  // { rows, table, sig, atMs } -- sig = the table's change-probe signature read BEFORE the scan that produced rows. A new
  // pass is seeded with rows only while the probe is byte-identical and the entry is younger than the hard cap; a reused
  // entry keeps its ORIGINAL sig + atMs (staleness never accumulates). Tier-1 / watermark only: every per-job, dependency,
  // deep-sweep and route-CLI read stays fresh, so a stale entry can only DELAY detection -- never verify or publish.
  const sharedReuse = new Map();
  const SHARED_REUSE_MAX = 4;
  const reuseCapMs = Math.max(0, Math.min(3600, Number(config.sharedEvidenceReuseSeconds ?? 3600) || 0)) * 1000;
  let deepPauseCheckAt = 0;

  // routeKind: the legacy reason whitelist applies ONLY to the four legacy-cli routes (classify.js; a route-cli reason is
  // checked against REASON_RULES + ROUTE_REASON_VOCABULARY alone).
  const classifyCtx = (route, asOf, t0) => ({ routeId: route.id, routeKind: route.kind, skuMovementServeAttested: !!(config.attestations && config.attestations.skuMovementServeToken === true), argAsOf: asOf, expectedAsOf: utcDMinus1(t0) });
  const isLive = (ctl, routeId, region) => {
    if (!ctl || !ctl.enabled || tripped.has(routeId) || !config.liveRoutes.includes(routeId)) return false;
    const r = ctl.routes && ctl.routes[routeId];
    return !!(r && r.liveEnabled === true && Array.isArray(r.liveRegions) && r.liveRegions.includes(region));
  };
  const anyLive = (ctl) => routes.some((r) => config.regions.some((g) => isLive(ctl, r.id, g)));

  async function heartbeat(mode) {
    try {
      await store.beat({ workerId, host: config.host, pid, version, mode, startedAt, lastErrorCode: stats.lastError, stats: { ...stats, tripped: [...tripped] } });
    } catch (e) { stats.lastError = "heartbeat-failed"; log("heartbeat failed: " + S(e && e.code)); }
  }

  const spawn = async (args) => {
    stats.childRuns += 1;
    // Keep the heartbeat fresh while a (possibly long) child runs, so a stale heartbeat means a hung/dead worker.
    const beat = setInterval(() => { heartbeat("child:" + args.kind); }, CHILD_BEAT_MS);
    if (beat.unref) beat.unref();
    let res;
    try { res = await run({ ...args, now: clock, onChild: (c) => { currentChild = { child: c, kind: args.kind }; } }); }
    catch (e) { res = { route: args.route, kind: args.kind, spawnError: "argv-refused", exitCode: null, timedOut: false, targets: null, result: null, zeroExport: { blocked: 0 }, stderrTail: [S(e && e.message).slice(0, 160)] }; }
    finally { clearInterval(beat); currentChild = null; }
    // Structural zero-export tripwire on EVERY child (tier-2 sweep, pre-check, live, cleanup, verify).
    const rc = classifyRun(res);
    if (rc && rc.cls === CLASSES.ZERO_EXPORT_VIOLATION && !tripped.has(args.route)) {
      tripped.add(args.route);
      log(`ZERO-EXPORT VIOLATION reported by route ${args.route} (${args.kind}) -- route TRIPPED off for this process.`);
    }
    // A writer-fence rejection surfaced by a child (stderr) is a typed 'writer-fenced' event (LKG preserved).
    for (const line of Array.isArray(res && res.stderrTail) ? res.stderrTail : []) if (classifyReportWriterError(line).fenced) { stats.writerFenced += 1; break; }
    return res;
  };

  // ---------------- evidence ----------------
  // sweepCache (tier-1 and the watermark pass; a fresh Map per pass): a `shared: true` statement runs once per pass.
  // Every other read (per-job, deep sweep, dependency) passes none: each route reads its account-scoped statements.
  async function evidenceFor(route, region, epoch, now, sweepCache = null) {
    const directory = await store.readDirectory();
    if (!(directory instanceof Map) || directory.size === 0) { const e = new Error("the durable account directory is empty"); e.code = "DIRECTORY_EMPTY"; throw e; }
    const ctx = buildEvidenceContext({ epoch, now, directory, region, organizationFingerprint });
    return { ctx, directory, map: sweepCache ? await store.readRouteEvidence(route, ctx, { sweepCache }) : await store.readRouteEvidence(route, ctx) };
  }
  // ---------------- cross-pass reuse of shared evidence ----------------
  // probeShared: the change probe in its OWN transaction, BEFORE the pass's first evidence read (so any write missing
  // from a later scan either moved the probe or is still unflushed -- bounded by the cap). null = cannot vouch -> no reuse.
  async function probeShared() {
    if (!(reuseCapMs > 0) || typeof store.readAdsChangeProbe !== "function") return null;
    const atMs = clock();
    try { const sig = adsChangeProbeSignature(await store.readAdsChangeProbe()); return sig ? { sig, atMs, table: "ads_daily_source_rows" } : null; }
    catch { return null; }
  }
  // seedShared: carry every still-valid entry into this pass's NEW sweep cache -> { seeded: Set<key>, reason }.
  function seedShared(sweepCache, probe, now) {
    const seeded = new Set();
    if (!probe) return { seeded, reason: reuseCapMs > 0 ? "probe-unavailable" : "disabled" };
    let reason = sharedReuse.size ? "none-valid" : "empty";
    for (const [key, ent] of [...sharedReuse]) {
      const valid = ent.table === probe.table && ent.sig === probe.sig && now >= ent.atMs && now - ent.atMs <= reuseCapMs;
      if (!valid) { sharedReuse.delete(key); reason = ent.sig !== probe.sig ? "probe-changed" : "cap"; continue; }
      seedReusable(sweepCache, { key, table: ent.table, rows: ent.rows });
      seeded.add(key);
    }
    if (seeded.size) { reason = "reused"; stats.sharedReuseHits += seeded.size; }
    return { seeded, reason };
  }
  // harvestShared: keep this pass's FRESH successful shared results (tagged with this pass's probe); a seeded entry is
  // never re-tagged, a failure is never kept, and nothing is kept when the probe could not vouch.
  function harvestShared(sweepCache, seeded, probe) {
    if (!probe) return;
    for (const e of reusableEntriesOf(sweepCache)) {
      if (seeded.has(e.key) || e.table !== probe.table) continue;
      sharedReuse.set(e.key, { rows: e.rows, table: e.table, sig: probe.sig, atMs: probe.atMs });
      stats.sharedReuseScans += 1;
    }
    while (sharedReuse.size > SHARED_REUSE_MAX) {
      let oldest = null; for (const [k, v] of sharedReuse) if (!oldest || v.atMs < oldest[1].atMs) oldest = [k, v];
      sharedReuse.delete(oldest[0]);
    }
  }

  // Owners are informational for a region target and bounded by the jobs CHECK (<= 128).
  const boundedOwners = (owners) => (Array.isArray(owners) ? owners.slice(0, 128) : []);

  // ---------------- 2. watermark (live pairs only) ----------------
  async function watermarkPass() {
    const now = clock(); const epoch = utcDMinus1(now);
    const ctl = await store.control();
    let n = 0;
    // ONE sweep cache per watermark pass (like tier-1): the live Brand View + portfolio pairs of this pass (one clock)
    // read the shared Ads digest partials once, instead of one scan per live route x region.
    const sweepCache = new Map();
    // The same cross-pass reuse as tier-1, probed lazily (only when a live pair is evaluated: observe-only issues none).
    let probe = null, seeded = new Set(), probed = false;
    for (const id of byPriority) {
      const route = routeOf.get(id);
      if ((lastWatermarkAt.get(id) || 0) + route.evidence.everySeconds * 1000 > now) continue;
      const regions = config.regions.filter((g) => isLive(ctl, id, g));
      if (!regions.length) continue;
      lastWatermarkAt.set(id, now);
      if (!probed) { probed = true; probe = await probeShared(); ({ seeded } = seedShared(sweepCache, probe, now)); }
      for (const region of regions) {
        let ev;
        try { ev = await evidenceFor(route, region, epoch, now, sweepCache); } catch (e) { stats.evidenceErrors += 1; log(`watermark ${id}/${region} evidence read failed: ${S(e && (e.code || e.name))}`); continue; }
        const st = await store.readState({ route: id, region, epoch });
        for (const [targetKey, e] of ev.map) {
          if (e.token == null || (e.region != null && e.region !== region)) continue;
          const s = st.get(targetKey);
          if (s && (e.token === s.verified_token || e.token === s.observed_token)) continue;
          const d = await store.enqueue({ route: id, region, targetKey, owners: boundedOwners(e.owners), asOf: epoch, token: e.token, origin: "watermark", priority: route.priority });
          if (d === "enqueued" || d === "refreshed") n += 1;
        }
      }
    }
    if (probed) harvestShared(sweepCache, seeded, probe);
    stats.watermarkEnqueued += n;
    return n;
  }

  // ---------------- 3. tier-1 consistency scan (metadata only, every route x region) ----------------
  async function tier1Scan() {
    const began = await store.tryBeginScan({ holder: workerId, kind: "tier1", leaseSeconds: config.scanLeaseSeconds, minIntervalSeconds: config.scanIntervalSeconds });
    if (!began) return false;
    const t0 = clock(); const epoch = utcDMinus1(t0);
    const ctl = await store.control();
    const alerts = alertBag();
    const counts = {}; let enq = 0, targets = 0, errors = 0;
    const obs = []; const baseline = []; const served = [];
    const digestParts = new Map();
    // ONE sweep cache per tier-1 pass (dropped when the pass ends): the shared Ads digest partials scan runs once for
    // every Brand View + portfolio route x region evaluation of this pass (all at the same t0 clock) -- and is CARRIED from
    // an earlier pass while the Ads table's change probe is unchanged (seedShared; read BEFORE any evidence read).
    const probe = await probeShared();
    const sweepCache = new Map();
    const { seeded, reason: reuseReason } = seedShared(sweepCache, probe, t0);
    // CIRCUIT BREAKER (database protection): a SECOND statement timeout (57014) in the pass -- two distinct reads each ran
    // the full 60 s -- means the database is starved: the rest of the pass is NOT issued (each counted as a failed
    // evaluation, 'tier1-circuit-open', outcome 'partial', never 'complete'); the next pass retries. One slow statement
    // alone fails only its own evaluation (+ instant sweep-cache replays). The pass STARTS at a rotating (region, route)
    // offset, so a persistent trip never hides the same pairs every pass. Only detection is delayed; tier-1 never
    // verifies or publishes.
    let circuit = null, skipped = 0, timeouts = 0;
    const noteTimeout = (code, where) => { if (code !== "57014") return; timeouts += 1; if (timeouts >= 2 && !circuit) { circuit = code; log(`tier-1 circuit OPEN after ${where} (second statement timeout): the rest of this pass is not issued`); } };
    const pairs = [];
    for (const region of config.regions) for (const id of byPriority) pairs.push([region, id]);
    const offset = pairs.length ? stats.tier1Scans % pairs.length : 0;
    for (const [region, id] of [...pairs.slice(offset), ...pairs.slice(0, offset)]) {
      {
        const route = routeOf.get(id);
        if (circuit) { errors += 1; skipped += 1; stats.tier1Skipped += 1; alerts.add("tier1-circuit-open", `${id}/${region}:${circuit}`); continue; }
        let ev;
        try { ev = await evidenceFor(route, region, epoch, t0, sweepCache); }
        catch (e) {
          errors += 1; stats.evidenceErrors += 1;
          // The error CODE is kept (sample + log): a statement timeout (57014) is transient, a compose throw is a defect.
          // A 'replay' is this pass's earlier failed shared read re-thrown by the sweep cache -- ONE failure, not many.
          const code = S(e && (e.code || e.name)).replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40) || "error";
          const replay = !!(e && e.sweepReplay === true);
          alerts.add(code === "DIRECTORY_EMPTY" ? "directory-empty" : replay ? "evidence-read-failed-replayed" : "evidence-read-failed", `${id}/${region}:${code}`);
          log(`tier-1 ${id}/${region} evidence read failed: ${code}${replay ? " (replay of this pass's failed shared read)" : ""}`);
          if (!replay) noteTimeout(code, `${id}/${region}`);
          continue;
        }
        const live = isLive(ctl, id, region);
        const st = await store.readState({ route: id, region, epoch });
        const scopes = [];
        for (const [tk, s] of st) {
          if (s.verified_ms == null) continue;
          let sc; try { sc = liveRowScopesFor(route, tier1Target(route, tk, region)); } catch { continue; }
          for (const x of sc) scopes.push({ key: tk, ...x });
        }
        // A FAILED live-row read leaves every scoped target's served state UNKNOWN: no confirmation and no revocation is
        // pushed (a confirmation without the read would be unproven), the pass is 'partial', and a 57014 counts toward the
        // circuit breaker.
        let writes = new Map(), liveReadFailed = false;
        const scopedKeys = new Set(scopes.map((x) => x.key));
        if (scopes.length) {
          try { writes = await store.readLiveRowWritesSince(scopes); }
          catch (e) {
            liveReadFailed = true; errors += 1;
            const lc = S(e && (e.code || e.name)).replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40) || "error";
            alerts.add("live-row-read-failed", `${id}/${region}:${lc}`);
            noteTimeout(lc, `${id}/${region} live-row read`);
          }
        }
        const parts = [];
        const byRegion = digestParts.get(id) || new Map(); digestParts.set(id, byRegion); byRegion.set(region, parts);
        for (const [tk, e] of ev.map) {
          targets += 1;
          parts.push(`${region}|${tk}|${S(e.token)}`);
          for (const a of e.alerts || []) alerts.add(a, `${id}/${region}/${tk.slice(0, 40)}`);
          const s = st.get(tk);
          let code = "ok";
          if (e.token == null) code = "no-token";
          else if (!s) code = "target-missing";
          else if (s.verified_token == null) code = s.observed_token === e.token ? "observed-unverified" : "token-unobserved";
          else if (e.token !== s.verified_token) code = "token-advanced";
          else {
            const w = writes.get(tk);
            if (liveReadFailed && scopedKeys.has(tk)) code = "served-unknown";
            else if (w && w.maxMs != null && s.verified_ms != null && w.maxMs > s.verified_ms) code = "served-row-foreign";
            else if (route.identityAsOf) {
              let want = null;
              try { want = identityAsOfFor(route, tier1Target(route, tk, region), { now: t0, directory: ev.directory }); } catch { want = null; }
              if (want && s.verified_rows.some((v) => v && v.asOf && v.asOf !== want)) code = "identity-rollover";
            }
          }
          counts[code] = (counts[code] || 0) + 1;
          // The SERVED read-back of a verified target: a legacy family's proof IS this check (no live row in scope written
          // after the verification); a route CLI's comes from its units at verification and is only ever REVOKED here.
          // A REVOCATION is STICKY for the verified token (WP11 verifier F1): a legacy row is confirmed only while its proof
          // is still unproven (null) -- once revoked (false) only a NEW verified token or a republish by this worker resets
          // it (the store enforces the same rule); the row carries the verified token it evaluated, so a newer verification
          // that landed meanwhile is never touched.
          if (s && s.verified_token != null && e.token === s.verified_token && (code === "ok" || code === "served-row-foreign" || code === "identity-rollover")) {
            const conf = code !== "served-row-foreign";
            const push = !conf ? s.served_confirmed !== false : route.kind === "legacy-cli" && s.served_confirmed == null;
            if (push) served.push({ kind: "served", route_id: id, region, target_key: tk, requested_as_of: epoch, served_confirmed: conf, token: s.verified_token });
          }
          // A route-cli re-check is enqueued; a legacy family's foreign served-row write is DETECTION-ONLY (its own
          // backstops / the scheduler also write that key -- never fought in a loop).
          const actionable = ACTIONABLE_TIER1.has(code) && !(code === "served-row-foreign" && route.kind === "legacy-cli");
          if (actionable && live && e.token != null && (e.region == null || e.region === region)) {
            const d = await store.enqueue({ route: id, region, targetKey: tk, owners: boundedOwners(e.owners), asOf: epoch, token: e.token, origin: "scan", priority: route.priority });
            if (d === "enqueued" || d === "refreshed") enq += 1;
          }
          if (code === "served-row-foreign") alerts.add("served-row-foreign", `${id}/${region}/${tk.slice(0, 40)}`);
          obs.push({ route_id: id, region, target_key: tk, unit_key: "-", report_key: "tier-1", requested_as_of: epoch, target_as_of: e.targetAsOf || null, tier: 1, state: code, reason_code: e.token == null ? S(e.reason).slice(0, 120) || null : null, alert: code === "served-row-foreign" ? "served-row-foreign" : null });
          // An ineligible target's class is typed missing-evidence (or source-absent) -- recorded for the hand-off matrix
          // (never a verification: the token is null).
          if (e.token == null && (!s || s.last_class !== CLASSES.MISSING_EVIDENCE || S(s.last_reason) !== S(e.reason))) {
            baseline.push({ route_id: id, region, target_key: tk, requested_as_of: epoch, owners: boundedOwners(e.owners), token: null, class: CLASSES.MISSING_EVIDENCE, reason: S(e.reason).slice(0, 240) || "no-evidence-token", alert: null, handoff: handoffFor(CLASSES.MISSING_EVIDENCE, { reason: e.reason }) });
          }
        }
      }
    }
    for (const id of byPriority) {
      const known = tokenParts.get(id) || new Map(); tokenParts.set(id, known);
      for (const [region, parts] of digestParts.get(id) || []) known.set(region, { epoch, parts });
      // Only when EVERY region was evaluated in THIS epoch: a digest over a subset (or an older epoch's parts) would look
      // like a token change. Otherwise the digest is dropped and the token-change sweep waits (the per-epoch sweep stays).
      if (config.regions.every((g) => known.has(g) && known.get(g).epoch === epoch)) tokenDigest.set(id, tokenDigestOf(config.regions.flatMap((g) => known.get(g).parts)));
      else tokenDigest.delete(id);
    }
    // Honest reuse report: 'scanned' = shared results read FRESH this pass (a seeded key can coexist with a fresh scan of
    // another key, e.g. a rolled window).
    const scanned = reusableEntriesOf(sweepCache).filter((e) => !seeded.has(e.key)).length;
    const reuseOutcome = seeded.size && scanned ? "reused+scanned" : reuseReason;
    harvestShared(sweepCache, seeded, probe);
    // Global checks (metadata only).
    let gate = null, fence = null;
    try { gate = await store.readSchedulerGate({ cooldownSeconds: config.schedulerCooldownSeconds }); for (const a of gate.alerts) alerts.add(a.code, a); }
    catch { alerts.add("scheduler-gate-unreadable"); }
    try { fence = fenceStatusSummary(await store.readFence()); if (fence.state === "invalid" || fence.state === "unreadable") alerts.add("writer-fence-" + fence.state, fence.code || null); }
    catch { fence = fenceStatusSummary({ state: "unreadable", code: "error" }); alerts.add("writer-fence-unreadable"); }
    try {
      for (const r of await store.readReportKeys()) if (!classifyReportKey(r.report_key)) alerts.add("unregistered-live-report-key", `${S(r.report_key).slice(0, 64)}:${r.n}`);
    } catch { alerts.add("report-keys-unreadable"); }
    if (stats.writerFenced > 0) alerts.add(REPORT_WRITER_FENCED_EVENT, `children:${stats.writerFenced}`);
    for (let i = 0; i < obs.length; i += 500) await store.recordObservations(obs.slice(i, i + 500));
    for (let i = 0; i < baseline.length; i += 500) await store.recordBaseline(baseline.slice(i, i + 500));
    for (let i = 0; i < served.length; i += 500) await store.recordBaseline(served.slice(i, i + 500));
    const durationMs = clock() - t0;
    const summary = { epoch, durationMs, targets, errors, skipped, circuit, sharedReuse: { reason: reuseOutcome, seeded: seeded.size, scanned, probe: probe ? "ok" : "unavailable" }, enqueued: enq, findings: counts, gate: gate ? { blocked: gate.blocked, reason: gate.reason, orphanPartial: gate.orphanPartial } : null, fence, alerts: alerts.list() };
    await store.finishScan({ holder: workerId, kind: "tier1", outcome: errors ? "partial" : "complete", summary });
    stats.tier1Scans += 1; stats.tier1Ms = durationMs; stats.tier1Enqueued += enq; stats.lastTier1At = new Date(clock()).toISOString();
    log(`tier-1 ${errors ? "partial" : "complete"} epoch=${epoch} targets=${targets} enqueued=${enq} ms=${durationMs} alerts=${alerts.size}`);
    return true;
  }

  // ---------------- per-target recording of a child's verdicts (sweep + pre-check) ----------------
  // -> { verdict, tokOk, cls } per target id (the child's TARGETS), recording the baseline + unit observations.
  async function recordRun(route, region, epoch, runRes, evMap, { live, origin, t0, only = null }) {
    const tmap = runTargets(runRes);
    const out = new Map(); const baseline = []; const obs = []; let enq = 0;
    const cctx = classifyCtx(route, epoch, t0);
    for (const [tk, t] of tmap) {
      if (only && !only.has(tk)) continue;
      const ev = evMap && evMap.get(tk);
      const workerTok = ev ? ev.token : null;
      const servedConfirmed = servedConfirmedFromUnits(t);
      const v = jobVerdict(t, verdictReportKeys(route), { ...cctx, servedConfirmed });
      const tokOk = route.kind === "route-cli" ? (t.tok != null && t.tok === workerTok) : workerTok != null;
      const cls = v.cls === CLASSES.CURRENT && !tokOk ? CLASSES.EVIDENCE_ADVANCED : v.cls;
      const alert = v.alerts.join(",").slice(0, 120) || null;
      out.set(tk, { verdict: v, tokOk, cls, target: t, servedConfirmed });
      baseline.push({ route_id: route.id, region, target_key: tk, requested_as_of: epoch, owners: boundedOwners(t.owners && t.owners.length ? t.owners : (ev ? ev.owners : [])), token: workerTok, class: cls, reason: v.reason, alert, handoff: handoffFor(cls, { reason: v.reason, servedConfirmed }), verified_rows: cls === CLASSES.CURRENT ? compactVerifiedRows(t, { upd: t0 }) : [], served_confirmed: servedConfirmed });
      for (const r of v.rows) {
        const fenced = WRITER_FENCED_RE.test(S(r.r));
        if (fenced) stats.writerFenced += 1;
        obs.push({ route_id: route.id, region, target_key: tk, unit_key: r.u || "-", report_key: S(r.rk).slice(0, 64) || "-", requested_as_of: epoch, target_as_of: (t.units.find((u) => u.u === r.u && u.rk === r.rk) || {}).asOf || null, tier: 2, state: S(r.s).slice(0, 64) || "UNKNOWN", reason_code: r.r ? S(r.r).slice(0, 120) : null, alert: fenced ? REPORT_WRITER_FENCED_EVENT : (r.alert || null) });
      }
      if ((hasStaleUnit(v) || cls === CLASSES.EVIDENCE_ADVANCED) && cls !== CLASSES.ZERO_EXPORT_VIOLATION && live && workerTok != null && origin) {
        const d = await store.enqueue({ route: route.id, region, targetKey: tk, owners: boundedOwners(ev.owners), asOf: epoch, token: workerTok, origin, priority: route.priority });
        if (d === "enqueued" || d === "refreshed") enq += 1;
      }
    }
    for (let i = 0; i < baseline.length; i += 200) await store.recordBaseline(baseline.slice(i, i + 200));
    for (let i = 0; i < obs.length; i += 500) await store.recordObservations(obs.slice(i, i + 500));
    return { byTarget: out, enqueued: enq };
  }

  // A LIVE child's writer-fence rejections (a unit reason naming REPORT_WRITER_FENCED / writer-fenced): the typed
  // 'writer-fenced' event -- LKG preserved by the database fence; from a fenced route writer it is a defect -> alert.
  async function noteWriterFenced(route, region, epoch, runRes) {
    const obs = [];
    for (const [tk, t] of runTargets(runRes)) {
      for (const u of Array.isArray(t.units) ? t.units : []) {
        if (!WRITER_FENCED_RE.test(S(u.r))) continue;
        stats.writerFenced += 1;
        // A DISTINCT report_key (wf:<rk>) so the verify child's later observation of the same unit never erases the event.
        obs.push({ route_id: route.id, region, target_key: tk, unit_key: u.u || "-", report_key: ("wf:" + S(u.rk)).slice(0, 64), requested_as_of: epoch, target_as_of: u.asOf || null, tier: 2, state: REPORT_WRITER_FENCED_EVENT, reason_code: S(u.r).slice(0, 120), alert: REPORT_WRITER_FENCED_EVENT });
      }
    }
    if (obs.length) await store.recordObservations(obs.slice(0, 500));
    return obs.length;
  }

  // ---------------- 4. deep sweep (stepped, single-flight) ----------------
  async function keepScanLease() {
    if (!sweep) return false;
    const ok = await store.renewScan({ holder: workerId, leaseSeconds: config.scanLeaseSeconds });
    if (!ok) { log(`deep-sweep lease lost (epoch ${sweep.epoch}, step ${sweep.idx}/${sweep.steps.length}) -- abandoning`); stats.deepAbandoned += 1; sweep = null; }
    return !!ok;
  }
  async function gateNow() {
    const now = clock();
    if (inSchedulerWindow(config.schedulerWindows, now)) return { blocked: true, reason: "scheduler-window-configured" };
    return store.readSchedulerGate({ cooldownSeconds: config.schedulerCooldownSeconds });
  }

  // The route is swept once its LAST region step ran -- whatever the outcome (a child failure, an evidence-read failure,
  // a tripped route): a failing route must not be re-swept every tick (tier-1 + the next period / epoch cover it). Its
  // token is a digest over EVERY configured region's parts only when every region's evidence was read in this sweep;
  // otherwise tier-1's current digest (epoch-scoped, or none) -- never a subset digest that looks like a token change.
  function markSweptIfLast(id) {
    if (!sweep || sweep.steps.slice(sweep.idx).some((x) => x.route === id)) return;
    const seen = sweep.partsRegions.get(id) || new Set();
    const complete = config.regions.every((g) => seen.has(g));
    sweep.byRoute[id] = { lastAtMs: clock(), epoch: sweep.epoch, tok: complete ? tokenDigestOf(sweep.parts.get(id) || []) : (tokenDigest.get(id) || null) };
  }
  async function deepSweepStep() {
    if (!sweep) {
      const now = clock();
      if (now < nextSweepCheckAt) return false;
      nextSweepCheckAt = now + pollMs * 3;
      const epoch = utcDMinus1(now);
      const ds = ((await store.readScanState()) || {}).deepSweep || {};
      const byRoute = ds.byRoute && typeof ds.byRoute === "object" ? ds.byRoute : {};
      const lastAtByRoute = Object.fromEntries(Object.entries(byRoute).map(([id, v]) => [id, Number(v && v.lastAtMs)]));
      const periodic = new Set(deepSweepDue({ now, deepSweepHours: config.deepSweepHours, lastAtByRoute, routes }).map((d) => d.routeId));
      const due = byPriority.filter((id) => {
        if (tripped.has(id)) return false;
        const b = byRoute[id];
        if (!b || b.epoch !== epoch) return true; // once per epoch
        if (!periodic.has(id)) return false;
        if (TOKEN_CHANGE_ONLY_SWEEP_ROUTES.includes(id)) return tokenDigest.has(id) && tokenDigest.get(id) !== b.tok;
        return true;
      });
      if (!due.length) return false;
      const gate = await gateNow();
      if (gate.blocked) return false; // the sweep runs only once the scheduler gate clears
      if (!(await store.tryBeginScan({ holder: workerId, kind: "deep", leaseSeconds: config.scanLeaseSeconds, minIntervalSeconds: 60 }))) return false;
      const steps = [];
      for (const region of config.regions) for (const id of due) steps.push({ region, route: id });
      sweep = { epoch, steps, idx: 0, startedAt: now, byRoute: { ...byRoute }, parts: new Map(), partsRegions: new Map(), ctl: await store.control(), summary: { epoch, steps: {}, errors: 0, stale: 0, current: 0, enqueued: 0 } };
      log(`deep sweep start epoch=${epoch} steps=${steps.length} routes=[${due.join(",")}]`);
      return true;
    }
    if (sweep.idx < sweep.steps.length) {
      if (utcDMinus1(clock()) !== sweep.epoch) { await finishSweep("epoch-rolled"); return true; }
      // PAUSE while the scheduler gate is blocked (before, it was checked only at sweep START, so a sweep in progress kept
      // stepping -- evidence reads + heavy children -- straight through a scheduler cycle). The step is NOT consumed, the
      // scan lease is kept, and the gate is re-checked at most every 3 polls while paused. Unreadable gate = paused.
      if (sweep.pausedSince && clock() < deepPauseCheckAt) return false;
      let gate;
      try { gate = await gateNow(); } catch { gate = { blocked: true, reason: "gate-unreadable" }; stats.gateUnreadable += 1; }
      if (gate && gate.blocked) {
        deepPauseCheckAt = clock() + pollMs * 3;
        stats.deepPaused += 1;
        if (!sweep.pausedSince) { sweep.pausedSince = clock(); log(`deep sweep PAUSED at step ${sweep.idx}/${sweep.steps.length}: ${S(gate.reason).slice(0, 80)}`); }
        if (!(await keepScanLease())) return true;
        return false;
      }
      if (sweep.pausedSince) { sweep.summary.pausedMs = (sweep.summary.pausedMs || 0) + (clock() - sweep.pausedSince); sweep.pausedSince = null; }
      const { region, route: id } = sweep.steps[sweep.idx++];
      if (!(await keepScanLease())) return true;
      const route = routeOf.get(id);
      const key = `${region}/${id}`;
      if (tripped.has(id)) { sweep.summary.steps[key] = { skipped: "tripped" }; markSweptIfLast(id); return true; }
      const t0 = clock();
      // Tokens are read BEFORE the child: evidence landing during the run is newer than what is recorded, so the
      // watermark / tier-1 still react to it (never records newer evidence as already evaluated).
      let ev;
      try { ev = await evidenceFor(route, region, sweep.epoch, t0); } catch (e) { sweep.summary.errors += 1; sweep.summary.steps[key] = { error: "evidence-read-failed", code: S(e && (e.code || e.name)).replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40) || "error" }; markSweptIfLast(id); return true; }
      const parts = sweep.parts.get(id) || []; sweep.parts.set(id, parts);
      for (const [tk, e] of ev.map) parts.push(`${region}|${tk}|${S(e.token)}`);
      const seen = sweep.partsRegions.get(id) || new Set(); sweep.partsRegions.set(id, seen); seen.add(region);
      const r = await spawn({ route: id, region, asOf: sweep.epoch, kind: supportsVerifyExact(route) ? "verify" : "dry-run", targets: null });
      stats.deepSteps += 1;
      if (!sweep || !(await keepScanLease())) return true;
      const rc = classifyRun(r);
      if (rc) { sweep.summary.errors += 1; sweep.summary.steps[key] = { error: rc.cls, reason: S(rc.reason).slice(0, 80), ms: r.durationMs }; }
      else {
        const rec = await recordRun(route, region, sweep.epoch, r, ev.map, { live: isLive(sweep.ctl, id, region), origin: "deep-scan", t0 });
        let stale = 0, current = 0;
        for (const x of rec.byTarget.values()) { if (x.cls === CLASSES.STALE) stale += 1; if (x.cls === CLASSES.CURRENT) current += 1; }
        sweep.summary.stale += stale; sweep.summary.current += current; sweep.summary.enqueued += rec.enqueued;
        sweep.summary.steps[key] = { targets: rec.byTarget.size, stale, current, enqueued: rec.enqueued, ms: r.durationMs };
      }
      markSweptIfLast(id);
      return true;
    }
    await finishSweep(sweep.summary.errors ? "partial" : "complete");
    return true;
  }
  async function finishSweep(outcome) {
    const s = sweep; if (!s) return;
    try { await store.prune(config.keepDays); } catch { /* retention is best-effort */ }
    const durationMs = clock() - s.startedAt;
    const ok = await store.finishScan({ holder: workerId, kind: "deep", outcome, summary: { ...s.summary, durationMs }, deepSweep: { epoch: s.epoch, byRoute: s.byRoute, lastDurationMs: durationMs } });
    if (!ok) log("deep-sweep lease lost before finish -- result discarded");
    else { stats.deepSweeps += 1; log(`deep sweep ${outcome} epoch=${s.epoch} current=${s.summary.current} stale=${s.summary.stale} enqueued=${s.summary.enqueued} errors=${s.summary.errors} ms=${durationMs}`); }
    sweep = null;
  }

  // ---------------- 5. one claimed batch ----------------
  // Every finish carries the evidence token the outcome is ABOUT (default: the token the job held WHEN CLAIMED): if an
  // enqueue refreshed it meanwhile (or the child evaluated other evidence), the store RE-ARMS the job instead.
  async function finishJob(job, outcome, cls, reason, extra = {}) {
    const d = await store.finish({
      id: job.id, claimToken: claimed.token, outcome, cls, reason: S(reason).slice(0, 240) || null, backoff: extra.backoff || 0, maxAttempts: config.maxAttempts,
      runToken: extra.runToken || null, evaluatedToken: Object.prototype.hasOwnProperty.call(extra, "evaluatedToken") ? extra.evaluatedToken : (job.evidence_token ?? null),
      verifiedRows: extra.verifiedRows || null, alert: extra.alert ? S(extra.alert).slice(0, 120) : null, published: !!extra.published,
      handoff: extra.handoff || null, recordState: extra.recordState !== false,
      servedConfirmed: Object.prototype.hasOwnProperty.call(extra, "servedConfirmed") ? extra.servedConfirmed : null, maxRearms: config.maxRearms || 12,
    });
    if (d === "verified") { stats.verified += 1; if (extra.published) stats.repaired += 1; stats.lastVerifiedAt = new Date(clock()).toISOString(); }
    else if (d === "deferred") stats.deferred += 1;
    else if (d === "retry") stats.retried += 1;
    else if (d === "dead") stats.dead += 1;
    else if (d === "superseded") stats.superseded += 1;
    else if (d === "released") stats.released += 1;
    else if (d === "re-armed") stats.rearmed += 1;
    claimed.open.delete(job.id);
    return d;
  }
  const finishCls = (job, cls, reason, extra = {}) => {
    const o = outcomeFor(cls, { attempt: Number(job.attempts) || 0 });
    return finishJob(job, o.outcome === "proceed" ? "deferred" : o.outcome, cls, reason, { backoff: o.backoff, handoff: handoffFor(cls, { published: !!extra.published, reason }), ...extra });
  };
  // A gate deferral evaluated nothing: no attempt, the state row untouched.
  const finishGate = (job, cls, reason, backoff, alert = null) => finishJob(job, "deferred", cls, reason, { backoff, recordState: false, alert });

  // The worker's CURRENT token for one target (null when unreadable / ineligible). ONE evidence read per (route, region)
  // between two children (cached on the child-run counter: a read after a child sees what that child could have seen).
  let tokCache = null;
  async function currentToken(route, region, epoch, targetKey) {
    const key = `${route.id}|${region}|${epoch}|${stats.childRuns}`;
    if (!tokCache || tokCache.key !== key) {
      let map = null;
      try { map = (await evidenceFor(route, region, epoch, clock())).map; } catch { map = null; }
      tokCache = { key, map };
    }
    const e = tokCache.map ? tokCache.map.get(targetKey) : null;
    return e && e.token != null ? e.token : null;
  }
  // The child evaluated a DIFFERENT token than the job was claimed with (a route CLI). Evidence advanced -> adopt the
  // worker's current token (enqueue refresh) and RE-ARM; the worker itself still reads the claim-time token while the
  // child evaluated another -> a persistent worker / CLI token DISAGREEMENT (ctx or code defect): typed deferral + alert,
  // never a loop.
  async function tokenMismatch(route, region, epoch, job, childTok, runToken) {
    const cur = await currentToken(route, region, epoch, job.target_key);
    if (cur != null && cur !== job.evidence_token) {
      await store.enqueue({ route: route.id, region, targetKey: job.target_key, owners: boundedOwners(job.owner_account_ids), asOf: epoch, token: cur, origin: job.origin, priority: route.priority });
      return finishJob(job, "deferred", CLASSES.EVIDENCE_ADVANCED, `evaluated-token-mismatch:${cur === childTok ? "advanced" : "moving"}`, { backoff: 0, runToken, evaluatedToken: job.evidence_token });
    }
    if (cur == null) return finishCls(job, CLASSES.MISSING_EVIDENCE, "evidence-ineligible-after-run", { runToken });
    stats.tokenDisagreements += 1;
    return finishJob(job, "deferred", CLASSES.UNKNOWN, "token-disagreement:worker-vs-cli", { backoff: 1800, runToken, alert: "token-disagreement", handoff: HANDOFF_CLASSES.DEFERRED });
  }
  // VERIFIED only when the verdict is current AND the child's evaluated token is the job's token (a route CLI). A legacy
  // CLI (TARGETS v1: no evaluated token) is verified on its binding, then the worker re-reads its own token: evidence
  // that moved during the run re-arms (never a verification stamped on evidence the CLI did not see).
  async function settleCurrent(route, region, epoch, job, x, { runToken = null, published = false, extraAlerts = [] } = {}) {
    if (route.kind === "route-cli") {
      if (x.target.tok !== job.evidence_token) return tokenMismatch(route, region, epoch, job, x.target.tok, runToken);
    } else {
      const cur = await currentToken(route, region, epoch, job.target_key);
      if (cur != null && cur !== job.evidence_token) {
        await store.enqueue({ route: route.id, region, targetKey: job.target_key, owners: boundedOwners(job.owner_account_ids), asOf: epoch, token: cur, origin: job.origin, priority: route.priority });
        return finishJob(job, "deferred", CLASSES.EVIDENCE_ADVANCED, "evidence-advanced-during-run", { backoff: 0, runToken, evaluatedToken: job.evidence_token });
      }
    }
    // The hand-off REQUIRES the served read-back (classify handoffClass): a legacy target (v1: no served proof until the
    // tier-1 served-row check confirms it AFTER this verification) is handed off 'deferred' until then.
    return finishJob(job, "verified", CLASSES.CURRENT, published ? "verified-live-readback" : "already-current", {
      runToken, published, alert: [...new Set([job.awaitAlert, ...extraAlerts, ...x.verdict.alerts].filter(Boolean).flatMap((a) => S(a).split(",")).filter(Boolean))].join(",").slice(0, 120) || null, servedConfirmed: x.servedConfirmed,
      verifiedRows: compactVerifiedRows(x.target, { upd: clock() }), handoff: handoffFor(CLASSES.CURRENT, { published, servedConfirmed: x.servedConfirmed }),
    });
  }

  async function enqueueDependents(route, region, epoch, ctl, repairedJobs) {
    const deps = routes.filter((r) => r.awaits.includes(route.id));
    if (!deps.length || !repairedJobs.length) return;
    const owners = new Set(repairedJobs.flatMap((j) => (route.grain === "account" ? [S(j.target_key)] : (j.owner_account_ids || []).map(S))));
    for (const dep of deps) {
      if (!isLive(ctl, dep.id, region)) continue;
      let ev;
      try { ev = await evidenceFor(dep, region, epoch, clock()); } catch { continue; }
      for (const [tk, e] of ev.map) {
        if (e.token == null) continue;
        if (dep.grain === "account" && !owners.has(tk) && !(e.owners || []).some((o) => owners.has(o))) continue;
        const d = await store.enqueue({ route: dep.id, region, targetKey: tk, owners: boundedOwners(e.owners), asOf: epoch, token: e.token, origin: "dependency", priority: dep.priority });
        if (d === "enqueued" || d === "refreshed") stats.dependencyEnqueued += 1;
      }
    }
  }

  // ---------------- batch gates (shared by the batch start and the re-check right before a live child) ----------------
  // A gate / lease / claim / directory READ failure defers WITHOUT an attempt (typed 'gate-unreadable', 300 s + alert;
  // WP12 verifier P3) -- never the batch-exception attempt path, so a flaky metadata read can never dead-letter a job.
  async function gateUnreadable(list, what, e) {
    stats.gateUnreadable += 1;
    log(`${what} read failed (${errCode(e)}) -- ${list.length} job(s) deferred without an attempt`);
    for (const j of list) await finishGate(j, GATE_CLASSES.UNREADABLE, `${what}-unreadable:${errCode(e)}`, 300, "gate-unreadable");
  }
  /**
   * The trip / route switch (control.enabled AND route.live_enabled AND the region AND PRW_LIVE_ROUTES) / GLOBAL scheduler
   * gate / control-plane lease checks of a batch. `ctl` = an already-read control row (the batch start), else it is
   * re-read. -> { held: false, ctl } when every gate is clear; else { held: true } after finishing EVERY job of `list`
   * with the typed outcome (deferred, NO attempt, state untouched; a tripped route dead-letters zero-export).
   */
  async function holdByGates(routeId, region, list, ctl = null) {
    if (tripped.has(routeId)) { for (const j of list) await finishJob(j, "dead", CLASSES.ZERO_EXPORT_VIOLATION, "route-tripped-this-process", { alert: "zero-export-violation", handoff: HANDOFF_CLASSES.FAILED }); return { held: true }; }
    let c = ctl;
    if (!c) { try { c = await store.control(); } catch (e) { await gateUnreadable(list, "control", e); return { held: true }; } }
    if (!isLive(c, routeId, region)) { for (const j of list) await finishGate(j, GATE_CLASSES.NOT_LIVE, "route not live for this region (control / route switch / PRW_LIVE_ROUTES)", 600); return { held: true }; }
    // the GLOBAL scheduler gate -- deferred WITHOUT consuming an attempt.
    let gate;
    try { gate = await gateNow(); } catch (e) { await gateUnreadable(list, "scheduler-gate", e); return { held: true }; }
    if (gate.blocked) { stats.gateDeferred += list.length; for (const j of list) await finishGate(j, GATE_CLASSES.SCHEDULER, S(gate.reason) || "scheduler-owned cycle", 300); return { held: true }; }
    let lease;
    try { lease = await store.readControlLease(); } catch (e) { await gateUnreadable(list, "control-lease", e); return { held: true }; }
    if (lease.held) { for (const j of list) await finishGate(j, CLASSES.CONTENTION, "control-plane lease held:" + S(lease.operationKey).slice(0, 60), 120); return { held: true }; }
    return { held: false, ctl: c };
  }
  /**
   * RE-CHECK immediately BEFORE a live / repair child (WP12 verifier P2-1): the pre-check child may have run for its whole
   * hard timeout since the batch-start checks. In order: the CLAIM (renewed for exactly these jobs; a job whose claim was
   * lost -- lease expired + reclaimed -- is dropped from this batch WITHOUT a finish: another worker owns it); the EPOCH
   * (a newer UTC D-1 -> superseded, like step 1); then holdByGates (trip / control + route switch / scheduler gate /
   * lease, re-read). -> { items: the entries still cleared to publish, ctl: the re-read control row }; empty -> ZERO live.
   */
  async function recheckBeforeLive(routeId, region, asOf, items) {
    const leaseSeconds = config.leaseSeconds;
    let n;
    try { n = await store.renewClaim({ ids: items.map((p) => p.j.id), claimToken: claimed.token, leaseSeconds }); }
    catch (e) { await gateUnreadable(items.map((p) => p.j), "claim-renew", e); return { items: [] }; }
    let held = items;
    if (Number(n) !== items.length) {
      held = [];
      for (const p of items) {
        let one = 0, threw = null;
        try { one = Number(await store.renewClaim({ ids: [p.j.id], claimToken: claimed.token, leaseSeconds })) || 0; } catch (e) { threw = e; }
        if (one === 1) { held.push(p); continue; }
        // A THROWN renew proves nothing about ownership (a transient DB error, final-review P3-2): defer the job typed
        // 'gate-unreadable' (no attempt; the claim-token-bound finish answers not-owner harmlessly if it really moved)
        // instead of dropping a job we may still own -- which would leak its claim until the lease expires.
        if (threw) { await gateUnreadable([p.j], "claim-renew", threw); continue; }
        // Not provably ours any more: never publish for it, never finish it (the new owner does; our lease, if any is
        // left, expires and the crash-loop guard bounds the reclaims).
        claimed.open.delete(p.j.id);
        stats.claimsLost += 1;
        log(`claim lost before the live child: ${routeId}/${region}/${S(p.j.target_key).slice(0, 40)} -- dropped without a finish`);
      }
      if (!held.length) return { items: [] };
    }
    const epochNow = utcDMinus1(clock());
    if (asOf < epochNow) { for (const { j } of held) await finishJob(j, "superseded", "superseded-by-new-as-of", `as-of ${asOf} < ${epochNow}`); return { items: [] }; }
    const g = await holdByGates(routeId, region, held.map((p) => p.j));
    if (g.held) { stats.liveGateHeld += 1; log(`live child for ${routeId}/${region} NOT started: a gate closed after the pre-check`); return { items: [] }; }
    return { items: held, ctl: g.ctl };
  }

  async function processOneBatch() {
    const ctl = await store.control();
    if (!anyLive(ctl)) return false; // observe-only: no job is ever processed
    const token = randomUUID();
    const jobs = await store.claim({ workerId, claimToken: token, limit: config.batch, leaseSeconds: config.leaseSeconds, maxClaims: config.maxClaims });
    if (!jobs.length) return false;
    claimed = { token, open: new Map(jobs.map((j) => [j.id, j])) };
    stats.batches += 1;
    const routeId = S(jobs[0].route_id);
    const region = S(jobs[0].region);
    const asOf = asOfText(jobs[0].requested_as_of);
    // Keep BOTH leases alive across every child: the job claim, and (when a stepped sweep is in progress) the scan.
    // A keep-alive only: a failed renew READ never costs an attempt (final review P3; the W2 principle) -- every later
    // finish is bound to the claim token (a lost claim answers not-owner harmlessly) and the pre-live recheck
    // (recheckBeforeLive) renews EXPLICITLY with its own typed handling before any live child.
    const renew = async () => {
      try {
        if (claimed && claimed.open.size) await store.renewClaim({ ids: [...claimed.open.keys()], claimToken: token, leaseSeconds: config.leaseSeconds });
        if (sweep) await keepScanLease();
      } catch (e) {
        stats.renewErrors = (stats.renewErrors || 0) + 1;
        log(`claim / scan keep-alive renew failed (${errCode(e)}) -- continuing; finishes stay claim-token-bound`);
      }
    };
    let failure = null;
    try {
      // (1) epoch rollover: a newer UTC D-1 makes this job moot (tier-1 / the watermark re-detect under the new epoch).
      const epochNow = utcDMinus1(clock());
      if (asOf < epochNow) { for (const j of jobs) await finishJob(j, "superseded", "superseded-by-new-as-of", `as-of ${asOf} < ${epochNow}`); return true; }
      const route = routeOf.get(routeId);
      if (!route) { for (const j of jobs) await finishGate(j, "route-unknown-to-release", "route not declared by this release", 3600, "route-unknown-to-release"); return true; }
      // (2) the trip, the route switch, the GLOBAL scheduler gate and the control lease (deferred WITHOUT an attempt; a
      // READ failure of any of them too -- typed gate-unreadable).
      let liveCtl = ctl;
      { const g = await holdByGates(routeId, region, jobs, ctl); if (g.held) return true; liveCtl = g.ctl; }
      // (3) capacity + the owner activation attestation (config; never an attempt, never a spawn).
      if (childHeapFor(route, config.childMaxOldSpaceMb) == null) { for (const j of jobs) await finishCls(j, CLASSES.CAPACITY_EXCEEDED, `capacity-exceeded:child-heap-cap-${config.childMaxOldSpaceMb}-below-route-minimum-${route.minChildHeapMb}`, { alert: "capacity-exceeded" }); return true; }
      const needs = missingLiveAttestation(config, routeId);
      if (needs) { for (const j of jobs) await finishCls(j, CLASSES.ROUTE_NOT_ACTIVATED, "route-not-activated:attestation-missing:" + needs, { alert: "route-not-activated" }); return true; }
      let ready = jobs;
      // (3b) SCOPE (WP11 verifier F2): an account target that is no longer in the region's DURABLE DIRECTORY (the worker's
      // buildWorkerDirectory == the route CLI's buildDurableDirectory, regionEvidenceAccountIds == its accountInScope rule)
      // would make the route CLI STOP ROUTE_TARGET_OUT_OF_SCOPE for the WHOLE batch. It is SUPERSEDED here (no attempt, no
      // child, alert 'target-out-of-scope'): moot like an epoch rollover and -- unlike a dead job -- never
      // 'dead-same-evidence', so if the account re-enters the directory the watermark / tier-1 re-detect it. An
      // unreadable / empty directory proves nothing -> every job deferred gate-unreadable (no spawn).
      if (route.grain === "account") {
        let dir = null;
        try { dir = await store.readDirectory(); } catch (e) { await gateUnreadable(ready, "durable-directory", e); return true; }
        if (!(dir instanceof Map) || dir.size === 0) { await gateUnreadable(ready, "durable-directory", { code: "DIRECTORY_EMPTY" }); return true; }
        const inScope = new Set(regionEvidenceAccountIds(dir, region));
        const kept = [];
        for (const j of ready) {
          if (inScope.has(S(j.target_key))) { kept.push(j); continue; }
          stats.outOfScope += 1;
          await finishJob(j, "superseded", TARGET_OUT_OF_SCOPE_CLASS, `target-out-of-scope:not-in-the-${region}-durable-directory`, { alert: "target-out-of-scope", recordState: false });
        }
        ready = kept;
        if (!ready.length) return true;
      }
      // (4) LIVE-STATE AWAITS: an open upstream job / a 'stale' upstream state blocks the owner; past the bound, proceed.
      if (route.awaits.length) {
        const candidates = ready;
        ready = [];
        for (const j of candidates) {
          const owners = route.grain === "account" ? [S(j.target_key)] : null; // a region target: any upstream in the region
          let blockers;
          try { blockers = await store.readUpstreamBlockers({ awaits: route.awaits, region, owners, epoch: asOf }); }
          catch (e) { await gateUnreadable([j], "upstream-blockers", e); continue; }
          if (!blockers.length) { ready.push(j); continue; }
          const created = Number(j.created_ms ?? j.created_at);
          const av = awaitVerdict({ openSinceMs: Number.isFinite(created) ? created : clock(), nowMs: clock(), maxMinutes: config.awaitMaxMinutes });
          if (av.cls === CLASSES.AWAIT_TIMEOUT) { stats.awaitTimeouts += 1; j.awaitAlert = "await-timeout"; ready.push(j); continue; }
          stats.awaitDeferred += 1;
          await finishJob(j, "deferred", CLASSES.DEPENDENCY, `awaiting-upstream:${[...new Set(blockers.map((b) => b.route_id))].join("+")}`, { backoff: 180, recordState: false });
        }
        if (!ready.length) return true;
      }
      if (stopping) return true; // shutting down: the finally hands every open job back unexecuted
      const targets = ready.map((j) => S(j.target_key));
      const jobByTarget = new Map(ready.map((j) => [S(j.target_key), j]));
      const alertOf = (j, x) => [j.awaitAlert, x && x.verdict && x.verdict.alerts.join(",")].filter(Boolean).join(",").slice(0, 120) || null;
      // (5) PRE-CHECK: the exact binding (+ the manifest for a route CLI). Current + token-exact -> verified WITHOUT a
      // publish (this is what makes a crash AFTER publish safe).
      const preT0 = clock();
      const pre = await spawn({ route: routeId, region, asOf, kind: supportsVerifyExact(route) ? "verify" : "dry-run", targets });
      await renew();
      if (stopping) return true;
      const preRc = classifyRun(pre);
      if (preRc) {
        for (const j of ready) await finishCls(j, preRc.cls, preRc.reason, { alert: [j.awaitAlert, preRc.alert].filter(Boolean).join(",") || null });
        return true;
      }
      const evPre = new Map(ready.map((j) => [S(j.target_key), { token: j.evidence_token, owners: j.owner_account_ids || [] }]));
      const preRec = await recordRun(route, region, asOf, pre, evPre, { live: false, origin: null, t0: preT0, only: new Set(targets) });
      let toPublish = [];
      for (const tk of targets) {
        const j = jobByTarget.get(tk);
        const x = preRec.byTarget.get(tk);
        if (!x) { await finishCls(j, CLASSES.TRANSPORT, "target-missing-from-targets", { alert: j.awaitAlert || null }); continue; }
        // current -> verified only with the token echo (settleCurrent re-arms / alerts a mismatch).
        if (x.verdict.cls === CLASSES.CURRENT) { await settleCurrent(route, region, asOf, j, x); continue; }
        // ANY stale unit gets the live / repair pass (the worst class decides only the FINAL outcome: one integrity /
        // config unit must never keep a target's other stale units from being repaired). A route CLI that evaluated a
        // DIFFERENT (non-null) token first re-arms onto the worker's current token (never publish for untracked evidence).
        if (hasStaleUnit(x.verdict) && x.verdict.cls !== CLASSES.ZERO_EXPORT_VIOLATION) {
          if (route.kind === "route-cli" && x.target.tok != null && x.target.tok !== j.evidence_token) { await tokenMismatch(route, region, asOf, j, x.target.tok, null); continue; }
          toPublish.push({ tk, j, x });
          continue;
        }
        await finishCls(j, x.verdict.cls, x.verdict.reason, { alert: alertOf(j, x) });
      }
      if (!toPublish.length || stopping) return true;
      // (5b) RE-CHECK every batch-start gate NOW (the claim, the epoch, the trip, control + route switch, the scheduler
      // gate, the control lease): any gate closed -> the same typed outcome as at batch start, ZERO live child.
      {
        const cleared = await recheckBeforeLive(routeId, region, asOf, toPublish);
        toPublish = cleared.items;
        if (!toPublish.length || stopping) return true;
        liveCtl = cleared.ctl || liveCtl;
      }
      // (6) PUBLISH through the route CLI (unique run token; never immediate / scheduler mode; never a full-region live
      // pass). A manifest drift needs a 'repair' pass (--live --verify-exact).
      const kind = route.kind === "route-cli" && toPublish.some(({ x }) => repairKindFor(x.verdict) === "repair") ? "repair" : "live";
      const runToken = makeRunToken({ workerId, route: routeId, region, now: clock() });
      const liveRun = await spawn({ route: routeId, region, asOf, kind, targets: toPublish.map((p) => p.tk), runToken });
      await renew();
      const liveRc = classifyRun(liveRun);
      // A refused argv (runner argsError) spawned NO child: nothing to clean up.
      const abnormal = !liveRun.argsError && (liveRun.timedOut || liveRun.spawnError || (liveRun.exitCode !== 0 && !liveRun.result) || cleanupUnresolved(liveRun));
      if (abnormal && !liveRun.spawnError) {
        const c = await spawn({ route: routeId, region, asOf, kind: "cleanup", runToken });
        log(`cleanup ${routeId}/${region} run=${runToken} -> exit ${c.exitCode} cleaned=${!!(c.result && c.result.cleaned)}`);
        await renew();
      }
      // Shutting down after the (mandatory) cleanup: hand the jobs back; the next start's PRE-CHECK proves whether the
      // interrupted publish landed (verified without re-publishing) or must be retried.
      if (stopping) return true;
      if (liveRc && liveRc.cls === CLASSES.ZERO_EXPORT_VIOLATION) {
        for (const { j } of toPublish) await finishJob(j, "dead", CLASSES.ZERO_EXPORT_VIOLATION, liveRc.reason, { runToken, alert: "zero-export-violation", handoff: HANDOFF_CLASSES.FAILED });
        return true;
      }
      const liveTargets = runTargets(liveRun);
      const fencedUnits = await noteWriterFenced(route, region, asOf, liveRun);
      // (7) VERIFY with the exact binding + the served-row read-back (--verify-exact for a route CLI).
      const verT0 = clock();
      const ver = await spawn({ route: routeId, region, asOf, kind: supportsVerifyExact(route) ? "verify" : "dry-run", targets: toPublish.map((p) => p.tk) });
      if (stopping) return true;
      const verRc = classifyRun(ver);
      if (verRc && verRc.cls === CLASSES.ZERO_EXPORT_VIOLATION) {
        for (const { j } of toPublish) await finishJob(j, "dead", CLASSES.ZERO_EXPORT_VIOLATION, verRc.reason, { runToken, alert: "zero-export-violation", handoff: HANDOFF_CLASSES.FAILED });
        return true;
      }
      const verRec = verRc ? { byTarget: new Map() } : await recordRun(route, region, asOf, ver, evPre, { live: false, origin: null, t0: verT0, only: new Set(toPublish.map((p) => p.tk)) });
      const repaired = [];
      for (const { tk, j } of toPublish) {
        const vx = verRec.byTarget.get(tk);
        if (vx && vx.verdict.cls === CLASSES.CURRENT) {
          // 'published' (hand-off repaired; a v1 sticky served-proof revocation reset) ONLY when THIS job's live child
          // actually published a unit -- a concurrent scheduler / backstop run may have written the row between the
          // pre-check and the live child (final-review P3-3 / e2e S4c): then it is already-current, not repaired.
          // A live child that RAN but left no unit evidence for the target (crashed after a fenced CAS, no TARGETS line --
          // e2e S6b) may well have written: counted published. No child at all (a refused argv / spawn error) never is.
          const lt0 = liveTargets.get(tk);
          const ranChild = !liveRun.argsError && !liveRun.spawnError;
          const publishedByUs = !ranChild ? false
            : (!lt0 || !Array.isArray(lt0.units)) ? true
              : lt0.units.some((u) => S(u.s) === STATES.PUBLISHED || S(u.s) === STATES.READBACK_VERIFIED);
          // A live child that OOMed / hard-timed out / STOPped / left its cleanup unresolved, followed by a CURRENT verify,
          // still carries that child's alert (final review P3: formerly dropped on the verified path).
          const d = await settleCurrent(route, region, asOf, j, vx, { runToken, published: publishedByUs, extraAlerts: [liveRc && liveRc.alert] });
          if (d === "verified") repaired.push(j);
          continue;
        }
        if (vx && route.kind === "route-cli" && vx.target.tok != null && vx.target.tok !== j.evidence_token && hasStaleUnit(vx.verdict)) { await tokenMismatch(route, region, asOf, j, vx.target.tok, runToken); continue; }
        const lt = liveTargets.get(tk);
        const lv = lt ? jobVerdict(lt, verdictReportKeys(route), classifyCtx(route, asOf, verT0)) : null;
        let cls, reason;
        if (liveRc) { cls = liveRc.cls; reason = liveRc.reason; }
        else if (lv && lv.cls !== CLASSES.PUBLISHED_UNVERIFIED && lv.cls !== CLASSES.CURRENT) { cls = lv.cls; reason = lv.reason; }
        else if (verRc) { cls = CLASSES.TRANSPORT; reason = "verify-" + S(verRc.reason); }
        else if (vx && vx.verdict.cls === CLASSES.STALE) { cls = CLASSES.READBACK_MISMATCH; reason = "published-but-binding-still-stale:" + S(vx.verdict.reason); }
        else { cls = vx ? vx.verdict.cls : CLASSES.TRANSPORT; reason = vx ? vx.verdict.reason : "target-missing-from-verify"; }
        const fencedAlert = fencedUnits && lt && lt.units.some((u) => WRITER_FENCED_RE.test(S(u.r))) ? REPORT_WRITER_FENCED_EVENT : null;
        // The alert is the UNION over every verdict consulted (the run-level live class, the live pass's own typed units,
        // the verify pass), deduplicated -- the class may come from the live verdict while the verify verdict carries no
        // alert, and a live-pass typed alert (e.g. storage-missing) must never be dropped (WP14 e2e finding S9).
        const alertParts = [fencedAlert, liveRc && liveRc.alert, alertOf(j, lv ? { verdict: lv } : null), alertOf(j, vx)]
          .filter(Boolean).flatMap((a) => S(a).split(",")).filter(Boolean);
        await finishCls(j, cls, reason, { runToken, alert: [...new Set(alertParts)].join(",").slice(0, 120) || null });
      }
      // (8) DEPENDENTS of a verified PUBLISH (origin 'dependency').
      if (repaired.length) await enqueueDependents(route, region, asOf, liveCtl, repaired);
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
          else await finishJob(j, "released", "released", "batch-aborted", { recordState: false });
        } catch { /* lease expiry reclaims */ }
      }
      claimed = null;
    }
  }

  async function tick() {
    stats.polls += 1;
    await heartbeat("running");
    await watermarkPass();
    if (stopping) return false;
    const scanned = await tier1Scan();
    if (stopping) return scanned;
    const swept = await deepSweepStep();
    if (stopping) return scanned || swept;
    const processed = await processOneBatch();
    return scanned || swept || processed;
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
   * Graceful stop: stop claiming and starting children. A running READ-ONLY child (a sweep step, a pre-check or a
   * verify: kind 'dry-run' | 'verify') is terminated after the grace window -- it writes nothing, and its jobs are
   * handed back without burning an attempt. A LIVE / REPAIR / CLEANUP child is NEVER terminated here: the releases
   * finalize a cycle before publishing, so a kill in that window would strand the revision's cycle; each is bounded by
   * its own --deadline-seconds and the runner's hard timeout (the systemd TimeoutStopSec covers that bound).
   */
  function stop() {
    stopping = true;
    const cur = currentChild;
    if (cur && (cur.kind === "dry-run" || cur.kind === "verify")) {
      const t = setTimeout(() => { try { cur.child.kill("SIGTERM"); } catch { /* ignore */ } }, config.stopGraceSeconds * 1000);
      t.unref?.();
    }
  }

  return { tick, runForever, stop, watermarkPass, tier1Scan, deepSweepStep, processOneBatch, stats, get stopping() { return stopping; }, tripped };
}
