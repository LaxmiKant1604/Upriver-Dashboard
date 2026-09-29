// Publication recovery worker -- configuration validation (WP11: route-based). Reads process env (already loaded from the
// protected VM env file); NEVER returns or logs a secret value -- only presence booleans for the secret-bearing variables.
// Every behaviour flag is OFF / safe by default: no live route (PRW_LIVE_ROUTES empty = observe-only), no shadow prune,
// no attestation. PRW_LIVE_FAMILIES (the ffb035b four-family switch) is RETIRED: setting it is a configuration error
// (never silently ignored, never mapped -- the operator must choose route ids explicitly).

import os from "node:os";
import { ROUTE_IDS, PUBLICATION_ROUTES } from "./routes.js";
import { ROUTE_REGIONS } from "./route-contract.js";
import { CLEANUP_HARD_TIMEOUT_SECONDS } from "./runner.js";

const REGIONS = ROUTE_REGIONS;

const intIn = (raw, def, min, max, name, errors) => {
  if (raw == null || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) { errors.push(`${name} must be an integer in [${min}, ${max}]`); return def; }
  return n;
};
const listOf = (raw, allowed, name, errors) => {
  const items = String(raw || "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const i of items) if (!allowed.includes(i)) errors.push(`${name} contains unknown value '${i.slice(0, 60)}' (allowed: ${allowed.join(",")})`);
  return [...new Set(items.filter((i) => allowed.includes(i)))];
};
const boolFlag = (raw, name, errors) => {
  if (raw == null || raw === "" || raw === "false") return false;
  if (raw === "true") return true;
  errors.push(`${name} must be exactly 'true' or 'false'`);
  return false;
};
// Attestations are read EXACTLY like the route CLI reads them: only the literal 'true' attests (anything else = not).
const attested = (raw) => raw === "true";

const WINDOW_RE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;
/**
 * PRW_SCHEDULER_WINDOWS: optional comma-separated 'HH:MM-HH:MM' UTC windows during which the scheduler owns the
 * control plane (the worker defers, no attempt). A window may wrap midnight ('23:30-01:00'); a zero-length window is
 * invalid. -> [{ from, to }] in minutes of the UTC day.
 */
export function parseSchedulerWindows(raw, errors = []) {
  const out = [];
  for (const part of String(raw || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = WINDOW_RE.exec(part);
    if (!m) { errors.push(`PRW_SCHEDULER_WINDOWS entry '${part.slice(0, 20)}' must be HH:MM-HH:MM (UTC)`); continue; }
    const from = Number(m[1]) * 60 + Number(m[2]); const to = Number(m[3]) * 60 + Number(m[4]);
    if (from === to) { errors.push(`PRW_SCHEDULER_WINDOWS entry '${part}' is empty`); continue; }
    out.push(Object.freeze({ from, to }));
  }
  return out;
}

/** True when the UTC instant `nowMs` falls inside any scheduler window ([from, to), wrapping midnight). */
export function inSchedulerWindow(windows, nowMs) {
  const d = new Date(Number(nowMs));
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return (Array.isArray(windows) ? windows : []).some((w) => (w.from < w.to ? m >= w.from && m < w.to : m >= w.from || m < w.to));
}

// Per-route OWNER ACTIVATION ATTESTATIONS the worker checks BEFORE spawning a LIVE child (defense in depth: the route CLI
// itself refuses a live write without them). A missing attestation defers the job route-not-activated (config; no attempt
// consumed, alert) -- never a failure loop:
//   fba-plan      FBA_PLAN_ROUTE_FENCE_ATTESTED     only after WP10b is deployed AND the WP15 fence has fba-plan fenced_only
//   sku-movement  SKU_MOVEMENT_SERVE_TOKEN_ATTESTED only after the WP10 serve (sms2 serve token) is DEPLOYED
//   listings      LHV3_SERVE_GATE_ATTESTED          the owner attests both Vercel prod flags LHV3_PUBLISH_LIVE + LISTING_HEALTH_V3
export const ROUTE_LIVE_ATTESTATIONS = Object.freeze({ "fba-plan": "fbaPlanRouteFence", "sku-movement": "skuMovementServeToken", listings: "lhv3ServeGate" });
// PRW_LIVE_ROUTES CONFIG GATE (WP11 fixer P2a): naming one of these routes live WITHOUT its attestation is a
// configuration ERROR (the worker refuses to start) -- without it the route can never publish AND verify live
// (fba-plan: its CLI refuses every live write, 'fba-plan-route-fence-not-attested'; sku-movement: its CLI defers every
// live write, 'sku-movement-serve-not-attested:route-not-activated' -- the legacy serve would re-derive every
// route-stamped row, so a publish could never be read back as served), so the combination is contradictory, never a
// silent observe-only. The env
// var is compared EXACTLY like the CLI reads it (only the literal 'true'). 'listings' is deliberately NOT here: its
// live path (the pre-existing zero-export LHv3 reconciler, scripts/release/listing-health-v3-reconcile.mjs) never reads
// LHV3_SERVE_GATE_ATTESTED -- only the LHv3 INGESTION CLI's served-row proof does -- so the worker keeps it as the
// runtime live-pass deferral above (missingLiveAttestation -> route-not-activated), not a startup error.
export const LIVE_ROUTE_CONFIG_ATTESTATIONS = Object.freeze({ "fba-plan": "FBA_PLAN_ROUTE_FENCE_ATTESTED", "sku-movement": "SKU_MOVEMENT_SERVE_TOKEN_ATTESTED" });
/** The attestation a route's LIVE pass needs but the config lacks (null when none is needed or it is present). */
export function missingLiveAttestation(config, routeId) {
  const need = ROUTE_LIVE_ATTESTATIONS[routeId];
  if (!need) return null;
  return config && config.attestations && config.attestations[need] === true ? null : need;
}

/** Validate + build the worker config. Returns { ok, config, errors }. */
export function loadRecoveryConfig(env = process.env) {
  const errors = [];
  // Secret-bearing variables: presence only (the CLIs need all four: Postgres for the control store, Supabase REST for
  // snapshots, and the DataDoe key for the zero-token account-directory GET -- never an export).
  const present = {
    POSTGRES_URL: !!String(env.POSTGRES_URL || "").trim(),
    SUPABASE_URL: !!String(env.SUPABASE_URL || env.VITE_SUPABASE_URL || "").trim(),
    SUPABASE_SERVICE_ROLE_KEY: !!String(env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY || "").trim(),
    DATADOE_API_KEY: !!String(env.DATADOE_API_KEY || "").trim(),
  };
  for (const [k, v] of Object.entries(present)) if (!v) errors.push(`${k} is not set (required; never printed)`);
  if (env.PRW_LIVE_FAMILIES != null && String(env.PRW_LIVE_FAMILIES).trim() !== "") errors.push("PRW_LIVE_FAMILIES is RETIRED (route registry): set PRW_LIVE_ROUTES to explicit route ids instead (" + ROUTE_IDS.join(",") + ")");
  const pollSeconds = intIn(env.PRW_POLL_SECONDS, 20, 15, 120, "PRW_POLL_SECONDS", errors);
  const scanIntervalSeconds = intIn(env.PRW_SCAN_INTERVAL_SECONDS, 600, 300, 3600, "PRW_SCAN_INTERVAL_SECONDS", errors);
  // Cross-pass reuse of SHARED evidence (the Ads digest partials) while its table's change probe is unchanged: the hard
  // cap in seconds (0 = off: every pass scans, as before). Only detection can be delayed by it (never a verification).
  const sharedEvidenceReuseSeconds = intIn(env.PRW_SHARED_EVIDENCE_REUSE_SECONDS, 3600, 0, 3600, "PRW_SHARED_EVIDENCE_REUSE_SECONDS", errors);
  const batch = intIn(env.PRW_BATCH, 5, 1, 10, "PRW_BATCH", errors);
  const leaseSeconds = intIn(env.PRW_LEASE_SECONDS, 2700, 1500, 7200, "PRW_LEASE_SECONDS", errors);
  const maxAttempts = intIn(env.PRW_MAX_ATTEMPTS, 6, 2, 20, "PRW_MAX_ATTEMPTS", errors);
  const maxClaims = intIn(env.PRW_MAX_CLAIMS, 8, 3, 30, "PRW_MAX_CLAIMS", errors);
  // The per-job evidence-advanced RE-ARM bound (20260934 finish p_max_rearms): past it the job is alerted
  // 'evidence-rearm-bound' and backs off 600 s (a token that keeps moving never becomes a hot loop).
  const maxRearms = intIn(env.PRW_MAX_REARMS, 12, 3, 100, "PRW_MAX_REARMS", errors);
  // Ceiling 512: the worker heap (160) + one child heap + V8/native overhead must stay under the unit's MemoryMax=850M.
  const childMaxOldSpaceMb = intIn(env.PRW_CHILD_MAX_OLD_SPACE_MB, 448, 192, 512, "PRW_CHILD_MAX_OLD_SPACE_MB", errors);
  const keepDays = intIn(env.PRW_KEEP_DAYS, 14, 3, 90, "PRW_KEEP_DAYS", errors);
  const stopGraceSeconds = intIn(env.PRW_STOP_GRACE_SECONDS, 60, 5, 240, "PRW_STOP_GRACE_SECONDS", errors);
  const schedulerCooldownSeconds = intIn(env.PRW_SCHEDULER_COOLDOWN_SECONDS, 900, 300, 3600, "PRW_SCHEDULER_COOLDOWN_SECONDS", errors);
  const deepSweepHours = intIn(env.PRW_DEEP_SWEEP_HOURS, 6, 1, 24, "PRW_DEEP_SWEEP_HOURS", errors);
  const awaitMaxMinutes = intIn(env.PRW_AWAIT_MAX_MINUTES, 120, 10, 720, "PRW_AWAIT_MAX_MINUTES", errors);
  const schedulerWindows = parseSchedulerWindows(env.PRW_SCHEDULER_WINDOWS, errors);
  const shadowPrune = boolFlag(env.PRW_SHADOW_PRUNE, "PRW_SHADOW_PRUNE", errors);
  const liveRoutes = listOf(env.PRW_LIVE_ROUTES, ROUTE_IDS, "PRW_LIVE_ROUTES", errors);
  for (const [id, envVar] of Object.entries(LIVE_ROUTE_CONFIG_ATTESTATIONS)) {
    if (liveRoutes.includes(id) && !attested(env[envVar])) errors.push(`PRW_LIVE_ROUTES names '${id}' but ${envVar} is not exactly 'true' (the route cannot publish + verify live without it) -- remove '${id}' or set the owner attestation`);
  }
  // The job claim must outlive a live job's whole child sequence (pre-check + live + verify at the route's hard timeout,
  // plus a cleanup) for every live route.
  const needLease = Math.max(0, ...PUBLICATION_ROUTES.filter((r) => liveRoutes.includes(r.id)).map((r) => 3 * r.hardTimeoutSeconds + CLEANUP_HARD_TIMEOUT_SECONDS));
  if (leaseSeconds < needLease) errors.push(`PRW_LEASE_SECONDS=${leaseSeconds} is shorter than the live routes' child sequence (${needLease}s = 3 x hard timeout + cleanup)`);
  const regions = env.PRW_REGIONS ? listOf(env.PRW_REGIONS, REGIONS, "PRW_REGIONS", errors) : [...REGIONS];
  if (!regions.length) errors.push("PRW_REGIONS resolved to an empty set");
  const workerId = String(env.PRW_WORKER_ID || `${os.hostname()}-${process.pid}`).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 120);
  const config = Object.freeze({
    workerId, host: os.hostname().slice(0, 120), pollSeconds, scanIntervalSeconds, sharedEvidenceReuseSeconds, scanLeaseSeconds: Math.max(900, leaseSeconds),
    batch, leaseSeconds, maxAttempts, maxClaims, maxRearms, childMaxOldSpaceMb, keepDays, stopGraceSeconds,
    schedulerCooldownSeconds, schedulerWindows: Object.freeze(schedulerWindows), deepSweepHours, awaitMaxMinutes, shadowPrune,
    liveRoutes: Object.freeze(liveRoutes),
    regions: Object.freeze(regions), concurrency: 1,
    // Attestations the children read (only the literal 'true'); surfaced for classification context + status.
    attestations: Object.freeze({
      skuMovementServeToken: attested(env.SKU_MOVEMENT_SERVE_TOKEN_ATTESTED),
      fbaPlanRouteFence: attested(env.FBA_PLAN_ROUTE_FENCE_ATTESTED),
      lhv3ServeGate: attested(env.LHV3_SERVE_GATE_ATTESTED),
    }),
    secretsPresent: Object.freeze(present),
  });
  return { ok: errors.length === 0, config, errors };
}
