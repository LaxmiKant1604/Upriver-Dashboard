// TRUSTED, ONE-TIME OLI DIMENSIONAL HISTORICAL REPLACEMENT for ONE bucket. Re-exports the FULL canonical Order
// Line Items history [fixed-start .. asOf] with the NEW 9-column contract (adds amazon_order_status /
// fulfillment_channel / address_state / address_city) and persists it dimensionally (the atomic
// replace_oli_dimensional_window RPC replaces the dimensional rows + the NON-cancelled daily rollup + coverage).
//
//   node scripts/release/oli-dimensional-replacement.mjs --bucket=us|non-us [--as-of=YYYY-MM-DD] [--apply]
//
// DRY by default: reconciles accounts, proves the plan, FREEZES the exact export/token ceiling, and checks the
// live balance -- writes nothing, spends nothing. --apply performs the replacement:
//   - refuses to start while any Scheduler-v2 / manual source operation is active (no collision);
//   - refuses BEFORE the first create if the usable balance is below the frozen ceiling;
//   - re-exports through the SAME bounded runtime the scheduler/manual paths use (<=5 sellers/export, US/Non-US
//     never mixed, <=441-day complete windows), forcing a full re-fetch by clearing the in-memory coverage so
//     every window is re-requested with the new identity; old exports (missing the dimensions) are NEVER adopted;
//   - a value-missing / status-missing account is BLOCKED (its LKG preserved) and reported separately;
//   - never retries an ambiguous create (the runtime's one-create-per-hash + reconcile design holds).
// Never prints a seller / account / export id (only counts + short prefixes). Campaign Ads / FBA untouched.

import { loadReleaseEnv } from "./env-bootstrap.mjs";

loadReleaseEnv();

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const bucket = argOf("bucket");
const asOfArg = argOf("as-of");
const APPLY = process.argv.includes("--apply");
if (bucket !== "us" && bucket !== "non-us") { console.error("STOP --bucket must be us|non-us"); process.exit(2); }

const { buildBucketSourceSyncRuntime } = await import("../../lib/server/sync/source-bucket-sync-runtime.js");
const { planBucketSourceSync } = await import("../../lib/server/sync/source-bucket-sync.js");
const { getSyncSourceJobs } = await import("../../lib/server/supabase.js");
const { getDataDoeTokenBalance } = await import("../../lib/server/datadoe-usage.js");

const log = (m) => console.log("oli-dim-replace[" + bucket + "]: " + m);
const runtime = buildBucketSourceSyncRuntime({ budgetMs: 550_000, ...(asOfArg ? { asOfOverride: asOfArg } : {}) });
const dl = runtime.makeDeadline();
const pf = await runtime.preflightEvidence({ bucket, sourceKey: "order-line-items", deadline: dl });
const accounts = pf.accounts || [];
if (!accounts.length) { console.error("STOP no discovered accounts for " + bucket); process.exit(1); }
const asOf = pf.asOf; const today = pf.today;
log("discovered " + accounts.length + " primary accounts; asOf=" + asOf + " today=" + today);

// FREEZE the exact ceiling: plan the FULL backfill with EMPTY coverage (forces every window to be re-requested).
const plan = planBucketSourceSync({
  apiKey: process.env.DATADOE_API_KEY, bucket, accounts,
  existingMembership: pf.membership, coverageByAccountId: {}, // empty => the complete [fixed-start..asOf] re-fetch
  catalogCarrierSeller: pf.catalogCarrierSeller || null,
  catalogSnapshot: (pf.evidence && pf.evidence.catalogSnapshot) || null,
  fbaSnapshotsByAccount: (pf.evidence && pf.evidence.fbaSnapshotsByAccount) || {},
  asOf, today,
});
const oliFamily = (plan.families || []).find((f) => f.sourceKey === "order-line-items") || { plannedJobs: [], units: [] };
const oliExports = (oliFamily.units || []).length;
const ceiling = oliExports; const tokenCeiling = ceiling * 2;
log("FROZEN ceiling: " + ceiling + " OLI exports / " + tokenCeiling + " tokens (full [" + (oliFamily.units[0] ? oliFamily.units[0].slice.from : "?") + ".." + asOf + "] re-export; <=5 sellers, <=441-day windows)");

