// Publication recovery -- the STUCK-CYCLE REAPER (an OPERATOR tool; NOT part of the worker runtime: the worker's import
// graph never names a cycle-finalize RPC -- scripts/worker-closure.test.js W3 -- and the worker never writes a sync table).
//
//   node scripts/worker/publication-recovery-reaper.mjs                                     # READ-ONLY: list candidates
//   node scripts/worker/publication-recovery-reaper.mjs --apply --cycle-id=<uuid> --confirm=<uuid>   # finalize ONE cycle
//
// Candidates (store-pg.js reaperCandidates, over the SAME metadata the worker's global scheduler gate reads):
//   finalize-orphan-partial  a RUNNING priority-partial cycle of a PAST epoch (cycle_date < the current UTC D-1) past 2 x the
//                            longest route hard timeout with ZERO report and source jobs (a crash between the cycle claim
//                            and the job upsert) -> the guarded finalize_sync_cycle yields 'succeeded', report_total 0. A
//                            CURRENT-epoch orphan is 'never': the next run with the same evidence resumes it, and
//                            finalizing it would dead-letter that target ('cycle-not-running') for the rest of the day;
//   finalize-drained         a RUNNING scheduler-owned / paid cycle idle > 6 h whose every job is finished (the process died
//                            after draining) -> the guarded finalize applies the counters;
//   never                    a priority-partial cycle holding ANY job (pending / failed: e.g. the LHv3 salted foreign-retry
//                            cycle -- finalizing it could strand the retry) and any cycle with an OPEN job. An open stuck
//                            PAID fba cycle is superseded by the next natural paid cycle, or needs the reviewed paid re-run.
// --apply finalizes EXACTLY ONE cycle, only when --confirm repeats its id and a FRESH re-read still classifies it
// finalize-*; the RPC itself re-checks the whole cycle under FOR UPDATE (it answers 'open-work' rather than close a cycle
// that gained a job). Every run needs owner sign-off (README "Stuck cycles"). Prints ids / buckets / counts only.

import { loadReleaseEnv } from "../release/env-bootstrap.mjs";
loadReleaseEnv();
const argOf = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.split("=").slice(1).join("=") : null; };
if (!String(process.env.POSTGRES_URL || "").trim()) { console.error("STOP POSTGRES_URL not set"); process.exit(2); }
const pg = (await import("pg")).default;
const { recoveryPoolConfig, SCHEDULER_GATE_SQL, reaperCandidates } = await import("../../lib/server/recovery/store-pg.js");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const apply = process.argv.includes("--apply");
const cycleId = argOf("cycle-id");
if (apply && (!UUID_RE.test(String(cycleId || "")) || argOf("confirm") !== cycleId)) { console.error("STOP --apply needs --cycle-id=<uuid> and --confirm=<the same uuid>"); process.exit(2); }
let client;
try { client = new pg.Client(recoveryPoolConfig(process.env.POSTGRES_URL, { max: 1 })); await client.connect(); }
catch (e) { console.error("STOP database unreachable: " + String((e && e.code) || "error")); process.exit(3); }
const readCandidates = async () => {
  await client.query("begin transaction read only");
  // The current epoch = the UTC D-1 (toISOString is UTC; never a local-timezone date).
  const epoch = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  try { await client.query("set local statement_timeout = '60s'"); const rows = (await client.query(SCHEDULER_GATE_SQL, [0])).rows; await client.query("commit"); return reaperCandidates(rows, { epoch }); }
  catch (e) { try { await client.query("rollback"); } catch { /* ignore */ } throw e; }
};
try {
  const cands = await readCandidates();
  if (!apply) { console.log(JSON.stringify({ mode: "read-only", candidates: cands }, null, 1)); await client.end(); process.exit(0); }
  const c = cands.find((x) => x.id === cycleId);
  if (!c || !c.action.startsWith("finalize-")) { console.log(JSON.stringify({ mode: "apply", cycleId, refused: c ? c.why : "not a current candidate (fresh re-read)" })); await client.end(); process.exit(1); }
  await client.query("begin");
  let result;
  try { await client.query("set local statement_timeout = '30s'"); result = (await client.query("select public.finalize_sync_cycle($1::uuid) as r", [cycleId])).rows[0].r; await client.query("commit"); }
  catch (e) { try { await client.query("rollback"); } catch { /* ignore */ } throw e; }
  const disposition = result && typeof result === "object" ? String(result.disposition || "") : String(result);
  console.log(JSON.stringify({ mode: "apply", cycleId, bucket: c.bucket, action: c.action, disposition, status: result && result.cycle ? result.cycle.status : null }));
  await client.end();
  process.exit(disposition === "finalized" || disposition === "already-terminal" ? 0 : 1);
} catch (e) { console.error("STOP reaper failed: " + String((e && e.code) || "error")); try { await client.end(); } catch { /* ignore */ } process.exit(3); }
