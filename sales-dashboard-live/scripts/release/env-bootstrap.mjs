// PORTABLE env bootstrap for the release + scheduler operators.
//
// Replaces the old machine-specific `const repoRoot = "C:/Users/.../Upriver-Dashboard"` boilerplate. It:
//   - resolves the repo + app roots from THIS module's own location (import.meta.url), never a hardcoded path,
//     so the operators run unchanged on a developer laptop AND on a GitHub Actions ubuntu runner;
//   - loads <repoRoot>/.env.local ONLY when the file exists (GitHub Actions injects env directly, no file);
//   - NEVER overrides a variable already present in process.env, so CI-supplied secrets always win over the file;
//   - maps SUPABASE_URL from VITE_SUPABASE_URL only when SUPABASE_URL is not already set;
//   - NEVER prints a secret (it returns only which file was loaded + the resolved roots, never any value).

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// This module lives at <repo>/sales-dashboard-live/scripts/release/env-bootstrap.mjs, so the roots are fixed
// offsets from HERE regardless of the caller's location or the process working directory.
const HERE = dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = resolve(HERE, "..", "..");        // <repo>/sales-dashboard-live
export const REPO_ROOT = resolve(HERE, "..", "..", "..");  // <repo>

// Parse a dotenv-style file body into a plain object (last assignment wins). Surrounding single/double quotes
// are stripped. Pure + side-effect free so it is trivially unit-testable.
export function parseEnvFile(text) {
  const out = {};
  for (const line of String(text == null ? "" : text).split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

// Apply an optional env file onto a target env map, fail-soft + CI-first. Injectable fs seams (exists/read) +
// the target env make it fully offline-testable with NO real files. Returns { loadedEnvFile, mappedSupabaseUrl }
// (booleans only -- never any value). Contract:
//   - the file is read ONLY when `exists(envFilePath)` is true (absent file => no throw, just skipped);
//   - a key already present in `env` is NEVER overwritten (CI/GitHub-Actions-supplied secrets win);
//   - SUPABASE_URL is filled from VITE_SUPABASE_URL only when SUPABASE_URL is still unset afterwards.
export function applyEnv({ envFilePath = null, env = process.env, exists = existsSync, read = (p) => readFileSync(p, "utf8") } = {}) {
  const loadedEnvFile = Boolean(envFilePath && exists(envFilePath));
  if (loadedEnvFile) {
    const parsed = parseEnvFile(read(envFilePath));
    for (const key of Object.keys(parsed)) {
      if (env[key] === undefined) env[key] = parsed[key]; // NEVER override an already-set (CI) variable
    }
  }
  let mappedSupabaseUrl = false;
  if (!env.SUPABASE_URL && env.VITE_SUPABASE_URL) { env.SUPABASE_URL = env.VITE_SUPABASE_URL; mappedSupabaseUrl = true; }
  return { loadedEnvFile, mappedSupabaseUrl };
}

// Production entry point the operators call once at startup. Loads <repoRoot>/.env.local when present and maps
// SUPABASE_URL. Returns the resolved roots + which file was loaded (no secret values).
export function loadReleaseEnv() {
  const info = applyEnv({ envFilePath: resolve(REPO_ROOT, ".env.local") });
  return { ...info, appRoot: APP_ROOT, repoRoot: REPO_ROOT };
}

// TYPED fail-closed config gate. Call this AFTER loadReleaseEnv() and BEFORE importing any lib/server module that
// reads Supabase creds at module-evaluation time (supabase.js captures SUPABASE_URL + SUPABASE_SECRET_KEY into
// module-level constants the instant it is imported). If the URL or the service/secret key is unavailable, this
// throws a typed RELEASE_CONFIG_UNAVAILABLE error so the operator STOPS on an honest configuration failure --
// it must NEVER be silently degraded into "zero accounts" / "no accounts discovered". Never prints a secret
// value (only which variable name is missing). Returns true when configured. Pure w.r.t. the injected env map.
export function assertSupabaseReleaseConfig(env = process.env) {
  const url = String(env.SUPABASE_URL || env.VITE_SUPABASE_URL || "").trim();
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY || "").trim();
  if (!url || !key) {
    const missing = [
      !url && "SUPABASE_URL (or VITE_SUPABASE_URL)",
      !key && "SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY)",
    ].filter(Boolean).join(" + ");
    const err = new Error(
      "RELEASE_CONFIG_UNAVAILABLE: " + missing + " is not configured. This is a CONFIGURATION failure -- it is NOT "
      + "'zero accounts' / 'no accounts discovered'. Populate the release environment (load .env.local, or inject "
      + "the CI secrets) BEFORE importing any lib/server module that captures Supabase credentials at import time."
    );
    err.code = "RELEASE_CONFIG_UNAVAILABLE";
    throw err;
  }
  return true;
}
