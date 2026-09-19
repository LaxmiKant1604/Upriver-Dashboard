// Report Delivery Status -- admin-only, READ-ONLY shaping of existing durable production evidence into a
// per-account / per-source EXPORT + PUBLISH matrix. It answers, after each scheduler cycle: was each source
// exported/validated for this account, was its dependent live dashboard published + readable, what is the latest
// validated timestamp, and (if not) what SAFE stage/code failed.
//
// SAFETY: this module NEVER writes, exports, dispatches, or spends tokens. It only shapes evidence that the caller
// has ALREADY read via the injected read-only Supabase helpers. It is FAIL-CLOSED: a reader error, a missing/
// unapplied schema, or an unconfigured org identity maps to "Unavailable" -- never a fabricated "Yes"/"No"/zero.
// account-safe / admin-safe only: no object paths, payload bodies, raw provider errors, or seller credentials leave
// this layer -- only the classified statuses, safe stage/code, and the durable validated timestamps.
//
// The source -> dependent-live-dashboard mapping is DERIVED from the canonical registries (never hardcoded, so it
// cannot drift): a live-publishable report (a key of SCHEDULER_LIVE_SNAPSHOT_CONTRACTS) is a dependent of a source
// iff that source appears in its direct requirements, its derived durable deps, OR any reconciler lineage-families
// map. The Publish universe is exactly those live-publishable keys; a shadow ("scheduler-v2/<key>") row or a report
// JOB row is NEVER counted as published.

import { regionForMarketplace, REGIONS, REGION_SCHEDULE } from "./sync/campaign-region-routing.js";
import {
  OLI_SOURCE_KEY, CATALOG_SOURCE_KEY, FBA_INVENTORY_SOURCE_KEY,
  LISTINGS_SOURCE_KEY, LISTINGS_RAW_SOURCE_KEY, ORGANIZATION_SCOPE_KEY,
} from "./sync/source-durable-model.js";
import { REPORT_SOURCE_REQUIREMENTS } from "./source-contracts.js";
import { REPORT_DERIVED_SOURCE_KEYS, isValidCalendarDate } from "./sync/report-source-contracts.js";
import { OLI_LINEAGE_DEPENDS_ON } from "./sync/oli-dependent-reports.js";
import { ADS_LINEAGE_DEPENDS_ON, ADS_CAMPAIGN_SOURCE_KEY, adsWorkerKeyForGrain } from "./sync/ads-dependent-reports.js";
import { FBA_LINEAGE_DEPENDS_ON } from "./sync/fba-dependent-reports.js";
import { LISTINGS_LINEAGE_DEPENDS_ON } from "./sync/listing-health-v3-dependent-reports.js";
import { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } from "./sync/report-publisher.js";
// The CANONICAL active-connection predicate every scheduler/reconciler/publisher path already applies (report-planner,
// sync-dispatch, source-bucket-sync-runtime, publisher-composition, all four reconcilers). The admin view MUST apply
// the SAME one so it can never show an account the pipeline will not operate. datadoe-connections.js is a pure registry
// (imports only source-identity crypto) -- no transport, no writes.
import { classifyDirectoryAccounts, getDataDoeConnections } from "./datadoe-connections.js";
// The CANONICAL report-materialization registry -- the ONE place each report declares whether it has an ACTIVE
// per-region live publisher. Registry-derived (never hardcoded) so a superseded/shadow report drops out of the Publish
// universe automatically. Pure + offline (report-derivation.js it transitively reaches declares "NO transport/supabase").
import { REPORT_MATERIALIZATION } from "./reports/report-materialization-registry.js";

const S = (v) => (v == null ? "" : String(v));
const isDate = (v) => isValidCalendarDate(S(v));
// Real RFC3339-ish timestamp sanity (never trust a stored value blindly; a malformed one is Unavailable, not Yes).
const isTs = (v) => {
  if (v == null) return false;
  const t = Date.parse(String(v));
  return Number.isFinite(t);
};

// A Postgres `date` string minus/plus N days, computed in UTC (deterministic; no local-timezone shift -- Date.UTC
// and toISOString are both UTC, so this never reproduces the toISOString()-on-a-date IST drift). Returns null on a
// malformed input rather than a fabricated date.
export function addDaysStr(dateStr, delta) {
  if (!isDate(dateStr)) return null;
  const [y, m, d] = String(dateStr).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + Number(delta || 0));
  return dt.toISOString().slice(0, 10);
}

// ---- Region options for the dropdown (canonical order + labels; never a frontend-duplicated marketplace rule). ----
export const DELIVERY_REGIONS = Object.freeze([
  { value: REGIONS.INDIA, label: REGION_SCHEDULE[REGIONS.INDIA].label },
  { value: REGIONS.EUROPE_AU, label: REGION_SCHEDULE[REGIONS.EUROPE_AU].label },
  { value: REGIONS.US_CA, label: REGION_SCHEDULE[REGIONS.US_CA].label },
]);
const REGION_VALUES = new Set(DELIVERY_REGIONS.map((r) => r.value));
export function normalizeDeliveryRegion(region) {
  const r = S(region).trim();
  return REGION_VALUES.has(r) ? r : REGIONS.INDIA; // default to the first region; never throw for a bad param
}

