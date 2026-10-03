// TRUSTED ASIN Ads (asin-performance-v1 / "Ad Performance by ASIN & Date") refresh operator for ONE region -- a thin CLI
// over the SHARED region-aware runner (lib/server/sync/scheduled-asin-ads-runner.js) that the Data Sync Center card uses
// too. ASIN Ads is an ADDITIONAL durable source: Campaign stays the active Ads grain for every dashboard and report, and
// nothing here touches Campaign, a report, a control window or a publication. Usage (from sales-dashboard-live/):
//   node scripts/release/scheduled-asin-ads-refresh.mjs --bucket=india|europe-au|us-ca --max-creates=N
//        [--as-of=YYYY-MM-DD] [--scheduled] [--dry-run] [--accounts=id,id] [--confirm-paid] [--reserve-tokens=N]
//        [--evidence-file=path]
//   --scheduled     the scheduler-v2 asin_ads job: runs ONLY while source_controls['ads-asin-date'] is schedule_enabled
//                   and not paused (the durable on/off switch -- no redeploy); otherwise a typed SKIP with zero creates.
//   (operator)      without --scheduled a paid run needs --confirm-paid (an explicit, owner-approved canary); it still
//                   refuses when the source is paused. --accounts restricts the region to exact export-eligible ids.
//   --dry-run       the plan, windows, size estimates, exposure and balance only: ZERO creates, ZERO export listing.
//   --max-creates   REQUIRED: the hard total create cap for this invocation (checked BEFORE every POST).
// Before the first create the live balance (zero tokens) must cover the worst case plus --reserve-tokens (default 100,
// kept for OLI / Campaign). A failed create is never blindly retried: one ADOPT-ONLY reconcile pass may reuse an
// already-completed export (zero tokens). Logs print 8-character id prefixes only; full export ids go to
// --evidence-file (operator canary evidence, a local file) when given.

import { writeFileSync, appendFileSync } from "node:fs";
import { loadReleaseEnv } from "./env-bootstrap.mjs";

loadReleaseEnv();

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const flag = (name) => process.argv.includes(`--${name}`);
const region = argOf("bucket");
const asOf = argOf("as-of") || (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
const scheduled = flag("scheduled"); const dryRun = flag("dry-run"); const confirmPaid = flag("confirm-paid");
const maxCreatesArg = argOf("max-creates");
const reserveTokens = Math.max(0, Math.trunc(Number(argOf("reserve-tokens") ?? 100)) || 0);
const accountsArg = argOf("accounts");
const evidenceFile = argOf("evidence-file");
const REGIONS = ["india", "europe-au", "us-ca"];
const stop = (m, code = 2) => { console.error("STOP " + m); process.exit(code); };
if (!REGIONS.includes(region)) stop("--bucket must be one region: india|europe-au|us-ca (got: " + region + ")");
if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) stop("--as-of must be YYYY-MM-DD (got: " + asOf + ")");
const maxCreates = maxCreatesArg == null ? null : Math.trunc(Number(maxCreatesArg));
if (!dryRun && !(Number.isSafeInteger(maxCreates) && maxCreates >= 0)) stop("--max-creates=N (a non-negative integer) is REQUIRED for a paid run");
if (!dryRun && !scheduled && !confirmPaid) stop("an operator (non-scheduled) paid run requires --confirm-paid");
if (scheduled && accountsArg) stop("--scheduled runs the whole region (no --accounts)");
const accountAllowlist = accountsArg ? accountsArg.split(",").map((x) => x.trim()).filter(Boolean) : null;

const R = await import("../../lib/server/sync/scheduled-asin-ads-runner.js");
const { getSourceControls, upsertSourceRunStatus } = await import("../../lib/server/supabase.js");
const { getDataDoeTokenBalance } = await import("../../lib/server/datadoe-usage.js");
const { REGION_SCHEDULE } = await import("../../lib/server/sync/campaign-region-routing.js");
const label = REGION_SCHEDULE[region].label;
const log = (m) => console.log("asin-ads[" + region + "@" + asOf + (scheduled ? "/scheduled" : dryRun ? "/dry-run" : "/operator") + "]: " + m);
const p8 = (x) => String(x == null ? "" : x).slice(0, 8);
const summaryOut = (md) => { const f = process.env.GITHUB_STEP_SUMMARY; if (f) { try { appendFileSync(f, md + "\n"); } catch { /* ignore */ } } };
const result = (o) => { console.log("RESULT " + JSON.stringify({ region, asOf, ...o })); };

