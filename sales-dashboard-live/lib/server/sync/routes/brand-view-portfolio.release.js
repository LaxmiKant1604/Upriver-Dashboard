// Publication recovery WP9 -- the CLI-side brand-view-portfolio route (route-contract.js CLI shape): the zero-export
// release the generic route CLI (scripts/release/publication-route-reconcile.mjs) runs through route-publication-release.js.
// build(deps) returns the route RUNTIME over DURABLE readers only (deps.sb is the READ-ONLY supabase facade; deps.pgReadOnly
// runs the route's read-only evidence SQL inside a READ ONLY transaction). No DataDoe, no source refresh, no export.
//
// SCOPE TARGET 'region:<bucket>' (grain region). UNITS (unit 'region-brand') = the portfolio brands the PAGE can request
// for this region, computed by the SHARED browser-parity membership (lib/server/reports/brand-directory-membership.js):
//   membership = computeBrandDirectoryMembership over the latest brand-sales (hydrated storage-first, memoised by its
//                exact row identity) of EVERY selectable account (the page's account list: active !== false, any region);
//   members    = regionPortfolioMembers(membership, the serve's accountsById, region) -- the serve's own trusted-country
//                region filter; a brand with an empty region member set is not a unit;
//   unit       = { unitKey: sha12(brandKey), targetId = liveAccountId = brandViewPortfolioScopeId(members, display),
//                  ownerAccountIds: members (the publisher's AND gate), targetAsOf: the IN as-of the page sends }.
// A brand whose member set can never be published as the page requests it is a TYPED deferred unit (zero reads/writes):
// a settingUp member ('member-setting-up'), a duplicated directory id ('member-directory-ambiguous'), a member whose latest
// row of a read report is TIED ('latest-row-ambiguous:<report>'), or a scope id over the reconciler's unit target bound
// (MAX_TARGET_ID_BYTES UTF-8 BYTES -- the btree index bound; measured with the core's OWN targetIdByteLength, BEFORE any
// cycle / job write) ('portfolio-scope-id-too-long'). An unreadable / advanced / ambiguous membership read defers the
// whole target through one typed sentinel unit -- never a silently-shrunk unit set.
//
// EVIDENCE: the L1 token 'pf1:' (lib/server/recovery/routes/brand-view-portfolio.route.js -- the SAME SQL + compose the
// worker's tier-1 scan uses). Per unit, resolveBundle re-reads it, recomputes the membership, the LEGACY Brand View
// dependency fingerprint (collectBrandViewDependencyFingerprint scope 'portfolio' through the SHARED extracted readers
// makeBrandViewDepReaders -- the serve's brandViewDepFingerprintReaders semantics -> the serve's 'updating' flag keeps
// working, zero serve change) and the PER-UNIT manifest token 'pfm2:' (portfolioUnitManifestToken: ONLY this unit's
// inputs -- never the region token). STRICT: every reader failure the serve/builder would swallow (the fingerprint
// readers' catch -> null, the builder's catalog / mapping / inventory catches, a storage hydration fallback, an ABSENT
// storage object whose inline payload is an unusable stub: 'storage-missing:<report>') is RECORDED and turns the unit into
// a typed deferral ('evidence-read-failed:<source>'); every REST row the fingerprint or the build reads (incl. the durable
// Ads rows: count + max(updated_at) AND the EXACT 'adr1:' content digest over the build window -- the SAME digest the
// evidence SQL computes, brand-view-dependency-readers.js adsRowsDigest / adsRowsDigestSql) is cross-checked against the
// SQL evidence identity ('evidence-advanced:<source>') -- so a published payload is PROVABLY the derivation of exactly
// the identities in its token. The token (pf1) and the per-unit manifest (pfm2) also bind the DERIVATION-CODE identity
// (the route's DERIVE_REV + the Brand View versions + ACTIVE_ADS_SOURCE_KEY), so a derivation change re-arms every unit.
//
// CURRENT PREDICATE (per unit): the region token folds EVERY selectable account's evidence, so any upstream change
// anywhere moves it and the exact binding would call EVERY unit stale (a full rebuild + a new multi-MB content-addressed
// shadow per unit). For exactly that case -- the latest job promotable but not covering the moved region token -- the
// predicate re-runs the exact binding against the job's OWN lineage (shadow validity, the live row IS its promotion,
// stamp + payload + stored extras equal, the shared live read-back) and requires the unit's CURRENT per-unit manifest in
// the job lineage, the shadow AND the live row's stored manifestToken, plus the SERVED row (servedSelector) to BE that
// live row: then PUBLICATION_NOT_REQUIRED 'unit-manifest-unchanged' with ZERO writes. Anything else is the exact binding's
// verdict (STALE -> re-derive), unchanged.
//
// DERIVE: the composition's OWN deriveBrandViewPortfolio (report-materialization-brandview-composition.js
// makeBrandViewDerivers -- the closure the scheduler materializer uses; NOT buildBrandViewMaterializationRelease, whose
// DataDoe account-discovery defaults must stay off the route CLI's derive path, route-cli-closure C3): fingerprint FIRST,
// then buildBrandViewPortfolioSnapshot with the strict readers above, the serve's accountsById and sliceConcurrency 1
// (one account's payloads in memory at a time on the recovery VM). CAPACITY: a unit whose build crosses the heap
// high-water mark or its wall-clock budget stops between slices and defers 'capacity-exceeded:<heap|deadline>' (typed +
// alertable; never a partial portfolio).
//
// SERVED ROW: selectExactThenScopeLatest (the serve's serveSharedReport with staleScopeKeys ['region']) at the unit's
// scope id and { accountIds, brand, asOf, region } under brand-view-portfolio-v1. Stamp policy 'cycle'. 7-bit ASCII, LF.

