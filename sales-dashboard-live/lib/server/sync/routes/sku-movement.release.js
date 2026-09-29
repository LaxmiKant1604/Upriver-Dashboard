// Publication recovery WP6 -- the CLI-SIDE 'sku-movement' recovery route (validated fail-closed by route-contract.js
// validateRouteModule side:'cli' against the REAL SCHEDULER_LIVE_SNAPSHOT_CONTRACTS + REPORT_DERIVATIONS; paired with
// lib/server/recovery/routes/sku-movement.route.js). The generic route CLI (scripts/release/publication-route-reconcile.mjs
// --route=sku-movement) builds this runtime over DURABLE readers only (the read-only supabase facade + the read-only pg
// client) and runs it through the generic two-phase release (route-publication-release.js) -> the reviewed fenced
// four-gate publisher. ZERO DataDoe: nothing here (or below it) can create an export or spend a token.
//
// UNITS (per scope account = the job target): 'ALL' plus one unit per brand of the account's EXACT live
// brand-view-brands row (report_key 'brand-view-brands', account_id = the account, params_hash =
// paramsHashFor('brand-view-brands-v1', { accountId })) -- VERIFIED: the row read here must carry EXACTLY the
// (params_hash, source_refreshed_at, updated_at) the L1 token was composed from, name its own account, and list
// canonical (trimmed, nonblank, unique) brand strings. The brand string is used EXACTLY (case preserved; never folded,
// never fuzzy-matched) -- it is the UI's brand param. A missing row builds ONLY 'ALL' and marks the named units
// DEFERRED_DEPENDENCY 'brand-list-unavailable' (a marker unit that is never read or written); an advanced / invalid /
// unreadable row marks them 'brand-list-advanced' / 'brand-list-invalid' / 'brand-list-read-failed'; a brand whose
// target id exceeds the reconciler's bound keeps the marker 'brand-target-unrepresentable' (never silently dropped).
// Marker STATES: a CONTENT problem of the verified row ('brand-list-invalid', 'brand-target-unrepresentable') is
// DEFERRED_PROVENANCE (missing-evidence + alert: waiting will not fix it); 'brand-list-unavailable' /
// 'brand-list-advanced' / 'brand-list-read-failed' are DEFERRED_DEPENDENCY (wait for brand-view-brands, retry).
//   unit key   'ALL' | sha12(brand)          (never a brand string in a job key or argv)
//   targetId   skuMovementTargetId(acct, brand) = 'sku-movement:<acct>::<brand>'   (keys the job + shadow)
//   live       report_key 'sku-movement', account_id = acct, params { asOf: effectiveAsOf, brand } (+ the stored-only
//              evidenceToken / serveToken / manifestToken extras, never hashed)
//
// EVIDENCE: the L1 token is the worker route's metadata SQL + compose, re-run here through deps.pgReadOnly (the SAME
// statements -> the SAME token the worker claimed). The per-account HYDRATED evidence (ordered OLI history + org
// catalog) is loaded ONCE per (account, L1 token) by the STRICT loadSkuMovementAccountEvidence (a failed read defers
// typed -- never a brandless ALL or an empty named payload) and shared by every brand unit (a 2-entry LRU; the org
// catalog payload is hydrated once per object path). resolveBundle re-reads the L1 metadata on EVERY call (the release's
// entry + before-write TOCTOU checks see a real re-read), cross-checks the hydrated evidence against it, and returns
//   manifestToken  'smm1:' digest of the hydrated history + catalog rows (--verify-exact proves the lineage carries it)
//   serveToken     'sms2:' (sku-movement-evidence.js computeSkuServeToken) computed from the SAME L1 metadata the
//                  evidence token was composed from (coverage windows + updated_at, catalog payload_sha, opunits count +
//                  max(updated_at)) -- what the WP10 serve recomputes from its own reads (THE SERVE-SIDE CONTRACT there).
// STAMP: 'cycle' (the priority-partial cycle's created_at).
//
// SERVED ROW: the serve (api/datadoe.js serveSelfHealingSkuMovement) serves the latest stored row for (account,
// 'sku-movement/v2', { brand }) ONLY when its "stored is current" predicate over its own cheap reads says so; otherwise
// it re-derives read-only (no row is served). The served selector reproduces BOTH steps: selectLatestForScope (pinned
// by the parity suite) + the serve's freshness probe -> null 'serve-rederives' (+ heldBy = the row holding the serve's
// latest slot) when the serve would not serve the stored row; a probe read that is not 'ok' is null 'read-failed'.
// WHICH predicate is FAIL-CLOSED on an owner attestation (the LHv3 serve-gate attestation pattern):
//   SKU_MOVEMENT_SERVE_TOKEN_ATTESTED exactly 'true' (the owner attests the DEPLOYED Vercel serve uses
//     skuMovementStoredIsCurrent / computeSkuServeToken -- WP10) -> the token predicate;
//   anything else (unset, 'TRUE', '1', ...) -> the LEGACY predicate EXACTLY as api/datadoe.js serves today
//     (source_refreshed_at === max(catalog validated_at, effectiveAsOf T00Z)). Route rows are stamped
//     cycle.created_at, so the legacy serve re-derives them: they are never read back as served / verified.
// ACTIVATION GATE (WP13 verifier P2-2): unattested, every LIVE write is DEFERRED with zero writes (derive returns the
// typed 'sku-movement-serve-not-attested:route-not-activated' before any cycle / job / shadow write; publishGuard refuses
// a resumed prepare before the CAS) -- the scheduler's unconditional route run publishes NO sku-movement row until the
// owner attests the deployed WP10 serve, so it never writes a row the deployed serve cannot serve. (With the legacy
// materializer retired, nothing writes sku-movement until then: the page keeps the serve's read-only re-derive -- correct,
// but slower once D-1 advances.)
// Read ONCE per runtime from deps.env (else process.env) by skuServeTokenAttested. 7-bit ASCII, LF.

