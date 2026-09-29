// Publication recovery WP5 -- the returns-v3 recovery ROUTE, CLI side (validated by route-contract.js
// validateRouteModule side:'cli' against the REAL SCHEDULER_LIVE_SNAPSHOT_CONTRACTS + REPORT_DERIVATIONS, paired with
// lib/server/recovery/routes/returns-v3.route.js by validateRoutePair). The generic route CLI
// (scripts/release/publication-route-reconcile.mjs) calls build(deps) and runs the returned runtime through the generic
// two-phase release (route-publication-release.js) -> the reviewed fenced four-gate publisher -> the shared live read-back
// -> the SERVED-ROW check. This module never writes anything itself: deps.sb is the READ-ONLY supabase facade and
// deps.pgReadOnly a single-SELECT read-only verified pg query. ZERO DataDoe (no DataDoe module is imported here).
//
// TARGET: the Returns & Refund Leakage page users see -- live report_key 'returns-leakage', version
// 'returns-leakage-v3', identity params { to }, served by api/datadoe.js serveSelfHealingReturns as the LATEST row for
// (report, account, version, scope {}) with an inline payload (serve-selectors.js selectLatestForScope). Publisher key
// 'returns-leakage-v3' (SOURCE_PROMOTED; the route's control package opens its promoted gate only for the window).
//
// RUNTIME (the route-contract.js hook contract):
//   readScopeEvidence -- the worker module's five METADATA-ONLY evidence SELECTs through deps.pgReadOnly + the SAME
//                        pure compose (returnsEvidenceByAccount) -> the L1 token is computed IDENTICALLY to the worker's;
//   computeRevision   -- returnsRevision (typed DEFERRED_PROVENANCE on missing evidence: 'returns-evidence-missing',
//                        'catalog-missing', 'directory-country-missing', 'oli-coverage-short');
//   expandUnits       -- the single account unit bound at targetAsOf = the evidence latestDataDate (the live { to });
//   resolveBundle     -- re-reads the metadata (same token), applies NEVER-REGRESS, then STRICT gatherReturnsEvidence at
//                        asOf = epoch (every fail-soft read is a typed not-ready), cross-checks the hydrated rows against
//                        the metadata the token bound (row counts + NO repeated primary-key tuple = the exact row set,
//                        latestDataDate, catalog sha, window-scoped OLI covered_to: a write between the two reads -- or a
//                        paged read that duplicated / skipped a row -- defers 'evidence-inconsistent:<what>'), and
//                        returns the manifest token
//                        'rm1:' + sha256 of the order-independent digests of the hydrated Returns, Settlement, ordered-OLI
//                        and catalog rows (+ catalog sha + proven OLI covered_to);
//   derive            -- the payload the strict gather already built (its own accountId / asOf / latestDataDate must be
//                        this unit's); the release then runs the REAL v3 validatePayload (a v2 payload is refused);
//   identityParams    -- { to: latestDataDate }; stampPolicy 'cycle' (the stamp is the route cycle's created_at);
//   servedSelector    -- selectLatestForScope('returns-leakage', account, 'returns-leakage-v3', {});
//   currentPredicate  -- NEVER-REGRESS (a served v3 row whose params.to is NEWER than this evidence's latestDataDate is
//                        superseded: DEFERRED_DEPENDENCY 'served-newer-to', zero writes -- publishing an older { to }
//                        would become the latest-updated row and regress the page) and the SOURCE-AGE alert (evidence
//                        older than 168 h: the verdict is unchanged but its reason carries 'source-stale-manual');
//   readEvidenceToken -- the scan's token, "" (-> the release defers 'evidence-advanced', zero CAS) when ineligible or
//                        when a newer { to } became served since prepare (never-regress re-checked immediately before
//                        the publish).
// Also exports the PURE golive helpers (planReturnsRouteInvocations / parseRouteResultLine) the dedicated Returns
// operator (scripts/release/returns-leakage-golive.mjs) uses for its step 7. 7-bit ASCII, LF.

import { createHash } from "node:crypto";
import { gatherReturnsEvidence, duplicateKeyCount, RETURNS_HISTORY_KEY_COLUMNS, SETTLEMENT_HISTORY_KEY_COLUMNS } from "../../reports/returns-publish.js";
import { stableJson, isCalendarDate, PUBLICATION_STATE } from "../publication-binding.js";
import { RECONCILE_STATUS } from "../saved-data-reconciler.js";
import { accountInScope } from "../scheduler-scope.js";
import { ROUTE_REGIONS, ROUTE_CLI_MAX_TARGETS } from "../route-publication-release.js";
import {
  RETURNS_V3_EVIDENCE_SQL, returnsEvidenceByAccount, returnsRevision, returnsSourceAlert,
  RETURNS_V3_ROUTE_ID, RETURNS_V3_PUBLISHER_KEY, RETURNS_V3_LIVE_REPORT_KEY, RETURNS_V3_LIVE_VERSION,
} from "../../recovery/routes/returns-v3.route.js";

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";
const sha256 = (v) => createHash("sha256").update(String(v)).digest("hex");
const no = (reason) => ({ eligible: false, reason });