import { createHash } from "node:crypto";
import { getHeapStatistics } from "node:v8";
import {
  buildBrandViewPortfolioSnapshot, brandViewPortfolioScopeId,
  BRAND_VIEW_PORTFOLIO_VERSION, BRAND_VIEW_PORTFOLIO_REPORT_KEY, BRAND_INVENTORY_REPORT_VERSION,
} from "../../reports/brand-view.js";
import { collectBrandViewDependencyFingerprint } from "../../reports/brand-view-dependency-fingerprint.js";
import { campaignMappingRevision } from "../../reports/campaign-ads-aggregation.js";
import { makeBrandViewDerivers } from "../report-materialization-brandview-composition.js";
import { makeBrandViewDepReaders } from "../brand-view-dependency-readers.js";
import { brandKey, brandDisplay } from "../../reports/brand-membership.js";
import { computeBrandDirectoryMembership, regionPortfolioMembers, snapshotBrandNames } from "../../reports/brand-directory-membership.js";
import { ACTIVE_ADS_SOURCE_KEY } from "../../active-ads-source.js";
import { adsRowsDigest } from "../brand-view-dependency-readers.js";
import { stableJson, evaluatePublicationBinding, jobIsPromotable, revisionCoveredByJob, PUBLICATION_STATE } from "../publication-binding.js";
import { RECONCILE_STATUS, MAX_TARGET_ID_BYTES, targetIdByteLength } from "../saved-data-reconciler.js";
import { REGION_SCOPES, regionForCountry } from "../scheduler-scope.js";
import * as SERVE_SELECTORS from "../../recovery/serve-selectors.js";
import {
  ROUTE_ID, PUBLISHER_KEY, REGION_TARGET_PREFIX, BRAND_SALES_KEY, BRAND_INVENTORY_KEY,
  EVIDENCE_SQL, composeBrandViewPortfolioEvidence, canonicalInstant, snapshotIdentity, portfolioAsOf, isAmbiguousIdentity,
  PORTFOLIO_CODE_IDENTITY,
} from "../../recovery/routes/brand-view-portfolio.route.js";

const S = (v) => (v == null ? "" : String(v));
const sha256 = (v) => createHash("sha256").update(String(v)).digest("hex");

// The saved-data reconciler's unit target-id bound (UTF-8 BYTES) -- imported, never a local copy, and measured with the
// core's OWN targetIdByteLength, so the route and the core can not disagree (a scope id the core would refuse is deferred
// typed here, before any cycle / job write, instead of failing the whole region target).
export const MAX_UNIT_TARGET_BYTES = MAX_TARGET_ID_BYTES;
// The per-UNIT manifest token prefix (portfolioUnitManifestToken; stored in the job lineage, the shadow params AND the
// live row's stored extras -- the portfolio contract's liveParamsExtra carries manifestToken).
export const PORTFOLIO_MANIFEST_PREFIX = "pfm2:";
// The current-predicate verdict reason of a unit proven current across a region-token advance.
export const UNIT_MANIFEST_UNCHANGED = "unit-manifest-unchanged";
// The per-unit build budget on the recovery VM (the route's whole-job deadline is 720 s) and the heap high-water mark
// (fraction of the V8 heap limit) above which a build stops between slices -- both typed 'capacity-exceeded'.
export const PORTFOLIO_UNIT_BUDGET_MS = 300000;
export const PORTFOLIO_HEAP_HIGH_WATER = 0.85;
export const MEMBERSHIP_SENTINEL_UNIT_KEY = "membership";
const SCOPE_PREFIX = BRAND_VIEW_PORTFOLIO_REPORT_KEY + ":";

/** The safe unit key of a portfolio brand: sha12 of its CANONICAL brand key (never brand text in keys / argv). */
export function portfolioUnitKey(canonicalKey) {
  return sha256(S(canonicalKey)).slice(0, 12);
}

/**
 * Decode a unit's (members, brand) from its target id + owners: the target IS brandViewPortfolioScopeId(owners, brand)
 * (owners are the sorted members). -> { members, brand } | null (a unit that is not a portfolio scope id).
 */
export function decodePortfolioUnit(unit) {
  const members = unit && Array.isArray(unit.ownerAccountIds) ? unit.ownerAccountIds.map(S) : [];
  const targetId = S(unit && unit.targetId);
  if (!members.length) return null;
  const prefix = SCOPE_PREFIX + members.join(",") + "::";
  if (!targetId.startsWith(prefix)) return null;
  const brand = targetId.slice(prefix.length);
  if (!brand.trim() || brandViewPortfolioScopeId(members, brand) !== targetId) return null;
  return { members, brand };
}

/**
 * The label DECIDERS of a brand key (PURE): every account (ANY region) whose brand-sales names carry a variant of the key
 * -- exactly the accounts pickDisplay chooses the page's label over -- each with the digest of ITS variants of this key
 * (brandDisplay-normalized, de-duplicated, sorted). -> [[accountId, sha256], ...] sorted by id. `namesById` = each
 * display account's snapshotBrandNames.
 */
export function portfolioLabelDeciders(membership, namesById, key) {
  const entry = membership instanceof Map ? membership.get(key) : null;
  const ids = entry && entry.accounts ? [...entry.accounts].map(S).sort() : [];
  return ids.map((id) => {
    const names = namesById && Array.isArray(namesById[id]) ? namesById[id] : [];
    const variants = [...new Set(names.filter((n) => brandKey(n) === key).map((n) => brandDisplay(n)))].sort();
    return [id, sha256(stableJson(variants))];
  });
}

/**
 * The PER-UNIT manifest token 'pfm2:' (PURE over the SQL evidence): ONLY this brand unit's inputs -- the region, the IN
 * as-of + the Ads build window, the brand key + the page's label + the sorted members, per member its directory entry
 * (name / country / settingUp / dup), its latest-row identities of every report the build reads, its newest AVAILABLE
 * compact, its Ads state + succeeded windows + build-window row count / max(updated_at) + the EXACT build-window Ads-row
 * content digest ('adr1:' -- any row insert / update / delete moves it, even one whose updated_at is not above the max),
 * its campaign-mapping revision under the PRIMARY org, the primary org's catalog pointer, the label deciders' variant
 * digests, and the DERIVATION-CODE identity (ev.code: DERIVE_REV + the Brand View versions + ACTIVE_ADS_SOURCE_KEY). NEVER
 * the region token (an unrelated account's change leaves it unchanged); the legacy dep fingerprint is a function of these
 * same identities (every fingerprint read is cross-checked against them), so an unchanged manifest proves an unchanged
 * derive input AND an unchanged derivation.
 */
