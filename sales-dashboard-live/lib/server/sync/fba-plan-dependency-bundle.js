// Publication recovery WP7 -- the fba-plan DURABLE DEPENDENCY BUNDLE: everything the fba-plan derive needs, rebuilt
// from validated DURABLE evidence only -- never the paid acquisition path, never the 20-hour source-export cache, never a
// DataDoe export:
//   - FBA inventory: public.source_snapshots(fba-inventory-health, scope = account) -- the per-account rows the paid
//     fba job persisted from the SAME validated batch fragment its derive consumed (fba-durable-source-persist.js,
//     UNCHANGED), bound to the exact D-1 single-seller request identity;
//   - AWD: the durable canonical Listings pointer (public.source_listings_snapshot) -- the per-account isolated rows of
//     the ONE shared canonical Listings export fba-plan:awd and listing-health-v3:listings resolve to (identical request
//     hash, LISTINGS_CANONICAL_COLUMNS incl. the two awd_* fields);
//   - OLI sales + Product Catalog: the SAME strict durable loader the paid derive uses (makeFbaPlanDurableContextLoader),
//     fed the coverage windows + catalog pointer this bundle already proved (so the loader, the token and the manifest
//     all describe ONE read).
//
// FAIL CLOSED, TYPED (every refusal is { eligible:false, reason } -- LKG preserved, zero writes, NEVER an export):
//   fba-durable-missing (no pointer) | fba-snapshot-not-d1 (pointer for another day) | fba-pointer-integrity:<why>
//   (org / connection / source / scope (cross-account) / sha / object path / row_count / validated_at, the checks of
//   listing-health-v3-dependency-bundle.js:237-256) | fba-rows-invalid:<code> / fba-rows-cross-account (rows) |
//   oli-coverage-short (provenTo < salesAsOf) | sales-asof-unresolved | catalog-durable-missing / -integrity |
//   awd-durable-missing / awd-durable-stale / awd-pointer-integrity / awd-rows-invalid (US: AWD is a HARD requirement) |
//   awd-regression-guard (EU5 durable AWD missing while the SERVED row or the exact live row at {to: salesAsOf} shows
//   awdAvailable:true -- never regress paid AWD to "no AWD"; ':served-unreadable' when the served slot is anything but
//   a readable row or a true 'missing') | durable-oli-unavailable / durable-catalog-unavailable (the strict loader
//   refused) | raw-seller-mismatch | the FILL-ONLY verdicts (below): superseded-newer-live:served-newer-to /
//   :paid-owned / :served-newer-inventory / :served-newer-awd / :paid-publish-pending:to|inventory|awd |
//   :paid-publish-refused-by-route-stamp (ALERT) | paid-job-in-flight | paid-job-stale-in-flight |
//   paid-cycle-open:<bucket> | paid-cycle-stale-open:<bucket> |
//   inventory-guard:served-unreadable / :live-unreadable / :paid-lineage-unreadable / :paid-cycle-unreadable (a guard
//   read failed) | inventory-guard:fetch-unordered / :awd-fetch-unordered / :sales-asof-unordered (a row whose
//   ordering instant / day is unknowable).
// A MISSING pointer is never a zero-inventory payload; a VALID empty pointer (row_count 0) is honest empty evidence, the
// SAME as the paid path (inventoryAvailable:false publishes).
//
// FILL-ONLY (WP7 round 4 -- the orchestrator's design decision after three verification rounds each reproduced a race
// in which NEWER PAID data was lost / regressed: the route and the ACTIVE paid publisher write the SAME live key through
// the same latest-job-promoting publisher). The PAID path is authoritative by construction; the route only FILLS a D-1
// the paid path has not published, and may replace only a row IT wrote:
//   1. OWNERSHIP: a live fba-plan row is ROUTE-WRITTEN iff its stored params carry this route's evidence token (the
//      FBA_PLAN_TOKEN_PREFIX version) AND its manifest token -- the 'fba-plan' live contract stores exactly those two as
//      liveParamsExtra (report-publisher.js pickExtra("evidenceToken", "manifestToken")); the SHADOW's route / rev
//      params are never copied to the live row, so they cannot be the live-row test. Anything else (paid, legacy,
//      refresh=1, an older route token version) is PAID-OWNED and is NEVER replaced: a paid-owned row at the exact
//      identity {to: salesAsOf} is either content-equivalent (current, zero writes -- the release's predicate) or
//      'superseded-newer-live:paid-owned' (zero writes). Never a CAS over it.
//   2. FILL: the route creates the live row for {to: salesAsOf} only when (a) no exact row exists there (or it is
//      route-written: 3.), (b) the SERVED row's sales as-of (max of params.to / payload.asOf) is STRICTLY older
//      ('superseded-newer-live:served-newer-to' otherwise; a row whose sales day is unknowable is
//      'inventory-guard:sales-asof-unordered'), (c) no readable served / exact row carries a newer inventory day / fetch
//      or AWD fetch (the component order below), and (d) no PAID fba-plan job can still publish at >= salesAsOf: the
//      NEWEST FOREIGN (non-route-lineage) job is read with its cycle; a validated one the publisher would still promote
//      (it IS the latest job, its shadow is not yet live at an equal-or-newer stamp) whose sales as-of >= salesAsOf is
//      'superseded-newer-live:paid-publish-pending:to', an older-to one is ordered per component
//      (':paid-publish-pending:inventory|awd'; an older pending shadow never blocks); one still IN FLIGHT on the current
//      epoch (cycle_date >= epoch; its content is not derived yet) is 'paid-job-in-flight' (retryable, deliberately NOT
//      /newer-live/), and after 6 h 'paid-job-stale-in-flight' (retryable + ALERT: a stuck paid cycle); an in-flight job
//      of an OLDER cycle_date (it can only carry an older inventory day) and a validated job that is no longer the
//      latest (the publisher never promotes it) do not block; and (e) no PAID CYCLE that can still produce an fba-plan
//      job for this account is OPEN (pending / running): a paid fba-plan operation opens its cycle before its job
//      exists (runReportJobs upserts every planned job after the dispatch's first source round -- SECONDS later on a
//      cache-hit re-run), so an open paid cycle is the paid path's publication in progress ('paid-cycle-open:<bucket>',
//      retryable). This closes the window the job-level read cannot see (a paid cycle opened, its job not inserted
//      yet) and narrows the raced insert to a paid cycle that opens in the ~sub-second after the route's last check
//      AND lands its job in the ~1-RTT gap between the generic release's final latest-job re-read and its job upsert
//      (the release's publishGuard post-insert check is the backstop). A cycle is ACTIVE while its last activity (the
//      cycle row, its source jobs, its report jobs) is within FBA_PLAN_PAID_CYCLE_ACTIVE_MS (6 h); an idle open cycle on the CURRENT
//      epoch is 'paid-cycle-stale-open:<bucket>' (retryable + ALERT: a stuck paid cycle; it stops blocking when the
//      epoch rolls past it or a reaper closes it -- never forever), an idle open cycle of an OLDER epoch never blocks.
//      The exact paid bucket set is the release's (fba-plan.release.js fbaPlanPaidCycleBuckets); and (f) no validated
//      paid shadow was REFUSED BY A ROUTE STAMP. STAMP INVERSION (round-4 verifier P2): a route row is stamped with the
//      durable pointer's validated_at -- the PERSIST instant, AFTER the paid fetch it holds -- so a later PAID publish
//      of the SAME D-1 built from CACHED fetches (a DSC re-sync, a bootstrap wave, a natural cycle hitting the 20 h
//      source-export cache: its shadow is stamped at the cached fetch) is OLDER than the route row: the fenced CAS
//      refuses it 'newer-live' (and the paid operation counts that as success). The route must then never re-derive
//      over that paid shadow (its next job would make the shadow unpromotable forever): a validated LATEST foreign job
//      whose live identity holds a ROUTE-written row stamped at or after its shadow, with DIFFERENT (masked) content, is
//      the 'refused' paid slot -> 'superseded-newer-live:paid-publish-refused-by-route-stamp' (an ALERT: paid content
//      the page does not show). It is released ONLY when the route can SERVE exactly that content: its evidence instant
//      is strictly newer than the route row (it can replace its own row) AND its derive is content-equivalent to the
//      refused shadow (e.g. the paid operation's durable persist re-recorded the same fetch later) -- convergence, the
//      paid content goes live. Anything else stays refused (never an 'evidence-instant-not-advanced' benign deferral,
//      never a route-over-route over newer paid content). A COMPLETE fix is outside this module (the owner note in
//      fba-plan.release.js): record the paid fetch instant durably and stamp route rows below it, or have the paid
//      operation treat 'newer-live' against a route-owned row as not-success.
//   3. ROUTE-OVER-ROUTE: a route-written exact row is replaced (through the fenced CAS, stamp-ordered) when the durable
//      evidence moved, subject to the same component ordering.
//   COMPONENT ORDER (never go backwards): FBA inventory and AWD are the two inputs the PAID job fetches itself, ordered
//   against every readable live row this publish could displace or be hidden behind (the SERVED row + the exact row): a
//   row whose inventory DAY (max of payload.inventoryRequestedThrough / payload.inventoryDate) is later than this
//   bundle's inventoryAsOf, or the SAME day fetched strictly AFTER this bundle's FBA pointer was validated
//   (payload.inventoryFetchedAt > validated_at), is 'served-newer-inventory'; with durable AWD in use, a row that HOLDS
//   AWD fetched later than the Listings pointer's validated_at is 'served-newer-awd'. Fetch instants are parsed ONLY as
//   offset-bearing timestamps (offsetInstantMs); a same-day row whose fetch stamp is missing / naive / unparseable is
//   bounded by the row's own source_refreshed_at, and a row with neither is UNORDERED ('inventory-guard:fetch-unordered',
//   fail closed, never "older").
// ONE pure verdict (fbaPlanLiveGuard) is applied by resolve (the predicate in 'report' mode + both prepare reads, before
// any payload hydration) AND by the release's publishGuard INSIDE the control lease immediately before the fenced CAS
// (fresh reads). ZERO writes on every refusal.
//
// UK -> GB: every marketplace comparison goes through normalizeMarketplace (the directory says "UK", durable rows and
// the Listings pointer say "GB"). The request-identity + row validators MIRROR resolvedFbaSnapshot /
// validateFbaSnapshotRows (source-bucket-sync.js) EXACTLY -- the route CLI's static import closure may not reach the
// sync runtime module that holds them (scripts/route-cli-closure.test.js C2); the mirrors are pinned identical by
// scripts/fba-plan-zero-export-route.test.js. Every read is injected + AbortSignal-threaded. 7-bit ASCII, LF.

