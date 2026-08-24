// TRUSTED pre-create token-gate. Usage (run from sales-dashboard-live/):
//   node scripts/release/confirm-token-budget.mjs --min=<N> [--bucket=us|non-us]
//
// Reads the CURRENT usable DataDoe balance (read-only /usage-logs; spends ZERO tokens; NEVER a diagnostic export)
// and decides, before any create, per exact PER-RUN ceiling (Non-US 20 / US 10):
//   - unreadable/malformed balance -> HARD STOP (exit 1, fail closed);
//   - usable < required            -> TYPED SAFE SKIP: writes proceed=false + SKIPPED_INSUFFICIENT_TOKENS; exit 0
//                                     (the workflow then skips OLI/Ads/controls -- NO creates, NO controls, LKG
//                                     unchanged -- and the run visibly reports the skip);
//   - usable >= required           -> proceed=true; exit 0.
// Emits a GitHub step summary + step output (proceed / skipped) with required/available counts. Never prints the
// api key. Warns when the balance funds fewer than 3 worst-case complete days.

import { appendFileSync } from "node:fs";
import { loadReleaseEnv } from "./env-bootstrap.mjs";

loadReleaseEnv();

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const bucket = argOf("bucket") || "";
const minArg = argOf("min");
const required = Number.isFinite(Number(minArg)) && Number(minArg) > 0 ? Number(minArg) : 30;

const { getDataDoeTokenBalance, tokenGateDecision, LOW_BALANCE_WARN_TOKENS } = await import("../../lib/server/datadoe-usage.js");
const { getDataDoeConnections } = await import("../../lib/server/datadoe-connections.js");

const ghOut = (k, v) => { const f = process.env.GITHUB_OUTPUT; if (f) { try { appendFileSync(f, k + "=" + v + "\n"); } catch { /* ignore */ } } };
const ghSum = (s) => { const f = process.env.GITHUB_STEP_SUMMARY; if (f) { try { appendFileSync(f, s + "\n"); } catch { /* ignore */ } } console.log(s); };

const primary = getDataDoeConnections().find((c) => c.id === "primary");
if (!primary || !primary.apiKey) { ghOut("proceed", "false"); console.error("STOP no primary DataDoe connection / api key (fail closed)"); process.exit(1); }

const balance = await getDataDoeTokenBalance({ apiKey: primary.apiKey });
const g = tokenGateDecision(balance, required);
ghSum("### Token gate" + (bucket ? " (" + bucket + ")" : "") + "\n- required: " + required + "\n- usable: " + (g.usable == null ? "unreadable" : g.usable) + "\n- decision: " + g.decision + (g.lowBalance ? "\n- WARNING: LOW BALANCE (< " + LOW_BALANCE_WARN_TOKENS + " tokens = fewer than 3 worst-case complete days)" : ""));

if (g.decision === "fail") { ghOut("proceed", "false"); console.error("STOP token balance unreadable/malformed -- fail closed (need >= " + required + "): " + g.reason); process.exit(1); }
if (g.decision === "skip") {
  ghOut("proceed", "false"); ghOut("skipped", "SKIPPED_INSUFFICIENT_TOKENS");
  console.log("SKIPPED_INSUFFICIENT_TOKENS: usable " + g.usable + " < required " + required + " -- NO creates, NO controls, LKG unchanged.");
  process.exit(0);
}
ghOut("proceed", "true");
console.log("token-gate OK: usable " + g.usable + " >= required " + required + (g.lowBalance ? " (LOW BALANCE warning)" : "") + " -- proceeding.");
process.exit(0);
