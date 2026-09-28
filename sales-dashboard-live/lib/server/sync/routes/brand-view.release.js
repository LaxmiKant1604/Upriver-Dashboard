// Publication recovery WP8 -- CLI-side `brand-view` route: the zero-export release of the ACCOUNT-SCOPED Brand View
// through the generic route release (route-publication-release.js -> the fenced four-gate publisher). Worker-side twin:
// lib/server/recovery/routes/brand-view.route.js (the evidence SQL + the pure compose / token it shares).
//
// UNITS: the brands of the account's EXACT live brand-view-brands row (read by the evidence SQL, bound into the token):
// unitKey sha12(brand), targetId = live account = brandViewScopeId(owner, brand), owner = the gate account, targetAsOf =
// marketplaceToday(durable directory country, now) -- the value the browser sends (BrandView.jsx).
//
// STABLE, COMPLETE upstream content identity (never "last writer wins"):
//   - the L1 token covers EVERY input the payload is assembled from (see brand-view.route.js), bound at the unit's
//     identity as-of; resolveBundle re-reads it (strict) and the release brackets the derive between two resolves;
//   - params.depFingerprint is the UNCHANGED legacy collectBrandViewDependencyFingerprint computed with the EXTRACTED
//     readers (brand-view-dependency-readers.js) over the read-only REST facade -- the SAME value the serve computes
//     (api/datadoe.js brandViewDepFingerprintReaders), so the serve's 'updating' flag keeps working with NO serve change.
//     Every fingerprint read must SUCCEED and must EQUAL the evidence identity (brand-sales / fba-plan / listing-health
//     meta, the selected inventory compact, Ads state, mapping, catalog) -- a failed or advanced read DEFERS, so a
//     published fingerprint is never computed from a failed read;
//   - derive reuses the composition's deriveBrandView (makeBrandViewDerivers) with the durable directory account, a
//     per-account MEMOISED hydrated reader (brand-sales hydrated ONCE per account across its N brands) whose every row
//     must be EXACTLY the evidence row (a stale memo entry is evicted + re-read once; still different -> DEFER), a
//     strict storage hydration (an out-of-line payload that cannot be hydrated DEFERS instead of degrading), and strict
//     Ads-row / mapping / inventory-candidate readers (a read failure DEFERS -- never a fabricated zero or an empty
//     mapping); the durable Ads rows the build reads must be EXACTLY the rows the token binds (the SAME 'adr1:' content
//     digest -- brand-view-dependency-readers.js adsRowsDigest over the REST rows == the evidence SQL's adsRowsDigestSql
//     -- over the SAME window and active source, else 'evidence-advanced:ads-rows'); a fingerprint that advanced during
//     the build DEFERS.
//   - a directory brand the account's saved sales do not SELL (it is in the directory only via fba-plan / sku-pl) is
//     pre-checked with the builder's OWN predicates (buildAccountBrandSlice required=true: brand-sales rows present,
//     aggregateBrandSales(rows, brand).series non-empty) over the memoised brand-sales row and defers TYPED
//     'brand-not-sold' (or 'no-sales-snapshot' when the account's brand-sales carries no row at all) -- the page can
//     never show a Brand View for it either (the serve's build throws the same condition; without a stored row the
//     read-only serve shows "not saved yet"), so it is NOT-APPLICABLE, never a generic, retried-forever build failure.
//     The unit stays in the unit set (the page's brand list IS the directory); excluding it at expandUnits would cost a
//     brand-sales hydration on every scan. Every OTHER build throw keeps 'brand-view-build-failed'.
//   - a local-midnight roll during a run defers 'asof-rolled' (identityAsOf is the fresh browser value; the token and
//     manifest stay bound at the unit's as-of), and the next scan publishes the new identity.
// stampPolicy 'cycle'. servedSelector = selectExactThenLatest over the scope id at { accountId, brand, asOf } with
// version brand-view-account-scoped-v2 (the serve's exact read + its single-latest-row fallback). Read-only readers
// only (deps.sb is the get*/list* facade); zero DataDoe. 7-bit ASCII, LF.