export const RETURNS_MANIFEST_TOKEN_PREFIX = "rm1:";
// The read-only supabase readers the runtime needs (all get* -> present on the CLI's read-only facade).
const REQUIRED_READERS = Object.freeze([
  "getReturnsHistoryRows", "getSettlementHistoryRows", "getSourceOliHistoryRows", "getSourceCoverageWindows",
  "getSourceOliOperationalUnitRows", "getSourceSnapshot", "getSourceSnapshotPayload", "getOliSkuAsinResolutionRows",
  "getLatestReportSnapshotForScope",
]);

/** An ORDER-INDEPENDENT content digest of hydrated rows (the manifest never depends on the REST read order). */
export function rowsDigest(rows) {
  return sha256((Array.isArray(rows) ? rows : []).map((r) => stableJson(r)).sort().join("\n"));
}

/** The manifest token of a strict gather's hydrated evidence (PURE). */
export function returnsManifestToken(evidence) {
  const e = evidence && typeof evidence === "object" ? evidence : {};
  return RETURNS_MANIFEST_TOKEN_PREFIX + sha256(stableJson([
    rowsDigest(e.durableReturnRows), rowsDigest(e.durableSettlementRows), rowsDigest(e.orderedRows), rowsDigest(e.catalogRows),
    S(e.catalogPayloadSha), S(e.oliCoveredTo),
  ]));
}

// The serve's stored-row choice for the never-regress check: the latest v3 row for (report, account, scope {}) --
// served ONLY with an inline payload (api/datadoe.js serveSelfHealingReturns `stored && stored.payload`).
const servedNewerTo = (row, targetAsOf) => {
  const to = row && row.payload && row.params && typeof row.params === "object" ? row.params.to : null;
  return isCalendarDate(to) && isCalendarDate(targetAsOf) && to > targetAsOf;
};

