// THROWAWAY strictly READ-ONLY digest diagnostic (Scheduler-v2 release, blocker 1/2).
// Computes, inside BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY (ROLLBACK in finally):
//   * for live + scheduler-v2/* shadow report_snapshots -- BOTH digest algorithms:
//       OLD:        md5( string_agg( md5(row::text), '|' ORDER BY md5(row::text) ) )
//       HISTORICAL: md5( string_agg( md5(row::text), ',' ORDER BY natural_key ) )   (Appendix W runbook)
//     and reports which (if either) matches BOTH pinned Appendix-AI count/hash pairs.
//   * the HISTORICAL count+hash for ALL eight protected datasets (candidate manifest pins).
// Never prints payloads, credentials, or connection strings. Writes NOTHING. Never updates pinned values.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { validateIdentity, PROTECTED_DIGESTS, PROTECTED_DIGEST_KEYS } from "./release-manifest.mjs";
import { captureProtectedDigest, beginReadOnlySnapshot } from "./release-state.mjs";
import { parseEnv } from "./release-fs.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const env = parseEnv(readFileSync(path.resolve(repoRoot, ".env.local"), "utf8"));

const id = validateIdentity(env);
console.log(`IDENTITY  approved_ref=${id.projectRef} host=${id.pgHost}:${id.pgPort} ok=${id.ok}`);
if (!id.ok) { console.error("STOP identity: " + id.problems.join("; ")); process.exit(1); }

const NK = "(report_key || '/' || account_id || '/' || params_hash)";
const oldAlgo = async (q, where) => {
  const r = (await q(`select coalesce(md5(string_agg(md5(t::text), '|' order by md5(t::text))), 'EMPTY') h, count(*)::int c from public.report_snapshots t where ${where}`, [])).rows[0];
  return { c: Number(r.c), h: r.h };
};
const histSnap = async (q, where) => {
  const r = (await q(`select coalesce(md5(string_agg(md5(t::text), ',' order by ${NK})), 'EMPTY') h, count(*)::int c from public.report_snapshots t where ${where}`, [])).rows[0];
  return { c: Number(r.c), h: r.h };
};
const eq = (a, b) => a && b && a.c === b.c && a.h === b.h;

const u = new URL(env.POSTGRES_URL); u.searchParams.set("sslmode", "no-verify");
const client = new pg.Client({ connectionString: u.toString() });
const q = (t, p) => client.query(t, p);
await client.connect();
try {
  await beginReadOnlySnapshot(client);
  const liveWhere = "report_key not like 'scheduler-v2/%'";
  const shadowWhere = "report_key like 'scheduler-v2/%'";
  const oldLive = await oldAlgo(q, liveWhere), oldShadow = await oldAlgo(q, shadowWhere);
  const histLive = await histSnap(q, liveWhere), histShadow = await histSnap(q, shadowWhere);
  const pinL = PROTECTED_DIGESTS.live_snapshots, pinS = PROTECTED_DIGESTS.shadow_snapshots;

  console.log(`LIVE    count=${oldLive.c}  OLD=${oldLive.h}  HIST=${histLive.h}  pinned=${pinL.h}`);
  console.log(`SHADOW  count=${oldShadow.c}  OLD=${oldShadow.h}  HIST=${histShadow.h}  pinned=${pinS.h}`);
  const oldMatches = eq(oldLive, pinL) && eq(oldShadow, pinS);
  const histMatches = eq(histLive, pinL) && eq(histShadow, pinS);
  console.log(`MATCH   old_algo_matches_both=${oldMatches}  historical_algo_matches_both=${histMatches}`);
  if (histMatches && !oldMatches) console.log("PROVEN  the HISTORICAL (Appendix W) algorithm reproduces both pinned pairs -> retain it in the checker.");
  else if (oldMatches && !histMatches) console.log("NOTE    the OLD algorithm matches (unexpected) -- report to Codex; do not change pins.");
  else console.log("STOP    NEITHER (or BOTH/ambiguous) algorithm reproduces the pinned pairs -- report exact counts/hashes above; do not change pins.");

  // Candidate manifest pins for ALL protected datasets (HISTORICAL algorithm), for blocker-2 pinning.
  const all = await captureProtectedDigest(q);
  console.log("\nCANDIDATE MANIFEST PINS (historical algorithm):");
  for (const k of PROTECTED_DIGEST_KEYS) console.log(`  ${k}: { c: ${all[k].c}, h: "${all[k].h}" }${PROTECTED_DIGESTS[k] ? "   (already pinned: " + (eq(all[k], PROTECTED_DIGESTS[k]) ? "MATCH" : "DIFFERS!") + ")" : ""}`);
} finally {
  try { await client.query("ROLLBACK"); } catch {}
  await client.end();
}