import { createHash } from "node:crypto";
import {
  brandViewScopeId, buildBrandViewSnapshot, BRAND_VIEW_VERSION, BRAND_INVENTORY_REPORT_VERSION, selectAuthoritativeInventorySnapshot, aggregateBrandSales,
} from "../../reports/brand-view.js";
import { collectBrandViewDependencyFingerprint } from "../../reports/brand-view-dependency-fingerprint.js";
import { selectExactThenLatest } from "../../recovery/serve-selectors.js";
import { stableJson, isCalendarDate } from "../publication-binding.js";
import { makeBrandViewDerivers } from "../report-materialization-brandview-composition.js";
import {
  makeBrandViewDepReaders, makeMemoHydratedReader, snapshotRowIdentity, sameSnapshotIdentity, sameMetaIdentity, canonicalInstant, adsRowsDigest,
} from "../brand-view-dependency-readers.js";
import { ACTIVE_ADS_SOURCE_KEY } from "../../active-ads-source.js";
import { marketplaceToday } from "../../../marketplaces.js";
import workerRoute, {
  BRAND_VIEW_ROUTE_ID, BRAND_VIEW_PUBLISHER_KEY, BRAND_VIEW_EVIDENCE_REPORT_KEYS, composeBrandViewEvidence, brandViewToken, adsIdentity,
  brandViewIneligibleReason,
} from "../../recovery/routes/brand-view.route.js";
import { recoveryNowDate } from "../../recovery/routes/brand-view-brands.route.js";

const S = (v) => (v == null ? "" : String(v));
const sha256 = (v) => createHash("sha256").update(String(v)).digest("hex");
const errCode = (e) => (S(e && e.message).match(/^[A-Za-z0-9_.:-]+/) || [""])[0].slice(0, 80) || "error";
const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
// The legacy fingerprint reads these latest-row METAS (brand-inventory goes through the selected compact instead).
const FINGERPRINT_META_KEYS = Object.freeze(["brand-sales", "fba-plan", "listing-health"]);

/** The unit key of a brand: sha12(brand) (never brand text in a job key / argv). */
export const brandUnitKey = (brand) => sha256(S(brand)).slice(0, 12);

/** { owner, brand } of a brand-view unit (targetId === brandViewScopeId(owner, brand)), or null when malformed. */
export function parseBrandViewUnit(unit) {
  const owner = unit && Array.isArray(unit.ownerAccountIds) && unit.ownerAccountIds.length === 1 ? S(unit.ownerAccountIds[0]) : "";
  const targetId = S(unit && unit.targetId);
  const prefix = "brand-view:" + owner + "::";
  if (!owner || !targetId.startsWith(prefix)) return null;
  const brand = targetId.slice(prefix.length);
  if (!brand || brand !== brand.trim() || brandViewScopeId(owner, brand) !== targetId) return null;
  return { owner, brand, targetId };
}

/** The dependency identity strings a revision records (sync_report_jobs.depends_on; printable ASCII, bounded). */
export function brandViewDeps(ev) {
  const rowDep = (name, id) => "bv:" + name + ":" + (id ? S(id.id) + "@" + S(id.upd) : "absent");
  const hashDep = (name, v) => "bv:" + name + ":" + sha256(stableJson(v == null ? null : v)).slice(0, 32);
  return [
    ...BRAND_VIEW_EVIDENCE_REPORT_KEYS.map((rk) => rowDep(rk, ev.identities[rk])),
    rowDep("selected-inventory", ev.inventorySelected),
    rowDep("brand-view-brands", ev.directory.identity),
    hashDep("ads", ev.ads), hashDep("ads-rows", ev.adsRows ? S(ev.adsRows.digest) : null), hashDep("mapping", ev.mapping), hashDep("catalog", ev.catalog),
  ].sort();
}

/**
 * The durable Ads rows a build read are EXACTLY the rows the evidence token binds (PURE): the owner account, the ACTIVE
 * source only, the evidence's build window (ev.adsRows from / to -- brandViewAdsWindow of the bundle as-of) and the SAME
 * exact content digest (adsRowsDigest over the REST rows == the evidence SQL's adsRowsDigestSql). An insert / update /
 * delete between the evidence read and the build read -- including one that bypasses content_rev, or whose updated_at is
 * not above the newest one -- fails it.
 */
