// TRUSTED, MANUAL-ONLY (workflow_dispatch) operator for the FIRST-TIME FBA Shipment Plan go-live. It runs the SAME
// reviewed Scheduler-v2 machinery -- the shadow dispatcher (batched marketplace-safe FBA Health/AWD fetch + durable
// OLI/catalog derive), the four-gate CAS publisher, and the guarded control package -- inside an
// apply-gates -> derive -> publish -> ALWAYS-safe-close envelope, bounded by a hard token ceiling.
//
//   node scripts/release/fba-plan-golive.mjs --mode=dry-run   [--as-of=YYYY-MM-DD] [--max-blocked=2]
//   node scripts/release/fba-plan-golive.mjs --mode=go-live   [--as-of=YYYY-MM-DD] [--max-tokens=80] [--max-blocked=2]
//
// dry-run: ZERO creates, ZERO control changes -- resolves the coverage-maximizing as-of, builds the exact batched
//   plan, proves how much is already adoptable from cache, and prints the create/token cost vs the ceiling.
// go-live: refuses to start if the plan exceeds --max-tokens; otherwise opens ONLY the fba-plan publication gates,
//   runs the fba-plan shadow dispatch for both buckets, publishes every eligible account through the four gates,
//   and ALWAYS safe-closes the controls (even on failure). Genuinely-stale-OLI accounts fail closed (never
//   fabricated) and publish on a later run once their OLI catches up.

import { loadReleaseEnv } from "./env-bootstrap.mjs";
loadReleaseEnv();

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const mode = argOf("mode");
if (mode !== "dry-run" && mode !== "go-live") { console.error("STOP --mode must be dry-run | go-live"); process.exit(2); }
const asOfArg = argOf("as-of");
const maxTokens = Number(argOf("max-tokens") || 80);
const maxBlocked = Number(argOf("max-blocked") || 2);
// --bucket selects which bucket(s) to refresh + publish: "us" | "non-us" | "both" (default). The scheduler runs ONE
// bucket per cron (per-bucket independence); the manual go-live publishes both. Each bucket is fully independent --
// a failure in one never touches the other's accounts or snapshots.
const bucketArg = (argOf("bucket") || "both").toLowerCase();
if (!["us", "non-us", "both"].includes(bucketArg)) { console.error("STOP --bucket must be us | non-us | both"); process.exit(2); }
const wantBucket = (b) => bucketArg === "both" || bucketArg === b;
const log = (m) => console.log("fba-golive[" + mode + (bucketArg === "both" ? "" : "/" + bucketArg) + "]: " + m);

const { getDataDoeConnections, resolveDataDoeAccountIds } = await import("../../lib/server/datadoe-connections.js");
const { organizationFingerprint } = await import("../../lib/server/source-identity.js");
const { buildShadowReportPlan } = await import("../../lib/server/sync/report-planner.js");
const { getSourceCoverageWindows, getSourceExportCache } = await import("../../lib/server/supabase.js");
const { resolveGoLiveAsOf, fbaGoLiveTokenCost } = await import("../../lib/server/sync/fba-plan-golive-plan.js");
const { discoverPrimaryAccountIds, connectPriorityControlStore } = await import("../../lib/server/sync/priority-control-pg-store.js");
const pg = (await import("pg")).default;

const OLI_SOURCE_KEY = "order-line-items";
const CEILING = new Date(Date.now() - 86400000).toISOString().slice(0, 10); // server D-1 (never publish past yesterday)
const connections = getDataDoeConnections();

