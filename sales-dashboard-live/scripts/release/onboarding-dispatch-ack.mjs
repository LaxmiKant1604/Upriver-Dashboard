// TRUSTED bootstrap-run ACKNOWLEDGEMENT operator -- the scheduler-v2 bootstrap run's durable start/finish
// receipt, keyed by the EXACT dispatch identity it was dispatched with. Usage (from sales-dashboard-live/):
//   node scripts/release/onboarding-dispatch-ack.mjs --region=<india|europe-au|us-ca> --dispatch-id=<id> --phase=running|completed|failed --run-token=<id> [--note=<safe typed code>]
//
// WHY: a workflow_dispatch HTTP 204 only means QUEUED. The run itself acks:
//   running   -> right after configuration (STAMPS this run's token + extends the lease horizon),
//   completed -> ONLY when every scoped source step + the live-read completion proof succeeded,
//   failed    -> a proven unsuccessful finish (the wave becomes retryable after the bounded backoff).
// STALE/LATE-ACK GUARD: --run-token is this workflow run's own token (github run_id-run_attempt). The RPC
// honors completed/failed ONLY when the row is 'running' AND its active_run_token equals this token, so a
// SUPERSEDED or EXPIRED workflow can never revive/complete the dispatch (typed 'stale-ack' no-op). This
// operator performs ZERO DataDoe calls and ONE Supabase RPC; a missing/stale row is a typed no-op.

import { loadReleaseEnv } from "./env-bootstrap.mjs";

loadReleaseEnv();

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const region = argOf("region");
const dispatchId = argOf("dispatch-id");
const phase = argOf("phase");
const note = argOf("note") || null;
const runToken = (argOf("run-token") || "").trim();
if (!["india", "europe-au", "us-ca"].includes(region || "")) { console.error("STOP --region must be india | europe-au | us-ca (got: " + region + ")"); process.exit(2); }
if (!dispatchId || !dispatchId.trim()) { console.error("STOP --dispatch-id is required (the exact identity the run was dispatched with)"); process.exit(2); }
if (!["running", "completed", "failed"].includes(phase || "")) { console.error("STOP --phase must be running | completed | failed (got: " + phase + ")"); process.exit(2); }
if (!runToken) { console.error("STOP --run-token is required (the stale-ack guard token)"); process.exit(2); }

const { ackOnboardingDispatch } = await import("../../lib/server/supabase.js");
let result = null;
try {
  result = await ackOnboardingDispatch({ region, dispatchId, phase, note, runToken });
} catch (e) {
  // The ack is a RECEIPT, not a gate: an unreachable lifecycle table must never turn a successful
  // bootstrap red (the lease horizon simply expires and the worker retries) -- report and exit green.
  console.log("onboarding-ack[" + region + "]: ACK_UNRECORDED (" + (e && e.message ? e.message : e) + ") -- lease horizon governs retry.");
  process.exit(0);
}
const disposition = String((result && result.disposition) || "unreadable");
console.log("onboarding-ack[" + region + "]: phase=" + phase + " dispatch=" + dispatchId + " -> " + disposition + (note ? " note=" + note : ""));
process.exit(0);