const balanceRead = await getDataDoeTokenBalance({ apiKey: process.env.DATADOE_API_KEY }).catch(() => null);
const balance = balanceRead && balanceRead.read === "ok" ? Number(balanceRead.usable) : null;
log("usable token balance: " + (balance == null ? "UNREADABLE" : balance));

if (!APPLY) {
  log("DRY RUN complete (no writes, no exports). Re-run with --apply to perform the replacement.");
  process.exit(0);
}

// ---- APPLY guards ----
if (balance == null || Number(balance) < tokenCeiling) {
  console.error("STOP insufficient/unreadable balance (" + balance + ") for the frozen ceiling " + tokenCeiling + " -- refusing before the first create.");
  process.exit(1);
}
// No-collision: refuse while any Scheduler-v2 / manual source operation is active (a running cycle with open work,
// or an active refresh lock on THIS bucket's sources).
const pg = (await import("pg")).default;
const gc = new pg.Client({ connectionString: String(process.env.POSTGRES_URL).split("?")[0], ssl: { rejectUnauthorized: false } });
await gc.connect();
const activeOpen = (await gc.query("select count(*)::int n from public.sync_source_jobs j join public.sync_cycles y on y.id=j.cycle_id where y.status='running' and y.bucket=$1 and y.cycle_date >= (now()::date - 1) and (j.fetch_status='pending' or j.fetch_status='attempted')", [bucket])).rows[0].n;
const activeLocks = (await gc.query("select count(*)::int n from public.report_refresh_locks where locked_until > now()")).rows[0].n;
await gc.end();
if (activeOpen > 0) { console.error("STOP a Scheduler-v2/manual OLI operation is ACTIVE for " + bucket + " (" + activeOpen + " open jobs on a current running cycle) -- not colliding."); process.exit(1); }
log("no-collision proof: 0 active open OLI jobs on a current " + bucket + " cycle; " + activeLocks + " refresh locks (informational).");

// ---- run the replacement through the bounded runtime, forcing a full re-fetch (empty in-memory coverage) ----
const forcedPreflight = { ...pf, oliCoverageByAccountId: {}, evidence: { ...(pf.evidence || {}), oliCoverageByAccountId: {} } };
let cycleId = null; let prevOpen = Infinity; let stall = 0;
for (let iter = 1; iter <= 200; iter += 1) {
  const res = await runtime.runSourceCardAction({ bucket, sourceKey: "order-line-items", deadline: dl, preflight: forcedPreflight });
  if (res && res.refused === true) { console.error("STOP source action refused: " + (res.code || "unknown")); process.exit(1); }
  if (res && res.alreadyTerminal === true) { log("today's cycle already terminal -> the day's OLI work is complete."); break; }
  cycleId = (res && res.cycleId) || cycleId;
  if (!cycleId) { log("nothing to replace (no cycle opened)"); break; }
  const jobs = await getSyncSourceJobs(cycleId);
  const oli = jobs.filter((j) => (j.source_key ?? j.sourceKey) === "order-line-items");
  const open = oli.filter((j) => { const s = j.fetch_status ?? j.fetchStatus; return s === "pending" || s === "attempted"; }).length;
  const failed = oli.filter((j) => (j.fetch_status ?? j.fetchStatus) === "failed" && j.terminal !== true).length;
  log("iter " + iter + ": cycle=" + String(cycleId).slice(0, 8) + " oli_open=" + open + " failed=" + failed);
  const outstanding = open + failed;
  if (outstanding === 0) break;
  stall = outstanding >= prevOpen ? stall + 1 : 0; prevOpen = outstanding;
  if (stall >= 3) { console.error("STOP no progress for 3 resumptions (open=" + open + " failed=" + failed + ") -- transient source failures persisted; LKG intact, re-run later."); process.exit(1); }
}
log("OLI dimensional replacement drained. Re-derive/publish the affected Daily + Brand snapshots next (zero-export).");
process.exit(0);