import { createHash } from "node:crypto";
import { makeFbaPlanDurableContextLoader } from "./fba-plan-durable-loader.js";
import { validateListingsPointer } from "./listing-health-v3-dependency-bundle.js";
import { assertNoDuplicatePerAccountReadIdentities } from "./listing-health-v3-materialize.js";
import { REPORT_SOURCE_CONTRACTS } from "./report-source-contracts.js";
import { FBA_INVENTORY_SOURCE_KEY, LISTINGS_SOURCE_KEY, CATALOG_SOURCE_KEY, ORGANIZATION_SCOPE_KEY } from "./source-durable-model.js";
import { normalizeMarketplace } from "./oli-sales-estimate.js";
import { stableJson } from "./publication-binding.js";
import { sourceContractForKey } from "../source-contracts.js";
import { sourceRequestIdentity } from "../source-identity.js";
import { isValidRfc3339Timestamp } from "../rfc3339-timestamp.js";
import { awdCapableMarketplace, awdRequiredForMarketplace } from "../reports/awd-capability.js";
import { FBA_PLAN_TOKEN_PREFIX, isoMs, offsetInstantMs } from "../recovery/routes/fba-plan.route.js";

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";
const sha256 = (v) => createHash("sha256").update(String(v)).digest("hex");
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v) => typeof v === "string" && DATE_RE.test(v) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;
const isCount = (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const rowsOf = (payload) => (Array.isArray(payload) ? payload : (payload && Array.isArray(payload.rows) ? payload.rows : null));

export const FBA_PLAN_INVENTORY_REQUEST_KEY = "fba-plan:inventory-health";
export const FBA_PLAN_AWD_REQUEST_KEY = "fba-plan:awd";
export const FBA_PLAN_MANIFEST_PREFIX = "fpm1:";
// The two payload fields the paid path stamps from the source-cache fetch time and the durable path from the pointer's
// validated_at (report-derivation.js fba-plan derive). Content equivalence ignores EXACTLY these.
export const FBA_PLAN_FETCH_STAMP_KEYS = Object.freeze(["inventoryFetchedAt", "awdFetchedAt"]);
// The two top-level DISPLAY LABELS the derive copies verbatim from the account directory (context.accountName /
// context.marketCountry). The route reads them from the DURABLE directory snapshot, the paid job from its DataDoe accounts
// GET; the route's content verdict masks them (fbaPlanRouteContentVerdict) -- see there.
export const FBA_PLAN_DIRECTORY_LABEL_KEYS = Object.freeze(["accountName", "marketCountry"]);
export const AWD_REQUIRED_COLUMNS = Object.freeze(["awd_available_distributable_quantity", "awd_total_inbound_quantity"]);
// The FILL-ONLY verdicts (see the header). The two in-flight deferrals are RETRYABLE and deliberately NOT /newer-live/
// (the worker's superseded class is terminal for the token; a paid run that later fails must not strand the repair);
// the stale one is additionally an ALERT (a paid cycle stuck 'running' on the current epoch for > 6 h).
export const FBA_PLAN_PAID_IN_FLIGHT = "paid-job-in-flight";
export const FBA_PLAN_PAID_STALE_IN_FLIGHT = "paid-job-stale-in-flight";
export const FBA_PLAN_STALE_IN_FLIGHT_MS = 6 * 60 * 60 * 1000;
export const FBA_PLAN_SERVED_NEWER_TO = "superseded-newer-live:served-newer-to";
export const FBA_PLAN_PAID_OWNED = "superseded-newer-live:paid-owned";
export const FBA_PLAN_PAID_PENDING_TO = "superseded-newer-live:paid-publish-pending:to";
// The route's post-insert check (the release's publishGuard): a FOREIGN job that appeared after the prepare's resolve
// (i.e. inside the residual window between the generic release's last latest-job re-read and its job insert). Retryable.
export const FBA_PLAN_PAID_RACED_INSERT = "paid-job-raced-insert";
// FILL-ONLY (f): a validated paid shadow the fenced CAS refused because a ROUTE row is stamped at / after it (STAMP
// INVERSION, see the header) -- an ALERT reason (paid content not served), deliberately distinct from every benign one.
export const FBA_PLAN_PAID_REFUSED_BY_ROUTE_STAMP = "superseded-newer-live:paid-publish-refused-by-route-stamp";
// FILL-ONLY (e): an OPEN paid cycle that can still produce an fba-plan job (retryable), and the same cycle idle for
// longer than the activity window on the current epoch (retryable + ALERT; bounded by the epoch roll).
export const FBA_PLAN_PAID_CYCLE_OPEN = "paid-cycle-open";
export const FBA_PLAN_PAID_CYCLE_STALE_OPEN = "paid-cycle-stale-open";
export const FBA_PLAN_PAID_CYCLE_ACTIVE_MS = 6 * 60 * 60 * 1000;

// ---- mirrors of source-bucket-sync.js (pinned identical by the WP7 test) -------------------------------------------

/**
 * The per-seller FBA inventory snapshot request hash for [asOf .. asOf] -- EXACTLY resolvedFbaSnapshot(...).requestHash
 * (the identity fba-durable-source-persist.js records as source_request_hash and the FBA reconciler recomputes).
 */
export function fbaSnapshotRequestHash({ apiKey, rawSellerId, asOf }) {
  if (!isDate(S(asOf))) throw new Error("fbaSnapshotRequestHash requires a YYYY-MM-DD asOf (fail closed).");
  if (!nb(rawSellerId)) throw new Error("fbaSnapshotRequestHash requires the raw seller id (fail closed).");
  const c = (REPORT_SOURCE_CONTRACTS["fba-plan"] || []).find((x) => x.requestKey === FBA_PLAN_INVENTORY_REQUEST_KEY);
  if (!c) throw new Error("fbaSnapshotRequestHash: the fba-plan:inventory-health contract is missing (fail closed).");
  const sourceId = sourceContractForKey(FBA_INVENTORY_SOURCE_KEY).ids[0];
  const options = { groupBy: c.groupBy || undefined, aggregations: c.aggregations || undefined, orderByColumn: c.orderByColumn, orderByDirection: c.orderByDirection };
  return sourceRequestIdentity({ apiKey, sourceId, columns: c.columns, ids: [rawSellerId], from: asOf, to: asOf, limit: c.limit, options }).requestHash;
}

/** validateFbaSnapshotRows (source-bucket-sync.js) verbatim: every non-empty row carries EXACTLY the marketplace. */
export function validateFbaDurableRows(rows, marketplaceCountry) {
  if (!Array.isArray(rows)) return { valid: false, code: "MALFORMED_PAYLOAD" };
  const want = String(marketplaceCountry || "").trim();
  if (!want) return { valid: false, code: "MARKETPLACE_CONSTRAINT_MISSING" };
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return { valid: false, code: "MALFORMED_PAYLOAD" };
    const nonEmpty = Object.values(row).some((v) => v != null && String(v).trim() !== "");
    if (!nonEmpty) continue;
    const got = String(row.marketplace_country_code ?? "").trim();
    if (!got) return { valid: false, code: "FBA_ROW_NO_MARKETPLACE" };
    if (got !== want) return { valid: false, code: "FBA_CROSS_MARKETPLACE" };
  }
  return { valid: true, code: null };
}