import { createHash } from "node:crypto";
import { skuMovementTargetId, skuMovementCanonicalBrand, SKU_MOVEMENT_TARGET_PREFIX } from "../report-publisher.js";
import { RECONCILE_STATUS } from "../saved-data-reconciler.js";
import { selectLatestForScope, defaultServedVerdict } from "../../recovery/serve-selectors.js";
import { loadSkuMovementAccountEvidence, buildSkuMovementUnit, skuMovementProvenDates, skuMovementRefreshedAt } from "../../reports/sku-movement-durable-rederive.js";
import {
  computeSkuServeToken, computeSkuManifestToken, skuMovementStoredIsCurrent, skuMovementLegacyStoredIsCurrent,
  normalizeSkuCoverageWindows, normalizeSkuServeWindows, skuServeCanonicalBrand,
} from "../../reports/sku-movement-evidence.js";
import {
  readSkuMovementScopeEvidence, brandViewBrandsLiveHash, skuMovementEvidenceCeiling,
  SKU_MOVEMENT_ROUTE_ID, SKU_MOVEMENT_PUBLISHER_KEY, SKU_MOVEMENT_LIVE_REPORT_KEY,
} from "../../recovery/routes/sku-movement.route.js";
import { BRAND_VIEW_BRANDS_REPORT_KEY } from "../../reports/brand-view.js";

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";
const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const textOrNull = (v) => (v == null ? null : S(v));
const sha12 = (v) => createHash("sha256").update(String(v)).digest("hex").slice(0, 12);

export const SKU_MOVEMENT_LIVE_VERSION = "sku-movement/v2";
export const SKU_ALL_UNIT_KEY = "ALL";
// The marker unit that carries a typed brand-list deferral (never read, never written; its targetId is outside the
// 'sku-movement:' target namespace so it can never collide with a real (account, brand) target).
export const SKU_BRAND_LIST_UNIT_KEY = "brands";
export const SKU_BRAND_LIST_MARKER_PREFIX = "sku-movement-brand-list:";
// Marker reasons that are CONTENT problems of the verified brands row (waiting will not fix them): DEFERRED_PROVENANCE.
// Every other marker reason is DEFERRED_DEPENDENCY (the brands row is missing / moved / unreadable: wait + retry).
const SKU_BRAND_LIST_PROVENANCE_REASONS = Object.freeze(["brand-list-invalid", "brand-target-unrepresentable"]);
// The owner's attestation that the DEPLOYED serve uses the token predicate (WP10). Exactly 'true' or it is not given.
export const SKU_MOVEMENT_SERVE_TOKEN_ATTESTED_ENV = "SKU_MOVEMENT_SERVE_TOKEN_ATTESTED";
// The typed deferral of every LIVE write while the serve attestation is absent (the worker classifies the
// 'route-not-activated' substring as ROUTE_NOT_ACTIVATED: a typed deferral + alert, never a failure, never published).
export const SKU_MOVEMENT_ROUTE_NOT_ACTIVATED = "sku-movement-serve-not-attested:route-not-activated";
const HEAVY_MEMO_MAX = 2;
// An intentionally TIGHTER per-route bound than the reconciler core's unit target-id limit: a sku-movement target is
// 'sku-movement:<account>::<brand>', so 512 chars only refuses a pathological brand string (typed, never dropped).
const MAX_UNIT_TARGET_ID_CHARS = 512;
// The supabase.js READERS this runtime needs (the CLI hands it the read-only facade; a writer is never reachable).
const REQUIRED_READERS = Object.freeze([
  "getSourceOliHistoryRows", "getSourceCoverageWindows", "getSourceSnapshot", "getSourceSnapshotPayload",
  "getSourceOliOperationalUnitRows", "getOliSkuAsinResolutionRows", "getLatestReportSnapshotForScope", "getReportSnapshotStoragePayload",
]);