// ---------------- Stage 0: discover primaries + their authoritative account metadata ----------------
// The control store's discovery returns the fresh primary account ids; the durable account-directory snapshot
// supplies each account's country + currency (the batched planner needs both). Read the directory once (zero
// DataDoe) directly from report_snapshots.
async function loadDirectory() {
  const u = new URL(process.env.POSTGRES_URL); u.searchParams.set("sslmode", process.env.PGSSLMODE || "no-verify");
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  try {
    const row = (await c.query("select payload from public.report_snapshots where report_key='account-directory' order by updated_at desc limit 1")).rows[0];
    const p = row && row.payload;
    return Array.isArray(p && p.accounts) ? p.accounts : (Array.isArray(p) ? p : []);
  } finally { await c.end(); }
}
const dirRows = await loadDirectory();
const metaById = new Map(dirRows.map((a) => [String(a.accountId || a.id || a.account_id || "").trim(), { name: a.name || null, country: String(a.country || a.marketCountry || a.marketplace || "").trim(), currency: a.currency || null }]));
const primaryIds = await discoverPrimaryAccountIds();
const accounts = primaryIds.map((id) => ({ accountId: id, ...(metaById.get(id) || { name: null, country: "", currency: null }) })).filter((a) => a.country);
if (accounts.length !== primaryIds.length) log("WARN " + (primaryIds.length - accounts.length) + " discovered account(s) missing directory metadata (country) -- excluded from planning");
log("discovered " + accounts.length + " primary accounts with metadata");

// ---------------- Stage 1: resolve the coverage-maximizing go-live as-of ----------------
async function provenTo(account) {
  let resolved;
  try { resolved = resolveDataDoeAccountIds([account.accountId], connections); } catch { return null; }
  if (!resolved || resolved.rawAccountIds.length !== 1) return null;
  const org = resolved.connection.organizationFingerprint || organizationFingerprint(resolved.connection.apiKey);
  const connectionId = resolved.connection.id === "secondary" ? "dd-secondary" : "primary";
  let cov;
  try { cov = await getSourceCoverageWindows({ organizationFingerprint: org, connectionId, accountId: account.accountId, sourceKey: OLI_SOURCE_KEY }); }
  catch { return null; }
  const wins = cov && cov.read === "ok" ? (cov.windows || []) : [];
  const tos = wins.map((w) => String(w.to ?? w.covered_to ?? "")).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  return tos.length ? tos.reduce((m, t) => (t > m ? t : m)) : null;
}
const proven = [];
for (const a of accounts) proven.push({ accountId: a.accountId, provenTo: await provenTo(a) });
const asOfResolved = asOfArg && /^\d{4}-\d{2}-\d{2}$/.test(asOfArg)
  ? { asOf: asOfArg > CEILING ? CEILING : asOfArg, included: proven.filter((p) => p.provenTo && p.provenTo >= (asOfArg > CEILING ? CEILING : asOfArg)).map((p) => p.accountId), blocked: proven.filter((p) => !(p.provenTo && p.provenTo >= (asOfArg > CEILING ? CEILING : asOfArg))) }
  : resolveGoLiveAsOf(proven, { ceiling: CEILING, maxBlocked });
const asOf = asOfResolved.asOf;
if (!asOf) { console.error("STOP no account has durable OLI coverage; cannot resolve a go-live as-of."); process.exit(1); }
log("go-live as-of = " + asOf + " (ceiling D-1 = " + CEILING + "); included=" + asOfResolved.included.length + " blocked(stale OLI)=" + asOfResolved.blocked.length);
if (asOfResolved.blocked.length) log("  blocked (publish later once OLI catches up): " + asOfResolved.blocked.map((b) => b.accountId.slice(0, 6) + "(" + (b.provenTo || "none") + ")").join(", "));

// ---------------- Stage 2: build the exact batched plan + prove the token cost (ZERO creates) ----------------
const asOfFor = () => asOf; // a SINGLE go-live as-of => batched FBA/AWD exports share one window per batch
// Scope accounts to the selected bucket(s) -- each bucket is planned/fetched/published INDEPENDENTLY.
const usAccounts = wantBucket("us") ? accounts.filter((a) => a.country.toUpperCase() === "US") : [];
const nonUsAccounts = wantBucket("non-us") ? accounts.filter((a) => a.country.toUpperCase() !== "US") : [];
const selectedIds = new Set([...usAccounts, ...nonUsAccounts].map((a) => a.accountId));
const planFor = (bucketAccounts) => (bucketAccounts.length ? buildShadowReportPlan({ accounts: bucketAccounts, reportKeys: ["fba-plan"], connections, asOfFor }) : { sourceJobs: [], reportRequests: [] });
const usPlan = planFor(usAccounts);
const nonUsPlan = planFor(nonUsAccounts);
const allSourceJobs = [...usPlan.sourceJobs, ...nonUsPlan.sourceJobs];
const adoptable = new Set();
for (const j of allSourceJobs) { const h = j.requestHash ?? j.request_hash; try { if (await getSourceExportCache(h)) adoptable.add(h); } catch { /* treat as not-adoptable */ } }
const cost = fbaGoLiveTokenCost(allSourceJobs, (h) => adoptable.has(h));
log("PLAN: " + allSourceJobs.length + " batched exports (us=" + usPlan.sourceJobs.length + " non-us=" + nonUsPlan.sourceJobs.length + "); adoptable(cached)=" + (allSourceJobs.length - cost.creates) + " => " + cost.creates + " creates / " + cost.tokens + " tokens");
log("  by family: " + JSON.stringify(cost.byFamily));
log("  token ceiling = " + maxTokens + " -> " + (cost.tokens <= maxTokens ? "WITHIN budget" : "EXCEEDS budget"));