// ---- pointer integrity (PURE) -----------------------------------------------------------------------------------

/**
 * The FBA source_snapshots pointer integrity (listing-health-v3-dependency-bundle.js:237-256): the isolated org +
 * connection, the fba-inventory-health source, scope === THIS account (a cross-account pointer is refused), a nonblank
 * content sha embedded in a content-addressed object path equal to the recomputed namespace path, an ACTUAL safe
 * non-negative integer row_count (never a Number() coercion) and a real RFC3339 validated_at.
 */
export function validateFbaInventoryPointer({ pointer, organizationFingerprint, connectionId = "primary", accountId, expectedObjectPath }) {
  const fail = (reason) => ({ ok: false, reason });
  if (!pointer || typeof pointer !== "object") return fail("no-pointer");
  if (S(pointer.organization_fingerprint) !== S(organizationFingerprint) || !nb(organizationFingerprint)) return fail("org-mismatch");
  if (S(pointer.connection_id) !== S(connectionId) || (connectionId !== "primary" && connectionId !== "dd-secondary")) return fail("connection-mismatch");
  if (S(pointer.source_key) !== FBA_INVENTORY_SOURCE_KEY) return fail("source-key-mismatch");
  if (S(pointer.scope_key) !== S(accountId) || !nb(accountId)) return fail("cross-account-scope");
  const sha = S(pointer.payload_sha);
  if (!nb(sha)) return fail("payload-sha-blank");
  if (!S(pointer.object_path).endsWith("/" + sha + ".json")) return fail("path-sha-mismatch");
  if (S(pointer.object_path) !== S(expectedObjectPath)) return fail("path-namespace-mismatch");
  if (!isCount(pointer.row_count)) return fail("row-count-invalid");
  if (!isValidRfc3339Timestamp(pointer.validated_at)) return fail("validated-at-invalid");
  if (!nb(pointer.source_request_hash)) return fail("request-hash-blank");
  return { ok: true };
}

/** The org Product Catalog pointer integrity (source_snapshots product-catalog / __organization). */
export function validateCatalogPointer({ pointer, organizationFingerprint, connectionId = "primary", expectedObjectPath }) {
  const fail = (reason) => ({ ok: false, reason });
  if (!pointer || typeof pointer !== "object") return fail("no-pointer");
  if (S(pointer.organization_fingerprint) !== S(organizationFingerprint) || !nb(organizationFingerprint)) return fail("org-mismatch");
  if (S(pointer.connection_id) !== S(connectionId)) return fail("connection-mismatch");
  if (S(pointer.source_key) !== CATALOG_SOURCE_KEY || S(pointer.scope_key) !== ORGANIZATION_SCOPE_KEY) return fail("source-scope-mismatch");
  const sha = S(pointer.payload_sha);
  if (!nb(sha)) return fail("payload-sha-blank");
  if (!S(pointer.object_path).endsWith("/" + sha + ".json") || S(pointer.object_path) !== S(expectedObjectPath)) return fail("path-mismatch");
  if (!isCount(pointer.row_count)) return fail("row-count-invalid");
  if (!isValidRfc3339Timestamp(pointer.validated_at)) return fail("validated-at-invalid");
  return { ok: true };
}

/**
 * The durable canonical Listings (AWD) pointer: the SHARED listing-health-v3 validateListingsPointer (org / connection /
 * account / 2-letter marketplace === the account's CANONICAL marketplace / source / real as_of / validated_at / request
 * hash / sha / row_count / content-addressed path) PLUS as_of >= inventoryAsOf (a Listings label older than the FBA
 * snapshot day is not the evidence the paid path would have used).
 */
export function validateAwdListingsPointer({ pointer, organizationFingerprint, connectionId = "primary", accountId, marketplace, inventoryAsOf, expectedObjectPath }) {
  const v = validateListingsPointer({ snapshot: pointer, expectedOrg: organizationFingerprint, durableConn: connectionId, sourceKey: LISTINGS_SOURCE_KEY, accountId, marketplace, requestedAsOf: inventoryAsOf, expectedObjectPath });
  if (!v.ok) return v;
  if (!isDate(S(inventoryAsOf)) || S(pointer.as_of) < S(inventoryAsOf)) return { ok: false, reason: "as-of-before-inventory" };
  return { ok: true };
}

// ---- duplicate raw seller guard ---------------------------------------------------------------------------------

/**
 * The pan-EU ambiguity guard over the REGION's directory accounts [{ accountId, rawSellerId, marketplace }]: the shared
 * assertNoDuplicatePerAccountReadIdentities (a raw seller id shared by two accounts collapses their per-account read
 * identities) + the grouping that names the colliding accounts. EVERY account of a duplicated raw seller is ambiguous;
 * an unexplained guard throw marks the WHOLE region ambiguous (fail closed). -> Set<accountId>.
 */
export function ambiguousRawSellerAccounts({ accounts = [], connections = [] } = {}) {
  const list = (Array.isArray(accounts) ? accounts : []).filter((a) => a && nb(a.accountId));
  const groups = new Map();
  for (const a of list) { const k = S(a.rawSellerId); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(S(a.accountId)); }
  const out = new Set();
  for (const ids of groups.values()) if (ids.length > 1) for (const id of ids) out.add(id);
  let threw = false;
  try {
    assertNoDuplicatePerAccountReadIdentities({ v3Requests: list.map((a) => ({ owner: { accountId: S(a.accountId), rawSellerId: S(a.rawSellerId), connectionId: "primary", marketplace: S(a.marketplace) || null } })), connections });
  } catch { threw = true; }
  if (threw && out.size === 0) for (const a of list) out.add(S(a.accountId));
  return out;
}

// ---- metadata-level evaluation (PURE; the scan's computeRevision) ------------------------------------------------

/**
 * Evaluate ONE account's metadata evidence (fba-plan.route.js composeFbaPlanEvidence output) without any payload:
 * -> { ok:true, marketplace, awdCapable, awdRequired, awdUsable, awdReason, deps } | { ok:false, reason }.
 * Order: FBA missing -> not-D-1 -> FBA integrity -> sales as-of / OLI coverage -> catalog -> AWD (US hard, EU5 soft).
 */