// The account's EXACT live brand-view-brands row + its brand list (one read-only statement; the metadata columns use the
// SAME text formatting as the L1 evidence SQL, so the verification is an exact string comparison).
export const SKU_BRAND_LIST_SQL = [
  "select r.account_id, r.params_hash,",
  "  to_char(r.source_refreshed_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as source_refreshed_at,",
  "  to_char(r.updated_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as updated_at,",
  "  r.payload->>'accountId' as payload_account_id, r.payload->'brands' as brands, r.payload_storage_path",
  "from public.report_snapshots r",
  `where r.report_key = '${BRAND_VIEW_BRANDS_REPORT_KEY}' and r.account_id = $1 and r.params_hash = $2`,
].join("\n");

/** The unit key of a brand: 'ALL' for the All-Brands scope, else sha12(brand) (a brand string never leaves the process). */
export function skuMovementUnitKey(brand) {
  return brand === "ALL" ? SKU_ALL_UNIT_KEY : sha12(brand);
}

/** { owner, brand } of a unit whose targetId is the CANONICAL target of (liveAccountId, brand); null otherwise. */
export function parseSkuMovementUnit(unit) {
  const owner = S(unit && unit.liveAccountId);
  const tid = S(unit && unit.targetId);
  const prefix = SKU_MOVEMENT_TARGET_PREFIX + owner + "::";
  if (!nb(owner) || !tid.startsWith(prefix)) return null;
  const brand = tid.slice(prefix.length);
  if (skuMovementTargetId(owner, brand) !== tid || skuMovementCanonicalBrand(brand) !== brand) return null;
  return { owner, brand };
}

/**
 * Has the owner attested that the DEPLOYED serve uses the token predicate (skuMovementStoredIsCurrent /
 * computeSkuServeToken -- WP10)? ONLY env.SKU_MOVEMENT_SERVE_TOKEN_ATTESTED === 'true' (exactly); anything else -- unset,
 * blank, 'TRUE', '1', a non-object env -- is NOT attested (fail closed: the served selector models the legacy serve).
 */
export function skuServeTokenAttested(env) {
  return !!(env && typeof env === "object" && env[SKU_MOVEMENT_SERVE_TOKEN_ATTESTED_ENV] === "true");
}

/**
 * The serve's CHEAP freshness probe, reproduced EXACTLY (api/datadoe.js serveSelfHealingSkuMovement; with
 * readServeTokenInputs, the WP10 token serve): the account's OLI coverage windows (read 'ok' only, else none) ->
 * effectiveAsOf at the serve's ceiling (the UTC calendar date), the org catalog pointer -> the legacy provenance
 * (skuMovementRefreshedAt) and, when `readServeTokenInputs` is given, the serve token (computeSkuServeToken over the
 * coverage windows WITH updated_at + the operational-units stats that reader returns, the catalog payload_sha and the
 * canonical brand). -> { read, effectiveAsOf, serveToken, legacyProvenance }. `read` is 'ok' ONLY when the coverage
 * read, the catalog read and (when used) the token-input read are all 'ok' AND the token inputs cover EXACTLY the
 * coverage windows the serve read (else 'read-failed' / 'inputs-inconsistent': the caller never guesses what is
 * served). readServeTokenInputs({ accountId, effectiveAsOf, signal }) -> { read: 'ok', coverageWindows: [{ from, to,
 * updatedAt }], opunits: { windowFrom, windowTo, rows, maxUpdatedAt } } (the SERVE-SIDE CONTRACT's (1)+(4)). Readers
 * throw through (the caller types it).
 */