export function brandViewAdsRowsMatch(args, rows, ev, owner) {
  const want = ev && ev.adsRows;
  if (!want || typeof want !== "object" || !S(want.digest)) return false;
  const keys = args && Array.isArray(args.sourceKeys) ? args.sourceKeys.map(S) : [];
  if (S(args && args.accountId) !== S(owner) || keys.length !== 1 || keys[0] !== ACTIVE_ADS_SOURCE_KEY) return false;
  if (S(args.from) !== S(want.from) || S(args.to) !== S(want.to)) return false;
  return adsRowsDigest(Array.isArray(rows) ? rows : []) === S(want.digest);
}

/** PURE revision of one account's Brand View evidence (at the evidence's own as-of; the worker compose's predicate). */
export function brandViewRevision(ev) {
  const reason = brandViewIneligibleReason(ev);
  if (reason) return { eligible: false, reason };
  const token = S(ev.token);
  return { eligible: true, revisionId: token, evidenceToken: token, deps: brandViewDeps(ev), status: "available" };
}

const REQUIRED_SB = ["getLatestReportSnapshot", "getLatestReportSnapshotHydrated", "getReportSnapshot", "getReportSnapshotStoragePayload", "getLatestReportSnapshotMeta", "getDailyAdsCoverage", "getCampaignBrandMappings", "getSourceSnapshot", "getInventorySnapshotCandidates", "getAdsDailySourceRows"];