if (mode === "dry-run") { log("DRY-RUN complete: ZERO creates, ZERO control changes."); process.exit(0); }

// ---------------- go-live: HARD token gate BEFORE any create / control change ----------------
if (cost.tokens > maxTokens) { console.error("STOP the plan costs " + cost.tokens + " tokens > the " + maxTokens + "-token ceiling; refusing to start (zero creates, zero control changes)."); process.exit(1); }

const { buildSchedulerV2Runtime } = await import("../../lib/server/sync/runtime-composition.js");
const { buildSchedulerV2Publisher } = await import("../../lib/server/sync/publisher-composition.js");
const { runControlPackageCli, buildFbaPlanControlPackage } = await import("../../lib/server/sync/source-priority-control-package.js");
const { CONTROLLED_REPORT_KEYS } = await import("../../lib/server/sync/report-controls.js");
const OPERATOR = process.env.PRIORITY_OPERATOR || "laxmikant@superboring.in";
const cycleDate = asOf;
const runtime = buildSchedulerV2Runtime({});
const publisher = buildSchedulerV2Publisher();

let controlsOpen = false;
const safeClose = async () => {
  try {
    const r = await runControlPackageCli({ mode: "rollback", operator: OPERATOR, connectStore: connectPriorityControlStore, controlledReportKeys: CONTROLLED_REPORT_KEYS, log: (m) => log("controls: " + m) });
    if (!r || r.committed !== true) throw new Error("SAFE-CLOSE did not commit (code " + (r && r.code) + ") -- verify controls manually");
    controlsOpen = false;
    log("controls safe-closed.");
  } catch (e) { console.error("STOP SAFE-CLOSE FAILED: " + (e && e.message ? e.message : e) + " -- verify controls manually."); process.exitCode = 1; }
};