// ---- The six source columns of the matrix, in display order. Each declares how its per-account EXPORT evidence is
// read + whether that evidence is calendar-DATED (D-1 coverage) or a DATE-FREE current-state snapshot (validated_at
// only). Listings/Listings-Raw are DATE-FREE: their freshness is validated_at, NOT the as_of cycle LABEL. ----
export const DELIVERY_SOURCES = Object.freeze([
  { sourceKey: OLI_SOURCE_KEY, label: "Order Line Items", evidence: "oli-coverage", dated: true },
  { sourceKey: CATALOG_SOURCE_KEY, label: "Product Catalog", evidence: "org-snapshot", dated: false },
  { sourceKey: ADS_CAMPAIGN_SOURCE_KEY, label: "Campaign Ads", evidence: "ads-state", dated: true },
  // FBA Inventory Health has NO standalone durable source pointer (unlike OLI coverage / Catalog+Listings snapshots):
  // it is fetched as an OWNED export of fba-plan and consumed. Its per-account export proof is therefore the fba-plan
  // report JOB (validated + latest_data_date === the single-day D-1 it fetched) -- a DATED signal. NOTE: this is
  // EXPORT evidence (the source was fetched + validated), NOT publication (a validated job is never a publish proof).
  { sourceKey: FBA_INVENTORY_SOURCE_KEY, label: "FBA Inventory", evidence: "fba-plan-job", dated: true },
  { sourceKey: LISTINGS_SOURCE_KEY, label: "Listings", evidence: "listings-pointer", dated: false },
  { sourceKey: LISTINGS_RAW_SOURCE_KEY, label: "Listings Raw", evidence: "listings-raw-pointer", dated: false },
]);

// ---- Registry-derived source -> dependent live-report mapping (drift-proof). ----
const LINEAGE_MAPS = [OLI_LINEAGE_DEPENDS_ON, ADS_LINEAGE_DEPENDS_ON, FBA_LINEAGE_DEPENDS_ON, LISTINGS_LINEAGE_DEPENDS_ON];
export const LIVE_PUBLISHABLE_REPORT_KEYS = Object.freeze(Object.keys(SCHEDULER_LIVE_SNAPSHOT_CONTRACTS).slice().sort());

// ---- Registry-derived "has an ACTIVE per-region live publisher" predicate (drift-proof; never hardcoded). ----
// A live-publishable report is a REAL current publication target ONLY when the canonical materialization registry says
// it is published per region daily. A report the registry marks otherwise has NO live publisher today and must NOT be
// counted as an expected publication -- otherwise it fabricates a permanent partial fraction. The two cases that matter
// for the six-source matrix:
//   - ppc-performance: SUPERSEDED by the durable Campaign Ads workspace (materialization registry: regionalScheduling
//     "shadow", "the ppc-performance snapshot itself has no live publisher"). It stays in ADS_LINEAGE_DEPENDS_ON (the
//     durable-lineage inverse) but has no live promotion, so counting it inflated Campaign Ads to a permanent K/2.
//   - listing-health-v3: regionalScheduling "shadow" until its DOUBLE serve gate flips on (handled separately below).
// Every other live-publishable key here is either per-region-daily (kept) or not a dependent of any of the six sources
// (irrelevant to the matrix). A future report flips automatically when its registry owner changes -- no edit here.
const MATERIALIZATION_BY_REPORT_KEY = new Map(Object.values(REPORT_MATERIALIZATION).map((e) => [S(e.reportKey), e]));
export function reportHasActiveLivePublisher(reportKey) {
  const entry = MATERIALIZATION_BY_REPORT_KEY.get(S(reportKey));
  return entry ? entry.regionalScheduling === "per-region-daily" : true; // absent from the registry => fail toward showing
}
// The live-publishable keys with NO active live publisher today (superseded/shadow/on-demand). Excluded from every
// source's Publish universe. listing-health-v3 is re-included by the loader when its double serve gate is enabled.
export const NO_LIVE_PUBLISHER_REPORT_KEYS = Object.freeze(LIVE_PUBLISHABLE_REPORT_KEYS.filter((rk) => !reportHasActiveLivePublisher(rk)));

// FBA Shipment Plan is the ONE scheduler-published (non-reconciler) dashboard built DIRECTLY on the sources it OWNS
// as fetched exports -- FBA Inventory Health + Listings (AWD). It has a live publication contract but no saved-data
// reconciler of its own, so the lineage maps alone would omit it. We add it for EXACTLY its owned sources (from
// REPORT_SOURCE_REQUIREMENTS minus REPORT_DERIVED_SOURCE_KEYS -- so if fba-plan's contract ever changes, this tracks
// it). This is the only named dashboard here; every other dependency is pure reconciler-lineage.
const FBA_PLAN_LIVE_KEY = "fba-plan";
function reportDependsOnSource(reportKey, sourceKey) {
  // (1) reconciler lineage: the source's saved-data reconciler (re)derives + promotes this live report when the
  //     source advances -- the canonical "this dashboard is delivered from this source" relationship.
  for (const map of LINEAGE_MAPS) {
    const fams = map[reportKey];
    if (Array.isArray(fams) && fams.includes(sourceKey)) return true;
  }
  // (2) FBA Shipment Plan for exactly the FBA-inventory / Listings exports it OWNS (owned = required and NOT
  //     durably-derived). This surfaces FBA -> {Brand Inventory, FBA Plan} and Listings -> {FBA Plan AWD, LHv3}.
  if (reportKey === FBA_PLAN_LIVE_KEY) {
    const req = REPORT_SOURCE_REQUIREMENTS[reportKey];
    const derived = REPORT_DERIVED_SOURCE_KEYS[reportKey];
    if (Array.isArray(req) && req.includes(sourceKey) && !(Array.isArray(derived) && derived.includes(sourceKey))) return true;
  }
  return false;
}

// The live-publishable dashboards that DEPEND ON this source (sorted). Empty => Publish is Not-applicable for the
// source. Purely registry-derived: (owned-export requirements) ∪ (reconciler-lineage), intersected with the
// live-contract universe. The registries carry import-time consistency asserts, so this cannot silently diverge.
export function dependentLiveReportsForSource(sourceKey) {
  return LIVE_PUBLISHABLE_REPORT_KEYS.filter((r) => reportDependsOnSource(r, S(sourceKey)));
}