function build(deps = {}) {
  const { sb, pgReadOnly, computeHash, directory = null, orgFp = null, now = () => Date.now() } = deps;
  for (const name of REQUIRED_SB) if (!sb || typeof sb[name] !== "function") throw new Error(`brand-view route requires the read-only supabase reader ${name} (fail closed).`);
  if (typeof pgReadOnly !== "function") throw new Error("brand-view route requires pgReadOnly (fail closed).");
  if (typeof computeHash !== "function") throw new Error("brand-view route requires computeHash (paramsHashFor) (fail closed).");
  const SQL = workerRoute.evidence.sql;
  const nowDate = () => recoveryNowDate(now);

  // The per-account MEMOISED hydrated reader. Its underlying read hydrates STRICTLY: an out-of-line payload whose
  // storage object cannot be read (throw OR absent) is marked -- the derive then defers instead of building from the
  // inline stub the serve would silently fall back to.
  // STORAGE IMMUTABILITY INVARIANT (relied on, not re-proven here): a hydrated storage payload is trusted as THE content
  // of the row whose identity (id, params_hash, source_refreshed_at, updated_at, reportVersion) the evidence SQL bound
  // (the derive checks every memoised row against it) -- the object's bytes are NOT in the token. That holds because NO
  // code path uploads or overwrites a report-snapshot storage object: no report_snapshots writer is ever handed a
  // payloadStoragePath (out-of-line rows are LEGACY), and the bucket's only uploader (supabase.js putPrivateStorageObject)
  // writes source-cache/v1/<requestHash> objects, versioned source-cache objects (source-cache.js versionedObjectPath) and
  // content-addressed source-snapshots/v2/<sha> objects (pinned by scripts/brand-view-routes.test.js F8). It would BREAK
  // if a writer started uploading report payloads to a path re-used across saves of one row (content changes, row
  // identity does not), or if a legacy row's payload_storage_path named a source-cache/v1/<requestHash> object
  // (overwritten in place by saveSourceExportCache) -- such a writer must make the path content-addressed or bump the
  // row (updated_at) in the same save.
  const memo = makeMemoHydratedReader(async ({ reportKey, accountId }) => {
    let storageFailed = false;
    const readStorage = async (path, opt) => {
      try { const v = await sb.getReportSnapshotStoragePayload(path, opt); if (v == null) storageFailed = true; return v; }
      catch (e) { storageFailed = true; throw e; }
    };
    const row = await sb.getLatestReportSnapshotHydrated({ reportKey, accountId }, { readStorage });
    return { row, storageFailed };
  });

  async function readEvidence(scope, { dir = directory, org = orgFp } = {}) {
    const accountIds = [...new Set((Array.isArray(scope) ? scope : []).map(S).filter(Boolean))].sort();
    const ctx = { accountIds, directory: dir, organizationFingerprint: org, now: nowDate() };
    const rowsByName = {};
    for (const q of SQL) rowsByName[q.name] = await pgReadOnly(q.text, q.params(ctx));
    return composeBrandViewEvidence(rowsByName, ctx);
  }

  // The legacy dependency fingerprint with the EXTRACTED readers over the read-only facade (serve parity), every read
  // observed: -> { ok:true, depFingerprint } | { ok:false, reason } (a failed read, or a read that is not EXACTLY the
  // evidence identity the token binds).
  async function fingerprintFor(ev, { owner, brand }) {
    const fails = []; const obs = { meta: {}, ads: undefined, mappings: undefined, catalog: undefined, inventory: undefined };
    const readers = {
      getSnapshotMeta: async ({ reportKey, accountId }) => {
        try { const r = await sb.getLatestReportSnapshotMeta({ reportKey, accountId }); obs.meta[reportKey] = r || null; return r; }
        catch (e) { fails.push("meta-" + reportKey); throw e; }
      },
      getAdsCoverageState: async (accountId, sourceKey) => {
        let r;
        try { r = await sb.getDailyAdsCoverage(accountId, sourceKey); } catch (e) { fails.push("ads"); throw e; }
        if (!r || r.read !== "ok") fails.push("ads");
        obs.ads = r; return r;
      },
      getMappings: async (args) => {
        try { const r = await sb.getCampaignBrandMappings(args); obs.mappings = Array.isArray(r) ? r : []; return r; }
        catch (e) { fails.push("mapping"); throw e; }
      },
      getSourceSnap: async (args) => {
        let r;
        try { r = await sb.getSourceSnapshot(args); } catch (e) { fails.push("catalog"); throw e; }
        if (!r || r.read !== "ok") fails.push("catalog");
        obs.catalog = r; return r;
      },
      getInventoryCandidates: async (args) => {
        try { const rows = await sb.getInventorySnapshotCandidates(args); obs.inventory = Array.isArray(rows) ? rows : []; return rows; }
        catch (e) { fails.push("inventory"); throw e; }
      },
    };
    let depFingerprint = null;
    try {
      depFingerprint = await collectBrandViewDependencyFingerprint({
        scope: "account", brand, accountIds: [owner], reportVersion: BRAND_VIEW_VERSION, readers: makeBrandViewDepReaders({ orgFp, readers }),
      });
    } catch (e) { return { ok: false, reason: "fingerprint-threw:" + errCode(e) }; }
    if (fails.length) return { ok: false, reason: "fingerprint-read-failed:" + [...fails].sort()[0] };
    if (typeof depFingerprint !== "string" || !/^[0-9a-f]{40}$/.test(depFingerprint)) return { ok: false, reason: "fingerprint-invalid" };
    // CROSS-CHECK: every fingerprint input IS the evidence the L1 token binds.
    for (const rk of FINGERPRINT_META_KEYS) if (!sameMetaIdentity(obs.meta[rk] == null ? null : obs.meta[rk], ev.identities[rk])) return { ok: false, reason: "fingerprint-inputs-advanced:" + rk };
    if (!sameSnapshotIdentity(snapshotRowIdentity(selectAuthoritativeInventorySnapshot(obs.inventory || [])), ev.inventorySelected)) return { ok: false, reason: "fingerprint-inputs-advanced:brand-inventory" };
    const a = obs.ads || {};
    const restAds = adsIdentity({ hasState: true, status: a.status, latest: a.latestMetricDate, rev: a.contentRev, windows: (Array.isArray(a.windows) ? a.windows : []).map((w) => S(w && w.from) + ".." + S(w && w.to)) });
    if (stableJson(restAds) !== stableJson(ev.ads)) return { ok: false, reason: "fingerprint-inputs-advanced:ads" };
    if (orgFp) {
      const rows = obs.mappings || [];
      const max = rows.map((m) => canonicalInstant(m && m.updated_at)).filter(Boolean).sort().pop() || null;
      if (rows.length !== ev.mapping.n || (rows.length > 0 && max !== ev.mapping.max)) return { ok: false, reason: "fingerprint-inputs-advanced:mapping" };
      const ptr = obs.catalog && obs.catalog.snapshot ? obs.catalog.snapshot : null;
      const restCat = ptr ? { sha: S(ptr.payload_sha), at: canonicalInstant(ptr.validated_at) } : null;
      if (stableJson(restCat) !== stableJson(ev.catalog)) return { ok: false, reason: "fingerprint-inputs-advanced:catalog" };
    } else if (ev.mapping.n !== 0 || ev.catalog !== null) {
      return { ok: false, reason: "fingerprint-inputs-advanced:org" };
    }
    return { ok: true, depFingerprint };
  }

  async function resolveBundle(unit) {
    const p = parseBrandViewUnit(unit);
    if (!p) return { eligible: false, reason: "unit-malformed" };
    let ev;
    try { ev = (await readEvidence([p.owner])).get(p.owner); } catch (e) { return { eligible: false, reason: "evidence-unreadable:" + errCode(e) }; }
    const rev = brandViewRevision(ev);
    if (!rev.eligible) return rev;
    if (!ev.directory.brands.includes(p.brand)) return { eligible: false, reason: "brand-not-in-directory" };
    // The token + manifest bind the unit's IDENTITY as-of (the scan's targetAsOf); the fresh browser as-of is the
    // bundle's (the release defers 'asof-rolled' when the two part).
    const boundAsOf = isCalendarDate(unit && unit.targetAsOf) ? S(unit.targetAsOf) : ev.asOf;
    const evidenceToken = brandViewToken(ev, boundAsOf);
    const fp = await fingerprintFor(ev, p);
    if (!fp.ok) return { eligible: false, reason: fp.reason };
    const manifestToken = "bvm1:" + sha256(stableJson([evidenceToken, p.targetId, p.brand, boundAsOf, fp.depFingerprint]));
    return {
      eligible: true, revisionId: evidenceToken, evidenceToken, manifestToken, deps: rev.deps, depFingerprint: fp.depFingerprint,
      bundle: {
        owner: p.owner, brand: p.brand, targetId: p.targetId, asOf: ev.asOf, boundAsOf, depFingerprint: fp.depFingerprint, evidence: ev,
        account: { accountId: p.owner, country: ev.country, currency: ev.currency, name: ev.name },
      },
    };
  }

  async function derive(bundle) {
    const { owner, brand, asOf, account, evidence: ev, depFingerprint } = bundle || {};
    if (!owner || !brand || !ev) return { notReady: true, reason: "bundle-malformed" };
    const problems = [];
    // The memoised hydrated reader, bound to the evidence: every row must be EXACTLY the evidence row.
    const getSnapshotHydrated = async ({ reportKey, accountId }) => {
      if (S(accountId) !== owner || !has(ev.identities, reportKey)) { problems.push("unbound-read:" + reportKey); return null; }
      const readOnce = async () => {
        let got;
        try { got = await memo({ reportKey, accountId: owner }); } catch (e) { problems.push("read-failed:" + reportKey); throw e; }
        return got || { row: null, storageFailed: false };
      };
      let got = await readOnce();
      if (got.storageFailed || !sameSnapshotIdentity(snapshotRowIdentity(got.row), ev.identities[reportKey])) {
        memo.invalidate({ reportKey, accountId: owner }); // a stale / failed memo entry is never reused
        got = await readOnce();
        if (got.storageFailed) { memo.invalidate({ reportKey, accountId: owner }); problems.push("hydrate-failed:" + reportKey); }
        else if (!sameSnapshotIdentity(snapshotRowIdentity(got.row), ev.identities[reportKey])) problems.push("evidence-advanced:" + reportKey);
      }
      return got.row;
    };
    // The selected compact the builder will use must be the evidence's selection.
    const getInventorySnapshots = async ({ reportKey, accountId }) => {
      let rows;
      try { rows = await sb.getInventorySnapshotCandidates({ reportKey, accountId, reportVersion: BRAND_INVENTORY_REPORT_VERSION }); }
      catch (e) { problems.push("read-failed:inventory-candidates"); throw e; }
      if (!sameSnapshotIdentity(snapshotRowIdentity(selectAuthoritativeInventorySnapshot(rows)), ev.inventorySelected)) problems.push("evidence-advanced:selected-inventory");
      return rows;
    };
    // Ads DAILY ROWS: IDENTITY-CHECKED (the former KNOWN RESIDUAL is CLOSED). The rows read here (getAdsDailySourceRows
    // over ~6 calendar months: monthBack(asOf, 5).from .. asOf, up to ADS_MAX_ROWS) must be EXACTLY the rows the L1 token
    // binds: ev.adsRows is the evidence SQL's EXACT 'adr1:' content digest of the account's ACTIVE-source rows over that
    // window (brand-view.route.js ADS_ROWS_SQL -> the SHARED adsRowsDigestSql), and brandViewAdsRowsMatch recomputes it
    // (adsRowsDigest, the JS twin) over the REST rows. This closes both former gaps:
    //   (1) content_rev (ads-sync.js) digests only the committed rows of the LAST MAX_REQUIRED_COVERAGE_DAYS (60) days of
    //       an Ads sync run -- a row change OLDER than that (still inside Brand View's ~6-month read) left content_rev and
    //       so the token unchanged; the row digest covers the WHOLE build window, so ANY row insert / update / delete in
    //       it (even one whose updated_at is not above the newest -- now() is the transaction START time) moves the
    //       token and re-arms the account's units;
    //   (2) these rows and the ads_sync_state / coverage rows are SEPARATE reads (no shared snapshot): an Ads write
    //       landing between the evidence read and this read can no longer reach a payload -- the digest differs and the
    //       unit defers typed 'evidence-advanced:ads-rows' (zero writes; the next scan binds the new rows).
    // The jsonb metrics / dimensions are bound through updated_at (touch_updated_at trigger on every UPDATE; the Ads
    // writer never supplies updated_at), see brand-view-dependency-readers.js. A read FAILURE still defers (never a
    // fabricated zero spend).
    const getAdsRows = async (args) => {
      let rows;
      try { rows = await sb.getAdsDailySourceRows(args); } catch (e) { problems.push("read-failed:ads-rows"); throw e; }
      if (!brandViewAdsRowsMatch(args, rows, ev, owner)) problems.push("evidence-advanced:ads-rows");
      return rows;
    };
    // STRICT mappings (the composition's reader swallows a failure into [] -- an honest-looking zero ad spend).
    const getCampaignMappings = async ({ accountId }) => {
      if (!orgFp) return [];
      let rows;
      try { rows = await sb.getCampaignBrandMappings({ organizationFingerprint: orgFp, connectionId: "primary", accountId }); }
      catch (e) { problems.push("read-failed:mapping"); throw e; }
      const list = Array.isArray(rows) ? rows : [];
      const max = list.map((m) => canonicalInstant(m && m.updated_at)).filter(Boolean).sort().pop() || null;
      if (list.length !== ev.mapping.n || (list.length > 0 && max !== ev.mapping.max)) problems.push("evidence-advanced:mapping");
      return list;
    };
    const { deriveBrandView } = makeBrandViewDerivers({
      depReaders: makeBrandViewDepReaders({
        orgFp,
        readers: { getSnapshotMeta: sb.getLatestReportSnapshotMeta, getAdsCoverageState: sb.getDailyAdsCoverage, getMappings: sb.getCampaignBrandMappings, getSourceSnap: sb.getSourceSnapshot, getInventoryCandidates: sb.getInventorySnapshotCandidates },
      }),
      getSnapshotHydrated, getAdsRows, getCampaignMappings, getInventorySnapshots,
      // The route stamps the cycle (stampPolicy 'cycle'): the brand-sales provenance read is not needed.
      getProvenance: async () => null,
      buildSingle: buildBrandViewSnapshot,
    });
    // PRE-CHECK (the builder's OWN predicates -- buildAccountBrandSlice with required=true throws on exactly these):
    // over the memoised, identity-checked brand-sales row (the builder's own read below is then a memo hit). A brand the
    // saved sales do not sell is typed NOT-APPLICABLE, never a generic build failure re-derived every scan.
    let salesRow;
    try { salesRow = await getSnapshotHydrated({ reportKey: "brand-sales", accountId: owner }); }
    catch (e) { return { notReady: true, reason: problems[0] || "read-failed:brand-sales" }; }
    if (problems.length) return { notReady: true, reason: problems[0] };
    const salesPayload = salesRow && salesRow.payload;
    if (!(salesPayload && salesPayload.rows && salesPayload.rows.length)) return { notReady: true, reason: "no-sales-snapshot" };
    let sold = true;
    try { sold = aggregateBrandSales(salesPayload.rows, brand).series.size > 0; } catch (_e) { sold = true; } // a malformed payload: the builder reports it
    if (!sold) return { notReady: true, reason: "brand-not-sold" };
    let out;
    try { out = await deriveBrandView({ accountId: owner, brand, asOf, account }); }
    catch (e) { return { notReady: true, reason: problems[0] || "derive-threw:" + errCode(e) }; }
    if (problems.length) return { notReady: true, reason: problems[0] };
    if (!out || out.notReady) return { notReady: true, reason: S(out && out.notReady) || "brand-view-empty" };
    // The legacy fingerprint re-captured BEFORE the build (the composition's TOCTOU ordering) must still be the bundle's.
    if (S(out.depFingerprint) !== S(depFingerprint)) return { notReady: true, reason: "dep-fingerprint-advanced" };
    const cov = out.payload && out.payload.coverage;
    return { payload: out.payload, latestDataDate: cov && isCalendarDate(cov.salesLatestDate) ? cov.salesLatestDate : null };
  }

  return {
    readScopeEvidence: async ({ scope, directory: dir, organizationFingerprint }) => {
      try { return { ok: true, perAccount: await readEvidence(scope, { dir: dir || directory, org: organizationFingerprint || orgFp }) }; }
      catch (e) { return { ok: false, failCode: "brand-view-evidence-unreadable:" + errCode(e) }; }
    },
    computeRevision: ({ evidence }) => brandViewRevision(evidence),
    expandUnits: async ({ accountId, evidence }) => {
      const brands = evidence && evidence.directory && Array.isArray(evidence.directory.brands) ? evidence.directory.brands : null;
      if (!brands) throw new Error("brand-directory-unavailable"); // typed deferral by the core (never an empty unit set)
      return brands.map((brand) => {
        const targetId = brandViewScopeId(accountId, brand);
        return { unitKey: brandUnitKey(brand), targetId, liveAccountId: targetId, ownerAccountIds: [accountId], targetAsOf: evidence.asOf, reportKeys: [BRAND_VIEW_PUBLISHER_KEY] };
      });
    },
    resolveBundle,
    derive,
    identityParams: (unit, { bundle }) => ({ ownerAccountId: S(bundle.owner), brand: S(bundle.brand), asOf: S(bundle.asOf) }),
    // The browser's CURRENT identity as-of for the owner's marketplace (a roll between the two resolves -> 'asof-rolled').
    identityAsOf: (unit, { bundle, now: n }) => marketplaceToday(bundle.account.country, recoveryNowDate(n == null ? now : n)),
    servedSelector: async (unit) => {
      const p = parseBrandViewUnit(unit);
      if (!p) return { row: null, reason: "unit-malformed", via: null };
      return selectExactThenLatest({
        reportKey: "brand-view", accountId: S(unit.liveAccountId), reportVersion: BRAND_VIEW_VERSION,
        params: { accountId: p.owner, brand: p.brand, asOf: S(unit.targetAsOf) },
        readers: { getReportSnapshot: sb.getReportSnapshot, getLatestReportSnapshot: sb.getLatestReportSnapshot }, computeHash,
      });
    },
  };
}

export default Object.freeze({
  id: BRAND_VIEW_ROUTE_ID,
  publisherKey: BRAND_VIEW_PUBLISHER_KEY,
  stampPolicy: "cycle",
  build,
});