// ---- the durable control (pause / schedule switch) ----
const controls = await getSourceControls();
const ctl = controls.read === "ok" ? (controls.rows || []).find((r) => r.source_key === R.ASIN_ADS_SOURCE_KEY) || null : null;
if (!dryRun) {
  if (controls.read !== "ok") { log("source controls unreadable (" + controls.read + ") -- SKIP, zero creates (fail closed)"); result({ ok: true, classification: "ASIN_ADS_CONTROLS_UNREADABLE", creates: 0, tokens: 0 }); process.exit(0); }
  if (ctl && ctl.paused === true) { log("source paused in the Data Sync Center -- SKIP, zero creates"); result({ ok: true, classification: "ASIN_ADS_PAUSED", creates: 0, tokens: 0 }); process.exit(0); }
  if (scheduled && !(ctl && ctl.schedule_enabled === true)) {
    log("deployed but the schedule is NOT enabled (source_controls.schedule_enabled=false) -- SKIP, zero creates");
    result({ ok: true, classification: "ASIN_ADS_SCHEDULE_NOT_ENABLED", creates: 0, tokens: 0 });
    process.exit(0);
  }
}

// ---- plan (zero tokens) ----
const plan = await R.planAsinAdsRegionRun({ region, asOf, accountAllowlist });
const exposure = R.asinAdsPlanExposure(plan);
log(label + ": " + plan.regionAccounts.length + " export-eligible, " + plan.compatible.length + " ASIN-compatible, " + plan.incompatible.length + " incompatible, " + plan.unreadable.length + " unreadable, " + plan.covered.length + " already covered, " + plan.pending.length + " pending; horizon [" + plan.windows.horizon.from + ".." + plan.windows.horizon.to + "] rolling [" + plan.windows.rolling.from + ".." + plan.windows.rolling.to + "]");
for (const a of plan.pending) log("  pending " + p8(a.accountId) + " (" + a.marketplace + ") " + a.kind + " [" + a.window.from + ".." + a.window.to + "] " + a.window.days + "d rate=" + (a.ratePerDay == null ? "unknown" : a.ratePerDay + "/day"));
for (const a of plan.incompatible) log("  incompatible " + p8(a.accountId) + " (" + a.marketplace + ") -- no Amazon Ads ASIN source on its DataDoe connection (typed unavailable)");
for (const a of plan.unreadable) log("  unreadable " + p8(a.accountId) + " (" + a.reason + ") -- excluded this run");
plan.items.forEach((it, i) => log("  export " + (i + 1) + ": " + it.allowlist.length + " seller(s) [" + it.window.from + ".." + it.window.to + "] chunk " + it.chunk.index + "/" + it.chunk.of + " predicted~" + it.expectedRows + " rows"));
log("PLAN: " + exposure.normalCreates + " planned export(s) / " + exposure.expectedTokens + " tokens; hard cap " + (maxCreates == null ? "-" : maxCreates) + " creates / " + (maxCreates == null ? "-" : maxCreates * R.ASIN_ADS_TOKENS_PER_CREATE) + " tokens; largest predicted export ~" + exposure.maxPredictedRowsPerExport + " rows (limit 50000)");
let balance = null;
try { const b = await getDataDoeTokenBalance({ apiKey: plan.primaryConn.apiKey }); balance = b && b.read === "ok" && Number.isFinite(b.usable) ? b.usable : null; } catch { balance = null; }
log("balance: " + (balance == null ? "UNREADABLE" : balance + " tokens") + "; reserve " + reserveTokens);
const planSummary = { regionAccounts: plan.regionAccounts.length, compatible: plan.compatible.length, incompatible: plan.incompatible.map((a) => p8(a.accountId)), unreadable: plan.unreadable.map((a) => p8(a.accountId)), alreadyCovered: plan.covered.length, pending: plan.pending.map((a) => ({ id: p8(a.accountId), kind: a.kind, from: a.window.from, to: a.window.to })), plannedCreates: exposure.normalCreates, maxCreates, balance };
if (dryRun) { result({ ok: true, classification: "DRY_RUN", creates: 0, tokens: 0, plan: planSummary }); process.exit(0); }
if (maxCreates < exposure.normalCreates) log("WARNING ASIN_ADS_CAP_BELOW_PLAN: the cap " + maxCreates + " is below the " + exposure.normalCreates + " planned export(s) -- the rest are budget-deferred (keep last-known-good) and reported");
if (exposure.normalCreates > 0) {
  const worstTokens = maxCreates * R.ASIN_ADS_TOKENS_PER_CREATE;
  if (balance == null || balance - worstTokens < reserveTokens) {
    log("token gate REFUSED: balance " + balance + " - worst case " + worstTokens + " < reserve " + reserveTokens + " -- SKIP, zero creates");
    result({ ok: true, classification: "ASIN_ADS_TOKEN_RESERVE", creates: 0, tokens: 0, plan: planSummary });
    summaryOut("### ASIN Ads (" + region + ") skipped -- token reserve");
    process.exit(0);
  }
}

