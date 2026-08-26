// The ONE trusted source-sync orchestration shared by the AUTOMATIC GitHub scheduler, the Data Sync Center
// manual "Sync source" action, and controlled operator scripts -- so the two execution paths cannot drift.
//
// It accepts ONLY reviewed server-side identifiers ({ bucket, sourceKey, origin, asOf }); request columns,
// seller ids, export limits, report keys, owner bindings, publication keys, and token ceilings are NEVER taken
// from a request body -- they live in the frozen registries this module and its collaborators own.
//
// After a successful source sync the affected dashboards are derived from the SAME persisted durable evidence
// (never a separate export per dashboard), published through the reviewed release engine (freshness CAS, exact
// live read-back), and the temporary publication controls are ALWAYS safe-closed -- per slice, so an abandoned
// continuation can never leave the gates open between requests.

import { PRIORITY_DASHBOARDS, SCHEDULED_OPERATION_KEY_PREFIX } from "./source-priority-dashboards.js";

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(S(v));

// The FROZEN orchestrated source set for this release. Campaign Ads, FBA, and every other family are refused --
// they stay paused and are never scheduled or created by this operation.
export const ORCHESTRATED_SOURCE_KEYS = Object.freeze(["order-line-items", "ads-asin-date", "product-catalog"]);

// The EXPLICIT immutable source -> dashboard dependency registry. One source sync derives EVERY affected report
// from the same persisted evidence. daily/brand-sales/brand-inventory are the release engine's frozen priority
// scope; the ads + membership/portfolio surfaces are zero-export re-derivations from the same durable rows.
export const SOURCE_DASHBOARD_DEPENDENCIES = Object.freeze({
  "order-line-items": Object.freeze({
    reports: Object.freeze(["daily-reporting", "brand-sales", "brand-inventory"]),
    adsRepublish: false,  // OLI changes are carried by the release derive itself
    membership: true,     // fresh brand-sales evidence can change Brand View membership
  }),
  "ads-asin-date": Object.freeze({
    reports: Object.freeze(["daily-reporting", "brand-sales", "brand-inventory"]),
    adsRepublish: true,   // Daily v2 ads-provenance republish + Brand View portfolio ads from the same rows
    membership: false,    // ads never change brand-sales membership
  }),
  "product-catalog": Object.freeze({
    reports: Object.freeze(["daily-reporting", "brand-sales", "brand-inventory"]),
    adsRepublish: true,   // catalog drives ASIN->brand attribution for ads surfaces too
    membership: true,     // catalog changes brand attribution + selector membership
  }),
});

export const OPERATION_ORIGINS = Object.freeze(["scheduled", "admin-manual"]);

/**
 * Validate the ONLY inputs the trusted operation accepts. Throws a typed error on anything outside the frozen
 * enums (fail closed) -- there is no pass-through of request-shaping data. Returns the normalized identifiers
 * plus the date-scoped catalog operation key (manual + scheduled same-day operations SHARE it, so the org-wide
 * Catalog is created at most once per date across BOTH paths).
 */
export function validateSourceSyncRequest({ bucket, sourceKey, origin, asOf } = {}) {
  const b = S(bucket).trim();
  if (b !== "us" && b !== "non-us") { const e = new Error("SOURCE_SYNC_BAD_BUCKET: bucket must be us|non-us."); e.code = "SOURCE_SYNC_BAD_BUCKET"; e.status = 400; throw e; }
  const k = S(sourceKey).trim();
  if (!ORCHESTRATED_SOURCE_KEYS.includes(k)) { const e = new Error("SOURCE_SYNC_BAD_SOURCE: sourceKey must be one of " + ORCHESTRATED_SOURCE_KEYS.join("|") + "."); e.code = "SOURCE_SYNC_BAD_SOURCE"; e.status = 400; throw e; }
  const o = S(origin).trim();
  if (!OPERATION_ORIGINS.includes(o)) { const e = new Error("SOURCE_SYNC_BAD_ORIGIN: origin must be scheduled|admin-manual."); e.code = "SOURCE_SYNC_BAD_ORIGIN"; e.status = 400; throw e; }
  const a = S(asOf).trim();
  if (!isDate(a)) { const e = new Error("SOURCE_SYNC_BAD_ASOF: asOf must be YYYY-MM-DD."); e.code = "SOURCE_SYNC_BAD_ASOF"; e.status = 400; throw e; }
  return Object.freeze({
    bucket: b, sourceKey: k, origin: o, asOf: a,
    dependencies: SOURCE_DASHBOARD_DEPENDENCIES[k],
    operationKey: SCHEDULED_OPERATION_KEY_PREFIX + a,
  });
}