function build(deps = {}) {
  const d = deps && typeof deps === "object" ? deps : {};
  const { directory, orgFp, sb, pgReadOnly, selectors, liveContracts = null } = d;
  const connectionId = S(d.connectionId || "primary");
  const now = typeof d.now === "function" ? d.now : () => Date.now();
  const log = typeof d.log === "function" ? d.log : () => {};
  // Test seam only (the CLI never passes it): the strict evidence gatherer.
  const gather = typeof d.gatherEvidence === "function" ? d.gatherEvidence : gatherReturnsEvidence;
  if (!(directory instanceof Map)) throw new Error("returns-v3 build: deps.directory (the durable account directory Map) is required (fail closed).");
  if (!nb(orgFp)) throw new Error("returns-v3 build: deps.orgFp is required (fail closed).");
  if (typeof pgReadOnly !== "function") throw new Error("returns-v3 build: deps.pgReadOnly is required (fail closed).");
  if (!selectors || typeof selectors.selectLatestForScope !== "function") throw new Error("returns-v3 build: deps.selectors.selectLatestForScope is required (fail closed).");
  for (const name of REQUIRED_READERS) if (!sb || typeof sb[name] !== "function") throw new Error(`returns-v3 build: deps.sb.${name} is required (fail closed).`);
  if (liveContracts) {
    const c = liveContracts[RETURNS_V3_PUBLISHER_KEY];
    if (!c || c.liveReportKey !== RETURNS_V3_LIVE_REPORT_KEY || c.liveReportVersion !== RETURNS_V3_LIVE_VERSION) throw new Error("returns-v3 build: the live contract no longer targets returns-leakage / returns-leakage-v3 (fail closed).");
  }

  // The latest per-account evidence the scan read (the source-age alert of the current predicate reads it).
  const lastEvidence = new Map();
  async function readEvidence({ scope, epoch, directory: dir, organizationFingerprint, connectionId: conn }) {
    const ids = [...new Set((Array.isArray(scope) ? scope : []).map(S).filter(Boolean))].sort();
    const ctx = { epoch, accountIds: ids, organizationFingerprint: nb(organizationFingerprint) ? S(organizationFingerprint) : S(orgFp), connectionId: nb(conn) ? S(conn) : connectionId };
    const rowsByName = {};
    for (const q of RETURNS_V3_EVIDENCE_SQL) {
      const rows = await pgReadOnly(q.text, q.params(ctx));
      if (!Array.isArray(rows)) throw new Error("returns-v3 evidence query '" + q.name + "' returned no rows array");
      rowsByName[q.name] = rows;
    }
    const perAccount = returnsEvidenceByAccount(rowsByName, { epoch, accountIds: ids, directory: dir instanceof Map ? dir : directory });
    for (const [a, ev] of perAccount) lastEvidence.set(a, ev);
    return perAccount;
  }
  const readServedRaw = async (accountId) => sb.getLatestReportSnapshotForScope({ reportKey: RETURNS_V3_LIVE_REPORT_KEY, accountId, reportVersion: RETURNS_V3_LIVE_VERSION, scope: {} });
  // Per-call readers for the strict gather (signal-threaded where the supabase reader supports it).
  const readersFor = (signal) => ({
    readReturnsHistory: (a) => sb.getReturnsHistoryRows({ ...a, signal }),
    readSettlementHistory: (a) => sb.getSettlementHistoryRows({ ...a, signal }),
    readOliHistory: (a) => sb.getSourceOliHistoryRows({ ...a, signal }),
    readOliCoverage: (a) => sb.getSourceCoverageWindows({ ...a, signal }),
    readOliOperationalUnits: (a) => sb.getSourceOliOperationalUnitRows({ ...a, signal }),
    readCatalogSnapshot: (a) => sb.getSourceSnapshot({ ...a, signal }),
    loadCatalogPayload: (p) => sb.getSourceSnapshotPayload(p, { signal }),
    readOliSkuAsinResolution: (a) => sb.getOliSkuAsinResolutionRows({ ...a, signal }),
    // The SAME durable directory the scan + the token use (never a second, possibly different, directory read).
    readDirectory: async () => [...directory.values()].map((e) => ({ accountId: e.accountId, country: e.country })),
  });

  const runtime = {
    async readScopeEvidence({ scope, epoch, directory: dir, organizationFingerprint, connectionId: conn } = {}) {
      try { return { ok: true, perAccount: await readEvidence({ scope, epoch, directory: dir, organizationFingerprint, connectionId: conn }) }; }
      catch (_e) { return { ok: false, failCode: "DURABLE_SOURCE_UNREADABLE: returns-v3-evidence-read-failed" }; }
    },

    computeRevision({ evidence, epoch } = {}) {
      return returnsRevision(evidence, { epoch });
    },

    expandUnits({ accountId, evidence, requestedAsOf, epoch } = {}) {
      const rev = returnsRevision(evidence, { epoch: requestedAsOf ?? epoch });
      if (!rev.eligible) return [{ unitKey: "-", targetId: accountId, liveAccountId: accountId, ownerAccountIds: [accountId], targetAsOf: null, reportKeys: [RETURNS_V3_PUBLISHER_KEY], deferred: { state: RECONCILE_STATUS.DEFERRED_PROVENANCE, reason: rev.reason } }];
      return [{ unitKey: "-", targetId: accountId, liveAccountId: accountId, ownerAccountIds: [accountId], targetAsOf: rev.targetAsOf, reportKeys: [RETURNS_V3_PUBLISHER_KEY] }];
    },

    async resolveBundle(unit, { epoch, signal = null } = {}) {
      const targetId = S(unit && unit.targetId);
      if (!nb(targetId) || !isCalendarDate(epoch)) return no("bad-unit");
      let perAccount;
      try { perAccount = await readEvidence({ scope: [targetId], epoch }); } catch (_e) { return no("evidence-read-failed:metadata"); }
      const ev = perAccount.get(targetId);
      const rev = returnsRevision(ev, { epoch });
      if (!rev.eligible) return no(rev.reason);
      // NEVER-REGRESS: a served v3 row with a NEWER { to } than this evidence can bind is never superseded by it.
      let served;
      try { served = await readServedRaw(S(unit.liveAccountId || targetId)); } catch (_e) { return no("served-read-failed"); }
      if (servedNewerTo(served, rev.targetAsOf)) return no("served-newer-to");
      let g;
      try { g = await gather({ accountId: targetId, organizationFingerprint: S(orgFp), connectionId, asOf: epoch }, readersFor(signal), { strict: true }); }
      catch (_e) { return no("evidence-read-failed:gather"); }
      if (!g || typeof g !== "object") return no("evidence-not-ready");
      if (g.notReady) return no(S(g.notReady));
      const e = g.evidence;
      if (!g.payload || !e || typeof e !== "object") return no("evidence-not-strict");
      // The hydrated rows must BE the evidence the metadata token bound (a durable write between the reads defers).
      if (!Array.isArray(e.durableReturnRows) || e.durableReturnRows.length !== ev.returns.n) return no("evidence-inconsistent:returns");
      if (!Array.isArray(e.durableSettlementRows) || e.durableSettlementRows.length !== ev.settlement.n) return no("evidence-inconsistent:settlement");
      // count == the SQL count(*) AND no repeated primary-key tuple => the EXACT durable row set (a paged read that
      // duplicated one row and skipped another keeps the count; the strict gather refuses it too -- defense in depth
      // for any gatherer).
      if (duplicateKeyCount(e.durableReturnRows, RETURNS_HISTORY_KEY_COLUMNS) > 0) return no("evidence-inconsistent:returns-duplicate");
      if (duplicateKeyCount(e.durableSettlementRows, SETTLEMENT_HISTORY_KEY_COLUMNS) > 0) return no("evidence-inconsistent:settlement-duplicate");
      if (S(g.latestDataDate) !== S(rev.targetAsOf)) return no("evidence-inconsistent:asof");
      if (S(e.catalogPayloadSha) !== S(ev.catalog && ev.catalog.payloadSha)) return no("evidence-inconsistent:catalog");
      // The proven OLI covered_to the manifest binds is the SAME window-scoped max the token bound (both over the
      // succeeded windows overlapping [from, epoch]); a coverage write between the two reads defers.
      if (S(e.oliCoveredTo) !== S(ev.oli && ev.oli.coveredTo)) return no("evidence-inconsistent:oli");
      return {
        eligible: true, revisionId: rev.revisionId, evidenceToken: rev.evidenceToken, manifestToken: returnsManifestToken(e), deps: rev.deps,
        bundle: Object.freeze({ accountId: targetId, epoch, latestDataDate: S(g.latestDataDate), payload: g.payload }),
      };
    },

    async derive(bundle, { unit } = {}) {
      const p = bundle && bundle.payload;
      if (!p || typeof p !== "object") return { notReady: true, reason: "bundle-empty" };
      if (S(p.accountId) !== S(unit && unit.targetId) || S(p.accountId) !== S(bundle.accountId)) return { notReady: true, reason: "payload-account-mismatch" };
      if (S(p.asOf) !== S(bundle.epoch)) return { notReady: true, reason: "payload-asof-mismatch" };
      if (S(p.latestDataDate) !== S(bundle.latestDataDate)) return { notReady: true, reason: "payload-latest-date-mismatch" };
      return { payload: p, latestDataDate: S(bundle.latestDataDate) };
    },

    identityParams(_unit, { bundle } = {}) {
      return { to: S(bundle && bundle.latestDataDate) };
    },

    identityAsOf(_unit, { bundle } = {}) {
      return S(bundle && bundle.latestDataDate);
    },

    servedSelector(unit) {
      return selectors.selectLatestForScope({
        reportKey: RETURNS_V3_LIVE_REPORT_KEY, accountId: S(unit && unit.liveAccountId), reportVersion: RETURNS_V3_LIVE_VERSION, scope: {},
        readers: { getLatestReportSnapshotForScope: (a) => sb.getLatestReportSnapshotForScope(a) },
      });
    },

    async currentPredicate(rk, unit, ctx = {}) {
      if (rk !== RETURNS_V3_PUBLISHER_KEY) return null;
      let served;
      try { served = await readServedRaw(S(unit && unit.liveAccountId)); } catch (_e) { return { state: RECONCILE_STATUS.DEFERRED_DEPENDENCY, reason: "served-read-failed" }; }
      if (servedNewerTo(served, unit && unit.targetAsOf)) return { state: RECONCILE_STATUS.DEFERRED_DEPENDENCY, reason: "served-newer-to" };
      const alert = returnsSourceAlert(lastEvidence.get(S(ctx.accountId || (unit && unit.targetId))), Number(now()));
      if (!alert) return null; // the exact binding (+ the served-row check) decides, unchanged
      const b = typeof ctx.binding === "function" ? ctx.binding() : null;
      const reason = (r) => (nb(r) ? S(r) + ":" + alert : alert);
      if (b && b.state === PUBLICATION_STATE.PUBLICATION_NOT_REQUIRED) {
        log(`route ${RETURNS_V3_ROUTE_ID}: saved Returns/Settlement evidence older than 168 h (${alert}); verified from saved evidence, zero exports`);
        return { state: b.state, reason: reason(b.reason), h: nb(ctx.candHash) ? S(ctx.candHash) : null, sra: ctx.live && nb(ctx.live.source_refreshed_at) ? S(ctx.live.source_refreshed_at) : null };
      }
      if (b && b.state === PUBLICATION_STATE.STALE) return { state: b.state, reason: reason(b.reason) };
      return null;
    },

    async readEvidenceToken(unit, { accountId, epoch, directory: dir, organizationFingerprint, connectionId: conn } = {}) {
      const a = S(accountId || (unit && unit.targetId));
      let perAccount;
      try { perAccount = await readEvidence({ scope: [a], epoch, directory: dir, organizationFingerprint, connectionId: conn }); } catch (_e) { return ""; }
      const rev = returnsRevision(perAccount.get(a), { epoch });
      if (!rev.eligible) return "";
      let served;
      try { served = await readServedRaw(S((unit && unit.liveAccountId) || a)); } catch (_e) { return ""; }
      if (servedNewerTo(served, rev.targetAsOf)) return "";
      return rev.evidenceToken;
    },
  };
  return runtime;
}