// ---- run: one bounded pass (+ resumable continuations), then ONE adopt-only reconcile pass for transient accounts ----
const startedIso = new Date().toISOString();
const MAX_PASSES = Number(process.env.SCHEDULED_ASIN_ADS_MAX_ITERS || 10);
let spent = 0; let reused = 0; const all = { covered: new Set(), rejected: new Set(), transient: new Set(), ambiguous: new Set(), budgetDeferred: new Set() };
const fragments = []; const created = []; const adopted = []; let last = null;
const absorb = (r) => {
  spent += r.creates || 0; reused += r.reused || 0;
  for (const k of Object.keys(all)) for (const id of r[k] || []) all[k].add(id);
  for (const id of r.covered || []) for (const k of ["rejected", "transient", "ambiguous", "budgetDeferred"]) all[k].delete(id);
  fragments.push(...(r.fragments || [])); created.push(...(r.createdExportIds || [])); adopted.push(...(r.adoptedExportIds || []));
};
let passPlan = plan;
for (let pass = 1; pass <= MAX_PASSES && passPlan.items.length; pass += 1) {
  last = await R.runAsinAdsRegionSlice({ region, asOf, plan: passPlan, maxTotalCreates: Math.max(0, maxCreates - spent), log });
  absorb(last);
  if (last.phase === "complete" || last.phase === "partial") break;
  if (last.continuationRequired === true) { log("pass " + pass + " deferred; resuming"); passPlan = await R.planAsinAdsRegionRun({ region, asOf, accountAllowlist }); continue; }
  break;
}
if (all.transient.size || all.ambiguous.size) {
  // A transient / ambiguous create may have COMPLETED server-side: wait briefly, then reuse it if an exact completed
  // export exists -- ZERO new creates (adoptOnly). Anything still missing keeps last-known-good for the next run.
  await new Promise((res) => setTimeout(res, Number(process.env.ASIN_ADS_RECONCILE_WAIT_MS || 30000)));
  const retryIds = [...all.transient, ...all.ambiguous];
  const rp = await R.planAsinAdsRegionRun({ region, asOf, accountAllowlist: retryIds });
  if (rp.items.length) {
    const rr = await R.runAsinAdsRegionSlice({ region, asOf, plan: rp, maxTotalCreates: 0, adoptOnly: true, log });
    log("adopt-only reconcile: covered " + (rr.covered || []).length + " of " + retryIds.length + " (reused " + (rr.reused || 0) + ", creates 0)");
    for (const id of rr.covered || []) { all.transient.delete(id); all.ambiguous.delete(id); all.covered.add(id); }
    reused += rr.reused || 0; fragments.push(...(rr.fragments || [])); adopted.push(...(rr.adoptedExportIds || []));
  }
}
const tokens = spent * R.ASIN_ADS_TOKENS_PER_CREATE;
const systemic = last && last.phase === "sync" && last.ok === false;
const out = {
  ok: !systemic, classification: systemic ? "ASIN_ADS_FAILED" : (all.transient.size + all.rejected.size + all.ambiguous.size + all.budgetDeferred.size ? "PARTIAL" : "COMPLETE"),
  creates: spent, reused, tokens, maxCreates,
  covered: [...all.covered].map(p8), alreadyCovered: plan.covered.length,
  incompatible: plan.incompatible.map((a) => p8(a.accountId)), unreadable: plan.unreadable.map((a) => p8(a.accountId)),
  failed: { rejected: [...all.rejected].map(p8), transient: [...all.transient].map(p8), ambiguous: [...all.ambiguous].map(p8), budgetDeferred: [...all.budgetDeferred].map(p8) },
  fragments: fragments.map((f) => ({ from: f.from, to: f.to, rowCount: f.rowCount, sellers: f.sellers, exportId: p8(f.exportId) })),
  createdExports: created, adoptedExports: adopted, problems: systemic ? last.problems : undefined,
};
result(out);
// The operator status row for this region (the Data Sync Center card folds the bucket's regions). Best-effort: a status
// write failure never changes the outcome, it is only logged.
try {
  await upsertSourceRunStatus(R.asinAdsRunStatusEntry({ region, plan, maxCreates, nowIso: startedIso, outcome: { systemic, creates: spent, covered: [...all.covered], rejected: [...all.rejected], transient: [...all.transient], ambiguous: [...all.ambiguous], budgetDeferred: [...all.budgetDeferred] } }));
} catch (e) { log("run-status write failed (non-fatal): " + String(e && e.message).slice(0, 100)); }
summaryOut("### ASIN Ads (" + label + ") " + out.classification + "\n- covered now " + out.covered.length + ", already covered " + out.alreadyCovered + ", incompatible " + out.incompatible.length + ", unreadable " + out.unreadable.length
  + "\n- failed: rejected " + out.failed.rejected.length + ", transient " + out.failed.transient.length + ", ambiguous " + out.failed.ambiguous.length + ", budget-deferred " + out.failed.budgetDeferred.length
  + "\n- " + spent + " create(s) / " + tokens + " token(s) (cap " + maxCreates + "), reused " + reused + " completed export(s) at zero tokens");
if (evidenceFile) {
  try { writeFileSync(evidenceFile, JSON.stringify({ at: new Date().toISOString(), region, asOf, plan: { pending: plan.pending, items: plan.items, covered: plan.covered.map((a) => a.accountId), incompatible: plan.incompatible.map((a) => a.accountId) }, result: { ...out, covered: [...all.covered], fragmentsFull: fragments } }, null, 1)); }
  catch (e) { log("evidence file not written: " + String(e && e.message).slice(0, 80)); }
}
process.exit(systemic ? 1 : 0);