export function evaluateFbaPlanEvidence(evidence, { apiKey, buildObjectPath, organizationFingerprint, connectionId = "primary" } = {}) {
  const e = evidence && typeof evidence === "object" ? evidence : null;
  const no = (reason) => ({ ok: false, reason });
  if (!e || !nb(e.accountId)) return no("evidence-missing");
  if (!isDate(S(e.inventoryAsOf))) return no("inventory-asof-invalid");
  if (!nb(e.rawSellerId) || !nb(e.country)) return no("directory-incomplete");
  if (typeof buildObjectPath !== "function") return no("object-path-builder-missing");
  const pathOf = (sourceKey, scopeKey, payloadSha) => { try { return S(buildObjectPath({ organizationFingerprint, connectionId, sourceKey, scopeKey, payloadSha })); } catch { return ""; } };
  if (e.duplicatePointer === true) return no("fba-pointer-integrity:duplicate-pointer");
  // 1. FBA inventory: present -> the exact D-1 single-seller identity -> integrity.
  const p = e.fbaPointer;
  if (!p) return no("fba-durable-missing");
  let expected = "";
  try { expected = S(fbaSnapshotRequestHash({ apiKey, rawSellerId: e.rawSellerId, asOf: e.inventoryAsOf })); } catch { expected = ""; }
  if (!nb(expected)) return no("fba-expected-hash-unresolved");
  if (S(p.source_request_hash) !== expected) return no("fba-snapshot-not-d1");
  const vf = validateFbaInventoryPointer({ pointer: p, organizationFingerprint, connectionId, accountId: e.accountId, expectedObjectPath: pathOf(FBA_INVENTORY_SOURCE_KEY, e.accountId, S(p.payload_sha)) });
  if (!vf.ok) return no("fba-pointer-integrity:" + vf.reason);
  // 2. The region sales as-of + THIS account's proven OLI coverage through it.
  if (!isDate(S(e.salesAsOf))) return no("sales-asof-unresolved");
  if (!isDate(S(e.provenTo)) || S(e.provenTo) < S(e.salesAsOf)) return no("oli-coverage-short");
  // 3. The org Product Catalog pointer.
  const c = e.catalogPointer;
  if (!c) return no("catalog-durable-missing");
  const vc = validateCatalogPointer({ pointer: c, organizationFingerprint, connectionId, expectedObjectPath: pathOf(CATALOG_SOURCE_KEY, ORGANIZATION_SCOPE_KEY, S(c.payload_sha)) });
  if (!vc.ok) return no("catalog-pointer-integrity:" + vc.reason);
  // 4. AWD: US + EU5 only (UK -> GB). US is a HARD requirement (missing / stale / corrupt -> defer); EU5 is soft (the
  //    bundle applies the served-row regression guard); AU / CA / IN never read AWD.
  const marketplace = normalizeMarketplace(e.country);
  const awdCapable = awdCapableMarketplace(marketplace);
  const awdRequired = awdRequiredForMarketplace(marketplace);
  let awdUsable = false;
  let awdReason = awdCapable ? null : "awd-not-applicable";
  if (awdCapable) {
    const a = e.awdPointer;
    if (!a) awdReason = "awd-durable-missing";
    else {
      const va = validateAwdListingsPointer({ pointer: a, organizationFingerprint, connectionId, accountId: e.accountId, marketplace, inventoryAsOf: e.inventoryAsOf, expectedObjectPath: pathOf(LISTINGS_SOURCE_KEY, e.accountId, S(a.payload_sha)) });
      if (va.ok) awdUsable = true;
      else awdReason = va.reason === "as-of-before-inventory" ? "awd-durable-stale" : "awd-pointer-integrity:" + va.reason;
    }
    if (!awdUsable && awdRequired) return no(awdReason);
  }
  const deps = [...new Set([S(p.source_request_hash), ...(awdUsable ? [S(e.awdPointer.source_request_hash)] : [])])].sort();
  return { ok: true, marketplace, awdCapable, awdRequired, awdUsable, awdReason, deps };
}

// ---- content equivalence ----------------------------------------------------------------------------------------

/**
 * The canonical content of an fba-plan payload: its STORED (JSON round-trip) form without the two fetch stamps (and,
 * with omitLabels, without the two directory display labels too).
 */
export function fbaPlanContentDigest(payload, { omitLabels = false } = {}) {
  if (!payload || typeof payload !== "object") return "";
  const p = JSON.parse(JSON.stringify(payload));
  for (const k of FBA_PLAN_FETCH_STAMP_KEYS) delete p[k];
  if (omitLabels) for (const k of FBA_PLAN_DIRECTORY_LABEL_KEYS) delete p[k];
  return stableJson(p);
}
/** The masked content identity of a refused paid shadow (stamps + directory labels masked): sha256 of the verdict form. */
export function fbaPlanRefusedPaidDigest(payload) {
  const d = fbaPlanContentDigest(payload, { omitLabels: true });
  return nb(d) ? sha256(d) : "";
}
/** stableJson(omit(a, stamps)) === stableJson(omit(b, stamps)) (both non-empty objects) -- the STRICT parity check. */
export function fbaPlanContentEqual(a, b) {
  const da = fbaPlanContentDigest(a);
  return nb(da) && da === fbaPlanContentDigest(b);
}

/**
 * THE ROUTE'S CONTENT VERDICT over (served payload, durable derive): equal iff their stored forms agree with the two
 * fetch stamps AND the two directory display labels (accountName / marketCountry) masked; labelDrift names the masked
 * labels that differ (the caller logs it). WHY the labels are masked (never compared, never stamped):
 *   - they are directory LABELS, not evidence: the route reads the durable account-directory snapshot, the paid job its
 *     DataDoe accounts GET, so a label-only drift (a rename not yet in one of them) would otherwise flip-flop the served
 *     row between the two writers every pass -- or, since no evidence instant moved, defer NEWER_LIVE
 *     'evidence-not-newer-than-live' forever. Masked, a label-only drift is current (zero writes, logged);
 *   - the directory exposes NO timestamp to stamp (getAccountDirectorySnapshotAccounts returns the accounts only; a
 *     buildDurableDirectory entry carries none), and stamping a directory WRITE instant would claim a data freshness
 *     the row does not have -- the fenced live CAS would then refuse a later, genuinely newer PAID publish (newer-live).
 * So every content input the verdict compares is stamped evidence (FBA / AWD validated_at, OLI coverage refresh, catalog
 * validated_at) whose instant advances with it (the stampPolicy 'evidence' contract). The derived semantics of the
 * country (isUS, awdEligible, the marketplace every row is validated against) stay compared; a country / raw-seller
 * change is a different request identity (other pointers) anyway. A publish that happens for other reasons carries the
 * durable directory's labels. -> { equal, labelDrift: [key] }
 */
export function fbaPlanRouteContentVerdict(served, derived) {
  const ds = fbaPlanContentDigest(served, { omitLabels: true });
  const equal = nb(ds) && ds === fbaPlanContentDigest(derived, { omitLabels: true });
  const labelOf = (p, k) => (p && typeof p === "object" && p[k] != null ? S(p[k]) : "");
  const labelDrift = equal ? FBA_PLAN_DIRECTORY_LABEL_KEYS.filter((k) => labelOf(served, k) !== labelOf(derived, k)) : [];
  return { equal, labelDrift };
}

// ---- FILL-ONLY + NEVER GO BACKWARDS (PURE; see the header) -------------------------------------------------------

const isObj = (o) => !!o && typeof o === "object" && !Array.isArray(o);
// The pure ordering's two "unknowable fetch instant" verdicts (mapped to typed 'inventory-guard:*' deferrals).
const FETCH_UNORDERED = "fetch-unordered";
const AWD_FETCH_UNORDERED = "awd-fetch-unordered";

/** A payload's inventory snapshot DAY: the later of payload.inventoryRequestedThrough / payload.inventoryDate ("" none). */
export function fbaPlanPayloadInventoryDay(payload) {
  if (!payload || typeof payload !== "object") return "";
  const days = [payload.inventoryRequestedThrough, payload.inventoryDate].map(S).filter(isDate).sort();
  return days.length ? days[days.length - 1] : "";
}

// A row's fetch instant for ONE component: its own OFFSET-BEARING payload stamp; else (missing / null / unparseable /
// naive) the ROW's source_refreshed_at -- a sound UPPER bound: the paid shadow is stamped at its newest source fetch, the
// route row at its evidence instant (>= its FBA / AWD validated_at), and the publisher copies the shadow's stamp. NaN when
// neither is usable (UNORDERED).
const fetchBoundMs = (stamp, rowRefreshedAt) => {
  const t = offsetInstantMs(stamp);
  return Number.isFinite(t) ? t : offsetInstantMs(rowRefreshedAt);
};

/**
 * The per-component never-go-backwards verdict over readable live rows (the served row + the exact live row at
 * {to: salesAsOf}, or a pending paid shadow) against THIS bundle's FBA (inventoryAsOf + the pointer's validated_at) and,
 * when durable AWD is used, the Listings pointer's validated_at. `rows` are { payload, refreshedAt (the row's
 * source_refreshed_at) }; bare `payloads` carry no row stamp (a same-day payload with an unusable fetch stamp is then
 * UNORDERED). -> null (nothing newer) | 'served-newer-inventory' | 'served-newer-awd' | 'fetch-unordered' |
 * 'awd-fetch-unordered' (a definitive newer component wins over an unordered one).
 * FAIL CLOSED: an unparseable bundle stamp is the OLDEST instant (any usable row fetch is newer); a row fetch instant
 * that is unknowable (no usable payload stamp AND no usable row stamp) is never read as "older". AWD is ordered only for
 * rows that HOLD AWD (awdAvailable:true or a non-null awdFetchedAt) -- a row published without AWD has none to protect.
 */
