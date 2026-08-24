// TRUSTED pre-create token-confirmation gate. Usage (run from sales-dashboard-live/):
//   node scripts/release/confirm-token-budget.mjs [--min=30]
//
// Reads the CURRENT usable DataDoe balance (read-only /usage-logs; spends ZERO tokens) and REFUSES (exit 1) if it
// is below the required floor OR cannot be confirmed. Run FIRST in each scheduled run, before any OLI/Ads/Catalog
// create, so a run that could exceed the combined daily ceiling never starts. Never prints the api key.

import { loadReleaseEnv } from "./env-bootstrap.mjs";

loadReleaseEnv();

const minArg = (process.argv.find((a) => a.startsWith("--min=")) || "").split("=")[1];
const required = Number.isFinite(Number(minArg)) && Number(minArg) > 0 ? Number(minArg) : 30;

const { getDataDoeTokenBalance, confirmUsableTokens } = await import("../../lib/server/datadoe-usage.js");
const { getDataDoeConnections } = await import("../../lib/server/datadoe-connections.js");

const primary = getDataDoeConnections().find((c) => c.id === "primary");
if (!primary || !primary.apiKey) { console.error("STOP no primary DataDoe connection / api key"); process.exit(1); }

const balance = await getDataDoeTokenBalance({ apiKey: primary.apiKey });
const result = confirmUsableTokens(balance, required);
console.log("token-budget: usable=" + (result.usable == null ? "unreadable" : result.usable) + " required=" + required + " confirmed=" + result.confirmed + (balance.asOf ? " asOf=" + balance.asOf : ""));
if (!result.confirmed) { console.error("STOP insufficient/unconfirmed DataDoe tokens (need >= " + required + "): " + (result.reason || "unknown")); process.exit(1); }
console.log("token-budget: OK -- at least " + required + " usable tokens confirmed before the first create.");
process.exit(0);