export async function skuServeFreshnessProbe({ sb, readServeTokenInputs = null, organizationFingerprint, connectionId = "primary", accountId, brand, ceiling, signal = null } = {}) {
  const cov = await sb.getSourceCoverageWindows({ organizationFingerprint, connectionId, accountId, sourceKey: "order-line-items", signal });
  const covOk = !!(cov && cov.read === "ok");
  const oliWindows = covOk ? (cov.windows || []) : [];
  const { effectiveAsOf } = skuMovementProvenDates(oliWindows, ceiling);
  const catRead = await sb.getSourceSnapshot({ organizationFingerprint, connectionId, sourceKey: "product-catalog", scopeKey: "__organization", signal });
  const catOk = !!(catRead && typeof catRead === "object" && (!("read" in catRead) || catRead.read === "ok"));
  const catalogSnapshot = catRead && typeof catRead === "object" && "snapshot" in catRead ? catRead.snapshot : catRead;
  const legacyProvenance = skuMovementRefreshedAt({ catalogSnapshot, effectiveAsOf });
  const out = { read: covOk && catOk ? "ok" : "read-failed", effectiveAsOf, serveToken: null, legacyProvenance };
  if (out.read !== "ok" || typeof readServeTokenInputs !== "function" || !effectiveAsOf) return out;
  const inputs = await readServeTokenInputs({ accountId, effectiveAsOf, signal });
  if (!inputs || inputs.read !== "ok") return { ...out, read: "read-failed" };
  if (JSON.stringify(normalizeSkuCoverageWindows(inputs.coverageWindows)) !== JSON.stringify(normalizeSkuCoverageWindows(oliWindows))) return { ...out, read: "inputs-inconsistent" };
  out.serveToken = computeSkuServeToken({ effectiveAsOf, coverageWindows: inputs.coverageWindows, catalogPayloadSha: catalogSnapshot && catalogSnapshot.payload_sha, opunits: inputs.opunits, brand: skuServeCanonicalBrand(brand) });
  return out;
}