// ---- EXPORT classifier (pure). `evidence` is the normalized per-source read result; `cycle` carries the selected
// cycle's as-of (D-1) + terminal flag + startedAt. Never returns "Yes" without proven durable evidence. ----
// evidence: { read:'ok'|'schema-missing'|'read-failed', present:bool, validatedAt, sourceAsOf, coversCycle }
export function classifyExport({ evidence, cycle, dated } = {}) {
  const c = cycle || {};
  const U = (code, stage) => ({ status: "Unavailable", mode: null, validatedAt: null, sourceAsOf: null, safeCode: code, safeStage: stage });
  if (!evidence || evidence.read === "read-failed") return U(evidence?.error || "READ_FAILED", "export-read");
  // An unapplied durable schema (e.g. Listings pre-migration) is a KNOWN-safe "cannot classify yet", never a No.
  if (evidence.read === "schema-missing") return U(evidence.error || "SCHEMA_MISSING", "export-schema");

  const validatedAt = isTs(evidence.validatedAt) ? evidence.validatedAt : null;
  const sourceAsOf = isDate(evidence.sourceAsOf) ? evidence.sourceAsOf : null;
  // Reuse/adoption detail: a durable artifact whose validation predates this cycle's start was ADOPTED (validated
  // reuse), not newly purchased this cycle -- still Export:Yes, but flagged so an admin never mistakes it for a fresh
  // paid export. When we cannot tell (no validated_at, or no cycle start), we say plain "validated".
  const reuse = validatedAt && isTs(c.startedAt) && Date.parse(validatedAt) < Date.parse(c.startedAt);
  const mode = reuse ? "validated-reuse" : "validated";
  const Yes = () => ({ status: "Yes", mode, validatedAt, sourceAsOf, safeCode: null, safeStage: null });
  const Waiting = (stage) => ({ status: "Waiting", mode: null, validatedAt, sourceAsOf, safeCode: null, safeStage: stage });
  const No = (code, stage) => ({ status: "No", mode: null, validatedAt, sourceAsOf, safeCode: code, safeStage: stage });

  if (dated) {
    // DATED source (OLI / Campaign Ads): the proof of freshness is the succeeded coverage reaching the cycle's D-1,
    // NOT a validated_at timestamp. Fabricate nothing: coversCycle must be strictly true.
    if (evidence.present && evidence.coversCycle === true) return Yes();
    if (evidence.present) return c.terminal ? No("D1_COVERAGE_MISSING", "export-coverage") : Waiting("export-coverage");
    return c.terminal ? No("SOURCE_EVIDENCE_MISSING", "export-evidence") : Waiting("export-pending");
  }
  // DATE-FREE current-state source (Catalog / FBA snapshot / Listings / Listings-Raw): freshness is a real
  // validated_at timestamp on a present durable pointer -- NEVER the as_of cycle label. A present pointer with a
  // malformed/absent validated_at is Unavailable (cannot be trusted), never a fabricated Yes.
  if (evidence.present && validatedAt) return Yes();
  if (evidence.present) return U("VALIDATED_AT_MISSING", "export-validate");
  return c.terminal ? No("SOURCE_EVIDENCE_MISSING", "export-evidence") : Waiting("export-pending");
}

// ---- PUBLISH classifier for ONE dependent live report (pure). `liveRow` is the newest bare-live-key snapshot meta
// for (reportKey, accountId) or null; a "scheduler-v2/<key>" shadow row must NEVER be passed here. ----
export function classifyReportPublish({ liveRow, contract, cycleAsOf, metaOk, exportPresent, cycleTerminal } = {}) {
  if (!metaOk) return { status: "Unavailable", asOf: null, refreshedAt: null };
  if (!liveRow) {
    // No live row. If the export is present but the cycle is still open, it is publishing (Waiting); a terminal cycle
    // with no live row is a durable No; nothing at all yet is Waiting.
    if (exportPresent && !cycleTerminal) return { status: "Waiting", asOf: null, refreshedAt: null };
    return { status: cycleTerminal ? "No" : "Waiting", asOf: null, refreshedAt: null };
  }
  // A row whose reportVersion is NOT the live contract version is NOT a valid live publication (e.g. a stale/other
  // contract) -- treat as not-published, never Yes.
  if (contract && S(liveRow.reportVersion) !== S(contract.liveReportVersion)) {
    return { status: cycleTerminal ? "No" : "Waiting", asOf: null, refreshedAt: liveRow.refreshedAt || null };
  }
  const asOf = isDate(liveRow.asOf) ? liveRow.asOf : null;
  if (!asOf) return { status: "Unavailable", asOf: null, refreshedAt: liveRow.refreshedAt || null };
  // Without a resolvable cycle as-of we CANNOT prove the live row is current -> Unavailable (never a fabricated Yes).
  if (!isDate(cycleAsOf)) return { status: "Unavailable", asOf, refreshedAt: liveRow.refreshedAt || null };
  // The exact live identity is present. as_of >= the cycle's as-of => this cycle (or a newer one) published.
  // An OLDER as_of means a previous-cycle LAST-KNOWN-GOOD row is retained while this cycle has not (yet) published it:
  //   - while the cycle is NON-terminal, publication is still in its async completion window -> "Waiting" (in progress);
  //   - once the cycle is TERMINAL, this cycle did NOT bring the report current. That is a truthful, terminal
  //     RETAINED-LAST-KNOWN-GOOD state ("LKG") carrying the LAST-PUBLISHED as_of -- NEVER an indefinitely-running
  //     "Waiting", and NEVER a fabricated "Yes". A weeks-old as_of (e.g. a stuck fba-plan derive) is thus glaringly
  //     visible as stale LKG rather than masked as "in progress", so the underlying failure is surfaced, not hidden.
  if (asOf < cycleAsOf) return { status: cycleTerminal ? "LKG" : "Waiting", asOf, refreshedAt: liveRow.refreshedAt || null, lkg: true };
  return { status: "Yes", asOf, refreshedAt: liveRow.refreshedAt || null };
}

