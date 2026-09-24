// Publication recovery worker -- configuration validation. Reads process env (already loaded from the protected VM env
// file); NEVER returns or logs a secret value -- only presence booleans for the secret-bearing variables.

import os from "node:os";

const FAMILIES = ["oli", "fba", "ads", "listings"];
const REGIONS = ["india", "europe-au", "us-ca"];

const intIn = (raw, def, min, max, name, errors) => {
  if (raw == null || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) { errors.push(`${name} must be an integer in [${min}, ${max}]`); return def; }
  return n;
};
const listOf = (raw, allowed, name, errors) => {
  const items = String(raw || "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const i of items) if (!allowed.includes(i)) errors.push(`${name} contains unknown value '${i}' (allowed: ${allowed.join(",")})`);
  return [...new Set(items.filter((i) => allowed.includes(i)))];
};

/** Validate + build the worker config. Returns { ok, config, errors }. */
export function loadRecoveryConfig(env = process.env) {
  const errors = [];
  // Secret-bearing variables: presence only (the reconciler CLIs need all four: Postgres for the control store, Supabase
  // REST for snapshots, and the DataDoe key for the zero-token account-directory GET -- never an export).
  const present = {
    POSTGRES_URL: !!String(env.POSTGRES_URL || "").trim(),
    SUPABASE_URL: !!String(env.SUPABASE_URL || env.VITE_SUPABASE_URL || "").trim(),
    SUPABASE_SERVICE_ROLE_KEY: !!String(env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY || "").trim(),
    DATADOE_API_KEY: !!String(env.DATADOE_API_KEY || "").trim(),
  };
  for (const [k, v] of Object.entries(present)) if (!v) errors.push(`${k} is not set (required; never printed)`);
  const pollSeconds = intIn(env.PRW_POLL_SECONDS, 20, 15, 120, "PRW_POLL_SECONDS", errors);
  const scanIntervalSeconds = intIn(env.PRW_SCAN_INTERVAL_SECONDS, 600, 300, 3600, "PRW_SCAN_INTERVAL_SECONDS", errors);
  const batch = intIn(env.PRW_BATCH, 5, 1, 10, "PRW_BATCH", errors);
  const leaseSeconds = intIn(env.PRW_LEASE_SECONDS, 2400, 1500, 7200, "PRW_LEASE_SECONDS", errors); // > LHv3 840s hard timeout x (dry-run + live + verify)
  const maxAttempts = intIn(env.PRW_MAX_ATTEMPTS, 6, 2, 20, "PRW_MAX_ATTEMPTS", errors);
  const maxClaims = intIn(env.PRW_MAX_CLAIMS, 8, 3, 30, "PRW_MAX_CLAIMS", errors);
  // Ceiling 512: the worker heap (160) + one child heap + V8/native overhead must stay under the unit's MemoryMax=850M.
  const childMaxOldSpaceMb = intIn(env.PRW_CHILD_MAX_OLD_SPACE_MB, 448, 192, 512, "PRW_CHILD_MAX_OLD_SPACE_MB", errors);
  const keepDays = intIn(env.PRW_KEEP_DAYS, 14, 3, 90, "PRW_KEEP_DAYS", errors);
  const stopGraceSeconds = intIn(env.PRW_STOP_GRACE_SECONDS, 60, 5, 240, "PRW_STOP_GRACE_SECONDS", errors);
  const liveFamilies = listOf(env.PRW_LIVE_FAMILIES, FAMILIES, "PRW_LIVE_FAMILIES", errors);
  const regions = env.PRW_REGIONS ? listOf(env.PRW_REGIONS, REGIONS, "PRW_REGIONS", errors) : [...REGIONS];
  if (!regions.length) errors.push("PRW_REGIONS resolved to an empty set");
  const workerId = String(env.PRW_WORKER_ID || `${os.hostname()}-${process.pid}`).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 120);
  const config = Object.freeze({
    workerId, host: os.hostname().slice(0, 120), pollSeconds, scanIntervalSeconds, scanLeaseSeconds: Math.max(900, leaseSeconds),
    batch, leaseSeconds, maxAttempts, maxClaims, childMaxOldSpaceMb, keepDays, stopGraceSeconds,
    liveFamilies: Object.freeze(liveFamilies), regions: Object.freeze(regions), concurrency: 1,
    secretsPresent: Object.freeze(present),
  });
  return { ok: errors.length === 0, config, errors };
}