const OK_FINALIZE = new Set(["finalized", "already-terminal"]);
const OK_PUBLISH = new Set(["published", "already-current"]);

/**
 * ONE bounded slice of the post-sync RELEASE for a bucket: derive (resumable) -> runner-grade consistency
 * assertion -> finalize -> preflight EVERY account -> open controls, publish until the slice budget runs out,
 * ALWAYS safe-close -> exact live read-back. Stateless-resumable: every phase re-proves from DURABLE state
 * (publishAccount is freshness-CAS idempotent -- "already-current" -- so a replayed slice never regresses a newer
 * snapshot and never double-writes). Returns a typed result:
 *   { phase, ok?, continuationRequired?, problems?, published?, total?, readback? }
 *
 * deps: {
 *   release        -- buildPriorityDashboardsRelease(...) surface (deriveBucket/finalizeBucket/preflightAccount/
 *                     publishAccount/catalogReservation);
 *   controls       -- { apply(): Promise, close(): Promise } -- the reviewed priority control package; close runs
 *                     in `finally`, so gates NEVER stay open past the slice, even on failure;
 *   readbackLive   -- (reportKey, accountId) -> { ok, problems } exact-identity live read-back;
 *   outOfTime      -- () => boolean: the caller's slice budget (route deadline / operator budget);
 *   log            -- optional narration sink (safe strings only).
 * }
 */