export function portfolioUnitManifestToken(ev, { region, orgFp, key, display, members, labelDeciders }) {
  const emptyMap = campaignMappingRevision([]);
  const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  const per = (Array.isArray(members) ? members : []).map((id) => ({
    id: S(id),
    account: own(ev.accounts, id) ? ev.accounts[id] : null,
    snaps: own(ev.snaps, id) ? ev.snaps[id] : null,
    invAvail: own(ev.invAvail, id) ? ev.invAvail[id] : null,
    ads: own(ev.ads, id) ? ev.ads[id] : null,
    map: own(ev.maps, id) && own(ev.maps[id], orgFp) ? ev.maps[id][orgFp] : emptyMap,
  }));
  return PORTFOLIO_MANIFEST_PREFIX + sha256(stableJson({
    v: "pfm2", route: ROUTE_ID, region: S(region), asOf: S(ev.asOf), adsWindow: ev.adsWindow || null, key: S(key), display: S(display),
    members: (members || []).map(S), per, catalog: own(ev.catalog, orgFp) ? ev.catalog[orgFp] : null, label: labelDeciders || [],
    code: ev.code && typeof ev.code === "object" ? ev.code : { ...PORTFOLIO_CODE_IDENTITY },
  }));
}

const defaultHeapStats = () => { const h = getHeapStatistics(); return { used: h.used_heap_size, limit: h.heap_size_limit }; };

// A strict reader-call recorder: failures (a throw / a fail-soft non-ok read) and identity mismatches vs the SQL evidence.
function makeLedger() {
  const failures = new Set(); const mismatches = new Set();
  return {
    fail: (src) => failures.add(S(src)),
    mismatch: (src) => mismatches.add(S(src)),
    reason: () => {
      if (failures.size) return "evidence-read-failed:" + [...failures].sort()[0];
      if (mismatches.size) return "evidence-advanced:" + [...mismatches].sort()[0];
      return null;
    },
  };
}

// The inventory candidate set the serve reads (getInventorySnapshotCandidates: newest AVAILABLE compact + newest row,
// de-duplicated by id) must be EXACTLY the SQL evidence's two identities (a swallowed sub-read shows up here).
function inventoryCandidatesMatch(rows, ev, accountId) {
  const avail = ev.invAvail[accountId] || null;
  const latest = (ev.snaps[accountId] || {})[BRAND_INVENTORY_KEY] || null;
  const expected = [];
  if (avail) expected.push(avail);
  if (latest && (!avail || latest.id !== avail.id)) expected.push(latest);
  const got = (Array.isArray(rows) ? rows : []).map((r) => snapshotIdentity(r));
  return stableJson(got) === stableJson(expected);
}

function adsCoverageMatch(cov, want) {
  if (!want || !cov) return false;
  const windows = (Array.isArray(cov.windows) ? cov.windows : []).map((w) => S(w && w.from) + ".." + S(w && w.to)).sort();
  return stableJson(windows) === stableJson(want.windows) && S(cov.status) === S(want.status)
    && S(cov.latestMetricDate) === S(want.latestMetricDate) && S(cov.contentRev) === S(want.contentRev);
}

// The durable Ads rows a build read must be EXACTLY the evidence's build-window rows: the active source over the SAME
// window, the SAME count, the SAME max(updated_at) AND the SAME exact content digest (adsRowsDigest over the REST rows ==
// the evidence SQL's adsRowsDigestSql -- one shared definition, so an insert / edit / delete between the evidence read
// and the build read, including one that bypassed content_rev or whose updated_at is not above the max, shows up here).
function adsRowsMatch(args, rows, ev, accountId) {
  const want = ev.ads && ev.ads[accountId];
  const win = ev.adsWindow;
  if (!want || !win) return false;
  const keys = args && Array.isArray(args.sourceKeys) ? args.sourceKeys.map(S) : [];
  if (keys.length !== 1 || keys[0] !== ACTIVE_ADS_SOURCE_KEY || S(args.from) !== S(win.from) || S(args.to) !== S(win.to)) return false;
  const list = Array.isArray(rows) ? rows : [];
  let max = "";
  for (const r of list) { const u = canonicalInstant(r && r.updated_at); if (u > max) max = u; }
  return String(list.length) === S(want.rows) && max === S(want.rowsMaxUa) && S(want.rowsDigest) !== "" && adsRowsDigest(list) === S(want.rowsDigest);
}

function catalogPointerMatch(ptr, want) {
  if (!ptr && !want) return true;
  if (!ptr || !want) return false;
  return S(ptr.payload_sha) === want.payloadSha && canonicalInstant(ptr.validated_at) === want.validatedAt && S(ptr.object_path) === want.objectPath;
}

/**
 * Build the route RUNTIME (route-contract.js ROUTE_RUNTIME_REQUIRED_HOOKS + expandUnits / identityAsOf / scopeTargets /
 * readEvidenceToken). THROWS (fail closed -> the CLI STOPs) on a missing collaborator or a non-region bucket.
 * Optional test/tuning seam deps.capacity = { heapStats() -> { used, limit }, unitBudgetMs, heapHighWater }.
 */