// ---- PURE helpers for the dedicated Returns operator's step 7 (scripts/release/returns-leakage-golive.mjs) ----------

/**
 * Group the accounts the Returns cycle acquired into route CLI invocations: one per (region, <= maxTargets accounts),
 * routed EXACTLY like the route CLI's own scope (regionAccountIds: accountInScope over the DURABLE directory country),
 * so no invocation is ever refused ROUTE_TARGET_OUT_OF_SCOPE. An account absent from the durable directory (or with no
 * routable country) is reported in `outOfScope` (typed, never published, never guessed into a region).
 */
export function planReturnsRouteInvocations({ accountIds, directory, maxTargets = ROUTE_CLI_MAX_TARGETS } = {}) {
  const cap = Number.isInteger(maxTargets) && maxTargets > 0 && maxTargets <= ROUTE_CLI_MAX_TARGETS ? maxTargets : ROUTE_CLI_MAX_TARGETS;
  const byRegion = new Map(ROUTE_REGIONS.map((r) => [r, []]));
  const outOfScope = [];
  const ids = [...new Set((Array.isArray(accountIds) ? accountIds : []).map((a) => S(a).trim()).filter(Boolean))].sort();
  for (const id of ids) {
    const e = directory instanceof Map ? directory.get(id) : null;
    const region = e ? ROUTE_REGIONS.find((r) => accountInScope(r, S(e.country).toUpperCase())) : null;
    if (!region) { outOfScope.push(id); continue; }
    byRegion.get(region).push(id);
  }
  const chunks = [];
  for (const [region, list] of byRegion) for (let i = 0; i < list.length; i += cap) chunks.push({ region, targets: list.slice(i, i + cap) });
  return { chunks, outOfScope };
}