export function fbaPlanNewerLiveReason({ payloads = [], rows = [], inventoryAsOf, inventoryValidatedAt, awdValidatedAt = null } = {}) {
  const list = [
    ...(Array.isArray(payloads) ? payloads : []).map((p) => ({ payload: p, refreshedAt: null })),
    ...(Array.isArray(rows) ? rows : []).map((r) => ({ payload: r && r.payload, refreshedAt: r ? r.refreshedAt : null })),
  ].filter((r) => isObj(r.payload));
  const inv = S(inventoryAsOf);
  const invAt = offsetInstantMs(inventoryValidatedAt);
  const awdAt = awdValidatedAt == null ? null : offsetInstantMs(awdValidatedAt);
  const order = (stamp, rowAt, mine) => {
    const t = fetchBoundMs(stamp, rowAt);
    if (!Number.isFinite(t)) return "unordered";
    return !Number.isFinite(mine) || t > mine ? "newer" : null;
  };
  let invUnordered = false;
  for (const { payload: p, refreshedAt } of list) {
    const day = fbaPlanPayloadInventoryDay(p);
    if (!isDate(day)) continue;
    if (!isDate(inv) || day > inv) return "served-newer-inventory";
    if (day !== inv) continue; // an OLDER inventory day is older whatever its fetch time (the newer day wins)
    const o = order(p.inventoryFetchedAt, refreshedAt, invAt);
    if (o === "newer") return "served-newer-inventory";
    if (o === "unordered") invUnordered = true;
  }
  let awdNewer = false;
  let awdUnordered = false;
  if (awdAt !== null) {
    for (const { payload: p, refreshedAt } of list) {
      const holdsAwd = p.awdAvailable === true || (p.awdFetchedAt != null && S(p.awdFetchedAt) !== "");
      if (!holdsAwd) continue;
      const o = order(p.awdFetchedAt, refreshedAt, awdAt);
      if (o === "newer") awdNewer = true;
      else if (o === "unordered") awdUnordered = true;
    }
  }
  if (awdNewer) return "served-newer-awd";
  if (invUnordered) return FETCH_UNORDERED;
  if (awdUnordered) return AWD_FETCH_UNORDERED;
  return null;
}