// ---- Aggregate the per-report publish states for a source into one cell (Yes · K/N, No · K/N, Waiting, Unavailable,
// Not applicable). ----
export function aggregatePublish({ dependentReports, perReport, metaOk = true } = {}) {
  const expected = (dependentReports || []).length;
  if (expected === 0) return { status: "Not applicable", count: 0, expected: 0, lkg: false, lkgAsOf: null };
  if (metaOk === false) return { status: "Unavailable", count: 0, expected, lkg: false, lkgAsOf: null };
  let yes = 0, waiting = 0, unavailable = 0, no = 0, lkgN = 0, lkg = false, lkgAsOf = null;
  for (const r of dependentReports) {
    const st = perReport[r];
    if (!st) { unavailable += 1; continue; }
    if (st.status === "Yes") yes += 1;
    else if (st.status === "Waiting") { waiting += 1; if (st.lkg) lkg = true; }
    // LKG (terminal cycle, retained last-known-good, not current): track the OLDEST retained as_of so the cell reports
    // the worst staleness (a weeks-old date is unmistakable). LKG is NEVER counted toward Yes (it is not current).
    else if (st.status === "LKG") { lkgN += 1; lkg = true; if (isDate(st.asOf) && (!lkgAsOf || st.asOf < lkgAsOf)) lkgAsOf = st.asOf; }
    else if (st.status === "Unavailable") unavailable += 1;
    else no += 1; // "No" -- terminal, nothing published for this dependent
  }
  if (yes === expected) return { status: "Yes", count: yes, expected, lkg: false, lkgAsOf: null };
  if (unavailable === expected) return { status: "Unavailable", count: yes, expected, lkg, lkgAsOf };
  // Some not-current. Worst-state precedence so the cell states the MOST serious truthful outcome: a hard No (nothing
  // published) outranks a retained-LKG (previous-cycle data still live), which outranks an in-progress Waiting.
  if (no > 0) return { status: "No", count: yes, expected, lkg, lkgAsOf };
  if (lkgN > 0) return { status: "LKG", count: yes, expected, lkg: true, lkgAsOf };
  if (waiting > 0) return { status: "Waiting", count: yes, expected, lkg, lkgAsOf: null };
  return { status: "No", count: yes, expected, lkg, lkgAsOf };
}

// ---- Per-account remark: the single most actionable safe result, naming the SPECIFIC source + safe code (never a
// generic "Source export failed" bucket). Priority: eligibility, then export failures, then publish failures, then
// LKG-retained, then in-progress, then healthy. Every fragment is admin-safe (a typed safeCode + the source label --
// no raw provider error, object path, or credential). "Healthy" is returned verbatim (the failures-only filter and
// the summary key off it). ----
export function accountRemark({ eligible, reports }) {
  if (eligible === false) return "Account not eligible";
  const rows = Array.isArray(reports) ? reports : [];
  const firstExport = (s) => rows.find((r) => r.exportStatus === s);
  const firstPublish = (s) => rows.find((r) => r.publishStatus === s);
  const code = (c) => (c ? " (" + S(c) + ")" : "");
  const frac = (r) => S(r.publicationCount) + "/" + S(r.publicationExpected);
  // Actionable failures first (a proven miss outranks a not-yet-readable source), then unavailability, then LKG, then
  // in-flight. Each names the exact source so an admin never has to guess WHICH of the six failed.
  const exNo = firstExport("No");
  if (exNo) return exNo.label + " export failed" + code(exNo.safeCode);
  const pubNo = firstPublish("No");
  if (pubNo) return pubNo.label + " publication failed " + frac(pubNo);
  // Terminal cycle with a retained previous-cycle last-known-good (current cycle did NOT publish this report). Name the
  // EXACT last-published as-of so a stuck/deferred publication (e.g. a weeks-old fba-plan) is unmistakable, never masked
  // as "in progress". This ranks above unavailability/in-progress because it is a concrete not-current result.
  const pubLkg = rows.find((r) => r.publishStatus === "LKG");
  if (pubLkg) return pubLkg.label + " last-known-good as-of " + S(pubLkg.publishLkgAsOf || "unknown") + " retained; current cycle not published " + frac(pubLkg);
  const exUn = firstExport("Unavailable");
  if (exUn) return exUn.label + " evidence unavailable" + code(exUn.safeCode);
  const pubUn = firstPublish("Unavailable");
  if (pubUn) return pubUn.label + " publication evidence unavailable";
  const lkg = rows.find((r) => r.publishStatus === "Waiting" && r.publishLkg);
  if (lkg) return lkg.label + " last-known-good retained";
  const exW = firstExport("Waiting");
  if (exW) return exW.label + " cycle in progress";
  const pubW = firstPublish("Waiting");
  if (pubW) return pubW.label + " publication pending";
  return "Healthy";
}