function build(deps = {}) {
  const { sb, pgReadOnly, directory, orgFp, connectionId = "primary", now = () => Date.now(), log = () => {}, liveContracts = null } = deps || {};
  if (typeof pgReadOnly !== "function") throw new Error("sku-movement route: deps.pgReadOnly (the read-only pg query) is required (fail closed).");
  const missing = REQUIRED_READERS.filter((n) => !sb || typeof sb[n] !== "function");
  if (missing.length) throw new Error("sku-movement route: the read-only supabase facade lacks " + missing.join(",") + " (fail closed).");
  if (!(directory instanceof Map)) throw new Error("sku-movement route: deps.directory (the durable account directory Map) is required (fail closed).");
  if (!nb(orgFp)) throw new Error("sku-movement route: deps.orgFp is required (fail closed).");
  if (connectionId !== "primary") throw new Error("sku-movement route: only the primary connection is supported (fail closed).");
  const selectors = deps.selectors && typeof deps.selectors.selectLatestForScope === "function" ? deps.selectors : { selectLatestForScope };
  const contract = liveContracts && liveContracts[SKU_MOVEMENT_PUBLISHER_KEY];
  const liveVersion = contract && nb(contract.liveReportVersion) ? S(contract.liveReportVersion) : SKU_MOVEMENT_LIVE_VERSION;
  // The resolver's marketplace authority is the SAME durable directory the token's marketplace comes from.
  const directoryRows = [...directory.values()].map((m) => ({ accountId: S(m && m.accountId), country: S(m && m.country) }));
  // Which serve the served selector models (see SERVED ROW above): read ONCE, from the injected env else process.env.
  const serveTokenAttested = skuServeTokenAttested(deps.env && typeof deps.env === "object" ? deps.env : process.env);
  if (!serveTokenAttested) log("sku-movement: " + SKU_MOVEMENT_SERVE_TOKEN_ATTESTED_ENV + " is not exactly 'true' -- every LIVE sku-movement write is DEFERRED ('" + SKU_MOVEMENT_ROUTE_NOT_ACTIVATED + "', zero writes); dry-run / verify-exact are unaffected");

  // ---- L1: the worker route's metadata SQL + compose, over the read-only pg client ----------------------------------
  // `at` pins the effectiveAsOf ceiling's clock (a caller comparing against another read taken at the same instant).
  async function readL1(accountIds, { organizationFingerprint = null, dir = null, at = null } = {}) {
    if (nb(organizationFingerprint) && S(organizationFingerprint) !== S(orgFp)) throw new Error("organization fingerprint mismatch (fail closed)");
    return readSkuMovementScopeEvidence(pgReadOnly, { organizationFingerprint: orgFp, connectionId, accountIds, now: at == null ? now() : at, directory: dir instanceof Map ? dir : directory });
  }

  // PURE: the reconciler revision of one account's composed L1 evidence.
  function computeRevision({ accountId, evidence } = {}) {
    const ev = evidence;
    if (!ev || typeof ev !== "object" || S(ev.accountId) !== S(accountId) || !nb(ev.token)) return { eligible: false, reason: "evidence-missing", status: "ineligible" };
    if (ev.ineligibleReason) return { eligible: false, reason: S(ev.ineligibleReason), status: "ineligible" };
    return { eligible: true, revisionId: S(ev.token), evidenceToken: S(ev.token), deps: [S(ev.catalog.sourceRequestHash)], contentDeps: [S(ev.token)], status: "available" };
  }

  // ---- the ONE hydrated evidence load per (account, L1 token) -------------------------------------------------------
  let catalogMemo = null; // { path, promise } -- the org catalog payload, hydrated once per content-addressed path
  const readersFor = (signal) => ({
    readOliHistory: (a) => sb.getSourceOliHistoryRows({ ...a, signal }),
    readOliCoverage: (a) => sb.getSourceCoverageWindows({ ...a, signal }),
    readCatalogSnapshot: (a) => sb.getSourceSnapshot({ ...a, signal }),
    loadCatalogPayload: (path) => {
      if (catalogMemo && catalogMemo.path === path) return catalogMemo.promise;
      const promise = Promise.resolve().then(() => sb.getSourceSnapshotPayload(path, { signal }));
      const entry = { path, promise };
      catalogMemo = entry;
      promise.catch(() => { if (catalogMemo === entry) catalogMemo = null; });
      return promise;
    },
    readOliOperationalUnits: (a) => sb.getSourceOliOperationalUnitRows({ ...a, signal }),
    readOliSkuAsinResolution: (a) => sb.getOliSkuAsinResolutionRows({ ...a, signal }),
    readDirectory: async () => directoryRows,
  });
  const heavyMemo = new Map(); // key -> Promise<{ ok, evidence, manifestToken } | { ok:false, reason }>
  function heavyFor(owner, ev, signal) {
    const key = owner + "\n" + S(ev.token);
    const hit = heavyMemo.get(key);
    if (hit) { heavyMemo.delete(key); heavyMemo.set(key, hit); return hit; }
    const p = (async () => {
      let e;
      try { e = await loadSkuMovementAccountEvidence({ accountId: owner, organizationFingerprint: orgFp, connectionId, ceiling: ev.ceiling }, readersFor(signal), { strict: true }); }
      catch (_e) { return { ok: false, reason: "evidence-read-failed:load" }; }
      if (!e || e.notReady) return { ok: false, reason: S(e && e.notReady) || "not-ready" };
      const manifestToken = computeSkuManifestToken({ accountId: owner, effectiveAsOf: e.effectiveAsOf, coverageFrom: e.coverageFrom, historyRows: e.historyRows, catalogRows: e.catalogRows });
      return { ok: true, evidence: e, manifestToken };
    })();
    heavyMemo.set(key, p);
    while (heavyMemo.size > HEAVY_MEMO_MAX) heavyMemo.delete(heavyMemo.keys().next().value);
    // Only a SUCCESSFUL load is memoised: a failed / not-ready one is retried by the next unit.
    p.then((r) => { if (!(r && r.ok) && heavyMemo.get(key) === p) heavyMemo.delete(key); });
    return p;
  }

  // ---- the VERIFIED brand list of the exact live brand-view-brands row ----------------------------------------------
  async function readVerifiedBrandList(accountId, meta, signal) {
    if (!meta) return { ok: false, reason: "brand-list-unavailable" };
    let rows;
    try { rows = await pgReadOnly(SKU_BRAND_LIST_SQL, [accountId, brandViewBrandsLiveHash(accountId)]); }
    catch (_e) { return { ok: false, reason: "brand-list-read-failed" }; }
    const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
    if (!row) return { ok: false, reason: "brand-list-unavailable" };
    if (S(row.params_hash) !== S(meta.paramsHash) || textOrNull(row.source_refreshed_at) !== meta.sourceRefreshedAt || textOrNull(row.updated_at) !== meta.updatedAt) return { ok: false, reason: "brand-list-advanced" };
    let accountOf = row.payload_account_id;
    let brands = row.brands;
    if (brands == null && nb(row.payload_storage_path)) {
      let payload = null;
      try { payload = await sb.getReportSnapshotStoragePayload(S(row.payload_storage_path), { signal }); } catch (_e) { payload = null; }
      if (!payload || typeof payload !== "object") return { ok: false, reason: "brand-list-unavailable" };
      accountOf = payload.accountId;
      brands = payload.brands;
    }
    if (S(accountOf) !== S(accountId)) return { ok: false, reason: "brand-list-invalid" };
    if (!Array.isArray(brands) || new Set(brands).size !== brands.length || !brands.every((b) => typeof b === "string" && nb(b) && skuMovementCanonicalBrand(b) === b)) return { ok: false, reason: "brand-list-invalid" };
    return { ok: true, brands: brands.slice() };
  }

  // ---- the runtime hooks --------------------------------------------------------------------------------------------
  async function readScopeEvidence({ scope, directory: dir = null, organizationFingerprint = null } = {}) {
    try {
      const perAccount = await readL1(Array.isArray(scope) ? scope : [], { organizationFingerprint, dir });
      return { ok: true, perAccount };
    } catch (e) {
      log("sku-movement evidence read failed: " + S(e && e.message).replace(/[^\x20-\x7e]/g, "").slice(0, 160));
      return { ok: false, failCode: "DURABLE_SOURCE_UNREADABLE: sku-movement-evidence-read-failed" };
    }
  }

  async function expandUnits({ accountId, evidence, signal = null } = {}) {
    const acct = S(accountId);
    const ev = evidence;
    if (!ev || S(ev.accountId) !== acct || !isDate(ev.effectiveAsOf)) throw new Error("sku-movement expandUnits: the account evidence is missing (fail closed)");
    const base = (targetId) => ({ targetId, liveAccountId: acct, ownerAccountIds: [acct], targetAsOf: ev.effectiveAsOf, reportKeys: [SKU_MOVEMENT_PUBLISHER_KEY] });
    const units = [{ unitKey: SKU_ALL_UNIT_KEY, ...base(skuMovementTargetId(acct, "ALL")) }];
    const marker = (reason) => ({
      unitKey: SKU_BRAND_LIST_UNIT_KEY, ...base(SKU_BRAND_LIST_MARKER_PREFIX + acct),
      deferred: { state: SKU_BRAND_LIST_PROVENANCE_REASONS.includes(reason) ? RECONCILE_STATUS.DEFERRED_PROVENANCE : RECONCILE_STATUS.DEFERRED_DEPENDENCY, reason },
    });
    const list = await readVerifiedBrandList(acct, ev.brands, signal);
    if (!list.ok) return [...units, marker(list.reason)];
    // The brand string EXACTLY as the verified row lists it (the UI's brand param). "ALL" is the All-Brands unit itself.
    // A brand whose target id the reconciler cannot carry (> MAX_UNIT_TARGET_ID_CHARS) is never silently dropped: the
    // account keeps a typed marker so its job is never counted verified.
    let unrepresentable = 0;
    for (const brand of list.brands) {
      if (brand === "ALL") continue;
      const targetId = skuMovementTargetId(acct, brand);
      if (!targetId || targetId.length > MAX_UNIT_TARGET_ID_CHARS) { unrepresentable += 1; continue; }
      units.push({ unitKey: skuMovementUnitKey(brand), ...base(targetId) });
    }
    if (unrepresentable > 0) units.push(marker("brand-target-unrepresentable"));
    return units;
  }

  async function resolveBundle(unit, { signal = null } = {}) {
    const u = parseSkuMovementUnit(unit);
    if (!u) return { eligible: false, reason: "unit-target-invalid" };
    let l1;
    try { l1 = await readL1([u.owner]); } catch (_e) { return { eligible: false, reason: "evidence-read-failed:l1" }; }
    const ev = l1.get(u.owner);
    const rev = computeRevision({ accountId: u.owner, evidence: ev });
    if (rev.eligible !== true) return { eligible: false, reason: rev.reason };
    const heavy = await heavyFor(u.owner, ev, signal);
    if (!heavy || heavy.ok !== true) return { eligible: false, reason: S(heavy && heavy.reason) || "not-ready" };
    const e = heavy.evidence;
    const cs = e.catalogSnapshot || {};
    // The hydrated evidence must be the SAME evidence the L1 token was composed from (else a concurrent write landed
    // between the reads: typed, retried -- never a token paired with other content). When the hydrated coverage read
    // carries each window's updated_at too (the WP10-extended getSourceCoverageWindows), those stamps must equal the
    // L1's (canonical-instant comparison: the REST '+00:00' and the SQL 'Z' renderings of one timestamptz agree).
    const l1Windows = JSON.stringify(ev.windows.map((w) => [w.from, w.to]));
    const hydratedStamped = Array.isArray(e.coverageWindows) && e.coverageWindows.length > 0 && e.coverageWindows.every((w) => w && (w.updatedAt != null || w.updated_at != null));
    if (e.effectiveAsOf !== ev.effectiveAsOf || S(e.coverageFrom) !== S(ev.coverageFrom)
      || JSON.stringify(normalizeSkuCoverageWindows(e.coverageWindows)) !== l1Windows
      || (hydratedStamped && JSON.stringify(normalizeSkuServeWindows(e.coverageWindows)) !== JSON.stringify(normalizeSkuServeWindows(ev.windows)))
      || S(cs.payload_sha) !== S(ev.catalog.payloadSha) || S(cs.source_request_hash) !== S(ev.catalog.sourceRequestHash)) {
      return { eligible: false, reason: "evidence-inconsistent" };
    }
    // The STORED serve token is computed from the SAME metadata the L1 evidence token was composed from (the coverage
    // windows + their updated_at, the catalog payload_sha, the operational-units count + max(updated_at) over
    // [monthBack(effAsOf, 3), effAsOf]) -- exactly the inputs the WP10 serve reads (THE SERVE-SIDE CONTRACT).
    const serveToken = computeSkuServeToken({ effectiveAsOf: ev.effectiveAsOf, coverageWindows: ev.windows, catalogPayloadSha: ev.catalog.payloadSha, opunits: ev.opunits, brand: u.brand });
    if (!serveToken) return { eligible: false, reason: "serve-token-underivable" };
    return {
      eligible: true, revisionId: rev.revisionId, evidenceToken: rev.evidenceToken, manifestToken: heavy.manifestToken, serveToken,
      deps: rev.deps.slice(), bundle: Object.freeze({ accountId: u.owner, brand: u.brand, evidence: e }),
    };
  }

  // THE ACTIVATION GATE (publication recovery WP13 verifier P2-2; README section 5 / 9.2: "the route CLI refuses the live
  // write itself" until the owner attests the DEPLOYED WP10 serve). Unattested, a route row (stamped cycle.created_at)
  // fails the LEGACY serve predicate, so publishing it would only push every page GET into a slow read-only re-derive.
  // The generic release calls derive ONLY from the LIVE prepare (the scan and --verify-exact never do), BEFORE the first
  // cycle / job / shadow write -> an unattested live run defers each unit ('derive-not-ready:<gate>') with ZERO writes and
  // stays a DEFERRAL (the scheduler job stays green; nothing is counted published). publishGuard below closes the resume
  // path (an already-prepared shadow skips derive) with ZERO CAS. Dry-run / verify-exact are unaffected.
  async function derive(bundle) {
    if (!serveTokenAttested) return { notReady: true, reason: SKU_MOVEMENT_ROUTE_NOT_ACTIVATED };
    if (!bundle || !bundle.evidence || !nb(bundle.accountId)) return { notReady: true, reason: "bundle-missing" };
    const out = buildSkuMovementUnit(bundle.evidence, bundle.brand, { accountId: bundle.accountId });
    return { payload: out.payload, latestDataDate: out.latestDataDate };
  }

  // The shadow identity: the owner (the contract's liveAccountId + gate account + targetIdentity input), the honest
  // effectiveAsOf and the EXACT brand.
  const identityParams = (unit, { bundle } = {}) => ({ ownerAccountId: S(bundle.accountId), asOf: S(bundle.evidence.effectiveAsOf), brand: S(bundle.brand) });
  const identityAsOf = (unit, { bundle } = {}) => S(bundle && bundle.evidence && bundle.evidence.effectiveAsOf);

  // The WP10 serve's token inputs (THE SERVE-SIDE CONTRACT (1)+(4)), read through the route's own read-only L1
  // statements (the SAME source_coverage / source_oli_operational_units rows the serve reads over REST; the canonical-
  // instant digest makes the two renderings agree). Only an L1 at the probe's effectiveAsOf is usable.
  async function readServeTokenInputs({ accountId, effectiveAsOf }, at) {
    const l1 = await readL1([accountId], { at });
    const ev = l1.get(accountId);
    if (!ev || ev.effectiveAsOf !== effectiveAsOf || !ev.opunits) return { read: "inconsistent" };
    return { read: "ok", coverageWindows: ev.windows, opunits: ev.opunits };
  }

  async function servedSelector(unit, { signal = null } = {}) {
    const u = parseSkuMovementUnit(unit);
    if (!u) return { row: null, reason: "unit-target-invalid", via: null };
    let captured = null;
    const readers = { getLatestReportSnapshotForScope: async (args) => { const r = await sb.getLatestReportSnapshotForScope(args); captured = r || null; return r; } };
    const sel = await selectors.selectLatestForScope({ reportKey: SKU_MOVEMENT_LIVE_REPORT_KEY, accountId: u.owner, reportVersion: liveVersion, scope: { brand: u.brand }, readers });
    if (!sel || !sel.row) return sel;
    const at = now();
    let probe;
    try {
      probe = await skuServeFreshnessProbe({
        sb, readServeTokenInputs: serveTokenAttested ? (a) => readServeTokenInputs(a, at) : null,
        organizationFingerprint: orgFp, connectionId, accountId: u.owner, brand: u.brand, ceiling: skuMovementEvidenceCeiling(at), signal,
      });
    } catch (_e) { return { row: null, reason: "read-failed", via: sel.via }; }
    if (!probe || probe.read !== "ok") return { row: null, reason: "read-failed", via: sel.via };
    const current = serveTokenAttested
      ? skuMovementStoredIsCurrent({ stored: captured, effectiveAsOf: probe.effectiveAsOf, serveToken: probe.serveToken, legacyProvenance: probe.legacyProvenance })
      : skuMovementLegacyStoredIsCurrent({ stored: captured, effectiveAsOf: probe.effectiveAsOf, legacyProvenance: probe.legacyProvenance });
    if (current) return sel;
    const out = { row: null, reason: "serve-rederives", via: sel.via, heldBy: sel.row };
    // ATTESTED only: the held row is a ROUTE row (it carries a serveToken) at the serve's effectiveAsOf whose token is
    // not the one this route computes NOW (a retired 'sms1:' token, or one from before the evidence moved) --
    // republishing through the fenced path writes the current token, so servedVerdict may call it fixable.
    const sp = captured && captured.params && typeof captured.params === "object" ? captured.params : null;
    if (serveTokenAttested && sp && sp.serveToken !== undefined && probe.serveToken && captured.payload && captured.payload.effectiveAsOf === probe.effectiveAsOf && sp.serveToken !== probe.serveToken) out.storedTokenStale = true;
    return out;
  }

  // The served-row verdict: defaultServedVerdict, plus ONE fixable case it cannot see -- the serve re-derives because
  // the route's OWN expected canonical row (heldBy IS the expected identity, stamp included) carries a stale serve
  // token (storedTokenStale, attested only). Re-publishing fixes exactly that; after it the stored token equals the
  // route's token, so this can never loop. Every other re-derive (the legacy serve, another as-of, another row) stays
  // the default's NON-fixable 'serve-rederives' (typed deferral + alert).
  function servedVerdict(served, expected) {
    const h = served && !served.row && served.reason === "serve-rederives" && served.storedTokenStale === true ? served.heldBy : null;
    const e = expected && typeof expected === "object" ? expected : {};
    if (h && nb(e.source_refreshed_at) && ["report_key", "account_id", "params_hash", "source_refreshed_at"].every((k) => S(h[k]) === S(e[k]))) {
      return { ok: false, fixable: true, reason: "serve-token-stale" };
    }
    return defaultServedVerdict(served, expected);
  }

  // The CURRENT L1 token of a unit's account (publish-time 'evidence-advanced' check). "" when unreadable / ineligible.
  async function readEvidenceToken(unit) {
    const owner = S(unit && unit.liveAccountId);
    if (!nb(owner)) return "";
    const l1 = await readL1([owner]);
    const rev = computeRevision({ accountId: owner, evidence: l1.get(owner) });
    return rev.eligible === true ? S(rev.evidenceToken) : "";
  }

  // The activation gate at PUBLISH time (inside the control lease, immediately before the fenced CAS): a resumed prepare
  // (an earlier attested run's shadow) never publishes while the serve attestation is absent. ZERO CAS; a deferral.
  async function publishGuard() {
    return serveTokenAttested ? null : { state: "DEFERRED_DEPENDENCY", reason: SKU_MOVEMENT_ROUTE_NOT_ACTIVATED };
  }

  return Object.freeze({ readScopeEvidence, computeRevision, expandUnits, resolveBundle, derive, identityParams, identityAsOf, servedSelector, servedVerdict, readEvidenceToken, publishGuard });
}

export default Object.freeze({ id: SKU_MOVEMENT_ROUTE_ID, publisherKey: SKU_MOVEMENT_PUBLISHER_KEY, stampPolicy: "cycle", build });