// The two stored-token shapes that make a live row ROUTE-WRITTEN (FILL-ONLY 1.): this route's evidence token version
// and its manifest token, each over a 64-hex sha256 (fba-plan.route.js fbaPlanEvidenceToken / the manifest below).
const reEscape = (s) => S(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ROUTE_EVIDENCE_TOKEN_RE = new RegExp("^" + reEscape(FBA_PLAN_TOKEN_PREFIX) + "[0-9a-f]{64}$");
const ROUTE_MANIFEST_TOKEN_RE = new RegExp("^" + reEscape(FBA_PLAN_MANIFEST_PREFIX) + "[0-9a-f]{64}$");

/**
 * The OWNER of a live fba-plan row from its STORED params (FILL-ONLY 1.): 'route' iff they carry this route's evidence
 * token AND its manifest token -- exactly the liveParamsExtra the 'fba-plan' live contract copies from a route shadow
 * (a paid shadow carries neither, so a paid publish stores none); anything else -- paid, legacy, refresh=1, an older
 * route token version, a bare / param-less row -- is 'paid' (PAID-OWNED: never replaced by the route).
 */
export function fbaPlanRowOwner(params) {
  const p = isObj(params) ? params : {};
  return ROUTE_EVIDENCE_TOKEN_RE.test(S(p.evidenceToken)) && ROUTE_MANIFEST_TOKEN_RE.test(S(p.manifestToken)) ? "route" : "paid";
}

/**
 * A row's SALES as-of: the LATER of its stored params.to (the live identity) and payload.asOf (the derive's sales
 * through-date) -- valid calendar dates only ("" when neither; the verdict then fails closed). The later one, so a row
 * whose payload claims a newer sales day than its identity is never read as older.
 */
export function fbaPlanRowSalesAsOf({ params = null, payload = null } = {}) {
  const days = [isObj(params) ? params.to : null, isObj(payload) ? payload.asOf : null].map(S).filter(isDate).sort();
  return days.length ? days[days.length - 1] : "";
}
// A row's live IDENTITY day: its stored params.to (the fba-plan identity is { to }); a param-less row falls back to its
// sales as-of.
const identityDayOf = (r) => (r && isObj(r.params) && isDate(S(r.params.to)) ? S(r.params.to) : fbaPlanRowSalesAsOf(r || {}));

// The live-guard slots readLiveRows returns: a readable row ({ payload, refreshedAt: its source_refreshed_at, params:
// its STORED params -- the ownership + sales as-of source }), a true 'missing', an EMPTY served slot (the serve shows
// no fba-plan row for a reason other than 'missing': out-of-line / version-hidden / ...), or unreadable.
const LIVE_SLOT_STATES = new Set(["row", "missing", "empty", "unreadable"]);
function liveSlot(x) {
  if (!x || typeof x !== "object" || !LIVE_SLOT_STATES.has(x.state)) return { state: "unreadable" };
  if (x.state === "row") return isObj(x.payload) ? { state: "row", payload: x.payload, refreshedAt: x.refreshedAt == null ? null : x.refreshedAt, params: isObj(x.params) ? x.params : null } : { state: "unreadable" };
  return { state: x.state };
}
// The paid-job slot readPaidPending returns for the NEWEST FOREIGN (non-route-lineage) (fba-plan, account) job, with
// its id (jobId: the publishGuard post-insert check compares it; null when no foreign job exists):
//   'none'             no foreign job, or nothing it can still publish (failed / skipped / a terminal cycle without a
//                      validated job, a validated job that is no longer the LATEST job -- the publisher never promotes
//                      it --, a shadow already live at an equal-or-newer stamp, an in-flight job of an OLDER cycle_date);
//   'pending'          { payload, refreshedAt, params } of a validated shadow the publisher would still promote;
//   'in-flight'        not yet validated, its cycle pending / running on the current epoch (cycle_date >= epoch);
//   'stale-in-flight'  the same, created more than FBA_PLAN_STALE_IN_FLIGHT_MS ago;
//   'refused'          { payload, refreshedAt, params, liveRefreshedAt } of a validated LATEST shadow whose live
//                      identity holds a ROUTE-written row stamped at / after it with DIFFERENT content (STAMP INVERSION);
//   'unreadable'       any read failure / malformed row (fail closed).
// Every readable state but 'none' requires its jobId.
const PAID_SLOT_STATES = new Set(["none", "pending", "in-flight", "stale-in-flight", "refused", "unreadable"]);
function paidSlot(x) {
  const bad = { state: "unreadable", jobId: null };
  if (!x || typeof x !== "object" || !PAID_SLOT_STATES.has(x.state) || x.state === "unreadable") return bad;
  const jobId = nb(x.jobId) ? S(x.jobId) : null;
  if (x.state === "none") return { state: "none", jobId };
  if (!jobId) return bad;
  if (x.state === "pending") return isObj(x.payload) ? { state: "pending", jobId, payload: x.payload, refreshedAt: x.refreshedAt == null ? null : x.refreshedAt, params: isObj(x.params) ? x.params : null } : bad;
  if (x.state === "refused") return isObj(x.payload) && nb(x.liveRefreshedAt) ? { state: "refused", jobId, payload: x.payload, refreshedAt: x.refreshedAt == null ? null : x.refreshedAt, params: isObj(x.params) ? x.params : null, liveRefreshedAt: S(x.liveRefreshedAt) } : bad;
  return { state: x.state, jobId };
}
// The paid-CYCLE slot readPaidCycles returns (FILL-ONLY (e)): 'none' (no open paid cycle that can still produce an
// fba-plan job), 'open' { bucket } (an ACTIVE open one), 'stale-open' { bucket } (idle beyond the activity window on the
// current epoch), or 'unreadable' (fail closed). A non-'none' state requires its bucket.
const CYCLE_SLOT_STATES = new Set(["none", "open", "stale-open", "unreadable"]);
const CYCLE_BUCKET_RE = /^[A-Za-z0-9._-]{1,80}$/;
function cycleSlot(x) {
  const bad = { state: "unreadable" };
  if (!x || typeof x !== "object" || !CYCLE_SLOT_STATES.has(x.state) || x.state === "unreadable") return bad;
  if (x.state === "none") return { state: "none" };
  return CYCLE_BUCKET_RE.test(S(x.bucket)) ? { state: x.state, bucket: S(x.bucket) } : bad;
}
// The typed reason of a pure component-ordering verdict for its source ('served' = the served / exact live rows, 'paid'
// = a pending paid shadow).
function guardReason(r, source) {
  if (r === FETCH_UNORDERED) return "inventory-guard:fetch-unordered";
  if (r === AWD_FETCH_UNORDERED) return "inventory-guard:awd-fetch-unordered";
  if (source === "paid") return "superseded-newer-live:paid-publish-pending:" + (r === "served-newer-awd" ? "awd" : "inventory");
  return "superseded-newer-live:" + r;
}

/**
 * THE FILL-ONLY GUARD (PURE) -- the ONE verdict resolveFbaPlanDependencyBundle (step 0: the predicate + both prepare
 * reads) AND the release's publishGuard (inside the control lease, immediately before the CAS, fresh reads) evaluate:
 *   live: { served, exact } (readLiveRows slots), paid (readPaidPending slot), the bundle's salesAsOf (the live identity
 *   {to}), inventoryAsOf + FBA validated_at and the durable AWD validated_at (null when durable AWD is not used)
 * -> { hard: reason | null (an unreadable guard read: fail closed), newerLive: reason | null, served, exact, paid }
 * newerLive, in order (see the header):
 *   (b) a served / exact row at a LATER sales as-of -> 'superseded-newer-live:served-newer-to' (an unknowable one
 *       'inventory-guard:sales-asof-unordered');
 *   (a) a PAID-OWNED row at the exact identity {to: salesAsOf} -> 'superseded-newer-live:paid-owned' (never a CAS over
 *       it -- the predicate's 'report' mode still proves an equal-content row current);
 *   (c) a newer inventory / AWD component on a served / exact row -> 'superseded-newer-live:served-newer-inventory|awd'
 *       (an unknowable same-day fetch 'inventory-guard:fetch-unordered' / ':awd-fetch-unordered');
 *   (d) a pending paid shadow at a sales as-of >= salesAsOf -> 'superseded-newer-live:paid-publish-pending:to', an
 *       older-to one with a newer component -> ':paid-publish-pending:inventory|awd'; a paid job in flight ->
 *       'paid-job-in-flight' / 'paid-job-stale-in-flight';
 *   (e) an OPEN paid cycle that can still produce an fba-plan job -> 'paid-cycle-open:<bucket>' (an idle one on the
 *       current epoch 'paid-cycle-stale-open:<bucket>');
 *   (f) a REFUSED paid shadow (stamp inversion) -> 'superseded-newer-live:paid-publish-refused-by-route-stamp' (ALERT),
 *       unless its masked content digest equals acceptRefusedDigest (the resolve PROVED the route's derive serves
 *       exactly that content with a newer stamp -- convergence). It is evaluated LAST, so clearing it never skips another
 *       refusal.
 * cycles: the readPaidCycles slot (REQUIRED: absent / malformed is 'inventory-guard:paid-cycle-unreadable').
 */
export function fbaPlanLiveGuard({ live = null, paid = null, cycles = null, salesAsOf, inventoryAsOf, inventoryValidatedAt, awdValidatedAt = null, acceptRefusedDigest = null } = {}) {
  const served = liveSlot(live && live.served);
  const exact = liveSlot(live && live.exact);
  const pp = paidSlot(paid);
  const cy = cycleSlot(cycles);
  const out = (hard, newerLive = null) => ({ hard, newerLive, served, exact, paid: pp, cycles: cy });
  if (served.state === "unreadable") return out("inventory-guard:served-unreadable");
  if (exact.state !== "row" && exact.state !== "missing") return out("inventory-guard:live-unreadable");
  if (pp.state === "unreadable") return out("inventory-guard:paid-lineage-unreadable");
  if (cy.state === "unreadable") return out("inventory-guard:paid-cycle-unreadable");
  const sa = S(salesAsOf);
  if (!isDate(sa)) return out("inventory-guard:sales-asof-missing");
  const rows = [served, exact].filter((x) => x.state === "row");
  // (b) the SALES as-of: a definitive later day wins over an unknowable one (never read as "older").
  if (rows.some((r) => fbaPlanRowSalesAsOf(r) > sa)) return out(null, FBA_PLAN_SERVED_NEWER_TO);
  if (rows.some((r) => !isDate(fbaPlanRowSalesAsOf(r)))) return out(null, "inventory-guard:sales-asof-unordered");
  // (a) OWNERSHIP at the exact identity: the exact row, or a served row AT {to: salesAsOf} (the same identity -- e.g.
  //     one that landed between the two reads). Only a ROUTE-WRITTEN row may ever be replaced.
  if (rows.some((r) => (r === exact || identityDayOf(r) === sa) && fbaPlanRowOwner(r.params) !== "route")) return out(null, FBA_PLAN_PAID_OWNED);
  // (c) the per-component order over the readable rows.
  const ord = { inventoryAsOf, inventoryValidatedAt, awdValidatedAt };
  const liveVerdict = fbaPlanNewerLiveReason({ rows, ...ord });
  if (liveVerdict) return out(null, guardReason(liveVerdict, "served"));
  // (d) the paid path: a pending shadow at >= salesAsOf is the paid path's own publication of this D-1 (or a newer one).
  if (pp.state === "pending") {
    const pday = fbaPlanRowSalesAsOf(pp);
    if (!isDate(pday)) return out(null, "inventory-guard:sales-asof-unordered");
    if (pday >= sa) return out(null, FBA_PLAN_PAID_PENDING_TO);
    const paidVerdict = fbaPlanNewerLiveReason({ rows: [pp], ...ord });
    if (paidVerdict) return out(null, guardReason(paidVerdict, "paid"));
  }
  if (pp.state === "in-flight") return out(null, FBA_PLAN_PAID_IN_FLIGHT);
  if (pp.state === "stale-in-flight") return out(null, FBA_PLAN_PAID_STALE_IN_FLIGHT);
  // (e) the paid path's publication in progress (its job not inserted yet): never fill under it.
  if (cy.state === "open") return out(null, FBA_PLAN_PAID_CYCLE_OPEN + ":" + cy.bucket);
  if (cy.state === "stale-open") return out(null, FBA_PLAN_PAID_CYCLE_STALE_OPEN + ":" + cy.bucket);
  // (f) STAMP INVERSION: a refused paid shadow is never re-derived over (never orphaned) unless proven served.
  if (pp.state === "refused" && !(nb(acceptRefusedDigest) && fbaPlanRefusedPaidDigest(pp.payload) === S(acceptRefusedDigest))) return out(null, FBA_PLAN_PAID_REFUSED_BY_ROUTE_STAMP);
  return out(null, null);
}

/**
 * The EU5 AWD REGRESSION verdict over a fbaPlanLiveGuard result, for a route payload WITHOUT AWD (durable AWD missing /
 * unusable): 'awd-regression-guard' when the served row, the exact live row at {to: salesAsOf} OR a pending paid shadow
 * shows awdAvailable:true (paid AWD is never regressed to "no AWD", nor hidden behind a route job); ':served-unreadable'
 * when the served slot is anything but a readable row or a TRUE 'missing' (absence of served AWD unprovable); else null.
 */
export function fbaPlanAwdRegressionReason(guard) {
  const g = guard && typeof guard === "object" ? guard : {};
  const payloads = [g.served, g.exact, g.paid].filter((x) => x && (x.state === "row" || x.state === "pending" || x.state === "refused") && isObj(x.payload)).map((x) => x.payload);
  if (payloads.some((p) => p.awdAvailable === true)) return "awd-regression-guard";
  const s = g.served && g.served.state;
  if (s !== "row" && s !== "missing") return "awd-regression-guard:served-unreadable";
  return null;
}

// ---- the deep bundle --------------------------------------------------------------------------------------------

/**
 * Resolve + integrity-validate ONE account's complete fba-plan dependency bundle from DURABLE evidence.
 * readers: { loadSnapshotPayload(objectPath, { signal }) -> { rows } (content-hash verified),
 *            readOliHistory({ organizationFingerprint, connectionId, accountIds, from, to, signal }) -> rows,
 *            readLiveRows({ accountId, salesAsOf, signal }) -> { served: slot, exact: slot } -- the SERVED row and the
 *              exact live row at {to: salesAsOf}, each { state:'row', payload, refreshedAt (the row's
 *              source_refreshed_at), params (its STORED params: ownership + sales as-of) } | { state:'missing' } |
 *              { state:'empty' } (served only: the serve shows nothing for a reason other than 'missing') |
 *              { state:'unreadable' },
 *            readPaidPending({ accountId, inventoryAsOf, signal }) -> the NEWEST FOREIGN (non-route-lineage)
 *              (fba-plan, account) job as a paid slot (see paidSlot): { state:'none'|'pending'|'in-flight'|
 *              'stale-in-flight'|'unreadable', jobId, payload?, refreshedAt?, params? },
 *            readPaidCycles({ accountId, inventoryAsOf, signal }) -> the OPEN paid cycles that can still produce an
 *              fba-plan job for the account (see cycleSlot): { state:'none'|'open'|'stale-open'|'unreadable', bucket? },
 *            deriveContent({ sources, context }) (optional) -> the derived payload | null -- used ONLY to prove a
 *              refused paid shadow's convergence (absent: a refused shadow always refuses -- fail closed),
 *            connections, buildObjectPath }
 * args:    { evidence (composeFbaPlanEvidence), organizationFingerprint, connectionId, apiKey, signal,
 *            newerLive: 'refuse' (default: every FILL-ONLY refusal -- paid-owned, a newer sales as-of / component, a
 *                       pending or in-flight paid job -- is an ineligible typed reason) |
 *                       'report' (the route's current predicate ONLY: resolve anyway and return it as newerLive, so a
 *                       served row whose CONTENT equals the derive -- e.g. the paid row itself -- is still proven
 *                       current, never falsely superseded) }
 * -> { eligible:true, evidenceInstant, manifestToken, awdStatus, newerLive: null | reason, guard, bundle: { sources,
 *      context } } | { eligible:false, reason }
 * guard (plain JSON; the generic release requires it stableJson-equal at the prepare's two reads and hands it to
 * publishGuard as prepared.guard): { salesAsOf, inventoryAsOf, fbaValidatedAt, awdValidatedAt (null when the payload
 * carries no durable AWD), awdApplicable (the marketplace is AWD-capable: with awdValidatedAt null the payload has NO
 * AWD, so the EU5 regression guard applies), foreignJobId (the NEWEST FOREIGN job's id this resolve saw, null when none:
 * publishGuard's post-insert check), refusedPaidDigest (the masked content digest of a REFUSED paid shadow this resolve
 * proved it serves -- convergence; null otherwise) } -- the instants as canonical millisecond UTC ISO.
 */
export async function resolveFbaPlanDependencyBundle(readers = {}, args = {}) {
  const { loadSnapshotPayload, readOliHistory, readLiveRows, readPaidPending, readPaidCycles, deriveContent = null, connections = [], buildObjectPath } = readers;
  const { evidence, organizationFingerprint, connectionId = "primary", apiKey, signal = null, newerLive: newerLiveMode = "refuse" } = args;
  const miss = (reason) => ({ eligible: false, reason });
  const aborted = () => !!(signal && signal.aborted);
  for (const [n, f] of [["loadSnapshotPayload", loadSnapshotPayload], ["readOliHistory", readOliHistory], ["readLiveRows", readLiveRows], ["readPaidPending", readPaidPending], ["readPaidCycles", readPaidCycles], ["buildObjectPath", buildObjectPath]]) {
    if (typeof f !== "function") throw new Error("resolveFbaPlanDependencyBundle requires " + n + " (fail closed).");
  }
  const ev = evaluateFbaPlanEvidence(evidence, { apiKey, buildObjectPath, organizationFingerprint, connectionId });
  if (!ev.ok) return miss(ev.reason);
  if (aborted()) return miss("aborted");
  const e = evidence;
  const acct = S(e.accountId);
  const raw = S(e.rawSellerId);
  const inventoryAsOf = S(e.inventoryAsOf);
  const salesAsOf = S(e.salesAsOf);

  // 0. FILL-ONLY (see the header) -- metadata + the two live rows + the newest foreign job + the open paid cycles,
  //    before any payload is hydrated. Every live row this publish could displace or be hidden behind must be readable (a true 'missing' is
  //    nothing to protect; an EMPTY served slot shows no row, while the exact live row -- the CAS target -- is always
  //    read), and so must the newest foreign (fba-plan, account) job (the paid path's pending / in-flight publication).
  let live = null;
  try { live = await readLiveRows({ accountId: acct, salesAsOf, signal }); } catch { live = null; }
  if (aborted()) return miss("aborted");
  let paid = null;
  try { paid = await readPaidPending({ accountId: acct, inventoryAsOf, signal }); } catch { paid = null; }
  if (aborted()) return miss("aborted");
  let cycles = null;
  try { cycles = await readPaidCycles({ accountId: acct, inventoryAsOf, signal }); } catch { cycles = null; }
  if (aborted()) return miss("aborted");
  const liveGuard = fbaPlanLiveGuard({ live, paid, cycles, salesAsOf, inventoryAsOf, inventoryValidatedAt: e.fbaPointer.validated_at, awdValidatedAt: ev.awdUsable ? e.awdPointer.validated_at : null });
  if (liveGuard.hard) return miss(liveGuard.hard);
  let newerLive = liveGuard.newerLive;
  // A REFUSED paid shadow (the LAST check of the verdict, so nothing else is pending) is decided after the bundle is
  // built: released only when the route provably serves exactly its content (see step 5b).
  const refusedPending = newerLive === FBA_PLAN_PAID_REFUSED_BY_ROUTE_STAMP;
  if (newerLive && newerLiveMode !== "report" && !refusedPending) return miss(newerLive);
  const hydrate = async (pointer, label) => {
    let rows;
    try { rows = rowsOf(await loadSnapshotPayload(S(pointer.object_path), { signal })); }
    catch (err) { return { reason: label + "-payload-unreadable:" + S(err && err.code ? err.code : "read-failed") }; }
    if (!Array.isArray(rows)) return { reason: label + "-payload-dangling" };
    // row_count is PROVEN an actual safe integer above -> compare directly (no Number() re-coercion).
    if (rows.length !== pointer.row_count) return { reason: label + "-pointer-integrity:row-count-mismatch" };
    return { rows };
  };

  // 1. FBA inventory rows: the account's marketplace (UK -> GB) + seller on EVERY row.
  const p = e.fbaPointer;
  const inv = await hydrate(p, "fba");
  if (inv.reason) return miss(inv.reason);
  if (aborted()) return miss("aborted");
  const vr = validateFbaDurableRows(inv.rows, ev.marketplace);
  if (!vr.valid) return miss("fba-rows-invalid:" + vr.code);
  if (inv.rows.some((r) => S(r.seller_or_vendor_id).trim() !== raw)) return miss("fba-rows-cross-account");
  const sources = {};
  sources[FBA_PLAN_INVENTORY_REQUEST_KEY] = {
    available: true, rows: inv.rows,
    fragments: [{ requestKey: FBA_PLAN_INVENTORY_REQUEST_KEY, requestHash: S(p.source_request_hash), from: inventoryAsOf, to: inventoryAsOf, sellerOrVendorIds: [raw], fetchedAt: S(p.validated_at), rows: inv.rows }],
    disabled: false, disabledPolicy: null, reason: null,
  };

  // 2. AWD (US + EU5 only).
  let awdStatus = ev.awdCapable ? "missing" : "not-applicable";
  let awdPointerUsed = null;
  if (ev.awdCapable) {
    let failure = ev.awdUsable ? null : ev.awdReason;
    let awdRows = null;
    if (!failure) {
      const a = e.awdPointer;
      const got = await hydrate(a, "awd");
      if (aborted()) return miss("aborted");
      if (got.reason) failure = got.reason;
      else if (got.rows.some((r) => !r || typeof r !== "object" || Array.isArray(r))) failure = "awd-rows-invalid:malformed";
      // The durable rows must BE the canonical Listings export (the AWD columns present on every row) -- a pointer
      // persisted from a Listings export without them would fold every AWD value to a fabricated 0.
      else if (got.rows.some((r) => !AWD_REQUIRED_COLUMNS.every((k) => Object.prototype.hasOwnProperty.call(r, k)))) failure = "awd-rows-invalid:awd-columns-missing";
      else if (got.rows.some((r) => S(r.seller_or_vendor_id).trim() !== raw)) failure = "awd-rows-invalid:cross-account";
      else if (got.rows.some((r) => normalizeMarketplace(r.marketplace_country_code) !== ev.marketplace)) failure = "awd-rows-invalid:cross-marketplace";
      else awdRows = got.rows;
    }
    if (!failure) {
      const a = e.awdPointer;
      sources[FBA_PLAN_AWD_REQUEST_KEY] = {
        available: true, rows: awdRows,
        fragments: [{ requestKey: FBA_PLAN_AWD_REQUEST_KEY, requestHash: S(a.source_request_hash), from: null, to: null, sellerOrVendorIds: [raw], fetchedAt: S(a.validated_at), rows: awdRows }],
        disabled: false, disabledPolicy: null, reason: null,
      };
      awdStatus = "available";
      awdPointerUsed = a;
    } else if (ev.awdRequired) {
      return miss(failure); // US: AWD is a hard requirement -- never a US plan without its validated AWD
    } else {
      // EU5 REGRESSION GUARD: publish "AWD unavailable" ONLY when NEITHER the SERVED row NOR the exact live row at
      // {to: salesAsOf} (the CAS target; under FILL-ONLY only a route-written one is ever replaced) NOR a pending paid
      // shadow shows AWD -- a paid awdAvailable:true is never regressed to "no AWD" by missing durable evidence. Any served state but a
      // readable row or a TRUE 'missing' (an empty / out-of-line / version-hidden slot) cannot prove the absence of
      // served AWD: fail closed. (publishGuard re-applies the SAME verdict inside the control lease.)
      const regression = fbaPlanAwdRegressionReason(liveGuard);
      if (regression) return miss(regression);
      sources[FBA_PLAN_AWD_REQUEST_KEY] = { available: false, rows: null, fragments: [], disabled: false, disabledPolicy: null, reason: S(failure) };
      awdStatus = "unavailable:" + S(failure);
    }
  }

  // 3. OLI + Catalog through the SAME strict durable loader the paid derive uses, fed the coverage + catalog pointer
  //    this bundle already proved (one read). A loader refusal ({} / catalog absent) defers.
  const cat = e.catalogPointer;
  const coverageWindows = (Array.isArray(e.coverage) ? e.coverage : []).map((w) => ({ from: S(w.from), to: S(w.to) }));
  let catalogRowCount = null;
  const loader = makeFbaPlanDurableContextLoader({
    connections,
    getOliCoverage: async ({ organizationFingerprint: o, connectionId: c, accountId: a, sourceKey }) => (S(o) === S(organizationFingerprint) && S(c) === S(connectionId) && S(a) === acct && sourceKey === "order-line-items"
      ? { read: "ok", windows: coverageWindows } : { read: "read-failed", windows: [] }),
    getOliHistory: (q) => readOliHistory({ ...q, signal }),
    getCatalogSnapshot: async ({ organizationFingerprint: o, connectionId: c, sourceKey, scopeKey }) => (S(o) === S(organizationFingerprint) && S(c) === S(connectionId) && sourceKey === CATALOG_SOURCE_KEY && scopeKey === ORGANIZATION_SCOPE_KEY
      ? { read: "ok", snapshot: cat } : { read: "read-failed", snapshot: null }),
    loadCatalogPayload: async (objectPath) => {
      const rows = rowsOf(await loadSnapshotPayload(S(objectPath), { signal }));
      if (!Array.isArray(rows) || rows.length !== cat.row_count) throw new Error("catalog-row-count-mismatch");
      catalogRowCount = rows.length;
      return { rows };
    },
  });
  let durable;
  try { durable = await loader({ reportKey: "fba-plan", accountId: acct, planned: { context: { to: salesAsOf } } }); }
  catch (err) { return miss("durable-context-threw:" + S(err && err.code ? err.code : "error")); }
  if (aborted()) return miss("aborted");
  const oli = durable && durable.fbaPlanDurableOli;
  const catalog = durable && durable.fbaPlanDurableCatalog;
  if (!oli || oli.available !== true || !Array.isArray(oli.fragments)) return miss("durable-oli-unavailable");
  if (!catalog || catalog.available !== true || !Array.isArray(catalog.fragments) || catalogRowCount == null) return miss("durable-catalog-unavailable");
  // The loader resolves the raw seller from the connection map; it must BE the directory's (the derive binds both).
  const loaderRaw = [...oli.fragments, ...catalog.fragments].map((f) => S(f && f.sellerOrVendorIds && f.sellerOrVendorIds[0]));
  if (!loaderRaw.every((x) => x === raw)) return miss("raw-seller-mismatch");

  // 4. The EVIDENCE INSTANT (the route's source_refreshed_at; never the wall clock): the max of the PAID-FETCH-DERIVED
  //    components ONLY -- the FBA pointer's validated_at and, when durable AWD is used, the Listings pointer's
  //    validated_at. OLI coverage refreshes and the catalog validated_at are DELIBERATELY excluded (FILL-ONLY): an
  //    unrelated OLI / catalog re-ack can then never lift a route row above paid data, and ANY later genuinely new paid
  //    fetch (its shadow is stamped at its newest source fetch) out-ranks a route row in the fenced IfNewer CAS.
  //    ACCEPTED CONSEQUENCE (owner-approved design): an OLI / catalog-ONLY change for a ROUTE-written row moves the token
  //    + manifest but not this instant, so the generic release defers it 'evidence-instant-not-advanced' (the exact live
  //    row sits at exactly this instant with different content tokens; typed, zero writes, NEVER reported current since
  //    the content differs) until the next paid fetch or the next D-1 -- the benign 'awaiting-next-fba-fetch' class for
  //    fba-plan (no alert). A paid-owned row is never replaced at all (FILL-ONLY 1.).
  const instants = [isoMs(p.validated_at), awdPointerUsed ? isoMs(awdPointerUsed.validated_at) : ""].filter(nb).sort();
  const evidenceInstant = instants.length ? instants[instants.length - 1] : "";
  if (!nb(evidenceInstant)) return miss("evidence-instant-unresolved");

  // 5. The derive context -- the report-planner.js (fba-plan request) context shape, plus the durable inputs.
  const country = S(e.country);
  const context = {
    to: salesAsOf, inventoryAsOf, rawSellerId: raw,
    accountName: e.accountName ? S(e.accountName) : null,
    marketCountry: country || null,
    isUS: country.toUpperCase() === "US",
    accountId: acct,
    fbaPlanDurableOli: oli,
    fbaPlanDurableCatalog: catalog,
  };

  // 5b. STAMP INVERSION (see the header): a refused paid shadow is released ONLY when the route can serve exactly its
  //     content -- this bundle's evidence instant strictly after the route row it was refused by (so the fenced CAS can
  //     replace that row) AND the derive content-equivalent (stamps + labels masked) to the shadow. Then the prepare's
  //     guard carries its digest (publishGuard re-verifies the SAME shadow). Otherwise it stays the typed ALERT.
  let refusedPaidDigest = null;
  if (refusedPending) {
    const refused = liveGuard.paid;
    const liveAt = offsetInstantMs(refused.liveRefreshedAt);
    const eiAt = offsetInstantMs(evidenceInstant);
    let converges = false;
    if (Number.isFinite(liveAt) && Number.isFinite(eiAt) && eiAt > liveAt && typeof deriveContent === "function") {
      let derived = null;
      try { derived = await deriveContent({ sources, context }); } catch { derived = null; }
      if (aborted()) return miss("aborted");
      converges = !!derived && fbaPlanRouteContentVerdict(refused.payload, derived).equal;
    }
    if (converges) { refusedPaidDigest = fbaPlanRefusedPaidDigest(refused.payload); newerLive = null; }
    else if (newerLiveMode !== "report") return miss(FBA_PLAN_PAID_REFUSED_BY_ROUTE_STAMP);
  }

  // 6. The MANIFEST: the canonical inputs incl. the row digests (the verify-exact content identity).
  const manifestToken = FBA_PLAN_MANIFEST_PREFIX + sha256(JSON.stringify([
    S(e.token), S(p.source_request_hash), S(p.payload_sha), inv.rows.length,
    awdPointerUsed ? S(awdPointerUsed.payload_sha) + "@" + isoMs(awdPointerUsed.validated_at) : "AWD:" + awdStatus,
    sha256(stableJson(oli.fragments)), S(cat.payload_sha), catalogRowCount,
    stableJson({ to: context.to, inventoryAsOf, rawSellerId: raw, accountName: context.accountName, marketCountry: context.marketCountry, isUS: context.isUS, accountId: acct }),
  ]));

  // 7. The publish GUARD components (see the doc above): what this payload holds + the newest foreign job this resolve
  //    saw, for publishGuard's re-check (inside the control lease).
  const guard = {
    salesAsOf, inventoryAsOf,
    fbaValidatedAt: isoMs(p.validated_at),
    awdValidatedAt: awdPointerUsed ? isoMs(awdPointerUsed.validated_at) : null,
    awdApplicable: ev.awdCapable === true,
    foreignJobId: liveGuard.paid && liveGuard.paid.jobId ? S(liveGuard.paid.jobId) : null,
    refusedPaidDigest,
  };

  return { eligible: true, evidenceInstant, manifestToken, awdStatus, newerLive, guard, bundle: { sources, context, salesAsOf, inventoryAsOf, awdStatus } };
}