// ---- PURE payload shaper. Consumes fully-read evidence and returns the browser-safe response. Zero I/O. ----
// accounts: [{ accountId, accountName, marketplace, connectionId, eligible }]
// exportEvidenceByAccount: { [accountId]: { [sourceKey]: normalizedEvidence } }
// liveByReportAccount: { [reportKey]: { [accountId]: { reportVersion, asOf, refreshedAt } } } (newest bare-live only)
// readOkByReport: { [reportKey]: bool } -- false => that report's live-meta read failed/truncated (its cells => Unavailable)
// disabledReports: Set of report_keys NOT currently live-serving (e.g. listing-health-v3 while its publish gate is off);
//   excluded from the Publish universe so a deliberately-gated preview report is never counted as a publication failure.
export function shapeDeliveryPayload({
  region, cycle, generatedAt, accounts, exportEvidenceByAccount, liveByReportAccount,
  readOkByReport = {}, disabledReports = new Set(), failuresOnly, notes = [],
} = {}) {
  const cycleAsOf = cycle && isDate(cycle.asOf) ? cycle.asOf : null;
  const cycleContext = { asOf: cycleAsOf, terminal: cycle ? cycle.terminal === true : false, startedAt: cycle ? cycle.startedAt : null };
  const disabled = disabledReports instanceof Set ? disabledReports : new Set(disabledReports || []);
  const dependentsCache = new Map();
  const dependentsFor = (sk) => {
    if (!dependentsCache.has(sk)) dependentsCache.set(sk, dependentLiveReportsForSource(sk).filter((rk) => !disabled.has(rk)));
    return dependentsCache.get(sk);
  };

  const shapedAccounts = [];
  for (const acct of accounts || []) {
    const evForAcct = (exportEvidenceByAccount || {})[acct.accountId] || {};
    const reports = DELIVERY_SOURCES.map((src) => {
      const exp = classifyExport({ evidence: evForAcct[src.sourceKey], cycle: cycleContext, dated: src.dated });
      const dependents = dependentsFor(src.sourceKey);
      const perReport = {};
      for (const rk of dependents) {
        const contract = SCHEDULER_LIVE_SNAPSHOT_CONTRACTS[rk] || null;
        const liveRow = ((liveByReportAccount || {})[rk] || {})[acct.accountId] || null;
        perReport[rk] = classifyReportPublish({
          liveRow, contract, cycleAsOf,
          metaOk: readOkByReport[rk] !== false, exportPresent: exp.status === "Yes", cycleTerminal: cycleContext.terminal,
        });
      }
      const agg = aggregatePublish({ dependentReports: dependents, perReport });
      return {
        sourceKey: src.sourceKey,
        label: src.label,
        exportStatus: exp.status,
        exportMode: exp.mode,
        validatedAt: exp.validatedAt,
        sourceAsOf: exp.sourceAsOf,
        cycleAsOf,
        publishStatus: agg.status,
        publishLkg: agg.lkg === true,
        publishLkgAsOf: agg.lkgAsOf || null,
        publicationCount: agg.count,
        publicationExpected: agg.expected,
        dependentReports: dependents,
        safeCode: exp.safeCode,
        safeStage: exp.safeStage,
      };
    });
    const remark = accountRemark({ eligible: acct.eligible, reports });
    shapedAccounts.push({
      accountId: acct.accountId,
      accountName: acct.accountName || null,
      marketplace: acct.marketplace || null,
      eligible: acct.eligible !== false,
      reports,
      remark,
    });
  }

  // Summary over ELIGIBLE accounts only (ineligible/setup-incomplete accounts must not distort success totals).
  const eligibleAccounts = shapedAccounts.filter((a) => a.eligible);
  let exportYes = 0, exportTotal = 0, publishYes = 0, publishTotal = 0, failedCount = 0, waitingCount = 0, lkgCount = 0;
  for (const a of eligibleAccounts) {
    let acctFailed = false, acctWaiting = false, acctLkg = false;
    for (const r of a.reports) {
      exportTotal += 1;
      if (r.exportStatus === "Yes") exportYes += 1;
      if (r.publishStatus !== "Not applicable") {
        publishTotal += 1;
        // LKG is NOT a current publication (a previous-cycle last-known-good is retained), so it never counts toward
        // publishYes -- the fraction stays honest about what published THIS cycle.
        if (r.publishStatus === "Yes") publishYes += 1;
      }
      if (r.exportStatus === "No" || r.publishStatus === "No") acctFailed = true;
      if (r.publishStatus === "LKG") acctLkg = true;
      if (r.exportStatus === "Waiting" || r.publishStatus === "Waiting") acctWaiting = true;
    }
    // Precedence: a hard failure outranks a retained-LKG (current cycle not published) which outranks in-progress.
    if (acctFailed) failedCount += 1;
    else if (acctLkg) lkgCount += 1;
    else if (acctWaiting) waitingCount += 1;
  }

  const visibleAccounts = failuresOnly
    ? shapedAccounts.filter((a) => a.remark !== "Healthy")
    : shapedAccounts;

  return {
    region,
    cycleDate: cycle ? cycle.cycleDate : null,
    cycleAsOf,
    cycleStatus: cycle ? cycle.status : null,
    cycleTerminal: cycleContext.terminal,
    availableCycleDates: cycle && Array.isArray(cycle.availableCycleDates) ? cycle.availableCycleDates : [],
    generatedAt: generatedAt || null,
    accounts: visibleAccounts,
    summary: {
      accountCount: eligibleAccounts.length,
      accountsShown: visibleAccounts.length,
      exportYes, exportTotal,
      publishYes, publishTotal,
      failedCount, waitingCount, lkgCount,
    },
    notes: Array.isArray(notes) ? notes : [],
  };
}

// ================================ READ-ONLY LOADER (injected deps) ================================
// Orchestrates the bounded, metadata-only durable reads and hands them to shapeDeliveryPayload. Every reader is
// INJECTED (deps) so the loader is unit-testable offline with mocks and the module never imports the transport layer.
// The API handler passes the real read-only Supabase helpers. NOTHING here writes, exports, dispatches, or spends
// tokens; every read is a GET of already-durable evidence. Fail-closed: any thrown/failed read degrades to
// Unavailable (or a safe note) and one account's bad evidence never aborts the whole page.