export function buildBrandViewPortfolioRuntime(deps = {}) {
  const {
    bucket, sb, pgReadOnly, computeHash, orgFp, directory = null, selectors = SERVE_SELECTORS,
    reportDerivations = null, now = () => Date.now(), log = () => {}, capacity = {},
  } = deps || {};
  if (!REGION_SCOPES.includes(S(bucket))) throw new Error("brand-view-portfolio route requires a region bucket (india|europe-au|us-ca) (fail closed).");
  if (typeof pgReadOnly !== "function") throw new Error("brand-view-portfolio route requires pgReadOnly (fail closed).");
  if (typeof computeHash !== "function") throw new Error("brand-view-portfolio route requires computeHash (fail closed).");
  if (!S(orgFp).trim()) throw new Error("brand-view-portfolio route requires the primary organization fingerprint (fail closed).");
  const READERS = ["getLatestReportSnapshot", "getReportSnapshotStoragePayload", "getLatestReportSnapshotMeta", "getInventorySnapshotCandidates", "getDailyAdsCoverage", "getCampaignBrandMappings", "getSourceSnapshot", "getSourceSnapshotPayload", "getAdsDailySourceRows", "getReportSnapshot", "getLatestReportSnapshotForScope", "inlinePayloadUsable"];
  for (const name of READERS) if (!sb || typeof sb[name] !== "function") throw new Error(`brand-view-portfolio route requires sb.${name} (fail closed).`);
  if (!selectors || typeof selectors.selectExactThenScopeLatest !== "function") throw new Error("brand-view-portfolio route requires the serve selectors (fail closed).");
  const heapStats = typeof capacity.heapStats === "function" ? capacity.heapStats : defaultHeapStats;
  const unitBudgetMs = Number.isFinite(capacity.unitBudgetMs) && capacity.unitBudgetMs > 0 ? capacity.unitBudgetMs : PORTFOLIO_UNIT_BUDGET_MS;
  const heapHighWater = Number.isFinite(capacity.heapHighWater) && capacity.heapHighWater > 0 && capacity.heapHighWater <= 1 ? capacity.heapHighWater : PORTFOLIO_HEAP_HIGH_WATER;
  const region = S(bucket);
  const TARGET = REGION_TARGET_PREFIX + region;

  // ---- evidence ----------------------------------------------------------------------------------------------------
  // ONE clock per read: the SQL params (the Ads build window) and the compose (the IN as-of) share nowMs.
  async function readRegionEvidence({ signal = null } = {}) {
    const nowMs = Number(now());
    const rowsByName = {};
    for (const q of EVIDENCE_SQL) {
      if (signal && signal.aborted) return { ok: false, failCode: "deadline-aborted" };
      try { rowsByName[q.name] = await pgReadOnly(q.text, q.params({ region, now: nowMs })); }
      catch (_e) { return { ok: false, failCode: "evidence-read-failed:" + q.name }; }
    }
    return { ok: true, evidence: composeBrandViewPortfolioEvidence(rowsByName, { now: nowMs }).get(region) };
  }
  // The evidence the current SCAN classified (keyed by its token) -- the current predicate evaluates each unit against
  // exactly that evidence (never a newer read the scan did not bind); a token mismatch falls back to a fresh read.
  let scanEvidence = null;
  const rememberScan = (ev) => { if (ev && S(ev.token)) scanEvidence = { token: S(ev.token), ev }; };

  function computeRevision({ accountId, evidence }) {
    if (S(accountId) !== TARGET) return { eligible: false, reason: "target-not-this-region" };
    const ev = evidence && typeof evidence === "object" ? evidence : null;
    if (!ev || !S(ev.token)) return { eligible: false, reason: "evidence-missing" };
    if (Array.isArray(ev.problems) && ev.problems.length) return { eligible: false, reason: ev.problems[0] };
    if (!Array.isArray(ev.universe) || ev.universe.length === 0) return { eligible: false, reason: "region-directory-empty" };
    return { eligible: true, revisionId: ev.token, evidenceToken: ev.token, deps: [ev.token], contentDeps: [ev.token], status: "available" };
  }

  // ---- the strict hydrated reader (getLatestReportSnapshotHydrated semantics; a storage THROW is a failure) --------
  // -> { row, storageMissing }. storageMissing: the row is OUT OF LINE (payload_storage_path set, inline payload not
  // usable) and its storage object is ABSENT -- the serve would silently fall back to the unusable inline stub (a member
  // skipped / an inventory fallback published as complete); the route never does: every caller turns it into a typed
  // deferral.
  // STORAGE IMMUTABILITY INVARIANT (relied on, not re-proven here): a hydrated storage payload is trusted as THE content
  // of the row whose identity (id, params_hash, source_refreshed_at, updated_at, reportVersion) the evidence SQL bound --
  // the object's bytes are NOT in the token. That holds because NO code path uploads or overwrites a report-snapshot
  // storage object: no report_snapshots writer is ever handed a payloadStoragePath (out-of-line rows are LEGACY), and the
  // bucket's only uploader (supabase.js putPrivateStorageObject) writes source-cache/v1/<requestHash> objects, versioned
  // source-cache objects (source-cache.js versionedObjectPath) and content-addressed source-snapshots/v2/<sha> objects
  // (pinned by scripts/brand-view-routes.test.js F8). It would BREAK if a writer started uploading report payloads to a
  // path re-used across saves of one row (content changes, row identity does not), or if a legacy row's
  // payload_storage_path named a source-cache/v1/<requestHash> object (overwritten in place by saveSourceExportCache) --
  // such a writer must make the path content-addressed or bump the row (updated_at) in the same save.
  async function strictHydrated({ reportKey, accountId }, signal) {
    const row = await sb.getLatestReportSnapshot({ reportKey, accountId });
    if (!row) return { row: null, storageMissing: false };
    if (sb.inlinePayloadUsable(row.payload) || !row.payload_storage_path) return { row, storageMissing: false };
    const hydrated = await sb.getReportSnapshotStoragePayload(row.payload_storage_path, { signal });
    if (hydrated) return { row: { ...row, payload: hydrated }, storageMissing: false };
    return { row, storageMissing: true };
  }

  // ---- membership (memoised brand names per account, keyed by the EXACT brand-sales row identity) ------------------
  const namesMemo = new Map();
  async function brandNamesFor(accountId, ident, signal) {
    if (!ident) return { ok: true, names: [] }; // no saved brand-sales yet (e.g. still loading): pins nothing
    // A TIED latest brand-sales row: the serve's pick is arbitrary, so the membership is unprovable.
    if (isAmbiguousIdentity(ident)) return { ok: false, reason: "latest-row-ambiguous:" + BRAND_SALES_KEY };
    const k = stableJson(ident);
    const hit = namesMemo.get(accountId);
    if (hit && hit.k === k) return { ok: true, names: hit.names };
    let read;
    try { read = await strictHydrated({ reportKey: BRAND_SALES_KEY, accountId }, signal); } catch (_e) { return { ok: false, reason: "membership-read-failed" }; }
    // An ABSENT storage object is an unreadable membership input (never the stub's empty brand list).
    if (read.storageMissing) return { ok: false, reason: "membership-read-failed" };
    const row = read.row;
    if (!row || stableJson(snapshotIdentity(row)) !== k) return { ok: false, reason: "membership-evidence-advanced" };
    const names = snapshotBrandNames(row.payload);
    namesMemo.set(accountId, { k, names });
    return { ok: true, names };
  }
  // -> { ok, brands: regionPortfolioMembers(...), membership, namesById } | { ok:false, reason }
  async function membershipOf(ev, signal) {
    const perAccountSales = [];
    const namesById = {};
    for (const id of ev.displayIds) {
      if (signal && signal.aborted) return { ok: false, reason: "deadline-aborted" };
      const r = await brandNamesFor(id, ev.display[id], signal);
      if (!r.ok) return { ok: false, reason: r.reason };
      perAccountSales.push({ accountId: id, salesBrands: r.names });
      namesById[id] = r.names;
    }
    const { membership } = computeBrandDirectoryMembership(perAccountSales);
    return { ok: true, brands: regionPortfolioMembers(membership, ev.serveAccountsById, region), membership, namesById };
  }
  const memberBlock = (ev, members) => {
    for (const id of members) {
      const a = ev.accounts[id];
      if (!a) return "member-not-in-region-universe";
      if (a.settingUp) return "member-setting-up";
      if (a.dup) return "member-directory-ambiguous";
      const tied = ev.ambiguous && Array.isArray(ev.ambiguous[id]) ? ev.ambiguous[id] : [];
      if (tied.length) return "latest-row-ambiguous:" + tied[0];
    }
    return null;
  };
  // The unit's per-unit manifest over evidence `ev` + its membership `m` for brand entry `b`.
  const unitManifestOf = (ev, m, b) => portfolioUnitManifestToken(ev, {
    region, orgFp, key: b.key, display: b.display, members: b.members, labelDeciders: portfolioLabelDeciders(m.membership, m.namesById, b.key),
  });

  // ---- the strict, evidence-checked readers: the serve's reader SEMANTICS (same supabase.js readers, same transforms)
  // plus failure capture + an identity check against the SQL evidence on every row they return ----------------------
  function makeReaders(ev, ledger, signal) {
    const getSnapshotMeta = async ({ reportKey, accountId }) => {
      let meta;
      try { meta = await sb.getLatestReportSnapshotMeta({ reportKey, accountId }, { signal }); } catch (e) { ledger.fail("snapshot-meta:" + reportKey); throw e; }
      const want = (ev.snaps[accountId] || {})[reportKey];
      const got = meta ? { h: S(meta.params_hash), sra: canonicalInstant(meta.source_refreshed_at), ua: canonicalInstant(meta.updated_at) } : null;
      if (want === undefined || stableJson(got) !== stableJson(want ? { h: want.h, sra: want.sra, ua: want.ua } : null)) ledger.mismatch(reportKey);
      return meta;
    };
    const getAdsCoverageState = async (accountId, sourceKey) => {
      let cov;
      try { cov = await sb.getDailyAdsCoverage(accountId, sourceKey, { signal }); } catch (e) { ledger.fail("ads-coverage"); throw e; }
      // getDailyAdsCoverage is fail-soft (read:'read-failed' + an empty state): a non-ok read is a FAILURE here.
      if (!cov || cov.read !== "ok") { ledger.fail("ads-coverage"); return cov || null; }
      if (S(sourceKey) !== ACTIVE_ADS_SOURCE_KEY || !adsCoverageMatch(cov, ev.ads[accountId])) ledger.mismatch("ads-coverage");
      return cov;
    };
    const getInventoryCandidates = async ({ reportKey, accountId, reportVersion }) => {
      let rows;
      try { rows = await sb.getInventorySnapshotCandidates({ reportKey, accountId, reportVersion }); } catch (e) { ledger.fail(BRAND_INVENTORY_KEY); throw e; }
      if (S(reportKey) !== BRAND_INVENTORY_KEY || S(reportVersion) !== BRAND_INVENTORY_REPORT_VERSION || !inventoryCandidatesMatch(rows, ev, accountId)) ledger.mismatch(BRAND_INVENTORY_KEY);
      return rows;
    };
    const getCampaignMappings = async ({ accountId }) => {
      let rows;
      try { rows = await sb.getCampaignBrandMappings({ organizationFingerprint: orgFp, connectionId: "primary", accountId, signal }); } catch (e) { ledger.fail("campaign-mapping"); throw e; }
      const want = ev.maps[accountId] && Object.prototype.hasOwnProperty.call(ev.maps[accountId], orgFp) ? ev.maps[accountId][orgFp] : campaignMappingRevision([]);
      if (campaignMappingRevision(rows || []) !== want) ledger.mismatch("campaign-mapping");
      return Array.isArray(rows) ? rows : [];
    };
    const catalogPointer = async () => {
      let read;
      try { read = await sb.getSourceSnapshot({ organizationFingerprint: orgFp, connectionId: "primary", sourceKey: "product-catalog", scopeKey: "__organization", signal }); } catch (e) { ledger.fail("catalog"); throw e; }
      // getSourceSnapshot is fail-soft ({ snapshot:null, read:'read-failed' }): a non-ok read is a FAILURE here.
      if (read && typeof read === "object" && "read" in read && read.read !== "ok") { ledger.fail("catalog"); return null; }
      const ptr = read && typeof read === "object" && "snapshot" in read ? read.snapshot : read;
      if (!catalogPointerMatch(ptr || null, ev.catalog[orgFp] || null)) ledger.mismatch("catalog");
      return ptr || null;
    };
    const getCatalogValidatedAt = async () => { const ptr = await catalogPointer(); return (ptr && (ptr.validated_at || ptr.payload_sha)) || null; };
    // The SHARED legacy fingerprint readers (brand-view-dependency-readers.js, moved verbatim from the composition) over
    // the strict readers above -- the value the serve computes when every read succeeds.
    const depReaders = makeBrandViewDepReaders({ orgFp, readers: { getSnapshotMeta, getAdsCoverageState, getInventoryCandidates, getCampaignMappings, getCatalogValidatedAt } });
    // The build's readers (the serve's brand-view-portfolio wiring: hydrated snapshots, durable Ads rows, the org catalog,
    // the campaign mappings, the authoritative inventory candidates).
    const getSnapshotHydrated = async ({ reportKey, accountId }) => {
      let read;
      try { read = await strictHydrated({ reportKey, accountId }, signal); } catch (e) { ledger.fail("snapshot:" + reportKey); throw e; }
      // An ABSENT storage object behind an unusable inline stub: a FAILURE (the unit defers typed, LKG kept) -- never the
      // stub the serve would silently use.
      if (read.storageMissing) ledger.fail("storage-missing:" + reportKey);
      const row = read.row;
      const want = (ev.snaps[accountId] || {})[reportKey];
      if (want === undefined || stableJson(snapshotIdentity(row)) !== stableJson(want || null)) ledger.mismatch(reportKey);
      return row;
    };
    const getAdsRows = async (args) => {
      let rows;
      try { rows = await sb.getAdsDailySourceRows({ ...args, signal }); }
      catch (e) {
        // The row-cap refusal is a DATA outcome the builder turns into an honest adsError (the serve does the same); any
        // other throw is a transient read failure -> the unit defers instead of publishing degraded Ads.
        if (!(e && e.code === "ADS_ROW_LIMIT_EXCEEDED")) ledger.fail("ads-rows");
        throw e;
      }
      // The rows read must be EXACTLY the evidence's build-window rows (count + max(updated_at) + window + source).
      if (!adsRowsMatch(args, rows, ev, S(args && args.accountId))) ledger.mismatch("ads-rows");
      return rows;
    };
    const getCatalogRows = async () => {
      const ptr = await catalogPointer();
      if (!ptr || !ptr.object_path) return null;
      let payload;
      try { payload = await sb.getSourceSnapshotPayload(ptr.object_path, { signal }); } catch (e) { ledger.fail("catalog-payload"); throw e; }
      return Array.isArray(payload) ? payload : (payload && Array.isArray(payload.rows) ? payload.rows : null);
    };
    const getInventorySnapshots = ({ reportKey, accountId }) => getInventoryCandidates({ reportKey, accountId, reportVersion: BRAND_INVENTORY_REPORT_VERSION });
    return { depReaders, getSnapshotHydrated, getAdsRows, getCatalogRows, getCampaignMappings, getInventorySnapshots };
  }

  // The LEGACY Brand View portfolio dependency fingerprint (the serve's value over the same inputs) -- strict.
  async function legacyFingerprint(ev, brand, members, signal) {
    const ledger = makeLedger();
    const { depReaders } = makeReaders(ev, ledger, signal);
    const depFingerprint = await collectBrandViewDependencyFingerprint({ scope: "portfolio", brand, accountIds: members, reportVersion: BRAND_VIEW_PORTFOLIO_VERSION, readers: depReaders });
    const reason = ledger.reason();
    return reason ? { ok: false, reason } : { ok: true, depFingerprint };
  }

  // ---- hooks -------------------------------------------------------------------------------------------------------
  async function readScopeEvidence({ scope, signal = null } = {}) {
    const targets = [...new Set((Array.isArray(scope) ? scope : []).map(S))];
    const perAccount = new Map();
    if (targets.includes(TARGET)) {
      const r = await readRegionEvidence({ signal });
      if (!r.ok) return { ok: false, failCode: "DURABLE_SOURCE_UNREADABLE: brand-view-portfolio " + r.failCode };
      perAccount.set(TARGET, r.evidence);
      rememberScan(r.evidence);
    }
    for (const t of targets) if (t !== TARGET) perAccount.set(t, null); // computeRevision: target-not-this-region
    return { ok: true, perAccount };
  }

  async function expandUnits({ accountId, evidence }) {
    const ev = evidence;
    if (S(accountId) !== TARGET || !ev || !Array.isArray(ev.universe) || !ev.universe.length) return [];
    rememberScan(ev);
    const sentinel = (reason) => [{
      unitKey: MEMBERSHIP_SENTINEL_UNIT_KEY, targetId: TARGET + ":" + MEMBERSHIP_SENTINEL_UNIT_KEY, liveAccountId: TARGET + ":" + MEMBERSHIP_SENTINEL_UNIT_KEY,
      ownerAccountIds: ev.universe.slice(), targetAsOf: ev.asOf, reportKeys: [PUBLISHER_KEY],
      deferred: { state: RECONCILE_STATUS.DEFERRED_DEPENDENCY, reason },
    }];
    const m = await membershipOf(ev, null);
    if (!m.ok) { log(`membership unavailable (${m.reason}) -- the region target defers`); return sentinel(m.reason); }
    const units = [];
    for (const b of m.brands) {
      const unitKey = portfolioUnitKey(b.key);
      const scopeId = brandViewPortfolioScopeId(b.members, b.display);
      const base = { unitKey, ownerAccountIds: b.members.slice(), targetAsOf: ev.asOf, reportKeys: [PUBLISHER_KEY] };
      // The core's OWN bound + measure (UTF-8 bytes), checked BEFORE any cycle / job write.
      if (targetIdByteLength(scopeId) > MAX_UNIT_TARGET_BYTES) {
        const tid = TARGET + ":scope-too-long:" + unitKey;
        units.push({ ...base, targetId: tid, liveAccountId: tid, deferred: { state: RECONCILE_STATUS.DEFERRED_PROVENANCE, reason: "portfolio-scope-id-too-long" } });
        continue;
      }
      const block = memberBlock(ev, b.members);
      units.push(block
        ? { ...base, targetId: scopeId, liveAccountId: scopeId, deferred: { state: RECONCILE_STATUS.DEFERRED_PROVENANCE, reason: block } }
        : { ...base, targetId: scopeId, liveAccountId: scopeId });
    }
    return units;
  }

  async function resolveBundle(unit, { signal = null } = {}) {
    const r = await readRegionEvidence({ signal });
    if (!r.ok) return { eligible: false, reason: r.failCode };
    const ev = r.evidence;
    const rev = computeRevision({ accountId: TARGET, evidence: ev });
    if (!rev.eligible) return { eligible: false, reason: rev.reason };
    const decoded = decodePortfolioUnit(unit);
    if (!decoded) return { eligible: false, reason: "unit-malformed" };
    const m = await membershipOf(ev, signal);
    if (!m.ok) return { eligible: false, reason: m.reason };
    const key = brandKey(decoded.brand);
    const b = m.brands.find((x) => x.key === key) || null;
    // The unit's identity (members + display label) must still be what the page requests NOW; else the next scan re-expands.
    if (!b || b.display !== decoded.brand || stableJson(b.members) !== stableJson(decoded.members)) return { eligible: false, reason: "unit-identity-changed" };
    const block = memberBlock(ev, b.members);
    if (block) return { eligible: false, reason: block };
    const fp = await legacyFingerprint(ev, b.display, b.members, signal);
    if (!fp.ok) return { eligible: false, reason: fp.reason };
    const accountsById = {};
    for (const id of b.members) {
      const meta = ev.serveAccountsById[id] || { name: null, country: null };
      accountsById[id] = { name: meta.name, country: meta.country };
    }
    // The PER-UNIT manifest (only this unit's inputs -- never the region token): the job lineage, the shadow params and
    // the live row's stored extras carry it; the current predicate proves a unit current by it across a region advance.
    const manifestToken = unitManifestOf(ev, m, b);
    return {
      eligible: true, revisionId: rev.revisionId, evidenceToken: rev.evidenceToken, manifestToken, deps: rev.deps.slice(),
      depFingerprint: fp.depFingerprint,
      bundle: { region, asOf: ev.asOf, brand: b.display, brandKey: key, members: b.members.slice(), accountsById, depFingerprint: fp.depFingerprint, evidence: ev },
    };
  }

  async function derive(bundle, { signal = null } = {}) {
    if (!bundle || !Array.isArray(bundle.members) || !bundle.members.length || !bundle.evidence) return { notReady: true, reason: "bundle-malformed" };
    const ev = bundle.evidence;
    const ledger = makeLedger();
    const readers = makeReaders(ev, ledger, signal);
    // CAPACITY guard, run by the builder BETWEEN account slices (never inside one): a recorded read failure / identity
    // mismatch also stops the build early (it could never publish).
    const started = Number(now());
    let exceeded = null;
    const deadline = {
      ensureTime: async () => {
        if (signal && signal.aborted) { exceeded = exceeded || "aborted"; throw new Error("aborted"); }
        if (ledger.reason()) { exceeded = exceeded || "evidence"; throw new Error("evidence"); }
        if (Number(now()) - started > unitBudgetMs) { exceeded = "deadline"; throw new Error("capacity-exceeded:deadline"); }
        let hs = null;
        try { hs = heapStats(); } catch (_e) { hs = null; }
        if (hs && Number(hs.limit) > 0 && Number(hs.used) / Number(hs.limit) > heapHighWater) { exceeded = "heap"; throw new Error("capacity-exceeded:heap"); }
      },
    };
    // The composition's OWN deriveBrandViewPortfolio (fingerprint FIRST, then the build, the materializer's exact code),
    // over the strict readers; the builder runs one slice at a time under the capacity guard. The provenance read feeds
    // only the materializer's stamp -- this route stamps by cycle -- so it is a no-op here (zero extra reads).
    const { deriveBrandViewPortfolio } = makeBrandViewDerivers({
      depReaders: readers.depReaders, getSnapshotHydrated: readers.getSnapshotHydrated, getAdsRows: readers.getAdsRows,
      getCampaignMappings: readers.getCampaignMappings, getInventorySnapshots: readers.getInventorySnapshots, getCatalogRows: readers.getCatalogRows,
      getProvenance: async () => null,
      buildPortfolio: (args) => buildBrandViewPortfolioSnapshot({ ...args, deadline, sliceConcurrency: 1 }),
    });
    let out;
    try { out = await deriveBrandViewPortfolio({ accountIds: bundle.members, brand: bundle.brand, asOf: bundle.asOf, region: bundle.region, accountsById: bundle.accountsById }); }
    catch (_e) { out = { notReady: "portfolio-derive-threw" }; }
    if (exceeded === "heap" || exceeded === "deadline") return { notReady: true, reason: "capacity-exceeded:" + exceeded };
    if (exceeded === "aborted") return { notReady: true, reason: "deadline-aborted" };
    // STRICT: a swallowed read or a REST row that is not the evidence identity never publishes.
    const reason = ledger.reason();
    if (reason) return { notReady: true, reason };
    if (!out || out.notReady || !out.payload) return { notReady: true, reason: S(out && out.notReady) || "portfolio-empty" };
    // The fingerprint the derive captured BEFORE its build must still be the bundle's (the serve 'updating' parity value).
    if (S(out.depFingerprint) !== S(bundle.depFingerprint)) return { notReady: true, reason: "evidence-advanced:dep-fingerprint" };
    return { payload: out.payload };
  }

  function identityParams(_unit, { bundle } = {}) {
    return { members: bundle.members.slice(), brand: bundle.brand, asOf: bundle.asOf, region: bundle.region };
  }

  function identityAsOf(_unit, { now: at } = {}) {
    return portfolioAsOf(at == null ? Number(now()) : at);
  }

  async function servedSelector(unit, { signal = null } = {}) {
    const d = decodePortfolioUnit(unit);
    if (!d || !S(unit.targetAsOf)) return { row: null, reason: "unit-malformed", via: null };
    return selectors.selectExactThenScopeLatest({
      reportKey: BRAND_VIEW_PORTFOLIO_REPORT_KEY, accountId: S(unit.liveAccountId), reportVersion: BRAND_VIEW_PORTFOLIO_VERSION,
      params: { accountIds: d.members.join(","), brand: d.brand, asOf: S(unit.targetAsOf), region },
      staleScopeKeys: ["region"],
      readers: {
        getReportSnapshot: (args) => sb.getReportSnapshot(args, { signal }),
        getLatestReportSnapshotForScope: (args) => sb.getLatestReportSnapshotForScope(args),
      },
      computeHash,
    });
  }

  /**
   * THE PER-UNIT CURRENT PREDICATE (see the header). Scoped to rk === the publisher key and to EXACTLY the case the
   * region token cannot decide per unit: the latest job is promotable but its lineage does not cover the scan's (moved)
   * region revision. Everything else -> null (the exact binding decides, unchanged). PUBLICATION_NOT_REQUIRED
   * 'unit-manifest-unchanged' ONLY when ALL hold (zero writes):
   *   - the scan's evidence (never a newer read) re-expands this unit to the SAME members + label, no member blocked;
   *   - the exact binding against the job's OWN lineage is PUBLICATION_NOT_REQUIRED (shadow publisher-valid, the live row
   *     IS its promotion: identity + as-of + stamp + payload + stored extras, the shared live read-back ok);
   *   - the unit's CURRENT per-unit manifest is in the job's durable_content_deps AND is the shadow's params.manifestToken
   *     AND the live row's stored manifestToken (the route's own shadow);
   *   - the SERVED row (servedSelector, the serve's selection) IS that live row (defaultServedVerdict).
   * A failed check is null (-> the exact binding: STALE -> re-derive), never a guess; a throw DEFERS (core).
   */
  async function currentPredicate(rk, unit, ctx = {}) {
    if (S(rk) !== PUBLISHER_KEY || !ctx || typeof ctx !== "object") return null;
    const job = ctx.job;
    const revision = ctx.revision;
    if (!jobIsPromotable(job) || !revision || revision.eligible !== true || revisionCoveredByJob(revision, job)) return null;
    if (!reportDerivations || typeof reportDerivations !== "object" || !ctx.contract) return null;
    const shadow = ctx.shadow && typeof ctx.shadow === "object" ? ctx.shadow : null;
    const live = ctx.live && typeof ctx.live === "object" ? ctx.live : null;
    const sp = shadow && shadow.params && typeof shadow.params === "object" ? shadow.params : null;
    const lp = live && live.params && typeof live.params === "object" ? live.params : null;
    if (!sp || !lp || S(sp.route) !== ROUTE_ID) return null;
    // The evidence the scan bound this revision to (else a fresh read that must still BE that revision).
    const want = S(revision.evidenceToken);
    let ev = scanEvidence && scanEvidence.token === want ? scanEvidence.ev : null;
    if (!ev) {
      const r = await readRegionEvidence({});
      if (!r.ok || !r.evidence || S(r.evidence.token) !== want) return null;
      ev = r.evidence;
    }
    if (!computeRevision({ accountId: TARGET, evidence: ev }).eligible) return null;
    const decoded = decodePortfolioUnit(unit);
    if (!decoded) return null;
    const m = await membershipOf(ev, null);
    if (!m.ok) return null;
    const b = m.brands.find((x) => x.key === brandKey(decoded.brand)) || null;
    if (!b || b.display !== decoded.brand || stableJson(b.members) !== stableJson(decoded.members) || memberBlock(ev, b.members)) return null;
    const manifestToken = unitManifestOf(ev, m, b);
    // The exact binding with the job's OWN lineage as the revision: every check except the region-token coverage.
    const jobRevision = { eligible: true, revisionId: "job-lineage", deps: (job.dependsOn || []).map(S), contentDeps: (job.durableContentDeps || []).map(S) };
    let bound;
    try {
      bound = evaluatePublicationBinding({
        revision: jobRevision, accountId: S(ctx.targetId), reportKey: PUBLISHER_KEY, requestedAsOf: ctx.requestedAsOf,
        expectedShadowKey: ctx.expectedShadowKey, job, shadow, hydratedShadowPayload: ctx.hydratedShadowPayload, live,
        hydratedLivePayload: ctx.hydratedLivePayload, liveReadback: ctx.liveReadback, contract: ctx.contract, computeHash, reportDerivations,
        liveAccountId: S(ctx.liveAccountId),
      });
    } catch (_e) { return null; }
    if (!bound || bound.state !== PUBLICATION_STATE.PUBLICATION_NOT_REQUIRED) return null;
    const contentDeps = new Set((job.durableContentDeps || []).map(S));
    if (!contentDeps.has(manifestToken) || S(sp.manifestToken) !== manifestToken || S(lp.manifestToken) !== manifestToken) return null;
    // The SERVED row must BE the proven live row (never on tokens alone).
    let served;
    try { served = await servedSelector(unit, {}); } catch (_e) { return null; }
    let verdict;
    try { verdict = SERVE_SELECTORS.defaultServedVerdict(served, SERVE_SELECTORS.servedRowIdentity(live)); } catch (_e) { verdict = null; }
    if (!verdict || verdict.ok !== true) return null;
    return { state: PUBLICATION_STATE.PUBLICATION_NOT_REQUIRED, reason: UNIT_MANIFEST_UNCHANGED, h: S(live.params_hash), sra: S(live.source_refreshed_at) };
  }

  async function readEvidenceToken(_unit, { signal = null } = {}) {
    const r = await readRegionEvidence({ signal });
    if (!r.ok) return "";
    const rev = computeRevision({ accountId: TARGET, evidence: r.evidence });
    return rev.eligible ? rev.evidenceToken : "";
  }

  // The region target exists only when the durable directory has an account in it (else no target, never a permanent
  // deferral for an empty region).
  async function scopeTargets({ directory: dir = directory } = {}) {
    const d = dir instanceof Map ? dir : new Map();
    for (const m of d.values()) if (regionForCountry(m && m.country) === region) return [TARGET];
    return [];
  }

  return Object.freeze({
    readScopeEvidence, computeRevision, resolveBundle, derive, identityParams, servedSelector,
    expandUnits, identityAsOf, scopeTargets, readEvidenceToken, currentPredicate,
  });
}

export default Object.freeze({
  id: ROUTE_ID,
  publisherKey: PUBLISHER_KEY,
  stampPolicy: "cycle",
  build: (deps) => buildBrandViewPortfolioRuntime(deps),
});