export async function runReleaseSlice({ bucket, release, controls, readbackLive, outOfTime = () => false, log = () => {} } = {}) {
  if (bucket !== "us" && bucket !== "non-us") return { phase: "validate", ok: false, problems: ["bad-bucket"] };
  if (!release || typeof release.deriveBucket !== "function") return { phase: "validate", ok: false, problems: ["release-surface-missing"] };
  if (!controls || typeof controls.apply !== "function" || typeof controls.close !== "function") return { phase: "validate", ok: false, problems: ["controls-missing"] };
  if (typeof readbackLive !== "function") return { phase: "validate", ok: false, problems: ["readback-missing"] };

  // (1) DERIVE (resumable). A stopped derive is a typed failure with LKG intact; an out-of-budget derive is a
  // continuation, never a failure.
  const { rollup } = await release.deriveBucket(bucket);
  if (!rollup || rollup.stopped === true) {
    return { phase: "derive", ok: false, problems: ["derive stopped: " + S(rollup && rollup.stopReason && rollup.stopReason.code)] };
  }
  if (rollup.continuationRequired === true || (rollup.globalDrained !== true && rollup.alreadyComplete !== true)) {
    return { phase: "derive", continuationRequired: true, ok: null };
  }
  // Runner-grade consistency assertion (mirrors source-priority-release-runner): a ready=false/saved=0 derive is
  // NOT "derive ok". An already-complete cycle passes to the finalizer, which re-proves the exact counts.
  if (rollup.alreadyComplete !== true && !(rollup.derived && rollup.derived.skipped != null)) {
    const d = rollup.derived || {};
    const daily = d.daily || {}, bv = d.brandView || {}, inv = d.brandInventory || {};
    const ds = Number(daily.saved || 0), bs = Number(bv.saved || 0), is = Number(inv.saved || 0);
    const lineageCount = Array.isArray(d.lineage) ? d.lineage.length : 0;
    const problems = [];
    if (daily.ready !== true) problems.push("daily-reporting not ready");
    if (bv.ready !== true) problems.push("brand-sales not ready");
    if (ds <= 0 || bs <= 0 || is <= 0) problems.push("saved report jobs = 0 (" + ds + "/" + bs + "/" + is + ")");
    else if (ds !== bs || bs !== is) problems.push("inconsistent per-account counts (" + ds + "/" + bs + "/" + is + ")");
    if (lineageCount !== ds + bs + is) problems.push("lineage " + lineageCount + " != saved " + (ds + bs + is));
    if (problems.length) return { phase: "derive", ok: false, problems };
    log("derive ok: " + bucket + " (" + ds + " x 3 report jobs)");
  } else if (rollup.derived && rollup.derived.skipped != null) {
    return { phase: "derive", ok: false, problems: ["derive skipped: " + S(rollup.derived.skipped)] };
  } else {
    log("derive ok: " + bucket + " (already-complete cycle)");
  }

  // (2) token ceiling from the durable reservation (a warm-cache release makes zero creates).
  const reservation = await release.catalogReservation(null);
  const tokensSpent = reservation ? Number(reservation.tokensSpent) : 0;
  if (tokensSpent > PRIORITY_DASHBOARDS.maxTokens) return { phase: "token-ceiling", ok: false, problems: ["reservation tokens " + tokensSpent + " > " + PRIORITY_DASHBOARDS.maxTokens] };

  // (3) FINALIZE this bucket's cycle (idempotent: already-terminal accepted); collect the proven account scope.
  const fin = await release.finalizeBucket(bucket);
  if (!fin || !OK_FINALIZE.has(S(fin.disposition))) {
    return { phase: "finalize", ok: false, problems: ["finalize refused: " + S(fin && (fin.reason || fin.disposition))] };
  }
  const accounts = [...new Set((fin.accounts || []).map(S).filter(nb))].sort();
  if (!accounts.length) return { phase: "finalize", ok: false, problems: ["finalize returned no accounts"] };
  log("finalize ok: " + bucket + " (" + accounts.length + " accounts, " + S(fin.cycleStatus) + ")");

  // (4)+(5) PREFLIGHT + PUBLISH inside ONE open->...->ALWAYS-safe-close envelope. The publish gate consults the
  // temporary publication controls (publish_enabled / schedule_enabled, fail closed), which are safe-closed
  // outside the envelope by design -- so the all-or-nothing preflight MUST run with the controls open. It is
  // read-only and re-proven on every slice, and it still runs BEFORE the first publish write: a preflight
  // failure exits through the finally (controls safe-closed) having published NOTHING.
  const published = [];
  let remaining = [...accounts];
  await controls.apply();
  try {
    for (const accountId of accounts) {
      const pre = await release.preflightAccount(accountId);
      const rs = (pre && pre.results) || [];
      const bad = rs.filter((r) => !(r && r.disposition === "ready" && nb(r.liveReportKey) && nb(r.paramsHash)));
      if (rs.length !== PRIORITY_DASHBOARDS.reportKeys.length || bad.length) {
        return { phase: "preflight", ok: false, problems: ["publish gate not ready for an account (" + (bad[0] && bad[0].reportKey || "shape") + ": " + S(bad[0] && bad[0].disposition) + ")"] };
      }
    }
    log("preflight ok: " + accounts.length + " accounts x " + PRIORITY_DASHBOARDS.reportKeys.length + " gates");

    while (remaining.length && !outOfTime()) {
      const accountId = remaining[0];
      const res = await release.publishAccount(accountId);
      const rs = (res && res.results) || [];
      const bad = rs.filter((r) => !(r && OK_PUBLISH.has(S(r.disposition))));
      if (rs.length !== PRIORITY_DASHBOARDS.publishOrder.length || bad.length) {
        return { phase: "publish", ok: false, problems: ["publish failed (" + S(bad[0] && bad[0].reportKey) + ": " + S(bad[0] && bad[0].disposition) + ")"], published: published.length, total: accounts.length };
      }
      published.push(accountId);
      remaining = remaining.slice(1);
    }
  } finally {
    // SAFE-CLOSE runs on EVERY exit from the publish envelope -- success, failure, or slice-budget pause -- so
    // the temporary gates never survive past this request.
    await controls.close();
  }
  if (remaining.length) {
    log("publish slice: " + published.length + "/" + accounts.length + " published; continuation required");
    return { phase: "publish", continuationRequired: true, published: published.length, total: accounts.length };
  }

  // (6) EXACT live read-back for every (report, account) pair.
  const readback = [];
  for (const accountId of accounts) {
    for (const reportKey of PRIORITY_DASHBOARDS.publishOrder) {
      const rb = await readbackLive(reportKey, accountId);
      if (!rb || rb.ok !== true) {
        return { phase: "readback", ok: false, problems: ["live read-back failed (" + reportKey + "): " + S(rb && rb.problems && rb.problems[0])], published: published.length, total: accounts.length };
      }
      readback.push({ reportKey, accountId });
    }
  }
  log("read-back ok: " + readback.length + " live pairs");
  return { phase: "complete", ok: true, published: accounts.length, total: accounts.length, readback: readback.length };
}