const TERMINAL_CYCLE = new Set(["succeeded", "partial", "failed"]);
const MAX_ACCOUNTS = 60;                 // hard bound on the per-account fan-out (regions hold <= ~16 accounts)
const MAX_CYCLE_LOOKBACK_DAYS = 30;      // recent-cycle enumeration window for the dropdown
const MAX_CYCLES_FETCHED = 18;           // bounded getSyncCycle fan-out for the dropdown / selection
const PUBLISH_ROW_SAFETY = 950;          // a per-key live-meta read at/above this may be PostgREST-truncated -> fail-closed

// Choose the better of two candidate live rows for one (report_key, account_id): a row whose reportVersion matches the
// live contract ALWAYS beats a non-matching one (so a manually-opened off-window / wrong-version snapshot never masks
// the real live row); among equal match-status, the greater as_of wins, then the newer updated_at.
function pickBetterLive(prev, cand, wantVersion) {
  if (!prev) return cand;
  const pMatch = !!wantVersion && prev.reportVersion === wantVersion;
  const cMatch = !!wantVersion && cand.reportVersion === wantVersion;
  if (pMatch !== cMatch) return pMatch ? prev : cand;
  const pa = isDate(prev.asOf) ? prev.asOf : "";
  const ca = isDate(cand.asOf) ? cand.asOf : "";
  if (pa !== ca) return pa > ca ? prev : cand;
  return String(prev.updatedAt || "") >= String(cand.updatedAt || "") ? prev : cand;
}

const normConn = (c) => (String(c || "") === "secondary" ? "dd-secondary" : (String(c || "") || "primary"));
// A durable-status onboarding row is INELIGIBLE only on POSITIVE evidence of setup-incompleteness -- otherwise the
// account counts (fail toward inclusion, but clearly mark the proven-ineligible so totals stay honest).
const SETUP_STATUS = /(setup|onboard|bootstrap|discover|pending|provision)/i;
function accountEligible(onboardingRow) {
  if (!onboardingRow) return true;                       // unknown -> counts (marked eligible)
  if (onboardingRow.datadoe_ready === false) return false;
  if (SETUP_STATUS.test(String(onboardingRow.status || ""))) return false;
  return true;
}

async function settle(promise, fallback) {
  try { return await promise; } catch { return fallback; }
}

