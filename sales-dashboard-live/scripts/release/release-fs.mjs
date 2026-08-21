// Local fs/crypto helpers for the release scripts (env parse, git HEAD, manifest fingerprint). Kept separate
// so release-manifest.mjs / release-state.mjs stay pure over an injected q and remain offline-testable.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export function parseEnv(text) {
  const v = {};
  for (const line of String(text).replace(/^﻿/, "").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/); if (!m) continue;
    let val = m[2]; if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    v[m[1]] = val;
  }
  return v;
}

// Resolve the current commit sha from a .git directory without spawning git.
export function readGitHead(gitDir) {
  const head = readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
  if (!head.startsWith("ref:")) return head; // detached HEAD is a raw sha
  const ref = head.slice(4).trim();
  try { return readFileSync(path.join(gitDir, ref), "utf8").trim(); }
  catch {
    const packed = readFileSync(path.join(gitDir, "packed-refs"), "utf8");
    for (const line of packed.split(/\r?\n/)) { const m = line.match(/^([0-9a-f]{40})\s+(.+)$/); if (m && m[2] === ref) return m[1]; }
    throw new Error("cannot resolve HEAD ref " + ref);
  }
}

// A fingerprint over the release LOGIC (manifest + engine + both scripts + this helper) so a stale/edited
// baseline is rejected if any release logic changed since it was created.
const FINGERPRINT_FILES = ["release-manifest.mjs", "release-state.mjs", "release-fs.mjs", "ro-prod-check.mjs", "apply-one-migration.mjs"];
export function manifestFingerprint(releaseDir) {
  const h = createHash("sha256");
  for (const f of FINGERPRINT_FILES) { h.update(f + "\0"); h.update(readFileSync(path.join(releaseDir, f))); h.update("\0"); }
  return h.digest("hex");
}

// The env's actual SUPABASE_URL project ref (for the environment-switch cross-check in validateBaseline).
export function envProjectRef(env) {
  try { return new URL(env.SUPABASE_URL).host.split(".")[0]; } catch { return null; }
}