export const RETURNS_ALERT_PREFIX = "RETURNS_ALERT ";
/**
 * The typed operator alert for acquired accounts the route can NOT publish because they are outside the durable
 * directory scope (planReturnsRouteInvocations.outOfScope) -- so an unpublished account is visible, never silent.
 * -> null when there are none, else { line: 'RETURNS_ALERT {"outOfScope":n,"accounts":[...]}',
 * githubOutput: 'returns_out_of_scope=<n>' } (n = the distinct, sorted, nonblank account ids).
 */
export function returnsOutOfScopeAlert(outOfScope) {
  const accounts = [...new Set((Array.isArray(outOfScope) ? outOfScope : []).map((a) => S(a).trim()).filter(Boolean))].sort();
  if (!accounts.length) return null;
  return { line: RETURNS_ALERT_PREFIX + JSON.stringify({ outOfScope: accounts.length, accounts }), githubOutput: `returns_out_of_scope=${accounts.length}` };
}

/** The route CLI's machine RESULT (its LAST `RESULT {...}` stdout line), or null when absent / malformed. */
export function parseRouteResultLine(stdout) {
  const lines = S(stdout).split(/\r?\n/).filter((l) => l.startsWith("RESULT "));
  if (!lines.length) return null;
  try { const r = JSON.parse(lines[lines.length - 1].slice(7)); return r && typeof r === "object" && !Array.isArray(r) ? r : null; } catch { return null; }
}

const RETURNS_V3_RELEASE = Object.freeze({
  id: RETURNS_V3_ROUTE_ID,
  publisherKey: RETURNS_V3_PUBLISHER_KEY,
  stampPolicy: "cycle",
  build,
});

export default RETURNS_V3_RELEASE;