export async function loadDeliveryStatus({ region, cycleDate, failuresOnly } = {}, deps = {}) {
  const {
    primaryOrganizationFingerprint,
    getAccountDirectoryRows, getAccountOnboardingRows,
    getRecentSyncCycleIds, getSyncCycle,
    getSourceCoverageWindows, getSourceSnapshot, getSourceListingsSnapshot, getSourceListingsRawSnapshot,
    getAdsSyncStates, getReportSnapshotsMeta, getLatestReportJobLineage,
    now = () => new Date(), signal = null,
  } = deps;

  const rgn = normalizeDeliveryRegion(region);
  const generatedAt = now().toISOString();
  const notes = [];
  const org = (() => { try { return primaryOrganizationFingerprint ? primaryOrganizationFingerprint() : null; } catch { return null; } })();
  if (!org) notes.push("Primary organization identity is not configured; per-account source evidence is unavailable.");

  // ---- 1) Accounts for this region (canonical routing; each account resolves to exactly one region). ----
  const directoryRows = await settle(getAccountDirectoryRows(), null);
  if (!Array.isArray(directoryRows)) notes.push("Account directory could not be read; showing no accounts.");
  const onboardingRows = await settle(getAccountOnboardingRows(), null);
  const onboardingById = new Map((Array.isArray(onboardingRows) ? onboardingRows : []).map((r) => [String(r.account_id), r]));

  let accounts = (Array.isArray(directoryRows) ? directoryRows : [])
    .filter((r) => r && r.account_id && regionForMarketplace(r.marketplace_country_code) === rgn)
    .map((r) => ({
      accountId: String(r.account_id),
      accountName: r.name || null,
      marketplace: r.marketplace_country_code || null,
      connectionId: normConn(r.connection_id),
      eligible: accountEligible(onboardingById.get(String(r.account_id))),
    }))
    .sort((a, b) => a.accountId.localeCompare(b.accountId));

  // ---- Canonical active-connection filter -- the SAME predicate every scheduler/reconciler/publisher path applies
  // (classifyDirectoryAccounts). When the secondary DataDoe organization is decommissioned (DATADOE_API_KEY_SECONDARY
  // unset), its historical `dd-secondary:`-prefixed directory rows are RETAINED for audit but are STALE: excluded here
  // from the response, the summary totals, and the failures filter -- while staying in the durable directory (this view
  // never deletes). If an admin later re-enables the connection, getDataDoeConnections() returns it again and its
  // accounts become eligible automatically (no code change, no hardcoded IDs/marketplaces). Fail-closed: if the
  // connection registry cannot be read, fall back to a primary-only set so a stale secondary account is STILL excluded
  // WITHOUT dropping primary accounts. Keyed on the canonical account-id prefix (never a frontend string match). ----
  const connections = (() => { try { return getDataDoeConnections(); } catch { return null; } })();
  const { active, unavailable } = classifyDirectoryAccounts(accounts, connections || [{ id: "primary" }]);
  accounts = active;
  if (unavailable.length > 0) notes.push(unavailable.length + " account(s) from a decommissioned DataDoe connection are excluded (retained read-only).");

  if (accounts.length > MAX_ACCOUNTS) {
    notes.push("Showing the first " + MAX_ACCOUNTS + " of " + accounts.length + " accounts in this region.");
    accounts = accounts.slice(0, MAX_ACCOUNTS);
  }
  const accountIds = accounts.map((a) => a.accountId);

  // ---- 2) Recent cycles for this region's NATURAL daily bucket (bucket === region; cycle_date = D, as_of = D-1). ----
  const sinceDate = addDaysStr(generatedAt.slice(0, 10), -MAX_CYCLE_LOOKBACK_DAYS) || "2000-01-01";
  const cycleIds = await settle(getRecentSyncCycleIds(rgn, sinceDate, { signal, limit: 40 }), []);
  const cycleRows = (await Promise.all((Array.isArray(cycleIds) ? cycleIds : []).slice(0, MAX_CYCLES_FETCHED)
    .map((id) => settle(getSyncCycle(id, { signal }), null)))).filter(Boolean);
  // Newest-first, de-duplicated by cycle_date; terminal (succeeded|partial|failed OR finished_at) drives the dropdown.
  const byDate = new Map();
  for (const row of cycleRows) {
    const d = String(row.cycle_date || "");
    if (!isDate(d)) continue;
    const terminal = TERMINAL_CYCLE.has(String(row.status || "")) || !!row.finished_at;
    const prev = byDate.get(d);
    if (!prev || (terminal && !prev.terminal)) byDate.set(d, { cycleDate: d, status: row.status || null, terminal, startedAt: row.started_at || null });
  }
  const orderedCycles = [...byDate.values()].sort((a, b) => (a.cycleDate < b.cycleDate ? 1 : -1));
  const terminalCycles = orderedCycles.filter((c) => c.terminal);
  const availableCycleDates = orderedCycles.slice(0, 12).map((c) => c.cycleDate);
  const requested = isDate(cycleDate) ? String(cycleDate) : null;
  const selected = (requested && byDate.get(requested)) || terminalCycles[0] || orderedCycles[0] || null;
  const cycle = selected
    ? { cycleDate: selected.cycleDate, status: selected.status, terminal: selected.terminal, startedAt: selected.startedAt, asOf: addDaysStr(selected.cycleDate, -1), availableCycleDates }
    : { cycleDate: null, status: null, terminal: false, startedAt: null, asOf: null, availableCycleDates };
  if (!selected) notes.push("No recent scheduler cycle was found for this region.");

  // ---- 3) Per-account EXPORT evidence (bounded, metadata-only, parallel; each read fails closed to Unavailable). ----
  const workerKey = (() => { try { return adsWorkerKeyForGrain(ADS_CAMPAIGN_SOURCE_KEY); } catch { return null; } })();
  // Ads: ONE bulk read across all accounts (throws on failure -> all Ads Unavailable).
  let adsByAccount = new Map(); let adsReadFailed = false;
  if (accountIds.length) {
    try { const rows = await getAdsSyncStates(accountIds); for (const r of (rows || [])) { if (String(r.source_key) === workerKey) adsByAccount.set(String(r.account_id), r); } }
    catch { adsReadFailed = true; }
  }
  // Catalog: org-scoped snapshot, read ONCE per distinct connection (shared across that connection's accounts).
  const catalogByConn = new Map();
  if (org) {
    for (const conn of new Set(accounts.map((a) => a.connectionId))) {
      catalogByConn.set(conn, await settle(getSourceSnapshot({ organizationFingerprint: org, connectionId: conn, sourceKey: CATALOG_SOURCE_KEY, scopeKey: ORGANIZATION_SCOPE_KEY, signal }), { snapshot: null, read: "read-failed", error: "CATALOG_READ_FAILED" }));
    }
  }
  const cycleAsOf = cycle.asOf;
  // A DATED source only "covers the cycle" when we have a real cycle as-of AND a succeeded window spans it. When the
  // cycle as-of is unknown (no cycle resolved), coverage is UNPROVEN -> false (fail-closed; the classifier then yields
  // Waiting/No, never a fabricated Yes off stale/old evidence).
  const oliCovers = (windows) => isDate(cycleAsOf) && Array.isArray(windows) && windows.some((w) => isDate(w.from) && isDate(w.to) && w.from <= cycleAsOf && w.to >= cycleAsOf);
  const oliMaxTo = (windows) => { const tos = (Array.isArray(windows) ? windows : []).map((w) => w.to).filter(isDate).sort(); return tos.length ? tos[tos.length - 1] : null; };

  const exportEvidenceByAccount = {};
  await Promise.all(accounts.map(async (a) => {
    const ev = {};
    if (!org) {
      for (const s of DELIVERY_SOURCES) ev[s.sourceKey] = { read: "read-failed", present: false, error: "ORG_UNCONFIGURED" };
      exportEvidenceByAccount[a.accountId] = ev;
      return;
    }
    const idArgs = { organizationFingerprint: org, connectionId: a.connectionId, accountId: a.accountId, signal };
    // FBA Inventory: read the fba-plan report JOB (getLatestReportJobLineage throws on a real DB error -> read-failed,
    // returns null when there is simply no job -> absent). It is NOT a typed-wrapper reader, so wrap it explicitly.
    const fbaJobP = (async () => { try { return { job: await getLatestReportJobLineage("fba-plan", a.accountId, { signal }), read: "ok" }; } catch { return { job: null, read: "read-failed" }; } })();
    const [oli, fbaJobRes, listings, listingsRaw] = await Promise.all([
      settle(getSourceCoverageWindows({ ...idArgs, sourceKey: OLI_SOURCE_KEY }), { windows: [], read: "read-failed", error: "OLI_READ_FAILED" }),
      fbaJobP,
      settle(getSourceListingsSnapshot(idArgs), { snapshot: null, read: "read-failed", error: "LISTINGS_READ_FAILED" }),
      settle(getSourceListingsRawSnapshot(idArgs), { snapshot: null, read: "read-failed", error: "LISTINGS_RAW_READ_FAILED" }),
    ]);
    ev[OLI_SOURCE_KEY] = { read: oli.read, present: (oli.windows || []).length > 0, validatedAt: null, sourceAsOf: oliMaxTo(oli.windows), coversCycle: oliCovers(oli.windows) };
    const cat = catalogByConn.get(a.connectionId) || { snapshot: null, read: "read-failed", error: "CATALOG_READ_FAILED" };
    ev[CATALOG_SOURCE_KEY] = { read: cat.read, present: !!cat.snapshot, validatedAt: cat.snapshot ? cat.snapshot.validated_at : null, sourceAsOf: null };
    if (adsReadFailed || !workerKey) ev[ADS_CAMPAIGN_SOURCE_KEY] = { read: "read-failed", present: false, error: "ADS_STATE_READ_FAILED" };
    else { const st = adsByAccount.get(a.accountId) || null; const covered = isDate(cycleAsOf) && st && isDate(st.latest_metric_date) && st.latest_metric_date >= cycleAsOf; ev[ADS_CAMPAIGN_SOURCE_KEY] = { read: "ok", present: !!(st && String(st.last_status) === "succeeded" && isDate(st.latest_metric_date)), validatedAt: st ? st.last_daily_sync_at : null, sourceAsOf: st ? st.latest_metric_date : null, coversCycle: !!covered }; }
    const fbaJob = fbaJobRes.job;
    const fbaCovers = isDate(cycleAsOf) && fbaJob && isDate(fbaJob.latestDataDate) && fbaJob.latestDataDate >= cycleAsOf;
    ev[FBA_INVENTORY_SOURCE_KEY] = fbaJobRes.read === "read-failed"
      ? { read: "read-failed", present: false, error: "FBA_JOB_READ_FAILED" }
      : { read: "ok", present: !!(fbaJob && fbaJob.validated === true), validatedAt: null, sourceAsOf: fbaJob ? fbaJob.latestDataDate : null, coversCycle: !!fbaCovers };
    ev[LISTINGS_SOURCE_KEY] = { read: listings.read, present: !!listings.snapshot, validatedAt: listings.snapshot ? listings.snapshot.validated_at : null, sourceAsOf: null };
    ev[LISTINGS_RAW_SOURCE_KEY] = { read: listingsRaw.read, present: !!listingsRaw.snapshot, validatedAt: listingsRaw.snapshot ? listingsRaw.snapshot.validated_at : null, sourceAsOf: null };
    exportEvidenceByAccount[a.accountId] = ev;
  }));

  // ---- 4) PUBLISH evidence: read the BARE live keys' snapshot metadata PER KEY (never one bulk read of all keys).
  // report_snapshots retains one row per (report_key, account_id, params_hash) -- MANY windows per pair -- so a single
  // all-keys read can exceed the PostgREST row cap and SILENTLY truncate (HTTP 200), dropping pairs into a fabricated
  // "No". A per-key read is far smaller; if any single key's read still approaches the cap we cannot trust it and mark
  // THAT key's cells Unavailable (fail-closed) rather than fabricate. Shadow "scheduler-v2/<key>" rows are excluded by
  // construction (only the bare live keys are ever queried). ----
  const readOkByReport = {}; const liveByReportAccount = {};
  if (accountIds.length) {
    const perKey = await Promise.all(LIVE_PUBLISHABLE_REPORT_KEYS.map(async (rk) => {
      try { const rows = await getReportSnapshotsMeta({ reportKeys: [rk], accountIds }); return { rk, rows: rows || [], ok: (rows || []).length < PUBLISH_ROW_SAFETY }; }
      catch { return { rk, rows: [], ok: false }; }
    }));
    for (const { rk, rows, ok } of perKey) {
      readOkByReport[rk] = ok;
      if (!ok) continue;
      const wantVersion = SCHEDULER_LIVE_SNAPSHOT_CONTRACTS[rk] ? SCHEDULER_LIVE_SNAPSHOT_CONTRACTS[rk].liveReportVersion : null;
      for (const row of rows) {
        const acct = String(row.account_id);
        const params = row.params && typeof row.params === "object" ? row.params : {};
        const cand = {
          reportVersion: params.reportVersion != null ? String(params.reportVersion) : null,
          asOf: params.to || params.asOf || params.through || null,
          refreshedAt: row.source_refreshed_at || row.updated_at || null,
          updatedAt: row.updated_at || null,
        };
        if (!liveByReportAccount[rk]) liveByReportAccount[rk] = {};
        liveByReportAccount[rk][acct] = pickBetterLive(liveByReportAccount[rk][acct], cand, wantVersion);
      }
    }
    if (Object.values(readOkByReport).some((v) => v === false)) notes.push("Some live dashboard snapshot reads could not be completed or were too large to read safely; those cells show Unavailable.");
  }

  // Exclude from the Publish universe every live-publishable report the canonical registry says has NO active live
  // publisher today -- a superseded/shadow/on-demand report -- so a retired target never inflates a denominator (e.g.
  // Campaign Ads' ppc-performance, superseded by the durable workspace, no longer forces a permanent K/2). This is
  // registry-DERIVED (NO_LIVE_PUBLISHER_REPORT_KEYS), not a hardcoded list. listing-health-v3 is the one env-gated
  // exception: it serves live only behind its DOUBLE gate (LHV3_PUBLISH_LIVE && LISTING_HEALTH_V3, both default OFF) --
  // when that gate is ON its reconciler DOES promote it per region, so it is re-included; while OFF it stays excluded
  // (its Listings/Raw dependents show Not-applicable, never a fabricated publication failure).
  const lhv3LiveEnabled = String(process.env.LHV3_PUBLISH_LIVE) === "true" && String(process.env.LISTING_HEALTH_V3) === "true";
  const disabledReports = new Set(NO_LIVE_PUBLISHER_REPORT_KEYS);
  if (lhv3LiveEnabled) disabledReports.delete("listing-health-v3");

  return shapeDeliveryPayload({
    region: rgn, cycle, generatedAt, accounts,
    exportEvidenceByAccount, liveByReportAccount, readOkByReport, disabledReports,
    failuresOnly: failuresOnly === true || String(failuresOnly) === "true",
    notes,
  });
}