try {
  // 1) open ONLY the fba-plan publication gates (GATE2 dispatch + GATE3 rollout + GATE4 approvals).
  const applied = await runControlPackageCli({ mode: "apply", operator: OPERATOR, discoverAccounts: discoverPrimaryAccountIds, connectStore: connectPriorityControlStore, controlledReportKeys: CONTROLLED_REPORT_KEYS, buildApplyPackage: buildFbaPlanControlPackage, log: (m) => log("controls: " + m) });
  if (!applied || applied.committed !== true) throw new Error("controls apply did not commit (code " + (applied && applied.code) + ")");
  controlsOpen = true;

  // 2) run the fba-plan SHADOW dispatch for each SELECTED bucket until drained (batched FBA/AWD fetch + durable
  //    derive). Buckets run independently -- a failure in one never touches the other's accounts or snapshots.
  for (const bucket of ["us", "non-us"]) {
    if (!wantBucket(bucket)) continue;
    if (bucket === "us" ? !usAccounts.length : !nonUsAccounts.length) continue;
    let cycleId = null;
    for (let slice = 1; slice <= 40; slice += 1) {
      // trigger MUST be one of the sync_cycles_trigger_check enum ('pg_cron'|'github'|'vercel'|'manual'); this
      // operator runs in GitHub Actions. The fba-plan operation identity (bucket + as-of + request_hash) is what
      // distinguishes/idempotates fba-plan runs, NOT the trigger enum.
      // cycleBucket namespaces the fba-plan cycle (us-fba / non-us-fba) so it NEVER collides with the scheduler-v2
      // daily (us|non-us, cycle_date) cycle; account scope is still the real bucket (us | non-us).
      const res = await runtime.run({ bucket, cycleBucket: bucket + "-fba", cycleDate, asOf, asOfFor, manualReportKeys: ["fba-plan"], trigger: "github" });
      cycleId = res.cycleId || cycleId;
      log(bucket + " slice " + slice + ": cycle=" + String(res.cycleId || "").slice(0, 8) + " drained=" + res.drained + " reports=" + JSON.stringify(res.reports ? { processed: res.reports.processed, drained: res.reports.drained } : null));
      if (res.drained === true) break;
      if (res.continuationRequired !== true) throw new Error(bucket + " dispatch stopped un-drained without requesting continuation");
      if (slice === 40) throw new Error(bucket + " dispatch did not drain within the slice budget");
    }
    // FINALIZE the fba-plan cycle. A manualReportKeys dispatch deliberately NEVER auto-finalizes (it must not
    // terminalize a SHARED (bucket, cycle_date) cycle other reports may append to). But fba-plan's cycle is
    // DEDICATED (us-fba / non-us-fba, no other report), so we finalize it here -- the publisher's four-gate check
    // requires a validated report job in a TERMINAL (succeeded|partial) cycle. Idempotent: a replay's already-
    // terminal cycle returns "already-terminal".
    if (cycleId) {
      const disp = await runtime.store.finalizeCycle({ cycleId });
      const status = disp && disp.cycle && disp.cycle.status;
      log(bucket + " cycle finalized: disposition=" + (disp && disp.disposition) + " status=" + status);
      if (!disp || !["finalized", "already-terminal"].includes(disp.disposition) || !["succeeded", "partial"].includes(status)) {
        throw new Error(bucket + " fba-plan cycle did not finalize to a terminal (succeeded|partial) status: " + JSON.stringify(disp));
      }
    }
  }

  // 3) publish every INCLUDED account IN THE SELECTED BUCKET(S) through the four gates (preflight proves it
  //    before the CAS write). A stale-OLI-blocked account is simply absent from `included` -> its LKG is untouched.
  const published = []; const skipped = [];
  for (const accountId of asOfResolved.included.filter((id) => selectedIds.has(id))) {
    const pre = await publisher.preflight("fba-plan", accountId);
    if (pre.disposition !== "ready") { skipped.push(accountId.slice(0, 6) + ":" + pre.disposition); continue; }
    const r = await publisher.publish("fba-plan", accountId);
    if (["published", "already-current", "newer-live"].includes(r.disposition)) published.push(accountId);
    else skipped.push(accountId.slice(0, 6) + ":" + r.disposition);
  }
  log("PUBLISH: " + published.length + " live; " + skipped.length + " skipped" + (skipped.length ? " [" + skipped.join(", ") + "]" : ""));

  // 4) OWNERSHIP BACKFILL -- part of the go-live completion path (never a forgotten manual step). Zero DataDoe,
  //    idempotent; reads the freshly-published v2d-5 snapshots. Non-fatal (the publish already succeeded and it is
  //    safely re-runnable) so an ownership hiccup never blocks the safe-close or the go-live result.
  if (published.length) {
    try {
      const { backfillFbaOwnership } = await import("../backfill-fba-ownership.mjs");
      const bf = await backfillFbaOwnership({ dry: false, log: (m) => log("ownership: " + m) });
      log("OWNERSHIP: " + bf.applied + " accounts populated, " + bf.totalRows + " rows" + (bf.skippedNoV5 ? ", " + bf.skippedNoV5 + " skipped (no v2d-5)" : ""));
    } catch (e) { log("WARN ownership backfill failed (re-runnable, non-fatal): " + (e && e.message ? e.message : e)); }
  }

  // 5) ALWAYS safe-close.
  await safeClose();
  if (!published.length) { console.error("STOP zero accounts published live -- see skipped dispositions above."); process.exit(1); }
  log("DONE: fba-plan published for " + published.length + " accounts (as-of " + asOf + "); controls safe-closed.");
  process.exit(process.exitCode || 0);
} catch (e) {
  console.error("STOP go-live failed: " + (e && e.message ? e.message : e));
  if (controlsOpen) await safeClose();
  process.exit(1);
}
